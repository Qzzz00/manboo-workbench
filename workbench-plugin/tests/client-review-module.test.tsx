/**
 * 「数据复盘」那一格接上数之后长什么样。
 *
 * ★ 2026-10-03:这一格的组件本体是**运营同学(Air)自己写的那一份**
 * (`user-layer/起步/小组件/review/index.js`,原件 `contrib/air-20261002/src/review.js`)。
 * 维护者当日原话:「有现成的代码不用,非要去重新开发……你就把他之前的代码,原封不动在下一次更新里替换进去。」
 *
 * 所以这一份用例整份改过:断言的是**她那一格真正的样子**。上一版(09-21 ~ 10-02)那几条
 * 断言的是被她替掉的那一版的做法(占位那一支、八格 MetricCell、登录态那一句、
 * 「这个范围还没接上」、事务官的建议、「让我看看这页」、ReviewCompare 那一组),
 * 她那一份里没有这些东西 —— 删了,并在
 * docs/交接-1003-运营同学六组件原封接入.md 里逐条列出「她那一版没有的」。
 *
 * 留下来照旧守着的:
 * - **不许装成有**:取不到的那一条写「未采集」,不写 0;占比算不出来就说算不出来;
 * - **显示的是页面上原样那串**(`raw`,后台写「7.7万」就显示「7.7万」);
 * - 不可采集那两项(`notes` / `avg_watch`)一处都不摆 —— 判据是她写的 `reviewHasValue`;
 * - 两颗范围按钮是真的开关、「刷新数据」打的是 `/xhs/refresh` 且回话原样上屏;
 * - 账号表(`AccountsTable`,本体那一份 + 她改的列头算法)与 `deltaOf` 两个纯件。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { XhsAccountView, XhsView } from '../src/protocol.ts'
import { AccountsTable, REVIEW_ACCOUNT_NO_DATA, REVIEW_CELL_NONE, REVIEW_METRIC_MISSING, deltaOf, reviewHasValue } from '../src/client/ReviewModule.tsx'
import { starterWidget } from './helpers/starterLayer.ts'

// 2026-10-21:这几格搬进了用户层(`user-layer/起步/小组件/`),经本体的加载口装出来。
const ReviewModule = starterWidget('review')

afterEach(cleanup)

const BOX = {
  id: 'review',
  title: '数据复盘',
  basisPct: 30,
  dragging: false,
  onResizeStart: () => {},
  onResizeMove: () => {},
  onResizeEnd: () => {},
}

function mount(xhs?: XhsView, calls: { url: string }[] = []) {
  const fetchImpl = (async (url: string) => {
    calls.push({ url: String(url) })
    return { ok: true, json: async () => ({ message: '取到 8 项' }) } as unknown as Response
  }) as unknown as typeof fetch
  render(
    <ReviewModule
      box={BOX}
      header={<h2 id="h">数据复盘</h2>}
      headingId="h"
      baseUrl="http://127.0.0.1:1"
      fetchImpl={fetchImpl}
      {...(xhs === undefined ? {} : { xhs })}
    />,
  )
  return calls
}

/** 夹具里的数字全是假的(与 tests/xhsPageFixtures.ts 同一条纪律)。 */
function view(over: Partial<XhsView> = {}): XhsView {
  return {
    login: { connected: true, nickname: '假昵称·用例用的' },
    accounts: [],
    ranges: [{
      range: '近 7 日',
      date: '2026-09-21',
      at: '2026-09-21T02:00:00.000Z',
      metrics: [
        {
          key: 'impressions', label: '曝光数', kind: 'count', value: 77_000, raw: '7.7万',
          prev: { value: 99_000, raw: '9.9万', date: '2026-09-14' },
        },
        { key: 'views', label: '观看数', kind: 'count', value: 11_000, raw: '1.1万' },
        // 后台压根没给这一项。
        { key: 'cover_ctr', label: '封面点击率', kind: 'percent' },
      ],
    }],
    fetches: [
      { at: '2026-09-21T02:00:00.000Z', ok: true, got: 2, total: 8, trigger: 'routine' },
    ],
    last_ok_at: '2026-09-21T02:00:00.000Z',
    ...over,
  }
}

