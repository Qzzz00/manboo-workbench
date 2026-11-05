// @vitest-environment node
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import type { WorkbenchState } from '../src/protocol.ts'

const locatorCalls = vi.hoisted(() => ({ codex: 0, codexLooks: 0, kimi: 0, kimiProbes: 0, codexIndexSingles: 0, codexIndexBatches: 0, codexIndexGets: 0 }))
vi.mock('../src/server/codexThreadIndex.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/codexThreadIndex.ts')>()
  return { ...real,
    codexRolloutForSession: (...args: Parameters<typeof real.codexRolloutForSession>) => {
      locatorCalls.codexIndexSingles++; return real.codexRolloutForSession(...args)
    },
    createCodexRolloutLookup: (...args: [string]) => {
      locatorCalls.codexIndexBatches++
      const lookup = real.createCodexRolloutLookup(...args)
      return { get: (id: string) => { locatorCalls.codexIndexGets++; return lookup.get(id) }, close: () => lookup.close() }
    },
  }
})
vi.mock('../src/server/cliSessionRead.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/cliSessionRead.ts')>()
  const { stat } = await import('node:fs/promises')
  const countedStat = ((path: string, options?: { bigint?: boolean }) => {
    locatorCalls.kimiProbes++
    return stat(path, options as never)
  }) as typeof stat
  return { ...real,
    createCodexExecutionLocator: (codexHome: string) => {
      // 机制变化(2026-10-28):Codex 执行定位加了 hint(对齐 Kimi 已有做法)。全量校验
      // (realpath + 64KB 元数据读)只在冷拍与文件/index/cwds 变化后的下一拍发生,计入
      // locatorCalls.codex;每一拍每一来源仍逐次过定位器闭包,计入 codexLooks(与 kimi 同口径)。
      const locator = real.createCodexExecutionLocator(codexHome, { fullLocate: async (input) => {
        locatorCalls.codex++; return real.locateCodexCliSession(input)
      } })
      return { prepare: async () => {
        const locate = await locator.prepare()
        return async (input: Parameters<typeof locate>[0]) => { locatorCalls.codexLooks++; return locate(input) }
      } }
    },
    createKimiExecutionLocator: (home: string) => {
      const locator = real.createKimiExecutionLocator(home, countedStat)
      return { prepare: async () => {
        const locate = await locator.prepare()
        return async (input: Parameters<typeof locate>[0]) => { locatorCalls.kimi++; return locate(input) }
      } }
    },
    locateCodexCliSession: async (...args: Parameters<typeof real.locateCodexCliSession>) => {
      locatorCalls.codex++; return real.locateCodexCliSession(...args)
    },
    locateKimiCliSession: async (...args: Parameters<typeof real.locateKimiCliSession>) => {
      locatorCalls.kimi++
      return real.locateKimiCliSession({ ...args[0], statFile: async path => { locatorCalls.kimiProbes++; return stat(path) } })
    },
  }
})

