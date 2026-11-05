/*
 * ## 2026-10-21:搬出本体,进用户层(卡「分层第一刀」,设计 docs/设计-分层第一刀-2026-10-21.md)
 *
 * 原来在 workbench-plugin/src/client/air/topics.js,编进本体;现在是用户层里的一格小组件,
 * 由本体的加载口(client/userLayer.tsx)按 widget.json 装进来。**逻辑、文案、CSS 一个字没动**,
 * 只换了两处写法:
 *
 * - 顶上那几行 `import … from '../X.tsx'` → `require(…)`:react、react/jsx-runtime 照旧,
 *   本体那几样一律从 `require('@workbench/host')` 拿(那张表在本体 client/userLayerHost.ts);
 * - `export function TodoModule(` → `function TodoModule(`,文件末尾 `module.exports = { TodoModule }`。
 *
 * 下面是这一格搬家之前的全部档案,原样留着。原件存档在 user-layer/原件/air-20261002/(只读)。
 */
/*
 * 原件:contrib/air-20261002/src/topics.js,2026-10-03 原封不动接入,只做了下面这几处机械替换:
 *
 * - `(0, react_jsx_runtime.jsx)` → `jsx`(1 处)
 * - `(0, react.useState)` → `useState`(15 处)
 * - `(0, react.useRef)` → `useRef`(1 处)
 * - `function TodoModule(` → `export function TodoModule(`
 * - `isOpen` / `isTopic` / `stageOf` / `LegacyTodoModule` 从 ../TodoModule.tsx import;`TOPIC_STAGES` / `TOPIC_CONTENT_TYPES` / `DEFAULT_TOPIC_STAGE` / `nextTopicStage` 从 ../../protocol.ts import
 * - 删掉原件里那一份 `LegacyTodoModule` —— 他在它身上改的四处(initialOpen / embedded / actionNote+checkedPost / 嵌入时 Fragment)原样落进 ../TodoModule.tsx,再 import,不留两份
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
 * - `#b9a5ee` ×1 / `#c8b8f1` ×2 / `#d2c2f6` ×1 / `#d6c5ff` ×1 → `var(--dsw-alias-state-business-primary)`
 * - `#eeecf5` ×1(浮层里的主文字色)→ `#eee`(同上):它配的是他写死的深底(`#222126` / `#19191d` / `#28262e`,不是紫,这张卡不动),所以也只能是一个写死的浅字 —— 用令牌会在浅色主题里变成深字压在深底上
 * - `#231d34` ×1(`.ct-primary` 实心强调底上的字)→ `var(--dsw-alias-bg-base)`
 * - `#b9a5ee0b` → 4% / `#b9a5ee14` → 8% / `#b9a5ee20` ×2 → 13% / `#b9a5ee55` ×2 → 33% / `#b9a5ee77` → 47% / `#b9a5ee88` ×2 → 53%(都是 `color-mix` 到 transparent)
 *
 * ## 2026-10-13:上一行判过「不是紫」的那几个深底 → 纯灰
 *
 * 维护者原话:「自媒体布局的所有紫色改成和产品研发布局的黑白灰」。10-03 放过的那几个深底
 * 三个通道其实差 4~6(偏紫的灰),这一轮按同一个明度换成纯灰;**配着它们的那个写死浅字
 * `#eee` 一个字没动**(理由同上:浮层的底是写死的,字也只能写死)。
 *
 * - `#222126` ×2(`.ct-modal` 那张浮层、它里面那条吸顶的 `.ct-head`)→ `#232323`
 * - `#242228` ×1(`.ct-body option`)→ `#252525`
 */

