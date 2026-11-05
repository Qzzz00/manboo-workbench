/**
 * 电脑端引导整屏的状态映射(2026-09-23,维护者从零重装验收:「注册之后粒子球就应该要出现了」
 * 「扫描能够给一个 Loading 进度条,或者就用现在粒子的工作状态」)。
 *
 * 纯函数,不认识 React、不发请求:FirstRunFlow 把手上的信号交进来,这里回「球是什么态、
 * 球下面那行字幕说什么、状态行说什么、出没出错」。设计写在 docs/交接-0923-电脑引导粒子球.md。
 *
 * 态的优先级:出错 > 找项目 > 说话 > 在想 > 听你打字 > 待命。
 * - 出错放最前:球变成「失败」的颜色、停在待命,字幕位换成一句人话。不能静默只剩她自己的话。
 * - 找项目在说话之前(2026-09-23 维护者看扫描那一屏:「上面的粒子改成工作的那个状态就行」):
 *   扫描期间主球一直是执行中,她那句「我看一下你的仓库」照样出字幕,球不再切去说话。
 *   以前是说话在前,扫描开头那几秒球在「说话」,看上去不像在干活。
 * - 2026-09-24 傍晚(卡 fix/scan-orb-working-whole-wait):「找项目」是**那一整段等待** —— 从她动手找到她开口说结果
 *   (服务端窗口 + scanHold.ts 的 useReplyWindow);她的下一句一出来窗口就收,于是结果那一句照样是说话的样子。
 *   执行中的样子是核心原版的 working 形(莫比乌斯环,中心光团关),维护者 09-24 傍晚澄清:当时只是不要中间的光团。
 *
 * 依赖的服务端字段(fix/onboarding-stale-session 已合进 main;旧服务端缺席就按下面的退路走):
 * - 回合 `kind:'error'`(服务端替她补的那句人话)与 `/onboarding/turns` 的 `failed`。
 * - 扫描进度:`/onboarding/turns` 回包里的 `scan`(与 `GET /onboarding/scan/status` 同一份):
 *   `{ scanning, phase: 'list'|'repos'|'read', done, total?, current?, started_at?, finished_at?, last_read? }`。
 *   list 阶段还不知道总数 → 只有工作态与「正在看有哪些文件夹…」;repos 阶段 → 已看 N/M + 进度条;
 *   read 阶段(2026-09-24,已有项目拉齐)→ 「正在读 X 的说明…」,没有进度条。认不得的 phase 照「正在找你的项目…」。
 *   也认 `/state.onboarding.scan` 与顶层 `scanning`(兼容)。**一个都拿不到时**:阶段在「项目」且她在忙 → 工作态。
 */
import type { OnboardingTurnView } from './firstRunApi.ts'
import type { ParticleMode } from '../ParticleOrb.tsx'
import type { ParticleNotice } from '../butlerSceneModel.ts'

export interface ScanProgress {
  scanning: boolean
  /** list = 在扫描根里找仓库(总数未知);repos = 逐个读仓库;read = 读一个项目的说明和最近记录(2026-09-24)。 */
  phase?: 'list' | 'repos' | 'read'
  done?: number
  total?: number
  /** 此刻在看的目录(路径或名字);read 阶段是项目名。 */
  current?: string
  /** 上一次扫描结束的时刻(ms,服务端 finished_at)。只给 scanHold 判断「刚扫过」用。 */
  finishedAt?: number
  /** 上一轮读完的那个项目(服务端 last_read)。窗口收了、她还没开口时,那一行凭它留在「正在读 X…」。 */
  lastRead?: string
  /** 服务端第几段窗口(2026-09-24 傍晚,onboardingActivity.ts;老服务端没有)。 */
  id?: number
  /** 活儿做完了、窗口还开着在等她开口。 */
  held?: boolean
}

export type OrbCue = 'idle' | 'listening' | 'thinking' | 'speaking' | 'working' | 'trouble'

