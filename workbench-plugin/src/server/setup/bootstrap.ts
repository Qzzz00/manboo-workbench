/**
 * 裸机引导:`deploy/bootstrap.sh` 背后的那一半(2026-09-17)。
 *
 * ## 它解决的是一个鸡生蛋
 *
 * 登录台(初始化页)住在工作台服务里,而工作台服务是 DSH 的插件,DSH 又要先有运行时、
 * profile、启动脚本和 launchd 项才跑得起来 —— 也就是说**登录台自己没法把自己装出来**。
 * `验收-从零重装清单-2026-09-17.md` 第六节第 3 条点名要的就是这条命令:
 * 「第一次需要一条引导命令把 8791 临时拉起来」。
 *
 * ## 一条纪律:不重写卡 A 的安装逻辑
 *
 * 卡 A(`install.ts`)已经把十一步安装写成了「可注入 exec 的服务」。这里**只做三件事**:
 *
 *   ① 从十一步里挑出「到登录台能打开」为止的六步,按顺序喂给同一个 `createSetupInstaller`;
 *   ② 把作业的 note / tail 翻成一行行人话打出来(命令行上没有进度条可用);
 *   ③ 挡掉两条不该在这时候跑的 `launchctl`(见 `bootstrapSkip`)。
 *
 * shell 里**一行安装逻辑都没有** —— 它只管体检 node、把这段跑起来、等端口、开浏览器。
 * 两处各写一份安装步骤,迟早不一致。
 *
 * ## 为什么不含 shell / butler / worker / web_login / restart
 *
 * - `shell`(壳 App):装完**要人去系统设置里点一次辅助功能**(第一次装无论如何都要点;
 *   壳要是 ad-hoc 签名的,那就每次重建都得重点一次 —— 治本见 deploy/codesign-identity.sh)。
 *   总之要人在场,所以按 Ben 09-17 的拍板,这一颗留在初始化页里由人自己点。
 * - `butler` / `worker`:事务官后端与通道层工人,少了它们看板照常开 —— 属于「可选」那一档
 *   (`types.ts` 里 `SetupItem.optional` 的判据)。
 * - `web_login`:要先有跑起来的 DSH 才有日志可读,所以它在这六步**之后**,由 `bootstrapSetupUrl` 做。
 * - `restart`:第一次装完是 `launchctl bootstrap` 起的,不是重启。
 */
import type { SetupIo } from './io.ts'
import { createSetupInstaller } from './install.ts'
import { latestWebToken } from './status.ts'
import { MIN_NODE_MAJOR, type SetupPaths } from './paths.ts'
import type { SetupInstallStep } from './types.ts'

/**
 * 「到登录台能打开」为止的六步。顺序就是依赖顺序:没有 node 装不了运行时,
 * 没有运行时装不进 profile,没有脚本 launchd 起不来。
 */
export const BOOTSTRAP_STEPS = ['node', 'runtime', 'profile', 'plugin', 'scripts', 'launchd'] as const
export type BootstrapStep = typeof BOOTSTRAP_STEPS[number]

function isBootstrapStep(value: string): value is BootstrapStep {
  return (BOOTSTRAP_STEPS as readonly string[]).includes(value)
}

/** 每一步在命令行上显示成什么。人话,不是步骤名。 */
export const BOOTSTRAP_STEP_LABEL: Record<BootstrapStep, string> = {
  node: '自有 node(先试复制这条;它跑不起来就下官方独立包)',
  runtime: 'DSH 运行时(要联网装 200 来个包,几分钟很正常)',
  profile: 'profile web(工作台插件挂在它下面)',
  plugin: '工作台插件(在仓库里构建 → 打包 → 装进 profile)',
  scripts: '三个启动脚本(dsh-start / butler-start / channel-start)',
  launchd: '开机自启项(写 plist + 装载 DSH)',
}

// ───────────────────────────── 命令行参数 ─────────────────────────────

export interface BootstrapArgs {
  /** 家目录。`--home` > `$HOME`。临时目录里真跑一遍时靠它。 */
  home: string
  /** DSH 的家。`--dsh-home` > `$DSH_HOME` > `<home>/.dsh`。 */
  dshHome: string
  /** 仓库根。`--repo` > `$WORKBENCH_BUTLER_CWD`。 */
  repoRoot: string
  /** 不真跑任何 launchctl(临时 HOME 里验证时必须给:真装载会和正在跑的服务抢 3080/8791)。 */
  noLaunch: boolean
  /** 什么都不装,只从日志里取那条带 token 的地址打到 stdout。 */
  printUrl: boolean
  steps: readonly BootstrapStep[]
}

