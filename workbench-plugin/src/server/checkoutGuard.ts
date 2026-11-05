/**
 * **写代码不归事务官做**:凡 git 仓库一律只读,构建 / 测试 / 包管理命令一律拦
 * (2026-09-28,卡 BS2;`docs/设计-事务官做什么不做什么与思考分档-2026-09-28.md` 第五节第 1 道门;
 * 决策记录 2026-09-28 15:5x「按你建议的来」第 6 条)。
 *
 * ## 2026-09-28 这一版把门从「他那份 checkout」扩到「凡 git 仓库」
 *
 * 前一版只守**他登记过的项目目录 + 工作台自己的仓库根**,`.claude/worktrees/` 底下**明确放行** ——
 * 于是卡片那件 37 万字思考就是事务官在一个 worktree 里自己改代码改出来的。现在:
 *
 * - **凡是 git 仓库里的路径一律只读**(含独立工作区 `.claude/worktrees/`、含她自己的项目);
 *   判据是 `ctx.repoRootOf`(往上找 `.git`,由 `index.ts` 注入;缺席就退回只看 `protectedRoots` 的老行为)。
 * - **构建 / 测试 / 包管理命令一律拦**,不看在哪个目录:`pnpm|npm|yarn|npx|bun|vitest|jest|tsc|vite|
 *   make|cmake|cargo|go build|swift build|xcodebuild|gradle|mvn|pytest…`。
 * - 拦下那句话说「**这是派出去的活**」并给派活口(`/dispatch/run`、`/dispatch/choices`)。
 *
 * **她自己的工作目录(`ownRoots`)照旧放行** —— 事项、记忆、交代、采集器定义都写在那里,
 * 那一份就算是 git 仓库也要让她写(不然她连记忆都记不成)。
 *
 * 派出去的那家在**自己的进程**里跑,不经这道门,不受影响。
 *
 * ---
 *
 * 原来那一条(2026-09-25,统筹给卡 O 补的,设计第 6 条「自我迭代」的一部分):
 * **不在他正在用的那份仓库里切分支、改文件**。
 *
 * 那天事务官修一个显示问题,在维护者的主 checkout(`~/Documents/GitHub/desktop-workbench`)上直接
 * `git checkout -b fix/avatar-headroom`、改文件、发布 —— 统筹紧接着往 main 提交的设计文档就落到了她那条分支上,
 * 维护者正开着的那份仓库也跟着换了分支。**用户正在用的那份目录不是她的工作台**。
 *
 * 规矩:改工作台自己(或者任何一个他登记过的项目)要在**独立工作区**里做 —— `POST /feature/branch`
 * 开的 git worktree(`<项目>/.claude/worktrees/<名>`),或者把写代码的活派给写代码的那家(派活那一层对工作台自己
 * 的活会先开一个独立工作区,见 `dispatchRun.ts` 的 `workdirFor`);合并与发布只走 `POST /feature/ship` 那固定的八步。
 *
 * 这一道门挂在 DSH 的 `tools/pre-execute` 上(每一次工具调用执行之前),**只拦两种**:
 *
 * 1. 在受保护的仓库里**动分支 / 动历史 / 动工作区**的 git 命令:checkout、switch、reset、stash、rebase、merge、pull、
 *    cherry-pick、revert、commit、restore、clean、am、apply,以及删 / 强改分支;
 *    (`git status / log / diff / show / fetch / worktree add|list` 这类只读的、开独立工作区的,照常放行。)
 * 2. 往受保护的仓库里**写文件**:write / edit / apply_patch 这类工具的目标路径;bash 里 `>`、`>>`、`tee`、`sed -i`、
 *    `cp`、`mv`、`rm`、`touch`、`mkdir` 落在那里的。
 *
 * 「受保护的仓库」= 他登记过的项目目录 + 工作台自己的仓库根(都是**他那份** checkout);
 * 其中 `.worktrees/`、`.claude/worktrees/` 底下的是独立工作区,**不算**;她自己的工作目录也不算。
 *
 * 局限写清楚:命令是按字认的(同卡 M 的「同类审批」),`cd` 进去之后用 `..` 往外绕、或者写进脚本再跑,认不出来。
 * 这道门是兜底 —— 第一道门仍是 DSH 的沙箱(她平时只能写自己的工作目录),再加上技能里那一段规矩。
 * 全是纯函数。
 */
