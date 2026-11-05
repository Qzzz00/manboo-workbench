// @vitest-environment node
/**
 * 「DSH 的设置在哪」这一处抽象(2026-09-26,卡 U1b)。
 *
 * 0.1.7 把 `settings.yaml` 收进了 profile 的补丁层,而用户机器上两代运行时都可能在跑
 * (热更新换运行时是分步做的,还有回滚)。所以模型面板、令牌下发、读当前模型三处
 * **都不许自己拼路径**,一律经这一份:它按装着的运行时决定读写哪儿。
 *
 * 这一份用**真临时目录 + 真文件系统**跑(0904 事故纪律:递归删除只落在本用例前缀下的
 * mktemp 沙箱里),因为要验的正是"到底写到了哪个文件、另一个文件有没有被碰"。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDshSettingsStore, DSH_PATCH_SETTINGS_SINCE, dshSettingsPlaceOf,
} from '../src/server/dshSettingsStore.ts'
import { LOCKED_DSH_VERSION, setupPaths } from '../src/server/setup/paths.ts'
import { readPatchDefaultModel, readPatchOwnProvider, readPatchRelayProvider } from '../src/server/dshProfilePatch.ts'
import { DSH_OWN_KEY_ENV } from '../src/server/dshModelSettings.ts'
import { readAgentDefaultModel } from '../src/server/dshModelSettings.ts'

const BOX_PREFIX = join(tmpdir(), 'wb-dsh-settings-store-')
const boxes: string[] = []
afterEach(() => {
  while (boxes.length) {
    const box = boxes.pop() as string
    if (!box.startsWith(BOX_PREFIX) || box.slice(BOX_PREFIX.length).includes('/')) continue
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

const RELAY = 'https://api.aibooo.cn/v1'

/** 0.1.2 那一代:设置住在 `settings.yaml` 里。 */
const LEGACY_SETTINGS = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash-vision-exp
`

/** 登录台建出来的补丁层(升级前后都是这个底子)。 */
const PATCH = `# 工作台登录台生成(可以继续往下加别的补丁)。

- insert:
    - id: ben-workbench
      name: '@ben/dsh-workbench'

- id: client-connection
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
    cookieMaxAgeDays: 3650
`

/** 升级那一刻:0.1.7 把我们播的那份收进补丁层之后的样子(真灰度跑里逐字抄回来的,见 dsh-profile-patch.test.ts 文件头)。 */
const PATCH_IMPORTED = `${PATCH}
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

interface Machine {
  home: string
  dshHome: string
  settings: string
  imported: string
  patch: string
}

/**
 * 摆一台机器出来。`runtime` 是装着的 dsh 版本(undefined = 读不到,例如还没装完);
 * `settings` / `patch` / `imported` 给了就写那个文件。
 */
function machine(options: {
  runtime?: string
  settings?: string
  patch?: string
  imported?: string
  homePatch?: string
}): Machine {
  const home = mkdtempSync(BOX_PREFIX)
  boxes.push(home)
  const paths = setupPaths({ home })
  mkdirSync(paths.profileDir, { recursive: true })
  if (options.runtime !== undefined) {
    mkdirSync(dirname(paths.runtimeDshPackageJson), { recursive: true })
    writeFileSync(paths.runtimeDshPackageJson, `${JSON.stringify({ name: '@deepseek-ai/dsh', version: options.runtime })}\n`)
  }
  if (options.settings !== undefined) writeFileSync(paths.dshSettingsYaml, options.settings)
  if (options.imported !== undefined) writeFileSync(paths.dshSettingsImported, options.imported)
  if (options.patch !== undefined) writeFileSync(paths.profilePatchYml, options.patch)
  if (options.homePatch !== undefined) writeFileSync(`${paths.dshHome}/cordis.patch.yml`, options.homePatch)
  return {
    home,
    dshHome: paths.dshHome,
    settings: paths.dshSettingsYaml,
    imported: paths.dshSettingsImported,
    patch: paths.profilePatchYml,
  }
}

function store(box: Machine) {
  return createDshSettingsStore({ dshHome: box.dshHome })
}

