"""局域网主路 M2(2026-10-21):8791 的票与状态多了几格(`route`、局域网地址、`mode: lan`)。

听筒今天只需「不被新字段弄坏」—— 接连接规格是卡 M5 的事。这一份按相对路径读 8791 那边的字段表
(`workbench-plugin/src/server/channelWire.cases.json`,接缝主人是统筹;工人与手机读同一份,**不抄一份**),
把样例喂给听筒自己的解析。顺带钉一条:同一位拿到的票与它问到的状态是**同一个地址、同一间房** ——
`room_moved` 拿两者比,8791 两处按来路给得不一样的话,听筒每次重连都会白换一张票。
"""
import json
import os
import unittest

from pairing import room_moved, room_of_status, ticket_of

WIRE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "workbench-plugin", "src", "server", "channelWire.cases.json")


def examples() -> dict:
    with open(WIRE, encoding="utf-8") as handle:
        return json.load(handle)["examples"]


class ChannelWireTest(unittest.TestCase):
    def test_局域网那张票照旧解析_多出来的格子不碍事(self):
        ex = examples()
        ticket = ticket_of(ex["token_lan"])
        self.assertEqual(ticket["url"], ex["token_lan"]["url"])
        self.assertEqual(ticket["room"], ex["token_lan"]["room"])
        self.assertEqual(ticket["expires_at"], ex["token_lan"]["expires_at"])
        self.assertEqual(ticket_of(ex["token_relay"])["url"], ex["token_relay"]["url"])

    def test_状态_mode_lan_照旧掏得出房间与地址(self):
        ex = examples()
        self.assertEqual(room_of_status(ex["status_lan"]), {"room": ex["status_lan"]["room"], "url": ex["status_lan"]["url"]})

    def test_同一位的票与状态是同一间房_不白换票(self):
        ex = examples()
        self.assertFalse(room_moved(ticket_of(ex["token_lan"]), room_of_status(ex["status_lan"])))


if __name__ == "__main__":
    unittest.main()