/** 服务端没给那句人话时,出错位上的默认说法。 */
export const TROUBLE_MODEL_DOWN = '我这边模型没接上,刚才那句没听到。稍等几秒再说一遍。'
export const TROUBLE_ENDED = '这段对话断开了。再说一句,我会接着刚才的往下聊。'
export const TROUBLE_SILENT = '好一会儿没回上话 —— 可能是模型没接上。稍等几秒再说一遍。'
export const SCAN_LINE = '正在找你的项目…'
/** list 阶段(还在看扫描根下有哪些文件夹,总数未知)那一句。手机 butler-app/src/onboarding/scanHold.ts 同一句。 */
export const SCAN_LIST_LINE = '正在看有哪些文件夹…'
/**
 * read 阶段那一句(2026-09-24,已有项目拉齐):她拿到点头之后去读那个项目的说明和最近的记录。
 * 手机 butler-app/src/onboarding/scanHold.ts 同一句 —— 手机 375 宽要整句看得见,所以两端一起收短成「正在读 <名> 的说明…」,
 * 名字太长(显示宽度 > {@link SCAN_READ_NAME_MAX},中文算 2)只说「正在读它的说明…」。
 */
export const SCAN_READ_NAME_MAX = 24
export const SCAN_READ_FALLBACK = '正在读它的说明…'
function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return width
}
export function scanReadLine(name?: string): string {
  const trimmed = name?.trim() ?? ''
  if (trimmed === '' || displayWidth(trimmed) > SCAN_READ_NAME_MAX) return SCAN_READ_FALLBACK
  return `正在读 ${trimmed} 的说明…`
}
/** 说完一句话之后、回合结束了却一个字没回,等多久才算「没接上」。 */
export const SILENT_AFTER_MS = 45_000
/**
 * 等她回话超过这么久,「在想…」后面补一句人话(2026-09-24 维护者真机:重启完说了一句,页面停在「在想…」
 * 很久,他以为卡死了;其实是重启后第一轮冷启动)。
 */
export const SLOW_AFTER_MS = 8_000
/** 等超过这么久,给一颗「再发一次」。 */
export const RESEND_AFTER_MS = 30_000
/** 刚启动 / 这段对话她还一句没回过:第一句要冷启动。 */
export const THINKING_SLOW_COLD = '在想… 刚启动,第一句会慢一点'
export const THINKING_SLOW = '在想… 这一句要多想一会儿'

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/**
 * 从一份服务端回包里读扫描进度。认两种形状:`{ scan: { scanning, … } }` 与顶层 `{ scanning, … }`。
 * 认不出来回 undefined(= 服务端没给这个信号,不是「没在扫」)。
 */
export function scanProgressOf(raw: unknown): ScanProgress | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const inner = typeof record.scan === 'object' && record.scan !== null ? record.scan as Record<string, unknown> : record
  if (typeof inner.scanning !== 'boolean') return undefined
  const done = finite(inner.done), total = finite(inner.total), id = finite(inner.id)
  const current = typeof inner.current === 'string' && inner.current.trim() !== '' ? inner.current.trim() : undefined
  // 认不得的 phase(更新的服务端)不当错:缺席,那一行照「正在找你的项目… <current>」显示。
  const phase = inner.phase === 'list' || inner.phase === 'repos' || inner.phase === 'read' ? inner.phase : undefined
  const finishedAt = typeof inner.finished_at === 'string' ? Date.parse(inner.finished_at) : Number.NaN
  const lastRead = typeof inner.last_read === 'string' && inner.last_read.trim() !== '' ? inner.last_read.trim() : undefined
  return {
    scanning: inner.scanning,
    ...(phase === undefined ? {} : { phase }),
    ...(done === undefined ? {} : { done }),
    ...(total === undefined ? {} : { total }),
    ...(current === undefined ? {} : { current }),
    ...(Number.isFinite(finishedAt) ? { finishedAt } : {}),
    ...(lastRead === undefined ? {} : { lastRead }),
    ...(id === undefined ? {} : { id }),
    ...(inner.held === true ? { held: true } : {}),
  }
}

/** 路径只留最后两段,家目录写成 ~(屏上不出现 /Users/名字)。 */
export function shortPath(path: string): string {
  const home = path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
  const parts = home.split('/').filter(part => part !== '')
  if (parts.length <= 2) return home
  return `…/${parts.slice(-2).join('/')}`
}

