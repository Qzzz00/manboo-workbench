"""派这一侧的声音(2026-09-22 晚:**派不响铃**)。

Ben 定的那一条(决策记录「2026-09-22 晚 · 座机话筒不响铃,铃由手机出」):

> 响铃应该是手机发出,而不是话筒,话筒自己是用来对话的。

所以这一份只钉两件事:**没有铃**,以及**提机/挂机那两声确认音还在**
—— 它们不是铃,是在他手里那只听筒上响的一下「接上了 / 断了」。
"""
import os
import tempfile
import unittest

import audio


class 派不响铃(unittest.TestCase):
    def test_开机合成的几段声音里没有铃(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = audio.prepare_sounds(tmp)
        self.assertNotIn("ring", paths)

    def test_合成铃声那个函数已经不存在了(self):
        """★ 变异检验的靶子:把 `make_ring` 加回来、或者让 prepare_sounds 再生成一段铃,
        这一份当场红。"""
        self.assertFalse(hasattr(audio, "make_ring"))

    def test_铃声播放器连壳都没有了(self):
        """★ 变异检验的靶子:2026-09-22 晚留过一件空壳 `RingPlayer`,只为 popphone.py
        那一支还没拆的接线;配网那张卡合完之后连类带接线一起删了(`chore/pi-tidy`)。
        把它加回来,这一条当场红 —— 免得下一个人又照着它接一遍。"""
        self.assertFalse(hasattr(audio, "RingPlayer"))

    def test_守护进程里一条响铃接线都没有(self):
        """那件空壳真正的危害在 popphone.py 那一侧:`("ring", …)` 那一支只要还在,
        就还有人会往状态机里加回那个动作。这一条钉的是**接线没了**:
        `run_phone` 的签名里没有播放器、循环里没有 `"ring"` 那一支。"""
        import inspect

        import popphone

        self.assertEqual(
            list(inspect.signature(popphone.run_phone).parameters),
            ["queue", "room", "paths", "http_base", "dev"],
        )
        source = inspect.getsource(popphone.run_phone)
        self.assertNotIn('action[0] == "ring"', source)


class 提机挂机那两声还在(unittest.TestCase):
    def test_两段确认音照旧合成得出来(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = audio.prepare_sounds(tmp)
            self.assertEqual(sorted(paths), ["answered", "hangup"])
            for path in paths.values():
                self.assertTrue(os.path.getsize(path) > 0)


class ALSA缓冲(unittest.TestCase):
    """2026-09-23,Ben 真机:「字幕早就出来了,声音大概晚了一秒左右」。

    `aplay`/`arecord` 不给 `--buffer-time` 时吃的是设备默认值(Pi 上常是 500ms 缓冲),
    而 aplay 的 start_threshold 就是缓冲满 —— 那半秒原样加在「她开口 → 他听见」上。
    这一组钉的是:**默认加上这两个参数**,而且**一个环境变量就能整个关掉**。
    """

    def test_默认就带上缓冲与周期(self):
        cmd = audio.play_command("plughw:CARD=Phone", {})
        self.assertIn("--buffer-time", cmd)
        self.assertEqual(cmd[cmd.index("--buffer-time") + 1], str(audio.DEFAULT_BUFFER_MS * 1000))
        self.assertEqual(cmd[cmd.index("--period-time") + 1], str(audio.DEFAULT_PERIOD_MS * 1000))
        # 裸流那个 `-` 必须还在最后一位,否则 aplay 会去读一个叫 --period-time 的文件
        self.assertEqual(cmd[-1], "-")

    def test_录音那一侧同样带(self):
        cmd = audio.record_command("plughw:CARD=Phone", {})
        self.assertIn("--buffer-time", cmd)
        self.assertEqual(cmd[-1], "-")

    def test_设成0就一个参数都不加回到老行为(self):
        """★ 单独关掉这一手的开关。真机上听着爆音、断续,就先把它设回 0。"""
        cmd = audio.play_command("plughw:CARD=Phone", {"PB_PLAY_BUFFER_MS": "0"})
        self.assertNotIn("--buffer-time", cmd)
        self.assertNotIn("--period-time", cmd)
        self.assertEqual(
            cmd,
            ["aplay", "-q", "-D", "plughw:CARD=Phone", "-f", "S16_LE",
             "-r", str(audio.SAMPLE_RATE), "-c", str(audio.CHANNELS), "-t", "raw", "-"],
        )

    def test_两个数能各自调(self):
        cmd = audio.play_command("dev", {"PB_PLAY_BUFFER_MS": "300", "PB_PLAY_PERIOD_MS": "50"})
        self.assertEqual(cmd[cmd.index("--buffer-time") + 1], "300000")
        self.assertEqual(cmd[cmd.index("--period-time") + 1], "50000")

    def test_周期比缓冲还大就自己收敛成四分之一(self):
        """周期 > 缓冲 ALSA 直接报错起不来。配错了不该让电话哑掉。"""
        cmd = audio.play_command("dev", {"PB_PLAY_BUFFER_MS": "120", "PB_PLAY_PERIOD_MS": "500"})
        self.assertEqual(cmd[cmd.index("--period-time") + 1], "30000")

    def test_读不懂的值用缺省不报错(self):
        cmd = audio.play_command("dev", {"PB_PLAY_BUFFER_MS": "快一点"})
        self.assertEqual(cmd[cmd.index("--buffer-time") + 1], str(audio.DEFAULT_BUFFER_MS * 1000))

    def test_整条命令自己给时这两个参数一个都不掺(self):
        """`PB_PLAY_CMD` 是 Mac 上假环境那条路(文件头)。自己给的命令要原样跑。"""
        cmd = audio.play_command("dev", {"PB_PLAY_CMD": "ffmpeg -i - out.wav"})
        self.assertEqual(cmd, ["ffmpeg", "-i", "-", "out.wav"])


if __name__ == "__main__":
    unittest.main()
