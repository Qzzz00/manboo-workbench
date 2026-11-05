// @vitest-environment node
/*
 * 任务书 10-29「在跑的事项要数到命令行真在跑的活」的服务端用例:
 * ①(第二轮改口)任务日志是唯一那本账;`runSegmentsOf` 的判法一处没动,卡上 `dispatch` 是派发口
 *    同一拍写下的运行态、给账补见证:dispatch.status running 且 pid 活着 → `running`
 *    (含账里 started 缺席的老卡 / 账被裁,含 started 在账但活动过了 RUN_ACTIVE_STALE_MS 的等模型);
 *    只有派出事件、卡上没运行态 → `dispatched`(原行为);dispatch 有 ended_at → 按回执判
 *    (账里有收场步照旧认账;账里缺席时认卡上回执,有回执 done、没回执 failed)。
 *    起进程记 `started`(带 pid / 轮次身份)、活动记 `updated`(30 秒节流)、退场记 `ended` 照旧。
 * ①b `executionOverview` 的 `observed_running_tasks` / `observed_running_sessions` 与
 *    `GET /collab/runs` 数出来的在跑事项一致(同一组卡两边各算一次,相等)。
 * ② `GET /collab/runs` 不带参数 = 全部**未结卡**的片段,一次请求 —— 没归目标的卡也在里面;
 *    已收场(done/canceled)的卡不进这本;`?task_id=` / `?goal_id=` 两种老读法照旧。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RUN_ACTIVE_STALE_MS, type RunSegment, type TaskView, type WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog, type JobEvent } from '../src/server/jobLog.ts'
import { createPersonalTokens } from '../src/server/personalToken.ts'
import { runSegmentsOf } from '../src/server/collabRoutes.ts'
import { CLI_ACTIVITY_THROTTLE_MS, createDispatchRunner } from '../src/server/dispatchRun.ts'
import { createCliAdapter } from '../src/server/engine/adapters/cli.ts'
import type { AgentCli } from '../src/server/agentDispatch.ts'
import type { ClientDispatch, SendToClientInput } from '../src/server/dispatchSend.ts'
import type { Job } from '../src/server/engine/adapter.ts'

/* ─────────────── ① runSegmentsOf:命令行的 started/updated/ended ─────────────── */

const T0 = Date.parse('2026-10-29T01:00:00.000Z')
const at = (ms: number): string => new Date(T0 + ms).toISOString()
const DISPATCHED: JobEvent[] = [
  { job: 't-cli', step: 'assigned', family: 'kimi', at: at(0) },
  { job: 't-cli', step: 'seen', family: 'kimi', via: 'cli', at: at(1_000) },
]
const segment = (events: JobEvent[], nowMs: number): RunSegment => runSegmentsOf('t-cli', events, nowMs)[0]!

describe('runSegmentsOf:命令行这一路靠事实变 running(判法一处没动)', () => {
  it('只有派出事件(assigned/seen)= dispatched(原行为)', () => {
    expect(segment(DISPATCHED, T0 + 60_000).status).toBe('dispatched')
  })
  it('派出后有 started = running', () => {
    const runs = segment([...DISPATCHED, { job: 't-cli', step: 'started', family: 'kimi', via: 'cli', pid: 93149, at: at(5_000) }], T0 + 60_000)
    expect(runs.status).toBe('running')
  })
  it('活动(updated)把在跑续上;过了 RUN_ACTIVE_STALE_MS 没活动 = unknown(失联)', () => {
    const events: JobEvent[] = [
      ...DISPATCHED,
      { job: 't-cli', step: 'started', family: 'kimi', via: 'cli', pid: 93149, at: at(5_000) },
      { job: 't-cli', step: 'updated', family: 'kimi', via: 'cli', at: at(5_000 + 110_000) },
    ]
    // 距最近一次活动 20 秒:在跑。
    expect(segment(events, T0 + 5_000 + 130_000).status).toBe('running')
    // 距最近一次活动超过 2 分钟:失联,不当作在跑。
    expect(segment(events, T0 + 5_000 + 110_000 + RUN_ACTIVE_STALE_MS + 1).status).toBe('unknown')
    // 有 started 但从没有任何活动、超过 2 分钟:同样 unknown。
    expect(segment(events.slice(0, 3), T0 + 5_000 + RUN_ACTIVE_STALE_MS + 1).status).toBe('unknown')
  })
  it('收场照旧认第一条收场步:ended 排在 replied 之后,outcome 仍是 replied', () => {
    const events: JobEvent[] = [
      ...DISPATCHED,
      { job: 't-cli', step: 'started', family: 'kimi', via: 'cli', pid: 93149, at: at(5_000) },
      { job: 't-cli', step: 'replied', family: 'kimi', at: at(600_000) },
      { job: 't-cli', step: 'ended', family: 'kimi', via: 'cli', pid: 93149, at: at(600_500) },
    ]
    const runs = segment(events, T0 + 700_000)
    expect(runs.status).toBe('done')
    expect(runs.outcome).toBe('replied')
    expect(runs.finished_at).toBe(at(600_000))
  })
})

