/**
 * 通道凭据向中转要(2026-09-21)。这个文件盯住三件事:
 *
 *   1. **没登录说「登录后可用」**,而不是「通道没配」—— 后者会让一个什么都没做错的
 *      新用户以为是自己漏了一步;
 *   2. **只存内存**:取回来的东西不落盘;失效(过期 / 401)自动重取;
 *   3. **本机那一份优先**:开发机上起着 livekit-server --dev 时,登录不该把它抢走。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CHANNEL_CREDENTIAL_FALLBACK_TTL_MS, createChannelCredentialStore, credentialExpiryMs, parseChannelCredentials,
} from '../src/server/channelCredentials.ts'
import {
  CHANNEL_DEFAULT_ROOM, CHANNEL_DEFAULT_URL, CHANNEL_NO_RELAY_ASR_NOTE, CHANNEL_NO_RELAY_NOTE, createChannelService,
} from '../src/server/channel.ts'
import { NO_RELAY_NOTE } from '../src/server/modelConfig.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER } from '../src/server/rtcCall.ts'

let dir: string
let modelFile: string

/** 中转那边回的一份完整凭据。**值全是编的**。 */
const FULL = {
  livekit: {
    configured: true,
    url: 'wss://lk.example.test',
    room: 'wb-0123456789abcdef',
    token_endpoint: '/v1/channel-token',
    token_ttl_seconds: 604_800,
  },
  volc_asr: { app_id: '1234', access_token: 'asr-token-fake', resource_id: 'volc.bigasr.sauc.duration' },
  volc_tts: { app_id: '1234', access_token: 'tts-token-fake' },
  expires_at: '2026-09-21T04:00:00.000Z',
  store: 'memory-only',
}

const NOW = Date.parse('2026-09-21T03:00:00.000Z')

async function writeModel(config: Record<string, unknown>): Promise<void> {
  await writeFile(modelFile, JSON.stringify({ mode: 'relay', relay_url: 'https://relay.test', device_id: 'dev-1', ...config }))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-channel-creds-'))
  modelFile = join(dir, 'model.json')
})

afterEach(async () => {
  // 删的只有这一轮自己建的那个临时目录(路径来自 mkdtemp,不是拼出来的)。
  await rm(dir, { recursive: true, force: true })
})

describe('parseChannelCredentials', () => {
  it('看不懂的字段丢掉,不猜', () => {
    const parsed = parseChannelCredentials({
      livekit: { configured: true, url: 'wss://x', room: 'wb-1', token_ttl_seconds: 'many' },
      volc_asr: { app_id: '1' }, // 少了 access_token,整块丢掉
      notes: ['一句', 42],
    })
    expect(parsed?.livekit.token_ttl_seconds).toBeUndefined()
    expect(parsed?.volc_asr).toBeUndefined()
    expect(parsed?.notes).toEqual(['一句'])
  })

  it('说 configured 但没给地址 = 没配(回一个连不上的地址不如说没配)', () => {
    expect(parseChannelCredentials({ livekit: { configured: true } })?.livekit.configured).toBe(false)
  })

  it('没写到期时间就给一个保守的短命,不抱着一份旧的不放', () => {
    const parsed = parseChannelCredentials({ livekit: { configured: false } })
    expect(credentialExpiryMs(parsed!, NOW)).toBe(NOW + CHANNEL_CREDENTIAL_FALLBACK_TTL_MS)
  })
})

describe('没接中转(零服务器档)', () => {
  it('不去补令牌、一个包都不发,说「这台没接中转」而不是「登录之后」', async () => {
    await writeModel({ relay_url: '' })
    let ensured = 0
    const store = createChannelCredentialStore({
      modelFile,
      fetchImpl: (() => { throw new Error('不该发请求') }) as unknown as typeof fetch,
      ensureToken: async () => { ensured += 1; return { ok: false } },
    })
    const result = await store.get()
    expect(result).toEqual({ ok: false, reason: 'no_relay', error: expect.stringContaining(NO_RELAY_NOTE) })
    const ticket = await store.issueToken({ identity: 'wb-phone-d1' })
    expect(ticket).toMatchObject({ ok: false, reason: 'no_relay' })
    expect(ensured).toBe(0)
    expect(await store.relayConfigured?.()).toBe(false)
    expect(store.view().reason).toBe('no_relay')
  })

  it('接了中转时 relayConfigured 是真', async () => {
    await writeModel({})
    expect(await createChannelCredentialStore({ modelFile }).relayConfigured?.()).toBe(true)
  })
})

