"""座机配网(2026-09-22)。**这一份是纯逻辑**:状态机、nmcli 输出解析、消息编解码。

不 import dbus、不 import gi、不起 subprocess —— 真正的蓝牙与 nmcli 在 `provisiond.py`。
拆成两份的理由和 `phone_state.py` 一样:派上跑的那份逻辑,要能在一台没有蓝牙、没有
NetworkManager 的 Mac 上用 `python3 -m unittest` 逐条验过。

## 为什么是 BLE 而不是「派自己开热点」

Ben 定的硬要求是「整套流程在客户端里完成」。两条路都能做到不碰系统设置,但:

- **BLE**:手机**不离开自己的网**。这一点是决定性的 —— 这条流程的最后一步要拿账号的
  会话令牌去中转换一张设备令牌(`/register-device`),那一下**手机必须有外网**。
  派开热点时手机连的是一个 local-only 网(Android 的 `WifiNetworkSpecifier`),
  那期间手机没有外网,于是「配网」和「进房」两件事在同一条流程里互相打架:
  要么先连热点配网、断开、再连回自己的网去领令牌(中间那一下断开之后派就找不回来了),
  要么先领令牌再连热点(那就得把令牌在手机上先攒着,而它是一把钥匙)。
- **热点**还有一串 Android 的限制:`WifiNetworkSpecifier` 在 Android 10+ 每次都要弹一个
  系统对话框、连上之后那条网络**只对本 App 可见且不走默认路由**、退出 App 就断,
  而 Android 9 及以下走的是另一套 API。三套代码路径,没有真机的情况下没一条验得了。

BLE 这边:手机扫到「工作台座机-XXXX」→ 连上 → 在同一条 GATT 连接上问网、送密码、
看结果、交令牌,全程 Wi-Fi 一直连着自己家的网。这也是市面上智能音箱/灯泡的标准做法。

**代价写清楚**:Zero 2W 的蓝牙挂在 UART 上,Debian 的 raspi 镜像要 `bluez` +
`bluez-firmware-raspi` 才认得出来,而且 `dtoverlay=disable-bt` 一旦出现在 config.txt 里
就全盘失效 —— 这几条在真机上一条都没验过,见交接文档第七节。

## 谁在跑这一份

`provisiond.py`,**system 级** systemd 服务、跑在 root 下(`wb-provision.service`)。
与用户级的 `phone-bridge.service` 并存,互不打扰。为什么是 root 而不是跟 phone-bridge
一样挂在 ben 下面:

1. bluez 的 `org.bluez` D-Bus 接口(注册 GATT 应用 + 发广播)在 Debian 的默认策略下
   只对 root 与 `bluetooth` 组放行;
2. `nmcli` 改系统连接要 polkit 的 `...settings.modify.system`,非 root 且没有活动 seat 的
   用户级服务拿不到(派上没人登录,只有 linger);
3. 密码要落成 NM 的 keyfile(`/etc/NetworkManager/system-connections/`,0600 root)。

装它要 sudo,所以**不在 `deploy.sh` 里装**(那个脚本的老规矩是不 sudo):
由 cloud-init 的 user-data 在首次开机时以 root 落盘,或者 Ben 自己跑两行。

## 密码去哪儿了

只在三个地方出现过:① BLE 写进来的那一帧;② `connect` 动作的第二个参数;
③ 送进 `nmcli --ask` 的 **stdin**。**不进 argv**(`ps` 看得见)、不进日志、不进任何文件
(NM 自己的 keyfile 除外,那是它该在的地方)、不进异常消息。
`redact()` 是给日志用的那道闸,`provisiond.py` 里每一条日志都要过它。
"""
from dataclasses import dataclass, replace
from typing import Optional
import json

# ———————————————————————— GATT 那三个口 ————————————————————————
#
# 随机的 128 位 UUID(不是任何标准服务)。手机那边 butler-app/src/handset/provisionProtocol.ts
# 有**逐字相同**的一份 —— 改这里就得改那里,不然扫得到、连不上、报不出原因。

SERVICE_UUID = "8f5a7b10-4c3d-4a9e-9b21-6d0c5e7a1f00"
#: 派 → 手机:一条 JSON 的状态(在干什么、成没成、人话)。notify + read。
CHAR_STATUS = "8f5a7b11-4c3d-4a9e-9b21-6d0c5e7a1f00"
#: 派 → 手机:扫到的 Wi-Fi 列表(一条 JSON)。notify + read。
CHAR_NETWORKS = "8f5a7b12-4c3d-4a9e-9b21-6d0c5e7a1f00"
#: 手机 → 派:命令(scan / connect / link / status)。write。
CHAR_COMMAND = "8f5a7b13-4c3d-4a9e-9b21-6d0c5e7a1f00"

#: 广播名的前缀。后面跟四位、取自 machine-id。手机那边只把它当**显示名**,
#: 找设备靠的是上面那个 service UUID(名字进的是扫描响应包,可能被截)。
NAME_PREFIX = "工作台座机-"


