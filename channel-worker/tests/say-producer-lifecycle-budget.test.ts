import { afterEach, describe, expect, it, vi } from 'vitest'
import { sayProducerHarness, type Result } from './helpers/sayProducerHarness.ts'
import { SAY_OUTCOME_UNKNOWN_LINE } from '../src/sayTurn.ts'

function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r}); return {promise,resolve} }
const flush = async () => { for(let i=0;i<15;i++)await Promise.resolve() }
const reply=(id:string):Result=>({ok:true,reply:{say_id:id,items:[],ask:{ask_id:'ask-'+id,question:'确认吗？'},say:{screen:'记下了受控事项。',spoken:'记下了受控事项。'}}})
afterEach(()=>vi.useRealTimers())

describe('production Say lifecycle and real shared sentence budget',()=>{
 it('drops a first success after hangup A -> greet B with no new final',async()=>{
  const first=deferred<Result>(),p=sayProducerHarness({limit:2,send:()=>first.promise});p.greet('A');const a=p.submit();const consuming=p.consume();p.hangup();p.greet('B');first.resolve(reply('A'));await a;await consuming
  expect(p.context('yes')).toEqual({in_call:true});expect(p.packets).toEqual([]);expect(p.spoken).toEqual([])
 })
 it('drops the same-key retry after A is replaced by B, preserving empty B context',async()=>{
  const retry=deferred<Result>(),calls:any[]=[];const p=sayProducerHarness({limit:2,send:async input=>{calls.push(input);return calls.length===1?{ok:false,timedOut:true}:retry.promise}});p.greet('A');const a=p.submit();const consuming=p.consume();await flush();p.hangup();p.greet('B');retry.resolve(reply('old'));await a;await consuming;await flush()
  expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect(p.context('yes')).toEqual({in_call:true});expect(p.packets).toEqual([]);expect(p.spoken).toEqual([])
 })
 it('retains the latest final context when two first responses arrive in reverse order',async()=>{
  const first=deferred<Result>(),second=deferred<Result>();let n=0;const p=sayProducerHarness({send:()=>++n===1?first.promise:second.promise});p.greet('same');const a=p.submit('第一句'),b=p.submit('第二句');second.resolve(reply('new'));await b;first.resolve(reply('old'));await a
  expect(p.context('no')).toEqual({in_call:true,last_say_id:'new',confirmed:{ask_id:'ask-new',choice:'否'}})
 })
 for(const limit of [1,2])for(const outcome of ['success','still_running','error','timeout']as const)it(`limit=${limit}: acknowledgement/timeout/${outcome} preserves one audible final result`,async()=>{
  vi.useFakeTimers();const first=deferred<Result>(),retry=deferred<Result>(),calls:any[]=[];const p=sayProducerHarness({limit,send:input=>{calls.push(input);return calls.length===1?first.promise:retry.promise}});p.virtual();const a=p.submit();const consuming=p.consume();const ack=p.ack();await vi.advanceTimersByTimeAsync(700);await ack
  first.resolve({ok:false,timedOut:true});await flush();const result=outcome==='success'?reply('late'):outcome==='still_running'?{ok:false,outcomeUncertain:true}:outcome==='timeout'?{ok:false,timedOut:true}:{ok:false,why:'HTTP 503'};retry.resolve(result);await a;await consuming;await flush()
  const final=outcome==='success'?'记下了受控事项。':outcome==='still_running'?SAY_OUTCOME_UNKNOWN_LINE:'我还没收到这句的结果，是否办成还不确定；我不会重复办理。'
  expect(p.spoken).toEqual(limit===1?[final]:['我听到了。',final]);expect(p.budget.spent).toBeLessThanOrEqual(limit);expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect(p.spoken.join('')).not.toContain('马上办')
 })
 it('publishes the real captured call id and retains confirmation for a current normal result',async()=>{
  const p=sayProducerHarness({limit:2,send:async()=>reply('normal')});p.greet('original');await p.submit();await p.consume();expect(p.packets.map(x=>x.callId)).toEqual(['original']);expect(p.context('yes')).toMatchObject({last_say_id:'normal',confirmed:{ask_id:'ask-normal',choice:'是'}})
 })
 it('keeps no-call legacy/virtual input compatible without inventing a call id',async()=>{
  const p=sayProducerHarness({limit:1,send:async()=>reply('legacy')});p.legacy();p.virtual();await p.submit();await p.consume();expect(p.spoken).toEqual(['记下了受控事项。']);expect(p.packets[0]?.callId).toBeUndefined()
 })
})

