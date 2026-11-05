/**
 * 额度面板:**一套行,不分「老四格」和「别的家」**(2026-09-26,卡 QU)。
 *
 * 维护者 16:30 看着面板说:「他们(Muse、豆包办公、Manus、Grok Bot、Antigravity)的样式,和上面的 3 家
 * 可以说完全不一样,只有文字…你能不能统一一下」。当时那几家是左名字 + 右一个 20px 大字、长句直接铺在行下;
 * 老四格是 `名字 | 横条 | ▸ 说明`。
 *
 * 这份文件把**统一之后的那副骨架**钉死,而且是按 DOM 钉的(类名 + 有没有那根填充 + 右端那个字),
 * 不是按截图 —— 样式统一这件事,类名一样才是真一样:两边用同一批 `ben-wb__usage-q*`,
 * CSS 就不可能再各写一套(这正是当初跑偏的地方)。
 *
 * 三格各画成什么,见 `AgentQuotaCells.tsx` 的 `quotaBar`:
 * | 三格                     | 横条       | 右端那个字     |
 * | 有数、有分母             | 按比例填   | 62%            |
 * | 有数、没分母(Manus 积分)| 只画轨道   | 2,690 积分     |
 * | 不限                     | 整条实心淡 | 不限           |
 * | 没接上                   | 只画轨道   | 没接上         |
 *
 * 2026-09-26(卡 QD)又多一条:**窗口型额度的那几家一扇窗一条**(豆包办公的「当前时段 / 近 7 天」
 * = Claude 的「5h / 周」),见 `quotaBarRows`。同一种东西该长同一个样,这也是「统一」的一部分。
 *
 * **右端那个字是硬规矩**:三格不靠颜色分(同 dispatchEyesStyle.ts 头上那条)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentQuotaView, QuotaEntry } from '../src/protocol.ts'
import { QuotaPanel } from '../src/client/QuotaPanel.tsx'
import { quotaBar, quotaBarRows } from '../src/client/AgentQuotaCells.tsx'

afterEach(cleanup)

const NOW = '2026-09-26T10:00:00.000Z'

/** 老四格里的一格(有窗口 = 画横条),用来比对「别的家」是不是真靠到同一副骨架上了。 */
const CLAUDE_WINDOWS: QuotaEntry = {
  kind: 'quota',
  windows: [{ label: '5h', left_pct: 81 }, { label: '周', left_pct: 62 }],
}

/** 有数、有分母:Muse 的「使用情况」页上那个百分比。 */
const MUSE: AgentQuotaView = {
  id: 'muse', title: 'Muse', state: 'numbers', level: 'ok', left_pct: 62,
  line: '本周还剩约 62%', source: '18:40 在 Muse 窗口上读到的(「使用情况」页上写着「剩余 62%」)',
}
/** 有数、**没分母**:Manus 首页右上角那一格积分 —— 它自己没有任何地方写着「总共多少」。 */
const MANUS: AgentQuotaView = {
  id: 'manus', title: 'Manus', state: 'numbers', level: 'ok',
  line: '剩 2,690 积分', left: { text: '2,690', unit: '积分', amount: 2690 },
  source: '18:40 在 Manus 窗口上读到的',
}
/**
 * 不限:查实过的 —— **它自己界面上写着**。
 * 2026-09-26(卡 QD)起这一格里**没有豆包办公**了:它有额度(下面那份 `DOUBAO`),
 * 上午那版「不限」是按一句话写的,当晚被那一页的截图打回来。留在这一格里的是 Muse 那一页上的「无限制」。
 */
const UNLIMITED: AgentQuotaView = {
  id: 'muse-free', title: 'Muse Free', state: 'unlimited', line: '不限',
  source: '18:40 在 Muse 窗口上读到的(「使用情况」页上写着「无限制」)',
}
/**
 * 有数、**窗口型**(一个短时段 + 一个长时段):豆包办公「订阅与额度管理」页上的「当前时段 / 近 7 天」。
 * 与 Claude 的「5h / 周」是同一种东西,所以画出来也该是同一副样子 —— 两条横条(卡 QD)。
 */
