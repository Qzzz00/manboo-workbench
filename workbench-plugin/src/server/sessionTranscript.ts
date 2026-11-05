/**
 * 一条对话的完整内容,从最新往前按轮分页(2026-10-01,手机读对话卡 B)。
 *
 * 维护者:「只有最近一轮我说的和一轮 AI 说的,往上就没了」—— 原来点开走的是 `/sessions/digest`(最多 6 轮、
 * 她那句截 80 字、AI 那句截 120 字、只读头尾两段)。这里读的是**整份记录**,但不一次读完:
 *
 * - **倒着读**:从文件末尾(或游标那一行)往前一行一行读,凑够 {@link SESSION_TRANSCRIPT_ROUNDS} 轮(一轮从她说的一句起)就停;
 *   游标 = 这一页最早那一轮开头那一行的字节偏移,往上翻就从那里接着往前读。几十 MB 的会话也只读要看的那一截;
 * - **解析只有一份**:同 sessionDigest.ts 的三家读法(按行带偏移),系统注入、工具结果、元记录在那里就已经不算;
 * - 文字原样(Markdown 交给手机渲染),单条超大的才截一刀并标 `clipped`;
 * - 工具调用连着的几步折成一条:一行人话 + 每步的说明与文件名,**不给原始输入输出**;
 * - 只读、不落盘、不经模型。
 */
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { humanError } from '../humanError.ts'
import {
  SESSION_TRANSCRIPT_ROUNDS,
  type SessionAttachmentRef,
  type SessionTranscriptEntry,
  type SessionTranscriptView,
} from '../protocol.ts'
import {
  asRecord,
  claudeAsk,
  didLine,
  parseRowsOf,
  readHeadTail,
  stripLeadingTags,
  stripTagBlocks,
  turnsOf,
  type DigestEvent,
  type DigestFormat,
  type SourceRow,
  type ToolVerb,
} from './sessionDigest.ts'
import type { SessionFileRef } from './sessionHistory.ts'
import type { LibraryResult } from './sessionLibrary.ts'

/** 一步工具调用说成什么(过去时,不出现工具名)。 */
const STEP_LINE: Record<ToolVerb, string> = {
  read: '看文件',
  edit: '改文件',
  test: '跑测试',
  build: '构建',
  commit: '提交改动',
  push: '推送改动',
  git: '看改动记录',
  install: '装依赖',
  search: '查找',
  web: '查网页',
  run: '跑命令',
  agent: '派助手',
  ask_user: '问你',
  screen: '操作电脑界面',
  plan: '排步骤',
  message: '给别的会话传话',
  wait: '等后台的结果',
  other: '用了别的工具',
}

/** 单条文字最长给多少字(超大的那种一般是贴进来的日志;截了标 `clipped`,手机写「太长,截了」)。 */
const ENTRY_TEXT_MAX = 60_000
/** 一页回包的文字最多这么多(中转一条回包 1MB,留足余量)。超了就少给几轮,游标照样接得上。 */
const PAGE_TEXT_BUDGET = 600_000
/** 一页最多往回读这么多字节(全是工具输出的长会话也不至于一次读几百 MB)。 */
const PAGE_SCAN_MAX = 48 * 1024 * 1024
const CHUNK = 256 * 1024
const DETAIL_MAX = 300

export interface SessionTranscriptDeps {
  locate: (agent: string, sessionId: string) => Promise<SessionFileRef | undefined>
  now?: () => Date
  /**
   * 附件(卡 C):每读到一行,问一句这一行带出了哪些附件(她贴的图、它的截图、提到的本机文件)。
   * 缺席 = 不列附件。
   */
  attachmentsOf?: (format: DigestFormat, row: Record<string, unknown>, offset: number) => Promise<AttachmentHit[]> | AttachmentHit[]
}

/** 一行里带出的附件,挂到哪一条上(她那句 / 它那句 / 那几步)。 */
export interface AttachmentHit {
  on: 'ask' | 'reply' | 'steps'
  ref: SessionAttachmentRef
  /**
   * 同一张图在记录里写了好几遍时的内容标识(2026-10-04):Codex 的一张截图会同时出现在
   * `event_msg.item_completed.item.result` 与 `response_item.*_call_output.output`(压缩那几行里还有副本),
   * 两行偏移不同、字节一样 —— 这一页里**只留先读到的那一份**,不让她在手机上看到同一张图三遍。
   * 缺席 = 不去重(路径类的附件同一个文件在两轮里提到两次,是两次,该各显示一次)。
   */
  same?: string
}

export interface TranscriptQuery {
  agent: string
  id: string
  before?: string | undefined
  /**
   * 只要**从这一行到末尾**的那一段(不限轮数)。手机开着一条还在长的对话时刷新最新那一段用:
   * 最新一页的起点不变,新出来的几轮接在后面,和已经翻上去的那几页接得严丝合缝。
   */
  from?: string | undefined
  rounds?: number | undefined
}

