/**
 * 那行红字里多出来的一颗按钮(2026-09-18)。独占 `ben-wb__accessnote*` 前缀、单独一个
 * 文件,理由同 emptyStyle.ts / unlockStyle.ts:`style.ts` 这一版同时被好几张卡改着,
 * 把这几行塞进那个一千多行的模板串里,合并时必冲突。
 *
 * 只加排布,不加颜色:红框、红字仍然是既有的 `.ben-wb__slot-warn`(style.ts 第 460 行),
 * 这里只让那一段能换行、并把按钮摆在句末。横屏底部那一格只有三百像素高,
 * 这句话本来就得允许折行 —— 不折行就只能被裁掉半句。
 */
export const ACCESS_NOTE_STYLE = `
.ben-wb__accessnote{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ben-wb__accessnote-line{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.ben-wb .ben-wb__accessnote-go{flex:none;padding:1px 9px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:inherit;cursor:pointer}
.ben-wb .ben-wb__accessnote-go:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb__accessnote-err{flex:1 1 100%;opacity:.85}
`
