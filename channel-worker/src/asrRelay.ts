/**
 * 出了局域网也能「按住说话」(2026-09-25,卡 S `fix/phone-voice-anywhere`)。
 *
 * 维护者放假在外,手机远程用正是核心场景(「通过事务官去下发、通过事务官去验收,这样子的话我其实放不放假没区别」)。
 * 09-24 那一版出了局域网,按住说话必然转不了文字:房间代理故意不放 `/butler/proxy/**`,屏上只剩一句
 * 「不在同一个网络」。这里给识别**专门开一条走房间的路**;通用代理的白名单照旧不放 `/butler/proxy/**`。
 *
 * ## 一段录音怎么走
 *
 *   手机 ──wb.rpc──▶ `{ id, type:'asr' }`                   几十字节:「我要识别一段,编号 id」
 *   手机 ──wb.asr──▶ 字节流,**只发给工人**,流上属性 `wb_asr_id = id`   WAV 本身(16k 单声道,5 秒约 160KB)
 *   工人:信箱按「谁发的 + id」把两样对上 → 查(配对过的手机 / WAV / ≤20 秒 / ≤大小上限)
 *        → 以**那台手机的身份**(`X-Workbench-Channel-Device`)POST 8791 的 `/butler/proxy/api/asr`
 *          —— 与局域网直连是同一条路、同一个后端(butler-server `/api/asr`)、同一道设备门:
 *          手机被解除配对,8791 当场 401,房间凭证还没过期也没用(rpc.ts 文件头那条「降权」)。
 *   工人 ──wb.rpc──▶ `{ id, type:'http', status, body }`      与 http 代理同一个形状,手机照直连的口径读
 *
 * ## 为什么用字节流,不自己分片
 *
 * `wb.rpc` 是文本数据流,LiveKit 的 RPC(`performRpc`)单包 15KiB 封顶;一段 20 秒的录音 640KB。
 *   1. **二进制原样走**:塞进 JSON 得先 base64,多 33%(20 秒 640KB → 850KB)。在外面,上传是整条路上唯一
 *      看网络脸色的一段,少三成字节就是少三成等待,弱网上差得出半秒以上。
 *   2. **分块、重组、顺序、校验由 LiveKit 做**(15KB 一块,可靠有序):自己分片就要自己写编号、缺片、
 *      乱序、半截丢了谁来收拾 —— 一整套没人测过的协议,换来的只是和字节流一样的效果。
 *   3. **大小在流头上就知道**:超上限的当场关掉不收(自己分片要收到最后一片才知道总共多大)。
 *   4. **只发给工人**(destinationIdentities):录音不会被房里另一台电脑、那只树莓派听筒收到;
 *      也不进 `wb.rpc` 那条大家共用的 JSON 通道。
 *   5. 这条路手机与工人早就在走:在外面发附件就是 `wb.file` 字节流(卡 J)。
 *
 * ## 为什么还要 `wb.rpc` 那条小消息
 *
 * **老工人不认 `asr`,当场回一句「不认识这种请求:asr」** —— 手机据此说「电脑上的事务官要更新」,
 * 而不是干等:老工人对没注册的字节流 topic 一声不吭地丢掉,手机只能等到超时,再说一句不对的「等太久」。
 * 顺带让回包、日志、「不认这台手机」这几样都走 `wb.rpc` 原有的那一套(rpc.ts 的 handleRpcRequest)。
 *
 * 两样谁先到都行:信箱先收下的等请求来取;请求先到的等录音进来(最多 {@link ASR_STREAM_WAIT_MS})。
 *
 * ## 这个文件里有什么
 *
 * 全是不碰 LiveKit 的纯函数与小对象:信箱、读流(带上限)、看 WAV 多长、交给 8791、`RpcAsrPort` 的实现。
 * 房间那一层(注册 `wb.asr` 的字节流、把它接到信箱)在 agent.ts 里,只有几行。
 */
import type { RpcAsrPort } from './rpc.ts'
import { CHANNEL_DEVICE_HEADER } from './workbench.ts'

