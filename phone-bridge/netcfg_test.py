"""`netcfg.py` 的用例(2026-09-22 晚)。不需要派、不需要 livekit、不需要蓝牙。

    cd phone-bridge && python3 -m unittest discover -p "*_test.py"
"""
import json
import unittest

import netcfg
from netcfg import (
    ACTION_SCAN, ACTION_SWITCH, GIVE_UP, REPORT_OK, REPORT_ROLLED_BACK, ROLLBACK,
    ROLLBACK_VERIFY_SEC, SwitchWatch, VERIFY_SEC, WAIT, active_command, decode_ipc,
    encode_ipc, error_result, ipc_request, parse_active_wifi, parse_netcfg_request,
    rollback_plan, rolled_back_text, scan_result, switch_result, valid_ipc,
)

PHONE = "wb-phone-abc123"
WORKER = "wb-channel-worker"


def req(**fields) -> str:
    return json.dumps({"type": "netcfg", **fields}, ensure_ascii=False)


class 房间里那条请求(unittest.TestCase):
    def test_换网那条读得出来(self):
        got = parse_netcfg_request(req(id="r1", action="switch", ssid="VR_GUEST", psk="12345678"), PHONE)
        self.assertEqual(got, {"id": "r1", "action": "switch", "from": PHONE,
                               "ssid": "VR_GUEST", "psk": "12345678"})

    def test_扫一遍那条不要_ssid(self):
        got = parse_netcfg_request(req(id="r2", action="scan"), PHONE)
        self.assertEqual(got, {"id": "r2", "action": "scan", "from": PHONE})

    def test_开放网的空密码是合法的(self):
        """空密码和"没有密码这个字段"要分得开:前者是开放网,后者是一条残缺的请求。"""
        got = parse_netcfg_request(req(id="r3", action="switch", ssid="Guest", psk=""), PHONE)
        self.assertEqual(got["psk"], "")

    def test_不是手机发的一律不认(self):
        """★ 房里还有工人。它不该指挥派换网 —— 身份是签在凭证里的,自己改不了。"""
        self.assertEqual(parse_netcfg_request(req(id="r1", action="switch", ssid="X"), WORKER), {})

    def test_少一样就不认(self):
        for bad in (
            req(action="switch", ssid="X"),                 # 没 id
            req(id="r1", ssid="X"),                         # 没 action
            req(id="r1", action="reboot"),                  # 不认得的动作
            req(id="r1", action="switch"),                  # switch 没 ssid
            req(id="r1", action="switch", ssid=""),         # 空 ssid
            '{"id":"r1"',                                   # 半截 JSON
            "[]",                                           # 不是对象
            json.dumps({"type": "call", "id": "r1", "action": "scan"}),  # 是来电那条
        ):
            self.assertEqual(parse_netcfg_request(bad, PHONE), {}, bad)

    def test_工人那条_ring_落不到这里(self):
        """两条解析共用一条 topic。ring 走 signals.parse_room_signal,不该在这儿被认成别的。"""
        ring = json.dumps({"type": "ring", "call_id": "c1"})
        self.assertEqual(parse_netcfg_request(ring, WORKER), {})


