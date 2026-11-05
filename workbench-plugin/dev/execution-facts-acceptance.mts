/** QA: explicit single approved UUID only; never reads config, credentials or unlinked conversations. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { codexRolloutForSession } from '../src/server/codexThreadIndex.ts'
import type { WorkbenchState } from '../src/protocol.ts'
const id = process.argv[2]
assert.match(id ?? '', /^[a-f0-9-]{36}$/)
const root = process.env.CODEX_HOME ?? join(homedir(), '.codex')
const file = codexRolloutForSession(root, id!)
assert.ok(file, 'approved exact UUID must exist in its index')
const dir = await mkdtemp(join(tmpdir(), 'execution-natural-'))
let server: Awaited<ReturnType<typeof startWorkbenchServer>> | undefined
try {
  const taskFile = join(dir, 'tasks.json'), logFile = join(dir, 'jobs.jsonl')
  let tasks = createTasksService({ file: taskFile }), log = createJobLog({ file: logFile })
  const created = await tasks.create({ title: '公共执行事实当前来源核验', assignee: 'codex', status: 'doing', links: [{ agent: 'codex', session_id: id! }] })
  await tasks.update(created.id!, { dispatch: { family: 'codex', hand: 'cli', cwd: process.cwd().replace(/\/workbench-plugin$/, ''), status: 'running', session_id: id!, started_at: new Date().toISOString() } })
  async function open() {
    return startWorkbenchServer({ port: 0, tickIntervalMs: 0, heartbeatMs: 0, service: createWorkbenchService(), tasks, jobLog: log,
      authorization: { isAllowed: async () => true } as never,
      sessionDigest: { files: () => [{ agent: 'codex', session_id: id, file, format: 'codex-rollout' }] } as never })
  }
  server = await open()
  const before = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
  const source = before.execution?.items[0]?.sources[0]
  assert.ok(source?.state === 'running' || source?.state === 'unknown' && source.unknown === 'stale')
  assert.equal(source.provider, 'codex')
  assert.equal(before.running?.count, source.state === 'running' ? 1 : undefined)
  assert.equal(JSON.stringify(before.execution).includes(file), false)
  const events = log.all().length
  assert.ok(events > 0)
  await server.close(); server = undefined
  tasks = createTasksService({ file: taskFile }); log = createJobLog({ file: logFile }); await log.load()
  server = await open()
  const after = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
  const afterSource = after.execution?.items[0]?.sources[0]
  assert.ok(afterSource?.state === 'running' || afterSource?.state === 'unknown' && afterSource.unknown === 'stale')
  assert.equal(after.running?.count, afterSource.state === 'running' ? 1 : undefined)
  const afterEvents = log.all().length
  assert.ok(afterEvents >= events)
  if (afterSource.rounds.at(-1)?.event_id === source.rounds.at(-1)?.event_id && afterSource.state === source.state) assert.equal(afterEvents, events)
  const runs = await (await fetch(`${server.url}/collab/runs?task_id=${created.id}`)).json() as { runs: { status: string, current?: boolean }[] }
  const currentRun = runs.runs.find(run => run.current)
  assert.ok(currentRun?.status === 'running' || currentRun?.status === 'unknown')
  process.stdout.write(JSON.stringify({ approved_source: true, provider: source.provider, provider_basis: source.provider_basis,
    transport: source.transport, state_before: source.state, state_after_restart: afterSource.state, run_status: currentRun.status,
    unknown_before: source.unknown ?? null, last_event_at: source.rounds.at(-1)?.at,
    running_tasks_before: before.running?.count ?? null, source_events_before: events, source_events_after_restart: afterEvents,
    source_rounds: new Set(source.rounds.map(event => event.round)).size,
    replay_events_unchanged: afterEvents === events, original_path_absent_from_projection: true, http_and_restart: 'passed' }, null, 2) + '\n')
} finally { await server?.close(); await rm(dir, { recursive: true, force: true }) }
