/**
 * 「这一段 mp3 有多长」——— 从字节里**量出来**,不按字数估(2026-10-13,卡「播客页联动」)。
 *
 * 为什么要量:资讯页上「讲到哪条亮哪条」靠的是每条资讯在音频里的起止毫秒。
 * 起止是一段一段累出来的,所以每一段的时长必须是真的 ——
 * 按字数估出来的数会被当成真的(D13),而且估偏 1 秒,后面每一条都跟着偏。
 *
 * 怎么量:MPEG audio 的帧头自描述(采样率 + 每帧采样数),把帧走一遍加起来就是时长。
 * 这也正是 8792 把几段 mp3 直接首尾相接还能连着播的原因(见 feed.ts 的 PODCAST_MAX_CHARS),
 * 所以**接起来的字节走一遍就是整段的时长**,不用一段一段分开量。
 *
 * 量不出来(不是 MPEG、字节被截断、换了别的容器)就回 `undefined` ——
 * 调用方那边退回按字数估并把那一段标 `estimated`,**不假装量到了**。
 *
 * 对照:2026-09-21 在这台机器上真合成的那一段(交接-0921-资讯与播客 第四节)
 * 413,760 字节、MPEG2 layer III / 160kbps / 24kHz 单声道,`afinfo` 报 20.688 秒;
 * 这个算法对同一份输入给的是 20688ms(有用例钉着这个数)。
 */

/** 每帧采样数:MPEG1 layer III 是 1152,MPEG2 / 2.5 layer III 是 576。 */
const SAMPLES_PER_FRAME: Record<number, number> = { 1: 1152, 2: 576, 25: 576 }

/** 采样率表,按版本 → 采样率索引。 */
const SAMPLE_RATES: Record<number, readonly number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  25: [11025, 12000, 8000],
}

/** layer III 的码率表(kbps),按版本分两张。索引 0 是「自由格式」、15 是「坏值」,都不认。 */
const BITRATES_V1: readonly number[] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BITRATES_V2: readonly number[] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]

interface Frame {
  /** 这一帧占多少字节(含 padding)。 */
  bytes: number
  /** 这一帧多少毫秒。 */
  ms: number
}

/**
 * 读 `offset` 处的帧头。不是合法的 layer III 帧头就回 `undefined`。
 *
 * **只认 layer III**:我们这条链上 8792 回的是 mp3(audio/mpeg),
 * 放宽到 layer I / II 等于为一种从没出现过的输入多留一条猜路。
 */
function frameAt(buffer: Buffer, offset: number): Frame | undefined {
  if (offset + 4 > buffer.length) return undefined
  const b0 = buffer[offset] as number
  const b1 = buffer[offset + 1] as number
  const b2 = buffer[offset + 2] as number
  // 同步字:11 个 1。
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined
  // 版本:11 = MPEG1,10 = MPEG2,00 = MPEG2.5(01 保留)。
  const versionBits = (b1 >> 3) & 0b11
  const version = versionBits === 0b11 ? 1 : versionBits === 0b10 ? 2 : versionBits === 0b00 ? 25 : undefined
  if (version === undefined) return undefined
  // layer:01 = layer III。
  if (((b1 >> 1) & 0b11) !== 0b01) return undefined
  const bitrate = (version === 1 ? BITRATES_V1 : BITRATES_V2)[(b2 >> 4) & 0b1111] ?? 0
  if (bitrate === 0) return undefined
  const rateIndex = (b2 >> 2) & 0b11
  const sampleRate = SAMPLE_RATES[version]?.[rateIndex]
  if (sampleRate === undefined) return undefined
  const samples = SAMPLES_PER_FRAME[version] as number
  const padding = (b2 >> 1) & 0b1
  // 帧长 = 每帧采样数 / 8 × 码率 / 采样率,向下取整,再加 padding 的那一个字节。
  const bytes = Math.floor((samples / 8) * ((bitrate * 1000) / sampleRate)) + padding
  if (bytes <= 4) return undefined
  return { bytes, ms: (samples / sampleRate) * 1000 }
}

/** ID3v2 那一段有多长(没有就 0)。头 10 字节 + 四个 7 位的「同步安全」长度字节。 */
function id3Length(buffer: Buffer): number {
  if (buffer.length < 10) return 0
  if (buffer[0] !== 0x49 || buffer[1] !== 0x44 || buffer[2] !== 0x33) return 0
  const size = ((buffer[6] as number) & 0x7f) * 0x200000
    + ((buffer[7] as number) & 0x7f) * 0x4000
    + ((buffer[8] as number) & 0x7f) * 0x80
    + ((buffer[9] as number) & 0x7f)
  return 10 + size
}

/**
 * 一段 MPEG audio(mp3)有多少毫秒。
 *
 * 一帧都没走通 → `undefined`(调用方退回按字数估,并标 `estimated`)。
 * 中途遇到认不出的字节就往后找下一个同步字(几段 mp3 接起来的接缝、ID3v1 尾巴都在这儿吃掉);
 * **连续找不到就停**,不把整段字节当成音频硬凑一个数出来。
 */
export function mp3DurationMs(buffer: Buffer): number | undefined {
  let at = id3Length(buffer)
  let ms = 0
  let frames = 0
  while (at + 4 <= buffer.length) {
    const frame = frameAt(buffer, at)
    if (frame !== undefined) {
      ms += frame.ms
      frames += 1
      at += frame.bytes
      continue
    }
    // 认不出:往后找下一个 0xFF。找不到就收工。
    const next = buffer.indexOf(0xff, at + 1)
    if (next < 0) break
    at = next
  }
  return frames === 0 ? undefined : Math.round(ms)
}