export interface SessionTranscript {
  read: (query: TranscriptQuery) => Promise<LibraryResult<SessionTranscriptView>>
}

/** 倒着一行一行读(字节层面找换行,不在多字节字中间切)。`end` 是从哪儿往前读(一行的开头)。 */
async function* linesBackward(file: string, end: number): AsyncGenerator<{ o: number, text: string }> {
  const handle = await open(file, 'r')
  try {
    let position = end
    let carry: Buffer = Buffer.alloc(0)
    while (position > 0) {
      const size = Math.min(CHUNK, position)
      position -= size
      const chunk = Buffer.alloc(size)
      await handle.read(chunk, 0, size, position)
      let buffer = Buffer.concat([chunk, carry])
      let lineEnd = buffer.length
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i] !== 0x0a) continue
        if (lineEnd > i + 1) yield { o: position + i + 1, text: buffer.subarray(i + 1, lineEnd).toString('utf8') }
        lineEnd = i
      }
      carry = Buffer.from(buffer.subarray(0, lineEnd))
      buffer = Buffer.alloc(0)
    }
    if (carry.length > 0) yield { o: 0, text: carry.toString('utf8') }
  }
  finally {
    await handle.close()
  }
}

/** 这一行像不像一轮的开头(她说的一句)。粗筛:多算几行没关系,凑够了再按解析结果数。 */
function looksLikeAsk(format: DigestFormat, row: Record<string, unknown>): boolean {
  if (format === 'claude-transcript') return row.type === 'user' && claudeAsk(row) !== undefined
  if (format === 'kimi-wire') return row.type === 'turn.prompt'
  const payload = asRecord(row.payload)
  if (payload === undefined) return false
  if (row.type === 'event_msg') return payload.type === 'user_message' || (payload.type === 'item_completed' && asRecord(payload.item)?.type === 'UserMessage')
  return row.type === 'response_item' && payload.type === 'message' && payload.role === 'user'
}

/** 解析 JSON 一行;认不出就 undefined。图片的 base64 在这里就丢掉(附件那一层已经在读行时记下了),回包与内存都不背它。 */
function parseRow(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed[0] !== '{') return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  }
  catch {
    return undefined
  }
}

function clipEntry(text: string): { text: string, clipped?: true } {
  return text.length <= ENTRY_TEXT_MAX ? { text } : { text: `${text.slice(0, ENTRY_TEXT_MAX)}…`, clipped: true }
}

/** 她那句:去掉夹在里面的注入标签与行首我们自己打的记号。 */
function askText(raw: string): string {
  return stripLeadingTags(stripTagBlocks(raw)).replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim()
}

function stepsLine(steps: { verb: ToolVerb, files: readonly string[] }[]): string {
  const counts = new Map<ToolVerb, number>()
  const files = new Map<ToolVerb, Set<string>>()
  for (const step of steps) {
    if ((step.verb === 'edit' || step.verb === 'read') && step.files.length > 0) {
      const set = files.get(step.verb) ?? new Set<string>()
      for (const file of step.files) set.add(file)
      files.set(step.verb, set)
    }
    else counts.set(step.verb, (counts.get(step.verb) ?? 0) + 1)
  }
  for (const [verb, set] of files) counts.set(verb, set.size)
  const did = didLine(counts)
  return did === undefined ? `做了 ${steps.length} 步` : `做了 ${steps.length} 步:${did}`
}

