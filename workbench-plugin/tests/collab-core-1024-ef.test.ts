// @vitest-environment node
/*
 * 协作区事实层 E / F 两个切片的服务端契约测试
 * (2026-10-24,`collab-core-kimi-contract.md` §4/§5):
 * E = 时间与容量事实(jobLog 现算);F = 局域网身份与成员(按需 refresh,不是后台扫描)。
 *
 * harness 照抄 tests/collab-core-1024-bcd.test.ts,时钟用真实当前时间:
 * presence 有 30 分钟 TTL,jobLog 的 24h 失联判据也按真实「现在」算。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActivityItem, CapacityItem, LanIdentity, LanMember, RunSegment } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createPersonalTokens } from '../src/server/personalToken.ts'

let nowSec = 0
const iso = (sec: number): string => new Date(sec * 1000).toISOString()

const started: WorkbenchServer[] = []
const dirs: string[] = []

beforeEach(() => { nowSec = Math.floor(Date.now() / 1000) })

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-collab-ef-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => nowSec, newId: () => `t-${++n}` })
  const jobLog = createJobLog({ file: join(dir, 'jobs.jsonl'), now: () => new Date(nowSec * 1000) })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => nowSec }),
    tickIntervalMs: 0,
    tasks,
    jobLog,
    personalTokens: createPersonalTokens({ file: join(dir, 'pat.json') }),
    collabWorkdir: async () => join(dir, 'work'),
  })
  started.push(server)
  return { url: server.url, jobLog }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function get(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function makeTask(url: string, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const made = await post(url, '/task/create', { title, status: 'todo', ...extra })
  expect(made.status).toBe(200)
  return String(made.body.id)
}

/* ─────────────────────────── E:运行片段 ─────────────────────────── */

