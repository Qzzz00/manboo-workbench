/**
 * 在这台机器上按文件名找文件(2026-09-21)。
 *
 * Ben 的原话:「几台授权过的设备的文件,我可以让事务官去找,并且做传输」。
 *
 * ## 边界,先说清楚
 *
 *   1. **只在授权目录里找**。目录由 8791 给(`GET /channel/search-roots`),
 *      它先看 `docs/记忆/授权.md` 里的 `read_scan_roots` 是不是「可以」;不是就一个目录都不给,
 *      并带一句人话 —— 那句话要原样说给他听,不能变成「没找到」。
 *   2. **只看名字和路径,不读内容**。这一版不做内容检索(任务书写死的),所以这里一个
 *      `readFile` 都没有 —— 少一条能读到内容的路,就少一种「模型把文件内容念出来」的事故。
 *   3. **隐藏文件与 `.git` 不进结果**。`.env`、`.ssh/id_rsa`、`.git/config` 里全是不该出门的东西;
 *      `node_modules` 也跳过 —— 它只会把结果淹掉。
 *   4. **有上限**。目录深度、扫过的条目数、回的条数都有顶:一次搜索不该把电话晾在那儿转三分钟。
 *
 * ## 结果是**白名单**,不是建议
 *
 * `send_file` 只许传「搜索结果里出现过的路径」(tools.ts 里那张表)。这是防模型编一条路径
 * 去读任意文件的那一道 —— 检索这一层老老实实只回它真的看见的文件。
 *
 * 这个文件里只有纯函数 + 一个走 fs 的遍历,遍历的 readdir/stat 可注入,单测不碰真磁盘。
 */
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/** 一次最多回几条。电话里念不完,多的如实说「还有 N 条」。 */
export const SEARCH_RESULT_LIMIT = 20

/** 一次最多看几个目录条目。超了就停下并如实说一句「只扫了一部分」。 */
export const SEARCH_SCAN_LIMIT = 20000

/** 从扫描根往下最多几层。再深就是别人的 node_modules 了。 */
export const SEARCH_MAX_DEPTH = 6

/** 永远不进的目录名。 */
export const SEARCH_SKIP_DIRS: readonly string[] = ['.git', 'node_modules', 'Library', '.Trash']

export interface SearchRoot {
  path: string
  /** 这个根从哪来的,一句给人看的话(「扫描根」「工作目录」)。 */
  label?: string
  depth?: number
  /**
   * 「在哪」要不要带上这个根的名字(2026-09-25,卡 J)。事务官文件夹要带(「事务官文件夹 / 收件」);
   * 扫描根不带 —— 「GitHub / desktop-workbench / docs」里那个 GitHub 他听了没用,仓库名才是他认的。
   */
  labelPrefix?: boolean
}

export interface FoundFile {
  /** 绝对路径。**只在这台机器内部流转**,传给别的设备时也带着(那边只拿它当收件人的 path 说明)。 */
  path: string
  name: string
  size: number
  /** 最后修改时间(ISO)。读不到就缺席 —— 不写一个 0。 */
  mtime?: string
  /**
   * 在哪(2026-09-25,卡 J):项目名(「desktop-workbench」),或者那个根的名字加上一两级目录
   * (「GitHub / desktop-workbench / docs」)。**电话里念的是它,不是路径**。老的对端不带就缺席。
   */
  where?: string
}

export interface SearchOutcome {
  files: readonly FoundFile[]
  /** 命中总数(可能大于 files.length)。 */
  total: number
  /** 因为到了上限而停下。界面/电话里要如实说。 */
  truncated: boolean
  /** 一个根读不到就记一条,不让整次搜索变成「失败了」。 */
  errors: readonly { root: string, reason: string }[]
}

/** 一句话 → 若干个词。空格、逗号、顿号都算分隔;去掉空的。 */
export function searchTerms(query: string): readonly string[] {
  return (query ?? '')
    .split(/[\s,,、]+/)
    .map(term => term.trim().toLowerCase())
    .filter(term => term !== '')
    .slice(0, 8)
}

