/**
 * 记忆的**收尾检查**(2026-09-27,并入闭环那张卡)。每 10 分钟一次 + 每条例程开跑前一次。
 *
 * ## 这一段代码是为什么存在的
 *
 * 09-26 20:34,代码那一半全对:收了 59 份、算出待并 59 份、提交了 aa75134、推上去了。
 * 事务官会话 20:36 起逐份读、逐份并,写进了用户文件、三个项目文件与决策记录(质量不错);
 * 它的计划是「全部并完 → 最后写台账 → 最后一次 commit」。**20:49:49 它在第 23 步中途没了**
 * (工作台那会儿重启),没报错。结果:`已并入.md` 一行都没有、并好的 6 个文件至今没提交、
 * 明天还会把同样的 59 份再列一遍给它读。Ben 验收不过。
 *
 * 教训不是「让模型别死」—— 会话随时可能断,这是常态。教训是:
 * **收尾不能指望模型活到最后**。所以这里由代码兜两件事:
 *
 * 1. **把进度写在明面上**:刷新每一家 `来自-<家>/来源.md` 顶上的状态块(memoryStatus.ts)——
 *    最近一次收了几份、并了几份、还差几份、最近一次并入是哪天。用人话,不出现指纹与英文键名。
 * 2. **把没提交的改动提交掉**:记忆路径下有未提交的改动、且**最近 10 分钟没有文件再变**
 *    (= 没人正在写)→ 一次 `chore(记忆): 收尾(接上次没写完的)`,配了远端就推。
 *
 * ## 四条纪律
 *
 * 1. **静默期在前,写状态块在后**。顺序反了,自己刚写的状态块就把「最近有没有人在写」这个判断带偏,
 *    于是永远等不到静默、永远不提交。所以:先读 `git status` 算静默 → 再刷状态块 → 再提交。
 *    只有状态块变了、别处没动的那一轮不提交,**下一轮**(10 分钟后,那时它也静下来了)顺手带上。
 * 2. **状态块没变化就一个字节都不写**。否则每 10 分钟一次空改动,一天 100 个空 commit。
 * 3. **`已并入.md` 不存在就不建**。一个空台账会被下一个人读成「并过了,什么都没并」,
 *    而事实是「还没人并」。那一行由模型写第一条时才出现(卡里 D 条)。
 * 4. **不抛**。收尾没做成不该把例程一起拖没:每一步自己 try 住,回一句人话就算尽责。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MEMORY_FAMILY_LABELS } from './agentMemory.ts'
import {
  MEMORY_DIR_REL,
  MERGED_LEDGER,
  familyDirName,
  fingerprintOf,
  latestLedgerDate,
  listCopiedMemories,
  parseMergedLedger,
} from './memoryCollect.ts'
import { collectedLineFor, collectedLineOf, memoryStamp, renderMemoryStatus, statusBlockOf, withMemoryStatus } from './memoryStatus.ts'
import type { GitExec, PushOutcome } from './routines.ts'
import { MEMORY_COMMIT_PATHS, errorNote, pushIfUpstream, pushNote, writeAtomic } from './routines.ts'

/** 「最近多久没有文件再变就算没人在写」的默认值。 */
export const CLOSEOUT_QUIET_MS = 10 * 60_000

/** 收尾那一笔的提交说明。**接上次没写完的** —— 这句话本身就是台账。 */
export const CLOSEOUT_COMMIT_MESSAGE = 'chore(记忆): 收尾(接上次没写完的)'

/** 一家的并入进度。数字口径与第 0 步算清单的那一套**完全一致**(同一个指纹比法),否则两处说的话会打架。 */
export interface FamilyProgress {
  label: string
  /** `docs/记忆/来自-<家>/来源.md`(相对仓库根)。 */
  sourceRel: string
  /** 这一家目录里现在有多少份待并的原件。 */
  total: number
  /** 其中台账里记过同一份同一个内容的。 */
  merged: number
  /** 「最近一次收」那一行(原样。由收的那一步写,收尾检查只带过去 —— memoryStatus.ts 纪律 3)。 */
  collectedLine: string
  /** 台账里最新那个日期。没有台账就 undefined。 */
  lastMergedDate?: string
}