const homes: string[] = [], servers: WorkbenchServer[] = [], sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  for (const server of servers.splice(0)) await server.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function productionShape(options: { denseHistory?: boolean, codexIndex?: boolean, eventRich?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'execution-read-budget-')); homes.push(home)
  const project = join(home, 'project'), otherProject = join(home, 'other-project'); mkdirSync(project); mkdirSync(otherProject)
  const codexHome = join(home, '.codex'), codexDir = join(codexHome, 'sessions', '2026', '10', '26')
  mkdirSync(codexDir, { recursive: true }); vi.stubEnv('CODEX_HOME', codexHome)
  const kimiRoot = join(home, '.kimi-code', 'sessions'); mkdirSync(kimiRoot, { recursive: true })
  for (let group = 0; group < 163; group++) mkdirSync(join(kimiRoot, `workspace-${group}`))
  const now = '2026-10-26T08:00:00.000Z'
  let seconds = Date.parse(now) / 1000
  const registrations: { agent: 'codex', session_id: string, file: string, format: 'codex-rollout' }[] = []
  const sourceFiles = new Map<string, string>()
  const rows = Array.from({ length: 129 }, (_, index) => {
    const comments = Array.from({ length: options.denseHistory && index === 0 ? 64 : 16 }, (_, n) => ({ id: `c-${index}-${n}`, by: 'QA', text: `历史意见 ${index}/${n} ${'内容'.repeat(40)}`, at: now }))
    const status = index < 6 ? 'doing' : index < 13 ? 'done' : index < 20 ? 'blocked' : index === 20 ? 'confirm' : index === 21 ? 'canceled' : 'backlog'
    const task: Record<string, unknown> = { id: `t-${index}`, title: `业务事项 ${index}`, status, project_id: 'qa', comments,
      execution_role: { kind: 'business', origin: 'explicit_task' }, source: { kind: 'manual' }, created_at: now, updated_at: now }
    if (index < 23) {
      const agent = index < 18 ? 'codex' : 'kimi', id = `session_source_${index}`
      task.links = [{ agent, session_id: id }]
      if (agent === 'codex') {
        const file = join(codexDir, `${id}.jsonl`)
        writeFileSync(file, [
          { type: 'session_meta', payload: { id, cwd: project, model_provider: 'openai' } },
          { type: 'event_msg', timestamp: now, payload: { type: 'task_started', turn_id: 'r-1' } },
          ...Array.from({ length: 128 }, (_, n) => ({ type: 'event_msg', timestamp: now,
            payload: { type: 'token_count', sequence: n, metadata: 'm'.repeat(512) } })),
        ].map(row => JSON.stringify(row)).join('\n') + '\n')
        sourceFiles.set(id, file)
        if (!options.codexIndex) registrations.push({ agent, session_id: id, file, format: 'codex-rollout' })
      } else {
        const dir = join(kimiRoot, `workspace-${index}`, id); mkdirSync(dir)
        writeFileSync(join(dir, 'state.json'), JSON.stringify({ cwd: project }))
        writeFileSync(join(dir, 'wire.jsonl'), [
          { type: 'context.append_loop_event', time: seconds * 1000, event: { type: 'TurnBegin', turn_id: 'r-1' } },
          ...Array.from({ length: 128 }, (_, n) => ({ type: 'usage.record', time: seconds * 1000,
            sequence: n, metadata: 'm'.repeat(512) })),
        ].map(row => JSON.stringify(row)).join('\n') + '\n')
        sourceFiles.set(id, join(dir, 'wire.jsonl'))
      }
    }
    return task
  })
  if (options.eventRich) {
    (rows[0]!.links as unknown[]).push({ agent: 'codex', session_id: 'session_source_1' })
    rows[1]!.links = []; rows[1]!.status = 'done'
  }
  if (options.codexIndex) {
    const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?)')
    for (let index = 0; index < 18; index++) insert.run(`session_source_${index}`, sourceFiles.get(`session_source_${index}`)!)
    db.close()
  }
  const file = join(home, 'tasks.json')
  writeFileSync(file, JSON.stringify({ version: 2, tasks: rows, sprints: [], modules: [], project_meta: [] }))
  const logFile = join(home, 'jobs.jsonl')
  writeFileSync(logFile, Array.from({ length: 8_000 }, (_, index) => {
    const sourceIndex = index % 23
    return JSON.stringify(options.eventRich ? {
      at: now, job: `t-${sourceIndex === 1 ? 0 : sourceIndex}`, step: 'updated', family: 'synthetic',
      agent: sourceIndex < 18 ? 'codex' : 'kimi', session_id: `session_source_${sourceIndex}`,
      source_round: `r-${1 + Math.floor(index / 23) % 20}`, source_event_id: `history-${index}`, task_round: 1,
    } : { at: now, job: `historical-${index % 129}`, step: 'assigned', family: 'synthetic', why: '历史事件'.repeat(12) })
  }).join('\n') + '\n')
  const jobLog = createJobLog({ file: logFile, max: 16_000, now: () => new Date(now) })
  await jobLog.load()
  const historyCopies = { calls: 0, rows: 0 }
  const originalEvents = jobLog.events
  jobLog.events = job => { const rows = originalEvents(job); historyCopies.calls++; historyCopies.rows += rows.length; return rows }
  const tasks = createTasksService({ file, now: () => seconds })
  const counters = { tasks: 0, projects: 0, digest: 0, permission: 0, move: 0, receipt: 0, update: 0 }
  let allowed = true, projectPath = project
  const originalList = tasks.list
  tasks.list = async () => { counters.tasks++; return originalList() }
  const originalMove = tasks.move, originalReceipt = tasks.recordReceipt, originalUpdate = tasks.update
  tasks.move = (...args) => { counters.move++; return originalMove(...args) }
  tasks.recordReceipt = (...args) => { counters.receipt++; return originalReceipt(...args) }
  tasks.update = (...args) => { counters.update++; return originalUpdate(...args) }
  const server = await startWorkbenchServer({ port: 0, tickIntervalMs: 0, heartbeatMs: 0,
    service: createWorkbenchService({ now: () => seconds }), tasks, jobLog,
    paths: { home, config: {} } as never,
    authorization: { isAllowed: async () => { counters.permission++; return allowed }, denialMessage: () => '未授权' } as never,
    sessionDigest: { files: () => { counters.digest++; return registrations } } as never,
    projects: { getProjectsState: async () => { counters.projects++; return { projects: [{ id: 'qa', name: 'QA', path: projectPath }] } } } as never,
  })
  servers.push(server)
  const get = async (path: string) => {
    const res = await fetch(server.url + path)
    expect(res.status).toBe(200)
    return res.json()
  }
  /*
   * 8791 第六轮(2026-10-29;第 3 轮退修改):/state 与 /collab/* 读路都不再触发对账,只读上一次快照。
   * 要推进对账,用 server.reconcileNow()(验收/排障口:合并进在途那一拍、链式等补拍落地,不受 2 秒事件节流限制)。
   */
  let reconcileCalls = 0
  const sweep = async () => {
    reconcileCalls += 1; await server.reconcileNow?.()
    reconcileCalls += 1; await server.reconcileNow?.()
  }
  const reset = () => { counters.tasks = counters.projects = counters.digest = counters.permission = counters.move = counters.receipt = counters.update = 0 }
  const duplicateDir = join(kimiRoot, 'workspace-50', 'session_source_18')
  return { server, tasks, counters, historyCopies, reset, get, sweep, taskFile: file, sourceFiles, tick: () => { seconds += 5 },
    codexHome, reconcileCalls: () => reconcileCalls,
    sourceRow: (id: string, row: unknown) => appendFileSync(sourceFiles.get(id)!, JSON.stringify(row) + '\n'),
    replaceSource: (id: string, rows: readonly unknown[]) => writeFileSync(sourceFiles.get(id)!, rows.map(row => JSON.stringify(row)).join('\n') + '\n'),
    nowIso: () => new Date(seconds * 1000).toISOString(),
    revoke: () => { allowed = false }, allow: () => { allowed = true },
    moveProject: () => { projectPath = otherProject }, restoreProject: () => { projectPath = project },
    duplicateKimi: () => { mkdirSync(duplicateDir); writeFileSync(join(duplicateDir, 'state.json'), JSON.stringify({ cwd: project }))
      writeFileSync(join(duplicateDir, 'wire.jsonl'), JSON.stringify({ type: 'context.append_loop_event', time: seconds * 1000,
        event: { type: 'TurnBegin', turn_id: 'r-1' } }) + '\n') },
    removeDuplicateKimi: () => rmSync(duplicateDir, { recursive: true, force: true }) }
}

