import { describe, expect, it } from 'vitest'
import { collectCodexQuota, parseCodexQuota, pickLatestRateLimits, windowLabel } from '../src/quota/codex.ts'

/** 按 ~/.codex/sessions 里实际观察到的形状造行（2026-08-19 在本机核对过）。 */
/** 固定在重置之前：这些用例测的是换算，不是过期判断。 */
const BEFORE_RESET = new Date(1787196780 * 1000 - 3_600_000)

function line(used: number, minutes: number, resetsAt: number): string {
  return JSON.stringify({
    type: 'token_count',
    info: {
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: used, window_minutes: minutes, resets_at: resetsAt },
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: '0' },
        plan_type: 'prolite',
      },
    },
  })
}

describe('pickLatestRateLimits', () => {
  it('取最后一条 rate_limits——同一份 session 会反复写入，只有最后一条是现值', () => {
    const picked = pickLatestRateLimits([line(1, 10080, 1787196780), line(64, 10080, 1787196780)])

    expect(picked).toMatchObject({ primary: { used_percent: 64 } })
  })

  it('没有任何 rate_limits 时返回 undefined，交给调用方降级', () => {
    expect(pickLatestRateLimits(['{"type":"message"}', 'not json at all'])).toBeUndefined()
  })

  it('坏行不能让整份文件作废', () => {
    const picked = pickLatestRateLimits(['{ 半行坏 JSON', line(7, 10080, 1787196780), ''])

    expect(picked).toMatchObject({ primary: { used_percent: 7 } })
  })
})

describe('windowLabel', () => {
  it('把 window_minutes 翻成界面用的窗口名', () => {
    expect(windowLabel(300)).toBe('5h')
    expect(windowLabel(10080)).toBe('周')
    expect(windowLabel(43200)).toBe('月')
  })
})

describe('parseCodexQuota', () => {
  it('used_percent 换算成剩余，方向与 PRD §8.2 规则 1 一致', () => {
    const quota = parseCodexQuota({
      primary: { used_percent: 36, window_minutes: 10080, resets_at: 1787196780 },
    }, BEFORE_RESET)

    expect(quota.kind).toBe('quota')
    expect(quota.windows[0]).toMatchObject({ label: '周', left_pct: 64 })
  })

  it('额度真的用满时给 0，不能退化成"未接入"', () => {
    const quota = parseCodexQuota({
      primary: { used_percent: 100, window_minutes: 10080, resets_at: 1787196780 },
    }, BEFORE_RESET)

    expect(quota.windows[0]?.left_pct).toBe(0)
  })

  it('resets_at 转成 ISO 时间，界面据此显示何时恢复', () => {
    const quota = parseCodexQuota({
      primary: { used_percent: 100, window_minutes: 10080, resets_at: 1787196780 },
    }, BEFORE_RESET)

    expect(quota.windows[0]?.reset_at).toBe(new Date(1787196780 * 1000).toISOString())
  })

  it('primary 与 secondary 都在时按窗口从短到长排', () => {
    const quota = parseCodexQuota({
      primary: { used_percent: 10, window_minutes: 10080, resets_at: 1787196780 },
      secondary: { used_percent: 20, window_minutes: 300, resets_at: 1787100000 },
    }, BEFORE_RESET)

    expect(quota.windows.map(w => w.label)).toEqual(['5h', '周'])
  })

  it('两个窗口都为空时抛错，由调用方降级成 unknown——不编 0', () => {
    expect(() => parseCodexQuota({ primary: null, secondary: null })).toThrow()
  })
})

describe('collectCodexQuota', () => {
  // 故意让"文件名靠前"和"最近修改"指向不同的文件——真机上就是这样：
  // 他恢复一个早先创建的会话继续用，那份文件名靠后却一直在写。
  const io = {
    listSessionFiles: async () => [
      { path: 'z-新建但已停写.jsonl', mtimeMs: 1_000 },
      { path: 'a-早建但仍在写.jsonl', mtimeMs: 9_000 },
    ],
    readFile: async (file: string) =>
      (file === 'a-早建但仍在写.jsonl' ? line(64, 10080, 1787196780) : line(1, 10080, 1787196780)),
  }

  it('按最后修改时间找最近在写的那份，不看文件名', async () => {
    const quota = await collectCodexQuota({ codexHome: '/fake/.codex', io, now: BEFORE_RESET })

    expect(quota).toMatchObject({ kind: 'quota', windows: [{ label: '周', left_pct: 36 }] })
  })

  it('目录不存在时如实降级，不抛给上层', async () => {
    const quota = await collectCodexQuota({
      codexHome: '/fake/.codex',
      io: { listSessionFiles: async () => { throw new Error('ENOENT') }, readFile: async () => '' },
    })

    expect(quota.kind).toBe('unknown')
  })

  it('一份都没有额度记录时说明原因，而不是显示 0', async () => {
    const quota = await collectCodexQuota({
      codexHome: '/fake/.codex',
      io: {
        listSessionFiles: async () => [{ path: 'x.jsonl', mtimeMs: 1 }],
        readFile: async () => '{"type":"message"}',
      },
    })

    expect(quota).toMatchObject({ kind: 'unknown', note: expect.stringContaining('未找到') })
  })
})

describe('重置时间已过的旧读数', () => {
  const stale = { primary: { used_percent: 100, window_minutes: 10080, resets_at: 1787196780 } }

  it('窗口还没到点时照常给数', () => {
    const quota = parseCodexQuota(stale, new Date(1787196780 * 1000 - 60_000))

    expect(quota.windows[0]).toMatchObject({ left_pct: 0 })
  })

  it('已经过了重置时刻就不能再报 0%——那个数是重置前的，会让人以为还没恢复', () => {
    expect(() => parseCodexQuota(stale, new Date(1787196780 * 1000 + 60_000)))
      .toThrow(/重置|过期|陈/)
  })
})

describe('collectCodexQuota 对过期读数的处理', () => {
  it('降级成 unknown 并说明原因，而不是显示一个已经不成立的 0%', async () => {
    const line = JSON.stringify({
      info: { rate_limits: { primary: { used_percent: 100, window_minutes: 10080, resets_at: 1787196780 } } },
    })
    const quota = await collectCodexQuota({
      codexHome: '/fake/.codex',
      now: new Date(1787196780 * 1000 + 60_000),
      io: { listSessionFiles: async () => [{ path: 'a.jsonl', mtimeMs: 1 }], readFile: async () => line },
    })

    expect(quota).toMatchObject({ kind: 'unknown', note: expect.stringContaining('重置') })
  })
})
