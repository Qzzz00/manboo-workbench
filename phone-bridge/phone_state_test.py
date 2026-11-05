"""来电状态机测试。先于实现编写(仓库纪律:TDD)。

状态机是纯函数:吃 (状态, 事件, 当前秒) 吐 (新状态, 动作列表)。
时钟一律外部传入——和 workbench-plugin 的 sessions/ring 同一哲学,测试可精确复现。

2026-09-21 起有**两条来路**(见 phone_state.py 顶部):房间(`room`,LiveKit,带音频)
与 8791 的 WS(`live`,老路,只有铃)。下面按来路分了两组,**两组都要留着** ——
老路是房间没配起来时唯一还能响的那条。
"""
import unittest
from phone_state import (
    IDLE, RINGING, IN_CALL,
    PhoneState, ring_event, room_ring_event, ring_end_event,
    button_event, tick_event, hook_event,
    transition, RING_TIMEOUT_SEC, RING_UNTIL_GRACE_SEC,
)


class 待机(unittest.TestCase):
    def test_来电进入可提机接听并记录会话(self):
        st, actions = transition(PhoneState(IDLE), ring_event("claude", "s1"), now=100)
        self.assertEqual(st.phase, RINGING)
        self.assertEqual((st.agent, st.session_id), ("claude", "s1"))
        self.assertEqual(st.ringing_since, 100)
        # ★ 2026-09-22 晚(Ben 定):**派不响铃**,铃由手机 App 出。
        # 所以这一下**一个动作都没有** —— 只是把叉簧的下一次「拿起」认成接这一通。
        self.assertEqual(actions, [])

    def test_待机按键等同提机_也拨出去(self):
        """POP 那颗键与叉簧等价(硬件文档第 2 条),这条捷径上也一样。"""
        st, actions = transition(PhoneState(IDLE), button_event(), now=100)
        self.assertEqual(st.phase, IN_CALL)
        self.assertEqual(actions, [("rpc", "start", ""), ("audio", "on")])

    def test_待机时钟嘀嗒无事发生(self):
        st, actions = transition(PhoneState(IDLE), tick_event(), now=100)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(actions, [])

    def test_没有电话时拿起听筒_直接接通事务官(self):
        """★ 2026-09-23 Ben 定(设计-座机整体体验 第六节第 4 条):提机即拨出。

        发的是 `start` 不是 `answer` —— 这会儿一通电话都没有,凭空 answer
        会被工人如实回绝(「这会儿没有电话在响」),听筒里就是一片安静。
        """
        st, actions = transition(PhoneState(IDLE), hook_event(off=True), now=100)
        self.assertEqual(st.phase, IN_CALL)
        self.assertEqual(st.source, "room")
        self.assertIsNone(st.call_id)
        self.assertEqual(actions, [("rpc", "start", ""), ("audio", "on")])

    def test_待机收到别人的收场消息不当回事(self):
        st, actions = transition(PhoneState(IDLE), ring_end_event("c9", "missed"), now=100)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(actions, [])


class 可提机接听(unittest.TestCase):
    def setUp(self):
        self.ringing, _ = transition(PhoneState(IDLE), ring_event("claude", "s1"), now=100)

    def test_按键即摘机(self):
        st, actions = transition(self.ringing, button_event(), now=105)
        self.assertEqual(st.phase, IN_CALL)
        # 没有 ("ring","stop") —— 派压根没响过(2026-09-22 晚)。
        self.assertEqual(actions, [
            ("post", "offhook", "claude", "s1"), ("play", "answered"),
        ])

    def test_等人接的那段时间里再来电不换会话(self):
        """铃声克制原则的延伸:一次只处理一通,后来的不插队。"""
        st, actions = transition(self.ringing, ring_event("codex", "s2"), now=110)
        self.assertEqual((st.agent, st.session_id), ("claude", "s1"))
        self.assertEqual(actions, [])

    def test_超时未接自动收场(self):
        st, actions = transition(self.ringing, tick_event(), now=100 + RING_TIMEOUT_SEC + 1)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(actions, [("post", "missed", "claude", "s1")])

    def test_未到超时线保持可接(self):
        st, actions = transition(self.ringing, tick_event(), now=100 + RING_TIMEOUT_SEC)
        self.assertEqual(st.phase, RINGING)
        self.assertEqual(actions, [])


