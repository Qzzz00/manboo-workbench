// @vitest-environment node
/**
 * 解析器(src/server/xhsMetrics.ts)。夹具与「数字全是假的」那段说明在 tests/xhsPageFixtures.ts。
 *
 * 这一份守的全是「一个数都不编」的各种走样形态:读不出来的值不许退回 0、
 * 形状对不上不许硬塞、标签一个都没认出来要判成"页面变了"而不是"八项全是 0"。
 */
import { describe, expect, it } from 'vitest'
import {
  XHS_METRICS, XHS_METRIC_KEYS, XHS_OVERVIEW_KEYS, XHS_RANGES, XHS_RANGE_DAYS,
  mergeLabelOverrides, metricDefOf, parseCreatorPage, parseXhsNumber, periodLineOf,
} from '../src/server/xhsMetrics.ts'
import {
  XHS_FAKE_DASH_PAGE_TEXT, XHS_FAKE_DATA_PAGE_TEXT, XHS_FAKE_ONE_LINE_PAGE_TEXT,
  XHS_FAKE_PARTIAL_PAGE_TEXT, XHS_FAKE_RENAMED_PAGE_TEXT, XHS_HOME_PAGE_D30_TEXT,
  XHS_HOME_PAGE_TEXT, XHS_LOGIN_PAGE_TEXT,
} from './xhsPageFixtures.ts'

describe('八个指标的定义', () => {
  it('就是 Ben 草图上那八个,一个不多一个不少,顺序也是他画的顺序', () => {
    expect(XHS_METRICS.map(def => def.label)).toEqual([
      '笔记发布数', '曝光数', '观看数', '封面点击率',
      '点赞数', '收藏数', '涨粉数', '平均观看时长',
    ])
  })

  it('机器名与定义表同源(改一头忘了另一头,metricDefOf 当场抛)', () => {
    for (const key of XHS_METRIC_KEYS) expect(metricDefOf(key).key).toBe(key)
    expect(XHS_METRICS.length).toBe(XHS_METRIC_KEYS.length)
  })

  it('数据范围只有近 7 日 / 近 30 日,天数对得上', () => {
    expect(XHS_RANGES).toEqual(['近 7 日', '近 30 日'])
    expect(XHS_RANGE_DAYS['近 7 日']).toBe(7)
    expect(XHS_RANGE_DAYS['近 30 日']).toBe(30)
  })
})

describe('parseXhsNumber:页面上那串中文数字', () => {
  it('普通计数与千分位', () => {
    expect(parseXhsNumber('12')).toEqual({ value: 12, kind: 'count' })
    expect(parseXhsNumber('1,234')).toEqual({ value: 1234, kind: 'count' })
  })

  it('万 / 亿 / 千', () => {
    expect(parseXhsNumber('1.1万')).toEqual({ value: 11_000, kind: 'count' })
    expect(parseXhsNumber('9.9万')).toEqual({ value: 99_000, kind: 'count' })
    expect(parseXhsNumber('3.5亿')).toEqual({ value: 350_000_000, kind: 'count' })
    expect(parseXhsNumber('2千')).toEqual({ value: 2_000, kind: 'count' })
  })

  it('百分比回的是百分点(11.1 表示 11.1%),不是 0.111', () => {
    expect(parseXhsNumber('11.1%')).toEqual({ value: 11.1, kind: 'percent' })
  })

  it('时长:mm:ss 与 hh:mm:ss,以及中文的「1分23秒」', () => {
    expect(parseXhsNumber('00:11')).toEqual({ value: 11, kind: 'seconds' })
    expect(parseXhsNumber('1:02:03')).toEqual({ value: 3723, kind: 'seconds' })
    expect(parseXhsNumber('1分23秒')).toEqual({ value: 83, kind: 'seconds' })
    expect(parseXhsNumber('23秒')).toEqual({ value: 23, kind: 'seconds' })
  })

  it('★「00:11」不许被当成 0 —— 时长要先于纯数字判', () => {
    expect(parseXhsNumber('00:11')?.value).toBe(11)
  })

  it('★读不出来回 undefined,**绝不退回 0**', () => {
    for (const raw of ['-', '--', '暂无数据', '', '   ', '待更新', 'N/A']) {
      expect(parseXhsNumber(raw)).toBeUndefined()
    }
  })
})