import { isAbsolute, join, normalize } from 'node:path'

/** 独立工作区放在这两处(`selfUpdate.ts` 的 WORKTREES_REL 与任务卡的惯例)。 */
const NESTED_WORKTREES = ['.worktrees', '.claude/worktrees']

export interface GuardContext {
  /** 受保护的仓库根(他那份 checkout)。 */
  protectedRoots: readonly string[]
  /** 她自己的工作目录(永远不拦 —— 事项、记忆、交代、采集器定义都写在那里)。 */
  ownRoots?: readonly string[]
  /**
   * 这个路径在哪个 git 仓库里(往上找 `.git`;不在任何仓库里回 undefined)。
   * **2026-09-28 卡 BS2 那道门就靠它**:在就一律只读。缺席(老调用方、用例)= 退回只看 `protectedRoots`。
   */
  repoRootOf?: (path: string) => string | undefined
  home: string
}

function clean(path: string): string {
  const out = normalize(path).replace(/\/+$/, '')
  return out === '' ? '/' : out
}

function under(path: string, root: string): boolean {
  const r = clean(root)
  const p = clean(path)
  return p === r || p.startsWith(`${r}/`)
}

/** 路径 → 绝对路径(`~` 展开、相对的按 cwd)。算不出来回 undefined。 */
export function absolutePath(path: string, cwd: string | undefined, home: string): string | undefined {
  const raw = path.trim().replace(/^['"]|['"]$/g, '')
  if (raw === '') return undefined
  if (raw === '~') return home
  if (raw.startsWith('~/')) return clean(join(home, raw.slice(2)))
  if (isAbsolute(raw)) return clean(raw)
  if (cwd === undefined || cwd === '') return undefined
  return clean(join(cwd, raw))
}

/** 这个路径落在哪一份受保护的仓库里(在独立工作区里、在她自己的目录里的不算)。 */
export function protectedRootOf(path: string, ctx: GuardContext): string | undefined {
  if ((ctx.ownRoots ?? []).some(root => under(path, root))) return undefined
  const roots = [...ctx.protectedRoots].sort((a, b) => b.length - a.length)
  for (const root of roots) {
    if (!under(path, root)) continue
    const nested = NESTED_WORKTREES.some(rel => under(path, join(root, rel)))
    return nested ? undefined : clean(root)
  }
  return undefined
}

/** 这一条写的地方归谁:他那份 checkout,还是「随便哪个 git 仓库」。 */
export interface BlockedPlace {
  root: string
  kind: 'checkout' | 'repo'
}

/**
 * 这个路径写不得吗(2026-09-28,卡 BS2)。她自己的工作目录永远写得;
 * 他那份 checkout 回 `checkout`(话术照旧);其余任何 git 仓库回 `repo`。
 */
export function blockedPlaceOf(path: string, ctx: GuardContext): BlockedPlace | undefined {
  if ((ctx.ownRoots ?? []).some(root => under(path, root))) return undefined
  const checkout = protectedRootOf(path, ctx)
  if (checkout !== undefined) return { root: checkout, kind: 'checkout' }
  const repo = ctx.repoRootOf?.(path)
  return repo === undefined ? undefined : { root: clean(repo), kind: 'repo' }
}

/**
 * 构建 / 测试 / 包管理命令(2026-09-28,卡 BS2:**一律拦**,不看在哪个目录 —— 这是派出去的活)。
 * 认的是一段命令的**头一个词**;`go` / `swift` / `flutter` / `python` 那几个要看子命令(`go build` 拦,`go version` 不拦)。
 */
const BUILD_COMMANDS: ReadonlySet<string> = new Set([
  'pnpm', 'npm', 'yarn', 'npx', 'pnpx', 'bun', 'bunx', 'deno',
  'vitest', 'jest', 'mocha', 'playwright', 'cypress',
  'tsc', 'tsdown', 'vite', 'rollup', 'webpack', 'esbuild', 'tsup', 'turbo', 'nx',
  'make', 'cmake', 'ninja', 'bazel', 'gradle', 'gradlew', 'mvn', 'ant',
  'cargo', 'xcodebuild', 'xcrun', 'dotnet', 'msbuild',
  'pytest', 'tox', 'nox', 'rspec', 'rake', 'bundle',
  'eslint', 'biome', 'prettier', 'ruff', 'mypy',
])

/** 这几个要看子命令:头一个词 → 拦哪几个子命令。 */
const BUILD_SUBCOMMANDS: Readonly<Record<string, RegExp>> = {
  go: /^(build|test|run|vet|install|generate)$/,
  swift: /^(build|test|run)$/,
  flutter: /^(build|test|run|pub)$/,
  python: /^-m$/,
  python3: /^-m$/,
  node: /^--test$/,
}

/** 这一段命令是构建 / 测试 / 包管理吗。是就回它的原话头几个词(拦下时说出来)。 */
export function buildCommandOf(segment: string): string | undefined {
  const w = words(segment)
  let i = 0
  // `cd x && pnpm test` 已经按 && 拆开了;这里只跳过 env 赋值与 sudo / time 这类前缀。
  while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i] as string) || ['sudo', 'time', 'nohup', 'env', 'command'].includes(w[i] as string))) i += 1
  const head = w[i]
  if (head === undefined) return undefined
  const bare = head.split('/').pop() ?? head
  if (BUILD_COMMANDS.has(head) || BUILD_COMMANDS.has(bare)) return [head, ...w.slice(i + 1, i + 3)].join(' ')
  const sub = BUILD_SUBCOMMANDS[bare]
  const next = w[i + 1]
  if (sub !== undefined && next !== undefined && sub.test(next)) return `${head} ${next}`
  return undefined
}