const DOUBAO: AgentQuotaView = {
  id: 'doubao', title: '豆包办公', state: 'numbers', level: 'ok', left_pct: 99,
  windows: [{ label: '5h', left_pct: 99, reset_at: '2026-09-26T15:00:00.000Z' }, { label: '周', left_pct: 99 }],
  line: '5 小时窗口还剩约 99%', source: '19:00 在豆包办公窗口上读到的(「订阅与额度管理」页上写着「当前时段 已用 <1%」)',
}
/**
 * 没接上:原因 + 该他自己去点的那一步(都在同一句话里)。
 *
 * ★ 2026-09-30 维护者拍板把「带我过去」全删(见 `docs/决策记录.md` 末尾那一条):这一行原来带一个
 * `fix: { kind: 'show_app', label: '带我过去', hint: '把 Grok Bot 叫到台前…' }`;键没了,
 * 那句 hint 由服务端并进 `why` / `line`,界面只管把它摆进「▸ 说明」里。
 */
const GROK: AgentQuotaView = {
  id: 'grok', title: 'Grok Bot', state: 'unconnected',
  line: '没接上:Grok Bot 没开着 —— 把 Grok Bot 叫到台前,右上角那一格就是额度',
  why: 'Grok Bot 没开着,额度只在它自己窗口上 —— 把 Grok Bot 叫到台前,右上角那一格就是额度',
}

const ALL = [MUSE, MANUS, UNLIMITED, GROK]

function row(name: string): HTMLElement {
  return screen.getByRole('listitem', { name })
}
/** 那一行的横条骨架:轨道 + 里面那根填充(没有填充就是 null)。 */
function bar(name: string) {
  const at = row(name)
  const bars = at.querySelectorAll('.ben-wb__usage-qbar')
  const track = at.querySelector('.ben-wb__usage-qtrack')
  return {
    count: bars.length,
    track,
    fill: track?.querySelector('i') ?? null,
    /** 右端那个字(老四格写百分比的那一栏)。 */
    right: at.querySelector('.ben-wb__usage-qpct')?.textContent ?? null,
  }
}

describe('★一套行:别的家用的是老四格那一副骨架(同一批类名)', () => {
  it('老四格的一行与别的家的一行,横条骨架是同一批类名 —— 类名一样,CSS 才不可能再各写一套', () => {
    render(<QuotaPanel quota={{ claude: CLAUDE_WINDOWS }} now={NOW} agentQuota={ALL} />)
    // 老四格:两个窗口两条,右端是百分比。
    const claude = row('Claude')
    expect(claude.querySelectorAll('.ben-wb__usage-qbars')).toHaveLength(1)
    expect(claude.querySelectorAll('.ben-wb__usage-qbar')).toHaveLength(2)
    expect(claude.querySelectorAll('.ben-wb__usage-qtrack')).toHaveLength(2)
    // 别的家:同样的 qbars / qbar / qtrack / qpct,只是**一条**(服务端顶上来的就是一个数)。
    for (const name of ['Muse', 'Manus', 'Muse Free', 'Grok Bot']) {
      const at = row(name)
      expect(at.querySelectorAll('.ben-wb__usage-qbars'), name).toHaveLength(1)
      expect(at.querySelectorAll('.ben-wb__usage-qbar'), name).toHaveLength(1)
      expect(at.querySelectorAll('.ben-wb__usage-qtrack'), name).toHaveLength(1)
      expect(at.querySelectorAll('.ben-wb__usage-qpct'), name).toHaveLength(1)
    }
  })

  it('★别的家不再画行右边那个大字(ben-wb__usage-qval)—— 值挪到了横条右端,位置与老四格的百分比同一栏', () => {
    render(<QuotaPanel quota={{ claude: CLAUDE_WINDOWS }} now={NOW} agentQuota={ALL} />)
    for (const name of ['Muse', 'Manus', 'Muse Free', 'Grok Bot']) {
      expect(row(name).querySelector('.ben-wb__usage-qval'), name).toBeNull()
    }
  })

  it('横条那一栏的标签留空:别的家只有一条,没有要分辨的窗口;空栏占着同样的宽度,横条起点才和老四格对得齐', () => {
    render(<QuotaPanel quota={{ claude: CLAUDE_WINDOWS }} now={NOW} agentQuota={ALL} />)
    // 空着,但**在**——撤掉它横条就往左跑,和老四格错开。
    const label = row('Muse').querySelector('.ben-wb__usage-qlabel')
    expect(label).not.toBeNull()
    expect(label?.textContent).toBe('')
    // 老四格那边照旧写着窗口名。
    expect(row('Claude').querySelector('.ben-wb__usage-qlabel')?.textContent).toBe('5时')
  })

  it('老四格一个字节没动:它那条横条上没有卡 QU 新加的 data-fill 钩子', () => {
    render(<QuotaPanel quota={{ claude: CLAUDE_WINDOWS }} now={NOW} agentQuota={ALL} />)
    for (const track of row('Claude').querySelectorAll('.ben-wb__usage-qtrack')) {
      expect(track.getAttribute('data-fill')).toBeNull()
    }
  })
})

