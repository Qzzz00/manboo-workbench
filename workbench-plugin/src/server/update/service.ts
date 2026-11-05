/**
 * 热更新的门面(2026-09-18)。http.ts 只认这一个接口。
 *
 * 三件事:
 *
 * 1. **查**(`check`)—— 取清单、比版本、回「当前 / 最新 / 有没有 / 说了什么 / 要下多大」。
 *    取不到清单**不是错误状态**:回一条带 `error` 的视图,`available` 一定是 false。
 *    没网是常态,界面上要显示的是一句人话,不是一个红色的异常框。
 * 2. **装**(`apply`)—— 起一条作业,形状与登录台的安装作业一样,界面用同一套轮询。
 * 3. **每天自己查一次**(`pump`)—— 同 `setup.pump()` 那条"请求驱动 + 内部限频"的老规矩:
 *    `/state` 每拍调一次,它自己决定今天查过没有。查出来有新版就在齿轮上打个点,
 *    **不弹窗**(Ben 09-18 的原话是「加个按钮」,不是「来烦我」)。
 *
 * ## 「有更新」不只看插件版本号(2026-09-26,卡 U6)
 *
 * 09-26 生产切换撞出来的:旧客户端执行新版热更新时步骤表里没有 `runtime`,运行环境没换;
 * 之后再点「检查更新」,这里只比 `isNewerVersion(manifest.version, current)` → 永远 false
 * → **运行环境再也装不上**。所以从这一版起,判「有没有要装的东西」是两条或的关系:
 *
 *   ① 服务器上那份插件比本机新(老规矩);**或者**
 *   ② 插件不比本机新,但**运行环境跟这一版锁定的那一版对不上**(`deps.runtimeDrift`)。
 *
 * 第 ② 档叫 `runtime_only`:不下那几十兆产物,只跑 `profile` + `runtime` 两步再重启。
 * 判据不在这个文件里自己写一遍 —— 它在 `setup/dshRuntimeLock.ts` 的 `readRuntimeDrift`,
 * 体检那一项读的是同一个函数(两处各判一次正是那件事故的成因)。
 *
 * ## 第 ③ 档:版本号一样,可还有组件没装到这台电脑上(2026-10-03)
 *
 * 0.4.89 发完那十分钟(维护者机器):发版闸只装了**插件**,装完 `current == latest == 0.4.89`
 * → `available: false` → 设置里「没有更新」。可同一份回包的 `plan.items` 里五样都 `changed`:
 * 事务官后端(没有语气代码)、电话工人(没有中文打断)**都还是旧的**;维护者亲手按一次
 * `/update/apply`,回的是「已经是最新的了」,一件都没装 —— 那两个进程从此再也装不上。
 *
 * 所以「有没有要装的东西」是三条或的关系,而且**先算 plan 再算它**:
 *
 *   ① 服务器上那份插件比本机新(老规矩);**或者**
 *   ② 插件不比本机新,但运行环境跟这一版锁定的那一版对不上(`runtime_only`);**或者**
 *   ③ 版本号**相等**,而清单里有产物**有凭据**说明这台电脑上那一份跟它对不上(`components_behind`)。
 *
 * 第 ③ 档的两条边界:**只数有凭据的那几件**(`behindItems`:刚用安装包装好的机器一条记录
 * 都没有,不许被说成"少了 5 样"),**版本号必须相等**(服务器上比本机旧时沉默 —— 那颗按钮
 * 会把插件降级回公网那一版)。
 */
import type { RuntimeDriftState } from '../setup/dshRuntimeLock.ts'
import type { SetupIo } from '../setup/io.ts'
import type { SetupPaths } from '../setup/paths.ts'
import { RUNTIME_ONLY_STEPS, runUpdate, type UpdateApplyRun } from './apply.ts'
import { absentKindsOf, behindItems, localShaOf, planAssets, readInstalled, type UpdatePlanScope } from './installed.ts'
import { manifestUrlOf, type UpdateChannelStore } from './channel.ts'
import { compareVersions, isNewerVersion, parseManifest, UpdateManifestError } from './manifest.ts'
import type { UpdateApkStateView, UpdateChannel, UpdateCheckView, UpdateCloudApk, UpdateInstallerView, UpdateJobView, UpdateManifest, UpdatePlanItem, UpdatePlanView, UpdateRuntimeStaleView, UpdateStateView } from './types.ts'
import { DEFAULT_UPDATE_CHANNEL, humanSize, isUpdateChannel, UPDATE_CHANNEL_TITLES } from './types.ts'
import { BUILD_UPDATE_MANIFEST_URL } from '../../buildEndpoints.ts'

