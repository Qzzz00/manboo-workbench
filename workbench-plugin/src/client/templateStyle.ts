/**
 * 布局模板带来的那几块新样式(2026-09-21)。
 *
 * 独占 `ben-wb__topics* / __pub* / __review* / __assets* / __tpl*` 前缀、单独一个文件,
 * 理由同 devToolStyle.ts / sceneMenuStyle.ts:`style.ts` 那一千多行的模板串是
 * 多张卡同时在改的地方,新样式塞进去必冲突。
 *
 * 视觉一条不破:全用既有的 `--dsw-alias-*` 变量与 `--wb-t*` 字号档,一个新颜色都没引
 * (黑白微光那一套不动)。三格的排布规矩都一样 —— 头部固定,内容 `flex:1 + min-height:0`
 * 自己滚,不往下长把格子撑破(同系统文件夹那一格 2026-09-09 的教训)。
 */
export const TEMPLATE_STYLE = `
/* ── 选题池:六段一列 + 末尾「其它事项」,看不完往右推(2026-09-21)── */
.ben-wb__topics{display:flex;flex-direction:column;min-height:0}
.ben-wb__topics-bar{flex:none;display:flex;align-items:center;gap:6px;justify-content:flex-end;padding:2px 0 4px}
.ben-wb .ben-wb__topics-new{padding:2px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb .ben-wb__topics-new:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__topics-form{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:6px;margin-bottom:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.ben-wb__topics-form .ben-wb__inp{flex:1 1 140px;min-width:0}
.ben-wb__topics-form label{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
.ben-wb__topics-form input[type="date"]{padding:2px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t5)}
.ben-wb__topics-form select{padding:2px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t5)}
.ben-wb .ben-wb__topics-form button{flex:none;padding:2px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb__topics-scroll{flex:1 1 0;min-height:0;display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;padding-bottom:4px}
.ben-wb__topics-col{flex:0 0 164px;display:flex;flex-direction:column;min-height:0;gap:4px;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.ben-wb__topics-colname{display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t5)}
.ben-wb__topics-colname b{flex:none;padding:0 5px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-weight:400}
.ben-wb__topics-list{flex:1 1 0;min-height:0;overflow-y:auto;margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.ben-wb__topics-card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
/* 不是选题的那些(「其它事项」那一列)描虚线:一眼看出它们不是一条选题。 */
.ben-wb__topics-card[data-topic="false"]{border-style:dashed}
.ben-wb .ben-wb__topics-head{display:flex;flex-direction:column;gap:3px;width:100%;padding:5px 7px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t5);line-height:1.4;cursor:pointer;text-align:left}
.ben-wb .ben-wb__topics-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb__topics-title{display:block;word-break:break-word}
.ben-wb__topics-tags{display:flex;flex-wrap:wrap;gap:3px}
.ben-wb__topics-tag{padding:0 5px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t6,11px);line-height:1.5}
.ben-wb__topics-tag[data-kind="priority"]{border:1px solid var(--dsw-alias-border-l2);background:transparent}
.ben-wb__topics-body{display:flex;flex-direction:column;gap:4px;padding:0 7px 6px;border-top:1px solid var(--dsw-alias-border-l1)}
.ben-wb__topics-dates{display:flex;flex-wrap:wrap;gap:6px}
.ben-wb__topics-dates label{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t6,11px)}
.ben-wb__topics-dates input{min-width:0;padding:1px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t6,11px)}
.ben-wb__topics-desc,.ben-wb__topics-flow,.ben-wb__topics-due,.ben-wb__topics-nofiles,.ben-wb__topics-err{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t6,11px);line-height:1.5}
.ben-wb__topics-acts{display:flex;flex-wrap:wrap;gap:4px}
.ben-wb .ben-wb__topics-acts button{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t6,11px);cursor:pointer}
.ben-wb .ben-wb__topics-acts button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb .ben-wb__topics-acts button:disabled{opacity:.45;cursor:default}
/* ── 「拆解这条」那一小块(2026-09-22 采集类)。一个新颜色都没引,全走既有的别名 ── */
.ben-wb__topics-tear{display:flex;flex-direction:column;gap:4px;margin-top:6px;padding:6px;border:1px dashed var(--dsw-alias-border-l1);border-radius:6px}
.ben-wb .ben-wb__topics-tearin{width:100%;box-sizing:border-box;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t6,11px)}
.ben-wb .ben-wb__topics-tear button{align-self:flex-start;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t6,11px);cursor:pointer}
.ben-wb .ben-wb__topics-tear button:disabled{opacity:.45;cursor:default}
.ben-wb__topics-files{margin:0;padding:0;list-style:none;max-height:120px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.ben-wb__topics-files li{display:flex;justify-content:space-between;gap:6px;font-size:var(--wb-t6,11px);color:var(--dsw-alias-label-secondary)}
.ben-wb__topics-filename{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__topics-filefrom{flex:none;color:var(--dsw-alias-label-tertiary)}
/* 八环节那一行流程说明:贴在这一格最底下,一行,看不完就省略号。 */
.ben-wb__topics-hint{flex:none;margin:4px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t6,11px)}

/* ── 发布计划:月历。7 列,格子自己等分剩下的高度 ── */
.ben-wb__pub{position:relative;display:flex;flex-direction:column;min-height:0}
/* 两个状态那一行(2026-09-22)。未发布在前、默认亮着;一个新颜色都没引,亮暗全走既有别名。 */
.ben-wb__pub-views{flex:none;display:flex;gap:0;padding-top:2px}
.ben-wb .ben-wb__pub-views button{padding:2px 10px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb .ben-wb__pub-views button:first-child{border-radius:6px 0 0 6px}
.ben-wb .ben-wb__pub-views button:last-child{border-radius:0 6px 6px 0;border-left:0}
.ben-wb .ben-wb__pub-views button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 亮着的那一个照抄项目区「总览 / 看板」那颗开关的别名(ben-wb__viewswitch):
   同一台工作台上"此刻是哪一个"只该有一种长相,而且**一个新颜色都没引**。 */
.ben-wb .ben-wb__pub-views button[data-on="true"]{background:var(--dsw-alias-state-business-tertiary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);font-weight:600}
.ben-wb__pub-bar{flex:none;display:flex;align-items:center;gap:6px;padding:4px 0}
.ben-wb .ben-wb__pub-bar button{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb .ben-wb__pub-bar button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb__pub-month{flex:1 1 auto;color:var(--dsw-alias-label-primary);font-size:var(--wb-t5)}
.ben-wb__pub-hint{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
.ben-wb__pub-week{flex:none;display:grid;grid-template-columns:repeat(7,1fr);gap:2px;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t6,11px);text-align:center}
.ben-wb__pub-grid{flex:1 1 0;min-height:0;display:grid;grid-template-columns:repeat(7,1fr);grid-auto-rows:1fr;gap:2px;overflow:hidden}
.ben-wb .ben-wb__pub-day{display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-width:0;min-height:0;overflow:hidden;padding:2px 3px;border:1px solid transparent;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t6,11px);line-height:1.2;cursor:pointer;text-align:left}
.ben-wb .ben-wb__pub-day:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ben-wb .ben-wb__pub-day[data-out="true"]{opacity:.38}
/* 今天(2026-09-28,卡 FB:「发布计划那里没有标记今天是哪一天,这个不方便」)。
   原来只把描边换成 border-l2 —— 那根线跟没选中的格子几乎一样,等于没标。现在**描边 + 日期加粗**:
   这一套是黑白微光,没有红色可用,"只用颜色说话"的标记在这里等于没说(同逾期那一格的理由)。
   一格只有二十几像素高,所以不加角标、不占一行,只让那个数字自己变粗。
   两套模板(做产品 / 自媒体运营)共用这一份样式,所以改这一处两边一起生效。 */
.ben-wb .ben-wb__pub-day[data-today="true"]{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}
.ben-wb .ben-wb__pub-day[data-picked="true"]{border-color:var(--dsw-alias-label-secondary)}
.ben-wb__pub-line{display:flex;align-items:center;gap:3px;max-width:100%}
.ben-wb__pub-num{flex:none;color:var(--dsw-alias-label-primary)}
.ben-wb__pub-num[data-today="true"]{font-weight:700}
.ben-wb__pub-count{flex:none;padding:0 4px;border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
/* 逾期:今天之前还没发的那几天。**写字不只靠颜色** —— 这一格是黑白微光,没有红色可用,
   而"只用颜色说话"的标记在这套配色里等于没说。 */
.ben-wb .ben-wb__pub-day[data-overdue="true"]{border-style:dashed;border-color:var(--dsw-alias-label-secondary)}
.ben-wb__pub-late{flex:none;padding:0 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary)}
.ben-wb__pub-list{flex:none;max-height:88px;overflow-y:auto;margin:4px 0 0;padding:0 0 0 14px;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t6,11px);line-height:1.6}
.ben-wb__pub-first{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.ben-wb__pub-new{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding-top:4px}
.ben-wb__pub-new label{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
.ben-wb__pub-new select{padding:2px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--wb-t5)}
.ben-wb__pub-new .ben-wb__inp{flex:1 1 auto;min-width:0}
.ben-wb .ben-wb__pub-new button{flex:none;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t5);cursor:pointer}

/* ── 数据复盘(2026-09-21 接上小红书自取)── */
.ben-wb__review{display:flex;flex-direction:column;min-height:0;overflow-y:auto}
.ben-wb__review-bar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px}
.ben-wb__review-acts{flex:none;display:flex;gap:6px}
.ben-wb .ben-wb__review-acts button{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb .ben-wb__review-acts button:disabled{opacity:.5;cursor:default}
.ben-wb__review-range{flex:none;display:flex;gap:6px;padding:4px 0}
.ben-wb .ben-wb__review-range button{padding:2px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb .ben-wb__review-range button[data-on="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.ben-wb__review-note{flex:none;margin:2px 0 6px;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5);line-height:1.6}
/* 指标名字**灰着列**,一个数字都不写 —— 见 ReviewModule.tsx 顶上那段。 */
.ben-wb__review-metrics{flex:1 1 0;min-height:0;overflow-y:auto;margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:4px 6px;align-content:flex-start}
.ben-wb__review-metrics li{padding:2px 8px;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
/* 接上之后的八格。**取不到的那一格不画大数字**,只有一句「后台没有这项」。 */
.ben-wb__review-grid{flex:none;margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.ben-wb__review-cell{display:flex;flex-direction:column;gap:1px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;min-width:0}
.ben-wb__review-cell[data-missing="true"]{border-style:dashed}
.ben-wb__review-cell-name{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5)}
.ben-wb__review-cell-num{color:var(--dsw-alias-label-primary);font-size:var(--wb-t3);font-variant-numeric:tabular-nums}
.ben-wb__review-cell-none{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5);font-style:italic}
.ben-wb__review-cell-delta{display:flex;flex-wrap:wrap;gap:0 4px;font-size:var(--wb-t6,var(--wb-t5));color:var(--dsw-alias-label-tertiary)}
.ben-wb__review-cell-delta[data-dir="up"]{color:var(--dsw-alias-label-secondary)}
.ben-wb__review-cell-delta[data-dir="down"]{color:var(--dsw-alias-label-secondary)}
.ben-wb__review-cell-since{opacity:.75}
.ben-wb__review-cell-derived{align-self:flex-start;padding:0 4px;border-radius:4px;background:var(--dsw-alias-fill-l1,rgba(127,127,127,.12));font-size:var(--wb-t6,var(--wb-t5));color:var(--dsw-alias-label-tertiary)}
.ben-wb__review-cell-why{font-size:var(--wb-t6,var(--wb-t5));color:var(--dsw-alias-label-tertiary);line-height:1.35}
/* 多账号(2026-09-22):每个账号一行 + 合计一行。两个以上账号才出现。 */
.ben-wb__review-accounts{flex:none;width:100%;margin-top:6px;border-collapse:collapse;font-size:var(--wb-t5);table-layout:fixed}
.ben-wb__review-accounts caption{caption-side:top;text-align:left;padding-bottom:3px;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t6,var(--wb-t5))}
.ben-wb__review-accounts th,.ben-wb__review-accounts td{padding:3px 4px;text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-wb__review-accounts thead th{color:var(--dsw-alias-label-tertiary);font-weight:400}
.ben-wb__review-accounts tbody th{text-align:left;color:var(--dsw-alias-label-primary);font-weight:600}
.ben-wb__review-accounts tbody tr[data-total="true"] th,.ben-wb__review-accounts tbody tr[data-total="true"] td{border-top:1px solid var(--dsw-alias-border-l1);font-weight:600}
.ben-wb__review-acc-num{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.ben-wb__review-acc-none{color:var(--dsw-alias-label-tertiary);font-style:italic}
.ben-wb__review-acc-derived,.ben-wb__review-acc-dir,.ben-wb__review-acc-off{margin-left:4px;font-style:normal;font-weight:400;font-size:var(--wb-t6,var(--wb-t5));color:var(--dsw-alias-label-tertiary)}
.ben-wb__review-total-note{font-size:var(--wb-t6,var(--wb-t5))}
/* 事务官的建议:每条底下贴着一行代码算出来的依据。 */
.ben-wb__review-advice{flex:none;margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1)}
.ben-wb__review-advice h3{margin:0 0 4px;font-size:var(--wb-t5);color:var(--dsw-alias-label-secondary);font-weight:600}
.ben-wb__review-advice ol{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:4px}
.ben-wb__review-advice li{font-size:var(--wb-t5);color:var(--dsw-alias-label-secondary)}
.ben-wb__review-advice-text{display:block}
.ben-wb__review-advice-basis{display:block;color:var(--dsw-alias-label-tertiary);opacity:.85}
/* 自取记录:每一次自动动作都看得见(PRD §9)。 */
.ben-wb__review-log{flex:none;margin-top:6px}
.ben-wb .ben-wb__review-log button{padding:1px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb__review-log ul{margin:4px 0 0;padding:0;list-style:none;max-height:96px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.ben-wb__review-log li{font-size:var(--wb-t5);color:var(--dsw-alias-label-tertiary)}
.ben-wb__review-log li[data-ok="false"]{opacity:.9;text-decoration:none}
.ben-wb__review-peek{margin:4px 0 0;font-size:var(--wb-t5);color:var(--dsw-alias-label-tertiary);word-break:break-all}

/* ── 折线图(2026-09-21)。三条线 = 三张小图,各有自己的纵向范围 ──
   一个新颜色都没引:线走 label-secondary,点走 label-primary,轴线走 border-l1。
   横向 preserveAspectRatio="none" 拉满,所以每一条描边都挂 vector-effect:non-scaling-stroke
   (CSS 里再兜一次,属性与样式表哪一头被改掉都还剩一道)。 */
.ben-wb__trend{flex:none;margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1)}
.ben-wb__trend-basis{margin:0 0 4px;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5);line-height:1.5}
.ben-wb__trend-rows{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}
.ben-wb__trend-row{display:flex;flex-direction:column;gap:1px;min-width:0}
.ben-wb__trend-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.ben-wb__trend-name{color:var(--dsw-alias-label-secondary);font-size:var(--wb-t5)}
.ben-wb__trend-last{color:var(--dsw-alias-label-primary);font-size:var(--wb-t4,13px);font-variant-numeric:tabular-nums}
.ben-wb__trend-none{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5);font-style:italic}
.ben-wb__trend-plot{display:flex;align-items:stretch;gap:6px;min-width:0}
.ben-wb__trend-svg{flex:1 1 0;min-width:0;height:40px;overflow:visible}
.ben-wb__trend-svg path{vector-effect:non-scaling-stroke;fill:none}
.ben-wb__trend-axis{stroke:var(--dsw-alias-border-l1);stroke-width:1}
.ben-wb__trend-line{stroke:var(--dsw-alias-label-secondary);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;fill:none}
.ben-wb__trend-dot{stroke:var(--dsw-alias-label-primary);stroke-width:5;stroke-linecap:round}
/* 看不见但接得住鼠标的靶子(12px 圆头),原生 <title> 提示挂在它上面。 */
.ben-wb__trend-hit{stroke:transparent;stroke-width:12;stroke-linecap:round}
.ben-wb__trend-edge{flex:none;display:flex;flex-direction:column;justify-content:space-between;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t6,11px);font-variant-numeric:tabular-nums}
.ben-wb__trend-from{color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t6,11px);opacity:.85}
.ben-wb__trend-axis-labels{display:flex;justify-content:space-between;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t6,11px)}

/* ── 素材管理那一行文件夹按钮(贴在模式条下面)── */
.ben-wb__assets{flex:none;display:flex;flex-wrap:wrap;gap:4px;padding:2px 0 4px}
.ben-wb .ben-wb__assets-btn{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb .ben-wb__assets-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 第八格「收藏网址」是个**文件**,不是文件夹:虚线边把它跟前面七颗分开,点法也不一样
   (文件夹是把 Finder 领过去,文件是在 Finder 里选中它)。同样不引新颜色。 */
.ben-wb .ben-wb__assets-btn[data-kind="file"]{border-style:dashed}

/* ── 设置里的「模板」两张卡片 ── */
.ben-wb__tpl{display:flex;flex-direction:column;gap:8px}
.ben-wb__tpl-cards{display:flex;flex-wrap:wrap;gap:8px}
.ben-wb__tpl-card{flex:1 1 220px;display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.ben-wb__tpl-card[data-current="true"]{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}
.ben-wb__tpl-name{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:var(--wb-t4,13px)}
.ben-wb__tpl-now{padding:0 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t6,11px)}
.ben-wb__tpl-line{margin:0;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5);line-height:1.5}
.ben-wb__tpl-acts{display:flex;gap:6px;margin-top:2px}
.ben-wb .ben-wb__tpl-acts button{padding:3px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--wb-t5);cursor:pointer}
.ben-wb .ben-wb__tpl-acts button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ben-wb .ben-wb__tpl-acts button:disabled{opacity:.45;cursor:default}
.ben-wb__tpl-confirm{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:var(--wb-t5);line-height:1.6}
.ben-wb__tpl-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:var(--wb-t5);line-height:1.6}
/* 「运营技能:已接上 n 条」那一行(2026-09-22,卡 ①)。一个新颜色都没引;
   没接上时描虚线 —— 黑白微光里**只靠颜色说话等于没说**(同上面逾期那一格的理由)。 */
.ben-wb__tpl-skills{display:flex;flex-direction:column;gap:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.ben-wb__tpl-skills[data-ok="false"]{padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px}
`
