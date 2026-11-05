// @vitest-environment node
/**
 * 机器 / 角标 / 日历三格**到点重采时不让那一拍 `/state` 干等**(2026-10-21 急修「8791 空转」)。
 *
 * 原来缓存过期之后,恰好碰上的那一次 `/state` 要现场等 `df` + `top -l 1` + `sysctl`(机器那一格,60 秒一回)、
 * `osascript`(日历,5 分钟一回,最长 60 秒超时)跑完才回。维护者那台机器一忙,`top` 就要好几秒 ——
 * 隔离实例上每 60 秒一次 `/state` 1 秒,碰上忙的时候 7.8 秒,网页那一拍整个停住。
 *
 * 钉三件事(三格同一套):
 *   ① 头一回没有上一份 → 照旧等它采完(不编一个空的);
 *   ② 过期了 → 当场回上一份,后台补采;补采完了下一拍就是新的;
 *   ③ 补采还在跑时又来几次 → 都回上一份,只补采一轮。
 */
import { describe, expect, it } from 'vitest'
import { createBadgesSampler } from '../src/server/badges.ts'
import { createCalendarSampler } from '../src/server/calendar.ts'
import { createMachineSampler } from '../src/server/machine.ts'

type Run = (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>

/** 一个能卡住的命令行:`hold()` 之后发出去的命令都挂着,直到 `release()`。 */
function gatedRun(answer: (cmd: readonly string[], round: number) => string): { run: Run, hold: () => void, release: () => void, calls: () => number, round: () => void } {
  let held: (() => void)[] | undefined
  let calls = 0
  let round = 0
  const run: Run = async (cmd) => {
    calls += 1
    if (held !== undefined) await new Promise<void>(resolve => held?.push(resolve))
    return { ok: true, stdout: answer(cmd, round) }
  }
  return {
    run,
    hold: () => { held = [] },
    release: () => { const list = held ?? []; held = undefined; for (const go of list) go() },
    calls: () => calls,
    round: () => { round += 1 },
  }
}

function machineAnswer(cmd: readonly string[], round: number): string {
  if (cmd[0] === 'df') {
    return 'Filesystem   1024-blocks      Used Available Capacity iused    ifree %iused  Mounted on\n'
      + '/dev/disk3s5   482797652 438698808   8080660    62% 4199019 80806600    5%   /System/Volumes/Data'
  }
  if (cmd[0] === 'top') return `${round === 0 ? '54.30' : '12.00'}% idle`
  return '17179869184'
}

/** 让后台那一轮把所有 then 跑完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const cases = [
  {
    name: '机器那一格',
    make: (run: Run, now: () => number) => createMachineSampler(run, now, 60),
    answer: machineAnswer,
    pick: (sample: unknown) => (sample as { cpu_idle_pct?: number }).cpu_idle_pct,
    first: 54.3, next: 12,
  },
  {
    name: '日历',
    make: (run: Run, now: () => number) => createCalendarSampler(run, now, 60),
    answer: (_cmd: readonly string[], round: number) => (round === 0 ? 'A|2026-10-21' : 'B|2026-10-22'),
    pick: (sample: unknown) => (sample as { events: { title: string }[] }).events[0]?.title,
    first: 'A', next: 'B',
  },
  {
    name: '角标',
    make: (run: Run, now: () => number) => createBadgesSampler(run, now, 60),
    answer: (cmd: readonly string[], round: number) => (cmd.includes('pid') ? '"pid"=1' : `"StatusLabel"={ "label"="${round === 0 ? 1 : 7}" }`),
    pick: (sample: unknown) => Object.values(sample as Record<string, number | null>)[0],
    first: 1, next: 7,
  },
] as const

describe.each(cases)('$name:到点重采不让那一拍干等', ({ make, answer, pick, first, next }) => {
  it('★头一回照旧等;过期了当场回上一份、后台补采,补采完了下一拍是新的', async () => {
    const gate = gatedRun(answer)
    let now = 1000
    const sampler = make(gate.run, () => now)
    expect(pick(await sampler())).toBe(first)

    now += 61
    gate.round()
    gate.hold()
    let answered = false
    const stale = sampler().then((sample) => { answered = true; return sample })
    await settle()
    // 命令还卡着,这一拍已经回了上一份。
    expect(answered).toBe(true)
    expect(pick(await stale)).toBe(first)

    gate.release()
    await settle()
    expect(pick(await sampler())).toBe(next)
  })

  it('补采还在跑时又来几次:都回上一份,只补采一轮', async () => {
    const gate = gatedRun(answer)
    let now = 1000
    const sampler = make(gate.run, () => now)
    await sampler()
    const perRound = gate.calls()

    now += 61
    gate.round()
    gate.hold()
    const many = await Promise.all([sampler(), sampler(), sampler()])
    expect(many.map(sample => pick(sample as unknown))).toEqual([first, first, first])
    gate.release()
    await settle()
    expect(gate.calls()).toBe(perRound * 2)
  })
})
