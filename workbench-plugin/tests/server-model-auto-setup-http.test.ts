// @vitest-environment node
/**
 * 「注册/登录成功那一刻自动领模型服务令牌」的整条 HTTP 路(2026-09-18,决策记录同日
 * 「新用户零凭据:模型服务令牌要在注册那一刻自动领」)。
 *
 * 起的是**真的 workbench server + 真的 modelService**,只有中转是假的(一个 fetch 替身)
 * 与 launchctl 是假的(一个记数组的 exec)。DSH 的两个文件在**临时 HOME** 里,
 * 真的 ~/.dsh 一个字节都不碰(0904 家目录事故之后的规矩)。
 *
 * Ben 09-18 真机那一幕就是最后一个 describe 里那条:清空凭据 → `/model` 是 relay
 * 但 `relay_token_configured:false`,要他自己进设置点一下。这一版登录完就该是 true。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAccountService } from '../src/server/account.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { saveCredential } from '../src/server/credentials.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createModelAutoSetup } from '../src/server/modelAutoSetup.ts'
import { createModelService } from '../src/server/modelService.ts'
import type { OnboardingService } from '../src/server/onboarding.ts'
import { ONBOARDING_RESTARTING_NOTE } from '../src/protocol.ts'
import { createWorkbenchService } from '../src/server/service.ts'

/**
 * 引导只需要这一份的两个方法:composeState 每拍要 `view()`,那条路由要 `openSession()`。
 * 真的 OnboardingService 要一个记忆仓库(WORKBENCH_BUTLER_CWD)才建得起来 —— 这一份用例
 * 验的是"重启发生在开口之前",不是引导本身,所以给一个只回一句话的替身。
 * **openSession 直接炸**:它要是被调到了,就说明那道"先重启"的门没挡住,用例必须红。
 */
function fakeOnboarding(): OnboardingService {
  return {
    view: () => ({ stage: 'opening', done: false, label: '① 开场', step: 1, steps: 3 }),
    openSession: async () => { throw new Error('重启之前不该开会话') },
  } as unknown as OnboardingService
}

