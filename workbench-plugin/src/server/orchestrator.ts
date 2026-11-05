/**
 * 窗口贴合编排(spec §2/§3 关键行为约定)。壳只是执行器,这里持有全部决策:
 * 激活重试、坐标换算、原位记忆、回读校验。每步失败都如实进 SnapView.reason(D13)。
 */
import type { HelperRect, SnapView } from '../protocol.ts'
import type { AppsRegistry } from './appsRegistry.ts'
import type { HelperChannel } from './helperChannel.ts'
import { APP_BUNDLES, ensureRunningWith } from './activation.ts'
import { APP_COMMANDS } from './apps.ts'

/** 页面 CSS 视口坐标 → AX 全局屏幕坐标。壳报 webview 的 AX 矩形与 scale(CSS px→pt,常为 1)。 */
export function pageRectToScreen(page: HelperRect, webview: HelperRect, scale: number): HelperRect {
  return {
    x: Math.round(webview.x + page.x * scale),
    y: Math.round(webview.y + page.y * scale),
    w: Math.round(page.w * scale),
    h: Math.round(page.h * scale),
  }
}

/**
 * 位置容差(真机实测调宽):16px 肉眼不可辨,而真正要拦的位置错位是数百像素级
 * (屏外钳制那类),16 完全拦得住,不会放过真正的贴合失败。
 */
const FRAME_TOLERANCE_PX = 16
/**
 * 尺寸容差(真机二轮实测逼出来的政策):只设下限、不设上限。应用最小尺寸(企微实测
 * 960×640)与终端字符网格向下取整(实测 -19px)都是物理事实,不是编排指令没生效——
 * 窗口比槽位大只是把槽位盖满,比槽位小一点也多半盖住了大半,都该算达标;真正要拦的
 * 是位置钳制那类数百像素级错位,不该让尺寸维度背这个锅。
 */
const SIZE_MIN_SLACK_PX = 32
/** 等窗口出现的上限:10 次 × 500ms。是单次动作内的有限重试,不是后台轮询。 */
const WINDOW_WAIT_TRIES = 10
const WINDOW_WAIT_MS = 500