describe('判据:这台机器上 DSH 的设置在哪', () => {
  it('`settings.yaml` 还在 → 就写它(下次启动 0.1.7 会把它整段收进补丁层,先写补丁层等于写了会被盖掉的地方)', () => {
    expect(dshSettingsPlaceOf({
      runtimeVersion: '0.1.7-rc.2', settingsFileExists: true, importedExists: true,
    }).generation).toBe('settings-file')
  })

  it('文件没了、装着的是 0.1.7 → 补丁层', () => {
    expect(dshSettingsPlaceOf({
      runtimeVersion: '0.1.7-rc.2', settingsFileExists: false, importedExists: true,
    }).generation).toBe('profile-patch')
  })

  it('文件没了、装着的还是 0.1.2 → 还是那个文件(回滚过的机器)', () => {
    expect(dshSettingsPlaceOf({
      runtimeVersion: '0.1.2-rc.1', settingsFileExists: false, importedExists: true,
    }).generation).toBe('settings-file')
  })

  it('版本读不到:有 `.imported` 就说明已经被收走过 → 补丁层', () => {
    expect(dshSettingsPlaceOf({ settingsFileExists: false, importedExists: true }).generation).toBe('profile-patch')
  })

  it('版本读不到、什么痕迹都没有 → 按我们锁着要装的那一版', () => {
    const got = dshSettingsPlaceOf({ settingsFileExists: false, importedExists: false }).generation
    expect(got).toBe(LOCKED_DSH_VERSION >= DSH_PATCH_SETTINGS_SINCE ? 'profile-patch' : 'settings-file')
  })

  it('判据只看前三段版本号,预发布后缀不参与(0.1.7-alpha 也算 0.1.7)', () => {
    expect(dshSettingsPlaceOf({
      runtimeVersion: '0.1.7-alpha.1', settingsFileExists: false, importedExists: false,
    }).generation).toBe('profile-patch')
    expect(dshSettingsPlaceOf({
      runtimeVersion: '0.1.6', settingsFileExists: false, importedExists: false,
    }).generation).toBe('settings-file')
  })

  it('路径与登录台那一份逐字相同(两处各拼一次迟早会不一样)', () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION })
    const paths = setupPaths({ home: box.home })
    expect(store(box).files()).toEqual({
      settings: paths.dshSettingsYaml,
      imported: paths.dshSettingsImported,
      patch: paths.profilePatchYml,
      homePatch: `${paths.dshHome}/cordis.patch.yml`,
      runtimePackageJson: paths.runtimeDshPackageJson,
    })
  })
})

describe('0.1.2 那一代(settings.yaml 形)', () => {
  it('读当前模型读的是那个文件', async () => {
    const box = machine({ runtime: '0.1.2-rc.1', settings: LEGACY_SETTINGS, patch: PATCH })
    await expect(store(box).readDefaultModel()).resolves.toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp',
    })
  })

  it('切到中转写回那个文件,补丁层一个字节不动', async () => {
    const box = machine({ runtime: '0.1.2-rc.1', settings: LEGACY_SETTINGS, patch: PATCH })
    const out = await store(box).applyRelay({ baseUrl: RELAY })
    expect(out).toMatchObject({ ok: true, changed: true, generation: 'settings-file' })
    const text = readFileSync(box.settings, 'utf8')
    expect(readAgentDefaultModel(text)?.provider).toBe('workbench-relay')
    expect(text).toContain('apiKeyEnv: WORKBENCH_RELAY_TOKEN')
    expect(readFileSync(box.patch, 'utf8')).toBe(PATCH)
  })

  it('那个文件压根不在 → 说人话、不新建,话里不出现文件名', async () => {
    const box = machine({ runtime: '0.1.2-rc.1', patch: PATCH })
    const out = await store(box).applyRelay({ baseUrl: RELAY })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).not.toMatch(/settings\.yaml|cordis|\.dsh|\.yml/)
    expect(existsSync(box.settings)).toBe(false)
  })
})

