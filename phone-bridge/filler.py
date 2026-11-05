"""派端的缓冲语与「真声什么时候到」(2026-09-23,Ben 真机第一次整条线通:「延迟有点高」)。

## 这一份要解决的那件事

统筹 10:32 转述 Ben 的观察:**手机上的字幕早就出来了,声音大概晚了一秒左右**。
也就是说慢的不是识别、不是模型,是「文字已出 → 派上出声」那一段。手机那一侧
2026-09-20 就有缓冲语了(`butler-app/src/call/fillerAudio.ts`:她开口慢于 0.7 秒
就本地放一句「我想想」,真声一到掐掉),而**座机话筒这一侧一句都没有** ——
提机对话时声音走派,手机只显示,于是那一秒里听筒里什么都没有。

这个文件把手机那套判定原样搬到派上,**三条规矩一字不改**:

  ① 门是 {@link FILLER_DELAY_SEC} = 0.7 秒。她在这之前开口就不垫 —— 垫了反而打架;
  ② **真声一到立刻掐掉**。不是淡出、不是放完这一句,是下一帧就换成她;
  ③ **一轮只垫一次**。工人一轮会发两条信号(`thinking` 一条、慢工具再一条,
     见 channel-worker/src/filler.ts),按轮号去重,不是每条信号垫一句。

## 为什么不另起一个 aplay

派上的听筒是 `aplay -D plughw:CARD=Phone`(audio.py)。`plughw` 不过 dmix,
**同一张卡上第二个 aplay 会被拒**(device busy)—— 想在通话中间插一句话,
只能插进**已经开着的那根管子**里。所以这里不放音频,只回「这一帧该写什么」:
她没在说话的那些帧本来写的是静音,垫场时就写缓冲语的 PCM。
接线在 room_link.py 的 `_to_earpiece`。

## 同一根管子里还插了一句:**提机那一刻的「老板,有什么吩咐?」**(2026-09-23 下午)——**缺省已关**

维护者 12:xx:「我拿起电话到说话中间可能间隔有一两秒吧,所以最好事务官能先问一句。」
工人那边的正解是**预合成 + 提机直接发帧**(channel-worker/src/tts/greeting.ts);
这个文件里的 {@link GreetingGate} 当时是**派上的兜底**:叉簧一抬就本地放 `greeting.wav`。

**同一天 14:20 真机之后这个兜底缺省关掉了**,维护者 原话:
「音色和最开始听到的『吩咐』二字不一致。」派上那份是**死文件**(用当时那个音色合的、
跟不了音色),工人那句是预合成 + 当前音色 —— 两边一起放,他在一通电话的头一秒里
听见两个人。工人那句已经够快(缓存命中直接发帧,不经 TTS),这个兜底换来的那几百毫秒
不值一个分裂的嗓子。

**代码一行没删**:`PB_GREETING_WAV` 明着指到一份 wav 上就还能开(见
{@link DEFAULT_GREETING_WAV})。铺卡那一段不再装它,还会把派上装过的那一份删掉
(sdcard-stage.sh)。

## 顺带量了派端那一截

工人那边量得到的最后一刻是「首包发进房」(channel-worker/src/latency.ts 的 `speaking`),
之后的 Opus → 阿里云 → 派 → 抖动缓冲 → ALSA **它一概量不到**。
{@link FillerGate.real_voice_ms} 就是派上能拿到的那一个数:
**从收到「她开始想」那条信号,到听筒这根管子里真的出现她的声音,过了多少毫秒**。
两个数一减,中间那一截就是网络与缓冲。没量到就是 None,不编。

纯 Python(只用 stdlib 的 wave/json/audioop 替代品),不认识 livekit,单测直接跑。
"""
import json
import os
import wave

#: 她开口慢于这么久才垫。**和手机那一侧同一个数**
#: (butler-app/src/call/fillerAudio.ts 的 FILLER_WAIT_MS = 700)。
#: 改这里要连手机那份一起改,否则同一个事务官在两只听筒上是两种脾气。
FILLER_DELAY_SEC = 0.7

#: 垫场最多放这么久。缓冲语本来就是一句话("我想想"),
#: 真放到这个上限说明信号那头出了事(模型卡住、掉线)——
#: 那时候安静下来比一直自言自语好。
FILLER_MAX_SEC = 3.0

