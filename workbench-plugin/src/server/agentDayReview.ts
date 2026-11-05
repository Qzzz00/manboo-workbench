/**
 * 早报正文 = 昨天的 Agent 任务复盘(2026-10-13,照维护者转来的《日报规范》
 * `docs/规范-日报-2026-10-12.md`;「日报就是早报」见决策记录 2026-10-12 夜)。
 *
 * 规范第 1 条:核心数据源是**上次早报以来启动 / 推进过的 Agent 任务**,待办与随手记只做辅助。
 * 所以这一份分成两半,分界线与预案卡(`meetingPrep.meetingFactsOf` + `meeting.ts`)逐字同一条:
 *
 * - **事实与分档由程序按记录判**(规范 §4–§9):谁进得来、派过哪几家、关键状态变化、
 *   完成有没有依据、卡在哪、要不要外部条件 —— 全部从**派活台账(`jobLog`)、卡上的派活记录、
 *   `itemStanding` 现算的「停在哪」、`progress` 现算的「现在到哪」**里取,取不到就缺席,一个字不编(D13)。
 *   结果是一张**带编号的事实表**({@link dayReviewFacts})。
 * - **归并与措辞交给模型**(规范 §3 §11 §12 §14):同一个目标下几家派的活并成一条、认出依赖、
 *   必要时点出计划与实际的偏差。模型**只许引表里的编号**,冒出表外的数、把没有完成依据的
 *   写进「已完成」、下一步写「继续优化」那种话 —— 整条丢({@link parseDayReviewReply})。
 *   模型不在(没接 / 抛了 / 回话对不上)就按事实表直接排四段,并注明这一份只有程序拼的部分。
 *
 * 四段固定(规范 §13):已完成 / 推进中 / 卡点 / 下一步;一段都没有整块不出 ——
 * 规范 §14 自己写着「不为了看起来完整强行补充信息」,仓库纪律也一样(空段不写废话)。
 */
import type { NoteView, TaskView, TodayTodosView } from '../protocol.ts'
import { ITEM_STANDING_CASE_TITLES, WAIT_REASON_TITLES, assigneeName } from '../protocol.ts'
import type { JobEvent, JobStep } from './jobLog.ts'
/** 接力记录的形状(读法只有 `videoChain.view()` 一处,这里只认类型)。 */
import type { ChainRecord, ChainStage } from './videoChain.ts'

/* ─────────────────────── 口径与上限 ─────────────────────── */

/** 五档(规范 §4)。 */
export type DayVerdict = 'done' | 'in_progress' | 'blocked' | 'paused' | 'new_idle'

export const DAY_VERDICT_TITLES: Readonly<Record<DayVerdict, string>> = {
  done: '已完成',
  in_progress: '推进中',
  blocked: '卡点',
  paused: '暂停',
  new_idle: '当日新增,还没实质推进',
}

/** 四段(规范 §13)。`paused` 与 `new_idle` 不占前三段,只进「下一步」—— 规范 §7 不许把「没来得及」写成卡点。 */
export type DaySectionId = 'done' | 'in_progress' | 'blocked' | 'next'

export const DAY_SECTION_IDS: readonly DaySectionId[] = ['done', 'in_progress', 'blocked', 'next']

export const DAY_REVIEW_HEAD = '上次早报到现在,这些事推到了哪:'

export const DAY_REVIEW_SECTION_HEADS: Readonly<Record<DaySectionId, string>> = {
  done: '已完成:',
  in_progress: '推进中:',
  blocked: '卡点:',
  next: '下一步:',
}

/** 模型没参与那一份要说实话(同 `BUTLER_SESSION_OFFLINE_NOTE` 的纪律)。 */
export const DAY_REVIEW_PROGRAM_ONLY_NOTE = '(这四段是程序按记录排的,没经模型归并)'

/** 一段最多列几条,超出末尾一行「另外 N 件在事项里」(同 `STALLED_MORNING_MAX` 的手法)。 */
export const DAY_REVIEW_SECTION_MAX = 5

/** 四段正文的字数上限。超了按规范 §8「只留关键状态变化」裁 —— 先裁推进中,再裁已完成。 */
export const DAY_REVIEW_MAX_CHARS = 1200

/** 一件事最多留几条关键状态变化(规范 §8);超出留头一条与最后三条。 */
export const DAY_REVIEW_CHANGES_MAX = 4

/** 下一步里不许出现的话(规范 §10 明令禁止的那几种模糊表达)。 */
export const DAY_REVIEW_VAGUE_WORDS: readonly string[] = [
  '继续优化', '持续优化', '持续推进', '继续推进', '继续推动', '跟进一下', '继续跟进', '持续跟进', '持续关注', '保持关注',
]

const DAY_MS = 86_400_000

/** 账上这几步与任务怎么走无关(电话、动作闸),规范 §8 要求压掉。 */
const NOISE_STEPS: readonly JobStep[] = ['called', 'no_call', 'gate_pass', 'gate_block']

