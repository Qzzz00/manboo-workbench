"""POP 话筒守护进程(跑在树莓派上)。

2026-09-21 起派是 **LiveKit 房间里的一台设备**(`handset`),不再只是个按键上报器:
工人往房里广播 `ring`,派**不响铃**(铃由手机 App 出,Ben 2026-09-22 晚定),
只进「可提机接听」;拿起听筒 → 发 `call/answer` 并推麦克风音轨;
放回去 → 发 `call/hangup` 并撤掉。通话的嘴和耳朵都在这只听筒上。

**没来电时拿起听筒 = 直接接通事务官**(2026-09-23,提机即拨出):发的是 `call/start`,
工人把接话对象钉到这只听筒上、开口说一句;放下照样是 `call/hangup`。理由见 phone_state.py 文件头。
协议见 `docs/设计-座机信号协议-2026-09-21.md`。

几根线各自独立,汇到一个 asyncio 队列里喂状态机:

  1. **叉簧开关**:GPIO17,压住=在座(挂机位)、松开=拿起。这是主输入。
  2. **HID 按键**:读 /dev/input/eventN 的原始 input_event(stdlib,免 evdev 依赖)。
     POP 唯一那颗键(0xCD)与叉簧**等价**,留作开关没装好时的后备。
  3. **房间**:LiveKit,`wb.rpc` 上的 ring / ring_end。带音频的那条路。
  4. **8791 的 WS**(老路,兜底):房间没配起来、或者凭证领不到时,派**照样能提机接听** ——
     只是没有声音。留着它的理由写在 phone_state.py 顶上。
  5. **时钟**:每秒一个 tick,驱动「可提机接听」那根保险丝。

动作执行(状态机吐什么就做什么,它自己不碰 IO):
  ("rpc", …)   → 往房间发一条
  ("post", …)  → POST {8791}/phone/event(老路)
  ("audio", …) → 推 / 撤麦克风音轨
  ("play", …)  → 一小段提示音

用法:
  python3 popphone.py                      正常跑(systemd 就是这么起的)
  python3 popphone.py ws://主机:8791        临时换工作台地址
  python3 popphone.py --pair 123456        **一次性配对**:拿电脑端「添加设备」生成的
                                           6 位码换一张设备令牌,写进 ~/phone-bridge/device.json
"""
import asyncio
import json
import os
import struct
import sys
import time
import urllib.request

from audio import audio_device, play, prepare_sounds
from pairing import (
    DEFAULT_DEVICE_NAME, acquire_ticket, default_state_file, http_base_of,
    load_state, pair, save_state,
)
from phone_state import (
    PhoneState, button_event, hook_event, ring_event, tick_event, transition,
)

KEY_PLAYPAUSE = 164  # POP 唯一的按键(HID Consumer 0xCD),实测见硬件文档
HOOK_GPIO = 17  # 叉簧微动开关:C→物理针脚9(GND),NO→物理针脚11(GPIO17)。压住=挂机位,松开=拿起。
INPUT_EVENT = struct.Struct("<qqHHi")  # aarch64: sec, usec, type, code, value

DEFAULT_WORKBENCH_WS = "ws://MacBook-Air-1864.local:8791"

#: 向 8791 报到的节拍。**只为了让电脑端「我的设备」看得出派在线** ——
#: 8791 那边 authenticate() 会更新 lastSeenAt(自带 60 秒限频,所以这里再快也没用)。
#: 出了局域网报不到,设置里就会显示离线;这一点如实写在交接里,不粉饰。
HEARTBEAT_SEC = 60


def resolve_workbench_url(argv: list, env: dict) -> str:
    """工作台地址:命令行参数 > 环境变量 WORKBENCH_WS > 默认主机名。

    默认值用 **mDNS 主机名而不是 IP**:热点是 DHCP,Mac 的地址会变;
    写死 IP 之后链路断了只会一直刷「断线,重连」,从日志里看不出是地址错了。
    派侧 2026-09-22 实测能解析 `MacBook-Air-1864.local`(Mac 改名前叫 MacBook-Air-3)(反方向 Mac 解析 `pizero.local` 不通,
    那是另一回事,见 docs/硬件-POP话筒与树莓派桥.md)。
    """
    if argv and not argv[0].startswith("--"):
        return argv[0]
    return env.get("WORKBENCH_WS") or DEFAULT_WORKBENCH_WS


