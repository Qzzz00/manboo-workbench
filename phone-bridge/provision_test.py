"""座机配网的纯逻辑测试(2026-09-22)。

**一行蓝牙都不碰、一次 subprocess 都不起**:这一份要能在一台没有 bluez、没有
NetworkManager 的 Mac 上跑完。真机上那一半在 `provisiond.py`,它没有单测,
手工验证步骤写在 docs/交接-0922-座机配网走App.md 第六节。

钉住的是四件会静默坏掉的事:
  1. 时限(开机 60 秒才广播、连上之后再开 60 秒、掉网 60 秒才重新开门);
  2. nmcli terse 输出的切分(SSID 里有冒号/反斜杠时);
  3. 分帧编解码(MTU 只有 20 字节那一档);
  4. 密码与令牌**不出现在日志里**。
"""
import json
import unittest

from provision import (
    BOOTING, CONNECTING, GRACE_AFTER_ONLINE_SEC, LINKING, ONLINE, QUIET, SCANNING,
    WAIT_BEFORE_ADVERTISE_SEC, WAITING,
    FrameAssembler, Provision, classify_connect, command_event, connect_done_event,
    connect_plan, decode_command, device_id_of, device_name, encode_frames, fail_text,
    link_done_event, link_patch, name_suffix, parse_device_state, parse_ip, parse_saved,
    parse_wifi_list, redact, restart_bridge_command, scan_done_event, status_payload,
    tick_event, transition, wifi_event,
)


def run(state, events):
    """把一串事件喂进去,回 (末状态, 所有动作)。"""
    actions = []
    for event in events:
        state, got = transition(state, event)
        actions.extend(got)
    return state, actions


class 开机那一分钟(unittest.TestCase):
    def test_开机就有网也先开一分钟_进了房到点就关(self):
        """最常见的那条路:派早就记得家里的 Wi-Fi。2026-09-30 起开机先开蓝牙一分钟
        (维护者:网在、房进不去时,蓝牙是唯一的门);进了房、到点、没人在用 → 关。"""
        state, actions = run(Provision(since=0), [wifi_event(5, True, "VR_GUEST", "10.0.0.9"), room_event(20, True)])
        self.assertTrue(state.advertising)
        self.assertEqual(state.ssid, "VR_GUEST")
        state, actions = run(state, [room_event(40, True), tick_event(WAIT_BEFORE_ADVERTISE_SEC)])
        self.assertEqual(state.phase, QUIET)
        self.assertFalse(state.advertising)
        self.assertIn(("advertise", False), actions)

    def test_开机就有网但没绑账号_照样广播等人来添加(self):
        """2026-09-27(统筹,维护者:「座机的匹配也初始化,到时候改成跟着那台设备走」)。
        派记得访客网,开机就连上;可它的账号绑定被挪走了(device.json 里没有中转令牌)——
        这时候不广播,手机「添加座机」就永远找不到它。没绑账号 = 等人来添加,有网也开广播,
        而且不设收尾窗口(直到交下令牌为止)。"""
        state, actions = run(Provision(since=0, unbound=True), [wifi_event(5, True, "VR_GUEST", "10.0.0.9")])
        self.assertTrue(state.advertising)
        self.assertEqual(state.ssid, "VR_GUEST")
        self.assertIn(("advertise", True), actions)
        self.assertIsNone(state.grace_until)
        # 交下令牌之后进收尾窗口,到点(而且进了房)停广播。
        state, _ = transition(state, {"kind": "link_done", "now": 100, "ok": True})
        self.assertTrue(state.linked)
        self.assertIsNotNone(state.grace_until)
        state, actions = run(state, [room_event(state.grace_until, True), tick_event(state.grace_until)])
        self.assertFalse(state.advertising)
        self.assertIn(("advertise", False), actions)

    def test_没网开机就开蓝牙_一分钟后进待配网_一直开着(self):
        """2026-09-30 起不再等 60 秒才开:开机就开(那一分钟本来就开着)。"""
        state = Provision(since=0)
        state, actions = transition(state, tick_event(0))
        self.assertTrue(state.advertising)
        self.assertIn(("advertise", True), actions)
        state, actions = transition(state, tick_event(WAIT_BEFORE_ADVERTISE_SEC - 1))
        self.assertEqual(state.phase, BOOTING)
        self.assertEqual([a for a in actions if a[0] == "advertise"], [], "已经开着就不再发一次")

        state, actions = transition(state, tick_event(WAIT_BEFORE_ADVERTISE_SEC))
        self.assertEqual(state.phase, WAITING)
        self.assertTrue(state.advertising)

    def test_待配网那句话说的是下一步做什么(self):
        state, _ = transition(Provision(since=0), tick_event(WAIT_BEFORE_ADVERTISE_SEC))
        self.assertIn("等你告诉它连哪个", state.text)