/**
 * 服务器上那份清单的地址 = 构建带的那一个(src/buildEndpoints.ts):我们的构建是中转的只读静态路由
 * (relay/server/app.cjs),**开源构建是空** = 不查更新(endpoints.ts 把空当成关)。
 */
export const DEFAULT_MANIFEST_URL = BUILD_UPDATE_MANIFEST_URL

/** 后台自己查的间隔:一天一次。**不是**为了尽快知道,是为了"打开设置时那个点已经在了"。 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000

/** 取清单给多久。它只有几百字节,慢过这个数基本就是没网。 */
const MANIFEST_TIMEOUT_MS = 15_000

export interface UpdateServiceDeps {
  io: SetupIo
  paths: SetupPaths
  now: () => number
  newId: () => string
  /** 这会儿跑着的插件版本(src/version.ts 注入的)。比版本以它为准。 */
  currentVersion: string
  /** **稳定版**那份清单的地址。缺省 api.aibooo.cn;用例里指向本地假服务器。热修那份在同一个目录下(`channel.ts`)。 */
  manifestUrl?: string
  /**
   * 这台机器收哪条更新通道(2026-10-21)。每查一次现读一次 —— 设置里一切过去,下一次查就按新的。
   * 不接(既有那批用例)= 永远是稳定版、切不了,行为与这一版之前逐字一样。
   */
  channel?: UpdateChannelStore
  /** 后台自查间隔。测试传小数字。 */
  checkIntervalMs?: number
  /** 透传给 runUpdate(测试把几个等待时间压成 0)。 */
  applyTuning?: { subPollMs?: number, restartDelayMs?: number, restartWatchdogMs?: number, downloadTimeoutMs?: number, buildTimeoutMs?: number, downloadPollMs?: number }
  /**
   * 重启那一下过了保险期还没把这个进程换掉时调谁(2026-10-13,「装完没自己起来」那张卡)。
   *
   * 原样透传给 `runUpdate`。**只有生产那一份实例许接**(接的是 `() => process.exit(1)`,
   * 让 plist 的 `KeepAlive.SuccessfulExit=false` 拉起来);灰度跑在 scratch HOME 上、
   * 不由 launchd 管,退出去没人拉 —— 判据与 `autoRepair` 同一条。
   */
  hardRestart?: () => void
  /**
   * 一条更新作业失败了(2026-09-22)。原样透传给 `runUpdate`,由 http.ts 接到自动上报上。
   * 不接就整条缺席(既有那一批用例一行都不用改)。
   */
  onFailed?: (view: { id: string, version?: string, error: string, tail: readonly string[] }) => void
  /**
   * 「这台机器上的运行环境跟这一版锁定的那一版对不上没有」(2026-09-26,卡 U6)。
   *
   * **只读,不判**:真正的判据是 `setup/dshRuntimeLock.ts` 的 `readRuntimeDrift`,
   * 生产上由 `setup/runtimeRepair.ts` 那个服务节流地探、把结论缓存着 —— 这里只是问它一声。
   * 不接(既有那一批用例)= 这一档不存在,行为与 09-26 之前逐字一样。
   */
  runtimeDrift?: () => Promise<RuntimeDriftState | undefined>
  /**
   * `/state.update.runtime_stale` 那一格。同上,只读。
   * **它与「查过清单没有」无关**:没网、从没查过清单的机器也要看得见这一格
   * (它读的是本机的运行时目录)—— 所以 `lastCheck()` 在没查过时也会为它造一条最小视图。
   */
  runtimeStale?: () => UpdateRuntimeStaleView | undefined
}

