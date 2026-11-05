// @vitest-environment node
/**
 * GET /butler/item/:id/turns(2026-09-15):手机端事务官要念的那段对话。
 *
 * 出处:docs/交接-0914-butler-app.md 第五节第 1 条。守三件事:
 * ① 门与其它 /butler 写路由同一道——回环或带令牌的已配对设备;局域网裸请求 401;
 * ② 事项不存在 / 事项没开会话 / 会话在 DSH 里已经没了 → 404,各说各的原因,不混;
 * ③ limit 默认 20、上限 100,回合正文来自 dshSessionFeed(与 /state.sessions[].summary 同一来源)。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionTurn, WorkbenchState } from '../src/protocol.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createPairingService } from '../src/server/devices.ts'
import { createDshSessionFeed } from '../src/server/dshSessionFeed.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'
const NOW_SEC = Math.floor(Date.parse('2026-09-15T09:00:00Z') / 1000)

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

function userMessage(text: string) {
  return { type: 'user/message', seq: 1, data: { id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }
}
function assistantMessage(text: string, seq = 2) {
  return { type: 'assistant/message', seq, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } } }
}

interface ServeOptions {
  withTasks?: boolean
  withTurns?: boolean
  withPairing?: boolean
  /** 建事项时开出来的会话 id;undefined = 开不出来(事项没有 conversation)。 */
  sessionId?: string | undefined
}