/* ───── ①(第二轮改口)卡上 dispatch 运行态 = 派发口同一拍写下的见证,给任务日志这本账补事实 ───── */

const taskWithDispatch = (more: Partial<TaskView> & { dispatch: NonNullable<TaskView['dispatch']> }): TaskView =>
  ({ id: 't-cli', title: '卡', status: 'doing', source: { kind: 'manual' }, created_at: at(0), updated_at: at(0), ...more }) as TaskView
const LIVE_CLI = { family: 'kimi', status: 'running', hand: 'cli', pid: 93149, started_at: at(5_000) } as const
const segmentOfTask = (events: readonly JobEvent[], task: TaskView, nowMs: number): RunSegment =>
  runSegmentsOf('t-cli', events, nowMs, task)[0]!

describe('runSegmentsOf:卡上 dispatch 运行态是同一派发口的见证(以账为准,账缺的由它补)', () => {
  it('卡上 dispatch.status running 且 pid 活着、账里 started 缺席(老卡 / 账被裁)→ running', () => {
    const task = taskWithDispatch({ dispatch: { ...LIVE_CLI } })
    expect(segmentOfTask(DISPATCHED, task, T0 + 600_000).status).toBe('running')
  })
  it('started 在账但活动过了 RUN_ACTIVE_STALE_MS:pid 活着照旧 running(等模型不是失联)', () => {
    const task = taskWithDispatch({ dispatch: { ...LIVE_CLI } })
    const events: JobEvent[] = [
      ...DISPATCHED,
      { job: 't-cli', step: 'started', family: 'kimi', via: 'cli', pid: 93149, at: at(5_000) },
    ]
    expect(segmentOfTask(events, task, T0 + 5_000 + RUN_ACTIVE_STALE_MS + 1).status).toBe('running')
  })
  it('dispatch 有 ended_at = 收场,账里有收场步照旧认账:replied → done、outcome 不变', () => {
    const task = taskWithDispatch({ dispatch: { ...LIVE_CLI, status: 'done', ended_at: at(600_000) } })
    const events: JobEvent[] = [
      ...DISPATCHED,
      { job: 't-cli', step: 'started', family: 'kimi', via: 'cli', pid: 93149, at: at(5_000) },
      { job: 't-cli', step: 'replied', family: 'kimi', at: at(600_000) },
      { job: 't-cli', step: 'ended', family: 'kimi', via: 'cli', pid: 93149, at: at(600_500) },
    ]
    const runs = segmentOfTask(events, task, T0 + 700_000)
    expect(runs.status).toBe('done')
    expect(runs.outcome).toBe('replied')
  })
  it('dispatch 有 ended_at 而账里收场步缺席(账被裁):按回执判 —— 有回执 done、没回执 failed', () => {
    const ended = { ...LIVE_CLI, status: 'done', ended_at: at(600_000) } as const
    const withReceipt = taskWithDispatch({ dispatch: { ...ended },
      receipt: { kind: 'done', text: '做完:悬浮球计数修好了', by: 'kimi', at: at(600_000) } })
    expect(segmentOfTask(DISPATCHED, withReceipt, T0 + 700_000).status).toBe('done')
    const withoutReceipt = taskWithDispatch({ dispatch: { ...ended } })
    expect(segmentOfTask(DISPATCHED, withoutReceipt, T0 + 700_000).status).toBe('failed')
  })
  it('只有派出事件、卡上没运行态(没 dispatch)→ dispatched(原行为);已收场的 dispatch 按回执判', () => {
    expect(segment(DISPATCHED, T0 + 60_000).status).toBe('dispatched')
    const noDispatch = taskWithDispatch({ dispatch: undefined as never })
    delete (noDispatch as { dispatch?: unknown }).dispatch
    expect(segmentOfTask(DISPATCHED, noDispatch, T0 + 60_000).status).toBe('dispatched')
    // dispatch 已收场(ended_at 在)而账里没记到收场步:按回执判,卡上没回执 = failed,不是 dispatched。
    const settled = taskWithDispatch({ dispatch: { ...LIVE_CLI, status: 'failed', started_at: at(1_000), ended_at: at(2_000) } })
    expect(segmentOfTask(DISPATCHED, settled, T0 + 60_000).status).toBe('failed')
  })
})

