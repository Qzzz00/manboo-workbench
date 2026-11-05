/**
 * 一键装(2026-09-17,登录台关 1 的另一半)。Ben 09-17 拍板:**安装器真的要能装**。
 *
 * ## 形状
 *
 * 一步一个作业(job):`POST /setup/install {step}` 立刻回一个 job id,界面轮询
 * `GET /setup/install/:job` 看进度。为什么不是同步等:装运行时那步要下 200 个包,
 * 网络慢时好几分钟 —— 一条挂着不动的 HTTP 请求既会被代理掐断,也让界面无从显示进度。
 *
 * ## 三条硬纪律
 *
 * 1. **每一步都幂等、可重复**。装到一半断网、点两次、装完再点一次,都不能把机器弄坏。
 *    所以每步开头先看一眼"是不是已经好了",好了就直接回一句"不用装"。
 * 2. **失败回人话 + 原始输出尾 20 行**。只回"失败了"等于什么都没说;只回原始输出
 *    Ben(非程序员)看不懂。两样都要。
 * 3. **一行都不真跑在测试里**。命令执行与文件写入全部经 `SetupIo`,测试注入假的,
 *    断言"调了什么命令、写了哪些文件";临时 HOME 保证就算哪里写错也只写进 mktemp 目录。
 *    (2026-09-04 家目录被删事故之后,这条不是洁癖。)
 */
import type { SetupIo } from './io.ts'
import { tailLines } from './io.ts'
import type { SetupInstallStep, SetupJobView } from './types.ts'
import type { SetupPaths } from './paths.ts'
import {
  BUTLER_LAUNCHD_LABEL, DSH_LAUNCHD_LABEL, LIVEKIT_LAUNCHD_LABEL, LIVEKIT_MIN_MACOS_MAJOR, LIVEKIT_SERVER_VERSION,
  LOCKED_DSH_VERSION, LOCKED_NODE_VERSION,
  DSH_UPSTREAM_DEFAULT_MODEL, DSH_WELCOME_NOTICE_VERSION, LOCKED_PNPM_VERSION, MIN_NODE_MAJOR, NPM_MIRROR_REGISTRY,
  NODE_TARBALL_NAME, NODE_TARBALL_SHA256, NODE_TARBALL_URLS,
  PNPM_TARBALL_NAME, PNPM_TARBALL_SHA256, PNPM_TARBALL_URLS,
  SEEDED_DEFAULT_MODEL, SHELL_APP_NAME,
} from './paths.ts'
import { ROWS_OFF_FOR_USERS } from '../../upstreamEntries.ts'
import { latestWebToken } from './status.ts'
import { DSH_RELAY_PROVIDER, readAgentDefaultModel, settingsForRelay } from '../dshModelSettings.ts'
import { DEFAULT_RELAY_URL, parseModelConfig } from '../modelConfig.ts'
import { ensureLocalRoomConfig } from '../localRoom.ts'
import { readOrCreateMachineId } from '../machineId.ts'
import {
  BUNDLED_RUNTIME_LOCK, describeDrift, isLockedRuntimeLock, lockedDshVersion, readRuntimeLockPair,
  RUNTIME_LOCK_FILENAMES, runtimeDrift, runtimeLockText, runtimePackageJsonText, type DshRuntimeLockPair,
} from './dshRuntimeLock.ts'

/** npm 那步默认给 30 分钟。真机上首次装运行时实测要几分钟,网络差时更久。 */
const DEFAULT_NPM_TIMEOUT_MS = 30 * 60_000
/** 构建壳 / 同步目录这类:10 分钟足够,再久多半是卡住了。 */
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60_000
/** 留多少条历史作业。只为"刚才那次失败的输出还在不在",不做归档。 */
const MAX_JOBS = 20

/** 一步失败时抛它:message 是给 Ben 看的人话,原始输出由作业自己带。 */
export class SetupStepError extends Error {}

export interface SetupInstallDeps {
  io: SetupIo
  paths: SetupPaths
  /** 仓库根。几步(plugin / scripts / shell / butler / worker / launchd)没有它做不了。 */
  repoRoot?: string
  now: () => number
  newId: () => string
  npmTimeoutMs?: number
  buildTimeoutMs?: number
  /**
   * 「产物已经打包好了,别在这台机器上现构建」(2026-09-18 桌面安装包)。
   *
   * 登录台那条路上仓库就在手边,`plugin` 那步 `pnpm build && npm pack`、`shell` 那步
   * `build.sh` 都跑得起来。而**双击 dmg 的那台机器上没有仓库、没有 pnpm、没有 swiftc**
   * —— 安装器把这两样东西预先构建好塞进 .app 的 Resources 里,这里只是换掉"从哪来"。
   * 装进 profile、ditto 到 /Applications 那后半截一个字不变,所以只有一处分叉。
   */
  prebuilt?: SetupPrebuilt
  /**
   * `scripts` 那一步要不要顺手把 `repoRoot` 记进 app.json 的 `butler_cwd`(缺省要)。
   *
   * 热更新(2026-09-18)传 false:那条路上的 `repoRoot` 是 `~/.dsh/updates/<版本>/payload`
   * —— 一个**下次更新就会被删掉**的临时解包目录。把它记成事务官的落脚目录,等于下一版
   * 装完之后引导和记忆全指向一个不存在的路径。热更新不改这个配置,一个字都不动。
   */
  recordButlerCwd?: boolean
  /**
   * 作业里每冒出一行就当场叫一次(2026-09-27,卡 PN)。
   *
   * **为什么非有不可**:`SetupJobView` 上只有 `tail`(20 行的滑动窗口)与 `note`(只留最后一条),
   * 轮询的调用方因此必然丢行 —— 安装器那边按"看过几条"取增量,窗口一满就再也取不到新的,
   * 于是一次失败的安装,「详细日志」里一个字都没有(维护者 9/27 在新 Air 上的截图)。
   * 界面要的是"每一行都别丢",这件事只能由产生那一行的地方推出来。
   *
   * 缺席 = 老样子(体检页那条路照旧轮询 `tail`,它只要"最后 20 行"就够)。
   */
  onLine?: (step: SetupInstallStep, kind: 'log' | 'note', text: string) => void
  /**
   * 这台 Mac 的机器 id 从哪取(本机房间名 `wb-local-<前 8 位>` 要它)。缺省 `machineId.ts` 的
   * `readOrCreateMachineId(paths.machineIdFile)` —— 与 8791 同一个函数、同一个文件,两边不会各定一个。
   */
  machineId?: () => Promise<string | undefined>
}

/** 预先构建好的产物。缺席 = 照旧在仓库里现构建。 */
export interface SetupPrebuilt {
  /** 插件的 .tgz(`pnpm build && npm pack` 出来的那个)。 */
  pluginTarball?: string
  /** 构建好的 `工作台.app`(`workbench-app/build.sh` 出来的那个)。 */
  shellApp?: string
  /** 手机包(安装器 payload 里那份)。scripts 步骤把它放进数据目录,首次流程的二维码从那里发。 */
  apk?: string
  /**
   * 自带 pnpm 的那个 .tgz(安装器 payload 里那份,2026-09-27 卡 PN)。
   *
   * 传了就**不联网**:装插件那一步要的 pnpm 直接从安装包里解出来。缺席(热更新、裸机引导)
   * 照 `PNPM_TARBALL_URLS` 下一份,一律核仓库里钉着的同一份 sha256。
   */
  pnpmTarball?: string
  /**
   * 放着一对 `runtime.package.json` + `runtime.package-lock.json` 的目录(2026-09-25 升 0.1.7)。
   *
   * **只有热更新那条路会传**,而且它是热更新能换 DSH 版本的关键:跑更新作业的是**旧那份插件的
   * 进程**,`import` 进来的锁定清单永远是旧版本的,所以新清单要从下下来的
   * `runtime_tgz` 里解出来、从这里交给运行时那一步。
   *
   * 传了就用这一对,而且**必须读得到、必须是合法 JSON**,读不到就让这一步失败 ——
   * 悄悄退回旧清单会把"升级了"变成"看着升了其实没换",那比失败更糟。
   * 缺席(安装器、裸机引导、体检里点单步)照旧用插件里编进来的那一份。
   */
  runtimeLockDir?: string
}

interface JobRecord {
  view: SetupJobView
  done: Promise<void>
}

export interface SetupInstaller {
  /** 起一步。同一步已经在跑就直接把那条作业回给你(不会起第二个 npm)。 */
  start: (step: SetupInstallStep) => SetupJobView
  job: (id: string) => SetupJobView | undefined
  /** 等某条作业跑完。生产用不到,测试与 dispose 用。 */
  wait: (id: string) => Promise<void>
}

interface StepCtx {
  io: SetupIo
  paths: SetupPaths
  repoRoot?: string
  log: (line: string) => void
  note: (text: string) => void
  npmTimeoutMs: number
  buildTimeoutMs: number
  prebuilt: SetupPrebuilt
  recordButlerCwd: boolean
  machineId: () => Promise<string | undefined>
}

type StepResult = { url?: string } | void

export function createSetupInstaller(deps: SetupInstallDeps): SetupInstaller {
  const jobs = new Map<string, JobRecord>()
  const running = new Map<SetupInstallStep, string>()

  function start(step: SetupInstallStep): SetupJobView {
    const existingId = running.get(step)
    const existing = existingId === undefined ? undefined : jobs.get(existingId)
    if (existing !== undefined && existing.view.state === 'running') return existing.view

    const id = deps.newId()
    const lines: string[] = []
    const view: SetupJobView = {
      id,
      step,
      state: 'running',
      started_at: new Date(deps.now()).toISOString(),
      tail: [],
    }
    const ctx: StepCtx = {
      io: deps.io,
      paths: deps.paths,
      ...(deps.repoRoot === undefined || deps.repoRoot === '' ? {} : { repoRoot: deps.repoRoot }),
      log: (line) => {
        lines.push(line)
        // 尾 20 行:界面上只看得下这么多,而真正有用的报错总在最后。
        if (lines.length > 400) lines.splice(0, lines.length - 400)
        view.tail = tailLines(lines.join('\n'))
        // **每一行当场交出去**(2026-09-27,卡 PN 顺带修的第三个坑)。
        // 原来调用方只能轮询 `view.tail` —— 那是一个 20 行的滑动窗口,几千行 npm / pnpm
        // 输出从里面一掠而过;安装器那边按"看过几条"取增量,窗口一满就永远取不到新的,
        // 于是「详细日志」整块是空的(维护者 9/27 的截图)。
        deps.onLine?.(step, 'log', line)
      },
      note: (text) => {
        view.note = text
        // note 同理:`view.note` 只留最后一条,连着两句时前一句在轮询里根本看不到。
        deps.onLine?.(step, 'note', text)
      },
      npmTimeoutMs: deps.npmTimeoutMs ?? DEFAULT_NPM_TIMEOUT_MS,
      buildTimeoutMs: deps.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      prebuilt: deps.prebuilt ?? {},
      recordButlerCwd: deps.recordButlerCwd ?? true,
      machineId: deps.machineId ?? (() => readOrCreateMachineId(deps.paths.machineIdFile)),
    }

    const done = (async () => {
      try {
        const result = await STEPS[step](ctx)
        if (result !== undefined && result.url !== undefined) view.url = result.url
        view.state = 'done'
      }
      catch (error) {
        view.state = 'failed'
        view.error = error instanceof SetupStepError
          ? error.message
          : `没预料到的错:${error instanceof Error ? error.message : String(error)}`
      }
      finally {
        view.finished_at = new Date(deps.now()).toISOString()
        view.tail = tailLines(lines.join('\n'))
        if (running.get(step) === id) running.delete(step)
      }
    })()

    jobs.set(id, { view, done })
    running.set(step, id)
    // 历史只留最近几条(插入序 = Map 的迭代序)。
    while (jobs.size > MAX_JOBS) {
      const oldest = jobs.keys().next().value
      if (oldest === undefined) break
      jobs.delete(oldest)
    }
    return view
  }

  return {
    start,
    job: id => jobs.get(id)?.view,
    wait: async (id) => { await jobs.get(id)?.done },
  }
}

