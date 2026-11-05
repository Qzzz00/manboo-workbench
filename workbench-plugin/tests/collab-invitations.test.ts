// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createTasksService } from '../src/server/tasks.ts'
import { deliverInvitations } from '../src/server/collabDelivery.ts'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('一条邀请只派一次,准确名片与子任务保留共同目标和原负责人', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-invite-')); dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const card = await tasks.saveAgentCard({ name: '受控执行者', hand: 'codex', runtime: { family: 'codex' } })
  const parent = await tasks.create({ title: '共同事项', status: 'todo', assignee: 'me', goalId: 'g1', projectId: 'p1', acceptance: ['给出可核产物'] })
  const said = await tasks.message(parent.id!, { text: '核对材料', intent: 'ask', mentions: [card.id!], clientMsgId: 'once' })
  const calls: unknown[] = []
  const dispatch = async (id: string, input: unknown) => { calls.push({ id, input }); return { ok: true, note: '实际送达' } }
  await deliverInvitations(tasks, parent.id!, said.message!, dispatch)
  await deliverInvitations(tasks, parent.id!, said.message!, dispatch)
  const state = await tasks.list()
  expect(calls).toHaveLength(1)
  const original = state.tasks.find(t => t.id === parent.id)!
  const delivery = original.messages![0]!.deliveries![0]!
  const child = state.tasks.find(t => t.id === delivery.task_id)!
  expect(original.assignee).toBe('me')
  expect(child).toMatchObject({ assignee: card.id, goal_id: 'g1', project_id: 'p1', from: { kind: 'channel', ref: said.message!.id } })
  expect(original.children).toContain(child.id)
  expect(delivery.status).toBe('delivered')
})
it('派活失败写入对应投递结果,不冒已接受', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-invite-')); dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const card = await tasks.saveAgentCard({ name: '失联执行者', hand: 'codex' })
  const parent = await tasks.create({ title: '事项', status: 'todo' })
  const said = await tasks.message(parent.id!, { text: '核对', intent: 'ask', mentions: [card.id!] })
  await deliverInvitations(tasks, parent.id!, said.message!, async () => ({ ok: false, note: '这台没接执行通道' }))
  expect((await tasks.list()).tasks.find(t => t.id === parent.id)?.messages?.[0]?.deliveries?.[0]).toMatchObject({ status: 'failed', error: '这台没接执行通道' })
})
