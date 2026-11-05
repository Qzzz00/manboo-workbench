/**
 * 字幕按播放顺序出(2026-09-18)。本机实测:开场白拆成四小块并发合成,最短那句最先合完,
 * 于是屏幕上**先出现最后一句**。这条队列就是为这件事存在的。
 */
import { describe, expect, it, vi } from 'vitest'
import { SpeechOrder } from '../src/tts/speechOrder.ts'

describe('SpeechOrder', () => {
  it('谁先合完都不算:按占位(=播放)顺序出', () => {
    const emit = vi.fn()
    const order = new SpeechOrder(emit)
    const a = order.slot('第一句')
    const b = order.slot('第二句')
    const c = order.slot('第三句')

    order.ready(c, true)
    order.ready(b, true)
    expect(emit).not.toHaveBeenCalled() // 队头还没好,后面的先排着

    order.ready(a, true)
    expect(emit.mock.calls.map(call => call[0])).toEqual(['第一句', '第二句', '第三句'])
  })

  it('合成失败也出字幕(ok:false):没声音至少还有字', () => {
    const emit = vi.fn()
    const order = new SpeechOrder(emit)
    const a = order.slot('出不了声的那句')
    order.ready(a, false)
    expect(emit).toHaveBeenCalledWith('出不了声的那句', false)
  })

  it('被打断的那块让位:后面的字幕不会跟着卡死', () => {
    const emit = vi.fn()
    const order = new SpeechOrder(emit)
    const a = order.slot('被打断的')
    const b = order.slot('后面那句')
    order.ready(b, true)
    expect(emit).not.toHaveBeenCalled()
    order.drop(a)
    expect(emit.mock.calls.map(call => call[0])).toEqual(['后面那句'])
  })

  it('同一块重复 ready / drop 只算一次', () => {
    const emit = vi.fn()
    const order = new SpeechOrder(emit)
    const a = order.slot('一句')
    order.ready(a, true)
    order.ready(a, true)
    order.drop(a)
    expect(emit).toHaveBeenCalledTimes(1)
  })
})

/**
 * 看门狗(2026-09-18 本机实测):框架有时造出一块从来不跑、也不 abort 的合成,
 * 队头就永远 pending —— 那一次的现象是「她说了话,屏幕上一个字都没有」。
 * 宁可漏一句字幕,也不能整段没有字幕。
 */
describe('SpeechOrder 的看门狗', () => {
  function fakeTimer() {
    const jobs: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    return {
      setTimer: (fn: () => void, ms: number) => {
        const job = { fn, ms, cancelled: false };
        jobs.push(job);
        return { cancel: () => { job.cancelled = true; } };
      },
      fire: () => { for (const job of jobs.splice(0)) if (!job.cancelled) job.fn(); },
      jobs,
    };
  }

  it('队头一直不来:到点扔掉它,后面的字幕照出', () => {
    const emit = vi.fn()
    const timer = fakeTimer()
    const order = new SpeechOrder(emit, { stallMs: 100, setTimer: timer.setTimer })
    order.slot('永远不来的那块')
    const b = order.slot('后面那句')
    order.ready(b, true)
    expect(emit).not.toHaveBeenCalled()

    timer.fire()
    expect(emit.mock.calls.map(call => call[0])).toEqual(['后面那句'])
  })

  it('没人被压着就不起看门狗(不白转一只定时器)', () => {
    const timer = fakeTimer()
    const order = new SpeechOrder(vi.fn(), { stallMs: 100, setTimer: timer.setTimer })
    const a = order.slot('一句')
    order.ready(a, true)
    expect(timer.jobs).toHaveLength(0)
  })
})
