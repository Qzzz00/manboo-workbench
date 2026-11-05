/*
 * ## 2026-10-21:搬出本体,进用户层(卡「分层第一刀」,设计 docs/设计-分层第一刀-2026-10-21.md)
 *
 * 原来在 workbench-plugin/src/client/air/notes.js,编进本体;现在是用户层里的一格小组件,
 * 由本体的加载口(client/userLayer.tsx)按 widget.json 装进来。**逻辑、文案、CSS 一个字没动**,
 * 只换了两处写法:
 *
 * - 顶上那几行 `import … from '../X.tsx'` → `require(…)`:react、react/jsx-runtime 照旧,
 *   本体那几样一律从 `require('@workbench/host')` 拿(那张表在本体 client/userLayerHost.ts);
 * - `export function NotesModule(` → `function NotesModule(`,文件末尾 `module.exports = { NotesModule }`。
 *
 * 下面是这一格搬家之前的全部档案,原样留着。原件存档在 user-layer/原件/air-20261002/(只读)。
 *
 * ## 2026-10-22:照评审页 0cf75042 随手记那一格重排(统筹转维护者拍板 16「照稿」)
 *
 * 顶上「灵感随记 / N 条随记」那一行撤掉,条数挪到格头右端「N 条记录 ›」,点开是「全部随手记」那张居中弹层
 * (本体 `headerWith` / `ui.Dialog`;老本体没有这两样就照旧摆 header、不画那颗键)。输入框「记下一个想法,或今天要做的事…」、
 * 脚注「Enter 记下 · Shift + Enter 换行」;每条「今天 11:42 · 记录」+ ×;没保存成功那一句用左线 + soft 底;
 * 一条都没有时画「想法先留在这里」那一块(图标 + 标题 + 一句)。存与删的逻辑一个字没动。颜色只用本体令牌。
 *
 * ## 2026-10-23(分层二刀二):mono 那一层里只服务这一格的规则搬进这份 <style>
 *
 * 本体 monoStyle.ts 那组 .ben-wb .creator-notes-* 规则只画这一格的 DOM、本体没有别的
 * 消费者 —— 本体不留双份,整组搬进上面 css 模板的末尾(竖屏补丁保原相对顺序)。
 * 级联等价的核对与两格截图对照见 docs/交接-1023-分层二刀二.md。
 */

/*
 * 原件:contrib/air-20261002/src/notes.js,2026-10-03 原封不动接入,只做了下面这几处机械替换:
 *
 * - `(0, react_jsx_runtime.jsx)` → `jsx`(1 处)
 * - `(0, react.useState)` → `useState`(2 处)
 * - `function NotesModule(` → `export function NotesModule(`
 * - `ModuleBox` / `EmptyState` / `postSilently` 改成 import(他的包内名字)
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
 * - `#bcaaec` ×1(`--cn-accent` 那一个自定义属性的值)→ `var(--dsw-alias-state-business-primary)`
 *
 * ## 2026-10-04:剩下那九个紫 **rgba** 也换掉了(维护者:「随手记现在是黑紫色,我不喜欢」)
 *
 * 10-03 那一轮只换了 `--cn-accent` 那**一个十六进制**,`rgba(152,126,210,…)`
 * (= `#987ED2`,一个实打实的紫)还留在底色 / 边框 / 按钮里 —— 于是产品研发布局下的随手记
 * 仍然是黑紫的:输入框底、每条随记的底、「记下来」那颗键与它的悬停、删除键的悬停。
 * `--cn-border` 的 `rgba(150,140,175,.22)` 也带着紫灰。
 *
 * 换法与 10-03 那一轮**逐字同一条规矩**:带透明度的走
 * `color-mix(in srgb,var(--dsw-alias-state-business-primary) N%,transparent)`,
 * N = 原来那个 alpha(`.015` → `1.5%`,`.4` → `40%`,以此类推)。
 * **只换颜色值,布局与别的 CSS 一个字没动。** 逐处(各 1 次):`rgba(150,140,175,.22)` /
 * `rgba(152,126,210,.015|.045|.08|.09|.12|.14|.25)` / `rgba(173,152,217,.4)`。
 *
 * 自媒体(运营)布局下这一格仍然是黑紫的 —— 那一层由 `client/opsThemeStyle.ts` 盖上来
 * (`.ben-wb[data-template=ops] .creator-notes*`),**不在这个文件里写死**。
 */

const { useState } = require('react')
const { jsx } = require('react/jsx-runtime')
const host = require('@workbench/host')
const { ModuleBox, EmptyState, Dialog, Icon } = host.ui
const { postSilently } = host.net

