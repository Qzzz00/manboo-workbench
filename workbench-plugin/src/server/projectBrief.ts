/**
 * 已有项目拉齐:读一个项目、拼一份**有上限**的摘要(2026-09-24,维护者 12:40:
 * 「我真的很需要她能扫仓库啊,不然我还得口述一遍吗……新点子是需要梳理的,已有的,得迅速拉齐到同一认知界面啊」)。
 * 设计:docs/设计-已有项目拉齐-2026-09-24.md 第三~五节;交接:docs/交接-0924-已有项目拉齐.md。
 *
 * 引导 ②′ 已有项目那一段,她拿到「读目录」的点头之后**自己找、自己读**,用两句话复述「做什么、给谁、现在到哪」请他纠正。
 * 电话工人(`read_project` / `scan_projects`)与电脑上的 DSH 会话(curl)拿的是**同一份摘要、同一段 note** ——
 * 话术只写在这里一处({@link BRIEF_NOTE} / {@link READ_CONSENT_NOTE}),两条路的差别只剩「工具还是 curl」。
 *
 * 按这个顺序拼,每段标出处(她据此说一句「我读了说明和最近的交接」):
 *   1. 说明:README(中文版优先)前 {@link README_LIMIT} 字;没有就 CLAUDE.md / AGENTS.md 开头;再没有就 package.json 的 description;
 *   2. 最近的总纲 / 设计:最近提交里动过、名字像设计的最新一份,前 {@link DESIGN_LIMIT} 字;
 *   3. 现在到哪:最近提交里动过、名字像交接的最新一份,{@link HANDOFF_LIMIT} 字以内(「现在到哪」「下一步」两节优先);
 *   4. 决策记录末尾 {@link DECISION_TITLES} 节的标题;
 *   5. 最近 {@link COMMIT_COUNT} 条提交标题(带「几天前」)、当前分支、还有几处没提交。
 *
 * 纪律:
 *   - **只读**:不写项目区缓存、不写记忆;git 只跑 `log` / `status --porcelain` / `rev-parse`,
 *     一律带 `-c core.quotepath=false`(中文文件名,09-23 踩过),status 带 `--no-optional-locks`(连索引都不刷)。
 *   - **路径只认三类**({@link resolveBriefPath}):扫描根之下、项目区录过的、这一次找到过的;`..`、符号链接跳出、不存在的一律拒;
 *     每个要读的文件再核一次真实路径还在仓库里。
 *   - **不读**代码、`.env*`、名字像密钥的文件、node_modules、二进制;读到的行里**像密钥的整行抹掉**。
 *   - **有上限**:一次约 {@link BRIEF_LIMIT} 字;每条 git {@link GIT_TIMEOUT_MS}ms、整份 {@link BRIEF_TIMEOUT_MS}ms;
 *     没读到的那一段如实写「没读到」,不补一句空话(D13)。
 *   - 「最近动过」按 **git 历史**排,不按文件修改时间(克隆下来的仓库修改时间都一样)。
 *   - 摘要只进这一通电话 / 这一条会话的上下文,**不落盘**;记下来的是他点过头的那几句(阶段机照旧写项目文件)。
 *
 * I/O 全部注入({@link BriefIo}):用例用假的,或者 mkdtemp 出来的临时仓库;生产用 {@link nodeBriefIo}。
 * 门(`read_scan_roots` 授权、新点子 / 运营那一支不读)在 http.ts,与 `/onboarding/scan` 同一道。
 *
 * 2026-09-24 下午小修(卡 fix/project-brief-polish,统筹真机自验发现的三处):
 *   - 别读两遍:同一个 path {@link BRIEF_REUSE_MS} 以内再读直接回上一份({@link createBriefReuse},http.ts 用);
 *   - 出处写对:他那句是不是只是点头({@link confirmsOnly}),阶段机据此给读了仓库、他点头之后记的那几句标「读仓库说明,他确认」;
 *   - 改口重问别说过程话:两段 note 里写「直接照那句问」,不再写「再问一遍」。
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { maxVersion, staleVersionOf } from './materialize.ts'

/** 一份摘要最多多少字(拼好之后的总长,含小标题)。 */
export const BRIEF_LIMIT = 3500
/** 说明那一段最多多少字。 */
export const README_LIMIT = 1500
/** 最近的总纲 / 设计那一段最多多少字。 */
export const DESIGN_LIMIT = 600
/** 最近的交接那一段最多多少字。 */
export const HANDOFF_LIMIT = 1200
/** 决策记录末尾取几节的标题。 */
export const DECISION_TITLES = 3
/** 念几条最近的提交标题。 */
export const COMMIT_COUNT = 10
/** 一条提交标题最多留多少字(十条都要进,长的截短)。 */
export const COMMIT_SUBJECT_LIMIT = 56
/** 每条 git 命令最多等多久。 */
export const GIT_TIMEOUT_MS = 3_000
/** 整份摘要最多等多久(到点没读完的那几段写「没读到」)。 */
export const BRIEF_TIMEOUT_MS = 5_000
/** 「最近动过」往回看多少个提交。 */
export const HISTORY_COMMITS = 300
/**
 * 挑「最近的交接」时的窗口(秒):最新那份交接之前这么久以内动过的交接里,**讲现状的那份优先**
 * (既有「现在到哪 / 进展」一节、又有「下一步 / 接下来」一节)。一个仓库里常常同一天有好几份交接(每张卡一份),
 * 最新动过的那份多半只讲那张卡怎么做的,不讲整个项目到哪了。
 * 窗口外的不去翻 —— 宁可用最新那份,也不拿一份三天前的现状冒充现在。
 */
export const HANDOFF_WINDOW_SEC = 2 * 86400
/** 这一次引导里找到过的路径记多久(按名字 / 路径找、扫描回过的)。「读过摘要」给出处用,也记这么久。 */
export const SURFACED_TTL_MS = 30 * 60 * 1000
/**
 * 同一个 path 多久之内再读,直接回上一份(2026-09-24 下午小修「别读两遍」):不再跑 git、不再读文件。
 * 找到时顺手读过一次,她紧接着又调 project-brief 读同一个 —— 那一两秒是白等的。
 */
