/**
 * 接话模型往哪儿发(2026-09-17)。三条优先级都验一遍,外加最要紧的那一条:
 * **没有 model.json 的老机器行为一个字都不变**。
 *
 * ★ own 档的对照用例(2026-10-23 退修,Codex)不手抄配置:**从盘上读**
 * `workbench-plugin/tests/fixtures/own-endpoint-cases.json` —— 与插件侧
 * (model-config.test.ts「读唯一源夹具」)同一份源,各自用真实的解析函数,
 * 跑出同样的 base_url / model。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHANNEL_DEFAULTS } from '../src/config.ts'
import { applyCallModelRefresh, applyModelChoice, channelModelNow, channelModelRefreshOf, modelChoiceOfText, resolveChannelModel } from '../src/modelChoice.ts'
import { channelWorkerConfigOf } from '../src/config.ts'

const OFFICIAL = CHANNEL_DEFAULTS.llmBaseUrl

/** 一个假的读盘:按文件名回内容,没列到的一律 ENOENT。 */
function files(map: Record<string, string>) {
  return async (file: string): Promise<string> => {
    for (const [suffix, content] of Object.entries(map)) {
      if (file.endsWith(suffix)) return content
    }
    throw new Error('ENOENT')
  }
}

const resolve = (deps: Omit<Parameters<typeof resolveChannelModel>[0], 'fallbackBaseUrl' | 'home'> & { fallbackBaseUrl?: string, home?: string }) =>
  resolveChannelModel({ fallbackBaseUrl: OFFICIAL, home: '/tmp/fake-home', ...deps })

describe('model.json 的解析', () => {
  it('读得出 relay', () => {
    expect(modelChoiceOfText('{"mode":"relay","relay_url":"https://api.aibooo.cn/","relay_token":"wb_x"}'))
      .toEqual({ mode: 'relay', relayUrl: 'https://api.aibooo.cn', relayToken: 'wb_x' })
  })

  it('own 档读得出自己填的地址与模型名(2026-10-23,卡「事务官换Key」)', () => {
    expect(modelChoiceOfText(
      '{"mode":"own","relay_url":"https://api.aibooo.cn","own":{"base_url":"https://ark.cn-beijing.volces.com/api/plan/v3/","model":"deepseek-v4-flash"}}',
    )).toEqual({
      mode: 'own',
      relayUrl: 'https://api.aibooo.cn',
      ownBaseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      ownModel: 'deepseek-v4-flash',
    })
    // 没填 = 缺席,调用方退回官方地址 / 缺省模型名(老配置一字不变)。
    expect(modelChoiceOfText('{"mode":"own","relay_url":"https://api.aibooo.cn"}'))
      .toEqual({ mode: 'own', relayUrl: 'https://api.aibooo.cn' })
  })

  it('坏 JSON、缺 mode、relay 缺地址,一律当作「没有这个文件」', () => {
    expect(modelChoiceOfText('{坏')).toBeUndefined()
    expect(modelChoiceOfText('{}')).toBeUndefined()
    expect(modelChoiceOfText('{"mode":"relay"}')).toBeUndefined()
  })
})

describe('优先级 ① 环境变量指定的地址最大', () => {
  it('指到哪就发到哪,key 还是自己那把', async () => {
    const target = await resolve({
      env: { WORKBENCH_CHANNEL_LLM_BASE_URL: 'http://127.0.0.1:8796/v1/', DEEPSEEK_API_KEY: 'sk-env' },
      readFileImpl: files({ 'model.json': '{"mode":"relay","relay_url":"https://api.aibooo.cn","relay_token":"wb_x"}' }),
    })
    expect(target).toMatchObject({ baseUrl: 'http://127.0.0.1:8796/v1', key: 'sk-env', source: 'env', ready: true })
  })

  it('指了地址但没有 key:照样起,只是接不了话', async () => {
    const target = await resolve({
      env: { WORKBENCH_CHANNEL_LLM_BASE_URL: 'http://127.0.0.1:8796/v1' },
      readFileImpl: files({}),
    })
    expect(target.ready).toBe(false)
    expect(target.note).toContain('没有 key')
  })
})

