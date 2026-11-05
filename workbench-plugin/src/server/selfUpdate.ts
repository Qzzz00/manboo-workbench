/**
 * 「改工作台自己」的判据、硬边界与那几样纯算(2026-09-23,断点 C)。
 *
 * 出处:`docs/设计-中秋目标-手机远程指挥电脑优化事务官-2026-09-23.md` 第二节断点 C
 * 与**第三节安全边界**(那一节是硬约束,这个文件是它在代码里的那一半)。
 *
 * ## 为什么要有"判据"这件事
 *
 * 需求卡这条线对**任何**项目都成立(`featureRun.ts`),但「合并 → 发版 → 热更新」
 * 这一串只对**这一个仓库**成立 —— 别人的仓库没有 `deploy/publish-update.sh`,
 * 也没有一个跑着的工作台等着 `/update/apply`。所以这里先问一句「这是不是我自己」:
 *
 * 1. 项目根有 `deploy/publish-update.sh`;
 * 2. `workbench-plugin/package.json` 的 `name` 是 `@ben/dsh-workbench`。
 *
 * **两条都要**。只认脚本的话,谁在自己仓库里放一个同名脚本就拿到了这条路;
 * 只认包名的话,一份 clone 出来的副本(没有发版链)会在第五步才失败。
 *
 * ## 硬边界写在这里,不是写在文档里
 *
 * 设计文档第三节:「事务官不许改 `deploy/`、`.claude/`、`~/.dsh` 下任何东西;
 * 不许改发版链本身。」一条只写在文档里的边界,等于没有边界 —— 读文档的是模型,
 * 而模型会在第七次派活时把它忘了。`guardSelfPaths` 是那句话的可执行形式:
 * **合并之前拿分支上改过的文件挨个过一遍**,撞上就停,不合。
 *
 * `docs/发版记录.md` 是**唯一被放行的那一份 docs**:第 3 步本来就要往它第 7 行插一行。
 * `docs/交接-*` 一律挡 —— 交接是人写给人的过程记录,事务官改它等于改历史。
 *
 * ## 这个文件一行 I/O 都没有
 *
 * 除了 `detectSelfProject` 收一个"读文件"的函数(判据要看两个文件),其余全是纯函数。
 * 真跑 git、真跑发版脚本的在 `selfShip.ts`,那里每一样都可注入 —— 用例里
 * **发版脚本与 `/update/apply` 全是假的**,一次都没有真发过版。
 */

/** 这个仓库的插件包叫什么。判据之一,**唯一定义处**。 */
export const SELF_PACKAGE_NAME = '@ben/dsh-workbench'

/** 插件的 package.json 在仓库里的位置(版本号也从这里取、往这里写)。 */
export const SELF_PACKAGE_REL = 'workbench-plugin/package.json'

/** 发版脚本。判据之一,**同时是被硬边界挡住的那一个**(不许改发版链本身)。 */
export const PUBLISH_SCRIPT_REL = 'deploy/publish-update.sh'

/**
 * 自改闭环发版那一下递给 `--skip-local-check` 的理由(2026-10-03,发版闸那张卡)。
 *
 * 发版脚本从这一版起在 rsync 之前先把新插件装到本机、重启、等 8791 报出新版本号。
 * 而这条闭环的第 ⑥ 步**跑在工作台自己的进程里**:那一下重启会把这条请求杀掉,
 * 第 ⑦ 步的记录就永远写不成(「记录在热更新之前」是这条路最要紧的一条,见 selfShip.ts 文件头)。
 * 这条路自己的第 ⑧ 步会装这台机器并重启,所以它不是没装过,只是**装在推完之后**。
 */
export const SELF_SHIP_SKIP_LOCAL_CHECK
  = '自改闭环:第⑥步跑在工作台自己的进程里,闸里那一下重启会把它杀在记录之前;这条路的第⑧步自己会装本机'

/** 发版记录。第 3 步往它第 7 行插一行。 */
export const RELEASE_LOG_REL = 'docs/发版记录.md'

