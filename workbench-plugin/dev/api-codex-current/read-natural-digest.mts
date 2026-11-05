/** 只读已登记自然执行原件；加载原 tasks/授权，无模型、CLI、凭据或登记补写。 */
import { mkdtemp, copyFile, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { startWorkbenchServer } from '../../src/server/http.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { createTasksService } from '../../src/server/tasks.ts'
import { createAuthorizationService } from '../../src/server/authorization.ts'
import { locateCodexCliSession } from '../../src/server/cliSessionRead.ts'

const source = process.env.QA_DIGEST_SOURCE
const output = process.env.QA_DIGEST_OUTPUT
if (!source || !output) throw new Error('QA_DIGEST_SOURCE and QA_DIGEST_OUTPUT required')
const id = '01a16c39-fa2a-77d3-8202-9755860955fd'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const sourceTasks = await readFile(join(source, 'tasks.json'))
const board = JSON.parse(sourceTasks.toString('utf8'))
const task = board.tasks.find((one: { id: string }) => one.id === 't-18d28421')
if (!task?.links?.some((link: { agent: string, session_id: string }) => link.agent === 'codex' && link.session_id === id)) throw new Error('original registration missing')
const dir = await mkdtemp(join(tmpdir(), 'api-natural-digest-'))
const evidence: Record<string, unknown> = { session_id: id, task_id: task.id, source_tasks_sha256: hash(sourceTasks), new_model_requests: 0, new_cli_executions: 0 }
let server: Awaited<ReturnType<typeof startWorkbenchServer>> | undefined
try {
  await copyFile(join(source, 'tasks.json'), join(dir, 'tasks.json'))
  await copyFile(join(source, 'authorization.md'), join(dir, 'authorization.md'))
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const authorization = createAuthorizationService({ file: join(dir, 'authorization.md') })
  if (!(await authorization.isAllowed('read_client_files'))) throw new Error('original controlled read permission absent')
  const ref = await locateCodexCliSession({ codexHome: process.env.CODEX_HOME ?? join(homedir(), '.codex'), sessionId: id, cwds: [task.dispatch.cwd] })
  if (!ref) throw new Error('exact registered source unavailable')
  const rawBefore = await readFile(ref.file)
  evidence.raw_sha256 = hash(rawBefore)
  evidence.raw_bytes = rawBefore.length
  server = await startWorkbenchServer({ port: 0, service: createWorkbenchService({}), tasks, authorization, tickIntervalMs: 0, heartbeatMs: 0 })
  for (const route of ['transcript', 'digest']) {
    const response = await fetch(`${server.url}/sessions/${route}?agent=codex&id=${id}`)
    evidence[route] = { status: response.status, body: await response.json() }
  }
  const transcript = evidence.transcript as { status: number, body: { entries?: { k: string, text?: string, final?: boolean }[] } }
  const digest = evidence.digest as { status: number, body: { rounds?: { reply?: string }[] } }
  evidence.transcript_has_final = transcript.status === 200 && transcript.body.entries?.some(one => one.k === 'reply' && one.final && one.text === 'QA_1C_SUGGEST_REAL') === true
  evidence.digest_has_final = digest.status === 200 && digest.body.rounds?.some(one => one.reply === 'QA_1C_SUGGEST_REAL') === true
  evidence.raw_unchanged = hash(await readFile(ref.file)) === evidence.raw_sha256
  evidence.source_tasks_unchanged = hash(await readFile(join(source, 'tasks.json'))) === evidence.source_tasks_sha256
  evidence.loaded_tasks_unchanged = hash(await readFile(join(dir, 'tasks.json'))) === evidence.source_tasks_sha256
  if (!evidence.transcript_has_final || !evidence.digest_has_final || !evidence.raw_unchanged || !evidence.source_tasks_unchanged || !evidence.loaded_tasks_unchanged) process.exitCode = 1
} finally {
  await server?.close()
  await rm(dir, { recursive: true, force: true })
  evidence.cleanup = 'own port0 server closed; temporary tasks/authorization copies removed'
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'live-http.json'), JSON.stringify(evidence, null, 2) + '\n')
}
console.log(JSON.stringify({ transcript_has_final: evidence.transcript_has_final, digest_has_final: evidence.digest_has_final, raw_unchanged: evidence.raw_unchanged, cleanup: evidence.cleanup }))
