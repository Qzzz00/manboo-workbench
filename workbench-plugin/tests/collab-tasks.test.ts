// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTasksService, loadTasksFile, migrateSprintsToGoals, emptyTasksFile } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-21T09:00:00Z') / 1000)
const AT = '2026-10-21T09:00:00.000Z'

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'collab-tasks-')), 'tasks.json')
}

function svc(file: string) {
  let n = 0
  return createTasksService({ file, now: () => NOW_SEC, newId: () => `t-${++n}` })
}

describe('便签的新字段:读写往返', () => {
  it('建便签带四样与小字段,读回来原样', async () => {
    const file = await tmpFile()
    const tasks = svc(file)
    const created = await tasks.create({
      title: '铃声换一首',
      goalId: 'g-1',
      from: { kind: 'said', quote: '铃声太吵了换一首' },
      acceptance: ['铃声换成柔和的', '  ', '手机上试响一次'],
      assignee: 'codex',
      labels: ['声音', '声音'],
      props: { 客户: '自己' },
      module: '座机',
      version: '0.4.140',
    })
    expect(created.ok).toBe(true)
    const [note] = (await tasks.list()).tasks
    expect(note).toMatchObject({
      goal_id: 'g-1',
      from: { kind: 'said', quote: '铃声太吵了换一首' },
      // 空白那条挑掉
      acceptance: ['铃声换成柔和的', '手机上试响一次'],
      labels: ['声音'],
      props: { 客户: '自己' },
      module: '座机',
      version: '0.4.140',
    })
  })

  it('验收最多三条,多的截掉;认不出的来源只挑掉这一格', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{
        id: 't-x', title: 'x', status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT,
        acceptance: ['1', '2', '3', '4'], from: { kind: '瞎写' }, receipt: { kind: 'done', text: '好了', at: AT }, receipt_irregular: true,
      }],
      sprints: [], modules: [], project_meta: [],
    }))
    const [note] = (await loadTasksFile(file)).tasks
    expect(note?.acceptance).toEqual(['1', '2', '3'])
    expect(note?.from).toBeUndefined()
    expect(note?.receipt).toEqual({ kind: 'done', text: '好了', at: AT })
    expect(note?.receipt_irregular).toBe(true)
  })

  it('改便签:换目标、清目标、改验收', async () => {
    const tasks = svc(await tmpFile())
    await tasks.create({ title: 'a' })
    await tasks.update('t-1', { goalId: 'g-2', acceptance: ['能跑'] })
    expect((await tasks.list()).tasks[0]).toMatchObject({ goal_id: 'g-2', acceptance: ['能跑'] })
    await tasks.update('t-1', { goalId: null, acceptance: [] })
    const note = (await tasks.list()).tasks[0]
    expect(note?.goal_id).toBeUndefined()
    expect(note?.acceptance).toBeUndefined()
  })
})

describe('目标', () => {
  it('建目标、改目标;没有删除,只有「不要了」', async () => {
    const tasks = svc(await tmpFile())
    const goal = await tasks.createGoal({ title: '座机能打通', why: '出门也能接', due: '2026-10-30' })
    expect(goal).toEqual({ ok: true, id: 't-1' })
    await tasks.updateGoal('t-1', { status: 'dropped' })
    expect((await tasks.list()).goals).toEqual([{
      id: 't-1', title: '座机能打通', why: '出门也能接', owner: 'me', status: 'dropped', due: '2026-10-30', created_at: AT, updated_at: AT,
    }])
  })
  it('空标题不建', async () => {
    const tasks = svc(await tmpFile())
    expect((await tasks.createGoal({ title: '  ' })).ok).toBe(false)
  })
})

describe('留言与已解决', () => {
  it('留一句、标已解决、取消已解决', async () => {
    const tasks = svc(await tmpFile())
    await tasks.create({ title: 'a' })
    const said = await tasks.comment('t-1', { by: 'me', text: '颜色再暗一点', verdict: 'rework' })
    expect(said.ok).toBe(true)
    const id = said.id as string
    await tasks.resolveComment('t-1', id, 'me')
    expect((await tasks.list()).tasks[0]?.comments).toEqual([{ id, by: 'me', text: '颜色再暗一点', verdict: 'rework', at: AT, resolved_by: 'me', resolved_at: AT }])
    await tasks.resolveComment('t-1', id, null)
    expect((await tasks.list()).tasks[0]?.comments?.[0]?.resolved_at).toBeUndefined()
  })
})