/** 收场成「没做成」的那几步。 */
const FAIL_STEPS: readonly JobStep[] = ['timeout', 'unreadable', 'not_sent']

/** 一条事件怎么念(只有影响任务发展的那几步在表里;表外的一律不进复盘)。 */
const STEP_WORDS: Partial<Record<JobStep, (family: string) => string>> = {
  assigned: f => `交给了 ${f}`,
  sent: f => `送进 ${f} 了`,
  seen: f => `在 ${f} 那边看见那一句了(送到,不等于办完)`,
  replied: f => `${f} 交回来了`,
  timeout: f => `等 ${f} 回话等过头了`,
  unreadable: f => `${f} 那边的回话读不到`,
  not_sent: f => `一个字都没送进 ${f}`,
  waiting: f => `电脑锁着屏,给 ${f} 的那一句排着等解锁`,
  budget_stop: () => '到上限先停下来了',
  done: () => '你把这张卡收了',
}

/* ─────────────────────── 事实表 ─────────────────────── */

/** 卡点要不要外部条件才解得开(规范 §7)。 */
export type DayBlockNeeds = '她' | '重派' | '外部'

/** 一条事实。**模型只许引 `id`**。 */
export interface DayFact {
  id: string
  /** `agent_task` = 复盘主体;`note` / `todo` = 辅助参照(规范 §2),只能当背景与下一步线索。 */
  kind: 'agent_task' | 'note' | 'todo'
  task_id?: string
  title: string
  /** 归在哪个目标下(项目名 / 选题)。模型按它并条(规范 §3)。认不出就缺席。 */
  goal?: string
  /** 这件事派过哪几家(登记表里那个 id)。 */
  families?: readonly string[]
  verdict?: DayVerdict
  /** 判成这一档的依据(规范 §5)。 */
  because?: string
  /** 推进中:已经做到哪里(规范 §6)。 */
  stage_result?: string
  /** 卡点:卡在哪、为什么(规范 §7)。 */
  blocked_why?: string
  blocked_needs?: DayBlockNeeds
  /** 关键状态变化(规范 §8)。 */
  changes?: readonly string[]
  /** 下一步候选(规范 §10);拼不出具体动作就缺席。 */
  next?: string
  /** 给模型看的那一行。 */
  text: string
  /** 出处。 */
  source: string
}

export interface DayReviewInput {
  /** 上次早报那一刻(ISO)。 */
  since: string
  /** 现在(ISO)。 */
  until: string
  /** `/state.tasks.tasks`(带 `standing` / `progress` / `mover` 那一份)。 */
  tasks: readonly TaskView[]
  /** 任务账(`jobLog.all()`)。缺席 = 这台服务没接任务账,事实只用卡上的证据。 */
  jobEvents?: readonly JobEvent[]
  /** 项目名,只为把事实归到目标上(`/state.projects.projects`)。 */
  projects?: readonly { id: string, name: string }[]
  /** `/state.today_todos`:辅助参照(规范 §2),也是下一步的一条来源(规范 §10)。 */
  today_todos?: TodayTodosView
  /** `/state.notes` 随手记:**只当背景**。见本文件末尾那一段「§10 第五条来源为什么缺席」。 */
  notes?: readonly NoteView[]
  /**
   * 正在走的两步接力(`videoChain.view()`;出参考图 → 可灵出片)。
   * 缺席 = 这台服务没接接力(或这一拍读不到),分档与加这一道之前逐字相同。
   */
  chains?: readonly ChainRecord[]
}

/**
 * ★ **接力还没走完的那几步,「做到哪」怎么说**(2026-10-13,卡 F;四场景验收第 16 条)。
 *
 * 14:31 那份早报把正在可灵那一步的「女孩树林摘蘑菇」列进了已完成,依据是
 * 「豆包办公已说完,结果没收进卡」—— 可视频链里**豆包的回话不是交付**,它只是第一步出了张参考图。
 */
const CHAIN_STAGE_RESULT: Readonly<Record<Exclude<ChainStage, 'done' | 'failed'>, string>> = {
  image: '在等豆包出参考图',
  kling: '参考图拿到了,在可灵生成',
  video: '可灵在出片,出来了推到你手机上',
}

/** 这张卡此刻还在接力里(没走完、也没断)吗。 */
function chainRunning(chain: ChainRecord | undefined): chain is ChainRecord & { stage: keyof typeof CHAIN_STAGE_RESULT } {
  return chain !== undefined && chain.stage !== 'done' && chain.stage !== 'failed'
}

function ms(at: string | undefined): number | undefined {
  if (at === undefined || at === '') return undefined
  const value = Date.parse(at)
  return Number.isNaN(value) ? undefined : value
}

function nameOf(family: string | undefined): string {
  return family === undefined ? '那一家' : assigneeName(family)
}

/** 上次早报到现在。认不出上次(或比现在还晚)就退回 24 小时。 */
export function dayReviewWindow(nowMs: number, lastMorningStartedAt: string | undefined): { since: string, until: string } {
  const last = ms(lastMorningStartedAt)
  return {
    since: last === undefined || last > nowMs ? new Date(nowMs - DAY_MS).toISOString() : lastMorningStartedAt as string,
    until: new Date(nowMs).toISOString(),
  }
}