export const BRIEF_REUSE_MS = 60_000
/** 单个文件最多读多大(再大就当读不了;说明、交接、决策记录都远小于它)。 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

/**
 * 读目录的那一问(维护者 09-24 拍板,确认点 1:授权问一句就够,仍记 `read_scan_roots`,不另加一问)。
 * 以前是「……只看名字,可以吗?」—— 读内容已经超出那句承诺,不改问句就去读等于食言。
 * **与 channel-worker/src/onboarding.ts 的 `ASK_TO_READ` 逐字相同**(用例对一遍)。
 * 凭据门(onboardingConsent.ts)认它:问句里有「目录」「放代码」「看一眼」「读」,末尾是问号。
 */
export const ASK_TO_READ = '为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?'

/**
 * 还没有「读目录」授权时回包里的那段用法(403,`reason: 'consent'`)。工人原样交给模型,DSH 会话照它做。
 * 含「他说不可以」与「他后来改口」两条:凭据门要的是「问出口 + 他点头」,改口也得先问一句,409 才是 0。
 *
 * 改口那一问**直接照那句问**(2026-09-24 下午小修):以前这里写「照上面那句再问一遍」,
 * 统筹真机上她就说成「好,那我再问一遍确认:……」—— 把过程话念给了他。这段里不再出现那几个字。
 */
export const READ_CONSENT_NOTE
  = '还没有读目录的授权,所以没找也没读。**先问后看**:先问他一句'
    + `「${ASK_TO_READ}」,`
    + '**等他说可以**,再把 read_scan_roots 记成可以(true),然后再去找、去读;没问之前一个目录都不看。'
    + '他说不可以:应一句就过去,改成问他,别再提读目录。'
    + '他后来改口说「你去看吧」「你自己读吧」:**直接照上面那句问他**,像头一回问那样,不提前面问过,也不说「确认一下」这类话;'
    + '他答了可以再记、再读 —— 不能拿他那句顺口话直接记。'
    + '别先看了再补一句「顺手记成可以了」。'

/**
 * 读好了之后的那段用法(200 回包的 `note`)。**话术只写这一处**:工人把它原样交给模型,
 * DSH 会话从 curl 的回包里拿到同一段(用例钉住两条路一字不差)。
 *
 * 开头那句「不用再读一遍」(2026-09-24 下午小修):电脑那条路找到时回包里已经带了摘要,
 * 她又调了一次 project-brief,8791 日志「读项目」两次、多一两秒。
 */
export const BRIEF_NOTE = [
  '上面是从他仓库里读来的素材(不是结论),只在这一次对话里用,不落盘。'
  + '**已经读好了,同一个项目不用再读一遍**(不用再调 project-brief / read_project;他后来说「你再看看」才再读)。照下面说:',
  '1. 一次说完:找到了哪个(名字里的连字符念成空格),读了哪几份(说「说明」「最近的交接」这种叫法,不念文件名);'
  + '再用两句以内复述:它是做什么的、给谁用;现在做到哪了。最后只问一句「是这个吗?」',
  '2. 他点头或纠正之后才记 project:one_liner、status、next_step 用他认可的说法,path 原样带上(project.path);他纠正的以他为准。',
  '3. 之后只问文档里没有的(比如截止日、卡在哪、谁一起做);摘要里写着的别再问他,也不问「你手上有哪些事」。',
  '4. 交接里写着的下一步由你念出来(最多三条,一句话),问他先做哪个;他排了先后,再照他的顺序往下。'
  + '标了「可能过时」的(提到的版本比仓库现在旧、或最近提交里像是做完了)**别直接排进方案**,先问他一句还要不要。',
  '5. 不念路径、文件名、提交号、分支名、链接;日期和数字照摘要说,摘要里没有的不编。',
  '6. 摘要和他说的对不上就指出来,以他说的为准;哪一段写着「没读到」就如实说没读到,别替它补。',
  `7. 他改口说「别读了」「不用看」:停下,别再读,改成问他;之后他又说「你去看吧」,直接照「${ASK_TO_READ}」问他`
  + '(像头一回问那样,不提前面问过,也不说「确认一下」这类话),他答了再记、再读。',
].join('\n')

/** 新点子 / 运营那一支来找、来读(403,`reason: 'branch'`)。那一支本来就没有找项目这一步(设计第五节)。 */
export const BRANCH_REFUSAL
  = '这一段是新点子 / 账号那一支:不找也不读他的目录。照梳理接着问,别提读仓库、看目录这件事。'

// ———————————————————————— I/O ————————————————————————

export interface BriefExec {
  ok: boolean
  stdout: string
  /** 超时被掐掉的(与「git 说失败」分开,摘要里说法不一样)。 */
  timedOut?: boolean
}

export interface BriefIo {
  /** 读一个文件(utf8)。读不了就抛(不存在、太大、不是文件)。 */
  readFile: (path: string) => Promise<string>
  /** 一个目录下的名字(不是路径)。不是目录就抛。 */
  listDir: (dir: string) => Promise<string[]>
  /** 真实路径(解开符号链接)。不存在就抛。 */
  realpath: (path: string) => Promise<string>
  /** 在 cwd 里跑 `git <args>`,最多等 timeoutMs。失败不抛,回 ok:false。 */
  exec: (args: readonly string[], cwd: string, timeoutMs: number) => Promise<BriefExec>
  /** 现在(毫秒)。 */
  now: () => number
}

/** 生产用的真 I/O。git 带 `GIT_OPTIONAL_LOCKS=0`(status 不刷索引)与 `GIT_TERMINAL_PROMPT=0`(永不等输入)。 */
export function nodeBriefIo(): BriefIo {
  return {
    async readFile(path) {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('不是文件')
      if (info.size > MAX_FILE_BYTES) throw new Error('文件太大')
      const buffer = await readFile(path)
      if (buffer.subarray(0, 8000).includes(0)) throw new Error('二进制文件')
      return buffer.toString('utf8')
    },
    listDir: async dir => await readdir(dir),
    realpath: async path => await realpath(path),
    exec: async (args, cwd, timeoutMs) => await new Promise<BriefExec>((resolve) => {
      execFile('git', [...args], {
        cwd,
        timeout: Math.max(1, timeoutMs),
        killSignal: 'SIGKILL',
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      }, (error, stdout) => {
        if (error !== null) {
          resolve({ ok: false, stdout: '', ...((error as { killed?: boolean }).killed === true ? { timedOut: true } : {}) })
          return
        }
        resolve({ ok: true, stdout: String(stdout) })
      })
    }),
    now: () => Date.now(),
  }
}

// ———————————————————————— 路径 ————————————————————————

