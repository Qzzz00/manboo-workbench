// @vitest-environment node
/**
 * 执行租约接进派发器的场景钉(2026-10-26,卡「事务官机制D」t-ea3ba424)。
 *
 * 复现 14:36 事故链:同卡同树两次正常派发起来了两个 Kimi 进程;一路拿中途文本说 done,
 * 原生轮次却还在跑。这里用**假送话手 + 真任务账 + 真租约文件**把派发器这一层的解法钉死:
 *   - 两个并发正常入口只有一个派出(另一个被拒,回执带 holder 真身);
 *   - 同卡重试:真终态(进程退出)之后自动能派;píd 没了但没人看到结束 → 拒(不确定保留),
 *     同卡人点重派(takeover)才接上;
 *   - 不同卡同一工作树 → 拒;
 *   - 进程没起来(送话失败)→ 租约放手,能再派;
 *   - 异常退出 → 放手;
 *   - 重启:新派发器实例照同一份租约文件拒;巡检 pid-gone 只标不确定、不重派;
 *   - 迟到的旧进程退出摘不动新租约;
 *   - 结果文件里已有「像交卷的话」但进程没退出 → 租约不放(终态证据是退出,不是文本)。
 *
 * 不起真进程:送话手是注入的假件(与 dispatchRun 的 deps 契约同一份)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import type { ClientDispatch } from '../src/server/dispatchSend.ts'
import { createExecutionLeaseStore } from '../src/server/executionLease.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-26T08:40:00.000Z') / 1000)

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-disp-lease-'))
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
  leaseFile: string
  sends: { text: string, cwd?: string }[]
  processes: Map<number, FakeProcess>
  alivePids: Set<number>
  outputs: Map<string, string>
  nextPid: number
  failNextSend: boolean
  dispatch: (taskId: string, opts?: { cwd?: string, said?: string }) => Promise<{ ok: boolean, note: string }>
}

function rig(): Rig {
  const dir = temp()
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${Math.floor(Math.random() * 1e9)}` })
  const leaseFile = join(dir, 'leases.json')
  const sends: Rig['sends'] = []
  const processes = new Map<number, FakeProcess>()
  const alivePids = new Set<number>()
  const outputs = new Map<string, string>()
  let nextPid = 9000
  let failNextSend = false
  const clientDispatch = {
    send: async (input: { text: string, cwd?: string }) => {
      sends.push({ text: input.text, ...(input.cwd === undefined ? {} : { cwd: input.cwd }) })
      if (failNextSend) { failNextSend = false; return { ok: false, reason: '起进程那一下失败了(注入)' } }
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
    lease: createExecutionLeaseStore({ file: leaseFile }),
    readFile: async (file) => outputs.get(file),
    alive: pid => alivePids.has(pid),
    sessions: () => [],
    now: () => new Date(NOW_SEC * 1000),
    pollMs: 60_000,
  })
  return {
    runner, tasks, leaseFile, sends, processes, alivePids, outputs,
    get nextPid() { return nextPid },
    set nextPid(v) { nextPid = v },
    get failNextSend() { return failNextSend },
    set failNextSend(v) { failNextSend = v },
    dispatch: async (taskId: string, opts: { cwd?: string, said?: string } = {}) => {
      const r = await runner.start(taskId, { family: 'codex', said: opts.said ?? '把这件事办了', kind: 'code', ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) })
      return { ok: r.ok, note: r.note }
    },
  } as unknown as Rig
}

async function makeCodeTask(r: Rig, title = '租约试验'): Promise<string> {
  const created = await r.tasks.create({ title, status: 'doing' })
  return created.id as string
}

/** 终态:让某个 pid 退出(exit-observed),输出文件带上交卷的话。 */
async function exitProcess(r: Rig, pid: number, code: number, reply = '做完了:XYZ'): Promise<void> {
  const proc = r.processes.get(pid)
  if (proc === undefined) throw new Error(`no fake process ${pid}`)
  r.outputs.set(proc.output_file, reply)
  r.outputs.set(`${proc.output_file}.jsonl`, '{"type":"turn.completed"}')
  proc.resolve({ code })
  await proc.exited
  // exit 回调是微任务挂链:让 finishCli 跑完。
  await new Promise(resolve => setTimeout(resolve, 20))
}

