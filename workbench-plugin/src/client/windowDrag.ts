/**
 * 全屏界面的窗口拖拽兜底(2026-11-13)。
 *
 * 壳把标题栏做透明了(`ShellTitleBar`,`.fullSizeContentView`),拖窗口的落点改由网页顶栏
 * 空白处 mousedown → `titlebar_drag` → 壳 `performDrag(with:)` 提供。那一套只在主工作台的
 * `TopBar.tsx` 上;登录屏、启动弹窗、首次引导、整屏密钥引导都是 `WorkbenchOverlay` 的
 * early-return,不渲染 TopBar,于是装完到配完 Key 这一路窗口一下都拖不动。
 *
 * 这里补的判定只管「页面上没有 TopBar」的那些屏:窗口顶部一条 30px 空白带(左边 78px
 * 留给系统红绿灯)按住就能拖,发的是**同一条**既有壳消息,不另开通道、不改 DOM 布局、
 * 不盖一层会吃掉点击的东西。能点的元素按下去一律不算拖动。
 *
 * 浏览器标签页里 `postToShell` 会回 false,这一层就完全不动作:不 `preventDefault`,
 * 不打扰网页自己的选择/点击。浏览器本来也不需要拖窗口(那是标签页的事)。
 */
import { requestShellDrag } from './topbarDrag.ts'

/** 顶部可拖的高度(pt/px,壳窗口与网页都是点坐标)。够按,又不至于盖住内容。 */
export const WINDOW_DRAG_BAND_PX = 30
/** 左边留给系统红绿灯的宽度,与壳侧 `ShellTitleBar.trafficLightInset` 同一个数。 */
export const WINDOW_DRAG_TRAFFIC_INSET_PX = 78
/** 显式把一块区域标成可拖的把手(任何高度都算,但可交互元素仍优先排除)。 */
export const WINDOW_DRAG_ATTR = 'data-wb-drag'
/** 主工作台有这一条,那一屏的拖拽归它自己管。 */
export const WINDOW_DRAG_TOPBAR_CLASS = 'ben-wb__topbar'

export const WINDOW_DRAG_COPY = {
  hint: '按住这里可以拖动窗口',
} as const

/**
 * 按下去不算拖动的东西。与 `topbarDrag.ts` 的 NO_DRAG_SELECTOR 同一套,**少了 `[role="dialog"]`**:
 * 这一版要盖的就是那些整屏 dialog(启动弹窗本身就是 role=dialog),把 dialog 当「不能拖」
 * 就等于一屏都拖不动了。
 */
export const WINDOW_DRAG_NO_DRAG_SELECTOR =
  'a,button,input,select,textarea,label,summary,details,[role="button"],[contenteditable="true"],[data-no-drag]'

export interface WindowDragHit {
  button: number
  clientX: number
  clientY: number
  defaultPrevented: boolean
  /** 按在能点的元素(或它的子元素)上。 */
  interactive: boolean
  /** 按在显式标了 `data-wb-drag` 的把手里。 */
  inHandle: boolean
  /** 页面上渲染着主工作台顶栏;那一屏归 TopBar 管,这里整体让开。 */
  hasTopBar: boolean
}

/** 这一下该不该把窗口交给壳拖。纯函数,用例在 `windowDrag.test.ts`。 */
export function shouldWindowDrag(hit: WindowDragHit): boolean {
  if (hit.button !== 0) return false
  if (hit.defaultPrevented) return false
  if (hit.hasTopBar) return false
  if (hit.interactive) return false
  // 把手是显式约定:标了就认,不受顶部带/红绿灯留白的限制。
  if (hit.inHandle) return true
  if (hit.clientY < 0 || hit.clientY > WINDOW_DRAG_BAND_PX) return false
  if (hit.clientX <= WINDOW_DRAG_TRAFFIC_INSET_PX) return false
  return true
}

/**
 * 在文档上装一次全局 mousedown 监听。插件入口 `apply()` 调一次就够,之后不管界面
 * 切成登录屏 / 弹窗 / 引导页 / 主工作台,监听都在。
 *
 * @returns 摘掉监听的清理函数(测试与热更新时用)。
 */
export function installWindowDrag(doc: Document, win: unknown): () => void {
  const onDown = (event: MouseEvent): void => {
    const node = event.target
    const element = node instanceof Element ? node : null
    const inHandle = element !== null && element.closest(`[${WINDOW_DRAG_ATTR}]`) !== null
    const interactive = element !== null && element.closest(WINDOW_DRAG_NO_DRAG_SELECTOR) !== null
    const hasTopBar = doc.querySelector(`.${WINDOW_DRAG_TOPBAR_CLASS}`) !== null
    if (!shouldWindowDrag({
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      defaultPrevented: event.defaultPrevented,
      interactive,
      inHandle,
      hasTopBar,
    })) return
    // 不在壳里(普通浏览器)就原地收手,连 preventDefault 都不做。
    if (!requestShellDrag(win)) return
    event.preventDefault()
  }
  doc.addEventListener('mousedown', onDown)
  return () => doc.removeEventListener('mousedown', onDown)
}
