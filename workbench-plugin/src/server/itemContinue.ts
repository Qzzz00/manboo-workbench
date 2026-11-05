/**
 * ★ **同事项接续的来源与动作契约**(2026-10-23,卡 A `t-0c770bc0`;交接 `docs/交接-1023-协作A同事项接续.md`)。
 *
 * 一件事从电脑 / 手机「继续」时,先由 `GET /butler/item/:id/continue` 下发这条事项的来源清单
 * (它自己的事务官会话 + `links` 里的外部会话,各能不能这会儿接着发话),再由
 * `POST /butler/item/continue` 把一句话发到明确的那一条来源、把结果翻成
 * 「记下了 / 留着等它醒 / 送到了(还没核上) / 这条路走不通 / 要先选来源」那一档。
 *
 * 三条纪律:
 *   - **判据全部来自既有的门,一处不重写**:外部会话能不能捎 = `sessionAnswer.relayReady`
 *     (与 `GET /sessions/digest` 里 relay 那一格同一个出处);真发话 = `sessionAnswer.relay`
 *     (与 `POST /sessions/relay` 同一条路)。这里只做**组装与翻译**。
 *   - **不猜最新**:目标没指明、能续的多条 → 回 `pick` 让调用方选;没有能续的 → 如实说。
 *   - **永不报 started**(protocol.ts ItemContinueFact 那段):发一句话报不出「它开工了」。
 */
import type { ItemContinueAction, ItemContinueSource, ItemContinueFact, ItemSayIntent, TaskView } from '../protocol.ts'
import { ITEM_CONTINUE_BUTLER_KEY, ITEM_SAY_INTENTS } from '../protocol.ts'
import type { RelayResult } from './sessionAnswer.ts'
import { SESSION_CLOSED_QUEUED_SAY } from './sessionClosed.ts'

export const BUTLER_SOURCE_KEY = ITEM_CONTINUE_BUTLER_KEY

/**
 * 事实档全集(用例钉着):卡 A 的六档 + 卡「事务官机制A」的 redirected / recalled。
 * 仍然没有 started —— 发一句话报不出「它开工了」,改方向 / 撤回也一样。
 */
export const CONTINUE_FACTS: readonly ItemContinueFact[] = ['saved', 'kept', 'sent', 'failed', 'unsupported', 'pick', 'redirected', 'recalled']

/* ──────────────────── 同事项四意图(2026-10-26,卡「事务官机制A」)──────────────────── */

/**
 * 认请求里的 `intent`:缺席 = 补充(**旧调用逐字兼容**,卡 A 之前的行为一个字不变);
 * 带错 = 拒 —— 「改向」被静默当普通补话,正是这张卡要治的那个病(新交代被旧的等待挡住,
 * 过期方案继续跑)。frame 是固定模板,一处实现,不经模型。
 */
export function parseItemSayIntent(raw: unknown): { ok: true, intent: ItemSayIntent } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, intent: 'supplement' }
  if (typeof raw === 'string' && (ITEM_SAY_INTENTS as readonly string[]).includes(raw)) {
    return { ok: true, intent: raw as ItemSayIntent }
  }
  return { ok: false }
}

/**
 * 一种意图怎么落地(纯方案,http.ts 照它执行):
 *   - `mode`:'queue' 排进会话(不打断)/ 'steer' 打断正在跑的轮次、这句在最近的 step 进
 *     (DSH `prompt({mode})` → `agent.followup` / `agent.steer`,上游源码已核);
 *   - `fallbackQueueWhenIdle`:这版会话**没在跑**时 steer 没有意义(没有要打断的),
 *     退化成 queue —— 空闲时两种模式都等于开头,但回执照实说没打断;
 *   - `cancelFirst`(只撤回):先 `sessionController.cancel` 停住在跑的那一轮
 *     (cancel 走 keepInbox,上游 commands.cancel 已核);
 *   - `clearFirst`(改方向 / 撤回):先把队列里经工作台递进去的旧句作废
 *     (旧队列不复活;DSH 页面上手敲的不动;作废的句子原文留在卡上,一句不丢);
 *   - `noSay`(只撤回):**一个字都不往会话里递** —— 递了等于又把它叫醒跑一轮,
 *     交代写在卡的留言里;
 *   - `frame`:递进去的整句。**supplement 没有框 = 原话直发** —— 旧调用发出去的字节
 *     一个字都不能变;其余带固定框,把「旧方案作废 / 别干等 / 别再办别再派」说清楚,
 *     这是「改向后旧队列不复活、无二派」的交代,不经模型、不编。撤回没有会话句,frame 只落卡。
 */
export interface ItemIntentPlan {
  intent: ItemSayIntent
  mode: 'queue' | 'steer'
  fallbackQueueWhenIdle: boolean
  cancelFirst: boolean
  clearFirst: boolean
  noSay: boolean
  /** 递进去的整句;supplement 返回 undefined(原话直发)。撤回:只落卡不进会话。 */
  frame: (taskId: string, text: string) => string | undefined
  /** 行为账「结果」那一格的字。 */
  label: string
}

export function intentPlanOf(intent: ItemSayIntent): ItemIntentPlan {
  switch (intent) {
    case 'redirect':
      return {
        intent,
        mode: 'steer',
        fallbackQueueWhenIdle: true,
        cancelFirst: false,
        clearFirst: true,
        noSay: false,
        label: '改方向',
        frame: (taskId, text) =>
          `【改方向 · 事项 ${taskId}】先停下手头这套做法,以这句为准:${text}\n刚才那套办法就此作废;已经派出去还没回的那一路别再追、也别派第二路,等它交回时只核对已做完的部分(做完的保留),做一次简短交接。`,
      }
    case 'hurry':
      return {
        intent,
        mode: 'steer',
        fallbackQueueWhenIdle: true,
        cancelFirst: false,
        clearFirst: false,
        noSay: false,
        label: '催一下',
        frame: (taskId, text) =>
          `【加速 · 事项 ${taskId}】这件催一下:${text}\n计划不变。如果正卡在等某个作者先给回声,去催它或自己接手,别干等。`,
      }
    case 'recall':
      return {
        intent,
        mode: 'queue',
        fallbackQueueWhenIdle: false,
        cancelFirst: true,
        clearFirst: true,
        noSay: true,
        label: '撤回',
        frame: (taskId, text) =>
          `【撤回 · 事项 ${taskId}】这件先撤下,别再办、别再派、也别再开新的作者;做到哪了留一句交接。${text.trim() === '' ? '' : `撤下的原因:${text.trim()}`}`,
      }
    case 'supplement':
      return { intent, mode: 'queue', fallbackQueueWhenIdle: false, cancelFirst: false, clearFirst: false, noSay: false, label: '补一句', frame: () => undefined }
  }
}

/**
 * 意图落地后的那一句回执(照实现时的事实说,不编):
 *   - `wasRunning` 发送前这条会话在不在跑 —— steer 打断了才说「打断」,没在跑不假装;
 *   - 撤回的 `cancelled` 是 cancel 的真回执:`ok:false`(老宿主停不了)= 撤回没办成,如实说;
 *   - `cleared` 是作废掉的排队旧句:有就说「一并作废,已留在卡上」—— 那些话没丢,卡上留着。
 */
export function intentReceiptOf(
  intent: ItemSayIntent,
  fact: {
    wasRunning: boolean | undefined
    cancelled?: { ok: boolean, running?: boolean, why?: string }
    cleared?: readonly string[] | undefined
  },
): string {
  const running = fact.wasRunning === true
  const clearedNote = (fact.cleared?.length ?? 0) > 0 ? `前面排着的 ${fact.cleared?.length} 句旧话一并作废,已留在卡上,要再用请重发。` : ''
  switch (intent) {
    case 'redirect':
      return (running
        ? '改方向送进去了 —— 正在跑的那一轮已被打断,旧的做法就此作废,以你这句为准。'
        : '改方向送进去了 —— 它这会儿没在跑,这句一到就按新办,旧的做法就此作废。') + clearedNote
    case 'hurry':
      return running
        ? '催到了 —— 它正在跑的那一轮被打断了一下,这句递进它手里了。'
        : '催到了 —— 它这会儿没在跑,这句一到它就接手催,别干等那句也说给它了。'
    case 'recall': {
      const cancelled = fact.cancelled
      if (running && (cancelled === undefined || !cancelled.ok)) {
        return `想撤,但这条会话这会儿停不住(${cancelled?.why ?? '这一版没有停会话的那颗键'})—— 撤回没办成,它还在跑,请到电脑上手动停。`
      }
      return (running
        ? '撤回了 —— 正在跑的那一轮已停住,这件挪回待排。'
        : '撤回了 —— 它这会儿没在跑,没有要停的;这件挪回待排。') + clearedNote
    }
    case 'supplement':
      return '捎到了 —— 你那句话已经送进事务官那条会话里了。'
  }
}

/** relay(外部会话)那条路只捎得动原话:非补充意图如实回 unsupported,不假装已改向。 */
export function intentUnsupportedWhy(intent: ItemSayIntent, where: string): string | undefined {
  if (intent === 'supplement') return undefined
  const label = intentPlanOf(intent).label
  return `${where}那条会话这条路只能把话原样捎过去,打断 / 停住它办不到 —— 「${label}」请到电脑上那条会话自己那边办,或只留一句记在卡上。`
}

/** 组装来源清单要用的几个现成判据(生产在 http.ts 里接到既有服务上,用例注入假的)。 */
export interface ContinueEnv {
  /** 事务官那条会话这会儿说不说得进去(与 /butler/item/say 那道梯同一个出处)。 */
  butlerSayReady: () => { ok: true } | { ok: false, why: string }
  /** 外部会话能不能捎(与 digest 里 relay 那一格同一个出处);这条路没接上 = 缺席。 */
  relayReady: (agent: string, sessionId: string) => { can: boolean, why?: string } | undefined
  /** 外部会话的标题(会话表里那一份;认不到给 undefined,这里落「X 的会话」)。 */
  sessionTitle: (agent: string, sessionId: string) => string | undefined
}

type TaskBits = Pick<TaskView, 'conversation' | 'links'>

/** 这条事项现在的来源清单(事务官会话在前,外部会话按 links 顺序,重复键只出一条)。 */
export function continueSourcesOf(task: TaskBits, env: ContinueEnv): ItemContinueSource[] {
  const out: ItemContinueSource[] = []
  if (task.conversation !== undefined) {
    const ready = env.butlerSayReady()
    /*
     * ★ 与 /butler/item/say 同一道梯,不多收一道闸:archived_at 是任务侧的生命周期记号
     * (做完/取消时盖的),DSH 里那条会话还在、说同样也说得进去 —— 能力以真发话那道梯为准,
     * 不由任务章推。「做完的事不再往里说」是体验层的取舍,不归这条能力契约判死。
     */
    const action: ItemContinueAction = ready.ok
      ? { kind: 'butler' }
      : { kind: 'none', why: ready.why }
    out.push({
      key: BUTLER_SOURCE_KEY,
      agent: 'dsh',
      session_id: task.conversation.session_id,
      title: '事务官',
      action,
    })
  }
  const seen = new Set(out.map(one => one.key))
  for (const link of task.links ?? []) {
    const key = `${link.agent}:${link.session_id}`
    if (seen.has(key)) continue
    seen.add(key)
    const ready = env.relayReady(link.agent, link.session_id)
    const title = env.sessionTitle(link.agent, link.session_id) ?? `${link.agent} 的会话`
    const action: ItemContinueAction = ready?.can === true
      ? { kind: 'relay' }
      : { kind: 'none', why: ready?.why ?? `这句话得你到电脑上的${link.agent}里自己说` }
    out.push({ key, agent: link.agent, session_id: link.session_id, title, action })
  }
  return out
}

/** 目标解析:发给谁。 */
export type ContinueTarget =
  | { kind: 'butler' }
  | { kind: 'relay', agent: string, sessionId: string }

export type ContinueResolve =
  | { kind: 'one', target: ContinueTarget, key: string }
  | { kind: 'pick', candidates: readonly ItemContinueSource[] }
  | { kind: 'blocked', why: string }
  | { kind: 'unknown', why: string }
  | { kind: 'none', why: string }