class 配网这一趟(unittest.TestCase):
    def waiting(self, now=100):
        state, _ = run(Provision(since=0), [tick_event(WAIT_BEFORE_ADVERTISE_SEC)])
        return state

    def test_扫一遍再把列表推回去(self):
        state = self.waiting()
        state, actions = transition(state, command_event(200, {"op": "scan"}))
        self.assertEqual(state.phase, SCANNING)
        self.assertIn(("scan",), actions)

        nets = [{"ssid": "VR_GUEST", "signal": 70, "security": "WPA2", "in_use": False, "saved": False}]
        state, actions = transition(state, scan_done_event(205, nets))
        self.assertEqual(state.phase, WAITING)  # 还没连上,回到待配网
        self.assertEqual([a for a in actions if a[0] == "notify_networks"], [("notify_networks", nets)])

    def test_连上了就进收尾窗口并且六十秒后停广播(self):
        state = self.waiting()
        state, actions = transition(state, command_event(200, {"op": "connect", "ssid": "VR_GUEST", "psk": "开门芝麻"}))
        self.assertEqual(state.phase, CONNECTING)
        self.assertIn(("connect", "VR_GUEST", "开门芝麻"), actions)
        # **还没连上就不算连着**:ssid 要等 connect_done 才落。
        self.assertIsNone(state.ssid)

        state, _ = transition(state, connect_done_event(210, True, ssid="VR_GUEST"))
        self.assertEqual(state.phase, ONLINE)
        self.assertEqual(state.ssid, "VR_GUEST")
        self.assertTrue(state.advertising)
        self.assertEqual(state.grace_until, 210 + GRACE_AFTER_ONLINE_SEC)

        state, actions = run(state, [room_event(230, True), tick_event(210 + GRACE_AFTER_ONLINE_SEC - 1)])
        self.assertTrue(state.advertising)
        state, actions = run(state, [room_event(260, True), tick_event(210 + GRACE_AFTER_ONLINE_SEC)])
        self.assertEqual(state.phase, QUIET)
        self.assertFalse(state.advertising)
        self.assertIn(("advertise", False), actions)

    def test_人还在操作就把收尾窗口往后推(self):
        """最容易得罪人的一个 bug:他正在输令牌,门在他手底下关了。"""
        state = self.waiting()
        state, _ = transition(state, command_event(200, {"op": "connect", "ssid": "W", "psk": "x"}))
        state, _ = transition(state, connect_done_event(210, True, ssid="W"))
        state, _ = transition(state, command_event(250, {"op": "status"}))
        self.assertEqual(state.grace_until, 250 + GRACE_AFTER_ONLINE_SEC)

    def test_密码错回到待配网并且说的是人话(self):
        state = self.waiting()
        state, _ = transition(state, command_event(200, {"op": "connect", "ssid": "W", "psk": "错的"}))
        state, actions = transition(state, connect_done_event(
            240, False, code="bad_password", text="Secrets were required, but not provided"))
        self.assertEqual(state.phase, WAITING)
        self.assertEqual(state.error, "bad_password")
        self.assertIn("密码不对", state.text)
        self.assertTrue(state.advertising, "失败之后得让他还能再试一次")
        self.assertIn(("notify_status",), actions)

    def test_正在连的时候不听_NM_的旁白(self):
        """连的过程中 NM 会报一路 `online=False`。听它的话会把相位打回待配网,
        于是界面上那根进度条跳回起点,而 nmcli 其实还在跑。"""
        state = self.waiting()
        state, _ = transition(state, command_event(200, {"op": "connect", "ssid": "W", "psk": "x"}))
        state, actions = transition(state, wifi_event(205, False))
        self.assertEqual(state.phase, CONNECTING)
        self.assertEqual(actions, [])

    def test_待配网期间自己连上了也算连上(self):
        """派上那条 wifi 看门狗每 20 秒轮流硬连存过的网。它成功的时候
        配网服务要跟着改口,不然手机上一直写着「还没连上」。"""
        state = self.waiting()
        state, _ = transition(state, wifi_event(300, True, "Ben", "172.20.10.4"))
        self.assertEqual(state.phase, ONLINE)
        self.assertEqual(state.grace_until, 300 + GRACE_AFTER_ONLINE_SEC)


