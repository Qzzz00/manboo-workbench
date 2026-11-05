// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createPairingService } from '../src/server/devices.ts'

const servers: WorkbenchServer[] = [], dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
async function instance(now: () => number = () => Math.floor(Date.now() / 1000), existingDir?: string) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'core-063-delta-'))
  if (!existingDir) dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now })
  const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService({ now }), tasks, tickIntervalMs: 0,
    pairing: createPairingService({ file: join(dir, 'devices.json') }), collabWorkdir: async () => join(dir, 'work') })
  servers.push(server)
  const api = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: r.status, body: await r.json() as any }
  }
  return { api, tasks, url: server.url, server, dir }
}
type API = Awaited<ReturnType<typeof instance>>['api']
async function setup(api: API) {
  const goal = (await api('/collab/goal/create', { title: '隔离验收目标' })).body.id as string
  const made = await api('/task/create', { title: '承接事项', status: 'todo', goal_id: goal, project_id: 'delta', assignee: 'me', from: { kind: 'user' }, acceptance: ['成果符合条件'] })
  expect(made.status, JSON.stringify(made.body)).toBe(200)
  const task = made.body.id as string
  const saved = await api('/collab/goal/condition/save', { goal_id: goal, text: '成果符合条件', task_id: task, evidence: ['controlled:fixture'] })
  expect(saved.status).toBe(200)
  const condition = saved.body.id as string
  const verify = () => api('/collab/goal/condition/verify', { goal_id: goal, condition_id: condition, by: 'me', pass: true })
  const deliver = () => api('/collab/goal/condition/deliver', { goal_id: goal, condition_id: condition })
  const move = async (id: string, status: string) => { expect((await api('/task/move', { id, status })).status).toBe(200) }
  const board = async () => (await api(`/collab/goal/board?goal_id=${goal}`)).body.summary.conditions.items[0].state as string
  const raw = async () => (await api('/state')).body.tasks.goals.find((g: any) => g.id === goal).conditions[0]
  await move(task, 'doing'); await move(task, 'confirm')
  expect((await verify()).status).toBe(200)
  return { goal, task, condition, move, verify, deliver, board, raw }
}

it.each([{ path: ['blocked', 'doing'] }, { path: ['canceled', 'todo', 'doing'] }])('R1 confirm 经 $path 恢复不能复活旧核验/交付', async ({ path }) => {
  const { api, tasks } = await instance(), f = await setup(api)
  expect((await f.deliver()).status).toBe(200)
  for (const status of path) await f.move(f.task, status)
  expect(await f.board()).toBe('rework')
  expect((await tasks.list()).tasks.find(t => t.id === f.task)?.round).toBe(2)
  expect((await f.raw()).delivered_at).toBeUndefined()
  expect((await f.raw()).verifications).toHaveLength(1)
  expect((await f.deliver()).status).toBe(409)
  await f.move(f.task, 'confirm'); expect((await f.verify()).status).toBe(200)
  expect((await f.deliver()).status).toBe(200)
})

it.each(['handoff', 'derived'])('R2 %s 上游重开使下游旧核验失效,关系刷新也须重新核验', async kind => {
  const { api } = await instance(), f = await setup(api)
  const source = (await api('/task/create', { title: '上游', status: 'todo' })).body.id
  await f.move(source, 'doing'); await f.move(source, 'confirm')
  const edge = await api('/collab/relation/save', { from_id: source, to_id: f.task, kind, note: '上游成果' })
  expect(edge.status).toBe(200)
  expect((await f.deliver()).status).toBe(200)
  await f.move(source, 'doing')
  expect((await api(`/collab/relations?task_id=${f.task}`)).body.relations[0].stale).toBe(true)
  expect(await f.board()).toBe('rework')
  expect((await f.deliver()).status).toBe(409)
  expect((await f.verify()).status).toBe(409)
  expect((await f.raw()).verifications[0].pass).toBe(true)
  expect((await f.raw()).delivered_at).toBeUndefined()
  await api('/collab/relation/remove', { id: edge.body.id })
  expect(await f.board()).toBe('rework')
  await f.move(source, 'confirm')
  await api('/collab/relation/save', { from_id: source, to_id: f.task, kind, note: '更新后的成果' })
  expect((await f.verify()).status).toBe(200)
  expect((await f.deliver()).status).toBe(200)
})

