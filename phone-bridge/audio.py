"""派这一侧的嘴和耳朵(2026-09-21;2026-09-22 晚拿掉了铃)。

**派不响铃**(Ben 2026-09-22 晚):「响铃应该是手机发出,而不是话筒,
话筒自己是用来对话的。」所以这个文件里只剩两段**确认音**(接通 / 挂断)和
通话那两根裸流管子 —— 合成铃声那一段已经删掉。


**不用 sounddevice / PyAudio**:那两个要 PortAudio,派上要编译、要多一棵依赖树,
而 `arecord` / `aplay` 本来就在系统里、2026-08-21 那次录放回环人耳验证用的就是它们
(硬件文档「三项硬件实测」)。这里只是把它们当成两根管子:
录音进程的 stdout 是原始 S16LE,播放进程的 stdin 也是。

## 为什么每条命令都可配

Mac 上没有 `arecord`/`aplay`(实测 `which` 两个都没有)。要在 Mac 上真跑一遍
「工人发 ring → 派响铃 → 音轨互通」,就得能把这两根管子换成别的东西
(ffmpeg 读一个 wav 当麦克风、写一个 wav 当听筒)。所以:

  PB_RECORD_CMD / PB_PLAY_CMD  通话那两根裸流管子,整条命令自己给(空格分词)
  PB_WAV_CMD                   放一段 wav(铃声、提示音)的命令,`{file}` 是那个文件
  AUDIO_DEV                    只换设备名,命令还是 arecord/aplay(派上就用这个)

2026-09-23 又多了两对(见 {@link DEFAULT_BUFFER_MS} 那一段):

  PB_PLAY_BUFFER_MS / PB_PLAY_PERIOD_MS      听筒的 ALSA 缓冲(0 = 不加参数,回到老行为)
  PB_RECORD_BUFFER_MS / PB_RECORD_PERIOD_MS  麦克风那一侧同理

三条里 `{dev}` 都会被替换成设备名。

没有这两个口子,「Mac 上跑通」就只能靠嘴说。
"""
import math
import os
import shlex
import struct
import subprocess
import wave

#: 房间里的采样率与声道。LiveKit 那头按这个收,POP 那头按这个录。
#: 48k 单声道:POP 的输入本来就是 1ch(硬件文档实测表),不必先采 2ch 再丢一半。
SAMPLE_RATE = 48000
CHANNELS = 1

#: 一帧多少个采样点。10ms —— 与 LiveKit 的 AudioSource 队列(默认 1000ms)配合得刚好,
#: 再小 CPU 上下文切换开销在 Zero 2W 上就显出来了。
FRAME_SAMPLES = SAMPLE_RATE // 100
FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2

#: 默认按**名字**选卡,不用序号 —— 热插拔之后序号会变(popphone.py 里那条老注释)。
DEFAULT_AUDIO_DEV = "plughw:CARD=Phone"

#: ALSA 缓冲(毫秒)。**2026-09-23 的第一手快**,Ben 真机:「字幕早就出来了,声音晚一秒」。
#:
#: `aplay` / `arecord` 不给 `--buffer-time` 时用的是设备允许的默认值,在 Pi 上通常是
#: **500ms 缓冲 / 125ms 周期**;而 aplay 的 start_threshold 就是缓冲满 —— 也就是说
#: 听筒这根管子稳定之后**一直含着约半秒的音频**,那半秒原样加在「她开口 → 他听见」上。
#: 录音那一侧同理,只是方向相反(他说的话晚半个周期才出发)。
#:
#: 120ms / 20ms:留四个周期的余量,够 Zero 2W 在一条 Opus 编码之外喂得上。
#: **关掉**:`PB_PLAY_BUFFER_MS=0`(录音是 `PB_RECORD_BUFFER_MS=0`)——
#: 不加这两个参数就完全回到 2026-09-22 的行为。
#: **代价说清楚**:调得太小,派上一忙就 underrun,听筒里是断续的爆音。
#: 真机上听着不对就先把它调回 0,再按 200 / 300 往上找。
DEFAULT_BUFFER_MS = 120
DEFAULT_PERIOD_MS = 20


def _int_env(env: dict, key: str, fallback: int) -> int:
    """环境变量 → 非负整数。读不懂就用缺省 —— 这两个数配错了只影响音质,不该让电话起不来。"""
    raw = (env.get(key) or "").strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError:
        return fallback
    return value if value >= 0 else fallback


