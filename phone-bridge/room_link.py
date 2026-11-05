"""派在 LiveKit 房间里的那一半(2026-09-21)。

派是房里的**第三位**:工人(`wb-channel-worker`)、手机(`wb-phone-<id>`)、
派(也是 `wb-phone-<id>`,但属性里 `wb_kind=handset`)。它只做四件事:

  1. 进房、断了重进;
  2. 收 `wb.rpc` 上的 `ring` / `ring_end`,翻成事件丢进队列(状态机那边吃);
  3. 提机时**才**推麦克风音轨(`audio on`),挂机时撤掉(`audio off`);
  4. 订阅工人的音轨,写进听筒那根管子。
  5. (2026-09-22 晚)收**手机发来的换网请求**(`netcfg`),交给 root 那半边去跑
     nmcli,切完在新网上重新进房、把结果发回给那台手机;回不来就切回老网。
     逻辑全在 `netcfg.py`(有单测),这里只是把它接到房间与 socket 上。

## livekit 这个依赖是懒加载的

`import livekit` 放在 `connect()` 里而不是文件顶上:phone_state / signals / pairing
那几份单测要在**没装 livekit 的机器上**跑得起来(CI、以及任何一台刚 clone 的 Mac)。
把它提到顶上,`python3 -m unittest` 第一行就 ImportError。

## 待机不推音轨

卡上那条「待机不推音轨(省电省流量)」不只是省:Zero 2W 上一条常开的 Opus 编码
本身就是持续 CPU,而一只常年开着的麦克风摆在桌上是另一回事(设计-座机信号协议 §五)。
所以 `publish_track` 只在提机那一刻调,挂机就 `unpublish_track`。
"""
import asyncio
import subprocess
import time

import filler
import netcfg
from audio import CHANNELS, FRAME_BYTES, FRAME_SAMPLES, SAMPLE_RATE, play_command, record_command
from signals import RPC_TOPIC, call_request, parse_room_signal, rpc_response_of

#: 工人在房里的身份。与 workbench-plugin/src/server/channel.ts 的
#: CHANNEL_WORKER_IDENTITY、channel-worker/src/rpc.ts 的 WORKER_IDENTITY 同一个字符串。
WORKER_IDENTITY = "wb-channel-worker"

#: 断线重连的退避上限(秒)。与老那条 WS 用同一个数,日志读起来是一回事。
MAX_BACKOFF_SEC = 30


def _write_all(stream, data: bytes) -> None:
    """把一帧整个写进去。`bufsize=0` 的管子是裸的 —— `write()` 可能只吃一部分,
    剩下的不补就是听筒里一声轻微的咔哒(采样错位)。"""
    view = memoryview(data)
    while view:
        written = stream.write(view)
        if not written:
            return
        view = view[written:]