describe('parseCreatorPage:未登录那一页', () => {
  it('★真抓的未登录页判成 logged_out,一个指标都不出(而不是八项全 0)', () => {
    const parsed = parseCreatorPage(XHS_LOGIN_PAGE_TEXT)
    expect(parsed.state).toBe('logged_out')
    expect(Object.keys(parsed.metrics)).toEqual([])
  })
})

describe('parseCreatorPage:两种排法都要认', () => {
  it('「标签一行、数字一行」的两行式', () => {
    const parsed = parseCreatorPage(XHS_FAKE_DATA_PAGE_TEXT)
    expect(parsed.state).toBe('ok')
    // 夹具里的数字全是假的(见 xhsPageFixtures.ts 文件头)。
    // 2026-09-22 起 notes / avg_watch **不在总览页上取**(首页根本没有这两项),
    // 所以这两份编出来的夹具上它们也不该被认出来 —— 见 xhsMetrics.ts 文件头。
    expect(parsed.metrics.notes).toBeUndefined()
    expect(parsed.metrics.avg_watch).toBeUndefined()
    expect(parsed.metrics.impressions).toEqual({ value: 99_000, raw: '9.9万' })
    expect(parsed.metrics.views).toEqual({ value: 11_000, raw: '1.1万' })
    expect(parsed.metrics.cover_ctr).toEqual({ value: 11.1, raw: '11.1%' })
    expect(parsed.metrics.likes).toEqual({ value: 999, raw: '999' })
    expect(parsed.metrics.favorites).toEqual({ value: 888, raw: '888' })
    expect(parsed.metrics.new_fans).toEqual({ value: 77, raw: '77' })
    expect(parsed.label_seen_no_value).toEqual([])
  })

  it('「标签和数字在同一行」', () => {
    const parsed = parseCreatorPage(XHS_FAKE_ONE_LINE_PAGE_TEXT)
    expect(parsed.state).toBe('ok')
    expect(Object.keys(parsed.metrics).sort()).toEqual([...XHS_OVERVIEW_KEYS].sort())
    expect(parsed.metrics.cover_ctr?.value).toBe(11.1)
  })

  it('★「涨粉数 77」不许被「笔记发布数」那一行的 12 串到', () => {
    const parsed = parseCreatorPage(XHS_FAKE_DATA_PAGE_TEXT)
    expect(parsed.metrics.new_fans?.raw).toBe('77')
  })
})

describe('parseCreatorPage:取不到的时候', () => {
  it('★后台只剩一半指标:缺的那两项如实缺席(界面显示「后台没有这项」)', () => {
    const parsed = parseCreatorPage(XHS_FAKE_PARTIAL_PAGE_TEXT)
    expect(parsed.state).toBe('ok')
    expect(parsed.metrics.cover_ctr).toBeUndefined()
    expect(parsed.metrics.avg_watch).toBeUndefined()
    expect(parsed.metrics.likes?.value).toBe(999)
  })

  it('★标签在、值是「-」或「暂无数据」:那几项缺席且记进 label_seen_no_value,**不退回 0**', () => {
    const parsed = parseCreatorPage(XHS_FAKE_DASH_PAGE_TEXT)
    expect(parsed.metrics.impressions).toBeUndefined()
    expect(parsed.metrics.cover_ctr).toBeUndefined()
    expect(parsed.label_seen_no_value).toContain('impressions')
    expect(parsed.label_seen_no_value).toContain('cover_ctr')
    // 同一页上取得到的那几项照常取。
    expect(parsed.metrics.views?.value).toBe(11_000)
  })

  it('★一个标签都没认出来 = 页面变了,不是八项全 0', () => {
    const parsed = parseCreatorPage(XHS_FAKE_RENAMED_PAGE_TEXT)
    expect(parsed.state).toBe('layout_changed')
    expect(Object.keys(parsed.metrics)).toEqual([])
  })

  it('★形状对不上就算没取到:「封面点击率」旁边是个计数时,这一项缺席而不是塞 12000', () => {
    const parsed = parseCreatorPage(['封面点击率', '1.2万'].join('\n'))
    expect(parsed.metrics.cover_ctr).toBeUndefined()
    expect(parsed.label_seen_no_value).toContain('cover_ctr')
  })

  it('★往下找值时遇到下一个标签就停,不把下一项的数字算到这一项头上', () => {
    const parsed = parseCreatorPage(['曝光数', '观看数', '1.1万'].join('\n'))
    expect(parsed.metrics.impressions).toBeUndefined()
    expect(parsed.metrics.views?.value).toBe(11_000)
  })
})