interface Mark {
  at: number
  /** 这一下是什么(给「关键状态变化」用)。 */
  what: string
  step?: JobStep | undefined
  family?: string | undefined
}

/**
 * 这件事在窗口里有没有**真的动过**。
 *
 * **卡上最后一次改动(`updated_at`)不算**(同 `itemStanding` 那条「卡上改动只作兜底」):
 * 改个标题、挪一下优先级都会动它,拿它当「推进过」就等于规范 §9 骂的那种流水账。
 */
function marksOf(task: TaskView, events: readonly JobEvent[]): Mark[] {
  const marks: Mark[] = []
  const push = (at: string | undefined, what: string, extra?: { step?: JobStep, family?: string | undefined }): void => {
    const value = ms(at)
    if (value === undefined) return
    marks.push({ at: value, what, ...(extra ?? {}) })
  }
  push(task.created_at, '这件事记下来了')
  push(task.done_at, '你把这件事收了')
  const d = task.dispatch
  if (d !== undefined) {
    push(d.started_at, `派给了 ${nameOf(d.family)}`, { family: d.family })
    if (d.status === 'done') push(d.ended_at, `${nameOf(d.family)} 交回来了`, { family: d.family })
    else if (d.stopped === 'user') push(d.ended_at, `你停掉了派给 ${nameOf(d.family)} 的那一次`, { family: d.family })
    else if (d.stopped === 'cap') push(d.ended_at, `派给 ${nameOf(d.family)} 的那一次到上限停下了`, { family: d.family })
    else if (d.status === 'failed') push(d.ended_at, `派给 ${nameOf(d.family)} 没做成${d.note === undefined || d.note.trim() === '' ? '' : `:${d.note.trim()}`}`, { family: d.family })
  }
  const block = task.dispatch_block
  if (block !== undefined) push(block.at, `派不出去:${block.why}`, { family: block.family })
  const c = task.client_dispatch
  if (c !== undefined) {
    if (c.status === 'failed') push(c.at, `没送进 ${nameOf(c.family)}${c.reason === undefined || c.reason.trim() === '' ? '' : `:${c.reason.trim()}`}`, { family: c.family })
    else if (c.status === 'typed') push(c.at, `字写进 ${nameOf(c.family)} 的输入框了,没发出去`, { family: c.family })
    else push(c.at, `送进 ${nameOf(c.family)} 了`, { family: c.family })
    if (c.status === 'sent') push(c.seen_at, `在 ${nameOf(c.family)} 那边看见那一句了(送到,不等于办完)`, { family: c.family })
    if (c.reply_state === 'done') push(c.reply_at, `${nameOf(c.family)} 的回话读回来了`, { family: c.family })
  }
  for (const event of events) {
    if (NOISE_STEPS.includes(event.step)) continue
    const words = STEP_WORDS[event.step]
    if (words === undefined) continue
    push(event.at, words(nameOf(event.family)), { step: event.step, family: event.family })
  }
  marks.sort((a, b) => a.at - b.at)
  return marks
}

/** 一件事算不算「Agent 任务」:派过活(含派不出去那一下)、挂着会话,或者任务账上有它。 */
function isAgentTask(task: TaskView, events: readonly JobEvent[]): boolean {
  if (task.casual === true) return false
  if (task.dispatch !== undefined || task.client_dispatch !== undefined || task.conversation !== undefined || task.dispatch_block !== undefined) return true
  return events.some(event => !NOISE_STEPS.includes(event.step) && STEP_WORDS[event.step] !== undefined)
}

/** 她自己的待办(负责人是她、没派过、也不等她验收)不进复盘 —— 口径与 `stalledMorningLines` 同一份。 */
function isHerOwnTodo(task: TaskView): boolean {
  return task.assignee === 'me' && task.dispatch === undefined && task.client_dispatch === undefined && task.status !== 'confirm'
}

interface Judged {
  verdict: DayVerdict
  because?: string
  stage_result?: string
  blocked_why?: string
  blocked_needs?: DayBlockNeeds
}

/** 完成的明确依据(规范 §5)。「讨论了」「试了」一律不算 —— 这里只认交回、验收、她自己收卡。 */
function doneBecause(task: TaskView, marks: readonly Mark[], window: { since: number, until: number }): string | undefined {
  const inWindow = (at: number | undefined): boolean => at !== undefined && at > window.since && at <= window.until
  if (task.status === 'done' && inWindow(ms(task.done_at))) {
    return `你把这张卡收进「办完」了${task.dispatch?.note === undefined || task.dispatch.note.trim() === '' ? '' : `(${task.dispatch.note.trim()})`}`
  }
  const d = task.dispatch
  if (d?.status === 'done' && inWindow(ms(d.ended_at))) {
    const note = d.note === undefined || d.note.trim() === '' ? '' : `:${d.note.trim()}`
    return `${nameOf(d.family)} 交回来了${note}${task.status === 'confirm' ? ',等你验收' : ''}`
  }
  const c = task.client_dispatch
  if (c?.reply_state === 'done' && inWindow(ms(c.reply_at))) return `${nameOf(c.family)} 的回话读回来了${task.status === 'confirm' ? ',等你验收' : ''}`
  const replied = marks.filter(mark => mark.step === 'replied' && inWindow(mark.at)).at(-1)
  if (replied !== undefined && (task.status === 'confirm' || task.status === 'done')) return `${replied.what}${task.status === 'confirm' ? ',等你验收' : ''}`
  return undefined
}