/** 进化日志:每一次「改自己」在这里留一条(设计文档第三节第 3 条)。 */
export const EVOLUTION_LOG_REL = 'docs/进化日志.md'

/** 分支落在哪(与人开卡时的习惯同一处,`.claude/worktrees/<slug>`)。 */
export const WORKTREES_REL = '.claude/worktrees'

/** 分支名前缀。`feat/<需求名-slug>`。 */
export const SELF_BRANCH_PREFIX = 'feat/'

/** 发版记录那张表的第一行数据在第几行(1 起)。新的一版插在它前面 —— 最新的在最上面。 */
export const RELEASE_ROW_LINE = 7

/* ──────────────────────── 判据:这是不是「我自己」 ──────────────────────── */

export interface SelfProjectVerdict {
  /** 这条需求改的是不是工作台自己。 */
  self: boolean
  /** 为什么(人话)。**两种结论都给** —— 界面上要能说清"为什么没有那条闭环"。 */
  why: string
}

/**
 * 读一个文件;不存在回 undefined。调用方注进来(用例喂假的,生产喂 fs)。
 */
export type ReadTextAt = (path: string) => Promise<string | undefined>

/** 拼一条仓库里的路径。**不用 node:path**:这个文件要保持零依赖、纯算。 */
export function joinRel(base: string, rel: string): string {
  const left = base.endsWith('/') ? base.slice(0, -1) : base
  return `${left}/${rel}`
}

/**
 * 「项目 = 这个仓库」吗。两条判据都过才算(见文件头)。
 *
 * package.json 读不出 `name` 时**当作不是**,不猜:一份读坏的 JSON 比一份没有的更危险。
 */
export async function detectSelfProject(projectPath: string, readText: ReadTextAt): Promise<SelfProjectVerdict> {
  const script = await readText(joinRel(projectPath, PUBLISH_SCRIPT_REL))
  if (script === undefined) {
    return { self: false, why: `这个项目里没有 ${PUBLISH_SCRIPT_REL},它不是工作台自己的仓库` }
  }
  const pkgText = await readText(joinRel(projectPath, SELF_PACKAGE_REL))
  if (pkgText === undefined) {
    return { self: false, why: `这个项目里没有 ${SELF_PACKAGE_REL},它不是工作台自己的仓库` }
  }
  let name: unknown
  try { name = (JSON.parse(pkgText) as { name?: unknown }).name }
  catch { return { self: false, why: `${SELF_PACKAGE_REL} 读不出来(不是一份能解析的 JSON),按"不是我自己"办` } }
  if (name !== SELF_PACKAGE_NAME) {
    return { self: false, why: `${SELF_PACKAGE_REL} 里的包名是 ${String(name)},不是 ${SELF_PACKAGE_NAME}` }
  }
  return { self: true, why: `这个项目就是工作台自己(有 ${PUBLISH_SCRIPT_REL},包名是 ${SELF_PACKAGE_NAME})` }
}

/* ──────────────────────── 分支名 ──────────────────────── */

/**
 * 需求名 → 分支上那一截 slug。
 *
 * git 的分支名认 UTF-8,所以**中文原样留着** —— 把「时钟字号调大一号」音译成拼音
 * 只会让她在 `git branch` 里认不出自己那条需求。挡掉的是 git 真的不认的那些:
 * 空白、`~^:?*[\`、`..`、`@{`、控制字符,以及开头/结尾的 `.` 与 `/`。
 *
 * 一个字都不剩时回 undefined ——**不编一个 `feat/feature-1`**:一条认不出是什么的分支
 * 比没有分支更坏。
 */