describe('E · GET /collab/runs:assigned→收场步为一段', () => {
  it('assigned→waiting→replied 一段:pause_reason 有值、outcome=replied、status=done、source=family', async () => {
    const { url, jobLog } = await serve()
    const taskId = await makeTask(url, '短片')
    jobLog.append({ job: taskId, step: 'assigned', family: 'codex', at: iso(nowSec - 300) })
    jobLog.append({ job: taskId, step: 'waiting', family: 'codex', why: '电脑锁屏了', at: iso(nowSec - 240) })
    jobLog.append({ job: taskId, step: 'sent', family: 'codex', at: iso(nowSec - 120) })
    jobLog.append({ job: taskId, step: 'replied', family: 'codex', at: iso(nowSec - 60) })
    const got = await get(url, `/collab/runs?task_id=${taskId}`)
    expect(got.status).toBe(200)
    const runs = (got.body as { runs: RunSegment[] }).runs
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      task_id: taskId,
      source: 'codex',
      status: 'done',
      pause_reason: '电脑锁屏了',
      outcome: 'replied',
      started_at: iso(nowSec - 300),
      finished_at: iso(nowSec - 60),
    })
  })
  it('收场是 timeout/unreadable/not_sent → status=failed;无 family → source=unknown', async () => {
    const { url, jobLog } = await serve()
    const taskId = await makeTask(url, '卡')
    jobLog.append({ job: taskId, step: 'assigned', at: iso(nowSec - 200) })
    jobLog.append({ job: taskId, step: 'timeout', at: iso(nowSec - 100) })
    const runs = (await get(url, `/collab/runs?task_id=${taskId}`)).body as { runs: RunSegment[] }
    expect(runs.runs[0]).toMatchObject({ status: 'failed', outcome: 'timeout', source: 'unknown' })
  })
  it('未收场:assigned(+sent)无开工证据 = dispatched;有 started = running;started 后超 24h = unknown;中途 paused', async () => {
    const { url, jobLog } = await serve()
    const dispatchedId = await makeTask(url, '已派出')
    jobLog.append({ job: dispatchedId, step: 'assigned', family: 'kimi', at: iso(nowSec - 3600) })
    jobLog.append({ job: dispatchedId, step: 'sent', family: 'kimi', at: iso(nowSec - 3000) })
    const runningId = await makeTask(url, '真在跑')
    jobLog.append({ job: runningId, step: 'assigned', family: 'kimi', at: iso(nowSec - 3600) })
    jobLog.append({ job: runningId, step: 'started', family: 'kimi', at: iso(nowSec - 30) })
    const startedStaleId = await makeTask(url, ' Seen 后失联')
    jobLog.append({ job: startedStaleId, step: 'assigned', family: 'kimi', at: iso(nowSec - 26 * 3600) })
    jobLog.append({ job: startedStaleId, step: 'started', family: 'kimi', at: iso(nowSec - 25 * 3600) })
    const staleId = await makeTask(url, '失联')
    jobLog.append({ job: staleId, step: 'assigned', family: 'kimi', at: iso(nowSec - 25 * 3600) })
    const pausedId = await makeTask(url, '等预算')
    jobLog.append({ job: pausedId, step: 'assigned', family: 'kimi', at: iso(nowSec - 300) })
    jobLog.append({ job: pausedId, step: 'budget_stop', family: 'kimi', why: '到上限了', at: iso(nowSec - 60) })

    const one = async (id: string) => ((await get(url, `/collab/runs?task_id=${id}`)).body as { runs: RunSegment[] }).runs[0]!
    expect((await one(dispatchedId)).status).toBe('dispatched')
    const running = await one(runningId)
    expect(running.status).toBe('running')
    expect(running.outcome).toBeUndefined()
    expect((await one(startedStaleId)).status).toBe('unknown')
    expect((await one(staleId)).status).toBe('unknown')
    const paused = await one(pausedId)
    expect(paused.status).toBe('paused')
    expect(paused.pause_reason).toBe('到上限了')
  })
  it('无事件 = 空数组(不编一段);goal_id 一次取整目标下所有卡', async () => {
    const { url, jobLog } = await serve()
    const emptyId = await makeTask(url, '没派过')
    expect(((await get(url, `/collab/runs?task_id=${emptyId}`)).body as { runs: unknown[] }).runs).toEqual([])
    const goal = await post(url, '/collab/goal/create', { title: '整目标' })
    const goalId = String(goal.body.id)
    const a = await makeTask(url, '甲')
    const b = await makeTask(url, '乙')
    for (const id of [a, b]) {
      expect((await post(url, '/task/update', { id, goal_id: goalId })).status).toBe(200)
      jobLog.append({ job: id, step: 'assigned', family: 'codex', at: iso(nowSec - 100) })
      jobLog.append({ job: id, step: 'replied', family: 'codex', at: iso(nowSec - 50) })
    }
    const runs = ((await get(url, `/collab/runs?goal_id=${goalId}`)).body as { runs: RunSegment[] }).runs
    expect(runs).toHaveLength(2)
    expect(runs.map(one => one.task_id).sort()).toEqual([a, b].sort())
  })
  it('再一次 assigned 开新段(相邻 assigned 各是一段)', async () => {
    const { url, jobLog } = await serve()
    const taskId = await makeTask(url, '重派')
    jobLog.append({ job: taskId, step: 'assigned', family: 'codex', at: iso(nowSec - 500) })
    jobLog.append({ job: taskId, step: 'timeout', at: iso(nowSec - 400) })
    jobLog.append({ job: taskId, step: 'assigned', family: 'kimi', at: iso(nowSec - 200) })
    jobLog.append({ job: taskId, step: 'replied', family: 'kimi', at: iso(nowSec - 100) })
    const runs = ((await get(url, `/collab/runs?task_id=${taskId}`)).body as { runs: RunSegment[] }).runs
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ status: 'failed', source: 'codex' })
    expect(runs[1]).toMatchObject({ status: 'done', source: 'kimi' })
  })
})

describe('E · 原执行观察时刻公共HTTP接缝', () => {
  it('runs与activity透传同源可选观察时刻,不挪用用户排期', async () => {
    const { url, jobLog } = await serve()
    const taskId = await makeTask(url, '时刻核对', { start: iso(nowSec + 3600), end: iso(nowSec + 7200) })
    jobLog.append({ job: taskId, step: 'assigned', family: 'codex', at: iso(nowSec - 120) })
    jobLog.append({ job: taskId, step: 'started', family: 'codex', at: iso(nowSec - 90) })
    jobLog.append({ job: taskId, step: 'started', family: 'codex', at: iso(nowSec - 60) })
    jobLog.append({ job: taskId, step: 'replied', family: 'codex', at: iso(nowSec - 10) })
    const runs = (await get(url, `/collab/runs?task_id=${taskId}`)).body as { runs: RunSegment[] }
    expect(runs.runs[0]).toMatchObject({ started_at: iso(nowSec - 120), execution_started_observed_at: iso(nowSec - 90), execution_finished_observed_at: iso(nowSec - 10) })
    const activity = (await get(url, `/collab/note/activity?id=${taskId}`)).body as { items: ActivityItem[] }
    expect(activity.items.find(one => one.type === 'run')).toMatchObject({ segment: runs.runs[0] })
  })
})