class 回给手机的那几条(unittest.TestCase):
    def test_扫描结果带着列表(self):
        body = json.loads(scan_result("r1", [{"ssid": "VR_GUEST", "signal": 70}]))
        self.assertEqual(body["id"], "r1")
        self.assertEqual(body["action"], ACTION_SCAN)
        self.assertTrue(body["ok"])
        self.assertEqual(body["networks"][0]["ssid"], "VR_GUEST")

    def test_换网结果里一个秘密都没有(self):
        """★ 这条经服务器走一趟。密码、令牌一个字都不许在里头。"""
        raw = switch_result("r1", True, ssid="VR_GUEST", ip="192.168.1.20")
        self.assertNotIn("psk", raw)
        self.assertNotIn("password", raw)
        self.assertNotIn("token", raw)
        body = json.loads(raw)
        self.assertEqual(set(body), {"id", "type", "action", "ok", "code", "text",
                                     "ssid", "ip", "rolled_back"})

    def test_回滚过的那条要说清东西还在(self):
        body = json.loads(switch_result("r1", False, "verify_failed",
                                        rolled_back_text("VR_GUEST"), rolled_back=True))
        self.assertTrue(body["rolled_back"])
        self.assertIn("切回原来的网", body["text"])
        self.assertIn("VR_GUEST", body["text"])

    def test_办不了的那条如实说(self):
        body = json.loads(error_result("r1", ACTION_SWITCH, "座机上的配网服务没在跑"))
        self.assertFalse(body["ok"])
        self.assertEqual(body["code"], "unavailable")


class 切网这一趟的看守(unittest.TestCase):
    def start(self) -> SwitchWatch:
        watch = SwitchWatch()
        watch.begin("r1", PHONE, "VR_GUEST", "netplan-wlan0-Ben", now=0, join_seq=3)
        return watch

    def test_没开始的时候什么都不做(self):
        self.assertEqual(SwitchWatch().decide(now=999, join_seq=7), (WAIT, {}))

    def test_重新进房了才算成(self):
        """★ 判据是**又进了一次房**,不是"连接还在" ——
        切网必然断一次,连接还在只说明那一下还没生效。"""
        watch = self.start()
        self.assertEqual(watch.decide(now=5, join_seq=3)[0], WAIT)
        action, job = watch.decide(now=5, join_seq=4)
        self.assertEqual(action, REPORT_OK)
        self.assertEqual(job["id"], "r1")
        self.assertEqual(job["from"], PHONE)
        # 报完就不在等了
        self.assertFalse(watch.busy())

    def test_到点没回来就切回老网(self):
        watch = self.start()
        self.assertEqual(watch.decide(now=VERIFY_SEC - 1, join_seq=3)[0], WAIT)
        action, job = watch.decide(now=VERIFY_SEC, join_seq=3)
        self.assertEqual(action, ROLLBACK)
        self.assertEqual(job["previous"], "netplan-wlan0-Ben")
        # 回滚只发一次:下一秒还没回来也不再发
        self.assertEqual(watch.decide(now=VERIFY_SEC + 1, join_seq=3)[0], WAIT)

    def test_切回去之后回来了报的是没换成而不是成了(self):
        """最要紧的一条:回滚成功**不是**换网成功。报成了会让他以为现场的网配好了。"""
        watch = self.start()
        watch.decide(now=VERIFY_SEC, join_seq=3)
        action, job = watch.decide(now=VERIFY_SEC + 5, join_seq=4)
        self.assertEqual(action, REPORT_ROLLED_BACK)
        self.assertTrue(job["rolled_back"])

    def test_切回去也没回来就不再动手(self):
        """再切一次只会让它在两个连不上的网之间来回跳。交给 wifi 看门狗。"""
        watch = self.start()
        watch.decide(now=VERIFY_SEC, join_seq=3)
        action, _ = watch.decide(now=VERIFY_SEC + ROLLBACK_VERIFY_SEC, join_seq=3)
        self.assertEqual(action, GIVE_UP)
        self.assertFalse(watch.busy())

    def test_同一时刻只跑一趟(self):
        watch = self.start()
        self.assertTrue(watch.busy())
        watch.cancel()
        self.assertFalse(watch.busy())