describe('0.1.7 那一代(补丁层形)', () => {
  it('读当前模型读的是补丁层那一行', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH_IMPORTED, imported: LEGACY_SETTINGS })
    await expect(store(box).readDefaultModel()).resolves.toEqual({
      provider: 'workbench-relay', model: 'deepseek-v4-flash-vision-exp',
    })
  })

  it('补丁层里还没写过那一行 → 退回上游缺省(不编一个数)', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH, imported: LEGACY_SETTINGS })
    await expect(store(box).readDefaultModel()).resolves.toEqual({
      provider: 'deepseek-official', model: 'deepseek-flash',
    })
  })

  it('切到中转写进补丁层,不去重建 settings.yaml', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH, imported: LEGACY_SETTINGS })
    const out = await store(box).applyRelay({ baseUrl: RELAY })
    expect(out).toMatchObject({ ok: true, changed: true, generation: 'profile-patch' })
    const text = readFileSync(box.patch, 'utf8')
    expect(readPatchDefaultModel(text)?.provider).toBe('workbench-relay')
    expect(readPatchRelayProvider(text)).toMatchObject({ found: true, baseUrl: RELAY })
    expect(existsSync(box.settings)).toBe(false)
  })

  it('★ 升级那一刻(段刚被收进补丁层、选的就是中转):一个字都不写,他选过的模型还在', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH_IMPORTED, imported: LEGACY_SETTINGS })
    const out = await store(box).applyRelay({ baseUrl: RELAY })
    expect(out).toMatchObject({ ok: true, changed: false })
    expect(readFileSync(box.patch, 'utf8')).toBe(PATCH_IMPORTED)
    // 没写 = 没备份(不该每次开机都堆一份)
    expect(readdirSync(dirname(box.patch)).filter(one => one.includes('bak-workbench'))).toEqual([])
  })

  it('切回自己的 Key:provider 指回去,模型与我们那条路由都留着', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH_IMPORTED })
    const out = await store(box).applyOwnKey()
    expect(out).toMatchObject({ ok: true, changed: true, generation: 'profile-patch' })
    const text = readFileSync(box.patch, 'utf8')
    expect(readPatchDefaultModel(text)).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp',
    })
    expect(readPatchRelayProvider(text)).toMatchObject({ found: true })
  })

  it('切到自己接的端点(2026-10-23,卡「事务官换Key」):两代都写成 workbench-own', async () => {
    const ARK = { baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: 'deepseek-v4-flash' }
    // 补丁层这一代。
    const patched = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH_IMPORTED })
    const out = await store(patched).applyOwnKey(undefined, ARK)
    expect(out).toMatchObject({ ok: true, changed: true, generation: 'profile-patch' })
    const text = readFileSync(patched.patch, 'utf8')
    expect(readPatchDefaultModel(text)).toEqual({ provider: 'workbench-own', model: ARK.model })
    expect(readPatchOwnProvider(text)).toMatchObject({ found: true, baseUrl: ARK.baseUrl, model: ARK.model })
    // settings.yaml 那一代。
    const legacy = machine({ runtime: '0.1.2-rc.1', settings: LEGACY_SETTINGS, patch: PATCH })
    const out2 = await store(legacy).applyOwnKey(undefined, ARK)
    expect(out2).toMatchObject({ ok: true, changed: true, generation: 'settings-file' })
    const text2 = readFileSync(legacy.settings, 'utf8')
    expect(readAgentDefaultModel(text2)).toEqual({ provider: 'workbench-own', model: ARK.model })
    expect(text2).toContain(`baseURL: ${ARK.baseUrl}`)
    expect(text2).toContain(`apiKeyEnv: ${DSH_OWN_KEY_ENV}`)
    expect(text2).not.toContain('sk-')
  })

  it('官方地址只换模型名(2026-10-23 退修):两代都只动 model 行,provider 回滚,不建 workbench-own', async () => {
    // 补丁层这一代。
    const patched = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH_IMPORTED })
    const out = await store(patched).applyOwnKey(undefined, { model: 'my-finetune-1' })
    expect(out).toMatchObject({ ok: true, changed: true, generation: 'profile-patch' })
    const text = readFileSync(patched.patch, 'utf8')
    expect(readPatchDefaultModel(text)).toEqual({ provider: 'deepseek-official', model: 'my-finetune-1' })
    expect(readPatchOwnProvider(text)).toEqual({ ok: true, found: false })
    // settings.yaml 那一代。
    const legacy = machine({ runtime: '0.1.2-rc.1', settings: LEGACY_SETTINGS, patch: PATCH })
    const out2 = await store(legacy).applyOwnKey(undefined, { model: 'my-finetune-1' })
    expect(out2).toMatchObject({ ok: true, changed: true, generation: 'settings-file' })
    expect(readAgentDefaultModel(readFileSync(legacy.settings, 'utf8')))
      .toEqual({ provider: 'deepseek-official', model: 'my-finetune-1' })
  })

  it('补丁层文件还不存在(profile 刚建出来)→ 建一份写进去', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION })
    const out = await store(box).applyRelay({ baseUrl: RELAY })
    expect(out).toMatchObject({ ok: true, changed: true, generation: 'profile-patch' })
    expect(readPatchRelayProvider(readFileSync(box.patch, 'utf8'))).toMatchObject({ found: true })
  })

  it('写之前先留一份备份,改完补丁层里读回来的就是新的', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH_IMPORTED })
    await store(box).applyOwnKey()
    const backups = readdirSync(dirname(box.patch)).filter(one => one.includes('bak-workbench'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dirname(box.patch), backups[0] as string), 'utf8')).toBe(PATCH_IMPORTED)
  })
})

