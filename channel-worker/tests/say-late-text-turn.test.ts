import { describe, expect, it } from 'vitest'
import { sayProducerHarness, type Result } from './helpers/sayProducerHarness.ts'
import { SAY_OUTCOME_UNKNOWN_LINE } from '../src/sayTurn.ts'
function deferred() { let resolve!: (v:Result)=>void; const promise=new Promise<Result>(r=>{resolve=r});return{promise,resolve} }
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
const success:Result={ok:true,reply:{say_id:'late',items:[],say:{screen:'记下了三件。',spoken:'记下了三件。'}}}
describe('late say result in the live virtual phone call',()=>{
 it('reads the same-key retry through the actual shared budget without a room device',async()=>{let n=0;const p=sayProducerHarness({limit:1,send:async()=>++n===1?{ok:false,timedOut:true}:success});p.virtual();await p.submit();await p.consume();expect(p.spoken).toEqual(['记下了三件。'])})
 it('does not accept, publish or speak after the virtual call has hung up',async()=>{const d=deferred();let n=0;const p=sayProducerHarness({limit:2,send:()=>++n===1?Promise.resolve({ok:false,timedOut:true}):d.promise});p.virtual();const pending=p.submit(),consuming=p.consume();await flush();p.hangup();d.resolve(success);await pending;await consuming;expect(p.spoken).toEqual([]);expect(p.packets).toEqual([]);expect(p.context()).toEqual({in_call:true})})
 it('ignores an older utterance retry after a newer final succeeds',async()=>{const d=deferred();let n=0;const p=sayProducerHarness({limit:2,send:()=>++n===1?Promise.resolve({ok:false,timedOut:true}):n===2?d.promise:Promise.resolve({...success,reply:{...(success.reply as object),say_id:'new'}})});p.virtual();const old=p.submit();await flush();await p.submit('新的');await p.consume();d.resolve(success);await old;expect(p.context()).toEqual({in_call:true,last_say_id:'new'});expect(p.spoken).toEqual(['记下了三件。'])})
 it('announces still_running within a real one-sentence budget',async()=>{let n=0;const p=sayProducerHarness({limit:1,send:async()=>++n===1?{ok:false,timedOut:true}:{ok:false,outcomeUncertain:true}});p.virtual();await p.submit();await p.consume();expect(p.spoken).toEqual([SAY_OUTCOME_UNKNOWN_LINE])})
})