/** 一个账号一份范围数(2026-09-22 起 `/state.xhs.accounts`)。 */
function account(
  profile: string,
  name: string,
  metrics: XhsAccountView['ranges'][number]['metrics'],
  over: Partial<XhsAccountView> = {},
): XhsAccountView {
  return {
    profile,
    index: 0,
    name,
    connected: true,
    ranges: [{ range: '近 7 日', date: '2026-09-21', at: '2026-09-21T02:00:00.000Z', metrics }],
    ...over,
  }
}

describe('她那一格的骨架', () => {
  it('两颗范围按钮是真的开关', async () => {
    mount(view())
    act(() => { screen.getByRole('button', { name: '近 30 日' }).click() })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '近 30 日' })).toHaveAttribute('aria-pressed', 'true')
    })
    expect(screen.getByRole('button', { name: '近 7 日' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('两颗视图按钮:默认「账号对比 / 占比」亮着,点一下切到「账号趋势」', async () => {
    mount(view())
    expect(screen.getByRole('button', { name: '账号对比 / 占比' })).toHaveAttribute('aria-pressed', 'true')
    act(() => { screen.getByRole('button', { name: '账号趋势' }).click() })
    await waitFor(() => expect(screen.getByRole('button', { name: '账号趋势' })).toHaveAttribute('aria-pressed', 'true'))
  })

  it('顶上报的是**接上了几个账号**,不报第一个的昵称', () => {
    mount(view({
      accounts: [
        account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 100, raw: '100' }]),
        account('b', '新号', [{ key: 'views', label: '观看数', kind: 'count', value: 50, raw: '50' }], { connected: false }),
      ],
    }))
    expect(screen.getByText(/已连接 1\/2 个账号/)).toBeInTheDocument()
  })

  it('账号下拉里「全部账号」+ 每个账号一条', () => {
    mount(view({
      accounts: [
        account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 100, raw: '100' }]),
        account('b', '新号', [{ key: 'views', label: '观看数', kind: 'count', value: 50, raw: '50' }]),
      ],
    }))
    const picker = screen.getByLabelText('选择复盘账号') as HTMLSelectElement
    expect([...picker.options].map(option => option.textContent)).toEqual(['全部账号', '小食堂', '新号'])
  })

  it('★指标下拉里只有可采集的那六项 —— 「笔记发布数 / 平均观看时长」连选项都没有', () => {
    mount(view())
    const picker = screen.getByLabelText('选择图表指标') as HTMLSelectElement
    expect([...picker.options].map(option => option.textContent))
      .toEqual(['观看', '曝光', '封面点击率', '点赞', '收藏', '涨粉'])
  })
})

describe('账号对比那一块:取不到就说取不到', () => {
  it('★每个账号一条,数字是页面上原样那串,条长按值比', () => {
    mount(view({
      accounts: [
        account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 100_000, raw: '10万' }]),
        account('b', '新号', [{ key: 'views', label: '观看数', kind: 'count', value: 25_000, raw: '2.5万' }]),
      ],
    }))
    const rows = [...document.querySelectorAll('.rviz-compare-row')]
    expect(rows).toHaveLength(2)
    // 原样那串,不是换算回来的 100,000。
    expect(rows[0]?.textContent).toContain('10万')
    expect(rows[1]?.textContent).toContain('2.5万')
    const fills = [...document.querySelectorAll('.rviz-fill')] as HTMLElement[]
    expect(fills[0]?.style.width).toBe('100%')
    expect(fills[1]?.style.width).toBe('25%')
  })

  it('★这一条没取到:写「未采集」,**不画一个 0**', () => {
    mount(view({
      accounts: [
        account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 100, raw: '100' }]),
        // 这个账号这一项后台没给(没有 value / raw)。
        account('b', '新号', [{ key: 'views', label: '观看数', kind: 'percent' }]),
      ],
    }))
    const rows = [...document.querySelectorAll('.rviz-compare-row')]
    expect(rows[1]?.textContent).toContain('未采集')
    expect(rows[1]?.querySelector('.rviz-compare-label strong')?.textContent).toBe('未采集')
    expect(rows[1]?.querySelector('.rviz-compare-label strong')?.textContent).not.toBe('0')
    expect((rows[1]?.querySelector('.rviz-fill') as HTMLElement).style.width).toBe('0%')
  })

  it('★负值(涨粉掉了)条长按绝对值,并且在条下面说出来', () => {
    mount(view({
      accounts: [account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: -30, raw: '-30' }])],
    }))
    expect(document.querySelector('.rviz-compare-row')?.textContent).toContain('负值')
    expect((document.querySelector('.rviz-fill') as HTMLElement).style.width).toBe('100%')
  })
})

