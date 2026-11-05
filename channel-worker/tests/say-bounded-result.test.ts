import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkbenchClient } from '../src/workbench.ts'
import { SAY_RETRY_UNKNOWN_LINE, SAY_UNAVAILABLE_LINE, SAY_OUTCOME_UNKNOWN_LINE } from '../src/sayTurn.ts'
import { createSayRosterRoom, sayProducerHarness } from './helpers/sayProducerHarness.ts'

const original = '帮我建一个待办:周四下午给客户发样片,再把样片派给 Claude 剪一版,然后换个女声'
// Controlled complete envelope: the live run had no captured successful HTTP envelope.
const complete = { say_id:'controlled-s4', items:[{kind:'记',title:'周四下午给客户发样片',status:'done'},{kind:'办',title:'把样片派给 Claude 剪一版',who:'claude',status:'done'},{kind:'改',title:'换个女声',status:'done'}], say:{screen:'周四下午发样片的待办已记下；样片已派给 Claude；音色设置为女声。',spoken:'待办已记下，样片已派给 Claude，音色已换成女声。'} }
const flush=async()=>{for(let n=0;n<20;n++)await Promise.resolve()}
afterEach(()=>vi.useRealTimers())

/** In-memory HTTP transport with one ongoing idempotent handler; no network/model/window/room. */
function setup(options:{finishMs?:number,status?:number,body?:unknown,limit?:number,bodyDelayMs?:number,firstDelayMs?:number}={}) {
 vi.useFakeTimers();vi.setSystemTime(0)
 const calls:{at:number,body:any,signal:AbortSignal|null|undefined}[]=[], jobs=new Map<string,Promise<void>>()
 const effects={model:0,dispatch:0,voice:0}
 const fetchImpl=(async(_url:unknown,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body));calls.push({at:Date.now(),body,signal:init?.signal})
  let job=jobs.get(body.client_key)
  if(!job){effects.model++;job=new Promise<void>(resolve=>setTimeout(()=>{effects.dispatch++;effects.voice++;resolve()},options.finishMs??7901));jobs.set(body.client_key,job)}
  return await new Promise<Response>((resolve,reject)=>{
   const signal=init?.signal,abort=()=>reject(new DOMException('Aborted','AbortError'))
   if(signal?.aborted){abort();return}signal?.addEventListener('abort',abort,{once:true})
   const deliver=()=>{
    signal?.removeEventListener('abort',abort)
    if(options.bodyDelayMs!==undefined){
     resolve({ok:true,status:200,json:()=>new Promise((done,fail)=>{const timer=setTimeout(()=>done(complete),options.bodyDelayMs);signal?.addEventListener('abort',()=>{clearTimeout(timer);fail(new DOMException('Aborted','AbortError'))},{once:true})})} as Response)
    }else resolve(new Response(JSON.stringify(options.body??complete),{status:options.status??200}))
   }
   if(options.firstDelayMs!==undefined && calls.length===1)setTimeout(deliver,options.firstDelayMs)
   else void job.then(deliver)
  })
 }) as typeof fetch
 const client=createWorkbenchClient({baseUrl:'http://127.0.0.1:3793',fetchImpl})
 const room=createSayRosterRoom(['wb-phone-A','wb-phone-B'])
 const p=sayProducerHarness({room,limit:options.limit??2,send:(input,transport)=>client.sayTurn(input,transport)})
 p.greet('call-A','wb-phone-A')
 return {p,room,calls,effects,client}
}