# ———————————————————————— 时限 ————————————————————————

#: 开机后没连上任何已知 Wi-Fi 多久才进「待配网」并开始广播。
#: 60 秒不是随手写的:派开机到 NetworkManager 把 wlan0 拉起来实测要十几到几十秒
#: (2026-09-22 真机一次等了 10 分钟,那是热点那头的毛病)。太短会让一台其实连得上的
#: 派每次开机都白广播一分钟;太长则让一台真的没网的派干等。
WAIT_BEFORE_ADVERTISE_SEC = 60

#: 连上之后**继续可被发现**多久,给 App 收尾(交令牌、看一眼状态)。
#: 到点停广播:一台常年摆在桌上的设备不该一直对外喊「我在这儿,来配我」。
GRACE_AFTER_ONLINE_SEC = 60

#: 已经在线的派掉网多久才重新广播。和上面同一个数,同一个理由(别为一次抖动就开门)。
OFFLINE_BEFORE_ADVERTISE_SEC = 60

#: 开机之后**不管有没有网**先开蓝牙这么久(2026-09-30 维护者:「开机之后都打开一分钟」)。
BOOT_ADVERTISE_SEC = 60

#: 进房那一半(popphone)多久没报「我在房里」就当它不在房里了。它每 20 秒报一次。
ROOM_STALE_SEC = 90

#: 「连不上网 / 进不了房」持续多久才开蓝牙(开机那一段从开机算起,所以开机就不通的派一直开着)。
#: 在房里掉线一小会儿(一次重连)不该就开门。
TROUBLE_BEFORE_ADVERTISE_SEC = 60

#: 一次 `nmcli dev wifi connect` 等多久。NM 自己的默认是 90 秒,这里收到 45:
#: 密码错的情形 NM 往往要等完整个超时才回话,而人盯着手机上那根进度条。
CONNECT_TIMEOUT_SEC = 45


# ———————————————————————— 相位 ————————————————————————

#: 刚开机,还在等 NM 把网拉起来。不广播。
BOOTING = "booting"
#: 待配网:没网、正在广播、等手机来。
WAITING = "waiting"
#: 正在扫 Wi-Fi(手机点了「重新找」或刚连上蓝牙)。
SCANNING = "scanning"
#: 正在连一个 Wi-Fi。
CONNECTING = "connecting"
#: 连上了,广播还开着(收尾窗口内)。
ONLINE = "online"
#: 正在把 App 交过来的令牌写下去、重启 phone-bridge。
LINKING = "linking"
#: 收尾窗口过了 / 开机就有网:不广播,安静待着。
QUIET = "quiet"


@dataclass(frozen=True)
class Provision:
    phase: str = BOOTING
    #: 这个相位是什么时候进来的(秒)。所有时限都从它算。
    since: int = 0
    #: 正在广播吗。**状态机说了算**,`provisiond` 只负责兑现。
    advertising: bool = False
    #: 这会儿连着的 Wi-Fi 名(没连上是 None)。要显示给人看,不是秘密。
    ssid: Optional[str] = None
    #: 本机地址,显示用。
    ip: Optional[str] = None
    #: 上一次失败的机器码(`bad_password` 之类),给手机那头挑文案用。
    error: Optional[str] = None
    #: 一句人话。**原样显示** —— 手机那边不再包一层。
    text: str = ""
    #: 令牌交下来了没有(只记「有没有」,令牌本身一个字节都不进状态机)。
    linked: bool = False
    #: 收尾窗口什么时候到点(秒)。None = 不在窗口里。
    grace_until: Optional[int] = None
    #: 没绑账号(device.json 里没有中转令牌,2026-09-27)。有网也广播,等手机「添加座机」。
    unbound: bool = False
    #: 进房那一半最近报的:在不在通话房间里(2026-09-30)。
    in_room: bool = False
    #: 那一条报告是几点收到的。太久没报 = 不算在房里(`ROOM_STALE_SEC`)。
    room_at: Optional[int] = None
    #: 开机那一分钟到几点(第一次进状态机时按 since 算)。
    boot_until: Optional[int] = None
    #: 手机最近一次发命令后,再开多久(他正在用蓝牙配它,门不能在他手底下关)。
    active_until: Optional[int] = None
    #: 「连不上网 / 进不了房」从几点开始的。通了就清掉。
    trouble_since: Optional[int] = None


# ———————————————————————— 事件构造器 ————————————————————————

def tick_event(now: int) -> dict:
    return {"kind": "tick", "now": now}


def wifi_event(now: int, online: bool, ssid: str = "", ip: str = "") -> dict:
    """NM 那边的实况(`provisiond` 每几秒问一次)。"""
    return {"kind": "wifi", "now": now, "online": online, "ssid": ssid, "ip": ip}


def command_event(now: int, command: dict) -> dict:
    """手机从 BLE 写进来的一条。`command` 是 `decode_command()` 的产物。"""
    return {"kind": "cmd", "now": now, "command": command}


