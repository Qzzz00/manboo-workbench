/**
 * 各家 Agent 客户端**自己记的那些东西**,拷一份到事务官这边(2026-09-21)。
 *
 * Ben 原话:「Agent 客户端里的记忆这件事,后面在引导里要加一条进去,在已有项目那里要加,
 * 就是要不要把记忆拷贝到事务官那。」决策记录 2026-09-18 同名那一条。
 *
 * ## 三条纪律
 *
 * 1. **只读它们的,不改它们的。** 这里只有 `readdir` / `lstat` / `readFile`:
 *    不移动、不删除、不往人家目录里写一个字节。拷过来的那一份也**不解析、不改写**
 *    —— 原文一个字节不动地落到 `docs/记忆/来自-<家>/`,谁的话是谁的话。
 * 2. **拷不越界。** 每一份候选都要过 `copyTargetOf`:必须真的在声明的那个根底下、
 *    必须是 `.md`。软链一律不跟(`lstat` 判,链到别处的那一份不拷)—— 一条指向
 *    `~/Documents` 的软链能把整个文稿目录顺进仓库里。
 * 3. **查不到就写「未查到」,不猜。** 每一家都记着 `looked`(找过哪几个地方),
 *    探不到时那句话里带得出来。Kimi 这台机器上就是一份都没有(见文件末尾那张表),
 *    界面上要如实说,不许含糊成"可能没有"。
 *
 * ## 本机实测:各家记忆到底在哪(2026-09-21,只 `ls` 不读正文)
 *
 * | 家 | 在哪 | 什么格式 |
 * |---|---|---|
 * | Claude | `~/.claude/projects/<项目>/memory/`(每个项目一个);仓库根的 `CLAUDE.md` | 纯 `.md`,一份 `MEMORY.md` 当索引 + 若干单主题 md |
 * | Codex | `~/.codex/AGENTS.md`;`~/.codex/memories/`(本机是**空的**);`~/.codex/memories_*.sqlite` | 前两样 Markdown;SQLite 那份是二进制,**不拷** |
 * | Kimi | **未查到**(找过 `~/.kimi`、`~/.kimi-code`、`~/Library/Application Support/Kimi`、`kimi-desktop`;只有会话 jsonl,没有 md/memory 形态的记忆) | — |
 * | 工作台自己 | `~/.dsh/AGENTS.md` | Markdown。**探得到但不拷** —— 它本来就是事务官自己的那一份 |
 *
 * `~/.claude/CLAUDE.md` 本机不存在(全局用户级记忆文件没有),但路径留在表里:
 * 别人机器上可能有,而"没有"这件事由 `lstat` 当场回答,不写死。
 */
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { collectedLineFor, memoryStamp, restampCollected, statusBlockOf, withMemoryStatus } from './memoryStatus.ts'

export type MemoryFamily = 'claude' | 'codex' | 'kimi' | 'dsh'

/** 顺序固定:界面与那句话都按这个顺序念。 */
export const MEMORY_FAMILIES: readonly MemoryFamily[] = ['claude', 'codex', 'kimi', 'dsh']

/** 文件夹名里的那半截(`docs/记忆/来自-<这里>/`)。**不带斜杠、不带空格**。 */
export const MEMORY_FAMILY_LABELS: Readonly<Record<MemoryFamily, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  dsh: '工作台',
}

/**
 * 家 → 应用探测里的那个键(2026-09-27,卡 OB)。
 *
 * 引导「能不能读你电脑上各家 AI 记着的东西」那一问的名单要**两头都对得上**:
 * 这儿真探到了 .md 记录 **而且** 那个 App 真装着。`~/.claude/projects` 探得到而 Claude 没装
 * 是可能的(拷进来的仓库里带一份 CLAUDE.md 就够),那种情况下念「Claude」就是对着一台
 * 没装 Claude 的机器说话 —— 新 Air 上正是这么出的错。
 *
 * 工作台自己(`dsh`)没有键:它本来就不进那份名单。
 */
export const MEMORY_FAMILY_APP_KEYS: Readonly<Record<string, string | undefined>> = {
  claude: 'claude',
  codex: 'codex',
  kimi: 'kimi',
  dsh: undefined,
}

/** 一份文件最大多少字节。记忆是人写的短文,超过这个数的多半是导出的日志。 */
export const MAX_MEMORY_FILE_BYTES = 512 * 1024
/** 一家最多拷多少份。防的是某台机器上几百个项目 memory 目录一股脑进仓库。 */
export const MAX_MEMORY_FILES_PER_FAMILY = 200

/** 只收这一种扩展名。记忆是给人读的纯文本;别的(jsonl 会话、sqlite 库)都不是。 */
const MEMORY_EXT = '.md'

