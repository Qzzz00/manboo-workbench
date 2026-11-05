#!/usr/bin/env python3
"""座机配网守护进程(2026-09-22)。**这一份是那些脏活**:bluez 的 D-Bus、nmcli 的子进程、
device.json 的落盘。逻辑全在 `provision.py`,那一份有 42 条单测;这一份**没有单测**,
手工验证步骤写在 `docs/交接-0922-座机配网走App.md` 第六节。

跑法(system 级 systemd,root):

    /usr/bin/python3 /home/ben/phone-bridge/provisiond.py

用得上的两个开关:

    --check     只自检(bluez / D-Bus / nmcli / machine-id 各样有没有),打完就退。
                **装完先跑这个**,它是"蓝牙到底能不能用"唯一的答案。
    --once      不进主循环,只把当前状态打一行出来(排查用)。

## 它还是 root 那半边的「换网代办」(2026-09-22 晚)

派**已经在线**的时候换网走的是房间那条路(手机 → LiveKit → `room_link.py`),
而那一半跑在用户 `ben` 下,`nmcli` 改系统连接它做不了。于是这一份多开一条
Unix socket(`netcfg.SOCKET_PATH`,0660,属主 root、属组 ben):
一条请求一行 JSON、一条应答一行 JSON、然后关。协议与校验在 `netcfg.py`(有单测)。

**蓝牙那一半起不来也要开这条 socket**:没有蓝牙的板子照样能用房间那条路换网。

## 为什么 import 都包着 try

`provision.py` 那一份要能在 Mac 上 `python3 -m unittest`;这一份在 Mac 上压根跑不起来
(没有 dbus、没有 gi)。把 import 摊在文件顶上会让 `unittest discover` 第一行就炸,
于是**整个 phone-bridge 的用例都跑不了** —— 那是 2026-09-21 room_link.py 踩过的同一个坑
(它的解法是把 `import livekit` 挪进函数里)。这里用同一条路子。

## 权限

这一份跑在 **root** 下:bluez 注册 GATT 应用与广播、nmcli 改系统连接、
往 `/etc/NetworkManager/system-connections/` 写 keyfile —— 三件都要。
理由写全在 `provision.py` 的文件头。
"""
import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time

import netcfg
import provision
from provision import (
    CHAR_COMMAND, CHAR_NETWORKS, CHAR_STATUS, SERVICE_UUID,
    FrameAssembler, Provision,
)

BLUEZ = "org.bluez"
ADAPTER_IFACE = "org.bluez.Adapter1"
GATT_MANAGER = "org.bluez.GattManager1"
AD_MANAGER = "org.bluez.LEAdvertisingManager1"
DBUS_OM = "org.freedesktop.DBus.ObjectManager"
DBUS_PROPS = "org.freedesktop.DBus.Properties"

APP_PATH = "/ai/ben/workbench/provision"
IFACE = os.environ.get("WB_WIFI_IFACE", "wlan0")
BRIDGE_USER = os.environ.get("WB_BRIDGE_USER", "ben")
BRIDGE_UID = int(os.environ.get("WB_BRIDGE_UID", "1000") or 1000)
STATE_FILE = os.environ.get("WB_DEVICE_FILE",
                            f"/home/{BRIDGE_USER}/phone-bridge/device.json")

#: 多久问一次 NM「现在连着没有」。2 秒不算勤快:这上面还挂着界面上那根进度条。
POLL_SEC = 2
#: nmcli 一次最多跑多久(比 CONNECT_TIMEOUT_SEC 多留 10 秒给它自己收场)。
RUN_TIMEOUT_SEC = provision.CONNECT_TIMEOUT_SEC + 10


def log(line: str) -> None:
    print(line, flush=True)


def machine_id() -> str:
    for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return handle.read().strip()
        except OSError:
            continue
    return ""


# ———————————————————————— nmcli ————————————————————————

