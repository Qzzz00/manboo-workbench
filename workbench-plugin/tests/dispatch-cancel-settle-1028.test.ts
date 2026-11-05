// @vitest-environment node
/**
 * 取消要收场执行者的场景钉(2026-10-28,任务书 `docs/交接-1028-取消要收场执行者.md`)。
 *
 * 来历:悬浮球里取消一张在跑的卡,卡上 dispatch.status 仍 running,kimi-code 继续在
 * 工作树里跑了十几分钟,还会按流程交回到一张已取消的卡上 —— 额度白花,统筹还得记着不合它。
 *
 * 这里用**假送话手 + 真任务账 + 真租约文件 + 内存账**把派发器这一层的解法钉死:
 *   用例 1:kimi cli 在跑(假进程)→ cancel → 收到 SIGTERM、卡 dispatch.status=canceled、
 *          租约释放(证据 canceled_by_user)、账上一步 canceled(canceled_by_user);
 *          SIGTERM 之后进程赖着不退 → 到时补 SIGKILL。
 *   用例 2:取消后那只手还交回(进程临死前的「做完」)→ 卡仍 canceled、不进 confirm、
 *          不触发核验(onDelivered 不叫)、只落一条「取消后交回,已忽略」评论。
 *   用例 3:窗口手 → 往那条会话捎一句「这件取消了,停下」(她亲手点取消那一下,by:'user',
 *          闸的「收场了就不再动那一家」对它不拦)、卡上 reply_state 记 canceled、不再等交回。
 *   另:没有在跑的派发时 cancel 一字不动、回话不加句。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import type { ClientDispatch } from '../src/server/dispatchSend.ts'
import { createExecutionLeaseStore } from '../src/server/executionLease.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-28T09:30:00.000Z') / 1000)

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-disp-cancel-'))
  dirs.push(dir)
  return dir
}

interface FakeProcess {
  pid: number
  output_file: string
  exited: Promise<{ code: number }>
  resolve: (outcome: { code: number }) => void
}

interface Rig {
  runner: ReturnType<typeof createDispatchRunner>
  tasks: ReturnType<typeof createTasksService>
  jobLog: ReturnType<typeof createJobLog>
  lease: ReturnType<typeof createExecutionLeaseStore>
  leaseFile: string
  sends: Record<string, unknown>[]
  processes: Map<number, FakeProcess>
  alivePids: Set<number>
  outputs: Map<string, string>
  killCalls: { pid: number, signal: 'SIGTERM' | 'SIGKILL' }[]
  nextPid: number
  windowMode: boolean
  /** 交回即核验的回调收到过哪几张卡(用例 2 钉「不触发核验」)。 */
  delivered: string[]
  dispatchCli: (taskId: string) => Promise<{ ok: boolean, note: string }>
  dispatchWindow: (taskId: string) => Promise<{ ok: boolean, note: string }>
}

