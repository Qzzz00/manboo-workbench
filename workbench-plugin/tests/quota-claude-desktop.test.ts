import { describe, expect, it } from 'vitest'
import { CLAUDE_DESKTOP_GONE, claudeDesktopGoneNote, isClaudeDesktopGone } from '../src/protocol.ts'
import {
  defaultClaudeDesktopUsageFile,
  parseClaudeDesktopUsage,
  readClaudeDesktopUsage,
} from '../src/quota/claudeDesktop.ts'

/**
 * 形状取自真机上的 ~/Library/Application Support/Claude/plan-usage-history.json。
 * 这一条是 2026-08-20 19:39:48 的真实样本，与 Ben 客户端截图「5h 已用 74% / 周 已用 8%」对得上。
 */
const NOW = new Date('2026-08-20T11:45:00.000Z')
const SAMPLE_T = new Date('2026-08-20T11:39:48.000Z').getTime()

const history = {
  version: 2,
  samples: [
    { t: SAMPLE_T - 900_000, org: 'add5d0cf', u: { fh: 69, sd: 7 } },
    { t: SAMPLE_T, org: 'add5d0cf', u: { fh: 73, sd: 8 } },
  ],
}

describe('parseClaudeDesktopUsage', () => {
  it('取最新样本，fh/sd 换算成剩余百分比', () => {
    const quota = parseClaudeDesktopUsage(history, { now: NOW })

    expect(quota.kind).toBe('quota')
    expect(quota.windows).toEqual([
      { label: '5h', left_pct: 27 },
      { label: '周', left_pct: 92 },
    ])
  })

  it('样本乱序时仍然取时间最大的那条——文件是追加写的，但不假设它有序', () => {
    const shuffled = { version: 2, samples: [history.samples[1], history.samples[0]] }

    const quota = parseClaudeDesktopUsage(shuffled, { now: NOW })

    expect(quota.windows[0]).toEqual({ label: '5h', left_pct: 27 })
  })

  it('只读得出一个窗口时也出数——少一栏总比整格空掉强', () => {
    const quota = parseClaudeDesktopUsage(
      { samples: [{ t: SAMPLE_T, u: { fh: 10 } }] },
      { now: NOW },
    )

    expect(quota.windows).toEqual([{ label: '5h', left_pct: 90 }])
  })

  it('浮点不留 91.99999999999999 这种尾巴', () => {
    const quota = parseClaudeDesktopUsage(
      { samples: [{ t: SAMPLE_T, u: { sd: 0.1 } }] },
      { now: NOW },
    )

    expect(quota.windows[0]?.left_pct).toBe(99.9)
  })

  it('空闲时采样会变稀，隔个把小时不算过期——那时候数字本来就没在变', () => {
    // 真机上抓到过 08:14→08:59 整整 45 分钟的间隔，比这更稀的也有。
    // 门槛卡太紧的话，界面会在人没干活的时候无缘无故闪成"未接入"。
    const idle = new Date(SAMPLE_T + 70 * 60 * 1000)

    const quota = parseClaudeDesktopUsage(history, { now: idle })

    expect(quota.windows[0]).toEqual({ label: '5h', left_pct: 27 })
  })

  /**
   * 话术 2026-09-26(卡 QS)改成人话:这句错误会**原样上界面**(那一格的 note,展示台也显示),
   * 「过期」「用量记录已过期」是内部词。
   *
   * ★ 2026-10-03 再改一次(维护者:「Claude 额度格如实显示『Claude 桌面端没再提供』不再追」):
   * 句子搬到 `protocol.ts` 的 `claudeDesktopGoneNote`(界面层要**认出这一种**好把大字从
   * 「未接入」换成实话,见 client/quotaCells.ts),岁数从分钟改成小时。
   * **断言读的是导出的常量,不逐字抄中文。**
   * (「读不到新的数不等于这家没接上」那一半在 tests/quota-stale-keeps-numbers.test.ts;
   * 「大字不写未接入」那一半在 tests/client-quota-claude-desktop-gone.test.ts。)
   */
  it('旧到以小时计才算桌面端没再提供用量记录——话说成人话,不写「过期」', () => {
    const dead = new Date(SAMPLE_T + 3 * 60 * 60 * 1000)

    expect(() => parseClaudeDesktopUsage(history, { now: dead })).toThrow(CLAUDE_DESKTOP_GONE)
    expect(() => parseClaudeDesktopUsage(history, { now: dead })).not.toThrow(/过期/)
    // 岁数以小时写(918 分钟前要她自己心算)。
    expect(() => parseClaudeDesktopUsage(history, { now: dead })).toThrow('最后一次 3 小时前')
  })

  it('那条线可以调', () => {
    const stale = new Date(SAMPLE_T + 30 * 60 * 1000)

    expect(() => parseClaudeDesktopUsage(history, { now: stale, maxAgeMs: 10 * 60 * 1000 }))
      .toThrow(CLAUDE_DESKTOP_GONE)
  })

  it('那句话是 protocol.ts 那一个拼的(一份字两头读,不各写一份)', () => {
    expect(claudeDesktopGoneNote(3 * 60 * 60 * 1000)).toBe(`${CLAUDE_DESKTOP_GONE}(最后一次 3 小时前)`)
    // 不满一小时按 1 小时写(这条线是 2 小时,走不到这儿,留着兜底)。
    expect(claudeDesktopGoneNote(10 * 60 * 1000)).toBe(`${CLAUDE_DESKTOP_GONE}(最后一次 1 小时前)`)
    expect(isClaudeDesktopGone(claudeDesktopGoneNote(3 * 60 * 60 * 1000))).toBe(true)
    expect(isClaudeDesktopGone('这次没取到')).toBe(false)
    expect(isClaudeDesktopGone(undefined)).toBe(false)
  })

  it('样本里的窗口值不是数字时跳过，不猜也不补 0', () => {
    expect(() => parseClaudeDesktopUsage(
      { samples: [{ t: SAMPLE_T, u: { fh: '73', sd: null } }] },
      { now: NOW },
    )).toThrow(/没有可用窗口/)
  })

  it('没有 samples 时抛错', () => {
    expect(() => parseClaudeDesktopUsage({ version: 2 }, { now: NOW })).toThrow(/没有 samples/)
  })

  it('org 之类的标识不进结果——这份数据要推给展示台', () => {
    const quota = parseClaudeDesktopUsage(history, { now: NOW })

    expect(JSON.stringify(quota)).not.toContain('add5d0cf')
  })
})

describe('readClaudeDesktopUsage', () => {
  it('读得到就出数', async () => {
    const quota = await readClaudeDesktopUsage({
      now: NOW,
      file: '/somewhere/plan-usage-history.json',
      io: { readFile: async () => JSON.stringify(history) },
    })

    expect(quota.windows[0]).toEqual({ label: '5h', left_pct: 27 })
  })

  it('文件读不到时把话说清楚，不抛原始 ENOENT', async () => {
    await expect(readClaudeDesktopUsage({
      now: NOW,
      io: { readFile: async () => { throw new Error('ENOENT') } },
    })).rejects.toThrow(/没装或没跑过/)
  })

  it('文件不是合法 JSON 时抛错', async () => {
    await expect(readClaudeDesktopUsage({
      now: NOW,
      io: { readFile: async () => '{ 半行' },
    })).rejects.toThrow(/不是合法 JSON/)
  })
})

describe('defaultClaudeDesktopUsageFile', () => {
  it('按 HOME 推出桌面端的记录位置（路径里带空格，交给 fs 而不是 shell）', () => {
    expect(defaultClaudeDesktopUsageFile('/Users/example'))
      .toBe('/Users/example/Library/Application Support/Claude/plan-usage-history.json')
  })
})
