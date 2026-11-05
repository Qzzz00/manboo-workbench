import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_BUNDLE_ID,
  ANTIGRAVITY_QUOTA_PATH,
  antigravityPorts,
  antigravityProcess,
  parseAntigravityQuota,
  readAntigravityNative,
} from '../src/quota/antigravityNative.ts'
import { antigravityNativeView } from '../src/server/agentQuota.ts'

/**
 * ★ 这一份夹具是 **2026-09-27 在本机实测**回来的那一次响应的**形状**
 * (`RetrieveUserQuotaSummary`),字段名、嵌套、驼峰写法一字没改;数值按实测那一刻。
 *
 * **令牌一个字都不在这里**(纪律见 `src/quota/antigravityNative.ts` 文件头):
 * 下面 `ps` 那几条夹具里的令牌是编的占位符,不是他机器上那一个。
 */
function body(): unknown {
  return {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-03T07:35:07Z' },
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.98, resetTime: '2026-09-27T07:05:04Z' },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-04T02:05:04Z' },
            { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-09-27T07:05:04Z' },
          ],
        },
      ],
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
    },
  }
}

const PS = [
  '  701 /usr/libexec/UserEventAgent (Aqua)',
  ' 41719 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --override_ide_name antigravity --subclient_type hub --https_server_port 0 --csrf_token=FAKE-TOKEN-NOT-REAL-0000 --app_data_dir antigravity',
].join('\n')

const LSOF = [
  'COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
  'language_ 41719   ben    7u     IPv4 0xf6bc9950993b0ffc      0t0  TCP 127.0.0.1:59582 (LISTEN)',
  'language_ 41719   ben    8u     IPv4 0xac11fa823bc8f701      0t0  TCP 127.0.0.1:59583 (LISTEN)',
  'language_ 41719   ben   12u     IPv4 0xac11fa823bc8f702      0t0  TCP 127.0.0.1:59583->127.0.0.1:60001 (ESTABLISHED)',
].join('\n')

describe('antigravityProcess —— 从它自己进程的命令行参数里现取', () => {
  it('取到 pid 与令牌(令牌只进变量,这里只断言它被取到了)', () => {
    const found = antigravityProcess(PS)
    expect(found?.pid).toBe(41719)
    expect(found?.token).toBe('FAKE-TOKEN-NOT-REAL-0000')
  })

  it('它没在跑 —— 回 undefined,不抛、不编', () => {
    expect(antigravityProcess('  701 /usr/libexec/UserEventAgent (Aqua)')).toBeUndefined()
  })

  it('进程在、参数里没有那个令牌(它换了版本)—— 回 undefined,不拿别的参数凑数', () => {
    const line = ' 41719 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --https_server_port 0'
    expect(antigravityProcess(line)).toBeUndefined()
  })

  it('--csrf_token 用空格分隔也认得', () => {
    const line = ' 900 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token FAKE-2 --standalone'
    expect(antigravityProcess(line)?.token).toBe('FAKE-2')
  })
})

describe('antigravityPorts —— 端口每次重启都变,只能现查', () => {
  it('只认 127.0.0.1 上 LISTEN 的那几个,连出去的那条不算', () => {
    expect(antigravityPorts(LSOF)).toEqual([59582, 59583])
  })

  it('一个都没监听 —— 空数组', () => {
    expect(antigravityPorts('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME')).toEqual([])
  })
})

