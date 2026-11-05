// @vitest-environment node
/**
 * 把按模型的周窗口并进 Claude 那一格。
 *
 * 分工：统一的 5h/周 仍由响应头那条路给（实时），这条只补它补不了的按模型窗口。
 * 两边合成一格，顺序是「先统一窗口、后按模型窗口」——与官方 Usage 页面同序。
 */
import { describe, expect, it, vi } from 'vitest'
import { collectQuota } from '../src/quota/collect.ts'
import { createClaudeScopedGate } from '../src/quota/claudeScopedGate.ts'
import type { WindowQuota } from '../src/protocol.ts'

const HEADERS = {
  'anthropic-ratelimit-unified-5h-utilization': '0.2',
  'anthropic-ratelimit-unified-5h-reset': '1787670000',
  'anthropic-ratelimit-unified-7d-utilization': '0.65',
  'anthropic-ratelimit-unified-7d-reset': '1787673600',
}

const SCOPED_BODY = {
  limits: [
    { kind: 'weekly', percent: 65 },
    {
      kind: 'weekly_scoped',
      percent: 80,
      resets_at: '2026-08-25T16:00:00.000Z',
      scope: { model: { display_name: 'Fable' } },
    },
  ],
}

/** 只回 Claude 两条路要的东西；其余家一律失败，本用例不关心它们。 */
function fetchStub(scoped: { status: number, body: unknown }) {
  return vi.fn(async (url: string) => {
    const target = String(url)
    if (target.includes('/api/oauth/usage')) {
      return {
        ok: scoped.status < 400,
        status: scoped.status,
        json: async () => scoped.body,
        text: async () => JSON.stringify(scoped.body),
        headers: { get: () => null },
      }
    }
    if (target.includes('/v1/messages')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
        headers: { get: (n: string) => (HEADERS as Record<string, string>)[n.toLowerCase()] ?? null },
      }
    }
    throw new Error('本用例不打这个地址')
  }) as never
}

function options(scoped: { status: number, body: unknown }) {
  return {
    env: {},
    credentials: { claude_api: 'tok-inference' },
    fetch: fetchStub(scoped),
    // 按模型窗口那条路要的两样：keychain 读出来的 JSON、已装版本目录。
    claudeScopedIo: {
      readKeychain: async () => '{"claudeAiOauth":{"accessToken":"tok-profile"}}',
      readVersions: async () => ['2.1.212', '2.1.237'],
    },
    // Codex 那两条路也要喂桩——collect.ts 的选项注释明写「测试用桩,绝不 spawn 真的
    // codex app-server」,但本文件此前没喂,于是每个用例都真的起了一个子进程。
    // 单次调用勉强压在 5 秒超时线内所以一直没露馅;下面有个用例连调三次 collectQuota,
    // 立刻就超时了。本文件只关心 Claude 那一格,Codex 两条路一律让它干净地失败。
    codexAppServerIo: { readRateLimits: async () => { throw new Error('本用例不打 codex app-server') } },
    codexIo: {
      listSessionFiles: async () => [],
      readFile: async () => { throw new Error('本用例不读 codex 会话文件') },
    },
  }
}

