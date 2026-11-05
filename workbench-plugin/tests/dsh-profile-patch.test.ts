// @vitest-environment node
/**
 * DSH 0.1.7 形态下「模型设置在 profile 补丁层里」的读写(2026-09-26,卡 U1b)。
 *
 * 夹具就是**真形状**:0.1.7 启动时把 `settings.yaml` 的每个顶层段写进当前 profile 的
 * `cordis.patch.yml`(上游 `importLegacyDocument` → `configEditor.edit`),写出来的行是
 * `- id: <段名>` + `name:` + `config:`(整段 config,因为补丁按 id **整体替换** config)。
 * 下面 `IMPORTED` 就是灰度里真读到的那个样子。
 *
 * 这一份守的是「坏一个字符 DSH 整个起不来」:认不得的文档一律拒写、别人的行一个字节不动、
 * 写完自己再读一遍核对。
 */
import { describe, expect, it } from 'vitest'
import { DSH_OWN_PROVIDER, DSH_RELAY_PROVIDER } from '../src/server/dshModelSettings.ts'
import {
  PATCH_MODEL_DEFAULTS,
  parseProfilePatch, patchForOwnEndpoint, patchForOwnKey, patchForOwnModel, patchForRelay, patchUpgradeManagedRelay,
  readPatchDefaultModel, readPatchOwnProvider, readPatchRelayProvider,
} from '../src/server/dshProfilePatch.ts'

/** 登录台建出来的那份(升级前就有,与 0.1.2 时一字不差)。 */
const OURS = `# 工作台登录台生成(可以继续往下加别的补丁)。

# 桌面工作台插件(desktop-workbench/workbench-plugin)。
- insert:
    - id: ben-workbench
      name: '@ben/dsh-workbench'

# DSH 0.1.2-rc.1 起网页要 token 或签名 cookie 才能开;把 cookie 寿命拉长,引导一次长期有效。
- id: client-connection
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
    cookieMaxAgeDays: 3650

# 对用户关掉的上游新入口(升 0.1.7 时定)。
- id: ui-sidebar-terminal
  disabled: true
- id: terminal-controller
  disabled: true
`

/**
 * 升级那一刻:0.1.7 真把我们播的 settings.yaml 收进补丁层之后的样子。
 *
 * **这一段是从真的灰度跑里逐字抄回来的**(2026-09-26:scratch HOME + `~/.dsh/runtime-next`
 * 起一次 3081,让上游 `importLegacyDocument()` 自己搬一遍,再把它写出来的
 * `cordis.patch.yml` 抄进来)。两处与"照我们自己的落笔方式猜"不一样,都要紧:
 *
 * - `name:` 是**双引号**的(上游 `yaml` 库的落笔);
 * - `input` 是**块式**(`input:` 换行后 `- text` / `- image`),不是我们写的行内 `[text, image]`。
 * - 思考档那一段(2026-09-28 卡 BS 加的)里,我们落笔的空值 `off:` 被 `yaml` 库写成 `off: null`
 *   —— 所以判"齐不齐"只比**档名**,不比值(值是线上的拼法,`off` 那一档本来就没有值)。
 *   `deepseek-v4-pro` 那一条**故意只有三档**:线上没有 low。
 *
 * 第二条正是「升级那一刻不重复写」的关键:按文本比,这一段与我们要写的那一段不同,
 * 于是第一次登录就会把语义相同的一段重写一遍(白写、还多一份备份)。所以判"要不要重写"
 * 是按**语义**比的(`relayBlockMatches`)。
 */
const IMPORTED = `${OURS}
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-08-13.1
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: workbench-relay
    model: deepseek-v4-flash-vision-exp
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      workbench-relay:
        displayName: 工作台提供的模型服务
        api: openai-completions
        baseURL: https://api.aibooo.cn/v1
        apiKeyEnv: WORKBENCH_RELAY_TOKEN
        compat:
          thinkingFormat: deepseek
          supportsReasoningEffort: true
          requiresReasoningContentOnAssistantMessages: true
          supportsDeveloperRole: false
        models:
          - id: deepseek-v4-flash-vision-exp
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
              high: high
              max: max
          - id: deepseek-v4-flash
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
              high: high
              max: max
          - id: deepseek-v4-pro
            reasoningEfforts:
              off: null
              high: high
              max: max
`

