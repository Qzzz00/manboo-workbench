// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { LiveMessage, WorkbenchState } from '../src/protocol.ts'
import { UNSORTED_GOAL_ID } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'
import { createPersonalTokens } from '../src/server/personalToken.ts'
import { createUserLayerService } from '../src/server/userLayer.ts'
import { DISPATCH_GATE_ERROR, NOTE_GATE_ERROR_HEAD } from '../src/server/noteGate.ts'
import { ACTOR_TOKEN_HEADER } from '../src/server/herself.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-21T09:00:00Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve(extra: Partial<Parameters<typeof startWorkbenchServer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-collab-http-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const jobLog = createJobLog()
  const personalTokens = createPersonalTokens({ file: join(dir, 'pat.json') })
  const service = createWorkbenchService({ now: () => NOW_SEC })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    tasks,
    jobLog,
    personalTokens,
    collabWorkdir: async () => join(dir, 'work'),
    ...extra,
  })
  started.push(server)
  return { url: server.url, dir, tasks, jobLog, personalTokens, service }
}

/** 一个真用户层服务(临时目录):技能格里一件扁平形,别的格空着。 */
function userLayerWithSkill() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ul-http-'))
  dirs.push(dir)
  mkdirSync(join(dir, '技能'), { recursive: true })
  writeFileSync(join(dir, '技能', 'g-scoped-implementation.SKILL.md'), '---\nname: 范围内实现\n---\n\n# 范围内实现\n')
  return createUserLayerService({ dir })
}

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

const PAGE = { origin: 'http://127.0.0.1:3080' }

describe('/task/create 的门:新形状四样缺一不贴', () => {
  it('缺验收 / 负责人 → 400 说缺哪几样,一张都不建', async () => {
    const { url } = await serve()
    const got = await post(url, '/task/create', { title: '换铃声', from: { kind: 'said', quote: '换个铃声' } })
    expect(got.status).toBe(400)
    expect(String(got.body.error).startsWith(NOTE_GATE_ERROR_HEAD)).toBe(true)
    expect(got.body.missing).toEqual(['acceptance', 'assignee'])
    expect((await state(url)).tasks?.tasks).toEqual([])
  })
  it('四样齐 → 贴上;没写目标贴「未归目标」', async () => {
    const { url } = await serve()
    const got = await post(url, '/task/create', { title: '换铃声', from: { kind: 'said', quote: '换个铃声' }, acceptance: ['手机响一次'], assignee: 'codex' })
    expect(got.status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]).toMatchObject({ goal_id: UNSORTED_GOAL_ID, acceptance: ['手机响一次'], from: { kind: 'said' }, assignee: 'codex' })
  })
  it('老形状照旧收(老客户端不断)', async () => {
    const { url } = await serve()
    expect((await post(url, '/task/create', { title: '老样子' })).status).toBe(200)
  })
})

describe('/task/update:拖到别的目标区只改 goal_id,不改状态', () => {
  it('改 goal_id / 验收 / 标签 / 属性', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a', status: 'doing' })
    expect((await post(url, '/task/update', { id: 't-1', goal_id: 'g-9', acceptance: ['好了'], labels: ['x'], props: { 客户: '我' } })).status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]).toMatchObject({ status: 'doing', goal_id: 'g-9', acceptance: ['好了'], labels: ['x'], props: { 客户: '我' } })
  })
  it('回执不在这条路由上写', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a' })
    await post(url, '/task/update', { id: 't-1', receipt: { kind: 'done', text: 'x', at: 'y' } })
    expect((await state(url)).tasks?.tasks[0]?.receipt).toBeUndefined()
  })
})