class 交令牌(unittest.TestCase):
    def online(self):
        state, _ = run(Provision(since=0), [
            tick_event(WAIT_BEFORE_ADVERTISE_SEC),
            command_event(200, {"op": "connect", "ssid": "W", "psk": "x"}),
            connect_done_event(210, True, ssid="W"),
        ])
        return state

    def test_连上之后才收令牌(self):
        state = self.online()
        cmd = {"op": "link", "relay": "https://api.aibooo.cn/", "token": "wb_secret"}
        state, actions = transition(state, command_event(220, cmd))
        self.assertEqual(state.phase, LINKING)
        self.assertEqual([a[0] for a in actions if a[0] == "link"], ["link"])

        state, _ = transition(state, link_done_event(225, True))
        self.assertTrue(state.linked)
        self.assertEqual(state.text, "座机已上线")

    def test_没连上_Wi_Fi_就不收令牌(self):
        state, _ = run(Provision(since=0), [tick_event(WAIT_BEFORE_ADVERTISE_SEC)])
        state, actions = transition(state, command_event(220, {
            "op": "link", "relay": "https://r", "token": "wb_x"}))
        self.assertEqual(state.error, "offline")
        self.assertEqual([a for a in actions if a[0] == "link"], [])

    def test_停了广播之后不再听指挥(self):
        """BLE 连接可能比广播活得久。门关了就不该再有人从里面指挥它。"""
        state = self.online()
        state, _ = run(state, [room_event(260, True), tick_event(210 + GRACE_AFTER_ONLINE_SEC)])
        state, actions = run(state, [room_event(390, True), command_event(400, {"op": "connect", "ssid": "别的", "psk": "y"})])
        self.assertEqual(state.phase, QUIET)
        self.assertEqual([a for a in actions if a[0] == "connect"], [])

    def test_link_少一样就不动_device_json(self):
        self.assertIsNone(link_patch({"op": "link", "token": "wb_x"}, "handset-1"))
        self.assertIsNone(link_patch({"op": "link", "relay": "https://r"}, "handset-1"))
        self.assertIsNone(link_patch({"op": "link", "relay": "", "token": "wb_x"}, "handset-1"))

    def test_link_补齐的那几个字段(self):
        patch = link_patch({"op": "link", "relay": "https://api.aibooo.cn/", "token": "wb_x"}, "handset-abc")
        self.assertEqual(patch, {"relay_token": "wb_x", "relay": "https://api.aibooo.cn",
                                 "device_id": "handset-abc"})

    def test_重启_phone_bridge_是从_root_跨到用户总线(self):
        argv = restart_bridge_command("ben", 1000)
        self.assertEqual(argv[:3], ["runuser", "-u", "ben"])
        self.assertIn("XDG_RUNTIME_DIR=/run/user/1000", argv)
        self.assertEqual(argv[-4:], ["systemctl", "--user", "restart", "phone-bridge"])


class 掉网之后(unittest.TestCase):
    def test_掉网满六十秒才重新开门(self):
        state, _ = run(Provision(since=0), [wifi_event(5, True, "VR_GUEST", "10.0.0.9"), room_event(10, True)])
        state, _ = transition(state, wifi_event(100, False))
        self.assertEqual(state.phase, QUIET)
        self.assertIsNone(state.ssid)

        state, actions = transition(state, tick_event(159))
        self.assertFalse(state.advertising)
        state, actions = transition(state, tick_event(160))
        self.assertEqual(state.phase, WAITING)
        self.assertIn(("advertise", True), actions)

    def test_抖一下就回来的不开门(self):
        state, _ = run(Provision(since=0), [wifi_event(5, True, "VR_GUEST", "10.0.0.9"), room_event(10, True)])
        state, _ = transition(state, wifi_event(100, False))
        state, _ = run(state, [wifi_event(110, True, "VR_GUEST", "10.0.0.9"), room_event(115, True)])
        state, actions = run(state, [room_event(190, True), tick_event(200)])
        self.assertFalse(state.advertising)


