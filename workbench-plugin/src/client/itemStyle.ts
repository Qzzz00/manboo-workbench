/**
 * 一件事一份、进度靠证据(2026-09-25,卡 N)那几块的样式:卡上那一行「到哪」、卡片弹窗里「现在到哪 · 依据 · 几点看的」、
 * 事项详情里那一小段、空泳道收成一行、「＋ 新模块」小按钮。
 *
 * 2026-10-12 加「停在哪」:卡面 `ben-wb__task-standing`、弹窗 `ben-wb__item-standing`(停住的用 warn,不用红;不再需要的用三级灰)。
 *
 * 独占 `ben-wb__item-*` / `ben-wb__lane-empty*` / `ben-wb__lane-new-btn` / `ben-wb__task-progress` /
 * `ben-wb__particle-progress` 前缀、单独一个文件(同 layoutAskStyle.ts 的理由:style.ts 常被好几张卡同时改)。
 * 颜色全走设计令牌(--dsw-alias-*),不自己写色值;「对不上」用 warn 那一档,不用红(红只给真失败)。
 */
export const ITEM_STYLE = `
.ben-wb__task-progress{margin:3px 0 0;font-size:var(--wb-t4);line-height:1.45;color:var(--dsw-alias-label-secondary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ben-wb__task-progress[data-state=none]{color:var(--dsw-alias-label-tertiary)}
.ben-wb__task-progress[data-state=mismatch]{color:var(--dsw-alias-state-warn-label)}
.ben-wb__task-standing{margin:3px 0 0;font-size:var(--wb-t4);line-height:1.45;color:var(--dsw-alias-state-warn-label);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ben-wb__task-standing[data-case=likely_moot]{color:var(--dsw-alias-label-tertiary)}
.ben-wb__item-standing{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.ben-wb__item-standing h4{margin:0;font-size:var(--wb-t4);font-weight:600;color:var(--dsw-alias-label-tertiary)}
.ben-wb__item-progress{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.ben-wb__item-progress h4{margin:0;font-size:var(--wb-t4);font-weight:600;color:var(--dsw-alias-label-tertiary)}
.ben-wb__item-mover{margin:0;font-size:var(--wb-t4);color:var(--dsw-alias-label-secondary)}
.ben-wb__item-line{margin:0;font-size:var(--wb-t3);line-height:1.5;color:var(--dsw-alias-label-primary)}
.ben-wb__item-line[data-state=none]{color:var(--dsw-alias-label-secondary)}
.ben-wb__item-mismatch{margin:0;font-size:var(--wb-t4);color:var(--dsw-alias-state-warn-label)}
.ben-wb__item-basis{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px}
.ben-wb__item-basis li{font-size:var(--wb-t4);line-height:1.45;color:var(--dsw-alias-label-tertiary)}
.ben-wb__item-basis q{quotes:"「" "」";color:var(--dsw-alias-label-secondary)}
.ben-wb__item-when{margin:0;font-size:var(--wb-t4);color:var(--dsw-alias-label-tertiary)}
.ben-wb__item-acts{display:flex;flex-wrap:wrap;gap:6px}
.ben-wb .ben-wb__item-acts button,.ben-wb .ben-wb__item-say button{height:26px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t4);cursor:pointer}
.ben-wb .ben-wb__item-acts button:hover,.ben-wb .ben-wb__item-say button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb .ben-wb__item-acts button[data-primary=true]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.ben-wb .ben-wb__item-acts button:disabled,.ben-wb .ben-wb__item-say button:disabled{opacity:.5;cursor:default}
.ben-wb__item-confirm{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2)}
.ben-wb__item-confirm p{margin:0;font-size:var(--wb-t4);line-height:1.5;color:var(--dsw-alias-label-primary)}
.ben-wb__item-say{display:flex;gap:6px}
.ben-wb__item-say input,.ben-wb__item-owner input{flex:1;min-width:0;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t4)}
.ben-wb__item-say input:focus,.ben-wb__item-owner input:focus{outline:0;border-color:var(--dsw-alias-state-business-primary)}
.ben-wb__item-owner{display:flex;margin-top:6px}
.ben-wb__particle-progress{margin:8px 0;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l1)}
.ben-wb__particle-progress small{display:block;color:var(--dsw-alias-label-secondary);font-size:10px}
.ben-wb__particle-progress p{margin:2px 0}
.ben-wb__particle-progress p[data-state=mismatch]{color:var(--dsw-alias-state-warn-label)}
.ben-wb__board-lane[data-empty=true]{align-items:center}
.ben-wb__lane-empty{grid-column:2/-1;display:flex;align-items:center;gap:10px;min-height:34px;padding:2px 6px;border:1px dashed transparent;border-radius:9px}
.ben-wb__lane-empty[data-over=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.ben-wb__lane-empty-note{font-size:var(--wb-t4);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ben-wb__lane-new[data-collapsed=true]{padding:2px 4px 8px}
.ben-wb .ben-wb__lane-new-btn{padding:3px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--wb-t4);cursor:pointer}
.ben-wb .ben-wb__lane-new-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
`