/** 卡在哪、为什么、要不要外部条件(规范 §7)。**普通的「今天没来得及」不进这里。** */
function blockedOf(task: TaskView, marks: readonly Mark[], window: { since: number, until: number }): { why: string, needs: DayBlockNeeds } | undefined {
  const inWindow = (at: number): boolean => at > window.since && at <= window.until
  // 账上最后一条「出事了」的那一步说话(失败 / 额度 / 锁屏三种各自一种卡法)。
  const signal = marks.filter(mark => mark.step !== undefined && inWindow(mark.at)
    && (FAIL_STEPS.includes(mark.step) || mark.step === 'budget_stop' || mark.step === 'waiting')).at(-1)
  if (signal?.step === 'waiting') return { why: signal.what, needs: '她' }
  if (signal?.step === 'budget_stop') return { why: `${signal.what}(额度)`, needs: '她' }
  if (signal !== undefined) return { why: signal.what, needs: '重派' }

  const block = task.dispatch_block
  if (block !== undefined && inWindow(ms(block.at) ?? -1)) {
    return { why: `派不出去:${block.why}`, needs: block.unlock === true ? '她' : '重派' }
  }
  const d = task.dispatch
  if (d?.stopped === 'cap' && inWindow(ms(d.ended_at) ?? -1)) return { why: `派给 ${nameOf(d.family)} 的那一次到上限停下了(额度)`, needs: '她' }
  if (d?.status === 'failed' && d.stopped === undefined && inWindow(ms(d.ended_at) ?? -1)) {
    const note = d.note === undefined || d.note.trim() === '' ? '' : `:${d.note.trim()}`
    return { why: `派给 ${nameOf(d.family)} 没做成${note}`, needs: '重派' }
  }
  const c = task.client_dispatch
  if (c?.status === 'failed' && inWindow(ms(c.at) ?? -1)) {
    return { why: `没送进 ${nameOf(c.family)}${c.reason === undefined || c.reason.trim() === '' ? '' : `:${c.reason.trim()}`}`, needs: '重派' }
  }
  // 回话读不回来:要她去那扇窗里看一眼(同 itemStanding 把 `unreadable` 判成「在等她」)。
  if (c?.reply_state === 'unreadable' && inWindow(ms(c.reply_at ?? c.seen_at ?? c.at) ?? -1)) {
    return { why: `${nameOf(c.family)} 的回话读不回来`, needs: '她' }
  }
  if (task.status === 'blocked') {
    const mark = `卡上标着阻塞${task.block_reason === undefined ? '' : ` · ${WAIT_REASON_TITLES[task.block_reason]}`}`
    const note = task.note === undefined || task.note.trim() === '' ? undefined : task.note.trim()
    return { why: note === undefined ? mark : `${note}(${mark})`, needs: task.block_reason === 'error' ? '重派' : '她' }
  }
  return undefined
}

/** 推进中:已经做到哪里(规范 §6)。证据评估器那一句最准,其次是那家交回时的摘要,最后是最后一条关键变化。 */
function stageResultOf(task: TaskView, marks: readonly Mark[]): string {
  const line = task.progress?.line
  if (line !== undefined && line.trim() !== '' && task.progress?.state === 'found') return line.trim()
  const note = task.dispatch?.note
  if (note !== undefined && note.trim() !== '') return note.trim()
  return marks.at(-1)?.what ?? '送出去了,还没回话'
}

