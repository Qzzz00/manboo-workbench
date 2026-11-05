"""派怎么变成「账号里的一台设备」,以及怎么领一张进房凭证(2026-09-21)。

**复用手机那一套,一个字都不新发明**(docs/交接-0911-手机配对与设备令牌):
电脑端设置里点「生成配对码」→ 6 位数字,5 分钟有效、一次性 → 派上跑一次
`python3 popphone.py --pair 123456`,`POST /pair/claim` 换回一张设备令牌 →
令牌落 `~/phone-bridge/device.json`(0600),之后每次开机直接用。

## 两条领凭证的路(卡上要求两条都实现)

1. **局域网**:`POST {8791}/channel/token`,带 `Authorization: Bearer <设备令牌>`。
   身份由 8791 按设备令牌拼(`wb-phone-<device_id>`),**派说了不算** —— 这是那一层
   的老规矩(channelIdentityOf),派这边连想伪造的接口都没有。
2. **中转**:`POST {中转}/v1/channel-token`,带账号那条令牌。出了局域网、或者 Mac 关着时
   唯一的路。身份用上一次局域网领到的那个(存在 device.json 里)——中转那边 identity
   是客户端报的,所以**必须报上次那一个**,否则工人会把派当成一台没见过的设备。

先试哪条:**能通哪条用哪条,局域网优先**(它不要钱、不出门、延迟低)。

**在这两条之前还有一问**(2026-10-03,卡 B):手上那张票没过期时,先 `GET /channel/status`
问一声「现在该进哪个房」(`ask_room_now`)。房变了就换票、房没变就接着用、问不到就用缓存票
并在日志里说一声 —— 整段理由在 `acquire_ticket` 的注释里。

中转那条要的「账号那条令牌」怎么来(2026-09-22):`python3 popphone.py --relay-login`,
在派上输一次账号密码,`relay_login()` 登录 → 注册设备 → 注销会话,令牌落 device.json 的
`relay_token`。前提:中转服务器配了 LiveKit(`RELAY_CHANNEL_*`),否则签不出凭证。

## 纪律

- 令牌**只在这个文件和请求头里出现**:不打日志、不进 URL、不进异常消息。
  下面每个抛出去的错误串都只说"哪一步、HTTP 几"。
- device.json 权限 0600,先写临时文件再 rename(同 workbench-plugin 的 devices.ts)。
- 读不懂的 device.json 当成"没配对过",**不删它** —— 删掉等于把唯一那张令牌扔了,
  而它很可能只是被谁手动编辑坏了一个逗号。
"""
import json
import os
import urllib.error
import urllib.request

#: 派在配对表里的平台名。电脑端设置里据此显示成「话筒」而不是「手机」,
#: 工人据此把它当成合法的音频端点。与 workbench-plugin/src/server/devices.ts
#: 的 `DEVICE_KIND_HANDSET` **逐字相同**。
PLATFORM_HANDSET = "handset"

#: 派在房里的默认显示名。房间列表里看得见,没有秘密。
DEFAULT_DEVICE_NAME = "座机话筒"

#: 凭证还剩这么多秒就该换一张了(10 分钟,与手机那边 wbchNeedsRenew 同一个口径)。
RENEW_BEFORE_SEC = 10 * 60


def default_state_file(home: str = "") -> str:
    return os.path.join(home or os.path.expanduser("~"), "phone-bridge", "device.json")


# ———————————————————————— 落盘 ————————————————————————

def load_state(path: str) -> dict:
    """读 device.json。**不存在、读不懂、不是对象一律回 `{}`**(=还没配对过)。"""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(path: str, state: dict) -> None:
    """原子写 + 0600。**先 chmod 再 rename**:临时文件哪怕只有一瞬也不该是可读的。"""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


# ———————————————————————— 纯函数 ————————————————————————

