/**
 * 桌面安装包的内核(2026-09-18)。**双击 dmg 之后真正干活的那一半。**
 *
 * ## 它和 bootstrap.ts 的区别只有一处:东西从哪来
 *
 * `bootstrap.ts` 服务的是「仓库就在手边」的那台机器(开发机):插件现构建、壳现构建。
 * 这里服务的是**普通用户那台机器** —— 没有仓库、没有 pnpm、没有 swiftc,只有一个
 * 双击开的 `安装工作台.app`。所以:
 *
 *   · 插件 `.tgz` 与构建好的 `工作台.app` 预先打进 .app 的 `Resources/`;
 *   · 启动脚本、plist、butler-server、channel-worker、本机房间的 livekit-server 也打进去,**摆成仓库的样子**
 *     (`Resources/payload/{workbench-plugin/bin,deploy,butler-server,channel-worker,livekit}`),
 *     于是 `install.ts` 的 scripts / launchd / butler / worker 四步一个字都不用改 ——
 *     它们要的本来就只是「仓库里的那几个文件」,而不是「一个真的 git 仓库」。
 *
 * **安装逻辑一行都没有在这里重写**,更没有在 Swift 里重写。这个文件只做三件事:
 * ① 排一串步骤的顺序并给每步一句人话;② 把作业的 note / tail 翻成事件流(Swift 读 JSON);
 * ③ 补两件仓库那条路上不需要的事 —— 建工作仓库、壳装不进 /Applications 时退到 ~/Applications。
 *
 * ## 为什么要「工作仓库」这一步
 *
 * 事务官的会话、引导、授权表、日常例程都要一个目录当落脚点(`butler_cwd`)。开发机上
 * 那是 desktop-workbench 仓库本身;普通用户机器上没有这个东西,所以现建一个空的:
 * `~/Documents/工作台`,`git init` + 最小结构,并把路径写进 `~/.dsh/workbench/app.json`。
 * **不写进 dsh-start** —— 环境变量压着 app.json,写死在启动脚本里等于把设置里那一栏废掉。
 */
import type { SetupIo } from './io.ts'
import { createSetupInstaller, writeButlerCwd, type SetupPrebuilt } from './install.ts'
import type { SetupInstallStep, SetupJobView } from './types.ts'
import { PNPM_TARBALL_NAME, type SetupPaths } from './paths.ts'
import { redactText } from '../diagnostics/redact.ts'

// ───────────────────────────── 那几步 ─────────────────────────────

export interface InstallerStepSpec {
  key: string
  /** 进度条底下那句话。**人话,不是步骤名** —— 看的人不知道什么叫 profile。 */
  title: string
  /** 对应 install.ts 的哪一步;缺席 = 安装器自己做的事,由 `local` 指名是哪一件。 */
  setupStep?: SetupInstallStep
  /** `setupStep` 缺席时,安装器自己做的是哪一件。 */
  local?: 'work_repo' | 'desktop'
  /** 少了它工作台照样能用(界面上失败时多一颗「跳过这步」)。 */
  optional?: boolean
}

/**
 * 顺序就是依赖顺序。两处值得说明:
 *
 * · **`launchd` 放在最后**:它一装载 DSH 就起来了,而 DSH 起来那一刻该读到的插件、
 *   启动脚本、事务官后端都得已经在位,否则第一次启动必然是一轮失败重启。
 * · **`shell` 在 `launchd` 之前**:壳一打开就要连 3080,先把它放好,结尾那颗
 *   「打开工作台」才是"点了就开"而不是"点了再装"。
 * · **`work_repo` 在 `scripts` 之前**:装启动脚本那一步会在 app.json 还没配过 `butler_cwd` 时
 *   记一笔(install.ts),而它手上的"仓库"是 .app 里那个 payload 目录 —— 先把工作目录建好并
 *   写进 app.json,那一笔就不会落到一个安装包内部的路径上。
 */
export const INSTALLER_STEPS: readonly InstallerStepSpec[] = [
  { key: 'node', title: '正在准备运行环境…', setupStep: 'node' },
  { key: 'runtime', title: '正在下载工作台的运行时…', setupStep: 'runtime' },
  { key: 'profile', title: '正在配置运行环境…', setupStep: 'profile' },
  { key: 'plugin', title: '正在安装工作台…', setupStep: 'plugin' },
  { key: 'work_repo', title: '正在建你的工作目录…', local: 'work_repo' },
  { key: 'scripts', title: '正在安装启动脚本…', setupStep: 'scripts' },
  { key: 'butler', title: '正在安装事务官…', setupStep: 'butler', optional: true },
  { key: 'worker', title: '正在安装通话组件…', setupStep: 'worker', optional: true },
  // 本机房间(2026-10-21,卡 M1):少了它打电话走云上那条,所以可跳过;macOS 14 上这一步自己如实跳过(不算失败)。
  { key: 'livekit', title: '正在安装本机通话服务…', setupStep: 'livekit', optional: true },
  { key: 'shell', title: '正在把工作台放进「应用程序」…', setupStep: 'shell' },
  { key: 'launchd', title: '正在设置开机自动启动…', setupStep: 'launchd' },
  // **最后一步、可跳过**(2026-09-27,卡 IN,维护者:「在安装过程中,把权限还有自动隐藏都做好了」)。
  // 放最后:它改的是她的桌面,不是工作台能不能跑 —— 万一这一步不成,前面十步已经都成了。
  { key: 'desktop', title: '正在把桌面整理一下…', local: 'desktop', optional: true },
]

