// @vitest-environment node
/**
 * 窗口槽「拉进来」(2026-09-25,卡 fix/quota-and-slot-apps)。
 *
 * 维护者 09-24 引导 ④:「你刚刚讲那几个都放进去」→ 她说「窗口槽摆好了」→ 窗口槽是空的
 * (apps.json 里只多了 enabled:[claude,codex,kimi,wechat,wecom])。原话:「他说把一些应用拉进去,它也没拉啊」。
 *
 * 这里钉的是:
 * 1. enabled 里还没进窗口槽的那几家出现在 `/state.dock.pending`(标签上写「点一下拉进来」);
 * 2. `claimEnabled` 把开着的那几家程序化认领进来:摆进窗位、藏起来(**不换当前在台的那一扇**),
 *    **不替他开应用**(没开着的 = not_running);
 * 3. `claim(app)`(标签上点的那一下):先开、再拉、置前、藏起上一位;拉不成就把原因写进 dock.note;
 * 4. `claimPreview` 只读,一扇窗都不动;
 * 5. 拉进来之后与拖进来的一模一样:回声 moved 不会被当成新认领,✕ 放出送回原位,放出之后回到 pending。
 *
 * 用真 appsRegistry(临时 apps.json)+ 假壳 + 假 lsappinfo:真实的窗口一扇都不碰。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperRect, WorkbenchState } from '../src/protocol.ts'
import { APP_BUNDLES } from '../src/server/activation.ts'
import { createAppsRegistry } from '../src/server/appsRegistry.ts'
import { APP_COMMANDS } from '../src/server/apps.ts'
import type { DockService } from '../src/server/dock.ts'
import { createDockService, loadDockFile } from '../src/server/dock.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const noSleep = (): Promise<void> => Promise.resolve()

/** 页面槽位矩形 + screen_info → 屏幕上的窗位 {100,100,400,300}(webview 在原点、scale=1)。 */
const SLOT_PAGE_RECT = { x: 100, y: 100, w: 400, h: 300 }
const SLOT_SCREEN = { x: 100, y: 100, w: 400, h: 300 }
const SCREEN_INFO = { webview: { x: 0, y: 0, w: 2000, h: 1200 }, scale: 1 }

const B = {
  claude: APP_BUNDLES.claude ?? '',
  codex: APP_BUNDLES.codex ?? '',
  kimi: APP_BUNDLES.kimi ?? '',
  wechat: APP_BUNDLES.wechat ?? '',
  wecom: APP_BUNDLES.wecom ?? '',
}

/** 各家的窗在哪(认领前那一帧,放出时要送回这里)。 */
const HOME: Record<string, HelperRect> = {
  [B.claude]: { x: 900, y: 50, w: 800, h: 600 },
  [B.codex]: { x: 950, y: 80, w: 800, h: 600 },
  [B.kimi]: { x: 1000, y: 90, w: 700, h: 500 },
  [B.wechat]: { x: 1100, y: 120, w: 600, h: 500 },
  [B.wecom]: { x: 1150, y: 130, w: 600, h: 500 },
}

interface World {
  running: Set<string>
  /** 开着但一扇窗都没有的(企业微信常驻后台那种)。 */
  windowless: Set<string>
  /** 壳整个不通时的报错(辅助功能没授权 / 工作台 App 没连上)。 */
  helperDown?: string
}

function fakeShell(world: World) {
  const calls: HelperRequest[] = []
  // 各家此刻的窗帧:认领前在 HOME,`set_window_frame` 之后就在那儿(2026-10-12 起贴完会再量一眼,假壳得记住贴到哪了)。
  const frames = new Map<string, HelperRect>(Object.entries(HOME))
  const channel = {
    request: (req: HelperRequest): Promise<Record<string, unknown>> => {
      calls.push(req)
      if (world.helperDown !== undefined) return Promise.reject(new Error(world.helperDown))
      if (req.op === 'screen_info') return Promise.resolve(SCREEN_INFO)
      if (req.op === 'app_info') {
        const running = world.running.has(req.bundle_id)
        const frame = frames.get(req.bundle_id)
        const windows = !running || world.windowless.has(req.bundle_id) || frame === undefined ? [] : [{ index: 0, frame }]
        return Promise.resolve({ running, hidden: false, windows })
      }
      if (req.op === 'set_window_frame') frames.set(req.bundle_id, req.frame)
      return Promise.resolve({})
    },
  }
  return { calls, channel }
}