export function featureSlug(name: string): string | undefined {
  if (typeof name !== 'string') return undefined
  const cleaned = name
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[~^:?*[\]\\]/g, '')
    .replace(/@\{/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/[\s/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .trim()
  if (cleaned === '' || cleaned.length > 80) return cleaned === '' ? undefined : cleaned.slice(0, 80)
  return cleaned
}

/** `feat/<slug>`。名字不合法回 undefined(不拼半截出来,同 `featureDirOf`)。 */
export function branchOfFeature(name: string): string | undefined {
  const slug = featureSlug(name)
  return slug === undefined ? undefined : `${SELF_BRANCH_PREFIX}${slug}`
}

/** worktree 落在 `<项目根>/.claude/worktrees/<slug>`。 */
export function worktreeOfFeature(projectPath: string, name: string): string | undefined {
  const slug = featureSlug(name)
  return slug === undefined ? undefined : `${joinRel(projectPath, WORKTREES_REL)}/${slug}`
}

/* ──────────────────────── 硬边界 ──────────────────────── */

export interface ForbiddenRule {
  id: string
  /** 撞上之后屏上那一句(人话,说清为什么不许)。 */
  why: string
  hit: (rel: string) => boolean
}

/**
 * 事务官这条路**不许碰**的东西(设计文档第三节逐字)。
 *
 * 顺序就是判定顺序,第一条撞上的那一句就是理由。
 */
export const SELF_FORBIDDEN: readonly ForbiddenRule[] = [
  {
    id: 'deploy',
    why: '发版链本身(deploy/)不许改 —— 改自己的那条路不能顺手改开门的那把锁',
    hit: rel => rel === 'deploy' || rel.startsWith('deploy/'),
  },
  {
    id: 'claude',
    why: '.claude/ 不许改 —— 那是会话与 worktree 的家当,不是这条需求的产物',
    hit: rel => rel === '.claude' || rel.startsWith('.claude/'),
  },
  {
    id: 'handoff',
    why: `docs/交接-* 不许改 —— 交接是人写给人的过程记录;能改的那一份 docs 只有 ${RELEASE_LOG_REL}`,
    hit: rel => rel.startsWith('docs/交接-'),
  },
]

/** `~/.dsh` 下的东西。绝对路径与 `~` 两种写法都认。 */
export function isUnderDshHome(path: string, home?: string): boolean {
  const one = path.trim()
  if (one.startsWith('~/.dsh/') || one === '~/.dsh') return true
  const base = (home ?? '').replace(/\/$/, '')
  if (base === '') return false
  return one === `${base}/.dsh` || one.startsWith(`${base}/.dsh/`)
}

export interface BlockedPath {
  path: string
  why: string
}

export interface SelfGuardVerdict {
  ok: boolean
  blocked: readonly BlockedPath[]
}

/**
 * 分支上改过的这些文件,事务官能不能合。
 *
 * `paths` 是 `git diff --name-only` 那种**相对仓库根**的路径;也认绝对路径
 * (那时先看在不在仓库里 —— 不在就是"改到仓库外面去了",一律挡)。
 *
 * ★ 这道门**在合并之前**过。合完再发现改了 `deploy/` 已经晚了:main 上已经有那一笔。
 */
export function guardSelfPaths(
  paths: readonly string[],
  opts: { projectPath?: string, home?: string } = {},
): SelfGuardVerdict {
  const root = opts.projectPath === undefined ? undefined : opts.projectPath.replace(/\/$/, '')
  const blocked: BlockedPath[] = []
  for (const raw of paths) {
    const one = typeof raw === 'string' ? raw.trim() : ''
    if (one === '') continue

    if (isUnderDshHome(one, opts.home)) {
      blocked.push({ path: one, why: '~/.dsh 下的任何东西都不许改 —— 那是这台机器上跑着的那一份,不是仓库' })
      continue
    }

    let rel = one
    if (one.startsWith('/')) {
      if (root === undefined || !(one === root || one.startsWith(`${root}/`))) {
        blocked.push({ path: one, why: '这条路径在仓库外面 —— 改自己只许改这个仓库里的东西' })
        continue
      }
      rel = one.slice(root.length + 1)
    }
    // `..` 拐出去的一律挡(`git diff --name-only` 不该给出这种,但收进来的东西不预设善意)。
    if (rel.split('/').some(part => part === '..')) {
      blocked.push({ path: one, why: '这条路径带 .. —— 拐出仓库的路一律不认' })
      continue
    }
    const rule = SELF_FORBIDDEN.find(one2 => one2.hit(rel))
    if (rule !== undefined) blocked.push({ path: rel, why: rule.why })
  }
  return { ok: blocked.length === 0, blocked }
}

/** 撞了边界之后卡上/收件箱里那一句。**把撞的那几条原样列出来**,不概括。 */
export function guardBlockedNote(verdict: SelfGuardVerdict): string {
  const lines = verdict.blocked.map(one => `${one.path}(${one.why})`)
  return `这条分支上改到了不许改的东西,没有合并:${lines.join(';')}`
}

/* ──────────────────────── 改到了哪几个包 ──────────────────────── */

export interface SelfPackage {
  /** 仓库里的顶层目录。 */
  dir: string
  /** `publish-update.sh --with` 里的那一项。 */
  with: string
  /** 人话名字(卡上与日志里写这个)。 */
  title: string
  /**
   * 这个包怎么跑测试。**一条一条按顺序跑,红一条就停**。
   * 空数组 = 这个包没有可跑的(现在没有这样的包,留着是为了别的包进来时不用改结构)。
   */
  tests: readonly (readonly string[])[]
}

/**
 * 四个包。`workbench-plugin` **永远跑测试**(卡里钉死:全量测试是插件那一份),
 * 另外三个改到了才跑、改到了才发。
 *
 * `deploy/` 不在这张表里 —— 它根本不许改(见 `SELF_FORBIDDEN`)。
 */
export const SELF_PACKAGES: readonly SelfPackage[] = [
  {
    dir: 'workbench-plugin',
    with: 'plugin',
    title: '工作台插件',
    tests: [['pnpm', 'typecheck'], ['pnpm', 'vitest', 'run']],
  },
  {
    dir: 'butler-app',
    with: 'apk',
    title: '手机端事务官',
    tests: [['pnpm', 'typecheck'], ['pnpm', 'vitest', 'run']],
  },
  {
    dir: 'channel-worker',
    with: 'worker',
    title: '通话组件',
    tests: [['pnpm', 'typecheck'], ['pnpm', 'vitest', 'run']],
  },
  {
    // 这一份没有 typecheck 脚本(它是 CommonJS + node:sqlite,见 AGENTS.md 的仓库结构表)。
    // **不编一条跑不起来的命令**:一条 `pnpm typecheck` 在这里只会红在"没有这个脚本"上。
    dir: 'butler-server',
    with: 'butler',
    title: '事务官本机后端',
    tests: [['pnpm', 'vitest', 'run']],
  },
]

/** 插件那一份(永远要跑、永远要发)。 */
export const PLUGIN_PACKAGE = SELF_PACKAGES[0] as SelfPackage

/**
 * 这些改动碰到了哪几个包。**插件永远在里面**(它是热更新的主体,而且全量测试跑的就是它)。
 * 返回顺序与 `SELF_PACKAGES` 一致 —— 跑测试与发版的顺序要是确定的。
 */
export function packagesOfPaths(paths: readonly string[]): readonly SelfPackage[] {
  const touched = new Set<string>()
  for (const raw of paths) {
    const one = typeof raw === 'string' ? raw.trim() : ''
    const top = one.split('/')[0]
    if (top !== undefined && top !== '') touched.add(top)
  }
  return SELF_PACKAGES.filter(pkg => pkg.dir === PLUGIN_PACKAGE.dir || touched.has(pkg.dir))
}

/**
 * `--with` 那一串。脚本自己会把 `plugin` 补在最前面(`WITH="plugin,${1}"`),
 * 所以这里**不重复写 plugin**;一个字都不改地照脚本的口径拼。
 */
export function withArgOf(packages: readonly SelfPackage[]): string {
  const rest = packages.filter(pkg => pkg.with !== PLUGIN_PACKAGE.with).map(pkg => pkg.with)
  return rest.length === 0 ? PLUGIN_PACKAGE.with : rest.join(',')
}

/* ──────────────────────── 版本号与发版记录 ──────────────────────── */

/**
 * 补丁位加一。认不出的版本号回 undefined ——**不编一个 0.0.1**:
 * 一个编出来的版本号会比服务器上那一版旧,发版脚本会当场拒绝,而那时已经 commit 过了。
 */
export function bumpPatch(version: string): string | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim())
  if (match === null) return undefined
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

/** 从 package.json 的正文里把 version 捞出来。读不出回 undefined。 */
export function versionOfPackageJson(text: string): string | undefined {
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version
    return typeof version === 'string' && version.trim() !== '' ? version.trim() : undefined
  }
  catch { return undefined }
}

