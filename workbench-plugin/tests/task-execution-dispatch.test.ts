// @vitest-environment node
/**
 * 起跑、换手、观察收成一处(派发口)——可靠执行闭环第一批第 3 步(2026-10-29)。
 *
 * 钉住任务书验收 ①–⑤(都经第 1 步的 ExecutionStore,真任务账,不碰真窗口 / 真进程):
 * ① 第一候选起跑即失败、允许换手 → 第二候选**真起跑**,执行记录里两只手的原因都在;
 * ② 发出后收不到确认 → **不起第二作者**,记录 reconciling 且带 `reconcile` 动作;
 * ③ 严格点名不可替换 → 等待 + 具体原因,不伪称她点名了替代者;
 * ④ 写执行记录失败 → **不起子进程**;
 * ⑤ 重启后从执行记录恢复未完动作,不重复有副作用的派发。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DispatchChoicesView, TaskClientDispatch } from '../src/protocol.ts'
import type { AgentCli } from '../src/server/agentDispatch.ts'
import type { DispatchRunDeps } from '../src/server/dispatchRun.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import type { ExecutionRecord } from '../src/server/taskExecution.ts'
import type { ExecutionStore } from '../src/server/taskExecutionStore.ts'
import { createExecutionStore } from '../src/server/taskExecutionStore.ts'
import type { ClientDispatch, SendToClientInput } from '../src/server/dispatchSend.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

const T0 = Date.parse('2026-10-29T09:00:00Z')

async function until(what: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 3000; i += 1) {
    if (await what()) return
    await new Promise(resolve => { setTimeout(resolve, 2) })
  }
  throw new Error(`等不到:${label}`)
}

/** 候选:Kimi / Codex 都能写代码、额度都够;默认 Kimi。 */
const balance = { level: 'ok' as const, text: '本周还剩约 58%', state: 'numbers' as const }
function viewBothOk(): DispatchChoicesView {
  return {
    kind: 'code', kind_why: '要改代码',
    default: 'kimi', default_from: 'fallback', default_why: 'Kimi 能改你电脑上的文件',
    line: '写代码的活 → 派给 Kimi',
    options: [
      { family: 'kimi', title: 'Kimi', ok: true, hand: 'cli', balance },
      { family: 'codex', title: 'Codex', ok: true, hand: 'cli', balance },
    ],
  }
}

interface Rig {
  dir: string
  tasks: ReturnType<typeof createTasksService>
  execution: ExecutionStore
  cliRuns: { bin: string, argv: readonly string[], cwd: string, logFile: string }[]
  files: Map<string, string>
  runner: ReturnType<typeof createDispatchRunner>
  find: (id: string) => Promise<ReturnType<typeof createTasksService> extends never ? never : Awaited<ReturnType<ReturnType<typeof createTasksService>['list']>>['tasks'][number] | undefined>
  recordOf: (id: string) => Promise<ExecutionRecord | undefined>
  setNow: (ms: number) => void
  finishRun: (index: number, code: number | null) => void
  mkRunner: () => ReturnType<typeof createDispatchRunner>
}

