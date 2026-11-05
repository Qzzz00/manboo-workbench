/**
 * 弹层让开窗位(2026-09-11)——几处弹层都挂上了 useVeilSlot 的配对断言。
 *
 * 每处只钉一件事:开 → /dock/veil {on:true},关 → {on:false}。hook 本身的行为
 * (keepalive/pagehide/顺序)在 client-veil-slot.test.tsx;这里防的是"某处弹层忘了挂"。
 * 事务官浮窗多一条:只有矩形与窗位**相交**才让路,拖走就回来。
 *
 * 2026-10-23(卡「系统文件夹改成Graphify图谱」):Wiki 归档确认那一条随 WikiView 一起删了
 * —— 这一格再没有弹层。机制本身(设置/任务卡/日结那几处照旧)不受影响。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DailyReport, TaskView, WorkbenchProject } from '../src/protocol.ts'
import { Butler, type ButlerProps } from '../src/client/Butler.tsx'
import { DailyBar } from '../src/client/DailyBar.tsx'
import { SettingsDialog } from '../src/client/SettingsDialog.tsx'
import { TaskBoard } from '../src/client/TaskBoard.tsx'
import type { BoardActions } from '../src/client/TaskBoard.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** 只记 /dock/veil 的开关;别的请求(凭据/图谱/归档)一律回一个空 ok。 */
function veilRecorder() {
  const flips: boolean[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/dock/veil')) flips.push((JSON.parse(String(init?.body)) as { on: boolean }).on)
    return { ok: true, json: async () => ({ ok: true, deepseek: false, kimi_web: false, claude_api: false, nodes: [], edges: [], notes: [] }) }
  }) as unknown as typeof fetch
  return { flips, fetchImpl, target: { baseUrl: 'http://x', fetchImpl } }
}

describe('设置弹窗', () => {
  it('挂载即让路,卸载即回来', async () => {
    const { flips, target } = veilRecorder()
    const view = render(<SettingsDialog baseUrl="http://x" fetchImpl={target.fetchImpl} onClose={() => {}} veil={target} />)
    await waitFor(() => expect(flips).toEqual([true]))
    view.unmount()
    await waitFor(() => expect(flips).toEqual([true, false]))
  })

  it('不传 veil(不在壳里)→ 不发', async () => {
    const { flips, target } = veilRecorder()
    const view = render(<SettingsDialog baseUrl="http://x" fetchImpl={target.fetchImpl} onClose={() => {}} />)
    view.unmount()
    await Promise.resolve()
    expect(flips).toEqual([])
  })
})

describe('日结弹层', () => {
  const REPORT: DailyReport = {
    date: '2026-09-01', generated_at: '2026-09-02T09:00:05+08:00',
    progress: [], missing: [], ideas: [], proposals: [],
  }
  it('点开让路,再点收起回来', async () => {
    const { flips, target } = veilRecorder()
    render(<DailyBar daily={REPORT} veil={target} />)
    const toggle = screen.getByRole('button', { name: /日结 2026-09-01/ })
    fireEvent.click(toggle)
    await waitFor(() => expect(flips).toEqual([true]))
    fireEvent.click(toggle)
    await waitFor(() => expect(flips).toEqual([true, false]))
  })
})

describe('任务卡弹窗', () => {
  const AT = '2026-08-25T09:00:00.000Z'
  const task: TaskView = { id: 'a', title: '甲', status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, project_id: 'p1', module_id: 'm1' }
  const project: WorkbenchProject = { id: 'p1', name: 'Aiboo', stage: 'MVP 开发', links: [], session_count: 0, idle: false }
  it('点卡片开弹窗让路,关闭回来', async () => {
    const { flips, target } = veilRecorder()
    const actions = {
      createTask: vi.fn(), moveTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(),
      createSprint: vi.fn(), updateSprint: vi.fn(), deleteSprint: vi.fn(),
      createModule: vi.fn(), updateModule: vi.fn(), deleteModule: vi.fn(), setProjectMeta: vi.fn(),
    } satisfies BoardActions
    render(
      <TaskBoard
        tasks={[task]}
        sprints={[{ id: 's1', project_id: 'p1', name: '冲刺一', versions: [], created_at: AT, updated_at: AT }]}
        modules={[{ id: 'm1', sprint_id: 's1', name: '播放模块', created_at: AT, updated_at: AT }]}
        projectMeta={[]} projects={[project]} sessions={[]} now="2026-08-25T17:00:00+08:00"
        axis="module-rows" onAxisChange={() => {}} actions={actions} veil={target}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '甲' }))
    expect(screen.getByRole('dialog', { name: '功能点 甲' })).toBeInTheDocument()
    await waitFor(() => expect(flips).toEqual([true]))
    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(flips).toEqual([true, false]))
  })
})

