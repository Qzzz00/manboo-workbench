// @vitest-environment node
/**
 * **中转配了哪家,才出现哪家**(2026-09-26,卡 GH;`src/server/relayProviders.ts`)。
 *
 * 起因:派活名单与额度面板里的「GPT」是个空壳。接口那只手经我们自己的中转转给上游,而线上那台中转
 * `GET /health` 回的是 `"providers":{"deepseek":true,"openai":false,"doubao":false}` ——
 * **服务器上没配 OpenAI 的 Key**,派给 GPT 只会换回 503 `openai_not_configured`。
 * 维护者 09-26 问「所以 GPT 那条没有意义,可以删掉是吧」,答应的做法**不是删**,而是这条机制。
 *
 * 钉五样:
 * 1. `/health` 那两种回包都认得(线上那一份 `openai:false`、配上之后那一份 `openai:true`),老中转没有 `providers` 就当没取到;
 * 2. 什么时候问:走中转才问、10 分钟一次、换模式立刻重问;**「用自己的 Key」那一档一个请求都不发**;
 * 3. 取不到就按上次那份,从没取到过就当「没配」(宁可少一家,不摆空壳);
 * 4. ★`openai:false` → **派活名单、额度、事务官技能里那张表、设置里各家能力那一页都没有 GPT**;`openai:true` → 回来;
 * 5. 豆包这种**有窗口那只手**的照常在,只是接口那一只标成「中转没配这家」
 *    (它的额度 09-26 卡 QD 起从它自己那一页读,与中转配没配无关)。
 *
 * 上游那一头是**真起一个假中转**(同 `server-dispatch-api-http.test.ts` 的纪律:不 mock fetch ——
 * 这条路最容易错的地方正是「问的是哪条 URL、回包怎么读」)。一次真的上游请求都没有。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentQuotaView } from '../src/protocol.ts'
import { createAgentCaps } from '../src/server/agentCaps.ts'
import type { AgentCliProbe } from '../src/server/agentDispatch.ts'
import { dispatchSkillBody, resolveAgentCli } from '../src/server/agentDispatch.ts'
import { quotasFor } from '../src/server/agentQuota.ts'
import { composerAgents } from '../src/server/composer.ts'
import { capTargetsFor, dispatchTargets } from '../src/server/dispatchTargets.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import {
  createRelayProvidersReader, parseRelayProviders, relayHealthUrl, relayProviderFor, relayProviderOfModel,
} from '../src/server/relayProviders.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const started: WorkbenchServer[] = []
const relays: (() => Promise<void>)[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (relays.length) await relays.pop()?.()
})

/** 线上那台中转此刻回的那一份(2026-09-26 真读到的:服务器上只配了 DeepSeek)。 */
const ONLINE_TODAY = { deepseek: true, openai: false, doubao: false }
/** 服务器上加了 `RELAY_OPENAI_KEY` 之后那一份。 */
const OPENAI_ADDED = { deepseek: true, openai: true, doubao: false }

/**
 * 一个假中转:**只有 `/health` 这一条路**。记下被问了几次、问的是哪条路径,
 * `providers` 与状态码随时换得动(换 Key、换机器、网络出错都在这一层演)。
 */
async function fakeRelay(providers: Record<string, boolean> | undefined = ONLINE_TODAY) {
  const hits: string[] = []
  const box = { providers, status: 200, body: undefined as string | undefined }
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(box.status, { 'content-type': 'application/json' })
    // `/health` 回的那一份的形状照 relay/server/app.cjs:providers 只有布尔,没有 Key、没有地址。
    res.end(box.body ?? JSON.stringify({
      ok: true,
      name: 'model-relay',
      upstream_configured: true,
      ...(box.providers === undefined ? {} : { providers: box.providers }),
      accounts: true,
    }))
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  relays.push(() => new Promise<void>(done => { server.close(() => done()) }))
  return { baseUrl: `http://127.0.0.1:${port}/v1`, hits, box }
}

