/**
 * 窄栏里的场景条 —— 收成一颗图标按钮 + 一块弹出面板(2026-09-18)。
 *
 * 独占 `ben-wb__scenemenu*` 前缀、单独一个文件,理由同 emptyStyle.ts / unlockStyle.ts:
 * `style.ts` 这一版同时被好几张卡改着,把这十来行塞进那个一千多行的模板串里,合并时必冲突。
 * 面板**里面**那几行仍然是既有的 `.ben-wb__scene-*`(名字、恢复、覆盖保存、删除)——
 * 这一版没有第二套场景行,只是给它换了个住处。
 *
 * 为什么面板要 `left:100%` 往右开,而不是在栏里往下展开:横屏左栏定死 168px,
 * 「覆盖保存」四个字加上「恢复」「删除」在这个宽度里怎么排都要折行(Ben 09-18 截图第一处
 * 就是被挤成两行、还截掉半个字)。往右开之后面板自己说了算有多宽,一行放得下三颗按钮。
 * 它落在 `.ben-wb__land-band` 里(那一条是 overflow:hidden 的),往右开进的是中间那块
 * 窗位槽的地盘,不会被裁掉。
 */
export const SCENE_MENU_STYLE = `
.ben-wb__scenemenu{position:relative;flex:none}
.ben-wb .ben-wb__scenemenu-trigger{display:flex;align-items:center;gap:6px;width:100%;padding:4px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;text-align:left;cursor:pointer}
.ben-wb .ben-wb__scenemenu-trigger:hover,.ben-wb .ben-wb__scenemenu-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__scenemenu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__scenemenu-pop{position:absolute;left:100%;top:0;z-index:6;width:280px;margin-left:8px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.ben-wb__scenemenu-pop .ben-wb__scenebar{margin-bottom:0}
`
