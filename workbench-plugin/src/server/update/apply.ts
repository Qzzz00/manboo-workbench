/**
 * 「立即更新」按下去之后真正发生的事(2026-09-18)。
 *
 * ## 一行安装逻辑都没有重写
 *
 * 这是整张卡最要紧的一条,照抄桌面安装包那张卡的做法:**把下载解包出来的东西摆成仓库的
 * 样子**,然后直接调 `setup/install.ts` 那份现成的代码。于是 plugin / scripts / butler /
 * worker / shell / launchd 六步一个字都不用改 —— 它们要的本来就只是「仓库里的那几个文件」,
 * 而不是「一个真的 git 仓库」。
 *
 * ```
 * ~/.dsh/updates/0.2.42/
 *   assets/          下下来的原件(断了接着下,校验过才算数)
 *   payload/         解开之后:butler-server/ channel-worker/ workbench-plugin/bin/ deploy/
 *   shell/工作台.app  壳(单独解,因为要先验签名身份)
 * ```
 *
 * ## 顺序与为什么
 *
 * 下载 → plugin → scripts → butler → worker → livekit → shell → launchd → 重启。
 * 插件排在最前:它是唯一必须有的一样,先把它装进 profile,后面哪一步出岔子,
 * 点一次「重试」也只是从断的那一步接着来(每一步都幂等)。重启排在最后 ——
 * 它会把**正在跑这个作业的这个进程**杀掉,后面再排任何一步都没有意义。
 *
 * ## 壳那一步的门
 *
 * macOS 的 TCC(辅助功能授权)认的是 App 的 designated requirement。签名身份一换,
 * DR 就换一条,系统把它当成另一个 App —— **用户的辅助功能授权当场失效**,窗位、拖窗、
 * 认领全废,要去系统设置里关一次再开。所以这一步有一道门:**现装的那份壳与要换上去的
 * 那份,DR 逐字相同才换**;对不上就跳过,并在结尾如实说一句为什么。
 * 一次自动更新不该把人的授权悄悄弄掉(0918 壳稳定签名那张卡第 8 条)。
 */
import { createSetupInstaller } from '../setup/install.ts'
import type { SetupIo } from '../setup/io.ts'
import { tailLines } from '../setup/io.ts'
import type { SetupPaths } from '../setup/paths.ts'
import { DSH_LAUNCHD_LABEL, SHELL_APP_NAME } from '../setup/paths.ts'
import type { SetupInstallStep, SetupJobView } from '../setup/types.ts'
import { downloadAsset, UpdateDownloadError } from './download.ts'
import { absentKindsOf, emptyInstalled, localShaOf, planAssets, readInstalled, writeInstalled } from './installed.ts'
import type { InstalledAssetRecord, UpdateAssetKind, UpdateJobView, UpdateManifest } from './types.ts'
import { humanSize, UPDATE_ASSET_TITLES } from './types.ts'

/** 下一件产物给多久。工人包 350MB,在慢网上半小时并不夸张。 */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 40 * 60_000
/** 解包 / rsync / ditto 这类:10 分钟足够,再久多半是卡住了。 */
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60_000
/** 子步骤跑着的时候,多久把它那句人话抄进更新作业一次。 */
const DEFAULT_SUB_POLL_MS = 500
/**
 * 发出 `launchctl kickstart` 之前等一下。
 *
 * 这一下会把**正在跑这个作业的进程**杀掉,所以必须先让界面有机会轮到「装好了,正在重启」
 * 那一拍 —— 界面 1 秒问一次,1.5 秒够它看到一次。不等的话人看到的是:点了更新,
 * 页面忽然连不上,什么也没说。
 *
 * **这一拍等在哪**:2026-10-13 之前等在这个进程自己的 `setTimeout` 里(而且 unref),
 * 于是进程在这 1.5 秒里没了那一下就永远不会发出去 —— 见 `scheduleRestart`。
 * 现在这个数是递给那个 detach 出去的 `sh` 的 `sleep`,与这个进程的生死无关。
 */
const DEFAULT_RESTART_DELAY_MS = 1_500

/**
 * 重启那一下发出去之后,**这个进程还活着多久就认为它没到 launchd**(2026-10-13)。
 *
 * 正常路径上这个数永远走不到:`kickstart -k` 一到,launchd 当场把这个进程(连它的
 * 整个进程组)杀掉。走到了就说明那一下没生效(launchctl 没起来 / 请求没送到),
 * 这时候**自己以非 0 退出**,让 plist 里 `KeepAlive.SuccessfulExit=false` 把服务拉起来
 * —— 这是 plist 为「崩了自愈」留的那条路,不是另造一条。
 *
 * 给 20 秒:launchd 的 `ThrottleInterval`(plist 里 10)会让它最多晚 10 秒才真起来,
 * 量到的实际间隔约 9 秒(交接里的 E-A)。20 秒 = 留一倍余量。
 */
const DEFAULT_RESTART_WATCHDOG_MS = 20_000

/**
 * 换完壳之后自动重开那一段(2026-09-21)。
 *
 * 以前换完壳只能在界面上写一句「把工作台窗口关掉重开一次」—— 屏幕上跑着的还是换之前
 * 那份二进制。对一个不懂代码的人,一次"自动更新"最后要他自己动手关一扇窗,
 * 那句话本身就是这条流程没做完的证据。
 */
/** 壳的 bundle id(workbench-app/Info.plist 里那一条)。 */
const SHELL_BUNDLE_ID = 'ai.ben.workbench'
/**
 * 拉起新壳时带的那个参数。**与 `workbench-app/Sources/ShellRelaunch.swift` 里的
 * `ShellRelaunch.flag` 逐字相同** —— 两边各有一条用例钉着这一串字。
 */
export const SHELL_RELAUNCH_FLAG = '--relaunched-by-update'
/** 等旧壳退出的上限。到点还没退就**不强杀**,改成如实告诉他手动重开一次。 */
const DEFAULT_SHELL_QUIT_TIMEOUT_MS = 10_000
/** 多久问一次「它退了没有」。 */
const DEFAULT_SHELL_QUIT_POLL_MS = 250