it('生产形状 129 卡/23 关联：state、runs、广播只读上一次对账快照，对账拍仍逐源授权', async () => {
  const f = await productionShape()
  // 冷解析限速 4/拍(8791 第四轮):23 个冷来源一拍只消化 4 个,先分拍预热到稳态再测读预算;预热拍被 reset 清出断言。
  // 8791 第六轮:对账由 server.reconcileNow()(验收/排障口,合并)推进;/state 与广播只读 snapshot。
  // 第 3 轮起收场卡一律安静(不看观察结果):这盘 7 done + 1 canceled 稳态不再被读,每拍 23-8=15 来源。
  for (let i = 0; i < 8; i++) await f.sweep()
  f.reset()
  const state = await f.get('/state') as WorkbenchState
  // /state 本身零对账读:执行视图来自上一拍快照,一格不少。
  expect(state.execution?.observed_running_tasks).toBeGreaterThan(0)
  expect(state.execution?.items).toHaveLength(23)
  expect(f.counters.permission).toBe(0)
  expect(f.counters.tasks).toBeLessThanOrEqual(2)
  // projects 那一格 composeState 每拍自己读一次(项目区),与对账无关;对账专属的 digest 才是 0。
  expect(f.counters.projects).toBeLessThanOrEqual(1)
  expect(f.counters.digest).toBe(0)

  f.reset()
  await f.sweep()
  const runs = await f.get('/collab/runs?task_id=t-0') as { runs: unknown[] }
  expect(runs.runs.length).toBeGreaterThan(0)
  // sweep 拍两下(排空合并/补拍),这一档是 2 拍 × 15 来源(8 张收场卡安静)。
  expect(f.counters.permission).toBe(15 * 2)
  expect(f.counters.tasks).toBeLessThanOrEqual(8)
  expect(f.counters.projects).toBeLessThanOrEqual(4) // 每拍至多 2 次项目区读(对账快照一次 + 本拍自己一次)
  expect(f.counters.digest).toBeLessThanOrEqual(2)

  const socket = new WebSocket(f.server.url.replace('http:', 'ws:') + '/live'); sockets.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('initial snapshot timeout')), 10_000)
    socket.once('message', () => { clearTimeout(timer); resolve() })
  })
  f.reset()
  const next = new Promise<WorkbenchState>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('snapshot timeout')), 10_000)
    socket.once('message', bytes => { clearTimeout(timer); resolve((JSON.parse(bytes.toString()) as { state: WorkbenchState }).state) })
  })
  f.server.broadcastState()
  const broadcast = await next
  expect(broadcast.execution?.observed_running_tasks).toBe(state.execution?.observed_running_tasks)
  // 广播也零对账读:整份快照来自上一拍对账结果。
  expect(f.counters.permission).toBe(0)
  expect(f.counters.tasks).toBeLessThanOrEqual(2)
  expect(f.counters.projects).toBeLessThanOrEqual(1)
  expect(f.counters.digest).toBe(0)

  f.revoke(); f.reset()
  await f.sweep()
  const denied = await f.get('/state') as WorkbenchState
  expect(f.counters.permission).toBe(15 * 2) // 在跑的 t-0 照常逐拍重授权,撤权当场可见
  expect(denied.execution?.complete).toBe(false)
  expect(denied.execution?.items[0]?.sources[0]).toMatchObject({ state: 'unknown', unknown: 'denied' })
  expect(denied.running?.count).toBeUndefined()
  f.allow(); f.moveProject(); f.reset()
  await f.sweep()
  const moved = await f.get('/state') as WorkbenchState
  expect(f.counters.permission).toBe(15 * 2)
  expect(moved.execution?.items[0]?.sources[0]).toMatchObject({ state: 'unknown', unknown: 'missing' })
  f.restoreProject(); f.reset()
  await f.sweep()
  expect((await f.get('/state') as WorkbenchState).execution?.items[0]?.sources[0]?.state).toBe('running')
  f.duplicateKimi()
  await f.sweep()
  expect((await f.get('/state') as WorkbenchState).execution?.items.find(item => item.task_id === 't-18')?.sources[0]).toMatchObject({ state: 'unknown' })
  f.removeDuplicateKimi()
  await f.sweep()
  expect((await f.get('/state') as WorkbenchState).execution?.items.find(item => item.task_id === 't-18')?.sources[0]?.state).toBe('running')
  await f.tasks.update('t-0', { links: [] })
  f.reset()
  // update 只把事件排进 2 秒节流,sweep 两拍(reconcileNow)各跑一拍;t-0 摘链后每拍 23-8-1=14 来源。
  await f.sweep()
  expect((await f.get('/state') as WorkbenchState).execution?.items).toHaveLength(22)
  expect(f.counters.permission).toBe(14 * 2)
}, 120_000)