const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'multiedit', 'str_replace_editor', 'apply_patch', 'notebook_edit', 'create_file'])

/** 动分支 / 动历史 / 动工作区的 git 子命令。 */
const GIT_MUTATING = /^(checkout|switch|reset|stash|rebase|merge|pull|cherry-pick|revert|commit|restore|clean|am|apply|mv|rm)$/

/** 一整条命令按 `&&` `||` `|` `;` 换行拆成一段一段(管道后面那一段也是一条命令:`… | tee <路径>`)。 */
function splitCommands(command: string): string[] {
  return command.split(/&&|\|\||\||;|\n/).map(one => one.trim()).filter(one => one !== '')
}

function words(segment: string): string[] {
  return segment.match(/'[^']*'|"[^"]*"|\S+/g)?.map(one => one.replace(/^['"]|['"]$/g, '')) ?? []
}

/** 一段 git 命令落在哪个目录、动不动东西。 */
function gitMutation(segment: string, cwd: string | undefined, home: string): { dir?: string, sub: string } | undefined {
  const w = words(segment)
  const at = w.indexOf('git')
  if (at === -1) return undefined
  let dir = cwd
  let i = at + 1
  while (i < w.length && (w[i] as string).startsWith('-')) {
    const flag = w[i] as string
    if (flag === '-C' && w[i + 1] !== undefined) { dir = absolutePath(w[i + 1] as string, cwd, home) ?? dir; i += 2; continue }
    if (flag === '-c' && w[i + 1] !== undefined) { i += 2; continue }
    i += 1
  }
  const sub = w[i]
  if (sub === undefined) return undefined
  if (sub === 'branch') {
    const rest = w.slice(i + 1)
    // 只读(列出来)放行;删 / 强改 / 改名算动。
    if (!rest.some(one => /^-(d|D|f|m|M|-delete|-force|-move)$/.test(one))) return undefined
    return { ...(dir === undefined ? {} : { dir }), sub: 'branch' }
  }
  if (sub === 'worktree') return undefined
  if (!GIT_MUTATING.test(sub)) return undefined
  return { ...(dir === undefined ? {} : { dir }), sub }
}

