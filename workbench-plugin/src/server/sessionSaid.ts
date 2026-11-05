/**
 * **送进去的那一句,到那条会话自己的记录文件里核一次**(2026-10-01,卡 AW)。
 *
 * 维护者 16:06 原话:「怎么又说不敢替我打字了,我都说了这是复制黏贴和发送了」。
 * 从前替她答进 Claude 桌面那条会话,全靠辅助功能树里能不能找到那一问的记号 ——
 * 真机上**一次都没找到过**(日志里清一色「没在它的窗口里找到那段对话」),于是一次都没送出去。
 *
 * 改法(维护者 17:0x 定成通用的):**先把那一段开到前台,再照送** —— 哪一家都一样;
 * 送完**按证据核**,证据分两种、不按家分:有会话记录文件的看记录(就是这个模块),
 * 没有文件的读窗口(`read_reply`);两样都没有就如实说核不了。核不上就说「可能发到了别的对话」,
 * **绝不说成答上了**。
 *
 * 这里只做一件事:**读那条会话最近她说过的几句原文**。只读、不落盘、不经模型。
 */
import { readHeadTail, turnsOf } from './sessionDigest.ts'
import type { SessionFileRef } from './sessionHistory.ts'

/** 往回读多少字节(最近几轮够了;几十 MB 的会话也只读这一截)。 */
export const SAID_TAIL_BYTES = 128 * 1024
/** 最多交回最近这么多句「她说的」。 */
export const SAID_LIMIT = 20

/**
 * 认「这两句是同一句」用的洗法:剥掉行首的 `【…】`(派活 / 捎话那个记号,那家记下来的多半还带着),
 * 把各种空白收成一个空格,去首尾空白。**不改字、不截断**。
 */
export function normalizeSaid(text: string): string {
  return text
    .replace(/^\s*【[^】]*】\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 这几句「她说的」里,和 `said` 对得上的有几句(前后比个数:她自己重复说过同一句也认得出是不是新的一句)。 */
export function countSaid(lines: readonly string[], said: string): number {
  const want = normalizeSaid(said)
  if (want === '') return 0
  let hit = 0
  for (const line of lines) {
    const one = normalizeSaid(line)
    if (one === want || one.includes(want)) hit += 1
  }
  return hit
}

export interface SaidInTranscriptDeps {
  /** 按 id 找这条会话的记录文件(`sessionHistory.locate`)。认不出 → 这条会话没有本机记录。 */
  locate: (agent: string, sessionId: string) => Promise<SessionFileRef | undefined>
}

/**
 * 这条会话最近她说过的几句原文。**`undefined` = 这条会话没有本机记录文件**(窗口型那几家、
 * 或者文件这会儿读不了)—— 调用方据此退回「只靠窗口核实」那一套,不乱送。
 */
export function createSaidInTranscript(
  deps: SaidInTranscriptDeps,
): (agent: string, sessionId: string) => Promise<readonly string[] | undefined> {
  return async (agent, sessionId) => {
    const ref = await deps.locate(agent, sessionId).catch(() => undefined)
    if (ref === undefined) return undefined
    const read = await readHeadTail(ref, { headBytes: 4096, maxHeadBytes: 4096, tailBytes: SAID_TAIL_BYTES })
    if (read === undefined) return undefined
    const turns = turnsOf(ref.format, {
      head: read.head,
      tail: read.tail,
      fallbackAt: read.fallbackAt,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    })
    return turns.turns.filter(one => one.k === 'ask').map(one => one.text).slice(-SAID_LIMIT)
  }
}

/** 送完等记录文件里多出她那句的上限 / 节拍(照 2026-10-01 卡 AW 那两个缺省值,一个没改)。 */
export const SAID_CONFIRM_MS = 10_000
export const SAID_CONFIRM_STEP_MS = 1000

/**
 * ★ **第三档证据接成引擎的 `transcript` 那一格**(2026-10-02,卡「引擎接线与删复制品」)。
 *
 * 从前这一段写在 `sessionAnswer.pushIntoWindow` 里(`saidNow` + `confirmInTranscript`),
 * 和「怎么开到前台、怎么打字」缠在一起;引擎接上之后它是**独立的一档证据**:
 * 窗口那一层说「按了发送、核不上」时,回这条会话自己的记录文件里再核一次。
 *
 * 比的是**个数**(`countSaid` 前后比),所以她自己重复说过同一句也认得出哪一句是新的。
 * 读不出来 / 这条会话没有本机记录文件 → `said` 回 `undefined`,引擎据此整档关掉(不乱说核过了)。
 */
export function createTranscriptEvidence(deps: SaidInTranscriptDeps & {
  /** 核不上那一句人话(由说话那一层给:要带那一家的名字)。 */
  why: (agent: string) => string
  confirmMs?: number
  confirmStepMs?: number
  sleep?: (ms: number) => Promise<void>
}): {
    said: (job: { family: string, target: { kind: 'session', sessionId: string } | { kind: string } }) => Promise<readonly string[] | undefined>
    confirm: (job: { family: string, text: string, target: { kind: 'session', sessionId: string } | { kind: string } }, before: readonly string[]) => Promise<boolean>
    why: (job: { family: string }) => string
  } {
  const saidIn = createSaidInTranscript({ locate: deps.locate })
  const step = deps.confirmStepMs ?? SAID_CONFIRM_STEP_MS
  const budget = deps.confirmMs ?? SAID_CONFIRM_MS
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.() }))
  const sessionOf = (target: { kind: 'session', sessionId: string } | { kind: string }): string | undefined =>
    target.kind === 'session' ? (target as { sessionId: string }).sessionId : undefined
  return {
    async said(job) {
      const id = sessionOf(job.target)
      if (id === undefined) return undefined
      return await saidIn(job.family, id).catch(() => undefined) ?? undefined
    },
    async confirm(job, before) {
      const id = sessionOf(job.target)
      if (id === undefined) return false
      const want = countSaid(before, job.text)
      for (let waited = 0; ; waited += step) {
        const now = await saidIn(job.family, id).catch(() => undefined)
        if (now !== undefined && countSaid(now, job.text) > want) return true
        if (waited >= budget) return false
        await sleep(step)
      }
    },
    why: job => deps.why(job.family),
  }
}