/* ─────────────── ① 派发那一程:起进程记 started、活动节流、退场记 ended ─────────────── */

let clock = Date.parse('2026-10-29T02:00:00.000Z')

function cliRig() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-collab-runs-cli-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => `t-1029${++n}` })
  const jobLog = createJobLog({ now: () => new Date(clock) })
  const files = new Map<string, string>()
  let exit: (code: number | null) => void = () => {}
  const cli: AgentCli = { found: true, family: 'codex', bin: '/test/codex', source: 'bundled' }
  const jobOf = (input: SendToClientInput): Job => ({
    id: input.job ?? 'j', ...(input.job === undefined ? {} : { itemId: input.job }), family: input.family, kind: 'dispatch', target: { kind: 'new' },
    text: input.text, expect: 'ack',
    ...(input.work === undefined ? {} : { work: input.work }), ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  })
  // 窗口那一路这份用例不碰:假送话直接走命令行适配器,并替引擎记「assigned + seen(核到)」
  // 那两行(真跑时引擎自己记,见 engine.JOB_LOG_STEP —— 这份假件兼着引擎的记账角色)。
  const clientDispatch: ClientDispatch = {
    async send(input) {
      jobLog.append({ job: input.job ?? 'j', step: 'assigned', family: input.family, via: 'cli' })
      const out = await createCliAdapter(input.family as AgentCli['family'] ?? 'codex', {
        resolveCli: () => cli,
        runCli: () => ({ pid: 4242, exited: new Promise<{ code: number | null }>(resolve => { exit = code => resolve({ code }) }) }),
        resultDir: join(dir, 'results'),
        now: () => new Date(clock),
      }).run(jobOf(input))
      if (out.delivered === 'confirmed') jobLog.append({ job: input.job ?? 'j', step: 'seen', family: input.family, via: 'cli' })
      return { ok: true, result: out }
    },
  }
  const runner = createDispatchRunner({
    tasks, clientDispatch, jobLog,
    alive: () => true,
    readFile: async file => files.get(file),
    sessions: () => [],
    now: () => new Date(clock),
    setTimer: () => 'timer',
    clearTimer: () => {},
  })
  return { tasks, jobLog, files, runner, finishCli: (code: number | null) => exit(code) }
}

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })
beforeEach(() => { clock = Date.parse('2026-10-29T02:00:00.000Z') })

async function cardOf(r: ReturnType<typeof cliRig>, id: string) {
  return (await r.tasks.list()).tasks.find(one => one.id === id)
}

