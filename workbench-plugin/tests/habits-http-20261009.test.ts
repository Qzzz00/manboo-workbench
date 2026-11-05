// @vitest-environment node
/**
 * 习惯接在 8791 上(2026-10-09,卡「数出习惯」):
 *
 *   GET  /habits                 正在试用 / 已留下 / 已撤的(给「它学到了什么」那一页)
 *   POST /habits/revoke { id }   她撤掉一条(撤掉的不再自动学回来);只认她本人
 *
 * 另钉两处记账:派活那一条带上「类」(数默认分派按它分),收回「同类都允许」记成一次纠正。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HabitsView } from '../src/protocol.ts'
import { createBehaviorLog, type BehaviorEntry } from '../src/server/behaviorLog.ts'
import { createApprovalGrants } from '../src/server/butlerAsks.ts'
import { createHabitService, dispatchClassOf, GRANT_REVOKED, type StoredHabit } from '../src/server/habits.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createRulesService } from '../src/server/rules.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const PAGE = { origin: 'http://127.0.0.1:3080' }
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const CODE = dispatchClassOf('code')

function habit(over: Partial<StoredHabit> = {}): StoredHabit {
  const at = new Date(Date.now() - 3600_000).toISOString()
  return {
    id: `分派:${CODE}→codex`, kind: 'dispatch', 类: CODE, value: 'codex', text: `「${CODE}」这类事默认派给 Codex`,
    status: 'trial', evidence: [{ at, what: '10-03 14:20《T12》推荐 Claude,她派了 Codex' }], applied: [],
    created_at: at, updated_at: at, adopted_at: at, ...over,
  }
}

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-habits-http-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const rules = createRulesService({ file: join(dir, 'rules.json'), agents: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true }) } })
  await rules.load()
  const behaviorLog = createBehaviorLog({ dir: join(dir, '行为账') })
  const habits = createHabitService({ store: rules, behavior: behaviorLog })
  const approvalGrants = createApprovalGrants()
  const request = async (req: { op: string }): Promise<Record<string, unknown>> =>
    (req.op === 'send_text' ? { method: 'ax_value', submitted: true } : { found: false, busy: false })
  const engine = engineHarness({ helper: { connected: () => true, supports: () => true, request } })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    rules,
    habits,
    behaviorLog,
    approvalGrants,
    engine: engine.engine,
    engineRegistry: engine.registry,
    helper: {
      attach: () => {}, view: () => ({ connected: true, authorized: true }) as never, connected: () => true, onChange: () => {}, onEvent: () => {}, request,
    },
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    appInstalled: () => true,
  })
  started.push(server)
  const call = async (path: string, init: { body?: unknown, headers?: Record<string, string> } = {}) => {
    const res = await fetch(`${server.url}${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const entries = async (): Promise<BehaviorEntry[]> => { await behaviorLog.flush(); return behaviorLog.read({}) }
  return { call, rules, habits, tasks, approvalGrants, entries }
}

describe('GET /habits 与 POST /habits/revoke', () => {
  it('列出试用 / 留下 / 撤掉的;她撤掉一条之后挪到撤掉那一栏', async () => {
    const t = await serve()
    await t.rules.putHabits([habit(), habit({ id: '时段:13', kind: 'quiet', 类: '13 点', value: '13', text: '13:00–14:00 不打电话,改发消息', status: 'kept' })])
    const view = (await t.call('/habits')).body as unknown as HabitsView
    expect(view.trial.map(one => one.id)).toEqual([`分派:${CODE}→codex`])
    expect(view.kept.map(one => one.id)).toEqual(['时段:13'])
    expect(view.trial[0]).toMatchObject({ kind_title: '默认分派', applied: 0 })

    // 不是她(没身份的 curl)不能撤
    expect((await t.call('/habits/revoke', { body: { id: '时段:13' } })).status).toBe(403)
    const done = await t.call('/habits/revoke', { body: { id: '时段:13' }, headers: PAGE })
    expect(done.status).toBe(200)
    expect(String(done.body.note)).toContain('不会再自己学回来')
    expect((await t.call('/habits/revoke', { body: { id: '时段:13' }, headers: PAGE })).status).toBe(409)
    expect((await t.call('/habits/revoke', { body: { id: '没有' }, headers: PAGE })).status).toBe(404)
    const after = (await t.call('/habits')).body as unknown as HabitsView
    expect(after.retired.map(one => `${one.id}:${one.status}`)).toEqual(['时段:13:removed'])
    // 撤掉也进行为账(她做的一次拍板)
    expect((await t.entries()).filter(e => e.事 === '拍板').map(e => e.结果)).toEqual(['撤掉习惯'])
  })
})

describe('派活那一条带上「类」;学到的默认分派进推荐', () => {
  it('试用「写代码的活默认给 Codex」时推荐的是 Codex;她改派 Claude → 账里记下类与推荐,学一遍就撤', async () => {
    const t = await serve()
    await t.rules.putHabits([habit()])
    const task = await t.tasks.create({ title: '修一下首页的报错', direction: 'mine', status: 'todo' })
    const choices = await t.call(`/dispatch/choices?item=${task.id}`)
    expect(choices.body.default).toBe('codex')
    expect(String(choices.body.default_why)).toContain('按你的习惯')
    await t.call('/dispatch/run', { body: { item_id: task.id, app: 'claude' }, headers: PAGE })
    const picked = (await t.entries()).filter(e => e.事 === '派活')
    expect(picked).toEqual([expect.objectContaining({ 类: CODE, 推荐: 'codex' })])
    expect(picked[0]?.结果.startsWith('claude')).toBe(true)
    expect((await t.habits.learn()).reverted).toBe(1)
    expect(t.habits.dispatchDefault('code')).toBeUndefined()
  })
})

describe('收回「同类都允许」记成一次纠正', () => {
  it('记 拍板 · 收回同类都允许,带那一类', async () => {
    const t = await serve()
    // 记在一件还在办的事上(办完 / 不在了的那几条会被顺手作废)
    const task = await t.tasks.create({ title: '改首页', direction: 'mine', status: 'doing' })
    t.approvalGrants.grant({ sessionId: 's-1', taskId: task.id }, { key: 'repo:/Users/her/app', title: '改「app」这个仓库' })
    const done = await t.call('/approvals/grant/revoke', { body: { task_id: task.id, session_id: 's-1', key: 'repo:/Users/her/app' }, headers: PAGE })
    expect(done.status).toBe(200)
    expect((await t.entries()).filter(e => e.事 === '拍板')).toEqual([
      expect.objectContaining({ 结果: GRANT_REVOKED, 类: 'repo:/Users/her/app', 对象: `${task.id} 改「app」这个仓库` }),
    ])
  })
})