export interface UpdateService {
  /** 真去取一次清单。界面上那颗「检查更新」按的就是它。 */
  check: () => Promise<UpdateCheckView>
  /** 上一次检查的结论。`/state` 读它,**不现查**。没查过就 undefined(不编一个 false)。 */
  lastCheck: () => UpdateStateView | undefined
  /** 手机包那一格。清单里有 apk 且比本机新才有。 */
  apk: () => UpdateApkStateView | undefined
  /**
   * 云上那份手机包(2026-09-18「包一律放阿里云」)。**读缓存,一定不联网** ——
   * `/state` 每拍都会问它。跟 `apk()` 的区别:那一格要比版本(「有没有**新**的」),
   * 这一格不比(「那个包**在哪**」)。二维码与手机端「重新下载手机包」要的是后者。
   */
  cloudApk: () => UpdateCloudApk | undefined
  /**
   * 这一版的**电脑安装包**在哪(2026-09-26,卡 SM)。同 `cloudApk` 一条口径:
   * **读缓存、一定不联网、不比版本** —— 问的是「那个包在哪」,给别的机器装用。
   * 没查过清单、或者清单里没这一格就 undefined(不编一个地址)。
   */
  installer: () => UpdateInstallerView | undefined
  /**
   * 同上,但**没缓存过清单就现取一次**(`/setup/apk.json` 走这条:首次流程那一屏
   * 多半出现在刚装完、后台还没查过的那一刻)。取不到就 undefined —— 调用方据此退回
   * 局域网地址,而不是把一个连不上的公网地址硬塞给二维码。
   */
  ensureCloudApk: () => Promise<UpdateCloudApk | undefined>
  /** 节流过的后台自查。composeState 每拍调一次,内部决定今天查过没有。 */
  pump: () => void
  /** 起一条更新作业。已经在跑就把那条回给你(不会起第二次下载)。 */
  apply: () => UpdateJobView | { error: string }
  job: (id: string) => UpdateJobView | undefined
  /** 等作业跑完。生产用不到,测试与收尾用。 */
  waitJob: (id: string) => Promise<void>
  /** 这台机器现在收哪条通道。读不出来按稳定版说。 */
  channel: () => Promise<UpdateChannel>
  /** 切通道:落盘之后当场按新通道再查一次,回那一趟的结论。更新正跑着时不许切。 */
  setChannel: (channel: UpdateChannel) => Promise<UpdateCheckView | { error: string }>
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const manifestUrl = deps.manifestUrl ?? DEFAULT_MANIFEST_URL
  const intervalMs = deps.checkIntervalMs ?? UPDATE_CHECK_INTERVAL_MS
  let last: UpdateCheckView | undefined
  let lastManifest: UpdateManifest | undefined
  /** 上一次在清单里看到的那份手机包(清单又漏了这一格时顶上,见 cloudApkOf)。 */
  let lastApk: UpdateCloudApk | undefined
  /** 上一次在清单里看到的那份电脑安装包(同上,卡 U8 的双保险,见 installerOf)。 */
  let lastInstaller: UpdateInstallerView | undefined
  let checking = false
  /** 现取清单时同时进来几个只发一趟(`/setup/apk.json` 首次流程与设置页可能前后脚各问一次)。 */
  let inflight: Promise<UpdateCheckView> | undefined
  const runs = new Map<string, UpdateApplyRun>()
  let current: UpdateApplyRun | undefined

  async function channelNow(): Promise<UpdateChannel> {
    if (deps.channel === undefined) return DEFAULT_UPDATE_CHANNEL
    try { return await deps.channel.read() }
    catch { return DEFAULT_UPDATE_CHANNEL }
  }

