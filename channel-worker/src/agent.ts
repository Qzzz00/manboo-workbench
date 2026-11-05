/**
 * 接线:进房 → VAD → 流式 ASR → deepseek-v4-flash → 火山 TTS → 回房,外加双向文件。
 *
 * 这个文件是唯一同时碰 LiveKit 与我们自己那几块的地方;别的模块都只认纯数据,单测里不用起房间。
 *
 * 打断:**判法在 bargeIn.ts,闸在这一层**(2026-10-03,决策记录 ④甲)。框架自带那道词数闸
 * 对中文没用(数的是按空白切的词),所以把它关上、按**字数**自己判,
 * 「嗯 / 对 / 好」不停她、真打断我们自己调 `session.interrupt()`。人设里那句「他一开口你就停下来听」
 * 是给模型的**语气**约束,不是打断机制本身。
 * 判成应声的那一段**也不进交给模型的文本**(2026-10-03 维护者拍板「抹掉」):框架把它攒在
 * `audioTranscript` 里,我们在 `onUserTurnCompleted` 那一处照 `stripLeadingAcks` 剥掉开头。
 *
 * 人设:**8791 下发的那一份按意图裁**(2026-10-03,卡 ②;personaTrim.ts)。
 * 段与「哪些意图用得上」的标记由工作台下发(`GET /channel/persona` 的 `persona_sections`),
 * 这一层只在 `llmNode` 那份上下文**副本**上把用不上的段摘掉;下发的人设形状不认得就带整份。
 *
 * 文件两个方向:
 *   收 `registerByteStreamHandler(FILE_TOPIC)` → 落到收件目录 → 在房间里说一句「收到了」;
 *   发 扫发件目录 → `sendFile` → 挪进 `已发送/`。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import type { ByteStreamHandler } from '@livekit/rtc-node'
import { AudioFrame, Room, RoomEvent, TrackKind } from '@livekit/rtc-node'
import { Agent, AgentSession, AgentSessionEventTypes, llm as llmNs, type ToolContext, type VAD, tts as ttsNs } from '@livekit/agents'
import { applyFamilyPool } from './agentName.ts'
import { withoutStutter } from './stutter.ts'
import { withDsmlToolCalls } from './dsmlToolCalls.ts'
import { NICKNAME_ASR_CONTEXT, awaitingNickname, nicknameDoubt, withNicknameDoubt } from './nickname.ts'
import { LLM as OpenAILLM } from '@livekit/agents-plugin-openai'
import { createAsr } from './asr/index.ts'
import type { ChannelWorkerConfig } from './config.ts'
import type { FillerSignal } from './filler.ts'
import { FillerSignaller, VoiceWatcher, applyAgentState, encodeFillerSignal, encodeFillerVoiceSignal, fillerGateVerdict } from './filler.ts'
import type { TurnLatency } from './latency.ts'
import { TurnTimeline, applyAgentStateToTimeline, formatTurnLatency } from './latency.ts'
import { createCallRecorder, heardLogLine, watchUnsavedCards, workerReportsRecord } from './callRecord.ts'
import { noteFields } from './remember.ts'
import type { SelfFacts, SelfModelRoute } from './selfBrief.ts'
import { THINKING_DISABLED, createNoThinkingClient } from './llmThinking.ts'
import { applyCallModelRefresh, channelModelRefreshOf, type ChannelModelNow } from './modelChoice.ts'
import { describeSelf, thinkingOf } from './selfBrief.ts'
import type { RingCall } from './callOut.ts'
import type { CallStateBroadcaster, RingMachine } from './callOut.ts'
import { RING_OPENER_REPEAT_MS, createCallState, createRingMachine, inCallAnnounceText, ringInstructions, ringOpener } from './callOut.ts'
import { ackOf, answerFirst, claimRoomTick } from './twoRooms.ts'
import { MAX_TRANSFER_BYTES, inboxNotice, saveInboxFile } from './files/inbox.ts'
import { ensureOutboxDirs, markSent, scanOutboxTargets } from './files/outbox.ts'
import type { DeviceInfo } from './files/devices.ts'
import { createDeviceDirectory, deviceOfParticipant, reportedDevices, startDevicesHeartbeat } from './files/devices.ts'
import type { DevRequest, DevResponse } from './files/deviceRpc.ts'
import { DEV_TOPIC, encodeDevResponse, handleDevRequest, parseDevRequest, parseDevResponse } from './files/deviceRpc.ts'
import type { DeviceSearchSlice } from './files/deviceTools.ts'
import { SEARCH_MAX_DEPTH, searchFiles, transferBlockReason } from './files/search.ts'
import { createTransferLog } from './files/transfers.ts'
import type { TransferRecord } from './files/transfers.ts'
import type { DeviceFilesPort } from './tools.ts'
import { ButlerTts, TTS_SAMPLE_RATE } from './tts/butlerTts.ts'
import type { Tone } from './tts/tone.ts'
import { FILLER_LINES, WorkerFiller, dropEmptyText, pickFillerClip, withFillerFrames, withFillerKick } from './workerFiller.ts'
import { Backchannel, ackWordsWith, encodeBackchannelSignal, makeIsBackchannelOnly, type BackchannelSignal } from './backchannel.ts'
import { BargeIn, stripLeadingAcks, WORD_GATE_SHUT } from './bargeIn.ts'
import {
  personaForTurn,
  withTrimmedPersona,
  type PersonaChatContext,
  type PersonaChatItem,
  type PersonaTurn,
} from './personaTrim.ts'
import { GreetingCache, OPENER_SAY_OPTIONS, OpeningDelay, createGreetingSynthesizer, greetingFrames, offhookGreeting, openerSpeech, warmWhenReady, withGreetedNote } from './tts/greeting.ts'
import { audioPublicationOf, createOpenerGate } from './tts/openerGate.ts'
import { createOpenerCutIn, createOpenerRepeat, type OpenerRepeatRun } from './tts/openerRepeat.ts'
import type { PlayingGate } from './tts/playingGate.ts'
import { createPlayingGate } from './tts/playingGate.ts'
import { openerLeadFor } from './tts/greeting.ts'
import { ChineseSentenceTokenizer } from './tts/sentences.ts'
import { SentenceBudget, withSentenceCap } from './sentenceCap.ts'
import { hubContextNote } from './hubTools.ts'
import { canSayPendingAck, guardSayStream, SAY_RESULT_BUDGET_MS, SAY_RETRY_UNKNOWN_LINE, SAY_PENDING_ACK_LINE, sayPendingAckDue, SAY_OUTCOME_UNKNOWN_LINE, SAY_UNAVAILABLE_LINE, SayConversation, type SayReply } from './sayTurn.ts'
import { createSayDecisionPublisher, roomReplayEnabled, type RoomDecisionReplay } from './roomDecisionReplay.ts'
import { TOOL_ANSWER_ASK, createChannelTools, createRingTools } from './tools.ts'
import { createVoiceClient } from './voice.ts'
import { createVoiceRescue } from './voiceRescue.ts'
import type { AddressState } from './address.ts'
import { addressListOf, localDay, nextAddress } from './address.ts'
import { ACK_LINES, TurnRouting, butlerLeftOpen, carryNote, createTurnRouter, describeDecision, followUpNote, withAckedTurn, withTurnNote, looksLikeAsking, turnOpening, INTRO_INTENT } from './turnRoute.ts'
// 2026-10-12,卡「通话补一句不丢事」第 3 条:一回合没有工具办成,不许说办了。
import { failedLine, guardsTurn, withHonestClaims, type ClaimKind } from './claimGuard.ts'
/** The guided onboarding flow still uses the legacy understanding contract. */
import { CONFIRM_DROPPED_SAY, UNDERSTAND_BUDGET_MS, approvalOf, bodyTextOf, describeUnderstanding, isHandled, saidStream, sayFirstFailLine, saysFirst, type Understanding } from './understand.ts'
// 2026-10-03,卡「首声提速」:工具按意图下发(甲)+ 这一回合现生的首句(乙)。
import { intentToolNote, planTurnTools } from './intentTools.ts'
import { FIRST_VOICE_MAX_TOKENS, FirstVoice } from './firstVoice.ts'
import type { OnboardingBrief } from './onboarding.ts'
import type { TextTurnPort } from './textTurn.ts'
import { deliverTextTurn, TextTurnCollector } from './textTurn.ts'
import type { FarewellHangup } from './farewell.ts'
import { createFarewellHangup, END_CALL_ACCEPTED_TEXT, endCallVeto, farewellFixedSay, offersEndCall, TOOL_END_CALL } from './farewell.ts'
import type { AnnounceHold } from './announceHold.ts'
import { createAnnounceHold } from './announceHold.ts'
import { ONBOARDING_PREWARM_LINES, ONBOARDING_RESUME_INSTRUCTION, buildOnboardingInstructions, buildSetupInstructions, createOnboardingTools, leadsOnDesktop, parseOnboardingBrief, speakOpeningLine } from './onboarding.ts'
import { createDialogueTail } from './dialogueTail.ts'
import { ListenGate } from './listenGate.ts'
import type { RpcCallPort, RpcFilesPort, RpcOnboardingPort } from './rpc.ts'
import { ASR_TOPIC, createAsrMailbox, createAsrRelay, createAsrStreamHandler, workbenchAsrPoster } from './asrRelay.ts'
import { MEETING_TOPIC, createMeetingMailbox, createMeetingRelay, createMeetingStreamHandler, workbenchMeetingPoster } from './meetingRelay.ts'
import {
  FILE_TOPIC,
  LEGACY_FILE_TOPIC,
  RPC_TOPIC,
  WORKER_IDENTITY,
  deviceIdOfParticipant,
  encodeCaption,
  encodeRpcResponse,
  handleRpcRequest,
  notPairedResponse,
  parseRpcRequest,
  participantKindOf,
  pickSpeaker,
  PHONE_IDENTITY_PREFIX,
} from './rpc.ts'
import type { WorkbenchClient } from './workbench.ts'

export { FILE_TOPIC, LEGACY_FILE_TOPIC, RPC_TOPIC } from './rpc.ts'

/** 扫发件目录的节拍。3 秒:他把文件拖进去之后不用等太久,也不至于把磁盘转起来。 */
export const OUTBOX_TICK_MS = 3000

