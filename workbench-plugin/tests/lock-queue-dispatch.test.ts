// @vitest-environment node
/**
 * ★ **解锁之后,排着的派活回到派活的正常流程**(2026-10-12,卡「锁屏派活排队」)。
 *
 * 排着的派活不能只「再调一次引擎」:那样字送出去了,卡还挂在「等你处理」、没人盯窗读回话、没人自查。
 * 所以派活那几条经 `dispatchItem` 整件重派(卡挪「在办」、盯窗、自查一样不少);
 * 重派之前先看卡上的事实:还在等解锁、还是派给这一家,才送。
 */
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import type { Job, JobResult } from '../src/server/engine/adapter.ts'
import type { DispatchStartResult } from '../src/server/dispatchRun.ts'
import { createLockQueue, lockQueueKey } from '../src/server/engine/lockQueue.ts'
import { createLockQueueDispatch, LOCK_RELEASE_NOTE } from '../src/server/lockQueueDispatch.ts'

function taskOf(over: { [K in keyof TaskView]?: TaskView[K] | undefined } = {}): TaskView {
  return {
    id: 't-cover',
    title: '封面做三版',
    status: 'blocked',
    block_reason: 'input',
    dispatch_block: { family: 'doubao', kind: 'chat', why: '电脑锁着屏…', unlock: true, at: '2026-10-12T01:00:00.000Z' },
    ...over,
  } as TaskView
}

const job: Job = {
  id: 't-cover', itemId: 't-cover', family: 'doubao', kind: 'dispatch', target: { kind: 'new' },
  text: '【派活 t-cover】帮我把这篇的封面做三版', expect: 'ack', waitUnlock: true, brief: '帮我把这篇的封面做三版', work: 'chat',
}

function rig(task: TaskView | undefined, started: DispatchStartResult = { ok: true, hand: 'window', note: '已经送到' }) {
  const calls: { taskId: string, input: Record<string, unknown> }[] = []
  const engineRuns: Job[] = []
  const released: { taskId: string, note: string }[] = []
  const bridge = createLockQueueDispatch({
    releaseCard: async (taskId, note) => { released.push({ taskId, note }) },
    run: async (one) => { engineRuns.push(one); return { delivered: 'confirmed', via: 'window', evidence: 'window' } satisfies JobResult },
    findTask: async () => task,
    dispatchItem: async (taskId, input) => { calls.push({ taskId, input }); return started },
  })
  return { bridge, calls, engineRuns, released }
}

describe('还在等吗(stillWanted:判据是卡上的事实)', () => {
  it('还挂着「在等你解锁电脑」、还是这一家 → 还在等', async () => {
    expect(await rig(taskOf()).bridge.stillWanted(job)).toBeUndefined()
  })
  it('★卡没了 / 收了 / 别的手已经派出去(不再挂那一格)/ 改派了别家 → 不在等(说得出为什么)', async () => {
    expect(await rig(undefined).bridge.stillWanted(job)).toContain('不在看板上')
    expect(await rig(taskOf({ status: 'done' })).bridge.stillWanted(job)).toContain('完成')
    expect(await rig(taskOf({ status: 'doing', dispatch_block: undefined })).bridge.stillWanted(job)).toContain('不在等解锁')
    const other = taskOf({ dispatch_block: { family: 'kimi', kind: 'chat', why: 'x', unlock: true, at: '' } })
    expect(await rig(other).bridge.stillWanted(job)).toContain('kimi')
  })
  it('她那句话(替她答 / 捎话)不问:照老规矩送', async () => {
    const answer: Job = { id: 'session:kimi/x', family: 'kimi', kind: 'answer', target: { kind: 'session', sessionId: 'x' }, text: '好', expect: 'ack' }
    expect(await rig(undefined).bridge.stillWanted(answer)).toBeUndefined()
  })
})

