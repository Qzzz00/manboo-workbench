// @vitest-environment node
/**
 * createMachineSampler 的缓存行为单测(终审 F4)。
 *
 * 同构的 calendar sampler(tests/calendar.test.ts)、badges sampler(tests/server-badges.test.ts)
 * 都有直接单测,唯独 machine 缺——server-projects-http.test.ts 里的用例只测了路由管线,
 * 喂的是内联假 sampler,没有真正调用 createMachineSampler 本体。这里补齐,测法照抄同一套模式。
 */
import { describe, expect, it } from 'vitest'
import { createMachineSampler } from '../src/server/machine.ts'

/** df / top / sysctl 都答一份合法输出,便于只关注缓存行为而不是解析细节。 */
function fakeRun() {
  return async (cmd: readonly string[]) => {
    if (cmd[0] === 'df') {
      return {
        ok: true,
        stdout: 'Filesystem   1024-blocks      Used Available Capacity iused    ifree %iused  Mounted on\n'
          + '/dev/disk3s5   482797652 438698808   8080660    62% 4199019 80806600    5%   /System/Volumes/Data',
      }
    }
    if (cmd[0] === 'top') return { ok: true, stdout: '54.30% idle' }
    if (cmd[0] === 'sysctl') return { ok: true, stdout: '17179869184' }
    return { ok: false, stdout: '' }
  }
}

describe('createMachineSampler(§6:60s 最短间隔缓存，不得靠 setInterval)', () => {
  it('60 秒内第二次调用直接回缓存,不重发 df/top/sysctl', async () => {
    let calls = 0
    const run = async (cmd: readonly string[]) => {
      calls += 1
      return fakeRun()(cmd)
    }
    let now = 1000
    const sampler = createMachineSampler(run, () => now, 60)

    const first = await sampler()
    const callsAfterFirst = calls
    expect(callsAfterFirst).toBe(3) // df + top + sysctl

    now += 30
    const second = await sampler()
    expect(calls).toBe(callsAfterFirst) // 30s < 60s，应该直接回缓存
    expect(second).toEqual(first)

    now += 31 // 累计 61s > 60s，重新采一轮
    await sampler()
    expect(calls).toBeGreaterThan(callsAfterFirst)
  })

  it('错误结果同样进缓存，不因为上次失败就在窗口内被重新触发一轮进程开销', async () => {
    let calls = 0
    const run = async () => {
      calls += 1
      return { ok: false, stdout: '' }
    }
    let now = 0
    const sampler = createMachineSampler(run, () => now, 60)

    const first = await sampler()
    expect(first).toEqual({ error: 'df 失败' })
    expect(calls).toBe(1)

    now += 30
    const second = await sampler()
    expect(calls).toBe(1)
    expect(second).toEqual({ error: 'df 失败' })
  })

  it('single-flight：冷启动时并发调用只触发一轮 df/top/sysctl，不是各起各的', async () => {
    // 2026-08-21 真机实测：重启后展示台 1 秒轮询 /state，首个请求超过 5 秒才响应——
    // 根因是缓存"采完才写入"，冷启动那几个并发请求各自发现缓存是空的、各自起一轮。
    let calls = 0
    const run = async (cmd: readonly string[]) => {
      calls += 1
      return fakeRun()(cmd)
    }
    const sampler = createMachineSampler(run, () => 1000, 60)

    // 不等第一个 sampler() 落地就发第二个——模拟冷启动那几个并发 GET /state。
    const [first, second] = await Promise.all([sampler(), sampler()])

    expect(calls).toBe(3) // 只有一轮 df + top + sysctl，不是 6 次
    expect(second).toEqual(first)
  })
})