describe('mergeLabelOverrides:Ben 登录后校准那份覆盖文件', () => {
  it('认得的键收下,认不出的键丢掉(一个错键不该把整份覆盖废掉)', () => {
    const merged = mergeLabelOverrides({
      labels: { impressions: ['总曝光'], 不存在的键: ['x'], views: [], likes: [1, '赞'] },
    })
    expect(merged.impressions).toEqual(['总曝光'])
    // 空数组当没给(照用内置那份)。
    expect(merged.views).toBeUndefined()
    // 非字符串项被剔掉,剩下的还算数。
    expect(merged.likes).toEqual(['赞'])
    expect(Object.keys(merged)).not.toContain('不存在的键')
  })

  it('文件坏了 / 形状不对一律回空,不抛', () => {
    expect(mergeLabelOverrides(null)).toEqual({})
    expect(mergeLabelOverrides('不是对象')).toEqual({})
    expect(mergeLabelOverrides({})).toEqual({})
    expect(mergeLabelOverrides({ labels: 5 })).toEqual({})
  })

  it('覆盖真的生效:后台把「曝光数」改叫「内容触达」之后,改一份文件就能接上,不用重新发版', () => {
    const page = ['内容触达', '9.9万'].join('\n')
    expect(parseCreatorPage(page).metrics.impressions).toBeUndefined()
    const labels = mergeLabelOverrides({ labels: { impressions: ['内容触达'] } })
    expect(parseCreatorPage(page, labels).metrics.impressions?.value).toBe(99_000)
  })

  it('内置候选是「含」而不是「等于」:「总曝光量」照样认得出(改版只是加了前缀时不用改文件)', () => {
    expect(parseCreatorPage(['总曝光量', '9.9万'].join('\n')).metrics.impressions?.value).toBe(99_000)
  })
})

/**
 * 2026-09-22:**真版面**(数字是假的)。
 *
 * 这一组是这张卡的核心 —— 9/21 那一版的标签是猜的,这一组钉的是"照真页面改对了没有"。
 */
