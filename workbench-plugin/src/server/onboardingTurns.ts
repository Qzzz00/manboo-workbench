/**
 * 引导会话的回合(2026-09-16,给手机 App 那张卡):`GET /onboarding/turns?after=<seq>` 回的就是这里的表。
 *
 * 来源是 DSH 进程内的原生会话事件(与 dshSessionFeed 同一条 `ctx.on('session/event')`,
 * 但那个文件归「会话回合摘要」那张卡改,这里另开一份订阅,只盯引导会话那一条):
 * - `user/message`(source.kind === 'user')→ 用户回合。**阶段机发的种子句不算**:开会话时把那条
 *   第一条消息登记为种子,文字相同的 user/message 跳过。
 * - `assistant/message` → 事务官回合:只取 text 块,去掉 ``` 代码块与行内 `curl …`
 *   (模型在会话里 curl /onboarding/answer 的那些,不该念给手机听)。空了就不记。
 * - `turn/start` / `turn/end` → busy(手机据此显示「在想」);`session/disposed` → ended
 *   (再 /onboarding/say 就 409,手机该重新 /onboarding/session 接着聊)。
 *
 * 种子句(2026-09-16 开场体验):手机在开会话那一刻就自己把阶段种子句(Ben 亲笔)摆出来、念出来,不等模型;
 * 模型随后按铁律照念的那条在这里标 `kind:'seed'`(按 speechKey 与当前阶段种子句比较——模型会改标点),
 * 手机据此合并、不重复显示。**紧接着**一模一样的两条事务官回合只记一条(真机见过模型把开场白说两遍);
 * 中间隔了用户的话就不算重复(用户可能真让它再说一遍)。阶段推进时由 HTTP 层 `setStageSeed` 换成下一阶段的种子句。
 *
 * 回合以错误结束(2026-09-23,新装机器真机):DSH 的 `turn/end` 带 `reason: { kind: 'error', error: { message, code } }`
 * (上游 dsh-session `TurnEndReasonMap.error`)。那时模型一个字没说,界面上只剩她自己的话。所以这里补一条
 * `kind:'error'` 的事务官回合 {@link ONBOARDING_MODEL_DOWN}(人话,不带上游英文原文),`status().failed` 置真,
 * 并通过 `onTurnEnd` 告诉引导服务「这条会话坏了」—— 服务把它落盘,下次续接就另开一条(见 onboarding.ts openSession)。
 * 下一轮正常结束(completed 等非 error)就把 failed 撤掉。
 *
 * 纪律同 dshSessionFeed:订阅侧对坏数据一律「当没看见」,绝不抛——事件回调里抛出会污染 DSH 自己的派发。
 * 只在内存里(进程重启就空):历史对话的真相在 DSH 的会话日志里,这里只是给手机的一面镜子。
 */

export interface OnboardingTurn {
  seq: number
  role: 'user' | 'assistant'
  text: string
  at: string
  /**
   * `seed`:模型照念的当前阶段种子句(手机开会话时已经自己显示过那句,合并不重复)。
   * `error`:这一轮以错误结束,不是模型说的,是工作台替它说的一句人话(2026-09-23)。
   */
  kind?: 'seed' | 'error'
}

export interface OnboardingTurnsStatus {
  session_id?: string
  /** 事务官正在回话(turn/start 之后、turn/end 之前)。 */
  busy: boolean
  /** 会话在 DSH 里已经没了(disposed)。 */
  ended: boolean
  /** 最近一轮以错误结束(模型没接上等)。下一句话会另开一条会话(见 http.ts /onboarding/say)。 */
  failed: boolean
}

/** 引导回合以错误结束时替事务官说的那句。不带上游英文原文(她看不懂,也不该看到路由名)。 */
export const ONBOARDING_MODEL_DOWN = '我这边模型没接上,正在重连。你稍等几秒再说一遍,刚才那句我没听到。'

/** 一轮结束的结果:给引导服务落盘用。`code` 是上游 LlmFailure.code(如 MISSING_CREDENTIAL),只进诊断。 */
export type OnboardingTurnOutcome = { ok: true } | { ok: false, code?: string, message?: string }

