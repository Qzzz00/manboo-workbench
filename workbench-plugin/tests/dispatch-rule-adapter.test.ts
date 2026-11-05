// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createTasksService } from '../src/server/tasks.ts'
import { createRulesService } from '../src/server/rules.ts'
import { createOrdinaryDispatchRulesFor, dispatchRuleTaskText } from '../src/server/dispatchRuleAdapter.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ordinary-dispatch-rules-'))
  dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const rules = createRulesService({ file: join(dir, 'rules.json') })
  await rules.load()
  for (const [area, text] of [['ui', '界面保持灰色'], ['content', '文章保留出处'], ['all', '执行前检查边界']] as const) {
    expect((await rules.add({ area, text, channel: 'desk' })).ok).toBe(true)
  }
  const made = await tasks.create({ title: '界面排版', desc: '文章摘要', status: 'todo', origin: 'user' })
  expect(made.ok).toBe(true)
  return { tasks, rules, taskId: made.id! }
}

it('没有普通规矩服务时不注入 callback，也不读取任务', () => {
  const tasks = { list: async () => { throw new Error('不应读取') } }
  expect(createOrdinaryDispatchRulesFor({ tasks })).toBeUndefined()
})

it('真实 RulesService 沿原 title + desc + said/kind 筛选，不用假 baseCallback 代替', async () => {
  const { tasks, rules, taskId } = await fixture()
  const run = createOrdinaryDispatchRulesFor({ tasks, rules })!
  const said = '再检查一遍'
  const chat = await run({ taskId, said, kind: 'chat' })
  expect(chat).toBe(rules.brief('dispatch', ['界面排版\n文章摘要', said].join('\n'), 'chat').text)
  expect(chat).toContain('界面保持灰色')
  expect(chat).toContain('文章保留出处')
  expect(chat).not.toContain('执行前检查边界')
  const code = await run({ taskId, said, kind: 'code' })
  expect(code).toContain('执行前检查边界')
  expect(await run({ taskId, said })).toBe(rules.brief('dispatch', '界面排版\n文章摘要\n再检查一遍').text)
})

it('回调每次读取本实例任务原文，更新描述后规则范围随事实改变', async () => {
  const { tasks, rules, taskId } = await fixture()
  const run = createOrdinaryDispatchRulesFor({ tasks, rules })!
  await tasks.update(taskId, { title: '普通事项', desc: '无专项内容' })
  expect(await dispatchRuleTaskText(tasks, taskId)).toBe('普通事项\n无专项内容')
  expect(await run({ taskId, said: '继续', kind: 'chat' })).toBe(rules.brief('dispatch', '普通事项\n无专项内容\n继续', 'chat').text)
})

it('缺任务、缺 tasks 或空 id 沿原空串语义；不改规则 fallback', async () => {
  const { tasks, rules } = await fixture()
  for (const id of [undefined, '', 'gone']) expect(await dispatchRuleTaskText(tasks, id)).toBe('')
  expect(await dispatchRuleTaskText(undefined, 'gone')).toBe('')
  expect(await createOrdinaryDispatchRulesFor({ rules })!({ taskId: 'gone', said: '界面检查', kind: 'chat' })).toBe(rules.brief('dispatch', '\n界面检查', 'chat').text)
})

it('读取任务失败不吞错或换成全局规则；保持原适配异常语义', async () => {
  const { rules } = await fixture()
  const tasks = { list: async () => { throw new Error('fixture read failed') } }
  await expect(createOrdinaryDispatchRulesFor({ tasks, rules })!({ taskId: 't-broken', said: '继续' })).rejects.toThrow('fixture read failed')
})