const { useRef, useState } = require('react')
const { jsx } = require('react/jsx-runtime')
const { ui: { ModuleBox }, builtin: { TodoModule: LegacyTodoModule }, topics: {
  DEFAULT_TOPIC_STAGE, TOPIC_CONTENT_TYPES, TOPIC_STAGES, nextTopicStage, isOpen, isTopic, stageOf,
} } = require('@workbench/host')

        function TodoModule(props) {
            const {box,header,headingId,baseUrl,fetchImpl,tasks=[],projects=[]}=props;
            const h=(type,p,...children)=>jsx(type,{...p,...(children.length?{children:children.length===1?children[0]:children}:{})});
            const [section,setSection]=useState('topics'),[filter,setFilter]=useState('全部'),[query,setQuery]=useState('');
            const [adding,setAdding]=useState(false),[title,setTitle]=useState(''),[account,setAccount]=useState(''),[type,setType]=useState('视频'),[date,setDate]=useState('');
            const [planning,setPlanning]=useState(null),[planned,setPlanned]=useState('');
            const [detail,setDetail]=useState(null),[confirm,setConfirm]=useState(null),[actual,setActual]=useState('');
            const [busy,setBusy]=useState(false),[said,setSaid]=useState('');
            const lock=useRef(false);
            const topics=tasks.filter(t=>isOpen(t)&&isTopic(t)),others=tasks.filter(t=>isOpen(t)&&!isTopic(t));
            const visible=(section==='topics'?topics:others).filter(t=>(section!=='topics'||filter==='全部'||stageOf(t)===filter)&&(!query.trim()||t.title.toLowerCase().includes(query.trim().toLowerCase())));
            const selected=tasks.find(t=>t.id===detail),publishing=tasks.find(t=>t.id===confirm);
            async function post(path,body,success){if(lock.current)return false;lock.current=true;setBusy(true);setSaid('');try{const r=await fetchImpl(`${baseUrl}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error??'操作未完成');setSaid(success+(j.dir_note?' · '+j.dir_note:''));return true}catch(e){setSaid('未完成：'+(e instanceof Error?e.message:'请重试'));return false}finally{lock.current=false;setBusy(false)}}
            async function create(e){e.preventDefault();if(!title.trim())return;if(await post('/task/create',{title:title.trim(),kind:'topic',status:'todo',stage:DEFAULT_TOPIC_STAGE,content_type:type,...(account?{project_id:account}:{}),...(date?{planned_at:date}:{})},'选题已创建')){setAdding(false);setTitle('');setDate('');setFilter('全部')}}
            const advance=t=>post('/task/advance',{id:t.id},`「${t.title}」已推进到${nextTopicStage(stageOf(t))}`);
            const accountName=id=>projects.find(p=>p.id===id)?.name??'未指定账号';
            const css=`.ct-body{overflow:auto;min-height:0;padding:4px 2px 10px;font-size:14px;line-height:1.6}.ct-body *,.ct-modal *{box-sizing:border-box}.ct-body button,.ct-modal button{font:inherit;color:inherit;cursor:pointer}.ct-head,.ct-tabs,.ct-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ct-head{justify-content:space-between;margin-bottom:12px}.ct-head strong{font-size:19px}.ct-head p{margin:3px 0;font-size:12px;opacity:.65}.ct-body button,.ct-modal button{border:1px solid #9994;border-radius:8px;background:#ffffff06;padding:6px 11px}.ct-primary{background:var(--dsw-alias-state-business-primary)!important;color:var(--dsw-alias-bg-base)!important;border-color:var(--dsw-alias-state-business-primary)!important;font-weight:650!important}.ct-tabs{margin:9px 0}.ct-tabs button[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 53%,transparent);color:var(--dsw-alias-state-business-primary)}.ct-body input,.ct-body select,.ct-modal input{font:inherit;color:inherit;background:#ffffff06;border:1px solid #9995;border-radius:9px;padding:9px 11px;min-width:0}.ct-body option{background:#252525}.ct-search{width:100%;margin:7px 0 12px}.ct-card{border:1px solid #9993;border-left:3px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 53%,transparent);border-radius:12px;padding:14px;margin:10px 0;background:linear-gradient(110deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 4%,transparent),transparent)}.ct-title{font-size:16px;font-weight:650;margin-bottom:5px;overflow-wrap:anywhere}.ct-meta{font-size:12px;opacity:.72;margin:5px 0 11px}.ct-badge{display:inline-block;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);border-radius:6px;padding:2px 7px;margin-right:7px;font-size:12px}.ct-actions{margin-top:10px}.ct-empty{padding:25px 12px;text-align:center;opacity:.65}.ct-notice{padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 33%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent);border-radius:9px;margin:8px 0;overflow-wrap:anywhere}.ct-form{border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 47%,transparent);border-radius:12px;padding:14px;margin:12px 0}.ct-form label{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}.ct-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.ct-body button:disabled,.ct-modal button:disabled{opacity:.45;cursor:default}.ct-overlay{position:fixed;inset:0;z-index:10001;background:#0009;backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center}.ct-modal{background:#232323;color:#eee;width:min(860px,92vw);max-height:86vh;overflow:auto;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 33%,transparent);border-radius:18px;padding:24px;box-shadow:0 24px 100px #0008;font-size:14px}.ct-modal .ct-head{position:sticky;top:-24px;background:#232323;padding:10px0;z-index:2}.ct-modal h2{font-size:21px;margin:0}.ct-detail .ben-wb__topics-bar,.ct-detail .ben-wb__topics-colname,.ct-detail .ben-wb__topics-hint,.ct-detail .ben-wb__topics-head{display:none}.ct-detail .ben-wb__card--fill{display:block!important;height:auto!important;max-height:none!important;overflow:visible!important}.ct-detail .ben-wb__topics-scroll{display:block!important;flex:none!important;height:auto!important;max-height:none!important;overflow:visible!important}.ct-detail .ben-wb__topics-list{display:block!important;height:auto!important;overflow:visible!important}.ct-detail .ben-wb__topics-col{height:auto!important;max-height:none!important;overflow:visible!important}.ct-detail .ben-wb__topics-body{height:auto!important;max-height:none!important;overflow:visible!important}.ct-detail .ben-wb__topics-col{flex:none}.ct-detail .ben-wb__topics-col{width:100%;min-width:0}.ct-detail .ben-wb__topics-card{padding:12px;font-size:14px}.ct-detail .ben-wb__topics-list{padding:0;flex:none!important}.ct-detail .ben-wb__topics-col{display:block!important;flex:none!important}.ct-detail .ben-wb__topics-card{flex:none!important;overflow:visible!important}.ct-detail .ben-wb__card--fill{flex:none!important}.ct-detail .ben-wb__topics-head{display:none!important}.ct-detail .ben-wb__topics-body{font-size:14px}.ct-modal label{display:flex;flex-direction:column;gap:7px;margin:15px 0}.ct-body button:focus-visible,.ct-body input:focus-visible,.ct-modal button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}`;
            return h(ModuleBox,{...box},h('section',{className:'ben-wb__card ben-wb__card--fill','aria-labelledby':headingId},header,h('style',{},css),h('div',{className:'ct-body'},
                h('div',{className:'ct-head'},h('div',{},h('strong',{},'让灵感，成为下一条内容'),h('p',{},'选题 → 制作 → 待发布 → 确认已发布')),h('button',{type:'button',className:'ct-primary',onClick:()=>{setSection('topics');setAdding(v=>!v)}},adding?'收起新建':'＋ 新建选题')),
                h('div',{className:'ct-tabs','aria-label':'内容与事项'},h('button',{type:'button','aria-pressed':section==='topics',onClick:()=>setSection('topics')},`创作选题 ${topics.length}`),h('button',{type:'button','aria-pressed':section==='others',onClick:()=>{setSection('others');setAdding(false)}},`其它事项 ${others.length}`)),
                said&&h('p',{role:'status',className:'ct-notice'},said),
                adding&&h('form',{className:'ct-form',onSubmit:create},h('label',{},'选题标题',h('input',{autoFocus:true,required:true,value:title,'aria-label':'新选题标题',placeholder:'你下一条想做什么内容？',disabled:busy,onChange:e=>setTitle(e.target.value)})),h('div',{className:'ct-fields'},h('label',{},'账号',h('select',{value:account,'aria-label':'选题账号',onChange:e=>setAccount(e.target.value)},h('option',{value:''},'稍后选择'),...projects.map(p=>h('option',{value:p.id},p.name)))),h('label',{},'形式',h('select',{value:type,'aria-label':'选题内容形式',onChange:e=>setType(e.target.value)},...TOPIC_CONTENT_TYPES.map(t=>h('option',{value:t},t)))),h('label',{},'计划发布日（可选）',h('input',{type:'date',value:date,'aria-label':'新选题计划发布日',onChange:e=>setDate(e.target.value)}))),h('div',{className:'ct-actions'},h('button',{type:'submit',className:'ct-primary',disabled:busy||!title.trim()},busy?'保存中…':'保存选题'),h('button',{type:'button',disabled:busy,onClick:()=>setAdding(false)},'取消'))),
                section==='topics'&&h('div',{className:'ct-tabs','aria-label':'筛选选题阶段'},...['全部',...TOPIC_STAGES].map(s=>h('button',{type:'button','aria-pressed':filter===s,onClick:()=>setFilter(s)},`${s==='发布'?'待发布 / 已发布':s} ${s==='全部'?topics.length:topics.filter(t=>stageOf(t)===s).length}`))),
                h('input',{className:'ct-search',type:'search',value:query,'aria-label':'搜索选题或事项',placeholder:section==='topics'?'搜索选题标题…':'搜索其它事项…',onChange:e=>setQuery(e.target.value)}),
                ...visible.map(t=>{const stage=stageOf(t),next=nextTopicStage(stage),topic=isTopic(t);return h('article',{className:'ct-card'},h('div',{className:'ct-title'},t.title),h('div',{},h('span',{className:'ct-badge'},topic?(stage==='发布'?(t.published_at?'已发布':'待发布'):stage):'普通事项'),topic&&t.published_at&&stage!=='发布'&&h('span',{className:'ct-badge'},'已发布')),h('p',{className:'ct-meta'},`${accountName(t.project_id)}${t.content_type?' · '+t.content_type:''}${t.planned_at?' · 计划 '+t.planned_at:''}${t.published_at?' · 已发布 '+t.published_at:''}`),!topic&&t.desc&&h('p',{},t.desc),h('div',{className:'ct-actions'},h('button',{type:'button',onClick:()=>setDetail(t.id)},topic?'详情与素材':'查看事项'),topic&&h('button',{type:'button',onClick:()=>{setPlanning(t.id);setPlanned(t.planned_at??'');setSaid('')}},'安排发布日'),topic&&stage==='发布'&&!t.published_at?h('button',{type:'button',className:'ct-primary',disabled:busy,onClick:()=>{setConfirm(t.id);setActual('')}},'确认已发布'):topic&&next?h('button',{type:'button',className:'ct-primary',disabled:busy,onClick:()=>advance(t)},`推进到${next==='发布'?'待发布':next}`):null))}),
                !visible.length&&h('p',{className:'ct-empty'},query?'没有找到匹配内容':section==='topics'?'这里还没有选题，点“＋ 新建选题”开始。':'暂无其它事项')
            ),selected&&h('div',{className:'ct-overlay',onKeyDown:e=>{if(e.key==='Escape'){e.stopPropagation();setDetail(null)}}},h('div',{className:'ct-modal',role:'dialog','aria-modal':true,'aria-label':'选题详情'},h('div',{className:'ct-head'},h('h2',{},selected.title),h('button',{type:'button',onClick:()=>setDetail(null)},'关闭详情')),h('div',{className:'ct-detail'},h(LegacyTodoModule,{...props,tasks:[selected],initialOpen:selected.id,embedded:true,header:null})))),
                planning&&h('div',{className:'ct-overlay'},h('div',{className:'ct-modal',role:'dialog','aria-modal':true,'aria-label':'安排发布日'},h('h2',{},'安排发布日'),h('p',{},tasks.find(t=>t.id===planning)?.title),h('form',{onSubmit:async e=>{e.preventDefault();if(await post('/task/update',{id:planning,planned_at:planned||null},'发布排期已保存'))setPlanning(null)}},h('label',{},'计划发布日（留空可取消排期）',h('input',{type:'date',value:planned,'aria-label':'调整计划发布日',disabled:busy,onChange:e=>setPlanned(e.target.value)})),said&&h('p',{role:'status'},said),h('div',{className:'ct-actions'},h('button',{type:'submit',className:'ct-primary',disabled:busy},busy?'保存中…':'保存排期'),h('button',{type:'button',disabled:busy,onClick:()=>setPlanning(null)},'取消'))))),
                publishing&&h('div',{className:'ct-overlay'},h('div',{className:'ct-modal',role:'dialog','aria-modal':true,'aria-label':'确认内容已发布'},h('h2',{},'确认这条内容已经发布'),h('p',{},publishing.title),h('p',{},'请填写实际发布日。这里只记录发布结果，不会替你发布到平台。'),h('form',{onSubmit:async e=>{e.preventDefault();if(actual&&await post('/task/update',{id:publishing.id,published_at:actual},'已记录实际发布日期'))setConfirm(null)}},h('label',{},'实际发布日',h('input',{type:'date',required:true,value:actual,'aria-label':'确认实际发布日',disabled:busy,onChange:e=>setActual(e.target.value)})),said&&h('p',{role:'status'},said),h('div',{className:'ct-actions'},h('button',{type:'submit',className:'ct-primary',disabled:busy||!actual},busy?'保存中…':'确认已发布'),h('button',{type:'button',disabled:busy,onClick:()=>setConfirm(null)},'取消')))))
            ));
        }

module.exports = { TodoModule }
