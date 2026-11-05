// @vitest-environment node
/**
 * `/state` 里的两格新字段(2026-09-17「每个区域单独解锁」):`clients` 与 `model_mode`。
 *
 * 整台服务跑在真 socket 上,但扫描与模型来源都是**注入的假的** —— 一条 mdfind 都不会真跑,
 * 一个字节的真实 `~/.dsh` 都不会被碰。这正是 `clientScan` 做成"只认注入"的理由
 * (见 StartWorkbenchServerOptions.clientScan)。
 */
import { describe, expect, it, afterEach } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import type { ClientScan } from '../src/server/clientScan.ts'
import type { ModelModeReader } from '../src/server/modelMode.ts'
import type { ClientsView, WorkbenchState } from '../src/protocol.ts'

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

function fakeScan(view: ClientsView | undefined, pumped: { count: number }): ClientScan {
  return {
    view: () => view,
    pump: () => { pumped.count += 1 },
    scan: async () => view,
    invalidate: () => {},
    installedKeys: () => undefined,
  }
}

function fakeModel(mode: 'relay' | 'own' | undefined): ModelModeReader {
  return { view: () => mode, pump: () => {}, read: async () => mode }
}

const OFF = { installed: false, connected: false }
const VIEW: ClientsView = {
  claude: { installed: true, connected: true },
  codex: { installed: true, connected: false, how: '点一下,工作台帮你接上 —— 会先让你看一眼要写什么。' },
  kimi: OFF,
  wechat: { installed: true, connected: true },
  wecom: OFF,
}

async function serve(extra: Parameters<typeof startWorkbenchServer>[0] extends infer T ? Partial<T> : never = {}) {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    usageIntervalMs: 0,
    ...extra,
  })
  started.push(server)
  return server
}

async function state(server: WorkbenchServer): Promise<WorkbenchState> {
  const res = await fetch(`${server.url}/state`)
  return await res.json() as WorkbenchState
}

describe('/state.clients', () => {
  it('★没接扫描服务 → 这一格整个缺席(不是五个 false):前台据此退回"全都显示"', async () => {
    const body = await state(await serve())
    expect(body.clients).toBeUndefined()
    expect(body.model_mode).toBeUndefined()
  })

  it('接了扫描服务 → 三态原样出现在 /state 上', async () => {
    const pumped = { count: 0 }
    const body = await state(await serve({ clientScan: fakeScan(VIEW, pumped) }))
    expect(body.clients?.claude).toEqual({ installed: true, connected: true })
    expect(body.clients?.codex.installed).toBe(true)
    expect(body.clients?.codex.connected).toBe(false)
    expect(body.clients?.codex.how).toContain('帮你接上')
    expect(body.clients?.kimi).toEqual(OFF)
    // 每拍泵一次(节流在扫描服务内部),不在 /state 这条热路径上同步跑 mdfind。
    expect(pumped.count).toBeGreaterThan(0)
  })

  it('★扫描服务在、但还没扫出结果 → 这一格照样缺席', async () => {
    const body = await state(await serve({ clientScan: fakeScan(undefined, { count: 0 }) }))
    expect(body.clients).toBeUndefined()
  })

  /**
   * 2026-09-17 改判(Ben 拍板「钩子在就算」)。**这一条是反过来钉的**:
   * 以前收到一条事件就当场算接上,现在不了 —— 「接上没有」只由钩子说了算。
   *
   * 为什么反过来更好:接得上、事件也来了,但钩子其实指着另一个 checkout 的那台机器,
   * 旧判法会说"接上了",于是解锁卡不出现、那颗「帮你接上」的按钮也没处点,
   * 而他的钩子每次会话都在静默失败。判据与那颗按钮一一对应,界面才说得圆。
   */
  it('★收到过 Claude 的事件但钩子不在 → 仍然算没接上(判据只认钩子)', async () => {
    const service = createWorkbenchService()
    const scan = fakeScan({ ...VIEW, claude: { installed: true, connected: false, how: '点一下,工作台帮你接上' } }, { count: 0 })
    const server = await startWorkbenchServer({
      port: 0, service, tickIntervalMs: 0, heartbeatMs: 0, usageIntervalMs: 0, clientScan: scan,
    })
    started.push(server)
    expect((await state(server)).clients?.claude.connected).toBe(false)

    service.applyEvent({
      agent: 'claude', session_id: 's1', type: 'running', project: 'x',
      ts: Math.floor(Date.now() / 1000),
    })
    expect((await state(server)).clients?.claude.connected).toBe(false)
    // 会话本身照旧进来 —— 变的只是"接上没有"这一格的判据。
    expect((await state(server)).agents.find(agent => agent.id === 'claude')?.connected).toBe(true)
  })

  it('扫描服务自己抛异常时 /state 照常回,只是这一格缺席', async () => {
    const broken: ClientScan = {
      view: () => { throw new Error('炸了') },
      pump: () => {},
      scan: async () => undefined,
      invalidate: () => {},
      installedKeys: () => undefined,
    }
    const body = await state(await serve({ clientScan: broken }))
    expect(body.clients).toBeUndefined()
    expect(body.agents.length).toBe(4) // 别的格子一个没少
  })
})

describe('/state.model_mode', () => {
  it('model.json 不存在 → 缺席(前台按现有逻辑渲染 DeepSeek 那一格)', async () => {
    expect((await state(await serve({ modelMode: fakeModel(undefined) }))).model_mode).toBeUndefined()
  })

  it('relay / own 原样透出', async () => {
    expect((await state(await serve({ modelMode: fakeModel('relay') }))).model_mode).toBe('relay')
    expect((await state(await serve({ modelMode: fakeModel('own') }))).model_mode).toBe('own')
  })
})
