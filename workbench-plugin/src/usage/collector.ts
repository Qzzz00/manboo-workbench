/**
 * 用量采集循环。对应 quota/collector.ts 的位置:解析器只负责"解析一段文本",
 * store 只负责"聚合",这一层把它们和文件系统接起来。
 *
 * 实时靠增量追读兑现:启动时全扫一次建游标,之后每轮只 stat,文件变长了才从上次
 * 偏移往后读那一小段。除首轮外开销约等于一次 stat 遍历——Ben 机器上 Claude 那堆
 * 日志有 689MB,每轮全扫是不可行的。
 *
 * **已读偏移落盘 + 首轮限速(2026-10-28,8791 第五轮,任务书
 * `docs/交接-1028-8791热点第五轮-用量采集首轮全量扫描.md`)**:原来的偏移只在内存里,
 * 工作台每次重启首轮都把 `~/.codex/sessions`(真机 9.5GB、1189 份)从头 `indexOf` 扫一遍
 * 找用量标记,一扫一分多钟满 CPU。现在每轮扫完把 {path → size, mtimeMs, 已读偏移,
 * Codex 解析器续跑状态} 原子写进 `~/.dsh/workbench/usage-offsets.json`,启动读回:
 * stamp 对得上(尺寸没动)就跳过,变长了从偏移续读,变短/同尺寸重写才整份重扫。
 * 账本缺失(第一次装)也不燃机:一轮最多读 20 份或 64MB,剩下的下一轮接着,面板数字
 * 迟几分钟到位(08-31 拍过「迟一分钟无所谓」);扫描在每份文件之间让一次事件循环,
 * `/state`、`/butler/say` 先走。
 *
 * 失败纪律(与 quota/collector.ts 同源):任一来源失败只标该来源 error 并**保留
 * 上一轮已聚合的结果**,不清空、不填 0(D13)。
 *
 * **Kimi(2026-10-27 维护者拍板重新接上,任务书 `docs/任务书-Kimi用量接进消耗面板-2026-10-27.md`)**:
 * 09-02 摘掉的理由是"订阅制拿不到 token、旧命令行只有输出 token"——新版不成立了:
 * Kimi 命令行与桌面版内置的本机 Agent 引擎都会在 wire.jsonl 里写 `usage.record`
 * (每轮 turn 四字段齐全:新输入/缓存读/缓存写/输出)。只算 `usageScope == "turn"`,
 * 按 model 分家(火山 deepseek-v4-flash 归 DeepSeek),项目归属经两侧 workspaces.json
 * 把 `wd_xxx` 还原成路径再 rollupProject;普通聊天在云端跑、本机没数据,面板写明不计入。
 * 旧命令行目录 `~/.kimi` 不读(9 月以后没更新过),credentials 目录一个字节不碰。
 */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as zlib from 'node:zlib'
import { pickLatestGeneration } from '../dshSessionFile.ts'
import type { UsageSourceStatus, UsageState, UsageTotals } from '../protocol.ts'
import { CLAUDE_USAGE_MARKER, parseClaudeLine } from './claude.ts'
import { CODEX_USAGE_MARKERS, createCodexLineParser, type CodexParserState } from './codex.ts'
import { parseDshSession } from './dsh.ts'
import { KIMI_USAGE_MARKER, parseKimiWireLine } from './kimi.ts'
import { rollupProject } from './rollup.ts'
import { createUsageStore, nextCursor, type UsageStoreSnapshot } from './store.ts'
import type { UsageRecord } from './types.ts'

/** 这份用量**覆盖到哪**。界面原样念这一句(见 `view()` 里 `scope` 那段)。 */
export const USAGE_SCOPE_LOCAL_LOGS = '本机留存的会话日志,不等于账号全端用量或账单'

/** 本机时区名(`Asia/Shanghai` 这种)。问不出来就回 undefined —— 不猜一个(D13)。 */
export function localTimeZone(): string | undefined {
  try {
    const name = new Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof name === 'string' && name !== '' ? name : undefined
  }
  catch { return undefined }
}

export interface UsageCollector {
  refresh: () => Promise<void>
  view: () => UsageState | { error: string }
  /** 按会话汇总,键 `${agent}:${session_id}`;查不到的缺席。见 store.ts 同名方法。 */
  sessionTotals: (keys: readonly string[]) => Record<string, UsageTotals>
}

/** 仅计数与耗时的 Codex 扫描收据；不得放文件名、会话号或原文。 */
export interface UsageScanDiagnostic {
  source: 'codex'
  instance: number
  round: number
  concurrent: number
  files: number
  changed: number
  bytes: number
  rewinds: number
  failed: number
  duration_ms: number
  cpu_ms: number
}