/**
 * 每样产物解到哪去。`tar` 那几样一律解进 payload(按仓库相对路径打的包,解开就是仓库的样子)。
 *
 * `runtime_tgz` 也在里面:它打的是 `workbench-plugin/src/server/setup/dsh-runtime/` 那两个文件
 * 的仓库相对路径,所以解进 payload 之后正好落在"仓库的样子"里那个位置,
 * `prebuilt.runtimeLockDir` 就是那一条路径(见下面 `runtimeLockDir`)。
 */
const TAR_ASSETS: readonly UpdateAssetKind[] = ['scripts_tgz', 'runtime_tgz', 'butler_server_tgz', 'channel_worker_tgz', 'livekit_tgz']

/**
 * 解包之后那一对运行环境清单在 payload 里的相对位置。
 * **与 `publish-update.sh` 打 `runtime.tgz` 时用的仓库相对路径逐字相同**,两边各有用例钉着。
 */
export const RUNTIME_LOCK_PAYLOAD_DIR = 'workbench-plugin/src/server/setup/dsh-runtime'

/**
 * 下下来的原件叫什么名字。**不用 URL 里的文件名** —— 那是服务器说了算的东西,不该决定我们往哪写。
 *
 * `apk` 与 `installer_dmg` 这台机器**从来不下载**(见 `DOWNLOADED_ASSET_KINDS`),
 * 这两格只是把表填满 —— 少一格 TypeScript 就不让过,而这正是想要的:以后新加一样产物,
 * 这里一定会红,由加它的人来答「下下来叫什么名字」。
 */
const ASSET_FILENAMES: Record<UpdateAssetKind, string> = {
  plugin_tgz: 'plugin.tgz',
  scripts_tgz: 'scripts.tgz',
  runtime_tgz: 'runtime.tgz',
  shell_app_zip: 'shell-app.zip',
  butler_server_tgz: 'butler-server.tgz',
  channel_worker_tgz: 'channel-worker.tgz',
  livekit_tgz: 'livekit.tgz',
  apk: 'app.apk',
  installer_dmg: '工作台安装器.dmg',
}

export interface UpdateApplyDeps {
  io: SetupIo
  paths: SetupPaths
  now: () => number
  newId: () => string
  /** 这会儿跑着的插件版本。只用来写进日志与作业视图。 */
  currentVersion: string
  downloadTimeoutMs?: number
  buildTimeoutMs?: number
  /** 子步骤进度回抄间隔。测试传 0 = 不起定时器。 */
  subPollMs?: number
  /** 下载时多久 stat 一次半成品文件。测试传 0 = 不起定时器。 */
  downloadPollMs?: number
  /** 发重启之前等多久(等在那个 detach 出去的 sh 里)。测试传 0 = 不等。 */
  restartDelayMs?: number
  /**
   * 重启发出去之后还活着多久就自己以非 0 退出(2026-10-13)。0 = 不设这道保险。
   * 缺省 `DEFAULT_RESTART_WATCHDOG_MS`。
   */
  restartWatchdogMs?: number
  /**
   * 那道保险真要动手时调谁(2026-10-13)。生产接的是 `() => process.exit(1)`。
   *
   * **缺席 = 不设保险**:它会把整个 DSH 进程结束掉,不该由一个库自己决定,
   * 也不该在用例里有机会真发生(没有哪一条用例传它)。
   */
  hardRestart?: () => void
  /** 等旧壳退出的上限(2026-09-21)。测试传 0 = 一轮都不等,当场判它没退。 */
  shellQuitTimeoutMs?: number
  /** 问「旧壳退了没有」的间隔。 */
  shellQuitPollMs?: number
  /**
   * 这一条更新作业失败了(2026-09-22,自动上报里那一类 `update_failed`)。
   *
   * 为什么值得单独报:更新失败是**最容易让一台脱机的机器从此停在旧版本上**的一件事,
   * 而 Ben 那头看到的只是一个红框,他多半会点两下重试然后放下。日志尾巴在 `tail` 里,
   * 那正是排它唯一要看的东西。
   *
   * **每条作业只喊一次**(就在这里,状态变成 failed 的那一刻),不是界面轮询时喊。
   */
  onFailed?: (view: { id: string, version?: string, error: string, tail: readonly string[] }) => void
}

export interface UpdateApplyRun {
  view: UpdateJobView
  done: Promise<void>
}

/** 一步安装子任务的描述。`when` 回 false 就整步跳过(并记一句人话)。 */
interface PlannedStep {
  step: SetupInstallStep
  phase: string
  /** 缺这样产物就跳过;undefined = 不依赖任何下载物。 */
  needs?: UpdateAssetKind
  /**
   * **伴随步**:只在这一趟真有东西要装的时候才跑(2026-09-26,卡 U6)。
   *
   * `profile` 是这一档:它不依赖任何下载物,所以要是不加这个标记,它就会**永远**在步骤表里
   * —— 那会把「一样都没变(发版的人只 bump 了版本号)就不重启」那条规矩弄坏
   * (steps 永不为空 → 每次都重启一遍,把正开着的网页白踢一下)。
   * 装什么都没装的时候,也谈不上"把配置核对成这一版该有的样子"。
   */
  companion?: boolean
}

/**
 * 安装那几步的顺序。
 *
 * **`runtime` 为什么排在最后一步**(2026-09-25,升 0.1.7 时加的这一步):
 *
 * ① 它最后一个动作是把 `~/.dsh/runtime` 换名、把新那棵树换上去。换名不影响已经加载进内存的
 *    模块,但换名**之后**才发生的惰性 import 会打到新那棵树上 —— 所以这一下离
 *    `launchctl kickstart` 越近越好。排在最后,窗口只有那几秒;真撞上了也自愈:
 *    plist 写着 `KeepAlive.SuccessfulExit=false`,崩一下 launchd 立刻拉起,
 *    拉起来的就是新运行时 + 新插件。
 * ② 插件那一步跑的是 `dsh plugin --profile web add`,用的是**这会儿装着的**那份 dsh。
 *    先换运行时的话,那条命令会由新版 dsh 来跑,而它装前要查插件的 peer ——
 *    多一层这一趟没必要承担的风险。
 * ③ 反过来更要紧:插件那一步失败时整趟作业抛错、**不重启**,于是机器上跑着的还是旧插件 +
 *    旧运行时,一切照常;而如果先换了运行时再在插件上失败,重启之后就是"新 dsh + 旧插件",
 *    0.1.7 的启动预检(app-boot 的 `plugin-compatibility`)会按 peer 判它不兼容 —— 白屏。
 */
