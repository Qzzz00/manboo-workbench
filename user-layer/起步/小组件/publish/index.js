/*
 * ## 2026-10-21:搬出本体,进用户层(卡「分层第一刀」,设计 docs/设计-分层第一刀-2026-10-21.md)
 *
 * 原来在 workbench-plugin/src/client/air/publish.js,编进本体;现在是用户层里的一格小组件,
 * 由本体的加载口(client/userLayer.tsx)按 widget.json 装进来。**逻辑、文案、CSS 一个字没动**,
 * 只换了两处写法:
 *
 * - 顶上那几行 `import … from '../X.tsx'` → `require(…)`:react、react/jsx-runtime 照旧,
 *   本体那几样一律从 `require('@workbench/host')` 拿(那张表在本体 client/userLayerHost.ts);
 * - `export function PublishModule(` → `function PublishModule(`,文件末尾 `module.exports = { PublishModule }`。
 *
 * 下面是这一格搬家之前的全部档案,原样留着。原件存档在 user-layer/原件/air-20261002/(只读)。
 */
/*
 * 原件:contrib/air-20261002/src/publish.js,2026-10-03 原封不动接入,只做了下面这几处机械替换:
 *
 * - `(0, react_jsx_runtime.jsx)` → `jsx`(1 处)
 * - `(0, react.useState)` → `useState`(9 处)
 * - `(0, react.useRef)` → `useRef`(3 处)
 * - `(0, react.useEffect)` → `useEffect`(1 处)
 * - `function PublishModule(` → `export function PublishModule(`
 * - `pad` / `WEEKDAYS` / `PUBLISH_VIEWS` / `monthCells` / `shiftMonth` / `publishDayOf` / `tasksByPublishDay` / `isOverdue` 改成从 ../PublishModule.tsx import;`DEFAULT_TOPIC_STAGE` / `TOPIC_CONTENT_TYPES` 从 ../../protocol.ts import
 * - 删掉原件尾部那几个 trendChart 函数(trendScale/trendSegments/trendX/trendY/trendPathD/round/trendShowDots/trendRange)—— 它们是构建产物里挨着的邻居,不是他改的,源码里本来就有(client/trendChart.ts)
 *
 * **逻辑、文案、CSS 一个字没动**(缩进也照原件,`css` 那几个模板字符串里的空白是原文)。
 * 要改这一格先改这里 —— `contrib/air-20261002/` 是他交来的原件存档,只读。
 *
 * ## 2026-10-12:填写面板改在卡片里切换,不再铺全台遮罩(他 10-08 的做法,卡 `claude/ops-patch-1012`)
 *
 * 原来点日期开的是 `position:fixed` 的整屏遮罩 + 居中弹窗,会把工作台别的模块一起盖住、模糊掉。
 * 现在遮罩(`.cp-local-backdrop`)与面板(`.cp-panel`)都是 `.ben-wb__publish-card` 的孩子、
 * `position:absolute` 限制在这一格里;内容过长只有面板自己滚。点日期、「添加计划」、Esc、关闭、
 * 取消、保存、保存失败留草稿这些逻辑一个字没动。
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
 * - `#b9a5ee` ×2 / `#c0afff` ×2 / `#c5b3ef` ×1 / `#c7b6fa` ×1 / `#d2c3ff` ×1 / `#d7c7ff` ×1 / `#e0d6f7` ×1 → `var(--dsw-alias-state-business-primary)`
 * - `#efedf5` ×2(浮层与下拉项里的主文字色)→ `#eee`(他自己在数据复盘那张放大层里用的就是这个中性值):它配的是他写死的深底(`#222126` / `#19191d` / `#28262e`,不是紫,这张卡不动),所以也只能是一个写死的浅字 —— 用令牌会在浅色主题里变成深字压在深底上
 * - `#231d34` ×1(`.cp-primary` 实心强调底上的字)→ `var(--dsw-alias-bg-base)`
 * - `#b9a5ee10` → 6% / `#b9a5ee16` → 9% / `#b9a5ee18` → 9% / `#b9a5ee20` → 13% / `#b9a5ee22` → 13% / `#b9a5ee88` → 53% / `#b9a5eeaa` → 67% / `#a99ab766` → 40%(都是 `color-mix` 到 transparent)
 *
 * ## 2026-10-13:上一行判过「不是紫」的那几个深底 → 纯灰
 *
 * 维护者原话:「自媒体布局的所有紫色改成和产品研发布局的黑白灰」。10-03 放过的那几个深底
 * 三个通道其实差 5~8(偏紫的灰),这一轮按同一个明度换成纯灰;**配着它们的那个写死浅字
 * `#eee` 一个字没动**(理由同上:浮层的底是写死的,字也只能写死)。
 *
 * - `#222126` ×2(`.cp-panel` 那张面板、`.cp-hover` 那条悬停条)→ `#232323`
 * - `#28262e` ×1(`.cp-panel option`)→ `#292929`
 */

