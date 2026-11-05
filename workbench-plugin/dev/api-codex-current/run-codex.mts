/** 真 Codex CLI 原件：Say -> 产品引擎/派活账/links -> transcript/digest。无手种回执。 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startWorkbenchServer } from '../../src/server/http.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { createTasksService } from '../../src/server/tasks.ts'
import { createAuthorizationService } from '../../src/server/authorization.ts'
import { createEngine } from '../../src/server/engine/engine.ts'
import { createRegistry } from '../../src/server/engine/registry.ts'
import { createActionGate } from '../../src/server/actionGate.ts'
import { createJobLog } from '../../src/server/jobLog.ts'
const out = process.env.QA_API_OUTPUT
if (!out) throw new Error('QA_API_OUTPUT required')
mkdirSync(out, { recursive: true, mode: 0o700 })
const cwd = join(out, 'project'); mkdirSync(cwd, { recursive: true })
execFileSync('git', ['init', '-q', cwd])
const tasks = createTasksService({ file: join(out, 'tasks.json') })
const auth = createAuthorizationService({ file: join(out, 'authorization.md') })
for (const key of ['read_client_files', 'write_api'] as const) await auth.set(key, '可以', '2026-10-24')
const log = createJobLog({ warn: () => {} })
const gate = createActionGate({ phaseOf: () => 'unknown', log, now: () => new Date() })
const registry = createRegistry()
const engine = createEngine({ registry, gate, log, warn: () => {} })
const bin = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim()
let executions = 0
const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService({}), tasks, authorization: auth,
  tickIntervalMs: 0, heartbeatMs: 0, engine, engineRegistry: registry, actionGate: gate, jobLog: log,
  dispatchRun: {
    resultDir: out,
    resolveCli: family => family === 'codex' ? { found: true, family, bin } : { found: false, family, why: 'QA只接Codex' },
    runCli: cmd => {
      if (cmd.bin !== bin || cmd.cwd !== cwd) throw new Error('QA process out of scope')
      executions++
      const fd = openSync(cmd.logFile, 'a', 0o600)
      const child = spawn(cmd.bin, [...cmd.argv], { cwd: cmd.cwd, env: process.env, stdio: ['ignore', fd, fd] })
      closeSync(fd)
      return { pid: child.pid, exited: new Promise(resolve => { child.once('exit', code => resolve({ code })); child.once('error', () => resolve({ code: null })) }) }
    },
    readFile: async path => readFile(path, 'utf8').catch(() => undefined),
    alive: pid => { try { process.kill(pid, 0); return true } catch { return false } },
  },
})
const evidence: Record<string, unknown>[] = []
const save = (stage: string, data: Record<string, unknown>) => { evidence.push({ stage, ...data }); writeFileSync(join(out, 'report.json'), JSON.stringify(evidence, null, 2)); console.log(stage, JSON.stringify(data)) }
const post = async (path: string, body: unknown) => { const r = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any } }
try {
 const card = await post('/collab/agent/save', { name: 'QA Codex 原件', hand: 'cli', runtime: { family: 'codex' }, project: { repo: cwd }, budget: { minutes: 5 } })
 save('card', { status: card.status, id: card.body.id })
 const said = await post('/butler/say', { text: '派给 Codex 修改代码任务的验收回执。这是受控原件验收，仅输出：原件验收真实执行已经收到。禁止工具、文件读写与代理调用。', client_key: 'qa-codex-source-current' })
 save('say', said)
 const id = said.body.items?.find((i: any) => i.card_id)?.card_id
 let task
 const end = Date.now() + 150_000
 while (id && said.body.items?.[0]?.status !== 'failed' && Date.now() < end) {
  task = (await tasks.list()).tasks.find(t => t.id === id)
  if (task?.dispatch?.status === 'done' || task?.dispatch?.status === 'failed' || task?.dispatch_block) break
  await new Promise(r => setTimeout(r, 300))
 }
 save('real-dispatch', { executions, dispatch: task?.dispatch, links: task?.links })
 const session = task?.links?.find(l => l.agent === 'codex')?.session_id
 if (!session || task?.dispatch?.status !== 'done') { process.exitCode = 1 }
 else {
  for (const route of ['transcript', 'digest']) {
   const r = await fetch(`${server.url}/sessions/${route}?agent=codex&id=${encodeURIComponent(session)}`)
   const body = await r.json()
   save(route, { status: r.status, body })
   if (r.status !== 200 || !JSON.stringify(body).includes('原件验收真实执行')) process.exitCode = 1
  }
 }
} finally { await server.close() }