class root那半边的IPC(unittest.TestCase):
    def test_一条一行且拼得回来(self):
        raw = encode_ipc(ipc_request("switch", ssid="VR_GUEST", psk="12345678"))
        self.assertTrue(raw.endswith(b"\n"))
        self.assertEqual(decode_ipc(raw)["ssid"], "VR_GUEST")

    def test_读不懂回空(self):
        for bad in (b"", b"\n", b"{", b"[]", b"\xff\xfe"):
            self.assertEqual(decode_ipc(bad), {}, bad)

    def test_root那边先过一道校验(self):
        """同一台机器上任何能读到那个 socket 的进程都写得进来。"""
        self.assertTrue(valid_ipc({"op": "scan"}))
        self.assertTrue(valid_ipc({"op": "current"}))
        # 2026-09-30:进房那一半报在不在房里 —— 只认真的布尔值
        self.assertTrue(valid_ipc({"op": "room", "in_room": True}))
        self.assertTrue(valid_ipc({"op": "room", "in_room": False}))
        self.assertFalse(valid_ipc({"op": "room", "in_room": "yes"}))
        self.assertFalse(valid_ipc({"op": "room"}))
        self.assertTrue(valid_ipc({"op": "switch", "ssid": "X", "psk": ""}))
        self.assertTrue(valid_ipc({"op": "rollback", "name": "netplan-wlan0-Ben"}))
        for bad in ({}, {"op": "rm"}, {"op": "switch"}, {"op": "switch", "ssid": ""},
                    {"op": "rollback"}, {"op": "rollback", "name": ""}, "scan"):
            self.assertFalse(valid_ipc(bad), bad)

    def test_密码在日志里是星号(self):
        line = netcfg.redact(ipc_request("switch", ssid="VR_GUEST", psk="12345678"))
        self.assertEqual(line["psk"], "***")
        self.assertEqual(line["ssid"], "VR_GUEST")


class 回滚要按连接名(unittest.TestCase):
    ACTIVE = (
        "netplan-wlan0-Ben:wlan0:802-11-wireless\n"
        "Wired connection 1:usb0:802-3-ethernet\n"
        "lo:lo:loopback\n"
    )

    def test_认出这块网卡上那条无线连接的名字(self):
        self.assertEqual(parse_active_wifi(self.ACTIVE, "wlan0"), "netplan-wlan0-Ben")

    def test_没有无线连接时回空串(self):
        self.assertEqual(parse_active_wifi("lo:lo:loopback\n", "wlan0"), "")

    def test_连接名里的冒号是转义过的(self):
        line = "office\\:guest:wlan0:802-11-wireless\n"
        self.assertEqual(parse_active_wifi(line, "wlan0"), "office:guest")

    def test_回滚用的是名字不是_ssid(self):
        """★ netplan 生成的连接叫 `netplan-wlan0-Ben`,拿 SSID 去 up 会「找不到这条连接」。"""
        argv = rollback_plan("netplan-wlan0-Ben")
        self.assertIn("connection", argv)
        self.assertIn("up", argv)
        self.assertIn("netplan-wlan0-Ben", argv)
        self.assertIn("ifname", argv)

    def test_问一句现在连的是哪条(self):
        self.assertEqual(active_command()[:2], ["nmcli", "-t"])
        self.assertIn("--active", active_command())


class 两条路共用同一份解析(unittest.TestCase):
    def test_扫描结果的形状与蓝牙那条逐字相同(self):
        """★ 手机端两条流程共用同一个 HandsetNetwork 与同一份排序。
        这里多出一个字段、少一个字段,换网那条的列表就画不出来。"""
        nets = netcfg.parse_wifi_list("VR_GUEST:70:WPA2:*\nBen:40:WPA2:\n", ("Ben",))
        self.assertEqual(set(nets[0]), {"ssid", "signal", "security", "in_use", "saved"})
        self.assertEqual(nets[0]["ssid"], "VR_GUEST")
        self.assertTrue(nets[1]["saved"])

    def test_连不上的判法也是同一份(self):
        ok, code, _ = netcfg.classify_connect(4, "Error: Secrets were required")
        self.assertFalse(ok)
        self.assertEqual(code, "bad_password")
        self.assertIn("密码不对", netcfg.fail_text(code))


if __name__ == "__main__":
    unittest.main()