def relay_base_of(env: dict) -> str:
    """中转地址。没配就是空串 —— 那条路直接不走,不去猜一个域名。"""
    return env.get("WORKBENCH_RELAY") or ""


def find_pop_input() -> str:
    """按设备名在 /proc/bus/input/devices 里找 POP 的 eventN。热插拔后编号会变,启动时现查。"""
    name, handlers = None, ""
    for line in open("/proc/bus/input/devices"):
        if line.startswith("N:"):
            name = line
        elif line.startswith("H:") and name and "POP Phone" in name:
            handlers = line
            break
    for tok in handlers.split():
        if tok.startswith("event"):
            return f"/dev/input/{tok}"
    raise RuntimeError("找不到 POP 话筒的输入设备——它插上了吗?")


async def hid_reader(queue: asyncio.Queue) -> None:
    """POP 按键监听,**自带重插自愈**。

    话筒被碰掉重插后 USB 会换设备号、输入节点也可能换(event2→event0 实测发生过),
    旧 fd 立刻失效。第一版在这里直接抛异常、任务静默死掉,表现是"按键从此没反应",
    而日志上什么都看不到——一台常年摆在桌上的设备不能这样,所以整段套在重试循环里。
    """
    while True:
        try:
            device = find_pop_input()
        except (RuntimeError, OSError):
            await asyncio.sleep(3)  # 话筒没插着(或者这不是派),等它回来
            continue

        loop = asyncio.get_running_loop()
        ev = asyncio.Event()
        fd = os.open(device, os.O_RDONLY | os.O_NONBLOCK)
        loop.add_reader(fd, ev.set)
        print(f"[hid] 按键监听已附到 {device}", flush=True)
        try:
            while True:
                await ev.wait(); ev.clear()
                try:
                    data = os.read(fd, INPUT_EVENT.size * 16)
                except BlockingIOError:
                    continue
                for off in range(0, len(data) - INPUT_EVENT.size + 1, INPUT_EVENT.size):
                    _, _, etype, code, value = INPUT_EVENT.unpack_from(data, off)
                    if etype == 1 and code == KEY_PLAYPAUSE and value == 1:  # 只认按下沿
                        print("[button] POP 按键:按下", flush=True)
                        await queue.put(button_event())
        except OSError as e:
            print(f"[hid] 设备掉了({e}),3 秒后重新寻找", flush=True)
        finally:
            loop.remove_reader(fd)
            try:
                os.close(fd)
            except OSError:
                pass
        await asyncio.sleep(3)


def rings_from_message(msg: dict) -> list:
    """从一条 /live 推送里读出该起哪些铃(**8791 那条老路**)。

    两个来源:
    - `ring`:正常的起铃推送;
    - `snapshot.state.ringing`:**重连后能接听的唯一依据**。2026-08-25 实测——
      响铃原来只活在消息流里,谁也不持有,派一断线重连就永久丢失这次响铃,
      回到待机态,POP 按键按下去什么也不做(复现:起铃 → 重启 phone-bridge →
      展示台还在响,派却没再进 ringing)。工作台现在把「当前正在响的是谁」放进快照。

    缺字段一律当成「没有铃在响」:派可能连上一台还没升级的工作台,不能炸。
    """
    kind = msg.get("kind")
    if kind == "ring":
        return [ring_event(msg.get("agent", "?"), msg.get("session_id", "?"))]
    if kind == "snapshot":
        state = msg.get("state") or {}
        ringing = state.get("ringing") or []
        return [ring_event(r.get("agent", "?"), r.get("session_id", "?")) for r in ringing]
    return []


