"""来电状态机(纯函数)。

三个状态:待机 → **可提机接听** → 通话中。真正的副作用(发一条 `wb.rpc`、推不推音轨)
由调用方按返回的动作列表执行,这里不碰 IO、不认识 LiveKit、不认识 ALSA。

还有一条捷径:**待机时拿起听筒直接进「通话中」**(见下面「提机即拨出」)。

## 派**不响铃**(2026-09-22 晚,Ben 定)

> 响铃应该是手机发出,而不是话筒,话筒自己是用来对话的。

所以中间那一档从「响铃中」变成了**「可提机接听」**:派收到 `ring` 只是把叉簧的下一次
「拿起」认成「接这一通」,**一声都不出**。铃由手机 App 出(它和派收的是同一条广播)。

为什么状态名还叫 `RINGING`:它说的是「有一通电话正在等人接」,这件事没变 ——
改名字要连着台账、日志、两份用例一起改,而那和 Ben 要的那件事无关。
文档与日志里一律叫它「可提机接听」。

## 提机即拨出(2026-09-23,Ben 定)

`docs/设计-座机整体体验-2026-09-22.md` 第六节第 4 条:「提机时没有来电 → 直接接通事务官」。
真座机这时是拨号音 + 拨号;这台**只有一个号码可拨**,所以拿起听筒本身就是拨过去:
往房里发一条 `call/start`(工人本来就认这个动作),工人把接话对象钉到这只听筒上、
开口说一句;放下 = 挂断,和接起来的那一通逐字同一条 `_hangup`。

三条纪律:
1. **不放铃声、不放拨号音**:铃在手机上(第二节第 3 条),而这一通是他自己打的,
   没有人需要被叫;听筒里除了她的声音不该有别的动静。
2. **不自己收场**:工人没接上就一直等到他放下。拿一个超时把这通掐了,
   表现是「说着说着电话自己断了」,而他手里的听筒还举着。
3. **工人不在房里时听筒里就什么都没有**:这一层是纯函数,它不知道房间在不在,
   照常吐 `("rpc","start")`;发不出去由调用方记一行日志(popphone.run_phone),
   **不假装接通了**,也不退回 8791 那条老路 —— 那条路没有音频,拨过去也听不见人。

## 两条来路,一个状态机(2026-09-21)

- **房间**(`source='room'`):派作为 `handset` 进 LiveKit 房,工人广播 `ring`,
  派回 `call/answer`(=提机)与 `call/hangup`(=挂机)。通话音频走房间。
- **8791 的 WS**(`source='live'`,来电链 v0,2026-08 起就在跑的那条):
  工人够不着、或者房间没配起来时的兜底。它**只有响铃没有音频** ——
  派照样响、照样上报 `offhook`/`onhook` 给 `/phone/event`,但听筒里不会有人说话。

两条并成一个状态机而不是两份:叉簧只有一根,状态只有一个。两份状态迟早会
一个以为在通话、另一个还在响铃,而听筒是同一只。

## 输入设备

叉簧微动开关(GPIO17,压住=在座、松开=拿起)是主输入;POP 的那颗
播放/暂停键(HID 0xCD)**等价**,留作开关没装好 / 线掉了时的后备
(硬件文档第 2 条:POP 本身没有摘机信号)。
"""
from dataclasses import dataclass
from typing import Optional

IDLE = "idle"
RINGING = "ringing"
IN_CALL = "in_call"

# 无人提机的自动收场时限(**只对 8791 那条老路生效**)。对齐 display-client
# useRingingTimeout 的 25 秒来电语义,与工作台的 10 分钟响铃冷却是两回事。
#
# 房间那条路**不用这个数**:工人自己有 60 秒(callOut.ts 的 RING_TIMEOUT_MS),
# 到点它会广播 ring_end。派再自己算一份就是两个时钟,而那两个数不一样。
RING_TIMEOUT_SEC = 25

# 房间那条路的兜底时限:`ring` 里带的 `until`(毫秒)之外再宽限这么多秒。
# 它**不是**第二个超时,是「ring_end 那条消息丢了」时不至于永远停在「可提机接听」的保险丝
#(那会让下一次拿起听筒接到一通早就结束的电话)。
# 5 秒:比一次数据通道重发长,比人的耐心短。
RING_UNTIL_GRACE_SEC = 5


