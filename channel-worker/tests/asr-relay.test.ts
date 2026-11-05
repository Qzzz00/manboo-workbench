/**
 * 出了局域网的「按住说话」—— 工人这一侧(2026-09-25,卡 S `fix/phone-voice-anywhere`)。
 *
 * 一段录音在 `wb.asr` 字节流上到,`wb.rpc` 上一条 `type:'asr'` 来取;两样在信箱里对上,
 * 以那台手机的身份交给 8791 的 `/butler/proxy/api/asr`。这里不起房间:字节流用一个假的读头,
 * 8791 用一个本机回环上的小服务(真的 HTTP、真的 fetch),**不发任何真的识别请求**。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ASR_AUDIO_BROKEN_TEXT,
  ASR_AUDIO_MISSING_TEXT,
  ASR_BACKEND_DOWN_TEXT,
  ASR_BACKEND_SLOW_TEXT,
  ASR_ID_ATTRIBUTE,
  ASR_MAX_BYTES,
  ASR_PATH,
  ASR_TOO_BIG_TEXT,
  ASR_TOPIC,
  createAsrMailbox,
  createAsrRelay,
  createAsrStreamHandler,
  readAsrStream,
  wavSeconds,
  workbenchAsrPoster,
} from '../src/asrRelay.ts'
import type { AsrAudio, AsrStreamReader } from '../src/asrRelay.ts'
import { handleRpcRequest, notPairedResponse, parseRpcRequest } from '../src/rpc.ts'
import type { RpcWorkbenchPort } from '../src/rpc.ts'
import { CHANNEL_DEVICE_HEADER } from '../src/workbench.ts'

/** 一段 16k / 16 位 / 单声道的 WAV(静音)。 */
function wav(seconds: number, rate = 16000): Uint8Array {
  const samples = Math.round(rate * seconds)
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(samples * 2, 40)
  return new Uint8Array(buf)
}

/** 一个假的字节流读头:按 15KB 一块吐(LiveKit 的块大小),可以中途断。 */
function reader(bytes: Uint8Array, options: { id?: string, totalSize?: number, breakAt?: number, mimeType?: string } = {}): AsrStreamReader & { closed: boolean } {
  const out = {
    closed: false,
    info: {
      ...(options.totalSize === undefined ? { totalSize: bytes.byteLength } : { totalSize: options.totalSize }),
      ...(options.id === undefined ? {} : { attributes: { [ASR_ID_ATTRIBUTE]: options.id } }),
      mimeType: options.mimeType ?? 'audio/wav',
    },
    async close() { out.closed = true },
    async* [Symbol.asyncIterator]() {
      for (let at = 0; at < bytes.byteLength; at += 15_000) {
        if (options.breakAt !== undefined && at >= options.breakAt) throw new Error('stream reset')
        yield bytes.subarray(at, at + 15_000)
      }
    },
  }
  return out
}

const servers: { close: () => void }[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

/**
 * 一台假的 8791:认 `X-Workbench-Channel-Device`(只认配对过的那几台,别的 401 —— 与真 8791 的降权那一段同一句话),
 * `/butler/proxy/api/asr` 收裸 WAV,回 `respond` 给的东西。记下每一条收到的请求。
 */
async function fake8791(respond: (input: { device: string, bytes: Buffer, contentType: string }) => { status: number, body: unknown, delayMs?: number }, paired = ['dev-1']) {
  const seen: { method: string, path: string, device: string, contentType: string, bytes: Buffer }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const device = String(req.headers[CHANNEL_DEVICE_HEADER] ?? '')
      const bytes = Buffer.concat(chunks)
      const contentType = String(req.headers['content-type'] ?? '')
      seen.push({ method: req.method ?? '', path: req.url ?? '', device, contentType, bytes })
      if (!paired.includes(device)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: '这台设备没配对过,或者已经解除配对了' }))
        return
      }
      const answer = respond({ device, bytes, contentType })
      setTimeout(() => {
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body))
      }, answer.delayMs ?? 0)
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()))
  servers.push({ close: () => server.close() })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const noWorkbench: RpcWorkbenchPort = {
  callAsDevice: async () => { throw new Error('识别不该走通用代理') },
  renewTicket: async () => ({ error: '用不到', status: 500 }),
}

