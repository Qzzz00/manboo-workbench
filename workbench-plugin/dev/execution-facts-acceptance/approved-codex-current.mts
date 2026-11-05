/** Read only the task-authorized Codex UUID through the public HTTP reconciler. Print metadata, never conversation text. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorkbenchServer } from '../../src/server/http.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { createTasksService } from '../../src/server/tasks.ts'
import { createJobLog } from '../../src/server/jobLog.ts'
import { codexRolloutForSession } from '../../src/server/codexThreadIndex.ts'
import type { WorkbenchState } from '../../src/protocol.ts'

const id = '01a17646-54f6-75e2-8bf4-0d2a6177349b'
const root = process.env.CODEX_HOME ?? join(homedir(), '.codex')
const file = codexRolloutForSession(root, id)
assert.ok(file, 'exact approved Codex source must exist')
const temp = await mkdtemp(join(tmpdir(), 'execution-codex-current-'))
const taskFile = join(temp, 'tasks.json'), logFile = join(temp, 'jobs.jsonl')
let tasks = createTasksService({ file: taskFile }), log = createJobLog({ file: logFile })
let server: Awaited<ReturnType<typeof startWorkbenchServer>> | undefined
try {
  const made = await tasks.create({ title: '授权 Codex 来源当前状态', assignee: 'codex', status: 'doing',
    links: [{ agent: 'codex', session_id: id }] })
  assert.ok(made.id)
  await tasks.update(made.id, { dispatch: { family: 'codex', hand: 'cli', cwd: process.cwd().replace(/\/workbench-plugin$/, ''),
    status: 'running', session_id: id, started_at: new Date().toISOString() } })
  async function open() { return startWorkbenchServer({ port: 0, tickIntervalMs: 0, heartbeatMs: 0,
    service: createWorkbenchService(), tasks, jobLog: log,
    authorization: { isAllowed: async () => true } as never,
    sessionDigest: { files: () => [{ agent: 'codex', session_id: id, file, format: 'codex-rollout' }] } as never }) }
  async function snapshot(): Promise<WorkbenchState> {
    assert.ok(server)
    const response = await fetch(`${server.url}/state`)
    assert.equal(response.status, 200)
    return await response.json() as WorkbenchState
  }
  server = await open()
  const before = await snapshot(), source = before.execution?.items[0]?.sources[0]
  assert.equal(source?.session_id, id)
  if (source.unknown === undefined) {
    assert.equal(source.provider, 'codex')
    assert.equal(source.transport, 'codex-rollout')
  } else {
    assert.equal(before.running?.count, undefined)
  }
  assert.equal(JSON.stringify(before.execution).includes(file), false)
  const eventCount = log.all().length
  await server.close(); server = undefined
  await log.flush()
  tasks = createTasksService({ file: taskFile }); log = createJobLog({ file: logFile }); await log.load()
  server = await open()
  const after = await snapshot(), replayed = after.execution?.items[0]?.sources[0]
  assert.equal(replayed?.state, source.state)
  assert.equal(replayed?.unknown, source.unknown)
  assert.equal(replayed?.rounds.at(-1)?.event_id, source.rounds.at(-1)?.event_id)
  assert.equal(after.running?.count, before.running?.count)
  assert.equal(log.all().length, eventCount)
  process.stdout.write(JSON.stringify({ exact_approved_uuid: true, provider: source.provider,
    transport: source.transport, state: source.state, unknown: source.unknown ?? null,
    last_kind: source.rounds.at(-1)?.kind ?? null, last_at: source.rounds.at(-1)?.at ?? null,
    running_count: before.running?.count ?? null, observed_count: before.running?.observed_count ?? null,
    restart_same_state: true, source_events_before: eventCount, source_events_after: log.all().length,
    original_path_absent_from_projection: true }, null, 2) + '\n')
} finally { await server?.close(); await rm(temp, { recursive: true, force: true }) }
