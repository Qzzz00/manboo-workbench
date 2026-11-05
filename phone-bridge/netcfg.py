"""已上线的座机**换 Wi-Fi**(2026-09-22 晚,Ben:配网优先做,他要用它给派换网)。

和 `provision.py` 那条(蓝牙、开箱第一次配网)是**两条不同的路**,解决的是两件事:

| | 走哪条链路 | 什么时候用 |
|---|---|---|
| `provision.py` + `provisiond.py` | 蓝牙 BLE | 派**没网**:开箱第一次,或者换了地方连不上任何存过的网 |
| 这一份 | **房间**(LiveKit 数据通道 `wb.rpc`) | 派**已经在线**:换个网、去比赛现场之前先把那边的网配上 |

为什么不都走蓝牙:派已经在房里的时候,房间这条链路是**现成的**——手机不必靠近派、
不必要蓝牙权限、不必等那 60 秒的待配网窗口。而且这条路今晚就能用(派上那半套 BLE
一条都没在真机上验过)。反过来,派掉网之后房间这条路就不存在了,那时只有蓝牙。
**两条都要,不是二选一。**

## 这一份是纯逻辑

协议编解码、切网这一趟的看守(什么时候该报成、什么时候该回滚)、给 root 那半边的
IPC 帧。**不 import livekit、不起 subprocess、不碰 socket** —— 理由同 `provision.py`:
派上跑的逻辑要能在一台没有派的 Mac 上逐条验过。

真正动手的两头:
- `room_link.py`:收房间里那条请求、把结果发回去、重连之后把欠的结果补上;
- `provisiond.py`:root 那半边,真的去跑 nmcli(用户级的 popphone **跑不了** ——
  改系统连接要 polkit 的 `settings.modify.system`,派上没人登录只有 linger,拿不到)。

## 密码到哪儿为止

① 手机发的那条房间消息(**点名发给派**,`destination_identities`,房里别人收不到);
② 这一份里 `switch` 请求的一个字段;③ 经 Unix socket 交给 root 那半边;
④ `nmcli --ask` 的 **stdin**。**不进 argv、不进日志、不进任何回给手机的消息**。
日志一律先过 `provision.redact()`。

**老实说一句代价**:这条消息经的是中转上的 LiveKit 服务器(TLS,但不是端到端加密),
服务器的运营者理论上看得见。那台服务器是 Ben 自己的。蓝牙那条也一样不是加密链路
(见交接文档「没做的」)。真要端到端得再加一层,这一版没做。
"""
import json
import uuid

from provision import classify_connect, fail_text, parse_wifi_list, parse_saved, redact  # noqa: F401

# ———————————————————————— 房间里那条消息 ————————————————————————

#: 消息的 `type`。**不叫 `call`** —— 工人(channel-worker/src/rpc.ts)按 type 分发,
#: 借用 `call` 会被它当成一条来电指令。`netcfg` 它不认得,原样忽略,正是我们要的。
MSG_TYPE = "netcfg"

#: 两条动作。
ACTION_SCAN = "scan"
ACTION_SWITCH = "switch"
ACTIONS = (ACTION_SCAN, ACTION_SWITCH)

#: 手机的身份前缀。派只听这个前缀发来的 netcfg —— 房里另外那位是工人,
#: 它不该指挥派换网(而且它也不会发)。身份是**签在凭证里的**,自己改不了。
PHONE_PREFIX = "wb-phone-"


def parse_netcfg_request(raw: str, from_identity: str = "") -> dict:
    """房间里来的一行 JSON → 一条换网请求。**读不懂一律 `{}`,绝不抛**。

    校验四样,少一样就不认:
      · 发的人是手机(`wb-phone-*`)—— 工人发的 ring 走的是另一条解析,不会落到这里;
      · `type` 是 `netcfg`;
      · `id` 是非空字符串(结果要按它回);
      · `action` 在认得的两条里。
    `switch` 还要有非空 `ssid`(`psk` 可以是空串 —— 开放网真的不要密码)。
    """
    if from_identity != "" and not from_identity.startswith(PHONE_PREFIX):
        return {}
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(msg, dict) or msg.get("type") != MSG_TYPE:
        return {}
    req_id = msg.get("id")
    action = msg.get("action")
    if not isinstance(req_id, str) or req_id == "" or action not in ACTIONS:
        return {}
    out = {"id": req_id, "action": action, "from": from_identity}
    if action == ACTION_SWITCH:
        ssid = msg.get("ssid")
        if not isinstance(ssid, str) or ssid == "":
            return {}
        psk = msg.get("psk")
        out["ssid"] = ssid
        out["psk"] = psk if isinstance(psk, str) else ""
    return out


