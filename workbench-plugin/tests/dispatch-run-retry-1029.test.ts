// @vitest-environment node
/**
 * 起跑失败换手 + 选人理由(2026-10-29,任务书「派活智能体文件与起跑换手」④⑤⑥⑦;10-29 09:22 真机:
 * Kimi 命令行一起就退,卡直接「阻塞」,候选里的 Codex 没被换上;10-28 同一句 Claude 登录过期,
 * 也停在第一只手上)。可靠执行闭环第一批第 3 步起,换手的痕迹(试过哪只、为什么)进**执行记录**
 * (卡上一格,重启不丢),不再凭内存里的三张表。
 *
 * 钉住:
 * - ④ 第一只**出第一条有效事件之前就退** → 按 `selection.candidates` 里 ok 的下一只同卡重派,
 *   卡仍 doing,note 记第一只的原因;
 * - ⑤ 每只都起跑失败 → blocked,note 列清每只为什么;
 * - ⑥ 已出事件 / 有改动的不算起跑失败,照旧走原来的路(不换手);
 * - ⑦ 中枢挑的(她没点名)`selection.reason` 不含「点名」;只有点名位(named)传进来才写「你点名要」。
 * 一个真窗口、一个真进程都不碰。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DispatchChoicesView } from '../src/protocol.ts'
import type { TaskClientDispatch } from '../src/protocol.ts'
import type { AgentCli } from '../src/server/agentDispatch.ts'
import type { DispatchRunDeps } from '../src/server/dispatchRun.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import type { ClientDispatch, SendToClientInput } from '../src/server/dispatchSend.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createExecutionStore } from '../src/server/taskExecutionStore.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

const clock = Date.parse('2026-10-29T09:00:00Z')

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

function rig(opts: {
  choicesFor?: DispatchRunDeps['choicesFor']
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-retry-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => `t-1029${++n}` })
  const cliRuns: { bin: string, argv: readonly string[], cwd: string, logFile: string }[] = []
  const files = new Map<string, string>()
  const exits: ((code: number | null) => void)[] = []
  let exit: (code: number | null) => void = () => {}
  const clis: Record<string, AgentCli> = {
    claude: { found: true, family: 'claude', bin: '/usr/bin/claude', source: 'bundled' },
    codex: { found: true, family: 'codex', bin: '/Applications/ChatGPT.app/Contents/Resources/codex', source: 'bundled' },
    kimi: { found: true, family: 'kimi', bin: '/opt/homebrew/bin/kimi', source: 'path' },
  }
  const now = (): Date => new Date(clock)
  const h = engineHarness({
    connected: () => false,
    now,
    cli: {
      resolveCli: family => clis[family] ?? { found: false, family, why: 'x' },
      runCli: (cmd) => {
        cliRuns.push(cmd)
        return { pid: 7171, exited: new Promise<{ code: number | null }>((resolve) => { exit = code => resolve({ code }); exits.push(exit) }) }
      },
      resultDir: '/tmp/wb-retry-results',
      now,
    },
  })
  const runner = createDispatchRunner({
    tasks,
    // 第 3 步(派发口归一):换手痕迹进执行记录,用例也要把推进存储接上(与生产同一个装配)。
    execution: createExecutionStore(tasks),
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
  })
  const find = async (id: string) => (await tasks.list()).tasks.find(one => one.id === id)
  return { tasks, cliRuns, files, runner, find, finish: (code: number | null) => exit(code), finishRun: (index: number, code: number | null) => exits[index]?.(code) }
}

describe('起跑失败换手(④⑤⑥)', () => {
  it('④ 第一只出第一条有效事件之前就退 → 自动换 candidates 里 ok 的下一只,卡仍 doing、note 记第一只原因', async () => {
    const r = rig({ choicesFor: async () => viewBothOk() })
    const made = await r.tasks.create({ title: '改随手记那一格', direction: 'mine', status: 'todo' })
    const id = made.id as string
    const started = await r.runner.start(id, { family: 'kimi', said: '改一下', kind: 'code', cwd: '/repo' })
    expect(started).toMatchObject({ ok: true, hand: 'cli' })
    expect(r.cliRuns).toHaveLength(1)
    // Kimi 一起就退:日志空空、非 0(真机那一下是 ENOENT,等价)。
    r.finishRun(0, 1)
    // 等第二只真派出去(派发记录写上、卡仍 doing),runCli 记账比写卡早一拍。
    await until(async () => {
      const task = await r.find(id)
      return task?.dispatch?.family === 'codex' && task.dispatch.status === 'running'
    }, '换下一只(Codex)再派')
    expect(r.cliRuns[1]?.bin).toBe('/Applications/ChatGPT.app/Contents/Resources/codex')
    const task = await r.find(id)
    // 同一张卡、同一交代,换的是手:卡仍 doing,派发记录是第二只。
    expect(task?.status).toBe('doing')
    expect(task?.dispatch).toMatchObject({ family: 'codex', hand: 'cli', status: 'running' })
    // 第一只的原因留在卡上。
    expect(task?.note).toContain('起跑没跑起来')
    expect(task?.note).toContain('Kimi')
    expect(task?.note).toContain('Codex')
  })

  it('⑤ 每只都起跑失败 → blocked,note 列清每只为什么', async () => {
    const r = rig({ choicesFor: async () => viewBothOk() })
    const made = await r.tasks.create({ title: '改随手记那一格', direction: 'mine', status: 'todo' })
    const id = made.id as string
    await r.runner.start(id, { family: 'kimi', said: '改一下', kind: 'code', cwd: '/repo' })
    r.finishRun(0, 1)
    await until(() => r.cliRuns.length === 2, '换 Codex 再派')
    // 第二只也一起就退:候选走完 → blocked,note 列每只(等 block_reason 落卡,它跟在挪状态后一拍)。
    r.finishRun(1, 1)
    await until(async () => (await r.find(id))?.block_reason === 'error', '两只都失败挂阻塞')
    const task = await r.find(id)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('error')
    expect(task?.dispatch).toMatchObject({ status: 'failed' })
    expect(task?.note).toContain('起跑没跑起来')
    expect(task?.note).toContain('Kimi:')
    expect(task?.note).toContain('Codex:')
  })

  it('⑥ 已出有效事件后退出 → 不算起跑失败,不换手(原行为一字不变)', async () => {
    const r = rig({ choicesFor: async () => viewBothOk() })
    const made = await r.tasks.create({ title: '改随手记那一格', direction: 'mine', status: 'todo' })
    const id = made.id as string
    await r.runner.start(id, { family: 'kimi', said: '改一下', kind: 'code', cwd: '/repo' })
    // 干上活了(出了事件)才退:不换手。
    r.files.set(r.cliRuns[0]?.logFile as string, '{"type":"turn.started"}\n')
    r.finishRun(0, 1)
    // 收尾那一拍多了一次执行记录读(换手痕迹),别用定长睡眠,等到卡上那句落地再断言。
    await until(async () => {
      const task = await r.find(id)
      return task?.note?.includes('没做成') === true
    }, '收尾那句落卡')
    expect(r.cliRuns).toHaveLength(1)
    const task = await r.find(id)
    expect(task?.status).toBe('blocked')
    expect(task?.note).toContain('派给 Kimi 没做成')
  })

  it('⑥b Kimi stream-json 出了输出(行里没有旧尺认的事件类型)再退 → 也不算起跑失败、不换手(共用非空白行那把尺)', async () => {
    const r = rig({ choicesFor: async () => viewBothOk() })
    const made = await r.tasks.create({ title: '改随手记那一格', direction: 'mine', status: 'todo' })
    const id = made.id as string
    await r.runner.start(id, { family: 'kimi', said: '改一下', kind: 'code', cwd: '/repo' })
    /*
     * Kimi stream-json 的行长这样:每行带 `role`、没有旧尺(按事件类型数)认的任何一个 `type`,
     * 也没有 assistant 成稿 —— 旧尺数出来是 0、结果也是空,只剩「数行」这一道在挡误判:
     * 旧尺会把干着活的 Kimi 判成「起跑失败」再换走(10-29 真机「数不到 Kimi」的根),
     * 共用尺(`cliOutputLines` 非空白行)数得到 → 算「干了活没做成」,不换手。
     */
    r.files.set(r.cliRuns[0]?.logFile as string, [
      '{"role":"meta","type":"session.resume_hint","session_id":"session_x1"}',
      '{"role":"user","content":"改一下"}',
    ].join('\n'))
    r.finishRun(0, 1)
    // 同上:等卡上那句落地,不定长睡眠。
    await until(async () => {
      const task = await r.find(id)
      return task?.note?.includes('没做成') === true
    }, '收尾那句落卡')
    expect(r.cliRuns).toHaveLength(1)
    const task = await r.find(id)
    expect(task?.status).toBe('blocked')
    expect(task?.note).toContain('派给 Kimi 没做成')
    expect(task?.note).not.toContain('起跑没跑起来')
  })
})