it.each(['', '   ', null])('R3 HTTP 显式清空 task_id=%j 必须解绑并作废旧核验', async task_id => {
  const { api } = await instance(), f = await setup(api)
  await f.deliver()
  expect((await api('/collab/goal/condition/save', { goal_id: f.goal, id: f.condition, text: '成果符合条件', task_id })).status).toBe(200)
  expect((await f.raw()).task_id).toBeUndefined()
  expect((await f.raw()).delivered_at).toBeUndefined()
  expect((await f.raw()).verifications.at(-1).pass).toBe(false)
  expect(await f.board()).toBe('pending')
  expect((await f.deliver()).status).toBe(409)
})

it.each([{ path: ['blocked', 'todo', 'doing'] }, { path: ['canceled', 'backlog', 'todo', 'doing'] }])('R1 尚未交付的 verified 经 $path 也失效', async ({ path }) => {
  const { api } = await instance(), f = await setup(api)
  expect(await f.board()).toBe('verified')
  for (const status of path) await f.move(f.task, status)
  await f.move(f.task, 'confirm')
  expect(await f.board()).toBe('rework')
  expect((await f.deliver()).status).toBe(409)
})

it.each(['handoff', 'derived'])('R2 %s 上游重开不能让下游旧 verified 首次交付', async kind => {
  const { api } = await instance(), f = await setup(api)
  const source = (await api('/task/create', { title: '上游', status: 'todo' })).body.id
  await f.move(source, 'doing'); await f.move(source, 'confirm')
  expect((await api('/collab/relation/save', { from_id: source, to_id: f.task, kind, note: '成果承接' })).status).toBe(200)
  await f.move(source, 'doing')
  expect((await f.deliver()).status).toBe(409)
  expect(await f.board()).toBe('rework')
})

it('R3 omitted 保留绑定,非法类型拒绝,重新绑定需重验', async () => {
  const { api } = await instance(), f = await setup(api)
  const payload = { goal_id: f.goal, id: f.condition, text: '成果符合条件' }
  expect((await api('/collab/goal/condition/save', payload)).status).toBe(200)
  expect((await f.raw()).task_id).toBe(f.task)
  expect(await f.board()).toBe('verified')
  expect((await api('/collab/goal/condition/save', { ...payload, task_id: 42 })).status).toBe(400)
  const other = (await api('/task/create', { title: '新承接卡', status: 'todo' })).body.id
  expect((await api('/collab/goal/condition/save', { ...payload, task_id: other })).status).toBe(200)
  expect((await f.raw()).task_id).toBe(other)
  expect(await f.board()).toBe('rework')
})

it.each([{ text: '做完:已完成' }, { reply_to: 'second-invitation' }])('R4 已配对 peer 同 report ID 换 $text $reply_to 不能污染回执', async change => {
  const a = await instance(), b = await instance()
  const bId = (await b.api('/collab/lan/identity')).body.identity.member_id
  const bCode = (await b.api('/pair/start', {})).body.pairing.code
  expect((await a.api('/collab/lan/connect', { host: '127.0.0.1', port: Number(new URL(b.url).port), member_id: bId, code: bCode })).status).toBe(200)
  expect((await b.api('/task/create', { title: '共同项目', status: 'todo', project_id: 'delta' })).status).toBe(200)
  const start = (await a.api('/pair/start', {})).body.pairing
  const token = (await a.api('/pair/claim', { code: start.code, device_name: `LAN:${bId}`, platform: 'collab-peer' })).body.token
  expect(typeof token).toBe('string')
  const ids: string[] = []
  for (const text of ['第一项', '第二项']) {
    const parent = (await a.api('/task/create', { title: text, status: 'todo', project_id: 'delta', assignee: 'me' })).body.id
    const asked = await a.api('/collab/note/message', { task_id: parent, text, intent: 'ask', mentions: [`member:${bId}`] })
    ids.push(asked.body.message.id)
  }
  const report = { id: 'report-once', project_id: 'delta', author: { member_id: bId, name: '受控成员' }, text: '卡住:缺少材料', kind: 'report', reply_to: ids[0], at: new Date().toISOString() }
  expect((await a.api('/collab/lan/receive', { message: report }, token)).status).toBe(200)
  const messages = async () => (await a.api('/collab/lan/channel?project_id=delta')).body.messages as any[]
  const first = JSON.stringify(await messages())
  expect((await a.api('/collab/lan/receive', { message: report }, token)).status).toBe(200)
  expect(JSON.stringify(await messages())).toBe(first)
  const replay = { ...report, ...change, ...('reply_to' in change ? { reply_to: ids[1] } : {}) }
  expect((await a.api('/collab/lan/receive', { message: replay }, token)).status).toBe(409)
  expect(JSON.stringify(await messages())).toBe(first)
  const snapshot = (await a.api('/state')).body.tasks.tasks
  expect(snapshot[0].messages[0].deliveries[0].receipt.kind).toBe('blocked')
  expect(snapshot[1].messages[0].deliveries[0].receipt).toBeUndefined()
})