describe('两端的约定', () => {
  it('topic、流上的编号属性、交给 8791 的那条路都是写死的(手机那一侧逐字一样)', () => {
    expect(ASR_TOPIC).toBe('wb.asr')
    expect(ASR_ID_ATTRIBUTE).toBe('wb_asr_id')
    // 与局域网里手机直连打的是同一条 —— 同一个后端、同一道设备令牌门。
    expect(ASR_PATH).toBe('/butler/proxy/api/asr')
  })

  it('一段最多 20 秒:上限按 16k 单声道 16 位算,20 秒的录音放得下,再大就不收', () => {
    expect(wav(20).byteLength).toBeLessThan(ASR_MAX_BYTES)
    expect(ASR_MAX_BYTES).toBeLessThan(700 * 1024)
  })
})

describe('信箱:录音和请求谁先到都行', () => {
  const ok: AsrAudio = { ok: true, bytes: new Uint8Array([1, 2, 3]), mime: 'audio/wav' }

  it('录音先到:请求来了当场拿走,信箱清空', async () => {
    const box = createAsrMailbox()
    box.put('wb-phone-dev-1', 'a1', ok)
    expect(box.size()).toBe(1)
    await expect(box.take('wb-phone-dev-1', 'a1', 1000)).resolves.toBe(ok)
    expect(box.size()).toBe(0)
  })

  it('请求先到:等录音进来', async () => {
    const box = createAsrMailbox()
    const taking = box.take('wb-phone-dev-1', 'a1', 1000)
    box.put('wb-phone-dev-1', 'a1', ok)
    await expect(taking).resolves.toBe(ok)
  })

  it('等到点没来:回 undefined(调用方说「录音没传过来」)', async () => {
    const box = createAsrMailbox()
    await expect(box.take('wb-phone-dev-1', 'a1', 20)).resolves.toBeUndefined()
  })

  it('按「谁发的 + 编号」对:别的设备报同一个编号拿不走', async () => {
    const box = createAsrMailbox()
    box.put('wb-phone-dev-1', 'a1', ok)
    await expect(box.take('wb-phone-dev-2', 'a1', 20)).resolves.toBeUndefined()
    await expect(box.take('wb-phone-dev-1', 'a1', 20)).resolves.toBe(ok)
  })

  it('同一台手机压太多:只留最新的两份;没人取的过一会儿自己扔', async () => {
    const box = createAsrMailbox({ keepMs: 30 })
    box.put('p', '1', ok)
    box.put('p', '2', ok)
    box.put('p', '3', ok)
    expect(box.size()).toBe(2)
    await expect(box.take('p', '1', 5)).resolves.toBeUndefined()
    await new Promise(done => setTimeout(done, 60))
    expect(box.size()).toBe(0)
  })
})

describe('读录音流', () => {
  it('收齐:字节原样', async () => {
    const bytes = wav(5)
    const got = await readAsrStream(reader(bytes))
    expect(got.ok).toBe(true)
    if (got.ok) {
      // 按字节比(原生):几百 KB 逐元素 toEqual 在机器忙的时候会慢到超时。
      expect(Buffer.from(got.bytes).equals(Buffer.from(bytes))).toBe(true)
      expect(got.mime).toBe('audio/wav')
    }
  })

  it('流头上报的大小超上限:连读都不读,关掉那一头,回 413', async () => {
    const r = reader(wav(1), { totalSize: ASR_MAX_BYTES + 1 })
    await expect(readAsrStream(r)).resolves.toEqual({ ok: false, status: 413, error: ASR_TOO_BIG_TEXT })
    expect(r.closed).toBe(true)
  })

  it('报的大小不可信(或没报):读的时候数,一超就停', async () => {
    const got = await readAsrStream(reader(wav(1), { totalSize: 10 }), 20_000)
    expect(got).toEqual({ ok: false, status: 413, error: ASR_TOO_BIG_TEXT })
  })

  it('传到一半断了:408(手机那边说「网可能慢,再说一遍」)', async () => {
    await expect(readAsrStream(reader(wav(5), { breakAt: 30_000 }))).resolves.toEqual({ ok: false, status: 408, error: ASR_AUDIO_BROKEN_TEXT })
  })
})

