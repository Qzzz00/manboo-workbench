/**
 * 全屏界面顶上那一条「按住这里可以拖动窗口」(2026-11-13)。
 *
 * 只是视觉提示:**整条 pointer-events:none**,一下点击都不吃。真正拖窗口靠
 * `windowDrag.ts` 装的全局 mousedown 监听(按坐标判定后发 `titlebar_drag`)。
 * 这样加了把手之后,底下原有内容的按钮、输入框、链接全都照旧能点。
 *
 * 左侧 78px 让给系统红绿灯,和壳侧 `ShellTitleBar.trafficLightInset`、主工作台顶栏
 * 的 `--ben-wb-traffic-inset` 是同一个数。
 */
import { WINDOW_DRAG_COPY } from './windowDrag.ts'

export function WindowDragHandle() {
  return (
    <div
      className="ben-wb__dragbar"
      data-wb-drag=""
      aria-label="拖动窗口"
    >
      <style>{DRAGBAR_STYLE}</style>
      <span>{WINDOW_DRAG_COPY.hint}</span>
    </div>
  )
}

/** 样式自包含,只挂在 `.ben-wb__dragbar` 下,不漏到工作台本体。 */
const DRAGBAR_STYLE = `
.ben-wb__dragbar{position:fixed;top:0;left:78px;right:0;height:30px;z-index:10000;display:flex;align-items:center;justify-content:center;pointer-events:none;user-select:none;font-size:11px;letter-spacing:.08em;color:var(--wb-faint,rgba(127,127,127,.6))}
@media (prefers-color-scheme: light){.ben-wb__dragbar{color:rgba(60,60,67,.45)}}
`