/**
 * 每次**真正读文件**的计数探针(2026-10-28,8791 第五轮):哪家读了几个字节。
 * 与 {@link UsageScanDiagnostic} 同一套脱敏纪律——不得放文件名、会话号或原文;
 * 第五轮的验收(重启零重读、首轮限速)全靠它钉字节数。stat 不算读。
 */
export interface UsageReadProbe {
  source: 'claude' | 'codex' | 'dsh'
  bytes: number
}

let nextCollectorInstance = 0

/**
 * Codex rollout 文件名形如 `rollout-2026-09-09T09-32-51-<uuid>.jsonl`,而 Codex 会话源
 * (codexSessionFeed)报上来的 session_id 是 session_meta.payload.id,就是那个 uuid。
 * 记账时用 uuid 当会话键,任务卡上的关联才对得上;取不出 uuid 的文件名原样保留。
 */
export function codexSessionKey(fileName: string): string {
  const match = fileName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return match?.[1] ?? fileName
}

/**
 * 解一份 DSH 的 `session.jsonl.zstd`(2026-09-15)。
 *
 * 它是**多帧追加**的:DSH 每次落盘各压一帧再 append(真机一份 420KB 的文件里有 756 帧),
 * `zlib.zstdDecompressSync` 整块喂只会解出第一帧(208 字节,恰好是会话头那一行),后面全丢。
 * 所以逐帧循环:`info: true` 时 `engine.bytesWritten` 就是这一帧吃掉的压缩字节数,以此推进偏移。
 * 帧与行不对齐(756 帧对 1091 行),一行可能被切在两帧之间——先拼完整个 Buffer 再切行。
 *
 * zstd 支持是 Node 22.15+/24 才有的内置能力(工作台自带的 `~/.dsh/node` 是 24.19);没有就整家
 * dsh 报 error 带原因,不静默当 0。
 */
export function decompressZstdFrames(buffer: Buffer): Buffer {
  // @types/node 还没给 zstdDecompressSync 声明 `info: true` 的重载,这里按运行时真实返回值自己标类型。
  type DecompressWithInfo = (input: Buffer, options: { info: true }) => { buffer: Buffer, engine: { bytesWritten: number } }
  const decompress = (zlib as Record<string, unknown>).zstdDecompressSync
  if (typeof decompress !== 'function') throw new Error('本机 Node 缺少 zstd 支持(需 22.15+ / 24),DSH 会话日志解不开')
  const parts: Buffer[] = []
  let offset = 0
  while (offset < buffer.length) {
    const result = (decompress as DecompressWithInfo)(buffer.subarray(offset), { info: true })
    const consumed = result.engine.bytesWritten
    if (!(consumed > 0)) throw new Error(`zstd 帧在偏移 ${offset} 处没有推进`)
    parts.push(result.buffer)
    offset += consumed
  }
  return Buffer.concat(parts)
}

/** 从 offset 起读到文件末尾。返回新增的字节与新的偏移量。 */
async function readFrom(path: string, offset: number): Promise<{ bytes: Buffer, offset: number }> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= offset) return { bytes: Buffer.alloc(0), offset: size }
    const length = size - offset
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, offset)
    return { bytes: buffer, offset: size }
  }
  finally {
    await handle.close()
  }
}

/**
 * `region` 里提到任一个词的那几整行(按在文件里的先后,一行只出一次);没提到的行一个字节都不解码(2026-10-21 急修)。
 *
 * 会话日志里绝大多数字节是工具输出与嵌着图片的消息(真机 Codex 9GB、Claude 2GB,一行最长 21MB),
 * 原来整段解成字符串、逐行 `JSON.parse` 再扔掉 —— DSH 每次重启首轮从头扫,一扫就是一分多钟的满 CPU。
 * 在字节上找词是 C++ 里的一趟扫描,命中的只有带用量的那几行(几百字节一行)。
 */
export function linesMentioning(region: Buffer, words: readonly string[]): string[] {
  const lines = new Map<number, number>()
  for (const word of words) {
    let at = region.indexOf(word)
    while (at !== -1) {
      const start = region.lastIndexOf(0x0a, at) + 1
      const newline = region.indexOf(0x0a, at)
      const end = newline === -1 ? region.length : newline
      lines.set(start, end)
      at = end >= region.length ? -1 : region.indexOf(word, end)
    }
  }
  return [...lines].sort((a, b) => a[0] - b[0]).map(([start, end]) => region.toString('utf8', start, end))
}