/** 扫描那一行:「正在找你的项目… 已看 12/40 · …/GitHub/foo」;没有数就只有前半句。 */
export function scanLineOf(scan: ScanProgress | undefined): string {
  if (scan === undefined) return SCAN_LINE
  // list 阶段:还在找有哪些仓库,数都没有,说了也是 0。
  if (scan.phase === 'list') return SCAN_LIST_LINE
  // read 阶段:读一个项目,没有「已看几个」可说。
  if (scan.phase === 'read') return scanReadLine(scan.current)
  const rest: string[] = []
  if (scan.total !== undefined && scan.total > 0) rest.push(`已看 ${Math.min(scan.done ?? 0, scan.total)}/${scan.total}`)
  else if (scan.done !== undefined && scan.done > 0) rest.push(`已看 ${scan.done} 个`)
  if (scan.current !== undefined) rest.push(shortPath(scan.current))
  return rest.length === 0 ? SCAN_LINE : `${SCAN_LINE} ${rest.join(' · ')}`
}

/** 进度条比例(0–1);没有总数就没有条。 */
export function scanRatioOf(scan: ScanProgress | undefined): number | undefined {
  if (scan?.phase === 'list' || scan?.phase === 'read' || scan?.total === undefined || scan.total <= 0) return undefined
  return Math.max(0, Math.min(1, (scan.done ?? 0) / scan.total))
}

/** 一句话「说」多久:按字数,1.2–7 秒。电脑上不出声,这是球做说话动作的时长。 */
export function speakMsFor(text: string): number {
  const chars = [...text.replace(/\s+/g, '')].length
  return Math.max(1200, Math.min(7000, chars * 110))
}

export interface DialogueRead {
  /** 她最近说的那一句(字幕)。出错回合不算她说的。 */
  her?: { seq: number, text: string }
  /** 你最近说的那一句。 */
  you?: { seq: number, text: string }
  /** 你说完之后她还没回(不算出错回合)。 */
  waiting: boolean
  /** 你最后一句之后,有一条出错回合 —— 它的人话。 */
  errorText?: string
}

/** 把回合表读成「她最后说了什么 / 你最后说了什么 / 是不是在等她」。 */
export function readDialogue(turns: readonly OnboardingTurnView[]): DialogueRead {
  let her: DialogueRead['her'], you: DialogueRead['you'], errorText: string | undefined
  for (const turn of turns) {
    if (turn.role === 'user') { you = { seq: turn.seq, text: turn.text }; errorText = undefined; continue }
    if (turn.kind === 'error') { errorText = turn.text; continue }
    her = { seq: turn.seq, text: turn.text }
    errorText = undefined
  }
  const waiting = you !== undefined && (her === undefined || her.seq < you.seq) && errorText === undefined
  return {
    ...(her === undefined ? {} : { her }),
    ...(you === undefined ? {} : { you }),
    waiting,
    ...(errorText === undefined ? {} : { errorText }),
  }
}

export interface StageSignals {
  /** 她那句字幕还在「说」的时长里。 */
  speaking: boolean
  /** /onboarding/turns 的 busy(回合在跑)。 */
  busy: boolean
  /** 本地在等一个请求(开会话、交答案、发出一句)。 */
  pending: boolean
  /** 你说完了、她还没回。 */
  waiting: boolean
  /** 输入框里有字。 */
  drafting: boolean
  /** 当前阶段(stage);只用于扫描的退路。 */
  stage?: string
  /** 服务端给的扫描进度;undefined = 没给这个信号。 */
  scan?: ScanProgress
  /** 出错回合的人话。 */
  errorText?: string
  /** /onboarding/turns 的 failed(最近一轮以错误结束)。 */
  failed?: boolean
  /** /onboarding/turns 的 ended(会话在 DSH 里没了)。 */
  ended?: boolean
  /** 你说完那一刻起过了多久;在等她时才有意义。 */
  waitedMs?: number
  /** 刚重启过 / 这段对话她还一句没回过(第一句要冷启动)。只影响等久了那一句人话怎么说。 */
  coldStart?: boolean
}

