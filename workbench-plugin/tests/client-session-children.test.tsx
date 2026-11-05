/**
 * 后台任务挂在主会话卡里 —— 一张卡多一层(2026-09-25,卡 Q;维护者:「这种后台任务,事务官是看不到的,我其实也不建议
 * 分开展示,卡片会非常多,事务官的卡片里可以改成一张卡片里有后台任务的说明,就是多一层的意思」)。
 *
 * 一条带 3 个后台任务的假会话(两个在跑、一个办完了;主会话自己已经说完了):
 * 事务官舞台上**一张**卡,卡上一行「内含 3 项后台任务 · 在跑 2」;点开详情「展开」才一项一行、三行;「执行」只数 1。
 * 界面上不露子任务的 id、型号。手机那一半在 butler-app/tests/sessionChildren.test.tsx。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerScene } from '../src/client/ButlerScene.tsx'
import { SessionChildren } from '../src/client/SessionChildren.tsx'
import { buildButlerScene } from '../src/client/butlerSceneModel.ts'
import type { AgentEntryView, SessionChildView, WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)

const NOW = '2026-09-25T12:30:00.000Z'

const CHILDREN: SessionChildView[] = [
  { id: 'a0734735cd33abd5', parent_session_id: 'parent-1', title: '卡 O:派活的眼睛', status: 'running', activity: { line: '在改文件', at: '2026-09-25T12:29:00.000Z' }, started_at: '2026-09-25T12:02:00.000Z', model: 'claude-opus-5-5' },
  { id: 'a0a4b8f355a4a0df0', parent_session_id: 'parent-1', title: '卡 T:在等你看内容', status: 'running', activity: { line: '在跑测试', at: '2026-09-25T12:28:00.000Z' }, started_at: '2026-09-25T12:01:00.000Z', model: 'claude-opus-5-5' },
  { id: 'acef92c3bb2825186', parent_session_id: 'parent-1', title: '卡 P:会话标题', status: 'done', activity: { line: '做完了,提交号 b21048c2。', at: '2026-09-25T11:40:00.000Z' }, started_at: '2026-09-25T11:00:00.000Z', ended_at: '2026-09-25T11:40:00.000Z', model: 'claude-opus-5-5' },
]

function stateWith(children: readonly SessionChildView[] | undefined, status: 'done' | 'running' = 'done'): WorkbenchState {
  const session = {
    agent: 'claude', session_id: 'parent-1', project: 'desktop-workbench', status, elapsed_sec: 1200, unread: false,
    updated_at: '2026-09-25T12:10:00.000Z', title: '统筹 0925', via: 'sessions' as const,
    ...(children === undefined ? {} : { children }),
  }
  const claude: AgentEntryView = {
    id: 'claude', bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', color: '#eb714d',
    found: { how: 'sessions', at: '', basis: '' }, sources: [], status: status === 'running' ? 'running' : 'idle', gaps: {},
    sessions: [session], counts: { running: status === 'running' ? 1 : 0, waiting: 0, unread: 0 },
  }
  const self: AgentEntryView = { id: 'dsh', name: '事务官', self: true, found: { how: 'self', at: '', basis: '' }, sources: [], status: 'idle', gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 } }
  return {
    agents: [], sessions: [], quota: {}, stale: false, now: NOW,
    tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
    butler_inbox: { items: [] },
    agent_registry: { entries: [self, claude], asking: [], notices: [] },
  } as unknown as WorkbenchState
}

describe('一张卡多一层:主会话卡上一行,展开才一项一行', () => {
  it('★三个后台任务的会话:舞台上一张卡、「执行」数 1;卡上一行「内含 3 项后台任务 · 在跑 2」', () => {
    const state = stateWith(CHILDREN)
    const scene = buildButlerScene(state)
    const cards = scene.items.filter(item => item.external !== undefined)
    expect(cards).toHaveLength(1)
    expect(scene.running).toBe(1)
    render(<ButlerScene state={state} onOpen={vi.fn()} onConfirm={vi.fn()}>粒子</ButlerScene>)
    const stage = screen.getByLabelText('执行中的事项')
    expect(within(stage).getByText('内含 3 项后台任务 · 在跑 2')).toBeInTheDocument()
    // 子任务不单独成卡。
    expect(within(stage).queryByText('卡 O:派活的眼睛')).toBeNull()
  })

  it('★点开那张卡:一行说几项,「展开」之后三行 —— 描述、在跑 / 办完了、在做什么;不露 id、型号', () => {
    const state = stateWith(CHILDREN)
    render(<ButlerScene state={state} onOpen={vi.fn()} onConfirm={vi.fn()}>粒子</ButlerScene>)
    fireEvent.click(screen.getByRole('button', { name: '查看事项:统筹 0925' }))
    const section = screen.getByRole('region', { name: '后台任务' })
    expect(within(section).getByText('内含 3 项后台任务 · 在跑 2')).toBeInTheDocument()
    expect(within(section).queryByRole('listitem')).toBeNull()
    fireEvent.click(within(section).getByRole('button', { name: '展开' }))
    const rows = within(section).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows.map(row => row.querySelector('.ben-wb__session-child-title')?.textContent)).toEqual(['卡 O:派活的眼睛', '卡 T:在等你看内容', '卡 P:会话标题'])
    expect(rows[0]).toHaveTextContent('在跑 · 在改文件 · 1 分钟前')
    expect(rows[2]).toHaveTextContent('办完了 · 做完了')
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('a0734735cd33abd5')
    expect(text).not.toContain('claude-opus')
    fireEvent.click(within(section).getByRole('button', { name: '收起' }))
    expect(within(section).queryByRole('listitem')).toBeNull()
  })

  it('主会话说完了、后台任务也都办完了:不算在办(台上没有这张卡);都办完了那一行照样说得清', () => {
    const done = CHILDREN.map(child => ({ ...child, status: 'done' as const }))
    expect(buildButlerScene(stateWith(done)).items.filter(item => item.external !== undefined)).toHaveLength(0)
    render(<SessionChildren items={done} now={NOW} />)
    expect(screen.getByText('内含 3 项后台任务 · 都办完了')).toBeInTheDocument()
  })

  it('没有后台任务的会话:卡上不多那一行', () => {
    const state = stateWith(undefined, 'running')
    render(<ButlerScene state={state} onOpen={vi.fn()} onConfirm={vi.fn()}>粒子</ButlerScene>)
    expect(screen.queryByText(/后台任务/)).toBeNull()
    expect(buildButlerScene(state).running).toBe(1)
  })
})
