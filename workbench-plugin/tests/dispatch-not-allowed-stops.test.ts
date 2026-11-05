// @vitest-environment node
/**
 * 派活:动作闸拦下的那一下,一条替代的路都不许走(2026-10-03,审计第二节第 3 条)。
 *
 * 复现(审计 `engine-repro.mjs` BUG 5):已取消的卡 → 引擎的闸拦住窗口那只手(`not_allowed`)→
 * `dispatchRun` 把它当普通失败 `continue` → 下一只手(接口 / 命令行)在引擎**外面**直接调:
 * 接口真被调了一次、回 ok:true/hand:api。她已经取消的交代仍可能被执行。
 *
 * 这一份钉三件事:
 * ① `startNow` 先看卡收没收场(`jobKey.SETTLED_TASK_STATUS`,与闸同一张表):收场了一只手都不试、卡一个字不改;
 * ② 窗口那只手回 `not_allowed`(闸拦的)→ 当场返回 ok:false,不换手、不写卡;
 * ③ **命令行 / 接口两条通道在引擎里**(2026-10-03 下午,卡「派活三只手收进引擎」):过的就是引擎那一道闸、记同一本账 ——
 *    拦下 → 零调用、账上有 `gate_block`;没登记那条通道 → 如实说没有能用的手。
 *
 * 真看板(临时目录 tasks.json)、真 `createClientDispatch`、真引擎 + 真闸(`engineHarness`,`phaseOf` 走真 `jobPhaseOf`);
 * 壳是假的(op 全记下来)、接口与命令行是计数的假件。一个真窗口、一个真进程都不碰。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STATUS_TITLES, type TaskStatus } from '../src/protocol.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import { DISPATCH_SETTLED_NOTE, createDispatchRunner } from '../src/server/dispatchRun.ts'
import type { DispatchTarget } from '../src/server/dispatchTargets.ts'
import { jobPhaseOf, type JobKeyTask } from '../src/server/jobKey.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness, type EngineHarnessOptions } from './helpers/engineHarness.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

const DOUBAO_PKG = 'com.work.pc.doubao'
const CODEX_PKG = 'com.openai.codex'
const DOUBAO = { id: 'doubao', title: '豆包办公', bundle_id: DOUBAO_PKG, hands: ['window', 'api'], aliases: [], from_registry: true } as unknown as DispatchTarget
const CODEX = { id: 'codex', title: 'Codex', bundle_id: CODEX_PKG, hands: ['window', 'cli'], aliases: [], from_registry: true } as unknown as DispatchTarget
const only = (target: DispatchTarget, hands: DispatchTarget['hands']): DispatchTarget => ({ ...target, hands })

interface RigOptions {
  targets?: readonly DispatchTarget[]
  limits?: EngineHarnessOptions['limits']
  /** 壳连着没有(没连 = 窗口那条通道排不上,派活只能走命令行 / 接口)。缺省连着。 */
  connected?: boolean
  /** 要不要登记命令行 / 接口两条通道(缺省都登;老宿主一条都没登的那一种传 false)。 */
  hands?: boolean
}

