/**
 * 8792 那条流式合成回包的**帧解码**(2026-09-23)。纯函数,不认识 fetch、不认识 LiveKit。
 *
 * ## 格式(两边各写一份,**改一处要改两处**)
 *
 *     [1B 类型][4B 大端长度][载荷]
 *       1 = 音频(载荷 = 裸 16 位小端单声道 PCM,采样率在响应头 `x-tts-sample-rate` 里)
 *       2 = 完了(载荷空)
 *       3 = 断了(载荷 = 一句人话,UTF-8)
 *
 * 另一份在 `butler-server/server/routes/api/ttsStream.cjs`。为什么不共用:两个子目录
 * **互不 import**(AGENTS.md「仓库结构」),这几十字节的格式抄一份比造一个共享包便宜。
 *
 * ## 为什么末尾一定要有「完了 / 断了」
 *
 * 裸音频流断在半路和正常结束在字节上是同一件事。分不出来就只能把半句话当整句播,
 * 而「她说半句就停」在电话里比「慢半秒」难受得多。有了第 2/3 类帧,工人能如实说这一句断了。
 *
 * ## 纪律:**绝不抛**
 *
 * 这是网上来的字节。长度字段坏了、帧只到一半、收到不认识的类型 —— 一律当作
 * 「这一块先攒着」或「这一帧跳过」,不把整通电话带走。
 */

/** 音频帧。 */
export const FRAME_AUDIO = 1
/** 到头了。 */
export const FRAME_END = 2
/** 断了,载荷是一句人话。 */
export const FRAME_ERROR = 3

/** 帧头:1 字节类型 + 4 字节长度。 */
export const FRAME_HEADER_BYTES = 5

/**
 * 单帧载荷上限。**防的是长度字段坏掉**:一个乱码的长度会让读帧的人一直攒下去,
 * 内存一路涨到进程被杀。32MB 远大于任何一句话的 PCM(24k/16bit 的一分钟才 2.9MB)。
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024

export type StreamFrame
  = { kind: 'audio', audio: Buffer }
  | { kind: 'end' }
  | { kind: 'error', message: string }
  | { kind: 'broken', message: string }

/** 拼一帧(给测试与将来别的写端用;工人自己只读不写)。 */
export function frameOf(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(FRAME_HEADER_BYTES)
  head.writeUInt8(type, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

export interface FrameReader {
  /** 喂一块网上来的字节,回这一块里读全了的帧(可能是 0 个,也可能是好几个)。 */
  push: (bytes: Buffer) => StreamFrame[]
  /** 流没了。手里还攒着半帧就回一条 `broken` —— 那正是「合到一半断了」。 */
  end: () => StreamFrame[]
}

/**
 * 一个读帧的状态机。**一个流一个**(它自己攒着半帧)。
 */
export function createFrameReader(): FrameReader {
  let buffered = Buffer.alloc(0)
  let dead = false

  const drain = (): StreamFrame[] => {
    const out: StreamFrame[] = []
    for (;;) {
      if (dead) return out
      if (buffered.length < FRAME_HEADER_BYTES) return out
      const type = buffered.readUInt8(0)
      const size = buffered.readUInt32BE(1)
      if (size > MAX_FRAME_BYTES) {
        dead = true
        out.push({ kind: 'broken', message: `帧长度不像话(${size} 字节),这条流不读了` })
        return out
      }
      if (buffered.length < FRAME_HEADER_BYTES + size) return out
      const payload = buffered.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + size)
      buffered = buffered.subarray(FRAME_HEADER_BYTES + size)
      if (type === FRAME_AUDIO) { if (payload.length > 0) out.push({ kind: 'audio', audio: Buffer.from(payload) }) }
      else if (type === FRAME_END) out.push({ kind: 'end' })
      else if (type === FRAME_ERROR) out.push({ kind: 'error', message: payload.toString('utf8').slice(0, 300) })
      // 不认识的类型:跳过这一帧。长度字段还在,所以跳得准 —— 这正是为什么帧要自带长度。
    }
  }

  return {
    push(bytes: Buffer): StreamFrame[] {
      if (dead || bytes.length === 0) return dead ? [] : drain()
      buffered = buffered.length === 0 ? Buffer.from(bytes) : Buffer.concat([buffered, bytes])
      return drain()
    },
    end(): StreamFrame[] {
      if (dead) return []
      if (buffered.length === 0) return []
      const left = buffered.length
      buffered = Buffer.alloc(0)
      dead = true
      return [{ kind: 'broken', message: `流断在半帧上(还差一帧的 ${left} 个字节)` }]
    },
  }
}

/**
 * PCM(16 位小端)→ 能直接喂 AudioByteStream 的整样本字节。
 * 奇数个字节意味着最后半个样本还没到,**留着**下一块再拼 —— 直接送进去会让声音里多一声咔哒。
 * 回 `[能用的, 留着的]`。
 */
export function evenSamples(buf: Buffer): [Buffer, Buffer] {
  if (buf.length % 2 === 0) return [buf, Buffer.alloc(0)]
  return [buf.subarray(0, buf.length - 1), Buffer.from(buf.subarray(buf.length - 1))]
}