def scan_done_event(now: int, networks: list) -> dict:
    return {"kind": "scan_done", "now": now, "networks": networks}


def connect_done_event(now: int, ok: bool, code: str = "", text: str = "", ssid: str = "") -> dict:
    return {"kind": "connect_done", "now": now, "ok": ok, "code": code, "text": text, "ssid": ssid}


def link_done_event(now: int, ok: bool, text: str = "") -> dict:
    return {"kind": "link_done", "now": now, "ok": ok, "text": text}


def room_event(now: int, in_room: bool) -> dict:
    """进房那一半(popphone)报的:这会儿在不在通话房间里。每 20 秒一条,进出房各一条。"""
    return {"kind": "room", "now": now, "in_room": bool(in_room)}


# ———————————————————————— 人话 ————————————————————————
#
# 一处定义,两头共用(手机那边照抄一份在 provisionProtocol.ts 里,对着这里的 code 挑)。
# 每一条都要能回答「我现在该做什么」,而不只是「出了什么事」。

TEXT = {
    "booting": "座机刚开机,正在找网…",
    "waiting": "座机还没连上 Wi-Fi,等你告诉它连哪个",
    "scanning": "正在让座机扫一遍附近的 Wi-Fi…",
    "connecting": "座机正在连 {ssid}…",
    "online": "座机连上 {ssid} 了",
    "linking": "正在把这台座机记到你的账号下…",
    "linked": "座机已上线",
    "quiet": "座机连着 {ssid},一切正常",
    "no_room": "座机连着 {ssid},但进不了通话房间。在手机上「添加座机」重新添加一次就好",
}

#: 连不上的几种,逐条一句人话 + 一句「那怎么办」。
FAIL_TEXT = {
    "bad_password": "密码不对。重新输一遍试试(注意大小写)",
    "not_found": "附近没找到这个 Wi-Fi。座机只认 2.4G 的网,5G 的它看不见",
    "timeout": "连了半天没连上。座机离路由器太远,或者这个网要在网页上点同意才能用",
    "no_wifi": "座机上找不到无线网卡(wlan0)。这台机器的 Wi-Fi 可能被关掉了",
    "failed": "没连上",
}


def say(phase: str, ssid: str = "") -> str:
    return TEXT.get(phase, "").replace("{ssid}", ssid or "这个网")


def fail_text(code: str, detail: str = "") -> str:
    """机器码 → 人话。

    **`failed` 是"我们也不知道"那一档**:这时候原样带上 nmcli 那句(它至少是真的),
    编一个好听的说法,人照着它什么也修不好。
    """
    base = FAIL_TEXT.get(code)
    if base is not None and code != "failed":
        return base
    return (detail or "").strip() or FAIL_TEXT["failed"]


# ———————————————————————— 状态机 ————————————————————————

def transition(state: Provision, event: dict) -> tuple:
    """(新状态, 动作列表)。**纯函数**,不碰 IO。

    动作一共五种,`provisiond` 一条条兑现:

      ("advertise", True/False)      开 / 关 BLE 广播
      ("scan",)                      扫一遍 Wi-Fi
      ("connect", ssid, psk)         连(psk 只在这里出现,不进日志)
      ("link", payload)              把令牌写进 device.json 并重启 phone-bridge
      ("notify_status",)             把当前状态推给手机
      ("notify_networks", networks)  把 Wi-Fi 列表推给手机
    """
    kind = event.get("kind")
    now = int(event.get("now") or 0)
    if state.boot_until is None:
        # 第一次进来:开机那一分钟从开机那一刻(since)算;「不通」也从开机算起。
        state = replace(state, boot_until=state.since + BOOT_ADVERTISE_SEC, trouble_since=state.since)
    before = state.advertising
    moved, actions = _handle(state, event, kind, now)
    return _reconcile(moved, actions, now, before)


def _handle(state: Provision, event: dict, kind, now: int) -> tuple:
    if kind == "room":
        return replace(state, in_room=bool(event.get("in_room")), room_at=now), []
    if kind == "tick":
        return _tick(state, now)
    if kind == "wifi":
        return _wifi(state, event, now)
    if kind == "cmd":
        return _command(state, event, now)
    if kind == "scan_done":
        nets = event.get("networks") or []
        # 扫完回到「谁叫我扫的」那个相位:没网就还是待配网,有网就还是在线。
        back = ONLINE if state.ssid else WAITING
        moved = replace(state, phase=back, since=now, text=say(back, state.ssid or ""))
        return moved, [("notify_networks", nets), ("notify_status",)]
    if kind == "connect_done":
        return _connect_done(state, event, now)
    if kind == "link_done":
        ok = bool(event.get("ok"))
        moved = replace(
            state, phase=ONLINE, since=now, linked=ok,
            # 没绑账号那条路一直广播着;交下令牌了才进收尾窗口。
            **({"unbound": False, "grace_until": now + GRACE_AFTER_ONLINE_SEC} if ok and state.unbound else {}),
            error=None if ok else "link_failed",
            text=TEXT["linked"] if ok else (str(event.get("text") or "") or "没记上"),
        )
        return moved, [("notify_status",)]
    return state, []