/** 事件 → 界面上的条目(工具连着的几步并成一条)。附件按行偏移挂上去。 */
function entriesOf(events: readonly DigestEvent[], hits: ReadonlyMap<number, AttachmentHit[]>): SessionTranscriptEntry[] {
  const out: SessionTranscriptEntry[] = []
  let run: { verb: ToolVerb, files: string[], line: string, detail?: string, at?: string, o?: number }[] = []
  let runAttachments: SessionAttachmentRef[] = []
  const flush = (): void => {
    if (run.length === 0 && runAttachments.length === 0) return
    const at = run.find(step => step.at !== undefined)?.at
    out.push({
      k: 'steps',
      line: run.length === 0 ? '它看了几张图' : stepsLine(run),
      ...(at === undefined ? {} : { at }),
      steps: run.map(step => ({
        line: step.line,
        ...(step.detail === undefined ? {} : { detail: step.detail }),
        ...(step.files.length === 0 ? {} : { files: step.files }),
      })),
      ...(runAttachments.length === 0 ? {} : { attachments: runAttachments }),
    })
    run = []
    runAttachments = []
  }
  const used = new Set<number>()
  /** 这一行带出来的、该挂在这一种条目上的附件(一行只挂一次)。 */
  const take = (o: number | undefined, on: AttachmentHit['on']): SessionAttachmentRef[] => {
    if (o === undefined) return []
    const list = (hits.get(o) ?? []).filter(hit => hit.on === on)
    if (list.length === 0) return []
    const key = o * 4 + (on === 'ask' ? 0 : on === 'reply' ? 1 : 2)
    if (used.has(key)) return []
    used.add(key)
    return list.map(hit => hit.ref)
  }
  // 工具结果那几行(它看的截图)本身不出事件:它们的附件按行偏移挂到紧挨着的那几步上。
  const loose = [...hits.entries()].filter(([, list]) => list.some(hit => hit.on === 'steps')).map(([o]) => o).sort((a, b) => a - b)
  let next = 0
  const absorb = (until: number): void => {
    while (next < loose.length && loose[next]! < until) runAttachments.push(...take(loose[next++], 'steps'))
  }
  for (const event of events) {
    if (event.o !== undefined) absorb(event.o)
    if (event.k === 'tool' || event.k === 'plan') {
      const verb: ToolVerb = event.k === 'plan' ? 'plan' : event.verb
      const detailRaw = event.k === 'plan' ? event.text : event.detail
      const detail = detailRaw === undefined || detailRaw.trim() === '' ? undefined : detailRaw.trim().slice(0, DETAIL_MAX)
      run.push({
        verb,
        files: event.k === 'tool' ? [...new Set(event.files.map(file => basename(file)))] : [],
        line: STEP_LINE[verb],
        ...(detail === undefined ? {} : { detail }),
        ...(event.at === undefined ? {} : { at: event.at }),
      })
      runAttachments.push(...take(event.o, 'steps'))
      continue
    }
    // 工具结果那几行(它看的截图)不出事件,附件挂在最近那几步上。
    if (event.k === 'end') continue
    flush()
    const stamp = event.at === undefined ? {} : { at: event.at }
    if (event.k === 'ask') {
      const attachments = take(event.o, 'ask')
      const text = askText(event.text)
      if (text === '' && attachments.length === 0 && !event.image) continue
      out.push({ k: 'ask', ...clipEntry(text === '' && event.image ? '' : text), ...stamp, ...(attachments.length === 0 ? {} : { attachments }) })
    }
    else if (event.k === 'say') {
      const attachments = take(event.o, 'reply')
      out.push({ k: 'reply', ...clipEntry(event.text.trim()), ...stamp, ...(event.final ? { final: true as const } : {}), ...(attachments.length === 0 ? {} : { attachments }) })
    }
    else if (event.k === 'fail') {
      const human = humanError({ ...(event.code === undefined ? {} : { code: event.code }), ...(event.raw === undefined ? {} : { raw: event.raw }) })
      out.push({ k: 'note', tone: 'fail', text: human?.line ?? '这一轮出错停了', ...stamp })
    }
    else if (event.k === 'abort') {
      out.push({ k: 'note', tone: 'stop', text: '这一轮被打断了', ...stamp })
    }
    else if (event.k === 'wait') {
      out.push({ k: 'note', tone: 'wait', text: event.formal === 'approval' ? '停下来等你批准' : '停下来在问你', ...stamp })
    }
  }
  absorb(Number.POSITIVE_INFINITY)
  flush()
  return out
}

/** 条目里的文字有多大(估回包大小用)。 */
function weight(entries: readonly SessionTranscriptEntry[]): number {
  return JSON.stringify(entries).length
}

