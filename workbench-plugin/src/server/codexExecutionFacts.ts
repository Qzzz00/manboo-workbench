import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NoteReceipt, SessionView, TaskLink, TaskView, TaskExecutionSource } from '../protocol.ts'
import { parseReceipt } from './noteReceipt.ts'
import { RUN_ACTIVE_STALE_MS } from '../protocol.ts'
import type { SessionFileRef } from './sessionHistory.ts'

// Internal adapter output, not a second HTTP protocol or persistent ledger.
export interface CodexExecutionEvent {
  id: string
  round: string
  kind: 'started' | 'updated' | 'ended' | 'interrupted'
  receipt?: NoteReceipt
  at: string
}
export interface CodexExecutionSource {
  task_id: string
  agent: string
  provider?: string
  transport?: string
  provider_basis?: TaskExecutionSource['provider_basis']
  task_round?: number
  session_id: string
  state: 'running' | 'returned' | 'ended' | 'interrupted' | 'unknown'
  receipt?: NoteReceipt
  unknown?: TaskExecutionSource['unknown']
  events: readonly CodexExecutionEvent[]
}
export interface CodexExecutionDeps {
  now: () => Date
  /** Must reuse the existing read_client_files + task project/cwd gate. No path supplied by UI. */
  authorize: (task: TaskView, link: TaskLink) => Promise<SessionFileRef | undefined>
  read?: (ref: SessionFileRef) => Promise<string>
  staleMs?: number
  /**
   * 解析状态落盘目录(8791 第四轮):内存缓存按 deps 实例存,重启即丢。给了目录后,冷解析结果
   * 原子写进 <dir>/<sha256(key)>.json,重启后 stamp/头锚续得上就直接接着增量读,不从头喂几 MB 的 wire。
   * 只存派生数据,丢了重建;任何读写失败都不影响对账。read 替身(测试)路径完全不走这里。
   */
  cacheDir?: string
  /**
   * 每拍整文件冷解析上限(缺省不限制)。续跑解析(读追加尾巴)不占额度。给了值就按拍限量:
   * 超额的来源有旧观察先吃旧的(下一拍增量追上),没有旧观察记 'unavailable'。
   * 缺省不限制是刻意的:同卡回归用例(生产形状一拍 23 个冷来源全解析、首拍即稳态)与「缺省 4」
   * 不能同时成立,而接线一节只要求接 cacheDir —— 生产要开限额,在 http.ts 显式传这个常量即可(见本卡交接)。
   */
  coldParsePerBeat?: number
}
const MAX_BYTES = 8 * 1024 * 1024
/** 每拍整文件冷解析上限的导出常量(接线处显式传入才生效,缺省不限制,见 {@link CodexExecutionDeps.coldParsePerBeat})。 */
export const COLD_PARSE_PER_BEAT = 4
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
type ParsedSource = {
  transport: SessionFileRef['format']
  provider?: string
  provider_basis?: TaskExecutionSource['provider_basis']
  events: readonly CodexExecutionEvent[]
}
type CacheEntry = { stamp: string, devIno: string, value: ParsedSource, run: ParseRun, anchor: Anchor, settled: boolean }
type CacheCandidate = CacheEntry & { key: string }
/** 缓存键:与解析路径一一对应,主循环(settled 跳过)与 readParsed 共用这一份算法。 */
const cacheKeyOf = (ref: SessionFileRef): string => JSON.stringify([ref.agent, ref.session_id, ref.format, ref.file])
/**
 * 续跑头锚:冷解析时认过的前 anchorChars 个字符的哈希(小文件 = 整份,大文件封顶 ANCHOR_CHARS)。
 * dev/ino 不变、文件变长只说明"像追加"——同 inode 原地重写(重建文件,对账注释里的预期场景)
 * 也满足这两条;不重查前缀就会把重写出的新尾巴错当成新事件、带着新 id 重复追加进任务账。
 * 锚长度冷解析时定死:追加不改前缀,续跑比对才成立;每拍一次小读换掉这个错。
 */
