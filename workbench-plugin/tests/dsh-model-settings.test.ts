// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DSH_MANAGED_MARK, DSH_OWN_KEY_ENV, DSH_OWN_PROVIDER, DSH_RELAY_PROVIDER, DSH_RELAY_TOKEN_ENV,
  readAgentDefaultModel, relayProviderBlock, removeEnvLine, settingsForOwnEndpoint, settingsForOwnKey,
  settingsForOwnModel, settingsForRelay,
  topLevelBlockRange, upsertEnvLine,
} from '../src/server/dshModelSettings.ts'

// Ben 本机那份 settings.yaml 的样子(2026-09-17 实际读到的形状)。
const BEN = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash-vision-exp
`

describe('找顶层段', () => {
  it('段从自己那一行开始,到下一个顶层键为止', () => {
    const lines = BEN.split('\n')
    expect(topLevelBlockRange(lines, 'ui-onboarding')).toEqual({ start: 0, end: 2 })
    expect(topLevelBlockRange(lines, 'agent-default-model')?.start).toBe(2)
    expect(topLevelBlockRange(lines, '没有这一段')).toBeUndefined()
  })
})

describe('读现在选的是什么', () => {
  it('读得出 provider 与 model', () => {
    expect(readAgentDefaultModel(BEN)).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp',
    })
  })

  it('带引号的值把引号剥掉', () => {
    expect(readAgentDefaultModel('agent-default-model:\n  provider: "x"\n  model: \'y\'\n'))
      .toEqual({ provider: 'x', model: 'y' })
  })

  it('没有这一段就是 undefined', () => {
    expect(readAgentDefaultModel('ui-onboarding:\n  a: 1\n')).toBeUndefined()
  })
})

describe('切到中转', () => {
  it('装上 llm-pi-ai 那一段,provider 指过去,model 那一行一个字不动', () => {
    const out = settingsForRelay(BEN, { baseUrl: 'https://api.aibooo.cn/v1' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text).toContain(`provider: ${DSH_RELAY_PROVIDER}`)
    expect(out.text).toContain('model: deepseek-v4-flash-vision-exp')
    expect(out.text).toContain('api: openai-completions')
    expect(out.text).toContain('baseURL: https://api.aibooo.cn/v1')
    expect(out.text).toContain(`apiKeyEnv: ${DSH_RELAY_TOKEN_ENV}`)
    // models 必须包含此刻选中的那一个,否则切过去 DSH 会说 UNKNOWN_MODEL。
    expect(out.text).toContain('- id: deepseek-v4-flash-vision-exp')
    // 别人的段原样保留。
    expect(out.text).toContain('ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1')
  })

  it('再切一次是幂等的,不会堆出两段', () => {
    const first = settingsForRelay(BEN, { baseUrl: 'https://api.aibooo.cn/v1' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = settingsForRelay(first.text, { baseUrl: 'https://api.aibooo.cn/v1' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.text.split('llm-pi-ai:').length - 1).toBe(1)
    expect(second.changed).toBe(false)
  })

  it('换了地址就把那一段改掉', () => {
    const first = settingsForRelay(BEN, { baseUrl: 'https://api.aibooo.cn/v1' })
    if (!first.ok) throw new Error('第一步就该成功')
    const second = settingsForRelay(first.text, { baseUrl: 'https://别处/v1' })
    if (!second.ok) throw new Error('第二步也该成功')
    expect(second.text).toContain('baseURL: https://别处/v1')
    expect(second.text).not.toContain('baseURL: https://api.aibooo.cn/v1')
  })

  it('他自己配过 llm-pi-ai 的话,一个字都不动,只回一句话', () => {
    const his = `${BEN}llm-pi-ai:
  providers:
    my-own-gateway:
      api: openai-completions
      baseURL: https://我自己的/v1
      apiKeyEnv: MY_KEY
      models:
        - id: whatever
