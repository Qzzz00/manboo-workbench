// 事项详情同页(2026-10-27,《设计-协作区与事务官标签页合并》第六节):去掉事务官页以后只剩协作区这一个详情,
// 原事务官页详情独有的几样 —— 干预(花费 / 停掉 / 取消)、现在到哪、要拍板的方案与依据 + 确认、
// 证据里冒出的下一步「加上 / 不要」、优先级可改、目标条件事实 —— 都要在这里。
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollabGoal, TaskView, WorkbenchState } from '../src/protocol.ts'
import { NoteDialog } from '../src/client/collab/NoteDialog.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'

afterEach(cleanup)
const AT = '2026-10-27T10:00:00.000Z'
const task = (patch: Partial<TaskView> = {}): TaskView => ({ id: 't1', title: '座机铃声换一版', status: 'doing', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })
const stateOf = (t: TaskView, goals: CollabGoal[] = []) => ({
  now: AT,
  tasks: { tasks: [t], project_meta: [], session_usage: {}, modules: [], sprints: [], goals, agent_cards: [], goal_sprints: [] },
  sessions: [],
}) as unknown as WorkbenchState

function open(t: TaskView, goals: CollabGoal[] = []) {
  const posts: { path: string, body: Record<string, unknown> }[] = []
  const api: CollabApi = {
    get: async () => ({ items: [], runs: [], events: [], facts: [] }) as never,
    post: async (path: string, body: unknown) => { posts.push({ path, body: body as Record<string, unknown> }); return { ok: true, body: { ok: true } } as never },
  } as CollabApi
  const fetchCalls: { url: string, body: unknown }[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    return { ok: true, json: async () => ({ ok: true, note: '好了' }) }
  }) as unknown as typeof fetch
  const receipts: string[] = []
  render(<NoteDialog task={t} state={stateOf(t, goals)} goals={goals} cards={[]} entries={[]} api={api} baseUrl="http://wb" fetchImpl={fetchImpl} assigneeText={() => '我'} onClose={() => {}} onFlyGoal={() => {}} onReceipt={text => receipts.push(text)} />)
  return { posts, fetchCalls, receipts }
}

describe('干预:原只在事务官页的那几颗键', () => {
  it('★没做完的事项在详情里有「干预」一段,能取消这一件;花费一行照卡上写', async () => {
    const t = task({ budget: { state: 'running', spent: 1.2, limit: 5, unit: 'yuan' } as unknown as NonNullable<TaskView['budget']> })
    open(t)
    const box = screen.getByRole('region', { name: '干预' })
    expect(within(box).getByTestId('item-controls')).toBeInTheDocument()
  })
  it('做完了的、也没有花费与阻塞的:不画这一段', () => {
    open(task({ status: 'done' }))
    expect(screen.queryByRole('region', { name: '干预' })).toBeNull()
  })
})

describe('现在到哪(按证据)', () => {
  it('★卡上有 progress 就写那一句与依据;对不上时写对不上什么', () => {
    open(task({ progress: { line: '分支上已有 3 个提交', state: 'mismatch', mismatch: '卡上说还没开工', basis: [{ source: 'git', at: AT }], checked_at: AT } as unknown as NonNullable<TaskView['progress']> }))
    const box = screen.getByRole('region', { name: '现在到哪' })
    expect(box).toHaveTextContent('分支上已有 3 个提交')
    expect(box).toHaveTextContent('和卡上写的对不上:卡上说还没开工')
    expect(box).toHaveTextContent('依据:git')
  })
  it('没有 progress:不画', () => {
    open(task())
    expect(screen.queryByRole('region', { name: '现在到哪' })).toBeNull()
  })
})