const PLANNED_STEPS: readonly PlannedStep[] = [
  { step: 'plugin', phase: '正在安装工作台本体', needs: 'plugin_tgz' },
  { step: 'scripts', phase: '正在更新启动脚本', needs: 'scripts_tgz' },
  { step: 'butler', phase: '正在更新事务官本机后端', needs: 'butler_server_tgz' },
  { step: 'worker', phase: '正在更新通话组件', needs: 'channel_worker_tgz' },
  /**
   * 本机通话服务(2026-10-21,卡 M1)。排在 launchd 之前:它自己会把 `ai.deepseek.livekit` 装载上(启动脚本那一份
   * 没变、launchd 那一步不跑的时候也补得上);launchd 那一步再核一次,装载过就跳过。
   */
  { step: 'livekit', phase: '正在更新本机通话服务', needs: 'livekit_tgz' },
  { step: 'shell', phase: '正在更换工作台窗口', needs: 'shell_app_zip' },
  { step: 'launchd', phase: '正在核对开机自启', needs: 'scripts_tgz' },
  /**
   * **配置那一步为什么也进热更新**(2026-09-26,卡 U6)。
   *
   * 这一步(`setup/install.ts` 的 `profile`)只做一件事:把工作台在 DSH 里那份补丁层
   * 核对成这一版该有的样子(哪几行关掉、cookie 寿命那一行的 id)。原来它**只在一键装里跑**,
   * 于是已经装好的机器**永远收不到配置的修正** —— U4 查出 cookie 那一行的 id 从 0.1.2 起
   * 一直写错、一直被静默跳过,就是这个缝:热更新换了插件,却没人去改那份补丁。
   *
   * 它不依赖任何下载物(`needs` 缺席),幂等(该有的都在就一个字不动),
   * 排在 `runtime` 之前 —— 补丁是给重启之后那个 DSH 读的,先写好再换运行时。
   */
  { step: 'profile', phase: '正在核对工作台在 DSH 里的配置', companion: true },
  { step: 'runtime', phase: '正在更新运行环境', needs: 'runtime_tgz' },
]

/**
 * 「只补运行环境」那一趟跑哪几步(2026-09-26,卡 U6)。
 *
 * 插件本体已经是新版了(旧客户端那趟热更新把它装上了),差的只有运行环境与那份配置。
 * 所以不碰插件 / 脚本 / 事务官 / 通话组件 / 壳 / launchd —— 它们一个字节都没变,
 * 动它们只是多几次失败的机会。最后照旧重启(`applyAll` 结尾那一下)。
 */
export const RUNTIME_ONLY_STEPS: readonly SetupInstallStep[] = ['profile', 'runtime']

/**
 * 这一趟更新的范围(2026-09-26,卡 U6)。缺省(不传)= 今天的行为:清单里有什么就装什么。
 *
 * 运行环境漂移那一趟传的是:`steps = RUNTIME_ONLY_STEPS`、`assets = ['runtime_tgz']`、
 * `force = ['runtime_tgz']`(理由见 `planAssets` 的 `scope.force`)。
 */
export interface UpdateIntent {
  /** 只跑这几步(缺省 = `PLANNED_STEPS` 全部)。 */
  steps?: readonly SetupInstallStep[]
  /** 只下这几件(缺省 = 清单里能下的全部)。 */
  assets?: readonly UpdateAssetKind[]
  /** 这几件一律当"变了"(不管 `installed.json` 里记着什么)。 */
  force?: readonly UpdateAssetKind[]
  /**
   * 本机那份现算出来的 sha **胜过** `installed.json` 里那条记录(2026-10-03)。
   * 「版本号一样、还有组件没装上」那一趟传 true —— 理由全文见 `installed.ts` 的
   * `UpdatePlanScope.localFirst`。**必须与 check() 那一趟传的那一份相同**,
   * 否则这里会把发版闸刚装好的插件再装一遍、再重启一次。
   */
  localFirst?: boolean
  /** 开头写进日志的那一句(说清这一趟是干什么的)。 */
  says?: string
}

/**
 * 进度条上的数:下载占 0–60,解包 60–65,安装那几步 65–95,重启 100。
 *
 * 这几个分界是按**耗时**拍的,不是按步数:一次典型更新里下载就是大头(哪怕只有插件那
 * 1MB,握手加验证也比往 profile 里装快不了多少),而 rsync 本地文件是秒级的。
 * 它是个进度条,不是个测量仪 —— 但它**不会退回去**,也不会在一个地方停死不动。
 */
export function progressOf(stage: 'download' | 'extract' | 'install' | 'restart', done: number, total: number): number {
  const frac = total <= 0 ? 1 : Math.min(1, Math.max(0, done / total))
  if (stage === 'download') return Math.round(frac * 60)
  if (stage === 'extract') return 60 + Math.round(frac * 5)
  if (stage === 'install') return 65 + Math.round(frac * 30)
  return 100
}

/**
 * 重启那一下到底发什么(2026-10-13)。**等那一拍等在 sh 里,不在这个进程的定时器里**
 * —— 为什么见 `scheduleRestart`。
 *
 * `target` 是 `gui/<uid>/<label>`,里头不含空格,所以这一串拼进 `sh -c` 是安全的。
 * `exec` 让那个 sh 把自己换成 launchctl,中间不多挂一个进程。
 */
export function restartHandoffCommand(target: string, delayMs: number): readonly string[] {
  const kick = `exec launchctl kickstart -k ${target}`
  const seconds = Math.max(0, delayMs) / 1000
  return ['/bin/sh', '-c', seconds <= 0 ? kick : `sleep ${Number(seconds.toFixed(3))}; ${kick}`]
}

/**
 * 那一下连发都没发出去时,给人看的救法(2026-10-13)。
 *
 * **不带 `-k` 的那一句**:对还在跑的项它什么都不做(量过,交接里的 E-E),
 * 所以人照着跑一遍不会把一个好着的服务弄掉。
 */
export function restartRescueHint(target: string): string {
  return `更新装好了,但**自动重启那一下没发出去**。工作台窗口再等一会儿会自己拉一次;`
    + `还不行就在终端里跑这一句:launchctl kickstart ${target}(或者注销重登一次)。`
}

