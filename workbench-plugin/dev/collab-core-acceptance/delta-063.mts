/** 063 delta 实验:只读原自然执行证据,复制受控事实到新隔离实例,不调用模型、不种执行日志。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTasksService } from '../../src/server/tasks.ts'
import { createJobLog } from '../../src/server/jobLog.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { startWorkbenchServer } from '../../src/server/http.ts'
import { browserQa } from './browser.mts'

const original = process.env.COLLAB_DELTA_ORIGINAL
assert.ok(original, '明确指定已有受控自然执行归档,不新开执行')
const root = await mkdtemp(join(tmpdir(), 'collab-063-delta-'))
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const saved = new Map<string, Buffer>()
for (const name of ['tasks.json', 'jobs.jsonl', 'execution/input.json', 'execution/result.json']) saved.set(name, await readFile(join(original, name)))
const data = JSON.parse(saved.get('tasks.json')!.toString())
assert.ok(data.tasks.every((t: any) => t.dispatch?.status !== 'running'), '归档必须已完成,不能在副本恢复活进程')
const parent = data.tasks.find((t: any) => t.title === '受控求和')
const message = parent.messages[0]
const childId = message.deliveries[0].task_id
const child = data.tasks.find((t: any) => t.id === childId)
assert.equal(child.dispatch.status, 'done')
assert.equal(child.receipt.message_id, message.id)
assert.ok(child.dispatch.session_id)
const input: number[] = JSON.parse(saved.get('execution/input.json')!.toString())
const result = JSON.parse(saved.get('execution/result.json')!.toString())
assert.equal(result.sum, input.reduce((sum, n) => sum + n, 0))
for (const name of ['tasks.json', 'jobs.jsonl']) await writeFile(join(root, name), saved.get(name)!)
const tasks = createTasksService({ file: join(root, 'tasks.json') })
const jobLog = createJobLog({ file: join(root, 'jobs.jsonl') }); await jobLog.load()
assert.ok(jobLog.events(childId).some(e => e.step === 'started'))
assert.ok(jobLog.events(childId).some(e => e.step === 'replied'))
const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tasks, jobLog, tickIntervalMs: 0, collabWorkdir: async () => join(root, 'work') })
const records: unknown[] = []
async function call(path: string, body?: unknown, status = 200) {
  const r = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const got = await r.json() as any
  assert.equal(r.status, status, `${path}: ${JSON.stringify(got)}`)
  records.push({ path, status, at: new Date().toISOString() })
  return got
}
const goal = data.goals.find((g: any) => g.id === child.goal_id)
const condition = goal.conditions.find((c: any) => c.text === '读取真实输入生成结果')
const board = async () => (await call(`/collab/goal/board?goal_id=${goal.id}`)).summary.conditions.items.find((c: any) => c.id === condition.id).state
const verify = () => call('/collab/goal/condition/verify', { goal_id: goal.id, condition_id: condition.id, by: 'me', pass: true, note: `重新核对原自然执行产物 sum=${result.sum};本轮没有再次执行模型` })
const deliver = (status = 200) => call('/collab/goal/condition/deliver', { goal_id: goal.id, condition_id: condition.id }, status)
const move = (id: string, status: string) => call('/task/move', { id, status })
let ui: Awaited<ReturnType<typeof browserQa>> | undefined
async function see(expected: string, label: string) {
  if (!ui) return
  // 每个 checkpoint 重读当前真实快照,避免连续相同状态命中上一拍 React DOM。
  await ui.open('goal', { goal: goal.id, task: childId, condition: condition.id })
  await ui.state(expected, label)
}
try {
  const duplicate = await call('/collab/note/message', { task_id: parent.id, text: message.text, intent: 'ask', mentions: message.mentions, client_msg_id: message.client_msg_id })
  assert.equal(duplicate.duplicated, true)
  assert.equal((await tasks.list()).tasks.length, data.tasks.length)
  assert.equal(duplicate.message.deliveries[0].task_id, childId)
  const activity = await call(`/collab/note/activity?id=${parent.id}`)
  assert.equal(activity.items.find((i: any) => i.type === 'message').message.deliveries[0].receipt.message_id, message.id)
  assert.equal(await board(), 'rework')
  await move(childId, 'confirm'); await verify(); await deliver()
  if (process.env.COLLAB_UI_ROOT) { ui = await browserQa(server.url, root); await see('delivered', 'delta-initial-delivered') }
  const initialRound = (await tasks.list()).tasks.find(t => t.id === childId)!.round ?? 1
  for (const path of [['blocked', 'doing'], ['canceled', 'todo', 'doing']]) {
    for (const status of path) await move(childId, status)
    assert.equal(await board(), 'rework'); await deliver(409)
    await see('rework', `delta-${path[0]}-rework`)
    await move(childId, 'confirm'); await verify(); await deliver()
  }
  assert.equal((await tasks.list()).tasks.find(t => t.id === childId)!.round, initialRound + 2)
  const upstream = await call('/task/create', { title: '受控上游材料', status: 'todo', assignee: 'me' })
  await move(upstream.id, 'doing'); await move(upstream.id, 'confirm')
  const relation = await call('/collab/relation/save', { from_id: upstream.id, to_id: childId, kind: 'handoff', note: '本实验引用原自然产物,未新执行' })
  await move(upstream.id, 'doing')
  assert.equal(await board(), 'rework'); await deliver(409)
  await call('/collab/goal/condition/verify', { goal_id: goal.id, condition_id: condition.id, by: 'me', pass: true }, 409)
  await see('rework', 'delta-upstream-rework')
  await call('/collab/relation/remove', { id: relation.id })
  assert.equal(await board(), 'rework')
  await verify(); await deliver()
  await call('/collab/goal/condition/save', { goal_id: goal.id, id: condition.id, text: condition.text, task_id: null })
  assert.equal(await board(), 'pending'); await deliver(409)
  await call('/collab/goal/condition/save', { goal_id: goal.id, id: condition.id, text: condition.text, task_id: childId })
  assert.equal(await board(), 'rework'); await verify(); await deliver()
  await see('delivered', 'delta-reverified-delivered')
  assert.equal(await readFile(join(root, 'jobs.jsonl'), 'utf8'), saved.get('jobs.jsonl')!.toString(), '没有新增/手工重造执行记录')
  for (const [name, bytes] of saved) assert.equal(hash(await readFile(join(original, name))), hash(bytes), '原证据不得改动')
  const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url))
  const files: Record<string, string> = {}
  for (const file of ['src/protocol.ts', 'src/server/tasks.ts', 'src/server/collabRoutes.ts', 'src/server/collabRelations.ts', 'src/server/collabLan.ts', 'src/server/collabLanTransport.ts', 'src/server/dispatchRun.ts']) files[file] = hash(await readFile(join(sourceRoot, 'workbench-plugin', file)))
  const evidence = { scope: '063-delta-recheck-existing-natural-execution', original, root, source: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(), files }, session_id: child.dispatch.session_id, child_id: childId, message_id: message.id, sum: result.sum, new_model_calls: 0, job_log_unchanged: true, original_unchanged: true, final_condition: await board(), records }
  await writeFile(join(root, 'delta-evidence.json'), JSON.stringify(evidence, null, 2))
  const out = process.env.COLLAB_DELTA_EVIDENCE
  if (out) { await mkdir(out, { recursive: true }); await writeFile(join(out, 'delta-evidence.json'), JSON.stringify(evidence, null, 2)); for (const name of ['delta-initial-delivered', 'delta-blocked-rework', 'delta-canceled-rework', 'delta-upstream-rework', 'delta-reverified-delivered']) { if (ui) await writeFile(join(out, `ui-${name}.png`), await readFile(join(root, `ui-${name}.png`))) } }
  console.log(JSON.stringify({ ok: true, root, session_id: child.dispatch.session_id, sum: result.sum, requests: records.length, new_model_calls: 0 }))
} finally { await ui?.close(); await server.close() }