it('LAN 持久 reachable 过期、重启与失联不冒当前可达,名称范围未知', async () => {
  let now = Math.floor(Date.now() / 1000)
  const a = await instance(() => now), b = await instance()
  const identity = (await b.api('/collab/lan/identity')).body.identity
  await a.api('/collab/lan/members/remember', { member_id: identity.member_id, name: identity.name, host: '127.0.0.1', port: Number(new URL(b.url).port) })
  const fresh = (await a.api('/collab/lan/members?refresh=1')).body.members[0]
  expect(fresh.reachable).toBe(true)
  now += 121
  expect((await a.api('/collab/lan/members')).body.members[0]).toMatchObject({ member_id: identity.member_id, last_seen: fresh.last_seen })
  expect((await a.api('/collab/lan/members')).body.members[0].reachable).toBeUndefined()
  await a.server.close(); servers.splice(servers.indexOf(a.server), 1)
  const restarted = await instance(() => now, a.dir)
  a.api = restarted.api
  expect((await a.api('/collab/lan/members')).body.members[0].reachable).toBeUndefined()
  const renamed = await a.api('/collab/lan/identity', { name: '新名称', members_refreshed: true })
  expect(renamed.status).toBe(409)
  expect(renamed.body.availability).toBe('unknown')
  expect((await a.api('/collab/lan/members?refresh=1')).body.members[0].reachable).toBe(true)
  expect((await a.api('/collab/lan/identity', { name: '新名称' })).status).toBe(200)
  await b.server.close(); servers.splice(servers.indexOf(b.server), 1)
  const failed = (await a.api('/collab/lan/members?refresh=1')).body.members[0]
  expect(failed.reachable).toBe(false)
  expect(failed.last_seen).toBeDefined()
  expect((await a.api('/collab/lan/identity', { name: '第三个名称' })).body.availability).toBe('unknown')
})

it('R1 直接重开/验收退回同口径,confirm→done/原地不动不增加轮次,done→blocked 本来非法', async () => {
  const { api, tasks } = await instance(), f = await setup(api)
  await f.move(f.task, 'confirm'); await f.move(f.task, 'done')
  expect((await tasks.list()).tasks[0]?.round ?? 1).toBe(1)
  expect((await api('/task/move', { id: f.task, status: 'blocked' })).status).toBe(409)
  await f.move(f.task, 'doing')
  expect(await f.board()).toBe('rework')
  await f.move(f.task, 'confirm'); await f.verify()
  expect((await api('/collab/goal/condition/verify', { goal_id: f.goal, condition_id: f.condition, by: 'me', pass: false, note: '补充成果' })).status).toBe(200)
  expect((await tasks.list()).tasks[0]?.round).toBe(3)
  expect(await f.board()).toBe('rework')
})

it('R2 成果链 A→B→C 传播失效;reference/depends_on/rejected_back 不传播', async () => {
  const { api } = await instance(), f = await setup(api)
  const a = (await api('/task/create', { title: 'A', status: 'todo' })).body.id
  const b = (await api('/task/create', { title: 'B', status: 'todo' })).body.id
  await f.move(a, 'doing'); await f.move(a, 'confirm')
  for (const kind of ['reference', 'depends_on', 'rejected_back']) {
    const edge = await api('/collab/relation/save', { from_id: a, to_id: f.task, kind, note: '非成果承接边' })
    expect(edge.status).toBe(200)
  }
  await f.move(a, 'doing')
  expect(await f.board()).toBe('verified')
  await f.move(a, 'confirm')
  await api('/collab/relation/save', { from_id: a, to_id: b, kind: 'handoff', note: 'A成果' })
  await api('/collab/relation/save', { from_id: b, to_id: f.task, kind: 'derived' })
  await f.move(a, 'doing')
  expect(await f.board()).toBe('rework')
  expect((await f.verify()).status).toBe(409)
  expect((await f.raw()).verifications.at(-1)).toMatchObject({ by: 'system', pass: false })
})