export interface OnboardingTurnsStore {
  /**
   * 开(或续)会话那一刻登记:会话 id + 第一条消息(不算用户回合)+ 当前阶段的种子句(模型照念的那条标 kind:seed)。
   * 不给种子句就不标。
   */
  bind: (sessionId: string, firstMessage: string, stageSeed?: string) => void
  /** 阶段推进后换成下一阶段的种子句;undefined = 没有(done)。 */
  setStageSeed: (seed: string | undefined) => void
  handleEvent: (sessionId: string, event: { type?: unknown, data?: unknown }) => void
  handleDisposed: (sessionId: string) => void
  list: (after: number) => OnboardingTurn[]
  /**
   * 这一阶段开始以后的回合(2026-09-23):阶段推进(`setStageSeed`)或绑会话那一刻记一个起点。
   * 给「问出口了却没答上」那道查(onboardingConsent.unansweredAsked)用。
   */
  stageTurns: () => OnboardingTurn[]
  status: () => OnboardingTurnsStatus
  /** restart 时清空。 */
  reset: () => void
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 消息 content 里的 text 块拼起来;不是数组当空。 */
export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.type === 'text' && typeof record.text === 'string' && record.text !== '') parts.push(record.text)
  }
  return parts.join('\n')
}

/**
 * 去掉不该念给人听的部分:``` 围起来的代码块、行内反引号里的命令/JSON;然后把多余空行压成一个。
 * 只删,不改字——事务官说的话照原样。
 */
