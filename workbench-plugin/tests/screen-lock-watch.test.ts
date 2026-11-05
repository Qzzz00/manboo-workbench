// @vitest-environment node
/**
 * ★ **问壳「这一刻锁着屏没有」那一拍**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
 *
 * 它挂在 http 那根既有的 1 秒节拍上,所以这里钉的是**内部限频**与**三条纪律**:
 * ① 「不知道」不许当成「锁着」,也不许把上一次知道的抹掉;
 * ② 解锁那一下**重送一轮**,而且一次只跑一轮;
 * ③ 刚起服务第一次问出来是「没锁」也要重送一次 —— 盘上那本队可能是上一回锁屏时排下的。
 */
import { describe, expect, it } from 'vitest'
import {
  SCREEN_LOCK_LOG_LOCKED,
  SCREEN_LOCK_LOG_UNLOCKED,
  SCREEN_LOCK_POLL_MS,
  createScreenLockWatch,
} from '../src/server/screenLockWatch.ts'

function harness(answers: readonly (boolean | undefined)[] | (() => Promise<boolean | undefined>)) {
  const clock = { value: 1_000_000 }
  const asked: number[] = []
  const drains: number[] = []
  const lines: string[] = []
  let at = 0
  const watch = createScreenLockWatch({
    ask: async () => {
      asked.push(clock.value)
      if (typeof answers === 'function') return await answers()
      const one = answers[Math.min(at, answers.length - 1)]
      at += 1
      return one
    },
    drain: async () => { drains.push(clock.value); return { kept: 0 } },
    now: () => clock.value,
    warn: line => lines.push(line),
  })
  return { watch, clock, asked, drains, lines }
}

describe('限频:挂在 1 秒节拍上,内部 3 秒一问', () => {
  it('★第一拍就问(起服务那一下要尽快知道)', async () => {
    const h = harness([false])
    await h.watch.pump()
    expect(h.asked).toHaveLength(1)
  })

  it('★★没到点的那几拍一个 op 都不发', async () => {
    const h = harness([false, false])
    await h.watch.pump()
    h.clock.value += SCREEN_LOCK_POLL_MS - 1
    await h.watch.pump()
    expect(h.asked).toHaveLength(1)
    h.clock.value += 2
    await h.watch.pump()
    expect(h.asked).toHaveLength(2)
  })
})

describe('「不知道」那几种', () => {
  it('★★还没问到 → locked() 是 undefined(窗口那一层据此照旧送)', () => {
    expect(harness([undefined]).watch.locked()).toBeUndefined()
  })

  it('★问不到(老壳 / 壳没连上 / 这一拍抛了)→ 一格都不改', async () => {
    const h = harness([true, undefined])
    await h.watch.pump()
    expect(h.watch.locked()).toBe(true)
    h.clock.value += SCREEN_LOCK_POLL_MS
    await h.watch.pump()
    // ★ 不许把一次锁屏抹成「不知道」→ 否则窗口那一层照旧送 → 又是 09:04 那一幕
    expect(h.watch.locked()).toBe(true)
    expect(h.drains).toEqual([])
  })

  it('★那一拍抛了也不把节拍带走', async () => {
    const h = harness(async () => { throw new Error('壳响应超时') })
    await h.watch.pump()
    expect(h.watch.locked()).toBeUndefined()
  })
})

describe('锁 / 解锁那两下', () => {
  it('★★锁上了:记一行,**不重送**', async () => {
    const h = harness([true])
    await h.watch.pump()
    expect(h.watch.locked()).toBe(true)
    expect(h.lines).toEqual([SCREEN_LOCK_LOG_LOCKED])
    expect(h.drains).toEqual([])
  })

  it('★★解锁了:记一行 + 重送一轮', async () => {
    const h = harness([true, false])
    await h.watch.pump()
    h.clock.value += SCREEN_LOCK_POLL_MS
    await h.watch.pump()
    expect(h.watch.locked()).toBe(false)
    expect(h.lines).toEqual([SCREEN_LOCK_LOG_LOCKED, SCREEN_LOCK_LOG_UNLOCKED])
    expect(h.drains).toHaveLength(1)
  })

  it('★★刚起服务、第一次问出来就是没锁 → 也重送一次(盘上那本队可能是上一回排下的)', async () => {
    const h = harness([false])
    await h.watch.pump()
    expect(h.drains).toHaveLength(1)
  })

  it('★★本来就没锁的那几拍:一轮都不白跑', async () => {
    const h = harness([false, false, false])
    await h.watch.pump()
    h.clock.value += SCREEN_LOCK_POLL_MS
    await h.watch.pump()
    h.clock.value += SCREEN_LOCK_POLL_MS
    await h.watch.pump()
    expect(h.drains).toHaveLength(1)
  })

  it('★锁了又解、再锁再解 → 每次解锁各重送一轮', async () => {
    const h = harness([true, false, true, false])
    for (let i = 0; i < 4; i += 1) {
      await h.watch.pump()
      h.clock.value += SCREEN_LOCK_POLL_MS
    }
    expect(h.drains).toHaveLength(2)
  })

  it('★★上一轮还留着东西(被闸拦下 / 又锁上了)→ 下一拍接着来一轮,不等下一次锁 / 解锁', async () => {
    const clock = { value: 1_000_000 }
    const kept = [1, 1, 0]
    let at = 0
    const drains: number[] = []
    const watch = createScreenLockWatch({
      ask: async () => false,
      drain: async () => {
        drains.push(clock.value)
        const one = kept[Math.min(at, kept.length - 1)] as number
        at += 1
        return { kept: one }
      },
      now: () => clock.value,
      warn: () => {},
    })
    for (let i = 0; i < 4; i += 1) {
      await watch.pump()
      clock.value += SCREEN_LOCK_POLL_MS
    }
    // 第一拍(刚起服务)+ 两拍「还留着」各来一轮,第三轮报 0 之后就不再白跑
    expect(drains).toHaveLength(3)
  })

  it('★★重送那一轮抛了:记一行,下一次解锁照旧再试(不把 locked 留在错的那一格)', async () => {
    const clock = { value: 1_000_000 }
    const lines: string[] = []
    let locked = true
    const watch = createScreenLockWatch({
      ask: async () => locked,
      drain: async () => { throw new Error('重送炸了') },
      now: () => clock.value,
      warn: line => lines.push(line),
    })
    await watch.pump()
    locked = false
    clock.value += SCREEN_LOCK_POLL_MS
    await watch.pump()
    expect(watch.locked()).toBe(false)
    expect(lines.some(one => one.includes('重送那一轮出错'))).toBe(true)
  })
})