def http_base_of(ws_url: str) -> str:
    """`ws://host:8791` → `http://host:8791`。两个地址从来只该配一次。"""
    if ws_url.startswith("wss://"):
        return "https://" + ws_url[len("wss://"):]
    if ws_url.startswith("ws://"):
        return "http://" + ws_url[len("ws://"):]
    return ws_url


def ticket_of(raw: object) -> dict:
    """一张进房凭证。缺了四样里的任何一样都不算数(**宁可没有,也不要半张**:
    半张凭证会让派一直重试一个进不去的房间,日志上看不出缺的是哪一项)。"""
    if not isinstance(raw, dict):
        return {}
    need = ("url", "room", "identity", "token")
    if any(not isinstance(raw.get(key), str) or raw.get(key) == "" for key in need):
        return {}
    expires = raw.get("expires_at")
    return {
        "url": raw["url"], "room": raw["room"], "identity": raw["identity"], "token": raw["token"],
        "expires_at": int(expires) if isinstance(expires, (int, float)) else 0,
    }


def ticket_usable(ticket: dict, now_sec: int) -> bool:
    """还能用吗。`expires_at` 是 0(老服务器没给)时**当成能用** ——
    进不去房自然会重试,而据一个我们没有的数字提前判死刑是编。"""
    if not ticket:
        return False
    expires = ticket.get("expires_at") or 0
    return expires == 0 or expires - now_sec > RENEW_BEFORE_SEC


# ———————————————————————— HTTP ————————————————————————

class HttpRefused(RuntimeError):
    """对面明确回了一个状态码(不是"没打通")。

    **为什么要多这一个类**(2026-09-30):中转说「这把钥匙我不认识」和「网线没插好」
    在原来的代码里是同一个 `RuntimeError`,于是死令牌永远清不掉 —— 派拿着一把作废的
    钥匙每 20 秒敲一次中转,敲到换卡。带上 `status` 与 `code` 之后,
    `relay_token_dead()` 才分得出这两件事。

    仍然是 `RuntimeError` 的子类:原来所有 `except RuntimeError` 的地方一个字都不用改。
    **消息里没有令牌**,`code` 只是中转给的机器码(`invalid_relay_token` 之类)。
    """

    def __init__(self, message: str, status: int = 0, code: str = ""):
        super().__init__(message)
        self.status = int(status or 0)
        self.code = code or ""


#: 中转说「这把设备令牌不认识或已经被撤了」时给的机器码。与 relay/server/app.cjs
#: `deviceOf` 里那一串 **逐字相同**(那里是 401 + `invalid_relay_token`)。
#: 注意别把 403 `not_bound_to_account` 也算进来:那是**那台 Mac 还没登录账号**,
#: 钥匙好好的,清掉等于白白把派踢成没绑账号。
RELAY_TOKEN_DEAD_CODE = "invalid_relay_token"


def relay_token_dead(err: Exception) -> bool:
    """中转这一声是不是「你这把钥匙作废了」。

    认两种:带机器码的(新中转)与只有 401 的(老中转,没有 `code` 那一层)。
    别的一律不算 —— 503(中转没配 LiveKit)、403(那台 Mac 没登录)、超时、断网
    都是**暂时的**,清了钥匙反而要人跑一趟重新添加。
    """
    if not isinstance(err, HttpRefused):
        return False
    if err.code == RELAY_TOKEN_DEAD_CODE:
        return True
    return err.status == 401 and err.code == ""


def _error_said(payload: object) -> tuple:
    """从回包里掏出(给人看的一句话, 机器码)。两种形状都认:

    - 工作台 8791:`{"error": "一句话"}`
    - 中转(照 OpenAI 那一套):`{"error": {"message": "…", "code": "invalid_relay_token"}}`

    **只掏这两样**,整个 body 不往异常里抄 —— 那里头可能有别的东西。
    """
    if not isinstance(payload, dict):
        return "", ""
    said = payload.get("error")
    if isinstance(said, str):
        return said, ""
    if isinstance(said, dict):
        message = said.get("message")
        code = said.get("code")
        return (message if isinstance(message, str) else "",
                code if isinstance(code, str) else "")
    return "", ""


