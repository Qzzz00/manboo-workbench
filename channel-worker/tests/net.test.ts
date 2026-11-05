/**
 * 工人往外发的那几条 HTTP:对 8791 的三件工具与两样凭证,对 8792 的 TTS 与 ASR。
 * 两边都是桩 —— 这里验的是**工人发出去什么、收回来怎么解释**,不是那两台服务会不会答应。
 *
 * 重点在**失败那一半**:8791 不在、回 403、回一句「会话未开」,工人都必须变成一句
 * 能在电话里说出口的实话,而不是抛异常把通话带走。
 */
import { describe, expect, it } from 'vitest'
import { createWorkbenchClient } from '../src/workbench.ts'
import { SegmentedStt, transcriptOfAsrBody } from '../src/asr/segmentedStt.ts'
import { ButlerTts } from '../src/tts/butlerTts.ts'
import { AudioFrame } from '@livekit/rtc-node'
import { encodeWav, pcmOfInt16 } from '../src/audio/wav.ts'

interface Call { url: string, body: unknown }

/** 一个记账的假 fetch。`reply` 按路径给回包。 */
function stubFetch(reply: (path: string) => { status: number, body: unknown, contentType?: string, raw?: Buffer }) {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = new URL(url).pathname
    const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    calls.push({ url, body: parsed })
    const result = reply(path)
    const payload = result.raw ?? Buffer.from(JSON.stringify(result.body))
    return new Response(payload, {
      status: result.status,
      headers: { 'content-type': result.contentType ?? 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('工作台客户端:取凭证与人设', () => {
  it('凭证请求带 worker: true——工人要的是那个固定身份', async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: { url: 'ws://127.0.0.1:7880', room: 'workbench', identity: 'wb-channel-worker', token: 'jwt', expires_at: 1 },
    }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl, workerName: '事务官' })
    const ticket = await client.ticket()
    expect(ticket.identity).toBe('wb-channel-worker')
    expect(stub.calls[0]?.body).toEqual({ worker: true, name: '事务官' })
  })

  it('凭证签不出来时报错带上工作台那句人话', async () => {
    const stub = stubFetch(() => ({ status: 503, body: { error: '通道层没配 LiveKit 的 api key / secret,签不出进房凭证' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    await expect(client.ticket()).rejects.toThrow('没配 LiveKit')
  })

  it('人设形状不对就当拿不到,不半生不熟地用', async () => {
    const stub = stubFetch(() => ({ status: 200, body: { welcome: '喂' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    await expect(client.persona()).rejects.toThrow('形状不对')
  })

  /**
   * 第三方凭据(2026-09-21)。工人从此**一个文件都不读** —— 钥匙在我们的服务器上,
   * 工作台登录后取回来,工人向 8791 问它。这一条的全部纪律是:**取不到绝不抛**。
   */
  describe('取通道凭据', () => {
    it('拿到了就原样带回来', async () => {
      const stub = stubFetch(() => ({
        status: 200,
        body: {
          source: 'server',
          volc_asr: { app_id: '1234', access_token: 'asr-token-fake' },
          expires_at: '2026-09-21T04:00:00.000Z',
        },
      }))
      const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
      const creds = await client.credentials()
      expect(creds.source).toBe('server')
      expect(creds.volc_asr?.access_token).toBe('asr-token-fake')
      expect(stub.calls[0]?.url).toContain('/channel/credentials')
    })

    it('老版本的工作台没有这条路(404):说清楚是这一种「没有」,不抛', async () => {
      const stub = stubFetch(() => ({ status: 404, body: { error: '没有这个路径' } }))
      const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
      const creds = await client.credentials()
      expect(creds.source).toBe('none')
      expect(creds.note).toContain('旧版')
    })

    it('还没登录:把工作台那句人话原样带回来', async () => {
      const stub = stubFetch(() => ({
        status: 200,
        body: { source: 'none', note: '通道密钥由服务器在登录后下发。这台机器还没领到服务器凭证,通道要登录之后才能用。' },
      }))
      const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
      const creds = await client.credentials()
      expect(creds.source).toBe('none')
      expect(creds.note).toContain('登录')
      expect(creds.volc_asr).toBeUndefined()
    })

    it('8791 压根不在(工作台在重启):也不抛', async () => {
      const impl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
      const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: impl })
      const creds = await client.credentials()
      expect(creds.source).toBe('none')
      expect(creds.note).toContain('问不到')
    })
  })
})

describe('工作台客户端:三件工具', () => {
  it('记一件事 → POST /butler/item,原话不改写', async () => {
    const stub = stubFetch(() => ({ status: 200, body: { ok: true, id: 't-7', conversation: { agent: 'dsh', session_id: 's1' } } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.rememberItem('  记一下明天开会  ')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('t-7')
    expect(result.text).toContain('我让事务官去办')
    expect(stub.calls[0]?.url).toContain('/butler/item')
    // `source:'call'`(2026-09-24,卡 F):这句话在电话里已经过了确认点那道门。
    expect(stub.calls[0]?.body).toEqual({ text: '记一下明天开会', source: 'call', client_key: expect.any(String) })
  })

  it('会话没开成时**不许**说「我让事务官去办」', async () => {
    const stub = stubFetch(() => ({ status: 200, body: { ok: true, id: 't-8', note: '会话未开' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.rememberItem('订机票')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('会话未开')
    expect(result.text).not.toContain('我让事务官去办,办完告诉你')
  })

  it('工作台拒绝 / 连不上,都变成一句「如实告诉他」', async () => {
    const denied = stubFetch(() => ({ status: 403, body: { error: '授权门关着' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: denied.impl })
    const result = await client.rememberItem('x')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('授权门关着')

    const broken = createWorkbenchClient({
      baseUrl: 'http://127.0.0.1:8791',
      fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
    })
    const offline = await broken.rememberItem('x')
    expect(offline.ok).toBe(false)
    expect(offline.text).toContain('连不上')
  })

  it('查在办 → GET /state,念出来的那段带 id、不含待排', async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: { tasks: { tasks: [{ id: 't-1', title: '订机票', status: 'doing' }, { id: 't-9', title: '以后再说', status: 'backlog' }] } },
    }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.listDoing()
    expect(result.text).toContain('在办:订机票(id t-1)')
    expect(result.text).not.toContain('以后再说')
  })

  it('查不到就说查不到,不凭印象编', async () => {
    const client = createWorkbenchClient({
      baseUrl: 'http://127.0.0.1:8791',
      fetchImpl: (async () => { throw new Error('down') }) as unknown as typeof fetch,
    })
    const result = await client.listDoing()
    expect(result.ok).toBe(false)
    expect(result.text).toContain('别凭印象说')
  })

  it('「XX 到哪了」→ POST /progress/ask,照工作台按证据核的那一句说;认不出 / 旧版 / 连不上都如实说(卡 N)', async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: { ok: true, line: '「参赛网页架构收尾」:11 屏已做完,逐屏文案稿在等你审(依据:Codex 里「制作参赛网页」那段对话 · 9月24日 20:17)', results: [] },
    }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    expect((await client.askProgress('  ')).ok).toBe(false)
    expect(stub.calls).toHaveLength(0)
    const result = await client.askProgress('参赛网页到哪了?')
    expect(stub.calls.map(call => [new URL(call.url).pathname, call.body])).toEqual([['/progress/ask', { text: '参赛网页到哪了?' }]])
    expect(result.ok).toBe(true)
    expect(result.text).toContain('11 屏已做完,逐屏文案稿在等你审')

    const unknown = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stubFetch(() => ({ status: 200, body: { ok: false, line: '看板上没认出你说的是哪一件', results: [] } })).impl })
    expect((await unknown.askProgress('天气到哪了')).text).toContain('问他是哪一件')
    const old = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stubFetch(() => ({ status: 404, body: { error: 'not found' } })).impl })
    expect((await old.askProgress('参赛网页到哪了')).text).toContain('还不会核进度')
    const down = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: (async () => { throw new Error('down') }) as unknown as typeof fetch })
    expect((await down.askProgress('参赛网页到哪了')).text).toContain('别凭印象说')
  })

  /**
   * 捎话给某条会话(2026-09-26,卡 BR)。维护者 16:41 那一通要的就是这条路,
   * 而那会儿只有 `askButler` 这条**要事项 id** 的路 —— 于是他听到「它归哪件事」。
   */
  it('★捎话 → POST /sessions/relay(不带事项 id);捎到 / 要他选 / 捎不到 / 旧版 / 连不上,五种都说实话', async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: { ok: true, route: 'window', agent: 'claude', session_id: 'd9991aac', mark: '事务官捎话 d9991a', note: '捎到了 —— 你那句话已经送进 Claude 那条会话里了。' },
    }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    // 缺一样就不发请求(不猜是哪一条、不送空话)
    expect((await client.relayToSession({ who: '', text: '到哪了' })).ok).toBe(false)
    expect((await client.relayToSession({ who: '统筹交接那条', text: '  ' })).ok).toBe(false)
    expect(stub.calls).toHaveLength(0)

    const got = await client.relayToSession({ who: '正在做统筹交接的那个 Claude 会话', text: '现在进行到什么情况,大概什么时候能处理完' })
    expect(stub.calls.map(call => [new URL(call.url).pathname, call.body])).toEqual([[
      '/sessions/relay',
      // `from:'call'`(2026-09-27,卡 CB):这一句是电话里让捎的 —— 回电转述时那句人话才说得出
      // 「你**电话里**让我捎的那句话」。
      { who: '正在做统筹交接的那个 Claude 会话', text: '现在进行到什么情况,大概什么时候能处理完', from: 'call', client_key: expect.any(String) },
    ]])
    expect(got.ok).toBe(true)
    expect(got.text).toContain('捎到了')

    // 几条都对得上:念给他选,**不许自己挑一条**
    const pick = createWorkbenchClient({
      baseUrl: 'http://127.0.0.1:8791',
      fetchImpl: stubFetch(() => ({ status: 200, body: { ok: false, where: 'pick', note: '有 2 条都对得上:1. …;2. …。问他是哪一条。' } })).impl,
    })
    const picked = await pick.relayToSession({ who: '给 Claude 发个信息', text: '到哪了' })
    expect(picked.ok).toBe(false)
    expect(picked.text).toContain('有 2 条都对得上')
    expect(picked.text).toContain('别自己挑一条送')

    // 捎不到:照原话说,不说成送到了
    const desk = createWorkbenchClient({
      baseUrl: 'http://127.0.0.1:8791',
      fetchImpl: stubFetch(() => ({ status: 200, body: { ok: false, where: 'desk', note: '捎不进去:这句话得你到电脑上的 Claude 里自己说(窗口里没找到那段对话)' } })).impl,
    })
    expect((await desk.relayToSession({ who: '统筹交接那条', text: '到哪了' })).text).toContain('捎不进去')

    const old = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stubFetch(() => ({ status: 404, body: { error: 'not found' } })).impl })
    expect((await old.relayToSession({ who: '统筹交接那条', text: '到哪了' })).text).toContain('还不会往会话里捎话')
    const down = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: (async () => { throw new Error('down') }) as unknown as typeof fetch })
    expect((await down.relayToSession({ who: '统筹交接那条', text: '到哪了' })).text).toContain('没捎进去')
  })

  it('补一句 → POST /butler/item/say,缺 id 或缺话就不发请求', async () => {
    const stub = stubFetch(() => ({ status: 200, body: { ok: true, id: 't-1', session_id: 's1' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    expect((await client.handToButler('', '话')).ok).toBe(false)
    expect(stub.calls).toHaveLength(0)
    const result = await client.handToButler('t-1', '顺便把票也退了')
    expect(result.ok).toBe(true)
    expect(stub.calls[0]?.url).toContain('/butler/item/say')
    expect(stub.calls[0]?.body).toEqual({ id: 't-1', text: '顺便把票也退了', client_key: expect.any(String) })
  })

  it('那条会话已经没了:如实说没送到', async () => {
    const stub = stubFetch(() => ({ status: 409, body: { error: '这条会话在 DSH 里已经没了' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.handToButler('t-1', '话')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('已经没了')
  })
})

describe('分段 ASR(8792)', () => {
  function frameOf(seconds: number): AudioFrame {
    const samples = new Int16Array(Math.round(16000 * seconds))
    return new AudioFrame(samples, 16000, 1, samples.length)
  }

  it('把这一段转成 WAV 的 base64 发过去,拿回文字', async () => {
    const stub = stubFetch(() => ({ status: 200, body: { text: '记下，明天上午10点开会。' } }))
    const stt = new SegmentedStt({ butlerUrl: 'http://127.0.0.1:8792', fetchImpl: stub.impl })
    // @ts-expect-error 走 protected 的 _recognize:公开的 recognize 会带上重试与埋点,这里只要那一段逻辑。
    const event = await stt._recognize(frameOf(1))
    expect(event.alternatives?.[0]?.text).toBe('记下，明天上午10点开会。')
    const sent = (stub.calls[0]?.body as { audio: string }).audio
    expect(Buffer.from(sent, 'base64').subarray(0, 4).toString('ascii')).toBe('RIFF')
  })

  it('太短的段根本不发请求(那是咳嗽,不是话)', async () => {
    const stub = stubFetch(() => ({ status: 200, body: { text: 'x' } }))
    const stt = new SegmentedStt({ butlerUrl: 'http://127.0.0.1:8792', fetchImpl: stub.impl })
    // @ts-expect-error 同上
    const event = await stt._recognize(frameOf(0.1))
    expect(event.alternatives).toBeUndefined()
    expect(stub.calls).toHaveLength(0)
  })

  it('8792 不在 / 回 503 / 回空,都当作「这句没听清」,不抛', async () => {
    const dead = new SegmentedStt({
      butlerUrl: 'http://127.0.0.1:8792',
      fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
    })
    // @ts-expect-error 同上
    expect((await dead._recognize(frameOf(1))).alternatives).toBeUndefined()

    const notConfigured = new SegmentedStt({
      butlerUrl: 'http://127.0.0.1:8792',
      fetchImpl: stubFetch(() => ({ status: 503, body: { code: 'voice_not_configured' } })).impl,
    })
    // @ts-expect-error 同上
    expect((await notConfigured._recognize(frameOf(1))).alternatives).toBeUndefined()

    expect(transcriptOfAsrBody({ text: '   ' })).toBe('')
    expect(transcriptOfAsrBody(null)).toBe('')
  })
})

describe('TTS(8792)', () => {
  it('要 wav、只传 scene(音色由 8792 按绑定解析),回来的 PCM 进一帧音频', async () => {
    const pcm = pcmOfInt16(Int16Array.from([0, 100, -100, 200]))
    const stub = stubFetch(() => ({
      status: 200,
      contentType: 'audio/wav',
      raw: encodeWav(pcm, 24000, 1),
      body: null,
    }))
    const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl: stub.impl })
    const chunks = []
    for await (const audio of tts.synthesize('你好')) chunks.push(audio)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.frame.sampleRate).toBe(24000)
    expect(chunks[0]?.frame.data.length).toBe(4)
    expect(stub.calls[0]?.body).toEqual({ text: '你好', scene: 'chat', encoding: 'wav' })
  })

  it('没配语音供应商密钥(503)不假装出过声', async () => {
    const stub = stubFetch(() => ({ status: 503, body: { code: 'voice_not_configured' } }))
    const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl: stub.impl })
    // 框架把合成失败发成 TTS 的 'error' 事件。EventEmitter 上没人听 'error' 会直接把进程掀翻,
    // 所以生产里 AgentSession 一定接着这个事件;用例里也接一下,否则验的就不是我们这段逻辑了。
    const errors: string[] = []
    tts.on('error', ev => errors.push(ev.error.message))
    const chunks = []
    for await (const audio of tts.synthesize('你好')) chunks.push(audio)
    // 一帧音频都没有 + 一条说清原因的错误 + **没有未处理的拒绝**(run() 不抛,理由见实现)。
    expect(chunks).toHaveLength(0)
    expect(errors[0]).toContain('合成失败(503)')
  })
})

/**
 * 房间代理那两条(2026-09-17)。**最要紧的一句话:那条降权的头必须真的在请求里。**
 * 少了它,工人就是在用回环全权替房里的人办事 —— 这一条测的就是那个。
 */
describe('工作台客户端:替手机办事(降权)', () => {
  function headerStub(reply: (path: string) => { status: number, body: unknown }) {
    const calls: { url: string, method: string, device?: string, contentType?: string, body: unknown }[] = []
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(headers.get('x-workbench-channel-device') === null ? {} : { device: headers.get('x-workbench-channel-device') as string }),
        ...(headers.get('content-type') === null ? {} : { contentType: headers.get('content-type') as string }),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
      })
      const result = reply(new URL(url).pathname)
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  it('callAsDevice 带上 X-Workbench-Channel-Device,回包原样交回去', async () => {
    const stub = headerStub(() => ({ status: 200, body: { id: 't-1' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.callAsDevice({ deviceId: 'dev-1', method: 'POST', path: '/butler/item', body: { text: '记一下' } })
    expect(result).toEqual({ status: 200, body: { id: 't-1' } })
    expect(stub.calls[0]).toEqual({
      url: 'http://127.0.0.1:8791/butler/item',
      method: 'POST',
      device: 'dev-1',
      contentType: 'application/json',
      body: { text: '记一下' },
    })
  })

  it('GET 不带 body,也不带 content-type', async () => {
    const stub = headerStub(() => ({ status: 200, body: { ok: true } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    await client.callAsDevice({ deviceId: 'dev-1', method: 'GET', path: '/onboarding/turns?after=3' })
    expect(stub.calls[0]).toEqual({
      url: 'http://127.0.0.1:8791/onboarding/turns?after=3',
      method: 'GET',
      device: 'dev-1',
    })
  })

  it('8791 的 403 原样交回去——不翻译成别的', async () => {
    const stub = headerStub(() => ({ status: 403, body: { error: '只能在本机生成配对码' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    expect(await client.callAsDevice({ deviceId: 'dev-1', method: 'POST', path: '/pair/start' }))
      .toEqual({ status: 403, body: { error: '只能在本机生成配对码' } })
  })

  it('renewTicket 同样降权,拿回 token 与到期时间(2026-10-21 起连地址与房间一起带回)', async () => {
    const stub = headerStub(() => ({ status: 200, body: { url: 'ws://x', room: 'workbench', identity: 'wb-phone-dev-1', token: 'jwt2', expires_at: 999 } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    expect(await client.renewTicket('dev-1')).toEqual({ token: 'jwt2', expires_at: 999, url: 'ws://x', room: 'workbench' })
    expect(stub.calls[0]?.device).toBe('dev-1')
    // name 不传:房里显示的名字由配对时定,续期不该把它改了
    expect(stub.calls[0]?.body).toEqual({})
  })

  it('续期被拒(设备刚解除配对)如实回原因,不抛', async () => {
    const stub = headerStub(() => ({ status: 401, body: { error: '这台设备没配对过,或者已经解除配对了' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    expect(await client.renewTicket('dev-1')).toEqual({ status: 401, error: '这台设备没配对过,或者已经解除配对了' })
  })

  it('工作台连不上时续期回一句人话,不抛', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: impl })
    expect(await client.renewTicket('dev-1')).toEqual({ status: 0, error: '工作台连不上,这张凭证续不了' })
  })
})
