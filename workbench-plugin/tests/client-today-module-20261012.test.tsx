/**
 * 「今天的待办」那一格(2026-10-12):看板事项的今天视图,读 `/state.today_todos`,写只走看板现有的三条路。
 *
 *   勾选     = `/task/move` 照七态表一格一格走到「完成」(待办 → 进行中 → 完成)
 *   取消勾选 = `/task/move` 回「进行中」(七态表上办完只能重开到进行中)
 *   延到明天 = `/task/update {due: 明天}`
 *   新加一件 = `/task/create {status:'todo', due: 今天}`
 *   运营同学浏览器里那份(`dsh-workbench.daily-todo.v1`):有没办完的就问一次,点了才导成事项,之后不再问。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskView, TodayTodosView } from '../src/protocol.ts'
import {
  LEGACY_TODO_ASKED_KEY, LEGACY_TODO_KEY, TodayModule, legacyTodosOf, todayImportAsk,
} from '../src/client/TodayModule.tsx'

afterEach(cleanup)

const BOX = { id: 'today', title: '今天的待办', basisPct: 10, dragging: false, onResizeStart: () => {}, onResizeMove: () => {}, onResizeEnd: () => {} }
const AT = '2026-10-12T02:00:00.000Z'

function task(id: string, status: TaskView['status'], due = '2026-10-12'): TaskView {
  return { id, title: id, status, due, created_at: AT, updated_at: AT } as TaskView
}

function fakeFetch(fail?: string) {
  const calls: { path: string, body: Record<string, unknown> }[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace('http://127.0.0.1:8791', '')
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ path, body })
    if (fail !== undefined && path === fail) return new Response(JSON.stringify({ error: '不许这样挪' }), { status: 409 })
    return new Response(JSON.stringify({ ok: true, id: `new-${calls.length}` }), { status: 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

const VIEW: TodayTodosView = {
  date: '2026-10-12',
  tomorrow: '2026-10-13',
  items: [
    { id: 'late', title: '补拍空镜', due: '2026-10-10', done: false, overdue: true },
    { id: 'a', title: '回三条评论', due: '2026-10-12', done: false, overdue: false },
    { id: 'd', title: '剪片头', due: '2026-10-12', done: true, overdue: false },
  ],
}
const TASKS = [task('late', 'todo', '2026-10-10'), task('a', 'backlog'), task('d', 'done')]

function paint(opts: { view?: TodayTodosView | undefined, fetchImpl?: typeof fetch, storage?: ReturnType<typeof memoryStorage> } = {}) {
  return render(
    <TodayModule
      box={BOX}
      header={<h3 id="t">今天的待办</h3>}
      headingId="t"
      baseUrl="http://127.0.0.1:8791"
      fetchImpl={opts.fetchImpl ?? fakeFetch().impl}
      {...('view' in opts ? (opts.view === undefined ? {} : { view: opts.view }) : { view: VIEW })}
      tasks={TASKS}
      storage={opts.storage ?? memoryStorage()}
    />,
  )
}

describe('今天的待办:读', () => {
  it('列今天那几件,逾期的写明;还剩几件数得对;办完的打着勾', () => {
    paint()
    expect(screen.getByText('10月12日')).toBeInTheDocument()
    expect(screen.getByText('还有 2 件')).toBeInTheDocument()
    expect(screen.getByText('补拍空镜')).toBeInTheDocument()
    expect(screen.getByText('逾期 · 10/10')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '完成:回三条评论' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '重开:剪片头' })).toBeChecked()
  })

  it('没有这一份(老服务端 / 不是自媒体模板)时说清,不画空列表', () => {
    paint({ view: undefined })
    expect(screen.getByText('工作台服务还没给出今天的待办')).toBeInTheDocument()
  })

  it('这一格不带紫色,也不借主题点缀色(黑底白字灰线)', () => {
    paint()
    const css = [...document.querySelectorAll('style')].map(one => one.textContent ?? '').join('\n')
    expect(css).not.toMatch(/business-primary|--[a-z-]*accent/)
    // 每个十六进制色都是灰阶(r = g = b,透明度随意)。
    for (const hex of css.match(/#[0-9a-f]{3,8}\b/gi) ?? []) {
      const rgb = hex.length <= 5 ? [...hex.slice(1, 4)] : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)]
      expect(new Set(rgb.map(one => one.toLowerCase())).size, hex).toBe(1)
    }
  })
})

describe('今天的待办:写只走看板那三条路', () => {
  it('勾一件「待排」的:照七态表走 待办 → 进行中 → 完成,一格一格', async () => {
    const f = fakeFetch()
    paint({ fetchImpl: f.impl })
    fireEvent.click(screen.getByRole('checkbox', { name: '完成:回三条评论' }))
    await waitFor(() => expect(f.calls).toHaveLength(3))
    expect(f.calls.map(one => [one.path, one.body.status])).toEqual([
      ['/task/move', 'todo'], ['/task/move', 'doing'], ['/task/move', 'done'],
    ])
    expect(f.calls.every(one => one.body.id === 'a')).toBe(true)
  })

  it('走到一半被拒:停下,把服务端那句话摆出来', async () => {
    const f = fakeFetch('/task/move')
    paint({ fetchImpl: f.impl })
    fireEvent.click(screen.getByRole('checkbox', { name: '完成:补拍空镜' }))
    expect(await screen.findByText('不许这样挪')).toBeInTheDocument()
    expect(f.calls).toHaveLength(1)
  })

  it('取消勾选:重开回「进行中」', async () => {
    const f = fakeFetch()
    paint({ fetchImpl: f.impl })
    fireEvent.click(screen.getByRole('checkbox', { name: '重开:剪片头' }))
    await waitFor(() => expect(f.calls).toEqual([{ path: '/task/move', body: { id: 'd', status: 'doing' } }]))
  })

  it('延到明天:改那件事的日期,不动别的', async () => {
    const f = fakeFetch()
    paint({ fetchImpl: f.impl })
    fireEvent.click(screen.getByRole('button', { name: '回三条评论 延到明天' }))
    await waitFor(() => expect(f.calls).toEqual([{ path: '/task/update', body: { id: 'a', due: '2026-10-13' } }]))
    expect(screen.queryByRole('button', { name: '剪片头 延到明天' })).toBeNull()
  })

  it('新加一件 = 建一件今天到期的事项', async () => {
    const f = fakeFetch()
    paint({ fetchImpl: f.impl })
    fireEvent.change(screen.getByRole('textbox', { name: '新加一件今天的待办' }), { target: { value: '  发预告  ' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(f.calls).toEqual([{ path: '/task/create', body: { title: '发预告', status: 'todo', due: '2026-10-12' } }]))
  })
})

describe('浏览器里那份旧待办', () => {
  const LEGACY = JSON.stringify([
    { id: '1', title: '旧的一件', day: '2026-10-09', done: false },
    { id: '2', title: '明天那件', day: '2026-10-13', done: false },
    { id: '3', title: '办完了的', day: '2026-10-09', done: true },
    { nope: true },
  ])

  it('只认没办完、形状对的;日子早于今天的按今天导', () => {
    expect(legacyTodosOf(LEGACY, '2026-10-12')).toEqual([
      { title: '旧的一件', due: '2026-10-12' },
      { title: '明天那件', due: '2026-10-13' },
    ])
    expect(legacyTodosOf('坏的', '2026-10-12')).toEqual([])
    expect(todayImportAsk(2)).toBe('把之前记在浏览器里的 2 件导成事项?')
  })

  it('有就问一次;点「导成事项」才建,建完记下问过了,浏览器里那份不删', async () => {
    const f = fakeFetch()
    const storage = memoryStorage({ [LEGACY_TODO_KEY]: LEGACY })
    paint({ fetchImpl: f.impl, storage })
    expect(screen.getByText(todayImportAsk(2))).toBeInTheDocument()
    expect(f.calls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '导成事项' }))
    await waitFor(() => expect(f.calls.map(one => one.body)).toEqual([
      { title: '旧的一件', status: 'todo', due: '2026-10-12' },
      { title: '明天那件', status: 'todo', due: '2026-10-13' },
    ]))
    expect(storage.data.get(LEGACY_TODO_ASKED_KEY)).toBeDefined()
    expect(storage.data.get(LEGACY_TODO_KEY)).toBe(LEGACY)
    await waitFor(() => expect(screen.queryByText(todayImportAsk(2))).toBeNull())
  })

  it('点「不用了」:一件不建,之后不再问', () => {
    const f = fakeFetch()
    const storage = memoryStorage({ [LEGACY_TODO_KEY]: LEGACY })
    paint({ fetchImpl: f.impl, storage })
    fireEvent.click(screen.getByRole('button', { name: '不用了' }))
    expect(f.calls).toHaveLength(0)
    cleanup()
    paint({ fetchImpl: f.impl, storage })
    expect(screen.queryByText(todayImportAsk(2))).toBeNull()
  })

  it('浏览器里没有、或者都办完了:不问', () => {
    paint({ storage: memoryStorage() })
    expect(screen.queryByRole('button', { name: '导成事项' })).toBeNull()
  })
})