function normalizeAbs(path: string): string {
  const parts = path.split('/').filter(part => part !== '' && part !== '.')
  return `/${parts.join('/')}`
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home}${path.slice(1)}`
  return path
}

function underOrEqual(child: string, parent: string): boolean {
  return child === parent || strictlyUnder(child, parent)
}

function strictlyUnder(child: string, parent: string): boolean {
  if (parent === '/') return child !== '/'
  return child.startsWith(`${parent}/`)
}

function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

/** 哪些目录能读:扫描根(之下)、项目区录过的、这一次找到过的(等于或之下)。 */
export interface BriefScope {
  /** 展开 `~` 用。 */
  home: string
  /** 此刻生效的扫描根(绝对路径)。 */
  roots: readonly string[]
  /** 项目区已经录了的仓库路径(projects.json 的 repoPath)。 */
  known: readonly string[]
  /** 这一次进程里按名字 / 路径找到过、扫描回过的(30 分钟内)。 */
  surfaced: readonly string[]
}

export type BriefPathVerdict =
  | { ok: true, path: string, real: string }
  | { ok: false, status: 400 | 403 | 404, reason: 'invalid' | 'dotdot' | 'outside' | 'missing', error: string }

/**
 * 他 / 模型交上来的 path → 能不能读、真实路径是什么。
 *
 * - 要绝对路径(`~` 展开);有 `..` 段的直接拒(哪怕解出来还在根下 —— 不陪它绕);
 * - 解开符号链接之后:在某个扫描根**之下**(扫描根本身不算),或者等于 / 在「录过的」「找到过的」之下
 *   (后两类还要字面上也在它之下:只认那一条路径本身,不认借着它的链接跳到别处);
 * - 不存在、不是目录 → 404。
 */
export async function resolveBriefPath(
  raw: unknown,
  scope: BriefScope,
  io: Pick<BriefIo, 'realpath' | 'listDir'>,
): Promise<BriefPathVerdict> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, status: 400, reason: 'invalid', error: 'path 要一个目录的绝对路径(找项目时回包里的那个 path 原样填)' }
  }
  const text = expandHome(raw.trim(), scope.home)
  if (!text.startsWith('/')) {
    return { ok: false, status: 400, reason: 'invalid', error: 'path 要绝对路径(找项目时回包里的那个 path 原样填),不认相对路径' }
  }
  if (text.split('/').includes('..')) {
    return { ok: false, status: 400, reason: 'dotdot', error: '路径里不能有「..」:只读找项目时回的那个路径本身' }
  }
  const path = normalizeAbs(text)
  let real: string
  try { real = normalizeAbs(await io.realpath(path)) }
  catch { return { ok: false, status: 404, reason: 'missing', error: `这个目录不存在:${path}` } }
  try { await io.listDir(real) }
  catch { return { ok: false, status: 404, reason: 'missing', error: `这不是一个能读的目录:${path}` } }

  const realOf = async (entry: string): Promise<string | undefined> => {
    try { return normalizeAbs(await io.realpath(normalizeAbs(expandHome(entry, scope.home)))) }
    catch { return undefined }
  }
  for (const root of scope.roots) {
    const rootReal = await realOf(root)
    if (rootReal !== undefined && strictlyUnder(real, rootReal)) return { ok: true, path, real }
  }
  for (const entry of [...scope.known, ...scope.surfaced]) {
    const lexical = normalizeAbs(expandHome(entry, scope.home))
    if (!underOrEqual(path, lexical)) continue
    const entryReal = await realOf(entry)
    if (entryReal !== undefined && underOrEqual(real, entryReal)) return { ok: true, path, real }
  }
  return {
    ok: false,
    status: 403,
    reason: 'outside',
    error: '这个目录不在能读的范围里:只读扫描根下面的、项目区里录过的、这次找项目时找到过的。',
  }
}

/** 这一次引导里找到过的路径(按名字 / 路径找、扫描回过的),记 {@link SURFACED_TTL_MS}。只在这个进程里,不落盘。 */
export interface SurfacedPaths {
  add: (paths: readonly string[]) => void
  list: () => string[]
}

export function createSurfacedPaths(options: { now?: () => number, ttlMs?: number } = {}): SurfacedPaths {
  const now = options.now ?? (() => Date.now())
  const ttl = options.ttlMs ?? SURFACED_TTL_MS
  const until = new Map<string, number>()
  return {
    add(paths) {
      const at = now() + ttl
      for (const path of paths) {
        if (typeof path === 'string' && path.startsWith('/')) until.set(normalizeAbs(path), at)
      }
    },
    list() {
      const at = now()
      for (const [path, expires] of until) if (expires <= at) until.delete(path)
      return [...until.keys()]
    },
  }
}

/**
 * 「是不是同一个目录」的比对键:`~` 展开、多余的 `/` 与 `.` 段去掉(与 {@link resolveBriefPath} 给的 `path` 同一个写法)。
 * 不是绝对路径、带 `..` 的一律 undefined —— 这种本来就读不成,也就谈不上「刚读过」。不碰磁盘。
 */
export function briefPathKey(raw: unknown, home: string): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const text = expandHome(raw.trim(), home)
  if (!text.startsWith('/') || text.split('/').includes('..')) return undefined
  return normalizeAbs(text)
}

// ———————————————————————— 读什么、不读什么 ————————————————————————

const DOC_EXT = /\.(md|markdown|mdx|txt|rst|adoc|org)$/i
const BARE_DOC = /^(changelog|todo|roadmap|history|notes|progress|status)$/i
const SKIP_SEGMENT = /^(node_modules|vendor|dist|build|out|target|coverage|third_party|bower_components)$/i
/** 名字像凭据的一律不读(连文件名带目录名一起看)。宁可少读一份,不碰一次密钥。 */
const SECRETISH = /(^|[^a-z])env([^a-z]|$)|secret|credential|passw|token|apikey|api[_-]key|(^|[^a-z])keys?([^a-z]|$)|private|密钥|密码|凭据|凭证|口令|私钥|证书/i

/** 这个(仓库里的相对)路径能不能当文档读:文档类扩展名、不在隐藏 / 依赖 / 产物目录里、名字不像凭据。 */
export function readableDoc(file: string): boolean {
  const parts = file.split('/').filter(Boolean)
  if (parts.length === 0) return false
  if (parts.some(part => part.startsWith('.') || SKIP_SEGMENT.test(part))) return false
  if (SECRETISH.test(file)) return false
  const base = parts.at(-1) as string
  return DOC_EXT.test(base) || BARE_DOC.test(base)
}

export type BriefDocKind = 'design' | 'handoff' | 'decisions'

const HANDOFF_STRONG = /交接|handoff|hand-off/i
const DECISION = /决策|decision|(^|[^a-z])adrs?([^a-z]|$)/i
const DESIGN = /总纲|审视|需求|设计|design|roadmap|(^|[^a-z])prd([^a-z]|$)|(^|[^a-z])specs?([^a-z]|$)/i
const HANDOFF_WEAK = /进展|进度|计划|progress|changelog|(^|[^a-z])status([^a-z]|$)|(^|[^a-z])todo([^a-z]|$)/i

/**
 * 按名字归类(设计第四节):交接 > 决策 > 设计 > 进度类的弱词。
 * 「设计-扫描进度.md」算设计(强词先认),「进度.md」算交接。
 */
export function docKindOf(file: string): BriefDocKind | undefined {
  if (!readableDoc(file)) return undefined
  if (HANDOFF_STRONG.test(file)) return 'handoff'
  if (DECISION.test(file)) return 'decisions'
  if (DESIGN.test(file)) return 'design'
  if (HANDOFF_WEAK.test(file)) return 'handoff'
  return undefined
}

/** git log 里的一条「这个文件在这个时刻被动过」。 */
export interface Touched { file: string, at: number }

/**
 * `git log --name-only --format=%x1e%ct` → 每个文件最近一次被动的时刻,新的在前。
 * 同一个提交里动了好几份的,名字大的排前(交接 / 设计的文件名里多半带日期,大的新)。
 */
export function parseHistory(stdout: string): Touched[] {
  const seen = new Set<string>()
  const out: Touched[] = []
  for (const record of stdout.split('\x1E')) {
    const lines = record.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (lines.length === 0) continue
    const at = Number(lines[0])
    if (!Number.isFinite(at)) continue
    for (const file of lines.slice(1)) {
      if (seen.has(file)) continue
      seen.add(file)
      out.push({ file, at })
    }
  }
  // 新的在前;同一刻(同一个提交)里名字大的在前。按码点比,不随系统语言漂。
  return out.sort((a, b) => (b.at - a.at) || (a.file < b.file ? 1 : a.file > b.file ? -1 : 0))
}

// ———————————————————————— 清洗 ————————————————————————

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)[A-Z ]*-----/,
  // 「名字 = 值」:值要像一把真钥匙(≥ 6 位字母数字符号)。文档里写「`?token=`」「令牌 = `用户名.到期`」这种讲做法的不算。
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token)\b\s*["']?\s*[:=\uFF1A]\s*["']?[\w\-./+=]{6,}/i,
  /(密码|密钥|口令|令牌|私钥)\s*[:=\uFF1A]\s*["']?[\w\-./+=]{6,}/,
  // 一长串字母数字混排(≥ 40 位、不带连字符):多半是钥匙或整串哈希,念出来也没用。
  /(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])\b[A-Za-z0-9_]{40,}\b/,
]

/**
 * 像密钥的**整行抹掉**(设计第四节)。私钥块从 BEGIN 到 END 整段抹。回抹掉了几行,摘要里如实说一句。
 */
export function scrubSecrets(text: string): { text: string, removed: number } {
  const kept: string[] = []
  let removed = 0
  let inKeyBlock = false
  for (const line of text.split('\n')) {
    if (inKeyBlock) {
      removed += 1
      if (/-----END [A-Z0-9 ]*-----/.test(line)) inKeyBlock = false
      continue
    }
    if (/-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)[A-Z ]*-----/.test(line)) {
      removed += 1
      if (!/-----END [A-Z0-9 ]*-----/.test(line)) inKeyBlock = true
      continue
    }
    if (SECRET_PATTERNS.some(pattern => pattern.test(line))) { removed += 1; continue }
    kept.push(line)
  }
  return { text: kept.join('\n'), removed }
}

/** 行内的 Markdown → 念得出来的字:图片 / 徽章 / HTML 去掉,链接只留字,行内代码去反引号,加粗去星号,裸链接换成「(链接)」。 */
export function cleanInline(line: string): string {
  return line
    .replace(/<!--[\s\S]*?-->/g, '')
    // 只去真 HTML 标签(标签名是英文字母);文档里「<名>」「<工作目录>」这种占位写法留着。
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(\s[^<>\n]*)?\/?>/g, '')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/https?:\/\/[^\s)\u300D\u300F,\uFF0C\u3002;\uFF1B]+/g, '(链接)')
    .replace(/[ \t]+$/g, '')
}

/**
 * 一段 Markdown → 念得出来的正文(设计第四节「去掉」那一条):代码块换成「(代码略)」,
 * 标题去井号、引用去 `>`、表格去竖线、分隔线与链接定义去掉,空行并成一行。
 */
export function cleanMarkdown(text: string): string {
  const out: string[] = []
  let fence: string | undefined
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(raw)?.[1]
    if (fence !== undefined) {
      if (fenceMark !== undefined && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = undefined
      continue
    }
    if (fenceMark !== undefined) {
      fence = fenceMark
      if (out.at(-1) !== '(代码略)') out.push('(代码略)')
      continue
    }
    if (/^\s*\[[^\]]+\]:\s*\S+/.test(raw)) continue
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) continue
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(raw)) continue
    let line = raw.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').replace(/^\s{0,3}>\s?/, '')
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()).filter(cell => cell !== '').join(' · ')
    }
    line = cleanInline(line)
    if (line.trim() === '' && (out.length === 0 || out.at(-1) === '')) continue
    out.push(line.trim() === '' ? '' : line)
  }
  while (out.at(-1) === '') out.pop()
  return out.join('\n')
}

/** 截到 limit 个字符以内(按码点,不劈开一个字);截了就以「…」结尾。 */
export function clip(text: string, limit: number): string {
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  if (limit <= 1) return limit <= 0 ? '' : '…'
  return `${chars.slice(0, limit - 1).join('').trimEnd()}…`
}

function charCount(text: string): number {
  return Array.from(text).length
}

/** 「几天前」(按 git 历史的秒数)。 */
export function ageText(atSec: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000 - atSec))
  if (seconds < 10 * 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  const days = Math.floor(seconds / 86400)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (days < 30) return `${Math.floor(days / 7)} 周前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

