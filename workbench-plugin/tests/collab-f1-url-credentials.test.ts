// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { sanitizeLanMessage } from '../src/server/collabStore.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { createFeedService } from '../src/server/feed.ts'

// All URL values are invented and never fetched. Only loopback QA services are contacted.
const marker = 'F1_FICTIONAL_NOT_A_CREDENTIAL'
const base = 'https://example.invalid/article'
const credentialNames = ['access_token', 'refresh_token', 'id_token', 'token', 'api_key', 'apikey', 'key', 'auth', 'authorization', 'password', 'passwd', 'pwd', 'secret', 'client_secret', 'signature', 'sig', 'credential', 'session', 'session_id', 'session_token', 'jwt', 'code', 'auth_code', 'access_key', 'access_key_id', 'private_key', 'security_token', 'cookie', 'x-api-key', 'X-Amz-Credential', 'X-Amz-Signature', 'X-Amz-Security-Token', 'X-Goog-Credential', 'X-Goog-Signature', 'AWSAccessKeyId', 'OSSAccessKeyId']
const blocked = [
  ...credentialNames.map((key, n) => ({ label: `query credential ${n}`, url: `${base}?${key}=${marker}` })),
  { label: 'mixed case', url: `${base}?AcCeSs_ToKeN=${marker}` },
  { label: 'encoded name', url: `${base}?%61ccess%5Ftoken=${marker}` },
  { label: 'twice encoded name', url: `${base}?%2561ccess%255Ftoken=${marker}` },
  { label: 'empty reserved parameter', url: `${base}?token=` },
  { label: 'duplicate after ordinary query', url: `${base}?page=2&page=3&token=${marker}` },
  { label: 'bracket parameter', url: `${base}?credentials[password]=${marker}` },
  { label: 'semicolon delimiter', url: `${base}?page=2;api_key=${marker}` },
  { label: 'fragment form', url: `${base}#access_token=${marker}&state=qa` },
  { label: 'fragment route query', url: `${base}#/reader?TOKEN=${marker}` },
  { label: 'encoded fragment form', url: `${base}#%61ccess_token%3D${marker}` },
  { label: 'twice encoded fragment form', url: `${base}#%2561ccess_token%253D${marker}` },
  { label: 'fragment scheme', url: `${base}#Bearer%20${marker}` },
  { label: 'encoded plus name separator', url: `${base}?access%2Btoken=${marker}` },
  { label: 'encoded plus fragment scheme', url: `${base}#Basic%2B${marker}` },
  { label: 'encoded delimiters', url: `${base}?page=2%26access_token%3D${marker}` },
  { label: 'excessive encoding depth', url: `${base}#%2525252561ccess_token=${marker}` },
  { label: 'malformed encoding', url: `${base}?%ZZtoken=${marker}` },
  { label: 'userinfo', url: `https://F1_FICTIONAL:${marker}@example.invalid/article` },
  { label: 'file scheme', url: 'file:///F1_FICTIONAL' },
  { label: 'javascript scheme', url: 'javascript:void(0)' },
]
const ordinary = [base, `${base}?q=协作&page=2&topic=lan#section-2`, `${base}?q=access_token%3Ddocumentation&sort=date#access-token-guide`, `${base}?keyword=token&monkey=1&signature_style=short#topic=协作`, `${base}#/reader?page=2&topic=lan`, `${base}#%E7%AC%AC%E4%BA%8C%E8%8A%82`, `${base}?q=100%25#section%202`, 'http://example.invalid/article?page=1']
function message(url: string, field: 'source' | 'ref', author = 'qa-peer', id = 'f1') {
  return { id, project_id: 'aihot-daily', author: { member_id: author, name: 'F1受控成员' }, kind: 'message', at: '2026-10-24T02:00:00Z', text: 'F1受控来源', category: 'news',
    source: { kind: 'feed', id, scope: 'project-feed', recorded_at: '2026-10-24T02:00:00Z', url: field === 'source' ? url : base },
    topic: { id, title: 'F1来源' }, refs: [{ kind: 'url', id, title: '原文', url: field === 'ref' ? url : base }] }
}
it.each(blocked)('F1 rejects $label in either URL field', ({ url }) => {
  for (const field of ['source', 'ref'] as const) expect(sanitizeLanMessage(message(url, field)) === undefined).toBe(true)
})
it.each(ordinary.map((url, n) => ({ url, n })))('F1 preserves ordinary URL $n exactly', ({ url }) => {
  for (const field of ['source', 'ref'] as const) expect(sanitizeLanMessage(message(url, field))).toEqual(message(url, field))
})

