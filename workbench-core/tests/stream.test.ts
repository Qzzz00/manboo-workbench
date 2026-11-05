import { request, type IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { startCore, type Core } from '../src/server.ts'
import { applyEvent } from '../src/translate.ts'
import type { CoreEvent } from '../src/events.ts'
import { freePort, startFakeUpstream, until, type FakeUpstream } from './fakeUpstream.ts'

let core: Core | undefined
let upstream: FakeUpstream | undefined
const open: IncomingMessage[] = []
afterEach(async () => {
  for (const res of open.splice(0)) res.destroy()
  await core?.close(); core = undefined
  await upstream?.stop(); upstream = undefined
})

interface Snapshot { epoch: string, snapshot_seq: number, upstream: { connected: boolean }, state: Record<string, unknown> | null }

async function getJson<T>(port: number, path: string): Promise<{ status: number, body: T }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as T }))
    }).on('error', reject).end()
  })
}

/** 一个最小的 SSE 读者:收 data 行里的事件,另记 hello。 */
function subscribe(port: number, path: string, headers: Record<string, string> = {}) {
  const events: CoreEvent[] = []
  const hello: Array<{ epoch: string, last_seq: number }> = []
  let status = 0
  const ready = new Promise<void>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (res) => {
      status = res.statusCode ?? 0
      open.push(res)
      let buf = ''
      res.on('data', (c: Buffer) => {
        buf += c.toString()
        let at: number
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, at)
          buf = buf.slice(at + 2)
          const lines = frame.split('\n')
          const name = lines.find(l => l.startsWith('event: '))?.slice(7)
          const data = lines.filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n')
          if (data === '') continue
          if (name === 'hello') hello.push(JSON.parse(data) as { epoch: string, last_seq: number })
          else events.push(JSON.parse(data) as CoreEvent)
        }
      })
      resolve()
    }).on('error', reject).end()
  })
  return { events, hello, ready, status: () => status }
}