/** 录音那条字节流的 topic。两端唯一的约定(手机那一侧是 butler-app/src/channel/channelProtocol.ts 的 WBCH_ASR_TOPIC)。 */
export const ASR_TOPIC = 'wb.asr'

/** 流上带编号的那个属性名。同上,两端逐字一样。 */
export const ASR_ID_ATTRIBUTE = 'wb_asr_id'

/** 交给 8791 的那条路 —— 与手机在局域网里直连打的是**同一条**。 */
export const ASR_PATH = '/butler/proxy/api/asr'

/** 一段最长多少秒。手机的录音机到 20 秒自己停(butler-app/src/aiboo/useVoiceRecorder.ts 的 MAX_DURATION_MS)。 */
export const ASR_MAX_SECONDS = 20

/** 录音机到点才停,最后一块采样可能多出几十毫秒;这一点余量不算「超过 20 秒」。 */
const ASR_SECONDS_SLACK = 1

/** 一段最多多少字节:16k 单声道 16 位 21 秒 + WAV 头与一点余量。约 660KB。 */
export const ASR_MAX_BYTES = 16000 * 2 * (ASR_MAX_SECONDS + ASR_SECONDS_SLACK) + 4096

/**
 * 请求到了、录音还没到:最多等多久。20 秒的录音 640KB,在 0.5Mbps 的弱网上要传十来秒;再久就是没传过来。
 */
export const ASR_STREAM_WAIT_MS = 12_000

/**
 * 交给 8791 之后最多等多久。火山这条一句话识别本机实测约 0.55 倍实时(butler-server volcAsr.cjs 的注释),
 * 20 秒的录音十一二秒出字;给到 20 秒,再久就如实说「等太久」。手机那一侧等 35 秒(12 + 20 + 余量)。
 */
export const ASR_BACKEND_TIMEOUT_MS = 20_000

/** 信箱里没人来取的录音留多久。请求丢了(手机那一刻断网)的那一份,过了这么久就扔。 */
const ASR_KEEP_MS = 30_000

/** 同一台手机最多在信箱里压几段。手机一次只识别一段,压多了只可能是出了毛病。 */
const ASR_KEEP_PER_SENDER = 2

// ———— 回给手机的那几句话(手机按 status 分类,另有自己的说法;这几句进日志,也是老手机看到的原话) ————

export const ASR_TOO_BIG_TEXT = `这段录音太大了(最多 ${ASR_MAX_SECONDS} 秒)`
export const ASR_TOO_LONG_TEXT = `这段超过 ${ASR_MAX_SECONDS} 秒了,分两段说`
export const ASR_NOT_WAV_TEXT = '这段录音的格式电脑认不出来'
export const ASR_AUDIO_MISSING_TEXT = '录音没传到电脑上(网可能慢)'
export const ASR_AUDIO_BROKEN_TEXT = '录音传到一半断了'
export const ASR_BACKEND_SLOW_TEXT = '电脑上的识别等太久没回'
export const ASR_BACKEND_DOWN_TEXT = '电脑上的工作台没接这一段(连不上)'

/** 信箱里的一份:收齐了的录音,或者一句收不齐的原因(带着要回给手机的 status)。 */
export type AsrAudio =
  | { ok: true, bytes: Uint8Array, mime: string }
  | { ok: false, status: number, error: string }

export interface AsrMailbox {
  /** 字节流那一侧:收齐了(或收坏了)就放进来。有人在等就当场交给他。 */
  put: (sender: string, id: string, audio: AsrAudio) => void
  /** 请求那一侧:取这一段。还没到就等最多 `waitMs`;到点没来回 undefined。 */
  take: (sender: string, id: string, waitMs: number) => Promise<AsrAudio | undefined>
  /** 信箱里压着几份(测试 / 日志用)。 */
  size: () => number
}

interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const REAL_TIMERS: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    // 信箱的定时器不该拦住工人退出。
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * 录音与请求在这里碰头。**按「谁发的 + 编号」对**:编号是手机编的,光看编号的话,
 * 房里另一台设备报一个一样的编号就能把别人的录音领走 —— 发件人是 LiveKit 按凭证认的,改不了。
 */