describe('cancellation, unchanged acknowledgement and result stream boundaries',()=>{
 it('suppresses the 700ms acknowledgement if the call changes before its timer',async()=>{
  vi.useFakeTimers();const d=deferred<Result>(),p=sayProducerHarness({limit:2,send:()=>d.promise});p.greet('A');const a=p.submit(),ack=p.ack();p.greet('B');await vi.advanceTimersByTimeAsync(701);await ack;d.resolve(reply('old'));await a;expect(p.spoken).toEqual([]);expect(p.context()).toEqual({in_call:true})
 })
 it('keeps normal initial errors audible without reissuing or consuming an existing confirmation',async()=>{
  const calls:any[]=[];const p=sayProducerHarness({limit:2,send:async input=>{calls.push(input);return calls.length===1?reply('ask'):{ok:false,why:'HTTP 503'}}});p.greet('A');await p.submit();await p.consume();await p.submit('否');await p.consume();expect(calls[1].ctx.confirmed).toEqual({ask_id:'ask-ask',choice:'否'});expect(p.context('no')).toMatchObject({last_say_id:'ask',confirmed:{ask_id:'ask-ask',choice:'否'}});expect(calls).toHaveLength(2);expect(p.spoken[1]).toContain('暂时不可用')
 })
 it('suppresses stale transport errors and never retries them in the new call',async()=>{
  const d=deferred<Result>(),calls:any[]=[];const p=sayProducerHarness({send:input=>{calls.push(input);return d.promise}});p.greet('A');const a=p.submit(),consume=p.consume();p.hangup();p.greet('B');d.resolve({ok:false,timedOut:true});await a;await consume;expect(calls).toHaveLength(1);expect(p.spoken).toEqual([]);expect(p.packets).toEqual([])
 })
 it('drops speech when its stream is invalidated before pull and does not spend the next turn budget',async()=>{
  const {guardSayStream}=await import('../src/sayTurn.ts');const {SentenceBudget,withSentenceCap}=await import('../src/sentenceCap.ts');const {saidStream}=await import('../src/understand.ts');let current=true;const budget=new SentenceBudget();const stream=guardSayStream(saidStream<string>('旧结果。'),()=>current);current=false;const got=[];for await(const text of withSentenceCap(stream,budget,1))got.push(text);expect(got).toEqual([]);expect(budget.spent).toBe(0)
 })
})

describe('incoming call and ordinary no-limit acknowledgement siblings',()=>{
 for(const legacy of [false,true])it(`successful incoming answer invalidates an earlier call, legacy=${legacy}`,async()=>{const d=deferred<Result>();const p=sayProducerHarness({send:()=>d.promise});p.greet('old');const a=p.submit(),consuming=p.consume();await p.answer('incoming',legacy);d.resolve(reply('old'));await a;await consuming;expect(p.context()).toEqual({in_call:true});expect(p.packets).toEqual([]);expect(p.spoken).toEqual([])})
 it('keeps an ordinary pending acknowledgement when the sentence rule is absent',async()=>{vi.useFakeTimers();const d=deferred<Result>();const p=sayProducerHarness({send:()=>d.promise});p.greet('normal');const a=p.submit(),consuming=p.consume(),ack=p.ack();await vi.advanceTimersByTimeAsync(701);await ack;d.resolve(reply('ok'));await a;await consuming;expect(p.spoken).toEqual(['我听到了。','记下了受控事项。'])})
})

describe('legacy replacement call association',()=>{
 it('does not borrow an earlier device call id when the next greet has no identity/id',async()=>{
  const p=sayProducerHarness({send:async()=>reply('legacy-after-device')});p.greet('previous-device-call');p.legacy();await p.submit();await p.consume();expect(p.packets[0]?.callId).toBeUndefined()
 })
})

describe('failed incoming answer preserves the active confirmation',()=>{
 for(const options of [{answerOk:false},{answerFirstOk:false}])it(`does not reset the call when answer fails ${JSON.stringify(options)}`,async()=>{
  const p=sayProducerHarness({...options,send:async()=>reply('active')});p.greet('active');await p.submit();await p.consume();await p.answer('failed-incoming');expect(p.context('yes')).toMatchObject({last_say_id:'active',confirmed:{ask_id:'ask-active',choice:'是'}})
 })
})

describe('normal response and acknowledgement budget boundaries',()=>{
 it('does not acknowledge an already completed ordinary response and caps its actual stream once',async()=>{
  const p=sayProducerHarness({limit:2,send:async()=>({ok:true,reply:{say_id:'fast',items:[],say:{screen:'第一句。第二句。第三句。',spoken:'第一句。第二句。第三句。'}}})});p.greet('fast');await p.submit();await p.ack();await p.consume();expect(p.spoken).toEqual(['第一句。第二句。']);expect(p.budget.spent).toBe(2)
 })
 it('keeps invalid/deleted limits compatible and refuses acknowledgements that exhaust a finite rule',async()=>{
  const {canSayPendingAck}=await import('../src/sayTurn.ts');const {SentenceBudget}=await import('../src/sentenceCap.ts');const budget=new SentenceBudget();for(const limit of [undefined,0,-1,1.5])expect(canSayPendingAck(budget,limit)).toBe(true);expect(canSayPendingAck(budget,1)).toBe(false);expect(canSayPendingAck(budget,2)).toBe(true);budget.charge('我听到了。',2);expect(canSayPendingAck(budget,2)).toBe(false)
 })
})