function rig(options: RigOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-gate-'))
  dirs.push(dir)
  let clock = Date.parse('2026-10-03T03:00:00.000Z')
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => `t-00000${++n}` })
  /** 闸的 `phaseOf` 是同步的;照 http.ts 的做法留一份同步快照,改卡之后刷一次。 */
  let phaseTasks: readonly JobKeyTask[] = []
  const refresh = async (): Promise<void> => { phaseTasks = (await tasks.list()).tasks }
  const targets = options.targets ?? [DOUBAO, CODEX]
  let apiCalls = 0
  let cliRuns = 0
  const h = engineHarness({
    phaseOf: job => jobPhaseOf({ job, tasks: phaseTasks, sessions: [] }),
    nameOf: family => targets.find(one => one.id === family)?.title ?? family,
    connected: () => options.connected ?? true,
    installed: (family) => {
      const target = targets.find(one => one.id === family)
      return target?.bundle_id === undefined ? undefined : [{ bundle_id: target.bundle_id, name: target.title, running: true }]
    },
    reply: req => (req.op === 'send_text' ? { submitted: true, method: 'ax_value' } : {}),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.hands === false
      ? {}
      : {
          cli: {
            resolveCli: family => ({ found: true, family, bin: '/fake/codex', source: 'path' }),
            runCli: () => { cliRuns += 1; return { pid: 4242, exited: new Promise(() => {}) } },
            resultDir: join(dir, 'results'),
            now: () => new Date(clock),
          },
          api: {
            send: async (input) => {
              apiCalls += 1
              return { ok: true, reply: '本不该执行的回答', dispatch: { family: input.family, hand: 'api', status: 'done', started_at: 'x' } as never }
            },
          },
        }),
  })
  const clientDispatch = createClientDispatch({ engine: h.engine, targets: () => targets, sessionIdsOf: () => [], now: () => new Date(clock) })
  const runner = createDispatchRunner({
    tasks,
    targets: () => targets,
    clientDispatch,
    engine: h.engine,
    alive: () => true,
    readFile: async () => undefined,
    sessions: () => [],
    now: () => new Date(clock),
    setTimer: () => 'timer',
    clearTimer: () => {},
  })
  const card = async (id: string) => (await tasks.list()).tasks.find(one => one.id === id)
  const newItem = async (status: TaskStatus = 'todo'): Promise<string> => {
    const created = await tasks.create({ title: '[闸测试] 一件事', direction: 'mine', status: 'todo' })
    const id = created.id as string
    // 七态转换表:todo → canceled 直达;done 要先过 doing。
    if (status === 'done') { await tasks.move(id, 'doing'); await tasks.move(id, 'done') }
    else if (status !== 'todo') await tasks.move(id, status)
    await refresh()
    return id
  }
  return { dir, tasks, runner, h, newItem, card, refresh, api: () => apiCalls, cli: () => cliRuns, tick: (ms: number) => { clock += ms } }
}

describe('① 收场的卡:一只手都不试,卡一个字不改', () => {
  it('★已取消的卡派给豆包(窗口 → 接口):ok:false、说收场;壳零 op、接口零调用;卡还是「已取消」', async () => {
    const r = rig()
    const id = await r.newItem('canceled')
    const got = await r.runner.start(id, { family: 'doubao', said: '已经取消的交代' })
    expect(got.ok).toBe(false)
    expect(got.hand).toBeUndefined()
    expect(got.note).toBe(DISPATCH_SETTLED_NOTE('豆包办公', 'canceled'))
    expect(r.api()).toBe(0)
    expect(r.h.requests).toHaveLength(0)
    const task = await r.card(id)
    expect(task?.status).toBe('canceled')
    expect(task?.note).toBeUndefined()
    expect(task?.client_dispatch).toBeUndefined()
    expect(task?.dispatch).toBeUndefined()
  })

  it('★已完成的卡派给 Codex(窗口 → 命令行):命令行零调用、壳零 op,卡还是「已完成」', async () => {
    const r = rig()
    const id = await r.newItem('done')
    const got = await r.runner.start(id, { family: 'codex', said: '已经办完的交代', cwd: r.dir })
    expect(got.ok).toBe(false)
    expect(got.note).toBe(DISPATCH_SETTLED_NOTE('Codex', 'done'))
    expect(r.cli()).toBe(0)
    expect(r.h.requests).toHaveLength(0)
    expect((await r.card(id))?.status).toBe('done')
  })

  it('那一句说得出是哪一种收场(办完 / 取消 用的是看板那张状态表的字)', () => {
    expect(DISPATCH_SETTLED_NOTE('豆包办公', 'canceled')).toContain(STATUS_TITLES.canceled)
    expect(DISPATCH_SETTLED_NOTE('豆包办公', 'done')).toContain(STATUS_TITLES.done)
    expect(DISPATCH_SETTLED_NOTE('豆包办公', 'done')).toContain('豆包办公')
  })
})