export interface MemorySourceFile {
  /** 原件在哪(绝对路径)。 */
  from: string
  /** 相对这一家那个根的路径 —— 也是拷过去之后在 `来自-<家>/` 底下的相对路径。 */
  rel: string
  bytes: number
}

export interface MemorySourceView {
  family: MemoryFamily
  label: string
  /** 找过哪几个地方(绝对路径,原样)。探不到时那句「未查到」要说得出找过哪儿。 */
  looked: readonly string[]
  files: readonly MemorySourceFile[]
  /** 看见了但这次没拷的,每条一句人话(SQLite、软链、太大的)。 */
  left: readonly string[]
  /** 这一家整体不拷的理由。缺席 = 照拷。 */
  skip?: string
}

/**
 * 这一份该不该拷、拷过去叫什么。**纯函数,不碰磁盘** —— 越界判断值得单独被测。
 *
 * 回 `undefined` = 不拷。三种情形:不是 `.md`、不在 `root` 底下、就是 `root` 自己。
 * 「在 root 底下」用 `relative()` 判而不是 `startsWith`:`/rootless/a.md` 以 `/root`
 * 开头,但它不在 `/root` 里 —— 字符串前缀在路径上从来不是包含关系。
 */
export function copyTargetOf(root: string, path: string): string | undefined {
  if (!path.toLowerCase().endsWith(MEMORY_EXT)) return undefined
  const rel = relative(normalize(root), normalize(path))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  if (rel.split(sep).includes('..')) return undefined
  return rel.split(sep).join('/')
}

/** 一个根:一棵目录、或者单独一份文件。 */
interface MemoryRoot {
  /** 目录根:底下的 .md 全收(递归)。 */
  dir?: string
  /** 单文件:收它自己,`rel` 就是文件名。 */
  file?: string
  /** 目录根下再展一层(Claude 的 `projects` 底下每个项目各一个 `memory`)。 */
  starThen?: string
}

export interface AgentMemoryOptions {
  home: string
  repoRoot: string
}

function rootsOf(family: MemoryFamily, opts: AgentMemoryOptions): readonly MemoryRoot[] {
  const { home, repoRoot } = opts
  switch (family) {
    case 'claude': return [
      // 每个项目一个 memory 目录。rel 里留着项目 slug,拷过去还分得清哪一份是哪个项目的。
      { dir: join(home, '.claude', 'projects'), starThen: 'memory' },
      { file: join(home, '.claude', 'CLAUDE.md') },
      { file: join(repoRoot, 'CLAUDE.md') },
    ]
    case 'codex': return [
      { file: join(home, '.codex', 'AGENTS.md') },
      { dir: join(home, '.codex', 'memories') },
    ]
    case 'kimi': return [
      { dir: join(home, '.kimi', 'memory') },
      { file: join(home, '.kimi', 'AGENTS.md') },
      { dir: join(home, 'Library', 'Application Support', 'Kimi', 'memory') },
    ]
    case 'dsh': return [
      { file: join(home, '.dsh', 'AGENTS.md') },
    ]
  }
}

/** 探到了但不拷的那几样,各说一句人话。 */
async function leftoversOf(family: MemoryFamily, opts: AgentMemoryOptions): Promise<string[]> {
  if (family !== 'codex') return []
  const dir = join(opts.home, '.codex')
  const listing = await readdir(dir).catch(() => undefined)
  if (listing === undefined) return []
  return listing
    .filter(name => /^memories.*\.sqlite$/.test(name))
    .map(name => `${join(dir, name)}:Codex 把记忆写在 SQLite 库里,那不是文本,这次没拷(要拷得先由 Codex 自己导出成文字)`)
}

/** 一棵目录下的 .md,递归收。软链、超大的、非 .md 都进 `left`。 */
async function walk(
  root: string,
  dir: string,
  files: MemorySourceFile[],
  left: string[],
): Promise<void> {
  const names = await readdir(dir).catch(() => undefined)
  if (names === undefined) return
  for (const name of [...names].sort()) {
    if (files.length >= MAX_MEMORY_FILES_PER_FAMILY) return
    const path = join(dir, name)
    // lstat 而不是 stat:软链要认出它是软链,不跟过去。
    const info = await lstat(path).catch(() => undefined)
    if (info === undefined) continue
    if (info.isSymbolicLink()) {
      if (name.toLowerCase().endsWith(MEMORY_EXT)) left.push(`${path}:是一条软链,没跟过去(链到哪儿是别人的事,不替他决定)`)
      continue
    }
    if (info.isDirectory()) { await walk(root, path, files, left); continue }
    if (!info.isFile()) continue
    const rel = copyTargetOf(root, path)
    if (rel === undefined) continue
    if (info.size > MAX_MEMORY_FILE_BYTES) {
      left.push(`${path}:${Math.round(info.size / 1024)} KB,比一份记忆该有的大得多,这次没拷`)
      continue
    }
    files.push({ from: path, rel, bytes: info.size })
  }
}