def _healthy(state: Provision, now: int) -> bool:
    """连着网,而且进房那一半最近报过「在房里」。"""
    return (state.ssid is not None and state.in_room and state.room_at is not None
            and now - state.room_at <= ROOM_STALE_SEC)


def _want_advertise(state: Provision, now: int) -> bool:
    """**蓝牙该不该开着**(2026-09-30 维护者三条,见 provision_test「蓝牙什么时候开」)。
    只有「连着网 + 在房里 + 没人在用蓝牙 + 开机那一分钟过了」才关;缺哪一样都开着。"""
    if state.phase in (SCANNING, CONNECTING, LINKING) or state.unbound:
        return True
    for until in (state.boot_until, state.active_until, state.grace_until):
        if until is not None and now < until:
            return True
    return state.trouble_since is not None and now - state.trouble_since >= TROUBLE_BEFORE_ADVERTISE_SEC


def _reconcile(state: Provision, actions: list, now: int, before: bool) -> tuple:
    """每处理完一个事件统一算一遍:「不通」从几点开始、蓝牙该不该开、相位与那句话跟着对齐。
    各分支自己发的 advertise 一律以这里为准(只发一次、只在真的变了的时候发)。"""
    if _healthy(state, now):
        state = replace(state, trouble_since=None)
    elif state.trouble_since is None:
        # 在房里的报告是「放着放着过期了」:不通从过期那一刻算,不是从这一拍算。
        stale_at = (state.room_at + ROOM_STALE_SEC
                    if state.ssid is not None and state.in_room and state.room_at is not None else now)
        state = replace(state, trouble_since=min(stale_at, now))
    want = _want_advertise(state, now)
    rest = [a for a in actions if a[0] != "advertise"]
    if want and state.phase == QUIET:
        phase = ONLINE if state.ssid is not None else WAITING
        text = say("no_room", state.ssid or "") if state.ssid is not None and not _healthy(state, now) else say(phase, state.ssid or "")
        state = replace(state, phase=phase, since=now, text=text)
    if not want and state.advertising and state.phase not in (BOOTING,):
        state = replace(state, phase=QUIET, since=now, grace_until=None, text=say(QUIET, state.ssid or ""))
    state = replace(state, advertising=want)
    if want != before:
        rest.append(("advertise", want))
        if want and ("notify_status",) not in rest:
            rest.append(("notify_status",))
    return state, rest


def _tick(state: Provision, now: int) -> tuple:
    """时钟只管三件事:开机等够了没、收尾窗口到点没、掉线够久了没。"""
    if state.phase == BOOTING and now - state.since >= WAIT_BEFORE_ADVERTISE_SEC:
        moved = replace(state, phase=WAITING, since=now, advertising=True, text=say(WAITING))
        return moved, [("advertise", True), ("notify_status",)]

    if state.grace_until is not None and now >= state.grace_until:
        # 收尾窗口到点:停广播,安静下来。**状态里还留着 linked** —— 那是给下次开机
        # 的日志看的,不影响任何判断。
        moved = replace(state, phase=QUIET, since=now, advertising=False, grace_until=None,
                        text=say(QUIET, state.ssid or ""))
        return moved, [("advertise", False)]

    if state.phase == QUIET and state.ssid is None and now - state.since >= OFFLINE_BEFORE_ADVERTISE_SEC:
        moved = replace(state, phase=WAITING, since=now, advertising=True, text=say(WAITING))
        return moved, [("advertise", True), ("notify_status",)]

    return state, []


def _wifi(state: Provision, event: dict, now: int) -> tuple:
    """NM 的实况。**只在「有没有网」真的变了的时候动状态** —— 每几秒来一条,
    每条都重置一次 since 的话,上面那几个时限永远到不了点。"""
    online = bool(event.get("online"))
    ssid = (event.get("ssid") or "") or None
    ip = (event.get("ip") or "") or None

    if state.phase == CONNECTING:
        # 正在连的时候不听 NM 的旁白:结果以 connect_done 为准(那一条才分得清
        # 「密码错」和「还没连上」,而这里只看得见 online=False)。
        return state, []

    was = state.ssid is not None
    if online and not was:
        # 开机就有网:**一次广播都不发**。这是最常见的那条路(派已经记得家里的 Wi-Fi)。
        if state.phase == BOOTING:
            if state.unbound:
                # 有网、但没绑账号(统筹 2026-09-27「座机初始化」):开广播等手机来添加,不设收尾窗口。
                moved = replace(state, phase=ONLINE, since=now, ssid=ssid, ip=ip, error=None,
                                advertising=True, grace_until=None, text=say(ONLINE, ssid or ""))
                return moved, [("advertise", True), ("notify_status",)]
            moved = replace(state, phase=QUIET, since=now, ssid=ssid, ip=ip,
                            advertising=False, text=say(QUIET, ssid or ""))
            return moved, []
        # 待配网期间自己连上了(看门狗轮到了一个存着的网):当成连上,照样给收尾窗口。
        moved = replace(state, phase=ONLINE, since=now, ssid=ssid, ip=ip, error=None,
                        grace_until=now + GRACE_AFTER_ONLINE_SEC, text=say(ONLINE, ssid or ""))
        return moved, [("notify_status",)]

    if not online and was:
        moved = replace(state, phase=QUIET, since=now, ssid=None, ip=None,
                        text="座机掉网了,正在重连…")
        return moved, [("notify_status",)] if state.advertising else []

    if online and (ssid != state.ssid or ip != state.ip):
        # 换了个网 / 换了个地址:只更新显示,不动相位与时限。
        return replace(state, ssid=ssid, ip=ip), []

    return state, []