/** 发版记录那一列的日期:`MM-DD`(与表里既有的每一行同一个写法)。 */
export function releaseDay(at: Date): string {
  const pad = (one: number): string => String(one).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * 发版记录里的那一行。四列:版本 / 日期 / **你会看到什么** / 交接。
 *
 * 第三列是**人话**,来自 `需求.md`(卡里钉死:「人话,来自需求.md」)。竖线会把表拆散,
 * 所以原文里的 `|` 换成全角 `｜`;换行压成一个空格。
 */
export function releaseRow(input: { version: string, day: string, notes: string, handoff?: string }): string {
  const clean = (one: string): string => one.replace(/\r?\n/g, ' ').replace(/\|/g, '｜').trim()
  const handoff = input.handoff === undefined || input.handoff.trim() === '' ? '—' : clean(input.handoff)
  return `| ${input.version} | ${input.day} | ${clean(input.notes)} | ${handoff} |`
}

export type InsertReleaseRowResult = { ok: true, text: string } | { ok: false, reason: string }

/**
 * 把一行插进发版记录的**第 7 行**(= 表头分隔行的下一行,最新的在最上面)。
 *
 * **先认一次表头再插**:第 5 行是 `| 版本 |…`、第 6 行是 `|---|…`。对不上就**拒绝**,
 * 不"尽量插在看起来像表的地方" —— 一行插错位置的发版记录,下一个人读到的是一张烂表。
 */
export function insertReleaseRow(text: string, row: string): InsertReleaseRowResult {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const header = lines[RELEASE_ROW_LINE - 3]
  const rule = lines[RELEASE_ROW_LINE - 2]
  if (header === undefined || !header.trim().startsWith('| 版本')) {
    return { ok: false, reason: `${RELEASE_LOG_REL} 第 ${RELEASE_ROW_LINE - 2} 行不是「| 版本 |」表头,没敢往里插` }
  }
  if (rule === undefined || !/^\|[\s|:-]+\|$/.test(rule.trim())) {
    return { ok: false, reason: `${RELEASE_LOG_REL} 第 ${RELEASE_ROW_LINE - 1} 行不是表头分隔行,没敢往里插` }
  }
  if (lines.includes(row)) return { ok: false, reason: '这一行已经在发版记录里了(同一版发过一次?)' }
  const next = [...lines.slice(0, RELEASE_ROW_LINE - 1), row, ...lines.slice(RELEASE_ROW_LINE - 1)]
  return { ok: true, text: next.join('\n') }
}

/* ──────────────────────── 进化日志 ──────────────────────── */

/**
 * 进化日志那一节里「状态」那一行的两种值(2026-09-23 接线时定的,见本节下面那段)。
 *
 * **为什么会有"状态"这件事**:第 ⑦ 步(触发热更新)会把**正在跑这条请求的这个进程**
 * 换掉并重启 —— 它没有办法在同一个进程里观察"版本号变了没有"。统筹定的做法是
 * **先落记录、再触发更新、立刻回包不等**,于是这一节写下去的那一刻,
 * 这一版到底生没生效**还不知道**。
 *
 * 写「已生效」就是编一件没发生的事;不写状态则是让半年后读日志的人以为它成了。
 * 所以这一行如实写 `待重启确认`,由重启之后那一段「收尾」(`selfShipFollowUp.ts`)
 * 对一次版本号再改成 `已生效`。
 */
export const EVOLUTION_PENDING = '待重启确认'
export const EVOLUTION_CONFIRMED = '已生效'

/** 状态那一行的前缀。**唯一定义处**:写它的与回头改它的念的是同一个串。 */
export const EVOLUTION_STATUS_PREFIX = '- 状态:'

/**
 * 进化日志里那一节(设计文档第三节第 3 条逐字:**哪天、什么、谁做的、版本号、怎么撤**),
 * 外加一行**状态**(见 {@link EVOLUTION_PENDING})。
 *
 * 「怎么撤」不是一句套话:它是这条闭环存在的前提 —— 一件能自己改自己的东西,
 * 没有一条写下来的退路就不该动手。这里写的是**这一版真实的那两条命令**。
 */
export function evolutionSection(input: {
  day: string
  what: string
  who: string
  version: string
  previousVersion?: string
  commit?: string
  /** 缺省 `待重启确认` —— 这条闭环落这一节的时候,热更新还没重启完(见上面那段)。 */
  status?: string
}): string {
  const back = input.previousVersion === undefined
    ? '回到上一版:`git revert <这一笔>` 然后照发版流程再发一版'
    : `回到上一版:\`git revert ${input.commit ?? '<这一笔>'}\`,把 ${SELF_PACKAGE_REL} 的版本改回 ${input.previousVersion} 之后照发版流程再发一版`
  const status = input.status ?? `${EVOLUTION_PENDING}(已经触发热更新,等这台电脑重启起来之后对一次版本号)`
  return [
    `## ${input.day} ${input.what}`,
    '',
    `- 哪天:${input.day}`,
    `- 什么:${input.what}`,
    `- 谁做的:${input.who}`,
    `- 版本号:${input.version}`,
    `${EVOLUTION_STATUS_PREFIX}${status}`,
    `- 怎么撤:${back}`,
    '',
  ].join('\n')
}

/** 进化日志里**最近那一节**的样子(收尾那一段要看的就是它)。 */
export interface LatestEvolution {
  /** 标题行在第几行(0 起)。 */
  heading: number
  /** 「什么」那一行(= 这一版的人话)。认不出就没有。 */
  what?: string
  /** 「版本号」那一行。认不出就没有 —— **不猜**:猜错了会把一条没生效的记成生效。 */
  version?: string
  /** 「状态」那一行在第几行(0 起)。这一版之前写的那些没有这一行。 */
  statusLine?: number
  /** 状态那一行冒号后面的原文。 */
  status?: string
}

/**
 * 把进化日志里**最近那一节**解出来。一节都没有回 undefined。
 *
 * 「最近」= 文件里**最后一个** `## ` 标题 —— 这个文件是往后追加的(`selfShip.ts` 第 ⑦ 步),
 * 所以最后一节就是刚发的那一版。
 */
export function parseLatestEvolution(text: string): LatestEvolution | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let heading = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] as string).startsWith('## ')) { heading = i; break }
  }
  if (heading < 0) return undefined
  const found: LatestEvolution = { heading }
  for (let i = heading + 1; i < lines.length; i += 1) {
    const line = lines[i] as string
    if (line.startsWith('## ')) break
    const what = /^-\s*什么\s*[::]\s*(.+)$/.exec(line)?.[1]?.trim()
    if (what !== undefined && what !== '') found.what = what
    const version = /^-\s*版本号\s*[::]\s*(.+)$/.exec(line)?.[1]?.trim()
    if (version !== undefined && version !== '') found.version = version
    const status = /^-\s*状态\s*[::]\s*(.*)$/.exec(line)?.[1]?.trim()
    if (status !== undefined) { found.statusLine = i; found.status = status }
  }
  return found
}