function rig(opts: {
  choicesFor?: DispatchRunDeps['choicesFor']
  /** 执行记录写入口替身(验收④:写不上)。 */
  execution?: ExecutionStore
  replyTimeoutMs?: number
} = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'wb-task-exec-dispatch-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(nowMs / 1000), newId: () => `t-1029${++n}` })
  const execution = opts.execution ?? createExecutionStore(tasks)
  const cliRuns: Rig['cliRuns'] = []
  const files = new Map<string, string>()
  const exits: ((code: number | null) => void)[] = []
  const clis: Record<string, AgentCli> = {
    claude: { found: true, family: 'claude', bin: '/usr/bin/claude', source: 'bundled' },
    codex: { found: true, family: 'codex', bin: '/Applications/ChatGPT.app/Contents/Resources/codex', source: 'bundled' },
    kimi: { found: true, family: 'kimi', bin: '/opt/homebrew/bin/kimi', source: 'path' },
  }
  let nowMs = T0
  const now = (): Date => new Date(nowMs)
  const h = engineHarness({
    connected: () => false,
    now,
    cli: {
      resolveCli: family => clis[family] ?? { found: false, family, why: 'x' },
      runCli: (cmd) => {
        cliRuns.push(cmd)
        return { pid: 7171, exited: new Promise<{ code: number | null }>((resolve) => { exits.push(code => resolve({ code })) }) }
      },
      resultDir: '/tmp/wb-retry-results',
      now,
    },
  })
  const mkRunner = (): ReturnType<typeof createDispatchRunner> => createDispatchRunner({
    tasks,
    execution,
    ...(opts.choicesFor === undefined ? {} : { choicesFor: opts.choicesFor }),
    helper: { connected: () => true, request: async () => ({ found: false, busy: false }) },
    engine: h.engine,
    clientDispatch: createClientDispatch({ engine: h.engine, sessionIdsOf: () => [], now }),
    alive: () => true,
    readFile: async file => files.get(file),
    sessions: () => [],
    now,
    setTimer: () => 'timer',
    clearTimer: () => {},
    alternativesFor: async () => [],
    killPid: () => {},
    ...(opts.replyTimeoutMs === undefined ? {} : { replyTimeoutMs: opts.replyTimeoutMs }),
  })
  const runner = mkRunner()
  return {
    dir, tasks, execution, cliRuns, files, runner,
    find: async (id) => (await tasks.list()).tasks.find(one => one.id === id),
    recordOf: async (id) => await execution.read(id),
    setNow: (ms) => { nowMs = ms },
    finishRun: (index, code) => exits[index]?.(code),
    mkRunner,
  }
}

/** 窗口那一套:假 clientDispatch 收下发出去的那一句,引擎不读回(= 永远收不到确认)。 */
function windowRig(opts: { replyTimeoutMs: number } = { replyTimeoutMs: 1000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-task-exec-window-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(nowMs / 1000), newId: () => `t-1029${++n}` })
  const execution = createExecutionStore(tasks)
  const sent: SendToClientInput[] = []
  let nowMs = T0
  const clientDispatch: ClientDispatch = {
    async send(input) {
      sent.push(input)
      const dispatch: TaskClientDispatch = {
        hand: 'window', family: input.family as TaskClientDispatch['family'], status: 'sent',
        at: new Date(nowMs).toISOString(), text: input.text, submitted: true, method: 'paste', baseline: [],
      }
      return { ok: true, dispatch, baseline: [] }
    },
  }
  const runner = createDispatchRunner({
    tasks,
    execution,
    choicesFor: async () => ({
      kind: 'chat', kind_why: '聊聊',
      default: 'kimi', default_from: 'fallback', default_why: 'Kimi 能接',
      line: '派给 Kimi',
      options: [{ family: 'kimi', title: 'Kimi', ok: true, hand: 'window', balance }],
    }),
    clientDispatch,
    readFile: async () => undefined,
    sessions: () => [],
    now: () => new Date(nowMs),
    setTimer: () => 'timer',
    clearTimer: () => {},
    replyTimeoutMs: opts.replyTimeoutMs,
  })
  return { tasks, execution, runner, sent, find: async (id: string) => (await tasks.list()).tasks.find(one => one.id === id), recordOf: async (id: string) => await execution.read(id), setNow: (ms: number) => { nowMs = ms } }
}

