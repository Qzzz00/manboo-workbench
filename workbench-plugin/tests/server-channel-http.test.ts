// @vitest-environment node
/**
 * 通道层经 8791 的那几条路(2026-09-17,docs/交接-0917-LiveKit通道层原型.md):
 *
 *   POST /channel/token     进房凭证。门与建事项同一道;身份由服务端按设备令牌拼,调用方说了不算。
 *   GET  /channel/status    服务器在不在、工人在不在房。
 *   GET  /channel/persona   只给本机的工人。
 *   POST /butler/item/say   通道层第三件工具落脚的地方:给已在办那条事项补一句。
 *
 * livekit-server 整个是桩:这里验的是工作台发出去/回出去的东西。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { CHANNEL_WORKER_IDENTITY, createChannelService } from '../src/server/channel.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER } from '../src/server/rtcCall.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createPairingService } from '../src/server/devices.ts'
import { createChannelWorkerService } from '../src/server/channelWorker.ts'
import { createButlerService } from '../src/server/butler.ts'
import { lanOn } from './helpers/lanOn.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-17T09:00:00Z') / 1000)
const ENV = { WORKBENCH_CHANNEL_API_KEY: 'devkey', WORKBENCH_CHANNEL_API_SECRET: 'secret' }

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface Harness {
  server: WorkbenchServer
  /** 下一条请求装成谁。'local' = 回环,'phone' = 已配对的手机。 */
  who: (value: 'local' | 'phone') => void
  token: string
  deviceId: string
  tasks: ReturnType<typeof createTasksService>
  saidTo: { sessionId: string, text: string }[]
}