// F1-R1: the scheme is explicit, only its leading structural whitespace varies.
const leadingSchemes = [
  '%20Bearer%20', '+Basic+', '++bEaReR%20', '%09BASIC%09', '%0D%0Abasic%20',
  '%20+%09Bearer+%20', '%2BBasic%2B', '%2520Bearer%2520', '%252BBasic%252B',
  '%252520bEaReR%252520', '%25252520BASIC%25252520', '%C2%A0Bearer%20',
]
it.each(leadingSchemes.map((part, n) => ({ part, n })))('F1-R1 rejects leading scheme variant $n in source/ref and query/fragment', ({ part }) => {
  for (const separator of ['?', '#']) for (const field of ['source', 'ref'] as const) {
    expect(sanitizeLanMessage(message(`${base}${separator}${part}${marker}`, field)) === undefined).toBe(true)
  }
})
const leadingOrdinary = [
  `${base}#%20Bearer-guide`, `${base}#%20Basic`, `${base}#%20notes%20about%20Bearer%20syntax`,
  `${base}?q=%20Basic%20authentication&page=2#%20section-2`, `${base}#++ordinary+anchor`,
]
it.each(leadingOrdinary.map((url, n) => ({ url, n })))('F1-R1 preserves ordinary leading anchor and words $n', ({ url }) => {
  for (const field of ['source', 'ref'] as const) {
    const input = { ...message(url, field), text: 'Bearer and Basic are words in this ordinary article.' }
    expect(sanitizeLanMessage(input)).toEqual(input)
  }
})

const cleanup: (() => Promise<void>)[] = [], dirs: string[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function instance(urls?: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'collab-f1-')); dirs.push(dir)
  let feed: ReturnType<typeof createFeedService> | undefined
  if (urls !== undefined) {
    const origin = await listen(createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ report: { date: '2026-10-24', sections: [{ label: 'F1受控公告', items: urls.map((url, i) => ({ title: i === 0 ? '星图观测公告' : '图书馆闭馆通知', summary: '仅测试来源校验', source: { name: 'F1隔离来源' }, links: { original: url } })) }] } }))
    }))
    feed = createFeedService({ file: join(dir, 'feed.json'), configFile: join(dir, 'feed-config.json'), projects: async () => [], aihotDaily: async () => (await fetch(origin)).json() })
    await feed.load(); await feed.setConfig({ podcast: false }); await feed.run()
  }
  const server = await startWorkbenchServer({ port: 0, tickIntervalMs: 0, tasks: createTasksService({ file: join(dir, 'tasks.json') }), service: createWorkbenchService(), pairing: createPairingService({ file: join(dir, 'devices.json') }), collabWorkdir: async () => join(dir, 'work'), ...(feed === undefined ? {} : { feed }) })
  cleanup.push(() => server.close())
  const api = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: r.status, body: await r.json() as any }
  }
  await api('/task/create', { title: 'F1隔离项目', project_id: 'aihot-daily', status: 'todo' })
  const id = (await api('/collab/lan/identity')).body.identity.member_id as string
  return { api, id, dir, feed, url: server.url }
}
const channel = '/collab/lan/channel?project_id=aihot-daily'
function evidence(name: string, data: unknown) {
  const dir = process.env.COLLAB_F1_EVIDENCE_DIR
  if (dir !== undefined) writeFileSync(join(dir, name + '.json'), JSON.stringify(data, null, 2) + '\n')
}