export function installerStep(key: string): InstallerStepSpec | undefined {
  return INSTALLER_STEPS.find(step => step.key === key)
}

// ───────────────────────────── 事件流(Swift 读的就是它) ─────────────────────────────

/**
 * 一行一个 JSON 对象打到 stdout。**为什么是 JSON 而不是人话**:界面要的是
 * 「第几步 / 总共几步 / 这步在说什么 / 失败了没有」这四件事能被程序取出来,
 * 而人话行一旦改个标点,界面就得跟着改正则(交接-0917 第三节第 9 条留的那件事)。
 */
export type InstallerEvent =
  /** 开场:总共几步。 */
  | { t: 'begin', total: number }
  /** 进到第 i 步(1 起)。 */
  | { t: 'step', i: number, n: number, key: string, title: string }
  /** 这一步内部的进展,人话一句(「在装 200 个包,断了会接着来」)。 */
  | { t: 'note', text: string }
  /** 原始输出的一行。界面折在「详细日志」里。 */
  | { t: 'log', text: string }
  /**
   * 这一步能算出百分比(现在只有下载 node 那一段)。`pct` 是 0~1。
   * 算不出来的步骤**不发这条**,进度条就保持"来回走"的样子 —— 编一个假的百分比
   * 比没有百分比更糟(装 200 个 npm 包到底走到哪了,谁也不知道)。
   */
  | { t: 'progress', pct: number }
  /** 这一步跳过了(可选步骤失败,或者本来就不用装)。 */
  | { t: 'skip', key: string, why: string }
  /** 停在这一步。`error` 是人话,`tail` 是原始输出的尾巴。 */
  | { t: 'fail', key: string, title: string, error: string, tail: readonly string[], optional: boolean }
  /** 全装完了。 */
  | { t: 'done', shell_app: string, work_repo: string }
  /**
   * 这一趟的完整日志写在哪(2026-09-27,卡 PN)。开头发一次,界面把它记下来 ——
   * 出错那一屏要能说清"日志在哪"并给一颗「在访达里显示」,她才发得给我们。
   */
  | { t: 'logfile', path: string }
  /**
   * 装完之后自检的一件(2026-10-21,卡「引导三件事」;`installSelfCheck.ts`):早报 / 交代 / 电话各一条,
   * `line` 是给人看的那一句(「成」,或「没成 —— 缺哪道门 + 怎么办」),界面原样显示。老界面不认就当日志。
   */
  | {
    t: 'check'
    key: string
    title: string
    ok: boolean
    state: string
    line: string
    gate?: string
    fixes?: readonly { kind: string, label: string, family?: string }[]
  }

export function encodeInstallerEvent(event: InstallerEvent): string {
  return JSON.stringify(event)
}

/** 同一条事件给人看的样子(命令行里验收时用 `--human`)。 */
export function humanInstallerEvent(event: InstallerEvent): string | undefined {
  switch (event.t) {
    case 'begin': return `共 ${event.total} 步`
    case 'step': return `\n[${event.i}/${event.n}] ${event.title}`
    case 'note': return `      ${event.text}`
    case 'skip': return `      跳过:${event.why}`
    case 'progress': return `      ${Math.round(event.pct * 100)}%`
    case 'fail': return `\n×  ${event.title}没做成:${event.error}`
    case 'done': return `\n✓  装完了。壳在 ${event.shell_app},工作目录在 ${event.work_repo}`
    case 'logfile': return `   这一趟的完整日志:${event.path}`
    case 'check': return `   ${event.ok ? '✓' : '·'} ${event.line}`
    // 原始日志默认不往屏上刷 —— 几千行 npm 输出会把那十句人话冲掉。
    case 'log': return undefined
  }
}

// ───────────────────────── 安装日志落盘(2026-09-27,卡 PN) ─────────────────────────

/**
 * 这一趟的日志写在哪:`~/Library/Logs/工作台/安装-<时刻>.log`。
 *
 * **为什么非要落盘**:界面里那块「详细日志」只是给人当场看一眼的 —— 窗口一关就没了,
 * 而出错时我们真正需要的是她**把日志发过来**。macOS 上第三方 App 的日志本来就该放在
 * `~/Library/Logs/<名字>/`(控制台 App 能直接看见),所以不另发明一个地方。
 * 一趟一个文件(时刻在文件名里):重试几次就是几份,不会互相盖掉。
 */