`
    const out = settingsForRelay(his, { baseUrl: 'https://api.aibooo.cn/v1' })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toContain('你自己配过的')
    // 给人看的话里不出现文件名(2026-09-26,卡 U1b)。
    expect(out.ok === false && out.error).not.toMatch(/settings\.yaml|\.dsh|\.yml|docs\//)
  })

  it('没接中转(地址是空的,拼出来是 /v1):拒绝,不往 DSH 里写一个连不上的 baseURL', () => {
    const out = settingsForRelay(BEN, { baseUrl: '/v1' })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toContain('没接中转')
  })

  it('我们自己写过的那一段认得出来(靠段内的标记)', () => {
    const block = relayProviderBlock({ baseUrl: 'https://x/v1', models: ['m'] })
    expect(block).toContain(DSH_MANAGED_MARK)
  })

  it('没有 agent-default-model 就不猜,直接说清楚(话里不出现文件名)', () => {
    const out = settingsForRelay('ui-onboarding:\n  a: 1\n', { baseUrl: 'https://x/v1' })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toContain('还没选过模型')
    expect(out.ok === false && out.error).not.toMatch(/settings\.yaml|\.dsh|\.yml|agent-default-model/)
  })

  it('有段但没写 model 也不猜', () => {
    const out = settingsForRelay('agent-default-model:\n  provider: deepseek-official\n', { baseUrl: 'https://x/v1' })
    expect(out.ok).toBe(false)
  })
})

describe('切回自己的 Key', () => {
  it('默认回 deepseek-official,我们那一段留着不删', () => {
    const relay = settingsForRelay(BEN, { baseUrl: 'https://x/v1' })
    if (!relay.ok) throw new Error('第一步该成功')
    const back = settingsForOwnKey(relay.text)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.text).toContain('provider: deepseek-official')
    expect(back.text).toContain('llm-pi-ai:')
  })

  it('记得住切走之前那一个', () => {
    const custom = BEN.replace('deepseek-official', '他自己的路由')
    const relay = settingsForRelay(custom, { baseUrl: 'https://x/v1' })
    if (!relay.ok) throw new Error('第一步该成功')
    const back = settingsForOwnKey(relay.text, '他自己的路由')
    if (!back.ok) throw new Error('第二步该成功')
    expect(back.text).toContain('provider: 他自己的路由')
  })

  it('本来就没这一段:不是错误,也什么都不改', () => {
    const out = settingsForOwnKey('ui-onboarding:\n  a: 1\n')
    expect(out).toEqual({ ok: true, text: 'ui-onboarding:\n  a: 1\n', changed: false })
  })
})

/**
 * own 档填了自己接的端点(2026-10-23,卡「事务官换Key」):DSH 那一侧要把模型请求
 * 指到那个 OpenAI 协议口。写法同中转那一段:一条我们维护的 pi-ai 路由 + 环境变量引用,
 * 但路由指向他自己填的地址,模型名也是他填的那一个;Key 由 modelService 写进 .env(不在这里)。
 */
describe('切到自己接的端点(2026-10-23)', () => {
  const ARK = { baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: 'deepseek-v4-flash' }

  it('装上 workbench-own 那一段,provider 与 model 都指过去;别人的段原样', () => {
    const out = settingsForOwnEndpoint(BEN, ARK)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text).toContain(`provider: ${DSH_OWN_PROVIDER}`)
    expect(out.text).toContain(`model: ${ARK.model}`)
    expect(out.text).toContain(`baseURL: ${ARK.baseUrl}`)
    expect(out.text).toContain(`apiKeyEnv: ${DSH_OWN_KEY_ENV}`)
    expect(out.text).toContain(`- id: ${ARK.model}`)
    expect(out.text).toContain('ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1')
    // 地址与模型名不是秘密;Key 永远不出现在这一份文件里。
    expect(out.text).not.toContain('sk-')
  })

  it('从中转那段切过来:整段换掉,不堆两段 llm-pi-ai', () => {
    const relay = settingsForRelay(BEN, { baseUrl: 'https://api.aibooo.cn/v1' })
    if (!relay.ok) throw new Error('第一步该成功')
    const out = settingsForOwnEndpoint(relay.text, ARK)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text.split('llm-pi-ai:').length - 1).toBe(1)
    expect(out.text).not.toContain('api.aibooo.cn')
    expect(out.text).toContain(`provider: ${DSH_OWN_PROVIDER}`)
  })

  it('再切一次是幂等的', () => {
    const first = settingsForOwnEndpoint(BEN, ARK)
    if (!first.ok) throw new Error('第一步该成功')
    const second = settingsForOwnEndpoint(first.text, ARK)
    expect(second).toEqual({ ok: true, text: first.text, changed: false })
  })

  it('他自己配过 llm-pi-ai 的话,一个字都不动,只回一句话', () => {
    const his = `${BEN}llm-pi-ai:
  providers:
    my-own-gateway:
      api: openai-completions
      baseURL: https://我自己的/v1
      apiKeyEnv: MY_KEY
      models:
        - id: whatever