async function serve(options: {
  fetchImpl?: typeof fetch
  env?: Record<string, string | undefined>
  sayAccepts?: boolean
  /** 接不接工人的常驻那一层。脚本故意指到一个不存在的路径——这里验的是路由与权限,不是真去拉进程。 */
  worker?: boolean
  /** 接不接本机后端(8792)。`true` = /health 通,`false` = 连不上;不传 = 压根没接线。 */
  butler?: boolean
  /**
   * 服务器下发那一层(2026-09-21)。传一个假 store 就走「凭据从中转来」那条路;
   * 不传 = 只认本机那一份(老行为)。
   */
  remote?: Parameters<typeof createChannelService>[0]['remote']
  /**
   * 理解中枢的假模型(2026-10-29 入口归一):/butler/item 一律进中枢,这几条用例里
   * 手机「建事项」那一步按原话回 note。默认认「订机票」。
   */
  answers?: Parameters<typeof fakeHubModel>[0]
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-channel-http-'))
  dirs.push(dir)
  const agentsFile = join(dir, 'AGENTS.md')
  writeFileSync(agentsFile, '我叫 周到。\n', 'utf8')

  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const pairing = createPairingService({ file: join(dir, 'devices.json'), now: () => NOW_SEC })
  const saidTo: { sessionId: string, text: string }[] = []

  const channel = createChannelService({
    agentsFile,
    tasks,
    env: options.env ?? ENV,
    configFile: join(dir, '不存在.json'),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    nowSeconds: () => NOW_SEC,
    rememberTool: CALL_TOOL_REMEMBER,
    doingTool: CALL_TOOL_DOING,
    ...(options.remote === undefined ? {} : { remote: options.remote }),
  })

  const channelWorker = options.worker === true
    ? createChannelWorkerService({
      script: '/假的/channel-start',
      logFile: '/假的/channel-worker.log',
      scriptExists: async () => false,
      openLog: async () => undefined,
    })
    : undefined

  /**
   * 本机后端(8792)。`/channel/status` 的 `tts_backend` 就是它 `/health` 的结论 ——
   * 与 /state.butler 同一条路,两处不会打架(2026-09-18)。
   */
  const butler = options.butler === undefined
    ? undefined
    : createButlerService({
      configFile: join(dir, 'butler.json'),
      runCommand: async () => ({ ok: false, stdout: '' }),
      cacheMs: 0,
      fetchImpl: (async (url: string) => {
        if (!String(url).endsWith('/health')) throw new Error('这份用例只答 /health')
        if (options.butler !== true) throw new Error('connect ECONNREFUSED 127.0.0.1:8792')
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
    })

  let actor: 'local' | 'phone' = 'local'
  // 入口归一(2026-10-29):/butler/item 进理解中枢,接假模型按原话回命令(默认「订机票」→ note)。
  const model = fakeHubModel(options.answers ?? { '订机票': [{ name: 'note', title: '订机票', status: 'todo' }] })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    pairing,
    channel,
    model: model.service as never,
    fetchImpl: model.fetchImpl,
    ...(channelWorker === undefined ? {} : { channelWorker }),
    ...(butler === undefined ? {} : { butler }),
    butlerSession: {
      open: async () => 'session-1',
      say: async (sessionId, text) => {
        saidTo.push({ sessionId, text })
        return options.sayAccepts ?? true
      },
    },
    // 装本机 / 装手机:同一台服务上换远端地址,与 server-pairing-http 那份同一招。
    remoteAddress: (_req: IncomingMessage) => (actor === 'local' ? '127.0.0.1' : '172.20.10.7'),
    // 2026-10-01:手机热点网段那条来源门例外撤掉了,扮演手机的用例照真机的样子把
    // 「允许手机在局域网访问」开着;验的还是设备令牌那道门(见 helpers/lanOn.ts)。
    lan: lanOn(),
  })
  started.push(server)

  pairing.start()
  const code = pairing.current()?.code ?? ''
  const claimed = await pairing.claim({ code, device_name: '手机', platform: 'android' })
  if (!claimed.ok) throw new Error('测试装置:配对没成')

  return {
    server,
    who: (value) => { actor = value },
    token: claimed.token,
    deviceId: claimed.device_id,
    tasks,
    saidTo,
  }
}

/**
 * 装成「工人替某台设备来办事」:回环 + `X-Workbench-Channel-Device`。
 * 这条路的全部意思就是**降权** —— 和手机自己带令牌打过来该得到的一模一样。
 */
async function asDevice(h: Harness, method: string, path: string, deviceId: string, body?: unknown) {
  const res = await fetch(`${h.server.url}${path}`, {
    method,
    headers: {
      'x-workbench-channel-device': deviceId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
}

async function call(h: Harness, method: string, path: string, body?: unknown, withToken = false) {
  const res = await fetch(`${h.server.url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(withToken ? { authorization: `Bearer ${h.token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
}

function okList(participants: readonly string[]): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ participants: participants.map(identity => ({ identity })) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
}

describe('POST /channel/token', () => {
  it('本机拿到的是测试页身份,回包里有 url/room/token', async () => {
    const h = await serve()
    const { status, body } = await call(h, 'POST', '/channel/token', { suffix: 'chrome' })
    expect(status).toBe(200)
    expect(body.identity).toBe('wb-dev-chrome')
    expect(body.url).toBe('ws://127.0.0.1:7880')
    expect(body.room).toBe('workbench')
    expect(typeof body.token).toBe('string')
    // secret 不能顺着回包漏出去。
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('已配对的手机拿到的身份带它自己的设备 id——它说了不算', async () => {
    const h = await serve()
    h.who('phone')
    const { status, body } = await call(h, 'POST', '/channel/token', { suffix: '我想冒充别人' }, true)
    expect(status).toBe(200)
    expect(String(body.identity).startsWith('wb-phone-')).toBe(true)
    expect(body.identity).not.toBe('wb-dev-我想冒充别人')
  })

  /**
   * 2026-09-27(统筹,维护者:「小米上显示电脑不在线」)。那台小米走**有线 ADB**(`adb reverse tcp:8791`)连电脑,
   * 于是它的请求在这边看是**回环**。原来回环的请求一律不看设备令牌 → 当成本机的测试页,签出一张
   * `wb-dev-page` 的进房凭证;工人只认已配对手机的身份,于是房间代理一直 403,手机上写着
   * 「电脑上的事务官不认这台手机」。**回环上带着有效的设备令牌,就是那台手机**,按手机的身份签。
   */
  it('★回环(有线 ADB 转发)上带着设备令牌 → 按那台手机的身份签,不是测试页', async () => {
    const h = await serve()
    const { status, body } = await call(h, 'POST', '/channel/token', { suffix: 'page' }, true)
    expect(status).toBe(200)
    expect(body.identity).toBe(`wb-phone-${h.deviceId}`)
  })

  it('手机拿不到工人那个身份(拿到就能占着房冒充工人)', async () => {
    const h = await serve()
    h.who('phone')
    const { body } = await call(h, 'POST', '/channel/token', { worker: true }, true)
    expect(body.identity).not.toBe(CHANNEL_WORKER_IDENTITY)
  })

  it('本机带 worker: true 才拿得到工人身份', async () => {
    const h = await serve()
    const { body } = await call(h, 'POST', '/channel/token', { worker: true })
    expect(body.identity).toBe(CHANNEL_WORKER_IDENTITY)
  })

  it('没配 key/secret 时回 503,并说清是没配——不签一张假的', async () => {
    const h = await serve({ env: {} })
    const { status, body } = await call(h, 'POST', '/channel/token', {})
    expect(status).toBe(503)
    expect(String(body.error)).toContain('没配 LiveKit')
  })

  it('没配对的手机连门都进不来(鉴权那一段就 401)', async () => {
    const h = await serve()
    h.who('phone')
    const { status } = await call(h, 'POST', '/channel/token', {})
    expect(status).toBe(401)
  })
})

describe('GET /channel/status', () => {
  it('如实报告服务器与工人', async () => {
    const h = await serve({ fetchImpl: okList([CHANNEL_WORKER_IDENTITY]) })
    const { status, body } = await call(h, 'GET', '/channel/status')
    expect(status).toBe(200)
    expect(body.configured).toBe(true)
    expect(body.server).toBe(true)
    expect(body.worker).toBe(true)
  })

  it('探不到就说探不到,不猜', async () => {
    const h = await serve({ fetchImpl: (async () => { throw new Error('down') }) as unknown as typeof fetch })
    const { body } = await call(h, 'GET', '/channel/status')
    expect(body.server).toBe(false)
    expect(body.worker).toBe(false)
    expect(String(body.note)).toContain('先在本机把 livekit-server 起起来')
  })

  /**
   * 语音后端在不在(2026-09-18,Ben 真机:8792 没起来时引导通话「接不上」)。
   * 手机据此能说一句「这一通可能没有声音」,而不是对着一颗不说话的球干等。
   */
  it('8792 在:tts_backend 是 ok', async () => {
    const h = await serve({ fetchImpl: okList([CHANNEL_WORKER_IDENTITY]), butler: true })
    const { body } = await call(h, 'GET', '/channel/status')
    expect(body.tts_backend).toBe('ok')
  })

  it('8792 连不上:tts_backend 是 down,但**工人那几格照旧**(说不了话的电话仍是一通电话)', async () => {
    const h = await serve({ fetchImpl: okList([CHANNEL_WORKER_IDENTITY]), butler: false })
    const { body } = await call(h, 'GET', '/channel/status')
    expect(body.tts_backend).toBe('down')
    expect(body.worker).toBe(true)
  })

  it('没接本机后端就不说 —— 缺席,不编一个 ok', async () => {
    const h = await serve({ fetchImpl: okList([]) })
    const { body } = await call(h, 'GET', '/channel/status')
    expect(body.tts_backend).toBeUndefined()
  })

  it('配对过的手机也能看状态(它要知道电脑那头在不在)', async () => {
    const h = await serve({ fetchImpl: okList([]) })
    h.who('phone')
    const { status } = await call(h, 'GET', '/channel/status', undefined, true)
    expect(status).toBe(200)
  })
})

describe('GET /channel/persona', () => {
  it('本机(工人)拿得到,人设里有名字', async () => {
    const h = await serve()
    const { status, body } = await call(h, 'GET', '/channel/persona')
    expect(status).toBe(200)
    expect(body.butler_name).toBe('周到')
    expect(String(body.system_message)).toContain('名字叫周到')
    expect(body.welcome).toBe('喂,我是周到,你说。')
  })

  it('手机拿不到——人设里带着他手上所有事项的摘要', async () => {
    const h = await serve()
    h.who('phone')
    const { status, body } = await call(h, 'GET', '/channel/persona', undefined, true)
    expect(status).toBe(403)
    expect(String(body.error)).toContain('只给本机')
  })
})

/**
 * 工人取第三方凭据(2026-09-21)。这条回包里有火山的 access token(识别要直连火山的
 * 流式 WebSocket),所以门比 persona 还硬:**只认回环**。
 */
describe('GET /channel/credentials', () => {
  /** 一个只回一份火山凭据的假 store。值全是编的。 */
  const store = {
    get: async () => ({
      ok: true as const,
      credentials: {
        livekit: { configured: true, url: 'wss://lk.example.test', room: 'wb-1' },
        volc_asr: { app_id: '1234', access_token: 'asr-token-fake' },
        expires_at: '2026-09-17T10:00:00.000Z',
      },
    }),
    issueToken: async () => ({ ok: false as const, reason: 'server' as const, error: '用不到' }),
    view: () => ({ cached: true }),
    forget: () => {},
  } as unknown as NonNullable<Parameters<typeof createChannelService>[0]['remote']>

  it('本机(工人)拿得到火山那一份,**没有 LiveKit 的任何东西**', async () => {
    // env 传空 = 本机没配 key/secret,于是走服务器下发那条路。
    const h = await serve({ env: {}, remote: store })
    const { status, body } = await call(h, 'GET', '/channel/credentials')
    expect(status).toBe(200)
    expect(body.source).toBe('server')
    expect((body.volc_asr as { access_token: string }).access_token).toBe('asr-token-fake')
    expect(body.expires_at).toBe('2026-09-17T10:00:00.000Z')
    expect(JSON.stringify(body)).not.toContain('lk.example.test')
  })

  it('手机拿不到 —— 里头是第三方的 access token', async () => {
    const h = await serve({ env: {}, remote: store })
    h.who('phone')
    const { status, body } = await call(h, 'GET', '/channel/credentials', undefined, true)
    expect(status).toBe(403)
    expect(String(body.error)).toContain('只给本机')
  })
})

describe('POST /butler/item/say', () => {
  async function withItem(options: { sayAccepts?: boolean } = {}) {
    const h = await serve(options)
    // 2026-10-29 入口归一:会话不再随建卡自开 —— 这张卡直接带会话建(本条只钉 /butler/item/say 这条路)。
    const made = await h.tasks.create({ title: '订机票', direction: 'mine', conversation: { agent: 'dsh', session_id: 'session-1' } })
    return { h, id: String(made.id) }
  }

  it('把话送进那条事项底下的会话', async () => {
    const { h, id } = await withItem()
    const { status, body } = await call(h, 'POST', '/butler/item/say', { id, text: '顺便把酒店也订了' })
    expect(status).toBe(200)
    expect(body.session_id).toBe('session-1')
    expect(h.saidTo).toContainEqual({ sessionId: 'session-1', text: '顺便把酒店也订了' })
  })

  it('已配对的手机也能用(工人就是经这条路走的)', async () => {
    const { h, id } = await withItem()
    h.who('phone')
    const { status } = await call(h, 'POST', '/butler/item/say', { id, text: '再加一句' }, true)
    expect(status).toBe(200)
  })

  it('没有这个事项 → 404,不含糊', async () => {
    const h = await serve()
    const { status, body } = await call(h, 'POST', '/butler/item/say', { id: '不存在', text: '话' })
    expect(status).toBe(404)
    expect(body.error).toBe('没有这个事项')
  })

  it('DSH 那边说这条会话没了 → 409,如实说', async () => {
    const { h, id } = await withItem({ sayAccepts: false })
    const { status, body } = await call(h, 'POST', '/butler/item/say', { id, text: '话' })
    expect(status).toBe(409)
    expect(String(body.error)).toContain('已经没了')
  })

  it('参数不对就 400,不去猜他想说什么', async () => {
    const { h, id } = await withItem()
    expect((await call(h, 'POST', '/butler/item/say', { text: '话' })).status).toBe(400)
    expect((await call(h, 'POST', '/butler/item/say', { id, text: '  ' })).status).toBe(400)
    expect((await call(h, 'POST', '/butler/item/say', { id, text: 'x'.repeat(4001) })).status).toBe(400)
  })
})

describe('通道层没接线时', () => {
  it('三条 /channel/* 都是 404「通道层未启用」,不是 500', async () => {
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      heartbeatMs: 0,
    })
    started.push(server)
    for (const [method, path] of [['POST', '/channel/token'], ['GET', '/channel/status'], ['GET', '/channel/persona']] as const) {
      const res = await fetch(`${server.url}${path}`, {
        method,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      })
      expect(res.status).toBe(404)
      expect((await res.json() as { error: string }).error).toBe('通道层未启用')
    }
  })
})

/**
 * 回环降权(2026-09-17,房间代理)。这一段是整条链上最要紧的一处:
 * 工人在回环上,回环是全权;要是不降权,房里任何参与者都等于坐在 Ben 的 Mac 前面。
 */
describe('X-Workbench-Channel-Device(回环降权)', () => {
  it('带上它之后,回环请求只拿得到「那台手机」的权限——回环专属的路当场 403', async () => {
    const h = await serve()
    // 不带头:回环全权,生成配对码没问题
    expect((await call(h, 'POST', '/pair/start')).status).toBe(200)
    // 带上头:降成手机,改信任边界的那条路就不给走了
    const denied = await asDevice(h, 'POST', '/pair/start', h.deviceId)
    expect(denied.status).toBe(403)
    expect(denied.body.error).toBe('只能在本机生成配对码')
  })

  it('人设只给本机的工人:降权之后拿不到(里头是他手上所有事项的摘要)', async () => {
    const h = await serve()
    expect((await call(h, 'GET', '/channel/persona')).status).toBe(200)
    expect((await asDevice(h, 'GET', '/channel/persona', h.deviceId)).status).toBe(403)
  })

  it('手机该能做的照样能做:建事项、补话、看状态', async () => {
    const h = await serve({ fetchImpl: okList([CHANNEL_WORKER_IDENTITY]) })
    // 这一句原先是「记一下明天开会」——2026-10-13(卡 B′)起「记一下…」= 只记一笔、不开会话,
    // 于是「补话」那一步成了 409。这条用例验的是手机那道门,换一句要人去办的话。
    // 2026-10-29 入口归一:建事项那一下进理解中枢(假模型回 note),卡照建。
    const created = await asDevice(h, 'POST', '/butler/item', h.deviceId, { text: '订机票' })
    expect(created.status).toBe(200)
    expect(typeof created.body.id).toBe('string')
    // 补话:/butler/item/say 只往卡上已有的会话里送 —— 入口归一后会话不再随建卡自开,
    // 这张带会话直接建(与 append-lands-20261013.test.ts 的改法同一招)。
    const made = await h.tasks.create({ title: '在办的那件', direction: 'mine', conversation: { agent: 'dsh', session_id: 'session-1' } })
    const said = await asDevice(h, 'POST', '/butler/item/say', h.deviceId, { id: String(made.id), text: '顺便订酒店' })
    expect(said.status).toBe(200)
    expect((await asDevice(h, 'GET', '/channel/status', h.deviceId)).status).toBe(200)
  })

  it('认不出来的设备 id → 401,**绝不退回回环全权**', async () => {
    const h = await serve()
    const res = await asDevice(h, 'POST', '/pair/start', 'no-such-device')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('这台设备没配对过,或者已经解除配对了')
  })

  it('解除配对之后这条路当场断——凭证还没过期也没用', async () => {
    const h = await serve()
    expect((await asDevice(h, 'GET', '/state', h.deviceId)).status).toBe(200)
    expect((await call(h, 'POST', '/pair/revoke', { id: h.deviceId })).status).toBe(200)
    expect((await asDevice(h, 'GET', '/state', h.deviceId)).status).toBe(401)
  })

  it('非回环来源上这条头一个字都不看——那条路本来就要设备令牌', async () => {
    const h = await serve()
    h.who('phone')
    // 手机那一侧就算自己加了这条头,没有 Authorization 照样 401
    const res = await fetch(`${h.server.url}/state`, { headers: { 'x-workbench-channel-device': h.deviceId } })
    expect(res.status).toBe(401)
  })

  it('降权之后签出来的凭证是那台手机的身份,不是工人的', async () => {
    const h = await serve()
    const issued = await asDevice(h, 'POST', '/channel/token', h.deviceId, { worker: true })
    expect(issued.status).toBe(200)
    expect(issued.body.identity).toBe(`wb-phone-${h.deviceId}`)
    expect(issued.body.identity).not.toBe(CHANNEL_WORKER_IDENTITY)
  })
})

describe('进房凭证里的设备属性与有效期', () => {
  it('手机那张凭证里签着 wb_device_id(工人据此决定用谁的权限);本机房间的票 24 小时(2026-10-21)', async () => {
    const h = await serve()
    h.who('phone')
    const issued = await call(h, 'POST', '/channel/token', { name: '手机' }, true)
    const payload = JSON.parse(
      Buffer.from((issued.body.token as string).split('.')[1] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>
    // 2026-09-21 多了 wb_kind(座机形态:手机 + 树莓派话筒)。这台是按 platform 'android'
    // 配对进来的,所以是 phone;树莓派那种是 handset,由工人决定通话的声音走哪台。
    expect(payload.attributes).toEqual({ wb_device_id: h.deviceId, wb_kind: 'phone' })
    // 地址缺省指向这台 Mac(本机房间):在家随时能找 8791 换,票短一点(局域网主路设计稿第二节)。
    expect(payload.exp).toBe(NOW_SEC + 24 * 60 * 60)
    expect(issued.body.expires_at).toBe(NOW_SEC + 24 * 60 * 60)
    // 授权里没有 canUpdateOwnMetadata:能改属性就等于能改自己是谁
    expect(payload.video).toEqual({ room: 'workbench', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true })
  })

  it('本机有钥匙、地址指向云上那台(拷来的那份):有效期照旧 7 天 —— 那间房在外面也进得去,续期得先进房', async () => {
    const h = await serve({ env: { ...ENV, WORKBENCH_CHANNEL_URL: 'wss://lk.example.cn' } })
    h.who('phone')
    const issued = await call(h, 'POST', '/channel/token', {}, true)
    expect(issued.body.expires_at).toBe(NOW_SEC + 7 * 24 * 60 * 60)
    expect(issued.body.url).toBe('wss://lk.example.cn')
  })

  it('工人自己那张不带设备属性——它不是一台设备,也不该被降权成谁', async () => {
    const h = await serve()
    const issued = await call(h, 'POST', '/channel/token', { worker: true })
    const payload = JSON.parse(
      Buffer.from((issued.body.token as string).split('.')[1] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>
    expect(payload.attributes).toBeUndefined()
    expect(payload.sub).toBe(CHANNEL_WORKER_IDENTITY)
  })

  it('有效期可配(秒),越界夹回上下界', async () => {
    const h = await serve({ env: { ...ENV, WORKBENCH_CHANNEL_TOKEN_TTL: '3600' } })
    const issued = await call(h, 'POST', '/channel/token', {})
    expect(issued.body.expires_at).toBe(NOW_SEC + 3600)
    const tiny = await serve({ env: { ...ENV, WORKBENCH_CHANNEL_TOKEN_TTL: '1' } })
    expect((await call(tiny, 'POST', '/channel/token', {})).body.expires_at).toBe(NOW_SEC + 60)
  })
})

describe('/channel/status 的 mode 与 process', () => {
  it('地址指着回环就是 local,指着别人家的机器就是 remote', async () => {
    const local = await serve({ fetchImpl: okList([CHANNEL_WORKER_IDENTITY]) })
    expect((await call(local, 'GET', '/channel/status')).body.mode).toBe('local')
    const remote = await serve({
      fetchImpl: okList([]),
      env: { ...ENV, WORKBENCH_CHANNEL_URL: 'wss://lk.aibooo.cn' },
    })
    const status = (await call(remote, 'GET', '/channel/status')).body
    expect(status.mode).toBe('remote')
    expect(status.url).toBe('wss://lk.aibooo.cn')
  })

  it('远程连不上时那句话说的是碰头点,不是「先起本机服务器」', async () => {
    const remote = await serve({
      fetchImpl: (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch,
      env: { ...ENV, WORKBENCH_CHANNEL_URL: 'wss://lk.aibooo.cn' },
    })
    const status = (await call(remote, 'GET', '/channel/status')).body
    expect(status.server).toBe(false)
    expect(status.note).toContain('lk.aibooo.cn')
  })

  it('接了常驻那一层就多一格 process;手机也看得见(它要知道电脑那头有没有人接)', async () => {
    const h = await serve({ fetchImpl: okList([]), worker: true })
    const local = (await call(h, 'GET', '/channel/status')).body
    expect((local.process as { running: boolean }).running).toBe(false)
    h.who('phone')
    const phone = await call(h, 'GET', '/channel/status', undefined, true)
    expect(phone.status).toBe(200)
    expect((phone.body.process as { script: string }).script).toBe('/假的/channel-start')
  })
})

describe('/channel/start|stop|worker', () => {
  it('只认回环:手机按不了这个开关', async () => {
    const h = await serve({ fetchImpl: okList([]), worker: true })
    h.who('phone')
    expect((await call(h, 'POST', '/channel/start', {}, true)).status).toBe(403)
    expect((await call(h, 'GET', '/channel/worker', undefined, true)).status).toBe(403)
  })

  it('start 拉不起来时如实回 { ok:false, error },HTTP 层还是 200', async () => {
    const h = await serve({ fetchImpl: okList([]), worker: true })
    const res = await call(h, 'POST', '/channel/start', {})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toContain('deploy/channel-start')
  })

  it('没接常驻那一层时是 404「工人常驻未接线」,不是 500', async () => {
    const h = await serve({ fetchImpl: okList([]) })
    expect((await call(h, 'POST', '/channel/start', {})).status).toBe(404)
    expect((await call(h, 'GET', '/channel/worker')).status).toBe(404)
  })
})