export function installLogPath(home: string, at: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${String(at.getFullYear())}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
  return `${home}/Library/Logs/工作台/安装-${stamp}.log`
}

/**
 * 一条事件写进日志文件时的那一行(纯函数,可测)。
 *
 * - **脱敏用的是诊断包那一份规则**(`diagnostics/redact.ts` 的 `redactText`):
 *   一份日志是要发给别人的,而 npm / pnpm / curl 的输出里可能带着 `?token=…` 这类东西。
 *   两套规则迟早会漂,漂掉的那一次就是一把钥匙被发出去的那一次。
 * - `progress` 不写:几百条百分比会把真正有用的几行冲掉(界面上它是进度条,不是日志)。
 */
export function installLogLine(event: InstallerEvent): string | undefined {
  switch (event.t) {
    case 'begin': return redactText(`=== 开始安装,共 ${event.total} 步 ===`)
    case 'step': return redactText(`\n--- [${event.i}/${event.n}] ${event.key} ${event.title} ---`)
    case 'note': return redactText(`· ${event.text}`)
    case 'log': return redactText(event.text)
    case 'skip': return redactText(`跳过 ${event.key}:${event.why}`)
    case 'fail': return redactText([`× ${event.key} ${event.title} 失败:${event.error}`, ...event.tail.map(line => `  | ${line}`)].join('\n'))
    case 'done': return redactText(`✓ 装完了。壳在 ${event.shell_app},工作目录在 ${event.work_repo}`)
    case 'logfile': return redactText(`日志文件:${event.path}`)
    case 'progress': return undefined
  }
}

/**
 * 把 `emit` 包一层:先写日志文件,再照常发给界面。
 *
 * 写失败**一律不吭声、也不挡安装**(磁盘满了、Logs 目录没权限):日志是排障用的,
 * 不能因为它让一次本来能成的安装失败。追加是串行的(一条接一条),不然几千行并发追加
 * 会把行写岔。
 */
export function withInstallLog(io: SetupIo, path: string, emit: (event: InstallerEvent) => void): (event: InstallerEvent) => void {
  let queue: Promise<void> = Promise.resolve()
  return (event) => {
    const line = installLogLine(event)
    if (line !== undefined) {
      queue = queue.then(async () => { await io.appendFile(path, `${line}\n`) }).catch(() => {})
    }
    emit(event)
  }
}

// ───────────────────────────── 打进 .app 的那几样东西 ─────────────────────────────

export interface InstallerBundle {
  /**
   * `Resources/payload`。里面摆成仓库的样子,给 scripts / launchd / butler / worker
   * 四步当 `repoRoot` 用(它们要的只是那几个文件,不需要真的是 git 仓库)。
   */
  payloadRoot: string
  /** `Resources/payload/plugin/<name>.tgz` —— 构建好打包好的插件。 */
  pluginTarball: string
  /** `Resources/payload/app/工作台.app` —— 构建好的壳。 */
  shellApp: string
  /**
   * `Resources/payload/pnpm/pnpm-<版本>.tgz`(2026-09-27,卡 PN)。
   *
   * 0.1.7 的 `dsh plugin add` 转手给 pnpm,一台全新的 Mac 上没有 pnpm(也没有 Homebrew)
   * —— 所以把它打进安装包里,**装的时候一条网络请求都不用**。
   */
  pnpmTarball: string
}

export function bundleOf(resourcesDir: string, pluginTarballName: string): InstallerBundle {
  const payloadRoot = `${resourcesDir}/payload`
  return {
    payloadRoot,
    pluginTarball: `${payloadRoot}/plugin/${pluginTarballName}`,
    shellApp: `${payloadRoot}/app/工作台.app`,
    pnpmTarball: `${payloadRoot}/pnpm/${PNPM_TARBALL_NAME}`,
  }
}

/**
 * 从 `Resources/payload/plugin/` 里挑出那个 .tgz。
 *
 * 为什么不把文件名钉死:它带着版本号(`ben-dsh-workbench-0.2.40.tgz`),每次发版都变;
 * 钉死等于每次发版都要改两处。目录里只会有一个 .tgz,认后缀就够。
 */
export async function findBundledTarball(io: SetupIo, resourcesDir: string): Promise<string | undefined> {
  const dir = `${resourcesDir}/payload/plugin`
  const listing = await io.readdir(dir)
  if (!listing.ok) return undefined
  return [...listing.names].sort().find(name => name.endsWith('.tgz'))
}

// ───────────────────────────── 工作仓库 ─────────────────────────────