// ───────────────────────────── 公共小工具 ─────────────────────────────

/**
 * 装完壳之后,如实说一句「辅助功能授权要不要重新点」。
 *
 * 判据**不是**「我们以为构建脚本用了哪个身份」,而是刚装到 /Applications 那一份自己的签名:
 * `codesign -d -r -` 打出来的 designated requirement 就是 macOS 的 TCC 认的那条线。
 *
 * - `cdhash H"…"`             → ad-hoc,每构建一次就换一条,系统当成新 App,**授权必掉**。
 * - `certificate leaf = H"…"` → 固定证书(deploy/codesign-identity.sh 那张,或 Developer ID),
 *                               重建多少次都是这一条,**授权跨更新保留**。
 *
 * 安装器那条路(prebuilt)与仓库现构建那条路都走这里 —— 问产物本身,两条路不用各写一份判断。
 */
async function shellSignatureNote(ctx: StepCtx): Promise<string> {
  const shown = await ctx.io.exec(['codesign', '-d', '-r', '-', ctx.paths.shellApp])
  const requirement = /designated =>(.*)/.exec(shown.out)?.[1]?.trim()
  if (requirement === undefined || requirement === '') {
    return '装好了。读不出这份壳的签名(codesign 没给出 designated requirement),辅助功能授权掉没掉,只能去系统设置里看一眼。'
  }
  if (requirement.includes('certificate leaf')) {
    return `装好了。签名身份是固定的(${requirement}),**辅助功能授权不会因为这次更新失效** —— 第一次装才要去系统设置里点一次。`
  }
  return '装好了。**这一份是 ad-hoc 签名,系统会当成新 App:要去 系统设置 → 隐私与安全性 → 辅助功能,把「工作台」关一次再开。** 想一次了结:在仓库里跑一遍 `bash deploy/codesign-identity.sh`(它建一张长期证书),之后重建不再掉授权。'
}

function needRepo(ctx: StepCtx): string {
  if (ctx.repoRoot === undefined || ctx.repoRoot === '') {
    throw new SetupStepError('这一步要先知道仓库在哪。回到第 2 步「仓库在哪」选一个目录,再回来点。')
  }
  return ctx.repoRoot
}

/** 跑一条命令,失败就抛人话。输出按行喂给作业。 */
async function run(ctx: StepCtx, cmd: readonly string[], options: { cwd?: string, env?: Record<string, string>, timeoutMs?: number, why: string }): Promise<string> {
  ctx.log(`$ ${cmd.join(' ')}`)
  const result = await ctx.io.exec(cmd, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onLine: line => ctx.log(line),
  })
  if (!result.ok) throw new SetupStepError(`${options.why}(命令 \`${cmd[0]}\` 退出码 ${result.code})`)
  return result.out
}

interface LaunchdItem { template: string, target: string, label: string }

/**
 * 写一份 plist 并 bootstrap。回 `loaded`(这次装载的)、`already`(早就在 launchd 里了 —— 幂等,不算失败)、
 * `no_template`(仓库 / payload 里没有那份模板,由调用方决定算不算错)。真装载失败抛人话。
 */
async function loadLaunchdItem(ctx: StepCtx, item: LaunchdItem): Promise<'loaded' | 'already' | 'no_template'> {
  const template = await ctx.io.readFile(item.template)
  if (template === undefined) return 'no_template'
  await ctx.io.mkdirp(ctx.paths.launchAgentsDir)
  // 三份 plist 的日志都在 ~/.dsh/logs:目录不在时 launchd 起不了这一项(不替它建目录)。
  await ctx.io.mkdirp(ctx.paths.logsDir)
  await ctx.io.writeFile(item.target, renderPlist(template, ctx.paths.home))
  ctx.log(`已写:${item.target}`)
  const uid = ctx.io.uid()
  ctx.log(`$ launchctl bootstrap gui/${uid} ${item.target}`)
  const result = await ctx.io.exec(['launchctl', 'bootstrap', `gui/${uid}`, item.target], { onLine: line => ctx.log(line) })
  if (result.ok) return 'loaded'
  // 已经装载过(code 5 / "already loaded")不是失败 —— 这一步必须幂等。
  const already = result.code === 5 || /already/i.test(result.out)
  if (!already) throw new SetupStepError(`装载 ${item.label} 失败(退出码 ${result.code})`)
  ctx.log(`${item.label} 已经在 launchd 里了,跳过装载`)
  return 'already'
}

function livekitLaunchdItem(ctx: StepCtx, repo: string): LaunchdItem {
  return { template: `${repo}/deploy/${LIVEKIT_LAUNCHD_LABEL}.plist`, target: ctx.paths.livekitPlist, label: LIVEKIT_LAUNCHD_LABEL }
}

/** 本机房间的启动脚本 → `~/.dsh/bin/livekit-start`(755)。仓库 / payload 里没有回 false。scripts 与 livekit 两步共用。 */
async function installLivekitStart(ctx: StepCtx, repo: string): Promise<boolean> {
  const text = await ctx.io.readFile(`${repo}/deploy/livekit-start`)
  if (text === undefined) return false
  await ctx.io.mkdirp(ctx.paths.binDir)
  await ctx.io.writeFile(ctx.paths.livekitStart, text, 0o755)
  ctx.log(`已写(755):${ctx.paths.livekitStart}`)
  return true
}

/** 一个文件的 sha256(`shasum -a 256`)。算不出来回 undefined。 */
async function shaOf(ctx: StepCtx, file: string): Promise<string | undefined> {
  const sums = await ctx.io.exec(['shasum', '-a', '256', file])
  if (!sums.ok) return undefined
  const sha = sums.out.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return /^[0-9a-f]{64}$/.test(sha) ? sha : undefined
}

/** 换过 node 之后系统会重新要一次文稿文件夹授权(0827:TCC 认二进制)。 */
const NODE_TCC_HINT = '提示:换过 node 之后,系统会重新弹一次「文稿文件夹」授权框,点允许。'

/** 只取域名,给人看"这会儿在从哪下"。**不打完整 URL**:那一长串对 Ben 没有信息量。 */
export function hostOf(url: string): string {
  const match = url.match(/^[a-z]+:\/\/([^/]+)/i)
  return match?.[1] ?? url
}

function majorOf(version: string): number {
  const major = Number(version.split('.')[0])
  return Number.isInteger(major) ? major : -1
}

/** 这条 node 跑不跑得起来、是哪一版。跑不起来(dyld 报错之类)回 undefined。 */
async function nodeVersionOf(ctx: StepCtx, bin: string): Promise<string | undefined> {
  const probe = await ctx.io.exec([bin, '-p', 'process.versions.node'])
  if (!probe.ok) return undefined
  const version = (probe.out.trim().split('\n').pop() ?? '').trim()
  return version === '' ? undefined : version
}

/**
 * 下官方独立包并解到 `~/.dsh/node`。
 *
 * 三条纪律:**锁版本**(不跟随上游,同 C3)、**核对仓库里钉着的 sha256**(同 C4 的先审计
 * 再 pin)、**装完当场跑一次**(不验就等于把"装没装上"留给下一步去报一串怪错)。
 */
async function downloadNode(ctx: StepCtx): Promise<void> {
  const tgz = `${ctx.paths.nodeDownloadDir}/${NODE_TARBALL_NAME}`
  ctx.note(`下载 node v${LOCKED_NODE_VERSION}(约 50MB,网络慢会久一点)`)
  await ctx.io.mkdirp(ctx.paths.nodeDownloadDir)
  // 国内镜像在前、官方在后(paths.ts 的 NODE_TARBALL_URLS)。**下完一律核对同一份 sha256**,
  // 所以"换一条源"不会换掉任何一条安全性上的保证。
  const failures: string[] = []
  let downloaded = false
  for (const url of NODE_TARBALL_URLS) {
    ctx.note(`下载 node v${LOCKED_NODE_VERSION}(约 50MB):${hostOf(url)}`)
    const result = await ctx.io.exec(['curl', '-fL', '--retry', '2', '--retry-delay', '2', '--connect-timeout', '20', '-o', tgz, url], {
      timeoutMs: ctx.npmTimeoutMs,
      onLine: line => ctx.log(line),
    })
    if (result.ok) { downloaded = true; ctx.log(`下好了:${url}`); break }
    failures.push(`${url}(退出码 ${result.code})`)
    ctx.log(`这条源没下成,换下一条:${url}`)
  }
  if (!downloaded) {
    throw new SetupStepError(`node 的安装包一条源都没下成(试过 ${NODE_TARBALL_URLS.length} 条:${failures.join('、')})。多半是这会儿没网,或者公司网挡着。连上网之后点「重试」。`)
  }

  ctx.note('核对 sha256')
  const sums = await ctx.io.exec(['shasum', '-a', '256', tgz])
  const got = (sums.out.trim().split(/\s+/)[0] ?? '').toLowerCase()
  if (!sums.ok || got !== NODE_TARBALL_SHA256) {
    // 对不上的包一律不留,免得下次误以为已经下好了。
    await ctx.io.rmrf(ctx.paths.nodeDownloadDir)
    throw new SetupStepError(`下下来的包跟仓库里锁着的 sha256 对不上(算出来是 ${got === '' ? '(没算出来)' : got},要的是 ${NODE_TARBALL_SHA256})。多半是下到一半断了,或者中间有代理改过内容。再点一次这一步会重新下。`)
  }

  ctx.note('解包到 ~/.dsh/node')
  await ctx.io.mkdirp(ctx.paths.nodeDir)
  await run(ctx, ['tar', '-xzf', tgz, '-C', ctx.paths.nodeDir, '--strip-components=1'], {
    timeoutMs: ctx.buildTimeoutMs, why: '解包失败',
  })
  await ctx.io.rmrf(ctx.paths.nodeDownloadDir)

  const version = await nodeVersionOf(ctx, ctx.paths.nodeBin)
  if (version === undefined) {
    throw new SetupStepError(`解包完了,但 ${ctx.paths.nodeBin} 还是跑不起来。看一眼那个目录里有没有东西(ls ${ctx.paths.nodeDir}),然后再点一次。`)
  }
  ctx.note(`自有 node 装好了:v${version}`)
  ctx.log(NODE_TCC_HINT)
}

// ───────────────────────── 自带 pnpm(2026-09-27,卡 PN) ─────────────────────────

/**
 * `~/.dsh/node/bin/pnpm` 那个小脚本(纯函数,可测)。
 *
 * 为什么是「小脚本 + 自带 node」而不是把 pnpm 的可执行文件直接放上去:npm 上的 `pnpm` 包
 * 是一份 JS(`bin/pnpm.mjs`),要有 node 才跑;而这台机器上**唯一保证存在**的 node 就是
 * `~/.dsh/node`(0827 之后的规矩:不借别人家会自动更新的 node)。两条绝对路径写死在脚本里,
 * 所以它不依赖调用方的 PATH 里有没有 node,也不会哪天顺着别人的 node 跑。
 */
export function pnpmShimScript(paths: SetupPaths): string {
  return [
    '#!/bin/sh',
    '# 工作台自带的 pnpm。由安装 / 热更新时的 ensurePnpm 写出来,别手改 —— 下一次装它会覆盖。',
    '# 为什么要有它:DSH 0.1.7 的 `dsh plugin add` 转手给 pnpm,找不到就回 127。',
    `exec "${paths.nodeBin}" "${paths.pnpmEntry}" "$@"`,
    '',
  ].join('\n')
}