describe('镜像与事件流', () => {
  it('订阅上游 /live:首帧快照翻成每键一条 set,之后只出变了的键;seq 严格 +1', async () => {
    upstream = await startFakeUpstream({ agents: [], tasks: [1] })
    core = await startCore({ port: 0, upstream: upstream.url })
    await until(() => core!.events.lastSeq >= 3, '首帧两键 + upstream up')
    upstream.setState({ agents: [], tasks: [1, 2] })
    upstream.send({ kind: 'call', phase: 'offhook', agent: 'claude', session_id: 's' })
    upstream.send({ kind: 'ping', ts: 1 })
    await until(() => core!.events.lastSeq >= 5, '一条变化 + 一条来电')
    const all = core.events.since(0)
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.events.map(e => [e.seq, e.topic, e.kind])).toEqual([
      [1, 'core.upstream', 'up'],
      [2, 'state.agents', 'set'],
      [3, 'state.tasks', 'set'],
      [4, 'state.tasks', 'set'],
      [5, 'live.call', 'message'],
    ])
  })

  it('GET /snapshot 回当前镜像 + snapshot_seq + epoch;GET /events?since=snapshot_seq 只给之后的', async () => {
    upstream = await startFakeUpstream({ n: 0 })
    core = await startCore({ port: 0, upstream: upstream.url })
    await until(() => core!.events.lastSeq >= 2, '首帧')
    const snap = await getJson<Snapshot>(core.port, '/snapshot')
    expect(snap.status).toBe(200)
    expect(snap.body.state).toEqual({ n: 0 })
    expect(snap.body.snapshot_seq).toBe(2)
    expect(snap.body.upstream.connected).toBe(true)

    const sub = subscribe(core.port, `/events?since=${snap.body.snapshot_seq}&epoch=${snap.body.epoch}`)
    await sub.ready
    await until(() => sub.hello.length === 1, 'hello')
    expect(sub.hello[0]).toEqual({ epoch: snap.body.epoch, last_seq: 2 })
    upstream.setState({ n: 1 })
    await until(() => sub.events.length === 1, '一条变化')
    expect(sub.events[0]).toMatchObject({ seq: 3, topic: 'state.n', kind: 'set', payload: 1 })
  })

  it('since 续流不漏不重:先回放缓冲里的,再接着推新的;断了用 Last-Event-ID 续上', async () => {
    upstream = await startFakeUpstream({ n: 0 })
    core = await startCore({ port: 0, upstream: upstream.url })
    await until(() => core!.events.lastSeq === 2, '先订上(up + 首帧)')
    for (let i = 1; i <= 8; i++) upstream.setState({ n: i })
    await until(() => core!.events.lastSeq === 10, '8 条变化')

    const first = subscribe(core.port, '/events?since=4')
    await first.ready
    for (let i = 9; i <= 12; i++) upstream.setState({ n: i })
    await until(() => first.events.length === 10, '回放 6 + 新 4')
    expect(first.events.map(e => e.seq)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    open.splice(0).forEach(res => res.destroy())

    for (let i = 13; i <= 15; i++) upstream.setState({ n: i })
    await until(() => core!.events.lastSeq === 17, '断开期间 3 条')
    const second = subscribe(core.port, '/events', { 'last-event-id': '14' })
    await second.ready
    await until(() => second.events.length === 3, '续上 3 条')
    expect(second.events.map(e => e.seq)).toEqual([15, 16, 17])
  })

  it('浏览器 EventSource 断线重连:URL 上还是当初的 ?since=,Last-Event-ID 优先,不从头重放', async () => {
    upstream = await startFakeUpstream({ n: 0 })
    core = await startCore({ port: 0, upstream: upstream.url })
    await until(() => core!.events.lastSeq === 2, '先订上(up + 首帧)')
    for (let i = 1; i <= 8; i++) upstream.setState({ n: i })
    await until(() => core!.events.lastSeq === 10, '8 条变化')

    const resumed = subscribe(core.port, '/events?since=4', { 'last-event-id': '8' })
    await resumed.ready
    await until(() => resumed.events.length === 2, '续上 2 条')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(resumed.events.map(e => e.seq)).toEqual([9, 10])
  })

  it('快照与续流交错:变化一直在来,取快照再从 snapshot_seq 续,重建出来的与上游最终状态一模一样', async () => {
    upstream = await startFakeUpstream({ a: 0, b: 0 })
    core = await startCore({ port: 0, upstream: upstream.url })
    await until(() => core!.events.lastSeq >= 3, '首帧')
    let i = 0
    const pump = setInterval(() => { i++; upstream!.setState(i % 3 === 0 ? { a: i } : { a: i, b: -i }) }, 2)
    await new Promise(resolve => setTimeout(resolve, 40))
    const snap = await getJson<Snapshot>(core.port, '/snapshot')
    const sub = subscribe(core.port, `/events?since=${snap.body.snapshot_seq}`)
    await sub.ready
    await new Promise(resolve => setTimeout(resolve, 60))
    clearInterval(pump)
    const finalSeq = await (async () => { await new Promise(r => setTimeout(r, 50)); return core!.events.lastSeq })()
    await until(() => (sub.events.at(-1)?.seq ?? snap.body.snapshot_seq) === finalSeq, '收齐')

    const seqs = sub.events.map(e => e.seq)
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, k) => snap.body.snapshot_seq + 1 + k))
    let rebuilt = snap.body.state ?? {}
    for (const e of sub.events) rebuilt = applyEvent(rebuilt, e)
    expect(rebuilt).toEqual(upstream.state)
  })

  it('since 早于保留窗、晚于最新、或 epoch 对不上:410,终端该重取快照', async () => {
    upstream = await startFakeUpstream({ n: 0 })
    core = await startCore({ port: 0, upstream: upstream.url, keepEvents: 3 })
    await until(() => core!.events.lastSeq === 2, '先订上(up + 首帧)')
    for (let i = 1; i <= 6; i++) upstream.setState({ n: i })
    await until(() => core!.events.lastSeq === 8, '6 条变化')
    expect((await getJson(core.port, '/events?since=1')).status).toBe(410)
    expect((await getJson(core.port, '/events?since=99')).status).toBe(410)
    expect((await getJson(core.port, '/events?since=8&epoch=old-life')).status).toBe(410)
    expect((await getJson(core.port, '/events?since=abc')).status).toBe(400)
  })

  it('上游断了:出 core.upstream down,快照留着上次的样子并标 connected=false;上游回来自动重订、只补变化', async () => {
    upstream = await startFakeUpstream({ n: 1, keep: true })
    core = await startCore({ port: 0, upstream: upstream.url, reconnectMinMs: 20, reconnectMaxMs: 50 })
    await until(() => core!.events.lastSeq >= 3, '首帧')
    await upstream.stop()
    await until(() => core!.mirror.connected === false, '看见断开')
    const down = await getJson<Snapshot>(core.port, '/snapshot')
    expect(down.body.upstream.connected).toBe(false)
    expect(down.body.state).toEqual({ n: 1, keep: true })
    const downSeq = down.body.snapshot_seq

    upstream.state = { n: 2, keep: true }
    await upstream.start()
    await until(() => core!.mirror.connected, '重订上')
    await until(() => core!.events.lastSeq >= downSeq + 2, 'up + 一条变化')
    const r = core.events.since(downSeq - 1)
    expect(r.ok && r.events.map(e => [e.topic, e.kind])).toEqual([
      ['core.upstream', 'down'],
      ['core.upstream', 'up'],
      ['state.n', 'set'],
    ])
  })

  it('上游 /live 半开(连着但一声不吭)超过空闲期限就主动重连', async () => {
    upstream = await startFakeUpstream({ n: 1 })
    core = await startCore({ port: 0, upstream: upstream.url, liveIdleMs: 150, reconnectMinMs: 20, reconnectMaxMs: 50 })
    await until(() => core!.mirror.connected, '连上')
    await until(() => core!.mirror.reconnects >= 1, '空闲后重连', 3000)
  })

  it('上游从没起来过:/snapshot 的 state 是 null、connected=false,不编数据', async () => {
    const port = await freePort()
    core = await startCore({ port: 0, upstream: `http://127.0.0.1:${port}`, reconnectMinMs: 20, reconnectMaxMs: 50 })
    const snap = await getJson<Snapshot>(core.port, '/snapshot')
    expect(snap.body.state).toBeNull()
    expect(snap.body.upstream.connected).toBe(false)
    expect(snap.body.snapshot_seq).toBe(0)
  })
})
