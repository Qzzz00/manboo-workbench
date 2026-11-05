/*
 * ## 2026-10-21:搬出本体,进用户层(卡「分层第一刀」,设计 docs/设计-分层第一刀-2026-10-21.md)
 *
 * 原来在 workbench-plugin/src/client/air/review.js,编进本体;现在是用户层里的一格小组件,
 * 由本体的加载口(client/userLayer.tsx)按 widget.json 装进来。**逻辑、文案、CSS 一个字没动**,
 * 只换了两处写法:
 *
 * - 顶上那几行 `import … from '../X.tsx'` → `require(…)`:react、react/jsx-runtime 照旧,
 *   本体那几样一律从 `require('@workbench/host')` 拿(那张表在本体 client/userLayerHost.ts);
 * - `export function ReviewModule(` → `function ReviewModule(`,文件末尾 `module.exports = { ReviewModule }`。
 *
 * 下面是这一格搬家之前的全部档案,原样留着。原件存档在 user-layer/原件/air-20261002/(只读)。
 */
/*
 * 原件:contrib/air-20261002/src/review.js,2026-10-03 原封不动接入,只做了下面这几处机械替换:
 *
 * - `(0, react_jsx_runtime.jsx)` → `jsx`(1 处)
 * - `(0, react.useState)` → `useState`(7 处)
 * - `function ReviewModule(` → `export function ReviewModule(`
 * - `REVIEW_RANGES` / `AccountsTable` / `reviewHasValue` 改成从 ../ReviewModule.tsx import(他的包内名字)
 *
 * **逻辑、文案、CSS 一个字没动**(缩进也照原件,`css` 那几个模板字符串里的空白是原文)。
 * 要改这一格先改这里 —— `contrib/air-20261002/` 是他交来的原件存档,只读。
 *
 * ## 2026-10-03 之二:紫色点缀色 → 本体点缀色令牌(维护者:「这个紫色的点缀色真是太丑了」)
 *
 * **只换颜色值,布局与别的 CSS 一个字没动。** 换成的是工作台本体现成的那一个 ——
 * `var(--dsw-alias-state-business-primary)`,它在 `client/neutralStyle.ts` 里被重定义成
 * 主文字色(深色主题里是白、浅色主题里是墨),2026-09-24 维护者「改成白色底黑字吧,中性一点,
 * 这是全局的」那一条就是它。带透明度的那几个换成 `color-mix(in srgb,<令牌> N%,transparent)`
 * (N = 原来那两位十六进制折成的百分比);他拿近白的紫当主文字色用的那几处换成
 * `var(--dsw-alias-label-primary)`;实心强调底上的字(.cp-primary / .ct-primary)按
 * neutralStyle.ts 同一条规矩取底色反色 `var(--dsw-alias-bg-base)`。**用变量不写死。**
 * 逐处:
 *
 * - `#9d94f4` ×1(账号配色第一色)→ `currentColor` —— 这一个**不是令牌**:它会进 SVG 的 `stroke` / `fill` **属性**,而 `var()` 在 SVG 呈现属性里不保证解析得了;`currentColor` 两边都认,取的也正是主文字色
 * - `#c8b8f1` ×1 / `#d7c8f6` ×1 / `#d8c8ff` ×1 → `var(--dsw-alias-state-business-primary)`
 * - `#eeeafa` ×3(他拿它当主文字色)→ `var(--dsw-alias-label-primary)`
 * - `#b9a5ee0e` ×1 → 5% / `#b9a5ee22` ×2 → 13% / `#b9a5ee44` ×1 → 27% / `#b9a5ee99` ×1 → 60%(都是 `color-mix` 到 transparent)
 */

