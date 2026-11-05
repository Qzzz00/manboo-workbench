// @vitest-environment node
/**
 * 三件主路接在 8791 上(2026-10-21,卡「引导三件事」):
 *   · `GET /first-use` 一条接口读出「这台机器三件事各成没成、第几天成的」(从行为账算),`/state.first_use` 给界面;
 *   · `POST /first-use/prefer` 记她答的「想先试哪一件」;
 *   · 电话那一件:电话工人在通话里建成一张卡 / 捎出一句话就记「成」;没配过手机的人在电脑上对她说一句建成事项也算;
 *   · 实验开关(`/state.experiments`、`POST /experiments`):会议录音、座机听筒挡在入口。
 *     ★ 2026-10-29 入口归一(批 3):旧 /butler/item 主路上的视频 / 点名豆包·Kimi(window_dispatch)门
 *     随词表快路径删除,中枢主路不查这些门 —— 对应两条用例已删,理由见「实验开关」一节内的注记;
 *   · 自检:`POST /first-use/selfcheck` 起一遍、`GET` 读三行。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXPERIMENT_OFF_LINE } from '../src/mainPaths.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createBehaviorLog } from '../src/server/behaviorLog.ts'
import { CHANNEL_DEVICE_HEADER } from '../src/server/channel.ts'
import { createPairingService } from '../src/server/devices.ts'
import { MAIN_PATH_EVENT, createFirstUseService } from '../src/server/firstUse.ts'
import { ACTOR_TOKEN_HEADER } from '../src/server/herself.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'
const PAGE = { origin: 'http://127.0.0.1:3080' }
const WORKER = { [ACTOR_TOKEN_HEADER]: 'worker-token' }

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fakeMdns(): MdnsAdvertiser {
  let on = false
  return { async start() { on = true }, async stop() { on = false }, active: () => on }
}

async function serve(opts: { sourceRepo?: boolean, ports?: Parameters<typeof startWorkbenchServer>[0]['firstUsePorts'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-first-use-http-'))
  dirs.push(dir)
  const behaviorLog = createBehaviorLog({ dir: join(dir, '行为账') })
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const firstUse = createFirstUseService({ file: join(dir, 'first-use.json'), behaviorLog })
  const remote = { address: LOOPBACK }
  // 2026-10-29 入口归一:POST /butler/item 一律进理解中枢(不再查实验门,批 3),接假模型按原话回 note 建卡。
  const noteOf = (text: string) => [{ name: 'note', title: text, status: 'todo' }] as Record<string, unknown>[]
  const model = fakeHubModel({
    '周五前盯一下报销单': noteOf('周五前盯一下报销单'),
    '电脑上说的': noteOf('电脑上说的'),
    '出门说的': noteOf('出门说的'),
    '下周三提醒我交房租': noteOf('下周三提醒我交房租'),
  })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    tasks,
    behaviorLog,
    firstUse,
    // ready() 是给「三件主路」 readiness 看的(model.ready ?? model.status):假模型补一个,缺了 GET /first-use 会 500。
    model: { ...model.service, ready: async () => true } as never,
    fetchImpl: model.fetchImpl,
    ...(opts.ports === undefined ? {} : { firstUsePorts: opts.ports }),
    appConfig: config,
    sourceRepo: async () => opts.sourceRepo ?? false,
    actorTokens: { butler: 'butler-token', worker: 'worker-token' },
    lan: { config, mdns: fakeMdns(), lanAddress: () => '10.0.0.2', name: '测试工作台', version: '0.0.0' },
    remoteAddress: () => remote.address,
  })
  started.push(server)
  const call = async (path: string, init: { body?: unknown, headers?: Record<string, string>, from?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const pair = async (platform = 'android') => {
    expect((await call('/lan', { body: { enabled: true } })).status).toBe(200)
    const code = ((await call('/pair/start', { body: {} })).body.pairing as { code: string }).code
    const claim = await call('/pair/claim', { body: { code, device_name: '她的手机', platform }, from: PHONE })
    return { status: claim.status, body: claim.body, token: claim.body.token as string, id: claim.body.device_id as string }
  }
  const state = async () => (await call('/state')).body as unknown as WorkbenchState
  // 电话那一件从回包里「先 200 再异步记」(watchCallPath → firstUse.record 走文件):读账前轮询到行数够(或超时)。
  const ledger = async (want = 0) => {
    for (let i = 0; i < 50; i++) {
      await behaviorLog.flush()
      const rows = (await behaviorLog.read({})).filter(one => one.事 === MAIN_PATH_EVENT)
      if (rows.length >= want) return rows
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await behaviorLog.flush()
    return (await behaviorLog.read({})).filter(one => one.事 === MAIN_PATH_EVENT)
  }
  return { call, pair, tasks, state, ledger, config }
}

describe('GET /first-use:三件事各成没成、第几天成的', () => {
  it('还没用过:三件都没成,按默认顺序;没配手机 → 电话那一件在电脑上说', async () => {
    const t = await serve()
    const got = await t.call('/first-use')
    expect(got.status).toBe(200)
    const view = got.body.view as { order: string[], call_mode: string, paths: { path: string, state: string }[] }
    expect(view.order).toEqual(['morning', 'delegate', 'call'])
    expect(view.call_mode).toBe('desk')
    const ledger = got.body.ledger as { paths: Record<string, { ok: boolean }>, source: string }
    expect(ledger.source).toBe('ledger')
    expect(Object.values(ledger.paths).every(one => !one.ok)).toBe(true)
    // /state 上同一份。
    expect((await t.state()).first_use?.order).toEqual(['morning', 'delegate', 'call'])
  })

  it('手机读不到(只给本机与配对过的设备)—— 认不出的来源 403', async () => {
    const t = await serve()
    expect((await t.call('/first-use', { from: PHONE })).status).toBe(403)
  })

  it('她答了「想先试哪一件」:那一件排第一;认不出的值 400', async () => {
    const t = await serve()
    expect((await t.call('/first-use/prefer', { body: { path: '打个电话' }, headers: PAGE })).status).toBe(200)
    expect((await t.state()).first_use?.order).toEqual(['call', 'morning', 'delegate'])
    expect((await t.call('/first-use/prefer', { body: { path: 42 }, headers: PAGE })).status).toBe(400)
    // 「都行」= 清掉,回默认。
    expect((await t.call('/first-use/prefer', { body: { path: '都行' }, headers: PAGE })).status).toBe(200)
    expect((await t.state()).first_use?.order).toEqual(['morning', 'delegate', 'call'])
  })
})

describe('电话那一件', () => {
  it('电话工人在通话里建成一张卡 = 成,记「电话」', async () => {
    const t = await serve()
    await t.pair()
    const made = await t.call('/butler/item', { body: { text: '周五前盯一下报销单', source: 'call' }, headers: WORKER })
    expect(made.status).toBe(200)
    const ledger = await t.ledger(1)
    expect(ledger).toEqual([expect.objectContaining({ 端: '电话', 对象: '电话', 结果: '成' })])
    const call = (await t.state()).first_use?.paths.find(one => one.path === 'call')
    expect(call).toMatchObject({ state: 'ok', ok_day: 1 })
  })

  it('配着手机时,电脑上打的那一句不算这一件;手机出门经工人代发的也不算(那是手机,不是电话)', async () => {
    const t = await serve()
    const phone = await t.pair()
    await t.call('/butler/item', { body: { text: '电脑上说的' }, headers: PAGE })
    await t.call('/butler/item', { body: { text: '出门说的' }, headers: { [CHANNEL_DEVICE_HEADER]: phone.id, ...WORKER } })
    expect(await t.ledger()).toEqual([])
  })

  it('没配过手机的人:在电脑上对她说一句建成事项 = 这一件成了,记「电脑」', async () => {
    const t = await serve()
    await t.call('/butler/item', { body: { text: '下周三提醒我交房租' }, headers: PAGE })
    expect(await t.ledger(1)).toEqual([expect.objectContaining({ 端: '电脑', 对象: '电话', 结果: '成' })])
    expect((await t.state()).first_use?.paths.find(one => one.path === 'call')?.state).toBe('ok')
  })
})

describe('实验开关', () => {
  it('外部机器默认四样全关;本机能逐样打开', async () => {
    const t = await serve()
    expect((await t.state()).experiments).toEqual({ audience: 'external', on: { video: false, meeting: false, handset: false, window_dispatch: false } })
    expect((await t.call('/experiments', { body: { key: 'video', on: true }, headers: PAGE })).status).toBe(200)
    expect((await t.state()).experiments?.on.video).toBe(true)
    expect((await t.call('/experiments', { body: { key: 'nonsense', on: true }, headers: PAGE })).status).toBe(400)
    // 手机改不了这台电脑的开关。
    const phone = await t.pair()
    expect((await t.call('/experiments', { body: { key: 'meeting', on: true }, headers: { authorization: `Bearer ${phone.token}` }, from: PHONE })).status).toBe(403)
  })

  it('有源码仓库的机器(维护者那台)默认全开', async () => {
    const t = await serve({ sourceRepo: true })
    expect((await t.state()).experiments?.on).toEqual({ video: true, meeting: true, handset: true, window_dispatch: true })
  })

  /*
   * ★ 2026-10-29 入口归一(批 3)删:旧 /butler/item 主路上的视频 / 点名豆包·Kimi(window_dispatch)实验门
   * 随词表快路径一并删除 —— 中枢主路不查这些门,这两条约「她说一句 → 回还在内测、一张卡都不建」的行为没有入口了。
   * 会议录音(/meeting/start)与座机听筒(配对)的门仍在各自的入口,下面两条照旧。
   */

  it('会议录音关着:开录那一下就挡住', async () => {
    const t = await serve()
    const got = await t.call('/meeting/start', { body: {}, headers: PAGE })
    expect(got.status).toBe(409)
    expect(got.body).toMatchObject({ error: EXPERIMENT_OFF_LINE, experiment_off: 'meeting' })
  })

  it('座机听筒关着:座机来配对挡住;开了照常配', async () => {
    const t = await serve()
    const blocked = await t.pair('handset')
    expect(blocked.status).toBe(403)
    expect(blocked.body).toMatchObject({ error: EXPERIMENT_OFF_LINE, experiment_off: 'handset' })
    await t.call('/experiments', { body: { key: 'handset', on: true }, headers: PAGE })
    expect((await t.pair('handset')).status).toBe(200)
  })
})

describe('自检', () => {
  it('起一遍,读回三行(成 / 没成 + 缺哪道门),只给本机', async () => {
    const t = await serve({
      ports: {
        morning: async () => ({ ok: true }),
        delegate: async () => ({ started: false, door: 'ai_login' }),
        call: async () => ({ ok: false, door: 'phone' }),
      },
    })
    const kicked = await t.call('/first-use/selfcheck', { body: {} })
    expect(kicked.status).toBe(202)
    let view: { lines?: string[], ended_at?: string } = {}
    for (let i = 0; i < 50 && view.ended_at === undefined; i++) {
      view = (await t.call('/first-use/selfcheck')).body as typeof view
      if (view.ended_at === undefined) await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(view.lines).toHaveLength(3)
    expect(view.lines?.[0]).toBe('早报与播客:成')
    expect(view.lines?.[1]).toMatch(/^交代一件事:没成 —— 没登录 Claude 或 Codex/)
    expect(view.lines?.[2]).toMatch(/^打个电话:没成 —— 手机没配对/)
    expect((await t.call('/first-use/selfcheck', { from: PHONE })).status).toBe(403)
  })
})