/** 这一节是不是「等重启确认」那一种。 */
export function isEvolutionPending(entry: LatestEvolution | undefined): boolean {
  return entry?.status !== undefined && entry.status.startsWith(EVOLUTION_PENDING)
}

export type ConfirmEvolutionResult = { ok: true, text: string } | { ok: false, reason: string }

/**
 * 把最近那一节的状态从 `待重启确认` 改成 `已生效`,并把**对上的那一刻**写进去。
 *
 * **只改那一行**,整份文件别的地方一个字节都不动 —— 这是一份人会读的历史,
 * 一次"顺手重排"就是改历史。没有状态那一行(这一版之前写的那些)就**拒绝**,
 * 不往里补一行:那等于替一条不知道结果的记录做结论。
 */
export function confirmEvolutionSection(
  text: string,
  facts: { version: string, at: string },
): ConfirmEvolutionResult {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const entry = parseLatestEvolution(text)
  if (entry === undefined) return { ok: false, reason: `${EVOLUTION_LOG_REL} 里一节都没有` }
  if (entry.statusLine === undefined) return { ok: false, reason: `${EVOLUTION_LOG_REL} 最近那一节没有「状态」那一行` }
  if (!isEvolutionPending(entry)) return { ok: false, reason: `${EVOLUTION_LOG_REL} 最近那一节不是「${EVOLUTION_PENDING}」` }
  lines[entry.statusLine] = `${EVOLUTION_STATUS_PREFIX}${EVOLUTION_CONFIRMED}(${facts.at} 重启之后对上了 ${facts.version})`
  return { ok: true, text: lines.join('\n') }
}

