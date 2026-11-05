/** Production App retarget; restored genuine defaults, no synthetic links or responses. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.COLLAB_1C_BROWSER_ROOT; assert(root);
const source = join(root, 'source'); const pairing = JSON.parse(readFileSync(process.env.COLLAB_1C_SESSION ?? join(source, 'browser-session.json'), 'utf8'));
const evidence = existsSync(join(root,'retarget-evidence.json')) ? JSON.parse(readFileSync(join(root,'retarget-evidence.json'),'utf8')) : []; const save = (stage,data) => { evidence.push({stage,...data}); writeFileSync(join(root,'retarget-evidence.json'),JSON.stringify(evidence,null,2)); console.log(stage,JSON.stringify(data)); };
const base=`http://${pairing.host}:${pairing.port}`;
async function api(path,body) { const r=await fetch(base+path,{headers:{authorization:`Bearer ${pairing.token}`,'content-type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});const data=await r.json();assert(r.ok,`${path} ${r.status}: ${JSON.stringify(data)}`);return data; }
async function receipt(id) { for(let i=0;i<500;i++){const task=(await api('/state')).tasks.tasks.find(t=>t.id===id);if(['done','failed'].includes(task?.dispatch?.status)||task?.dispatch_block||task?.status==='blocked')return task;await new Promise(r=>setTimeout(r,300));}throw Error('Receipt timeout'); }
const prior=(await api('/state')).tasks.tasks;
const {chromium}=await import('/tmp/collab-mobile-verify/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({headless:true,executablePath:'/Users/example/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'});
let page; mkdirSync(join(root,'screens'),{recursive:true});
try {
 const ctx=await browser.newContext({viewport:{width:375,height:812}});
 await ctx.addInitScript(p=>{localStorage.setItem('CapacitorStorage.butler.pairing',JSON.stringify(p));localStorage.setItem('CapacitorStorage.butler.settings',JSON.stringify({voiceEnabled:false,onboarding:'done',stage:'particles',callProvider:'livekit',ringStandby:false}));},pairing);
 page=await ctx.newPage();page.setDefaultTimeout(20000);const posts=[]; const reads=[];
 page.on('response',async r=>{const url=new URL(r.url());if(['/sessions/transcript','/sessions/digest'].includes(url.pathname))reads.push({path:url.pathname,agent:url.searchParams.get('agent'),id:url.searchParams.get('id'),status:r.status(),body:await r.json()});});
 page.on('response',async r=>{if(new URL(r.url()).pathname==='/butler/say'&&r.request().method()==='POST')posts.push({request:r.request().postDataJSON(),status:r.status(),body:await r.json()});});
 // Resume only the exact already-sent App request key through the real idempotent API. No reply is injected.
 const priorPost=evidence.find(row=>row.stage==='production-decided');
 if(priorPost) await page.route('**/butler/say',async route=>{const input=route.request().postDataJSON();await route.continue(input.text===priorPost.request.text ? {postData:JSON.stringify(priorPost.request)} : {});});
 const nextPost=async before=>{for(let i=0;i<300&&posts.length<=before;i++)await new Promise(r=>setTimeout(r,100));assert(posts.length>before,'No App response');return posts.at(-1);};
 await page.goto('http://127.0.0.1:9695/',{waitUntil:'domcontentloaded'});
 let decided,decision,original,target,action;
 const done=evidence.find(row=>row.stage==='production-retarget');
 if(done){ decided=priorPost; decision=decided.body.decided.find(d=>d.field==='who'); original=decided.body.items[decision.item_index]; target=evidence.find(row=>row.stage==='normal-registered-target').target; action=done; save('read-only-resume',{originalId:original.card_id,newExecutions:0}); await page.getByRole('button',{name:'记录',exact:true}).click(); }
 else {
 await page.getByLabel('打字说给事务官').fill('安排代码通道改选口令核对');await page.getByRole('button',{name:'发送',exact:true}).click();
 decided=await nextPost(0);save('production-decided',decided);
 decision=decided.body.decided?.find(d=>d.field==='who');assert(decided.status===200&&decision?.decided_id);
 original=decided.body.items[decision.item_index];assert(original?.card_id);
 const failed=await receipt(original.card_id);save('original-scope-refusal',{task:failed,refusal:JSON.parse(readFileSync(join(source,'scope-refusal.json'),'utf8'))});assert(failed.status==='blocked'&&failed.note.includes('Outside authorized controlled CLI acceptance'));
 target=await api('/collab/agent/save',{name:'1c 受控改选 Luna',hand:'cli',runtime:{family:'codex'},project:{repo:'/tmp/collab-1c-retarget-1024'},model:{name:'gpt-6-luna',effort:'low'},shared:{to:'none'}});assert(target.ok&&target.id);save('normal-registered-target',{target});
 await page.getByRole('button',{name:'记录',exact:true}).click();
 await page.getByText(`原件：${original.title} · 事项 ID ${original.card_id}`,{exact:true}).waitFor();
 const button=page.getByRole('button',{name:'改为 1c 受控改选 Luna',exact:true});await button.waitFor();
 const before=posts.length;await button.click();action=await nextPost(before);save('production-retarget',action);
 assert.deepEqual(action.request.ctx.decided,{decided_id:decision.decided_id,choice:target.id});assert.equal(action.request.ctx.last_say_id,decided.body.say_id);assert.equal(action.body.items[0].card_id,original.card_id);
 await page.getByText(action.body.say.screen,{exact:true}).first().waitFor();
 }
 const actual=await receipt(original.card_id);save('actual-receipt',{task:actual});assert.equal(actual.assignee,target.id);
 assert.equal(actual.dispatch?.status,'done');assert.equal(actual.dispatch?.cwd,'/tmp/collab-1c-retarget-1024');
 const link=actual.links?.find(l=>l.agent==='codex'&&l.session_id===actual.dispatch.session_id);assert(link,'Natural matching session link');
 const executions=JSON.parse(readFileSync(join(source,'executions.json'),'utf8'));save('actual-invocation',{executions});assert.equal(executions.executions,1);assert(executions.argv.includes('gpt-6-luna'));
 const after=(await api('/state')).tasks.tasks;for(const old of prior.filter(t=>t.id!==original.card_id))assert.deepEqual(after.find(t=>t.id===old.id),old,`Unrelated original changed ${old.id}`);save('no-cross-card',{ids:prior.filter(t=>t.id!==original.card_id).map(t=>t.id),originalId:original.card_id,targetId:target.id});
 await page.screenshot({path:join(root,'screens/retarget-result-375.png')});
 await page.getByRole('button',{name:'事项',exact:true}).click();await page.getByRole('tab',{name:/^等你/}).click();await page.getByText(original.title,{exact:true}).first().click();
 await page.getByRole('button',{name:/^查看原会话：/}).click();const region=page.getByRole('region',{name:'原会话回读'});await region.waitFor();
 await region.locator('.ba-rounds__reply').filter({hasText:actual.dispatch.reply}).last().waitFor();
 const text=await region.innerText(); assert(reads.some(r=>r.status===200&&r.agent==='codex'&&r.id===link.session_id)); save('actual-reader-http',{reads});save('production-original-reader',{text,session_id:link.session_id});assert(text.includes(actual.dispatch.reply));
 await region.locator('.ba-rounds__reply').last().scrollIntoViewIfNeeded();
 await page.screenshot({path:join(root,'screens/retarget-original-375.png')});
 // A real refusal is evidence, not business completion; never spend a second execution.
 assert.equal(actual.dispatch.reply?.trim(),'QA_1C_RETARGET_REAL','CLI did not complete the requested mechanical token');
 save('complete',{sameOriginal:original.card_id,stableTarget:target.id,naturalSession:link.session_id,boundary:'Plan fixture transport only; actual registered target, one Codex execution, natural links and production App reader. Effort forwarding is not supported by current adapter.'});
} catch(e){if(page){await page.screenshot({path:join(root,'screens/retarget-failure.png')});save('failure-ui',{text:await page.locator('body').innerText()});}throw e;}finally{await browser.close();}