class nmcli的输出(unittest.TestCase):
    def test_terse_里的冒号是转义过的(self):
        """SSID 叫 `Ben:5G` 的时候,按 `:` 硬切会切出两段,于是列表里多一个叫 `Ben` 的网,
        点了永远连不上。"""
        got = parse_wifi_list("Ben\\:5G:70:WPA2:*\n")
        self.assertEqual(got[0]["ssid"], "Ben:5G")
        self.assertTrue(got[0]["in_use"])

    def test_同名两个_AP_只留一行(self):
        got = parse_wifi_list("VR_GUEST:40:WPA2:\nVR_GUEST:80:WPA2:\n")
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["signal"], 80)

    def test_没名字的隐藏网丢掉(self):
        got = parse_wifi_list(":55:WPA2:\nVR_GUEST:40:WPA2:\n")
        self.assertEqual([n["ssid"] for n in got], ["VR_GUEST"])

    def test_当前连着的排最前_其余按信号(self):
        got = parse_wifi_list("A:90:WPA2:\nB:30:WPA2:*\nC:60::\n")
        self.assertEqual([n["ssid"] for n in got], ["B", "A", "C"])
        self.assertEqual(got[2]["security"], "", "开放网的 security 是空串")

    def test_存过的网标出来(self):
        got = parse_wifi_list("VR_GUEST:40:WPA2:\n", saved=("VR_GUEST",))
        self.assertTrue(got[0]["saved"])

    def test_存过的网从_connection_show_里认(self):
        self.assertEqual(
            parse_saved("VR_GUEST:802-11-wireless\nWired connection 1:802-3-ethernet\nBen:wifi\n"),
            ("VR_GUEST", "Ben"))

    def test_网卡不在和没连上是两件事(self):
        text = "wlan0:wifi:connected:VR_GUEST\nlo:loopback:unmanaged:--\n"
        self.assertEqual(parse_device_state(text), {"present": True, "online": True, "ssid": "VR_GUEST"})
        text2 = "wlan0:wifi:disconnected:--\n"
        self.assertEqual(parse_device_state(text2), {"present": True, "online": False, "ssid": ""})
        self.assertEqual(parse_device_state("lo:loopback:unmanaged:--\n"),
                         {"present": False, "online": False, "ssid": ""})

    def test_地址只取第一个不带掩码(self):
        self.assertEqual(parse_ip("lo   UNKNOWN 127.0.0.1/8\nwlan0 UP 10.86.37.27/24\n"), "10.86.37.27")
        self.assertEqual(parse_ip("lo   UNKNOWN 127.0.0.1/8\n"), "")


class 连不上的几种(unittest.TestCase):
    def test_成了(self):
        ok, code, said = classify_connect(0, "Device 'wlan0' successfully activated with '1a-2b'.")
        self.assertTrue(ok)
        self.assertEqual(code, "")

    def test_密码错(self):
        ok, code, _ = classify_connect(4, "Error: Connection activation failed: Secrets were required, but not provided.")
        self.assertFalse(ok)
        self.assertEqual(code, "bad_password")
        self.assertIn("密码不对", fail_text(code))

    def test_找不到这个网(self):
        ok, code, _ = classify_connect(10, "Error: No network with SSID 'VR_GUEST' found.")
        self.assertEqual(code, "not_found")
        self.assertIn("2.4G", fail_text(code))

    def test_超时(self):
        ok, code, _ = classify_connect(1, "Error: Timeout expired (45 seconds)")
        self.assertEqual(code, "timeout")

    def test_回了零但没说_activated_不算成(self):
        """NM 有过"排上队了"就回 0 的行为。当成成了,界面会说「连上了」而其实没有。"""
        ok, code, _ = classify_connect(0, "")
        self.assertFalse(ok)
        self.assertEqual(code, "timeout")

    def test_认不得的码原样带上_nmcli_那句(self):
        ok, code, said = classify_connect(9, "Error: 某种我们没见过的毛病")
        self.assertEqual(code, "failed")
        self.assertEqual(fail_text(code, said), "Error: 某种我们没见过的毛病")

    def test_密码不进_argv(self):
        argv, stdin = connect_plan("VR_GUEST", "开门芝麻")
        self.assertNotIn("开门芝麻", " ".join(argv))
        self.assertIn("--ask", argv)
        self.assertEqual(stdin, "开门芝麻\n")

    def test_开放网不带_ask(self):
        """带了 --ask 连一个不要密码的网会一直等那个永远不来的回答。"""
        argv, stdin = connect_plan("免费WiFi", "")
        self.assertNotIn("--ask", argv)
        self.assertIsNone(stdin)