/** bash 里往哪几个路径写(重定向、tee、sed -i、cp/mv/rm/touch/mkdir 的参数)。 */
function shellWriteTargets(segment: string): string[] {
  const targets: string[] = []
  for (const m of segment.matchAll(/(?:^|[^0-9&])>{1,2}\s*([^\s;&|<>]+)/g)) targets.push(m[1] as string)
  const w = words(segment)
  const head = w[0] ?? ''
  if (head === 'tee') targets.push(...w.slice(1).filter(one => !one.startsWith('-')))
  if ((head === 'sed' && w.some(one => /^-i/.test(one))) || (head === 'perl' && w.some(one => /^-p?i/.test(one)))) {
    targets.push(...w.slice(1).filter(one => one.startsWith('/') || one.startsWith('~') || one.startsWith('.')))
  }
  if (['cp', 'mv', 'rm', 'touch', 'mkdir', 'rmdir', 'ln', 'install', 'rsync'].includes(head)) {
    const args = w.slice(1).filter(one => !one.startsWith('-'))
    // cp / mv / ln / rsync 只有最后一个是写的目标;其余几个每个参数都是。
    targets.push(...(['cp', 'mv', 'ln', 'install', 'rsync'].includes(head) ? args.slice(-1) : args))
  }
  return targets.filter(one => !/^\/dev\/(null|stdout|stderr)$/.test(one))
}

/** apply_patch 那一大段里改到的文件。 */
function patchPaths(patch: string): string[] {
  const out: string[] = []
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) out.push((m[1] as string).trim())
  for (const m of patch.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)) if (m[1] !== '/dev/null') out.push(m[1] as string)
  return out
}

function repoName(root: string): string {
  return root.split('/').filter(one => one !== '').pop() ?? root
}

/** 拦下时给她看的那一句(模型读得到)。 */
/**
 * 拦下时的那一句(统筹 09-25 拍板 ④:维护者自己在 DSH 网页里直接用时也拦,**提示要说清楚为什么、去哪做**)。
 * 读的人可能是事务官,也可能是他本人 —— 不写「他」,直说这是谁的目录、为什么不让动、三条路各在哪。
 */
export function guardReason(root: string, what: string): string {
  return `工作台拦下了:${what} 落在「${repoName(root)}」(${root})。`
    + '为什么:这是你平时用的那份仓库(登记过的项目 / 工作台自己的仓库根),工作台不让 DSH 在里面切分支、提交、改文件 —— '
    + '免得改到一半把你手上正在用的东西弄乱;你直接在 DSH 网页里用时也一样拦。'
    + '去哪做:① 在独立工作区里改 —— POST http://127.0.0.1:8791/feature/branch 开一个(落在 .claude/worktrees 底下),在那里改;'
    + '② 把写代码的活派给写代码的那家 —— POST /dispatch/run(kind 写 code),工作台会在独立工作区里跑;'
    + '③ 真要在这份目录里动,请你自己在终端(不是 DSH)里做。合并与发布只走 POST /feature/ship 那固定的一步。'
}

/** 「这是派出去的活」那一句尾巴:派活怎么派(两处拦下都念这一截)。 */
const DISPATCH_TAIL
  = '**这是派出去的活**:先看 GET http://127.0.0.1:8791/dispatch/choices?item=<事项 id>(哪家能做、还剩多少),'
  + '再 POST http://127.0.0.1:8791/dispatch/run {"item_id":"<事项 id>","app":"claude","text":"<他的原话>","kind":"code"} —— '
  + '工作台会在独立工作区里让那家做,做完把结果收回来。派不出去就如实告诉他(哪一家、为什么、能换谁),**不要自己上手**。'

/**
 * 在一个 git 仓库里要写东西(2026-09-28,卡 BS2)。**不是他那份 checkout 也拦** ——
 * 独立工作区、她自己的项目,一样只读。
 */
export function repoReadOnlyReason(root: string, what: string): string {
  return `工作台拦下了:${what} 落在 git 仓库「${repoName(root)}」(${root})里。`
    + '为什么:事务官会话里**凡 git 仓库一律只读**(含独立工作区、含你自己的项目)—— 写代码不归事务官做'
    + '(2026-09-28 拍板,设计第五节第 1 道门)。'
    + DISPATCH_TAIL
    + '真要你自己在这份目录里动,请在终端(不是工作台)里做。'
}