interface Section { heading: string, level: number, body: string[] }

/** 按标题切段(代码块里的 `#` 不算标题)。第一个标题之前的算一段无标题的。 */
function sectionsOf(text: string): Section[] {
  const sections: Section[] = [{ heading: '', level: 0, body: [] }]
  let fence: string | undefined
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence !== undefined) {
      if (fenceMark !== undefined && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = undefined
      ;(sections.at(-1) as Section).body.push(line)
      continue
    }
    if (fenceMark !== undefined) fence = fenceMark
    const heading = fence === undefined ? /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (heading !== null) {
      sections.push({ heading: (heading[2] as string).trim(), level: (heading[1] as string).length, body: [] })
      continue
    }
    ;(sections.at(-1) as Section).body.push(line)
  }
  return sections
}

// 不收光秃秃的「现在」:「屏上现在是什么样」讲的是界面,不是项目到哪了。
const NOW_HEADING = /到哪|现状|进展|进度|近况|状态|status|progress|where we are/i
const NEXT_HEADING = /下一步|接下来|待办|要做|todo|next/i
const LIST_ITEM = /^\s{0,3}([-*+]|\d+[.)、])\s+/

/**
 * 交接那一段:「现在到哪」与「下一步」两节优先(下一步只取每一条的第一行),
 * 都找不到就取开头。她要拿「下一步」念给他排先后。
 */
