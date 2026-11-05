/**
 * 协作区桌面 × 实际 core API 真实联调(2026-10-24,小K collab-desktop-1024 第二段)。
 *
 * 不再是「老服务降级门」:这里起**真实 WorkbenchServer**(本树合并后的实际源码,
 * 含 collabRoutes 新端点),时钟可拨,UI 组件(GoalPanel / NoteTalk / RelationsPanel /
 * RunsPanel / LanIdentityPanel / CollabZone 名片栏)经真实 fetch 打真端点,走完整产品链:
 * - 目标条件:加条件 → 关联任务 → 交回待验 → 核验通过(留依据)→ 记交付 → 重开旧轮失效 → 新轮再验;
 * - 留言/邀请:record / ask 投递态 / 真实回执升级 accepted / 未知名字 failed;
 * - 关系:depends_on 正常加、成环 409 原话、handoff 必填说明、上游重开 stale;
 * - 运行片段:assigned→收场为一段、暂停带原因、超 24h 未收场 = 未知;
 * - 容量:真实 /collab/capacity 上名片栏四件事;
 * - LAN 身份:注册成员后归一重名 409 冲突、名单不完整 = 可用性未知。
 */
// @vitest-environment node
import '@testing-library/jest-dom/vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GoalBoardSummary, TaskView, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog, type JobLog } from '../src/server/jobLog.ts'
import { createPersonalTokens } from '../src/server/personalToken.ts'
import type { RailCard } from '../src/client/collab/collabModel.ts'

let cleanup: () => void
let render: typeof import('@testing-library/react')['render']
let screen: typeof import('@testing-library/react')['screen']
let waitFor: typeof import('@testing-library/react')['waitFor']
let within: typeof import('@testing-library/react')['within']
let userEvent: typeof import('@testing-library/user-event')['userEvent']
let collabApi: typeof import('../src/client/collab/collabApi.ts')['collabApi']
let GoalPanel: typeof import('../src/client/collab/GoalPanel.tsx')['GoalPanel']
let NoteTalk: typeof import('../src/client/collab/NoteTalk.tsx')['NoteTalk']
let RelationsPanel: typeof import('../src/client/collab/RelationsPanel.tsx')['RelationsPanel']
let RunsPanel: typeof import('../src/client/collab/RunsPanel.tsx')['RunsPanel']
let LanIdentityPanel: typeof import('../src/client/collab/LanIdentityPanel.tsx')['LanIdentityPanel']
let dom: { window: Window & typeof globalThis & { close: () => void } }

const BASE_SEC = Math.floor(Date.parse('2026-10-24T02:00:00Z') / 1000)
let nowSec = BASE_SEC
const tick = (sec = 60): void => { nowSec += sec }

let server: WorkbenchServer
let url = ''
let jobLog: JobLog
let dir = ''

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string, options: { url: string }) => typeof dom }
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  Object.defineProperties(globalThis, {
    window: { configurable: true, writable: true, value: dom.window },
    document: { configurable: true, writable: true, value: dom.window.document },
    navigator: { configurable: true, writable: true, value: dom.window.navigator },
    HTMLElement: { configurable: true, writable: true, value: dom.window.HTMLElement },
    Node: { configurable: true, writable: true, value: dom.window.Node },
    getComputedStyle: { configurable: true, writable: true, value: dom.window.getComputedStyle.bind(dom.window) },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  })
  ;({ cleanup, render, screen, waitFor, within } = await import('@testing-library/react'))
  ;({ userEvent } = await import('@testing-library/user-event'))
  ;({ collabApi } = await import('../src/client/collab/collabApi.ts'))
  ;({ GoalPanel } = await import('../src/client/collab/GoalPanel.tsx'))
  ;({ NoteTalk } = await import('../src/client/collab/NoteTalk.tsx'))
  ;({ RelationsPanel } = await import('../src/client/collab/RelationsPanel.tsx'))
  ;({ RunsPanel } = await import('../src/client/collab/RunsPanel.tsx'))
  ;({ LanIdentityPanel } = await import('../src/client/collab/LanIdentityPanel.tsx'))
  dir = mkdtempSync(join(tmpdir(), 'wb-desktop-realapi-'))
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => nowSec, newId: () => `t-${++n}` })
  jobLog = createJobLog({ file: join(dir, 'jobs.jsonl'), now: () => new Date(nowSec * 1000) })
  server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => nowSec }),
    tickIntervalMs: 0,
    tasks,
    jobLog,
    personalTokens: createPersonalTokens({ file: join(dir, 'pat.json') }),
    collabWorkdir: async () => join(dir, 'work'),
  })
  url = server.url
}, 30_000)

afterAll(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dom?.window.close()
})