/** 按扩展名给字节流标一个 MIME(2026-09-25,卡 J):手机那头按它挑怎么打开。认不出就 octet-stream。 */
const FILE_MIME: Readonly<Record<string, string>> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.log': 'text/plain',
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
export function fileMimeOf(name: string): string {
  return FILE_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 这种文件在路上压缩有没有用(2026-09-25,卡 J)。图片、视频、音频、PDF、zip、Office 本来就压过了,
 * 框架缺省会**逐块试着再压一遍**(压不小才放弃)—— 40MB 的录屏白白多烧一遍 CPU,
 * 而电话就跑在同一台机器上。只让文本类去试。
 */
export function worthCompressing(name: string): boolean {
  const mime = fileMimeOf(name)
  return mime.startsWith('text/') || mime === 'application/json'
}

/** 一个文件的 sha256(流式)。手机收完拿它对一遍,对不上就丢掉并如实说(2026-09-25)。 */
async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 来 8791 领电话的节拍(2026-09-21)。2 秒。
 *
 * 为什么是领不是推:8791 与工人之间今天只有**工人主动发起**的那一条回环 HTTP
 * ——8791 够不到工人,也不该为了推一条消息去认识 LiveKit(设计 §二:通道只有一条)。
 * 2 秒是「等确认 → 立刻」那条规矩付得起的延迟:他按下一件事的完成键到座机响,
 * 最坏多等两秒,而一条长连接要多一个会断的东西。
 */
export const CALL_CLAIM_TICK_MS = 2000

/**
 * 隔多久问一次「事务官的音色换了没有」(2026-09-22)。
 *
 * 15 秒:换音色是人在 Mac 上手点的事,一分钟里最多发生一次;而这一拍的代价是一条回环 HTTP。
 * 为什么不并进上面那根 2 秒的节拍:那一根是「等确认 → 立刻响铃」付的钱,
 * 音色没有那么急 —— 他换完音色到下一通电话之间总有十几秒。
 * **房里没有手机就不问**:没人听得见这条广播,问了也只是白打一条 HTTP。
 */
export const VOICE_WATCH_TICK_MS = 15_000

export interface StartChannelAgentDeps {
  config: ChannelWorkerConfig
  workbench: WorkbenchClient
  vad: VAD
  /** 没有 key 时传 undefined:工人照常进房、照常收发文件,只是不接话(如实记一条日志)。 */
  deepseekKey?: string
  /**
   * **每通电话现读一次**接话模型配置(2026-10-23 运行时 P1):工人常驻,设置里换了
   * 模型,在通这一通照旧打完,下一通自然吃新配置(main.ts 注入:resolveChannelModel
   * + applyModelChoice)。缺席(老接线)= 只用启动那一份,行为同以前。
   */
  modelNow?: () => Promise<import('./modelChoice.ts').ChannelModelNow | undefined>
  /**
   * 这一轮的火山识别凭据(2026-09-21,由 main.ts 在进房前向 8791 现取)。
   * **只在内存里传一路**;没有就退回环境变量与 channel.json(见 asr/index.ts 的三条来源)。
   */
  volcAsrCreds?: { app_id: string, access_token: string, resource_id?: string }
  /**
   * 接话模型走的是哪条路(2026-09-23,modelChoice.ts 的 `source`,由 main.ts 现解析出来)。
   * 只进「关于我自己」那段话(selfBrief.ts),**不影响任何一次模型调用** ——
   * 地址与 key 早就在 config / deepseekKey 里了,这一格只是让她说得出「我走的是中转」。
   * 不给就是「这一项我没拿到」,不猜一条。
   */
  modelRoute?: SelfModelRoute
  outboxDir: string
  /**
   * 问别的设备一句话最多等多久(毫秒)。房里那台机器可能正忙着、也可能刚掉线 ——
   * **一定要有超时**,否则一条永远不回的搜索请求会把电话晾在那儿。
   */
  devTimeoutMs?: number
  /** 日志。测试里换成收集器。 */
  log?: (line: string) => void
  /**
   * 和房间彻底断开了(livekit-server 重启、网断了、被踢)。main.ts 据此**重新进房**:
   * 地址与凭证都要重新向 8791 要一遍(服务器可能已经换地方、凭证可能已经过期),
   * 所以重连不是「room.connect 再来一次」,是整条接线重来。
   */
  onLost?: () => void
}

export interface ChannelAgentHandle {
  room: Room
  session?: AgentSession
  /**
   * 这会儿**在不在通话里**(含引导那一通)。通话护栏(loadGuard.ts)每两秒问一次:
   * 在通话就把这台 Mac 上的构建 / 测试调到后台档,不在就还原。
   */
  inCall: () => boolean
  /** Available only in an explicitly isolated QA process; never exposed through room RPC. */
  roomDecisionReplay?: RoomDecisionReplay
  /**
   * 「文字当成他说的话」测试口的那一头(2026-09-27,卡 TT)。
   * **只有这一轮真接上了嘴**(有接话模型)才有;那个 HTTP 壳起不起由 main.ts 按环境变量定,
   * 它每次都现问一次这个口子 —— 工人掉线重进房之后拿到的自然是新的一份。
   */
  textTurn?: TextTurnPort
  close: () => Promise<void>
}

export async function startChannelAgent(deps: StartChannelAgentDeps): Promise<ChannelAgentHandle> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const [ticket, firstPersona] = await Promise.all([deps.workbench.ticket(), deps.workbench.persona()])
  /**
   * 人设**每通电话现取**(2026-09-24 晚,卡 K):工人是常驻的,以前只在进房那一刻取一次 ——
   * 他在上一通里立的规矩(规矩表 / 通话偏好)要等工人重进房才算数。现在每通开头跟「关于我自己」一起再取一次
   * (refreshSelfBrief),取不到就沿用上一份。
   */
  let persona = firstPersona
  log(`[channel-worker] 进房:${ticket.url} / ${ticket.room},身份 ${ticket.identity}`)

  const room = new Room()

  /** 给房里某一个人发一行 JSON(`wb.rpc`)。发不出去只记日志——一条回包丢了不该把工人带走。 */
  function sendTo(identity: string, line: string): void {
    void room.localParticipant?.sendText(line, { topic: RPC_TOPIC, destinationIdentities: [identity] })
      .catch((err: unknown) => log(`[channel-worker] 回 ${identity} 没送出去:${(err as Error)?.message ?? '没说原因'}`))
  }

  /**
   * ——— 通话纪要(2026-09-23,Ben 第四通真机:`call_records` 0 行) ———
   *
   * 攒的是**字幕那一条通道上的最终结果**:他说的(ASR final)与她说的(真要出声那一刻那句),
   * 按时间顺序进同一本;挂断时由工人交给 8791 落一份通话记录(2026-10-22 起不建卡)。
   * 谁报谁不报、为什么、什么时候不报,全在 callRecord.ts 的文件头。
   */
  const callRecord = createCallRecorder({
    report: async payload => await deps.workbench.recordCall(payload),
    log,
  })
  /**
   * 通话里那几件工具用的工作台(2026-10-22):建卡那一下连不上工作台,那张卡记成没建成的「要办」,
   * 跟着这一通的记录一起交(callRecord.ts 文件头 2026-10-22 那一节)。别的方法原样。
   */
  const callWorkbench = watchUnsavedCards(deps.workbench, callRecord, text => noteFields(text).title)

  const dialogueTail = createDialogueTail()

  /**
   * 字幕。**广播**给房里所有人:一个房间就是一场对话,他自己的手机和电脑上的测试页都该看见同一份。
   * ASR 的中间结果 final=false,最终结果 final=true。
   *
   * **纪要也在这儿分叉**(2026-09-23):这个函数是两边的话唯一的汇合口
   * —— 他那边(UserInputTranscribed)与她那边(ButlerTts 的 onSpeech)都从这里过,
   * 所以「按时间顺序攒起来」在这一处接就够了,不用在两条链上各记一遍。
   *
   * **发出去就不管**(2026-09-18 实测的取舍):`sendText` 的 promise 要等对面收完才落地,
   * 排成队列发会把后面几句压后好几秒 —— 字幕晚到比乱序更糟。顺序由**收的那一侧**保证:
   * 每条 `sendText` 是一条独立的文本流,同时来四条时并发地 readAll 会读出乱序
   * (本机实测:屏幕上先看到最后一句)。手机那一侧在 roomLink 里把它们排成一条队列读。
   */
  function caption(role: 'me' | 'butler', text: string, final: boolean, tone?: Tone): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    // 中间结果不进纪要:一句话能刷十几条,纪要要的是说定了的那一句。
    if (final) callRecord.add(role, trimmed)
    // 引导交答案时带给工作台的「她问了什么、他答了什么」(2026-09-23,见 dialogueTail.ts)。
    if (final) dialogueTail.add(role, trimmed)
    // 测试口盯着这一回合时,她说的每一段顺手也给它一份(2026-09-27,卡 TT)。字幕本身一个字没改。
    if (final && role === 'butler') textTurnCollector?.butler(trimmed)
    // 语气(2026-10-02):只有她那一边有、模型写了才有。**字幕文字里已经没有标签**(见 tone.ts)。
    void room.localParticipant?.sendText(encodeCaption({ type: 'caption', role, text: trimmed, final, ...(tone === undefined ? {} : { tone }) }), { topic: RPC_TOPIC })
      .catch(() => { /* 字幕丢一条不值得记一行日志,声音才是主线 */ })
  }

  /**
   * 缓冲语信号(2026-09-20 第二版)。和字幕同一条通道、同样广播、同样发出去就不管。
   *
   * **这里不说话、不合成、不排发言队列** —— 只是告诉房里的手机「她开始想了」,
   * 由它拿包里预先合成好的那几句自己垫。第一版为什么不行、这一版凭什么成,见 filler.ts 的头注释。
   */
  function sendFillerSignal(signal: FillerSignal): void {
    void room.localParticipant?.sendText(encodeFillerSignal(signal), { topic: RPC_TOPIC })
      .catch(() => { /* 和字幕同一条规矩:垫一句是好意,丢了不值得惊动谁 */ })
  }

  /**
   * **她还说着的时候那一声「嗯」**(2026-10-02,卡「声音与形象跟着话走」第 5 件)。
   * 和字幕、垫场同一条通道、同样广播、同样发出去就不管 —— 阈值在 backchannel.ts,
   * 声音是手机包里预先合成好的那几声(这里一个字都不合成)。
   */
  function sendBackchannelSignal(signal: BackchannelSignal): void {
    void room.localParticipant?.sendText(encodeBackchannelSignal(signal), { topic: RPC_TOPIC })
      .catch(() => { /* 同上:应一声是好意,丢了不值得惊动谁 */ })
  }

  const decisionPublisher = createSayDecisionPublisher({
    qa: roomReplayEnabled(process.env),
    publish: async packet => {
      if (room.localParticipant === undefined) throw new Error('工人还没进房')
      await room.localParticipant.sendText(packet, { topic: RPC_TOPIC })
    },
  })
  function broadcastSayDecisions(reply: SayReply, callId?: string): void {
    void decisionPublisher.send(reply, callId)
      .catch((err: unknown) => log(`[channel-worker] 决定卡事件没送出去:${(err as Error)?.message ?? '没说原因'}`))
  }

  /**
   * ——— 房间代理(`wb.rpc`)。注册在 connect 之前:他可能一进来就问。 ———
   *
   * 每条请求各自独立地办,回包**只发给发问的那一个**(destinationIdentities)——
   * 同一个房间里可以有好几台手机/电脑,谁问的谁收,不互相看见。
   */
  /**
   * **只有第一台电脑替手机办 `wb.rpc`**(2026-09-21,两台电脑同房那一遍跑出来的第二件事)。
   *
   * 手机把请求**广播**进房间,只认 `wb-channel-worker` 的回包(butler-app/src/channel/rpc.ts)。
   * 第二台电脑上的工人身份带后缀,它的回答手机本来就不会认 —— 但它照样答的话,
   * 房里就多了一份抢跑的噪音:真跑那一遍里,第二台那句「接不了引导」先到,把第一台的答复挤没了。
   *
   * 何况手机要办的事(看板、事项、引导)本来就只该落在**它配对的那台机器**上。
   */
  const primaryWorker = ticket.identity === WORKER_IDENTITY

  /**
   * ——— 出了局域网的「按住说话」(2026-09-25,卡 S):录音走 `wb.asr` 字节流,`wb.rpc` 上那条 `type:'asr'` 来取 ———
   * 两样在信箱里按「谁发的 + 编号」碰头,对上之后以那台手机的身份交给 8791 的 `/butler/proxy/api/asr`
   * (与局域网直连同一个后端)。为什么这么走、限额多少,见 asrRelay.ts。
   */
  const asrMailbox = createAsrMailbox()
  const asrPort = createAsrRelay({ mailbox: asrMailbox, post: workbenchAsrPoster({ workbenchUrl: deps.config.workbenchUrl }), log })
  room.registerByteStreamHandler(ASR_TOPIC, createAsrStreamHandler({
    mailbox: asrMailbox,
    primary: primaryWorker,
    deviceOf: (identity) => {
      const attributes = room.remoteParticipants.get(identity)?.attributes
      return deviceIdOfParticipant({ identity, ...(attributes === undefined ? {} : { attributes }) })
    },
    log,
  }))

  /**
   * ——— 出了局域网的会议分段(2026-10-09):录音走 `wb.meeting` 字节流,`wb.rpc` 上那条 `type:'meeting_segment'` 来取 ———
   * 同上面识别那条的接法,对上之后以那台手机的身份 POST 8791 的 `/meeting/segment`。只转不存,见 meetingRelay.ts。
   */
  const meetingMailbox = createMeetingMailbox()
  const meetingPort = createMeetingRelay({ mailbox: meetingMailbox, post: workbenchMeetingPoster({ workbenchUrl: deps.config.workbenchUrl }), log })
  room.registerByteStreamHandler(MEETING_TOPIC, createMeetingStreamHandler({
    mailbox: meetingMailbox,
    primary: primaryWorker,
    deviceOf: (identity) => {
      const attributes = room.remoteParticipants.get(identity)?.attributes
      return deviceIdOfParticipant({ identity, ...(attributes === undefined ? {} : { attributes }) })
    },
    log,
  }))

  room.registerTextStreamHandler(RPC_TOPIC, (reader, participant) => {
    void (async () => {
      if (!primaryWorker) return
      let text: string
      try { text = await reader.readAll() }
      catch { log('[channel-worker] 有一条 wb.rpc 没收完'); return }
      const parsed = parseRpcRequest(text)
      if (!parsed.ok) {
        // 连 id 都没有就回不到人身上,发出去只是噪音——记一行就算了。
        if (parsed.id === undefined) { log(`[channel-worker] 收到一条读不懂的 wb.rpc:${parsed.error}`); return }
        sendTo(participant.identity, encodeRpcResponse({ id: parsed.id, type: 'error', error: parsed.error }))
        return
      }
      /**
       * 属性要去房间里拿:数据流的回调只给一个 `{ identity }`,拿不到属性。
       * identity 与属性**都是 LiveKit 按签好的凭证强制的**,所以这一步查表不是「信任房里的自称」。
       */
      const attributes = room.remoteParticipants.get(participant.identity)?.attributes
      const deviceId = deviceIdOfParticipant({
        identity: participant.identity,
        ...(attributes === undefined ? {} : { attributes }),
      })
      if (deviceId === undefined) {
        // 不是一台已配对的手机(测试页、别的什么)——**一条都不代办**。
        log(`[channel-worker] ${participant.identity} 想走房间代理,但它不是一台已配对的手机,回 403`)
        // 引导 / 通话回同类的一条 ok:false(手机当场收场,不干等 15 秒);其余照旧 http 403。见 rpc.ts notPairedResponse。
        sendTo(participant.identity, encodeRpcResponse(notPairedResponse(parsed.request)))
        return
      }
      // 「发到我手机上」认的是最近开口的那一台(见 lastTalker)。
      if (parsed.request.type === 'onboarding' || parsed.request.type === 'call') lastTalker = participant.identity
      const response = await handleRpcRequest(parsed.request, {
        deviceId,
        /**
         * **这一条是哪台设备发的**(2026-09-22,待拍板 E1)。今天只有挂断那一条用得上:
         * 听筒挂机要往房里广播一条 `hung_up`(手机才收得掉屏上那一面),手机自己挂的不广播。
         * 属性与 identity 一样是凭证里签的、房里改不动(理由见上面那一段)。
         */
        kind: participantKindOf(attributes === undefined ? {} : { attributes }),
        /**
         * **谁发的这一条**(2026-09-22 晚)。接起那一条要用它把接话对象钉到这一台上:
         * 座机形态下房里同时有手机与听筒,「谁接的」必须就是「声音跟谁走」的那一台。
         */
        identity: participant.identity,
        workbench: deps.workbench,
        files: filesPort,
        asr: asrPort,
        meeting: meetingPort,
        // 没有接话模型时压根没有引导模式、也没有嘴:handleRpcRequest 会如实回一句,不假装接上了。
        ...(onboarding === undefined ? {} : { onboarding }),
        ...(callPort === undefined ? {} : { call: callPort }),
      })
      // 识别那一条(卡 S)的明细 asrRelay.ts 已经记了一行(秒数、字节、每段耗时),这里不重复。
      if (response.type === 'http' && (parsed.request.type === 'asr' || parsed.request.type === 'meeting_segment')) { /* 见上(会议分段 meetingRelay.ts 也记了一行) */ }
      else if (response.type === 'http') log(`[channel-worker] 代办 ${participant.identity}:${parsed.request.type === 'http' ? `${parsed.request.method} ${parsed.request.path}` : 'renew'} → ${response.status}`)
      else if (response.type === 'call') {
        // 四个动作各说各的(2026-09-25:以前一律记成「普通通话招呼 … 说了」,挂断那一条也是 —— 查日志时对不上)。
        const action = parsed.request.type === 'call' ? parsed.request.action : 'start'
        const what = action === 'start'
          ? '普通通话招呼'
          : action === 'answer'
            ? '接起来电'
            : action === 'later'
              ? '稍后再打'
              // 手机说「我这边在放了」(卡 CF 第 4 条):开场白等的就是这一条。
              : action === 'playing' ? '手机说它在放了' : '手机挂断'
        log(`[channel-worker] ${what} ← ${participant.identity}:${response.ok ? (action === 'start' ? '说了' : '好了') : `没办成(${response.error ?? '没说原因'})`}`)
      }
      else if (response.type === 'file_pull') log(`[channel-worker] 取文件 ← ${participant.identity}:${response.ok ? `开始推「${response.name ?? ''}」` : `没推(${response.error ?? '没说原因'})`}`)
      else if (response.type === 'onboarding') log(`[channel-worker] 引导(${parsed.request.type === 'onboarding' ? parsed.request.action : '?'})← ${participant.identity}:${response.ok ? `好了${response.stage === undefined ? '' : `(${response.stage})`}` : `没接上(${response.error ?? '没说原因'})`}`)
      else log(`[channel-worker] 代办 ${participant.identity}:${response.type === 'token' ? '续了一张凭证' : `没办成(${response.error})`}`)
      sendTo(participant.identity, encodeRpcResponse(response))
    })()
  })


  /**
   * ——— 设备目录与设备之间那条控制通道(2026-09-21,「设备间传文件」那张卡) ———
   *
   * 房里现在可能有好几台:这台电脑上的工人、他的手机、另一台电脑上的另一个工人。
   * 谁在线、哪台叫什么,全来自**凭证里签的 metadata**(devices.ts 的文件头写了为什么可信)。
   */
  const selfDevice: DeviceInfo = deviceOfParticipant({ identity: ticket.identity, name: deps.config.deviceName })
    ?? { identity: ticket.identity, device_id: ticket.identity, name: deps.config.deviceName, kind: 'mac' }
  const directory = createDeviceDirectory(selfDevice)
  /** 房里这一位是话筒还是手机:凭证里签的 `wb_kind`(与挑接话对象同一个来源)。报在线表时用。 */
  const handsetKindOf = (identity: string) => participantKindOf(room.remoteParticipants.get(identity) ?? {})
  const transfers = createTransferLog({ file: deps.config.transfersFile })
  const devTimeoutMs = deps.devTimeoutMs ?? 15000

  /** 一条传输记录:落本机流水 + 报给 8791(电脑端那张记录面板看的是后者)。**都不抛**。 */
  async function recordTransfer(record: Omit<TransferRecord, 'at'>): Promise<void> {
    const saved = await transfers.append(record)
    void deps.workbench.reportTransfer(saved)
  }

  /**
   * 房里的某一台 → 设备(2026-09-25,卡 J)。**不只看设备表**:卡 J 端到端撞到过 ——
   * 机器忙的时候,手机的 `wb.rpc` 比「有人进房」那个事件先到,设备表里还没有它,
   * 于是「这台手机不在房里」,而它明明正在跟我们说话。所以先看设备表,再看房间本身,
   * 都没有就等一小会儿(它既然发来了消息,就一定在房里)。
   */
  async function deviceInRoom(identity: string, waitMs = 2000): Promise<DeviceInfo | undefined> {
    const deadline = Date.now() + waitMs
    for (;;) {
      const listed = directory.list().find(device => device.identity === identity)
      if (listed !== undefined) return listed
      const participant = room.remoteParticipants.get(identity)
      if (participant !== undefined) {
        return deviceOfParticipant({
          identity,
          ...(participant.attributes === undefined ? {} : { attributes: participant.attributes }),
          ...(participant.metadata === undefined ? {} : { metadata: participant.metadata }),
          ...(participant.name === undefined ? {} : { name: participant.name }),
        })
      }
      if (Date.now() >= deadline) return undefined
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  /** 在线设备变了:报给 8791,并把「发给-XXX」那几个文件夹建出来(他拖文件进去就发那一台)。 */
  function syncDevices(): void {
    void deps.workbench.reportDevices(reportedDevices(directory.list(), handsetKindOf))
    void ensureOutboxDirs(deps.outboxDir, directory.others())
  }

  /** 还等着回话的那几条 `wb.dev`。key 是请求 id。 */
  const pendingDev = new Map<string, (response: DevResponse) => void>()

  function sendDev(identity: string, line: string): void {
    void room.localParticipant?.sendText(line, { topic: DEV_TOPIC, destinationIdentities: [identity] })
      .catch((err: unknown) => log(`[channel-worker] 往 ${identity} 发 wb.dev 没送出去:${(err as Error)?.message ?? '没说原因'}`))
  }

  /** 问房里另一台机器一句话。**一定有超时** —— 那台可能正忙着,也可能刚掉线。 */
  async function askDevice(identity: string, request: DevRequest): Promise<DevResponse | undefined> {
    return await new Promise<DevResponse | undefined>((resolve) => {
      const timer = setTimeout(() => {
        pendingDev.delete(request.id)
        resolve(undefined)
      }, devTimeoutMs)
      pendingDev.set(request.id, (response) => {
        clearTimeout(timer)
        pendingDev.delete(request.id)
        resolve(response)
      })
      sendDev(identity, JSON.stringify(request))
    })
  }

  /**
   * 在**这台机器**上找。目录由 8791 按授权给 —— 没授权就如实回一句,
   * **不变成「没找到」**(那会让他以为文件不在,而其实是没开权限)。
   */
  async function searchHere(query: string): Promise<DeviceSearchSlice> {
    let roots: Awaited<ReturnType<typeof deps.workbench.searchRoots>>
    try { roots = await deps.workbench.searchRoots(query) }
    catch { return { device: selfDevice, files: [], total: 0, truncated: false, note: '这会儿问不到工作台能找哪些目录。' } }
    /**
     * 他点了项目名(「工作台 README」)→ 8791 认出是 desktop-workbench,**只在它底下找**(2026-09-25,卡 J)。
     * 在他点名的仓库里没找到,就如实说没找到 —— 不退到全盘去找一个同名的(那会让他以为就是那一个)。
     */
    if (roots.focus !== undefined) {
      const focus = roots.focus
      if (focus.terms.length === 0) {
        return { device: selfDevice, files: [], total: 0, truncated: false, note: `「${focus.name}」是一整个仓库,问他要里面哪一个文件。` }
      }
      const outcome = await searchFiles({
        roots: [{ path: focus.path, label: focus.name, depth: SEARCH_MAX_DEPTH }],
        query,
        terms: focus.terms,
        whereLabel: focus.name,
      })
      return {
        device: selfDevice,
        files: outcome.files,
        total: outcome.total,
        truncated: outcome.truncated,
        ...(outcome.total === 0 ? { note: `在「${focus.name}」里没找到名字带「${focus.terms.join('」「')}」的文件。` } : {}),
      }
    }
    /**
     * 工作目录(收件/发件的那个文件夹)**一直在可找的范围里**:那里的东西是他自己
     * 为了传给事务官才放进去的,意图本来就明确。扫描根那一半则要 `read_scan_roots` 授权 ——
     * 没授权时**照样在工作目录里找**,但如实带上那句「只在工作目录里找了」,
     * 不让他以为文件不在(D13:没授权与没找到是两件事)。
     */
    const workDir = dirname(deps.config.inboxDir)
    /**
     * 深度按「找文件」算,不按「扫仓库」算(2026-09-25,卡 J):老的 8791 回的是扫描根那一格 depth(GitHub 底下 1 层),
     * 照用的话仓库里 docs/ 下的文件一个都找不到。「在哪」写根的名字(GitHub / desktop-workbench),不写「扫描根」。
     */
    const all = [
      ...roots.roots.map(root => ({ path: root.path, label: basename(root.path), depth: Math.max(root.depth ?? 0, SEARCH_MAX_DEPTH) })),
      { path: workDir, label: '事务官文件夹', depth: 3, labelPrefix: true },
    ]
    const outcome = await searchFiles({ roots: all, query })
    const notes: string[] = []
    if (!roots.allowed) {
      notes.push(roots.note ?? '这台电脑还没给「读扫描根」这项授权,所以只在事务官自己的工作目录里找了。')
    }
    if (outcome.errors.length > 0) {
      notes.push(`有 ${outcome.errors.length} 个目录读不到(${outcome.errors.map(e => e.root).join('、')})`)
    }
    return {
      device: selfDevice,
      files: outcome.files,
      total: outcome.total,
      truncated: outcome.truncated,
      ...(notes.length === 0 ? {} : { note: notes.join(';') }),
    }
  }

  /** 这一通电话里、这台机器真的搜出来过的路径。`wb.dev` 的 send 只认它 —— 白名单在**执行的那一头**。 */
  const foundHere = new Set<string>()

  /**
   * 把**本机**一个文件发给房里某一台。四道:路径不能是隐藏/`.git`、要能 stat、不能超上限、要真发出去。
   * 任何一道没过都**如实回一句**,并同样记一条传输记录(失败的记录也是记录)。
   */
  async function sendLocalFile(input: {
    path: string
    to: DeviceInfo
    by: 'outbox' | 'butler' | 'typed'
    name?: string
    /** 这一次推的是哪张取件单(2026-10-04):带了它,8791 才认得出这是哪一件事的回执。 */
    offer?: string
  }): Promise<{ ok: true, name: string, bytes: number } | { ok: false, error: string }> {
    const name = input.name ?? input.path.split('/').filter(Boolean).at(-1) ?? input.path
    const result = await sendLocalFileOnce({ ...input, name })
    /**
     * **没传过去要让手机知道为什么**(2026-09-25,卡 J)。以前失败只进日志和传输记录,
     * 手机上什么都不说 —— 他在外面等一个永远不来的文件。发给收件的那台(它不在房里就发不到,那也没办法)。
     */
    if (!result.ok && input.to.kind === 'phone') {
      sendTo(input.to.identity, JSON.stringify({ type: 'file_status', name, ok: false, error: result.error }))
    }
    return result
  }

  async function sendLocalFileOnce(input: {
    path: string
    to: DeviceInfo
    by: 'outbox' | 'butler' | 'typed'
    name: string
    offer?: string
  }): Promise<{ ok: true, name: string, bytes: number } | { ok: false, error: string }> {
    const name = input.name
    /** 单号(有就带上):成没成这两种流水都带,8791 两种都要(到了 / 没到都是回执)。 */
    const slip = input.offer === undefined ? {} : { offer: input.offer }
    const blocked = transferBlockReason(input.path)
    if (blocked !== undefined) {
      await recordTransfer({ direction: 'out', peer: input.to.name, name, bytes: 0, ok: false, error: blocked, by: input.by, ...slip })
      return { ok: false, error: blocked }
    }
    let bytes = 0
    try {
      const info = await stat(input.path)
      if (!info.isFile()) throw new Error('这不是一个文件')
      bytes = info.size
    }
    catch (err) {
      const error = `读不到这个文件(${(err as Error)?.message ?? '没说原因'})`
      await recordTransfer({ direction: 'out', peer: input.to.name, name, bytes: 0, ok: false, error, by: input.by, ...slip })
      return { ok: false, error }
    }
    if (bytes > MAX_TRANSFER_BYTES) {
      const error = `这个文件有 ${(bytes / 1024 / 1024).toFixed(1)}MB,超过了 ${Math.round(MAX_TRANSFER_BYTES / 1024 / 1024)}MB 的上限`
      await recordTransfer({ direction: 'out', peer: input.to.name, name, bytes, ok: false, error, by: input.by, ...slip })
      return { ok: false, error }
    }
    if (await deviceInRoom(input.to.identity) === undefined) {
      const error = `${input.to.name}这会儿不在房里(App 没开着,或者没网)`
      await recordTransfer({ direction: 'out', peer: input.to.name, name, bytes, ok: false, error, by: input.by, ...slip })
      return { ok: false, error }
    }
    // 带上大小与 sha256(2026-09-25,卡 J):手机据此算进度、收完对一遍,对不上就丢掉并如实说。
    let sha256: string | undefined
    try { sha256 = await sha256File(input.path) }
    catch { sha256 = undefined }
    try {
      await room.localParticipant?.sendFile(input.path, {
        topic: FILE_TOPIC,
        name,
        mimeType: fileMimeOf(name),
        destinationIdentities: [input.to.identity],
        attributes: { bytes: String(bytes), ...(sha256 === undefined ? {} : { sha256 }) },
        compress: worthCompressing(name),
      })
    }
    catch (err) {
      const error = (err as Error)?.message ?? '没说原因'
      await recordTransfer({ direction: 'out', peer: input.to.name, name, bytes, ok: false, error, by: input.by, ...slip })
      return { ok: false, error }
    }
    await recordTransfer({ direction: 'out', peer: input.to.name, name, bytes, ok: true, by: input.by, ...slip })
    return { ok: true, name, bytes }
  }

  /**
   * 两件设备工具的那一头(tools.ts 里是纯逻辑,这里是真去做)。
   *
   * 搜索:本机自己搜;别的机器经房间问过去,**问不到就如实写一句 note**,不当成「那台上没有」。
   * 传输:本机的直接发;别的机器上的,让那台自己发 —— 文件在谁那儿就谁发,
   * 中间不经第三台,也就没有「一份文件在路上被抄了一道」这回事。
   */
  /** 接话对象(声音跟谁走)。接话那一块接上之后换成真的(2026-09-25,卡 J)。 */
  let callerOf: () => string | undefined = () => undefined
  /**
   * **最近一次开口的是哪一台**(打电话 / 接起 / 引导 / 引导里打字,都从 `wb.rpc` 来)。
   * 他手机和平板都常驻在房里时,「发到我手机上」要发给**他正拿着说话的那一台** ——
   * 卡 J 端到端就撞到过:平板上说的,文件却进了另一台手机(那台才是接话对象)。
   */
  let lastTalker: string | undefined
  /** 树莓派话筒不算「手机」:文件发不给一只听筒。种类从凭证里签的属性读(同 rpc.ts 的 participantKindOf)。 */
  const isHandset = (identity: string): boolean => participantKindOf(room.remoteParticipants.get(identity) ?? {}) === 'handset'
  const deviceFiles: DeviceFilesPort = {
    devices: () => directory.list().filter(device => !isHandset(device.identity)),
    self: () => selfDevice,
    caller: () => {
      const talker = lastTalker !== undefined && room.remoteParticipants.has(lastTalker) ? lastTalker : undefined
      const identity = talker ?? callerOf()
      if (identity === undefined || isHandset(identity)) return undefined
      return directory.list().find(device => device.identity === identity)
    },
    async search(input) {
      const wanted = input.devices ?? directory.list()
      const slices: DeviceSearchSlice[] = []
      for (const device of wanted) {
        if (device.identity === selfDevice.identity) {
          const slice = await searchHere(input.query)
          for (const file of slice.files) foundHere.add(file.path)
          slices.push(slice)
          continue
        }
        if (device.kind === 'phone') {
          // 手机上不找:这一版手机那一侧没有文件检索(它的文件在 App 沙盒里,本来也没几个)。
          slices.push({ device, files: [], total: 0, truncated: false, note: '手机上不找文件(这一版只在电脑上找)。' })
          continue
        }
        const answer = await askDevice(device.identity, { id: randomUUID(), type: 'search', query: input.query })
        if (answer === undefined || answer.type !== 'search') {
          slices.push({ device, files: [], total: 0, truncated: false, note: '那台电脑这会儿没回话(可能正忙,或者刚掉线)。' })
          continue
        }
        slices.push({
          device,
          files: answer.files,
          total: answer.total,
          truncated: answer.truncated,
          ...(answer.note === undefined ? {} : { note: answer.note }),
        })
      }
      return slices
    },
    async send(input) {
      if (input.from.identity === selfDevice.identity) {
        const name = input.path.split('/').filter(Boolean).at(-1) ?? input.path
        /**
         * ★ **电话里要的文件也进交付回执台账**(2026-10-04,卡 `claude/three-small-1004`)。
         *
         * 登记在**真推之前**:拿一个单号,推完那条流水带着它报回 8791
         * (`TransferRecord.offer`),8791 按单号认出这是哪一件事的回执,看板上那张牌子
         * 才会从「正在传」变成「已经到你手机上了」。
         *
         * **只给手机 / 平板那一类登记**:发到另一台电脑不是「送到她手机上」那件事。
         * **登记不上(老工作台没这个口、连不上)就照旧传** —— 只是看板上少一张牌子,
         * 不能因为记不上账就不传文件。
         */
        const offer = input.to.kind === 'phone'
          ? await deps.workbench.phoneDelivery({ name, toDevice: input.to.device_id, toName: input.to.name })
          : undefined
        const sent = await sendLocalFile({ path: input.path, to: input.to, by: 'butler', ...(offer === undefined ? {} : { offer }) })
        return sent.ok ? { ok: true, name: sent.name, bytes: sent.bytes } : { ok: false, error: sent.error }
      }
      const answer = await askDevice(input.from.identity, {
        id: randomUUID(),
        type: 'send',
        path: input.path,
        to: input.to.identity,
      })
      if (answer === undefined) return { ok: false, error: `${input.from.name} 这会儿没回话` }
      if (answer.type === 'error') return { ok: false, error: answer.error }
      if (answer.type !== 'send') return { ok: false, error: `${input.from.name} 回了一条读不懂的话` }
      if (!answer.ok) return { ok: false, error: answer.error ?? '没说原因' }
      return {
        ok: true,
        name: answer.name ?? (input.path.split('/').filter(Boolean).at(-1) ?? input.path),
        ...(answer.bytes === undefined ? {} : { bytes: answer.bytes }),
      }
    },
  }

  /**
   * 手机在外面时打字要的那个文件(2026-09-25,卡 J):手机在 `wb.rpc` 上说 `file_pull`,
   * 这里去 8791 核单(单子必须是开给这台手机的),核过了就**开始推**,不等推完 ——
   * 大文件要传好一会儿,`wb.rpc` 那一条回话不该被它压着。推不过去 sendLocalFile 自己会给手机发 `file_status`。
   */
  const filesPort: RpcFilesPort = {
    async pull({ offer, deviceId, identity }) {
      const got = await deps.workbench.fileOffer(offer, deviceId)
      if (!got.ok) return { ok: false, error: got.error }
      const to = await deviceInRoom(identity)
      if (to === undefined) return { ok: false, error: '这台手机这会儿不在房里,推不过去' }
      log(`[channel-worker] ${to.name} 在外面取「${got.name}」(${got.bytes} 字节),开始推`)
      void sendLocalFile({ path: got.path, to, by: 'typed', name: got.name, offer }).then((sent) => {
        log(`[channel-worker] 推「${got.name}」给 ${to.name}:${sent.ok ? '推完了' : `没推过去(${sent.error})`}`)
      })
      return { ok: true, name: got.name, bytes: got.bytes }
    },
  }

  /**
   * ——— `wb.dev`:设备之间。注册在 connect 之前。 ———
   *
   * 同一个 topic 上跑请求与回包:id 在 `pendingDev` 里的当回包,别的当请求。
   * **只替房里的设备办事** —— 测试页那种 `wb-dev-*` 一条都不办(devices.ts 说了为什么)。
   */
  room.registerTextStreamHandler(DEV_TOPIC, (reader, participant) => {
    void (async () => {
      let text: string
      try { text = await reader.readAll() }
      catch { log('[channel-worker] 有一条 wb.dev 没收完'); return }
      const asResponse = parseDevResponse(text)
      if (asResponse !== undefined && pendingDev.has(asResponse.id)) {
        pendingDev.get(asResponse.id)?.(asResponse)
        return
      }
      const parsed = parseDevRequest(text)
      if (!parsed.ok) {
        if (parsed.id === undefined) { log(`[channel-worker] 收到一条读不懂的 wb.dev:${parsed.error}`); return }
        sendDev(participant.identity, encodeDevResponse({ id: parsed.id, type: 'error', error: parsed.error }))
        return
      }
      const attributes = room.remoteParticipants.get(participant.identity)?.attributes
      const metadata = room.remoteParticipants.get(participant.identity)?.metadata
      const asker = deviceOfParticipant({
        identity: participant.identity,
        ...(attributes === undefined ? {} : { attributes }),
        ...(metadata === undefined ? {} : { metadata }),
      })
      if (asker === undefined) {
        log(`[channel-worker] ${participant.identity} 想用 wb.dev,但它不是一台设备,回一句拒绝`)
        sendDev(participant.identity, encodeDevResponse({
          id: parsed.request.id,
          type: 'error',
          error: '这条通道只替房里的设备办事',
        }))
        return
      }
      const response = await handleDevRequest(parsed.request, {
        asker,
        self: selfDevice,
        devices: () => directory.list(),
        searchHere,
        sendLocal: async input => await sendLocalFile({ path: input.path, to: input.to, by: 'butler' }),
        recentTransfers: async () => await transfers.recent(),
        found: foundHere,
      })
      if (response.type === 'search') log(`[channel-worker] ${asker.name} 让我找「${parsed.request.type === 'search' ? parsed.request.query : ''}」:${response.note ?? `${response.total} 个`}`)
      else if (response.type === 'send') log(`[channel-worker] ${asker.name} 让我发一个文件:${response.ok ? '发了' : response.error ?? '没说原因'}`)
      sendDev(participant.identity, encodeDevResponse(response))
    })()
  })

  // ——— 收文件。注册在 connect 之前:他可能一进来就发。 ———
  const onFile: ByteStreamHandler = (reader, participant): void => {
    void (async () => {
      const chunks: Uint8Array[] = []
      try { for await (const chunk of reader) chunks.push(chunk) }
      catch { log('[channel-worker] 收文件时这条流断了,没收完'); return }
      const data = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
      const result = await saveInboxFile(
        { ...(reader.info.name === undefined ? {} : { name: reader.info.name }), data },
        { dir: deps.config.inboxDir },
      )
      /**
       * 谁发来的(2026-09-21)。房里不止一台设备了,「收到了什么」必须连着「谁发的」一起说 ——
       * 查不到就用 identity,**不编一个名字**。
       */
      const senderAttributes = room.remoteParticipants.get(participant.identity)?.attributes
      const senderMetadata = room.remoteParticipants.get(participant.identity)?.metadata
      const sender = deviceOfParticipant({
        identity: participant.identity,
        ...(senderAttributes === undefined ? {} : { attributes: senderAttributes }),
        ...(senderMetadata === undefined ? {} : { metadata: senderMetadata }),
      })
      const peer = sender?.name ?? participant.identity
      /**
       * 统一输入框的附件(2026-09-25,卡 J):手机在外面时它也走这条字节流,但它是**挂在一条事项上的**,
       * 不是「发给电脑的一个文件」—— 记成 `attachment`,电脑首页不单独提它,也不在电话里念。
       */
      const attachment = reader.info.attributes?.purpose === 'attachment'
      await recordTransfer({
        direction: 'in',
        peer,
        name: result.ok ? result.name : (reader.info.name ?? '不知名文件'),
        bytes: result.ok ? result.bytes : data.length,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.reason }),
        ...(attachment ? { by: 'attachment' as const } : {}),
      })
      const notice = inboxNotice(result, peer)
      log(`[channel-worker] ${participant.identity} 发来文件:${notice}`)
      if (attachment) return
      // 说给他听。收到文件是他**已经知道**的事,所以这一句不用经模型 —— 直接念,快且不会编。
      try { session?.say(notice) } catch { /* 还没接上话就只记日志 */ }
      // 没接话(没有 key)时字幕也要有:他在手机上看得见「收到了什么」。
      if (session === undefined) caption('butler', notice, true)
    })()
  }
  room.registerByteStreamHandler(FILE_TOPIC, onFile)
  // 原型用的是 `wb-file`。**只收不发**:测试页和 09-17 那版假手机还发着它,不该因为改了名字就收不到。
  room.registerByteStreamHandler(LEGACY_FILE_TOPIC, onFile)

  /**
   * **不自动订阅**(2026-09-25,卡 fix/evening-gaps 第 1 条:隐私 + 计费)。以前 `autoSubscribe: true`:
   * 房里谁发了音轨就订谁,手机常驻房间、挂断只静音 —— 那条轨道就一直订着、一直出帧,
   * VAD 与火山识别跟着一直跑(09-24 晚 18:53–19:19 上万行 VAD、上百次 45000081)。
   * 现在订谁由收音闸(listenGate.ts)说了算:**只在通话里、只订接话对象的麦克风**。
   */
  await room.connect(ticket.url, ticket.token, { autoSubscribe: false, dynacast: true })
  log(`[channel-worker] 进房了。房里现在有:${[...room.remoteParticipants.values()].map(p => p.identity).join('、') || '还没有别人'}`)

  /**
   * 设备表:进房那一刻按房里现有的人铺一遍,之后跟着进出改。
   * `ParticipantAttributesChanged` 也接 —— 换了张凭证进来时名字可能变了。
   */
  directory.reset([...room.remoteParticipants.values()])
  syncDevices()
  const onRoster = (): void => {
    directory.reset([...room.remoteParticipants.values()])
    log(`[channel-worker] 在线设备:${directory.list().map(device => device.name).join('、')}`)
    syncDevices()
  }
  room.on(RoomEvent.ParticipantConnected, onRoster)
  room.on(RoomEvent.ParticipantDisconnected, onRoster)
  room.on(RoomEvent.ParticipantAttributesChanged, onRoster)
  /**
   * 平时也定时再报一遍(2026-09-23 晚):只在进出时报的话,8791 过 5 分钟就把表标旧,
   * App 于是说「话筒不在线」;8791 重启后表也要等下一次进出才回来。见 `DEVICES_HEARTBEAT_MS`。
   */
  const stopDevicesHeartbeat = startDevicesHeartbeat({ report: () => deps.workbench.reportDevices(reportedDevices(directory.list(), handsetKindOf)) })

  /**
   * ——— 晚进房的那一位要补一份铃(2026-09-23 真机 10:27)———
   *
   * 那一幕:工人刚重启(8791 热更新之后拉起)就领了一通电话排上响,而 `座机响了`
   * 那一刻房里**只有座机话筒** —— 手机几秒之后才(重新)出现。`ring` 是一次性广播,
   * 发出去就没了,于是手机从头到尾一声没响,60 秒后台账上记了一条「未接」。
   * 台账说他错过了一通电话,而他的手机根本没响过 —— 这类失真是这个仓库里最要紧的那一条(D13)。
   *
   * 补法:**响铃期间有人进房(或者属性这会儿才齐)就点名补发一次**,
   * 发的是 `start()` 当时编好的那一行原文(同 `call_id`、同 `until`,见 callOut.ts 的 resendRingTo)。
   *
   * 为什么不广播:已经在响的那几台不该再收一条。手机那一侧对同一 `call_id` 的重复 `ring`
   * 是幂等的(`reduceIncoming` 在非 idle 时原样返回),但那是兜底,不是全房重播的借口。
   *
   * 三条边:
   *   · **别的工人不补** —— 它不是一台会响的设备(同 relinkSpeaker 里那条);
   *   · **同一通只补一次** —— `ParticipantAttributesChanged` 一次进房能连来好几条;
   *   · **真的走了再回来算一次新的** —— `ParticipantConnected` 先把这一位的记录抹掉,
   *     所以掉线重连的那台手机会再收到一份,而不是被上一次的记录挡住。
   *
   * (`ring` 在下面几行才填上。这几个回调只在事件来的时候跑,那已经是后来的事了。)
   */
  const ringResent = new Map<string, string>()
  const resendRingTo = (identity: string | undefined, fresh: boolean): void => {
    if (identity === undefined || identity === '') return
    // 工人不是一台会响的设备。
    if (identity.startsWith(WORKER_IDENTITY)) return
    // 真的重新进了一次房:上一次补过什么不作数。
    if (fresh) ringResent.delete(identity)
    const call = ring?.current()
    if (call === undefined) return
    if (ringResent.get(identity) === call.id) return
    if (ring?.resendRingTo(identity) !== true) return
    ringResent.set(identity, call.id)
  }
  room.on(RoomEvent.ParticipantConnected, (participant) => { resendRingTo(participant?.identity, true) })
  room.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => { resendRingTo(participant?.identity, false) })

  // ——— 接话那条链 ———
  let session: AgentSession | undefined
  /**
   * 引导模式(2026-09-18)。没有接话模型时这三样一直是空的 —— 手机发「我在做引导」会收到
   * 一句「电脑上的事务官现在接不了引导」,而不是石沉大海。
   */
  let onboarding: RpcOnboardingPort | undefined
  /**
   * 普通通话的招呼(2026-09-18)。以前是进房就 `session.say(persona.welcome)` —— 工人常驻,
   * 房里没人时那一句只是排在音频队列里,等手机进来才出声,于是 Ben 一进引导先听见「喂,我在,你说。」。
   * 现在改成**打电话的那一头点名要**:普通通话发 `{type:'call',action:'start'}`,引导发 onboarding.start。
   */
  let callPort: RpcCallPort | undefined
  /**
   * ——— 「文字当成他说的话」测试口(2026-09-27,卡 TT) ———
   *
   * 默认关着(main.ts 里按环境变量决定起不起那个壳),这里只是把口子摆出来。
   * 它送进去的**就是**下面那个 `hearFinalText` + `session.generateReply`,
   * 一行回合逻辑都没有另写;它能收到什么,全靠下面那几条**现成的**事件顺手喂给收集器。
   */
  let textTurnPort: TextTurnPort | undefined
  /** 这会儿有没有一回合正在被测试口盯着。没有就是真通话,一个字节都不多攒。 */
  let textTurnCollector: TextTurnCollector | undefined
  /** 测试口开的那通「虚拟来电」在不在(它走的是与提机 / 挂断同一条 callPort)。 */
  let textTurnCallOn = false
  let invalidateSay = (): void => {}
  /**
   * 座机主动来电的振铃状态机(2026-09-21)。没有接话模型时一直是空的 ——
   * 那时工人领了电话也没人能开口,所以下面那根领活的节拍压根不起(见 callTimer)。
   */
  let ring: RingMachine | undefined
  /**
   * **这会儿房里在不在通话中**(2026-09-23,「打进打出同一张页」)。来电那条路有 `ring`/`ring_end`,
   * 他自己提机拨出的那条一个字都没广播过 —— 手机于是不知道房里正在通话。理由全文在 callOut.ts
   * 的 {@link CallStateSignal}。和 `ring` 一样,没有接话模型时一直是空的。
   */
  let callState: CallStateBroadcaster | undefined
  /**
   * **他道别 → 她回一句 → 由她挂**(2026-09-23 晚,维护者真机 0.2.73「说了拜拜之后没有真的拜拜」)。
   * 状态机与否决规则在 farewell.ts;真挂那一下复用下面挂断那一条路。没有接话模型时一直是空的。
   */
  let farewell: FarewellHangup | undefined
  /**
   * 她道别挂了之后**收音关着**,直到下一通开始(提机 / 接起 / 放下听筒 / 引导开始 / 房里没人)。
   *
   * 为什么要关:话筒接的那一通,工人挂了而派不知道(派在通话中不认任何 `ring_end`,
   * phone_state.py 的 IN_CALL 那一支),听筒还举在他手里、麦克风还推着。不关的话他再说一句,
   * 她就又接上了 —— 那等于没挂。关了之后要再说话就得放下再拿起,和真座机一样。
   */
  let mutedAfterBye = false
  /**
   * 收音闸按此刻的状态落一次(2026-09-25,listenGate.ts)。接话那条链接好之后才换成真的;
   * 没有接话模型的那几台上它一直是空的 —— 那时压根不订任何人的声音。
   */
  let syncListen: (why: string) => void = () => {}
  const listenAgain = (why: string): void => {
    if (!mutedAfterBye) return
    mutedAfterBye = false
    // 真开不开由收音闸按「在不在通话里」定:她道别之后这一下只是把那一道解开。
    log(`[channel-worker] 道别后关着的收音解开了(${why})`)
    syncListen(why)
  }
  /**
   * 「这通来电完了,换回平时那套人设」。由下面那段接线填上(没有接话模型时一直是空的)。
   * 提到外层是因为 relinkSpeaker 也要调它 —— 手机走了和他按挂断是同一件事。
   */
  let restoreAfterRing: (() => Promise<void>) | undefined
  let onboardingBrief: OnboardingBrief | undefined
  let onboardingOn = false
  /**
   * **一个房间只有一张嘴**(2026-09-21,两台电脑同房那一遍真跑出来的事)。
   *
   * 第一次把两个工人放进同一个房间,两边都把接话链接上了。结果是:工人 A 说话的声音
   * 被工人 B 的 ASR 听见、当成「他说的话」转写出来,再喂给模型 —— 两台机器隔空对聊,
   * 字幕里全是她自己的话被标成 `[me]`。日志逐字印证了这一条。
   *
   * 所以:**只有身份不带后缀的那一台接话**(`wb-channel-worker`,也正是手机唯一认的那个身份)。
   * 别的电脑上的工人照常进房、照常收发文件、照常替她找文件 —— 只是不长嘴。
   * 他要的本来就是「一个事务官」,不是「每台电脑一个事务官」。
   *
   * 想在某台机器上强行开/关,用 `WORKBENCH_CHANNEL_VOICE=on|off`。
   */
  /**
   * 提机那一句的**预合成缓存**(2026-09-23,Ben:「最好事务官能先问一句『老板,有什么吩咐?』」)。
   *
   * 提到这一层是因为**换音色那根节拍在下面**(voiceWatcher):缓存的是声音,
   * 换了嗓子就得整张重来。没有接话模型的那几台上它一直是空的 —— 那时压根没有嘴。
   */
  let greetings: GreetingCache | undefined
  /**
   * 开场白那道「**手机说它在放了**」的闸(2026-09-28,卡 CF 第 4 条;tts/playingGate.ts)。
   * 提到这一层是因为 `callPort` 要往它上面记两件事:这一通那台手机报不报、报了没有。
   * 没有接话模型的那几台上它一直是空的(那时压根没有开场白)。
   */
  let playingGate: PlayingGate | undefined
  const voiceEnv = process.env.WORKBENCH_CHANNEL_VOICE?.trim().toLowerCase()
  const voiceHere = voiceEnv === 'on' ? true : (voiceEnv === 'off' ? false : ticket.identity === WORKER_IDENTITY)
  if (!voiceHere) {
    log(`[channel-worker] 这台(${selfDevice.name})不是接话的那一台,只管文件与找文件 —— 一个房间只有一张嘴,理由见 agent.ts。`)
  }
  else if (deps.deepseekKey === undefined) {
    log('[channel-worker] 没有接话模型的 key(DEEPSEEK_API_KEY 或 ~/.dsh/workbench/credentials.json 的 keys.deepseek),这一轮只收发文件、不接话。')
  }
  else {
    /**
     * ASR 出事要进同一条日志(2026-09-18)。以前它走的是裸 `console.warn`,
     * 混在框架 pino 的那一堆里几乎看不见 —— 而「她听不见你」最常见的原因就写在那一行里。
     */
    const asr = createAsr({
      config: deps.config,
      vad: deps.vad,
      onError: line => log(`[channel-worker] ${line}`),
      onNote: line => log(`[channel-worker] ${line}`),
      ...(deps.volcAsrCreds === undefined ? {} : { issued: deps.volcAsrCreds }),
      /**
       * **识别热词**(2026-10-02,卡「电话里像个活人」):这台机器上的家名、事务官的名字、
       * 称呼、账号名、小组件名、她最近说过的专有词,由 8791 算好下发(`channelHotwords`)。
       *
       * Air 那一通里「Codex」被听成 to death / 泄露 / Cold death,来回**五轮** ——
       * 识别那一头两条路 09-25 起就收热词,**但一直没有人往里面填东西**。
       * 这一行就是那一格。人设换了跟着换(见下面 `syncAsrHotwords`)。
       */
      ...(persona.hotwords === undefined || persona.hotwords.length === 0 ? {} : { hotwords: persona.hotwords }),
    })
    if (asr.note !== undefined) log(`[channel-worker] ${asr.note}`)
    /**
     * 热词跟着人设走(2026-10-02):每通电话现取一次人设(`refreshSelfBrief`),
     * 她最近说过的专有词、新装的那一家都在里头。换了记一行 —— 「她为什么又听错了」要查得出来。
     */
    const syncAsrHotwords = (): void => {
      const words = persona.hotwords
      if (asr.setHotwords(words === undefined || words.length === 0 ? undefined : words)) {
        log(`[channel-worker] 识别热词:${(words ?? []).length} 个(${(words ?? []).slice(0, 8).join('、')}${(words ?? []).length > 8 ? '…' : ''})`)
      }
    }
    syncAsrHotwords()
    /**
     * **问称呼那一段,把她那句问话当上下文交给火山识别**(2026-09-25,nickname.ts):
     * 火山知道上一句是「怎么称呼你」,英文名就不容易被听成「变」「编辑」。记下称呼、引导停了就撤。
     * 只有火山流式有这一格;分段兜底那一路没有,那就什么都不做。
     */
    const syncNicknameAsrContext = (): void => {
      const want = onboardingOn && awaitingNickname(onboardingBrief) ? NICKNAME_ASR_CONTEXT : undefined
      if (asr.setDialogContext?.(want) === true) {
        log(`[channel-worker] 识别上下文:${want === undefined ? '撤掉(称呼记下了或引导停了)' : '带上「怎么称呼你」那句问话(问称呼这一段)'}`)
      }
    }
    log(`[channel-worker] ASR:${asr.kind};接话模型:${deps.config.llmModel};TTS:8792 /api/tts(场景 ${deps.config.ttsScene})`)

    /**
     * 缓冲语的**信号**那一头(2026-09-20 第二版)。建在工具前面:工具开跑那一下要用它。
     * 为什么工人这边一个字都不说,见下面接 `agent_state_changed` 那一段与 filler.ts 的头注释。
     */
    const filler = new FillerSignaller({ send: sendFillerSignal, workerVoiced: deps.config.workerFiller })
    /**
     * **她说话时的那几声应声**(2026-10-02)。轮号跟垫场同一个(手机按它分批次)。
     * 为什么阈值在这边、声音在手机那边,见 backchannel.ts 的文件头。
     */
    /**
     * **「这一段整段只是一声应声吗」那把判子,整个工人只造一次**(2026-10-03,卡 ④甲)。
     * 应声那一头(别对着一声嗯再应一声)与打断这一头(一声嗯不许把她掐断)吃的是**同一把** ——
     * 词表只有 backchannel.ts 那一份,运营那层改 `WORKBENCH_CHANNEL_ACK_WORDS` 两头一起变。
     */
    const isAck = makeIsBackchannelOnly(ackWordsWith(deps.config.ackWords))
    const backchannel = new Backchannel({ send: sendBackchannelSignal, round: () => filler.round, isAck, log })
    /**
     * **打断那道闸**(2026-10-03,卡 ④甲)。判法与「为什么框架那一格要反着用」都在 bargeIn.ts。
     *
     * 这里只接两样:
     *   · `stop` → `session.interrupt()`。**不带 `force`** —— 发言照旧 `allowInterruptions:true`,
     *     所以不用它:带上会连发言队列与在跑的工具步一起取消(agent_activity.js 2020–2027);
     *   · 掐不动就**如实记一行**(会话还没起、这会儿本来就没人说话),不装作掐了。
     *
     * **开关关着就压根不造**(2026-10-03,卡 fix/voice-route-zh;审计 voice.md 附证 C):
     * `WORKBENCH_CHANNEL_BARGE_IN_ZH=off` 以前只撤掉框架那道词数闸的「关上」值,这台判子
     * 照旧在跑 —— 框架自带的自动打断与我们自己的判法同时生效,一声「嗯」照旧可能被这边丢掉。
     * 「一键回到 10-02」那句话要成立,下面喂事件那三处就得跟着一件都不做。
     */
    const bargeIn = deps.config.bargeInZh
      ? new BargeIn({
          stop: () => {
            try { session?.interrupt() }
            catch (err) { log(`[channel-worker] 想掐她没掐动:${(err as Error)?.message ?? '没说原因'}`) }
          },
          isAck,
          ...(deps.config.bargeInMinChars === undefined ? {} : { minChars: deps.config.bargeInMinChars }),
          ...(deps.config.bargeInDeadlineMs === undefined ? {} : { deadlineMs: deps.config.bargeInDeadlineMs }),
          log,
        })
      : undefined
    /**
     * **垫场由工人自己用当前音色说**(2026-09-23 晚,维护者拍板)。怎么插进回答前面、
     * 为什么不用 `session.say`,见 workerFiller.ts 头注释。句子取自开场白那张预合成缓存
     * (下面 `greetings`,换音色整张作废重合);**没命中就不垫**。
     * `WORKBENCH_CHANNEL_WORKER_FILLER=off` 时这一个都不建,逐字回到「只发信号」那一版。
     */
    const workerFiller = deps.config.workerFiller
      ? new WorkerFiller<AudioFrame>({
          clip: line => pickFillerClip(line, (text) => {
            const got = greetings?.get(text)
            return got === undefined ? undefined : greetingFrames(got)
          }),
          // 首句还在合着时多等这一小截(2026-10-03,卡「首声提速」乙;0 = 不多等)。
          firstVoiceGraceMs: deps.config.firstVoiceGraceMs,
          log,
          onPlay: (clip) => {
            timing?.note({ filler: true })
            // 垫出去的这一句(固定那几句或现生的首句)也算这一回合说的(2026-10-12,电话少说几句;sentenceCap.ts 的 `charge`)。
            if (!onboardingOn) turnBudget.charge(clip.text, persona.max_sentences)
          },
        })
      : undefined
    /** 一件工具开跑了 → 值得垫的那几件才广播一条信号,并记一行日志(量延迟要靠它)。 */
    const onToolStart = (name: string): void => {
      if (filler.toolStarted(name)) log(`[channel-worker] 缓冲语信号:tool ${name}(第 ${filler.round} 轮)`)
    }

    /**
     * ——— 回合分流:**调模型之前就决定这一句带不带工具**(2026-09-23)———
     *
     * Ben 真机 0.2.68:「现在不管说什么都要说『我想想』……我问他是谁,也要想想。」
     * 数就摆在 `GET /channel/latency` 上:带工具的回合 `llm_first_ms` 2253/3435,
     * 闲聊回合 830–1175,而缓冲语的门是 0.7 秒 —— **每一个回合都过了门**。
     *
     * 病根是分流发生得太晚:以前每一回合都把全部工具塞给模型,由它自己决定用不用。
     * 现在:识别最终文本一到手就开判(turnRoute.ts),`llmNode` 里把判定等回来,
     * **闲聊回合一件工具都不给、也不垫场**;要办事的回合一字不变。
     *
     * 判不出来、超时、出错,一律按「要办事」—— 也就是**和这一版之前完全一样的行为**。
     */
    const turnRouter = await createTurnRouter({ log })
    const routing = new TurnRouting({ router: turnRouter, log })
    log(`[channel-worker] 回合分流:${turnRouter.name}(闲聊回合不带工具、不垫场;换一件:WORKBENCH_CHANNEL_TURN_ROUTER=rules|jev)`)
    /**
     * 闲聊回合交给模型的工具集:**压根不给这一格**(`undefined`),不是给一个空的 `ToolContext`。
     *
     * 差别在请求体上,逐字查过框架的代码(`@livekit/agents/dist/inference/llm.js`):
     * `toolCtx` 给了对象就会走到 `tools = [...]`,空的 `ToolContext` 发出去的是 **`tools: []`**;
     * 给 `undefined` 才是 `tools` 整个不出现。OpenAI 兼容的那一头对空数组各家脾气不一样
     * (有的直接 400),而我们要的本来就是「这一轮没有工具这回事」。
     *
     * 类型上要一个 `ToolContext`,所以这里明着断言一次 —— 断言的理由就是上面这一段。
     */
    const NO_TOOLS = undefined as unknown as ToolContext
    /**
     * 他**这一回合**说的话(识别最终结果;一回合被切成几段就拼起来)。她一开口,下一段就算新的一回合。
     * 挂断那件工具的否决、闲聊回合递不递那一件,看的都是它(farewell.ts)——**他的原话,不是模型的复述**。
     */
    let turnHeard = ''
    /** 这一回合她已经说了几句(卡 K:他的规矩「电话每轮不超过两句」在流上掐,sentenceCap.ts)。 */
    const turnBudget = new SentenceBudget()
    let heardFresh = true
    /**
     * 这一回合他是**打字**说的(引导的打字备胎,2026-09-25)。打出来的字是准的 ——
     * 问称呼那一轮「没听准就请他打字」的提示对它不加(否则他打完字她又请他打一遍)。
     */
    let turnTyped = false
    /**
     * 事务官**上一句说的话**(2026-10-02,卡「电话里像个活人」)。分流拿它判
     * 「她这句『可以』是批准还是应答」—— 判据在 turnRoute.ts 的 `looksLikeAsking`。
     * 空的 = 这一通还没开过口(第一句),按「没挂问」处理。
     */
    let lastButlerLine = ''

    /**
     * ——— 「关于我自己」那段话的那几格(2026-09-23)———
     *
     * `selfBlock` 是拼好的那一段(每通电话开始时现拼,见下面的 refreshSelfBrief);
     * `lastTurn` 是上一回合的成绩单 —— 他在电话里问「刚才慢在哪」时,答案就是它;
     * `workbenchVersion` 问到过一次就记住(它要等一次 HTTP,而同一个工人进程里它不会变
     * —— 热更新会把工人重启)。
     * 三个都可能一直是 undefined(计时关着、这一轮还没说过话、8791 没答应),
     * 那时那一行如实写「这一项我没拿到」。
     */
    let selfBlock: string | undefined
    let lastTurn: TurnLatency | undefined
    let workbenchVersion: string | undefined
    /**
     * 这一通的开场白**说的是哪一句**(2026-09-23,提机先问)。有值 = 系统已经替她开过口,
     * 提示词里要写明「别重复」(见 {@link baseInstructions});挂断清空。
     */
    let openedWith: string | undefined
    /**
     * 这一回合**已经先应过**的那一句(2026-09-23 下午,按意图先应)。
     * 调模型时带一行「你已经应过了,别重复」进 chatCtx(见 `llmNode`);下一回合开判时清掉。
     */
    let ackedWith: string | undefined
    /**
     * 「下一段推进切分器的字是谁的」(2026-09-27)。
     *
     * 09-27 那份诊断包里最贵的一行是 `模型首段 85 字(一个字 = 真流式;一整句 = 路上有人攒 buffer)`
     * —— 它把我们直接送去查中转与反代的流式,查了半天才发现那 85 个字**根本不是模型吐的**:
     * 是 `session.say()` 把固定开场白整句推进了同一个句子切分器(TTS 只有这一条路),
     * 于是「首段」当然是一整句。同一份日志里模型那一轮的首段是 **2 字**,中转的流式一直是好的。
     *
     * 所以这一格只做一件事:让那一行说清这一段字是谁推的。`say()` 之前置上,日志出过就清掉;
     * 置晚了、清早了最多是标错一行(尽力而为),不影响出声。
     */
    let firstTextSource: string | undefined
    /** 先应的是**哪一回合**(`routing.seq`)。垫场那道闸拿它认「这一回合已经应过了,别再垫」。 */
    let ackedSeq: number | undefined
    /**
     * ——— **先应那一句挪到回合提交那一刻出口**(2026-10-12,卡「通话补一句不丢事」)———
     *
     * 09-23 起它在识别最终文本那一刻就 `say()` 了(排在回答前面)。10-03 打断判法把框架那道词数闸
     * 关死之后(bargeIn.ts:`minWords = WORD_GATE_SHUT`),这一句一开口就成了框架眼里
     * 「她手上正在说的话」—— 几十毫秒后回合提交走到 `onEndOfTurn`(`agent_activity.js` 第 1698–1711 行):
     * 她手上有话、他词数不够 → **这一回合整个不要,连带把抢跑的那次带工具生成取消**。
     * 10-12 真机四次先应四次都是这样:带工具那一格 `llm_first` 是空的,先应念完、回到听,
     * 框架才把这一句补交上来,而那时判定已经被 `routing.end()` 清了,只能走 none。
     *
     * 现在:判出来的那一刻只**定下**说哪一句(`plannedAck`),真正 `say()` 放在 `onUserTurnCompleted` ——
     * 那时词数闸已经过了(`userTurnCompleted` 在调我们之前就把排着的话掐干净了),
     * 先应排在回答前面照旧成立(回答在我们返回之后才排进队),抢跑生成也不会作废
     * (先应的那一句播完才进上下文,比对的是之前那一份)。代价是晚了「识别最终文本 → 回合提交」那 5~40ms。
     * 打字送进来的那一回合不经回合提交(`generateReply({ userInput })`),仍在判出来那一刻就说。
     */
    let plannedAck: { seq: number, speech: ReturnType<typeof openerSpeech> } | undefined
    /** 这一回合**有没有一件工具办成了**(claimGuard.ts 拿它判「她说办了」是不是真的)。他说新的一句就清。 */
    let turnToolOk = false
    /** 这一回合拦不拦「说办了」(llmNode 按判定定,kickLlm 照它包流)。 */
    let turnClaimGuard = false
    /** 这一回合哪几件工具自己报过成没成(`onUsed`)。没报过的那几件(挂断之类)跑完就算成。 */
    const turnToolReports = new Set<string>()
    /** 这一回合有工具**自己报了没成**的那句原因(兜底句按真实状态说,2026-10-13)。 */
    let turnToolFailed: string | undefined
    /** 这一通里兜底句已经换过哪几类(一通不重复,2026-10-13)。挂断清掉。 */
    const rewroteKinds = new Set<ClaimKind>()
    /** 工具自己报的成没成(两套工具的 `onUsed` 都接这里)。 */
    function noteToolUsed(name: string, ok: boolean, text: string): void {
      log(`[channel-worker] 工具 ${name} → ${ok ? '成了' : '没成'}:${text}`)
      turnToolReports.add(name)
      if (ok) turnToolOk = true
      else if (turnToolFailed === undefined) turnToolFailed = text
    }

    /** Guided onboarding still uses the legacy understanding flow; ordinary phone turns use turnSay only. */
    let turnUnderstanding: { seq: number, pending: Promise<Understanding | undefined>, taken?: boolean, text: string } | undefined
    let turnSay: { seq: number, generation: number, callId?: string, pending: Promise<SayReply | undefined>, taken?: boolean } | undefined
    const sayConversation = new SayConversation()
    let sayGeneration = 0
    let sayRequestController: AbortController | undefined
    const cancelSayRequest = (): void => {
      sayRequestController?.abort()
      sayRequestController = undefined
    }
    // Bound at the lifecycle source, including legacy calls with no room identity.
    let sayCallId: string | undefined
    invalidateSay = () => {
      sayGeneration += 1
      cancelSayRequest()
      sayConversation.reset()
      sayCallId = undefined
      turnSay = undefined
      plannedAck = undefined
      textTurnCallOn = false
      // Stop speech already queued by the call that just ended; server work is not cancelled.
      try { session?.interrupt() } catch { /* The session may already be closing. */ }
    }
    /**
     * 刚派出去 / 刚开始的那件事(8791 据此认「补细节」:她紧接着那句短话并进这一件)。
     * 只记最近一件;挂断清掉。
     */
    let openThing: { itemId: string, said: string, atMs: number } | undefined
    /** 念过一句确认、正等她点头的那一件(`confirm.needed` 那一档)。 */
    let pendingConfirm: { understanding: Understanding, text: string } | undefined
    /**
     * ★ **介绍模式**(2026-10-13 夜,卡 V;维护者经工作台捎话:「识别到对方问『能够介绍一下自己吗』就触发这个模式」)。
     * 这一通里她问过「你是谁 / 介绍一下自己」之后,接下来的闲聊回合也带上人设里【介绍自己】那一段
     * (对方多半接着问「那你还能做什么」);要办事的回合、挂断就退出。只在通话里有这一格。
     */
    let introMode = false
    /**
     * ★ **这一通里道别过了吗**(2026-10-13 下午,卡 A 第 2 条)。
     * 一通只道别一次:那一句固定的「好,拜拜。」说过之后,他再说一遍「拜拜」就只挂,不再说。
     */
    let farewellSaid = false
    /**
     * ★ **这一回合是一句干净的道别**(2026-10-13 晚,卡 K)。
     *
     * 0.4.121 真机 16:33 那一通道别**认出来了**,可那一回合照旧问了 8791、照旧起了垫场计时器:
     *
     * ```
     * 他道别了(「不用看了,拜拜。」):固定一句就收
     * 8791 听懂了:none/normal → 交给模型(认不出是哪一类,交给模型)
     * 到点还没出声,垫了一句「嗯,我想一下。」(当前音色,走同一条音轨)
     * 她说:好,拜拜。
     * ```
     *
     * 维护者:「他垫了一句说我想想,然后才说的拜拜」。固定那一句 **0 毫秒就有**,
     * 先应 / 垫场那两样都是为「要等模型」造的 —— 所以认出道别的那一刻就把这一格置上:
     * 8791 那一问**整个不问**,`thisTurnIsHandled()` 当场回 true(先应 / 垫场同一道闸)。
     *
     * 按回合号(`routing.seq`)记,所以他说下一句就自动过期。
     */
    let turnFarewell: { seq: number, say: string } | undefined
    /**
     * ★ **他拨出去的那一通:挂着的问攒在这里**(2026-10-13 下午,卡 A 第 4 条;announceHold.ts)。
     * 只有**他拨出去**的那一通有(来电那一通一开口就说事,照旧);挂断清掉。
     */
    let announceHold: AnnounceHold | undefined
    /**
     * **开场那几句「出声之后翻成可打断」那一处**(2026-10-13 下午,卡「来电开场」②③;
     * 整段理由在 tts/openerRepeat.ts 的文件头)。
     *
     * 四条路同一个毛病,所以**提机招呼、固定开场白、来电开场、再说那一遍都托给它**:
     * `say` 那一下照旧 `allowInterruptions:false`(09-27 卡 CL 那一脚不能再踩),
     * 她真的出声之后(`agent_state` → `speaking`)才翻 —— 翻过来之后
     * 她开口的那几个字照样进识别(`shouldDiscardInputAudio`),真打断也掐得动。
     */
    const openerCutIn = createOpenerCutIn({ log })
    /** 这一通来电的「念完才起算 3 秒」那一台(每通一台;挂断 `stop()`)。 */
    let ringOpenerRun: OpenerRepeatRun | undefined

    /** 这一通收了:攒着的那几件挂着的问丢掉(不许串进下一通,announceHold.ts)。 */
    function announceHoldStop(): void {
      announceHold?.stop()
      announceHold = undefined
    }

    /** 这一回合那份判定(最多等 {@link UNDERSTAND_BUDGET_MS};到点按「问不到」走老路)。 */
    async function settleUnderstanding(): Promise<Understanding | undefined> {
      const holder = turnUnderstanding
      if (holder === undefined || holder.seq !== routing.seq) return undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const budget = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), UNDERSTAND_BUDGET_MS)
        timer.unref?.()
      })
      try { return await Promise.race([holder.pending, budget]) }
      finally { if (timer !== undefined) clearTimeout(timer) }
    }

    /** 这一回合已有确定回复路径吗(先应 / 垫场那两道闸要在开口之前问它)。 */
    async function thisTurnIsHandled(): Promise<boolean> {
      // ★ 道别也算「不等模型」那一种(卡 K):固定一句 0 毫秒就有,这两样垫上去只会抢在它前面。
      if (turnFarewell?.seq === routing.seq) return true
      if (pendingConfirm !== undefined) return true
      if (turnSay?.seq === routing.seq) return (await turnSay.pending) !== undefined
      return isHandled(await settleUnderstanding())
    }

    /**
     * ——— 一回合的计时(2026-09-23,Ben 真机:「延迟有点高」) ———
     *
     * 每一段多久:量在 latency.ts(纯数据结构,有用例),这里只是把框架那几个事件
     * 接到它的打点上。一回合收尾吐一行进 channel-worker.log,并报给 8791 ——
     * 统筹在体检页与 `GET /channel/latency` 上看的就是这一份。
     *
     * 关:`WORKBENCH_CHANNEL_LATENCY=off`。关掉之后下面这些 `mark` 一个都不接。
     */
    const timing = deps.config.latencyLog
      ? new TurnTimeline({
        onTurn: (latency) => {
          // 留一份给「关于我自己」那段用。**只是记一下**,计时本身一个字没改。
          lastTurn = latency
          // 测试口盯着的话,这一回合的成绩单也回给它一份(卡 TT)。计时本身一个字没改。
          textTurnCollector?.turnLatency(latency)
          log(`[channel-worker] ${formatTurnLatency(latency)}`)
          void deps.workbench.reportLatency(latency)
        },
      })
      : undefined

    /**
     * 换音色那一头的 8792 客户端(2026-09-23 起工具用它,2026-09-28 起兜底也用它)。
     * **换的和用的必须是同一台**,否则她会说「换好了」而嘴里还是旧嗓子(D13)。
     */
    const voiceClient = createVoiceClient({ butlerUrl: deps.config.butlerUrl })
    /**
     * **当前音色念不了中文时自己换回来**(2026-09-28,卡 VC)。
     *
     * 真机 09-28 19:2x:电话里换到英文女声 Dacey / Stokie,此后每一句中文都
     * `3011 unsupported language`,开场白预合成 10 趟全失败,他打过去一直没声音。
     * 这一层在连着两句这样的失败之后**自己 PUT 回上一个能用的音色**,再开口说一句人话。
     * 攒几句、换回哪一个的账都在 voiceRescue.ts。
     */
    const voiceRescue = createVoiceRescue({
      voice: voiceClient,
      log: text => log(text),
      say: (text) => {
        caption('butler', text, true)
        try { session?.say(text, { allowInterruptions: true, addToChatCtx: false }) }
        catch { /* 说不出来也已经换回去了,他下一句就听得见 */ }
      },
    })

    const tts = new ttsNs.StreamAdapter(
      new ButlerTts({
        butlerUrl: deps.config.butlerUrl,
        scene: deps.config.ttsScene,
        ...(deps.config.ttsVoiceId === undefined ? {} : { voiceId: deps.config.ttsVoiceId }),
        /**
         * 字幕与声音同一时刻出现(2026-09-18,Ben:「开场白的文字很早就有一个气泡出现,
         * 闪了一下之后语音才开始播放」)。所以字幕接的是**这一句进音频队列**那一下,
         * 不是模型「这句生成完了」那一下 —— 合成还要几百毫秒。按句推,一句一条。
         */
        onSpeech: (text: string, ok: boolean, tone?: Tone) => {
          // 语气跟着这一句一起广播(2026-10-02):手机拿它驱动表情;字幕文字里不含标签。
          caption('butler', text, true, tone)
          // 真出声了:兜底那头攒下的那一笔归零,并把现在这个音色记成「能用」(卡 VC)。
          if (ok) voiceRescue.noteSpoken()
        },
        /**
         * 连着几句合不出声就在字幕里说一句实话(2026-09-20)。这一句**不经模型、不出声**
         * —— 出不了声正是它要说的那件事。会话照旧活着,见 butlerTts.ts 里 failed() 那一段。
         */
        onDegraded: (text: string) => caption('butler', text, true),
        /**
         * **这一句是「这个嗓子念不了这段字」哑的**(2026-09-28,卡 VC):交给兜底那一层,
         * 连着两句就自己把音色换回一个会念中文的 —— 绝不让整通电话没声音。
         */
        onLanguageMismatch: () => { void voiceRescue.languageMismatch() },
        ...(timing === undefined ? {} : { onMark: (name) => timing.mark(name) }),
        /**
         * **流式合成**(2026-09-23):先走 8792 的 `/api/tts/stream`,边合边发。
         * 走不通当场回退老路,一个进程只白试一次。开关见 config.ts。
         */
        stream: deps.config.ttsStream,
      }),
      /**
       * 按句切分:模型吐一句就合一句、说一句。首字延迟等于**第一小块**的合成时间,不是整段的。
       * 2026-09-18 换成中文断句器:框架自带那个只认英文的 `. ! ?`,中文句号一个都不认,
       * 于是一整段话才合成一次 —— 开场白那一百字要等两秒多才出声(Ben 说的「十秒」里有这一段)。
       */
      new ChineseSentenceTokenizer({
        ...(deps.config.ttsSoftBreakAt === undefined ? {} : { softBreakAt: deps.config.ttsSoftBreakAt }),
        ...(deps.config.ttsFirstBreakAt === undefined ? {} : { firstSoftBreakAt: deps.config.ttsFirstBreakAt }),
        // 模型的第一段字到嘴边了 —— 这是这条链路上唯一拿得到「模型首字」的地方(sentences.ts)。
        //
        // 顺手记一个数:**第一次推过来有多少字**。一个字就是真流式;一整句就说明这条链路上
        // 有人在攒 buffer(中转、反代、SDK,总有一个)。09-23 第一批里
        // 「模型首字 → 开始合成」一次 189ms、一次 10ms,10ms 那次很可疑,这一行就是去验它的。
        ...(timing === undefined
          ? {}
          : {
            onFirstText: (text: string) => {
              timing.mark('llm_first')
              const who = firstTextSource
              firstTextSource = undefined
              if (who !== undefined) {
                // 固定句(开场白、先应、垫场)是**整句一次推进来**的,「几个字」在这里说明不了任何事。
                log(`[channel-worker] ${who}首段 ${[...text].length} 字(固定句,一次整句推进来的,不是流式的证据)`)
                return
              }
              log(`[channel-worker] 模型首段 ${[...text].length} 字(一个字 = 真流式;一整句 = 路上有人攒 buffer)`)
            },
          }),
      }),
    )

    /**
     * 合一句话 → PCM。**提出一个名字**只为一件事:首句(2026-10-03,卡「首声提速」乙)
     * 要**现合成**一句缓存里没有的话,用的必须是**同一台 8792、同一个音色**
     * (换的和用的不是同一台就会出现「说换好了,嘴里还是旧嗓子」那种 D13)。
     * 预合成那张缓存照旧拿它合(下面 `GreetingCache`),一个字没改。
     */
    const synthesizeLine = createGreetingSynthesizer({
      butlerUrl: deps.config.butlerUrl,
      scene: deps.config.ttsScene,
      ...(deps.config.ttsVoiceId === undefined ? {} : { voiceId: deps.config.ttsVoiceId }),
      log,
    })
    /**
     * ——— 提机那一句,**现在就合好**(2026-09-23)———
     *
     * Ben 12:xx:「我拿起电话到说话中间可能间隔有一两秒吧,所以最好事务官能先问一句:
     * 『老板,有什么吩咐?』还蛮重要的。」
     *
     * 称呼表上每个称呼一句,工人一启动就去 8792 合好放着(换音色之后重来一遍,
     * 见下面 voiceWatcher)。提机的 `start` 一到直接发缓存的帧 —— 不等模型、不等合成。
     * **不 await**:它要等好几条 HTTP,而进房这件事一秒都不该为它多等;
     * 还没合完时提机走的是老路(现合成,慢一两秒),一句话都不少。
     */
    greetings = new GreetingCache({
      synthesize: synthesizeLine,
      /**
       * 要预热哪几句:
       *   · 表上每个称呼的提机那一句。**只有提机这一句**:来电那句 `ringOpener` 有三种理由,
       *     预热的份数要翻三倍,而他被铃叫醒、接起前本来就等了几秒 —— 见 docs/决策记录.md;
       *   · **按意图先应的那四句**(2026-09-23 下午,`ACK_LINES`)。它们和开场白是同一件事:
       *     要在等待路径的最前面出声,就必须已经合好;换音色时也跟着整张重合成。
       *     四句与称呼表无关(不带称呼),所以份数是固定的四句。
       */
      lines: () => [
        ...addressListOf(persona.addresses ?? []).map(one => offhookGreeting(one)),
        ...ACK_LINES,
        SAY_PENDING_ACK_LINE,
        // 垫场那五句(2026-09-23 晚,工人自己说):同一张缓存,换音色跟着整张重合。
        ...(workerFiller === undefined ? [] : FILLER_LINES),
        // 引导开场白(2026-09-23 统筹第三轮 T):手机配对后进电话引导,第一句就是它 —— 定死的一句,
        // 与提机那句同一个道理:合好放着,引导一开口直接发帧,不等合成。
        ...ONBOARDING_PREWARM_LINES,
      ],
      log,
    })
    /**
     * **8792 还没起来就等它起来再补**(2026-09-27)。09-27 那台全新的 Air 上工人比事务官后端先起来,
     * 启动这一趟 12 句全是 503,而**之后再没有人补过** —— 那一轮进程里每句开场白都只能现合成。
     * 退避重试在 greeting.ts 的 {@link warmWhenReady} 里(有用例);这里照旧**不 await**。
     */
    void warmWhenReady(greetings, { log }).catch(() => { /* 它自己就不抛,这一行只是兜住将来 */ })
    /**
     * 开场那一句**晚多久再出口**(2026-09-23 下午,维护者 14:20:
     * 「拿起电话之后,我放到耳边,一听到『吩咐』两个字,很明显说的太早了」)。
     *
     * 提机与来电接起**共用这一个**:两处的行为必须一模一样,而且挂断能一把取消。
     * 缺省 700ms,`WORKBENCH_CHANNEL_GREETING_DELAY_MS=0` 就逐字回到上一版。
     */
    /**
     * 排到点之后**再等对端订上工人音轨**(2026-09-27,卡 CL;理由与证据见 tts/openerGate.ts)。
     * 到点(缺省 1.5s)还没订上就照旧开口 —— 不许因为等而让他举着一只安静的听筒。
     *
     * 音轨发布**每次现取**:工人常驻,满重连时 SDK 会把这条轨重新发一次(换了 sid)。
     */
    const openerGate = createOpenerGate({
      publication: () => audioPublicationOf(room.localParticipant?.trackPublications?.values?.()),
      timeoutMs: deps.config.openerSubscribeMs,
      log,
    })
    /**
     * ★ **再等手机说「我这边真的在放了」**(2026-09-28,卡 CF 第 4 条;理由见 tts/playingGate.ts)。
     *
     * 卡 CL 那道闸等的是「订上音轨了没有」,而手机常驻房间 —— 它十几分钟前就订上了,
     * 那道闸每通都是「等了 0ms」,整句前面一大截照旧被吃。这一道等的是**它自己报的起播**。
     * 老手机不报 → 这一道整个跳过(逐字回到卡 CL 那一版)。
     */
    playingGate = createPlayingGate({ timeoutMs: deps.config.openerPlayingMs, log })
    const openerReady = deps.config.openerSubscribeMs <= 0 && deps.config.openerPlayingMs <= 0
      ? undefined
      : async (): Promise<void> => {
        if (deps.config.openerSubscribeMs > 0) await openerGate()
        if (deps.config.openerPlayingMs > 0) await playingGate?.wait()
      }
    const opening = new OpeningDelay({
      delayMs: deps.config.greetingDelayMs,
      ...(openerReady === undefined ? {} : { ready: openerReady }),
    })
    log(`[channel-worker] 开场那一句延后 ${opening.delayMs}ms 再出口(提机到贴耳那一段;改:WORKBENCH_CHANNEL_GREETING_DELAY_MS)`)
    log(`[channel-worker] 开场那一句${deps.config.openerSubscribeMs <= 0 ? '不等对端订上音轨' : `最多等 ${deps.config.openerSubscribeMs}ms 等对端订上音轨`}`
      + `,前面垫 ${deps.config.openerLeadMs}ms 静音(对端起播那一下吃掉的是这一段,第一个字才整;改:WORKBENCH_CHANNEL_OPENER_SUBSCRIBE_MS / _OPENER_LEAD_MS)`)
    log(`[channel-worker] 开场那一句${deps.config.openerPlayingMs <= 0
      ? '不等手机说「我这边在放了」'
      : `最多等 ${deps.config.openerPlayingMs}ms 等手机说「我这边在放了」(老手机不报就不等)`}`
      + '(改:WORKBENCH_CHANNEL_OPENER_PLAYING_MS)')

    /**
     * 端点检测那一段固定等待(2026-09-23)。**缺省一个字都不传** —— 用框架自己的默认值
     * (流式 STT 300/2500,VAD 分段 500/3000)。调小了她抢话更早,代价是他中间换一口气
     * 就被当成说完了。真机上要试就用 `WORKBENCH_CHANNEL_ENDPOINTING_MIN_MS`,
     * 前后各量二十回合(`GET /channel/latency` 的 `commit_ms`),别凭感觉定。
     */
    const endpointing = deps.config.endpointingMinMs === undefined && deps.config.endpointingMaxMs === undefined
      ? undefined
      : {
        ...(deps.config.endpointingMinMs === undefined ? {} : { minDelay: deps.config.endpointingMinMs }),
        ...(deps.config.endpointingMaxMs === undefined ? {} : { maxDelay: deps.config.endpointingMaxMs }),
      }
    if (endpointing !== undefined) log(`[channel-worker] 端点检测固定等待按配置改过:${JSON.stringify(endpointing)}`)

    /**
     * **抢跑合成**(2026-09-23)。框架缺省只让模型抢跑,合成要等回合确认
     * (`preemptiveGeneration: { enabled: true, preemptiveTts: false }`)——
     * 于是第一句的合成时间整段压在他说完之后。打开之后它基本从等待路径上消失,
     * 代价是「他又补了一句」的那几轮白合一次。理由与开关见 config.ts。
     */
    if (!deps.config.ttsStream) log('[channel-worker] 流式合成按配置关了:走老的 /api/tts,首包等于整句的合成时间。')
    if (deps.config.preemptiveTts) log('[channel-worker] 抢跑合成开着:回合确认之前就开始合第一句(他改口那几轮会白合一次)。')
    /**
     * **打断那条路换成认中文的判法**(2026-10-03,决策记录 ④甲)。
     *
     * 填进去的是框架那道词数闸的「关上」值 —— 为什么是反着用、为什么不动 `enabled`、
     * 不动 `discardAudioIfUninterruptible`,整段理由在 bargeIn.ts 的文件头(带行号)。
     * 一句话:她说话时框架自己一次都不掐、也不开新回合,判断全归下面那台 {@link BargeIn};
     * 该停的时候我们自己调 `session.interrupt()`,两道门立刻让路。
     *
     * `WORKBENCH_CHANNEL_BARGE_IN_ZH=off` 时这一格一个字都不填,逐字回到 10-02 的行为。
     */
    const turnHandling = {
      ...(endpointing === undefined ? {} : { endpointing }),
      ...(deps.config.preemptiveTts ? { preemptiveGeneration: { preemptiveTts: true } } : {}),
      ...(deps.config.bargeInZh ? { interruption: { minWords: WORD_GATE_SHUT } } : {}),
    }
    log(deps.config.bargeInZh
      ? `[channel-worker] 打断按中文的字数判:框架那道词数闸关上(minWords=${WORD_GATE_SHUT}),`
        + `「嗯 / 对 / 好」不停她、真打断我们自己掐(改:WORKBENCH_CHANNEL_BARGE_IN_ZH=off 退回 10-02)`
      : '[channel-worker] 打断按配置退回 10-02 的行为:框架自带那条路,一声「嗯」也会把她掐断。')

    /**
     * 这一轮**真的交给模型的那几个参数**。提出来只为一件事:「关于我自己」那段里
     * 「thinking 开没开」读的就是它(selfBrief.ts 的 `thinkingOf`)——
     * 于是那句话不是写死的「没开」,哪天这里多一项 thinking,她在电话里的答案自己就变了。
     *
     * **这一份是活的**(2026-10-23 运行时 P1):一通电话开始时现读一次 model.json
     * (refreshSelfBrief 里,与「认得出哪几家」同一条缝),变了就 `session.updateOptions`
     * 换掉 LLM —— 在通的那通照旧打完,下一通吃新配置;不打断通话,也不靠外部重启进程。
     */
    // apiKey 用 '' 表示「没有 key」(下游签名要 string;没 key 本来也接不了话,见下面那道闸)。
    let llmOptions: {
      model: string
      firstVoiceModel: string
      apiKey: string
      baseURL: string | undefined
      thinking: typeof THINKING_DISABLED
    } = {
      model: deps.config.llmModel,
      firstVoiceModel: deps.config.firstVoiceModel,
      apiKey: deps.deepseekKey ?? '',
      baseURL: deps.config.llmBaseUrl,
      /**
       * **这一路显式关思考**(2026-09-28,卡 BS)。有人正举着听筒等回话,想 4–16 秒
       * 是最贵也最不该花的一笔(思考按输出计价)。这个键写在这儿有两个作用:
       * 一是「关于我自己」那段里 `thinkingOf` 读的就是它(于是她在电话里答「没开」是**读**出来的);
       * 二是它就是下面那个客户端真往 body 里塞的那一格 —— 上游的 withDeepSeek 拼请求时
       * 只放它认得的字段,额外键会被丢掉,所以真正塞进去的是 `llmThinking.ts` 那一层 fetch。
       */
      thinking: THINKING_DISABLED,
    }
    /** 一通电话的活视图 → 接话 LLM 需要的三样(首通与每通刷新同一份构建,不漂)。 */
    const llmViewOf = (now: ChannelModelNow): { model: string, apiKey: string, baseURL: string | undefined } => ({
      model: now.llmModel,
      apiKey: now.key ?? '',
      baseURL: now.llmBaseUrl,
    })
    /**
     * 按一个视图(模型名 / key / 地址)重建接话 LLM。视图在换 LLM 成功之前先用候选值,
     * 避免「先改了缓存再等 updateOptions」的竞态。
     */
    const buildLlm = (view: { model: string, apiKey: string, baseURL: string | undefined }) => OpenAILLM.withDeepSeek({
      model: view.model,
      apiKey: view.apiKey,
      ...(view.baseURL === undefined ? {} : { baseURL: view.baseURL }),
      // 自建客户端:唯一能让它发 DeepSeek 方言 `thinking` 的口子(理由见 llmThinking.ts)。
      client: createNoThinkingClient({
        apiKey: view.apiKey,
        ...(view.baseURL === undefined ? {} : { baseURL: view.baseURL }),
      }),
    })

    session = new AgentSession({
      vad: deps.vad,
      stt: asr.stt,
      ...(Object.keys(turnHandling).length === 0 ? {} : { turnHandling }),
      llm: buildLlm(llmOptions),
      tts,
    })

    /**
     * ——— **这一回合的第一句话,现生一句贴这件事的**(2026-10-03,卡「首声提速」乙)———
     *
     * 维护者的后果描述:「多数回合先『我想想』垫场,再等好几秒」。那一句的边界、
     * 四条当场检查的规矩在 `firstVoice.ts`;插进去的路是垫场那一条(workerFiller.ts),
     * **一个字没改** —— 所以它同样不进对话历史、不进字幕,她一开口就跟着停。
     *
     * 三个「不建」:垫场关了(没有插进去的路)、首句关了、没有模型 key。
     * 不建 = 逐字回到固定那五句。
     */
    const buildFirstVoiceClient = (view: { apiKey: string, baseURL: string | undefined }) => (
      deps.config.firstVoice && workerFiller !== undefined && view.apiKey !== ''
        ? createNoThinkingClient({
          apiKey: view.apiKey,
          ...(view.baseURL === undefined ? {} : { baseURL: view.baseURL }),
        })
        : undefined)
    let firstVoiceClient = buildFirstVoiceClient(llmOptions)
    const firstVoice = firstVoiceClient === undefined || workerFiller === undefined
      ? undefined
      : new FirstVoice({
        /**
         * 问那一句。**不带工具、不带人设、最多 40 个 token** —— 快的一半原因在这儿
         * (电话人设 3000 多字,这一问两百来字)。`thinking` 由客户端那层 fetch 关掉
         * (llmThinking.ts),与接话那一路同一个口子。
         */
        ask: async ({ system, user }) => {
          if (firstVoiceClient === undefined) return undefined
          const answer = await firstVoiceClient.chat.completions.create({
            model: llmOptions.firstVoiceModel,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            max_tokens: FIRST_VOICE_MAX_TOKENS,
            stream: false,
          })
          const said = answer.choices[0]?.message?.content
          return typeof said === 'string' && said.trim() !== '' ? said : undefined
        },
        /**
         * 合成那一句、交给垫场那条路。**合不出来就算了**(回 `unvoiced`):
         * 宁可这一回合垫固定那句,也不现合成去撞她的真回答。
         */
        speak: async (text, guard) => {
          const got = await synthesizeLine(text)
          if (got === undefined || got.pcm.length === 0) return 'unvoiced'
          /*
           * **合成这一截里她可能又说了一句**(2026-10-03,卡 fix/voice-route-zh;审计附证 A)。
           * 垫场那条路是整通电话共享的一条,这儿不问一声就会把上一回合的首句垫进新回合。
           */
          if (!guard.current()) return 'late'
          const frames = greetingFrames({ text, pcm: got.pcm, sampleRate: got.sampleRate })
          // `whole`:**这一句不许被掐断**(十来个字,两秒;吞字比多等几百毫秒糟。见 workerFiller.ts)。
          return workerFiller.offerFirstVoice({ text, frames, whole: true }) ? 'said' : 'late'
        },
        timeoutMs: deps.config.firstVoiceTimeoutMs,
        log,
        /**
         * 结局进这一回合的计时那一行(latency.ts 多的那几格)。
         * `first_voice:'said'` 的意思是「交给垫场那条路了」;**真垫出声那一下**
         * 由同一行的 `filler:true` 作证(`WorkerFiller.onPlay`)—— 两格分开看,不混成一个。
         */
        onDone: result => timing?.note({ firstVoice: result.outcome, firstVoiceMs: result.ms }),
      })
    log(`[channel-worker] 这一回合的首句:${firstVoice === undefined
      ? '关着(固定那五句照旧)'
      : `开着,模型 ${llmOptions.firstVoiceModel},最多等 ${deps.config.firstVoiceTimeoutMs}ms`
        + `,到点再多等 ${deps.config.firstVoiceGraceMs}ms(关:WORKBENCH_CHANNEL_FIRST_VOICE=off)`}`)
    log(`[channel-worker] 工具按意图下发:${deps.config.toolsByIntent
      ? '开着(认不出意图的回合照旧全套;关:WORKBENCH_CHANNEL_TOOLS_BY_INTENT=off)'
      : '关着(每个要办事的回合都带全套)'}`)

    const channelTools = createChannelTools({
      workbench: callWorkbench,
      deviceFiles,
      /**
       * 换音色那件工具的那一头(2026-09-23)。地址就是合成走的那个 8792 ——
       * **换的和用的必须是同一台**,否则她会说「换好了」而嘴里还是旧嗓子(D13)。
       */
      voice: voiceClient,
      /** 转本体时的缺省收件人:这通来电正在说的那条事项(平时的通话里没有,那时让模型自己查一条)。 */
      currentItemId: () => ring?.answered()?.item_id,
      /**
       * **他刚才亲口说的那一句**(2026-09-27,卡 LK):捎话那道门靠它判「他到底让不让发」。
       * 与引导那边交答案用的是同一条尾巴(dialogueTail),取的都是他最后连着说的那几句。
       */
      lastSaid: () => dialogueTail.heard()?.reply,
      ...(deps.config.sendQuickMs === undefined ? {} : { sendQuickMs: deps.config.sendQuickMs }),
      onStart: onToolStart,
      onUsed: noteToolUsed,
      /**
       * 大文件先回了「开始传了」,**后来**传完 / 没传过去(2026-09-25,卡 J)。电话还开着就当场说一声;
       * 没在通话里就只记日志 —— 手机那头自己看得见(收到了就有「收到」,没收到有 file_status 带原因)。
       */
      onLateSend: (text, ok) => {
        log(`[channel-worker] 后来的传文件结果(${ok ? '成了' : '没成'}):${text}`)
        if (callState?.current() === undefined && !onboardingOn) return
        try { session?.say(text, { allowInterruptions: true, addToChatCtx: false }) }
        catch { /* 说不出来就算了,手机上看得见 */ }
      },
      /**
       * **电话里换完音色,那张预合成的缓存当场作废**(2026-09-23 下午)。
       *
       * 维护者 14:20 真机:「音色和最开始听到的『吩咐』二字不一致。」缓存里装的是**声音** ——
       * 不作废的话,他换完嗓子、下一通提机听见的还是上一个人;这一通里也会变成
       * 「好,我挑几个给你听」是旧嗓子、她的回答是新嗓子,两个人在说话。
       *
       * 两条路都接上了:这一条是**电话里换**(当场),下面 `voiceWatcher` 那条是
       * **在 Mac 的配置后台里换**(`PUT /api/voices/current`,隔几秒问一次)。
       * 逐个播样音那种试听只作废、不重合成(理由见 tools.ts 的 `onVoicePicked`)。
       */
      onVoicePicked: (voiceId, options) => {
        // 兜底那头要知道「这会儿是哪个嗓子」,才说得出退回哪一个(卡 VC)。
        voiceRescue.noteSwitched(voiceId)
        if (options?.preview === true) { greetings?.invalidate(voiceId); return }
        void greetings?.revoice(voiceId).catch(() => { /* revoice 自己不抛 */ })
      },
      /**
       * **她要挂了**(2026-09-23 晚)。模型调了 `wb_end_call` 就到这儿:
       * 先拿他**这一回合的原话**过一遍否决(转述、「别挂」、道别后又说了新的事),
       * 过了就记下「要挂」—— 真挂要等她那句道别播完,见 farewell.ts 的状态机。
       */
      endCall: () => {
        const veto = endCallVeto(turnHeard)
        if (veto !== undefined) {
          log(`[channel-worker] 她想挂,没让(他原话「${turnHeard.slice(0, 40)}」):${veto}`)
          return { ok: false, text: veto }
        }
        if (farewell === undefined) return { ok: false, text: '没挂:这会儿挂不了。接着跟他聊。' }
        farewell.request()
        return { ok: true, text: END_CALL_ACCEPTED_TEXT }
      },
    })
    /**
     * 闲聊回合**只递挂断这一件**的那份工具集(2026-09-23 晚)。回合分流把「拜拜」判成闲聊、
     * 闲聊回合零工具 —— 不单独递这一件,模型想挂也挂不了。只在他这句话像道别时递(farewell.ts)。
     */
    const endCallTool = (channelTools as Record<string, unknown>)[TOOL_END_CALL]
    const END_ONLY = endCallTool === undefined
      ? undefined
      : new llmNs.ToolContext({ [TOOL_END_CALL]: endCallTool } as never) as unknown as ToolContext

    /**
     * **一直是同一个 Agent**(2026-09-18 踩过坑之后改的)。进出引导只换它的提示词与工具
     * (`updateInstructions` / `updateTools`),**不换 Agent** —— `session.updateAgent()` 会把整条
     * AgentActivity 重建一遍:本机实测的现象是开场白照说、转写照出,但她**从此不接话**了,
     * 而且新活动搭起来要好几秒,排在它后面的开场白也跟着慢。
     */
    const agent = new Agent({ instructions: persona.system_message, tools: channelTools })

    /**
     * ——— **她说的那一声「嗯」不进交给模型的文本**(2026-10-03,维护者拍板「抹掉」)———
     *
     * 判成应声的那一段上面那道闸已经让它**不进回合**了(`UserInputTranscribed` 那一处 `return`),
     * 但框架那一头照旧把它攒着:`onEndOfTurn` 回 `false` 时 `audioTranscript` 不清
     * (`dist/voice/audio_recognition.js` 第 1266–1275 行),下一句最终转写
     * `audioTranscript += ' ' + transcript`(第 862–863 行)—— 于是模型收到的是
     * 「嗯 帮我把这条派给 Codex」,而工人日志里的「他说」是干净的。两边不一致。
     *
     * 上游**没有**「这一段别攒」的口子(整格口子表在 bargeIn.ts 文件头),能接的最前一处就是
     * `onUserTurnCompleted`:框架在**调模型、进对话历史之前**拿着那条用户消息问我们一次
     * (`agent_activity.js` 第 2118 行造、第 2137 行调;改过的 content 后面原样用 ——
     * 上游自己有一条用例钉着这件事,`agent_activity.test.js:1557`
     * 「keeps onUserTurnCompleted edits on the retained speculative message」)。
     *
     * 剥的分寸全在 `stripLeadingAcks`:**只剥判定命中的那一截**、剥到一个字不剩就退回原文。
     *
     * ⚠️ **认了的一笔代价**:框架的抢跑生成拿 `info.newTranscript`(没剥过的那一份)与这里改完的
     * content 比(`transcriptsEquivalent`,第 2181 行),剥过的那一回合比不上 → 抢跑那一次作废、
     * 重发一遍(第 2197 行那条 warn)。也就是**真剥到的那几个回合慢一趟**,不会出错。
     * 抢跑合成本来缺省就是关的(`WORKBENCH_CHANNEL_PREEMPTIVE_TTS`),这一笔只落在抢跑生成上。
     */
    const baseUserTurnCompleted = agent.onUserTurnCompleted.bind(agent)
    agent.onUserTurnCompleted = async (chatCtx, newMessage) => {
      await baseUserTurnCompleted(chatCtx, newMessage)
      await sayPlannedAck()
      if (!deps.config.ackOutOfText) return
      const dropped = bargeIn?.takeDroppedAcks() ?? []
      if (dropped.length === 0) return
      /*
       * 只认「content 就是一段字」那一种(识别那条路造出来的就是它:
       * `ChatMessage.create({ role:'user', content: info.newTranscript })`)。
       * 形状不认得就一个字都不动 —— 剥错一句话比多一声「嗯」贵。
       */
      const parts = newMessage.content
      if (parts.length !== 1 || typeof parts[0] !== 'string') return
      const got = stripLeadingAcks(parts[0], dropped)
      if (got.stripped.length === 0) return
      newMessage.content = [got.text]
      log(`[channel-worker] 那一声「${got.stripped.join('」「')}」没进交给模型的文本(剩下的是「${got.text.slice(0, 40)}」)`)
    }

    /**
     * ——— 分流接在这里:`llmNode` 是**调模型前的最后一道关口**(2026-09-23)———
     *
     * 为什么是 `llmNode` 而不是在识别结果那一刻 `agent.updateTools({})`:
     *   ① `updateTools` 是**异步**的,而回合提交在识别最终文本之后 5~40ms 就发生
     *      (真机 `commit_ms`)—— 抢不抢得赢全看运气,而「这一回合到底带没带工具」不能靠运气;
     *   ② 框架的 `updateTools` 每换一次就往对话历史里插一条 `AgentConfigUpdate`,
     *      一通电话来回切十几次,等于在他和她的对话里塞十几条系统噪音;
     *   ③ `llmNode` 拿到的 `toolCtx` **就是这一次要发给模型的那一份**,在这里换掉是精确的。
     *
     * 三条纪律:
     *   · **引导中不分流**:引导那一套的 `record_answer` 被收走 = 他答的话没人记,
     *     而引导里每一句都是答案(「我叫 Ben」没有任何一个「要办事」的词);
     *   · **来电接起的那一通不分流**:那一通里她刚问过他一个要拍板的问题,
     *     「可以了」「好的」就是批准(真机那一通里紧跟着的正是 `wb_decide_item`)。
     *     收走工具 = 他说了「可以」而卡没动 —— 那是两种错里贵的那一种;
     *   · **一个回合里只判一次**:模型调完工具会再回到这里,那时用的是同一个判定
     *     (`TurnRouting.settle` 第 ② 条),中途换工具集等于把它正在办的事掐断。
     */
    const baseLlmNode = agent.llmNode.bind(agent)
    /**
     * 垫场那一层(2026-09-23 晚,workerFiller.ts):模型还没吐字时「该垫了」一响,
     * 往文字流里塞一个空串让框架当场开一段 —— 不改任何文字、不进对话历史。
     */
    const kickLlm = async (stream: ReturnType<typeof baseLlmNode>): ReturnType<typeof baseLlmNode> => {
      const got = await stream
      if (got === null) return got
      // 2026-09-30 Air 真机:模型把工具调用写成一段 DSML 文字吐进正文 —— 不念,当成真的工具调用交给框架(dsmlToolCalls.ts)。
      // 2026-09-24:模型流里紧挨着重复的一小段(「运营?营?」)在这儿去掉 —— 合成、字幕、对话历史都走这一条(stutter.ts)。
      const clean = withoutStutter(withDsmlToolCalls(got))
      /*
       * 2026-10-12(卡「通话补一句不丢事」第 3 条):这一回合没有一件工具办成时,「派给 Claude 了」「换好了」
       * 那一句换成如实的问话(claimGuard.ts)。排在 DSML 之后:写进正文的工具调用要先变回真的工具调用,
       * 才认得出「这一步跟着调了工具」。
       */
      const honest = withHonestClaims(clean, {
        active: turnClaimGuard,
        mayClaim: () => turnToolOk,
        /*
         * ★ 2026-10-13(卡「三个入口一套管线」第 ④ 处,10-13 早真机):
         *   · **一通里一类只换一次** —— 那一通里「我还没记下,要我现在记吗?」说了三次;
         *   · **按真实状态说** —— 工具跑过、它自己报没成时,说的是那句原因,不是「我还没派」。
         */
        alreadyRewrote: kind => rewroteKinds.has(kind),
        noteRewrote: kind => rewroteKinds.add(kind),
        insteadOf: () => (turnToolFailed === undefined ? undefined : failedLine(turnToolFailed)),
        onRewrite: (said, instead) => log(`[channel-worker] 这一回合没有工具办成,她那句「${said.slice(0, 60)}」没念,换成「${instead}」`),
      })
      // 他的规矩「电话每轮不超过两句」在流上掐(2026-09-24 晚,卡 K;sentenceCap.ts)。上限来自规矩表;引导那一通不掐。
      const capped = onboardingOn ? honest : withSentenceCap(honest, turnBudget, persona.max_sentences)
      return workerFiller === undefined ? capped : withFillerKick(capped, workerFiller, '')
    }
    /**
     * ★ **固定流程那一回合:8791 当场办完,念一句,不经模型**(2026-10-13,卡「三个入口一套管线」)。
     *
     * 回的是一条只有一句话的文字流 —— 框架照常把它排进发言队列、进对话历史、推字幕与表情
     * (理由见 `understand.ts` 的 `saidStream`)。这一回合:
     *   · **兜底句关掉**(`turnClaimGuard = false`):这一句是真办完之后拼的,它不是模型许的愿;
     *   · **算这一件办了**(`routing.noteHandled()`):下一句短话按「承接」走,不再并进来;
     *   · `/butler/item` 建出来的那一件记成 {@link openThing} —— 她紧接着补的细节并进它。
     */
    async function runFixedFlow(
      understanding: Understanding,
      options: { confirmed?: boolean, text?: string } = {},
    ): ReturnType<typeof baseLlmNode> {
      turnClaimGuard = false
      // 这一回合的判定用掉了:`llmNode` 万一被调第二次,不许把同一件事办两遍。
      if (turnUnderstanding !== undefined) turnUnderstanding.taken = true
      /*
       * ★ **送去办的正文用 8791 认的那一句**(2026-10-13 下午,卡 A 第 6 条,`bodyTextOf`):
       * `turnHeard` 是这一回合几段识别结果**拼**起来的那一段,他被打断之后它成了
       * 「给我生成一个。给我生成一个女孩子…」—— 卡标题、主题、选题目录名全跟着带上口吃引子。
       * 「听懂」那一问是按段问的,工人自己认下来的那一句是对的。
       */
      const text = options.text ?? bodyTextOf({ ...(turnUnderstanding === undefined ? {} : { asked: turnUnderstanding.text }), heard: turnHeard })
      // 只回问一句的那一档(「这条打算哪天发?」):一个字都不办。
      if (understanding.route === undefined) {
        const ask = understanding.ask ?? ''
        log(`[channel-worker] 固定流程:只回问一句 —— 「${ask}」`)
        routing.noteHandled()
        return saidStream(ask)
      }
      const path = understanding.route.path
      /**
       * ★ **先念再办**(2026-10-13 下午,卡 A 第 1 条;判据在 `understand.ts` 的 `saysFirst`)。
       *
       * 派活那一步要 7.4–7.6 秒,而固定流程回合按设计不先应、不垫场 ——
       * 三通真机下来就是「他说完,听筒里 9 秒没人说话」(`llm_first_ms 7631 / 7437`)。
       * `say.start` 本来就是「将要做」的措辞,所以**当场念**,`/butler/item` 放后台。
       *
       * 没派出去时**另起一句** `session.say` 补(不是把这一回合的流吊着等它):
       * 框架对 TTS / 音频转发都有 10 秒的空闲上限(`ttsReadIdleTimeout` /
       * `forwardAudioIdleTimeout`,`agent_session.js` 缺省 `1e4`),一条开着 7 秒不吐字的流
       * 正好撞在上面 —— 而且吊着那一回合就回不到「听」,他这 7 秒里说的话都得排队。
       */
      if (saysFirst(understanding)) {
        const first = understanding.say.start.trim()
        log(`[channel-worker] 固定流程 ${understanding.kind} → ${path}:先念「${first}」,派活放后台`)
        routing.noteHandled()
        const pending = deps.workbench.runUnderstanding({
          understanding,
          text,
          ...(options.confirmed === true ? { confirmed: true } : {}),
        })
        void pending.then((done) => {
          log(`[channel-worker] 后台那一步回来了(${path}):${done.ok ? '办好了' : '没办成'}${done.why === undefined ? '' : `(${done.why})`},说「${done.say}」`)
          openThing = done.itemId === undefined ? openThing : { itemId: done.itemId, said: text, atMs: Date.now() }
          if (done.ok) return
          const why = sayFirstFailLine(done.say)
          if (why === undefined) return
          // 这一通已经挂了就不补(更不许串进下一通)。
          if (session === undefined || callState?.current() === undefined) {
            log(`[channel-worker] 这一通已经不在了,没派出去那一句没补:「${why}」`)
            return
          }
          try { session.say(why, { allowInterruptions: true, addToChatCtx: true }) }
          catch (err) { log(`[channel-worker] 没派出去那一句没补上:${(err as Error)?.message ?? '没说原因'}`) }
        }).catch((err: unknown) => {
          log(`[channel-worker] 后台那一步出错了(${path}):${(err as Error)?.message ?? '没说原因'}`)
        })
        return saidStream(first)
      }
      const done = await deps.workbench.runUnderstanding({
        understanding,
        text,
        ...(options.confirmed === true ? { confirmed: true } : {}),
      })
      log(`[channel-worker] 固定流程 ${understanding.kind} → ${path}:${done.ok ? '办好了' : '没办成'}${done.why === undefined ? '' : `(${done.why})`},说「${done.say}」`)
      if (done.ok) turnToolOk = true
      routing.noteHandled()
      openThing = done.itemId === undefined
        ? undefined
        : { itemId: done.itemId, said: text, atMs: Date.now() }
      return saidStream(done.say)
    }

    const routedLlmNode = async (...args: Parameters<typeof baseLlmNode>): ReturnType<typeof baseLlmNode> => {
      const [chatCtx, toolCtx, modelSettings] = args
      // 引导那一通不拦(它有自己那一套话术,`record_answer` 也不算「办事」);来电那一通照拦。
      turnClaimGuard = deps.config.claimGuard && !onboardingOn
      // The ordinary phone path has already received its sole decision from /butler/say.
      if (!onboardingOn) {
        const bye = turnFarewell?.seq === routing.seq ? turnFarewell.say : farewellFixedSay(turnHeard)
        if (bye !== undefined) {
          turnClaimGuard = false
          routing.noteHandled()
          const asked = farewell?.request() === true
          if (farewellSaid) {
            log(`[channel-worker] 他又道了一次别(「${turnHeard.slice(0, 20)}」):这一通已经道过别了,只挂,不再说一遍`)
            return saidStream('')
          }
          farewellSaid = true
          log(`[channel-worker] 他道别了(「${turnHeard.slice(0, 20)}」):固定一句就收${asked ? '' : '(挂断那一下已经在等了)'}`)
          return saidStream(bye)
        }
        if (turnSay?.seq === routing.seq && turnSay.taken === true) return saidStream('')
        if (turnSay?.seq === routing.seq && turnSay.taken !== true) {
          const external = turnSay
          const reply = await external.pending
          if (external !== turnSay || external.generation !== sayGeneration) return saidStream('')
          if (reply !== undefined) {
            external.taken = true
            turnClaimGuard = false
            pendingConfirm = undefined
            routing.noteHandled()
            broadcastSayDecisions(reply, external.callId)
            log(reply.say_id === '' ? '[channel-worker] 念电话服务结果/未知状态' : `[channel-worker] /butler/say ${reply.say_id}:照读服务端 spoken`)
            return guardSayStream(saidStream(reply.say.spoken), () => external.generation === sayGeneration)
          }
        }
        // No legacy understand/router/model fallback: an absent turn response is an unavailable service.
        turnClaimGuard = false
        return saidStream(SAY_UNAVAILABLE_LINE)
      }
      if (onboardingOn || ring?.answered() !== undefined) {
        /**
         * **问称呼那一轮,识别像没听准就请他打字**(2026-09-25,维护者:「为什么总是第一次听名字的时候听不清」)。
         * 判据在 nickname.ts;提示只补在这一次的副本上,不进对话历史。打字说的那一回合不判。
         */
        const doubt = onboardingOn && !turnTyped && awaitingNickname(onboardingBrief) ? nicknameDoubt(turnHeard) : undefined
        if (doubt === undefined) return await baseLlmNode(chatCtx, toolCtx, modelSettings)
        log(`[channel-worker] 称呼这句像没听准(${doubt}):让她请他在屏幕上打出来`)
        return await baseLlmNode(withNicknameDoubt(chatCtx, doubt), toolCtx, modelSettings)
      }
      const decision = await routing.settle()
      timing?.note({ route: decision.route, router: decision.router })
      log(`[channel-worker] ${describeDecision(decision)}`)
      /**
       * **「你已经应过一句了」那一行**(2026-09-23 下午,按意图先应)。
       *
       * 为什么不走提示词:`updateInstructions` 是异步的,而这一行**一个回合就过期** ——
       * 抢不赢回合提交(真机 `commit_ms` 5~40ms),也不该留到下一回合。
       * `llmNode` 拿到的 `chatCtx` 就是这一次要发出去的那一份,在它的**副本**上补一句是精确的;
       * 补在副本上,对话历史里不会多出一条(那是 `updateInstructions` 的老毛病)。
       */
      const acked = ackedWith === undefined ? chatCtx : withAckedTurn(chatCtx, ackedWith)
      /*
       * 2026-10-12(卡「通话补一句不丢事」):这一句是补进没办完的那件事的 / 接着刚办的那件事答的 ——
       * 补一行说清是哪件事(一个回合就过期,同「你已经应过一句了」那一行)。
       */
      const withAck = decision.followUp !== undefined
        ? withTurnNote(acked, followUpNote(decision.followUp))
        : decision.carriedFrom !== undefined ? withTurnNote(acked, carryNote(decision.carriedFrom)) : acked
      turnClaimGuard = deps.config.claimGuard && guardsTurn(decision)
      /**
       * ——— **人设按这一回合的意图裁**(2026-10-03,卡 ②,维护者拍板「做」)———
       *
       * 段与「哪些意图 / 哪件工具用得上」都是 8791 下发的(`persona.persona_sections`);
       * 这儿只把用不上的段摘掉,替在**这一次**那份上下文副本里整份人设那一段上面。
       * 为什么不走 `updateInstructions`:异步、抢不赢回合提交,而且会留到下一回合 ——
       * 与上面「你已经应过一句了」同一条道理。整段理由与退路在 personaTrim.ts 文件头。
       *
       * 认不出的形状(老工作台、或者下发的段拼不回整份)→ `personaForTurn` 回 `undefined`
       * = **整份照旧**,一个字都不裁。
       */
      const trimPersona = <T extends PersonaChatContext>(ctx: T, turn: PersonaTurn): T => {
        if (!deps.config.personaByIntent) return ctx
        const want = personaForTurn(persona.persona_sections, turn)
        if (want === undefined) return ctx
        timing?.note({ persona: [...want.text].length })
        if (want.dropped.length > 0) {
          log(`[channel-worker] 这一回合人设 ${[...want.text].length}/${[...persona.system_message].length} 字(没带:${want.dropped.join('、')})`)
        }
        return withTrimmedPersona(ctx, {
          full: persona.system_message,
          trimmed: want.text,
          replace: (like, text) => llmNs.ChatMessage.create({
            ...(typeof (like as { id?: unknown }).id === 'string' ? { id: (like as { id: string }).id } : {}),
            role: (like.role ?? 'system') as 'system',
            content: [text],
          }) as unknown as PersonaChatItem,
          log,
        })
      }
      /**
       * 闲聊回合零工具;**只有一个例外**(2026-09-23 晚):他这句话像道别,就只递挂断那一件 ——
       * 挂不挂仍由模型定。要办事的回合本来就带全套(其中也有这一件)。
       */
      const chatTools = END_ONLY !== undefined && offersEndCall(turnHeard) ? END_ONLY : NO_TOOLS
      if (decision.route === 'chat' && chatTools !== NO_TOOLS) log('[channel-worker] 这句像道别:闲聊回合只递挂断那一件工具')
      if (decision.route === 'chat') {
        timing?.note({ tools: chatTools === NO_TOOLS ? 0 : 1 })
        /*
         * 闲聊回合:**意图是空的**(分流判 chat 时压根不填 `intent`),手上也就挂断那一件 ——
         * 于是只剩必带段。卡上量的那个数就是这一份(约 1567 字 vs 整份 3159 字)。
         */
        /*
         * ★ 介绍模式(2026-10-13 夜,卡 V):这一句问她自己(分流给了 `intro`)、或这一通已经在介绍模式里 →
         * 这一回合带上【介绍自己】那一段(只多这一段,仍然零工具);她只按那份材料说。
         */
        const asksIntro = decision.intents?.includes(INTRO_INTENT) === true
        if (asksIntro && !introMode) log('[channel-worker] 进入介绍模式(这一通里接下来的闲聊回合都带【介绍自己】那份材料)')
        if (asksIntro) introMode = true
        const turn: PersonaTurn = { intents: [], tools: chatTools === NO_TOOLS ? [] : [TOOL_END_CALL] }
        const introTurn: PersonaTurn = introMode ? { ...turn, intents: [INTRO_INTENT] } : turn
        return await baseLlmNode(trimPersona(withAck, introTurn), chatTools, modelSettings)
      }
      // 要办事了:介绍模式到此为止(卡 V)。
      if (introMode) { log('[channel-worker] 退出介绍模式(这一句要办事)'); introMode = false }
      /*
       * 上下文包同源(A2,2026-10-28):要办事的回合带上 8791 现拼的那一份(与 /butler/say 同一个拼法),
       * 写板子的工具按卡号 / 目标 id 指,模型得看得见它们。取不到就不带(最多等 HUB_CONTEXT_TIMEOUT_MS)。
       */
      const hubNote = await hubContextNote(deps.workbench, turnHeard)
      const withHub = hubNote === undefined ? withAck : withTurnNote(withAck, hubNote)
      /**
       * ——— **要办事的回合只下发用得上的那几件工具**(2026-10-03,卡「首声提速」甲)———
       *
       * 对照表在 `intentTools.ts`(**只有那一处**);认不出意图就是 `undefined` = 全套
       * (卡上原话「分不出意图时退回全量(不许漏能力)」)。
       *
       * 挑的是**这一次真要发出去的那一份**(`toolCtx.functionTools`),不是我们记着的那一份:
       * 引导 / 来电那两种上面已经早返回了,但这条路将来要是又多一组工具,
       * 从实际的那一份里挑才不会把它悄悄吃掉。
       */
      const have = (toolCtx as unknown as { functionTools?: Record<string, unknown> }).functionTools
      const plan = planTurnTools({
        on: deps.config.toolsByIntent,
        ...(decision.intent === undefined ? {} : { intent: decision.intent }),
        /*
         * **这一句命中的全部意图**(2026-10-03,卡 fix/voice-route-zh;审计 voice.md 第 3 条)。
         * 有它就按并集挑 —— 「把文件发给我,再换个音色」交代了两件事,两件的工具都得在手上。
         */
        ...(decision.intents === undefined ? {} : { intents: decision.intents }),
        ...(have === undefined ? {} : { all: have }),
      })
      const intentNote = decision.intent === undefined ? {} : { intent: decision.intent }
      /** 这一回合的人设按什么裁:命中的意图 + **真送出去的那几件工具**(见 personaTrim.ts 文件头)。 */
      const actIntents = decision.intents ?? (decision.intent === undefined ? [] : [decision.intent])
      if (plan === undefined) {
        timing?.note({ ...intentNote, ...(have === undefined ? {} : { tools: Object.keys(have).length }) })
        // 全套工具的回合:讲工具的那几段一段都不少(手上真有那么多件),只有「文件」那类按意图算。
        const turn: PersonaTurn = { intents: actIntents, tools: Object.keys(have ?? {}) }
        return await baseLlmNode(trimPersona(withHub, turn), toolCtx, modelSettings)
      }
      timing?.note({ ...intentNote, tools: plan.names.length })
      log(`[channel-worker] 这一回合按意图「${decision.intent ?? '?'}」只递 ${plan.names.length}/${Object.keys(have ?? {}).length} 件工具:${plan.names.join('、')}`)
      /**
       * **人设里跟着只讲那几件**那一行(卡上原话)。补在**这一次**的上下文副本上 ——
       * 和「你已经应过一句了」同一条道理(一个回合就过期,见 intentTools.ts 的 `intentToolNote`)。
       *
       * **装回去一定要用数组那条路**。框架的 `ToolContext` 收对象时要求每一件是**匿名**的
       * (`normalizeToolContextInit`:`if ("name" in toolValue || "id" in toolValue) throw`),
       * 而我们挑出来的这几件是从 `toolCtx.functionTools` 来的 —— 它们早就被框架按键名
       * 落上了 `id` 与 `name`。拿对象去造就会抛「must be anonymous」,**每一个要办事的回合都炸**。
       * 收数组那条路原样接受已经有名字的那几件(用例 `intent-tools-1003` 里有一条真造一次钉着它)。
       */
      const narrowed = new llmNs.ToolContext(Object.values(plan.tools) as never) as unknown as ToolContext
      const trimmed = trimPersona(withHub, { intents: actIntents, tools: plan.names })
      return await baseLlmNode(withTurnNote(trimmed, intentToolNote(plan.names)), narrowed, modelSettings)
    }
    agent.llmNode = (chatCtx, toolCtx, modelSettings) => kickLlm(routedLlmNode(chatCtx, toolCtx, modelSettings))
    /**
     * 垫场那一层的另一半:这一段的音频先吐垫场那句的帧,**真声第一帧一到就不再吐**。
     * 文字流里那个空串在这儿滤掉(别让它当成「模型首字」进计时)。
     */
    if (workerFiller !== undefined) {
      const baseTtsNode = agent.ttsNode.bind(agent)
      const silenceSamples = Math.round(TTS_SAMPLE_RATE / 50)
      agent.ttsNode = async (text, modelSettings) => {
        const input = text instanceof ReadableStream ? dropEmptyText(text) : text
        const real = await baseTtsNode(input, modelSettings)
        if (real === null) return null
        return withFillerFrames(real, {
          filler: workerFiller,
          silence: () => new AudioFrame(new Int16Array(silenceSamples), TTS_SAMPLE_RATE, 1, silenceSamples),
        })
      }
    }

    /**
     * ——— 她知道自己是谁(2026-09-23,Ben 第四通真机问「你跑在哪个模型上、thinking 开没开」)———
     *
     * 平时那套提示词 = 人设 + **这一通电话开始时现拼的**那段「关于我自己」。
     * 拼什么、缺了怎么说,全在 selfBrief.ts(纯函数,有用例);这里只负责**去取真值**。
     *
     * 为什么每通电话现拼一次:音色、工作台版本、上一回合的延迟这几样在两通电话之间会变。
     * 为什么不在每一回合都拼:那要在每一轮对话前多等两条 HTTP,而这几样一通电话里基本不动。
     */
    function baseInstructions(): string {
      const base = selfBlock === undefined ? persona.system_message : `${persona.system_message}\n\n${selfBlock}`
      /**
       * 开场那一句**已经说过了**(2026-09-23,提机先问)。不写这一行的话,
       * 模型这一轮的第一句话十有八九是再问一遍「有什么吩咐」—— 他刚听完一模一样的那一句,
       * 只会以为她没听见自己。挂断时清掉(见 hangup),下一通不带着上一通的开场。
       */
      return withGreetedNote(base, openedWith)
    }

    /** 这一通是谁接的:按**此刻的接话对象**算(凭证里签的 `wb_kind`,房里改不动)。 */
    function answeredOn(): 'phone' | 'handset' | undefined {
      if (boundSpeaker === undefined) return undefined
      const participant = room.remoteParticipants.get(boundSpeaker)
      if (participant === undefined) return undefined
      return participantKindOf(participant) === 'handset' ? 'handset' : 'phone'
    }

    /**
     * 去取这一轮的实情。**每一格都自己兜住**:问不到就缺席(= 「这一项我没拿到」),
     * 一格失败不该把整段话弄没,更不该让她在电话里沉默。
     */
    async function collectSelfFacts(): Promise<SelfFacts> {
      if (workbenchVersion === undefined) {
        try { workbenchVersion = await deps.workbench.workbenchVersion() }
        catch { /* 问不到就让那一行写「没拿到」 */ }
      }
      /** 音色:配置里写死了就是它,没写就问 8792 此刻绑的那个(与 VoiceWatcher 同一条路)。 */
      let voice = deps.config.ttsVoiceId
      if (voice === undefined) {
        try { voice = await deps.workbench.butlerVoice() }
        catch { /* 同上 */ }
      }
      // 读的是**真交给模型的那个参数对象**;只读 thinking 那几个键 ——
      // apiKey 就在同一个对象里,看都不看,更不会进这段话。
      const thinking = thinkingOf(llmOptions as unknown as Record<string, unknown>)
      const on = answeredOn()
      return {
        llmModel: deps.config.llmModel,
        ...(deps.modelRoute === undefined ? {} : { llmRoute: deps.modelRoute }),
        llmBaseUrl: deps.config.llmBaseUrl,
        ...(thinking === undefined ? {} : { thinking }),
        // 实际用上的那一种(配的是流式、凭据没下来时会退回分段,见 asr/index.ts)。
        asr: asr.kind,
        ttsUrl: deps.config.butlerUrl,
        ttsScene: deps.config.ttsScene,
        ...(voice === undefined ? {} : { ttsVoice: voice }),
        ...(workbenchVersion === undefined ? {} : { workbenchVersion }),
        deviceName: deps.config.deviceName,
        ...(on === undefined ? {} : { answeredOn: on }),
        ...(lastTurn === undefined ? {} : { lastTurn }),
      }
    }

    /**
     * 现读这一通的接话模型配置(modelNow 缺席 = 老接线,只用启动那一份,什么都不做)。
     * 四样(接话模型 / 首声模型 / 地址 / Key)都没变就省一次重建;变了才换。
     *
     * **成功才提交**(2026-10-23 源审退修):先用候选视图建新 LLM 交给框架
     * (`applyCallModelRefresh` 里 await `agent.updateOptions`),**框架换上了才**把
     * llmOptions / firstVoiceClient 换成新的;没换上(框架回滚旧 LLM)本地保持旧 ——
     * 下一通 fresh 与旧状态依旧不同,会再次尝试,不会因为缓存先更新而永远跳过。
     */
    async function refreshCallModel(): Promise<void> {
      if (deps.modelNow === undefined) return
      const fresh = await deps.modelNow()
      if (fresh === undefined) return
      const current = {
        llmModel: llmOptions.model,
        firstVoiceModel: llmOptions.firstVoiceModel,
        llmBaseUrl: llmOptions.baseURL ?? '',
        key: llmOptions.apiKey,
        source: deps.modelRoute ?? ('own' as const),
      }
      const applied = await applyCallModelRefresh(current, fresh, async (next) => {
        try {
          /**
           * 框架给**运行中**会话换 LLM 的原生口子(`agent.updateOptions({ llm })`,
           * 上游 agent_activity:解绑旧事件 → 绑新 → 失败 rollback;普通 LLM 互换运行中允许,
           * 换 RealtimeModel 才要求停)。与 09-18 那个坑不同:那次换的是整个 Agent,
           * 这里只递 llm,activity 不重建。
           */
          await agent.updateOptions({ llm: buildLlm(llmViewOf(next)) })
          return true
        }
        catch (err) {
          log(`[channel-worker] 模型读到了但换不上(updateOptions 没成),这一通沿用上一份:${(err as Error)?.message ?? '没说原因'}`)
          return false
        }
      })
      if (applied === undefined) return
      llmOptions = {
        ...llmOptions,
        model: applied.llmModel,
        firstVoiceModel: applied.firstVoiceModel,
        apiKey: applied.key ?? '',
        baseURL: applied.llmBaseUrl,
      }
      firstVoiceClient = buildFirstVoiceClient(llmViewOf(applied))
      log(`[channel-worker] 这一通的接话模型:${applied.llmModel}(${applied.source},${applied.llmBaseUrl})`)
    }

    /**
     * 一通电话开始了:现拼一份「关于我自己」。**不抛、不挡路** ——
     * 拼不出来就沿用上一份(或者干脆没有),她照常说话,只是被问到时答得不全。
     */
    async function refreshSelfBrief(): Promise<void> {
      /*
       * 新的一通:上一通最后那句问话作废(2026-10-02)。工人是**常驻**的,
       * 这一格不清掉的话,上一通结尾挂着的那个问号会让新一通的第一句走回 act ——
       * 行为仍然安全(那是这一版之前的样子),但白丢一次快路。
       */
      lastButlerLine = ''
      // 上一通没办完的那件事也忘掉:下一通的第一句不许并进去(2026-10-12)。
      routing.forget()
      /*
       * 2026-10-13(卡「三个入口一套管线」):固定流程那几格也跟着这一通清。
       *   · 挂着的那一句确认:上一通没答完的「对吗?」不许被下一通的「对」当成点头;
       *   · 刚开始的那件事:下一通的短话不许并进上一通那一件;
       *   · 兜底句换过哪几类:一通不重复,下一通重新算。
       */
      pendingConfirm = undefined
      openThing = undefined
      turnUnderstanding = undefined
      rewroteKinds.clear()
      // 介绍模式按通算(卡 V):挂了就退出。
      introMode = false
      // 道别那一句也按通算(2026-10-13 下午):上一通道过别,不影响这一通。
      farewellSaid = false
      turnFarewell = undefined
      /**
       * ★ **认得出哪几家也跟着这一通现取**(2026-10-03,卡 C;审计材料 2026-10-03 附证 C)。
       *
       * 从前只在 `main.ts` 进房前拉一次 —— 而那个循环**一圈是一次进房,不是一通电话**:
       * 工人常驻在房里,她启动之后才装上的那一家(登记表里运行时发现的 Grok Bot /
       * Antigravity)要等断房重连才认得出,而她在电话里点名派活走的正是工人这一池。
       *
       * 和这一函数里别的几样一样:**自己兜住、互不挡路**,一条 HTTP,排在开场白之后 ——
       * 首声那条路一点都没碰。处置与那一行措辞在 `applyFamilyPool`(有用例)。
       */
      try { log(applyFamilyPool(await deps.workbench.families())) }
      catch (err) { log(`[channel-worker] 这一通的「有哪几家」没换上,沿用上一份:${(err as Error)?.message ?? '没说原因'}`) }
      // (接话模型的每通刷新不在这儿:它在 greet/来电首句投递之前单独 await,
      //  不被 families/persona 这些无关网络 gate —— 见 refreshCallModel 的调用点。)
      try { persona = await deps.workbench.persona() }
      catch (err) { log(`[channel-worker] 这一通的人设没现取到,沿用上一份:${(err as Error)?.message ?? '没说原因'}`) }
      // 热词跟着这一份人设换(2026-10-02)。
      try { syncAsrHotwords() }
      catch (err) { log(`[channel-worker] 这一通的识别热词没换上:${(err as Error)?.message ?? '没说原因'}`) }
      try { selfBlock = describeSelf(await collectSelfFacts()) }
      catch (err) { log(`[channel-worker] 这一通的「关于我自己」没拼出来:${(err as Error)?.message ?? '没说原因'}`) }
    }

    await session.start({
      agent,
      room,
      inputOptions: {
        /**
         * **工人是常驻的,挂断一通电话不该把它的会话关掉。**
         *
         * 框架默认 `closeOnDisconnect: true`:接话对象一离开房间(手机挂断就是 CLIENT_INITIATED),
         * 整条 AgentSession 就关了。原型里工人是一通电话起一次,关了正好;现在它一直在房里,
         * 关了就等于「第一台手机走了之后,后面谁进来都没人接话」—— 2026-09-17 实测踩到过:
         * 第一台假手机离开后,第二台放了一整段录音,一个字都没转写。
         */
        closeOnDisconnect: false,
      },
    })

    /**
     * ——— 引导模式(2026-09-18,Ben:「引导部分的 UI……不是通话模式吗」) ———
     *
     * 手机进房后在 `wb.rpc` 上说一句「我在做引导」,这里就把系统提示换成
     * 「引导技能 + 当前阶段要问什么 + 值的形状」,并多给一件 `record_answer`。
     * **种子句(开场白)由工人立刻说出来,不等模型** —— 那正是十秒变一秒半的地方。
     * 挂断(或手机离开房间)就换回平时那套人设:引导是暂停,不是结束,进度在 onboarding.json 里。
     */
    /**
     * 让她**当场说一句**,不经模型(2026-09-20)。现在只剩一处用:
     * 「先说后记」真没记上时补的那句实话(「刚才那条我没记上」)。
     *
     * **缓冲语与「我看一下你的仓库」这两处 09-20 第二版搬走了** —— 它们是定死的几句话,
     * 每轮走一次火山既慢又花钱,而且排在同一条发言队列里注定迟到(filler.ts 头注释)。
     * 剩下这一句留在这儿的理由正相反:它**不是定死的垫场话,是一条更正**,
     * 内容跟着那一次失败走,而且必须让所有听得见的人都听见,不能只在手机上响。
     *
     * `allowInterruptions: true` —— 他这会儿开口就该把它掐掉;
     * `addToChatCtx: false` —— **不进对话历史**:模型不该以为自己已经答过什么。
     */
    const sayAside = (text: string): void => {
      try { session?.say(text, { allowInterruptions: true, addToChatCtx: false }) }
      catch (err) { log(`[channel-worker] 这一句没说出去:${(err as Error)?.message ?? '没说原因'}`) }
    }

    const onboardingTools = createOnboardingTools({
      workbench: deps.workbench,
      brief: () => onboardingBrief,
      log,
      say: sayAside,
      onStart: onToolStart,
      heard: () => dialogueTail.heard(),
      // 阶段推进了就重新取一份简报、换掉系统提示。下一句问什么由工具的回话先顶上(见 answerResultText),
      // 所以这里不必抢在模型前面说话——两个声音一起说才是最糟的。
      onAnswered: ({ advanced }) => { if (advanced) void refreshOnboarding() },
    })

    /** 换成引导那套:提示词按当前阶段拼,工具多一件 `record_answer`。 */
    async function wearOnboarding(brief: OnboardingBrief): Promise<void> {
      // 问称呼那一段带上识别上下文,记下称呼之后下一次换提示词就撤(nickname.ts)。
      syncNicknameAsrContext()
      await agent.updateInstructions(buildOnboardingInstructions({
        brief,
        ...(persona.style === undefined ? {} : { style: persona.style }),
        ...(persona.butler_name === undefined ? {} : { butlerName: persona.butler_name }),
      }))
      await agent.updateTools({ ...channelTools, ...onboardingTools })
    }

    /** 取一份简报。取不到就回一句能说出口的话(**不猜一个阶段出来问人**)。 */
    async function fetchBrief(): Promise<{ ok: true, brief: OnboardingBrief } | { ok: false, error: string }> {
      let result: { status: number, body: unknown }
      try { result = await deps.workbench.onboardingBrief() }
      catch { return { ok: false, error: '工作台连不上,引导接不上' } }
      if (result.status === 404) return { ok: false, error: '这台工作台没接引导(没配记忆仓库)' }
      if (result.status !== 200) {
        const error = (result.body as { error?: unknown } | null)?.error
        return { ok: false, error: typeof error === 'string' ? error : `工作台回了 ${result.status}` }
      }
      const brief = parseOnboardingBrief(result.body)
      return brief === undefined ? { ok: false, error: '引导简报的形状不对' } : { ok: true, brief }
    }

    /**
     * 引导做完、落地单子还等他点头(2026-09-24 晚,卡 feat/onboarding-materialize):提示词换成「只等他对单子点头」,
     * 工具留着引导那一组(setup_preview / setup_apply 在里面)—— 他在电话里说「可以」就能直接落。
     */
    async function wearSetup(brief: OnboardingBrief): Promise<void> {
      await agent.updateInstructions(buildSetupInstructions({
        brief,
        ...(persona.style === undefined ? {} : { style: persona.style }),
        ...(persona.butler_name === undefined ? {} : { butlerName: persona.butler_name }),
      }))
      await agent.updateTools({ ...channelTools, ...onboardingTools })
    }

    async function refreshOnboarding(): Promise<void> {
      if (!onboardingOn) return
      const got = await fetchBrief()
      if (!got.ok) { log(`[channel-worker] 引导简报刷新失败:${got.error}`); return }
      onboardingBrief = got.brief
      if (got.brief.done) {
        if (got.brief.setup?.pending === true) {
          await wearSetup(got.brief)
          log('[channel-worker] 引导记完了;落地单子等他点头,留着 setup_apply。')
          return
        }
        log('[channel-worker] 引导做完了,换回平时那套人设。')
        await stopOnboarding()
        return
      }
      await wearOnboarding(got.brief)
      log(`[channel-worker] 引导到「${got.brief.label}」,提示词换过了。`)
    }

    /**
     * 引导那套提示词**正在后台换**(2026-09-24:begin 先回话、再换,见 {@link beginOnboardingCall})。
     * 落定为 true = 换上了;不抛。停引导、打字那一句都排在它后面 —— 不然后到的那一下会把平时那套盖回去,
     * 或者他打的那句落在平时那套人设上。
     */
    let onboardingWearing: Promise<boolean> | undefined

    /** 换回平时那套人设与工具。 */
    async function wearBase(): Promise<void> {
      await agent.updateInstructions(baseInstructions())
      await agent.updateTools(channelTools)
    }

    async function stopOnboarding(): Promise<void> {
      if (!onboardingOn) return
      onboardingOn = false
      onboardingBrief = undefined
      // 引导这一通完了:不在通话里就不听(收音闸,listenGate.ts)。
      syncListen('引导停了')
      syncNicknameAsrContext()
      // 后台还在换引导那套:等它落定再换回来(先后反了,挂断之后留着的就是引导那套)。
      if (onboardingWearing !== undefined) await onboardingWearing
      await wearBase()
      log('[channel-worker] 引导暂停(挂断或手机离开),回到平时那套人设。')
    }

    onboarding = {
      /**
       * **先回话,换提示词在后台接着做**(2026-09-24,卡 `fix/onboarding-call-same-as-call`)。
       * 手机拿到这一条的回话才算接通;回话以前排在换提示词后面,于是引导那通比平时电话接通得晚,
       * 她开口时手机上可能还是「正在接通…」。顺序与四条正确性(开场白只说一次、续接排在换完之后、
       * 换失败有日志有人话、归电脑管不开口)钉在 {@link beginOnboardingCall},这里只接线。
       */
      async begin(_resume, by) {
        const begun = await beginOnboardingCall({
          fetchBrief,
          open: (brief) => {
            /**
             * **谁打的这一通引导,就听谁**(2026-09-25):与 greet / answer 同一条。09-24 晚房里先有一个测试页,
             * 接话对象一直钉在它身上(pickSpeaker「现任还在就不换」),后进来的小米打引导,声音没人听。
             */
            if (by !== undefined) bindSpeaker(by.identity)
            onboardingBrief = brief
            onboardingOn = true
            syncNicknameAsrContext()
            farewell?.reset()
            listenAgain('引导开始')
            syncListen('引导开始')
            /**
             * 「从现在起引导在手机上做」。**发出去就不等**:这一笔只影响电脑那一屏长什么样,
             * 让开场白为它多等一个来回是本末倒置(那 0.3 秒正是这张卡前一版拼命省下来的)。
             */
            void deps.workbench.onboardingLeader('phone')
              .catch(() => log('[channel-worker] 「引导归手机」没记上,电脑那一屏可能还出着输入框'))
          },
          speakSeed: (seed, stage) => {
            /**
             * **先开口,再换提示词**(2026-09-18 实测的顺序,别调换):
             * 排在换提示词后面的 `say()` 要等那一下落定才出声 —— 开场白就又慢回去了。
             * 开场白是**定死的一句话**,不需要新提示词也说得出来,所以让它先走。
             *
             * 字幕由 TTS 的 onSpeech 在这一句真的要出声那一刻推出去(见上面 ButlerTts)。
             * 「说过了」马上落盘(不等说完 —— 说到一半掉线也算说过,再进来重念一遍比漏念更糟)。
             */
            /**
             * **引导开场不用预合成音频**(2026-09-24 维护者真机 0.2.78:「语音听不到」)。
             * 直接发帧的那一句一出口,紧跟着的换提示词会把正在播的这一句截掉,手机上一个字都没有。
             * 现合成时出声晚于换完,所以一直没事。(09-24 起换提示词挪到回话之后的后台,
             * 但仍是开口之后当场就开始换,与这一条的时序一样。)
             * 那条「接通到出声 17 秒」的卡本来就量错了(那是整句念完的时长),退回现合成不会变慢。
             */
            /**
             * **第一小句不可打断,立刻出声**(2026-09-27,卡 fix/voice-onboarding-latency)。
             * 09-27 现场 34 秒才出声,账在 `publish_ms: 33291`:音频 0.7 秒就合好了,
             * 框架在发第一帧之前把播出**暂停**了 —— 免提摆在房间里,VAD 一直听见声音,
             * 那道「误判打断」的暂停就一直不放(条件之一正是「这一句允许被打断」)。
             * 切法与理由在 onboarding.ts 的 {@link openingPieces} / {@link speakOpeningLine}。
             */
            log('[channel-worker] 引导开场:现合成,第一小句不可打断(它不等模型、也不许被「用户在说话」按住)')
            speakOpeningLine(seed, (piece, options) => {
              firstTextSource = '固定开场白'
              // 出声之后翻成可打断(兄弟路同一处,见 openerCutIn):引导里她抢着答第一句也不丢字。
              try { openerCutIn.track(session?.say(piece, options), '固定开场白') }
              catch (err) { log(`[channel-worker] 开场白没说出去:${(err as Error)?.message ?? '没说原因'}`) }
            })
            void deps.workbench.onboardingSeedSpoken(stage)
              .catch(() => log('[channel-worker] 「种子句说过了」没记上,下次可能会重说一遍'))
          },
          wear: wearOnboarding,
          stillOn: () => onboardingOn,
          resumeReply: () => {
            // 接着做:不重说种子句(0.2.30 起的规矩);2026-09-24 起也不问「上次到哪」,直接只问还没答的那一题。
            // 这一句要新提示词(它得知道做到哪),所以由 beginOnboardingCall 排在换完之后。
            try {
              session?.generateReply({ instructions: ONBOARDING_RESUME_INSTRUCTION })
            }
            catch (err) { log(`[channel-worker] 接着引导那句没说出去:${(err as Error)?.message ?? '没说原因'}`) }
          },
          wearFailed: async () => {
            // 手机早就算接通了,回话里已经带不回这件事:她当场说一句实话(字幕同出),换回平时那套,不装作还在引导。
            sayAside(ONBOARDING_WEAR_FAILED_LINE)
            onboardingOn = false
            onboardingBrief = undefined
            syncListen('引导没接好')
            syncNicknameAsrContext()
            try { await wearBase() }
            catch (err) { log(`[channel-worker] 换回平时那套也没成:${(err as Error)?.message ?? '没说原因'}`) }
          },
          log,
        }, onboardingWearing)
        const wearing = begun.wearing
        if (wearing !== undefined) {
          onboardingWearing = wearing
          void wearing.then(() => { if (onboardingWearing === wearing) onboardingWearing = undefined })
        }
        return begun.reply
      },

      async say(text) {
        const trimmed = text.trim()
        if (trimmed === '') return { ok: false, error: '这句话是空的' }
        if (!onboardingOn) return { ok: false, error: '引导还没开始,这句话没送进去' }
        // 引导那套还在后台换(begin 先回了话):等它落定再交给模型,不然这句落在平时那套人设上。
        if (onboardingWearing !== undefined && !(await onboardingWearing)) return { ok: false, error: ONBOARDING_WEAR_FAILED_REPLY }
        if (!onboardingOn) return { ok: false, error: '引导已经停了,这句话没送进去' }
        // 打字备胎:当成他说的话喂给模型,答案照旧经 record_answer 落到 onboarding.json。
        caption('me', trimmed, true)
        turnTyped = true
        try { session?.generateReply({ userInput: trimmed }) }
        catch (err) { return { ok: false, error: (err as Error)?.message ?? '这句话没送进去' } }
        return { ok: true }
      },

      stop: stopOnboarding,
    }

    /**
     * 谁在跟她说话(2026-09-17)。框架只在 `init()` 里挑**一次**接话对象并把麦克风接上去,
     * 之后那位走了、新的进来了,**麦克风不会自己跟过去**。2026-09-17 实测的两个症状:
     * 第一台手机离开后会话直接关了(上面那个 closeOnDisconnect);把它关掉之后,第二台手机
     * 放了一整段录音还是一个字都没转写 —— 因为 `audioInput` 只在 `setParticipant()` 里换,
     * 而框架在那之后再没调过它(它内部的 `onParticipantConnected` 只把「有人了」那个信号重置了)。
     *
     * 所以这里**自己记住绑的是谁**,不去问框架(问它会得到「已经有人了」而其实音频没接上)。
     *
     * 声音这条链**一次只服务一个人** —— 一个房间里两台手机同时说话,声音会糊在一起,
     * 没有哪种自动仲裁是对的。控制那条链(wb.rpc)不受影响:它按参与者隔离,谁问的谁收。
     */
    let boundSpeaker: string | undefined
    // 「发到我手机上」的那台 = 接话对象(2026-09-25,卡 J)。
    callerOf = () => boundSpeaker
    const relinkSpeaker = (): void => {
      const roomIO = session?._roomIO
      if (roomIO === undefined) return
      /**
       * **别的电脑上的工人不算「说话的人」**(2026-09-21,两台电脑同房那一遍跑出来的第三件事)。
       *
       * 以前这里的兜底是「房里第一个人」。第二台电脑进房之后,手机一挂断,兜底就把
       * **另一个工人**选成了接话对象 —— 于是下一台手机进来时「现任还在房里」成立,
       * 它的声音一直没被接上,引导也跟着乱。工人不是人,不该出现在这份候选里。
       */
      const identities = [...room.remoteParticipants.keys()].filter(id => !id.startsWith(WORKER_IDENTITY))
      /**
       * 挑法在 rpc.ts 的 {@link pickSpeaker} 里(纯函数,有用例钉着)。三句话:
       * 现任还在就不换;有树莓派话筒(`kind: 'handset'`)就跟话筒走;没有才跟手机走。
       *
       * 种类从**参与者属性**里读(`wb_kind`,由 8791 签进凭证、房里改不动)——
       * 与 `wb_device_id` 同一道门,理由见 workbench-plugin/src/server/channel.ts。
       */
      const next = pickSpeaker(
        identities,
        id => participantKindOf(room.remoteParticipants.get(id) ?? {}),
        boundSpeaker,
      )
      if (next === boundSpeaker) return
      // A replacement audio device does not inherit the departed caller's Say lifecycle.
      if (boundSpeaker !== undefined && next !== undefined && !room.remoteParticipants.has(boundSpeaker)) {
        invalidateSay()
      }
      boundSpeaker = next
      if (next === undefined) {
        roomIO.setParticipant(null)
        log('[channel-worker] 房里没人了,先不接话。')
        /**
         * **手机走了 = 这通电话挂了**(2026-09-21,本机真跑当场踩到)。
         *
         * 挂断本该由手机发一条 `{type:'call',action:'hangup'}`,但它可能**没机会发**:
         * App 被杀、断网、电池没了,甚至只是假手机跑完退出。不在这儿补一刀的话,
         * 振铃状态机会一直以为「还在通话中」,于是**下一通电话永远排在队列里不响**
         * —— 本机那一遍的台账上就留着一条卡在 `ringing` 的记录,而手机上一声都没响过。
         * 那正是这类状态机最坏的失真:界面说在响,事实是没有。
         *
         * `'worker'`(2026-09-22):这一刀是工人自己补的,所以照样广播一条 `hung_up`。
         * 走到这儿时房里通常已经没人听了 —— **但一条如实的广播不该看有没有人听才发**,
         * 而且「话筒掉线」这一种正是房里还剩着手机的那条边:掉线的是听筒,
         * relinkSpeaker 会改跟手机走,这一支不触发,手机那一面由话筒的挂机信号收。
         */
        farewell?.reset()
        listenAgain('房里没人了')
        ring?.hangup('worker')
        // 拨出那一通没有 `live`、`ring.hangup` 一个字不发,这条统一信号才是手机收掉那一面的依据。
        invalidateSay()
        callState?.leave('worker')
        /**
         * 人走了,这一通的纪要也该交了(2026-09-23)。**和挂断走同一条路** ——
         * 「他按挂断」与「手机/话筒没声没响地走了」对纪要来说是同一件事:电话结束了。
         * 攒到一半的那几句交上去,比因为没收到一条 hangup 就整份丢掉好。
         */
        callRecord.finish()
        announceHoldStop()
        void restoreAfterRing?.()
        // 引导中的人走了(挂断没来得及说一声、App 被杀、断网)也要暂停:
        // 下一个进来的人不该掉进别人的引导里。进度在 onboarding.json,接着做就是了。
        void stopOnboarding()
        syncListen('房里没人了')
        return
      }
      roomIO.setParticipant(next)
      const kind = participantKindOf(room.remoteParticipants.get(next) ?? {})
      // 种类要进日志:「他拿起了听筒,而她在听手机」这类毛病只有这一行分得开。
      log(`[channel-worker] 接话对象换成 ${next}(${kind === 'handset' ? '树莓派话筒' : '手机'})`)
      syncListen(`接话对象换成 ${next}`)
    }
    /**
     * **谁接的电话,就跟谁说话**(2026-09-22 晚,Ben:「响铃应该是手机发出,
     * 而不是话筒,话筒自己是用来对话的」)。
     *
     * `pickSpeaker` 那三条挑的是「平时跟谁走」:有听筒就跟听筒。那条规矩对**平时**是对的,
     * 但一通电话被**手机**接起来的时候它就错了 —— 他在手机上按了「接起」,对着手机说话,
     * 而她还在听那只挂在叉簧上的听筒。反过来那一半正是 Ben 20:50 在真机上遇到的:
     * 听筒接起来了,她的声音却从手机里出来。
     *
     * 所以接起那一刻**明着钉一次**:把 `boundSpeaker` 设成接电话那一台。
     * 钉完之后 `pickSpeaker` 的第 ① 条(现任还在就不换)会一直守着它,
     * 直到那一台离开房间 —— 也就是说这一刀只在「谁接的」这件事上用一次,
     * 剩下的时间还是那三条老规矩说了算。
     */
    const bindSpeaker = (identity: string): void => {
      const roomIO = session?._roomIO
      if (roomIO === undefined) return
      // 房里根本没这一位(消息比 ParticipantConnected 先到)就不钉:
      // 钉一个不在房里的身份等于把麦克风接到空气上,而下一次 relinkSpeaker 也修不回来。
      if (!room.remoteParticipants.has(identity)) {
        log(`[channel-worker] 接电话的是 ${identity},但它这会儿不在房里,接话对象没动`)
        return
      }
      if (identity === boundSpeaker) return
      boundSpeaker = identity
      roomIO.setParticipant(identity)
      const kind = participantKindOf(room.remoteParticipants.get(identity) ?? {})
      log(`[channel-worker] 这一通归 ${identity}(${kind === 'handset' ? '树莓派话筒' : '手机'})说话`)
      syncListen(`这一通归 ${identity}`)
    }
    /**
     * ——— 收音闸(2026-09-25,卡 fix/evening-gaps 第 1 条:隐私 + 计费)———
     *
     * **不在通话里,一个字都不听**:不订任何人的麦克风、框架那一路收音关着、火山连接当场断。
     * 在通话里(普通来去电、引导那一通 —— 与通话护栏同一个 `inCall` 口径)只订接话对象的麦克风。
     * 为什么、闸怎么开关,见 listenGate.ts 文件头。开关变了会记一行「收音开了 / 收音关了」。
     */
    const listenGate = new ListenGate({
      participants: () => room.remoteParticipants.values(),
      isMic: publication => (publication as { kind?: unknown }).kind === TrackKind.KIND_AUDIO,
      setAudioEnabled: (on) => { session?.input.setAudioEnabled(on) },
      ...(asr.quiet === undefined ? {} : { quietAsr: asr.quiet }),
      log,
    })
    syncListen = (why: string): void => {
      listenGate.sync({ listen: (callState?.current() !== undefined || onboardingOn) && !mutedAfterBye, speaker: boundSpeaker }, why)
    }
    // 房里新发了一条轨道(手机接通之后才开麦):按此刻的闸订或不订。订上之后再对一遍(防 SDK 的时序)。
    room.on(RoomEvent.TrackPublished, () => { listenGate.reconcile() })
    room.on(RoomEvent.TrackSubscribed, () => { listenGate.reconcile() })
    room.on(RoomEvent.ParticipantConnected, relinkSpeaker)
    room.on(RoomEvent.ParticipantDisconnected, relinkSpeaker)
    // 工人可能比手机后进房:进来时房里已经有人了,补一次。
    relinkSpeaker()
    // 工人刚进房:不在通话里 —— 收音关着,房里挂着的麦克风(旧包挂断只静音)一条都不订。
    syncListen('工人进房')
    /**
     * 字幕(2026-09-17;2026-09-18 改了她那一边)。两边各一条:
     *   - 他说的:ASR 的中间结果 final=false、最终结果 final=true(舞台页上面那一行);
     *   - 她说的:**在那一句真的要出声的那一刻**推(下面那一行)—— 见上面 ButlerTts 的 onSpeech。
     * 走的是我们自己的 `wb.rpc`,不是框架的 TranscriptionReceived —— 手机只需要认一条通道。
     *
     * 她那一边为什么不再接 `ConversationItemAdded`(2026-09-18):那个事件在**整段**生成完时才来,
     * 而声音是按句合成、按句播的。接它就会出现 Ben 看到的那个毛病:字先整段冒出来,
     * 闪一下,过一会儿才开始有声音。
     */
    /**
     * 他开口/停口。**只为计时**(2026-09-23):框架把 user_state 落回 `listening` 那一刻
     * 就是 VAD 判停 —— 一回合的起点。别的什么都不做。
     */
    if (timing !== undefined) {
      session.on(AgentSessionEventTypes.UserStateChanged, (event) => {
        if (event.newState === 'listening') timing.mark('user_end')
      })
    }
    // 等着挂的时候他开口了:先别挂,等他这句的识别结果(是噪声就到点照挂,是话就不挂)。
    session.on(AgentSessionEventTypes.UserStateChanged, (event) => {
      /*
       * ★ **她一开口,来电开场那一句就不再重复**(2026-10-13 下午)。认的是 **VAD 判到人声**,
       * **不等 ASR 出字**:11:40 那一通她那 1.2 秒的话一个字都没识别出来(开场白按住了麦克风那一路,
       * 见 tts/openerRepeat.ts ③),等 `hearFinalText` 的话第二遍照样会接上去。
       * 顺手把开场那一句翻成可打断(掐不掐照旧由 bargeIn.ts 判)。
       */
      if (event.newState === 'speaking') ringOpenerRun?.sheSpoke('VAD 判到人声')
      farewell?.userSpeaking(event.newState === 'speaking')
      // 他正说着话,挂着的那件事不插进去(2026-10-13 下午,卡 A 第 4 条)。
      announceHold?.heSpeaking(event.newState === 'speaking')
      // 他说得久了插一声「嗯」(2026-10-02)。**他一停口这一条当场把计时器撤掉**。
      backchannel.userSpeaking(event.newState === 'speaking')
      // 打断那道闸也看这一下(2026-10-03):她手上有话而他开口 → 挂那只兜底的手。
      bargeIn?.userSpeaking(event.newState === 'speaking')
    })
    /**
     * ——— 他这一回合说定了的那句话,从这里进回合 ———
     *
     * 2026-09-27(卡 TT)把它从 `UserInputTranscribed` 的回调里**原样提**成一个有名字的函数:
     * 一个字都没改,只是让「文字当成他说的话」那个测试口能走**同一条**路(textTurn.ts 的
     * {@link deliverTextTurn})。真通话与测试口的差别从此只有一处 —— 这段字是识别出来的,
     * 还是统筹敲进来的;这之后的分流、先应、日志、farewell、回合提交全是同一份代码。
     */
    /**
     * 回合提交那一刻把定下的先应那一句说出去(2026-10-12,理由在 `plannedAck` 那一格)。
     * 分流可能还没判回来(Jev 要一次 HTTP):等它,最多 `ROUTE_BUDGET_MS` —— llmNode 本来也要等这一下。
     * 他又说了新的一句(轮号对不上)就不说了。
     */
    async function sayPlannedAck(): Promise<void> {
      if (onboardingOn || ring?.answered() !== undefined) return
      const seq = routing.seq
      ackCommittedSeq = seq
      await routing.settle()
      const external = turnSay?.seq === seq ? turnSay : undefined
      if (external !== undefined && await sayPendingAckDue(external.pending)) {
        if (turnSay === external && external.taken !== true && routing.seq === seq) {
          const speech = openerSpeech(greetings, SAY_PENDING_ACK_LINE, { leadSilenceMs: 0 })
          if (speech.cached && external.generation === sayGeneration && canSayPendingAck(turnBudget, persona.max_sentences)) {
            ackedWith = speech.text
            ackedSeq = seq
            turnBudget.charge(speech.text, persona.max_sentences)
            speakAck(speech)
            log(`[channel-worker] /butler/say 还在处理：本地先应「${speech.text}」`)
          }
        }
      }
      /*
       * ★ **走固定流程的那一回合一个字都不先应**(2026-10-13,卡「三个入口一套管线」):
       * 那一句话 0 毫秒就有、而且说的是真发生的事,再垫一句「好,我去安排」只是两句说一件事。
       * 这一等就是 `UNDERSTAND_BUDGET_MS`(本机那一跳几毫秒),而先应本来也要等判定这一下。
       */
      if (await thisTurnIsHandled()) {
        plannedAck = undefined
        ackedWith = undefined
        ackedSeq = undefined
        return
      }
      const planned = plannedAck
      if (planned === undefined || planned.seq !== seq || routing.seq !== seq) return
      plannedAck = undefined
      speakAck(planned.speech)
    }
    /** 先应那一句真说出去。 */
    function speakAck(speech: ReturnType<typeof openerSpeech>): void {
      try {
        firstTextSource = '先应那一句'
        session?.say(speech.text, ...(speech.audio === undefined ? [] : [{ audio: speech.audio }]))
      }
      catch (err) {
        log(`[channel-worker] 先应那一句没说出去:${(err as Error)?.message ?? '没说原因'}`)
      }
    }
    /** 回合提交走到了哪一回合(先应那一句晚判出来时,据此当场说,不再等一个不会来的提交)。 */
    let ackCommittedSeq: number | undefined

    function hearFinalText(transcript: string, options: { typed?: boolean } = {}): void {
      sayGeneration += 1
      cancelSayRequest()
      timing?.mark('stt_final')
      /**
       * **他说的那句话也要进日志**(2026-09-20;2026-09-23 改成所有识别路径都打)。
       *
       * 「本」被记成「Java」那天,日志里只有她说的话和 `record_answer → 200` ——
       * 想查「到底是 ASR 听岔了,还是模型自己编了一个」时,**证据整个不存在**。
       *
       * 09-20 那一版只在引导里记,理由是「平时通话的内容是他的私事」。09-23 第四通真机
       * 推翻了它:整份日志里**一行「他说」都没有**,于是「她的回复我不是很满意」这句
       * 只能靠她那一半去猜他说了什么。Ben 拍板照记(决策记录同日,可推翻)。
       * 分寸没变:**只记 final、只记前 120 字**,不记中间结果、不记整段。
       */
      const line = heardLogLine(transcript)
      if (line !== undefined) log(line)
      // 她说定了一句:来电开场那句「再说一遍」不说了(2026-10-13;VAD 那一下已经撤过一次,这里兜底)。
      ringOpenerRun?.sheSpoke('识别出字')
      // 等着挂的时候他又说了话 → 不挂了(farewell.ts)。先于 turnHeard 更新:这句是新的一回合。
      farewell?.heard(transcript)
      // 他问「有什么事」就当场提一件挂着的(别的只是把空闲计时撤掉,announceHold.ts)。
      announceHold?.heSaid(transcript)
      const said = transcript.trim()
      if (said !== '') {
        turnHeard = heardFresh ? said : `${turnHeard}${said}`
        heardFresh = false
        turnTyped = false
      }
      /**
       * 引导模式用本地 router 选择对话工具；普通电话模式不再做第二次意图判断，
       * 而是在下方把 ASR final 交给 `/butler/say`。这两种路径都先重置本轮语音预算。
       */
      // 每轮几句的预算也重来(卡 K,sentenceCap.ts)。
      turnBudget.reset()
      // 「这一回合有没有一件工具办成」也重来(claimGuard.ts)。
      turnToolOk = false
      turnToolFailed = undefined
      turnToolReports.clear()
      plannedAck = undefined
      /*
       * 引导流程的 `pendingAsk`:上一句是否留着话头(见 turnRoute.ts 的 `butlerLeftOpen`)。
       */
      // 介绍模式(卡 Z):这一通里她问过自己,接着问她自己的话走闲聊 + 知识库,不被动作词拽去办事路。
      const started = onboardingOn
        ? routing.start(transcript, { pendingAsk: butlerLeftOpen(lastButlerLine), ...(introMode ? { introMode: true } : {}) })
        : routing.startExternal()
      /**
       * ★ **道别那一回合到这儿就判完**(2026-10-13 晚,卡 K;整段理由在 `turnFarewell` 那一格)。
       *
       * 判完才问得起「这一问要不要问」:8791 对一句道别回的是 `none/normal`(帮不上),
       * 而那一问一发出去,`thisTurnIsHandled()` 就得等它回来、回来又是「交给模型」——
       * 先应与垫场两道闸双双放行,固定那句「好,拜拜。」比垫的「嗯,我想一下。」还晚出声。
       *
       * 判据与 `routedLlmNode` 里那一道是**同一个** `farewellFixedSay`(≤12 字那道门)。
       */
      turnFarewell = undefined
      const turnBye = onboardingOn ? undefined : farewellFixedSay(turnHeard)
      if (turnBye !== undefined) {
        turnFarewell = { seq: started.seq, say: turnBye }
        // 这一回合没有「听懂」那一问,上一回合那一份也不许被当成这一回合的(`settleUnderstanding` 按回合号认)。
        turnUnderstanding = undefined
        log(`[channel-worker] 他这一句是道别(「${turnHeard.slice(0, 20)}」):不问 8791、不先应、不垫场`)
      }
      /** Ordinary work-call finals go to the single server decision endpoint. */
      if (!onboardingOn && turnBye === undefined) {
        const seq = started.seq
        const generation = sayGeneration
        const verdict = approvalOf(transcript)
        const ctx = sayConversation.contextFor(verdict === 'yes' || verdict === 'no' ? verdict : undefined)
        const sayInput = { text: transcript, ctx, clientKey: `say-${randomUUID()}` }
        const callId = sayCallId
        const deadline = Date.now() + SAY_RESULT_BUDGET_MS
        const controller = new AbortController()
        sayRequestController = controller
        const pending = deps.workbench.sayTurn(sayInput, { signal: controller.signal }).then(async (got) => {
          if (generation !== sayGeneration) return undefined
          if (got.ok) {
            sayConversation.accept(got.reply)
            log(`[channel-worker] /butler/say ${got.reply.say_id} ok`)
            return got.reply
          }
          if (got.timedOut) {
            // Keep the final sentence free: the neutral acknowledgement already covered the wait.
            // Both attempts belong to this one reply stream and use the exact same client key.
            log('[channel-worker] /butler/say 超过 3 秒：保留结果句，用相同请求号在剩余总预算内重送一次')
            let retry: Awaited<ReturnType<typeof deps.workbench.sayTurn>>
            const remainingMs = Math.max(0, deadline - Date.now())
            try {
              retry = remainingMs === 0
                ? { ok: false, why: 'Say result budget exhausted', timedOut: true }
                : await deps.workbench.sayTurn(sayInput, { timeoutMs: remainingMs, signal: controller.signal })
            }
            catch { retry = { ok: false, why: 'retry request failed' } }
            if (generation !== sayGeneration) return undefined
            if (retry.ok) {
              sayConversation.accept(retry.reply)
              return retry.reply
            }
            sayConversation.failed()
            const spoken = retry.outcomeUncertain ? SAY_OUTCOME_UNKNOWN_LINE : SAY_RETRY_UNKNOWN_LINE
            log('[channel-worker] 同号重送未取得确定结果，不再重派；照实告知结果未知')
            return { say_id: '', items: [], say: { screen: spoken, spoken } } satisfies SayReply
          }
          sayConversation.failed()
          if (got.outcomeUncertain) {
            log('[channel-worker] /butler/say 仍在处理；结果未知，不重派同一句')
            return { say_id: '', items: [], say: { screen: SAY_OUTCOME_UNKNOWN_LINE, spoken: SAY_OUTCOME_UNKNOWN_LINE } } satisfies SayReply
          }
          log(`[channel-worker] /butler/say 未接通(${got.why})，电话入口不可用；本句没有办理`)
          return { say_id: '', items: [], say: { screen: SAY_UNAVAILABLE_LINE, spoken: SAY_UNAVAILABLE_LINE } } satisfies SayReply
        }).catch((err: unknown) => {
          if (generation !== sayGeneration) return undefined
          const why = (err as Error)?.message ?? '未知'
          log(`[channel-worker] /butler/say 请求失败(${why})，电话入口不可用；本句没有办理`)
          return { say_id: '', items: [], say: { screen: SAY_UNAVAILABLE_LINE, spoken: SAY_UNAVAILABLE_LINE } } satisfies SayReply
        }).finally(() => {
          if (sayRequestController === controller) sayRequestController = undefined
        })
        turnSay = { seq: started.seq, generation, ...(callId === undefined ? {} : { callId }), pending }
        // Ordinary phone turns have no local understanding fallback.
      }
      /*
       * 新的一回合:上一回合应过的那一句作废(它只对上一回合算数)——
       * **补进一件没办完的事时不作废**(2026-10-12):那件事已经应过了,这一回合还是那件事,
       * 「别再应一次」那一行照带、也不垫「我想想」。
       */
      if (started.followUp === undefined || ackedWith === undefined) {
        ackedWith = undefined
        ackedSeq = undefined
      }
      else {
        ackedSeq = started.seq
        log(`[channel-worker] 这一句补进还没办完的那件事「${started.followUp.slice(0, 40)}」:意图与工具沿用,不另起一回合、不再先应`)
      }
      /**
       * ——— **按意图先应一句**(2026-09-23 下午,维护者 14:20)———
       *
       * > 「我说我想换音色,她还是说了『我想想』。」
       *
       * 「我想想」是**认不出意图**时才该说的话。判成 `act` 而且认得出意图的回合,
       * 这里当场把那一句预合成好的应答发出去(「好,我挑几个给你听」/「好,我去安排」/
       * 「我看一眼」),**然后才**去调工具与模型。2026-10-12 起只有会慢的意图有先应句,
       * 马上能答的(查一眼、记一笔)一个字都不先说 —— 哪类算快在 turnRoute.ts 的 `QUICK_INTENTS`。
       *
       * 三条纪律:
       *   ① **只发缓存里有的**。没预合成好就一个字都不说,退回原来的垫场 ——
       *      现合成要一两秒,那时候说这一句只会撞上她真正的回答(09-20 第一版的老毛病);
       *   ② **排在回合提交之前**。`say()` 进的是和回答同一条发言队列(优先级都是 NORMAL),
       *      而识别最终文本比回合提交早 5~40ms —— 在这儿排才排得到回答前面;
       *      等到 `agent_state_changed` 再说就注定排在回答后面(09-20 第一版逐字踩过);
       *   ③ **应过就不垫场**(下面那道闸按 `ackedSeq` 认),否则他先听见
       *      「好,我挑几个给你听」,0.7 秒后又听见一句「我想想」。
       *
       * 引导与来电那一通不应 —— 和 `llmNode`、垫场闸门同样的两条例外,理由也一样。
       */
      const ackSeq = routing.seq
      routing.whenDecided(ackSeq, (decision) => {
        // /butler/say supplies the one response for this turn; local phrase routes do not add an ack.
        if (turnSay?.seq === ackSeq) return
        /*
         * ★ **道别那一回合一个字都不先应**(2026-10-13 晚,卡 K)。
         * `sayPlannedAck` 那道闸本来也会把它拦下来,可那时这一行日志、这一笔额度
         * (`turnBudget.charge`)已经记过了 —— 认得出道别就别走到那一步。
         */
        if (turnFarewell?.seq === ackSeq) return
        // 闲聊、马上能答(2026-10-12,电话先应收窄)的回合一个字都不先说,交给模型。判据在 turnRoute.ts。
        if (turnOpening(decision) === 'none') return
        if (onboardingOn || ring?.answered() !== undefined) return
        // 补进没办完那件事的一句:那件事已经应过 / 已经在想了,不再应、也不现生一句(2026-10-12)。
        if (decision.followUp !== undefined) return
        /**
         * ——— **先应那一句没有的回合,现生一句**(2026-10-03,卡「首声提速」乙)———
         *
         * 顺序是**先看缓存里那四句**:它们是预合成好的,出口是 0 毫秒,
         * 而现生一句要 0.6–1.2 秒。所以缓存里有、而且真说出去了 → 这一回合**不问小模型**
         * (省一次调用,也不会两句话打架);没有先应句(动作词那七组故意没有)、
         * 或者那一句还没合好 → 才现生一句。
         */
        // **这一句不垫前导静音**(2026-09-27):通话中途那条音轨早就在播着了,
        // 垫的 260ms 在这儿纯是延迟 —— 前导静音只治「对端刚起播」那一下(开场白)。
        const speech = decision.ack === undefined
          ? undefined
          : openerSpeech(greetings, decision.ack, { leadSilenceMs: 0 })
        if (speech?.cached !== true) {
          /*
           * ★ **2026-10-13:没有先应句的回合不再现生一句**(维护者 10-13 早:那三次
           * 「好,我这就去弄 / 问问豆包 / 跟它说」都没发生过)。改成固定的中性垫场 ——
           * `turnOpening` 回的就是 `filler`,这里什么都不起,垫场由下面那道闸按常规来。
           * 现生那一层(firstVoice.ts)代码与用例都留着,只是 act 回合不起它。
           */
          if (decision.ack !== undefined) {
            log(`[channel-worker] 先应那一句还没预合成好(「${decision.ack}」),这一回合照旧垫场`)
          }
          return
        }
        /*
         * 2026-10-12:**定下**这一句,回合提交那一刻再说(`plannedAck` 那一格写着为什么)。
         * 打字送进来的那一回合没有回合提交;回合提交已经先走过了(判定比提交还晚)—— 这两种当场说。
         * 「已经应过了」那两格现在就置上:llmNode 与垫场那道闸要在回合提交之前就看得见它。
         */
        ackedWith = speech.text
        ackedSeq = ackSeq
        // 先应这一句占这一回合的额度(2026-10-12,电话少说几句):模型那边只剩一句说结果。
        turnBudget.charge(speech.text, persona.max_sentences)
        if (options.typed === true || ackCommittedSeq === ackSeq) speakAck(speech)
        else plannedAck = { seq: ackSeq, speech }
        log(`[channel-worker] 先应了一句:「${speech.text}」(意图 ${decision.intent ?? '?'},回合提交时出口,这一回合不垫场)`)
      })
    }

    session.on(AgentSessionEventTypes.UserInputTranscribed, (event) => {
      caption('me', event.transcript, event.isFinal)
      /**
       * 应声要看这一段**到没到句尾**(backchannel.ts 的阈值之一),所以中间结果也喂它。
       * 中间结果一句话能来十几条,这一条只记最近那一段,不攒。
       */
      backchannel.heard(event.transcript)
      /**
       * ——— **打断那道闸就在这一拍判**(2026-10-03,卡 ④甲)———
       *
       * 中间结果与 final 都喂它:真打断要在**第一条有字的中间结果**上就掐
       * (业界那条尺子 ≤300ms),等到 final 就晚了一个端点检测的等待。
       *
       * 回 `ack` 的那一段(整段只是一声「嗯 / 对 / 好」,而且**她手上还有话**)
       * **整段不进回合**:框架那边本来就会把它丢掉(`agent_activity.js:1698` 那道门,
       * 见 bargeIn.ts 文件头),工人这边也得跟着丢 —— 否则一声「嗯」照旧去跑分流、
       * 把「先应那一句」说出口、记一行「他说」,而她的话已经在半句上停住了,
       * 那是最吓人的那一种。
       *
       * **她手上没话**时的那一声「好」回的是 `turn`,一个字都不特殊对待 ——
       * 那是**他的答复**,分流那边当应答处理(turnRoute.ts 的 `ANSWER_WORDS`,两张表故意不合)。
       */
      // 这道闸关着(`WORKBENCH_CHANNEL_BARGE_IN_ZH=off`)→ 当 `turn`:一个字都不过滤,照旧进回合。
      const bargeInVerdict = bargeIn?.heard(event.transcript, event.isFinal) ?? 'turn'
      if (bargeInVerdict === 'ack') {
        if (event.isFinal) log(`[channel-worker] 他只应了一声「${event.transcript.trim().slice(0, 8)}」:不打断她、这一段也不进回合`)
        return
      }
      if (event.isFinal) hearFinalText(event.transcript)
    })
    /**
     * 她说了什么、调了什么工具:**只进日志,不进字幕**(字幕走 TTS 那条,见上面)。
     * 引导跑偏时这两行是唯一能看出「她到底听懂没有、记了没记」的地方。
     */
    session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => {
      const item = event.item as { role?: string, textContent?: string, interrupted?: boolean }
      if (item.role !== 'assistant') return
      timing?.mark('llm_done')
      log(`[channel-worker] 她说:${(item.textContent ?? '').slice(0, 80)}${item.interrupted === true ? '(说到一半被掐了)' : ''}`)
      /*
       * **这件事算办了没有**(2026-10-12,卡「通话补一句不丢事」):模型完整说完一段话才算 ——
       * 先应那一句(定死的那几句)不算,说到一半被他掐断的不算。没办完的那件事,
       * 他接下来插的话会并进来(turnRoute.ts 的 TurnRouting 第 ④ 条)。
       */
      const said = (item.textContent ?? '').trim()
      if (item.interrupted !== true && said !== '' && !ACK_LINES.includes(said)) routing.noteHandled()
      /*
       * **她上一句是不是在问她**(2026-10-02,卡「电话里像个活人」)。
       *
       * 分流那边要这一格:同样一句「可以」,事务官刚问完一句时是**批准**(要工具),
       * 刚报完一个结果时只是**应答**(不要工具)。判据在 turnRoute.ts 的 `looksLikeAsking`
       * (标点与句尾那几个字,不经模型),这里只是把事务官最后说的那一句记下来。
       *
       * 存的是**整句**而不是那个布尔:下一回合开判时才算,算法改了不用改这里。
       */
      lastButlerLine = item.textContent ?? ''
    })
    /**
     * ——— 缓冲语(2026-09-20 第二版:工人只发信号,手机拿包里的音频自己垫) ———
     *
     * 一问一答实测 3.7–4.3 秒(交接-0918 第三节),那几秒里手机上什么都没有,人只能猜她还在不在。
     *
     * **第一版在这里调 `session.say('我想想。')`,两个毛病**(交接-0920-引导通话第二轮 第六节第 1 条):
     * 它排进的是和回答**同一条发言队列**,而回答在回合提交那一刻就排进去了 ——
     * 等 700ms 再 say 注定排在回答后面(实测「先出回答、1.4 秒后补一句稍等」);
     * 而且那是一句**定死的话**,每轮都去火山合成一次,花时间花钱换同样那几句。
     *
     * 这一版:这里只**广播一条信号**,不说话、不合成、不占发言队列。
     * 等多久、说哪一句、什么时候掐,全在手机那一侧(butler-app/src/call/fillerAudio.ts),
     * 那几句音频是预先合成好打进安装包的。
     *
     * 为什么接 `agent_state_changed` 而不是自己在 UserInputTranscribed 里计时:
     * 状态是框架**唯一**知道「模型的第一个字有没有出来」的地方 —— 工具往返、重试、打断
     * 都已经算进去了,自己数会在每一种边角上都数错。
     */
    session.on(AgentSessionEventTypes.AgentStateChanged, (event) => {
      /*
       * ★ **她真的出声了 → 开场那一句从这一下起掐得动**(2026-10-13 下午,卡「来电开场」②③)。
       * `speaking` 正是第一帧转发出去那一刻(`agent_activity.js` 的 `onFirstFrame` →
       * `tryStartAgentSpeech`),09-27 那两道门(`userSilenceEvent` / `reconcilePlayoutPause`)
       * 都已经过去了,所以这会儿翻只剩「能掐」与「听得见她」这两件好处。
       */
      if (event.newState === 'speaking') openerCutIn.outLoud()
      /**
       * 状态 → 轮号那三条**整个在 filler.ts 的 `applyAgentState` 里**(2026-09-22),
       * 为的是能有用例看着它 —— 这一段本身要真起一个 LiveKit 会话才跑得到。
       *
       * 这次改的那一条:**`speaking` 不算回合结束**(Ben 真机:「在生成回复之前,
       * 它一次念了好几句」)。原先这里把「不是 thinking」一律当结束,而框架在
       * 一个回合的工具步之间就会 `speaking ↔ thinking` 来回切
       * (`agent_activity.js`:工具还忙着 / 工具有输出 → `updateAgentState(lease,'thinking')`),
       * 于是**一个回合被切成好几轮**,手机每个新轮号都以为「他又说了一句话」。
       * 整段发言真收尾(`releaseAgentStateLease()`)与被打断那两处,框架写死的都是 `listening`。
       */
      /**
       * **闲聊回合一个字都不垫**(2026-09-23)。闸门就是这一段:
       * 回合提交那一刻分流可能还没判回来(Jev 要一次 HTTP),所以给的是一个**开关**,
       * 判定回来了、而且还是这一回合(轮号对得上)、而且是「要办事」,才按下去。
       *
       * 引导与来电那一通照旧一律垫 —— 和上面 `llmNode` 同样的两条例外,理由也一样。
       */
      const gate = (emit: () => void): void => {
        /**
         * **引导里一句都不垫**(2026-09-23 第二轮真机,维护者:「我说叫我 Ben,他说我想想,这合适吗?」)。
         * 引导是一问一答,他答的都是短句,0.7 秒的门每一轮都会被撞开 —— 一连六轮都是「我想想 / 稍等一下」。
         * 真要等久的那一下(找项目)由她自己说「我看一眼」,不靠垫场。
         */
        if (onboardingOn) return
        /*
         * ★ **走固定流程的那一回合不垫场**(2026-10-13):那一句话不等模型,垫了就是抢话。
         * 来电那一通也要过这一道 —— 她答豆包那道题走的正是固定流程(演示场景 ③)。
         */
        const seq = routing.seq
        void thisTurnIsHandled().then((handled) => {
          if (handled) {
            const reason = turnFarewell?.seq === seq
              ? '道别固定回复'
              : turnSay?.seq === seq ? '/butler/say 已接管本回合' : '引导固定流程'
            log(`[channel-worker] 这一回合${reason},不垫场`)
            return
          }
          if (ring?.answered() !== undefined) { emit(); return }
          fillerGate(seq, emit)
        })
      }
      /** 原来那一道闸(按分流判定垫不垫)。2026-10-13 提成一个有名字的函数,上面那一道在它前面。 */
      function fillerGate(seq: number, emit: () => void): void {
        routing.whenDecided(seq, (decision) => {
          /**
           * 闲聊不垫;**已经按意图应过一句的也不垫**(2026-09-23 下午)——
           * 他刚听见「好,我挑几个给你听」,0.7 秒后再补一句「我想想」就是两句话打架,
           * 而后一句正是维护者 这次点名要去掉的那一句。判断本身在 filler.ts(有用例)。
           */
          const verdict = fillerGateVerdict(decision.route, {
            ...(ackedSeq === seq && ackedWith !== undefined ? { acked: ackedWith } : {}),
            ...(decision.quick === true ? { quick: true } : {}),
          })
          if (verdict.fill) { emit(); return }
          log(`[channel-worker] ${verdict.why},不垫场(${decision.router}:${decision.reason})`)
        })
      }
      /**
       * 闸门按下那一刻,工人这边也开始计 700ms(workerFiller.ts)。信号照发 ——
       * 带着 `voiced_by:'worker'`,手机据此不再放本地那份;老手机不认,会**和工人一起垫**
       * (两句叠在一起,只在没换包的那台手机上),交接里写明要换包。
       */
      const gateWithWorker = workerFiller === undefined
        ? gate
        : (emit: () => void): void => gate(() => { emit(); workerFiller.arm(filler.line) })
      applyAgentState(filler, event.newState, gateWithWorker)
      if (event.newState !== 'thinking' && event.newState !== 'speaking') workerFiller?.endRound()
      // 应声的计数也按回合算(一轮最多三声);回合真结束了才归零,同上面那条口径。
      if (event.newState !== 'thinking' && event.newState !== 'speaking') backchannel.endTurn()
      /**
       * **打断那道闸认「她手上有没有话」**(2026-10-03)。口径与上面那几条**故意不一样**:
       * `thinking` 也算**有**。
       *
       * 因为框架那两道门认的是 `_currentSpeech`,而它在发言排进队那一刻就挂上了
       * (模型第一个字还没出来,act 那条路中位 8.2 秒)。只认 `speaking` 的话,
       * 他在那八秒里说的一整句会被框架当成「她手上有话、词数不够」整段丢掉 ——
       * 他说了一句话,一个回音都没有。整段理由在 bargeIn.ts 文件头那段⚠️(带行号)。
       */
      bargeIn?.agentHasFloor(event.newState === 'speaking' || event.newState === 'thinking')
      // 同一条状态流上的第二位读者:回合的提交、开口、收尾三下都在这里(latency.ts)。
      if (timing !== undefined) applyAgentStateToTimeline(timing, event.newState)
      // 回合真结束了(回到听 / 闲下来)→ 判定也该忘掉:下一个没有识别结果的回合
      // 不该沿用这一回合的路(turnRoute.ts 的第 ③ 条)。`speaking` 不算结束,同上。
      if (event.newState !== 'thinking' && event.newState !== 'speaking') {
        routing.end()
        /*
         * **还在合着的那一句首句跟着作废**(2026-10-03,卡 fix/voice-route-zh;审计附证 A)。
         * 下一回合判成闲聊时压根不会 `start()`,轮号不动 —— 不在这儿作废,
         * 那一句回来之后看上去仍然算数,就垫进了新回合。
         */
        firstVoice?.cancel()
        /*
         * ★ **他这件事办完了 → 这才提挂着的那一件**(2026-10-13 下午,卡 A 第 4 条)。
         * 口径就是这一条:她那一段话真收尾(框架写死 `listening`)。排在这一段的**最后**:
         * 它可能当场 `say` 一句,本回合自己的收尾先做完。一次只提一件;他正说着话不提。
         */
        announceHold?.thingDone()
      }
      // 她一开口,他下一段话就是新的一回合(turnHeard 从头拼)。
      if (event.newState === 'speaking') heardFresh = true
      // 挂断等的就是这一下:她这一段话收尾(回到 listening)再多等一小截才挂(farewell.ts)。
      farewell?.agentState(event.newState)
      // 测试口等的也是这一下:回合收尾了才把这一回合的结果回给统筹(卡 TT,口径同上面那几条)。
      textTurnCollector?.agentState(event.newState)
    })

    session.on(AgentSessionEventTypes.FunctionToolsExecuted, (event) => {
      const calls = (event as unknown as { functionCalls?: { name?: string }[] }).functionCalls ?? []
      if (calls.length > 0) log(`[channel-worker] 她调了工具:${calls.map(call => call.name ?? '?').join('、')}`)
      /*
       * 调过工具 = 这件事办了(办成办不成由工具回话说,她照那句说);
       * 自己不报成没成的那几件跑完就算成(claimGuard 只拦「一件都没办成」的回合)。2026-10-12。
       */
      if (calls.length > 0) {
        routing.noteHandled()
        if (calls.some(call => !turnToolReports.has(call.name ?? ''))) turnToolOk = true
      }
      /**
       * 测试口要的「调了哪些工具及结果」(卡 TT)。输出与调用是**同下标的两条数组**
       * (框架的 events.d.ts 写明了),所以按下标配对;**只在测试口盯着这一回合时**才攒,
       * 真通话一个字节都不多存(工具结果里有他的私事)。
       */
      if (textTurnCollector !== undefined) {
        const outputs = (event as unknown as { functionCallOutputs?: { output?: unknown }[] }).functionCallOutputs ?? []
        calls.forEach((call, index) => {
          const raw = outputs[index]?.output
          const result = raw === undefined ? undefined : (typeof raw === 'string' ? raw : JSON.stringify(raw))
          textTurnCollector?.tool({
            name: call.name ?? '?',
            ...(result === undefined ? {} : { result: result.slice(0, 2000) }),
          })
        })
      }
      /**
       * 慢工具跑完、她跑之前那几句也放完了(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait):告诉手机一声。
       * 手机引导通话页据此知道「她下一次开口就是在说结果」—— 球从开始找一直是执行中,到那一刻才回去。
       * 为什么是这个事件而不是工具自己跑完那一刻,见 filler.ts 的 toolsDone。
       */
      try {
        if (filler.toolsDone(calls.map(call => call.name ?? ''))) log(`[channel-worker] 缓冲语信号:tool_done ${calls.map(call => call.name ?? '?').join('、')}(第 ${filler.round} 轮)`)
      }
      catch { /* 一条信号发不出去不许把会话带走 */ }
    })

    /**
     * ——— 招呼(2026-09-18 改) ———
     *
     * 以前这里直接 `session.say(persona.welcome)`。工人是**常驻**的:房里没人时那一句
     * 只是排进音频队列,等第一台手机进来才真的出声 —— Ben 09-18 在手机上一进引导
     * 先听见「喂,我在,你说。」,之后才是开场白,他那台机器的日志逐字印证了这个顺序。
     *
     * 所以招呼从此**由打电话的那一头点名要**。普通通话:手机接通后发
     * `{type:'call',action:'start'}`;引导:发 onboarding.start,由种子句开场,没有招呼。
     * 为什么不是「先说招呼,发现是引导再打断」:手机进房前要先问麦克风权限,那一下可能等人好几秒,
     * 任何靠时间窗猜的写法在真机上都会翻车。
     */
    /**
     * ——— 座机主动来电(2026-09-21,Ben:「待确认 / 运行失败 / 完成提醒时座机响铃」) ———
     *
     * 8791 决定打不打(server/callOut.ts),这里只管响铃与接起之后那一段。
     * 顺序与引导那条一模一样:**先开口,再换提示词** —— 开场那一句是定死的,
     * 不必等 updateInstructions 把活动重搭一遍(2026-09-18 实测,交接-0918 第三节第 3 条)。
     */
    const ringTools = createRingTools({
      workbench: callWorkbench,
      onStart: onToolStart,
      onUsed: noteToolUsed,
    })

    /**
     * ——— 这一通叫他什么(2026-09-23,Ben:「第一次叫老板,下一次叫姚总,有点好玩」)———
     *
     * 表在人设里(`persona.addresses`),轮换的规矩在 address.ts(**同一天不重复**)。
     * 状态留在工人进程里:它是常驻的,跨通电话记得住;重启就从头开始 ——
     * 为了一个称呼去落一份盘,代价比重复叫一次「老板」大得多。
     */
    let addressState: AddressState | undefined
    function addressForThisCall(): string {
      const picked = nextAddress(persona.addresses ?? [], addressState, localDay(new Date()))
      addressState = picked.state
      return picked.address
    }

    /**
     * 换上「这一通电话」那套:人设不动,只在后面补这件事的来意与那件工具。
     * 底子用的是 `baseInstructions()` —— 人设 + 这一通现拼的「关于我自己」:
     * 他在来电里问「你跑在哪个模型上」的时候,那几行得在她眼前(2026-09-23)。
     */
    async function wearRing(call: RingCall, address: string): Promise<void> {
      // 称呼原样带进提示词:她要知道开场白里已经叫过他什么,才不会紧接着再叫一次别的。
      await agent.updateInstructions(ringInstructions(baseInstructions(), call, { address }))
      // 「等你回答」那一通只挂交原话那一件;别的来电只挂落决定那一件(2026-09-25,卡 M):
      // 那一问不是一张要验收的卡,「批准」落到看板上会把卡挪进「完成」。
      const { [TOOL_ANSWER_ASK]: answerTool, ...decideTools } = ringTools
      await agent.updateTools(call.reason === 'ask' ? { ...channelTools, [TOOL_ANSWER_ASK]: answerTool } : { ...channelTools, ...decideTools })
    }

    /** 电话完了,换回平时那套。**引导在做时不碰** —— 那一套提示词比这一通重要。 */
    async function takeOffRing(): Promise<void> {
      /**
       * 开场白那一行跟着这一通走(2026-09-23)。清在最前面,连引导那条早退的路一起清:
       * 「上一通她已经问过有什么吩咐」对下一通没有任何意义,留着只会让她下一通不肯开口。
       */
      openedWith = undefined
      /**
       * 排着还没出口的那一句开场白**当场掐掉**(2026-09-23 下午,延后 700ms 之后才有的这条)。
       * 他提机 0.3 秒又放下的话,这一句既不该在空听筒里响,更不该串进下一通。
       */
      opening.cancel()
      // 「念完 3 秒不吭声再说一遍」那一台也收掉:她已经挂了(2026-10-13)。
      ringOpenerRun?.stop()
      ringOpenerRun = undefined
      // 先应过的那一句也只对那一回合算数,跟着这一通一起清。
      ackedWith = undefined
      ackedSeq = undefined
      if (onboardingOn) return
      await agent.updateInstructions(baseInstructions())
      await agent.updateTools(channelTools)
    }

    restoreAfterRing = takeOffRing
    /**
     * 通话状态那条统一信号(2026-09-23)。和铃声、字幕同一条通道、同样**广播** ——
     * 手机与展示台该看见同一份「这会儿在不在通话里」。
     */
    callState = createCallState({
      send: (line: string) => {
        void room.localParticipant?.sendText(line, { topic: RPC_TOPIC })
          .catch((err: unknown) => log(`[channel-worker] 通话状态没发出去:${(err as Error)?.message ?? '没说原因'}`))
      },
      log,
    })
    /**
     * **她道过别,由她挂**(2026-09-23 晚)。挂的那一下**复用现有挂断那一条路**,不另起协议:
     *
     *   - `ring.hangup('butler')`:来电那一通广播 `ring_end{hung_up}`(不带 `by`,只换那句人话)——
     *     手机接的那一面(老包也认)据此回待机、退出通话页;话筒接的那一面同理收掉;
     *   - `callState.leave('butler')`:线上是 `call_state{idle, by:'worker'}` —— 话筒拨出那一面据此收掉;
     *     新手机自己拨的那一通也据此自己挂(butler-app livekitCall.ts),老包收不掉那一种(交接里写明);
     *   - `callRecord.finish()`:纪要照交(该报的才报,同挂断);
     *   - **收音关掉**,直到下一通开始(见 `mutedAfterBye`):话筒那一通派不知道她挂了,听筒还推着音。
     */
    farewell = createFarewellHangup({
      hangup: () => {
        const on = answeredOn()
        ring?.hangup('butler')
        invalidateSay()
        callState?.leave('butler')
        callRecord.finish()
        announceHoldStop()
        // 收音关上(收音闸:这一通已经不在了,道别那一道也记上 —— 听筒放下再拿起才算新的一通)。
        mutedAfterBye = true
        syncListen('她道别挂了')
        log(`[channel-worker] 由她挂断(${on === 'handset' ? '话筒:要再说话得放下再拿起' : on === 'phone' ? '手机' : '接话对象不明'})`)
        void takeOffRing().catch(() => { /* 同挂断那一条 */ })
        // 引导那一通:新手机会自己挂并暂停引导;老包不会 —— 这里先暂停,进度在 onboarding.json。
        if (onboardingOn) void stopOnboarding()
      },
      log,
    })
    ring = createRingMachine({
      // 和字幕、缓冲语同一条通道、同样**广播**:一个房间就是一场对话,他的手机和测试页该看见同一份。
      send: (line: string) => {
        void room.localParticipant?.sendText(line, { topic: RPC_TOPIC })
          .catch((err: unknown) => log(`[channel-worker] 铃声没发出去:${(err as Error)?.message ?? '没说原因'}`))
      },
      /**
       * 补发给**一位**(2026-09-23,上面那段「晚进房的那一位要补一份铃」)。
       * 走的是同一条 `wb.rpc`,只是点了名 —— 手机那一侧读的是同一个处理器,认不出区别。
       */
      sendTo: (identity: string, line: string) => sendTo(identity, line),
      /**
       * **这会儿正在通话里吗**(2026-09-27,卡 MS)。他自己拨的那一通、话筒提机那一通都走 `callState`,
       * 振铃机器自己的 `live` 看不见它们 —— 于是 21:23 那一通里派活失败的「只发通知」广播了一条 `ring` 进房,
       * 手机那一面收到来电就把**正在进行的这通电话**收了场。引导那一通同理(它就是一通电话)。
       */
      inCall: () => callState?.current() !== undefined || onboardingOn,
      /**
       * 通话里当场说(卡 MS)。**不广播 `ring`、不挂电话**:那一句由代码从事实拼好(`inCallAnnounceText`),
       * 插在她正说的话后面。说不出去(还没接上话)就回 false,那一通照旧排着,等这通挂了再响。
       */
      onAnnounce: (call) => {
        if (session === undefined) return false
        const text = inCallAnnounceText(call)
        /**
         * ★ **他拨出去的那一通先让他安排他的事**(2026-10-13 下午,卡 A 第 4 条;announceHold.ts)。
         *
         * 14:17 那一通他一接通就被念了 108 字(同一件事两条 key 念两遍,还带钱 / 分钟 / 步数),
         * 「打断不了」。维护者定的顺序:他先安排事,事务官再说它的。
         *
         * 攒下来回 true(这一通照旧按「只发了通知」收场,不再排队响铃):
         * 放的时候仍然走这一条 `say`,所以文案、可打断、进对话历史三样一个字没变。
         * **来电那一通不经这里** —— 她主动打来就是为了说这件事(`ringOpener` 一开口就说清)。
         */
        const hold = announceHold
        if (hold !== undefined && ring?.answered() === undefined) {
          return hold.hold({ itemId: call.item_id, text })
        }
        try {
          session.say(text, { allowInterruptions: true, addToChatCtx: true })
          return true
        }
        catch (err) {
          log(`[channel-worker] 通话里这一句没说出去:${(err as Error)?.message ?? '没说原因'}`)
          return false
        }
      },
      onAnswered: (call) => {
        log(`[channel-worker] 他接起来了:${call.title}`)
        /**
         * 纪要从**接起那一刻**开始攒(2026-09-23)。来电这一通手机那一侧不写纪要
         * (useIncoming 里没有 record 这条路),所以这一通**由工人报**,带上 call_id;
         * 手机哪天也开始报了,8791 按同一个 call_id 合并成一条。
         */
        /*
         * ★ **接的是手机就由手机报**(2026-10-13 下午,卡 A 第 5 条;整段理由在 callRecord.ts 文件头)。
         * 09-23 这里写死 `report: true`,理由是「手机那一侧今天不写纪要」—— 那条假设过期了:
         * `useCall.hangup()` 对每一通接通过的电话都报,而它那条不带 `call_id`,8791 去重对不上,
         * 于是 14:06 那一通在看板上落了两张一模一样的纪要卡。
         */
        const ringOn = answeredOn()
        callRecord.start({ callId: call.id, report: workerReportsRecord(ringOn === undefined ? {} : { answeredOn: ringOn }) })
        /**
         * 这一通的称呼**先定下来再开口**(2026-09-23):开场白与随后换上的提示词
         * 必须用同一个,否则她开场叫「老板」、下一句改口叫「姚总」——那不是好玩,是分裂。
         */
        const address = addressForThisCall()
        /**
         * 来电这一句**也认那份缓存**(2026-09-23):命中就直接发帧,没命中照旧现合成。
         * 现在预热的只有提机那一句,所以这一条实际上总是走现合成 —— 留着它是因为
         * 哪天把 `ringOpener` 也预热进来,这里一个字都不用改(理由见 docs/决策记录.md)。
         */
        const opener = openerSpeech(greetings, ringOpener(call, { address }), { leadSilenceMs: deps.config.openerLeadMs })
        /**
         * **也晚一点再说**(2026-09-23 下午)。来电这一通他是按了「接起」才通的,
         * 手到耳朵那一段路和提机一样长 —— 卡上原话「来电接起那条同样」。
         * 这一句要是还没出口他就挂了,`takeOffRing` 会把它取消掉。
         */
        /*
         * ★ **她 3 秒不吭声就把那件事再说一遍**(2026-10-13,维护者:「接起来也不说事,还要我来问」)。
         * 只一次;她一开口、或者这一通已经不是她接起的那一通,就不说了。
         * 这一句是定死的、0 毫秒出口 —— 比等她问一声(要等模型 8 秒)快得多。
         *
         * ★ **那 3 秒从「这一句真的念完」才起算**(2026-10-13 下午,维护者 11:40 真机:
         * 44 字那一句要 3.5 秒才念完(`tts_all_ms:3501`),于是第一遍没念完第二遍就接上了)。
         * 「念完」取框架的 `SpeechHandle.waitForPlayout()`;判法与上限在 tts/openerRepeat.ts。
         */
        ringOpenerRun?.stop()
        const run = createOpenerRepeat({
          say: (round) => {
            firstTextSource = round === 'first' ? '来电开场白' : '来电开场白(再说一遍)'
            return session?.say(opener.text, { ...OPENER_SAY_OPTIONS, ...(opener.audio === undefined ? {} : { audio: opener.audio }) })
          },
          live: () => ring?.answered()?.id === call.id,
          cutIn: openerCutIn,
          repeatMs: RING_OPENER_REPEAT_MS,
          log,
        })
        ringOpenerRun = run
        opening.schedule(() => { void run.start() })
        /**
         * **先开口,再换提示词**(这条顺序没动)。「关于我自己」现拼要等一两条 HTTP,
         * 所以它和提示词一起排在开场白后面 —— 开场白是定死的一句,一秒都不该为它多等。
         *
         * ★ **接话模型这一通也现取,且排在首句投递之前**(2026-10-23 源审退修):
         * 本地读文件 + updateOptions(毫秒级),在链里先于 refreshSelfBrief(families/persona
         * 那些无关网络不 gate 它);失败则本地保持旧,下一通再试(开场白是本地音频,不占这条)。
         */
        void (async () => {
          try { await refreshCallModel() }
          catch (err) { log(`[channel-worker] 这一通的接话模型没换上,沿用上一份:${(err as Error)?.message ?? '没说原因'}`) }
          await refreshSelfBrief()
          await wearRing(call, address)
        })().catch((err: unknown) => log(`[channel-worker] 这一通的提示词没换上:${(err as Error)?.message ?? '没说原因'}`))
      },
      onSettled: (call, outcome, text) => {
        log(`[channel-worker] 这一通收场:${outcome}${text === undefined ? '' : `(${text})`}`)
        // 被取消的那一种在台账上记 `failed`(技术失败;她停铃、已无需再打由工作台自己记)。都带上这间房(卡 M6,twoRooms.ts 的 ackOf)。
        void deps.workbench.ackCall(ackOf(call, outcome, text, ticket.room))
          .then((ok) => { if (!ok) log('[channel-worker] 这一通的收场没回给工作台(台账那边有超时兜底)') })
      },
      // 别的房间先接起了、这边收了铃(卡 M6):只回一句「这间房回过话了」,台账上那一通已经是「接了」。
      onAnsweredElsewhere: (call) => {
        void deps.workbench.ackCall(ackOf(call, 'elsewhere', undefined, ticket.room))
          .then((ok) => { if (!ok) log('[channel-worker] 「在别处接了」没回给工作台(台账那边有超时兜底)') })
      },
      log,
    })

    callPort = {
      async greet(by, callId) {
        /**
         * **先钉接话对象,再开口**(2026-09-23,提机即拨出;理由与 `answer` 那一条逐字相同)。
         *
         * 他从那只树莓派听筒里拿起电话,招呼就该从那只听筒里出来。不钉的话
         * `pickSpeaker` 的第 ① 条(现任还在房里就不换)会让她对着**上一通**的那一台说话 ——
         * 座机形态下那正好是搁在外壳里的手机,而他正举着听筒。
         *
         * 钉在 `onboardingOn` 那几条之前:那几条只是「这一句不用说」,
         * 接话对象该归谁跟说不说这一句没关系。
         */
        if (by !== undefined) bindSpeaker(by.identity)
        invalidateSay()
        sayCallId = by === undefined ? undefined : callId
        // 新的一通:上一通她道别挂了之后关着的收音打开,没挂完的那一下忘掉(farewell.ts)。
        farewell?.reset()
        listenAgain('新的一通')
        /**
         * **他提机拨出去的那一通,手机也要知道**(2026-09-23,Ben 12:45:「打过来和打过去
         * 都应该是显示同一个页面」)。这一条排在这儿而不是排在她开口之后:叉簧已经抬起来了,
         * 房里这会儿**就是**在通话中 —— 她说不说得出话(没有接话模型、TTS 挂了)是另一回事,
         * 那一条在字幕上说,不该让手机这一面跟着一起哑掉。
         *
         * 没带身份的老手机(不带 `by` 的那条 `start`)**不广播**:连是哪一台都不知道,
         * 广播出去手机也判不了「这一通归不归我」—— 宁可退回老行为。
         */
        if (by !== undefined) callState?.enter(by.kind, callId, by.identity)
        // 这一通开始了:只听拨这一通的那一台(收音闸)。
        syncListen('他拨通了')
        if (onboardingOn) {
          // 引导里不打招呼(这一段的开场白已经说过了)。不算错,如实说一句就好。
          return { ok: true }
        }
        // 主动来电那一通的开场白是 ringOpener,不是招呼 —— 两句一起说就是两个声音抢话。
        if (ring?.answered() !== undefined) return { ok: true }
        /**
         * 普通通话也是一通电话:纪要从招呼这一刻开始攒(2026-09-23)。
         *
         * **谁报**:接话的是那只树莓派话筒时,没有别人会报,工人报;
         * 接话的是手机时**工人不报** —— 手机挂断时自己就带着两边字幕上报了
         * (butler-app/src/call/useCall.ts),而它那条没有 call_id,两边都报去重就靠不上,
         * 看板上会多一张一模一样的卡。理由与边界写在 callRecord.ts 的文件头。
         */
        const greetOn = answeredOn()
        // 编号用手机 `start` 带来的那个(手机挂断报的时候带同一个);没带就由 callRecord 自己编。
        callRecord.start({ ...(callId === undefined ? {} : { callId }), report: workerReportsRecord(greetOn === undefined ? {} : { answeredOn: greetOn }) })
        /**
         * ★ **他拨出去的这一通:挂着的问攒着,等他说完他的事**(2026-10-13 下午,卡 A 第 4 条)。
         * 这一台只给**他拨出去**的那一通(来电那一通一开口就说事,`onAnnounce` 那里按
         * `ring.answered()` 分路)。接通就开始数空闲:他一直不开口,到点先说一件。
         */
        announceHold?.stop()
        announceHold = createAnnounceHold({
          say: (one) => {
            try { session?.say(one.text, { allowInterruptions: true, addToChatCtx: true }); return true }
            catch (err) {
              log(`[channel-worker] 挂着的那件事没说出去:${(err as Error)?.message ?? '没说原因'}`)
              return false
            }
          },
          log,
        })
        /**
         * ——— 先问一句「有什么吩咐」(2026-09-23,Ben 12:xx) ———
         *
         * 以前这里说的是 `persona.welcome`(「喂,我在,你说。」)。他拿起听筒到开口
         * 中间那一两秒里听筒是安静的,于是改成**主动问一句**,而且**不等合成**:
         * 这一句在工人启动时就按称呼表合好放在内存里(tts/greeting.ts),
         * 命中就把缓存的帧直接交给 `say(text, { audio })` —— 框架看见 `audio` 整条跳过 TTS。
         *
         * 没命中(还没合完、8792 那会儿不在、换音色刚清了缓存)就**照样说这一句**,
         * 只是退回现合成:慢回从前那个样子,一个字都不少。
         *
         * 称呼与来电那一通同一条规矩:**先定下来再开口**,提示词里用的是同一个。
         */
        const address = addressForThisCall()
        const speech = openerSpeech(greetings, offhookGreeting(address), { leadSilenceMs: openerLeadFor(by?.kind, deps.config) })
        if (!speech.cached) log(`[channel-worker] 开场白没命中缓存,现合成:「${speech.text}」(会慢一两秒)`)
        else if (speech.leadSilenceMs > 0) log(`[channel-worker] 开场白命中缓存,前面垫 ${speech.leadSilenceMs}ms 静音再发帧(对端起播那一下吃掉的是这一段)`)
        /**
         * **晚 700ms 再出口**(2026-09-23 下午,维护者 14:20:「我放到耳边,
         * 一听到『吩咐』两个字,很明显说的太早了」)。叉簧一抬就发帧的话,
         * 这一句念到一半他才把听筒贴上,听见的只有后两个字。
         *
         * **这一句排出去之前先回 `{ok:true}`**:提机那条 RPC 等的是「这边收到了」,
         * 不是「她已经念完了」—— 让它多等 700ms 只会把叉簧那一头也拖慢。
         * 他 700ms 内又放下听筒(拨错了、改主意):`hangup` 里 `opening.cancel()`
         * 把它掐掉,那一句不会在空听筒里响,更不会串进下一通。
         */
        opening.schedule(() => {
          try {
            firstTextSource = '提机开场白'
            /*
             * 出声之后翻成可打断(兄弟路同一处,2026-10-13 下午)。他提起听筒、听见「吩咐」
             * 就抢着说第一句的那一下,从前**那几个字进不了识别**
             * (`discardAudioIfUninterruptible`,见 tts/openerRepeat.ts ③)。
             */
            openerCutIn.track(
              session?.say(speech.text, { ...OPENER_SAY_OPTIONS, ...(speech.audio === undefined ? {} : { audio: speech.audio }) }),
              '提机开场白',
            )
          }
          catch (err) { log(`[channel-worker] 招呼没说出去:${(err as Error)?.message ?? '没说原因'}`) }
        })
        // 这一句已经说过了:提示词里要写明「别重复」(见 baseInstructions)。
        openedWith = speech.text
        // 招呼先出口,「关于我自己」随后挂上去(同来电那一条的顺序)。
        void (async () => {
          await refreshSelfBrief()
          if (!onboardingOn && ring?.answered() === undefined) await agent.updateInstructions(baseInstructions())
        })().catch((err: unknown) => log(`[channel-worker] 这一通的「关于我自己」没挂上:${(err as Error)?.message ?? '没说原因'}`))
        /**
         * ★ **模型刷新必须在首句投给 LLM 之前完成**(2026-10-23 源审退修):
         * `textTurnPort.say` 在 await greet 后立刻投首句 —— 这里把 refreshCallModel
         * await 住(本地读文件 + updateOptions,毫秒级;不等上面那条 fire-and-forget 的
         * families/persona),失败则本地保持旧、下一通再试,不在首句上蒙混。
         */
        try { await refreshCallModel() }
        catch (err) { log(`[channel-worker] 这一通的接话模型没换上,沿用上一份:${(err as Error)?.message ?? '没说原因'}`) }
        return { ok: true }
      },

      /**
       * 接起(2026-09-21;2026-09-22 晚多认一个 `by`)。
       *
       * **先钉接话对象,再接**:反过来的话,她的开场白(`ringOpener`,在 `onAnswered`
       * 里当场就说)会先送进**上一位**的耳朵里 —— 座机形态下那正好是那只没人拿起来的听筒。
       */
      async answer(callId, by) {
        if (ring === undefined) return { ok: false, error: '电脑上的事务官现在接不了话' }
        /**
         * **先问谁先接**(2026-10-22,局域网主路 M6;twoRooms.ts):同一通在本机房间与云房间都响着,
         * 别的房间先接了就不出声 —— 这间房收铃,按「接起」的那台收到一句人话。问在钉接话对象之前:输了的那一边什么都不碰。
         */
        const attributes = by === undefined ? undefined : room.remoteParticipants.get(by.identity)?.attributes
        const deviceId = by === undefined ? undefined : deviceIdOfParticipant({ identity: by.identity, ...(attributes === undefined ? {} : { attributes }) })
        const first = await answerFirst(
          { room: ticket.room, callAnswered: input => deps.workbench.callAnswered(input), ring, log },
          { callId, ...(deviceId === undefined ? {} : { deviceId }) },
        )
        if (!first.ok) return first
        if (by !== undefined) bindSpeaker(by.identity)
        const done = ring.answer(callId, by?.kind, by?.identity)
        if (done.ok) { invalidateSay(); sayCallId = callId; farewell?.reset(); listenAgain('接起来电') }
        /**
         * 接起来了也发一条**同样的** `call_state`(2026-09-23)。来电这条路上手机本来就靠
         * `ring_end{answered,by}` 进那一面,这一条是**同一张页的同一个入口** ——
         * 打进与打出从此走同一个状态,手机不必为两种来由各记一套。
         * 接不上(铃刚好超时)时一个字都不发:那一通没有开始过。
         */
        if (done.ok && by !== undefined) callState?.enter(by.kind, callId, by.identity)
        if (done.ok) syncListen('接起来电')
        return done
      },

      async later(callId) {
        if (ring === undefined) return { ok: false, error: '电脑上的事务官现在接不了话' }
        return ring.later(callId)
      },

      /**
       * **这台手机接起之后会报「我在放了」**(2026-09-28,卡 CF 第 4 条)。
       * 老手机不发那一格,于是这一下压根不会被调用 → 那道闸整个跳过。
       */
      expectPlaying(identity) {
        playingGate?.expect(identity)
      },

      /**
       * 手机说「我这边在放了」:开场白在等的就是它。`warmMs` 是它自己把通话输出烘热等了多久
       * (新包带,卡 OP)—— 只进日志。**拨出那一路这一条比接起先到**,闸那边记着(见 playingGate.ts)。
       */
      async playing(identity, warmMs) {
        playingGate?.arrived(identity, warmMs)
        return { ok: true }
      },

      /**
       * 挂断(2026-09-21;2026-09-22 多认一个 `by`)。
       *
       * 手机与树莓派话筒发的**是同一条** `{type:'call',action:'hangup'}`
       * (交接-0921-树莓派话筒进房 第三节:提机/挂机不另起名字)。谁发的由凭证里签的
       * `wb_kind` 分辨,而不是让设备自己在消息里报 —— 房里的自称一个字都不能信。
       */
      async hangup(by) {
        /**
         * 他挂的(或者她道别挂了之后他放下听筒、手机自己收场)。等着挂的那一下忘掉,
         * 关着的收音打开 —— 叉簧压回去了,听筒不再推音;下次拿起是新的一通。
         */
        farewell?.reset()
        listenAgain(by === 'handset' ? '听筒放下了' : '手机挂了')
        ring?.hangup(by === 'handset' ? 'handset' : 'phone')
        /**
         * 谁挂的都广播一条 `idle`(2026-09-23)。`ring.hangup` 那一条只管**来电**那一通
         * (而且手机自己挂的刻意不回声);拨出那一通它压根不知道,所以这一行不能省 ——
         * 手机上那面「话筒通话中 · 挂断」靠它收掉。
         */
        invalidateSay()
        callState?.leave(by === 'handset' ? 'handset' : 'phone')
        // 挂了:不在通话里就不听 —— 退订、关收音、火山当场断(收音闸)。
        syncListen(by === 'handset' ? '听筒放下了' : '手机挂了')
        // 挂断 = 这一通的纪要该交了(该报的才报,见 callRecord.ts)。
        callRecord.finish()
        announceHoldStop()
        // 这一通那道「在放了」的闸清掉:下一通重新等它自己那一下(卡 CF 第 4 条)。
        playingGate?.reset(by === 'handset' ? '听筒放下了' : '手机挂了')
        await takeOffRing().catch(() => { /* 换不回去下一通会带着上一通的来意,记一行就够 */ })
        return { ok: true }
      },
    }

    /**
     * ——— 「文字当成他说的话」测试口的那一头(2026-09-27,卡 TT) ———
     *
     * 三件事,都是**复用**:
     *   ① 还没开始通话就先开一通「虚拟来电」—— 走的是 `callPort.greet()`,
     *      也就是他提起听筒那一条**一模一样**的路(招呼、纪要起头、收音闸、提示词)。
     *      没带 `by`:房里压根没有那台设备,拿一个编出来的身份去钉接话对象是在撒谎
     *      (老手机那条不带身份的 `start` 走的就是这一支,所以这不是新路)。
     *      她的招呼会照常合成、照常往房里发 —— 没人订阅那条轨,没人听见,回合逻辑不知道区别。
     *   ② 一句话 = 一回合:`deliverTextTurn` 把它放在「ASR 定稿」那个位置上(textTurn.ts);
     *   ③ 挂断走 `callPort.hangup('phone')` —— 与手机真挂断同一条收尾(纪要、收音、换回提示词)。
     */
    textTurnPort = {
      async say(text) {
        const collector = new TextTurnCollector()
        if (session === undefined) return collector.fail('这一轮没有接话模型(没有嘴),这句话没送进去')
        if (!textTurnCallOn) {
          log('[channel-worker] 测试口:开一通虚拟来电(走的是提机那条路)')
          const greeted = await callPort?.greet()
          if (greeted !== undefined && !greeted.ok) return collector.fail(`这通虚拟来电没开起来:${greeted.error ?? '没说原因'}`)
          textTurnCallOn = true
        }
        log(`[channel-worker] 测试口:当成他说的话送进去 ——「${text.trim().slice(0, 120)}」`)
        textTurnCollector = collector
        const sent = deliverTextTurn({ text, caption, hear: said => hearFinalText(said, { typed: true }), session })
        if (!sent.ok) {
          textTurnCollector = undefined
          return collector.fail(sent.error)
        }
        const result = await collector.done()
        if (textTurnCollector === collector) textTurnCollector = undefined
        log(`[channel-worker] 测试口:这一回合跑完(${result.ms}ms,她说了 ${result.said.length} 段,调了 ${result.tools.length} 件工具${result.timedOut === true ? ',等到超时才收' : ''})`)
        return result
      },
      async hangup() {
        if (!textTurnCallOn) return { ok: false, error: '这会儿没有测试口开的那通虚拟来电' }
        textTurnCallOn = false
        log('[channel-worker] 测试口:挂掉这通虚拟来电(走的是手机挂断那条收尾)')
        return (await callPort?.hangup?.('phone')) ?? { ok: true }
      },
    }
  }

  /**
   * ——— 来 8791 领电话(2026-09-21) ———
   *
   * **房里没有手机就不领**。领走的那一通在台账上立刻变成「振铃中」,而没有人能听见它 ——
   * 三分钟后它会被扫成「未接」,那是在记一件没发生的事(他没错过任何一次响铃)。
   * 排着不动才是真话:座机一进房,排着的这就响。
   *
   * 没有接话模型时这根节拍整根不起:领了也没人开得了口。
   */
  /*
   * ★ 2026-10-22(局域网主路 M6):**按自己那间房领**(`ticket.room`)。本机房间与云房间各一条工人时同一通两边都领到、都响;
   * `answered_elsewhere` 里那几通在别的房间先接了,这边收铃(twoRooms.ts)。房里没设备照旧一个请求都不发。
   */
  const callTimer = setInterval(() => {
    void (async () => {
      if (ring === undefined) return
      await claimRoomTick({
        room: ticket.room,
        devicePresent: () => [...room.remoteParticipants.keys()].some(id => id.startsWith(PHONE_IDENTITY_PREFIX)),
        claim: one => deps.workbench.claimRoomCalls(one),
        ring,
        ack: (id) => { void deps.workbench.ackCall({ id, result: 'answered', room: ticket.room }) },
        log,
      })
    })()
  }, CALL_CLAIM_TICK_MS)

  /**
   * ——— 盯着音色变没变(2026-09-22)———
   *
   * 手机上那七句缓冲语是**按音色缓存在本地**的。人在 Mac 的配置后台里换了音色之后,
   * 她的回答立刻是新嗓子、垫场那几句还是旧的 —— 电话里于是有两个嗓子
   * (交接-0920 第六节第 1 条记的那个洞)。这一拍变了就广播一条,手机下次进房重取。
   *
   * 判断「变没变」在 filler.ts 的 VoiceWatcher(纯的,单测跑得完三条路)。
   */
  const voiceWatcher = new VoiceWatcher({
    read: () => deps.workbench.butlerVoice(),
    send: (signal) => {
      void room.localParticipant?.sendText(encodeFillerVoiceSignal(signal), { topic: RPC_TOPIC })
        .catch(() => { /* 和字幕同一条规矩:丢了不值得惊动谁,手机下次进房照样会问一遍 */ })
      /**
       * **开场白那几句也得跟着换嗓子**(2026-09-23)。缓存的是声音:不重合成的话,
       * 他刚在电话里换完音色、下一通提机听见的第一句还是旧的那个人 ——
       * 正是 09-20 记下的「一通电话里两个嗓子」那个洞,只是挪到了开场白上。
       */
      void greetings?.revoice(signal.voice).catch(() => { /* revoice 自己不抛 */ })
    },
    log,
  })
  /**
   * **房里有没有人都要问**(2026-09-23 下午改,原先是「房里有手机才问」)。
   *
   * 原先那道门是为了那条广播:没人听的时候广播一条 `filler_voice_changed` 没有意义。
   * 但从这一版起,这根节拍还管**第二件事** —— 开场白与「先应那一句」那张预合成缓存
   * (tts/greeting.ts)。他在 Mac 的配置后台里换音色时房里通常一个人都没有;
   * 那时不问,这张缓存就一直是旧嗓子,直到他下一次提机 —— 听见的第一句正是上一个人。
   * 维护者 2026-09-23 14:20 那句「音色和最开始听到的『吩咐』二字不一致」就是这条路。
   *
   * 代价:每 15 秒一条到 8791 的回环 HTTP(本机、几毫秒),以及一条发进空房间的广播
   * (`sendText` 自己吞掉,与字幕同一条规矩)。比「他换了音色而她不知道」便宜得多。
   */
  const voiceTimer = setInterval(() => {
    void voiceWatcher.tick()
  }, VOICE_WATCH_TICK_MS)

  /**
   * ——— 发文件:扫发件目录 ———
   *
   * 两层:根下那些**发给房里所有设备**(09-17 那版的行为,一个字没改);
   * `发给-XXX/` 里那些**只发那一台**(2026-09-21,他不用打命令、也不用记 identity,拖进去就行)。
   */
  /**
   * 上一拍还没发完就不起下一拍(2026-09-25,卡 J)。以前一个 40MB 的文件 3 秒发不完,
   * 下一拍又扫到它(还没挪进「已发送」),于是同一个文件被发了好几遍。
   */
  let outboxBusy = false
  const timer = setInterval(() => {
    if (outboxBusy) return
    outboxBusy = true
    void (async () => {
      // 房里没人就先攒着。2026-09-17 实测:工人比手机先起,第一拍就把文件发进了空房间,
      // 手机后脚进来什么也收不到——文件还被挪进了「已发送」,看起来像发成功了。
      if (room.remoteParticipants.size === 0) return
      const picks = await scanOutboxTargets({ dir: deps.outboxDir, devices: directory.others() })
      for (const pick of picks) {
        // 点名发的:走同一条 sendLocalFile(上限、隐藏文件、记录三样都在里头)。
        if (pick.to !== undefined) {
          const sent = await sendLocalFile({ path: pick.path, to: pick.to, by: 'outbox', name: pick.name })
          if (!sent.ok) { log(`[channel-worker] 发「${pick.name}」给 ${pick.to.name} 没成:${sent.error}`); continue }
          const moved = await markSent(pick.path)
          log(`[channel-worker] 发出文件「${pick.name}」→ ${pick.to.name}${moved ? '' : '(挪不进已发送,下一拍会重发)'}`)
          continue
        }
        // 广播的:一台一台发过去,这样每一台都留得下一条记录、每一台都按同一套上限把关。
        const targets = directory.others()
        if (targets.length === 0) continue
        let anyOk = false
        for (const target of targets) {
          const sent = await sendLocalFile({ path: pick.path, to: target, by: 'outbox', name: pick.name })
          if (sent.ok) anyOk = true
          else log(`[channel-worker] 发「${pick.name}」给 ${target.name} 没成:${sent.error}`)
        }
        if (!anyOk) continue
        const moved = await markSent(pick.path)
        log(`[channel-worker] 发出文件「${pick.name}」→ ${targets.map(t => t.name).join('、')}${moved ? '' : '(挪不进已发送,下一拍会重发)'}`)
      }
    })().finally(() => { outboxBusy = false })
  }, OUTBOX_TICK_MS)

  /**
   * 彻底断开(livekit-server 重启、网断了、被踢)。框架自己会先试着重连一阵子,走到这一步
   * 说明它放弃了 —— 那就整条重来:`onLost` 交给 main.ts,由它退避之后重新取凭证、重新进房。
   */
  let lost = false
  room.on(RoomEvent.Disconnected, () => {
    log('[channel-worker] 和房间断开了')
    if (lost) return
    lost = true
    clearInterval(timer)
    clearInterval(callTimer)
    clearInterval(voiceTimer)
    stopDevicesHeartbeat()
    // 掉线了:正响着的那一通取消掉。**不按未接记** —— 那不是他错过的,是房间断了。
    farewell?.reset()
    ring?.cancel('和房间断开了,这一通没打成')
    invalidateSay()
    callState?.leave('worker')
    // 房间都没了:火山那条连接也当场断(收音闸),别等 10 秒空闲。
    syncListen('和房间断开了')
    // 正在通话里断的:纪要照交(8791 在回环上,房间断了不影响)。半份纪要也是纪要。
    callRecord.finish()
    deps.onLost?.()
  })

  return {
    room,
    ...(decisionPublisher.qa === undefined ? {} : { roomDecisionReplay: decisionPublisher.qa }),
    ...(session === undefined ? {} : { session }),
    ...(textTurnPort === undefined ? {} : { textTurn: textTurnPort }),
    inCall: () => callState?.current() !== undefined || onboardingOn,
    async close() {
      clearInterval(timer)
      clearInterval(callTimer)
      clearInterval(voiceTimer)
      stopDevicesHeartbeat()
      farewell?.reset()
      ring?.cancel('工人要退出了,这一通没打成')
      invalidateSay()
      callState?.leave('worker')
      syncListen('工人要退出了')
      callRecord.finish()
      try { await session?.close?.() } catch { /* 关不掉也要继续断房 */ }
      try { await room.disconnect() } catch { /* 已经断了 */ }
    },
  }
}