/** lsappinfo 看 world.running;`open -b <包标识>` 记下来,并让那一家"开起来"。 */
function fakeCommands(world: World) {
  const opens: string[][] = []
  const runCommand = async (cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> => {
    if (cmd[0] === 'lsappinfo') {
      const bundle = cmd.at(-1) ?? ''
      return { ok: true, stdout: world.running.has(bundle) ? '"pid"=321\n' : '' }
    }
    opens.push([...cmd])
    // 一律按包标识拉起(2026-09-28):命令最后一段就是包标识,不再按显示名反查。
    const bundle = cmd.at(-1) ?? ''
    if (bundle !== '') world.running.add(bundle)
    return { ok: true, stdout: '' }
  }
  return { opens, runCommand }
}

async function setup(options: {
  enabled?: string[]
  running?: string[]
  windowless?: string[]
  helperDown?: string
  slot?: boolean
  firstRun?: boolean
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dock-claim-'))
  const appsFile = join(dir, 'apps.json')
  const dockFile = join(dir, 'dock.json')
  await writeFile(appsFile, JSON.stringify({
    version: 1,
    apps: [],
    disabled: [],
    enabled: options.enabled ?? ['claude', 'codex', 'kimi', 'wechat', 'wecom'],
  }))
  const world: World = {
    running: new Set(options.running ?? []),
    windowless: new Set(options.windowless ?? []),
    ...(options.helperDown === undefined ? {} : { helperDown: options.helperDown }),
  }
  const shell = fakeShell(world)
  const commands = fakeCommands(world)
  const registry = createAppsRegistry({ file: appsFile, runOsascript: async () => ({ ok: false, stdout: '' }) })
  let changed = 0
  const dock = createDockService({
    file: dockFile,
    helper: shell.channel,
    registry,
    runCommand: commands.runCommand,
    sleep: noSleep,
    onChanged: () => { changed += 1 },
    ...(options.firstRun === undefined ? {} : { firstRun: () => options.firstRun === true }),
  })
  if (options.slot !== false) dock.setSlotRect(SLOT_PAGE_RECT)
  // setSlotRect 把悬停圈推送排进写队列;等它先走完,免得算进用例的 calls 里。
  await dock.view()
  await new Promise(resolve => setTimeout(resolve, 5))
  shell.calls.length = 0
  return { dock, world, shell, commands, dockFile, appsFile, changed: () => changed }
}

const ops = (calls: readonly HelperRequest[], op: HelperRequest['op']) => calls.filter(call => call.op === op)

describe('/state.dock.pending:他要的、还没拉进来的那几家', () => {
  it('★维护者那份 apps.json(enabled 五家、叠是空的)→ 五个 pending,按他说的顺序', async () => {
    const { dock } = await setup()
    const view = await dock.view()
    expect(view?.stack).toEqual([])
    expect(view?.pending).toEqual([
      { key: 'claude', label: 'Claude' },
      { key: 'codex', label: 'Codex' },
      { key: 'kimi', label: 'Kimi' },
      { key: 'wechat', label: '微信' },
      { key: 'wecom', label: '企业微信' },
    ])
  })

  it('enabled 是空的 → 这一格整格缺席(与这一版之前逐字相同)', async () => {
    const { dock } = await setup({ enabled: [] })
    expect((await dock.view())?.pending).toBeUndefined()
  })
})

describe('claimEnabled:一口气拉进来(引导落地点「就这样」之后)', () => {
  it('★开着的三家拉进来:摆进窗位、藏起来,不置前、不换当前那一扇;没开着的两家不替他开', async () => {
    const { dock, shell, commands, dockFile, changed } = await setup({ running: [B.claude, B.codex, B.kimi] })
    const report = await dock.claimEnabled?.()
    expect(report?.results.map(row => [row.app, row.state])).toEqual([
      ['claude', 'claimed'], ['codex', 'claimed'], ['kimi', 'claimed'], ['wechat', 'not_running'], ['wecom', 'not_running'],
    ])
    expect(report?.ok).toBe(false)
    expect(report?.claimed).toEqual([{ app: 'claude', label: 'Claude' }, { app: 'codex', label: 'Codex' }, { app: 'kimi', label: 'Kimi' }])
    expect(report?.pending.map(row => row.app)).toEqual(['wechat', 'wecom'])
    expect(report?.pending[0]?.note).toContain('标签上点一下,会先打开再拉进来')

    // 三扇窗都摆进了窗位,没有一扇被置前;摆完各自藏起来。
    expect(ops(shell.calls, 'set_window_frame').map(call => call.op === 'set_window_frame' && [call.bundle_id, call.frame]))
      .toEqual([[B.claude, SLOT_SCREEN], [B.codex, SLOT_SCREEN], [B.kimi, SLOT_SCREEN]])
    expect(ops(shell.calls, 'raise_window')).toEqual([])
    expect(ops(shell.calls, 'hide_app').map(call => call.op === 'hide_app' && call.bundle_id)).toEqual([B.claude, B.codex, B.kimi])
    // 没开着的一个都没替他开。
    expect(commands.opens).toEqual([])

    const saved = await loadDockFile(dockFile)
    expect(saved.stack.map(item => item.app)).toEqual(['claude', 'codex', 'kimi'])
    // original 是摆位之前那一帧(放出时送回这里)。
    expect(saved.stack[0]?.original).toEqual(HOME[B.claude])
    // 当前在台的那一扇不换(本来就是事务官那一档)。
    expect(saved.current).toBeNull()
    expect(changed()).toBeGreaterThan(0)

    const view = await dock.view()
    expect(view?.stack.map(tab => tab.key)).toEqual(['claude', 'codex', 'kimi'])
    expect(view?.pending).toEqual([{ key: 'wechat', label: '微信' }, { key: 'wecom', label: '企业微信' }])
  })

  it('{launch:true} 才替他把没开着的开起来,然后照样拉进来', async () => {
    const { dock, commands } = await setup({ enabled: ['wechat'], running: [] })
    const report = await dock.claimEnabled?.({ launch: true })
    expect(report?.results).toEqual([{ app: 'wechat', label: '微信', state: 'claimed' }])
    expect(commands.opens).toEqual([APP_COMMANDS.wechat])
    expect(report?.ok).toBe(true)
  })

  it('本来就在窗口槽里的记 already;全在了 ok 为真,「摆好了」这时才说得出口', async () => {
    const { dock } = await setup({ enabled: ['claude', 'codex'], running: [B.claude, B.codex] })
    await dock.claimEnabled?.()
    const again = await dock.claimEnabled?.()
    expect(again?.results.map(row => row.state)).toEqual(['already', 'already'])
    expect(again?.ok).toBe(true)
    expect(again?.pending).toEqual([])
  })

  it('开着但一扇窗都没有(企业微信常驻后台)→ 叫一次窗,还是没有就 needs_click,不拖着后面几家', async () => {
    const { dock, commands } = await setup({ enabled: ['wecom', 'claude'], running: [B.wecom, B.claude], windowless: [B.wecom] })
    const report = await dock.claimEnabled?.()
    expect(report?.results.map(row => [row.app, row.state])).toEqual([['wecom', 'needs_click'], ['claude', 'claimed']])
    expect(report?.results[0]?.note).toContain('没找到它的窗口')
    expect(report?.results[0]?.note).toContain('拖进虚线区')
    // 唤窗补发过一次 open(同切换那条路的语义),只一次。
    expect(commands.opens).toEqual([APP_COMMANDS.wecom])
  })

  it('窗位量不到(窗口槽收起 / 纯净模式)→ 开着的记 needs_click、没开着的照实说没开着;一扇窗都不动', async () => {
    const { dock, shell } = await setup({ enabled: ['claude', 'wechat'], running: [B.claude], slot: false })
    const report = await dock.claimEnabled?.()
    expect(report?.results.map(row => [row.app, row.state])).toEqual([['claude', 'needs_click'], ['wechat', 'not_running']])
    expect(report?.results[0]?.note).toContain('窗口槽这会儿没露出来')
    expect(ops(shell.calls, 'set_window_frame')).toEqual([])
  })

  it('辅助功能没授权 → failed,一句说清(点标签也没用,要先授权)', async () => {
    const { dock } = await setup({ enabled: ['claude'], running: [B.claude], helperDown: '辅助功能未授权' })
    const report = await dock.claimEnabled?.()
    expect(report?.results).toEqual([{ app: 'claude', label: 'Claude', state: 'failed', note: expect.stringContaining('辅助功能还没授权给工作台') }])
  })

  it('★第一次用(引导还没做完)也拉:这是他点了「就这样」的明确动作,不是程序自己挪窗', async () => {
    const { dock } = await setup({ enabled: ['claude'], running: [B.claude], firstRun: true })
    const report = await dock.claimEnabled?.()
    expect(report?.results[0]?.state).toBe('claimed')
  })
})

describe('claim(app):标签上「点一下拉进来」', () => {
  it('★没开着:先开、再拉、置前、藏起上一位,它成为当前那一扇;旧 note 清掉', async () => {
    const { dock, shell, commands, dockFile } = await setup({ enabled: ['claude', 'wechat'], running: [B.claude] })
    await dock.claimEnabled?.()
    await dock.switchTo('claude')
    shell.calls.length = 0

    const out = await dock.claim?.('wechat')
    expect(out).toEqual({ ok: true, state: 'claimed' })
    expect(commands.opens).toEqual([APP_COMMANDS.wechat])
    expect(ops(shell.calls, 'set_window_frame').map(call => call.op === 'set_window_frame' && call.bundle_id)).toEqual([B.wechat])
    expect(ops(shell.calls, 'raise_window').map(call => call.op === 'raise_window' && call.bundle_id)).toEqual([B.wechat])
    expect(ops(shell.calls, 'hide_app').map(call => call.op === 'hide_app' && call.bundle_id)).toEqual([B.claude])
    const saved = await loadDockFile(dockFile)
    expect(saved.current).toBe('wechat')
    expect((await dock.view())?.pending).toBeUndefined()
  })

  it('拉不成 → 那一句进窗位 note(告诉他还能把窗拖进虚线区);叠里一项都不多', async () => {
    const { dock, dockFile } = await setup({ enabled: ['wecom'], running: [B.wecom], windowless: [B.wecom] })
    const out = await dock.claim?.('wecom')
    expect(out?.state).toBe('needs_click')
    expect((await dock.view())?.note).toContain('拖进虚线区')
    expect((await loadDockFile(dockFile)).stack).toEqual([])
  })

  it('拉进来之后与拖进来的一模一样:回声 moved(程序化)不当新认领;✕ 放出送回原位,又回到 pending', async () => {
    const { dock, shell } = await setup({ enabled: ['claude'], running: [B.claude] })
    await dock.claim?.('claude')
    // 摆位那一下的回声:壳报 dragged=false,落在窗位上。
    await dock.handleMoved(B.claude, SLOT_SCREEN, false)
    const view = await dock.view()
    expect(view?.stack.map(tab => tab.key)).toEqual(['claude'])
    expect(view?.recent_moves?.at(-1)?.decision).toBe('settled')

    shell.calls.length = 0
    await dock.release('claude')
    const back = ops(shell.calls, 'set_window_frame').map(call => call.op === 'set_window_frame' && call.frame)
    expect(back).toEqual([HOME[B.claude]])
    expect((await dock.view())?.pending).toEqual([{ key: 'claude', label: 'Claude' }])
  })
})

describe('claimPreview:只读', () => {
  it('★一扇窗都不动,只说每一家会怎样:开着 = ready,没开 = not_running,已在 = already', async () => {
    const { dock, shell } = await setup({ enabled: ['claude', 'codex', 'wechat'], running: [B.claude, B.codex] })
    await dock.claim?.('codex', { raise: false })
    shell.calls.length = 0
    const report = await dock.claimPreview?.()
    expect(report?.preview).toBe(true)
    expect(report?.results.map(row => [row.app, row.state])).toEqual([['claude', 'ready'], ['codex', 'already'], ['wechat', 'not_running']])
    // 预览里 ready 不算「在窗口槽里」—— 别把它说成「摆好了」。
    expect(report?.claimed).toEqual([{ app: 'codex', label: 'Codex' }])
    expect(shell.calls.filter(call => call.op !== 'screen_info')).toEqual([])
  })
})

// ———————————————————————————— HTTP ————————————————————————————

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

async function serveDock(dock: DockService) {
  const remote = { address: '127.0.0.1' }
  const server = await startWorkbenchServer({
    port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0,
    remoteAddress: () => remote.address,
    dock,
  })
  started.push(server)
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, from = '127.0.0.1') => {
    remote.address = from
    const res = await fetch(`${server.url}${path}`, {
      method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
    })
    remote.address = '127.0.0.1'
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, any> }
  }
  return { call, url: server.url }
}