const D = PATCH_MODEL_DEFAULTS

describe('认得的文档 / 认不得的文档', () => {
  it('上游那份空模板(注释 + [])算空文档,不是错', () => {
    const doc = parseProfilePatch('# Your patch layer for this dsh profile\n[]\n')
    expect(doc.ok).toBe(true)
    if (doc.ok) expect(doc.rows).toEqual([])
  })

  it('真文档能按行认出每一行补丁', () => {
    const doc = parseProfilePatch(IMPORTED)
    expect(doc.ok).toBe(true)
    if (!doc.ok) return
    expect(doc.rows.map(row => row.id)).toEqual([
      undefined, 'client-connection', 'ui-sidebar-terminal', 'terminal-controller',
      'ui-settings-general', 'agent-default-model', 'llm-pi-ai',
    ])
    expect(doc.rows[0]?.insert).toBe(true)
  })

  it.each([
    ['带制表符', '- id: x\n\tconfig: 1\n'],
    ['多文档', '---\n- id: x\n'],
    ['顶层不是数组', 'agent-default-model:\n  provider: x\n'],
    ['行内 config', '- id: agent-default-model\n  config: {provider: x}\n'],
  ])('认不得就说认不得(%s),一个字都不改', (_name, text) => {
    const doc = parseProfilePatch(text)
    expect(doc.ok).toBe(false)
    const out = patchForRelay(text, { baseUrl: 'https://x/v1', ...D })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).not.toMatch(/cordis|\.yml|settings\.yaml/)
  })
})

describe('读现在选的是什么', () => {
  it('读 patch 里那一行的 provider 与 model', () => {
    expect(readPatchDefaultModel(IMPORTED)).toEqual({
      provider: 'workbench-relay', model: 'deepseek-v4-flash-vision-exp',
    })
  })

  it('没有那一行 = 还没人写过(回 undefined,由上层退回上游缺省)', () => {
    expect(readPatchDefaultModel(OURS)).toBeUndefined()
  })

  it('引号、行尾注释都认;`reasoningEffort` 也读出来', () => {
    const text = `- id: agent-default-model\n  config:\n    provider: "a"\n    model: 'b'  # 他手写的\n    reasoningEffort: high\n`
    expect(readPatchDefaultModel(text)).toEqual({ provider: 'a', model: 'b', reasoningEffort: 'high' })
  })

  it('带 insert 的那一行不算(上游按 id 找的也是非 insert 的最后一行)', () => {
    const text = `- insert:\n    - id: agent-default-model\n      name: x\n`
    expect(readPatchDefaultModel(text)).toBeUndefined()
  })
})

