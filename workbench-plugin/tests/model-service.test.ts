// @vitest-environment node
//
// 「切一次,三处都跟着变」那条链路。DSH 那两个文件用的是**临时 HOME**,
// 真的 ~/.dsh 一个字节都不碰(0904 家目录事故之后的规矩)。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveCredential } from '../src/server/credentials.ts'
import { loadModelConfig, NO_RELAY_NOTE } from '../src/server/modelConfig.ts'
import { readPatchDefaultModel, readPatchOwnProvider, readPatchRelayProvider } from '../src/server/dshProfilePatch.ts'

/** 唯一源夹具(workbench-plugin/tests/fixtures/own-endpoint-cases.json):DSH 侧的期望也读这里,不手抄。 */
function fixtureCase(namePart: string): { model_json: string, expect: { base_url: string, model: string } } {
  const cases = (JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'own-endpoint-cases.json'), 'utf8')) as {
    cases: { name: string, model_json: string, expect: { base_url: string, model: string } }[]
  }).cases
  const found = cases.find(one => one.name.includes(namePart))
  if (found === undefined) throw new Error(`夹具里没有 ${namePart} 这个 case`)
  return found
}
import { createModelService } from '../src/server/modelService.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const SETTINGS = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash-vision-exp
`

/**
 * 用例跑的是开源缺省(构建不带中转,src/buildEndpoints.ts),所以「接了中转」的那批用例要把地址写进 model.json ——
 * 就像我们的构建(地址编在包里)或自建中转的人(填在 model.json)那样。`relay: null` = 零服务器档。
 */
const RELAY = 'https://relay.test'

async function sandbox(options: { settings?: string, env?: string, relay?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-modelsvc-'))
  dirs.push(root)
  const dshHome = join(root, '.dsh')
  await mkdir(join(dshHome, 'workbench'), { recursive: true })
  const relay = options.relay === undefined ? RELAY : options.relay
  if (relay !== null) await writeFile(join(dshHome, 'workbench', 'model.json'), JSON.stringify({ relay_url: relay }))
  if (options.settings !== undefined) await writeFile(join(dshHome, 'settings.yaml'), options.settings)
  if (options.env !== undefined) await writeFile(join(dshHome, '.env'), options.env)
  return {
    root,
    dshHome,
    modelFile: join(dshHome, 'workbench', 'model.json'),
    credentialFile: join(dshHome, 'workbench', 'credentials.json'),
    accountFile: join(dshHome, 'workbench', 'account.json'),
    settingsFile: join(dshHome, 'settings.yaml'),
    envFile: join(dshHome, '.env'),
  }
}

/** 一个会发令牌、会报用量的假中转。记下它收到过什么。 */
function fakeRelay(options: { token?: string, registerStatus?: number, used?: number } = {}) {
  const seen: { url: string, body?: unknown }[] = []
  const impl: typeof fetch = async (url, init) => {
    const href = String(url)
    seen.push({ url: href, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
    if (href.endsWith('/register-device')) {
      if (options.registerStatus !== undefined && options.registerStatus >= 400) {
        return new Response(JSON.stringify({ error: { message: '领取太频繁了,过一会儿再试。' } }), { status: options.registerStatus })
      }
      return new Response(JSON.stringify({ token: options.token ?? 'wb_issued' }), { status: 201 })
    }
    if (href.endsWith('/usage')) {
      const used = options.used ?? 1200
      return new Response(JSON.stringify({
        day: '2026-09-17', used_tokens: used, daily_token_limit: 50_000, remaining_tokens: 50_000 - used,
      }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  return { impl, seen }
}

describe('没接中转(零服务器档)', () => {
  function serviceIn(box: Awaited<ReturnType<typeof sandbox>>, relay: ReturnType<typeof fakeRelay>) {
    return createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      accountFile: box.accountFile, fetchImpl: relay.impl,
    })
  }

  it('缺省就是「用自己的 Key」,状态里说没接中转', async () => {
    const box = await sandbox({ settings: SETTINGS, relay: null })
    const status = await serviceIn(box, fakeRelay()).status()
    expect(status).toMatchObject({ mode: 'own', relay_url: '', relay_configured: false, ready: false })
  })

  it('切「用工作台提供的服务」:如实拒绝,一个包都不发,DSH 那一侧与 model.json 一个字节都不动', async () => {
    const box = await sandbox({ settings: SETTINGS, relay: null })
    const relay = fakeRelay()
    const result = await serviceIn(box, relay).update({ mode: 'relay' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain(NO_RELAY_NOTE)
    expect(relay.seen).toEqual([])
    expect(await readFile(box.settingsFile, 'utf8')).toBe(SETTINGS)
    await expect(stat(box.modelFile)).rejects.toThrow()
  })

  it('「重新接一次」同样拒绝', async () => {
    const box = await sandbox({ settings: SETTINGS, relay: null })
    const relay = fakeRelay()
    expect((await serviceIn(box, relay).reissue()).error).toContain(NO_RELAY_NOTE)
    expect(relay.seen).toEqual([])
  })

  it('注册 / 登录那一刻不自动去接,也不去挂账号', async () => {
    const box = await sandbox({ settings: SETTINGS, relay: null })
    const relay = fakeRelay()
    const result = await serviceIn(box, relay).autoSetup()
    expect(result).toMatchObject({ ok: true, attempted: false, skipped: 'no_relay' })
    expect(relay.seen).toEqual([])
  })

  it('通话要的设备令牌:不去领,说没接中转', async () => {
    const box = await sandbox({ relay: null })
    const relay = fakeRelay()
    expect(await serviceIn(box, relay).ensureDeviceToken()).toEqual({ ok: false, error: NO_RELAY_NOTE })
    expect(relay.seen).toEqual([])
  })

  it('自建中转:切的时候带上地址就接得上', async () => {
    const box = await sandbox({ settings: SETTINGS, relay: null })
    const relay = fakeRelay()
    const result = await serviceIn(box, relay).update({ mode: 'relay', relay_url: 'https://self.example' })
    expect(result.ok).toBe(true)
    expect(relay.seen[0]?.url).toBe('https://self.example/register-device')
  })
})

describe('第一次切到「用工作台提供的服务」', () => {
  it('领到令牌 → 写 model.json(0600)→ 写 DSH 的两个文件', async () => {
    const box = await sandbox({ settings: SETTINGS, env: 'DEEPSEEK_API_KEY=sk-ben\n' })
    const relay = fakeRelay()
    const service = createModelService({
      modelFile: box.modelFile,
      credentialFile: box.credentialFile,
      dshHome: box.dshHome,
      accountFile: box.accountFile,
      fetchImpl: relay.impl,
    })

    const result = await service.update({ mode: 'relay' })
    expect(result.ok).toBe(true)
    expect(result.status.mode).toBe('relay')
    expect(result.status.relay_token_configured).toBe(true)
    expect(result.status.ready).toBe(true)
    expect(result.status.usage?.used_tokens).toBe(1200)
    // 回给浏览器的东西里绝不能出现令牌。
    expect(JSON.stringify(result.status)).not.toContain('wb_issued')

    const saved = await loadModelConfig(box.modelFile)
    expect(saved.relay_token).toBe('wb_issued')
    expect((await stat(box.modelFile)).mode & 0o777).toBe(0o600)

    const settings = await readFile(box.settingsFile, 'utf8')
    expect(settings).toContain('provider: workbench-relay')
    expect(settings).toContain('apiKeyEnv: WORKBENCH_RELAY_TOKEN')
    // 他自己的段原样。
    expect(settings).toContain('welcomeNoticeVersion: 2026-08-13.1')

    const env = await readFile(box.envFile, 'utf8')
    expect(env).toContain('DEEPSEEK_API_KEY=sk-ben')
    expect(env).toContain('WORKBENCH_RELAY_TOKEN=wb_issued')

    // 改他的 settings.yaml 之前留了一份备份。
    const files = await readFile(box.settingsFile, 'utf8')
    expect(files.length).toBeGreaterThan(0)

    /**
     * 要重启一次才生效 —— 这句话要说出来,但 2026-09-18 起**不再让用户自己去终端里跑那行命令**
     * (任务卡:不让用户碰终端)。重启由工作台自己做,所以这里钉的是"说了要重启、没甩出命令"。
     */
    expect(result.hints.join('\n')).toContain('重启')
    expect(result.hints.join('\n')).not.toContain('launchctl')
    // 而"要重启"这件事本身是一个字段,不是一句要去认的字符串。
    expect(result.dsh_restart_required).toBe(true)
  })

  it('领第二次不会再领 —— 已经有令牌就不重领', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const relay = fakeRelay()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: relay.impl,
    })
    await service.update({ mode: 'relay' })
    await service.update({ mode: 'relay' })
    expect(relay.seen.filter(s => s.url.endsWith('/register-device')).length).toBe(1)
  })

  it('「重新接一次」会真的再领一把', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const relay = fakeRelay()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: relay.impl,
    })
    await service.update({ mode: 'relay' })
    await service.reissue()
    expect(relay.seen.filter(s => s.url.endsWith('/register-device')).length).toBe(2)
  })

  it('账号名从 account.json 来;没有那个文件也能用(退回本机名字)', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const relay = fakeRelay()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      accountFile: box.accountFile, fetchImpl: relay.impl,
    })
    await service.update({ mode: 'relay' })
    const first = relay.seen.find(s => s.url.endsWith('/register-device'))
    expect((first?.body as { account: string }).account).toMatch(/^local-/)

    // 账号卡落地之后:文件里有名字,重领时就用它。
    await writeFile(box.accountFile, JSON.stringify({ username: '小李' }))
    const box2 = await sandbox({ settings: SETTINGS })
    await writeFile(box2.accountFile, JSON.stringify({ username: '小李' }))
    const relay2 = fakeRelay()
    const service2 = createModelService({
      modelFile: box2.modelFile, credentialFile: box2.credentialFile, dshHome: box2.dshHome,
      accountFile: box2.accountFile, fetchImpl: relay2.impl,
    })
    await service2.update({ mode: 'relay' })
    expect((relay2.seen[0]?.body as { account: string }).account).toBe('小李')
  })

  it('领不到令牌:model.json 照样写下去(mode 已经切了),并如实说一句', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const relay = fakeRelay({ registerStatus: 429 })
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: relay.impl,
    })
    const result = await service.update({ mode: 'relay' })
    expect(result.ok).toBe(true)
    expect(result.status.ready).toBe(false)
    expect(result.hints.join('\n')).toContain('领取太频繁')
    expect((await loadModelConfig(box.modelFile)).mode).toBe('relay')
  })
})

describe('切回「用自己的 DeepSeek Key」', () => {
  it('provider 指回 deepseek-official,令牌从 .env 里收走', async () => {
    const box = await sandbox({ settings: SETTINGS, env: 'DEEPSEEK_API_KEY=sk-ben\n' })
    const relay = fakeRelay()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: relay.impl,
    })
    await service.update({ mode: 'relay' })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-ben-own')

    const back = await service.update({ mode: 'own' })
    expect(back.ok).toBe(true)
    expect(back.status.mode).toBe('own')
    expect(back.status.own_key_configured).toBe(true)
    expect(back.status.ready).toBe(true)

    const settings = await readFile(box.settingsFile, 'utf8')
    expect(settings).toContain('provider: deepseek-official')
    const env = await readFile(box.envFile, 'utf8')
    expect(env).not.toContain('WORKBENCH_RELAY_TOKEN')
    expect(env).toContain('DEEPSEEK_API_KEY=sk-ben')

    // 令牌还留在 model.json 里,切回来时不用再领一次。
    expect((await loadModelConfig(box.modelFile)).relay_token).toBe('wb_issued')
  })

  it('切成 own 但没填 Key:ready=false,界面据此提示去填', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: fakeRelay().impl,
    })
    const result = await service.update({ mode: 'own' })
    expect(result.status.ready).toBe(false)
    expect(result.status.own_key_configured).toBe(false)
  })
})

describe('DSH 那边出状况时', () => {
  it('DSH 那侧压根没有设置:工作台与工人照切,只多一句人话(2026-09-26 起话里不出现文件名)', async () => {
    const box = await sandbox({})
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: fakeRelay().impl,
    })
    const result = await service.update({ mode: 'relay' })
    expect(result.ok).toBe(true)
    expect(result.status.ready).toBe(true)
    const said = result.hints.join('\n')
    expect(said).toContain('事务官')
    expect(said).not.toMatch(/settings\.yaml|cordis|\.yml/)
  })

  it('他自己配过 llm-pi-ai:一个字不动,如实说明', async () => {
    const his = `${SETTINGS}llm-pi-ai:
  providers:
    mine:
      api: openai-completions
      baseURL: https://我自己的/v1
      apiKeyEnv: MY_KEY
      models:
        - id: whatever
