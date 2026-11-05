/**
 * 一条火山流式 ASR 的 WebSocket 会话。协议帧见 volcProtocol.ts;这里只管**时序**:
 *
 *   连上 → 发一帧开场请求 → 边说边 push PCM → 说完 finish() 发最后一包 → 收最终结果。
 *
 * 一句话**说完了**有两条路,两条都走 `onFinal`:
 *   ① **判停**(2026-09-18 补的):火山自己在 `utterances[]` 里标 `definite: true` ——
 *      这是电话里唯一会自己发生的那一条,连接照旧不关,他接着说下一句;
 *   ② **最后一包**(负序号 flag):我们 `finish()` 之后服务端的收尾,那之后连接就关了。
 * 其余带正序号回来的都是中间结果,走 `onInterim`。
 * 打断靠上层:`close()` 立刻断,不等服务端。
 *
 * **绝不抛**:连不上、帧坏了、服务端回错误,全部变成一次 `onError(一句人话)` 加一次 `onClose()`。
 * 电话里 ASR 挂了应该是「这句没听清」,不该是整个进程崩掉。
 *
 * WebSocket 由外面注入(`wsFactory`),测试里换成连本地假服务端的那一个 —— 火山的密钥本机没有,
 * 这条链路只能这么验;真接火山那一步如实记「未跑」。
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  FLAG_NEG_WITH_SEQUENCE,
  MSG_FULL_SERVER,
  MSG_SERVER_ACK,
  MSG_SERVER_ERROR,
  PCM_CHUNK_BYTES,
  SILENCE_CHUNK,
  VOLC_PACKET_MS,
  buildAudioFrame,
  buildStartFrame,
  definiteTranscriptOf,
  errorMessageOf,
  parseFrame,
  transcriptOf,
} from './volcProtocol.ts'

export interface VolcAsrCreds {
  appId: string
  accessToken: string
  resourceId: string
}

export interface VolcAsrHandlers {
  /** 中间结果。同一句话会来很多次,每次都是**到目前为止**的全文。 */
  onInterim?: (text: string) => void
  /**
   * 一句说完了(判停,或者收尾那一包)。一句来一次,**一条连接上可以来很多次**;
   * 服务端没给文字时不调。
   */
  onFinal?: (text: string) => void
  /** 出事了。一句人话,已经带上 code。 */
  onError?: (message: string) => void
  /** 连接结束(正常或异常都会调一次,且只调一次)。 */
  onClose?: () => void
}

export interface VolcAsrSession {
  /** 推一段 PCM(16k/16bit/mono)。内部按 200ms 切包。 */
  push: (pcm: Buffer) => void
  /** 说完了:把剩下的连同「最后一包」标记一起发出去。 */
  finish: () => void
  /** 立刻断(打断、或者上层不要了)。 */
  close: () => void
}

export interface OpenVolcAsrInput {
  url: string
  creds: VolcAsrCreds
  hotwords?: readonly string[]
  /** 这条连接开场时带给火山的对话上下文(见 volcProtocol.ts 的 buildCorpus)。 */
  dialog?: readonly string[]
  handlers: VolcAsrHandlers
  /** 测试注入:返回一个 ws 风格的对象。缺省用真的 ws。 */
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocket
  /** 心跳包的间隔。缺省 {@link VOLC_PACKET_MS};测试调小。 */
  packetMs?: number
}

/** 极小的 ws 子集,够测试造一个假的。 */
interface MinimalSocket {
  on: (event: string, handler: (...args: never[]) => void) => unknown
  send: (data: Buffer) => void
  close: () => void
  readyState: number
}

export function openVolcAsrSession(input: OpenVolcAsrInput): VolcAsrSession {
  const { handlers } = input
  const headers = {
    'X-Api-App-Key': input.creds.appId,
    'X-Api-Access-Key': input.creds.accessToken,
    'X-Api-Resource-Id': input.creds.resourceId,
    'X-Api-Request-Id': randomUUID(),
    'X-Api-Connect-Id': randomUUID(),
  }
  const factory = input.wsFactory ?? ((url: string, h: Record<string, string>) => new WebSocket(url, { headers: h }))
  const ws = factory(input.url, headers) as unknown as MinimalSocket

  /** 开场帧发出去之前攒着的 PCM。连接是异步的,他可能已经在说了。 */
  let pending: Buffer = Buffer.alloc(0)
  let opened = false
  let closed = false
  /** 序号从 1 开始(1 是开场帧),音频从 2 起。 */
  let sequence = 1
  let finishing = false

  function finishOnce(): void {
    if (closed) return
    closed = true
    stopKeepalive()
    try { ws.close() } catch { /* 已经断了 */ }
    handlers.onClose?.()
  }

  function sendChunk(chunk: Buffer, last: boolean): void {
    sequence += 1
    lastSentAt = Date.now()
    try { ws.send(buildAudioFrame(chunk, sequence, last)) }
    catch { /* 断了:close 事件会收尾 */ }
  }

  /**
   * ——— 心跳静音包(2026-09-20:`45000081 等包超时` 的解药) ———
   *
   * Ben 真机第二轮那一通里连着 17 条 `火山 ASR 错误(45000081)`,那段时间她一个字都听不见。
   * 查清了:45000081 官方逐字是**「等包超时」**(《大模型流式语音识别API》与《同声传译2.0》
   * 两篇文档里同一张表)。也就是说**服务端在等我们的下一包音频,等到超时**。
   *
   * 我们这头为什么会断流:这条 WebSocket 一开就用着,而音频是**框架喂进来的**——
   * 换接话对象、房里一时没人、手机把麦克风收了、App 被切到后台,任何一样都会让
   * `for await (const item of this.input)` 停住;连接还开着,包却一个都不发了。
   * 服务端只知道「等不到包」,于是回一个 45000081、断线;下一帧音频又重开一条,再等、再断 ——
   * 正是日志里那 17 条的形状。
   *
   * 解药就是官方文档自己那句建议(逐字):「单包音频大小建议在100~200ms左右,
   * **发包间隔建议100～200ms,不能过大或者过小**」。所以只要这条会话还开着,
   * 就保证每 {@link VOLC_PACKET_MS} 至少有一包出去 —— 手里没有真音频就补一包静音。
   *
   * 这**不会**让连接永远挂着:房里真没人时 volcStt.ts 的空闲计时器(10 秒)照样把整条会话收掉,
   * 心跳跟着停。心跳只保证「开着的时候不断流」,不保证「一直开着」。
   */
  const packetMs = input.packetMs ?? VOLC_PACKET_MS
  let lastSentAt = 0
  let keepalive: ReturnType<typeof setInterval> | undefined

  function startKeepalive(): void {
    if (keepalive !== undefined) return
    keepalive = setInterval(() => {
      // 收尾中(最后一包已经发过)或者已经断了都不要再补:那会在协议上跟在最后一包后面。
      if (!opened || closed || finishing) return
      if (Date.now() - lastSentAt < packetMs) return
      sendChunk(SILENCE_CHUNK, false)
    }, packetMs)
    keepalive.unref?.()
  }

  function stopKeepalive(): void {
    if (keepalive === undefined) return
    clearInterval(keepalive)
    keepalive = undefined
  }

  /** 把 pending 里够一包的都发掉。`flush` 为真时连不满一包的尾巴也发,并标最后一包。 */
  function drain(flush: boolean): void {
    if (!opened || closed) return
    while (pending.length >= PCM_CHUNK_BYTES) {
      const chunk = pending.subarray(0, PCM_CHUNK_BYTES)
      pending = pending.subarray(PCM_CHUNK_BYTES)
      // 尾巴恰好为空且正在收尾时,这一包就是最后一包。
      const last = flush && pending.length === 0
      sendChunk(chunk, last)
      if (last) return
    }
    if (!flush) return
    // 一个字节都没剩也要发一包空的:协议里「最后一包」是个标记,不是「有内容的最后一段」。
    const tail = pending
    pending = Buffer.alloc(0)
    sendChunk(tail, true)
  }

  ws.on('open', (() => {
    opened = true
    try { ws.send(buildStartFrame(input.hotwords ?? [], input.dialog === undefined ? {} : { dialog: input.dialog })) }
    catch {
      handlers.onError?.('火山 ASR:开场帧发不出去')
      finishOnce()
      return
    }
    lastSentAt = Date.now()
    drain(finishing)
    if (!finishing) startKeepalive()
  }) as (...args: never[]) => void)

  ws.on('message', ((data: Buffer) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer)
    const frame = parseFrame(buf)
    if (frame.messageType === MSG_SERVER_ERROR) {
      handlers.onError?.(errorMessageOf(frame))
      finishOnce()
      return
    }
    if (frame.messageType !== MSG_FULL_SERVER && frame.messageType !== MSG_SERVER_ACK) return
    const definite = definiteTranscriptOf(frame)
    if (frame.flags === FLAG_NEG_WITH_SEQUENCE) {
      const text = definite ?? transcriptOf(frame)
      if (text !== undefined) handlers.onFinal?.(text)
      finishOnce()
      return
    }
    /**
     * **判停 ≠ 挂电话**(2026-09-18「引导不理我」)。火山说的是「这一句他说完了」,
     * 连接要**接着用**:他马上还要说下一句,重开一条要一次握手,中间那点声音会漏掉。
     *
     * 以前这里只有「最后一包」一条路能出 onFinal,而最后一包只在 `finish()` 时发,
     * `finish()` 只在框架 flush 时调 —— 框架**从不** flush 流式 STT。
     * 于是一通电话里一句 FINAL 都没有:她把每个字都听清了,却一直当你还没说完。
     */
    if (definite !== undefined) {
      handlers.onFinal?.(definite)
      return
    }
    const text = transcriptOf(frame)
    if (text !== undefined) handlers.onInterim?.(text)
  }) as unknown as (...args: never[]) => void)

  ws.on('error', ((err: Error) => {
    handlers.onError?.(`火山 ASR 连接失败:${err?.message ?? '没说原因'}`)
    finishOnce()
  }) as unknown as (...args: never[]) => void)

  ws.on('close', (() => { finishOnce() }) as (...args: never[]) => void)

  return {
    push(pcm) {
      if (closed || finishing) return
      pending = pending.length === 0 ? Buffer.from(pcm) : Buffer.concat([pending, pcm])
      drain(false)
    },
    finish() {
      if (closed || finishing) return
      finishing = true
      // 最后一包发出去之后就不该再有包了,心跳先停。
      stopKeepalive()
      // 还没连上就先记着:open 里会带着 finishing 再 drain 一次。
      drain(true)
    },
    close() { finishOnce() },
  }
}