describe('collectQuota：Claude 的按模型周窗口', () => {
  it('★统一窗口 + 按模型窗口合成一格，Fable 那条在最后', async () => {
    const result = await collectQuota(options({ status: 200, body: SCOPED_BODY }))
    const claude = result.quota.claude as WindowQuota

    expect(claude.kind).toBe('quota')
    expect(claude.windows.map(w => w.label)).toEqual(['5h', '周', 'Fable'])
    expect(claude.windows[2]).toEqual({
      label: 'Fable', left_pct: 20, reset_at: '2026-08-25T16:00:00.000Z',
    })
  })

  it('按模型那条取不到时，统一的两个窗口照常显示——少一栏，不是整格塌掉', async () => {
    const result = await collectQuota(options({ status: 500, body: {} }))
    const claude = result.quota.claude as WindowQuota

    expect(claude.windows.map(w => w.label)).toEqual(['5h', '周'])
  })

  it('★403（缺 user:profile）要在 note 里说清楚要重新登录，不许闷声少一栏', async () => {
    const result = await collectQuota(options({
      status: 403,
      body: { error: { message: 'OAuth token does not meet scope requirement user:profile' } },
    }))
    const claude = result.quota.claude as WindowQuota

    expect(claude.windows.map(w => w.label)).toEqual(['5h', '周'])
    // 断言 alert 而不是 note:note 按 protocol.ts 是给 /state 看的调试字段,
    // 界面那层会整个覆盖掉它——话写在 note 里等于没写(2026-08-26 真机实证:
    // Fable 那栏消失一整天,屏幕上一个字线索都没有)。alert 才是会显示的那个。
    expect(claude.alert).toContain('claude auth login')
  })

  it('★传了闸门时:限频期内不重复打 usage 端点,但 Fable 那栏照常在(2026-08-26 限流根因)', async () => {
    const fetchImpl = fetchStub({ status: 200, body: SCOPED_BODY })
    const gate = createClaudeScopedGate({ minIntervalMs: 15 * 60_000, now: () => nowMs })
    let nowMs = 1_000_000

    const first = await collectQuota({ ...options({ status: 200, body: SCOPED_BODY }), fetch: fetchImpl, claudeScopedGate: gate })
    expect((first.quota.claude as WindowQuota).windows.map(w => w.label)).toEqual(['5h', '周', 'Fable'])

    const usageHits = () => (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(call => String(call[0]).includes('/api/oauth/usage')).length
    expect(usageHits()).toBe(1)

    // 采集器一分钟后又跑一轮:端点一次都不许再打,但 Fable 必须还在。
    nowMs += 60_000
    const second = await collectQuota({ ...options({ status: 200, body: SCOPED_BODY }), fetch: fetchImpl, claudeScopedGate: gate })
    expect(usageHits()).toBe(1)
    expect((second.quota.claude as WindowQuota).windows.map(w => w.label)).toEqual(['5h', '周', 'Fable'])

    // 过了限频间隔才再打一次。
    nowMs += 15 * 60_000
    await collectQuota({ ...options({ status: 200, body: SCOPED_BODY }), fetch: fetchImpl, claudeScopedGate: gate })
    expect(usageHits()).toBe(2)
  })

  it('★429 连着两轮:统一窗口不受连累,note 里写明 Fable 暂缺的原因', async () => {
    const gate = createClaudeScopedGate({ minIntervalMs: 0, now: () => nowMs })
    let nowMs = 1_000_000

    await collectQuota({ ...options({ status: 429, body: {} }), claudeScopedGate: gate })
    nowMs += 60_000
    const second = await collectQuota({ ...options({ status: 429, body: {} }), claudeScopedGate: gate })
    const claude = second.quota.claude as WindowQuota

    expect(claude.windows.map(w => w.label)).toEqual(['5h', '周'])
    expect(claude.alert).toContain('Fable')
  })

  it('★only:[claude] 时另外三家的接口一次都不打(60 秒快路的白打问题)', async () => {
    const fetchImpl = fetchStub({ status: 200, body: SCOPED_BODY })
    const result = await collectQuota({
      ...options({ status: 200, body: SCOPED_BODY }),
      fetch: fetchImpl,
      only: ['claude'],
    })

    // Claude 照常取到(两条路都走)。
    expect((result.quota.claude as WindowQuota).windows.map(w => w.label)).toEqual(['5h', '周', 'Fable'])
    // 另外三家保持"未接入"占位,且它们的取数一次都没发生——fetchStub 遇到别的地址会抛。
    for (const agent of ['dsh', 'codex', 'kimi'] as const) {
      expect(result.quota[agent].kind).toBe('unknown')
    }
  })

  it('不传闸门时行为一个字节不变——闸门是采集器那一层的长期状态,纯取数这层仍然无状态', async () => {
    const fetchImpl = fetchStub({ status: 200, body: SCOPED_BODY })
    await collectQuota({ ...options({ status: 200, body: SCOPED_BODY }), fetch: fetchImpl })
    await collectQuota({ ...options({ status: 200, body: SCOPED_BODY }), fetch: fetchImpl })
    const usageHits = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(call => String(call[0]).includes('/api/oauth/usage')).length
    expect(usageHits).toBe(2)
  })

  it('★keychain 里的 token 已过期:不发请求,直接告诉 Ben 要重新登录(2026-08-26 Fable 栏消失的真因)', async () => {
    // 真机时序:token 08-25 18:58 过期 → 此后每次请求都是 401 → 那栏消失且毫无痕迹;
    // 而采集器每 60 秒拿这个死 token 再撞一次,最终把自己撞进限流(429 反过来把 401 盖住了)。
    // 本地就能看出它死了,不必去撞——省掉的正是招来限流的那些请求。
    const fetchImpl = fetchStub({ status: 200, body: SCOPED_BODY })
    const gate = createClaudeScopedGate({ minIntervalMs: 0, now: () => 1_800_000_000_000 })
    const result = await collectQuota({
      ...options({ status: 200, body: SCOPED_BODY }),
      fetch: fetchImpl,
      claudeScopedGate: gate,
      claudeScopedIo: {
        // expiresAt 早于 now
        readKeychain: async () => '{"claudeAiOauth":{"accessToken":"tok-dead","expiresAt":1787655517108}}',
        readVersions: async () => ['2.1.241'],
      },
    })
    const claude = result.quota.claude as WindowQuota

    expect(claude.windows.map(w => w.label)).toEqual(['5h', '周']) // 统一窗口不受连累
    expect(claude.alert).toContain('claude auth login') // 说人话,而且是可执行的那句
    const hit = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .some(call => String(call[0]).includes('/api/oauth/usage'))
    expect(hit).toBe(false) // 一次都不去撞
  })

  it('token 还没过期就照常去打,不因为有 expiresAt 就疑神疑鬼', async () => {
    const fetchImpl = fetchStub({ status: 200, body: SCOPED_BODY })
    const result = await collectQuota({
      ...options({ status: 200, body: SCOPED_BODY }),
      fetch: fetchImpl,
      claudeScopedGate: createClaudeScopedGate({ minIntervalMs: 0, now: () => 1_787_000_000_000 }),
      claudeScopedIo: {
        readKeychain: async () => '{"claudeAiOauth":{"accessToken":"tok-live","expiresAt":1787655517108}}',
        readVersions: async () => ['2.1.241'],
      },
    })

    expect((result.quota.claude as WindowQuota).windows.map(w => w.label)).toEqual(['5h', '周', 'Fable'])
  })

  it('keychain 里是空串（没跑过 claude auth login）就干脆不发请求，也不报错吓人', async () => {
    const fetchImpl = fetchStub({ status: 200, body: SCOPED_BODY })
    const result = await collectQuota({
      ...options({ status: 200, body: SCOPED_BODY }),
      fetch: fetchImpl,
      claudeScopedIo: {
        readKeychain: async () => '{"claudeAiOauth":{"accessToken":""}}',
        readVersions: async () => ['2.1.237'],
      },
    })
    const claude = result.quota.claude as WindowQuota

    expect(claude.windows.map(w => w.label)).toEqual(['5h', '周'])
    expect(claude.alert ?? '').not.toContain('claude auth login')
    const hit = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .some(call => String(call[0]).includes('/api/oauth/usage'))
    expect(hit).toBe(false)
  })
})
