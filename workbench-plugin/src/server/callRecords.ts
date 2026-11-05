/**
 * ★ **通话记录**(2026-10-22,决策记录同日「通电话是记录不是事项」)。
 *
 * 维护者:「『和事务官通了电话』这个不叫事项,这是个记录或者说动作……如果只是闲聊,有必要建立吗?」
 * 以前 `POST /butler/call/record` 给每通电话建一张「完成」的纪要卡,看板「已完成」里一排电话。
 * 从这一天起一通电话落成**一份记录**,归材料那一类(账的设计稿 4.7:会议三件旁边的「通话」):
 *
 * - **文件**:`<工作目录>/通话/<日期>-<时刻>-<call_id>.md`(同会议落在工作目录里的放法:访达里看得见、
 *   索引坏了文件还在)。没配工作目录就落在工作台自己的数据目录里 —— 那是我们自己的地方,不是猜一个仓库;
 * - **索引**:`~/.dsh/workbench/calls.json`,最多留 {@link CALL_RECORD_INDEX_MAX} 通(更早的 md 还在目录里);
 *   `/state.calls.recent` 给最近 {@link CALL_RECORD_RECENT_MAX} 通,手机「通话记录」与「最近一次通话」读它。
 *
 * 事项只从电话里说到的事来:通话里工人用工具当场建 / 挪(那几张挂在记录的 `items` 上),闲聊不建。
 * 「要办」的判法见 {@link maybeTodosOf} 与 http.ts 那条路由上面那一段。**这里一处都不经模型。**
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CallRecordItemLink, CallRecordLine, CallRecordView, CallsView } from '../protocol.ts'
import { STATUS_TITLES } from '../protocol.ts'
import { formatCallDuration } from './rtcCall.ts'
import { explicitRuleOf } from './rules.ts'
import { asksToRemember } from './understand.ts'

/** 通话记录落在工作目录下面这个子目录里(与 `会议/` 并排)。 */
export const CALL_RECORDS_DIR_NAME = '通话'
/** `/state.calls.recent` 里最多几通。 */
export const CALL_RECORD_RECENT_MAX = 20
/** `calls.json` 里最多留几通。 */
export const CALL_RECORD_INDEX_MAX = 500
/** 一通最多收多少句(同工人那一侧的上限:够长的一通也就几十句)。 */
export const CALL_RECORD_LINES_MAX = 400
/** 「可能要办」那一句最多留多少字。 */
export const MAYBE_TODO_MAX = 80

export function defaultCallRecordsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/calls.json`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** id 进文件名之前的那道闸:只留字母、数字、`-`、`_`(手机 / 工人报上来的字符串不许在盘上拼路径)。 */
function safeIdPart(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return cleaned === '' ? 'call' : cleaned
}

/** `2026-10-22-1435-<call_id>.md`(本地时间:她在访达里按名字排就是按时间排)。 */
export function callRecordFileName(atMs: number, id: string): string {
  const d = new Date(atMs)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${safeIdPart(id)}.md`
}

function localStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function linkLine(item: CallRecordItemLink): string {
  const title = item.title ?? '(标题没取到)'
  if (item.did === 'created') return `- 建了:${title}(${item.task_id})`
  if (item.did === 'moved') return `- 挪到「${item.to === undefined ? '?' : STATUS_TITLES[item.to]}」:${title}(${item.task_id})`
  return `- 补了一句:${title}(${item.task_id})`
}