/** 自带 pnpm 的 .tgz 从哪来:安装包里带的那份(不联网),没带就下一份(镜像在前)。 */
async function pnpmTarballAt(ctx: StepCtx): Promise<string> {
  const bundled = ctx.prebuilt.pnpmTarball
  if (bundled !== undefined && bundled !== '' && await ctx.io.stat(bundled) !== undefined) {
    ctx.log(`用安装包里带的那份 pnpm:${bundled}`)
    return bundled
  }

  // 热更新那条路:机器上还没有 pnpm,而更新包里也没带 —— 照 node 的做法下一份。
  const tgz = `${ctx.paths.pnpmDownloadDir}/${PNPM_TARBALL_NAME}`
  await ctx.io.mkdirp(ctx.paths.pnpmDownloadDir)
  const failures: string[] = []
  for (const url of PNPM_TARBALL_URLS) {
    ctx.note(`下载包管理器 pnpm v${LOCKED_PNPM_VERSION}(约 9MB):${hostOf(url)}`)
    const result = await ctx.io.exec(['curl', '-fL', '--retry', '2', '--retry-delay', '2', '--connect-timeout', '20', '-o', tgz, url], {
      timeoutMs: ctx.npmTimeoutMs,
      onLine: line => ctx.log(line),
    })
    if (result.ok) { ctx.log(`下好了:${url}`); return tgz }
    failures.push(`${url}(退出码 ${result.code})`)
    ctx.log(`这条源没下成,换下一条:${url}`)
  }
  throw new SetupStepError(`装工作台要的包管理器(pnpm)一条源都没下成(试过 ${PNPM_TARBALL_URLS.length} 条:${failures.join('、')})。多半是这会儿没网,或者公司网挡着。连上网之后点「重试」。`)
}

/**
 * 把自带的 pnpm 放到位(幂等)。**装插件那一步的第一件事。**
 *
 * 为什么非有这一段:DSH 0.1.7 的 `dsh plugin add` 自己不装包,它 `execa('pnpm', …)`
 * —— 找不到就回 127,而 127 这个数字对用户完全没有信息量(2026-09-27 维护者在新
 * MacBook Air 上看到的就是「装进 profile 失败(命令 …/node 退出码 127)」)。
 * 详细背景见 `paths.ts` 的 `LOCKED_PNPM_VERSION`。
 *
 * 三条纪律与 node 那一步**一模一样**:锁版本(不跟随上游)、核仓库里钉着的 sha256
 * (镜像被投毒就是这一行挡着)、装完当场跑一次(不验就等于把"装没装上"留给下一步去报怪错)。
 */
export async function ensurePnpm(ctx: StepCtx): Promise<void> {
  const { pnpmBin, pnpmDir, pnpmEntry, pnpmDownloadDir } = ctx.paths

  /** 装着的那一份跑不跑得起来、是哪一版。**只问我们自己那条路径**,不问 PATH 上别人的 pnpm。 */
  const probe = async (): Promise<string | undefined> => {
    if (await ctx.io.stat(pnpmEntry) === undefined || await ctx.io.stat(pnpmBin) === undefined) return undefined
    const shown = await ctx.io.exec([pnpmBin, '--version'])
    if (!shown.ok) return undefined
    const version = (shown.out.trim().split('\n').pop() ?? '').trim()
    return version === '' ? undefined : version
  }

  // ① 已经是钉死那一版:一个字不动。
  const already = await probe()
  if (already === LOCKED_PNPM_VERSION) {
    ctx.log(`自带的 pnpm 已经在了(v${already}),不用装`)
    return
  }
  if (already !== undefined) ctx.log(`自带的 pnpm 是 v${already},要的是 v${LOCKED_PNPM_VERSION} —— 重新装一份`)

  // ② 拿到那个 .tgz(安装包里带的优先),核 sha256。
  const tgz = await pnpmTarballAt(ctx)
  ctx.note('核对包管理器的 sha256')
  const sums = await ctx.io.exec(['shasum', '-a', '256', tgz])
  const got = (sums.out.trim().split(/\s+/)[0] ?? '').toLowerCase()
  if (!sums.ok || got !== PNPM_TARBALL_SHA256) {
    // 下下来的坏包一律不留(免得下次误以为已经下好了);**安装包里带的那份不动** ——
    // 那是 .app 里的东西,删它只会把一份坏的安装包变成一份更奇怪的安装包。
    await ctx.io.rmrf(pnpmDownloadDir)
    throw new SetupStepError(`装工作台要的包管理器(pnpm)跟仓库里锁着的 sha256 对不上(算出来是 ${got === '' ? '(没算出来)' : got},要的是 ${PNPM_TARBALL_SHA256})。多半是下到一半断了,或者中间有代理改过内容。再点一次这一步会重新下;要是这句话一直出现,把它发给维护者。`)
  }

  // ③ 解包。**先清再解**:上一趟断在半路留下的半棵树会让 pnpm 报一串看不懂的错。
  ctx.note(`装包管理器 pnpm v${LOCKED_PNPM_VERSION}`)
  await ctx.io.rmrf(pnpmDir)
  await ctx.io.mkdirp(pnpmDir)
  await run(ctx, ['tar', '-xzf', tgz, '-C', pnpmDir, '--strip-components=1'], {
    timeoutMs: ctx.buildTimeoutMs, why: '包管理器(pnpm)解包失败',
  })
  await ctx.io.writeFile(pnpmBin, pnpmShimScript(ctx.paths), 0o755)
  ctx.log(`已写(755):${pnpmBin}`)
  await ctx.io.rmrf(pnpmDownloadDir)

  // ④ 当场跑一次。版本对不上也算失败:那说明解出来的不是我们以为的那一份。
  const version = await probe()
  if (version !== LOCKED_PNPM_VERSION) {
    throw new SetupStepError(`装工作台要的包管理器(pnpm)装完之后跑不起来${version === undefined ? '' : `(跑出来是 v${version},要的是 v${LOCKED_PNPM_VERSION})`}。再点一次这一步;还不行就把这句话发给维护者。`)
  }
  ctx.note(`包管理器装好了(pnpm v${version})`)
}

/**
 * 这一趟运行时那一步用哪一对锁定清单(2026-09-25 升 0.1.7)。
 *
 * 热更新传 `prebuilt.runtimeLockDir`(从下下来的 `runtime_tgz` 里解出来的那一对)。传了就
 * **必须读得通**:读不到 / 不是 JSON / 里面没有 dsh 版本一律让这一步失败,绝不悄悄退回插件里
 * 那份旧清单 —— 那会让"升级成功"这句话变成假的(界面说好了,DSH 还是旧版本,而没人会发现)。
 */
async function resolveRuntimeLockPair(ctx: StepCtx): Promise<DshRuntimeLockPair> {
  const dir = ctx.prebuilt.runtimeLockDir
  if (dir === undefined || dir === '') return BUNDLED_RUNTIME_LOCK
  const read = readRuntimeLockPair({
    packageJson: await ctx.io.readFile(`${dir}/${RUNTIME_LOCK_FILENAMES.packageJson}`),
    lock: await ctx.io.readFile(`${dir}/${RUNTIME_LOCK_FILENAMES.lock}`),
  })
  if (!read.ok) {
    throw new SetupStepError(`${read.error}。这一版的更新包是坏的,先别升 —— 把这句话发给维护者(要发版的人重发一次)。你这会儿在用的那一份运行环境没有被动过。`)
  }
  ctx.log(`用更新包里带的运行环境清单(dsh ${lockedDshVersion(read.pair) ?? '?'}):${dir}`)
  return read.pair
}

/**
 * 把装好的 `runtime-next` 换成 `runtime`,旧的那份换名成 `runtime-prev`(2026-09-25 升 0.1.7)。
 *
 * 顺序与每一步为什么:
 *
 * 1. **先腾空 `runtime-prev`**:上一次升级留下的那一份要让位。`rmrf` 的路径由 `paths` 算出来
 *    (0904 事故之后的规矩),而且这是升级路径上唯一被删的东西 —— 用户的 `sessions/`、
 *    `profiles/`、`workbench/` 一个字节都不碰。
 * 2. `runtime` → `runtime-prev`。旧那份**换名、不删**:回滚只要把它换回来,不用在慢网上
 *    重装一遍旧版本(评估 5.1 的回滚步骤第 2 步)。新机器上 `runtime` 根本不存在,这一步跳过。
 * 3. `runtime-next` → `runtime`。
 * 4. **第 3 步失败就把第 2 步换回去**。这是这个函数存在的全部理由:两次 rename 之间是唯一
 *    "没有 runtime"的瞬间,失败后必须回到一个能启动的状态,而不是留一台起不来的机器。
 */
export async function swapRuntime(ctx: StepCtx): Promise<void> {
  const { runtimeDir, runtimeNextDir, runtimePrevDir } = ctx.paths

  await ctx.io.rmrf(runtimePrevDir)
  const hadOld = await ctx.io.stat(runtimeDir) !== undefined
  if (hadOld) {
    const moved = await ctx.io.rename(runtimeDir, runtimePrevDir)
    if (!moved.ok) {
      throw new SetupStepError(`装好了新的运行环境,但换不过去(${runtimeDir} → ${runtimePrevDir}:${moved.message})。你这会儿在用的那一份没有被动过,工作台照常能用。再点一次这一步;还不行就把这句话发给维护者。`)
    }
    ctx.log(`旧运行环境换名留着:${runtimeDir} → ${runtimePrevDir}`)
  }

  const swapped = await ctx.io.rename(runtimeNextDir, runtimeDir)
  if (!swapped.ok) {
    // 换不过去:把旧那份换回原位 —— 宁可这次没升上去,也不能留一台起不来的机器。
    if (hadOld) {
      const back = await ctx.io.rename(runtimePrevDir, runtimeDir)
      ctx.log(back.ok ? `已把旧运行环境换回原位:${runtimePrevDir} → ${runtimeDir}` : `旧运行环境也换不回去(${back.message})`)
      if (back.ok) {
        throw new SetupStepError(`装好了新的运行环境,但换不过去(${runtimeNextDir} → ${runtimeDir}:${swapped.message})。已经把原来那一份换回原位了,工作台照常能用。再点一次这一步;还不行就把这句话发给维护者。`)
      }
      throw new SetupStepError(`换运行环境时出了岔子:新的换不过去(${swapped.message}),旧的也换不回去。现在 ${runtimePrevDir} 是原来那一份、${runtimeNextDir} 是新的 —— 把这句话原样发给维护者,别自己动这两个目录。`)
    }
    throw new SetupStepError(`装好了新的运行环境,但换不过去(${runtimeNextDir} → ${runtimeDir}:${swapped.message})。再点一次这一步;还不行就把这句话发给维护者。`)
  }
  ctx.log(`新运行环境已换上:${runtimeNextDir} → ${runtimeDir}`)
}