export interface StageView {
  cue: OrbCue
  mode: ParticleMode
  notice: ParticleNotice
  /** 读屏名的后半句。 */
  label: string
  /** 字幕下面那一行状态;没有就不显示。 */
  status?: string
  /** 进度条比例;没有就不画条。 */
  ratio?: number
  /** 出错那句人话;有它就占掉状态行、球变「失败」色。 */
  trouble?: string
  /** 等她回话太久(RESEND_AFTER_MS):给一颗「再发一次」。 */
  resend?: boolean
}

const CUE_ORB: Record<OrbCue, { mode: ParticleMode, notice: ParticleNotice, label: string }> = {
  idle: { mode: 'idle', notice: 'neutral', label: '待命' },
  listening: { mode: 'listening', notice: 'neutral', label: '在听' },
  // 思考借 listening 的动作(微微前倾、点头):核心里没有单独的思考态,不给它加(与手机端同一条纪律)。
  thinking: { mode: 'listening', notice: 'neutral', label: '在想' },
  speaking: { mode: 'speaking', notice: 'neutral', label: '在说话' },
  // 找项目 / 读仓库:核心原版的 working 形(莫比乌斯环)。2026-09-23 一度换成「待命 + 转快」(嫌像长方形横带),
  // 维护者 09-24 傍晚澄清:当时只是不要中间的光团 —— 恢复 working 形,光团照关(particleScene.ts sceneSettings)。
  working: { mode: 'working', notice: 'neutral', label: '在找你的项目' },
  trouble: { mode: 'idle', notice: 'failed', label: '没接上' },
}

export function stageViewOf(signals: StageSignals): StageView {
  // failed / ended 是「上一轮」的旗子:她又开口了(在等、在跑)就先不挂,等这一轮的结果。
  const settled = !signals.busy && !signals.pending && !signals.waiting
  const trouble = signals.errorText
    ?? (signals.failed === true && settled ? TROUBLE_MODEL_DOWN : undefined)
    ?? (signals.ended === true && settled ? TROUBLE_ENDED : undefined)
    ?? (signals.waiting && !signals.busy && !signals.pending && (signals.waitedMs ?? 0) >= SILENT_AFTER_MS ? TROUBLE_SILENT : undefined)
  const scanning = signals.scan !== undefined
    ? signals.scan.scanning
    // 退路:服务端没给扫描信号。阶段在「项目」且她在忙,当她在找项目(那一段的忙几乎都是在扫)。
    : signals.stage === 'projects' && signals.busy
  const thinking = signals.busy || signals.pending || signals.waiting
  const cue: OrbCue = trouble !== undefined ? 'trouble'
    : scanning ? 'working'
      : signals.speaking ? 'speaking'
        : thinking ? 'thinking'
          : signals.drafting ? 'listening'
            : 'idle'
  const orb = CUE_ORB[cue]
  // 读项目那一段(2026-09-24):球照样是工作态,读屏名换成「在读你的项目」。
  const view: StageView = { cue, ...orb, ...(cue === 'working' && signals.scan?.phase === 'read' ? { label: '在读你的项目' } : {}) }
  const resend = signals.waiting && !signals.pending && (signals.waitedMs ?? 0) >= RESEND_AFTER_MS ? { resend: true } : {}
  if (trouble !== undefined) return { ...view, trouble, ...resend }
  // 状态行不跟着球走:她一边说「我看一下」一边在扫,进度照样挂着。
  if (scanning) {
    const ratio = scanRatioOf(signals.scan)
    return { ...view, status: scanLineOf(signals.scan), ...(ratio === undefined ? {} : { ratio }) }
  }
  if (cue === 'thinking') {
    const slow = signals.waiting && (signals.waitedMs ?? 0) >= SLOW_AFTER_MS
    return { ...view, status: slow ? (signals.coldStart === true ? THINKING_SLOW_COLD : THINKING_SLOW) : '在想…', ...resend }
  }
  return view
}