describe('待你处理:要拍板的、要不要加的', () => {
  it('★等我确认且标了四类拍板:摆方案与依据,「确认」走 /task/move done', async () => {
    const { fetchCalls } = open(task({ status: 'confirm', owner_ask: { kind: 'spend', proposal: '开一个月付费版', basis: '免费额度今天用完', at: AT } }))
    const box = screen.getByRole('region', { name: '待你处理' })
    expect(box).toHaveTextContent('要拍板:花钱')
    expect(box).toHaveTextContent('方案:开一个月付费版')
    expect(box).toHaveTextContent('依据:免费额度今天用完')
    await userEvent.click(within(box).getByRole('button', { name: '确认收下:座机铃声换一版' }))
    await waitFor(() => expect(fetchCalls.some(c => c.url === 'http://wb/task/move' && (c.body as { status?: string }).status === 'done')).toBe(true))
  })
  it('★证据里冒出来的下一步(origin evidence、待排):「加上」挪进待办,「不要」改取消', async () => {
    const { fetchCalls } = open(task({ status: 'backlog', origin: 'evidence' } as Partial<TaskView>))
    const box = screen.getByRole('region', { name: '待你处理' })
    await userEvent.click(within(box).getByRole('button', { name: '加上这张卡:座机铃声换一版' }))
    await userEvent.click(within(box).getByRole('button', { name: '不要这张卡:座机铃声换一版' }))
    await waitFor(() => {
      const moves = fetchCalls.filter(c => c.url === 'http://wb/task/move').map(c => (c.body as { status?: string }).status)
      expect(moves).toEqual(['todo', 'canceled'])
    })
  })
  it('都没有:不画这一段', () => {
    open(task())
    expect(screen.queryByRole('region', { name: '待你处理' })).toBeNull()
  })
})

describe('优先级可改', () => {
  it('★下拉选「高」→ /task/update priority high;选「不定」→ null', async () => {
    const { posts } = open(task({ priority: 'low' }))
    const select = screen.getByRole('combobox', { name: '优先级' })
    expect(select).toHaveValue('low')
    await userEvent.selectOptions(select, 'high')
    await userEvent.selectOptions(select, '')
    await waitFor(() => expect(posts.filter(p => p.path === '/task/update').map(p => p.body.priority)).toEqual(['high', null]))
  })
})

describe('目标条件事实', () => {
  it('★所属目标有挂这一件的条件:详情里有「目标条件事实」那一段', async () => {
    const goal = { id: 'g1', title: '演示', status: 'active', created_at: AT, updated_at: AT, conditions: [{ id: 'c1', task_id: 't1', text: '铃声能响', round: 1 }] } as unknown as CollabGoal
    open(task({ goal_id: 'g1' }), [goal])
    await waitFor(() => expect(document.querySelector('[data-testid="note-condition-facts"]')).not.toBeNull())
  })
})

describe('改名文案', () => {
  it('详情头那颗键写「修改事项名称」', () => {
    open(task())
    expect(screen.getByRole('button', { name: '改卡名' })).toHaveTextContent('修改事项名称')
  })
})

describe('同页布局:顶部这件的轨迹,右栏背景与安排', () => {
  it('★有所属目标:顶部一条「这件的轨迹」,读 /collab/trace 只摆这一件的节点与此刻停在哪', async () => {
    const t = task({ goal_id: 'g1' })
    const api: CollabApi = {
      get: async (path: string) => (path.startsWith('/collab/trace')
        ? { goal_id: 'g1', traces: [{ task_id: 't1', nodes: [{ kind: 'dispatch', at: AT, actor: 'dsh', to: 'kimi' }], current: { state: 'running', actor: 'kimi' } }, { task_id: 'other', nodes: [{ kind: 'accept', at: AT }], current: { state: 'done' } }] }
        : { items: [], runs: [], events: [] }) as never,
      post: async () => ({ ok: true, body: { ok: true } }) as never,
    } as CollabApi
    render(<NoteDialog task={t} state={stateOf(t)} goals={[]} cards={[]} entries={[]} api={api} baseUrl="http://wb" fetchImpl={fetch} assigneeText={() => '我'} onClose={() => {}} onFlyGoal={() => {}} onReceipt={() => {}} />)
    const strip = screen.getByRole('region', { name: '这件的轨迹' })
    expect(strip).toHaveAttribute('data-dir', 'row')
    await waitFor(() => expect(strip.querySelectorAll('.ben-cl__trace-node:not(.ben-cl__trace-current)')).toHaveLength(1))
    expect(strip.querySelector('.ben-cl__trace-current')).not.toBeNull()
  })
  it('没有所属目标:不画那一条', () => {
    open(task())
    expect(screen.queryByRole('region', { name: '这件的轨迹' })).toBeNull()
  })
  it('★负责人、前因后果、文件在右栏「背景与安排」;留言与经手在中间', () => {
    open(task())
    const side = screen.getByRole('complementary', { name: '背景与安排' })
    expect(within(side).getByRole('region', { name: '头' })).toBeInTheDocument()
    expect(within(side).getByRole('region', { name: '前因后果' })).toBeInTheDocument()
    expect(within(side).getByRole('region', { name: '文件与仓库' })).toBeInTheDocument()
    expect(within(side).queryByRole('region', { name: '留言' })).toBeNull()
    expect(within(side).queryByRole('region', { name: '经手' })).toBeNull()
  })
})
