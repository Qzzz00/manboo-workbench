// @vitest-environment node
// Isolated, synthetic /state performance probe. No daily files are opened.
import { DatabaseSync } from 'node:sqlite'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from 'node:inspector/promises'
import type { Profiler } from 'node:inspector'
import { afterEach, expect, it, vi } from 'vitest'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createProjectsService } from '../src/server/projectsService.ts'
import { createSessionDigestService } from '../src/server/sessionDigestService.ts'

let server: WorkbenchServer | undefined
let home: string | undefined
afterEach(async () => {
  await server?.close(); server = undefined
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined; vi.unstubAllEnvs()
})

it('diagnoses the authorized production /state path with synthetic sources and ledger', async () => {
  home = mkdtempSync(join(tmpdir(), 'execution-perf-'))
  const project = join(home, 'project'), codexHome = join(home, '.codex')
  const codexDir = join(codexHome, 'sessions', '2026', '10', '26')
  mkdirSync(project); mkdirSync(codexDir, { recursive: true })
  vi.stubEnv('CODEX_HOME', codexHome)
  const nowSec = Date.parse('2026-10-26T08:00:00Z') / 1000
  const projectsFile = join(home, 'projects.json')
  writeFileSync(projectsFile, JSON.stringify({ version: 1, projects: [{ id: 'qa', name: 'QA', stage: '待整理', repoPath: project, links: [] }], rules: [] }))
  const projects = createProjectsService({ file: projectsFile, home, codexHome,
    exec: async () => ({ ok: true, stdout: '' }), listDir: async () => [], isRepo: async () => false,
    codexDeps: { listFiles: async () => [], readFirstLine: async () => '' }, scanRoots: [], now: () => nowSec })
  const tasks = createTasksService({ file: join(home, 'tasks.json'), now: () => nowSec })
  const jobsFile = join(home, 'jobs.jsonl')
  writeFileSync(jobsFile, Array.from({ length: 3900 }, (_, i) => JSON.stringify({ at: new Date(nowSec * 1000).toISOString(), job: `older-${i}`, step: 'sent', why: 'x'.repeat(200) })).join('\n') + '\n')
  const jobLog = createJobLog({ file: jobsFile, now: () => new Date(nowSec * 1000) })
  await jobLog.load()
  const service = createWorkbenchService({ now: () => nowSec })
  const digest = createSessionDigestService({ sessions: () => service.getState().sessions })
  const db = new DatabaseSync(join(codexHome, 'state_1.sqlite'))
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)')
  const put = db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)')
  const richSources = Math.max(1, Math.min(12, Number(process.env.EXECUTION_PERF_RICH_SOURCES ?? 8)))
  for (let i = 0; i < 12; i++) {
    const kimi = i >= 8, registered = i >= 4 && i < 8
    const agent = kimi ? 'kimi' : 'codex', id = `session-synthetic-${i}`
    let file: string
    if (kimi) {
      const dir = join(home, '.kimi-code', 'sessions', 'workspace', id)
      mkdirSync(join(dir, 'agents', 'main'), { recursive: true })
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ cwd: project }))
      file = join(dir, 'agents', 'main', 'wire.jsonl')
      writeFileSync(file, JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: nowSec * 1000 }) + '\n'
        + JSON.stringify({ type: 'context.append_loop_event', time: nowSec * 1000, event: { type: 'step.begin', step: 1 } }) + '\n')
    } else {
      file = join(codexDir, `${id}.jsonl`)
      writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd: project, model_provider: 'openai' } }) + '\n'
        + JSON.stringify({ type: 'event_msg', timestamp: new Date(nowSec * 1000).toISOString(), payload: { type: 'task_started', turn_id: 'r-1' } }) + '\n')
      if (i === 1) appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date(nowSec * 1000).toISOString(),
        payload: { type: 'task_complete', turn_id: 'r-1', last_agent_message: '做完:合成回执' } }) + '\n')
      if (registered) digest.note(agent, id, file, 'codex-rollout')
      else put.run(id, file)
    }
    if (i < richSources && !kimi) appendFileSync(file, Array.from({ length: 1000 }, (_, n) => JSON.stringify({ type: 'response_item', timestamp: new Date(nowSec * 1000).toISOString(),
      payload: { type: 'custom_tool_call_output', turn_id: 'r-1', call_id: `c-${n}`, output: 'ok' } })).join('\n') + '\n')
    const task = await tasks.create({ title: `Synthetic ${i}`, projectId: 'qa', status: 'doing', assignee: agent, links: [{ agent, session_id: id }] })
    await tasks.update(task.id!, { dispatch: { family: agent, hand: 'cli', status: 'running', cwd: project, session_id: id, started_at: new Date(nowSec * 1000).toISOString() } })
  }
  db.close()
  const stats = new Map<string, { calls: number, ms: number }>()
  const wrap = <T extends (...args: never[]) => unknown>(label: string, fn: T): T => ((...args: Parameters<T>) => {
    const started = performance.now()
    const done = () => { const row = stats.get(label) ?? { calls: 0, ms: 0 }; row.calls++; row.ms += performance.now() - started; stats.set(label, row) }
    try {
      const result = fn(...args)
      if (result !== null && typeof result === 'object' && 'then' in result) return (result as Promise<unknown>).finally(done)
      done(); return result
    } catch (error) { done(); throw error }
  }) as T
  const measuredTasks = { ...tasks, list: wrap('tasks.list', tasks.list.bind(tasks)), recordReceipt: wrap('tasks.recordReceipt', tasks.recordReceipt.bind(tasks)) }
  const measuredProjects = { ...projects, getProjectsState: wrap('projects.getProjectsState', projects.getProjectsState.bind(projects)) }
  const measuredDigest = { ...digest, files: wrap('sessionDigest.files', digest.files.bind(digest)) }
  const measuredLog = { ...jobLog, events: wrap('jobLog.events', jobLog.events.bind(jobLog)), append: wrap('jobLog.append', jobLog.append.bind(jobLog)) }
  const authorization = { isAllowed: wrap('authorization.isAllowed', async () => true), denialMessage: () => 'denied' }
  server = await startWorkbenchServer({ port: 0, tickIntervalMs: 0, heartbeatMs: 0, service, tasks: measuredTasks as never, jobLog: measuredLog as never,
    projects: measuredProjects as never, sessionDigest: measuredDigest as never, authorization: authorization as never, paths: { home, config: {} } as never })
  const fetchState = async () => { const response = await fetch(`${server!.url}/state`); expect(response.status).toBe(200); return response.json() }
  // 8791 第六轮:/state 不再触发对账 —— 用 reconcileNow(验收/排障口)先对到稳态
  // (冷解析限拍 4/拍,12 个冷来源要几拍);后面的 /state 测的就是「只读快照」这条新路。
  for (let i = 0; i < 4; i++) await server!.reconcileNow?.()
  const topOf = (profile: Profiler.Profile) =>
    profile.nodes.map(node => ({ function: node.callFrame.functionName, file: node.callFrame.url.split('/').at(-1), hits: node.hitCount ?? 0 }))
      .filter(node => node.hits > 0).sort((a, b) => b.hits - a.hits).slice(0, 15)
  const coldProfiler = new Session(); coldProfiler.connect(); await coldProfiler.post('Profiler.enable'); await coldProfiler.post('Profiler.start')
  const coldAt = performance.now(), coldCpuAt = process.cpuUsage(); const first = await fetchState(); const coldMs = performance.now() - coldAt
  const coldCpu = process.cpuUsage(coldCpuAt), coldProfile = (await coldProfiler.post('Profiler.stop')).profile
  coldProfiler.disconnect()
  expect(first.execution.items).toHaveLength(12)
  expect(first.running.count).toBe(11)
  expect(first.execution.items.some((item: { sources: { provider?: string, transport?: string }[] }) =>
    item.sources.some(source => source.provider === 'kimi' && source.transport === 'kimi-wire'))).toBe(true)
  const coldStats = Object.fromEntries(stats)
  stats.clear()
  const profiler = new Session(); profiler.connect(); await profiler.post('Profiler.enable'); await profiler.post('Profiler.start')
  const wallAt = performance.now(), cpuAt = process.cpuUsage()
  for (let i = 0; i < 4; i++) await fetchState()
  const wallMs = performance.now() - wallAt, cpu = process.cpuUsage(cpuAt)
  const { profile } = await profiler.post('Profiler.stop')
  profiler.disconnect()
  console.log('PERF_DIAGNOSTIC', JSON.stringify({ coldMs, coldCpuMs: (coldCpu.user + coldCpu.system) / 1000, coldStats, coldTop: topOf(coldProfile),
    warmFourWallMs: wallMs, warmFourCpuMs: (cpu.user + cpu.system) / 1000,
    stats: Object.fromEntries(stats), top: topOf(profile), jobsBytes: statSync(jobsFile).size, sourceEvents: Math.min(richSources, 8) * 1000, sourceCount: 12 }))
  expect(stats.get('jobLog.append')?.calls ?? 0).toBeLessThan(20)
  expect(stats.get('tasks.recordReceipt')?.calls ?? 0).toBe(0)
  expect(coldStats['jobLog.append']?.ms).toBeLessThan(200)
}, 60000)