export function handoffExcerpt(raw: string, limit = HANDOFF_LIMIT, current?: string): string {
  const sections = sectionsOf(raw)
  const title = sections.find(section => section.level === 1)?.heading
  // 只认二级及以下的小节:一级标题是整份的题目(「# 进展」那种整份就是交接,取开头)。
  const now = sections.find(section => section.level >= 2 && NOW_HEADING.test(section.heading))
  const next = sections.find(section => section.level >= 2 && NEXT_HEADING.test(section.heading) && section !== now)
  if (now === undefined && next === undefined) return clip(cleanMarkdown(raw), limit)
  const parts: string[] = []
  if (title !== undefined) parts.push(cleanInline(title))
  if (now !== undefined) {
    const body = cleanMarkdown(now.body.join('\n'))
    parts.push(`${cleanInline(now.heading)}:\n${clip(body, Math.floor(limit * (next === undefined ? 0.9 : 0.45)))}`)
  }
  if (next !== undefined) {
    // 只取最外层那几条的第一行(子条目、续行都不要):她要念的是「先 A、再 B」,不是 A 的细节。
    const listed = next.body.filter(line => LIST_ITEM.test(line))
    const indent = (line: string): number => (/^\s*/.exec(line)?.[0] ?? '').length
    const outer = listed.length === 0 ? 0 : Math.min(...listed.map(indent))
    const items = listed.filter(line => indent(line) === outer).map((line) => {
      const item = clip(cleanInline(line.trim()), 110)
      // 2026-09-24 晚(卡 feat/onboarding-materialize):中午那份交接里的「查 0.2.80……」到晚上仓库已经 0.2.83 了,
      // 她照念、他照点头,看板上就多了两条过时的活。提到的版本比仓库现在旧的标一句,她先问他还要不要。
      const old = staleVersionOf(line, current)
      return old === undefined ? item : `${item}〔可能过时:提到 ${old},现在已经 ${current as string}〕`
    })
    const body = items.length > 0 ? items.join('\n') : cleanMarkdown(next.body.join('\n'))
    parts.push(`${cleanInline(next.heading)}:\n${body}`)
  }
  return clip(parts.join('\n'), limit)
}

/** 这份交接是不是讲现状的那种:既有「到哪 / 进展 / 状态」一节,又有「下一步 / 接下来 / 待办」一节(都是二级及以下)。 */
export function isStatusHandoff(raw: string): boolean {
  const sections = sectionsOf(raw).filter(section => section.level >= 2)
  const now = sections.find(section => NOW_HEADING.test(section.heading))
  return now !== undefined && sections.some(section => section !== now && NEXT_HEADING.test(section.heading))
}

/** 决策记录末尾那几节的标题(二级标题优先;一个都没有就用任意级)。 */
export function lastHeadings(raw: string, count = DECISION_TITLES): string[] {
  // 整份扫(不从中间切:切在代码块里面,后面的标题全会被当成代码)。4MB 以内几十毫秒。
  const sections = sectionsOf(raw).filter(section => section.level > 0)
  const level2 = sections.filter(section => section.level === 2)
  const pick = (level2.length > 0 ? level2 : sections).slice(-count)
  return pick.map(section => clip(cleanInline(section.heading), 90))
}

// ———————————————————————— 拼 ————————————————————————

export interface BriefSource {
  kind: 'readme' | 'design' | 'handoff' | 'decisions' | 'commits'
  /** 她说「我读了……」时用的叫法。 */
  label: string
  /** 仓库里的相对路径(给人核对用;她不念)。 */
  file?: string
  /** 最近一次被提交动过是多久以前。 */
  age?: string
}

export interface ProjectBrief {
  name: string
  path: string
  /** 念给模型看的那份摘要(≤ {@link BRIEF_LIMIT} 字)。 */
  brief: string
  sources: BriefSource[]
  /** 没读到的那几段,人话(「最近的提交(git 超时)」)。 */
  missing: string[]
  /** 抹掉了几行像密钥的。 */
  redacted: number
  /** 是不是在一个 git 仓库的根上读的。 */
  git: boolean
}

export interface ReadBriefOptions {
  limit?: number
  gitTimeoutMs?: number
  deadlineMs?: number
}

interface DocPick { file: string, text: string, age?: string }

/**
 * 读一个项目 → 摘要。`root` 是 {@link resolveBriefPath} 给的真实路径(已经过了白名单),
 * `path` 是给人看的那条(找项目时回的原样),`name` 是项目名(目录名)。
 */