def scan_result(req_id: str, networks: list) -> str:
    """扫描结果。字段与蓝牙那条的 `parse_wifi_list` 产物**逐字相同** ——
    手机端两条流程共用同一个 `HandsetNetwork` 与同一份排序。"""
    return json.dumps({"id": req_id, "type": MSG_TYPE, "action": ACTION_SCAN,
                       "ok": True, "networks": networks}, ensure_ascii=False)


def switch_result(req_id: str, ok: bool, code: str = "", text: str = "",
                  ssid: str = "", ip: str = "", rolled_back: bool = False) -> str:
    """换网结果。**没有密码、没有令牌** —— 这条会经服务器走一趟。

    `rolled_back` 告诉手机「已经切回原来的网了」:界面上那句话完全不同
    (「没换成,座机还在原来的网上」vs「没换成,而且座机现在可能离线了」)。
    """
    return json.dumps({"id": req_id, "type": MSG_TYPE, "action": ACTION_SWITCH,
                       "ok": bool(ok), "code": code, "text": text,
                       "ssid": ssid, "ip": ip, "rolled_back": bool(rolled_back)},
                      ensure_ascii=False)


def error_result(req_id: str, action: str, text: str) -> str:
    """办不了(root 那半边不在、socket 连不上之类)。**如实说**,不装作成了。"""
    return json.dumps({"id": req_id, "type": MSG_TYPE, "action": action,
                       "ok": False, "code": "unavailable", "text": text},
                      ensure_ascii=False)


# ———————————————————————— 切网这一趟的看守 ————————————————————————
#
# 换网和别的动作有一处根本不同:**切过去的那一刻,报结果的那条链路自己断了**。
# 派换到新网 → 和服务器的连接掉 → 重连 → 这时才有可能把结果发出去。
# 所以「成没成」不能只看 nmcli 怎么说:nmcli 说「连上了」只代表连上了那个**路由器**,
# 不代表那个网出得了外网、更不代表回得到房间里(比赛现场的网要在网页上点同意才放行,
# 这种网 nmcli 一样报成功)。
#
# 真正的判据只有一个:**换过去之后,派自己重新回到房间里了**。
# 回不来就在原地把网切回去 —— 那是唯一能让他"至少东西还在"的结局。

#: 切过去之后等多久才算"回不来了"。90 秒:NM 拿到地址几秒、DNS 与 TLS 几秒、
#: 重连退避最坏 30 秒,再留一倍余量。太短会把一个只是慢的网判死并白白切回去。
VERIFY_SEC = 90

#: 回滚之后再等多久。回老网是"它本来就连得上"的那个网,不该要这么久。
ROLLBACK_VERIFY_SEC = 60

#: 看守的四种答复。
WAIT = "wait"                              # 还没到点,继续等
REPORT_OK = "report_ok"                    # 回来了,报成
ROLLBACK = "rollback"                      # 到点没回来,把网切回去
REPORT_ROLLED_BACK = "report_rolled_back"  # 切回老网之后回来了,报「没换成,但东西还在」
GIVE_UP = "give_up"                        # 切回去也没回来(这条只会打在派自己的日志里)


class SwitchWatch:
    """一趟换网的看守。**纯的**:不睡觉、不发消息,只回答「现在该干什么」。

    用法(`room_link.py`):
      · 发 nmcli 之前 `begin(...)`,记下这会儿是第几次进房(`join_seq`);
      · 每次重新进房之后把新的 `join_seq` 喂给 `decide()`;
      · 定时器每秒也喂一次(`now` 在动,`join_seq` 不动)。

    「回来了」的判据是 **`join_seq` 比开始那会儿大** —— 不是"连接还在"。
    切网必然会断一次,连接还在只说明 nmcli 那一下还没生效。
    """

    def __init__(self):
        self.pending = None

    def begin(self, req_id: str, who: str, ssid: str, previous: str,
              now: int, join_seq: int) -> None:
        """`previous` 是切之前那条连接的名字(回滚要用;拿不到就空串)。"""
        self.pending = {
            "id": req_id, "from": who, "ssid": ssid, "previous": previous,
            "deadline": now + VERIFY_SEC, "join_seq": join_seq, "rolled_back": False,
        }

    def busy(self) -> bool:
        return self.pending is not None

    def decide(self, now: int, join_seq: int) -> tuple:
        """(该干什么, 那件事要的东西)。没有在等的一趟就是 `(WAIT, {})`。"""
        job = self.pending
        if job is None:
            return WAIT, {}
        if join_seq > job["join_seq"]:
            self.pending = None
            return (REPORT_ROLLED_BACK if job["rolled_back"] else REPORT_OK), dict(job)
        if now < job["deadline"]:
            return WAIT, {}
        if job["rolled_back"]:
            # 切回去也没回来。**不再动手** —— 再切一次只会让它在两个连不上的网之间
            # 来回跳。派上那条 wifi 看门狗(每 20 秒硬连存过的网)接着管。
            self.pending = None
            return GIVE_UP, dict(job)
        job["rolled_back"] = True
        job["deadline"] = now + ROLLBACK_VERIFY_SEC
        return ROLLBACK, dict(job)

    def cancel(self) -> None:
        self.pending = None


