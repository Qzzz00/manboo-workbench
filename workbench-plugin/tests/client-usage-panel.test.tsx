/**
 * 「消耗数据」那一格的面板。
 *
 * ★ 2026-10-03:面板本体是**运营同学(Air)自己写的那一份**
 * (`user-layer/起步/小组件/usage/index.js`,原件 `contrib/air-20261002/src/usage.js`)。
 * 维护者当日原话:「有现成的代码不用,非要去重新开发……你就把他之前的代码,原封不动在下一次更新里替换进去。」
 *
 * 她那一版自己算近 7 / 30 天 / 全部、自己画按日柱状与占比条、自己写「豆包办公 · 未接入用量」;
 * 上一版那一整块(三标签页 + stat tile 网格 + 年度热力图 + 项目/模型排行 + 缓存与习惯 +
 * 「计算口径」那一折)整个被替掉了,所以上一版那 8 条用例(以及 client-usage-heatmap 那一份)
 * 断言的都是**已经不存在的做法** —— 删了,列在
 * docs/交接-1003-运营同学六组件原封接入.md 的「她那一版没有的」里。
 *
 * 这一份守的是她那一版真正在守的事:
 * - **不接入就不编数**:读不到写「暂未读取」/ 服务端那句 error,不写 0;
 * - **豆包办公写一句话,不写 0**,而且明说不计入合计;
 * - 一家读取失败时如实标出来,已有的数字说清是历史记录;
 * - 范围按钮按**北京时间**切(她那一版的归日口径);
 * - `formatTokens`(本体那一个量级收整,她 import 的就是它)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { UsageState } from '../src/protocol.ts'
import { formatTokens } from '../src/client/UsagePanel.tsx'
import { starterWidget } from './helpers/starterLayer.ts'

// 2026-10-21:这几格搬进了用户层(`user-layer/起步/小组件/`),经本体的加载口装出来。
const UsagePanel = starterWidget('usage')

afterEach(cleanup)

function day(date: string, input: number, cacheRead = 0, source = 'codex'): UsageState['days'][number] {
  const totals = { input, output: 0, cache_read: cacheRead, cache_write: 0 }
  return {
    date,
    by_project: { Aiboo: totals },
    by_model: { 'gpt-5-codex': totals },
    by_source: { [source]: totals },
    sessions: 1,
    messages: 1,
    hour_counts: {},
  }
}

const USAGE: UsageState = {
  days: [{
    date: '2026-09-01',
    by_project: {
      Aiboo: { input: 400_000_000, output: 100_000_000, cache_read: 5_400_000_000, cache_write: 700_000_000 },
    },
    by_model: {
      'gpt-5-codex': { input: 400_000_000, output: 100_000_000, cache_read: 5_400_000_000, cache_write: 700_000_000 },
    },
    by_source: {
      codex: { input: 400_000_000, output: 100_000_000, cache_read: 5_400_000_000, cache_write: 700_000_000 },
    },
    sessions: 3,
    messages: 12,
    hour_counts: {},
  }],
  sources: { codex: { status: 'ok' } },
  scanned_at: '2026-09-02T00:00:00Z',
}

/** 她那一版多收一个 `now`:「今天是哪天」按它算(北京时间),不读时钟。 */
const NOW = '2026-09-02T10:00:00+08:00'