export async function readProjectBrief(
  input: { root: string, path: string, name: string },
  io: BriefIo,
  options: ReadBriefOptions = {},
): Promise<ProjectBrief> {
  const limit = options.limit ?? BRIEF_LIMIT
  const gitTimeout = options.gitTimeoutMs ?? GIT_TIMEOUT_MS
  const deadline = io.now() + (options.deadlineMs ?? BRIEF_TIMEOUT_MS)
  const root = input.root
  const missing: string[] = []
  let redacted = 0

  /** 一条 git:`-c core.quotepath=false` 打头;每条最多 gitTimeout,整份到点就不再跑。自己也兜一层超时(I/O 不守时也不拖垮整份)。 */
  const git = async (args: readonly string[]): Promise<BriefExec> => {
    const left = Math.min(gitTimeout, deadline - io.now())
    if (left <= 0) return { ok: false, stdout: '', timedOut: true }
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<BriefExec>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, stdout: '', timedOut: true }), left + 50)
      ;(timer as { unref?: () => void }).unref?.()
    })
    try {
      return await Promise.race([
        io.exec(['-c', 'core.quotepath=false', ...args], root, left).catch(() => ({ ok: false, stdout: '' })),
        guard,
      ])
    }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }

  /** 读仓库里的一个相对路径:真实路径必须还在仓库里;二进制不要。读不了回 undefined。 */
  const readInside = async (rel: string): Promise<string | undefined> => {
    try {
      const real = normalizeAbs(await io.realpath(`${root}/${rel}`))
      if (!strictlyUnder(real, root)) return undefined
      const text = await io.readFile(real)
      if (text.includes('\u0000')) return undefined
      const scrubbed = scrubSecrets(text)
      redacted += scrubbed.removed
      return scrubbed.text
    }
    catch { return undefined }
  }

  // 0) 是不是 git 仓库的根。不是(或 git 超时)就只读说明,其余如实说。
  let isGit = false
  let gitWhy = ''
  const top = await git(['rev-parse', '--show-toplevel'])
  if (top.ok) {
    let topReal = ''
    try { topReal = normalizeAbs(await io.realpath(top.stdout.trim())) }
    catch { topReal = '' }
    isGit = topReal === root
    if (!isGit) gitWhy = '这个目录不是一个 git 仓库的根'
  }
  else gitWhy = top.timedOut === true ? 'git 超时' : '这个目录不是 git 仓库'

  // 1) git 那几条并排跑(整份 5 秒的上限按最慢那条算,不是加起来)。
  const [history, commits, branch, status] = isGit
    ? await Promise.all([
        git(['log', `-n${HISTORY_COMMITS}`, '--no-merges', '--diff-filter=d', '--name-only', '--relative', '--format=%x1e%ct']),
        git(['log', `-n${COMMIT_COUNT}`, '--no-merges', '--format=%ct%x09%s']),
        git(['rev-parse', '--abbrev-ref', 'HEAD']),
        git(['--no-optional-locks', 'status', '--porcelain']),
      ])
    : [undefined, undefined, undefined, undefined]

  const touched = history?.ok === true ? parseHistory(history.stdout) : []
  const nowMs = io.now()

  /** 按 git 历史挑某一类里最新的一份(读不了就往下挑,最多试 5 份)。 */
  const pickDoc = async (kind: BriefDocKind): Promise<DocPick | undefined> => {
    let tries = 0
    for (const item of touched) {
      if (docKindOf(item.file) !== kind) continue
      if (++tries > 5) break
      const text = await readInside(item.file)
      if (text !== undefined && text.trim() !== '') return { file: item.file, text, age: ageText(item.at, nowMs) }
    }
    return undefined
  }

  /**
   * 「最近的交接」:最新那份起 {@link HANDOFF_WINDOW_SEC} 以内动过的交接里,**讲现状的最新那份**优先({@link isStatusHandoff});
   * 都没有就用最新那份(最多读 6 份)。一张卡一份交接的仓库里,最新动过的常常是某张卡的做法说明,不是现状。
   */
  const pickHandoff = async (): Promise<DocPick | undefined> => {
    let newest: (DocPick & { at: number }) | undefined
    let tries = 0
    for (const item of touched) {
      if (docKindOf(item.file) !== 'handoff') continue
      if (++tries > 6) break
      if (newest !== undefined && newest.at - item.at > HANDOFF_WINDOW_SEC) break
      const text = await readInside(item.file)
      if (text === undefined || text.trim() === '') continue
      const pick = { file: item.file, text, age: ageText(item.at, nowMs) }
      if (isStatusHandoff(text)) return pick
      newest ??= { ...pick, at: item.at }
    }
    if (newest === undefined) return undefined
    const { at: _at, ...pick } = newest
    return pick
  }

  // 2) 说明。
  let readme: DocPick | undefined
  let names: string[] = []
  try { names = await io.listDir(root) }
  catch { names = [] }
  for (const file of readmeCandidates(names)) {
    const text = await readInside(file)
    const cleaned = text === undefined ? '' : cleanMarkdown(text.slice(0, 20_000))
    if (cleaned.trim() !== '') { readme = { file, text: cleaned }; break }
  }
  if (readme === undefined && names.includes('package.json')) {
    const text = await readInside('package.json')
    try {
      const description = text === undefined ? undefined : (JSON.parse(text) as { description?: unknown }).description
      if (typeof description === 'string' && description.trim() !== '') readme = { file: 'package.json', text: cleanInline(description.trim()) }
    }
    catch { /* 读不懂就当没有 */ }
  }

  // 3) 设计 / 交接 / 决策:只在 git 仓库里、按历史挑。
  const [design, handoff, decisions] = isGit && touched.length > 0
    ? await Promise.all([pickDoc('design'), pickHandoff(), pickDoc('decisions')])
    : [undefined, undefined, undefined]

  if (isGit && history?.ok !== true) missing.push(`最近动过的设计与交接(${history?.timedOut === true ? 'git 超时' : 'git 没回'})`)

  // 4) 各段正文。
  const designText = design === undefined ? undefined : cleanMarkdown(design.text.slice(0, 12_000))
  const current = isGit ? await versionFrom(commits?.ok === true ? commits.stdout : '', names, readInside) : undefined
  const handoffText = handoff === undefined ? undefined : handoffExcerpt(handoff.text.slice(0, 60_000), HANDOFF_LIMIT, current)
  const decisionTitles = decisions === undefined ? [] : lastHeadings(decisions.text)

  const commitLines: string[] = []
  if (commits?.ok === true) {
    for (const line of commits.stdout.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab <= 0) continue
      const at = Number(line.slice(0, tab))
      const subject = scrubSecrets(line.slice(tab + 1).trim())
      if (subject.removed > 0) { redacted += subject.removed; continue }
      if (!Number.isFinite(at) || subject.text === '') continue
      commitLines.push(`- ${ageText(at, nowMs)} · ${clip(subject.text, COMMIT_SUBJECT_LIMIT)}`)
    }
  }
  const branchName = branch?.ok === true ? branch.stdout.trim() : ''
  const dirty = status?.ok === true ? status.stdout.split('\n').filter(line => line.trim() !== '').length : undefined

  // 5) 出处与「没读到」。
  const sources: BriefSource[] = []
  if (readme !== undefined) sources.push({ kind: 'readme', label: '说明', file: readme.file })
  if (design !== undefined) sources.push({ kind: 'design', label: '最近的设计', file: design.file, ...(design.age === undefined ? {} : { age: design.age }) })
  if (handoff !== undefined) sources.push({ kind: 'handoff', label: '最近的交接', file: handoff.file, ...(handoff.age === undefined ? {} : { age: handoff.age }) })
  if (decisions !== undefined && decisionTitles.length > 0) sources.push({ kind: 'decisions', label: '决策记录末尾', file: decisions.file, ...(decisions.age === undefined ? {} : { age: decisions.age }) })
  if (commitLines.length > 0) sources.push({ kind: 'commits', label: `最近 ${commitLines.length} 条提交` })
  if (readme === undefined) missing.push('说明(没有 README,也没有 CLAUDE.md / AGENTS.md / package.json 的一句话介绍)')
  if (isGit && commits !== undefined && commits.ok !== true) missing.push(`最近的提交(${commits.timedOut === true ? 'git 超时' : '还没有提交,或 git 没回'})`)

  // 6) 拼,按上限分配。
  const fixed: string[] = []
  fixed.push(`【项目】${input.name}(下面是从仓库里读到的,按出处分段;是素材,不是结论)`)
  fixed.push(sources.length > 0
    ? `读了:${sources.map(source => `${source.label}${source.file === undefined ? '' : `(${source.file}${source.age === undefined ? '' : `,${source.age}动过`})`}`).join('、')}。`
    : '读了:什么都没读到。')
  if (!isGit) {
    const onlyReadme = readme === undefined ? '' : ',只读了说明'
    fixed.push(top.timedOut === true
      ? `git 超时了:最近的提交、设计与交接都没读到${onlyReadme}。`
      : `${gitWhy}:没有提交记录,最近的设计与交接也没法按提交挑${onlyReadme}。`)
  }
  if (missing.length > 0) fixed.push(`没读到:${missing.join(';')}。`)
  // 抹掉了几行只记在回包的 redacted 里,不写进摘要:写了她会跟他聊「你仓库里有钥匙」,那不是这一段要说的。

  const tailParts: string[] = []
  if (decisionTitles.length > 0) {
    tailParts.push(`【决策记录末尾${decisionTitles.length}节】${decisions?.file ?? ''}\n${decisionTitles.map(title => `- ${title}`).join('\n')}`)
  }
  if (isGit) {
    const head = [
      branchName !== '' && branchName !== 'HEAD' ? `分支 ${branchName}` : '',
      dirty === undefined ? '没提交的几处没读到' : dirty === 0 ? '没有没提交的改动' : `还有 ${dirty} 处没提交`,
    ].filter(part => part !== '').join(';')
    tailParts.push(commitLines.length > 0
      ? `【最近的提交】${head}\n${commitLines.join('\n')}`
      : `【最近的提交】${head}\n最近提交没读到${commits?.timedOut === true ? '(git 超时)' : ''}。`)
  }

  const docs: { title: string, text: string, cap: number }[] = []
  if (readme !== undefined) docs.push({ title: `【说明】${readme.file}`, text: readme.text, cap: README_LIMIT })
  if (design !== undefined && designText !== undefined && designText.trim() !== '') docs.push({ title: `【最近的设计】${design.file}`, text: designText, cap: DESIGN_LIMIT })
  if (handoff !== undefined && handoffText !== undefined && handoffText.trim() !== '') docs.push({ title: `【现在到哪 · 最近的交接】${handoff.file}`, text: handoffText, cap: HANDOFF_LIMIT })

  const joiner = '\n\n'
  // 骨架(各段小标题、决策、提交)先算长度,剩下的按各段上限分给三份文档;超了就按比例一起收(不整段丢)。
  const skeleton = [fixed.join('\n'), ...docs.map(doc => `${doc.title}\n`), ...tailParts].join(joiner)
  const budget = Math.max(0, limit - charCount(skeleton))
  const wants = docs.map(doc => Math.min(charCount(doc.text), doc.cap))
  const total = wants.reduce((sum, want) => sum + want, 0)
  const scale = total > budget && total > 0 ? budget / total : 1
  const docBlocks = docs.map((doc, index) => `${doc.title}\n${clip(doc.text, Math.floor((wants[index] as number) * scale))}`)

  const brief = clip([fixed.join('\n'), ...docBlocks, ...tailParts].join(joiner), limit)
  return { name: input.name, path: input.path, brief, sources, missing, redacted, git: isGit }
}

