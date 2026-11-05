/**
 * 工人自己退(2026-10-10,通话组件孤儿进程):
 *   - 父进程(工作台)没了 → 离开房间、退出,不留下来和新工人抢同一个身份;
 *   - 收到 SIGTERM 之后**有时限**:收场挂住也要按时退出。
 */
import { describe, expect, it } from 'vitest'
import {
  EXIT_DEADLINE_MS,
  PARENT_CHECK_MS,
  createParentWatch,
  createShutdown,
  parentGone,
  parentPidOf,
} from '../src/lifeline.ts'

describe('parentGone', () => {
  it('父进程号没变、还活着 → 在', () => {
    expect(parentGone({ startPpid: 500, ppid: 500 })).toBe(false)
  })

  it('★被过继给 1 号进程 → 没了(工作台被 kickstart -k 硬杀就是这样)', () => {
    expect(parentGone({ startPpid: 500, ppid: 1 })).toBe(true)
  })

  it('父进程号变了 → 没了', () => {
    expect(parentGone({ startPpid: 500, ppid: 777 })).toBe(true)
  })

  it('一开始就挂在 1 号下面(将来装 launchd 项)→ 不算没了,不然一起来就退', () => {
    expect(parentGone({ startPpid: 1, ppid: 1 })).toBe(false)
  })

  it('工作台传进来的那个号已经不在了 → 没了(中间隔了一层壳时也认得出)', () => {
    expect(parentGone({ startPpid: 400, ppid: 400, expected: 500, expectedAlive: false })).toBe(true)
    expect(parentGone({ startPpid: 400, ppid: 400, expected: 500, expectedAlive: true })).toBe(false)
  })
})

describe('parentPidOf', () => {
  it('读 WORKBENCH_CHANNEL_PARENT_PID;没有或不是正整数就缺席', () => {
    expect(parentPidOf({ WORKBENCH_CHANNEL_PARENT_PID: '6983' })).toBe(6983)
    expect(parentPidOf({})).toBeUndefined()
    expect(parentPidOf({ WORKBENCH_CHANNEL_PARENT_PID: 'abc' })).toBeUndefined()
    expect(parentPidOf({ WORKBENCH_CHANNEL_PARENT_PID: '1' })).toBeUndefined()
    expect(parentPidOf({ WORKBENCH_CHANNEL_PARENT_PID: '0' })).toBeUndefined()
  })
})

describe('createParentWatch', () => {
  function harness(options: { expected?: number } = {}) {
    let ppid = 500
    let alive = true
    let tick: (() => void) | undefined
    let interval: number | undefined
    let cancelled = false
    const gone: string[] = []
    const watch = createParentWatch({
      readPpid: () => ppid,
      isAlive: () => alive,
      ...(options.expected === undefined ? {} : { expected: options.expected }),
      every: (ms, run) => { interval = ms; tick = run; return () => { cancelled = true } },
      onGone: reason => gone.push(reason),
    })
    return {
      watch,
      gone,
      interval: () => interval,
      cancelled: () => cancelled,
      tick: () => tick?.(),
      setPpid: (value: number) => { ppid = value },
      kill: () => { alive = false },
    }
  }

  it('按 PARENT_CHECK_MS 看一次;父进程在就不吭声', () => {
    const h = harness()
    h.watch.start()
    expect(h.interval()).toBe(PARENT_CHECK_MS)
    h.tick()
    expect(h.gone).toEqual([])
  })

  it('★被过继给 1 号 → 喊一次 onGone 并停表,之后不再喊', () => {
    const h = harness()
    h.watch.start()
    h.setPpid(1)
    h.tick()
    h.tick()
    expect(h.gone).toHaveLength(1)
    expect(h.gone[0]).toContain('500')
    expect(h.cancelled()).toBe(true)
  })

  it('传了工作台进程号:那个号没了也算', () => {
    const h = harness({ expected: 500 })
    h.watch.start()
    h.kill()
    h.tick()
    expect(h.gone).toHaveLength(1)
  })
})

describe('createShutdown', () => {
  function harness(close: () => Promise<void>) {
    const exits: number[] = []
    const timers: { ms: number, run: () => void }[] = []
    const lines: string[] = []
    const shutdown = createShutdown({
      close,
      exit: code => exits.push(code),
      after: (ms, run) => { timers.push({ ms, run }) },
      log: line => lines.push(line),
    })
    return { shutdown, exits, timers, lines }
  }

  it('收场做完就以 0 退出', async () => {
    const h = harness(async () => {})
    h.shutdown('SIGTERM')
    await Promise.resolve()
    await Promise.resolve()
    expect(h.exits).toEqual([0])
  })

  it('★收场挂住(session.close / room.disconnect 不回来)→ 到点照样退出,日志说清', () => {
    const h = harness(() => new Promise<void>(() => {}))
    h.shutdown('SIGTERM')
    expect(h.exits).toEqual([])
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0]?.ms).toBe(EXIT_DEADLINE_MS)
    h.timers[0]?.run()
    expect(h.exits).toEqual([1])
    expect(h.lines.join('\n')).toContain('没收完')
  })

  it('收场抛了也退出', async () => {
    const h = harness(async () => { throw new Error('断不开') })
    h.shutdown('SIGTERM')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.exits).toEqual([0])
  })

  it('★第二次喊退出 → 当场退,不再等', () => {
    const h = harness(() => new Promise<void>(() => {}))
    h.shutdown('SIGTERM')
    h.shutdown('SIGTERM')
    expect(h.exits).toEqual([1])
  })

  it('时限比工作台那边的「等一会儿再 SIGKILL」短', () => {
    expect(EXIT_DEADLINE_MS).toBeLessThanOrEqual(3000)
  })
})