/** 那一份 md。 */
export function renderCallRecordMd(record: Omit<CallRecordView, 'file'>): string {
  const duration = formatCallDuration(record.duration_seconds)
  const out: string[] = [
    `# ${record.kind === 'onboarding' ? '引导通话' : '通话'} · ${localStamp(record.at)}`,
    '',
    `- 时长:${duration ?? '没记下来'}`,
    `- 聊了什么:${record.summary}`,
    `- 编号:${record.id}`,
    '',
    '## 通话里建过 / 挪过的事项',
    '',
    ...(record.items.length === 0 ? ['这一通没有建、也没有挪事项。'] : record.items.map(linkLine)),
    '',
  ]
  const maybe = record.maybe_todo ?? []
  if (maybe.length > 0) {
    out.push(
      '## 可能要办',
      '',
      '她明说了要记,通话里却没有对得上的卡。**没替她建** —— 要办的话说一句,或者在看板上建一张。',
      '',
      ...maybe.map(one => `- 「${one}」`),
      '',
    )
  }
  out.push('## 转写', '')
  if (record.kind === 'onboarding') out.push('引导那一通不落全文:他答的每一项都在引导存档与记忆文件里。')
  else if (record.transcript.length === 0) out.push('这通电话没有留下转写(手机没收到字幕,或者刚接通就挂了)。')
  else out.push(...record.transcript.map(line => `- ${line.who === 'me' ? '我' : '事务官'}:${line.text}`))
  out.push('')
  return out.join('\n')
}

/** 去掉标点与空白,只剩字,好比「这一句里有没有那张卡的标题」。 */
function bareText(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 两段字有没有一段连着的 4 个字是一样的(短于 4 个字的整段算)。 */
function overlaps(said: string, title: string): boolean {
  const a = bareText(said)
  const b = bareText(title.replace(/…$/u, ''))
  if (b === '' || a === '') return false
  const chars = [...b]
  const span = Math.min(4, chars.length)
  for (let i = 0; i + span <= chars.length; i++) {
    if (a.includes(chars.slice(i, i + span).join(''))) return true
  }
  return false
}

/**
 * ★ **「可能要办」的判法**(2026-10-22,统筹定;**不经模型**)。
 *
 * 一句算「可能要办」要同时满足:
 *   ① 是**她**说的(事务官说「我记一下」不算);
 *   ② 明说了要记(`understand.ts` 的 `asksToRemember`:「记一下 / 记下来 / 帮我记 / 先记着」那一类;
 *      「记到日历」不算 —— 那一种落的是发布计划);
 *   ③ 不是一条以后都算数的规矩(`rules.ts` 的 `explicitRuleOf` 认得出的那种进规矩表,不是事项);
 *   ④ 通话里**没有对得上的卡**:这一通建过的卡里,没有哪张的标题与这一句有连着 4 个字相同。
 *
 * 认出来**只标不建**:拿不准的事替她建一张卡(看板上多一件没人交代过的事),比在记录上多标一句坏。
 */
export function maybeTodosOf(transcript: readonly CallRecordLine[], items: readonly CallRecordItemLink[]): string[] {
  const made = items.filter(item => item.did === 'created' && item.title !== undefined).map(item => item.title as string)
  const out: string[] = []
  for (const line of transcript) {
    if (line.who !== 'me') continue
    const said = line.text.trim()
    if (!asksToRemember(said)) continue
    if (explicitRuleOf(said) !== undefined) continue
    if (made.some(title => overlaps(said, title))) continue
    const cut = [...said].length > MAYBE_TODO_MAX ? `${[...said].slice(0, MAYBE_TODO_MAX).join('')}…` : said
    if (!out.includes(cut)) out.push(cut)
  }
  return out
}

/* ──────────────────────── 索引与文件 ──────────────────────── */

interface CallRecordsFile {
  version: 1
  /** 先落的在前。 */
  calls: CallRecordView[]
}

function emptyFile(): CallRecordsFile { return { version: 1, calls: [] } }

async function loadIndex(file: string): Promise<CallRecordsFile> {
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch { return emptyFile() }
  try {
    const parsed = JSON.parse(text) as Partial<CallRecordsFile> | null
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.calls)) return emptyFile()
    return { version: 1, calls: parsed.calls.filter(one => typeof one?.id === 'string' && typeof one.at === 'string') }
  }
  // 写坏了按空表兜底,不抛(同 meetings.json):**目录里的 md 一份都没少**,丢的只是这份索引。
  catch { return emptyFile() }
}