describe('占比环:分母少一个就不算', () => {
  it('★全员都有观看数:环画出来,图例里是百分比', () => {
    mount(view({
      accounts: [
        account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 75, raw: '75' }]),
        account('b', '新号', [{ key: 'views', label: '观看数', kind: 'count', value: 25, raw: '25' }]),
      ],
    }))
    expect(document.querySelector('.rviz-donut')).not.toBeNull()
    const legend = [...document.querySelectorAll('.rviz-legend strong')].map(node => node.textContent)
    expect(legend).toEqual(['75.0%', '25.0%'])
  })

  it('★少一个账号的观看数:**环整块不画**,并说出为什么', () => {
    mount(view({
      accounts: [
        account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 75, raw: '75' }]),
        account('b', '新号', [{ key: 'views', label: '观看数', kind: 'count' }]),
      ],
    }))
    expect(document.querySelector('.rviz-donut')).toBeNull()
    expect(screen.getByText('部分账号缺少观看量，暂不计算占比。')).toBeInTheDocument()
  })

  it('★全员都有数但合计是 0:说「暂无占比」,不画一个空环', () => {
    mount(view({
      accounts: [
        account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 0, raw: '0' }]),
        account('b', '新号', [{ key: 'views', label: '观看数', kind: 'count', value: 0, raw: '0' }]),
      ],
    }))
    expect(document.querySelector('.rviz-donut')).toBeNull()
    expect(screen.getByText('观看量合计为 0，暂无占比。')).toBeInTheDocument()
  })

  it('选了某一个账号之后,占比那一块整个不画(占比是"相对别人"的事)', async () => {
    mount(view({
      accounts: [
        account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 75, raw: '75' }]),
        account('b', '新号', [{ key: 'views', label: '观看数', kind: 'count', value: 25, raw: '25' }]),
      ],
    }))
    const picker = screen.getByLabelText('选择复盘账号') as HTMLSelectElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
      setter?.call(picker, 'a')
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitFor(() => expect(screen.queryByText('观看量 · 账号占比')).toBeNull())
    expect(document.querySelectorAll('.rviz-compare-row')).toHaveLength(1)
  })
})

describe('关键数字那一折:不可采集的一个都不摆', () => {
  it('★服务端照旧带着那两项,这一格一个都不摆', () => {
    mount(view({
      ranges: [{
        range: '近 7 日',
        date: '2026-09-21',
        at: '2026-09-21T02:00:00.000Z',
        metrics: [
          { key: 'views', label: '观看数', kind: 'count', value: 11_000, raw: '1.1万' },
          // 平台结构上就不给的那两项(server/xhsMetrics.ts 的 source:'none')。
          { key: 'notes', label: '笔记发布数', kind: 'count', why: '首页没有这一项' },
          { key: 'avg_watch', label: '平均观看时长', kind: 'seconds', why: '首页没有这一项' },
        ],
      }],
    }))
    const kpis = [...document.querySelectorAll('.rviz-kpi')].map(node => node.textContent)
    expect(kpis).toHaveLength(1)
    expect(kpis[0]).toContain('观看数')
    expect(screen.queryByText('笔记发布数')).toBeNull()
    expect(screen.queryByText('平均观看时长')).toBeNull()
  })

  it('算出来的数自报家门(「合计」/「按曝光加权」)', () => {
    mount(view({
      ranges: [{
        range: '近 7 日',
        date: '2026-09-21',
        at: '2026-09-21T02:00:00.000Z',
        metrics: [{ key: 'views', label: '观看数', kind: 'count', value: 3, raw: '3', derived: '合计' }],
      }],
    }))
    expect(document.querySelector('.rviz-kpi small')?.textContent).toBe('合计')
  })
})