describe('/task/receipt:回执三态落章', () => {
  it('做完 → 等你;小鼠标盖章', async () => {
    const { url, jobLog } = await serve()
    await post(url, '/task/create', { title: 'a', status: 'doing' })
    expect((await post(url, '/task/receipt', { id: 't-1', receipt: 'done', text: '做完:1 好了', evidence: ['/tmp/a.png'], by: 'codex' })).status).toBe(200)
    const note = (await state(url)).tasks?.tasks[0]
    expect(note?.status).toBe('confirm')
    expect(note?.receipt).toMatchObject({ kind: 'done', evidence: ['/tmp/a.png'], by: 'codex' })
    expect(jobLog.all().at(-1)).toMatchObject({ job: 't-1', step: 'replied', family: 'codex' })
  })
  it('按来源会话和轮次保留并去重回执；清空当前回执后重放不算新交回', async () => {
    const { url, tasks, jobLog } = await serve()
    await post(url, '/task/create', { title: '多来源', status: 'doing' })
    const first = { id: 't-1', receipt: 'done', text: '做完:成果一', by: 'codex', source_session_id: 's-1', source_round: 'r-1' }
    const second = { id: 't-1', receipt: 'objection', text: '有异议:成果二', by: 'codex', source_session_id: 's-2', source_round: 'r-1' }
    await post(url, '/task/receipt', first)
    await post(url, '/task/receipt', second)
    const count = jobLog.all().length
    await post(url, '/task/receipt', first)
    expect(jobLog.all()).toHaveLength(count)
    await tasks.update('t-1', { receipt: null })
    await post(url, '/task/receipt', first)
    const task = (await tasks.list()).tasks[0]
    expect(task?.receipts).toHaveLength(2)
    expect(task?.receipts?.map(one => one.source_session_id)).toEqual(['s-1', 's-2'])
    expect(task?.receipt).toMatchObject({ source_session_id: 's-1', source_round: 'r-1' })
  })
  it('卡住 → 卡住(从待办照表一格一格走)', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a' })
    await post(url, '/task/receipt', { id: 't-1', receipt: 'blocked', text: '卡住:没权限' })
    expect((await state(url)).tasks?.tasks[0]?.status).toBe('blocked')
  })
  it('kind 认不出 400', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a' })
    expect((await post(url, '/task/receipt', { id: 't-1', receipt: 'maybe', text: 'x' })).status).toBe(400)
  })
})

describe('执行来源撤权后的状态投影', () => {
  it('拒绝读取时移除缓存中的旧运行会话，并将公共运行状态置为未知', async () => {
    const authorization = { isAllowed: async () => false, denialMessage: () => '没授权' }
    const { url, tasks, service, jobLog } = await serve({ authorization: authorization as never })
    await tasks.create({ title: '来源撤权', status: 'doing', links: [{ agent: 'codex', session_id: 's-revoked' }] })
    service.applyEvent({ agent: 'codex', session_id: 's-revoked', type: 'running', title: '旧的运行快照', ts: NOW_SEC - 10 })

    const snapshot = await state(url)
    expect(snapshot.sessions.some(one => one.agent === 'codex' && one.session_id === 's-revoked')).toBe(false)
    expect(snapshot.tasks?.tasks[0]?.execution_sources).toMatchObject([{ session_id: 's-revoked', state: 'unknown', unknown: 'denied' }])
    expect(jobLog.events('t-1').at(-1)).toMatchObject({ step: 'source_unknown', session_id: 's-revoked' })
    const runs = await (await fetch(`${url}/collab/runs?task_id=t-1`)).json() as { runs: { status: string }[] }
    expect(runs.runs.at(-1)?.status).toBe('unknown')
  })
})

describe('/task/comment:留言与已解决', () => {
  it('页面上留一句 = 他说的;标已解决', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a' })
    const said = await post(url, '/task/comment', { id: 't-1', text: '再暗一点', verdict: 'rework' }, PAGE)
    expect(said.status).toBe(200)
    await post(url, '/task/comment/resolve', { id: 't-1', comment_id: said.body.comment_id }, PAGE)
    expect((await state(url)).tasks?.tasks[0]?.comments?.[0]).toMatchObject({ by: 'me', text: '再暗一点', verdict: 'rework', resolved_by: 'me' })
  })
})

describe('/butler/item/dispatch 的门:没写验收不许派', () => {
  it('开始派 → 409;写了验收 → 记上', async () => {
    const { url, dir } = await serve()
    await post(url, '/task/create', { title: 'a' })
    const body = { id: 't-1', family: 'codex', status: 'running', cwd: dir }
    const refused = await post(url, '/butler/item/dispatch', body)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(DISPATCH_GATE_ERROR)
    await post(url, '/task/update', { id: 't-1', acceptance: ['能跑'] })
    expect((await post(url, '/butler/item/dispatch', body)).status).toBe(200)
  })
})