async function serve(options: ServeOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-butler-turns-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const service = createWorkbenchService({ now: () => NOW_SEC })
  // 与生产同一条线:feed 的 applyEvent 直接进 service,summary 与回合都出自这一个 feed。
  const feed = createDshSessionFeed({ applyEvent: event => service.applyEvent(event), setMetrics: () => {}, now: () => NOW_SEC })
  const remote = { address: LOOPBACK }
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const sessionId = 'sessionId' in options ? options.sessionId : 's-1'
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    heartbeatMs: 0,
    ...(options.withTasks === false ? {} : { tasks }),
    ...(options.withTurns === false ? {} : { sessionTurns: (id: string, limit: number) => feed.turns(id, limit) }),
    butlerSession: { open: async () => sessionId },
    ...(options.withPairing === false
      ? {}
      : {
          pairing,
          lan: { config, mdns: fakeMdns(), lanAddress: () => '10.86.37.27', name: '测试工作台', version: '0.0.0' },
        }),
    remoteAddress: () => remote.address,
  })
  started.push(server)

  const call = async (path: string, init: { method?: string, body?: string, token?: string, from?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const pair = async () => {
    expect((await call('/lan', { body: JSON.stringify({ enabled: true }) })).status).toBe(200)
    const startRes = await call('/pair/start', { method: 'POST' })
    const code = (startRes.body.pairing as { code: string }).code
    const claim = await call('/pair/claim', { body: JSON.stringify({ code, device_name: 'Ben 的 iPhone', platform: 'ios' }), from: PHONE })
    expect(claim.status).toBe(200)
    return claim.body.token as string
  }
  const createItem = async (text = '把展示台的黄历接上') => {
    const res = await call('/butler/item', { body: JSON.stringify({ text }) })
    expect(res.status).toBe(200)
    return res.body.id as string
  }
  /** 模拟 DSH 那头:会话建了、他说了一句、模型答了一段、回合结束。 */
  const converse = (id: string, reply: string) => {
    feed.handleCreated(id, '/tmp/x')
    feed.handleEvent(id, { type: 'turn/start', seq: 0 })
    feed.handleEvent(id, userMessage('把展示台的黄历接上'))
    feed.handleEvent(id, assistantMessage(reply))
    feed.handleEvent(id, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
  }
  return { url: server.url, call, pair, createItem, converse, feed, service }
}

describe('GET /butler/item/:id/turns', () => {
  it('★本机来源:回该事项那条会话的回合列表,与 /state.sessions[].summary 同一来源', async () => {
    const t = await serve()
    const id = await t.createItem()
    t.converse('s-1', '黄历接上了,展示台已经能显示。')

    const res = await t.call(`/butler/item/${id}/turns`)
    expect(res.status).toBe(200)
    expect(res.body.session_id).toBe('s-1')
    const turns = res.body.turns as SessionTurn[]
    expect(turns).toEqual([
      { role: 'user', text: '把展示台的黄历接上', at: '2026-09-15T09:00:00.000Z' },
      { role: 'assistant', text: '黄历接上了,展示台已经能显示。', at: '2026-09-15T09:00:00.000Z' },
    ])

    const state = (await (await fetch(`${t.url}/state`)).json()) as WorkbenchState
    const session = state.sessions.find(s => s.agent === 'dsh' && s.session_id === 's-1')
    expect(session?.summary).toBe('黄历接上了,展示台已经能显示。')
  })

  it('★局域网裸请求 401;带设备令牌 200', async () => {
    const t = await serve()
    const token = await t.pair()
    const id = await t.createItem()
    t.converse('s-1', '好了。')

    expect((await t.call(`/butler/item/${id}/turns`, { from: PHONE })).status).toBe(401)
    const ok = await t.call(`/butler/item/${id}/turns`, { from: PHONE, token })
    expect(ok.status).toBe(200)
    expect((ok.body.turns as SessionTurn[]).map(turn => turn.text)).toEqual(['把展示台的黄历接上', '好了。'])
  })

  it('没接配对服务时,非本机来源 403(与其它 /butler 写路由同门)', async () => {
    const t = await serve({ withPairing: false })
    const id = await t.createItem()
    expect((await t.call(`/butler/item/${id}/turns`, { from: PHONE })).status).toBe(403)
  })

  it('事项不存在 → 404「没有这个事项」', async () => {
    const t = await serve()
    const res = await t.call('/butler/item/t-404/turns')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('没有这个事项')
  })

  it('事项建了但会话没开 → 404「会话未开」', async () => {
    const t = await serve({ sessionId: undefined })
    const id = await t.createItem()
    const res = await t.call(`/butler/item/${id}/turns`)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('会话未开')
  })

  it('★事项记着会话,但 DSH 这边已经没有它(重启 / 已释放)→ 404「没有这个会话」', async () => {
    const t = await serve()
    const id = await t.createItem()
    // 从没 handleCreated,feed 不认识 s-1。
    const res = await t.call(`/butler/item/${id}/turns`)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('没有这个会话')
  })

  it('会话在、还没说过话 → 200 空列表(不是 404:会话是真的有)', async () => {
    const t = await serve()
    const id = await t.createItem()
    t.feed.handleCreated('s-1')
    const res = await t.call(`/butler/item/${id}/turns`)
    expect(res.status).toBe(200)
    expect(res.body.turns).toEqual([])
  })

  it('★limit 默认 20、上限 100,非法值按默认', async () => {
    const t = await serve()
    const id = await t.createItem()
    t.feed.handleCreated('s-1')
    for (let i = 0; i < 130; i++) t.feed.handleEvent('s-1', { ...userMessage(`第 ${i} 句`), seq: i })

    const dflt = (await t.call(`/butler/item/${id}/turns`)).body.turns as SessionTurn[]
    expect(dflt).toHaveLength(20)
    expect(dflt.at(-1)?.text).toBe('第 129 句')

    expect(((await t.call(`/butler/item/${id}/turns?limit=5`)).body.turns as SessionTurn[]).map(turn => turn.text))
      .toEqual(['第 125 句', '第 126 句', '第 127 句', '第 128 句', '第 129 句'])
    expect((await t.call(`/butler/item/${id}/turns?limit=500`)).body.turns).toHaveLength(100)
    expect((await t.call(`/butler/item/${id}/turns?limit=abc`)).body.turns).toHaveLength(20)
    expect((await t.call(`/butler/item/${id}/turns?limit=0`)).body.turns).toHaveLength(20)
  })

  it('没接任务看板 → 404「任务看板未启用」;没接 DSH 会话 → 404「DSH 会话未接线」', async () => {
    const noTasks = await serve({ withTasks: false })
    expect((await noTasks.call('/butler/item/t-1/turns')).body.error).toBe('任务看板未启用')

    const noTurns = await serve({ withTurns: false })
    const id = await noTurns.createItem()
    const res = await noTurns.call(`/butler/item/${id}/turns`)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('DSH 会话未接线')
  })

  it('只认 GET;POST 到这条路径 404「没有这个路径」', async () => {
    const t = await serve()
    const id = await t.createItem()
    const res = await t.call(`/butler/item/${id}/turns`, { body: '{}' })
    expect(res.status).toBe(404)
  })

  it('★收件箱里那条事项的 summary 与 /state.sessions[] 的一致(同一来源)', async () => {
    const t = await serve()
    await t.createItem()
    // 会话停在等审批:收件箱「等着的会话」那一档会出现它。
    t.feed.handleCreated('s-1', '/tmp/x')
    t.feed.handleEvent('s-1', { type: 'turn/start', seq: 0 })
    t.feed.handleEvent('s-1', assistantMessage('第一回合:先看了一遍代码。'))
    t.feed.handleEvent('s-1', { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
    t.feed.handleEvent('s-1', { type: 'turn/start', seq: 4 })
    t.feed.handleEvent('s-1', { type: 'approval/asked', seq: 5, data: { id: 'a1', toolName: 'edit' } })

    const state = (await (await fetch(`${t.url}/state`)).json()) as WorkbenchState
    const session = state.sessions.find(s => s.session_id === 's-1')
    expect(session?.status).toBe('waiting')
    expect(session?.summary).toBe('第一回合:先看了一遍代码。')
    const item = state.butler_inbox?.items.find(entry => entry.id === 'session:s-1')
    expect(item?.summary).toBe('第一回合:先看了一遍代码。')
  })

  /**
   * 升到 0.1.7(卡 U3):把 `tests/fixtures/dsh-session-v4/session.v4.jsonl` 里那一整份**真 V4 事件流**
   * 原样喂进 feed,再走这条接口 —— 手机上念到的就该只有人说的那一句和她答的那两段。
   * 那份文件是用上游 0.1.7-rc.2 自己的编解码器生成、自己的校验器验过的(见夹具目录 README.md)。
   */
  it('★V4 真事件流喂进来:接口照旧工作,notice / 时间上下文 / 工具结果一条都不露', async () => {
    const t = await serve()
    const id = await t.createItem()
    const lines = readFileSync(join(import.meta.dirname, 'fixtures/dsh-session-v4/session.v4.jsonl'), 'utf8')
      .split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
    const [header, ...events] = lines
    expect(header?.version).toBe(4) // 拿的确实是 4 代那一份
    t.feed.handleCreated('s-1', { cwd: header?.cwd as string })
    for (const event of events) t.feed.handleEvent('s-1', event as { type: string, seq?: number, data?: unknown })

    const res = await t.call(`/butler/item/${id}/turns`)
    expect(res.status).toBe(200)
    expect((res.body.turns as SessionTurn[]).map(turn => [turn.role, turn.text])).toEqual([
      ['user', '把回归跑一遍'],
      ['assistant', '好,我先改一个文件,再起后台任务跑测试。'],
      ['assistant', '测试全绿,438 个文件都过了。'],
    ])
    // 她说的最后一段照旧是 summary;那条 notice 的原文一个字都没进去
    const state = (await (await fetch(`${t.url}/state`)).json()) as WorkbenchState
    const session = state.sessions.find(s => s.session_id === 's-1')
    expect(session?.summary).toBe('测试全绿,438 个文件都过了。')
    expect(session?.title).toBe('跑一遍回归')
    // notice 的原文一个字都没落到 /state 里(手机字幕读的就是这一份)
    // 「改了 n 个文件」那一格由 setMetrics 送,这个 harness 把它接成空函数,所以在
    // dsh-session-v4.test.ts 里对同一份夹具单独验(那里拿得到真的 setMetrics)。
    expect(JSON.stringify(state)).not.toContain('job_output')
  })
})
