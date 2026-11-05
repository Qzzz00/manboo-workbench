/*
 * ## 2026-10-21:搬出本体,进用户层(卡「分层第一刀」,设计 docs/设计-分层第一刀-2026-10-21.md)
 *
 * 原来在 workbench-plugin/src/client/air/files.js,编进本体;现在是用户层里的一格小组件,
 * 由本体的加载口(client/userLayer.tsx)按 widget.json 装进来。**逻辑、文案、CSS 一个字没动**,
 * 只换了两处写法:
 *
 * - 顶上那几行 `import … from '../X.tsx'` → `require(…)`:react、react/jsx-runtime 照旧,
 *   本体那几样一律从 `require('@workbench/host')` 拿(那张表在本体 client/userLayerHost.ts);
 * - `export function FilesModule(` → `function FilesModule(`,文件末尾 `module.exports = { FilesModule }`。
 *
 * 下面是这一格搬家之前的全部档案,原样留着。原件存档在 user-layer/原件/air-20261002/(只读)。
 *
 * ## 2026-10-23(分层二刀二):mono 那一层里只服务这一格的规则搬进这份 <style>
 *
 * 本体 monoStyle.ts 那组 .ben-wb .creator-files .cf-* 规则只画这一格的 DOM、本体没有
 * 别的消费者 —— 本体不留双份,整组搬进上面 css 模板的末尾。级联等价的核对与两格
 * 截图对照见 docs/交接-1023-分层二刀二.md。
 */

/*
 * 原件:contrib/air-20261002/src/files.js,2026-10-03 原封不动接入,只做了下面这几处机械替换:
 *
 * - `(0, react_jsx_runtime.jsx)` → `jsx`(1 处)
 * - `(0, react.useState)` → `useState`(6 处)
 * - `function FilesModule(` → `export function FilesModule(`
 * - `LegacyFilesModule` 改成 import ../FilesModule.tsx —— 他原件里那一份 `LegacyFilesModule`就是 0.4.85 本体 FilesModule 的逐字拷贝,源码这边把本体那一份还原回去再 import,不留两份
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
 * - `#b7aae6` ×2 / `#c5b9f1` ×1 → `var(--dsw-alias-state-business-primary)`
 * - `#a391cc0c` → 5% / `#a391cc12` → 7% / `#a391cc18` → 9% / `#a391cc20` → 13% / `#a99ada18` → 9% / `#b7aae644` → 27% / `#b7aae666` ×2 → 40%(都是 `color-mix` 到 transparent)
 *
 * ## 2026-10-22:照评审页 0cf75042 系统文件夹那一格重排(统筹转维护者拍板 16「照稿」)
 *
 * 「素材入口 / 整理与图谱」两颗照旧切页,样子换成带图标的常用位置小钮(\`.folder-shortcuts\`);
 * 「待整理文件 N 项」那一行挪到格头右端「N 项 ›」,点开是「待整理文件」那张居中弹层(本体 \`headerWith\` / \`ui.Dialog\`;
 * 老本体没有就照旧);搜索框带图标、写「搜索 N 项待整理文件」;列表整列可滚,不再先只列 5 条;每行 图标 · 名 · 位置 · ↗;
 * 搜不到画「没有找到匹配项」那一块(带「清除搜索」)。定位逻辑一个字没动。稿里还有一颗「+ 添加文件夹」,本体没有对应的口,不画。
 */