/**
 * 换提示词没换上时她当场说的那一句(2026-09-24)。手机早已算接通,回话里带不回这件事,
 * 所以用说的(字幕同出);技术原因只进日志。
 */
export const ONBOARDING_WEAR_FAILED_LINE = '抱歉,引导这边没接好。先挂断,过一会儿再打给我,我们从这儿接着聊。'
/** 那之后他再打字,手机上显示的那句。 */
export const ONBOARDING_WEAR_FAILED_REPLY = '引导没接好,这句话没送进去;挂断再打一次就能接着聊'

/** 引导那一通开场要用到的每一步。纯编排,不认识 LiveKit:agent.ts 注入真的,用例注入假的。 */
export interface OnboardingBeginSteps {
  /** 取一份简报;取不到回一句能说出口的话。 */
  fetchBrief: () => Promise<{ ok: true, brief: OnboardingBrief } | { ok: false, error: string }>
  /** 这一通进引导了:记下简报、置位、道别与收音重置、告诉工作台归手机(发出去不等)。 */
  open: (brief: OnboardingBrief) => void
  /** 开场白:工人当场说(现合成),并记「说过了」(发出去不等)。 */
  speakSeed: (seed: string, stage: string) => void
  /** 换上引导那套提示词与工具。 */
  wear: (brief: OnboardingBrief) => Promise<void>
  /** 这一通还在引导吗(挂断、手机离开、换失败之后都不在了)。 */
  stillOn: () => boolean
  /** 接着做那一句(不重说开场白,只问还没答的那一题)—— 要新提示词。 */
  resumeReply: () => void
  /** 换提示词失败之后:说一句人话、换回平时那套。 */
  wearFailed: (why: string) => Promise<void>
  log: (line: string) => void
}

