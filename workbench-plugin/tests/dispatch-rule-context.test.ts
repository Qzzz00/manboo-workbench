// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createTasksService } from '../src/server/tasks.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-rules-context-')); dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const calls: unknown[] = []
  const runner = createDispatchRunner({
    tasks, now: () => new Date(), sessions: () => [], readFile: async () => undefined,
    setTimer: () => 0, clearTimer: () => {},
    rulesFor: async input => {
      const task = (await tasks.list()).tasks.find(one => one.id === input.taskId)
      calls.push({ ...input, persistedAssignee: task?.assignee })
      return undefined
    },
    clientDispatch: { send: async () => ({ ok: false, reason: '受控测试不连接窗口', kind: 'helper_down' }) },
  })
  const created = await tasks.create({ title: '把样片剪一版', projectId: '样片', status: 'todo' })
  return { tasks, runner, calls, dir, id: created.id! }
}

it('真实解析后的家名、负责人、新建目标进入规则上下文，不提前伪写任务 assignee', async () => {
  const f = await fixture()
  await f.runner.start(f.id, { family: 'claude', said: '把样片剪一版', kind: 'chat' })
  expect(f.calls).toEqual([{ taskId: f.id, said: '把样片剪一版', kind: 'chat', persistedAssignee: undefined, dispatch: { family: 'claude', assignee: 'claude', target: 'new' } }])
})

it('名片先解析 runtime，规则收到真实家名和名片 id，不把请求家名当结论', async () => {
  const f = await fixture()
  const card = await f.tasks.saveAgentCard({ name: '受控 Claude', hand: 'claude', runtime: { family: 'claude' } })
  await f.tasks.update(f.id, { assignee: card.id! })
  await f.runner.start(f.id, { family: 'codex', said: '把样片剪一版', kind: 'chat' })
  expect(f.calls).toMatchObject([{ dispatch: { family: 'claude', assignee: card.id, target: 'new' }, persistedAssignee: card.id }])
})

it.each([true, false])('resume 目标跟实际同家旧 session 判据一致：有 session=%s', async hasSession => {
  const f = await fixture()
  if (hasSession) await f.tasks.update(f.id, { dispatch: { family: 'claude', cwd: f.dir, status: 'failed', started_at: '2026-10-24T00:00:00Z', session_id: 'fixture-session' } })
  await f.runner.start(f.id, { family: 'claude', said: '把样片剪一版', kind: 'chat', resume: true })
  expect(f.calls).toMatchObject([{ dispatch: { family: 'claude', target: hasSession ? 'session' : 'new' } }])
})
