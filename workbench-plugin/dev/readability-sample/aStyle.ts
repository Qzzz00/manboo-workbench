/**
 * 工作台可读性 · 样张 A 的原型样式(2026-10-21),只给 `dev/readability-sample` 用,不进构建。
 * 规矩见 docs/设计-工作台可读性规矩-2026-10-21.md;维护者认可后按 TDD 搬进 `src/client/readabilityStyle.ts`。
 *
 * 只做三件事:字号收成四档(格标题 15 / 正文 13 / 说明 11 / 大数字 28)、间距收成 4 / 8 / 12 / 16、
 * 默认露出的「可删 / 首次才需要」那几行藏起来(文字改短那几处在 aText.ts)。
 * 不写一个色值,不动格子尺寸与位置。每条选择器都从 S 起头:自媒体布局一条都碰不到。
 */
const S = '.ben-wb:not([data-template=ops])'
const TITLE = 'font-size:var(--wb-fs-title);font-weight:600;line-height:1.3'
const BODY = 'font-size:var(--wb-fs-body);line-height:1.5'
const NOTE = 'font-size:var(--wb-fs-note);line-height:1.45'

export const A_STYLE = `
/* ── 四档。--wb-t1…t5 原来是看板那五档(15 / 13.5 / 12.5 / 11 / 10),这里收成三档;数字格 A 版也走它们 ── */
${S}{--wb-fs-title:15px;--wb-fs-body:13px;--wb-fs-note:11px;--wb-num:28px;--wb-t1:15px;--wb-t2:13px;--wb-t3:13px;--wb-t4:11px;--wb-t5:11px}

/* ── 骨架:顶栏、格子、格头、底部条 ── */
${S} .ben-wb__topbar{gap:16px;margin-bottom:12px;${BODY}}
${S} .ben-wb__topbar :is(.ben-wb__topname,.ben-wb__topclock,.ben-wb__topgear,.ben-wb__toppure,.ben-wb__topplain,.ben-wb__agentcount-btn,.ben-wb__topagent,.ben-wb__topstat-val){font-size:var(--wb-fs-body)}
${S} .ben-wb__topbar .ben-wb__topstat-label{${NOTE}}
${S} .ben-wb__card{padding:12px 16px}
${S} .ben-wb__modhead{min-height:24px;margin:0 0 8px;align-items:center}
${S} .ben-wb__modhead .ben-wb__ttl{${TITLE}}
${S} .ben-wb__footbar{gap:16px;margin-top:12px;padding:8px 16px}
${S} .ben-wb__footbar .ben-wb__daily-toggle{${BODY}}
/* 「▮ AI 悬浮窗(收起)— 不可改」:不可改清单那一格,字样留着(给改布局的流程看,统筹 10-21 定),只降到说明档、不加粗。 */
${S} .ben-wb__footbar .ben-wb__lock{${NOTE};font-weight:400}
${S} .ben-wb__scroll{gap:8px}

/* ── 左栏:应用名本来写 12px,被 .ben-wb button{font:inherit} 顶成 16px;归到正文 ── */
${S} .ben-wb__dock-tabs :is(.ben-wb__dock-tab-name,.ben-wb__dock-tab-close){${BODY}}
${S} .ben-wb__dock-tabs .ben-wb__dock-badge-dot{font-size:var(--wb-fs-note);line-height:1;min-width:16px;height:16px}
${S} .ben-wb__scenemenu .ben-wb__scenemenu-label{${BODY}}
${S} .ben-wb__scenemenu .ben-wb__scenemenu-count{${NOTE}}
${S} .ben-wb__devtool .ben-wb__devtool-name{${BODY}}

/* ── 事务官台 ── */
/* 「正在执行 2 · 等你 1」与球下那一行同一组数:只留球下。外观设置收到悬停才露。 */
${S} .ben-wb__task-stage-heading>span:not(.ben-wb__task-stage-tools){visibility:hidden}
${S} .ben-wb__task-stage-tools{${NOTE}}
${S} .ben-wb__task-stage-tools button{font-size:var(--wb-fs-note)}
${S} .ben-wb__particle-actions>button:not(.ben-wb__orb-drawer-btn){opacity:0;transition:opacity .15s}
${S} .ben-wb__task-stage-heading:is(:hover,:focus-within) .ben-wb__particle-actions>button{opacity:1}
/* 卡片:9 / 10px 的小字归到说明档;卡片高度不动,行间距收紧让进度那一行不再被截半行。 */
${S} .ben-fx__beam>button{gap:4px}
${S} .ben-fx__beam>button>strong{${BODY};font-weight:500}
${S} .ben-fx__beam .ben-wb__task-agents,${S} .ben-fx__beam .ben-wb__task-agents>span,${S} .ben-fx__beam .ben-wb__task-agents-name{${NOTE}}
${S} .ben-fx__beam .ben-wb__task-progress{${NOTE};margin:0}
${S} .ben-wb__particle-mode{${TITLE}}
/* 球下:主句(格标题档)+ 唯一的计数行(正文档)。单行的字不加行距,球下那一区的高度不被挤小。 */
${S} .ben-wb__orb-counts{font-size:var(--wb-fs-body);line-height:1.3}
${S} .ben-wb__items-report:not([data-open=true]) .ben-wb__items-report-text{display:none}
${S} .ben-wb__items-report:not([data-open=true]){line-height:1}
${S} .ben-wb__items-report-toggle{font-size:var(--wb-fs-note);line-height:1}
${S} .ben-wb__askrow .ben-wb__askrow-text,${S} .ben-wb__askrow .ben-wb__askrow-open{${BODY}}
/* 「排队 2 · 已取消 0」:排队数球下已经说了,零不写 —— 只留「查看记录」那个入口。 */
${S} .ben-wb__other-items>summary{font-size:0;line-height:0;min-height:16px;display:flex;align-items:center;justify-content:flex-end}
${S} .ben-wb__other-items>summary>span{${NOTE}}
${S} .ben-wb__result-folder>header :is(h4,span){${NOTE}}
${S} .ben-wb__result-folder li strong{${BODY};font-weight:500}
${S} .ben-wb__result-folder li small{${NOTE}}
${S} .ben-wb__result-folder .ben-wb__folder-toggle{${NOTE}}
${S} .wb-cmp__bar .wb-cmp__pill{${BODY}}

/* ── 项目区 ── */
${S} .ben-wb__viewswitch button{${BODY}}
${S} .ben-wb__pj .ben-wb__pj-name{${TITLE}}
${S} .ben-wb__pj :is(.ben-wb__pj-stage,.ben-wb__pj-risk,.ben-wb__pj-status-meta,.ben-wb__pj-activity,.ben-wb__pj-calc){${NOTE}}
${S} .ben-wb__pj .ben-wb__pj-status>span:not(.ben-wb__pj-status-meta){${BODY}}
${S} .ben-wb__pj .ben-wb__pj-status>span:only-child{font-size:var(--wb-fs-note);opacity:.6}
${S} .ben-wb__pj-others>summary,${S} .ben-wb__lines{${NOTE}}

/* ── 消耗数据 ── */
${S} .ben-wb__usage .ben-wb__usage-segbtn{font-size:var(--wb-fs-body)}
${S} .ben-wb__usage{gap:12px}
/* 大数字与「会话数 · 消息数」并排(大数字收到 28 之后放得下),不再折到下一行被格子底边截掉。 */
${S} .ben-wb__usage .ben-wb__usage-tiles{flex-wrap:nowrap;align-items:flex-end;gap:0 16px}
${S} .ben-wb__usage .ben-wb__usage-tiles>.ben-wb__usage-tile--primary{flex:1 1 auto;min-width:0}
${S} .ben-wb__usage .ben-wb__usage-tiles>.ben-wb__usage-activity{flex:none}
${S} .ben-wb__usage :is(.ben-wb__usage-tile-l,.ben-wb__usage-tile-sub,.ben-wb__usage-hint,.ben-wb__usage-note){${NOTE}}
${S} .ben-wb__usage .ben-wb__usage-tile-v{font-size:var(--wb-fs-body);font-weight:800}
${S} .ben-wb__usage .ben-wb__usage-tile--primary .ben-wb__usage-tile-v{font-size:var(--wb-num);line-height:1}
${S} .ben-wb__usage[data-fig=true] .ben-wb__usage-tile--primary .ben-wb__usage-tile-v{font-size:var(--wb-num);line-height:1}
${S} .ben-wb__usage[data-fig=true] .ben-wb__usage-activity .ben-wb__usage-tile-v,
${S} .ben-wb__usage[data-fig=true] .ben-wb__usage-cache .ben-wb__usage-tile-v{font-size:var(--wb-fs-body)}
${S} .ben-wb__usage[data-fig=true] :is(.ben-wb__usage-cache,.ben-wb__usage-habits,.ben-wb__usage-unwired){padding-top:12px}
${S} .ben-wb__fig-heatday{font-size:var(--wb-fs-note)}
${S} .ben-wb__fig-mix,${S} .ben-wb__usage-heatwrap.ben-wb__fig-heat{padding-top:12px}
/* 来源注(「只有输出 token」)进「计算口径」那个折叠;「没有用量来源」那一组收成一行计数(aFold.ts)。 */
${S} .ben-wb__usage .ben-wb__usage-note{display:none}

/* ── 余额 / 额度 ── */
${S} .ben-wb__usage-q .ben-wb__usage-qname{${BODY}}
${S} .ben-wb__usage-q .ben-wb__usage-qlabel{${NOTE}}
${S} .ben-wb__usage-q .ben-wb__usage-qpct{font-size:var(--wb-fs-body)}
${S} .ben-wb__usage-q .ben-wb__usage-qval{font-size:var(--wb-num);font-weight:800;line-height:1}
${S} .ben-wb__usage-q .ben-wb__usage-qval.ben-wb__fig-val{font-size:var(--wb-num)}
/* 每家那颗「说明」:收成悬停那一行才露的「?」,点开照旧是原来那段说明。 */
${S} .ben-wb__usage-q .ben-wb__usage-qdetails>summary{opacity:0;transition:opacity .15s;font-size:var(--wb-fs-note)}
${S} .ben-wb__usage-q:is(:hover,:focus-within) .ben-wb__usage-qdetails>summary,${S} .ben-wb__usage-qdetails[open]>summary{opacity:1}

/* ── 随手记(运营同学的原件,两种布局共用;只从这一侧盖上去) ── */
${S} .creator-notes{padding:0;gap:12px}
${S} .creator-notes .creator-notes-top{display:none}
${S} .creator-notes textarea{${BODY};min-height:40px}
${S} .creator-notes .creator-notes-hint{${NOTE};visibility:hidden}
${S} .creator-notes:is(:focus-within,:not(:has(.creator-notes-item))) .creator-notes-hint{visibility:visible}
${S} .creator-notes .creator-notes-save{${BODY};padding:4px 12px}
${S} .creator-notes .creator-notes-text{${BODY}}
${S} .creator-notes .creator-notes-date{${NOTE}}
${S} .creator-notes .creator-notes-delete{${BODY}}
${S} .creator-notes .creator-notes-compose-foot{margin-top:8px}
/* 「记下来」在没字时是灰的、按不了:输入框空着又没在打字时整行不露,一打字就回来(回车照旧能存)。 */
${S} .creator-notes .creator-notes-compose:not(:focus-within):has(textarea:placeholder-shown) .creator-notes-compose-foot{display:none}

/* ── 系统文件夹(同上,共用原件) ── */
${S} .creator-files{padding:0;${BODY}}
${S} .creator-files .cf-tabs{gap:8px;margin-bottom:12px}
${S} .creator-files .cf-tabs button{padding:4px 12px}
${S} .creator-files>div>p.cf-note:first-child{display:none}
${S} .creator-files .cf-note{${NOTE}}
${S} .creator-files .cf-file-head{margin-bottom:8px}
${S} .creator-files .cf-file-head strong{${BODY};font-weight:600}
${S} .creator-files :is(.cf-search,.cf-file-name){${BODY}}
${S} .creator-files .cf-search{padding:8px 12px;margin-bottom:8px}
${S} .creator-files .cf-list{gap:8px}
${S} .creator-files .cf-file{padding:8px 12px;gap:8px}
${S} .creator-files .cf-file-path{${NOTE};margin-top:4px}
${S} .creator-files .cf-arrow{font-size:var(--wb-fs-body)}
`

/**
 * 样张 B:其余同 A,只有数字格四格的数字照数字格 A 版不动(总吞吐 57、余额 28.5、会话数 24、缓存三数 19.5)。
 * 盖在 A 后面,把 A 里改大数字的那几条撤回去。
 */
export const B_DELTA = `
${S} .ben-wb__usage .ben-wb__usage-tiles{flex-wrap:wrap}
${S} .ben-wb__usage[data-fig=true] .ben-wb__usage-tile--primary .ben-wb__usage-tile-v{font-size:calc(var(--wb-t1) * 3.8);line-height:.95}
${S} .ben-wb__usage[data-fig=true] .ben-wb__usage-activity .ben-wb__usage-tile-v{font-size:calc(var(--wb-t1) * 1.6)}
${S} .ben-wb__usage[data-fig=true] .ben-wb__usage-cache .ben-wb__usage-tile-v{font-size:calc(var(--wb-t1) * 1.3)}
${S} .ben-wb__usage-q .ben-wb__usage-qval.ben-wb__fig-val{font-size:calc(var(--wb-t1) * 1.9)}
`
