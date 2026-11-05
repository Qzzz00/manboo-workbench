/**
 * 自定义模块那一档的样式(2026-09-21)。
 *
 * **独占前缀 `ben-wb__module-*`、单独一个文件**:`style.ts` 这一版同时被另外三张卡改着
 * (`feat/xhs-metrics`、`feat/ops-accounts`、`feat/channel-key-from-server`),塞进去必冲突
 * —— 同 `devToolStyle.ts` 上一张卡的处理。`style.ts` 里只多两行(import + 拼接)。
 */
export const CUSTOM_MODULE_STYLE = `
/* ── 自定义模块:窗位槽里那块 iframe(嵌法同事务官那一档) ── */
.ben-wb__module-frame {
  /* 盖在槽体上,不替换它——槽体是窗位矩形的唯一来源(CustomModuleFrame.tsx 的注释)。
     定位上下文是 .ben-wb__slot-stack,与事项收件箱那一层同级。 */
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  /* 模块页面自己会铺满;这一层给一个底色,免得它加载那一瞬间透出下面的槽体虚线框。 */
  background: #0b0d10;
  border-radius: 8px;
}

/* ── 窗位叠里那一格自定义标签 ── */
.ben-wb__module-tab {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.ben-wb__module-tab .ben-wb__dock-tab-name { display: inline-flex; align-items: center; gap: 4px; }
.ben-wb__module-tab-icon { font-size: 12px; line-height: 1; }
/* 「移除」那颗 ✕ 与应用标签的 ✕ 同一个样子——同一排里两种 ✕ 长得不一样会让人以为
   它们干的不是一件事(其实都是"把这一格拿走")。 */
.ben-wb__module-tab-close { opacity: 0.55; }
.ben-wb__module-tab-close:hover { opacity: 1; }
/* 二次确认:✕ 按下去之后原地变成一句问话,不是弹一个系统对话框——
   窗位叠上一颗标签的去留,不值得把整个界面挡住;而且 window.confirm 在壳里会顶掉焦点。 */
.ben-wb__module-tab[data-confirming="true"] {
  border-color: rgba(220, 120, 110, 0.55);
}
.ben-wb__module-tab-confirm {
  font-size: 11px;
  color: rgba(238, 170, 160, 0.95);
  background: none;
  border: 0;
  cursor: pointer;
  padding: 0 2px;
}
.ben-wb__module-tab-cancel {
  font-size: 11px;
  color: rgba(200, 204, 210, 0.7);
  background: none;
  border: 0;
  cursor: pointer;
  padding: 0 2px;
}

/* ── 事务官那边:待确认的小工具需求 ── */
.ben-wb__devtool-ask {
  border: 1px dashed rgba(150, 170, 200, 0.45);
  border-radius: 10px;
  padding: 10px 12px;
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.ben-wb__devtool-ask-head { color: rgba(200, 210, 225, 0.75); }
.ben-wb__devtool-ask-need {
  color: rgba(235, 240, 248, 0.95);
  line-height: 1.5;
  white-space: pre-wrap;
}
.ben-wb__devtool-ask-sketch { color: rgba(190, 205, 225, 0.8); line-height: 1.5; }
.ben-wb__devtool-ask-none { color: rgba(170, 178, 190, 0.7); }
.ben-wb__devtool-ask-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ben-wb__devtool-ask-name {
  flex: 1 1 120px;
  min-width: 96px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: inherit;
  font-size: 12px;
  padding: 4px 8px;
}
.ben-wb__devtool-ask-err { color: rgba(238, 150, 140, 0.95); }

/* ── 设置里「自定义模块」那一节 ── */
.ben-wb__module-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}
.ben-wb__module-row-name { flex: 1 1 auto; }
.ben-wb__module-row-note { color: rgba(170, 178, 190, 0.75); }
`