const ANCHOR_CHARS = 4096
type Anchor = { chars: number, hash: string }
const anchorOf = (text: string, chars: number): Anchor => ({ chars, hash: hash(text.slice(0, chars)) })
/**
 * 可续跑的行级解析状态。活动会话每拍追加,stamp 一变就整文件重读重解析是最大的读放大;
 * dev/ino 不变且文件变长时只读追加的尾巴,从这份状态接着走,事件 id(内容哈希 + Kimi 行号)保持不变。
 */
type ParseRun = {
  /** 已吃进状态机的字节数(只推进到已终结行,未换行的末行留待补全)。 */
  consumed: number
  /** 已吃进状态机的行数 —— Kimi 事件 id 用行号,续跑点必须接着数。 */
  lines: number
  events: CodexExecutionEvent[]
  seen: Set<string>
  round: string | undefined
  active: boolean
  reply: string
  known: string | undefined
  model: string | undefined
  provider: unknown
  metaRowSeen: boolean
  metaValid: boolean
}
const parsedByReader = new WeakMap<CodexExecutionDeps, Map<string, CacheEntry>>()
const CACHE_LIMIT = 32
const stampOf = async (file: string): Promise<string> => {
  const info = await stat(file, { bigint: true })
  if (info.size > MAX_BYTES) throw new Error('source exceeds bounded replay')
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
}
const devInoOf = (stamp: string): string => stamp.split(':').slice(0, 2).join(':')
const sizeOf = (stamp: string): bigint => BigInt(stamp.split(':')[2] ?? '0')

// ———————————————————————————— 解析状态落盘(8791 第四轮:重启续跑) ————————————————————————————

/** 落盘文件的格式版本:结构对不上就当不存在(容错读),别拿旧格式赌。 */
const CACHE_FILE_VERSION = 1
const cacheFileOf = (cacheDir: string, key: string): string => join(cacheDir, `${hash(key)}.json`)

/** 内存条目 → JSON 纯数据(ParseRun.seen 落成数组,回来再成 Set)。 */
function serializeCacheEntry(entry: CacheEntry): Record<string, unknown> {
  return {
    version: CACHE_FILE_VERSION,
    stamp: entry.stamp,
    devIno: entry.devIno,
    settled: entry.settled,
    value: entry.value,
    run: { ...entry.run, seen: [...entry.run.seen] },
    anchor: entry.anchor,
  }
}

const EVENT_KINDS = new Set(['started', 'updated', 'ended', 'interrupted'])
function parseEvent(value: unknown): CodexExecutionEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const one = value as Record<string, unknown>
  if (typeof one.id !== 'string' || typeof one.round !== 'string' || typeof one.at !== 'string') return undefined
  if (one.kind !== 'started' && one.kind !== 'updated' && one.kind !== 'ended' && one.kind !== 'interrupted') return undefined
  return { id: one.id, round: one.round, kind: one.kind, at: one.at,
    ...(typeof one.receipt === 'object' && one.receipt !== null ? { receipt: one.receipt as NoteReceipt } : {}) }
}

/** 容错反序列化:任何一格对不上都回 undefined(当不存在,走冷解析),不许把半份状态喂进状态机。 */
function deserializeCacheEntry(raw: unknown): CacheEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const one = raw as Record<string, unknown>
  if (one.version !== CACHE_FILE_VERSION) return undefined
  if (typeof one.stamp !== 'string' || typeof one.devIno !== 'string' || typeof one.settled !== 'boolean') return undefined
  if (typeof one.value !== 'object' || one.value === null) return undefined
  const value = one.value as Record<string, unknown>
  if (typeof value.transport !== 'string' || !Array.isArray(value.events)) return undefined
  const events = value.events.map(parseEvent)
  if (events.some(one => one === undefined)) return undefined
  if (typeof one.run !== 'object' || one.run === null || typeof one.anchor !== 'object' || one.anchor === null) return undefined
  const run = one.run as Record<string, unknown>
  const anchor = one.anchor as Record<string, unknown>
  if (typeof run.consumed !== 'number' || typeof run.lines !== 'number' || !Array.isArray(run.events) || !Array.isArray(run.seen)) return undefined
  const runEvents = run.events.map(parseEvent)
  if (runEvents.some(one => one === undefined) || run.seen.some(one => typeof one !== 'string')) return undefined
  if (typeof anchor.chars !== 'number' || typeof anchor.hash !== 'string') return undefined
  return {
    stamp: one.stamp, devIno: one.devIno, settled: one.settled,
    value: { transport: value.transport as ParsedSource['transport'],
      ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
      ...(typeof value.provider_basis === 'string' ? { provider_basis: value.provider_basis as ParsedSource['provider_basis'] } : {}),
      events: events as CodexExecutionEvent[] },
    run: { consumed: run.consumed, lines: run.lines, events: runEvents as CodexExecutionEvent[],
      seen: new Set(run.seen as string[]),
      round: typeof run.round === 'string' ? run.round : undefined,
      active: run.active === true, reply: typeof run.reply === 'string' ? run.reply : '',
      known: typeof run.known === 'string' ? run.known : undefined,
      model: typeof run.model === 'string' ? run.model : undefined,
      provider: run.provider, metaRowSeen: run.metaRowSeen === true, metaValid: run.metaValid === true },
    anchor: { chars: anchor.chars, hash: anchor.hash },
  }
}