it('129 卡/23 关联/8000 事件的并发 HTTP 与 live 消费不反复解析整本账或全扫事件', async () => {
  const f = await productionShape()
  // 冷解析限速 4/拍(8791 第四轮):冷启动一拍只消化 4 个来源,先分拍预热到稳态再测读预算;预热拍用 f.reset() 清出断言。
  // 8791 第六轮:对账靠 sweep 推进且合并;/state 与广播只读 snapshot,不再碰来源。
  for (let i = 0; i < 8; i++) await f.sweep()
  f.reset()
  const socketsNow: WebSocket[] = []
  let taskParses = 0, eventFullScans = 0
  locatorCalls.codex = locatorCalls.kimi = locatorCalls.kimiProbes = 0
  const parse = JSON.parse, filter = Array.prototype.filter
  JSON.parse = ((input: string, reviver?: (key: string, value: unknown) => unknown) => {
    if (typeof input === 'string' && input.length > 100_000
      && (input.startsWith('{"version":2,"tasks":') || input.startsWith('{\n  "version": 2,\n  "tasks":'))) taskParses++
    return parse(input, reviver)
  }) as typeof JSON.parse
  Array.prototype.filter = function (this: unknown[], predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
    if (this.length >= 8_000) eventFullScans++
    return filter.call(this, predicate, thisArg)
  } as typeof Array.prototype.filter
  try {
    const ws = async () => {
      const socket = new WebSocket(f.server.url.replace('http:', 'ws:') + '/live')
      sockets.push(socket); socketsNow.push(socket)
      await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('initial snapshot timeout')), 10_000)
        socket.once('message', () => { clearTimeout(timer); resolve() })
      })
    }
    // 并发:三拍 /state(零对账)+ 三声 reconcileNow(合并成一两拍)+ 两条 live。
    await Promise.all([f.get('/state'), f.get('/state'), f.get('/state'),
      (async () => { await Promise.all([f.server.reconcileNow?.(), f.server.reconcileNow?.(), f.server.reconcileNow?.()]) })(), ws(), ws()])
    const broadcast = async () => {
      const message = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('broadcast timeout')), 10_000)
        socketsNow[0]!.once('message', () => { clearTimeout(timer); resolve() })
      })
      f.server.broadcastState()
      await message
    }
    await broadcast(); await broadcast()
    // 对账只跑了合并后的少数几拍(3 声 reconcileNow 至多一两拍),每拍仍 15 来源(8 张收场卡安静)逐次授权。
    expect(f.counters.permission).toBeGreaterThanOrEqual(15)
    expect(f.counters.permission).toBeLessThanOrEqual(15 * 2)
    expect(f.counters.tasks, `任务快照读取 ${f.counters.tasks} 次`).toBeLessThanOrEqual(15)
    expect(taskParses, `任务账 JSON 全解析 ${taskParses} 次`).toBeLessThanOrEqual(3)
    expect(eventFullScans).toBe(0)
    // 对账拍内每来源仍逐次过定位器(逐源授权许可不受影响);Codex 全量校验因 hint 只剩冷拍级别。
    expect(locatorCalls.codexLooks + locatorCalls.kimi).toBeGreaterThanOrEqual(23)
    expect(locatorCalls.codex, `codex 全量校验 ${locatorCalls.codex} 次`).toBeLessThanOrEqual(20)
    expect(locatorCalls.kimiProbes, `Kimi 精确路径探测 ${locatorCalls.kimiProbes} 次`).toBeLessThanOrEqual(3_000)
  } finally {
    JSON.parse = parse
    Array.prototype.filter = filter
  }
}, 120_000)