/** 只把 `endpoint()` 接上 —— 这条路用到的就这一样(同 server-dispatch-api-http)。 */
function fakeModel(baseUrl: string, over: Record<string, unknown> = {}) {
  return {
    endpoint: () => Promise.resolve({ mode: 'relay', baseUrl, key: 'wb_token_x', ready: true, ...over }),
  } as unknown as NonNullable<Parameters<typeof startWorkbenchServer>[0]['model']>
}

async function tasksService() {
  const file = join(await mkdtemp(join(tmpdir(), 'relay-providers-tasks-')), 'tasks.json')
  return createTasksService({ file })
}

/** 一台「什么 App 都没装」的假 Mac:于是名单里有谁,全凭「中转上配了哪几家」。 */
async function serve(providers: Record<string, boolean> | undefined, over: Record<string, unknown> = {}) {
  const relay = await fakeRelay(providers)
  const model = fakeModel(relay.baseUrl, over)
  const reader = createRelayProvidersReader({ endpoint: () => model.endpoint(), now: () => Date.now() })
  // 起服务时先问一次(同 src/index.ts 的接线)。
  await reader.read()
  const caps = createAgentCaps({
    families: () => [],
    installed: () => false,
    helper: () => ({ connected: false, authorized: false, newConversation: false, readReply: false }),
    cliFound: () => false,
    cliLogin: async () => ({ login: 'unknown' }),
    now: () => new Date('2026-09-26T10:00:00Z'),
    setTimer: () => 1,
    clearTimer: () => {},
  })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks: await tasksService(),
    model,
    relayProviders: reader,
    agentCaps: caps,
    appInstalled: () => false,
  })
  started.push(server)
  return { url: server.url, relay, reader }
}

async function get(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, any> }
}
async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}


describe('/health 的两种回包都钉住', () => {
  it('★线上那一份(openai:false)与配上之后那一份(openai:true)', () => {
    expect(parseRelayProviders(JSON.stringify({ ok: true, providers: ONLINE_TODAY }))).toEqual(ONLINE_TODAY)
    expect(parseRelayProviders(JSON.stringify({ ok: true, providers: OPENAI_ADDED }))).toEqual(OPENAI_ADDED)
  })

  it('认不出一律 undefined(= 没取到,照上次那份):老中转没有 providers、不是 JSON、值不是布尔', () => {
    // 09-22 之前的中转压根没有 providers 那一格。
    expect(parseRelayProviders(JSON.stringify({ ok: true, upstream_configured: true }))).toBeUndefined()
    expect(parseRelayProviders('<html>502</html>')).toBeUndefined()
    expect(parseRelayProviders(undefined)).toBeUndefined()
    expect(parseRelayProviders(JSON.stringify({ providers: ['openai'] }))).toBeUndefined()
    // 值不是布尔的那一条当没说;别的照收。
    expect(parseRelayProviders(JSON.stringify({ providers: { deepseek: true, openai: 'yes' } }))).toEqual({ deepseek: true })
  })

  it('家 → 上游那一家:判据与中转自己那份(providers.cjs 的 providerOfModel)同源', () => {
    expect(relayProviderFor('gpt')).toBe('openai')
    expect(relayProviderFor('doubao')).toBe('doubao')
    expect(relayProviderOfModel('gpt-4o')).toBe('openai')
    expect(relayProviderOfModel('o3-mini')).toBe('openai')
    expect(relayProviderOfModel('doubao-pro-32k')).toBe('doubao')
    expect(relayProviderOfModel('ep-2026')).toBe('doubao')
    // 认不出就是 DeepSeek(现状那一档),与中转一字不差。
    expect(relayProviderOfModel('deepseek-chat')).toBe('deepseek')
    expect(relayProviderOfModel(undefined)).toBe('deepseek')
  })

  it('问的是 /health,不是 /v1/health', () => {
    expect(relayHealthUrl('https://api.aibooo.cn/v1')).toBe('https://api.aibooo.cn/health')
    expect(relayHealthUrl('http://127.0.0.1:8795/v1/')).toBe('http://127.0.0.1:8795/health')
  })
})

