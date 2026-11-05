import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopBar } from '../src/client/TopBar.tsx'
import type { RegistryCount } from '../src/client/agentRegistryView.ts'
import { TOPBAR_HOVER_CLOSE_MS, TOPBAR_HOVER_OPEN_MS, popoverClamp, popoverShift } from '../src/client/topbarPopover.ts'

afterEach(cleanup)

const LAMPS = [{ id: 'dsh', name: '事务官', color: 'teal' }, { id: 'claude', name: 'Claude', color: 'off' }]

describe('顶条状态区(2026-08-25 版面重排:组件条退休,存储/性能改为顶条常显)', () => {
  it('存储/性能两格常显在顶条,数值原样', () => {
    render(
      <TopBar
        lamps={LAMPS}
        now="10:03"
        storage={{ error: false, valueText: '62% · 剩 180G', alert: false }}
        performance={{ error: false, valueText: '54% 空闲 · 16G' }}
        onOpenSettings={() => {}}
      />,
    )
    expect(within(screen.getByRole('group', { name: '存储' })).getByText('62% · 剩 180G')).toBeTruthy()
    expect(within(screen.getByRole('group', { name: '性能' })).getByText('54% 空闲 · 16G')).toBeTruthy()
  })

  it('磁盘告警态 → data-alert=true(Ben 的盘长期 95%+,这条提示不能没有)', () => {
    render(
      <TopBar
        lamps={LAMPS}
        now="10:03"
        storage={{ error: false, valueText: '97% · 剩 16G', alert: true }}
        performance={{ error: false, valueText: '54% 空闲 · 16G' }}
        onOpenSettings={() => {}}
      />,
    )
    expect(screen.getByRole('group', { name: '存储' })).toHaveAttribute('data-alert', 'true')
  })

  it('未接入时显式标注,不编数(D13)', () => {
    render(
      <TopBar
        lamps={LAMPS}
        now="10:03"
        storage={{ error: true, valueText: '未接入:尚未采样', alert: false }}
        performance={{ error: true, valueText: '未接入:尚未采样' }}
        onOpenSettings={() => {}}
      />,
    )
    expect(screen.getAllByText('未接入:尚未采样')).toHaveLength(2)
  })
})

/**
 * 顶栏上的浮层让窗口槽让路(2026-09-26,卡 TB2;维护者:「悬浮上去还被挡住了」)。
 *
 * 窗位里贴的是真的原生窗,永远盖在 WebView 上 —— 网页里的浮层排不到它前面。所以顶栏这一条上
 * **所有**弹出物(点「N 家」那张登记表、悬停小灯那张)都走同一处 veil:开的时候 POST
 * /dock/veil {on:true},关掉 {on:false},**一次开一次关、配对**。
 */
const DETAIL_LAMPS = [
  { id: 'dsh', name: '事务官', color: 'teal' },
  { id: 'claude', name: 'Claude', color: 'teal', detail: { state: '在跑 · 周报怎么写' } },
  { id: 'muse', name: 'Muse', color: 'off', dim: true, why: 'Muse:没接上,还没读到过它的窗口', detail: { state: '没接上:还没读到 Muse 的窗口' } },
]

const COUNT: RegistryCount = {
  total: 2,
  text: '这台电脑上 2 家 Agent 客户端',
  label: '2 家',
  candidates: [{ id: 'com.example.maybe', name: 'Maybe AI', why: '有会话列表,但看不出在不在跑' }],
  // 认出是 AI 应用、窗口却读不到的那几家(2026-10-01):这张用例里没有,那一段就不画。
  unreadable: [],
  items: [
    { id: 'claude', name: 'Claude', self: false, icon: false, tint: '#8f8f96', connected: true, why: 'Claude:在跑 · 周报怎么写' },
    { id: 'muse', name: 'Muse', self: false, icon: false, tint: '#8f8f96', connected: false, why: 'Muse:没接上,还没读到过它的窗口' },
  ],
}

