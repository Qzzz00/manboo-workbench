/**
 * 顶栏当标题栏用(2026-09-25,卡 TB;维护者原话「客户端没法全屏、顶部空隙难受」)。
 *
 * 壳那边把窗口标题栏做透明了(`.fullSizeContentView`,见 workbench-app/Sources/TitleBar.swift),
 * 网页内容顶到窗顶、红绿灯浮在顶栏上 —— 顶上不再叠两层标题。代价是**拖窗口没了落点**:
 * 原来那条能按住拖的标题栏没有了。补法就是这个文件:顶栏**空白处**按下左键 → 经壳的通道
 * 发 `titlebar_drag`,壳用系统的 `performDrag(with:)` 接着做(手感、贴边、跨屏都是系统在做);
 * 双击空白处发 `titlebar_dblclick`,壳照系统设置「连按标题栏来」那一项走。
 *
 * 「空白处」的判断在这里(纯函数,有单测):顶栏里能点的东西(小灯、齿轮、纯净开关……)
 * 按下去不算拖动,否则点一下就把窗口拖走了。浏览器里没有壳的通道,这两下什么都不做。
 */

import { postToShell } from './shell.ts'

/** 壳认的两条消息(与 workbench-app/Sources/TitleBar.swift 里的字符串一字不差)。 */
export const TITLEBAR_DRAG = 'titlebar_drag'
export const TITLEBAR_DBLCLICK = 'titlebar_dblclick'
/** 顶栏「换屏」(2026-09-27,维护者「加一个按钮,一键搬运到另一个桌面」):壳把窗口搬到下一块屏。 */
export const TITLEBAR_MOVE_SCREEN = 'titlebar_move_screen'

/**
 * 按下去**不算**拖动的东西:能点的一律不算(按钮、链接、输入、可展开、显式标了 data-no-drag 的)。
 * 顶栏上的小灯有的是 span、有的是 button(能点开详情那一张),所以除了标签名还认 role 与
 * `data-no-drag` —— 以后往顶栏加东西,加一个 `data-no-drag` 就不会被误当成拖动区。
 */
const NO_DRAG_SELECTOR = 'a,button,input,select,textarea,label,summary,details,[role="button"],[role="dialog"],[contenteditable="true"],[data-no-drag]'

interface ClosestNode { closest: (selectors: string) => unknown }
interface ContainsNode { contains: (node: unknown) => boolean }

/**
 * 这一下按在顶栏的空白处吗(可以当「拖窗口」)。
 *
 * - 按的东西不在顶栏里 → 不是(事件冒泡上来的别处的点击)。
 * - 按到顶栏里任何能点的东西(或它的子元素,比如按钮里的小圆点)→ 不是。
 * - 其余(顶栏底色、名字那几个字、「存储」这类标签文字)→ 是。
 *
 * 参数收 unknown 而不是 Element:测试里传 jsdom 的节点、壳里传真事件的 target,两边都不用转型;
 * 拿到的东西不像个节点(没有 closest / contains)一律当「不是」—— 宁可拖不动,也不要点一下窗口就跑。
 */
export function isDragBlank(target: unknown, bar: unknown): boolean {
  const node = target as ClosestNode | null | undefined
  const root = bar as (ContainsNode & ClosestNode) | null | undefined
  if (node === null || node === undefined || typeof node.closest !== 'function') return false
  if (root === null || root === undefined || typeof root.contains !== 'function') return false
  if (!root.contains(node)) return false
  const hit = node.closest(NO_DRAG_SELECTOR)
  if (hit !== null && hit !== undefined && root.contains(hit)) return false
  return true
}

/** 顶栏空白处按下了:交给壳拖窗口。不在壳里(浏览器标签页)返回 false,什么都没发生。 */
export function requestShellDrag(win: unknown): boolean {
  return postToShell(win, { type: TITLEBAR_DRAG })
}

/** 双击了顶栏空白处:交给壳,照系统设置(缩放 / 最小化 / 什么都不做)。 */
export function requestShellTitleBarDoubleClick(win: unknown): boolean {
  return postToShell(win, { type: TITLEBAR_DBLCLICK })
}

/** 「换屏」:交给壳把窗口搬到下一块屏、按那块屏铺好。不在壳里返回 false。 */
export function requestShellMoveScreen(win: unknown): boolean {
  return postToShell(win, { type: TITLEBAR_MOVE_SCREEN })
}