export function createUsageCollector(options: { home?: string, onDiagnostic?: (row: UsageScanDiagnostic) => void, onRead?: (row: UsageReadProbe) => void } = {}): UsageCollector {
  const home = options.home ?? process.env.HOME ?? '/Users/example'
  const instance = ++nextCollectorInstance
  let round = 0
  let activeRefreshes = 0
  const store = createUsageStore()
  const cursors = new Map<string, number>()
  const sources: Record<string, UsageSourceStatus> = {
    claude: { status: 'ok' },
    codex: { status: 'ok' },
    dsh: { status: 'ok' },
  }
  /**
   * DSH 里读不了/解不开的会话文件。与 Codex 那个每轮归零的计数不同,这里持久记着,只要它还在,
   * dsh 就一直如实标 partial——跳过了不等于修好了。坏文件**不推游标**,下轮再试:权限修好、
   * 写到一半的尾帧补齐,都可能发生在文件尺寸不变的情况下(DSH 会话文件是按会话分的小文件,
   * 每分钟多撞一次代价可忽略;Codex 那边有 1GB 的 rollout,才要靠推游标止损)。读成功才摘掉。
   */
  const dshBroken = new Set<string>()
  let scannedAt = ''
  let everSucceeded = false

  /**
   * 已读偏移账本(2026-10-28,8791 第五轮,见文件头):每轮扫完原子写
   * `~/.dsh/workbench/usage-offsets.json`,启动读回。`offset` 只推进到**最后一个完整行
   * 的结尾**:文件末尾那截没换行的尾巴不落盘,新实例续读时把这几字节再读一遍拼回来
   * (新实例的账本是空的,重放这几字节不会造成重复计入;半行写全了反而因此不漏)。
   * `codex` 是解析器闭包里那点续跑状态(cwd/模型/序号/回声签名),见 codex.ts。
   * `store` 是聚合账的整体快照:已读偏移只覆盖文件字节,**已聚合的数字**靠它带过去,
   * 否则新实例跳过未变文件后,面板就是一片空白(去重键也一并带上,截短重写时不重复计入)。
   */
  interface UsageOffsetEntry { size: number, mtimeMs: number, offset: number, codex?: CodexParserState }
  interface UsageOffsetLedger { v: 1, files: Record<string, UsageOffsetEntry>, store?: UsageStoreSnapshot }
  const ledgerFile = join(home, '.dsh/workbench/usage-offsets.json')
  const saved = new Map<string, UsageOffsetEntry>()
  let ledgerLoaded = false
  let ledgerDirty = false

  async function loadLedger(): Promise<void> {
    if (ledgerLoaded) return
    ledgerLoaded = true
    try {
      const row = JSON.parse(await readFile(ledgerFile, 'utf8')) as UsageOffsetLedger
      if (row.v === 1 && typeof row.files === 'object' && row.files !== null) {
        for (const [path, entry] of Object.entries(row.files)) {
          if (typeof entry?.size === 'number' && typeof entry.mtimeMs === 'number' && typeof entry.offset === 'number') saved.set(path, entry)
        }
      }
      // 聚合账整体恢复:重启的新实例靠它续账(见 UsageOffsetLedger 注释)。
      if (row.store !== undefined) store.restore(row.store)
    }
    catch {
      /* 账本缺失/读不了/格式不认:当成第一份账本从空开始,首轮限速把全量扫摊平。 */
    }
  }

  async function saveLedger(): Promise<void> {
    const files: Record<string, UsageOffsetEntry> = {}
    for (const [path, entry] of saved) files[path] = entry
    const tmp = `${ledgerFile}.${randomUUID()}.tmp`
    await mkdir(dirname(ledgerFile), { recursive: true })
    await writeFile(tmp, JSON.stringify({ v: 1, files, store: store.snapshot() } satisfies UsageOffsetLedger))
    await rename(tmp, ledgerFile)
    ledgerDirty = false
  }

  function remember(path: string, entry: UsageOffsetEntry): void {
    saved.set(path, entry)
    ledgerDirty = true
  }

  /** 吃进记录;有新计入的才把账本标脏(2026-10-28 第五轮,省得每轮重写落盘账)。 */
  function ingestRecords(records: readonly UsageRecord[]): void {
    if (store.ingest(records) > 0) ledgerDirty = true
  }

  /** 读探针(第五轮):统计不能影响扫描本身,同 onDiagnostic 的纪律。 */
  function probe(source: UsageReadProbe['source'], bytes: number): void {
    if (options.onRead === undefined) return
    try { options.onRead({ source, bytes }) }
    catch { /* 探针不能影响用量账与游标。 */ }
  }

  /**
   * 这一份文件**本轮从哪个偏移读**:`cursors`(内存,本实例)优先;否则用账本条目判:
   * 变长了 → 从账本偏移续读;尺寸 + mtime 都没动 → 返回 size(调用方当「跳过」);
   * 变短或同尺寸重写 → 从头整扫并 `rescan`(调用方作废解析器状态,诊断里计一次 rewind)。
   * 内存游标那支保持 2026-10-12 以来的 nextCursor 语义(size < offset → 整扫)。
   */
  function resumePoint(path: string, size: number, mtimeMs: number): { offset: number, rescan: boolean } {
    const mem = cursors.get(path)
    if (mem !== undefined) return nextCursor(size, mem)
    const entry = saved.get(path)
    if (entry === undefined) return { offset: 0, rescan: false }
    if (size > entry.offset) return { offset: entry.offset, rescan: false }
    if (size === entry.offset && mtimeMs === entry.mtimeMs) return { offset: entry.offset, rescan: false }
    return { offset: 0, rescan: true }
  }

  /** 落盘的已读偏移:只推进到最后一个完整行结尾,末尾半行留给下个实例重放拼接。 */
  function safeOffset(base: number, bytes: Buffer): number {
    const nl = bytes.lastIndexOf(0x0a)
    return nl === -1 ? base : base + nl + 1
  }

  /**
   * 每轮扫描配额(2026-10-28 第五轮):账本缺失/第一次装也要把首轮摊平,一轮最多读
   * 20 份或 64MB(任务书建议值),超出的文件**不留游标**,下一轮接着扫;面板数字
   * 迟几分钟到位(08-31 拍过「迟一分钟无所谓」)。稳态轮几乎不读文件,配额用不完。
   */
  const SCAN_ROUND_MAX_FILES = 20
  const SCAN_ROUND_MAX_BYTES = 64 * 1024 * 1024
  let spend = { files: 0, bytes: 0 }

  /** 两份文件之间让一次事件循环:`/state`、`/butler/say` 不必等整轮扫完(第五轮)。 */
  function yieldLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve))
  }

  /** 配额够读这一份吗?估算量是「尺寸 − 已读偏移」。调用方先排除「没变」的情况。 */
  function overBudget(point: { offset: number }, size: number): boolean {
    return spend.files >= SCAN_ROUND_MAX_FILES || spend.bytes + (size - point.offset) > SCAN_ROUND_MAX_BYTES
  }

  async function scanClaude(): Promise<void> {
    const root = join(home, '.claude/projects')
    for (const dir of await readdir(root)) {
      const dirPath = join(root, dir)
      let entries: string[]
      try {
        entries = await readdir(dirPath)
      }
      catch {
        // 单个项目目录读不了(权限/竞态删除)不该让整家 claude 判失败。
        continue
      }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue
        const path = join(dirPath, name)
        let size: number
        let mtimeMs: number
        try {
          const st = await stat(path)
          size = st.size
          mtimeMs = st.mtimeMs
        }
        catch {
          continue
        }
        const point = resumePoint(path, size, mtimeMs)
        if (point.offset === size) continue // 没变,一个字节不读
        if (overBudget(point, size)) continue // 本轮配额用尽,不留游标,下一轮接着
        const { bytes, offset } = await readFrom(path, point.offset)
        cursors.set(path, offset)
        spend.files += 1
        spend.bytes += bytes.length
        await yieldLoop()
        probe('claude', bytes.length)
        // 已读偏移落盘:只推进到最后一个完整行,末尾半行留给下个实例重放(见文件头)。
        remember(path, { size, mtimeMs, offset: safeOffset(point.offset, bytes) })
        if (bytes.length === 0) continue

        const session = name.replace(/\.jsonl$/, '')
        const records: UsageRecord[] = []
        for (const line of linesMentioning(bytes, [CLAUDE_USAGE_MARKER])) {
          const record = parseClaudeLine(line, session)
          if (record !== undefined) records.push(record)
        }
        ingestRecords(records)
      }
    }
  }

  /**
   * Codex 每个文件各留一份**解析器 + 一截没换行的尾巴**(2026-10-12,增量追读;卡 `claude/ops-patch-1012`)。
   *
   * 原来是「文件变长了就整份重读」(cwd 只在文件头出现一次,追读拿不到),配上 10 秒一轮,
   * 一份几百 MB 的活跃 rollout 每十秒整份流过一遍 —— 08-31 那场磁盘风暴就是这么来的。
   * 解析器留着,cwd / 模型 / 序号都在它闭包里,追加的几行照样归到文件头那个项目上;
   * 尾巴按**字节**留(不是字符串):多字节字符可能正好切在块边界上,按字节拼回去再解。
   * 尾巴是**一串块**,见到换行那一刻才拼成一段:一行嵌着图片的工具输出能有 20MB,每来一块就把尾巴整段拼一遍、
   * 整段找换行、再整段复制,这一行的代价就按长度的平方涨(真机一份 474MB 的 rollout 切行 44 秒,2026-10-21 急修)。
   * 文件被截短(Codex 另起一份同名文件)→ `nextCursor` 说 rescan → 这一份作废、从头来。
   */
  const codexStates = new Map<string, { parser: ReturnType<typeof createCodexLineParser>, tail: Buffer[] }>()

  /**
   * 从上次偏移往后流式追读一份 rollout(2026-09-11 起流式:Ben 机器上一份 1.06GB 的 rollout
   * 整份 readFile 直接撞 V8 字符串上限 "Invalid string length";异常按文件隔离,读不了的只计数)。
   * 只喂**完整的行**(到最后一个换行为止),剩下的字节留到下一轮;游标只在这一轮读完之后才推进。
   *
   * 2026-10-28(8791 第五轮):`point` 由调用方按「内存游标 → 落盘账本」定好;续读时把
   * 账本里那份解析器快照喂给新解析器(cwd/模型/序号,见 codex.ts),重启后追加的记录
   * 照旧归到文件头那个项目。落盘的已读偏移扣掉末尾没换行的尾巴,下个实例把那几字节
   * 重放拼回——新实例账本为空,重放不重复计入,半行写全了也不漏(理由见文件头)。
   */
  async function ingestCodexFile(path: string, session: string, size: number, mtimeMs: number, point: { offset: number, rescan: boolean }, diagnostic?: UsageScanDiagnostic): Promise<number> {
    if (point.rescan && diagnostic !== undefined) diagnostic.rewinds += 1
    if (point.rescan) codexStates.delete(path)
    const state = codexStates.get(path) ?? { parser: createCodexLineParser(session, point.rescan ? undefined : saved.get(path)?.codex), tail: [] }
    codexStates.set(path, state)
    const stream = createReadStream(path, { start: point.offset })
    let consumed = 0
    try {
      for await (const chunk of stream) {
        const buf = chunk as Buffer
        consumed += buf.length
        if (diagnostic !== undefined) diagnostic.bytes += buf.length
        // 尾巴里本来就没有换行,只在新到的这一块里找。
        const cut = buf.lastIndexOf(0x0a)
        if (cut === -1) {
          state.tail.push(buf)
          continue
        }
        const head = buf.subarray(0, cut)
        const lines = state.tail.length === 0 ? head : Buffer.concat([...state.tail, head])
        for (const line of linesMentioning(lines, CODEX_USAGE_MARKERS)) state.parser.push(line)
        // 复制一份,不让一截尾巴把整块大缓冲按着不放。
        state.tail = cut + 1 < buf.length ? [Buffer.from(buf.subarray(cut + 1))] : []
      }
    }
    finally {
      stream.destroy()
    }
    // 文件末尾没换行的那一截:整条 JSON 都在了就是一条完整记录(写日志的一方不一定补换行),照喂;
    // 解不开才是写了一半,留到下一轮。喂过的那一截游标已经推过去,下一轮读到的开头是那个换行(空行,解析器跳过)。
    if (state.tail.length > 0) {
      const rest = state.tail.length === 1 ? state.tail[0] as Buffer : Buffer.concat(state.tail)
      if (isWholeJsonLine(rest)) {
        state.parser.push(rest.toString('utf8'))
        state.tail = []
      }
      else {
        state.tail = [rest]
      }
    }
    ingestRecords(state.parser.take())
    cursors.set(path, point.offset + consumed)
    probe('codex', consumed)
    let tailBytes = 0
    for (const piece of state.tail) tailBytes += piece.length
    remember(path, { size, mtimeMs, offset: point.offset + consumed - tailBytes, codex: state.parser.snapshot() })
    return consumed
  }

  function isWholeJsonLine(bytes: Buffer): boolean {
    try { JSON.parse(bytes.toString('utf8')); return true }
    catch { return false }
  }

  async function scanCodex(diagnostic?: UsageScanDiagnostic): Promise<string | undefined> {
    const root = join(home, '.codex/sessions')
    let failed = 0
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(path)
          continue
        }
        if (!entry.name.endsWith('.jsonl')) continue
        let size: number
        let mtimeMs: number
        try {
          const st = await stat(path)
          size = st.size
          mtimeMs = st.mtimeMs
        }
        catch {
          continue
        }
        if (diagnostic !== undefined) diagnostic.files += 1
        const point = resumePoint(path, size, mtimeMs)
        if (point.offset === size) continue // 没变(内存游标或落盘账本),一个字节不读
        if (overBudget(point, size)) continue // 本轮配额用尽:不留游标,下一轮接着(2026-10-28 第五轮)
        if (diagnostic !== undefined) diagnostic.changed += 1
        // 只追读新增的那一段(解析器按文件留着,见 codexStates);记录带稳定去重 key,截短重来也不会重复计入。
        try {
          const consumed = await ingestCodexFile(path, codexSessionKey(entry.name), size, mtimeMs, point, diagnostic)
          spend.files += 1
          spend.bytes += consumed
          await yieldLoop()
        }
        catch {
          failed += 1
          if (diagnostic !== undefined) diagnostic.failed += 1
          cursors.set(path, size) // 这一版读不了,下轮不再反复撞它;文件变长了会再试
          const prev = saved.get(path)
          remember(path, { size, mtimeMs, offset: size, ...(prev?.codex === undefined ? {} : { codex: prev.codex }) })
        }
      }
    }
    await walk(root)
    return failed === 0 ? undefined : `${failed} 份会话文件读不了,已跳过`
  }

  /**
   * DSH 会话用量(2026-09-15,Ben 拍板接进来;解析器 2026-08 就写了,采集器一直没调它)。
   * 布局 `~/.dsh/sessions/<编码后的项目目录>/session-<uuid>/session[.v4].jsonl[.zstd]`;
   * 压缩与明文两种都认。游标按文件大小,变了就整份重解析——会话头的 cwd 只在首行,追读拿不到;
   * 记录带去重键,重解析不会重复计入(与 Codex 同一套做法)。会话键用目录名 `session-<uuid>`,
   * 与 `ctx.on('session/created')` 报上来的 session.id 一致,任务卡的关联才对得上。
   * 单个文件读不了/解不开只记进 dshBroken 标 partial,不影响别的会话,更不影响另外两家。
   *
   * **一个会话目录只读数字最高的那一代(2026-09-25,卡 U3)**:0.1.7 把文件改名成
   * `session.v4.jsonl[.zstd]`,而且「迁移不移动、不覆盖、不删除任何已提交代际」——旧的
   * `session.jsonl[.zstd]` 逐字节留在同一个目录里。原先这里写死两个老名字,升级后**新用量一条都
   * 看不见**(静默归零);两代全读又会把同一批消息算两遍(迁移会重排 seq)。所以按
   * {@link pickLatestGeneration} 挑一份,老的当自带备份、一个字节不碰。一条会话在跑的过程中被迁移
   * (上游是「打开某条会话时逐文件做」)也接得住:下一轮自然改读 4 代那一份,已经算过的那些消息
   * 靠 `message.id` 去重键认出来,不重复计入(见 `usage/dsh.ts` 文件头)。
   */
  async function scanDsh(): Promise<string | undefined> {
    const root = join(home, '.dsh/sessions')
    let projectDirs: string[]
    try {
      projectDirs = await readdir(root)
    }
    catch (error) {
      const code = (error as { code?: string }).code
      throw new Error(code === 'ENOENT' ? `~/.dsh/sessions 不存在` : `~/.dsh/sessions 读不了:${error instanceof Error ? error.message : String(error)}`)
    }
    for (const dirName of projectDirs) {
      let sessionDirs: string[]
      try {
        sessionDirs = await readdir(join(root, dirName))
      }
      catch {
        continue // 单个项目目录读不了(权限/竞态删除)不该让整家 dsh 判失败
      }
      for (const session of sessionDirs) {
        const sessionPath = join(root, dirName, session)
        let entries: string[]
        try {
          entries = await readdir(sessionPath)
        }
        catch {
          continue // 不是目录 / 读不了:没有可读的代际,跳过
        }
        const latest = pickLatestGeneration(entries)
        if (latest === undefined) continue // 这个目录里没有规范名的会话日志
        const path = join(sessionPath, latest.name)
        let size: number
        let mtimeMs: number
        try {
          const st = await stat(path)
          size = st.size
          mtimeMs = st.mtimeMs
        }
        catch {
          continue
        }
        // 已读偏移落盘(2026-10-28 第五轮):没变的会话重启后一个字节不读;变了的整份重解析,
        // 重解析靠 message.id 去重不重复计入(见本函数头),所以续读对 DSH 就是「跳过没动的」。
        const point = resumePoint(path, size, mtimeMs)
        if (point.offset === size) continue
        try {
          const raw = await readFile(path)
          probe('dsh', raw.length)
          const text = (latest.compressed ? decompressZstdFrames(raw) : raw).toString('utf8')
          ingestRecords(parseDshSession(text, session, dirName, latest.version))
          cursors.set(path, size)
          remember(path, { size, mtimeMs, offset: size })
          dshBroken.delete(path)
        }
        catch {
          dshBroken.add(path)
          cursors.delete(path) // 不推游标,下轮再试(理由见 dshBroken)
          saved.delete(path)
          ledgerDirty = true
        }
      }
    }
    return dshBroken.size === 0 ? undefined : `${dshBroken.size} 份会话文件读不了,已跳过`
  }

  /**
   * Kimi 用量(2026-10-27 接上,见文件头)。两棵 layout 相同的树:命令行 `~/.kimi-code/sessions`、
   * 桌面版本机 Agent 的 home(在 Application Support 深处);布局都是
   * `<root>/<wd_xxx>/<会话目录>/agents/<agent>/wire.jsonl`。子 agent 与 main 并列在 agents/ 下,
   * 都要读;同一会话目录下的各 agent 文件并成同一条会话键。
   *
   * 项目归属:`wd_xxx` 是编码,两侧的 `workspaces.json`(在 sessions 的上一级)把 id 映射回
   * 路径再交给 rollupProject 归拢;还原不了就归「Kimi 桌面」(桌面侧)/ `(未知)`(命令行侧,
   * 沿 rollupProject 的约定)——不猜一个路径。
   *
   * 追读与去重:每份 wire 各留「下一行行号 + 一截没换行的尾巴」,文件变长只读新增段;
   * 去重键 = 路径 + 行号(见 kimi.ts),截短重扫(nextCursor rescan)也不会重复计入。
   * 末尾没换行但整条 JSON 都在的当轮照喂,写了一半的留到下轮(与 Codex 同一套纪律)。
   *
   * 两棵树都不在(这台没装 Kimi)时 sources 里**不放 kimi 键** —— 名册不摆它,
   * 也不在一家「未接入」上替用户操心(比照 quota 的 installed 口径,2026-10-27 任务书)。
   */
  const kimiStates = new Map<string, { lineNo: number, tail: Buffer }>()

  /** 读 workspaces.json(id → root 路径);没有/读不了就空表 —— 归属走「还原不了」那支,不猜。 */
  async function loadKimiWorkspaces(path: string): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    try {
      const row = JSON.parse(await readFile(path, 'utf8')) as { workspaces?: Record<string, { root?: unknown }> }
      for (const [id, info] of Object.entries(row.workspaces ?? {})) {
        if (typeof info?.root === 'string') map.set(id, info.root)
      }
    }
    catch {
      /* 没有映射表 = 全部还原不了,不是错 */
    }
    return map
  }

  async function ingestKimiWire(path: string, session: string, project: string): Promise<void> {
    const size = (await stat(path)).size
    const cursor = nextCursor(size, cursors.get(path) ?? 0)
    if (cursor.rescan) kimiStates.delete(path)
    let state = kimiStates.get(path)
    if (state === undefined) {
      state = { lineNo: 0, tail: Buffer.alloc(0) }
      kimiStates.set(path, state)
    }
    const { bytes, offset } = await readFrom(path, cursor.offset)
    cursors.set(path, offset)
    const buf = state.tail.length === 0 ? bytes : Buffer.concat([state.tail, bytes])
    // 只喂完整的行(到最后一个换行为止),剩下的字节留到下一轮;UTF-8 多字节字符
    // 不含 0x0a,按字节切行不会切断字符。
    const cut = buf.lastIndexOf(0x0a)
    const complete = cut === -1 ? Buffer.alloc(0) : buf.subarray(0, cut)
    state.tail = cut === -1 ? Buffer.from(buf) : cut + 1 < buf.length ? Buffer.from(buf.subarray(cut + 1)) : Buffer.alloc(0)
    const records: UsageRecord[] = []
    let at = 0
    while (at < complete.length) {
      const nl = complete.indexOf(0x0a, at)
      const end = nl === -1 ? complete.length : nl
      const line = complete.subarray(at, end)
      // 字节上先找 marker(非用量行不解码:wire 里混着工具输出,真机单行能很大)。
      if (line.indexOf(KIMI_USAGE_MARKER) !== -1) {
        const record = parseKimiWireLine(line.toString('utf8'), { path, lineNo: state.lineNo, session, project })
        if (record !== undefined) records.push(record)
      }
      state.lineNo += 1
      at = end + 1
    }
    if (state.tail.length > 0 && isWholeJsonLine(state.tail)) {
      const record = parseKimiWireLine(state.tail.toString('utf8'), { path, lineNo: state.lineNo, session, project })
      if (record !== undefined) records.push(record)
      state.lineNo += 1
      state.tail = Buffer.alloc(0)
    }
    ingestRecords(records)
  }

  async function scanKimi(): Promise<void> {
    try {
      const sides = [
        { root: join(home, '.kimi-code/sessions'), desktop: false },
        { root: join(home, 'Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/sessions'), desktop: true },
      ]
      let anyRoot = false
      let failed = 0
      const notes: string[] = []
      for (const side of sides) {
        let wdDirs
        try {
          wdDirs = await readdir(side.root, { withFileTypes: true })
        }
        catch (error) {
          if ((error as { code?: string }).code === 'ENOENT') continue // 这一侧没装:缺席,不报错(D13)
          notes.push(`${side.desktop ? '桌面版' : '命令行'}目录读不了:${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        anyRoot = true
        const workspaces = await loadKimiWorkspaces(join(side.root, '..', 'workspaces.json'))
        for (const wd of wdDirs) {
          if (!wd.isDirectory()) continue
          const mapped = workspaces.get(wd.name)
          const project = mapped !== undefined ? rollupProject(mapped) : side.desktop ? 'Kimi 桌面' : '(未知)'
          const wdPath = join(side.root, wd.name)
          let sessionDirs
          try {
            sessionDirs = await readdir(wdPath, { withFileTypes: true })
          }
          catch {
            continue // 单个 wd 目录读不了不该让整家 kimi 判失败
          }
          for (const sessionDir of sessionDirs) {
            if (!sessionDir.isDirectory()) continue
            const agentsDir = join(wdPath, sessionDir.name, 'agents')
            let agentDirs
            try {
              agentDirs = await readdir(agentsDir, { withFileTypes: true })
            }
            catch {
              continue // 没有 agents/ 的不是会话目录
            }
            for (const agentDir of agentDirs) {
              if (!agentDir.isDirectory()) continue
              const path = join(agentsDir, agentDir.name, 'wire.jsonl')
              let size: number
              try {
                size = (await stat(path)).size
              }
              catch {
                continue
              }
              if (size === cursors.get(path)) continue
              try {
                await ingestKimiWire(path, sessionDir.name, project)
              }
              catch {
                failed += 1
                cursors.set(path, size) // 这一版读不了,下轮不再反复撞它;变长了会再试(与 Codex 同)
              }
            }
          }
        }
      }
      if (failed > 0) notes.push(`${failed} 份 wire 日志读不了,已跳过`)
      // 两棵树都不在且没碰上过任何 Kimi 数据 → sources 不放 kimi 键(没装就不摆名册)。
      if (!anyRoot && notes.length === 0) return
      sources.kimi = notes.length === 0 ? { status: 'ok' } : { status: 'partial', note: notes.join(';') }
    }
    catch (error) {
      sources.kimi = { status: 'error', note: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    async refresh() {
      round += 1
      activeRefreshes += 1
      const thisRound = round
      await loadLedger() // 已读偏移落盘(第五轮):启动首轮按账本续读,不再全量扫
      spend = { files: 0, bytes: 0 }
      const jobs: [string, () => Promise<string | undefined>, boolean][] = [
        ['claude', async () => { await scanClaude(); return undefined }, true],
        ['codex', async () => {
          if (options.onDiagnostic === undefined) return scanCodex()
          const diagnostic: UsageScanDiagnostic = {
            source: 'codex', instance, round: thisRound, concurrent: activeRefreshes,
            files: 0, changed: 0, bytes: 0, rewinds: 0, failed: 0, duration_ms: 0, cpu_ms: 0,
          }
          const started = performance.now()
          const cpu = process.cpuUsage()
          try { return await scanCodex(diagnostic) }
          finally {
            diagnostic.duration_ms = Math.round(performance.now() - started)
            const used = process.cpuUsage(cpu)
            diagnostic.cpu_ms = Math.round((used.user + used.system) / 1000)
            try { options.onDiagnostic(diagnostic) }
            catch { /* 诊断不能影响用量账与游标。 */ }
          }
        }, true],
        ['dsh', scanDsh, true],
        // Kimi 自己管 sources.kimi(含「整个键缺席」,没装就不摆名册),不参与统一赋值。
        ['kimi', async () => { await scanKimi(); return undefined }, false],
      ]
      try {
        for (const [id, job, assign] of jobs) {
          try {
            const note = await job()
            if (assign) sources[id] = note === undefined ? { status: 'ok' } : { status: 'partial', note }
            everSucceeded = true
          }
          catch (error) {
            sources[id] = {
              status: 'error',
              note: error instanceof Error ? error.message : String(error),
            }
          }
        }
        scannedAt = new Date().toISOString()
        // 已读偏移落盘(第五轮):原子写,失败不毁这一轮——游标在内存里,下一轮接着写。
        if (ledgerDirty) {
          try { await saveLedger() }
          catch { /* 账本写不进去顶多下次重启重扫,用量数字不差(去重键兜底)。 */ }
        }
      }
      finally {
        activeRefreshes -= 1
      }
    },

    view() {
      // 一轮都没成功过 → 整块 error,界面只显示项目区,不显示一个全是 0 的空面板。
      if (!everSucceeded) return { error: '用量日志尚未扫描成功' }
      return {
        days: store.aggregate().days,
        sources,
        scanned_at: scannedAt,
        /**
         * 这份数**按什么口径**算出来的(2026-10-02 运营同学 Air 那一版 —— 她那一格原来
         * 把这两句写死在界面文案里)。写成字段是因为**只有这里知道**:按天切的时区是本机的
         * (`store.localDayOf`),范围是本机留存的那几份会话日志,不等于账号全端用量或账单。
         * 界面原样念这两句,不自己编一个口径(D13)。
         */
        // 问不出来时**整个字段缺席**(不是 undefined 占着位置)—— 见 protocol 那段注释。
        ...(localTimeZone() === undefined ? {} : { timezone: localTimeZone() as string }),
        scope: USAGE_SCOPE_LOCAL_LOGS,
      }
    },

    sessionTotals(keys) {
      return store.sessionTotals(keys)
    },
  }
}