describe('① 起跑失败换手(允许):第二候选真起跑,执行记录里两只手的原因都在', () => {
  it('Kimi 一起就退 → Codex 真起跑;记录里 Kimi 的启动失败原因与 Codex 的派出都在', async () => {
    const r = rig({ choicesFor: async () => viewBothOk() })
    const made = await r.tasks.create({ title: '改随手记那一格', direction: 'mine', status: 'todo' })
    const id = made.id as string
    const started = await r.runner.start(id, { family: 'kimi', said: '改一下', kind: 'code', cwd: '/repo' })
    expect(started).toMatchObject({ ok: true, hand: 'cli' })
    // 派出前已持久化:attemptId + 候选表 + prepared 痕迹(first trace);phase 可能已被接单事实推进到 running。
    const prepared = await r.recordOf(id)
    expect(['dispatching', 'running']).toContain(prepared?.phase)
    expect(prepared?.attemptId).not.toBeNull()
    expect(prepared?.candidates).toEqual(['kimi', 'codex'])
    expect((prepared?.attempts ?? [])[0]?.outcome).toBe('prepared')
    // Kimi 一起就退(日志空空、非 0)。
    r.finishRun(0, 1)
    await until(() => r.cliRuns.length === 2, '换 Codex 再派')
    expect(r.cliRuns[1]?.bin).toBe('/Applications/ChatGPT.app/Contents/Resources/codex')
    // 第二只真起跑:派发记录落卡(等它,不凭 runCli 记账那一拍)。
    await until(async () => (await r.find(id))?.dispatch?.family === 'codex', 'Codex 派发落卡')
    // 第二只接单后:running + 执行来源登记。
    await until(async () => (await r.recordOf(id))?.phase === 'running', '记录进入 running')
    const record = await r.recordOf(id)
    expect(record?.origin).toBe('codex')
    // 两只手的原因都在记录里:Kimi 起跑失败带原因,Codex 派出(started 之前至少 prepared)。
    const failed = (record?.attempts ?? []).filter(one => one.outcome === 'startup-failed')
    expect(failed.map(one => one.family)).toEqual(['kimi'])
    expect(failed[0]?.reason).toBeTruthy()
    expect((record?.attempts ?? []).some(one => one.family === 'codex' && (one.outcome === 'prepared' || one.outcome === 'started'))).toBe(true)
    // 卡仍 doing,人是看得见的那一句照旧。
    const task = await r.find(id)
    expect(task?.status).toBe('doing')
    expect(task?.dispatch).toMatchObject({ family: 'codex', status: 'running' })
  })
})

describe('② 发出后收不到确认:不起第二作者,记录 reconciling + reconcile 动作', () => {
  it('窗口那一句送出后再也读不到 → 卡如实挂起,记录 reconciling 带 reconcile,不再送第二遍', async () => {
    const w = windowRig()
    const made = await w.tasks.create({ title: '问件事', direction: 'mine', status: 'todo' })
    const id = made.id as string
    const started = await w.runner.start(id, { family: 'kimi', said: '问件事' })
    expect(started.ok).toBe(true)
    expect(w.sent).toHaveLength(1)
    expect((await w.recordOf(id))?.phase).toBe('dispatching')
    // 过了回话总时限还是读不到(引擎缺席 = 永远没读到):如实收场。
    w.setNow(T0 + 60_000)
    await w.runner.tick()
    const record = await w.recordOf(id)
    expect(record?.phase).toBe('reconciling')
    expect(record?.next?.kind).toBe('reconcile')
    expect(record?.next?.reason).toBeTruthy()
    // 不起第二作者:那一句话只送出去一遍。
    expect(w.sent).toHaveLength(1)
    await w.runner.tick()
    expect(w.sent).toHaveLength(1)
  })
})

describe('③ 严格点名不可替换:等待 + 具体原因,不伪称她点名了替代者', () => {
  it('点名 Kimi 起跑失败 → 不换 Codex;记录 waiting_user + ask(原因写清是 Kimi 起跑失败)', async () => {
    const r = rig({ choicesFor: async () => viewBothOk() })
    const made = await r.tasks.create({ title: '点名那件', direction: 'mine', status: 'todo' })
    const id = made.id as string
    const started = await r.runner.start(id, { family: 'kimi', said: '改一下', kind: 'code', cwd: '/repo', named: true })
    expect(started.ok).toBe(true)
    expect(r.cliRuns).toHaveLength(1)
    r.finishRun(0, 1)
    await until(async () => (await r.recordOf(id))?.phase === 'waiting_user', '记录进入等待本人')
    const record = await r.recordOf(id)
    expect(record?.next?.kind).toBe('ask')
    expect(record?.next?.reason).toContain('kimi')
    // 不伪称她点名了替代者:第二只手一个字都没派。
    expect(r.cliRuns).toHaveLength(1)
    // 卡上说清具体原因(给人看的那句)——记录先于卡落地,等卡挪到「阻塞」再断言。
    await until(async () => (await r.find(id))?.status === 'blocked', '卡挂阻塞')
    const task = await r.find(id)
    expect(task?.note).toContain('起跑没跑起来')
    expect(task?.note).toContain('Kimi')
  })
})