export type BootstrapArgsResult = { ok: true, args: BootstrapArgs } | { ok: false, error: string }

/**
 * 参数只认这几个,认不出来的**直接停**而不是忽略 —— 打错一个字就默默装到别处去,
 * 是 0904 那类事故的开头。
 */
export function parseBootstrapArgs(argv: readonly string[], env: Record<string, string | undefined>): BootstrapArgsResult {
  let home: string | undefined
  let dshHome: string | undefined
  let repoRoot: string | undefined
  let noLaunch = false
  let printUrl = false
  let steps: readonly BootstrapStep[] = BOOTSTRAP_STEPS

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string
    const next = (): string | undefined => { i += 1; return argv[i] }
    switch (flag) {
      case '--home': home = next(); break
      case '--dsh-home': dshHome = next(); break
      case '--repo': repoRoot = next(); break
      case '--no-launch': noLaunch = true; break
      case '--print-url': printUrl = true; break
      case '--steps': {
        const raw = next() ?? ''
        const names = raw.split(',').map(name => name.trim()).filter(name => name !== '')
        const bad = names.filter(name => !isBootstrapStep(name))
        if (bad.length > 0) {
          return { ok: false, error: `不认识这几步:${bad.join('、')}。裸机引导只做这六步:${BOOTSTRAP_STEPS.join('、')}(壳 App 要人去点一次辅助功能授权,留在初始化页里自己点)。` }
        }
        steps = names as readonly BootstrapStep[]
        break
      }
      default:
        return { ok: false, error: `不认识的参数:${flag}。能用的是 --home / --dsh-home / --repo / --steps / --no-launch / --print-url。` }
    }
  }

  const resolvedHome = trimSlash(home ?? env.HOME ?? '')
  if (resolvedHome === '') return { ok: false, error: '不知道家目录在哪:既没有 --home,环境里也没有 HOME。' }
  const resolvedRepo = trimSlash(repoRoot ?? env.WORKBENCH_BUTLER_CWD ?? '')
  if (resolvedRepo === '') return { ok: false, error: '不知道仓库在哪:给一个 --repo <仓库根目录>,或者把 WORKBENCH_BUTLER_CWD 配上。' }

  return {
    ok: true,
    args: {
      home: resolvedHome,
      dshHome: trimSlash(dshHome ?? env.DSH_HOME ?? `${resolvedHome}/.dsh`),
      repoRoot: resolvedRepo,
      noLaunch,
      printUrl,
      steps,
    },
  }
}

function trimSlash(path: string): string {
  return path === '/' ? path : path.replace(/\/+$/, '')
}

// ───────────────────────────── node 体检 ─────────────────────────────

/** 没有合格 node 时照着贴的几条命令。**只印出来给人看,脚本自己一条都不跑。** */
export const HOMEBREW_NODE_HINT = [
  '  # 还没有 Homebrew 的话,先装它(官方安装脚本):',
  '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
  '  # 然后装 node 24:',
  '  brew install node@24',
  '  echo \'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"\' >> ~/.zprofile',
  '  exec zsh -l   # 让 PATH 生效,然后重新跑一次 bash deploy/bootstrap.sh',
].join('\n')

export type NodeVersionResult = { ok: true, major: number } | { ok: false, message: string }

/**
 * 系统 node 够不够新。**低于 24 不是"凑合能跑"**:channel-start 要 node 自己剥 TypeScript
 * (`paths.ts` 的 MIN_NODE_MAJOR),而这条 node 还会被原样复制成 `~/.dsh/node` 长期用下去。
 */
export function checkNodeVersion(version: string): NodeVersionResult {
  const match = version.trim().match(/^v?(\d+)\./)
  if (match === null) {
    return { ok: false, message: `认不出 node 的版本号(拿到的是「${version.trim()}」)。工作台要 node ${MIN_NODE_MAJOR} 或更新:\n${HOMEBREW_NODE_HINT}` }
  }
  const major = Number(match[1])
  if (major < MIN_NODE_MAJOR) {
    return { ok: false, message: `这台机器上的 node 是 ${major} 版,工作台要 ${MIN_NODE_MAJOR} 或更新。照着装一个:\n${HOMEBREW_NODE_HINT}` }
  }
  return { ok: true, major }
}

// ───────────────────────────── 挡掉哪几条命令 ─────────────────────────────