describe('/dispatch/run 的门:事务官派之前要写验收;她自己点不挡', () => {
  it('带事务官那把令牌、便签没写验收 → 409;写了就放过门(往下派)', async () => {
    const tokens = { butler: 'wb-butler-test', worker: 'wb-worker-test' }
    const { url } = await serve({ actorTokens: tokens })
    await post(url, '/task/create', { title: 'a' }, PAGE)
    const butler = { [ACTOR_TOKEN_HEADER]: tokens.butler }
    const refused = await post(url, '/dispatch/run', { item_id: 't-1', app: 'codex' }, butler)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(DISPATCH_GATE_ERROR)
    await post(url, '/task/update', { id: 't-1', acceptance: ['能跑'] }, PAGE)
    expect((await post(url, '/dispatch/run', { item_id: 't-1', app: 'codex' }, butler)).body.error).not.toBe(DISPATCH_GATE_ERROR)
  })
  it('页面上她自己点「派给 Codex」:没写验收也不挡', async () => {
    const { url } = await serve({ actorTokens: { butler: 'b', worker: 'w' } })
    await post(url, '/task/create', { title: 'a' }, PAGE)
    expect((await post(url, '/dispatch/run', { item_id: 't-1', app: 'codex' }, PAGE)).body.error).not.toBe(DISPATCH_GATE_ERROR)
  })
})

describe('目标', () => {
  it('建、改;有截止日才挂风险', async () => {
    const { url } = await serve()
    expect((await post(url, '/collab/goal/create', { title: '座机打通', why: '出门能接', due: '2026-10-25' })).body).toEqual({ ok: true, id: 't-1' })
    await post(url, '/collab/goal/create', { title: '没截止' })
    const goals = (await state(url)).tasks?.goals
    expect(goals?.[0]?.risk).toBeDefined()
    expect(goals?.[1]?.risk).toBeUndefined()
    expect((await post(url, '/collab/goal/update', { id: 't-2', status: 'dropped' })).status).toBe(200)
    expect((await post(url, '/collab/goal/update', { id: 't-2', status: 'deleted' })).status).toBe(400)
  })
})

describe('板.canvas', () => {
  it('存一份摆法 → 落在 <工作目录>/协作区/板.canvas;读回来只认坐标', async () => {
    const { url, dir } = await serve()
    await post(url, '/task/create', { title: '换铃声' })
    const layout = { goals: { [UNSORTED_GOAL_ID]: { x: 0, y: 0, w: 500, h: 300 } }, notes: { 't-1': { x: 20, y: 60 } } }
    const saved = await post(url, '/collab/canvas', { layout })
    expect(saved.status).toBe(200)
    const file = join(dir, 'work', '协作区', '板.canvas')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).nodes).toContainEqual(expect.objectContaining({ id: 't-1', type: 'text', text: '换铃声' }))
    const read = await (await fetch(`${url}/collab/canvas`)).json() as { layout: unknown }
    expect(read.layout).toEqual(layout)
  })
})

describe('Agent 小鼠标:账上记一条 → /live 推 presence,不进快照', () => {
  it('assigned → moving 推出去;GET /collab/presence 拿得到', async () => {
    const { url, jobLog } = await serve()
    const ws = new WebSocket(`${url.replace('http', 'ws')}/live`)
    const got: LiveMessage[] = []
    await new Promise<void>((resolve) => { ws.on('open', () => resolve()) })
    ws.on('message', data => got.push(JSON.parse(String(data)) as LiveMessage))
    jobLog.append({ job: 't-1', step: 'assigned', family: 'codex' })
    await new Promise(resolve => setTimeout(resolve, 100))
    ws.close()
    expect(got.find(one => one.kind === 'presence')).toMatchObject({ kind: 'presence', presence: { actor: { kind: 'agent', id: 'codex' }, on_note: 't-1', state: 'moving' } })
    const listed = await (await fetch(`${url}/collab/presence`)).json() as { presence: unknown[] }
    expect(listed.presence).toHaveLength(1)
    expect(JSON.stringify(await state(url))).not.toContain('"presence"')
  })
})