export function createAsrMailbox(options: { keepMs?: number, maxPerSender?: number, timers?: Timers } = {}): AsrMailbox {
  const keepMs = options.keepMs ?? ASR_KEEP_MS
  const maxPerSender = options.maxPerSender ?? ASR_KEEP_PER_SENDER
  const timers = options.timers ?? REAL_TIMERS
  const kept = new Map<string, { sender: string, audio: AsrAudio, timer: unknown }>()
  const waiting = new Map<string, { resolve: (audio: AsrAudio | undefined) => void, timer: unknown }>()
  const keyOf = (sender: string, id: string): string => `${sender}\n${id}`

  return {
    put(sender, id, audio) {
      const key = keyOf(sender, id)
      const waiter = waiting.get(key)
      if (waiter !== undefined) {
        waiting.delete(key)
        timers.clear(waiter.timer)
        waiter.resolve(audio)
        return
      }
      const old = kept.get(key)
      if (old !== undefined) timers.clear(old.timer)
      kept.set(key, { sender, audio, timer: timers.set(() => { kept.delete(key) }, keepMs) })
      // 同一台压太多:扔最早的那几份(Map 按放进来的顺序排)。
      const mine = [...kept.entries()].filter(([, entry]) => entry.sender === sender)
      for (const [staleKey, entry] of mine.slice(0, Math.max(0, mine.length - maxPerSender))) {
        timers.clear(entry.timer)
        kept.delete(staleKey)
      }
    },

    take(sender, id, waitMs) {
      const key = keyOf(sender, id)
      const ready = kept.get(key)
      if (ready !== undefined) {
        kept.delete(key)
        timers.clear(ready.timer)
        return Promise.resolve(ready.audio)
      }
      // 同一个编号又来一次请求(手机重发):前一个等的人先放掉,别让它悬着。
      const previous = waiting.get(key)
      if (previous !== undefined) {
        waiting.delete(key)
        timers.clear(previous.timer)
        previous.resolve(undefined)
      }
      return new Promise((resolve) => {
        const timer = timers.set(() => {
          if (waiting.get(key)?.resolve !== resolve) return
          waiting.delete(key)
          resolve(undefined)
        }, waitMs)
        waiting.set(key, { resolve, timer })
      })
    },

    size: () => kept.size,
  }
}

/** 读流用到的那一点(rtc-node 的 ByteStreamReader 就是这个形状;测试给一个假的)。 */
export interface AsrStreamReader extends AsyncIterable<Uint8Array> {
  info: { totalSize?: number, attributes?: Record<string, string>, mimeType?: string }
  close?: () => Promise<void>
}

/**
 * 把一条录音流读完,**超上限当场停**。流头上报的大小先看一眼:超了连读都不读。
 * 读的时候再数一遍:报的大小可能不准(或者没报),不能只信它。
 */
export async function readAsrStream(reader: AsrStreamReader, maxBytes: number = ASR_MAX_BYTES): Promise<AsrAudio> {
  const declared = reader.info.totalSize
  if (typeof declared === 'number' && declared > maxBytes) {
    await reader.close?.().catch(() => {})
    return { ok: false, status: 413, error: ASR_TOO_BIG_TEXT }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const chunk of reader) {
      total += chunk.byteLength
      // 超了就停:跳出 for-await 会把读的那一头关掉(rtc-node 的约定),剩下的字节不再进内存。
      if (total > maxBytes) return { ok: false, status: 413, error: ASR_TOO_BIG_TEXT }
      chunks.push(chunk)
    }
  }
  catch {
    // 408:没传完整 —— 手机那边归成「等太久 / 网可能慢,再说一遍」,不是「识别服务坏了」。
    return { ok: false, status: 408, error: ASR_AUDIO_BROKEN_TEXT }
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  const mime = typeof reader.info.mimeType === 'string' && reader.info.mimeType !== '' ? reader.info.mimeType : 'audio/wav'
  return { ok: true, bytes, mime }
}

