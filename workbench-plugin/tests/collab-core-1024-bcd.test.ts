// @vitest-environment node
/*
 * 协作区事实层 B / C / D2 三个切片的服务端契约测试
 * (2026-10-24,`docs/../../collab-core-kimi-contract.md` §1/§2/§3):
 * B = 目标能力条件与动态验收;C = 留言 / 邀请 / 活动流;D2 = 任务关系 / 轮次。
 *
 * harness 照抄 tests/collab-http.test.ts,时钟做成可拨的:活动流排序与
 * 「回执晚于留言才升级 accepted」都要靠时间先后断言。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActivityItem, GoalBoardSummary, NoteMessage, TaskRelation, TaskView, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createPersonalTokens } from '../src/server/personalToken.ts'

const BASE_SEC = Math.floor(Date.parse('2026-10-24T01:00:00Z') / 1000)
let nowSec = BASE_SEC
/** 拨时钟(秒):同一 serve 里先后发生的动作才能排出时间序。 */
const tick = (sec = 60): void => { nowSec += sec }

const started: WorkbenchServer[] = []
const dirs: string[] = []

beforeEach(() => { nowSec = BASE_SEC })

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-collab-bcd-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => nowSec, newId: () => `t-${++n}` })
  const jobLog = createJobLog({ now: () => new Date(nowSec * 1000) })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => nowSec }),
    tickIntervalMs: 0,
    tasks,
    jobLog,
    personalTokens: createPersonalTokens({ file: join(dir, 'pat.json') }),
    collabWorkdir: async () => join(dir, 'work'),
  })
  started.push(server)
  return { url: server.url, jobLog, tasks }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function get(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function state(url: string): Promise<WorkbenchState> {
  return (await (await fetch(`${url}/state`)).json()) as WorkbenchState
}

async function board(url: string, goalId: string): Promise<GoalBoardSummary> {
  const got = await get(url, `/collab/goal/board?goal_id=${encodeURIComponent(goalId)}`)
  expect(got.status).toBe(200)
  return (got.body as { summary: GoalBoardSummary }).summary
}

/** 建一张便签(老形状,不过四样的门),顺手把时钟拨一格。HTTP 建卡缺省进「待排」,这里显式给「待办」。 */
async function makeTask(url: string, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const made = await post(url, '/task/create', { title, status: 'todo', ...extra })
  expect(made.status).toBe(200)
  tick()
  return String(made.body.id)
}

const move = (url: string, id: string, status: string) => post(url, '/task/move', { id, status })

async function makeGoal(url: string, title = '目标甲'): Promise<string> {
  const made = await post(url, '/collab/goal/create', { title })
  expect(made.status).toBe(200)
  tick()
  return String(made.body.id)
}

async function saveCondition(url: string, goalId: string, text: string, extra: Record<string, unknown> = {}) {
  return post(url, '/collab/goal/condition/save', { goal_id: goalId, text, evidence: ['test-artifact:controlled-fixture'], ...extra })
}

/* ─────────────────────────── B:目标能力条件与动态验收 ─────────────────────────── */

describe('B · 目标条件:条数与保存', () => {
  it('建目标带 3–7 条条件;再存第 8 条 409', async () => {
    const { url } = await serve()
    const conditions = Array.from({ length: 7 }, (_, i) => ({ text: `条件 ${i + 1}` }))
    const made = await post(url, '/collab/goal/create', { title: '短片上线', conditions })
    expect(made.status).toBe(200)
    const goalId = String(made.body.id)
    const eighth = await saveCondition(url, goalId, '条件 8')
    expect(eighth.status).toBe(409)
    expect(String(eighth.body.error)).toContain('最多')
    const seen = await board(url, goalId)
    expect(seen.conditions.total).toBe(7)
  })
  it('建目标带 2 条条件 409(下限 3)', async () => {
    const { url } = await serve()
    const made = await post(url, '/collab/goal/create', { title: '太少', conditions: [{ text: '一' }, { text: '二' }] })
    expect(made.status).toBe(409)
  })
  it('条件 text 空白 409;目标不存在 404', async () => {
    const { url } = await serve()
    const goalId = await makeGoal(url)
    expect((await saveCondition(url, goalId, '   ')).status).toBe(409)
    expect((await saveCondition(url, 'goal:没有', '正经条件')).status).toBe(404)
  })
  it('改既有条件保留核验历史;remove 只删条件不动任务', async () => {
    const { url } = await serve()
    const goalId = await makeGoal(url)
    const taskId = await makeTask(url, '承接卡')
    const saved = await saveCondition(url, goalId, '能导出成片', { task_id: taskId })
    const conditionId = String(saved.body.id)
    await move(url, taskId, 'doing')
    await move(url, taskId, 'confirm')
    expect((await post(url, '/collab/goal/condition/verify', { goal_id: goalId, condition_id: conditionId, by: 'me', pass: true })).status).toBe(200)
    tick()
    const updated = await saveCondition(url, goalId, '能导出 4K 成片', { id: conditionId })
    expect(updated.status).toBe(200)
    const seen = await board(url, goalId)
    expect(seen.conditions.items[0]!.text).toBe('能导出 4K 成片')
    const raw = (await state(url)).tasks?.goals?.find(one => one.id === goalId)
    expect(raw?.conditions?.[0]?.verifications).toHaveLength(2)
    expect(seen.conditions.items[0]!.state).toBe('rework')
    expect((await post(url, '/collab/goal/condition/remove', { goal_id: goalId, condition_id: conditionId })).status).toBe(200)
    expect((await board(url, goalId)).conditions.total).toBe(0)
    expect((await state(url)).tasks?.tasks.find(one => one.id === taskId)?.status).toBe('confirm')
  })
})

describe('B · 条件状态现算:pending→doing→blocked→submitted→verified→delivered', () => {
  it('AI 卡 doing 不能冒开工:先 unknown,派出是 dispatched,真实 started 才 doing', async () => {
    const { url, jobLog } = await serve()
    const goalId = await makeGoal(url)
    const taskId = await makeTask(url, '由 Agent 接手', { assignee: 'codex' })
    await move(url, taskId, 'doing')
    await saveCondition(url, goalId, 'Agent 能真实处理这件事', { task_id: taskId })
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('unknown')
    jobLog.append({ job: taskId, step: 'assigned', family: 'codex' })
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('dispatched')
    jobLog.append({ job: taskId, step: 'started', family: 'codex' })
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('doing')
  })

  it('未明确负责人时 doing 仍是未知,不能当作本人已开工', async () => {
    const { url } = await serve(), goalId = await makeGoal(url)
    const taskId = await makeTask(url, '未写谁做')
    await move(url, taskId, 'doing'); await saveCondition(url, goalId, '可使用', { task_id: taskId })
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('unknown')
  })

  it('每一步跟任务事实走', async () => {
    const { url } = await serve()
    const goalId = await makeGoal(url)
    const taskId = await makeTask(url, '剪样片', { assignee: 'me' })
    const conditionId = String((await saveCondition(url, goalId, '能剪出 30 秒样片', { task_id: taskId })).body.id)

    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('pending')
    await move(url, taskId, 'doing')
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('doing')
    await move(url, taskId, 'blocked')
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('blocked')
    await move(url, taskId, 'doing')
    await move(url, taskId, 'confirm')
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('submitted')

    const verified = await post(url, '/collab/goal/condition/verify', { goal_id: goalId, condition_id: conditionId, by: 'me', pass: true, note: '样片看过了' })
    expect(verified.status).toBe(200)
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('verified')

    expect((await post(url, '/collab/goal/condition/deliver', { goal_id: goalId, condition_id: conditionId })).status).toBe(200)
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('delivered')
    expect((await board(url, goalId)).conditions.by_state.delivered).toBe(1)
  })
  it('只有卡状态、没有任何成果证据时不能核验通过', async () => {
    const { url } = await serve()
    const goalId = await makeGoal(url)
    const taskId = await makeTask(url, '无成果')
    const saved = await saveCondition(url, goalId, '可使用', { task_id: taskId, evidence: [] })
    await move(url, taskId, 'doing'); await move(url, taskId, 'confirm')
    expect((await post(url, '/collab/goal/condition/verify', { goal_id: goalId, condition_id: saved.body.id, by: 'me', pass: true })).status).toBe(409)
  })
  it('验收退回必须说明修改要求,承接事项重开新轮并保留退回记录', async () => {
    const { url } = await serve()
    const goalId = await makeGoal(url), taskId = await makeTask(url, '制作')
    const saved = await saveCondition(url, goalId, '能使用', { task_id: taskId })
    await move(url, taskId, 'doing'); await move(url, taskId, 'confirm')
    const payload = { goal_id: goalId, condition_id: saved.body.id, by: 'me', pass: false }
    expect((await post(url, '/collab/goal/condition/verify', payload)).status).toBe(409)
    expect((await post(url, '/collab/goal/condition/verify', { ...payload, note: '请补负数情况' })).status).toBe(200)
    const task = (await state(url)).tasks!.tasks.find(t => t.id === taskId)!
    expect(task).toMatchObject({ status: 'doing', round: 2 })
    expect(task.comments?.at(-1)).toMatchObject({ verdict: 'rework', text: '请补负数情况' })
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('rework')
  })
  it('任务在 doing 时 verify 409(没有成果可验)', async () => {
    const { url } = await serve()
    const goalId = await makeGoal(url)
    const taskId = await makeTask(url, '在做的卡')
    const conditionId = String((await saveCondition(url, goalId, '条件', { task_id: taskId })).body.id)
    await move(url, taskId, 'doing')
    const verified = await post(url, '/collab/goal/condition/verify', { goal_id: goalId, condition_id: conditionId, by: 'me', pass: true })
    expect(verified.status).toBe(409)
  })
  it('verify 记任务当前轮次;deliver 只允许 verified,否则 409', async () => {
    const { url } = await serve()
    const goalId = await makeGoal(url)
    const taskId = await makeTask(url, '卡')
    const conditionId = String((await saveCondition(url, goalId, '条件', { task_id: taskId })).body.id)
    await move(url, taskId, 'doing')
    await move(url, taskId, 'confirm')
    expect((await post(url, '/collab/goal/condition/deliver', { goal_id: goalId, condition_id: conditionId })).status).toBe(409)
    await post(url, '/collab/goal/condition/verify', { goal_id: goalId, condition_id: conditionId, by: 'me', pass: true })
    const raw = (await state(url)).tasks?.goals?.find(one => one.id === goalId)
    expect(raw?.conditions?.[0]?.verifications[0]).toMatchObject({ by: 'me', round: 1 })
  })
  it('重开(done→doing)round 涨、旧核验失效、delivered_at 清掉、条件回 rework;再验再交付恢复', async () => {
    const { url } = await serve()
    const goalId = await makeGoal(url)
    const taskId = await makeTask(url, '样片卡')
    const conditionId = String((await saveCondition(url, goalId, '能剪出样片', { task_id: taskId })).body.id)
    await move(url, taskId, 'doing')
    await move(url, taskId, 'confirm')
    await post(url, '/collab/goal/condition/verify', { goal_id: goalId, condition_id: conditionId, by: 'me', pass: true })
    await post(url, '/collab/goal/condition/deliver', { goal_id: goalId, condition_id: conditionId })
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('delivered')
    // done→doing 重开
    await move(url, taskId, 'done')
    await move(url, taskId, 'doing')
    const task = (await state(url)).tasks?.tasks.find(one => one.id === taskId)
    expect(task?.round).toBe(2)
    expect(task?.transitions?.length).toBeGreaterThan(0)
    const seen = await board(url, goalId)
    expect(seen.conditions.items[0]!.state).toBe('rework')
    const raw = (await state(url)).tasks?.goals?.find(one => one.id === goalId)
    expect(raw?.conditions?.[0]?.delivered_at).toBeUndefined()
    expect(raw?.conditions?.[0]?.verifications).toHaveLength(1)
    // 旧核验失效:再 verify 前仍 rework;doing 时 verify 仍 409
    expect((await post(url, '/collab/goal/condition/verify', { goal_id: goalId, condition_id: conditionId, by: 'me', pass: true })).status).toBe(409)
    // 重新交回、本轮再验、再交付
    await move(url, taskId, 'confirm')
    await post(url, '/collab/goal/condition/verify', { goal_id: goalId, condition_id: conditionId, by: 'me', pass: true })
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('verified')
    expect((await post(url, '/collab/goal/condition/deliver', { goal_id: goalId, condition_id: conditionId })).status).toBe(200)
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('delivered')
  })
  it('任务取消 → 条件回 pending(取消不算达成)', async () => {
    const { url } = await serve()
    const goalId = await makeGoal(url)
    const taskId = await makeTask(url, '要取消的卡')
    await saveCondition(url, goalId, '条件', { task_id: taskId })
    await move(url, taskId, 'confirm')
    await move(url, taskId, 'canceled')
    expect((await board(url, goalId)).conditions.items[0]!.state).toBe('pending')
  })
})

describe('B · 目标汇总投影', () => {
  it('父子不双计、取消单列、pending 计数、item 带承接人', async () => {
    const { url } = await serve()
    const goalId = await makeGoal(url)
    const childId = await makeTask(url, '子卡', { status: 'doing' })
    const parentId = await makeTask(url, '父卡')
    const canceledId = await makeTask(url, '取消的卡')
    const otherId = await makeTask(url, '别的目标的卡')
    // 挂目标走 /task/update(建卡那道四样的门只拦新形状,这里老形状建完再挂)
    for (const [id, goal] of [[childId, goalId], [parentId, goalId], [canceledId, goalId], [otherId, 'goal:别处']] as const) {
      expect((await post(url, '/task/update', { id, goal_id: goal })).status).toBe(200)
    }
    expect((await post(url, '/task/update', { id: parentId, children: [childId] })).status).toBe(200)
    await move(url, canceledId, 'canceled')
    await saveCondition(url, goalId, '有承接的条件', { task_id: childId })
    await saveCondition(url, goalId, '没安排的条件甲')
    await saveCondition(url, goalId, '没安排的条件乙')

    const seen = await board(url, goalId)
    expect(seen.goal_id).toBe(goalId)
    expect(typeof seen.scope).toBe('string')
    // 任务统计:父卡不双计(只计子卡),取消单列,别的目标不计
    expect(seen.tasks.total).toBe(1)
    expect(seen.tasks.by_status.doing).toBe(1)
    expect(seen.tasks.canceled).toBe(1)
    expect(seen.tasks.unscheduled).toBe(2)
    // 任务账 doing 与执行事实分开:无负责人没有开工证据,条件一条 unknown、两条 pending
    expect(seen.conditions.total).toBe(3)
    expect(seen.conditions.by_state.unknown).toBe(1)
    expect(seen.conditions.by_state.pending).toBe(2)
    const withTask = seen.conditions.items.find(one => one.task_id === childId)
    expect(withTask?.assignee).toBeUndefined()
    expect(withTask?.state).toBe('unknown')
  })
  it('不带 goal_id 返回全部目标汇总;带错的 id 404', async () => {
    const { url } = await serve()
    await makeGoal(url, '甲')
    await makeGoal(url, '乙')
    const all = await get(url, '/collab/goal/board')
    expect(all.status).toBe(200)
    expect((all.body as { summaries: unknown[] }).summaries).toHaveLength(2)
    expect((await get(url, '/collab/goal/board?goal_id=goal:没有')).status).toBe(404)
  })
  it('受阻的条件给 blocker(卡 blocked 时)', async () => {
    const { url } = await serve()
    const goalId = await makeGoal(url)
    const taskId = await makeTask(url, '卡住了')
    await saveCondition(url, goalId, '条件', { task_id: taskId })
    await move(url, taskId, 'blocked')
    const seen = await board(url, goalId)
    expect(seen.conditions.items[0]!.state).toBe('blocked')
    expect(seen.conditions.items[0]!.blocker).toBeDefined()
  })
})

/* ─────────────────────────── C:留言 / 邀请 / 活动流 ─────────────────────────── */

describe('C · 留言与邀请', () => {
  it('record 只落记录,无 deliveries', async () => {
    const { url } = await serve()
    const taskId = await makeTask(url, '卡')
    const said = await post(url, '/collab/note/message', { task_id: taskId, text: '先记一笔', intent: 'record' })
    expect(said.status).toBe(200)
    const message = said.body.message as NoteMessage
    expect(message.intent).toBe('record')
    expect(message.deliveries).toBeUndefined()
    const task = (await state(url)).tasks?.tasks.find(one => one.id === taskId)
    expect(task?.messages).toHaveLength(1)
  })
  it('ask:me 立即 delivered;不存在的名片 failed 带 unknown target', async () => {
    const { url } = await serve()
    const taskId = await makeTask(url, '卡')
    const asked = await post(url, '/collab/note/message', { task_id: taskId, text: '谁来接?', intent: 'ask', mentions: ['me', 'agent:不存在的'] })
    expect(asked.status).toBe(200)
    const deliveries = (asked.body.message as NoteMessage).deliveries ?? []
    expect(deliveries[0]!).toMatchObject({ to: 'me', status: 'delivered' })
    expect(deliveries[1]!).toMatchObject({ to: 'agent:不存在的', status: 'failed' })
    expect(String(deliveries[1]!.error)).toContain('unknown target: agent:不存在的')
  })
  it('ask 无 mentions 409;ask 把 mention 加进 collaborators 且 assignee 不动', async () => {
    const { url } = await serve()
    const taskId = await makeTask(url, '卡', { assignee: 'codex', collaborators: ['kimi'] })
    expect((await post(url, '/collab/note/message', { task_id: taskId, text: '问一句', intent: 'ask' })).status).toBe(409)
    const asked = await post(url, '/collab/note/message', { task_id: taskId, text: '问一句', intent: 'ask', mentions: ['me', 'kimi'] })
    expect(asked.status).toBe(200)
    const task = (await state(url)).tasks?.tasks.find(one => one.id === taskId)
    expect(task?.collaborators).toEqual(['kimi', 'me'])
    expect(task?.assignee).toBe('codex')
  })
  it('同一 client_msg_id 重发 → duplicated,不新建留言', async () => {
    const { url } = await serve()
    const taskId = await makeTask(url, '卡')
    const first = await post(url, '/collab/note/message', { task_id: taskId, text: '断网前那句', intent: 'record', client_msg_id: 'cm-1' })
    expect(first.status).toBe(200)
    tick()
    const again = await post(url, '/collab/note/message', { task_id: taskId, text: '断网前那句', intent: 'record', client_msg_id: 'cm-1' })
    expect(again.status).toBe(200)
    expect(again.body.duplicated).toBe(true)
    expect((again.body.message as NoteMessage).id).toBe((first.body.message as NoteMessage).id)
    const task = (await state(url)).tasks?.tasks.find(one => one.id === taskId)
    expect(task?.messages).toHaveLength(1)
  })
  it('协作留言同 client_key 响应丢失后重试回放原留言', async () => {
    const { url } = await serve()
    const taskId = await makeTask(url, '协作留言补发')
    const first = await post(url, '/collab/note/message', { task_id: taskId, text: '请接手', intent: 'record', client_key: 'outbox-1' })
    expect(first.status).toBe(200)
    const replay = await post(url, '/collab/note/message', { task_id: taskId, text: '请接手', intent: 'record', client_key: 'outbox-1' })
    expect(replay.status).toBe(200)
    expect((replay.body.message as NoteMessage).id).toBe((first.body.message as NoteMessage).id)
    expect((await state(url)).tasks?.tasks.find(one => one.id === taskId)?.messages).toHaveLength(1)
  })
  it('便签不存在 404', async () => {
    const { url } = await serve()
    expect((await post(url, '/collab/note/message', { task_id: 't-没有', text: 'x', intent: 'record' })).status).toBe(404)
  })
})

describe('C · 活动流', () => {
  it('POST /task/comment 同 client_key 重试只写一条评论', async () => {
    const { url } = await serve()
    const taskId = await makeTask(url, '离线补发留言')
    const first = await post(url, '/task/comment', { id: taskId, text: '请看这个修改', client_key: 'comment-retry-1' })
    expect(first.status).toBe(200)
    const again = await post(url, '/task/comment', { id: taskId, text: '请看这个修改', client_key: 'comment-retry-1' })
    expect(again.status).toBe(first.status)
    expect(again.body.comment_id).toBe(first.body.comment_id)
    const task = (await state(url)).tasks?.tasks.find(one => one.id === taskId)
    expect(task?.comments).toHaveLength(1)
  })

  it('按 at 升序合一 message/comment/receipt/transition', async () => {
    const { url } = await serve()
    const taskId = await makeTask(url, '卡')
    await post(url, '/collab/note/message', { task_id: taskId, text: '第一条', intent: 'record' })
    tick()
    await post(url, '/task/comment', { id: taskId, text: '改一改', verdict: 'rework' })
    tick()
    await move(url, taskId, 'doing')
    tick()
    await post(url, '/task/receipt', { id: taskId, receipt: 'done', text: '做完:好了', by: 'codex' })

    const got = await get(url, `/collab/note/activity?id=${taskId}`)
    expect(got.status).toBe(200)
    const items = (got.body as { items: ActivityItem[] }).items
    // 回执会按 statusPathTo 挪卡,多一条 doing→confirm 的 transition;同时刻 receipt 排在它前面。
    // 10-29 第 4 步起凡交回都核:/task/receipt 落进「等你确认」即进核验,卡上没验收条件 → 事务官留一条「核不了」留言(by: butler),同一刻排在 receipt 前。
    expect(items.map(one => one.type)).toEqual(['message', 'comment', 'transition', 'comment', 'receipt', 'transition'])
    expect(items.filter(one => one.type === 'comment')[1]).toMatchObject({ comment: { by: 'butler' } })
    const ats = items.map(one => Date.parse(one.at))
    expect([...ats].sort((a, b) => a - b)).toEqual(ats)
    const transition = items.find(one => one.type === 'transition')
    expect(transition).toMatchObject({ from: 'todo', to: 'doing' })
    const comment = items.find(one => one.type === 'comment')
    expect(comment).toMatchObject({ comment: { verdict: 'rework' } })
  })
  it('只有精确 message_id 回执才将本条邀请升级 accepted', async () => {
    const { url, tasks } = await serve()
    const card = await post(url, '/collab/agent/save', { name: '小K', hand: 'kimi' })
    const cardId = String(card.body.id)
    const taskId = await makeTask(url, '卡')
    const asked = await tasks.message(taskId, { text: '接一下这个', intent: 'ask', mentions: [cardId] })
    const askedMessage = asked.message as NoteMessage
    expect((askedMessage.deliveries ?? [])[0]!.status).toBe('pending')
    tick()
    await post(url, '/task/receipt', { id: taskId, receipt: 'done', text: '做完:接到了', by: cardId })
    const got = await get(url, `/collab/note/activity?id=${taskId}`)
    let message = (got.body as { items: { type: string, message: NoteMessage }[] }).items.find(one => one.type === 'message')
    expect((message?.message.deliveries ?? [])[0]?.status).toBe('pending')
    tick()
    await post(url, '/task/receipt', { id: taskId, receipt: 'done', text: '对应留言已接手', by: cardId, message_id: askedMessage.id })
    expect((await state(url)).tasks?.tasks.find(one => one.id === taskId)?.receipt).toMatchObject({ by: cardId, message_id: askedMessage.id })
    const correlated = await get(url, `/collab/note/activity?id=${taskId}`)
    message = (correlated.body as { items: { type: string, message: NoteMessage }[] }).items.find(one => one.type === 'message')
    expect((message?.message.deliveries ?? [])[0]?.status).toBe('accepted')
    // 读取侧现算,不落盘:卡上存的仍是 pending
    const task = (await state(url)).tasks?.tasks.find(one => one.id === taskId)
    expect(((task as TaskView).messages ?? [])[0]?.deliveries?.[0]?.status).toBe('pending')
  })
})

/* ─────────────────────────── D2:任务关系 / 轮次 ─────────────────────────── */

describe('D2 · 任务关系', () => {
  it('depends_on 成环 409;rejected_back 回路允许', async () => {
    const { url } = await serve()
    await makeTask(url, 'A')
    await makeTask(url, 'B')
    await makeTask(url, 'C')
    expect((await post(url, '/collab/relation/save', { from_id: 't-1', to_id: 't-2', kind: 'depends_on' })).status).toBe(200)
    expect((await post(url, '/collab/relation/save', { from_id: 't-2', to_id: 't-3', kind: 'depends_on' })).status).toBe(200)
    const cycle = await post(url, '/collab/relation/save', { from_id: 't-3', to_id: 't-1', kind: 'depends_on' })
    expect(cycle.status).toBe(409)
    expect(String(cycle.body.error)).toContain('环')
    // rejected_back 回到原制作是有意义的流程环,不拦
    expect((await post(url, '/collab/relation/save', { from_id: 't-1', to_id: 't-2', kind: 'rejected_back', note: '改第 2 点' })).status).toBe(200)
    expect((await post(url, '/collab/relation/save', { from_id: 't-2', to_id: 't-1', kind: 'rejected_back', note: '已改,再看一眼' })).status).toBe(200)
  })
  it('自连与完全重复 409;卡不存在 404', async () => {
    const { url } = await serve()
    await makeTask(url, 'A')
    await makeTask(url, 'B')
    expect((await post(url, '/collab/relation/save', { from_id: 't-1', to_id: 't-1', kind: 'reference' })).status).toBe(409)
    expect((await post(url, '/collab/relation/save', { from_id: 't-1', to_id: 't-2', kind: 'reference' })).status).toBe(200)
    expect((await post(url, '/collab/relation/save', { from_id: 't-1', to_id: 't-2', kind: 'reference' })).status).toBe(409)
    expect((await post(url, '/collab/relation/save', { from_id: 't-1', to_id: 't-没有', kind: 'reference' })).status).toBe(404)
  })
  it('handoff / rejected_back 必填 note;rejected_back 记目标卡轮次', async () => {
    const { url } = await serve()
    const a = await makeTask(url, 'A')
    const b = await makeTask(url, 'B')
    expect((await post(url, '/collab/relation/save', { from_id: a, to_id: b, kind: 'handoff' })).status).toBe(409)
    expect((await post(url, '/collab/relation/save', { from_id: a, to_id: b, kind: 'rejected_back' })).status).toBe(409)
    const back = await post(url, '/collab/relation/save', { from_id: a, to_id: b, kind: 'rejected_back', note: '头图重做' })
    expect(back.status).toBe(200)
    const got = await get(url, `/collab/relations?task_id=${b}`)
    const relation = (got.body as { relations: TaskRelation[] }).relations[0]
    expect(relation).toMatchObject({ kind: 'rejected_back', note: '头图重做', round: 1 })
  })
  it('上游 round 涨后,handoff 读取带 stale:true;remove 后消失', async () => {
    const { url } = await serve()
    const a = await makeTask(url, '上游')
    const b = await makeTask(url, '下游')
    await post(url, '/collab/relation/save', { from_id: a, to_id: b, kind: 'handoff', note: '交接脚本' })
    const before = await get(url, `/collab/relations?task_id=${b}`)
    expect((before.body as { relations: (TaskRelation & { stale: boolean })[] }).relations[0]!.stale).toBe(false)
    // 上游重开:doing→confirm→doing,round 1→2
    await move(url, a, 'doing')
    await move(url, a, 'confirm')
    await move(url, a, 'doing')
    const after = await get(url, `/collab/relations?task_id=${b}`)
    expect((after.body as { relations: (TaskRelation & { stale: boolean })[] }).relations[0]!.stale).toBe(true)
    // 删掉就没了
    const id = (after.body as { relations: TaskRelation[] }).relations[0]!.id
    expect((await post(url, '/collab/relation/remove', { id })).status).toBe(200)
    expect(((await get(url, `/collab/relations?task_id=${b}`)).body as { relations: unknown[] }).relations).toHaveLength(0)
  })
})
