// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createTasksService } from '../src/server/tasks.ts'
import { createItemDriver } from '../src/server/itemDriver.ts'
import { deliverInvitations } from '../src/server/collabDelivery.ts'
import { createDispatchRunner, DISPATCH_RECOVER_GRACE_MS } from '../src/server/dispatchRun.ts'
import { dispatchMarker } from '../src/server/dispatchReply.ts'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const dirs: string[] = []
const servers: WorkbenchServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('child 已落盘、dispatch 前中断:重启不从负责人驱动暗中派活,保留唯一 child 与明确未知', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-recovery-')); dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const agent = await tasks.saveAgentCard({ name: '受控名片', hand: 'codex', runtime: { family: 'codex' } })
  const parent = await tasks.create({ title: '共同事项', status: 'todo', assignee: 'me' })
  const msg = await tasks.message(parent.id!, { text: '核对材料', intent: 'ask', mentions: [agent.id!] })
  const claim = await tasks.prepareInvitation(parent.id!, msg.message!.id, agent.id!)
  expect(claim.fresh).toBe(true)
  // 崩溃边界:只完成 prepare 的真实写事务;从同一文件重建服务/原负责人驱动,不伪造模型执行或 jobLog。
  const restored = createTasksService({ file: join(dir, 'tasks.json') })
  const calls: string[] = []
  const driver = createItemDriver({ tasks: restored, now: () => new Date(0), file: join(dir, 'drive.json'), mode: async () => 'auto',
    dispatch: async id => { calls.push(id); return { ok: false, note: '受控边界不连接模型' } } })
  driver.kick()
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(calls).toHaveLength(0)
  await deliverInvitations(restored, parent.id!, msg.message!, async id => { calls.push(id); return { ok: false, note: '禁止重发' } })
  expect(calls).toHaveLength(0)
  const state = await restored.list()
  expect(state.tasks).toHaveLength(2)
  expect(state.tasks.find(t => t.id === claim.taskId)).toMatchObject({ status: 'blocked' })
  expect(state.tasks.find(t => t.id === parent.id)?.messages?.[0]?.deliveries?.[0]?.error).toContain('尚未确认')
})

it.each([true, false])('dispatch 中断后既有 runner 收敛:找到交代=%j,不重派、不丢名片归属', async found => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-recovery-')); dirs.push(dir)
  let clock = Date.now()
  const options = { file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000) }
  const tasks = createTasksService(options)
  const agent = await tasks.saveAgentCard({ name: '受控名片', hand: 'codex', runtime: { family: 'codex' } })
  const parent = await tasks.create({ title: '共同事项', status: 'todo', assignee: 'me' })
  const msg = await tasks.message(parent.id!, { text: '核对材料', intent: 'ask', mentions: [agent.id!] })
  const child = (await tasks.prepareInvitation(parent.id!, msg.message!.id, agent.id!)).taskId!
  let sends = 0
  const deps = { tasks, now: () => new Date(clock), sessions: () => [], readFile: async () => undefined,
    setTimer: () => 'controlled-timer', clearTimer: () => {},
    clientDispatch: { send: async () => { sends += 1; return await new Promise<never>(() => {}) } } }
  const first = createDispatchRunner(deps)
  // 真实生产 runner 写 sending 后,受控运输永不返回,模拟进程在该 await 边界退出。
  void first.start(child, { family: agent.id!, said: msg.message!.text })
  await expect.poll(async () => (await tasks.list()).tasks.find(t => t.id === child)?.dispatch_lane?.state).toBe('sending')
  const restored = createTasksService(options)
  const again = createDispatchRunner({ ...deps, tasks: restored, engine: { read: async () => ({ via: 'window' as const, evidence: found ? 'window' as const : 'none' as const }) } })
  await again.resume()
  if (!found) { clock += DISPATCH_RECOVER_GRACE_MS + 1; await again.tick() }
  expect(sends).toBe(1)
  const result = (await restored.list()).tasks.find(t => t.id === child)!
  expect(result.assignee).toBe(agent.id)
  expect(result.dispatch_lane).toBeUndefined()
  expect(result.status).toBe(found ? 'doing' : 'blocked')
  if (found) expect(result.client_dispatch).toMatchObject({ marker: dispatchMarker(child), reply_state: 'waiting' })
  else expect(result.note).toContain('重启')
  const server = await startWorkbenchServer({ port: 0, tasks: restored, service: createWorkbenchService(), tickIntervalMs: 0, collabWorkdir: async () => join(dir, 'work') }); servers.push(server)
  const activity = await (await fetch(`${server.url}/collab/note/activity?id=${parent.id}`)).json() as any
  const delivery = activity.items.find((one: any) => one.type === 'message').message.deliveries[0]
  expect(delivery.task_id).toBe(child)
  if (found) { expect(delivery.status).toBe('delivered'); expect(delivery.error).toBeUndefined() }
  else { expect(delivery.status).toBe('pending'); expect(delivery.error).toContain('重启') }
  first.stop(); again.stop()
})

it('dispatch 已返回但 finishInvitation 前中断:从同 child 的实际投递记录恢复 delivered,不冒 accepted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-recovery-')); dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const agent = await tasks.saveAgentCard({ name: '受控名片', hand: 'codex', runtime: { family: 'codex' } })
  const parent = await tasks.create({ title: '共同事项', status: 'todo', assignee: 'me' })
  const msg = await tasks.message(parent.id!, { text: '核对材料', intent: 'ask', mentions: [agent.id!] })
  const child = (await tasks.prepareInvitation(parent.id!, msg.message!.id, agent.id!)).taskId!
  let sends = 0
  const runner = createDispatchRunner({ tasks, now: () => new Date(), sessions: () => [], readFile: async () => undefined,
    setTimer: () => 'controlled-timer', clearTimer: () => {}, clientDispatch: { send: async input => {
      sends += 1
      return { ok: true, baseline: [], dispatch: { family: 'codex', hand: 'window', status: 'sent', at: new Date().toISOString(), text: input.text, submitted: true } }
    } } })
  expect((await runner.start(child, { family: agent.id!, said: msg.message!.text })).ok).toBe(true)
  runner.stop()
  const restored = createTasksService({ file: join(dir, 'tasks.json') })
  const server = await startWorkbenchServer({ port: 0, tasks: restored, service: createWorkbenchService(), tickIntervalMs: 0, collabWorkdir: async () => join(dir, 'work') }); servers.push(server)
  const activity = await (await fetch(`${server.url}/collab/note/activity?id=${parent.id}`)).json() as any
  expect(activity.items.find((one: any) => one.type === 'message').message.deliveries[0]).toMatchObject({ status: 'delivered', task_id: child })
  await deliverInvitations(restored, parent.id!, msg.message!, async () => { sends += 1; return { ok: false, note: '不得重复执行' } })
  expect(sends).toBe(1)
})
