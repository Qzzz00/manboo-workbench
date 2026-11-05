/*
 * ## 2026-10-21:搬出本体,进用户层(卡「分层第一刀」,设计 docs/设计-分层第一刀-2026-10-21.md)
 *
 * 原来在 workbench-plugin/src/client/air/usage.js,编进本体;现在是用户层里的一格小组件,
 * 由本体的加载口(client/userLayer.tsx)按 widget.json 装进来。**逻辑、文案、CSS 一个字没动**,
 * 只换了两处写法:
 *
 * - 顶上那几行 `import … from '../X.tsx'` → `require(…)`:react、react/jsx-runtime 照旧,
 *   本体那几样一律从 `require('@workbench/host')` 拿(那张表在本体 client/userLayerHost.ts);
 * - `export function UsagePanel(` → `function UsagePanel(`,文件末尾 `module.exports = { UsagePanel }`。
 *
 * 下面是这一格搬家之前的全部档案,原样留着。原件存档在 user-layer/原件/air-20261002/(只读)。
 */
/*
 * 原件:contrib/air-20261002/src/usage.js,2026-10-03 原封不动接入,只做了下面这几处机械替换:
 *
 * - `(0, react_jsx_runtime.jsx)` → `jsx`(1 处)
 * - `(0, react.useState)` → `useState`(2 处)
 * - `formatTokens$1` → `formatTokens`(1 处)
 * - `function UsagePanel(` → `export function UsagePanel(`
 * - `formatTokens$1`(构建产物里的改名)→ `formatTokens`,从 ../UsagePanel.tsx import
 * - 删掉原件尾部的 `RankList` / `Tile` —— 构建产物里挨着的邻居,属于被他替掉的那一版面板
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
 * - `#8e8be1` ×1(「新增输入」那一项)/ `#b7afff` ×1(范围键按下时的字)→ `var(--dsw-alias-state-business-primary)`
 * - `#9d94f4` ×1(DeepSeek 那一条的配色)同样换成那个令牌,不过它**不在这个文件里了** ——
 *   名册这一轮改成读真数(下一节),那一行搬去了 `client/usageSources.ts` 的 `USAGE_ACCENT_COLOR`
 * - `#efedf6` ×1(放大那一层的主文字色)→ `#eee`(同上):它配的是他写死的深底(`#222126` / `#19191d` / `#28262e`,不是紫,这张卡不动),所以也只能是一个写死的浅字 —— 用令牌会在浅色主题里变成深字压在深底上
 * - `#8171ca22` → 13% / `#9890ea22` → 13% / `#9890ea88` → 53% / `#a69bea44` → 27%(都是 `color-mix` 到 transparent)
 *
 * ## 2026-10-13:上一行判过「不是紫」的那个深底 → 纯灰
 *
 * 维护者原话:「自媒体布局的所有紫色改成和产品研发布局的黑白灰」。放大那一层的底
 * (`.cu-full`)三个通道差 4(偏紫的灰),按同一个明度换成纯灰:`#19191d` ×1 → `#1a1a1a`。
 * **配着它的那个写死浅字 `#eee` 一个字没动。**
 *
 * ## 2026-10-03 之三:写死 → 读真数(他的代码里**唯一**允许改的地方)
 *
 * 维护者原话:「我看到他的现在消耗数据应该是他机器的,不是我的……消耗数据都是写死的,
 * 显示哪些模型也是写死的,这个我们自己先修,下一个版本再发。」
 * **布局、文案、CSS 一个字没动,只换数据来源。** 五处,每一处为什么:
 *
 * - `const sources=[{dsh…},{codex…}]` → `airUsageSources(usage)`。
 *   **为什么改:写死 → 读真数。** 名册写死成他机器上那两家,维护者机器上采集器名册是
 *   `claude` / `codex` / `dsh`(`usage/collector.ts` 的 `sources`),于是 Claude 那一整份用量
 *   在他那一格里压根没有格子。改成按 `/state.usage.sources` 的键(并上只在 `days[].by_source`
 *   里出现过的)列,名字 / 配色 / 那句来源说明在 `client/usageSources.ts`。
 * - `${recorded}/3 项工具可读取` → `${recorded}/${sources.length+USAGE_NOT_WIRED_FAMILIES.length}`。
 *   **为什么改:写死 → 读真数。** 那个 3 是"他机器上两家 + 豆包一格"数出来的,
 *   换成真的摆了几格。
 * - 豆包办公那一格 → `USAGE_NOT_WIRED_FAMILIES.map(…)`(本体 `UsagePanel.tsx` 那一份表,
 *   产品研发模板那一版面板读的也是它),大字用导出的 `USAGE_NOT_WIRED`(= 他写的那四个字
 *   「未接入用量」,逐字相同)。**为什么改:写死 → 读真数**(「哪几家没有 token 来源」
 *   两版面板共一份表,不各写一份)。他那两句小字(`当前采集器没有 Token 来源` /
 *   `不计入合计，不按 0 处理`)与那颗点的颜色**一个字没动**;今天那份表里只有豆包办公一条,
 *   所以**渲染结果与他原件逐字相同**。
 * - 按日柱状图的 `aria-label`:写死「按日期展示 DeepSeek 与 Codex 的…」→ 按真的在图上的那几家拼。
 *   **为什么改:写死 → 读真数**(图上多了 Claude 而标签还说只有两家,就是说错话)。
 *
 * **没改、摆在这儿**:`const stamp=…+8*3600000…`(归日按东八区)与口径那一句
 * 「AI 创作投入 · 本机留存日志 · 北京时间」—— 归日是跟着他自己写死的那句**文案**走的,
 * 要改是连文案一起改,而这张卡的规矩是文案不动(采集器那边 `usage.timezone` / `usage.scope`
 * 两个字段早就有了,他那一格不读)。两台机器都在东八区,今天结果一样。
 * 「来自本机 Codex 与工作台会话日志…」那一长段说明里点名的那两家同理:那是说明文字,没动。
 *
 * ## 2026-10-04:Codex 剩余额度卡 + 去掉豆包办公那一格(维护者当天拍板,运营同学交回的那一版)
 *
 * **布局与他写的文案照搬,取数搬进 `client/codexQuota.ts`**(判据要测得到;那边写清了
 * 「优先 5 小时、另列一周、只从 `/state.quota.codex` 与 `/state.agent_quota` 取、不推算」)。
 * 四处:
 *
 * - `UsagePanel({usage, now})` → 多收 `quota` / `agentQuota` 两个 props(`UsageModule.tsx` 传);
 * - 「已记录用量」下面多一张 `.cu-codex-quota`;
 * - **删掉豆包办公那一格**(`USAGE_NOT_WIRED_FAMILIES.map(...)` 那一串)与占比下面
 *   「豆包办公尚未纳入」那半句 —— 维护者 10-04:这一格上不摆没有数的家;
 * - 于是分母回到 `sources.length`(本来是 `sources.length + USAGE_NOT_WIRED_FAMILIES.length`,
 *   那个加数就是刚删掉的那几格)。
 *
 * 他那张卡的 CSS 是一串写死的紫(`#a78bfa` / `#6d28d9` / `#c4b5fd`…)。**这里一个都没抄** ——
 * 0.4.91「他那六格里一个紫都不许再有」那条还算数(tests/client-air-accent.test.ts),
 * 颜色一律走本体令牌;自媒体布局的黑紫皮肤由 `client/opsThemeStyle.ts` 整层盖上来。
 */