describe('并发与重试', () => {
  it('★两个并发正常入口同卡同树:只一个派出(真起进程),另一个被拒、回执带 holder 真身', async () => {
    const r = rig()
    const id = await makeCodeTask(r)
    const [a, b] = await Promise.all([r.dispatch(id, { cwd: '/wt/one' }), r.dispatch(id, { cwd: '/wt/one' })])
    const okCount = [a, b].filter(one => one.ok).length
    expect(okCount).toBe(1)
    expect(r.sends).toHaveLength(1)
    const loser = a.ok ? b : a
    expect(loser.note).toContain('重复派')
    expect(loser.note).toContain('占着')
  })

  it('★同卡重试:真终态(进程退出、交卷)之后自动能派;第二个进程真起来', async () => {
    const r = rig()
    const id = await makeCodeTask(r)
    const first = await r.dispatch(id, { cwd: '/wt/one' })
    expect(first.ok).toBe(true)
    const pid1 = [...r.processes.keys()][0] as number
    await exitProcess(r, pid1, 0)
    const second = await r.dispatch(id, { cwd: '/wt/one' })
    expect(second.ok).toBe(true)
    expect(r.sends).toHaveLength(2)
  })

  it('★不同卡同一工作树:第二张被拒(树还被占着),话里指认出占用者', async () => {
    const r = rig()
    const a = await makeCodeTask(r, '卡 A')
    const b = await makeCodeTask(r, '卡 B')
    expect((await r.dispatch(a, { cwd: '/wt/shared' })).ok).toBe(true)
    const second = await r.dispatch(b, { cwd: '/wt/shared' })
    expect(second.ok).toBe(false)
    expect(second.note).toContain('同一工作区')
    expect(r.sends).toHaveLength(1)
  })
})

describe('进程没起来 / 异常退出', () => {
  it('★进程起失败(送话那一下没成)→ 租约放手,同卡立刻能重派', async () => {
    const r = rig()
    const id = await makeCodeTask(r)
    r.failNextSend = true
    const failed = await r.dispatch(id, { cwd: '/wt/one' })
    expect(failed.ok).toBe(false)
    const retry = await r.dispatch(id, { cwd: '/wt/one' })
    expect(retry.ok).toBe(true)
    expect(r.sends).toHaveLength(2)
  })

  it('★异常退出(非零码)→ 租约按 process-failed 放手,能再派', async () => {
    const r = rig()
    const id = await makeCodeTask(r)
    expect((await r.dispatch(id, { cwd: '/wt/one' })).ok).toBe(true)
    const pid1 = [...r.processes.keys()][0] as number
    await exitProcess(r, pid1, 1, '')
    r.outputs.delete(r.processes.get(pid1)!.output_file)
    const card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(card.status).toBe('blocked')
    expect((await r.dispatch(id, { cwd: '/wt/one' })).ok).toBe(true)
  })
})