it.each([
  { label: 'F1', urls: [`${base}?access_token=${marker}`, `${base}/fragment#%61ccess_token%3D${marker}`], evidenceName: 'publish' },
  { label: 'F1-R1', urls: [`${base}#%20Bearer%20${marker}`, `${base}/fragment#+Basic+${marker}`], evidenceName: 'leading-publish' },
])('$label actual Feed publish rejects credential links before snapshot/network and leaves Feed originals intact', async ({ urls, evidenceName }) => {
  const a = await instance(urls), b = await instance()
  let receives = 0
  const proxy = await listen(createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c))
    if (req.url === '/collab/lan/receive') receives++
    const r = await fetch(b.url + req.url, { method: req.method ?? 'GET', headers: { 'content-type': 'application/json', ...(req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization }) }, ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks) }) })
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text())
  }))
  const code = (await b.api('/pair/start', {})).body.pairing.code
  expect((await a.api('/collab/lan/connect', { host: '127.0.0.1', port: Number(new URL(proxy).port), code, member_id: b.id })).status).toBe(200)
  expect((await a.api('/collab/lan/channel/source-policy', { project_id: 'aihot-daily', enabled: true, recipients: [b.id], categories: ['news'], expected_version: 0 })).status).toBe(200)
  expect(a.feed!.view().groups.flatMap(g => g.items)).toHaveLength(2)
  const before = [a, b].map(x => readFileSync(join(x.dir, 'tasks.json'), 'utf8'))
  const original = readFileSync(join(a.dir, 'feed.json'), 'utf8')
  const results = await Promise.all([a.api('/collab/lan/channel/publish', { project_id: 'aihot-daily' }), a.api('/collab/lan/channel/publish', { project_id: 'aihot-daily' })])
  for (const r of results) { expect(r.status).toBe(200); expect(r.body.ok).toBe(false); expect(r.body.messages).toEqual([]); expect(r.body.errors).toHaveLength(2) }
  expect(receives).toBe(0)
  for (const [i, x] of [a, b].entries()) { expect(readFileSync(join(x.dir, 'tasks.json'), 'utf8') === before[i]).toBe(true); expect((await x.api(channel)).body.messages).toEqual([]) }
  expect(readFileSync(join(a.dir, 'feed.json'), 'utf8') === original).toBe(true)
  evidence(evidenceName, { synthetic_only: true, concurrent_requests: 2, rejected_materials_per_request: 2, receive_requests: receives, sender_and_receiver_tasks_unchanged: true, feed_original_unchanged: true, formal_snapshots: 0 })
})

it.each([
  { label: 'F1', url: ordinary[1]!, evidenceName: 'ordinary-publish' },
  { label: 'F1-R1', url: leadingOrdinary[3]!, evidenceName: 'leading-ordinary-publish' },
])('$label ordinary query/fragment survives actual Feed publishing and paired persisted readback', async ({ url, evidenceName }) => {
  const a = await instance([url]), b = await instance()
  const code = (await b.api('/pair/start', {})).body.pairing.code
  expect((await a.api('/collab/lan/connect', { host: '127.0.0.1', port: Number(new URL(b.url).port), code, member_id: b.id })).status).toBe(200)
  await a.api('/collab/lan/channel/source-policy', { project_id: 'aihot-daily', enabled: true, recipients: [b.id], categories: ['news'], expected_version: 0 })
  const r = await a.api('/collab/lan/channel/publish', { project_id: 'aihot-daily' })
  expect(r.body.ok).toBe(true); expect(r.body.messages).toHaveLength(1)
  expect(r.body.messages[0].deliveries[0].status).toBe('delivered')
  for (const x of [a, b]) {
    const saved = (await x.api(channel)).body.messages
    expect(saved).toHaveLength(1); expect(saved[0].source.url).toBe(url); expect(saved[0].refs[0].url).toBe(url)
    expect(JSON.parse(readFileSync(join(x.dir, 'tasks.json'), 'utf8')).lan_messages[0].source.url).toBe(url)
  }
  evidence(evidenceName, { ordinary_source_and_ref_exact: true, sender_and_receiver_persisted: true, delivered: 1, source_url_fetched: false, model_calls: 0 })
})