describe('parseAntigravityQuota —— 照实测形状解析', () => {
  it('四行两组,组名、行名、剩余、重置时刻全照它原样', () => {
    expect(parseAntigravityQuota(body())).toEqual([
      {
        name: 'Gemini Models',
        buckets: [
          { id: 'gemini-weekly', label: 'Weekly Limit Remaining', window: 'weekly', leftPct: 100, resetAt: '2026-10-03T07:35:07Z' },
          { id: 'gemini-5h', label: 'Five Hour Limit Remaining', window: '5h', leftPct: 98, resetAt: '2026-09-27T07:05:04Z' },
        ],
      },
      {
        name: 'Claude and GPT models',
        buckets: [
          { id: '3p-weekly', label: 'Weekly Limit Remaining', window: 'weekly', leftPct: 100, resetAt: '2026-10-04T02:05:04Z' },
          { id: '3p-5h', label: 'Five Hour Limit Remaining', window: '5h', leftPct: 100, resetAt: '2026-09-27T07:05:04Z' },
        ],
      },
    ])
  })

  it('没有 response 那层包装(Connect 有时直接给)也认', () => {
    const raw = (body() as { response: unknown }).response
    expect(parseAntigravityQuota(raw)[0]?.name).toBe('Gemini Models')
  })

  it('remainingFraction 缺席 = 0(proto3 JSON 不发默认值)—— 只要 bucketId / displayName 还在,形状就没变', () => {
    const raw = { response: { groups: [{ displayName: 'G', buckets: [{ bucketId: 'a', displayName: 'A' }] }] } }
    expect(parseAntigravityQuota(raw)[0]?.buckets[0]?.leftPct).toBe(0)
  })

  it('disabled 的那一条照它原样带出来', () => {
    const raw = { response: { groups: [{ displayName: 'G', buckets: [{ bucketId: 'a', displayName: 'A', remainingFraction: 0.5, disabled: true }] }] } }
    expect(parseAntigravityQuota(raw)[0]?.buckets[0]?.disabled).toBe(true)
  })

  it('顶层 buckets 那一格(已标 deprecated)一个字都不读', () => {
    const raw = { response: { buckets: [{ bucketId: 'old', displayName: '老的', remainingFraction: 0.1 }] } }
    expect(() => parseAntigravityQuota(raw)).toThrow(/形状/)
  })

  it('字段名变了 —— 抛错,只写顶层字段名、不编一个数(D13)', () => {
    const raw = { response: { groups: [{ name: 'G', limits: [] }] } }
    expect(() => parseAntigravityQuota(raw)).toThrow(/形状/)
  })

  it('抛出来的话里带着它实际给了哪些字段,好查是不是接口改了', () => {
    expect(() => parseAntigravityQuota({ response: { quotas: [] } })).toThrow(/quotas/)
  })
})

describe('antigravityNativeView —— 翻成那一格', () => {
  const groups = parseAntigravityQuota(body())
  const view = antigravityNativeView({ id: 'antigravity', title: 'Antigravity', at: '2026-09-27T03:30:00.000Z', groups })

  it('四条横条两组,照它页面怎么列就怎么列', () => {
    expect(view.windows).toEqual([
      { label: 'Weekly Limit Remaining', left_pct: 100, reset_at: '2026-10-03T07:35:07Z', group: 'Gemini Models' },
      { label: 'Five Hour Limit Remaining', left_pct: 98, reset_at: '2026-09-27T07:05:04Z', group: 'Gemini Models' },
      { label: 'Weekly Limit Remaining', left_pct: 100, reset_at: '2026-10-04T02:05:04Z', group: 'Claude and GPT models' },
      { label: 'Five Hour Limit Remaining', left_pct: 100, reset_at: '2026-09-27T07:05:04Z', group: 'Claude and GPT models' },
    ])
  })

  it('那一句只说最紧的那一行(同窗口读法、同豆包办公)', () => {
    expect(view.state).toBe('numbers')
    expect(view.line).toBe('还剩约 98%')
    expect(view.left_pct).toBe(98)
    expect(view.level).toBe('ok')
  })

  it('「说明」里说清走的是**哪一条路**,四条原话一条不落、组名行名各自带引号', () => {
    expect(view.source).toContain('直接问 Antigravity 在本机的语言服务')
    expect(view.source).toContain('「Gemini Models」「Weekly Limit Remaining」「100%」')
    expect(view.source).toContain('「Gemini Models」「Five Hour Limit Remaining」「98%」')
    expect(view.source).toContain('「Claude and GPT models」「Five Hour Limit Remaining」「100%」')
  })

  it('reset_at 跟着最紧的那一行走', () => {
    expect(view.reset_at).toBe('2026-09-27T07:05:04Z')
  })

  it('出处、那一句、任何一格里都不许出现令牌那几个字', () => {
    const all = JSON.stringify(view)
    expect(all).not.toContain('csrf')
    expect(all).not.toContain('token')
  })

  it('见底那一行把整格判成用完了', () => {
    const empty = antigravityNativeView({
      id: 'antigravity', title: 'Antigravity', at: '2026-09-27T03:30:00.000Z',
      groups: [{ name: 'Gemini Models', buckets: [{ id: 'a', label: 'Weekly Limit Remaining', leftPct: 0 }] }],
    })
    expect(empty.level).toBe('empty')
    expect(empty.line).toBe('用量用完了')
  })

  it('只有一条时不画表(照老四格那副骨架只画一条横条)', () => {
    const one = antigravityNativeView({
      id: 'antigravity', title: 'Antigravity', at: '2026-09-27T03:30:00.000Z',
      groups: [{ name: 'Gemini Models', buckets: [{ id: 'a', label: 'Weekly Limit Remaining', leftPct: 42 }] }],
    })
    expect(one.windows).toBeUndefined()
    expect(one.left_pct).toBe(42)
  })

  it('一条都没有 —— 抛错走「这会儿读不到」,不画一个空表', () => {
    expect(() => antigravityNativeView({ id: 'antigravity', title: 'Antigravity', at: '2026-09-27T03:30:00.000Z', groups: [] }))
      .toThrow(/一条用量都没给/)
  })
})