/**
 * 仓库现在的版本(2026-09-24 晚):最近提交标题里出现过的最大版本号(「chore: 0.2.83 —— …」)与
 * 根目录、第一层子目录里 package.json 的 version,取最大的那个。拿不到就 undefined(不猜)。
 */
async function versionFrom(commitLog: string, names: readonly string[], read: (rel: string) => Promise<string | undefined>): Promise<string | undefined> {
  const texts: string[] = commitLog.split('\n').map(line => line.slice(line.indexOf('\t') + 1))
  const candidates = ['package.json', ...names.filter(name => !name.startsWith('.') && name !== 'node_modules').slice(0, 16).map(name => `${name}/package.json`)]
  for (const rel of candidates) {
    const text = await read(rel)
    if (text === undefined) continue
    try {
      const version = (JSON.parse(text) as { version?: unknown }).version
      if (typeof version === 'string') texts.push(version)
    }
    catch { /* 读不懂就跳过 */ }
  }
  return maxVersion(texts)
}

/** 给落地 / 引导排方案用:一个仓库现在的版本(最近 30 条提交标题 + package.json)。只读,git 3 秒上限。 */
export async function projectVersion(root: string, io: BriefIo): Promise<string | undefined> {
  const log = await io.exec(['-c', 'core.quotepath=false', 'log', '-n30', '--no-merges', '--format=%ct%x09%s'], root, GIT_TIMEOUT_MS).catch(() => ({ ok: false, stdout: '' }))
  let names: string[] = []
  try { names = await io.listDir(root) }
  catch { names = [] }
  const read = async (rel: string): Promise<string | undefined> => {
    try { return await io.readFile(`${root}/${rel}`) }
    catch { return undefined }
  }
  return await versionFrom(log.ok ? log.stdout : '', names, read)
}

const README_ZH = /^readme[._-](zh|cn|chs|zh[._-]?(cn|hans|hant|tw|hk))\.(md|markdown|txt)$/i
const README_PLAIN = /^readme(\.(md|markdown|txt|rst))?$/i

