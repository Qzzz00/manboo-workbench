/**
 * 下班例程第 0 步「收」(2026-09-26,docs/设计-讨论结论都落进工作台记忆-2026-09-26.md §二 0 / §三)。
 *
 * ## 为什么要有这一步
 *
 * 拷各家 AI 的记忆原来**只能手动**(引导里答「要」、或设置里点那颗按钮),之后各家新记的东西再也进不来;
 * 而且拷来的只是原样副本,**没有任何东西把它并进**用户文件或项目文件 —— 仓库里越堆越多、没人读。
 *
 * 现在每天下班例程开头自动收一次,收完把「与上次并入时相比新增或变了的那几份」交给事务官(第 5 步由模型并)。
 * 代码这一半只做三件**不经模型**的事:过授权门、拷(沿用 `agentMemory.ts` 的 `importAgentMemories`,只读原件)、
 * **算清单**。判断哪句话属于他的偏好、哪句属于某个项目,是模型的事,代码一个字都不猜。
 *
 * ## 三条纪律
 *
 * 1. **授权表 `read_client_files` 不是「可以」就一个字节都不拷**(同 onboarding.ts 的 `clientFilesAllowed`,
 *    Ben 2026-09-22 定的 C5),并在汇报里如实说现在是哪一档 —— 不是默默跳过。
 * 2. **清单按内容指纹算**,不按 mtime:`来自-<家>/已并入.md` 里记过同一份文件的同一个指纹,这次就不再列
 *    (同样的内容不该让事务官读第二遍)。`已并入.md` 还没有 = 这一家的全都算新的。
 * 3. **拷来的文件落在 `docs/记忆/来自-<家>/` 底下**,也就落在下班例程 commit 的路径限定里(routines.ts 的
 *    `COMMIT_PATHS` 就是 `docs/记忆` 与 `docs/记忆索引.md`),跟第 7 步一起提交 —— 这里不自己 add、不自己 commit。
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MEMORY_FAMILY_LABELS, importAgentMemories } from './agentMemory.ts'
import type { MemoryImportResult } from './agentMemory.ts'

/** 各家记忆拷在哪(相对仓库根,`来自-<家>` 前面那一截)。 */
export const MEMORY_DIR_REL = 'docs/记忆'

/** 事务官并完之后在每一家目录里记的那份台账。**它由模型写**,代码只读。 */
export const MERGED_LEDGER = '已并入.md'

/** 各家目录名:`来自-Claude`、`来自-Codex`…… */
export function familyDirName(label: string): string {
  return `来自-${label}`
}

/** 这一趟拷进来、还没并过的一份。 */
export interface FreshMemoryFile {
  /** 相对仓库根,如 `docs/记忆/来自-Claude/x-proj/a.md`。 */
  rel: string
  /** 内容指纹(sha256 前 12 位十六进制)。`已并入.md` 里记的就是这一串。 */
  fingerprint: string
}

export interface EveningCollectResult {
  /** 授权不是「可以」时那句话。**有它就等于这次没收**。 */
  skipped?: string
  /** 这一趟各家合计拷了多少份(含内容没变的)。 */
  copied: number
  /** 与「已并入」相比新增或变了的那几份,事务官这次要读的就是它们。 */
  fresh: readonly FreshMemoryFile[]
  /** 一句人话,进 run.note 与会话第一条消息。 */
  summary: string
}

/** 内容指纹:sha256 前 12 位。短到人能抄进表里,长到不会撞。 */
export function fingerprintOf(body: Buffer | string): string {
  return createHash('sha256').update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body).digest('hex').slice(0, 12)
}

/**
 * 读 `已并入.md` 里记过的 `(文件, 指纹)`。**宽容**:那份表是模型写的,列序、多一列少一列都可能,
 * 所以只认「同一行里既出现一个 `.md` 文件名、又出现一串十六进制指纹」—— 认不出的行忽略,不抛。
 *
 * 回的是 `文件名\u0000指纹` 的集合(文件名按 `来自-<家>/` 底下的相对路径,允许表里只写文件名那一截)。
 */
export function parseMergedLedger(text: string | undefined): Set<string> {
  const out = new Set<string>()
  if (text === undefined) return out
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line.split('|').map(cell => cell.trim().replace(/^`|`$/g, ''))
    const file = cells.find(cell => cell.toLowerCase().endsWith('.md'))
    const fingerprint = cells.find(cell => /^[0-9a-f]{8,64}$/.test(cell))
    if (file === undefined || fingerprint === undefined) continue
    out.add(`${file}\u0000${fingerprint}`)
    // 表里只写了文件名那一截(没带项目 slug)也认:拿最后一段再记一条。
    const tail = file.split('/').slice(-1)[0] as string
    if (tail !== file) out.add(`${tail}\u0000${fingerprint}`)
  }
  return out
}