/**
 * 把某些命令挡下来的 io 包装:`skip(cmd)` 回一句人话就不真跑,并把那句话喂进进度。
 *
 * 为什么做成包装而不是给 `install.ts` 加参数:安装那一块是卡 A 的地盘,而"这一次别跑
 * launchctl"是**调用方的处境**,不是安装步骤的属性。包在外面,`install.ts` 一个字不用改。
 */
export function withSkippedCommands(io: SetupIo, skip: (cmd: readonly string[]) => string | undefined): SetupIo {
  return {
    ...io,
    exec: async (cmd, options) => {
      const reason = skip(cmd)
      if (reason === undefined) return io.exec(cmd, options)
      options?.onLine?.(reason)
      return { ok: true, code: 0, out: reason }
    },
  }
}

/**
 * 裸机引导该挡掉哪些 `launchctl`。
 *
 * ① `--no-launch`:临时 HOME 里验证时一条都不跑 —— 真装载会和正在跑的那台服务抢 3080/8791。
 * ② 事务官后端那一项(`ai.deepseek.butler`):**任何时候都不装载**。它的 plist 是
 *    `KeepAlive.SuccessfulExit=false` + `ThrottleInterval 10`,而裸机引导不跑 `butler` 那步
 *    (`~/.dsh/butler-server` 还是空的),装载它的结果是 launchd 每 10 秒把一个必定失败的
 *    进程拉起来一次,而且这台机器此前**根本没装过**这一项(验收清单第二节:「butler 的
 *    plist 本机没装」)。plist 照写不误(仓库里有副本总比没有好),只是不装载。
 */
export function bootstrapSkip(options: { noLaunch: boolean }): (cmd: readonly string[]) => string | undefined {
  return (cmd) => {
    if (cmd[0] !== 'launchctl') return undefined
    const line = cmd.join(' ')
    if (options.noLaunch) return `跳过(--no-launch):${line}`
    if (line.includes('ai.deepseek.butler')) {
      return '跳过装载事务官后端的 launchd 项:裸机引导不发布 butler-server,装载它只会让 launchd 每 10 秒重启一个必定失败的进程。plist 已经写好了,等你在初始化页里装完事务官后端再装载它。'
    }
    return undefined
  }
}

// ───────────────────────────── 动手之前先看一眼 ─────────────────────────────

export interface BootstrapPreflightDeps {
  io: SetupIo
  paths: SetupPaths
  repoRoot: string
}

/**
 * 一条东西都还没写之前,先把"这个仓库能不能装"看一遍,回一串人话问题(空 = 过)。
 *
 * 为什么值得单独一步:六步里最贵的是 `runtime`(联网下 200 个包,几分钟)。让它先跑完
 * 再在 `plugin` 那步倒在"没装依赖"上,是最浪费人的时间的一种失败方式。
 */
export async function bootstrapPreflight(deps: BootstrapPreflightDeps): Promise<readonly string[]> {
  const repo = deps.repoRoot
  const problems: string[] = []
  const missing = async (path: string): Promise<boolean> => (await deps.io.stat(path)) === undefined

  if (await missing(`${repo}/workbench-plugin/package.json`)) {
    problems.push(`${repo} 底下没有 workbench-plugin/package.json —— 仓库路径给错了?这条命令要在 desktop-workbench 仓库根上跑。`)
    // 后面几条都以仓库为前提,路径本身就不对时不必再逐条报。
    return problems
  }
  if (await missing(`${repo}/workbench-plugin/node_modules/.bin/tsdown`)) {
    problems.push('插件还没装依赖:先 `cd workbench-plugin && pnpm install`。注意它的 devDependencies 用 `link:` 指向隔壁的 deepseek-harness 仓库(与本仓库同级),那个仓库不在的话 pnpm install 会失败 —— 见 README「运行要求」。')
  }
  for (const [path, why] of [
    [`${repo}/deploy/ai.deepseek.dsh.plist`, 'DSH 的开机自启项模板'],
    [`${repo}/butler-server/launchd/ai.deepseek.butler.plist`, '事务官后端的开机自启项模板'],
    [`${repo}/workbench-plugin/bin/dsh-start`, 'DSH 的启动脚本'],
    [`${repo}/workbench-plugin/bin/butler-start`, '事务官后端的启动脚本'],
    [`${repo}/deploy/channel-start`, '通道层工人的启动脚本'],
  ] as const) {
    if (await missing(path)) problems.push(`仓库里找不到${why}:${path}`)
  }
  return problems
}

// ───────────────────────────── 六步 ─────────────────────────────

