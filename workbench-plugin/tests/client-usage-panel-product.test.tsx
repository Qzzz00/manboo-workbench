/**
 * 「消耗数据」**产品研发模板那一版**面板(= 0.4.89 那一份)。
 *
 * ★ 2026-10-03:这一份是从 `79b3757a` 原样取回的 `tests/client-usage-panel.test.tsx`,
 * **一条断言没改,只改了文件名**(`-product` 后缀)—— 同名那一份此刻守的是运营模板那一版
 * (他的 `air/usage.js`)。两版并存,各自一份用例,挑哪一版在 `client/UsageModule.tsx`。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { UsageState } from '../src/protocol.ts'
import { USAGE_METHOD_LABEL, UsagePanel } from '../src/client/UsagePanel.tsx'

afterEach(cleanup)

/**
 * 2026-09-02 真机误读案:面板上「总 token」只算输入+输出(5.49 亿),而缓存读是另一个
 * 量级(Claude 一项就 5.4B)——Ben 把缓存口径的数字记成了总消耗,得出"有一天 5B 多、
 * 今天变 469M"的结论。Ben 拍板修法:总数口径不变,处处标清口径,缓存读/写独立成行。
 */
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

describe('用量口径标注(2026-09-02 误读案修复)', () => {
  it('按活动、缓存、习惯分组，图表先于可展开口径且筛选保留', () => {
    render(<UsagePanel usage={USAGE} />)
    const activity = screen.getByRole('group', { name: '活动统计' })
    expect(within(activity).getByText('3')).toBeInTheDocument()
    expect(within(activity).getByText('12')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: '缓存统计' })).getByText('5.4B')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: '使用习惯' })).getByText('gpt-5-codex')).toBeInTheDocument()
    const chart = screen.getByRole('figure', { name: '年度用量' })
    const disclosure = screen.getByText(`${USAGE_METHOD_LABEL} ›`)
    expect(chart.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(disclosure.closest('details')).not.toHaveAttribute('open')
    fireEvent.click(disclosure)
    expect(disclosure.closest('details')).toHaveAttribute('open')
    expect(screen.getByText(/缓存读通常是总消耗的几十倍/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '7d' }))
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true')
  })
  /**
   * 2026-09-15 Ben:「我现在的总消耗数太少了,默认展示 All,搞多一点」。统筹会话解释后拍板:
   * **不编数**,换口径展示——大字改成「总吞吐(含缓存读)」,总消耗降成同一格里的小字。
   * 两个数的算法一字不改,只换主次;排行与热力图仍按总消耗(计费口径)。
   */
  // 2026-10-21 维护者(统筹转):大字仍是总吞吐,上下两行的括弧去掉 ——「总吞吐」「总消耗 530.6M」;口径写在「计算口径」里。
  it('总览唯一主指标是总吞吐,总消耗作为同格小字保留;切换视图后不重复数字', () => {
    const { container } = render(<UsagePanel usage={USAGE} />)
    const assertPrimary = () => {
      const primary = container.querySelector('.ben-wb__usage-tile--primary')
      expect(primary?.querySelector('.ben-wb__usage-tile-l')).toHaveTextContent(/^总吞吐$/)
      expect(primary?.querySelector('.ben-wb__usage-tile-v')).toHaveTextContent('6.6B')
      expect(primary?.querySelector('.ben-wb__usage-tile-sub')).toHaveTextContent(/^总消耗 \S+$/)
      expect(primary?.querySelector('.ben-wb__usage-tile-sub')).toHaveTextContent('1.2B')
      expect(container.querySelectorAll('.ben-wb__usage-tile--primary')).toHaveLength(1)
      expect(container.querySelector('.ben-wb__usage-tiles')?.firstElementChild).toBe(primary)
      // 2026-10-02 多了一格:「没有用量来源」那一块里的豆包办公(写一句话,不写 0)。
      expect(container.querySelectorAll('.ben-wb__usage-tile')).toHaveLength(11)
      // 构成图例照评审页写各家的数(「● Codex 1.2B」),只有一家时与小字同数 —— 不重复只看数字那几格。
      const tiles = container.querySelector('.ben-wb__usage-tiles') as HTMLElement
      expect(within(tiles).getAllByText('6.6B')).toHaveLength(1)
      expect(within(tiles).getAllByText(/1\.2B/)).toHaveLength(1)
    }
    assertPrimary()
    // 项目/模型页的排行按总消耗排,页头大字也是总消耗——占比才和条长对得上
    fireEvent.click(screen.getByRole('tab', { name: '项目' }))
    expect(container.querySelector('.ben-wb__usage-tile--primary')).toBeNull()
    expect(container.querySelector('.ben-wb__usage-hero-v')).toHaveTextContent('1.2B')
    expect(container.querySelector('.ben-wb__usage-hero-l')).toHaveTextContent('入+缓存写+出')
    fireEvent.click(screen.getByRole('tab', { name: '总览' }))
    assertPrimary()
  })

  it('All / 30d / 7d 三档大字都是吞吐、小字都是消耗,且随范围一起变', () => {
    // 8 天:第一天独占一份大数,7d 切掉它之后大小字都要跟着缩
    const day = (date: string, input: number, cacheRead: number): UsageState['days'][number] => ({
      date,
      by_project: { Aiboo: { input, output: 0, cache_read: cacheRead, cache_write: 0 } },
      by_model: { m: { input, output: 0, cache_read: cacheRead, cache_write: 0 } },
      by_source: { codex: { input, output: 0, cache_read: cacheRead, cache_write: 0 } },
      sessions: 1,
      messages: 1,
      hour_counts: {},
    })
    const days = [day('2026-09-01', 1_000_000_000, 8_000_000_000)]
    for (let i = 2; i <= 8; i++) days.push(day(`2026-09-0${i}`, 100_000_000, 200_000_000))
    const { container } = render(<UsagePanel usage={{ ...USAGE, days }} />)
    const primary = () => container.querySelector('.ben-wb__usage-tile--primary')
    for (const [range, big, small] of [['All', '11.1B', '1.7B'], ['30d', '11.1B', '1.7B'], ['7d', '2.1B', '700.0M']] as const) {
      fireEvent.click(screen.getByRole('button', { name: range }))
      expect(primary()?.querySelector('.ben-wb__usage-tile-l')).toHaveTextContent(/^总吞吐$/)
      expect(primary()?.querySelector('.ben-wb__usage-tile-v')).toHaveTextContent(big)
      expect(primary()?.querySelector('.ben-wb__usage-tile-sub')).toHaveTextContent(new RegExp(`^总消耗 ${small.replace('.', '\\.')}$`))
    }
  })

  it('口径说明写清缓存读是每轮重读上下文、计价约为输入的十分之一', () => {
    render(<UsagePanel usage={USAGE} />)
    const disclosure = screen.getByText(`${USAGE_METHOD_LABEL} ›`)
    fireEvent.click(disclosure)
    expect(screen.getByText(/缓存读 = 每轮重读上下文,计价约为输入的十分之一/)).toBeVisible()
    expect(screen.getByText(/总消耗 = 入 \+ 缓存写 \+ 出/)).toBeVisible()
  })

  it.each([undefined, { error: '暂时无法读取' }])('未接入时不伪造主数字：%j', usage => {
    const { container } = render(<UsagePanel usage={usage} />)
    expect(screen.getByText(/未接入/)).toBeInTheDocument()
    expect(container.querySelector('.ben-wb__usage-tile--primary')).toBeNull()
    expect(container.querySelector('.ben-wb__usage-hero-v')).toBeNull()
  })

  it('总 token 标明「入+出」口径,缓存读/写独立成行且不混进总数', () => {
    render(<UsagePanel usage={USAGE} />)
    // 总数 = 4亿 + 1亿 = 500.0M,口径写在标签上
    // 2026-09-02 二次修订(Ben:"这才是总消耗嘛"):口径从「入+出」改为「入+缓存写+出」。
    // 真机铁证:两家记账口径不同——Codex 的 input_tokens 含缓存(我们减掉后即真实新增),
    // 而 Claude 的既不含缓存读、**也不含缓存写**,它"第一次送进去被处理"的那批全在
    // cache_write 里。全时段实测:Claude 新增输入只有 63,182,而缓存写有 63,602,029——
    // 旧口径等于把 Claude 的贡献抹成零。
    // 2026-09-15 三次修订:大字换成总吞吐,总消耗降为同格小字,两个数都在、口径都标
    expect(screen.getByText(/^总消耗 1\.2B$/)).toBeTruthy()
    expect(screen.getAllByText(/1\.2B/).length).toBeGreaterThan(0) // 4亿 + 7亿缓存写 + 1亿 = 12亿(构成图例里也写这一家的数)
    expect(screen.getByText('总吞吐')).toBeTruthy()
    expect(screen.getByText('6.6B')).toBeTruthy() // 再加 54 亿缓存读 = 66 亿
    // 缓存读/写各自成行,数字可见——5.4B 从此不会被读成"总消耗"
    expect(screen.getByText('缓存读')).toBeTruthy()
    expect(screen.getByText('5.4B')).toBeTruthy()
    expect(screen.getByText('缓存写')).toBeTruthy()
    expect(screen.getByText('700.0M')).toBeTruthy()
  })

  it('缓存远大于总消耗时给一句说明——几十倍是正常的,不是数据错', () => {
    // 真机:总消耗 6.01 亿、总吞吐 224.5 亿。这是长上下文每轮重读的正常形态,
    // 但连着三次被读成"数字不对"。与其等人再问,不如在数字旁边写清楚。
    render(<UsagePanel usage={USAGE} />)
    expect(screen.getByText(/缓存读通常是总消耗的几十倍/)).toBeTruthy()
  })
})