describe('优先级 ② model.json', () => {
  it('relay + 令牌:发去中转,拿令牌当 Bearer', async () => {
    const target = await resolve({
      env: { DEEPSEEK_API_KEY: 'sk-his-own' },
      readFileImpl: files({ 'model.json': '{"mode":"relay","relay_url":"https://api.aibooo.cn","relay_token":"wb_x"}' }),
    })
    expect(target).toEqual({
      baseUrl: 'https://api.aibooo.cn/v1', key: 'wb_x', source: 'relay', ready: true,
      note: '接话模型走工作台提供的服务',
    })
  })

  it('own:直连官方,用他自己的 Key', async () => {
    const target = await resolve({
      env: {},
      readFileImpl: files({
        'model.json': '{"mode":"own","relay_url":"https://api.aibooo.cn","relay_token":"wb_x"}',
        'credentials.json': '{"keys":{"deepseek":"sk-from-file"}}',
      }),
    })
    expect(target).toMatchObject({ baseUrl: OFFICIAL, key: 'sk-from-file', source: 'own', ready: true })
    // 老配置没填模型名:不塞一个进 target,工人照旧用缺省那个(行为一字不变)。
    expect(target.model).toBeUndefined()
  })

  /**
   * ★ 唯一源对照(2026-10-23 退修,Codex):**从盘上读** workbench-plugin 的夹具,
   * 与插件侧同一份源;工人这一家的解析(modelChoiceOfText + resolveChannelModel)
   * 必须跑出与 expect 相同的 base_url / model;Key 工人这一家 env 优先于 credentials.json。
   */
  it('读唯一源夹具:每个 case 的 base_url / model / key 与 expect 一致', async () => {
    const cases = (JSON.parse(readFileSync(
      join(import.meta.dirname, '..', '..', 'workbench-plugin', 'tests', 'fixtures', 'own-endpoint-cases.json'),
      'utf8',
    )) as {
      cases: { name: string, model_json: string, credentials_json: string, env: Record<string, string>,
        expect: { base_url: string, model: string, key_worker: string } }[]
    }).cases
    expect(cases.length).toBeGreaterThanOrEqual(5)
    for (const one of cases) {
      const target = await resolve({
        env: one.env,
        readFileImpl: files({ 'model.json': one.model_json, 'credentials.json': one.credentials_json }),
      })
      // 生效模型名一致:没填模型名时工人用内置缺省(与插件侧 OWN_DEFAULT_MODEL 同一个值)。
      expect(target, one.name).toMatchObject({
        baseUrl: one.expect.base_url, key: one.expect.key_worker, source: 'own', ready: true,
      })
      expect(target.model ?? CHANNEL_DEFAULTS.llmModel, one.name).toBe(one.expect.model)
    }
  })

  it('own 填了模型名但没填地址:地址照旧官方,模型名照用', async () => {
    const target = await resolve({
      env: {},
      readFileImpl: files({
        'model.json': '{"mode":"own","relay_url":"https://relay.test","own":{"model":"deepseek-v4-flash"}}',
        'credentials.json': '{"keys":{"deepseek":"sk-from-file"}}',
      }),
    })
    expect(target).toMatchObject({ baseUrl: OFFICIAL, model: 'deepseek-v4-flash', ready: true })
  })

  it('选了中转但还没领到凭证:退回他自己的 Key,并且**说出来**', async () => {
    const target = await resolve({
      env: { DEEPSEEK_API_KEY: 'sk-his-own' },
      readFileImpl: files({ 'model.json': '{"mode":"relay","relay_url":"https://api.aibooo.cn"}' }),
    })
    expect(target).toMatchObject({ baseUrl: OFFICIAL, key: 'sk-his-own', source: 'own', ready: true })
    expect(target.note).toContain('还没领到凭证')
  })

  it('选了中转没凭证、own 档填了自己端点:退回时走他自己那个端点(地址与模型名都对)', async () => {
    const target = await resolve({
      env: { DEEPSEEK_API_KEY: 'sk-his-own' },
      readFileImpl: files({
        'model.json': '{"mode":"relay","relay_url":"https://api.aibooo.cn","own":{"base_url":"https://ark.test/v3","model":"m-1"}}',
      }),
    })
    expect(target).toMatchObject({ baseUrl: 'https://ark.test/v3', model: 'm-1', key: 'sk-his-own', source: 'own', ready: true })
    expect(target.note).toContain('还没领到凭证')
  })

  it('选了中转、没凭证、也没有自己的 Key:接不了话,但如实说清楚', async () => {
    const target = await resolve({
      env: {},
      readFileImpl: files({ 'model.json': '{"mode":"relay","relay_url":"https://api.aibooo.cn"}' }),
    })
    expect(target.ready).toBe(false)
    expect(target.note).toContain('接不了话')
  })
})