export interface OnboardingBeginOutcome {
  /** 回给手机的那一条。手机拿到就算接通。 */
  reply: { ok: boolean, stage?: string, error?: string, leader?: 'desktop' }
  /** 后台换提示词那一段;落定为 true = 换上了,不抛。没进引导(取不到简报 / 做完了 / 归电脑管)时缺席。 */
  wearing?: Promise<boolean>
}

/**
 * ——— 引导那一通的开场顺序(2026-09-24,卡 `fix/onboarding-call-same-as-call`)———
 *
 * 维护者:「现在手机端的通话,好像引导和平时电话不是同一套?」两通用的是同一张页、同一套光,
 * 差在时序:手机要拿到这一条的回话才算接通(butler-app `livekitCall.ts`),以前回话排在
 * 「换引导提示词」后面 —— 换的那一下慢时,她已经在念开场白,手机上还是「正在接通…」、
 * 球是工作态、底边还在来回扫。平时电话不等这一步。
 *
 * 现在**先回话,换提示词在后台接着做**:回话在开场白发出去那一刻就落定(与平时电话同一时机)。
 * 原来的四条正确性照旧:
 *   1. **开场白只说一次**:工人当场说;换上的提示词按「已经说过了」拼(`speak_seed:false`),
 *      模型不会再念一遍(2026-09-20 本机逐字记录里连说两遍的那个坑);
 *   2. **接着做那一句排在换完之后**(它要新提示词才知道做到哪);换完时这一通已经停了就不说;
 *   3. **换失败**:日志一行原因 + 她当场说一句人话(字幕同出)+ 换回平时那套,不装作还在引导;
 *   4. **归电脑管**:一个字都不说、什么都不换,如实回 `leader:'desktop'`(与以前一模一样)。
 * 同一通里又开一次(「改回手机」)时先等上一次换完,两下不交错。
 */