describe('采集状态与记录(PRD §9:每一次自动动作都看得见)', () => {
  it('取过的那几次列出来;服务端那句 note 原样上屏', () => {
    mount(view({ note: '后台页面变了,等更新' }))
    expect(screen.getByText('后台页面变了,等更新')).toBeInTheDocument()
    expect(screen.getByText(/已读取部分或全部数据/)).toBeInTheDocument()
  })

  it('一次都没取过:说「暂无采集记录」', () => {
    mount(view({ fetches: [] }))
    expect(screen.getByText('暂无采集记录')).toBeInTheDocument()
  })

  it('失败那一次写「读取失败」加服务端给的原因', () => {
    mount(view({
      fetches: [{ at: '2026-09-21T05:00:00.000Z', ok: false, got: 0, total: 8, trigger: 'manual', reason: '要重新登录' }],
    }))
    expect(screen.getByText(/读取失败 · 要重新登录/)).toBeInTheDocument()
  })
})

describe('「刷新数据」那一颗', () => {
  it('打 /xhs/refresh,服务端那句话原样上屏', async () => {
    const calls = mount(view())
    act(() => { screen.getByRole('button', { name: '刷新数据' }).click() })
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/xhs/refresh'))).toBe(true))
    expect(await screen.findByText('取到 8 项')).toBeInTheDocument()
  })
})

describe('reviewHasValue(她写的那条判据,原封接入)', () => {
  it('不可采集那两项一律 false —— key 与中文名两道都挡', () => {
    expect(reviewHasValue({ key: 'notes', label: '笔记发布数', kind: 'count', value: 3, raw: '3' })).toBe(false)
    expect(reviewHasValue({ key: 'avg_watch', label: '平均观看时长', kind: 'seconds', value: 3, raw: '3' })).toBe(false)
    expect(reviewHasValue({ key: 'x', label: '笔记发布数', kind: 'count', value: 3, raw: '3' })).toBe(false)
  })

  it('没有数、没有原样那串、原样那串是空白 → false(不编一个 0)', () => {
    expect(reviewHasValue({ key: 'views', label: '观看数', kind: 'count' })).toBe(false)
    expect(reviewHasValue({ key: 'views', label: '观看数', kind: 'count', value: 3 })).toBe(false)
    expect(reviewHasValue({ key: 'views', label: '观看数', kind: 'count', value: 3, raw: '   ' })).toBe(false)
    expect(reviewHasValue(undefined)).toBe(false)
  })

  it('真有数就 true —— 0 也算有数', () => {
    expect(reviewHasValue({ key: 'views', label: '观看数', kind: 'count', value: 0, raw: '0' })).toBe(true)
  })
})

describe('deltaOf 这个纯函数', () => {
  const metric = (value?: number, prev?: { value: number, raw: string, date: string }) =>
    ({ key: 'x', label: 'x', kind: 'count' as const, ...(value === undefined ? {} : { value, raw: String(value) }), ...(prev === undefined ? {} : { prev }) })

  it('涨了画 ↑,跌了画 ↓,一样画 →', () => {
    expect(deltaOf(metric(10, { value: 5, raw: '5', date: '2026-09-14' }))?.arrow).toBe('↑')
    expect(deltaOf(metric(5, { value: 10, raw: '10', date: '2026-09-14' }))?.arrow).toBe('↓')
    expect(deltaOf(metric(5, { value: 5, raw: '5', date: '2026-09-14' }))?.arrow).toBe('→')
  })

  it('★没有上一周期就整块缺席 —— 不画一个"持平"的横杠', () => {
    expect(deltaOf(metric(10))).toBeUndefined()
  })

  it('★本期没取到也不画(「上期有、本期没有」不是下降)', () => {
    expect(deltaOf(metric(undefined, { value: 10, raw: '10', date: '2026-09-14' }))).toBeUndefined()
  })

  it('上期是 0 时不说百分比,只说上期原样那串', () => {
    expect(deltaOf(metric(10, { value: 0, raw: '0', date: '2026-09-14' }))?.text).toBe('上期 0')
  })
})

