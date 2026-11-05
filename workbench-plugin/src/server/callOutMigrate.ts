/**
 * ★ **座机台账里那些老的会话事项 id,启动时迁一次**(2026-10-03,卡「两条接缝」;
 * 决策记录 10-03 早 ⑦ 第二条;审计 `docs/审计-0928起送话修复覆盖-2026-10-02.md` 第二表第 15 条)。
 *
 * ## 为什么要迁
 *
 * 「为某条会话那一问打电话」那条路的事项 id 从前是 `session:<会话 id>` —— **没有家名**。
 * 2026-10-03 起它与闸、账、`/state.waiting` 同一个定法(`jobKey.sessionJobId`:`session:<家>/<会话 id>`)。
 * 落了盘的老行不迁的后果是真的:
 *   - 她在电脑 / 手机上答了那一问,`dropQueuedAsk` 拿**新**的 id 去撤那一通 —— 老行对不上,
 *     于是那通电话还排着,手机一上线就为一个**已经答掉的问**打过去(卡 AQ 修的正是这件事);
 *   - 闸(`jobPhaseOf`)对老行答「查不出」,「这件事早就收场了还在动那一家」那条拦不住它。
 *
 * ## 只做三件事,一件都不多
 *
 * 1. **先备份**:原文件整份抄到旁边 `<文件>.bak-<YYYY-MM-DD>`(同一天跑两次不覆盖那份备份);
 * 2. 只改 `log[].item_id` 与 `log[].merged[].item_id`;
 * 3. 文件里记一个标记(`migrated: ['session-job-id']`),下次启动看见就**整支跳过**。
 *
 * `seen` 不用迁:那里面放的是**事件 key**(`ask:session:<会话 id>:<那个框出现的时刻>`,
 * 见 `sessionAskCalls.sessionAskCallKey`),这张卡一个字都没动它。
 *
 * ## 认不出家的那几行:**原样留着**
 *
 * 家名不在台账里(那是从前这条格式的病根),所以要从别处的证据反查
 * ({@link CallOutMigrateInput.familyOf} —— 看板上那几张卡认下的会话、此刻认得出的会话)。
 * **查不到就不改**(D13:查不到不等于可以猜一个家名)。不改的后果与 10-03 之前一字不差:
 * `sessionOfJob` 对它答 undefined → 闸 `unknown` → 放行;`sessionAskRef` 照旧读得出会话 id,
 * 所以电话里那一问答得进去。报告里数出来有几行没迁。
 *
 * 全是纯函数 + 一支薄薄的读写(`runCallOutSessionIdMigration`)。**不对真机数据跑**:
 * 发版时由工作台自己启动那一下跑,用例只对夹具跑。
 */
import { copyFile, readFile } from 'node:fs/promises'
import { legacySessionOfJob, sessionJobId } from './jobKey.ts'

/** 这一支迁移的标记。文件里出现它就不再跑第二遍。**别在别处写这个字面量**。 */
export const CALL_OUT_MIGRATION_SESSION_JOB_ID = 'session-job-id'

/** 迁移看得见的那一点点台账(不引 `callOut.ts` 那一整套,免得这一处成了新的接缝)。 */
export interface CallOutMigrateFile {
  seen?: unknown
  log?: unknown
  migrated?: unknown
  [key: string]: unknown
}

export interface CallOutMigrateReport {
  /** 真改了几行(`log` 与 `merged` 合起来数)。 */
  changed: number
  /** 认不出家、原样留着的有几行。 */
  unresolved: number
}

export interface CallOutMigrateInput {
  file: CallOutMigrateFile
  /** 这条会话是哪一家的。查不到回 undefined —— 那一行**原样留着**,不猜。 */
  familyOf: (sessionId: string) => string | undefined
}

/** 这份台账已经迁过了没有。 */
export function callOutMigrated(file: CallOutMigrateFile, tag: string): boolean {
  const done = file.migrated
  return Array.isArray(done) && done.includes(tag)
}

/** 这一行的事项 id 要不要改、改成什么。不是老格式 / 认不出家 → undefined。 */
function nextItemId(itemId: unknown, familyOf: (sessionId: string) => string | undefined): string | undefined {
  if (typeof itemId !== 'string' || itemId === '') return undefined
  const legacy = legacySessionOfJob(itemId, { withAgent: false })
  if (legacy === undefined) return undefined
  const family = familyOf(legacy.sessionId)
  if (family === undefined || family.trim() === '') return undefined
  return sessionJobId(family, legacy.sessionId)
}

/**
 * ★ **纯函数那一半**:台账进、台账出。**幂等** —— 迁过的行(带 `/`)`legacySessionOfJob` 对它答
 * undefined,所以再跑一遍一个字都不动;整支还有文件里那个标记挡着。
 */