describe('选人理由(⑦)', () => {
  /** 窗口那只手的假世界:送话由假 clientDispatch 接住,reason 进派发词。 */
  function windowWorld(choicesFor: NonNullable<DispatchRunDeps['choicesFor']>) {
    const dir = mkdtempSync(join(tmpdir(), 'wb-reason-'))
    dirs.push(dir)
    let seq = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => `t-1029${++seq}` })
    const sent: SendToClientInput[] = []
    const calls: { taskId: string, input: Parameters<NonNullable<DispatchRunDeps['choicesFor']>>[1] }[] = []
    const clientDispatch: ClientDispatch = {
      async send(input) {
        sent.push(input)
        const dispatch: TaskClientDispatch = {
          hand: 'window', family: input.family as TaskClientDispatch['family'], status: 'sent',
          at: new Date(clock).toISOString(), text: input.text, submitted: true, method: 'paste', baseline: [],
        }
        return { ok: true, dispatch, baseline: [] }
      },
    }
    const recording: NonNullable<DispatchRunDeps['choicesFor']> = async (taskId, input) => {
      calls.push({ taskId, input })
      return await choicesFor(taskId, input)
    }
    const runner = createDispatchRunner({
      tasks,
      choicesFor: recording,
      clientDispatch,
      readFile: async () => undefined,
      sessions: () => [],
      now: () => new Date(clock),
      setTimer: () => 'timer',
      clearTimer: () => {},
    })
    return { tasks, runner, sent, calls }
  }

  it('中枢挑的(没点名):reason 写「按默认推荐挑的」、不含「点名」,选项表收到的是「别按负责人推断」', async () => {
    const w = windowWorld(async (_taskId, _input) => {
      // 这一份 default_why 是「假如误记成点名」会写出来的那句话 —— 用例证明它进不了 reason。
      return {
        kind: 'chat', kind_why: '聊聊',
        default: 'kimi', default_from: 'named', default_why: '你点名要 Kimi 做',
        line: '派给 Kimi',
        options: [{ family: 'kimi', title: 'Kimi', ok: true, hand: 'window', balance }],
      }
    })
    const made = await w.tasks.create({ title: '问件事', direction: 'mine', status: 'todo' })
    await w.runner.start(made.id as string, { family: 'kimi', said: '问件事' })
    expect(w.sent).toHaveLength(1)
    const text = w.sent[0]?.text ?? ''
    const reasonLine = text.split('\n').find(one => one.startsWith('本次分工依据：')) ?? ''
    expect(reasonLine).toContain('按默认推荐挑的')
    expect(reasonLine).not.toContain('点名')
    // 选项表那一层:没传 named、带了「别从卡上负责人推断点名」。
    expect(w.calls[0]?.input.named).toBeUndefined()
    expect(w.calls[0]?.input.ignoreAssignee).toBe(true)
  })

  it('她点了名(named 位):reason 照旧写「你点名要」;挑了默认项之外的写「在跑少」', async () => {
    const w = windowWorld(async () => ({
      kind: 'chat', kind_why: '聊聊',
      default: 'kimi', default_from: 'named', default_why: '你点名要 Kimi 做',
      line: '派给 Kimi',
      options: [{ family: 'kimi', title: 'Kimi', ok: true, hand: 'window', balance }],
    }))
    const named = await w.tasks.create({ title: '点名那件', direction: 'mine', status: 'todo' })
    await w.runner.start(named.id as string, { family: 'kimi', said: '问件事', named: true })
    const namedReason = (w.sent[0]?.text ?? '').split('\n').find(one => one.startsWith('本次分工依据：')) ?? ''
    expect(namedReason).toContain('你点名要 Kimi 做')

    // 没点名而挑了默认项之外的一家(在跑少):写「在跑少」,不写「按默认推荐挑的」。
    const w2 = windowWorld(async () => ({
      kind: 'chat', kind_why: '聊聊',
      default: 'kimi', default_from: 'fallback', default_why: 'Kimi 能接',
      line: '派给 Kimi',
      options: [{ family: 'kimi', title: 'Kimi', ok: true, hand: 'window', balance }],
    }))
    const busy = await w2.tasks.create({ title: '在跑少那件', direction: 'mine', status: 'todo' })
    await w2.runner.start(busy.id as string, { family: 'codex', said: '问件事' })
    const busyReason = (w2.sent[0]?.text ?? '').split('\n').find(one => one.startsWith('本次分工依据：')) ?? ''
    expect(busyReason).toContain('在跑少')
    expect(busyReason).not.toContain('点名')
  })
})
