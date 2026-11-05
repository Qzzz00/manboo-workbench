/**
 * 电话里「新开一条发给 X」(`POST /sessions/relay {new_conversation:true}`)的那一段:**送 → 登记回电 → 说实话**。
 *
 * 2026-09-30 晚(Air 诊断包 195508,故障 ②):壳按了发送、对话区里当场没核上(`status:'typed'`),
 * 这里以前直接回「没发出去」、**回电也不登记** —— 豆包其实收到了、两分钟后就回了,电话一直没来。
 *
 * 维护者定的验收口径:指派记录 → 指令投递 → 完成事件 → 电话打通,**任一步失败都明确报失败**。于是这里分三档说:
 * - `sent`:在它对话区里看见了 → 登记回电;
 * - `unconfirmed`:按了发送、没当场看见 → **照样登记回电**(巡检读到这句话才算核上;一直读不到,等过头时回电明说
 *   「没核实到发出去」),回 ok,说清「没看见它收下,先别重发」;
 * - `failed`:壳没接下 / 送不了 → ok:false,「这句话没发出去」+ 原因,一条回电都不登记。
 * 回电登记不上(跟踪服务没接、落不了盘)也明说「它回了我不会自己打电话」—— 不许留一个永远不来的电话。
 */
import type { ClientDispatch } from './dispatchSend.ts'
import type { RelayFrom, RelayWatchService } from './relayWatch.ts'
import {
  RELAY_PROMISE_CALL,
  RELAY_PROMISE_CALL_UNSURE,
  RELAY_PROMISE_NOWATCH,
  RELAY_PROMISE_NOWATCH_UNSURE,
} from './relayWatch.ts'
import { relayMark, relayPrompt, relayReadMark } from './sessionRelay.ts'

export interface NewConversationRelayDeps {
  send: ClientDispatch['send']
  /** 回电那本轻账。缺席 = 这台没接跟踪服务。 */
  watch?: Pick<RelayWatchService, 'remember'>
  newId: () => string
}

export interface NewConversationRelayInput {
  /** 家名(`doubao`)。 */
  family: string
  /** 说给她听的名字(「豆包」)。 */
  title: string
  /** 她的原话(一个字不改)。 */
  text: string
  from: RelayFrom
  overwrite?: boolean
  /**
   * ★ **她明说了「回了打电话给我」**(2026-10-04,卡 `claude/relay-call-optin`;
   * 电话里的判据是她的原话,见 `channel-worker/src/relayIntent.ts` 的 `callBack`)。
   *
   * 缺省(缺席)= **一条回电都不登记**(卡 `claude/relay-nocall-noread`,维护者原话「可以不读」):
   * 新开那一条照开、她的原话照送,只是不盯、不读那扇窗 —— 它回的那句就留在新开的那条会话里。
   */
  callOnReply?: boolean
}

export interface NewConversationRelayOutcome {
  ok: boolean
  /** 投递那一步到哪了。 */
  delivered: 'sent' | 'unconfirmed' | 'failed'
  /** 回电登记上了没有。 */
  watched: boolean
  note: string
  mark?: string
}

export async function relayIntoNewConversation(deps: NewConversationRelayDeps, input: NewConversationRelayInput): Promise<NewConversationRelayOutcome> {
  const newId = deps.newId()
  const mark = relayReadMark(input.text) || relayMark(newId)
  const sent = await deps.send({
    family: input.family,
    text: relayPrompt({ sessionId: newId, said: input.text }),
    confirmMarker: mark,
    submit: true,
    newConversation: true,
    ...(input.overwrite === true ? { overwrite: true } : {}),
  })
  const status = sent.dispatch?.status
  if (!sent.ok || (status !== 'sent' && status !== 'typed')) {
    const reason = sent.reason ?? sent.dispatch?.reason ?? '壳没有接下这一句'
    const note = /没(?:送|发)出去/.test(reason) ? reason : `这句话没发出去:${reason}`
    return { ok: false, delivered: 'failed', watched: false, note }
  }
  const delivered = status === 'sent' ? 'sent' : 'unconfirmed'
  /*
   * 协议那条路(Codex `thread/start`、Claude socket)当场就报了新开的是哪一条,送话那一层已经把它
   * 存进 `dispatch.session_id`。有就按它登记:巡检拿真号去 `thread/resume`,读得到它的回答。
   * 没报(窗口型那几家)才用本地占位号 —— 占位会被巡检翻成「它此刻开着的那条」,而协议认不出那一种。
   */
  const reported = sent.dispatch?.session_id?.trim() ?? ''
  const sessionId = reported === '' ? newId : reported
  let watched = false
  /*
   * ★ **她没明说要回电 = 不登记、不盯、不读**(2026-10-04 下午,卡 `claude/relay-nocall-noread`)。
   * 上午那一版还登记、还巡检,只是那一通不响;维护者追了一句「不勾的时候可以不读」之后收到底。
   */
  if (deps.watch !== undefined && input.callOnReply === true) {
    try {
      await deps.watch.remember({
        agent: input.family,
        session_id: sessionId,
        // 新开的那条到底是哪一条认不出时如实标占位,键不冒充会话键。
        ...(reported === '' ? { session_placeholder: true as const } : {}),
        // 哪一轮也带上(协议型报的;2026-10-03):巡检只认这一轮,不拿她后来那一轮顶。
        ...(sent.dispatch?.turn_id === undefined ? {} : { turn_id: sent.dispatch.turn_id }),
        title: '新会话',
        mark,
        from: input.from,
        ...(sent.bundle_id === undefined ? {} : { bundle_id: sent.bundle_id }),
        ...(delivered === 'unconfirmed' ? { unconfirmed: true } : {}),
      })
      watched = true
    }
    catch { watched = false }
  }
  const who = input.title
  const head = delivered === 'sent'
    ? `已给${who}新开会话并发送。`
    : `已给${who}新开会话并按了发送,但还没在它对话区里看到这句话,先别重发。`
  /*
   * ★ 2026-10-04(卡 `claude/relay-call-optin`):许的那一句照**她勾没勾**说。
   * 两套文案都在 `relayWatch.ts` 的常量里(断言照常量,不逐字抄)。
   */
  const tail = input.callOnReply !== true
    // 她没明说要那一通:不盯、不读,照实说回话会留在哪儿(两句都是常量)。
    ? (delivered === 'sent' ? RELAY_PROMISE_NOWATCH : RELAY_PROMISE_NOWATCH_UNSURE)
    : watched
      ? (delivered === 'sent' ? RELAY_PROMISE_CALL : RELAY_PROMISE_CALL_UNSURE)
      : (delivered === 'sent'
          ? `但回电没登记上 —— 它回了我不会自己打电话,要你去${who}里看。`
          : `回电也没登记上 —— 它回了我不会自己打电话,去${who}窗口里看一眼是不是还停在输入框里。`)
  const extra = sent.package_note === undefined ? '' : `(${sent.package_note})`
  return { ok: true, delivered, watched, note: `${head}${tail}${extra}`, mark }
}
