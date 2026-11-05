// @vitest-environment node
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import type { WorkbenchState } from '../src/protocol.ts'
const dirs: string[] = [], servers: WorkbenchServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllEnvs() })
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'execution-http-')); dirs.push(home)
  const cwd = join(home, 'project'); mkdirSync(cwd)
  const root = join(home, '.codex'), sessionDir = join(root, 'sessions', '2026', '10', '26'); mkdirSync(sessionDir, { recursive: true })
  vi.stubEnv('CODEX_HOME', root)
  let seconds = Date.parse('2026-10-26T08:00:00Z') / 1000, allowed = true
  const refs: { agent: string, session_id: string, file: string, format: 'codex-rollout' | 'kimi-wire' }[] = []
  const tasksFile = join(home, 'tasks.json'), jobsFile = join(home, 'jobs.jsonl')
  let tasks = createTasksService({ file: tasksFile, now: () => seconds }), jobLog = createJobLog({ file: jobsFile, now: () => new Date(seconds * 1000) })
  const service = createWorkbenchService({ now: () => seconds })
  async function open() {
    const s = await startWorkbenchServer({ port: 0, tickIntervalMs: 0, heartbeatMs: 0, service, tasks, jobLog, paths: { home, config: {} } as never,
      authorization: { isAllowed: async () => allowed, denialMessage: () => '未授权' } as never, sessionDigest: { files: () => refs } as never, projects: { getProjectsState: async () => ({ projects: [{ id: 'qa', name: 'QA', path: cwd }] }) } as never })
    servers.push(s); return s
  }
  let server = await open()
  const at = () => new Date(seconds * 1000).toISOString()
  function event(id: string, type: string, round: string, text?: string) {
    appendFileSync(refs.find(one => one.session_id === id)!.file, JSON.stringify({ type: 'event_msg', timestamp: at(), payload: { type, turn_id: round, ...(text === undefined ? {} : { last_agent_message: text }) } }) + '\n')
  }
  function source(id: string, provider: string) {
    const file = join(sessionDir, `${id}.jsonl`)
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd, model_provider: provider } }) + '\n')
    refs.push({ agent: 'codex', session_id: id, file, format: 'codex-rollout' }); event(id, 'task_started', 'r-1'); return file
  }
  async function task(ids: string[], agent: 'codex' | 'kimi' = 'codex') {
    const made = await tasks.create({ title: '图谱返修', projectId: 'qa', assignee: 'codex', status: 'doing', links: ids.map(session_id => ({ agent, session_id })) })
    await tasks.update(made.id!, { dispatch: { family: agent, hand: 'cli', status: 'running', cwd, session_id: ids[0]!, started_at: at() } }); return made.id!
  }
  async function get(path: string) { const res = await fetch(server.url + path); expect(res.status).toBe(200); return res.json() }
  async function post(path: string, data: unknown) {
    const res = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' }, body: JSON.stringify(data) }); expect(res.status).toBe(200); return res.json()
  }
  function nativeSource(id: string) {
    const dir = join(home, '.kimi-code', 'sessions', 'qa-workspace', id)
    mkdirSync(join(dir, 'agents', 'main'), { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ cwd }))
    const file = join(dir, 'agents', 'main', 'wire.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: seconds * 1000 }) + '\n')
    refs.push({ agent: 'kimi', session_id: id, file, format: 'kimi-wire' })
    return (type: string, extra: object = {}) => appendFileSync(file, JSON.stringify({ type: 'context.append_loop_event', time: seconds * 1000, event: { type, ...extra } }) + '\n')
  }
  return { home, service, task, source, nativeSource, event, get, post, url: () => server.url, broadcast: () => server.broadcastState(),
    taskFile: tasksFile, nowSec: () => seconds, createGoal: () => tasks.createGoal({ title: 'QA唯一目标' }),
    createBacklog: () => tasks.create({ title: '还没派出的事项', assignee: 'codex', status: 'backlog' }),
    createImported: (status: 'done' | 'blocked' | 'confirm', sessionId: string) => tasks.create({ title: `历史导入 ${status}`, projectId: 'qa', status,
      source: { kind: 'session' }, links: [{ agent: 'codex', session_id: sessionId }] }),
    rawTask: async (id: string) => (await tasks.list()).tasks.find(one => one.id === id), directMove: (id: string, status: 'confirm' | 'done') => tasks.move(id, status),
    /*
     * 8791 第六轮(2026-10-29):/state 与 /collab/* 读路都不再触发对账,只读上一次对账快照。
     * snapshot() 先用 server.reconcileNow()(验收/排障口,合并进在途那一拍、链式等补拍落地)
     * 推进对账再取 /state。「谁触发对账」的契约由 tests/execution-reconcile-hot6-1029.test.ts 钉死;
     * 这本账管对账语义(回执 / 轮次 / 重放)。
     */
    reconcile: async () => { await server.reconcileNow?.() },
    snapshot: async () => {
      await server.reconcileNow?.()
      return await get('/state') as WorkbenchState
    },
    moveRef: (id: string, file: string) => { const ref = refs.find(one => one.session_id === id); if (ref !== undefined) ref.file = file },
    tick: () => { seconds += 10 }, revoke: (value: boolean) => { allowed = !value },
    restart: async () => { await server.close(); servers.splice(servers.indexOf(server), 1); await jobLog.flush(); tasks = createTasksService({ file: tasksFile, now: () => seconds }); jobLog = createJobLog({ file: jobsFile, now: () => new Date(seconds * 1000) }); await jobLog.load(); server = await open() },
    events: () => jobLog.all(), jobs: () => readFileSync(jobsFile, 'utf8') }
}
describe('公共执行事实真实 HTTP 生命周期', () => {
  it.each([['blocked', '卡住:第二来源也受阻'], ['done', '做完:第二来源已交付']] as const)(
    '双来源旧阻塞回执加较晚 %s 交回：重复 HTTP、live 与重启不循环重开', async (_kind, reply) => {
      const f = await fixture()
      f.source('session-first', 'openai'); f.source('session-second', 'openai')
      const id = await f.task(['session-first', 'session-second'])
      await f.snapshot()
      f.tick(); f.event('session-second', 'task_complete', 'r-1', '卡住:较早的第二来源受阻')
      f.tick(); f.event('session-first', 'task_started', 'r-2')
      f.tick(); f.event('session-first', 'task_complete', 'r-2', reply)
      const first = await f.snapshot()
      const card = first.tasks?.tasks.find(task => task.id === id)
      expect(card).toMatchObject({ status: 'blocked', receipt: { kind: 'blocked', source_session_id: 'session-second' } })
      expect(card?.receipts).toHaveLength(2)
      const transitions = card?.transitions?.length
      const events = f.events().length
      const mtime = statSync(f.taskFile, { bigint: true }).mtimeNs
      const bytes = readFileSync(f.taskFile)
      const ws = new WebSocket(f.url().replace('http:', 'ws:') + '/live')
      try {
        await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
        await new Promise<void>((resolve, reject) => { ws.once('message', () => resolve()); ws.once('error', reject) })
        await Promise.all([f.snapshot(), f.get(`/collab/runs?task_id=${id}`), f.snapshot()])
        const next = new Promise<void>((resolve, reject) => { ws.once('message', () => resolve()); ws.once('error', reject) })
        f.broadcast(); await next
      } finally { ws.close() }
      await f.restart()
      const after = await f.snapshot()
      expect(after.tasks?.tasks.find(task => task.id === id)?.status).toBe('blocked')
      expect(after.tasks?.tasks.find(task => task.id === id)?.round).toBe(card?.round)
      expect(after.tasks?.tasks.find(task => task.id === id)?.transitions).toHaveLength(transitions!)
      expect(statSync(f.taskFile, { bigint: true }).mtimeNs).toBe(mtime)
      expect(readFileSync(f.taskFile).equals(bytes)).toBe(true)
      expect(f.events()).toHaveLength(events)
      expect(after.execution?.items[0]?.state).toBe('blocked')
    }, 30_000)

  it('双来源旧阻塞后第二来源确实开新轮，正在执行要重开且业务数仍为一件', async () => {
    const f = await fixture()
    f.source('session-first', 'openai'); f.source('session-second', 'openai')
    const id = await f.task(['session-first', 'session-second'])
    await f.snapshot()
    f.tick(); f.event('session-first', 'task_complete', 'r-1', '卡住:第一来源受阻')
    f.tick(); f.event('session-second', 'task_complete', 'r-1', '卡住:第二来源受阻')
    expect((await f.snapshot()).tasks?.tasks.find(task => task.id === id)?.status).toBe('blocked')
    f.tick(); f.event('session-second', 'task_started', 'r-2')
    const active = await f.snapshot()
    expect(active.tasks?.tasks.find(task => task.id === id)?.status).toBe('doing')
    expect(active.execution?.observed_running_tasks).toBe(1)
    expect(active.running?.count).toBe(1)
  })

  it('较晚来源在两次观察间开工并交回，仍记录一次真实重开和新回执', async () => {
    const f = await fixture()
    f.source('session-first', 'openai')
    const id = await f.task(['session-first', 'session-second'])
    await f.snapshot()
    f.tick(); f.event('session-first', 'task_complete', 'r-1', '卡住:第一来源受阻')
    expect((await f.snapshot()).tasks?.tasks.find(task => task.id === id)?.status).toBe('blocked')
    f.tick(); f.source('session-second', 'openai')
    f.tick(); f.event('session-second', 'task_complete', 'r-1', '卡住:第二来源也受阻')
    const returned = await f.snapshot()
    const card = returned.tasks?.tasks.find(task => task.id === id)
    expect(card?.receipts).toHaveLength(2)
    expect(card?.transitions?.map(one => `${one.from}>${one.to}`)).toEqual(['doing>blocked', 'blocked>doing', 'doing>blocked'])
    expect((await f.snapshot()).tasks?.tasks.find(task => task.id === id)?.transitions).toHaveLength(3)
  })

  it('双来源旧阻塞与已保存的新回执，较晚来源失联后仍标未知且不重写事项', async () => {
    const f = await fixture()
    const laterFile = f.source('session-later', 'openai'); f.source('session-earlier', 'openai')
    const id = await f.task(['session-later', 'session-earlier'])
    await f.snapshot()
    f.tick(); f.event('session-earlier', 'task_complete', 'r-1', '卡住:较早来源受阻')
    f.tick(); f.event('session-later', 'task_started', 'r-2')
    f.tick(); f.event('session-later', 'task_complete', 'r-2', '做完:较晚来源交付')
    expect((await f.snapshot()).tasks?.tasks.find(task => task.id === id)?.receipts).toHaveLength(2)
    rmSync(laterFile)
    const before = readFileSync(f.taskFile)
    const mtime = statSync(f.taskFile, { bigint: true }).mtimeNs
    for (let n = 0; n < 3; n++) {
      const state = await f.snapshot()
      expect(state.execution?.items[0]?.sources.find(source => source.session_id === 'session-later')).toMatchObject({ state: 'unknown', unknown: 'missing' })
      expect(state.execution?.complete).toBe(false)
      expect(state.running?.count).toBeUndefined()
      expect(state.tasks?.tasks.find(task => task.id === id)?.status).toBe('blocked')
    }
    await f.restart()
    expect((await f.snapshot()).running?.count).toBeUndefined()
    expect(readFileSync(f.taskFile).equals(before)).toBe(true)
    expect(statSync(f.taskFile, { bigint: true }).mtimeNs).toBe(mtime)
  })
  it('待排但还没有来源的事项不使已纳管运行数永远缺席', async () => {
    const f = await fixture(); f.source('session-active', 'openai'); await f.task(['session-active']); await f.createBacklog()
    const state = await f.snapshot()
    expect(state.execution?.observed_running_tasks).toBe(1)
    expect(state.running?.count).toBe(1)
  })
  it('CODEX_HOME 中途变了:执行定位 hint 按新 home 重建,不沿用旧 home 的缓存定位器', async () => {
    const f = await fixture()
    f.source('session-move', 'openai')
    const id = await f.task(['session-move'])
    const first = await f.snapshot()
    expect(first.execution?.items.find(item => item.task_id === id)?.sources[0]?.state).toBe('running')
    // 同一 session 原件迁到另一个 CODEX_HOME(同一项目 cwd),新原件上已收尾。
    const rootB = join(f.home, 'codex-home-b'), dirB = join(rootB, 'sessions', '2026', '10', '26')
    mkdirSync(dirB, { recursive: true })
    const fileB = join(dirB, 'session-move.jsonl')
    const at = new Date(f.nowSec() * 1000).toISOString()
    writeFileSync(fileB, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'session-move', cwd: join(f.home, 'project'), model_provider: 'openai' } }),
      JSON.stringify({ type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: 'r-1' } }),
      JSON.stringify({ type: 'event_msg', timestamp: at, payload: { type: 'task_complete', turn_id: 'r-1', last_agent_message: '做完:迁过去的原件' } }),
    ].join('\n') + '\n')
    f.moveRef('session-move', fileB)
    vi.stubEnv('CODEX_HOME', rootB)
    // 旧实现:服务端 codexExecutionLookup 在 home A 建过,??= 短路使 home 变更不被发现,
    // 全量校验仍拿 A 的 sessions 根拦 B 的文件 → 来源变 unknown;修了之后按 B 解析到交回。
    const second = await f.snapshot()
    expect(second.execution?.items.find(item => item.task_id === id)?.sources[0]).toMatchObject({ state: 'returned', provider: 'codex' })
    expect(second.tasks?.tasks.find(task => task.id === id)?.receipts).toHaveLength(1)
  })
  it('大原件并发读取仍能在状态请求内给出同一业务执行数', async () => {
    const f = await fixture()
    const ids = Array.from({ length: 30 }, (_, index) => `session-large-${index}`)
    for (const id of ids) {
      const file = f.source(id, 'openai')
      appendFileSync(file, (JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol', padding: 'x'.repeat(900) } }) + '\n').repeat(7500))
    }
    await f.task(ids)
    // 冷解析限速 4/拍(8791 第四轮):30 个大原件冷启动一拍只消化 4 个,先分拍预热进缓存,再测并发稳态读。
    for (let i = 0; i < 8; i++) await f.snapshot()
    const first = await f.snapshot()
    expect(first.running?.count).toBe(1)
    const start = performance.now()
    const states = await Promise.all(Array.from({ length: 4 }, () => f.snapshot()))
    const elapsed = performance.now() - start
    expect(states.every(state => state.running?.count === 1)).toBe(true)
    expect(elapsed).toBeLessThan(1200)
  }, 30000)
  it('超过缓存预算的稳定来源不因固定顺序淘汰而每拍全量重读，单源追加不拖全批', async () => {
    const f = await fixture()
    const ids = Array.from({ length: 40 }, (_, index) => `session-over-budget-${index}`)
    const files = ids.map(id => {
      const file = f.source(id, 'openai')
      appendFileSync(file, (JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-sol', padding: 'x'.repeat(900) } }) + '\n').repeat(7500))
      return file
    })
    await f.task(ids)
    // 冷解析限速 4/拍(8791 第四轮):40 个原件超过内存缓存预算(32),先分拍预热让落盘账本兜住被挤出的来源,
    // 稳态下被挤出走落盘续跑(不占冷解析额度),再测读预算与单源追加。
    for (let i = 0; i < 12; i++) await f.snapshot()
    expect((await f.snapshot()).running?.count).toBe(1)
    const start = performance.now()
    const stable = await Promise.all(Array.from({ length: 4 }, () => f.snapshot()))
    const stableMs = performance.now() - start
    expect(stable.every(state => state.running?.count === 1)).toBe(true)
    expect(stableMs).toBeLessThan(1600)
    appendFileSync(files[0]!, JSON.stringify({ type: 'event_msg', timestamp: new Date(f.nowSec() * 1000).toISOString(), payload: { type: 'agent_message', turn_id: 'r-1', message: '继续处理' } }) + '\n')
    const changedAt = performance.now()
    const changed = await Promise.all(Array.from({ length: 4 }, () => f.snapshot()))
    expect(changed.every(state => state.running?.count === 1)).toBe(true)
    expect(changed[0]?.execution?.items[0]?.sources.find(source => source.session_id === ids[0])?.rounds.at(-1)?.kind).toBe('updated')
    expect(performance.now() - changedAt).toBeLessThan(1600)
    f.revoke(true)
    const denied = await f.snapshot()
    expect(denied.running?.count).toBeUndefined()
    expect(denied.execution?.items[0]?.sources.every(source => source.unknown === 'denied')).toBe(true)
    f.revoke(false)
    expect((await f.snapshot()).running?.count).toBe(1)
    rmSync(files[0]!)
    const missing = await f.snapshot()
    expect(missing.execution?.items[0]?.sources.find(source => source.session_id === ids[0])?.unknown).toBe('missing')
    expect(missing.running?.count).toBeUndefined()
    const rebuild = (index: number) => writeFileSync(files[index]!, [
      { type: 'session_meta', payload: { id: ids[index], cwd: join(f.home, 'project'), model_provider: 'openai' } },
      { type: 'event_msg', timestamp: new Date(f.nowSec() * 1000).toISOString(), payload: { type: 'task_started', turn_id: 'r-1' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    rebuild(0)
    expect((await f.snapshot()).running?.count).toBe(1)
    appendFileSync(files[1]!, 'x'.repeat(8 * 1024 * 1024))
    const oversized = await f.snapshot()
    expect(oversized.execution?.items[0]?.sources.find(source => source.session_id === ids[1])?.unknown).toBe('oversized')
    expect(oversized.running?.count).toBeUndefined()
    rebuild(1)
    expect((await f.snapshot()).running?.count).toBe(1)
  }, 30000)
  it('多轮实质事件已入账后，重复状态请求不会再按全量来源事件重放', async () => {
    const f = await fixture(), file = f.source('session-event-rich', 'openai')
    await f.task(['session-event-rich'])
    appendFileSync(file, Array.from({ length: 2500 }, (_, index) => JSON.stringify({ type: 'response_item', timestamp: new Date(f.nowSec() * 1000).toISOString(),
      payload: { type: 'custom_tool_call_output', turn_id: 'r-1', call_id: `call-${index}`, output: 'ok' } })).join('\n') + '\n')
    expect((await f.snapshot()).running?.count).toBe(1)
    const start = performance.now()
    const states = await Promise.all(Array.from({ length: 4 }, () => f.snapshot()))
    expect(states.every(state => state.running?.count === 1)).toBe(true)
    expect(performance.now() - start).toBeLessThan(1500)
  }, 30000)
  it('来源事件超过账本保留上限后，重复状态请求不反复回填旧事件', async () => {
    const f = await fixture(), file = f.source('session-long-history', 'openai')
    await f.task(['session-long-history'])
    appendFileSync(file, Array.from({ length: 5200 }, (_, index) => JSON.stringify({ type: 'response_item', timestamp: new Date(f.nowSec() * 1000).toISOString(),
      payload: { type: 'custom_tool_call_output', turn_id: 'r-1', call_id: `call-${index}`, output: 'ok' } })).join('\n') + '\n')
    expect((await f.snapshot()).running?.count).toBe(1)
    const before = f.jobs().length
    const oldest = f.events()[0]?.source_event_id
    expect((await f.snapshot()).running?.count).toBe(1)
    expect(f.jobs().length).toBe(before)
    expect(f.events()[0]?.source_event_id).toBe(oldest)
  }, 30000)
  it('HTTP 当前业务数不被已停留在待验、受阻、办完的历史 session 卡永久污染', async () => {
    const f = await fixture()
    const old = await Promise.all(['done', 'blocked', 'confirm'].map((status, index) =>
      f.createImported(status as 'done' | 'blocked' | 'confirm', `old-import-${index}`)))
    f.source('new-worker', 'openai')
    const id = await f.task(['new-worker'])
    const state = await f.snapshot()
    expect(state.execution?.complete).toBe(true)
    expect(state.running).toMatchObject({ count: 1, observed_count: 1, items: [{ task_id: id, text: '图谱返修' }] })
    expect(state.running?.excluded?.map(item => item.task_id)).toEqual(old.map(item => item.id))
    expect(state.running?.excluded?.every(item => item.sources?.[0]?.unknown === 'missing')).toBe(true)
    await f.restart()
    expect((await f.snapshot()).running?.count).toBe(1)
  })
  it('热缓存每拍重新授权，追加、截断重建、撤权、失联及重启均取当前原件；等确认的安静卡不再每拍重读', async () => {
    const f = await fixture(), file = f.source('session-changing', 'openai')
    const id = await f.task(['session-changing'])
    expect((await f.snapshot()).running?.count).toBe(1)
    expect((await f.snapshot()).running?.count).toBe(1)
    f.tick(); f.event('session-changing', 'task_complete', 'r-1', '做完:第一轮')
    expect((await f.snapshot()).execution?.items[0]?.state).toBe('awaiting_review')
    // 8791 第六轮:等确认且有回执 = 安静卡 —— 撤权不再每拍重读,维持上次观察;任务账来一个事件才重读一次。
    f.revoke(true)
    expect((await f.snapshot()).execution?.items[0]?.sources[0]).toMatchObject({ state: 'returned' })
    await f.post('/task/receipt', { id, receipt: 'done', text: '做完:第一轮', by: 'codex', source_session_id: 'session-changing', source_round: 'r-1b', task_round: 1 })
    expect((await f.snapshot()).execution?.items[0]?.sources[0]).toMatchObject({ state: 'unknown', unknown: 'denied' })
    f.revoke(false)
    f.tick()
    writeFileSync(file, [
      { type: 'session_meta', payload: { id: 'session-changing', cwd: join(f.home, 'project'), model_provider: 'openai' } },
      { type: 'event_msg', timestamp: new Date(f.nowSec() * 1000).toISOString(), payload: { type: 'task_started', turn_id: 'r-2' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    // 安静卡靠任务事件唤醒(改卡);tick 让 updated_at 前进、签名才有差。戳醒后卡回 doing,之后每拍照常读。
    await f.post('/task/update', { id, desc: '原件重建成 r-2 了' })
    expect((await f.snapshot()).execution?.items[0]).toMatchObject({ state: 'running', sources: [{ task_round: 2, state: 'running' }] })
    rmSync(file)
    expect((await f.snapshot()).execution?.items[0]?.sources[0]).toMatchObject({ state: 'unknown', unknown: 'missing' })
    writeFileSync(file, [
      { type: 'session_meta', payload: { id: 'session-changing', cwd: join(f.home, 'project'), model_provider: 'openai' } },
      { type: 'event_msg', timestamp: new Date(f.nowSec() * 1000).toISOString(), payload: { type: 'task_started', turn_id: 'r-2' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    await f.restart()
    const restarted = await f.snapshot()
    expect(restarted.running?.items).toMatchObject([{ task_id: id }])
    expect(restarted.execution?.items[0]?.sources[0]).toMatchObject({ state: 'running', task_round: 2 })
  })
  it('来源重建时旧事件前插入的新实质事件也必须入账', async () => {
    const f = await fixture(), file = f.source('session-insert-before-old', 'openai')
    await f.task(['session-insert-before-old'])
    const old = JSON.stringify({ type: 'response_item', timestamp: new Date(f.nowSec() * 1000).toISOString(),
      payload: { type: 'custom_tool_call_output', turn_id: 'r-1', call_id: 'old', output: 'ok' } })
    appendFileSync(file, `${old}\n`)
    await f.snapshot()
    expect(f.events().filter(event => event.step === 'updated')).toHaveLength(1)
    const rows = readFileSync(file, 'utf8').trim().split('\n')
    const inserted = JSON.stringify({ type: 'response_item', timestamp: new Date(f.nowSec() * 1000).toISOString(),
      payload: { type: 'custom_tool_call_output', turn_id: 'r-1', call_id: 'new', output: 'ok' } })
    writeFileSync(file, [rows[0], rows[1], inserted, rows[2]].join('\n') + '\n')
    await f.snapshot()
    expect(f.events().filter(event => event.step === 'updated')).toHaveLength(2)
  })
  it('建卡入口的明确协调角色与来源角色持久进入同一执行契约', async () => {
    const f = await fixture(); f.source('session-create-coordinator', 'openai')
    const created = await f.post('/task/create', { title: '协调会话', status: 'doing', project_id: 'qa', assignee: 'codex',
      execution_role: 'coordination', links: [{ agent: 'codex', session_id: 'session-create-coordinator', execution_role: 'coordination' }] })
    const state = await f.snapshot()
    expect(state.execution?.items.find(one => one.task_id === created.id)).toMatchObject({ role: 'coordination', role_origin: 'user',
      sources: [{ role: 'coordination', role_origin: 'user', state: 'running' }] })
    expect(state.running?.count).toBe(0)
    await f.restart()
    expect((await f.snapshot()).execution?.items.find(one => one.task_id === created.id)?.role).toBe('coordination')
  })
  it('第一次观察被拒，允许后即使原始开工早于拒绝观察也恢复真实执行', async () => {
    const f = await fixture(); f.source('session-first-denied', 'openai'); f.tick()
    // 8791 第六轮:对账事件驱动且合并 —— 撤权落在建卡之前,reconcileNow 推进的那一拍就是「第一次观察」,确定性被拒。
    f.revoke(true)
    const id = await f.task(['session-first-denied'])
    await f.reconcile()
    expect((await f.get(`/collab/runs?task_id=${id}`)).runs.at(-1).status).toBe('unknown')
    f.tick(); f.revoke(false)
    await f.reconcile()
    const runs = (await f.get(`/collab/runs?task_id=${id}`)).runs
    expect(runs.find((one: { current?: boolean }) => one.current)?.status).toBe('running')
  })
  it('同事项双来源去重，运输格式不混提供方，统筹散会话不计业务执行', async () => {
    const f = await fixture(), file = f.source('session-sol', 'openai'); f.source('session-kimi', 'moonshot'); const id = await f.task(['session-sol', 'session-sol', 'session-kimi'])
    f.service.applyEvent({ agent: 'codex', session_id: 'coordinator-session', type: 'running', ts: Date.now() / 1000 })
    const state = await f.snapshot()
    expect(state.execution).toMatchObject({ scope: 'linked_tasks', observed_running_tasks: 1, observed_running_sessions: 2, complete: true })
    expect(state.execution?.items).toMatchObject([{ task_id: id, title: '图谱返修', state: 'running', sources: [{ provider: 'codex' }, { provider: 'kimi' }] }])
    expect(state.execution?.items[0]?.sources).toHaveLength(2)
    expect(state.running).toMatchObject({ count: 1, items: [{ task_id: id, text: '图谱返修' }] }); expect(state.running?.items).toHaveLength(1)
    expect(state.butler_inbox?.executing).toBe(1)
    expect(JSON.stringify(state.execution)).not.toContain(file)
    const n = f.events().length; await f.snapshot(); expect(f.events()).toHaveLength(n)
    f.tick(); f.event('session-sol', 'task_complete', 'r-1', '做完:第一份交付')
    const partial = await f.snapshot()
    expect(partial.tasks?.tasks[0]?.status).toBe('doing'); expect(partial.execution?.items[0]?.state).toBe('running'); expect(partial.tasks?.tasks[0]?.receipts).toHaveLength(1)
    expect((await f.get(`/collab/runs?task_id=${id}`)).runs).toEqual(expect.arrayContaining([expect.objectContaining({ session_id: 'session-kimi', status: 'running' })]))
  })
  it('旧交回不能盖掉退回，新轮实做、独立回执与重启重放均保留', async () => {
    const f = await fixture(); f.source('session-kimi', 'moonshot'); const id = await f.task(['session-kimi'])
    await f.snapshot(); f.tick(); f.event('session-kimi', 'task_complete', 'r-1', '做完:第一轮')
    expect((await f.snapshot()).execution?.items[0]?.state).toBe('awaiting_review')
    f.tick(); await f.post('/task/move', { id, status: 'doing' }); const returned = await f.snapshot()
    expect(returned.tasks?.tasks[0]).toMatchObject({ status: 'doing', round: 2 }); expect(returned.execution?.items[0]?.state).toBe('rework')
    f.tick(); f.event('session-kimi', 'task_started', 'r-2'); expect((await f.snapshot()).execution?.items[0]).toMatchObject({ state: 'running', task_round: 2 })
    f.tick(); f.event('session-kimi', 'task_complete', 'r-2', '卡住:缺少必要材料'); expect((await f.snapshot()).execution?.items[0]?.state).toBe('blocked')
    const before = f.events().length; await f.restart(); const restarted = await f.snapshot()
    expect(restarted.tasks?.tasks[0]?.receipts).toHaveLength(2); expect(restarted.execution?.items[0]?.state).toBe('blocked'); expect(f.events()).toHaveLength(before); expect(f.jobs()).not.toContain('必要材料')
  })
  it('撤权恢复通过直接运行接口刷新，事件先持久再回包', async () => {
    const f = await fixture(); f.source('session-revoke', 'openai'); const id = await f.task(['session-revoke']); await f.snapshot(); f.tick(); f.revoke(true)
    // 8791 第六轮第 3 轮:读路不再触发对账 —— 「直接运行接口」= reconcileNow(验收/排障口);
    // 撤权这类非任务账变化也靠它(或 30 秒到期)才被重新观察到。
    await f.reconcile()
    expect((await f.get(`/collab/runs?task_id=${id}`)).runs.at(-1).status).toBe('unknown')
    expect((await f.snapshot()).execution?.items[0]?.sources[0]).toMatchObject({ state: 'unknown', unknown: 'denied' })
    f.tick(); f.revoke(false); await f.reconcile(); expect((await f.get(`/collab/runs?task_id=${id}`)).runs.at(-1).status).toBe('running')
    f.tick(); f.revoke(true); await f.reconcile(); expect((await f.get(`/collab/runs?task_id=${id}`)).runs.at(-1).status).toBe('unknown'); expect(f.jobs()).toContain('source_unknown')
  })
  it('缺失、过大、元数据、歧义明确未知，不以doing或PID补执行', async () => {
    const f = await fixture(), file = f.source('session-unknown', 'openai'); await f.task(['session-unknown'])
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'session-unknown', cwd: join(f.home, 'project'), model_provider: 'openai' } }) + '\n')
    expect((await f.snapshot()).execution).toMatchObject({ complete: false, observed_running_tasks: 0 }); expect((await f.snapshot()).running?.count).toBeUndefined()
    expect((await f.snapshot()).butler_inbox?.executing).toBeUndefined()
    appendFileSync(file, 'x'.repeat(8 * 1024 * 1024 + 1)); expect((await f.snapshot()).execution?.items[0]?.sources[0]?.unknown).toBe('oversized')
    rmSync(file); expect((await f.snapshot()).execution?.items[0]?.sources[0]?.unknown).toBe('missing')
    await f.task(['session-unknown']); expect((await f.snapshot()).execution?.items.every(item => item.sources[0]?.unknown === 'ambiguous_link')).toBe(true)
  })
  it('原生Kimi读取已登记的主agent原件，真实step开工和返修交回独立于桌面blocked标签', async () => {
    const f = await fixture(), wire = f.nativeSource('session-native-kimi')
    const id = await f.task(['session-native-kimi'], 'kimi')
    wire('step.begin', { step: 1 })
    expect((await f.snapshot()).execution?.items[0]).toMatchObject({ state: 'running', sources: [{ provider: 'kimi', transport: 'kimi-wire' }] })
    f.tick(); wire('content.part', { part: { type: 'text', text: '做完:原生Kimi交回' } }); wire('step.end', { finishReason: 'end_turn' })
    expect((await f.snapshot()).execution?.items[0]?.state).toBe('awaiting_review')
    f.tick(); await f.post('/task/move', { id, status: 'doing' })
    expect((await f.snapshot()).execution?.items[0]?.state).toBe('rework')
    f.tick(); wire('step.begin', { step: 1 })
    expect((await f.snapshot()).execution?.items[0]?.state).toBe('running')
  })

  it('卡片被过早写成完成时，仍在运行的原件不会投影成已完成', async () => {
    const f = await fixture(); f.source('session-premature', 'moonshot'); const id = await f.task(['session-premature'])
    expect((await f.directMove(id, 'confirm')).ok).toBe(true)
    expect((await f.directMove(id, 'done')).ok).toBe(true)
    const state = await f.snapshot()
    expect(state.tasks?.tasks[0]?.status).toBe('done')
    expect(state.execution?.items[0]).toMatchObject({ state: 'running', sources: [{ state: 'running' }] })
    expect(state.execution?.observed_running_tasks).toBe(1)
    expect(state.running?.count).toBe(1)
    await f.restart()
    expect((await f.snapshot()).execution?.items[0]?.state).toBe('running')
    /*
     * 8791 第六轮第 3 轮(退修):收场卡签名不变 = 一律安静 —— 撤权与纯来源活动都不再每拍重读,
     * 维持上次观察;任务账来一个事件(这里用 /task/update 改卡)才唤醒重读一次。
     */
    f.revoke(true)
    expect((await f.snapshot()).execution?.items[0]?.state).toBe('running')
    f.tick(); await f.post('/task/update', { id, desc: '核一遍来源' })
    expect((await f.snapshot()).execution?.items[0]).toMatchObject({ state: 'unknown', sources: [{ unknown: 'denied' }] })
    f.revoke(false); f.tick(); f.event('session-premature', 'task_complete', 'r-1', '中途摘要，没有正式交回')
    f.tick(); await f.post('/task/update', { id, desc: '又核了一遍' })
    expect((await f.snapshot()).execution?.items[0]?.state).toBe('unknown')
    f.tick(); f.event('session-premature', 'task_started', 'r-2')
    f.tick(); f.event('session-premature', 'task_complete', 'r-2', '做完:正式交回')
    f.tick(); await f.post('/task/update', { id, desc: '正式交回到了' })
    expect((await f.snapshot()).execution?.items[0]?.state).toBe('completed')
  })

  it('明确来源回执覆盖同轮未关闭的原件，不能被仍在running的缓存冲回doing', async () => {
    const f = await fixture(); f.source('session-report', 'openai'); const id = await f.task(['session-report'])
    await f.snapshot(); f.tick()
    await f.post('/task/receipt', { id, receipt: 'blocked', text: '卡住:材料缺失', by: 'codex', source_session_id: 'session-report', source_round: 'r-1' })
    expect((await f.snapshot()).execution?.items[0]?.state).toBe('blocked')
    f.tick(); f.event('session-report', 'task_started', 'r-2')
    expect((await f.snapshot()).execution?.items[0]?.state).toBe('running')
  })
  it('两次请求间完整跑完新轮仍会开启新事项轮，不能挤在上一次待验里', async () => {
    const f = await fixture(); f.source('session-fast', 'openai'); const id = await f.task(['session-fast'])
    f.tick(); f.event('session-fast', 'task_complete', 'r-1', '做完:第一轮'); await f.snapshot()
    f.tick(); f.event('session-fast', 'task_started', 'r-2'); f.tick(); f.event('session-fast', 'task_complete', 'r-2', '做完:返修轮')
    // 8791 第六轮:纯来源活动不再被每拍 /state 捞起;任务账来一个事件(改卡),下一拍对账把它读出来。
    await f.post('/task/update', { id, desc: '返修交回来了' })
    const result = await f.snapshot()
    expect(result.execution?.items[0]).toMatchObject({ task_round: 2, state: 'awaiting_review' })
    expect(result.tasks?.tasks[0]?.receipts?.map(one => one.task_round)).toEqual([1, 2])
  })

  it('首次观察跨过多个来源轮也保留旧回执，正文只进明确交回记录，不进执行投影', async () => {
    const f = await fixture(), file = f.source('session-history', 'openai'); await f.task(['session-history'])
    f.tick(); f.event('session-history', 'task_complete', 'r-1', '做完:旧轮专属结果')
    f.tick(); f.event('session-history', 'task_started', 'r-2')
    appendFileSync(file, JSON.stringify({ type: 'response_item', timestamp: '2026-10-26T08:00:20.000Z', payload: { type: 'custom_tool_call_output', output: 'private-source-body' } }) + '\n')
    const state = await f.snapshot()
    expect(state.tasks?.tasks[0]?.receipts).toMatchObject([{ source_round: 'r-1' }])
    expect(JSON.stringify(state.execution)).not.toContain('旧轮专属结果')
    expect(JSON.stringify(state.execution)).not.toContain('private-source-body')
    expect(JSON.stringify(state.execution)).not.toContain(file)
  })

  it('角色：真实singleOpenGoal自动挂卡仍未知，只有可信分类才计业务；重启保留', async () => {
    const f = await fixture(); f.source('session-manager', 'openai'); await f.createGoal()
    f.service.applyEvent({ agent: 'codex', session_id: 'session-manager', project: 'qa', type: 'running', title: '普通业务交付标题', ts: f.nowSec() })
    let autoId = ''
    await vi.waitFor(async () => {
      const state = await f.snapshot()
      const item = state.execution?.items.find(one => one.sources.some(source => source.session_id === 'session-manager'))
      expect(item).toBeDefined(); autoId = item!.task_id
    }, { interval: 10, timeout: 2000 })
    const automatic = await f.snapshot()
    expect(automatic.execution?.items[0]).toMatchObject({ role: 'unclassified', role_origin: 'automatic_session', state: 'running' })
    expect(automatic.running?.items).toEqual([]); expect(automatic.running?.count).toBeUndefined()
    expect(automatic.running?.excluded).toMatchObject([{ task_id: autoId, role: 'unclassified' }])
    const denied = await fetch(f.url() + '/task/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: autoId, execution_role: 'business' }) })
    expect(denied.status).toBe(403)
    const outside = await fetch(f.url() + '/task/update', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.invalid' }, body: JSON.stringify({ id: autoId, execution_role: 'business' }) })
    expect(outside.status).toBe(403)
    await f.post('/task/update', { id: autoId, execution_role: 'coordination' })
    const coordinator = await f.snapshot()
    expect(coordinator.execution?.items[0]).toMatchObject({ role: 'coordination', role_origin: 'user' })
    expect(coordinator.running?.count).toBe(0)
    expect((await f.get(`/collab/runs?task_id=${autoId}`)).runs.at(-1)).toMatchObject({ role: 'coordination', role_origin: 'user' })
    await f.post('/task/update', { id: autoId, execution_role: 'business' })
    expect((await f.snapshot()).running).toMatchObject({ count: 1, items: [{ task_id: autoId, role: 'business' }] })
    await f.restart(); expect((await f.snapshot()).running?.count).toBe(1)
  })
  it('角色：同一业务事项中的协调来源不增加执行会话数，也不阻止执行者独立交回', async () => {
    const f = await fixture(); f.source('session-coordinator', 'openai'); f.source('session-worker', 'moonshot')
    const id = await f.task(['session-coordinator', 'session-worker'])
    await f.post('/task/update', { id, links: [{ agent: 'codex', session_id: 'session-coordinator', execution_role: 'coordination' }, { agent: 'codex', session_id: 'session-worker' }] })
    const state = await f.snapshot()
    expect(state.execution).toMatchObject({ observed_running_tasks: 1, observed_running_sessions: 1 })
    expect(state.running?.items[0]?.sources).toMatchObject([{ role: 'coordination', role_origin: 'user' }, { role: 'business', provider: 'kimi', transport: 'codex-rollout' }])
    f.tick(); f.event('session-worker', 'task_complete', 'r-1', '做完:执行者交回')
    const returned = await f.snapshot()
    expect(returned.execution?.items[0]?.state).toBe('awaiting_review')
    expect(returned.tasks?.tasks[0]?.status).toBe('confirm'); expect(returned.running?.count).toBe(0)
  })

  it('角色：显式协调回执只存来源历史，业务来源单独交回就进入待验', async () => {
    const f = await fixture(); f.source('session-control', 'openai'); f.source('session-work', 'openai')
    const id = await f.task(['session-control', 'session-work'])
    await f.post('/task/update', { id, links: [
      { agent: 'codex', session_id: 'session-control', execution_role: 'coordination' },
      { agent: 'codex', session_id: 'session-work' },
    ] })
    await f.post('/task/receipt', { id, receipt: 'blocked', text: '卡住:协调等待', source_session_id: 'session-control', source_round: 'r-1' })
    expect(await f.rawTask(id)).toMatchObject({ status: 'doing', receipts: [{ source_session_id: 'session-control' }] })
    expect((await f.rawTask(id))?.receipt).toBeUndefined()
    expect((await f.snapshot()).tasks?.tasks[0]?.status).toBe('doing')
    await f.post('/task/receipt', { id, receipt: 'done', text: '做完:业务产物', source_session_id: 'session-work', source_round: 'r-1' })
    const state = await f.snapshot()
    expect(state.tasks?.tasks[0]?.status).toBe('confirm')
    expect(state.tasks?.tasks[0]?.receipts).toHaveLength(2)
    expect(state.running?.count).toBe(0)
  })

})