describe('Agent 名片', () => {
  it('登记一张,id 带 agent: 前缀;改名', async () => {
    const tasks = svc(await tmpFile())
    const made = await tasks.saveAgentCard({ name: 'Ben 的代码 Agent', hand: 'codex', goodAt: '改前端' })
    expect(made.ok).toBe(true)
    expect(made.id).toMatch(/^agent:/)
    await tasks.saveAgentCard({ id: made.id as string, name: '代码 Agent' })
    expect((await tasks.list()).agent_cards).toMatchObject([{ id: made.id, name: '代码 Agent', hand: 'codex', owner: 'me', shared: { to: 'none' } }])
  })
})

describe('老冲刺 → 目标、模块 → 分组(一次性、可回退)', () => {
  const old = {
    ...emptyTasksFile(),
    sprints: [{ id: 's-1', project_id: 'p1', name: '冲刺一', goal: '座机打通', versions: [{ label: '客户端', version: 'V0.1' }], ends_at: '2026-10-30', created_at: AT, updated_at: AT }],
    modules: [{ id: 'm-1', sprint_id: 's-1', name: '铃声', created_at: AT, updated_at: AT }],
    tasks: [
      { id: 'a', title: '在模块里', status: 'todo' as const, module_id: 'm-1', project_id: 'p1', source: { kind: 'manual' as const }, created_at: AT, updated_at: AT },
      { id: 'b', title: '没模块', status: 'todo' as const, source: { kind: 'manual' as const }, created_at: AT, updated_at: AT },
    ],
  }

  it('纯函数:冲刺成目标、卡挂上目标与模块名,老字段一个不删', () => {
    let n = 0
    const next = migrateSprintsToGoals(structuredClone(old), AT, () => `g-${++n}`)
    expect(next.goals).toEqual([{
      id: 'g-1', title: '冲刺一', why: '座机打通', owner: 'me', status: 'open', due: '2026-10-30', project_id: 'p1', version: '客户端 V0.1', migrated_from: 's-1', created_at: AT, updated_at: AT,
    }])
    expect(next.tasks.find(one => one.id === 'a')).toMatchObject({ goal_id: 'g-1', module: '铃声', module_id: 'm-1' })
    expect(next.tasks.find(one => one.id === 'b')?.goal_id).toBeUndefined()
    expect(next.sprints).toHaveLength(1)
    expect(next.modules).toHaveLength(1)
    expect(next.collab_migration).toEqual({ at: AT, goal_ids: ['g-1'], tasks: { a: { goal_id: 'g-1', module: '铃声' } } })
  })

  it('已经迁过就不再迁(一次性)', () => {
    let n = 0
    const once = migrateSprintsToGoals(structuredClone(old), AT, () => `g-${++n}`)
    const twice = migrateSprintsToGoals(once, AT, () => `g-${++n}`)
    expect(twice.goals).toHaveLength(1)
  })

  it('没有老冲刺:什么都不写(连文件都不建)', async () => {
    const file = await tmpFile()
    expect(await svc(file).migrateToGoals()).toEqual({ ok: true, goals: 0, tasks: 0 })
    expect(existsSync(file)).toBe(false)
  })

  it('服务:迁之前留一份备份;回退把迁出来的目标与挂法撤掉', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify(old))
    const tasks = svc(file)
    const ran = await tasks.migrateToGoals()
    expect(ran).toMatchObject({ ok: true, goals: 1, tasks: 1 })
    expect(existsSync(`${file}.pre-collab.json`)).toBe(true)
    expect(JSON.parse(await readFile(`${file}.pre-collab.json`, 'utf8')).goals).toBeUndefined()
    // 迁完之后他新挂的那张不跟着回退
    await tasks.update('b', { goalId: 't-new' })
    const back = await tasks.rollbackGoals()
    expect(back).toMatchObject({ ok: true, goals: 1, tasks: 1 })
    const after = await tasks.list()
    expect(after.goals).toEqual([])
    expect(after.tasks.find(one => one.id === 'a')?.goal_id).toBeUndefined()
    expect(after.tasks.find(one => one.id === 'a')?.module).toBeUndefined()
    expect(after.tasks.find(one => one.id === 'b')?.goal_id).toBe('t-new')
    // 回退之后可以再迁一次
    expect((await tasks.migrateToGoals()).ok).toBe(true)
  })
})