function rig(escalateAfterMs = 60): Rig {
  const dir = temp()
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${Math.floor(Math.random() * 1e9)}` })
  const jobLog = createJobLog({ now: () => new Date(NOW_SEC * 1000) })
  const leaseFile = join(dir, 'leases.json')
  const lease = createExecutionLeaseStore({ file: leaseFile })
  const sends: Record<string, unknown>[] = []
  const processes = new Map<number, FakeProcess>()
  const alivePids = new Set<number>()
  const outputs = new Map<string, string>()
  const killCalls: Rig['killCalls'] = []
  let nextPid = 9000
  let windowMode = false
  const delivered: string[] = []
  const clientDispatch = {
    send: async (input: Record<string, unknown>) => {
      sends.push(input)
      if (windowMode) {
        // 窗口那只手:话送进了它那条会话(这里直接报会话号,不走差集认会话)。
        return {
          ok: true,
          dispatch: {
            hand: 'window', family: input.family, status: 'sent', at: new Date(NOW_SEC * 1000).toISOString(),
            text: input.text, marker: '工作台派活 deadbeef', new_conversation: '新聊天', session_id: 's-win-1',
            submitted: true,
          },
        }
      }
      let resolve!: (outcome: { code: number }) => void
      const exited = new Promise<{ code: number }>((res) => { resolve = res })
      const pid = nextPid++
      const output_file = join(dir, `out-${pid}`)
      const proc: FakeProcess = { pid, output_file, exited, resolve }
      processes.set(pid, proc)
      alivePids.add(pid)
      void exited.then(() => { alivePids.delete(pid) })
      return { ok: true, result: { via: 'cli', process: proc } }
    },
  } as unknown as ClientDispatch
  const runner = createDispatchRunner({
    tasks,
    clientDispatch,
    jobLog,
    lease,
    readFile: async (file) => outputs.get(file),
    alive: pid => alivePids.has(pid),
    killPid: (pid: number) => { killCalls.push({ pid, signal: 'SIGTERM' }) },
    killPidHard: (pid: number) => { killCalls.push({ pid, signal: 'SIGKILL' }) },
    escalateAfterMs,
    sessions: () => [],
    now: () => new Date(NOW_SEC * 1000),
    pollMs: 60_000,
    onDelivered: (taskId: string) => { delivered.push(taskId) },
  })
  return {
    runner, tasks, jobLog, lease, leaseFile, sends, processes, alivePids, outputs, killCalls, delivered,
    get nextPid() { return nextPid },
    set nextPid(v) { nextPid = v },
    get windowMode() { return windowMode },
    set windowMode(v) { windowMode = v },
    dispatchCli: async (taskId: string) => {
      const r = await runner.start(taskId, { family: 'kimi', said: '把这件事办了', kind: 'code', cwd: '/wt/one' })
      return { ok: r.ok, note: r.note }
    },
    dispatchWindow: async (taskId: string) => {
      const r = await runner.start(taskId, { family: 'doubao', said: '把这件事办了' })
      return { ok: r.ok, note: r.note }
    },
  } as unknown as Rig
}

async function makeTask(r: Rig, title = '取消收场试验'): Promise<string> {
  const created = await r.tasks.create({ title, status: 'doing' })
  return created.id as string
}

const sleep = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))

describe('用例 1:命令行手(kimi cli)在跑 → 取消收场', () => {
  it('收到 SIGTERM;卡 dispatch.status=canceled + ended_at;租约释放(证据 canceled_by_user);账记 canceled_by_user', async () => {
    const r = rig()
    const id = await makeTask(r)
    const started = await r.dispatchCli(id)
    expect(started.ok).toBe(true)
    const pid = [...r.processes.keys()][0] as number

    const moved = await r.tasks.move(id, 'canceled')
    expect(moved.ok).toBe(true)
    const result = await r.runner.cancel(id)
    expect(result.settled).toBe(true)
    expect(result.note).toContain('已停')

    // ① SIGTERM 发到了那个假进程。
    expect(r.killCalls).toEqual([{ pid, signal: 'SIGTERM' }])
    // ② 卡上 dispatch 记 canceled + ended_at。
    const card = (await r.tasks.list()).tasks.find(one => one.id === id)
    expect(card?.status).toBe('canceled')
    expect(card?.dispatch?.status).toBe('canceled')
    expect(card?.dispatch?.ended_at).toBeDefined()
    // ③ 租约释放,证据 = canceled_by_user。
    expect(await r.lease.activeForTask(id)).toBeUndefined()
    // ④ 账上一步 canceled,carry canceled_by_user。
    const events = r.jobLog.events(id)
    const canceledStep = events.find(one => one.step === 'canceled')
    expect(canceledStep).toBeDefined()
    expect(canceledStep?.why).toBe('canceled_by_user')
    expect(canceledStep?.family).toBe('kimi')
  })

  it('SIGTERM 之后赖着不退 → 到时补 SIGKILL;已经退了的不补', async () => {
    const r = rig(25)
    const id = await makeTask(r)
    await r.dispatchCli(id)
    const pid = [...r.processes.keys()][0] as number
    await r.tasks.move(id, 'canceled')
    await r.runner.cancel(id)
    // 进程还活着(没退)→ 补刀那一拍到点落下来。
    await sleep(90)
    expect(r.killCalls).toContainEqual({ pid, signal: 'SIGKILL' })
  })

  it('没有在跑的派发:cancel 一字不动、不加回话句', async () => {
    const r = rig()
    const id = await makeTask(r)
    await r.tasks.move(id, 'canceled')
    const result = await r.runner.cancel(id)
    expect(result.settled).toBe(false)
    expect(result.note).toBeUndefined()
    expect(r.killCalls).toEqual([])
    expect(r.sends).toEqual([])
  })
})

describe('用例 2:取消后那只手还交回(进程临死前的「做完」)', () => {
  it('卡仍 canceled、不进 confirm、不触发核验,只落一条「取消后交回,已忽略」评论', async () => {
    const r = rig()
    const id = await makeTask(r)
    await r.dispatchCli(id)
    const pid = [...r.processes.keys()][0] as number
    const fake = r.processes.get(pid) as FakeProcess

    await r.tasks.move(id, 'canceled')
    await r.runner.cancel(id)

    // 那只手临死前把「做完」写进了结果文件,进程退出(exit 回调 → finishCli)。
    r.outputs.set(fake.output_file, '做完:交回的东西')
    r.outputs.set(`${fake.output_file}.jsonl`, '{"type":"turn.completed"}')
    fake.resolve({ code: 0 })
    await fake.exited
    await sleep(30)

    const card = (await r.tasks.list()).tasks.find(one => one.id === id)
    expect(card?.status).toBe('canceled')
    expect(card?.dispatch?.status).toBe('canceled')
    // 交回的回答没有写进卡(不进 confirm、没有 reply、没有交付物)。
    expect(card?.dispatch?.reply ?? '').toBe('')
    expect(card?.deliverables ?? []).toEqual([])
    // 不触发核验(交回即核验的回调没叫到这张卡)。
    expect(r.delivered).toEqual([])
    // 只落一条评论。
    const notes = (card?.comments ?? []).map(one => one.text)
    expect(notes.filter(one => one === '取消后交回,已忽略')).toHaveLength(1)
  })
})

describe('用例 3:窗口手 → 捎话一句、卡标 canceled', () => {
  it('往那条会话捎「这件取消了,停下」(她亲手点取消那一下,by:user,不走新对话);reply_state 记 canceled', async () => {
    const r = rig()
    r.windowMode = true
    const id = await makeTask(r)
    const started = await r.dispatchWindow(id)
    expect(started.ok).toBe(true)
    const before = (await r.tasks.list()).tasks.find(one => one.id === id)
    expect(before?.client_dispatch?.reply_state).toBe('waiting')

    await r.tasks.move(id, 'canceled')
    const result = await r.runner.cancel(id)
    expect(result.settled).toBe(true)
    expect(result.note).toContain('说这件取消了')

    // ① 捎话那一句:送进原来那条会话(不开新对话),标了她亲手点的取消。
    const say = r.sends.at(-1) as Record<string, unknown>
    expect(say.text).toBe('这件取消了,停下')
    expect(say.newConversation).toBe(false)
    expect(say.resumeSessionId).toBe('s-win-1')
    expect(say.by).toBe('user')
    // ② 卡上记 canceled:不再等它交回。
    const card = (await r.tasks.list()).tasks.find(one => one.id === id)
    expect(card?.client_dispatch?.reply_state).toBe('canceled')
    expect(card?.status).toBe('canceled')
    // ③ 账上也记一步 canceled_by_user。
    expect(r.jobLog.events(id).some(one => one.step === 'canceled' && one.why === 'canceled_by_user')).toBe(true)
  })
})