it('R2 063 已持久化的 stale 关系删除后,旧通过也不能复活', async () => {
  const { api, dir } = await instance(), f = await setup(api)
  const source = (await api('/task/create', { title: '旧上游', status: 'todo' })).body.id
  const edge = await api('/collab/relation/save', { from_id: source, to_id: f.task, kind: 'derived' })
  await f.deliver()
  // 仅构造旧 063 格式的持久事实:上游已 round2,下游仍旧通过。本例不生成执行日志。
  const file = join(dir, 'tasks.json'), data = JSON.parse(readFileSync(file, 'utf8'))
  data.tasks.find((t: any) => t.id === source).round = 2
  writeFileSync(file, JSON.stringify(data))
  expect(await f.board()).toBe('rework')
  expect((await f.deliver()).status).toBe(409)
  await api('/collab/relation/remove', { id: edge.body.id })
  expect(await f.board()).toBe('rework')
  expect((await f.raw()).verifications.at(-1).pass).toBe(false)
})

it.each(['doing', 'blocked', 'canceled'])('R1 063 已持久化的 %s/旧同轮通过,恢复提交也不能复活', async status => {
  const { api, dir } = await instance(), f = await setup(api)
  await f.deliver()
  // 旧版本间接恢复后可能遗留 round1 + 旧通过/交付;恢复动作仍须经真实 HTTP。
  const file = join(dir, 'tasks.json'), data = JSON.parse(readFileSync(file, 'utf8'))
  data.tasks.find((t: any) => t.id === f.task).status = status
  writeFileSync(file, JSON.stringify(data))
  if (status === 'canceled') await f.move(f.task, 'todo')
  if (status !== 'doing') await f.move(f.task, 'doing')
  await f.move(f.task, 'confirm')
  expect(await f.board()).toBe('rework')
  expect((await f.deliver()).status).toBe(409)
  expect((await f.raw()).delivered_at).toBeUndefined()
})

it('R4 同 ID 原报告重试不覆盖后来的真实报告,本机不能换原文后再次发送', async () => {
  const a = await instance(), b = await instance()
  for (const member of [a, b]) await member.api('/task/create', { title: '共同项目', project_id: 'delta', status: 'todo' })
  const bId = (await b.api('/collab/lan/identity')).body.identity.member_id
  const code = (await b.api('/pair/start', {})).body.pairing.code
  await a.api('/collab/lan/connect', { host: '127.0.0.1', port: Number(new URL(b.url).port), code, member_id: bId })
  const original = await a.api('/collab/lan/channel/send', { id: 'original', project_id: 'delta', text: '原邀请', recipients: [bId] })
  expect(original.status).toBe(200)
  const peerCode = (await a.api('/pair/start', {})).body.pairing.code
  const token = (await a.api('/pair/claim', { code: peerCode, device_name: `LAN:${bId}`, platform: 'collab-peer' })).body.token
  const report = { id: 'report-old', project_id: 'delta', author: { member_id: bId, name: '受控成员' }, text: '卡住:缺材料', kind: 'report', reply_to: 'original', at: new Date().toISOString() }
  expect((await a.api('/collab/lan/receive', { message: report }, token)).status).toBe(200)
  expect((await a.api('/collab/lan/receive', { message: { ...report, id: 'report-new', text: '做完:材料已补齐' } }, token)).status).toBe(200)
  expect((await a.api('/collab/lan/receive', { message: report }, token)).status).toBe(200)
  const current = (await a.api('/collab/lan/channel?project_id=delta')).body.messages
  expect(current.find((m: any) => m.id === 'original').deliveries[0].receipt.kind).toBe('done')
  expect((await a.api('/collab/lan/channel/send', { id: 'original', project_id: 'delta', text: '改写邀请', recipients: [bId] })).status).toBe(409)
  expect((await b.api('/collab/lan/channel?project_id=delta')).body.messages[0].text).toBe('原邀请')
})