def _command(state: Provision, event: dict, now: int) -> tuple:
    """手机写进来的一条。**只有在广播着的时候才听** —— 停了广播就不该再有人指挥它,
    而 BLE 连接可能比广播活得久(连上之后广播停了,那条连接还在)。"""
    command = event.get("command") or {}
    op = command.get("op")

    if not state.advertising and op != "status":
        return state, [("notify_status",)]

    # 手机正在用蓝牙跟它说话:再开 GRACE 那么久,别在他手底下关门(2026-09-30)。
    state = replace(state, active_until=now + GRACE_AFTER_ONLINE_SEC)

    # 任何一条命令都把收尾窗口往后推:人还在操作,别在他手底下把门关了。
    pushed = state
    if state.grace_until is not None:
        pushed = replace(state, grace_until=now + GRACE_AFTER_ONLINE_SEC)

    if op == "status":
        return pushed, [("notify_status",)]

    if op == "scan":
        moved = replace(pushed, phase=SCANNING, since=now, text=say(SCANNING))
        return moved, [("scan",), ("notify_status",)]

    if op == "connect":
        ssid = str(command.get("ssid") or "")
        psk = str(command.get("psk") or "")
        if ssid == "":
            return pushed, [("notify_status",)]
        moved = replace(pushed, phase=CONNECTING, since=now, ssid=None, error=None,
                        text=say(CONNECTING, ssid))
        # ssid 放进 text 里显示,但状态里的 ssid 先清掉:**还没连上就不算连着**。
        return moved, [("connect", ssid, psk), ("notify_status",)]

    if op == "link":
        if state.ssid is None:
            moved = replace(pushed, error="offline", text="座机还没连上 Wi-Fi,先把网配好再记账号")
            return moved, [("notify_status",)]
        moved = replace(pushed, phase=LINKING, since=now, text=say(LINKING))
        return moved, [("link", command), ("notify_status",)]

    # 读不懂的一律忽略(同 signals.py 的老规矩:多一种新命令不该让配网服务挂掉)。
    return pushed, []


def _connect_done(state: Provision, event: dict, now: int) -> tuple:
    if event.get("ok"):
        ssid = (event.get("ssid") or "") or None
        moved = replace(state, phase=ONLINE, since=now, ssid=ssid, error=None,
                        grace_until=now + GRACE_AFTER_ONLINE_SEC, text=say(ONLINE, ssid or ""))
        return moved, [("notify_status",)]
    code = str(event.get("code") or "failed")
    moved = replace(state, phase=WAITING, since=now, ssid=None, error=code,
                    text=fail_text(code, str(event.get("text") or "")))
    return moved, [("notify_status",)]


# ———————————————————————— 状态 → 一条 JSON ————————————————————————

def status_payload(state: Provision, device_id: str = "", name: str = "") -> dict:
    """推给手机的那一条。**没有令牌、没有密码、没有任何秘密** ——
    它会经 BLE 明文走一趟(这条链路没有配对加密,见文档「没做的」第 2 条)。"""
    return {
        "phase": state.phase,
        "text": state.text,
        "ssid": state.ssid or "",
        "ip": state.ip or "",
        "error": state.error or "",
        "linked": state.linked,
        "device_id": device_id,
        "name": name,
    }


# ———————————————————————— 分帧(BLE 那 20 个字节) ————————————————————————
#
# 协商前的 ATT MTU 是 23,能装的净荷只有 20 字节;协商后 Android 上通常是 185 或 517,
# **但不保证**。所以两头都不许假设一条消息装得下:统一分帧。
#
#   每一帧 = 1 字节帧头 + 净荷
#   帧头 0x01 = 后面还有;0x00 = 这是最后一帧
#
# 为什么不用"末尾加个换行"那种分隔符:JSON 里可以合法地出现换行,而且真出现时
# 表现是"偶尔丢一条消息",最难查的那一类。

FRAME_MORE = 0x01
FRAME_LAST = 0x00
#: 帧头占掉的那一个字节。
FRAME_HEADER = 1