describe('命令行派发:任务日志记下开工 / 活动 / 退场', () => {
  it('起进程成功那一刻记 started(带 pid 与轮次身份);活动 30 秒节流;退出记 ended', async () => {
    const r = cliRig()
    const created = await r.tasks.create({ title: '修悬浮球计数', direction: 'mine', status: 'todo' })
    const id = created.id as string
    const started = await r.runner.start(id, { family: 'codex', said: '修悬浮球计数', cwd: '/tmp/demo', kind: 'code' })
    expect(started).toMatchObject({ ok: true, hand: 'cli' })
    const task = await cardOf(r, id)
    expect(task?.dispatch).toMatchObject({ hand: 'cli', status: 'running', pid: 4242 })
    const attempt = task?.dispatch?.runtime?.attempt_id

    // ① 起进程那一刻:账上有 started,带 pid 与这一轮身份 —— 面板从此数得到它。
    let events = r.jobLog.events(id)
    const startedEvent = events.find(one => one.step === 'started')
    expect(startedEvent).toMatchObject({ family: 'codex', via: 'cli', pid: 4242, attempt_id: attempt })
    expect(segmentOf(id, events).status).toBe('running')

    // 执行账每多一行有效输出记一条活动;30 秒内不重复记。
    const out = task?.dispatch?.output_file as string
    const logFile = `${out}.jsonl`
    r.files.set(logFile, '{"type":"thread.started","thread_id":"01a0d392"}\n')
    await r.runner.tick()
    events = r.jobLog.events(id)
    expect(events.filter(one => one.step === 'updated')).toHaveLength(1)
    expect(events.filter(one => one.step === 'updated')[0]).toMatchObject({ family: 'codex', via: 'cli' })
    r.files.set(logFile, '{"type":"thread.started","thread_id":"01a0d392"}\n{"type":"turn.started"}\n{"type":"item.completed"}\n')
    await r.runner.tick()
    expect(r.jobLog.events(id).filter(one => one.step === 'updated')).toHaveLength(1)

    // 过了节流窗口、又有新输出:再记一条。
    clock += CLI_ACTIVITY_THROTTLE_MS + 1_000
    r.files.set(logFile, '{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}\n')
    await r.runner.tick()
    expect(r.jobLog.events(id).filter(one => one.step === 'updated')).toHaveLength(2)
    // 活动续着:片段依旧在跑。
    expect(segmentOf(id, r.jobLog.events(id)).status).toBe('running')

    // 退出:replied(有结果)+ ended(退场),片段收场、口径不变。
    r.files.set(out, '做完了,悬浮球计数修好了。')
    r.files.set(logFile, '{"a":1}\n{"type":"turn.completed","thread_id":"01a0d392"}\n')
    r.finishCli(0)
    for (let i = 0; i < 50 && (await cardOf(r, id))?.status !== 'confirm'; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
    const done = await cardOf(r, id)
    expect(done?.status).toBe('confirm')
    events = r.jobLog.events(id)
    expect(events.some(one => one.step === 'replied')).toBe(true)
    expect(events.filter(one => one.step === 'ended')).toHaveLength(1)
    expect(events.findLast(one => one.step === 'ended')).toMatchObject({ pid: 4242 })
    const settled = segmentOf(id, events)
    expect(settled.status).toBe('done')
    expect(settled.outcome).toBe('replied')
  })
})

function segmentOf(id: string, events: readonly JobEvent[]): RunSegment {
  return runSegmentsOf(id, events, clock)[0]!
}

/* ─────────────── ② GET /collab/runs:不带参数 = 全部未结卡 ─────────────── */

let nowSec = 0
const iso = (sec: number): string => new Date(sec * 1000).toISOString()
const startedServers: WorkbenchServer[] = []
beforeEach(() => { nowSec = Math.floor(Date.now() / 1000) })
afterEach(async () => {
  while (startedServers.length) await startedServers.pop()?.close()
})

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-collab-runs-http-'))
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
  startedServers.push(server)
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

describe('GET /collab/runs 不带参数 = 全部未结卡(没归目标的也在里面)', () => {
  it('未结卡在数(含没归目标的);已收场的卡不进这本;老读法照旧', async () => {
    const { url, jobLog } = await serve()
    // 没归目标的在跑卡(悬浮球里说一句建的那种):assigned + started,没人给它 goal_id。
    const ungoalId = await makeTask(url, '悬浮球里说一句建的活')
    jobLog.append({ job: ungoalId, step: 'assigned', family: 'kimi', at: iso(nowSec - 600) })
    jobLog.append({ job: ungoalId, step: 'started', family: 'kimi', via: 'cli', pid: 93149, at: iso(nowSec - 30) })
    // 归了目标的在跑卡。
    const goal = await post(url, '/collab/goal/create', { title: '整目标' })
    const goalId = String(goal.body.id)
    const goalIdTask = await makeTask(url, '目标下的活')
    expect((await post(url, '/task/update', { id: goalIdTask, goal_id: goalId })).status).toBe(200)
    jobLog.append({ job: goalIdTask, step: 'assigned', family: 'codex', at: iso(nowSec - 300) })
    jobLog.append({ job: goalIdTask, step: 'replied', family: 'codex', at: iso(nowSec - 60) })
    // 已收场的卡(done):不在「未结」里,不进来。
    const doneId = await makeTask(url, '办完的事')
    expect((await post(url, '/task/move', { id: doneId, status: 'doing' })).status).toBe(200)
    expect((await post(url, '/task/move', { id: doneId, status: 'done' })).status).toBe(200)
    jobLog.append({ job: doneId, step: 'assigned', family: 'kimi', at: iso(nowSec - 900) })
    jobLog.append({ job: doneId, step: 'replied', family: 'kimi', at: iso(nowSec - 800) })
    // 从没派过的未结卡:没有事件,不编一段。
    await makeTask(url, '还没派的活')

    const got = await get(url, '/collab/runs')
    expect(got.status).toBe(200)
    const runs = (got.body as { runs: RunSegment[] }).runs
    const byTask = new Map(runs.map(one => [one.task_id, one]))
    // 没归目标的那张在跑 —— 从前的洞:按 goal_id 逐个查永远查不到它。
    expect(byTask.get(ungoalId)).toMatchObject({ status: 'running', source: 'kimi' })
    expect(byTask.get(goalIdTask)).toMatchObject({ status: 'done', outcome: 'replied' })
    expect(byTask.has(doneId)).toBe(false)
    expect(runs).toHaveLength(2)

    // 老读法照旧:一张卡 / 一整个目标。
    expect(((await get(url, `/collab/runs?task_id=${ungoalId}`)).body as { runs: RunSegment[] }).runs).toHaveLength(1)
    expect(((await get(url, `/collab/runs?goal_id=${goalId}`)).body as { runs: RunSegment[] }).runs.map(one => one.task_id)).toEqual([goalIdTask])
  })
})


/* ───── ①b execution 总览的在跑数与 /collab/runs 同一本账(同一组卡两边各算一次,相等) ───── */

describe('①b executionOverview 的在跑数 = /collab/runs 数出来的在跑事项', () => {
  it('同一组卡:observed_running_tasks / observed_running_sessions 与 /collab/runs 各算一次,相等', async () => {
    const { url, jobLog } = await serve()
    // 三张在跑的卡:Kimi 命令行没归目标(悬浮球建的)、Codex 归了目标、Claude 命令行在 doing。
    const ungoalId = await makeTask(url, '悬浮球里说一句建的活')
    expect((await post(url, '/task/move', { id: ungoalId, status: 'doing' })).status).toBe(200)
    jobLog.append({ job: ungoalId, step: 'assigned', family: 'kimi', at: iso(nowSec - 600) })
    jobLog.append({ job: ungoalId, step: 'started', family: 'kimi', via: 'cli', pid: 93149, at: iso(nowSec - 30) })
    const goal = await post(url, '/collab/goal/create', { title: '整目标' })
    const goalId = String(goal.body.id)
    const goalTask = await makeTask(url, '目标下的活')
    expect((await post(url, '/task/update', { id: goalTask, goal_id: goalId })).status).toBe(200)
    expect((await post(url, '/task/move', { id: goalTask, status: 'doing' })).status).toBe(200)
    jobLog.append({ job: goalTask, step: 'assigned', family: 'codex', at: iso(nowSec - 300) })
    jobLog.append({ job: goalTask, step: 'started', family: 'codex', via: 'cli', pid: 4242, at: iso(nowSec - 20) })
    const thirdId = await makeTask(url, '第三件在跑的活')
    expect((await post(url, '/task/move', { id: thirdId, status: 'doing' })).status).toBe(200)
    jobLog.append({ job: thirdId, step: 'assigned', family: 'claude', at: iso(nowSec - 200) })
    jobLog.append({ job: thirdId, step: 'started', family: 'claude', via: 'cli', pid: 777, at: iso(nowSec - 10) })
    // 不在数里的:已收场卡、从没派过的卡。
    const doneId = await makeTask(url, '办完的事')
    expect((await post(url, '/task/move', { id: doneId, status: 'doing' })).status).toBe(200)
    expect((await post(url, '/task/move', { id: doneId, status: 'done' })).status).toBe(200)
    jobLog.append({ job: doneId, step: 'assigned', family: 'kimi', at: iso(nowSec - 900) })
    jobLog.append({ job: doneId, step: 'replied', family: 'kimi', at: iso(nowSec - 800) })
    await makeTask(url, '还没派的活')

    // 这边:/collab/runs 全部未结卡,按客户端同一口径(runningTaskIdsOfRuns)数在跑事项。
    const runs = ((await get(url, '/collab/runs')).body as { runs: RunSegment[] }).runs
    const runningBusiness = runs.filter(one => one.status === 'running' && one.role === 'business')
    const fromRunsTasks = new Set(runningBusiness.map(one => one.task_id)).size
    // 那边:/state.execution 总览自己推的 observed_running_tasks。
    const state = (await get(url, '/state')).body as unknown as WorkbenchState
    expect(state.execution?.observed_running_tasks).toBe(fromRunsTasks)
    expect(state.execution?.observed_running_tasks).toBe(3)
    expect(state.execution?.observed_running_sessions).toBe(runningBusiness.length)
  })
})