def buffer_args(env: dict, buffer_key: str, period_key: str) -> list:
    """`--buffer-time` / `--period-time` 那两个参数(微秒)。缓冲设成 0 = 一个参数都不加。"""
    buffer_ms = _int_env(env, buffer_key, DEFAULT_BUFFER_MS)
    if buffer_ms <= 0:
        return []
    period_ms = _int_env(env, period_key, DEFAULT_PERIOD_MS)
    if period_ms <= 0 or period_ms > buffer_ms:
        period_ms = max(1, buffer_ms // 4)
    return ["--buffer-time", str(buffer_ms * 1000), "--period-time", str(period_ms * 1000)]


def record_command(dev: str, env: dict = None) -> list:
    """录音那根管子。默认 `arecord … -t raw -`,stdout 是 S16LE 裸流。"""
    env = os.environ if env is None else env
    custom = env.get("PB_RECORD_CMD")
    if custom:
        return shlex.split(custom.replace("{dev}", dev))
    return (["arecord", "-q", "-D", dev, "-f", "S16_LE", "-r", str(SAMPLE_RATE),
             "-c", str(CHANNELS), "-t", "raw"]
            + buffer_args(env, "PB_RECORD_BUFFER_MS", "PB_RECORD_PERIOD_MS")
            + ["-"])


def play_command(dev: str, env: dict = None) -> list:
    """播放那根管子。默认 `aplay … -t raw -`,stdin 吃 S16LE 裸流。"""
    env = os.environ if env is None else env
    custom = env.get("PB_PLAY_CMD")
    if custom:
        return shlex.split(custom.replace("{dev}", dev))
    return (["aplay", "-q", "-D", dev, "-f", "S16_LE", "-r", str(SAMPLE_RATE),
             "-c", str(CHANNELS), "-t", "raw"]
            + buffer_args(env, "PB_PLAY_BUFFER_MS", "PB_PLAY_PERIOD_MS")
            + ["-"])


def wav_command(path: str, dev: str, env: dict = None) -> list:
    """放一段 wav(提机 / 挂机的确认音)。默认 `aplay -q -D <dev> <file>`。

    为什么不复用上面那根裸流管子:一段 wav 不值得自己解一遍头。
    为什么可配:Mac 上没有 aplay,而这两声「接上了 / 断了」是假环境里唯一听得见的东西 ——
    不给这个口子,那一步就只能靠日志上一句「放不出来」。
    """
    env = os.environ if env is None else env
    custom = env.get("PB_WAV_CMD")
    if custom:
        return shlex.split(custom.replace("{dev}", dev).replace("{file}", path))
    return ["aplay", "-q", "-D", dev, path]


def audio_device(env: dict = None) -> str:
    env = os.environ if env is None else env
    return env.get("AUDIO_DEV") or DEFAULT_AUDIO_DEV


# ———————————————————————— 提示音与铃声 ————————————————————————

def make_beep(path: str, freqs: list, dur: float = 0.18, rate: int = SAMPLE_RATE) -> None:
    """生成一段提示音 WAV(几个音符连播)。stdlib 合成,不引依赖。"""
    frames = bytearray()
    for f in freqs:
        n = int(rate * dur)
        for i in range(n):
            fade = min(1.0, i / 500, (n - i) / 500)  # 淡入淡出防爆音
            value = 0 if f == 0 else int(12000 * fade * math.sin(2 * math.pi * f * i / rate))
            frames += struct.pack("<h", value)
    with wave.open(path, "wb") as w:
        w.setnchannels(CHANNELS)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))


# 2026-09-22 晚:`make_ring()`(440+480Hz 双音、响 1 秒停 2 秒的那段铃)**整个删掉了**。
# Ben 定的:「响铃应该是手机发出,而不是话筒,话筒自己是用来对话的。」
# 手机那一段铃还在(butler-app/public/ring/ringtone.m4a,同一组参数),派这一份没人要了。
#
# 同一天稍晚还留过一件空壳 `RingPlayer`(只为 popphone.py 那一支没拆的接线),
# 配网那张卡合进 main 之后**连类带接线一起删掉了**(分支 `chore/pi-tidy`):
# 状态机一条 `("ring", …)` 都不吐,`run_phone` 的签名里也没有它了。


SOUNDS = {"answered": [523, 659, 784], "hangup": [784, 523]}


def prepare_sounds(tmp_dir: str = "/tmp") -> dict:
    """开机时把几段提示音合成到临时目录。**每次开机重做** ——
    它们只有几十 KB,而一份跟着代码走的 wav 迟早和代码里的频率表对不上。

    2026-09-22 晚起**不再有 `ring` 这一项**:派不响铃(见文件里 make_ring 那处的注释)。
    留下的两段("answered" / "hangup")是**提机与挂机的确认音**,不是铃 ——
    它们在他手里的听筒上响,告诉他这一下接上了 / 断了。
    """
    paths = {}
    for name, freqs in SOUNDS.items():
        p = os.path.join(tmp_dir, f"popphone_{name}.wav")
        make_beep(p, freqs)
        paths[name] = p
    return paths


def play(paths: dict, name: str, dev: str = "") -> None:
    """放一小段提示音。**不等它放完**(那会卡住整个事件循环)。

    走的是 `aplay <wav>` 而不是上面那根裸流管子:一段 wav 不值得自己解一遍头。
    Mac 上没有 aplay —— 放不出来只是没声音,不该把守护进程带走,所以整段 try。
    """
    if name not in paths:
        return
    try:
        subprocess.Popen(wav_command(paths[name], dev or audio_device()),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass
