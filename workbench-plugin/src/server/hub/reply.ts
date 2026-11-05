/**
 * 理解中枢的回话与 say 账(设计第二节末):回话由执行结果拼,不由模型编(chat 除外,那是模型对事实的答);
 * 屏上一份、电话口语一份(不念卡号)。say 账每句落一条:句子、命令、结果、卡号 —— 下一句的上下文包从这里取「最近的话」。
 * 挂着等她点头的问(护栏改出来的、模型问的)也记在这本账上:她点「好」或回一句「好」就照原命令执行,不重新听懂。
 */
import type { HubCommand, HubCommandName, HubResult } from './commands.ts'
import { CONTEXT_LIMITS, type HubEntrance, type HubSayRecord } from './context.ts'

/** 回包 items 的 kind 仍用旧口的六类(电话 / 手机 / 页面都按它画)。 */
const KIND_OF: Record<HubCommandName, '记' | '办' | '问' | '改' | '捎话' | '闲聊'> = {
  dispatch: '办', reassign: '办', user_layer_fix: '办', verify: '办',
  supplement: '捎话',
  rename: '改', cancel: '改', move_status: '改', set_goal: '改', goal_status: '改', goal_create: '改', goal_due: '改',
  note: '记', remember: '记', feedback: '记', voice: '改',
  ask: '问', confirm: '办', chat: '闲聊',
}

function lineOf(result: HubResult): string {
  if (result.ask !== undefined) return result.ask.options.length === 0 ? result.ask.question : `${result.ask.question}(${result.ask.options.join(' / ')})`
  if (result.reply !== undefined) return result.reply
  if (result.ok) return result.did
  return `${result.did}——${result.why ?? '没办成'}${result.next === undefined ? '' : `;${result.next}`}`
}

function endWith(text: string): string {
  return /[。?？!！)）」]$/u.test(text) ? text : `${text}。`
}

export function replyOf(results: readonly HubResult[]): { screen: string, spoken: string } {
  if (results.length === 0) return { screen: '这句我没理解成能办的事,没动。', spoken: '这句我没听明白,没动。' }
  const lines = results.map(lineOf)
  const screen = lines.length === 1 ? endWith(lines[0]!) : lines.map(endWith).join('\n')
  const spoken = lines
    .map(line => line.replace(/\bt-[0-9a-z]{4,12}\b\s*/giu, '').replace(/[((]\s*[))]/gu, '').replace(/\s{2,}/gu, ' ').trim())
    .map(endWith)
    .join('')
  return { screen, spoken }
}

/** 回包 items:旧形状(kind / title / status / card_id / who / detail),页面与手机照旧画。 */
export function itemsOf(results: readonly HubResult[]): Record<string, unknown>[] {
  return results.map((one) => {
    const asked = one.ask !== undefined
    const detail = asked ? one.ask!.question : one.ok ? undefined : [one.why, one.next].filter(Boolean).join(';')
    return {
      kind: KIND_OF[one.command],
      title: one.did,
      status: asked ? 'asked' : one.ok ? 'done' : 'failed',
      ...(one.card_id === undefined ? {} : { card_id: one.card_id }),
      ...(one.who === undefined ? {} : { who: one.who }),
      ...(detail === undefined || detail === '' ? {} : { detail }),
    }
  })
}

export interface HubPendingAsk {
  ask_id: string
  say_id: string
  said: string
  question: string
  options: readonly string[]
  /** 她点头后照办的命令(护栏挂起的那条);模型自己的 ask 没有挂命令,答案走下一句重新听懂。 */
  held: readonly HubCommand[]
  at: number
}

/** 挂着的问多久作废(与旧 say 账同 10 分钟)。 */
export const ASK_WINDOW_MS = 10 * 60 * 1000

/**
 * 中枢一条 say 每一步的打点键(2026-10-28 卡「悬浮窗 say 挂住与超时」):
 * 收到 → 模型回了 → 执行开始 → 执行完 → 回了;总时限到点另记 timeout。
 * 哪一步卡住从这本账的 stagesOf / lastStageOf 看,不靠下次复现猜。
 */
export type SayStage = 'received' | 'model' | 'exec_start' | 'exec_done' | 'replied' | 'timeout'

export function createSayBook(opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now
  const records: HubSayRecord[] = []
  const pending: HubPendingAsk[] = []
  const marks: { say_id: string, stage: SayStage, at: number }[] = []
  const live = (): HubPendingAsk[] => pending.filter(one => now() - one.at <= ASK_WINDOW_MS)
  return {
    record(input: { say_id: string, entrance: HubEntrance, said: string, commands: readonly string[], results: readonly HubResult[] }): HubSayRecord {
      const cards = [...new Set(input.results.flatMap(one => (one.card_id === undefined ? [] : [one.card_id])))]
      const entry: HubSayRecord = { say_id: input.say_id, at: now(), entrance: input.entrance, said: input.said, commands: [...input.commands], cards, results: input.results.map(lineOf) }
      records.push(entry)
      while (records.length > CONTEXT_LIMITS.says) records.shift()
      return entry
    },
    recent(): HubSayRecord[] {
      return records.filter(one => now() - one.at <= CONTEXT_LIMITS.sayWindowMs)
    },
    hold(ask: Omit<HubPendingAsk, 'at'>): void {
      pending.push({ ...ask, at: now() })
      while (pending.length > 20) pending.shift()
    },
    asks(): HubPendingAsk[] { return live() },
    /** 一步打点进 say 账(say_id 一条一串,按先后)。 */
    mark(sayId: string, stage: SayStage): void {
      marks.push({ say_id: sayId, stage, at: now() })
      while (marks.length > 1000) marks.shift()
    },
    /** 这一条 say 的打点串(诊断「卡在哪一步」用)。 */
    stagesOf(sayId: string): readonly { stage: SayStage, at: number }[] {
      return marks.filter(one => one.say_id === sayId)
    },
    /** 这一条 say 最后一个打点(总时限到点时说清卡在哪一步)。 */
    lastStageOf(sayId: string): SayStage | undefined {
      return marks.filter(one => one.say_id === sayId).at(-1)?.stage
    },
    has(askId: unknown): boolean { return typeof askId === 'string' && live().some(one => one.ask_id === askId) },
    /** 取走一问(答了就销);'latest' = 最近那一问。 */
    take(askId: string | 'latest'): HubPendingAsk | undefined {
      const alive = live()
      const hit = askId === 'latest' ? alive.at(-1) : alive.find(one => one.ask_id === askId)
      if (hit === undefined) return undefined
      pending.splice(pending.indexOf(hit), 1)
      return hit
    },
  }
}
export type SayBook = ReturnType<typeof createSayBook>