describe('AccountsTable:列头按她那条算法来(每个账号一行 + 合计一行)', () => {
  const table = (accounts: readonly XhsAccountView[], total?: XhsView['ranges'][number]) => {
    render(<AccountsTable accounts={accounts} range="近 7 日" {...(total === undefined ? {} : { total })} />)
  }

  it('★列头把合计与所有账号那几行并起来,按 key 去重', () => {
    table([
      account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 100, raw: '100' }]),
      // 这个账号独有的一项:上一版只看合计那一行,它就没有列。
      account('b', '新号', [{ key: 'likes', label: '点赞数', kind: 'count', value: 7, raw: '7' }]),
    ])
    expect([...document.querySelectorAll('thead th')].map(node => node.textContent))
      .toEqual(['账号', '观看数', '点赞数'])
  })

  it('★一项都没有数时整张表不画(不摆一张只有表头的表)', () => {
    table([account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count' }])])
    expect(document.querySelector('.ben-wb__review-accounts')).toBeNull()
  })

  it('★不可采集那两项连列都不留', () => {
    table([account('a', '小食堂', [
      { key: 'views', label: '观看数', kind: 'count', value: 100, raw: '100' },
      { key: 'notes', label: '笔记发布数', kind: 'count', value: 3, raw: '3' },
    ])])
    expect([...document.querySelectorAll('thead th')].map(node => node.textContent)).toEqual(['账号', '观看数'])
  })

  it('★空着的那一格写「没给」,不写 0;完整的原因挂在 title 上', () => {
    table([
      account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 100, raw: '100' }]),
      account('b', '新号', [{ key: 'views', label: '观看数', kind: 'count', why: '这个号的后台还没放出来' }]),
    ])
    const cell = document.querySelector('.ben-wb__review-acc-none') as HTMLElement
    expect(cell.textContent).toBe(REVIEW_CELL_NONE)
    expect(cell).toHaveAttribute('title', '这个号的后台还没放出来')
    expect(cell.textContent).not.toBe('0')
  })

  it('没有 why 的那一项照旧写「后台没有这项」', () => {
    table([
      account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 100, raw: '100' }]),
      account('b', '新号', [{ key: 'views', label: '观看数', kind: 'count' }]),
    ])
    expect(document.querySelector('.ben-wb__review-acc-none')).toHaveAttribute('title', REVIEW_METRIC_MISSING)
  })

  it('★这个账号这个范围一个数都没有时,那一行如实说,不画一排 0', () => {
    table([
      account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 100, raw: '100' }]),
      account('b', '新号', [], { ranges: [] }),
    ])
    expect(screen.getByText(REVIEW_ACCOUNT_NO_DATA)).toBeInTheDocument()
  })

  it('★没登录的账号那一行标着「未登录」,但它上一次的数还在', () => {
    table([account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 100, raw: '100' }], { connected: false })])
    expect(screen.getByText('未登录')).toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
  })

  it('对上运营模板那边的账号文件夹就挂个钩;对不上就没有(不强绑)', () => {
    table([account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 100, raw: '100' }], { account_dir: '小食堂' })])
    expect(screen.getByText('账号/小食堂')).toBeInTheDocument()
    cleanup()
    table([account('b', '新号', [{ key: 'views', label: '观看数', kind: 'count', value: 1, raw: '1' }])])
    expect(document.querySelector('.ben-wb__review-acc-dir')).toBeNull()
  })

  it('合计那一行写着「合计」', () => {
    table(
      [account('a', '小食堂', [{ key: 'views', label: '观看数', kind: 'count', value: 100, raw: '100' }])],
      {
        range: '近 7 日',
        date: '2026-09-21',
        at: '2026-09-21T02:00:00.000Z',
        metrics: [{ key: 'views', label: '观看数', kind: 'count', value: 101, raw: '101' }],
      },
    )
    const total = document.querySelector('tbody tr[data-total="true"]')
    expect(total?.textContent).toContain('合计')
    expect(total?.textContent).toContain('101')
  })
})