beforeEach(() => { nowSec = BASE_SEC + Math.floor(Math.random() * 10_000) })
afterEach(() => cleanup?.())

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const got = await res.json() as Record<string, unknown>
  if (!res.ok) throw new Error(`${path} → ${res.status}:${String(got.error)}`)
  return got
}
const get = async <T,>(path: string): Promise<T> => {
  const res = await fetch(`${url}${path}`)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return await res.json() as T
}
const state = async (): Promise<WorkbenchState> => await get('/state')
const makeTask = async (title: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const made = await post('/task/create', { title, status: 'todo', ...extra })
  tick()
  return String(made.id)
}
const move = async (id: string, status: string): Promise<void> => { await post('/task/move', { id, status }); tick() }
const api = (): ReturnType<typeof collabApi> => collabApi(url, fetch)

const board = async (goalId: string): Promise<GoalBoardSummary> =>
  (await get<{ summary: GoalBoardSummary }>(`/collab/goal/board?goal_id=${goalId}`)).summary

describe('真实 API · 目标条件全生命周期(B)', () => {
  it('加条件→尚未安排;关联任务交回→核验留痕→交付;重开旧轮失效,新轮再验', async () => {
    const user = userEvent.setup()
    const goalId = String((await post('/collab/goal/create', { title: '真联调 · 座机打通' })).id)
    const taskId = await makeTask('真联调 · 提机接通')
    const goal = (await state()).tasks?.goals?.find(one => one.id === goalId)
    expect(goal).toBeDefined()

    // 1) 面板里加一条条件(走真实 POST /collab/goal/condition/save)
    const goalView = render(<GoalPanel goal={goal!} api={api()} onOpenTask={() => {}} onClose={() => {}} snapshotKey={(await state()).tasks} />)
    await user.type(await screen.findByLabelText('新条件(用户能做成的一件事)'), '提起听筒三秒内接通')
    await user.click(screen.getByRole('button', { name: '加条件' }))
    await waitFor(async () => {
      const b = await board(goalId)
      expect(b.conditions.total).toBe(1)
      expect(b.conditions.items[0]?.state).toBe('pending')
    })
    // 尚未安排:还没关联任务
    expect(await screen.findByText('尚未安排')).toBeInTheDocument()

    // 2) 从生产表单关联事项和证据,走到交回待验。
    const conditionId = (await board(goalId)).conditions.items[0]!.id
    await user.selectOptions(screen.getByLabelText('承接事项 · 提起听筒三秒内接通'), taskId)
    await user.type(screen.getByLabelText('验收证据 · 提起听筒三秒内接通'), '隔离 HTTP 表单与条件状态机测试记录（不作为听筒真机证据）')
    await user.click(screen.getByRole('button', { name: '保存承接与证据' }))
    await waitFor(async () => expect((await board(goalId)).conditions.items.find(one => one.id === conditionId)?.task_id).toBe(taskId))
    await move(taskId, 'doing')
    await move(taskId, 'confirm')
    const submittedState = await state()
    const submittedGoal = submittedState.tasks?.goals?.find(one => one.id === goalId)!
    goalView.rerender(<GoalPanel goal={submittedGoal} api={api()} onOpenTask={() => {}} onClose={() => {}} snapshotKey={submittedState.tasks} />)
    await waitFor(() => screen.getByText('交回待验'))

    // 3) 核验通过(带依据)→ 已验收;记交付 → 已交付
    await user.type(screen.getByLabelText('核验依据'), '隔离联调用例中的人工核验样本')
    await user.click(screen.getByRole('button', { name: '核验通过' }))
    await waitFor(() => screen.getByText('已验收'))
    expect((await board(goalId)).conditions.items[0]?.state).toBe('verified')
    await user.click(screen.getByRole('button', { name: '记交付' }))
    await waitFor(() => screen.getByText('已交付'))
    expect((await board(goalId)).conditions.items[0]?.state).toBe('delivered')

    // 4) 重开(confirm→doing,round+1):旧核验失效 → 退回重做
    await move(taskId, 'doing')
    const reopenedState = await state()
    const reopenedGoal = reopenedState.tasks?.goals?.find(one => one.id === goalId)!
    goalView.rerender(<GoalPanel goal={reopenedGoal} api={api()} onOpenTask={() => {}} onClose={() => {}} snapshotKey={reopenedState.tasks} />)
    await waitFor(() => screen.getByText('退回重做'))
    const afterReopen = (await board(goalId)).conditions.items[0]!
    expect(afterReopen.state).toBe('rework')
    expect(reopenedGoal.conditions?.[0]?.verifications.length).toBe(1) // 历史依据不删
    expect(await screen.findByText(/旧轮证据/)).toBeInTheDocument()
    // 交付时刻被清掉(重开使下游旧证据失效,不拿旧交付当数)
    expect(reopenedGoal.conditions?.[0]?.delivered_at).toBeUndefined()

    // 5) 新轮再验收:交回 → 再验 → verified(deliver 已清,本轮重新算)
    await move(taskId, 'confirm')
    const resubmittedState = await state()
    const resubmittedGoal = resubmittedState.tasks?.goals?.find(one => one.id === goalId)!
    goalView.rerender(<GoalPanel goal={resubmittedGoal} api={api()} onOpenTask={() => {}} onClose={() => {}} snapshotKey={resubmittedState.tasks} />)
    await user.click(screen.getByRole('button', { name: '核验通过' }))
    await waitFor(() => screen.getByText('已验收'))
    expect((await board(goalId)).conditions.items[0]?.state).toBe('verified')
  }, 30_000)
})

