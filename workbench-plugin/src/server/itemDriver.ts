/**
 * **负责人驱动**(2026-09-25,卡 N;设计 docs/设计-谁来做与进度靠证据-2026-09-25.md 第一节第 2、5 条)。
 *
 * 维护者:「右侧现在有事项和看板了,哪些是谁来处理,这个明确吗」—— 以前看板上负责人只是个标签:除了引导落地那第一件
 * 真派了,其余写「Claude」的卡没人做、没人提醒。现在负责人决定谁动:
 *
 * | 负责人 | 驱动做什么 |
 * |---|---|
 * | 某家 AI | 卡在「待办」:**保持待办、不问、不派**(2026-10-29 删规矩第一批 E#2:待办有负责人 ≠ 现在开工)。卡上有「开工」这样的明确委托 —— 她交代的、或她在卡上点的「派给 X」—— 才派;派的指令按证据写,不照引导旧话 |
 * | 事务官 | 同上:只挂负责人的卡不动;她点在卡上「交给事务官」才开她那条会话 |
 * | 他 / 同事 / 别人 | 不派;他的进「今天要做」与早报,同事 / 别人的到期提醒(itemMover.ownerMorningLines) |
 *
 * 派出去的活**交回来**(卡上 `reply_state` 变成 done / unreadable、命令行那只手结束)→ 叫进度核对当场核那一张。
 *
 * 纪律:
 * - **不重复派**:一张卡驱动只派一次(记在 `drive.json`);他把卡挪回「待办」想再派,在卡上点「派给 X」(`driveNow`)。
 * - **别的路在管的不插手**:派出去过的(任何一条路:中枢点名直派、派活弹窗、引导落地第一件)、事务官那条会话还开着的,
 *   驱动不碰;中枢建的卡带负责人的,`hubDepsFor` 那一下 `claim` 过,驱动这一拍也看得见。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentCard, AgentDispatchFamily, ComposerMode, TaskAssignee, TaskProgressView, TaskView } from '../protocol.ts'
import { ASSIGNEE_NAMES, PROGRESS_NONE_LINE, assigneeName, dispatchAskText, isAgentCardAssignee, isAgentDispatchFamily } from '../protocol.ts'
import { clip, plainText, shortAt } from './progressEvidence.ts'
import { isTestItem } from './progressSources.ts'

export function defaultDriveFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/drive.json`
}

/** 卡 O `dispatchChoices` 回的形状里驱动用得到的那几格(结构性读取,不 import 卡 O 的文件)。 */
export interface DispatchChoicesLike {
  kind?: string
  line?: string
  options: readonly {
    family: string
    ok: boolean
    why?: string
    fix?: { label: string }
    balance?: { text?: string }
    self?: { line?: string }
  }[]
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ItemDriverDeps {
  tasks: {
    list: () => Promise<{ tasks: readonly TaskView[], agent_cards?: readonly AgentCard[] }>
    update: (id: string, input: { note?: string | null }) => Promise<boolean>
  }
  now: () => Date
  file: string
  /** 此刻的档(输入框那一档:只出方案 / 先问我 / 自动办)。卡上交办时记的档优先(`task.mode`)。 */
  mode: () => Promise<ComposerMode>
  /**
   * 审批经纪人:2026-10-29 删规矩第一批 E#2 起**不再使用** —— 「派给 X 开工?」那一问整个删掉
   * (待办有负责人 ≠ 现在开工;开工只来自她明确委托:她说的、或她在卡上点的)。字段暂留,
   * 让存量调用方(与旧测试)的 deps 对象不至于编译即红;整组清理随下一批。
   */
  approvals?: {
    ask: (req: { sessionId: string, tool: string, reason?: string, detail?: { say?: string, proposal?: true }, signal?: AbortSignal }) => { id: string, answer: Promise<ApprovalOutcome> }
    list: () => readonly { session_id: string }[]
  }
  /** 派给某家(卡 F 的 `dispatchItem`,可带卡 O 的 kind)。`family` 也收名片 id —— 用哪一家由派活那一层按名片解析。 */
  dispatch?: (taskId: string, input: { family: string, text: string, source: 'item', kind?: string }) => Promise<{ ok: boolean, note: string }>
  /** 交给事务官:给这张卡开她那条会话(只开,不新建卡)。 */
  butlerStart?: (taskId: string, text: string) => Promise<{ ok: boolean, note?: string }>
  /** 派之前按证据核一次(进度核对)。 */
  precheck?: (taskId: string) => Promise<TaskProgressView | undefined>
  /** 卡 O 的挑手(`server.dispatchChoices`)。缺席 = 照卡 F 的三只手顺序。 */
  choices?: (taskId: string, input: { text: string }) => Promise<DispatchChoicesLike | undefined>
  /** 派出去的活交回来了(叫进度核对当场核那一张)。 */
  onReturn?: (taskId: string) => void
  onChanged?: () => void
  /** 同一时刻最多挂几问。 */
  maxAsks?: number
  intervalMs?: number
}

interface DriveRecord {
  /** 负责人 + 标题:变了就当新卡(之前的「不行」作废)。 */
  fp: string
  asked_at?: string
  declined_at?: string
  dispatched_at?: string
  /** 为什么没派(挑手说不行、只出方案档)。 */
  held?: { why: string, who: 'me' | 'butler' }
  /** 驱动第一次上线之前就在看板上的卡(「自动办」档也先问一次)。 */
  legacy?: boolean
  /** 上一次派没派成的时刻(没成的半小时内不再自动试,免得一拍一拍地撞)。 */
  failed_at?: string
  /** 别的路接过这张的「派不派」(他交代时点名那条路、引导落地第一件):驱动不再问。 */
  claimed_at?: string
  /**
   * 证据和卡上对不上(卡在「待办」,证据说已经做完 / 发了版):先不问不派,等他看一眼;到这个时刻之前不再核。
   * 负责人或标题改了(fp 变)、他在卡上点「派给 X」都作废。
   */
  hold_until?: string
}

interface DriveFile {
  version: 1
  since: string
  cards: Record<string, DriveRecord>
  /** 派出去的活交回来的记号(见过的就不再叫进度核对)。 */
  returns: Record<string, string>
}

export interface ItemDriver {
  /** 挂在 1 秒 tick 上;内部按 intervalMs 限频。 */
  pump: () => void
  /** 看板变了:尽快补一拍。 */
  kick: () => void
  /** 跑一拍(测试 / 起服务后第一拍)。 */
  reconcile: () => Promise<void>
  /** 为什么没派(挂到 mover 上)。 */
  held: () => ReadonlyMap<string, { why: string, who: 'me' | 'butler' }>
  /** 他在卡上点「派给 X」/「交给事务官」:不再问,直接派(他点的这一下就是点头)。 */
  driveNow: (taskId: string) => Promise<{ ok: boolean, note: string }>
  /**
   * 按证据核过再派(引导落地的第一件也走它)。**指令一律按证据写**,不照调用方手里的旧话 ——
   * 引导落地那句「架构还差一截、文案不用写」正是这张卡要纠正的。
   */
  dispatchChecked: (taskId: string, input: { family: AgentDispatchFamily }) => Promise<{ ok: boolean, note: string }>
  /**
   * 别的路已经在管这张的派不派(他交代时点了名:当场直派,或挂了「派给 X」那一问 —— 卡 F):驱动不再问。
   * **同步**记进内存(驱动那一拍可能正跑到一半),再落进 drive.json。
   */
  claim: (taskId: string) => void
}

export const DRIVE_INTERVAL_MS = 30_000
export const DRIVE_MAX_ASKS = 3
/** 派没派成之后多久再自动试。 */
export const DRIVE_RETRY_MS = 30 * 60_000
/** 证据和卡上对不上之后多久再核(等他看一眼)。 */
export const DRIVE_MISMATCH_HOLD_MS = 6 * 60 * 60_000

/** 这张名片按哪一家算(派活解析同一个判法的一处副本:runtime.family 缺席退回 hand)。 */
function cardFamilyOf(card: Pick<AgentCard, 'hand' | 'runtime'>): string {
  return card.runtime?.family ?? card.hand
}

/** 一个负责人怎么称呼:名片带表换名片名,其余同 `assigneeName`。 */
function assigneeDisplay(who: TaskAssignee | undefined, cards: readonly AgentCard[]): string {
  return assigneeName(who, cards.map(one => ({ id: one.id, name: one.name })))
}

/** 「证据和卡上对不上」那一句(挂到「现在该谁动」上)。 */
export function mismatchWhy(task: Pick<TaskView, 'assignee'>, progress: TaskProgressView, cards: readonly AgentCard[] = []): string {
  const who = task.assignee === 'dsh' ? '交给事务官' : `派给 ${assigneeDisplay(task.assignee, cards)}`
  // 说人话:他不知道「证据」指什么 ——「我看到的」。
  return `我看到的和卡上写的对不上:${clip(progress.mismatch ?? progress.line, 40)} —— 先不派,你看一眼(要派在卡上点「${who}」)`
}

/**
 * 驱动管哪几张:他交代的 / 看板上的普通事项,在「待办」,负责人是某家 AI(含名片,按名片自己的命令行家判)或事务官。
 * `cards` 只读 `id / hand / runtime` 三格(与 `dispatchRun.cardDispatchFamily` 同一个决定的两处副本,不许第三份)。
 */
export function drivable(task: TaskView, cards?: readonly Pick<AgentCard, 'id' | 'hand' | 'runtime'>[]): boolean {
  if (task.status !== 'todo') return false
  if (task.kind === 'topic' || task.kind === 'feature' || task.origin === 'call' || isTestItem(task)) return false
  /*
   * ★ **演示数据不许触发真派活**(2026-10-13,卡「演示数据一键放进去」)。
   * 那一套里有一张「当日新增、还没实质推进」的卡(待办 + 负责人写着某一家 + 账上只有一条「交给了它」)——
   * 正好落在驱动管的那几张里。真派出去就会在演示机上开那家的窗、送一段话出去,
   * 而放演示数据这件事说好了**只写记录**。所以这一格在这里也是一道门(同 `isTestItem` 的位置)。
   */
  if (task.demo === true) return false
  // 已经有人接过:派出去过(任何一条路)、事务官那条会话还开着。再派只走卡上那颗「派给 X」(driveNow)——
  // 同一件事两条路在派是最坏的一种(驱动问一句、那边也派一次)。
  if (task.dispatch !== undefined || task.client_dispatch !== undefined) return false
  if (task.conversation !== undefined && task.conversation.archived_at === undefined) return false
  const who = task.assignee
  if (who === undefined) return false
  if (who === 'dsh' || isAgentDispatchFamily(who)) return true
  // 名片负责人(2026-10-22,卡「名片补四样与Kimi命令行手」B):照旧按它的 runtime.family(缺席退回 hand)
  // 判是不是 AI —— 名片被删了 / 没传表,认不出,不驱动(派活那一层会如实说)。
  if (!isAgentCardAssignee(who)) return false
  const card = cards?.find(one => one.id === who)
  return card !== undefined && isAgentDispatchFamily(cardFamilyOf(card))
}

function fingerprintOf(task: TaskView): string {
  return `${task.assignee ?? ''}|${task.title}`
}

const PRIORITY_RANK: Readonly<Record<string, number>> = { high: 0, mid: 1, low: 2 }

/**
 * 按证据写的派活指令(设计第一节第 5 条:派活之前先按证据核一次这件事真到哪了,指令里按证据写,不照引导旧话)。
 * 卡上描述只有他亲口交代的才带(引导排的那几句是口述、可能过时);证据说在等他的,明说这一步不用那家做。
 */
export function dispatchInstruction(task: TaskView, progress: TaskProgressView | undefined): string {
  const lines: string[] = [task.title]
  if (task.origin === 'user' && task.desc !== undefined && task.desc !== task.title) lines.push(clip(plainText(task.desc), 300))
  if (progress === undefined || progress.state === 'none') {
    // 这段话会原样摆在卡上(「送出去的原话」):写给那家看,也得让他看得懂;不是每个项目都是写代码,不说「仓库」「提交」。
    lines.push('现在到哪:工作台没看到这件事的进展 —— 先看看跟这件事有关的文件和最近的改动,弄清做到哪了再动手。')
  }
  else {
    const when = shortAt(progress.checked_at)
    lines.push(`现在到哪(工作台${when === '' ? '' : ` ${when} `}看过的):${progress.line}`)
    const basis = progress.basis.slice(0, 3).map((one) => {
      const at = shortAt(one.at)
      return `${one.source}${at === '' ? '' : ` ${at}`}${one.quote === undefined ? '' : `:「${one.quote}」`}`
    })
    if (basis.length > 0) lines.push(`依据:${basis.join(';')}`)
    if (progress.mismatch !== undefined) lines.push(`卡上写的和工作台看到的对不上:${progress.mismatch} —— 以看到的为准,拿不准就停下来问。`)
    if (progress.waiting_on === 'me') lines.push('工作台看到有一步在等他本人(审、点头或给材料)—— 那一步不用你做,先把你能做的做完,做不下去就说清卡在哪。')
  }
  lines.push('先看这些依据,弄清做到哪了再接着做,别从头重做;删文件、发布、合并这类收不回来的事,先停下来问他。')
  lines.push('做完用三五句话汇报:做了什么、改了哪些文件、还差什么。')
  return lines.join('\n')
}

/** 「这张派给 X 开工?」那一问的小字 —— 2026-10-29 E#2 起这一问不再存在;函数保留给存量调用方,不再被驱动调用。 */
export function askReason(task: TaskView, progress: TaskProgressView | undefined, extra?: string, cards: readonly AgentCard[] = []): string {
  // 字在 protocol.ts 的 dispatchAskText:外层这一问与卡上点「派给 X」之后那一下确认(电脑、手机)同一句。
  return dispatchAskText(task.assignee, progress, extra, undefined, cards.map(one => ({ id: one.id, name: one.name })))
}

export function createItemDriver(deps: ItemDriverDeps): ItemDriver {
  const intervalMs = deps.intervalMs ?? DRIVE_INTERVAL_MS
  let data: DriveFile | undefined
  let fresh = false
  let lastRun = 0
  let busy = false
  let again = false
  /** 别的路刚接过的(`claim`、`dispatchChecked`):落进 drive.json 之前先在内存里挡住这一拍。 */
  const claimedNow = new Set<string>()
  const heldMap = new Map<string, { why: string, who: 'me' | 'butler' }>()

  /** 只读一次盘:几条路同时第一次 load(驱动那一拍、claim、driveNow)拿到的是**同一份**,谁写的都不丢。 */
  let loading: Promise<DriveFile> | undefined
  async function load(): Promise<DriveFile> {
    if (data !== undefined) return data
    loading ??= (async (): Promise<DriveFile> => {
      let got: DriveFile
      try {
        const raw = JSON.parse(await readFile(deps.file, 'utf8')) as Partial<DriveFile>
        got = {
          version: 1,
          since: typeof raw.since === 'string' ? raw.since : deps.now().toISOString(),
          cards: typeof raw.cards === 'object' && raw.cards !== null ? raw.cards as Record<string, DriveRecord> : {},
          returns: typeof raw.returns === 'object' && raw.returns !== null ? raw.returns as Record<string, string> : {},
        }
      }
      catch {
        got = { version: 1, since: deps.now().toISOString(), cards: {}, returns: {} }
        fresh = true
      }
      for (const [id, record] of Object.entries(got.cards)) if (record.held !== undefined) heldMap.set(id, record.held)
      data = got
      return got
    })()
    return await loading
  }

  async function save(): Promise<void> {
    if (data === undefined) return
    await mkdir(dirname(deps.file), { recursive: true })
    const tmp = `${deps.file}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await rename(tmp, deps.file)
  }

  function setHeld(id: string, record: DriveRecord, held: DriveRecord['held']): boolean {
    const before = JSON.stringify(record.held ?? null)
    if (held === undefined) { delete record.held; heldMap.delete(id) }
    else { record.held = held; heldMap.set(id, held) }
    return before !== JSON.stringify(held ?? null)
  }

  async function precheck(taskId: string): Promise<TaskProgressView | undefined> {
    try { return await deps.precheck?.(taskId) }
    catch { return undefined }
  }

  /**
   * 这是什么活:**用挑手回的那一个**(`choices.kind`)。这一拍已经问过就用那一份,没有就现问一次;
   * 挑手没接 / 问不出来回 undefined —— 那时派活那一层照旧按字认(老行为)。
   */
  async function kindFor(taskId: string, task: TaskView, pre?: DispatchChoicesLike): Promise<string | undefined> {
    const choices = pre ?? (deps.choices === undefined
      ? undefined
      : await deps.choices(taskId, { text: task.title }).catch(() => undefined))
    return typeof choices?.kind === 'string' ? choices.kind : undefined
  }

  function holdForMismatch(taskId: string, task: TaskView, record: DriveRecord, progress: TaskProgressView, cards: readonly AgentCard[] = []): void {
    record.hold_until = new Date(deps.now().getTime() + DRIVE_MISMATCH_HOLD_MS).toISOString()
    setHeld(taskId, record, { why: mismatchWhy(task, progress, cards), who: 'me' })
  }

  /**
   * `explicit`:他在卡上点的 / 他批了的;不是 = 「自动办」档驱动自己起的(那时别的路接过就让开)。
   *
   * ★ `pre` = 这一拍**已经问过挑手的那一份**(`deps.choices`)。2026-09-25(卡 Z)起驱动派活用的
   * 「这是什么活」(`kind`)就取它 —— 与问他那一句里说的、与挑手算出来的**是同一个判断**。
   * 以前这里不带 `kind`,派活那一层自己用纯函数 `jobKindOf` 再认一遍(不读额度、不读体检),
   * 于是「问的时候说是写代码的活、派的时候当成聊天」是可能的。他自己在卡上点「派给 X」那一路没有 `pre`,
   * 这里现问一次挑手(节流过的,不多一次真 I/O)。
   */
  async function run(taskId: string, explicit: boolean, pre?: DispatchChoicesLike): Promise<{ ok: boolean, note: string }> {
    const file = await load()
    const state = await deps.tasks.list()
    const task = state.tasks.find(one => one.id === taskId)
    if (task === undefined) return { ok: false, note: '没有这张卡' }
    const cards = state.agent_cards ?? []
    const who = task.assignee
    if (who === undefined || (who !== 'dsh' && !isAgentDispatchFamily(who) && !isAgentCardAssignee(who))) {
      return { ok: false, note: '这张的负责人不是某家 AI、名片或事务官,不派' }
    }
    const progress = await precheck(taskId)
    // 核证据要一会儿:这期间别的路接过了(点名直派、引导落地第一件)→ 让开。
    if (!explicit && (claimedNow.has(taskId) || file.cards[taskId]?.claimed_at !== undefined)) return { ok: false, note: '别的路已经在办这张' }
    const record = file.cards[taskId] ?? { fp: fingerprintOf(task) }
    // 「自动办」档:证据和卡上对不上(卡在待办、证据说已经做完)→ 先不派,等他看一眼。他自己点的照派。
    if (!explicit && progress?.state === 'mismatch') {
      holdForMismatch(taskId, task, record, progress)
      file.cards[taskId] = record
      await save()
      deps.onChanged?.()
      return { ok: false, note: record.held?.why ?? '我看到的和卡上写的对不上,先不派' }
    }
    const instruction = dispatchInstruction(task, progress)
    let result: { ok: boolean, note: string }
    if (who === 'dsh') {
      if (deps.butlerStart === undefined) return { ok: false, note: '事务官那条会话接不上,这张先不办' }
      const started = await deps.butlerStart(taskId, instruction)
      result = { ok: started.ok, note: started.note ?? (started.ok ? '交给事务官了' : '事务官那条会话没开成') }
    }
    else {
      if (deps.dispatch === undefined) return { ok: false, note: '派活没接上' }
      const kind = await kindFor(taskId, task, pre)
      // 名片负责人:family 传名片 id,用哪一家 / 在哪个仓库 / 带哪个模型由派活那一层按名片解析(一处)。
      result = await deps.dispatch(taskId, { family: who, text: instruction, source: 'item', ...(kind === undefined ? {} : { kind }) })
    }
    if (result.ok) {
      record.dispatched_at = deps.now().toISOString()
      delete record.declined_at
      delete record.failed_at
      setHeld(taskId, record, undefined)
    }
    else {
      record.failed_at = deps.now().toISOString()
      setHeld(taskId, record, { why: `没派成:${clip(result.note, 60)}`, who: 'me' })
    }
    file.cards[taskId] = record
    await save()
    deps.onChanged?.()
    return result
  }

  async function reconcile(): Promise<void> {
    const file = await load()
    const state = await deps.tasks.list()
    const board = state.tasks
    const cards = state.agent_cards ?? []
    // Persist the first observed baseline even when no receipt has arrived yet.
    let changed = fresh

    // 派出去的活交回来了 → 叫进度核对当场核那一张。第一次上线时把已经交回来的记成见过(不回放历史)。
    for (const task of board) {
      const cd = task.client_dispatch
      const back = cd !== undefined && (cd.reply_state === 'done' || cd.reply_state === 'unreadable')
        ? `window:${cd.reply_at ?? cd.at}`
        : task.dispatch !== undefined && (task.dispatch.status === 'done' || task.dispatch.status === 'failed')
          ? `${task.dispatch.hand ?? 'cli'}:${task.dispatch.ended_at ?? task.dispatch.started_at}`
          : undefined
      const receipt = task.receipt
      const receiptKey = receipt === undefined ? undefined : createHash('sha256').update(JSON.stringify([
        task.round ?? 1, receipt.at, receipt.kind, receipt.by, receipt.message_id, receipt.text, receipt.evidence,
      ])).digest('hex')
      // Dispatch completion and independent receipt are different observations. Removing a receipt is not a return.
      const marks: [string, string][] = []
      if (back !== undefined) marks.push([task.id, back])
      if (receiptKey !== undefined) marks.push([`receipt:${task.id}`, receiptKey])
      let returned = false
      for (const [key, mark] of marks) {
        if (file.returns[key] === mark) continue
        file.returns[key] = mark
        changed = true
        returned = true
      }
      if (!returned) continue
      await save()
      if (!fresh) deps.onReturn?.(task.id)
    }

    const mode = await deps.mode()
    const since = Date.parse(file.since)

    const candidates = board.filter(task => drivable(task, cards)).sort((a, b) => {
      const pa = PRIORITY_RANK[a.priority ?? 'mid'] ?? 1
      const pb = PRIORITY_RANK[b.priority ?? 'mid'] ?? 1
      if (pa !== pb) return pa - pb
      return (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.created_at.localeCompare(b.created_at)
    })
    const live = new Set(candidates.map(task => task.id))
    // 不再该驱动的卡(办了、改了负责人、挪走了):「为什么没派」那一句撤掉。
    for (const id of [...heldMap.keys()]) {
      if (!live.has(id) && file.cards[id] !== undefined) changed = setHeld(id, file.cards[id] as DriveRecord, undefined) || changed
    }

    /*
     * ★ 2026-10-29 删规矩第一批 E#2:负责人驱动**不问、不自动派**。
     * 待办有负责人 ≠ 现在开工 —— 只挂了负责人的卡保持待办;「开工」这样的明确委托
     * (她交代的 → 中枢 dispatch;她在卡上点的 → `driveNow` / `dispatchChecked`)才派。
     * 这一拍只剩两件事:记档(plan 档的「先不派」照写)、把不再该驱动的卡上的 held 撤掉。
     */
    for (const task of candidates) {
      const fp = fingerprintOf(task)
      let record = file.cards[task.id]
      if (record === undefined || record.fp !== fp) {
        record = { fp }
        file.cards[task.id] = record
        changed = true
      }
      const taskMode = task.mode ?? mode
      if (taskMode === 'plan') {
        changed = setHeld(task.id, record, { why: '「只出方案」档:先不派(要派在卡上点一下)', who: 'butler' }) || changed
        continue
      }
      // 没派成的那一句(引导落地 / 卡上点派失败)保留到重试窗结束 —— 不自动重试,
      // 只是让她看得见为什么没派;窗过了清掉,下次有明确委托照派。
      const failedRecent = record.failed_at !== undefined && deps.now().getTime() - Date.parse(record.failed_at) < DRIVE_RETRY_MS
      if (!failedRecent) changed = setHeld(task.id, record, undefined) || changed
    }

    fresh = false
    if (changed) {
      await save()
      deps.onChanged?.()
    }
  }

  function schedule(force: boolean): void {
    const now = Date.now()
    if (!force && now - lastRun < intervalMs) return
    if (busy) { again = true; return }
    busy = true
    lastRun = now
    void reconcile().catch(() => undefined).finally(() => {
      busy = false
      if (again) { again = false; schedule(true) }
    })
  }

  return {
    pump: () => schedule(false),
    kick: () => schedule(true),
    reconcile: async () => { await reconcile() },
    held: () => heldMap,
    driveNow: async (taskId) => {
      const file = await load()
      const record = file.cards[taskId]
      if (record !== undefined) { delete record.declined_at; delete record.dispatched_at; delete record.claimed_at; delete record.hold_until }
      claimedNow.delete(taskId)
      // 他点了这一下就是点头:直接派。
      return await run(taskId, true)
    },
    claim: (taskId) => {
      claimedNow.add(taskId)
      void (async () => {
        const file = await load()
        const task = (await deps.tasks.list()).tasks.find(one => one.id === taskId)
        if (task === undefined) return
        const record = file.cards[taskId] ?? { fp: fingerprintOf(task) }
        record.fp = fingerprintOf(task)
        record.claimed_at = deps.now().toISOString()
        setHeld(taskId, record, undefined)
        file.cards[taskId] = record
        await save()
        claimedNow.delete(taskId)
        deps.onChanged?.()
      })().catch(() => undefined)
    },
    dispatchChecked: async (taskId, input) => {
      // 引导落地的第一件:驱动那一拍别再为它问一句「派给 X 开工?」。
      claimedNow.add(taskId)
      const task = (await deps.tasks.list()).tasks.find(one => one.id === taskId)
      if (task === undefined) return { ok: false, note: '没有这张卡' }
      if (deps.dispatch === undefined) return { ok: false, note: '派活没接上' }
      const progress = await precheck(taskId)
      const text = dispatchInstruction(task, progress)
      const kind = await kindFor(taskId, task)
      const result = await deps.dispatch(taskId, { family: input.family, text, source: 'item', ...(kind === undefined ? {} : { kind }) })
      const file = await load()
      const record = file.cards[taskId] ?? { fp: fingerprintOf(task) }
      if (result.ok) record.dispatched_at = deps.now().toISOString()
      else {
        record.failed_at = deps.now().toISOString()
        setHeld(taskId, record, { why: `没派成:${clip(result.note, 60)}`, who: 'me' })
      }
      file.cards[taskId] = record
      await save()
      claimedNow.delete(taskId)
      return result
    },
  }
}