describe('E · GET /collab/capacity:在线 / 手上几件 / 未收场 / 上限分开给', () => {
  it('presence 实推 online;doing 计数;running_jobs 只数真实开工片段;limit 全是 unknown', async () => {
    const { url, jobLog } = await serve()
    const card = await post(url, '/collab/agent/save', { name: '小K', hand: 'kimi' })
    const cardId = String(card.body.id)
    // 在线:账上来一条这家的动静(presence 由 jobLog 推,30 分钟 TTL)
    jobLog.append({ job: 't-0', step: 'sent', family: cardId })
    // 名下 doing:assignee 匹配名片 id
    await makeTask(url, '在办的', { status: 'doing', assignee: cardId })
    await makeTask(url, '在办二', { status: 'doing', assignee: cardId })
    await makeTask(url, '别人在办', { status: 'doing', assignee: 'codex' })
    // 未收场片段:assigned 后没有收场步
    const openId = await makeTask(url, '还开着')
    jobLog.append({ job: openId, step: 'assigned', family: cardId, at: iso(nowSec - 60) })
    jobLog.append({ job: openId, step: 'started', family: cardId, at: iso(nowSec - 30) })
    const closedId = await makeTask(url, '已收场')
    jobLog.append({ job: closedId, step: 'assigned', family: cardId, at: iso(nowSec - 60) })
    jobLog.append({ job: closedId, step: 'replied', family: cardId, at: iso(nowSec - 30) })

    const got = await get(url, '/collab/capacity')
    expect(got.status).toBe(200)
    const items = (got.body as { items: CapacityItem[] }).items
    const mine = items.find(one => one.id === cardId)
    expect(mine).toMatchObject({ online: true, active_jobs: 2, running_jobs: 1, limit: 'unknown' })
    // 没动静的名片:online false
    const other = items.find(one => one.id === 'me')
    expect(other).toBeDefined()
    expect(other?.online).toBe(false)
    expect(items.every(one => one.limit === 'unknown')).toBe(true)
  })
})

describe('E · 活动流并入 run 段', () => {
  it('activity 里有 {type:run, segment};at 取收场时刻,未收场取开始时刻', async () => {
    const { url, jobLog } = await serve()
    const taskId = await makeTask(url, '卡')
    jobLog.append({ job: taskId, step: 'assigned', family: 'codex', at: iso(nowSec - 300) })
    jobLog.append({ job: taskId, step: 'replied', family: 'codex', at: iso(nowSec - 60) })
    const got = await get(url, `/collab/note/activity?id=${taskId}`)
    const items = (got.body as { items: ActivityItem[] }).items
    const run = items.find(one => one.type === 'run')
    expect(run).toBeDefined()
    expect(run?.at).toBe(iso(nowSec - 60))
    expect(run && 'segment' in run ? run.segment.status : '').toBe('done')
  })
})

/* ─────────────────────────── F:局域网身份与成员 ─────────────────────────── */

