/**
 * 横屏模块挪区 · 渲染那一层(2026-09-20,分支 fix/landscape-module-move)。
 *
 * 纯函数那一层在 tests/client-landscape-regions.test.ts。这份钉的是 Ben 真正看得见的东西:
 *   ① 在标题栏按 Alt+↑之后,那一格**真的出现在项目区下面**(在 .ben-wb__land-side 里,不在底部一排);
 *   ② 标题栏支持键盘、固定区域不可拖动(底部格的下箭头是死的,紧挨项目区那格的上箭头是死的);
 *   ③ 底部一排少一格仍然等宽、空了整条收起;
 *   ④ 挪出来的样子落了盘(POST /layout 带 region),「恢复默认布局」放回底部。
 *
 * jsdom 里驱动方向切换同 tests/client-landscape.test.tsx:改 innerWidth/innerHeight + 派发 resize。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { RESET_LAYOUT_LABEL } from '../src/client/TopBar.tsx'
import { CONFIRMS } from '../src/client/ui/index.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import { DEFAULT_MODULE_TITLES } from '../src/templates.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

/** 底部最后一格的正式标题(2026-10-23 起 files 格是 Graphify 图谱,与本体常量共源)。 */
const FILES_TITLE = DEFAULT_MODULE_TITLES.files

configure({ asyncUtilTimeout: 5_000 })

const REAL_WIDTH = window.innerWidth
const REAL_HEIGHT = window.innerHeight

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

afterEach(() => {
  cleanup()
  setViewport(REAL_WIDTH, REAL_HEIGHT)
  window.history.replaceState(null, '', '/')
})

function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

/** 叠上有一扇窗在台前——否则事务官档会盖住槽体(先例见 workbenchLayout.test.tsx)。 */
function snapshot(): WorkbenchState {
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-09-20T10:03:00+08:00',
    stale: false,
    dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
  }
}

function fakeFetchRecording(state: WorkbenchState, calls: { url: string, body: unknown }[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
}

function props(options: { state?: WorkbenchState, fetchImpl?: typeof fetch } = {}): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }
  const state = options.state ?? snapshot()
  return {
    useStore: selector => selector(instance.getSnapshot()),
    actions: instance.actions,
    useWorkspaces: selector => selector(workspaceState as never),
    useSessions: selector => selector({} as never),
    ...UNUSED_STANDARD_PROPS,
    openWorkspace: async () => {},
    openSession: () => {},
    serviceFetch: options.fetchImpl ?? (vi.fn(async () => ({
      ok: true, json: async () => state,
    })) as unknown as typeof fetch),
    servicePollMs: 0,
    serviceWebSocket: fakeWebSocket(),
  }
}

/** 渲染一块 2560×1440 的横屏工作台,等到底部一排真的画出来。 */
async function renderLandscape(overrides: Parameters<typeof props>[0] = {}): Promise<void> {
  setViewport(2560, 1440)
  render(<WorkbenchOverlay {...props(overrides)} />)
  await screen.findByRole('heading', { name: '工作台' })
  await waitFor(() => expect(document.querySelector('.ben-wb__land-deck')).not.toBeNull())
}

/** 某个区域里从头到尾都是哪几个模块(按 DOM 顺序读模块标题)。 */
function regionTitles(selector: string): string[] {
  const region = document.querySelector(selector)
  if (region === null) return []
  return [...region.querySelectorAll('.ben-wb__ttl')].map(node => node.textContent ?? '')
}

function click(name: string): void {
  if (name.endsWith(' 上移') || name.endsWith(' 下移')) {
    const header = screen.getByRole('heading', { name: name.slice(0, -3) }).closest('.ben-wb__modhead')!
    fireEvent.keyDown(header, { altKey: true, key: name.endsWith(' 上移') ? 'ArrowUp' : 'ArrowDown' })
  } else act(() => { screen.getByRole('button', { name }).click() })
}

