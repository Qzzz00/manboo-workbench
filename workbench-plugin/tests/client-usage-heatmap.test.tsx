/**
 * 年度热力图(产品研发模板那一版面板里的那一块)。
 *
 * ★ 2026-10-03:0.4.90 把这一格整块换成他那一版、这份用例跟着删了;按模板分流之后
 * 产品研发模板又用回 0.4.89 那一版面板,所以这一份从 `79b3757a` **原样取回,一条没改**。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsagePanel } from '../src/client/UsagePanel.tsx'
import { previewBoardState, previewState } from '../../docs/prototypes/workbench-visual/fixture.ts'
import { TaskBoard, type BoardActions } from '../src/client/TaskBoard.tsx'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T14:20:00+08:00')) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('固定预览的真实用量日历', () => {
  it('有任务场景在真实看板的四个状态内显示示例卡，常规场景保留空态', () => {
    const state = previewBoardState()
    const actions: BoardActions = {
      createTask: vi.fn(), moveTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(),
      createSprint: vi.fn(), updateSprint: vi.fn(), deleteSprint: vi.fn(),
      createModule: vi.fn(), updateModule: vi.fn(), deleteModule: vi.fn(), setProjectMeta: vi.fn(),
    }
    render(<TaskBoard tasks={state.tasks?.tasks ?? []} sprints={state.tasks?.sprints ?? []}
      modules={state.tasks?.modules ?? []} projectMeta={state.tasks?.project_meta ?? []}
      projects={state.projects!.projects} sessions={[]} now={state.now} axis="module-rows"
      onAxisChange={() => {}} actions={actions} />)
    expect(within(screen.getByLabelText('工作台界面 · 进行中')).getByText('统一工作台卡片材质')).toBeInTheDocument()
    expect(within(screen.getByLabelText('工作台界面 · 等我确认')).getByText('确认手机端第一条链路')).toBeInTheDocument()
    expect(within(screen.getByLabelText('工作台界面 · 完成')).getByText('整理项目交接说明')).toBeInTheDocument()
    expect(within(screen.getByLabelText('工作台界面 · 阻塞')).getByText('等待本机入口验证')).toBeInTheDocument()
    expect(previewState().tasks).toBeUndefined()
  })
  it('实际日期覆盖全部强度，未来日期不冒充零用量', () => {
    const { container } = render(<UsagePanel usage={previewState().usage} />)
    const cells = container.querySelectorAll('.ben-wb__usage-heatgrid [data-level]:not([data-future="true"])')
    expect([...new Set(Array.from(cells, node => node.getAttribute('data-level')))].sort()).toEqual(['0', '1', '2', '3', '4'])
    expect(container.querySelector('.ben-wb__usage-heatgrid [data-future="true"]')).toHaveAttribute('title', expect.stringContaining('还没到'))
  })

  it('格子上面一行月份「1 月 2 … 12」(评审页 0cf75042 消耗数据 `.months`),读屏不念', () => {
    const { container } = render(<UsagePanel usage={previewState().usage} />)
    const months = container.querySelector('.ben-wb__usage-heatmonths')!
    expect(months).toHaveAttribute('aria-hidden', 'true')
    expect([...months.children].map(one => one.textContent)).toEqual(['1 月', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
  })

  it('少到多图例提供五个非交互档位', () => {
    render(<UsagePanel usage={previewState().usage} />)
    const legend = screen.getByRole('group', { name: '用量强度' })
    expect(legend).toHaveTextContent('少')
    expect(legend).toHaveTextContent('多')
    expect(legend.querySelectorAll('[data-level]')).toHaveLength(5)
    expect(within(legend).queryByRole('button')).toBeNull()
  })

  it('零用量日无会话或消息，项目/模型/来源统计一致', () => {
    const usage = previewState().usage!
    if ('error' in usage) throw new Error('示例应有用量')
    expect(usage.days).toHaveLength(30)
    const zeroDays = usage.days.filter(day => Object.values(day.by_project).every(total => total.input + total.output + total.cache_write === 0))
    expect(zeroDays.length).toBeGreaterThan(0)
    for (const day of zeroDays) {
      expect(day.sessions).toBe(0)
      expect(day.messages).toBe(0)
      expect(Object.values(day.hour_counts).reduce((a, b) => a + b, 0)).toBe(0)
    }
    for (const day of usage.days) {
      expect(Object.values(day.by_project)).toEqual(Object.values(day.by_model))
      expect(Object.values(day.by_project)).toEqual(Object.values(day.by_source))
    }
  })
})