/**
 * 一段 WAV 有多长(秒)。只认 PCM 的 RIFF/WAVE —— 手机的录音机出的就是它(16k / 16 位 / 单声道)。
 * 认不出来就如实说认不出来,不猜:猜错的代价是把一段噪音交给识别、白烧一次额度。
 */
export function wavSeconds(bytes: Uint8Array): { ok: true, seconds: number } | { ok: false, error: string } {
  if (bytes.byteLength < 44) return { ok: false, error: ASR_NOT_WAV_TEXT }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number): string => String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0)
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return { ok: false, error: ASR_NOT_WAV_TEXT }
  let byteRate = 0
  let dataBytes: number | undefined
  let at = 12
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ' && at + 8 + 16 <= bytes.byteLength) {
      const format = view.getUint16(at + 8, true)
      if (format !== 1) return { ok: false, error: ASR_NOT_WAV_TEXT }
      byteRate = view.getUint32(at + 16, true)
    }
    if (id === 'data') {
      // 头里写的长度可能比实际多(录音机按预估写):以真有的字节为准。
      dataBytes = Math.min(size, bytes.byteLength - (at + 8))
      break
    }
    at += 8 + size + (size % 2)
  }
  if (byteRate <= 0 || dataBytes === undefined) return { ok: false, error: ASR_NOT_WAV_TEXT }
  return { ok: true, seconds: dataBytes / byteRate }
}

/** 以那台手机的身份把录音交给 8791。回的是 8791 原样的 status + body。 */
export type AsrPoster = (input: { deviceId: string, audio: Uint8Array, mime: string, signal: AbortSignal }) => Promise<{ status: number, body: unknown }>

/**
 * 交给 8791 的那一下。**原样的 WAV 字节**(`content-type: audio/wav`),不转 base64:
 * butler-server 的 `/api/asr` 本来就收裸 WAV(与 JSON base64 两种都认),8791 的代理原样转过去。
 */
export function workbenchAsrPoster(input: { workbenchUrl: string, fetchImpl?: typeof fetch }): AsrPoster {
  const doFetch = input.fetchImpl ?? fetch
  const base = input.workbenchUrl.replace(/\/+$/, '')
  return async ({ deviceId, audio, mime, signal }) => {
    const res = await doFetch(`${base}${ASR_PATH}`, {
      method: 'POST',
      headers: { [CHANNEL_DEVICE_HEADER]: deviceId, 'content-type': mime },
      body: audio,
      signal,
    })
    const raw = await res.text()
    let body: unknown = {}
    try { body = raw === '' ? {} : JSON.parse(raw) }
    catch { body = { error: '识别服务回了一段读不懂的内容' } }
    return { status: res.status, body }
  }
}

export interface AsrRelayDeps {
  mailbox: AsrMailbox
  post: AsrPoster
  /** 请求到了等录音多久。缺省 {@link ASR_STREAM_WAIT_MS}。 */
  streamWaitMs?: number
  /** 交给 8791 之后等多久。缺省 {@link ASR_BACKEND_TIMEOUT_MS}。 */
  backendTimeoutMs?: number
  log?: (line: string) => void
  now?: () => number
}

/**
 * `wb.rpc` 那条 `type:'asr'` 的实现(rpc.ts 的 `RpcAsrPort`)。**绝不抛**:每一种没办成都回一个 status + 一句话。
 *
 * 日志只记长短、字节、耗时和 status,**不记识别出来的字** —— 那是他说的话;
 * 要看他说了什么,手机屏上、事项里都有。
 */
