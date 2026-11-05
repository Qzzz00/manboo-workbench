// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskView, WorkbenchProject } from '../src/protocol.ts'
import { createS4WindowQaRules, S4_WINDOW_QA_ENV, S4_WINDOW_QA_RULE, parseS4WindowQaConfig } from '../src/server/s4WindowQaRules.ts'

const execution = { family: 'claude', assignee: 'claude', target: 'new' } as const
const requestOf = (card: TaskView, kind: 'chat' | 'code' = 'chat', said = card.title) => ({ taskId: card.id, said, kind, dispatch: execution })
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0 })
async function world() {
  const root = await mkdtemp(join(tmpdir(), 's4-window-factory-')); roots.push(root)
  const home = join(root, 'iso/home'), dsh = join(home, '.dsh'), profile = join(dsh, 'profiles/web'), repo = join(home, 'Documents/GitHub/样片')
  await mkdir(profile, { recursive: true }); await mkdir(repo, { recursive: true })
  const config = { version: 1, enabled: true, root, home, profileDir: profile, projectId: '样片', projectRepo: repo }
  const env = { HOME: home, DSH_HOME: dsh, [S4_WINDOW_QA_ENV]: JSON.stringify(config) }
  let cards: TaskView[] = []
  let projects = [{ id: '样片', path: repo }] as Pick<WorkbenchProject, 'id' | 'path'>[]
  const list = vi.fn(async () => ({ tasks: cards, sprints: [], modules: [], project_meta: [] }))
  const ordinaryRulesFor = vi.fn(async () => '原普通规则')
  const input = { env, tasks: { list }, projects: async () => projects, ordinaryRulesFor }
  const task = (id = 't-qa-new'): TaskView => ({ id, title: '把样片派给 Claude 剪一版', assignee: 'claude', project_id: '样片', status: 'todo', source: { kind: 'manual' }, created_at: '2026-10-24T16:00:00Z', updated_at: '2026-10-24T16:00:00Z' })
  return { root, repo, profile, config, env, input, list, ordinaryRulesFor, task, cards: (value: TaskView[]) => { cards = value }, projects: (value: typeof projects) => { projects = value } }
}