`
    const out = settingsForOwnEndpoint(his, ARK)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toContain('你自己配过的')
    expect(out.ok === false && out.error).not.toMatch(/settings\.yaml|\.dsh|\.yml|docs\//)
  })

  it('没有 agent-default-model 就不猜,不说文件名', () => {
    const out = settingsForOwnEndpoint('ui-onboarding:\n  a: 1\n', ARK)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toContain('还没选过模型')
    expect(out.ok === false && out.error).not.toMatch(/settings\.yaml|\.dsh|\.yml|agent-default-model/)
  })

  it('地址不带协议:拒写', () => {
    const out = settingsForOwnEndpoint(BEN, { baseUrl: 'ark/v1', model: 'm' })
    expect(out.ok).toBe(false)
  })
})

/**
 * 「地址保持官方、只换模型名」(2026-10-23 退修,Codex):DSH 那一侧不换路由、不碰 Key,
 * 只把 `agent-default-model.model` 换成他填的那一个 —— provider 照「切回自己的 Key」的
 * 回滚语义(默认 deepseek-official,或切走之前那一个),我们那一段留着不删。
 */
describe('官方地址只换模型名(2026-10-23 退修)', () => {
  it('provider 回 deepseek-official,model 行换成他填的,中转那一段留着', () => {
    const relay = settingsForRelay(BEN, { baseUrl: 'https://x/v1' })
    if (!relay.ok) throw new Error('第一步该成功')
    const out = settingsForOwnModel(relay.text, undefined, 'my-finetune-1')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text).toContain('provider: deepseek-official')
    expect(out.text).toContain('model: my-finetune-1')
    expect(out.text).not.toContain('provider: workbench-own')
    expect(out.text).toContain('llm-pi-ai:')
  })

  it('记得住切走之前那一个 provider', () => {
    const custom = BEN.replace('deepseek-official', '他自己的路由')
    const relay = settingsForRelay(custom, { baseUrl: 'https://x/v1' })
    if (!relay.ok) throw new Error('第一步该成功')
    const out = settingsForOwnModel(relay.text, '他自己的路由', 'my-finetune-1')
    if (!out.ok) throw new Error('该成功')
    expect(out.text).toContain('provider: 他自己的路由')
    expect(out.text).toContain('model: my-finetune-1')
  })

  it('幂等:第二遍一个字不改', () => {
    const first = settingsForOwnModel(BEN, undefined, 'my-finetune-1')
    if (!first.ok) throw new Error('第一步该成功')
    const second = settingsForOwnModel(first.text, undefined, 'my-finetune-1')
    expect(second).toEqual({ ok: true, text: first.text, changed: false })
  })

  it('模型名不安全:拒写,不硬塞进 YAML', () => {
    const out = settingsForOwnModel(BEN, undefined, 'a: b #c')
    expect(out.ok).toBe(false)
  })

  it('没有 agent-default-model:不新建、说人话(话里不出现文件名)', () => {
    const out = settingsForOwnModel('ui-onboarding:\n  a: 1\n', undefined, 'my-finetune-1')
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toContain('还没选过模型')
      expect(out.error).not.toMatch(/settings\.yaml|\.dsh|\.yml|agent-default-model/)
    }
  })
})

describe('.env 行级改写', () => {
  it('没有就追加,有了就换值,别的行不动', () => {
    const before = 'DEEPSEEK_API_KEY=sk-ben\n'
    const once = upsertEnvLine(before, DSH_RELAY_TOKEN_ENV, 'wb_one')
    expect(once).toBe('DEEPSEEK_API_KEY=sk-ben\nWORKBENCH_RELAY_TOKEN=wb_one\n')
    const twice = upsertEnvLine(once, DSH_RELAY_TOKEN_ENV, 'wb_two')
    expect(twice).toBe('DEEPSEEK_API_KEY=sk-ben\nWORKBENCH_RELAY_TOKEN=wb_two\n')
  })

  it('空文件也能写', () => {
    expect(upsertEnvLine('', 'A', 'b')).toBe('A=b\n')
  })

  it('认得出 export 前缀的写法', () => {
    expect(upsertEnvLine('export WORKBENCH_RELAY_TOKEN=old\n', DSH_RELAY_TOKEN_ENV, 'new'))
      .toBe('WORKBENCH_RELAY_TOKEN=new\n')
  })

  it('值里有空格或 # 就加引号', () => {
    expect(upsertEnvLine('', 'A', 'x y')).toBe('A="x y"\n')
    expect(upsertEnvLine('', 'A', 'a#b')).toBe('A="a#b"\n')
  })

  it('删掉一行时别的原样', () => {
    const text = 'DEEPSEEK_API_KEY=sk-ben\nWORKBENCH_RELAY_TOKEN=wb_x\nOTHER=1\n'
    expect(removeEnvLine(text, DSH_RELAY_TOKEN_ENV)).toBe('DEEPSEEK_API_KEY=sk-ben\nOTHER=1\n')
    // 没有那一行时原样返回(连换行都不动)。
    expect(removeEnvLine('A=1', 'B')).toBe('A=1')
  })
})

describe('中转模型表与看图能力(2026-09-24 统一输入框)', () => {
  it('写我们那一段时登记 flash 与 pro;能看图的写 input: [text, image],pro 不写', async () => {
    const { RELAY_STANDARD_MODELS } = await import('../src/server/dshModelSettings.ts')
    const out = settingsForRelay(BEN, { baseUrl: 'https://api.aibooo.cn/v1' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    for (const id of RELAY_STANDARD_MODELS) expect(out.text).toContain(`- id: ${id}`)
    expect(out.text).toContain('- id: deepseek-v4-flash\n          input: [text, image]')
    expect(out.text).toContain('- id: deepseek-v4-flash-vision-exp\n          input: [text, image]')
    expect(out.text).not.toMatch(/- id: deepseek-v4-pro\n\s+input/)
  })

  it('relayModelSpec:表里有的用表,表外的带 vision 才当能看图,短名不编', async () => {
    const { relayModelSpec } = await import('../src/server/dshModelSettings.ts')
    expect(relayModelSpec('deepseek-v4-flash')).toEqual({ id: 'deepseek-v4-flash', title: 'V4 Flash', images: true })
    expect(relayModelSpec('deepseek-v4-pro').images).toBe(false)
    expect(relayModelSpec('some-vision-model')).toEqual({ id: 'some-vision-model', title: 'some-vision-model', images: true })
    expect(relayModelSpec('other').images).toBe(false)
  })

  it('upgradeManagedRelayBlock:老机器上我们写的那段补齐 pro 与 input,provider 一个字不动', async () => {
    const { upgradeManagedRelayBlock } = await import('../src/server/dshModelSettings.ts')
    const old = `agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