/** 重启续跑:读落盘条目。文件缺失/损坏/结构不符一律当不存在,任何异常都不许冒泡进对账。 */
async function loadPersistedEntry(cacheDir: string, key: string): Promise<CacheEntry | undefined> {
  try {
    return deserializeCacheEntry(JSON.parse(await readFile(cacheFileOf(cacheDir, key), 'utf8')))
  } catch { return undefined }
}

/** 准入时落盘:原子写(tmp + rename),best-effort —— 写不成只是下次重启多喂一遍,不影响这一拍。 */
async function persistCacheEntry(cacheDir: string, key: string, entry: CacheEntry): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true })
    const file = cacheFileOf(cacheDir, key)
    const tmp = `${file}.${hash(`${key}:${entry.stamp}`).slice(0, 16)}.tmp`
    await writeFile(tmp, JSON.stringify(serializeCacheEntry(entry)), 'utf8')
    await rename(tmp, file)
  } catch { /* 落盘失败不连累对账 */ }
}

/** Bounded exact-file read, raw bytes. Oversized files stay unknown; no head/tail gap masquerades as a full replay. */
async function readExact(ref: SessionFileRef): Promise<Buffer> {
  const handle = await open(ref.file, 'r')
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const got = await handle.read(buffer, size, buffer.length - size, null)
      if (got.bytesRead === 0) break
      size += got.bytesRead
    }
    if (size > MAX_BYTES) throw new Error('source exceeds bounded replay')
    return buffer.subarray(0, size)
  } finally { await handle.close() }
}

function freshRun(): ParseRun {
  return { consumed: 0, lines: 0, events: [], seen: new Set(), round: undefined, active: false,
    reply: '', known: undefined, model: undefined, provider: undefined, metaRowSeen: false, metaValid: false }
}

function feedCodexLine(run: ParseRun, line: string, sessionId: string): void {
  if (line.trim() === '') return
  let row: { type?: string, timestamp?: string, payload?: Record<string, unknown> }
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    row = parsed as { type?: string, timestamp?: string, payload?: Record<string, unknown> }
  } catch { /* an incomplete last write is not an event */ return }
  if (!run.metaRowSeen) {
    run.metaRowSeen = true
    run.metaValid = row.type === 'session_meta' && row.payload?.id === sessionId
  }
  // provider/model 追踪与事件解析同一遍:task_started 重置 model,turn_context 记当前轮模型。
  if (row.type === 'event_msg' && row.payload?.type === 'task_started') run.model = undefined
  if (row.type === 'turn_context' && typeof row.payload?.model === 'string') run.model = row.payload.model
  if (!run.metaValid) return
  const p = row.payload
  if (p === undefined || p === null || typeof p !== 'object') return
  const at = row.timestamp
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return
  let kind: CodexExecutionEvent['kind'] | undefined
  if (row.type === 'event_msg') {
    if (p.type === 'task_started') kind = 'started'
    else if (p.type === 'task_complete') kind = 'ended'
    else if (p.type === 'turn_aborted') kind = 'interrupted'
    else if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.trim() !== '') kind = 'updated'
  } else if (row.type === 'response_item' && (p.type === 'function_call' || p.type === 'function_call_output' || p.type === 'custom_tool_call' || p.type === 'custom_tool_call_output')) {
    kind = 'updated'
  } else if (row.type === 'response_item' && p.type === 'message' && p.role === 'assistant'
    && (typeof p.content === 'string' ? p.content.trim() !== '' : Array.isArray(p.content) && p.content.some(part =>
      part !== null && typeof part === 'object' && part.type === 'output_text' && typeof part.text === 'string' && part.text.trim() !== ''))) {
    kind = 'updated'
  }
  if (kind === undefined) return
  // Hash structured source data, never clock/mtime/PID or private text in the output.
  const id = hash(JSON.stringify([sessionId, at, row.type, p]))
  if (run.seen.has(id)) return
  if (kind === 'started') {
    run.round = typeof p.turn_id === 'string' && p.turn_id !== '' ? p.turn_id : id
    run.active = true
  }
  // Output without a witnessed start cannot establish execution or invent a round.
  if (run.round === undefined || (kind === 'updated' && !run.active)) return
  if (typeof p.turn_id === 'string' && p.turn_id !== run.round) return
  run.seen.add(id)
  const receipt = kind === 'ended' && typeof p.last_agent_message === 'string' ? parseReceipt(p.last_agent_message) : undefined
  run.events.push({ id, round: run.round, kind, at, ...(receipt === undefined ? {} : { receipt: { ...receipt, by: 'codex', at } }) })
  if (kind === 'ended' || kind === 'interrupted') run.active = false
}

function feedKimiLine(run: ParseRun, line: string, index: number, sessionId: string): void {
  try {
    const row = JSON.parse(line) as Record<string, unknown>
    const stamp = row.time ?? row.timestamp ?? row.created_at
    const ms = typeof stamp === 'number' ? stamp * (stamp < 1e12 ? 1000 : 1) : typeof stamp === 'string' ? Date.parse(stamp) : NaN
    if (Number.isFinite(ms)) run.known = new Date(ms).toISOString()
    const wrapped = row.message as { type?: string, payload?: Record<string, unknown> } | undefined
    const event = row.type === 'context.append_loop_event' ? row.event as Record<string, unknown> | undefined : wrapped?.type === undefined ? undefined : { ...wrapped.payload, type: wrapped.type }
    if (event === undefined || run.known === undefined) return
    const type = event.type
    let kind: CodexExecutionEvent['kind'] | undefined
    if (type === 'TurnBegin' || type === 'step.begin' || type === 'StepBegin') kind = run.active ? 'updated' : 'started'
    else if (type === 'TurnEnd' || type === 'step.end' && event.finishReason === 'end_turn') kind = 'ended'
    else if (type === 'StepInterrupted' || type === 'TurnAbort' || type === 'TurnError' || type === 'StepError'
      || type === 'step.end' && /error|fail|abort|interrupt|cancel/i.test(String(event.finishReason))) kind = 'interrupted'
    else if (type === 'tool.call' || type === 'tool.result' || type === 'ToolCall' || type === 'StepRetry') kind = 'updated'
    else if (type === 'content.part') {
      const part = event.part as { type?: string, text?: string } | undefined
      if (run.active && part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') { run.reply += part.text; kind = 'updated' }
    }
    if (kind === undefined) return
    const id = hash(JSON.stringify([sessionId, index, row]))
    if (kind === 'started') { run.round = typeof event.turn_id === 'string' ? event.turn_id : id; run.active = true; run.reply = '' }
    if (run.round === undefined || !run.active && kind === 'updated') return
    const receipt = kind === 'ended' ? parseReceipt(run.reply) : undefined
    run.events.push({ id, round: run.round, kind, at: run.known, ...(receipt === undefined ? {} : { receipt: { ...receipt, by: 'kimi', at: run.known } }) })
    if (kind === 'ended' || kind === 'interrupted') run.active = false
  } catch { /* partial or unknown records cannot create lifecycle */ }
}

function feedLine(run: ParseRun, line: string, index: number, sessionId: string, format: SessionFileRef['format']): void {
  if (format === 'kimi-wire') feedKimiLine(run, line, index, sessionId)
  else feedCodexLine(run, line, sessionId)
}

/** Replay only lifecycle and actual output. Token counts, turn_context and file metadata cannot refresh activity. */
export function codexExecutionEvents(raw: string, sessionId: string): CodexExecutionEvent[] {
  const run = freshRun()
  drainRun(run, raw, sessionId, 'codex-rollout', true)
  return run.events
}

/** Native wire lifecycle only. Prompt, usage and file metadata never establish execution. */
export function kimiExecutionEvents(raw: string, sessionId: string): CodexExecutionEvent[] {
  const run = freshRun()
  drainRun(run, raw, sessionId, 'kimi-wire', true)
  return run.events
}

/**
 * 把一段文本喂进状态机:已换行的行提交进 run,未换行的末行原样返回(调用方决定是
 * 整解析冲刷还是挂起等补全)。行号从 run.lines 接着数,Kimi 事件 id 因此与全量解析一致。
 */
function drainRun(run: ParseRun, text: string, sessionId: string, format: SessionFileRef['format'], flush: boolean): string {
  let start = 0, index = run.lines
  for (;;) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) break
    feedLine(run, text.slice(start, nl), index, sessionId, format)
    index += 1
    start = nl + 1
  }
  run.lines = index
  const rest = text.slice(start)
  if (flush && rest !== '') { feedLine(run, rest, index, sessionId, format); return '' }
  return rest
}

/** 未换行的末行当拍就要可见(写完不再动的文件不会有下一拍),但不提交 —— 字节未读满,补全后要从头重走。
 *  返回里带上 model:挂起行可能是 turn_context,它改的模型这一拍就要体现在 provider 判定上。 */
function probePendingLine(run: ParseRun, line: string, sessionId: string, format: SessionFileRef['format']): { events: CodexExecutionEvent[], model: string | undefined } {
  const probe = { ...run, seen: new Set(run.seen), events: [] as CodexExecutionEvent[] }
  feedLine(probe, line, run.lines, sessionId, format)
  return { events: probe.events, model: probe.model }
}

function valueOf(run: ParseRun, ref: SessionFileRef): ParsedSource {
  const provider = ref.format === 'kimi-wire' ? 'kimi' : run.provider
  const model = run.model
  const providerName = /^kimi(?:[-_.]|$)/i.test(model ?? '') ? 'kimi' : /^claude(?:[-_.]|$)/i.test(model ?? '') ? 'claude'
    : /^(?:gpt[-_.]|o[1-9](?:[-_.]|$))/i.test(model ?? '') ? 'codex' : provider === 'openai' || provider === 'azure' ? 'codex'
      : provider === 'kimi' || provider === 'moonshot' ? 'kimi' : undefined
  const events = run.events
    .map(event => event.receipt === undefined ? event : { ...event, receipt: { ...event.receipt, by: providerName ?? 'unknown' } })
  return { transport: ref.format, ...(providerName === undefined ? {} : { provider: providerName,
    provider_basis: ref.format === 'kimi-wire' ? 'native_reader' as const : model !== undefined ? 'turn_context' as const : 'session_metadata' as const }), events }
}

function parseSource(raw: string, ref: SessionFileRef, sessionId: string): ParsedSource {
  const run = freshRun()
  // 首行单独 JSON.parse 是从双遍时代留下的契约:首行读不出来 = 整份不可用(不是"没有事件")。
  const head = JSON.parse(raw.split('\n')[0] ?? '{}') as { type?: string, payload?: { model_provider?: unknown } } | null
  if (head !== null && typeof head === 'object' && head.type === 'session_meta') run.provider = head.payload?.model_provider
  drainRun(run, raw, sessionId, ref.format, true)
  return valueOf(run, ref)
}

/** 只读追加尾巴,原始字节:起点是上一拍认过的行边界(必为字符边界),分块读够再让调用方按字节切行尾。 */
async function readTail(file: string, from: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const chunks: Buffer[] = []
    let total = 0
    const buffer = Buffer.alloc(256 * 1024)
    for (;;) {
      const got = await handle.read(buffer, 0, buffer.length, from + total)
      if (got.bytesRead === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, got.bytesRead)))
      total += got.bytesRead
      if (total > MAX_BYTES) throw new Error('source exceeds bounded replay')
    }
    return Buffer.concat(chunks)
  } finally { await handle.close() }
}

/** 续跑前的头锚核对:读够 chars 个字符可能需要的字节(UTF-8 每字符至多 4 字节),多带 8 字节让跨界字符解得一样。 */
async function readAnchor(file: string, chars: number): Promise<Anchor> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(chars * 4 + 8)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    return anchorOf(text, Math.min(chars, text.length))
  } finally { await handle.close() }
}

async function readParsed(ref: SessionFileRef, sessionId: string, deps: CodexExecutionDeps,
  cache: Map<string, CacheEntry>, pending: CacheCandidate[], budget: { coldLeft: number }): Promise<ParsedSource> {
  if (deps.read !== undefined) return parseSource(await deps.read(ref), ref, sessionId)
  const stamp = await stampOf(ref.file)
  const key = cacheKeyOf(ref)
  let loaded = cache.get(key)
  if (loaded === undefined && deps.cacheDir !== undefined) {
    // 重启续跑:内存里没有,落盘的解析状态当上一拍。stamp 不符 / 锚对不上由下面的 canResume 把关,
    // 续不上就走冷解析、冷解析完覆盖写盘;容错读,任何异常都不许冒泡影响对账。
    loaded = await loadPersistedEntry(deps.cacheDir, key)
    if (loaded !== undefined) cache.set(key, loaded)
  }
  const previous = loaded
  if (previous?.stamp === stamp) return previous.value
  const devIno = devInoOf(stamp), size = sizeOf(stamp)
  // 续跑只信"同一文件变长了且头锚没动":截断重建、同长改写、换文件、原地重写且变长都回到整文件解析。
  const canResume = previous?.run !== undefined && previous.devIno === devIno && size > BigInt(previous.run.consumed)
    && (await readAnchor(ref.file, previous.anchor.chars)).hash === previous.anchor.hash
  let observed: ParsedSource
  let next: CacheEntry
  if (canResume) {
    const run: ParseRun = { ...previous.run, seen: new Set(previous.run.seen), events: [...previous.run.events] }
    const tail = await readTail(ref.file, run.consumed)
    // 已读字节只认原始缓冲里的行尾:解码会把非法 UTF-8 换成 U+FFFD(3 字节),按解码后字符串
    // 回算字节数会把续跑点推过头,下一拍从一行中间开读、整行报废。
    const lastNl = tail.lastIndexOf(0x0a)
    const completeBytes = lastNl >= 0 ? lastNl + 1 : 0
    drainRun(run, tail.subarray(0, completeBytes).toString('utf8'), sessionId, ref.format, false)
    const pendingText = tail.subarray(completeBytes).toString('utf8')
    const probe = pendingText === '' ? { events: [], model: run.model } : probePendingLine(run, pendingText, sessionId, ref.format)
    const observedEvents = probe.events.length === 0 ? run.events : [...run.events, ...probe.events]
    observed = valueOf({ ...run, model: probe.model, events: observedEvents }, ref)
    run.consumed += completeBytes
    const lastKind = observed.events.at(-1)?.kind
    next = { stamp, devIno, value: observed, run, anchor: previous!.anchor,
      settled: lastKind === 'ended' || lastKind === 'interrupted' }
  } else {
    // 整文件冷解析每拍限量:额度先给在跑的来源(主循环按这个顺序排)。超额的来源有旧观察先吃旧的
    // (本拍不推进,下一拍增量追上),没有旧观察只能记不可用 —— 走现有 catch,source_unknown 只在 why 变化时追加。
    if (budget.coldLeft <= 0) {
      if (previous !== undefined) return previous.value
      throw Object.assign(new Error('cold parse budget exhausted'), { code: 'budget' })
    }
    budget.coldLeft -= 1
    const run = freshRun()
    const raw = await readExact(ref)
    const rawText = raw.toString('utf8')
    // 冷解析也要保持首行契约(读不出来 = 不可用),provider 从首行拿走。
    const head = JSON.parse(rawText.split('\n')[0] ?? '{}') as { type?: string, payload?: { model_provider?: unknown } } | null
    if (head !== null && typeof head === 'object' && head.type === 'session_meta') run.provider = head.payload?.model_provider
    const rest = drainRun(run, rawText, sessionId, ref.format, false)
    const probe = rest === '' ? { events: [], model: run.model } : probePendingLine(run, rest, sessionId, ref.format)
    const observedEvents = rest === '' ? run.events : [...run.events, ...probe.events]
    // 未换行的末行不当已读字节(行尾以原始缓冲为准,理由同续跑路):写完不再动的文件当拍可见,下一拍补全时从行首重走。
    const lastNl = raw.lastIndexOf(0x0a)
    run.consumed = lastNl >= 0 ? lastNl + 1 : 0
    observed = valueOf({ ...run, model: probe.model, events: observedEvents }, ref)
    // 上次观察到的来源状态是 ended/returned/interrupted(最后事件收口)记 settled:已闭环卡的来源
    // stamp 不变时主循环直接用这个观察,不再每拍 readParsed。
    const lastKind = observed.events.at(-1)?.kind
    next = { stamp, devIno, value: observed, run, anchor: anchorOf(rawText, Math.min(ANCHOR_CHARS, rawText.length)),
      settled: lastKind === 'ended' || lastKind === 'interrupted' }
  }
  // A writer may append while we read. Keep this observation but never cache a partial version.
  if (await stampOf(ref.file) === stamp) {
    pending.push({ key, ...next })
    if (pending.length > CACHE_LIMIT) pending.shift()
  }
  return observed
}