/** 跑在 ~/.dsh 上下文里的命令要的环境:自有 node 优先,DSH_HOME 指对。 */
function dshEnv(paths: SetupPaths): Record<string, string> {
  return {
    DSH_HOME: paths.dshHome,
    // 第一段是自有 node 的 bin —— **自带的 pnpm 那个小脚本也在那儿**(卡 PN),
    // 所以 `dsh plugin add` 转手给 pnpm 时找到的是我们自己带的那一份,
    // 而不是碰运气看这台机器上有没有 Homebrew 装过 pnpm。
    PATH: `${paths.dshHome}/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  }
}

/**
 * dsh-start 里那一行 `WORKBENCH_BUTLER_CWD` 渲染成本机仓库路径(纯函数,可测)。
 *
 * 为什么非改不可:这个变量决定事务官的会话开在哪个仓库、引导的记忆写进哪个仓库。
 * 仓库副本里写的是 Ben 那台机器的路径,照抄到别的机器上就是"引导整块 404"(鸡生蛋)。
 */
export function renderDshStart(text: string, repoRoot: string, dshHome?: string): string {
  let out = text
  if (/^export WORKBENCH_BUTLER_CWD=/m.test(out)) {
    out = out.replace(/^export WORKBENCH_BUTLER_CWD=.*$/m, `export WORKBENCH_BUTLER_CWD="${repoRoot}"`)
  }
  // `dshHome` 只在它**不是** `$HOME/.dsh` 时才传进来(裸机引导在临时目录里验证的那种情形)。
  // 不改这一行的话,脚本一跑就又回到 `$HOME/.dsh`,装在别处的那一份等于白装。
  if (dshHome !== undefined && dshHome !== '' && /^export DSH_HOME=/m.test(out)) {
    out = out.replace(/^export DSH_HOME=.*$/m, `export DSH_HOME="${dshHome}"`)
  }
  return out
}

/**
 * plist 模板 → 本机 plist(纯函数,可测)。
 *
 * 两种模板都要认:
 *   ① 仓库 deploy/ 里新加的那份用 `{{HOME}}` 占位(不含任何本机私有值);
 *   ② butler-server/launchd/ 里那份是 2026-09-11 照抄本机写的,路径里带着 `/Users/<某人>/`
 *      —— 那份还被交接文档里的 `cp` 直接引用着,不能改它,所以这里把家目录前缀换掉。
 */
export function renderPlist(template: string, home: string): string {
  return template
    .replaceAll('{{HOME}}', home)
    .replace(/<string>\/Users\/[^/<]+\/([^<]*)<\/string>/g, `<string>${home}/$1</string>`)
}

/**
 * cordis.patch.yml:缺什么补什么(纯函数,可测)。
 *
 * **不整体覆盖**:这个文件是 profile 的补丁层,以后还会装别的东西(dsh-context 就在里面)。
 * 一把覆盖等于把别人的补丁抹掉。所以只看三件事在不在:工作台的 insert、cookie 寿命、
 * 对用户关掉的上游新入口(2026-09-25 升 0.1.7 时加的第三件)。
 */
export const PROFILE_INSERT_BLOCK = `# 桌面工作台插件(desktop-workbench/workbench-plugin)。
- insert:
    - id: ben-workbench
      name: '@ben/dsh-workbench'
`
/**
 * cookie 寿命那一行的 id。
 *
 * ## 2026-09-26(卡 U4 灰度)撞出来的:这一行一直没生效过
 *
 * 原来写的是 `client-connection` —— 那是**包名**(`@deepseek-ai/dsh-client-connection`)
 * 去掉前缀,不是组合里那一行的 **id**。组合里的 id 从 0.1.2-rc.1 到 0.1.7-rc.2 一直都是
 * `connection`(两个 checkout 逐字比过)。补丁层按 id 找不到就只 `warn` 一句然后跳过
 * (`vendor/include/src/index.ts` 的 `patch: entry %C not found`,两个版本同一段代码),
 * **进程照样起来、界面一切正常**,所以这件事一直没人发现:
 * 灰度实例 `web --dump-config` 里 `- id: connection` 那一行的 config 只有 `trustedHosts`,
 * **没有 `cookieMaxAgeDays`** —— 也就是说 cookie 一直是上游默认的 30 天,
 * 「引导一次长期有效」这句话从来没成立过(30 天后他会被要求重新拿 token)。
 *
 * 这不是升级带来的,是升级顺手照出来的。守门两道:`tests/client-upstream-seats.test.ts`
 * 那条「patch 里每个 id 都得在上游真组合里存在」拿 id 去对上游 checkout 的 yml;
 * `tests/install-shape-profile-patch.test.ts` 把 `renderProfilePatch` 写出来的那份放进 scratch 机器,
 * 起**装在机器上的真 dsh** `--dump-config`,逐行断言 stderr 里没有 `entry "…" not found`、
 * 合成结果里那一行真带上了我们写的值 ——**这一类沉默失效只有真 dsh 认一遍才看得见**,
 * 跟关插件那五行是同一个道理(见 `PROFILE_DISABLE_BLOCK` 的注释)。
 */
export const PROFILE_COOKIE_ROW_ID = 'connection'
/** 老机器上那个错 id:升级时要把它改对,不能只当"已经补过了"放着。 */
export const PROFILE_COOKIE_WRONG_ROW_ID = 'client-connection'

export const PROFILE_COOKIE_BLOCK = `# DSH 0.1.2-rc.1 起网页要 token 或签名 cookie 才能开;把 cookie 寿命拉长,引导一次长期有效。
# 补丁会整体替换该行的 config,所以 trustedHosts 表达式要照抄 bundle 里的原文。
# 0.1.7-rc.2 复核过:上游 web 组合那一行仍是 \`trustedHosts: !!js ctx.webRuntime.trustedHosts\`,
# \`cookieMaxAgeDays\` 这个配置项也还在(默认仍 30 天),照抄成立。
# id 是 \`${PROFILE_COOKIE_ROW_ID}\`(不是包名 \`dsh-client-connection\`)—— 写错 id 补丁会被静默跳过。
- id: ${PROFILE_COOKIE_ROW_ID}
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
    cookieMaxAgeDays: 3650
`

/**
 * 升 0.1.7 时要对**用户**关掉的上游新入口。
 *
 * ## 清单只有一份(2026-09-26,卡 U4 合并时统一)
 *
 * 要关哪几行**不写在这里**,写在 `src/upstreamEntries.ts` 那张表里,这里只把
 * `ROWS_OFF_FOR_USERS` 渲染成 YAML。U1 与 U2 各自列过一份(四条 / 三条,内容不一样),
 * 并成一份取那张表,是因为它带着守门(`tests/client-upstream-seats.test.ts`):
 * **patch 按 id 覆盖,id 打错一个字,那一行就变成「新加一个没人认识的插件」——
 * 终端照样开着,而界面上一切正常。** 这种错在界面上看不出来,只有把 id 拿去跟上游真组合
 * 对一遍才发现,所以清单必须待在有守门的那一侧。
 *
 * 决策记录 2026-09-26 凌晨拍定的五行:右侧栏终端两半(`ui-sidebar-terminal` +
 * `terminal-controller`)、插件管理页(`ui-plugin-manager`)、账号页(`ui-settings-account`)、
 * ⌘/ 那张整屏快捷键参考页(`ui-shortcuts`)。
 *
 * ## 为什么是 `disabled: true` 而不是删行
 *
 * 这几行是**上游 web 组合自己 insert 进来的**,我们的 `cordis.patch.yml` 是排在它后面的
 * overlay 层。overlay 里写 `- id: X` + `disabled: true` 正是上游给的用法 —— 0.1.7-rc.2 的
 * `packages/bundle/base/cordis.patch.yml` 在 `tool-ralph` 那一段的注释里逐字写着
 * 「An overlay row restores it for a base-backed profile (`$DSH_HOME/cordis.patch.yml`,
 * or a `--patch <file>`): `- id: tool-ralph` / `disabled: false`」,而 `web-app` 组合自己
 * 就是这么关掉 base 里 `tool-bash` / `tool-jobs` 那一批的。删行做不到:下层 insert 进来的行
 * 不在我们这一层里,没有行可删。
 *
 * ## 为什么这几条不写 `config`
 *
 * 「补丁整体替换该行的 config」是这个文件最容易踩的一条 —— 五条在上游 web 组合里都是
 * **光秃秃的 id + name、没有 config**(0.1.7-rc.2 `packages/bundle/web-app/cordis.patch.yml`
 * 逐条核过),所以只写 `disabled` 不会抹掉任何配置。哪天上游给它们加了 config,这里要跟着
 * 照抄一遍 —— 与 cookie 那一块同一条纪律。
 *
 * ## 为什么关这几条、不关别的(逐条理由在 `upstreamEntries.ts` 每一行的 `why` 里)
 *
 * **维护者要用某一项**:把它那两行从 `~/.dsh/profiles/web/cordis.patch.yml` 里删掉即可。
 * `renderProfilePatch` 靠 `PROFILE_DISABLE_MARK` 判"补过没有",删掉行不会被下一次一键装塞回去。
 *
 * **有意不关的**:`shortcuts`(命令注册表,`ui-settings-general` 靠它注册「打开设置」,
 * 关了连设置入口一起坏 —— 跟要关的 `ui-shortcuts` 差三个字)、只读的插件清单页
 * (`ui-settings-plugin-inventory`)、文件 / 改动 / 文档预览(`ui-sidebar-files`、
 * `ui-deliverables`、`ui-sidebar-documentpreview` + `office-to-pdf`);定时任务
 * (`schedule` / `ui-schedule`)与 `time-context` 保持**上游默认** —— 上游自己已经写着
 * `disabled: true`,我们一行都不加(以后要开是把上游那一行覆盖成 `disabled: false`,
 * 而不是删我们的行);侧边栏浏览器 `ui-sidebar-browser` 上游在非 desktop profile 上本来就关。
 */
export const PROFILE_DISABLE_BLOCK = `# 对用户关掉的上游新入口(升 0.1.7 时定;清单与逐条理由在插件源码 src/upstreamEntries.ts)。
# 维护者自己要用某一项:把它那两行删掉即可,登录台不会再补回来。
${ROWS_OFF_FOR_USERS.map(id => `- id: ${id}\n  disabled: true`).join('\n')}
`

/**
 * 判「关插件那一段补过没有」的记号。
 *
 * 用注释里那句中文、**不用某一个 id**:维护者删掉其中一两行(他要用终端)之后,这个文件
 * 仍然算"补过了",不会在下一次一键装 / 热更新时被悄悄塞回去 —— 那会是一次把人的选择
 * 无声抹掉的行为。
 */
export const PROFILE_DISABLE_MARK = '对用户关掉的上游新入口'

/**
 * 首次使用不弹上游的「添加一个 API Key」框(2026-09-26,卡 AK)。
 *
 * ## 那个框是谁、什么时候弹
 *
 * 上游 `ui-settings-models` 往 `settings.onboarding` 槽注册了一步 `deepseek-official`
 * (`DeepSeekOnboardingDialog`,标题 `onboardingTitle: '添加一个 API Key 开始使用'`)。
 * 弹不弹只由一条判据决定 —— `store.ts` 的 `onboardingReadiness` → `providerUsable`:
 *
 * ```ts
 * if (!row.entry.active) return false                  // 路由没注册
 * if (row.apiKeyEnv === undefined) return true         // profile 没写凭据引用 = 不欠 key
 * return row.credential?.configured === true           // 写了就得真有那个凭据
 * ```
 *
 * **一个能用的 provider 都没有**才弹。我们那条路由 `workbench-relay` 写的是
 * `apiKeyEnv: WORKBENCH_RELAY_TOKEN`,而那个令牌是**用户注册 / 登录之后我们的服务器才发下来的**
 * —— 也就是说,**第一次打开工作台的那一刻,这条判据在物理上就不可能满足**:令牌还不存在。
 * (灰度 3085 上逐格验过:补丁层里有中转两段 + `.env` 里有令牌 → 不弹;把令牌拿走 → 弹,
 * 而且 `OnboardingModal` 把 `#root` 设成 inert,我们的注册页整页点不动。)
 *
 * 所以「把上游的检查喂满」这条路在首屏走不通,只能用上游自己给的开关。
 *
 * ## 为什么这是机制、不是把框藏起来
 *
 * 0.1.7 给 `ui-settings-models` 的 **Host 半区**新加了一个配置项(0.1.2 没有):
 *
 * ```ts
 * export interface Config {
 *   // 注释原文:Offer the browser API-key step when no native shell owns credential onboarding.
 *   credentialOnboarding: boolean
 * }
 * ```
 *
 * 原话就是「**当没有一个原生壳接管凭据引导时**,才提供浏览器里那一步 API Key」。
 * 工作台正是那个壳:账号、令牌、模型服务全由我们自己的注册 → 引导 → 事务官出场这条线管。
 * 配成 `false` 之后,上游那一步拿到 `automatic: false`,自己 `complete()` 并渲染 `null`
 * (`DeepSeekOnboardingDialog` 第一段),**是上游按设计让位,不是我们遮住它**。
 *
 * 跟壳里那道 `onboardingGate`(`src/client/onboardingGate.ts`)的分工:那一道只在壳里
 * (`?ben-workbench=app`)拦,而且只拦「按 order 取第一个没 complete 的」那条路;
 * 浏览器里直接开 3080、事项页内嵌的那一层、以及 0.1.7 新增的「点名某一步」,它都拦不住。
 * 这一行在 **Host 半区**,所有这些面一次全覆盖。两道都留着(纵深),不互相替代。
 *
 * ## 留下了什么
 *
 * 只关掉**自动弹的那一步**。设置 → 模型那一页原样留着(`ui-settings-models` 不 disabled),
 * 想自己填 Key 的人照样填得了;`openOnboarding('deepseek-official')` 那条「点名」路也还在。
 *
 * ## 写 config 的纪律
 *
 * 补丁按 id **整体替换** config。上游 web 组合里 `ui-settings-models` 那一行是**光秃秃的
 * id + name、没有 config**(0.1.7-rc.2 `packages/bundle/web-app/cordis.patch.yml:288` 逐字核过),
 * 所以写这一个键不会抹掉任何东西;而 `Config` 也只有这一个键。哪天上游给它加了别的配置项,
 * 这里要跟着照抄一遍 —— 与 cookie 那一块同一条纪律,守门在 `tests/client-upstream-seats.test.ts`。
 */
export const PROFILE_MODELS_ONBOARDING_ROW_ID = 'ui-settings-models'

/**
 * 判「这一段补过没有」的记号。同 `PROFILE_DISABLE_MARK` 的理由:用注释里那句话、不用 id ——
 * 维护者把这一段删掉(他就想要上游那个框)之后,下一次开机 / 热更新不会再悄悄塞回去。
 */
export const PROFILE_MODELS_ONBOARDING_MARK = '上游的「添加一个 API Key」框'

export const PROFILE_MODELS_ONBOARDING_BLOCK = `# 首次使用不弹${PROFILE_MODELS_ONBOARDING_MARK}(2026-09-26,卡 AK)。
# 上游这个配置项的原话是「当没有一个原生壳接管凭据引导时才提供这一步」——
# 工作台就是那个壳(账号、令牌、模型服务都走我们自己的注册与引导),所以这里让位给我们。
# 只关自动弹的那一步;设置里的模型页原样留着,想自己填 Key 照样填得了。理由全文在
# 插件源码 src/server/setup/install.ts 的 PROFILE_MODELS_ONBOARDING_BLOCK。
- id: ${PROFILE_MODELS_ONBOARDING_ROW_ID}
  config:
    credentialOnboarding: false
`

export function renderProfilePatch(existing?: string): string {
  const base = existing ?? '# 工作台登录台生成(可以继续往下加别的补丁)。\n'
  let out = base.endsWith('\n') ? base : `${base}\n`
  /**
   * 老机器上 cookie 那一行的 id 是错的(见 `PROFILE_COOKIE_ROW_ID` 的注释:一直没生效过)。
   * **只改这一行的 id**,不重写整块 —— 他可能自己调过 `cookieMaxAgeDays` 的天数,
   * 那是他的选择;这里修的是"这一行根本没被认出来"。
   * 光靠下面那句 `includes('cookieMaxAgeDays')` 不够:老文件里有这个词,于是会被当成
   * "已经补过了"而永远带着错 id —— 那正是这个 bug 活了这么久的原因。
   */
  out = out.replace(
    new RegExp(`^- id: ${PROFILE_COOKIE_WRONG_ROW_ID}$`, 'm'),
    `- id: ${PROFILE_COOKIE_ROW_ID}`,
  )
  if (!out.includes('ben-workbench')) out += `\n${PROFILE_INSERT_BLOCK}`
  if (!out.includes('cookieMaxAgeDays')) out += `\n${PROFILE_COOKIE_BLOCK}`
  if (!out.includes(PROFILE_DISABLE_MARK)) out += `\n${PROFILE_DISABLE_BLOCK}`
  /**
   * 老机器上没有这一段(它是 0.1.7 之后才加的),所以这一行同时是「新装机器写上」与
   * 「已装机器开机 / 热更新时幂等补上」两件事 —— 卡 AK 要求的「老用户升上来后不该再弹」
   * 就落在这里。判据是注释里那句话,补过一次就不再动(维护者删掉也不会被塞回去)。
   */
  if (!out.includes(PROFILE_MODELS_ONBOARDING_MARK)) out += `\n${PROFILE_MODELS_ONBOARDING_BLOCK}`
  return out
}

/**
 * 把 `butler_cwd` 并进 `~/.dsh/workbench/app.json`。
 *
 * **只改这一个键**,文件里别的键原样保留(那个文件还装着「允许手机在局域网访问」等等)。
 * `onlyIfAbsent` 时已经配过就一个字不动 —— 他在设置里选过的目录,不能被"再装一次启动脚本"
 * 这种动作悄悄改掉。
 *
 * 读不动或者写坏了的 JSON:不猜、不修,从一份干净的默认值重写。这个文件此刻要么是
 * 安装器刚建的机器上的第一份,要么本来就已经坏了 —— 两种情形都没有值得抢救的内容。
 */
export async function writeButlerCwd(io: SetupIo, paths: SetupPaths, dir: string, options: { onlyIfAbsent?: boolean } = {}): Promise<boolean> {
  const text = await io.readFile(paths.appJson)
  let config: Record<string, unknown> = { version: 1, lan_access: false }
  if (text !== undefined) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        config = { ...(parsed as Record<string, unknown>) }
      }
    }
    catch { /* 写坏了:按上面那份默认值来 */ }
  }
  if (options.onlyIfAbsent === true && typeof config.butler_cwd === 'string' && config.butler_cwd !== '') return false
  config.version = 1
  config.butler_cwd = dir
  await io.writeFile(paths.appJson, `${JSON.stringify(config, null, 2)}\n`)
  return true
}

