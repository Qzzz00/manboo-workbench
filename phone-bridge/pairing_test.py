"""配对与领凭证的测试。HTTP 那一层用假的 post 注入,不发一个真包。"""
import json
import os
import tempfile
import unittest

import provision
from pairing import (
    DEVICE_ID_ATTRIBUTE, KIND_ATTRIBUTE, KIND_HANDSET, PLATFORM_HANDSET, RENEW_BEFORE_SEC,
    RELAY_DEVICE_KIND, RELAY_TOKEN_DEAD_CODE, ROOM_NOW_PATH, HttpRefused,
    _error_said, acquire_ticket, ask_room_now, cleared_relay_state, http_base_of, identity_of,
    load_state, pair, relay_login, relay_token_dead, room_moved, room_of_status, room_ticket_lan,
    room_ticket_relay, save_state, ticket_of, ticket_usable,
)


def fake_post(routes: dict, seen: list = None):
    """按 URL 尾巴回一份假回包;没配的路由抛 RuntimeError(=那条路不通)。"""
    def post(url, body, token="", timeout=10):
        if seen is not None:
            seen.append((url, body, token))
        for tail, value in routes.items():
            if url.endswith(tail):
                if isinstance(value, Exception):
                    raise value
                return value
        raise RuntimeError(f"没打通 {url}")
    return post


def fake_get(routes: dict, seen: list = None):
    """同上,GET 那一边(问「现在该进哪个房」用的)。没配的路由 = Mac 关着 / 够不到。"""
    def get(url, token="", timeout=5):
        if seen is not None:
            seen.append((url, token))
        for tail, value in routes.items():
            if url.endswith(tail):
                if isinstance(value, Exception):
                    raise value
                return value
        raise RuntimeError(f"没打通 {url}")
    return get


#: `/channel/status` 真回过的那几格(workbench-plugin/src/server/channel.ts 的 `status()`)。
#: 这里只用到 `configured` / `url` / `room` 三格,别的原样摆着免得用例看起来比真回包干净。
def status_body(room: str, url: str = "ws://lk:7880", configured: bool = True) -> dict:
    return {"configured": configured, "url": url, "room": room, "mode": "local",
            "token_ttl_seconds": 604800, "source": "local",
            "server": {"reachable": True}, "worker": {"in_room": True}}


class 地址换算(unittest.TestCase):
    def test_ws_换成_http(self):
        self.assertEqual(http_base_of("ws://MacBook-Air-3.local:8791"),
                         "http://MacBook-Air-3.local:8791")

    def test_wss_换成_https(self):
        self.assertEqual(http_base_of("wss://x.example:443"), "https://x.example:443")

    def test_本来就是_http_的原样(self):
        self.assertEqual(http_base_of("http://a:1"), "http://a:1")


class 配对(unittest.TestCase):
    def test_拿码换令牌并报上_handset_这个平台(self):
        """★ 平台报 `handset` 是电脑端能把它显示成「话筒」、工人能把它当音频端点的**唯一**依据。"""
        seen = []
        got = pair("http://wb:8791", "123456",
                   post=fake_post({"/pair/claim": {"ok": True, "device_id": "d1", "token": "tok"}}, seen))
        self.assertEqual(got["device_id"], "d1")
        self.assertEqual(got["token"], "tok")
        self.assertEqual(got["workbench_http"], "http://wb:8791")
        url, body, _ = seen[0]
        self.assertEqual(body["platform"], PLATFORM_HANDSET)
        self.assertEqual(body["code"], "123456")

    def test_回包里没有令牌就算失败(self):
        with self.assertRaises(RuntimeError):
            pair("http://wb:8791", "123456", post=fake_post({"/pair/claim": {"ok": True}}))