describe('重送(run)', () => {
  it('★★派活经 dispatchItem 整件重派:她的原话、这一家、这一种活、按发送', async () => {
    const r = rig(taskOf())
    const out = await r.bridge.run(job)
    expect(r.engineRuns).toEqual([])
    expect(r.calls).toEqual([{ taskId: 't-cover', input: { family: 'doubao', text: '帮我把这篇的封面做三版', source: 'item', kind: 'chat' } }])
    expect(out.delivered).not.toBe('not_sent')
  })
  it('★又撞上锁屏 → 回 screenLocked(队里留着,下一回解锁再来)', async () => {
    const r = rig(taskOf(), { ok: false, note: '电脑锁着屏…', screen_locked: true })
    const out = await r.bridge.run(job)
    expect(out.screenLocked).toBe(true)
    expect(out.delivered).toBe('not_sent')
  })
  it('别的失败 → not_sent + 那一句(卡上 dispatchRun 已经照常写好了)', async () => {
    const r = rig(taskOf(), { ok: false, note: '派给 豆包 没派出去:接口这会儿连不上' })
    const out = await r.bridge.run(job)
    expect(out.delivered).toBe('not_sent')
    expect(out.screenLocked).toBeUndefined()
    expect(out.why).toContain('接口这会儿连不上')
  })
  it('★★没派成、卡上还挂着「解锁就送」(闸拦下那一类 dispatchRun 不改卡)→ 摘掉那一格、说一句,不留一个不会兑现的诺', async () => {
    const r = rig(taskOf(), { ok: false, note: '豆包:这一下工作台没放行' })
    await r.bridge.run(job)
    expect(r.released).toHaveLength(1)
    expect(r.released[0]?.note).toContain('这一下工作台没放行')
    expect(r.released[0]?.note).toContain(LOCK_RELEASE_NOTE)
  })
  it('又撞上锁屏 → 不摘(还排着)', async () => {
    const r = rig(taskOf(), { ok: false, note: '电脑锁着屏…', screen_locked: true })
    await r.bridge.run(job)
    expect(r.released).toEqual([])
  })
  it('release:卡已经不挂那一格 / 改派别家 → 不动卡', async () => {
    expect((await (async () => { const r = rig(taskOf({ status: 'doing', dispatch_block: undefined })); await r.bridge.release(job, 'x'); return r.released })())).toEqual([])
    const other = taskOf({ dispatch_block: { family: 'kimi', kind: 'chat', why: 'x', unlock: true, at: '' } })
    expect((await (async () => { const r = rig(other); await r.bridge.release(job, 'x'); return r.released })())).toEqual([])
  })

  it('她那句话照旧再调一次引擎', async () => {
    const r = rig(undefined)
    const answer: Job = { id: 'session:kimi/x', family: 'kimi', kind: 'answer', target: { kind: 'session', sessionId: 'x' }, text: '好', expect: 'ack' }
    await r.bridge.run(answer)
    expect(r.engineRuns).toEqual([answer])
    expect(r.calls).toEqual([])
  })
})

describe('队里自己丢掉的那几条(过期 / 满了 / 重送到顶):告诉接线那一处', () => {
  it('★onDrop:到顶、过期都报一声(派活据此摘卡上那一格)', () => {
    let now = Date.parse('2026-10-12T01:00:00.000Z')
    const dropped: string[] = []
    const queue = createLockQueue({ now: () => new Date(now), maxTries: 2, ttlMs: 60_000, onDrop: (row, why) => dropped.push(`${row.job.itemId ?? row.job.id}:${why}`) })
    queue.add(job)
    queue.retried(lockQueueKey(job))
    queue.retried(lockQueueKey(job))
    expect(dropped).toEqual(['t-cover:tries'])
    queue.add({ ...job, itemId: 't-old' })
    now += 120_000
    queue.list()
    expect(dropped).toEqual(['t-cover:tries', 't-old:expired'])
  })
})
