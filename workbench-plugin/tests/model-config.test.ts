// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILD_RELAY_URL } from '../src/buildEndpoints.ts'
import {
  autoRelayDecision,
  DEFAULT_RELAY_URL, deviceTokenBindingOf, fetchRelayUsage, loadModelConfig, modelEndpointOf, modelStatusOf,
  NO_RELAY_NOTE, OWN_DEFAULT_BASE_URL, OWN_DEFAULT_MODEL, parseModelConfig, parseModelPatch, registerRelayDevice, relayConfigured, saveModelConfig,
} from '../src/server/modelConfig.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempFile(name = 'model.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-model-'))
  dirs.push(dir)
  return join(dir, name)
}

describe('model.json 的读写', () => {
  it('中转地址缺省是构建带的那一个;用例里跑的是开源缺省(空)', () => {
    expect(DEFAULT_RELAY_URL).toBe(BUILD_RELAY_URL)
    expect(DEFAULT_RELAY_URL).toBe('')
  })

  it('什么都没有、构建也没带中转 = 「这台没接中转」:用自己的 Key(还没填)', () => {
    const config = parseModelConfig(undefined, () => 'dev-1')
    expect(config.mode).toBe('own')
    expect(config.relay_url).toBe('')
    expect(relayConfigured(config)).toBe(false)
    expect(config.relay_token).toBeUndefined()
    expect(config.device_id).toBe('dev-1')
  })

  it('文件里写了中转地址就是「用工作台提供的服务、还没领凭证」(我们的构建、自建中转)', () => {
    const config = parseModelConfig('{"relay_url":"https://relay.test"}', () => 'dev-1')
    expect(config.mode).toBe('relay')
    expect(relayConfigured(config)).toBe(true)
  })

  it('没有中转地址时写着 relay 也按 own 算 —— 那条路走不通,不装作能走', () => {
    expect(parseModelConfig('{"mode":"relay"}', () => 'd').mode).toBe('own')
  })

  it('坏 JSON 不抛,退回默认(界面显示的正是此刻的真相)', () => {
    expect(parseModelConfig('{这不是 JSON', () => 'dev-1').mode).toBe('own')
  })

  it('认得出 own,别的 mode 一律当 relay(有中转时)', () => {
    expect(parseModelConfig('{"mode":"own","relay_url":"https://x.test"}', () => 'd').mode).toBe('own')
    expect(parseModelConfig('{"mode":"火星","relay_url":"https://x.test"}', () => 'd').mode).toBe('relay')
  })

  it('设备 id 一旦有了就不变', async () => {
    const file = tempFile()
    await saveModelConfig(file, parseModelConfig(undefined, () => 'dev-1'))
    const again = await loadModelConfig(file, () => 'dev-2')
    expect(again.device_id).toBe('dev-1')
  })

  it('落盘是 0600 —— 里头有令牌', async () => {
    const file = tempFile()
    await saveModelConfig(file, { mode: 'relay', relay_url: 'https://x.test', relay_token: 'wb_x', device_id: 'd' })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    // 已存在的文件也要收到 0600(writeFile 的 mode 只在新建时生效)。
    await writeFile(file, '{}', { mode: 0o644 })
    await saveModelConfig(file, { mode: 'relay', relay_url: 'https://x.test', device_id: 'd' })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('末尾斜杠去掉 —— 后面一律 `${base}/v1` 拼', () => {
    expect(parseModelConfig('{"relay_url":"https://x.test/"}', () => 'd').relay_url).toBe('https://x.test')
  })
})

/**
 * 「自己的 OpenAI 协议端点」(2026-10-23,卡「事务官换Key」):own 这一档从「写死 DeepSeek 官方」
 * 变成「地址、模型名可填」。三处消费方(通话工人 / DSH 事务官 / 插件自己)读的都是这一份解析,
 * 对照用例在 channel-worker/tests/model-choice.test.ts 用同一份 JSON 原文钉同样的结果。
 */
describe('own:自己的 OpenAI 协议端点(2026-10-23)', () => {
  // 对照用例的共用原文 —— channel-worker/tests/model-choice.test.ts 里有一份逐字相同的。
  const OWN_FILLED = '{"mode":"own","relay_url":"https://relay.test","own":{"base_url":"https://ark.cn-beijing.volces.com/api/plan/v3/","model":"deepseek-v4-flash"},"device_id":"d"}'

  it('缺省 = DeepSeek 官方(/v1 写法) + 现在用的模型名(老配置一字不改照旧)', () => {
    const config = parseModelConfig('{"mode":"own","relay_url":"https://x.test"}', () => 'd')
    expect(config.own_base_url).toBe(OWN_DEFAULT_BASE_URL)
    expect(config.own_model).toBe(OWN_DEFAULT_MODEL)
    const fallback = parseModelConfig(undefined, () => 'd')
    expect(fallback.own_base_url).toBe(OWN_DEFAULT_BASE_URL)
    expect(fallback.own_model).toBe(OWN_DEFAULT_MODEL)
  })

  it('填齐:地址去末尾斜杠,模型名照填', () => {
    const config = parseModelConfig(OWN_FILLED, () => 'd')
    expect(config.own_base_url).toBe('https://ark.cn-beijing.volces.com/api/plan/v3')
    expect(config.own_model).toBe('deepseek-v4-flash')
  })

  it('own 不是对象 / 字段不是字符串:当没填,不猜', () => {
    expect(parseModelConfig('{"mode":"own","own":"https://x.test"}', () => 'd').own_base_url).toBe(OWN_DEFAULT_BASE_URL)
    expect(parseModelConfig('{"mode":"own","own":{"base_url":42,"model":true}}', () => 'd').own_model).toBe(OWN_DEFAULT_MODEL)
  })

  it('坏文件:own 退回缺省,不抛', () => {
    const config = parseModelConfig('{坏', () => 'd')
    expect(config.own_base_url).toBe(OWN_DEFAULT_BASE_URL)
    expect(config.own_model).toBe(OWN_DEFAULT_MODEL)
  })

  /**
   * ★ 地址**原样**通过(2026-10-23 复核):不自动补 `/v1`,也不拼成 `/v1/v1`。
   * 三家 SDK 都拿 baseURL 直接拼 `/chat/completions`(OpenAI 官方 SDK / DSH pi-ai / 工人那一路),
   * 用户照他那一家的文档填什么就是什么。channel-worker/tests/model-choice.test.ts 钉同一组。
   */
  it.each([
    ['官方根地址(DeepSeek 认这个写法)', 'https://api.deepseek.com', 'https://api.deepseek.com'],
    ['官方 SDK 写法(带 /v1,缺省那个)', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1'],
    ['已带 /v1 的兼容口(不会被拼成 /v1/v1)', 'https://api.moonshot.cn/v1/', 'https://api.moonshot.cn/v1'],
    ['火山方舟 Agent Plan(真实路径,没有 /v1)', 'https://ark.cn-beijing.volces.com/api/plan/v3', 'https://ark.cn-beijing.volces.com/api/plan/v3'],
  ])('地址原样使用(%s)', (_name, filled, expected) => {
    const config = parseModelConfig(
      `{"mode":"own","relay_url":"https://relay.test","own":{"base_url":"${filled}","model":"m-1"},"device_id":"d"}`,
      () => 'd',
    )
    expect(modelEndpointOf(config, 'sk-own')).toMatchObject({ mode: 'own', baseUrl: expected, model: 'm-1', ready: true })
  })

  it('endpoint:own 拼出 baseUrl + model;relay 一字不动(没有 model 字段)', () => {
    const own = modelEndpointOf(parseModelConfig(OWN_FILLED, () => 'd'), 'sk-own')
    expect(own).toEqual({
      mode: 'own',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      key: 'sk-own',
      model: 'deepseek-v4-flash',
      ready: true,
    })
    const relay = modelEndpointOf(
      { mode: 'relay', relay_url: 'https://api.aibooo.cn', relay_token: 'wb_x', device_id: 'd' },
      'sk-own',
    )
    expect(relay).toEqual({ mode: 'relay', baseUrl: 'https://api.aibooo.cn/v1', key: 'wb_x', ready: true })
  })

  it('给浏览器看的状态带上地址与模型名(都不是秘密),永远没有 key', () => {
    const view = modelStatusOf(parseModelConfig(OWN_FILLED, () => 'd'), true)
    expect(view.own_base_url).toBe('https://ark.cn-beijing.volces.com/api/plan/v3')
    expect(view.own_model).toBe('deepseek-v4-flash')
    expect(JSON.stringify(view)).not.toContain('sk-own')
  })

  /**
   * ★ 唯一源对照(2026-10-23 退修,Codex):不再手抄配置互指,**从盘上读**
   * `tests/fixtures/own-endpoint-cases.json` —— 三处消费方(这里 / channel-worker / DSH 设置)
   * 都读这同一份源,各自用**真实的解析函数**跑出同样的 base_url / model。
   * 地址**原样**通过(不自动补 `/v1`,依据:OpenAI 官方 SDK / DSH pi-ai / 插件自己都是
   * 拿 baseURL 直接拼 `/chat/completions`)。
   */
  it('读唯一源夹具:每个 case 的 base_url / model / key 与 expect 一致', () => {
    const cases = (JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/own-endpoint-cases.json'), 'utf8')) as {
      cases: { name: string, model_json: string, credentials_json: string,
        expect: { base_url: string, model: string, key_plugin: string } }[]
    }).cases
    expect(cases.length).toBeGreaterThanOrEqual(5)
    for (const one of cases) {
      const config = parseModelConfig(one.model_json, () => 'd')
      const key = (JSON.parse(one.credentials_json) as { keys: { deepseek?: string } }).keys.deepseek
      // 插件这一家:Key 只从 credentials.json 来(modelService.ownKeyOf),不读环境变量。
      expect(modelEndpointOf(config, key), one.name)
        .toMatchObject({ mode: 'own', baseUrl: one.expect.base_url, model: one.expect.model, key: one.expect.key_plugin, ready: true })
    }
  })

  it('落盘:own 的地址与模型名写进文件,key 永远不在这个文件里', async () => {
    const file = tempFile()
    await saveModelConfig(file, parseModelConfig(OWN_FILLED, () => 'd'))
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(onDisk.own).toEqual({ base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: 'deepseek-v4-flash' })
    expect(JSON.stringify(onDisk)).not.toContain('sk-')
  })
})

describe('此刻该往哪发', () => {
  it('relay:地址是中转 + /v1,key 是中转令牌', () => {
    const endpoint = modelEndpointOf(
      { mode: 'relay', relay_url: 'https://api.aibooo.cn', relay_token: 'wb_x', device_id: 'd' },
      'sk-own',
    )
    expect(endpoint).toEqual({ mode: 'relay', baseUrl: 'https://api.aibooo.cn/v1', key: 'wb_x', ready: true })
  })

  it('relay 但还没领到令牌:ready=false,而不是退回官方偷偷用他的 Key', () => {
    const endpoint = modelEndpointOf({ mode: 'relay', relay_url: 'https://x.test', device_id: 'd' }, 'sk-own')
    expect(endpoint.ready).toBe(false)
    expect(endpoint.key).toBeUndefined()
    expect(endpoint.baseUrl).toBe('https://x.test/v1')
  })

  it('own:直连官方,key 是他自己那个;模型名是缺省那个(老配置照旧)', () => {
    const endpoint = modelEndpointOf({ mode: 'own', relay_url: 'https://x.test', relay_token: 'wb_x', device_id: 'd' }, 'sk-own')
    expect(endpoint).toEqual({
      mode: 'own', baseUrl: OWN_DEFAULT_BASE_URL, key: 'sk-own', model: OWN_DEFAULT_MODEL, ready: true,
    })
  })

  it('own 但没填 Key:ready=false', () => {
    expect(modelEndpointOf({ mode: 'own', relay_url: 'https://x.test', device_id: 'd' }).ready).toBe(false)
  })
})

describe('给浏览器看的状态', () => {
  it('永远不含令牌,只有布尔', () => {
    const view = modelStatusOf({ mode: 'relay', relay_url: 'https://x.test', relay_token: 'wb_secret', device_id: 'd' }, false)
    expect(JSON.stringify(view)).not.toContain('wb_secret')
    expect(view.relay_token_configured).toBe(true)
    expect(view.ready).toBe(true)
  })

  it('用量取不到时整块缺席,而不是填 0(0 和「不知道」是两回事)', () => {
    const view = modelStatusOf({ mode: 'relay', relay_url: 'x', relay_token: 't', device_id: 'd' }, false, undefined, '连不上')
    expect(view.usage).toBeUndefined()
    expect(view.usage_error).toBe('连不上')
  })
})

describe('PUT /model 的请求体', () => {
  it('只认 relay / own', () => {
    expect(parseModelPatch({ mode: 'relay' })).toEqual({ ok: true, mode: 'relay' })
    expect(parseModelPatch({ mode: 'own' })).toEqual({ ok: true, mode: 'own' })
    expect(parseModelPatch({ mode: '别的' }).ok).toBe(false)
    expect(parseModelPatch(undefined).ok).toBe(false)
  })

  it('地址要带协议', () => {
    expect(parseModelPatch({ mode: 'relay', relay_url: 'api.aibooo.cn' }).ok).toBe(false)
    expect(parseModelPatch({ mode: 'relay', relay_url: 'https://api.aibooo.cn/' }))
      .toEqual({ ok: true, mode: 'relay', relay_url: 'https://api.aibooo.cn' })
  })

  it('own 的地址与模型名:可填、要过校验(2026-10-23,卡「事务官换Key」)', () => {
    expect(parseModelPatch({ mode: 'own', own_base_url: 'https://ark.test/v3/', own_model: 'deepseek-v4-flash' }))
      .toEqual({ ok: true, mode: 'own', own_base_url: 'https://ark.test/v3', own_model: 'deepseek-v4-flash' })
    // 地址要带协议。
    expect(parseModelPatch({ mode: 'own', own_base_url: 'ark.test' }).ok).toBe(false)
    // 模型名不能带空白;空白的就当没填(保留原来的)。
    expect(parseModelPatch({ mode: 'own', own_model: '  ' })).toEqual({ ok: true, mode: 'own' })
    expect(parseModelPatch({ mode: 'own', own_model: 'a b' }).ok).toBe(false)
    // 不填就缺席(保留原来的)。
    expect(parseModelPatch({ mode: 'own' })).toEqual({ ok: true, mode: 'own' })
  })
})

describe('没接中转', () => {
  it('领令牌:一个包都不发,说「这台没接中转」', async () => {
    let called = 0
    const result = await registerRelayDevice({
      relayUrl: '', account: 'a', deviceId: 'd', fetchImpl: async () => { called += 1; return new Response('{}') },
    })
    expect(called).toBe(0)
    expect(result).toEqual({ ok: false, error: NO_RELAY_NOTE, no_relay: true })
  })

  it('问用量:一个包都不发', async () => {
    let called = 0
    const result = await fetchRelayUsage({ relayUrl: '', token: 't', fetchImpl: async () => { called += 1; return new Response('{}') } })
    expect(called).toBe(0)
    expect(result).toEqual({ ok: false, error: NO_RELAY_NOTE })
  })

  it('不自动去接、不去挂账号', () => {
    const none = { mode: 'own' as const, relay_url: '', device_id: 'd' }
    expect(autoRelayDecision({ ...none, mode: 'relay' }, false)).toEqual({ auto: false, reason: 'no_relay' })
    expect(deviceTokenBindingOf(none, 'acct:1')).toEqual({ rebind: false, reason: 'no_relay' })
  })

  it('给浏览器看的状态带上「接没接中转」', () => {
    expect(modelStatusOf({ mode: 'own', relay_url: '', device_id: 'd' }, false).relay_configured).toBe(false)
    expect(modelStatusOf({ mode: 'relay', relay_url: 'https://x.test', device_id: 'd' }, false).relay_configured).toBe(true)
  })
})

describe('向中转领令牌', () => {
  it('领到了就把明文带回来', async () => {
    const result = await registerRelayDevice({
      relayUrl: 'https://x.test/',
      account: 'ben',
      deviceId: 'dev-1',
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe('https://x.test/register-device')
        expect(JSON.parse(String(init?.body))).toEqual({ account: 'ben', device_id: 'dev-1' })
        return new Response(JSON.stringify({ token: 'wb_new' }), { status: 201 })
      },
    })
    expect(result).toEqual({ ok: true, token: 'wb_new' })
  })

  it('连不上:一句人话,不把底层错误抖出来', async () => {
    const result = await registerRelayDevice({
      relayUrl: 'https://x.test', account: 'a', deviceId: 'd',
      fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND x.test') },
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).not.toContain('ENOTFOUND')
  })

  it('中转拒绝:照读它那句人话', async () => {
    const result = await registerRelayDevice({
      relayUrl: 'https://x.test', account: 'a', deviceId: 'd',
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: '领取太频繁了,过一会儿再试。' } }), { status: 429 }),
    })
    expect(result).toEqual({ ok: false, error: '领取太频繁了,过一会儿再试。' })
  })

  it('回包里没有 token:不当成成功', async () => {
    const result = await registerRelayDevice({
      relayUrl: 'https://x.test', account: 'a', deviceId: 'd',
      fetchImpl: async () => new Response('{}', { status: 201 }),
    })
    expect(result.ok).toBe(false)
  })
})