const { useState } = require('react')
const { jsx } = require('react/jsx-runtime')
const { usage: { formatTokens, formatResetAt, sourcesOf: airUsageSources, codexQuotaOf } } = require('@workbench/host')

        function UsagePanel({ usage, now, quota, agentQuota }) {
            const h=(type,props,...children)=>jsx(type,{...props,children:children.length===1?children[0]:children});
            const [range,setRange]=useState("7d");
            const [expanded,setExpanded]=useState(false);
            const sources=airUsageSources(usage);
            const valid=usage && !usage.error;
            const days=valid?usage.days??[]:[];
            const anchor=now??usage?.scanned_at;
            const stamp=anchor?new Date(Date.parse(anchor)+8*3600000).toISOString().slice(0,10):days.at(-1)?.date;
            const limit=range==="7d"?7:range==="30d"?30:Infinity;
            const cutoff=stamp&&Number.isFinite(limit)?new Date(Date.parse(stamp+"T00:00:00Z")-(limit-1)*86400000).toISOString().slice(0,10):"";
            const scoped=days.filter(d=>(!cutoff||d.date>=cutoff)&&(!stamp||d.date<=stamp));
            const sum=t=>t?Number(t.input??0)+Number(t.output??0)+Number(t.cache_read??0)+Number(t.cache_write??0):0;
            const totals=sources.map(s=>({...s,total:scoped.reduce((n,d)=>n+sum(d.by_source?.[s.id]),0),meta:usage?.sources?.[s.id]}));
            const total=totals.reduce((n,s)=>n+s.total,0);
            const fmt=n=>formatTokens(n);
            const recorded=totals.filter(s=>s.meta&&s.meta.status!=="error").length;
            const codex=codexQuotaOf(quota,agentQuota);
            const breakdown=[['新增输入','input','var(--dsw-alias-state-business-primary)'],['生成输出','output','#d2ad72'],['缓存读取','cache_read','#52ada9'],['缓存写入','cache_write','#d18db0']].map(([name,key,color])=>({name,color,value:scoped.reduce((n,d)=>n+sources.reduce((a,s)=>a+Number(d.by_source?.[s.id]?.[key]??0),0),0)}));
            const maximum=Math.max(1,...scoped.map(d=>sources.reduce((n,s)=>n+sum(d.by_source?.[s.id]),0)));
            const css=`.creator-usage{color:inherit;font-size:14px;line-height:1.6;overflow:auto;min-height:0;padding:3px 3px 14px}.creator-usage *{box-sizing:border-box}.cu-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px}.creator-usage button{font:inherit;color:inherit;border:1px solid #9994;border-radius:8px;background:transparent;padding:5px 10px;cursor:pointer}.creator-usage button[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 53%,transparent);color:var(--dsw-alias-state-business-primary)}.cu-scope{font-size:12px;opacity:.6;margin:8px 0}.cu-hero{border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 27%,transparent);border-radius:13px;padding:16px;background:radial-gradient(ellipse at top right,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 75%);margin-bottom:12px}.cu-hero strong{display:block;font-size:35px;line-height:1.25;letter-spacing:-.03em;font-variant-numeric:tabular-nums}.cu-hero small{font-size:12px;opacity:.7}.cu-codex-quota{margin:0 0 12px;padding:14px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 28%,transparent);border-radius:12px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent),transparent 78%)}.cu-codex-head,.cu-codex-label,.cu-codex-week{display:flex;align-items:center;justify-content:space-between;gap:10px}.cu-codex-head{margin-bottom:9px}.cu-codex-head span{font-size:13px;opacity:.75}.cu-codex-head strong{font-size:24px;font-variant-numeric:tabular-nums}.cu-codex-label{font-size:12px;margin-bottom:5px}.cu-codex-label b{font-weight:600}.cu-codex-track{display:block;height:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent);border-radius:999px;background:#9992;overflow:hidden}.cu-codex-track i{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-business-primary)}.cu-codex-window small{display:block;margin-top:5px;font-size:11px;opacity:.58}.cu-codex-week{margin-top:10px;padding-top:9px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);font-size:12px}.cu-tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:9px}.cu-tool{border:1px solid #9993;border-radius:11px;padding:12px;background:#88888805}.cu-tool strong{display:block;font-size:24px;font-variant-numeric:tabular-nums}.cu-tool small{font-size:12px;opacity:.6;display:block}.cu-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px}.cu-card{border:1px solid #9993;border-radius:12px;padding:14px;margin-top:12px}.cu-card h3{font-size:15px;font-weight:600;margin:0 0 10px}.cu-chart{height:120px;display:flex;align-items:stretch;gap:5px;overflow-x:auto}.cu-day{flex:1;min-width:18px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}.cu-stack{height:92px;width:100%;display:flex;flex-direction:column;justify-content:flex-end;max-width:45px;gap:1px}.cu-segment{width:100%;border-radius:3px 3px 0 0;min-height:0}.cu-day small{font-size:10px;opacity:.6;margin-top:6px;white-space:nowrap}.cu-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin-top:10px}.cu-share{display:flex;height:12px;border-radius:9px;overflow:hidden;background:#9992;margin:12px 0}.cu-row{display:flex;justify-content:space-between;gap:12px;margin:7px 0}.cu-muted{opacity:.65;font-size:12px}.creator-usage summary{cursor:pointer;font-size:13px;margin:12px 0}.creator-usage p{overflow-wrap:anywhere}.cu-full{position:fixed;inset:6vh 10vw;z-index:9999;background:#1a1a1a;color:#eee;border:1px solid #9994;border-radius:18px;padding:24px;box-shadow:0 0 0 100vmax #0009}.cu-full .cu-tools{grid-template-columns:repeat(3,1fr)}.cu-full .cu-chart{height:230px}.cu-full .cu-stack{height:200px}`;
            return h("div",{className:`creator-usage${expanded?" cu-full":""}`,role:expanded?"dialog":undefined,"aria-label":"AI 创作投入"},h("style",{},css),
                h("div",{className:"cu-bar"},...[['7d','近 7 天'],['30d','近 30 天'],['all','全部记录']].map(([k,l])=>h("button",{type:"button","aria-pressed":range===k,onClick:()=>setRange(k)},l)),h("button",{type:"button",onClick:()=>setExpanded(v=>!v)},expanded?"收回小组件":"放大查看")),
                h("p",{className:"cu-scope"},"AI 创作投入 · 本机留存日志 · 北京时间"),
                h("div",{className:"cu-hero"},h("span",{},"已记录用量"),h("strong",{},valid?fmt(total):"暂未读取"),h("small",{},`Tokens · 含缓存读取 · ${recorded}/${sources.length} 项工具可读取`)),
                h("section",{className:"cu-codex-quota","aria-label":"Codex 剩余额度"},h("div",{className:"cu-codex-head"},h("span",{},"Codex 剩余额度"),h("strong",{},codex.head)),codex.five?h("div",{className:"cu-codex-window"},h("div",{className:"cu-codex-label"},h("span",{},codex.five.label),h("b",{},`剩余 ${codex.five.leftPct}%`)),h("span",{className:"cu-codex-track"},h("i",{style:{width:`${codex.five.leftPct}%`}})),h("small",{},codex.five.resetAt?`${formatResetAt(codex.five.resetAt,new Date(now??Date.now()))??"稍后"}重置`:"5 小时额度窗口")):h("p",{className:"cu-muted"},codex.why),codex.weekly&&h("div",{className:"cu-codex-week"},h("span",{},`${codex.weekly.label}剩余`),h("strong",{},`${codex.weekly.leftPct}%`))),
                h("div",{className:"cu-tools"},...totals.map(s=>h("div",{className:"cu-tool"},h("span",{},h("i",{className:"cu-dot",style:{background:s.color}}),s.name),h("strong",{},!s.meta?"未接入":s.meta.status==="error"&&s.total===0?"读取失败":fmt(s.total)),h("small",{},s.note),h("small",{},s.meta?.status==="error"?"读取失败，已有数字为历史记录":s.meta?.status==="partial"?"部分日志未读取":s.total===0?"本时段无用量记录":"Tokens 已记录")))),
                h("div",{className:"cu-card"},h("h3",{},"每天的 AI 创作投入"),scoped.length?h("div",{className:"cu-chart",role:"img","aria-label":`按日期展示${sources.map(s=>s.name).join(" 与 ")}的已记录Token用量`},...scoped.map(d=>h("div",{className:"cu-day",title:`${d.date} · ${sources.map(s=>`${s.name} ${fmt(sum(d.by_source?.[s.id]))}`).join(' / ')}`},h("div",{className:"cu-stack"},...sources.map(s=>h("div",{className:"cu-segment",style:{height:`${sum(d.by_source?.[s.id])/maximum*100}%`,background:s.color}}))),h("small",{},d.date.slice(5))))) : h("p",{className:"cu-muted"},"这段时间还没有用量日志。"),h("div",{className:"cu-legend"},...sources.map(s=>h("span",{},h("i",{className:"cu-dot",style:{background:s.color}}),s.name))),h("p",{className:"cu-muted"},"仅展示有记录的日期；条高代表已记录 Tokens，包含缓存读取。")),
                h("div",{className:"cu-card"},h("h3",{},"工具用量占比"),h("div",{className:"cu-share",role:"img","aria-label":"已接入工具的用量占比"},...totals.map(s=>h("div",{style:{width:`${total?s.total/total*100:0}%`,background:s.color},title:`${s.name} ${total?(s.total/total*100).toFixed(1):0}%`}))),...totals.map(s=>h("div",{className:"cu-row"},h("span",{},s.name),h("strong",{},total?`${(s.total/total*100).toFixed(1)}%`:"暂无占比"))),h("p",{className:"cu-muted"},"占比仅包含本机已记录的用量。")),
                h("details",{},h("summary",{},"用量构成与统计范围"),...breakdown.map(b=>h("div",{className:"cu-row"},h("span",{},h("i",{className:"cu-dot",style:{background:b.color}}),b.name),h("span",{},fmt(b.value)))),h("p",{className:"cu-muted"},"来自本机 Codex 与工作台会话日志，不等于账号全端用量或实际账单。缓存读取也是 Tokens，但各工具计价不同，不能据此直接计算费用。DeepSeek 仅覆盖工作台中留存的会话，不包含未落地到本机的网页或手机使用。"),h("p",{className:"cu-muted"},`最近扫描：${usage?.scanned_at?new Date(usage.scanned_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):"未扫描"}`),...totals.filter(s=>s.meta?.note).map(s=>h("p",{className:"cu-muted"},`${s.name}：${s.meta.note}`))),
                !valid&&h("p",{role:"status",className:"cu-muted"},usage?.error??"用量日志还未接入。")
            );
        }

module.exports = { UsagePanel }
