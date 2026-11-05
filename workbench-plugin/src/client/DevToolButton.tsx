/**
 * 窗位叠上那颗「开发一个小工具」(2026-09-20,决策记录同日那条 Ben 定的占位)。
 *
 * Ben 原话:「我想在窗口槽的应用那里加一个按钮,横版在底部,竖版在最右侧,名字叫
 * 开发一个小工具,点击下去之后,还是打开事务官,但是事务官会得到一个提前的输入,
 * 就是用户希望在窗口槽这个位置里开发一个工具类的应用,这个也先做占位就行。」
 *
 * **为什么单独一个组件、而不是在标签栏里多写一段 JSX**:它要出现在两个互斥的宿主里 ——
 * 竖屏是 DockTabBar 的那一排标签,横屏是 Workbench 左侧窄栏(标签栏被 hoistTabs 提上去
 * 之后,栏里还有场景菜单)。两处各抄一份,以后改文案/图标就要改两遍,迟早走漂
 * (先例:SceneBar 的 compact 那一版就是为了不让同一条场景条长出第二份)。同期还有两张卡
 * 在改 layout.ts / Workbench.tsx 横屏那一段与 scenes.ts / SceneBar,独立文件把冲突面压到最小。
 *
 * **它是动作,不是标签**:同一家族的圆角与字号(看着是一排里的成员),但没有 ✕、不可拖拽
 * 排序、不进 dock.stack、不带徽章 —— 它不是被认领的应用,点下去也不切任何窗,
 * 只是替用户把事务官叫出来、并把那句话先写进输入框。
 */

/** 按钮上的字。用例、横竖两处宿主共用同一个常量,改文案只改这一处。 */
export const DEV_TOOL_LABEL = '开发一个小工具'

/**
 * 点下去之后替用户写进事务官输入框的那一句(**预填,不发送**)。
 *
 * **2026-09-21 起真身在 `protocol.ts`**,这里只是 re-export。搬家的理由:服务端要拿这句话
 * **认出**一条事项其实是一次造模块的请求(`server/devTool.ts` 的 `isDevToolRequest`),
 * 而服务端 import 不了客户端。同一句话有两个地方说得出口就是走漂的起点
 * (同 MODULE_IDS、DEFAULT_LAYOUT 那两条先例)—— 那样的话改了按钮上的文案,
 * 服务端就再也认不出它了,而界面上什么异常都看不见。
 *
 * 结尾故意停在「它要做的是:」——光标落在这里,用户接着说想要什么就行。
 */
export { DEV_TOOL_DRAFT } from '../protocol.ts'

/**
 * 小扳手图标。**内联 SVG,不引图标库**——仓库里现有的图标(事务官输入区的话筒/发送箭头、
 * 场景菜单那个小窗格)全是这么画的,为一颗按钮加一个依赖不划算(YAGNI,AGENTS.md 第 5 条)。
 * `stroke="currentColor"` 让它跟着按钮的文字色走,明暗主题都不用另给一份。
 */
function WrenchIcon() {
  return (
    <svg
      className="ben-wb__devtool-icon"
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14.7 6.3a4 4 0 0 0 5 5l-7.4 7.4a2.1 2.1 0 0 1-3-3Z" />
      <path d="M14.7 6.3 17.5 3.5a4 4 0 0 1 3 5.6" />
    </svg>
  )
}

/**
 * 竖屏排在标签那一排的最右、横屏排在左侧窄栏的最底。位置由**宿主**决定(两处各插一行),
 * 这个组件只管长什么样、点了叫谁 —— 它不认识方向,也不认识事务官。
 */
export function DevToolButton({ onClick }: { onClick: () => void }) {
  return (
    <span className="ben-wb__devtool">
      <button
        type="button"
        className="ben-wb__devtool-btn"
        onClick={onClick}
        title="打开事务官,说说你想要一个什么样的小工具"
      >
        <WrenchIcon />
        <span className="ben-wb__devtool-name">{DEV_TOOL_LABEL}</span>
      </button>
    </span>
  )
}
