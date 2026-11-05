import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { EventEmitter } from 'node:events'
import { RoomEvent } from '@livekit/rtc-node'
import { participantKindOf, pickSpeaker, WORKER_IDENTITY } from '../../src/rpc.ts'
import { SayConversation, canSayPendingAck, guardSayStream, SAY_RESULT_BUDGET_MS, SAY_RETRY_UNKNOWN_LINE, sayPendingAckDue, SAY_UNAVAILABLE_LINE, SAY_OUTCOME_UNKNOWN_LINE } from '../../src/sayTurn.ts'
import { SentenceBudget, withSentenceCap } from '../../src/sentenceCap.ts'
import { createCallState } from '../../src/callOut.ts'
import { createSayDecisionPublisher } from '../../src/roomDecisionReplay.ts'
import { saidStream } from '../../src/understand.ts'

export interface SayRosterRoom {
  remoteParticipants: ReadonlyMap<string, { attributes?: Record<string, string> }>
  on(event: string, listener: (...args: any[]) => void): unknown
}
export function createSayRosterRoom(identities = ['wb-phone-qa']) {
  const room = Object.assign(new EventEmitter(), { remoteParticipants: new Map(identities.map(identity => [identity, { attributes: { wb_kind: 'phone' } }])) })
  return Object.assign(room, {
    connect(identity: string) { room.remoteParticipants.set(identity, { attributes: { wb_kind: 'phone' } }); room.emit(RoomEvent.ParticipantConnected) },
    disconnect(identity: string) { room.remoteParticipants.delete(identity); room.emit(RoomEvent.ParticipantDisconnected) },
    refresh() { room.emit(RoomEvent.ParticipantConnected) },
  })
}