class 通话中(unittest.TestCase):
    def setUp(self):
        ringing, _ = transition(PhoneState(IDLE), ring_event("claude", "s1"), now=100)
        self.in_call, _ = transition(ringing, button_event(), now=105)

    def test_再按键即挂机(self):
        st, actions = transition(self.in_call, button_event(), now=160)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(actions, [("post", "onhook", "claude", "s1"), ("play", "hangup")])

    def test_通话中来电不打扰(self):
        st, actions = transition(self.in_call, ring_event("kimi", "s9"), now=160)
        self.assertEqual(st.phase, IN_CALL)
        self.assertEqual((st.agent, st.session_id), ("claude", "s1"))
        self.assertEqual(actions, [])

    def test_通话不受超时影响(self):
        st, actions = transition(self.in_call, tick_event(), now=100 + RING_TIMEOUT_SEC * 10)
        self.assertEqual(st.phase, IN_CALL)
        self.assertEqual(actions, [])


class 叉簧开关(unittest.TestCase):
    """微动开关语义:压住=话筒在座(挂机位),松开=拿起。响铃时拿起=接听,通话中放下=挂断。"""

    def setUp(self):
        self.ringing, _ = transition(PhoneState(IDLE), ring_event("claude", "s1"), now=100)

    def test_可接时拿起即接听(self):
        st, actions = transition(self.ringing, hook_event(off=True), now=105)
        self.assertEqual(st.phase, IN_CALL)
        self.assertEqual(actions, [
            ("post", "offhook", "claude", "s1"), ("play", "answered"),
        ])

    def test_可接时放下动作无事发生(self):
        st, actions = transition(self.ringing, hook_event(off=False), now=105)
        self.assertEqual(st.phase, RINGING)
        self.assertEqual(actions, [])

    def test_通话中放下即挂断(self):
        in_call, _ = transition(self.ringing, hook_event(off=True), now=105)
        st, actions = transition(in_call, hook_event(off=False), now=160)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(actions, [("post", "onhook", "claude", "s1"), ("play", "hangup")])

    def test_通话中重复拿起无事发生(self):
        in_call, _ = transition(self.ringing, hook_event(off=True), now=105)
        st, actions = transition(in_call, hook_event(off=True), now=110)
        self.assertEqual(st.phase, IN_CALL)
        self.assertEqual(actions, [])

    def test_待机时放下是静止位_什么都不做(self):
        """开机自检、抖动都会送一条「放下」进来。拿起那一下才是拨出(见下面那一组)。"""
        st, actions = transition(PhoneState(IDLE), hook_event(off=False), now=100)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(actions, [])


# ———————————————————— 房间那条路(2026-09-21) ————————————————————

class 房间来电(unittest.TestCase):
    """派作为 handset 进房:ring → 提机接起 → 音轨互通 → 挂机结束。"""

    def setUp(self):
        self.ringing, self.first = transition(
            PhoneState(IDLE), room_ring_event("c1", "把首页文案改一版", until=160_000), now=100)

    def test_房间来电进可接态并记下_call_id(self):
        self.assertEqual(self.ringing.phase, RINGING)
        self.assertEqual(self.ringing.source, "room")
        self.assertEqual(self.ringing.call_id, "c1")
        self.assertEqual(self.ringing.title, "把首页文案改一版")
        self.assertEqual(self.ringing.ring_until, 160)
        # ★ 2026-09-22 晚:**收到 ring 不放音**,只进「可提机接听」。
        self.assertEqual(self.first, [])

    def test_提机接起_应答再推音轨(self):
        """★ 提机 = 接起,一个字都没变(2026-09-22 晚只去掉了那条停铃动作)。"""
        st, actions = transition(self.ringing, hook_event(off=True), now=105)
        self.assertEqual(st.phase, IN_CALL)
        self.assertEqual(st.source, "room")
        self.assertEqual(st.call_id, "c1")
        self.assertEqual(actions, [("rpc", "answer", "c1"), ("audio", "on")])

    def test_一条_ring_动作里绝不出现响铃(self):
        """★ 变异检验的靶子:整条路上**一个 `("ring", …)` 都不许有**。
        铃由手机 App 出(决策记录 2026-09-22 晚「座机话筒不响铃,铃由手机出」)。"""
        seen = []
        st = PhoneState(IDLE)
        for event, now in [
            (room_ring_event("c9", "等你确认", until=160_000), 100),
            (hook_event(off=True), 105),
            (hook_event(off=False), 200),
        ]:
            st, actions = transition(st, event, now=now)
            seen.extend(actions)
        self.assertEqual([a for a in seen if a[0] == "ring"], [])

    def test_按键与提机等价(self):
        """开关没装好 / 线掉了时,POP 那颗 0xCD 是唯一还能接电话的东西。"""
        st, actions = transition(self.ringing, button_event(), now=105)
        self.assertEqual(st.phase, IN_CALL)
        self.assertEqual(actions, [("rpc", "answer", "c1"), ("audio", "on")])

    def test_挂机_先撤音轨再说挂断(self):
        in_call, _ = transition(self.ringing, hook_event(off=True), now=105)
        st, actions = transition(in_call, hook_event(off=False), now=200)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(actions, [("audio", "off"), ("rpc", "hangup", "c1"), ("play", "hangup")])

    def test_夜间静默那一通连可接态都不进(self):
        """`silent` 的语义是「压根没响过」。记一个可接态,会让他下一次拿起
        听筒接到一通根本没人在等的电话。"""
        st, actions = transition(PhoneState(IDLE), room_ring_event("c2", "完成", silent=True), now=100)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(actions, [])

    def test_ring_里没有_until_也能进可接态(self):
        """老工人(还没带 until 的那个版本)发来的 ring 不能让派崩掉;
        那时只靠 ring_end 收场,不自己编一个时限。"""
        st, actions = transition(PhoneState(IDLE), room_ring_event("c3", "完成"), now=100)
        self.assertEqual(st.phase, RINGING)
        self.assertIsNone(st.ring_until)
        self.assertEqual(actions, [])