describe('WAV 多长', () => {
  it('16k 单声道 16 位:按字节率算秒数', () => {
    expect(wavSeconds(wav(5))).toEqual({ ok: true, seconds: 5 })
    expect(wavSeconds(wav(0.5))).toEqual({ ok: true, seconds: 0.5 })
  })

  it('头里写的长度比真有的多:以真有的为准', () => {
    const bytes = wav(2)
    new DataView(bytes.buffer).setUint32(40, 16000 * 2 * 60, true)
    expect(wavSeconds(bytes)).toEqual({ ok: true, seconds: 2 })
  })

  it('不是 WAV、不是 PCM:如实说认不出来,不猜', () => {
    expect(wavSeconds(new TextEncoder().encode('OggS…………………………………………………………………………')).ok).toBe(false)
    const floatWav = wav(1)
    new DataView(floatWav.buffer).setUint16(20, 3, true)
    expect(wavSeconds(floatWav).ok).toBe(false)
  })
})

describe('识别代转(RpcAsrPort)', () => {
  function relayWith(post: Parameters<typeof createAsrRelay>[0]['post'], extra: Partial<Parameters<typeof createAsrRelay>[0]> = {}) {
    const mailbox = createAsrMailbox()
    const lines: string[] = []
    const relay = createAsrRelay({ mailbox, post, streamWaitMs: 50, log: line => lines.push(line), ...extra })
    return { mailbox, relay, lines }
  }

  it('录音到了、交给 8791、8791 的回包原样回去;日志记秒数与耗时,不记他说的字', async () => {
    const posted: { deviceId: string, bytes: number, mime: string }[] = []
    const { mailbox, relay, lines } = relayWith(async ({ deviceId, audio, mime }) => {
      posted.push({ deviceId, bytes: audio.byteLength, mime })
      return { status: 200, body: { text: '明天九点提醒我开会' } }
    })
    mailbox.put('wb-phone-dev-1', 'a1', { ok: true, bytes: wav(5), mime: 'audio/wav' })
    await expect(relay.transcribe({ id: 'a1', deviceId: 'dev-1', identity: 'wb-phone-dev-1' }))
      .resolves.toEqual({ status: 200, body: { text: '明天九点提醒我开会' } })
    expect(posted).toEqual([{ deviceId: 'dev-1', bytes: wav(5).byteLength, mime: 'audio/wav' }])
    expect(lines.join('\n')).toMatch(/识别代转 ← wb-phone-dev-1:5 秒 · 156KB · 等录音 \d+ms · 识别 \d+ms → 200\(9 字\)/)
    expect(lines.join('\n')).not.toContain('提醒我开会')
  })

  it('录音没到:408 + 人话;一次都不交给 8791', async () => {
    let posts = 0
    const { relay } = relayWith(async () => { posts += 1; return { status: 200, body: {} } })
    await expect(relay.transcribe({ id: 'a1', deviceId: 'dev-1', identity: 'wb-phone-dev-1' }))
      .resolves.toEqual({ status: 408, body: { error: ASR_AUDIO_MISSING_TEXT } })
    expect(posts).toBe(0)
  })

  it('超过 20 秒:413(带 audio_too_long),不交给识别白烧一次额度', async () => {
    let posts = 0
    const { mailbox, relay } = relayWith(async () => { posts += 1; return { status: 200, body: {} } })
    mailbox.put('p', 'a1', { ok: true, bytes: wav(22.5), mime: 'audio/wav' })
    const got = await relay.transcribe({ id: 'a1', deviceId: 'dev-1', identity: 'p' })
    expect(got.status).toBe(413)
    expect(got.body).toMatchObject({ code: 'audio_too_long' })
    expect(posts).toBe(0)
  })

  it('20 秒整(录音机到点停,多出几十毫秒)照收', async () => {
    const { mailbox, relay } = relayWith(async () => ({ status: 200, body: { text: '好' } }))
    mailbox.put('p', 'a1', { ok: true, bytes: wav(20.08), mime: 'audio/wav' })
    await expect(relay.transcribe({ id: 'a1', deviceId: 'dev-1', identity: 'p' })).resolves.toMatchObject({ status: 200 })
  })

  it('不是 WAV:415;收坏了的录音:原样回它的 status', async () => {
    const { mailbox, relay } = relayWith(async () => ({ status: 200, body: {} }))
    mailbox.put('p', 'x', { ok: true, bytes: new TextEncoder().encode('not a wav at all, sorry about that one'), mime: 'audio/wav' })
    await expect(relay.transcribe({ id: 'x', deviceId: 'dev-1', identity: 'p' })).resolves.toMatchObject({ status: 415 })
    mailbox.put('p', 'y', { ok: false, status: 413, error: ASR_TOO_BIG_TEXT })
    await expect(relay.transcribe({ id: 'y', deviceId: 'dev-1', identity: 'p' })).resolves.toEqual({ status: 413, body: { error: ASR_TOO_BIG_TEXT } })
  })

  it('8791 等太久:504「等太久」;连不上:502', async () => {
    const slow = relayWith(async ({ signal }) => await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })))
    }), { backendTimeoutMs: 30 })
    slow.mailbox.put('p', 'a', { ok: true, bytes: wav(1), mime: 'audio/wav' })
    await expect(slow.relay.transcribe({ id: 'a', deviceId: 'dev-1', identity: 'p' })).resolves.toEqual({ status: 504, body: { error: ASR_BACKEND_SLOW_TEXT } })

    const down = relayWith(async () => { throw new TypeError('fetch failed') })
    down.mailbox.put('p', 'a', { ok: true, bytes: wav(1), mime: 'audio/wav' })
    await expect(down.relay.transcribe({ id: 'a', deviceId: 'dev-1', identity: 'p' })).resolves.toEqual({ status: 502, body: { error: ASR_BACKEND_DOWN_TEXT } })
  })
})