describe('事务官浮窗:只在与窗位相交时让路', () => {
  function props(over: Partial<ButlerProps> = {}): ButlerProps {
    return {
      conclusions: [], corner: 'br', min: false, narrowForced: false, paused: false, testRinging: false,
      onToggleMin: vi.fn(), onMove: vi.fn(), onResize: vi.fn(), onPause: vi.fn(), onTestRing: vi.fn(),
      onDismissBrief: vi.fn(), onAsk: vi.fn(async () => true), onCancelWatch: vi.fn(),
      ...over,
    }
  }
  const SLOT = { x: 0, y: 0, w: 1000, h: 400 }
  /** 浮窗当前的屏幕矩形——用例里改这个值再触发一次判定。 */
  let butlerRect = { x: 0, y: 500, w: 250, h: 300 }
  function stubButlerRect(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const r = butlerRect
      return { x: r.x, y: r.y, width: r.w, height: r.h, top: r.y, left: r.x, right: r.x + r.w, bottom: r.y + r.h, toJSON() {} } as DOMRect
    })
  }

  it('挂载时不相交 → 不让路;拖到窗位上方松手 → 让路;再拖走 → 回来', async () => {
    const { flips, target } = veilRecorder()
    butlerRect = { x: 0, y: 500, w: 250, h: 300 }
    stubButlerRect()
    render(<Butler {...props({ pos: { x_pct: 0, y_pct: 50 } })} veil={{ target, slotRect: () => SLOT }} />)
    await Promise.resolve()
    expect(flips).toEqual([])

    const head = screen.getByRole('button', { name: /事务官/ })
    // 拖到窗位上方:拖动过程中不判(免得一路上开开关关),松手才判一次
    fireEvent.pointerDown(head, { isPrimary: true, button: 0, pointerId: 1, clientX: 10, clientY: 510 })
    fireEvent.pointerMove(head, { isPrimary: true, button: 0, pointerId: 1, clientX: 10, clientY: 300 })
    butlerRect = { x: 0, y: 290, w: 250, h: 300 }
    expect(flips).toEqual([])
    fireEvent.pointerUp(head, { isPrimary: true, button: 0, pointerId: 1, clientX: 10, clientY: 300 })
    await waitFor(() => expect(flips).toEqual([true]))

    // 拖走
    fireEvent.pointerDown(head, { isPrimary: true, button: 0, pointerId: 2, clientX: 10, clientY: 300 })
    fireEvent.pointerMove(head, { isPrimary: true, button: 0, pointerId: 2, clientX: 10, clientY: 600 })
    butlerRect = { x: 0, y: 590, w: 250, h: 300 }
    fireEvent.pointerUp(head, { isPrimary: true, button: 0, pointerId: 2, clientX: 10, clientY: 600 })
    await waitFor(() => expect(flips).toEqual([true, false]))
  })

  it('挂载时就压在窗位上 → 立刻让路;窗位矩形未知(slotRect 回 undefined)→ 不让', async () => {
    const { flips, target } = veilRecorder()
    butlerRect = { x: 100, y: 100, w: 250, h: 300 }
    stubButlerRect()
    const view = render(<Butler {...props()} veil={{ target, slotRect: () => SLOT }} />)
    await waitFor(() => expect(flips).toEqual([true]))
    view.unmount()
    await waitFor(() => expect(flips).toEqual([true, false]))

    flips.length = 0
    render(<Butler {...props()} veil={{ target, slotRect: () => undefined }} />)
    await Promise.resolve()
    expect(flips).toEqual([])
  })
})
