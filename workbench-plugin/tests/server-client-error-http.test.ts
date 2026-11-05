// @vitest-environment node
/**
 * `POST /client/error` 与 `/state.client_errors`(2026-09-25,卡 V)—— **客户端报错走一遍**。
 *
 * 09-25 晚维护者点「事务官」没反应、页面卡死,而**没有任何地方记录**。壳是 WKWebView,
 * 那个控制台他打不开、统筹也看不到;第二天只能靠他复述「点了没反应」。
 * 这一份守四件事:
 * ① 报一条进得去,`/state.client_errors` 立刻看得到(统筹 `curl` 查的就是这一格);
 * ② **报错这条路绝不给页面添一个新的失败** —— 坏 JSON、空 body、只有半句话,一律 200;
 * ③ 同一条折叠成一行只加计数(一条死循环不许冲掉别的);
 * ④ 「执行 n」那一格(`/state.running`)与「等你」并排在同一份快照里现算。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientErrorView, RunningView } from '../src/protocol.ts'
import { PHONE_CELLS } from '../src/phoneCells.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const LOOPBACK = '127.0.0.1'
const NOW_SEC = Math.floor(Date.parse('2026-09-25T13:00:00Z') / 1000)

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

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-client-error-'))
  dirs.push(dir)
  const service = createWorkbenchService({ now: () => NOW_SEC })
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    lan: { config, mdns: fakeMdns(), lanAddress: () => '10.86.37.27', name: '测试工作台', version: '0.0.0' },
    remoteAddress: () => LOOPBACK,
  })
  started.push(server)
  const call = async (path: string, init: { method?: string, body?: string, raw?: string } = {}) => {
    const body = init.raw ?? init.body
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body }),
    })
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const errors = async (): Promise<readonly ClientErrorView[]> =>
    ((await call('/state')).body.client_errors ?? []) as readonly ClientErrorView[]
  return { call, errors }
}

describe('POST /client/error', () => {
  it('★报一条 → /state.client_errors 立刻看得到(统筹 curl 查的就是这一格)', async () => {
    const t = await serve()
    expect(await t.errors()).toEqual([])
    const res = await t.call('/client/error', {
      body: JSON.stringify({ message: '点「事务官」没反应', stack: 'TypeError: x\n    at Butler\n    at Overlay', view: 'butler', where: 'desktop' }),
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const list = await t.errors()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      at: '2026-09-25T13:00:00.000Z',
      where: 'desktop',
      message: '点「事务官」没反应',
      view: 'butler',
      count: 1,
    })
    expect(list[0]?.stack).toContain('at Butler')
  })

  it('手机报的记成 phone(出了局域网经房间代理进来的也是这一条)', async () => {
    const t = await serve()
    await t.call('/client/error', { body: JSON.stringify({ message: '首页白屏', where: 'phone' }) })
    expect((await t.errors())[0]).toMatchObject({ where: 'phone', message: '首页白屏' })
  })

  it('★同一条折叠成一行只加计数 —— 一条死循环不许冲掉别的', async () => {
    const t = await serve()
    for (let i = 0; i < 12; i++) {
      await t.call('/client/error', { body: JSON.stringify({ message: '每帧都抛', stack: 'at Orb' }) })
    }
    await t.call('/client/error', { body: JSON.stringify({ message: '另一条', stack: 'at Inbox' }) })
    const list = await t.errors()
    expect(list).toHaveLength(2)
    expect(list.find(one => one.message === '每帧都抛')?.count).toBe(12)
  })

  it('★坏 JSON / 空 body / 连一句话都没有:一律 200,不记 —— 报错这条路绝不给页面添一个新的失败', async () => {
    const t = await serve()
    expect((await t.call('/client/error', { raw: '{ 这不是 JSON' })).status).toBe(200)
    expect((await t.call('/client/error', { raw: '' })).status).toBe(200)
    expect((await t.call('/client/error', { body: JSON.stringify({}) })).status).toBe(200)
    expect((await t.call('/client/error', { body: JSON.stringify({ message: '   ' }) })).status).toBe(200)
    expect(await t.errors()).toEqual([])
  })

  it('回的只有 {ok:true} —— 不给页面任何可解析、可再出错的东西', async () => {
    const t = await serve()
    const res = await t.call('/client/error', { body: JSON.stringify({ message: '一条' }) })
    expect(Object.keys(res.body)).toEqual(['ok'])
  })
})

describe('/state 里那两格', () => {
  it('「执行 n」与「等你」并排在同一份快照里现算', async () => {
    const t = await serve()
    const state = (await t.call('/state')).body
    // 一件在跑的都没有:`items` 空、`count` 是 0(任务板接上了、快照没冻结 → 数得出来,那就说 0)。
    expect(state.running as RunningView).toMatchObject({ items: [] })
    expect(state.waiting).toMatchObject({ count: 0 })
    expect(state.client_errors).toEqual([])
  })

  /**
   * 球那一格(2026-10-04,卡「球的颜色一处算」):**真从 /state 出来**,不只是纯函数里算得出。
   * 电脑与手机都只显示它,所以它在不在这份响应里就是这条接缝本身。判据的用例在
   * `tests/orb-one-truth-20261004.test.ts` 与 `butler-app/tests/orbOneTruthParity.test.ts`。
   */
  it('球那一格也在同一份快照里(两端只显示它,不各自推算)', async () => {
    const t = await serve()
    const state = (await t.call('/state')).body
    // 什么都没发生的一台机器:中性、没在办、一件都没受阻。
    expect(state.orb).toEqual({
      notice: 'neutral', working: false, blocked: 0, active_failure: false, waiting: false, calling: false,
    })
  })

  /** 「哪一版起手机才有这一格」那张表(2026-10-09):手机拿自己的版本比,落后就提示更新手机端。 */
  it('手机才显示的那几格从哪一版起有,也在同一份快照里', async () => {
    const t = await serve()
    const state = (await t.call('/state')).body
    expect(state.phone_cells).toEqual(PHONE_CELLS)
  })
})