async function lastPostedLayout(calls: { url: string, body: unknown }[]): Promise<WorkbenchLayout> {
  await waitFor(() => expect(calls.some(c => c.url.endsWith('/layout'))).toBe(true), { timeout: 3000 })
  return (calls.filter(c => c.url.endsWith('/layout')).at(-1)?.body as { layout: WorkbenchLayout }).layout
}

// ───────────────────────────────────────────────────────────────────────────
describe('① 在标题栏按 Alt+↑,那一格真的到了项目区下面(Ben 报的那件事)', () => {
  it('消耗数据在标题栏按一次 Alt+↑ → 出现在右侧栏、排在项目区之后,底部一排里没有它了', async () => {
    await renderLandscape()
    expect(regionTitles('.ben-wb__land-side')).toEqual(['项目区'])
    expect(regionTitles('.ben-wb__land-deck')).toEqual(['消耗数据', '余额 / 额度', '随手记', FILES_TITLE])

    click('消耗数据 上移')

    await waitFor(() => expect(regionTitles('.ben-wb__land-side')).toEqual(['项目区', '消耗数据']))
    expect(regionTitles('.ben-wb__land-deck')).toEqual(['余额 / 额度', '随手记', FILES_TITLE])
  })

  it('余额/额度跟着上来,排在消耗数据下面(Ben 原话里的那两格)', async () => {
    await renderLandscape()

    click('消耗数据 上移')
    await waitFor(() => expect(regionTitles('.ben-wb__land-side')).toEqual(['项目区', '消耗数据']))
    click('余额 / 额度 上移')

    await waitFor(() => expect(regionTitles('.ben-wb__land-side')).toEqual(['项目区', '消耗数据', '余额 / 额度']))
    expect(regionTitles('.ben-wb__land-deck')).toEqual(['随手记', FILES_TITLE])
  })

  it('右侧栏里的那一格再点下移 → 回到底部一排最右', async () => {
    await renderLandscape()
    click('消耗数据 上移')
    await waitFor(() => expect(regionTitles('.ben-wb__land-side')).toEqual(['项目区', '消耗数据']))

    click('消耗数据 下移')

    await waitFor(() => expect(regionTitles('.ben-wb__land-side')).toEqual(['项目区']))
    expect(regionTitles('.ben-wb__land-deck')).toEqual(['余额 / 额度', '随手记', FILES_TITLE, '消耗数据'])
  })

  it('挪出来的样子落了盘:landscape.modules 里那一格带着 region=side', async () => {
    setViewport(2560, 1440)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(document.querySelector('.ben-wb__land-deck')).not.toBeNull())

    click('消耗数据 上移')

    const layout = await lastPostedLayout(calls)
    const usage = layout.landscape?.modules.find(m => m.id === 'usage')
    expect(usage?.region).toBe('side')
    expect(layout.landscape?.modules.find(m => m.id === 'quota')?.region).toBe('deck')
    // 竖屏那一份一字不动。
    expect(layout.modules.find(m => m.id === 'usage')?.region).toBeUndefined()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('② 标题栏替代单独移动按钮,固定区域仍不能挪走', () => {
  it('可移动组件提供标题栏键盘入口,头部只有收起按钮', async () => {
    await renderLandscape()
    const header = screen.getByRole('heading', { name: '消耗数据' }).closest('.ben-wb__modhead')!
    expect(header).toHaveAttribute('data-widget-draggable', 'true')
    expect(header).toHaveAttribute('tabindex', '0')
    expect(screen.queryByRole('button', { name: /上移|下移/ })).toBeNull()
    expect(header.querySelectorAll('button')).toHaveLength(1)
  })

  it('右侧栏中的组件仍可用键盘移动', async () => {
    await renderLandscape()
    click('消耗数据 上移')
    await waitFor(() => expect(regionTitles('.ben-wb__land-side')).toEqual(['项目区', '消耗数据']))
    const header = screen.getByRole('heading', { name: '消耗数据' }).closest('.ben-wb__modhead')!
    expect(header).toHaveAttribute('data-widget-draggable', 'true')
  })

  it('横屏窗口槽与项目区保持固定,保留各自收起键', async () => {
    await renderLandscape()
    for (const name of ['项目区', '窗口槽']) {
      const header = screen.getByRole('heading', { name }).closest('.ben-wb__modhead')!
      expect(header).toHaveAttribute('data-widget-draggable', 'false')
      expect(screen.getByRole('button', { name: `${name} 收起` })).toBeEnabled()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('③ 底部一排格数可变(0–4)', () => {
  it('少一格仍然等宽:剩下三格的 flex-grow 相等', async () => {
    await renderLandscape()
    click('消耗数据 上移')
    await waitFor(() => expect(regionTitles('.ben-wb__land-deck')).toEqual(['余额 / 额度', '随手记', FILES_TITLE]))

    // 等宽 = 三格的 flex-grow 相等(flex-basis 都是 0,所以 grow 之比就是宽度之比)。
    const grows = [...document.querySelectorAll('.ben-wb__land-deck > .ben-wb__mod')]
      .map(node => (node as HTMLElement).style.flexGrow)
    expect(grows).toEqual(['25', '25', '25'])
  })

  it('四格全挪上去 → 底部一排整条不画,上半条吃满', async () => {
    await renderLandscape()
    for (const title of ['消耗数据', '余额 / 额度', '随手记', FILES_TITLE]) {
      click(`${title} 上移`)
      await waitFor(() => expect(regionTitles('.ben-wb__land-side')).toContain(title))
    }

    await waitFor(() => expect(document.querySelector('.ben-wb__land-deck')).toBeNull())
    expect((document.querySelector('.ben-wb__land-band') as HTMLElement).style.flex).toContain('100%')
    // 整条没了,那根「主区 | 底部一排」的横把手也一起没了(边界不存在了)。
    expect(screen.queryByLabelText('调整 主区 与 底部一排 的高度占比')).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('④ 右侧栏里上下两格之间的把手 / 恢复默认布局', () => {
  it('挪上来之后,项目区与它之间多出一根横把手(跟别的边界同一个组件)', async () => {
    await renderLandscape()
    expect(screen.queryByLabelText('调整 项目区 与 消耗数据 的高度占比')).toBeNull()

    click('消耗数据 上移')

    await waitFor(() => expect(screen.getByLabelText('调整 项目区 与 消耗数据 的高度占比')).toBeTruthy())
    const handle = screen.getByLabelText('调整 项目区 与 消耗数据 的高度占比')
    expect(handle.classList.contains('ben-wb__split')).toBe(true)
    expect(handle.getAttribute('data-split-axis')).toBe('horizontal')
    expect(handle.getAttribute('role')).toBe('separator')
  })

  it('「恢复默认布局」把它们放回底部一排', async () => {
    await renderLandscape()
    click('消耗数据 上移')
    await waitFor(() => expect(regionTitles('.ben-wb__land-side')).toEqual(['项目区', '消耗数据']))

    click(RESET_LAYOUT_LABEL)
    // 10-22 统筹定 28:先问一句(评审页「恢复默认布局?」那张居中弹层),点「恢复」才换
    expect(regionTitles('.ben-wb__land-side')).toEqual(['项目区', '消耗数据'])
    click(CONFIRMS.restoreLayout.confirm)

    await waitFor(() => expect(regionTitles('.ben-wb__land-side')).toEqual(['项目区']))
    expect(regionTitles('.ben-wb__land-deck')).toEqual(['消耗数据', '余额 / 额度', '随手记', FILES_TITLE])
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('⑤ 竖屏一字不动', () => {
  it('竖屏下上移仍然是"在一列里换一位",没有区域这回事', async () => {
    setViewport(1440, 2560)
    render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(screen.getByRole('heading', { name: '窗口槽' })).toBeTruthy())

    // 横屏下窗口槽是钉死的;竖屏下它照旧能上移。
    expect(screen.getByRole('heading', { name: '窗口槽' }).closest('.ben-wb__modhead')).toHaveAttribute('data-widget-draggable', 'true')
    expect(document.querySelector('.ben-wb__land-side')).toBeNull()
    expect(document.querySelector('.ben-wb__land-deck')).toBeNull()
  })
})