describe('④ 写执行记录失败:不起子进程', () => {
  it('compareAndSet 返回 false → 不派、不起子进程,卡不动', async () => {
    const r = rig({
      choicesFor: async () => viewBothOk(),
      execution: {
        read: async () => undefined,
        compareAndSet: async () => false,
        unfinished: async () => [],
      },
    })
    const made = await r.tasks.create({ title: '记录写不上那件', direction: 'mine', status: 'todo' })
    const id = made.id as string
    const started = await r.runner.start(id, { family: 'kimi', said: '改一下', kind: 'code', cwd: '/repo' })
    expect(started.ok).toBe(false)
    expect(String(started.note)).toContain('执行记录')
    expect(r.cliRuns).toHaveLength(0)
    const task = await r.find(id)
    expect(task?.status).toBe('todo')
    expect(task?.dispatch).toBeUndefined()
  })

  it('执行记录这一层抛错 → 同样不起子进程', async () => {
    const r = rig({
      choicesFor: async () => viewBothOk(),
      execution: {
        read: async () => { throw new Error('disk gone') },
        compareAndSet: async () => { throw new Error('disk gone') },
        unfinished: async () => [],
      },
    })
    const made = await r.tasks.create({ title: '记录抛错那件', direction: 'mine', status: 'todo' })
    const started = await r.runner.start(made.id as string, { family: 'kimi', said: '改一下', kind: 'code', cwd: '/repo' })
    expect(started.ok).toBe(false)
    expect(r.cliRuns).toHaveLength(0)
  })
})

describe('⑤ 重启后从执行记录恢复未完动作,不重复有副作用的派发', () => {
  it('换手还没送出插件就重启:新进程从记录接上,只把 Codex 派一次,Kimi 不重跑', async () => {
    const r = rig({ choicesFor: async () => viewBothOk() })
    const made = await r.tasks.create({ title: '重启接续那件', direction: 'mine', status: 'todo' })
    const id = made.id as string
    await r.runner.start(id, { family: 'kimi', said: '改一下', kind: 'code', cwd: '/repo' })
    // Kimi 起跑失败 → 记录写下失败、待发下一只;这一瞬间插件死了(旧 runner 停掉,没送出的换手不丢了)。
    r.finishRun(0, 1)
    await until(async () => ((await r.recordOf(id))?.attempts?.some(one => one.outcome === 'startup-failed')) === true, '起跑失败落进记录')
    r.runner.stop()
    // 新进程(新 runner + 重新挂账):从执行记录恢复未完动作。
    const reborn = r.mkRunner()
    await reborn.resume()
    await until(() => r.cliRuns.length === 2, '重启后把 Codex 接上')
    expect(r.cliRuns[1]?.bin).toBe('/Applications/ChatGPT.app/Contents/Resources/codex')
    // 不重复有副作用的派发:Kimi 没重跑,也没有任何第三只手被起。
    expect(r.cliRuns.filter(one => one.bin.includes('kimi'))).toHaveLength(1)
    expect(r.cliRuns).toHaveLength(2)
    await until(async () => (await r.recordOf(id))?.phase === 'running', '接单事实落进记录')
    expect((await r.recordOf(id))?.origin).toBe('codex')
    // 卡上是第二只在跑(等派发记录落卡再断言)。
    await until(async () => (await r.find(id))?.dispatch?.family === 'codex', 'Codex 派发落卡')
    const task = await r.find(id)
    expect(task?.dispatch).toMatchObject({ family: 'codex', status: 'running' })
  })
})