class RoomLink:
    """一条房间连接。**所有对外接口都不抛** —— 房间断了是常态,不是错误。"""

    def __init__(self, queue: asyncio.Queue, dev: str, log=print):
        self._queue = queue
        self._dev = dev
        self._log = log
        self._room = None
        self._rtc = None
        #: 推出去的那条音轨(None = 待机,没在推)。
        self._pub = None
        self._source = None
        self._mic_task = None
        self._mic_proc = None
        #: 听筒那根管子(订阅到工人音轨时才起)。
        self._spk_task = None
        self._spk_proc = None
        self._connected = asyncio.Event()
        #: 进了几次房(2026-09-22 换网)。换网的成败只认这一个数 —— 详见 netcfg.SwitchWatch。
        self._join_seq = 0
        #: 正在跑的那一趟换网(没有就是闲着)。
        self._watch = netcfg.SwitchWatch()
        self._watch_task = None
        #: 垫场那道闸(2026-09-23)。没装缓冲语 wav 时它等于不存在 —— 见 filler.py。
        pcm, note = filler.read_filler_wav(filler.filler_wav_path(), SAMPLE_RATE, CHANNELS)
        if note:
            self._log(f"[filler] {note}")
        self._filler = filler.FillerGate(pcm, frame_bytes=FRAME_BYTES,
                                         frame_ms=1000 // (SAMPLE_RATE // FRAME_SAMPLES))
        if self._filler.enabled:
            self._log(f"[filler] 缓冲语备好了({len(pcm) // (SAMPLE_RATE * 2 // 1000)}ms),"
                      f"她开口慢于 {filler.FILLER_DELAY_SEC} 秒就垫一句")
        #: 提机那一句的本地兜底(2026-09-23)。同一套路、同一根管子,
        #: 只是由叉簧触发、不等 0.7 秒 —— 见 filler.GreetingGate。
        hello, hello_note = filler.read_filler_wav(
            filler.greeting_wav_path(), SAMPLE_RATE, CHANNELS,
            what="提机那一句", skip="不放本地那一句(只等工人那句)")
        if hello_note:
            self._log(f"[greeting] {hello_note}")
        self._greeting = filler.GreetingGate(hello, frame_bytes=FRAME_BYTES,
                                             frame_ms=1000 // (SAMPLE_RATE // FRAME_SAMPLES))
        if self._greeting.enabled:
            self._log(f"[greeting] 提机那一句备好了({len(hello) // (SAMPLE_RATE * 2 // 1000)}ms),"
                      "拿起听筒当场就问;工人那句一到立刻掐掉")

    # ———————————————————————— 进房 ————————————————————————

    async def run(self, ticket_source) -> None:
        """连上、断了再连。`ticket_source` 是一个**每次重连都会再调一次**的可调用对象 ——
        凭证会过期,拿着同一张重试一整夜是这类守护进程最经典的死法。"""
        backoff = 1
        loop = asyncio.get_running_loop()
        # 每 20 秒告诉 root 那半边一声「在不在房里」:进不了房时它要把蓝牙开着(2026-09-30)。
        asyncio.create_task(self._report_room_loop())
        while True:
            # **领凭证要发 HTTP,挪到线程池里**:它最坏要等两个 10 秒超时(局域网一次、
            # 中转一次),而这会儿事件循环里还跑着音频与房间心跳。直接 await 一个同步请求
            # 等于让整台电话卡二十秒 —— 而那正好是"领不到凭证"时每次重试都会发生的事。
            ticket = await loop.run_in_executor(None, ticket_source)
            if not ticket:
                self._log("[room] 还没有进房凭证(没配对?),20 秒后再看")
                await asyncio.sleep(20)
                continue
            try:
                await self._connect(ticket)
                backoff = 1
                await self._wait_until_gone()
            except Exception as err:  # noqa: BLE001 —— 进房能失败的方式太多,一条都不该带走进程
                self._log(f"[room] 进不去({err}),{backoff}s 后重试")
            finally:
                await self.audio_off()
                await self._teardown()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF_SEC)

    async def _connect(self, ticket: dict) -> None:
        from livekit import rtc  # 懒加载,见文件头
        self._rtc = rtc
        room = rtc.Room()
        self._connected.clear()

        @room.on("disconnected")
        def _gone(*_args):
            self._log("[room] 断开了")
            self._connected.set()
            asyncio.create_task(self._report_room())

        @room.on("track_subscribed")
        def _subscribed(track, publication, participant):
            if participant.identity != WORKER_IDENTITY:
                # 房里还有手机。**只听工人**:两路声音写进同一根管子会糊在一起,
                # 而且他自己的声音会从听筒里回来(回授)。
                return
            if track.kind != rtc.TrackKind.KIND_AUDIO:
                return
            self._log("[room] 订上工人的音轨了")
            self._spk_task = asyncio.create_task(self._to_earpiece(track))

        room.register_text_stream_handler(RPC_TOPIC, self._on_text)
        await room.connect(ticket["url"], ticket["token"])
        self._room = room
        # **进房次数**。加在 `self._room` 之后:看守一看见它变大就要发消息,
        # 那一刻房必须已经在手上。
        self._join_seq += 1
        asyncio.create_task(self._report_room())
        self._log(f"[room] 进房了:{ticket['room']},身份 {ticket['identity']};"
                  f"房里现在有:{'、'.join(room.remote_participants.keys()) or '还没有别人'}")

    async def _wait_until_gone(self) -> None:
        await self._connected.wait()

    def _in_room(self) -> bool:
        return self._room is not None and not self._connected.is_set()

    async def _report_room(self) -> None:
        """报一次在不在房里。**不抛、不记日志**(root 那半边没在跑也不该吵)。"""
        await self._ask_root(netcfg.ipc_request(netcfg.IPC_ROOM, in_room=self._in_room()), timeout=5)

    async def _report_room_loop(self) -> None:
        while True:
            try:
                await self._report_room()
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(20)

    async def _teardown(self) -> None:
        for task in (self._spk_task,):
            if task is not None:
                task.cancel()
        self._spk_task = None
        self._kill(self._spk_proc)
        self._spk_proc = None
        room = self._room
        self._room = None
        if room is not None:
            try:
                await room.disconnect()
            except Exception:  # noqa: BLE001 —— 已经断了
                pass

    # ———————————————————————— 收信号 ————————————————————————

    def _on_text(self, reader, participant_identity: str) -> None:
        """`wb.rpc` 上来一条。两种来路,**别的一律不读**:

        · 工人(`wb-channel-worker`):来电那几条;
        · 手机(`wb-phone-*`):换网请求(2026-09-22 晚)。房里另一台手机发给**工人**的
          rpc 请求也会路过这条通道,那些不是给派的 —— `parse_netcfg_request` 认不得
          就回 `{}`,原样丢掉。
        """
        if participant_identity != WORKER_IDENTITY and not participant_identity.startswith(netcfg.PHONE_PREFIX):
            return
        asyncio.create_task(self._read_text(reader, participant_identity))

    async def _read_text(self, reader, who: str = WORKER_IDENTITY) -> None:
        try:
            raw = await reader.read_all()
        except Exception as err:  # noqa: BLE001
            self._log(f"[room] 有一条消息没读完({err})")
            return
        if who != WORKER_IDENTITY:
            request = netcfg.parse_netcfg_request(raw, who)
            if request:
                self._log(f"[netcfg] 收到 {netcfg.redact(request)}")
                asyncio.create_task(self._netcfg(request))
            return
        event = parse_room_signal(raw)
        if event:
            await self._queue.put(event)
            return
        signal = filler.parse_filler_signal(raw)
        if signal:
            # **不进状态机队列**:垫一句话不是一件事,只是听筒这根管子接下来几帧写什么。
            if self._filler.arm(signal["round"], time.monotonic()):
                self._log(f"[filler] 第 {signal['round']} 轮:她开始想了,"
                          f"{filler.FILLER_DELAY_SEC} 秒内没听见她就垫一句")
            return
        said = rpc_response_of(raw)
        if said and not said["ok"]:
            # 工人拒了我们的 answer / hangup。**如实说一句** —— 最常见的是
            # 「正在响的不是这一通」(铃刚好在他拿起听筒那一刻超时了)。
            self._log(f"[room] 工人回:没办成 —— {said['error'] or '没说原因'}")

    # ———————————————————————— 发信号 ————————————————————————

    async def send_call(self, action: str, call_id: str) -> None:
        """提机 / 挂机。发不出去只记一行:一条消息丢了不该把守护进程带走。"""
        room = self._room
        if room is None:
            self._log(f"[room] 没进房,{action} 发不出去")
            return
        # 本地那一句就在这一刻起(2026-09-23,提机先问)。
        #
        # **排在 send_text 前面**:这一句的全部意义就是省掉那个来回,
        # 等消息发完再放等于把要省的那点时间又还回去了。
        #
        # 只认 `start`(待机提机拨出去的那一通)。来电接起(`answer`)**不放** ——
        # 那一通的开场白是工人的 `ringOpener`(「老板,有件事跟你确认一下」),
        # 本地这句「有什么吩咐」插在前面就是两句话打架。挂断(`hangup`)当场掐掉,
        # 不然下一通提机会听见上一通的尾巴。
        if action == "start":
            if self._greeting.offhook(time.monotonic()):
                self._log("[greeting] 提机:先本地问一句,工人那句一到就掐掉")
        elif action == "hangup":
            self._greeting.stop(time.monotonic())
        try:
            await room.local_participant.send_text(
                call_request(action, call_id), topic=RPC_TOPIC,
                destination_identities=[WORKER_IDENTITY])
            self._log(f"[room] → 工人:{action} {call_id}")
        except Exception as err:  # noqa: BLE001
            self._log(f"[room] {action} 没发出去({err})")

    async def _reply(self, who: str, text: str) -> None:
        """点名发给那台手机。**房里别人收不到** —— 结果里有地址,没必要广播。"""
        room = self._room
        if room is None:
            self._log("[netcfg] 没进房,这条结果发不出去")
            return
        try:
            await room.local_participant.send_text(text, topic=RPC_TOPIC,
                                                   destination_identities=[who])
        except Exception as err:  # noqa: BLE001
            self._log(f"[netcfg] 结果没发出去({err})")

    # ———————————————————————— 换网(2026-09-22 晚) ————————————————————————

    async def _ask_root(self, request: dict, timeout: float = 60.0) -> dict:
        """问 root 那半边(`provisiond.py` 的 Unix socket)。**不抛**。

        为什么要跨进程:这一半跑在用户 `ben` 下,而 `nmcli` 改系统连接要 polkit 的
        `settings.modify.system` —— 派上没人登录只有 linger,用户级服务拿不到活动 seat。
        理由全文在 `provision.py` 的文件头。
        """
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(netcfg.SOCKET_PATH), timeout=5)
        except (OSError, asyncio.TimeoutError) as err:
            return {"ok": False, "text": f"座机上的配网服务没在跑({err});"
                                         f"在派上 sudo systemctl status wb-provision 看一眼"}
        try:
            writer.write(netcfg.encode_ipc(request))
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        except (OSError, asyncio.TimeoutError) as err:
            return {"ok": False, "text": f"配网服务没回话({err})"}
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass
        got = netcfg.decode_ipc(line)
        return got or {"ok": False, "text": "配网服务回了读不懂的东西"}

    async def _netcfg(self, request: dict) -> None:
        who, req_id = request["from"], request["id"]
        if request["action"] == netcfg.ACTION_SCAN:
            got = await self._ask_root(netcfg.ipc_request(netcfg.IPC_SCAN), timeout=60)
            if got.get("ok"):
                await self._reply(who, netcfg.scan_result(req_id, got.get("networks") or []))
            else:
                await self._reply(who, netcfg.error_result(req_id, netcfg.ACTION_SCAN,
                                                           str(got.get("text") or "扫不动")))
            return

        # ——— 换网 ———
        if self._watch.busy():
            await self._reply(who, netcfg.error_result(
                req_id, netcfg.ACTION_SWITCH, "座机正在换网,等这一趟完了再来"))
            return
        ssid = request["ssid"]
        current = await self._ask_root(netcfg.ipc_request(netcfg.IPC_CURRENT), timeout=20)
        previous = str(current.get("name") or "")
        self._watch.begin(req_id, who, ssid, previous, int(time.time()), self._join_seq)

        got = await self._ask_root(
            netcfg.ipc_request(netcfg.IPC_SWITCH, ssid=ssid, psk=request.get("psk", "")),
            timeout=netcfg.VERIFY_SEC)
        if not got.get("ok"):
            # nmcli 就没连上(密码错、找不到这个网)。**这时房间多半还在**,
            # 直接把结果发回去,不进那个等重连的看守。
            self._watch.cancel()
            await self._reply(who, netcfg.switch_result(
                req_id, False, str(got.get("code") or "failed"),
                str(got.get("text") or "没连上"), ssid))
            return

        # nmcli 说连上了。**这还不算成** —— 连上路由器不等于回得到房间里
        # (比赛现场那种要在网页上点同意的网,nmcli 一样报成功)。
        # 主动断一次房间:在新网上重新进房才是唯一的判据,而且顺带把 DNS 与连接
        # 都在新网上重建一遍(不主动断的话,一条居然活下来的旧连接会让看守误判)。
        self._log(f"[netcfg] nmcli 说连上 {ssid} 了,断开重进看看回不回得来")
        self._connected.set()
        self._start_watching()

    def _start_watching(self) -> None:
        if self._watch_task is None or self._watch_task.done():
            self._watch_task = asyncio.create_task(self._watch_loop())

    async def _watch_loop(self) -> None:
        """每秒问一次看守该干什么。**不在 `_teardown` 里被取消** ——
        它要活过那一次断开重连,不然结果永远发不出去。"""
        try:
            while self._watch.busy():
                await asyncio.sleep(1)
                action, job = self._watch.decide(int(time.time()), self._join_seq)
                if action == netcfg.WAIT:
                    continue
                if action == netcfg.REPORT_OK:
                    where = await self._ask_root(netcfg.ipc_request(netcfg.IPC_CURRENT), timeout=20)
                    self._log(f"[netcfg] 换到 {job['ssid']} 成了,已经回到房里")
                    await self._reply(job["from"], netcfg.switch_result(
                        req_id=job["id"], ok=True, ssid=str(where.get("ssid") or job["ssid"]),
                        ip=str(where.get("ip") or "")))
                elif action == netcfg.ROLLBACK:
                    if job["previous"] == "":
                        self._log("[netcfg] 回不来,而且不知道原来连的是哪条,切不回去")
                        continue
                    self._log(f"[netcfg] {netcfg.VERIFY_SEC} 秒没回来,切回 {job['previous']}")
                    await self._ask_root(
                        netcfg.ipc_request(netcfg.IPC_ROLLBACK, name=job["previous"]), timeout=60)
                    self._connected.set()
                elif action == netcfg.REPORT_ROLLED_BACK:
                    self._log(f"[netcfg] 切回老网之后回来了,如实报「没换成」")
                    await self._reply(job["from"], netcfg.switch_result(
                        req_id=job["id"], ok=False, code="verify_failed",
                        text=netcfg.rolled_back_text(job["ssid"]),
                        ssid=job["ssid"], rolled_back=True))
                elif action == netcfg.GIVE_UP:
                    # 发不出去(不在房里)。只留一行,交给 wifi 看门狗。
                    self._log(f"[netcfg] {netcfg.give_up_text(job['ssid'])}")
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001 —— 一趟换网不该把守护进程带走
            self._log(f"[netcfg] 看守自己出错了({err})")
        finally:
            self._watch_task = None

    # ———————————————————————— 音轨 ————————————————————————

    async def audio_on(self) -> None:
        """提机:推麦克风。已经在推就什么都不做(重复的 offhook 不该推第二条轨)。"""
        room, rtc = self._room, self._rtc
        if room is None or rtc is None or self._pub is not None:
            return
        try:
            self._source = rtc.AudioSource(SAMPLE_RATE, CHANNELS)
            track = rtc.LocalAudioTrack.create_audio_track("pop-mic", self._source)
            options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
            self._pub = await room.local_participant.publish_track(track, options)
            self._mic_task = asyncio.create_task(self._from_mic())
            self._log("[audio] 麦克风推上去了")
        except Exception as err:  # noqa: BLE001
            self._log(f"[audio] 麦克风推不上去({err})")
            self._pub = None

    async def audio_off(self) -> None:
        """挂机:撤麦克风。**顺序是先停录音进程再 unpublish** ——
        反过来的话 capture_frame 会往一条已经没了的轨里写。"""
        task, self._mic_task = self._mic_task, None
        if task is not None:
            task.cancel()
        self._kill(self._mic_proc)
        self._mic_proc = None
        pub, self._pub = self._pub, None
        room = self._room
        if pub is not None and room is not None:
            try:
                await room.local_participant.unpublish_track(pub.sid)
                self._log("[audio] 麦克风撤下来了")
            except Exception as err:  # noqa: BLE001
                self._log(f"[audio] 撤轨没成({err})")
        self._source = None

    async def _from_mic(self) -> None:
        """POP 的麦克风 → 房间。一帧 10ms,读满了才推(短帧会被 LiveKit 拒)。"""
        from livekit import rtc
        loop = asyncio.get_running_loop()
        try:
            self._mic_proc = subprocess.Popen(
                record_command(self._dev), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except OSError as err:
            self._log(f"[audio] 录音起不来({err}):这一通他说的话过不去")
            return
        stdout = self._mic_proc.stdout
        try:
            while True:
                # 阻塞读挪到线程池:这根管子一秒要醒 100 次,卡在事件循环里
                # 会把房间的心跳一起拖住。
                chunk = await loop.run_in_executor(None, stdout.read, FRAME_BYTES)
                if not chunk or len(chunk) < FRAME_BYTES:
                    self._log("[audio] 录音流断了")
                    return
                await self._source.capture_frame(
                    rtc.AudioFrame(chunk, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES))
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            self._log(f"[audio] 录音这一路断了({err})")

    async def _to_earpiece(self, track) -> None:
        """工人的声音 → POP 的听筒。

        听筒这根管子**一直开着**(只要订上了),不随提机/挂机起落:她在我们挂断前
        那半句话该播完,而重开一次 `aplay` 在派上要几百毫秒(开头会吃掉一个字)。

        ★ 2026-09-28(卡 CF 第 4 条)**座机这一路刻意不发那条「我这边在放了」**。
        手机要发它,是因为它那个 `<audio>` 平时暂停+静音,接通才 `play()`,
        Android WebView 还要重开一次 AudioTrack —— 那几百毫秒吃掉了她的第一个字。
        座机没有这一段:这根管子从订上音轨起就没关过,帧一到就出声。
        所以它的 `call.start` 不带 `reports_playing`,工人那道闸对它整个跳过
        (channel-worker/src/tts/playingGate.ts);哪天听筒改成按通话起停 `aplay`,
        再在这儿发一条 `{"type":"call","action":"playing"}`,工人那一侧不用改。
        """
        from livekit import rtc
        loop = asyncio.get_running_loop()
        try:
            # **bufsize=0**(2026-09-23)。默认的 8192 字节 BufferedWriter 会把
            # 八九帧(约 85ms)攒在 Python 这一侧才交给 aplay —— 那 85ms 原样加在
            # 「她开口 → 他听见」上,而且是一跳一跳地加(攒满才走)。
            # 代价:write() 可能只写一部分,所以下面用 _write_all 兜着。
            self._spk_proc = subprocess.Popen(
                play_command(self._dev), stdin=subprocess.PIPE, stderr=subprocess.DEVNULL,
                bufsize=0)
        except OSError as err:
            self._log(f"[audio] 听筒起不来({err}):这一通他听不见她说话")
            return
        stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=CHANNELS)
        stdin = self._spk_proc.stdin
        try:
            async for event in stream:
                data = bytes(event.frame.data)
                now = time.monotonic()
                # 提机那一句(filler.GreetingGate):拿起听筒到工人那句到达之间的那一两秒,
                # 这根管子里本来全是静音。**排在垫场前面**:两道闸不会同时开
                # (垫场要等她那一轮开始想,那是他说完话之后的事),真撞上了也只是
                # 垫场那道闸把本地这句当成"有人在说话"而提前收场 —— 不会有两句一起响。
                was_hello = self._greeting.state
                data = self._greeting.step(now, data)
                if was_hello != "idle" and self._greeting.state == "idle":
                    self._log(f"[greeting] 真声到(提机后 {self._greeting.real_voice_ms}ms)"
                              f"{'' if self._greeting.played_ms is None else f',本地那句放了 {self._greeting.played_ms}ms'}"
                              ",本地这句当场掐掉")
                # 垫场那道闸(filler.py):她没开口的那些帧本来写的是静音,
                # 到点就换成缓冲语;她一开口下一帧立刻换回她。**一帧都不改她的声音**。
                was = self._filler.state
                data = self._filler.step(now, data)
                if was != "idle" and self._filler.state == "idle":
                    self._log(f"[filler] 真声到:信号后 {self._filler.real_voice_ms}ms"
                              f"{'' if self._filler.played_ms is None else f',垫了 {self._filler.played_ms}ms'}")
                await loop.run_in_executor(None, _write_all, stdin, data)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            self._log(f"[audio] 听筒这一路断了({err})")
        finally:
            await stream.aclose()

    @staticmethod
    def _kill(proc) -> None:
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass
