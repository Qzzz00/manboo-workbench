/**
 * 火山「大模型流式语音识别」(sauc bigmodel) 的**帧编解码**,纯函数。
 *
 * 协议 = bytedance v3 双向流式:`[4B header][?4B sequence][4B payloadSize][payload]`。
 * 这一份是照 butler-server/server/services/volcAsr.cjs 那份(已经在本机跑通过非流式一句话转写)
 * 搬过来的 TypeScript 版,**编解码规则一个比特都没改** —— 改的是上层用法:
 * 那边是「一次性把整段 PCM 发完再等最终结果」,这边是「边说边发、边发边出字」。
 *
 * 为什么单独一个文件:帧编解码是唯一能在**没有密钥**的情况下验到底的部分。
 * tests/volc-protocol.test.ts 逐字段验编码,tests/volc-session.test.ts 用一个假 WS 服务端
 * 把「发请求 → 收中间结果 → 收最终结果 → 收错误帧」四条路都走一遍。
 * 真接火山要密钥,本机没有,那一段如实记「未跑」。
 */
import { gunzipSync, gzipSync } from 'node:zlib'

// 消息类型(header[1] 的高 4 位)
export const MSG_FULL_CLIENT = 0b0001
export const MSG_AUDIO_ONLY = 0b0010
export const MSG_FULL_SERVER = 0b1001
export const MSG_SERVER_ACK = 0b1011
export const MSG_SERVER_ERROR = 0b1111

// 标志位(header[1] 的低 4 位)
export const FLAG_POS_SEQUENCE = 0b0001
/** 带序号且是最后一包。服务端回这个 flag 就表示这一句到头了。 */
export const FLAG_NEG_WITH_SEQUENCE = 0b0011

// 序列化 / 压缩(header[2])
export const SER_JSON = 0b0001
export const SER_RAW = 0b0000
export const COMP_GZIP = 0b0001

/** 200ms @ 16k/16bit/mono。火山按这个粒度吃 PCM 最稳。 */
export const PCM_CHUNK_BYTES = 16000 * 2 * 0.2

/**
 * **发包间隔**(毫秒)。官方文档原话:「单包音频大小建议在100~200ms左右,发包间隔建议
 * 100～200ms,不能过大或者过小」。超过这么久没发出一包,就补一包静音(见 volcSession.ts)
 * —— 那是 `45000081 等包超时` 的解药。
 */
export const VOLC_PACKET_MS = 200

/** 一包静音。长度与 {@link PCM_CHUNK_BYTES} 一致;只读,全局一份就够。 */
export const SILENCE_CHUNK: Buffer = Buffer.alloc(PCM_CHUNK_BYTES)

export interface FrameInput {
  messageType: number
  flags: number
  serialization: number
  compression: number
  sequence: number
  payload: Buffer
}

/** 拼一帧。sequence 只在带序号的 flags 下才占那 4 个字节。 */
export function buildFrame(input: FrameInput): Buffer {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001, // version=1, headerSize=1(=4 字节)
    (input.messageType << 4) | input.flags,
    (input.serialization << 4) | input.compression,
    0x00,
  ])
  const parts: Buffer[] = [header]
  if (input.flags === FLAG_POS_SEQUENCE || input.flags === FLAG_NEG_WITH_SEQUENCE) {
    const seq = Buffer.alloc(4)
    seq.writeInt32BE(input.sequence, 0)
    parts.push(seq)
  }
  const size = Buffer.alloc(4)
  size.writeUInt32BE(input.payload.length, 0)
  parts.push(size, input.payload)
  return Buffer.concat(parts)
}

export interface ParsedFrame {
  messageType: number
  flags: number
  /** 只有 MSG_SERVER_ERROR 帧才有意义。 */
  code: number
  /** payload 解得开就是对象,解不开是 null(非 JSON 帧)。 */
  json: Record<string, unknown> | null
}

/**
 * 解一帧。**绝不抛** —— 这是网上来的字节,一帧坏掉不该把整条通话带走;
 * 解不动就回一个 messageType 为 0 的空帧,上层当作「什么也没发生」。
 */
export function parseFrame(buf: Buffer): ParsedFrame {
  const empty: ParsedFrame = { messageType: 0, flags: 0, code: 0, json: null }
  if (buf.length < 8) return empty
  try {
    const headerSize = ((buf[0] ?? 0) & 0x0f) * 4
    const messageType = ((buf[1] ?? 0) >> 4) & 0x0f
    const flags = (buf[1] ?? 0) & 0x0f
    const compression = (buf[2] ?? 0) & 0x0f
    let offset = headerSize
    let code = 0
    if (messageType === MSG_SERVER_ERROR) {
      code = buf.readUInt32BE(offset)
      offset += 4
    }
    else if (flags === FLAG_POS_SEQUENCE || flags === FLAG_NEG_WITH_SEQUENCE) {
      offset += 4 // 跳过 sequence
    }
    const size = buf.readUInt32BE(offset)
    offset += 4
    let payload = buf.subarray(offset, offset + size)
    if (compression === COMP_GZIP && payload.length > 0) {
      try { payload = gunzipSync(payload) } catch { /* 解不开就当没压过 */ }
    }
    let json: Record<string, unknown> | null = null
    try {
      const decoded = JSON.parse(payload.toString('utf8')) as unknown
      if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) {
        json = decoded as Record<string, unknown>
      }
    }
    catch { /* 非 JSON 帧 */ }
    return { messageType, flags, code, json }
  }
  catch {
    return empty
  }
}

/** 回包里的识别文字。取不到就 undefined —— 空串和「没有这一字段」在上层是同一件事。 */
export function transcriptOf(frame: ParsedFrame): string | undefined {
  const result = (frame.json as { result?: unknown } | null)?.result
  const text = (result as { text?: unknown } | null)?.text
  return typeof text === 'string' && text !== '' ? text : undefined
}

/**
 * **判停**:这一句他已经说完了(2026-09-18「引导不理我」那张卡)。
 *
 * 火山把每一段话放在 `result.utterances[]` 里,`definite: true` 就是「这一段到头了」。
 * 它和「最后一包」(FLAG_NEG_WITH_SEQUENCE)是**两件事**:最后一包是**我们**说「我不发了」,
 * 判停是**火山**说「他不说了」。电话里只有后者会自己发生 —— 前者要有人来 flush,
 * 而 LiveKit Agents 从不给流式 STT 发 flush(`voice/audio_recognition.js` 里一次
 * `sttStream.flush()` 都没有,只有 `vadStream.flush()`)。
 *
 * 取的是那一段自己的 `text`,不是 `result.text`:判停那一帧里 `utterances` 往往已经多出
 * 一条空的「下一句」,盯着 `result.text` 会在换句那一刻拿到半截。
 */
export function definiteTranscriptOf(frame: ParsedFrame): string | undefined {
  const result = (frame.json as { result?: unknown } | null)?.result
  const utterances = (result as { utterances?: unknown } | null)?.utterances
  if (!Array.isArray(utterances)) return undefined
  for (const raw of utterances) {
    const utterance = raw as { text?: unknown, definite?: unknown } | null
    if (utterance?.definite !== true) continue
    const text = utterance.text
    if (typeof text === 'string' && text !== '') return text
  }
  return undefined
}

/**
 * 火山「大模型流式语音识别」的错误码 → 一句中文(2026-09-20 查清并抄回来的)。
 *
 * 出处:两篇官方文档里同一张表,互相印证 ——
 *   《大模型流式语音识别API》 https://www.volcengine.com/docs/6561/1354869
 *   《同声传译2.0-API接入文档》 https://www.volcengine.com/docs/DoubaoVoice/SimultaneousInterpretation20APIAccessDocumentation?lang=zh
 * 表里 `45000081` 的说明栏**是空的**,官方只给了「等包超时」四个字(超时阈值没公布),
 * 所以这里括号里那半句是我们自己加的**做法**,不是文档原文 —— 别把它当官方解释再传出去。
 *
 * 同一篇文档正文里那句建议是这次修法的依据,逐字:
 *   「单包音频大小建议在100~200ms左右,发包间隔建议100～200ms,不能过大或者过小」
 * 见 volcSession.ts 的心跳包。
 */
export const VOLC_ASR_ERROR_MEANING: Readonly<Record<number, string>> = {
  45000001: '请求参数无效(缺必需字段 / 值非法 / 重复请求)',
  45000002: '空音频',
  45000081: '等包超时——服务端等下一包音频等太久了(我们这头音频断了流)',
  45000151: '音频格式不正确',
  55000031: '服务器繁忙',
}

/** 这个码是什么意思。表里没有就回 undefined,**不猜一句**。 */
export function volcAsrErrorMeaning(code: number): string | undefined {
  return VOLC_ASR_ERROR_MEANING[code]
}

/**
 * 错误帧里的那句话。没有就给一句带 code 的兜底,别让日志里只有一个数字。
 *
 * 2026-09-20 补上「这个码是什么意思」:Ben 那一通里连着 17 条
 * `火山 ASR 错误(45000081)`,一个字的解释都没有,于是这件事在两张卡里挂了两天。
 * 认得出的码从此自带中文;认不出的照旧只给数字(**不编一个意思**)。
 */
export function errorMessageOf(frame: ParsedFrame): string {
  const message = frame.json?.message
  const meaning = volcAsrErrorMeaning(frame.code)
  const said = typeof message === 'string' && message !== '' ? message : meaning
  return said === undefined
    ? `火山 ASR 错误(${frame.code})`
    : `火山 ASR 错误(${frame.code}):${said}`
}

/** 热词 → corpus。单字热词会把同音字一起拉偏,一律跳过(与 butler-server 那份同一条规矩)。 */
const HOTWORD_CHAR_BUDGET = 120

/**
 * 对话上下文最多带多少字、几条(2026-09-25)。官方对上下文的限制是按 token 算的,
 * 这里按字数留足余量;超了从**最早**的那条丢(越近的越有用)。
 */
export const DIALOG_CONTEXT_CHAR_BUDGET = 300
export const DIALOG_CONTEXT_MAX_ITEMS = 10

/**
 * 热词 + 对话上下文 → `request.corpus`。
 *
 * **对话上下文**(2026-09-25,卡 fix/call-under-load-and-name):火山大模型流式识别的 `corpus.context`
 * 除了热词直传,还收一段对话上下文,形状是
 * `{"context_type":"dialog_ctx","context_data":[{"text":"…"}]}`(与热词放在同一个 JSON 字符串里,
 * 各家接入里都这么合着传)。问称呼那一轮把她那句问话放进去,火山就知道接下来是一个名字 ——
 * 维护者说「Ben」,第一遍被听成「变」「编辑」的,就是少了这一句。
 */
export function buildCorpus(hotwords: readonly string[], dialog: readonly string[] = []): { context: string } | undefined {
  const seen = new Set<string>()
  const words: { word: string }[] = []
  let chars = 0
  for (const raw of hotwords) {
    const word = String(raw ?? '').trim()
    if (word.length < 2 || seen.has(word)) continue
    // 跳过而不是停:后面可能还有更短的塞得下。
    if (chars + word.length > HOTWORD_CHAR_BUDGET) continue
    seen.add(word)
    words.push({ word })
    chars += word.length
  }
  // 对话上下文:从最近的那条往回收,收到预算为止,再按原来的先后排回去。
  const texts: string[] = []
  let dialogChars = 0
  for (const raw of [...dialog].reverse()) {
    const text = String(raw ?? '').trim()
    if (text === '') continue
    if (texts.length >= DIALOG_CONTEXT_MAX_ITEMS || dialogChars + text.length > DIALOG_CONTEXT_CHAR_BUDGET) break
    texts.unshift(text)
    dialogChars += text.length
  }
  if (words.length === 0 && texts.length === 0) return undefined
  return {
    context: JSON.stringify({
      ...(words.length === 0 ? {} : { hotwords: words }),
      ...(texts.length === 0 ? {} : { context_type: 'dialog_ctx', context_data: texts.map(text => ({ text })) }),
    }),
  }
}

/**
 * **强制判停窗口**(毫秒)。他停这么久不出声,火山就把这一句标成 `definite` 交上来。
 *
 * 600ms:比框架自己的 `minEndpointingDelay`(缺省 0.5 秒)稍长一点点 —— 判停要先于
 * 回合提交到,不然回合提交时手里还是空的(那正是 09-18 真机上「不理我」的样子)。
 * 再长就会让每一句都多等,一问一答本来就差着两秒。本机实测:说完之后约 800ms 收到判停。
 */
export const VOLC_END_WINDOW_MS = 600

/**
 * 开场那一帧(full client request)。
 *
 * `result_type: 'single'` 是**流式**要的:每一包只回这一段的增量,中间结果才出得来。
 * butler-server 那份是 `'full'`(一次性整段转写,只要最后一句),用法不同,不是抄错。
 *
 * `end_window_size` 是 2026-09-18 补的,**这一条不是调优,是能不能用的分界**:
 * 没有它,火山只在收到「最后一包」之后才给 `definite`;而电话里没有人会发最后一包
 * (框架不 flush 流式 STT),于是一整通电话一句 FINAL 都出不来,她永远等着你「还没说完」。
 */
export function buildStartFrame(
  hotwords: readonly string[] = [],
  options: { endWindowMs?: number, dialog?: readonly string[] } = {},
): Buffer {
  const corpus = buildCorpus(hotwords, options.dialog ?? [])
  const request = {
    user: { uid: 'butler-channel' },
    audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      result_type: 'single',
      end_window_size: options.endWindowMs ?? VOLC_END_WINDOW_MS,
      ...(corpus === undefined ? {} : { corpus }),
    },
  }
  return buildFrame({
    messageType: MSG_FULL_CLIENT,
    flags: FLAG_POS_SEQUENCE,
    serialization: SER_JSON,
    compression: COMP_GZIP,
    sequence: 1,
    payload: gzipSync(Buffer.from(JSON.stringify(request))),
  })
}

/** 一包音频。`last` 为真时序号取负 —— 那是协议里「这是最后一包」的表达方式。 */
export function buildAudioFrame(pcm: Buffer, sequence: number, last: boolean): Buffer {
  return buildFrame({
    messageType: MSG_AUDIO_ONLY,
    flags: last ? FLAG_NEG_WITH_SEQUENCE : FLAG_POS_SEQUENCE,
    serialization: SER_RAW,
    compression: COMP_GZIP,
    sequence: last ? -sequence : sequence,
    payload: gzipSync(pcm),
  })
}