/** 新建的工作仓库里放什么。**刻意少** —— 引导会自己往里写,这里只搭骨架。 */
export function workRepoFiles(): readonly { path: string, text: string }[] {
  return [
    {
      path: 'AGENTS.md',
      text: [
        '# 这个目录是什么',
        '',
        '桌面工作台的**工作目录**。事务官的会话开在这里,引导问你的那些答案、它对你的记忆、',
        '它的授权表,都落在这个目录的 `docs/` 底下,并且由 git 管着版本 —— 也就是说',
        '**任何一次改动都能翻回去**。',
        '',
        '你可以像普通文件夹一样用它:往里放东西、改里面的文件。不用懂 git。',
        '',
        '## 目录',
        '',
        '- `docs/记忆/` —— 事务官记住的事:你是谁、有哪些项目、它被授权做什么。',
        '- `docs/记忆/项目/` —— 一个项目一份文件。',
        '',
        '## 要换个目录?',
        '',
        '工作台 → 齿轮(设置) → 目录 → 「事务官仓库目录」,改完重启工作台。',
        '',
      ].join('\n'),
    },
    {
      path: 'docs/记忆/README.md',
      text: [
        '# 记忆',
        '',
        '事务官写在这里的东西,真相源就是这几份 Markdown —— 你随时可以打开来读、直接改。',
        '',
        '- `用户-*.md` —— 它对你的了解。「自述」那一段只有你写;「观察」由它追加,每条带日期。',
        '- `授权.md` —— 它能读什么、能写什么、永远不动什么。**改这份文件就是改授权。**',
        '- `项目/*.md` —— 一个项目一份。',
        '',
        '（这个目录是安装工作台时建的空骨架;第一次引导走完就会有内容。）',
        '',
      ].join('\n'),
    },
    { path: 'docs/记忆/项目/.gitkeep', text: '' },
  ]
}

export interface WorkRepoResult {
  /** 目录本身建好了没有。**这一条不成立才算这一步失败。** */
  ok: boolean
  /** git 管起来了没有。没有也不算失败(见下面那段注释)。 */
  git: boolean
  /** 人话,告诉界面发生了什么。 */
  note: string
}

/**
 * 建工作仓库(幂等:已经有了就一个字不动)。
 *
 * **git 失败不算这一步失败**,这是有意的取舍:一台刚出厂的 Mac 上 `git` 只是一个壳,
 * 真跑它会弹「需要安装命令行开发者工具」的系统框 —— 在一个正在跑进度条的安装器里
 * 弹那个框,是最糟糕的体验。所以先 `xcode-select -p` 探一下,探不到就**根本不碰 git**,
 * 只把目录和骨架文件建好,并如实说一句「没有版本管理」。事务官照常能用,
 * 只是改动不会自动存版本;装了开发者工具之后在那个目录里 `git init` 一次就补上了。
 */
export async function ensureWorkRepo(io: SetupIo, paths: SetupPaths, onNote?: (text: string) => void): Promise<WorkRepoResult> {
  const dir = paths.workRepoDir
  const note = (text: string): void => { onNote?.(text) }

  const existing = await io.stat(dir)
  if (existing !== undefined && !existing.isDirectory) {
    return { ok: false, git: false, note: `${dir} 已经存在,但它是一个文件,不是文件夹。把它改个名再重试。` }
  }
  await io.mkdirp(dir)
  for (const file of workRepoFiles()) {
    if (await io.stat(`${dir}/${file.path}`) !== undefined) continue
    await io.writeFile(`${dir}/${file.path}`, file.text)
  }

  if (await io.stat(`${dir}/.git`) !== undefined) {
    note('工作目录已经有了,没动它')
    return { ok: true, git: true, note: `${dir} 已经在,原样留着` }
  }

  const tools = await io.exec(['xcode-select', '-p'])
  if (!tools.ok) {
    note('这台机器还没有命令行开发者工具,工作目录先不接版本管理')
    return { ok: true, git: false, note: `建好了 ${dir}。这台机器上还没有 git(命令行开发者工具没装),所以它暂时没有版本管理 —— 事务官照常能用,只是改动不会自动存版本。` }
  }

  note('git init')
  const init = await io.exec(['git', 'init', '-b', 'main', dir])
  if (!init.ok) {
    return { ok: true, git: false, note: `建好了 ${dir},但 \`git init\` 没成(退出码 ${init.code})。事务官照常能用,只是改动不会自动存版本。` }
  }
  // **先 add 再 commit**:骨架文件这会儿还是未跟踪的,`commit -a` 只管已跟踪的那些
  //(第一次真跑就是这么漏掉的:提交是空的,四个文件全在 `git status` 里挂着)。
  await io.exec(['git', '-C', dir, 'add', '-A'])
  // 身份现给:一台新机器上多半没配过 user.name / user.email,不给就 commit 不了。
  // **只作用于这一条命令**(-c),不动他的全局 git 配置。
  const commit = await io.exec([
    'git', '-c', 'user.name=工作台', '-c', 'user.email=workbench@localhost',
    '-C', dir, 'commit', '-q', '-m', '工作台:建立工作目录',
  ])
  if (!commit.ok) {
    return { ok: true, git: true, note: `建好了 ${dir},git 也建起来了,但第一笔提交没成(退出码 ${commit.code})。不影响用。` }
  }
  return { ok: true, git: true, note: `建好了 ${dir},并且已经用 git 管起来了。` }
}

