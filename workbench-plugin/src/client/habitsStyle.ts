/**
 * 设置里「它学到了什么」那一节的样式(2026-10-09,`HabitsPanel.tsx`)。
 *
 * 独占 `ben-wb__habit*` 前缀、单独一个文件,理由同 promptsStyle.ts:`style.ts` 常被几张卡同时改着。
 * 三段并排(正在试用 / 已经留下 / 撤掉的),窄了就叠成一列;颜色只用灰阶细线,沿用黑底白字。
 */
export const HABITS_STYLE = `
.ben-wb__habits .ben-wb__habits-cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin: 8px 0;
}
.ben-wb__habits .ben-wb__habits-col {
  border-top: 1px solid var(--dsw-alias-border-l2);
  padding-top: 6px;
  min-width: 0;
}
.ben-wb__habits .ben-wb__habits-h {
  margin: 0 0 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.ben-wb__habits .ben-wb__habit {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 0;
  border-top: 1px solid var(--dsw-alias-border-l2);
  font-size: 12px;
}
.ben-wb__habits .ben-wb__habit .ben-wb__module-row-name { font-weight: 600; }
.ben-wb__habits .ben-wb__habit-kind {
  align-self: flex-start;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.ben-wb__habits .ben-wb__habit[data-habit-status=reverted],
.ben-wb__habits .ben-wb__habit[data-habit-status=removed] { opacity: .65; }
.ben-wb__habits .ben-wb__habit-why,
.ben-wb__habits .ben-wb__habit-log {
  margin: 0;
  padding-left: 14px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 1.55;
}
.ben-wb__habits .ben-wb__habit-log li { display: flex; flex-direction: column; padding: 2px 0; }
.ben-wb__habits .ben-wb__habit-acts { display: flex; flex-wrap: wrap; gap: 8px; }
`