describe('问中转今天用了多少', () => {
  it('带令牌去问,数字读回来', async () => {
    const result = await fetchRelayUsage({
      relayUrl: 'https://x.test', token: 'wb_x',
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe('https://x.test/v1/usage')
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer wb_x')
        return new Response(JSON.stringify({
          day: '2026-09-17', used_tokens: 1200, daily_token_limit: 50_000, remaining_tokens: 48_800,
        }), { status: 200 })
      },
    })
    expect(result).toEqual({
      ok: true,
      usage: { day: '2026-09-17', used_tokens: 1200, daily_token_limit: 50_000, remaining_tokens: 48_800 },
    })
  })

  it('★ 新中转回的元那三格一起读回来(2026-09-23)', async () => {
    const result = await fetchRelayUsage({
      relayUrl: 'https://x.test', token: 'wb_x',
      fetchImpl: async () => new Response(JSON.stringify({
        day: '2026-09-23', used_tokens: 526_000, daily_token_limit: 500_000, remaining_tokens: 0,
        used_cny: 0.3856, daily_cost_limit_cny: 5, remaining_cny: 4.6144,
      }), { status: 200 }),
    })
    expect(result).toEqual({
      ok: true,
      usage: {
        day: '2026-09-23', used_tokens: 526_000, daily_token_limit: 500_000, remaining_tokens: 0,
        used_cny: 0.3856, daily_cost_limit_cny: 5, remaining_cny: 4.6144,
      },
    })
  })

  it('401 说的是「重新领取」,不是「HTTP 401」', async () => {
    const result = await fetchRelayUsage({
      relayUrl: 'https://x.test', token: 'wb_x',
      fetchImpl: async () => new Response('{}', { status: 401 }),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('重新领取')
  })

  it('连不上不抛', async () => {
    const result = await fetchRelayUsage({
      relayUrl: 'https://x.test', token: 'wb_x',
      fetchImpl: async () => { throw new Error('boom') },
    })
    expect(result.ok).toBe(false)
  })
})

describe('落盘的内容', () => {
  it('写进去的就是读出来的(own 收成对象那一格)', async () => {
    const file = tempFile()
    await saveModelConfig(file, {
      mode: 'own', relay_url: 'https://x.test', relay_token: 'wb_x', account: 'ben',
      device_id: 'd', dsh_prev_provider: 'deepseek-official',
    })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      mode: 'own', relay_url: 'https://x.test', relay_token: 'wb_x', account: 'ben',
      device_id: 'd', dsh_prev_provider: 'deepseek-official',
      own: { base_url: OWN_DEFAULT_BASE_URL, model: OWN_DEFAULT_MODEL },
    })
  })
})