describe('重启与不确定性保留', () => {
  it('★重启(新派发器实例、同一租约文件):作者进程还活着 → 拒(还在跑),不重复派', async () => {
    const dir = temp()
    const leaseFile = join(dir, 'leases.json')
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${Math.random()}` })
    const created = await tasks.create({ title: '重启那一件', status: 'doing' })
    const id = created.id as string
    const alivePids = new Set<number>([7701])
    const mk = () => createDispatchRunner({
      tasks,
      clientDispatch: { send: async () => ({ ok: true, result: { via: 'cli', process: { pid: 7701, output_file: join(dir, 'out'), exited: new Promise(() => {}) } } }) } as unknown as ClientDispatch,
      lease: createExecutionLeaseStore({ file: leaseFile }),
      readFile: async () => undefined,
      alive: pid => alivePids.has(pid),
      sessions: () => [],
      now: () => new Date(NOW_SEC * 1000),
      pollMs: 60_000,
    })
    expect((await mk().start(id, { family: 'codex', said: '办', kind: 'code', cwd: '/wt/restart' })).ok).toBe(true)
    // 「重启」:新实例。作者进程还活着 → 拒。
    const again = await mk().start(id, { family: 'codex', said: '办', kind: 'code', cwd: '/wt/restart' })
    expect(again.ok).toBe(false)
    expect(again.note).toContain('不重复派')
  })

  it('★重启后 pid 没了:不自动重派 —— 巡检标「不确定」,同卡人重派(takeover)接上,别卡同树仍拒', async () => {
    const dir = temp()
    const leaseFile = join(dir, 'leases.json')
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${Math.random()}` })
    const created = await tasks.create({ title: 'pid 没了那一件', status: 'doing' })
    const id = created.id as string
    const other = await tasks.create({ title: '同树另一件', status: 'doing' })
    const outputs = new Map<string, string>()
    let alivePids = new Set<number>([6601])
    const sends: string[] = []
    const mk = () => createDispatchRunner({
      tasks,
      clientDispatch: {
        send: async () => {
          sends.push('send')
          return { ok: true, result: { via: 'cli', process: { pid: 6601, output_file: join(dir, 'out'), exited: new Promise(() => {}) } } }
        },
      } as unknown as ClientDispatch,
      lease: createExecutionLeaseStore({ file: leaseFile }),
      readFile: async (f) => outputs.get(f),
      alive: pid => alivePids.has(pid),
      sessions: () => [],
      now: () => new Date(NOW_SEC * 1000),
      pollMs: 60_000,
    })
    const first = await mk().start(id, { family: 'codex', said: '办', kind: 'code', cwd: '/wt/uncertain' })
    expect(first.ok).toBe(true)
    // 进程没了(插件重启期间它死了)。新实例直接重派 → 拒(不确定,不凭 pid 没了就重派)。
    alivePids = new Set()
    const auto = await mk().start(id, { family: 'codex', said: '办', kind: 'code', cwd: '/wt/uncertain' })
    expect(auto.ok).toBe(false)
    expect(auto.note).toContain('进程状态读不准')
    // 巡检那一拍:pid-gone → 标不确定(卡照常收失败,但租约不放)。
    await mk().tick()
    // 同卡人重派(显式 takeover)→ 接上;不带 takeover 的自动路已在上面拒过。
    const human = await mk().start(id, { family: 'codex', said: '办', kind: 'code', cwd: '/wt/uncertain', takeover: true })
    expect(human.ok).toBe(true)
    // 别卡同树仍拒:树被这一次占着。
    const otherTry = await mk().start(other.id as string, { family: 'codex', said: '办', kind: 'code', cwd: '/wt/uncertain' })
    expect(otherTry.ok).toBe(false)
  })
})

describe('迟到回调与终态证据', () => {
  it('★迟到的旧进程退出摘不动新租约:旧 pid 的 exit 回调之后,新作者的占用还在', async () => {
    const r = rig()
    const id = await makeCodeTask(r)
    expect((await r.dispatch(id, { cwd: '/wt/one' })).ok).toBe(true)
    const pid1 = [...r.processes.keys()][0] as number
    await exitProcess(r, pid1, 0)
    // 重派(新租约、新进程)。
    expect((await r.dispatch(id, { cwd: '/wt/one' })).ok).toBe(true)
    const pid2 = [...r.processes.keys()].at(-1) as number
    expect(pid2).not.toBe(pid1)
    // pid1 的退出回调**又响了一次**(迟到的重复回调)—— 摘不动 pid2 的租约。
    await exitProcess(r, pid1, 0)
    const third = await r.dispatch(id, { cwd: '/wt/one' })
    expect(third.ok).toBe(false)
    expect(third.note).toContain('不重复派')
  })

  it('★结果文件里已有「像交卷的话」、进程没退出 → 租约不放:终态证据是退出,不是文本', async () => {
    const r = rig()
    const id = await makeCodeTask(r)
    expect((await r.dispatch(id, { cwd: '/wt/one' })).ok).toBe(true)
    const pid1 = [...r.processes.keys()][0] as number
    // 中途文本(像交卷)先落到结果文件 —— 但进程还在跑。
    r.outputs.set(r.processes.get(pid1)!.output_file, '做完了:半程结论(其实还在跑)')
    const during = await r.dispatch(id, { cwd: '/wt/one' })
    expect(during.ok).toBe(false)
    expect(during.note).toContain('还在跑')
    // 真退出之后才放。
    await exitProcess(r, pid1, 0)
    expect((await r.dispatch(id, { cwd: '/wt/one' })).ok).toBe(true)
  })
})