/**
 * 这条路径算不算命中。**每个词都要出现**(在文件名或路径里),词之间是「而且」——
 * 他说「工作台 README」时要的是那一个文件,不是所有 README 加上所有带「工作台」的东西。
 *
 * 2026-09-25(卡 J):`searchFiles` 传进来的是**相对那个根的路径** —— 绝对路径里有
 * `/Users/example/Documents/GitHub` 这一截,「github」「documents」这种词会让所有文件都命中。
 */
export function fileMatches(path: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false
  const haystack = path.toLowerCase()
  return terms.every(term => haystack.includes(term))
}

/** 这一段路径名该不该跳过(隐藏、`.git`、`node_modules`)。 */
export function skipEntry(name: string): boolean {
  if (name.startsWith('.')) return true
  return SEARCH_SKIP_DIRS.includes(name)
}

/**
 * 看着像密钥 / 凭据的文件名(2026-09-25,卡 J)。**不找、不传** —— 与 8791 那一侧
 * (workbench-plugin/src/server/fileFetch.ts 的 SECRET_NAME)同一份。
 */
export const SECRET_FILE_NAME = /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|credentials\.json|secrets?\.(?:json|ya?ml|toml)|.*\.(?:pem|p12|pfx|key|keychain|keychain-db|kdbx))$/i

/**
 * 这条路径在不在某个根底下。**按路径段比**,不是 `startsWith` ——
 * `/a/bc` 不该因为 `/a/b` 是根就被放行(那是最经典的那一种越界)。
 */
export function withinRoots(path: string, roots: readonly string[]): boolean {
  const target = resolve(path)
  return roots.some((root) => {
    const base = resolve(root)
    if (target === base) return true
    return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
  })
}

/**
 * 这个文件**能不能传出去**。不能就回一句人话(能传就 undefined)。
 *
 * 搜索结果里本来就不会出现隐藏文件与 `.git`(见 skipEntry),这一道是**第二次**在发的那一刻再看一遍:
 * 白名单是按路径字符串比的,而路径可以从别处进来(发件目录里的文件、将来别的入口)。
 * 「不该出门的东西」这种事,拦两遍不算多。
 */
export function transferBlockReason(path: string): string | undefined {
  const segments = resolve(path).split(sep).filter(segment => segment !== '')
  for (const segment of segments) {
    if (segment.startsWith('.')) return `「${segment}」是隐藏文件或隐藏目录,不传`
    if (segment === '.git') return '`.git` 目录里的东西不传'
    if (segment === 'node_modules') return '`node_modules` 里的东西不传'
  }
  if (SECRET_FILE_NAME.test(basename(path))) return `「${basename(path)}」看着像密钥或凭据,不传`
  return undefined
}

export interface SearchDeps {
  readdirImpl?: (dir: string) => Promise<readonly { name: string, isDirectory: boolean, isFile: boolean }[]>
  statImpl?: (path: string) => Promise<{ size: number, mtimeMs: number }>
  resultLimit?: number
  scanLimit?: number
}

async function defaultReaddir(dir: string): Promise<readonly { name: string, isDirectory: boolean, isFile: boolean }[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.map(entry => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
  }))
}

/**
 * 真去走一遍。**绝不抛**:一个根没权限、一个目录读不动,都只记一条 error 接着走下一个。
 *
 * 广度优先:浅的先出。他要的多半是 `~/Documents/GitHub/某仓库/README.md`,
 * 不是某个 `vendor/` 深处同名的那一个。
 */
