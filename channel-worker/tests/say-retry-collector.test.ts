import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextTurnCollector } from '../src/textTurn.ts'
afterEach(() => vi.useRealTimers())
describe('text phone collector waits for its one transport retry', () => {
  it('keeps the late actual spoken result after the fallback has returned to listening', async () => {
    vi.useFakeTimers()
    const collector = new TextTurnCollector({ graceMs: 10, timeoutMs: 90000 })
    const release = collector.hold()
    let done = false
    void collector.done().then(() => { done = true })
    collector.agentState('speaking'); collector.butler('这句我记着，马上办。'); collector.agentState('listening')
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(false)
    collector.agentState('speaking'); collector.butler('记下了 2 条。'); collector.agentState('listening')
    release(); await vi.advanceTimersByTimeAsync(11)
    expect((await collector.done()).said).toEqual(['这句我记着，马上办。', '记下了 2 条。'])
  })
  it('retains the original hard deadline if the retry or playback never finishes', async () => {
    vi.useFakeTimers()
    const collector = new TextTurnCollector({ graceMs: 10, timeoutMs: 60 })
    collector.hold(); collector.agentState('speaking'); collector.agentState('listening')
    await vi.advanceTimersByTimeAsync(60)
    expect((await collector.done()).timedOut).toBe(true)
  })
})
