import { describe, expect, it } from 'vitest'
import { createPreviewFetch, previewBoardState, previewButlerState, previewState } from '../../docs/prototypes/workbench-visual/fixture.ts'

describe('视觉预览的网络隔离', () => {
  it.each([0, 1, 3, 6, 9])('可切换为%s件有完整会话证据的执行事项，不改变结果与网络隔离', count => {
    const state = previewButlerState(false, count)
    const tasks = state.tasks!.tasks.filter(task => task.status === 'doing')
    expect(tasks).toHaveLength(count)
    expect(tasks.every(task => task.links!.every(link => state.sessions.some(session => session.agent === link.agent && session.session_id === link.session_id && session.status === 'running')))).toBe(true)
    expect(state.tasks!.tasks.filter(task => task.status === 'confirm')).toHaveLength(1)
  })
  it('事务官示例覆盖跨 Agent 并行、同事多执行者、排队与真实失败，而不改变原四卡看板', () => {
    const state = previewButlerState()
    expect(previewBoardState().tasks!.tasks).toHaveLength(4)
    expect(state.tasks!.tasks.filter(task => task.status === 'doing').map(task => task.id)).toEqual(['preview-doing', 'preview-parallel'])
    expect(state.tasks!.tasks.find(task => task.id === 'preview-parallel')!.links).toEqual([
      { agent: 'claude', session_id: 'preview-session-parallel' },
      { agent: 'codex', session_id: 'preview-session-review' },
    ])
    expect(state.tasks!.tasks.find(task => task.id === 'preview-queued')!.status).toBe('todo')
    expect(state.tasks!.tasks.find(task => task.id === 'preview-failed')!.block_reason).toBe('error')
    expect(state.tasks!.tasks.find(task => task.id === 'preview-blocked')!.block_reason).toBe('input')
    expect(state.tasks!.tasks.find(task => task.id === 'preview-canceled')!.status).toBe('canceled')
    expect(state.sessions.find(session => session.session_id === 'preview-session-failed')!.status).toBe('error')
    expect(state.dock!.stack.every(tab => !tab.current)).toBe(true)
    expect(state.helper?.connected).toBe(false)
  })

  it('事务官空态快照没有残余事项、会话或假执行计数', () => {
    const state = previewButlerState(true)
    expect(state.tasks!.tasks).toEqual([])
    expect(state.butler_inbox!.items).toEqual([])
    expect(state.sessions).toEqual([])
    expect(state.agents.every(agent => agent.running === 0 && agent.waiting === 0)).toBe(true)
  })

  it('事项示例沿用看板事实源，会话和确认收件条目指向同一事项', () => {
    const state = previewBoardState()
    expect(state.tasks?.tasks.every(task => task.direction === 'mine')).toBe(true)
    expect(state.butler_inbox?.items.map(item => item.task_id)).toEqual(['preview-confirm'])
    const running = state.tasks!.tasks.find(task => task.id === 'preview-doing')!
    expect(running.links).toEqual([{ agent: 'codex', session_id: 'preview-session-doing', note: '统一卡片与控件视觉' }])
    expect(state.sessions.find(session => session.session_id === 'preview-session-doing')?.status).toBe('running')
    const blocked = state.tasks!.tasks.find(task => task.id === 'preview-blocked')!
    expect(blocked.block_reason).toBe('input')
  })
  it('只从固定示例返回快照，保持真实统计口径的数据形状', async () => {
    const request = createPreviewFetch(previewState())
    const res = await request('https://preview.invalid/state')
    expect(res.ok).toBe(true)
    const state = await res.json()
    expect(state.projects.projects).toHaveLength(5)
    expect(state.usage.days).toHaveLength(30)
    expect(state.helper.connected).toBe(false)
  })

  it('写操作和未知读取明确拒绝，不能假装任务已执行或返回快照冒充接口', async () => {
    const request = createPreviewFetch(previewState())
    for (const path of ['/ring/test', '/pause', '/butler/item', '/dock/activate']) {
      const res = await request(`https://preview.invalid${path}`, { method: 'POST', body: '{}' })
      expect(res.status).toBe(501)
      expect((await res.json()).error).toContain('仅视觉预览')
    }
    expect((await request('https://preview.invalid/unknown')).status).toBe(404)
    expect((await request('http://127.0.0.1:8791/state')).status).toBe(403)
  })
})