  /**
   * 按通道取清单。收热修而服务器上还没有 `beta.json`(404)时照稳定版那份查 ——
   * 发稳定版时两份一起写,稳定版从不落后于热修,所以这时候它就是热修通道上最新的那一版。
   * **反过来不成立**:稳定版那份 404 绝不去读热修,体验的人不能因为服务器缺一个文件就收到热修。
   */
  async function fetchChannelManifest(channel: UpdateChannel): Promise<{ manifest: UpdateManifest, fallback: boolean }> {
    if (channel === 'stable') return { manifest: await fetchManifest(manifestUrl), fallback: false }
    const hotfixUrl = manifestUrlOf(manifestUrl, channel)
    try {
      return { manifest: await fetchManifest(hotfixUrl), fallback: false }
    }
    catch (error) {
      if (!(error instanceof ManifestNotFound)) throw error
      return { manifest: await fetchManifest(manifestUrl), fallback: true }
    }
  }

  async function fetchManifest(url: string): Promise<UpdateManifest> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, MANIFEST_TIMEOUT_MS)
    timer.unref?.()
    let res: Response
    try {
      res = await deps.io.fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    }
    catch (error) {
      throw new UpdateManifestError(`连不上更新服务器(${hostOf(url)})。多半是这会儿没网,过一会儿再点一次。${error instanceof Error && error.name === 'AbortError' ? '(等了 15 秒没应答)' : ''}`)
    }
    finally { clearTimeout(timer) }
    if (!res.ok) {
      const says = `更新服务器回了 HTTP ${res.status} —— 这一版还没发布,或者服务器那边出了问题。不是你这台电脑的毛病。`
      throw res.status === 404 ? new ManifestNotFound(says) : new UpdateManifestError(says)
    }
    return parseManifest(await res.text(), url)
  }

  /**
   * 缓存着的清单里那件 apk。没清单、也没见过手机包时是 undefined(不编一个)。
   *
   * **清单里这一格缺了,就保留上一次看到的那一份**(2026-09-26,卡 U8 的双保险)。
   * 0.4.1 那次清单漏了 apk,设置里「手机包」那一格当场变空 —— Pixel 于是下不了。
   * 正路是发版时把没重打的那几样照上一版带上(deploy/publish-update.sh),这里是第二道:
   * 就算清单又漏了一次,这台机器上「那个包在哪」仍然答得出来(旧版本的目录从不删,那个地址一直下得到)。
   *
   * 只记在内存里,**不落盘**:重启之后由清单(已经带上了)说,而不是由一个可能陈到几个月前的
   * 本机记录说 —— 记一个越来越旧的地址落盘,等于把「不编一个」换成「编一个旧的」。
   */
  function cloudApkOf(): UpdateCloudApk | undefined {
    const manifest = lastManifest
    const asset = manifest?.assets.apk
    if (manifest === undefined || asset === undefined) return lastApk === undefined ? undefined : { ...lastApk }
    return { version: apkVersionOf(manifest), url: asset.url, size: asset.size, sha256: asset.sha256 }
  }

  /**
   * 那份手机包**是哪一版打的**。清单里带了 `from_version`(这一版没重打、照上一版原样带上的)
   * 就照它说;没带就是这一版自己打的(卡 U8)。
   */
  function apkVersionOf(manifest: UpdateManifest): string {
    return manifest.assets.apk?.from_version ?? manifest.version
  }

  /**
   * 清单里那份**电脑安装包**(2026-09-26,卡 SM)。写法与 `cloudApkOf` 逐字同形,
   * 连「清单又漏了这一格就保留上一次看到的那一份」那道双保险都一样(卡 U8):
   * 旧版本的目录从不删,那个地址一直下得到,而变空会让他以为"没有安装包可下"。
   *
   * `version` 说的是那份 dmg **真出自哪一版**(`from_version` 带了就照它说)——
   * 抄过来的安装包一个字节没变,在界面上说成这一版就是在说假话。
   */
  function installerOf(): UpdateInstallerView | undefined {
    const manifest = lastManifest
    const asset = manifest?.assets.installer_dmg
    if (manifest === undefined || asset === undefined) return lastInstaller === undefined ? undefined : { ...lastInstaller }
    return { version: asset.from_version ?? manifest.version, url: asset.url, size: asset.size, sha256: asset.sha256 }
  }

  /** 这一版的手机包是不是「照上一版原样带上的」(没重打)。 */
  function apkCarried(manifest: UpdateManifest): boolean {
    const from = manifest.assets.apk?.from_version
    return from !== undefined && from !== manifest.version
  }

  /**
   * 运行环境漂没漂。**探不出来一律当"没漂"**(没接这一路、读盘报错):
   * 「没查出来」不能变成一颗会去改这台机器的按钮(D13 的反面同样成立)。
   */
  async function driftNow(): Promise<RuntimeDriftState | undefined> {
    if (deps.runtimeDrift === undefined) return undefined
    try { return await deps.runtimeDrift() }
    catch { return undefined }
  }

  /**
   * 只补运行环境那一趟成立吗。两个条件都要:
   * ① 运行环境真对不上;② **清单里带了 `runtime_tgz`**。
   *
   * 第 ② 条不是摆设:老清单(加这件产物之前发的那几版)没有它,那一趟跑起来
   * `runtime` 那一步会被「这一版没带这件产物」滤掉 → 一步也不跑、什么都没换,
   * 而「检查更新」还一直说有更新 —— 一颗按了不算数的按钮比没有按钮更糟。
   * 那种情况下这一格保持沉默,体检里那一项仍然认得出来、仍然能一键装。
   */
  function runtimeOnlyOf(manifest: UpdateManifest, drift: RuntimeDriftState | undefined): boolean {
    if (drift?.drifted !== true) return false
    if (isNewerVersion(manifest.version, deps.currentVersion)) return false
    return manifest.assets.runtime_tgz !== undefined
  }

  async function check(): Promise<UpdateCheckView> {
    const checkedAt = new Date(deps.now()).toISOString()
    const channel = await channelNow()
    try {
      const { manifest, fallback } = await fetchChannelManifest(channel)
      lastManifest = manifest
      // 见过的那份手机包记下来(清单下一次漏了这一格时顶上,卡 U8)。
      if (manifest.assets.apk !== undefined) lastApk = cloudApkOf()
      // 见过的那份电脑安装包也记下来(同上,卡 SM)。
      if (manifest.assets.installer_dmg !== undefined) lastInstaller = installerOf()
      const drift = await driftNow()
      const pluginNewer = isNewerVersion(manifest.version, deps.currentVersion)
      const runtimeOnly = runtimeOnlyOf(manifest, drift)
      /**
       * 清单那一版与跑着的这一版**是同一版**(第 ③ 档的前提,2026-10-03)。
       * 严格相等,不是"不比我新":服务器上比本机旧的时候(维护者机器上常跑着还没发出去的
       * 那一版)这一档一律沉默 —— 那颗按钮按下去会把插件降级回公网那一版。
       */
      const sameVersion = compareVersions(manifest.version, deps.currentVersion) === 0
      // 「这次真要下多少」= 只算跟本机那份对不上的那几件(2026-09-18,Ben:「好慢」)。
      // 算它要读一次 installed.json 并对插件 tgz 现算一次 sha —— 都是本机上的几毫秒,
      // 而且**只在真去查了一次清单之后**做,`/state` 那条路一秒一拍,不会走到这儿。
      //
      // 只补运行环境那一趟的账里**只有运行环境那一件**,而且一律当"变了"
      // (理由见 planAssets 的 scope;两处必须与 apply() 传下去的那一份逐字相同)。
      //
      // **先算账,再判有没有更新**(2026-10-03):第 ③ 档问的就是这份账里有几件对不上。
      const plan = planAssets(
        manifest,
        await readInstalled(deps.io, deps.paths),
        await localShaOf(deps.io, deps.paths),
        scopeOf(runtimeOnly, sameVersion),
        // 本机确实没有的那几样(今天只有本机通话服务):第 ③ 档要数得着它。apply 那一趟现算同一份。
        await absentKindsOf(deps.io, deps.paths, manifest),
      )
      /** 版本号一样,但有凭据说明这台电脑上还差这几样(第 ③ 档;空数组 = 不差)。 */
      const behind = sameVersion && !runtimeOnly ? behindItems(plan) : []
      const available = pluginNewer || runtimeOnly || behind.length > 0
      const needsInstaller = manifest.min_installer_version !== undefined
        && isNewerVersion(manifest.min_installer_version, deps.currentVersion)
        ? `这台电脑上的工作台(${deps.currentVersion})太旧了,没法直接升到 ${manifest.version}(这一版要求至少 ${manifest.min_installer_version})。要重新下一次安装包装一遍 —— 你的数据不会动。`
        : undefined
      const apk = manifest.assets.apk
      const view: UpdateCheckView = {
        current: deps.currentVersion,
        latest: manifest.version,
        available: available && needsInstaller === undefined,
        // 只补运行环境那一趟**不显示发版说明**:那一段说的是这一版改了什么,而这一版他早装上了。
        // 这里要说的是"为什么还要再装一次",所以换成我们自己写的那句人话。
        // 第 ③ 档(版本号一样、还有组件没装上)同一条道理,换成它自己那句人话。
        ...(runtimeOnly
          ? { notes: runtimeOnlyNotes(drift) }
          : behind.length > 0
            ? { notes: componentsBehindNotes(manifest.version, behind, plan) }
            : (manifest.notes === undefined ? {} : { notes: manifest.notes })),
        size: plan.bytes,
        plan,
        // 手机包那一格只在**插件真有新版**时给:只补运行环境那一趟里手机包一个字节没变,
        // 报一句"有新的手机包"等于骗他去重下一份一样的。
        //
        // 同一条道理,**照上一版原样带上的那一份也不报**(2026-09-26,卡 U8):它带着
        // `from_version`,说明这一版根本没重打手机包 —— 那一格于是只在真换了包的那一版出现。
        // 他要重下一份(装坏了、换手机了)走的是「电脑上那份清单里的手机包」那一格(cloudApk),
        // 它与版本无关、一直在。
        ...(apk === undefined || !pluginNewer || apkCarried(manifest) ? {} : { apk: { version: manifest.version, url: apk.url, size: apk.size } }),
        checked_at: checkedAt,
        ...(needsInstaller === undefined ? {} : { needs_installer: needsInstaller }),
        ...(runtimeOnly ? { runtime_only: true } : {}),
        ...(behind.length > 0 ? { components_behind: true } : {}),
        channel,
        ...(fallback ? { channel_fallback: true } : {}),
      }
      last = view
      return view
    }
    catch (error) {
      // 取不到清单不是"没有新版",也不是一个异常 —— 是一句人话。available 一律 false。
      const view: UpdateCheckView = {
        current: deps.currentVersion,
        available: false,
        checked_at: checkedAt,
        error: error instanceof UpdateManifestError || error instanceof Error ? error.message : String(error),
        channel,
      }
      last = view
      return view
    }
  }

  return {
    check,
    lastCheck: () => {
      const stale = deps.runtimeStale?.()
      if (last === undefined) {
        /**
         * 还没查过清单(刚开机、或者根本没网)。原来这一格就整个缺席 ——
         * 可运行环境漂没漂**跟联网没有一点关系**(读的是本机的运行时目录),
         * 09-26 那台机器要看见的正是这一句。所以这时候为它造一条最小视图:
         * 「有没有新版」如实说不知道(`available: false`),那一格照样给出来。
         */
        return stale === undefined ? undefined : {
          current: deps.currentVersion,
          available: false,
          checked_at: new Date(deps.now()).toISOString(),
          runtime_stale: stale,
        }
      }
      // 安装包那一格**与 available 无关**(卡 SM):它答的是「那个包在哪」,
      // 这台机器已经是最新的时候照样要答得出来 —— 那正是他给另一台装的时候。
      const installer = installerOf()
      return {
        current: last.current,
        ...(last.latest === undefined ? {} : { latest: last.latest }),
        available: last.available,
        ...(last.notes === undefined ? {} : { notes: last.notes }),
        checked_at: last.checked_at,
        ...(stale === undefined ? {} : { runtime_stale: stale }),
        ...(installer === undefined ? {} : { installer }),
        ...(last.channel === undefined ? {} : { channel: last.channel }),
      }
    },
    apk: () => (last?.apk === undefined ? undefined : { ...last.apk }),
    cloudApk: cloudApkOf,
    installer: installerOf,
    ensureCloudApk: async () => {
      const cached = cloudApkOf()
      if (cached !== undefined) return cached
      inflight ??= check().finally(() => { inflight = undefined })
      await inflight
      return cloudApkOf()
    },
    pump: () => {
      if (checking) return
      if (last !== undefined && deps.now() - Date.parse(last.checked_at) < intervalMs) return
      checking = true
      // fire-and-forget:查得慢不该拖住 /state(同 setup.pump 的写法)。
      void check().catch(() => {}).finally(() => { checking = false })
    },
    apply: () => {
      if (current !== undefined && current.view.state === 'running') return current.view
      const manifest = lastManifest
      if (manifest === undefined) {
        return { error: '还没查过有没有新版。先点一次「检查更新」。' }
      }
      /**
       * 只补运行环境那一档(2026-09-26,卡 U6)。读的是**上一次检查的结论**
       * (`runtime_only`)—— 跟 `lastManifest` 同一份真相,而界面按下这颗按钮之前
       * 刚查过一次。这里不再自己探一遍运行时目录:那会让两处的判断有机会不一致,
       * 而这张卡要治的病正是"两处各判一次"。
       */
      const runtimeOnly = last?.runtime_only === true
      /**
       * 第 ③ 档:版本号一样,可还有组件没装到这台电脑上(2026-10-03)。
       * 同上,读的是**上一次检查的结论** —— 这一趟不自己再判一遍,免得两处有机会不一致。
       * 要装哪几样由 `applyAll` 按这一刻的机器现算一遍账(那份账与这里的 scope 逐字同一份)。
       */
      const behind = last?.components_behind === true
      if (!isNewerVersion(manifest.version, deps.currentVersion) && !runtimeOnly && !behind) {
        return { error: `已经是最新的了(${deps.currentVersion})。` }
      }
      if (manifest.min_installer_version !== undefined && isNewerVersion(manifest.min_installer_version, deps.currentVersion)) {
        return { error: `这台电脑上的工作台(${deps.currentVersion})太旧了,没法直接升到 ${manifest.version}。要重新下一次安装包装一遍。` }
      }
      const run = runUpdate({
        io: deps.io,
        paths: deps.paths,
        now: deps.now,
        newId: deps.newId,
        currentVersion: deps.currentVersion,
        ...(deps.onFailed === undefined ? {} : { onFailed: deps.onFailed }),
        ...(deps.hardRestart === undefined ? {} : { hardRestart: deps.hardRestart }),
        ...(deps.applyTuning ?? {}),
      }, manifest, runtimeOnly
        ? {
            steps: RUNTIME_ONLY_STEPS,
            assets: ['runtime_tgz'],
            force: ['runtime_tgz'],
            says: `只补运行环境:插件已经是 ${deps.currentVersion},运行环境还没换过来`,
          }
        : behind
          ? {
              // 步骤与产物都不限:按账走,`changed` 的那几样装,别的整步跳过(复用老那条路)。
              // `localFirst` 必须与 check() 那一趟逐字相同,否则这里会把闸刚装好的插件再装一遍。
              localFirst: true,
              says: `这一版(${manifest.version})已经装上了,这一趟只补还没装到这台电脑上的那几样`,
            }
          : {})
      runs.set(run.view.id, run)
      current = run
      // 只留最近几条:这里不做归档,只为"刚才那次失败的输出还在不在"。
      while (runs.size > 5) {
        const oldest = runs.keys().next().value
        if (oldest === undefined) break
        runs.delete(oldest)
      }
      return run.view
    },
    job: id => runs.get(id)?.view,
    waitJob: async (id) => { await runs.get(id)?.done },
    channel: channelNow,
    setChannel: async (next) => {
      if (!isUpdateChannel(next)) return { error: `不认识这条更新通道:${String(next)}。只有「${UPDATE_CHANNEL_TITLES.stable}」与「${UPDATE_CHANNEL_TITLES.hotfix}」两条。` }
      if (deps.channel === undefined) return { error: '这台电脑上的工作台还不能切更新通道。' }
      if (current !== undefined && current.view.state === 'running') {
        return { error: '正在更新,装完再切通道 —— 装到一半换一份清单,装出来的是哪一版就说不清了。' }
      }
      await deps.channel.write(next)
      // 上一条通道查到的结论不再作数:下面这一趟按新通道查(缓存的手机包 / 安装包地址照旧留着,见 cloudApkOf)。
      last = undefined
      lastManifest = undefined
      return await check()
    },
  }
}

