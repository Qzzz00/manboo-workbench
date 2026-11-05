// @vitest-environment node
/*
 * 协作区执行轨迹(2026-10-27):`GET /collab/trace?goal_id=` 与纯函数 taskTraceOf。
 * 只从真实记录取节点:没记录就没节点;读不到当前位置 = unknown,不从卡片状态冒充 running。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GoalTraceView, TaskView } from '../src/protocol.ts'
import type { JobEvent } from '../src/server/jobLog.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { runSegmentsOf } from '../src/server/collabRoutes.ts'
import { taskTraceOf } from '../src/server/collabTrace.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createPersonalTokens } from '../src/server/personalToken.ts'

const T0 = Date.parse('2026-10-27T01:00:00.000Z')
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString()

function task(extra: Partial<TaskView> = {}): TaskView {
  return { id: 't1', title: '短片', status: 'todo', source: 'manual', created_at: at(0), updated_at: at(0), ...extra } as TaskView
}
function ev(sec: number, step: JobEvent['step'], extra: Partial<JobEvent> = {}): JobEvent {
  return { at: at(sec), job: 't1', step, ...extra }
}
function trace(t: TaskView, events: JobEvent[], nowSec: number, more: Partial<{ relations: Parameters<typeof taskTraceOf>[2], conditions: Parameters<typeof taskTraceOf>[3] }> = {}) {
  const nowMs = T0 + nowSec * 1000
  const runs = runSegmentsOf(t.id, events, nowMs, t)
  return taskTraceOf(t, events, more.relations ?? [], more.conditions ?? [], runs, nowMs)
}

describe('taskTraceOf · 纯函数', () => {
  it('assigned→sent→started→replied + 带证据回执:派出、送达、开工、交回(去重为一)、产物,按时序且带执行者', () => {
    const t = task({
      status: 'confirm',
      receipt: { kind: 'done', text: '做完:样片已出', evidence: ['out/sample.mp4'], by: 'codex', at: at(400) },
    })
    const events = [
      ev(100, 'assigned', { family: 'codex' }),
      ev(110, 'sent', { family: 'codex' }),
      ev(115, 'seen', { family: 'codex' }),
      ev(120, 'started', { family: 'codex' }),
      ev(130, 'started', { family: 'codex' }),
      ev(390, 'replied', { family: 'codex' }),
    ]
    const got = trace(t, events, 500)
    expect(got.task_id).toBe('t1')
    expect(got.nodes.map(n => n.kind)).toEqual(['dispatch', 'sent', 'start', 'return', 'artifact'])
    expect(got.nodes[0]).toMatchObject({ kind: 'dispatch', to: 'codex', at: at(100) })
    expect(got.nodes[0]?.actor).toBeUndefined()
    expect(got.nodes[2]).toMatchObject({ kind: 'start', actor: 'codex' })
    expect(got.nodes[3]).toMatchObject({ kind: 'return', actor: 'codex', text: '做完:样片已出' })
    expect(got.nodes[4]).toMatchObject({ kind: 'artifact', evidence: ['out/sample.mp4'] })
    expect(got.current.state).toBe('awaiting_review')
  })

  it('改一改评论 + 第二轮再派:先 rework 再 dispatch', () => {
    const t = task({
      status: 'doing',
      round: 2,
      comments: [{ id: 'c1', by: 'me', text: '开头太长', at: at(200), verdict: 'rework' }],
      transitions: [{ from: 'confirm', to: 'doing', at: at(201) }],
    })
    const events = [
      ev(100, 'assigned', { family: 'codex', task_round: 1 }),
      ev(150, 'replied', { family: 'codex', task_round: 1 }),
      ev(300, 'assigned', { family: 'codex', task_round: 2 }),
    ]
    const got = trace(t, events, 320)
    const kinds = got.nodes.map(n => n.kind)
    expect(kinds).toEqual(['dispatch', 'return', 'rework', 'dispatch'])
    expect(got.nodes[2]).toMatchObject({ actor: 'me', text: '开头太长' })
    expect(got.current.state).toBe('dispatched')
  })

  it('没有任何记录:nodes 为空,current = not_started', () => {
    const got = trace(task(), [], 10)
    expect(got.nodes).toEqual([])
    expect(got.current).toEqual({ state: 'not_started' })
  })

  it('卡片 doing 但没有运行片段:current = unknown,不冒充 running', () => {
    const got = trace(task({ status: 'doing' }), [], 10)
    expect(got.current.state).toBe('unknown')
  })

  it('运行中:current = running,执行者与起始时刻取自片段', () => {
    const got = trace(task({ status: 'doing' }), [ev(100, 'assigned', { family: 'codex' }), ev(110, 'started', { family: 'codex' })], 130)
    expect(got.current).toEqual({ state: 'running', actor: 'codex', since: at(100) })
  })

  it('前后两段执行源不同:第二段开头一个 handoff', () => {
    const events = [
      ev(100, 'assigned', { family: 'codex' }),
      ev(150, 'timeout', { family: 'codex', why: '等过头了' }),
      ev(200, 'assigned', { family: 'claude' }),
    ]
    const got = trace(task({ status: 'doing' }), events, 220)
    expect(got.nodes.map(n => n.kind)).toEqual(['dispatch', 'blocked', 'handoff', 'dispatch'])
    expect(got.nodes[1]).toMatchObject({ text: '等过头了' })
    expect(got.nodes[2]).toMatchObject({ kind: 'handoff', actor: 'codex', to: 'claude', at: at(200) })
  })

  it('通过评论与 done 经手只记一个 accept;关系与核验不通过各成节点', () => {
    const t = task({
      status: 'done',
      comments: [{ id: 'c1', by: 'me', text: '好', at: at(500), verdict: 'pass' }],
      transitions: [{ from: 'confirm', to: 'done', at: at(502) }],
    })
    const relations = [
      { id: 'r1', from_id: 't1', to_id: 't2', kind: 'depends_on' as const, created_at: at(10) },
      { id: 'r2', from_id: 't9', to_id: 't1', kind: 'rejected_back' as const, note: '字幕错', created_at: at(300) },
      { id: 'r3', from_id: 't1', to_id: 't3', kind: 'handoff' as const, note: '交给剪辑', created_at: at(510) },
    ]
    const conditions = [{ id: 'k1', text: '能看', task_id: 't1', verifications: [{ by: 'me', at: at(250), pass: false, note: '画面糊', round: 1 }], created_at: at(0), updated_at: at(0) }]
    const nowMs = T0 + 600_000
    const got = taskTraceOf(t, [], relations, conditions, [], nowMs, new Map([['t2', '素材']]))
    expect(got.nodes.map(n => n.kind)).toEqual(['arrange', 'rework', 'rework', 'accept', 'handoff'])
    expect(got.nodes[0]).toMatchObject({ text: '依赖「素材」' })
    expect(got.nodes[1]).toMatchObject({ actor: 'me', text: '画面糊' })
    expect(got.nodes[2]).toMatchObject({ text: '字幕错' })
    expect(got.nodes[3]).toMatchObject({ actor: 'me' })
    expect(got.nodes[4]).toMatchObject({ text: '交给剪辑' })
    expect(got.current.state).toBe('done')
  })
})

/* ─────────────────────────── 路由 ─────────────────────────── */

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('GET /collab/trace', () => {
  it('只回该目标下的事项;缺 goal_id = 400', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const iso = (sec: number): string => new Date(sec * 1000).toISOString()
    const dir = mkdtempSync(join(tmpdir(), 'wb-collab-trace-'))
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
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }
    const goalId = String((await post('/collab/goal/create', { title: '整目标' })).body.id)
    const a = String((await post('/task/create', { title: '甲', status: 'todo' })).body.id)
    const b = String((await post('/task/create', { title: '乙', status: 'todo' })).body.id)
    const other = String((await post('/task/create', { title: '别处', status: 'todo' })).body.id)
    expect((await post('/task/update', { id: a, goal_id: goalId })).status).toBe(200)
    expect((await post('/task/update', { id: b, goal_id: goalId })).status).toBe(200)
    jobLog.append({ job: a, step: 'assigned', family: 'codex', at: iso(nowSec - 100) })
    jobLog.append({ job: other, step: 'assigned', family: 'codex', at: iso(nowSec - 100) })

    const res = await fetch(`${server.url}/collab/trace?goal_id=${goalId}`)
    expect(res.status).toBe(200)
    const view = await res.json() as GoalTraceView
    expect(view.goal_id).toBe(goalId)
    expect(view.traces.map(one => one.task_id).sort()).toEqual([a, b].sort())
    const ta = view.traces.find(one => one.task_id === a)
    expect(ta?.nodes.map(node => node.kind)).toEqual(['dispatch'])
    expect(ta?.current.state).toBe('dispatched')
    expect(view.traces.find(one => one.task_id === b)?.current.state).toBe('not_started')

    expect((await fetch(`${server.url}/collab/trace`)).status).toBe(400)
  })
})