#: 一帧里的最大振幅低于这个就算「静音」(16 位,满幅 32767)。
#: 500 ≈ -36dBFS:LiveKit 那头没人说话时是数字静音或极小的舒适噪声,
#: 而她真开口的第一帧远在这之上。调高会把她轻声说的第一个字当静音(垫的话会盖住它),
#: 调低会被线路底噪骗成"她在说话"(于是永远不垫)。
SILENCE_PEAK = 500

#: 缓冲语 wav 放哪。**不在包里**:它是一段合成出来的语音,要跟着事务官的音色走。
#: 没有这个文件时整条垫场**自己关掉**(不报错、不放别的声音),日志里说一句怎么开。
#:
#: **缺省是空的 = 这台话筒不本地垫**(2026-09-23 晚,维护者拍板):垫场改由电脑上的工人
#: 用**当前音色**说(channel-worker/src/workerFiller.ts),声音走同一条音轨进听筒。
#: 派上这一份是死文件、跟不了音色,两边一起放就是一通电话两个嗓子、两句叠在一起。
#: 协议一个字没改;要在某台机器上重新开:明设 `PB_FILLER_WAV=/var/lib/phone-bridge/filler.wav`
#: (同时把工人那边 `WORKBENCH_CHANNEL_WORKER_FILLER=off`,否则两句叠)。
DEFAULT_FILLER_WAV = ""

#: 待机提机那一刻本地先问的那一句 wav(2026-09-23,见 {@link GreetingGate})。
#:
#: **缺省是空的 = 这台话筒不放本地那一句**(2026-09-23 下午改)。
#: 维护者 14:20 真机原话:「音色和最开始听到的『吩咐』二字不一致。」
#: 派上这一份是**死文件**,用当时那个音色合的、跟不了音色;而工人那句是预合成 + 当前音色。
#: 两边一起放,他在一通电话的头一秒里就听见两个人。工人那句已经够快(缓存命中直接发帧),
#: 这个兜底换来的那几百毫秒不值一个分裂的嗓子。
#:
#: 要在某台机器上重新开它:放一份 48k/单声道/16 位的 wav 进去,并**明着**设
#: `PB_GREETING_WAV=/var/lib/phone-bridge/greeting.wav`。换音色之后记得重合一份,
#: 否则听见的还是上一个人 —— 那正是这一条被关掉的原因。
DEFAULT_GREETING_WAV = ""

#: 本地这一句最多放这么久。它本身 1.6 秒上下,3 秒的上限只是兜住
#: "wav 被换成了一整段话"这种配错 —— 真声到了随时会被掐掉,这个数平时用不上。
GREETING_MAX_SEC = 3.0


def filler_wav_path(env: dict = None) -> str:
    """缓冲语 wav 的路径。`PB_FILLER_WAV` 能改;设成空串 = **这台机器不垫**。"""
    env = os.environ if env is None else env
    if "PB_FILLER_WAV" in env:
        return (env.get("PB_FILLER_WAV") or "").strip()
    return DEFAULT_FILLER_WAV


def greeting_wav_path(env: dict = None) -> str:
    """提机那一句 wav 的路径。**缺省空 = 不放**(见 {@link DEFAULT_GREETING_WAV});
    `PB_GREETING_WAV` **明着**指到一份 wav 上才放。设成空串也是不放。"""
    env = os.environ if env is None else env
    if "PB_GREETING_WAV" in env:
        return (env.get("PB_GREETING_WAV") or "").strip()
    return DEFAULT_GREETING_WAV


def read_filler_wav(path: str, rate: int, channels: int,
                    what: str = "缓冲语", skip: str = "不垫场") -> tuple:
    """读一段本地语音 → `(pcm, note)`。

    **不重采样、不混轨**:格式对不上就如实回 `(b"", 一句人话)`,由调用方记一行日志。
    自己偷偷转一遍的话,出问题时听到的是变调的她,而没人会想到是这里干的。

    回的 `pcm` 是 16 位小端裸流,和听筒那根管子吃的东西一模一样。

    `what` / `skip` 只进那几句日志里(缓冲语「不垫场」/ 提机那一句「不放本地那一句」)——
    两段 wav 走同一条读法,但日志里必须分得开是哪一段没装上(2026-09-23)。
    """
    if not path:
        return b"", ""  # 明说不放,不是出错
    try:
        with wave.open(path, "rb") as w:
            got_rate, got_ch, got_width = w.getframerate(), w.getnchannels(), w.getsampwidth()
            frames = w.readframes(w.getnframes())
    except FileNotFoundError:
        return b"", f"没有{what} {path},这台话筒{skip}(放一段 48k 单声道 16 位的 wav 进去就开)"
    except (OSError, wave.Error) as err:
        return b"", f"{what} {path} 读不了({err}),这一轮{skip}"
    if (got_rate, got_ch, got_width) != (rate, channels, 2):
        return b"", (f"{what} {path} 是 {got_rate}Hz/{got_ch}ch/{got_width * 8}bit,"
                     f"要的是 {rate}Hz/{channels}ch/16bit —— 不自己转,这一轮{skip}")
    return frames, ""