class 凭证(unittest.TestCase):
    def test_四样齐了才算一张(self):
        self.assertEqual(ticket_of({"url": "ws://lk", "room": "workbench",
                                    "identity": "wb-phone-d1", "token": "t", "expires_at": 9}),
                         {"url": "ws://lk", "room": "workbench",
                          "identity": "wb-phone-d1", "token": "t", "expires_at": 9})

    def test_缺一样就整张不算(self):
        """半张凭证会让派一直重试一个进不去的房间,而日志上看不出缺的是哪一项。"""
        for missing in ("url", "room", "identity", "token"):
            raw = {"url": "ws://lk", "room": "r", "identity": "i", "token": "t"}
            del raw[missing]
            self.assertEqual(ticket_of(raw), {})

    def test_快到期就该换(self):
        full = {"url": "u", "room": "r", "identity": "i", "token": "t",
                "expires_at": 1000 + RENEW_BEFORE_SEC}
        self.assertFalse(ticket_usable(full, 1000))
        self.assertTrue(ticket_usable({**full, "expires_at": 1001 + RENEW_BEFORE_SEC}, 1000))

    def test_没有到期时刻的当成能用(self):
        """老服务器不回 expires_at。据一个我们没有的数字提前判死刑是编。"""
        self.assertTrue(ticket_usable({"url": "u", "room": "r", "identity": "i",
                                       "token": "t", "expires_at": 0}, 10 ** 9))


