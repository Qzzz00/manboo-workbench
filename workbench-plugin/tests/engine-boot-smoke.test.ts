// @vitest-environment node
/**
 * ★ **启动冒烟:接线按生产那样接起来,起得来、8791 答得出 `/state`**
 * (2026-10-03,卡「0.4.87 启动崩溃」;交接 `docs/交接-1003-0.4.87启动崩溃.md`)。
 *
 * ## 为什么要这一条
 *
 * 0.4.87 发出去的时候**插件全量用例是绿的**,装到维护者那台上却起不来:
 * `~/.dsh/logs/web.stdout.log` 每轮只到「dsh web: http://127.0.0.1:3080/…」就停、8791 永不响应,
 * launchd 每 5 分钟重启一次,`web.stderr.log` 反复是
 * `Exception in PromiseRejectCallback` + `RangeError: Maximum call stack size exceeded`。
 *
 * 一条用例都没红,是因为**没有一条用例把那几件接线接到一起**:
 * 窗口适配器的用例自己造一份假体检表,体检表的用例自己造一份假候选名单,
 * 而崩的恰恰是「体检表的『哪几家』回头问候选名单,候选名单又去问每条通道会什么」那条**环**
 * —— 只有把三件接成生产那样才撞得上。那张卡在回环上另起过一个实例也没撞上:
 * 那一跑只过了派活那条路,没人读 `/state`、没人读体检表。
 *
 * 所以这一条留下来,**它就是发版前的那一道门**:
 * 真 `wire.ts` 造的登记处 + 引擎 + 三个适配器、真 `createAgentCaps`、真 `startWorkbenchServer`,
 * 假壳连着、家族目录那几家都装着、运行时还认出三家陌生 App(其中两家「读不到窗口」),
 * 看板 / 捎话 / 账上都有东西。断言只有两句:**起来不抛**、**`/state` 回 200**。
 *
 * ## 为什么还要把钟往前拨
 *
 * 真机上崩的不是第一拍:登记处的能力答案留 5 秒({@link CAPS_TTL_MS}),
 * 过期之后**第一次有人读 `/state`** 才踢那一轮现查、才踩进那个环。
 * 所以这一条把登记处的钟拨过那 5 秒,再读一次 `/state` —— 那才是维护者那台上崩的那一拍。
 *
 * ## 验过它真的会红
 *
 * 10-03 修之前把这里的 `capCells` 换回 0.4.87 那一格(`() => agentCaps.view()`,整张表)、
 * 登记处也退回 0.4.87 那一版,这一条当场红,而且红法与真机**逐字相同**:
 * `Exception in PromiseRejectCallback` + `RangeError: Maximum call stack size exceeded`,
 * 最后 `JavaScript heap out of memory`;堆栈正指着 `adapters/window.ts` 的 `capabilities()`
 * 与 `registry.ts` 里 `await adapter.capabilities()` 那一行。
 * 两道防线各自单独也救得住(只修登记处、接线不改,这一条也绿)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRegistryView } from '../src/protocol.ts'
import { createActionGate } from '../src/server/actionGate.ts'
import { createAgentCaps } from '../src/server/agentCaps.ts'
import { FAMILY_SOURCES } from '../src/server/agentSources.ts'
import { capTargetsFor } from '../src/server/dispatchTargets.ts'
import { CAPS_TTL_MS } from '../src/server/engine/registry.ts'
import { engineJobKey } from '../src/server/engine/engine.ts'
import { createEngineWiring } from '../src/server/engine/wire.ts'
import { createHelperChannel } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import WebSocket from 'ws'

const started: WorkbenchServer[] = []
const sockets: WebSocket[] = []
const dirs: string[] = []

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close()
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 真壳报的那一串本事(照 `workbench-app/Sources/HelperSocket.swift` 的 hello)。 */
const SHELL_CAPS = [
  'new_conversation', 'read_reply', 'agent_press', 'agent_approval', 'agent_write_ask', 'agent_stop', 'agent_pick',
]

/** 家族目录里有自己那扇窗的每一家,这台都装着(按目录里的主包)。 */
const CATALOG_PACKAGES = FAMILY_SOURCES
  .filter(one => one.self !== true && one.bundle_id !== undefined)
  .map(one => ({ family: one.agent, bundle_id: one.bundle_id as string, name: one.name }))

/**
 * 运行时才认出来的那几家陌生 App(家族目录里一条都没有;家名**就是**包标识)。
 * 真机上就是 Grok Bot / Antigravity / 可灵这三家。
 */
const EXTRA_APPS = [
  { family: 'com.anysphere.sand', name: 'Grok Bot', bundle_id: 'com.anysphere.sand' },
  { family: 'com.google.antigravity', name: 'Antigravity', bundle_id: 'com.google.antigravity' },
  { family: 'com.electron.klingai', name: '可灵', bundle_id: 'com.electron.klingai' },
]

/** 「认出是 AI 应用、可那扇窗读不到」的那几家(真机 10-02 诊断包上就是新版 Kimi 与可灵)。 */
const UNREADABLE = [
  { id: 'kimi', name: 'Kimi', bundle_id: 'com.moonshot.kimichat.kmp.mac' },
  { id: 'com.electron.klingai', name: '可灵', bundle_id: 'com.electron.klingai' },
]