describe('normal Say bounded result recovery through production client and producer',()=>{
 it('recovers a complete result at 7901ms after the original 3+3 window, with one idempotent handler',async()=>{
  const {p,calls,effects}=setup();const pending=p.submit(original),consuming=p.consume(),ack=p.ack()
  await vi.advanceTimersByTimeAsync(700);await ack
  await vi.advanceTimersByTimeAsync(7201);await pending;await consuming
  expect(p.spoken).toEqual(['我听到了。',complete.say.spoken]);expect(p.packets[0]?.reply.say).toEqual(complete.say)
  expect(p.context()).toMatchObject({last_say_id:complete.say_id});expect(calls.map(c=>c.at)).toEqual([0,3000])
  expect(calls[1]?.body).toEqual(calls[0]?.body);expect(Object.keys(calls[0]!.body).sort()).toEqual(['client_key','ctx','entrance','text'])
  expect(effects).toEqual({model:1,dispatch:1,voice:1});expect(p.packets).toHaveLength(1)
 })
 it('uses only the remaining budget and settles at 15000ms with no third POST',async()=>{
  const {p,calls}=setup({finishMs:20000,limit:1});let ended=false
  const pending=p.submit(original).then(()=>{ended=true}),consuming=p.consume()
  await vi.advanceTimersByTimeAsync(14999);expect(ended).toBe(false);expect(p.spoken).toEqual([])
  await vi.advanceTimersByTimeAsync(1);await pending;await consuming
  expect(p.spoken).toEqual([SAY_RETRY_UNKNOWN_LINE]);expect(p.packets.filter(x=>x.reply.say_id)).toEqual([]);expect(calls).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(10000);expect(calls).toHaveLength(2);expect(p.spoken).toEqual([SAY_RETRY_UNKNOWN_LINE])
 })
 it('accepts a complete reply just before the total deadline without allocating another window',async()=>{
  const {p,calls}=setup({finishMs:14999,limit:1});const pending=p.submit(original),consuming=p.consume()
  await vi.advanceTimersByTimeAsync(14999);await pending;await consuming
  expect(p.spoken).toEqual([complete.say.spoken]);expect(calls).toHaveLength(2);expect(p.packets[0]?.reply.say.screen).toBe(complete.say.screen)
 })
 it('reports retry still_running honestly as soon as it arrives and does not issue a third POST',async()=>{
  const {p,calls}=setup({status:409,body:{code:'still_running'},limit:1});const pending=p.submit(original),consuming=p.consume()
  await vi.advanceTimersByTimeAsync(7901);await pending;await consuming
  expect(p.spoken).toEqual([SAY_OUTCOME_UNKNOWN_LINE]);expect(calls).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(20000);expect(calls).toHaveLength(2)
 })
 it('does not send a retry if scheduling delays have already exhausted the overall budget',async()=>{
  const {p,calls}=setup({finishMs:30000,limit:1});const pending=p.submit(original),consuming=p.consume()
  vi.setSystemTime(16000);await vi.advanceTimersByTimeAsync(3000);await pending;await consuming
  expect(calls).toHaveLength(1);expect(p.spoken).toEqual([SAY_RETRY_UNKNOWN_LINE])
 })
 it('keeps an ordinary direct caller default HTTP budget at 3000ms',async()=>{
  const {client}=setup({finishMs:7901});const promise=client.sayTurn({text:'direct default',clientKey:'direct-default'})
  await vi.advanceTimersByTimeAsync(3000);expect(await promise).toMatchObject({ok:false,timedOut:true})
 })
 for(const which of ['initial','retry'] as const)it(`keeps non-retryable ${which} errors finite without a third call`,async()=>{
  const {p,calls}=setup({finishMs:which==='initial'?100:7901,status:503,limit:1});const pending=p.submit(original),consuming=p.consume()
  await vi.advanceTimersByTimeAsync(7901);await pending;await consuming
  expect(calls).toHaveLength(which==='initial'?1:2);expect(p.spoken).toEqual([which==='initial'?SAY_UNAVAILABLE_LINE:SAY_RETRY_UNKNOWN_LINE]);expect(p.packets.filter(x=>x.reply.say_id)).toEqual([])
 })
 it('validates the complete response before success even when it arrives within the remaining budget',async()=>{
  const {p}=setup({body:{say_id:'bad',items:[],say:{spoken:'不完整'}}});const pending=p.submit(original),consuming=p.consume()
  await vi.advanceTimersByTimeAsync(7901);await pending;await consuming
  expect(p.spoken).toEqual([SAY_RETRY_UNKNOWN_LINE]);expect(p.packets.filter(x=>x.reply.say_id)).toEqual([]);expect(p.context()).toEqual({in_call:true})
 })
 for(const stage of ['initial','retry'] as const)for(const lifecycle of ['hangup','greet','disconnect','new-final'] as const)it(`${lifecycle} aborts obsolete ${stage} waiting without accepting its delayed result`,async()=>{
  const {p,room,calls}=setup();const pending=p.submit(original),consuming=p.consume()
  if(stage==='retry')await vi.advanceTimersByTimeAsync(3500);else await flush()
  const oldCalls=[...calls]
  if(lifecycle==='hangup')p.hangup()
  else if(lifecycle==='greet')p.greet('call-B','wb-phone-B')
  else if(lifecycle==='disconnect')room.disconnect('wb-phone-A')
  else void p.submit('新输入')
  await flush();expect(oldCalls.every(c=>c.signal?.aborted)).toBe(true)
  let ended=false;void pending.then(()=>{ended=true});await flush();expect(ended).toBe(true)
  await consuming;expect(p.spoken).toEqual([]);expect(p.packets.filter(x=>x.reply.say_id)).toEqual([])
  if(lifecycle!=='new-final'){await vi.advanceTimersByTimeAsync(20000);expect(calls).toHaveLength(stage==='initial'?1:2);expect(p.spoken).toEqual([]);expect(p.packets.filter(x=>x.reply.say_id)).toEqual([])}
 })
 it('does not restart a fresh 15-second timer for response body consumption',async()=>{
  const {p,calls}=setup({finishMs:14900,bodyDelayMs:500,limit:1});const pending=p.submit(original),consuming=p.consume()
  await vi.advanceTimersByTimeAsync(15000);await pending;await consuming
  expect(p.spoken).toEqual([SAY_RETRY_UNKNOWN_LINE]);expect(calls).toHaveLength(2);expect(p.packets.filter(x=>x.reply.say_id)).toEqual([])
 })
})