class 分帧(unittest.TestCase):
    def test_二十字节那一档也拼得回来(self):
        payload = {"phase": "waiting", "text": "座机还没连上 Wi-Fi,等你告诉它连哪个"}
        frames = encode_frames(payload, mtu=23)
        self.assertGreater(len(frames), 1, "这条中文消息在 20 字节里装不下")
        for frame in frames:
            self.assertLessEqual(len(frame), 20)
        # 拼回来:注意这里走的是 decode_command,它要求有 op,所以用一条真命令再验一遍。
        cmd = {"op": "connect", "ssid": "VR_GUEST", "psk": "开门芝麻芝麻开门"}
        box = FrameAssembler()
        got = [box.feed(f) for f in encode_frames(cmd, mtu=23)]
        self.assertEqual(got[-1], cmd)
        self.assertTrue(all(g is None for g in got[:-1]))

    def test_一条装得下的时候只有一帧(self):
        frames = encode_frames({"op": "scan"}, mtu=185)
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0][0], 0x00)

    def test_乱字节不崩也不留残渣(self):
        box = FrameAssembler()
        self.assertIsNone(box.feed(b"\x7f" + "乱七八糟".encode("utf-8")))
        self.assertEqual(box.feed(b"\x00" + json.dumps({"op": "scan"}).encode()), {"op": "scan"})

    def test_写了一串半截就走了会被扔掉(self):
        box = FrameAssembler()
        for _ in range(600):
            box.feed(b"\x01" + b"x" * 20)
        self.assertIsNone(box.feed(b"\x00"))

    def test_不是对象或者没有_op_一律不认(self):
        for raw in (b"[]", b"null", b"3", b'{"ssid":"x"}', b"\xff\xfe", b""):
            self.assertIsNone(decode_command(raw))


class 秘密不进日志(unittest.TestCase):
    def test_密码与令牌都打星号(self):
        got = redact({"op": "connect", "ssid": "VR_GUEST", "psk": "开门芝麻"})
        self.assertEqual(got, {"op": "connect", "ssid": "VR_GUEST", "psk": "***"})
        got = redact({"op": "link", "relay": "https://r", "token": "wb_x"})
        self.assertEqual(got["token"], "***")

    def test_状态里一个秘密都没有(self):
        """这一条会经 BLE 明文走一趟 —— 这条链路没有配对加密。"""
        payload = status_payload(Provision(phase=ONLINE, ssid="VR_GUEST", text="连上了"),
                                 device_id="handset-abc", name="工作台座机-7C10")
        self.assertEqual(set(payload), {"phase", "text", "ssid", "ip", "error",
                                        "linked", "device_id", "name"})
        for key in ("psk", "password", "token", "relay_token"):
            self.assertNotIn(key, payload)


class 名字与身份(unittest.TestCase):
    def test_广播名取_machine_id_末四位(self):
        self.assertEqual(device_name("3f2a7c91b04d4e0f8a11c5d27e6b9a4c"), "工作台座机-9A4C")
        self.assertEqual(name_suffix(""), "0000")

    def test_设备_id_从_machine_id_推而不是新生成一个(self):
        """新生成的那个要落盘,而落盘的文件会被重烧卡、被 deploy.sh 覆盖 ——
        于是同一台派在「我的设备」里变成好几台。"""
        one = device_id_of("3f2a7c91b04d4e0f8a11c5d27e6b9a4c")
        self.assertEqual(one, "handset-3f2a7c91b04d4e0f")
        self.assertEqual(device_id_of("3f2a7c91b04d4e0f8a11c5d27e6b9a4c"), one)
        # 只留 phoneIdentityOf 认得的字符集。
        self.assertRegex(one, r"^[A-Za-z0-9_-]+$")


if __name__ == "__main__":
    unittest.main()


# ———————————————————————— 2026-09-30:蓝牙什么时候开(维护者三条) ————————————————————————
#
# 死锁现场:座机连着一个「连得上、却进不了房」的网(钥匙被撤、或者网上不去外网),
# 于是按老规矩(只看有没有网)它安安静静不广播;手机「添加座机」扫不到,房间那条路又进不去 ——
# 两条路都断,只能拔卡。维护者定的三条:
#   1. 开机之后**不管有没有网**先开蓝牙一分钟;这一分钟里有手机连进来(发过命令)就不关;
#   2. 连不上 Wi-Fi **或者进不了房**,蓝牙一直开着;
#   3. 只有「连着网 + 在房里 + 没人在用蓝牙 + 开机那一分钟过了」才关。