/** 清单那个地址 404:这份清单在服务器上不存在(热修那一份还没发过时会撞上)。 */
class ManifestNotFound extends UpdateManifestError {}

/**
 * 这一趟算账的范围(2026-10-03)。**check() 与 apply() 必须拿到同一份** ——
 * 两处各算一套正是 U6 那张卡要治的病,这里把它收成一个函数。
 *
 * - 只补运行环境那一趟:账里只有运行环境那一件,而且一律当"变了"(理由见 `planAssets` 的 scope);
 * - 版本号相等那一趟:本机那份现算出来的 sha 胜过那条陈了的记录(发版闸不改 `installed.json`);
 * - 别的(插件真有新版):一个字不改,老规矩。
 */
function scopeOf(runtimeOnly: boolean, sameVersion: boolean): UpdatePlanScope {
  if (runtimeOnly) return { only: ['runtime_tgz'], force: ['runtime_tgz'] }
  return sameVersion ? { localFirst: true } : {}
}

/**
 * 第 ③ 档(版本号一样、还有组件没装到这台电脑上)那句人话(2026-10-03)。
 *
 * 要说清四件事,一句都不能省:**本体已经是最新的了**(不然他以为更新白点了)、
 * **还差哪几样**(名字用 `UPDATE_ASSET_TITLES`,不出现 butler / worker 这种内部词)、
 * **这一趟要下多大**、**装完会重启**。
 */
