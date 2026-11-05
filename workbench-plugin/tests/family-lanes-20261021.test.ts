/**
 * ★ **每一家一条通道**(2026-10-21,卡「派活按家隔离」)。
 *
 * 全景地图「最脆处 · 一 堵塞与连坐」:一家读不动,所有别家的卡几分钟没人盯;
 * 没有「清通道」,只能重启插件。这一份钉住通道本身的四条规矩:
 * ① 同一家排队、不同家互不等;② 每一下有硬上限,超了判「通道堵了」并放开通道;
 * ③ 堵着的那一家读窗先跳过、隔一阵才探一次;④ 「重置这一家」撤掉排着的、清掉堵的记录。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANE_STEP_TEXT, createFamilyLanes, laneJamSay } from '../src/server/familyLanes.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('每一家一条通道', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-21T08:00:00Z') }) })
  afterEach(() => { vi.useRealTimers() })

  const lanesWith = () => createFamilyLanes({
    now: () => new Date(),
    name: family => ({ doubao: '豆包', kimi: 'Kimi' })[family] ?? family,
    readCapMs: 20_000,
    runCapMs: 120_000,
    probeEveryMs: 15_000,
  })

  it('同一家排队一个一个来;别家不等它', async () => {
    const lanes = lanesWith()
    const slow = deferred<string>()
    const order: string[] = []
    const first = lanes.run('doubao', 'read', async () => { order.push('豆包1 开始'); return slow.promise })
    const second = lanes.run('doubao', 'read', async () => { order.push('豆包2 开始'); return 'b' })
    const other = lanes.run('kimi', 'read', async () => { order.push('Kimi 开始'); return 'k' })
    await expect(other).resolves.toEqual({ ok: true, value: 'k' })
    expect(order).toEqual(['豆包1 开始', 'Kimi 开始'])
    expect(lanes.view('doubao')).toMatchObject({ busy: true, queued: 1 })
    slow.resolve('a')
    await expect(first).resolves.toEqual({ ok: true, value: 'a' })
    await expect(second).resolves.toEqual({ ok: true, value: 'b' })
    expect(order).toEqual(['豆包1 开始', 'Kimi 开始', '豆包2 开始'])
  })

  it('超了硬上限 = 通道堵了:说清哪家、哪一步、等了多久,并放开通道给下一件', async () => {
    const lanes = lanesWith()
    const never = new Promise<string>(() => {})
    const stuck = lanes.run('doubao', 'read', () => never)
    const next = lanes.run('doubao', 'send', async () => 'sent')
    await vi.advanceTimersByTimeAsync(20_000)
    const out = await stuck
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.why).toBe('jammed')
    expect(out.jam).toMatchObject({ family: 'doubao', step: 'read', waitedMs: 20_000 })
    expect(out.say).toContain('豆包')
    expect(out.say).toContain(LANE_STEP_TEXT.read)
    expect(out.say).toContain('20 秒')
    await expect(next).resolves.toEqual({ ok: true, value: 'sent' })
    // 送成了一下 ≠ 读通了:堵的记录只由**同一步**做成了才清。
    expect(lanes.view('doubao').jam?.step).toBe('read')
  })

  it('送话那一步的上限比读窗长', async () => {
    const lanes = lanesWith()
    const out = lanes.run('doubao', 'send', () => new Promise<string>(() => {}))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(lanes.view('doubao').jam).toBeUndefined()
    await vi.advanceTimersByTimeAsync(100_000)
    await expect(out).resolves.toMatchObject({ ok: false, why: 'jammed', jam: { step: 'send', waitedMs: 120_000 } })
  })

  it('堵着的那一家:读窗先跳过(一下都不发),隔一阵才探一次;探通了就清掉', async () => {
    const lanes = lanesWith()
    void lanes.run('doubao', 'read', () => new Promise<string>(() => {}))
    await vi.advanceTimersByTimeAsync(20_000)
    const fn = vi.fn(async () => 'ok')
    const skipped = await lanes.run('doubao', 'read', fn)
    expect(skipped).toMatchObject({ ok: false, why: 'skipped' })
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(lanes.run('doubao', 'read', fn)).resolves.toEqual({ ok: true, value: 'ok' })
    expect(lanes.view('doubao').jam).toBeUndefined()
  })

  it('重置这一家:排着的撤掉、在跑的那一下作废、堵的记录清掉;别家一点不动', async () => {
    const lanes = lanesWith()
    const running = deferred<string>()
    const a = lanes.run('doubao', 'read', () => running.promise)
    const b = lanes.run('doubao', 'read', async () => 'never-runs')
    const k = deferred<string>()
    const kimi = lanes.run('kimi', 'read', () => k.promise)
    const done = lanes.reset('doubao')
    expect(done).toEqual({ cancelled: 1, abandoned: 1 })
    await expect(b).resolves.toMatchObject({ ok: false, why: 'reset' })
    await expect(a).resolves.toMatchObject({ ok: false, why: 'reset' })
    running.resolve('late')
    expect(lanes.view('doubao')).toMatchObject({ busy: false, queued: 0 })
    await expect(lanes.run('doubao', 'read', async () => 'again')).resolves.toEqual({ ok: true, value: 'again' })
    k.resolve('k')
    await expect(kimi).resolves.toEqual({ ok: true, value: 'k' })
  })

  it('抛出来的错原样往上抛(那是那一步自己的失败,不是通道堵了)', async () => {
    const lanes = lanesWith()
    await expect(lanes.run('doubao', 'read', async () => { throw new Error('壳回了失败') })).rejects.toThrow('壳回了失败')
    expect(lanes.view('doubao').jam).toBeUndefined()
  })

  it('堵了要记账:每次判堵回调一次', async () => {
    const onJam = vi.fn()
    const lanes = createFamilyLanes({ now: () => new Date(), readCapMs: 1000, onJam })
    void lanes.run('kimi', 'read', () => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(1000)
    expect(onJam).toHaveBeenCalledWith(expect.objectContaining({ family: 'kimi', step: 'read', waitedMs: 1000 }))
  })

  it('人话:哪家、哪一步、等了多久、能怎么办', () => {
    const say = laneJamSay({ who: '豆包', step: 'read', waitedMs: 20_000 })
    expect(say).toBe(`豆包 的窗口卡住了:${LANE_STEP_TEXT.read}那一步等了 20 秒没回应 —— 先跳过它,别家照常;点「重置这一家」可以清掉这条通道`)
  })
})