/** 单独一份文件。 */
async function one(path: string, files: MemorySourceFile[], left: string[]): Promise<void> {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined) return
  if (info.isSymbolicLink()) { left.push(`${path}:是一条软链,没跟过去`); return }
  if (!info.isFile()) return
  if (info.size > MAX_MEMORY_FILE_BYTES) {
    left.push(`${path}:${Math.round(info.size / 1024)} KB,比一份记忆该有的大得多,这次没拷`)
    return
  }
  files.push({ from: path, rel: path.split(sep).slice(-1)[0] as string, bytes: info.size })
}

/**
 * 各家记忆在这台机器上到底有哪几份。**只读**,一个字节都不写。
 *
 * 一家探不到不是错:`files` 空 + `looked` 写着找过哪儿,上层照它说「未查到」。
 */
export async function probeAgentMemories(opts: AgentMemoryOptions): Promise<MemorySourceView[]> {
  const out: MemorySourceView[] = []
  for (const family of MEMORY_FAMILIES) {
    const files: MemorySourceFile[] = []
    const left: string[] = [...await leftoversOf(family, opts)]
    const looked: string[] = []
    for (const root of rootsOf(family, opts)) {
      if (root.file !== undefined) {
        looked.push(root.file)
        await one(root.file, files, left)
        continue
      }
      const dir = root.dir as string
      looked.push(root.starThen === undefined ? dir : join(dir, '*', root.starThen))
      if (root.starThen === undefined) { await walk(dir, dir, files, left); continue }
      // `projects/*/memory`:展开那一层星号,rel 里保留项目 slug。
      const slugs = await readdir(dir).catch(() => undefined)
      if (slugs === undefined) continue
      for (const slug of [...slugs].sort()) {
        const inner = join(dir, slug, root.starThen)
        const info = await lstat(inner).catch(() => undefined)
        if (info?.isDirectory() !== true) continue
        const picked: MemorySourceFile[] = []
        await walk(inner, inner, picked, left)
        for (const file of picked) files.push({ ...file, rel: `${slug}/${file.rel}` })
      }
    }
    out.push({
      family,
      label: MEMORY_FAMILY_LABELS[family],
      looked,
      files,
      left,
      // 工作台自己那一份**探得到但不拷**:它本来就是事务官自己的记忆,
      // 拷成 `来自-工作台/AGENTS.md` 等于把同一句话在仓库里存两遍,
      // 而两份会各自走漂 —— 下一个人打开哪一份都不知道哪份算数。
      ...(family === 'dsh' ? { skip: '这一份本来就是事务官自己的(~/.dsh/AGENTS.md),不用拷' } : {}),
    })
  }
  return out
}

export interface MemoryImportFamilyResult {
  family: MemoryFamily
  label: string
  count: number
  /** 落在仓库里的哪个目录(相对仓库根)。 */
  dir: string
}

export interface MemoryImportResult {
  copied: readonly MemoryImportFamilyResult[]
  /**
   * 这一趟**真写进仓库**的那几个文件(相对仓库根)。调用方拿去 `git add`。
   *
   * 内容一个字节都没变的那几份**不在里面** —— 那不是吝啬,是因为界面上那颗按钮
   * 可以重复点:再点一次时屏幕上得说得出「这次真动了哪几份」。
   */
  written: readonly string[]
  /** `written` 里**第一次出现**的那几份(上一趟仓库里还没有)。刷新过的不算。 */
  added: readonly string[]
  /** 记忆文件里那几行索引。 */
  index: readonly string[]
  /** 探到了没拷的,原样带出来。 */
  left: readonly string[]
  /** 念给用户听的那一句。 */
  line: string
}

const MEMORY_DIR = ['docs', '记忆']