describe('换代那一刻不重复写', () => {
  it('运行时已经换成 0.1.7、DSH 还没重启(settings.yaml 还在)→ 写那个文件,补丁层不碰', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION, settings: LEGACY_SETTINGS, patch: PATCH })
    const out = await store(box).applyRelay({ baseUrl: RELAY })
    expect(out).toMatchObject({ ok: true, changed: true, generation: 'settings-file' })
    expect(readFileSync(box.patch, 'utf8')).toBe(PATCH)
    expect(readAgentDefaultModel(readFileSync(box.settings, 'utf8'))?.provider).toBe('workbench-relay')
  })

  it('两代各写一次不会互相覆盖:先在 0.1.2 上切,升级后再切,模型仍是他选的那个', async () => {
    const box = machine({ runtime: '0.1.2-rc.1', settings: LEGACY_SETTINGS, patch: PATCH })
    await store(box).applyRelay({ baseUrl: RELAY })
    const chosen = readAgentDefaultModel(readFileSync(box.settings, 'utf8'))?.model
    expect(chosen).toBe('deepseek-v4-flash-vision-exp')
    // 升级:0.1.7 启动把它收进补丁层(这里照上游的搬法手工搬一次)
    writeFileSync(box.imported, readFileSync(box.settings, 'utf8'))
    rmSync(box.settings)
    writeFileSync(box.patch, PATCH_IMPORTED)
    writeFileSync(`${box.dshHome}/runtime/node_modules/@deepseek-ai/dsh/package.json`,
      `${JSON.stringify({ version: LOCKED_DSH_VERSION })}\n`)
    const after = await store(box).applyRelay({ baseUrl: RELAY })
    expect(after).toMatchObject({ ok: true, changed: false })
    await expect(store(box).readDefaultModel()).resolves.toMatchObject({ model: chosen })
  })
})

describe('写坏了宁可不写', () => {
  it('补丁层认不出写法 → 拒写、文件一个字节不动、话里不出现文件名', async () => {
    const broken = '- id: agent-default-model\n\tconfig: 1\n'
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: broken })
    const out = await store(box).applyRelay({ baseUrl: RELAY })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).not.toMatch(/cordis|\.yml|settings\.yaml|~\/\.dsh/)
    expect(readFileSync(box.patch, 'utf8')).toBe(broken)
    expect(readdirSync(dirname(box.patch)).filter(one => one.includes('bak-workbench'))).toEqual([])
  })

  it('他自己配过 llm-pi-ai → 整件不做', async () => {
    const his = `${PATCH}- id: llm-pi-ai\n  config:\n    providers:\n      my-own:\n        baseURL: https://他的/v1\n`
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: his })
    const out = await store(box).applyRelay({ baseUrl: RELAY })
    expect(out.ok).toBe(false)
    expect(readFileSync(box.patch, 'utf8')).toBe(his)
  })

  it('家那一层的补丁压着 profile 这一层的同一行 → 写了也没用,所以不写,如实说一句', async () => {
    const box = machine({
      runtime: LOCKED_DSH_VERSION, patch: PATCH,
      homePatch: '- id: agent-default-model\n  config:\n    provider: x\n    model: y\n',
    })
    const out = await store(box).applyRelay({ baseUrl: RELAY })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).not.toMatch(/cordis|\.yml/)
    expect(readFileSync(box.patch, 'utf8')).toBe(PATCH)
  })
})

describe('老机器上我们那段补齐(开机时那一下)', () => {
  it('两代都走同一处抽象:补丁层这一代补在补丁层里', async () => {
    const thin = `${PATCH}- id: llm-pi-ai\n  config:\n    providers:\n      workbench-relay:\n        baseURL: ${RELAY}\n        apiKeyEnv: WORKBENCH_RELAY_TOKEN\n        models:\n          - id: deepseek-v4-flash\n`
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: thin })
    const out = await store(box).upgradeManagedRelay()
    expect(out).toMatchObject({ ok: true, changed: true, generation: 'profile-patch' })
    expect(readPatchRelayProvider(readFileSync(box.patch, 'utf8'))).toMatchObject({
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    })
  })

  it('0.1.2 那一代仍补在 settings.yaml 里', async () => {
    const old = `${LEGACY_SETTINGS}llm-pi-ai:\n  # managed-by: workbench-model-panel\n  providers:\n    workbench-relay:\n      baseURL: ${RELAY}\n      models:\n        - id: deepseek-v4-flash\n`
    const box = machine({ runtime: '0.1.2-rc.1', settings: old, patch: PATCH })
    const out = await store(box).upgradeManagedRelay()
    expect(out).toMatchObject({ ok: true, changed: true, generation: 'settings-file' })
    expect(readFileSync(box.settings, 'utf8')).toContain('deepseek-v4-pro')
    expect(readFileSync(box.patch, 'utf8')).toBe(PATCH)
  })

  it('什么都没有 → 不是错,也不写', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH })
    await expect(store(box).upgradeManagedRelay()).resolves.toMatchObject({ ok: true, changed: false })
    expect(readFileSync(box.patch, 'utf8')).toBe(PATCH)
  })
})