class 领凭证的两条路(unittest.TestCase):
    TICKET = {"url": "ws://lk:7880", "room": "workbench", "identity": "wb-phone-d1",
              "token": "jwt", "expires_at": 2_000_000}

    def test_局域网那条带的是设备令牌(self):
        seen = []
        got = room_ticket_lan("http://wb:8791", "tok",
                              post=fake_post({"/channel/token": self.TICKET}, seen))
        self.assertEqual(got["identity"], "wb-phone-d1")
        _, body, token = seen[0]
        self.assertEqual(token, "tok")
        # 身份**不由派报**:8791 按设备令牌拼(channelIdentityOf 那条老规矩)。
        self.assertNotIn("identity", body)

    def test_中转那条必须报上次那个身份(self):
        seen = []
        room_ticket_relay("https://relay", "rtok", "wb-phone-d1",
                          post=fake_post({"/v1/channel-token": self.TICKET}, seen))
        _, body, token = seen[0]
        self.assertEqual(body["identity"], "wb-phone-d1")
        self.assertEqual(token, "rtok")

    def test_没有身份时宁可不走中转(self):
        """★ 自己编一个身份的后果:工人拿它去 8791 查设备查不到,整条 wb.rpc 被 403。"""
        with self.assertRaises(RuntimeError):
            room_ticket_relay("https://relay", "rtok", "", post=fake_post({}))

    def test_中转那条要把两条属性一起签进去(self):
        """★ 2026-09-22 补的洞:属性漏了不会让派进不去房,只会让工人把这只实体话筒
        当成一台普通手机 —— pickSpeaker 挑不中它,听筒里一片寂静而日志全是绿的。
        局域网那条由 8791 代拼,一直是对的,所以这个洞只在中转那条路上露出来。"""
        seen = []
        room_ticket_relay("https://relay", "rtok", "wb-phone-handset-3f2a", device_id="handset-3f2a",
                          post=fake_post({"/v1/channel-token": self.TICKET}, seen))
        _, body, _ = seen[0]
        self.assertEqual(body["attributes"], {DEVICE_ID_ATTRIBUTE: "handset-3f2a",
                                              KIND_ATTRIBUTE: KIND_HANDSET})

    def test_没在局域网配过对的派也拼得出身份(self):
        """手机 App 配网那条流程压根不经 /pair/claim,于是永远没有"上次那个身份"。
        以前这里直接报"走不了",派就一辈子进不了房。"""
        state = {"relay_token": "rtok", "device_id": "handset-3f2a7c91b04d4e0f"}
        seen = []
        got = acquire_ticket(state, now_sec=0, relay_base="https://relay",
                             post=fake_post({"/v1/channel-token": self.TICKET}, seen))
        self.assertEqual(got, self.TICKET)
        _, body, _ = seen[0]
        self.assertEqual(body["identity"], "wb-phone-handset-3f2a7c91b04d4e0f")

    def test_中转地址也可以写在_device_json_里(self):
        """手机配网写的是 device.json;unit 里那一行可能还是老的。"""
        state = {"relay_token": "rtok", "device_id": "d1", "relay": "https://api.aibooo.cn"}
        seen = []
        acquire_ticket(state, now_sec=0, relay_base="",
                       post=fake_post({"/v1/channel-token": self.TICKET}, seen))
        self.assertTrue(seen[0][0].startswith("https://api.aibooo.cn/"))

    def test_命令行领过中转令牌的那台_地址在_relay_base_一格(self):
        """`--relay-login` 把地址写在 `relay_base`(popphone.do_relay_login);unit 里那一行缺省为空之后
        (2026-10-21 零服务器是缺省),这一格是那几台派唯一的中转地址。"""
        state = {"relay_token": "rtok", "device_id": "d1", "relay_base": "https://relay.example"}
        seen = []
        acquire_ticket(state, now_sec=0, relay_base="",
                       post=fake_post({"/v1/channel-token": self.TICKET}, seen))
        self.assertTrue(seen[0][0].startswith("https://relay.example/"))

    def test_没配中转时手上有中转令牌也只走_8791(self):
        """零服务器档:unit 与 device.json 都没有中转地址 —— 一个包都不往中转发,局域网领不到就回空。"""
        state = {"token": "tok", "workbench_http": "http://wb:8791", "relay_token": "rtok", "device_id": "d1"}
        seen = []
        got = acquire_ticket(state, now_sec=0, relay_base="", post=fake_post({}, seen), get=fake_get({}))
        self.assertEqual(got, {})
        self.assertEqual([url for url, _, _ in seen], ["http://wb:8791/channel/token"])

    def test_身份的拼法与手机端那份逐字相同(self):
        """roomFromRelay.ts 的 phoneIdentityOf:同一个字符集、同一个 48 字符上限。"""
        self.assertEqual(identity_of("handset-3f2a"), "wb-phone-handset-3f2a")
        self.assertEqual(identity_of("a b/c"), "wb-phone-a-b-c")
        self.assertEqual(identity_of("中文"), "wb-phone---")
        self.assertEqual(identity_of("x" * 60), "wb-phone-" + "x" * 48)
        self.assertEqual(identity_of(""), "")

    def test_局域网优先(self):
        state = {"token": "tok", "workbench_http": "http://wb:8791", "relay_token": "rtok"}
        seen = []
        got = acquire_ticket(state, now_sec=0, relay_base="https://relay",
                             post=fake_post({"/channel/token": self.TICKET,
                                             "/v1/channel-token": self.TICKET}, seen))
        self.assertEqual(got["token"], "jwt")
        self.assertEqual(len(seen), 1)
        self.assertIn("/channel/token", seen[0][0])

    def test_局域网不通就走中转(self):
        state = {"token": "tok", "workbench_http": "http://wb:8791", "relay_token": "rtok",
                 "ticket": {**self.TICKET, "expires_at": 1}}
        seen = []
        got = acquire_ticket(state, now_sec=10 ** 9, relay_base="https://relay",
                             post=fake_post({"/v1/channel-token": self.TICKET}, seen))
        self.assertEqual(got["token"], "jwt")
        self.assertIn("/v1/channel-token", seen[-1][0])

    def test_手上那张还没到期_Mac_关着时一个票都不领(self):
        """★ Mac 关着时派唯一的指望:7 天有效期就是为这个签的。

        2026-10-03 起进房前会先问一次「现在该进哪个房」—— Mac 关着时那一问也问不到,
        于是**照旧用缓存票**(只是日志里如实说一声)。领票那一边仍然一个包都不发。
        """
        state = {"token": "tok", "workbench_http": "http://wb:8791", "ticket": self.TICKET}
        seen = []
        lines = []
        got = acquire_ticket(state, now_sec=1000, post=fake_post({}, seen),
                             get=fake_get({}), log=lines.append)
        self.assertEqual(got["token"], "jwt")
        self.assertEqual(seen, [])
        self.assertTrue(any("用的是缓存票" in line for line in lines), lines)

    def test_两条都不通时把过期那张拿出来试一次(self):
        old = {**self.TICKET, "expires_at": 1}
        state = {"token": "tok", "workbench_http": "http://wb:8791", "ticket": old}
        got = acquire_ticket(state, now_sec=10 ** 9, post=fake_post({}))
        self.assertEqual(got["token"], "jwt")

    def test_什么都没有就回空(self):
        self.assertEqual(acquire_ticket({}, now_sec=0, post=fake_post({})), {})


