/** 真实受控执行验收。只用现有 Codex CLI 认证,不读取/复制个人配置。产物留在独立临时目录。 */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createRegistry } from '../../src/server/engine/registry.ts'
import { createEngine } from '../../src/server/engine/engine.ts'
import { createActionGate } from '../../src/server/actionGate.ts'
import { createJobLog } from '../../src/server/jobLog.ts'
import { createTasksService } from '../../src/server/tasks.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { startWorkbenchServer } from '../../src/server/http.ts'
const reused = process.env.COLLAB_QA_REUSE
const root = reused ?? await mkdtemp(join(tmpdir(), 'collab-core-real-'))
const repo = join(root, 'execution'); if (!reused) await mkdir(repo)
if (!reused) execFileSync('git', ['init', '-q', repo])
if (!reused) await writeFile(join(repo, 'AGENTS.md'), 'Only work in this controlled acceptance directory. Read input.json and write result.json as requested. Do not inspect any other repository, personal files, credentials or configuration. Do not spawn agents.\n')
const numbers: number[] = reused ? JSON.parse(await readFile(join(repo, 'input.json'), 'utf8')) : [100 + Math.floor(Math.random() * 300), 300 + Math.floor(Math.random() * 300)]
if (!reused) await writeFile(join(repo, 'input.json'), JSON.stringify(numbers))
const tasks = createTasksService({ file: join(root, 'tasks.json') })
const jobLog = createJobLog({ file: join(root, 'jobs.jsonl') })
await jobLog.load()
const registry = createRegistry()
const gate = createActionGate({ log: jobLog, phaseOf: () => 'open', now: () => new Date() })
const engine = createEngine({ registry, gate, log: jobLog, warn: () => {} })
const children = new Set<ReturnType<typeof spawn>>()
const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tasks, jobLog, engine, engineRegistry: registry, tickIntervalMs: 0, collabWorkdir: async () => join(root, 'work'), dispatchRun: {
 pollMs: 200,
 alive: pid => { try { process.kill(pid, 0); return true } catch { return false } },
 resultDir: root,
 runCli: cmd => {
  const fd = openSync(cmd.logFile, 'a', 0o600)
  const child = spawn(cmd.bin, [...cmd.argv], { cwd: cmd.cwd, env: cmd.env ?? process.env, stdio: ['ignore', fd, fd] }); closeSync(fd); children.add(child)
  const exited = new Promise<{ code: number | null }>(resolve => { child.once('exit', code => { children.delete(child); resolve({ code }) }); child.once('error', () => { children.delete(child); resolve({ code: 1 }) }) })
  return { ...(child.pid === undefined ? {} : { pid: child.pid }), exited }
 },
} })
let browser: Awaited<ReturnType<typeof import('./browser.mts')['browserQa']>> | undefined
const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(), files: {} as Record<string, string> }
for (const path of ['protocol.ts', 'server/http.ts', 'server/tasks.ts', 'server/dispatchRun.ts', 'server/collabRoutes.ts', 'server/collabDelivery.ts', 'server/collabLanTransport.ts']) source.files[path] = createHash('sha256').update(await readFile(join(sourceRoot, 'workbench-plugin/src', path))).digest('hex')
const records: unknown[] = []
async function api(path: string, body?: unknown) {
 const res = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
 const got = await res.json() as any
 if (!res.ok) throw new Error(`${path}: ${res.status} ${got.error ?? ''}`)
 return got
}
const record = (name: string, data: unknown) => { records.push({ at: new Date().toISOString(), name, data }); console.log(name, JSON.stringify(data)) }
try {
 await registry.targets()
 const existing = await tasks.list()
 const card = reused ? { id: existing.agent_cards!.find(c => c.name === 'QA 受控 Codex')!.id } : await api('/collab/agent/save', { name: 'QA 受控 Codex', hand: 'codex', runtime: { family: 'codex' }, project: { repo }, budget: { minutes: 5 } })
 const goal = reused ? { id: existing.goals!.find(g => g.title === '真实协作执行可验收')!.id } : await api('/collab/goal/create', { title: '真实协作执行可验收', project_id: 'qa-project', conditions: [{ text: '读取真实输入生成结果' }, { text: '结果可人工核验' }, { text: '重开使旧验收失效' }] })
 const parent = reused ? { id: existing.tasks.find(t => t.title === '受控求和')!.id } : await api('/task/create', { title: '受控求和', from: { kind: 'user', quote: '受控验收' }, status: 'todo', assignee: 'me', project_id: 'qa-project', goal_id: goal.id, acceptance: ['读取 input.json,将 sum 写入 result.json,回执给出结果文件路径'] })
 const said = reused ? { message: existing.tasks.find(t => t.id === parent.id)!.messages![0] } : await api('/collab/note/message', { task_id: parent.id, intent: 'ask', mentions: [card.id], client_msg_id: 'natural-once', text: '在当前受控目录读取 input.json 的数字,计算总和,创建 result.json 内容为 {"sum":总和}。不要读其它目录,不要创建代理。最后以“做完:”开头交回,写明 result.json 的绝对路径和总和。' })
 const delivery = said.message.deliveries[0]
 assert.equal(delivery.status, 'delivered', JSON.stringify(delivery))
 const childId = delivery.task_id; assert.ok(childId)
 record('natural-dispatch', { execution_reused: reused !== undefined, task_id: childId, card_id: card.id, message_id: said.message.id, parent: parent.id })
 let sawRunning = false, child: any
 const until = Date.now() + 240_000
 while (Date.now() < until) {
  const runs = await api(`/collab/runs?task_id=${childId}`)
  if (runs.runs.some((r: any) => r.status === 'running')) sawRunning = true
  const state = await api('/state'); child = state.tasks.tasks.find((t: any) => t.id === childId)
  if (child.dispatch?.status === 'done' || child.dispatch?.status === 'failed') break
  await new Promise(r => setTimeout(r, 300))
 }
 assert.equal(child?.dispatch?.status, 'done', child?.note ?? '未得到收尾')
 assert.ok(child.dispatch.session_id, '缺真实 session id')
 assert.equal(child.receipt?.by, card.id)
 assert.equal(child.receipt?.message_id, said.message.id)
 const result = JSON.parse(await readFile(join(repo, 'result.json'), 'utf8'))
 assert.equal(result.sum, numbers.reduce((a, b) => a + b, 0))
 const activity = await api(`/collab/note/activity?id=${parent.id}`)
 assert.equal(activity.items.find((i: any) => i.type === 'message').message.deliveries[0].status, 'accepted')
 const runs = await api(`/collab/runs?task_id=${childId}`)
 assert.equal(runs.runs.at(-1).status, 'done')
 assert.ok(jobLog.events(childId).some(e => e.step === 'started'))
 record('natural-receipt', { task_id: childId, source: 'codex-cli', session_id: child.dispatch.session_id, receipt: child.receipt, runs: runs.runs, sawRunning, result })
 const rawGoal = (await api('/state')).tasks.goals.find((g: any) => g.id === goal.id)
 const condition = rawGoal.conditions.find((c: any) => c.text === '读取真实输入生成结果')
 await api('/collab/goal/condition/save', { goal_id: goal.id, id: condition.id, text: condition.text, task_id: childId, evidence: [join(repo, 'result.json')] })
 if (process.env.COLLAB_UI_ROOT) {
  browser = await (await import('./browser.mts')).browserQa(server.url, root)
  await browser.open('goal', { goal: goal.id, task: childId, condition: condition.id })
  const initial = (await api(`/collab/goal/board?goal_id=${goal.id}`)).summary.conditions.items.find((c: any) => c.id === condition.id).state
  if (initial === 'submitted') { await browser.state('submitted', 'submitted'); await browser.action('核验通过'); await browser.state('verified', 'verified') }
  if (initial !== 'delivered') await browser.action('记交付')
  await browser.state('delivered', 'delivered')
  record('production-react-verification-delivery', { ui_source: process.env.COLLAB_UI_ROOT, condition_id: condition.id })
 } else {
  await api('/collab/goal/condition/verify', { goal_id: goal.id, condition_id: condition.id, by: 'me', pass: true, note: `实际读产物 sum=${result.sum},与输入逐项相加一致` })
  await api('/collab/goal/condition/deliver', { goal_id: goal.id, condition_id: condition.id })
 }
 assert.equal((await api(`/collab/goal/board?goal_id=${goal.id}`)).summary.conditions.items.find((c: any) => c.id === condition.id).state, 'delivered')
 await api('/task/move', { id: childId, status: 'done' }); await api('/task/move', { id: childId, status: 'doing' })
 const reopened = (await api(`/collab/goal/board?goal_id=${goal.id}`)).summary.conditions.items.find((c: any) => c.id === condition.id)
 assert.equal(reopened.state, 'rework')
 await api('/collab/relation/save', { from_id: parent.id, to_id: childId, kind: 'rejected_back', note: '下一轮补充负数输入再验' })
 if (browser) {
  await browser.state('rework', 'reopened')
  await browser.open('activity', { goal: goal.id, task: parent.id })
  await browser.textIncludes('回执')
  await browser.open('runs', { goal: goal.id, task: childId })
  await browser.textIncludes('收场:replied')
 }
 record('verified-delivered-reopened', { goal_id: goal.id, condition_id: condition.id, state: reopened.state, next: childId })
 await writeFile(join(root, 'evidence.json'), JSON.stringify({ source, root, server: server.url, records, passed: true }, null, 2))
 console.log('ACCEPTANCE_PASSED', root)
} finally { await browser?.close(); await server.close(); for (const child of children) child.kill('SIGTERM') }