@dataclass(frozen=True)
class PhoneState:
    phase: str = IDLE
    #: 这一通从哪条路来的:'room'(LiveKit 房间)或 'live'(8791 的 WS)。待机时为 None。
    source: Optional[str] = None
    #: 房间那条路的一通电话的 id。**answer / hangup 必带**。
    call_id: Optional[str] = None
    title: Optional[str] = None
    #: 8791 那条老路用的两个字段。
    agent: Optional[str] = None
    session_id: Optional[str] = None
    ringing_since: Optional[int] = None
    #: 响到什么时候为止(秒;由 ring 的 `until` 毫秒换算)。房间那条路才有。
    ring_until: Optional[int] = None


# ———————————————————————— 事件构造器 ————————————————————————

def ring_event(agent: str, session_id: str) -> dict:
    """8791 那条老路的起铃。"""
    return {"kind": "ring", "source": "live", "agent": agent, "session_id": session_id}


def room_ring_event(call_id: str, title: str = "", silent: bool = False,
                    until: Optional[float] = None) -> dict:
    """房间那条路的起铃。`until` 是毫秒时间戳(工人算的),可缺。"""
    return {"kind": "ring", "source": "room", "call_id": call_id, "title": title,
            "silent": silent, "until": until}


def ring_end_event(call_id: str, outcome: str = "", text: str = "") -> dict:
    """工人说这一通完了。**最要紧的一种是 outcome='answered' 而接的人不是我们** ——
    手机先按了接起,派要立刻回待机,并且**一个音轨都不推**。"""
    return {"kind": "ring_end", "call_id": call_id, "outcome": outcome, "text": text}


def button_event() -> dict:
    return {"kind": "button"}


def tick_event() -> dict:
    return {"kind": "tick"}


def hook_event(off: bool) -> dict:
    """叉簧开关:off=True 拿起(开关松开),off=False 放下(开关被话筒压住)。"""
    return {"kind": "hook", "off": off}


# ———————————————————————— 状态迁移 ————————————————————————

def _answer(state: PhoneState):
    """可提机接听 → 通话。

    2026-09-22 晚:**不再有 ("ring","stop")** —— 派压根没响过(铃在手机上)。
    """
    if state.source == "room":
        return (
            PhoneState(IN_CALL, source="room", call_id=state.call_id, title=state.title),
            [
                ("rpc", "answer", state.call_id),
                # 音轨在这一刻才推。待机时不推 —— 省电、省流量,而且一只常年开着的
                # 麦克风摆在桌上本身就不该(设计-座机信号协议 §五)。
                ("audio", "on"),
            ],
        )
    return (
        PhoneState(IN_CALL, source="live", agent=state.agent, session_id=state.session_id),
        [("post", "offhook", state.agent, state.session_id), ("play", "answered")],
    )


def _dial_out():
    """待机 → 通话:**他自己打的那一通**(2026-09-23,见文件头「提机即拨出」)。

    `call_id` 是空的:这一通不是工人排出来的,没有 id 可带 —— 而 `start` 恰好是
    `CALL_RPC_ACTIONS` 里**唯一不校验 call_id** 的那一条(rpc.ts:answer / later 才必带)。
    放下时照常走 `_hangup`,发的 `hangup` 同样不要 id。

    顺序与 `_answer` 逐字一致(先说话再推音轨):她的开场白走的是工人 → 听筒那一路,
    和这只听筒推不推麦克风没有关系,所以先把话拨出去,让工人那头早一点开始。
    """
    return (
        PhoneState(IN_CALL, source="room"),
        [("rpc", "start", ""), ("audio", "on")],
    )


def _hangup(state: PhoneState):
    """通话 → 待机。**先撤音轨再说挂断**:反过来的话,工人已经在收场了而听筒还开着。"""
    if state.source == "room":
        return (
            PhoneState(IDLE),
            # `or ""`:提机即拨出的那一通没有 call_id,而工人的 hangup 本来就不要它。
            [("audio", "off"), ("rpc", "hangup", state.call_id or ""), ("play", "hangup")],
        )
    return (
        PhoneState(IDLE),
        [("post", "onhook", state.agent, state.session_id), ("play", "hangup")],
    )