def run_nmcli(argv: list, stdin_text=None, timeout: int = RUN_TIMEOUT_SEC) -> tuple:
    """(returncode, stdout+stderr)。**不抛** —— nmcli 不在、卡住了都是常态。

    `LC_ALL=C`:`classify_connect` 认的是英文那几句。中文 locale 下它一条都匹配不上,
    于是所有失败都变成「没连上」,连密码错都分不出来。
    """
    env = {**os.environ, "LC_ALL": "C", "LANG": "C"}
    try:
        done = subprocess.run(argv, input=stdin_text, env=env, timeout=timeout,
                              capture_output=True, text=True)
    except FileNotFoundError:
        return 127, "nmcli not found"
    except subprocess.TimeoutExpired:
        return 124, "Timeout expired"
    except OSError as err:
        return 1, str(err)
    return done.returncode, f"{done.stdout}\n{done.stderr}".strip()


def wifi_now() -> dict:
    """问一次 NM:连着没有、连的哪个、地址多少。"""
    _, status = run_nmcli(provision.status_command(), timeout=10)
    state = provision.parse_device_state(status, IFACE)
    ip = ""
    if state["online"]:
        code, out = run_nmcli(["ip", "-4", "-br", "addr"], timeout=10)
        if code == 0:
            ip = provision.parse_ip(out, IFACE)
    return {"online": state["online"], "ssid": state["ssid"], "ip": ip,
            "present": state["present"]}


def scan_now() -> list:
    """扫一遍。`--rescan yes` 在 Zero 2W 上要几秒,所以这一趟在工作线程里跑。"""
    code, out = run_nmcli(provision.scan_command(IFACE), timeout=40)
    if code != 0:
        log(f"[wifi] 扫不动:{out.splitlines()[:1]}")
        return []
    _, saved_out = run_nmcli(provision.saved_command(), timeout=10)
    return provision.parse_wifi_list(out, provision.parse_saved(saved_out))


def connect_now(ssid: str, psk: str) -> dict:
    argv, stdin_text = provision.connect_plan(ssid, psk, IFACE)
    code, out = run_nmcli(argv, stdin_text)
    ok, reason, said = provision.classify_connect(code, out)
    # **这一行是唯一会打出 nmcli 原话的地方**,而那句原话里没有密码
    # (密码走的是 stdin,不在 argv、不在回显里)。
    log(f"[wifi] 连 {ssid}:{'成了' if ok else reason} · {said.splitlines()[-1] if said else ''}")
    return {"ok": ok, "code": reason, "text": said, "ssid": ssid}


# ———————————————————————— device.json ————————————————————————

def load_device() -> dict:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_device(patch: dict, clear: tuple = ()) -> None:
    """把几个字段合进 device.json。**原子写 + 0600 + 属主还给 ben** ——
    这份文件平时是 ben 写的(pairing.save_state),root 写完不改属主,
    下次 `--pair` 会 Permission denied,而那时人早就忘了这里动过手。

    `clear` 是**这一次要删掉**的键(2026-09-30):合并写在「重新接入」那一下是错的,
    旧账号的票与令牌会活下来。删与写在同一次读-改-写里完成,落盘还是那一次 rename,
    所以不会出现「清了一半」的 device.json。规矩与理由在 `provision.LINK_STALE`。
    """
    state = {k: v for k, v in load_device().items() if k not in clear}
    state.update(patch)
    os.makedirs(os.path.dirname(STATE_FILE) or ".", exist_ok=True)
    tmp = f"{STATE_FILE}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.chmod(tmp, 0o600)
    try:
        import pwd
        who = pwd.getpwnam(BRIDGE_USER)
        os.chown(tmp, who.pw_uid, who.pw_gid)
    except (ImportError, KeyError, OSError, PermissionError):
        pass  # 不是致命的:文件还是 0600,只是属主是 root
    os.replace(tmp, STATE_FILE)


def link_now(command: dict, device_id: str) -> dict:
    patch = provision.link_patch(command, device_id)
    if patch is None:
        return {"ok": False, "text": "手机交过来的那份不全(缺地址或令牌),没动座机上的设置"}
    try:
        # **清旧再写新**:这一条 link 很可能是「换个账号重新添加一遍」,
        # 旧账号的进房票 / 局域网令牌留着就会被 `acquire_ticket` 优先用上(根子 2)。
        save_device(patch, clear=provision.LINK_STALE)
    except OSError as err:
        return {"ok": False, "text": f"存不下来({err.strerror or err})"}
    # **这一行不打令牌**(redact 过)。
    log(f"[link] 记下了:{provision.redact(patch)}")
    code, out = run_nmcli(provision.restart_bridge_command(BRIDGE_USER, BRIDGE_UID), timeout=30)
    if code != 0:
        return {"ok": False, "text": f"令牌记下了,但座机的通话服务没重启成:{out.splitlines()[:1]}"}
    return {"ok": True, "text": ""}