describe('readAntigravityNative —— 端口现查、HTTP 优先、HTTPS 兜底', () => {
  const ok = { status: 200, text: JSON.stringify(body()) }

  function deps(over: Record<string, unknown> = {}): Parameters<typeof readAntigravityNative>[0] {
    return {
      ps: async () => PS,
      lsof: async () => LSOF,
      post: async () => ok,
      ...over,
    } as Parameters<typeof readAntigravityNative>[0]
  }

  it('打它自己在本机的那个口,路径与请求头照实测', async () => {
    const seen: { url: string, headers: Record<string, string>, body: string }[] = []
    const groups = await readAntigravityNative(deps({
      post: async (url: string, headers: Record<string, string>, payload: string) => { seen.push({ url, headers, body: payload }); return ok },
    }))
    expect(groups[0]?.name).toBe('Gemini Models')
    expect(seen[0]?.url).toBe(`http://127.0.0.1:59582${ANTIGRAVITY_QUOTA_PATH}`)
    expect(seen[0]?.headers['x-codeium-csrf-token']).toBe('FAKE-TOKEN-NOT-REAL-0000')
    expect(seen[0]?.headers['content-type']).toBe('application/json')
    // `forceRefresh` 要回源,不然拿的是它自己内存里的缓存(实测:不给的时候 5h 那条的重置时刻是旧的)。
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ forceRefresh: true })
  })

  it('那个口其实是 HTTPS(实测它回「Client sent an HTTP request to an HTTPS server」)—— 自己换成 https 再试', async () => {
    const urls: string[] = []
    await readAntigravityNative(deps({
      post: async (url: string) => {
        urls.push(url)
        if (url.startsWith('http://127.0.0.1:59582')) return { status: 400, text: 'Client sent an HTTP request to an HTTPS server.' }
        return ok
      },
    }))
    expect(urls).toEqual([
      `http://127.0.0.1:59582${ANTIGRAVITY_QUOTA_PATH}`,
      `https://127.0.0.1:59582${ANTIGRAVITY_QUOTA_PATH}`,
    ])
  })

  it('第一个口不通就试第二个(两个口哪个是 HTTP 每次都不一定)', async () => {
    const urls: string[] = []
    const groups = await readAntigravityNative(deps({
      post: async (url: string) => {
        urls.push(url)
        if (url.includes('59582')) throw new Error('ECONNREFUSED')
        return url.startsWith('http://') ? ok : { status: 500, text: '' }
      },
    }))
    expect(groups).toHaveLength(2)
    expect(urls[urls.length - 1]).toBe(`http://127.0.0.1:59583${ANTIGRAVITY_QUOTA_PATH}`)
  })

  it('它没在跑 —— 说人话,不说「接口挂了」', async () => {
    await expect(readAntigravityNative(deps({ ps: async () => '' }))).rejects.toThrow(/没在跑/)
  })

  it('一个口都没监听 —— 说清是这一步', async () => {
    await expect(readAntigravityNative(deps({ lsof: async () => '' }))).rejects.toThrow(/没在本机监听/)
  })

  it('401 要分清「令牌不对」与「真的没登录」,不许悄悄降级成「没数」', async () => {
    await expect(readAntigravityNative(deps({ post: async () => ({ status: 401, text: 'csrf token mismatch' }) })))
      .rejects.toThrow(/令牌/)
  })

  it('401 但它自己说没登录 —— 照它说的报', async () => {
    await expect(readAntigravityNative(deps({ post: async () => ({ status: 401, text: '{"code":"unauthenticated","message":"not logged in"}' }) })))
      .rejects.toThrow(/没登录/)
  })

  it('抛出来的每一句话里都不许带令牌', async () => {
    const boom = await readAntigravityNative(deps({ post: async () => ({ status: 500, text: 'oops FAKE-TOKEN-NOT-REAL-0000 oops' }) }))
      .then(() => undefined, (error: Error) => error.message)
    expect(boom).toBeDefined()
    expect(boom).not.toContain('FAKE-TOKEN-NOT-REAL-0000')
  })

  it('包标识就是窗口读法那一家的(兜底走的是同一家)', () => {
    expect(ANTIGRAVITY_BUNDLE_ID).toBe('com.google.antigravity')
  })
})
