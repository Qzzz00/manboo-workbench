/**
 * 协作区的样式(2026-10-21,视觉 A:`docs/设计-协作区视觉-A-2026-10-21.md`「阅读尺寸与令牌」「类型、状态与动作」)。
 * 独占 `ben-cl` 前缀。颜色、字体、圆角、发丝线都指向工作台那一套令牌(`../tokens.ts`,暗亮由 `<html data-theme>` 切),
 * 这里不再自带色值;`--cl-*` 只是协作区里的短名。
 *
 * - 黑白灰为主;**颜色只给事项类型**(会议杏 / 研发蓝 / 内容绿 / 例行灰,卡片浅底深字)与人的光标、Agent 小鼠标;
 * - 便签与目标区无常驻边框,靠明度与留白分区;拖入目标时临时 1px 轮廓;发丝线 0.7;
 * - 圆角:章 4、字段 / 按钮 6、时间卡 7、便签 10、目标 12、对话 14;
 * - 字号按表:正文 12.5、便签标题 13.5、时间卡标题 12.5、分组标题 14、页标题 15、详情标题 18、辅助 11–12、来源 10.5。
 * React Flow 自带的基础样式原样放在最前面(`xyflowCss.ts`)。
 */
import { XYFLOW_BASE_CSS } from './xyflowCss.ts'
import { OCC_COLUMN_LANE_PX, OCC_LINE_PX, OCC_SUBROW_PX, OCC_TEXT_MIN_PX } from './occupancyModel.ts'

export const COLLAB_Z = {
  canvas: 1,
  timelineCard: 1,
  timelineCardHover: 4,
  nowLine: 3,
  bubble: 8,
  receipt: 11,
  footPop: 9,
  // 名片浮列必须在对话框遮罩(10)之下——评审页原型的遮罩就是 10,浮列盖在对话框上
  // 是被点名的缺陷(换头像右半边被压住);宽屏常显那条不能靠"打开对话框时收起"兜底,
  // 层级上先压下去,收起是第二道。
  floatingRail: 5,
  filterPop: 20,
  stampMenu: 30,
  // 遮罩层级钉评审页原型的 10(tests/client-mono-ui-20261022 逐字断言),不跟着别的浮层抬。
  dialogVeil: 10,
} as const