# ———————————————————————— 换网代办(Unix socket,2026-09-22 晚) ————————————————————————

def current_wifi() -> dict:
    """这会儿连的是哪条连接(**名字**)、哪个网(SSID)、什么地址。

    名字与 SSID 是两件事:回滚走 `nmcli connection up <名字>`,而 netplan 生成的
    那几条叫 `netplan-wlan0-Ben`(见 netcfg.parse_active_wifi 的注释)。
    """
    _, active = run_nmcli(netcfg.active_command(), timeout=10)
    now = wifi_now()
    return {"ok": True, "name": netcfg.parse_active_wifi(active, IFACE),
            "ssid": now.get("ssid", ""), "ip": now.get("ip", ""),
            "online": now.get("online", False)}


#: 进房那一半报来的「在不在房里」,主循环每秒取一次喂给状态机(状态机只在主循环里跑,见 pump)。
ROOM_REPORTS: "queue.Queue[bool]" = queue.Queue()


def handle_ipc(request: dict) -> dict:
    """一条请求 → 一条应答。**这一份不认识 socket** —— 上面那几个函数怎么跑的,
    与它是从蓝牙来的还是从房间来的无关。"""
    if not netcfg.valid_ipc(request):
        return {"ok": False, "code": "bad_request", "text": "读不懂这条请求"}
    op = request["op"]
    if op == netcfg.IPC_ROOM:
        ROOM_REPORTS.put(bool(request["in_room"]))
        return {"ok": True}
    if op == netcfg.IPC_CURRENT:
        return current_wifi()
    if op == netcfg.IPC_SCAN:
        nets = scan_now()
        if not nets:
            return {"ok": False, "code": "scan_failed", "text": "座机扫不到任何 Wi-Fi(无线网卡可能被关掉了)"}
        return {"ok": True, "networks": nets}
    if op == netcfg.IPC_SWITCH:
        done = connect_now(request["ssid"], str(request.get("psk") or ""))
        return {"ok": done["ok"], "code": done["code"],
                "text": provision.fail_text(done["code"], done["text"]) if not done["ok"] else "",
                "ssid": done["ssid"]}
    # rollback
    code, out = run_nmcli(netcfg.rollback_plan(request["name"], IFACE), timeout=60)
    log(f"[netcfg] 切回 {request['name']}:{'成了' if code == 0 else out.splitlines()[:1]}")
    return {"ok": code == 0, "text": "" if code == 0 else out[:200]}


def serve_ipc() -> None:
    """一根线程,一次伺候一个连接。

    **故意不并发**:一趟换网前后一共三四次来回,而两条 `nmcli connect` 同时跑
    会互相把对方的连接踢掉。排队是这里最省事也最对的做法。
    """
    path = netcfg.SOCKET_PATH
    try:
        os.makedirs(os.path.dirname(path) or "/", exist_ok=True)
        if os.path.exists(path):
            os.unlink(path)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(path)
        # 0660 + 属组 ben:只有 root 和跑 phone-bridge 的那个用户写得进来。
        # 0666 的话同一台机器上任何进程都能让它换网。
        os.chmod(path, 0o660)
        try:
            import pwd
            who = pwd.getpwnam(BRIDGE_USER)
            os.chown(path, 0, who.pw_gid)
        except (ImportError, KeyError, OSError):
            log(f"[netcfg] 改不了 {path} 的属组,{BRIDGE_USER} 可能连不上这条 socket")
        server.listen(4)
    except OSError as err:
        log(f"[netcfg] 换网这条 socket 开不起来({err}) —— 房间那条路换不了网,蓝牙那条不受影响")
        return
    log(f"[netcfg] 换网代办在听 {path}")
    while True:
        try:
            conn, _ = server.accept()
        except OSError as err:
            log(f"[netcfg] accept 出错({err})")
            continue
        try:
            conn.settimeout(netcfg.VERIFY_SEC + 30)
            raw = b""
            while b"\n" not in raw and len(raw) < netcfg.IPC_LIMIT:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                raw += chunk
            request = netcfg.decode_ipc(raw)
            if request.get("op") != netcfg.IPC_ROOM:  # 每 20 秒一条,不进日志
                log(f"[netcfg] ← {provision.redact(request)}")
            conn.sendall(netcfg.encode_ipc(handle_ipc(request)))
        except Exception as err:  # noqa: BLE001 —— 一条坏请求不该把这根线程带走
            log(f"[netcfg] 这一条没办成({err})")
            try:
                conn.sendall(netcfg.encode_ipc({"ok": False, "text": str(err)[:120]}))
            except OSError:
                pass
        finally:
            try:
                conn.close()
            except OSError:
                pass


