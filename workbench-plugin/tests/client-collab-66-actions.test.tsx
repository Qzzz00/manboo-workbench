import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import type { CollabApi, CollabPost } from '../src/client/collab/collabApi.ts'
import { NoteTalk } from '../src/client/collab/NoteTalk.tsx'
const at = '2026-10-24T04:00:00Z'
const task: TaskView = { id: 'retry-task', title: '真实重试入口', status: 'confirm', source: { kind: 'manual' }, created_at: at, updated_at: at }
const cards = [{ id: 'agent:local:qa', name: '核验 Agent', kind: 'card' as const, online: true }]
const props = { task, cards, onReceipt: () => {} }
afterEach(() => { cleanup(); localStorage.clear() })
const activity = { items: [{ type: 'message', at, message: { id: 'original-message', by: cards[0]!.id, text: '请核对原始输入', intent: 'record', at } }] }
const fail = { ok: false, body: {}, error: '回包未知' }

it('R1 有效 @ 选择只记后,错误行重发保持原动作和请求号', async () => {
  const calls: Record<string, unknown>[] = []
  const api: CollabApi = { get: async () => activity as never, post: async (_path, body) => { calls.push(body as never); return fail } }
  render(<NoteTalk {...props} api={api} />)
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('留一句'), '@核验 Agent 只记下来')
  await user.click(screen.getByRole('button', { name: '只留记录' }))
  await user.click(await screen.findByRole('button', { name: '重发' }))
  expect(calls.map(body => body.intent)).toEqual(['record', 'record'])
  expect(calls[1]).toEqual(calls[0])
})

it('R2 未确认 ask 跨重挂载恢复原请求号、原回复和动作,不发新包', async () => {
  const calls: Record<string, unknown>[] = []
  const api: CollabApi = { get: async () => activity as never, post: async (_path, body) => { calls.push(body as never); return fail } }
  const user = userEvent.setup()
  const first = render(<NoteTalk {...props} api={api} />)
  await user.click(await screen.findByRole('button', { name: '回复' }))
  await user.type(screen.getByLabelText('留一句'), '@核验 Agent 继续核对')
  await user.click(screen.getByRole('button', { name: '请 TA 处理' }))
  await screen.findByRole('button', { name: '重发' })
  first.unmount()
  render(<NoteTalk {...props} api={api} />)
  expect(await screen.findByLabelText('留一句')).toHaveValue('@核验 Agent 继续核对')
  await user.click(await screen.findByRole('button', { name: '重发' }))
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0])
  expect(calls[1]!.reply_to).toBe('original-message')
})

it.each([false, true])('R2 A 迟到成功不清后写 B（重挂载=%s）', async remount => {
  let finish!: (result: CollabPost) => void
  const api: CollabApi = { get: async () => ({ items: [] }) as never, post: () => new Promise(resolve => { finish = resolve }) }
  const user = userEvent.setup()
  const first = render(<NoteTalk {...props} api={api} />)
  await user.type(screen.getByLabelText('留一句'), 'A 已发出')
  await user.click(screen.getByRole('button', { name: '留言' }))
  if (remount) { first.unmount(); render(<NoteTalk {...props} api={api} />) }
  await user.clear(screen.getByLabelText('留一句'))
  await user.type(screen.getByLabelText('留一句'), 'B 还要接着写')
  await act(async () => finish({ ok: true, body: { ok: true } }))
  expect(screen.getByLabelText('留一句')).toHaveValue('B 还要接着写')
  expect(localStorage.getItem(`ben-wb.note-draft.${task.id}`)).toContain('B 还要接着写')
})

it('R3 回复真实 Agent 明确预览作者/原句/稳定对象,无 @ 也可显式请处理或只记', async () => {
  const calls: Record<string, unknown>[] = []
  const api: CollabApi = { get: async () => activity as never, post: async (_path, body) => { calls.push(body as never); return { ok: true, body: { ok: true } } } }
  const user = userEvent.setup()
  render(<NoteTalk {...props} api={api} />)
  await user.click(await screen.findByRole('button', { name: '回复' }))
  const preview = screen.getByLabelText('回复对象与原文')
  expect(preview).toHaveTextContent('核验 Agent')
  expect(preview).toHaveTextContent('请核对原始输入')
  expect(preview).toHaveTextContent('original-message')
  expect(preview).toHaveTextContent(cards[0]!.id)
  await user.type(screen.getByLabelText('留一句'), '请再检查第二行')
  await user.click(screen.getByRole('button', { name: '请 TA 处理' }))
  expect(calls[0]).toMatchObject({ intent: 'ask', mentions: [cards[0]!.id], reply_to: 'original-message' })
  await user.click(screen.getByRole('button', { name: '回复' }))
  await user.type(screen.getByLabelText('留一句'), '这一句只记录')
  await user.click(screen.getByRole('button', { name: '只留记录' }))
  expect(calls[1]).toMatchObject({ intent: 'record', reply_to: 'original-message' })
})

it('R3 实际回执有回复入口和精确原句,不凭同家族猜名片', async () => {
  const api: CollabApi = { get: async () => ({ items: [{ type: 'receipt', at, receipt: { kind: 'done', by: cards[0]!.id, at, text: '做完:1 总和=89', message_id: 'original-message' } }] }) as never, post: async () => fail }
  render(<NoteTalk {...props} api={api} />)
  await userEvent.setup().click(await screen.findByRole('button', { name: '回复' }))
  expect(screen.getByLabelText('回复对象与原文')).toHaveTextContent('总和=89')
  expect(screen.getByLabelText('回复对象与原文')).toHaveTextContent(at)
  expect(screen.getByRole('button', { name: '请 TA 处理' })).toBeInTheDocument()
})


it('R3 comment 回复保留正式 comment id,不把记录默认当执行', async () => {
  const calls: Record<string, unknown>[] = []
  const api: CollabApi = { get: async () => ({ items: [{ type: 'comment', at, comment: { id: 'comment-1', by: cards[0]!.id, text: '请补交依据', at } }] }) as never, post: async (_path, body) => { calls.push(body as never); return { ok: true, body: { ok: true } } } }
  render(<NoteTalk {...props} api={api} />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '回复' }))
  expect(screen.getByLabelText('回复对象与原文')).toHaveTextContent('comment-1')
  await user.type(screen.getByLabelText('留一句'), '只记当前说明')
  await user.click(screen.getByRole('button', { name: '只留记录' }))
  expect(calls[0]).toMatchObject({ intent: 'record', reply_to: 'comment-1' })
  expect(calls[0]!.mentions).toBeUndefined()
})

it('R2 HTTP 成功但没有明确确认正文时保留原动作,恢复后仍同号', async () => {
  const calls: Record<string, unknown>[] = []
  const api: CollabApi = { get: async () => ({ items: [] }) as never, post: async (_path, body) => { calls.push(body as never); return { ok: true, body: {} } } }
  const user = userEvent.setup()
  const view = render(<NoteTalk {...props} api={api} />)
  await user.type(screen.getByLabelText('留一句'), '@核验 Agent 丢失确认正文')
  await user.click(screen.getByRole('button', { name: '请 TA 处理' }))
  expect(await screen.findByLabelText('待确认动作')).toBeInTheDocument()
  view.unmount()
  render(<NoteTalk {...props} api={api} />)
  await user.click(screen.getByRole('button', { name: '重发' }))
  expect(calls[1]).toEqual(calls[0])
})