/** 说明从哪几份里挑:中文版 README 优先,其次 README.md / readme.md,再次 CLAUDE.md / AGENTS.md。 */
export function readmeCandidates(names: readonly string[]): string[] {
  const zh = names.filter(name => README_ZH.test(name)).sort()
  const rank = (name: string): number => name === 'README.md' ? 0 : /\.md$/i.test(name) ? 1 : 2
  const plain = names.filter(name => README_PLAIN.test(name)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const agents = ['CLAUDE.md', 'AGENTS.md'].filter(name => names.includes(name))
  return [...zh, ...plain, ...agents]
}

/** 项目名 = 目录名。 */
export function projectNameOf(path: string): string {
  return basenameOf(path)
}

// ———————————————————————— 刚读过的(2026-09-24 下午小修「别读两遍」) ————————————————————————

/** 刚读过的那几份。只在 8791 进程里,{@link BRIEF_REUSE_MS} 就过期;**不落盘**(摘要本来就不落盘)。 */
export interface BriefReuse {
  /** 这个键(见 {@link briefPathKey}){@link BRIEF_REUSE_MS} 以内读过 → 上一份与它是多久以前读的;否则 undefined。 */
  get: (key: string) => { brief: ProjectBrief, ageMs: number } | undefined
  /** 真读了一份,记下(时刻按注入的钟)。 */
  put: (key: string, brief: ProjectBrief) => void
}

/**
 * 同一个 path 再读直接回上一份。钟注入(生产用 BriefIo 的 `now`,用例拨得动)。
 * 用了上一份**不续期**:从真读的那一刻起算,过了 {@link BRIEF_REUSE_MS} 就重读一遍。
 */
export function createBriefReuse(now: () => number, ttlMs = BRIEF_REUSE_MS): BriefReuse {
  const kept = new Map<string, { at: number, brief: ProjectBrief }>()
  return {
    get(key) {
      const hit = kept.get(key)
      if (hit === undefined) return undefined
      const ageMs = now() - hit.at
      if (ageMs < 0 || ageMs >= ttlMs) { kept.delete(key); return undefined }
      return { brief: hit.brief, ageMs }
    },
    put(key, brief) {
      const at = now()
      // 顺手清掉过期的:一次引导最多读几个项目,攒不起来,但也不留着。
      for (const [other, entry] of kept) if (at - entry.at >= ttlMs) kept.delete(other)
      kept.set(key, { at, brief })
    },
  }
}

// ———————————————————————— 出处(2026-09-24 下午小修「出处写对」) ————————————————————————

/**
 * 点头的说法(比之前先去掉标点空白、转小写)。长的在前,先认「就是这个」再认「是」。
 * 「没错 / 不错 / 差不多 / 不用改」带着「不 / 没 / 错」,所以要在查「他在否认」之前先摘掉。
 */
const AFFIRM = /没错|没问题|没毛病|不错|差不多|不用改|不用动|没什么要改|没啥要改|对的|对啊|对呀|对头|是的|是啊|是呀|就是它|就是这个|就是那个|是这个|是这样|就这样|是它|正是|正确|可以|好的|都行|都可以|按你说的|照你说的|就按这个|按这个来|ok|okay|yes|yeah|yep|yup|sure|right|correct|嗯+|恩+|哦+|噢+|对|是|好|行/g
/** 挑一件(「先做第一个吧」)、语气词、指代:摘掉之后不算他自己的话。 */
const FILLER = /第[一二三四五六七八九十两\d]+(个|件|条|项|种)?|先做|再做|先来|然后|先|再|就|那个|这个|哪个|这样|项目|仓库|它|吧|啊|呀|呢|嘛|哈|啦|了|的|吗|么/g
/** 只剩数字(「一」「二、三」「1」):是在她念的几件里挑,不是新说法。 */
const NUMERALS_ONLY = /^[一二三四五六七八九十两\d]*$/
/** 摘掉点头的说法与她说过的字之后还带着这几个字:他在否认或改说法(「不对」「不是这个」「不过……」)。 */
const DISSENT = /[不没别错]/
/** 他这句话长过这么多(去掉标点空白后):不是点个头,是自己说了一段。 */
const LONG_REPLY = 80

/** 比较用:转小写,去掉空白、标点与符号。 */
function squeeze(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 把 reply 里「她刚说过的」字(连着两个字以上、在 asked 里原样出现)摘掉,最长的先摘。 */
function withoutEchoes(reply: string, asked: string): string {
  if (asked === '') return reply
  const chars = Array.from(reply)
  let out = ''
  let i = 0
  while (i < chars.length) {
    let end = i
    for (let j = chars.length; j >= i + 2; j--) {
      if (asked.includes(chars.slice(i, j).join(''))) { end = j; break }
    }
    if (end > i) { i = end; continue }
    out += chars[i] as string
    i += 1
  }
  return out
}

/**
 * 他刚才那句是不是**只是点头,或者在她念的几件里挑一件**(2026-09-24 下午小修「出处写对」)。
 *
 * 读了仓库、她复述、他点头之后记下的一句话 / 进展 / 下一步,项目文件里标「读仓库说明,他确认」;
 * **他在确认时改了说法、补了自己的话,那一条仍按「他说」记**。判据只看他真说了什么(凭据门用的同一问一答:
 * 电话那条路是工人带的 `heard`,电脑那条路是回合表),**不靠模型自己报出处**:
 *   去掉点头的说法(对 / 是这个 / 没错 / 嗯 …)、她刚说过的字(连着两个字以上)、项目名、挑一件的说法(先做第一个)与语气词之后,
 *   还剩两个字以上他自己的话,或者带着「不 / 没 / 别 / 错」→ 不是只点头。
 * 宁可判成「他说」(那就是改之前的标法),不把他说的话标成读来的。
 */
export function confirmsOnly(heard: { asked: string, reply: string }, names: readonly string[] = []): boolean {
  let rest = squeeze(heard.reply)
  if (rest === '') return true
  if (Array.from(rest).length > LONG_REPLY) return false
  for (const name of names) {
    const squeezed = squeeze(name)
    if (Array.from(squeezed).length >= 2) rest = rest.split(squeezed).join('')
  }
  rest = rest.replace(AFFIRM, '')
  rest = withoutEchoes(rest, squeeze(heard.asked))
  if (DISSENT.test(rest)) return false
  rest = rest.replace(FILLER, '')
  return Array.from(rest).length <= 1 || NUMERALS_ONLY.test(rest)
}