export interface CloseoutResult {
  /** 状态块真写了的那几份 `来源.md`(相对仓库根)。没变化的不在里面。 */
  refreshed: string[]
  /** 各家的进度,给汇报与测试看。 */
  progress: FamilyProgress[]
  commit?: string
  push: PushOutcome
  /**
   * 有未提交的改动,但**还在变**(10 分钟内有人动过文件)→ 这次先不提交,等下一轮。
   * 模型正一份一份地并,半途提交没坏处但也没必要,而「刚写到一半」的判断留给静默期最省心。
   */
  waiting: boolean
  /** 一句人话。 */
  summary: string
}

export interface CloseoutInput {
  /** 记忆仓库(她的工作目录)。 */
  repo: string
  git: GitExec
  /** 现在几点(ms)。默认 Date.now —— 测试注入。 */
  now?: () => number
  /** 静默期,默认 10 分钟;测试传 0。 */
  quietMs?: number
}

/** `来源.md` 那张表列了多少份:第一格以 `.md` 结尾的行(表头与分隔行都不是)。 */
function copiedRowsOf(sourceText: string): number {
  let count = 0
  for (const line of sourceText.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const first = line.split('|')[1]?.trim().replace(/^`|`$/g, '') ?? ''
    if (first.toLowerCase().endsWith('.md')) count++
  }
  return count
}

/**
 * 算一家的进度。**没有 `来源.md` 就回 undefined** —— 状态块住在它里面,
 * 这一家还没收过,就没有门口可以贴。
 */
async function progressOf(repo: string, label: string): Promise<{ progress: FamilyProgress, sourceText: string } | undefined> {
  const dirRel = `${MEMORY_DIR_REL}/${familyDirName(label)}`
  const dir = join(repo, dirRel)
  const sourceRel = `${dirRel}/来源.md`
  const sourcePath = join(repo, sourceRel)
  const sourceText = await readFile(sourcePath, 'utf8').catch(() => undefined)
  if (sourceText === undefined) return undefined

  const files = await listCopiedMemories(dir)
  const ledgerText = await readFile(join(dir, MERGED_LEDGER), 'utf8').catch(() => undefined)
  const ledger = parseMergedLedger(ledgerText)
  let merged = 0
  for (const rel of files) {
    const body = await readFile(join(dir, rel)).catch(() => undefined)
    if (body === undefined) continue
    if (ledger.has(`${rel}\u0000${fingerprintOf(body)}`)) merged++
  }
  const lastMergedDate = latestLedgerDate(ledgerText)
  /**
   * 「最近一次收」那一行:块里已经有就**原样用**(纪律 3 —— 不能取自 `来源.md` 的 mtime,
   * 自己写一次就把它顶到现在,于是每一轮都算出新时刻、每一轮都重写)。
   * 块还没建起来(第一次)才按 `来源.md` 的 mtime 兜一个 —— 那一刻正好就是刚才收完写下它的时刻。
   */
  let collectedLine = collectedLineOf(statusBlockOf(sourceText))
  if (collectedLine === undefined) {
    const mtime = await stat(sourcePath).then(one => one.mtimeMs).catch(() => undefined)
    collectedLine = collectedLineFor(memoryStamp(new Date(mtime ?? Date.now())), copiedRowsOf(sourceText))
  }
  return {
    sourceText,
    progress: {
      label,
      sourceRel,
      total: files.length,
      merged,
      collectedLine,
      ...(lastMergedDate === undefined ? {} : { lastMergedDate }),
    },
  }
}

/** `git status --porcelain -z` 里那几个路径(相对仓库根)。读不到就空。 */
async function changedPaths(git: GitExec, repo: string): Promise<string[]> {
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...MEMORY_COMMIT_PATHS], repo)
  if (!status.ok) return []
  return status.stdout.split('\0').filter(line => line.length > 3).map(line => line.slice(3))
}

/** 这几个路径里最后被动过的那一刻(ms)。一个都 stat 不到(全是删除)就 undefined。 */
async function newestMtime(repo: string, paths: readonly string[]): Promise<number | undefined> {
  let newest: number | undefined
  for (const rel of paths) {
    // 向下取整:mtimeMs 带小数,Date.now() 是整毫秒 —— 刚写完的文件能算出「负的静默时长」。
    const mtime = await stat(join(repo, rel)).then(one => Math.floor(one.mtimeMs)).catch(() => undefined)
    if (mtime === undefined) continue
    if (newest === undefined || mtime > newest) newest = mtime
  }
  return newest
}

/**
 * 跑一次收尾检查。**幂等**:没有改动、状态块也没变化时一个文件不写、一个 commit 不产。
 */