def parse_filler_signal(raw: str) -> dict:
    """工人广播的那条 `{"type":"filler",...}` → `{"round": n}`。

    别的一律回 `{}`:这条通道上还跑着字幕、铃声、音色变更,认不得的原样丢掉。
    `kind` 是 `thinking` 还是 `tool` **这里不区分** —— 一轮只垫一次,按轮号去重
    (工人一轮会发两条,见 channel-worker/src/filler.ts 的第 ①②条)。
    """
    try:
        got = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(got, dict) or got.get("type") != "filler":
        return {}
    round_no = got.get("round")
    if not isinstance(round_no, int) or isinstance(round_no, bool) or round_no < 1:
        return {}
    return {"round": round_no}


def is_silent(frame: bytes, peak: int = SILENCE_PEAK) -> bool:
    """这一帧是静音吗。16 位小端,看最大绝对值。

    空帧算静音(没有声音就是没有声音)。长度是奇数时最后那个半样本丢掉 ——
    那不是一个样本,拿它凑出来的数没有意义。
    """
    if not frame:
        return True
    limit = len(frame) - (len(frame) % 2)
    for i in range(0, limit, 2):
        value = frame[i] | (frame[i + 1] << 8)
        if value >= 0x8000:
            value -= 0x10000
        if value < 0:
            value = -value
        if value > peak:
            return False
    return True


class FillerGate:
    """一轮垫场的判定。**所有方法都不抛**,而且**一帧都不改她的声音**。

    用法(room_link.py 的 `_to_earpiece`):

        out = gate.step(time.monotonic(), incoming_frame)
        write(out)

    `step` 只有三种回法:原样回她的那一帧、回一帧缓冲语、回原帧(静音)。
    `pcm` 是空的(没装缓冲语 wav)时这道闸**整个等于不存在**:永远原样回。
    """

    def __init__(self, pcm: bytes = b"", frame_bytes: int = 960, frame_ms: float = 10.0,
                 delay: float = FILLER_DELAY_SEC, max_sec: float = FILLER_MAX_SEC,
                 peak: int = SILENCE_PEAK):
        self._pcm = pcm or b""
        self._frame_bytes = max(2, int(frame_bytes))
        self._frame_ms = float(frame_ms) if frame_ms > 0 else 10.0
        self._delay = float(delay)
        frames_per_sec = 1000.0 / self._frame_ms
        self._max_bytes = (int(max_sec * frames_per_sec) * self._frame_bytes
                           if max_sec > 0 else len(self._pcm))
        self._peak = peak
        self._round = 0
        self._armed_at = None
        self._pos = 0
        self._playing = False
        self._real_ms = None
        self._played_ms = None

    # ———————————————————————— 状态(日志与用例用) ————————————————————————

    @property
    def enabled(self) -> bool:
        """这台机器垫不垫场(有没有缓冲语)。"""
        return len(self._pcm) > 0

    @property
    def state(self) -> str:
        """`idle` 闲着 / `waiting` 等她开口 / `playing` 正在垫。"""
        if self._armed_at is None:
            return "idle"
        return "playing" if self._playing else "waiting"

    @property
    def real_voice_ms(self):
        """上一轮:从「她开始想」那条信号到听筒里真出现她的声音,多少毫秒。没量到是 None。

        **这是派上唯一量得到的那个数**。和工人那边 `GET /channel/latency` 的
        `mouth_ms` 一减,中间那一截(Opus → 阿里云 → 派 → 抖动缓冲)就出来了。
        """
        return self._real_ms

    @property
    def played_ms(self):
        """上一轮真的垫出去了多少毫秒(没垫是 None)。"""
        return self._played_ms

    # ———————————————————————— 判定 ————————————————————————

    def arm(self, round_no: int, now: float) -> bool:
        """收到一条「她开始想」。回「这一条算不算数」(同一轮的第二条不算)。"""
        if not self.enabled:
            return False
        if round_no == self._round and self._armed_at is not None:
            return False
        if round_no == self._round and self._real_ms is not None:
            # 这一轮已经收过场了(她说完了),同一个轮号再来一条不重新开
            return False
        self._round = round_no
        self._armed_at = now
        self._pos = 0
        self._playing = False
        self._real_ms = None
        self._played_ms = None
        return True

    def step(self, now: float, frame: bytes) -> bytes:
        """这一帧往听筒里写什么。

        四条分支,顺序就是优先级:
          1. 没在等 → 原样(这道闸不存在);
          2. **她开口了** → 立刻收场(记下 real_voice_ms),原样;
          3. 还没到 0.7 秒 → 原样(那几帧本来就是静音);
          4. 到点了 → 回一帧缓冲语;放完/超时就收场。
        """
        if self._armed_at is None:
            return frame
        if not is_silent(frame, self._peak):
            self._finish(now)
            return frame
        if now - self._armed_at < self._delay:
            return frame
        chunk = self._pcm[self._pos:self._pos + self._frame_bytes]
        if not chunk or self._pos >= self._max_bytes:
            self._finish(now)
            return frame
        self._pos += len(chunk)
        self._playing = True
        if len(chunk) < self._frame_bytes:
            # 最后那一小块补齐成整帧:短帧写进 aplay 会把后面的采样错位半个样本。
            chunk = chunk + bytes(self._frame_bytes - len(chunk))
        return chunk

    def stop(self, now: float) -> None:
        """从外面掐掉这一段(2026-09-23:他放下听筒了)。

        没在放就什么都不做。不掐的话,挂断之后这根管子里还会继续吐完那一句 ——
        下一通提机就会听见上一通的尾巴。
        """
        self._finish(now)

    def _finish(self, now: float) -> None:
        if self._armed_at is None:
            return
        self._real_ms = int(round((now - self._armed_at) * 1000))
        self._played_ms = (int(round(self._pos / self._frame_bytes * self._frame_ms))
                           if self._playing else None)
        self._armed_at = None
        self._playing = False
        self._pos = 0