/**
 * 新装机器上 DSH 的 settings.yaml 该有的几条(纯函数,可测)。两件事,各自只补缺:
 *
 * 1. `ui-onboarding.welcomeNoticeVersion`(见 `renderWelcomeNoticeAck`):不弹上游的内测声明。
 * 2. **默认走中转**:没有 `agent-default-model` 段时,先按上游缺省(`DSH_UPSTREAM_DEFAULT_MODEL`)
 *    写一段,再交给模型面板**同一个** `settingsForRelay` 装上 workbench-relay 那段、把 provider 指过去
 *    —— 结果与"选了缺省模型、再在设置里点中转"逐字相同,不另写一份。
 *    为什么要播:登录领到令牌后 `applyToDsh` 只**改** settings.yaml,文件不在或没有
 *    agent-default-model 段就放弃(「工作台不敢替你猜」),新装的机器 DSH 那侧就一直没接上中转。
 *    已有 agent-default-model 段 = 选过了,不动;有一段他自己配的 llm-pi-ai 时
 *    `settingsForRelay` 会拒绝,这件就整个不做。
 *
 * 令牌不在这里写:它登录之后才领得到,由模型面板写进 `.env` 并重启 DSH(交接-0921)。
 * 所以**令牌到之前上游那个「添加一个 API Key」框照样会弹**,见交接-0923-安装器锁运行时依赖.md。
 */
export function renderDshSettingsSeed(
  existing: string | undefined,
  /** 中转地址:model.json 的 `relay_url`(自建中转的人装之前先填好它),缺省官方那台。 */
  relayUrl: string = DEFAULT_RELAY_URL,
): { text: string, changes: string[] } {
  const changes: string[] = []
  let text = renderWelcomeNoticeAck(existing)
  if (text !== (existing ?? '')) changes.push(`ui-onboarding.welcomeNoticeVersion = ${DSH_WELCOME_NOTICE_VERSION}`)
  if (readAgentDefaultModel(text) === undefined) {
    const { provider } = DSH_UPSTREAM_DEFAULT_MODEL
    // provider 照上游缺省写(下一行 settingsForRelay 会把它指到中转),
    // **model 用我们中转认的那个 id**(`SEEDED_DEFAULT_MODEL`)—— settingsForRelay 不碰 model 那一行,
    // 照抄 0.1.7 上游的 `deepseek-flash` 会给新机器播一个中转不认的名字。理由见 paths.ts。
    const model = SEEDED_DEFAULT_MODEL
    const withDefault = `${text.endsWith('\n') ? text : `${text}\n`}agent-default-model:\n  provider: ${provider}\n  model: ${model}\n`
    const relay = settingsForRelay(withDefault, { baseUrl: `${relayUrl}/v1` })
    if (relay.ok) {
      text = relay.text
      changes.push(`agent-default-model → ${DSH_RELAY_PROVIDER} / ${model}`)
    }
  }
  return { text, changes }
}

/**
 * 往 DSH 的 settings.yaml 里合并 `ui-onboarding.welcomeNoticeVersion`(纯函数,可测)。
 *
 * **只动这一个键**:文件不存在就建;没有 `ui-onboarding:` 段就在文件头插一段;有段就只改/补
 * 这一行,段里别的键、别的段(模型设置等)一个字不动。值不一样(上游 bump 过)一律改成当前的。
 */