const SETTINGS = `agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash-vision-exp
`

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 一个会发令牌的假中转。`registerStatus` 给失败那几条用。 */
function fakeRelay(options: { registerStatus?: number } = {}) {
  const seen: string[] = []
  const impl: typeof fetch = async (url) => {
    const href = String(url)
    seen.push(href)
    if (href.endsWith('/register-device')) {
      if (options.registerStatus !== undefined) {
        return new Response(JSON.stringify({ error: { message: '领取太频繁了,过一会儿再试。' } }), { status: options.registerStatus })
      }
      return new Response(JSON.stringify({ token: 'wb_issued' }), { status: 201 })
    }
    if (href.endsWith('/usage')) {
      return new Response(JSON.stringify({
        day: '2026-09-18', used_tokens: 12, daily_token_limit: 50_000, remaining_tokens: 49_988,
      }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  return { impl, seen }
}

async function serve(options: {
  relay?: ReturnType<typeof fakeRelay>
  ownKey?: string
  sessions?: number
  onboarding?: boolean
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-model-auto-'))
  dirs.push(root)
  const dshHome = join(root, '.dsh')
  await mkdir(join(dshHome, 'workbench'), { recursive: true })
  await writeFile(join(dshHome, 'settings.yaml'), SETTINGS)
  const modelFile = join(dshHome, 'workbench', 'model.json')
  // 用例跑的是开源缺省(构建不带中转);这里测的是接了中转的那一档,地址写进 model.json(同我们的构建 / 自建中转)。
  await writeFile(modelFile, JSON.stringify({ relay_url: 'https://relay.test' }))
  const credentialFile = join(dshHome, 'workbench', 'credentials.json')
  if (options.ownKey !== undefined) await saveCredential(credentialFile, 'deepseek', options.ownKey)

  const relay = options.relay ?? fakeRelay()
  const model = createModelService({
    modelFile, credentialFile, dshHome, fetchImpl: relay.impl,
  })
  const execs: string[][] = []
  const modelAutoSetup = createModelAutoSetup({
    model,
    exec: async (cmd) => { execs.push([...cmd]); return { ok: true } },
    uid: () => 501,
    dshSessionCount: () => options.sessions ?? 0,
    restartDelayMs: 0,
  })
  const account = createAccountService({
    file: join(dshHome, 'workbench', 'account.json'),
    keyFile: join(dshHome, 'workbench', 'account-session.key'),
    scryptN: 1024,
  })
  const appConfig = createAppConfig({ file: join(dshHome, 'workbench', 'app.json') })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_758_100_000 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    account,
    appConfig,
    model,
    modelAutoSetup,
    credentialFile,
    ...(options.onboarding === true ? { onboarding: fakeOnboarding() } : {}),
  })
  started.push(server)

  let jar = ''
  const call = async (path: string, init: { method?: string, body?: unknown } = {}) => {
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(jar === '' ? {} : { cookie: jar }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie !== null) {
      const first = setCookie.split(';')[0] ?? ''
      jar = first.endsWith('=') ? '' : first
    }
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }

  /** 注册那一下是"发完响应再去领":等它把后台那一遍跑完。 */
  const settle = async (): Promise<void> => { await modelAutoSetup.run() }

  return { call, relay, execs, settle, modelAutoSetup, files: { modelFile, dshHome } }
}

describe('注册成功 → 自动接上模型服务', () => {
  it('注册完就领到了令牌,DSH 的两个文件也写好了 —— 设置里一下都不用点', async () => {
    const box = await serve()
    const registered = await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    expect(registered.status).toBe(200)
    await box.settle()

    const status = (await box.call('/model')).body
    expect(status.mode).toBe('relay')
    expect(status.relay_token_configured).toBe(true)
    expect(status.ready).toBe(true)
    // 令牌永不回显。
    expect(JSON.stringify(status)).not.toContain('wb_issued')

    const settings = await readFile(join(box.files.dshHome, 'settings.yaml'), 'utf8')
    expect(settings).toContain('provider: workbench-relay')
    expect(await readFile(join(box.files.dshHome, '.env'), 'utf8')).toContain('WORKBENCH_RELAY_TOKEN=wb_issued')
  })

  it('登录也走这一条(Ben 那台是"清空凭据之后再登录"的旧机器)', async () => {
    const box = await serve()
    await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    await box.settle()
    expect((await box.call('/account/logout', { method: 'POST' })).status).toBe(200)

    const before = box.relay.seen.filter(u => u.endsWith('/register-device')).length
    expect((await box.call('/account/login', { body: { username: 'ben', password: 'hunter22' } })).status).toBe(200)
    await box.settle()
    // 已经有令牌了,所以这一次**不重领**(重领会把上一把作废)。
    expect(box.relay.seen.filter(u => u.endsWith('/register-device')).length).toBe(before)
    expect((await box.call('/model')).body.relay_token_configured).toBe(true)
  })

  it('他已经有自己的 DeepSeek Key:一个字都不动,也不去领', async () => {
    const box = await serve({ ownKey: 'sk-ben-own' })
    await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    await box.settle()
    expect(box.relay.seen.filter(u => u.endsWith('/register-device')).length).toBe(0)
    // 横幅那一格**缺席**:这件事不归自动化管,不是"还差一件事"。
    expect(box.modelAutoSetup.alert()).toBeUndefined()
    expect(await readFile(join(box.files.dshHome, 'settings.yaml'), 'utf8')).toBe(SETTINGS)
  })

  it('领不到:登录照样成功(不阻塞),顶上多一条横幅', async () => {
    const box = await serve({ relay: fakeRelay({ registerStatus: 429 }) })
    const registered = await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    expect(registered.status).toBe(200)
    expect(registered.body.ok).toBe(true)
    await box.settle()

    const state = (await box.call('/state')).body
    expect((state.setup_alerts as Record<string, unknown>).model_service).toBe(true)
    expect((await box.call('/model')).body.ready).toBe(false)
  })

  it('横幅上那颗「重试」:POST /model/auto-setup,好了那一格就变假', async () => {
    let failing = true
    const relay = {
      seen: [] as string[],
      impl: (async (url) => {
        const href = String(url)
        relay.seen.push(href)
        if (href.endsWith('/register-device')) {
          return failing
            ? new Response(JSON.stringify({ error: { message: '连不上' } }), { status: 503 })
            : new Response(JSON.stringify({ token: 'wb_issued' }), { status: 201 })
        }
        return new Response(JSON.stringify({ day: '2026-09-18', used_tokens: 0, daily_token_limit: 10, remaining_tokens: 10 }), { status: 200 })
      }) as typeof fetch,
    }
    const box = await serve({ relay })
    await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    await box.settle()
    expect(((await box.call('/state')).body.setup_alerts as Record<string, unknown>).model_service).toBe(true)

    failing = false
    const retried = await box.call('/model/auto-setup', { method: 'POST' })
    expect(retried.status).toBe(200)
    expect((retried.body.status as Record<string, unknown>).ready).toBe(true)
    expect(((await box.call('/state')).body.setup_alerts as Record<string, unknown>).model_service).toBe(false)
  })

  it('他自己在设置里点成了 → 横幅当场消失(结论只有一份,谁改的都算数)', async () => {
    let failing = true
    const relay = {
      seen: [] as string[],
      impl: (async (url) => {
        const href = String(url)
        relay.seen.push(href)
        if (href.endsWith('/register-device')) {
          return failing
            ? new Response(JSON.stringify({ error: { message: '连不上' } }), { status: 503 })
            : new Response(JSON.stringify({ token: 'wb_issued' }), { status: 201 })
        }
        return new Response(JSON.stringify({ day: '2026-09-18', used_tokens: 0, daily_token_limit: 10, remaining_tokens: 10 }), { status: 200 })
      }) as typeof fetch,
    }
    const box = await serve({ relay })
    await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    await box.settle()
    expect(((await box.call('/state')).body.setup_alerts as Record<string, unknown>).model_service).toBe(true)

    // 他没去点横幅那颗「重试」,而是进设置点了「用工作台提供的服务」。
    failing = false
    expect((await box.call('/model', { method: 'PUT', body: { mode: 'relay' } })).status).toBe(200)
    expect(((await box.call('/state')).body.setup_alerts as Record<string, unknown>).model_service).toBe(false)
  })

  it('他改成用自己的 Key:那一格回到**缺席**(不归自动化管了),不是变假', async () => {
    const box = await serve({ relay: fakeRelay({ registerStatus: 429 }) })
    await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    await box.settle()
    expect(((await box.call('/state')).body.setup_alerts as Record<string, unknown>).model_service).toBe(true)

    expect((await box.call('/model', { method: 'PUT', body: { mode: 'own' } })).status).toBe(200)
    expect((await box.call('/state')).body.setup_alerts).toBeUndefined()
  })

  it('还没注册过的时候:那一格缺席(没试过不是没缺)', async () => {
    const box = await serve()
    const state = (await box.call('/state')).body
    expect(state.setup_alerts).toBeUndefined()
  })
})

describe('那一下重启由工作台自己发', () => {
  it('首次流程走完:DSH 没有会话在跑 → kickstart 一次,回包里说一句', async () => {
    const box = await serve({ sessions: 0 })
    await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    await box.settle()

    const done = await box.call('/first-run', { body: { done: true } })
    expect(done.status).toBe(200)
    expect(done.body.restarting).toBe(true)
    expect(box.execs).toEqual([['launchctl', 'kickstart', '-k', 'gui/501/ai.deepseek.dsh']])
  })

  it('引导开口之前也走这一条:真重启了就先不开会话(开了也会跟着一起没)', async () => {
    const box = await serve({ sessions: 0, onboarding: true })
    await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    await box.settle()

    const opened = await box.call('/onboarding/session', { method: 'POST', body: {} })
    // 替身里的 openSession 一被调到就炸 —— 这一条绿,就说明那道门真的挡在开口前面。
    expect(opened.status).toBe(503)
    // 2026-09-24:这是预料之中的一步,回包那句是中性的「稍等,正在准备…」(与界面同一句),不是红字那种报错。
    expect(opened.body.error).toBe(ONBOARDING_RESTARTING_NOTE)
    expect(opened.body.restarting).toBe(true)
    expect(box.execs.length).toBe(1)
  })

  it('重启已经发出去、这个进程还没被换掉:再来开会话照样回「正在重启」,不在快没了的进程里开,也不再发一次 kickstart', async () => {
    const box = await serve({ sessions: 0, onboarding: true })
    await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    await box.settle()
    expect((await box.call('/onboarding/session', { method: 'POST', body: {} })).status).toBe(503)
    // 替身的 openSession 一被调到就炸:第二次还是 503,就说明门还关着。
    const again = await box.call('/onboarding/session', { method: 'POST', body: {} })
    expect(again.status).toBe(503)
    expect(again.body.restarting).toBe(true)
    expect(box.execs.length).toBe(1)
  })

  it('kickstart 自己失败了:撤掉「正在重启」那面旗子,不把人永远挡在门外', async () => {
    const setup = createModelAutoSetup({
      model: { autoSetup: async () => ({ ok: true, attempted: true, status: { ready: true }, hints: [], dsh_restart_required: true }) } as never,
      exec: async () => ({ ok: false }),
      uid: () => 501,
      dshSessionCount: () => 0,
      restartDelayMs: 0,
    })
    await setup.run()
    expect((await setup.restartIfPending()).restarted).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await setup.restartIfPending()).restarted).toBe(false)
  })

  it('DSH 里还有会话在跑:不重启,横幅/回包里也不谎称重启了', async () => {
    const box = await serve({ sessions: 3 })
    await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    await box.settle()

    const done = await box.call('/first-run', { body: { done: true } })
    expect(done.status).toBe(200)
    expect(done.body.restarting).toBeUndefined()
    expect(box.execs.length).toBe(0)
    // 还挂着:等它空下来再说。
    expect(box.modelAutoSetup.restartPending()).toBe(true)
  })

  it('没什么可重启的(压根没写过 DSH 配置)就什么都不做', async () => {
    const box = await serve({ ownKey: 'sk-ben-own' })
    await box.call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    await box.settle()
    const done = await box.call('/first-run', { body: { done: true } })
    expect(done.body.restarting).toBeUndefined()
    expect(box.execs.length).toBe(0)
  })
})
