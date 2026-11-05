// @vitest-environment node
/**
 * ★ **待排的卡不许被派出去**(2026-10-23,卡「待排的卡不许被派出去」①②)。
 *
 * 10-22 事故:24 张卡建成缺省「待办」被负责人驱动一件件派走;挪回「待排」之后,同一家排队的
 * 派活出队时只看「没结案」(`SETTLED_TASK_STATUS`),不看卡已经被挪走、负责人已经换了 ——
 * 待排的卡还是一张张被派出去。这一份钉住:
 *   ① 巡检轮到排着的那件时先核卡:状态必须仍是「待办 / 在做」、负责人仍是排队时那一家
 *      (或那张名片),否则撤掉这条排队、卡上写一句「排队时你把它挪走了,没派」,不派;
 *   ② 挪回「待排」那一刻就把 `dispatch_lane.state === 'queued'` 清掉(正在跑的窗口派活不动)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskClientDispatch } from '../src/protocol.ts'
import type { AdapterReadResult, Job } from '../src/server/engine/adapter.ts'
import type { ClientDispatch, SendToClientInput } from '../src/server/dispatchSend.ts'
import type { DispatchRunDeps } from '../src/server/dispatchRun.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import { DISPATCH_QUEUE_LEFT_NOTE, createTasksService } from '../src/server/tasks.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

async function until(what: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await what()) return
    await new Promise((resolve) => { setTimeout(resolve, 2) })
  }
  throw new Error(`等不到:${label}`)
}

function world(options: { read?: DispatchRunDeps['engine'] extends { read: infer R } ? R : never } = {}) {
  const state = { clock: Date.parse('2026-10-23T08:00:00Z') }
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-recheck-'))
  dirs.push(dir)
  let seq = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(state.clock / 1000), newId: () => `t-${++seq}` })
  const sent: SendToClientInput[] = []
  const clientDispatch: ClientDispatch = {
    async send(input) {
      sent.push(input)
      const dispatch: TaskClientDispatch = {
        hand: 'window', family: input.family as TaskClientDispatch['family'], status: 'sent',
        at: new Date(state.clock).toISOString(), text: input.text, submitted: true, method: 'paste', baseline: [],
      }
      return { ok: true, dispatch, baseline: [] }
    },
  }
  const base = {
    tasks,
    // 每一家都「同一时刻只送一件」:第二件起排队。
    exclusive: () => true,
    clientDispatch,
    readFile: async () => undefined,
    sessions: () => [],
    now: () => new Date(state.clock),
    setTimer: () => 'timer',
    clearTimer: () => {},
  }
  const runner = createDispatchRunner({
    ...base,
    // 默认读不到回话;个别用例换一支会答的。
    engine: { read: options.read ?? (async () => ({ via: 'window', evidence: 'none' })) },
  })
  /** 同一个世界换一支读法再开一个 runner(前一件要「做完」时用它)。 */
  const runnerWith = (read: NonNullable<DispatchRunDeps['engine']>['read']) => createDispatchRunner({
    ...base,
    engine: { read },
  })
  const card = async (title: string): Promise<string> => (await tasks.create({ title, direction: 'mine', status: 'todo' })).id as string
  const find = async (id: string) => (await tasks.list()).tasks.find(one => one.id === id)
  return { state, tasks, runner, runnerWith, sent, card, find }
}

/** 前一件「做完了」的读法:看到记号就回一句固定的话(连读两次一样 = 说完了)。 */
const doneRead = (marker: string, reply: string) => async (job: Job): Promise<AdapterReadResult> =>
  job.marks?.[0] === marker ? { via: 'window', evidence: 'window', reply } : { via: 'window', evidence: 'none' }