describe('显式 normal s4 QA rulesFor 工厂', () => {
  it('缺省完全不接入，不读任务/项目/普通规则', async () => {
    const w = await world()
    expect(await createS4WindowQaRules({ ...w.input, env: {} })).toBeUndefined()
    expect(w.list).not.toHaveBeenCalled(); expect(w.ordinaryRulesFor).not.toHaveBeenCalled()
    expect(parseS4WindowQaConfig({ [S4_WINDOW_QA_ENV]: '{"enabled":false}' })).toBeUndefined()
  })
  it('真实新增任务与扫描项目精确匹配，只在普通规则后附固定安全段，不改卡', async () => {
    const w = await world(), callback = await createS4WindowQaRules(w.input)
    const card = w.task(); w.cards([card])
    const before = structuredClone(card)
    const input = requestOf(card)
    expect(await callback!(input)).toBe(`原普通规则\n\n${S4_WINDOW_QA_RULE}`)
    expect(w.ordinaryRulesFor).toHaveBeenCalledWith(input)
    expect(card).toEqual(before)
  })
  it.each(['kind', 'assignee', 'project', 'said', 'links', 'dispatch', 'conversation', 'missing'] as const)('范围不符不附，普通规则逐字保留：%s', async field => {
    const w = await world(), callback = await createS4WindowQaRules(w.input)
    const card = w.task(); w.cards(field === 'missing' ? [] : [card])
    if (field === 'assignee') card.assignee = 'codex'
    if (field === 'project') card.project_id = '其它项目'
    if (field === 'links') card.links = [{ agent: 'claude', session_id: 'existing' }]
    if (field === 'dispatch') card.dispatch = { family: 'claude' } as NonNullable<TaskView['dispatch']>
    if (field === 'conversation') card.conversation = { session_id: 'existing' } as NonNullable<TaskView['conversation']>
    expect(await callback!(requestOf(card, field === 'kind' ? 'code' : 'chat', field === 'said' ? '其它任务' : card.title))).toBe('原普通规则')
  })
  it('启动时已有卡不附、第二张新 Claude 卡不附；同一张重复读规则稳定', async () => {
    const w = await world(), old = w.task('old'); w.cards([old])
    const callback = await createS4WindowQaRules(w.input), first = w.task(), second = w.task('another')
    w.cards([old, first, second])
    const run = (card: TaskView) => callback!(requestOf(card))
    expect(await run(old)).toBe('原普通规则')
    expect(await run(first)).toContain(S4_WINDOW_QA_RULE)
    expect(await run(first)).toContain(S4_WINDOW_QA_RULE)
    expect(await run(second)).toBe('原普通规则')
  })
  it('扫描项目路径不符不附，读不到任务不吞成已通过准备', async () => {
    const w = await world(), callback = await createS4WindowQaRules(w.input), card = w.task(); w.cards([card])
    w.projects([{ id: '样片', path: '/tmp/other' }])
    expect(await callback!(requestOf(card))).toBe('原普通规则')
    w.list.mockRejectedValueOnce(new Error('tasks unavailable'))
    await expect(callback!(requestOf(card))).rejects.toThrow('tasks unavailable')
  })
  it('非法/越界/注入字段在 bootstrap 报错，不尝试真实派活', async () => {
    const w = await world()
    for (const config of [{ ...w.config, home: '/tmp/other' }, { ...w.config, root: '/' }, { ...w.config, profileDir: '/tmp/web' }, { ...w.config, projectRepo: '/tmp/sample' }, { ...w.config, submit: true }]) {
      await expect(createS4WindowQaRules({ ...w.input, env: { ...w.env, [S4_WINDOW_QA_ENV]: JSON.stringify(config) } })).rejects.toThrow()
    }
  })
  it('拒绝 profile 或项目符号链越出隔离 root', async () => {
    const w = await world(), other = await mkdtemp(join(tmpdir(), 's4-window-outside-')); roots.push(other)
    await rm(w.repo, { recursive: true }); await symlink(other, w.repo)
    await expect(createS4WindowQaRules(w.input)).rejects.toThrow(/symlink|canonical/)
  })
  it('原 Say legacy 家名还未写 assignee：只认 dispatchRun 解析出的 Claude/new 上下文', async () => {
    const w = await world(), callback = await createS4WindowQaRules(w.input), card = w.task()
    delete card.assignee; w.cards([card])
    const request = { taskId: card.id, said: card.title, kind: 'chat' as const, dispatch: execution }
    expect(await callback!(request)).toBe(`原普通规则\n\n${S4_WINDOW_QA_RULE}`)
    expect(card.assignee).toBeUndefined()
  })
  it.each([undefined, { ...execution, family: 'codex' }, { ...execution, assignee: 'agent:local:other' }, { ...execution, target: 'session' }])('缺失/其它来源/非新对话的内部上下文不附：%j', async dispatch => {
    const w = await world(), callback = await createS4WindowQaRules(w.input), card = w.task(); delete card.assignee; w.cards([card])
    const request = { ...requestOf(card), dispatch }
    expect(await Reflect.apply(callback!, undefined, [request])).toBe('原普通规则')
  })
  it('普通规则空/undefined 时只附安全段，普通规则读取异常不伪造成功', async () => {
    const w = await world(), callback = await createS4WindowQaRules({ ...w.input, ordinaryRulesFor: async () => undefined }), card = w.task(); w.cards([card])
    expect(await callback!(requestOf(card))).toBe(S4_WINDOW_QA_RULE)
    const other = await world(), failed = await createS4WindowQaRules({ ...other.input, ordinaryRulesFor: async () => { throw new Error('ordinary unavailable') } })
    await expect(failed!(requestOf(other.task()))).rejects.toThrow('ordinary unavailable')
  })
})