llm-pi-ai:
  ${DSH_MANAGED_MARK}
  providers:
    workbench-relay:
      displayName: 工作台提供的模型服务
      api: openai-completions
      baseURL: https://别处/v1
      apiKeyEnv: ${DSH_RELAY_TOKEN_ENV}
      models:
        - id: deepseek-v4-flash
other: 1
`
    const out = upgradeManagedRelayBlock(old)
    expect(out.ok && out.changed).toBe(true)
    if (!out.ok) return
    expect(out.text).toContain('provider: deepseek-official')
    expect(out.text).toContain('baseURL: https://别处/v1')
    expect(out.text).toContain('- id: deepseek-v4-pro')
    expect(out.text).toContain('- id: deepseek-v4-flash\n          input: [text, image]')
    expect(out.text).toContain('\nother: 1\n')
    // 再跑一遍不再变
    const again = upgradeManagedRelayBlock(out.text)
    expect(again.ok && again.changed).toBe(false)
  })

  it('upgradeManagedRelayBlock:他自己配的 llm-pi-ai 一个字不动', async () => {
    const { upgradeManagedRelayBlock } = await import('../src/server/dshModelSettings.ts')
    const mine = `llm-pi-ai:\n  providers:\n    x:\n      baseURL: https://x/v1\n      models:\n        - id: m\n`
    expect(upgradeManagedRelayBlock(mine)).toEqual({ ok: true, text: mine, changed: false })
  })
})