/**
 * 提交署名的尾行。**按事实写**(卡里钉死):这一笔是事务官在一条 DSH 会话里做的,
 * 所以尾行写的就是那条会话 —— 不借别人的名字,也不写一个"自动化"这种谁都不是的词。
 */
export function shipTrailer(sessionId: string | undefined): string {
  const who = sessionId === undefined || sessionId.trim() === '' ? '会话不详' : `DSH 会话 ${sessionId.trim()}`
  return `Co-Authored-By: 事务官(${who}) <butler@dsh.local>`
}

/** 合并发版那一笔的提交说明。第一行是人话,尾行是署名。 */
export function shipCommitMessage(input: {
  version: string
  name: string
  notes: string
  sessionId?: string
}): string {
  const head = input.notes.replace(/\r?\n/g, ' ').trim()
  return [
    `release: ${input.version} ${head}`,
    '',
    `需求「${input.name}」验收通过,事务官合并并发版。`,
    '',
    shipTrailer(input.sessionId),
  ].join('\n')
}

/* ──────────────────────── 人话从哪儿来 ──────────────────────── */

/**
 * 发版那一句**人话**从 `需求.md` 里取(卡里钉死:「人话,来自需求.md」)。
 *
 * 优先「目标」那一行 —— 需求那份产物的第一件事就是目标(`FEATURE_STAGE_BRIEF.梳理`:
 * 「写成 需求.md:目标 / 边界 / 验收标准」)。没有那一行就退到**第一段正文**。
 *
 * 一个字都没有回 undefined ——**不编一句**:那段文字会原样显示在她的设置里,
 * 是她决定要不要点「立即更新」的唯一依据(`docs/交接-0918-热更新.md` 第二节逐字)。
 */
export function notesFromRequirement(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (const raw of lines) {
    const line = raw.replace(/^[\s>*#-]+/, '').trim()
    const match = /^\*{0,2}目标\*{0,2}\s*[::]\s*(.+)$/.exec(line)
    const value = match?.[1]?.trim()
    if (value !== undefined && value !== '') return value
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('>')) continue
    const cleaned = line.replace(/^[\s*-]+/, '').trim()
    if (cleaned !== '') return cleaned
  }
  return undefined
}