/** 登记表此刻的样子(`~/.dsh/workbench/agents.json` 读出来那一份的形状)。 */
function registryView(): AgentRegistryView {
  const at = '2026-10-03T03:40:00.000Z'
  const entry = (id: string, name: string, bundle_id: string | undefined) => ({
    id,
    name,
    ...(bundle_id === undefined ? {} : { bundle_id }),
    found: { how: 'activate' as const, at, basis: '它的窗口读出来了' },
    sources: [],
    app_running: true,
    status: 'idle' as const,
    gaps: {},
    sessions: [],
    counts: { running: 0, waiting: 0, unread: 0 },
  })
  return {
    entries: [
      { ...entry('dsh', '事务官', undefined), self: true },
      ...CATALOG_PACKAGES.map(one => entry(one.family, one.name, one.bundle_id)),
      ...EXTRA_APPS.map(one => entry(one.family, one.name, one.bundle_id)),
    ],
    asking: [],
    notices: [],
    unreadable: UNREADABLE.map(one => ({
      ...one,
      why: `认出${one.name}是个 AI 应用,可读不到它的窗口`,
      detail: '不像对话窗口:没有输入框',
      at,
    })),
  }
}

/** 一个「壳」:连 /helper、报 hello(带 caps)、来什么都答应。 */
async function shell(port: number): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/helper`)
  sockets.push(ws)
  await new Promise(resolve => ws.on('open', resolve))
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Record<string, unknown>
    if (msg.kind !== 'req') return
    ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: {} }))
  })
  ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1', caps: SHELL_CAPS }))
}

/**
 * **按 `index.ts` 那样接一遍**:引擎 / 登记处 / 三个适配器 / 体检表 / 8791,
 * 一处抄生产(接线的形状一格不改),碰外面的那几下换成假的。
 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-boot-smoke-'))
  dirs.push(dir)
  /** 登记处那口钟(真机上崩的是「5 秒过期之后第一次有人读 /state」那一拍)。 */
  let registryNowMs = 1_760_000_000_000
  const jobLog = createJobLog({ file: join(dir, 'jobs.jsonl'), warn: () => {} })
  const gate = createActionGate({ phaseOf: () => 'unknown', log: jobLog, now: () => new Date() })
  let taskId = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++taskId}0000000` })
  const helper = createHelperChannel()
  const view = registryView()

  /**
   * 体检表的句柄。`index.ts` 里也是这样先占位、建完赋值 ——
   * 起服务时预热那一遍跑在建表之前,那会儿这一格缺席,按「查不到」算。
   */
  let capCellsOf: ((family: string) => ReturnType<ReturnType<typeof createAgentCaps>['cellsOf']> | undefined) | undefined

  const wiring = createEngineWiring({
    gate,
    log: jobLog,
    name: family => view.entries.find(one => one.id === family)?.name ?? family,
    gateJobOf: job => engineJobKey(job),
    sleep: () => Promise.resolve(),
    warn: () => {},
    registry: {
      installed: () => [
        ...CATALOG_PACKAGES.map(one => ({ bundle_id: one.bundle_id, running: true })),
        ...EXTRA_APPS.map(one => ({ bundle_id: one.bundle_id, running: true })),
      ],
      extra: () => EXTRA_APPS.map(one => ({ family: one.family, name: one.name, bundle_id: one.bundle_id })),
      now: () => new Date(registryNowMs),
    },
    // 协议那两条不登记:这一条用例要的是「接线起不起得来」,不去碰 ~/.claude 与 codex app-server。
    claude: false,
    codex: false,
    window: {
      helper: {
        connected: () => helper.connected(),
        supports: cap => helper.supports?.(cap) ?? false,
        request: (req, timeoutMs) => helper.request(req, timeoutMs),
      },
      bundleOf: family => view.entries.find(one => one.id === family)?.bundle_id,
      installed: family => CATALOG_PACKAGES.filter(one => one.family === family)
        .map(one => ({ bundle_id: one.bundle_id, name: one.name, running: true })),
      unreadable: () => UNREADABLE,
      nameOf: family => view.entries.find(one => one.id === family)?.name ?? family,
      /*
       * ★ **就是这一格**:生产里它从前是 `caps: () => agentCaps.view()`(整张体检表),
       * 而整张表的第一件事是算「体检哪几家」→ `capTargetsFor` → `engineRegistry.targetsNow()`
       * —— 「这条通道会什么」绕一圈回去问「有哪几家」,同步递归爆栈。
       * 现在只问这一家那几格,所以这条边不存在了(`adapters/window.ts` 的 `capCells`)。
       */
      capCells: family => capCellsOf?.(family),
      bringToFront: async () => ({ ok: true }),
      gate,
      gateJobOf: job => engineJobKey(job),
      sleep: () => Promise.resolve(),
      settleMs: 0,
      wakeWaitMs: 0,
      now: () => new Date(),
    },
  })

  /**
   * 体检表,**接线照 `index.ts` 那一份**:「体检哪几家」= 登记表 + 本机探测 + **引擎登记处那一份候选**。
   * 最后那一项正是环的另一半。
   */
  const agentCaps = createAgentCaps({
    families: () => capTargetsFor({
      registry: view,
      installed: () => true,
      engineTargets: wiring.registry.targetsNow().map(one => ({
        family: one.family,
        name: one.name,
        ...(one.bundle_id === undefined ? {} : { bundle_id: one.bundle_id }),
        can: one.can,
        ...(one.write === undefined ? {} : { write: one.write }),
        here: one.here,
      })),
    }),
    installed: () => true,
    helper: () => ({
      connected: helper.connected(),
      authorized: helper.connected(),
      newConversation: helper.supports?.('new_conversation') ?? false,
      readReply: helper.supports?.('read_reply') ?? false,
    }),
    cliFound: () => false,
    cliLogin: async () => ({ login: 'unknown' as const }),
    now: () => new Date(),
  })
  capCellsOf = family => agentCaps.cellsOf(family)

  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    helper,
    agentCaps,
    engine: wiring.engine,
    engineRegistry: wiring.registry,
    actionGate: gate,
    jobLog,
    appInstalled: () => true,
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    dispatchRun: { pollMs: 1000, resultDir: dir },
  })
  started.push(server)
  await shell(server.port)
  for (let i = 0; i < 200 && !helper.connected(); i += 1) await new Promise(resolve => setTimeout(resolve, 10))

  return {
    server,
    tasks,
    helper,
    wiring,
    agentCaps,
    /** 把登记处那口钟往前拨(真机上崩的那一拍:能力答案过期之后第一次有人读 /state)。 */
    tick: (ms: number) => { registryNowMs += ms },
  }
}