class GreetingGate(FillerGate):
    """**提机那一刻本地先问一句**(2026-09-23,维护者 12:xx:
    「我拿起电话到说话中间可能间隔有一两秒吧,所以最好事务官能先问一句:
    『老板,有什么吩咐?』」)。**缺省不放**(2026-09-23 下午,见文件头)。

    工人那边也做了同一件事(预合成 + 提机直接发帧,channel-worker/src/tts/greeting.ts),
    这一份是**派上的兜底**:房间那条路慢了、抖动缓冲攒着、工人那句还没合出来时,
    听筒里先有声音。

    **为什么缺省关**:这一份是死文件,跟不了音色;工人那句跟着当前音色走。
    两边一起放 = 一通电话的头一秒里两个嗓子(维护者 14:20 真机)。
    `PB_GREETING_WAV` 明着设一份 wav 才放;没装 wav 时这个类的每一条路都是「不放」,
    行为与从前一字不差。

    与垫场那道闸的三点不同,每一点都是想明白了的:

      ① **不等 0.7 秒**(`delay=0`)。垫场是"她可能马上就开口,等一下别抢话";
         提机这一下**她一定还没开口**(消息才刚发出去),等一等只是白等;
      ② **由叉簧触发,不由房间里的信号触发**。信号要先跑一个来回,而这一句要的就是那个来回;
      ③ **称呼固定是「老板」**。轮换在工人那边(address.ts 那张表按天轮),
         派上这一句是本地 wav,跟不了表 —— 两边都想轮的话会出现
         「本地叫老板、工人接着叫姚总」的分裂。所以派上只叫「老板」,
         工人那句一到就把它掐掉,他听见的就是工人那个称呼。

    真声一到掐掉:那一条**和缓冲语逐字同一套**(`step` 的第 ② 条),一帧都不改她的声音。
    """

    def __init__(self, pcm: bytes = b"", frame_bytes: int = 960, frame_ms: float = 10.0,
                 max_sec: float = GREETING_MAX_SEC, peak: int = SILENCE_PEAK):
        super().__init__(pcm, frame_bytes=frame_bytes, frame_ms=frame_ms,
                         delay=0.0, max_sec=max_sec, peak=peak)
        self._seq = 0

    def offhook(self, now: float) -> bool:
        """他拿起听筒了。回「这一下放不放」(没装 wav 时永远是 False)。

        每提一次机算新的一次:轮号自己往上走,不与垫场那一套共用。
        """
        self._seq += 1
        return self.arm(self._seq, now)