describe('优先级 ③ 老机器一个字不变', () => {
  it('没有 model.json:官方地址 + 环境变量的 Key', async () => {
    const target = await resolve({ env: { DEEPSEEK_API_KEY: 'sk-env' }, readFileImpl: files({}) })
    expect(target).toMatchObject({ baseUrl: OFFICIAL, key: 'sk-env', source: 'own', ready: true })
  })

  it('没有 model.json:官方地址 + credentials.json 的 Key', async () => {
    const target = await resolve({
      env: {},
      readFileImpl: files({ 'credentials.json': '{"keys":{"deepseek":"sk-from-file"}}' }),
    })
    expect(target).toMatchObject({ baseUrl: OFFICIAL, key: 'sk-from-file', ready: true })
  })

  it('什么都没有:照旧「没有接话模型的 key」', async () => {
    const target = await resolve({ env: {}, readFileImpl: files({}) })
    expect(target.ready).toBe(false)
    expect(target.note).toBe('没有接话模型的 key')
  })

  it('model.json 写坏了也按老机器处理 —— 不去一个没有令牌的地方发请求', async () => {
    const target = await resolve({
      env: { DEEPSEEK_API_KEY: 'sk-env' },
      readFileImpl: files({ 'model.json': '{这不是 JSON' }),
    })
    expect(target).toMatchObject({ baseUrl: OFFICIAL, key: 'sk-env' })
  })
})

describe('日志里不许出现 key', () => {
  it('note 里一个字都没有', async () => {
    for (const target of [
      await resolve({ env: { DEEPSEEK_API_KEY: 'sk-secret-env' }, readFileImpl: files({}) }),
      await resolve({
        env: {},
        readFileImpl: files({ 'model.json': '{"mode":"relay","relay_url":"https://api.aibooo.cn","relay_token":"wb_secret"}' }),
      }),
    ]) {
      expect(target.note).not.toContain('sk-secret-env')
      expect(target.note).not.toContain('wb_secret')
    }
  })
})

/**
 * 「同一通电话的配置」(2026-10-23 运行时 P1):接话模型/首声模型/地址/Key 这四样
 * 是**每通电话开始**才定死的 —— 设置里换了模型,在通的这一通照旧打完,下一通自然
 * 吃新配置(重读在 agent.ts 的每通刷新,与「认得出哪几家」同一条缝;不打断通话,
 * 也不靠外部重启进程)。
 */