from provision import BOOT_ADVERTISE_SEC, ROOM_STALE_SEC, TROUBLE_BEFORE_ADVERTISE_SEC, room_event


class 蓝牙什么时候开(unittest.TestCase):
    def test_开机不管有没有网先开蓝牙一分钟_在房里了才关(self):
        state, actions = run(Provision(since=0), [tick_event(0), wifi_event(5, True, "VR_GUEST", "10.0.0.9"), room_event(20, True)])
        self.assertTrue(state.advertising, "开机那一分钟里,有网、进了房也先开着")
        self.assertIn(("advertise", True), actions)
        state, actions = transition(state, tick_event(BOOT_ADVERTISE_SEC - 1))
        self.assertTrue(state.advertising)
        state, actions = run(state, [room_event(BOOT_ADVERTISE_SEC, True), tick_event(BOOT_ADVERTISE_SEC)])
        self.assertFalse(state.advertising)
        self.assertEqual(state.phase, QUIET)
        self.assertIn(("advertise", False), actions)

    def test_开机那一分钟里有手机连进来_就不关(self):
        state, _ = run(Provision(since=0), [tick_event(0), wifi_event(5, True, "W", "10.0.0.9"), room_event(10, True)])
        state, _ = transition(state, command_event(50, {"op": "status"}))
        state, _ = run(state, [room_event(BOOT_ADVERTISE_SEC + 5, True), tick_event(BOOT_ADVERTISE_SEC + 5)])
        self.assertTrue(state.advertising, "他正在用手机配它,门不能在他手底下关上")

    def test_有网但进不了房_蓝牙一直开着(self):
        """这一次的死锁:连着网,钥匙被撤,进不了房。"""
        state, _ = run(Provision(since=0), [tick_event(0), wifi_event(5, True, "W", "10.0.0.9")])
        for now in (BOOT_ADVERTISE_SEC, 600, 3600, 86400):
            state, _ = run(state, [room_event(now, False), tick_event(now)])
            self.assertTrue(state.advertising, f"第 {now} 秒还进不了房,蓝牙得开着")

    def test_进房的消息断了太久_当成不在房里(self):
        """进房那一半(popphone)挂了、不报了:不能一直当它还在房里。"""
        state, _ = run(Provision(since=0), [tick_event(0), wifi_event(5, True, "W", "10.0.0.9"), room_event(10, True),
                                           room_event(BOOT_ADVERTISE_SEC, True), tick_event(BOOT_ADVERTISE_SEC)])
        self.assertFalse(state.advertising)
        late = BOOT_ADVERTISE_SEC + ROOM_STALE_SEC + TROUBLE_BEFORE_ADVERTISE_SEC + 1
        state, actions = transition(state, tick_event(late))
        self.assertTrue(state.advertising)
        self.assertIn(("advertise", True), actions)

    def test_在房里掉线一小会儿不开_掉满一分钟才开(self):
        state, _ = run(Provision(since=0), [tick_event(0), wifi_event(5, True, "W", "10.0.0.9"), room_event(10, True),
                                           room_event(BOOT_ADVERTISE_SEC, True), tick_event(BOOT_ADVERTISE_SEC)])
        t = BOOT_ADVERTISE_SEC + 10
        state, _ = run(state, [room_event(t, False), tick_event(t + TROUBLE_BEFORE_ADVERTISE_SEC - 1)])
        self.assertFalse(state.advertising, "一次重连不该就开门")
        state, actions = transition(state, tick_event(t + TROUBLE_BEFORE_ADVERTISE_SEC))
        self.assertTrue(state.advertising)
        # 又进房了 → 关(没人在用蓝牙)
        state, actions = run(state, [room_event(t + 200, True), tick_event(t + 200)])
        self.assertFalse(state.advertising)
        self.assertIn(("advertise", False), actions)

    def test_连不上网_开机那一分钟过了也一直开着(self):
        state, _ = run(Provision(since=0), [tick_event(0)])
        self.assertTrue(state.advertising)
        state, _ = transition(state, tick_event(BOOT_ADVERTISE_SEC * 10))
        self.assertTrue(state.advertising)
        self.assertEqual(state.phase, WAITING)