def encode_frames(payload: dict, mtu: int = 23) -> list:
    """一条 JSON → 若干帧(bytes)。`mtu` 是协商后的 ATT MTU,净荷 = mtu - 3 - 1。"""
    room = max(1, int(mtu) - 3 - FRAME_HEADER)
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    frames = []
    for start in range(0, max(len(raw), 1), room):
        chunk = raw[start:start + room]
        last = start + room >= len(raw)
        frames.append(bytes([FRAME_LAST if last else FRAME_MORE]) + chunk)
    return frames


class FrameAssembler:
    """把一串帧拼回一条 JSON。**读不懂就扔,绝不抛** —— 这条链路上任何一个字节都可能
    是别人的扫描器写进来的。"""

    #: 攒到这么多字节还没等到最后一帧就整个扔掉。防的是"对面写了一串 0x01 就走了"。
    LIMIT = 8 * 1024

    def __init__(self):
        self._buffer = bytearray()

    def feed(self, frame: bytes):
        """喂一帧。拼完一条回那条 dict,没拼完回 None。"""
        if not frame:
            return None
        head, body = frame[0], frame[1:]
        if head not in (FRAME_MORE, FRAME_LAST):
            self._buffer.clear()
            return None
        self._buffer.extend(body)
        if len(self._buffer) > self.LIMIT:
            self._buffer.clear()
            return None
        if head == FRAME_MORE:
            return None
        raw = bytes(self._buffer)
        self._buffer.clear()
        return decode_command(raw)


def decode_command(raw: bytes) -> Optional[dict]:
    """一段 UTF-8 JSON → 命令 dict。**不是对象、没有 op 一律 None**。"""
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("op"), str):
        return None
    return parsed


#: 日志里一律打星号的字段名。**加字段时记得往这里加** ——
#: 漏一个的代价是一把令牌或一个 Wi-Fi 密码躺在 journalctl 里。
SECRET_KEYS = ("psk", "password", "token", "relay_token", "session", "session_token")