function veilSpy() {
  const calls: boolean[] = []
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/dock/veil')) calls.push((JSON.parse(String(init?.body)) as { on: boolean }).on)
    return { ok: true, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function renderBar(veil: { baseUrl: string, fetchImpl: typeof fetch }) {
  render(
    <TopBar
      lamps={DETAIL_LAMPS}
      agentCount={COUNT}
      talk={{ baseUrl: 'http://wb', fetchImpl: veil.fetchImpl }}
      veil={veil}
      now="10:03"
      storage={{ error: false, valueText: '—', alert: false }}
      performance={{ error: false, valueText: '—' }}
      onOpenSettings={() => {}}
    />,
  )
}

describe('顶栏浮层一开,窗口槽就让路(卡 TB2:所有弹出物同一处)', () => {
  it('★点「N 家」开面板 → veil 一次;关掉 → 配对回来一次', async () => {
    const { calls, fetchImpl } = veilSpy()
    renderBar({ baseUrl: 'http://wb', fetchImpl })
    expect(calls).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: COUNT.text }))
    expect(screen.getByRole('dialog', { name: COUNT.text })).toBeInTheDocument()
    await waitFor(() => expect(calls).toEqual([true]))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: COUNT.text })).toBeNull()
    await waitFor(() => expect(calls).toEqual([true, false]))
  })

  it('★点小灯那一张也走同一处(不各写一套):开一次、关一次', async () => {
    const { calls, fetchImpl } = veilSpy()
    renderBar({ baseUrl: 'http://wb', fetchImpl })
    fireEvent.click(screen.getByRole('button', { name: 'Claude 的详情' }))
    await waitFor(() => expect(calls).toEqual([true]))
    fireEvent.click(screen.getByRole('button', { name: 'Claude 的详情' }))
    await waitFor(() => expect(calls).toEqual([true, false]))
  })

  it('★悬停:悬够一小段时间才开、才让路(鼠标扫过不闪);移开就收、配对回来', async () => {
    vi.useFakeTimers()
    try {
      const { calls, fetchImpl } = veilSpy()
      renderBar({ baseUrl: 'http://wb', fetchImpl })
      const slot = screen.getByRole('button', { name: 'Claude 的详情' }).parentElement as HTMLElement
      // 扫过:还没到那一小段时间就走了 —— 一张也不开、一条 veil 都不发。
      fireEvent.mouseEnter(slot)
      act(() => { vi.advanceTimersByTime(TOPBAR_HOVER_OPEN_MS - 50) })
      fireEvent.mouseLeave(slot)
      act(() => { vi.advanceTimersByTime(TOPBAR_HOVER_OPEN_MS + TOPBAR_HOVER_CLOSE_MS) })
      expect(screen.queryByRole('dialog', { name: 'Claude' })).toBeNull()
      expect(calls).toEqual([])
      // 真悬住:开了,窗位让路一次。
      fireEvent.mouseEnter(slot)
      act(() => { vi.advanceTimersByTime(TOPBAR_HOVER_OPEN_MS + 10) })
      expect(screen.getByRole('dialog', { name: 'Claude' })).toBeInTheDocument()
      await act(async () => { await Promise.resolve() })
      expect(calls).toEqual([true])
      // 移开:收起,配对回来。
      fireEvent.mouseLeave(slot)
      act(() => { vi.advanceTimersByTime(TOPBAR_HOVER_CLOSE_MS + 10) })
      expect(screen.queryByRole('dialog', { name: 'Claude' })).toBeNull()
      await act(async () => { await Promise.resolve() })
      expect(calls).toEqual([true, false])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('不在壳里(没给 veil):浮层照开照关,一条都不发', async () => {
    const { calls, fetchImpl } = veilSpy()
    render(
      <TopBar
        lamps={DETAIL_LAMPS}
        agentCount={COUNT}
        talk={{ baseUrl: 'http://wb', fetchImpl }}
        now="10:03"
        storage={{ error: false, valueText: '—', alert: false }}
        performance={{ error: false, valueText: '—' }}
        onOpenSettings={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: COUNT.text }))
    expect(screen.getByRole('dialog', { name: COUNT.text })).toBeInTheDocument()
    await waitFor(() => expect(calls).toEqual([]))
  })
})

