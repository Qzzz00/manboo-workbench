// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { calendarCommand, createCalendarSampler, parseCalendarOutput } from '../src/server/calendar.ts'

// 输出格式(标题|YYYY-M-D)取自 §R3 实测记录的字段语义(summary + 拆开的 year/month/day)，
// 不是编的样例。§R3 实测真实抓到过 "Spirit Festival | Thursday, 27 August 2026" 这类事件——
// 这里换算成本模块要求的机读格式来验证解析。
const REAL_LINE = 'Spirit Festival|2026-8-27'

describe('parseCalendarOutput(§R3 输出格式)', () => {
  it('单行"标题|YYYY-M-D" → 一条事件，月/日补零', () => {
    expect(parseCalendarOutput(REAL_LINE)).toEqual([{ date: '2026-08-27', title: 'Spirit Festival' }])
  })

  it('多行 → 多条事件，保留原始出现顺序', () => {
    const out = 'A|2026-8-21\nB|2026-08-05\n'
    expect(parseCalendarOutput(out)).toEqual([
      { date: '2026-08-21', title: 'A' },
      { date: '2026-08-05', title: 'B' },
    ])
  })

  it('空输出(近 7 天没有任何事件，§R3 实测真实出现过) → 空数组，不是错误', () => {
    expect(parseCalendarOutput('')).toEqual([])
    expect(parseCalendarOutput('   \n  ')).toEqual([])
  })

  it('单行格式不认识就跳过那一行，不让一条脏数据拖垮整批(不整体报错)', () => {
    const out = '这一行没有分隔符\nOK|2026-8-1\n'
    expect(parseCalendarOutput(out)).toEqual([{ date: '2026-08-01', title: 'OK' }])
  })
})

describe('calendarCommand(§R3 命令构造)', () => {
  it('是 osascript，用 -e 逐行传，且引用了 Calendar 应用', () => {
    const cmd = calendarCommand()
    expect(cmd[0]).toBe('osascript')
    expect(cmd.filter(part => part === '-e').length).toBeGreaterThan(5)
    expect(cmd.join(' ')).toContain('tell application "Calendar"')
  })
})

describe('createCalendarSampler(D13:失败绝不编数)', () => {
  it('run 返回 R3 格式输出 → 解析出 events', async () => {
    const run = async () => ({ ok: true, stdout: REAL_LINE })
    const sample = await createCalendarSampler(run, () => 0)()
    expect(sample).toEqual({ events: [{ date: '2026-08-27', title: 'Spirit Festival' }] })
  })

  it('run 失败(osascript 挂了/超时/未授权) → { error }，不编数', async () => {
    const run = async () => ({ ok: false, stdout: '' })
    const sample = await createCalendarSampler(run, () => 0)()
    expect(sample).toEqual({ error: expect.stringContaining('osascript') as unknown as string })
  })

  it('缓存命中(min interval 内)不重发命令；过了间隔才重新采一轮', async () => {
    let calls = 0
    const run = async () => {
      calls += 1
      return { ok: true, stdout: REAL_LINE }
    }
    let now = 1000
    const sampler = createCalendarSampler(run, () => now, 300)

    await sampler()
    expect(calls).toBe(1)

    now += 200 // 200s < 300s，应该直接回缓存
    await sampler()
    expect(calls).toBe(1)

    now += 101 // 累计 301s > 300s，重新采一轮
    await sampler()
    expect(calls).toBe(2)
  })

  it('错误结果同样进缓存，不因为上次失败就在窗口内被重新触发', async () => {
    let calls = 0
    const run = async () => {
      calls += 1
      return { ok: false, stdout: '' }
    }
    let now = 0
    const sampler = createCalendarSampler(run, () => now, 300)
    await sampler()
    now += 100
    const second = await sampler()
    expect(calls).toBe(1)
    expect(second).toEqual({ error: expect.stringContaining('osascript') as unknown as string })
  })
})