/* ────────────── 合流返工五缺口:派发器层(2026-10-26,合并 f92ac697 后)────────────── */

interface GapRig {
  runner: ReturnType<typeof createDispatchRunner>
  tasks: ReturnType<typeof createTasksService>
  lease: ReturnType<typeof createExecutionLeaseStore>
  alivePids: Set<number>
  outputs: Map<string, string>
  /** 可重复触发的退出信号(模拟迟到/重复的 exit 送达):每次 fire 都重放全部已注册回调。 */
  fireExit: (pid: number, code: number | null) => void
  /** 按进程实例触发(解决 PID 重用下按 pid 会误伤同 pid 新进程的问题)。 */
  procs: { serial: number, pid: number }[]
  fireProc: (serial: number, code: number | null) => void
  killed: number[]
  clock: { ms: number }
  dispatch: (taskId: string, opts?: { takeover?: boolean, cwd?: string }) => Promise<{ ok: boolean, note: string }>
}

function gapRig(over: { cliBudgetMinutes?: number, withKillPid?: boolean, fixedPid?: number, noAlive?: boolean } = {}): GapRig {
  const dir = temp()
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock.ms / 1000), newId: () => `t-${Math.random().toString(36).slice(2, 9)}` })
  const lease = createExecutionLeaseStore({ file: join(dir, 'leases.json') })
  const alivePids = new Set<number>()
  const outputs = new Map<string, string>()
  const killed: number[] = []
  const clock = { ms: Date.parse('2026-10-26T10:00:00.000Z') }
  const listeners = new Map<number, ((outcome: { code: number | null }) => void)[]>()
  const procs: { serial: number, pid: number }[] = []
  let nextPid = 7100
  const clientDispatch = {
    send: async () => {
      // fixedPid:同一个 pid 反复「被系统重用」(新进程拿到旧进程的号)。
      const pid = over.fixedPid ?? nextPid++
      const serial = procs.length
      procs.push({ serial, pid })
      alivePids.add(pid)
      const exited = {
        then(onF: (outcome: { code: number | null }) => unknown) {
          const list = listeners.get(serial) ?? []
          list.push(onF)
          listeners.set(serial, list)
          return Promise.resolve()
        },
      } as unknown as Promise<{ code: number | null }>
      return { ok: true, result: { via: 'cli', process: { pid, output_file: join(dir, `out-${serial}-${pid}`), exited } } }
    },
  } as unknown as ClientDispatch
  const runner = createDispatchRunner({
    tasks,
    clientDispatch,
    lease,
    readFile: async (file: string) => outputs.get(file),
    ...(over.noAlive === true ? {} : { alive: (pid: number) => alivePids.has(pid) }),
    sessions: () => [],
    now: () => new Date(clock.ms),
    pollMs: 60_000,
    ...(over.cliBudgetMinutes === undefined ? {} : { cliBudget: () => ({ cny: 1, minutes: over.cliBudgetMinutes as number }) }),
    ...(over.withKillPid !== true ? {} : { killPid: (pid: number) => { killed.push(pid) } }),
  })
  const fireProc = (serial: number, code: number | null): void => {
    const proc = procs[serial]
    if (proc === undefined) throw new Error(`no proc ${serial}`)
    alivePids.delete(proc.pid)
    const outFile = join(dir, `out-${serial}-${proc.pid}`)
    outputs.set(`${outFile}.jsonl`, '{"type":"turn.completed"}\n')
    outputs.set(outFile, '做完了:缺口回归交卷')
    for (const onF of listeners.get(serial) ?? []) onF({ code })
  }
  return {
    runner, tasks, lease, alivePids, outputs, killed, clock, procs,
    fireProc,
    fireExit(pid, code) {
      const serial = procs.find(one => one.pid === pid)?.serial
      if (serial === undefined) throw new Error(`no proc with pid ${pid}`)
      fireProc(serial, code)
    },
    dispatch: async (taskId, opts = {}) => {
      const r = await runner.start(taskId, { family: 'codex', said: '把这件事办了', kind: 'code', cwd: opts.cwd ?? '/wt/gap', ...(opts.takeover === true ? { takeover: true } : {}) })
      return { ok: r.ok, note: r.note }
    },
  }
}