describe('★三格各画成什么(横条 + 右端那个字;不靠颜色)', () => {
  it('有数、有分母 → 横条按 left_pct 填,右端写百分比', () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={ALL} />)
    const muse = bar('Muse')
    expect(muse.count).toBe(1)
    expect(muse.fill).not.toBeNull()
    expect(muse.fill).toHaveStyle({ width: '62%' })
    expect(muse.right).toBe('62%')
  })

  it('★有数、没分母(Manus 的积分)→ 只画轨道、不画填充,右端照实写「2,690 积分」', () => {
    // 老四格那条老纪律:余额没有分母,画条要先假设一个「满」值,那是编的。
    // 数是真的,只有那根填充是假的 —— 所以省掉填充、留下骨架。
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={ALL} />)
    const manus = bar('Manus')
    expect(manus.track).not.toBeNull()
    expect(manus.fill).toBeNull()
    expect(manus.track).toHaveAttribute('data-fill', 'open')
    expect(manus.right).toBe('2,690 积分')
  })

  it('不限 → 横条整条实心(淡色靠 CSS),右端写「不限」', () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={ALL} />)
    const free = bar('Muse Free')
    expect(free.fill).not.toBeNull()
    expect(free.fill).toHaveStyle({ width: '100%' })
    expect(free.fill).toHaveAttribute('data-fill', 'full')
    expect(free.right).toBe('不限')
  })

  /**
   * ★ 卡 QD(2026-09-26):**窗口型额度的那几家照老四格画,一扇窗一条。**
   *
   * 豆包办公的「当前时段 / 近 7 天」就是 Claude 的「5h / 周」—— 同一种东西该长同一个样,
   * 所以这里连类名到标签栏都与老四格逐字相同,而不是挑最紧的那一条画一根。
   * (那一句 `line` 仍然只说最紧的那一扇:派活确认点、手机上读的是一句话,不是一张图。)
   */
  it('★窗口型(豆包办公:当前时段 / 近 7 天)→ 两条横条,标签栏照写窗口名,右端各写自己的百分比', () => {
    render(<QuotaPanel quota={{ claude: CLAUDE_WINDOWS }} now={NOW} agentQuota={[DOUBAO]} />)
    const doubao = row('豆包办公')
    expect(doubao.querySelectorAll('.ben-wb__usage-qbar')).toHaveLength(2)
    // 老四格那一行有几条、标签写什么、右端写什么 —— 逐格对照,不是「差不多」。
    expect([...doubao.querySelectorAll('.ben-wb__usage-qlabel')].map(one => one.textContent))
      .toEqual([...row('Claude').querySelectorAll('.ben-wb__usage-qlabel')].map(one => one.textContent))
    expect([...doubao.querySelectorAll('.ben-wb__usage-qpct')].map(one => one.textContent)).toEqual(['99%', '99%'])
    for (const track of doubao.querySelectorAll('.ben-wb__usage-qtrack i')) {
      expect(track).toHaveStyle({ width: '99%' })
    }
    expect(doubao).not.toHaveTextContent('不限')
  })

  it('quotaBarRows:有 windows 就一扇一条,没有就一条(标签留空、右端那个字照三格说)', () => {
    expect(quotaBarRows(DOUBAO)).toEqual([
      { label: '5h', fill: { kind: 'pct', pct: 99 }, right: '99%' },
      { label: '周', fill: { kind: 'pct', pct: 99 }, right: '99%' },
    ])
    expect(quotaBarRows(MUSE)).toEqual([{ label: '', fill: { kind: 'pct', pct: 62 }, right: '62%' }])
    expect(quotaBarRows(MANUS)).toEqual([{ label: '', fill: { kind: 'open' }, right: '2,690 积分' }])
    expect(quotaBarRows(GROK)).toEqual([{ label: '', fill: { kind: 'none' }, right: '没接上' }])
    expect(quotaBarRows(UNLIMITED)).toEqual([{ label: '', fill: { kind: 'full' }, right: '不限' }])
    // 没接上 / 不限那两格哪怕带着上次那几扇窗,也不画成几条数(状态说了不算数)。
    expect(quotaBarRows({ ...DOUBAO, state: 'unconnected' })).toEqual([{ label: '', fill: { kind: 'none' }, right: '没接上' }])
  })

  it('没接上 → 横条只画轨道(空心),右端写「没接上」', () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={ALL} />)
    const grok = bar('Grok Bot')
    expect(grok.track).not.toBeNull()
    expect(grok.fill).toBeNull()
    expect(grok.track).toHaveAttribute('data-fill', 'none')
    expect(grok.right).toBe('没接上')
  })

  it('★「只画轨道」那两种靠右端那个字分辨,不靠颜色 —— 积分那行写着数,没接上那行写着「没接上」', () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={ALL} />)
    expect(bar('Manus').fill).toBeNull()
    expect(bar('Grok Bot').fill).toBeNull()
    expect(bar('Manus').right).not.toBe(bar('Grok Bot').right)
  })

  it('快用完 / 用完了照老四格同样的黄 / 红(条与右端那个字同一个 data-level)', () => {
    const low: AgentQuotaView = { ...MUSE, level: 'low', left_pct: 9, line: '只剩约 9%,快用完了' }
    const gone: AgentQuotaView = { id: 'x', title: 'Antigravity', state: 'numbers', level: 'empty', left_pct: 0, line: '额度用完了' }
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={[low, gone]} />)
    expect(row('Muse').querySelector('.ben-wb__usage-qtrack i')).toHaveAttribute('data-level', 'warn')
    expect(row('Muse').querySelector('.ben-wb__usage-qpct')).toHaveAttribute('data-level', 'warn')
    expect(row('Antigravity').querySelector('.ben-wb__usage-qpct')).toHaveAttribute('data-level', 'danger')
    // 用完了那一格:右端先写一个字,不是只把条染红。
    expect(bar('Antigravity').right).toBe('用完了')
  })

  it('quotaBar 是纯函数,三格 ↔ 四种画法一一对得上(横条怎么画只在这一处判)', () => {
    expect(quotaBar(MUSE)).toEqual({ kind: 'pct', pct: 62 })
    expect(quotaBar(MANUS)).toEqual({ kind: 'open' })
    expect(quotaBar(UNLIMITED)).toEqual({ kind: 'full' })
    expect(quotaBar(GROK)).toEqual({ kind: 'none' })
    // 服务端给了越界的数也不画到格子外面去。
    expect(quotaBar({ ...MUSE, left_pct: 140 })).toEqual({ kind: 'pct', pct: 100 })
    expect(quotaBar({ ...MUSE, left_pct: -5 })).toEqual({ kind: 'pct', pct: 0 })
  })
})