describe('取凭据', () => {
  it('还没领到设备令牌 = 还没登录:说「登录之后」,而不是「没配」', async () => {
    await writeModel({})
    const store = createChannelCredentialStore({ modelFile, fetchImpl: (() => { throw new Error('不该发请求') }) as unknown as typeof fetch })
    const result = await store.get()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not_linked')
    expect(result.error).toContain('登录')
  })

  it('取到了就存在内存里,**不落盘**;第二次不再打网络', async () => {
    await writeModel({ relay_token: 'wb_fake' })
    let calls = 0
    const store = createChannelCredentialStore({
      modelFile,
      now: () => NOW,
      fetchImpl: (async () => { calls += 1; return new Response(JSON.stringify(FULL)) }) as unknown as typeof fetch,
    })
    expect((await store.get()).ok).toBe(true)
    expect((await store.get()).ok).toBe(true)
    expect(calls).toBe(1)
    // 磁盘上那份 model.json 一个字节都没多 —— 凭据没被写下去。
    const onDisk = await readFile(modelFile, 'utf8')
    expect(onDisk).not.toContain('asr-token-fake')
    expect(onDisk).not.toContain('lk.example.test')
    // 显示用的那一份里只有布尔与时间,没有值。
    const view = JSON.stringify(store.view())
    expect(view).not.toContain('asr-token-fake')
    expect(store.view().volc_asr_configured).toBe(true)
  })

  it('过期了自动重取', async () => {
    await writeModel({ relay_token: 'wb_fake' })
    let calls = 0
    let nowMs = NOW
    const store = createChannelCredentialStore({
      modelFile,
      now: () => nowMs,
      fetchImpl: (async () => { calls += 1; return new Response(JSON.stringify(FULL)) }) as unknown as typeof fetch,
    })
    await store.get()
    nowMs = Date.parse('2026-09-21T05:00:00.000Z') // 过了 expires_at
    await store.get()
    expect(calls).toBe(2)
  })

  it('同一时刻问两次只打一次网络(工人、手机、状态面板会一起问)', async () => {
    await writeModel({ relay_token: 'wb_fake' })
    let calls = 0
    const store = createChannelCredentialStore({
      modelFile,
      now: () => NOW,
      fetchImpl: (async () => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 5))
        return new Response(JSON.stringify(FULL))
      }) as unknown as typeof fetch,
    })
    await Promise.all([store.get(), store.get(), store.get()])
    expect(calls).toBe(1)
  })

  it('401 说「重新登录一次」;连不上说「连不上」—— 两句话不混', async () => {
    await writeModel({ relay_token: 'wb_fake' })
    const unauthorized = createChannelCredentialStore({
      modelFile,
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'x' } }), { status: 401 })) as unknown as typeof fetch,
    })
    const a = await unauthorized.get()
    expect(a.ok === false && a.reason).toBe('unauthorized')

    const offline = createChannelCredentialStore({
      modelFile,
      fetchImpl: (async () => { throw new Error('ECONNREFUSED https://relay.test') }) as unknown as typeof fetch,
    })
    const b = await offline.get()
    expect(b.ok).toBe(false)
    // 底层报错可能把地址抖出来,一律换成自己的措辞。
    expect(b.ok === false && b.error).not.toContain('relay.test')
  })

  it('服务器说缺什么就原样带上那句话', async () => {
    await writeModel({ relay_token: 'wb_fake' })
    const store = createChannelCredentialStore({
      modelFile,
      fetchImpl: (async () => new Response(JSON.stringify({
        livekit: { configured: false }, notes: ['服务器上还没配 LiveKit'],
      }))) as unknown as typeof fetch,
    })
    const result = await store.get()
    expect(result.ok && result.credentials.notes?.[0]).toContain('LiveKit')
  })

  it('没令牌时先去补一次,补上了就接着取', async () => {
    await writeModel({})
    let ensured = 0
    const store = createChannelCredentialStore({
      modelFile,
      now: () => NOW,
      ensureToken: async () => {
        ensured += 1
        await writeModel({ relay_token: 'wb_just_issued' })
        return { ok: true }
      },
      fetchImpl: (async () => new Response(JSON.stringify(FULL))) as unknown as typeof fetch,
    })
    expect((await store.get()).ok).toBe(true)
    expect(ensured).toBe(1)
  })

  it('日志里只有「取到没取到」,一个值都没有', async () => {
    await writeModel({ relay_token: 'wb_fake' })
    const lines: string[] = []
    const store = createChannelCredentialStore({
      modelFile,
      now: () => NOW,
      log: line => lines.push(line),
      fetchImpl: (async () => new Response(JSON.stringify(FULL))) as unknown as typeof fetch,
    })
    await store.get()
    const all = lines.join('\n')
    expect(all).toContain('取到了')
    expect(all).not.toContain('asr-token-fake')
    expect(all).not.toContain('wb_fake')
  })
})