const { useState } = require('react')
const { jsx } = require('react/jsx-runtime')
const { ui: { ModuleBox }, review: { AccountsTable, REVIEW_RANGES, reviewHasValue } } = require('@workbench/host')

        function ReviewModule({ box, header, headingId, baseUrl, fetchImpl, xhs }) {
            const h = (type, props, ...children) => jsx(type, { ...props, children: children.length === 1 ? children[0] : children });
            const [range, setRange] = useState("近 7 日");
            const [selected, setSelected] = useState("all");
            const [metric, setMetric] = useState("views");
            const [expanded, setExpanded] = useState(false);
            const [view, setView] = useState("compare");
            const [busy, setBusy] = useState(false);
            const [said, setSaid] = useState("");
            const accounts = xhs?.accounts ?? [];
            const colors = ["currentColor", "#4ebbb1", "#d2ad72", "#d18db0", "#8fb3e8"];
            const definitions = [["views", "观看"], ["impressions", "曝光"], ["cover_ctr", "封面点击率"], ["likes", "点赞"], ["favorites", "收藏"], ["new_fans", "涨粉"]];
            const label = definitions.find(d => d[0] === metric)?.[1] ?? "观看";
            const rows = accounts.map((a, i) => ({ ...a, color: colors[i % colors.length], data: a.ranges?.find(r => r.range === range) }));
            const visible = selected === "all" ? rows : rows.filter(a => a.profile === selected);
            const valueOf = (a, key) => a.data?.metrics?.find(m => m.key === key && reviewHasValue(m));
            const latestFetch = xhs?.fetches?.[0];
            const isOld = a => a.data?.at && latestFetch?.at && Date.parse(a.data.at) < Date.parse(latestFetch.at);
            const dateText = at => at ? new Date(at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "未采集";
            const css = `
            .rviz{font-size:14px;line-height:1.5;overflow:auto;min-height:0;padding:3px 3px 14px;color:inherit}
            .rviz *{box-sizing:border-box}.rviz button,.rviz select{font:inherit;color:inherit;border:1px solid #9993;border-radius:9px;background:#ffffff06;padding:7px 11px;cursor:pointer}.rviz button:disabled{opacity:.5;cursor:default}.rviz button[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 60%,transparent);color:var(--dsw-alias-state-business-primary);font-weight:650;box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent) inset}.rviz select:focus-visible,.rviz button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
            .rviz-bar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:8px 0 12px}.rviz-card{border:1px solid #9993;border-radius:13px;padding:15px;margin:12px 0;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 5%,transparent),transparent 65%),#ffffff04;box-shadow:0 8px 24px #0002}.rviz h3{font-size:16px;margin:0 0 10px;font-weight:650;letter-spacing:.01em}.rviz small{font-size:12px;opacity:.68}.rviz-note{font-size:12px;opacity:.68;margin:8px 0}.rviz-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.rviz-overview .rviz-card{margin:0}.rviz-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:9px}.rviz-kpi{border:1px solid #9993;border-radius:10px;padding:12px;background:#ffffff04}.rviz-kpi strong{font-size:27px;font-variant-numeric:tabular-nums;display:block;line-height:1.3;color:var(--dsw-alias-label-primary)}.rviz-kpi span{font-size:13px;opacity:.7}.rviz-compare-row{margin:12px 0}.rviz-compare-label{display:flex;justify-content:space-between;gap:10px;margin-bottom:5px}.rviz-compare-label strong{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}.rviz-track{height:10px;border-radius:8px;background:#ffffff0c;overflow:hidden;border:1px solid #9992}.rviz-fill{height:100%;border-radius:8px;box-shadow:0 0 10px color-mix(in srgb,var(--dsw-alias-state-business-primary) 27%,transparent)}.rviz-donut-wrap{display:flex;align-items:center;gap:20px;flex-wrap:wrap}.rviz-donut{width:160px;flex:0 0 160px}.rviz-legend{flex:1;min-width:150px}.rviz-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;box-shadow:0 0 8px currentColor}.rviz-trend{border-top:1px solid #9993;padding-top:13px;margin-top:13px}.rviz-trend-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}.rviz-trend-head strong{font-size:22px;color:var(--dsw-alias-label-primary)}.rviz-chart{width:100%;height:150px;display:block;overflow:visible}.rviz table{font-size:13px;width:100%;border-collapse:collapse}.rviz td,.rviz th{padding:8px;text-align:right;border-bottom:1px solid #9993;white-space:nowrap}.rviz th:first-child{text-align:left}.rviz details{margin:12px 0;border-top:1px solid #9992;padding-top:10px}.rviz summary{cursor:pointer;font-size:13px;color:var(--dsw-alias-state-business-primary)}.rviz-log{font-size:12px;overflow-wrap:anywhere}.rviz-empty{padding:20px 0;font-size:13px;opacity:.65}
            `;
            async function refresh() {
                setBusy(true); setSaid("");
                try { const r = await fetchImpl(`${baseUrl}/xhs/refresh`, {method:"POST"}); const j = await r.json(); setSaid(j.message ?? (r.ok ? "刷新完成" : "刷新失败")); }
                catch { setSaid("未连接到工作台，请稍后再试。"); } finally { setBusy(false); }
            }
            function trendFor(a) {
                const trend = a.trends?.find(t => t.range === range);
                const series = trend?.series?.find(s => s.key === metric);
                const points = (series?.points ?? []).filter(p => Number.isFinite(p.value)).slice().sort((a,b) => a.date.localeCompare(b.date));
                const dates = trend?.dates ?? [];
                const current = valueOf(a, metric);
                const min = Math.min(0,...points.map(p=>p.value));
                const max = Math.max(1,...points.map(p=>p.value));
                const x = p => dates.length > 1 ? 38 + Math.max(0, dates.indexOf(p.date)) / (dates.length - 1) * 450 : 263;
                const y = p => 112 - (p.value-min)/(max-min)*88;
                const segments=[]; let segment=[];
                points.forEach(p=>{ if(segment.length && dates.indexOf(p.date)-dates.indexOf(segment[segment.length-1].date)!==1){segments.push(segment);segment=[];} segment.push(p); });
                if(segment.length) segments.push(segment);
                return h("div",{className:"rviz-trend"},
                    h("div",{className:"rviz-trend-head"},h("span",{},h("i",{className:"rviz-dot",style:{background:a.color}}),a.name),h("strong",{},current?.raw ?? "未采集")),
                    h("small",{},`${label} · ${range} · 采集于 ${dateText(a.data?.at)}${isOld(a) ? " · 本次未更新，显示历史值" : ""}`),
                    points.length ? h("svg",{className:"rviz-chart",viewBox:"0 0 520 150",role:"img","aria-label":`${a.name}${range}${label}趋势，${points.length}个真实采集点`},
                        ...[24,68,112].map(yy=>h("line",{x1:38,x2:488,y1:yy,y2:yy,stroke:"currentColor",opacity:.12})),
                        h("text",{x:32,y:27,textAnchor:"end",fontSize:11,fill:"currentColor",opacity:.65},String(max)),
                        h("text",{x:32,y:115,textAnchor:"end",fontSize:11,fill:"currentColor",opacity:.65},String(min)),
                        ...segments.filter(s=>s.length>1).map(s=>h("polyline",{points:s.map(p=>`${x(p)},${y(p)}`).join(" "),fill:"none",stroke:a.color,strokeWidth:3,strokeLinejoin:"round"})),
                        ...points.map(p=>h("circle",{cx:x(p),cy:y(p),r:5,fill:a.color,tabIndex:0},h("title",{},`${p.date}：${p.raw ?? p.value}`))),
                        h("text",{x:38,y:140,fontSize:12,fill:"currentColor",opacity:.65},dates[0] ?? points[0].date),
                        h("text",{x:488,y:140,textAnchor:"end",fontSize:12,fill:"currentColor",opacity:.65},dates[dates.length-1] ?? points[points.length-1].date)) : h("div",{className:"rviz-empty"},"该指标尚无历史快照，暂不能展示走势。"),
                    points.length === 1 && h("p",{className:"rviz-note"},"目前仅有 1 个采集日，先显示真实数据点；累积后再呈现变化。"));
            }
            const comparables = visible.map(a=>({a,m:valueOf(a,metric)}));
            const peak = Math.max(1,...comparables.map(({m})=>Math.abs(m?.value ?? 0)));
            const shares = rows.map(a=>({a,m:valueOf(a,"views")}));
            const shareComplete = shares.length>0 && shares.every(({m})=>m && m.value>=0);
            const shareTotal = shares.reduce((s,{m})=>s+(m?.value ?? 0),0);
            let shareOffset = 0;
            const total = xhs?.ranges?.find(r=>r.range===range);
            const kpis = selected === "all" ? total?.metrics ?? [] : visible[0]?.data?.metrics ?? [];
            return h(ModuleBox,{...box},h("section",{className:"ben-wb__card ben-wb__card--fill ben-wb__review","aria-labelledby":headingId,style:expanded?{position:"fixed",inset:"5vh 5vw",zIndex:9999,background:"#181818",color:"#eee",padding:24,boxShadow:"0 0 0 100vmax #0009",overflow:"hidden"}:undefined},header,
                h("style",{},css),h("div",{className:"rviz"},
                    h("div",{className:"rviz-bar"},...REVIEW_RANGES.map(r=>h("button",{type:"button","aria-pressed":r===range,onClick:()=>setRange(r)},r)),h("button",{type:"button",disabled:busy,onClick:refresh},busy?"读取中…":"刷新数据"),h("button",{type:"button",onClick:()=>setExpanded(v=>!v)},expanded?"收回小组件":"放大图表")),
                    h("div",{className:"rviz-bar"},h("label",{},"账号 ",h("select",{"aria-label":"选择复盘账号",value:selected,onChange:e=>setSelected(e.target.value)},h("option",{value:"all"},"全部账号"),...rows.map(a=>h("option",{value:a.profile},a.name)))),h("label",{},"指标 ",h("select",{"aria-label":"选择图表指标",value:metric,onChange:e=>setMetric(e.target.value)},...definitions.map(([k,l])=>h("option",{value:k},l))))),
                    h("p",{className:"rviz-note"},`已连接 ${accounts.filter(a=>a.connected).length}/${accounts.length} 个账号${visible.some(isOld)?" · 部分账号本次未更新，图表包含历史采集值":""}`),
                    said && h("p",{role:"status",className:"rviz-note"},said),
                    h("div",{className:"rviz-bar"},h("button",{type:"button","aria-pressed":view==="compare",onClick:()=>setView("compare")},"账号对比 / 占比"),h("button",{type:"button","aria-pressed":view==="trend",onClick:()=>setView("trend")},"账号趋势")),
                    view === "compare" && h("div",{className:"rviz-overview"},
                    h("div",{className:"rviz-card"},h("h3",{},`${label} · 账号对比`),...comparables.map(({a,m})=>h("div",{className:"rviz-compare-row"},h("div",{className:"rviz-compare-label"},h("span",{},a.name),h("strong",{},m?.raw ?? "未采集")),h("div",{className:"rviz-track",role:"img","aria-label":`${a.name}${label}：${m?.raw ?? "未采集"}`},h("div",{className:"rviz-fill",style:{width:`${Math.abs(m?.value ?? 0)/peak*100}%`,background:a.color}})),h("small",{},`${dateText(a.data?.at)}${isOld(a)?" · 历史值":""}${m?.value<0?" · 负值，条长表示绝对值":""}`)))),
                    selected === "all" && h("div",{className:"rviz-card"},h("h3",{},"观看量 · 账号占比"),shareComplete && shareTotal>0 ? h("div",{className:"rviz-donut-wrap"},h("svg",{className:"rviz-donut",viewBox:"0 0 160 160",role:"img","aria-label":`${range}各账号观看量占比`},...shares.map(({a,m})=>{const fraction=m.value/shareTotal;const offset=shareOffset;shareOffset+=fraction;return h("circle",{cx:80,cy:80,r:58,fill:"none",stroke:a.color,strokeWidth:19,pathLength:100,strokeDasharray:`${fraction*100} ${100-fraction*100}`,strokeDashoffset:-offset*100,transform:"rotate(-90 80 80)"},h("title",{},`${a.name}：${m.raw}，${(fraction*100).toFixed(1)}%`));}),h("text",{x:80,y:77,textAnchor:"middle",fontSize:23,fontWeight:650,fill:"currentColor"},shareTotal.toLocaleString("zh-CN")),h("text",{x:80,y:98,textAnchor:"middle",fontSize:12,fill:"currentColor"},"观看合计")),h("div",{className:"rviz-legend"},...shares.map(({a,m})=>h("div",{className:"rviz-compare-label"},h("span",{},h("i",{className:"rviz-dot",style:{background:a.color}}),a.name),h("strong",{},`${(m.value/shareTotal*100).toFixed(1)}%`))))) : h("p",{className:"rviz-note"},shareComplete?"观看量合计为 0，暂无占比。":"部分账号缺少观看量，暂不计算占比。")),
                    ),
                    view === "trend" && h("div",{className:"rviz-card"},h("h3",{},`${label} · 每个账号的趋势`),h("p",{className:"rviz-note"},`每个点代表采集当天的「${range}」汇总，并非当天新增；缺失日期不连线。各账号独立刻度。`),...visible.map(trendFor),!visible.length&&h("p",{className:"rviz-empty"},"请先在设置中连接账号。")),
                    h("details",{},h("summary",{},"查看关键数字"),h("div",{className:"rviz-kpis"},...kpis.filter(reviewHasValue).map(m=>h("div",{className:"rviz-kpi"},h("span",{},m.label),h("strong",{},m.raw),m.derived&&h("small",{},m.derived))))),
                    h("details",{},h("summary",{},"查看数字明细"),h("div",{style:{overflowX:"auto"}},h(AccountsTable,{accounts:visible,total:selected==="all"?total:undefined,range}))),
                    h("details",{},h("summary",{},"采集状态与记录"),h("p",{className:"rviz-log"},xhs?.note ?? "暂无采集记录"),...(xhs?.fetches ?? []).slice(0,5).map(f=>h("p",{className:"rviz-log"},`${dateText(f.at)} · ${f.ok?"已读取部分或全部数据":"读取失败"}${f.reason?` · ${f.reason}`:""}`)))
                )));
        }

module.exports = { ReviewModule }