async def live_reader(queue: asyncio.Queue, ws_url: str, token: str = "") -> None:
    """订阅工作台 /live(**老路,兜底**)。断线指数退避重连。

    非本机的订阅 8791 要验设备令牌(2026-09-11 起),没带就被直接掐断,派上看到的是
    「did not receive a valid HTTP response」(2026-09-22 真机实测)。配对后把令牌带在
    Authorization 头里;没配对时照旧不带 —— 那时本来就连不上,日志会一直说。

    房间那条路起来之后这条还留着:8791 不通时派仍能收到 ring 照常等人提机
    (只是那一通没有声音)。两条同时来同一通电话的可能是有的 ——
    状态机在 RINGING 里忽略新的 ring,所以最多是"已经在响了,再响一次不变"。
    """
    try:
        import websockets
    except ImportError:
        print("[live] 没装 websockets,老那条路不走了(房间那条不受影响)", flush=True)
        return
    backoff = 1
    while True:
        try:
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            try:
                conn = websockets.connect(f"{ws_url}/live", ping_interval=20, additional_headers=headers)
            except TypeError:  # websockets 13 及以前的旧参数名
                conn = websockets.connect(f"{ws_url}/live", ping_interval=20, extra_headers=headers)
            async with conn as ws:
                print(f"[live] 已连上 {ws_url}/live", flush=True)
                backoff = 1
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except ValueError:
                        continue
                    for ring in rings_from_message(msg):
                        await queue.put(ring)
        except Exception as e:  # noqa: BLE001
            print(f"[live] 断线({e}),{backoff}s 后重连", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


def start_hook_watch(queue: asyncio.Queue, loop) -> None:
    """叉簧开关监听。gpiozero 在自己的线程里回调,用 call_soon_threadsafe 送回事件循环。

    bounce_time=0.05:实测这颗鼠标微动的接触抖动在亚毫秒到几毫秒量级,50ms 足够压平。
    开关没接(或线掉了)时 GPIO 悬空读高=「拿起」,状态机在待机态忽略它,无害。
    """
    from gpiozero import Button
    hook = Button(HOOK_GPIO, pull_up=True, bounce_time=0.05)

    def on_hook_change(off: bool) -> None:
        print(f"[hook] 叉簧:{'拿起' if off else '放下'}", flush=True)
        loop.call_soon_threadsafe(queue.put_nowait, hook_event(off=off))

    hook.when_pressed = lambda: on_hook_change(False)
    hook.when_released = lambda: on_hook_change(True)
    # 挂在模块级防止被垃圾回收
    start_hook_watch.hook = hook
    # 开机报一次静止位:压住=话筒在座,松开=拿起。线掉了会永远显示"拿起"——
    # 这是判断"开关到底接没接上"最省事的一眼。
    print(f"[boot] 叉簧静止位:{'放下(在座)' if hook.is_pressed else '拿起(或线未接)'}", flush=True)


async def ticker(queue: asyncio.Queue) -> None:
    while True:
        await asyncio.sleep(1)
        await queue.put(tick_event())


def post_phone_event(http_base: str, etype: str, agent: str, session_id: str) -> None:
    body = json.dumps({"type": etype, "agent": agent, "session_id": session_id,
                       "ts": int(time.time())}).encode()
    req = urllib.request.Request(f"{http_base}/phone/event", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            print(f"[post] {etype} → {resp.status}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[post] {etype} 上报失败:{e}", flush=True)


async def heartbeat(state: dict) -> None:
    """定时向 8791 报到,好让电脑端「我的设备」里那一行显示在线。

    走的是**已有的** `GET /channel/status`(带设备令牌),不新开端点:
    8791 的 authenticate() 顺手就更新了 lastSeenAt。**出了局域网报不到** ——
    那时设置里会显示离线,而派其实在房里好好的。这一条如实写在交接的「没做的」。
    """
    token = state.get("token")
    base = state.get("workbench_http") or ""
    if not token or not base:
        return
    loop = asyncio.get_running_loop()

    def ping() -> None:
        req = urllib.request.Request(f"{base}/channel/status",
                                     headers={"Authorization": f"Bearer {token}"})
        try:
            urllib.request.urlopen(req, timeout=5).read()
        except Exception:  # noqa: BLE001 —— Mac 关着是常态,不刷屏
            pass

    while True:
        # 挪到线程池:Mac 关着时这一下要等满 5 秒超时,而那 5 秒里事件循环得照常跑音频。
        await loop.run_in_executor(None, ping)
        await asyncio.sleep(HEARTBEAT_SEC)


def do_pair(argv: list, env: dict) -> int:
    """`--pair <6位码>`:一次性配对。**这条命令跑完就退出**,不进守护循环。"""
    code = ""
    for i, arg in enumerate(argv):
        if arg == "--pair" and i + 1 < len(argv):
            code = argv[i + 1]
        elif arg.startswith("--pair="):
            code = arg.split("=", 1)[1]
    if not code:
        print("用法:python3 popphone.py --pair 123456(码在电脑端设置「我的设备」里生成)")
        return 2
    http_base = http_base_of(resolve_workbench_url(argv, env))
    path = default_state_file()
    try:
        fresh = pair(http_base, code, name=env.get("DEVICE_NAME") or DEFAULT_DEVICE_NAME)
    except RuntimeError as err:
        print(f"配对没成:{err}")
        return 1
    # 老的凭证不留:换了设备身份,上一张进房凭证签的是别人。
    state = {k: v for k, v in load_state(path).items() if k == "relay_token"}
    state.update(fresh)
    save_state(path, state)
    print(f"配对成功:device_id={fresh['device_id']},令牌已写入 {path}(0600)")
    return 0


def do_relay_login(argv: list, env: dict, ask=input, ask_secret=None) -> int:
    """`--relay-login`:在派上输一次账号密码,领中转令牌(公网那条路的门票)。跑完就退出。

    中转地址取 `$WORKBENCH_RELAY`(unit 里配)或 `--relay-login=<https://…>`。

    **同一台再跑一次是安全的,而且是改种类的办法**(2026-09-23):这台派在中转那边的
    设备类型现在报 `handset`(pairing.RELAY_DEVICE_KIND),而中转按这一列往进房凭证里
    签 `wb_kind`。2026-09-23 之前注册的那几台记的是 `other`,签不出「这是一只听筒」——
    再跑一次这条命令,中转按同一个 device_id 换一把钥匙并把类型覆盖成 handset
    (relay/server/tokens.cjs 的 issueToken),不算新设备、不占设备数。
    """
    import getpass
    from pairing import RELAY_DEVICE_KIND, relay_login
    relay_base = ""
    for arg in argv:
        if arg.startswith("--relay-login="):
            relay_base = arg.split("=", 1)[1]
    relay_base = (relay_base or relay_base_of(env)).rstrip("/")
    if not relay_base:
        print("用法:WORKBENCH_RELAY=https://中转地址 python3 popphone.py --relay-login"
              "(或 --relay-login=https://中转地址)")
        return 2
    path = default_state_file()
    state = load_state(path)
    device_id = state.get("device_id") or ""
    if not device_id:
        print("还没配对过(device.json 里没有 device_id),先 --pair 再来")
        return 2
    identifier = ask("账号(邮箱或手机号):").strip()
    password = (ask_secret or getpass.getpass)("密码(不回显):")
    try:
        token = relay_login(relay_base, identifier, password, device_id,
                            name=env.get("DEVICE_NAME") or DEFAULT_DEVICE_NAME)
    except RuntimeError as err:
        print(f"没领到:{err}")
        return 1
    finally:
        password = ""
    state["relay_token"] = token
    state["relay_base"] = relay_base
    save_state(path, state)
    print(f"领到了:中转令牌已写入 {path}(0600),这台在账号里记成"
          f"「{RELAY_DEVICE_KIND}」。之后出了局域网也能领进房凭证。")
    return 0


async def main() -> None:
    env = os.environ
    argv = sys.argv[1:]
    ws_url = resolve_workbench_url(argv, env)
    http_base = http_base_of(ws_url)
    state_path = default_state_file()
    device = load_state(state_path)
    dev = audio_device(env)
    paths = prepare_sounds()
    print(f"[boot] 工作台 {ws_url};声卡 {dev}", flush=True)
    # 两把令牌任意一把都够进房:`token` 是局域网配对那把,`relay_token` 是账号那把
    # (2026-09-22 起手机 App 配网时由它交下来,那条路上压根没有局域网配对)。
    keyed = bool(device.get("token") or device.get("relay_token"))
    if not keyed:
        print("[boot] 还没配对过(~/phone-bridge/device.json 里没有令牌):"
              "房间这条路走不了,只剩 8791 的老路(能响铃,没有声音)。"
              "在手机 App 的 设置 → 座机 → 添加座机 里配一次,"
              "或者老办法:python3 popphone.py --pair <6位码>", flush=True)

    queue: asyncio.Queue = asyncio.Queue()

    # ——— 房间那条路 ———
    room = None
    if keyed:
        from room_link import RoomLink  # 懒加载:没装 livekit 的机器上也要起得来
        room = RoomLink(queue, dev, log=lambda line: print(line, flush=True))
        ticket_box = {"ticket": {}}

        def forget_relay(cleaned: dict) -> None:
            """中转说钥匙作废了:把 device.json 换成清干净的那一份(原地改 `device`,
            房间那条路后面每一次领票用的都是它)。落盘失败也照样按「没绑账号」跑 ——
            内存里那把已经扔了,不会再去敲中转;只是重启后还要再挨一次 401。"""
            device.clear()
            device.update(cleaned)
            ticket_box["ticket"] = {}
            try:
                save_state(state_path, device)
            except OSError as err:
                print(f"[ticket] 清不掉作废的钥匙({err}),重启后会再试一次", flush=True)
            print("[ticket] 这台座机已回到「没绑账号」:在手机 App 里重新添加一次", flush=True)

        def next_ticket() -> dict:
            """**每次重连都重新领一次**:凭证会过期,拿着同一张重试一整夜是经典死法。"""
            fresh = acquire_ticket(device, int(time.time()), relay_base_of(env),
                                   log=lambda line: print(line, flush=True),
                                   on_unbind=forget_relay)
            if fresh and fresh != ticket_box["ticket"]:
                ticket_box["ticket"] = fresh
                device["ticket"] = fresh
                # 现在绑着的是哪间房。`fallback_ok` 拿它判「手上那张过期的还是不是这间的」。
                device["room"] = fresh.get("room") or ""
                try:
                    save_state(state_path, device)
                except OSError as err:
                    print(f"[ticket] 存不下来({err}),下次开机要重领", flush=True)
            return fresh

        asyncio.create_task(room.run(next_ticket))
        asyncio.create_task(heartbeat(device))

    asyncio.create_task(hid_reader(queue))
    try:
        start_hook_watch(queue, asyncio.get_running_loop())
        print(f"[boot] 叉簧开关就绪 GPIO{HOOK_GPIO}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[boot] 叉簧开关不可用({e}),仅按键模式", flush=True)
    asyncio.create_task(live_reader(queue, ws_url, device.get("token") or ""))
    asyncio.create_task(ticker(queue))

    await run_phone(queue, room, paths, http_base, dev)


async def run_phone(queue, room, paths: dict, http_base: str, dev: str) -> None:
    """**这台电话本身**:从队列里吃事件,把状态机吐出来的动作一条条兑现。

    抽成一个函数(2026-09-21)是为了让 Mac 上那份假环境
    (`dev/fake_handset.py`)跑的是**这一份**代码,而不是一份抄得像的。
    一份抄来的循环只能证明抄得对,证明不了派上跑的那个对。
    """
    phone = PhoneState()
    while True:
        event = await queue.get()
        prev = phone
        phone, actions = transition(phone, event, now=int(time.time()))
        if phone.phase != prev.phase:
            # 标出是谁触发的:叉簧和按键在状态机里等价,日志里必须分得开,
            # 否则没法回答"刚才那下到底是拿起听筒还是按了按钮"(Ben 2026-08-26 要求)。
            src = {"hook": "叉簧", "button": "按键", "ring": "来电",
                   "ring_end": "对面收场", "tick": "超时"}.get(
                event.get("kind"), event.get("kind", "?"))
            # 提机即拨出的那一通没有 call_id(工人还没给它编号),别在日志里印一个 None。
            who = (phone.call_id or phone.session_id or prev.call_id
                   or prev.session_id or "提机即拨出")
            print(f"[state] {prev.phase} → {phone.phase}  由「{src}」触发  ({who})", flush=True)
        for action in actions:
            if action[0] == "post":
                post_phone_event(http_base, action[1], action[2], action[3])
            elif action[0] == "play":
                play(paths, action[1], dev)
            elif action[0] == "rpc":
                if room is None:
                    # **听筒里什么都没有时,日志里得有一行**(2026-09-23,提机即拨出)。
                    # 没配对 / 没装 livekit 时房间这条路压根没起,拨出去的那条 start
                    # 无处可发。不退回 8791 那条老路 —— 它没有音频,拨过去照样听不见人。
                    print(f"[rpc] 房间这条路没起来,{action[1]} 发不出去:"
                          "听筒里不会有人说话(先在手机 App 的 设置 → 座机 里配一次)",
                          flush=True)
                else:
                    await room.send_call(action[1], action[2])
            elif action[0] == "audio" and room is not None:
                await (room.audio_on() if action[1] == "on" else room.audio_off())


if __name__ == "__main__":
    if any(a == "--pair" or a.startswith("--pair=") for a in sys.argv[1:]):
        sys.exit(do_pair(sys.argv[1:], os.environ))
    if any(a == "--relay-login" or a.startswith("--relay-login=") for a in sys.argv[1:]):
        sys.exit(do_relay_login(sys.argv[1:], os.environ))
    asyncio.run(main())