describe('② 窗口那只手被闸拦下(not_allowed):不换手、不写卡', () => {
  it('★重派到顶:第一回窗口送成;重派上限调成 0 → 第二回闸拦下 → 不走接口,卡还是第一回那样', async () => {
    const r = rig({ limits: { dispatch_resend: { tries: 0, minIntervalMs: 0 } } })
    const id = await r.newItem()
    const first = await r.runner.start(id, { family: 'doubao', said: '第一回' })
    expect(first).toMatchObject({ ok: true, hand: 'window' })
    await r.refresh()
    const before = await r.card(id)
    expect(before?.status).toBe('doing')
    r.tick(5_000)
    const second = await r.runner.start(id, { family: 'doubao', said: '第二回' })
    expect(second.ok).toBe(false)
    expect(second.hand).toBeUndefined()
    expect(second.note).toContain('到顶了')
    // 接口那只手一次都没碰;壳只收到第一回那一次送话。
    expect(r.api()).toBe(0)
    expect(r.h.sentTo()).toHaveLength(1)
    // 卡一个字没改:状态、第一回的记录、note 都还是原样。
    const after = await r.card(id)
    expect(after?.status).toBe(before?.status)
    expect(after?.client_dispatch?.text).toBe(before?.client_dispatch?.text)
    expect(after?.note).toBe(before?.note)
    expect(after?.dispatch).toBeUndefined()
  })
})

describe('③ 命令行 / 接口两条通道在引擎里:同一道闸、同一本账', () => {
  it('★接口那条(豆包只剩 api):闸上限 0 → 零调用、ok:false、说到顶了;账上有一行 gate_block', async () => {
    const r = rig({ targets: [only(DOUBAO, ['api'])], connected: false, limits: { dispatch_send: { tries: 0, minIntervalMs: 0 } } })
    const id = await r.newItem()
    const got = await r.runner.start(id, { family: 'doubao', said: '一句交代' })
    expect(got.ok).toBe(false)
    expect(got.note).toContain('到顶了')
    expect(r.api()).toBe(0)
    expect(r.h.log.events(id).some(one => one.step === 'gate_block')).toBe(true)
    expect((await r.card(id))?.status).toBe('todo')
  })

  it('接口那条:闸放行 → 调一次、ok:true/hand:api;账上 assigned 带 via api', async () => {
    const r = rig({ targets: [only(DOUBAO, ['api'])], connected: false })
    const id = await r.newItem()
    const got = await r.runner.start(id, { family: 'doubao', said: '一句交代' })
    expect(got).toMatchObject({ ok: true, hand: 'api' })
    expect(r.api()).toBe(1)
    const events = r.h.log.events(id)
    expect(events.some(one => one.step === 'gate_pass')).toBe(true)
    expect(events.find(one => one.step === 'assigned')?.via).toBe('api')
    expect((await r.card(id))?.dispatch).toMatchObject({ hand: 'api', status: 'done', reply: '本不该执行的回答' })
  })

  it('★命令行那条(Codex 只剩 cli):闸上限 0 → 零调用、ok:false', async () => {
    const r = rig({ targets: [only(CODEX, ['cli'])], connected: false, limits: { dispatch_send: { tries: 0, minIntervalMs: 0 } } })
    const id = await r.newItem()
    const got = await r.runner.start(id, { family: 'codex', said: '一句交代', cwd: r.dir })
    expect(got.ok).toBe(false)
    expect(got.note).toContain('到顶了')
    expect(r.cli()).toBe(0)
    expect((await r.card(id))?.status).toBe('todo')
  })

  it('命令行那条:闸放行 → 起一次、ok:true/hand:cli,卡上记着 pid 与结果文件;账上 assigned 带 via cli', async () => {
    const r = rig({ targets: [only(CODEX, ['cli'])], connected: false })
    const id = await r.newItem()
    const got = await r.runner.start(id, { family: 'codex', said: '一句交代', cwd: r.dir })
    expect(got).toMatchObject({ ok: true, hand: 'cli' })
    expect(r.cli()).toBe(1)
    expect((await r.card(id))?.dispatch).toMatchObject({ hand: 'cli', status: 'running', pid: 4242 })
    expect(r.h.log.events(id).find(one => one.step === 'assigned')?.via).toBe('cli')
  })

  it('一条通道都没登记(老宿主):派给只有接口的豆包 → 如实说没有能用的手,接口零调用,卡挂阻塞', async () => {
    const r = rig({ hands: false, targets: [only(DOUBAO, ['api'])], connected: false })
    const id = await r.newItem()
    const got = await r.runner.start(id, { family: 'doubao', said: '一句交代' })
    expect(got.ok).toBe(false)
    expect(got.note).toContain('没派出去')
    expect(r.api()).toBe(0)
    expect((await r.card(id))?.status).toBe('blocked')
  })
})