export function createSessionTranscript(deps: SessionTranscriptDeps): SessionTranscript {
  const now = deps.now ?? (() => new Date())

  return {
    async read(query) {
      const ref = await deps.locate(query.agent, query.id)
      if (ref === undefined) return { ok: false, status: 404, error: '读不到这条对话的记录(可能删掉了,或者不是这几家的)' }
      let size: number
      let fallbackAt: string
      let head: string | undefined
      try {
        const handle = await open(ref.file, 'r')
        try {
          const info = await handle.stat()
          size = info.size
          fallbackAt = new Date(info.mtimeMs).toISOString()
          // 游标得是一行的开头(前一个字节是换行),不然从半行读起会错位。
          for (const cursor of [query.before, query.from]) {
            if (cursor === undefined) continue
            if (!/^\d{1,15}$/.test(cursor)) return { ok: false, status: 400, error: '往上翻的位置不对' }
            const at = Number(cursor)
            if (at < 0 || at > size || (at === 0 && cursor === query.before)) return { ok: false, status: 400, error: '往上翻的位置不对' }
            if (at === 0) continue
            const prev = Buffer.alloc(1)
            await handle.read(prev, 0, 1, at - 1)
            if (prev[0] !== 0x0a) return { ok: false, status: 400, error: '往上翻的位置不对' }
          }
        }
        finally {
          await handle.close()
        }
      }
      catch {
        return { ok: false, status: 404, error: '读不到这条对话的记录(可能删掉了)' }
      }
      const end = query.before === undefined ? size : Number(query.before)
      const want = Math.max(1, Math.min(20, query.rounds ?? SESSION_TRANSCRIPT_ROUNDS))

      const collected: SourceRow[] = []
      const hits = new Map<number, AttachmentHit[]>()
      const sameSeen = new Set<string>()
      let candidates = 0
      let need = want
      let scanned = 0
      let reachedStart = true
      let start: number | undefined
      let events: DigestEvent[] = []
      const from = query.from === undefined ? undefined : Number(query.from)
      for await (const { o, text } of linesBackward(ref.file, end)) {
        if (from !== undefined && o < from) {
          start = from
          reachedStart = false
          break
        }
        scanned += text.length
        const row = parseRow(text)
        if (row !== undefined) {
          const found = deps.attachmentsOf === undefined ? [] : await deps.attachmentsOf(ref.format, row, o)
          // 同一张图写了好几遍的,这一页里只留先读到的那一份(见 AttachmentHit.same)。
          const kept = found.filter(hit => hit.same === undefined || !sameSeen.has(hit.same))
          for (const hit of kept) if (hit.same !== undefined) sameSeen.add(hit.same)
          if (kept.length > 0) hits.set(o, kept)
          stripImageData(row)
          collected.push({ row, o })
          if (looksLikeAsk(ref.format, row)) candidates += 1
        }
        if (from === undefined && candidates >= need) {
          events = parseRowsOf(ref.format, [...collected].reverse(), fallbackAt).events
          const asks = events.filter(event => event.k === 'ask')
          if (asks.length >= want) {
            start = asks[asks.length - want]!.o
            reachedStart = false
            break
          }
          need += want - asks.length
        }
        if (from === undefined && scanned > PAGE_SCAN_MAX) {
          // 往回读了太多(全是工具输出):这一页就到这儿,从这一行接着往上翻。
          start = o
          reachedStart = false
          break
        }
      }
      if (reachedStart || from !== undefined) events = parseRowsOf(ref.format, [...collected].reverse(), fallbackAt).events
      // 这一页从哪一行起;最早那一行就是文件开头 → 已经到头了。
      let kept = start === undefined ? events : events.filter(event => event.o === undefined || event.o >= start!)
      let entries = entriesOf(kept, hits)
      // 回包太大就少给几轮(从最早的那一轮往后让),游标跟着挪。
      while (from === undefined && weight(entries) > PAGE_TEXT_BUDGET) {
        const asks = kept.filter(event => event.k === 'ask')
        if (asks.length <= 1) break
        start = asks[1]!.o
        reachedStart = false
        kept = kept.filter(event => event.o === undefined || event.o >= start!)
        entries = entriesOf(kept, hits)
      }
      const before = !reachedStart && start !== undefined && start > 0 ? String(start) : undefined
      let tail: string | undefined
      if (query.before === undefined && query.from === undefined) {
        const read = await readHeadTail({ format: ref.format, file: ref.file }, { headBytes: 64 * 1024, maxHeadBytes: 1024 * 1024, tailBytes: 64 * 1024 })
        if (read !== undefined) { head = read.head; tail = read.tail }
      }
      const title = head === undefined ? undefined : titleOf(ref, head, tail ?? head, fallbackAt)
      return {
        ok: true,
        value: {
          agent: query.agent,
          session_id: query.id,
          ...(title === undefined ? {} : { title }),
          entries,
          ...(before === undefined ? {} : { before }),
          read_at: now().toISOString(),
        },
      }
    },
  }
}

/** 标题:与卡片同一套取法(那家自己的名 > custom-title > 第一句前 20 来字)。custom-title 常写在文件后面,所以头尾都给。 */
function titleOf(ref: SessionFileRef, head: string, tail: string, fallbackAt: string): string | undefined {
  return turnsOf(ref.format, { head, tail, fallbackAt, ...(ref.name === undefined ? {} : { name: ref.name }) }).title
}

/** 图片块的 base64 只留个长度(附件那一层读行时已经记下了;回包与内存都不背它)。 */
function stripImageData(row: Record<string, unknown>): void {
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) { for (const one of value) visit(one, depth + 1); return }
    const record = value as Record<string, unknown>
    if (typeof record.data === 'string' && record.data.length > 4096) record.data = ''
    if (typeof record.image_url === 'string' && record.image_url.startsWith('data:') && record.image_url.length > 4096) record.image_url = 'data:'
    for (const key of Object.keys(record)) {
      const child = record[key]
      if (typeof child === 'object' && child !== null) visit(child, depth + 1)
    }
  }
  visit(row, 0)
}