describe('HTTP:/dock/claim、/dock/claim-enabled、/dock/claim-preview', () => {
  it('★预览 → 一口气拉 → /state 里 pending 少了、stack 多了;回包就是那份 SlotClaimReport', async () => {
    const { dock } = await setup({ running: [B.claude, B.codex, B.kimi] })
    const { call, url } = await serveDock(dock)

    const preview = await call('GET', '/dock/claim-preview')
    expect(preview.status).toBe(200)
    expect(preview.body.preview).toBe(true)
    expect(preview.body.results.map((row: { state: string }) => row.state)).toEqual(['ready', 'ready', 'ready', 'not_running', 'not_running'])

    const claimed = await call('POST', '/dock/claim-enabled')
    expect(claimed.status).toBe(200)
    expect(claimed.body.claimed.map((row: { app: string }) => row.app)).toEqual(['claude', 'codex', 'kimi'])
    expect(claimed.body.pending.map((row: { app: string, state: string }) => [row.app, row.state])).toEqual([['wechat', 'not_running'], ['wecom', 'not_running']])

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.dock?.stack.map(tab => tab.key)).toEqual(['claude', 'codex', 'kimi'])
    expect(state.dock?.pending?.map(tab => tab.key)).toEqual(['wechat', 'wecom'])
  })

  it('POST /dock/claim:标签上那一下(缺省先开再拉);app 缺了 400', async () => {
    const { dock, commands } = await setup({ enabled: ['kimi'], running: [] })
    const { call } = await serveDock(dock)
    expect((await call('POST', '/dock/claim', {})).status).toBe(400)
    const res = await call('POST', '/dock/claim', { app: 'kimi' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, state: 'claimed' })
    expect(commands.opens).toEqual([APP_COMMANDS.kimi])
  })

  it('没配对的局域网来源碰不到(同 /dock/switch 的门)', async () => {
    const { dock } = await setup({ running: [B.claude] })
    const { call } = await serveDock(dock)
    expect((await call('POST', '/dock/claim-enabled', {}, '192.168.1.20')).status).toBe(403)
    expect((await call('POST', '/dock/claim', { app: 'claude' }, '192.168.1.20')).status).toBe(403)
  })

  it('没有这一档的 dock(测试替身 / 老接线)→ 三条都 404', async () => {
    const { dock } = await setup()
    const { claim: _claim, claimEnabled: _all, claimPreview: _preview, ...bare } = dock
    const { call } = await serveDock(bare as DockService)
    expect((await call('GET', '/dock/claim-preview')).status).toBe(404)
    expect((await call('POST', '/dock/claim-enabled')).status).toBe(404)
    expect((await call('POST', '/dock/claim', { app: 'claude' })).status).toBe(404)
  })
})
