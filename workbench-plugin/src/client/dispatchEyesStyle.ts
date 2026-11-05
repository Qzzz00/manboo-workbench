/**
 * 「派活的眼睛」那几样的样式(2026-09-25,卡 O):设置里「各家能做什么」那张表、外层那件事的卡上的花费 / 停掉 / 修法。
 *
 * 独占 `ben-wb__caps*` / `ben-wb__eyes*` 前缀、单独一个文件(理由同 layoutAskStyle.ts:style.ts 同时被好几张卡改着)。
 * 他的规矩:**不要蓝、不要卡片框、只做深色**;格子的好坏**不靠颜色**分 —— 每格先写一个字(行 / 不行 / 没有 / 没查到)。
 */
export const DISPATCH_EYES_STYLE = `
.ben-wb__caps .ben-wb__caps-lead { font-size: 12px; line-height: 1.55; margin: 4px 0; color: rgba(170, 178, 190, 0.85); }
/* 一家一块、一格一行:格名 | 一个字(行 / 不行 / 没有 / 没查到)| 那一句;提示与按钮在下一行接着那一句。 */
.ben-wb__caps-list { display: flex; flex-direction: column; gap: 10px; margin: 8px 0 4px; font-size: 12px; }
.ben-wb__caps-agent { border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 8px; }
.ben-wb__caps-agent[data-installed="false"] { opacity: 0.5; }
.ben-wb__caps-name { font-weight: 600; color: var(--dsw-alias-label-primary, #e8e6e3); margin-bottom: 4px; }
.ben-wb__caps-row { display: grid; grid-template-columns: 84px 40px minmax(0, 1fr); column-gap: 8px; row-gap: 2px; padding: 2px 0; align-items: baseline; }
.ben-wb__caps-cell { color: rgba(170, 178, 190, 0.75); }
.ben-wb__caps-mark { font-weight: 600; }
.ben-wb__caps-row[data-state="ok"] .ben-wb__caps-mark { color: rgba(214, 226, 200, 0.95); }
.ben-wb__caps-row[data-state="no"] .ben-wb__caps-mark { color: rgba(236, 190, 140, 0.95); }
.ben-wb__caps-row[data-state="na"] .ben-wb__caps-mark, .ben-wb__caps-row[data-state="unknown"] .ben-wb__caps-mark { color: rgba(170, 178, 190, 0.6); }
.ben-wb__caps-note, .ben-wb__caps-hint { line-height: 1.45; color: rgba(200, 204, 210, 0.85); overflow-wrap: anywhere; }
.ben-wb__caps-hint, .ben-wb__caps-act { grid-column: 3; }
/* 额度那一行写的是上次读到的、已经老了的那个数(2026-09-26,卡 QS):画淡;话里已经写着几点读到的。 */
.ben-wb__caps-row[data-stale="true"] .ben-wb__caps-mark, .ben-wb__caps-row[data-stale="true"] .ben-wb__caps-note { color: rgba(170, 178, 190, 0.7); }
.ben-wb__caps-hint { color: rgba(214, 206, 190, 0.85); }
.ben-wb__caps button, .ben-wb__caps input {
  margin-top: 5px; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 7px; background: rgba(255, 255, 255, 0.05);
  color: rgba(232, 230, 227, 0.92); padding: 4px 9px; font-size: 11.5px; cursor: pointer;
}
.ben-wb__caps input { width: 56px; cursor: text; margin: 0 4px; }
.ben-wb__caps button:disabled { opacity: 0.45; cursor: default; }
.ben-wb__caps-sub { font-size: 12.5px; font-weight: 550; margin: 14px 0 2px; color: var(--dsw-alias-label-primary, #e8e6e3); }
.ben-wb__caps-budget label { display: inline-flex; align-items: center; gap: 2px; color: rgba(200, 204, 210, 0.9); }

.ben-wb__eyes { margin: 8px 0 4px; display: flex; flex-direction: column; gap: 4px; }
.ben-wb__eyes p { margin: 0; }
.ben-wb__eyes-budget { color: rgba(200, 204, 210, 0.85); font-size: 11.5px; }
.ben-wb__eyes-budget[data-state="paused"] { color: rgba(236, 190, 140, 0.95); }
.ben-wb__eyes-why { color: rgba(236, 214, 190, 0.95); }
.ben-wb__eyes-hint { color: rgba(170, 178, 190, 0.8); font-size: 11px; }
.ben-wb__eyes-actions { margin-top: 2px; }

/* 球下「等你」那一堆里要他定的那一张(卡 O):一句话 + 那件事卡上的几颗键 + 看看这件。 */
.ben-wb__decide { display: flex; flex-direction: column; gap: 4px; }
.ben-wb__decide .ben-wb__eyes { margin: 2px 0 0; }

/* 派活确认点(卡 O):能派给的几家一家一行,各带额度那一格。 */
.wb-approvals__options { list-style: none; margin: 6px 0 2px; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; }
.wb-approvals__options li { display: grid; grid-template-columns: 88px minmax(0, 1fr); column-gap: 8px; color: rgba(200, 204, 210, 0.85); }
.wb-approvals__options li b { font-weight: 550; color: rgba(232, 230, 227, 0.92); }
.wb-approvals__options li span { overflow-wrap: anywhere; white-space: normal; }
.wb-approvals__options li[data-state="unconnected"] span { color: rgba(236, 214, 190, 0.9); }
.wb-approvals__options li[data-chosen="true"] b { text-decoration: underline; text-underline-offset: 3px; }
/* 上次读到的、已经老了的那个数(2026-09-26,卡 QS):这一行画淡 —— 那句话里已经写着几点读到的。 */
.wb-approvals__options li[data-stale="true"] span { color: rgba(170, 178, 190, 0.7); }

/* 额度那一格写的是**上次读到的那个数**(卡 QS):数与名字都画淡,但不用「没接上」那一套颜色 ——
   它是有数的,只是旧了;「昨晚 20:42 读到的」那一行摊在明面上(QuotaPanel 不把它折进「说明」里)。 */
.ben-wb .ben-wb__usage-q[data-stale="true"] .ben-wb__usage-qval { color: rgba(170, 178, 190, 0.8); }
.ben-wb .ben-wb__usage-q[data-stale="true"] .ben-wb__usage-qname { color: rgba(200, 204, 210, 0.75); }
.ben-wb .ben-wb__usage-q .ben-wb__usage-qnote[data-kept="true"] { grid-column: 2 / -1; margin: 3px 0 0; font-size: 11px; line-height: 1.5; color: rgba(200, 204, 210, 0.8); }
.ben-wb .ben-wb__usage-q[data-stale="true"] .ben-wb__usage-qnote[data-kept="true"] { color: rgba(214, 206, 190, 0.85); }

/* 额度区里老四格之外的那几家(卡 O;★2026-09-26 卡 QU 整份改成老四格那一副骨架 —— 维护者:「他们的样式,
   和上面的 3 家可以说完全不一样,只有文字…你能不能统一一下」)。

   骨架的类名现在与老四格逐字相同(名字 | 横条 | ▸ 说明,见 AgentQuotaCells.tsx),样式因此自动就是一套,
   **老四格那边一个字节没动**。下面只剩老四格没有的三件事:
   ① 状态行(修法那句、点完按钮那句 role=status)与按钮跟说明同一栏起,不让格子网格把它们挤到第 3 栏去;
   ② 右端那个字可能是「2,690 积分」「没接上」这类长字 —— 老四格那 36px 一栏是给「62%」的,这里给 auto、不折行;
   ③ 「不限」的整条实心画淡、「没接上」的轨道画空心。**③ 只是锦上添花**:三格分辨靠右端那个字,不靠颜色
      (同这个文件头上那条老规矩:每格先写一个字)。 */
.ben-wb .ben-wb__usage-q.ben-wb__agentq > .ben-wb__agentq-hint,
.ben-wb .ben-wb__usage-q.ben-wb__agentq > .ben-wb__agentq-actions { grid-column: 2 / -1; }
.ben-wb .ben-wb__agentq .ben-wb__usage-qbar { grid-template-columns: 34px minmax(16px, 1fr) auto; }
.ben-wb .ben-wb__agentq .ben-wb__usage-qpct { min-width: 36px; white-space: nowrap; }
.ben-wb .ben-wb__agentq .ben-wb__usage-qpct[data-level="warn"] { color: var(--dsw-alias-state-warn-label); }
.ben-wb .ben-wb__agentq .ben-wb__usage-qpct[data-level="danger"] { color: var(--dsw-alias-state-error-primary); }
.ben-wb .ben-wb__agentq[data-state="unconnected"] .ben-wb__usage-qpct { color: rgba(236, 214, 190, 0.95); }
/* 不限:有额度,但没有分母可填 —— 整条实心、淡,不去冒充一个「满」。 */
.ben-wb .ben-wb__agentq .ben-wb__usage-qtrack i[data-fill="full"] { opacity: 0.45; }
/* 没接上:只画轨道,空心一道边。积分那种(data-fill=open)留素轨道 —— 它有真数字,只是没有分母可填。 */
.ben-wb .ben-wb__agentq .ben-wb__usage-qtrack[data-fill="none"] {
  background: transparent; box-shadow: inset 0 0 0 1px var(--wb-surface-edge, rgba(255, 255, 255, 0.18));
}
.ben-wb__agentq-hint { font-size: 11px; line-height: 1.5; color: rgba(214, 206, 190, 0.85); margin: 4px 0 0; overflow-wrap: anywhere; }
.ben-wb__agentq-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; }
.ben-wb__agentq-actions button {
  border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 7px; background: rgba(255, 255, 255, 0.05);
  color: rgba(232, 230, 227, 0.92); padding: 3px 9px; font-size: 11.5px; cursor: pointer;
}
.ben-wb__agentq-actions button:disabled { opacity: 0.45; cursor: default; }
`
