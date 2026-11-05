// @vitest-environment node
/**
 * 8791 热点第六轮(2026-10-29,任务书 `docs/交接-1029-8791热点第六轮-对账队列与等确认卡的会话定位.md`):
 * 对账改事件驱动 + 有界到期、say 路不等对账、等确认的 Kimi 卡没有新事件不再每拍定位会话文件。
 * 验收四件(任务书编号):
 *   ① 连续 50 次 GET /state 期间只跑 ≤ 2 次对账(事件驱动 + 合并);
 *   ② /butler/say 在对账队列被人为挂住(注入一个不回的 reconcile)时仍 2 秒内回 200;
 *   ③ 9 张 confirm 卡挂 Kimi 链接、无新事件时,statFile 调用次数为 0(注入计数),执行视图不缺席;
 *   ④ 新事件(挪卡 = 交回那一档)到来时对应卡被读一次,读完回到安静。
 * 另附对账器单测:在途的一拍把所有后来的 request 合并进去;snapshot() 只读内存。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createExecutionReconciler } from '../src/server/executionState.ts'
import type { WorkbenchState } from '../src/protocol.ts'

const counts = vi.hoisted(() => ({ reconciles: 0, hangReconcile: false, kimiLocates: 0, kimiProbes: 0 }))
vi.mock('../src/server/codexExecutionFacts.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/codexExecutionFacts.ts')>()
  return { ...real,
    readLinkedCodexExecutions: (...args: Parameters<typeof real.readLinkedCodexExecutions>) => {
      counts.reconciles++
      // 用例 ②:注入一个永不返回的对账(对账队列被人为挂住)。
      if (counts.hangReconcile) return new Promise<never>(() => undefined)
      return real.readLinkedCodexExecutions(...args)
    },
  }
})
vi.mock('../src/server/cliSessionRead.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/cliSessionRead.ts')>()
  const { stat } = await import('node:fs/promises')
  const countedStat = ((path: string, options?: { bigint?: boolean }) => {
    counts.kimiProbes++
    return stat(path, options as never)
  }) as typeof stat
  return { ...real,
    createKimiExecutionLocator: (home: string) => {
      const locator = real.createKimiExecutionLocator(home, countedStat)
      return { prepare: async () => {
        const locate = await locator.prepare()
        return async (input: Parameters<typeof locate>[0]) => { counts.kimiLocates++; return locate(input) }
      } }
    },
    locateKimiCliSession: (...args: Parameters<typeof real.locateKimiCliSession>) => {
      counts.kimiLocates++
      return real.locateKimiCliSession({ ...args[0], statFile: async path => { counts.kimiProbes++; return stat(path) } })
    },
  }
})

const NOW = '2026-10-29T03:00:00.000Z'
const NOW_SEC = Math.floor(Date.parse(NOW) / 1000)
const homes: string[] = [], servers: WorkbenchServer[] = [], sockets: WebSocket[] = []
afterEach(async () => {
  counts.hangReconcile = false
  for (const socket of sockets.splice(0)) socket.close()
  for (const server of servers.splice(0)) await server.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface Fixture {
  server: WorkbenchServer
  url: string
  tasks: ReturnType<typeof createTasksService>
  get: (path: string) => Promise<WorkbenchState & Record<string, unknown>>
  post: (path: string, body: unknown) => Promise<{ status: number, body: Record<string, unknown> }>
  /** 等对账的一拍(server.reconcileNow:合并进在途那一拍,链式等补拍落地)。 */
  sweep: () => Promise<void>
  /** 假钟走 10 秒:改卡前 tick,updated_at 才动、拍签名才有差(真机写即刻变)。 */
  tick: () => void
}

