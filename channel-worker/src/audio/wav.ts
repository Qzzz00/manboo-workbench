/**
 * PCM ↔ WAV。两个纯函数,没有依赖 —— 8792 的 `/api/asr` 只吃 WAV(PCM 16k/16bit/单声道)
 * 或裸 PCM,而 LiveKit 给的是 `Int16Array`,中间差的就是一个 44 字节的头。
 *
 * 为什么不引第三方:一个 RIFF 头写死在这里比装一个包更容易验(tests/wav.test.ts 逐字段验)。
 */

/** 8792 的 ASR 只认这一种采样率(见 butler-server/server/routes/api/asr.cjs 顶部)。 */
export const ASR_SAMPLE_RATE = 16000

/** 16 位有符号小端 PCM → 带 RIFF 头的 WAV。 */
export function encodeWav(pcm: Buffer, sampleRate = ASR_SAMPLE_RATE, channels = 1): Buffer {
  const bitsPerSample = 16
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk 长度
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** `Int16Array` → 小端字节。LiveKit 的 AudioFrame.data 就是这个类型。 */
export function pcmOfInt16(samples: Int16Array): Buffer {
  const out = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) out.writeInt16LE(samples[i] ?? 0, i * 2)
  return out
}

/** 一段 PCM 有多少秒。用来算「这一段值不值得送去识别」,也用来算实测延迟。 */
export function pcmSeconds(pcm: Buffer, sampleRate = ASR_SAMPLE_RATE, channels = 1): number {
  return pcm.length / 2 / channels / sampleRate
}