describe('★「▸ 说明」:别的家也给同一个入口,长句不再铺在行下', () => {
  it('出处 / 原因 / 修法那句都收进「说明」里,展开就看得见', async () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={ALL} baseUrl="http://wb" />)
    for (const name of ['Muse', 'Manus', 'Muse Free', 'Grok Bot']) {
      expect(row(name).querySelector('.ben-wb__usage-qdetails'), name).not.toBeNull()
      expect(within(row(name)).getByText('说明'), name).toBeInTheDocument()
    }
    // 展开有数那一家 → 里面是出处(几点、在哪读到的)。
    const muse = row('Muse')
    await userEvent.click(within(muse).getByText('说明'))
    expect(muse.querySelector('.ben-wb__usage-qdetails')).toHaveAttribute('open')
    expect(within(muse).getByText(/在 Muse 窗口上读到的/)).toBeInTheDocument()
  })

  it('不限那一家展开是出处(查实过的:它自己界面上写着)', async () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={ALL} />)
    const free = row('Muse Free')
    await userEvent.click(within(free).getByText('说明'))
    expect(within(free).getByText(/「使用情况」页上写着「无限制」/)).toBeInTheDocument()
  })

  it('没接上那一家展开是原因 + 该他去点的那一步(同一句);长句**不再**是行下的直接子元素', async () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={ALL} baseUrl="http://wb" />)
    const grok = row('Grok Bot')
    await userEvent.click(within(grok).getByText('说明'))
    const details = grok.querySelector('.ben-wb__usage-qdetails') as HTMLElement
    // 2026-09-30 起原因与该做的那一步是**同一句**(键删了,hint 并进了 why)。
    expect(within(details).getByText('Grok Bot 没开着,额度只在它自己窗口上 —— 把 Grok Bot 叫到台前,右上角那一格就是额度')).toBeInTheDocument()
    // 那句长话不许铺在行下:写着它的那个元素必须在「▸ 说明」里面。
    const said = within(grok).getByText('Grok Bot 没开着,额度只在它自己窗口上 —— 把 Grok Bot 叫到台前,右上角那一格就是额度')
    expect(details.contains(said)).toBe(true)
    for (const child of grok.children) {
      if (child === details) continue
      expect(child.textContent).not.toContain('把 Grok Bot 叫到台前,右上角那一格就是额度')
    }
  })

  // 2026-09-27:「读一下」撤了(维护者:「读一下这个东西就不要了吧,不止交互,包括功能」)。
  // ★ 2026-09-30 维护者拍板全删「带我过去」:没接上那一行于是**一颗键都没有了**。
  it('没接上那一行一颗键都不画(2026-09-30 维护者拍板全删「带我过去」;「读一下」09-27 已撤)', () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={ALL} baseUrl="http://wb" />)
    const grok = row('Grok Bot')
    expect(within(grok).queryByRole('button', { name: '带我过去' })).toBeNull()
    expect(within(grok).queryByRole('button', { name: '读一下' })).toBeNull()
    // 剩下的只有「▸ 说明」那个展开器(summary,不是 button)。
    expect(within(grok).queryAllByRole('button')).toHaveLength(0)
    expect(within(grok).getByText('说明')).toBeInTheDocument()
  })
})