/** 9 张「等确认且有回执」的 Kimi 卡 + 各自的 wire 原件(旧 TurnBegin/TurnEnd,正式交回);可再加 N 张已完成的 Kimi 卡(第 3 轮验收①的形状)。 */
async function serve(options: { confirmCards?: number, doneCards?: number } = {}): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'hot6-reconcile-')); homes.push(home)
  const project = join(home, 'project'); mkdirSync(project)
  const kimiRoot = join(home, '.kimi-code', 'sessions')
  const rows: Record<string, unknown>[] = []
  const card = (i: number, status: string) => {
    const id = `session_confirm_${i}`
    const dir = join(kimiRoot, `workspace-${i}`, id); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ cwd: project }))
    writeFileSync(join(dir, 'wire.jsonl'), [
      { type: 'context.append_loop_event', time: (NOW_SEC - 3600) * 1000, event: { type: 'TurnBegin', turn_id: 'r-1' } },
      // 正式交回(带回执正文):对账观察 = returned,这张卡才进「安静」档 —— 等确认的真实现状。
      { type: 'context.append_loop_event', time: (NOW_SEC - 3600) * 1000 + 500, event: { type: 'content.part', part: { type: 'text', text: `做完:等确认 ${i}` } } },
      { type: 'context.append_loop_event', time: (NOW_SEC - 3600) * 1000 + 1000, event: { type: 'TurnEnd', turn_id: 'r-1' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    rows.push({
      id: `t-c${i}`, title: `等确认 ${i}`, status,
      ...(status === 'confirm' ? { receipt: { kind: 'done', text: '做完:样片', at: new Date((NOW_SEC - 1800) * 1000).toISOString(),
        by: 'kimi', source_session_id: id, source_round: 'r-1', task_round: 1 } } : {}),
      links: [{ agent: 'kimi', session_id: id }], project_id: 'qa',
      execution_role: { kind: 'business', origin: 'explicit_task' }, source: { kind: 'manual' },
      created_at: NOW, updated_at: NOW,
    })
  }
  for (let i = 0; i < (options.confirmCards ?? 9); i++) card(i, 'confirm')
  for (let n = 0; n < (options.doneCards ?? 0); n++) card((options.confirmCards ?? 9) + n, 'done')
  const file = join(home, 'tasks.json')
  writeFileSync(file, JSON.stringify({ version: 2, tasks: rows, sprints: [], modules: [], project_meta: [] }))
  // 可动的假钟:改卡前 tick 一下,updated_at 才动、对账的拍签名才有差(真机是写即刻变)。
  let nowSec = NOW_SEC
  const tasks = createTasksService({ file, now: () => nowSec })
  const server = await startWorkbenchServer({ port: 0, tickIntervalMs: 0, heartbeatMs: 0,
    service: createWorkbenchService({ now: () => nowSec }), tasks,
    paths: { home, config: {} } as never,
    authorization: { isAllowed: async () => true, denialMessage: () => '未授权' } as never,
    sessionDigest: { files: () => [] } as never,
    projects: { getProjectsState: async () => ({ projects: [{ id: 'qa', name: 'QA', path: project }] }) } as never,
    // 2026-10-29 入口归一:/butler/say 进理解中枢 —— 假模型回 note(「记一下周四发样片」按原语义落一张待办卡)。
    model: { endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: true }) } as never,
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ commands: [{ name: 'note', title: '周四发样片', status: 'todo' }] }) } }] }))) as never,
  })
  servers.push(server)
  const get = async (path: string) => {
    const res = await fetch(server.url + path)
    expect(res.status).toBe(200)
    return res.json() as Promise<WorkbenchState & Record<string, unknown>>
  }
  const post = async (path: string, body: unknown) => {
    const res = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
  }
  /*
   * 8791 第六轮第 3 轮:读路(/state、/collab/*)一律不触发对账 —— sweep 用 server.reconcileNow()
   * (验收/排障口,合并进在途那一拍、链式等补拍落地,不受 2 秒事件节流限制)。
   */
  const sweep = async () => { await server.reconcileNow?.() }
  return { server, url: server.url, tasks, get, post, sweep, tick: () => { nowSec += 10 } }
}

it('① 连续 50 次 GET /state 期间只跑 ≤2 次对账;执行视图照常在(事件驱动 + 合并)', async () => {
  const f = await serve()
  await f.sweep() // 起服务那一冷拍对完
  const runsBefore = counts.reconciles
  for (let i = 0; i < 50; i++) await f.get('/state')
  expect(counts.reconciles - runsBefore, '50 次 /state 触发的对账次数').toBeLessThanOrEqual(2)
  expect(counts.reconciles - runsBefore).toBe(0)
  const state = await f.get('/state')
  expect(state.execution?.items).toHaveLength(9)
  expect(state.execution?.items.map(one => one.task_id).sort()).toEqual(
    Array.from({ length: 9 }, (_, i) => `t-c${i}`).sort())
  // 任务账来一个真事件(她把一张卡退回进行中):当场触发对账(在途合并 + 跑完补拍,≤2 拍)。
  const moved = await f.tasks.move('t-c0', 'doing')
  expect(moved.ok).toBe(true)
  await f.sweep()
  expect(counts.reconciles - runsBefore).toBeGreaterThanOrEqual(1)
  expect(counts.reconciles - runsBefore).toBeLessThanOrEqual(2)
}, 60_000)