# ———————————————————————— BLE(bluez 的 D-Bus) ————————————————————————

def _dbus():
    """懒加载 dbus/gi。装不上时回 (None, None, 一句人话)。"""
    try:
        import dbus
        import dbus.mainloop.glib
        import dbus.service
        from gi.repository import GLib
    except ImportError as err:
        return None, None, f"缺 python3-dbus / python3-gi:{err}"
    return dbus, GLib, ""


def build_ble(dbus, on_command):
    """搭出 GATT 应用 + 广播那一套。回一个有 `notify_status` / `notify_networks` /
    `advertise(on)` 三个方法的东西。

    **为什么不用现成的 `bless` / `pygatt`**:它们要 pip,而派上 pip 装不了带编译的包
    (2026-09-22 真机:lgpio 就是这么栽的)。bluez 的 D-Bus 接口是系统自带的,
    `python3-dbus` 与 `python3-gi` 都是 apt 里的二进制包 —— 一棵树都不用编。
    """
    import dbus.service

    class Characteristic(dbus.service.Object):
        def __init__(self, bus, index, uuid, flags, service):
            self.path = f"{service.path}/char{index}"
            self.uuid, self.flags, self.service = uuid, flags, service
            self.notifying = False
            self.value = []
            dbus.service.Object.__init__(self, bus, self.path)

        def props(self):
            return {
                # 必须是 ObjectPath:传成普通字符串,bluez 认不出这个特征属于哪个服务,
                # 整个应用注册被拒「No valid service object found」(2026-09-27 真机日志)。
                "Service": dbus.ObjectPath(self.service.path), "UUID": self.uuid,
                "Flags": self.flags, "Value": dbus.Array(self.value, signature="y"),
            }

        @dbus.service.method(DBUS_PROPS, in_signature="s", out_signature="a{sv}")
        def GetAll(self, interface):
            if interface != "org.bluez.GattCharacteristic1":
                raise dbus.exceptions.DBusException("org.bluez.Error.InvalidArguments")
            return self.props()

        @dbus.service.signal(DBUS_PROPS, signature="sa{sv}as")
        def PropertiesChanged(self, interface, changed, invalidated):
            pass

        @dbus.service.method("org.bluez.GattCharacteristic1", in_signature="a{sv}", out_signature="ay")
        def ReadValue(self, options):
            # 读一次只回**第一帧**。手机那边正常走 notify,`read` 只是排查时用
            # (nRF Connect 之类)。这里不为它再实现一套分片读。
            return dbus.Array(self.value, signature="y")

        @dbus.service.method("org.bluez.GattCharacteristic1", in_signature="aya{sv}")
        def WriteValue(self, value, options):
            on_command(bytes(bytearray(value)))

        @dbus.service.method("org.bluez.GattCharacteristic1")
        def StartNotify(self):
            self.notifying = True

        @dbus.service.method("org.bluez.GattCharacteristic1")
        def StopNotify(self):
            self.notifying = False

        def push(self, frames):
            """把若干帧逐帧 notify 出去。**没人在听就不发** —— PropertiesChanged
            在没有订阅者时是白发,而它会把 D-Bus 刷满。"""
            if not self.notifying:
                return
            for frame in frames:
                self.value = list(frame)
                self.PropertiesChanged("org.bluez.GattCharacteristic1",
                                       {"Value": dbus.Array(self.value, signature="y")}, [])

    class Service(dbus.service.Object):
        def __init__(self, bus, index, uuid):
            self.path = f"{APP_PATH}/service{index}"
            self.uuid = uuid
            self.chars = []
            dbus.service.Object.__init__(self, bus, self.path)

        def props(self):
            return {"UUID": self.uuid, "Primary": True,
                    "Characteristics": dbus.Array([c.path for c in self.chars], signature="o")}

        @dbus.service.method(DBUS_PROPS, in_signature="s", out_signature="a{sv}")
        def GetAll(self, interface):
            return self.props()

    class Application(dbus.service.Object):
        def __init__(self, bus):
            self.path = APP_PATH
            dbus.service.Object.__init__(self, bus, self.path)
            self.service = Service(bus, 0, SERVICE_UUID)
            self.status = Characteristic(bus, 0, CHAR_STATUS, ["read", "notify"], self.service)
            self.networks = Characteristic(bus, 1, CHAR_NETWORKS, ["read", "notify"], self.service)
            self.command = Characteristic(bus, 2, CHAR_COMMAND, ["write", "write-without-response"], self.service)
            self.service.chars = [self.status, self.networks, self.command]

        @dbus.service.method(DBUS_OM, out_signature="a{oa{sa{sv}}}")
        def GetManagedObjects(self):
            out = {dbus.ObjectPath(self.service.path): {"org.bluez.GattService1": self.service.props()}}
            for char in self.service.chars:
                out[dbus.ObjectPath(char.path)] = {"org.bluez.GattCharacteristic1": char.props()}
            return out

    class Advertisement(dbus.service.Object):
        def __init__(self, bus, name):
            self.path = f"{APP_PATH}/adv0"
            self.name = name
            dbus.service.Object.__init__(self, bus, self.path)

        @dbus.service.method(DBUS_PROPS, in_signature="s", out_signature="a{sv}")
        def GetAll(self, interface):
            # ServiceUUIDs 进广播包,LocalName 由 bluez 挪进扫描响应包
            # (「工作台座机-XXXX」是 20 个字节,和一个 128 位 UUID 挤不进同一个 31 字节包)。
            # 手机那边**按 UUID 找设备、按名字显示**,正是为了这一条。
            return {
                "Type": "peripheral",
                "ServiceUUIDs": dbus.Array([SERVICE_UUID], signature="s"),
                "LocalName": dbus.String(self.name),
                "Includes": dbus.Array([], signature="s"),
            }

        @dbus.service.method("org.bluez.LEAdvertisement1")
        def Release(self):
            pass

    return Application, Advertisement