describe('Agent 名片的四样:命令行 / 仓库 / 模型与强度 / 智能体文件(2026-10-22,卡「名片补四样与Kimi命令行手」)', () => {
  it('存进去读回来原样;/state 的 agent_cards 原样带出', async () => {
    const tasks = svc(await tmpFile())
    const made = await tasks.saveAgentCard({
      name: 'Kimi 编程', hand: 'kimi',
      runtime: { family: 'kimi' },
      project: { repo: '/Users/example/Documents/GitHub/desktop-workbench' },
      model: { name: 'kimi-for-coding', effort: 'high' },
      instructions: 'docs/卡/agents/kimi-coder.md',
    })
    expect(made.ok).toBe(true)
    expect((await tasks.list()).agent_cards?.[0]).toMatchObject({
      id: made.id, hand: 'kimi',
      runtime: { family: 'kimi' },
      project: { repo: '/Users/example/Documents/GitHub/desktop-workbench' },
      model: { name: 'kimi-for-coding', effort: 'high' },
      instructions: 'docs/卡/agents/kimi-coder.md',
    })
    // 缺的可以单给;model 是整格换新(不给的档不回填,与 shared 整组替换同写法)
    await tasks.saveAgentCard({ id: made.id as string, model: { name: 'k2' } })
    expect((await tasks.list()).agent_cards?.[0]).toMatchObject({
      runtime: { family: 'kimi' }, model: { name: 'k2' },
    })
  })

  it('null = 清掉这一格(与 goodAt 同写法);形状不对只挑掉那一格(整张的取舍同这个文件)', async () => {
    const tasks = svc(await tmpFile())
    const made = await tasks.saveAgentCard({
      name: 'Kimi 编程', hand: 'kimi', runtime: { family: 'kimi' },
      project: { repo: '/repo' }, model: { name: 'm', effort: 'low' }, instructions: 'docs/卡/agents/kimi-coder.md',
    })
    await tasks.saveAgentCard({ id: made.id as string, runtime: null, project: null, model: null, instructions: null })
    const card = (await tasks.list()).agent_cards?.[0]
    expect(card?.runtime).toBeUndefined()
    expect(card?.project).toBeUndefined()
    expect(card?.model).toBeUndefined()
    expect(card?.instructions).toBeUndefined()
    // 强度只认 low / medium / high:认不出的那一格挑掉(400 那道门在 HTTP 路由上,见 collab-http 用例)
    await tasks.saveAgentCard({ id: made.id as string, model: { name: 'm', effort: 'max' } as never })
    expect((await tasks.list()).agent_cards?.[0]?.model).toEqual({ name: 'm' })
  })

  it('负责人保留 agent:… 名片 id:建与改都不折成家名', async () => {
    const tasks = svc(await tmpFile())
    const card = await tasks.saveAgentCard({ name: 'Kimi 编程', hand: 'kimi' })
    const created = await tasks.create({ title: '修一下日历认法', assignee: card.id as string })
    expect(created.ok).toBe(true)
    const id = created.id as string
    expect((await tasks.list()).tasks[0]?.assignee).toBe(card.id)
    await tasks.update(id, { assignee: 'codex' })
    expect((await tasks.list()).tasks[0]?.assignee).toBe('codex')
    await tasks.update(id, { assignee: card.id as string })
    expect((await tasks.list()).tasks[0]?.assignee).toBe(card.id)
  })
})

describe('Agent 名片的八样(视觉需求第 7 屏)', () => {
  it('挂哪些 MCP、共享给谁(只自己 / 全工作室 / 指定成员)、能动哪些仓库、每天上限', async () => {
    const tasks = svc(await tmpFile())
    const made = await tasks.saveAgentCard({
      name: '代码 Agent', hand: 'codex', skills: ['前端'], mcp: ['mc1'],
      shared: { to: 'members', members: ['member:li'], repos: ['/repo/a'], budget_per_day: 20 },
    })
    expect((await tasks.list()).agent_cards?.[0]).toMatchObject({
      id: made.id, mcp: ['mc1'], skills: ['前端'], shared: { to: 'members', members: ['member:li'], repos: ['/repo/a'], budget_per_day: 20 },
    })
  })
  it('指定成员却一个都没选 → 退回只自己', async () => {
    const tasks = svc(await tmpFile())
    await tasks.saveAgentCard({ name: 'x', hand: 'codex', shared: { to: 'members', members: [] } })
    expect((await tasks.list()).agent_cards?.[0]?.shared.to).toBe('none')
  })
})