it('② /butler/say 在对账队列被人为挂住时仍 2 秒内回 200,受理结果先到手', async () => {
  const f = await serve()
  await f.sweep()
  counts.hangReconcile = true // 注入一个永不返回的对账
  const started = Date.now()
  const res = await f.post('/butler/say', { text: '记一下周四发样片' })
  expect(res.status).toBe(200)
  expect(Date.now() - started, '挂住的对账队列没拖住 say 回包').toBeLessThan(2_000)
  const items = res.body.items as { kind: string, title: string, status: string, card_id?: string }[]
  // 中枢 items 的 title 是回话行(带卡号与状态);卡号在 card_id 上,标题看板上有。
  expect(items[0]).toMatchObject({ kind: '记', status: 'done' })
  // 卡真的建上了(受理不是嘴上说说)。
  expect((await f.tasks.list()).tasks.some(one => one.id === items[0]?.card_id)).toBe(true)
}, 60_000)

it('③ 9 张 confirm 卡无新事件:再对多少拍,statFile 探测都是 0,执行视图不缺席', async () => {
  const f = await serve()
  await f.sweep()
  // 冷解析限拍 4 个(既有机制,8791 第四轮):9 张冷卡一拍消化不完,先分拍预热到全 returned 再断言。
  for (let i = 0; i < 3; i++) await f.sweep()
  expect(counts.kimiProbes, '预热拍确曾探测过').toBeGreaterThan(0)
  counts.kimiProbes = 0
  counts.kimiLocates = 0
  for (let i = 0; i < 3; i++) await f.sweep() // 再三拍对账(无新事件)
  expect(counts.kimiProbes, '安静卡的 statFile 探测').toBe(0)
  expect(counts.kimiLocates, '安静卡连定位器都没进').toBe(0)
  const state = await f.get('/state')
  expect(state.execution?.items).toHaveLength(9)
  expect(state.execution?.items.every(one => (one.sources?.length ?? 0) > 0)).toBe(true)
}, 60_000)

it('④ 新事件(回执)到来时对应卡被读一次,读完回到安静', async () => {
  const f = await serve()
  for (let i = 0; i < 4; i++) await f.sweep() // 冷解析限拍:先预热到全部安静
  counts.kimiProbes = 0
  // 同一卡新来一条回执(另一个来源轮次):卡保持「等确认且有回执」,任务账确实变了。
  const recorded = await f.tasks.recordReceipt('t-c3', { kind: 'objection', text: '有异议:先别合',
    at: new Date(NOW_SEC * 1000).toISOString(), by: 'kimi', source_session_id: 'session_confirm_3', source_round: 'r-2', task_round: 1 })
  expect(recorded.ok).toBe(true)
  await f.sweep() // 合并/等待事件触发的那一拍
  expect(counts.kimiProbes, '事件卡被重新读了一次').toBeGreaterThan(0)
  const probesAfterEvent = counts.kimiProbes
  await f.sweep()
  expect(counts.kimiProbes, '没有新事件:回到零探测').toBe(probesAfterEvent)
  // 读过了,视图里这张卡的回执与状态都在(新回执成为当前光标,历史进 receipts)。
  const state = await f.get('/state')
  const card = state.tasks?.tasks.find(one => one.id === 't-c3')
  expect(card?.status).toBe('confirm')
  expect(card?.receipt).toMatchObject({ kind: 'objection', source_round: 'r-2' })
  expect(card?.receipts).toHaveLength(2) // r-1(冷拍记的)与 r-2(这条新回执)
}, 60_000)

it('第3轮① 35 张带 Kimi 链接的收场卡(9 confirm 有回执 + 26 done)、无事件:60 拍 statFile 0、对账 ≤3 拍', async () => {
  const f = await serve({ doneCards: 26 })
  await f.sweep() // 等在途的起服务冷拍落地(第 1 拍:35 张卡全量读一次,此后一律安静)
  expect(counts.kimiProbes, '冷拍确曾探测过').toBeGreaterThan(0)
  counts.kimiProbes = 0
  counts.kimiLocates = 0
  // 计数是本文件跨用例共享的,一律从本用例基线取相对值;起服务冷拍已落在基线里(=1 拍)。
  const runsAtStart = counts.reconciles
  for (let i = 0; i < 60; i++) await f.get('/state') // 连续 60 拍
  expect(counts.kimiProbes, '60 拍里收场卡的 statFile 探测').toBe(0)
  expect(counts.kimiLocates, '60 拍里连定位器都没进').toBe(0)
  expect(counts.reconciles - runsAtStart, '60 拍触发的对账(含冷拍 ≤3)').toBeLessThanOrEqual(3)
  const state = await f.get('/state')
  expect(state.execution?.items).toHaveLength(35)
}, 60_000)