/** `来自-<家>/来源.md` 的正文。**每一份都写清原件在哪、哪天拷的**。 */
function sourceDoc(view: MemorySourceView, files: readonly MemorySourceFile[], day: string): string {
  const lines = [
    `# 来自 ${view.label} 的记忆(${day} 拷过来的)`,
    '',
    `> 这些是 ${view.label} 自己记下的东西,工作台**只读**了它们、原样拷了一份过来。`,
    '> 原件一个字没动,也没有解析改写。原文是谁的话就还是谁的话。',
    '',
    '| 这儿的文件 | 原件在哪 |',
    '|---|---|',
  ]
  for (const file of files) lines.push(`| ${file.rel} | \`${file.from}\` |`)
  if (view.left.length > 0) {
    lines.push('', '## 看见了但没拷的', '')
    for (const item of view.left) lines.push(`- ${item}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * 一份落地。**内容一样就一个字节都不写**(连 mtime 都不动),回「写了没有 / 是不是头一回」。
 *
 * 为什么不是无脑 `copyFile`:界面上那颗按钮可以重复点(2026-09-22)。
 * 无脑覆盖的话,第二次点完 45 个文件全都换了 mtime、`git status` 里一片红,
 * 而**一个字都没变** —— 于是"这次拷了什么"这个问题在仓库里再也答不出来。
 */
async function putFile(target: string, body: Buffer | string): Promise<'added' | 'updated' | 'same'> {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const old = await readFile(target).catch(() => undefined)
  if (old !== undefined && old.equals(bytes)) return 'same'
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, bytes)
  return old === undefined ? 'added' : 'updated'
}

/**
 * 拷一份过来。**覆盖写**(再拷一次就是刷新,不堆第二份),**不删**任何东西
 * —— 上一次拷过、这次源头没有了的那一份留在原地(删文件从来不是这张卡该做的事)。
 *
 * 一家一份都没有就**连目录都不建**:一个空的 `来自-Kimi/` 会被下一个人读成
 * 「拷过了,是空的」,而事实是「这台机器上压根没有」。
 */
export async function importAgentMemories(
  opts: AgentMemoryOptions & { now?: () => Date, stampNow?: () => Date },
): Promise<MemoryImportResult> {
  const day = (opts.now ?? (() => new Date()))().toISOString().slice(0, 10)
  /**
   * 「最近一次收」那一行的时刻(2026-09-27)。跟 `day` 分开取:`day` 由调用方钉在例程的「今天」,
   * 时分要的是**真的现在几点**(下班例程把 now 钉成那天的 UTC 零点,拿它当时分就全是 08:00)。
   */
  const stamp = memoryStamp((opts.stampNow ?? (() => new Date()))())
  const found = await probeAgentMemories(opts)
  const copied: MemoryImportFamilyResult[] = []
  const written: string[] = []
  const added: string[] = []
  const index: string[] = []
  const left: string[] = []

  /** 写一份并记账。`same` 的既不进 written 也不进 added。 */
  async function put(rel: string, body: Buffer | string): Promise<void> {
    const how = await putFile(join(opts.repoRoot, rel), body)
    if (how === 'same') return
    written.push(rel)
    if (how === 'added') added.push(rel)
  }

  for (const view of found) {
    left.push(...view.left)
    if (view.skip !== undefined || view.files.length === 0) continue
    const dirRel = [...MEMORY_DIR, `来自-${view.label}`].join('/')
    for (const file of view.files) {
      // 原件读进来再比一次:**读的是它,写的是同一份字节**,中间不解析、不改写。
      const body = await readFile(file.from)
      await put(`${dirRel}/${file.rel}`, body)
    }
    /**
     * `来源.md` 是**整篇重写**的,所以收尾检查写在它顶上的那块状态(2026-09-27)要在这里接回去
     * —— 否则每天一收,「并到哪了」就被抹掉一次。摘出旧的那一块原样放回同一个位置;
     * 块里的数字由收尾检查刷新,这里不算、不编。
     */
    const sourceRel = `${dirRel}/来源.md`
    const oldSource = await readFile(join(opts.repoRoot, sourceRel), 'utf8').catch(() => undefined)
    const block = restampCollected(statusBlockOf(oldSource), collectedLineFor(stamp, view.files.length))
    await put(sourceRel, withMemoryStatus(sourceDoc(view, view.files, day), block))
    copied.push({ family: view.family, label: view.label, count: view.files.length, dir: dirRel })
    index.push(`- ${view.label}:${view.files.length} 份,拷在 [${dirRel}](${`来自-${view.label}`}/来源.md)(${day})`)
  }

  const none = found
    .filter(view => view.skip === undefined && view.files.length === 0)
    .map(view => view.label)
  const parts: string[] = []
  if (copied.length > 0) parts.push(`拷过来了:${copied.map(one => `${one.label} ${one.count} 份`).join('、')}`)
  if (none.length > 0) parts.push(`${none.join('、')} 在这台电脑上没找到记忆文件`)
  if (left.length > 0) parts.push(`另有 ${left.length} 样看见了没拷(见各家的「来源.md」)`)
  return {
    copied,
    written,
    added,
    index,
    left,
    line: parts.length === 0 ? '这台电脑上没找到别家的记忆文件。' : `${parts.join(';')}。`,
  }
}