const { useEffect, useRef, useState } = require('react')
const { jsx } = require('react/jsx-runtime')
const { ui: { ModuleBox }, topics: { DEFAULT_TOPIC_STAGE, TOPIC_CONTENT_TYPES }, publish: {
  PUBLISH_PLAN_SOURCE_PREFIX, PUBLISH_VIEWS, WEEKDAYS, isOverdue, monthCells, pad, publishDayOf, publishHoverOf, publishHoverText, shiftMonth,
  tasksByPublishDay,
} } = require('@workbench/host')

        function PublishModule({box,header,headingId,baseUrl,fetchImpl,tasks=[],now,projects=[]}) {
            const h=(type,props,...children)=>jsx(type,{...props,...(children.length?{children:children.length===1?children[0]:children}:{})});
            const parsed=Date.parse(now),at=new Date(Number.isNaN(parsed)?0:parsed);
            const today=Number.isNaN(parsed)?undefined:`${at.getFullYear()}-${pad(at.getMonth()+1)}-${pad(at.getDate())}`;
            const thisMonth=today?.slice(0,7)??'';
            const [month,setMonth]=useState(thisMonth);
            const [view,setView]=useState('未发布');
            const [picked,setPicked]=useState(null);
            const [draft,setDraft]=useState('');
            const [account,setAccount]=useState('');
            const [contentType,setContentType]=useState('视频');
            const [busy,setBusy]=useState(false);
            const [error,setError]=useState('');
            const [notice,setNotice]=useState('');
            const [removing,setRemoving]=useState(null);
            const [confirmRemove,setConfirmRemove]=useState(null);
            const [removedPlans,setRemovedPlans]=useState([]);
            // 2026-10-13:悬浮在某一条上时记它的 id(「悬浮上去就能看到相关内容」)。
            const [hover,setHover]=useState(null);
            const lock=useRef(false),opener=useRef(null);
            useEffect(()=>{if(!month&&thisMonth)setMonth(thisMonth)},[month,thisMonth]);
            
            // 成功后立即更新日历；服务端快照确认清除或重新排期后，交回快照管理。
            const matchesRemoved=(task,removed)=>task.id===removed.id&&task.planned_at===removed.planned_at&&task.due===removed.due;
            useEffect(()=>{setRemovedPlans(previous=>{
                const pending=previous.filter(removed=>tasks.some(task=>matchesRemoved(task,removed)));
                return pending.length===previous.length?previous:pending;
            })},[tasks]);
            const visibleTasks=tasks.map(task=>removedPlans.some(removed=>matchesRemoved(task,removed))?{...task,planned_at:undefined,due:undefined}:task);
            const close=()=>{if(lock.current)return;setPicked(null);setConfirmRemove(null);setError('');opener.current?.focus?.()};
            const choose=(date,event)=>{if(lock.current)return;opener.current=event?.currentTarget;setPicked(date);setConfirmRemove(null);setDraft('');setError('');setNotice('')};
            const byDay=tasksByPublishDay(visibleTasks,view),cells=monthCells(month);
            const daily=picked?visibleTasks.filter(t=>t.status!=='canceled'&&[publishDayOf(t,'未发布'),publishDayOf(t,'已发布')].includes(picked)):[];
            const monthItems=visibleTasks.filter(t=>publishDayOf(t,view)?.startsWith(month)&&month);
            const accountName=id=>projects.find(p=>p.id===id)?.name??'未指定账号';
            const accountOf=id=>projects.find(p=>p.id===id)?.name;
            const hoverOne=hover===null?undefined:visibleTasks.find(t=>t.id===hover);
            const hoverView=hoverOne===undefined?undefined:publishHoverOf(hoverOne,{account:accountOf(hoverOne.project_id)});
            const removePlan=async task=>{
                if(lock.current||confirmRemove!==task.id||publishDayOf(task,'未发布')!==picked)return;
                lock.current=true;setBusy(true);setRemoving(task.id);setError('');setNotice('');
                try {
                    // due 是旧计划的回退日期；一并清掉才能避免它又出现在日历里。
                    const response=await fetchImpl(`${baseUrl}/task/update`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:task.id,planned_at:null,...(task.due?{due:null}:{})})});
                    const result=await response.json();if(!response.ok||result.ok!==true)throw new Error(result.error??'删除未成功，请重试');
                    setRemovedPlans(previous=>[...previous.filter(one=>one.id!==task.id),{id:task.id,planned_at:task.planned_at,due:task.due}]);
                    setConfirmRemove(null);setHover(null);setNotice(`已删除 ${picked} 的发布计划「${task.title}」，选题和素材已保留。`);
                }catch(e){setError(e instanceof Error?e.message:'删除失败，请重试')}finally{lock.current=false;setBusy(false);setRemoving(null)}
            };
            const submit=async event=>{
                event.preventDefault();if(lock.current||!draft.trim()||!picked)return;
                lock.current=true;setBusy(true);setError('');
                try {
                    const response=await fetchImpl(`${baseUrl}/task/create`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:draft.trim(),status:'todo',kind:'topic',stage:DEFAULT_TOPIC_STAGE,content_type:contentType,planned_at:picked,...(account?{project_id:account}:{})})});
                    const result=await response.json();if(!response.ok||result.ok!==true)throw new Error(result.error??'保存未成功，请重试');
                    setNotice(`已保存 ${picked} 的发布计划「${draft.trim()}」${result.dir_note?'。'+result.dir_note:''}`);setDraft('');setView('未发布');setMonth(picked.slice(0,7));setPicked(null);opener.current?.focus?.();
                }catch(e){setError(e instanceof Error?e.message:'保存失败，请重试')}finally{lock.current=false;setBusy(false)}
            };
            const css=`.cp-body{overflow:auto;min-height:0;padding:4px 2px 10px;color:inherit;font-size:14px;line-height:1.5}.ben-wb__publish-card{position:relative;overflow:hidden}.cp-body *,.cp-panel *{box-sizing:border-box}.cp-body button,.cp-panel button{font:inherit;cursor:pointer;color:inherit}.cp-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.cp-top strong{display:block;font-size:19px;font-weight:650;letter-spacing:.02em}.cp-muted{font-size:12px;opacity:.7;margin:4px 0}.cp-primary{border:1px solid var(--dsw-alias-state-business-primary)!important;background:var(--dsw-alias-state-business-primary)!important;color:var(--dsw-alias-bg-base)!important;font-weight:650!important;border-radius:10px;padding:9px 15px;white-space:nowrap}.cp-nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}.cp-nav button,.cp-tabs button,.cp-secondary{border:1px solid #9994;background:#ffffff06;border-radius:8px;padding:5px 10px}.cp-nav strong{font-size:17px;margin-right:auto}.cp-tabs{display:flex;gap:6px}.cp-tabs button[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 53%,transparent);color:var(--dsw-alias-state-business-primary)}.cp-week,.cp-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}.cp-week{font-size:12px;text-align:center;opacity:.7;margin-bottom:6px}.cp-body .cp-day{display:flex;flex-direction:column;align-items:stretch;gap:5px;min-height:74px;min-width:0;text-align:left;padding:8px;border:1px solid #9993;background:#ffffff04;border-radius:10px;transition:background .15s,border-color .15s}.cp-day:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 67%,transparent)}.cp-day[data-out=true]{opacity:.4}.cp-day[data-today=true]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent)}.cp-day[data-has=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 6%,transparent)}.cp-day-top{display:flex;align-items:center;justify-content:space-between;gap:3px}.cp-day-num{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums}.cp-day-top small{font-size:10px;color:var(--dsw-alias-state-business-primary)}.cp-add{font-size:11px;color:var(--dsw-alias-state-business-primary)}.cp-chip{display:block;font-size:11px;line-height:1.5;padding:3px 5px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);border-radius:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-business-primary)}.cp-day[data-late=true] .cp-chip{background:#d7985520;color:#e0b585}.cp-notice{padding:10px 12px;background:#7ec1b61a;border:1px solid #7ec1b655;border-radius:9px;font-size:13px;margin:10px 0;overflow-wrap:anywhere}.cp-local-backdrop{position:absolute;inset:34px 0 0;z-index:7;background:#0008;backdrop-filter:blur(4px) saturate(.85);animation:cp-fade-in .14s ease-out}.cp-panel{position:absolute;top:54px;left:50%;z-index:8;width:min(480px,calc(100% - 28px));max-height:calc(100% - 68px);overflow:auto;color:#eee;background:#232323;padding:18px 20px 20px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,transparent);border-radius:16px;box-shadow:0 18px 52px #000a,0 0 0 1px #ffffff08;font:14px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;transform:translateX(-50%);animation:cp-panel-in .16s ease-out}.cp-panel-head{display:flex;align-items:center;justify-content:space-between;gap:14px}.cp-panel h2{font-size:20px;margin:0}.cp-panel h3{font-size:14px;margin:14px 0 7px}.cp-panel label{display:flex;flex-direction:column;gap:5px;margin-top:11px;font-size:14px}.cp-panel input,.cp-panel select{font:inherit;color:inherit;background:#ffffff08;border:1px solid #9995;border-radius:9px;min-height:39px;padding:8px 10px;width:100%}.cp-panel input:focus,.cp-panel select:focus{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.cp-panel option{background:#292929;color:#eee}.cp-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.cp-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:17px}.cp-panel button:disabled{opacity:.45;cursor:default}.cp-error{color:#f4b6ac;background:#f4b6ac0c;border-radius:8px;padding:10px;margin-top:14px}.cp-existing{padding:7px 9px;margin:5px 0;border:1px solid #9993;border-radius:8px;overflow-wrap:anywhere}.cp-existing span{display:block;font-size:12px;opacity:.7}.cp-remove-confirm{margin-top:8px}.cp-remove-confirm p{margin:0 0 8px}.cp-remove-confirm button+button{margin-left:8px}.cp-existing>button{margin-top:7px}.cp-hover{position:absolute;left:10px;right:10px;bottom:10px;z-index:6;padding:10px 12px;color:#eee;background:#232323;border:1px solid #9995;border-radius:12px;box-shadow:0 12px 32px #0008;font-size:12px;line-height:1.6;pointer-events:none;overflow-wrap:anywhere}.cp-hover strong{display:block;font-size:14px;margin-bottom:3px}.cp-hover p{margin:2px 0}.cp-hover-meta{color:var(--dsw-alias-state-business-primary)}.cp-hover-said,.cp-hover-from{opacity:.8}.cp-day:focus-visible,.cp-body button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}@keyframes cp-fade-in{from{opacity:0}to{opacity:1}}@keyframes cp-panel-in{from{opacity:0;transform:translate(-50%,7px) scale(.985)}to{opacity:1;transform:translate(-50%,0) scale(1)}}@media (max-width:560px){.cp-panel{top:46px;width:calc(100% - 18px);max-height:calc(100% - 56px);padding:14px}.cp-fields{grid-template-columns:1fr}}@media (prefers-reduced-motion:reduce){.cp-local-backdrop,.cp-panel{animation:none}}`;
            return h(ModuleBox,{...box},h('section',{className:'ben-wb__card ben-wb__card--fill ben-wb__publish-card','aria-labelledby':headingId},header,h('style',{},css),h('div',{className:'cp-body'},
                h('div',{className:'cp-top'},h('div',{},h('strong',{},'把下一条内容，排进日历'),h('p',{className:'cp-muted'},'点击日期直接填写 · 保存后同步到选题池')),h('button',{type:'button',className:'cp-primary',disabled:!today,onClick:e=>choose(today,e)},'＋ 添加计划')),
                h('div',{className:'cp-nav'},h('button',{type:'button','aria-label':'上个月',onClick:()=>setMonth(shiftMonth(month,-1))},'‹'),h('strong',{},month?month.replace('-',' 年 ')+' 月':'正在读取日期'),h('button',{type:'button','aria-label':'下个月',onClick:()=>setMonth(shiftMonth(month,1))},'›'),h('button',{type:'button',onClick:()=>setMonth(thisMonth)},'今天'),h('div',{className:'cp-tabs','aria-label':'发布状态'},...PUBLISH_VIEWS.map(v=>h('button',{type:'button','aria-pressed':view===v,onClick:()=>setView(v)},v)))),
                h('p',{className:'cp-muted'},`本月${view} ${monthItems.length} 条${view==='未发布'?' · 点击空白日期，安排新内容':' · 按实际发布日期显示'}`),
                notice&&!picked&&h('p',{className:'cp-notice',role:'status'},notice),
                h('div',{className:'cp-week','aria-hidden':true},...WEEKDAYS.map(d=>h('span',{},'周'+d))),
                h('div',{className:'cp-grid',role:'group','aria-label':`发布计划 月历 ${view}`},...cells.map(cell=>{const items=byDay.get(cell.date)??[],isToday=cell.date===today,late=view==='未发布'&&items.length>0&&isOverdue(cell.date,today);return h('button',{type:'button',className:'cp-day','data-out':!cell.inMonth,'data-today':isToday,'data-has':items.length>0,'data-late':late,'aria-label':`${cell.date}${isToday?'，今天':''}，${items.length}条${view}，点击填写发布计划`,onClick:e=>choose(cell.date,e)},h('span',{className:'cp-day-top'},h('span',{className:'cp-day-num'},cell.day),h('small',{},isToday?'今天':items.length?`${items.length}条`:'')),...(items.length?items.slice(0,2).map(t=>h('span',{className:'cp-chip',title:publishHoverText(publishHoverOf(t,{account:accountOf(t.project_id)})),onMouseEnter:()=>setHover(t.id),onMouseLeave:()=>setHover(null)},t.title)):[h('span',{className:'cp-add'},'＋ 添加')]))})),
                h('p',{className:'cp-muted'},'计划用于安排内容；填写实际发布日后，才会归入“已发布”。')
            ),picked&&h('div',{className:'cp-local-backdrop','aria-hidden':true,onClick:close}),picked&&h('div',{className:'cp-panel',role:'dialog','aria-modal':true,'aria-label':'填写发布计划',onKeyDown:e=>{if(e.key==='Escape'){e.stopPropagation();close()}}},h('div',{className:'cp-panel-head'},h('h2',{},daily.length?'当天发布计划':'安排一条新内容'),h('button',{type:'button',className:'cp-secondary','aria-label':'关闭发布计划',disabled:busy,onClick:close},'×')),h('p',{className:'cp-muted'},`${picked??''} · 查看当天内容，或添加新计划`),
                notice&&h('p',{className:'cp-notice',role:'status'},notice),
                error&&h('p',{className:'cp-error',role:'alert'},error),
                daily.length>0&&h('div',{},h('h3',{},`当天已有 ${daily.length} 条内容`),...daily.map(t=>h('div',{className:'cp-existing'},t.title,h('span',{},`${accountName(t.project_id)} · ${t.published_at?'已发布':'待发布'}`),
                    !t.published_at&&(confirmRemove===t.id?h('div',{className:'cp-remove-confirm'},h('p',{},'确认删除此计划？选题和素材会保留。'),h('button',{type:'button',className:'cp-secondary',disabled:busy,onClick:()=>{setConfirmRemove(null);setError('')}},'保留计划'),h('button',{type:'button',className:'cp-secondary',disabled:busy,onClick:()=>removePlan(t)},removing===t.id?'正在删除…':'确认删除')):h('button',{type:'button',className:'cp-secondary','aria-label':`删除计划：${t.title}`,disabled:busy,onClick:()=>{setConfirmRemove(t.id);setError('')}},'删除计划'))))),
                h('form',{onSubmit:submit},h('label',{},'内容标题',h('input',{autoFocus:daily.length===0,required:true,maxLength:200,value:draft,placeholder:'例如：国庆出游，3 个值得拍的镜头','aria-label':'发布内容标题',disabled:busy,onChange:e=>setDraft(e.target.value)})),
                h('div',{className:'cp-fields'},h('label',{},'发布账号',h('select',{'aria-label':'发布账号',value:account,disabled:busy,onChange:e=>setAccount(e.target.value)},h('option',{value:''},'稍后选择'),...projects.map(p=>h('option',{value:p.id},p.name)))),h('label',{},'内容形式',h('select',{'aria-label':'内容形式',value:contentType,disabled:busy,onChange:e=>setContentType(e.target.value)},...TOPIC_CONTENT_TYPES.map(t=>h('option',{value:t},t))))),
                h('div',{className:'cp-actions'},h('button',{type:'button',className:'cp-secondary',disabled:busy,onClick:close},'取消'),h('button',{type:'submit',className:'cp-primary',disabled:busy||!draft.trim()},busy&&!removing?'正在保存…':'保存发布计划')))
            ),hoverView!==undefined&&!picked&&h('div',{className:'cp-hover',role:'note','aria-label':'这一条的详情'},
                // 这几行不带 key:这一格的 `h` 把 props 整个摊进 jsx,带了 key 反而是另一条警告(原件的做法一字不动)。
                h('strong',{},hoverView.title),
                h('p',{className:'cp-hover-meta'},hoverView.meta),
                hoverView.said&&h('p',{className:'cp-hover-said'},hoverView.said),
                hoverView.source&&h('p',{className:'cp-hover-from'},PUBLISH_PLAN_SOURCE_PREFIX+hoverView.source))));
        }

module.exports = { PublishModule }