export interface RunBootstrapDeps {
  io: SetupIo
  paths: SetupPaths
  repoRoot: string
  steps: readonly BootstrapStep[]
  now: () => number
  newId: () => string
  /** 每有一句人话进度就调一次。命令行上就是 `console.log`。 */
  report: (line: string) => void
  /** 轮询作业进度的间隔。默认 1 秒;测试里给 2 毫秒。 */
  pollMs?: number
}

export interface BootstrapOutcome {
  ok: boolean
  /** 真正跑完的步骤,按顺序。 */
  done: readonly BootstrapStep[]
  failed?: BootstrapStep
  /** 失败原因,人话。 */
  error?: string
  /** 原始输出的尾 20 行。失败时它是唯一能照着查的东西。 */
  tail?: readonly string[]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

export async function runBootstrap(deps: RunBootstrapDeps): Promise<BootstrapOutcome> {
  const installer = createSetupInstaller({
    io: deps.io,
    paths: deps.paths,
    repoRoot: deps.repoRoot,
    now: deps.now,
    newId: deps.newId,
  })
  const pollMs = deps.pollMs ?? 1_000
  const done: BootstrapStep[] = []

  for (const [index, step] of deps.steps.entries()) {
    deps.report(`[${index + 1}/${deps.steps.length}] ${BOOTSTRAP_STEP_LABEL[step]}`)
    const started = installer.start(step as SetupInstallStep)
    let lastNote: string | undefined
    let view = started
    for (;;) {
      view = installer.job(started.id) ?? view
      if (view.note !== undefined && view.note !== lastNote) {
        lastNote = view.note
        deps.report(`      ${view.note}`)
      }
      if (view.state !== 'running') break
      await sleep(pollMs)
    }
    if (view.state === 'failed') {
      return {
        ok: false,
        done,
        failed: step,
        error: view.error ?? '失败了,但没说原因',
        tail: view.tail,
      }
    }
    done.push(step)

    // 装完当场再验一次自有 node。
    // `install.ts` 的 node 那步自己已经验过一轮(跑不起来就改下官方独立包),这里是**兜底**:
    // 剩下的每一步都靠这条 node,让它在这儿断,总好过让 npm 在下一步报一串谁也看不懂的怪错。
    if (step === 'node') {
      const probe = await deps.io.exec([deps.paths.nodeBin, '-p', 'process.versions.node'])
      if (!probe.ok) {
        return {
          ok: false,
          done: done.slice(0, -1),
          failed: 'node',
          error: `${deps.paths.nodeBin} 跑不起来 —— 这一步明明报了成功,说明装出来的东西不对。看一眼 \`ls ${deps.paths.nodeDir}\`,把整个目录删掉再跑一次。`,
          tail: probe.out.split('\n').filter(line => line.trim() !== '').slice(-20),
        }
      }
      deps.report(`      自有 node 能跑:v${probe.out.trim().split('\n').pop() ?? '?'}`)
    }
  }
  return { ok: true, done }
}

// ───────────────────────────── 那条带 token 的地址 ─────────────────────────────

/** 给地址加上 `setup=1`(初始化页的第三条进来的路)。已经有了就不加第二遍。 */
export function withSetupFlag(url: string): string {
  if (/[?&]setup=1(&|$)/.test(url)) return url
  return url.includes('?') ? `${url}&setup=1` : `${url}?setup=1`
}

export type BootstrapUrlResult = { ok: true, url: string } | { ok: false, error: string }

/**
 * 从 `~/.dsh/logs/web.stdout.log` 里捞最新那条带 token 的地址,补上 `setup=1`。
 *
 * 复用的是体检那边同一个 `latestWebToken` —— shell 里再写一遍正则,两处迟早对不上。
 * **地址本身就是钥匙**:它只经这一次回包,不落盘、不打进日志。
 */
export async function bootstrapSetupUrl(io: SetupIo, paths: SetupPaths): Promise<BootstrapUrlResult> {
  const log = await io.readFile(paths.webStdoutLog)
  if (log === undefined) {
    return { ok: false, error: `读不到 ${paths.webStdoutLog} —— DSH 还没起来过。看一眼 ${paths.logsDir}/web.stderr.log 里说了什么。` }
  }
  const url = latestWebToken(log)
  if (url === undefined) {
    return { ok: false, error: `${paths.webStdoutLog} 里没有带 token 的地址(日志可能被轮转过)。跑一次 \`launchctl kickstart -k gui/$(id -u)/ai.deepseek.dsh\`,DSH 会重新打印一条。` }
  }
  return { ok: true, url: withSetupFlag(url) }
}