describe('liveReconcile: 宿主注入的在线重载协调 (2026-10-23 卡「换Key运行时」)', () => {
  it('补丁层写入成功后调用并 await liveReconcile', async () => {
    let reconciled = false
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH_IMPORTED })
    const logs: string[] = []
    const s = createDshSettingsStore({
      dshHome: box.dshHome,
      log: line => logs.push(line),
      liveReconcile: async () => {
        reconciled = true
      },
      liveDocPath: () => `${box.dshHome}/profiles/web/cordis.patch.yml`,
    })
    const out = await s.applyOwnKey(undefined, { baseUrl: 'http://127.0.0.1:8893/v1', model: 'qa-brain-b' })
    expect(out).toMatchObject({ ok: true, changed: true, generation: 'profile-patch' })
    expect(reconciled).toBe(true)
    expect(logs.some(l => l.includes('sameDocPath=true'))).toBe(true)
  })

  it('liveReconcile 失败时回 ok:false，不静默算成功', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH_IMPORTED })
    const logs: string[] = []
    const s = createDshSettingsStore({
      dshHome: box.dshHome,
      log: line => logs.push(line),
      liveReconcile: async () => {
        throw new Error('Loader rejected')
      },
    })
    const out = await s.applyOwnKey(undefined, { baseUrl: 'http://127.0.0.1:8893/v1', model: 'qa-brain-b' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('热加载失败')
  })
})

describe('live 失败的持久化边界', () => {
  it('Loader 拒绝后保留旧文件，同一 B 重试仍需在线应用', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH_IMPORTED })
    let attempts = 0
    const s = createDshSettingsStore({ dshHome: box.dshHome, liveDocPath: () => box.patch,
      liveReconcile: async () => { attempts += 1; throw new Error('Loader rejected') },
    })
    expect((await s.applyOwnKey(undefined, { baseUrl: 'http://127.0.0.1:8893/v1', model: 'qa-brain-b' })).ok).toBe(false)
    expect(readFileSync(box.patch, 'utf8')).toBe(PATCH_IMPORTED)
    expect((await s.applyOwnKey(undefined, { baseUrl: 'http://127.0.0.1:8893/v1', model: 'qa-brain-b' })).ok).toBe(false)
    expect(attempts).toBe(2)
  })
  it('在线 editor 路径不符时拒绝，不先写错 profile', async () => {
    const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH_IMPORTED })
    const s = createDshSettingsStore({ dshHome: box.dshHome, liveDocPath: () => '/other/profile/cordis.patch.yml', liveReconcile: async () => {} })
    expect((await s.applyOwnKey()).ok).toBe(false)
    expect(readFileSync(box.patch, 'utf8')).toBe(PATCH_IMPORTED)
  })
  it('legacy 文件仍在且要求在线应用时，诚实拒绝纯写盘', async () => {
    const box = machine({ runtime: '0.1.7-rc.2', settings: LEGACY_SETTINGS })
    const s = createDshSettingsStore({ dshHome: box.dshHome, liveReconcile: async () => {} })
    expect((await s.applyRelay({ baseUrl: RELAY })).ok).toBe(false)
    expect(readFileSync(box.settings, 'utf8')).toBe(LEGACY_SETTINGS)
  })
})

it('磁盘已经是相同 B 也不能跳过在线应用', async () => {
  const box = machine({ runtime: LOCKED_DSH_VERSION, patch: PATCH_IMPORTED })
  await store(box).applyOwnKey(undefined, { baseUrl: 'http://127.0.0.1:8893/v1', model: 'qa-brain-b' })
  const before = readFileSync(box.patch, 'utf8')
  const online = createDshSettingsStore({ dshHome: box.dshHome, liveDocPath: () => box.patch,
    liveReconcile: async () => { throw new Error('runtime still on A') },
  })
  expect((await online.applyOwnKey(undefined, { baseUrl: 'http://127.0.0.1:8893/v1', model: 'qa-brain-b' })).ok).toBe(false)
  expect(readFileSync(box.patch, 'utf8')).toBe(before)
})