describe('出队前核卡(①)', () => {
  it('★排队中把它挪回「待排」:轮到它不派、队已撤,卡上写「排队时你把它挪走了,没派」', async () => {
    const w = world()
    const ahead = await w.card('前一件')
    const queued = await w.card('排着的那件')
    await w.runner.start(ahead, { family: 'kimi', said: '先做这个' })
    const second = await w.runner.start(queued, { family: 'kimi', said: '再做这个' })
    expect(second.queued).toBe(true)
    expect((await w.find(queued))?.dispatch_lane?.state).toBe('queued')

    // 她把它挪回「待排」:队当场撤掉,卡上那句换成「排队时你把它挪走了,没派」。
    expect((await w.tasks.move(queued, 'backlog')).ok).toBe(true)
    expect((await w.find(queued))?.dispatch_lane).toBeUndefined()
    expect((await w.find(queued))?.note).toBe(DISPATCH_QUEUE_LEFT_NOTE)

    // 前一件做完了(窗口里读到了回答);再巡几轮,排着的那件始终没有被派出去。
    const marker = (await w.find(ahead))?.client_dispatch?.marker as string
    const runner2 = w.runnerWith(doneRead(marker, '做完了'))
    await until(async () => { void runner2.tick(); return (await w.find(ahead))?.status === 'confirm' }, '前一件挪进等你确认')
    const sentBefore = w.sent.length
    for (let i = 0; i < 5; i += 1) await runner2.tick()
    expect(w.sent.length).toBe(sentBefore)
    const task = await w.find(queued)
    expect(task?.status).toBe('backlog')
    expect(task?.note).toBe(DISPATCH_QUEUE_LEFT_NOTE)
  })

  it('★排队中改派给别家:轮到它不派、撤掉排队,卡上写那一句', async () => {
    const w = world()
    const ahead = await w.card('前一件')
    const queued = await w.card('排着的那件')
    await w.runner.start(ahead, { family: 'kimi', said: '先做这个' })
    await w.runner.start(queued, { family: 'kimi', said: '再做这个' })
    // 她把负责人换成了别家。
    expect(await w.tasks.update(queued, { assignee: 'codex' })).toBe(true)

    const marker = (await w.find(ahead))?.client_dispatch?.marker as string
    const runner2 = w.runnerWith(doneRead(marker, '做完了'))
    await until(async () => { void runner2.tick(); return (await w.find(ahead))?.status === 'confirm' }, '前一件挪进等你确认')

    const sentBefore = w.sent.length
    await until(async () => { void runner2.tick(); return (await w.find(queued))?.dispatch_lane === undefined }, '排着的那件撤队')
    expect(w.sent.length).toBe(sentBefore)
    const task = await w.find(queued)
    expect(task?.assignee).toBe('codex')
    expect(task?.note).toBe(DISPATCH_QUEUE_LEFT_NOTE)
  })

  it('负责人是那张名片(名片解析出来仍是这一家):照旧派', async () => {
    // 卡 B/D:名片任务的负责人是名片 id,排队时落到卡上的也是名片 id;
    // 出队核卡认「名片解析 = 这一家」这一档,不算「被改派」。
    const w = world()
    const ahead = await w.card('前一件')
    await w.tasks.saveAgentCard({ name: 'Kimi 写码', hand: 'kimi', runtime: { family: 'kimi' } })
    const cardId = (await w.tasks.list()).agent_cards?.[0]?.id as string
    const queued = await w.card('排着的那件')
    await w.tasks.update(queued, { assignee: cardId })
    await w.runner.start(ahead, { family: 'kimi', said: '先做这个' })
    await w.runner.start(queued, { family: 'kimi', said: '再做这个' })
    expect((await w.find(queued))?.dispatch_lane?.state).toBe('queued')

    const marker = (await w.find(ahead))?.client_dispatch?.marker as string
    const runner2 = w.runnerWith(doneRead(marker, '做完了'))
    await until(async () => { void runner2.tick(); return (await w.find(ahead))?.status === 'confirm' }, '前一件挪进等你确认')
    // 轮到它:照落盘的交代接着派(送出去了,没在队里留着)。
    await until(async () => { void runner2.tick(); return (await w.find(queued))?.client_dispatch?.status === 'sent' }, '排着的那件接着派出去')
    expect(w.sent.length).toBeGreaterThanOrEqual(2)
  })
})

describe('挪回待排即撤队(②)', () => {
  it('★挪到「待排」那一刻就清掉「排着」那条队;正在等回话的窗口派活不跟着动', async () => {
    const w = world()
    const ahead = await w.card('前一件')
    const queued = await w.card('排着的那件')
    await w.runner.start(ahead, { family: 'kimi', said: '先做这个' })
    await w.runner.start(queued, { family: 'kimi', said: '再做这个' })
    expect((await w.find(queued))?.dispatch_lane?.state).toBe('queued')

    // 挪回待排:队立刻撤掉。
    expect((await w.tasks.move(queued, 'backlog')).ok).toBe(true)
    const after = await w.find(queued)
    expect(after?.status).toBe('backlog')
    expect(after?.dispatch_lane).toBeUndefined()

    // 正在等回话的那件(前一件)没有「排着」那一格;把它也挪「待排」,
    // 它在窗口里那次派活的记录一字不动(只是挪状态)。
    const waiting = (await w.find(ahead))?.client_dispatch
    expect(waiting?.reply_state).toBe('waiting')
    expect((await w.tasks.move(ahead, 'backlog')).ok).toBe(true)
    expect((await w.find(ahead))?.client_dispatch).toEqual(waiting)
  })
})