describe('★真版面(/new/home):2026-09-22 实测到的那一页', () => {
  it('六项账号级指标全取到,「净涨粉」就是涨粉数那一项', () => {
    const parsed = parseCreatorPage(XHS_HOME_PAGE_TEXT)
    expect(parsed.state).toBe('ok')
    expect(parsed.metrics.impressions).toEqual({ value: 1111, raw: '1,111' })
    expect(parsed.metrics.views).toEqual({ value: 222, raw: '222' })
    expect(parsed.metrics.cover_ctr).toEqual({ value: 11.1, raw: '11.1%' })
    expect(parsed.metrics.likes).toEqual({ value: 9, raw: '9' })
    expect(parsed.metrics.favorites).toEqual({ value: 8, raw: '8' })
    // ★ 页面上写的是「净涨粉」。
    expect(parsed.metrics.new_fans).toEqual({ value: 7, raw: '7' })
    expect(parsed.label_seen_no_value).toEqual([])
  })

  it('★首页没有「笔记发布数」与「平均观看时长」——这两项缺席,不是 0', () => {
    const parsed = parseCreatorPage(XHS_HOME_PAGE_TEXT)
    expect(parsed.metrics.notes).toBeUndefined()
    expect(parsed.metrics.avg_watch).toBeUndefined()
    // 而且不该被记成"认出了标签但读不出值" —— 标签本来就不在这一页上。
    expect(parsed.label_seen_no_value).not.toContain('notes')
    expect(parsed.label_seen_no_value).not.toContain('avg_watch')
  })

  it('★「笔记数据总览」不许被当成笔记发布数:它下面第二行「统计周期 09-15…」里的 09 会被读成 9 篇', () => {
    const parsed = parseCreatorPage(XHS_HOME_PAGE_TEXT)
    expect(parsed.metrics.notes).toBeUndefined()
  })

  it('★「新增关注 9」不许冒充涨粉数 —— 它比净涨粉大,拿它顶替是往好看了编', () => {
    const parsed = parseCreatorPage(XHS_HOME_PAGE_TEXT)
    expect(parsed.metrics.new_fans?.raw).toBe('7')
  })

  it('★值那一行万一没渲染出来,也不许往下抓到「环比-11%」', () => {
    // 把「封面点击率」下面那一行值抹掉,留着紧跟的「环比-11%」。
    const broken = XHS_HOME_PAGE_TEXT.replace('封面点击率\n11.1%\n环比-11%', '封面点击率\n环比-11%')
    const parsed = parseCreatorPage(broken)
    // 形状正好对得上(都是百分比),所以这一条全靠 LOOKAHEAD_STOP 挡着。
    expect(parsed.metrics.cover_ctr).toBeUndefined()
    expect(parsed.label_seen_no_value).toContain('cover_ctr')
    // 同一页上别的项照常取。
    expect(parsed.metrics.impressions?.raw).toBe('1,111')
  })

  it('「视频完播率 21.4%」这类首页上有、但不在八个指标里的东西一律不收', () => {
    const parsed = parseCreatorPage(XHS_HOME_PAGE_TEXT)
    expect(Object.keys(parsed.metrics).sort()).toEqual([...XHS_OVERVIEW_KEYS].sort())
  })
})

describe('periodLineOf:「统计周期」那一行是切范围唯一的硬证据', () => {
  it('原样取出来', () => {
    expect(periodLineOf(XHS_HOME_PAGE_TEXT)).toBe('统计周期 09-15 至 09-21')
    expect(periodLineOf(XHS_HOME_PAGE_D30_TEXT)).toBe('统计周期 08-23 至 09-21')
  })

  it('★近7日与近30日两份**地址一模一样**,只有这一行不同', () => {
    expect(periodLineOf(XHS_HOME_PAGE_TEXT)).not.toBe(periodLineOf(XHS_HOME_PAGE_D30_TEXT))
  })

  it('没有那一行就没有(不编一个)', () => {
    expect(periodLineOf(XHS_LOGIN_PAGE_TEXT)).toBeUndefined()
  })

  it('解析结果里带着它', () => {
    expect(parseCreatorPage(XHS_HOME_PAGE_TEXT).period).toBe('统计周期 09-15 至 09-21')
  })
})

describe('XHS_METRIC_KEYS 与来源', () => {
  it('八项里只有六项来自首页总览', () => {
    expect(XHS_OVERVIEW_KEYS.length).toBe(6)
    expect([...XHS_METRIC_KEYS].length).toBe(8)
    expect(metricDefOf('notes').source).toBe('note_table')
    expect(metricDefOf('avg_watch').source).toBe('none')
  })

  it('★天生取不到的那两项各自带着一句「为什么」,界面照着说', () => {
    expect(metricDefOf('avg_watch').absent_why).toContain('平台没给')
    expect(metricDefOf('notes').absent_why).toContain('发布于')
  })
})
