"""守护进程的配置解析测试。先于实现编写（仓库纪律：TDD）。

只测纯函数部分——HID / WS / 房间 / aplay 那几根线要真硬件，不在单测范围。
8791 那条老路（`rings_from_message`）2026-09-21 起是**兜底**，不是主路：
它带 `source: "live"`，状态机据此知道这一通没有音频（见 phone_state.py 顶部）。
"""
import unittest

from popphone import relay_base_of, resolve_workbench_url, rings_from_message


class 工作台地址(unittest.TestCase):
    def test_命令行参数优先于环境变量(self):
        url = resolve_workbench_url(["ws://cli:1"], {"WORKBENCH_WS": "ws://env:2"})

        self.assertEqual(url, "ws://cli:1")

    def test_没给参数时读环境变量(self):
        """systemd 服务就靠这条传地址，改地址不用改代码。"""
        url = resolve_workbench_url([], {"WORKBENCH_WS": "ws://env:2"})

        self.assertEqual(url, "ws://env:2")

    def test_都没有时回落到主机名而不是写死的IP(self):
        """热点是 DHCP，Mac 的 IP 会变；派能经 mDNS 解析 .local（2026-08-24 实测）。

        写死 IP 的后果是静默连不上——日志只会刷「断线，重连」，看不出是地址错了。
        """
        url = resolve_workbench_url([], {})

        self.assertIn(".local:", url)


class 中转地址缺省为空(unittest.TestCase):
    """零服务器是缺省(2026-10-21):源码与 unit 都不带中转地址,只走 8791。

    中转地址只从三处来:unit 的 `WORKBENCH_RELAY`、手机配网写进 device.json 的 `relay`、
    `--relay-login` 写下的 `relay_base`(pairing.acquire_ticket)。
    """

    def test_环境变量没有就是空(self):
        self.assertEqual(relay_base_of({}), "")
        self.assertEqual(relay_base_of({"WORKBENCH_RELAY": ""}), "")

    def test_unit_里那一行留空(self):
        import os
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "phone-bridge.service"), encoding="utf-8") as fh:
            lines = [line.strip() for line in fh if line.strip().startswith("Environment=WORKBENCH_RELAY=")]
        self.assertEqual(lines, ["Environment=WORKBENCH_RELAY="])



class 从推送里读出该起的铃(unittest.TestCase):
    def test_ring_消息就是一条铃(self):
        rings = rings_from_message({"kind": "ring", "agent": "claude", "session_id": "s1"})

        self.assertEqual(rings, [{"kind": "ring", "source": "live", "agent": "claude", "session_id": "s1"}])

    def test_快照里的_ringing_也要起铃_这是重连后能接听的唯一依据(self):
        """2026-08-25 实测：断线重连后派永久丢失这次响铃，按键按下去什么也不做。

        响铃原来只活在消息流里，谁也不持有；现在工作台把「当前正在响的是谁」放进快照，
        派据此恢复响铃态。没有这条，重连就等于永远错过。
        """
        rings = rings_from_message({
            "kind": "snapshot",
            "state": {"ringing": [{"agent": "claude", "session_id": "s1"}]},
        })

        self.assertEqual(rings, [{"kind": "ring", "source": "live", "agent": "claude", "session_id": "s1"}])

    def test_快照里没有铃在响就没有事件(self):
        self.assertEqual(rings_from_message({"kind": "snapshot", "state": {"ringing": []}}), [])

    def test_老工作台的快照没有_ringing_字段_也不能炸(self):
        """派可能连上一台还没升级的工作台，缺字段要当成「没有铃在响」。"""
        self.assertEqual(rings_from_message({"kind": "snapshot", "state": {}}), [])

    def test_其它类型一律没有铃(self):
        self.assertEqual(rings_from_message({"kind": "ping", "ts": 1}), [])
        self.assertEqual(rings_from_message({"kind": "hover", "inside": False}), [])


class 提机那一下才放本地那一句(unittest.TestCase):
    """接线(room_link.send_call):**只有待机提机拨出去的那一通**本地先问一句。

    来电接起(`answer`)不放 —— 那一通的开场白是工人的 `ringOpener`,
    本地这句插在前面就是两句话打架。放下听筒(`hangup`)当场掐掉,
    不然下一通提机会先听见上一通的尾巴。

    整段跑在一个协程里:`RoomLink.__init__` 自己建 `asyncio.Event`,
    3.9 上没有事件循环就建不出来。
    """

    @staticmethod
    def _make(pcm: bytes):
        """一条假的房间连接 + 它发出去的那几条消息。"""
        import filler
        import room_link

        link = room_link.RoomLink(None, "Phone", log=lambda _line: None)
        # 不去碰 /var/lib:把那道闸直接换成一段认得出来的 PCM。
        link._greeting = filler.GreetingGate(pcm, frame_bytes=room_link.FRAME_BYTES)

        sent = []

        class _Participant:
            async def send_text(self, text, topic=None, destination_identities=None):
                sent.append(text)

        class _Room:
            local_participant = _Participant()

        link._room = _Room()
        return link, sent

    def test_start放_answer不放_hangup掐掉(self):
        import asyncio
        import time

        import room_link

        quiet = bytes(room_link.FRAME_BYTES)

        async def go():
            pcm = b"\x10\x27" * (room_link.FRAME_BYTES // 2) * 4
            link, sent = self._make(pcm)

            await link.send_call("start", "")
            # ★ 当场就有声音:这一句的全部意义就是不等那一两秒。
            self.assertNotEqual(link._greeting.step(time.monotonic(), quiet), quiet)
            self.assertEqual(link._greeting.state, "playing")

            await link.send_call("hangup", "")
            self.assertEqual(link._greeting.state, "idle")

            await link.send_call("answer", "call-1")
            self.assertEqual(link._greeting.state, "idle")   # 来电接起不放本地这句

            self.assertEqual(len(sent), 3)                   # 三条消息一条都没少发

        asyncio.run(go())

    def test_没装wav时提机也不出事(self):
        import asyncio

        async def go():
            link, sent = self._make(b"")
            await link.send_call("start", "")
            self.assertEqual(link._greeting.state, "idle")
            self.assertEqual(len(sent), 1)

        asyncio.run(go())


if __name__ == "__main__":
    unittest.main()