def _get_json(url: str, token: str = "", timeout: float = 5) -> dict:
    """GET 一份 JSON。错法与 `_post_json` 一模一样(**消息里没有令牌**)。

    超时比 POST 那边短:这一问只是「现在该进哪个房」的一个提示,问不到就按缓存票走 ——
    为它多等十秒等于把每次重连都拖慢十秒,而那十秒里电话是哑的。
    """
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        try:
            said, code = _error_said(json.loads(err.read().decode("utf-8")))
        except Exception:
            said, code = "", ""
        raise HttpRefused(f"{url.rsplit('/', 1)[-1]} 回了 HTTP {err.code}"
                          + (f":{said}" if said else ""),
                          status=err.code, code=code) from None
    except (urllib.error.URLError, OSError, ValueError) as err:
        raise RuntimeError(f"{url.rsplit('/', 1)[-1]} 没打通:{err}") from None


def _post_json(url: str, body: dict, token: str = "", timeout: float = 10) -> dict:
    """POST 一份 JSON 回一份 JSON。失败抛 `RuntimeError`,**消息里没有令牌**。"""
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        # 回包里的 error 字段是给人看的一句话(工作台那边就是这么写的),原样带上;
        # 带不出来就只说个状态码。**不把整个 body 抄进异常** —— 那里头可能有别的东西。
        try:
            said, code = _error_said(json.loads(err.read().decode("utf-8")))
        except Exception:
            said, code = "", ""
        raise HttpRefused(f"{url.rsplit('/', 1)[-1]} 回了 HTTP {err.code}"
                          + (f":{said}" if said else ""),
                          status=err.code, code=code) from None
    except (urllib.error.URLError, OSError, ValueError) as err:
        raise RuntimeError(f"{url.rsplit('/', 1)[-1]} 没打通:{err}") from None


def pair(http_base: str, code: str, name: str = DEFAULT_DEVICE_NAME,
         platform: str = PLATFORM_HANDSET, post=_post_json) -> dict:
    """拿配对码换一张设备令牌。**一次性**:同一个码用第二次会被拒。

    回的是要写进 device.json 的那份 dict(调用方负责落盘)。
    """
    said = post(f"{http_base}/pair/claim", {
        "code": code, "device_name": name, "platform": platform,
    })
    device_id = said.get("device_id")
    token = said.get("token")
    if not isinstance(device_id, str) or not isinstance(token, str) or token == "":
        raise RuntimeError("配对回包里没有 device_id / token —— 工作台版本太老?")
    return {"device_id": device_id, "token": token, "workbench_http": http_base,
            "platform": platform, "name": name}


def room_ticket_lan(http_base: str, device_token: str, name: str = DEFAULT_DEVICE_NAME,
                    post=_post_json) -> dict:
    """局域网那条:8791 替我们签。身份与设备属性都由它拼,派报不上去也不该报。"""
    return ticket_of(post(f"{http_base}/channel/token", {"name": name}, token=device_token))


#: 中转注册设备时报的类型(2026-09-23 起是 handset)。
#:
#: 以前报 other:中转的 DEVICE_KINDS 里没有「话筒」这一类。代价是**中转签的进房凭证
#: 说不出这是一只听筒** —— 工人把它当普通手机,pickSpeaker 挑不中它,手机的座机页
#: (useHandsetOnline)说「座机不在线」、「换网络」按不了。中转现在认 handset,
#: 并按这一列往凭证里签 `wb_kind`(relay/server/channel.cjs 的 channelKindAttributeOf)。
#:
#: 已经注册成 other 的那几台:**再跑一次 `--relay-login` 就改过来了**(同一个 device_id
#: 重领只是换钥匙,中转那边按这次报的类型覆盖,见 relay/server/tokens.cjs 的 issueToken)。
RELAY_DEVICE_KIND = "handset"