// ───────────────────────────── 桌面整理(菜单栏 / 程序坞自动隐藏) ─────────────────────────────

/**
 * 「装的时候把顶部菜单栏和程序坞设成自动隐藏」(2026-09-27,卡 IN)。
 *
 * 维护者原话:「在安装过程中,把权限还有自动隐藏都做好了,趁我现在还没安装,这是干净的」。
 * 为什么工作台在意这个:壳的窗口铺满的是 `NSScreen.visibleFrame` —— 菜单栏与程序坞占着的那两条
 * 不在 visibleFrame 里。她的电脑是 13 寸,顶上 25pt、底下 70pt 加起来快一百点,
 * 而看板正是"一屏装多少"决定好不好用的东西(卡 TB 那一轮真机回访就是为这个)。
 *
 * ## 各系统上存的键(2026-09-27 在维护者本机 macOS 26.6.2 上 `defaults read` 读出来的,只读没写)
 *
 * | 东西 | 键 | 14 | 15 | 26 |
 * |---|---|---|---|---|
 * | 程序坞自动隐藏 | `com.apple.dock` `autohide` = true | 有 | 有 | 有 |
 * | 菜单栏自动隐藏 | `NSGlobalDomain` `_HIHideMenuBar` = true | 有 | 有 | 有 |
 * | 菜单栏「什么时候隐藏」 | `com.apple.controlcenter` `AutoHideMenuBarOption` = 0(始终) | 没有 | 没有 | **26 新增** |
 *
 * 26 上「系统设置 → 控制中心 → 自动隐藏和显示菜单栏」是四选一(从不 / 始终 / 全屏时 / 在桌面上),
 * 本机选的是「始终」,读出来是 `_HIHideMenuBar = 1` + `AutoHideMenuBarOption = 0` —— 也就是说
 * **老那个键没被废掉**,26 只是在旁边多存了一个"什么时候"。14/15 上没有 `AutoHideMenuBarOption`
 * 这个键,写了也只是多一个没人读的键(无害),所以三档系统写同一套,不按版本分岔。
 *
 * ## 即时生效到什么程度
 *
 * 程序坞:`killall Dock` 之后**当场**就自动隐藏了。
 * 菜单栏:`_HIHideMenuBar` 是登录会话级的,**要注销一次(或重启)才生效**。
 * 不去 `killall SystemUIServer` / `killall ControlCenter` 硬来 —— 那两下在 26 上会把
 * 菜单栏右边那一排图标搞成半死不活,而她这会儿正盯着一个安装器。宁可如实说一句"注销一次"。
 */
export interface DesktopTidyCommand {
  /** 真要跑的那条命令。 */
  argv: readonly string[]
  /** 它在干什么(人话,进日志与 note)。 */
  why: string
}

export interface DesktopTidyPlan {
  /** 按顺序跑。前面失败不挡后面(各自独立)。 */
  commands: readonly DesktopTidyCommand[]
  /** 菜单栏那一下要不要注销才生效(现在永远 true;哪天找到即时生效的路子就改这里)。 */
  menuBarNeedsLogout: boolean
}

export function desktopTidyPlan(): DesktopTidyPlan {
  return {
    commands: [
      { argv: ['defaults', 'write', 'com.apple.dock', 'autohide', '-bool', 'true'], why: '把程序坞设成自动隐藏' },
      { argv: ['defaults', 'write', 'NSGlobalDomain', '_HIHideMenuBar', '-bool', 'true'], why: '把顶部菜单栏设成自动隐藏' },
      // 26 才有的「什么时候隐藏」;14/15 上是一个没人读的键,无害。0 = 始终。
      { argv: ['defaults', 'write', 'com.apple.controlcenter', 'AutoHideMenuBarOption', '-int', '0'], why: '菜单栏按「始终」隐藏(macOS 26)' },
      { argv: ['killall', 'Dock'], why: '让程序坞当场重载' },
    ],
    menuBarNeedsLogout: true,
  }
}

/** 「装好了」那一屏上说这一步干了什么、去哪儿改回来的那段话。**一处定义,界面只读它。** */
export const DESKTOP_TIDY_SUMMARY = [
  '顺手把顶部菜单栏和底下的程序坞都设成了「自动隐藏」—— 鼠标碰到屏幕边上它们就出来,',
  '这样工作台能多用到那两条地方。',
  '',
  '菜单栏那一下要注销一次或者重启才看得到效果,程序坞已经生效了。',
  '想改回来:系统设置 → 桌面与程序坞(程序坞那一条),系统设置 → 控制中心 → 菜单栏(菜单栏那一条)。',
].join('\n')

