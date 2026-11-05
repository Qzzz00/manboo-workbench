/**
 * 「我把 X 挪到 Y,对吗?」那张确认卡的样式(2026-09-22「用自然语言改布局」)。
 *
 * 独占 `ben-wb__layoutask*` 前缀、单独一个文件,理由同 devToolStyle.ts / templateStyle.ts:
 * `style.ts` 与 `customModuleStyle.ts` 这一版同时被好几张卡改着,塞进去必冲突。
 *
 * **长得跟小工具那张确认卡一样**(虚线框、同样的圆角内边距、同样的两颗按钮):它们是
 * 同一件事的两个客户 —— 事务官替他动他的东西之前先把自己的理解说一遍。两张卡长得不一样,
 * 他就要在两处各学一套。颜色数值是从 `.ben-wb__devtool-ask` 逐字抄过来的,不是另调的一套。
 */
export const LAYOUT_ASK_STYLE = `
.ben-wb__layoutask {
  border: 1px dashed rgba(150, 170, 200, 0.45);
  border-radius: 10px;
  padding: 10px 12px;
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.ben-wb__layoutask-head { color: rgba(200, 210, 225, 0.75); }
.ben-wb__layoutask-say {
  color: rgba(235, 240, 248, 0.95);
  line-height: 1.5;
  white-space: pre-wrap;
}
.ben-wb__layoutask-note { color: rgba(170, 178, 190, 0.7); }
.ben-wb__layoutask-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ben-wb__layoutask-err { color: rgba(238, 150, 140, 0.95); }
`