#: 回滚回来之后报给手机的那一句。**说清两件事**:没换成、东西还在。
ROLLED_BACK_TEXT = "没换成:座机连上了 {ssid},但从那个网上回不到服务器(常见于要在网页上点同意才能用的网)。已经切回原来的网,座机还在线。"
#: 连滚回去都没回来 —— 这条发不出去(派不在房里),只打在派自己的日志上。
GIVE_UP_TEXT = "切到 {ssid} 之后回不来,切回原来的网也没回来。交给 wifi 看门狗。"


def rolled_back_text(ssid: str) -> str:
    return ROLLED_BACK_TEXT.replace("{ssid}", ssid or "那个网")


def give_up_text(ssid: str) -> str:
    return GIVE_UP_TEXT.replace("{ssid}", ssid or "那个网")


# ———————————————————————— root 那半边的 IPC ————————————————————————
#
# 为什么要这一层:房间那一半跑在用户 `ben` 下(popphone),而 nmcli 改系统连接要 root。
# 一条 Unix socket 把两边连起来,**一条请求一行 JSON、一条应答一行 JSON、然后关**。
# 不做长连接、不做多路复用:一趟换网前后一共三四次来回,复杂度不值得。

#: socket 的位置。`/run` 是 tmpfs,重启自动没了,不会留下一个属主不对的旧文件。
SOCKET_PATH = "/run/wb-provision.sock"

#: 一行最多这么长。防的是"对面写了一串没有换行的东西"。
IPC_LIMIT = 64 * 1024

IPC_SCAN = "scan"
IPC_SWITCH = "switch"
IPC_ROLLBACK = "rollback"
IPC_CURRENT = "current"
#: 进房那一半报「这会儿在不在通话房间里」(2026-09-30):root 那半边据此决定蓝牙开不开 ——
#: 连着网却进不了房时,蓝牙是唯一还能进来的门。
IPC_ROOM = "room"
IPC_OPS = (IPC_SCAN, IPC_SWITCH, IPC_ROLLBACK, IPC_CURRENT, IPC_ROOM)


def encode_ipc(payload: dict) -> bytes:
    """一条 → 一行(末尾带换行)。"""
    return (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def decode_ipc(raw: bytes) -> dict:
    """一行 → 一条。**读不懂回 `{}`**。"""
    try:
        parsed = json.loads(raw.decode("utf-8").strip() or "null")
    except (UnicodeDecodeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def ipc_request(op: str, **fields) -> dict:
    return {"op": op, **fields}


def valid_ipc(request: dict) -> bool:
    """root 那半边收到的东西**先过这一关**。socket 上的字节不比网上的可信多少:
    同一台机器上任何能读到那个 socket 的进程都写得进来。"""
    if not isinstance(request, dict) or request.get("op") not in IPC_OPS:
        return False
    if request.get("op") == IPC_SWITCH:
        return isinstance(request.get("ssid"), str) and request["ssid"] != ""
    if request.get("op") == IPC_ROLLBACK:
        return isinstance(request.get("name"), str) and request["name"] != ""
    if request.get("op") == IPC_ROOM:
        return isinstance(request.get("in_room"), bool)
    return True


# ———————————————————————— nmcli:切网与回滚 ————————————————————————

def parse_active_wifi(stdout: str, iface: str = "wlan0") -> str:
    """`nmcli -t -f NAME,DEVICE,TYPE connection show --active` → 这块网卡上那条连接的**名字**。

    要的是**名字**不是 SSID:回滚走的是 `nmcli connection up <名字>`,而连接名
    与 SSID **不一定相同**(netplan 生成的那几条叫 `netplan-wlan0-Ben`,
    见硬件文档 2026-09-22 那一节)。拿 SSID 去 up 会「找不到这条连接」。
    """
    from provision import _split_terse  # 同一份 terse 切法,不抄第二遍
    for line in stdout.splitlines():
        fields = _split_terse(line.strip())
        if len(fields) >= 3 and fields[1].strip() == iface and fields[2].strip() in ("802-11-wireless", "wifi"):
            return fields[0]
    return ""


def active_command() -> list:
    return ["nmcli", "-t", "-f", "NAME,DEVICE,TYPE", "connection", "show", "--active"]


def rollback_plan(name: str, iface: str = "wlan0", timeout: int = 30) -> list:
    """切回那条连接。**按名字**,理由见 `parse_active_wifi`。"""
    return ["nmcli", f"--wait={int(timeout)}", "connection", "up", name, "ifname", iface]