/**
 * 用量走哪条路(2026-09-18)。Ben 真机上这条一直回 404 —— 挡住的是 Caddy 的白名单
 * (只放行 /v1/*、/register-device、/health、/updates/*),不是中转。
 */
describe('用量接口的路径', () => {
  it('先问 /v1/usage', async () => {
    const seen: string[] = []
    const result = await fetchRelayUsage({
      relayUrl: 'https://x.test', token: 'wb_x',
      fetchImpl: async (url) => {
        seen.push(String(url))
        return new Response(JSON.stringify({ day: '2026-09-18', used_tokens: 1, daily_token_limit: 2, remaining_tokens: 1 }), { status: 200 })
      },
    })
    expect(seen).toEqual(['https://x.test/v1/usage'])
    expect(result.ok).toBe(true)
  })

  it('老中转上 /v1/usage 是 404 → 退回老路径 /usage,数字照样读得到', async () => {
    const seen: string[] = []
    const result = await fetchRelayUsage({
      relayUrl: 'https://x.test', token: 'wb_x',
      fetchImpl: async (url) => {
        seen.push(String(url))
        if (String(url).endsWith('/v1/usage')) return new Response('not found', { status: 404 })
        return new Response(JSON.stringify({
          day: '2026-09-18', used_tokens: 7, daily_token_limit: 100, remaining_tokens: 93,
        }), { status: 200 })
      },
    })
    expect(seen).toEqual(['https://x.test/v1/usage', 'https://x.test/usage'])
    expect(result).toEqual({
      ok: true,
      usage: { day: '2026-09-18', used_tokens: 7, daily_token_limit: 100, remaining_tokens: 93 },
    })
  })

  it('两条都 404:说的是「中转还是旧的,要重新部署」,不是一个让人去猜的 HTTP 404', async () => {
    const result = await fetchRelayUsage({
      relayUrl: 'https://x.test', token: 'wb_x',
      fetchImpl: async () => new Response('not found', { status: 404 }),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('重新部署')
    expect(result.ok === false && result.error).not.toContain('HTTP 404')
  })

  it('401 不退第二条路:那是中转自己说的话,退一步只会把它盖掉', async () => {
    const seen: string[] = []
    const result = await fetchRelayUsage({
      relayUrl: 'https://x.test', token: 'wb_x',
      fetchImpl: async (url) => { seen.push(String(url)); return new Response('{}', { status: 401 }) },
    })
    expect(seen).toEqual(['https://x.test/v1/usage'])
    expect(result.ok === false && result.error).toContain('重新领取')
  })
})

/**
 * 「注册那一刻要不要替他去领令牌」的三条判据(2026-09-18)。
 * 纯函数,所以这几条不需要网络、不需要文件系统 —— 而它们恰恰是最不能出错的那几条。
 */
describe('要不要自动接工作台提供的模型服务', () => {
  const base = { mode: 'relay' as const, relay_url: 'https://x.test', device_id: 'd1' }

  it('新用户:没选过、没令牌、也没自己的 Key → 自动', () => {
    expect(autoRelayDecision(base, false)).toEqual({ auto: true })
  })

  it('他自己填了 DeepSeek Key → 不动(任务卡:已有自己 Key 时不动)', () => {
    expect(autoRelayDecision(base, true)).toEqual({ auto: false, reason: 'own_key' })
  })

  it('他自己选了「用我自己的账号」→ 不动,哪怕那把 Key 还没填', () => {
    expect(autoRelayDecision({ ...base, mode: 'own' }, false)).toEqual({ auto: false, reason: 'own_mode' })
  })

  it('已经领过令牌 → 不动(再领一次只会把旧的作废)', () => {
    expect(autoRelayDecision({ ...base, relay_token: 'wb_x' }, false)).toEqual({ auto: false, reason: 'already_linked' })
    // 已经接上的那一支,优先于「他有自己的 Key」——接上了就是接上了。
    expect(autoRelayDecision({ ...base, relay_token: 'wb_x' }, true)).toEqual({ auto: false, reason: 'already_linked' })
  })
})


it('最近官方对齐来源独立持久化，旧配置/无效字段不借长期恢复记录猜来源', async () => {
  const file = tempFile()
  const original = { mode: 'relay' as const, relay_url: 'https://relay.test', device_id: 'd', dsh_prev_model: 'deepseek-v4-flash' }
  await saveModelConfig(file, { ...original, dsh_alignment_prev_model: 'deepseek-v4-pro' })
  const restored = await loadModelConfig(file)
  expect(restored.dsh_prev_model).toBe('deepseek-v4-flash')
  expect(restored.dsh_alignment_prev_model).toBe('deepseek-v4-pro')
  expect(modelStatusOf(restored, true)).not.toHaveProperty('dsh_alignment_prev_model')
  for (const value of [undefined, '', '   ', null, 42, {}]) {
    const old = parseModelConfig(JSON.stringify({ ...original, dsh_alignment_prev_model: value }))
    expect(old.dsh_prev_model).toBe('deepseek-v4-flash')
    expect(old.dsh_alignment_prev_model).toBeUndefined()
  }
})