/** 「今天 11:42」「昨天 18:30」「10 月 3 日 09:16」(按上海时间切天)。 */
function whenText(iso, now) {
    const at = Date.parse(iso)
    if (!Number.isFinite(at)) return ""
    const day = t => new Date(t).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })
    const clock = new Date(at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false })
    if (day(at) === day(now)) return `今天 ${clock}`
    if (day(at) === day(now - 86400000)) return `昨天 ${clock}`
    const [, month, date] = new Date(at).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }).split("-")
    return `${Number(month)} 月 ${Number(date)} 日 ${clock}`
}

        function NotesModule({ box, header, headerWith, headingId, baseUrl, fetchImpl, notes, draft, setDraft, empty, veil }) {
            const h = (type, props, ...children) => jsx(type, {...props, children: children.length === 1 ? children[0] : children});
            const [saving, setSaving] = useState(false);
            const [message, setMessage] = useState("");
            const [listOpen, setListOpen] = useState(false);
            async function save(event) {
                event.preventDefault();
                const text = draft.trim();
                if (!text || saving) return;
                setSaving(true); setMessage("");
                try {
                    const response = await fetchImpl(`${baseUrl}/note/add`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({text})});
                    if (!response.ok) throw new Error("save");
                    const result = await response.json();
                    if (result.ok === false || result.error) throw new Error("save");
                    setDraft(current => current === draft ? "" : current);
                } catch { setMessage("没有保存成功，内容已保留。可以再试一次。"); }
                finally { setSaving(false); }
            }
            const now = Date.now();
            const meta = item => { const when = item.created_at ? whenText(item.created_at, now) : ""; return when ? `${when} · 记录` : "随手记"; };
            const chevron = Icon ? h(Icon, {name: "chevron-right"}) : " ›";
            const head = headerWith && Dialog
                ? headerWith(h("button", {type: "button", className: "creator-notes-all", onClick: () => setListOpen(true)}, `${notes.length} 条记录`, chevron))
                : header;
            const css = `
            .creator-notes{min-height:0;flex:1;display:flex;flex-direction:column;overflow:hidden;color:var(--wb-ink);font-size:12px;line-height:1.65}
            .creator-notes *{box-sizing:border-box}
            .creator-notes-compose{flex:none;margin:0 0 12px;padding:10px 12px;border-radius:9px;background:var(--wb-soft)}
            .creator-notes textarea{display:block;width:100%;height:54px;min-height:42px;resize:vertical;border:0;outline:none;background:transparent;color:var(--wb-ink);font:400 12px/1.65 var(--wb-font);padding:0;box-shadow:none}
            .creator-notes textarea::placeholder{color:var(--wb-faint)}
            .creator-notes-compose-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;color:var(--wb-faint);font-size:10px}
            .creator-notes-save{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:4px 9px;border:0;border-radius:6px;background:var(--wb-ink);color:var(--wb-reverse);font:400 11px/1.5 var(--wb-font);cursor:pointer}
            .creator-notes-save:disabled{opacity:.35;cursor:default}
            .creator-notes-error{flex:none;margin:0 0 12px;padding:7px 10px;border-left:2px solid var(--dsw-alias-state-error-primary);background:var(--wb-soft);color:var(--dsw-alias-state-error-primary);font-size:11px}
            .creator-notes-list{list-style:none;margin:0;padding:0;min-height:0;flex:1;overflow:auto;scrollbar-width:thin}
            .creator-notes-item{padding:10px 0;border-bottom:var(--wb-hair) solid var(--wb-line)}
            .creator-notes-item:first-child{padding-top:0}
            .creator-notes-item:last-child{border-bottom:0}
            .creator-notes-meta{display:flex;align-items:center;gap:12px;color:var(--wb-faint);font-size:10px}
            .creator-notes-delete{margin-left:auto;min-height:18px;padding:0;border:0;background:transparent;color:var(--wb-faint);font-size:14px;line-height:1.5;cursor:pointer;border-radius:4px}
            .creator-notes-delete:hover,.creator-notes-delete:focus-visible{color:var(--wb-ink);background:var(--wb-soft)}
            .creator-notes-text{margin:4px 0 0;color:var(--wb-ink);font-size:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
            .creator-notes-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;min-height:95px;padding:18px 14px;text-align:center}
            .creator-notes-empty svg{width:22px;height:22px;margin-bottom:3px;color:var(--wb-faint)}
            .creator-notes-empty strong{color:var(--wb-ink);font-size:13px;font-weight:600}
            .creator-notes-empty p{max-width:280px;margin:0;color:var(--wb-sub);font-size:11px;line-height:1.7}
/* 2026-10-23(分层二刀二):本体 monoStyle 里只服务这一格的那组规则搬进来(本体不留双份)。
   原在 STYLE 约 2/3 处;这些选择器都带 .ben-wb 前缀、特异度高于上面本组件自己的单子类
   规则,落点从「STYLE 里」换到「这份 <style> 里」胜家逐条不变。 */
.ben-wb .creator-notes-subtitle{display:none}
.ben-wb .creator-notes-count{padding:0;border:0;background:transparent;color:var(--wb-sub);font-size:11px;font-weight:400}
.ben-wb .creator-notes-compose{margin:0 0 12px;padding:10px 12px;border:0;border-radius:9px;background:var(--wb-soft);box-shadow:none}
.ben-wb .creator-notes-compose textarea{height:54px;min-height:42px;padding:0;border:0;background:transparent;box-shadow:none;color:var(--wb-ink);font:400 12px/1.65 var(--wb-font);resize:vertical}
.ben-wb .creator-notes-compose textarea::placeholder{color:var(--wb-faint)}
.ben-wb .creator-notes-compose-foot{display:flex;align-items:center;justify-content:space-between;margin:4px 0 0;color:var(--wb-faint);font-size:10px}
.ben-wb .creator-notes-hint{color:var(--wb-faint);font-size:10px}
.ben-wb .creator-notes-save{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:4px 9px;border:0;border-radius:6px;background:var(--wb-ink);box-shadow:none;color:var(--wb-reverse);font-size:11px;font-weight:400;text-decoration:none}
.ben-wb .creator-notes-save:disabled{opacity:.35}
.ben-wb .creator-notes-list{gap:0}
.ben-wb .creator-notes-item{padding:10px 0!important;border:0;border-bottom:var(--wb-hair) solid var(--wb-line);border-radius:0;background:transparent;box-shadow:none}
.ben-wb .creator-notes-item:first-child{padding-top:0!important}
.ben-wb .creator-notes-item:last-child{border-bottom:0}
.ben-wb .creator-notes-item:before{display:none}
.ben-wb .creator-notes-meta{gap:12px;margin:0;color:var(--wb-faint);font-size:10px}
.ben-wb .creator-notes-date{color:var(--wb-faint);font-size:10px;opacity:1;letter-spacing:0}
.ben-wb .creator-notes-delete{min-width:0;min-height:18px;padding:0;color:var(--wb-faint);font-size:14px;line-height:1.5;opacity:1}
.ben-wb .creator-notes-text{margin-top:4px;color:var(--wb-ink);font-size:12px;line-height:1.65}
/* 「竖屏那一条」里随记条目的补丁(原 monoStyle;与本块主体保原相对顺序:它在主体之后)。 */
.ben-wb .creator-notes-item{border-left:0;padding-left:0}
            `;
            const row = (item, withDelete) => h("li", {className: "creator-notes-item"},
                h("div", {className: "creator-notes-meta"}, h("span", {className: "creator-notes-date"}, meta(item)),
                    withDelete && h("button", {type: "button", className: "creator-notes-delete", "aria-label": `删除随手记 ${item.text}`, title: "删除这条随记", onClick: () => postSilently(`${baseUrl}/note/remove`, {id: item.id}, fetchImpl)}, "×")),
                h("p", {className: "creator-notes-text"}, item.text));
            return h(ModuleBox,{...box},h("section",{className:"ben-wb__card ben-wb__card--fill","aria-labelledby":headingId},head,h("style",{},css),h("div",{className:"creator-notes"},
                h("form",{className:"creator-notes-compose",onSubmit:save},h("textarea",{"aria-label":"记录灵感或当天安排",placeholder:"记下一个想法，或今天要做的事…",value:draft,rows:2,onChange:e=>setDraft(e.target.value),onKeyDown:e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent?.isComposing&&!e.isComposing&&e.keyCode!==229){e.preventDefault();save(e);}}}),h("div",{className:"creator-notes-compose-foot"},h("span",{className:"creator-notes-hint"},"Enter 记下 · Shift + Enter 换行"),h("button",{className:"creator-notes-save",type:"submit",disabled:saving||!draft.trim()},saving?"保存中…":"记下来"))),
                message&&h("p",{className:"creator-notes-error",role:"status"},message),
                empty!==undefined&&h(EmptyState,{view:empty}),
                notes.length?h("ul",{className:"creator-notes-list","aria-label":"灵感与安排记录"},...notes.map(item=>row(item,true))):empty===undefined&&h("div",{className:"creator-notes-empty"},Icon&&h(Icon,{name:"file-pen-line"}),h("strong",{},"想法先留在这里"),h("p",{},"不用先想好归到哪个项目。"))
            ),listOpen&&h(Dialog,{title:"全部随手记",onClose:()=>setListOpen(false),...(veil?{veil}:{})},
                notes.length?h("ul",{className:"creator-notes-list","aria-label":"全部随手记"},...notes.map(item=>row(item,false))):h("div",{className:"creator-notes-empty"},h("strong",{},"还没有记录"),h("p",{},"先在组件里记下一件事。")))));
        }

module.exports = { NotesModule }