describe('交给 8791 的那一下(真的 HTTP)', () => {
  it('POST /butler/proxy/api/asr:裸 WAV、content-type audio/wav、带那台手机的身份头', async () => {
    const wb = await fake8791(() => ({ status: 200, body: { text: '好的' } }))
    const post = workbenchAsrPoster({ workbenchUrl: `${wb.url}/` })
    const bytes = wav(1)
    const got = await post({ deviceId: 'dev-1', audio: bytes, mime: 'audio/wav', signal: AbortSignal.timeout(2000) })
    expect(got).toEqual({ status: 200, body: { text: '好的' } })
    expect(wb.seen).toHaveLength(1)
    expect(wb.seen[0]).toMatchObject({ method: 'POST', path: '/butler/proxy/api/asr', device: 'dev-1', contentType: 'audio/wav' })
    expect(wb.seen[0]!.bytes.equals(Buffer.from(bytes))).toBe(true)
  })

  it('解除配对的手机:8791 当场 401,原话带回去(房间凭证还没过期也没用)', async () => {
    const wb = await fake8791(() => ({ status: 200, body: { text: '不该到这' } }), ['someone-else'])
    const got = await workbenchAsrPoster({ workbenchUrl: wb.url })({ deviceId: 'dev-1', audio: wav(1), mime: 'audio/wav', signal: AbortSignal.timeout(2000) })
    expect(got).toEqual({ status: 401, body: { error: '这台设备没配对过,或者已经解除配对了' } })
  })

  it('回包不是 JSON:说一句读不懂,不抛', async () => {
    const wb = await fake8791(() => ({ status: 502, body: '<html>bad gateway</html>' }))
    const got = await workbenchAsrPoster({ workbenchUrl: wb.url })({ deviceId: 'dev-1', audio: wav(1), mime: 'audio/wav', signal: AbortSignal.timeout(2000) })
    expect(got.status).toBe(502)
    expect(got.body).toEqual({ error: '识别服务回了一段读不懂的内容' })
  })
})