class Ble:
    """广播开关 + 两条 notify。bluez 不在时**整个退化成什么都不做** ——
    那时配网走不了,但 phone-bridge 那一半照常跑,不该被拖死。"""

    def __init__(self, name: str):
        self.name = name
        self.ok = False
        self.note = ""
        self._app = None
        self._adv = None
        self._adv_on = False
        self._mtu = 23
        self.inbox = queue.Queue()

    def start(self, dbus, GLib):
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        bus = dbus.SystemBus()
        adapter = self._find_adapter(dbus, bus)
        if adapter is None:
            self.note = "这台机器上找不到蓝牙适配器(hci0)"
            return False
        Application, Advertisement = build_ble(dbus, self._on_command)
        self._bus, self._dbus, self._adapter = bus, dbus, adapter
        self._app = Application(bus)
        self._adv = Advertisement(bus, self.name)
        manager = dbus.Interface(bus.get_object(BLUEZ, adapter), GATT_MANAGER)
        manager.RegisterApplication(self._app.path, {},
                                    reply_handler=lambda: log("[ble] GATT 服务注册上了"),
                                    error_handler=lambda e: log(f"[ble] GATT 注册失败:{e}"))
        # 适配器本身要是 Powered 的,否则广播注册会直接被拒。
        try:
            props = dbus.Interface(bus.get_object(BLUEZ, adapter), DBUS_PROPS)
            props.Set(ADAPTER_IFACE, "Powered", dbus.Boolean(True))
        except Exception as err:  # noqa: BLE001
            log(f"[ble] 打不开蓝牙({err}),下面多半也不行")
        self.ok = True
        return True

    def _find_adapter(self, dbus, bus):
        try:
            om = dbus.Interface(bus.get_object(BLUEZ, "/"), DBUS_OM)
            objects = om.GetManagedObjects()
        except Exception as err:  # noqa: BLE001
            self.note = f"连不上 bluez({err})"
            return None
        for path, ifaces in objects.items():
            if ADAPTER_IFACE in ifaces and GATT_MANAGER in ifaces:
                return path
        return None

    def _on_command(self, raw: bytes) -> None:
        self.inbox.put(raw)

    def advertise(self, on: bool) -> None:
        if not self.ok or on == self._adv_on:
            return
        manager = self._dbus.Interface(self._bus.get_object(BLUEZ, self._adapter), AD_MANAGER)
        if on:
            manager.RegisterAdvertisement(
                self._adv.path, {},
                reply_handler=lambda: log(f"[ble] 开始广播「{self.name}」"),
                error_handler=lambda e: log(f"[ble] 广播注册失败:{e}"))
        else:
            try:
                manager.UnregisterAdvertisement(self._adv.path)
                log("[ble] 停了广播")
            except Exception as err:  # noqa: BLE001
                log(f"[ble] 停广播失败:{err}")
        self._adv_on = on

    def notify_status(self, payload: dict) -> None:
        if self.ok:
            self._app.status.push(provision.encode_frames(payload, self._mtu))

    def notify_networks(self, networks: list) -> None:
        if self.ok:
            self._app.networks.push(provision.encode_frames({"networks": networks}, self._mtu))