export const COLLAB_STYLE = `
${XYFLOW_BASE_CSS}
.ben-cl{
  --cl-paper:var(--wb-paper); --cl-canvas:var(--wb-canvas); --cl-area:var(--wb-area); --cl-note:var(--wb-pop); --cl-field:var(--wb-field);
  --cl-fg:var(--wb-ink); --cl-fg2:var(--wb-sub); --cl-fg3:var(--wb-faint); --cl-line:var(--wb-line);
  --cl-card-fg:var(--wb-card-ink); --cl-card-fg2:var(--wb-card-sub);
  --t-meeting:var(--wb-type-meeting); --t-dev:var(--wb-type-dev); --t-content:var(--wb-type-content); --t-routine:var(--wb-type-routine); --t-none:var(--wb-type-routine);
  --cl-acc:var(--wb-ink);
  --cl-font:var(--wb-font);
  position:absolute; inset:0; z-index:3; display:flex; flex-direction:column; min-height:0; container-type:inline-size;
  background:var(--cl-paper); color:var(--cl-fg); font:400 12.5px/18.125px var(--cl-font);
}
.ben-cl[data-visible=false]{display:none}
.ben-cl [hidden]{display:none!important}
.ben-cl__context-controls{display:flex;flex-wrap:wrap;gap:2px 8px;padding:5px 12px;flex:none;border-bottom:var(--wb-hair) solid var(--cl-line)}
.ben-cl__context-controls button{font-size:11px;min-height:28px;max-width:100%;overflow-wrap:anywhere}
.ben-cl__context-controls button[aria-expanded=true]{background:var(--cl-field)}
.ben-cl__context-details{flex:none;max-height:32%;overflow:auto;overflow-anchor:none}
.ben-cl__context-details .ben-cl__toolbar{flex-wrap:wrap;gap:6px 12px}
.ben-cl__fixed-goal select{max-width:min(340px,48cqw)}
.ben-cl__fixed-goal>div{max-height:16vh;overflow:auto}
.ben-cl__reading{overflow-anchor:none}

.ben-cl button{font:inherit;color:inherit;background:none;border:0;border-radius:var(--wb-r-field);padding:3px 8px;cursor:pointer}
.ben-cl button:hover:not(:disabled){background:var(--cl-field)}
.ben-cl button:disabled{opacity:.4;cursor:default}
.ben-cl :focus-visible{outline:1px solid var(--cl-acc);outline-offset:1px}
.ben-cl input,.ben-cl textarea,.ben-cl select{font:inherit;color:var(--cl-fg);background:var(--cl-field);border:1px solid transparent;border-radius:var(--wb-r-field);padding:4px 8px}
.ben-cl :is(input,textarea,select):focus{outline:0;border-color:var(--wb-faint)}
/* 主 / 次按钮与常用组件(ui/uiStyle.ts 的 wb-ui-btn)同一套:主文字色底反色字、字段底、高 28、圆角 8 */
.ben-cl .ben-cl__primary,.ben-cl .ben-cl__secondary{min-height:var(--wb-btn-h);padding:0 12px;font-weight:500}
.ben-cl .ben-cl__primary{background:var(--wb-ink);color:var(--wb-reverse)}
.ben-cl .ben-cl__primary:hover:not(:disabled){background:var(--wb-g3)}
.ben-cl .ben-cl__secondary{background:var(--wb-field)}
.ben-cl .ben-cl__secondary:hover:not(:disabled){background:var(--wb-g1)}
/* 顶栏(10-22 起取 Codex 全局评审页 0cf75042 项目区那格嵌的协作区原型 \`?embed=workbench\`:
   \`.top\` 内边距 12 / 16 / 10、元素间 12、底线;按钮高 30、内边距 6 / 9、圆角 6、1px 透明边;视图段字 12 次字、按下 field 底主字(不加粗)、间 3;
   下拉 11px、内边距 5、1px 线、圆角 6、field 底、宽至多 126;日期一段 11px 主字、键间 2;等你条 field 底、圆角 6、内边距 7 / 10、字 11、间 10) */
/* 头三行(评审页协作区原型):\`.top\` 内边距 12 / 16 / 10、底线,标题 15 / 600,工具靠右间 4;\`.toolbar\` 10 / 16 / 6、间 12;
   \`.people-strip\` 6 / 16 / 10、间 6,放不下横着滑 */
.ben-cl__head{flex:none;display:flex;flex-direction:column}
.ben-cl__top{display:flex;align-items:center;gap:12px;padding:12px 16px 10px;border-bottom:var(--wb-hair) solid var(--cl-line)}
.ben-cl__title{font:600 15px/21.75px var(--cl-font);margin:0}
.ben-cl__tools{display:flex;gap:4px;margin-left:auto}
.ben-cl__toolbar{display:flex;align-items:center;gap:12px;padding:10px 16px 6px}
.ben-cl__people{display:flex;align-items:center;gap:6px;padding:6px 16px 10px;overflow-x:auto;scrollbar-width:none}
.ben-cl__people::-webkit-scrollbar{display:none}
.ben-cl__people>*{flex:none}
.ben-cl .ben-cl__people .ben-cl__person{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 9px 3px 3px;border:var(--wb-hair) solid var(--cl-line);border-radius:20px;background:var(--cl-note);color:var(--cl-fg);font-size:11px;white-space:nowrap}
.ben-cl .ben-cl__people .ben-cl__person:hover{border-color:var(--cl-fg2);background:var(--cl-field)}
.ben-cl .ben-cl__people .ben-cl__person[aria-pressed=true]{border-color:var(--cl-fg);background:var(--cl-fg);color:var(--cl-paper);box-shadow:0 0 0 1px var(--cl-fg)}
.ben-cl .ben-cl__people .ben-cl__avatar{width:22px;height:22px}
/* 频道(原型 \`.channel\` / \`.message\` / \`.comment-form\`):一列居中、宽至多 850、内边距 24、间 16;每条下一根线、下 18,
   人名标签同成员那一排,时刻 11 弱字,话上下 10,引用的事项一张浅卡宽至多 500;底下一行输入 + 「发送」 */
.ben-cl__chview{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;width:100%;max-width:850px;height:100%;margin:0 auto;padding:24px;overflow:auto}
.ben-cl__msgs{display:flex;flex-direction:column;gap:16px;margin:0;padding:0;list-style:none}
.ben-cl__msg{padding-bottom:18px;border-bottom:var(--wb-hair) solid var(--cl-line)}
.ben-cl__msg-head{display:flex;align-items:center;gap:8px}
.ben-cl__msg-head small{color:var(--cl-fg3);font-size:11px}
.ben-cl__msg p{margin:10px 0}
.ben-cl__msg-ref{max-width:500px;margin-top:8px;padding:12px;border-radius:7px;background:var(--t-routine);color:var(--cl-card-fg);font:600 12.5px/18px var(--cl-font)}
.ben-cl .ben-cl__msg .ben-cl__person{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 9px 3px 3px;border:var(--wb-hair) solid var(--cl-line);border-radius:20px;background:var(--cl-note);color:var(--cl-fg);font-size:11px;white-space:nowrap}
.ben-cl .ben-cl__msg .ben-cl__avatar{width:22px;height:22px}
.ben-cl__msg-form{display:flex;gap:8px;margin-top:10px}
.ben-cl__msg-form input{flex:1;width:0;min-width:0;padding:7px 9px;border:var(--wb-hair) solid var(--cl-line);border-radius:6px;background:var(--cl-field);color:var(--cl-fg);font:inherit}
.ben-cl .ben-cl__head button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:6px 9px;border:1px solid transparent;border-radius:6px;white-space:nowrap}
.ben-cl .ben-cl__head button[aria-pressed=true]{background:var(--cl-field);color:var(--cl-fg)}
.ben-cl .ben-cl__head select{max-width:126px;padding:5px;border:1px solid var(--cl-line);border-radius:6px;background:var(--cl-field);font-size:11px}
.ben-cl__seg{display:inline-flex;gap:3px}
.ben-cl .ben-cl__seg button{font-size:12px;color:var(--cl-fg2)}
.ben-cl .ben-cl__seg button[aria-pressed=true]{background:var(--cl-field);color:var(--cl-fg);font-weight:400}
/* 日期一段 \`.date-nav\`:靠右、间 2、11px;日期字左右 7、宽至少 100 居中 */
.ben-cl__nav{display:inline-flex;align-items:center;gap:2px;margin-left:auto;font-size:11px}
.ben-cl__range{min-width:100px;padding:0 7px;text-align:center;color:var(--cl-fg);font-size:11px}
.ben-cl .ben-cl__nav button{font-size:11px}
.ben-cl__waitbar{display:flex;align-items:center;gap:10px;margin:10px 16px;padding:7px 10px;min-height:32px;background:var(--cl-field);border-radius:6px;font-size:11px;flex-wrap:wrap;min-width:0}
.ben-cl__waitbar b{font-weight:600}
.ben-cl__chip{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.ben-cl__chip[data-kind=proposal]{white-space:normal;color:var(--cl-fg2)}
/* 他直接开的会话放进目标(10-22 第三轮 4,维护者定 B):一行里问句 / 说明、下拉、主键 ink 底 + 次键线框,键下一行后果小字 */
.ben-cl__place{flex-wrap:wrap;align-items:flex-start;gap:8px;white-space:normal;color:var(--cl-fg2)}
.ben-cl__place>.ben-cl__chip-text{align-self:center}
.ben-cl__place select{max-width:160px;border-color:var(--cl-line)}
.ben-cl__place input{width:120px;border-color:var(--cl-line)}
.ben-cl__place[data-kind=proposal]{flex-basis:100%;align-items:center}
.ben-cl__place-acts{display:flex;flex-basis:100%;gap:16px}
.ben-cl__place-act{flex:1;min-width:0;display:inline-flex;flex-direction:column;align-items:flex-start;gap:3px}
.ben-cl__place-act small{color:var(--cl-fg3);font-size:10px;line-height:1.4}
.ben-cl .ben-cl__place .ben-cl__secondary{background:transparent;border:1px solid var(--cl-line)}
.ben-cl__linkish{padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ben-cl__linkish:hover{color:var(--cl-fg)}
.ben-cl__filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:6px 16px 0}
.ben-cl__filter{position:relative}
.ben-cl__filter summary{list-style:none;cursor:pointer;color:var(--cl-fg2);padding:2px 8px;border-radius:6px}
.ben-cl__filter summary::after{content:" ⌄"}
.ben-cl__filter[data-on=true] summary{color:var(--cl-fg);background:var(--cl-field)}
.ben-cl__filter-pop{position:absolute;z-index:20;top:calc(100% + 4px);left:0;min-width:160px;max-height:260px;overflow:auto;background:var(--cl-note);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:4px;box-shadow:0 12px 32px rgba(0,0,0,.35)}
.ben-cl__filter-pop label{display:flex;gap:6px;align-items:center;white-space:nowrap}
.ben-cl__main{flex:1;display:flex;min-height:0}
.ben-cl__board{flex:1;position:relative;min-width:0;min-height:0;display:flex;flex-direction:column}
/* 底栏(原型 \`.footer\`:内边距 8 / 16、元素间 12、字 11、底线在上;键 11px、高 24、内边距 2 / 6;图例靠右、间 12、次字,色块 6×6 圆角 2、与字隔 4) */
.ben-cl__foot{display:flex;align-items:center;gap:12px;padding:8px 16px;border-top:var(--wb-hair) solid var(--cl-line);color:var(--cl-fg);font-size:11px;flex-wrap:wrap}
.ben-cl .ben-cl__foot button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:24px;padding:2px 6px;border-radius:6px;font-size:11px}
.ben-cl__legend{display:inline-flex;gap:12px;margin-left:auto;color:var(--cl-fg2);font-size:11px}
.ben-cl__legend span::before{content:"";display:inline-block;width:6px;height:6px;border-radius:2px;margin-right:4px;background:var(--lg);vertical-align:1px}
.ben-cl__spacer{flex:0}
/* 类型底色(卡片浅底深字;颜色只表示已知类型) */
.ben-cl [data-type=meeting]{--cl-tbg:var(--t-meeting)} .ben-cl [data-type=dev]{--cl-tbg:var(--t-dev)}
.ben-cl [data-type=content]{--cl-tbg:var(--t-content)} .ben-cl [data-type=routine]{--cl-tbg:var(--t-routine)}
.ben-cl [data-type=none]{--cl-tbg:var(--t-none)}
.ben-cl__ticon{display:inline-flex;flex:none;vertical-align:-2px;margin-right:6px}
.ben-cl__tlabel{display:inline-flex;align-items:center;color:var(--cl-card-fg2);font-size:11px}
/* 状态章:中性色、0.7 边线、下拉箭头 */
.ben-cl__stampwrap{position:relative;display:inline-flex}
/* 状态章(原型 \`.stamp\`):字 10、高 23、内边距 2 / 4、1px 半透明黑边、半透明白底、圆角 4、间 2 */
.ben-cl .ben-cl__stamp{display:inline-flex;align-items:center;justify-content:center;gap:2px;min-height:23px;border:1px solid rgba(0,0,0,.22);border-radius:4px;padding:2px 4px;font-size:10px;font-weight:400;background:rgba(255,255,255,.533);color:var(--cl-card-fg)}
.ben-cl .ben-cl__stamp:disabled{opacity:1;cursor:default}
.ben-cl__stamp-mark{font-size:9px}
.ben-cl__stamp-caret{font-size:10px;opacity:.7}
.ben-cl__stampmenu{position:absolute;z-index:30;top:calc(100% + 4px);right:0;display:flex;flex-direction:column;gap:2px;min-width:96px;background:var(--cl-note);color:var(--cl-fg);border-radius:10px;padding:6px;box-shadow:0 12px 32px rgba(0,0,0,.4)}
.ben-cl .ben-cl__stampopt{display:flex;gap:6px;align-items:center;text-align:left;padding:3px 8px}
.ben-cl .ben-cl__stampopt[aria-pressed=true]{background:var(--cl-field);font-weight:600}
.ben-cl__act{font-weight:500}
.ben-cl .ben-cl__act{background:rgba(255,255,255,.6);color:var(--cl-card-fg);padding:1px 8px;font-size:11.5px}
.ben-cl__rel{font-size:10.5px;color:var(--cl-card-fg);border:var(--wb-hair) solid currentColor;border-radius:4px;padding:0 4px}
/* 时间线 */
.ben-cl__tl{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--cl-paper)}
.ben-cl__timeline-panes{display:flex;flex:1;min-height:0;min-width:0;height:100%;overflow:hidden}
/* 人和 Agent 的时间占用(2026-10-27 合并稿 ④,原型 repair-time-wide / -portrait):计划虚线、实际实心;方向按容器宽高。 */
.ben-cl__occ{box-sizing:border-box;flex:1;min-width:0;min-height:0;height:100%;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px;font-size:11.5px}
.ben-cl__occ-top h3{margin:0;font-size:13px}
.ben-cl__occ-top p{margin:4px 0 0}
.ben-cl__occ-legend{display:flex;gap:14px;align-items:center;color:var(--cl-fg2);font-size:10.5px}
.ben-cl__occ-legend i{display:inline-block;width:10px;height:8px;margin-right:4px;vertical-align:-1px;border-radius:2px}
.ben-cl__occ-legend [data-kind=plan] i{border:1px dashed var(--cl-fg3)}
.ben-cl__occ-legend [data-kind=actual] i{background:var(--cl-p-done);border:1px solid var(--cl-fg3)}
.ben-cl__occ-body{position:relative;display:flex;flex-direction:column}
.ben-cl__occ-axis{position:relative;height:18px;margin-left:208px;color:var(--cl-fg3);font-size:10px}
.ben-cl__occ-axis span{position:absolute;transform:translateX(-50%);white-space:nowrap}
.ben-cl__occ-row{display:grid;grid-template-columns:160px 1fr;column-gap:8px;padding:10px 0;border-top:var(--wb-hair) solid var(--cl-line)}
.ben-cl__occ-who{grid-row:1 / span 2;min-width:0}
.ben-cl__occ-track{display:grid;grid-template-columns:40px 1fr;align-items:center;min-height:30px}
.ben-cl__occ-track-name{color:var(--cl-fg3);font-size:10px}
.ben-cl__occ-lane{position:relative;height:${OCC_SUBROW_PX}px}
.ben-cl__occ-tick{position:absolute;top:0;bottom:0;border-left:var(--wb-hair) solid var(--cl-line)}
.ben-cl__occ-bar{position:absolute;top:2px;bottom:2px;box-sizing:border-box;min-width:6px;padding:0 6px;overflow:hidden;border-radius:4px;font:inherit;font-size:10.5px;text-align:left;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;color:var(--cl-fg)}
.ben-cl__occ-bar{container-type:size}
.ben-cl__occ-bar span{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;line-height:${OCC_LINE_PX - 2}px}
@container (max-width:${OCC_TEXT_MIN_PX}px){.ben-cl__occ-bar span{display:none}}
.ben-cl__occ-bar[data-kind=more]{background:var(--cl-note);border:var(--wb-hair) solid var(--cl-line);color:var(--cl-fg2)}
.ben-cl__occ-more-list{position:absolute;z-index:5;top:100%;min-width:160px}
.ben-cl__occ-bar[data-kind=plan]{background:transparent;border:1px dashed var(--cl-fg3)}
.ben-cl__occ-bar[data-kind=actual]{background:var(--cl-p-done);color:var(--cl-card-fg);border:1px solid var(--cl-fg3)}
.ben-cl__occ-bar[data-kind=actual][data-open=true]{background:var(--cl-p-doing);border-right:2px solid var(--cl-fg)}
.ben-cl__occ-now{position:absolute;top:0;bottom:0;border-left:1px solid var(--cl-fg);z-index:2;pointer-events:none}
.ben-cl__occ-foot{margin:4px 0 0}
/* 真实回执飞线(合并稿 7.1):一颗点从交回那一家的头像沿直线落到那件事项的卡;位置是视口坐标,所以层用 fixed。 */
.ben-cl__fly-layer{position:fixed;inset:0;pointer-events:none;z-index:${COLLAB_Z.dialogVeil}}
.ben-cl__fly{position:absolute;left:0;top:0;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--cl-fg);box-shadow:0 0 0 3px color-mix(in srgb,var(--cl-fg) 22%,transparent);animation:ben-cl-fly var(--fly-ms,900ms) cubic-bezier(.3,.7,.2,1) both}
@keyframes ben-cl-fly{from{transform:translate(var(--fly-x0),var(--fly-y0));opacity:0}12%{opacity:1}88%{opacity:1}to{transform:translate(var(--fly-x1),var(--fly-y1));opacity:0}}
@media (prefers-reduced-motion: reduce){.ben-cl__fly{display:none}}
/* 竖排:每人一列、时间从上到下;刻度在左。 */
.ben-cl__occ[data-dir=column] .ben-cl__occ-body{flex-direction:row;align-items:flex-start;gap:0;min-width:min-content}
.ben-cl__occ[data-dir=column] .ben-cl__occ-axis{flex:none;width:40px;height:${OCC_COLUMN_LANE_PX}px;margin:56px 0 0}
.ben-cl__occ[data-dir=column] .ben-cl__occ-axis span{left:0;transform:translateY(-50%)}
.ben-cl__occ[data-dir=column] .ben-cl__occ-row{flex:1 1 0;min-width:120px;grid-template-columns:1fr 1fr;grid-template-rows:auto auto;column-gap:4px;padding:0 6px;border-top:0;border-left:var(--wb-hair) solid var(--cl-line)}
.ben-cl__occ[data-dir=column] .ben-cl__occ-who{grid-row:auto;grid-column:1 / span 2;height:40px;overflow:hidden}
.ben-cl__occ[data-dir=column] .ben-cl__occ-track{grid-template-columns:1fr;grid-template-rows:16px ${OCC_COLUMN_LANE_PX}px;align-items:stretch}
.ben-cl__occ[data-dir=column] .ben-cl__occ-lane{height:auto}
.ben-cl__occ[data-dir=column] .ben-cl__occ-tick{left:0;right:0;top:auto;bottom:auto;border-left:0;border-top:var(--wb-hair) solid var(--cl-line)}
.ben-cl__occ[data-dir=column] .ben-cl__occ-bar{top:auto;bottom:auto;padding:1px 4px;min-width:0;min-height:6px}
.ben-cl__occ[data-dir=column] .ben-cl__occ-bar[data-kind=actual][data-open=true]{border-right:1px solid var(--cl-fg3);border-bottom:2px solid var(--cl-fg)}
.ben-cl__occ[data-dir=column] .ben-cl__occ-more-list{left:auto;right:0}
.ben-cl__occ[data-dir=column] .ben-cl__occ-now{left:0;right:0;top:auto;bottom:auto;border-left:0;border-top:1px solid var(--cl-fg)}
.ben-cl__tl-mode{display:inline-flex;gap:2px}
.ben-cl__timeline-plan-title{margin:0;padding:10px 14px;font-size:12px;color:var(--cl-fg2)}
.ben-cl__timeline-actual{box-sizing:border-box;flex:0 0 260px;min-width:0;overflow:auto;padding:12px;border-left:var(--wb-hair) solid var(--cl-line);font-size:11.5px;overflow-wrap:anywhere}
.ben-cl__timeline-actual h3{font-size:12px;margin:0 0 8px}
.ben-cl__timeline-actual>ul{list-style:none;margin:0;padding:0}
.ben-cl__timeline-actual>ul>li{padding:10px 0;border-bottom:var(--wb-hair) solid var(--cl-line)}
.ben-cl__timeline-actual p{margin:5px 0}
.ben-cl__timeline-actual time{color:var(--cl-fg3);font-size:10px}
@media(max-width:1100px){.ben-cl__timeline-panes{flex-direction:column}.ben-cl__timeline-actual{flex-basis:180px;max-height:35%;border-left:0;border-top:var(--wb-hair) solid var(--cl-line)}}
/* 日期头(原型 \`.date-head\`):高 42、纸面底、底线;每天一格左线、内边距 11 / 10,日期 12 / 700 */
.ben-cl__tl-head{display:flex;align-items:stretch;background:var(--cl-paper);border-bottom:var(--wb-hair) solid var(--cl-line)}
.ben-cl__tl-day{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:11px 10px;border-left:var(--wb-hair) solid var(--cl-line);font-size:11px;font-weight:400}
.ben-cl__tl-day>b{font-size:12px;font-weight:700}
.ben-cl__tl-day>span{color:var(--cl-fg2)}
.ben-cl__today-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--cl-fg)}
.ben-cl__tl-body{flex:1;overflow-y:auto;overflow-x:hidden}
.ben-cl__tl-grid{position:relative;display:flex}
/* 刻度栏宽 48(TimelineView 的 GUTTER)、字 10 弱字;半点一根线(不透明);现在线 1px 主字色 + 左端 5px 圆点,时刻标签 10 / 18、圆角 3、内边距 0 / 3 */
.ben-cl__tl-gutter{position:relative;flex:none;color:var(--cl-fg3);font-size:10px}
.ben-cl__tl-gutter span{position:absolute;right:8px;transform:translateY(-50%)}
.ben-cl__now-tag{background:var(--cl-fg);color:var(--cl-paper);border-radius:3px;padding:0 3px;font:400 10px/18px var(--cl-font)}
.ben-cl__tl-col{position:relative;flex:1;min-width:0;border-left:var(--wb-hair) solid var(--cl-line)}
.ben-cl__tl-line{position:absolute;left:0;right:0;border-top:var(--wb-hair) solid var(--cl-line)}
.ben-cl__now{position:absolute;left:0;right:0;border-top:1px solid var(--cl-fg);z-index:3}
.ben-cl__now::before{content:"";position:absolute;width:5px;height:5px;border-radius:50%;background:var(--cl-fg);top:-3px;left:-3px}
/* 时间卡(原型 \`.event\`):内边距 8 / 9、间 5、1px 透明边、圆角 7;悬停 1px 主字色圈;选中(相关)2px 主字色圈 + 纸面色边;变淡 .2;
   标题 12.5 / 600、行高 18、最多两行 */
.ben-cl__tcard{position:absolute;box-sizing:border-box;background:var(--cl-tbg);color:var(--cl-card-fg);border:1px solid transparent;border-radius:7px;padding:8px 9px;display:flex;flex-direction:column;gap:5px;overflow:hidden;z-index:1;transition:opacity .12s,box-shadow .12s}
.ben-cl__tcard:hover{box-shadow:0 0 0 1px var(--cl-fg);z-index:4}
.ben-cl__tcard[data-dim=true]{opacity:.2}
.ben-cl__tcard[data-related=true]{box-shadow:0 0 0 2px var(--cl-fg);border-color:var(--cl-paper)}
.ben-cl .ben-cl__tcard-title{display:flex;align-items:flex-start;text-align:left;padding:0;font:600 12.5px/18px var(--cl-font);color:var(--cl-card-fg);overflow:hidden}
.ben-cl .ben-cl__tcard-title:hover{background:none;text-decoration:underline}
.ben-cl__tcard-foot{display:flex;align-items:center;gap:6px;min-width:0;flex:none;margin-top:auto}
.ben-cl__tcard-head{display:flex;gap:4px;align-items:center;min-width:0;color:var(--cl-card-fg2);font-size:10px;white-space:nowrap;overflow:hidden;flex:none}
.ben-cl__tcard-head>span{overflow:hidden;text-overflow:ellipsis}
.ben-cl__tcard-head>.ben-cl__ticon{flex:none;margin:0}
.ben-cl__tcard-goal{flex:none;color:var(--cl-card-fg2);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ben-cl__tcard-why{margin:2px 0 0;color:var(--cl-card-fg2);font-size:11px;line-height:1.65;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.ben-cl__tcard[data-size=compact]{padding:5px 7px;gap:1px}
.ben-cl__tcard[data-size=compact] .ben-cl__tcard-head{display:none}
.ben-cl .ben-cl__tcard[data-size=compact] .ben-cl__tcard-title{-webkit-line-clamp:1;font-size:12px}
.ben-cl__tcard[data-size=compact] .ben-cl__tcard-foot{margin-top:2px}
.ben-cl__tcard[data-point=true] .ben-cl__tcard-head{display:none}
.ben-cl__tcard[data-point=true]:not([data-type=past])::after{content:'时间点';position:absolute;right:7px;top:6px;font-size:9px;color:#656565}
.ben-cl .ben-cl__tcard[data-point=true]:not([data-type=past]) .ben-cl__tcard-title{padding-right:35px;font-size:11.5px}
.ben-cl .ben-cl__tcard .ben-cl__tcard-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;flex:none;white-space:normal}
.ben-cl__tcard-owner{flex:1;min-width:0;color:var(--cl-card-fg2);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 卡上的人(原型 \`.person.mini\`):字 10、间 4、高 21、内边距 1 / 5 / 1 / 1、1px 半透明黑边、半透明白底、圆角 20,头像 18 */
.ben-cl .ben-cl__tcard .ben-cl__person{gap:4px;min-height:21px;padding:1px 5px 1px 1px;border:1px solid rgba(0,0,0,.125);border-radius:20px;background:rgba(255,255,255,.396);color:var(--cl-card-fg);font-size:10px}
.ben-cl .ben-cl__tcard .ben-cl__person .ben-cl__avatar{width:18px;height:18px;font-size:9px}
.ben-cl__tcard[data-point=true]{border-left:3px solid #666}
.ben-cl__tmore{position:absolute;left:5px;right:5px;z-index:2}
.ben-cl .ben-cl__tmore>button{display:flex;align-items:center;gap:10px;width:100%;min-height:62px;padding:6px 9px;border:var(--wb-hair) solid var(--cl-line);border-radius:6px;background:var(--cl-note);text-align:left;white-space:normal}
.ben-cl__tmore>button>span{flex:1;min-width:0}
.ben-cl__tmore>button>.ben-cl__ticon{flex:none;margin:0}
.ben-cl__tmore small{display:block;margin-top:4px;color:var(--cl-fg3);font-size:10px}
.ben-cl__tmore-list{list-style:none;margin:4px 0 0;padding:6px;background:var(--cl-note);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.35)}
/* 目标视图(React Flow) */
.ben-cl__flow{position:relative;width:100%;height:100%;flex:1;min-height:0;background:var(--cl-canvas)}
.ben-cl .react-flow__background{color:var(--cl-line)}
.ben-cl .react-flow__minimap{background:var(--cl-area);border-radius:10px}
.ben-cl__minimap-cursor-hide{display:none}
.ben-cl .react-flow__controls{box-shadow:none;bottom:12px;left:16px;margin:0;z-index:10}
.ben-cl .react-flow__controls button{background:var(--cl-field);border:0;color:var(--cl-fg);fill:var(--cl-fg)}
.ben-cl .react-flow__node-goal{pointer-events:none}
.ben-cl .react-flow__node-goal .ben-cl__goal-head{pointer-events:all;cursor:grab}
.ben-cl .react-flow__node-cursor{pointer-events:none;transition:transform .9s cubic-bezier(.3,.9,.3,1)}
.ben-cl__goal{width:100%;height:100%;box-sizing:border-box;background:var(--cl-area);border-radius:12px;transition:box-shadow .2s}
.ben-cl__goal[data-empty=true]{background:transparent}
.ben-cl__goal[data-over=true]{box-shadow:0 0 0 1px var(--cl-fg) inset}
.ben-cl__goal[data-dim=true]{opacity:.45}
.ben-cl__goal[data-status=reached],.ben-cl__goal[data-status=dropped]{opacity:.6}
.ben-cl__goal-head{display:flex;flex-direction:column;gap:4px;padding:16px 18px}
.ben-cl__goal-row{display:flex;align-items:baseline;gap:10px}
.ben-cl__goal-head h3{margin:0;font:600 14px/20.3px var(--cl-font)}
.ben-cl__goal-why{color:var(--cl-fg2)}
.ben-cl__goal-meta{color:var(--cl-fg3);font-size:11px}
.ben-cl__goal-risk{margin-left:auto;color:var(--cl-fg3);font-size:11px;white-space:nowrap}
.ben-cl__dots{display:inline-flex;align-items:center;gap:5px;color:var(--cl-fg3);font-size:11px}
.ben-cl__dot-i{width:6px;height:6px;border-radius:50%;border:1px solid var(--cl-fg2);box-sizing:border-box}
.ben-cl__dot-i[data-done=true]{background:var(--cl-fg);border-color:var(--cl-fg)}
.ben-cl__dots-note{margin-left:6px}
.ben-cl__note{box-sizing:border-box;width:100%;background:var(--cl-tbg);color:var(--cl-card-fg);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:6px}
.ben-cl__note[data-dim=true]{opacity:.32}
.ben-cl__note[data-related=true]{box-shadow:0 0 0 1.5px var(--cl-fg)}
.ben-cl__note[data-working=true]{box-shadow:0 0 0 2px rgba(79,141,255,.55)}
.ben-cl .ben-cl__note-title{border:0;padding:0;text-align:left;font:600 13.5px/19.575px var(--cl-font);color:var(--cl-card-fg);background:none;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.ben-cl .ben-cl__note-title:hover{background:none;text-decoration:underline}
.ben-cl__note-line{color:var(--cl-card-fg2)}
.ben-cl__note-foot{display:flex;align-items:center;gap:6px;border-top:var(--wb-hair) solid rgba(0,0,0,.12);padding-top:8px;margin-top:2px}
.ben-cl__note-foot .ben-cl__owner{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cl-card-fg2)}
.ben-cl__note-objection{margin:0;color:#8a4b12}
.ben-cl__note-receipt{margin:0;color:var(--cl-card-fg2);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ben-cl__flag{font-size:10.5px;color:#9b2c2c;border:var(--wb-hair) solid currentColor;border-radius:4px;padding:0 4px}
.ben-cl__gaps{display:flex;gap:4px;flex-wrap:wrap}
.ben-cl__gap{font-size:10.5px;color:var(--cl-card-fg2);background:rgba(255,255,255,.5);border-radius:4px;padding:0 5px}
.ben-cl__note-arrows{display:flex;gap:2px}
.ben-cl .ben-cl__note-arrows button{padding:0 5px;color:var(--cl-card-fg2)}
.ben-cl__cursor-scale{position:relative;display:inline-block;pointer-events:none}
.ben-cl__cursor{position:relative;color:var(--cl-cursor,#4f8dff);animation:ben-cl-arrive .9s cubic-bezier(.3,.9,.3,1)}
.ben-cl__cursor svg{display:block;fill:currentColor;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
.ben-cl__cursor[data-state=working] svg{animation:ben-cl-wiggle .5s ease-in-out infinite}
.ben-cl__cursor[data-state=stamping]{animation:ben-cl-leave 1.4s ease-in forwards}
.ben-cl__cursor-tag{position:absolute;left:14px;top:12px;display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 9px 3px 3px;border:var(--wb-hair) solid var(--cl-line);border-radius:20px;background:var(--cl-note);color:var(--cl-fg);font-size:11px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none}
.ben-cl__cursor-tag .ben-cl__avatar{width:22px;height:22px}
.ben-cl__cursor-stamp{position:absolute;left:-20px;top:16px;font-size:14px;font-weight:700;border:1.5px solid currentColor;border-radius:4px;padding:0 3px;transform:rotate(-12deg)}
@keyframes ben-cl-arrive{from{transform:translateX(260px);opacity:0}to{transform:none;opacity:1}}
@keyframes ben-cl-leave{0%,60%{transform:none;opacity:1}100%{transform:translateX(260px);opacity:0}}
@keyframes ben-cl-wiggle{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}
/* 名片栏 */
.ben-cl__rail{width:252px;flex:none;border-left:var(--wb-hair) solid var(--cl-line);overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.ben-cl__rail h4{margin:0;font:500 12px/17.4px var(--cl-font);color:var(--cl-fg2)}
.ben-wb__projects-collab{flex:1;min-height:320px;display:flex;position:relative;margin-top:8px}
.ben-wb__projects-collab>.ben-cl{flex:1;min-width:0}
.ben-cl__rail[data-floating=true]{position:absolute;right:0;top:0;bottom:0;z-index:${COLLAB_Z.floatingRail};background:var(--cl-canvas);box-shadow:-8px 0 24px rgba(0,0,0,.25)}
.ben-cl__main{position:relative}
.ben-cl .ben-cl__card-edit{font-size:11px;color:var(--cl-fg2);padding:2px 6px}
.ben-cl .ben-cl__person{display:inline-flex;align-items:center;gap:6px;padding:1px 6px 1px 1px;border-radius:999px;color:inherit;font:inherit;max-width:100%}
.ben-cl .ben-cl__person .ben-cl__avatar{width:20px;height:20px;font-size:10px}
.ben-cl .ben-cl__person[data-mini=true] .ben-cl__avatar{width:16px;height:16px;font-size:9px}
.ben-cl .ben-cl__person[aria-pressed=true]{background:var(--cl-field);outline:1px solid var(--cl-fg3)}
.ben-cl__person-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-cl__avatar[data-custom=true]{overflow:hidden;padding:0}
.ben-cl__avatar[data-custom=true] img,.ben-cl__avatar[data-custom=true] svg,.ben-cl__avatar[data-custom=true] .ben-wb__agenticon{width:100%;height:100%;object-fit:cover;display:flex;align-items:center;justify-content:center}
.ben-cl__avatar[data-custom=true] .ben-wb__agenticon-img{width:100%;height:100%;object-fit:cover;display:block}
.ben-cl__people{display:flex;flex-wrap:wrap;gap:6px}
.ben-cl__tcard[data-type=past]{background:transparent;border-style:dashed;color:var(--cl-fg2)}
/* 已发生的会话 / 经过是透明底的虚线框,字落在纸面上:用纸面上的主次字,不用浅底卡的深字(暗色下 #25262b 落在 #1c1c1c 上对比 1.1,看不见)。
   稿里没有这一档(协作区 Pen 与评审页的协作区原型都只画了浅底卡)。 */
.ben-cl .ben-cl__tcard[data-type=past] .ben-cl__tcard-title{color:var(--cl-fg)}
.ben-cl__tcard[data-type=past] :is(.ben-cl__tcard-owner,.ben-cl__past-tag){color:var(--cl-fg2)}
.ben-cl__tcard[data-type=past][data-point=true]{border-left-color:var(--cl-fg2)}
.ben-cl__past-tag{font-size:10px;border:var(--wb-hair) solid var(--cl-line);border-radius:4px;padding:0 4px;margin-right:6px}
.ben-cl__avatar-editor{width:min(520px,92vw)}
.ben-cl__avatar-preview{display:flex;gap:16px;align-items:center;margin:8px 0 12px}
.ben-cl__avatar-preview>span:last-child{display:flex;flex-direction:column;gap:4px}
.ben-cl__avatar-large .ben-cl__avatar{width:72px;height:72px;font-size:28px}
.ben-cl__avatar-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:8px;margin:12px 0}
.ben-cl .ben-cl__avatar-grid button{aspect-ratio:1;padding:0;overflow:hidden;border-radius:10px;border:1px solid var(--cl-line)}
.ben-cl .ben-cl__avatar-grid button[data-round=true]{border-radius:50%}
.ben-cl .ben-cl__avatar-grid button[aria-pressed=true]{outline:2px solid var(--cl-fg)}
.ben-cl__avatar-upload{display:flex;flex-direction:column;gap:10px;margin:12px 0}
.ben-cl__avatar-upload input[type=file]{position:absolute;opacity:0;width:1px;height:1px}
.ben-cl__crop{border:1px solid var(--cl-line);border-radius:8px;overflow:hidden;cursor:grab;touch-action:none}
.ben-cl__dlg-foot{display:flex;gap:8px;align-items:center;margin-top:12px}
.ben-cl__rail-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.ben-cl__cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.ben-cl__card{border-bottom:var(--wb-hair) solid var(--cl-line);padding:12px 0}
.ben-cl .ben-cl__card-btn{display:flex;gap:12px;width:100%;text-align:left;padding:6px;border-radius:10px;align-items:flex-start}
.ben-cl .ben-cl__card-btn[aria-pressed=true]{background:var(--cl-field)}
.ben-cl__card[data-online=false]{opacity:.5}
.ben-cl__card-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.ben-cl__card-name{font-weight:600}
.ben-cl__card-line{color:var(--cl-fg2);font-size:12px}
.ben-cl .ben-cl__card-at{padding:0;text-align:left;color:var(--cl-fg2);font-size:12px}
.ben-cl__avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:var(--cl-field);color:var(--cl-fg);font-weight:600;font-size:13px}
.ben-cl__avatar[data-round=true]{border-radius:50%}
.ben-cl__rail-form{display:flex;flex-direction:column;gap:8px}
.ben-cl__rail-form label{display:flex;flex-direction:column;gap:4px;color:var(--cl-fg2)}
.ben-cl__rail-actions{display:flex;gap:6px}
.ben-cl__rail-note{color:#d26b6b;margin:0}
.ben-cl .ben-cl__rail-add{margin-top:auto;background:var(--cl-field);text-align:left;padding:8px 12px}
/* 气泡 / 回执 / 弹层 */
.ben-cl .ben-cl__bubble-btn{display:inline-flex;align-items:center;gap:6px}
.ben-cl__bubble{position:absolute;right:16px;bottom:56px;z-index:8;width:min(360px,calc(100% - 32px));background:var(--cl-note);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 16px 40px rgba(0,0,0,.4)}
.ben-cl__bubble-head{display:flex;gap:6px;align-items:center;color:var(--cl-fg2)}
.ben-cl__bubble-head span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-cl__bubble textarea{resize:vertical}
.ben-cl__receipt{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);z-index:9;margin:0;background:var(--cl-fg);color:var(--cl-paper);border-radius:7px;padding:10px 16px;max-width:90%;box-shadow:var(--wb-shadow-receipt)}
.ben-cl__pop{position:absolute;z-index:9;left:16px;bottom:48px;width:min(380px,calc(100% - 32px));max-height:60%;overflow:auto;background:var(--cl-note);border-radius:10px;padding:12px;box-shadow:0 16px 40px rgba(0,0,0,.4)}
.ben-cl__pop ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.ben-cl__pop li{display:flex;gap:8px;align-items:center;justify-content:space-between}
.ben-cl__dialog-veil{position:absolute;inset:0;z-index:${COLLAB_Z.dialogVeil};background:var(--wb-veil-deep);display:flex;justify-content:center;align-items:center;padding:24px;overflow:auto}
.ben-cl__dialog{box-sizing:border-box;width:min(900px,100%);max-height:calc(100% - 48px);overflow:auto;background:var(--cl-paper);color:var(--cl-fg);border:var(--wb-hair) solid var(--cl-line);border-radius:var(--wb-r-window);padding:24px 28px;display:flex;flex-direction:column;gap:12px;box-shadow:var(--wb-shadow-dlg)}
.ben-cl__dlg-head{display:flex;align-items:center;gap:12px}
.ben-cl__dlg-head h2{margin:0;font:600 18px/26.1px var(--cl-font);flex:1;min-width:0}
.ben-cl__dlg-head h2 .ben-cl__gap{margin-left:8px;vertical-align:2px}
.ben-cl__dlg-head .ben-cl__stamp{background:transparent;color:var(--cl-fg);border-color:currentColor}
.ben-cl__dlg-nav{display:flex;gap:4px}
.ben-cl__meta{display:flex;gap:24px;flex-wrap:wrap;margin:0;color:var(--cl-fg2)}
.ben-cl__mstatus{border:var(--wb-hair) solid var(--cl-line);border-radius:4px;padding:1px 6px;color:var(--cl-fg2)}
.ben-cl__meeting-cols{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:28px}
.ben-cl__meeting-cols aside{border-left:var(--wb-hair) solid var(--cl-line);padding-left:28px}
.ben-cl__decisions{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.ben-cl__decisions li{display:flex;flex-direction:column;gap:2px;align-items:flex-start}
.ben-cl .ben-cl__linked{display:flex;justify-content:space-between;align-items:center;width:100%;background:var(--cl-field);border-radius:10px;padding:12px 14px;margin-bottom:8px;text-align:left}
.ben-cl .ben-cl__linked .ben-cl__stamp{background:transparent;color:var(--cl-fg);border-color:currentColor}
.ben-cl__dlg-block{border-top:var(--wb-hair) solid var(--cl-line);padding-top:12px}
/* 详情两栏(2026-10-27 合并稿第六节):中间过程与交流,右栏背景与安排;容器窄了自动排成一栏。 */
.ben-cl__dlg-cols{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px 24px}
.ben-cl__dlg-main{flex:1 1 460px;min-width:0;display:flex;flex-direction:column;gap:12px}
.ben-cl__dlg-side{flex:1 1 280px;max-width:100%;min-width:0;display:flex;flex-direction:column;gap:12px}
.ben-cl__dlg-cols>.ben-cl__dlg-side:not(:only-child){flex-basis:300px}
.ben-cl__dlg-ask{display:flex;flex-direction:column;gap:4px;padding:8px 0}
.ben-cl__dlg-ask p{margin:0}
.ben-cl__dlg-executor{margin:4px 0 0}
.ben-cl__trace.ben-cl__trace--strip{width:auto;border-left:0;border-top:var(--wb-hair) solid var(--cl-line);padding:8px 0 0}
.ben-cl__trace--strip .ben-cl__trace-line{flex-direction:row;margin:0;padding:12px 0 4px;border-left:0;border-top:var(--wb-hair) solid var(--cl-line);gap:16px;overflow-x:auto}
.ben-cl__trace--strip .ben-cl__trace-node{flex:none;width:120px}
.ben-cl__trace--strip .ben-cl__trace-node>i{left:0;top:-16px}
.ben-cl__dlg-block h3{margin:0 0 8px;font:600 14px/20.3px var(--cl-font)}
.ben-cl__dlg-block h4{margin:8px 0 4px;font:500 12px/17.4px var(--cl-font);color:var(--cl-fg2)}
.ben-cl__dlg-block p{margin:4px 0}
.ben-cl__dlg-facts{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0}
.ben-cl__dlg-facts dt{color:var(--cl-fg3)}
.ben-cl__dlg-facts dd{margin:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ben-cl .ben-cl__link{padding:0 2px;color:var(--cl-fg2);text-decoration:underline}
.ben-cl__muted{color:var(--cl-fg3)}
.ben-cl__prewrap{white-space:pre-wrap}
.ben-cl__quote{margin-left:6px;color:var(--cl-fg)}
.ben-cl__ref{margin-left:6px;font-size:10.5px;color:var(--cl-fg3)}
.ben-cl__acceptance{margin:4px 0;padding-left:20px}
.ben-cl__timeline,.ben-cl__replay-list{margin:4px 0;padding-left:18px}
.ben-cl__timeline time,.ben-cl__replay-list time,.ben-cl__comments time{color:var(--cl-fg3);font-size:10.5px}
.ben-cl__replay-list li[data-kind=note]{color:#d26b6b}
.ben-cl__comments{list-style:none;margin:4px 0;padding:0;display:flex;flex-direction:column;gap:4px}
.ben-cl__comments[data-resolved=true]{opacity:.6}
.ben-cl__comments label{display:flex;gap:6px;align-items:baseline}
.ben-cl__dialog textarea{width:100%;box-sizing:border-box;resize:vertical}
.ben-cl__dlg-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.ben-cl__timeform{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
/* 空态 */
.ben-cl__emptystate{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:1}
.ben-cl__emptystate .wb-ui-empty{max-width:360px;flex:none}
.ben-cl__emptystate .wb-ui-empty-title{font:600 var(--wb-fs-detail)/26.1px var(--cl-font)}
/* 设置 */
.ben-cl__settings{display:grid;grid-template-columns:180px minmax(0,1fr);gap:24px;max-width:980px}
.ben-cl__settings nav{display:flex;flex-direction:column;gap:2px}
.ben-cl__settings nav button{text-align:left}
.ben-cl__settings nav button[aria-pressed=true]{background:var(--cl-field);font-weight:600}
.ben-cl__setsec{background:var(--cl-area);border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.ben-cl__setsec h3{margin:0;font:600 14px/20.3px var(--cl-font)}
.ben-cl__setrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-top:var(--wb-hair) solid var(--cl-line);padding-top:8px}
.ben-cl__setrow:first-of-type{border-top:0}
.ben-cl__code{font:600 20px/29px var(--cl-font);letter-spacing:.12em}
.ben-cl__form{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 12px;align-items:center}
.ben-cl__form label{color:var(--cl-fg2)}
@media (max-width:720px){.ben-cl__rail{display:none}.ben-cl__meeting-cols{grid-template-columns:1fr}.ben-cl__meeting-cols aside{border-left:0;padding-left:0}}
/* 窄的时候(原型 \`@container (max-width:1100px)\` / \`(max-width:650px)\`):工具栏收紧、折行,项目下拉窄一点,
   日期一段占满剩下那段靠右;「N 张名片」只留图标;底栏图例收起、「记一件事」靠右 */
@container (max-width:1100px){
  .ben-cl__toolbar{gap:6px}
}
@container (max-width:650px){
  .ben-cl__top{padding:10px 12px}
  .ben-cl__title{font-size:14px}
  .ben-cl__tool-label{display:none}
  .ben-cl__toolbar{flex-wrap:wrap;gap:5px;padding:8px 12px 4px}
  .ben-cl .ben-cl__toolbar select{max-width:105px;font-size:10px}
  .ben-cl__nav{flex:1;justify-content:flex-end;margin-left:0}
  .ben-cl__range{min-width:72px;padding:0 2px}
  .ben-cl__people{padding:6px 12px 9px}
  .ben-cl__waitbar{margin:0 12px 8px}
  .ben-cl__foot{gap:5px;padding:7px 10px}
  .ben-cl__legend{display:none}
  .ben-cl__bubble-btn{margin-left:auto}
}

/* 进展可读摘要 (2026-10-23 卡 D1 第一段) */
.ben-cl__progress-summary{
  background:var(--cl-area); border-bottom:var(--wb-hair) solid var(--cl-line);
  padding:6px 16px 8px; display:flex; flex-direction:column; gap:6px; flex:none; z-index:4;
}
.ben-cl__ps-bar{display:flex; flex-direction:column; gap:5px}
.ben-cl__ps-scope{display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:11px; color:var(--cl-fg2)}
.ben-cl__ps-scope-title{font-weight:600; color:var(--cl-fg)}
.ben-cl__ps-scope-count{color:var(--cl-fg3)}
.ben-cl__ps-dedup-tag{color:var(--cl-fg3); font-size:10.5px}
.ben-cl__ps-demo-tag{color:#f59e0b; font-size:10.5px}
.ben-cl__ps-stale-tag{color:#ef4444; font-size:10.5px}
.ben-cl__ps-chips{display:flex; align-items:center; gap:6px; flex-wrap:wrap}
.ben-cl__ps-chip{
  border:1px solid var(--cl-line); border-radius:var(--wb-r-field, 6px);
  padding:2px 7px; font-size:11px; color:var(--cl-fg); background:var(--cl-field);
  display:inline-flex; align-items:center; gap:4px; min-height:24px; cursor:pointer;
  transition:background .15s ease, border-color .15s ease;
}
.ben-cl__ps-chip:hover:not(:disabled){background:var(--wb-g1, rgba(255,255,255,0.08))}
.ben-cl__ps-chip[data-active=true]{border-color:var(--cl-acc); font-weight:600; background:var(--cl-paper)}
.ben-cl__ps-chip[data-truth=running]{border-color:rgba(96,165,250,0.5)}
.ben-cl__ps-chip[data-truth=review]{border-color:rgba(250,204,21,0.5)}
.ben-cl__ps-chip[data-truth=accepted]{border-color:rgba(74,222,128,0.4)}
.ben-cl__ps-chip[data-truth=delivered]{border-color:rgba(74,222,128,0.7)}
.ben-cl__ps-chip[data-truth=blocked]{border-color:rgba(244,63,94,0.5); color:#fda4af}
.ben-cl__ps-chip[data-truth=waiting_receipt]{border-color:rgba(148,163,184,0.5)}
.ben-cl__ps-chip[data-truth=canceled]{opacity:.6}

.ben-cl__ps-drawer{
  background:var(--cl-paper); border:1px solid var(--cl-line); border-radius:8px;
  padding:10px 14px; max-height:280px; overflow-y:auto; display:flex; flex-direction:column; gap:8px;
  box-shadow:0 4px 12px rgba(0,0,0,0.25);
}
.ben-cl__ps-drawer-head{
  display:flex; justify-content:space-between; align-items:center;
  border-bottom:var(--wb-hair) solid var(--cl-line); padding-bottom:6px;
}
.ben-cl__ps-drawer-title{margin:0; font-size:12.5px; font-weight:600}
.ben-cl__ps-close{padding:2px 6px; cursor:pointer; color:var(--cl-fg2)}
.ben-cl__ps-close:hover{color:var(--cl-fg)}
.ben-cl__ps-drawer-body{display:flex; flex-direction:column; gap:8px}
.ben-cl__ps-task-list{display:flex; flex-direction:column; gap:8px}
.ben-cl__ps-item{
  border-bottom:var(--wb-hair) solid var(--cl-line); padding-bottom:6px;
  display:flex; flex-direction:column; gap:4px;
}
.ben-cl__ps-item:last-child{border-bottom:0}
.ben-cl__ps-item-head{display:flex; justify-content:space-between; align-items:center; gap:8px}
.ben-cl__ps-item-title{
  font-size:12px; font-weight:600; text-align:left; color:var(--cl-fg);
  padding:0; background:none; border:0; cursor:pointer; text-decoration:none;
}
.ben-cl__ps-item-title:hover{text-decoration:underline; color:var(--cl-acc)}
.ben-cl__ps-item-meta{display:flex; gap:8px; flex-wrap:wrap; font-size:11px; color:var(--cl-fg2)}
.ben-cl__ps-badge{
  font-size:10.5px; padding:1px 5px; border-radius:3px;
  border:1px solid var(--cl-line); color:var(--cl-fg); background:var(--cl-field);
}
.ben-cl__ps-badge[data-truth=running]{border-color:rgba(96,165,250,0.5); color:#93c5fd}
.ben-cl__ps-badge[data-truth=review]{border-color:rgba(250,204,21,0.5); color:#fde047}
.ben-cl__ps-badge[data-truth=accepted]{border-color:rgba(74,222,128,0.4); color:#86efac}
.ben-cl__ps-badge[data-truth=delivered]{border-color:rgba(74,222,128,0.7); color:#4ade80}
.ben-cl__ps-badge[data-truth=blocked]{border-color:rgba(244,63,94,0.5); color:#fda4af}
.ben-cl__ps-wait{color:#fda4af}
.ben-cl__ps-item-checks{font-size:11px; color:var(--cl-fg2); margin-top:2px}
.ben-cl__ps-item-checks ul{margin:2px 0 0; padding-left:16px}
.ben-cl__ps-cond-list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px}
.ben-cl__ps-cond-item{
  display:flex; justify-content:space-between; align-items:flex-start; gap:10px;
  border-bottom:var(--wb-hair) solid var(--cl-line); padding:6px 0; font-size:12px;
}
.ben-cl__ps-cond-item:last-child{border-bottom:0}
.ben-cl__ps-cond-main{display:flex; flex-direction:column; gap:2px; flex:1; min-width:0}
.ben-cl__ps-cond-text{color:var(--cl-fg)}
.ben-cl__ps-tag--warn{color:#f59e0b; font-size:10.5px}
.ben-cl__ps-evidence{font-size:10.5px; color:var(--cl-fg3)}
.ben-cl__ps-cond-side{display:flex; align-items:center; gap:6px; flex:none}
.ben-cl__ps-link-btn{font-size:11px; color:var(--cl-fg2); cursor:pointer; padding:2px 4px}
.ben-cl__ps-link-btn:hover{color:var(--cl-fg); text-decoration:underline}

@container (max-width:650px){
  .ben-cl__progress-summary{padding:6px 12px}
  .ben-cl__ps-chips{gap:4px}
  .ben-cl__ps-chip{padding:2px 5px; font-size:10px; min-height:22px}
}

/* 目标摘要条(2026-10-24 小K collab-desktop-1024):固定在任务滚动区之外,滑到哪里都对照得到目标与剩余 */
.ben-cl__goalstrip{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:6px 16px;border-bottom:var(--wb-hair) solid var(--cl-line);background:var(--cl-paper);flex:none}
.ben-cl .ben-cl__goalstrip-chip{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--cl-line);border-radius:16px;padding:2px 10px;font-size:11px;background:var(--cl-field)}
.ben-cl__goalstrip-count{color:var(--cl-fg3);font-size:10.5px}
.ben-cl__goalstrip-chip[data-status=reached],.ben-cl__goalstrip-chip[data-status=dropped]{opacity:.6}
/* 阅读模式(组件态默认,设计 3.3):固定阅读字号、普通纵向滚动、目标分区、卡片网格按宽增列(260–370 不拉长) */
.ben-cl__reading{flex:1;overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:24px;padding:16px;background:var(--cl-paper)}
.ben-cl__rgoal{background:var(--cl-area);border-radius:12px;padding:4px 0 16px}
.ben-cl__rgoal[data-empty=true]{padding-bottom:0}
.ben-cl__rgoal[data-dim=true]{opacity:.45}
.ben-cl__rgoal[data-status=reached],.ben-cl__rgoal[data-status=dropped]{opacity:.6}
.ben-cl__rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));gap:20px;padding:0 20px;margin-top:12px;justify-content:start}
.ben-cl__rgoal-empty{padding:8px 4px}
/* 卡片浅状态色(设计 3.3:浅蓝处理 / 浅黄等待 / 浅绿完成 / 浅玫瑰受阻;配文字原因,不只靠颜色) */
.ben-cl__note[data-status=doing]{--cl-st:#71b8ff}
.ben-cl__note[data-status=confirm]{--cl-st:#f5c46e}
.ben-cl__note[data-status=done]{--cl-st:#83d9af}
.ben-cl__note[data-status=blocked]{--cl-st:#f49c9b}
.ben-cl__note[data-status=canceled]{opacity:.55}
.ben-cl__note{border-left:3px solid var(--cl-st,transparent)}
.ben-cl__note[data-working=true]{box-shadow:0 0 0 2px rgba(79,141,255,.55)}
.ben-cl__note-reason{margin:0;color:var(--cl-st,var(--cl-card-fg2));font-size:11px}
/* 频道:本机事务官身份与局域网成员(2026-10-24;人类只读,改名先查重) */
.ben-cl__lan{display:flex;flex-direction:column;gap:8px;padding:12px;border:var(--wb-hair) solid var(--cl-line);border-radius:10px;background:var(--cl-area)}
.ben-cl__lan-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.ben-cl__lan-row label{display:flex;flex-direction:column;gap:4px;color:var(--cl-fg2);font-size:11px}
.ben-cl__lan-note{margin:0;color:#f5c46e;font-size:11.5px}
.ben-cl__lan-conflict{margin:0;font-size:11.5px;color:var(--cl-fg2);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ben-cl__lan-members{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ben-cl__lan-member{display:inline-flex;gap:6px;align-items:center;border:var(--wb-hair) solid var(--cl-line);border-radius:16px;padding:2px 10px;font-size:11px}
.ben-cl__lan-member small{color:var(--cl-fg3)}
.ben-cl__lan-member[data-reachable=true] small{color:#83d9af}
.ben-cl__lan-member[data-reachable=false] small{color:#f49c9b}
.ben-cl__chview-note{margin-top:auto;padding-top:12px;font-size:11px}
.ben-cl__offline{margin:0;padding:7px 16px;border-bottom:var(--wb-hair) solid var(--cl-line);font-size:12px;color:var(--cl-fg2)}
.ben-cl__relay-feed{display:flex;flex-direction:column;gap:12px;min-width:0}
.ben-cl__channel-empty{display:flex;align-items:center;justify-content:center;min-height:140px;position:relative}
.ben-cl__lan-connect{font-size:12px;margin-top:12px}
.ben-cl__lan-connect summary{cursor:pointer;color:var(--cl-fg2)}
.ben-cl__lan-connect form{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:10px;margin-top:12px}
.ben-cl__lan-connect label{display:flex;flex-direction:column;gap:4px;min-width:0}
.ben-cl__lan-connect input{box-sizing:border-box;width:100%;min-width:0}
.ben-cl__lan-connect output{display:inline-block;margin:8px;font-size:20px;letter-spacing:4px}
/* 来往速览 / 统一活动流 / 留言邀请(2026-10-24;速览与详情共用 NoteTalk 与草稿) */
.ben-cl__quickview{position:absolute;right:16px;top:56px;z-index:8;width:min(420px,calc(100% - 32px));max-height:70%;overflow:auto;background:var(--cl-note);border:var(--wb-hair) solid var(--cl-line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 16px 40px rgba(0,0,0,.4)}
.ben-cl__quickview-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ben-cl__quickview-head b{font-size:13px}
.ben-cl__quickview-head small{flex-basis:100%}
.ben-cl__talk{display:flex;flex-direction:column;gap:8px}
.ben-cl__talk-stream{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:240px;overflow:auto}
.ben-cl__talk-stream li{font-size:12px;line-height:1.6;word-break:break-word}
.ben-cl__talk-stream time{color:var(--cl-fg3);font-size:10.5px}
.ben-cl__talk-stream li[data-kind=receipt]{color:var(--cl-fg2)}
.ben-cl__talk-stream li[data-kind=transition]{color:var(--cl-fg3)}
.ben-cl__talk-tag{margin-left:6px;font-size:10px;border:var(--wb-hair) solid var(--cl-line);border-radius:4px;padding:0 4px;color:var(--cl-fg2)}
.ben-cl__talk-delivery{display:block;color:var(--cl-fg2);font-size:11px}
.ben-cl__talk-delivery[data-status=accepted]{color:#83d9af}
.ben-cl__talk-delivery[data-status=failed]{color:#f49c9b}
.ben-cl__talk-compose{display:flex;flex-direction:column;gap:6px}
.ben-cl__talk-ask{display:flex;flex-direction:column;gap:6px;padding:8px;border:var(--wb-hair) solid var(--cl-line);border-radius:8px;background:var(--cl-area);font-size:11.5px}
.ben-cl .ben-cl__note-talk{font-size:10.5px;color:var(--cl-card-fg2);border:var(--wb-hair) solid rgba(0,0,0,.15);border-radius:4px;padding:0 5px}
/* 目标条件面板(2026-10-24,契约 B;文字状态不只靠颜色) */
.ben-cl__goalpanel{width:min(760px,100%)}
.ben-cl__gc-scope{margin:0;font-size:11px}
.ben-cl__gc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.ben-cl__gc-item{display:flex;flex-direction:column;gap:12px;border:var(--wb-hair) solid var(--cl-line);border-radius:8px;padding:12px;min-width:0}
.ben-cl__gc-main{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0;width:100%}
.ben-cl__gc-main ol{flex-basis:100%;margin:0;padding-left:20px;line-height:1.7;overflow-wrap:anywhere}
.ben-cl__gc-text{font-weight:600;min-width:160px;flex:1}
.ben-cl__gc-state{font-size:10.5px;border:var(--wb-hair) solid var(--cl-line);border-radius:4px;padding:0 5px}
.ben-cl__gc-state[data-state=verified]{color:#83d9af;border-color:rgba(131,217,175,.5)}
.ben-cl__gc-state[data-state=delivered]{color:#4ade80;border-color:rgba(74,222,128,.7)}
.ben-cl__gc-state[data-state=submitted]{color:#f5c46e;border-color:rgba(245,196,110,.5)}
.ben-cl__gc-state[data-state=rework]{color:#f5c46e;border-color:rgba(245,196,110,.4)}
.ben-cl__gc-state[data-state=blocked]{color:#f49c9b;border-color:rgba(244,156,155,.5)}
.ben-cl__gc-state[data-state=pending]{color:var(--cl-fg3)}
.ben-cl__gc-blocked{color:#f49c9b;font-size:11px}
.ben-cl__gc-acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ben-cl__gc-acts{width:100%;box-sizing:border-box}
.ben-cl__gc-acts label{display:flex;flex:1;flex-direction:column;gap:5px;min-width:min(200px,100%)}
.ben-cl__gc-acts label select,.ben-cl__gc-acts label textarea{box-sizing:border-box;width:100%;min-width:0}
.ben-cl__gc-acts textarea{min-height:64px;resize:vertical;font:inherit;color:var(--cl-fg);background:var(--cl-field);border:var(--wb-hair) solid var(--cl-line);border-radius:6px;padding:6px}
.ben-cl__gc-add{display:flex;gap:6px;align-items:center}
.ben-cl__gc-add input{flex:1;min-width:0}
.ben-cl__receipt-inline{margin:0;font-size:11.5px;color:var(--cl-fg2)}
.ben-cl .ben-cl__goal-conds{font-size:10.5px;color:var(--cl-fg2);border:var(--wb-hair) solid var(--cl-line);border-radius:4px;padding:0 6px}
/* 关系 / 父子分组 / 轮次(2026-10-24,契约 D2) */
.ben-cl__rels{display:flex;flex-direction:column;gap:8px}
.ben-cl__rels-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.ben-cl__rels-list li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px}
.ben-cl__rels-kind{font-size:10.5px;border:var(--wb-hair) solid var(--cl-line);border-radius:4px;padding:0 5px;color:var(--cl-fg2)}
.ben-cl__rels-note{color:var(--cl-fg2)}
.ben-cl__rels-stale{color:#f5c46e}
.ben-cl__rels-list li[data-stale=true] .ben-cl__rels-kind{border-color:rgba(245,196,110,.5)}
.ben-cl__rels-add{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ben-cl__rgroup{grid-column:1/-1;display:flex;flex-direction:column;gap:10px;border:var(--wb-hair) solid var(--cl-line);border-radius:12px;padding:12px;background:rgba(255,255,255,.02)}
.ben-cl__rgroup>.ben-cl__note,.ben-cl__rgrid>.ben-cl__note{max-width:370px}
.ben-cl__rgroup-kids{display:flex;flex-direction:column;gap:8px}
.ben-cl__rgroup-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,370px));gap:20px}
.ben-cl__round{font-size:11px;color:#f5c46e;border:var(--wb-hair) solid rgba(245,196,110,.5);border-radius:4px;padding:1px 6px;white-space:nowrap}

.ben-cl__rgroup-kids[hidden]{display:none}
.ben-cl__rgroup-grid>.ben-cl__rgroup{grid-column:1/-1}
.ben-cl__fixed-goal{flex:none;padding:8px 16px;border-bottom:var(--wb-hair) solid var(--cl-line);background:var(--cl-paper);font-size:12px;max-height:24vh;overflow:auto}
.ben-cl__fixed-goal>label{display:inline-flex;gap:8px;align-items:center;margin-right:12px}
.ben-cl__fixed-goal p{margin:5px 0}
.ben-cl__fixed-goal ul{margin:4px 0;padding-left:18px;display:flex;flex-wrap:wrap;gap:6px 24px}
.ben-cl__fixed-goal li{overflow-wrap:anywhere}
.ben-cl__reply-preview{padding:8px;border:1px solid var(--cl-line);border-radius:6px;overflow-wrap:anywhere}
.ben-cl__reply-preview small{display:block}
.ben-cl__reply-preview blockquote{margin:6px 0;white-space:pre-wrap}
.ben-cl__report-text p{white-space:pre-wrap;overflow-wrap:anywhere}

/* —— 2026-10-27 合并稿:卡片按完成情况上色、目标条、进度刻度、事项轨迹 —— */
.ben-cl{--cl-p-not-started:#d7d8da;--cl-p-doing:#d0daf0;--cl-p-review:#ecdcb7;--cl-p-done:#d6e5cc;--cl-p-blocked:#efcfc8}
.ben-cl[data-theme=light]{--cl-p-not-started:#ececed;--cl-p-doing:#e3ebfb;--cl-p-review:#f7ecd2;--cl-p-done:#e6f0de;--cl-p-blocked:#f8e1dc}
.ben-cl .ben-cl__note[data-progress=not-started]{--cl-tbg:var(--cl-p-not-started)}
.ben-cl .ben-cl__note[data-progress=doing]{--cl-tbg:var(--cl-p-doing)}
.ben-cl .ben-cl__note[data-progress=review]{--cl-tbg:var(--cl-p-review)}
.ben-cl .ben-cl__note[data-progress=done]{--cl-tbg:var(--cl-p-done)}
.ben-cl .ben-cl__note[data-progress=blocked]{--cl-tbg:var(--cl-p-blocked)}
.ben-cl__note-next{margin:0;color:var(--cl-card-fg2);font-size:11px;line-height:1.5}
.ben-cl__note-progress{display:flex;flex-direction:column;gap:5px;color:var(--cl-card-fg2);font-size:10.5px}
.ben-cl__note-rungs{display:flex;gap:3px}
.ben-cl__note-rungs i{flex:1;height:3px;border-radius:2px;background:rgba(0,0,0,.12)}
.ben-cl__note-rungs i[data-on=true]{background:var(--cl-card-fg)}
.ben-cl__goalbar{flex:none;display:flex;flex-direction:column;gap:8px;padding:12px 16px;border-bottom:var(--wb-hair) solid var(--cl-line)}
.ben-cl__goalbar-row{display:flex;align-items:baseline;gap:12px;min-width:0}
.ben-cl__goalbar-title{margin:0;font:600 14px/20px var(--cl-font);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-cl__goalbar-count{flex:none;color:var(--cl-fg2);font-size:12px}
.ben-cl__goalbar-trace{margin-left:auto;flex:none;font-size:11px}
.ben-cl__goalbar-rungs{display:flex;gap:3px}
.ben-cl__goalbar-rungs i{flex:1;height:4px;border-radius:2px;background:var(--cl-p-not-started)}
.ben-cl__goalbar-rungs i[data-progress=doing]{background:var(--cl-p-doing)}
.ben-cl__goalbar-rungs i[data-progress=review]{background:var(--cl-p-review)}
.ben-cl__goalbar-rungs i[data-progress=done]{background:var(--cl-p-done)}
.ben-cl__goalbar-rungs i[data-progress=blocked]{background:var(--cl-p-blocked)}
.ben-cl__goalbar-facts{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0;color:var(--cl-fg2);font-size:11.5px}
.ben-cl__legend-progress{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;margin:0;color:var(--cl-fg2);font-size:11px}
.ben-cl__legend-progress b{color:var(--cl-fg);font-weight:600}
.ben-cl__legend-progress span{display:inline-flex;align-items:center;gap:5px}
.ben-cl .ben-cl__legend-progress button{display:inline-flex;align-items:center;gap:5px;padding:2px 6px;margin:0 -6px;color:inherit;font-size:inherit;line-height:inherit}
.ben-cl .ben-cl__legend-progress button[aria-pressed=true],.ben-cl .ben-cl__progress-pick[aria-pressed=true]{background:var(--cl-field);color:var(--cl-fg);box-shadow:inset 0 0 0 1px var(--cl-fg3)}
.ben-cl__legend-progress i{width:10px;height:10px;border-radius:3px;background:var(--cl-p-not-started)}
.ben-cl__legend-progress [data-progress=doing] i{background:var(--cl-p-doing)}
.ben-cl__legend-progress [data-progress=review] i{background:var(--cl-p-review)}
.ben-cl__legend-progress [data-progress=done] i{background:var(--cl-p-done)}
.ben-cl__legend-progress [data-progress=blocked] i{background:var(--cl-p-blocked)}
.ben-cl__legend-progress small{margin-left:auto;color:var(--cl-fg3)}
.ben-cl__trace{flex:none;width:300px;display:flex;flex-direction:column;min-height:0;border-left:var(--wb-hair) solid var(--cl-line);padding:12px 0 0}
.ben-cl__main[data-narrow=true]{flex-direction:column}
/* 窄屏上下分(2026-10-28):轨迹按内容定高、最多四成、至少一条的高,里面自己滚;画布拿剩下的且不少于四成五。 */
.ben-cl__main[data-narrow=true]>.ben-cl__board{min-height:45%}
.ben-cl__main[data-narrow=true]>.ben-cl__trace{width:auto;height:auto;flex:0 1 auto;max-height:40%;min-height:120px;border-left:0;border-top:var(--wb-hair) solid var(--cl-line)}
.ben-cl__trace-status{margin:0 14px 6px}
.ben-cl__trace-wait,.ben-cl__trace-bad{margin:6px 12px;font-size:11px}
.ben-cl__trace-top{display:flex;align-items:baseline;gap:10px;padding:0 14px 8px}
.ben-cl__trace-top h4{margin:0;font:500 12px/17px var(--cl-font);color:var(--cl-fg2)}
.ben-cl__trace-top small{color:var(--cl-fg3);font-size:11px}
.ben-cl__trace>.ben-cl__muted{padding:0 14px}
/* 竖排:每件一列、时间从上到下;件多了换行接着排,把整条高都用上,竖着滚(10-28:原来 21 件一行横排,300 宽里只见两三件,下面大片空白)。 */
.ben-cl__trace-lanes{flex:1;min-height:0;overflow-x:hidden;overflow-y:auto;display:flex;flex-direction:row;flex-wrap:wrap;align-content:flex-start;gap:0;padding:0 6px 10px}
.ben-cl__trace-lane{flex:1 0 132px;min-width:0;display:flex;flex-direction:column;padding:0 8px 12px;border-right:var(--wb-hair) solid var(--cl-line);border-bottom:var(--wb-hair) solid var(--cl-line)}
.ben-cl__trace-head{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:4px 0 8px;text-align:left;white-space:normal;border:0;border-bottom:var(--wb-hair) solid var(--cl-line);border-radius:0;background:none;color:var(--cl-fg)}
.ben-cl__trace-head b{font-size:11.5px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ben-cl__trace-head small{color:var(--cl-fg3);font-size:10.5px}
.ben-cl__trace-line{list-style:none;margin:10px 0 0;padding:0 0 0 12px;border-left:var(--wb-hair) solid var(--cl-line);display:flex;flex-direction:column;gap:14px}
.ben-cl__trace-node{position:relative;display:flex;flex-direction:column;gap:1px;font-size:10.5px;color:var(--cl-fg2);word-break:keep-all;overflow-wrap:anywhere}
.ben-cl__trace-node>i{position:absolute;left:-16px;top:3px;width:7px;height:7px;border-radius:50%;background:var(--cl-fg2)}
.ben-cl__trace-node[data-kind=dispatch]>i,.ben-cl__trace-node[data-kind=handoff]>i{border-radius:1px;transform:rotate(45deg)}
.ben-cl__trace-node[data-kind=rework]>i,.ben-cl__trace-node[data-kind=blocked]>i{background:transparent;border:1px solid var(--cl-fg2)}
.ben-cl__trace-node time{color:var(--cl-fg3);font-size:10px}
.ben-cl__trace-node b{color:var(--cl-fg);font-size:11px;font-weight:600}
.ben-cl__trace-node code{font-size:10px;color:var(--cl-fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ben-cl__trace-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ben-cl__trace-current>i{background:transparent;border:1px dashed var(--cl-fg)}
.ben-cl__trace-current[data-state=running]>i{border-style:solid;box-shadow:0 0 0 3px color-mix(in srgb,var(--cl-fg) 15%,transparent)}
.ben-cl__trace-empty{font-size:10.5px;color:var(--cl-fg3)}
.ben-cl__trace[data-dir=row] .ben-cl__trace-lanes{flex-direction:column;flex-wrap:nowrap;padding:0 14px 8px}
.ben-cl__trace[data-dir=row] .ben-cl__trace-lane{flex:none;display:grid;grid-template-columns:160px 1fr;align-items:start;padding:8px 0;border-right:0;border-bottom:var(--wb-hair) solid var(--cl-line)}
.ben-cl__trace[data-dir=row] .ben-cl__trace-head{border-bottom:0;padding:0 12px 0 0}
.ben-cl__trace[data-dir=row] .ben-cl__trace-line{flex-direction:row;margin:0;padding:12px 0 0;border-left:0;border-top:var(--wb-hair) solid var(--cl-line);gap:16px;overflow-x:auto}
.ben-cl__trace[data-dir=row] .ben-cl__trace-node{flex:none;width:120px}
.ben-cl__trace[data-dir=row] .ben-cl__trace-node>i{left:0;top:-16px}
@media (prefers-reduced-motion:reduce){.ben-cl__trace-current>i{box-shadow:none}}
.ben-cl__manager{font-size:10.5px;color:var(--cl-card-fg2);white-space:nowrap}
`