describe('什么时候去问中转', () => {
  it('走中转:问一次拿到 providers;节流窗口内不再问;refresh() 立刻重问', async () => {
    const relay = await fakeRelay(ONLINE_TODAY)
    let clock = 1_000
    const reader = createRelayProvidersReader({
      endpoint: () => fakeModel(relay.baseUrl).endpoint(),
      now: () => clock,
      refreshMs: 60_000,
    })
    expect(reader.view()).toBeUndefined()
    await reader.read()
    expect(reader.view()).toEqual(ONLINE_TODAY)
    expect(relay.hits).toEqual(['/health'])

    reader.pump()
    expect(relay.hits.length).toBe(1)
    // 服务器上加了那把 Key:到点之后自己看得见。
    relay.box.providers = OPENAI_ADDED
    clock += 60_000
    await reader.pump()
    expect(relay.hits.length).toBe(2)
    expect(reader.view()).toEqual(OPENAI_ADDED)

    // 换了模式 / 重领了凭证:不等节流。
    relay.box.providers = ONLINE_TODAY
    await reader.refresh()
    expect(relay.hits.length).toBe(3)
    expect(reader.view()).toEqual(ONLINE_TODAY)
  })

  it('★「用自己的 DeepSeek Key」那一档:一个请求都不发(接口那只手本来就不可用)', async () => {
    const relay = await fakeRelay(OPENAI_ADDED)
    const reader = createRelayProvidersReader({
      endpoint: () => fakeModel(relay.baseUrl, { mode: 'own' }).endpoint(),
      now: () => 1_000,
    })
    expect(await reader.read()).toBeUndefined()
    await reader.refresh()
    expect(relay.hits).toEqual([])
    expect(reader.view()).toBeUndefined()
  })

  it('取不到就按上次那份;从没取到过就当「没配」', async () => {
    const relay = await fakeRelay(OPENAI_ADDED)
    const reader = createRelayProvidersReader({ endpoint: () => fakeModel(relay.baseUrl).endpoint(), now: () => 1_000 })
    await reader.read()
    expect(reader.view()).toEqual(OPENAI_ADDED)
    // 中转这会儿回 502 / 回一段读不出的东西:**上次那份还在**(网络抖一下不该让名单少一家又多一家)。
    relay.box.status = 502
    await reader.read()
    expect(reader.view()).toEqual(OPENAI_ADDED)
    relay.box.status = 200
    relay.box.body = '<html>nginx</html>'
    await reader.read()
    expect(reader.view()).toEqual(OPENAI_ADDED)

    // 一次都没问到过(中转压根连不上):undefined —— 调用方当「一家都没配」。
    const dead = createRelayProvidersReader({
      endpoint: async () => ({ mode: 'relay', baseUrl: 'http://127.0.0.1:1/v1' }),
      now: () => 1_000,
      timeoutMs: 200,
    })
    expect(await dead.read()).toBeUndefined()
  })
})