describe('他直接开的会话:放进目标 / 不进看板', () => {
  it('放进去 = 一张便签,来源是那条会话、负责人是那一家、连着那条会话;新目标一起建', async () => {
    const { url } = await serve()
    const got = await post(url, '/collab/session/attach', { agent: 'codex', session_id: 's-1', title: '修铃声', new_goal_title: '铃声' })
    expect(got.status).toBe(200)
    const s = await state(url)
    expect(s.tasks?.goals?.[0]).toMatchObject({ title: '铃声' })
    expect(s.tasks?.tasks[0]).toMatchObject({
      title: '修铃声', status: 'doing', assignee: 'codex', goal_id: s.tasks?.goals?.[0]?.id,
      from: { kind: 'session', ref: 'codex:s-1' }, links: [{ agent: 'codex', session_id: 's-1' }],
    })
    expect((await post(url, '/collab/session/attach', { agent: 'codex', session_id: 's-1' })).body).toMatchObject({ already: true })
  })
  it('不进看板 → 记下', async () => {
    const { url, tasks } = await serve()
    expect((await post(url, '/collab/session/dismiss', { agent: 'claude', session_id: 's-2' })).status).toBe(200)
    expect(await tasks.dismissedProposals()).toEqual(['claude:s-2'])
  })
})