export interface DesktopTidyResult {
  /** 有没有全部跑成。**这一步永远不算安装失败**(它在 INSTALLER_STEPS 里是 optional)。 */
  ok: boolean
  /** 哪几条没跑成(人话)。 */
  failed: readonly string[]
  note: string
}

/**
 * 真去写那几个键。**一条失败不挡后面**:程序坞成了、菜单栏没成,也比两条都不做好。
 * 一条都没成才回 `ok: false`(界面上那一步显示"跳过了,不影响使用")。
 */
export async function ensureDesktopTidy(io: SetupIo, onNote?: (text: string) => void): Promise<DesktopTidyResult> {
  const plan = desktopTidyPlan()
  const failed: string[] = []
  for (const command of plan.commands) {
    onNote?.(command.why)
    const result = await io.exec(command.argv)
    if (!result.ok) failed.push(`${command.why}(退出码 ${result.code})`)
  }
  if (failed.length === plan.commands.length) {
    return { ok: false, failed, note: '这台电脑不让改菜单栏和程序坞的设置,这一步跳过了 —— 不影响工作台。' }
  }
  const tail = plan.menuBarNeedsLogout ? '菜单栏那一下要注销一次或重启才看得到。' : ''
  if (failed.length > 0) {
    return { ok: true, failed, note: `桌面整理只做成了一部分(没成的:${failed.join('、')})。${tail}` }
  }
  return { ok: true, failed: [], note: `菜单栏和程序坞都设成自动隐藏了。${tail}` }
}

// ───────────────────────────── 去掉「来自网络」的标记 ─────────────────────────────

/**
 * 去掉 `com.apple.quarantine`(2026-09-27,新 Air 真机)。
 *
 * 从网页下的 dmg 带着「来自网络」的标记;安装器从 dmg 里拷出去 / 解出去的东西(壳、自带 pnpm 的 tgz
 * 解出来的每个文件)**全都继承这个标记**。维护者在「隐私与安全性」里点的「仍要打开」只放行了安装器本身,
 * 于是 pnpm 自带的 `reflink.darwin-arm64.node` 一加载、壳一打开,系统就一个个拦:「未打开…Apple 无法验证」。
 *
 * 只去**我们自己装出来的**那几处(`~/.dsh`、装好的壳),不碰系统设置、不关门禁。
 * 没有标记时 xattr 也可能回非零 —— 这一下**永远不算安装失败**,只记一行日志。
 */
export async function clearQuarantine(io: SetupIo, target: string, onLog?: (text: string) => void): Promise<void> {
  const result = await io.exec(['xattr', '-dr', 'com.apple.quarantine', target])
  if (!result.ok) onLog?.(`去掉「来自网络」的标记没成(${target},退出码 ${result.code});一般是本来就没有,不影响。`)
}

// ───────────────────────────── 跑完这几步 ─────────────────────────────

export interface RunInstallerDeps {
  io: SetupIo
  paths: SetupPaths
  bundle: InstallerBundle
  now: () => number
  newId: () => string
  emit: (event: InstallerEvent) => void
  /** 轮询作业进度的间隔。默认 1 秒;测试里给 2 毫秒。 */
  pollMs?: number
  /** 只跑其中几步(调试)。缺席 = 全部。 */
  only?: readonly string[]
  /**
   * 壳装不进 `/Applications` 时退到哪(通常是 `<home>/Applications`)。
   * 缺席 = 不退,直接把失败报出来。
   */
  fallbackApplicationsDir?: string
  /** 换掉 paths 里的 applicationsDir,拼第二套路径用(测试注入)。 */
  withApplicationsDir?: (dir: string) => SetupPaths
}

