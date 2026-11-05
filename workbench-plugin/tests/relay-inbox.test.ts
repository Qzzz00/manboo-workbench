// @vitest-environment node
/**
 * 协作区跨机底座的客户端(2026-10-21,中转卡)。对着一个假中转跑,盯:
 *   1. 游标文件:从记的位置起补齐、先落账后推游标、apply 抛错游标不动、写坏的文件当 0;
 *   2. 410 → resync,快照游标拨回去再续;
 *   3. 请求:拉到 → handle → 回结果 → 推游标;handle 回 undefined 不回结果;
 *   4. 错误形状:409 wrong_owner 带回现任;连不上 status 0;
 *   5. 令牌只在请求头里,不进 URL;频道 / 对象 id 里的 `/`、`:` 编码进路径。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { InboxEvent, InboxRequest } from '../src/protocol.ts'
import {
  channelSnapshot,
  defaultRelayInboxFile,
  newRelayRequestId,
  postChannelMessage,
  pushObjectEvent,
  readRelayInboxState,
  resetRelayInboxCursor,
  sendInboxRequest,
  syncInboxEvents,
  syncInboxRequests,
} from '../src/server/relayInbox.ts'

const TOKEN = 'wb_fake-device-token'

interface Seen { method: string, url: string, auth?: string, body?: unknown }

function fakeRelay() {
  const seen: Seen[] = []
  const events: InboxEvent[] = []
  const requests: InboxRequest[] = []
  const results: Array<{ request_id: string, state: string, result?: unknown }> = []
  const state = { floor: 0 }
  const addEvent = (text: string) => {
    const cursor = events.length + 1
    events.push({ cursor, kind: 'channel.message', object_id: 'ws:1/ch:1', object_version: cursor, origin: { device: 'b-mac' }, payload: { id: `m${cursor}`, text }, at: '2026-10-21T00:00:00.000Z' })
  }
  const addRequest = (id: string) => {
    requests.push({ cursor: requests.length + 1, request_id: id, to_account: 'A', from_account: 'B', from_device: 'b-phone', op: 'task.comment', object_id: 'aaaaaaaa:t-1', args: { text: id }, at: '2026-10-21T00:00:00.000Z', state: 'queued' })
  }
  const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const read = (req: IncomingMessage) => new Promise<unknown>((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => resolve(raw === '' ? undefined : JSON.parse(raw)))
  })
  const server: Server = createServer(async (req, res) => {
    const body = await read(req)
    seen.push({ method: req.method ?? '', url: req.url ?? '', ...(req.headers.authorization === undefined ? {} : { auth: req.headers.authorization }), ...(body === undefined ? {} : { body }) })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: { message: '不认识', code: 'invalid_relay_token' } })
    const url = new URL(req.url ?? '/', 'http://x')
    const since = Number(url.searchParams.get('since') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? 200)
    if (url.pathname === '/v1/inbox/events') {
      if (since < state.floor) return send(res, 410, { error: { message: '太久了', code: 'cursor_expired', floor: state.floor } })
      const page = events.filter(e => e.cursor > since).slice(0, limit + 1)
      const out = page.slice(0, limit)
      return send(res, 200, { events: out, next_cursor: out.at(-1)?.cursor ?? since, more: page.length > limit, head: events.length })
    }
    if (url.pathname === '/v1/inbox/requests' && req.method === 'GET') {
      const page = requests.filter(r => r.cursor > since).slice(0, limit + 1)
      const out = page.slice(0, limit)
      return send(res, 200, { requests: out, next_cursor: out.at(-1)?.cursor ?? since, more: page.length > limit, head: requests.length })
    }
    if (url.pathname === '/v1/inbox/requests' && req.method === 'POST') {
      return send(res, 409, { error: { message: '不是主人', type: 'invalid_request_error', code: 'wrong_owner', owner_account: 'A', owner_epoch: 1 } })
    }
    if (url.pathname === '/v1/inbox/requests/result') {
      results.push(body as never)
      return send(res, 200, { request: {}, duplicate: false })
    }
    if (req.url === '/v1/channels/ws%3A1%2Fch%3A1/messages' && req.method === 'POST') {
      return send(res, 201, { message: { id: 'm1', seq: 1 }, duplicate: false })
    }
    if (url.pathname === '/v1/channels/ws%3A1%2Fch%3A1/messages') {
      return send(res, 200, { channel: { id: 'ws:1/ch:1', version: 2 }, messages: [], cursor: events.length })
    }
    if (req.url === '/v1/objects/aaaaaaaa%3At-1/events') return send(res, 201, { duplicate: false, cursor: 9 })
    return send(res, 404, { error: { message: 'no route', code: 'not_found' } })
  })
  return { server, seen, events, requests, results, state, addEvent, addRequest }
}

const servers: Server[] = []
afterEach(async () => {
  while (servers.length) await new Promise<void>(done => servers.pop()?.close(() => done()))
})

async function start() {
  const relay = fakeRelay()
  await new Promise<void>(done => relay.server.listen(0, '127.0.0.1', () => done()))
  servers.push(relay.server)
  const port = (relay.server.address() as { port: number }).port
  const conn = { relayUrl: `http://127.0.0.1:${port}/`, token: TOKEN }
  const file = join(mkdtempSync(join(tmpdir(), 'relay-inbox-')), 'workbench', 'relay-inbox.json')
  return { relay, conn, file }
}

describe('游标文件与补齐', () => {
  it('从 0 起分页补齐,游标写进 relay-inbox.json(0600);再来一次只拿新的', async () => {
    const { relay, conn, file } = await start()
    for (let i = 1; i <= 7; i += 1) relay.addEvent(`第 ${i} 条`)
    const got: string[] = []
    const out = await syncInboxEvents(conn, { file, limit: 3, apply: (evs) => { got.push(...evs.map(e => String(e.payload.text))) } })
    expect(out).toEqual({ ok: true, applied: 7, cursor: 7 })
    expect(got).toEqual(Array.from({ length: 7 }, (_, i) => `第 ${i + 1} 条`))
    expect((await readRelayInboxState(file)).last_cursor).toBe(7)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    relay.addEvent('第 8 条')
    const again: string[] = []
    await syncInboxEvents(conn, { file, apply: (evs) => { again.push(...evs.map(e => String(e.payload.text))) } })
    expect(again).toEqual(['第 8 条'])
  })

  it('apply 抛错:游标不动,下次从原处重放(先落账、后推游标)', async () => {
    const { relay, conn, file } = await start()
    relay.addEvent('a')
    relay.addEvent('b')
    await expect(syncInboxEvents(conn, { file, apply: () => { throw new Error('写账失败') } })).rejects.toThrow('写账失败')
    expect((await readRelayInboxState(file)).last_cursor).toBe(0)
    const got: string[] = []
    await syncInboxEvents(conn, { file, apply: (evs) => { got.push(...evs.map(e => String(e.payload.text))) } })
    expect(got).toEqual(['a', 'b'])
  })

  it('写坏的游标文件当 0', async () => {
    const { conn, file } = await start()
    await resetRelayInboxCursor(file, 3)
    writeFileSync(file, '{坏了')
    expect(await readRelayInboxState(file)).toEqual({ version: 1, last_cursor: 0, last_request_cursor: 0 })
    expect(conn.token).toBe(TOKEN)
  })

  it('410 → resync;取快照、把游标拨到快照的 cursor 再续', async () => {
    const { relay, conn, file } = await start()
    for (let i = 1; i <= 4; i += 1) relay.addEvent(`${i}`)
    relay.state.floor = 3
    const out = await syncInboxEvents(conn, { file, apply: () => {} })
    expect(out).toMatchObject({ ok: false, resync: true, code: 'cursor_expired', applied: 0, cursor: 0 })
    const snap = await channelSnapshot(conn, 'ws:1/ch:1', { limit: 200 })
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    await resetRelayInboxCursor(file, snap.value.cursor)
    relay.addEvent('5')
    const got: string[] = []
    expect(await syncInboxEvents(conn, { file, apply: (evs) => { got.push(...evs.map(e => String(e.payload.text))) } })).toMatchObject({ ok: true })
    expect(got).toEqual(['5'])
  })
})

describe('请求队列(座机服务这一侧)', () => {
  it('handle 回结果就当场回给中转;回 undefined 不回;游标逐条推进', async () => {
    const { relay, conn, file } = await start()
    relay.addRequest('q1')
    relay.addRequest('q2')
    relay.addRequest('q3')
    const out = await syncInboxRequests(conn, {
      file,
      handle: r => (r.request_id === 'q2' ? undefined : { state: 'done', result: { ok: r.request_id } }),
    })
    expect(out).toEqual({ ok: true, applied: 3, cursor: 3 })
    expect(relay.results.map(r => r.request_id)).toEqual(['q1', 'q3'])
    const state = await readRelayInboxState(file)
    expect(state.last_request_cursor).toBe(3)
    expect(state.last_cursor).toBe(0)
  })
})

describe('错误形状与路径', () => {
  it('409 wrong_owner 把现任带回来', async () => {
    const { conn } = await start()
    const out = await sendInboxRequest(conn, { request_id: newRelayRequestId(), to_account: 'B', op: 'task.comment', object_id: 'aaaaaaaa:t-1', args: {} })
    expect(out).toEqual({ ok: false, status: 409, code: 'wrong_owner', error: '不是主人', detail: { owner_account: 'A', owner_epoch: 1 } })
  })

  it('频道 id、对象 id 编码进路径;令牌只在请求头里', async () => {
    const { relay, conn } = await start()
    expect((await postChannelMessage(conn, 'ws:1/ch:1', { request_id: 'r1', text: '你好' })).ok).toBe(true)
    expect((await pushObjectEvent(conn, 'aaaaaaaa:t-1', { origin_seq: 1, payload: {} })).ok).toBe(true)
    for (const one of relay.seen) {
      expect(one.auth).toBe(`Bearer ${TOKEN}`)
      expect(one.url.includes(TOKEN)).toBe(false)
    }
  })

  it('连不上 → status 0,不把底层报错原样抛出', async () => {
    const out = await sendInboxRequest({ relayUrl: 'http://127.0.0.1:1', token: TOKEN }, { request_id: 'x', to_account: 'A', op: 'task.create' })
    expect(out).toMatchObject({ ok: false, status: 0 })
  })

  it('默认游标文件在 ~/.dsh/workbench/relay-inbox.json;请求号大致按时间有序', () => {
    expect(defaultRelayInboxFile('/Users/x')).toBe('/Users/x/.dsh/workbench/relay-inbox.json')
    const a = newRelayRequestId(new Date('2026-10-21T00:00:00Z'))
    const b = newRelayRequestId(new Date('2026-10-21T00:00:01Z'))
    expect(a < b).toBe(true)
  })
})
