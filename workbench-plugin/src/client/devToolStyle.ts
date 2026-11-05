/**
 * 「开发一个小工具」那颗按钮的样式(2026-09-20)。
 *
 * 独占 `ben-wb__devtool*` 前缀、单独一个文件,理由同 sceneMenuStyle.ts / emptyStyle.ts:
 * `style.ts` 这一版同时被好几张卡改着(横屏模块搬家、去掉预置场景),把这几行塞进那个
 * 一千多行的模板串里,合并时必冲突。
 *
 * **跟标签同一家族,但看得出不是标签**:圆角、字号、内边距都照 `.ben-wb__dock-tab` 那套,
 * 所以它站在标签队尾不突兀;区别在底色 —— 标签是实心的 `bg-layer-2`(它代表一扇真窗口),
 * 这颗是描边透明的(它代表一个动作,背后没有窗)。虚线边框是第二重区分:一眼看出
 * 「这里还没有东西,是让你去造一个」。
 *
 * 横屏那一支(`.ben-wb__land-rail` 里)`margin-top:auto` 把它顶到栏底 —— Ben 原话
 * 「横版在底部」。左栏定死 168px,所以名字这一行允许被省略号截断,不折行、不把栏撑开
 * (2026-09-18 那三处显示问题的教训:窄栏里一折行就开始有东西掉到栏外)。
 */
export const DEV_TOOL_STYLE = `
.ben-wb__devtool{display:inline-flex;flex:none;min-width:0}
.ben-wb .ben-wb__devtool-btn{display:inline-flex;align-items:center;gap:5px;min-width:0;padding:5px 9px;border:1px dashed var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:1.2;cursor:pointer}
.ben-wb .ben-wb__devtool-btn:hover{border-style:solid;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__devtool-icon{flex:none}
.ben-wb__devtool-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__land-rail .ben-wb__devtool{margin-top:auto;width:100%}
.ben-wb__land-rail .ben-wb__devtool-btn{width:100%;justify-content:flex-start}
`
