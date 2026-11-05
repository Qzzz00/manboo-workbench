// @vitest-environment node
/**
 * 学风格接在 8791 上(2026-10-09,卡「学风格」):
 *
 * - 她亲手存选题 / 需求的一份稿(`/topic/doc/save`、`/feature/doc/save`)→ 与上一版按段比,行为账记一条「改稿」(只记改了哪类);
 *   事务官 / 别家存的不记。
 * - 「从记忆里的观察学」(`/butler/rules/import`)不再一次性导成规矩,改走风格候选那一道。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchLayout } from '../src/protocol.ts'
import { BEHAVIOR_EVENTS, createBehaviorLog } from '../src/server/behaviorLog.ts'
import { createHabitService } from '../src/server/habits.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createRulesService } from '../src/server/rules.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
const OPS_TEMPLATE = await loadStarterLayoutTemplate()

const PAGE = { origin: 'http://127.0.0.1:3080' }
const TOPIC = '露营锅具怎么选'
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve(opts: { observations?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-style-http-'))
  dirs.push(dir)
  const cwd = join(dir, '运营')
  mkdirSync(cwd, { recursive: true })
  let layout: WorkbenchLayout | undefined = { modules: [], butler: { corner: 'br', min: false } }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(layout),
    writeLayout: (next) => { layout = next; return Promise.resolve() },
    // 2026-10-23(分层二刀二):ops 模板的内容在用户层起步层,本体只剩 product —— 用例里注入这一份。
    templates: () => [OPS_TEMPLATE],
    butlerCwd: () => cwd,
  })
  await template.load()
  await template.apply('ops')
  const rules = createRulesService({ file: join(dir, 'rules.json'), agents: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true }) } })
  await rules.load()
  const behaviorLog = createBehaviorLog({ dir: join(dir, '行为账') })
  const prompts: string[] = []
  const habits = createHabitService({
    store: rules,
    behavior: behaviorLog,
    style: {
      ask: async (prompt) => {
        prompts.push(prompt)
        const n = prompt.split('\n').findIndex(line => /^\d+\. .*先听结论/u.test(line))
        return JSON.stringify({ items: n === -1 ? [] : [{ n: Number(prompt.split('\n')[n]?.split('.')[0]), id: '结论先行', quote: '先听结论' }] })
      },
      ...(opts.observations === undefined ? {} : { observations: async () => opts.observations }),
    },
  })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks: createTasksService({ file: join(dir, 'tasks.json') }),
    template,
    rules,
    habits,
    behaviorLog,
  })
  started.push(server)
  const post = async (path: string, body: unknown, headers: Record<string, string> = PAGE) => {
    const res = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  return { post, behaviorLog, rules, prompts }
}

const DRAFT = '大家好,很高兴又和你们见面啦!\n\n露营锅具选铝的还是钛的,看你一年出去几次。\n\n钛锅轻,但导热差,煮饭容易糊。'
const HERS = '露营锅具选铝的还是钛的,看你一年出去几次。\n\n钛锅轻,但导热差,煮饭容易糊。'

describe('改稿:她亲手存的那一版与上一版比,只记改了哪类', () => {
  it('她存下 → 行为账一条「改稿」(删了开头客套);第一次新建、没改出哪类的都不记', async () => {
    const s = await serve()
    expect((await s.post('/topic/doc/save', { name: TOPIC, tab: '初稿', text: DRAFT })).status).toBe(200)
    expect((await s.post('/topic/doc/save', { name: TOPIC, tab: '初稿', text: HERS })).status).toBe(200)
    expect((await s.post('/topic/doc/save', { name: TOPIC, tab: '初稿', text: HERS.replace('煮饭', '煮米饭') })).status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 50))
    const rows = (await s.behaviorLog.read({})).filter(one => one.事 === BEHAVIOR_EVENTS.revise)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ 端: '电脑', 对象: `选题 ${TOPIC} · 初稿`, 结果: '删了开头客套' })
    expect(rows[0]?.类).toContain('语气.少客套')
  })

  it('不是她存的(没带页面来源的 curl / 事务官)不记', async () => {
    const s = await serve()
    await s.post('/topic/doc/save', { name: TOPIC, tab: '初稿', text: DRAFT }, {})
    await s.post('/topic/doc/save', { name: TOPIC, tab: '初稿', text: HERS }, {})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await s.behaviorLog.read({})).filter(one => one.事 === BEHAVIOR_EVENTS.revise)).toHaveLength(0)
  })
})

describe('从记忆里的观察学:不再导成规矩,走风格候选', () => {
  it('回认出了几条候选;规矩表一条没加', async () => {
    const s = await serve({ observations: '# 用户:Ben\n\n## 观察\n- 2026-10-08 · 汇报他喜欢先听结论 · 依据:会话 x\n- **他的验收标准**:① 不要蓝' })
    const res = await s.post('/butler/rules/import', { from: 'observations' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, added: 0, candidates: 1 })
    expect(String(res.body.note)).toContain('不再直接导成规矩')
    expect(s.rules.view().rules).toHaveLength(0)
    expect(s.prompts).toHaveLength(1)
  })
})