export interface OrchestratorDeps {
  helper: Pick<HelperChannel, 'request'>
  runCommand: (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>
  sleep: (ms: number) => Promise<void>
  /** 应用清单(spec S4)。不传就只认基础八应用(APP_COMMANDS/APP_BUNDLES);传了就贴合也认自定义应用。 */
  registry?: Pick<AppsRegistry, 'commandFor' | 'bundleFor'>
}

export interface Orchestrator {
  snap(app: string, pageRect: HelperRect): Promise<{ ok: boolean, reason?: string }>
  unsnap(): Promise<{ ok: boolean, reason?: string }>
  snapView(): SnapView | undefined
}

interface WindowInfo { index: number, frame: HelperRect }
interface AppInfo { running: boolean, hidden: boolean, windows: WindowInfo[] }

/** 位置严、尺寸宽:位置(x/y)必须在 ±16px 内;尺寸(w/h)只要不比目标小超过 32px 就算到位,没有上限。 */
function closeEnough(actual: HelperRect, target: HelperRect): boolean {
  return Math.abs(actual.x - target.x) <= FRAME_TOLERANCE_PX
    && Math.abs(actual.y - target.y) <= FRAME_TOLERANCE_PX
    && actual.w >= target.w - SIZE_MIN_SLACK_PX
    && actual.h >= target.h - SIZE_MIN_SLACK_PX
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  let current: { app: string, bundleId: string, index: number, originalFrame: HelperRect } | undefined
  let last: SnapView | undefined

  async function appInfo(bundleId: string): Promise<AppInfo> {
    const raw = await deps.helper.request({ op: 'app_info', bundle_id: bundleId })
    return raw as unknown as AppInfo
  }

  /**
   * 等第一扇窗出现,有限重试。
   * 微信2 实测:常驻后台却没有主窗(窗口数=0)——纯等不会等出窗口,得补一次
   * open 唤窗。只在第一次探测就是"在跑但零窗口"时补发一次(不是每轮都发):
   * open(按包标识,见 `apps.ts`)对已在运行的应用等效于"把主窗叫出来",不是重新拉起进程,一次顶多补一次。
   */
  async function waitForWindow(bundleId: string, cmd: readonly string[]): Promise<WindowInfo | undefined> {
    for (let i = 0; i < WINDOW_WAIT_TRIES; i++) {
      const info = await appInfo(bundleId)
      const first = info.windows[0]
      if (first !== undefined) return first
      if (i === 0 && info.running) await deps.runCommand(cmd)
      await deps.sleep(WINDOW_WAIT_MS)
    }
    return undefined
  }

  async function setFrameVerified(bundleId: string, index: number, target: HelperRect): Promise<{ ok: boolean, actual?: HelperRect }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await deps.helper.request({ op: 'set_window_frame', bundle_id: bundleId, index, frame: target })
      const actual = (raw as { frame?: HelperRect }).frame
      // 成功也要把 actual 带出去(F2):调用方要拿它跟 target 比对,如实报尺寸偏差,不是只关心 ok。
      if (actual !== undefined && closeEnough(actual, target)) return { ok: true, actual }
      if (attempt === 1) return { ok: false, ...(actual === undefined ? {} : { actual }) }
    }
    return { ok: false }
  }

  /** 尺寸容差之外的诚实偏差(F2):>2px 才值得标注,避免把取整噪声也报成"受限"。 */
  const SIZE_DIFF_NOTE_PX = 2

  function sizeDiffReason(actual: HelperRect | undefined, target: HelperRect): string | undefined {
    if (actual === undefined) return undefined
    const diffW = Math.abs(actual.w - target.w)
    const diffH = Math.abs(actual.h - target.h)
    if (diffW <= SIZE_DIFF_NOTE_PX && diffH <= SIZE_DIFF_NOTE_PX) return undefined
    return `已贴合,尺寸受应用限制:实际 ${actual.w}×${actual.h}(槽位 ${target.w}×${target.h})`
  }

  async function restoreCurrent(): Promise<void> {
    if (current === undefined) return
    const held = current
    current = undefined
    // 送回原位是尽力而为:窗口可能已被用户关掉,失败不阻塞新动作,但也不装成功——
    // 这里的失败只影响旧窗口回不到原位,不影响本次 snap 的结果上报。
    try {
      await deps.helper.request({ op: 'set_window_frame', bundle_id: held.bundleId, index: held.index, frame: held.originalFrame })
    }
    catch {
      // 原样吞掉:上一扇窗已不可控,真相以桌面实况为准。
    }
  }

  /**
   * 解析 app→(命令,bundle id)。有 registry(spec S4)就连自定义应用一起认;
   * 没有就只认基础八应用——跟合并前 ensureRunning 内部做的事完全一致,行为不变。
   */
  async function resolveApp(app: string): Promise<{ cmd: readonly string[], bundleId: string } | undefined> {
    if (deps.registry !== undefined) {
      const [cmd, bundleId] = await Promise.all([deps.registry.commandFor(app), deps.registry.bundleFor(app)])
      if (cmd === undefined || bundleId === undefined) return undefined
      return { cmd, bundleId }
    }
    const cmd = Object.hasOwn(APP_COMMANDS, app) ? APP_COMMANDS[app] : undefined
    const bundleId = Object.hasOwn(APP_BUNDLES, app) ? APP_BUNDLES[app] : undefined
    if (cmd === undefined || bundleId === undefined) return undefined
    return { cmd, bundleId }
  }

  return {
    async snap(app: string, pageRect: HelperRect): Promise<{ ok: boolean, reason?: string }> {
      const resolved = await resolveApp(app)
      if (resolved === undefined) {
        // 先落一个局部变量再赋给 last:直接读 last.reason 在 exactOptionalPropertyTypes 下
        // 会被拓宽回 string | undefined(TS 不跨闭包边界做控制流收窄),导致类型不匹配。
        const reason = `不认识这个应用:${app}`
        last = { app, state: 'failed', reason }
        return { ok: false, reason }
      }
      const { cmd, bundleId } = resolved
      try {
        if (current !== undefined && current.app !== app) await restoreCurrent()

        const activated = await ensureRunningWith(cmd, bundleId, { runCommand: deps.runCommand, sleep: deps.sleep })
        if (!activated.ok) throw new Error(activated.reason ?? '激活失败')

        const screen = await deps.helper.request({ op: 'screen_info' }) as unknown as { webview: HelperRect, scale: number }
        const target = pageRectToScreen(pageRect, screen.webview, screen.scale)

        const win = await waitForWindow(bundleId, cmd)
        if (win === undefined) throw new Error(`没有可贴合的窗口:${bundleId}`)

        // 同一应用重复贴合不重记原位——原位是"贴合前"的位置,不是上一次槽位。
        if (current?.app !== app) current = { app, bundleId, index: win.index, originalFrame: win.frame }

        const set = await setFrameVerified(bundleId, win.index, target)
        if (!set.ok) {
          throw new Error(`贴合失败:窗口没有落到槽位${set.actual === undefined ? '' : `(实际 ${set.actual.x},${set.actual.y} ${set.actual.w}×${set.actual.h})`}`)
        }
        await deps.helper.request({ op: 'raise_window', bundle_id: bundleId, index: win.index })
        // 政策不变(尺寸只设下限):这里不影响 ok,只是如实标注 snapped 状态下的尺寸偏差(spec D13)。
        const reason = sizeDiffReason(set.actual, target)
        last = { app, state: 'snapped', ...(reason === undefined ? {} : { reason }) }
        return { ok: true }
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        last = { app, state: 'failed', reason }
        return { ok: false, reason }
      }
    },

    async unsnap(): Promise<{ ok: boolean, reason?: string }> {
      await restoreCurrent()
      last = undefined
      return { ok: true }
    },

    snapView(): SnapView | undefined {
      return last
    },
  }
}