function judge(task: TaskView, marks: readonly Mark[], window: { since: number, until: number }, chain?: ChainRecord): Judged {
  /*
   * ★ **两步接力还没走完的不算办完**(2026-10-13,卡 F):视频链里豆包那句回话只是第一步的产物,
   * 不是交付 —— 那一步读回来了,`doneBecause` 就会判成完成(14:31 真机那一条)。
   * 她自己把卡收进「办完」了那一档照旧算完成(她的判断比记录硬),所以只挡没收的那几张。
   */
  if (task.status !== 'done' && chainRunning(chain)) {
    return { verdict: 'in_progress', stage_result: CHAIN_STAGE_RESULT[chain.stage] }
  }
  const because = task.status !== 'done' && chain?.stage === 'failed' ? undefined : doneBecause(task, marks, window)
  if (because !== undefined) return { verdict: 'done', because }
  const d = task.dispatch
  if (d?.stopped === 'user') return { verdict: 'paused', because: `你停掉了派给 ${nameOf(d.family)} 的那一次` }
  const blocked = blockedOf(task, marks, window)
  if (blocked !== undefined) return { verdict: 'blocked', blocked_why: blocked.why, blocked_needs: blocked.needs }
  // 接力断了、而卡上这会儿还没挂上阻塞:照接力记录里那句原话算卡点,不编原因。
  if (task.status !== 'done' && chain?.stage === 'failed') {
    const why = chain.note === undefined || chain.note.trim() === '' ? '这条两步接力断了' : chain.note.trim()
    return { verdict: 'blocked', blocked_why: why, blocked_needs: '她' }
  }
  // 有没有「真的往外送过」:规范 §4 —— 启动过不等于有进展。
  const moved = marks.some(mark => mark.at > window.since && mark.at <= window.until
    && (mark.step === 'sent' || mark.step === 'seen' || mark.step === 'replied'
      || mark.what.startsWith('送进') || mark.what.startsWith('在 ') || mark.what.includes('交回来了')))
    || task.dispatch?.status === 'running'
  if (moved) return { verdict: 'in_progress', stage_result: stageResultOf(task, marks) }
  return { verdict: 'new_idle' }
}

/** 停太久的那几件照它的「停法」归档:多半不再需要算暂停,其余算卡点。 */
function judgeStalled(task: TaskView): Judged {
  const standing = task.standing
  const days = standing?.idle_days ?? 0
  if (standing?.case === 'likely_moot') return { verdict: 'paused', because: `${days} 天没动静、也没人在等` }
  const title = standing === undefined ? '停着' : ITEM_STANDING_CASE_TITLES[standing.case]
  return {
    verdict: 'blocked',
    blocked_why: `停了 ${days} 天:${title}`,
    blocked_needs: standing?.case === 'channel_failed' ? '重派' : '她',
  }
}

/** 下一步那一句(规范 §10:每条都要是具体可执行动作)。拼不出具体的就缺席,**不写「继续推进」凑一条**。 */
function nextOf(task: TaskView, judged: Judged): string | undefined {
  const candidate = [task.standing?.next, task.mover?.line].find(one => one !== undefined && one.trim() !== '' && !isVague(one))
  if (candidate !== undefined) return candidate.trim()
  if (judged.verdict === 'blocked') return `${judged.blocked_why};${judged.blocked_needs === '她' ? '要你解一下' : '重派,或者不做了就关掉'}`
  if (judged.verdict === 'paused') return '要接着做就重派,不做了就关掉'
  if (judged.verdict === 'new_idle') return '一个字还没送出去:定下派给谁,把它派出去'
  return undefined
}

export function isVague(line: string): boolean {
  return DAY_REVIEW_VAGUE_WORDS.some(word => line.includes(word))
}

function factText(fact: Omit<DayFact, 'id' | 'text'>): string {
  const parts: string[] = []
  if (fact.goal !== undefined) parts.push(`目标:${fact.goal}`)
  if (fact.families !== undefined && fact.families.length > 0) parts.push(`派过:${fact.families.map(nameOf).join('、')}`)
  if (fact.because !== undefined) parts.push(`依据:${fact.because}`)
  if (fact.stage_result !== undefined) parts.push(`做到:${fact.stage_result}`)
  if (fact.blocked_why !== undefined) parts.push(`卡在:${fact.blocked_why}${fact.blocked_needs === undefined ? '' : `(要${fact.blocked_needs === '她' ? '你' : fact.blocked_needs}才解得开)`}`)
  if (fact.changes !== undefined && fact.changes.length > 0) parts.push(`经过:${fact.changes.join(' → ')}`)
  if (fact.next !== undefined) parts.push(`下一步候选:${fact.next}`)
  const head = fact.verdict === undefined ? fact.title : `「${fact.title}」${DAY_VERDICT_TITLES[fact.verdict]}`
  return parts.length === 0 ? head : `${head};${parts.join(';')}`
}

/** 关键状态变化压到 {@link DAY_REVIEW_CHANGES_MAX} 条:留头一条(启动)与最后几条(规范 §8)。 */
function trimChanges(marks: readonly Mark[]): string[] {
  const words = marks.map(mark => mark.what)
  if (words.length <= DAY_REVIEW_CHANGES_MAX) return words
  return [words[0] as string, ...words.slice(-(DAY_REVIEW_CHANGES_MAX - 1))]
}

/**
 * 一张带编号的事实表(规范 §1 §2 §8 §9)。**纯函数,一个字不编,不经模型。**
 *
 * 编号 `d1…` 是复盘主体(Agent 任务,含停太久并进来的那几件);`n1…` 是随手记、`t1…` 是今天的待办,
 * 两者都是辅助参照 —— 模型只能拿它们当背景与下一步线索,不能写进前三段。
 */
