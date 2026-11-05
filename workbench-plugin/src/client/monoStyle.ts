/**
 * 工作台视觉 A · Mono 的外层(2026-10-21,`docs/设计-工作台视觉-2026-10-21.md`「每格改动」)。挂在 STYLE 最后,
 * 同特异度时它说了算。只读 `tokens.ts` 的令牌,不写死颜色。
 *
 * - 卡片无描边、无阴影,圆角 24,靠纸面与外层底色的明度分区;分隔用 0.7 发丝线。
 * - 受保护的光效(`PROTECTED_ROOTS`)这里一条都不碰。
 */
import { UI_STYLE } from './ui/uiStyle.ts'

export const MONO_STYLE = `
${UI_STYLE}
/* ── 外层与卡片 ── */
/* 基准字:评审页 body 13px / 1.5、主字色(原来吃宿主 body 的 16px / normal / #f9fafb,没写字号的字都比稿大一号) */
.ben-wb{background:var(--wb-back);font-family:var(--wb-font);font-size:13px;line-height:1.5;color:var(--wb-ink)}
.ben-wb .ben-wb__body .ben-wb__card{background:var(--wb-paper);border:0;box-shadow:none;border-radius:var(--wb-r-card)}

/* ── 顶栏(评审页 \`.desk-top\`):一行、无底线,字 10px 次字、元素间 12;「工作台」11 / 700 主字;
   按钮(几家、纯净、换屏、恢复布局、设置)10px 次字、高 22、内边距 0 / 6、圆角 6,悬停 soft;各家图标格 22×22、圆角 4;
   状态字(存储、性能、时刻)10px 次字。壳里 78px 红绿灯位与 28px 高照旧(稿里的红绿灯是示意)。 ── */
.ben-wb .ben-wb__topbar{background:transparent;border:0;border-radius:0;box-shadow:none;gap:12px;font-size:10px;line-height:1.5;color:var(--wb-sub)}
.ben-wb h1.ben-wb__topname{font-size:11px;font-weight:700;line-height:1.5;color:var(--wb-ink);letter-spacing:0}
.ben-wb .ben-wb__topbar :is(.ben-wb__topgear,.ben-wb__toppure,.ben-wb__topplain,.ben-wb__agentcount-btn){display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:22px;padding:0 6px;border:0;border-radius:6px;background:transparent;box-shadow:none;color:var(--wb-sub);font-size:10px;font-weight:400;line-height:1.5}
.ben-wb .ben-wb__topbar .ben-wb__topagent{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:22px;min-height:22px;padding:0;border:0;border-radius:4px;background:transparent;box-shadow:none;color:var(--wb-sub);font-size:10px;font-weight:400;line-height:1.5}
.ben-wb .ben-wb__topbar :is(.ben-wb__topgear,.ben-wb__toppure,.ben-wb__topplain,.ben-wb__agentcount-btn,.ben-wb__topagent):hover:not(:disabled){background:var(--wb-soft)}
.ben-wb .ben-wb__topbar .ben-wb__toppure[aria-pressed=true]{text-decoration:underline;text-underline-offset:4px}
.ben-wb :is(.ben-wb__topstat-label,.ben-wb__topclock){color:var(--wb-sub);font-size:10px;font-weight:400;line-height:1.5}
.ben-wb .ben-wb__topstat-val{font-size:10px;line-height:1.5}
.ben-wb .ben-wb__topstat-val:not(.ben-wb__topstat-val--alert):not(.ben-wb__topstat-val--off){color:var(--wb-sub);font-weight:400}
.ben-wb .ben-wb__topstat{gap:3px}

/* ── 窗口槽的标签(横屏提进左栏、竖屏横排在窗口槽里)。取 Codex 全局评审页 0cf75042
   \`#screen=landscape&theme=dark&slot=original\` 左栏 \`.app-rail\`:一行高 30、内边距 4 / 9、圆角 6、字 12 / 400 主字色、图标与字隔 6,
   行与行隔 5;选中 = 纸面底 + 600,**不反色**;计数 10px 次字色,选中那行跟着 600。悬停 = soft 底,整行一块(不再只有名字那半变色)。
   稿里没有的照旧:✕、没在跑置灰、还没拉进来的虚线框;「执行中」白点照 0.4.142(style.ts 那条:白底深字、呼吸),这里不碰它。 ── */
.ben-wb .ben-wb__land-rail{gap:5px;padding-top:6px}
.ben-wb .ben-wb__land-rail .ben-wb__dock-tabs{gap:5px}
.ben-wb .ben-wb__dock-tab{min-height:30px;background:transparent;border:0;border-radius:6px;box-shadow:none}
.ben-wb .ben-wb__dock-tab .ben-wb__dock-tab-name,.ben-wb .ben-wb__dock-tab .ben-wb__dock-tab-name:hover:not(:disabled){gap:6px;padding:4px 9px;background:transparent;color:var(--wb-ink);font-size:12px;font-weight:400}
.ben-wb .ben-wb__dock-tab:hover{background:var(--wb-soft)}
.ben-wb .ben-wb__dock-tab[data-current=true]{background:var(--wb-paper)}
.ben-wb .ben-wb__dock-tab[data-current=true] .ben-wb__dock-tab-name,.ben-wb .ben-wb__dock-tab[data-current=true] .ben-wb__dock-tab-name:hover:not(:disabled){font-weight:600}
.ben-wb .ben-wb__dock-tab[data-running=false] .ben-wb__dock-tab-name{color:var(--wb-faint)}
.ben-wb .ben-wb__dock-tab-close{color:var(--wb-faint);background:transparent}
/* 徽章(10-22 第三轮 7,维护者定:语义底色保留,评审页只画了灰字计数):各档底色照 0.4.142(style.ts),新消息改绿底白字;
   尺寸 15 高、圆角满、字 10 / 700。「在跑」那颗白底呼吸不动。 */
.ben-wb .ben-wb__dock-badge .ben-wb__dock-badge-dot{min-width:15px;height:15px;padding:0 4px;border-radius:999px;font-size:10px;font-weight:700}
.ben-wb .ben-wb__dock-badge[data-tone=im] .ben-wb__dock-badge-dot{background:var(--dsw-alias-state-success-primary,#3fb27f);border-color:transparent;color:#fff}
/* 竖屏那一排横标签:稿里没有(评审页竖屏不画应用这一列),沿用横屏左栏的值横过来。它摆在纸面卡片里,纸面底的选中在纸面上看不出,
   选中底按同一页「纸面上的选中 = soft」(\`.seg button.active\`、\`.settings-nav button.active\`)。 */
.ben-wb .ben-wb__mod[data-module-box=slot] .ben-wb__dock-tabs{gap:5px}
.ben-wb .ben-wb__mod[data-module-box=slot] .ben-wb__dock-tab[data-current=true]{background:var(--wb-soft)}
/* 这一排只占一行、高度钉死 30(评审页 \`.slot-tabs\` 也是不折行的一行):原来 flex-wrap 折行,徽章数字或「执行中」白点一出一没
   就可能多折 / 少折一行,槽体跟着高矮 37px,ResizeObserver 让服务端把窗重贴一次 —— 维护者看到的「应用顶部下面时不时露出虚线框」。
   放不下就横向滚(滚动条藏起),「开发一个小工具」钉在右端。 */
.ben-wb .ben-wb__mod[data-module-box=slot] .ben-wb__dock-tabs{flex-wrap:nowrap;height:30px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.ben-wb .ben-wb__mod[data-module-box=slot] .ben-wb__dock-tabs::-webkit-scrollbar{display:none}
.ben-wb .ben-wb__mod[data-module-box=slot] .ben-wb__dock-tabs>*{flex:none}
.ben-wb .ben-wb__mod[data-module-box=slot] .ben-wb__dock-tabs>.ben-wb__devtool{position:sticky;right:0;margin-left:auto;background:var(--wb-paper)}
/* 「窗口布局」是左栏的一行,样子同应用那几行(评审页 \`.app-rail>button\`);后面那个数稿里没有,照左栏计数的样子(10px 次字) */
.ben-wb .ben-wb__scenemenu-trigger{display:flex;align-items:center;gap:6px;min-height:30px;padding:4px 9px;border:0;border-radius:6px;background:transparent;color:var(--wb-ink);font-size:12px;font-weight:400;line-height:1.5}
.ben-wb .ben-wb__scenemenu-trigger:hover{background:var(--wb-soft);color:var(--wb-ink)}
/* 「开发一个小工具」是左栏最后一行,样子同上(评审页 \`.app-rail>button\`:+ 图标、12 / 400 主字色、高 30、内边距 4 / 9、圆角 6、图标隔 6) */
.ben-wb .ben-wb__devtool-btn{display:flex;align-items:center;justify-content:flex-start;gap:6px;min-height:30px;border:0;border-radius:6px;background:transparent;color:var(--wb-ink);font-size:12px;font-weight:400;line-height:1.5;padding:4px 9px;text-align:left}
.ben-wb .ben-wb__devtool-btn:hover{color:var(--wb-ink);background:var(--wb-soft)}

/* 它学到了什么(LearnRail.tsx),照评审页 \`.rail-learning\`:上面一根线、内边距 16 / 7 / 10;标题 11px 主字;说明 9px 弱字;
   三行各一行:名 10px 次字 · 点(隔 3)· 数 13 / 700 主字,行间 9,不再画分隔线。 */
.ben-wb__learn{display:block;margin-top:12px;padding:16px 7px 10px;border-top:var(--wb-hair) solid var(--wb-line)}
.ben-wb .ben-wb__learn-ttl{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;min-height:28px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;color:var(--wb-ink);font:400 11px/1.5 var(--wb-font);cursor:pointer}
.ben-wb .ben-wb__learn-ttl:hover{background:var(--wb-soft)}
.ben-wb__learn-cap{margin:5px 0 10px;color:var(--wb-faint);font:400 9px/1.5 var(--wb-font);letter-spacing:0}
.ben-wb__learn-rows{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.ben-wb__learn-row{display:flex;align-items:center;gap:8px;margin-top:9px;padding:0;border:0;color:var(--wb-sub);font-size:10px}
.ben-wb__learn-label{order:0;color:var(--wb-sub);font:400 10px/1.5 var(--wb-font)}
.ben-wb__learn-row .wb-ui-tally{order:1;flex:1;gap:3px}
.ben-wb__learn-n{order:2;color:var(--wb-ink);font:700 13px/1.5 var(--wb-font);letter-spacing:0;font-variant-numeric:tabular-nums}

/* ── 各格(评审页 \`.module\`):纸面底、圆角 16;头 \`.module-head\` 内边距 17 / 20 / 10、元素间 10,标题 13 / 600;
   身 \`.module-body\` 左右 20、底 16;竖屏头上 20、身底 20;格宽 ≤ 560 时头 14 / 16 / 9、身左右 16 底 14。
   右上「收起」稿里没有,照旧(弱字、无框,悬停 soft)。 ── */
.ben-wb .ben-wb__body .ben-wb__card{container-type:inline-size;padding:0}
.ben-wb .ben-wb__body .ben-wb__card>.ben-wb__modhead{gap:10px;margin:0;padding:17px 20px 10px}
.ben-wb .ben-wb__body .ben-wb__card>:where(:not(.ben-wb__modhead)){margin-left:20px;margin-right:20px}
.ben-wb .ben-wb__body .ben-wb__card>:where(:last-child:not(.ben-wb__modhead)){margin-bottom:16px}
.ben-wb[data-orientation=portrait] .ben-wb__body .ben-wb__card>.ben-wb__modhead{padding-top:20px}
.ben-wb[data-orientation=portrait] .ben-wb__body .ben-wb__card>:where(:last-child:not(.ben-wb__modhead)){margin-bottom:20px}
@container (max-width:560px){
  .ben-wb .ben-wb__body .ben-wb__card>.ben-wb__modhead{padding:14px 16px 9px}
  .ben-wb .ben-wb__body .ben-wb__card>:where(:not(.ben-wb__modhead)){margin-left:16px;margin-right:16px}
  .ben-wb .ben-wb__body .ben-wb__card>:where(:last-child:not(.ben-wb__modhead)){margin-bottom:14px}
}
/* 项目区那格里的协作区铺满(评审页项目区那格就是协作区组件本身,不留边) */
.ben-wb .ben-wb__body .ben-wb__card>.ben-wb__projects-collab{margin:0;border-radius:inherit;overflow:hidden}
.ben-wb .ben-wb__body :is(.ben-wb__card,.ben-wb__card--fill)>.ben-wb__modhead .ben-wb__ttl{color:var(--wb-ink);font-size:13px;font-weight:600;line-height:1.5;letter-spacing:0}
/* 格头右端那颗小键(评审页 \`.head-actions\` 里的「3 条记录 ›」):12px 主字、高 28、内边距 4 / 9、圆角 6,悬停 soft;挤在收起键前面 */
.ben-wb .ben-wb__modhead-aside{display:flex;align-items:center;gap:6px;margin-left:auto}
.ben-wb .ben-wb__modhead-aside+.ben-wb__modbtns{margin-left:0}
.ben-wb .ben-wb__modhead-aside button{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:4px 9px;border:0;border-radius:6px;background:transparent;color:var(--wb-ink);font:400 12px/1.5 var(--wb-font);cursor:pointer}
.ben-wb .ben-wb__modhead-aside button:hover{background:var(--wb-soft)}
.ben-wb .ben-wb__modbtns button{border:0;background:transparent;box-shadow:none;color:var(--wb-faint)}
.ben-wb .ben-wb__modbtns button:hover:not(:disabled){background:var(--wb-soft);color:var(--wb-ink)}
.ben-wb .ben-wb__viewswitch{gap:18px}
.ben-wb .ben-wb__viewswitch button,.ben-wb .ben-wb__viewswitch button[data-on=true]{padding:2px 0;border:0;border-radius:0;background:transparent;box-shadow:none;color:var(--wb-faint);font-size:var(--wb-fs-body)}
.ben-wb .ben-wb__viewswitch button:hover:not(:disabled){background:transparent;color:var(--wb-ink)}
.ben-wb .ben-wb__viewswitch button[data-on=true],.ben-wb .ben-wb__viewswitch button[aria-pressed=true],.ben-wb .ben-wb__viewswitch button[aria-selected=true]{color:var(--wb-ink);font-weight:600;box-shadow:inset 0 -1px 0 var(--wb-ink)}

/* ── 窗口槽外层:粒子、机器人、气泡不动;只理顺摘要与输入的层级 ── */
.ben-wb .ben-wb__land-stage>.ben-wb__mod>.ben-wb__card--fill,.ben-wb .ben-wb__body .ben-wb__card--fill:not(.ben-wb__card){background:var(--wb-paper);border:0;box-shadow:none;border-radius:var(--wb-r-card)}
.ben-wb .ben-wb__items-center .ben-wb__particle-mode{color:var(--wb-ink);font-size:17px;font-weight:600;letter-spacing:-.2px}
.ben-wb .ben-wb__items-center .ben-wb__orb-counts:not(.ben-wb__orb-counts--large){color:var(--wb-sub);font-size:var(--wb-fs-body);font-weight:400}
.ben-wb .ben-wb__items-report{color:var(--wb-faint);font-size:var(--wb-fs-source)}
.ben-wb .ben-wb__task-stage-heading{color:var(--wb-faint);font-size:var(--wb-fs-meta)}
.ben-wb .ben-wb__task-stage-heading b{color:var(--wb-sub);font-weight:600}
.ben-wb .ben-wb__other-items>summary{color:var(--wb-faint);font-size:var(--wb-fs-meta)}
/* 会话气泡只修底部那行近况被截一半(设计稿「仅补全气泡底部近况」):卡高由布局算定,收一点内边距与行距,
   让近况整行露出来。颜色、描边、圆角、头像与光效一律不动。 */
.ben-wb .ben-wb__task-constellation button{padding-top:11px;padding-bottom:10px;gap:5px}
.ben-wb .ben-wb__task-constellation .ben-wb__task-progress{flex:none;line-height:1.4}

/* ── 项目区总览:项目名后先给结论,再给时刻与分支;三项之间发丝线 ── */
.ben-wb .ben-wb__projects .ben-wb__scroll{gap:0}
.ben-wb .ben-wb__pj,.ben-wb .ben-wb__pj[data-tone]{padding:18px 0 20px;border:0;border-bottom:var(--wb-hair) solid var(--wb-line);border-radius:0;background:transparent;box-shadow:none}
.ben-wb .ben-wb__pj-head{align-items:baseline}
.ben-wb .ben-wb__pj-name{color:var(--wb-ink);font-size:var(--wb-fs-name);font-weight:700;letter-spacing:-.3px}
.ben-wb :is(.ben-wb__pj-stage,.ben-wb__pj-risk:not([data-risk=tight]):not([data-risk=late])){margin-left:auto;padding:0;background:transparent;color:var(--wb-sub);font-size:var(--wb-fs-source);font-weight:500;letter-spacing:.3px}
.ben-wb .ben-wb__pj-risk:is([data-risk=tight],[data-risk=late]){padding:0 5px;border:var(--wb-hair) solid currentColor;border-radius:var(--wb-r-chip);background:transparent;color:var(--dsw-alias-state-warn-label);font-size:var(--wb-fs-source)}
.ben-wb .ben-wb__pj-status{color:var(--wb-ink);font-size:var(--wb-fs-title);font-weight:600}
.ben-wb .ben-wb__pj-status-meta{color:var(--wb-faint);font-size:var(--wb-fs-source);font-weight:400}
.ben-wb .ben-wb__pj-activity{color:var(--wb-faint);font-size:var(--wb-fs-source)}
.ben-wb .ben-wb__pj-calc:not(.ben-wb__pj-calc--error){color:var(--wb-sub);font-family:var(--wb-font);font-size:var(--wb-fs-body)}
.ben-wb .ben-wb__pj-others>summary{color:var(--wb-sub);font-size:var(--wb-fs-body)}
/* 窗口槽、项目区的标题在卡外一行(10-22 拍板 8 / 9 / 11,评审页 \`.slot-tabs\`):高 27、元素间 6、与卡隔 7;
   「窗口槽」10px 弱字、字距 .4;「事务官 / 设置」11px、高 24、内边距 2 / 8,当前那一档纸面底;「收起」照旧排在行末。 */
.ben-wb .ben-wb__modhead--outside{flex:none;display:flex;align-items:center;gap:6px;height:27px;margin:0 0 7px;padding:0;font-size:10px}
.ben-wb .ben-wb__body .ben-wb__modhead--outside .ben-wb__ttl{margin:0;color:var(--wb-faint);font-size:10px;font-weight:400;line-height:1.5;letter-spacing:.4px}
.ben-wb .ben-wb__slotmodes{display:flex;align-items:center;gap:6px}
.ben-wb .ben-wb__slotmodes button{min-height:24px;padding:2px 8px;border:0;border-radius:6px;background:transparent;color:var(--wb-ink);font:400 11px/1.5 var(--wb-font);cursor:pointer}
.ben-wb .ben-wb__slotmodes button:hover{background:var(--wb-soft)}
.ben-wb .ben-wb__slotmodes button[aria-pressed=true]{background:var(--wb-paper)}
/* 窗口槽这张卡圆角 12(评审页 \`.window-slot\`;别的格 16) */
.ben-wb .ben-wb__body .ben-wb__mod[data-module-box=slot]>.ben-wb__card--fill{border-radius:var(--wb-r-window)}
/* 竖屏那一排横标签(稿里没有):卡里没了头,它排在卡顶,上 10、左右 20(同 \`.module-body\`) */
.ben-wb .ben-wb__mod[data-module-box=slot]>.ben-wb__card--fill>.ben-wb__dock{padding:10px 20px 0}
.ben-wb .ben-wb__topbar :is(button,span,b,i){font-family:var(--wb-font)}

/* ── 消耗数据(评审页 \`.module.usage\`):段选 \`.seg\` 10.5px、高 24、内边距 2 / 7、圆角 6,次字,选中 soft 底主字;
   主行 \`.metric-line\` 两端对齐、底对齐、间 18;主数说明 10.5 次字、下 4;主数 32 / 800、行高 1.08、字距 -1.1;
   右侧几个数 \`.metric-side\` 间 16:名 10px 弱字、数 14 / 700 字距 -.3;构成刻度高 8、隔 3、下 7,图例 10px 次字;
   年历块上 12、不画上下线。稿里没有的几块(缓存、使用习惯、未接入、口径)照同类的字:小标题照年历头 10px 次字。 ── */
.ben-wb .ben-wb__usage-seg{gap:2px;padding:0;background:transparent;border:0}
.ben-wb .ben-wb__usage-seg button.ben-wb__usage-segbtn,.ben-wb .ben-wb__usage-seg button.ben-wb__usage-segbtn[data-on=true]{display:inline-flex;align-items:center;justify-content:center;min-height:24px;padding:2px 7px;border:0;border-radius:6px;background:transparent;box-shadow:none;color:var(--wb-sub);font-size:10.5px;font-weight:400;line-height:1.5}
.ben-wb .ben-wb__usage-seg button.ben-wb__usage-segbtn[data-on=true]{background:var(--wb-soft);color:var(--wb-ink)}
.ben-wb .ben-wb__usage-seg button.ben-wb__usage-segbtn:hover:not(:disabled){background:var(--wb-soft);color:inherit}
.ben-wb .ben-wb__usage-tiles{display:flex;align-items:flex-end;gap:18px;margin:0 0 10px}
.ben-wb .ben-wb__usage .ben-wb__usage-tile--primary .ben-wb__usage-tile-v,.ben-wb .ben-wb__usage-hero-v{margin:0;color:var(--wb-ink);font-size:32px;font-weight:800;line-height:1.08;letter-spacing:-1.1px;font-variant-numeric:tabular-nums}
.ben-wb .ben-wb__usage .ben-wb__usage-tile--primary .ben-wb__usage-tile-l{margin-bottom:4px;color:var(--wb-sub);font-size:10.5px;letter-spacing:0}
.ben-wb .ben-wb__usage-activity{display:flex;gap:16px;margin-left:auto;padding-bottom:2px}
.ben-wb .ben-wb__usage-activity .ben-wb__usage-tile{display:flex;flex-direction:column;gap:4px}
.ben-wb .ben-wb__usage-activity .ben-wb__usage-tile-l{color:var(--wb-faint);font-size:10px;letter-spacing:0}
.ben-wb .ben-wb__usage-activity .ben-wb__usage-tile-v{margin:0;color:var(--wb-ink);font-size:14px;font-weight:700;line-height:1.5;letter-spacing:-.3px}
.ben-wb .ben-wb__usage :is(.ben-wb__usage-tile-sub,.ben-wb__usage-hero-l){color:var(--wb-faint);font-size:10px;letter-spacing:0}
.ben-wb__usage-mix{display:flex;flex-direction:column;align-items:stretch;gap:7px;margin:0}
.ben-wb__usage-mix .wb-ui-srungs{flex:none;width:100%;height:8px}
/* 构成图例 \`.provider-legend\`:各家「● 名 数」,间 14、10px 次字;圆点 5px、明度与刻度同序(g4 / g2 / g1);数主字 500、隔 3 */
.ben-wb__usage-mixlegend{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:14px;color:var(--wb-sub);font-size:10px}
.ben-wb__usage-mixlegend>span{display:flex;align-items:center;gap:5px}
.ben-wb__usage-mixlegend i{width:5px;height:5px;border-radius:50%;background:var(--wb-g1)}
.ben-wb__usage-mixlegend i[data-part="0"]{background:var(--wb-g4)}
.ben-wb__usage-mixlegend i[data-part="1"]{background:var(--wb-g2)}
.ben-wb__usage-mixlegend b{margin-left:3px;color:var(--wb-ink);font-weight:500}
.ben-wb .ben-wb__usage-heatwrap{margin:12px 0 4px;padding:0;border:0}
/* 年历:取 Codex 全局评审页 0cf75042 \`#screen=landscape&theme=dark&slot=original\` 消耗数据那格(\`.heat-grid\` / \`.heat-legend\`)。
   一格一天、方格圆角 2、格间 3;**明暗**五档 g0–g4(0 = 没用量也是 g0),不靠大小;还没到的日子只描 1px 线、整体 .3;
   图例「少 ● ● ● ● ● 多」5px 圆点、隔 3,9px 弱字;头 10px 次字,星期 9px 弱字。 */
.ben-wb .ben-wb__usage .ben-wb__usage-heathead{display:flex;align-items:center;justify-content:space-between;gap:0;margin:0 0 6px;color:var(--wb-sub);font-size:10px}
/* 格子下一句 \`.heat-caption\`:10px 弱字、上 6 */
.ben-wb .ben-wb__usage-heatcap{min-height:15px;margin:6px 0 0;color:var(--wb-faint);font-size:10px}
.ben-wb .ben-wb__usage-heatlegend{display:inline-flex;align-items:center;gap:3px;color:var(--wb-faint);font-size:9px}
/* 星期一列宽 12、与格子隔 8,上面空出月份那一行的 15;月份一行 9px 弱字、两端对齐 */
.ben-wb .ben-wb__usage-heat{gap:8px;align-items:stretch}
.ben-wb .ben-wb__usage-heatdays{width:12px;height:auto;padding-top:15px;gap:3px}
.ben-wb .ben-wb__usage-heatdays span{justify-content:flex-start;color:var(--wb-faint);font-size:9px}
.ben-wb__usage-heatmain{flex:1;min-width:0;display:flex;flex-direction:column}
.ben-wb__usage-heatmonths{display:flex;justify-content:space-between;height:15px;color:var(--wb-faint);font-size:9px;line-height:1.5}
.ben-wb .ben-wb__usage-heatgrid{gap:3px}
.ben-wb .ben-wb__usage .ben-wb__usage-heatcell,.ben-wb .ben-wb__usage-heatcell[data-level]{box-sizing:border-box;border-radius:2px;background:var(--wb-g0);box-shadow:none;opacity:1}
/* 没用量的日子也是 g0(surface.ts 那条 0,4,0 的混色压过来过,这里同权重写在后面) */
.ben-wb .ben-wb__usage-heatcell[data-level="0"]:not([data-future=true]){background:var(--wb-g0)}
.ben-wb .ben-wb__usage-heatcell[data-level="1"]{background:var(--wb-g1)}
.ben-wb .ben-wb__usage-heatcell[data-level="2"]{background:var(--wb-g2)}
.ben-wb .ben-wb__usage-heatcell[data-level="3"]{background:var(--wb-g3)}
.ben-wb .ben-wb__usage-heatcell[data-level="4"]{background:var(--wb-g4)}
.ben-wb .ben-wb__usage-heatcell[data-future=true]{background:transparent;border:var(--wb-hair) solid var(--wb-line);box-shadow:none;opacity:.3}
.ben-wb .ben-wb__usage-heatlegend .ben-wb__usage-heatcell{flex:none;width:5px;height:5px;border-radius:50%}
.ben-wb .ben-wb__usage-group h3{color:var(--wb-sub);font-size:10px;font-weight:400}
/* 格脚 \`.module-foot\`:「本机记录 · 12:24」……「来源与口径 ›」,10px 弱字、上 10、贴底;点开是口径 */
.ben-wb .ben-wb__usage-method{margin-top:auto;padding-top:10px}
.ben-wb .ben-wb__usage-method>summary{display:flex;align-items:center;gap:8px;list-style:none;color:var(--wb-faint);font-size:10px;font-weight:400;letter-spacing:.3px;cursor:pointer}
.ben-wb .ben-wb__usage-method>summary::-webkit-details-marker{display:none}
.ben-wb .ben-wb__usage-method>summary>:last-child{margin-left:auto}
/* 残缺 / 没接上的来源 \`.fold\`:上一根线、上 9、10px 次字;「暂未更新 N 家 …… 查看原因 ›」;展开每家上下 5 */
.ben-wb .ben-wb__usage-stale{margin-top:auto;padding-top:9px;border-top:var(--wb-hair) solid var(--wb-line);color:var(--wb-sub);font-size:10px}
.ben-wb .ben-wb__usage-stale>summary{display:flex;align-items:center;gap:6px;list-style:none;cursor:pointer}
.ben-wb .ben-wb__usage-stale>summary::-webkit-details-marker{display:none}
.ben-wb .ben-wb__usage-stale>summary>:last-child{margin-left:auto}
.ben-wb .ben-wb__usage-stale ul{margin:8px 0 0;padding:0;list-style:none}
.ben-wb .ben-wb__usage-stale li{display:flex;gap:8px;padding:5px 0}
.ben-wb .ben-wb__usage-method+.ben-wb__usage-stale,.ben-wb .ben-wb__usage-stale+.ben-wb__usage-method{margin-top:0}
.ben-wb .ben-wb__usage-hint,.ben-wb .ben-wb__usage-note{color:var(--wb-faint);font-size:10px}
.ben-wb .ben-wb__usage-rankfill{background:var(--wb-ink)}
.ben-wb .ben-wb__usage-rankbar{background:var(--wb-g0)}

/* ── 余额 / 额度(评审页 \`.module.quota\`):余额一行 \`.balance\` 底对齐、间 8,下 12 一根线;名 11px 主字、金额 24 / 800 字距 -.8 行高 1 靠右;
   每家一行 \`.quota-row\` 名 58 | 刻度 | 数 44、间 10、行间 11,字 11;档名 9px 弱字宽 16、与刻度隔 9;刻度高 5、一格 5% 隔 3;
   数 12 / 700 行高 13 靠右。最底一行 \`.fold\`:上一根线、上 9、10px 次字,右端「查看详情 ›」;展开每家一行(上下 5、间 8、键靠右)。
   「说明」稿里没有,照旧(10px 弱字)。 ── */
.ben-wb .ben-wb__usage-quotagrid{gap:11px}
.ben-wb .ben-wb__usage-q{grid-template-columns:58px minmax(0,1fr) auto;column-gap:10px;align-items:start;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;font-size:11px}
.ben-wb .ben-wb__usage-q[data-kind=balance]{display:flex;align-items:baseline;gap:8px;padding:0 0 12px;border-bottom:var(--wb-hair) solid var(--wb-line)}
.ben-wb .ben-wb__usage-q[data-kind=balance] .ben-wb__usage-qval{margin-left:auto}
.ben-wb .ben-wb__usage-quotagrid[aria-label="余额"]{margin-bottom:11px}
/* 名字后那半「· 余额」、各家之上那句口径、格脚,都是评审页的 \`.source\` / \`.module-foot\`:10px 弱字 */
.ben-wb .ben-wb__usage-qsrc{color:var(--wb-faint);font-size:10px;letter-spacing:.4px}
.ben-wb .ben-wb__usage-qscale{margin:0 0 12px;color:var(--wb-faint);font-size:10px;letter-spacing:.4px}
.ben-wb .ben-wb__usage-qfoot{display:flex;align-items:center;gap:8px;margin:auto 0 0;padding-top:10px;color:var(--wb-faint);font-size:10px;letter-spacing:.3px}
.ben-wb .ben-wb__usage-qfoot>:last-child{margin-left:auto}
.ben-wb .ben-wb__usage-qfoot+.ben-wb__usage-qmore{margin-top:0}
.ben-wb .ben-wb__usage-q .ben-wb__usage-qname{color:var(--wb-ink);font-size:11px;font-weight:400;line-height:1.5}
.ben-wb .ben-wb__usage-qval,.ben-wb .ben-wb__usage-qval[data-level]{color:var(--wb-ink);font-size:24px;font-weight:800;line-height:1;letter-spacing:-.8px;font-variant-numeric:tabular-nums}
.ben-wb .ben-wb__usage-qbars{gap:7px;padding-top:2px}
.ben-wb .ben-wb__usage-qbar{grid-template-columns:16px minmax(16px,1fr) 44px;gap:9px}
.ben-wb .ben-wb__usage-qbar .ben-wb__usage-qlabel{width:16px;min-width:0;color:var(--wb-faint);font-size:9px;line-height:1.5}
.ben-wb .ben-wb__usage-qbar .ben-wb__usage-qpct,.ben-wb .ben-wb__usage-qbar .ben-wb__usage-qpct[data-level]{color:var(--wb-ink);font-size:12px;font-weight:700;line-height:13px;font-variant-numeric:tabular-nums}
.ben-wb .ben-wb__usage-qtrack{height:5px;border-radius:0;background:var(--wb-g0);-webkit-mask:repeating-linear-gradient(90deg,#000 0 calc(5% - 3px),transparent calc(5% - 3px) 5%);mask:repeating-linear-gradient(90deg,#000 0 calc(5% - 3px),transparent calc(5% - 3px) 5%)}
.ben-wb .ben-wb__usage-qtrack i,.ben-wb .ben-wb__usage-qtrack i[data-level]{height:100%;border-radius:0;background:var(--wb-ink)}
.ben-wb .ben-wb__usage-qtrack i[data-fill=full]{background:var(--wb-g2)}
.ben-wb .ben-wb__usage-qdetails>summary{color:var(--wb-faint);font-size:10px;letter-spacing:.3px;cursor:pointer}
.ben-wb .ben-wb__usage-qnote{color:var(--wb-sub);font-size:10px}
.ben-wb .ben-wb__usage-qmore{margin-top:auto;padding-top:9px;border-top:var(--wb-hair) solid var(--wb-line);color:var(--wb-sub);font-size:10px}
.ben-wb .ben-wb__usage-qmore>summary{display:flex;align-items:center;gap:6px;list-style:none;color:var(--wb-sub);font-size:10px;letter-spacing:0;cursor:pointer}
.ben-wb .ben-wb__usage-qmore>summary>span:last-child{margin-left:auto}
.ben-wb .ben-wb__usage-qmore>summary::-webkit-details-marker{display:none}
.ben-wb .ben-wb__usage-qmore>.ben-wb__usage-quotagrid{gap:0;margin-top:8px}
.ben-wb .ben-wb__usage-qmore :is(.ben-wb__usage-q,.ben-wb__unlock-card){display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:5px 0;border:0;background:transparent;font-size:10px;color:var(--wb-sub)}
.ben-wb .ben-wb__usage-qmore .ben-wb__usage-qbars{flex:1;min-width:0;padding:0}
.ben-wb .ben-wb__usage-qmore .ben-wb__usage-qbar{display:flex;gap:8px}
.ben-wb .ben-wb__usage-qmore .ben-wb__usage-qtrack{display:none}
.ben-wb .ben-wb__usage-qmore .ben-wb__usage-q .ben-wb__usage-qpct,.ben-wb .ben-wb__usage-qmore .ben-wb__agentq[data-state] .ben-wb__usage-qpct{font-size:10px;font-weight:400;line-height:1.5;color:var(--wb-sub);text-align:left}
.ben-wb .ben-wb__usage-qmore .ben-wb__usage-q .ben-wb__usage-qname,.ben-wb .ben-wb__usage-qmore .ben-wb__unlock-card .ben-wb__unlock-name{color:var(--wb-sub);font-size:10px}
.ben-wb .ben-wb__usage-qmore :is(button,.ben-wb__agentq-actions){margin-left:auto}

/* ── 随手记 / 系统文件夹(评审页 .module.notes / .module.files)
   2026-10-23(分层二刀二):这两格由用户层的小组件画,**只服务这两格**的那两组规则
   搬进各自组件(起步层 小组件/notes|files/index.js 渲染的 <style>),本体不留双份。
   级联等价:那些选择器都带 .ben-wb 前缀,特异度高于组件自己的单子类规则,挪进组件
   <style>(在整份 STYLE 之后)胜家不变;「竖屏那一条」里随记条目的补丁并回组件那一份、
   保原相对顺序(主体在前补丁在后)。守军用例:client-user-layer-skin-guard。 ── */

/* ── 日结条(评审页 \`.daily-strip\`):纸面底、圆角 8、左右 12、高 36、元素间 24、字 11;
   按钮里间 20:「日结」12 主字、几项各 数 14 / 800 · 名 12 · 点(间 4),「一点一件」10px 弱字排在最后;
   右端「AI 悬浮窗(收起)— 不可改」10px 弱字、不加框。「展开完整日结 ↗」稿里没有,照旧(10px 弱字)。 ── */
.ben-wb .ben-wb__footbar{display:flex;align-items:center;gap:24px;min-height:36px;margin-top:10px;padding:0 12px;border:0;border-radius:8px;background:var(--wb-paper);box-shadow:none;color:var(--wb-ink);font-size:11px;line-height:1.5}
.ben-wb[data-orientation=portrait] .ben-wb__footbar{min-height:38px}
.ben-wb .ben-wb__daily-toggle{display:flex;align-items:center;gap:20px;min-height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--wb-ink);font:400 12px/1.5 var(--wb-font);white-space:nowrap;cursor:pointer}
.ben-wb .ben-wb__daily-toggle:hover{background:var(--wb-soft);color:var(--wb-ink)}
.ben-wb__daily-date{color:var(--wb-ink)}
.ben-wb__daily-day,.ben-wb__daily-cap{color:var(--wb-faint);font-size:10px;letter-spacing:.4px}
.ben-wb__daily-count{display:inline-flex;align-items:center;gap:7px}
.ben-wb__daily-count b{color:var(--wb-ink);font:800 14px/1.5 var(--wb-font);letter-spacing:0}
.ben-wb__daily-count>span:not(.wb-ui-tally){color:var(--wb-ink);font-size:12px}
.ben-wb__daily-count .wb-ui-tally{max-width:120px;gap:4px}
.ben-wb .ben-wb__lock{margin-left:auto;padding:0;border:0;border-radius:0;background:transparent;color:var(--wb-faint);font-family:var(--wb-font);font-size:10px;white-space:nowrap}

/* ── 设置(评审页 \`slot=settings\` 的 \`.settings-shell\`,填满窗口槽):纸面底、不加框;
   头高 47、左右 24、元素间 14、底一根线,「设置」14 / 600,副题 11px 次字,✕ 26×26;
   左栏 180、上下 20 左右 12、右一根线,一组高 34、内边距 8 / 10、圆角 6、字 12,当前那组 soft 底 600;栏底小字 10px 弱字;
   正文上下 24 左右 28,组名 16 / 600、下 20;每节上一根线、上 16,节名 13 / 600、下 8,说明 11 / 1.8 次字;
   槽宽 ≥ 1000 两列(间 28 / 32),< 1000 一列、左栏 150、正文 20,< 680 分组横排,< 560 左栏 140。
   组首的入口行稿里是一排跳转小钮(\`.settings-jump\`),这里照旧是入口行(样子照稿里的设置行 \`.setting-row\`)。 ── */
.ben-wb .ben-wb__setdlg-backdrop{align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--wb-back) 72%,transparent)}
.ben-wb .ben-wb__setdlg{container-type:inline-size;box-sizing:border-box;width:min(826px,94vw);height:min(623px,88vh);max-height:none;gap:0;padding:0;overflow:hidden;border:0;border-radius:var(--wb-r-window);background:var(--wb-paper);color:var(--wb-ink);box-shadow:none;font:400 13px/1.5 var(--wb-font)}
.ben-wb .ben-wb__setdlg-head{flex:none;justify-content:flex-start;align-items:center;gap:14px;height:47px;padding:0 24px;border-bottom:var(--wb-hair) solid var(--wb-line)}
.ben-wb .ben-wb__setdlg-head .ben-wb__ttl{margin:0;color:var(--wb-ink);font-size:14px;font-weight:600;line-height:1.5}
.ben-wb__setdlg-sub{color:var(--wb-sub);font-size:11px}
.ben-wb .ben-wb__setdlg-head button{display:inline-flex;align-items:center;justify-content:center;margin-left:auto;width:26px;min-height:26px;padding:4px;border:0;border-radius:6px;background:transparent;color:var(--wb-ink);font-size:12px}
.ben-wb .ben-wb__setdlg-head button:hover{color:var(--wb-ink);background:var(--wb-soft)}
.ben-wb__setbody{flex:1;min-height:0;display:grid;grid-template-columns:180px minmax(0,1fr)}
.ben-wb__setside{display:flex;flex-direction:column;min-height:0;padding:20px 12px;border-right:var(--wb-hair) solid var(--wb-line);overflow:auto}
.ben-wb .ben-wb__setnav{flex-direction:column;flex-wrap:nowrap;gap:0}
.ben-wb .ben-wb__setnav button{position:relative;width:100%;min-height:34px;margin:2px 0;padding:8px 10px;border:0;border-radius:6px;background:transparent;color:var(--wb-ink);font-size:12px;font-weight:400;line-height:1.5;text-align:left;white-space:normal}
.ben-wb .ben-wb__setnav button:hover{background:var(--wb-soft);color:var(--wb-ink)}
.ben-wb .ben-wb__setnav button[aria-selected=true]{background:var(--wb-soft);border:0;color:var(--wb-ink);font-weight:600}
.ben-wb__setnav-foot{margin:20px 10px 4px;padding:0;color:var(--wb-faint);font-size:10px}
.ben-wb .ben-wb__setgrp{gap:0;min-height:0;overflow-y:auto;padding:24px 28px;scrollbar-width:thin;scrollbar-color:var(--wb-line) transparent}
/* 组首 \`.setting-heading\`:组名 16 / 600、下一句说明 11 次字上 5,右边 ? ;与下面隔 20。跳转小钮 \`.settings-jump\`:间 5、上 -5 下 20,
   10.5px、soft 底、高 24、内边距 3 / 8 */
.ben-wb__setgrp-head{display:flex;align-items:flex-start;gap:20px;margin:0 0 20px}
.ben-wb__setgrp-head>div{flex:1;min-width:0}
.ben-wb__setgrp-ttl{margin:0;color:var(--wb-ink);font:600 16px/1.5 var(--wb-font)}
.ben-wb__setgrp-desc{margin:5px 0 0;color:var(--wb-sub);font-size:11px;line-height:1.5}
.ben-wb__setgrp-help{position:relative;flex:none}
.ben-wb .ben-wb__setgrp-help>button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--wb-sub);cursor:pointer}
.ben-wb .ben-wb__setgrp-help>button:hover{background:var(--wb-soft);color:var(--wb-ink)}
.ben-wb__setgrp-help .wb-ui-pop{width:260px}
.ben-wb__setjump{display:flex;flex-wrap:wrap;gap:5px;margin:-5px 0 20px}
.ben-wb .ben-wb__setjump>button{min-height:24px;padding:3px 8px;border:0;border-radius:6px;background:var(--wb-soft);color:var(--wb-ink);font:400 10.5px/1.5 var(--wb-font);cursor:pointer}
.ben-wb .ben-wb__setjump>button:hover{background:var(--wb-field)}
.ben-wb__setsec{scroll-margin-top:20px}
.ben-wb .ben-wb__setdlg .ben-wb__card{padding:16px 0 0;margin-bottom:28px;border:0;border-top:var(--wb-hair) solid var(--wb-line);border-radius:0;background:transparent;box-shadow:none}
.ben-wb .ben-wb__setdlg .ben-wb__card>:is(h2,h3),.ben-wb .ben-wb__setdlg .ben-wb__card :is(h2,h3).ben-wb__ttl{margin:0 0 8px;color:var(--wb-ink);font-size:13px;font-weight:600;line-height:1.5}
.ben-wb .ben-wb__setdlg .ben-wb__card :is(p,li,label){font-size:12px;line-height:1.5}
.ben-wb .ben-wb__setdlg .ben-wb__card>p{margin:0 0 12px;color:var(--wb-sub);font-size:11px;line-height:1.8}
.ben-wb .ben-wb__setdlg :is(.ben-wb__set-primary){min-height:28px;padding:4px 9px;border:0;border-radius:6px;background:var(--wb-ink);color:var(--wb-reverse);font-size:12px;font-weight:400}
.ben-wb .ben-wb__setdlg .ben-wb__set-lnk{color:var(--wb-ink);font-size:12px;text-underline-offset:4px}
.ben-wb .ben-wb__setdlg :is(input[type=text],input[type=number],input[type=password],input:not([type]),textarea,select){padding:7px 9px;border:1px solid transparent;border-radius:6px;background:var(--wb-soft);color:var(--wb-ink);font-family:var(--wb-font);font-size:12px}
.ben-wb .ben-wb__setdlg :is(input,textarea,select):focus{outline:0;border-color:var(--wb-faint)}
.ben-wb .ben-wb__setgrp-empty{color:var(--wb-faint)}
@container (min-width:1000px){
  .ben-wb .ben-wb__setgrp{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:32px;align-content:start}
  .ben-wb .ben-wb__setgrp>:not(.ben-wb__setsec){grid-column:1/-1}
}
@container (max-width:999px){
  .ben-wb__setjump{gap:4px}
  .ben-wb__setbody{grid-template-columns:150px minmax(0,1fr)}
  .ben-wb .ben-wb__setgrp{padding:20px}
}
@container (max-width:680px){
  .ben-wb__setbody{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
  .ben-wb__setside{padding:7px 10px;border-right:0;border-bottom:var(--wb-hair) solid var(--wb-line)}
  .ben-wb .ben-wb__setnav{flex-direction:row;flex-wrap:nowrap;gap:4px;overflow:auto}
  .ben-wb .ben-wb__setnav button{width:auto;flex:none;margin:0;min-height:28px;padding:4px 8px;font-size:11px}
  .ben-wb__setnav-foot{display:none}
  .ben-wb .ben-wb__setgrp{padding:16px}
  .ben-wb .ben-wb__setdlg-head{padding:0 16px}
  .ben-wb__setgrp-head{margin-bottom:16px}
  .ben-wb__setgrp-ttl{font-size:14px}
  .ben-wb__setjump,.ben-wb__setgrp-help{display:none}
}

/* ── 各格第一次用的空态(评审页「状态 · 空态」那一档的 \`.empty-inline\`):居中一列、间 9、内边距 18 / 14、高至少 95;
   字 11 / 1.7 次字、宽至多 280;按钮 = 次按钮(1px 线框、圆角 6、字 11、高 28、内边距 4 / 9)。
   每格「图标 22 + 标题 13 / 600 + 一句说明 + 次按钮 →」(10-22 拍板 23 补齐)。窗口槽那一格(浮在槽上)照旧靠左上。 ── */
.ben-wb .ben-wb__emptyfirst{align-items:center;justify-content:center;gap:9px;min-height:95px;padding:18px 14px;border:0;border-radius:0;background:transparent;text-align:center}
.ben-wb .ben-wb__emptyfirst>.wb-ui-ico{margin-bottom:3px;color:var(--wb-faint)}
.ben-wb .ben-wb__emptyfirst-title{margin:0;color:var(--wb-ink);font:600 13px/1.5 var(--wb-font)}
.ben-wb .ben-wb__emptyfirst-line{margin:0;max-width:280px;color:var(--wb-sub);font-size:11px;line-height:1.7}
.ben-wb .ben-wb__emptyfirst-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:28px;padding:4px 9px;border:1px solid var(--wb-line);border-radius:6px;background:transparent;color:var(--wb-ink);font-size:11px}
.ben-wb .ben-wb__emptyfirst-btn:hover{background:var(--wb-soft);color:var(--wb-ink)}
.ben-wb .ben-wb__emptyfirst[data-overlay=true]{align-items:flex-start;justify-content:flex-start;min-height:0;text-align:left}
.ben-wb .ben-wb__emptyfirst[data-overlay=true] .ben-wb__emptyfirst-line{color:var(--wb-faint)}

/* ── 顶栏「N 家」与每家的小卡(评审页 \`.top-agent-popover\`):纸面底、1px 线、圆角 9、内边距 14、投影、字 12 / 1.6;
   卡头间 8、下 12;每家一行间 9、上下 8、上一根线,名 500,状态 10px 次字靠右;卡脚 10px 弱字。 ── */
.ben-wb :is(.ben-wb__agentcount-card,.ben-wb__lampcard){padding:14px;border:var(--wb-hair) solid var(--wb-line);border-radius:9px;background:var(--wb-paper);box-shadow:var(--wb-shadow-pop);color:var(--wb-ink);font:400 12px/1.6 var(--wb-font)}
.ben-wb .ben-wb__agentcount-title{margin:0 0 12px;color:var(--wb-ink);font-size:12px;font-weight:600}
.ben-wb .ben-wb__agentcount-list{gap:0}
.ben-wb .ben-wb__agentcount-row{gap:2px 9px;padding:8px 0;border-top:var(--wb-hair) solid var(--wb-line)}
.ben-wb .ben-wb__agentcount-name{color:var(--wb-ink);font-weight:500}
.ben-wb :is(.ben-wb__agentcount-why,.ben-wb__agentcount-n){color:var(--wb-sub);font-size:10px}
/* 协作区成员标签上那张(同一张卡,挂在工作台根上按视口摆,不被横滑的那一排裁掉) */
.ben-wb__lamphover{display:inline-flex}
.ben-wb .ben-wb__lampcard--float{position:fixed;z-index:70;margin:0}
/* 成员标签里的图标同顶栏那颗:受保护的 AgentIcon 原样 16,不另画 */
.ben-wb .ben-cl__people .ben-cl__person .ben-wb__agenticon,.ben-wb .ben-cl__people .ben-cl__person .ben-wb__dotmini{flex:none}
.ben-wb .ben-wb__lampcard-state{color:var(--wb-ink)}
.ben-wb :is(.ben-wb__lampcard-note,.ben-wb__lampcard-reads){color:var(--wb-faint);font-size:10px}
.ben-wb .ben-wb__lampcard .ben-wb__agent-actions button{min-height:28px;padding:4px 9px;border:1px solid var(--wb-line);border-radius:6px;background:transparent;color:var(--wb-ink);font-size:11px}

/* ── 完整日结(评审页点日结条弹出的 \`.modal\`「日结 · 10 月 20 日」,10-22 拍板照稿):遮罩 #0007、内边距 24,居中一张宽 620;
   纸面底、圆角 12、投影;头 16 / 20 下一根线、标题 14 / 600;身 20、12 / 1.85;每一节上一根线、上 16,节名 13 / 600,内容 11 / 1.8 次字。
   量得到窗位时遮罩只盖窗位那块(窗让开后不露空白,09-14),那一张居中其中。 ── */
.ben-wb .ben-wb__daily-veil{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--wb-veil)}
.ben-wb .ben-wb__daily-veil.ben-wb__dlg-cover{right:auto;bottom:auto}
.ben-wb .ben-wb__daily-pop{position:static;display:flex;flex-direction:column;width:min(620px,100%);max-width:none;max-height:100%;overflow:hidden;padding:0;border:0;border-radius:var(--wb-r-window);background:var(--wb-paper);box-shadow:var(--wb-shadow-modal);color:var(--wb-ink);font:400 12px/1.85 var(--wb-font)}
.ben-wb .ben-wb__daily-head{flex:none;display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:var(--wb-hair) solid var(--wb-line)}
.ben-wb .ben-wb__daily-head>h2{flex:1;margin:0;color:var(--wb-ink);font:600 14px/1.5 var(--wb-font)}
.ben-wb .ben-wb__daily-head>button{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:4px 9px;border:0;border-radius:6px;background:transparent;color:var(--wb-ink);cursor:pointer}
.ben-wb .ben-wb__daily-head>button:hover{background:var(--wb-soft)}
.ben-wb .ben-wb__daily-body{min-height:0;overflow:auto;padding:20px}
/* 顶上三个大数 \`.daily-stats\`:三列、间 20、下 20;数 30 / 800 字距 -1;名 11 次字、上 4 下 10;点列宽至多 92 */
.ben-wb .ben-wb__daily-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin:0 0 20px}
.ben-wb .ben-wb__daily-stats strong{display:block;color:var(--wb-ink);font:800 30px/1.2 var(--wb-font);letter-spacing:-1px}
.ben-wb .ben-wb__daily-stats span:not(.wb-ui-tally):not(.wb-ui-dot){display:block;margin:4px 0 10px;color:var(--wb-sub);font-size:11px}
.ben-wb .ben-wb__daily-stats .wb-ui-tally{max-width:92px}
.ben-wb .ben-wb__daily-sec{margin:0;padding-top:16px;border-top:var(--wb-hair) solid var(--wb-line)}
.ben-wb .ben-wb__daily-sec+.ben-wb__daily-sec{margin-top:18px}
.ben-wb .ben-wb__daily-sec-t{margin:0 0 8px;color:var(--wb-ink);font-size:13px;font-weight:600;line-height:1.5}
.ben-wb .ben-wb__daily-line{margin:0;color:var(--wb-sub);font-size:11px;line-height:1.8}

/* ── 外层几处「没办成」的那一句(10-22 拍板 24):形状照评审页 \`.field-error\` —— 左 2px 线、soft 底、内边距 7 / 10、字 11;
   颜色保留宿主语义红(10-21 拍板语义色保留),不改成稿里的主字色。 ── */
.ben-wb :is(.ben-wb__pj-calc--error,.ben-wb__laid-err,.ben-wb__layoutask-err,.ben-wb__devtool-ask-err,.ben-wb__quotaask-err,.ben-wb__qask-err,.ben-wb__evolveask-err,.ben-wb__topics-err,.ben-wb__tophint-err){padding:7px 10px;border:0;border-left:2px solid var(--dsw-alias-state-error-primary);border-radius:0;background:var(--wb-soft);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:1.6}

/* ── 外层弹层(功能点详情、接上 Claude / Codex)照评审页 \`.overlay\` / \`.modal\`:遮罩 #0007、内边距 24;
   框纸面底、无边、圆角 12、宽 620、投影;头 16 / 20 下一根线,正文 20、12 / 1.85。「接上」那张没有分头身,只取外框与标题 14。 ── */
.ben-wb .ben-wb__dlg-scrim,.ben-wb .ben-wb__hookapply-mask{padding:24px;background:var(--wb-veil)}
.ben-wb .ben-wb__dlg,.ben-wb .ben-wb__board .ben-wb__dlg,.ben-wb .ben-wb__hookapply{width:min(620px,100%);border:0;border-radius:var(--wb-r-window);background:var(--wb-paper);box-shadow:var(--wb-shadow-modal)}
.ben-wb .ben-wb__dlg-head{gap:12px;padding:16px 20px;border-bottom:var(--wb-hair) solid var(--wb-line)}
.ben-wb .ben-wb__dlg-body{padding:20px;font-size:12px;line-height:1.85}
.ben-wb .ben-wb__hookapply-title{font-size:14px;font-weight:600}

/* 竖屏那一条场景条的小修(随记条目那条补丁随小组件搬走了,2026-10-23 分层二刀二) */
.ben-wb .ben-wb__scenebar :is(button){border:0;background:transparent;box-shadow:none;color:var(--wb-sub);font-size:var(--wb-fs-body)}
.ben-wb .ben-wb__scenebar :is(button):hover:not(:disabled){background:var(--wb-soft);color:var(--wb-ink)}

/* ── 10-21 main 新加的几处:首页「现在能做什么」、引导三件事的行、实验开关、用户层 ── */
.ben-wb .ben-wb__capcard{gap:6px;padding:12px 0 4px;border:0;border-top:var(--wb-hair) solid var(--wb-line);border-radius:0;background:transparent;font-family:var(--wb-font);font-size:var(--wb-fs-body)}
.ben-wb .ben-wb__capcard h2{color:var(--wb-ink);font-size:var(--wb-fs-title);font-weight:600}
.ben-wb .ben-wb__capcard ul{gap:0;margin-top:6px}
.ben-wb .ben-wb__capcard li{padding:6px 0;border-bottom:var(--wb-hair) solid var(--wb-line)}
.ben-wb .ben-wb__capcard li:last-child{border-bottom:0}
.ben-wb .ben-wb__capcard-line>span:first-child{color:var(--wb-ink);font-weight:500}
.ben-wb .ben-wb__capcard-line>span:last-child{color:var(--wb-sub);font-size:var(--wb-fs-meta)}
.ben-wb .ben-wb__capcard li[data-kind="beta"] .ben-wb__capcard-line>span{color:var(--wb-faint)}
.ben-wb .ben-wb__capcard-closing{color:var(--wb-faint);font-size:var(--wb-fs-source)}
.ben-wb .ben-wb__firstuse-row{padding:10px 0;border-radius:0;background:transparent;border-bottom:var(--wb-hair) solid var(--wb-line)}
.ben-wb .ben-wb__firstuse-row[data-current="true"]{outline:0;box-shadow:inset 2px 0 0 var(--wb-ink);padding-left:10px}
.ben-wb .ben-wb__firstuse-head{color:var(--wb-ink);font-family:var(--wb-font)}
.ben-wb .ben-wb__firstuse-state,.ben-wb .ben-wb__firstuse-row[data-state="ok"] .ben-wb__firstuse-state{color:var(--wb-sub)}
.ben-wb .ben-wb__firstuse-door{color:var(--wb-sub)}
/* 设置里的勾选框一律画成开关(实验开关、各节里的开 / 关) */
.ben-wb .ben-wb__setdlg input[type=checkbox]{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:30px;height:17px;margin:0;border:0;border-radius:99px;background:var(--wb-g1);cursor:pointer;transition:background-color .15s ease}
.ben-wb .ben-wb__setdlg input[type=checkbox]:hover:not(:disabled){background:var(--wb-faint)}
.ben-wb .ben-wb__setdlg input[type=checkbox]::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--wb-paper);transition:transform .15s ease}
.ben-wb .ben-wb__setdlg input[type=checkbox]:checked{background:var(--wb-ink)}
.ben-wb .ben-wb__setdlg input[type=checkbox]:checked::after{transform:translateX(13px)}
.ben-wb .ben-wb__setdlg input[type=checkbox]:disabled{opacity:.35;cursor:default}
.ben-wb .ben-wb__setdlg .ben-wb__cred-hint{color:var(--wb-sub);font-size:var(--wb-fs-meta)}
.ben-wb .ben-wb__setdlg .ben-wb__module-row{padding:8px 0;border:0;border-bottom:var(--wb-hair) solid var(--wb-line);border-radius:0;background:transparent}
.ben-wb .ben-wb__setdlg .ben-wb__module-row-name{color:var(--wb-ink);font-weight:500}
.ben-wb .ben-wb__setdlg .ben-wb__module-row-note{color:var(--wb-sub);font-size:var(--wb-fs-meta)}
.ben-wb .ben-wb__setdlg h3.ben-wb__module-row-note{margin:14px 0 2px;color:var(--wb-ink);font-size:var(--wb-fs-title);font-weight:600}
/* 用户层小组件没装时那一句(随手记、图谱那一格的占位):照空态的字号 */
.ben-wb .ben-wb__body .ben-wb__card>.ben-wb__module-row-note{margin:auto 0;padding:0 4px;color:var(--wb-faint);font-size:12px;line-height:1.5;text-align:center}

/* ── 协作区的「设置」:盖在协作区上的一层,✕ / Esc / 点遮罩关(Codex 全局评审页 0cf75042 \`#screen=landscape&theme=dark&slot=original\`
   项目区那格嵌的协作区组件 \`设计-协作区视觉-A-2026-10-21.html?embed=workbench&theme=dark\`,837 × 921,点 ⚙ 之后)。
   遮罩 #0008、内边距 24;弹层纸面底、1px 线、圆角 12、宽至多 900、阴影 0 24 100 #0006;头 14 / 20、标题 13 / 700、✕ 30 高;
   身 22;左栏 155 宽、右边 1px 线、内边距 15 / 10,一组 12px、高 30、内边距 6 / 9、圆角 6、间 5,当前那组 field 底(字重不变);正文 20。
   颜色走令牌:原型的 #1c1c1c → paper、#3c3c3c → line、#303030 → field、#efefef → ink。 ── */
.ben-wb .ben-cl__setveil{position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--wb-veil-deep)}
.ben-wb .ben-cl__setdlg{box-sizing:border-box;display:flex;flex-direction:column;width:min(900px,100%);max-height:100%;overflow:hidden;border:var(--wb-hair) solid var(--cl-line);border-radius:var(--wb-r-window);background:var(--cl-paper);color:var(--cl-fg);box-shadow:var(--wb-shadow-dlg)}
.ben-wb .ben-cl__setdlg-head{flex:none;display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:var(--wb-hair) solid var(--cl-line)}
.ben-wb .ben-cl__setdlg-head>strong{flex:1;font-size:13px;font-weight:700}
.ben-wb .ben-cl__setdlg-head>button{display:inline-flex;align-items:center;justify-content:center;min-height:30px;padding:6px 9px;border:1px solid transparent;border-radius:6px;color:var(--cl-fg)}
.ben-wb .ben-cl__setdlg-head>button svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.ben-wb .ben-cl__setdlg-body{min-height:0;overflow:auto;padding:22px}
.ben-wb .ben-cl__settings{display:flex;min-height:420px;gap:0;max-width:none}
.ben-wb .ben-cl__settings>nav{flex:none;display:block;width:155px;box-sizing:border-box;padding:15px 10px;border-right:var(--wb-hair) solid var(--cl-line)}
.ben-wb .ben-cl__settings>nav>button{display:flex;align-items:center;justify-content:flex-start;width:100%;min-height:30px;margin:0 0 5px;padding:6px 9px;border:1px solid transparent;border-radius:6px;font-size:12px;font-weight:400;text-align:left}
.ben-wb .ben-cl__settings>nav>button[aria-pressed=true]{background:var(--cl-field);color:var(--cl-fg);font-weight:400}
.ben-wb .ben-cl__setbody{flex:1;min-width:0;padding:20px}
/* 设置里的回执要露在遮罩上面(原型的提示条 z-index 60,高过遮罩的 20) */
.ben-wb .ben-cl__receipt{z-index:11}

/* 事务官浮窗里放那页事务官(10-22 浮窗两态):展开最小尺寸 520 × 680(照旧能拉伸) */
.ben-wb .ben-wb__butler:not([data-narrow=true]):not([style*=width]){width:520px;height:680px}
.ben-wb .ben-wb__butler:not([data-narrow=true]){min-width:520px;min-height:680px}
.ben-wb__butler-page{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
/* 协作区全屏(10-22 第三轮 5):盖住整个工作台(顶栏也让开),四周留 16、圆角 12 的纸面一张;「退出全屏」带线框、带字,一眼看得出 */
.ben-wb .ben-wb__collab-full{position:fixed;inset:0;z-index:58;box-sizing:border-box;padding:16px;background:var(--wb-back)}
.ben-wb .ben-wb__collab-full>.ben-cl{inset:16px;border-radius:var(--wb-r-window);overflow:hidden}
.ben-wb .ben-cl .ben-cl__head .ben-cl__exitfull{border-color:var(--wb-line);color:var(--wb-ink)}
`