def relay_login(relay_base: str, identifier: str, password: str, device_id: str,
                name: str = DEFAULT_DEVICE_NAME, post=_post_json) -> str:
    """账号密码 → 会话 → 把这台派注册成账号里的一台设备 → 注销会话;回**中转令牌**。

    照手机那一套(butler-app/src/account/relayApi.ts):`POST /v1/account/login` 拿会话,
    带会话 `POST /register-device`(device_id 用配对时那一份,同一台重领只是换钥匙),
    最后 `POST /v1/account/logout` 把会话吊销 —— 派不需要长期会话,只要那把设备令牌。
    密码只在这个函数的参数里出现一次,不落盘、不进日志、不进异常消息。
    """
    if device_id == "":
        raise RuntimeError("还没配对过(device.json 里没有 device_id),先 --pair")
    said = post(f"{relay_base}/v1/account/login", {"identifier": identifier, "password": password})
    session = said.get("session_token")
    if not isinstance(session, str) or session == "":
        raise RuntimeError("登录回包里没有 session_token —— 中转版本太老?")
    try:
        issued = post(f"{relay_base}/register-device",
                      {"device_id": device_id, "name": name, "kind": RELAY_DEVICE_KIND},
                      token=session)
    finally:
        try:
            post(f"{relay_base}/v1/account/logout", {}, token=session)
        except RuntimeError:
            pass  # 注销失败不影响结果:会话本来就有期限,而令牌已经在手上
    token = issued.get("token")
    if not isinstance(token, str) or token == "":
        raise RuntimeError("注册回包里没有 token —— 中转版本太老?")
    return token


#: 身份前缀。与 workbench-plugin/src/server/channel.ts 的 `CHANNEL_PHONE_PREFIX`、
#: butler-app/src/account/roomFromRelay.ts 的 `PHONE_IDENTITY_PREFIX` 同一个字符串。
IDENTITY_PREFIX = "wb-phone-"
#: 进房凭证里那两条属性的键。同上,三处逐字相同。
DEVICE_ID_ATTRIBUTE = "wb_device_id"
KIND_ATTRIBUTE = "wb_kind"
#: 这台是什么。工人靠它决定「这一通的声音跟谁走」(pickSpeaker:房里有话筒就跟话筒)。
KIND_HANDSET = "handset"


def identity_of(device_id: str) -> str:
    """`wb-phone-<清洗过的 device_id>`。

    与 `roomFromRelay.ts` 的 `phoneIdentityOf` **同一条规则**(同一个字符集、同一个
    48 字符上限)。2026-09-22 之前派只会用「上一次局域网领到的那个身份」,于是
    **从没在局域网里配过对的派走不了中转那条路** —— 而手机 App 配网这条新流程
    压根不经局域网配对。所以这里按同一条规则自己拼一个:拼出来的和 8791 会拼的
    一模一样,不是"编一个"。
    """
    cleaned = "".join(ch if (ch.isascii() and (ch.isalnum() or ch in "_-")) else "-"
                      for ch in (device_id or ""))[:48]
    return f"{IDENTITY_PREFIX}{cleaned}" if cleaned else ""