describe('她那一格的骨架', () => {
  it('口径那一句写在最上面(本机留存日志 · 北京时间),不自己编一个口径', () => {
    render(<UsagePanel usage={USAGE} now={NOW} />)
    expect(screen.getByText('AI 创作投入 · 本机留存日志 · 北京时间')).toBeInTheDocument()
  })

  it('已记录用量 = 四项全加(含缓存读),量级按 formatTokens 收整', () => {
    render(<UsagePanel usage={USAGE} now={NOW} />)
    // 4亿 + 1亿 + 54亿 + 7亿 = 66 亿
    expect(document.querySelector('.cu-hero strong')?.textContent).toBe(formatTokens(6_600_000_000))
    expect(document.querySelector('.cu-hero strong')?.textContent).toBe('6.6B')
  })

  it('三档范围按钮,默认亮着「近 7 天」', () => {
    render(<UsagePanel usage={USAGE} now={NOW} />)
    expect([...document.querySelectorAll('.cu-bar button')].map(node => node.textContent))
      .toEqual(['近 7 天', '近 30 天', '全部记录', '放大查看'])
    expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('★切到「近 7 天」之外的那一天真的被切掉了(不是摆设)', () => {
    const days = [day('2026-08-20', 1_000_000_000), day('2026-09-01', 100_000_000)]
    render(<UsagePanel usage={{ ...USAGE, days }} now={NOW} />)
    // 近 7 天:8-20 那一天不在里面。
    expect(document.querySelector('.cu-hero strong')?.textContent).toBe('100.0M')
    fireEvent.click(screen.getByRole('button', { name: '全部记录' }))
    expect(document.querySelector('.cu-hero strong')?.textContent).toBe('1.1B')
  })

  it('按日那张柱状图只摆**有记录的**那几天', () => {
    const days = [day('2026-08-31', 10), day('2026-09-01', 20)]
    render(<UsagePanel usage={{ ...USAGE, days }} now={NOW} />)
    expect([...document.querySelectorAll('.cu-day small')].map(node => node.textContent))
      .toEqual(['08-31', '09-01'])
    expect(screen.getByText('仅展示有记录的日期；条高代表已记录 Tokens，包含缓存读取。')).toBeInTheDocument()
  })

  it('这段时间一天记录都没有:说出来,不画一张空图', () => {
    render(<UsagePanel usage={{ ...USAGE, days: [day('2026-01-01', 10)] }} now={NOW} />)
    expect(screen.getByText('这段时间还没有用量日志。')).toBeInTheDocument()
    expect(document.querySelector('.cu-chart')).toBeNull()
  })
})

describe('★ 不接入就不编数', () => {
  it.each([undefined, { error: '暂时无法读取' }])('读不到时大字写「暂未读取」,不写 0:%j', (usage) => {
    render(<UsagePanel usage={usage} now={NOW} />)
    expect(document.querySelector('.cu-hero strong')?.textContent).toBe('暂未读取')
    // 服务端给了原因就说原因,没给就说「用量日志还未接入。」——界面不编第二句。
    expect(screen.getByRole('status').textContent).toBe(usage?.error ?? '用量日志还未接入。')
  })

  /*
   * ★ 2026-10-04 改口径(维护者当天拍板,运营同学交回的那一版):这一格上**不再摆没有 token 来源的家**
   * ——「豆包办公 未接入用量」那一格与占比下面「豆包办公尚未纳入」那半句都删了。
   * 产品研发那一版面板(`UsagePanel.tsx`)照旧摆它,`USAGE_NOT_WIRED_FAMILIES` 那份表没动。
   */
  it('★没有 token 来源的那几家不在这一格上(10-04 起);合计照旧不受影响', () => {
    render(<UsagePanel usage={USAGE} now={NOW} />)
    const tools = [...document.querySelectorAll('.cu-tool')] as HTMLElement[]
    expect(tools.find(node => node.textContent?.includes('豆包办公'))).toBeUndefined()
    expect(screen.queryByText('未接入用量')).toBeNull()
    expect(document.querySelector('.creator-usage')?.textContent).not.toContain('豆包办公尚未纳入')
    // 合计一个字没变:66 亿还是 66 亿。
    expect(document.querySelector('.cu-hero strong')?.textContent).toBe('6.6B')
  })

  it('采集器名册里有、这段时间一条都没数到:写「本时段无用量记录」,不写「未接入」也不写 0', () => {
    render(<UsagePanel usage={{ ...USAGE, sources: { codex: { status: 'ok' }, dsh: { status: 'ok' } } }} now={NOW} />)
    const tools = [...document.querySelectorAll('.cu-tool')] as HTMLElement[]
    const dsh = tools.find(node => node.textContent?.includes('DeepSeek')) as HTMLElement
    expect(dsh.textContent).toContain('本时段无用量记录')
  })

  it('只在历史数里出现、采集器名册里没有的那一家:写「未接入」,不写 0', () => {
    // sources 里只有 codex,可 days 里有 dsh 的数 —— 那一家的数留着,状态如实说"没在数了"。
    render(<UsagePanel usage={{ ...USAGE, days: [day('2026-09-01', 1_000, 0, 'dsh')], sources: { codex: { status: 'ok' } } }} now={NOW} />)
    const tools = [...document.querySelectorAll('.cu-tool')] as HTMLElement[]
    const dsh = tools.find(node => node.textContent?.includes('DeepSeek')) as HTMLElement
    expect(within(dsh).getByText('未接入')).toBeInTheDocument()
  })

  it('读取失败那一家如实标出来,已有的数字说清是历史记录', () => {
    const usage: UsageState = {
      ...USAGE,
      days: [day('2026-09-01', 1_000, 0, 'dsh')],
      sources: { codex: { status: 'error', note: '日志读不了' }, dsh: { status: 'ok' } },
    }
    render(<UsagePanel usage={usage} now={NOW} />)
    const tools = [...document.querySelectorAll('.cu-tool')] as HTMLElement[]
    const codex = tools.find(node => node.textContent?.includes('Codex')) as HTMLElement
    expect(within(codex).getByText('读取失败')).toBeInTheDocument()
    expect(codex.textContent).toContain('读取失败，已有数字为历史记录')
    // 那一家的 note 原样贴在「用量构成与统计范围」那一折里。
    expect(screen.getByText('Codex：日志读不了')).toBeInTheDocument()
  })

  it('合起来是 0 的时候占比那一列说「暂无占比」,不画一个假的 100%', () => {
    render(<UsagePanel usage={{ ...USAGE, days: [] }} now={NOW} />)
    expect(screen.getAllByText('暂无占比').length).toBeGreaterThan(0)
  })
})

describe('用量构成与统计范围那一折', () => {
  it('四项构成各自成行,缓存读取单独一行(不混进别的数)', () => {
    render(<UsagePanel usage={USAGE} now={NOW} />)
    const rows: readonly [string, string][] = [
      ['新增输入', '400.0M'], ['生成输出', '100.0M'], ['缓存读取', '5.4B'], ['缓存写入', '700.0M'],
    ]
    for (const [name, value] of rows) {
      const row = [...document.querySelectorAll('.cu-row')].find(node => node.textContent?.startsWith(name))
      expect(row?.textContent, name).toContain(value)
    }
  })

  it('说清这份数不等于账单,也不等于账号全端用量', () => {
    render(<UsagePanel usage={USAGE} now={NOW} />)
    expect(screen.getByText(/不等于账号全端用量或实际账单/)).toBeInTheDocument()
    expect(screen.getByText(/不能据此直接计算费用/)).toBeInTheDocument()
  })

  it('没扫过就说「未扫描」,不编一个时间', () => {
    const usage: UsageState = { ...USAGE, days: [day('2026-09-01', 1)] }
    delete (usage as { scanned_at?: unknown }).scanned_at
    render(<UsagePanel usage={usage} now={NOW} />)
    expect(screen.getByText('最近扫描：未扫描')).toBeInTheDocument()
  })
})

describe('formatTokens(本体那一个,他 import 的就是它)', () => {
  it('按 B / M / K 收整,个位数直接写', () => {
    expect(formatTokens(6_600_000_000)).toBe('6.6B')
    expect(formatTokens(700_000_000)).toBe('700.0M')
    expect(formatTokens(1_200)).toBe('1.2K')
    expect(formatTokens(7)).toBe('7')
  })
})

/**
 * ★ 2026-10-03:**摆哪几家由数据说了算,不写死**。
 * 维护者:「我看到他的现在消耗数据应该是他机器的,不是我的……显示哪些模型也是写死的。」
 */
describe('★ 摆哪几家:读本机真实采集,不写死', () => {
  /** 维护者机器上采集器名册真正的那三家(usage/collector.ts 的 sources)。 */
  const THREE: UsageState = {
    ...USAGE,
    days: [day('2026-09-01', 300, 0, 'claude'), day('2026-09-01', 200, 0, 'codex')],
    sources: { claude: { status: 'ok' }, codex: { status: 'ok' }, dsh: { status: 'ok' } },
  }

  it('★ Claude 不再被漏掉:采集器名册里有的每一家都有一格', () => {
    render(<UsagePanel usage={THREE} now={NOW} />)
    const tools = [...document.querySelectorAll('.cu-tool')].map(node => node.textContent ?? '')
    for (const name of ['Claude', 'Codex', 'DeepSeek']) {
      expect(tools.some(text => text.includes(name)), name).toBe(true)
    }
  })

  it('那一家的数真的算进合计里(不是摆一个空格子)', () => {
    render(<UsagePanel usage={THREE} now={NOW} />)
    // 300 + 200,两家都算上。
    expect(document.querySelector('.cu-hero strong')?.textContent).toBe('500')
  })

  it('「几项工具可读取」的分母也是数出来的,不是写死的 3', () => {
    render(<UsagePanel usage={THREE} now={NOW} />)
    // 2026-10-04 起分母就是**真的摆了几格** —— 没有 token 来源的那几家不在这一格上了(见上面那一条)。
    expect(screen.getByText(/3\/3 项工具可读取/)).toBeInTheDocument()
  })

  it('柱状图那句说明按真的在图上的那几家拼,不写死「DeepSeek 与 Codex」', () => {
    render(<UsagePanel usage={THREE} now={NOW} />)
    expect(document.querySelector('.cu-chart')?.getAttribute('aria-label'))
      .toBe('按日期展示Claude 与 Codex 与 DeepSeek的已记录Token用量')
  })

  it('认不出的那一家原样摆出来:名字就是它的 id,不编一句来源说明', () => {
    const usage: UsageState = {
      ...USAGE,
      days: [day('2026-09-01', 42, 0, 'muse')],
      sources: { muse: { status: 'ok' } },
    }
    render(<UsagePanel usage={usage} now={NOW} />)
    const tools = [...document.querySelectorAll('.cu-tool')] as HTMLElement[]
    const muse = tools.find(node => node.textContent?.includes('muse')) as HTMLElement
    expect(muse.textContent).toContain('Tokens 已记录')
  })

  it('读不到用量时一家都不摆 —— 不编一份「这台机器上有哪几家」的名册', () => {
    render(<UsagePanel usage={{ error: '暂时无法读取' }} now={NOW} />)
    const tools = [...document.querySelectorAll('.cu-tool')].map(node => node.textContent ?? '')
    // 只剩「没有 token 来源」那一类(豆包办公),它不依赖采集结果。
    expect(tools.filter(text => !text.includes('豆包办公'))).toEqual([])
  })
})