/** 构建 / 测试 / 包管理命令(2026-09-28,卡 BS2):一律拦,不看在哪个目录。 */
export function buildCommandReason(command: string): string {
  return `工作台拦下了:\`${command}\`。`
    + '为什么:构建、测试、装依赖都不归事务官做(2026-09-28 拍板,设计第五节第 1 道门)——'
    + '它跑一遍要几分钟、还常常要改代码才跑得过,那一整摊是写代码的那家的活。'
    + DISPATCH_TAIL
}

/**
 * 这一次工具调用要不要拦。回拦下的原因(给她看的那一句),不拦回 undefined。
 *
 * @param tool 工具名(DSH 的 `bash` / `write` / `edit` / …)
 * @param args 工具参数(DSH 已经解析好的对象)
 * @param cwd 这条会话的工作目录(相对路径按它算;bash 带 `workdir` 的按 `workdir`)
 */
export function checkoutViolation(tool: string, args: Record<string, unknown> | undefined, cwd: string | undefined, ctx: GuardContext): string | undefined {
  if (args === undefined) return undefined
  // 三道门一道都没接上(没有受保护的仓库、不认得 git 仓库)→ 只剩构建命令那一道还算数。
  const placesOff = ctx.protectedRoots.length === 0 && ctx.repoRootOf === undefined
  const name = tool.toLowerCase()
  if (WRITE_TOOLS.has(name)) {
    if (placesOff) return undefined
    if (name === 'str_replace_editor' && args.command === 'view') return undefined
    const paths: string[] = []
    for (const key of ['file_path', 'path', 'notebook_path', 'target_file']) {
      if (typeof args[key] === 'string') paths.push(args[key] as string)
    }
    for (const key of ['patch', 'input', 'diff']) {
      if (typeof args[key] === 'string') paths.push(...patchPaths(args[key] as string))
    }
    for (const one of paths) {
      const abs = absolutePath(one, cwd, ctx.home)
      const place = abs === undefined ? undefined : blockedPlaceOf(abs, ctx)
      if (place !== undefined) {
        return place.kind === 'checkout' ? guardReason(place.root, `改文件 ${abs}`) : repoReadOnlyReason(place.root, `改文件 ${abs}`)
      }
    }
    return undefined
  }
  if (name !== 'bash' && name !== 'shell' && name !== 'exec_command') return undefined
  const command = typeof args.command === 'string' ? args.command : Array.isArray(args.command) ? (args.command as unknown[]).join(' ') : ''
  if (command === '') return undefined
  let dir = typeof args.workdir === 'string' ? absolutePath(args.workdir, cwd, ctx.home) ?? cwd : cwd
  for (const segment of splitCommands(command)) {
    const w = words(segment)
    if (w[0] === 'cd' && w[1] !== undefined) {
      dir = absolutePath(w[1], dir, ctx.home) ?? dir
      continue
    }
    // 构建 / 测试 / 包管理(2026-09-28,卡 BS2):**不看在哪个目录**,一律拦。
    const build = buildCommandOf(segment)
    if (build !== undefined) return buildCommandReason(build)
    if (placesOff) continue
    const git = gitMutation(segment, dir, ctx.home)
    if (git !== undefined && git.dir !== undefined) {
      const place = blockedPlaceOf(git.dir, ctx)
      if (place !== undefined) {
        return place.kind === 'checkout' ? guardReason(place.root, `git ${git.sub}`) : repoReadOnlyReason(place.root, `git ${git.sub}`)
      }
    }
    for (const target of shellWriteTargets(segment)) {
      const abs = absolutePath(target, dir, ctx.home)
      const place = abs === undefined ? undefined : blockedPlaceOf(abs, ctx)
      if (place !== undefined) {
        return place.kind === 'checkout' ? guardReason(place.root, `往 ${abs} 写东西`) : repoReadOnlyReason(place.root, `往 ${abs} 写东西`)
      }
    }
  }
  return undefined
}