describe('浮层躲开窗位(壳没本事让路时的退路,卡 TB2 第 3 条)', () => {
  const slot = { x: 300, y: 120, w: 600, h: 500 }
  const viewport = { w: 1440, h: 900 }

  it('★与窗位横向重叠 → 整块挪到窗位左边;不重叠 → 一动不动', () => {
    // 锚点在 x=320(压在窗位上):290 宽的那一张挪到 300-8-290=2 …放不下(离边不足 8),于是挪到窗位右边。
    expect(popoverShift({ x: 320, y: 30, w: 80, h: 20 }, 290, slot, viewport)).toBe(slot.x + slot.w + 8)
    // 窗位靠右时挪到它左边。
    const right = { x: 700, y: 120, w: 600, h: 500 }
    expect(popoverShift({ x: 680, y: 30, w: 290, h: 20 }, 290, right, viewport)).toBe(700 - 8 - 290)
    // 压根不重叠:不挪。
    expect(popoverShift({ x: 10, y: 30, w: 80, h: 20 }, 200, right, viewport)).toBeUndefined()
    // 量不到窗位(窗位收起 / 纯净模式 / 不在壳里):不挪。
    expect(popoverShift({ x: 320, y: 30, w: 80, h: 20 }, 290, undefined, viewport)).toBeUndefined()
    expect(popoverShift({ x: 320, y: 30, w: 80, h: 20 }, 290, { x: 0, y: 0, w: 0, h: 0 }, viewport)).toBeUndefined()
    // 窗位铺满整条视口宽:两边都放不下,不硬挪(那种情况只剩 veil 能救)。
    expect(popoverShift({ x: 20, y: 30, w: 80, h: 20 }, 290, { x: 0, y: 0, w: 1440, h: 500 }, viewport)).toBeUndefined()
  })

  it('开面板时按实量的位置挪(jsdom 量出来是 0 矩形 → 不挪,浮层照原位)', () => {
    const { fetchImpl } = veilSpy()
    renderBar({ baseUrl: 'http://wb', fetchImpl })
    fireEvent.click(screen.getByRole('button', { name: COUNT.text }))
    expect(screen.getByRole('dialog', { name: COUNT.text })).not.toHaveAttribute('style', expect.stringContaining('left'))
  })
})

describe('登记表面板:只有真要他判断的那几家常显两颗键(卡 TB2 追加)', () => {
  it('★已接上的行默认没有可见的「这不是 Agent」;拿不准的那几家常显「接上 / 这不是 Agent」', () => {
    const { fetchImpl } = veilSpy()
    renderBar({ baseUrl: 'http://wb', fetchImpl })
    fireEvent.click(screen.getByRole('button', { name: COUNT.text }))
    const card = screen.getByRole('dialog', { name: COUNT.text })
    // 已经在登记表里的那两家:一颗撤销键都不显(维护者:「每一个下面都有一个『这不是 Agent』的按钮,这很蠢」)。
    expect(within(card).queryByLabelText('这不是 Agent:Claude')).toBeNull()
    expect(within(card).queryByLabelText('这不是 Agent:Muse')).toBeNull()
    // 拿不准的那一家:两颗键都在(这才是真要他判断的)。
    expect(within(card).getByLabelText('接上:Maybe AI')).toBeInTheDocument()
    expect(within(card).getByLabelText('这不是 Agent:Maybe AI')).toBeInTheDocument()
    // 判错了要撤:那一行的「⋯」点开才有。
    fireEvent.click(within(card).getByRole('button', { name: 'Claude:更多' }))
    expect(within(card).getByLabelText('这不是 Agent:Claude')).toBeInTheDocument()
  })

  it('「接上」→ POST /agents/connect(那一家的 id)', async () => {
    const calls: { url: string, body: unknown }[] = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return { ok: true, json: async () => ({ note: '好,接上了' }) } as Response
    }) as unknown as typeof fetch
    renderBar({ baseUrl: 'http://wb', fetchImpl })
    fireEvent.click(screen.getByRole('button', { name: COUNT.text }))
    fireEvent.click(screen.getByLabelText('接上:Maybe AI'))
    expect(await screen.findByText('好,接上了')).toBeInTheDocument()
    expect(calls.some(one => one.url === 'http://wb/agents/connect' && (one.body as { id: string }).id === 'com.example.maybe')).toBe(true)
  })
})

/**
 * 悬停那一张的位置与内容(2026-09-26,卡 AC)。
 *
 * 维护者 21:40 对着真壳截图:「悬停顶栏 Claude 那一格,浮层跑到屏幕最右边(不在那一格下面),
 * 里面还有『这不是 Agent』按钮」。两条都在这儿钉住:几何只夹回视口(不躲窗位),那一张里没有那颗键。
 */
