/**
 * 协作区阅读模式与按宽增列(2026-10-24,小K collab-desktop-1024 M1)。
 *
 * 钉死:
 * - 组件态(非全屏)= 阅读模式:普通滚动、目标分区、无 React Flow 画布控件;
 * - 全屏可切 画布/阅读,切回组件态回到阅读;
 * - 宽屏增列:卡阅读宽 260–370,超出加列不把卡拉长;窄容器收缩;
 * - 「整理布局」恢复自动排布(存一份自动摆法),手动拖过的位置在自动摆里保留(照旧规矩);
 * - 目标摘要条固定在滚动区外( DOM 上在滚动容器之前 );
 * - 卡片状态给浅状态色之外的文字原因(等谁/什么),不只靠颜色。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CollabPresence, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import { NOTE_W, autoLayout, boardNotes, colsForAreaWidth, noteWidthFor } from '../src/client/collab/collabModel.ts'

afterEach(() => { cleanup(); localStorage.clear() })
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const AT = '2026-10-21T09:00:00.000Z'
const note = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })

function stateWith(tasks: TaskView[], extra: Partial<NonNullable<WorkbenchState['tasks']>> = {}): WorkbenchState {
  return {
    now: AT,
    sessions: [],
    tasks: {
      tasks, sprints: [], modules: [], project_meta: [],
      goals: [{ id: 'g-1', title: '座机打通', why: '出门也能接', owner: 'me', status: 'open', created_at: AT, updated_at: AT }],
      goal_sprints: [], agent_cards: [], session_proposals: [], ...extra,
    },
    agent_registry: { entries: [], asking: [], notices: [] },
  } as unknown as WorkbenchState
}

function fakeFetch() {
  const calls: { path: string, method: string, body?: Record<string, unknown> }[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path: url.pathname, method, ...(body === undefined ? {} : { body }) })
    const json = url.pathname === '/collab/canvas' && method === 'GET'
      ? { layout: { goals: {}, notes: {} } }
      : url.pathname.endsWith('/trace') ? { events: [] } : { ok: true }
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, impl }
}

function zone(state: WorkbenchState, opts: { width?: number, onExpand?: () => void, onExitFull?: () => void } = {}) {
  const fetch = fakeFetch()
  render((
    <div style={{ width: opts.width ?? 1200, height: 800, position: 'relative' }}>
      <CollabZone
        state={state}
        baseUrl="http://127.0.0.1:8791"
        fetchImpl={fetch.impl}
        presence={[] as CollabPresence[]}
        visible
        initialView="goals"
        {...(opts.width === undefined ? {} : { width: opts.width })}
        {...(opts.onExpand === undefined ? {} : { onExpand: opts.onExpand })}
        {...(opts.onExitFull === undefined ? {} : { onExitFull: opts.onExitFull })}
      />
    </div>
  ))
  return fetch
}

describe('按宽增列(纯函数)', () => {
  it('卡宽 260–370:窄容器收缩,宽屏加列不拉长卡', () => {
    // 窄容器:一列,卡随容器收缩但不超 370
    expect(colsForAreaWidth(360)).toBe(1)
    expect(noteWidthFor(360)).toBeLessThanOrEqual(370)
    expect(noteWidthFor(360)).toBeGreaterThanOrEqual(260)
    // 老默认(580)= 两列 260,行为与 e2242240b 之前一致
    expect(colsForAreaWidth(580)).toBe(2)
    expect(noteWidthFor(580)).toBe(NOTE_W)
    // 1100:两列 370 封顶;1600:四列;2560:六列 —— 增列,不拉长
    expect(colsForAreaWidth(1100)).toBe(2)
    expect(noteWidthFor(1100)).toBe(370)
    expect(colsForAreaWidth(1600)).toBe(4)
    expect(noteWidthFor(1600)).toBe(370)
    expect(colsForAreaWidth(2560)).toBe(6)
    expect(noteWidthFor(2560)).toBe(370)
  })
  it('autoLayout 吃区域宽:同一批便签,宽区目标框更宽、列数更多', () => {
    const tasks = [note('a', { goal_id: 'g-1' }), note('b', { goal_id: 'g-1' }), note('c', { goal_id: 'g-1' }), note('d', { goal_id: 'g-1' }), note('e', { goal_id: 'g-1' })]
    const goals = stateWith(tasks).tasks?.goals ?? []
    const narrow = autoLayout(goals, tasks, { goals: {}, notes: {} }, 580)
    const wide = autoLayout(goals, tasks, { goals: {}, notes: {} }, 1600)
    expect(wide.goals['g-1']!.w).toBeGreaterThan(narrow.goals['g-1']!.w)
    // 宽区一排能摆更多张(第五张仍在第一排区内)
    const rowY = (lay: typeof wide) => Object.values(lay.notes).map(p => p.y)
    expect(Math.min(...rowY(wide))).toBe(Math.min(...rowY(narrow)))
  })
})

describe('阅读模式与画布切换', () => {
  it('组件态(非全屏)= 阅读:普通滚动分区,没有 React Flow 控件', async () => {
    zone(stateWith([note('换铃声', { goal_id: 'g-1' }), note('写周报', { goal_id: 'g-1' })]))
    expect(await screen.findByLabelText('目标 座机打通')).toBeInTheDocument()
    expect(screen.getByLabelText('便签 换铃声')).toBeInTheDocument()
    // 阅读容器:纵向滚动条容器,不是画布
    const reading = screen.getByLabelText('目标阅读区')
    expect(reading).toBeInTheDocument()
    expect(reading.className).toContain('ben-cl__reading')
    expect(document.querySelector('.react-flow__controls')).toBeNull()
  })

  it('全屏默认画布,可切阅读;退出全屏回阅读', async () => {
    const user = userEvent.setup()
    zone(stateWith([note('换铃声', { goal_id: 'g-1' })]), { onExpand: () => {}, onExitFull: () => {} })
    // 全屏(onExitFull 给了)先出画布
    await screen.findByLabelText('目标 座机打通')
    expect(screen.getByRole('group', { name: '看板方式' })).toBeInTheDocument()
    expect(document.querySelector('.ben-cl__flow')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: '阅读' }))
    expect(screen.getByLabelText('目标阅读区')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '画布' }))
    expect(document.querySelector('.ben-cl__flow')).not.toBeNull()
  })

  it('目标摘要条固定在滚动区外(DOM 上先于滚动容器)', async () => {
    zone(stateWith([note('换铃声', { goal_id: 'g-1' })]))
    const strip = await screen.findByLabelText('目标摘要')
    const reading = screen.getByLabelText('目标阅读区')
    expect(strip.compareDocumentPosition(reading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('「整理布局」存一份自动摆法(POST /collab/canvas),便签位置回到自动排', async () => {
    const user = userEvent.setup()
    const fetch = zone(stateWith([note('换铃声', { goal_id: 'g-1' }), note('写周报', { goal_id: 'g-1' })]))
    await screen.findByLabelText('便签 写周报')
    await user.click(screen.getByRole('button', { name: '整理布局' }))
    await waitFor(() => {
      const saved = fetch.calls.filter(one => one.path === '/collab/canvas' && one.method === 'POST')
      expect(saved.length).toBeGreaterThan(0)
      const last = saved.at(-1)!.body as { layout: { notes: Record<string, { x: number, y: number }> } }
      expect(Object.keys(last.layout.notes).slice().sort()).toEqual(['写周报', '换铃声'].sort())
    })
  })
})

describe('卡片状态:浅状态色 + 文字原因', () => {
  it('受阻的便签写出原因文字(等谁/什么),不只靠颜色', async () => {
    zone(stateWith([
      note('补材料', {
        goal_id: 'g-1', status: 'blocked',
        receipt: { kind: 'blocked', text: '卡住:缺接口文档', at: AT, by: 'codex' },
      }),
      note('等验收', { goal_id: 'g-1', status: 'confirm' }),
    ]))
    const card = await screen.findByLabelText('便签 补材料')
    expect(card.dataset.status).toBe('blocked')
    // 文字原因在卡上读得到
    expect(card.textContent).toContain('缺接口文档')
  })

  it('等待原因来自 dispatch_block / standing 时也照写', async () => {
    zone(stateWith([
      note('拉数据', { goal_id: 'g-1', status: 'blocked', dispatch_block: { family: 'codex', kind: 'code', why: '那家没有搜索权限', at: AT } }),
    ]))
    const card = await screen.findByLabelText('便签 拉数据')
    expect(card.textContent).toContain('那家没有搜索权限')
  })
})


describe('上方信息折叠', () => {
  it('折叠和恢复保留成员、筛选、当前目标与事项滚动位置；重挂载记住偏好', async () => {
    const user = userEvent.setup()
    const state = stateWith([note('换铃声', { goal_id: 'g-1', project_id: 'demo' })])
    zone(state)
    const reading = await screen.findByLabelText('目标阅读区')
    // 他自己滚下去(2026-10-28 起「动过」只认真实输入;光改 scrollTop 会被对准当前目标让掉)。
    fireEvent.wheel(reading, { deltaY: 280 })
    reading.scrollTop = 280
    await user.selectOptions(screen.getByLabelText('项目'), 'demo')
    const member = screen.getByRole('group', { name: '成员' }).querySelectorAll('button')[1]!
    await user.click(member)
    await user.click(screen.getByRole('button', { name: '收起上方' }))
    for (const name of ['成员', '筛选', '等你', '统计']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name} ·`) })).toHaveAttribute('aria-expanded', 'false')
    }
    expect(screen.getByLabelText('项目')).not.toBeVisible()
    expect(screen.getByLabelText('当前目标')).toHaveValue('g-1')
    expect(reading.scrollTop).toBe(280)
    await user.click(screen.getByRole('button', { name: '展开上方' }))
    expect(screen.getByLabelText('项目')).toHaveValue('demo')
    expect(member).toHaveAttribute('aria-pressed', 'true')
    expect(reading.scrollTop).toBe(280)
    await user.click(screen.getByRole('button', { name: /^成员 ·/ }))
    cleanup()
    zone(state)
    expect(await screen.findByRole('button', { name: /^成员 ·/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /^筛选 ·/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('能力条件折叠后切换目标仍记住偏好，目标选择可见', async () => {
    const user = userEvent.setup()
    const state = stateWith([], { goals: [
      { id: 'g-1', title: '座机打通', owner: 'me', status: 'open', created_at: AT, updated_at: AT },
      { id: 'g-2', title: '样片发布', owner: 'me', status: 'open', created_at: AT, updated_at: AT },
    ] })
    zone(state)
    // 2026-10-27 起能力条件缺省收起(目标条已回答完成程度):一开始就是收起的。
    expect(await screen.findByRole('button', { name: '能力条件' })).toHaveAttribute('aria-expanded', 'false')
    await user.selectOptions(screen.getByLabelText('当前目标'), 'g-2')
    expect(screen.getByRole('button', { name: '能力条件' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByLabelText('当前目标')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '能力条件' }))
    expect(screen.getByRole('button', { name: '能力条件' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('当前目标')).toHaveValue('g-2')
  })
})


describe('折叠偏好的存储边界', () => {
  it('坏 JSON 不阻断界面和折叠；存储不能写时当前会话仍可展开恢复', async () => {
    localStorage.setItem('workbench.collab.context-folds.v1', '{bad json')
    const user = userEvent.setup()
    zone(stateWith([note('换铃声', { goal_id: 'g-1' })]))
    await screen.findByLabelText('目标阅读区')
    const writing = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied') })
    try {
      await user.click(screen.getByRole('button', { name: '收起上方' }))
      expect(screen.getByLabelText('项目')).not.toBeVisible()
      await user.click(screen.getByRole('button', { name: '展开上方' }))
      expect(screen.getByLabelText('项目')).toBeVisible()
    } finally { writing.mockRestore() }
  })

  it('逐项校验存储形状，不把字符串 false 当折叠，并在目标切换后保留', async () => {
    localStorage.setItem('workbench.collab.context-folds.v1', JSON.stringify({ members: true, filters: 'false', stats: true }))
    zone(stateWith([note('换铃声', { goal_id: 'g-1' })]))
    expect(await screen.findByRole('button', { name: /^成员 ·/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByLabelText('项目')).toBeVisible()
    expect(screen.getByRole('button', { name: /^统计 ·/ })).toHaveAttribute('aria-expanded', 'false')
  })
})