def room_ticket_relay(relay_base: str, relay_token: str, identity: str,
                      name: str = DEFAULT_DEVICE_NAME, device_id: str = "",
                      post=_post_json) -> dict:
    """中转那条:身份原样报上去,**并且把两条属性一起报**。

    属性这一件 2026-09-22 之前漏了。后果不是"进不去房",而是更难查的那一种:
    进得去,但 `wb_device_id` 没签进凭证 → 工人不知道该用谁的权限去调 8791;
    `wb_kind` 没签进去 → 工人把这只实体话筒当成一台普通手机,`pickSpeaker` 挑不中它,
    于是「听筒里没有声音」而所有日志都是绿的(局域网那条路由 8791 代拼,一直是对的,
    所以这个洞只在中转那条路上露出来)。

    身份宁可按规则拼(`identity_of`)也不能瞎编:工人按 `wb-phone-<device_id>`
    去 8791 查设备,查不到就降权成"不是一台已配对的手机"直接 403(agent.ts 那一段)。
    """
    if identity == "":
        raise RuntimeError("还没有身份(device.json 里既没有 identity 也没有 device_id),中转这条路走不了")
    body = {"identity": identity, "name": name}
    if device_id:
        body["attributes"] = {DEVICE_ID_ATTRIBUTE: device_id, KIND_ATTRIBUTE: KIND_HANDSET}
    return ticket_of(post(f"{relay_base}/v1/channel-token", body, token=relay_token))


#: 中转把这把钥匙作废之后,device.json 里跟着一起作废的几样。
#:
#: `relay_token` 作废是明摆着的;`ticket` 与 `identity` 也得走 —— 那张进房票是**这把钥匙**
#: 签出来的,签的是旧账号那间房,留着只会让派拿着它一遍遍撞一个再也进不去的房间
#: (而且下面那条「过期了也试一次」的兜底会一直把它翻出来)。`room` 是它进的那间房的记录。
#: **不动** `device_id`(机器码算出来的,同一台重领只是换钥匙,换掉等于在账号里多一台
#: 占名额的僵尸)、`name`、`relay`(中转地址,下次添加还是这一个)、Wi-Fi(压根不在这份文件里,
#: 在 NetworkManager 的 keyfile 里 —— 清了连网都没了,那就再也添加不回来了)。
RELAY_DEAD_STALE = ("relay_token", "ticket", "identity", "room")


def cleared_relay_state(state: dict) -> dict:
    """中转说钥匙作废之后,device.json 该长什么样。**纯函数**,落盘是调用方的事。

    清完之后这台就是「没绑账号」:`provisiond` 开机按 `relay_token` 在不在算 `unbound`,
    而正在跑的那台会因为进不了房(`room_link` 每 20 秒报一次「不在房里」)在一分钟后
    自己把蓝牙打开(`provision._want_advertise`),于是手机上「添加座机」又能看见它。
    """
    return {k: v for k, v in state.items() if k not in RELAY_DEAD_STALE}


def fallback_ok(state: dict, cached: dict) -> bool:
    """两条路都不通时,手上那张**过期的**还能不能拿出来试一次(2026-09-30 收窄)。

    原来是「有就试」,于是换了账号之后派会拿着旧账号那张票一直去撞旧账号的房。
    现在要两样都对得上:

    1. **同一个房**:`state["room"]` 是上一次真的领到新票时记下的那间。
       老的 device.json 没有这一条(那时还不记),那就按票上自己写的那间算 —— 不编。
    2. **同一个身份**:知道 `device_id` 时,票上的身份必须还是这台派现在的身份。

    重新接入 / 被撤钥匙之后 `ticket` 本身就被清掉了,这里根本走不到 —— 这是第二道闸。
    """
    if not cached:
        return False
    device_id = state.get("device_id") if isinstance(state.get("device_id"), str) else ""
    if device_id and cached.get("identity") != identity_of(device_id):
        return False
    bound_room = state.get("room")
    if isinstance(bound_room, str) and bound_room:
        return cached.get("room") == bound_room
    return True


#: 问「现在该进哪个房」走的那条路。**只读、不签票**:与 workbench-plugin/src/server/http.ts
#: 的 `GET /channel/status` 同一条路由(门是 `trusted` —— 本机或**已配对的设备**,
#: 派拿它那把设备令牌进得来)。回包里 `room` / `url` 两格就是工人此刻在哪一间。
#:
#: 为什么不拿 `POST /channel/token` 问:那一问会**签一张新票**。「房没变就别重复要」
#: 正是这条修复不能违反的那一半(7 天票是 Mac 关着时派唯一的指望)。
ROOM_NOW_PATH = "/channel/status"