it('第3轮② /collab/runs 连读 20 次不触发对账', async () => {
  const f = await serve()
  await f.sweep()
  const before = counts.reconciles
  for (let i = 0; i < 20; i++) await f.get(`/collab/runs?task_id=t-c0`)
  expect(counts.reconciles - before, '20 次连读触发的对账').toBe(0)
}, 60_000)

it('第3轮③ 无变化不广播:无变化窗口快照推送为 0;一次任务写之后 ≤ 变化次数 + 1', async () => {
  const f = await serve()
  await f.sweep()
  const socket = new WebSocket(f.url.replace('http:', 'ws:') + '/live'); sockets.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('initial snapshot timeout')), 10_000)
    socket.once('message', () => { clearTimeout(timer); resolve() }) })
  // 起服务冷拍 / 合并补拍的推送可能还在路上 —— 先收干净,再从零计。
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 400); socket.once('error', reject); void timer })
  let snapshots = 0
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString()) as { kind?: string }
    if (message.kind === 'snapshot') snapshots++
  })
  // 无变化窗口:30 拍 /state + 10 拍 /collab/runs —— 一份快照也不该推。
  for (let i = 0; i < 30; i++) await f.get('/state')
  for (let i = 0; i < 10; i++) await f.get('/collab/runs?task_id=t-c0')
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(snapshots, '无变化窗口里的快照推送').toBe(0)
  // 一次任务写(不经 HTTP 路由):事件拍 2 秒内合并起跑,跑完推一份 → 总推送 = 变化 1 + 1 份上限以内。
  f.tick()
  await f.tasks.update('t-c0', { desc: '她看了一眼' })
  await new Promise(resolve => setTimeout(resolve, 2_600))
  expect(snapshots, '变化后的快照推送').toBeGreaterThanOrEqual(1)
  expect(snapshots).toBeLessThanOrEqual(2)
}, 60_000)

it('对账器单测:在途的一拍合并所有后来的 request;snapshot() 从没对过账时是 undefined', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hot6-unit-')); homes.push(home)
  const file = join(home, 'tasks.json')
  writeFileSync(file, JSON.stringify({ version: 2, tasks: [{
    id: 't-1', title: '在办', status: 'doing', links: [{ agent: 'kimi', session_id: 'session_x' }],
    execution_role: { kind: 'business', origin: 'explicit_task' }, source: { kind: 'manual' },
    created_at: NOW, updated_at: NOW,
  }], sprints: [], modules: [], project_meta: [] }))
  const tasks = createTasksService({ file, now: () => NOW_SEC })
  let releaseRead: ((text: string) => void) | undefined
  const firstRead = new Promise<string>(resolve => { releaseRead = resolve })
  let readCalls = 0
  const reconciler = createExecutionReconciler({
    tasks, jobLog: createJobLog({ now: () => new Date(NOW) }), now: () => new Date(NOW), idleTtlMs: 0,
    authorize: async () => ({ agent: 'kimi', session_id: 'session_x', file: '/virtual/wire.jsonl', format: 'kimi-wire' }),
    read: () => {
      readCalls++
      return readCalls === 1 ? firstRead : Promise.resolve('{"type":"turn.prompt","time":1}\n')
    },
  })
  expect(reconciler.snapshot()).toBeUndefined()
  const p1 = reconciler.request()
  const p2 = reconciler.request()
  const p3 = reconciler.request()
  releaseRead!('{"type":"turn.prompt","time":1}\n')
  const result = await p1
  // 合并:三个调用只跑一份在途对账(其间没有新的任务账写,不补拍);后来的两个拿到链式结果,
  // 三个结果都带同一张卡的对账投影,队列没有越排越长。
  const merged2 = await p2
  const merged3 = await p3
  expect(readCalls).toBe(1)
  expect(result.tasks.tasks.map(one => one.id)).toEqual(['t-1'])
  expect(merged2).toBe(result)
  expect(merged3).toBe(result)
  expect(reconciler.snapshot()).toBe(result)
  reconciler.dispose()
}, 30_000)