class 落盘(unittest.TestCase):
    def test_写出来是_0600(self):
        """里头是唯一那张设备令牌,与 credentials.json 同规格。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "sub", "device.json")
            save_state(path, {"token": "tok"})
            self.assertEqual(oct(os.stat(path).st_mode & 0o777), "0o600")
            self.assertEqual(load_state(path), {"token": "tok"})

    def test_读不懂的文件当成没配对过而不是删掉(self):
        """删掉等于把唯一那张令牌扔了,而它很可能只是被谁手动编辑坏了一个逗号。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "device.json")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("{ 坏了")
            self.assertEqual(load_state(path), {})
            self.assertTrue(os.path.exists(path))

    def test_没有这个文件时回空(self):
        self.assertEqual(load_state("/不存在/device.json"), {})

    def test_存下来的令牌不进日志这件事由调用方保证(self):
        """这一条只是钉住格式:落盘的 JSON 里确实有 token(不然开机就要重配对)。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "device.json")
            save_state(path, {"token": "tok", "device_id": "d1"})
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(json.load(handle)["token"], "tok")


if __name__ == "__main__":
    unittest.main()


class 中转登录领令牌(unittest.TestCase):
    """--relay-login:登录 → 注册设备 → 注销;密码只出现在登录那一包里。"""

    def test_三步顺序与字段(self):
        seen = []
        post = fake_post({
            "/v1/account/login": {"session_token": "wbs_s"},
            "/register-device": {"token": "wb_t", "prefix": "wb_t"},
            "/v1/account/logout": {"ok": True, "revoked": 1},
        }, seen)
        token = relay_login("https://relay.example", "ben@x", "pw", "dev-1", name="座机", post=post)
        self.assertEqual(token, "wb_t")
        self.assertEqual([u.rsplit("/", 1)[-1] for u, _, _ in seen], ["login", "register-device", "logout"])
        self.assertEqual(seen[0][1], {"identifier": "ben@x", "password": "pw"})
        # 类型报 handset(2026-09-23):中转按这一列往进房凭证里签 wb_kind,
        # 报 other 的话工人就把这只实体话筒当成普通手机。
        self.assertEqual(seen[1][1], {"device_id": "dev-1", "name": "座机", "kind": "handset"})
        self.assertEqual(seen[1][2], "wbs_s")  # 注册带的是会话令牌
        self.assertEqual(seen[2][2], "wbs_s")
        self.assertNotIn("pw", json.dumps(seen[1:]))  # 密码只在登录那一包

    def test_报的类型就是这一份常量_重跑一次即可改种类(self):
        """已经注册成 other 的那台,把 --relay-login 原样再跑一次就按这一份改过来。"""
        self.assertEqual(RELAY_DEVICE_KIND, "handset")
        seen = []
        post = fake_post({
            "/v1/account/login": {"session_token": "wbs_s"},
            "/register-device": {"token": "wb_t2", "prefix": "wb_t2"},
            "/v1/account/logout": {"ok": True},
        }, seen)
        relay_login("https://r", "a", "b", "dev-1", post=post)
        self.assertEqual(seen[1][1]["kind"], RELAY_DEVICE_KIND)
        self.assertEqual(seen[1][1]["device_id"], "dev-1")  # 同一个 id:重领只是换钥匙

    def test_没配对过不登录(self):
        seen = []
        with self.assertRaises(RuntimeError):
            relay_login("https://r", "a", "b", "", post=fake_post({}, seen))
        self.assertEqual(seen, [])

    def test_登录失败原样报错不带密码(self):
        post = fake_post({"/v1/account/login": RuntimeError("login 回了 HTTP 401:密码不对")})
        with self.assertRaises(RuntimeError) as ctx:
            relay_login("https://r", "a", "secret-pw", "dev-1", post=post)
        self.assertNotIn("secret-pw", str(ctx.exception))

    def test_注册失败也注销会话(self):
        seen = []
        post = fake_post({
            "/v1/account/login": {"session_token": "wbs_s"},
            "/register-device": RuntimeError("register-device 回了 HTTP 429:太多设备"),
            "/v1/account/logout": {"ok": True},
        }, seen)
        with self.assertRaises(RuntimeError):
            relay_login("https://r", "a", "b", "dev-1", post=post)
        self.assertEqual([u.rsplit("/", 1)[-1] for u, _, _ in seen], ["login", "register-device", "logout"])


class 重新接入与死钥匙(unittest.TestCase):
    """2026-09-30 止血(docs/设计-重构-接缝与技术债-2026-09-30.md 根子 2)。

    真机上的那个现象:座机换了账号重新添加,进的还是**旧账号**的房。
    三件事叠在一起 —— 合并写留下了旧票、旧票 7 天有效、领票先看旧票。
    """

    TICKET = {"url": "ws://lk:7880", "room": "wb-old", "identity": "wb-phone-handset-01",
              "token": "jwt-old", "expires_at": 2_000_000}
    NEW = {"url": "ws://lk:7880", "room": "wb-new", "identity": "wb-phone-handset-01",
           "token": "jwt-new", "expires_at": 2_000_000}

    def 旧的一份(self) -> dict:
        return {"device_id": "handset-01", "name": "座机话筒",
                "token": "lan-tok", "workbench_http": "http://old-mac:8791",
                "relay": "https://old-relay", "relay_base": "https://old-relay",
                "relay_token": "wb_old", "identity": "wb-phone-handset-01",
                "room": "wb-old", "ticket": self.TICKET}

    def test_重新接入把旧票旧令牌旧地址一起清掉(self):
        patch = provision.link_patch(
            {"relay": "https://new-relay/", "token": "wb_new", "device_id": "handset-01"},
            "handset-01")
        got = provision.relinked_state(self.旧的一份(), patch)
        for gone in ("ticket", "token", "workbench_http", "identity", "room", "relay_base"):
            self.assertNotIn(gone, got, f"{gone} 应该在重新接入时被清掉")
        self.assertEqual(got["relay_token"], "wb_new")
        self.assertEqual(got["relay"], "https://new-relay")

    def test_重新接入保留设备_id_与显示名(self):
        """device_id 是机器码算出来的:换掉等于每添加一次就在账号里多一台僵尸设备。"""
        patch = provision.link_patch({"relay": "https://new-relay", "token": "wb_new"}, "handset-01")
        got = provision.relinked_state(self.旧的一份(), patch)
        self.assertEqual(got["device_id"], "handset-01")
        self.assertEqual(got["name"], "座机话筒")

    def test_重新接入之后下一次领票走中转拿新钥匙(self):
        """★ 真机那个现象的守门用例:清完之后既不该用缓存票,也不该去问旧那台 Mac。"""
        patch = provision.link_patch({"relay": "https://new-relay", "token": "wb_new"}, "handset-01")
        state = provision.relinked_state(self.旧的一份(), patch)
        seen = []
        got = acquire_ticket(state, now_sec=1000, relay_base="",
                             post=fake_post({"/v1/channel-token": self.NEW}, seen))
        self.assertEqual(got, self.NEW)
        self.assertEqual(len(seen), 1, "只该发中转那一个包(局域网令牌已经清了)")
        url, _, token = seen[0]
        self.assertTrue(url.startswith("https://new-relay/"))
        self.assertEqual(token, "wb_new")

    def test_中转说钥匙作废就清掉它并回空(self):
        state = {k: v for k, v in self.旧的一份().items()
                 if k not in ("token", "workbench_http")}
        cleaned = {}
        dead = HttpRefused("channel-token 回了 HTTP 401:这台设备的凭证不认识或已失效。",
                           status=401, code=RELAY_TOKEN_DEAD_CODE)
        got = acquire_ticket(state, now_sec=10 ** 9, relay_base="https://old-relay",
                             post=fake_post({"/v1/channel-token": dead}),
                             on_unbind=lambda fresh: cleaned.update(fresh))
        self.assertEqual(got, {}, "作废之后不该再拿过期那张顶上")
        for gone in ("relay_token", "ticket", "identity", "room"):
            self.assertNotIn(gone, cleaned, f"{gone} 应该跟着作废的钥匙一起清掉")
        # 留下的:重新添加还要用的那几样
        self.assertEqual(cleaned["device_id"], "handset-01")
        self.assertEqual(cleaned["relay"], "https://old-relay")

    def test_清完之后再领一次一个包都不发(self):
        """★「不要拿着废钥匙每 20 秒敲一次中转」:清完就没得敲了(room_link 睡 20 秒再来)。"""
        cleaned = cleared_relay_state(self.旧的一份())
        seen = []
        got = acquire_ticket({k: v for k, v in cleaned.items()
                              if k not in ("token", "workbench_http")},
                             now_sec=10 ** 9, relay_base="https://old-relay",
                             post=fake_post({}, seen))
        self.assertEqual(got, {})
        self.assertEqual(seen, [])

    def test_只有真的说钥匙作废才算(self):
        self.assertTrue(relay_token_dead(HttpRefused("x", 401, RELAY_TOKEN_DEAD_CODE)))
        # 老中转没有 code 那一层,只有 401
        self.assertTrue(relay_token_dead(HttpRefused("x", 401, "")))
        # 403:那台 Mac 还没登录账号 —— 钥匙好着呢,清了要人白跑一趟
        self.assertFalse(relay_token_dead(HttpRefused("x", 403, "not_bound_to_account")))
        # 503:中转没配 LiveKit。都是暂时的
        self.assertFalse(relay_token_dead(HttpRefused("x", 503, "channel_not_configured")))
        self.assertFalse(relay_token_dead(RuntimeError("channel-token 没打通:timed out")))

    def test_中转那种回包形状也掏得出机器码(self):
        """中转照 OpenAI 那一套包一层(relay/server/app.cjs 的 oaiError),
        工作台 8791 是平的一句话。两种都要认得。"""
        self.assertEqual(_error_said({"error": {"message": "不认识", "code": "invalid_relay_token"}}),
                         ("不认识", "invalid_relay_token"))
        self.assertEqual(_error_said({"error": "码不对"}), ("码不对", ""))
        self.assertEqual(_error_said({"ok": True}), ("", ""))

    def test_过期那张只对得上现在这间房才拿出来试(self):
        state = {"device_id": "handset-01", "room": "wb-new",
                 "ticket": {**self.TICKET, "expires_at": 1}}
        self.assertEqual(acquire_ticket(state, now_sec=10 ** 9, post=fake_post({})), {},
                         "旧账号那间房的票不该再试")
        same = {**state, "room": "wb-old"}
        self.assertEqual(acquire_ticket(same, now_sec=10 ** 9, post=fake_post({}))["room"], "wb-old")

    def test_过期那张身份对不上也不试(self):
        state = {"device_id": "handset-02", "ticket": {**self.TICKET, "expires_at": 1}}
        self.assertEqual(acquire_ticket(state, now_sec=10 ** 9, post=fake_post({})), {})

    def test_解绑与重新接入之后都没有过期票可以兜底(self):
        """★ 「never after a relink/unbind」:两份清单都把 ticket 摘掉,兜底自然走不到。"""
        self.assertNotIn("ticket", cleared_relay_state(self.旧的一份()))
        self.assertNotIn("ticket", provision.relinked_state(
            self.旧的一份(), {"relay_token": "wb_new", "relay": "https://new-relay"}))


class 进房前先问现在该进哪个房(unittest.TestCase):
    """★ 2026-10-03,卡 B(审计 `docs/审计材料/2026-10-03/devices.md` 附证 B)。

    现场:派缓存了一张**还没到期**的旧房票,电脑重装 / 登录账号之后工人转进了新房间。
    `acquire_ticket` 第一行就是「没过期就直接回缓存那张」,于是派一直进旧房 ——
    而且因为「进房成功」,09-30 那条「进不了房就把蓝牙开着」的恢复入口永远不触发。

    现在:**手上这张还能用的时候**,进房前先问工作台一次 `GET /channel/status`。
    房变了就重新领;房没变就接着用(不重复要一张);问不到(Mac 关着 / 旧版 / 没配通道)
    照旧用缓存票,**日志里如实说一声**。
    """

    OLD = {"url": "ws://lk:7880", "room": "wb-old", "identity": "wb-phone-handset-01",
           "token": "jwt-old", "expires_at": 2_000_000}
    NEW = {"url": "ws://lk:7880", "room": "wb-new", "identity": "wb-phone-handset-01",
           "token": "jwt-new", "expires_at": 2_000_000}

    def 在线的一份(self) -> dict:
        return {"device_id": "handset-01", "name": "座机话筒", "token": "lan-tok",
                "workbench_http": "http://mac:8791", "room": "wb-old", "ticket": self.OLD}

    # ——— 纯函数:回包怎么读、什么算换房 ———

    def test_只认说得出房名的那种回包(self):
        self.assertEqual(room_of_status(status_body("wb-new")),
                         {"room": "wb-new", "url": "ws://lk:7880"})
        # 通道压根没配:那时回包里那个房名是默认占位值(CHANNEL_DEFAULT_ROOM),据它判换房是编。
        self.assertEqual(room_of_status(status_body("workbench", configured=False)), {})
        self.assertEqual(room_of_status(status_body("", url="")), {})
        self.assertEqual(room_of_status({"configured": True, "room": "wb-new"}),
                         {"room": "wb-new", "url": ""})
        for junk in (None, "一串字", [], {"error": "通道层未启用"}):
            self.assertEqual(room_of_status(junk), {})

    def test_房名变了算换房_服务器地址变了也算(self):
        self.assertTrue(room_moved(self.OLD, {"room": "wb-new", "url": "ws://lk:7880"}))
        self.assertFalse(room_moved(self.OLD, {"room": "wb-old", "url": "ws://lk:7880"}))
        # 同一个房名、换了一台 livekit:那也不是同一间房。
        self.assertTrue(room_moved(self.OLD, {"room": "wb-old", "url": "ws://other:7880"}))
        # 问不到就不算「换房」—— 不知道不等于变了(D13)。
        self.assertFalse(room_moved(self.OLD, {}))
        # 回包里没有地址那一格时只比房名,不拿空串当「地址变了」。
        self.assertFalse(room_moved(self.OLD, {"room": "wb-old", "url": ""}))
        self.assertFalse(room_moved({}, {"room": "wb-new"}))

    def test_问一次带的是设备令牌_走的是只读那条路(self):
        seen = []
        got = ask_room_now("http://mac:8791", "lan-tok", get=fake_get(
            {ROOM_NOW_PATH: status_body("wb-new")}, seen))
        self.assertEqual(got["room"], "wb-new")
        url, token = seen[0]
        self.assertEqual(url, f"http://mac:8791{ROOM_NOW_PATH}")
        self.assertEqual(token, "lan-tok")

    def test_问不到的三种都回空且不抛(self):
        # Mac 关着 / 够不到
        self.assertEqual(ask_room_now("http://mac:8791", "tok", get=fake_get({})), {})
        # 旧工作台:没有通道层那条路由
        old = HttpRefused("status 回了 HTTP 404", status=404)
        self.assertEqual(ask_room_now("http://mac:8791", "tok",
                                      get=fake_get({ROOM_NOW_PATH: old})), {})
        # 没有局域网那把令牌(手机 App 配网那条路):压根问不了,一个包都不发
        seen = []
        self.assertEqual(ask_room_now("http://mac:8791", "", get=fake_get({}, seen)), {})
        self.assertEqual(ask_room_now("", "tok", get=fake_get({}, seen)), {})
        self.assertEqual(seen, [])

    # ——— 领票那一头 ———

    def test_房变了就换票(self):
        """★ 卡上那一条:工作台换了房,手上这张虽然没过期也要换。"""
        state = self.在线的一份()
        seen = []
        lines = []
        got = acquire_ticket(state, now_sec=1000, post=fake_post({"/channel/token": self.NEW}, seen),
                             get=fake_get({ROOM_NOW_PATH: status_body("wb-new")}), log=lines.append)
        self.assertEqual(got, self.NEW)
        self.assertEqual(len(seen), 1, "该去领一张新的")
        self.assertIn("/channel/token", seen[0][0])
        self.assertTrue(any("换房" in line and "wb-new" in line for line in lines), lines)

    def test_票没变就不重复要(self):
        """★ 卡上那一条:房没变时只问那一声,不再领票(7 天票的意义不能被这条修复抹掉)。"""
        state = self.在线的一份()
        posted = []
        asked = []
        got = acquire_ticket(state, now_sec=1000, post=fake_post({"/channel/token": self.NEW}, posted),
                             get=fake_get({ROOM_NOW_PATH: status_body("wb-old")}, asked))
        self.assertEqual(got, self.OLD)
        self.assertEqual(posted, [], "房没变不该再领一张")
        self.assertEqual(len(asked), 1, "只该问那一声")

    def test_已经过期的那张不问_直接去领(self):
        """过期的无论房变没变都要换,那一问省下来(它最坏要等一个超时)。"""
        state = {**self.在线的一份(), "ticket": {**self.OLD, "expires_at": 1}}
        asked = []
        got = acquire_ticket(state, now_sec=10 ** 9,
                             post=fake_post({"/channel/token": self.NEW}),
                             get=fake_get({ROOM_NOW_PATH: status_body("wb-old")}, asked))
        self.assertEqual(got, self.NEW)
        self.assertEqual(asked, [], "过期那张本来就要换,不必先问房")

    def test_房变了但新票领不到就回空_不拿旧票撞门(self):
        """★ 这一条才让 09-30 那条恢复入口够得着:回空 → 进不了房 → 蓝牙开起来等人重新添加。

        这一份的 `room` 也写着旧那间,`fallback_ok` 会答「行」—— 真正挡住它的是
        「工作台刚刚说过现在是别的房」。
        """
        state = self.在线的一份()
        lines = []
        got = acquire_ticket(state, now_sec=1000, post=fake_post({}),
                             get=fake_get({ROOM_NOW_PATH: status_body("wb-new")}), log=lines.append)
        self.assertEqual(got, {})
        self.assertTrue(any("不拿它撞门" in line for line in lines), lines)

    def test_过期那张的兜底这一条没动(self):
        """09-30 那条「过期的也试一次,但只限同一个房同一个身份」原样留着。

        为什么这条路上不补一问:走到这里意味着**两条领票的路都不通**,而那一问走的是
        其中的局域网那一条 —— 它答不出来,白等一个超时。所以 `asked` 是空的。
        """
        state = {**self.在线的一份(), "ticket": {**self.OLD, "expires_at": 1}}
        asked = []
        got = acquire_ticket(state, now_sec=10 ** 9, post=fake_post({}),
                             get=fake_get({ROOM_NOW_PATH: status_body("wb-new")}, asked))
        self.assertEqual(got["room"], "wb-old")
        self.assertEqual(asked, [])

    def test_问不到就用缓存票并且说出来(self):
        """★ 卡上那一条:离线时用缓存,**日志里如实说「用的是缓存票」**,不装作核对过了。"""
        for bad in ({}, {ROOM_NOW_PATH: status_body("workbench", configured=False)},
                    {ROOM_NOW_PATH: HttpRefused("status 回了 HTTP 404", status=404)}):
            lines = []
            posted = []
            got = acquire_ticket(self.在线的一份(), now_sec=1000,
                                 post=fake_post({"/channel/token": self.NEW}, posted),
                                 get=fake_get(bad), log=lines.append)
            self.assertEqual(got, self.OLD)
            self.assertEqual(posted, [])
            self.assertTrue(any("用的是缓存票" in line for line in lines), lines)

    def test_那条路与那三格真的在插件里(self):
        """★ 对照测试:派从此多了一个消费方 —— 8791 的 `GET /channel/status`。

        **读源头文件比对**(顶层子目录互不 import,所以只能读文本;派上只铺 phone-bridge,
        所以读不到那份源码时跳过这一条)。钉三样:那条路由是 GET、回包里有 `configured`,
        以及 `room` / `url` 两格确实是 `status()` 拼出来的。
        """
        here = os.path.dirname(os.path.abspath(__file__))
        http_ts = os.path.join(here, "..", "workbench-plugin", "src", "server", "http.ts")
        channel_ts = os.path.join(here, "..", "workbench-plugin", "src", "server", "channel.ts")
        if not (os.path.exists(http_ts) and os.path.exists(channel_ts)):
            self.skipTest("这台机器上没有插件源码(派上只铺 phone-bridge)")
        with open(http_ts, encoding="utf-8") as handle:
            http_src = handle.read()
        self.assertIn(f"path === '{ROOM_NOW_PATH}' && req.method === 'GET'", http_src)
        with open(channel_ts, encoding="utf-8") as handle:
            channel_src = handle.read()
        # `status()` 那一份的三格(configured 之外的两格就是我们比的那两样)。
        self.assertIn("configured: true", channel_src)
        self.assertIn("token_ttl_seconds", channel_src)
        for key in ("url:", "room:"):
            self.assertIn(key, channel_src)

    def test_没有局域网令牌时照旧用缓存票(self):
        """手机 App 配网那条路上压根没有局域网那把令牌:问不了,就如实说用的是缓存票。
        **不去问中转** —— 中转答的是「这个账号那间房」,而那台 Mac 可能自己配着 LiveKit,
        两者房名本来就不同,拿它判换房会让每次重连都白白换一张票。"""
        state = {"device_id": "handset-01", "relay_token": "rtok", "relay": "https://relay",
                 "room": "wb-old", "ticket": self.OLD}
        lines = []
        posted = []
        got = acquire_ticket(state, now_sec=1000, post=fake_post({"/v1/channel-token": self.NEW}, posted),
                             get=fake_get({}), log=lines.append)
        self.assertEqual(got, self.OLD)
        self.assertEqual(posted, [])
        self.assertTrue(any("用的是缓存票" in line for line in lines), lines)