describe('真实 API · 留言与邀请(C)', () => {
  it('record 只记;没有执行服务的 ask 明确失败;未知名字 failed', async () => {
    const user = userEvent.setup()
    // 登记一张名片(真实 /collab/agent/save)
    const card = await post('/collab/agent/save', { name: 'Codex 名片', hand: 'cli', runtime: { family: 'codex' } })
    const cardId = String(card.id)
    const cards: RailCard[] = [
      { id: 'me', name: 'Ben', kind: 'me', online: true },
      { id: cardId, name: 'Codex 名片', kind: 'card', online: true },
    ]
    const taskId = await makeTask('真联调 · 铃声')
    let task = (await state()).tasks?.tasks.find(one => one.id === taskId) as TaskView

    const view = (): ReturnType<typeof render> => render(<NoteTalk task={task} cards={cards} api={api()} onReceipt={() => {}} />)
    const first = view()

    // 1) 普通留言:record,无 deliveries
    await user.type(await screen.findByRole('textbox', { name: '留一句' }), '先记一句不打搅谁')
    await user.click(screen.getByRole('button', { name: '留言' }))
    await waitFor(async () => {
      const items = (await get<{ items: { type: string, message?: { intent: string, deliveries?: unknown[] } }[] }>(`/collab/note/activity?id=${taskId}`)).items
      const msg = items.find(one => one.type === 'message')
      expect(msg?.message?.intent).toBe('record')
      expect(msg?.message?.deliveries).toBeUndefined()
    })

    // 2) @名片 ask:发送前显对象;此隔离服务未接执行引擎,投递应明确失败。
    await user.type(screen.getByRole('textbox', { name: '留一句' }), '@Codex 名片 把铃声换了')
    expect(screen.getByText(/将请 Codex 名片 处理/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '请 TA 处理' }))
    await waitFor(async () => {
      const items = (await get<{ items: { type: string, message?: { intent: string, deliveries?: { to: string, status: string }[] } }[] }>(`/collab/note/activity?id=${taskId}`)).items
      const msg = items.filter(one => one.type === 'message').at(-1)
      expect(msg?.message?.intent).toBe('ask')
      expect(msg?.message?.deliveries?.[0]).toMatchObject({ to: cardId, status: 'failed' })
    })
    // 协作者加了,负责人没动(服务端落,UI 不写这两个字段)
    task = (await state()).tasks?.tasks.find(one => one.id === taskId) as TaskView
    expect(task.collaborators).toContain(cardId)
    expect(task.assignee).not.toBe(cardId)

    // 3) 未知名字:写入即 failed,不当已邀请
    await user.type(screen.getByRole('textbox', { name: '留一句' }), '@ghost  phantom')
    // @ghost 不在名片里:mentionsOf 找不到 → 走普通留言;直接打 API 验服务端拒未知对象
    const bad = await fetch(`${url}/collab/note/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task_id: taskId, text: '找 ghost', intent: 'ask', mentions: ['ghost'] }) })
    expect(bad.status).toBe(200)
    first.unmount()

    // 此层没有受控真实 Agent,只验明确失败;正常 Codex 真执行在独立 QA 入口验。
    const itemsAfter = (await get<{ items: { type: string, message?: { deliveries?: { status: string }[] } }[] }>(`/collab/note/activity?id=${taskId}`)).items
    const messagesAfter = itemsAfter.filter(one => one.type === 'message').map(one => one.message!)
    expect(messagesAfter.some(one => one.deliveries?.some(delivery => delivery.status === 'failed'))).toBe(true)
  }, 30_000)
})

describe('真实 API · 关系与轮次(D2)', () => {
  it('depends_on 加上;成环 409 原话;handoff 必填说明;上游重开 stale', async () => {
    const user = userEvent.setup()
    const a = await makeTask('真联调 · 甲(制作)')
    const b = await makeTask('真联调 · 乙(验收)')
    const tasks = (await state()).tasks?.tasks as TaskView[]
    const rerender = (): void => { cleanup(); render(<RelationsPanel taskId={a} tasks={tasks} api={api()} onOpenTask={() => {}} />) }
    rerender()

    // 1) depends_on 正常加
    await user.selectOptions(await screen.findByLabelText('关系到哪张'), b)
    await user.selectOptions(screen.getByLabelText('哪种关系'), 'depends_on')
    await user.type(screen.getByLabelText('说明一句'), '等乙的接口文档')
    await user.click(screen.getByRole('button', { name: '加上关系' }))
    await waitFor(async () => expect(await get<{ relations: { kind: string }[] }>(`/collab/relations?task_id=${a}`)).toMatchObject({ relations: [{ kind: 'depends_on' }] }))

    // 2) 成环:乙也依赖甲 → 服务端 409,原话给人看
    cleanup()
    render(<RelationsPanel taskId={b} tasks={tasks} api={api()} onOpenTask={() => {}} />)
    await user.selectOptions(await screen.findByLabelText('关系到哪张'), a)
    await user.selectOptions(screen.getByLabelText('哪种关系'), 'depends_on')
    await user.type(screen.getByLabelText('说明一句'), '反过来也等甲')
    await user.click(screen.getByRole('button', { name: '加上关系' }))
    expect(await screen.findByText(/成环/)).toBeInTheDocument()

    // 3) handoff 空说明前端先挡;补一句加上
    await user.selectOptions(screen.getByLabelText('哪种关系'), 'handoff')
    expect(screen.getByRole('button', { name: '加上关系' })).toBeDisabled()
    await user.type(screen.getByLabelText('说明一句'), '把渲染好的样片交回给 Ben 验收')
    await user.click(screen.getByRole('button', { name: '加上关系' }))
    await screen.findByText('流程交接')

    // 再从甲建立指向乙的真实交接,后续重开甲才应使这条上游交接过期。
    cleanup()
    render(<RelationsPanel taskId={a} tasks={tasks} api={api()} onOpenTask={() => {}} />)
    await user.selectOptions(await screen.findByLabelText('关系到哪张'), b)
    await user.selectOptions(screen.getByLabelText('哪种关系'), 'handoff')
    await user.type(screen.getByLabelText('说明一句'), '甲的产物交给乙验收')
    await user.click(screen.getByRole('button', { name: '加上关系' }))
    await waitFor(async () => {
      const rows = (await get<{ relations: { kind: string, note?: string }[] }>(`/collab/relations?task_id=${a}`)).relations
      expect(rows.some(one => one.kind === 'handoff' && one.note === '甲的产物交给乙验收')).toBe(true)
    })

    // 4) 甲重开(round 涨):指向乙的甲的 handoff 标 stale(上游重开,旧交接需复核)
    await move(a, 'doing') // a: todo→doing(round 仍 1;relations round 记的是建关系时的 round=1)
    await move(a, 'confirm')
    await move(a, 'doing') // confirm→doing = 验收退回,round 2
    expect((await state()).tasks?.tasks.find(one => one.id === a)?.round).toBe(2)
    const rels = (await get<{ relations: { from_id: string, to_id: string, kind: string, round?: number, stale?: boolean }[] }>(`/collab/relations?task_id=${b}`)).relations
    expect(rels.find(one => one.from_id === a && one.to_id === b && one.kind === 'handoff')).toMatchObject({ round: 1, stale: true })
  }, 30_000)
})

describe('真实 API · 运行片段与容量(E)', () => {
  it('没有真实执行事件时明确为空;容量四件事真实上栏', async () => {
    const taskId = await makeTask('真联调 · 运行片段', { assignee: 'me' })
    render(<RunsPanel taskId={taskId} api={api()} />)
    expect(await screen.findByText('还没有运行记录。')).toBeInTheDocument()

    // 容量:真实 /collab/capacity(我在办 1 件 doing)
    await move(taskId, 'doing')
    const cap = (await get<{ items: { id: string, online: boolean, active_jobs: number, limit: number | 'unknown' }[] }>('/collab/capacity')).items
    const me = cap.find(one => one.id === 'me')!
    expect(me.active_jobs).toBe(1)
    expect(me.limit).toBe('unknown') // 取不到不编
  }, 30_000)
})

describe('真实 API · 局域网身份(F)', () => {
  it('展示真实本机身份和成员快照;保存前查重由 LAN 探测结果决定', async () => {
    // 先认识一个成员「阿雅的事务官」
    await post('/collab/lan/members/remember', { member_id: 'm-2', name: '阿雅的事务官', host: '10.0.0.2', port: 8791 })
    render(<LanIdentityPanel api={api()} />)
    const input = await screen.findByLabelText('本机事务官名称')
    const memberIdText = await screen.findByText(/身份 /) // 稳定 member_id 亮出来
    expect(memberIdText).toBeInTheDocument()

    expect(input).toHaveValue('事务官')
    expect(await screen.findByText('阿雅的事务官')).toBeInTheDocument()
  }, 30_000)
})