export function createAsrRelay(deps: AsrRelayDeps): RpcAsrPort {
  const streamWaitMs = deps.streamWaitMs ?? ASR_STREAM_WAIT_MS
  const backendTimeoutMs = deps.backendTimeoutMs ?? ASR_BACKEND_TIMEOUT_MS
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? (() => {})

  return {
    async transcribe({ id, deviceId, identity }) {
      const started = now()
      const audio = await deps.mailbox.take(identity, id, streamWaitMs)
      const waited = now() - started
      if (audio === undefined) {
        log(`[channel-worker] 识别代转 ← ${identity}:等了 ${waited}ms 录音没到 → 408`)
        return { status: 408, body: { error: ASR_AUDIO_MISSING_TEXT } }
      }
      if (!audio.ok) {
        log(`[channel-worker] 识别代转 ← ${identity}:录音没收成(${audio.error})→ ${audio.status}`)
        return { status: audio.status, body: { error: audio.error } }
      }
      const wav = wavSeconds(audio.bytes)
      if (!wav.ok) {
        log(`[channel-worker] 识别代转 ← ${identity}:${Math.round(audio.bytes.byteLength / 1024)}KB 不是认得的 WAV → 415`)
        return { status: 415, body: { error: wav.error } }
      }
      const seconds = Math.round(wav.seconds * 10) / 10
      if (wav.seconds > ASR_MAX_SECONDS + ASR_SECONDS_SLACK) {
        log(`[channel-worker] 识别代转 ← ${identity}:${seconds} 秒,超过 ${ASR_MAX_SECONDS} 秒 → 413`)
        return { status: 413, body: { code: 'audio_too_long', error: ASR_TOO_LONG_TEXT } }
      }
      const posted = now()
      let result: { status: number, body: unknown }
      try {
        result = await deps.post({ deviceId, audio: audio.bytes, mime: audio.mime, signal: AbortSignal.timeout(backendTimeoutMs) })
      }
      catch (err) {
        const name = (err as { name?: unknown } | null)?.name
        const timedOut = name === 'TimeoutError' || name === 'AbortError'
        log(`[channel-worker] 识别代转 ← ${identity}:${seconds} 秒 · ${timedOut ? `等了 ${now() - posted}ms 没回 → 504` : '连不上工作台 → 502'}`)
        return timedOut
          ? { status: 504, body: { error: ASR_BACKEND_SLOW_TEXT } }
          : { status: 502, body: { error: ASR_BACKEND_DOWN_TEXT } }
      }
      const chars = typeof (result.body as { text?: unknown } | null)?.text === 'string' ? ((result.body as { text: string }).text.trim().length) : undefined
      log(`[channel-worker] 识别代转 ← ${identity}:${seconds} 秒 · ${Math.round(audio.bytes.byteLength / 1024)}KB · 等录音 ${waited}ms · 识别 ${now() - posted}ms → ${result.status}${chars === undefined ? '' : `(${chars} 字)`}`)
      return result
    },
  }
}

/**
 * `wb.asr` 字节流的接法(agent.ts 注册它)。**不是配对过的手机发来的一律不收**(那一头的 `wb.rpc`
 * 请求也会被回「不认这台手机」);只有第一台电脑收(同 `wb.rpc` 的 primaryWorker 规矩)。
 */
export function createAsrStreamHandler(deps: {
  mailbox: AsrMailbox
  /** 这台工人是不是房里替手机办事的那一个(第二台电脑不收)。 */
  primary: boolean
  /** 这个身份是哪台已配对的手机;不是就 undefined。agent.ts 用 rpc.ts 的 deviceIdOfParticipant 查。 */
  deviceOf: (identity: string) => string | undefined
  maxBytes?: number
  /** 流上带编号的属性名。缺省 {@link ASR_ID_ATTRIBUTE};会议分段那条(meetingRelay.ts)换成它自己的。 */
  idAttribute?: string
  log?: (line: string) => void
}): (reader: AsrStreamReader, participant: { identity: string }) => void {
  const log = deps.log ?? (() => {})
  const idAttribute = deps.idAttribute ?? ASR_ID_ATTRIBUTE
  return (reader, participant) => {
    void (async () => {
      const id = reader.info.attributes?.[idAttribute]
      if (!deps.primary || deps.deviceOf(participant.identity) === undefined || typeof id !== 'string' || id === '' || id.length > 200) {
        if (deps.primary) log(`[channel-worker] ${participant.identity} 发来一段录音,但${deps.deviceOf(participant.identity) === undefined ? '它不是一台已配对的手机' : '流上没带编号'},不收`)
        await reader.close?.().catch(() => {})
        return
      }
      deps.mailbox.put(participant.identity, id, await readAsrStream(reader, deps.maxBytes))
    })()
  }
}