it('多来源多轮 8000 条同事项历史在连续 HTTP/live 观察中每事项只取一次防御副本', async () => {
  const f = await productionShape({ eventRich: true, denseHistory: true })
  // 冷解析限速 4/拍(8791 第四轮):冷启动一拍只消化 4 个来源,先分拍预热到稳态再测防御副本;预热拍被 reset 清出断言。
  // 8791 第六轮:对账靠 sweep 推进(合并),/state 与广播只读 snapshot。
  for (let i = 0; i < 8; i++) await f.sweep()
  f.reset(); f.historyCopies.calls = f.historyCopies.rows = 0
  const socket = new WebSocket(f.server.url.replace('http:', 'ws:') + '/live'); sockets.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('snapshot timeout')), 10_000)
    socket.once('message', () => { clearTimeout(timer); resolve() }) })
  // 对账五轮(每轮 reconcileNow ×2),间一份广播。eventRich 盘 t-1 空链、7 done + 1 canceled 安静,
  // 每拍读 23-8=15 来源;rows/calls 按实测校准,断言与拍数线性、不随观察次数涨。
  await f.sweep(); f.reset()
  await f.sweep(); f.reset()
  await f.sweep(); f.reset()
  const broadcast = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('broadcast timeout')), 10_000)
    socket.once('message', () => { clearTimeout(timer); resolve() }) })
  f.server.broadcastState(); await broadcast
  f.reset()
  await f.sweep(); await f.sweep()
  const sweeps = f.reconcileCalls() / 2 // 每轮 sweep = 两声 reconcileNow(顺序、各自成拍)
  expect(sweeps).toBeGreaterThanOrEqual(5)
  // 每拍每事项至多取一次防御副本(与拍数线性);8791 第六轮起对账拍由 sweep 显式推进,行数上限按实测校准。
  expect(f.historyCopies.rows, `copied history rows ${f.historyCopies.rows} over ${sweeps} sweeps`).toBeLessThanOrEqual(sweeps * 9_000 + 1_000)
  // 23 个链接来源每拍各取一次(t-0 挂两条同会话链接,去重后一次/事项);与拍数线性,不随观察次数涨。
  expect(f.historyCopies.calls, `history copies ${f.historyCopies.calls} over ${sweeps} sweeps`).toBeLessThanOrEqual(sweeps * 23 + 4)
  expect((await f.get('/state') as WorkbenchState).execution?.items.find(item => item.task_id === 't-0')?.sources).toHaveLength(2)
}, 120_000)