`
    const box = await sandbox({ settings: his })
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: fakeRelay().impl,
    })
    const result = await service.update({ mode: 'relay' })
    expect(result.ok).toBe(true)
    expect(await readFile(box.settingsFile, 'utf8')).toBe(his)
    const said = result.hints.join('\n')
    expect(said).toContain('你自己配过的')
    expect(said).not.toMatch(/settings\.yaml|cordis|\.yml|llm-pi-ai/)
  })

  it('dshHome 不传就整块不碰 DSH', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, fetchImpl: fakeRelay().impl,
    })
    await service.update({ mode: 'relay' })
    expect(await readFile(box.settingsFile, 'utf8')).toBe(SETTINGS)
  })
})

describe('给别处用的 endpoint()', () => {
  it('relay 时给中转地址与令牌;own 时给官方与他的 Key', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: fakeRelay().impl,
    })
    await service.update({ mode: 'relay' })
    const relayEndpoint = await service.endpoint()
    expect(relayEndpoint.mode).toBe('relay')
    expect(relayEndpoint.key).toBe('wb_issued')

    await saveCredential(box.credentialFile, 'deepseek', 'sk-own')
    await service.update({ mode: 'own' })
    const ownEndpoint = await service.endpoint()
    expect(ownEndpoint).toEqual({
      mode: 'own', baseUrl: 'https://api.deepseek.com/v1', key: 'sk-own', model: 'deepseek-v4-flash', ready: true,
    })
  })
})

describe('用量的节流', () => {
  it('连着问几次只真的问一次(设置弹窗每次打开都会 GET)', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const relay = fakeRelay()
    let clock = 1_000
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      fetchImpl: relay.impl, now: () => clock,
    })
    await service.update({ mode: 'relay' })
    const before = relay.seen.filter(s => s.url.endsWith('/usage')).length
    await service.status()
    await service.status()
    expect(relay.seen.filter(s => s.url.endsWith('/usage')).length).toBe(before)
    // 过了窗口就再问一次。
    clock += 60_000
    await service.status()
    expect(relay.seen.filter(s => s.url.endsWith('/usage')).length).toBe(before + 1)
  })
})

/**
 * 注册/登录那一刻自动接(2026-09-18,决策记录同日「新用户零凭据」)。
 * 这几条钉的是**判据**与**同一份实现**:自动那条路写出来的文件,要和设置里点一下写出来的一模一样。
 */
describe('autoSetup:注册那一刻自动接', () => {
  it('新机器:什么都没有 → 领令牌、写 model.json、写 DSH 的两个文件', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const relay = fakeRelay()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      accountFile: box.accountFile, fetchImpl: relay.impl,
    })

    const result = await service.autoSetup()
    expect(result.attempted).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.status.ready).toBe(true)
    expect(result.status.relay_token_configured).toBe(true)
    expect(result.dsh_restart_required).toBe(true)
    expect((await loadModelConfig(box.modelFile)).relay_token).toBe('wb_issued')
    expect(await readFile(box.settingsFile, 'utf8')).toContain('provider: workbench-relay')
    expect(await readFile(box.envFile, 'utf8')).toContain('WORKBENCH_RELAY_TOKEN=wb_issued')
    // 回给浏览器/日志的东西里没有令牌。
    expect(JSON.stringify(result.status)).not.toContain('wb_issued')
  })

  it('他已经填了自己的 DeepSeek Key → 一个字都不动,也不去领', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-own')
    const relay = fakeRelay()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: relay.impl,
    })

    const result = await service.autoSetup()
    expect(result.attempted).toBe(false)
    expect(result.skipped).toBe('own_key')
    expect(result.ok).toBe(true)
    expect(relay.seen.length).toBe(0)
    // model.json 一个字节都不该变:「没动」就是真的没动(沙盒里只有那一格中转地址)。
    expect(await readFile(box.modelFile, 'utf8')).toBe(JSON.stringify({ relay_url: RELAY }))
    // 他的 settings.yaml 原样。
    expect(await readFile(box.settingsFile, 'utf8')).toBe(SETTINGS)
  })

  it('他自己选了「用我自己的账号」→ 不动(哪怕 Key 还没填好)', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const relay = fakeRelay()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: relay.impl,
    })
    await service.update({ mode: 'own' })
    const before = relay.seen.length

    const result = await service.autoSetup()
    expect(result.skipped).toBe('own_mode')
    expect(relay.seen.length).toBe(before)
  })

  it('已经接上了 → 不重领(否则每登一次就把上一把作废)', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const relay = fakeRelay()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: relay.impl,
    })
    await service.autoSetup()
    await service.autoSetup()
    expect(relay.seen.filter(s => s.url.endsWith('/register-device')).length).toBe(1)
  })

  it('第二次自动接时 .env 一个字节没变 → 不报「要重启」(否则每次登录都会重启一遍自己)', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const relay = fakeRelay()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: relay.impl,
    })
    expect((await service.autoSetup()).dsh_restart_required).toBe(true)
    // 第二次走的是 already_linked 那一支,压根不碰文件。
    expect((await service.autoSetup()).dsh_restart_required).toBeUndefined()
    // 就算强行再切一次 relay(文件已经是对的),也不该报要重启。
    expect((await service.update({ mode: 'relay' })).dsh_restart_required).toBeUndefined()
  })

  it('令牌是通话先领的(ensureDeviceToken,没碰 DSH)→ 登录时 autoSetup 照样把 .env 补上并要重启(09-23 自跑)', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const relay = fakeRelay()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: relay.impl,
    })
    expect(await service.ensureDeviceToken()).toEqual({ ok: true })
    await expect(stat(box.envFile)).rejects.toThrow()

    const result = await service.autoSetup()
    expect(result.dsh_restart_required).toBe(true)
    expect(await readFile(box.envFile, 'utf8')).toContain('WORKBENCH_RELAY_TOKEN=')
    // 只领了一次令牌:补 DSH 这一下不重领。
    expect(relay.seen.filter(s => s.url.endsWith('/register-device')).length).toBe(1)
    // 再来一次:文件已经对了,不再报要重启。
    expect((await service.autoSetup()).dsh_restart_required).toBeUndefined()
  })

  it('中转不给令牌:不抛、model.json 照写(mode 是对的),状态说 ready:false,原因是人话', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const relay = fakeRelay({ registerStatus: 429 })
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: relay.impl,
    })

    const result = await service.autoSetup()
    expect(result.attempted).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.status.ready).toBe(false)
    expect(result.status.relay_token_configured).toBe(false)
    expect(result.hints.join('\n')).toContain('领取太频繁')
    // 没领到就没往 .env 里写过东西,自然也不该重启。
    expect(result.dsh_restart_required).toBeUndefined()
  })
})

/**
 * 「只补令牌,别的一个字不动」(2026-09-21,通道凭据下发那张卡)。
 *
 * 令牌本来只为模型服务领,可它现在也是**取通道凭据的门票**。
 * 「用自己的 DeepSeek Key」那一支永远不会自动领(autoRelayDecision 第三条),
 * 于是那类用户会莫名其妙打不了电话 —— 而那跟他选哪家模型毫无关系。
 */
describe('ensureDeviceToken', () => {
  it('用着自己的 Key 也能领到令牌,而且 mode 与 DSH 的两个文件一个字没动', async () => {
    const box = await sandbox({ settings: SETTINGS, env: 'DEEPSEEK_API_KEY=sk-ben\n' })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-ben')
    await writeFile(box.modelFile, JSON.stringify({ mode: 'own', relay_url: 'https://relay.test', device_id: 'dev-1' }))
    const relay = fakeRelay({ token: 'wb_for_channel' })
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome, fetchImpl: relay.impl,
    })

    expect(await service.ensureDeviceToken()).toEqual({ ok: true })
    const saved = await loadModelConfig(box.modelFile)
    expect(saved.relay_token).toBe('wb_for_channel')
    // mode 还是他选的那个;DSH 那两个文件原样。
    expect(saved.mode).toBe('own')
    expect(await readFile(box.envFile, 'utf8')).toBe('DEEPSEEK_API_KEY=sk-ben\n')
    expect(await readFile(box.settingsFile, 'utf8')).toBe(SETTINGS)
  })

  it('已经有令牌就一个字节都不动(重领会把手机上正通着的那条当场断)', async () => {
    const box = await sandbox()
    await writeFile(box.modelFile, JSON.stringify({ mode: 'relay', relay_url: 'https://relay.test', device_id: 'dev-1', relay_token: 'wb_old' }))
    const relay = fakeRelay({ token: 'wb_new' })
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, fetchImpl: relay.impl,
    })

    expect(await service.ensureDeviceToken()).toEqual({ ok: true })
    expect((await loadModelConfig(box.modelFile)).relay_token).toBe('wb_old')
    expect(relay.seen).toEqual([])
  })

  it('领不到不抛,把那句人话交回去', async () => {
    const box = await sandbox()
    const relay = fakeRelay({ registerStatus: 429 })
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, fetchImpl: relay.impl,
    })

    const result = await service.ensureDeviceToken()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('领取太频繁')
  })
})

/**
 * ★ 新装机上引导卡在「缺凭据」(2026-10-01 Air 引导修复日志):DSH 10:48 起来,令牌 10:49 才写进 `.env`;
 * `.env` 是启动时读进快照的,而「挑没会话在跑时重启」又被引导自己那条会话挡住 —— 一直缺凭据。
 * 根治:令牌直接存进 DSH 的凭据服务(`ctx.credentials`,改了立即生效、优先于 .env),**不用重启**。
 */
/** 假 DSH 凭据服务:记下每一次 set/unset 的名字(**不记值**),可按名失败。 */
function fakeDshCredentials(options: { setFails?: boolean, setFailsOn?: string } = {}) {
  const saved = new Map<string, string>()
  const calls: string[] = []
  return {
    saved,
    calls,
    store: {
      set: async (name: string, value: string) => {
        calls.push(`set ${name}`)
        // setFails = 全部失败;setFailsOn = 只在这一名字的 set 上失败(2026-10-23 退修:两边独立判)。
        if (options.setFails === true || options.setFailsOn === name) throw new Error('shadowed by launch environment')
        saved.set(name, value)
      },
      unset: async (name: string) => { calls.push(`unset ${name}`); saved.delete(name) },
    },
  }
}

describe('令牌存进 DSH 的凭据服务(不用重启)', () => {

  it('★新机器自动接:令牌存进凭据服务,不报「要重启」;.env 照旧写一份兜底', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const creds = fakeDshCredentials()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      accountFile: box.accountFile, fetchImpl: fakeRelay().impl, dshCredentials: () => creds.store,
    })
    const result = await service.autoSetup()
    expect(result.status.ready).toBe(true)
    expect(creds.saved.get('WORKBENCH_RELAY_TOKEN')).toBe('wb_issued')
    expect(result.dsh_restart_required).toBeUndefined()
    expect(await readFile(box.envFile, 'utf8')).toContain('WORKBENCH_RELAY_TOKEN=wb_issued')
    expect(JSON.stringify(result)).not.toContain('wb_issued')
  })

  it('凭据服务存不进(被启动环境挡着等)→ 退回老路:报「要重启」', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const creds = fakeDshCredentials({ setFails: true })
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      accountFile: box.accountFile, fetchImpl: fakeRelay().impl, dshCredentials: () => creds.store,
    })
    expect((await service.autoSetup()).dsh_restart_required).toBe(true)
  })

  it('凭据服务还没接上(undefined)→ 老路', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      accountFile: box.accountFile, fetchImpl: fakeRelay().impl, dshCredentials: () => undefined,
    })
    expect((await service.autoSetup()).dsh_restart_required).toBe(true)
  })

  it('切回自己的 Key:凭据服务里那一份也收走', async () => {
    const box = await sandbox({ settings: SETTINGS, env: 'DEEPSEEK_API_KEY=sk-ben\n' })
    const creds = fakeDshCredentials()
    const service = createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      fetchImpl: fakeRelay().impl, dshCredentials: () => creds.store,
    })
    await service.update({ mode: 'relay' })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-ben-own')
    await service.update({ mode: 'own' })
    expect(creds.saved.has('WORKBENCH_RELAY_TOKEN')).toBe(false)
    expect(creds.calls).toContain('unset WORKBENCH_RELAY_TOKEN')
  })
})

/**
 * 「自己的 OpenAI 协议端点」(2026-10-23,卡「事务官换Key」):own 档填了 base_url 时,
 * DSH 那一侧写成 workbench-own 路由;Key 进 DSH 的凭据服务与 .env(0600),
 * 一行明文都不进 hints / 日志;切回中转时收走。默认官方那一档一个字不变。
 */
describe('own 档自己接的端点(2026-10-23)', () => {
  // 期望从唯一源夹具读(火山 case),不手抄。
  const ARK_FIXTURE = fixtureCase('火山方舟')
  const ARK = { own_base_url: ARK_FIXTURE.expect.base_url, own_model: ARK_FIXTURE.expect.model }

  function serviceIn(box: Awaited<ReturnType<typeof sandbox>>, relay: ReturnType<typeof fakeRelay>) {
    return createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      accountFile: box.accountFile, fetchImpl: relay.impl,
    })
  }

  it('update 收下地址与模型名:model.json 写进去,状态里读得出来', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const service = serviceIn(box, fakeRelay())
    const result = await service.update({ mode: 'own', ...ARK })
    expect(result.ok).toBe(true)
    expect(result.status).toMatchObject({
      mode: 'own', own_base_url: ARK.own_base_url, own_model: ARK.own_model, ready: false,
    })
    const onDisk = await loadModelConfig(box.modelFile)
    expect(onDisk.own_base_url).toBe(ARK.own_base_url)
    expect(onDisk.own_model).toBe(ARK.own_model)
  })

  it('填了自己端点:DSH 那侧写成 workbench-own,Key 进 .env(0600),hints 里一个明文都没有', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceIn(box, fakeRelay())
    const result = await service.update({ mode: 'own', ...ARK })
    expect(result.ok).toBe(true)
    const settings = await readFile(box.settingsFile, 'utf8')
    expect(settings).toContain('provider: workbench-own')
    expect(settings).toContain(`baseURL: ${ARK.own_base_url}`)
    expect(settings).toContain(`model: ${ARK.own_model}`)
    const env = await readFile(box.envFile, 'utf8')
    expect(env).toContain('WORKBENCH_OWN_MODEL_KEY=sk-his-own-key')
    expect((await stat(box.envFile)).mode & 0o777).toBe(0o600)
    // 一行明文都不进 hints(也不进 settings:那里只有环境变量名)。
    expect(result.hints.join('\n')).not.toContain('sk-his-own-key')
    expect(settings).not.toContain('sk-his-own-key')
    expect(result.dsh_restart_required).toBe(true)
  })

  it('默认官方那一档(没填 base_url):不写 WORKBENCH_OWN_MODEL_KEY,照旧 deepseek-official', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceIn(box, fakeRelay())
    const result = await service.update({ mode: 'own' })
    expect(result.ok).toBe(true)
    const settings = await readFile(box.settingsFile, 'utf8')
    expect(settings).toContain('provider: deepseek-official')
    expect(settings).not.toContain('workbench-own')
    await expect(stat(box.envFile)).rejects.toThrow()
  })

  it('自己端点没填 Key:路由照写,但不写 .env,hint 说清缺什么', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const service = serviceIn(box, fakeRelay())
    const result = await service.update({ mode: 'own', ...ARK })
    expect(result.ok).toBe(true)
    const settings = await readFile(box.settingsFile, 'utf8')
    expect(settings).toContain('provider: workbench-own')
    await expect(stat(box.envFile)).rejects.toThrow()
    expect(result.hints.join('\n')).toContain('密钥')
  })

  it('切回中转:WORKBENCH_OWN_MODEL_KEY 从 .env 收走,DSH 那侧回 workbench-relay', async () => {
    const box = await sandbox({ settings: SETTINGS, env: 'DEEPSEEK_API_KEY=sk-ben\n' })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceIn(box, fakeRelay())
    await service.update({ mode: 'own', ...ARK })
    expect(await readFile(box.envFile, 'utf8')).toContain('WORKBENCH_OWN_MODEL_KEY=')
    const back = await service.update({ mode: 'relay' })
    expect(back.ok).toBe(true)
    const env = await readFile(box.envFile, 'utf8')
    expect(env).not.toContain('WORKBENCH_OWN_MODEL_KEY')
    expect(env).toContain('WORKBENCH_RELAY_TOKEN=')
    const settings = await readFile(box.settingsFile, 'utf8')
    expect(settings).toContain('provider: workbench-relay')
    expect(settings).not.toContain('workbench-own')
  })
})

describe('「试一下」(2026-10-23,卡「事务官换Key」)', () => {
  function serviceWith(fetchImpl: typeof fetch, box: Awaited<ReturnType<typeof sandbox>>) {
    return createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      fetchImpl,
    })
  }

  it('成了:回模型那半句话,请求里是同一个端点与模型名', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceWith(async (url, init) => {
      expect(String(url)).toBe('https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions')
      const body = JSON.parse(String(init?.body)) as { model: string, messages: unknown[] }
      expect(body.model).toBe('deepseek-v4-flash')
      return new Response(JSON.stringify({ choices: [{ message: { content: '在,说。' } }] }), { status: 200 })
    }, box)
    await service.update({
      mode: 'own', own_base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3', own_model: 'deepseek-v4-flash',
    })
    const result = await service.try()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('在,说。')
  })

  it('没填 Key:不发包,一句人话', async () => {
    const box = await sandbox({ settings: SETTINGS })
    let called = 0
    const service = serviceWith(async () => { called += 1; return new Response('{}') }, box)
    await service.update({ mode: 'own' })
    const result = await service.try()
    expect(result.ok).toBe(false)
    expect(called).toBe(0)
    expect(result.message).toContain('密钥')
  })

  it('对面拒绝了:一句人话,status 照说,Key 不漏', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceWith(
      async () => new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }),
      box,
    )
    await service.update({ mode: 'own' })
    const result = await service.try()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('401')
    expect(result.message).not.toContain('sk-his-own-key')
  })
})

/**
 * ★ 0.1.7 那一代(补丁层)经 modelService 全链路(2026-10-23 复核):真入口是 profile 的
 * cordis.patch.yml,不是 legacy settings.yaml —— settings.yaml 那代绿不算数。
 * 这里照 dsh-settings-store.test.ts 的夹具搭一台「装着 0.1.7」的机器:settings.yaml 已收走、
 * runtime package.json 写着 0.1.7、profiles/web 在。
 */
describe('own 档自己接的端点 · 0.1.7 补丁层全链路', () => {
  // 期望从唯一源夹具读(火山 case),不手抄。
  const ARK_FIXTURE = fixtureCase('火山方舟')
  const ARK = { baseUrl: ARK_FIXTURE.expect.base_url, model: ARK_FIXTURE.expect.model }
  const PATCH = `# 工作台登录台生成(可以继续往下加别的补丁)。
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash-vision-exp
`

  async function sandbox017() {
    const box = await sandbox()
    // 升级已完成的样子:settings.yaml 没了,痕迹在,补丁层与 runtime 版本都在。
    rmSync(box.settingsFile, { force: true })
    await writeFile(join(box.dshHome, 'settings.yaml.imported'), SETTINGS)
    await mkdir(join(box.dshHome, 'profiles', 'web'), { recursive: true })
    await writeFile(join(box.dshHome, 'profiles', 'web', 'cordis.patch.yml'), PATCH)
    await mkdir(join(box.dshHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(
      join(box.dshHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      `${JSON.stringify({ version: '0.1.7' })}\n`,
    )
    return { ...box, patchFile: join(box.dshHome, 'profiles', 'web', 'cordis.patch.yml') }
  }

  function serviceIn(box: Awaited<ReturnType<typeof sandbox017>>) {
    return createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      accountFile: box.accountFile, fetchImpl: fakeRelay().impl,
    })
  }

  it('写进 profile 的补丁层:workbench-own + 他的模型名;settings.yaml 不会被重建', async () => {
    const box = await sandbox017()
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceIn(box)
    const result = await service.update({ mode: 'own', own_base_url: ARK.baseUrl, own_model: ARK.model })
    expect(result.ok).toBe(true)
    const text = await readFile(box.patchFile, 'utf8')
    expect(readPatchDefaultModel(text)).toEqual({ provider: 'workbench-own', model: ARK.model })
    expect(readPatchOwnProvider(text)).toMatchObject({ found: true, baseUrl: ARK.baseUrl, model: ARK.model })
    // Key 进 .env(0600),不进补丁层。
    expect(text).not.toContain('sk-his-own-key')
    const env = await readFile(box.envFile, 'utf8')
    expect(env).toContain('WORKBENCH_OWN_MODEL_KEY=sk-his-own-key')
    expect((await stat(box.envFile)).mode & 0o777).toBe(0o600)
    await expect(stat(box.settingsFile)).rejects.toThrow()
  })

  it('切回中转:补丁层换成 workbench-relay,自己端点的 Key 收走(切回也验)', async () => {
    const box = await sandbox017()
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceIn(box)
    await service.update({ mode: 'own', own_base_url: ARK.baseUrl, own_model: ARK.model })
    const back = await service.update({ mode: 'relay' })
    expect(back.ok).toBe(true)
    const text = await readFile(box.patchFile, 'utf8')
    expect(readPatchRelayProvider(text)).toMatchObject({ ok: true, found: true })
    expect(readPatchDefaultModel(text)?.provider).toBe('workbench-relay')
    const env = await readFile(box.envFile, 'utf8')
    expect(env).not.toContain('WORKBENCH_OWN_MODEL_KEY')
    expect(env).toContain('WORKBENCH_RELAY_TOKEN=')
  })

  it('默认官方那一档:补丁层 provider 指回 deepseek-official,不建 workbench-own', async () => {
    const box = await sandbox017()
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceIn(box)
    const result = await service.update({ mode: 'own' })
    expect(result.ok).toBe(true)
    const text = await readFile(box.patchFile, 'utf8')
    expect(readPatchDefaultModel(text)).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    expect(readPatchOwnProvider(text)).toEqual({ ok: true, found: false })
  })
})

/**
 * 「地址保持官方、只换模型名」(2026-10-23 退修,Codex):customOwn 不能只比地址 ——
 * 地址是官方缺省、模型名是他自己填的,DSH 那一侧也必须跟上(插件/工人已经跟了)。
 * DSH 的做法:不换路由、不碰 Key,只把 agent-default-model.model 换成他填的;
 * 切回默认(模型名改回缺省)时恢复他原来选的模型;切到中转再切回也保持一致。
 */
describe('own 档 · 官方地址只换模型名(2026-10-23 退修)', () => {
  function serviceIn(box: Awaited<ReturnType<typeof sandbox>>) {
    return createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      accountFile: box.accountFile, fetchImpl: fakeRelay().impl,
    })
  }

  it('settings.yaml 一代:model 行换成他填的,provider 回 deepseek-official,不建 workbench-own、不碰 .env', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceIn(box)
    const result = await service.update({ mode: 'own', own_model: 'my-finetune-1' })
    expect(result.ok).toBe(true)
    const settings = await readFile(box.settingsFile, 'utf8')
    expect(settings).toContain('provider: deepseek-official')
    expect(settings).toContain('model: my-finetune-1')
    expect(settings).not.toContain('workbench-own')
    // 官方 provider 用它自己的 Key 通路:不写 WORKBENCH_OWN_MODEL_KEY。
    await expect(stat(box.envFile)).rejects.toThrow()
    // 记忆:他原来选的模型存进 model.json,切回默认时恢复用。
    expect((await loadModelConfig(box.modelFile)).dsh_prev_model).toBe('deepseek-v4-flash-vision-exp')
  })

  it('切回默认(模型名改回缺省):model 行恢复他原来选的,dsh_prev_model 清除', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceIn(box)
    await service.update({ mode: 'own', own_model: 'my-finetune-1' })
    const back = await service.update({ mode: 'own', own_model: 'deepseek-v4-flash' })
    expect(back.ok).toBe(true)
    const settings = await readFile(box.settingsFile, 'utf8')
    expect(settings).toContain('provider: deepseek-official')
    expect(settings).toContain('model: deepseek-v4-flash-vision-exp')
    expect((await loadModelConfig(box.modelFile)).dsh_prev_model).toBeUndefined()
  })

  it('中途切到中转再切回:model 行仍是他原来选的,provider 往返一致', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceIn(box)
    await service.update({ mode: 'own', own_model: 'my-finetune-1' })
    await service.update({ mode: 'relay' })
    let settings = await readFile(box.settingsFile, 'utf8')
    expect(settings).toContain('provider: workbench-relay')
    // 仍是本卡写入的own模型时，relay恢复记录的原选择，不把专用ID声明成中转支持。
    expect(settings).toContain('model: deepseek-v4-flash-vision-exp')
    await service.update({ mode: 'own' })
    settings = await readFile(box.settingsFile, 'utf8')
    expect(settings).toContain('provider: deepseek-official')
    // 切回时他又填着自定义模型名 → model 行还是他填的。
    expect(settings).toContain('model: my-finetune-1')
  })

  it('0.1.7 补丁层:同一场景走 cordis.patch.yml(真实 profile/store 路径)', async () => {
    const box = await sandbox()
    rmSync(box.settingsFile, { force: true })
    await writeFile(join(box.dshHome, 'settings.yaml.imported'), SETTINGS)
    await mkdir(join(box.dshHome, 'profiles', 'web'), { recursive: true })
    await writeFile(
      join(box.dshHome, 'profiles', 'web', 'cordis.patch.yml'),
      '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash-vision-exp\n',
    )
    await mkdir(join(box.dshHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(
      join(box.dshHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      `${JSON.stringify({ version: '0.1.7' })}\n`,
    )
    const patchFile = join(box.dshHome, 'profiles', 'web', 'cordis.patch.yml')
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const service = serviceIn(box)

    const result = await service.update({ mode: 'own', own_model: 'my-finetune-1' })
    expect(result.ok).toBe(true)
    let text = await readFile(patchFile, 'utf8')
    expect(readPatchDefaultModel(text)).toEqual({ provider: 'deepseek-official', model: 'my-finetune-1' })
    expect(readPatchOwnProvider(text)).toEqual({ ok: true, found: false })

    // 切回默认:恢复他原来选的模型。
    await service.update({ mode: 'own', own_model: 'deepseek-v4-flash' })
    text = await readFile(patchFile, 'utf8')
    expect(readPatchDefaultModel(text)).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })

    // 切到中转再切回:provider 与 model 行保持一致。
    await service.update({ mode: 'relay' })
    text = await readFile(patchFile, 'utf8')
    expect(readPatchDefaultModel(text)?.provider).toBe('workbench-relay')
    await service.update({ mode: 'own' })
    text = await readFile(patchFile, 'utf8')
    expect(readPatchDefaultModel(text)).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
  })
})

/**
 * DSH 凭据服务的**命名空间**(2026-10-23 退修,Codex P1):中转令牌(WORKBENCH_RELAY_TOKEN)与
 * 他自己那把 Key(WORKBENCH_OWN_MODEL_KEY)是两条名字。storeInDsh 曾把名字写死成中转那个,
 * 一切到自己端点,他的 Key 就盖掉中转令牌;且一边 set 失败会被另一边的成功盖掉,
 * 「要不要重启」因此误判。这里全部用假凭据服务,不碰任何真凭据。
 */
describe('DSH 凭据服务的命名空间(2026-10-23 退修)', () => {
  const ARK = { own_base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3', own_model: 'deepseek-v4-flash' }

  function serviceIn(box: Awaited<ReturnType<typeof sandbox>>, creds: ReturnType<typeof fakeDshCredentials>) {
    return createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      fetchImpl: fakeRelay().impl, dshCredentials: () => creds.store,
    })
  }

  it('切到自己端点:他的 Key 只写 WORKBENCH_OWN_MODEL_KEY,中转命名空间一个字不碰', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const creds = fakeDshCredentials()
    const service = serviceIn(box, creds)
    const result = await service.update({ mode: 'own', ...ARK })
    expect(result.ok).toBe(true)
    expect(creds.saved.get('WORKBENCH_OWN_MODEL_KEY')).toBe('sk-his-own-key')
    // ★ 自己的 Key 永不写进中转命名空间。
    expect(creds.saved.has('WORKBENCH_RELAY_TOKEN')).toBe(false)
    expect(creds.calls.filter(one => one.startsWith('set WORKBENCH_RELAY_TOKEN'))).toEqual([])
    // 写进凭据服务成功 → .env 那次不用要重启。
    expect(result.dsh_restart_required).toBeUndefined()
  })

  it('OWN 的 set 失败:如实报「要重启」(.env 兜底已写),失败不会被别名的成功盖掉', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const creds = fakeDshCredentials({ setFailsOn: 'WORKBENCH_OWN_MODEL_KEY' })
    const service = serviceIn(box, creds)
    const result = await service.update({ mode: 'own', ...ARK })
    expect(result.ok).toBe(true)
    expect(result.dsh_restart_required).toBe(true)
    // .env 兜底写上(0600),凭据服务里没存成。
    const env = await readFile(box.envFile, 'utf8')
    expect(env).toContain('WORKBENCH_OWN_MODEL_KEY=sk-his-own-key')
    expect((await stat(box.envFile)).mode & 0o777).toBe(0o600)
    expect(creds.saved.has('WORKBENCH_OWN_MODEL_KEY')).toBe(false)
    // 中转命名空间依旧一个字没碰。
    expect(creds.saved.has('WORKBENCH_RELAY_TOKEN')).toBe(false)
  })

  it('中转令牌留在它的名字空间里(值不被 own Key 盖掉),切回中转继续用那把', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const creds = fakeDshCredentials()
    const service = serviceIn(box, creds)
    await service.update({ mode: 'relay' })
    expect(creds.saved.get('WORKBENCH_RELAY_TOKEN')).toBe('wb_issued')
    await service.update({ mode: 'own', ...ARK })
    // 自己端点值班:中转令牌留着不动(下次切回去直接用),自己的 Key 写在它自己名字下。
    expect(creds.saved.get('WORKBENCH_OWN_MODEL_KEY')).toBe('sk-his-own-key')
    expect(creds.saved.get('WORKBENCH_RELAY_TOKEN')).toBe('wb_issued')
    expect(creds.calls.some(one => one === 'unset WORKBENCH_RELAY_TOKEN')).toBe(false)
    // 切回中转:自己的 Key 收走,中转那把还是原来那把。
    await service.update({ mode: 'relay' })
    expect(creds.saved.has('WORKBENCH_OWN_MODEL_KEY')).toBe(false)
    expect(creds.calls).toContain('unset WORKBENCH_OWN_MODEL_KEY')
    expect(creds.saved.get('WORKBENCH_RELAY_TOKEN')).toBe('wb_issued')
  })
})

/**
 * 「模型设置变更 → 喊主路一声」(2026-10-23 运行时 P1):applyMode 成功后,
 * DSH 侧目标真变了,就通过 onModelTargetChanged 把新目标递出去 —— index.ts 据此把
 * 钉在受控路由上的会话重指过去(见 tests/server-model-retarget.test.ts)。
 * 目标没变(重复保存)/ DSH 那侧没切成,都不喊。
 */
describe('onModelTargetChanged(2026-10-23 运行时 P1)', () => {
  const ARK = { own_base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3', own_model: 'qa-brain-b' }

  function serviceWithHook(box: Awaited<ReturnType<typeof sandbox>>, hook: (change: unknown) => void) {
    return createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      fetchImpl: fakeRelay().impl, onModelTargetChanged: hook as never,
    })
  }

  it('切自己端点:带上此前官方默认来源，供原会话一起换模型', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const seen: unknown[] = []
    const service = serviceWithHook(box, one => seen.push(one))
    await service.update({ mode: 'own', ...ARK })
    expect(seen).toEqual([{ provider: 'workbench-own', model: 'qa-brain-b', prevModel: 'deepseek-v4-flash-vision-exp' }])
  })

  it('只换模型名:喊 { provider: deepseek-official, model, prevModel }(官方上正用旧模型名的会话也要跟)', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const seen: unknown[] = []
    const service = serviceWithHook(box, one => seen.push(one))
    await service.update({ mode: 'own', own_model: 'my-finetune-1' })
    expect(seen).toEqual([{ provider: 'deepseek-official', model: 'my-finetune-1', prevModel: 'deepseek-v4-flash-vision-exp' }])
  })

  it('切中转:喊 { provider: workbench-relay },模型名缺席(由接收方问 catalog 缺省)', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const seen: unknown[] = []
    const service = serviceWithHook(box, one => seen.push(one))
    // 从「自己的账号」切到中转,目标才变(这台机器缺省就是中转,先切过去再切回来)。
    await service.update({ mode: 'own' })
    await service.update({ mode: 'relay' })
    expect(seen).toEqual([{ provider: 'deepseek-official', prevModel: 'deepseek-v4-flash-vision-exp' }, { provider: 'workbench-relay', prevModel: 'deepseek-v4-flash-vision-exp' }])
  })

  it('目标没变(同样的再保存一遍)不喊', async () => {
    const box = await sandbox({ settings: SETTINGS })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const seen: unknown[] = []
    const service = serviceWithHook(box, one => seen.push(one))
    await service.update({ mode: 'own', ...ARK })
    await service.update({ mode: 'own', ...ARK })
    expect(seen).toHaveLength(1)
  })

  it('DSH 那一侧没切成(他自己配过 llm-pi-ai):不喊 —— 旧路由还在,受控会话照旧能用', async () => {
    const box = await sandbox({
      settings: `${SETTINGS}llm-pi-ai:
  providers:
    my-own-gateway:
      api: openai-completions
      baseURL: https://我自己的/v1
      apiKeyEnv: MY_KEY
      models:
        - id: whatever