export function migrateCallOutSessionIds(input: CallOutMigrateInput): CallOutMigrateReport & { file: CallOutMigrateFile } {
  let changed = 0
  let unresolved = 0
  const rows = Array.isArray(input.file.log) ? input.file.log : []
  const log = rows.map((row) => {
    // 坏行(不是对象 / 没有 item_id)原样留着 —— 读台账那一处自己会丢掉它(`sanitizeEntry`)。
    if (typeof row !== 'object' || row === null) return row
    const entry = { ...(row as Record<string, unknown>) }
    const own = nextItemId(entry.item_id, input.familyOf)
    if (own !== undefined) { entry.item_id = own; changed += 1 }
    else if (legacySessionOfJob(typeof entry.item_id === 'string' ? entry.item_id : '', { withAgent: false }) !== undefined) unresolved += 1
    if (Array.isArray(entry.merged)) {
      entry.merged = entry.merged.map((one) => {
        if (typeof one !== 'object' || one === null) return one
        const sub = { ...(one as Record<string, unknown>) }
        const next = nextItemId(sub.item_id, input.familyOf)
        if (next !== undefined) { sub.item_id = next; changed += 1 }
        else if (legacySessionOfJob(typeof sub.item_id === 'string' ? sub.item_id : '', { withAgent: false }) !== undefined) unresolved += 1
        return sub
      })
    }
    return entry
  })
  const done = Array.isArray(input.file.migrated)
    ? input.file.migrated.filter((one): one is string => typeof one === 'string')
    : []
  return {
    changed,
    unresolved,
    file: {
      ...input.file,
      log,
      migrated: done.includes(CALL_OUT_MIGRATION_SESSION_JOB_ID) ? done : [...done, CALL_OUT_MIGRATION_SESSION_JOB_ID],
    },
  }
}

/** 反查家名要用到的那一点点卡面(同 `jobKey.JobKeyTask` 的手法:只要用得上的那几格)。 */
export interface SessionFamilyTask {
  /** 卡上认下的那条对话(派进别家窗口那一次)。 */
  client_dispatch?: { family?: string, session_id?: string }
  /** 事务官自己那条会话。 */
  conversation?: { agent?: string, session_id?: string }
  /** 挂在这张卡上的那几条会话(每一条自己带家名)。 */
  links?: readonly { agent?: string, session_id?: string }[]
}

/**
 * ★ **这条会话是哪一家的 —— 只认落了盘的证据**(2026-10-03,卡「两条接缝」)。
 *
 * 三样都是看板上那几张卡自己记下来的:卡认下的那条对话、卡上挂着的那几条、事务官那条会话。
 * 一条会话被两张卡记成两家(不该发生)时**取先遇到的那一条**,不去判谁更可信 ——
 * 这一支只敢改「证据清楚」的那几行。
 */
export function sessionFamilyMap(tasks: readonly SessionFamilyTask[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  const add = (sessionId: unknown, family: unknown): void => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (typeof family !== 'string' || family.trim() === '') return
    if (out.has(sessionId)) return
    out.set(sessionId, family)
  }
  for (const task of tasks) {
    add(task.client_dispatch?.session_id, task.client_dispatch?.family)
    add(task.conversation?.session_id, task.conversation?.agent)
    for (const link of task.links ?? []) add(link.session_id, link.agent)
  }
  return out
}

export interface CallOutMigrateRunInput {
  /** `~/.dsh/workbench/call-out.json`。 */
  path: string
  familyOf: (sessionId: string) => string | undefined
  /** 备份文件名里那个日期(`YYYY-MM-DD`)。 */
  today: string
  /** 真写那一下(用例注入,免得碰真机文件)。 */
  write: (path: string, text: string) => Promise<void>
  /** 备份那一下(缺省 `copyFile`,同一天已经有一份就不覆盖)。 */
  backup?: (from: string, to: string) => Promise<void>
}

/** 跑完报一句人话(进日志;真机上一眼看出这一下到底做了什么)。 */
export interface CallOutMigrateRun extends Partial<CallOutMigrateReport> {
  ran: boolean
  note: string
}

/**
 * ★ **启动时跑一次**。三种「什么都不做」各说清是哪一种:文件不在 / 读坏了 / 已经迁过。
 * **绝不抛**(台账迁不动不该让工作台起不来)。
 */
export async function runCallOutSessionIdMigration(input: CallOutMigrateRunInput): Promise<CallOutMigrateRun> {
  let text: string
  try { text = await readFile(input.path, 'utf8') }
  catch { return { ran: false, note: '座机台账还没有这个文件,不用迁。' } }
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { return { ran: false, note: '座机台账这份读不出来(不是 JSON),原样没碰 —— 读台账那一处自己会当空的。' } }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ran: false, note: '座机台账这份形状不对(顶上不是一个对象),原样没碰。' }
  }
  const file = raw as CallOutMigrateFile
  if (callOutMigrated(file, CALL_OUT_MIGRATION_SESSION_JOB_ID)) {
    return { ran: false, note: '座机台账的会话事项 id 早就迁过了,跳过。' }
  }
  const out = migrateCallOutSessionIds({ file, familyOf: input.familyOf })
  // 先备份,再改。同一天已经有一份就不覆盖(一天里重启几次不该把最早那份原文顶掉)。
  const backupPath = `${input.path}.bak-${input.today}`
  try { await (input.backup ?? defaultBackup)(input.path, backupPath) }
  catch (err) {
    return { ran: false, note: `座机台账备份不成(${(err as Error)?.message ?? String(err)}),这一支没动那个文件。` }
  }
  try { await input.write(input.path, `${JSON.stringify(out.file, null, 2)}\n`) }
  catch (err) {
    return { ran: false, note: `座机台账写不回去(${(err as Error)?.message ?? String(err)});原文还在,备份在 ${backupPath}。` }
  }
  return {
    ran: true,
    changed: out.changed,
    unresolved: out.unresolved,
    note: `座机台账的会话事项 id 迁了 ${out.changed} 行${out.unresolved === 0 ? '' : `,另有 ${out.unresolved} 行认不出是哪一家、原样留着`};原文备份在 ${backupPath}。`,
  }
}

/** `COPYFILE_EXCL`:同一天已经有一份备份就什么都不做(不覆盖最早那份原文)。 */
async function defaultBackup(from: string, to: string): Promise<void> {
  try { await copyFile(from, to, 1 /* fs.constants.COPYFILE_EXCL */) }
  catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') throw err
  }
}
