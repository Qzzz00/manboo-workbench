"""派端垫场的判定(filler.py)。

钉的是那三条规矩(文件头):0.7 秒的门、真声一到掐掉、一轮只垫一次。
外加一条更要紧的:**没装缓冲语时这道闸一帧都不许碰她的声音**。

手机与派不在手上,这一份**不是真机验证** —— 它只保证这几条判定本身没写错。
真机上要看的是 phone-bridge 日志里那行 `[filler] 真声到:信号后 XXXms`。
"""
import os
import struct
import tempfile
import unittest
import wave

import filler

RATE = 48000
FRAME_BYTES = 960  # 10ms,48k 单声道 16 位


def tone(samples: int, amplitude: int = 8000) -> bytes:
    """一段有声音的帧。"""
    return struct.pack("<" + "h" * samples, *([amplitude] * samples))


def hush(samples: int) -> bytes:
    """一段数字静音。"""
    return bytes(samples * 2)


def write_wav(path: str, seconds: float, rate: int = RATE, channels: int = 1, width: int = 2) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(bytes(int(rate * seconds) * channels * width))


class 认信号(unittest.TestCase):
    def test_工人那条filler原样认得出来(self):
        raw = '{"type":"filler","kind":"thinking","round":3,"at":1790130431891}'
        self.assertEqual(filler.parse_filler_signal(raw), {"round": 3})

    def test_慢工具那条也认同一个轮号(self):
        raw = '{"type":"filler","kind":"tool","tool":"scan_projects","round":3,"at":1}'
        self.assertEqual(filler.parse_filler_signal(raw), {"round": 3})

    def test_这条通道上别的东西一律不认(self):
        """字幕、铃声、音色变更都走同一个 topic —— 认错一条就会在她说话中间插一句。"""
        for raw in [
            '{"type":"caption","role":"butler","text":"你好","final":true}',
            '{"type":"ring","id":"abc"}',
            '{"type":"filler_voice_changed","voice":"S_x","at":1}',
            '{"type":"filler"}',                      # 没有轮号
            '{"type":"filler","round":0}',            # 轮号从 1 开始
            '{"type":"filler","round":true}',         # bool 不是轮号
            '{"type":"filler","round":"3"}',          # 字符串不是轮号
            "不是 JSON",
            "",
        ]:
            self.assertEqual(filler.parse_filler_signal(raw), {}, raw)


class 判静音(unittest.TestCase):
    def test_数字静音与空帧都算静音(self):
        self.assertTrue(filler.is_silent(hush(480)))
        self.assertTrue(filler.is_silent(b""))

    def test_她一开口就不算静音(self):
        self.assertFalse(filler.is_silent(tone(480)))

    def test_一帧里只要有一个大样本就算有声(self):
        frame = bytearray(hush(480))
        frame[200:202] = struct.pack("<h", 9000)
        self.assertFalse(filler.is_silent(bytes(frame)))

    def test_底噪不算她开口(self):
        self.assertTrue(filler.is_silent(tone(480, amplitude=100)))

    def test_奇数长度不抛(self):
        self.assertTrue(filler.is_silent(hush(10) + b"\x00"))


class 没装缓冲语时这道闸不存在(unittest.TestCase):
    """★ 变异检验的靶子:让空闸也往听筒里写点什么,这一条当场红。"""

    def test_每一帧都原样回(self):
        gate = filler.FillerGate(b"", frame_bytes=FRAME_BYTES)
        self.assertFalse(gate.enabled)
        self.assertFalse(gate.arm(1, 0.0))
        quiet = hush(480)
        for t in range(0, 300):
            self.assertIs(gate.step(t * 0.01, quiet), quiet)
        self.assertEqual(gate.state, "idle")