def redact(value):
    """给日志用的那道闸。dict / list 递归,秘密字段换成 `***`。"""
    if isinstance(value, dict):
        return {k: ("***" if k in SECRET_KEYS and v else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


# ———————————————————————— nmcli:输出解析 ————————————————————————
#
# 全部走 `-t`(terse):字段用 `:` 分隔、字段里的 `:` 与 `\` 用反斜杠转义。
# **不用人类那份表格** —— 它的列宽随内容变,SSID 里有空格时切不开。

def _split_terse(line: str) -> list:
    """按 nmcli 的 terse 规矩切一行(`\\:` 是内容里的冒号,`\\\\` 是一个反斜杠)。"""
    fields, current, escaped = [], [], False
    for ch in line:
        if escaped:
            current.append(ch)
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == ":":
            fields.append("".join(current))
            current = []
        else:
            current.append(ch)
    fields.append("".join(current))
    return fields


def parse_wifi_list(stdout: str, saved: tuple = ()) -> list:
    """`nmcli -t -f SSID,SIGNAL,SECURITY,IN-USE dev wifi list` → 列表。

    做了四件事,每一件都有代价:

    1. **丢掉没有名字的**(隐藏网)。它们在列表里是一行空白,点了也连不上 —— 要连隐藏网
       得手打名字,那是这一版没做的(文档「没做的」第 4 条)。
    2. **同名只留信号最强的那一个**。一个网常有 2.4G/5G 两个 AP 同名,列两行只会让人犹豫。
    3. **按信号从强到弱排**,当前连着的那个排最前。
    4. `saved` 里有的标上 `saved: True` —— 界面据此可以说「这个以前连过,不用再输密码」。
    """
    best = {}
    for line in stdout.splitlines():
        line = line.strip()
        if line == "":
            continue
        fields = _split_terse(line)
        if len(fields) < 3:
            continue
        ssid = fields[0].strip()
        if ssid == "":
            continue
        try:
            signal = int(fields[1] or 0)
        except ValueError:
            signal = 0
        security = (fields[2] or "").strip()
        in_use = len(fields) > 3 and fields[3].strip() == "*"
        old = best.get(ssid)
        best[ssid] = {
            "ssid": ssid,
            # 同名两行取信号强的那一个;`in_use` 与 `saved` 只要有一行是就是
            # (它们回答的是「这个网」怎么样,不是「这个 AP」怎么样)。
            "signal": max(max(0, min(100, signal)), (old or {}).get("signal", 0)),
            # 空 = 开放网。界面上那句「这个网不要密码」就认它。
            "security": security or (old or {}).get("security", ""),
            "in_use": in_use or (old or {}).get("in_use", False),
            "saved": ssid in saved,
        }
    return sorted(best.values(), key=lambda n: (not n["in_use"], -n["signal"], n["ssid"]))


def parse_saved(stdout: str) -> tuple:
    """`nmcli -t -f NAME,TYPE connection show` → 存过的 Wi-Fi 名。

    连接名**通常**等于 SSID(nmcli 建的时候就是这么起的),但不保证 ——
    所以这只是个"以前连过"的提示,连不连得上还是要试。
    """
    names = []
    for line in stdout.splitlines():
        fields = _split_terse(line.strip())
        if len(fields) >= 2 and fields[1].strip() in ("802-11-wireless", "wifi") and fields[0] != "":
            names.append(fields[0])
    return tuple(names)


def parse_device_state(stdout: str, iface: str = "wlan0") -> dict:
    """`nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev status` → 这块网卡怎么样了。

    回 `{"present":…, "online":…, "ssid":…}`。**网卡压根不在**和**在但没连上**是两件事:
    前者是"这台机器的 Wi-Fi 被关了"(要人去开),后者是"等着配"。
    """
    for line in stdout.splitlines():
        fields = _split_terse(line.strip())
        if len(fields) >= 4 and fields[0] == iface:
            state = fields[2].strip()
            connection = fields[3].strip()
            online = state.startswith("connected") or state == "已连接"
            return {"present": True, "online": online,
                    "ssid": connection if online and connection != "--" else ""}
    return {"present": False, "online": False, "ssid": ""}


def parse_ip(stdout: str, iface: str = "wlan0") -> str:
    """`ip -4 -br addr` → wlan0 的地址(只取第一个,不带掩码)。没有就空串。"""
    for line in stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[0] == iface:
            return parts[2].split("/")[0]
    return ""


# ———————————————————————— nmcli:命令与结果 ————————————————————————

def scan_command(iface: str = "wlan0") -> list:
    return ["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY,IN-USE", "dev", "wifi", "list",
            "ifname", iface, "--rescan", "yes"]


def saved_command() -> list:
    return ["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"]


def status_command() -> list:
    return ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "dev", "status"]


def connect_plan(ssid: str, psk: str, iface: str = "wlan0",
                 timeout: int = CONNECT_TIMEOUT_SEC) -> tuple:
    """(argv, 要喂进 stdin 的东西 / None)。

    **密码不进 argv**:`nmcli dev wifi connect X password Y` 会把 Y 摆在 `ps` 的输出里,
    而派上不止一个进程。`--ask` 让 nmcli 问,答案从 stdin 递进去 —— 同一份密码,
    少一处泄漏面,而且 `journalctl` 里那条 `Starting …` 也带不出它。

    开放网(没给密码)**不带 `--ask`**:带了它会一直等那个永远不来的回答,
    表现是"连一个不要密码的网反而卡住",最难猜的那一类。
    """
    if psk == "":
        return ["nmcli", f"--wait={int(timeout)}", "dev", "wifi", "connect", ssid,
                "ifname", iface], None
    return ["nmcli", "--ask", f"--wait={int(timeout)}", "dev", "wifi", "connect", ssid,
            "ifname", iface], psk + "\n"


def classify_connect(returncode: int, output: str) -> tuple:
    """nmcli 说了什么 → (成没成, 机器码, nmcli 那句原话)。

    机器码只有四种,对着 `FAIL_TEXT`。认不得的一律 `failed` 并**把 nmcli 那句原样带上** ——
    编一个好听的说法,人照着它什么也修不好。

    这些字符串是 nmcli 的英文输出。派上 `LC_ALL` 由 unit 钉成 C(见 wb-provision.service),
    否则中文 locale 下这里一条都匹配不上,全变成 `failed`。
    """
    text = (output or "").strip()
    low = text.lower()
    if returncode == 0 and "successfully activated" in low:
        return True, "", text
    if "secrets were required" in low or "invalid password" in low or "802.1x supplicant" in low:
        return False, "bad_password", text
    if "no network with ssid" in low or "not found" in low:
        return False, "not_found", text
    if "timeout" in low or "timed out" in low:
        return False, "timeout", text
    if "no wi-fi device found" in low or "no such device" in low:
        return False, "no_wifi", text
    if returncode == 0:
        # 回了 0 但没说 activated:当成成了太冒险(NM 有过"排上队了"就回 0 的行为),
        # 交给下一轮 wifi 事件去确认。这里报超时,人重试一次就好。
        return False, "timeout", text
    return False, "failed", text


# ———————————————————————— 名字 ————————————————————————

def name_suffix(machine_id: str) -> str:
    """machine-id → 四位后缀(大写十六进制)。

    取**末尾**四位而不是开头:systemd 的 machine-id 是一串随机十六进制,两头都行,
    但末尾那几位在同一批烧出来的卡上更不容易撞(开头那几位偶尔带镜像的痕迹)。
    读不出 machine-id 时回 `0000` —— 两台都叫 0000 总好过服务起不来。
    """
    cleaned = "".join(ch for ch in (machine_id or "") if ch in "0123456789abcdefABCDEF")
    return (cleaned[-4:] or "0000").upper()


def device_name(machine_id: str) -> str:
    return f"{NAME_PREFIX}{name_suffix(machine_id)}"


def device_id_of(machine_id: str) -> str:
    """这台派在账号里的 id。

    **从 machine-id 推,不新生成一个**:新生成的那个要落盘,而落盘的文件会被
    重烧卡、被 `deploy.sh` 覆盖、被手一抖删掉,于是同一台派在账号的「我的设备」里
    变成好几台。machine-id 是系统装出来那一刻定的,重装才会变 —— 那本来也该算新设备。

    形状对齐 `phoneIdentityOf` 认得的字符集(A-Za-z0-9_-)。
    """
    cleaned = "".join(ch for ch in (machine_id or "") if ch in "0123456789abcdefABCDEF").lower()
    return f"handset-{cleaned[:16]}" if cleaned else "handset-0000000000000000"


# ———————————————————————— 交令牌 ————————————————————————

#: `link` 那一条里必须有的两样。少一样就不动 device.json ——
#: 写半份进去的后果是 phone-bridge 下次开机拿着半把钥匙一直重试。
LINK_REQUIRED = ("relay", "token")

#: 重新接入时必须**从 device.json 里删掉**的几样(2026-09-30 止血,根子 2)。
#:
#: `save_device` 是合并写,于是「把这台座机重新添加一遍(很可能是添加到另一个账号)」
#: 之后,上一个账号留下的东西全都还在:
#:   ticket          上一把钥匙签出来的进房票,**7 天有效** —— `acquire_ticket` 先看它,
#:                   还没到期就直接用,于是座机换了账号照样进旧账号的房(这就是真机上看到的那个)。
#:                   2026-10-03 起那一步会**先问一次工作台现在该进哪个房**(卡 B),但那一问
#:                   走的是旧那台 Mac 的地址 —— 这里照旧要清,两道闸各管一件事
#:   token           局域网那把设备令牌(旧那台 Mac 的 8791 发的)。局域网那条路排在中转前面,
#:                   不清掉就是「新钥匙在兜里,门还是用旧钥匙开」
#:   workbench_http  旧那台 Mac 的地址。留着只会让上面那条路真的走得通
#:   identity / room 上一次在旧账号房里的身份与房号(缓存,拼得出来,不该沿用)
#:   relay_base      `--relay-login` 那条老路写下的中转地址。这一次写的是 `relay`,
#:                   两个键指着两个地方是 09-28 那种死锁的温床
#:
#: **留下**的:`device_id`(机器码算出来的,这台派在账号里的身份;换掉等于每次重新添加
#: 都多一台占名额的僵尸设备,见设计文档根子 2 里手机那一条)、`name`(显示名)、
#: `relay`(这一次 patch 会覆盖成新的)、Wi-Fi(不在这份文件里,在 NetworkManager 的
#: keyfile 里 —— 清掉它座机就掉网,那才是真的回不来)。
LINK_STALE = ("ticket", "token", "workbench_http", "identity", "room", "relay_base")


def relinked_state(old: dict, patch: dict) -> dict:
    """重新接入之后 device.json 该长什么样:先摘掉 `LINK_STALE`,再合进这一次的 patch。

    **一次写完**(调用方那一边是一次原子写):不能先清一遍再写一遍 ——
    中间掉电就剩一台既没有旧钥匙也没有新钥匙的座机。
    """
    kept = {k: v for k, v in (old or {}).items() if k not in LINK_STALE}
    kept.update(patch)
    return kept


def link_patch(command: dict, device_id: str) -> Optional[dict]:
    """`link` 命令 → 要合进 device.json 的那几个字段。**缺字段回 None**。

    合进去的是:
      relay_token   中转那把设备令牌(`wb_…`)
      relay         中转地址(`https://api.aibooo.cn`)
      device_id     这台派在账号里的 id(手机拿它去 `/register-device` 登记的那个)
      platform/name 显示用,沿用 pairing.py 里的那两个常量
    **不写 workbench_http**:那是局域网那条路的事,这条流程里手机不一定知道 Mac 在哪。
    """
    if not isinstance(command, dict):
        return None
    if any(not isinstance(command.get(key), str) or command.get(key) == "" for key in LINK_REQUIRED):
        return None
    patch = {
        "relay_token": command["token"],
        "relay": command["relay"].rstrip("/"),
        "device_id": str(command.get("device_id") or device_id),
    }
    name = command.get("name")
    if isinstance(name, str) and name != "":
        patch["name"] = name
    return patch


def restart_bridge_command(user: str = "ben", uid: int = 1000) -> list:
    """root 怎么重启 ben 那个用户级服务。

    `systemctl --user` 认的是**调用者自己的**用户总线,root 直接跑会去找 root 的那一个
    (不存在)。`runuser` + `XDG_RUNTIME_DIR` 是不引入 machinectl 的最短写法;
    前提是那个用户开着 linger(派上早就开了,见硬件文档 2026-08-24 那一节)。
    """
    return ["runuser", "-u", user, "--", "env", f"XDG_RUNTIME_DIR=/run/user/{int(uid)}",
            "systemctl", "--user", "restart", "phone-bridge"]