class 手机先接起(unittest.TestCase):
    """★ 这一组是这张卡的心脏:**谁先接起谁是音频端点**。

    手机上按了「接起」→ 工人广播 `ring_end(outcome='answered')` →
    派**回待机**,一个音轨都不推。反过来(派先提机)是上一组。
    (2026-09-22 晚:以前这里还有一条「停铃」,现在派压根没响过。)
    """

    def setUp(self):
        self.ringing, _ = transition(
            PhoneState(IDLE), room_ring_event("c1", "等你确认", until=160_000), now=100)

    def test_手机接起时派回待机不推音轨(self):
        st, actions = transition(self.ringing, ring_end_event("c1", "answered"), now=103)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(actions, [])
        self.assertNotIn(("audio", "on"), actions)

    def test_未接与取消同样回待机(self):
        for outcome in ("missed", "canceled"):
            st, actions = transition(self.ringing, ring_end_event("c1", outcome), now=170)
            self.assertEqual(st.phase, IDLE)
            self.assertEqual(actions, [])

    def test_说的是别的那一通就不关我们的事(self):
        """工人那边排着队。排在后面那一通被取消,不该把这只等着人提机的听筒收掉。"""
        st, actions = transition(self.ringing, ring_end_event("c9", "canceled"), now=103)
        self.assertEqual(st.phase, RINGING)
        self.assertEqual(st.call_id, "c1")
        self.assertEqual(actions, [])

    def test_我们自己接起后那条_answered_不能把电话挂掉(self):
        """★ 我们提机的那一刻工人也会广播一条 `ring_end(answered)` —— 那是**我们自己**接的。
        拿它当「别人接了」处理的话,电话会在接通的同一秒被挂断。"""
        in_call, _ = transition(self.ringing, hook_event(off=True), now=105)
        st, actions = transition(in_call, ring_end_event("c1", "answered"), now=105)
        self.assertEqual(st.phase, IN_CALL)
        self.assertEqual(actions, [])


class 房间可接态的保险丝(unittest.TestCase):
    """ring_end 丢了怎么办。**不是第二个超时** —— 到点只回待机,不向工人发任何东西。"""

    def setUp(self):
        self.ringing, _ = transition(
            PhoneState(IDLE), room_ring_event("c1", "等你确认", until=160_000), now=100)

    def test_过了_until_加宽限就回待机(self):
        st, actions = transition(self.ringing, tick_event(), now=160 + RING_UNTIL_GRACE_SEC + 1)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(actions, [])

    def test_宽限期内还可接(self):
        st, actions = transition(self.ringing, tick_event(), now=160 + RING_UNTIL_GRACE_SEC)
        self.assertEqual(st.phase, RINGING)
        self.assertEqual(actions, [])

    def test_到点不发_missed_也不发_later(self):
        """8791 那条老路的 missed 是派报的(没别人管);房间这条**工人自己会收场**,
        派再补一条只会去动一通已经结束的电话。"""
        _, actions = transition(self.ringing, tick_event(), now=100_000)
        self.assertEqual([a for a in actions if a[0] in ("rpc", "post")], [])

    def test_没有_until_时永远不自己停(self):
        """老工人发来的 ring 没有 until。这时只认 ring_end —— 自己编一个时限,
        会在工人还在响的时候把派这边停掉。"""
        ringing, _ = transition(PhoneState(IDLE), room_ring_event("c3"), now=100)
        st, actions = transition(ringing, tick_event(), now=100_000)
        self.assertEqual(st.phase, RINGING)
        self.assertEqual(actions, [])