def room_of_status(payload: object) -> dict:
    """从 `/channel/status` 的回包里掏出「现在该进哪个房」。掏不出来回 `{}`(=问不到)。

    `configured` 不是 True 时**一律当问不到**:那时候回包里那个房名是默认占位值
    (channel.ts 的 `CHANNEL_DEFAULT_ROOM`),据它判「换房了」是编一个结论出来(D13)。
    """
    if not isinstance(payload, dict):
        return {}
    if payload.get("configured") is not True:
        return {}
    room = payload.get("room")
    if not isinstance(room, str) or room == "":
        return {}
    url = payload.get("url")
    return {"room": room, "url": url if isinstance(url, str) else ""}


def ask_room_now(http_base: str, device_token: str, get=_get_json, log=lambda line: None) -> dict:
    """问工作台一声「现在该进哪个房」。**不抛**:问不到(Mac 关着、旧版没这条路由、
    通道没配、没有局域网那把令牌)一律回 `{}`,由调用方按「不知道」处理。

    只走局域网这一条。**故意不拿中转顶上**:中转那条 `GET /v1/channel-credentials`
    答的是「这个账号那间房」(`wb-<sha256(账号)前16位>`),而那台 Mac 可能自己配着
    LiveKit(`WORKBENCH_CHANNEL_ROOM` / channel.json),两边房名本来就不是一个。
    拿它判换房的后果是**每次重连都白换一张票**,比现在这个病更难查。
    """
    if not http_base or not device_token:
        return {}
    try:
        return room_of_status(get(f"{http_base}{ROOM_NOW_PATH}", token=device_token))
    except RuntimeError as err:
        # 只记**为什么**没问到;「那就用缓存票」那句话由调用方说(它才知道手上有没有票)。
        log(f"[ticket] 「现在该进哪个房」这一问没问到({err})")
        return {}


def room_moved(cached: dict, room_now: dict) -> bool:
    """手上这张票的房,还是工作台此刻那一间吗。

    **问不到就不算换房**(`room_now` 空):不知道不等于变了 —— 那条路上要用缓存票。
    地址也比:同一个房名换了一台 livekit 不是同一间房;回包里没给地址那一格时只比房名,
    不拿一个空串当「地址变了」。
    """
    if not cached or not room_now:
        return False
    room = room_now.get("room") or ""
    if room and cached.get("room") != room:
        return True
    url = room_now.get("url") or ""
    return bool(url) and cached.get("url") != url