`,
    })
    await saveCredential(box.credentialFile, 'deepseek', 'sk-his-own-key')
    const seen: unknown[] = []
    const service = serviceWithHook(box, one => seen.push(one))
    const result = await service.update({ mode: 'own', ...ARK })
    expect(result.ok).toBe(true)
    expect(seen).toEqual([])
  })
})

describe('ModelService.target(2026-10-23:续聊对齐要拿「此刻 DSH 侧目标」)', () => {
  function serviceIn(box: Awaited<ReturnType<typeof sandbox>>) {
    return createModelService({
      modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
      fetchImpl: fakeRelay().impl,
    })
  }

  it('自己端点:{ provider: workbench-own, model };只换模型名:{ deepseek-official, model }', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const service = serviceIn(box)
    await service.update({ mode: 'own', own_base_url: 'https://ark.test/v3', own_model: 'qa-brain-b' })
    expect(await service.target()).toEqual({ provider: 'workbench-own', model: 'qa-brain-b', prevModel: 'deepseek-v4-flash-vision-exp' })
    await service.update({ mode: 'own', own_base_url: 'https://api.deepseek.com/v1', own_model: 'my-finetune-1' })
    // 这次来自 workbench-own，不拿最初恢复来源冒充本次官方来源，避免牵动手选官方会话。
    expect(await service.target()).toEqual({ provider: 'deepseek-official', model: 'my-finetune-1' })
    expect((await loadModelConfig(box.modelFile)).dsh_prev_model).toBe('deepseek-v4-flash-vision-exp')
  })

  it('中转:{ provider: workbench-relay }(模型名由 catalog 缺省补);默认官方:{ deepseek-official, 缺省模型 }', async () => {
    const box = await sandbox({ settings: SETTINGS })
    const service = serviceIn(box)
    await service.update({ mode: 'relay' })
    expect(await service.target()).toEqual({ provider: 'workbench-relay' })
    await service.update({ mode: 'own' })
    // 全缺省:模型名不给(由 catalog 缺省 = 他自己选的那个补,不写一个死值盖掉他的选择)。
    expect(await service.target()).toEqual({ provider: 'deepseek-official' })
  })
})

describe('liveReconcile 与 onModelTargetChanged 协调 (2026-10-23 卡「换Key运行时」)', () => {
  it('update 换模型时调用 liveReconcile 并 await onModelTargetChanged', async () => {
    const box = await sandbox()
    rmSync(box.settingsFile, { force: true })
    await writeFile(join(box.dshHome, 'settings.yaml.imported'), SETTINGS)
    await mkdir(join(box.dshHome, 'profiles', 'web'), { recursive: true })
    await writeFile(
      join(box.dshHome, 'profiles', 'web', 'cordis.patch.yml'),
      '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash-vision-exp\n',
    )
    await mkdir(join(box.dshHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(
      join(box.dshHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      JSON.stringify({ version: '0.1.7-rc.2' }),
    )
    let reconciled = false
    let targetChangedAwaited = false
    let targetChangeResolved = false

    const service = createModelService({
      modelFile: box.modelFile,
      credentialFile: box.credentialFile,
      dshHome: box.dshHome,
      liveReconcile: async () => {
        reconciled = true
      },
      onModelTargetChanged: async () => {
        targetChangedAwaited = true
        await new Promise(r => setTimeout(r, 10))
        targetChangeResolved = true
      },
    })

    const res = await service.update({ mode: 'own', own_base_url: 'http://127.0.0.1:8893/v1', own_model: 'qa-brain-b' })
    expect(res.ok).toBe(true)
    expect(reconciled).toBe(true)
    expect(targetChangedAwaited).toBe(true)
    expect(targetChangeResolved).toBe(true)
  })
})

it('在线应用失败不保存 B，返回失败；同一 B 重试不会被洗成成功', async () => {
  const box = await sandbox()
  const before = await readFile(box.modelFile, 'utf8').catch(() => undefined)
  const service = createModelService({ modelFile: box.modelFile, credentialFile: box.credentialFile,
    dshHome: box.dshHome, liveReconcile: async () => { throw new Error('Loader rejected') },
  })
  for (let n = 0; n < 2; n += 1) {
    const result = await service.update({ mode: 'own', own_model: 'qa-brain-b' })
    expect(result.ok).toBe(false)
    await expect(service.target()).rejects.toThrow()
    expect(await readFile(box.modelFile, 'utf8').catch(() => undefined)).toBe(before)
  }
})

it('受控会话切换失败不保存 B，成功重试解除发送阻止', async () => {
  const box = await sandbox({ settings: SETTINGS })
  const before = await readFile(box.modelFile, 'utf8')
  let fail = true
  const service = createModelService({ modelFile: box.modelFile, credentialFile: box.credentialFile, dshHome: box.dshHome,
    onModelTargetChanged: async () => { if (fail) throw new Error('MODEL_TARGET_UNAVAILABLE') },
  })
  expect((await service.update({ mode: 'own', own_model: 'qa-brain-b' })).ok).toBe(false)
  expect(await readFile(box.modelFile, 'utf8')).toBe(before)
  await expect(service.target()).rejects.toThrow('MODEL_APPLICATION_FAILED')
  fail = false
  expect((await service.update({ mode: 'own', own_model: 'qa-brain-b' })).ok).toBe(true)
  expect(await service.target()).toMatchObject({ provider: 'deepseek-official', model: 'qa-brain-b' })
})
