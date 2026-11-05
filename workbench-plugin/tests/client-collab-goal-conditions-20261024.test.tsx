/**
 * 目标能力条件面板(2026-10-24,小K collab-desktop-1024,消费 core 契约 §1 B)。
 *
 * 钉死:
 * - 条件按状态给文字(尚未安排/已开工/受阻/交回待验/退回重做/已验收/已交付),不只靠颜色;
 * - 进度按条件算,不按卡数;scope(统计范围)与取消单列照写;
 * - 核验通过/不通过走 /collab/goal/condition/verify,留依据;任务不在 confirm/done 时核验键
 *   不可点(服务端也拒,这里先把话说明白);
 * - 交付只对已验收开放;退回/重开(round 涨)后旧核验显示「旧轮失效,已重算」;
 * - 条件 3–7 条:加第八条被服务端 409,原话给人看。
 * - 标题旁按 Pen 稿标签样式显示目标状态(open=在推 / reached=达成了 / dropped=不要了),
 *   与画布目标头同一套文字表(GOAL_STATUS_TITLES)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { GoalPanel } from '../src/client/collab/GoalPanel.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'
import type { CollabGoal } from '../src/protocol.ts'

afterEach(cleanup)

const AT = '2026-10-24T09:00:00.000Z'
const goal: CollabGoal = { id: 'g-1', title: '座机打通', why: '出门也能接', owner: 'me', status: 'open', created_at: AT, updated_at: AT }

function apiWith(handlers: Record<string, (body?: Record<string, unknown>) => { status: number, json: unknown }>) {
  const calls: { path: string, method: string, body?: Record<string, unknown> }[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path: url.pathname + url.search, method, ...(body === undefined ? {} : { body }) })
    const handler = handlers[url.pathname]
    if (handler === undefined) return new Response(JSON.stringify({ ok: false, error: '没有这个口' }), { status: 404 })
    const got = handler(body)
    return new Response(JSON.stringify(got.json), { status: got.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const api: CollabApi = {
    async post(path, body) {
      const res = await impl(`http://x${path}`, { method: 'POST', body: JSON.stringify(body) })
      const got = await res.json() as Record<string, unknown>
      return res.ok ? { ok: true, body: got } : { ok: false, body: got, error: typeof got.error === 'string' ? got.error : '没办成' }
    },
    async get(path) {
      const res = await impl(`http://x${path}`)
      return res.ok ? await res.json() as never : undefined
    },
  }
  return { calls, api }
}

const board = (items: unknown[]) => ({
  status: 200,
  json: { summary: {
    goal_id: 'g-1',
    scope: '目标「座机打通」全部事项;父子不双计;取消单列',
    conditions: {
      total: items.length,
      by_state: {},
      items,
    },
    tasks: { total: 3, by_status: { doing: 1, confirm: 1, done: 1 }, canceled: 1, unscheduled: 0 },
  } },
})

describe('目标条件面板', () => {
  it('按状态给文字;scope 与取消单列照写;点条件定位承接任务', async () => {
    const { api } = apiWith({
      '/collab/goal/board': () => board([
        { id: 'c1', text: '提起听筒能接通', state: 'verified', task_id: 't-1', assignee: 'codex', last_receipt_at: AT },
        { id: 'c2', text: '手机能看材料', state: 'pending' },
        { id: 'c3', text: '断网有最后已知', state: 'rework', task_id: 't-3', assignee: 'me' },
      ]),
    })
    render(<GoalPanel goal={goal} api={api} onOpenTask={() => {}} onClose={() => {}} />)
    expect(await screen.findByText('目标「座机打通」全部事项;父子不双计;取消单列')).toBeInTheDocument()
    const row1 = screen.getByText('提起听筒能接通').closest('li')!
    expect(within(row1 as HTMLElement).getByText('已验收')).toBeInTheDocument()
    expect(within(row1 as HTMLElement).getByText(/承接 · Codex/)).toBeInTheDocument()
    expect(screen.getByText('尚未安排')).toBeInTheDocument()
    expect(screen.getByText('退回重做')).toBeInTheDocument()
    // 取消单列、不算达成
    expect(screen.getByText(/取消 1 件,不算进达成/)).toBeInTheDocument()
    // 待安排的条件给得出「还没安排给谁」
    expect(screen.getByText('还没安排给谁做')).toBeInTheDocument()
  })

  it('核验:留依据走 verify;任务不在 confirm/done 时键不可点并说明', async () => {
    const user = userEvent.setup()
    const { calls, api } = apiWith({
      '/collab/goal/board': () => board([
        { id: 'c1', text: '提起听筒能接通', state: 'submitted', task_id: 't-1', assignee: 'codex' },
        { id: 'c2', text: '手机能看材料', state: 'doing', task_id: 't-2', assignee: 'kimi' },
      ]),
    })
    render(<GoalPanel goal={goal} api={api} onOpenTask={() => {}} onClose={() => {}} />)
    // doing(在做,成果未交回):没有核验键,只有说明
    const row2 = (await screen.findByText('手机能看材料')).closest('li') as HTMLElement
    expect(within(row2).queryByRole('button', { name: '核验通过' })).toBeNull()
    expect(within(row2).getByText(/成果还没交回,没得验/)).toBeInTheDocument()
    // submitted 那行可以验:写依据
    const row1 = screen.getByText('提起听筒能接通').closest('li') as HTMLElement
    await user.type(within(row1).getByLabelText('核验依据'), '真机提起听筒通了')
    await user.click(within(row1).getByRole('button', { name: '核验通过' }))
    await waitFor(() => {
      const sent = calls.find(one => one.path === '/collab/goal/condition/verify' && one.method === 'POST')
      expect(sent!.body).toMatchObject({ goal_id: 'g-1', condition_id: 'c1', pass: true, note: '真机提起听筒通了' })
    })
  })

  it('交付只对已验收开放;旧轮核验标注失效', async () => {
    const user = userEvent.setup()
    const { calls, api } = apiWith({
      '/collab/goal/board': () => board([
        { id: 'c1', text: '提起听筒能接通', state: 'verified', task_id: 't-1', verifications: [{ by: 'me', at: AT, round: 1 }] },
        { id: 'c2', text: '手机能看材料', state: 'submitted', task_id: 't-2' },
      ]),
    })
    render(<GoalPanel goal={goal} api={api} onOpenTask={() => {}} onClose={() => {}} />)
    const row1 = (await screen.findByText('提起听筒能接通')).closest('li') as HTMLElement
    await user.click(within(row1).getByRole('button', { name: '记交付' }))
    await waitFor(() => {
      const sent = calls.find(one => one.path === '/collab/goal/condition/deliver' && one.method === 'POST')
      expect(sent!.body).toMatchObject({ goal_id: 'g-1', condition_id: 'c1' })
    })
    // submitted 那行没有「记交付」
    const row2 = screen.getByText('手机能看材料').closest('li') as HTMLElement
    expect(within(row2).queryByRole('button', { name: '记交付' })).toBeNull()
  })

  it('条件到 7 条再加:服务端 409 原话给人看,不假装加成功', async () => {
    const user = userEvent.setup()
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, text: `条件${i}`, state: 'pending' }))
    const { api } = apiWith({
      '/collab/goal/board': () => board(seven),
      '/collab/goal/condition/save': () => ({ status: 409, json: { ok: false, error: '一个目标至多 7 条能力条件' } }),
    })
    render(<GoalPanel goal={goal} api={api} onOpenTask={() => {}} onClose={() => {}} />)
    await screen.findByText('条件0')
    await user.type(screen.getByLabelText('新条件(用户能做成的一件事)'), '第八条')
    await user.click(screen.getByRole('button', { name: '加条件' }))
    expect(await screen.findByText('一个目标至多 7 条能力条件')).toBeInTheDocument()
  })

  it.each([
    ['open', '在推'],
    ['reached', '达成了'],
    ['dropped', '不要了'],
  ] as const)('标题旁按标签样式显示目标状态(%s = %s)', async (status, word) => {
    const one: CollabGoal = { ...goal, status }
    const { api } = apiWith({ '/collab/goal/board': () => board([]) })
    render(<GoalPanel goal={one} api={api} onOpenTask={() => {}} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: `目标条件 · ${goal.title}` })
    const chip = within(dialog).getByText(word)
    // Pen 稿标签样式:同一个 chip 类(与便签标签同款),并带 data-status 供浅状态色区分。
    expect(chip.className).toContain('ben-cl__gap')
    expect(chip.dataset.status).toBe(status)
    expect(chip.closest('h2')).not.toBeNull()
  })
})