/** `codesign -d -r -` 打出来的那一条 designated requirement。读不出来回 undefined —— 不猜。 */
export function requirementOf(text: string): string | undefined {
  const line = /designated =>(.*)/.exec(text)?.[1]?.trim()
  return line === undefined || line === '' ? undefined : line
}

/**
 * 换不换壳。三种结局,每一种都有一句给 Ben 看的话。
 *
 * - `install`:没装过(第一次)、或者两边 DR 逐字相同 —— 换,授权不会掉。
 * - `skip`:DR 不一样,或者哪一边读不出来 —— 不换。**读不出来时也不换**(D13:
 *   「没查出来」不能当成「查过了、没问题」;猜错的代价是人的授权被悄悄弄掉)。
 */
export function shellDecision(installed: string | undefined, incoming: string | undefined, hasInstalledApp: boolean): { action: 'install' | 'skip', why: string } {
  if (!hasInstalledApp) {
    return { action: 'install', why: '这台机器的「应用程序」里还没有工作台窗口,这次一并装上。' }
  }
  if (incoming === undefined) {
    return { action: 'skip', why: `没换工作台窗口:读不出新那份壳的签名(codesign 没给出 designated requirement),不敢换 —— 换错了你的辅助功能授权会掉。窗口那一块保持原样,别的都更新了。` }
  }
  if (installed === undefined) {
    return { action: 'skip', why: '没换工作台窗口:读不出现在这份壳的签名,没法确认换了会不会掉授权。窗口那一块保持原样,别的都更新了。' }
  }
  if (installed !== incoming) {
    return { action: 'skip', why: '没换工作台窗口:新那份壳的签名身份跟你现在装的这份不一样,换上去 macOS 会当成另一个 App,**辅助功能授权会当场失效**(窗位、拖窗、认领都会停)。所以这次跳过它,别的都更新了。要换的话去「体检与修复」里单独点「壳 App」,点之前给自己留出重新授权的时间。' }
  }
  return { action: 'install', why: '签名身份跟现在这份一致,换了不会掉授权。' }
}

/**
 * 真跑一次更新。回一条**立刻就能轮询的**作业视图 + 一个跑完才 resolve 的 Promise。
 *
 * 跟登录台的作业一个形状(`SetupJobView` 的超集),所以界面上那个进度框是同一个组件。
 */