it('历史回执与新轮交回后多入口重复观察不重写任务账，旧轮仍可追溯', async () => {
  const f = await productionShape({ denseHistory: true })
  // 冷解析限速 4/拍(8791 第四轮):冷启动一拍只消化 4 个来源,先分拍预热到稳态,后面的替换/追加才测得到纯增量行为。
  for (let i = 0; i < 8; i++) await f.sweep()
  const id = 'session_source_0', baseMs = Date.parse(f.nowIso())
  const rows: unknown[] = [{ type: 'session_meta', payload: { id, cwd: join(f.taskFile, '..', 'project'), model_provider: 'openai' } }]
  for (let n = 1; n <= 13; n++) {
    rows.push({ type: 'event_msg', timestamp: new Date(baseMs - (27 - n * 2) * 1000).toISOString(),
      payload: { type: 'task_started', turn_id: `r-${n}` } })
    rows.push({ type: 'event_msg', timestamp: new Date(baseMs - (26 - n * 2) * 1000).toISOString(),
      payload: { type: 'task_complete', turn_id: `r-${n}`, last_agent_message: `做完:第 ${n} 轮证据` } })
  }
  rows.push(...Array.from({ length: 128 }, (_, n) => ({ type: 'turn_context', payload: { model: 'gpt-6-sol', sequence: n, metadata: 'm'.repeat(512) } })))
  f.replaceSource(id, rows)
  await f.sweep()
  const first = await f.get('/state') as WorkbenchState
  expect(first.tasks?.tasks.find(task => task.id === 't-0')?.receipts).toHaveLength(13)
  expect(first.execution?.items.find(item => item.task_id === 't-0')?.state).toBe('awaiting_review')
  const stable = async () => {
    const before = readFileSync(f.taskFile)
    const mtime = statSync(f.taskFile, { bigint: true }).mtimeNs
    f.reset()
    // 8791 第六轮:/state 与广播零对账读;对账拍(sweep)重复观察也不重写任务账。
    await f.get('/state'); await f.get('/state')
    await f.sweep()
    const socket = new WebSocket(f.server.url.replace('http:', 'ws:') + '/live'); sockets.push(socket)
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('snapshot timeout')), 10_000)
      socket.once('message', () => { clearTimeout(timer); resolve() }) })
    f.server.broadcastState()
    await f.get('/state')
    expect(f.counters.move).toBe(0)
    expect(f.counters.receipt).toBe(0)
    expect(f.counters.update).toBe(0)
    expect(readFileSync(f.taskFile).equals(before)).toBe(true)
    expect(statSync(f.taskFile, { bigint: true }).mtimeNs).toBe(mtime)
  }
  await stable()
  f.sourceRow(id, { type: 'turn_context', payload: { model: 'gpt-6-sol', metadata: 'changed-observation'.repeat(80) } })
  await stable()
  f.tick(); f.sourceRow(id, { type: 'event_msg', timestamp: f.nowIso(), payload: { type: 'task_started', turn_id: 'r-14' } })
  // 8791 第六轮:已收场且正式交回的卡是「安静卡」,纯来源活动不再被每拍捞起;
  // 任务账来一个事件(改卡)唤醒它,下一拍对账把新轮读出来(重开 doing、round 2)。
  await f.tasks.update('t-0', { desc: '来源又开工了' })
  await f.sweep()
  expect((await f.get('/state') as WorkbenchState).tasks?.tasks.find(task => task.id === 't-0')).toMatchObject({ status: 'doing', round: 2 })
  f.tick(); f.sourceRow(id, { type: 'event_msg', timestamp: f.nowIso(), payload: { type: 'task_complete', turn_id: 'r-14', last_agent_message: '做完:新轮证据' } })
  await f.sweep()
  const returned = await f.get('/state') as WorkbenchState
  const task = returned.tasks?.tasks.find(task => task.id === 't-0')
  expect(task?.receipts).toHaveLength(14)
  expect(task?.receipts?.at(-1)).toMatchObject({ source_round: 'r-14', task_round: 2 })
  expect(returned.execution?.items.find(item => item.task_id === 't-0')?.state).toBe('awaiting_review')
  await stable()
}, 120_000)