describe('悬停那一张:锚在被悬停那一格下面,里面不放「这不是 Agent」(卡 AC)', () => {
  const viewport = { w: 1440, h: 900 }

  it('★popoverClamp 只夹回视口,不因为窗位把浮层甩走', () => {
    const anchor = { x: 320, y: 30, w: 80, h: 20 }
    // 压在窗位上也不挪 —— 窗位那一半交给 veil(这正是 popoverShift 会甩到 x=908 的那一格)。
    expect(popoverClamp(anchor, 290, viewport, -6)).toBeUndefined()
    expect(popoverShift(anchor, 290, { x: 300, y: 120, w: 600, h: 500 }, viewport, -6)).toBe(908)
    // 靠右装不下:往左收边,右沿贴视口内侧(1440-8-290=1142)。
    expect(popoverClamp({ x: 1380, y: 30, w: 40, h: 20 }, 290, viewport, -6)).toBe(1142)
    // 靠左溢出:贴左边留 8。
    expect(popoverClamp({ x: 2, y: 30, w: 40, h: 20 }, 290, viewport, -6)).toBe(8)
    // 视口比浮层还窄:贴左边,别推得更远。
    expect(popoverClamp({ x: 100, y: 30, w: 40, h: 20 }, 290, { w: 280, h: 600 }, -6)).toBe(8)
    // 量不到那一格 / 量不到视口:不挪。
    expect(popoverClamp({ x: 0, y: 0, w: 0, h: 0 }, 290, viewport, -6)).toBeUndefined()
    expect(popoverClamp({ x: 320, y: 30, w: 80, h: 20 }, 290, undefined, -6)).toBeUndefined()
  })

  it('★悬停开出来的那一张里没有「这不是 Agent」(那颗键只在「N 家」面板每行的「⋯」里)', () => {
    vi.useFakeTimers()
    try {
      const { fetchImpl } = veilSpy()
      renderBar({ baseUrl: 'http://wb', fetchImpl })
      const slot = screen.getByRole('button', { name: 'Claude 的详情' }).parentElement as HTMLElement
      fireEvent.mouseEnter(slot)
      act(() => { vi.advanceTimersByTime(TOPBAR_HOVER_OPEN_MS + 10) })
      const card = screen.getByRole('dialog', { name: 'Claude' })
      expect(within(card).getByText('在跑 · 周报怎么写')).toBeInTheDocument()
      expect(within(card).queryByLabelText('这不是 Agent:Claude')).toBeNull()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('★点开那一张里也没有(点开与悬停是同一张)', () => {
    const { fetchImpl } = veilSpy()
    renderBar({ baseUrl: 'http://wb', fetchImpl })
    fireEvent.click(screen.getByRole('button', { name: 'Claude 的详情' }))
    const card = screen.getByRole('dialog', { name: 'Claude' })
    expect(within(card).queryByLabelText('这不是 Agent:Claude')).toBeNull()
  })
})

/**
 * 2026-09-27(维护者:「还是拖不动,你要不加一个按钮,一键搬运到另一个桌面吧」)。
 * 壳里的顶栏多一颗「换屏」:点一下发 `titlebar_move_screen` 给壳,壳把窗口搬到下一块屏并按那块屏铺好。
 * 不在壳里(浏览器标签页)不画 —— 那里没有窗口可搬。
 */
describe('顶栏「换屏」', () => {
  it('★壳里有这颗键,点了发 titlebar_move_screen;浏览器里没有', async () => {
    const { TopBar } = await import('../src/client/TopBar.tsx')
    const { render, screen, fireEvent } = await import('@testing-library/react')
    const posted: unknown[] = []
    ;(window as unknown as { webkit?: unknown }).webkit = { messageHandlers: { benWorkbenchShell: { postMessage: (m: unknown) => posted.push(m) } } }
    const widget = { label: '', value: '', level: 'ok' } as never
    const { unmount } = render(<TopBar lamps={[]} now="10:00" storage={widget} performance={widget} onOpenSettings={() => {}} shell />)
    fireEvent.click(screen.getByRole('button', { name: '换屏' }))
    expect(posted).toContainEqual({ type: 'titlebar_move_screen' })
    unmount()
    render(<TopBar lamps={[]} now="10:00" storage={widget} performance={widget} onOpenSettings={() => {}} />)
    expect(screen.queryByRole('button', { name: '换屏' })).toBeNull()
    delete (window as unknown as { webkit?: unknown }).webkit
  })
})
