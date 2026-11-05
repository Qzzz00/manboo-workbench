/**
 * 指挥台的样式(2026-09-22,`client/TopicDeck.tsx` 与 `client/FeatureDeck.tsx` 共用)。
 *
 * 独占 `ben-wb__deck*` 前缀、单独一个文件,理由同 `layoutAskStyle.ts` / `templateStyle.ts`:
 * `style.ts` 与 `templateStyle.ts` 这一晚同时被好几张卡改着,塞进去必冲突。
 *
 * 颜色与圆角从 `templateStyle.ts` 的 `.ben-wb__topics-*` 逐字抄来(同一格里的东西),
 * 不另调一套 —— 她在同一张卡上不该看到两种质感。
 */
export const TOPIC_DECK_STYLE = `
.ben-wb__deck { display: flex; flex-direction: column; gap: 6px; }

/* 四态:当前那格高亮。四格等宽 —— 它们是同一件事的四种状态,不分主次。 */
.ben-wb__deck-phases { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; }
.ben-wb .ben-wb__deck-phases button {
  padding: 3px 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: var(--wb-t5); cursor: pointer;
}
.ben-wb .ben-wb__deck-phases button[data-on="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
  color: var(--dsw-alias-label-primary); font-weight: 600;
}
.ben-wb__deck-now { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: var(--wb-t5); line-height: 1.5; }
.ben-wb__deck-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: var(--wb-t5); line-height: 1.5; }

.ben-wb__deck-run { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
/* 派活小标四档 + 「代做」。四个字各自一种底色,扫一眼就知道这件事走到哪了。 */
.ben-wb__deck-badge {
  padding: 0 6px; border-radius: 3px; font-size: var(--wb-t5);
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary);
}
.ben-wb__deck-badge[data-state="排队"] { color: var(--dsw-alias-label-tertiary); }
.ben-wb__deck-badge[data-state="在做"] { color: #7fb2ff; border-color: rgba(127, 178, 255, .45); }
.ben-wb__deck-badge[data-state="回来了"] { color: #74d69a; border-color: rgba(116, 214, 154, .45); }
.ben-wb__deck-badge[data-state="失败"] { color: #ff8a8a; border-color: rgba(255, 138, 138, .5); }
.ben-wb__deck-badge[data-state="代做"] { color: #e6c179; border-color: rgba(230, 193, 121, .5); }

.ben-wb .ben-wb__deck-note {
  width: 100%; padding: 3px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: var(--wb-t5);
}
.ben-wb__deck-said { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--wb-t5); line-height: 1.5; }

/* 七个页签横着排,窄格里可以横滚 —— 一个都不许因为放不下而消失。 */
.ben-wb__deck-tabs { display: flex; gap: 3px; overflow-x: auto; padding-bottom: 2px; }
.ben-wb .ben-wb__deck-tabs button {
  flex: none; padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: var(--wb-t5); cursor: pointer; white-space: nowrap;
}
/* 还没有这一份 = 虚线边:她一眼看得出哪几段还没做,不必逐个点开。 */
.ben-wb .ben-wb__deck-tabs button[data-has="false"] { border-style: dashed; opacity: .7; }
.ben-wb .ben-wb__deck-tabs button[data-on="true"] {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 600;
}

.ben-wb__deck-doc { display: flex; flex-direction: column; gap: 4px; }
.ben-wb__deck-file { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: var(--wb-t5); overflow-wrap: anywhere; }
.ben-wb .ben-wb__deck-text {
  width: 100%; min-height: 120px; resize: vertical;
  padding: 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: var(--wb-t5); line-height: 1.6;
}
.ben-wb__deck-acts { display: flex; gap: 4px; }
.ben-wb .ben-wb__deck-acts button {
  padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--wb-t5); cursor: pointer;
}
.ben-wb .ben-wb__deck-acts button:disabled { opacity: .5; cursor: default; }

/* 段落级 diff:增绿删红,没变的压暗 —— 位置对得上才读得懂。 */
.ben-wb__deck-diff { font-size: var(--wb-t5); }
.ben-wb__deck-diff summary { cursor: pointer; color: var(--dsw-alias-label-tertiary); }
.ben-wb__deck-diff ul { margin: 4px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.ben-wb__deck-diff li { line-height: 1.6; overflow-wrap: anywhere; color: var(--dsw-alias-label-tertiary); }
.ben-wb__deck-diff li[data-kind="add"] { color: #74d69a; }
.ben-wb__deck-diff li[data-kind="del"] { color: #ff8a8a; text-decoration: line-through; }

.ben-wb__deck-judge { display: flex; gap: 4px; flex-wrap: wrap; }
.ben-wb .ben-wb__deck-judge .ben-wb__chip[data-judge="pass"] { color: #74d69a; }
.ben-wb .ben-wb__deck-judge .ben-wb__chip[data-judge="revise"] { color: #e6c179; }
.ben-wb__deck-revise { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.ben-wb .ben-wb__deck-revise input {
  flex: 1 1 160px; padding: 3px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: var(--wb-t5);
}
.ben-wb .ben-wb__deck-revise button {
  padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--wb-t5); cursor: pointer;
}
.ben-wb__deck-lastsaid { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: var(--wb-t5); line-height: 1.5; }

/* 「在场 / 收起」那四块。收起不是删掉 —— summary 一直看得见。 */
.ben-wb__deck-sec { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 4px; font-size: var(--wb-t5); }
.ben-wb__deck-sec summary { cursor: pointer; color: var(--dsw-alias-label-secondary); }
.ben-wb__deck-sec[open] summary { color: var(--dsw-alias-label-primary); font-weight: 600; }

/* 看板上那张卡的派活四档小标(TaskCard)。与上面那一份同色同形,不另造一套词。 */
.ben-wb__task-runstate {
  padding: 0 5px; border-radius: 3px; font-size: var(--wb-t5);
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary);
}
.ben-wb__task-runstate[data-state="在做"] { color: #7fb2ff; border-color: rgba(127, 178, 255, .45); }
.ben-wb__task-runstate[data-state="回来了"] { color: #74d69a; border-color: rgba(116, 214, 154, .45); }
.ben-wb__task-runstate[data-state="失败"] { color: #ff8a8a; border-color: rgba(255, 138, 138, .5); }

/* ── 需求卡指挥台(2026-09-22)──
   **共用上面整套 ben-wb__deck 那一套**,只多两条:它长在功能点弹窗里(不是那一格里),
   所以上边要一道分隔;「写进决策记录」那一颗单独一行,免得跟「推进一步」挤在一起被误点。
   不另开一个样式文件:两种卡上的同一块东西该长得一模一样,分两份迟早会漂。 */
.ben-wb__deck--feature {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  padding: 8px; margin-bottom: 8px;
}
.ben-wb__deck-record { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
/* 派出去那几件的结果(2026-09-23,断点 B):一件一行,成的绿、没成的红。
   点标题展开全文 —— 全文是那份 .md 的原文,所以用 pre,不重排。 */
.ben-wb__deck-results li[data-ok="no"] .ben-wb__topics-filename { color: var(--dsw-alias-label-error, #c0392b); }
.ben-wb__deck-results li[data-ok="yes"] .ben-wb__topics-filename { color: var(--dsw-alias-label-secondary); }
.ben-wb__deck-results .ben-wb__topics-filename {
  background: none; border: 0; padding: 0; cursor: pointer; text-align: left; font: inherit;
}
.ben-wb__deck-resulttext {
  margin: 4px 0 0; padding: 6px; max-height: 240px; overflow: auto;
  background: var(--dsw-alias-bg-l2); border-radius: 4px;
  font-size: var(--wb-t5); white-space: pre-wrap; word-break: break-word;
}
/* 「改自己」那八步:走到哪了一眼看得出来,停在哪一步把原话摊在底下。 */
.ben-wb__deck-self { flex-direction: column; align-items: stretch; }
.ben-wb__deck-steps { margin: 6px 0 0; padding-left: 18px; font-size: var(--wb-t5); }
.ben-wb__deck-steps li[data-status="ok"] { color: var(--dsw-alias-label-secondary); }
.ben-wb__deck-steps li[data-status="failed"] { color: var(--dsw-alias-label-error, #c0392b); font-weight: 600; }
.ben-wb__deck-steps li[data-status="pending"] { color: var(--dsw-alias-label-tertiary); }
/* 建卡那一行:输入框一行、「当需求办」那个勾跟在下面。小字,不抢记一条那一格的位置。 */
.ben-wb__board-newrow { display: flex; flex-direction: column; gap: 2px; }
.ben-wb__board-new-kind {
  display: inline-flex; align-items: center; gap: 3px;
  color: var(--dsw-alias-label-tertiary); font-size: var(--wb-t5); cursor: pointer;
}
`