class 垫场三条规矩(unittest.TestCase):
    def setUp(self):
        # 1 秒缓冲语,每一帧都有声音(好认)
        self.pcm = tone(RATE)
        self.gate = filler.FillerGate(self.pcm, frame_bytes=FRAME_BYTES, frame_ms=10)
        self.quiet = hush(480)

    def test_她在0点7秒之前开口就一个字都不垫(self):
        self.assertTrue(self.gate.arm(1, 0.0))
        for t in (0.0, 0.2, 0.5, 0.69):
            self.assertIs(self.gate.step(t, self.quiet), self.quiet, t)
        voice = tone(480)
        self.assertIs(self.gate.step(0.70, voice), voice)
        self.assertEqual(self.gate.state, "idle")
        self.assertEqual(self.gate.real_voice_ms, 700)
        self.assertIsNone(self.gate.played_ms)

    def test_过了0点7秒还没听见她就开始垫(self):
        self.gate.arm(1, 0.0)
        self.assertIs(self.gate.step(0.69, self.quiet), self.quiet)
        first = self.gate.step(0.70, self.quiet)
        self.assertIsNot(first, self.quiet)
        self.assertEqual(len(first), FRAME_BYTES)
        self.assertFalse(filler.is_silent(first))
        self.assertEqual(self.gate.state, "playing")

    def test_真声一到下一帧立刻掐掉(self):
        """★ 靶子:改成「放完这一句再让位」,这一条当场红 —— 那就是她和缓冲语抢着说。"""
        self.gate.arm(1, 0.0)
        for i in range(20):
            self.gate.step(0.70 + i * 0.01, self.quiet)
        self.assertEqual(self.gate.state, "playing")
        voice = tone(480)
        self.assertIs(self.gate.step(0.90, voice), voice)
        self.assertEqual(self.gate.state, "idle")
        self.assertEqual(self.gate.real_voice_ms, 900)
        self.assertEqual(self.gate.played_ms, 200)

    def test_一轮只垫一次同一轮的第二条信号不算(self):
        self.assertTrue(self.gate.arm(4, 0.0))
        self.assertFalse(self.gate.arm(4, 0.3))
        # 第二条信号没把计时重置:0.7 秒还是从第一条算起
        self.assertIsNot(self.gate.step(0.70, self.quiet), self.quiet)

    def test_她说完之后同一轮再来一条也不重新垫(self):
        self.gate.arm(4, 0.0)
        self.gate.step(0.10, tone(480))
        self.assertEqual(self.gate.state, "idle")
        self.assertFalse(self.gate.arm(4, 0.5))

    def test_下一轮照垫(self):
        self.gate.arm(1, 0.0)
        self.gate.step(0.10, tone(480))
        self.assertTrue(self.gate.arm(2, 1.0))
        self.assertIsNot(self.gate.step(1.71, self.quiet), self.quiet)

    def test_缓冲语放完就自己收场不循环(self):
        """★ 靶子:让它绕回开头接着放,这一条当场红(听筒里会变成复读机)。"""
        gate = filler.FillerGate(tone(480 * 3), frame_bytes=FRAME_BYTES, frame_ms=10)
        gate.arm(1, 0.0)
        played = 0
        for i in range(50):
            out = gate.step(0.70 + i * 0.01, self.quiet)
            if out is not self.quiet:
                played += 1
        self.assertEqual(played, 3)
        self.assertEqual(gate.state, "idle")

    def test_信号来了她一直不开口也不会垫个没完(self):
        gate = filler.FillerGate(tone(RATE * 10), frame_bytes=FRAME_BYTES, frame_ms=10,
                                 max_sec=1.0)
        gate.arm(1, 0.0)
        played = 0
        for i in range(400):
            if gate.step(0.70 + i * 0.01, self.quiet) is not self.quiet:
                played += 1
        self.assertEqual(played, 100)  # 1 秒封顶
        self.assertEqual(gate.state, "idle")

    def test_最后那一小块补齐成整帧(self):
        """短帧写进 aplay 会把后面的采样错位。"""
        gate = filler.FillerGate(tone(480) + tone(100), frame_bytes=FRAME_BYTES, frame_ms=10)
        gate.arm(1, 0.0)
        self.assertEqual(len(gate.step(0.70, self.quiet)), FRAME_BYTES)
        self.assertEqual(len(gate.step(0.71, self.quiet)), FRAME_BYTES)


