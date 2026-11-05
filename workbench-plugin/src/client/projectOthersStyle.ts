/**
 * 项目区「其他仓库(N)」那一格的样式(2026-09-25,卡 feat/first-look-orb-top)。
 *
 * 独占 `ben-wb__pj-others` / `ben-wb__ptab--others` 两个名字、单独一个文件,理由同 devToolStyle.ts:
 * `style.ts` 同时被好几张卡改着,这里只在它末尾多拼一行。
 *
 * **看得出不是一个项目**:页签那一格是虚线描边、字淡一档(同「开发一个小工具」那颗键的做法 ——
 * 背后不是一个真东西,是一个收纳口);总览那一格是一行可展开的小字。
 */
export const PROJECT_OTHERS_STYLE = `
.ben-wb .ben-wb__ptab.ben-wb__ptab--others{border-style:dashed;color:var(--dsw-alias-label-tertiary);gap:6px}
.ben-wb .ben-wb__ptab.ben-wb__ptab--others:hover{color:var(--dsw-alias-label-secondary)}
.ben-wb__pj-others{margin:10px 0 4px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.ben-wb__pj-others>summary{cursor:pointer;list-style:none;font-size:var(--wb-t4,11px);color:var(--dsw-alias-label-tertiary);padding:2px 0 6px}
.ben-wb__pj-others>summary::-webkit-details-marker{display:none}
.ben-wb__pj-others>summary::after{content:' +';opacity:.7}.ben-wb__pj-others[open]>summary::after{content:' −'}
`