describe('F · 本机身份', () => {
  it('首次 GET 自动生成(名=事务官);两次 member_id 相同;hello 回同一身份', async () => {
    const { url } = await serve()
    const first = await get(url, '/collab/lan/identity')
    expect(first.status).toBe(200)
    const identity = (first.body as { identity: LanIdentity }).identity
    expect(identity.name).toBe('事务官')
    expect(identity.member_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(identity.version).toBe(1)
    const again = (await get(url, '/collab/lan/identity')).body as { identity: LanIdentity }
    expect(again.identity.member_id).toBe(identity.member_id)
    const hello = await get(url, '/collab/lan/hello')
    expect(hello.status).toBe(200)
    expect(hello.body).toMatchObject({ member_id: identity.member_id, name: '事务官' })
  })
  it('改名成功 version+1;expected_version 不符 409 且回包带服务端当前副本', async () => {
    const { url } = await serve()
    const current = ((await get(url, '/collab/lan/identity')).body as { identity: LanIdentity }).identity
    const conflict = await post(url, '/collab/lan/identity', { name: '新的名', expected_version: current.version + 5 })
    expect(conflict.status).toBe(409)
    expect(conflict.body.identity).toMatchObject({ member_id: current.member_id, version: current.version })
    const saved = await post(url, '/collab/lan/identity', { name: '新的名', expected_version: current.version })
    expect(saved.status).toBe(200)
    expect((saved.body as { identity: LanIdentity }).identity).toMatchObject({ name: '新的名', version: current.version + 1 })
  })
  it('归一查重:与已知成员重名(全角空白 / 大小写)409 带 conflict_with', async () => {
    const { url } = await serve()
    const member = await post(url, '/collab/lan/members/remember', { member_id: 'm-1', name: '小K', host: '127.0.0.1', port: 9 })
    expect(member.status).toBe(200)
    const dup = await post(url, '/collab/lan/identity', { name: '小ｋ ' })
    expect(dup.status).toBe(409)
    expect(String(dup.body.error)).toContain('名称与已知成员重复')
    expect(dup.body.conflict_with).toBe('m-1')
  })
  it('成员未见过或已失联时名称可用性始终 unknown,客户端声明不能放行', async () => {
    const { url } = await serve()
    await post(url, '/collab/lan/members/remember', { member_id: 'm-9', name: '没见过', host: '127.0.0.1', port: 9 })
    const blocked = await post(url, '/collab/lan/identity', { name: '随便改' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.availability).toBe('unknown')
    // 刷新失败仍缺席;客户端自称刷新成功也不能把范围变完整。
    await get(url, '/collab/lan/members?refresh=1')
    expect((await post(url, '/collab/lan/identity', { name: '随便改', members_refreshed: true })).body.availability).toBe('unknown')
  })
  it('空注册表不拦(无成员 = 无冲突)', async () => {
    const { url } = await serve()
    expect((await post(url, '/collab/lan/identity', { name: '任意名' })).status).toBe(200)
  })
})

describe('F · 成员注册表与按需 refresh', () => {
  it('remember 按 member_id 归并:改名不丢、不重复登记', async () => {
    const { url } = await serve()
    await post(url, '/collab/lan/members/remember', { member_id: 'm-1', name: '甲', host: '10.0.0.1', port: 8791 })
    await post(url, '/collab/lan/members/remember', { member_id: 'm-1', name: '甲二号', host: '10.0.0.2', port: 8792 })
    const got = await get(url, '/collab/lan/members')
    const members = (got.body as { members: LanMember[] }).members
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ member_id: 'm-1', name: '甲二号', host: '10.0.0.2', port: 8792 })
    expect(members[0]?.reachable).toBeUndefined()
  })
  it('refresh=1 逐个 ping /collab/lan/hello:通的 reachable:true + last_seen,死端口 false', async () => {
    // 对端 = 另一个服务实例(它自己的身份)
    const peerDir = mkdtempSync(join(tmpdir(), 'wb-collab-ef-peer-'))
    dirs.push(peerDir)
    let n = 0
    const peerTasks = createTasksService({ file: join(peerDir, 'tasks.json'), now: () => nowSec, newId: () => `t-${++n}` })
    const peer = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => nowSec }),
      tickIntervalMs: 0,
      tasks: peerTasks,
      jobLog: createJobLog(),
      collabWorkdir: async () => join(peerDir, 'work'),
    })
    started.push(peer)
    const peerUrl = new URL(peer.url)
    const peerId = (await peerTasks.lanIdentity()).member_id
    const { url } = await serve()
    await post(url, '/collab/lan/members/remember', { member_id: peerId, name: '活的对端', host: peerUrl.hostname, port: Number(peerUrl.port) })
    await post(url, '/collab/lan/members/remember', { member_id: 'm-dead', name: '死的端口', host: '127.0.0.1', port: 9 })
    const before = Date.parse(((await get(url, '/collab/lan/members')).body as { members: LanMember[] }).members.find(one => one.member_id === 'm-dead')?.last_seen ?? '')
    const got = await get(url, '/collab/lan/members?refresh=1')
    expect(got.status).toBe(200)
    const members = (got.body as { members: LanMember[] }).members
    const live = members.find(one => one.member_id === peerId)
    expect(live?.reachable).toBe(true)
    expect(typeof live?.last_seen).toBe('string')
    const dead = members.find(one => one.member_id === 'm-dead')
    expect(dead?.reachable).toBe(false)
    expect(Date.parse(dead?.last_seen ?? '')).toBe(before) // 没 ping 通,last_seen 不动
  })
  it('只有注册表而没有同项目配对路径的邀请如实 failed', async () => {
    const { url } = await serve()
    const taskId = await makeTask(url, '卡')
    await post(url, '/collab/lan/members/remember', { member_id: 'm-1', name: '成员甲', host: '127.0.0.1', port: 9 })
    const asked = await post(url, '/collab/note/message', { task_id: taskId, text: '接一下', intent: 'ask', mentions: ['member:m-1', 'member:查无此人'] })
    const deliveries = (asked.body.message as { deliveries: { to: string, status: string }[] }).deliveries
    expect(deliveries[0]).toMatchObject({ to: 'member:m-1', status: 'failed' })
    expect(deliveries[1]).toMatchObject({ to: 'member:查无此人', status: 'failed' })
  })
})