# ———————————————————————— 主循环 ————————————————————————

class Worker:
    """慢活(nmcli / 落盘)扔到一根线程上跑,结果从队列里回来。

    **不能在 GLib 主循环里直接跑 nmcli**:一次 connect 要 45 秒,那 45 秒里
    D-Bus 不回话 = 手机那头的 GATT 全部超时,表现是「连一半 App 说座机没反应」。
    """

    def __init__(self):
        self.jobs = queue.Queue()
        self.results = queue.Queue()
        threading.Thread(target=self._loop, daemon=True).start()

    def submit(self, kind, fn):
        self.jobs.put((kind, fn))

    def _loop(self):
        while True:
            kind, fn = self.jobs.get()
            try:
                self.results.put((kind, fn()))
            except Exception as err:  # noqa: BLE001
                self.results.put((kind, {"ok": False, "text": str(err)}))


def selfcheck() -> int:
    """`--check`:逐样报,**不猜**。照 deploy.sh 第 4 步那个路子。"""
    def say(name, ok, extra=""):
        print(f"  {'有' if ok else '没有'}  {name}{(' · ' + extra) if extra else ''}")

    dbus, GLib, note = _dbus()
    say("python3-dbus / python3-gi", dbus is not None, note)
    mid = machine_id()
    say("machine-id", mid != "", provision.device_name(mid))
    code, out = run_nmcli(["nmcli", "--version"], timeout=10)
    say("nmcli", code == 0, out.splitlines()[0] if out else "")
    state = provision.parse_device_state(run_nmcli(provision.status_command(), timeout=10)[1], IFACE)
    say(f"无线网卡 {IFACE}", state["present"],
        ("连着 " + state["ssid"]) if state["online"] else "没连上")
    if dbus is not None:
        ble = Ble(provision.device_name(mid))
        found = False
        try:
            dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
            found = ble._find_adapter(dbus, dbus.SystemBus()) is not None
        except Exception as err:  # noqa: BLE001
            ble.note = str(err)
        say("蓝牙适配器 hci0", found, ble.note)
    return 0