/**
 * 台账里**最新的那个日期**(`YYYY-MM-DD`)。认不出就 undefined。
 *
 * 同样**宽容**:那份表是模型写的,日期在第几列不保证,所以只在台账那几行里找形如日期的一串,取最大的。
 */
export function latestLedgerDate(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  let best: string | undefined
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    for (const found of line.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
      const one = found[0]
      if (best === undefined || one > best) best = one
    }
  }
  return best
}

/** 一棵目录下的 .md(递归),相对 `dir` 的路径;台账与来源说明不算。 */
export async function listCopiedMemories(dir: string, prefix = ''): Promise<string[]> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) }
  catch { return [] }
  const out: string[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) { out.push(...await listCopiedMemories(join(dir, entry.name), rel)); continue }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    if (entry.name === MERGED_LEDGER || entry.name === '来源.md') continue
    out.push(rel)
  }
  return out
}

export interface CollectInput {
  /** 记忆仓库(她的工作目录)。 */
  repo: string
  home: string
  /** 例程的「今天」,写进 `来源.md` 的那一天。 */
  date: string
  /** 授权表里 `read_client_files` 现在是哪一档(「可以」/「要问」/「不可以」/「未答」)。 */
  clientFiles: () => Promise<string>
  /** 测试注入;缺省是真的那一套(agentMemory.ts,只读各家原件)。 */
  importMemories?: (opts: { home: string, repoRoot: string, now?: () => Date, stampNow?: () => Date }) => Promise<MemoryImportResult>
  /** 「最近一次收」那一行写的时刻。缺省是真的现在(测试注入一个固定时刻)。 */
  stampNow?: () => Date
}

/**
 * 收一次。**不抛**:授权读不到按最保守的一档处理;拷到一半出错由调用方兜(routines.ts 那边 try/catch 住,
 * 「今天没收成」不该把下班例程其余几步一起拖没)。
 */
export async function collectAgentMemories(input: CollectInput): Promise<EveningCollectResult> {
  let status = '未答'
  try { status = await input.clientFiles() }
  catch { status = '未答' }
  if (status !== '可以') {
    const line = `没收各家记忆:授权表里「读各家客户端文件」现在是「${status}」,不是「可以」`
    return { skipped: line, copied: 0, fresh: [], summary: line }
  }

  const doImport = input.importMemories ?? importAgentMemories
  const imported = await doImport({
    home: input.home,
    repoRoot: input.repo,
    now: () => new Date(`${input.date}T00:00:00Z`),
    ...(input.stampNow === undefined ? {} : { stampNow: input.stampNow }),
  })
  const copied = imported.copied.reduce((sum, one) => sum + one.count, 0)

  // 清单:每一家自己的台账比自己的文件。已并入.md 没有 → 这一家全都算新的。
  const fresh: FreshMemoryFile[] = []
  for (const label of Object.values(MEMORY_FAMILY_LABELS)) {
    const dirRel = `${MEMORY_DIR_REL}/${familyDirName(label)}`
    const dir = join(input.repo, dirRel)
    const files = await listCopiedMemories(dir)
    if (files.length === 0) continue
    const ledger = parseMergedLedger(await readFile(join(dir, MERGED_LEDGER), 'utf8').catch(() => undefined))
    for (const rel of files) {
      const body = await readFile(join(dir, rel)).catch(() => undefined)
      if (body === undefined) continue
      const fingerprint = fingerprintOf(body)
      if (ledger.has(`${rel}\u0000${fingerprint}`)) continue
      fresh.push({ rel: `${dirRel}/${rel}`, fingerprint })
    }
  }

  /**
   * 两个数**不是同一件事**,分开说:`copied` 是这一趟从各家拷过来的份数,
   * `fresh` 是**还没并进来的**份数(含以前拷过、`已并入.md` 里没记的)。
   * 头一次跑时后者通常比前者大得多 —— 那正是实话:以前拷来的一直没人并。
   */
  const parts = [copied === 0 ? '各家 AI 在这台电脑上没有可收的记忆文件' : `从各家 AI 收了 ${copied} 份`]
  parts.push(fresh.length === 0 ? '没有待并的(都并过了)' : `待并 ${fresh.length} 份`)
  return { copied, fresh, summary: parts.join(',') }
}