/**
 * 2026-09-27 12:20 改(维护者对着截图:「额度那里的按钮是没有了,但是还有一堆文字……你这属于做事做一半」)。
 * 数老了那一行**和别家一个样**:横条 + 百分比 + 「▸ 说明」,只在名字旁边一个小字「旧」、整行画淡;
 * 「昨晚 21:52 读到的 · 数字可能旧」与出处原话一律收进「说明」,不在行下摊一大段。
 */
describe('数已经老了那一格:行上只有横条与百分比,话都收进「说明」', () => {
  const STALE: AgentQuotaView = {
    ...MUSE, stale: true,
    line: '本周还剩约 62% · 昨晚 20:42 读到的 · Muse 没在跑,数字可能旧',
  }

  it('★行下不摊那一段话;名字旁什么都不加;「说明」里有几点读到的', async () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={[STALE]} />)
    const muse = row('Muse')
    expect(muse).toHaveAttribute('data-stale', 'true')
    expect(muse.querySelector('.ben-wb__usage-qnote[data-kept="true"]')).toBeNull()
    // 名字旁不加任何字(维护者 12:20:「留那个旧是干什么用的,去掉吧」)。
    expect(muse.querySelector('.ben-wb__usage-qstale')).toBeNull()
    await userEvent.click(within(muse).getByText('说明'))
    expect(muse.querySelector('.ben-wb__usage-qdetails')?.textContent).toContain('昨晚 20:42 读到的')
  })

  // 2026-09-30:「带我过去」那一档删了,这一例改用还留着的那一档(「去授权」)—— 钉的是同一件事:
  // 有修法那句时,「说明」里两句(几点读到的 / 该做的那一步)都在。
  it('数老了、还有修法那句时,「说明」里两句都在', async () => {
    const withHint: AgentQuotaView = { ...STALE, fix: { kind: 'grant_ax', label: '去授权', hint: '把 Muse 叫到台前,「使用情况」那一页就是额度' } }
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={[withHint]} baseUrl="http://wb" />)
    const muse = row('Muse')
    await userEvent.click(within(muse).getByText('说明'))
    expect(within(muse).getByText('把 Muse 叫到台前,「使用情况」那一页就是额度')).toBeInTheDocument()
    expect(muse.querySelector('.ben-wb__usage-qdetails')?.textContent).toContain('昨晚 20:42 读到的')
  })

  it('数老了也照样画横条(它是有数的,只是旧了)—— 淡色由 data-stale 那套 CSS 管', () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={[STALE]} />)
    expect(bar('Muse').fill).toHaveStyle({ width: '62%' })
    expect(bar('Muse').right).toBe('62%')
  })
})

/* 「读一下」按完那一句(卡 MQ3)的三条:按钮撤了(2026-09-27),一并撤掉。 */