export interface Result { ok: boolean, reply?: unknown, timedOut?: boolean, outcomeUncertain?: boolean, why?: string }
/** Execute the actual producer blocks, isolating only audio/framework startup. No copy of its decisions. */
export function sayProducerHarness(options: { room?: SayRosterRoom, limit?: number, answerOk?: boolean, answerFirstOk?: boolean, send: (input: any, transport?: { timeoutMs?: number, signal?: AbortSignal }) => Promise<Result>, publish?: (packet: string) => Promise<void> }) {
  const source = readFileSync(new URL('../../src/agent.ts', import.meta.url), 'utf8')
  const between = (a: string, b: string) => { const start = source.indexOf(a), end = source.indexOf(b, start); if (start < 0 || end < start) throw Error('producer boundary drift: '+a); return source.slice(start, end) }
  const submit = between('        const seq = started.seq\n        const generation = sayGeneration', '\n        // Ordinary phone turns have no local understanding fallback.')
  const finalPrelude = between('    function hearFinalText(transcript: string, options: { typed?: boolean } = {}): void {', `      timing?.mark('stt_final')`).split('\n').slice(1).join('\n')
  const pendingBlock = submit
  const consume = between('        if (turnSay?.seq === routing.seq && turnSay.taken === true)', '\n      if (onboardingOn || ring?.answered() !== undefined)')
  const consumeBody = consume.slice(0, consume.lastIndexOf('\n      }'))
  const greet = between('      async greet(by, callId) {', '        if (onboardingOn)').split('\n').slice(1).join('\n')
  const hangup = between('      async hangup(by) {', '        // 挂断 =').split('\n').slice(1).join('\n')
  const answer = between('      async answer(callId, by) {', '\n      async later(callId)').split('\n').slice(1).join('\n').replace(/      },\s*$/, '')
  const ack = between('      const external = turnSay?.seq === seq ? turnSay : undefined', '      /*\n       * ★ **走固定流程')
  const declarations = between('    const sayConversation = new SayConversation()', '    /**\n     * 刚派出去')
  const broadcast = between('  function broadcastSayDecisions(reply: SayReply, callId?: string): void {', '  /**\n   * ——— 房间代理')
  const relink = between('    let boundSpeaker: string | undefined', '    /**\n     * ——— 收音闸')
  const rosterEvents = between('    room.on(RoomEvent.ParticipantConnected, relinkSpeaker)', '    // 工人刚进房:不在通话里')
  const publisher = createSayDecisionPublisher({ qa: false, publish: options.publish ?? (async () => {}) })
  const factory = new Function('deps', 'canSayPendingAck', 'guardSayStream', 'SAY_RESULT_BUDGET_MS', 'SAY_RETRY_UNKNOWN_LINE', 'SayConversation', 'sayPendingAckDue', 'SAY_UNAVAILABLE_LINE', 'SAY_OUTCOME_UNKNOWN_LINE', 'SentenceBudget', 'withSentenceCap', 'saidStream', 'createCallState', 'publisher', 'limit', 'RoomEvent', 'pickSpeaker', 'participantKindOf', 'WORKER_IDENTITY', ts.transpile(`
    let turnSay, invalidateSay = () => {}; ${declarations}
    const routing={seq:0,noteHandled(){}}, persona={max_sentences:limit}, turnBudget=new SentenceBudget(), logs=[], spoken=[], packets=[];
    const bindings=[],interrupts=[];const log=(line)=>logs.push(line), session={_roomIO:{setParticipant(id){bindings.push(id)}},say(text){spoken.push(text);return{waitForPlayout:async()=>{}}}, interrupt(){interrupts.push(true)}};
    const callState=createCallState({send:()=>{}});let textTurnCallOn=false,turnClaimGuard=false,pendingConfirm,ackedWith,ackedSeq,plannedAck;
    const textTurnCollector=undefined;const ticket={room:'qa'}, room=deps.room, deviceIdOfParticipant=()=>undefined, answerFirst=async()=>({ok:deps.answerFirstOk!==false});
    const farewell=undefined, ring={answer:()=>({ok:deps.answerOk!==false}),hangup(){}}, listenAgain=()=>{}, syncListen=()=>{};let callerOf;const callRecord={finish(){}},announceHoldStop=()=>{},restoreAfterRing=undefined,stopOnboarding=()=>{};
    ${relink}
    ${rosterEvents}
    const randomUUID=(()=>{let n=0;return()=>String(++n)})(), approvalOf=text=>text==='是'?'yes':text==='否'?'no':undefined;
    const decisionPublisher={send(reply,callId){packets.push({reply,callId});return publisher.send(reply,callId)}};${broadcast}
    const openerSpeech=(_cache,text)=>({text,cached:true}),greetings={},SAY_PENDING_ACK_LINE='我听到了。';
    const speakAck=speech=>spoken.push(speech.text);
    return {
      submit(text='受控输入'){${finalPrelude};routing.seq+=1;turnBudget.reset();const transcript=text,started={seq:routing.seq};${pendingBlock};return turnSay.pending},
      async consume(){const stream=await(async()=>{${consumeBody}})();if(stream)for await(const text of withSentenceCap(stream,turnBudget,limit))spoken.push(text)},
      async ack(){const seq=routing.seq;${ack}},
      greet(callId,identity='wb-phone-qa'){const by={identity,kind:'phone'};${greet}},
      legacy(){const by=undefined,callId=undefined;${greet}},
      hangup(){const by='phone';${hangup}},
      async answer(callId,legacy=false){const by=legacy?undefined:{identity:'wb-phone-qa',kind:'phone'};${answer}},
      virtual(){textTurnCallOn=true}, context:choice=>sayConversation.contextFor(choice), spoken,packets,logs,budget:turnBudget, callState, bindings,interrupts, speaker:()=>boundSpeaker
    }
  `, { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.None }))
  return factory({ room: options.room ?? createSayRosterRoom(), workbench: { sayTurn: options.send }, answerOk: options.answerOk, answerFirstOk: options.answerFirstOk }, canSayPendingAck, guardSayStream, SAY_RESULT_BUDGET_MS, SAY_RETRY_UNKNOWN_LINE, SayConversation, sayPendingAckDue, SAY_UNAVAILABLE_LINE, SAY_OUTCOME_UNKNOWN_LINE, SentenceBudget, withSentenceCap, saidStream, createCallState, publisher, options.limit, RoomEvent, pickSpeaker, participantKindOf, WORKER_IDENTITY) as {
    submit(text?: string): Promise<unknown>, consume(): Promise<void>, ack(): Promise<void>, greet(id?: string,identity?:string): void, legacy(): void, hangup(): void, virtual(): void, answer(id:string,legacy?:boolean):Promise<unknown>,
    speaker():string|undefined, bindings:(string|null)[], interrupts:boolean[],context(choice?: 'yes'|'no'): unknown, spoken: string[],packets: {reply:any,callId?:string}[],logs:string[],budget:SentenceBudget,callState:ReturnType<typeof createCallState>
  }
}