/** Called by the existing request-driven state reconciler after authorization; never scans directories or writes source state. */
export async function readLinkedCodexExecutions(tasks: readonly TaskView[], deps: CodexExecutionDeps,
  authorizeForSnapshot: CodexExecutionDeps['authorize'] = deps.authorize): Promise<{
  sources: CodexExecutionSource[], sessions: SessionView[]
}> {
  const links = new Map<string, Map<string, { task: TaskView, link: TaskLink }>>()
  for (const task of tasks) for (const link of task.links ?? []) {
    const key = link.session_id
    const owners = links.get(key) ?? new Map()
    owners.set(task.id, { task, link }); links.set(key, owners)
  }
  const sources: CodexExecutionSource[] = [], sessions: SessionView[] = []
  const now = deps.now().getTime()
  let cache = parsedByReader.get(deps)
  if (cache === undefined) { cache = new Map(); parsedByReader.set(deps, cache) }
  // 先逐来源过授权与格式校验(对账契约:每拍每来源照样过授权),再统一排序喂解析 ——
  // 冷解析额度按排序给,排不上队的来源不吃额度。
  const ready: { task: TaskView, link: TaskLink, ref: SessionFileRef, source: CodexExecutionSource }[] = []
  for (const owners of links.values()) {
    const first = [...owners.values()][0]!
    const sessionId = first.link.session_id, agent = first.link.agent
    if (owners.size !== 1) {
      for (const { task, link } of owners.values()) sources.push({ task_id: task.id, agent: link.agent, session_id: sessionId, state: 'unknown', unknown: 'ambiguous_link', events: [] })
      continue
    }
    const { task, link } = [...owners.values()][0]!
    const source: CodexExecutionSource = { task_id: task.id, agent, session_id: sessionId, state: 'unknown', unknown: 'unavailable', events: [] }
    sources.push(source)
    if (agent !== 'codex' && agent !== 'kimi') { source.unknown = 'unsupported'; continue }
    try {
      const ref = await authorizeForSnapshot(task, link)
      if (ref?.agent !== agent || ref.session_id !== sessionId) continue
      if (ref.format !== 'codex-rollout' && ref.format !== 'kimi-wire') { source.unknown = 'unsupported'; continue }
      ready.push({ task, link, ref, source })
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''
      const message = error instanceof Error ? error.message : ''
      source.unknown = code === 'denied' ? 'denied' : code === 'missing' || code === 'ENOENT' ? 'missing'
        : message.includes('bounded replay') ? 'oversized' : 'unavailable'
    }
  }
  // 冷解析额度先给在跑的:未闭环(非 done/canceled/confirm)且上次观察到 running(settled=false)的在前,
  // 已闭环的排最后 —— 它们 stamp 不变时根本不进 readParsed(settled 跳过)。
  const isClosed = (task: TaskView): boolean => task.status === 'done' || task.status === 'canceled' || task.status === 'confirm'
  const rankOf = (one: { task: TaskView, ref: SessionFileRef }): number => {
    if (isClosed(one.task)) return 2
    return cache.get(cacheKeyOf(one.ref))?.settled === false ? 0 : 1
  }
  ready.sort((a, b) => rankOf(a) - rankOf(b))
  const budget = { coldLeft: deps.coldParsePerBeat ?? Number.POSITIVE_INFINITY }
  const pending: CacheCandidate[] = []
  for (const { task, link, ref, source } of ready) {
    const sessionId = link.session_id, agent = link.agent
    try {
      // 已结束的来源 stamp 不变:直接用缓存观察,不推进状态、不写缓存文件。重启后内存空了,
      // 从落盘账本恢复同一条 settled 观察(容错读,对不上就走下面的 readParsed)。
      const key = cacheKeyOf(ref)
      let parsed: ParsedSource | undefined
      if (isClosed(task)) {
        let entry = cache.get(key)
        if (entry === undefined && deps.cacheDir !== undefined) {
          entry = await loadPersistedEntry(deps.cacheDir, key)
          if (entry !== undefined) cache.set(key, entry)
        }
        if (entry?.settled === true) {
          try { if (await stampOf(ref.file) === entry.stamp) parsed = entry.value } catch { /* stat 失败照常走 readParsed */ }
        }
      }
      if (parsed === undefined) parsed = await readParsed(ref, sessionId, deps, cache, pending, budget)
      source.transport = parsed.transport
      if (parsed.provider !== undefined) source.provider = parsed.provider
      if (parsed.provider_basis !== undefined) source.provider_basis = parsed.provider_basis
      source.events = parsed.events
      const last = source.events.at(-1)
      if (last === undefined) { source.unknown = 'unobservable'; continue }
      const age = now - Date.parse(last.at)
      if (age < 0 || (last.kind !== 'ended' && last.kind !== 'interrupted' && age > (deps.staleMs ?? RUN_ACTIVE_STALE_MS))) {
        source.unknown = 'stale'
      } else {
        source.state = last.kind === 'ended' ? (last.receipt === undefined ? 'ended' : 'returned') : last.kind === 'interrupted' ? 'interrupted' : 'running'
        delete source.unknown
        if (last.receipt !== undefined) source.receipt = last.receipt
      }
      if (agent === 'codex' || agent === 'kimi' || agent === 'claude') sessions.push({ agent, session_id: sessionId, title: link.note?.trim() || task.title, project: '', status: source.state === 'running' ? 'running' : (source.state === 'returned' || source.state === 'ended') ? 'done' : source.state === 'interrupted' ? 'error' : 'offline',
        ...(source.state === 'interrupted' ? { reason: 'interrupted' as const } : {}),
        updated_at: last.at, elapsed_sec: Math.max(0, Math.floor(age / 1000)), unread: false })
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''
      const message = error instanceof Error ? error.message : ''
      source.unknown = code === 'denied' ? 'denied' : code === 'missing' || code === 'ENOENT' ? 'missing'
        : message.includes('bounded replay') ? 'oversized' : 'unavailable'
    }
  }
  // Admit misses only after the whole authorized sweep. Evicting during a fixed-order sweep
  // makes N > limit stable sources miss on every request; batch admission rotates the budget fairly.
  for (const candidate of pending) {
    cache.delete(candidate.key)
    cache.set(candidate.key, { stamp: candidate.stamp, devIno: candidate.devIno, value: candidate.value, run: candidate.run, anchor: candidate.anchor, settled: candidate.settled })
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    if (deps.cacheDir !== undefined) await persistCacheEntry(deps.cacheDir, candidate.key, candidate)
  }
  return { sources, sessions }
}
