/**
 * 登录台的对外门面(2026-09-17):http.ts 只认这一个接口,不认底下那四块。
 *
 * 这里额外担一件事:**给 `/state.setup_required` 一个不花钱的答案**。界面每秒轮询一次
 * /state,而一次完整体检要跑 mdfind / osascript / launchctl 十几条命令 —— 挂上去就是
 * 每秒十几个子进程。所以 /state 只读**上一次**体检的结论,并顺手触发一次节流过的
 * 后台重检(同 sentinel / codexReconcile 那条"请求驱动 + 内部限频"的老规矩)。
 */
import type { SetupIo } from './io.ts'
import { createSetupInstaller, type SetupInstallDeps, type SetupInstaller } from './install.ts'
import { createSetupStatus, type SetupStatusDeps, type SetupStatusService } from './status.ts'
import { openSetupPane } from './panes.ts'
import { alertKindOf } from './accessibility.ts'
import type { SetupAlerts, SetupApkView, SetupInstallStep, SetupJobView, SetupPane, SetupStatus } from './types.ts'
import type { SetupPaths } from './paths.ts'

/** /state 顺手重检的最小间隔。体检本身要跑十几条命令,一分钟一次足够。 */
export const SETUP_RECHECK_MS = 60_000

export interface SetupServiceDeps extends SetupStatusDeps, Pick<SetupInstallDeps, 'newId'> {
  /** 手机能扫到的 APK 地址(局域网开着才有)。取不到就二维码不出现 —— 不给一个手机连不上的地址。 */
  apkUrl?: () => string | undefined
  /**
   * 云上那份手机包(更新清单里的 `assets.apk`,见 `server/update/service.ts` 的 `ensureCloudApk`)。
   * **优先用它**:Ben 真机上扫出来的是局域网 IP,换个网就下不动了 ——
   * 「扫码下载是失效的,IP 是局域网」(决策记录 2026-09-18「包一律放阿里云服务器」)。
   * 取不到(没网 / 这一版没带手机包)才退回 `apkUrl()`。
   *
   * **结构化地写在这里,不 import update 那边的类型**:update 依赖 setup 的 io 与 paths,
   * 反过来再 import 一次就成了环。
   */
  cloudApk?: () => Promise<{ version: string, url: string, size: number, sha256: string } | undefined>
  /** APK 在哪。缺省仓库里 `pnpm android:debug` 的产物。 */
  apkPath?: string
  recheckMs?: number
}

export interface SetupService {
  status: () => Promise<SetupStatus>
  /** 上一次体检的结论;没检查过就 undefined(/state 里那一格随之缺席,而不是瞎猜一个 false)。 */
  setupRequired: () => boolean | undefined
  /**
   * 顶上那两条横幅要的两件事(2026-09-17):辅助功能授权缺不缺、DeepSeek 密钥填没填。
   * **读上一次体检的结论,不自己跑体检** —— 同 setupRequired。没检查过就 undefined
   * (「没查过」和「查过了、没问题」是两件事,横幅随之缺席)。
   */
  alerts: () => SetupAlerts | undefined
  /** 节流过的后台重检。composeState 每拍调一次,内部决定要不要真跑。 */
  pump: () => void
  install: (step: SetupInstallStep) => SetupJobView
  job: (id: string) => SetupJobView | undefined
  waitJob: (id: string) => Promise<void>
  openPane: (pane: SetupPane) => Promise<{ ok: boolean, error?: string }>
  apk: () => Promise<SetupApkView>
  /** GET /setup/apk 真要发文件时用:回绝对路径与大小,读不到就 undefined。 */
  apkFile: () => Promise<{ path: string, size: number } | undefined>
}