describe('读我们那条中转路由', () => {
  it('认出 baseURL、已登记的模型、哪几个能收图、以及每个模型的思考档', () => {
    expect(readPatchRelayProvider(IMPORTED)).toEqual({
      ok: true,
      found: true,
      baseUrl: 'https://api.aibooo.cn/v1',
      api: 'openai-completions',
      apiKeyEnv: 'WORKBENCH_RELAY_TOKEN',
      displayName: '工作台提供的模型服务',
      models: ['deepseek-v4-flash-vision-exp', 'deepseek-v4-flash', 'deepseek-v4-pro'],
      imageModels: ['deepseek-v4-flash-vision-exp', 'deepseek-v4-flash'],
      compat: {
        thinkingFormat: 'deepseek',
        supportsReasoningEffort: 'true',
        requiresReasoningContentOnAssistantMessages: 'true',
        supportsDeveloperRole: 'false',
      },
      // pro 只有三档 —— 线上没有 low。
      thinkingLevels: {
        'deepseek-v4-flash-vision-exp': ['off', 'low', 'high', 'max'],
        'deepseek-v4-flash': ['off', 'low', 'high', 'max'],
        'deepseek-v4-pro': ['off', 'high', 'max'],
      },
    })
  })

  it('少一档就当没配齐(老机器开机那一下会自己补上)', () => {
    const missing = IMPORTED.replace('              low: low\n', '')
    const patched = patchForRelay(missing, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    expect(patched.ok).toBe(true)
    if (patched.ok) expect(patched.changed).toBe(true)
  })

  it('`input` 两种落笔都认:上游写块式,我们写行内,读出来一样', () => {
    const inline = IMPORTED
      .replaceAll('            input:\n              - text\n              - image\n', '            input: [text, image]\n')
    expect(inline).not.toBe(IMPORTED)
    const a = readPatchRelayProvider(IMPORTED)
    const b = readPatchRelayProvider(inline)
    expect(a.ok && a.found && a.imageModels).toEqual(b.ok && b.found && b.imageModels)
  })

  it('压根没有那一行 = 还没配过', () => {
    expect(readPatchRelayProvider(OURS)).toEqual({ ok: true, found: false })
  })

  it('他自己配了别的路由 → 不是我们的,拒绝(话里不出现文件名)', () => {
    const his = `- id: llm-pi-ai\n  config:\n    providers:\n      my-own:\n        baseURL: https://他自己的/v1\n`
    const got = readPatchRelayProvider(his)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.error).not.toMatch(/\.yml|settings\.yaml|~\/\.dsh/)
  })

  it('config 里除了 providers 还有别的键 → 不猜,拒绝', () => {
    const odd = `- id: llm-pi-ai\n  config:\n    providers:\n      workbench-relay:\n        baseURL: https://x/v1\n    别的键: 1\n`
    expect(readPatchRelayProvider(odd).ok).toBe(false)
  })
})