it('未登记 Codex 的 18 个授权来源在 HTTP 与 live 每拍共用精确索引，下一拍仍重查权限和索引变更', async () => {
  const f = await productionShape({ codexIndex: true, denseHistory: true })
  locatorCalls.codexIndexSingles = locatorCalls.codexIndexBatches = locatorCalls.codexIndexGets = 0
  const socket = new WebSocket(f.server.url.replace('http:', 'ws:') + '/live'); sockets.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('snapshot timeout')), 10_000)
    socket.once('message', () => { clearTimeout(timer); resolve() }) })
  // 8791 第六轮:对账由 reconcileNow 推进,/state 与 broadcast 只读 snapshot 不占拍。
  // 第 3 轮起收场卡一律安静:7 张 done 的 codex 来源不再被查索引,每拍 gets = 18-7 = 11。
  await f.sweep() // 吸掉起服务那一冷拍(与计数窗无关)
  locatorCalls.codexIndexSingles = locatorCalls.codexIndexBatches = locatorCalls.codexIndexGets = 0
  f.reset()
  await f.sweep()
  expect(locatorCalls.codexIndexSingles).toBe(0)
  expect(locatorCalls.codexIndexBatches).toBe(2) // 两声 reconcileNow,顺序各一拍,每拍共用一个索引
  expect(locatorCalls.codexIndexGets).toBe(11 * 2)
  expect(f.counters.permission).toBe(15 * 2)

  const id = 'session_source_0', old = f.sourceFiles.get(id)!
  const newer = join(f.codexHome, 'sessions', '2026', '10', '26', 'relocated.jsonl')
  writeFileSync(newer, readFileSync(old))
  appendFileSync(newer, JSON.stringify({ type: 'event_msg', timestamp: f.nowIso(), payload: { type: 'task_started', turn_id: 'r-new' } }) + '\n')
  const db = new DatabaseSync(join(f.codexHome, 'state_5.sqlite'))
  db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(newer, id); db.close()
  await f.sweep()
  const afterIndexChange = await f.get('/state') as WorkbenchState
  expect(afterIndexChange.execution?.items.find(item => item.task_id === 't-0')?.sources[0]?.rounds.some(round => round.round === 'r-new')).toBe(true)
  f.revoke(); f.reset()
  await f.sweep()
  const denied = await f.get('/state') as WorkbenchState
  expect(f.counters.permission).toBe(15 * 2) // 在跑的 t-0 照常逐拍重授权,撤权当场可见
  expect(denied.execution?.items[0]?.sources[0]).toMatchObject({ state: 'unknown', unknown: 'denied' })
  f.allow(); f.moveProject()
  await f.sweep()
  expect((await f.get('/state') as WorkbenchState).execution?.items[0]?.sources[0]).toMatchObject({ state: 'unknown', unknown: 'missing' })
}, 120_000)