def acquire_ticket(state: dict, now_sec: int, relay_base: str = "", post=_post_json,
                   log=lambda line: None, on_unbind=None, get=_get_json) -> dict:
    """领一张能用的进房凭证。**局域网优先,中转兜底,两条都不通就回 `{}`。**

    存着的那张还没到期就直接用 —— 这既是省一次请求,也是**Mac 关着时派唯一的指望**
    (7 天有效期就是为这个,见 channel.ts 的 CHANNEL_DEFAULT_TOKEN_TTL_SECONDS)。

    ★ **但先问一声「现在该进哪个房」**(2026-10-03,卡 B;审计材料 2026-10-03 附证 B)。
    从前这个函数第一行就是「没过期就回缓存那张」,于是电脑重装 / 登录账号之后工人
    转进了新房间,派还拿着旧票一直进旧房 —— 而且因为**进得去**,09-30 那条
    「进不了房就把蓝牙开着」的恢复入口永远不触发,人在手机上连「添加座机」都看不见它。
    三种结局各自如实记一行:房变了 → 换票;房没变 → 接着用这张;问不到 → 用缓存票。
    """
    cached = ticket_of(state.get("ticket"))
    moved = False
    if ticket_usable(cached, now_sec):
        # 只在「手上这张还能用」时问:已经过期的本来就要换,那一问纯是多等一个超时。
        token_now = state.get("token")
        room_now = ask_room_now(state.get("workbench_http") or "",
                                token_now if isinstance(token_now, str) else "",
                                get=get, log=log)
        if not room_now:
            log(f"[ticket] 问不到工作台现在该进哪个房:用的是缓存票({cached['room']})")
            return cached
        if not room_moved(cached, room_now):
            log(f"[ticket] 工作台还在 {room_now['room']}:接着用手上这张,不重复要")
            return cached
        moved = True
        log(f"[ticket] 工作台换房了(手上这张是 {cached['room']},现在该进 {room_now['room']}):"
            "重新领一张")

    # 中转地址:环境变量(unit 里那一行)优先,其次 device.json 里手机配网时写下的那一个(`relay`),
    # 再次 `--relay-login` 写下的那一个(`relay_base`)。unit 里那一行缺省为空(零服务器是缺省),
    # 三处都没有就不走中转。
    relay_base = relay_base or next(
        (state[key] for key in ("relay", "relay_base") if isinstance(state.get(key), str) and state[key]), "")

    token = state.get("token")
    base = state.get("workbench_http") or ""
    name = state.get("name") or DEFAULT_DEVICE_NAME
    if isinstance(token, str) and token and base:
        try:
            fresh = room_ticket_lan(base, token, name, post=post)
            if fresh:
                return fresh
            log("[ticket] 局域网领到的凭证不完整,换中转试试")
        except RuntimeError as err:
            log(f"[ticket] 局域网领不到({err}),换中转试试")

    relay_token = state.get("relay_token")
    device_id = state.get("device_id") if isinstance(state.get("device_id"), str) else ""
    if relay_base and isinstance(relay_token, str) and relay_token:
        # 身份:**有缓存的用缓存的,没有就按同一条规则拼**(2026-09-22)。
        # 手机 App 配网那条新流程不经局域网配对,于是永远没有缓存的身份 ——
        # 以前这里直接报"走不了",派就一辈子进不了房而日志上只有一行"中转也领不到"。
        identity = cached.get("identity", "") or identity_of(device_id or "")
        try:
            fresh = room_ticket_relay(relay_base, relay_token, identity, name,
                                      device_id=device_id or "", post=post)
            if fresh:
                return fresh
        except RuntimeError as err:
            log(f"[ticket] 中转也领不到({err})")
            if relay_token_dead(err):
                # 钥匙被撤了 / 中转不认识它:**当场清掉**,别再拿着它敲门
                # (`room_link` 每 20 秒回来领一次票,不清就是每 20 秒敲一次)。
                # 清完这台就是「没绑账号」,蓝牙会自己开起来等人重新添加。
                log("[ticket] 中转说这把钥匙作废了:清掉它,等手机重新添加这台座机")
                if on_unbind is not None:
                    on_unbind(cleared_relay_state(state))
                return {}

    # 两条都不通:过期的那张也拿出来试一次。进不去房顶多是再重试一轮,
    # 而"手上有一张只是过期了"和"手上什么都没有"对这台机器是两件事。
    # **但只限同一个房、同一个身份**(`fallback_ok`):换了账号之后那张是别人家的票。
    #
    # ★ **知道换房了就连这条兜底也不走**(2026-10-03):`fallback_ok` 比的是 device.json
    # 里记着的那间房 —— 它记的也是旧那间,所以它会答「行」。工作台刚刚明说现在是别的房了,
    # 这时候回 `{}` 才对:进不了房 → `room_link` 每 20 秒报一次「不在房里」→ 蓝牙开起来
    # 等人重新添加。这正是 09-30 那条恢复入口一直够不着的那一下。
    if not moved and fallback_ok(state, cached):
        log("[ticket] 两条路都不通,拿手上那张过期的试一次(用的是缓存票)")
        return cached
    if moved:
        log("[ticket] 换房了但新票两条路都领不到:手上那张是旧房的,不拿它撞门")
    return {}
