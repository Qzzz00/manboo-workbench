"""房间里那几条 JSON 信号(2026-09-21)。**纯函数,不认识 LiveKit、不发一个字节。**

形状与 `channel-worker/src/callOut.ts`、`channel-worker/src/rpc.ts` **逐字相同**,
协议写在 `docs/设计-座机信号协议-2026-09-21.md`。两个仓库不互相 import ——
这是本仓库既有的做法(见 channel-worker/src/callOut.ts 顶部那一段),所以这份是
**第二份手抄**,字段名错一个字就是整条链不通,改它之前先去看那份文档。

为什么单独一个文件:派上那几条线(GPIO、音频、房间)各有各的失败方式,
而「这条 JSON 长什么样」必须能在 Mac 上、不插话筒、不起房间的情况下单测。
"""
import json
import uuid

# ———————————————————————— topic ————————————————————————

#: 控制通道的 topic。与 workbench-plugin/src/server/channel.ts 的 CHANNEL_RPC_TOPIC
#: 和 channel-worker/src/rpc.ts 的 RPC_TOPIC 是同一个字符串。
RPC_TOPIC = "wb.rpc"

#: 派在房里的参与者种类。手机是 'phone',派是 'handset'(签在凭证属性里,自己改不了)。
KIND_HANDSET = "handset"


# ———————————————————————— 工人 → 房间 ————————————————————————

def parse_room_signal(raw: str) -> dict:
    """一行 JSON → 一条给状态机吃的事件;不认识的一律 `{}`(**绝不抛**)。

    房间里这条通道上跑着好几种东西(字幕 `caption`、缓冲语 `filler`、来电 `ring`、
    收场 `ring_end`、还有回给我们自己的 rpc 应答)。派**只关心来电那两条**,
    别的原样忽略 —— 工人哪天多发一种新信号,派不该因此崩掉。
    """
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(msg, dict):
        return {}
    kind = msg.get("type")
    if kind == "ring":
        call_id = msg.get("call_id")
        if not isinstance(call_id, str) or call_id == "":
            return {}
        until = msg.get("until")
        return {
            "kind": "ring",
            "source": "room",
            "call_id": call_id,
            "title": msg.get("title") if isinstance(msg.get("title"), str) else "",
            "reason": msg.get("reason") if isinstance(msg.get("reason"), str) else "",
            # 夜间静默那一通**压根不响**:手机收到它只弹一条通知,派什么都不做。
            "silent": msg.get("silent") is True,
            # 毫秒时间戳。缺了就当没有,靠工人的 ring_end 收场(别自己编一个时限)。
            "until": until if isinstance(until, (int, float)) else None,
        }
    if kind == "ring_end":
        call_id = msg.get("call_id")
        if not isinstance(call_id, str) or call_id == "":
            return {}
        return {
            "kind": "ring_end",
            "call_id": call_id,
            "outcome": msg.get("outcome") if isinstance(msg.get("outcome"), str) else "",
            "text": msg.get("text") if isinstance(msg.get("text"), str) else "",
        }
    return {}


def rpc_response_of(raw: str) -> dict:
    """工人回给我们的那条应答(`{id,type:'call',ok,error?}`)。读不懂回 `{}`。"""
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(msg, dict):
        return {}
    if msg.get("type") != "call" or not isinstance(msg.get("id"), str):
        return {}
    return {"id": msg["id"], "ok": msg.get("ok") is True,
            "error": msg.get("error") if isinstance(msg.get("error"), str) else ""}


# ———————————————————————— 派 → 工人 ————————————————————————

#: 四条动作,与 channel-worker/src/rpc.ts 的 `CALL_RPC_ACTIONS` 逐字对应。
ACTION_START = "start"     # **提机即拨出**:待机时拿起听筒,直接接通事务官(2026-09-23)
ACTION_ANSWER = "answer"   # 提机 offhook:接那一通正在响的
ACTION_LATER = "later"     # 「稍后」——派没有这颗键,留着对齐协议
ACTION_HANGUP = "hangup"   # 挂机 onhook


def call_request(action: str, call_id: str = "", req_id: str = "") -> str:
    """拼一条 `wb.rpc` 上的请求。

    `call_id` 对 **answer / later** 必带(工人会校验):铃刚好在他拿起听筒
    那一刻超时的话,不带 id 就会接起**下一通**而以为接的是上一通
    (channel-worker/src/rpc.ts 里那段注释说的就是这件事)。

    `start` / `hangup` 不要它:前者是他自己拨出去的一通(压根还没有 id),
    后者说的就是「我这只听筒上正在讲的这通」。空的时候**整个字段不发** ——
    发一个 `"call_id": null` 过去,工人那边读出来是空串,而日志里看着像带了 id。
    """
    body = {
        "id": req_id or uuid.uuid4().hex,
        "type": "call",
        "action": action,
    }
    if call_id:
        body["call_id"] = call_id
    return json.dumps(body, ensure_ascii=False)