export async function searchFiles(
  input: {
    roots: readonly SearchRoot[]
    query: string
    /** 已经拆好的词(8791 认出项目之后剩下的那几个)。给了就不再从 query 里拆。 */
    terms?: readonly string[]
    /** 这一次整个是在某个项目里找的:「在哪」就写项目名(2026-09-25)。 */
    whereLabel?: string
  },
  deps: SearchDeps = {},
): Promise<SearchOutcome> {
  const terms = input.terms !== undefined ? input.terms.map(term => term.toLowerCase()).filter(term => term !== '') : searchTerms(input.query)
  const resultLimit = deps.resultLimit ?? SEARCH_RESULT_LIMIT
  const scanLimit = deps.scanLimit ?? SEARCH_SCAN_LIMIT
  const readdirImpl = deps.readdirImpl ?? defaultReaddir
  const statImpl = deps.statImpl ?? (async (path: string) => {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  })
  const files: FoundFile[] = []
  const errors: { root: string, reason: string }[] = []
  if (terms.length === 0) return { files: [], total: 0, truncated: false, errors: [] }

  let scanned = 0
  let total = 0
  let truncated = false
  const seen = new Set<string>()
  // 广度优先的队列。根自己就是第 0 层。
  const queue: { dir: string, depth: number, maxDepth: number, root: string, label: string, prefix: boolean }[] = input.roots.map(root => ({
    dir: resolve(root.path),
    depth: 0,
    maxDepth: root.depth ?? SEARCH_MAX_DEPTH,
    root: resolve(root.path),
    label: root.label ?? basename(resolve(root.path)),
    prefix: root.labelPrefix === true,
  }))

  while (queue.length > 0) {
    const current = queue.shift() as { dir: string, depth: number, maxDepth: number, root: string, label: string, prefix: boolean }
    if (seen.has(current.dir)) continue
    seen.add(current.dir)
    if (scanned >= scanLimit) { truncated = true; break }
    let entries: readonly { name: string, isDirectory: boolean, isFile: boolean }[]
    try { entries = await readdirImpl(current.dir) }
    catch (err) {
      // 根本身读不到才值得说一句(子目录没权限是常事,说了只是噪音)。
      if (current.depth === 0) errors.push({ root: current.dir, reason: (err as Error)?.message ?? '读不到' })
      continue
    }
    for (const entry of entries) {
      scanned += 1
      if (scanned >= scanLimit) { truncated = true; break }
      if (skipEntry(entry.name)) continue
      const full = join(current.dir, entry.name)
      if (entry.isDirectory) {
        if (current.depth + 1 <= current.maxDepth) {
          queue.push({ dir: full, depth: current.depth + 1, maxDepth: current.maxDepth, root: current.root, label: current.label, prefix: current.prefix })
        }
        continue
      }
      if (!entry.isFile) continue
      if (SECRET_FILE_NAME.test(entry.name)) continue
      const rel = relative(current.root, full)
      if (!fileMatches(rel, terms)) continue
      total += 1
      if (files.length >= resultLimit) { truncated = true; continue }
      let size = 0
      let mtime: string | undefined
      try {
        const info = await statImpl(full)
        size = info.size
        mtime = new Date(info.mtimeMs).toISOString()
      }
      catch { /* stat 读不到就只给路径:不编一个大小 */ }
      const parent = dirname(rel)
      const tail = parent === '.' ? '' : parent.split(sep).slice(0, 2).join(' / ')
      const where = input.whereLabel !== undefined
        ? (tail === '' ? input.whereLabel : `${input.whereLabel} / ${tail}`)
        : (tail === '' ? current.label : current.prefix ? `${current.label} / ${tail}` : tail)
      files.push({ path: full, name: basename(full), size, where, ...(mtime === undefined ? {} : { mtime }) })
    }
  }

  return { files: rankFound(files, terms), total, truncated, errors }
}

/**
 * 排个序(2026-09-25,卡 J):**文件名里就有全部的词**的排前面,文件名去掉扩展名正好是某个词的再往前
 * (他说「README」要的是 README.md,不是 README-旧版备份.md);其余保持广度优先的顺序(浅的在前)。
 */
export function rankFound(files: readonly FoundFile[], terms: readonly string[]): FoundFile[] {
  const nameHit = (file: FoundFile): boolean => fileMatches(file.name, terms)
  const exact = (file: FoundFile): boolean => {
    const lower = file.name.toLowerCase()
    const dot = lower.lastIndexOf('.')
    const stem = dot > 0 ? lower.slice(0, dot) : lower
    return terms.some(term => term === stem || term === lower)
  }
  return files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => {
      const na = nameHit(a.file)
      const nb = nameHit(b.file)
      if (na !== nb) return na ? -1 : 1
      const ea = exact(a.file)
      const eb = exact(b.file)
      if (ea !== eb) return ea ? -1 : 1
      return a.index - b.index
    })
    .map(entry => entry.file)
}
