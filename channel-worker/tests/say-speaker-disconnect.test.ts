import { describe, expect, it } from 'vitest'
import { createSayRosterRoom, sayProducerHarness, type Result } from './helpers/sayProducerHarness.ts'

const A = 'wb-phone-A', B = 'wb-phone-B'
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r}); return {promise,resolve} }
const flush = async () => { for(let i=0;i<15;i++) await Promise.resolve() }
const reply = (id:string):Result => ({ok:true,reply:{say_id:id,items:[],ask:{ask_id:'ask-'+id,question:'确认吗？'},say:{screen:'记下受控事项。',spoken:'记下受控事项。'}}})

describe('production ParticipantDisconnected -> relinkSpeaker -> Say lifecycle', () => {
 for (const retry of [false,true]) it(`invalidates A leaving with B still present, retry=${retry}`, async () => {
  const room=createSayRosterRoom([A,B]),late=deferred<Result>(),calls:any[]=[]
  const p=sayProducerHarness({room,send:async input=>{calls.push(input);return retry && calls.length===1?{ok:false,timedOut:true}:late.promise}})
  p.greet('call-A',A)
  const pending=p.submit('受控A输入'),consuming=p.consume();await flush()
  const interrupts=p.interrupts.length
  room.disconnect(A)
  expect(p.speaker()).toBe(B);expect(p.bindings.at(-1)).toBe(B)
  late.resolve(reply('late-A'));await pending;await consuming
  expect(p.context('yes')).toEqual({in_call:true});expect(p.spoken).toEqual([]);expect(p.packets).toEqual([])
  expect(p.interrupts.length).toBe(interrupts+1)
  expect(calls).toHaveLength(retry?2:1)
  if(retry)expect(calls[1]).toEqual(calls[0])
 })
 it('clears an already accepted A confirmation immediately when A leaves but B stays',async()=>{
  const room=createSayRosterRoom([A,B]),p=sayProducerHarness({room,send:async()=>reply('accepted-A')})
  p.greet('call-A',A);await p.submit();await p.consume()
  expect(p.context('yes')).toMatchObject({last_say_id:'accepted-A'})
  room.disconnect(A)
  expect(p.context('yes')).toEqual({in_call:true});expect(p.speaker()).toBe(B)
  expect(p.packets).toHaveLength(1);expect(p.packets[0]?.callId).toBe('call-A')
 })
 it('preserves current A when non-bound B disconnects and candidate refreshes run',async()=>{
  const room=createSayRosterRoom([A,B]),late=deferred<Result>()
  const p=sayProducerHarness({room,send:()=>late.promise});p.greet('call-A',A)
  const pending=p.submit(),consuming=p.consume(),interrupts=p.interrupts.length
  room.disconnect(B);room.refresh();room.connect(B)
  expect(p.speaker()).toBe(A);expect(p.interrupts.length).toBe(interrupts)
  late.resolve(reply('current-A'));await pending;await consuming
  expect(p.context('yes')).toMatchObject({last_say_id:'current-A',confirmed:{ask_id:'ask-current-A',choice:'是'}})
  expect(p.spoken).toEqual(['记下受控事项。']);expect(p.packets.map(x=>x.callId)).toEqual(['call-A'])
  room.disconnect(B);room.refresh()
  expect(p.context('yes')).toMatchObject({last_say_id:'current-A'});expect(p.interrupts.length).toBe(interrupts)
 })
 it('keeps the existing no-replacement disconnect invalidation and call end',async()=>{
  const room=createSayRosterRoom([A]),late=deferred<Result>()
  const p=sayProducerHarness({room,send:()=>late.promise});p.greet('call-A',A)
  const pending=p.submit(),consuming=p.consume();room.disconnect(A);late.resolve(reply('late-A'));await pending;await consuming
  expect(p.speaker()).toBeUndefined();expect(p.bindings.at(-1)).toBeNull();expect(p.callState.current()).toBeUndefined()
  expect(p.context('yes')).toEqual({in_call:true});expect(p.spoken).toEqual([]);expect(p.packets).toEqual([])
 })
 it('lets B explicitly connect and send a new final after A leaves, without inheriting its confirmation',async()=>{
  const room=createSayRosterRoom([A,B]),late=deferred<Result>(),calls:any[]=[]
  const p=sayProducerHarness({room,send:async input=>{calls.push(input);return calls.length===1?late.promise:reply('new-B')}})
  p.greet('call-A',A);const old=p.submit(),consumeOld=p.consume();room.disconnect(A)
  p.greet('call-B',B);late.resolve(reply('late-A'));await old;await consumeOld
  await p.submit('B的新输入');await p.consume()
  expect(calls[1].ctx).toEqual({in_call:true});expect(p.speaker()).toBe(B)
  expect(p.context('no')).toMatchObject({last_say_id:'new-B',confirmed:{ask_id:'ask-new-B',choice:'否'}})
  expect(p.spoken).toEqual(['记下受控事项。']);expect(p.packets.map(x=>x.callId)).toEqual(['call-B'])
 })
})