it('F1 paired receive rejects both fields without write/receipt; ordinary source still persists exactly', async () => {
  const b = await instance(), author = 'f1-isolated-peer'
  const code = (await b.api('/pair/start', {})).body.pairing.code
  const token = (await b.api('/pair/claim', { code, device_name: `LAN:${author}`, platform: 'collab-peer' })).body.token
  const before = readFileSync(join(b.dir, 'tasks.json'), 'utf8')
  let rejected = 0
  for (const [n, { url }] of blocked.entries()) for (const field of ['source', 'ref'] as const) {
    const r = await b.api('/collab/lan/receive', { message: message(url, field, author, `blocked-${n}-${field}`) }, token)
    expect(r.status).toBe(403); expect(r.body).not.toHaveProperty('receipt'); rejected++
    expect(readFileSync(join(b.dir, 'tasks.json'), 'utf8') === before).toBe(true)
  }
  expect((await b.api(channel)).body.messages).toEqual([])
  for (const [n, url] of ordinary.entries()) {
    const input = message(url, 'source', author, `ordinary-${n}`); input.refs[0]!.url = url
    expect((await b.api('/collab/lan/receive', { message: input }, token)).status).toBe(200)
    const saved = (await b.api(channel)).body.messages.find((m: any) => m.id === input.id)
    expect(saved.source.url).toBe(url); expect(saved.refs[0].url).toBe(url)
    expect(JSON.parse(readFileSync(join(b.dir, 'tasks.json'), 'utf8')).lan_messages.find((m: any) => m.id === input.id).source.url).toBe(url)
  }
  evidence('receive', { synthetic_only: true, rejected_requests: rejected, rejected_status: 403, invalid_writes: 0, invalid_receipts: 0, ordinary_accepted: ordinary.length, ordinary_urls_preserved: true })
})


it('F1-R1 paired receive rejects leading scheme in either field with no receipt/write and preserves ordinary references', async () => {
  const b = await instance(), author = 'f1-r1-isolated-peer'
  const code = (await b.api('/pair/start', {})).body.pairing.code
  const token = (await b.api('/pair/claim', { code, device_name: `LAN:${author}`, platform: 'collab-peer' })).body.token
  const before = readFileSync(join(b.dir, 'tasks.json'), 'utf8')
  let rejected = 0
  for (const [n, part] of leadingSchemes.entries()) for (const field of ['source', 'ref'] as const) {
    const r = await b.api('/collab/lan/receive', { message: message(`${base}#${part}${marker}`, field, author, `leading-${n}-${field}`) }, token)
    expect(r.status).toBe(403); expect(r.body).not.toHaveProperty('receipt'); rejected++
    expect(readFileSync(join(b.dir, 'tasks.json'), 'utf8') === before).toBe(true)
  }
  expect((await b.api(channel)).body.messages).toEqual([])
  for (const [n, url] of leadingOrdinary.entries()) {
    const input = message(url, 'source', author, `ordinary-leading-${n}`); input.refs[0]!.url = url
    expect((await b.api('/collab/lan/receive', { message: input }, token)).status).toBe(200)
    const saved = (await b.api(channel)).body.messages.find((m: any) => m.id === input.id)
    expect(saved.source.url).toBe(url); expect(saved.refs[0].url).toBe(url)
    const disk = JSON.parse(readFileSync(join(b.dir, 'tasks.json'), 'utf8')).lan_messages.find((m: any) => m.id === input.id)
    expect(disk.source.url).toBe(url); expect(disk.refs[0].url).toBe(url)
  }
  evidence('leading-receive', { synthetic_only: true, rejected_requests: rejected, rejected_status: 403, invalid_writes: 0, invalid_receipts: 0, ordinary_accepted: leadingOrdinary.length, ordinary_urls_preserved: true })
})
