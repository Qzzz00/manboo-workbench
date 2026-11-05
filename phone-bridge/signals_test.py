"""房间信号的解析/拼装测试。

这一份钉住的是**跨仓库的那份手抄**:`channel-worker/src/callOut.ts` 写什么,
这边就得认什么。字段名错一个字 = 座机永远不响,而两边都没有报错。
"""
import json
import unittest

from signals import (
    ACTION_ANSWER, ACTION_HANGUP, ACTION_START, RPC_TOPIC,
    call_request, parse_room_signal, rpc_response_of,
)


class 收工人的信号(unittest.TestCase):
    def test_ring_原样是_channel_worker_发的那一条(self):
        """字段抄自 callOut.ts 的 `RingSignal`。多出来的字段(reason/item_id/merged)
        我们用不上,但**不能因此读不懂整条**。"""
        raw = json.dumps({
            "type": "ring", "call_id": "c1", "reason": "confirm",
            "item_id": "it-9", "title": "把首页文案改一版", "note": "他昨天提过",
            "at": "2026-09-21T10:00:00+08:00", "silent": False,
            "merged": [{"item_id": "it-8", "title": "另一件"}], "until": 1_758_000_060_000,
        }, ensure_ascii=False)
        event = parse_room_signal(raw)
        self.assertEqual(event["kind"], "ring")
        self.assertEqual(event["source"], "room")
        self.assertEqual(event["call_id"], "c1")
        self.assertEqual(event["title"], "把首页文案改一版")
        self.assertIs(event["silent"], False)
        self.assertEqual(event["until"], 1_758_000_060_000)

    def test_夜间静默那一条的_silent_要读出来(self):
        event = parse_room_signal(json.dumps({"type": "ring", "call_id": "c2", "silent": True}))
        self.assertIs(event["silent"], True)

    def test_ring_end_读出_outcome(self):
        event = parse_room_signal(json.dumps(
            {"type": "ring_end", "call_id": "c1", "outcome": "answered"}))
        self.assertEqual(event, {"kind": "ring_end", "call_id": "c1",
                                 "outcome": "answered", "text": ""})

    def test_没有_call_id_的一条一律不认(self):
        """没有 id 就没法 answer。硬当成一通电话去接,接到的会是下一通。"""
        for raw in ('{"type":"ring"}', '{"type":"ring","call_id":""}',
                    '{"type":"ring_end","outcome":"missed"}'):
            self.assertEqual(parse_room_signal(raw), {})

    def test_别的信号原样忽略而不是崩(self):
        """同一条通道上还跑着字幕与缓冲语(0.2.47 起),以后还会多。
        派只认来电那两条,别的一律当没看见 —— 工人多发一种新信号不该让座机挂掉。"""
        for raw in ('{"type":"caption","role":"her","text":"你好","final":true}',
                    '{"type":"filler","kind":"thinking","round":1,"at":1}',
                    '{"type":"unknown-2027"}', "不是 JSON", "[]", "null", ""):
            self.assertEqual(parse_room_signal(raw), {})


class 工人的应答(unittest.TestCase):
    def test_读得出没办成那一条(self):
        said = rpc_response_of(json.dumps(
            {"id": "x1", "type": "call", "ok": False, "error": "正在响的不是这一通"},
            ensure_ascii=False))
        self.assertEqual(said, {"id": "x1", "ok": False, "error": "正在响的不是这一通"})

    def test_办成了(self):
        said = rpc_response_of('{"id":"x1","type":"call","ok":true}')
        self.assertEqual(said, {"id": "x1", "ok": True, "error": ""})

    def test_不是_call_类型的应答不当回事(self):
        self.assertEqual(rpc_response_of('{"id":"x1","type":"http","status":200}'), {})


class 发给工人的请求(unittest.TestCase):
    def test_answer_必带_call_id(self):
        """★ 工人那边(rpc.ts)校验:answer / later 不带 call_id 直接回错。
        理由是铃可能刚好在他拿起听筒那一刻超时 —— 不带 id 就会接起**下一通**。"""
        body = json.loads(call_request(ACTION_ANSWER, "c1", req_id="fixed"))
        self.assertEqual(body, {"id": "fixed", "type": "call", "action": "answer", "call_id": "c1"})

    def test_hangup_也是同一个形状(self):
        body = json.loads(call_request(ACTION_HANGUP, "c1", req_id="fixed"))
        self.assertEqual(body["action"], "hangup")

    def test_提机即拨出那条_start_压根不带_call_id(self):
        """★ 2026-09-23:他自己拨出去的一通还没有 id。工人那边(rpc.ts)
        只对 answer / later 校验 call_id,start / hangup 不要 —— 发一个空的过去,
        工人读出来是空串,而日志里看着像带了 id。整个字段不发才不会骗人。"""
        body = json.loads(call_request(ACTION_START, req_id="fixed"))
        self.assertEqual(body, {"id": "fixed", "type": "call", "action": "start"})

    def test_挂断他自己那一通同样不带_call_id(self):
        body = json.loads(call_request(ACTION_HANGUP, "", req_id="fixed"))
        self.assertEqual(body, {"id": "fixed", "type": "call", "action": "hangup"})

    def test_每条请求的_id_不重样(self):
        """工人按 id 回应答。两条同 id 的请求会让第二条的结果被当成第一条的。"""
        ids = {json.loads(call_request(ACTION_ANSWER, "c1"))["id"] for _ in range(20)}
        self.assertEqual(len(ids), 20)

    def test_topic_是两端唯一的约定(self):
        self.assertEqual(RPC_TOPIC, "wb.rpc")


if __name__ == "__main__":
    unittest.main()