class 读缓冲语wav(unittest.TestCase):
    def test_格式对就读得出来(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "filler.wav")
            write_wav(path, 0.5)
            pcm, note = filler.read_filler_wav(path, RATE, 1)
            self.assertEqual(note, "")
            self.assertEqual(len(pcm), int(RATE * 0.5) * 2)

    def test_没有这个文件就是不垫而不是出错(self):
        pcm, note = filler.read_filler_wav("/不存在/filler.wav", RATE, 1)
        self.assertEqual(pcm, b"")
        self.assertIn("不垫场", note)

    def test_格式不对如实说一句绝不偷偷重采样(self):
        """★ 靶子:加一段自动重采样,这一条当场红 —— 变调的她没人会想到是这里干的。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "filler.wav")
            write_wav(path, 0.2, rate=24000)
            pcm, note = filler.read_filler_wav(path, RATE, 1)
            self.assertEqual(pcm, b"")
            self.assertIn("24000Hz", note)

    def test_明说空路径就是这台机器不垫连一句抱怨都没有(self):
        pcm, note = filler.read_filler_wav("", RATE, 1)
        self.assertEqual(pcm, b"")
        self.assertEqual(note, "")

    def test_路径由环境变量决定(self):
        self.assertEqual(filler.filler_wav_path({}), filler.DEFAULT_FILLER_WAV)
        # 2026-09-23 晚:缺省不本地垫(垫场改由工人用当前音色说)。
        self.assertEqual(filler.DEFAULT_FILLER_WAV, "")
        self.assertEqual(filler.filler_wav_path({"PB_FILLER_WAV": "/x/y.wav"}), "/x/y.wav")
        self.assertEqual(filler.filler_wav_path({"PB_FILLER_WAV": ""}), "")


class 和手机那一侧同一个数(unittest.TestCase):
    def test_门是0点7秒(self):
        """★ 靶子:两边的门不一样,同一个事务官在两只听筒上就是两种脾气。
        改这个数要连 butler-app/src/call/fillerAudio.ts 的 FILLER_WAIT_MS 一起改。"""
        self.assertEqual(filler.FILLER_DELAY_SEC, 0.7)



class 提机那一刻本地先问一句(unittest.TestCase):
    """提机先问(2026-09-23,Ben 12:xx:「我拿起电话到说话中间可能间隔有一两秒吧,
    所以最好事务官能先问一句:『老板,有什么吩咐?』」)。

    钉四件:**不等 0.7 秒当场就放**、**真声一到掐掉**、**放下就停**、
    以及那条最要紧的 —— **没装 greeting.wav 时它一帧都不碰她的声音**。
    """

    def setUp(self):
        # 1 秒的本地那一句,每帧都有声音(好认)
        self.pcm = tone(RATE)
        self.gate = filler.GreetingGate(self.pcm, frame_bytes=FRAME_BYTES)
        self.quiet = hush(480)

    def test_提机当场就出声不等那0点7秒(self):
        """★ 靶子:给它也加上 0.7 秒的门,这一条当场红 —— 那正是这张卡要消灭的那一两秒。"""
        self.assertTrue(self.gate.offhook(0.0))
        out = self.gate.step(0.0, self.quiet)
        self.assertNotEqual(out, self.quiet)
        self.assertEqual(len(out), FRAME_BYTES)
        self.assertEqual(self.gate.state, "playing")

    def test_工人那句一到立刻掐掉本地这句(self):
        """★ 靶子:改成「放完这一句再让位」,这一条当场红 —— 那就是两个她抢着说话。"""
        self.gate.offhook(0.0)
        self.gate.step(0.0, self.quiet)
        self.gate.step(0.01, self.quiet)
        real = tone(480)
        self.assertIs(self.gate.step(0.02, real), real)   # 一帧都不改她的声音
        self.assertEqual(self.gate.state, "idle")
        self.assertEqual(self.gate.real_voice_ms, 20)
        self.assertIsNotNone(self.gate.played_ms)
        # 掐掉之后这道闸就不存在了,后面的静音帧原样过
        self.assertIs(self.gate.step(0.03, self.quiet), self.quiet)

    def test_放下听筒就停不留到下一通(self):
        """不停的话,下一通提机会先听见上一通那句的尾巴。"""
        self.gate.offhook(0.0)
        self.gate.step(0.0, self.quiet)
        self.gate.stop(0.05)
        self.assertEqual(self.gate.state, "idle")
        self.assertIs(self.gate.step(0.06, self.quiet), self.quiet)

    def test_再提一次机是新的一次从头放(self):
        """上一次放到第二帧就被掐了,下一次得从第一帧重来(不然他听见的是半句)。"""
        # 每一帧都不一样的一段,好认是第几帧
        ramp = b"".join(struct.pack("<h", 1000 + i) * 480 for i in range(10))
        gate = filler.GreetingGate(ramp, frame_bytes=FRAME_BYTES)
        gate.offhook(0.0)
        self.assertEqual(gate.step(0.0, self.quiet), ramp[:FRAME_BYTES])
        self.assertEqual(gate.step(0.01, self.quiet), ramp[FRAME_BYTES:FRAME_BYTES * 2])
        gate.stop(0.02)
        self.assertTrue(gate.offhook(1.0))
        self.assertEqual(gate.step(1.0, self.quiet), ramp[:FRAME_BYTES])

    def test_本地这句放完就自己收场不循环(self):
        self.gate.offhook(0.0)
        t = 0.0
        for _ in range(int(RATE / 480)):          # 正好一秒
            self.gate.step(t, self.quiet)
            t += 0.01
        self.assertIs(self.gate.step(t, self.quiet), self.quiet)
        self.assertEqual(self.gate.state, "idle")

    def test_没装greeting_wav时这道闸一帧都不碰(self):
        """★ 靶子:让空闸也往听筒里写点什么,这一条当场红。"""
        gate = filler.GreetingGate(b"", frame_bytes=FRAME_BYTES)
        self.assertFalse(gate.enabled)
        self.assertFalse(gate.offhook(0.0))
        for t in range(0, 300):
            self.assertIs(gate.step(t * 0.01, self.quiet), self.quiet)
        self.assertEqual(gate.state, "idle")

    def test_缺省不放_PB_GREETING_WAV明设才放(self):
        """★ 2026-09-23 下午改:**缺省关**。

        维护者 14:20 真机:「音色和最开始听到的『吩咐』二字不一致。」
        派上这一份是死文件、跟不了音色,工人那句跟着当前音色走 ——
        两边一起放 = 一通电话的头一秒里两个嗓子。
        """
        self.assertEqual(filler.DEFAULT_GREETING_WAV, "")
        self.assertEqual(filler.greeting_wav_path({}), "")
        # 明着指一份 wav 才放(要开这个兜底的人自己放一份进去)
        self.assertEqual(filler.greeting_wav_path({"PB_GREETING_WAV": "/x/hi.wav"}), "/x/hi.wav")
        # 空串照旧 = 不放
        self.assertEqual(filler.greeting_wav_path({"PB_GREETING_WAV": ""}), "")

    def test_缺省那条路一帧都不碰(self):
        """★ 没装 wav:读出来是空的、闸门是关的、提机不放,每一帧原样过去。"""
        pcm, note = filler.read_filler_wav(filler.greeting_wav_path({}), RATE, 1,
                                           what="提机那一句", skip="不放本地那一句")
        self.assertEqual(pcm, b"")
        self.assertEqual(note, "")  # 明说不放,不是出错 —— 日志里不该有一行抱怨
        gate = filler.GreetingGate(pcm, frame_bytes=FRAME_BYTES)
        self.assertFalse(gate.enabled)
        self.assertFalse(gate.offhook(0.0))
        quiet = bytes(FRAME_BYTES)
        self.assertIs(gate.step(0.1, quiet), quiet)

    def test_读它走同一条读法但日志分得开是哪一段(self):
        pcm, note = filler.read_filler_wav("/不存在/greeting.wav", RATE, 1,
                                           what="提机那一句", skip="不放本地那一句")
        self.assertEqual(pcm, b"")
        self.assertIn("提机那一句", note)
        self.assertIn("不放本地那一句", note)


class 仓库里那份greeting_wav(unittest.TestCase):
    """留着给**明着**设 PB_GREETING_WAV 的人(2026-09-23 下午起铺卡不再装它)。

    格式不对派上只会记一行然后什么都不放,所以这一条仍然钉着。
    """

    def test_是48k单声道16位而且不长(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "greeting.wav")
        self.assertTrue(os.path.isfile(path), path)
        pcm, note = filler.read_filler_wav(path, RATE, 1, what="提机那一句")
        self.assertEqual(note, "")
        seconds = len(pcm) / 2 / RATE
        # 一句「老板,有什么吩咐?」两秒以内;长过 GREETING_MAX_SEC 会被那道上限截掉半句。
        self.assertLess(seconds, 2.0)
        self.assertGreater(seconds, 0.8)
        self.assertLess(seconds, filler.GREETING_MAX_SEC)


if __name__ == "__main__":
    unittest.main()


class 铺卡不再装本地开场句(unittest.TestCase):
    """★ 光是不装不够:上一次铺卡装进去的那一份还在 /var/lib,照放不误。

    所以 runcmd 里得有**一行删除**。这一条钉的是那两件事(2026-09-23 下午)。
    """

    @staticmethod
    def _stage() -> str:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sdcard-stage.sh")
        with open(path, encoding="utf-8") as f:
            return f.read()

    def test_runcmd里没有装greeting的那一行(self):
        text = self._stage()
        self.assertNotIn("install -D -m 0644 -o root -g root $PI_BOOT/phone-bridge/greeting.wav", text)
        # 缓冲语那一份没动(它跟着音色走,是另一件事)
        self.assertIn("install -D -m 0644 -o root -g root $PI_BOOT/phone-bridge/filler.wav", text)

    def test_runcmd里有删掉派上那一份的那一行(self):
        self.assertIn("rm -f /var/lib/phone-bridge/greeting.wav", self._stage())

    def test_清单里不再铺greeting_wav上卡(self):
        text = self._stage()
        self.assertIn("assets/filler.wav", text)
        self.assertNotIn("assets/greeting.wav", text)