export async function runMemoryCloseout(input: CloseoutInput): Promise<CloseoutResult> {
  const { repo, git } = input
  const nowMs = (input.now ?? Date.now)()
  const quietMs = input.quietMs ?? CLOSEOUT_QUIET_MS
  const result: CloseoutResult = { refreshed: [], progress: [], push: 'nothing', waiting: false, summary: '' }

  // 1. 先算静默:在**写状态块之前**读,否则自己的写会把「最近有人动过文件」永远顶成真(纪律 1)。
  const before = await changedPaths(git, repo)
  const newest = await newestMtime(repo, before)
  const quiet = before.length > 0 && (newest === undefined || nowMs - newest >= quietMs)

  // 2. 刷状态块:每一家一份,只在内容真变了时写(纪律 2)。
  for (const label of Object.values(MEMORY_FAMILY_LABELS)) {
    let one
    try { one = await progressOf(repo, label) }
    catch { continue }
    if (one === undefined) continue
    result.progress.push(one.progress)
    const block = renderMemoryStatus({
      collectedLine: one.progress.collectedLine,
      total: one.progress.total,
      merged: one.progress.merged,
      ...(one.progress.lastMergedDate === undefined ? {} : { lastMergedDate: one.progress.lastMergedDate }),
    })
    if (statusBlockOf(one.sourceText) === block) continue
    try {
      await writeAtomic(join(repo, one.progress.sourceRel), withMemoryStatus(one.sourceText, block))
      result.refreshed.push(one.progress.sourceRel)
    }
    catch { /* 一家写不下不该连累别家与提交那一步 */ }
  }

  // 3. 提交:静默了才提交(纪律 1)。这时把刚写的状态块一起带上(所以重读一次改动清单)。
  if (before.length === 0) result.waiting = false
  else if (!quiet) result.waiting = true
  else {
    try {
      /**
       * 路径限定用**这一刻真有改动的那几个文件**,不是 `MEMORY_COMMIT_PATHS` 本身:
       * `git add -- docs/记忆索引.md` 在还没有那份索引的仓库里是 `fatal: pathspec … did not match`,
       * 一句失败就把整趟 add 带没了(第一次跑收尾的新仓库正是这种)。改动清单来自 `git status`,
       * 本来就限定在记忆那两个路径底下 —— 别处的改动一个也进不来。
       */
      const paths = await changedPaths(git, repo)
      if (paths.length === 0) return finish(result, undefined)
      await git(['add', '--', ...paths], repo)
      const committed = await git([
        '-c', 'user.name=事务官', '-c', 'user.email=butler@workbench.local',
        'commit', '-m', CLOSEOUT_COMMIT_MESSAGE, '--', ...paths,
      ], repo)
      if (committed.ok) {
        const head = await git(['rev-parse', '--short', 'HEAD'], repo)
        if (head.ok && head.stdout.trim() !== '') result.commit = head.stdout.trim()
      }
    }
    catch { /* 提交不成如实说,不抛(纪律 4) */ }
  }

  // 4. 推:与下班例程第 7 步同一个函数、同一句话。推失败不抛(纪律 4)。
  let pushFailure: string | undefined
  if (result.commit !== undefined) {
    try {
      const pushed = await pushIfUpstream(git, repo)
      result.push = pushed.push
      pushFailure = pushed.failure
    }
    catch (error) {
      result.push = 'failed'
      pushFailure = errorNote(error)
    }
  }

  return finish(result, pushFailure)
}

/** 汇报那一句(人话)。提前 return 的那一支也走它,省得两处拼字。 */
function finish(result: CloseoutResult, pushFailure: string | undefined): CloseoutResult {
  const left = result.progress.reduce((sum, one) => sum + Math.max(0, one.total - one.merged), 0)
  const parts: string[] = []
  parts.push(result.progress.length === 0
    ? '还没有收过各家记忆,没什么要收尾的'
    : left === 0 ? '各家收来的都并完了' : `各家还差 ${left} 份没并进来`)
  if (result.refreshed.length > 0) parts.push(`${result.refreshed.length} 家的「来源.md」刷了进度`)
  if (result.waiting) parts.push('记忆目录里有没提交的改动,但刚刚还有人在写,等下一轮再提交')
  else if (result.commit !== undefined) parts.push(`把上次没提交的改动收尾提交了(commit ${result.commit})`)
  const note = pushNote(result.push, pushFailure)
  if (note !== undefined) parts.push(note)
  result.summary = parts.join(';')
  return result
}