export function cleanTurnText(text: string): string {
  let out = text.replace(/```[\s\S]*?```/g, '')
  // 没闭合的代码块:从开头到结尾都算代码。
  out = out.replace(/```[\s\S]*$/g, '')
  // 行内反引号:命令 / JSON 删掉;文件名、路径这种**要念给他听的**留下字、去掉反引号
  // (2026-09-23 统筹自跑:收尾那句「落下来的几份在 `用户-Ben.md`、…」被删成了「在 、、」)。
  out = out.replace(/`([^`\n]*)`/g, (_match, inner: string) => (looksLikeCommand(inner) ? '' : inner))
  // 删掉行内代码后留下的孤零零的标点(「我记一下:,然后」→「我记一下,然后」)。
  out = out.replace(/[:：]\s*([,，。;;])/g, '$1')
  out = out.split('\n').map(line => line.replace(/[ \t]+$/g, '')).join('\n')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/** 行内代码是不是命令 / JSON(要删的那种)。文件名、路径、一个词都不算。 */
export function looksLikeCommand(inner: string): boolean {
  const text = inner.trim()
  if (text === '') return true
  if (/^(curl|git|cd|ls|cat|npm|pnpm|npx|node|bash|sh|open|launchctl|POST|GET|PUT|DELETE)\b/i.test(text)) return true
  if (/https?:\/\//i.test(text)) return true
  return /[{}"=|&;<>$]/.test(text)
}

/**
 * 「同一句话」的比较键:去掉所有空白与标点(全角半角都算),只留字。
 * 模型照念开场白时会把半角逗号念成全角、末尾多个空格——都不算改字。手机端 `speechKey` 与这里逐字同源。
 */
export function speechKey(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

export interface OnboardingTurnsOptions {
  now?: () => Date
  /** 最多留多少条,缺省 500;超了丢最旧的。 */
  limit?: number
  /** 绑定那条会话的每一轮结束时调(成功或错误)。回调里抛出一律吞掉。 */
  onTurnEnd?: (sessionId: string, outcome: OnboardingTurnOutcome) => void
}

/** `turn/end` 的 data 读成结果;不是 turn/end 形状的当成功(只有明确 kind:'error' 才算坏)。 */
export function turnEndOutcome(data: unknown): OnboardingTurnOutcome {
  const reason = asRecord(asRecord(data)?.reason)
  if (reason?.kind !== 'error') return { ok: true }
  const error = asRecord(reason.error)
  return {
    ok: false,
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(typeof error?.message === 'string' ? { message: error.message } : {}),
  }
}

export function createOnboardingTurns(options: OnboardingTurnsOptions = {}): OnboardingTurnsStore {
  const now = options.now ?? (() => new Date())
  const limit = options.limit ?? 500
  let turns: OnboardingTurn[] = []
  let seq = 0
  let sessionId: string | undefined
  let firstMessage: string | undefined
  let stageSeedKey: string | undefined
  let stageStartSeq = 0
  let busy = false
  let ended = false
  let failed = false

  const push = (role: OnboardingTurn['role'], text: string, kind?: OnboardingTurn['kind']): void => {
    turns.push({ seq: ++seq, role, text, at: now().toISOString(), ...(kind === undefined ? {} : { kind }) })
    if (turns.length > limit) turns = turns.slice(turns.length - limit)
  }

  return {
    bind(id, message, stageSeed) {
      sessionId = id
      firstMessage = message.trim()
      stageSeedKey = stageSeed === undefined || stageSeed.trim() === '' ? undefined : speechKey(stageSeed)
      stageStartSeq = seq
      busy = false
      ended = false
      failed = false
    },
    setStageSeed(stageSeed) {
      stageSeedKey = stageSeed === undefined || stageSeed.trim() === '' ? undefined : speechKey(stageSeed)
      stageStartSeq = seq
    },
    handleEvent(id, event) {
      try {
        if (sessionId === undefined || id !== sessionId) return
        const data = asRecord(event.data)
        switch (event.type) {
          case 'turn/start':
            busy = true
            return
          case 'turn/end': {
            busy = false
            const outcome = turnEndOutcome(data)
            failed = !outcome.ok
            if (!outcome.ok) {
              // 上游原文不念给她,但要记一行(2026-10-01:Air 引导卡在「模型没接上」,日志里一个字都没有,查不出是 422 还是断网)。
              console.log(`[onboarding] 这一轮模型出错:${outcome.code ?? '无错误码'} ${(outcome.message ?? '').slice(0, 300)}`)
              const last = turns[turns.length - 1]
              // 连着几轮都坏:只说一次,直到她又开口。
              if (!(last?.role === 'assistant' && last.kind === 'error')) push('assistant', ONBOARDING_MODEL_DOWN, 'error')
            }
            try { options.onTurnEnd?.(id, outcome) } catch { /* 回调坏了不能带走事件派发 */ }
            return
          }
          case 'user/message': {
            const source = asRecord(data?.source)
            if (source?.kind !== 'user') return
            const text = textOfContent(data?.content).trim()
            if (text === '' || text === firstMessage) return
            push('user', text)
            return
          }
          case 'assistant/message': {
            const message = asRecord(data?.message)
            const text = cleanTurnText(textOfContent(message?.content))
            if (text === '') return
            const key = speechKey(text)
            // 紧接着一模一样的一句(去空白与标点后):只记一条。
            const last = turns[turns.length - 1]
            if (last?.role === 'assistant' && speechKey(last.text) === key) return
            push('assistant', text, stageSeedKey !== undefined && key === stageSeedKey ? 'seed' : undefined)
            return
          }
          default:
        }
      }
      catch {
        // 事件形状不对:当没看见。
      }
    },
    handleDisposed(id) {
      if (sessionId !== undefined && id === sessionId) { ended = true; busy = false }
    },
    list: after => turns.filter(turn => turn.seq > after),
    stageTurns: () => turns.filter(turn => turn.seq > stageStartSeq),
    status: () => ({ ...(sessionId === undefined ? {} : { session_id: sessionId }), busy, ended, failed }),
    reset() {
      turns = []
      seq = 0
      sessionId = undefined
      firstMessage = undefined
      stageSeedKey = undefined
      stageStartSeq = 0
      busy = false
      ended = false
      failed = false
    },
  }
}

/**
 * 接到 DSH 的事件总线上。纪律与 index.ts 的 wireDshSessions 逐字同源:不裸取服务、一切入口 try/catch、
 * 没有 ctx 或事件名不被认识就整块跳过。
 */
export function wireOnboardingTurns(
  ctx: { on?: (name: string, handler: (...args: never[]) => void) => unknown } | undefined,
  turns: OnboardingTurnsStore,
): void {
  if (ctx === undefined || typeof ctx.on !== 'function') return
  try {
    ctx.on('session/event', ((session: { id?: unknown } | null | undefined, event: { type?: unknown, data?: unknown } | undefined) => {
      try {
        const id = session?.id
        if ((typeof id !== 'string' && typeof id !== 'number') || typeof event?.type !== 'string') return
        turns.handleEvent(String(id), event)
      }
      catch { /* 一条事件读不出来不能带走整个监听器 */ }
    }) as (...args: never[]) => void)
    ctx.on('session/disposed', ((session: { id?: unknown } | null | undefined) => {
      try {
        const id = session?.id
        if (typeof id !== 'string' && typeof id !== 'number') return
        turns.handleDisposed(String(id))
      }
      catch { /* 同上 */ }
    }) as (...args: never[]) => void)
  }
  catch {
    // 事件名不被这一版 DSH 认识:回合表保持空,/onboarding/turns 回空数组,手机只显示自己发的话。
  }
}