describe('applyModelChoice / channelModelNow:一通电话用哪份模型配置', () => {
  const base = channelWorkerConfigOf({})

  it('applyModelChoice:地址换、自己填的模型名跟进,env 指过的照旧最大', () => {
    const withModel = applyModelChoice(base, {
      baseUrl: 'https://ark.test/v3', model: 'qa-brain-b', key: 'sk-x', source: 'own', ready: true, note: '',
    }, {})
    expect(withModel.llmBaseUrl).toBe('https://ark.test/v3')
    expect(withModel.llmModel).toBe('qa-brain-b')
    expect(withModel.firstVoiceModel).toBe('qa-brain-b')
    // 没填模型名:两个模型名都不动(内置缺省)。
    const bare = applyModelChoice(base, {
      baseUrl: 'https://ark.test/v3', key: 'sk-x', source: 'own', ready: true, note: '',
    }, {})
    expect(bare.llmModel).toBe(base.llmModel)
    expect(bare.firstVoiceModel).toBe(base.firstVoiceModel)
    // env 指过模型名:文件里的不盖它。
    const envBase = channelWorkerConfigOf({ WORKBENCH_CHANNEL_LLM_MODEL: 'env-model' })
    const envPicked = applyModelChoice(envBase, {
      baseUrl: 'https://ark.test/v3', model: 'qa-brain-b', key: 'sk-x', source: 'own', ready: true, note: '',
    }, { WORKBENCH_CHANNEL_LLM_MODEL: 'env-model' })
    expect(envPicked.llmModel).toBe('env-model')
    // 手动点停/没在通:这一层不管进程起停,只算这一通用的配置。
  })

  it('channelModelNow:从拼好的 config 与解析结果提取「这一通」的活视图', () => {
    const config = applyModelChoice(base, {
      baseUrl: 'https://ark.test/v3', model: 'qa-brain-b', key: 'sk-x', source: 'own', ready: true, note: '',
    }, {})
    expect(channelModelNow(config, 'sk-x', 'own')).toEqual({
      llmModel: 'qa-brain-b', firstVoiceModel: 'qa-brain-b', llmBaseUrl: 'https://ark.test/v3', key: 'sk-x', source: 'own',
    })
  })

  it('channelModelRefreshOf:配置没变/取不到 → 不换(返回 undefined);变了 → 给新的一份', () => {
    const current = channelModelNow(configOf(base), 'sk-x', 'own')
    expect(channelModelRefreshOf(current, undefined)).toBeUndefined()
    expect(channelModelRefreshOf(current, current)).toBeUndefined()
    const next = { ...current, llmModel: 'qa-brain-b', llmBaseUrl: 'https://ark.test/v3', key: 'sk-y' }
    expect(channelModelRefreshOf(current, next)).toEqual(next)
  })
})

function configOf(base: ReturnType<typeof channelWorkerConfigOf>) {
  return applyModelChoice(base, { baseUrl: base.llmBaseUrl, key: 'sk-x', source: 'own', ready: true, note: '' }, {})
}

/**
 * 「换 LLM,成功才提交」(2026-10-23 源审退修):
 * 原实现在 await agent.updateOptions **之前**就改了本地 llmOptions/firstVoiceClient ——
 * updateOptions 失败时框架回滚旧 LLM,本地缓存却已新,下一通 fresh 与缓存相同 → 永远不重试。
 * 现由 applyCallModelRefresh 编排:只有 apply 回 true 才交还新状态提交;false 回 undefined,
 * 调用方保持旧状态 → 下一通 fresh 依旧不同 → 再次尝试。
 */
describe('applyCallModelRefresh:成功才提交、失败下一通再试、顺序钉住', () => {
  const current: import('../src/modelChoice.ts').ChannelModelNow = {
    llmModel: 'qa-brain-a', firstVoiceModel: 'qa-brain-a', llmBaseUrl: 'https://a/v1', key: 'k-a', source: 'own',
  }
  const fresh: import('../src/modelChoice.ts').ChannelModelNow = {
    llmModel: 'qa-brain-b', firstVoiceModel: 'qa-brain-b', llmBaseUrl: 'https://b/v1', key: 'k-b', source: 'own',
  }

  it('★updateOptions 失败 → 返回 undefined(本地保持旧);同一次 fresh 再试仍会触发并成功采用', async () => {
    let applyCalls = 0
    const first = await applyCallModelRefresh(current, fresh, async () => { applyCalls += 1; return false })
    expect(first).toBeUndefined()
    // 失败没提交 → 本地还是旧 → 下一通 fresh 依旧不同 → 再试。
    const second = await applyCallModelRefresh(current, fresh, async () => { applyCalls += 1; return true })
    expect(second).toEqual(fresh)
    expect(applyCalls).toBe(2)
  })

  it('★await apply 之后才返回:apply 用延迟未决时,函数不提前结束(调用方不会抢在它前面投首句)', async () => {
    let settled = false
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const run = applyCallModelRefresh(current, fresh, async () => {
      await pending
      settled = true
      return true
    })
    // 让 run 跑到 await 那一步:apply 还没 settle,函数不返回。
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    release()
    const result = await run
    expect(settled).toBe(true)
    expect(result).toEqual(fresh)
  })

  it('四样没变 → 不调 apply(省一次重建)', async () => {
    let called = 0
    const r = await applyCallModelRefresh(current, current, async () => { called += 1; return true })
    expect(r).toBeUndefined()
    expect(called).toBe(0)
  })
})