async function saveIndex(file: string, data: CallRecordsFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await rename(tmp, file)
}

export interface CallRecordsDeps {
  /** `~/.dsh/workbench/calls.json`。 */
  file: string
  /** 工作目录(= `butler_cwd`)。没配就回 undefined,记录改落 {@link fallbackDir}。 */
  workdir: () => string | undefined
  /** 没配工作目录时落在哪(`~/.dsh/workbench/通话`)。 */
  fallbackDir: string
  now?: () => number
  /** 上报方没带 call_id 时编一个(用例里注入)。 */
  newId?: () => string
}

/** 落一通要给的那几格(`file` 由这里定)。 */
export type CallRecordInput = Omit<CallRecordView, 'file'>

export type CallRecordPutResult =
  | { ok: true, record: CallRecordView, created: boolean, file_error?: string }
  | { ok: false, error: string }

export interface CallRecordsService {
  /** 落一通;同一个 id 再来一次 = 就地更新那一份(文件名不换)。**先写 md 再记索引**。 */
  put: (input: CallRecordInput) => Promise<CallRecordPutResult>
  get: (id: string) => Promise<CallRecordView | undefined>
  /** `/state.calls`。 */
  view: () => Promise<CallsView>
  /** 给没带 call_id 的那一通编个号。 */
  newId: () => string
}

export function createCallRecordsService(deps: CallRecordsDeps): CallRecordsService {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => `call-${randomUUID().slice(0, 8)}`)
  // 同一个进程里排着写:两边前后脚报同一通时,不许两次读到同一份旧索引、后写的盖掉先写的。
  let chain: Promise<unknown> = Promise.resolve()

  function dirNow(): string {
    const workdir = deps.workdir()
    return workdir === undefined || workdir === '' ? deps.fallbackDir : join(workdir, CALL_RECORDS_DIR_NAME)
  }

  async function put(input: CallRecordInput): Promise<CallRecordPutResult> {
    const data = await loadIndex(deps.file)
    const at = data.calls.findIndex(one => one.id === input.id)
    const existing = at === -1 ? undefined : data.calls[at]
    const transcript = input.transcript.slice(0, CALL_RECORD_LINES_MAX)
    const base: CallRecordInput = { ...input, transcript }
    // 文件名按**第一次落下**的那一刻定:同一通后到的那份写回同一个文件。
    const file = existing?.file ?? join(dirNow(), callRecordFileName(Date.parse(existing?.at ?? input.at) || now(), input.id))
    let fileError: string | undefined
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, renderCallRecordMd(base), 'utf8')
    }
    catch (err) {
      fileError = `通话记录那份文件没写下来(${(err as Error)?.message ?? '没说原因'}),索引里还有这一通`
    }
    const record: CallRecordView = { ...base, ...(existing === undefined ? {} : { at: existing.at }), ...(fileError === undefined ? { file } : {}) }
    if (existing === undefined) data.calls.push(record)
    else data.calls[at] = record
    while (data.calls.length > CALL_RECORD_INDEX_MAX) data.calls.shift()
    try { await saveIndex(deps.file, data) }
    catch (err) { return { ok: false, error: `通话记录的索引没写下来:${(err as Error)?.message ?? '没说原因'}` } }
    return { ok: true, record, created: existing === undefined, ...(fileError === undefined ? {} : { file_error: fileError }) }
  }

  return {
    put(input) {
      const run = chain.then(() => put(input))
      chain = run.catch(() => undefined)
      return run
    },
    async get(id) {
      return (await loadIndex(deps.file)).calls.find(one => one.id === id)
    },
    async view() {
      const calls = (await loadIndex(deps.file)).calls
      const recent = [...calls].sort((a, b) => b.at.localeCompare(a.at)).slice(0, CALL_RECORD_RECENT_MAX)
      return { recent, dir: dirNow() }
    },
    newId,
  }
}