export function renderWelcomeNoticeAck(existing: string | undefined): string {
  const line = `  welcomeNoticeVersion: ${DSH_WELCOME_NOTICE_VERSION}`
  if (existing === undefined || existing.trim() === '') return `ui-onboarding:\n${line}\n`
  const lines = existing.split('\n')
  const start = lines.findIndex(item => /^ui-onboarding:\s*(\{\s*\})?\s*(#.*)?$/.test(item))
  if (start === -1) {
    // 行内写法(`ui-onboarding: {a: 1}`)不去解析,原样留着 —— 宁可多弹一次框,不弄坏别人的设置。
    if (lines.some(item => item.startsWith('ui-onboarding:'))) return existing
    return `ui-onboarding:\n${line}\n${existing}`
  }
  lines[start] = 'ui-onboarding:'
  let end = start + 1
  while (end < lines.length && !/^[A-Za-z0-9_-]+:/.test(lines[end] as string)) end += 1
  const at = lines.slice(start + 1, end).findIndex(item => /^\s+welcomeNoticeVersion:/.test(item))
  if (at === -1) lines.splice(start + 1, 0, line)
  else lines[start + 1 + at] = line
  return lines.join('\n')
}

/**
 * profile 的 package.json 骨架(没有时才写;已有就一个字不动)。
 *
 * 2026-09-25(升 0.1.7):去掉了 `patchReload: 'live'`。0.1.2 的 app-boot 读这个键
 * (`packages/boot/app-boot/src/profile.ts`),0.1.7 **一处都不读了** —— 改 patch 要不要热重载
 * 由组合里的 `dsh-hmr` 决定(web 模板默认开)。留着它不会报错(profile manifest 只读
 * `dsh.profile.bundles`),但它会变成一句骗人的话:看到的人会以为热重载是这儿配的。
 * 已经装过的机器上那个键还在,同样无害 —— 这个函数只在文件不存在时写。
 */
export function profilePackageJson(): string {
  return `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2)}\n`
}

/** `npm pack` 的输出里挑出 tgz 文件名。npm 会把别的话也打到 stdout,所以按后缀找最后一条。 */
export function packedTarball(out: string): string | undefined {
  const names = out.split('\n').map(line => line.trim()).filter(line => line.endsWith('.tgz'))
  return names[names.length - 1]
}

// ───────────────────────────── 十一步 ─────────────────────────────

const STEPS: Record<SetupInstallStep, (ctx: StepCtx) => Promise<StepResult>> = {
  /**
   * 自有 node。做法照 0907 事故恢复:**把这会儿跑着的这条 node 复制过去**,
   * 而不是去下载一个 —— 它已经被证明能跑 DSH,而且复制出来的那份从此不会自己更新
   * (macOS 的文件夹授权认二进制,别人更新一次授权就没了,0827 事故)。
   */
  async node(ctx) {
    const target = ctx.paths.nodeBin

    /**
     * `~/.dsh/node/bin/npm` 在不在(2026-09-27,卡 PN 顺带修的第二个坑)。
     *
     * **为什么这一条也要管**:下一步(装运行环境)跑的是 `npm ci`,它靠 `dshEnv()` 的 PATH
     * 找 npm,而第一段正是 `~/.dsh/node/bin`。只复制一条 `node` 二进制过去的那条路(②)
     * **不会带上 npm** —— 于是一台没有 Homebrew 的机器上下一步立刻死在「命令 `npm` 退出码 -1」。
     * 官方独立包里 node 与 npm 是一起的,所以缺 npm 就改下整包。
     */
    const hasNpm = async (): Promise<boolean> => await ctx.io.stat(`${ctx.paths.nodeDir}/bin/npm`) !== undefined

    // ① 已经有一份能跑、又够新、而且 npm 也在的:一个字不动(幂等)。
    if (await ctx.io.stat(target) !== undefined) {
      const version = await nodeVersionOf(ctx, target)
      if (version !== undefined && majorOf(version) >= MIN_NODE_MAJOR) {
        if (await hasNpm()) {
          ctx.note(`已经有一份 v${version},不用换`)
          return
        }
        ctx.log(`有一份 v${version},但同一个目录里没有 npm(装运行环境那一步要它)—— 下官方独立包补齐`)
        await downloadNode(ctx)
        return
      }
    }

    // ② 先试最省事的:把这会儿跑着的这条复制过去(0907 事故恢复的做法)。
    const source = ctx.io.currentNodeBinary()
    if (source === target) {
      if (await hasNpm()) {
        ctx.note('这会儿跑着的就是自有 node,不用复制')
        return
      }
      ctx.log('这会儿跑着的就是自有 node,但同一个目录里没有 npm —— 下官方独立包补齐')
      await downloadNode(ctx)
      return
    }
    ctx.note('复制 node 二进制')
    await ctx.io.mkdirp(`${ctx.paths.nodeDir}/bin`)
    await ctx.io.copyFile(source, target, 0o755)
    const probe = await ctx.io.exec([target, '-p', 'process.versions.node'])
    if (probe.ok && await hasNpm()) {
      ctx.log(`已复制:${source} → ${target}`)
      ctx.log(NODE_TCC_HINT)
      return
    }
    if (probe.ok) {
      // 复制过来跑得起来,但那个目录里没有 npm(复制只带了一条二进制)。
      ctx.log('复制过来的 node 跑得起来,但 ~/.dsh/node/bin 里没有 npm —— 装运行环境那一步会死在"找不到 npm",所以改下官方独立包。')
      await downloadNode(ctx)
      return
    }

    // ③ 复制过来跑不起来。**这不是异常,是裸机上的常态**:Homebrew 装的 node 只是
    //    `bin/node` 一个二进制,它的 libnode 在隔壁 `lib/` 里,靠 `@loader_path/../lib` 找
    //    (2026-09-17 实测:`dyld: Library not loaded: @rpath/libnode.147.dylib`)。
    //    所以改下官方独立包 —— 那份自带全部依赖,而且从此不随 Homebrew 更新,
    //    正是「自有 node」当初要的东西(0827 事故)。
    ctx.log('复制过来的那份跑不起来(多半是 Homebrew 装的 node:它的 libnode 在隔壁 lib/ 里,单拎一个二进制出来必然 dyld 报错)。')
    for (const line of tailLines(probe.out, 5)) ctx.log(`  | ${line}`)
    await downloadNode(ctx)
  },

  /**
   * DSH 运行时。**整棵依赖树锁死**(2026-09-23),而且**先装到 runtime-next 再原子换名**
   * (2026-09-25,升 0.1.7)。
   *
   * ## 锁整棵树(09-23)
   *
   * 以前是 `npm i @deepseek-ai/dsh@<锁定版本>` + 再 `npm i` 补三个 client 包 —— 顶层锁住了,
   * 传递依赖照 ^ 范围拉最新,09-23 上游发的 cordis 一家就把新装的机器弄成了启动即崩。
   * 三个 client 包已经是锁定清单的顶层依赖,第二条 `npm i` 去掉(它会再解析一次范围)。
   * 来龙去脉与「换 DSH 版本时怎么重生成」见 dshRuntimeLock.ts。
   *
   * ## 先装到 runtime-next 再换名(09-25)
   *
   * 这一步原来直接往 `runtime` 里 `npm ci`。装一台**新机器**时那没问题(那儿本来是空的),
   * 但升级一台**已经在用的机器**时它有两个坏处:
   *
   * 1. `npm ci` 干的第一件事就是清掉 `node_modules`。慢网上这一步要几分钟,中途断网 / 断电 /
   *    关机,机器就停在"半棵依赖树"上 —— DSH 起不来、页面白屏,而用户看不出是哪一步坏的。
   *    这正是 09-23 白屏事故的形状,只是原因从"版本漂"换成了"装了一半"。
   * 2. 没有可回滚的旧运行时。0.1.7 的会话文件是**单向迁移**(V0 → V4,旧版读不了新文件),
   *    回滚时最要紧的就是那份旧 runtime 还在手边(评估 5.1)。
   *
   * 所以:装在 `runtime-next` 里 → 核过关键包版本 → 两次 rename 换过去
   * (`runtime` → `runtime-prev`,`runtime-next` → `runtime`)。装失败或版本核不过,
   * **旧 runtime 一个字节没动**,机器照旧能用。第二次 rename 万一失败,把第一次换回来。
   *
   * ## 换名那一下与正在跑着的 DSH
   *
   * 换名不会影响已经加载进内存的模块,但一次**换名之后才发生的**惰性 import 会打到新那棵树上。
   * 所以热更新把这一步排在**最后一步**、紧接着 `launchctl kickstart`(apply.ts 的 `PLANNED_STEPS`),
   * 窗口只有几秒;而且真撞上了也自愈 —— plist 写着 `KeepAlive.SuccessfulExit=false`,
   * 崩一下 launchd 立刻拉起,拉起来的就是新运行时(dsh-start 里 `cd "$DSH_HOME/runtime"`)。
   */
  async runtime(ctx) {
    const { runtimeDir, runtimeNextDir } = ctx.paths

    // ⓪ 用哪一对锁定清单:热更新传下下来的那一对,别的路子用插件里编进来的那一对。
    //    三处(写清单、判幂等、核版本)必须用**同一对** —— 用混了会出现
    //    "照新清单装完、拿旧清单核版本"这种假红,或者"拿旧清单判成已经装好了"这种假绿。
    const pair = await resolveRuntimeLockPair(ctx)
    const version = lockedDshVersion(pair) ?? LOCKED_DSH_VERSION

    // ① 已经照这份清单装完、关键包版本都对:一个字不动(幂等)。
    //    `node_modules/.package-lock.json` 是 npm 装完最后才写的,拿它当"上次装完了"的记号。
    if (isLockedRuntimeLock(await ctx.io.readFile(`${runtimeDir}/package-lock.json`), pair)
      && await ctx.io.stat(`${runtimeDir}/node_modules/.package-lock.json`) !== undefined
      && (await runtimeDrift(ctx.io, runtimeDir, pair)).length === 0) {
      ctx.note(`已经照锁定清单装好了(dsh ${version}),不用装`)
      return
    }

    // ② 暂存目录:写清单 + npm ci。
    //    **每次从头开始**(先 rmrf 再建):上一趟断在半路留下的 node_modules 会让 npm ci
    //    多花时间去清,而且它本来就是个由 paths 算出来的、只属于这一步的目录
    //    (0904 家目录事故之后的规矩:能被 rmrf 的路径一律由 paths 算,不由字符串拼)。
    await ctx.io.rmrf(runtimeNextDir)
    await ctx.io.mkdirp(runtimeNextDir)
    await ctx.io.writeFile(`${runtimeNextDir}/package.json`, runtimePackageJsonText(pair))
    await ctx.io.writeFile(`${runtimeNextDir}/package-lock.json`, runtimeLockText(pair))
    ctx.log(`已写锁定清单:${runtimeNextDir}/package.json、package-lock.json`)
    ctx.note(`照锁定清单装 DSH ${version} 运行环境(网络慢会久一点;断了再点一次会接着装,这会儿在用的那一份一个字没动)`)
    await run(ctx, [
      'npm', 'ci',
      // 网络慢要能续传(0907 实测:不给这两个参数会在 fetch 上直接超时放弃)。
      '--fetch-timeout=300000', '--fetch-retries=5',
      // 这两样各要一次额外的联网请求,装运行时用不上。
      '--no-audit', '--no-fund',
    ], { cwd: runtimeNextDir, env: dshEnv(ctx.paths), timeoutMs: ctx.npmTimeoutMs, why: '装 DSH 运行环境失败' })

    // 0907 记过的一处:node-pty 的 spawn-helper 解包后可能没有执行位,少了它终端起不来。
    const helper = `${runtimeNextDir}/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`
    if (await ctx.io.stat(helper) !== undefined) {
      await ctx.io.chmod(helper, 0o755)
      ctx.log(`已补执行位:${helper}`)
    }

    // ③ 守卫:关键包逐个对版本。对不上就停在这里报清楚 —— 留一个启动即崩的 dsh 比装失败更糟
    //    (界面只会白屏,看不出是哪一步坏的)。**在换名之前核**,所以这一关没过时
    //    这会儿在用的那份运行时仍然是好的。
    const drift = await runtimeDrift(ctx.io, runtimeNextDir, pair)
    if (drift.length > 0) {
      throw new SetupStepError(`装出来的 DSH 运行环境跟锁定清单对不上:${describeDrift(drift)}。这样的 DSH 一启动就会崩(白屏),所以停在这里 —— 你这会儿在用的那一份没有被动过,工作台照常能用。再点一次会照清单重装;还不对就把这句话发给维护者。`)
    }

    // ④ 换名。同一个文件系统内 rename 是原子的,所以磁盘上永远没有"半棵树的 runtime"。
    await swapRuntime(ctx)
    ctx.note(`运行环境装好了(dsh ${version},关键包版本已核对)`)
  },

  /** profile web:目录 + package.json 骨架 + 补丁层(缺什么补什么,不覆盖别人的补丁)。 */
  async profile(ctx) {
    await ctx.io.mkdirp(ctx.paths.profileDir)
    if (await ctx.io.readFile(ctx.paths.profilePackageJson) === undefined) {
      await ctx.io.writeFile(ctx.paths.profilePackageJson, profilePackageJson())
      ctx.log(`已写:${ctx.paths.profilePackageJson}`)
    }
    else {
      ctx.log('profile 的 package.json 已存在,一个字不动')
    }
    // DSH 的 settings.yaml 播种(2026-09-23 从零重装验收):上游内测声明预先确认 + 默认走中转。
    // 只补缺的键,已有的段(选过的模型、自己配的 provider)一个字不动。
    //
    // **播过一次就不再播**(2026-09-25 升 0.1.7,灰度实测):0.1.7 没有 settings.yaml 这个
    // 文件了 —— 每次启动看见它就改名成 `settings.yaml.imported`、把里面每个段写进 profile 的
    // `cordis.patch.yml`(上游 `importLegacyDocument`)。所以播种只对**第一次**成立;
    // 之后那个文件永远不存在,不判这一条的话每次体检都会再播一份新的,而下次启动它又会被
    // 收进 profile —— 等于**把他自己选过的模型覆盖回默认值**。
    // `.imported` 在 = DSH 已经收下了我们播的那一份,这件事就做完了。
    const settings = await ctx.io.readFile(ctx.paths.dshSettingsYaml)
    const importedAlready = settings === undefined && await ctx.io.stat(ctx.paths.dshSettingsImported) !== undefined
    if (importedAlready) {
      ctx.log(`DSH 已经把播下去的那份设置收进 profile 了(${ctx.paths.dshSettingsImported}),不再播第二次`)
    }
    else {
      const seeded = renderDshSettingsSeed(settings, parseModelConfig(await ctx.io.readFile(ctx.paths.modelJson), () => '').relay_url)
      if (seeded.changes.length > 0) {
        await ctx.io.writeFile(ctx.paths.dshSettingsYaml, seeded.text)
        ctx.log(`已写:${ctx.paths.dshSettingsYaml}(${seeded.changes.join(';')})`)
      }
    }

    const existing = await ctx.io.readFile(ctx.paths.profilePatchYml)
    const next = renderProfilePatch(existing)
    if (next === existing) {
      ctx.note('补丁层已经齐了,不用改')
      return
    }
    /**
     * 改**他已经有的**那份补丁之前先备份一份(2026-09-26,卡 U4;做法同 U1b 的
     * `dshSettingsStore`)。原来这一步只往后追加,所以覆盖不掉东西;从这一版起还会
     * **改一行**(cookie 那一行的错 id,见 `PROFILE_COOKIE_ROW_ID`),就得有退路。
     *
     * - 只在**真要改**的时候备份:这一步每次开机 / 每次热更新都跑,不判就会慢慢把
     *   profile 目录塞满(同 U1b 那条理由)。
     * - 备份名带 `.bak-workbench-<时刻>`:profile 目录里只有 `cordis.patch.yml`
     *   这个名字会被 DSH 读,备份不会被当成第二份补丁。
     * - 备份失败照样改:备份只是多一道保险,不能因为它让升级卡住。
     */
    if (existing !== undefined) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      try {
        await ctx.io.copyFile(ctx.paths.profilePatchYml, `${ctx.paths.profilePatchYml}.bak-workbench-${stamp}`)
        ctx.log(`改之前先备份:${ctx.paths.profilePatchYml}.bak-workbench-${stamp}`)
      }
      catch { ctx.log('备份补丁层没成功(照样改,原文件的内容都在这条日志之后的写入里)') }
    }
    await ctx.io.writeFile(ctx.paths.profilePatchYml, next)
    ctx.log(`已写:${ctx.paths.profilePatchYml}`)
    ctx.note('profile 建好了')
  },

  /** 工作台插件:在仓库里 build → pack 到 ~/.dsh/packages → 装进 profile。 */
  async plugin(ctx) {
    let tarball: string
    let cwd: string
    const prebuilt = ctx.prebuilt.pluginTarball
    if (prebuilt !== undefined && prebuilt !== '') {
      // 安装器那条路:.tgz 已经在 .app 的 Resources 里,不构建(那台机器上没有仓库也没有 pnpm)。
      if (await ctx.io.stat(prebuilt) === undefined) {
        throw new SetupStepError(`安装包里找不到插件的 .tgz(${prebuilt})。这个安装包是坏的,重新下一份。`)
      }
      ctx.note('把插件放到 ~/.dsh/packages')
      await ctx.io.mkdirp(ctx.paths.packagesDir)
      tarball = prebuilt.split('/').pop() ?? 'workbench.tgz'
      await ctx.io.copyFile(prebuilt, `${ctx.paths.packagesDir}/${tarball}`)
      cwd = ctx.paths.packagesDir
    }
    else {
      const repo = needRepo(ctx)
      const pluginDir = `${repo}/workbench-plugin`
      ctx.note('构建插件')
      await run(ctx, ['pnpm', 'build'], { cwd: pluginDir, timeoutMs: ctx.buildTimeoutMs, why: '插件构建失败' })

      ctx.note('打包')
      await ctx.io.mkdirp(ctx.paths.packagesDir)
      const packed = await run(ctx, ['npm', 'pack', '--pack-destination', ctx.paths.packagesDir], {
        cwd: pluginDir, timeoutMs: ctx.buildTimeoutMs, why: '打包失败',
      })
      const named = packedTarball(packed)
      if (named === undefined) throw new SetupStepError('打包命令跑完了,但没能从输出里认出 .tgz 文件名')
      tarball = named
      cwd = pluginDir
    }

    // **装进 profile 之前先把 pnpm 放到位**(2026-09-27,卡 PN)。0.1.7 的 `dsh plugin add`
    // 转手给 pnpm,机器上没有就回 127 —— 这一段保证那件事跟用户装没装过 Homebrew 无关。
    await ensurePnpm(ctx)

    ctx.note('装进 profile web')
    /**
     * `dsh plugin add` 转手给 pnpm,而 pnpm 要去 registry 取这个插件的 **peer 依赖**
     * (2026-09-27 隔离环境实测:96 个包、约 37MB)。所以这一步**是要联网的**,
     * 而且默认走 registry.npmjs.org —— 国内那条线断流是常态。
     *
     * 做法与下 node 一样:**先官方、不成再换国内镜像**,而不是反过来。
     * 换过来的理由:包的完整性这一层靠的是 registry 给的 integrity,不像 node 那样有一份
     * 钉在仓库里的 sha256 兜着;官方那条能通的时候没有理由去信第三方。
     * (0.1.7 自己的 plugin 服务里也把 npmmirror 列成 fallback,口径一致。)
     */
    const addCommand = [
      ctx.paths.nodeBin, ctx.paths.runtimeBinJs, 'plugin', '--profile', 'web', 'add', `${ctx.paths.packagesDir}/${tarball}`,
    ]
    const addOptions = { cwd, env: dshEnv(ctx.paths), timeoutMs: ctx.buildTimeoutMs }
    ctx.log(`$ ${addCommand.join(' ')}`)
    const added = await ctx.io.exec(addCommand, { ...addOptions, onLine: line => ctx.log(line) })
    if (!added.ok) {
      ctx.note('官方源这一趟没成,换国内镜像再试一次')
      ctx.log(`装进 profile 没成(退出码 ${added.code}),换 ${NPM_MIRROR_REGISTRY} 再试一次`)
      await run(ctx, [...addCommand, `--registry=${NPM_MIRROR_REGISTRY}`], {
        ...addOptions,
        why: `装进 profile 失败(官方源退出码 ${added.code},换国内镜像也没成)`,
      })
    }
    ctx.note(`装好了(${tarball})。要最后点一次「重启」才生效。`)
  },

  /** 三个启动脚本。dsh-start 里的 WORKBENCH_BUTLER_CWD 用配置值渲染。 */
  async scripts(ctx) {
    const repo = needRepo(ctx)
    await ctx.io.mkdirp(ctx.paths.binDir)
    const customDshHome = ctx.paths.dshHome === `${ctx.paths.home}/.dsh` ? undefined : ctx.paths.dshHome
    const jobs: readonly { from: string, to: string, render?: (text: string) => string }[] = [
      // DSH_HOME 只在被覆盖过时才渲染(默认那种情形一个字不动,否则体检会把脚本判成「旧了」)。
      { from: `${repo}/workbench-plugin/bin/dsh-start`, to: ctx.paths.dshStart, render: text => renderDshStart(text, repo, customDshHome) },
      { from: `${repo}/workbench-plugin/bin/butler-start`, to: ctx.paths.butlerStart },
      { from: `${repo}/deploy/channel-start`, to: ctx.paths.channelStart },
    ]
    for (const item of jobs) {
      const text = await ctx.io.readFile(item.from)
      if (text === undefined) throw new SetupStepError(`仓库里找不到 ${item.from} —— 仓库路径选错了?`)
      await ctx.io.writeFile(item.to, item.render === undefined ? text : item.render(text), 0o755)
      ctx.log(`已写(755):${item.to}`)
    }
    // 本机房间的启动脚本(2026-10-21,卡 M1)。0.4.143 及以前打的包里没有它:没带就说一句,别的三份照装。
    if (!await installLivekitStart(ctx, repo)) ctx.log(`这一份里没有 deploy/livekit-start(本机通话服务的启动脚本),跳过它`)
    // dsh-start 从 2026-09-18 起**不再写死仓库路径**(环境变量压着 app.json,写死等于把
    // 设置里那一栏废掉)。所以第一次装脚本时把仓库路径记进 app.json —— **已经配过的不动**。
    if (ctx.recordButlerCwd && await writeButlerCwd(ctx.io, ctx.paths, repo, { onlyIfAbsent: true })) {
      ctx.log(`已记下事务官的落脚目录:${repo}(设置 → 目录 里可以改)`)
    }
    // 手机包(2026-09-18):普通用户的机器上没有仓库,首次流程里「手机端装好了吗」那张二维码只能从数据目录发。
    // 仓库(或安装器 payload)里有就带过去;没有不算失败——那一步会如实说「还没出过包」。
    // 安装器那条路 paths 是按工作目录算的(repoApk 指向工作目录,当然没有),所以先看 prebuilt。
    const apkSrc = ctx.prebuilt.apk ?? ctx.paths.repoApk
    if (apkSrc !== undefined && (await ctx.io.stat(apkSrc))?.isFile === true) {
      await ctx.io.mkdirp(ctx.paths.homeApk.replace(/\/[^/]+$/, ''))
      await ctx.io.copyFile(apkSrc, ctx.paths.homeApk, 0o644)
      ctx.log(`手机包已放到:${ctx.paths.homeApk}`)
    }
    ctx.note('三个启动脚本都装好了')
  },

  /**
   * launchd 三项(第三项本机房间 `ai.deepseek.livekit` 是 2026-10-21 卡 M1 加的)。bootstrap 已经装载过会报错,那不是失败。
   *
   * 本机房间那一项**二进制还没装也照装**:`livekit-start` 读不到二进制或配置就以 0 退出,
   * `KeepAlive.SuccessfulExit=false` 不会拉它,不会每 10 秒空转一次;装上二进制那一步再 kickstart 它。
   */
  async launchd(ctx) {
    const repo = needRepo(ctx)
    const items: readonly LaunchdItem[] = [
      { template: `${repo}/deploy/${DSH_LAUNCHD_LABEL}.plist`, target: ctx.paths.dshPlist, label: DSH_LAUNCHD_LABEL },
      { template: `${repo}/butler-server/launchd/${BUTLER_LAUNCHD_LABEL}.plist`, target: ctx.paths.butlerPlist, label: BUTLER_LAUNCHD_LABEL },
    ]
    for (const item of items) {
      if (await loadLaunchdItem(ctx, item) === 'no_template') throw new SetupStepError(`仓库里找不到 ${item.template} —— 仓库路径选错了?`)
    }
    // 0.4.143 及以前打的包里没有本机房间那份模板:没带就说一句,另两项照装。
    const livekit = await loadLaunchdItem(ctx, livekitLaunchdItem(ctx, repo))
    if (livekit === 'no_template') ctx.log(`这一份里没有 deploy/${LIVEKIT_LAUNCHD_LABEL}.plist(本机通话服务的开机自启),跳过它`)
    ctx.note(livekit === 'no_template' ? '两个 launchd 项都在了' : '三个 launchd 项都在了')
  },

  /**
   * 本机房间(2026-10-21,局域网主路卡 M1;设计稿第一节)。
   *
   * 二进制从安装包 / 热更新解开的 payload 里拿(`livekit/livekit-server`;开发机上是 `deploy/fetch-livekit.sh`
   * 放进 `dist/livekit/` 的那一份),出包时已经用「工作台本机签名」重签过 —— 这台机器上没有那张证书,不在这儿签。
   *
   * 1. 系统低于 macOS 15 就如实跳过(随包那份 bottle 的 minos 是 15.0,装上也起不来);
   * 2. 跟装着的那份**字节一样就不拷**:重签过的二进制换一次,系统防火墙就把它当新程序、再问一次;
   * 3. 拷到 `.new` 再换名(正在跑的那份照旧用旧的 inode,不会因为页被改掉而被系统杀);
   * 4. 去「来自网络」标记、跑一次 `--version` 核版本(跑不起来的东西不算装好);
   * 5. 钥匙与两份配置(`localRoom.ts`,secret 不进这一步的任何一行日志);
   * 6. 启动脚本与 launchd 项:没装载过就 bootstrap(`RunAtLoad` 当场起它),装载过就 kickstart -k 换上新的。
   */
  async livekit(ctx) {
    const repo = needRepo(ctx)
    const macos = (await ctx.io.exec(['sw_vers', '-productVersion'])).out.trim()
    if (macos !== '' && majorOf(macos) > 0 && majorOf(macos) < LIVEKIT_MIN_MACOS_MAJOR) {
      ctx.log(`这台 Mac 是 macOS ${macos},随包的 livekit-server 要 ${LIVEKIT_MIN_MACOS_MAJOR} 起`)
      ctx.note(`这台 Mac 是 macOS ${macos},本机通话服务要 macOS ${LIVEKIT_MIN_MACOS_MAJOR} 起才跑得了,这一步跳过 —— 打电话先走云上那条。`)
      return
    }

    let source: string | undefined
    for (const candidate of [`${repo}/livekit/livekit-server`, `${repo}/dist/livekit/livekit-server`]) {
      if ((await ctx.io.stat(candidate))?.isFile === true) { source = candidate; break }
    }
    if (source === undefined) {
      throw new SetupStepError(`安装包里找不到本机通话服务(${repo}/livekit/livekit-server)。这个安装包是坏的或没打全,重新下一份;开发机上先跑一次 bash deploy/fetch-livekit.sh --into dist。`)
    }
    const sourceDir = source.replace(/\/[^/]+$/, '')

    await ctx.io.mkdirp(ctx.paths.livekitDir)
    const incoming = await shaOf(ctx, source)
    const installed = (await ctx.io.stat(ctx.paths.livekitBin)) === undefined ? undefined : await shaOf(ctx, ctx.paths.livekitBin)
    if (incoming !== undefined && incoming === installed) {
      ctx.log(`${ctx.paths.livekitBin} 跟这一份一模一样,不重拷`)
    }
    else {
      ctx.note('把本机通话服务放到 ~/.dsh/livekit')
      const staged = `${ctx.paths.livekitBin}.new`
      await ctx.io.copyFile(source, staged, 0o755)
      const moved = await ctx.io.rename(staged, ctx.paths.livekitBin)
      if (!moved.ok) throw new SetupStepError(`本机通话服务换不上去(${moved.message})`)
      ctx.log(`已放好(755):${ctx.paths.livekitBin}`)
    }
    // Apache-2.0 要求随二进制带上 LICENSE 与 NOTICE。
    for (const name of ['LICENSE', 'NOTICE']) {
      if ((await ctx.io.stat(`${sourceDir}/${name}`))?.isFile === true) await ctx.io.copyFile(`${sourceDir}/${name}`, `${ctx.paths.livekitDir}/${name}`, 0o644)
    }
    const cleared = await ctx.io.exec(['xattr', '-dr', 'com.apple.quarantine', ctx.paths.livekitDir])
    if (!cleared.ok) ctx.log(`去掉「来自网络」的标记没成(退出码 ${cleared.code});一般是本来就没有,不影响。`)

    const version = await ctx.io.exec([ctx.paths.livekitBin, '--version'], { timeoutMs: 30_000 })
    if (!version.ok || !version.out.includes(LIVEKIT_SERVER_VERSION)) {
      throw new SetupStepError(`本机通话服务装上了却跑不对:要 livekit-server ${LIVEKIT_SERVER_VERSION},它回的是「${version.out.trim().split('\n').pop() ?? ''}」(退出码 ${version.code})。`)
    }
    ctx.log(version.out.trim())

    const config = await ensureLocalRoomConfig({ io: ctx.io, paths: ctx.paths, machineId: ctx.machineId })
    ctx.log(config.note)

    if (!await installLivekitStart(ctx, repo)) {
      throw new SetupStepError(`这一份里没有本机通话服务的启动脚本(${repo}/deploy/livekit-start),安装包没打全。`)
    }
    const loaded = await loadLaunchdItem(ctx, livekitLaunchdItem(ctx, repo))
    if (loaded === 'no_template') {
      throw new SetupStepError(`这一份里没有本机通话服务的开机自启(${repo}/deploy/${LIVEKIT_LAUNCHD_LABEL}.plist),安装包没打全。`)
    }
    if (loaded === 'already') {
      // 装载过 = 它可能正跑着旧的那份:让 launchd 杀掉按 plist 再起(起的就是刚换上的二进制与配置)。
      const target = `gui/${ctx.io.uid()}/${LIVEKIT_LAUNCHD_LABEL}`
      ctx.log(`$ launchctl kickstart -k ${target}`)
      const kicked = await ctx.io.exec(['launchctl', 'kickstart', '-k', target], { onLine: line => ctx.log(line), timeoutMs: 30_000 })
      if (!kicked.ok) ctx.log(`${LIVEKIT_LAUNCHD_LABEL} 重起没成(退出码 ${kicked.code}):下次开机会按新的起来`)
    }
    ctx.note(config.state === 'foreign'
      ? `本机通话服务装好了(livekit-server ${LIVEKIT_SERVER_VERSION}),但没起:${config.note}`
      : `本机通话服务装好了(livekit-server ${LIVEKIT_SERVER_VERSION})。系统防火墙开着的话,第一次会问要不要允许「livekit-server」接受传入连接 —— 点「允许」,手机和听筒在家才连得上。`)
  },

  /** 壳 App:build.sh → ditto 到 /Applications。装完如实说一句授权掉没掉(见 shellSignatureNote)。 */
  async shell(ctx) {
    let built: string
    const prebuilt = ctx.prebuilt.shellApp
    if (prebuilt !== undefined && prebuilt !== '') {
      // 安装器那条路:壳已经构建好塞在 .app 里了(那台机器上没有 swiftc)。
      if (await ctx.io.stat(prebuilt) === undefined) {
        throw new SetupStepError(`安装包里找不到构建好的壳(${prebuilt})。这个安装包是坏的,重新下一份。`)
      }
      built = prebuilt
    }
    else {
      const repo = needRepo(ctx)
      const shellDir = `${repo}/workbench-app`
      ctx.note('构建壳(swiftc,要一两分钟)')
      await run(ctx, [`${shellDir}/build.sh`], { cwd: shellDir, timeoutMs: ctx.buildTimeoutMs, why: '壳构建失败' })
      built = `${shellDir}/build/${SHELL_APP_NAME}`
    }
    ctx.note('安装到 /Applications')
    await run(ctx, ['ditto', built, ctx.paths.shellApp], {
      timeoutMs: ctx.buildTimeoutMs, why: '安装壳失败',
    })
    ctx.note(await shellSignatureNote(ctx))
  },

  /** 事务官本机后端发到 ~/.dsh/butler-server(结构照 butler-start 里读的那几样)。 */
  async butler(ctx) {
    const repo = needRepo(ctx)
    const from = `${repo}/butler-server`
    await ctx.io.mkdirp(ctx.paths.butlerServerDir)
    ctx.note('同步 butler-server')
    for (const part of ['server', 'admin-ui/dist', 'node_modules']) {
      if (await ctx.io.stat(`${from}/${part}`) === undefined) {
        ctx.log(`跳过(仓库里没有):${from}/${part}`)
        continue
      }
      await ctx.io.mkdirp(`${ctx.paths.butlerServerDir}/${part}`)
      await run(ctx, ['rsync', '-a', '--delete', `${from}/${part}/`, `${ctx.paths.butlerServerDir}/${part}/`], {
        timeoutMs: ctx.buildTimeoutMs, why: `同步 ${part} 失败`,
      })
    }
    const pkg = await ctx.io.readFile(`${from}/package.json`)
    if (pkg === undefined) throw new SetupStepError(`仓库里找不到 ${from}/package.json —— 仓库路径选错了?`)
    await ctx.io.writeFile(`${ctx.paths.butlerServerDir}/package.json`, pkg)
    /**
     * **换上的新代码要重启才算数**(2026-09-25,卡 S 查语音后端随不随安装走时撞见)。
     *
     * butler-server 起来那一刻就把代码读进了内存:热更新 / 重装把 ~/.dsh/butler-server 换成新的,
     * 正在跑的那一份照旧是老的。更新最后会重启 DSH,可事务官后端是 launchd 里**单独的一项**(ai.deepseek.butler),
     * 不跟着重启 —— 新的识别、合成要等到下次开机才生效,而中间这段时间界面上说的「已更新」是假的。
     * 所以这里当场让 launchd 重起它(`kickstart -k`:杀掉、按 plist 再起,起的就是刚换上的这份)。
     * 新机器上这时 launchd 项还没装(装开机自启是最后一步,那一步会把它起来),重启不了不算失败。
     * 只动 launchd 管的那一项;不在 launchd 里的进程(比如开发时从仓库手动起的那份)一概不碰。
     */
    const target = `gui/${ctx.io.uid()}/${BUTLER_LAUNCHD_LABEL}`
    ctx.log(`$ launchctl kickstart -k ${target}`)
    const restarted = await ctx.io.exec(['launchctl', 'kickstart', '-k', target], { onLine: line => ctx.log(line), timeoutMs: 30_000 })
    if (!restarted.ok) ctx.log(`${BUTLER_LAUNCHD_LABEL} 还不在 launchd 里(退出码 ${restarted.code}):装开机自启那一步会把它起来`)
    ctx.note(restarted.ok ? '发布好了,事务官后端已按新代码重启。' : '发布好了。开机自启那一步会把事务官后端起来。')
  },

  /** 通道层工人。**必须连 node_modules 一起搬**:onnxruntime 是原生模块。 */
  async worker(ctx) {
    const repo = needRepo(ctx)
    const from = `${repo}/channel-worker`
    if (await ctx.io.stat(`${from}/node_modules/@livekit/rtc-node`) === undefined) {
      throw new SetupStepError(`${from} 里还没装依赖。先在那个目录跑一次 pnpm install(原生模块必须在这台机器上装过),再回来点。`)
    }
    await ctx.io.mkdirp(ctx.paths.channelWorkerDir)
    ctx.note('同步 channel-worker(连 node_modules)')
    await run(ctx, ['rsync', '-a', '--delete', `${from}/`, `${ctx.paths.channelWorkerDir}/`], {
      timeoutMs: ctx.buildTimeoutMs, why: '同步工人失败',
    })
    ctx.note('同步好了')
  },

  /**
   * DSH 网页登录态:从日志读**最新**一条带 token 的地址,回给前端跳一次 —— 跳完服务端
   * 就下发签名 cookie(默认 30 天,本仓库把它拉到 3650 天)。
   * 这一步不跑任何命令,也不把 token 落盘:它只活在这一次回包里。
   */
  async web_login(ctx) {
    const log = await ctx.io.readFile(ctx.paths.webStdoutLog)
    if (log === undefined) {
      throw new SetupStepError(`读不到 ${ctx.paths.webStdoutLog}。DSH 还没起来过?先把运行时与 launchd 装好,再点最后一步「重启」。`)
    }
    const url = latestWebToken(log)
    if (url === undefined) {
      throw new SetupStepError('日志里没有带 token 的地址(日志可能被轮转过)。点一次最后那步「重启」,DSH 会重新打印一条。')
    }
    ctx.note('拿到地址了,点一下就会在新标签里开一次,cookie 随即种下')
    // 地址本身带着 token(它就是钥匙),所以只回给这一次请求,不写日志、不落盘。
    ctx.log('已取到带 token 的地址(内容不打进日志)')
    return { url }
  },

  /** 原地重启。**最后一步**:前面几步改的东西大多要重启才生效。 */
  async restart(ctx) {
    const uid = ctx.io.uid()
    ctx.note('重启 DSH(几秒后页面会自己回来)')
    await run(ctx, ['launchctl', 'kickstart', '-k', `gui/${uid}/${DSH_LAUNCHD_LABEL}`], {
      timeoutMs: 60_000, why: '重启失败',
    })
    ctx.note('已发出重启;冷机要 20 秒以上才监听得上,页面会自己重连。')
  },
}