// 10-22 第三轮 4(维护者定 B) + 10-28 任务书 11(维护者 15:0x):只有一个目标时不问,直接放进去;
// 多个目标时对得上(标题 / 项目)也不问、直接放进对题的那个;都对不上 / 没有目标才在「等你」里选(默认新目标)。
describe('他直接开的会话:对题直接放,对不上才问', () => {
  async function withSession() {
    const service = createWorkbenchService({ now: () => NOW_SEC })
    const got = await serve({ service })
    service.applyEvent({ agent: 'claude', session_id: 's-9', project: '别处', type: 'running', title: '座机铃声换一版', ts: NOW_SEC - 60 })
    return { ...got, service }
  }
  async function settled(url: string, check: (s: WorkbenchState) => boolean): Promise<WorkbenchState> {
    for (let i = 0; i < 40; i += 1) {
      const s = await state(url)
      if (check(s)) return s
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return await state(url)
  }

  it('一个目标:直接建便签放进去(负责 Claude、在做、连上会话),「等你」里是一行已办说明,不再问', async () => {
    const { url, tasks } = await withSession()
    await tasks.createGoal({ title: '座机来电' })
    const s = await settled(url, one => (one.tasks?.tasks ?? []).length > 0)
    const goal = s.tasks?.goals?.[0]
    expect(s.tasks?.tasks[0]).toMatchObject({ title: '座机铃声换一版', status: 'doing', assignee: 'claude', goal_id: goal?.id, links: [{ agent: 'claude', session_id: 's-9' }] })
    expect(s.tasks?.session_proposals).toEqual([])
    expect(s.tasks?.session_placed).toEqual([expect.objectContaining({ agent: 'claude', session_id: 's-9', title: '座机铃声换一版', task_id: s.tasks?.tasks[0]?.id, goal_id: goal?.id })])
  })

  it('换目标 → 便签改到那个目标,说明划掉;不进看板 → 便签撤掉,以后不再问', async () => {
    const { url, tasks } = await withSession()
    await tasks.createGoal({ title: '座机来电' })
    const s = await settled(url, one => (one.tasks?.session_placed ?? []).length > 0)
    const moved = await post(url, '/collab/session/placed', { agent: 'claude', session_id: 's-9', action: 'move', new_goal_title: '铃声' })
    expect(moved.status).toBe(200)
    const after = await state(url)
    expect(after.tasks?.session_placed).toEqual([])
    expect(after.tasks?.tasks[0]?.goal_id).toBe(after.tasks?.goals?.find(one => one.title === '铃声')?.id)
    expect(after.tasks?.tasks[0]?.id).toBe(s.tasks?.tasks[0]?.id)
    expect((await post(url, '/collab/session/placed', { agent: 'claude', session_id: 's-9', action: 'remove' })).status).toBe(200)
    const gone = await state(url)
    expect(gone.tasks?.tasks).toEqual([])
    expect(gone.tasks?.session_proposals).toEqual([])
    expect(await tasks.dismissedProposals()).toEqual(['claude:s-9'])
  })

  // 10-28 任务书 11(维护者 15:0x「这种能不能别问我」):多个目标时也按对题直接放,不问。
  it('多个目标、对得上(标题像):直接放进那个目标,「等你」里是已办说明,不问', async () => {
    const { url, tasks } = await withSession()
    await tasks.createGoal({ title: '登录页' })
    const phone = await tasks.createGoal({ title: '座机来电' })
    const s = await settled(url, one => (one.tasks?.tasks ?? []).length > 0)
    expect(s.tasks?.tasks[0]).toMatchObject({ title: '座机铃声换一版', status: 'doing', assignee: 'claude', goal_id: phone.id })
    expect(s.tasks?.session_proposals).toEqual([])
    expect(s.tasks?.session_placed).toEqual([expect.objectContaining({ agent: 'claude', session_id: 's-9', goal_id: phone.id })])
  })

  // 任务书 11:对不上任何目标才问,问的时候带默认选项(新目标,名默认会话标题)。
  it('多个目标、都对不上:不提 goal_id,留一条问(默认新目标)', async () => {
    const { url, tasks } = await withSession()
    await tasks.createGoal({ title: '登录页' })
    await tasks.createGoal({ title: '官网' })
    const s = await state(url)
    expect(s.tasks?.tasks).toEqual([])
    expect(s.tasks?.session_proposals).toEqual([expect.objectContaining({ session_id: 's-9', new_goal_title: '座机铃声换一版' })])
    expect(s.tasks?.session_proposals?.[0]?.goal_id).toBeUndefined()
  })

  it('没有目标:不自动放,提新目标(名字默认会话标题)', async () => {
    const { url } = await withSession()
    const s = await state(url)
    expect(s.tasks?.tasks).toEqual([])
    expect(s.tasks?.session_proposals).toEqual([expect.objectContaining({ session_id: 's-9', new_goal_title: '座机铃声换一版' })])
  })
})

describe('Agent 名片', () => {
  it('登记一张 → /state.tasks.agent_cards', async () => {
    const { url } = await serve()
    const made = await post(url, '/collab/agent/save', { name: 'Ben 的代码 Agent', hand: 'codex', good_at: '前端' })
    expect(made.status).toBe(200)
    expect((await state(url)).tasks?.agent_cards?.[0]).toMatchObject({ name: 'Ben 的代码 Agent', hand: 'codex' })
  })

  it('四样(命令行 / 仓库 / 模型与强度 / 智能体文件)收进 /collab/agent/save,读回带在 /state 里', async () => {
    const { url } = await serve()
    const made = await post(url, '/collab/agent/save', {
      name: 'Kimi 编程', hand: 'kimi',
      runtime: { family: 'kimi', bin: '/opt/homebrew/bin/kimi' },
      project: { repo: '/Users/example/Documents/GitHub/desktop-workbench' },
      model: { name: 'kimi-for-coding', effort: 'medium' },
      instructions: 'docs/卡/agents/kimi-coder.md',
    })
    expect(made.status).toBe(200)
    expect((await state(url)).tasks?.agent_cards?.[0]).toMatchObject({
      runtime: { family: 'kimi', bin: '/opt/homebrew/bin/kimi' },
      project: { repo: '/Users/example/Documents/GitHub/desktop-workbench' },
      model: { name: 'kimi-for-coding', effort: 'medium' },
      instructions: 'docs/卡/agents/kimi-coder.md',
    })
    // 改成只给 family / 清掉 model:照改
    await post(url, '/collab/agent/save', { id: made.body.id, runtime: { family: 'kimi' }, model: null })
    const after = (await state(url)).tasks?.agent_cards?.[0]
    expect(after?.runtime).toEqual({ family: 'kimi' })
    expect(after?.model).toBeUndefined()
  })

  it('时长上限 budget.minutes 收进 /collab/agent/save,读回带在 /state 里;形状不对 → 400(2026-10-23 卡「派活给名片的四处」③)', async () => {
    const { url } = await serve()
    const made = await post(url, '/collab/agent/save', { name: '小K', hand: 'kimi', runtime: { family: 'kimi' }, budget: { minutes: 90 } })
    expect(made.status).toBe(200)
    expect((await state(url)).tasks?.agent_cards?.[0]).toMatchObject({ budget: { minutes: 90 } })
    // budget: null 清掉;没写不动那一格。
    await post(url, '/collab/agent/save', { id: made.body.id, budget: null })
    expect((await state(url)).tasks?.agent_cards?.[0]?.budget).toBeUndefined()
    await post(url, '/collab/agent/save', { id: made.body.id, budget: { minutes: 45 } })
    await post(url, '/collab/agent/save', { id: made.body.id, name: '小K' })
    expect((await state(url)).tasks?.agent_cards?.[0]?.budget).toEqual({ minutes: 45 })
    // 形状不对 → 400(分钟数 1..1440)。
    for (const body of [
      { name: 'x', hand: 'kimi', budget: { minutes: 0 } },
      { name: 'x', hand: 'kimi', budget: { minutes: 1441 } },
      { name: 'x', hand: 'kimi', budget: { minutes: '90' } },
      { name: 'x', hand: 'kimi', budget: 90 },
    ]) {
      const got = await post(url, '/collab/agent/save', body)
      expect(got.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('四样形状不对 → 400 + 原话(与现有字段同样写法)', async () => {
    const { url } = await serve()
    for (const body of [
      { name: 'x', hand: 'kimi', runtime: { family: 1 } },
      { name: 'x', hand: 'kimi', runtime: 'kimi' },
      { name: 'x', hand: 'kimi', project: { repo: '' } },
      { name: 'x', hand: 'kimi', project: '/repo' },
      { name: 'x', hand: 'kimi', model: { effort: 'max' } },
      { name: 'x', hand: 'kimi', model: 'm' },
      { name: 'x', hand: 'kimi', instructions: 42 },
    ]) {
      const got = await post(url, '/collab/agent/save', body)
      expect(got.status, JSON.stringify(body)).toBe(400)
    }
    expect((await state(url)).tasks?.agent_cards).toEqual([])
  })

  it('勾技能:本体与用户层都收,两边都没有的 → 400 报不认得(2026-10-22 卡「用户层技能生效」B)', async () => {
    const { url } = await serve({ userLayer: userLayerWithSkill() })
    expect((await post(url, '/collab/agent/save', { name: 'x', hand: 'kimi', skills: ['huashu-report'] })).status).toBe(200)
    expect((await post(url, '/collab/agent/save', { name: 'y', hand: 'kimi', skills: ['g-scoped-implementation'] })).status).toBe(200)
    const bad = await post(url, '/collab/agent/save', { name: 'z', hand: 'kimi', skills: ['nope'] })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('nope')
    expect((await state(url)).tasks?.agent_cards?.map(one => one.name)).toEqual(['x', 'y'])
  })

  it('GET /dispatch/skills:两组 —— 本体几件 / 我的几件(勾选列表的数据)', async () => {
    const { url } = await serve({ userLayer: userLayerWithSkill() })
    const res = await fetch(`${url}/dispatch/skills`)
    expect(res.status).toBe(200)
    const got = await res.json() as { builtin: string[], mine: { id: string, name: string, description?: string }[] }
    expect(got.builtin).toEqual(['huashu-report', 'huashu-design'])
    expect(got.mine).toEqual([{ id: 'g-scoped-implementation', name: '范围内实现' }])
  })
})

describe('个人访问令牌', () => {
  it('只有本机页面能发;发了只回一次明文', async () => {
    const { url } = await serve()
    expect((await post(url, '/token/personal/issue', { purpose: 'x' })).status).toBe(403)
    const issued = await post(url, '/token/personal/issue', { purpose: '本机脚本' }, PAGE)
    expect(issued.status).toBe(200)
    expect(String(issued.body.token)).toMatch(/^wbp_/)
    const status = await (await fetch(`${url}/token/personal`)).json() as Record<string, unknown>
    expect(status.issued).toBe(true)
    expect(JSON.stringify(status)).not.toContain(String(issued.body.token))
  })
  it('带着它的程序按他本人放行(授权表那一道不拦);带错的 401', async () => {
    const denyAll = { isAllowed: async () => false, denialMessage: () => '没授权' }
    const { url, personalTokens } = await serve({ authorization: denyAll as never })
    expect((await post(url, '/task/create', { title: 'a' })).status).toBe(403)
    const token = await personalTokens.issue()
    expect((await post(url, '/task/create', { title: 'a' }, { authorization: `Bearer ${token}` })).status).toBe(200)
    expect((await post(url, '/task/create', { title: 'a' }, { authorization: 'Bearer wbp_wrong' })).status).toBe(401)
  })
})

describe('迁移与回退', () => {
  it('POST /collab/migrate → 冲刺成目标;rollback 撤掉', async () => {
    const { url } = await serve()
    const sprint = await post(url, '/sprint/create', { project_id: 'p1', name: '冲刺一', goal: '打通' })
    const mod = await post(url, '/module/create', { sprint_id: sprint.body.id, name: '铃声' })
    await post(url, '/task/create', { title: 'a', module_id: mod.body.id })
    const ran = await post(url, '/collab/migrate', {})
    expect(ran.body).toMatchObject({ ok: true, goals: 1, tasks: 1 })
    expect((await state(url)).tasks?.tasks[0]).toMatchObject({ module: '铃声' })
    const back = await post(url, '/collab/migrate/rollback', {})
    expect(back.body).toMatchObject({ ok: true, goals: 1, tasks: 1 })
    expect((await state(url)).tasks?.goals).toEqual([])
  })
})

describe('/butler/item 建出来的便签带着他那句原话当来源', () => {
  it('from: said + quote', async () => {
    // 2026-10-29 入口归一:/butler/item 进理解中枢 —— 假模型回 note,原话由中枢的手落卡。
    const model = fakeHubModel({ '把铃声换成柔和一点的': [{ name: 'note', title: '把铃声换成柔和一点的', status: 'todo' }] })
    const { url } = await serve({ model: model.service as never, fetchImpl: model.fetchImpl })
    await post(url, '/butler/item', { text: '把铃声换成柔和一点的' }, PAGE)
    expect((await state(url)).tasks?.tasks[0]?.from).toEqual({ kind: 'said', quote: '把铃声换成柔和一点的' })
  })
})

/*
 * 事项类型表(2026-10-22,统筹转维护者:类型名不写死,做成设置;Agent 也能改)。
 * 存 `<工作目录>/协作区/事项类型.json`;`GET / POST /collab/types` 读写,写走「改显示状态」那道门;/state 里 `tasks.work_types` 跟着变。
 */
describe('事项类型表:GET / POST /collab/types', () => {
  const GROWTH = { id: 'growth', title: '推广获客', icon: 'megaphone', color: { dark: '#dce4c5', light: '#eff4df' } }

  it('没存过 → 缺省四类(评审页协作区原型图例那四组)', async () => {
    const { url } = await serve()
    const got = await (await fetch(`${url}/collab/types`)).json() as { scope: string, types: { id: string, title: string }[] }
    expect(got.scope).toBe('local')
    expect(got.types.map(one => [one.id, one.title])).toEqual([['meeting', '会议'], ['dev', '研发与设计'], ['content', '内容与推广'], ['routine', '经营与其他']])
    expect((await state(url)).tasks?.work_types?.map(one => one.id)).toEqual(['meeting', 'dev', 'content', 'routine'])
  })

  it('存一张 → 落盘、再读一样、/state 跟着变;便签的 work_type 能写表里新加的 id', async () => {
    const { url, dir } = await serve()
    const current = (await (await fetch(`${url}/collab/types`)).json() as { types: unknown[] }).types
    const saved = await post(url, '/collab/types', { types: [...current, GROWTH] })
    expect(saved.status).toBe(200)
    const file = join(dir, 'work', '协作区', '事项类型.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).types.at(-1)).toEqual(GROWTH)
    const read = await (await fetch(`${url}/collab/types`)).json() as { types: { id: string }[] }
    expect(read.types.map(one => one.id)).toEqual(['meeting', 'dev', 'content', 'routine', 'growth'])
    expect((await state(url)).tasks?.work_types?.at(-1)).toEqual(GROWTH)
    await post(url, '/task/create', { title: '投一条广告' })
    expect((await post(url, '/task/update', { id: 't-1', work_type: 'growth' })).status).toBe(200)
    expect((await state(url)).tasks?.tasks[0]?.work_type).toBe('growth')
  })

  it('形状不对 → 400 说哪一条哪里不对,表不动', async () => {
    const { url } = await serve()
    const bad = await post(url, '/collab/types', { types: [{ ...GROWTH, color: { dark: 'red', light: '#fff' } }] })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('第 1 类')
    const dup = await post(url, '/collab/types', { types: [GROWTH, GROWTH] })
    expect(String(dup.body.error)).toContain('重了')
    expect((await (await fetch(`${url}/collab/types`)).json() as { types: unknown[] }).types).toHaveLength(4)
  })
})

describe('/task/owner-ask:事务官核验后标四类拍板请求(2026-10-26,卡「事务官页接管队列」)', () => {
  it('类别不在四类 / 方案空 / 依据空 → 400(未知不得自动放行);带方案与依据才标得上', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a', status: 'confirm' })
    expect((await post(url, '/task/owner-ask', { id: 't-1', kind: 'maybe', proposal: 'x', basis: 'y' })).status).toBe(400)
    expect((await post(url, '/task/owner-ask', { id: 't-1', kind: 'spend', proposal: '  ', basis: 'y' })).status).toBe(400)
    expect((await post(url, '/task/owner-ask', { id: 't-1', kind: 'spend', proposal: 'x', basis: '' })).status).toBe(400)
    expect((await post(url, '/task/owner-ask', { id: 't-1', kind: 'spend', proposal: '买这个', basis: '核过的事实' })).status).toBe(200)
    const note = (await state(url)).tasks?.tasks[0]
    expect(note?.owner_ask).toMatchObject({ kind: 'spend', proposal: '买这个', basis: '核过的事实' })
  })

  it('谁标的按来路认:页面 = me,事务官令牌 = butler;再标 = 覆盖写(改方案)', async () => {
    const tokens = { butler: 'wb-butler-test', worker: 'wb-worker-test' }
    const { url } = await serve({ actorTokens: tokens })
    await post(url, '/task/create', { title: 'a', status: 'confirm' }, PAGE)
    await post(url, '/task/owner-ask', { id: 't-1', kind: 'publish', proposal: '发 0.4.151', basis: '整包绿' }, PAGE)
    expect((await state(url)).tasks?.tasks[0]?.owner_ask?.by).toBe('me')
    await post(url, '/task/owner-ask', { id: 't-1', kind: 'publish', proposal: '再等等,先不发', basis: '真机未验' }, { [ACTOR_TOKEN_HEADER]: tokens.butler })
    const ask = (await state(url)).tasks?.tasks[0]?.owner_ask
    expect(ask).toMatchObject({ by: 'butler', proposal: '再等等,先不发' })
  })

  it('标了之后这件才进用户侧「等你」;没标的事务官先核验,不摊给本人', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: '没核完', status: 'confirm' })
    await post(url, '/task/create', { title: '核完了', status: 'confirm' })
    const before = await state(url)
    expect(before.waiting?.items.filter(item => item.kind === 'confirm').map(item => item.task_id)).toEqual([])
    await post(url, '/task/owner-ask', { id: 't-2', kind: 'scope', proposal: '照原习惯', basis: '问过两回都这么说' })
    const after = await state(url)
    expect(after.waiting?.items.filter(item => item.kind === 'confirm').map(item => item.task_id)).toEqual(['t-2'])
    // 退回(confirm → doing)请求被答掉擦掉,不再进「等你」。
    await post(url, '/task/move', { id: 't-2', status: 'doing' })
    expect((await state(url)).waiting?.items.some(item => item.kind === 'confirm')).toBe(false)
  })

  it('/task/update 不接 owner_ask 这个字段(只由 /task/owner-ask 那一条路写)', async () => {
    const { url } = await serve()
    await post(url, '/task/create', { title: 'a', status: 'confirm' })
    await post(url, '/task/update', { id: 't-1', owner_ask: { kind: 'spend', proposal: 'x', basis: 'y', at: 'z' } })
    expect((await state(url)).tasks?.tasks[0]).not.toHaveProperty('owner_ask')
  })
})