export function createSetupService(deps: SetupServiceDeps): SetupService {
  const status: SetupStatusService = createSetupStatus(deps)
  const installer: SetupInstaller = createSetupInstaller({
    io: deps.io,
    paths: deps.paths,
    ...(deps.repoRoot === undefined ? {} : { repoRoot: deps.repoRoot }),
    now: deps.now,
    newId: deps.newId,
  })
  const recheckMs = deps.recheckMs ?? SETUP_RECHECK_MS
  let pumping = false

  /** 注入的 > 数据目录里那份(安装器带来的)> 仓库构建产物。普通用户机器上只有中间那份。 */
  async function apkPathOf(paths: SetupPaths): Promise<string | undefined> {
    if (deps.apkPath !== undefined) return deps.apkPath
    const home = await deps.io.stat(paths.homeApk)
    if (home !== undefined && home.isFile) return paths.homeApk
    return paths.repoApk ?? paths.homeApk
  }

  /** 云上那份手机包。取不到**一律当没有**(没网是常态,不是故障)—— 退回局域网地址。 */
  async function cloudApkOf(): Promise<{ version: string, url: string, size: number, sha256: string } | undefined> {
    if (deps.cloudApk === undefined) return undefined
    try { return await deps.cloudApk() }
    catch { return undefined }
  }

  return {
    status: () => status.check(),
    setupRequired: () => {
      const ok = status.lastAllOk()
      return ok === undefined ? undefined : !ok
    },
    alerts: () => {
      const items = status.lastItems()
      if (items === undefined) return undefined
      const stateOf = (key: string): string | undefined => items.find(item => item.key === key)?.state
      const accessibility = stateOf('accessibility')
      const deepseekKey = stateOf('deepseek_key')
      // 体检里压根没有这一项(以后删了 / Windows 上不存在)就算"没缺",不编一条横幅出来。
      const accessibilityMissing = accessibility !== undefined && accessibility !== 'ok'
      /**
       * 哪一种(2026-09-18)。只在真缺的时候带,而且只带 alertKindOf 认的那两种 ——
       * 「壳没连上」那一支(unreachable)**不带**:那会儿谈不上"授权是哪一种没给",
       * 界面据此退回今天这句「还差一个授权」。
       */
      const kind = accessibilityMissing ? alertKindOf(status.lastAccessibility() ?? 'unauthorized') : undefined
      /**
       * 「完全磁盘访问」那一格(2026-10-13)。**只有真探到没给(denied)才说**:
       * 探不着(unknown)与压根没这一项都照"没查过"办,这一格随之缺席 ——
       * 顶上横幅宁可不说,也不拿一个判断不了的结论去催她点授权。
       */
      const fileAccess = status.lastFullDiskAccess()
      return {
        accessibility: accessibilityMissing,
        deepseek_key: deepseekKey !== undefined && deepseekKey !== 'ok',
        ...(kind === undefined ? {} : { accessibility_kind: kind }),
        ...(fileAccess === undefined || fileAccess === 'unknown' ? {} : { file_access: fileAccess === 'denied' }),
      }
    },
    pump: () => {
      if (pumping) return
      const last = status.lastCheckedAt()
      if (last !== undefined && deps.now() - last < recheckMs) return
      pumping = true
      // fire-and-forget:体检慢不慢都不该拖住 /state(同 pumpSentinel 的写法)。
      void status.check().catch(() => {}).finally(() => { pumping = false })
    },
    install: step => installer.start(step),
    job: id => installer.job(id),
    waitJob: id => installer.wait(id),
    // `node_binary` 那一下要知道那条 node 在哪 —— 路径从登录台的路径表来,不从请求里来。
    openPane: pane => openSetupPane(deps.io, pane, deps.paths.nodeBin),
    async apk() {
      /**
       * 云上那份优先(2026-09-18)。这一段**先问云、再看本机**,而不是反过来:
       * 本机出没出过包跟"手机能不能下到包"是两件事 —— 云上有包时,这台电脑上一个
       * apk 文件都没有(普通用户机器上本来就没有)也照样给二维码。
       * 取不到云上那份不是故障,是"没网",于是安静地退回局域网那条老路。
       */
      const cloud = await cloudApkOf()
      const path = await apkPathOf(deps.paths)
      const hint = '手机端的包还没出过。在仓库 butler-app/ 里跑一次 `pnpm android:debug`,产物会落在 android/app/build/outputs/apk/debug/。'
      if (cloud !== undefined) {
        return {
          available: true,
          // 这一格说的是"这台电脑上那份在哪"。云上那份不在本机上,如实说。
          path: path ?? '(在阿里云上,这台电脑上没有)',
          size: cloud.size,
          version: cloud.version,
          url: cloud.url,
          source: 'cloud',
          sha256: cloud.sha256,
        }
      }
      if (path === undefined) {
        return { available: false, path: '(还不知道仓库在哪)', hint: '先在第 2 步选好仓库目录,再回来看手机端的包。' }
      }
      const info = await deps.io.stat(path)
      if (info === undefined || !info.isFile) return { available: false, path, hint }
      const url = deps.apkUrl?.()
      return {
        available: true,
        path,
        size: info.size,
        built_at: new Date(info.mtimeMs).toISOString(),
        ...(url === undefined ? {} : { url, source: 'lan' as const }),
      }
    },
    async apkFile() {
      const path = await apkPathOf(deps.paths)
      if (path === undefined) return undefined
      const info = await deps.io.stat(path)
      if (info === undefined || !info.isFile) return undefined
      return { path, size: info.size }
    },
  }
}

export type { SetupIo }