describe('签进房凭证', () => {
  it('身份与设备属性由我们拼,原样交给中转', async () => {
    await writeModel({ relay_token: 'wb_fake' })
    let seen: { url: string, body: unknown } | undefined
    const store = createChannelCredentialStore({
      modelFile,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, body: JSON.parse(String(init.body)) }
        return new Response(JSON.stringify({
          url: 'wss://lk.example.test', room: 'wb-1', identity: 'wb-phone-abc', token: 'jwt.fake.sig', expires_at: 9,
        }))
      }) as unknown as typeof fetch,
    })
    const result = await store.issueToken({ identity: 'wb-phone-abc', attributes: { wb_device_id: 'abc' } })
    expect(result.ok).toBe(true)
    expect(seen?.url).toBe('https://relay.test/v1/channel-token')
    expect(seen?.body).toEqual({ identity: 'wb-phone-abc', attributes: { wb_device_id: 'abc' } })
  })

  it('401 时把手上那份凭据也扔掉(令牌换过了,房间名要跟着重取)', async () => {
    await writeModel({ relay_token: 'wb_fake' })
    let step = 0
    const store = createChannelCredentialStore({
      modelFile,
      now: () => NOW,
      fetchImpl: (async (url: string) => {
        if (url.endsWith('/v1/channel-credentials')) { step += 1; return new Response(JSON.stringify(FULL)) }
        return new Response(JSON.stringify({ error: { message: 'x' } }), { status: 401 })
      }) as unknown as typeof fetch,
    })
    await store.get()
    expect(step).toBe(1)
    await store.issueToken({ identity: 'wb-phone-abc' })
    expect(store.view().cached).toBe(false)
    await store.get()
    expect(step).toBe(2)
  })
})