export function runUpdate(deps: UpdateApplyDeps, manifest: UpdateManifest, intent: UpdateIntent = {}): UpdateApplyRun {
  const id = deps.newId()
  const lines: string[] = []
  const skipped: string[] = []
  /** 跟本机装着的那份一模一样、这次整件跳过的(2026-09-18)。跟 skipped 是两件事,见 types.ts。 */
  const unchanged: string[] = []
  const view: UpdateJobView = {
    id,
    step: 'update',
    state: 'running',
    started_at: new Date(deps.now()).toISOString(),
    tail: [],
    version: manifest.version,
    progress: 0,
    phase: '正在准备',
    skipped,
    unchanged,
  }
  const log = (line: string): void => {
    lines.push(line)
    if (lines.length > 400) lines.splice(0, lines.length - 400)
    view.tail = tailLines(lines.join('\n'))
  }
  const note = (text: string): void => { view.note = text }
  const phase = (text: string, progress: number): void => {
    view.phase = text
    view.progress = Math.max(view.progress, progress)
  }

  /** 这台机器上「已经装着哪一份」的备忘。applyAll 一进来就读。 */
  let installed = emptyInstalled()
  /** 这一趟已经下好、放在手上的那几件(人话名字)。失败那句话要说得出"哪几样不用重下"。 */
  const ready: string[] = []
  /** 这会儿正在下的是哪一件。都下完了是 undefined。 */
  let currentTitle: string | undefined

  const downloadTimeoutMs = deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  const buildTimeoutMs = deps.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS
  const subPollMs = deps.subPollMs ?? DEFAULT_SUB_POLL_MS
  const restartDelayMs = deps.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS
  const restartWatchdogMs = deps.restartWatchdogMs ?? DEFAULT_RESTART_WATCHDOG_MS
  const downloadPollMs = deps.downloadPollMs
  const shellQuitTimeoutMs = deps.shellQuitTimeoutMs ?? DEFAULT_SHELL_QUIT_TIMEOUT_MS
  const shellQuitPollMs = deps.shellQuitPollMs ?? DEFAULT_SHELL_QUIT_POLL_MS

  /**
   * 下载这一段的账:已下 / 总量 / 速度 / 预计剩余(2026-09-18,0918 那张卡第 4 条欠的)。
   *
   * 两条规矩:
   * ① **速度是最近一段的**(指数滑动),不是从头到现在的平均 —— 平均数在网速变了之后
   *    要好几分钟才跟得上,而人看进度条正是想知道"这会儿快不快"。
   * ② **算不出来就不给**。刚开始下的头一秒、或者时钟根本没动(用例里注入的假 now),
   *    速度与预计剩余一律缺席;界面那半句话跟着消失。宁可少一句,不给一个假的。
   */
  let speed: number | undefined
  let mark: { at: number, bytes: number } | undefined

  function startDownload(total: number): void {
    speed = undefined
    mark = { at: deps.now(), bytes: 0 }
    view.download = { total, done: 0 }
  }

  function reportBytes(bytes: number): void {
    const current = view.download
    if (current === undefined) return
    const at = deps.now()
    const done = Math.max(current.done, Math.min(bytes, current.total))
    const since = mark === undefined ? 0 : at - mark.at
    // 一秒一算:更密的话分母太小,速度会在屏幕上乱跳。
    if (mark !== undefined && since >= 1000 && done > mark.bytes) {
      const instant = (done - mark.bytes) / (since / 1000)
      speed = speed === undefined ? instant : speed * 0.6 + instant * 0.4
      mark = { at, bytes: done }
    }
    const left = current.total - done
    view.download = {
      total: current.total,
      done,
      ...(speed === undefined || speed <= 0 ? {} : { bytes_per_sec: Math.round(speed) }),
      ...(speed === undefined || speed <= 0 ? {} : { eta_seconds: Math.max(0, Math.round(left / speed)) }),
      ...(currentTitle === undefined ? {} : { current: currentTitle }),
    }
    phase('正在下载', progressOf('download', done, current.total))
  }

  const root = `${deps.paths.updatesDir}/${manifest.version}`
  const assetsDir = `${root}/assets`
  const payloadDir = `${root}/payload`
  const shellDir = `${root}/shell`

  const done = (async () => {
    try {
      await applyAll()
      view.state = 'done'
    }
    catch (error) {
      view.state = 'failed'
      view.error = error instanceof UpdateDownloadError || error instanceof Error
        ? error.message
        : String(error)
      if (!(error instanceof UpdateDownloadError) && error instanceof Error && !(error as { humane?: boolean }).humane) {
        // 没预料到的错也要说人话再带上原文 —— 光一句 ENOENT 对 Ben 没有任何意义。
        view.error = `更新没做完:${error.message}`
      }
      // **断在一样上,不等于整包重来**(2026-09-18)。已经下好的那几样就在硬盘上,
      // 点「重试」时 downloadAsset 第 ① 条会把它们原样认出来 —— 这句话是让人敢按第二下的依据。
      if (ready.length > 0) {
        view.error = `${view.error}\n已经下好的不用重下:${ready.join('、')}。点「重试」只补没下完的那一样。`
      }
    }
    finally {
      view.finished_at = new Date(deps.now()).toISOString()
      view.tail = tailLines(lines.join('\n'))
      if (view.state === 'failed') {
        deps.onFailed?.({
          id: view.id,
          ...(manifest.version === undefined ? {} : { version: manifest.version }),
          error: view.error ?? '更新失败(没写出原因)',
          tail: view.tail,
        })
      }
    }
  })()

  async function applyAll(): Promise<void> {
    log(intent.says ?? `从 ${deps.currentVersion} 更新到 ${manifest.version}`)
    await deps.io.mkdirp(assetsDir)

    // ── 只下变了的(2026-09-18)──
    // **在这儿现算一遍,不用「检查更新」那会儿算的那份**:那可能是几小时前的结论,
    // 而中间可能已经装过一趟(上次断在半路、重试)。账要跟这一刻的机器对得上。
    installed = await readInstalled(deps.io, deps.paths)
    const plan = planAssets(manifest, installed, await localShaOf(deps.io, deps.paths), {
      ...(intent.assets === undefined ? {} : { only: intent.assets }),
      ...(intent.force === undefined ? {} : { force: intent.force }),
      ...(intent.localFirst === undefined ? {} : { localFirst: intent.localFirst }),
    }, await absentKindsOf(deps.io, deps.paths, manifest))
    for (const item of plan.items) {
      log(item.why)
      if (!item.changed) unchanged.push(item.why)
    }
    log(plan.changed === plan.total
      ? `${plan.total} 样都要下,合计 ${humanSize(plan.bytes)}`
      : `${plan.total} 样里 ${plan.changed} 样有变化,这次下 ${humanSize(plan.bytes)}(不比对的话要下 ${humanSize(plan.all_bytes)})`)

    // ── 下载 ──
    const wanted = plan.items.filter(item => item.changed)
    const totalBytes = plan.bytes
    /** 已经整件下完的字节数。正在下的那件另算(见 reportBytes)。 */
    let doneBytes = 0
    startDownload(totalBytes)
    const files: Partial<Record<UpdateAssetKind, string>> = {}
    for (const [index, item] of wanted.entries()) {
      const kind = item.kind
      const asset = manifest.assets[kind]
      if (asset === undefined) continue
      const title = item.title
      currentTitle = title
      reportBytes(doneBytes)
      note(`正在下载 ${index + 1}/${wanted.length}:${title}(${humanSize(asset.size)})`)
      const base = doneBytes
      const outcome = await downloadAsset(
        {
          io: deps.io,
          log,
          timeoutMs: downloadTimeoutMs,
          // 下着的时候盯着那个半成品文件有多大 —— 0918 那张卡第 4 条欠的百分比,这里还上。
          onProgress: (bytesOnDisk) => { reportBytes(base + Math.min(bytesOnDisk, asset.size)) },
          ...(downloadPollMs === undefined ? {} : { progressPollMs: downloadPollMs }),
        },
        asset,
        `${assetsDir}/${ASSET_FILENAMES[kind]}`,
        title,
      )
      files[kind] = outcome.path
      // 下好一件就把它记进「已经在手上的」——下一件失败时那句话要说得出"哪几样不用重下"。
      ready.push(title)
      doneBytes = base + asset.size
      reportBytes(doneBytes)
    }
    currentTitle = undefined
    reportBytes(doneBytes)

    // 没变的那几样,产物压根没落到这一版的 assets 目录里 —— 于是 `files` 里也没有它,
    // 下面挑安装步骤时那一条自然就被滤掉了(同一个判断,不用第二套口径)。

    // ── 解包:摆成仓库的样子 ──
    phase('正在解包', progressOf('extract', 0, 1))
    note('正在解开下下来的包')
    // 每次都从一个干净的 payload 开始:上一趟解到一半的残件会让 rsync --delete 把
    // 半棵树同步到 ~/.dsh 去。**只删这一棵**,而且它是由 paths.updatesDir 算出来的
    // (2026-09-04 家目录事故之后,能被 rmrf 的路径一律由 paths 算,不由字符串拼)。
    await deps.io.rmrf(payloadDir)
    await deps.io.mkdirp(payloadDir)
    for (const kind of TAR_ASSETS) {
      const file = files[kind]
      if (file === undefined) continue
      log(`解包 ${UPDATE_ASSET_TITLES[kind]}`)
      const result = await deps.io.exec(['tar', '-xzf', file, '-C', payloadDir], {
        timeoutMs: buildTimeoutMs, onLine: line => log(line),
      })
      if (!result.ok) throw humane(`「${UPDATE_ASSET_TITLES[kind]}」解不开(tar 退出码 ${result.code})。点「重试」会重新下一份。`)
    }
    let shellApp: string | undefined
    if (files.shell_app_zip !== undefined) {
      await deps.io.rmrf(shellDir)
      await deps.io.mkdirp(shellDir)
      // ditto 而不是 unzip:壳是个 .app,里面有符号链接与扩展属性,unzip 会弄丢它们。
      const result = await deps.io.exec(['ditto', '-x', '-k', files.shell_app_zip, shellDir], {
        timeoutMs: buildTimeoutMs, onLine: line => log(line),
      })
      if (!result.ok) throw humane(`工作台窗口那个包解不开(ditto 退出码 ${result.code})。点「重试」会重新下一份。`)
      shellApp = `${shellDir}/${SHELL_APP_NAME}`
      if (await deps.io.stat(shellApp) === undefined) {
        throw humane(`工作台窗口那个包解开了,但里面没有「${SHELL_APP_NAME}」。服务器上那份产物是坏的,先别升 —— 这一条要发版的人去看。`)
      }
    }
    phase('正在解包', progressOf('extract', 1, 1))

    // ── 壳那一道门:签名身份对不上就不换 ──
    let installShell = false
    if (shellApp !== undefined) {
      const installedApp = await deps.io.stat(deps.paths.shellApp)
      const decision = shellDecision(
        await drOf(deps.paths.shellApp),
        await drOf(shellApp),
        installedApp !== undefined,
      )
      installShell = decision.action === 'install'
      log(decision.why)
      if (!installShell) skipped.push(decision.why)
    }

    // ── 安装:直接调登录台那份代码 ──
    const installer = createSetupInstaller({
      io: deps.io,
      paths: deps.paths,
      repoRoot: payloadDir,
      now: deps.now,
      newId: () => `${id}-${deps.newId()}`,
      buildTimeoutMs,
      prebuilt: {
        ...(files.plugin_tgz === undefined ? {} : { pluginTarball: files.plugin_tgz }),
        ...(shellApp === undefined ? {} : { shellApp }),
        // 这一版带了运行环境清单 → 运行时那一步用**它**,而不是这个进程里编着的那份旧清单
        // (跑这趟作业的是旧插件,它手上的清单永远是旧版本的 —— 见 update/types.ts)。
        ...(files.runtime_tgz === undefined ? {} : { runtimeLockDir: `${payloadDir}/${RUNTIME_LOCK_PAYLOAD_DIR}` }),
      },
      // payload 是个下次更新就会被删掉的解包目录,绝不能被记成事务官的落脚目录。
      recordButlerCwd: false,
    })

    const planned = PLANNED_STEPS.filter((item) => {
      // 这一趟只跑指定的那几步(运行环境漂移那一趟 = profile + runtime)。**排在最前面判**:
      // 被这一条滤掉的不该在界面上留下「这一版没带…」那句话 —— 它压根不在这一趟的范围里。
      if (intent.steps !== undefined && !intent.steps.includes(item.step)) return false
      if (item.needs !== undefined && files[item.needs] === undefined) {
        // 两种「没有这件产物」要分开说:
        //   ① 清单里压根没带它 → 这一步跳过,如实说一句(界面在结尾列出来);
        //   ② 带了,但跟本机那份一模一样 → 那一句已经进了 `unchanged`,**这里不再说第二遍**。
        if (manifest.assets[item.needs] === undefined) {
          skipped.push(`这一版没带「${UPDATE_ASSET_TITLES[item.needs]}」,${item.phase.replace('正在', '')}这一步跳过了(那一块保持原样)。`)
        }
        return false
      }
      if (item.step === 'shell' && !installShell) return false
      return true
    })
    /**
     * 伴随步(今天只有 `profile`)只在**真有东西要装**的时候才跑(2026-09-26,卡 U6)。
     * 一样都没变的那一趟(发版的人只 bump 了版本号)要能走到下面「不重启」那一支 ——
     * 而伴随步不依赖任何产物,不这么滤一次它会让 steps 永不为空。
     */
    const realWork = planned.filter(item => item.companion !== true).length
    const steps = realWork === 0 ? [] : planned

    /** 这一趟真装成了的那几件,跑完一起记进 installed.json(装失败的绝不记)。 */
    const applied = new Set<UpdateAssetKind>()
    for (const [index, item] of steps.entries()) {
      phase(item.phase, progressOf('install', index, steps.length))
      note(`${item.phase}…`)
      const sub = installer.start(item.step)
      const stop = watch(sub)
      try { await installer.wait(sub.id) }
      finally { stop() }
      for (const line of sub.tail) log(line)
      if (sub.state === 'failed') {
        throw humane(`${item.phase.replace('正在', '')}没成功:${sub.error ?? '不知道为什么'}`)
      }
      if (sub.note !== undefined) log(sub.note)
      if (item.needs !== undefined) applied.add(item.needs)
      phase(item.phase, progressOf('install', index + 1, steps.length))
    }

    // ── 记下「这台机器上现在装着的是哪一份」──
    // **装成了才记**:记早了的代价是下一次把一台没装成的机器当成装好的,然后再也不下那一样。
    // 没碰过的那几条原样留着(这一版只发插件,工人那一条还得算数)。
    const at = new Date(deps.now()).toISOString()
    const updates: Partial<Record<UpdateAssetKind, InstalledAssetRecord>> = {}
    for (const kind of applied) {
      const asset = manifest.assets[kind]
      if (asset === undefined) continue
      updates[kind] = { sha256: asset.sha256, version: manifest.version, at }
    }
    /**
     * **本机那份字节我们自己算过、它就是这一版那一份**的那几件,也把记录补上(2026-10-03)。
     *
     * 这不是"记一件没装过的东西":`source: 'local'` 说的是我们刚刚对这台机器上那个文件
     * 算了一次 sha256,算出来与清单逐位相同 —— 那是**事实**,而记录只是一张备忘(installed.ts
     * 文件头)。发版闸用 `cp` + `dsh plugin add` 装插件时不会去改那份备忘,不补上的话它会
     * 一直陈着,每一版都要靠兜底现算一次才认得出来。
     *
     * 只补这一种:`record` 判出来的不用补(本来就对得上),`none` 的一个字都不记
     * (那正是"没查出来"—— 记一个猜出来的 sha 等于把下一次的判断建在一句假话上)。
     */
    for (const item of plan.items) {
      if (item.changed || item.source !== 'local') continue
      const asset = manifest.assets[item.kind]
      if (asset === undefined || installed.assets[item.kind]?.sha256 === asset.sha256) continue
      updates[item.kind] = { sha256: asset.sha256, version: manifest.version, at }
    }
    if (Object.keys(updates).length > 0) {
      await writeInstalled(deps.io, deps.paths, installed, updates, { version: manifest.version, at })
      // 「记下来的」= 这一趟真装上去的 + 本机那份字节刚核过与这一版相同的(见上一段)。
      log(`已记下这台电脑上现在是这一版的 ${Object.keys(updates).length} 样(${deps.paths.installedJson})`)
    }

    // ── 一样都没要换的 ──
    // 清单的版本号是新的,但每一件产物的 sha 都跟本机那份一样(发版的人只 bump 了版本号)。
    // 这时候**不重启** —— 重启会把正开着的网页踢一下,为了一件什么都没换的事做这个不值。
    if (steps.length === 0) {
      phase('已经是最新的了', 100)
      note(`这一版(${manifest.version})的每一样都跟你这台电脑上装着的一模一样,没有要换的东西,也不用重启。`)
      return
    }

    /**
     * ── 换过壳的话,让那一扇窗自己换过来 ──(2026-09-21)
     *
     * **必须在 `scheduleRestart()` 之前**:那一下 kickstart 会把跑着这个作业的进程杀掉,
     * 排在它后面的代码一行都轮不到。
     *
     * 代价(已知,写在交接里):新壳起来的那几秒里 3080 正好在重启,页面会先白一下 ——
     * 壳自己的「加载失败自动重试」(退避 2→4→8→10 秒)本来就是为这一幕写的,
     * 不在这里另造一套等待。
     */
    if (applied.has('shell_app_zip')) {
      phase('正在换掉工作台窗口', 100)
      const hint = await relaunchShell()
      if (hint !== undefined) skipped.push(hint)
    }

    // ── 重启 ──
    // 这一下会把跑着这个作业的进程杀掉,所以状态先落成「好了」,再延迟发出去。
    view.restarting = true
    phase('正在重启工作台', 100)
    const saved = unchanged.length === 0 ? '' : `(有 ${unchanged.length} 样跟你机器上那份一模一样,没重下)`
    // 只补运行环境那一趟里,前后是同一个版本号 —— 别写成「0.4.0 → 0.4.0」那种看着像坏了的话。
    const versions = deps.currentVersion === manifest.version ? `(${manifest.version})` : `(${deps.currentVersion} → ${manifest.version})`
    /**
     * 「没回来的话把工作台窗口关掉重开一次」这句话**以前是假的**(2026-10-13):壳从来不去
     * 拉服务,只重连 —— 关掉重开也还是连不上。现在壳在 8791 连续 20 秒不答时自己
     * `launchctl kickstart` 一次(`workbench-app/Sources/ShellReadiness.swift`),
     * 所以改成说那一条。**壳要跟这一版一起发**,不然这句话又会变成一句空话。
     */
    note(skipped.length === 0
      ? `更新装好了${versions}${saved},正在重启工作台。几秒后页面会自己回来 —— 慢的话工作台窗口会自己再拉一次,给它半分钟。`
      : `更新装好了${versions}${saved},正在重启工作台。有几样这次没换,下面写了为什么。`)
    await scheduleRestart()
  }

  /** 子步骤跑着的时候,把它那句人话抄过来。测试传 subPollMs=0 就不起定时器。 */
  function watch(sub: SetupJobView): () => void {
    if (subPollMs <= 0) return () => {}
    const timer = setInterval(() => {
      if (sub.note !== undefined) view.note = `${view.phase}:${sub.note}`
      if (sub.tail.length > 0) view.tail = sub.tail
    }, subPollMs)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }

  /** 壳这会儿还在跑吗。读不出来(osascript 不在 / 报错)一律回 `undefined` —— 不猜(D13)。 */
  async function shellRunning(): Promise<boolean | undefined> {
    // `is running` 是 AppleScript 里少数几个**不会把 App 拉起来**的属性之一。
    const asked = await deps.io.exec(['osascript', '-e', `application id "${SHELL_BUNDLE_ID}" is running`], { timeoutMs: 10_000 })
    if (!asked.ok) return undefined
    const text = asked.out.trim().toLowerCase()
    if (text === 'true') return true
    if (text === 'false') return false
    return undefined
  }

  /**
   * 换完壳之后:让旧壳**优雅退出**,等它真退了,再把新的那份拉起来(2026-09-21)。
   *
   * ## 为什么是「优雅退出」而不是杀掉
   *
   * 壳在 `applicationWillTerminate` 里把当前窗口那一帧**同步**写进 `app.json`
   * (`window_frames`),新壳启动时照常读它就回到了原处。`kill -9` 也能让它消失,
   * 但那一下会把"他把窗口拖到哪儿、拉成多大"连同进程一起丢掉 —— 重开之后窗口回到铺满,
   * 那比不重开更气人。所以这一段的全部重量都在「优雅」两个字上。
   *
   * ## 三条纪律
   *
   * 1. **本来就没开着就不开。** 他没开工作台窗口的时候,一次后台更新不该凭空给他弹一扇窗。
   * 2. **到点还没退就不强杀**,改成如实说一句「这一扇窗得你自己关掉重开」。
   *    强杀省下的是一句话,赔上的是他摆了半天的窗口位置。
   * 3. **拉起来带上 `--relaunched-by-update`**:壳据此知道这一趟不是他点的图标 ——
   *    强行抬到最前面(不然开在别人后面,他以为工作台更新完不见了),
   *    也不再弹那个辅助功能的系统框(签名没变,授权没掉,没什么要他点的)。
   *
   * 回一句要写给他看的话;没什么可说的时候回 undefined。
   */
  async function relaunchShell(): Promise<string | undefined> {
    const before = await shellRunning()
    if (before === false) {
      log('工作台窗口本来就没开着,这次不替他打开')
      return undefined
    }
    if (before === undefined) {
      // 探不出来 ≠ 没开着。这时候既不敢 quit(可能根本没这个 App),也不敢 open。
      log('问不出工作台窗口开着没有(osascript 没给出答案),这一步跳过')
      return '换好了新的工作台窗口,但没能确认旧的那一扇有没有开着 —— 如果它还开着,关掉再打开一次就是新的了。'
    }

    log(`$ osascript -e 'tell application id "${SHELL_BUNDLE_ID}" to quit'`)
    await deps.io.exec(['osascript', '-e', `tell application id "${SHELL_BUNDLE_ID}" to quit`], { timeoutMs: 20_000 })

    // 等它**真的**退出:quit 是发出去的一个请求,不是一个事实。没等到就去 open 的话,
    // 新旧两份壳会同时挂在 /helper 上,而且旧那份还会在退出时把窗口位置覆盖回去。
    const deadline = deps.now() + shellQuitTimeoutMs
    // 轮数也要封顶:`deps.now` 是注入的,用例里它常常是个**不动的**时刻 ——
    // 只按时刻判的话那种 now 会把这里转成一个死循环。
    const rounds = shellQuitPollMs > 0 ? Math.ceil(shellQuitTimeoutMs / shellQuitPollMs) : 0
    let gone = false
    for (let round = 0; round < rounds && deps.now() < deadline; round += 1) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, shellQuitPollMs); t.unref?.() })
      if (await shellRunning() !== true) { gone = true; break }
    }
    if (!gone && await shellRunning() === true) {
      log('旧的工作台窗口没能在限时内退出 —— 不强杀它(强杀会把窗口位置丢掉)')
      return '工作台窗口这次没能自己重开(旧的那扇没退出来)。把它关掉再打开一次,就是新的那份了。'
    }

    log(`$ open -n ${deps.paths.shellApp} --args ${SHELL_RELAUNCH_FLAG}`)
    const opened = await deps.io.exec(['open', '-n', deps.paths.shellApp, '--args', SHELL_RELAUNCH_FLAG], { timeoutMs: 30_000 })
    if (!opened.ok) {
      return '工作台窗口这次没能自己重开(拉起来的时候出错了)。在「应用程序」里双击「工作台」就行,位置还是你原来摆的那样。'
    }
    return undefined
  }

  /**
   * 发出重启。**这一下不许依赖"发它的这个进程还活着"**(2026-10-13,0.4.115 现场)。
   *
   * ## 10-12 晚那一趟是怎么没起来的
   *
   * 原来这里是:`setTimeout(fire, 1500)` 且 `timer.unref()`,`fire` 里拿普通 `spawn`
   * (非 detached、管道)起 `launchctl kickstart -k`。三件事凑起来就有这一个洞:
   *
   * 1. **unref 的定时器不会让进程活着** —— 它只是"活着的话到点叫我一声"。
   * 2. 这个进程(DSH 宿主)在那 1.5 秒里以 **0** 退出掉,定时器就连一次都不会 fire,
   *    那条 kickstart 压根没发出去;
   * 3. plist 写着 `KeepAlive.SuccessfulExit=false` —— **正常退出故意不拉起**。
   *    于是服务停在那儿,`launchctl print` 是 state = not running、last exit code = 0、
   *    **runs 一格都没加**(现场读数一字不差,交接里的 E-B 复现了它)。
   *
   * 为什么它会在那 1.5 秒里以 0 退出,还没查到(那一半在 DSH 宿主里,我们的日志一行都没留)。
   * **这一下的改法不依赖知道答案**:谁把它弄死的都不要紧 —— `kickstart -k` 对一个
   * 已经不在跑的项就是"把它起起来"(交接里的 E-F),所以晚到 1.5 秒也照样救得回来。
   *
   * ## 所以等那一拍等在 sh 里
   *
   * `/bin/sh -c 'sleep 1.5; exec launchctl kickstart -k …'`,`background: true`
   * (detach 成自己一个会话 + stdio 全丢 + unref)。这样:
   * - 界面照旧有 1.5 秒看到「装好了,正在重启」那一拍(那一拍的理由没变);
   * - 这个进程在这期间死掉、被杀掉、或者被 launchd 连进程组一起收掉(量过:真会收,
   *   交接 E-A),那个 sh 都不在它的进程组里,照样把请求送到 launchd。
   *
   * ## 还有一道保险
   *
   * 发出去之后 20 秒这个进程还活着 = 那一下没生效(launchctl 没起来 / 没送到)。
   * 这时候自己以非 0 退出,让 `KeepAlive.SuccessfulExit=false` 把服务拉起来
   * —— 生产才接 `hardRestart`,用例一条都不传(见 `UpdateApplyDeps.hardRestart`)。
   */
  async function scheduleRestart(): Promise<void> {
    const target = `gui/${deps.io.uid()}/${DSH_LAUNCHD_LABEL}`
    const cmd = restartHandoffCommand(target, restartDelayMs)
    log(`$ ${cmd.join(' ')}`)
    const sent = await deps.io.exec(cmd, { background: true })
    if (!sent.ok) {
      // 今天这一下是 `void io.exec(...)`:发不出去一个字都不留。那正是 10-12 现场
      // 查不下去的原因之一,所以它得进日志、也得进界面上那一句。
      log(`重启那一下没发出去(${sent.out || '没说为什么'})`)
      skipped.push(restartRescueHint(target))
      note(`${view.note ?? ''}\n${restartRescueHint(target)}`.trim())
    }
    armRestartWatchdog(target, sent.ok)
  }

  /** 到点还活着就自己以非 0 退出(理由见 `scheduleRestart` 末节)。缺 `hardRestart` = 不设。 */
  function armRestartWatchdog(target: string, sent: boolean): void {
    const hard = deps.hardRestart
    if (hard === undefined || restartWatchdogMs <= 0) return
    const timer = setTimeout(() => {
      void (async () => {
        // **这一刻之后这个进程就没了**,内存里那份日志跟着没 —— 唯一会留下来的是这一行。
        const line = `${new Date(deps.now()).toISOString()} 更新 ${manifest.version}:`
          + `${sent ? '重启发出去了' : '重启没发出去'},${Math.round(restartWatchdogMs / 1000)} 秒后这个进程还活着,`
          + `改成自己以非 0 退出让 launchd 拉起(${target})\n`
        try { await deps.io.appendFile(`${deps.paths.updatesDir}/restart.log`, line) }
        catch { /* 写不下也要退:这一行只是给下一次查的人留的 */ }
        hard()
      })()
    }, restartWatchdogMs)
    timer.unref?.()
  }

  async function drOf(app: string): Promise<string | undefined> {
    const shown = await deps.io.exec(['codesign', '-d', '-r', '-', app])
    if (!shown.ok) return undefined
    return requirementOf(shown.out)
  }

  return { view, done }
}

/** 已经是人话的错误。`applyAll` 的 catch 靠这个标记决定要不要再包一层。 */
function humane(message: string): Error {
  const error = new Error(message) as Error & { humane?: boolean }
  error.humane = true
  return error
}
