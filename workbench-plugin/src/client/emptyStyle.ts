/**
 * 第一次用的空态样式(2026-09-18)。
 *
 * 单独一个文件、独占 `ben-wb__emptyfirst*` 前缀,理由同 unlockStyle.ts:`style.ts` 这一版
 * 同时被好几张卡改着(热更新按钮、首次流程那几屏),把这十来行塞进那个一千行的模板串里,
 * 合并时必冲突。
 *
 * **为什么不叫 `ben-wb__empty`**:那个类早就有了(`style.ts`,UsagePanel /
 * FilesModule 里那几句灰色小字都在用),它是"一行次要说明"的通用样式。
 * 这一版的空态是**一段带按钮的引导**,两者视觉与语义都不是一回事,占同一个名字迟早互相
 * 改坏(历史上 `ben-wb__card` / `ben-wb__inbox` 都撞过名)。
 */
export const EMPTY_STYLE = `
.ben-wb__emptyfirst{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.ben-wb__emptyfirst-line{margin:0;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t3);line-height:1.6;overflow-wrap:anywhere}
.ben-wb .ben-wb__emptyfirst-btn{padding:2px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb .ben-wb__emptyfirst-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 窗位槽那一格:悬浮在槽体里,不占文档流 —— 见 EmptyState.tsx 的 overlay 注释
   (槽体尺寸一变,服务端就会把贴住的窗重摆一次)。 */
.ben-wb__emptyfirst[data-overlay=true]{position:absolute;left:0;right:0;top:0;z-index:4;border:0;background:transparent;pointer-events:none}
.ben-wb__emptyfirst[data-overlay=true] .ben-wb__emptyfirst-line{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t4)}
`