# ———————————————— 提机即拨出(2026-09-23,Ben 定) ————————————————

class 提机即拨出(unittest.TestCase):
    """待机时拿起听筒 = 直接接通事务官(设计-座机整体体验 第六节第 4 条)。

    「他自己打的那一通」和「接起来的那一通」在这个状态机里是同一个 `IN_CALL`:
    挂断那一支逐字共用,不另开一个状态 —— 放下听筒就是放下听筒,不该有两种挂法。
    """

    def setUp(self):
        self.dialing, self.first = transition(PhoneState(IDLE), hook_event(off=True), now=100)

    def test_拿起就发_start_并推音轨(self):
        self.assertEqual(self.dialing.phase, IN_CALL)
        self.assertEqual(self.first, [("rpc", "start", ""), ("audio", "on")])

    def test_这一下不放铃声也不放拨号音(self):
        """★ 变异检验的靶子:铃在手机上,而这一通是他自己打的,没有人需要被叫。"""
        self.assertEqual([a for a in self.first if a[0] == "play"], [])

    def test_放下就是挂断_和接起来的那通同一条路(self):
        st, actions = transition(self.dialing, hook_event(off=False), now=160)
        self.assertEqual(st.phase, IDLE)
        # hangup 不带 call_id:工人那条本来就不要(rpc.ts 只校验 answer / later)。
        self.assertEqual(actions, [("audio", "off"), ("rpc", "hangup", ""), ("play", "hangup")])

    def test_工人半天没接上也一直等着_不自己收场(self):
        """★ 放下前一直等(卡上的硬要求)。拿一个超时把这通掐了,
        表现是「说着说着电话自己断了」,而他手里的听筒还举着。"""
        st, actions = transition(self.dialing, tick_event(), now=100_000)
        self.assertEqual(st.phase, IN_CALL)
        self.assertEqual(actions, [])

    def test_通话中再拿起一次忽略_不再拨一通(self):
        """抖动、或者他把听筒换了只手。再发一条 start 就是两通电话叠在一只听筒上。"""
        st, actions = transition(self.dialing, hook_event(off=True), now=105)
        self.assertEqual(st.phase, IN_CALL)
        self.assertEqual(actions, [])

    def test_拨出途中来的真来电不插队(self):
        """工人那边排着的电话照旧排着 —— 他正讲着话,不该被一通新的顶掉。"""
        st, actions = transition(self.dialing, room_ring_event("c9", "等你确认"), now=120)
        self.assertEqual(st.phase, IN_CALL)
        self.assertIsNone(st.call_id)
        self.assertEqual(actions, [])


class 全程一遍(unittest.TestCase):
    """ring → offhook → 通话 → onhook,一条路走完,按顺序把动作记下来。"""

    def test_房间那条路的全程(self):
        seen = []
        st = PhoneState(IDLE)
        for event, now in [
            (room_ring_event("c1", "等你确认", until=160_000), 100),
            (hook_event(off=True), 104),              # 拿起听筒
            (ring_end_event("c1", "answered"), 104),  # 工人广播:这一通有人接了(就是我们)
            (tick_event(), 130),                      # 通话中,时钟不该做任何事
            (hook_event(off=False), 190),             # 放回去
        ]:
            st, actions = transition(st, event, now=now)
            seen.extend(actions)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(seen, [
            # ★ 2026-09-22 晚:整条路上**一次响铃都没有**(铃由手机 App 出)。
            ("rpc", "answer", "c1"), ("audio", "on"),
            ("audio", "off"), ("rpc", "hangup", "c1"), ("play", "hangup"),
        ])

    def test_他自己拨出去那一通的全程(self):
        """提机 → 讲 → 放下。整条路上没有 answer、没有铃、没有超时。"""
        seen = []
        st = PhoneState(IDLE)
        for event, now in [
            (hook_event(off=True), 100),   # 待机拿起 = 拨出去
            (tick_event(), 130),           # 工人还没接上,一直等
            (tick_event(), 400),
            (hook_event(off=False), 460),  # 放回去 = 挂断
        ]:
            st, actions = transition(st, event, now=now)
            seen.extend(actions)
        self.assertEqual(st.phase, IDLE)
        self.assertEqual(seen, [
            ("rpc", "start", ""), ("audio", "on"),
            ("audio", "off"), ("rpc", "hangup", ""), ("play", "hangup"),
        ])


if __name__ == "__main__":
    unittest.main()
