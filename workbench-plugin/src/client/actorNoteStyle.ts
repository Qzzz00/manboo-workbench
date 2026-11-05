/**
 * 事务官动了哪一块时那一行字(2026-09-25 卡 P 补三,见 ActorNotes.tsx)。独占 `ben-wb__actor-note*` 前缀、
 * 单独一个文件,理由同 accessNoteStyle.ts:`style.ts` 同时被好几张卡改着,塞进那个大模板串合并时必冲突。
 *
 * 只是一行字:没有光、没有圈、没有边框动画(流线光只属于他亲手把新应用拖进窗口槽、松手那一下)。
 * 最上面一层、不吃鼠标 —— 挂两秒就收,不挡他点东西;层级低于首次流程 / 账户那两层整屏(50),
 * 不压在对话框上面。位置由 ActorNotes 每一帧从那个元素当场量(`left` / `top`),挂在模块上时右对齐到那一块的右上角。
 */
export const ACTOR_NOTE_STYLE = `
.ben-wb__actor-notes{position:fixed;inset:0;pointer-events:none;z-index:40}
.ben-wb__actor-note{position:fixed;margin:0;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.18);pointer-events:none;animation:ben-wb-actor-note-in .18s ease-out}
.ben-wb__actor-note[data-on-card=false]{transform:translateX(-100%)}
@keyframes ben-wb-actor-note-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion: reduce){.ben-wb__actor-note{animation:none}}
`
