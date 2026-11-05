/**
 * 火山 ASR `45000081` 查清了:**等包超时**(2026-09-20)。
 *
 * 证据(官方文档,两篇同一张表):
 *   《大模型流式语音识别API》   https://www.volcengine.com/docs/6561/1354869
 *   《同声传译2.0-API接入文档》 https://www.volcengine.com/docs/DoubaoVoice/SimultaneousInterpretation20APIAccessDocumentation?lang=zh
 *   | 45000081 | 等包超时 |   ← 说明栏是空的,官方只给这四个字,超时阈值没公布
 * 同一篇正文里那句建议就是解药(逐字):
 *   「单包音频大小建议在100~200ms左右,发包间隔建议100～200ms,不能过大或者过小」
 *
 * Ben 那一通里连着 17 条 45000081 = 连接开着、包断了流(换接话对象 / 房里一时没人 /
 * 手机收了麦克风 / App 切后台)。这一组用例钉两件:
 *   ① 只要会话还开着,没有真音频也每 200ms 补一包静音 —— 服务端等不到包这件事不会再发生;
 *   ② 同一条错误连着来,日志只写一行 + 一个数(不再是十七行一模一样的)。
 */
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  MSG_AUDIO_ONLY,
  MSG_FULL_CLIENT,
  MSG_SERVER_ERROR,
  PCM_CHUNK_BYTES,
  SILENCE_CHUNK,
  VOLC_PACKET_MS,
  errorMessageOf,
  parseFrame,
  volcAsrErrorMeaning,
} from '../src/asr/volcProtocol.ts'
import { openVolcAsrSession } from '../src/asr/volcSession.ts'
import { RepeatCollapser } from '../src/asr/volcStt.ts'
import { VOLC_ASR_DEFAULT_RESOURCE } from '../src/asr/index.ts'

const CREDS = { appId: 'app', accessToken: 'token', resourceId: VOLC_ASR_DEFAULT_RESOURCE }

interface Fake { url: string, frames: ReturnType<typeof parseFrame>[], close: () => Promise<void> }
const fakes: Fake[] = []
afterEach(async () => { while (fakes.length) await fakes.pop()?.close() })

async function startFake(): Promise<Fake> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  const port = (server.address() as AddressInfo).port
  const fake: Fake = {
    url: `ws://127.0.0.1:${port}`,
    frames: [],
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
  server.on('connection', (ws) => {
    ws.on('message', (data: Buffer) => {
      fake.frames.push(parseFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)))
    })
  })
  fakes.push(fake)
  return fake
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) { resolve(); return }
      if (Date.now() - started > timeoutMs) { reject(new Error(`等不到:${label}`)); return }
      setTimeout(tick, 5)
    }
    tick()
  })
}

const audioFrames = (fake: Fake): ReturnType<typeof parseFrame>[] =>
  fake.frames.filter(frame => frame.messageType === MSG_AUDIO_ONLY)

describe('等包超时的解药:心跳静音包', () => {
  it('一个字节真音频都没有,也照样每一拍出一包', async () => {
    const fake = await startFake()
    const session = openVolcAsrSession({ url: fake.url, creds: CREDS, handlers: {}, packetMs: 20 })
    await waitFor(() => audioFrames(fake).length >= 4, '四包心跳')
    expect(fake.frames[0]?.messageType).toBe(MSG_FULL_CLIENT)
    session.close()
  })

  it('推了真音频那一拍就不补静音(心跳只补空档,不加塞)', async () => {
    const fake = await startFake()
    const session = openVolcAsrSession({ url: fake.url, creds: CREDS, handlers: {}, packetMs: 60 })
    await waitFor(() => fake.frames.length >= 1, '开场帧')
    // 连着推四包真音频:每一包都会立刻发出去,心跳那一拍因此什么都不做。
    for (let i = 0; i < 4; i += 1) session.push(Buffer.alloc(PCM_CHUNK_BYTES, 7))
    await waitFor(() => audioFrames(fake).length >= 4, '四包真音频')
    expect(audioFrames(fake).length).toBe(4)
    session.close()
  })

  it('断了就不再补包(close 之后一拍都没有)', async () => {
    const fake = await startFake()
    const session = openVolcAsrSession({ url: fake.url, creds: CREDS, handlers: {}, packetMs: 20 })
    await waitFor(() => audioFrames(fake).length >= 2, '心跳起来了')
    session.close()
    const afterClose = audioFrames(fake).length
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(audioFrames(fake).length).toBe(afterClose)
  })

  it('finish() 之后也不再补包 —— 最后一包后面不许再有包', async () => {
    const fake = await startFake()
    const session = openVolcAsrSession({ url: fake.url, creds: CREDS, handlers: {}, packetMs: 20 })
    await waitFor(() => audioFrames(fake).length >= 2, '心跳起来了')
    session.finish()
    await waitFor(() => audioFrames(fake).some(frame => frame.flags === 0b0011), '最后一包')
    const at = audioFrames(fake).length
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(audioFrames(fake).length).toBe(at)
    session.close()
  })

  it('一拍是 200 毫秒,静音包和真音频一样大(官方:包 100~200ms、间隔 100~200ms)', () => {
    expect(VOLC_PACKET_MS).toBe(200)
    expect(SILENCE_CHUNK.length).toBe(PCM_CHUNK_BYTES)
    expect(SILENCE_CHUNK.every(byte => byte === 0)).toBe(true)
  })
})

describe('错误码说人话', () => {
  it('45000081 是「等包超时」,不再只剩一个数字', () => {
    expect(volcAsrErrorMeaning(45000081)).toContain('等包超时')
    const frame = { messageType: MSG_SERVER_ERROR, flags: 0, code: 45000081, json: null }
    expect(errorMessageOf(frame)).toBe('火山 ASR 错误(45000081):等包超时——服务端等下一包音频等太久了(我们这头音频断了流)')
  })

  it('表里没有的码照旧只给数字(**不编一个意思**)', () => {
    expect(volcAsrErrorMeaning(45000000)).toBeUndefined()
    expect(errorMessageOf({ messageType: MSG_SERVER_ERROR, flags: 0, code: 45000000, json: null }))
      .toBe('火山 ASR 错误(45000000)')
  })

  it('服务端自己带了 message 就用它的(我们那张表只是兜底)', () => {
    expect(errorMessageOf({ messageType: MSG_SERVER_ERROR, flags: 0, code: 45000081, json: { message: 'wait packet timeout' } }))
      .toBe('火山 ASR 错误(45000081):wait packet timeout')
  })
})

describe('连着来的同一条错误只写一行 + 一个数', () => {
  it('十七条一模一样 → 一行 + 「又连着来了 16 次」', () => {
    const lines: string[] = []
    const collapser = new RepeatCollapser(line => lines.push(line))
    for (let i = 0; i < 17; i += 1) collapser.say('火山 ASR 错误(45000081):等包超时')
    expect(lines).toHaveLength(1)
    collapser.flush()
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('16 次')
  })

  it('换了一条别的,先把上一条的数补上 —— 一条都不丢', () => {
    const lines: string[] = []
    const collapser = new RepeatCollapser(line => lines.push(line))
    collapser.say('A')
    collapser.say('A')
    collapser.say('B')
    expect(lines).toEqual(['A', '上面那条「A」又连着来了 1 次。', 'B'])
  })

  it('没有重复时 flush 什么都不写', () => {
    const lines: string[] = []
    const collapser = new RepeatCollapser(line => lines.push(line))
    collapser.say('A')
    collapser.flush()
    collapser.flush()
    expect(lines).toEqual(['A'])
  })
})
