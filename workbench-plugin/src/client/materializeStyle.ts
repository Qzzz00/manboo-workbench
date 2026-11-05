/**
 * 「我照你说的摆好了」那张卡的样式(2026-09-24 晚,卡 feat/onboarding-materialize)。
 *
 * 独占 `ben-wb__laid*` 前缀、单独一个文件(同 layoutAskStyle.ts 的理由:style.ts 常被好几张卡同时改)。
 * 只做深色(维护者 09-24「先不做浅色」);不用蓝色:主按钮白底黑字(`--ben-btn-*`),勾选框白色;
 * 光沿边那一圈由卡 A 那一区画(表里最前面那张走光),这里不另画。单子长,行区自己滚动,不把输入框挤出屏幕。
 */
export const MATERIALIZE_STYLE = `
/*
 * 2026-09-25 起它住在球下面那一区的「要你处理的」表里(卡 A 的 .ben-wb__ask 给框、底色、内边距与那一道光):
 * 在那里面不再自己画框。卡 A 那一区的按钮样式(.ben-wb__ask button)比这里的单类名更具体,主按钮与次按钮按那一区的写法再压一次。
 *
 * 2026-09-25 真壳验收(卡 fix/materialize-card-fit):卡是「卡头 / 行区 / 底栏」三截,只有行区滚,底栏钉在卡里;
 * 整张卡最高多少由 MaterializeAsk 量出来(从卡顶到事务官那一档舞台的底,即输入框上面)写在 style 上,不再用 vh。
 */
.ben-wb__ask .ben-wb__laid { border: 0; padding: 0; margin: 0; background: transparent; }
.ben-wb__ask .ben-wb__laid-go {
  background: var(--ben-btn-bg, #ffffff); color: var(--ben-btn-fg, #111111); border: 1px solid transparent;
  border-radius: 999px; padding: 6px 16px; font-weight: 600;
}
.ben-wb__ask .ben-wb__laid-go:hover:not(:disabled) { background: var(--ben-btn-hover, #ececec); color: var(--ben-btn-fg, #111111); }
.ben-wb__ask .ben-wb__laid-ghost { border-radius: 999px; padding: 6px 14px; }
.ben-wb__ask .ben-wb__laid-link, .ben-wb__laid-link {
  border: 0; background: transparent; padding: 6px 4px; color: rgba(210, 210, 210, 0.85); font: inherit; cursor: pointer;
  text-decoration: underline; text-underline-offset: 3px;
}
.ben-wb__ask .ben-wb__laid-link:hover:not(:disabled) { background: transparent; color: #f4f4f4; }
/* 单子那一格的框(卡 A 的 .ben-wb__ask)内边距收一点。 */
.ben-wb__ask[data-ask^="laid:"] { padding: 10px 14px; }
/*
 * 球下那一区摆不下整张时,每张收成一行(卡 fix/materialize-card-fit;统筹拍板:粒子球是主角,球不让,卡片收成行)。
 * 真壳 1475×812 下那一区只剩 25px:上下各留 2px,一行 21px(字 12px、按钮 19px)。再摆不下就只留一行「还有 N 件要你看 · 展开」。
 */
.ben-wb__items--particle[data-asks-mode=rows] .ben-wb__scene-below,
.ben-wb__items--particle[data-asks-mode=summary] .ben-wb__scene-below { padding: 2px; gap: 4px; }
.ben-wb__items--particle[data-asks-mode=rows] .ben-wb__asks,
.ben-wb__items--particle[data-asks-mode=summary] .ben-wb__asks { gap: 4px; }
.ben-wb__asks .ben-wb__askrow {
  box-sizing: border-box; height: 21px; display: flex; align-items: center; gap: 8px; padding: 0 4px 0 12px; overflow: hidden; white-space: nowrap;
  border: 1px solid var(--wb-surface-border, var(--dsw-alias-border-l1)); border-radius: 999px;
  background: var(--wb-surface-soft, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 17px;
}
.ben-wb__asks>.ben-fx>.ben-fx__beam:has(> .ben-wb__askrow) { border-radius: 999px; }
.ben-wb__askrow-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ben-wb__askrow .ben-wb__askrow-open { flex: none; }
.ben-wb__askrow--summary .ben-wb__askrow-text { flex: none; }
.ben-wb__askrow-dot { flex: none; color: rgba(200, 200, 200, 0.5); }
/* 单子收成的那一行:标题 + 几个项目几件事 + 就这样 / 改一下 / 看全部(或回执 + 收起)。 */
.ben-wb__laid.ben-wb__laid--row {
  flex: 1 1 auto; min-width: 0; flex-direction: row; align-items: center; gap: 8px; margin: 0; padding: 0; border: 0; background: transparent;
  overflow: hidden; white-space: nowrap; max-height: none;
}
.ben-wb__ask .ben-wb__laid.ben-wb__laid--row { height: 21px; }
.ben-wb__laid-rowtitle { flex: none; font-weight: 600; color: #f0f0f0; }
.ben-wb__laid-rowsub { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: rgba(200, 200, 200, 0.72); }
.ben-wb__laid-rowacts { flex: none; display: inline-flex; align-items: center; gap: 6px; }
.ben-wb__laid.ben-wb__laid--row button { height: 19px; padding: 0 10px; font-size: 11.5px; line-height: 15px; border-radius: 999px; box-sizing: border-box; }
.ben-wb__laid.ben-wb__laid--row .ben-wb__laid-go { background: var(--ben-btn-bg, #ffffff); color: var(--ben-btn-fg, #111111); border: 1px solid transparent; font-weight: 600; }
.ben-wb__laid.ben-wb__laid--row .ben-wb__laid-link, .ben-wb__askrow .ben-wb__laid-link { height: 19px; padding: 0 6px; border: 0; background: transparent; font-size: 11.5px; line-height: 15px; }
.ben-wb__laid.ben-wb__laid--row .ben-wb__laid-err { flex: none; font-size: 11px; }
/* 要他看的几张整张摊开(「展开」):盖在这一档上面,「收起」回去。 */
.ben-wb__asks-sheet {
  position: absolute; inset: 0; z-index: 6; display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 36px clamp(12px, 3cqw, 40px) 12px; box-sizing: border-box; background: var(--wb-surface-card, var(--dsw-alias-bg-layer-1));
}
.ben-wb__asks-sheet-head { width: 100%; max-width: 860px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ben-wb__asks-sheet-title { margin: 0; font-size: 14px; font-weight: 600; color: #f4f4f4; }
.ben-wb__asks-sheet-body.ben-wb__asks { flex: 1 1 auto; min-height: 0; overflow-y: auto; width: 100%; max-width: 860px; }
/* 摊开那一层是滚动区:里面每张照自己的高度摆,不许被压扁(光沿边那一层 overflow:hidden,默认会被 flex 压到 0)。 */
.ben-wb__asks-sheet-body > .ben-fx > .ben-fx__beam, .ben-wb__asks-sheet-body > * { flex: none; }
.ben-wb__laid {
  flex: 0 1 auto;
  min-height: 0;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  padding: 12px 14px;
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  background: rgba(18, 18, 20, 0.72);
  color: rgba(236, 236, 236, 0.95);
  overflow: hidden;
  accent-color: #ffffff;
}
.ben-wb__laid-top, .ben-wb__laid-foot { flex: none; display: flex; flex-direction: column; gap: 4px; }
.ben-wb__laid-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 2px; }
.ben-wb__laid-row, .ben-wb__laid-hint { flex: none; }
/* 整张摊开:盖在事务官这一档上面(球、输入框都盖住),卡占满、底栏钉在底下。 */
.ben-wb__laid-sheet {
  position: absolute; inset: 0; z-index: 6; display: flex; flex-direction: column; align-items: center;
  /* 顶上留 36px:窗口槽「叠里还没有窗……」那一条盖在这一档最上面那一截。 */
  padding: 36px clamp(12px, 3cqw, 40px) 12px; box-sizing: border-box; background: var(--wb-surface-card, var(--dsw-alias-bg-layer-1));
}
.ben-wb__laid-sheet > .ben-wb__laid { flex: 1 1 auto; width: 100%; max-width: 860px; margin: 0; box-sizing: border-box; }
.ben-wb__laid--sheet .ben-wb__laid-top { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; column-gap: 12px; }
.ben-wb__laid--sheet .ben-wb__laid-top .ben-wb__laid-close { grid-column: 2; grid-row: 1 / span 2; align-self: start; }
.ben-wb__laid-donehead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.ben-wb__laid-donehead .ben-wb__laid-line { flex: 1 1 12em; }
.ben-wb__laid-head { margin: 0; font-size: 14px; font-weight: 600; color: #f4f4f4; }
.ben-wb__laid-sub { margin: 0; color: rgba(200, 200, 200, 0.7); }
.ben-wb__laid-line { margin: 0; font-size: 13.5px; color: #f4f4f4; }
.ben-wb__laid-group { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.ben-wb__laid-gtitle { margin: 0; font-size: 11.5px; letter-spacing: .02em; color: rgba(190, 190, 190, 0.65); }
.ben-wb__laid-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.ben-wb__laid-item { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 3px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
.ben-wb__laid-item[data-done="true"], .ben-wb__laid-item[data-off="true"] { opacity: .5; }
.ben-wb__laid-check { display: inline-flex; align-items: baseline; gap: 6px; cursor: pointer; min-width: 0; }
.ben-wb__laid-check input[type="checkbox"] { margin: 0; transform: translateY(1px); }
.ben-wb__laid-title { color: #ededed; }
.ben-wb__laid-title-input {
  min-width: 14em; font: inherit; color: #f4f4f4; background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px; padding: 2px 6px;
}
.ben-wb__laid-owner {
  font: inherit; color: #f4f4f4; background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px; padding: 1px 4px;
}
.ben-wb__laid-detail { color: rgba(190, 190, 190, 0.72); font-size: 11.5px; }
.ben-wb__laid-note { color: rgba(170, 170, 170, 0.6); font-size: 11px; }
.ben-wb__laid-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
.ben-wb__laid-go {
  background: var(--ben-btn-bg, #ffffff); color: var(--ben-btn-fg, #111111); border: 1px solid var(--ben-btn-edge, rgba(0, 0, 0, .14));
  border-radius: 999px; padding: 5px 16px; font: inherit; font-weight: 600; cursor: pointer;
}
.ben-wb__laid-go:hover:not(:disabled) { background: var(--ben-btn-hover, #ececec); }
.ben-wb__laid-go:disabled { opacity: .45; cursor: default; }
.ben-wb__laid-ghost {
  background: transparent; color: #ededed; border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 999px; padding: 5px 14px; font: inherit; cursor: pointer;
}
.ben-wb__laid-ghost[aria-pressed="true"] { border-color: rgba(255, 255, 255, 0.6); }
.ben-wb__laid-hint { margin: 0; color: rgba(170, 170, 170, 0.6); font-size: 11px; }
.ben-wb__laid-err { margin: 0; color: rgba(238, 150, 140, 0.95); }
.ben-wb__laid-failed { margin: 0; padding-left: 16px; color: rgba(238, 190, 120, 0.9); font-size: 12px; }
@media (prefers-reduced-motion: reduce) { .ben-wb__laid { transition: none; } }
`