async function gapTask(r: GapRig, title = '缺口用例'): Promise<string> {
  return (await r.tasks.create({ title, status: 'doing' })).id as string
}

/** 等 finishCli(挂在 fire 的微任务/串行队列后)落地。 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30))
}

describe('缺口3:接管必须显式人工意图', () => {
  it('★holder 不确定时:自动 start(不带 takeover)拒;带 takeover 才换租约;alive 证据为真永远拒', async () => {
    const r = gapRig()
    const id = await gapTask(r)
    expect((await r.dispatch(id)).ok).toBe(true)
    const pid1 = [...r.alivePids][0] as number
    // 进程没了(没人在场看到退出):alive 证据消失,租约仍 active。
    r.alivePids.delete(pid1)
    const auto = await r.dispatch(id)
    expect(auto.ok).toBe(false)
    expect(auto.note).toContain('进程状态读不准')
    // 巡检标不确定。
    await r.runner.tick()
    // 自动路再来:仍拒(标了不确定也不是自动路的通行证)。
    const auto2 = await r.dispatch(id)
    expect(auto2.ok).toBe(false)
    // 显式人工接管:接上,新进程真起。
    const human = await r.dispatch(id, { takeover: true })
    expect(human.ok).toBe(true)
    expect(r.alivePids.size).toBe(1)
  })

  it('★alive 证据为真(缺 alive 证据不猜 —— 这里用「活着」证明照拒)且 holder 是别卡:takeover 也不许抢', async () => {
    const r = gapRig()
    const a = await gapTask(r, '卡 A')
    const b = await gapTask(r, '卡 B')
    expect((await r.dispatch(a, { cwd: '/wt/same' })).ok).toBe(true)
    // B 同树,显式 takeover 也不许抢(holder 不是 B 这张卡)。
    const bTry = await r.dispatch(b, { cwd: '/wt/same', takeover: true })
    expect(bTry.ok).toBe(false)
    expect(bTry.note).toContain('同一工作区')
  })
})

describe('缺口3b:到顶(cap)只在退出证据上放锁', () => {
  it('★cap 记卡+发停但锁不放:kill 缺席、进程没退 → 仍拒;进程退出(exit 证据)才放,证据=stopped-cap', async () => {
    const r = gapRig({ cliBudgetMinutes: 1 })
    const id = await gapTask(r)
    expect((await r.dispatch(id)).ok).toBe(true)
    // 跑过卡上时长上限(dispatch.budget_minutes 缺省 120 分钟)。capCli 在巡检里跑。
    r.clock.ms += 121 * 60 * 1000
    await r.runner.tick()
    await settle()
    const capped = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(capped.dispatch?.stopped).toBe('cap')
    expect(r.killed).toEqual([])
    // kill 缺席、进程没退:锁如实还在,重派拒。
    const still = await r.lease.activeForTask(id)
    expect(still?.state).toBe('active')
    expect((await r.dispatch(id)).ok).toBe(false)
    // 进程终于退出(真终态证据)→ 放(stopped-cap),能重派。
    const alive = [...r.alivePids][0] as number
    r.fireExit(alive, 0)
    await settle()
    // 锁已放(activeForTask 只回活跃锁 → undefined),重派真起新进程。
    expect(await r.lease.activeForTask(id)).toBeUndefined()
    expect((await r.dispatch(id)).ok).toBe(true)
  })

  it('★有 killPid 也一样:SIGTERM 发出去了但进程没退,锁不放', async () => {
    const r = gapRig({ cliBudgetMinutes: 1, withKillPid: true })
    const id = await gapTask(r)
    expect((await r.dispatch(id)).ok).toBe(true)
    r.clock.ms += 121 * 60 * 1000
    await r.runner.tick()
    await settle()
    expect(r.killed.length).toBe(1)
    const card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(card.dispatch?.stopped).toBe('cap')
    // 进程装死:锁还在。
    expect((await r.lease.activeForTask(id))?.state).toBe('active')
    expect((await r.dispatch(id)).ok).toBe(false)
    // 装死的进程终于退了。
    const alive = [...r.alivePids][0] as number
    r.fireExit(alive, null)
    await settle()
    expect(await r.lease.activeForTask(id)).toBeUndefined()
  })
})

describe('缺口4:迟到的旧退出不改新轮的卡、不放新锁', () => {
  it('★旧进程退出重放(迟到回调):卡上 B 轮原样、B 的锁原样;只有 B 自己的退出才收 B', async () => {
    const r = gapRig()
    const id = await gapTask(r)
    expect((await r.dispatch(id)).ok).toBe(true)
    const pidA = [...r.alivePids][0] as number
    r.fireExit(pidA, 0)
    await settle()
    // A 轮收完:卡 done、锁放。
    let card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(card.dispatch?.status).toBe('done')
    // B 轮接上。
    expect((await r.dispatch(id)).ok).toBe(true)
    const pidB = [...r.alivePids][0] as number
    expect(pidB).not.toBe(pidA)
    card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(card.dispatch?.status).toBe('running')
    // ★迟到的 A 退出又送达一次:卡不得改回 done、B 的锁不得放。
    r.fireExit(pidA, 0)
    await settle()
    card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(card.dispatch?.status).toBe('running')
    expect(card.dispatch?.pid).toBe(pidB)
    const held = await r.lease.activeForTask(id)
    expect(held?.state).toBe('active')
    // B 自己的退出才收 B。
    r.fireExit(pidB, 0)
    await settle()
    card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(card.dispatch?.status).toBe('done')
  })
})

describe('缺口5:进程已交出去,start 异常也不误放锁', () => {
  it('★send 起了进程但写卡那一下抛了:锁留着(进程在外头跑),它退出才放', async () => {
    const r = gapRig()
    const id = await gapTask(r)
    // 写卡第一次(dispatch 落盘那一下)抛错。
    const origUpdate = r.tasks.update.bind(r.tasks)
    let boom = true
    ;(r.tasks as unknown as { update: typeof r.tasks.update }).update = ((tid: string, patch: Parameters<typeof r.tasks.update>[1]) => {
      if (boom && patch !== null && typeof patch === 'object' && 'dispatch' in (patch as object)) {
        boom = false
        return Promise.reject(new Error('磁盘满了(注入)'))
      }
      return origUpdate(tid, patch)
    }) as typeof r.tasks.update
    const failed = await r.dispatch(id)
    expect(failed.ok).toBe(false)
    // 锁必须还在 —— 进程真在外头跑,不许 not-started 误放。
    const held = await r.lease.activeForTask(id)
    expect(held?.state).toBe('active')
    // 同卡重派照拒(作者还活着/没退出证据)。
    expect((await r.dispatch(id)).ok).toBe(false)
    // 进程退出(真证据)→ 放。
    const pid = [...r.alivePids][0] as number
    r.fireExit(pid, 0)
    await settle()
    expect(await r.lease.activeForTask(id)).toBeUndefined()
  })
})

describe('收尾两条原验收要求(2026-10-26 深夜)', () => {
  it('★反例1a:takeover:true 但 alive 探针缺席(unknown)→ 拒,不猜', async () => {
    const r = gapRig({ noAlive: true })
    const id = await gapTask(r)
    expect((await r.dispatch(id)).ok).toBe(true)
    // 标不确定(巡检在这台机器上核不了,由人来标)。
    const active = await r.lease.activeForTask(id)
    await r.lease.markUncertain({ taskId: id, runId: active?.run_id ?? '' })
    // 显式 takeover 也不行:没有「不在」的正面证据。
    const human = await r.dispatch(id, { takeover: true })
    expect(human.ok).toBe(false)
    expect(human.note).toContain('核不了它的进程此刻在不在')
    // 锁原样。
    expect((await r.lease.activeForTask(id))?.run_id).toBe(active?.run_id)
  })

  it('★反例1b:takeover:true 但 holder 没有 pid(identity 不全,unknown)→ 拒', async () => {
    const r = gapRig()
    const id = await gapTask(r)
    // 直接造一个「没 pid 且不确定」的锁(attachPid 没补上的旧世界),不经进程。
    const active0 = await r.lease.activeForTask(id)
    void active0
    await r.lease.claim({ taskId: id, cwd: '/wt/gap', family: 'codex', runId: 'r-nopid', at: new Date(r.clock.ms).toISOString() })
    await r.lease.markUncertain({ taskId: id, runId: 'r-nopid' })
    const human = await r.dispatch(id, { takeover: true })
    expect(human.ok).toBe(false)
    // unknown 两种话术(核不了 / 读不准)都是如实拒,不许放行。
    expect(human.note).toMatch(/核不了它的进程此刻在不在|进程状态读不准/)
    expect((await r.lease.activeForTask(id))?.run_id).toBe('r-nopid')
  })

  it('★反例2:同 PID 不同 attempt 的迟到回调 —— 租约与新轮卡逐字不变;新进程自己的退出才收', async () => {
    // PID 重用:系统把旧进程的号给了新进程。
    const r = gapRig({ fixedPid: 5555 })
    const id = await gapTask(r)
    expect((await r.dispatch(id)).ok).toBe(true)
    expect(r.procs[0]?.pid).toBe(5555)
    r.fireProc(0, 0)
    await settle()
    let card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(card.dispatch?.status).toBe('done')
    // 新一轮:pid 又是 5555(重用),attempt 是新的。
    expect((await r.dispatch(id)).ok).toBe(true)
    expect(r.procs[1]?.pid).toBe(5555)
    card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(card.dispatch?.status).toBe('running')
    const before = JSON.stringify(card.dispatch)
    const leaseBefore = JSON.stringify(await r.lease.activeForTask(id))
    // ★旧轮的退出迟到现在才送达:旧 attempt + 重用的 pid。
    r.fireProc(0, 0)
    await settle()
    card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(JSON.stringify(card.dispatch)).toBe(before)
    expect(JSON.stringify(await r.lease.activeForTask(id))).toBe(leaseBefore)
    // 新轮自己的退出才收新轮。
    r.fireProc(1, 0)
    await settle()
    card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(card.dispatch?.status).toBe('done')
    expect(await r.lease.activeForTask(id)).toBeUndefined()
  })
})

/**
 * 2026-10-28(0.4.169 候选,审计发现):读缓存去掉 structuredClone 之后 `tasks.list()` 交出的是**共享快照**,
 * 全仓消费方的不变量是「谁都不许就地改」。交卷收尾那条路曾把观测到的 runtime 直接赋回 list() 交出的那张卡
 * (`running.runtime = observeRuntime(...)`,而 running 就是 task.dispatch 的引用)——update 之前任何一步抛错,
 * 缓存里就留着盘上没有的状态,所有读者一起看错。这里钉住:收尾前拿到的那张卡一字不动,新状态只经 tasks.update 落账。
 */
describe('list() 共享快照不被收尾就地改', () => {
  it('★交卷收尾:观测到的 runtime 不写进 list() 交出的那张卡;账上那张卡经 tasks.update 才变', async () => {
    const r = rig()
    const id = await makeCodeTask(r)
    const started = await r.dispatch(id, { cwd: '/wt/snapshot' })
    expect(started.ok).toBe(true)
    const snapshot = (await r.tasks.list()).tasks.find(one => one.id === id)!
    const runtimeRef = snapshot.dispatch?.runtime
    const runtimeText = JSON.stringify(runtimeRef)
    expect(runtimeRef).toBeDefined()
    const pid = [...r.processes.keys()].at(-1)!
    await exitProcess(r, pid, 0)
    // 收尾之前拿到的那张卡:同一个引用、同样的内容 —— 共享快照没被就地改。
    expect(snapshot.dispatch?.runtime).toBe(runtimeRef)
    expect(JSON.stringify(snapshot.dispatch?.runtime)).toBe(runtimeText)
    // 账上那张卡已经按 tasks.update 落了终态。
    const after = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(after.dispatch?.status).toBe('done')
    expect(after.dispatch?.runtime).not.toBe(runtimeRef)
  })
})