export interface InstallerOutcome {
  ok: boolean
  done: readonly string[]
  skipped: readonly string[]
  failed?: string
  /** 壳最终装在哪(可能是退下来的 ~/Applications)。 */
  shellApp: string
  workRepo: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

export async function runInstaller(deps: RunInstallerDeps): Promise<InstallerOutcome> {
  const prebuilt: SetupPrebuilt = {
    pluginTarball: deps.bundle.pluginTarball,
    shellApp: deps.bundle.shellApp,
    apk: `${deps.bundle.payloadRoot}/butler-app/android/app/build/outputs/apk/debug/app-debug.apk`,
    // 安装包里带的那份 pnpm(卡 PN):装插件那一步用它,装的时候不联网。
    pnpmTarball: deps.bundle.pnpmTarball,
  }
  const makeInstaller = (paths: SetupPaths): ReturnType<typeof createSetupInstaller> => createSetupInstaller({
    io: deps.io,
    paths,
    repoRoot: deps.bundle.payloadRoot,
    now: deps.now,
    newId: deps.newId,
    prebuilt,
    // **每一行当场转成事件**(2026-09-27,卡 PN):轮询 `tail` 必然丢行,而"出错那一步
    // 的命令与子进程原文"正是最不能丢的那几行(维护者 9/27 看到的是一块空的详细日志)。
    onLine: (_step, kind, text) => { deps.emit(kind === 'note' ? { t: 'note', text } : { t: 'log', text }) },
  })

  const pollMs = deps.pollMs ?? 1_000
  const steps = deps.only === undefined
    ? INSTALLER_STEPS
    : INSTALLER_STEPS.filter(step => deps.only?.includes(step.key) === true)
  const done: string[] = []
  const skipped: string[] = []
  let shellApp = deps.paths.shellApp
  let installer = makeInstaller(deps.paths)

  deps.emit({ t: 'begin', total: steps.length })

  /**
   * 跑一条 install.ts 的作业。
   *
   * note 与每一行日志由 `onLine` **当场**发出去(见上面那段),这里只负责等它跑完 ——
   * 原来这一段按轮询从 `view.tail` 里取增量,而 `tail` 是 20 行的滑动窗口:
   * 窗口一满,`slice(seenTail)` 永远是空的,再往后的每一行都丢。
   */
  const runJob = async (paths: SetupPaths, step: SetupInstallStep): Promise<SetupJobView> => {
    const runner = paths === deps.paths ? installer : makeInstaller(paths)
    const started = runner.start(step)
    let view = started
    for (;;) {
      view = runner.job(started.id) ?? view
      if (view.state !== 'running') break
      await sleep(pollMs)
    }
    return view
  }

  for (const [index, spec] of steps.entries()) {
    deps.emit({ t: 'step', i: index + 1, n: steps.length, key: spec.key, title: spec.title })

    if (spec.local === 'desktop') {
      // 桌面整理(2026-09-27,卡 IN):菜单栏 + 程序坞自动隐藏。**跑不成只跳过,不算安装失败。**
      const tidy = await ensureDesktopTidy(deps.io, text => deps.emit({ t: 'note', text }))
      if (!tidy.ok) {
        deps.emit({ t: 'skip', key: spec.key, why: tidy.note })
        skipped.push(spec.key)
        continue
      }
      deps.emit({ t: 'note', text: tidy.note })
      done.push(spec.key)
      continue
    }

    if (spec.setupStep === undefined) {
      // 安装器自己做的那一步:建工作仓库 + 写 app.json。
      const result = await ensureWorkRepo(deps.io, deps.paths, text => deps.emit({ t: 'note', text }))
      if (!result.ok) {
        deps.emit({ t: 'fail', key: spec.key, title: spec.title, error: result.note, tail: [], optional: false })
        return { ok: false, done, skipped, failed: spec.key, shellApp, workRepo: deps.paths.workRepoDir }
      }
      await writeButlerCwd(deps.io, deps.paths, deps.paths.workRepoDir)
      deps.emit({ t: 'note', text: result.note })
      done.push(spec.key)
      continue
    }

    // 每一步开跑之前把 ~/.dsh 去掉标记:上一步解出来的东西(自带的 pnpm、node)这一步就要执行。
    await clearQuarantine(deps.io, deps.paths.dshHome, text => deps.emit({ t: 'log', text }))
    let view = await runJob(deps.paths, spec.setupStep)

    // 壳装不进 /Applications:退到 ~/Applications 再试一次,并且**说清楚退到哪了**。
    if (view.state === 'failed' && spec.key === 'shell' && deps.fallbackApplicationsDir !== undefined && deps.withApplicationsDir !== undefined) {
      const fallback = deps.withApplicationsDir(deps.fallbackApplicationsDir)
      deps.emit({ t: 'note', text: `装不进 /Applications(多半是这台电脑不让改那个文件夹),改装到 ${fallback.shellApp}` })
      await deps.io.mkdirp(deps.fallbackApplicationsDir)
      view = await runJob(fallback, spec.setupStep)
      if (view.state === 'done') shellApp = fallback.shellApp
    }

    if (view.state === 'failed') {
      if (spec.optional === true) {
        deps.emit({ t: 'skip', key: spec.key, why: view.error ?? '这一步没做成' })
        skipped.push(spec.key)
        continue
      }
      deps.emit({
        t: 'fail',
        key: spec.key,
        title: spec.title,
        error: view.error ?? '失败了,但没说原因',
        tail: view.tail,
        optional: false,
      })
      return { ok: false, done, skipped, failed: spec.key, shellApp, workRepo: deps.paths.workRepoDir }
    }
    // 壳装好了立刻去标记:下一步(开机自启)就会把它拉起来。
    if (spec.key === 'shell') await clearQuarantine(deps.io, shellApp, text => deps.emit({ t: 'log', text }))
    done.push(spec.key)
    if (spec.key === 'node') installer = makeInstaller(deps.paths)
  }

  // 收尾再去一遍:最后那一步(开机自启)装出来的东西也不能带着标记。
  await clearQuarantine(deps.io, deps.paths.dshHome, text => deps.emit({ t: 'log', text }))
  deps.emit({ t: 'done', shell_app: shellApp, work_repo: deps.paths.workRepoDir })
  return { ok: true, done, skipped, shellApp, workRepo: deps.paths.workRepoDir }
}

// ───────────────────────────── 命令行参数 ─────────────────────────────

export interface InstallerArgs {
  /** `Resources` 目录(.app 里那个)。 */
  resources: string
  home: string
  dshHome: string
  /** 事件用 JSON 打(界面读),否则打人话(命令行验收读)。 */
  json: boolean
  /** 只跑其中几步。 */
  only?: readonly string[]
  /** 什么都不装,只把「要装哪几步」打出来。 */
  plan: boolean
  /**
   * 一条 `launchctl` 都不跑。**在临时 HOME 里验证时必须给** —— 真装载会把一个
   * 指着临时目录的 launchd 项塞进当前登录会话,和正在跑的那台服务抢 3080/8791。
   * 与 `deploy/bootstrap.sh` 的同名开关同一个理由。
   */
  noLaunch: boolean
  /** 壳装到哪。缺省 /Applications;临时 HOME 里验证时传一个临时目录。 */
  applicationsDir?: string
  /**
   * 这一趟的完整日志写到哪(2026-09-27,卡 PN)。
   *
   * 由 `stage0.sh` 决定并经 `WORKBENCH_INSTALL_LOG` 传下来 —— **它先跑**(下 node 那一段),
   * 两边写同一个文件,一趟安装才是一份完整的日志。自己直接跑内核时按 `installLogPath` 现算一个。
   */
  logFile: string
}

export type InstallerArgsResult = { ok: true, args: InstallerArgs } | { ok: false, error: string }

export function parseInstallerArgs(argv: readonly string[], env: Record<string, string | undefined>, now: Date = new Date()): InstallerArgsResult {
  let resources: string | undefined
  let home: string | undefined
  let dshHome: string | undefined
  let json = false
  let plan = false
  let noLaunch = false
  let applicationsDir: string | undefined
  let logFile: string | undefined
  let only: readonly string[] | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string
    const next = (): string | undefined => { i += 1; return argv[i] }
    switch (flag) {
      case '--resources': resources = next(); break
      case '--home': home = next(); break
      case '--dsh-home': dshHome = next(); break
      case '--json': json = true; break
      case '--human': json = false; break
      case '--plan': plan = true; break
      case '--no-launch': noLaunch = true; break
      case '--applications': applicationsDir = next(); break
      case '--log-file': logFile = next(); break
      case '--steps': {
        const names = (next() ?? '').split(',').map(name => name.trim()).filter(name => name !== '')
        const bad = names.filter(name => installerStep(name) === undefined)
        if (bad.length > 0) {
          return { ok: false, error: `不认识这几步:${bad.join('、')}。只有这几步:${INSTALLER_STEPS.map(step => step.key).join('、')}。` }
        }
        only = names
        break
      }
      default:
        return { ok: false, error: `不认识的参数:${flag}。能用的是 --resources / --home / --dsh-home / --applications / --log-file / --steps / --json / --human / --plan / --no-launch。` }
    }
  }

  const trim = (path: string): string => (path === '/' ? path : path.replace(/\/+$/, ''))
  const resolvedResources = trim(resources ?? env.WORKBENCH_INSTALLER_RESOURCES ?? '')
  if (resolvedResources === '') return { ok: false, error: '不知道安装包里的资源在哪:给一个 --resources <.app 里的 Resources 目录>。' }
  const resolvedHome = trim(home ?? env.HOME ?? '')
  if (resolvedHome === '') return { ok: false, error: '不知道家目录在哪:既没有 --home,环境里也没有 HOME。' }

  return {
    ok: true,
    args: {
      resources: resolvedResources,
      home: resolvedHome,
      dshHome: trim(dshHome ?? env.DSH_HOME ?? `${resolvedHome}/.dsh`),
      json,
      plan,
      noLaunch,
      ...(applicationsDir === undefined || applicationsDir === '' ? {} : { applicationsDir: trim(applicationsDir) }),
      // 日志文件:`--log-file` > `WORKBENCH_INSTALL_LOG`(stage0.sh 传下来的那一份)> 现算一个。
      logFile: logFile ?? env.WORKBENCH_INSTALL_LOG ?? installLogPath(resolvedHome, now),
      ...(only === undefined ? {} : { only }),
    },
  }
}