export function dayReviewFacts(input: DayReviewInput): DayFact[] {
  const window = { since: ms(input.since) ?? 0, until: ms(input.until) ?? Number.MAX_SAFE_INTEGER }
  const projects = new Map((input.projects ?? []).map(one => [one.id, one.name]))
  const events = input.jobEvents ?? []
  // 这张卡在不在接力里(只看这一处;接力记录的读法在 `videoChain.view()`)。
  const chains = new Map((input.chains ?? []).map(one => [one.item, one]))
  const rows: Omit<DayFact, 'id'>[] = []
  const seen = new Set<string>()

  const goalOf = (task: TaskView): string | undefined => {
    const name = task.project_id === undefined ? undefined : projects.get(task.project_id)
    if (name !== undefined) return name
    return task.kind === 'topic' ? `选题「${task.title}」` : undefined
  }

  for (const task of input.tasks) {
    if (task.status === 'canceled' || isHerOwnTodo(task)) continue
    const mine = events.filter(event => event.job === task.id)
    const marks = marksOf(task, mine)
    const inWindow = marks.filter(mark => mark.at > window.since && mark.at <= window.until)
    /*
     * 停太久的那几件照旧进来(原本早报另有「停太久」一段,现在并进卡点 / 下一步,免得同一件事出现两次):
     * 门与 `stalledMorningLines` 同一份 —— 只排掉她自己的待办,**不要求它是 Agent 任务**。
     */
    const stalled = task.standing?.stalled === true
    if (inWindow.length === 0 && !stalled) continue
    if (inWindow.length > 0 && !isAgentTask(task, mine)) continue
    const judged = inWindow.length === 0 ? judgeStalled(task) : judge(task, marks, window, chains.get(task.id))
    const families = [...new Set(marks.map(mark => mark.family).filter((one): one is string => one !== undefined))]
    const next = nextOf(task, judged)
    const row: Omit<DayFact, 'id'> = {
      kind: 'agent_task',
      task_id: task.id,
      title: task.title,
      ...(goalOf(task) === undefined ? {} : { goal: goalOf(task) as string }),
      ...(families.length === 0 ? {} : { families }),
      ...judged,
      ...(inWindow.length === 0 ? {} : { changes: trimChanges(inWindow) }),
      ...(next === undefined ? {} : { next }),
      text: '',
      source: inWindow.length === 0 ? '事项卡上现算的「停在哪」' : '事项卡的派活记录与任务账',
    }
    rows.push({ ...row, text: factText(row) })
    seen.add(task.id)
  }

  const notes = (input.notes ?? []).filter(note => {
    const at = ms(note.created_at)
    return at !== undefined && at > window.since && at <= window.until
  })
  for (const note of notes.slice(0, DAY_REVIEW_SECTION_MAX)) {
    rows.push({ kind: 'note', title: note.text.trim(), text: `随手记:${note.text.trim()}`, source: '随手记' })
  }
  for (const item of (input.today_todos?.items ?? []).filter(one => !one.done)) {
    if (seen.has(item.id)) continue
    const line = `待办里原定今天${item.overdue ? `(逾期,原定 ${item.due})` : ''}`
    rows.push({ kind: 'todo', task_id: item.id, title: item.title, next: line, text: `待办:「${item.title}」${line}`, source: '今天的待办' })
  }

  let agent = 0
  let note = 0
  let todo = 0
  return rows.map((row) => {
    if (row.kind === 'agent_task') { agent += 1; return { id: `d${agent}`, ...row } }
    if (row.kind === 'note') { note += 1; return { id: `n${note}`, ...row } }
    todo += 1
    return { id: `t${todo}`, ...row }
  })
}

/* ─────────────────────── 四段 ─────────────────────── */

export interface DaySectionItem {
  /** 任务名称(规范 §14 的「任务名称｜…」那一半)。 */
  name: string
  /** 当前结果 / 当前状态 / 下一步,一两句。 */
  line: string
}

export interface DaySections {
  done: readonly DaySectionItem[]
  in_progress: readonly DaySectionItem[]
  blocked: readonly DaySectionItem[]
  next: readonly DaySectionItem[]
  /** 这一份是模型并的还是程序排的。 */
  by: 'model' | 'program'
}

function emptySections(by: DaySections['by']): DaySections {
  return { done: [], in_progress: [], blocked: [], next: [], by }
}

/**
 * 程序按事实表直接排四段(模型不在时走这条)。短句、只照抄事实表里的字。
 * 下一步的次序:卡点 → 暂停 → 当日新增 → 推进中 → 今天的待办(规范 §10 那几条来源,随手记除外)。
 */