describe('启动冒烟:接线按生产那样接起来', () => {
  it('★起得来、/state 回 200(0.4.87 在真机上就是这一步爆栈,8791 永不响应)', async () => {
    const { server, tasks, wiring, tick } = await boot()

    // 看板 / 账上有东西(真机上 `~/.dsh/workbench/` 不是空的)。
    await tasks.create({ title: '[派活测试] 写一段开场白', assignee: 'kimi', source: { kind: 'session', ref: 's-1' } })
    await tasks.create({ title: '把上周的数据复盘一遍', source: { kind: 'manual' } })

    const first = await fetch(`${server.url}/state`)
    expect(first.status).toBe(200)
    const state = await first.json() as Record<string, unknown>
    expect(typeof state.now).toBe('string')
    // 候选名单真答出来了(接线接通了,不是哑着过的)。
    expect((state.agent_caps as { agents?: unknown[] } | undefined)?.agents?.length ?? 0).toBeGreaterThan(0)

    /*
     * ★ **真机上崩的是这一拍**:能力答案留 5 秒,过期之后第一次有人读 `/state` 才踢那一轮现查。
     * 拨过那 5 秒再读一次 —— 环要是还在,这里就是 `RangeError: Maximum call stack size exceeded`。
     */
    tick(CAPS_TTL_MS + 1000)
    const again = await fetch(`${server.url}/state`)
    expect(again.status).toBe(200)

    // 现查落地之后再读一次:三拍都 200,而且候选名单照旧答得出来。
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    tick(CAPS_TTL_MS + 1000)
    const third = await fetch(`${server.url}/state`)
    expect(third.status).toBe(200)
    expect(wiring.registry.targetsNow().length).toBeGreaterThan(0)
  })

  it('★候选名单上家族目录那几家与运行时认出来的那几家都在(九家,含读不到窗口的)', async () => {
    const { wiring } = await boot()
    // 第一轮现查落地(起服务时 `wire.ts` 预热过一遍)。
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0) })

    const families = (await wiring.registry.targets()).map(one => one.family)
    for (const one of CATALOG_PACKAGES) expect(families).toContain(one.family)
    for (const one of EXTRA_APPS) expect(families).toContain(one.family)
    // 读不到窗口的那一家照旧列着(「查不到」不许冒充「没有」),只是一样都不会。
    const kimi = (await wiring.registry.targets()).find(one => one.family === 'kimi')
    expect(kimi?.can.send).toBe(false)
  })

  it('★体检表问「这一家那几格」时一次都不问「体检哪几家」(环的根就在这一步)', () => {
    let askedFamilies = 0
    const caps = createAgentCaps({
      families: () => { askedFamilies += 1; return [{ id: 'kimi', title: 'Kimi' }] },
      installed: () => true,
      helper: () => ({ connected: true, authorized: true, newConversation: true, readReply: true }),
      cliFound: () => false,
      cliLogin: async () => ({ login: 'unknown' as const }),
      now: () => new Date(),
    })

    // 整张表照旧要算「哪几家」(界面上那张表就是按家排的)。
    caps.view()
    expect(askedFamilies).toBeGreaterThan(0)

    // 这一家那几格**不许**:那一步正是 0.4.87 递归爆栈的那条边。
    const before = askedFamilies
    const cells = caps.cellsOf('kimi')
    expect(cells.chat).toBeDefined()
    expect(cells.collect).toBeDefined()
    expect(askedFamilies).toBe(before)
  })
})