describe('wb.rpc 上的 type:asr', () => {
  it('读得懂,只要一个 id', () => {
    expect(parseRpcRequest('{"id":"a1","type":"asr","bytes":160044}')).toEqual({ ok: true, request: { id: 'a1', type: 'asr' } })
  })

  it('分发给识别那一头;回包与 http 代理同一个形状', async () => {
    const got = await handleRpcRequest({ id: 'a1', type: 'asr' }, {
      deviceId: 'dev-1',
      identity: 'wb-phone-dev-1',
      workbench: noWorkbench,
      asr: { transcribe: async input => ({ status: 200, body: { text: `${input.deviceId}/${input.identity}/${input.id}` } }) },
    })
    expect(got).toEqual({ id: 'a1', type: 'http', status: 200, body: { text: 'dev-1/wb-phone-dev-1/a1' } })
  })

  it('这个工人没接识别这条路:501 + 人话(手机据此说「电脑上的事务官要更新」);识别那头抛了:502', async () => {
    await expect(handleRpcRequest({ id: 'a1', type: 'asr' }, { deviceId: 'dev-1', identity: 'x', workbench: noWorkbench }))
      .resolves.toMatchObject({ id: 'a1', type: 'http', status: 501 })
    await expect(handleRpcRequest({ id: 'a1', type: 'asr' }, {
      deviceId: 'dev-1', identity: 'x', workbench: noWorkbench, asr: { transcribe: async () => { throw new Error('boom') } },
    })).resolves.toMatchObject({ id: 'a1', type: 'http', status: 502 })
  })

  it('不是配对过的手机:回 http 403 那句「只替已配对的手机办事」(手机当场收场,不干等)', () => {
    expect(notPairedResponse({ id: 'a1', type: 'asr' })).toEqual({ id: 'a1', type: 'http', status: 403, body: { error: '房间代理只替已配对的手机办事' } })
  })
})

describe('wb.asr 字节流的接法', () => {
  function handler(extra: Partial<Parameters<typeof createAsrStreamHandler>[0]> = {}) {
    const mailbox = createAsrMailbox()
    const lines: string[] = []
    const on = createAsrStreamHandler({
      mailbox,
      primary: true,
      deviceOf: identity => (identity.startsWith('wb-phone-') ? identity.slice('wb-phone-'.length) : undefined),
      log: line => lines.push(line),
      ...extra,
    })
    return { mailbox, on, lines }
  }
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise(done => setImmediate(done)) }

  it('配对过的手机、带编号:收齐放进信箱', async () => {
    const { mailbox, on } = handler()
    on(reader(wav(1), { id: 'a1' }), { identity: 'wb-phone-dev-1' })
    await settle()
    const got = await mailbox.take('wb-phone-dev-1', 'a1', 10)
    expect(got?.ok).toBe(true)
  })

  it('不是配对过的手机 / 没带编号 / 不是第一台电脑:不收,关掉那一头', async () => {
    for (const [extra, identity, id] of [
      [{}, 'test-page', 'a1'],
      [{}, 'wb-phone-dev-1', undefined],
      [{ primary: false }, 'wb-phone-dev-1', 'a1'],
    ] as const) {
      const { mailbox, on } = handler(extra)
      const r = reader(wav(1), id === undefined ? {} : { id })
      on(r, { identity })
      await settle()
      expect(r.closed).toBe(true)
      expect(mailbox.size()).toBe(0)
    }
  })
})

/**
 * 工人这一侧的整条路:字节流进信箱 → wb.rpc 那条来取 → 交给(假的)8791 → 回包。
 * 录音比请求晚到一点(真房间里两样是并发发的,谁先到都有可能)。
 */
describe('整条路(字节流 + wb.rpc + 8791)', () => {
  it('5 秒的一段:录音晚到 30ms 也对得上,回的就是识别出来的那句;这一侧本身几毫秒', async () => {
    const wb = await fake8791(({ bytes }) => ({ status: 200, body: { text: bytes.byteLength > 100_000 ? '把首页的时钟调大一号' : '太短' } }))
    const mailbox = createAsrMailbox()
    const on = createAsrStreamHandler({ mailbox, primary: true, deviceOf: () => 'dev-1' })
    const relay = createAsrRelay({ mailbox, post: workbenchAsrPoster({ workbenchUrl: wb.url }) })
    const started = Date.now()
    const answer = handleRpcRequest(parseRpcRequest('{"id":"r1","type":"asr"}').ok ? { id: 'r1', type: 'asr' } : { id: 'x', type: 'renew' }, {
      deviceId: 'dev-1', identity: 'wb-phone-dev-1', workbench: noWorkbench, asr: relay,
    })
    setTimeout(() => on(reader(wav(5), { id: 'r1' }), { identity: 'wb-phone-dev-1' }), 30)
    await expect(answer).resolves.toEqual({ id: 'r1', type: 'http', status: 200, body: { text: '把首页的时钟调大一号' } })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(wb.seen[0]).toMatchObject({ path: ASR_PATH, device: 'dev-1', contentType: 'audio/wav' })
  })
})