export function dayReviewSectionsByProgram(facts: readonly DayFact[]): DaySections {
  const agent = facts.filter(fact => fact.kind === 'agent_task')
  const of = (verdict: DayVerdict): DayFact[] => agent.filter(fact => fact.verdict === verdict)
  const nextOrder: DayVerdict[] = ['blocked', 'paused', 'new_idle', 'in_progress']
  const next: DaySectionItem[] = []
  for (const verdict of nextOrder) {
    for (const fact of of(verdict)) {
      if (fact.next === undefined || isVague(fact.next)) continue
      next.push({ name: fact.title, line: fact.next })
    }
  }
  for (const fact of facts.filter(one => one.kind === 'todo')) {
    if (fact.next === undefined || isVague(fact.next)) continue
    next.push({ name: fact.title, line: fact.next })
  }
  return {
    done: of('done').map(fact => ({ name: fact.title, line: fact.because ?? '交回来了' })),
    in_progress: of('in_progress').map(fact => ({ name: fact.title, line: `做到:${fact.stage_result ?? '送出去了,还没回话'}` })),
    blocked: of('blocked').map(fact => ({
      name: fact.title,
      line: `卡在:${fact.blocked_why ?? '说不清'}${fact.blocked_needs === undefined ? '' : `(要${fact.blocked_needs === '她' ? '你' : fact.blocked_needs}才解得开)`}`,
    })),
    next,
    by: 'program',
  }
}

function renderSection(id: DaySectionId, items: readonly DaySectionItem[], more: number): string[] {
  if (items.length === 0) return []
  const lines = [DAY_REVIEW_SECTION_HEADS[id], ...items.map(item => `- ${item.name}｜${item.line}`)]
  if (more > 0) lines.push(`另外 ${more} 件在事项里`)
  return lines
}

function renderAll(sections: DaySections, cuts: Readonly<Record<DaySectionId, number>>): string[] {
  const head = [DAY_REVIEW_HEAD, ...(sections.by === 'program' ? [DAY_REVIEW_PROGRAM_ONLY_NOTE] : [])]
  const body = DAY_SECTION_IDS.flatMap((id) => {
    const all = sections[id]
    const keep = Math.max(0, all.length - cuts[id])
    return renderSection(id, all.slice(0, keep), all.length - keep)
  })
  return body.length === 0 ? [] : [...head, ...body]
}

/**
 * 四段 → 要念的那几行。**一段都没有整块不出**(规范 §14「不为了看起来完整强行补充信息」)。
 * 先按 {@link DAY_REVIEW_SECTION_MAX} 收每一段,还超 {@link DAY_REVIEW_MAX_CHARS} 就接着裁 ——
 * **先裁推进中,再裁已完成;卡点与下一步一条不裁**(那两段是明天要动的事)。
 */
export function dayReviewLines(sections: DaySections): string[] {
  const cuts: Record<DaySectionId, number> = {
    done: Math.max(0, sections.done.length - DAY_REVIEW_SECTION_MAX),
    in_progress: Math.max(0, sections.in_progress.length - DAY_REVIEW_SECTION_MAX),
    blocked: Math.max(0, sections.blocked.length - DAY_REVIEW_SECTION_MAX),
    next: Math.max(0, sections.next.length - DAY_REVIEW_SECTION_MAX),
  }
  let lines = renderAll(sections, cuts)
  for (const id of ['in_progress', 'done'] as const) {
    while (lines.join('\n').length > DAY_REVIEW_MAX_CHARS && sections[id].length - cuts[id] > 0) {
      cuts[id] += 1
      lines = renderAll(sections, cuts)
    }
  }
  return lines
}

/* ─────────────────────── 模型那一半 ─────────────────────── */

/** 做一次四段那一问的提示(照 `meetingPrep.buildCardPrompt` 的做法:表 + 只许引编号)。 */
export function buildDayReviewPrompt(facts: readonly DayFact[]): string {
  const table = facts.map(fact => `${fact.id} | ${fact.text} | 出处:${fact.source}`).join('\n')
  return [
    '你在替她写今天的开工复盘(日报)。下面是**程序从记录里数出来的事实表**,每一行一个编号。',
    '',
    table,
    '',
    '规矩(违反的那一条会被整条丢掉):',
    '- **只能引表里的编号**;表里没有的事、没有的数字,一个字都不许写。要提数就照抄那一行里的数。',
    '- `d*` 是 Agent 任务(复盘主体);`n*` 随手记、`t*` 今天的待办只是辅助背景,**不许进前三段**。',
    '- 同一个目标下的几条 `d*` 要**并成一条**(比如搜资料 / 写脚本 / 改标题都服务于「做宣传视频」,就是一件事)。',
    '- 段位照事实表里写的那一档:写着「已完成」的才能进 done,「推进中」进 in_progress,「卡点」进 blocked;',
    '  「暂停」「当日新增,还没实质推进」**只能**进 next。不许自己把一件事升成已完成。',
    '- 任务之间有依赖就在 line 里点明(例:视频脚本没启动,等产品 Demo 定稿)。',
    '- 计划与实际有值得说的偏差(原计划没启动、临时新增并完成、某件占了主要时间)才提,不做流水账对比。',
    '- next 每条都要是**具体可执行动作**;「继续优化」「持续推进」「跟进一下」这种话一个都不许写。',
    '',
    '风格:短、准、结果导向、少解释。每条一两句,照「任务名称｜当前结果 / 当前状态 / 下一步」写。',
    'name ≤ 20 字,line ≤ 60 字。',
    '',
    '只输出一个 JSON 数组,不要别的字:',
    '[{"section":"done" | "in_progress" | "blocked" | "next","fact":"d1","name":"任务名称","line":"一两句"}]',
  ].join('\n')
}