describe('★中转没配 OpenAI → GPT 一处都不出现(名单 / 额度 / 技能表 / 能力页)', () => {
  it('派活名单(/dispatch/choices)与额度(/agents/quota):openai:false 时没有 GPT', async () => {
    const { url } = await serve(ONLINE_TODAY)
    const choices = await post(url, '/dispatch/choices', { text: '帮我写三个标题' })
    // 卡 BS2(2026-09-28):选项表里没有「事务官自己做」那一项了 —— 一家都没接上时它就是空的。
    expect((choices.body.options as any[]).map(one => one.family)).toEqual([])
    expect(String(choices.body.line)).not.toContain('GPT')
    const quota = await get(url, '/agents/quota')
    expect((quota.body.agents as AgentQuotaView[]).map(one => one.id)).toEqual([])
  })

  it('★服务器上配上 OpenAI → 同两处 GPT 自己回来(一行代码都不用改)', async () => {
    const { url } = await serve(OPENAI_ADDED)
    const choices = await post(url, '/dispatch/choices', { text: '帮我写三个标题' })
    expect((choices.body.options as any[]).map(one => one.family)).toEqual(['gpt'])
    expect((choices.body.options as any[]).find(one => one.family === 'gpt')).toMatchObject({ title: 'GPT', hand: 'api' })
    const quota = await get(url, '/agents/quota')
    expect((quota.body.agents as AgentQuotaView[]).map(one => one.id)).toEqual(['gpt'])
  })

  it('中转压根没回 providers(老中转)/ 问不到:同样没有 GPT —— 宁可少一家,不摆空壳', async () => {
    const { url } = await serve(undefined)
    const choices = await post(url, '/dispatch/choices', { text: '帮我写三个标题' })
    // 卡 BS2(2026-09-28):选项表里没有「事务官自己做」那一项了 —— 一家都没接上时它就是空的。
    expect((choices.body.options as any[]).map(one => one.family)).toEqual([])
  })

  it('事务官技能里那张「这台电脑上现在怎么派」的表:openai:false 时没有 GPT 这一行', () => {
    // 与 http.ts 的 `probeAgentClis` 同一条路:家名从 `dispatchTargets` 来,再逐家探命令行。
    const probe: AgentCliProbe = { pathEnv: '', home: '/tmp/nobody-relay-gh', exists: () => false, listDir: () => [] }
    const bodyFor = (providers: Record<string, boolean>) => dispatchSkillBody(
      '# 派活给别家Agent',
      dispatchTargets({ apiReady: true, relayProviders: providers, installed: () => false })
        .map(one => resolveAgentCli(one.id, probe)),
    )
    expect(bodyFor(ONLINE_TODAY)).not.toContain('GPT')
    expect(bodyFor(OPENAI_ADDED)).toContain('| GPT |')
  })

  it('设置里各家能力那一页:GPT 两种回包下都不在(它没有本机窗口,这一页只体检有窗口的那几家)', () => {
    for (const providers of [ONLINE_TODAY, OPENAI_ADDED]) {
      const ids = capTargetsFor({ apiReady: true, relayProviders: providers, installed: () => true }).map(one => one.id)
      expect(ids).not.toContain('gpt')
      // 有窗口的那几家照旧在(这一页本身没坏)。
      expect(ids).toContain('doubao')
    }
  })
})

describe('★豆包这种有窗口的照常在,只是接口那一只标成不可用', () => {
  it('名单里在;@ 候选里接口那一只写「中转没配这家」', () => {
    const targets = dispatchTargets({ apiReady: true, relayProviders: ONLINE_TODAY, installed: () => true })
    expect(targets.map(one => one.id)).toContain('doubao')
    expect(targets.map(one => one.id)).not.toContain('gpt')

    const out = composerAgents({
      state: {},
      clis: new Set(),
      windowReady: true,
      apiReady: true,
      relayProviders: ONLINE_TODAY,
      now: new Date('2026-09-26T10:00:00.000Z'),
      appInstalled: family => family === 'doubao',
      targets,
    })
    expect(out.find(one => one.family === 'doubao')?.hands).toEqual([
      { hand: 'window', ready: true },
      { hand: 'api', ready: false, why: '中转没配这家' },
    ])
    // 豆包的额度那一格与中转配没配无关:它是从**它自己窗口上**那一页读的(卡 QD),
    // 中转少一把 Key 只影响接口那只手。这会儿没读过 → 「没接上:那一页在哪」,不是「不限」。
    // ★ 2026-09-30 维护者拍板把「带我过去」全删(见 `docs/决策记录.md` 末尾那一条):原来这一格挂一颗那样的键,
    // 该他自己去打开哪一页写在键旁边;键没了,那句话并进 `why`,所以这里只查前半句(后半句由额度那几个用例钉)。
    const doubao = quotasFor(['doubao'], { quota: {}, apiReady: true, relayProviders: ONLINE_TODAY, now: new Date() })[0]
    expect(doubao).toMatchObject({ id: 'doubao', state: 'unconnected' })
    expect(doubao?.why).toContain('还没读过豆包办公窗口上的额度(豆包办公的额度只在它「订阅与额度管理」那一页上)')
    expect(doubao?.fix).toBeUndefined()
  })
})
