// @vitest-environment node
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import ts from 'typescript'
import { hostDispatchRules } from '../src/index.ts'
import { startFromEnv, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createRulesService } from '../src/server/rules.ts'
import { ACTOR_TOKEN_HEADER, mintActorTokens } from '../src/server/herself.ts'
import { S4_WINDOW_QA_ENV, S4_WINDOW_QA_RULE } from '../src/server/s4WindowQaRules.ts'
/** 用例本地的清单件形状(旧 butlerSay.SayPlanItem 随旧路删除;这里只管造假模型回包)。 */
interface SayPlanItem { kind: '记' | '办' | '改', title: string, who?: string, risk: 'none', confidence: number, why: string }
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const roots: string[] = []
const servers: WorkbenchServer[] = []
const closeProviders: (() => Promise<void>)[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  while (closeProviders.length) await closeProviders.pop()!()
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const S4 = '帮我建一个待办:周四下午给客户发样片,再把样片派给 Claude 剪一版,然后换个女声'
const work: SayPlanItem = { kind: '办', title: '把样片剪一版', who: 'claude', risk: 'none', confidence: 0.99, why: '受控理解清单' }
const plan: SayPlanItem[] = [
  { kind: '记', title: '周四下午给客户发样片', risk: 'none', confidence: 0.99, why: '记待办' },
  work,
  { kind: '改', title: '换个女声', risk: 'none', confidence: 0.99, why: '改设置' },
]

async function world() {
  const root = await mkdtemp(join(tmpdir(), 'wb-s4-host-')); roots.push(root)
  const home = join(root, 'iso/home'), dsh = join(home, '.dsh'), profileDir = join(dsh, 'profiles/web'), projectRepo = join(home, 'Documents/GitHub/样片')
  await mkdir(profileDir, { recursive: true }); await mkdir(projectRepo, { recursive: true })
  const tasks = createTasksService({ file: join(dsh, 'workbench/tasks.json') })
  const rules = createRulesService({ file: join(dsh, 'workbench/rules.json') })
  await rules.load()
  await rules.add({ text: '文章标清出处，不编材料', area: 'content', channel: 'desk' })
  await rules.add({ text: '界面使用灰色', area: 'ui', channel: 'desk' })
  const project = { id: '样片', name: '样片', path: projectRepo }
  const config = { version: 1, enabled: true, root, home, profileDir, projectId: '样片', projectRepo }
  const env: Record<string, string | undefined> = { HOME: home, DSH_HOME: dsh, WORKBENCH_HOST: '127.0.0.1', [S4_WINDOW_QA_ENV]: JSON.stringify(config) }
  const input = { env, tasks, rules, projects: async () => [project] }
  return { root, home, project, config, env, tasks, rules, input }
}

async function serve(w: Awaited<ReturnType<typeof world>>, items = plan) {
  const dispatchRules = await hostDispatchRules(w.input)
  const modelBodies: Record<string, unknown>[] = []
  const provider = createServer((req, res) => {
    let text = ''
    req.on('data', chunk => { text += String(chunk) })
    req.on('end', () => {
      modelBodies.push(JSON.parse(text) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'application/json' })
      // 2026-10-29 入口归一:所有入口进理解中枢,假模型回命令表形状(记 → note、办 → dispatch、改女声 → voice)。
      const commands = items.flatMap((one): Record<string, unknown>[] => one.kind === '记' ? [{ name: 'note', title: one.title, status: 'todo' }]
        : one.kind === '办' ? [{ name: 'dispatch', new: { title: one.title }, text: one.title, ...(one.who === undefined ? {} : { to: one.who }) }]
          : one.title.includes('女声') ? [{ name: 'voice', gender: 'female' }] : [])
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ commands }) } }] }))
    })
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  closeProviders.push(() => new Promise(resolve => provider.close(() => resolve())))
  const providerPort = (provider.address() as AddressInfo).port
  // startFromEnv 按正常端口规则拒绝 0，先借一枚空闲端口后交回同一 host 启动路径。
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const calls: HelperRequest[] = []
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> => {
    calls.push(req)
    if (req.op === 'send_text') return { submitted: req.submit === true, method: 'ax_value', new_conversation: '新聊天' }
    return { found: false, busy: false }
  }
  const engine = engineHarness({ helper: { connected: () => true, supports: () => true, request } })
  const tokens = mintActorTokens()
  const server = await startFromEnv(createWorkbenchService({}), { ...w.env, WORKBENCH_PORT: String(port) }, {
    tasks: w.tasks, rules: w.rules, paths: { home: w.home, config: createAppConfig({ file: join(w.home, '.dsh/workbench/app.json') }) }, actorTokens: tokens,
    projects: { getProjectsState: async () => ({ projects: [w.project] }) } as never,
    engine: engine.engine,
    helper: { attach: () => {}, view: () => ({ connected: true, authorized: true }) as never, connected: () => true, onChange: () => {}, onEvent: () => {}, request },
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }), appInstalled: () => true,
    model: { endpoint: async () => ({ baseUrl: `http://127.0.0.1:${providerPort}/v1`, key: 'fixture', model: 'fixture-selected', ready: true }) } as never,
    ...(dispatchRules === undefined ? {} : { dispatchRules }),
  })
  servers.push(server)
  const say = async (text: string) => {
    const response = await fetch(server.url + '/butler/say', { method: 'POST', headers: { 'content-type': 'application/json', [ACTOR_TOKEN_HEADER]: tokens.worker }, body: JSON.stringify({ text, ctx: { in_call: true } }) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  return { say, modelBodies, sends: () => calls.filter(one => one.op === 'send_text'), dispatchRules }
}

it('缺省及显式关闭不注入 dispatchRules，也不产 QA 准备回执', async () => {
  for (const value of [undefined, '{"enabled":false}']) {
    const w = await world(); w.env[S4_WINDOW_QA_ENV] = value
    expect(await hostDispatchRules(w.input)).toBeUndefined()
    await expect(readFile(join(w.root, 's4-window-qa-bootstrap.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

it('正常 index.apply 确实 await 同一 host 工厂，并将条件 options 交给原 startFromEnv', async () => {
  const source = ts.createSourceFile('index.ts', await readFile(new URL('../src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const apply = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'apply') as ts.FunctionDeclaration
  const declarations: ts.VariableDeclaration[] = []
  const starts: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'dispatchRules') declarations.push(node)
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'startFromEnv') starts.push(node)
    ts.forEachChild(node, visit)
  }
  visit(apply)
  expect(declarations).toHaveLength(1)
  const initial = declarations[0]!.initializer!
  expect(ts.isAwaitExpression(initial)).toBe(true)
  const factory = (initial as ts.AwaitExpression).expression as ts.CallExpression
  expect(factory.expression.getText(source)).toBe('hostDispatchRules')
  const wiring = factory.arguments[0]!.getText(source)
  expect(wiring).toContain('env: process.env')
  expect(wiring).toContain('tasks, rules')
  expect(wiring).toContain('projects.getProjectsState()')
  expect(starts).toHaveLength(1)
  expect(starts[0]!.arguments[2]!.getText(source)).toContain('...(dispatchRules === undefined ? {} : { dispatchRules })')
})

it('实际普通 brief 与 QA 安全段组合：真实任务描述也参与筛选，普通在前且不被替代', async () => {
  const w = await world(), wired = await hostDispatchRules(w.input)
  const made = await w.tasks.create({ title: work.title, desc: '文章摘要', assignee: 'claude', projectId: '样片', status: 'todo' })
  const actual = await wired!.rulesFor!({ taskId: made.id!, said: work.title, kind: 'chat', dispatch: { family: 'claude', assignee: 'claude', target: 'new' } })
  const ordinary = w.rules.brief('dispatch', `${work.title}\n文章摘要\n${work.title}`, 'chat').text!
  expect(ordinary).toContain('文章标清出处，不编材料')
  expect(actual).toBe(`${ordinary}\n\n${S4_WINDOW_QA_RULE}`)
})

it.each([false, true])('正常 startFromEnv 的普通 rules.brief 真实回退与筛选保持：QA=%s', async enabled => {
  const w = await world(); if (!enabled) delete w.env[S4_WINDOW_QA_ENV]
  const item = { ...work, who: 'codex', title: '给样片写文章摘要' }
  const h = await serve(w, [item])
  await h.say('给样片写文章摘要，再检查出处')
  expect(h.sends()).toHaveLength(1)
  const send = h.sends()[0]!
  expect(send).toMatchObject({ submit: true, bundle_id: 'com.openai.codex' })
  if (send.op !== 'send_text') throw new Error('missing send_text')
  expect(send.text).toContain('文章标清出处，不编材料')
  expect(send.text).not.toContain('界面使用灰色')
  expect(send.text).not.toContain(S4_WINDOW_QA_RULE)
  expect(send.text.indexOf(item.title)).toBeLessThan(send.text.indexOf('文章标清出处，不编材料'))
})

it('显式 QA 经 host/startFromEnv 原 s4 HTTP 到窗口：原文与 Claude/submit 不变，末尾有唯一安全段', async () => {
  const w = await world(), h = await serve(w)
  const reply = await h.say(S4)
  expect(reply.status).toBe(200)
  expect(h.sends()).toHaveLength(1)
  const send = h.sends()[0]!
  expect(send).toMatchObject({ bundle_id: 'com.anthropic.claudefordesktop', submit: true, new_conversation: true })
  if (send.op !== 'send_text') throw new Error('missing send_text')
  expect(send.text).toContain(S4_WINDOW_QA_RULE)
  expect(send.text.indexOf(work.title)).toBeLessThan(send.text.indexOf(S4_WINDOW_QA_RULE))
  expect(send.text.split(S4_WINDOW_QA_RULE)).toHaveLength(2)
  expect(h.modelBodies).toHaveLength(1)
  expect(h.modelBodies[0]?.model).toBe('fixture-selected')
  expect(JSON.stringify(h.modelBodies[0]?.messages)).toContain(S4)
  const task = (await w.tasks.list()).tasks.find(one => one.title === work.title)
  expect(task?.title).toBe(work.title)
  expect(task?.from?.quote).toBe(S4)
  expect(reply.body.items[2].status).toBe('failed')
})

it('错误配置在 host 准备处明确失败，尚未开始 HTTP/模型/窗口', async () => {
  const w = await world()
  w.env[S4_WINDOW_QA_ENV] = JSON.stringify({ ...w.config, profileDir: '/tmp/not-owned-profile' })
  await expect(hostDispatchRules(w.input)).rejects.toThrow(/mismatch/)
  await expect(readFile(join(w.root, 's4-window-qa-bootstrap.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