const NUMBER_TOKEN = /\d+(?:\.\d+)?/g

function numberTokens(text: string): string[] {
  return text.match(NUMBER_TOKEN) ?? []
}

const SECTION_VERDICT: Readonly<Record<Exclude<DaySectionId, 'next'>, DayVerdict>> = {
  done: 'done',
  in_progress: 'in_progress',
  blocked: 'blocked',
}

const NAME_MAX = 40
const LINE_MAX = 120

/**
 * 模型的回话 → 四段。**整条丢**的四种(与 `meetingPrep.parseCardReply` 同一条纪律):
 * ① 引了表外的编号;② 名字 / 正文里冒出那一行里没有的数;③ 把不是那一档的事实写进前三段(规范 §5);
 * ④ 下一步写了规范 §10 明令禁止的模糊话。一条都剩不下就报错,由调用方退回程序排。
 */
export function parseDayReviewReply(reply: string, facts: readonly DayFact[]): { sections: DaySections } | { error: string } {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  let items: unknown
  try { items = start >= 0 && end > start ? JSON.parse(reply.slice(start, end + 1)) : undefined }
  catch { items = undefined }
  if (!Array.isArray(items)) return { error: '模型没按格式回' }
  const sections: Record<DaySectionId, DaySectionItem[]> = { done: [], in_progress: [], blocked: [], next: [] }
  let kept = 0
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const one = item as Record<string, unknown>
    const section = DAY_SECTION_IDS.find(id => id === one.section)
    if (section === undefined) continue
    const fact = typeof one.fact === 'string' ? facts.find(row => row.id === one.fact) : undefined
    if (fact === undefined) continue
    if (section !== 'next' && fact.verdict !== SECTION_VERDICT[section]) continue
    if (section !== 'next' && fact.kind !== 'agent_task') continue
    const name = typeof one.name === 'string' ? one.name.trim() : ''
    const line = typeof one.line === 'string' ? one.line.trim() : ''
    if (name === '' || line === '' || name.length > NAME_MAX || line.length > LINE_MAX) continue
    if (section === 'next' && isVague(line)) continue
    const allowed = new Set(numberTokens(`${fact.text}\n${fact.source}\n${fact.title}`))
    if (numberTokens(`${name}\n${line}`).some(token => !allowed.has(token))) continue
    if (sections[section].length >= DAY_REVIEW_SECTION_MAX) continue
    sections[section].push({ name, line })
    kept += 1
  }
  if (kept === 0) return { error: '模型给的几条一条都对不上事实表' }
  return { sections: { ...sections, by: 'model' } }
}

/**
 * 出一份四段:事实由程序判,归并与措辞问一次模型;模型不在 / 抛了 / 回话对不上就按事实表直接排,
 * 并在正文里注明这一份只有程序拼的部分。**绝不抛** —— 四段出不来不该把整份早报一起拖没。
 *
 * 一件 Agent 任务都没有(含停太久的)就**整块不出**:那时「今天的待办」「停太久」各自那一段照旧单独出。
 */
export async function composeDayReview(
  input: DayReviewInput & { chat?: (prompt: string) => Promise<string> },
): Promise<{ lines: string[], sections: DaySections, note?: string }> {
  const facts = dayReviewFacts(input)
  if (!facts.some(fact => fact.kind === 'agent_task')) return { lines: [], sections: emptySections('program') }
  const fallback = (note?: string): { lines: string[], sections: DaySections, note?: string } => {
    const sections = dayReviewSectionsByProgram(facts)
    return { lines: dayReviewLines(sections), sections, ...(note === undefined ? {} : { note }) }
  }
  if (input.chat === undefined) return fallback()
  let reply: string
  try { reply = await input.chat(buildDayReviewPrompt(facts)) }
  catch (error) { return fallback(`日报四段按记录排的(${(error as Error)?.message ?? '模型没回'})`) }
  const parsed = parseDayReviewReply(reply, facts)
  if ('error' in parsed) return fallback(`日报四段按记录排的(${parsed.error})`)
  return { lines: dayReviewLines(parsed.sections), sections: parsed.sections }
}

/*
 * 规范 §10 第五条来源(「随手记·灵感中已明确转化为行动的内容」)**这一版缺席**:
 * 随手记在仓库里只有 `NoteView { id, text, created_at }` 三个字段 ——「一个框,不分类不打标签」
 * 是 PRD §5.5 的产品决定(`server/notes.ts` 文件头),所以「已明确转化为行动」这个记号**压根不存在**,
 * 也没有随手记 → 事项的连线。于是这里只把窗口内新记的几条当背景(`n*` 行)交给模型,
 * **程序排的下一步一条都不从随手记出** —— 认不出来就缺席,不替她把一句想法判成一件要做的事。
 */
