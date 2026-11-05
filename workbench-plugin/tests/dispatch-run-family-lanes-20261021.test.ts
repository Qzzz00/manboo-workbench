// @vitest-environment node
/**
 * ★ **派活巡检按家分开、同一家同一时刻只送一件**(2026-10-21,卡「派活按家隔离」)。
 *
 * 全景地图「最脆处 · 一」:巡检一个定时器一圈里逐张卡顺序等壳读窗 —— 一家读不动,所有别家的卡几分钟没人盯;
 * 同一家两件同时送,后一件开新对话把前一件那条对话顶走,前一件的回话再也读不回来。
 * 这一份钉住验收的那几句:任一家卡死,别家照常;同一家排队并在卡上写明「排在 X 后面」;
 * 读窗超时在卡上一句人话、不当「没看到这一句」挪卡;插件被杀再起,进行中的事不丢不重。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskClientDispatch } from '../src/protocol.ts'
import { dispatchFamilyTitle } from '../src/protocol.ts'
import type { AdapterReadResult, Job } from '../src/server/engine/adapter.ts'
import type { ClientDispatch, SendToClientInput } from '../src/server/dispatchSend.ts'
import { DISPATCH_NOT_SEEN_MS, DISPATCH_RECOVER_GRACE_MS, createDispatchRunner, dispatchQueuedNote } from '../src/server/dispatchRun.ts'
import { dispatchMarker } from '../src/server/dispatchReply.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createTasksService } from '../src/server/tasks.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

async function until(what: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await what()) return
    await new Promise((resolve) => { setTimeout(resolve, 2) })
  }
  throw new Error(`等不到:${label}`)
}


function world(options: {
  read?: (job: Job) => Promise<AdapterReadResult>
  send?: (input: SendToClientInput, clock: number) => Promise<Awaited<ReturnType<ClientDispatch['send']>>>
  exclusive?: (family: string) => boolean
  dir?: string
} = {}) {
  const state = { clock: Date.parse('2026-10-21T08:00:00Z') }
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'wb-dispatch-lanes-'))
  if (options.dir === undefined) dirs.push(dir)
  let seq = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(state.clock / 1000), newId: () => `t-${Date.now().toString(36)}-${seq += 1}` })
  const sent: SendToClientInput[] = []
  const clientDispatch: ClientDispatch = {
    async send(input) {
      sent.push(input)
      if (options.send !== undefined) return await options.send(input, state.clock)
      const dispatch: TaskClientDispatch = {
        hand: 'window', family: input.family as TaskClientDispatch['family'], status: 'sent',
        at: new Date(state.clock).toISOString(), text: input.text, submitted: true, method: 'paste', baseline: [],
      }
      return { ok: true, dispatch, baseline: [] }
    },
  }
  const jobLog = createJobLog({ now: () => new Date(state.clock) })
  const runner = createDispatchRunner({
    tasks,
    engine: { read: options.read ?? (async () => ({ via: 'window', evidence: 'none' })) },
    clientDispatch,
    jobLog,
    readFile: async () => undefined,
    sessions: () => [],
    now: () => new Date(state.clock),
    setTimer: () => 'timer',
    clearTimer: () => {},
    ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
  })
  const card = async (title: string): Promise<string> => (await tasks.create({ title, direction: 'mine', status: 'todo' })).id as string
  const find = async (id: string) => (await tasks.list()).tasks.find(one => one.id === id)
  return { state, tasks, runner, sent, card, find, jobLog, dir }
}

const replyFor = (marker: string, reply: string) => async (job: Job): Promise<AdapterReadResult> =>
  job.marks?.[0] === marker ? { via: 'window', evidence: 'window', reply } : { via: 'window', evidence: 'none' }

describe('巡检按家分开', () => {
  it('★豆包那一下读窗挂死:Kimi 那张卡照常收回、挪「等你确认」,不等豆包', async () => {
    let w: ReturnType<typeof world> | undefined
    w = world({
      read: async (job) => {
        if (job.family === 'doubao') return await new Promise<AdapterReadResult>(() => {})
        return { via: 'window', evidence: 'window', reply: 'Kimi 的回答' }
      },
    })
    const doubao = await w.card('豆包那件')
    const kimi = await w.card('Kimi 那件')
    await w.runner.start(doubao, { family: 'doubao', said: '总结一下' })
    await w.runner.start(kimi, { family: 'kimi', said: '翻译一下' })
    // 定时器每拍都打一下 tick:豆包那一圈一直没回来,Kimi 那一圈照样一拍一拍走(稳住要连读两次一样)。
    await until(async () => { void w?.runner.tick(); return (await w?.find(kimi))?.status === 'confirm' }, 'Kimi 那张卡挪进等你确认')
    expect((await w.find(kimi))?.client_dispatch?.reply).toBe('Kimi 的回答')
    expect((await w.find(doubao))?.status).toBe('doing')
  })
})

describe('通道堵了在卡上一句人话', () => {
  it('★读窗超了上限:卡上写哪家、哪一步、等了多久;不当「没看到这一句」挪卡;读通了就清掉', async () => {
    let jammed = true
    const say = '豆包 的窗口卡住了:读回话那一步等了 20 秒没回应 —— 先跳过它,别家照常;点「重置这一家」可以清掉这条通道'
    const w = world({
      read: async () => (jammed ? { via: 'window', evidence: 'none', why: say, jammed: true } : { via: 'window', evidence: 'window' }),
    })
    const id = await w.card('豆包那件')
    await w.runner.start(id, { family: 'doubao', said: '总结一下' })
    await w.runner.tick()
    let task = await w.find(id)
    expect(task?.dispatch_lane).toMatchObject({ family: 'doubao', state: 'jammed', note: say })
    expect(task?.client_dispatch?.reply_state).toBe('waiting')

    // 堵了五分钟(早过了「三分钟没看到那一句」那条线):照旧不挪卡、不说成没发出去。
    w.state.clock += DISPATCH_NOT_SEEN_MS + 2 * 60_000
    await w.runner.tick()
    task = await w.find(id)
    expect(task?.status).toBe('doing')
    expect(task?.client_dispatch?.reply_state).toBe('waiting')
    expect(task?.note ?? '').not.toContain('没看到')

    // 通了:那一句清掉;「没看到那一句」的三分钟从通了那一刻重新算。
    jammed = false
    await w.runner.tick()
    task = await w.find(id)
    expect(task?.dispatch_lane).toBeUndefined()
    expect(task?.status).toBe('doing')
  })
})

describe('同一家同一时刻只送一件', () => {
  it('★后一件排在前一件后面,卡上写明;前一件收回之后自动送;别家不排', async () => {
    let w: ReturnType<typeof world> | undefined
    let firstDone = false
    w = world({
      exclusive: family => family === 'doubao',
      read: async job => (job.family === 'doubao' && firstDone && job.itemId === first
        ? { via: 'window', evidence: 'window', reply: '第一件的回答' }
        : { via: 'window', evidence: 'window' }),
    })
    const first = await w.card('写一段开场白')
    const second = await w.card('起三个标题')
    const kimi = await w.card('Kimi 那件')
    await w.runner.start(first, { family: 'doubao', said: '写一段开场白' })
    const queued = await w.runner.start(second, { family: 'doubao', said: '起三个标题' })
    await w.runner.start(kimi, { family: 'kimi', said: '翻译一下' })

    expect(w.sent.map(one => `${one.family}:${one.job}`)).toEqual([`doubao:${first}`, `kimi:${kimi}`])
    expect(queued.ok).toBe(true)
    expect(queued.note).toBe(dispatchQueuedNote({ who: dispatchFamilyTitle('doubao'), behind: '写一段开场白' }))
    const parked = await w.find(second)
    expect(parked?.dispatch_lane).toMatchObject({ family: 'doubao', state: 'queued', behind: first })
    expect(parked?.dispatch_lane?.input?.said).toBe('起三个标题')
    expect(parked?.client_dispatch).toBeUndefined()

    // 前一件还在等回话:再巡几拍也不送第二件。
    await w.runner.tick()
    expect(w.sent).toHaveLength(2)

    firstDone = true
    await w.runner.tick() // 第一件收回
    await w.runner.tick() // 轮到第二件
    expect((await w.find(first))?.status).toBe('confirm')
    expect(w.sent.map(one => one.job)).toEqual([first, kimi, second])
    const sentNow = await w.find(second)
    expect(sentNow?.dispatch_lane).toBeUndefined()
    expect(sentNow?.client_dispatch?.reply_state).toBe('waiting')
  })

  it('排着的那件被她取消了:轮到它时不送,那一格清掉', async () => {
    let done = false
    const w = world({
      exclusive: () => true,
      read: async () => (done ? { via: 'window', evidence: 'window', reply: '好了' } : { via: 'window', evidence: 'window' }),
    })
    const first = await w.card('一')
    const second = await w.card('二')
    await w.runner.start(first, { family: 'doubao', said: '一' })
    await w.runner.start(second, { family: 'doubao', said: '二' })
    await w.tasks.move(second, 'canceled')
    done = true
    await w.runner.tick()
    await w.runner.tick()
    expect(w.sent.map(one => one.job)).toEqual([first])
    expect((await w.find(second))?.dispatch_lane).toBeUndefined()
  })
})

describe('插件被杀再起:不丢不重', () => {
  it('★送到一半被杀:重启后在它对话里核到那一句 → 接着等回话,不再送第二遍;账上只有一次指派', async () => {
    const first = world({ send: () => new Promise(() => {}) })
    const id = await first.card('豆包那件')
    void first.runner.start(id, { family: 'doubao', said: '总结一下' })
    await until(async () => (await first.find(id))?.dispatch_lane?.state === 'sending', '落盘「正在送」')
    const lane = (await first.find(id))?.dispatch_lane
    expect(lane?.marker).toBe(dispatchMarker(id))
    // kill -9:这个 runner 就此不再动;同一份看板起一个新的。
    const again = world({ dir: first.dir, read: replyFor(dispatchMarker(id), '') })
    await again.runner.resume()
    const task = await again.find(id)
    expect(again.sent).toHaveLength(0)
    expect(task?.dispatch_lane).toBeUndefined()
    expect(task?.client_dispatch).toMatchObject({ family: 'doubao', reply_state: 'waiting', marker: dispatchMarker(id) })
  })

  it('★送到一半被杀、对话里核不到那一句:不自己再送(怕送两遍),卡上说清楚、她点重派', async () => {
    const first = world({ send: () => new Promise(() => {}) })
    const id = await first.card('豆包那件')
    void first.runner.start(id, { family: 'doubao', said: '总结一下' })
    await until(async () => (await first.find(id))?.dispatch_lane?.state === 'sending', '落盘「正在送」')
    let seenNow = false
    const again = world({ dir: first.dir, read: async () => (seenNow ? { via: 'window', evidence: 'window' } : { via: 'window', evidence: 'none' }) })
    await again.runner.resume()
    // 壳不跟着插件死:重启那一刻还没露面,先不判(宽限期内下一拍再核)。
    expect((await again.find(id))?.dispatch_lane?.state).toBe('sending')
    again.state.clock += DISPATCH_RECOVER_GRACE_MS + 1
    await again.runner.tick()
    const task = await again.find(id)
    expect(again.sent).toHaveLength(0)
    expect(task?.status).toBe('blocked')
    expect(task?.note).toContain('重启')
    expect(task?.note).toContain(dispatchFamilyTitle('doubao'))
    expect(task?.dispatch_lane).toBeUndefined()
    expect(again.jobLog.all().some(one => one.job === id && one.step === 'unreadable')).toBe(true)
  })

  it('★壳在插件死后把那一下做完了:宽限期内晚几秒露面 → 接着等回话,不送第二遍', async () => {
    const first = world({ send: () => new Promise(() => {}) })
    const id = await first.card('豆包那件')
    void first.runner.start(id, { family: 'doubao', said: '总结一下' })
    await until(async () => (await first.find(id))?.dispatch_lane?.state === 'sending', '落盘「正在送」')
    let seenNow = false
    const again = world({ dir: first.dir, read: async () => (seenNow ? { via: 'window', evidence: 'window' } : { via: 'window', evidence: 'none' }) })
    await again.runner.resume()
    again.state.clock += 10_000
    seenNow = true
    await again.runner.tick()
    const task = await again.find(id)
    expect(again.sent).toHaveLength(0)
    expect(task?.dispatch_lane).toBeUndefined()
    expect(task?.client_dispatch?.reply_state).toBe('waiting')
  })

  it('★排着的那件:重启后还排着,前一件收回后照常送一遍', async () => {
    const first = world({ exclusive: () => true })
    const a = await first.card('一')
    const b = await first.card('二')
    await first.runner.start(a, { family: 'doubao', said: '一' })
    await first.runner.start(b, { family: 'doubao', said: '二' })
    const again = world({ dir: first.dir, exclusive: () => true, read: replyFor(dispatchMarker(a), '一的回答') })
    await again.runner.resume()
    await again.runner.tick()
    await again.runner.tick()
    expect(again.sent.map(one => one.job)).toEqual([b])
    expect((await again.find(b))?.client_dispatch?.reply_state).toBe('waiting')
  })
})