def main() -> int:
    argv = sys.argv[1:]
    if "--check" in argv:
        return selfcheck()

    mid = machine_id()
    name = provision.device_name(mid)
    device = load_device()
    device_id = str(device.get("device_id") or provision.device_id_of(mid))
    log(f"[boot] 座机配网服务:{name} · 设备 {device_id} · 网卡 {IFACE}")

    if "--once" in argv:
        log(f"[once] {wifi_now()}")
        return 0

    # 换网代办**先开**,而且蓝牙起不起得来都开:派已经在线的时候换网走的是房间那条路
    # (手机 → LiveKit → room_link.py → 这条 socket),一个蓝牙字节都不用。
    threading.Thread(target=serve_ipc, daemon=True).start()

    dbus, GLib, note = _dbus()
    ble = None
    if dbus is None:
        log(f"[boot] {note} —— **蓝牙那条配网路走不了**。装:sudo apt install python3-dbus python3-gi")
    else:
        ble = Ble(name)
        if not ble.start(dbus, GLib):
            log(f"[boot] 蓝牙起不来:{ble.note} —— **蓝牙那条配网路走不了**")
            ble = None

    if ble is None:
        # **不退出**:房间那条换网路还在,而 unit 是 Restart=always ——
        # 退出只会让它每 5 秒重启一次,顺带把那条 socket 也带走。
        log("[boot] 只开换网代办(房间那条路)。座机没网时的第一次配网要蓝牙,现在用不了。")
        while True:
            time.sleep(3600)

    worker = Worker()
    box = FrameAssembler()
    # 没有中转令牌 = 没绑账号:有网也广播,等手机「添加座机」(2026-09-27)。
    state = Provision(since=int(time.time()), unbound=not bool(load_device().get("relay_token")))
    #: 同一种活一次只派一件。少了它,手机连点两下「重新找」就会有两个 nmcli 在扫。
    busy = {"scan": False, "connect": False, "link": False, "wifi": False}

    def apply(actions):
        nonlocal state
        for action in actions:
            if action[0] == "advertise":
                ble.advertise(bool(action[1]))
            elif action[0] == "notify_status":
                ble.notify_status(provision.status_payload(state, device_id, name))
            elif action[0] == "notify_networks":
                ble.notify_networks(action[1])
            elif action[0] == "scan" and not busy["scan"]:
                busy["scan"] = True
                worker.submit("scan", scan_now)
            elif action[0] == "connect" and not busy["connect"]:
                busy["connect"] = True
                ssid, psk = action[1], action[2]
                worker.submit("connect", lambda s=ssid, p=psk: connect_now(s, p))
            elif action[0] == "link" and not busy["link"]:
                busy["link"] = True
                command = action[1]
                worker.submit("link", lambda c=command: link_now(c, device_id))

    def feed(event):
        nonlocal state
        before = state.phase
        state, actions = provision.transition(state, event)
        if state.phase != before:
            log(f"[配网] {before} → {state.phase} · {state.text}")
        apply(actions)

    def pump():
        """每秒一趟:BLE 写进来的、工作线程回来的、时钟。**全在主循环里**,
        所以状态机永远是单线程的 —— 它那 42 条用例验的也正是单线程那一份。"""
        now = int(time.time())
        while True:
            try:
                raw = ble.inbox.get_nowait()
            except queue.Empty:
                break
            command = box.feed(raw)
            if command is not None:
                log(f"[ble] 收到 {provision.redact(command)}")
                feed(provision.command_event(now, command))

        while True:
            try:
                kind, result = worker.results.get_nowait()
            except queue.Empty:
                break
            busy[kind] = False
            if kind == "wifi":
                feed(provision.wifi_event(now, result.get("online", False),
                                          result.get("ssid", ""), result.get("ip", "")))
            elif kind == "scan":
                feed(provision.scan_done_event(now, result if isinstance(result, list) else []))
            elif kind == "connect":
                feed(provision.connect_done_event(now, result["ok"], result["code"],
                                                  result["text"], result["ssid"]))
            elif kind == "link":
                feed(provision.link_done_event(now, result["ok"], result.get("text", "")))

        while True:
            try:
                in_room = ROOM_REPORTS.get_nowait()
            except queue.Empty:
                break
            if in_room != state.in_room:
                log(f"[房间] {'进房了' if in_room else '不在房里'}")
            feed(provision.room_event(now, in_room))

        feed(provision.tick_event(now))
        return True

    def poll():
        """NM 的实况。**也扔线程里** —— `nmcli dev status` 在 NM 忙的时候能卡好几秒。
        正在连的时候不问:那一轮的答案以 connect_done 为准(状态机那边也不听)。"""
        if not busy["connect"] and not busy["wifi"]:
            busy["wifi"] = True
            worker.submit("wifi", wifi_now)
        return True

    GLib.timeout_add_seconds(1, pump)
    GLib.timeout_add_seconds(POLL_SEC, poll)
    log("[boot] 起来了。开机先开蓝牙一分钟;连不上网或进不了房就一直开着(2026-09-30)。")
    GLib.MainLoop().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