const { useState } = require('react')
const { jsx } = require('react/jsx-runtime')
const host = require('@workbench/host')
const { ModuleBox, Dialog, Icon } = host.ui
const { FilesModule: LegacyFilesModule } = host.builtin

        function FilesModule(props) {
            const {box,header,headerWith,headingId,baseUrl,fetchImpl,assetDirs,assetFiles,inbox,veil}=props;
            const h=(type,p,...children)=>jsx(type,{...p,...(children.length?{children:children.length===1?children[0]:children}:{})});
            const [mode,setMode]=useState("library");
            const [query,setQuery]=useState("");
            const [selected,setSelected]=useState("");
            const [feedback,setFeedback]=useState("");
            const [busy,setBusy]=useState(false);
            const [listOpen,setListOpen]=useState(false);
            async function locate(path,name){
                if(busy)return;
                setSelected(path);setBusy(true);setFeedback(`正在定位「${name}」…`);
                try{const r=await fetchImpl(`${baseUrl}/files/reveal`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path})});const j=await r.json();if(!r.ok||j.ok!==true)throw new Error(j.error??"访达未响应");setFeedback(`已在访达中定位「${name}」`);}
                catch(e){setFeedback(`定位未完成：${e instanceof Error?e.message:"请重试"}`);}finally{setBusy(false);}
            }
            const entries=[...Object.entries(assetDirs??{}).map(([name,path])=>({name,path,kind:"dir"})),...Object.entries(assetFiles??{}).map(([name,path])=>({name,path,kind:"file"}))];
            const all=inbox?.items??[];
            const files=all.filter(f=>!query.trim()||f.name.toLowerCase().includes(query.trim().toLowerCase()));
            const css=`.creator-files{min-height:0;flex:1;display:flex;flex-direction:column;overflow:hidden;color:var(--wb-ink);font-size:12px;line-height:1.6}.creator-files *{box-sizing:border-box}.creator-files button{font:inherit;color:inherit;cursor:pointer}.cf-tabs{flex:none;display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.cf-tabs button{display:inline-flex;align-items:center;gap:6px;min-height:29px;padding:5px 9px;border:0;border-radius:6px;background:var(--wb-soft);font-size:11px}.cf-tabs button[aria-pressed=true]{font-weight:600}.cf-tabs button:hover{background:var(--wb-field)}.cf-library{min-height:0;flex:1;display:flex;flex-direction:column}.cf-grid{flex:none;display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.cf-folder{display:inline-flex;align-items:center;gap:6px;min-height:29px;padding:5px 9px;border:0;border-radius:6px;background:var(--wb-soft);font-size:11px}.cf-folder:hover{background:var(--wb-field)}.creator-files [data-selected=true]{font-weight:600}.creator-files button:disabled{cursor:wait;opacity:.6}.cf-icon{flex:none;display:flex;color:var(--wb-sub)}.cf-search{flex:none;display:flex;align-items:center;gap:7px;margin-bottom:6px;padding:6px 9px;border-radius:6px;background:var(--wb-soft);color:var(--wb-sub)}.cf-search input{flex:1;min-width:0;padding:0;border:0;outline:none;background:transparent;color:var(--wb-ink);font:400 11px/1.5 var(--wb-font)}.cf-search input::placeholder{color:var(--wb-faint)}.cf-list{min-height:0;flex:1;overflow:auto;scrollbar-width:thin}.cf-file{display:flex;align-items:center;gap:10px;width:100%;min-width:0;padding:10px 0;border:0;border-bottom:var(--wb-hair) solid var(--wb-line);border-radius:0;background:transparent;text-align:left}.cf-file:last-child{border-bottom:0}.cf-file:hover .cf-file-name{text-decoration:underline}.cf-file-copy{min-width:0;flex:1}.cf-file-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-weight:500}.cf-file-path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px;color:var(--wb-faint);font-size:10px}.cf-arrow{flex:none;display:flex;color:var(--wb-faint)}.cf-status{flex:none;margin:0 0 10px;padding:7px 10px;border-left:2px solid var(--wb-line);background:var(--wb-soft);font-size:11px;overflow-wrap:anywhere}.cf-status small{display:block;margin-top:3px;color:var(--wb-faint);font-size:10px}.cf-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;min-height:95px;padding:18px 14px;text-align:center}.cf-empty>svg{width:22px;height:22px;margin-bottom:3px;color:var(--wb-faint)}.cf-empty strong{font-size:13px;font-weight:600}.cf-empty p{max-width:280px;margin:0;color:var(--wb-sub);font-size:11px;line-height:1.7}.cf-empty button{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:4px 9px;border:var(--wb-hair) solid var(--wb-line);border-radius:6px;background:transparent;font-size:11px}.cf-error{flex:none;margin:12px 0 0;padding:7px 10px;border-left:2px solid var(--dsw-alias-state-error-primary);background:var(--wb-soft);color:var(--dsw-alias-state-error-primary);font-size:11px}.cf-advanced{min-height:0;flex:1;display:flex;flex-direction:column;height:100%}
/* 2026-10-23(分层二刀二):本体 monoStyle 里只服务这一格的那组规则搬进来(本体不留双份)。
   原在 STYLE 约 2/3 处;选择器都带 .ben-wb 前缀、特异度高于上面本组件自己的单子类规则,
   落点从「STYLE 里」换到「这份 <style> 里」胜家逐条不变。 */
.ben-wb .creator-files .cf-tabs{gap:6px;margin-bottom:12px}
.ben-wb .creator-files .cf-tabs button{display:inline-flex;align-items:center;gap:6px;min-height:29px;padding:5px 9px;border:0;border-radius:6px;background:var(--wb-soft);box-shadow:none;color:var(--wb-ink);font-size:11px;font-weight:400}
.ben-wb .creator-files .cf-tabs button:is(.active,[aria-pressed=true],[aria-selected=true],[data-on=true]){color:var(--wb-ink);font-weight:600;box-shadow:none}
.ben-wb .creator-files>div>p.cf-note:first-child{display:none}
.ben-wb .creator-files .cf-file-head strong{color:var(--wb-ink);font-size:11px;font-weight:400}
.ben-wb .creator-files .cf-file-head .cf-note{color:var(--wb-sub);font-size:11px;font-weight:400;letter-spacing:0}
.ben-wb .creator-files .cf-search{min-height:0;margin-bottom:6px;padding:6px 9px;border:0;border-radius:6px;background:var(--wb-soft);color:var(--wb-ink);font-size:11px}
.ben-wb .creator-files .cf-file{gap:10px;padding:10px 0;border:0;border-bottom:var(--wb-hair) solid var(--wb-line);border-radius:0;background:transparent;box-shadow:none}
.ben-wb .creator-files .cf-file:last-child{border-bottom:0}
.ben-wb .creator-files .cf-file-name{color:var(--wb-ink);font-size:11.5px;font-weight:500}
.ben-wb .creator-files .cf-file-path{margin-top:3px;color:var(--wb-faint);font-size:10px;opacity:1}
.ben-wb .creator-files .cf-icon{width:16px;height:16px;color:var(--wb-sub)}
.ben-wb .creator-files .cf-arrow{width:12px;height:12px;color:var(--wb-faint);font-size:12px}`;
            const ico=name=>Icon?h(Icon,{name,size:16}):null;
            const fileIcon=kind=>ico(kind==="dir"?"folder":"file-text");
            const row=f=>h("button",{type:"button",className:"cf-file",title:f.path,"aria-label":`在访达中定位 ${f.name}`,disabled:busy,"data-selected":selected===f.path,onClick:()=>locate(f.path,f.name)},h("span",{className:"cf-icon"},fileIcon(f.kind)),h("span",{className:"cf-file-copy"},h("span",{className:"cf-file-name"},f.name),h("span",{className:"cf-file-path"},f.path)),h("span",{className:"cf-arrow","aria-hidden":true},Icon?h(Icon,{name:"arrow-up-right",size:12}):"↗"));
            const empty=(title,hint,action,onAction,icon)=>h("div",{className:"cf-empty"},ico(icon),h("strong",{},title),h("p",{},hint),action&&h("button",{type:"button",onClick:onAction},action,Icon&&h(Icon,{name:"arrow-right"})));
            const head=headerWith&&Dialog?headerWith(h("button",{type:"button",onClick:()=>setListOpen(true)},`${all.length} 项`,Icon?h(Icon,{name:"chevron-right"}):" ›")):header;
            return h(ModuleBox,{...box},h("section",{className:"ben-wb__card ben-wb__card--fill","aria-labelledby":headingId},head,h("style",{},css),h("div",{className:"creator-files"},
                h("div",{className:"cf-tabs"},h("button",{type:"button","aria-pressed":mode==="library",onClick:()=>setMode("library")},ico("folder"),"素材入口"),h("button",{type:"button","aria-pressed":mode==="advanced",onClick:()=>setMode("advanced")},ico("layers"),"整理与图谱")),
                mode==="library"?h("div",{className:"cf-library"},
                    entries.length>0&&h("div",{className:"cf-grid","aria-label":"素材分类"},...entries.map(f=>h("button",{type:"button",className:"cf-folder",title:f.path,"aria-label":`定位${f.name}`,disabled:busy,"data-selected":selected===f.path,onClick:()=>locate(f.path,f.name)},h("span",{className:"cf-icon"},fileIcon(f.kind)),h("span",{},f.name)))),
                    feedback&&h("div",{className:"cf-status",role:"status","aria-live":"polite"},feedback,h("small",{},selected)),
                    h("label",{className:"cf-search"},ico("scan-search"),h("input",{type:"search",placeholder:`搜索 ${all.length} 项待整理文件`,"aria-label":"搜索待整理文件",value:query,onChange:e=>setQuery(e.target.value)})),
                    files.length?h("div",{className:"cf-list"},...files.map(row)):query.trim()?empty("没有找到匹配项","换一个词，或清除搜索。","清除搜索",()=>setQuery(""),"scan-search"):empty("还没有待整理文件","收件箱里来了新文件，会列在这里。","","","folder"),
                    inbox?.error&&h("p",{className:"cf-error",role:"status"},inbox.error)):
                    h("div",{className:"cf-advanced"},h(LegacyFilesModule,{...props,box:{...box},header:null,headingId:undefined}))
            ),listOpen&&h(Dialog,{title:"待整理文件",onClose:()=>setListOpen(false),...(veil?{veil}:{})},
                all.length?h("div",{className:"cf-list"},...all.map(row)):empty("还没有文件","收件箱里来了新文件，会列在这里。","","","folder"))));
        }

module.exports = { FilesModule }
