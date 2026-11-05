/** Exact task-authorized native Kimi acceptance. No config, credentials, or other session contents. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { locateKimiCliSession } from '../src/server/cliSessionRead.ts'
import { kimiExecutionEvents } from '../src/server/codexExecutionFacts.ts'
import type { WorkbenchState } from '../src/protocol.ts'

const id = process.argv[2]
assert.equal(id, 'session_ca19f048-e7f7-4b6f-ae7a-05a0ab0eb140')
const ownerTree = '/Users/example/Documents/GitHub/desktop-workbench/.claude/worktrees/事务官机制A同事项补充改-8537'
const ref = await locateKimiCliSession({ home: homedir(), sessionId: id, cwds: [ownerTree] })
assert.ok(ref, 'exact native source must pass its project gate')
assert.equal(ref.format, 'kimi-wire')
const raw = await readFile(ref.file, 'utf8')
const sourceEvents = kimiExecutionEvents(raw, id)
assert.ok(sourceEvents.some(one => one.kind === 'started'))
const firstEnded = sourceEvents.find(one => one.kind === 'ended')
assert.ok(firstEnded && Date.parse(firstEnded.at) > Date.parse('2026-10-26T06:50:00Z'))
assert.ok(sourceEvents.some(one => one.kind === 'updated' && Date.parse(one.at) > Date.parse('2026-10-26T06:50:00Z')
  && Date.parse(one.at) < Date.parse(firstEnded.at)))
const temp = await mkdtemp(join(tmpdir(), 'execution-kimi-native-'))
const tasksFile = join(temp, 'tasks.json'), jobsFile = join(temp, 'jobs.jsonl')
let tasks = createTasksService({ file: tasksFile }), jobs = createJobLog({ file: jobsFile })
let allowed = true
let server: Awaited<ReturnType<typeof startWorkbenchServer>> | undefined
try {
  const task = await tasks.create({ title: '原生 Kimi 精确来源验收', status: 'doing', assignee: 'kimi', projectId: 'owner',
    links: [{ agent: 'kimi', session_id: id }] })
  assert.ok(task.id)
  await tasks.update(task.id, { dispatch: { family: 'kimi', hand: 'cli', status: 'running', cwd: ownerTree,
    session_id: id, started_at: new Date().toISOString() } })
  async function open() {
    return startWorkbenchServer({ port: 0, tickIntervalMs: 0, heartbeatMs: 0,
      service: createWorkbenchService(), tasks, jobLog: jobs,
      paths: { home: homedir(), config: {} } as never,
      authorization: { isAllowed: async (scope: string) => allowed && scope === 'read_client_files',
        denialMessage: () => 'QA 授权已撤回' } as never,
      projects: { getProjectsState: async () => ({ projects: [{ id: 'owner', name: 'owner', path: ownerTree }] }) } as never,
      sessionDigest: { files: () => [ref] } as never })
  }
  async function snapshot(): Promise<WorkbenchState> {
    assert.ok(server)
    const response = await fetch(`${server.url}/state`)
    assert.equal(response.status, 200)
    return await response.json() as WorkbenchState
  }
  async function restart() {
    assert.ok(server)
    await server.close(); server = undefined
    await jobs.flush()
    tasks = createTasksService({ file: tasksFile }); jobs = createJobLog({ file: jobsFile }); await jobs.load()
    server = await open()
  }
  server = await open()
  const first = await snapshot()
  const firstSource = first.execution?.items.find(one => one.task_id === task.id)?.sources[0]
  assert.equal(firstSource?.provider, 'kimi')
  assert.equal(firstSource?.provider_basis, 'native_reader')
  assert.equal(firstSource?.transport, 'kimi-wire')
  assert.equal(firstSource?.session_id, id)
  assert.ok(firstSource.rounds.some(one => one.kind === 'ended'))
  assert.equal(JSON.stringify(first.execution).includes(ref.file), false)
  const firstFile = await stat(ref.file)
  const beforeEvents = jobs.all().length
  allowed = false
  const revoked = await snapshot()
  assert.equal(revoked.execution?.items.find(one => one.task_id === task.id)?.sources[0]?.unknown, 'denied')
  assert.equal(revoked.running?.count, undefined)
  assert.equal(revoked.sessions.some(one => one.session_id === id), false)
  await restart()
  const deniedAfterRestart = await snapshot()
  assert.equal(deniedAfterRestart.execution?.items.find(one => one.task_id === task.id)?.sources[0]?.unknown, 'denied')
  allowed = true
  const restored = await snapshot()
  const restoredSource = restored.execution?.items.find(one => one.task_id === task.id)?.sources[0]
  assert.equal(restoredSource?.provider, 'kimi')
  assert.equal(restoredSource?.transport, 'kimi-wire')
  assert.notEqual(restoredSource?.unknown, 'denied')
  const afterFile = await stat(ref.file)
  const sourceIds = jobs.all().filter(one => one.session_id === id && one.source_event_id !== undefined)
    .map(one => `${one.source_round}:${one.source_event_id}`)
  assert.equal(new Set(sourceIds).size, sourceIds.length)
  assert.ok(jobs.all().length >= beforeEvents)
  const runReply = await fetch(`${server.url}/collab/runs?task_id=${task.id}`)
  assert.equal(runReply.status, 200)
  const runs = await runReply.json() as { runs: { current?: boolean, status: string }[] }
  assert.ok(runs.runs.some(one => one.current))
  process.stdout.write(JSON.stringify({ exact_native_uuid: true, project_gate: true,
    transport: firstSource.transport, provider: firstSource.provider, provider_basis: firstSource.provider_basis,
    raw_lifecycle: { events: sourceEvents.length, rounds: new Set(sourceEvents.map(one => one.round)).size,
      first_end_at: firstEnded.at, updates_after_intermediate_before_end: true },
    http_initial_state: firstSource.state, http_revoked: 'denied', restart_revoked: 'denied',
    http_restored_state: restoredSource?.state, run_current: runs.runs.find(one => one.current)?.status,
    source_bytes_before: firstFile.size, source_bytes_after: afterFile.size,
    log_events_before: beforeEvents, log_events_after: jobs.all().length,
    source_events_unique: true, original_path_absent_from_projection: true }, null, 2) + '\n')
} finally { await server?.close(); await rm(temp, { recursive: true, force: true }) }