describe('接进 ChannelService', () => {
  /** 一个够用的假 store —— 只实现 ChannelService 真会用到的那几件事。 */
  function fakeStore(overrides: Partial<ReturnType<typeof createChannelCredentialStore>> = {}) {
    return {
      get: async () => ({ ok: true as const, credentials: parseChannelCredentials(FULL)! }),
      issueToken: async () => ({
        ok: true as const,
        ticket: { url: 'wss://lk.example.test', room: 'wb-0123456789abcdef', identity: 'x', token: 'jwt.fake.sig', expires_at: 9 },
      }),
      view: () => ({ cached: true }),
      forget: () => {},
      ...overrides,
    } as ReturnType<typeof createChannelCredentialStore>
  }

  function service(
    remote: ReturnType<typeof createChannelCredentialStore>,
    env: Record<string, string> = {},
    more: Partial<Parameters<typeof createChannelService>[0]> = {},
  ) {
    return createChannelService({
      agentsFile: '/x',
      env,
      configFile: '/不存在',
      rememberTool: CALL_TOOL_REMEMBER,
      doingTool: CALL_TOOL_DOING,
      remote,
      ...more,
      fetchImpl: (async () => new Response(JSON.stringify({ participants: [{ identity: 'wb-channel-worker' }] }))) as unknown as typeof fetch,
    })
  }

  it('本机没配时走服务器那一份:地址与房间名都是服务器给的', async () => {
    const view = await service(fakeStore()).view()
    expect(view.configured).toBe(true)
    expect(view.source).toBe('server')
    expect(view.url).toBe('wss://lk.example.test')
    expect(view.room).toBe('wb-0123456789abcdef')
  })

  it('本机配了就用本机的:登录不该把开发机上那台 dev 服务器抢走', async () => {
    const view = await service(fakeStore(), {
      WORKBENCH_CHANNEL_API_KEY: 'local-key',
      WORKBENCH_CHANNEL_API_SECRET: 'local-secret',
    }).view()
    expect(view.source).toBe('local')
    expect(view.url).toBe(CHANNEL_DEFAULT_URL)
    expect(view.room).toBe(CHANNEL_DEFAULT_ROOM)
  })

  it('进房凭证由中转签,我们只把它转出去', async () => {
    const issued = await service(fakeStore()).issue({ deviceId: 'abc' })
    expect(issued?.token).toBe('jwt.fake.sig')
    expect(issued?.room).toBe('wb-0123456789abcdef')
  })

  it('还没登录时 status 说「登录后可用」并带 needs_login', async () => {
    const status = await service(fakeStore({
      get: async () => ({ ok: false as const, reason: 'not_linked' as const, error: '这台机器还没领到服务器凭证,通道要登录之后才能用。' }),
    })).status()
    expect(status.configured).toBe(false)
    expect(status.needs_login).toBe(true)
    expect(status.note).toContain('登录')
    expect(status.source).toBe('none')
  })

  it('服务器那条路上探得到房间,工人在不在照样看得出来', async () => {
    const status = await service(fakeStore()).status()
    expect(status.source).toBe('server')
    expect(status.server).toBe(true)
    expect(status.worker).toBe(true)
  })

  it('/channel/credentials 那一份:有火山凭据、有到期时间、没有 LiveKit 的任何东西', async () => {
    const creds = await service(fakeStore()).credentials()
    expect(creds.source).toBe('server')
    expect(creds.volc_asr?.access_token).toBe('asr-token-fake')
    expect(creds.expires_at).toBe('2026-09-21T04:00:00.000Z')
    expect(JSON.stringify(creds)).not.toContain('lk.example.test')
  })

  it('没登录时 /channel/credentials 也说「登录之后」,不回空对象', async () => {
    const creds = await service(fakeStore({
      get: async () => ({ ok: false as const, reason: 'not_linked' as const, error: '这台机器还没领到服务器凭证,通道要登录之后才能用。' }),
    })).credentials()
    expect(creds.source).toBe('none')
    expect(creds.note).toContain('登录')
    expect(creds.volc_asr).toBeUndefined()
  })

  const NO_RELAY = {
    get: async () => ({ ok: false as const, reason: 'no_relay' as const, error: '这台没接中转。' }),
    issueToken: async () => ({ ok: false as const, reason: 'no_relay' as const, error: '这台没接中转。' }),
    relayConfigured: async () => false,
  }
  const OWN_ASR = { app_id: 'own-app', access_token: 'own-asr-token-fake' }

  it('没接中转:status 说电话只走家里,不提「登录」', async () => {
    const status = await service(fakeStore(NO_RELAY)).status()
    expect(status.configured).toBe(false)
    expect(status.needs_login).toBeFalsy()
    expect(status.note).toBe(CHANNEL_NO_RELAY_NOTE)
  })

  it('没接中转:/channel/credentials 出这台电脑自己的识别钥匙(她在设置里填的)', async () => {
    const creds = await service(fakeStore(NO_RELAY), {}, { localKeys: async () => ({ volc_asr: OWN_ASR }) }).credentials()
    expect(creds).toEqual({ source: 'local', volc_asr: OWN_ASR })
  })

  it('没接中转、也没填识别钥匙:说去哪填,不说「登录之后」', async () => {
    const creds = await service(fakeStore(NO_RELAY), {}, { localKeys: async () => ({}) }).credentials()
    expect(creds).toEqual({ source: 'none', note: CHANNEL_NO_RELAY_ASR_NOTE })
  })

  it('自己填了识别钥匙就先用自己的(接了中转也一样,不往中转要)', async () => {
    let asked = 0
    const creds = await service(fakeStore({ get: async () => { asked += 1; return { ok: true as const, credentials: parseChannelCredentials(FULL)! } } }), {}, {
      localKeys: async () => ({ volc_asr: OWN_ASR }),
    }).credentials()
    expect(creds.volc_asr).toEqual(OWN_ASR)
    expect(asked).toBe(0)
  })

  it('/channel/route:没接中转时整格 relay 缺席;接了中转时照旧带着', async () => {
    const env = { WORKBENCH_CHANNEL_API_KEY: 'local-key', WORKBENCH_CHANNEL_API_SECRET: 'local-secret' }
    const none = await service(fakeStore(NO_RELAY), env).route()
    expect(none).not.toHaveProperty('relay')
    const linked = await service(fakeStore({ view: () => ({ cached: true, livekit_configured: true }) }), env).route()
    expect(linked.relay).toEqual({ configured: true })
  })

  it('没接中转:工人点名要云房间(卡 M6 的第二条工人)→ 签不出,一个包都不往中转发', async () => {
    let relayAsked = 0
    const env = { WORKBENCH_CHANNEL_API_KEY: 'local-key', WORKBENCH_CHANNEL_API_SECRET: 'local-secret-0123456789abcdef0123456789' }
    const issued = await service(fakeStore({ ...NO_RELAY, issueToken: async () => { relayAsked += 1; return NO_RELAY.issueToken() } }), env)
      .issue({ worker: true, suffix: 'relay' }, { want: 'relay' })
    expect(issued).toBeUndefined()
    expect(relayAsked).toBe(0)
  })

  it('没接中转:外网来的签票不走中转那条路,直接签本机', async () => {
    let relayAsked = 0
    const env = { WORKBENCH_CHANNEL_API_KEY: 'local-key', WORKBENCH_CHANNEL_API_SECRET: 'local-secret-0123456789abcdef0123456789' }
    const issued = await service(fakeStore({ ...NO_RELAY, issueToken: async () => { relayAsked += 1; return NO_RELAY.issueToken() } }), env)
      .issue({ deviceId: 'abc' }, { localAddress: '192.168.1.5', remoteAddress: '203.0.113.9' })
    expect(relayAsked).toBe(0)
    expect(issued?.route).toBe('lan')
  })
})
