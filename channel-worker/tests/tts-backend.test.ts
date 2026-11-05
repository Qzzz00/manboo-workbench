/**
 * 8792 缺席时工人不许崩(2026-09-18,Ben 真机:引导通话「接不上」)。
 *
 * 根因在他那台机器的日志里逐字写着:工人一启动就说招呼 → 那一句要向 8792 要音频 →
 * `connect ECONNREFUSED 127.0.0.1:8792` → **未处理的 Promise 拒绝** → 进程退出 → 插件拉起 → 再崩。
 *
 * 这两组用例钉的是:① 探测说得出人话且**绝不抛**;② 合成失败只是「这一句没声音」,
 * 字幕照推、迭代照常结束 —— 没有任何东西冒出 run() 之外。
 */
import { describe, expect, it } from 'vitest'
import { probeTtsBackend, TTS_PROBE_TIMEOUT_MS } from '../src/tts/backend.ts'
import { ButlerTts } from '../src/tts/butlerTts.ts'

describe('probeTtsBackend', () => {
  it('/health 通了就是 ok', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => { urls.push(url); return new Response('{"ok":true}', { status: 200 }) }) as unknown as typeof fetch
    const probe = await probeTtsBackend({ butlerUrl: 'http://127.0.0.1:8792', fetchImpl })
    expect(probe.state).toBe('ok')
    expect(urls).toEqual(['http://127.0.0.1:8792/health'])
  })

  it('连不上就是 down,而且**回一句话不是抛一个错**', async () => {
    const fetchImpl = (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8792') }) as unknown as typeof fetch
    const probe = await probeTtsBackend({ butlerUrl: 'http://127.0.0.1:8792', fetchImpl })
    expect(probe.state).toBe('down')
    // 那句话要能直接打进日志:说清「照常进房」,免得下一个人以为工人该退出。
    expect(probe.note).toContain('照常进房')
    expect(probe.note).toContain('8792')
  })

  it('回了 500 也算 down(在跑但答不了,和没起来对这条链路是一回事)', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const probe = await probeTtsBackend({ butlerUrl: 'http://127.0.0.1:8792', fetchImpl })
    expect(probe.state).toBe('down')
    expect(probe.note).toContain('500')
  })

  it('默认超时两秒(本机连不上是立刻的事,慢于此就当它没起来)', () => {
    expect(TTS_PROBE_TIMEOUT_MS).toBe(2000)
  })
})

describe('ButlerTts:8792 拒绝连接', () => {
  it('不抛、不产帧,字幕照推一条 ok:false —— 有字没声,总比进程被掀翻强', async () => {
    const spoken: [string, boolean][] = []
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      fetchImpl: (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8792') }) as unknown as typeof fetch,
      onSpeech: (text, ok) => spoken.push([text, ok]),
    })
    const frames: unknown[] = []
    for await (const frame of tts.synthesize('你好,很高兴认识你。')) frames.push(frame)
    expect(frames).toHaveLength(0)
    expect(spoken).toEqual([['你好,很高兴认识你。', false]])
  })

  it('回了 503(没配语音密钥)走同一条路', async () => {
    const spoken: [string, boolean][] = []
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      fetchImpl: (async () => new Response('{"error":"没配密钥"}', { status: 503 })) as unknown as typeof fetch,
      onSpeech: (text, ok) => spoken.push([text, ok]),
    })
    const frames: unknown[] = []
    for await (const frame of tts.synthesize('在的。')) frames.push(frame)
    expect(frames).toHaveLength(0)
    expect(spoken).toEqual([['在的。', false]])
  })

  it('8792 回来了下一句自己就有声音(没有缓存的「坏了」状态)', async () => {
    const spoken: [string, boolean][] = []
    let first = true
    const wav = wavOfSilence(2400)
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      fetchImpl: (async () => {
        if (first) { first = false; throw new Error('connect ECONNREFUSED 127.0.0.1:8792') }
        return new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } })
      }) as unknown as typeof fetch,
      onSpeech: (text, ok) => spoken.push([text, ok]),
    })
    for await (const _ of tts.synthesize('第一句。')) { /* 没有帧 */ }
    const frames: unknown[] = []
    for await (const frame of tts.synthesize('第二句。')) frames.push(frame)
    expect(spoken).toEqual([['第一句。', false], ['第二句。', true]])
    expect(frames.length).toBeGreaterThan(0)
  })
})

/** 一段静音 WAV(24k 单声道 16 位)。只为让「第二句真的出声」这条用例有音频可解。 */
function wavOfSilence(samples: number): ArrayBuffer {
  const dataBytes = samples * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(24000, 24)
  buf.writeUInt32LE(24000 * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}
