/**
 * 设置里「事务官的提示词」那一节的样式(2026-10-01,卡「设置里集中改提示词」)。
 *
 * 独占 `ben-wb__prompt*` 前缀、单独一个文件,理由同 layoutAskStyle.ts / templateStyle.ts:
 * `style.ts` 与 `customModuleStyle.ts` 这一版同时被好几张卡改着,塞进去必冲突。
 *
 * 为什么不直接用 `.ben-wb__module-row`:那一条是**单行 flex**(名字 + 一句说明 + 一颗按钮),
 * 而这一节一段里有全文、输入框、三四颗按钮 —— 挤在一行上会把全文压成一条看不见的细缝。
 * 这里把它改成竖排 + 按钮一行能换行,全文与输入框各占满一行。
 */
export const PROMPTS_STYLE = `
.ben-wb__prompts .ben-wb__prompt {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  padding: 8px 0;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.ben-wb__prompts .ben-wb__prompt .ben-wb__module-row-name { font-weight: 600; }
.ben-wb__prompts .ben-wb__prompt pre {
  margin: 4px 0;
  padding: 8px 10px;
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.ben-wb__prompts .ben-wb__prompt textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  resize: vertical;
}
/* 按钮横排、挤不下就换行(一段最多四颗:改 / 保存 / 恢复默认 / 撤到上一版)。 */
.ben-wb__prompts .ben-wb__prompt .ben-wb__set-lnk { align-self: flex-start; }

/* 页底「工作台怎么干活(只读)」展开之后那一摊:缩进一格,和上面人话那几项分得开(2026-10-02)。 */
.ben-wb__prompts .ben-wb__prompt-manual-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 0 6px 12px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  margin-top: 6px;
}
/* 「你各个环节的偏好」那一行小标题。 */
.ben-wb__prompts h3 { margin: 12px 0 0; font-size: 12.5px; }
`
