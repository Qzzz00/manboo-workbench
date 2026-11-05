// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { createFeedService } from '../src/server/feed.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { sanitizeLanMessage } from '../src/server/collabStore.ts'

const cleanup: (() => Promise<void>)[] = [], dirs: string[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
let clock = Date.parse('2026-10-18T12:00:00+08:00')
async function instance(withFeed = false, existing?: string, ticks = 0) {
  const dir = existing ?? mkdtempSync(join(tmpdir(), 'collab-f-source-'))
  if (existing === undefined) dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => clock / 1000 })
  let feed: ReturnType<typeof createFeedService> | undefined
  let stopOrigin: (() => Promise<void>) | undefined
  if (withFeed) {
    let base = ''
    const origin = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.url === '/notice' ? { title: '受控来源服务已启动', at: new Date(clock).toISOString() } : { report: { date: '2026-10-19', sections: [{ label: '本轮实际公告', items: [{ title: '受控来源服务已启动', summary: '该HTTP服务正在响应本轮请求', publishedAt: '2026-10-19', source: { name: '受控公告源' }, links: { original: base + '/notice' } }] }] } }))
    })
    await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(origin.address() as { port: number }).port}`
    let originClosed = false
    stopOrigin = async () => { if (!originClosed) { originClosed = true; await new Promise<void>((resolve, reject) => origin.close(error => error ? reject(error) : resolve())) } }
    cleanup.push(stopOrigin)
    feed = createFeedService({ file: join(dir, 'feed.json'), configFile: join(dir, 'feed-config.json'), projects: async () => [], now: () => clock,
      aihotDaily: async () => (await fetch(base + '/daily')).json() })
    await feed.load(); await feed.setConfig({ podcast: false })
  }
  const server = await startWorkbenchServer({ port: 0, tasks, service: createWorkbenchService({ now: () => clock / 1000 }),
    tickIntervalMs: ticks, jobLog: createJobLog({ file: join(dir, 'jobs.jsonl') }), ...(feed === undefined ? {} : { feed }),
    pairing: createPairingService({ file: join(dir, 'devices.json') }), collabWorkdir: async () => join(dir, 'work') })
  let closed = false
  const close = async () => { if (!closed) { closed = true; await server.close() } }
  cleanup.push(close)
  const api = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: r.status, body: await r.json() as any }
  }
  return { api, tasks, feed, dir, close, stopOrigin, url: server.url }
}
async function connected(withFeed = true, ticks = 0) {
  clock = Date.parse('2026-10-18T12:00:00+08:00')
  const a = await instance(withFeed, undefined, ticks), b = await instance()
  for (const member of [a, b]) expect((await member.api('/task/create', { title: '真实API登记的受控项目材料', project_id: 'aihot-daily', status: 'todo' })).status).toBe(200)
  const bId = (await b.api('/collab/lan/identity')).body.identity.member_id
  const code = (await b.api('/pair/start', {})).body.pairing.code
  expect((await a.api('/collab/lan/connect', { host: '127.0.0.1', port: Number(new URL(b.url).port), code, member_id: bId })).status).toBe(200)
  clock = Date.parse('2026-10-19T10:00:00+08:00')
  if (a.feed) expect((await a.feed.run()).added).toBe(1)
  const policy = { project_id: 'aihot-daily', enabled: true, recipients: [bId], categories: ['news', 'daily', 'weekly'], expected_version: 0 }
  return { a, b, bId, policy }
}
const channel = '/collab/lan/channel?project_id=aihot-daily'
const policyPath = '/collab/lan/channel/source-policy'
const publishPath = '/collab/lan/channel/publish'
function evidence(name: string, data: unknown) {
  const dir = process.env.COLLAB_F_EVIDENCE_DIR
  if (dir === undefined) return
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2) + '\n')
}

it('正式来源分类/话题/引用完整保存,旧消息不按关键字猜分类', () => {
  const message = { id: 'source-1', project_id: 'p', author: { member_id: 'peer', name: '成员' }, kind: 'message', at: '2026-10-19T02:00:00Z', text: '实际来源正文', category: 'news',
    source: { kind: 'feed', id: 'feed:1', recorded_at: '2026-10-19T01:00:00Z', scope: 'project-feed', url: 'https://example.org/article' },
    topic: { id: 'feed:1', title: '真实来源话题' }, refs: [{ kind: 'url', id: '1', title: '原文', url: 'https://example.org/article' }] }
  expect(sanitizeLanMessage(message)).toMatchObject(message)
  expect(sanitizeLanMessage({ ...message, source: undefined })).toBeUndefined()
  const { category: _c, source: _s, topic: _t, refs: _r, ...legacy } = message
  expect(sanitizeLanMessage({ ...legacy, text: '日报周报资讯' })).not.toHaveProperty('category')
  expect(sanitizeLanMessage({ ...message, text: '正式来源正文'.repeat(1000) })?.text).toBe('正式来源正文'.repeat(1000))
  for (const change of [{ category: 'invented' }, { kind: 'report' }, { source: { ...message.source, url: 'file:///secret' } }, { refs: [{ kind: 'url', id: 'bad', title: '无权限', url: 'https://user:password@example.org' }] },
    { category: 'daily', source: { kind: 'project-report', id: 'daily:bad', recorded_at: message.at, scope: 'local-project-records', period: { from: '2026-10-12', to: '2026-10-18' } } }]) {
    expect(sanitizeLanMessage({ ...message, ...change })).toBeUndefined()
  }
})

it('真实Feed入口和任务事实→发布→LAN落账→分类/话题/来源筛选与引用,并发同源不重复', async () => {
  const f = await connected()
  expect((await f.a.api(policyPath, f.policy)).status).toBe(200)
  const responses = await Promise.all([f.a.api(publishPath, { project_id: 'aihot-daily' }), f.a.api(publishPath, { project_id: 'aihot-daily' })])
  for (const r of responses) expect(r.status).toBe(200)
  const messages = (await f.b.api(channel)).body.messages
  expect(messages).toHaveLength(3)
  expect(messages.map((m: any) => m.category).sort()).toEqual(['daily', 'news', 'weekly'])
  for (const m of messages) { expect(m.source.id).toBeTruthy(); expect(m.topic.id).toBeTruthy(); expect(m.refs.length).toBeGreaterThan(0) }
  const news = messages.find((m: any) => m.category === 'news')
  expect(news.source.kind).toBe('feed'); expect(news.source.publisher).toBe(f.a.feed!.view().groups[0]!.items[0]!.source)
  expect(news.source).not.toHaveProperty('published_at') // 只有日期,不能补造精确发表时刻,也不能整条丢弃。
  expect((await fetch(news.source.url)).status).toBe(200)
  for (const filter of ['category=news', `topic_id=${encodeURIComponent(news.topic.id)}`, `source_id=${encodeURIComponent(news.source.id)}`]) {
    expect((await f.b.api(channel + '&' + filter)).body.messages.map((m: any) => m.id)).toEqual([news.id])
  }
  expect((await f.a.api(channel)).body.messages.every((m: any) => m.deliveries[0].status === 'delivered')).toBe(true)
  const before = JSON.stringify(messages)
  await f.a.api(publishPath, { project_id: 'aihot-daily' })
  expect(JSON.stringify((await f.b.api(channel)).body.messages)).toBe(before)
  const report = messages.find((m: any) => m.category === 'daily')
  expect(report.refs[0].kind).toBe('task')
  expect(report.source.period).toEqual({ from: '2026-10-18', to: '2026-10-18' })
  expect(report.text).toContain('实际开工/完成未知')
  evidence('source-lifecycle', { source_ingress: '本轮实际运行的HTTP公告→FeedService.run', model_calls: 0, origin_notice: await (await fetch(news.source.url)).json(), source_feed_item: f.a.feed!.view().groups[0]!.items[0], sender_messages: (await f.a.api(channel)).body, receiver_messages: (await f.b.api(channel)).body, concurrent_http_status: responses.map(r => r.status), filters_verified: ['category', 'topic_id', 'source_id'], report_origin: '正常隔离API创建的项目事项;没有种jobLog或模型完成' })
})

it('来源缺席明示未知且不制造空报告;策略越域/竞争失败保旧;手机与peer无发布权', async () => {
  const f = await connected(false)
  const saved = await f.a.api(policyPath, { ...f.policy, categories: ['news'] })
  expect(saved.status).toBe(200)
  expect((await f.a.api(channel)).body.source_scope.news).toBe('unwired')
  expect((await f.a.api(publishPath, { project_id: 'aihot-daily' })).body.messages).toEqual([])
  expect((await f.b.api(channel)).body.messages).toEqual([])
  const before = readFileSync(join(f.a.dir, 'tasks.json'), 'utf8')
  expect((await f.a.api(policyPath, { ...f.policy, project_id: 'private-other' })).status).toBe(409)
  expect((await f.a.api(policyPath, { ...f.policy, recipients: ['unknown-peer'], expected_version: 1 })).status).toBe(409)
  expect((await f.a.api(policyPath, f.policy)).status).toBe(409)
  expect(readFileSync(join(f.a.dir, 'tasks.json'), 'utf8')).toBe(before)
  const code = (await f.a.api('/pair/start', {})).body.pairing.code
  const token = (await f.a.api('/pair/claim', { code, device_name: '受控手机', platform: 'ios' })).body.token
  expect((await f.a.api(policyPath, { ...f.policy, expected_version: 1 }, token)).status).toBe(403)
  expect((await f.a.api(publishPath, { project_id: 'aihot-daily' }, token)).status).toBe(403)
  expect((await f.a.api(publishPath, { project_id: 'aihot-daily', text: '伪造来源' })).status).toBe(400)
  expect((await f.a.api('/collab/lan/channel/send', { project_id: 'aihot-daily', text: '伪造日报', recipients: [f.bId], category: 'daily' })).status).toBe(403)
})

it('来源快照跨两端重建保留;对端失联不删旧材料,恢复后重投同条', async () => {
  const f = await connected()
  expect((await f.a.api(policyPath, f.policy)).status).toBe(200)
  await f.a.api(publishPath, { project_id: 'aihot-daily' })
  const before = (await f.b.api(channel)).body.messages
  await f.a.close(); await f.b.close()
  const a = await instance(false, f.a.dir), b = await instance(false, f.b.dir)
  expect((await b.api(channel)).body.messages).toEqual(before)
  expect((await a.api(channel)).body.messages).toHaveLength(3)
  // 旧配对端口已失联,已送达旧材料不能因当前源未接而消失。
  await a.api(publishPath, { project_id: 'aihot-daily' })
  expect((await a.api(channel)).body.messages).toHaveLength(3)
  expect((await b.api(channel)).body.messages).toEqual(before)
  evidence('restart-readback', { receiver_before: before, sender_after: (await a.api(channel)).body, receiver_after: (await b.api(channel)).body })
})

it('真实对端关闭后来源保存为失败,重新配对原身份后投递原快照且不新落账', async () => {
  const f = await connected()
  expect((await f.a.api(policyPath, f.policy)).status).toBe(200)
  await f.b.close()
  const failed = await f.a.api(publishPath, { project_id: 'aihot-daily' })
  expect(failed.status).toBe(200); expect(failed.body.ok).toBe(false)
  expect(failed.body.messages).toHaveLength(3)
  expect(failed.body.messages.every((m: any) => m.deliveries[0].status === 'failed')).toBe(true)
  const b = await instance(false, f.b.dir)
  expect((await b.api('/collab/lan/identity')).body.identity.member_id).toBe(f.bId)
  const code = (await b.api('/pair/start', {})).body.pairing.code
  expect((await f.a.api('/collab/lan/connect', { host: '127.0.0.1', port: Number(new URL(b.url).port), code, member_id: f.bId })).status).toBe(200)
  const retried = await f.a.api(publishPath, { project_id: 'aihot-daily' })
  expect(retried.body.ok).toBe(true)
  const strip = ({ deliveries: _d, ...m }: any) => m
  expect(retried.body.messages.map(strip)).toEqual(failed.body.messages.map(strip))
  expect((await b.api(channel)).body.messages).toHaveLength(3)
  evidence('offline-recovery', { failure: failed.body, recovered: retried.body, receiver: (await b.api(channel)).body, stable_identity: f.bId })
})

it('接收成功但HTTP回执丢失后,真实重投保持原回执与正式来源;对端不能篡改同号来源', async () => {
  const f = await connected()
  const receipts: unknown[] = []
  let drop = true
  const proxy = createServer(async (req, res) => {
    const buffers: Buffer[] = []; for await (const chunk of req) buffers.push(Buffer.from(chunk))
    const response = await fetch(f.b.url + req.url, { method: req.method ?? 'GET', headers: { 'content-type': 'application/json', ...(req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization }) }, ...(req.method === 'GET' ? {} : { body: Buffer.concat(buffers) }) })
    const body = await response.json() as any
    if (req.url === '/collab/lan/receive') { receipts.push(body.receipt); if (drop) { drop = false; res.destroy(); return } }
    res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => proxy.close(e => e ? reject(e) : resolve())))
  const code = (await f.b.api('/pair/start', {})).body.pairing.code
  await f.a.api('/collab/lan/connect', { host: '127.0.0.1', port: (proxy.address() as { port: number }).port, code, member_id: f.bId })
  expect((await f.a.api(policyPath, { ...f.policy, categories: ['news'] })).status).toBe(200)
  const first = await f.a.api(publishPath, { project_id: 'aihot-daily' })
  expect(first.body.ok).toBe(false)
  const second = await f.a.api(publishPath, { project_id: 'aihot-daily' })
  expect(second.body.ok).toBe(true)
  expect(receipts).toHaveLength(2); expect(receipts[1]).toEqual(receipts[0])
  expect((await f.b.api(channel)).body.messages).toHaveLength(1)
  const sender = (await f.a.api('/collab/lan/identity')).body.identity.member_id
  const peerCode = (await f.b.api('/pair/start', {})).body.pairing.code
  const token = (await f.b.api('/pair/claim', { code: peerCode, device_name: `LAN:${sender}`, platform: 'collab-peer' })).body.token
  const original = second.body.messages[0]
  const before = readFileSync(join(f.b.dir, 'tasks.json'), 'utf8')
  expect((await f.b.api('/collab/lan/receive', { message: { ...original, topic: { ...original.topic, title: '篡改话题' } } }, token)).status).toBe(409)
  expect(readFileSync(join(f.b.dir, 'tasks.json'), 'utf8')).toBe(before)
  expect((await f.b.api(publishPath, { project_id: 'aihot-daily' }, token)).status).toBe(403)
  evidence('lost-receipt', { original_transport_receipt: receipts[0], replayed_transport_receipt: receipts[1], first: first.body, retry: second.body, conflict_status: 409, peer_publish_status: 403 })
})

it('来源自动发布挂原HTTP节拍,关闭策略后不再外发,没有人类发送入口', async () => {
  const f = await connected(true, 20)
  expect((await f.a.api(policyPath, { ...f.policy, categories: ['news'] })).status).toBe(200)
  clock += 60_000
  let messages: any[] = []
  for (let n = 0; n < 50; n++) {
    messages = (await f.b.api(channel)).body.messages
    if (messages.length > 0) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(messages).toHaveLength(1); expect(messages[0].category).toBe('news')
  expect((await f.a.api(policyPath, { ...f.policy, enabled: false, expected_version: 1 })).status).toBe(200)
  clock += 60_000
  await new Promise(resolve => setTimeout(resolve, 60))
  expect((await f.b.api(channel)).body.messages).toEqual(messages)
  expect((await f.a.api(channel)).body.source_scope.publication_enabled).toBe(false)
  evidence('existing-tick', { explicit_publish_calls: 0, tick_interval_ms: 20, received: messages, disabled_scope: (await f.a.api(channel)).body.source_scope })
})

it('项目来源不跨域,无期间材料不造报告,非法筛选拒绝,策略并发只有一个版本获准', async () => {
  const f = await connected()
  const policies = await Promise.all([f.a.api(policyPath, { ...f.policy, categories: ['news'] }), f.a.api(policyPath, { ...f.policy, categories: ['daily'] })])
  expect(policies.map(r => r.status).sort()).toEqual([200, 409])
  expect(policies.find(r => r.status === 409)!.body.policy.version).toBe(1)
  expect((await f.a.api('/task/create', { title: '另一个准确项目', status: 'todo', project_id: 'another-project' })).status).toBe(200)
  expect((await f.a.api(policyPath, { ...f.policy, project_id: 'another-project' })).status).toBe(200)
  const empty = await f.a.api(publishPath, { project_id: 'another-project' })
  expect(empty.body.messages).toEqual([])
  expect(empty.body.source_scope).toMatchObject({ news: 'unknown', reports: 'unknown' })
  expect((await f.a.api(channel + '&category=made-up')).status).toBe(400)
  expect((await f.a.api(channel + '&category=unknown')).body.messages).toEqual([])
})

it('真实资讯源关闭后来源状态unknown,已送材料/报告与引用完整保留', async () => {
  const f = await connected()
  expect((await f.a.api(policyPath, f.policy)).status).toBe(200)
  await f.a.api(publishPath, { project_id: 'aihot-daily' })
  const before = (await f.b.api(channel)).body.messages
  await f.a.stopOrigin!()
  expect((await f.a.feed!.run()).error).toBeTruthy()
  const retry = await f.a.api(publishPath, { project_id: 'aihot-daily' })
  expect(retry.body.source_scope.news).toBe('unknown')
  expect((await f.b.api(channel)).body.messages).toEqual(before)
  evidence('origin-failure', { source_ingress_failed: true, scope: retry.body.source_scope, preserved_receiver_messages: (await f.b.api(channel)).body.messages })
})

it('来源不可读时,更换接收者不自动泄露历史快照,只重试原目标的失败投递', async () => {
  const f = await connected()
  expect((await f.a.api(policyPath, { ...f.policy, categories: ['news'] })).status).toBe(200)
  await f.a.api(publishPath, { project_id: 'aihot-daily' })
  const before = (await f.b.api(channel)).body.messages
  await f.a.stopOrigin!(); await f.a.feed!.run()
  const c = await instance()
  await c.api('/task/create', { title: '新接收端项目', project_id: 'aihot-daily', status: 'todo' })
  const id = (await c.api('/collab/lan/identity')).body.identity.member_id
  const code = (await c.api('/pair/start', {})).body.pairing.code
  await f.a.api('/collab/lan/connect', { host: '127.0.0.1', port: Number(new URL(c.url).port), code, member_id: id })
  expect((await f.a.api(policyPath, { ...f.policy, recipients: [id], categories: ['news'], expected_version: 1 })).status).toBe(200)
  await f.a.api(publishPath, { project_id: 'aihot-daily' })
  expect((await c.api(channel)).body.messages).toEqual([])
  expect((await f.b.api(channel)).body.messages).toEqual(before)
  evidence('recipient-scope', { origin_unavailable: true, old_recipient_preserved: before, new_recipient_messages: (await c.api(channel)).body.messages, implicit_history_backfill: false })
})