export async function beginOnboardingCall(steps: OnboardingBeginSteps, previous?: Promise<boolean>): Promise<OnboardingBeginOutcome> {
  const got = await steps.fetchBrief()
  if (!got.ok) return { reply: { ok: false, error: got.error } }
  const brief = got.brief
  if (brief.done) return { reply: { ok: true, stage: 'done' } }
  /**
   * **电脑在做就别抢**(2026-09-18)。谁主导只是界面归属,两端共用同一份 onboarding.json;
   * 但两边同时问同一件事是 Ben 明确说奇怪的那个毛病。归电脑管时工人一个字都不说,
   * 把这一格如实回给手机,由它显示「电脑上在做,先别说」+ 一颗「改回手机」。
   */
  if (leadsOnDesktop(brief)) {
    steps.log('[channel-worker] 引导这会儿归电脑管,手机这通不开口。')
    return { reply: { ok: true, stage: brief.stage, leader: 'desktop' } }
  }
  steps.open(brief)
  steps.log(`[channel-worker] 引导接上了:${brief.label}${brief.speak_seed ? '(这一段的话还没出过声,这就说)' : '(接着上次,不重说)'}`)
  const seed = brief.speak_seed ? brief.seed : undefined
  if (seed !== undefined) steps.speakSeed(seed, brief.stage)
  const spokeSeed = seed !== undefined
  /**
   * 提示词换在开口之后、回话之前**开始**,但回话不等它换完。
   * **工人刚说过的那一句,提示词里就不能再写「开口就说这句」**(2026-09-20 本机真跑):
   * 简报是开口之前取的,那时 `speak_seed` 还是 true;落盘那一笔是异步的,等它回来再拼等于又慢一拍,
   * 所以这里直接按「已经说过了」拼 —— 这一句是不是出过声,工人自己最清楚。
   */
  const wearing = (async (): Promise<boolean> => {
    if (previous !== undefined) await previous
    try {
      await steps.wear(spokeSeed ? { ...brief, speak_seed: false } : brief)
    }
    catch (err) {
      const why = (err as Error)?.message || '没说原因'
      steps.log(`[channel-worker] 引导的提示词没换上:${why}`)
      if (steps.stillOn()) {
        try { await steps.wearFailed(why) }
        catch (again) { steps.log(`[channel-worker] 换失败之后的收场也没做完:${(again as Error)?.message || '没说原因'}`) }
      }
      return false
    }
    if (!spokeSeed && steps.stillOn()) steps.resumeReply()
    return true
  })()
  return { reply: { ok: true, stage: brief.stage }, wearing }
}