export function componentsBehindNotes(version: string, behind: readonly UpdatePlanItem[], plan: UpdatePlanView): string {
  const names = behind.map(item => item.title).join('、')
  /**
   * 这一趟真要下的件数可能比"还差这几样"多:账上还有几样**这台电脑上没记过是哪一份**
   * (`source: 'none'`),它们照下(D13)但不算"没装"。两个数不一样时得说一句,
   * 不然他会问"为什么补一个启动脚本要下 300 多兆"。
   */
  const extra = plan.changed - behind.length
  const 要下 = extra > 0
    ? `${humanSize(plan.bytes)}(连另外 ${extra} 样这台电脑上没记过是哪一份的一起核一遍;网慢会久一点)`
    : `${humanSize(plan.bytes)}(网慢会久一点)`
  return `工作台本体已经是最新的了(${version}),但这一版带的东西里有 ${behind.length} 样还没装到这台电脑上:${names}。`
    + `点一下把它们装上:这一趟要下 ${要下},装完工作台会自己重启一次,你的项目、事项、记忆都不会动。`
}

/**
 * 只补运行环境那一趟,「这一版说了什么」那一段换成的人话(2026-09-26,卡 U6)。
 *
 * 要说清三件事,一句都不能省:**为什么明明是最新版还要装**、**要多久**、**会不会重启**。
 * 不出现 npm / 依赖树 / profile / 锁定清单 这些词(占位盘查盯着的内部词)。
 */
export function runtimeOnlyNotes(drift: { installed?: string, locked: string } | undefined): string {
  const installed = drift?.installed
  const wanted = drift === undefined || drift.locked === '' ? '这一版要的那一版' : drift.locked
  const gap = installed === undefined
    ? `这台电脑上的 DSH 运行环境还没装上这一版要的那一份(${wanted})。`
    : `工作台本体已经是最新的了,但它底下那套 DSH 运行环境还是旧的(装着 ${installed},这一版要 ${wanted})。`
  return `${gap}点一下把运行环境装上:几十秒(网慢会久一点),装完工作台会自己重启一次,你的项目、事项、记忆都不会动。`
}

/** 只取域名,给人看"这会儿在跟谁说话"。不打完整 URL —— 那一长串对 Ben 没有信息量。 */
function hostOf(url: string): string {
  try { return new URL(url).host }
  catch { return url }
}