function sendableOf(sources: readonly ItemContinueSource[]): ItemContinueSource[] {
  return sources.filter(one => one.action.kind === 'butler' || one.action.kind === 'relay')
}

function targetOf(source: ItemContinueSource): ContinueTarget {
  return source.action.kind === 'butler'
    ? { kind: 'butler' }
    : { kind: 'relay', agent: source.agent, sessionId: source.session_id }
}

/**
 * 按目标键认来源。**不猜最新**:不带目标时,能续的只有一条直接用、多条回 pick、没有如实说;
 * 目标键不认识回 unknown(那句话不能掉进另一条会话);目标这会儿不能续回 blocked + why。
 */
export function resolveContinueTarget(sources: readonly ItemContinueSource[], target: string | undefined): ContinueResolve {
  if (target !== undefined) {
    const one = sources.find(source => source.key === target)
    if (one === undefined) return { kind: 'unknown', why: `不认识这条来源(${target})——这件事上没有连着它` }
    if (one.action.kind === 'none') return { kind: 'blocked', why: one.action.why }
    return { kind: 'one', target: targetOf(one), key: one.key }
  }
  const sendable = sendableOf(sources)
  if (sendable.length === 1 && sendable[0] !== undefined) {
    return { kind: 'one', target: targetOf(sendable[0]), key: sendable[0].key }
  }
  if (sendable.length > 0) return { kind: 'pick', candidates: sendable }
  const firstNone = sources.find(one => one.action.kind === 'none')
  return {
    kind: 'none',
    why: firstNone?.action.kind === 'none'
      ? firstNone.action.why
      : '这件事没有连着能接续的会话 —— 可以只留一句记在卡上,会话从「各家对话」里开。',
  }
}

export interface ContinueFact {
  ok: boolean
  fact: ItemContinueFact
  note: string
  delivered?: 'sent' | 'kept' | 'unconfirmed'
}

/**
 * 把 `sessionAnswer.relay` 的结果翻成结果那一档。`where` 是那家在人话里的名字(回执里用)。
 *
 * 映射(每一档都有真实依据,不发明状态):
 *   - 送成(含排进在跑的会话)→ sent;它正在跑时 note 里照实说排着队;
 *   - 会话没开着、留言排上队(2026-10-23 卡「捎话留言等它醒」)→ kept(暂存待上线,**不是失败**);
 *   - 按了发送当场没核上(unconfirmed)→ sent + delivered:'unconfirmed',note 说先别重发;
 *   - 捎不进、得去电脑上办(where:'desk')→ unsupported(可回溯的替代在 why 里),不是 failed;
 *   - 会话记录都没了(404)→ unsupported;其余 4xx → failed。
 */
export function continueFactOf(result: RelayResult, where: string): ContinueFact {
  if (result.ok) {
    if (result.sessionClosed === true) {
      return { ok: true, fact: 'kept', delivered: 'kept', note: result.note ?? SESSION_CLOSED_QUEUED_SAY }
    }
    const base = `捎到了 —— 你那句话已经送进${/[A-Za-z0-9]$/.test(where) ? ` ${where} ` : where}那条会话里了`
    const queued = result.queued === true ? '(它这会儿还在跑,这句话排在它后面,它跑完就看得见)' : ''
    const note = result.note === undefined ? `${base}${queued}。` : `${base}${queued}。(${result.note})`
    return { ok: true, fact: 'sent', delivered: 'sent', note }
  }
  const unconfirmed = !result.ok && result.status === 200 && result.unconfirmed === true
  if (unconfirmed && result.status === 200) {
    return { ok: true, fact: 'sent', delivered: 'unconfirmed', note: '按了发送,还没在它对话区里看到这句话,先别重发;它多半已经收到了,去那条会话里看一眼。' }
  }
  if (result.status === 404) return { ok: false, fact: 'unsupported', note: result.error }
  if (result.status === 200 && result.where === 'desk') {
    return { ok: false, fact: 'unsupported', note: `捎不进去:${result.why}` }
  }
  return { ok: false, fact: 'failed', note: 'error' in result ? result.error : result.why }
}