def transition(state: PhoneState, event: dict, now: int):
    """吃 (状态, 事件, 当前秒),吐 (新状态, 动作列表)。

    动作是这四种元组之一,调用方各自翻译:
      ("rpc", 动作, call_id)          → 往 `wb.rpc` 发一条(房间那条路)
      ("post", 类型, agent, sid)      → POST /phone/event(8791 那条老路)
      ("audio", "on"|"off")           → 推 / 撤麦克风音轨(顺带订 / 退听筒)
      ("play", 音效名)                → 放一小段提示音

    **`("ring", …)` 2026-09-22 晚整条去掉了**:铃由手机 App 出,派不响铃(Ben 定)。
    popphone.py 里那一支接线还留着(它还认得这个动作),只是再也不会收到了 ——
    等配网那张卡合完由统筹一起清掉。
    """
    kind = event.get("kind")

    if state.phase == IDLE:
        if kind == "ring":
            # 夜间静默那一通压根不是来电:手机收到它只弹一条通知,派**连「可接」都不进**。
            # 记一个「可提机接听」,会让下一次拿起听筒接到一通根本没人在等的电话。
            if event.get("silent") is True:
                return state, []
            # **一个动作都没有**(2026-09-22 晚):进「可提机接听」是一件纯状态的事,
            # 派不出声。铃在手机上 —— 它和派收的是同一条广播。
            if event.get("source") == "room":
                until_ms = event.get("until")
                return PhoneState(
                    RINGING, source="room", call_id=event.get("call_id"),
                    title=event.get("title") or "", ringing_since=now,
                    ring_until=None if until_ms is None else int(until_ms / 1000),
                ), []
            return PhoneState(
                RINGING, source="live", agent=event.get("agent"),
                session_id=event.get("session_id"), ringing_since=now,
            ), []
        # ——— 提机即拨出(2026-09-23,Ben 定;文件头有整段理由) ———
        # 没有电话却拿起听筒 = **直接接通事务官**。发的是 `start` 不是 `answer`:
        # answer 是「接那一通正在响的」,而这会儿一通都没有,凭空 answer 会被工人如实回绝。
        # 按键与叉簧在这里同样等价(硬件文档第 2 条:POP 自己没有摘机信号)。
        if kind == "button" or (kind == "hook" and event["off"]):
            return _dial_out()
        # 放下(开关被压住)是静止位:待机时收到它是开机自检或抖动,忽略。
        return state, []

    if state.phase == RINGING:
        # 放下(开关被压住)是静止位,等人接的那段时间里收到它是开机自检或抖动,忽略。
        if kind == "hook" and not event["off"]:
            return state, []
        if kind in ("button", "hook"):
            return _answer(state)
        if kind == "ring_end":
            # **手机先接起了**(outcome='answered' 而我们没接过),或者超时 / 被取消。
            # 一律回待机,**不推音轨**:音频端点是先接起的那一台。
            if event.get("call_id") != state.call_id:
                return state, []  # 说的是别的那一通(排着的),不关这只听筒的事
            return PhoneState(IDLE), []
        if kind == "tick":
            if state.source == "room":
                # 房间那条路的保险丝:ring_end 丢了才会走到这儿(见 RING_UNTIL_GRACE_SEC)。
                # **不发 later、不发任何东西** —— 工人那边早已按自己的时钟收过场了,
                # 派再补一条只会去动一通已经结束的电话。
                if state.ring_until is not None and now > state.ring_until + RING_UNTIL_GRACE_SEC:
                    return PhoneState(IDLE), []
                return state, []
            if state.ringing_since is not None and now - state.ringing_since > RING_TIMEOUT_SEC:
                # 8791 那条老路没有别人替我们收场,所以这条 missed 要派自己报。
                return PhoneState(IDLE), [("post", "missed", state.agent, state.session_id)]
            return state, []
        # 等人接的那段时间里来的新来电不插队:一次只处理一通(工人那边本来就排着队)。
        return state, []

    if state.phase == IN_CALL:
        # 通话中重复「拿起」忽略(抖动、或者他把听筒换了只手)。
        if kind == "hook" and event["off"]:
            return state, []
        if kind in ("button", "hook"):
            return _hangup(state)
        # 我们接起来那一刻工人会广播一条 ring_end(outcome='answered')——
        # **那是我们自己接的**,不能拿它把刚接通的电话挂掉。
        return state, []

    return state, []