describe('切到中转', () => {
  it('还没有那两行时:两行都补出来,别人的行一个字节不动', () => {
    const out = patchForRelay(OURS, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.changed).toBe(true)
    // 别人的行原样在前面
    expect(out.text.startsWith(OURS.trimEnd())).toBe(true)
    // 没写过模型 → 用中转认的那个 id(不是上游的 deepseek-flash)
    expect(readPatchDefaultModel(out.text)).toEqual({
      provider: 'workbench-relay', model: D.relayModel,
    })
    const relay = readPatchRelayProvider(out.text)
    expect(relay).toMatchObject({ ok: true, found: true, baseUrl: 'https://api.aibooo.cn/v1' })
    // 不写 name:(写错一个字整行会被上游当 name 不匹配跳过,而少写它不会)
    expect(out.text).not.toMatch(/- id: agent-default-model\n {2}name:/)
  })

  it('★ 升级那一刻(段刚被上游收进 patch、选的就是中转):一个字都不用改', () => {
    const out = patchForRelay(IMPORTED, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    expect(out).toEqual({ ok: true, text: IMPORTED, changed: false })
  })

  it('我们自己落笔的那份(行内 input)同样一个字不改', () => {
    const inline = IMPORTED
      .replaceAll('            input:\n              - text\n              - image\n', '            input: [text, image]\n')
    const out = patchForRelay(inline, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    expect(out).toEqual({ ok: true, text: inline, changed: false })
  })

  it('他自己选过的模型不被覆盖', () => {
    const chosen = IMPORTED.replace('provider: workbench-relay', 'provider: deepseek-official')
    const out = patchForRelay(chosen, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(readPatchDefaultModel(out.text)?.model).toBe('deepseek-v4-flash-vision-exp')
    expect(readPatchDefaultModel(out.text)?.provider).toBe('workbench-relay')
  })

  it('`reasoningEffort` 这类别的键留着', () => {
    const withEffort = IMPORTED.replace(
      '    model: deepseek-v4-flash-vision-exp\n',
      '    model: deepseek-v4-flash-vision-exp\n    reasoningEffort: high\n',
    ).replace('provider: workbench-relay\n    model', 'provider: deepseek-official\n    model')
    const out = patchForRelay(withEffort, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    expect(out.ok).toBe(true)
    if (out.ok) expect(readPatchDefaultModel(out.text)?.reasoningEffort).toBe('high')
  })

  it('跑第二遍不变(幂等)', () => {
    const first = patchForRelay(OURS, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = patchForRelay(first.text, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    expect(second).toEqual({ ok: true, text: first.text, changed: false })
  })

  it('换了地址就把那一行改过来', () => {
    const out = patchForRelay(IMPORTED, { baseUrl: 'https://别处/v1', ...D })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.changed).toBe(true)
    expect(readPatchRelayProvider(out.text)).toMatchObject({ baseUrl: 'https://别处/v1' })
  })

  it('他自己配过 llm-pi-ai → 整件不做,provider 那一行也不碰', () => {
    const his = `${OURS}- id: llm-pi-ai\n  config:\n    providers:\n      my-own:\n        baseURL: https://他的/v1\n`
    const out = patchForRelay(his, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    expect(out.ok).toBe(false)
  })

  it('模型 id 里有奇怪字符 → 拒写,不硬塞进 YAML', () => {
    const odd = IMPORTED.replace('model: deepseek-v4-flash-vision-exp', "model: 'a: b #c'")
    const out = patchForRelay(odd.replace('provider: workbench-relay', 'provider: deepseek-official'), {
      baseUrl: 'https://api.aibooo.cn/v1', ...D,
    })
    expect(out.ok).toBe(false)
  })
})

describe('切回自己的 Key', () => {
  it('provider 那一行指回去,model 一个字不动', () => {
    const out = patchForOwnKey(IMPORTED, { ...D })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(readPatchDefaultModel(out.text)).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp',
    })
    // 我们那一段留着不删(下次切回来不用重写)
    expect(readPatchRelayProvider(out.text)).toMatchObject({ found: true })
  })

  it('切走之前是他自己的路由就回到那一条', () => {
    const out = patchForOwnKey(IMPORTED, { ...D, previousProvider: '他自己的路由' })
    expect(out.ok).toBe(true)
    if (out.ok) expect(readPatchDefaultModel(out.text)?.provider).toBe('他自己的路由')
  })

  it('压根没有那一行、要切回的又正是上游缺省 → 不写,不是错', () => {
    expect(patchForOwnKey(OURS, { ...D })).toEqual({ ok: true, text: OURS, changed: false })
  })
})

/**
 * own 档填了自己接的端点(2026-10-23,卡「事务官换Key」):补丁层里写成一条我们维护的
 * workbench-own 路由(provider / model 都指过去)。语义与 settings.yaml 那一代一致,
 * 对照用例在 dsh-model-settings.test.ts「切到自己接的端点」。
 */
describe('切到自己接的端点(2026-10-23)', () => {
  const ARK = { baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: 'deepseek-v4-flash' }

  it('读得出 workbench-own 那一段的地址与模型名', () => {
    const out = patchForOwnEndpoint(IMPORTED, { ...ARK, ...D })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(readPatchOwnProvider(out.text)).toEqual({ ok: true, found: true, baseUrl: ARK.baseUrl, model: ARK.model })
  })

  it('从他那一份(没有任何我们的行)补出来:别人的行一个字节不动,不写 name:', () => {
    const out = patchForOwnEndpoint(OURS, { ...ARK, ...D })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.changed).toBe(true)
    expect(out.text.startsWith(OURS.trimEnd())).toBe(true)
    expect(readPatchDefaultModel(out.text)).toEqual({ provider: DSH_OWN_PROVIDER, model: ARK.model })
    expect(out.text).not.toMatch(/- id: agent-default-model\n {2}name:/)
    expect(out.text).not.toMatch(/- id: llm-pi-ai\n {2}name:/)
  })

  it('从中转切过来:llm-pi-ai 的 config 整块换成 workbench-own(只剩一条路由)', () => {
    const out = patchForOwnEndpoint(IMPORTED, { ...ARK, ...D })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text).not.toContain('api.aibooo.cn')
    expect(readPatchDefaultModel(out.text)).toEqual({ provider: DSH_OWN_PROVIDER, model: ARK.model })
    // 别人的行原样。
    expect(out.text).toContain('cookieMaxAgeDays: 3650')
  })

  it('幂等:第二遍一个字不改', () => {
    const first = patchForOwnEndpoint(OURS, { ...ARK, ...D })
    if (!first.ok) throw new Error('第一步该成功')
    const second = patchForOwnEndpoint(first.text, { ...ARK, ...D })
    expect(second).toEqual({ ok: true, text: first.text, changed: false })
  })

  it('自己端点切回中转:workbench-own 换成 workbench-relay,provider 指回来', () => {
    const own = patchForOwnEndpoint(IMPORTED, { ...ARK, ...D })
    if (!own.ok) throw new Error('第一步该成功')
    const back = patchForRelay(own.text, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(readPatchRelayProvider(back.text)).toMatchObject({ ok: true, found: true, baseUrl: 'https://api.aibooo.cn/v1' })
    expect(readPatchDefaultModel(back.text)?.provider).toBe(DSH_RELAY_PROVIDER)
  })

  it('readPatchRelayProvider 认得出「这一段现在是我们自己的端点」(found:false,不是错)', () => {
    const own = patchForOwnEndpoint(IMPORTED, { ...ARK, ...D })
    if (!own.ok) throw new Error('第一步该成功')
    expect(readPatchRelayProvider(own.text)).toEqual({ ok: true, found: false })
  })

  it('他自己配过 llm-pi-ai → 整件不做', () => {
    const his = `${OURS}- id: llm-pi-ai\n  config:\n    providers:\n      my-own:\n        baseURL: https://他的/v1\n`
    const out = patchForOwnEndpoint(his, { ...ARK, ...D })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).not.toMatch(/\.yml|settings\.yaml|~\/\.dsh/)
  })

  it('模型名 / 地址里有会破坏纯量的字符 → 拒写,不硬塞进 YAML', () => {
    const out = patchForOwnEndpoint(IMPORTED, { ...D, baseUrl: ARK.baseUrl, model: 'a: b #c' })
    expect(out.ok).toBe(false)
  })
})

/**
 * 「地址保持官方、只换模型名」(2026-10-23 退修,Codex):provider 那一行照
 * patchForOwnKey 的回滚语义,model 行换成他填的;不建 workbench-own,别人的行一个字节不动。
 */
describe('官方地址只换模型名(2026-10-23 退修)', () => {
  it('provider 回 deepseek-official,model 行换成他填的;中转路由留着不删', () => {
    const out = patchForOwnModel(IMPORTED, { ...D, model: 'my-finetune-1' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(readPatchDefaultModel(out.text)).toEqual({ provider: 'deepseek-official', model: 'my-finetune-1' })
    // 中转那一段留着(下次切回来不用重写),workbench-own 不存在。
    expect(readPatchRelayProvider(out.text)).toMatchObject({ found: true })
    expect(readPatchOwnProvider(out.text)).toEqual({ ok: true, found: false })
    expect(out.text).toContain('cookieMaxAgeDays: 3650')
  })

  it('切走之前是他自己的路由就回到那一条,model 照他填的', () => {
    const out = patchForOwnModel(IMPORTED, { ...D, previousProvider: '他自己的路由', model: 'my-finetune-1' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(readPatchDefaultModel(out.text)).toEqual({ provider: '他自己的路由', model: 'my-finetune-1' })
  })

  it('幂等:第二遍一个字不改', () => {
    const first = patchForOwnModel(IMPORTED, { ...D, model: 'my-finetune-1' })
    if (!first.ok) throw new Error('第一步该成功')
    const second = patchForOwnModel(first.text, { ...D, model: 'my-finetune-1' })
    expect(second).toEqual({ ok: true, text: first.text, changed: false })
  })

  it('模型名不安全:拒写,不硬塞进 YAML', () => {
    expect(patchForOwnModel(IMPORTED, { ...D, model: 'a: b #c' }).ok).toBe(false)
  })
})

describe('老机器上我们那段补齐', () => {
  it('补上 pro 与 input,provider 一个字不动', () => {
    const old = `${OURS}- id: llm-pi-ai\n  config:\n    providers:\n      workbench-relay:\n        baseURL: https://api.aibooo.cn/v1\n        apiKeyEnv: WORKBENCH_RELAY_TOKEN\n        models:\n          - id: deepseek-v4-flash\n`
      + '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash\n'
    const out = patchUpgradeManagedRelay(old)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.changed).toBe(true)
    expect(readPatchRelayProvider(out.text)).toMatchObject({
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      baseUrl: 'https://api.aibooo.cn/v1',
    })
    expect(out.text).toContain('input: [text, image]')
    // 他切回了自己的 Key,不许被我们切回中转
    expect(readPatchDefaultModel(out.text)?.provider).toBe('deepseek-official')
    expect(patchUpgradeManagedRelay(out.text).ok).toBe(true)
    const again = patchUpgradeManagedRelay(out.text)
    if (again.ok) expect(again.changed).toBe(false)
  })

  it('压根没有那一段 → 不补(补了等于替他做了选择)', () => {
    expect(patchUpgradeManagedRelay(OURS)).toEqual({ ok: true, text: OURS, changed: false })
  })

  it('他自己配的 llm-pi-ai 一个字不动,而且不报错(开机时跑的,不该吓人)', () => {
    const his = `${OURS}- id: llm-pi-ai\n  config:\n    providers:\n      my-own:\n        baseURL: https://他的/v1\n`
    expect(patchUpgradeManagedRelay(his)).toEqual({ ok: true, text: his, changed: false })
  })
})

describe('★ 中转不认 developer 角色(2026-10-01 Air 诊断包 095718)', () => {
  /**
   * Air 上 09-29 晚起,事务官每一件都 422:「messages[0].role: unknown variant `developer`」。
   * pi-ai 看 baseURL 认不出背后是 DeepSeek(是 api.aibooo.cn),就当它支持 developer 角色;
   * 选中的模型一开思考,系统提示就用 developer 发,DeepSeek 拒掉整条请求。
   */
  it('我们写的那段明说 supportsDeveloperRole: false', () => {
    const out = patchForRelay(OURS, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text).toMatch(/\n\s+supportsDeveloperRole: false\n/)
    expect(readPatchRelayProvider(out.text)).toMatchObject({ compat: { supportsDeveloperRole: 'false' } })
  })

  it('★ 老机器上那段缺这一项 → 开机那一下补上(模型与 provider 一个字不动)', () => {
    const fresh = patchForRelay(OURS, { baseUrl: 'https://api.aibooo.cn/v1', ...D })
    if (!fresh.ok) throw new Error(fresh.error)
    const old = fresh.text.replace(/\n\s+supportsDeveloperRole: false/, '')
    expect(old).not.toContain('supportsDeveloperRole')
    const out = patchUpgradeManagedRelay(old)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.changed).toBe(true)
    expect(readPatchRelayProvider(out.text)).toMatchObject({ compat: { supportsDeveloperRole: 'false' } })
    expect(readPatchDefaultModel(out.text)).toEqual(readPatchDefaultModel(old))
    const again = patchUpgradeManagedRelay(out.text)
    expect(again).toEqual({ ok: true, text: out.text, changed: false })
  })
})

describe('写完自己再核一遍', () => {
  it('每一次写完:文档仍认得、别人的行逐字节相同、自己那两行读回来就是写进去的', () => {
    const out = patchForRelay(IMPORTED.replace('provider: workbench-relay', 'provider: deepseek-official'), {
      baseUrl: 'https://api.aibooo.cn/v1', ...D,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(parseProfilePatch(out.text).ok).toBe(true)
    // 我们只动 agent-default-model 与 llm-pi-ai;别的行原样
    for (const keep of ['- id: client-connection', 'cookieMaxAgeDays: 3650', '- id: ui-settings-general', 'welcomeNoticeVersion: 2026-08-13.1']) {
      expect(out.text).toContain(keep)
    }
    expect(out.text).toContain('trustedHosts: !!js ctx.webRuntime.trustedHosts')
  })
})
