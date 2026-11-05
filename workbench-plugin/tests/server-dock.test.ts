import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { ACTIVATE_SUPPRESS_MS, ECHO_SUPPRESS_MS, SWITCH_TOTAL_BUDGET_MS, createDockService, defaultDockFile, saveDockFile } from '../src/server/dock.ts'
import type { AppsRegistry } from '../src/server/appsRegistry.ts'
import { APP_BUNDLES } from '../src/server/activation.ts'

const noSleep = (): Promise<void> => Promise.resolve()

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'dock-')), 'dock.json')
}

/**
 * 条件轮询:setSlotRect 的跟随重贴是异步排进写队列的(方法本身同步返回 void,先例见
 * dock.ts 的注释),测试里没法直接 await 它——反复重取条件直到成立,同款纪律先例见
 * tests/server-dock-http.test.ts 的 until/untilAsync。
 */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 5))
  }
}

const CLAUDE_BUNDLE = 'com.example.claude'
const CODEX_BUNDLE = 'com.example.codex'
const UNKNOWN_BUNDLE = 'com.example.unknown'

/** 页面槽位矩形+screen_info,换算后的屏幕矩形是 {x:100,y:100,w:400,h:300}(webview 在原点、scale=1)。 */
const SLOT_PAGE_RECT = { x: 100, y: 100, w: 400, h: 300 }
const SCREEN_INFO = { webview: { x: 0, y: 0, w: 2000, h: 1200 }, scale: 1 }
/** 中心点 (200,200),落在槽位屏幕矩形 [100,500]x[100,400] 内。 */
const INSIDE_FRAME = { x: 150, y: 150, w: 100, h: 100 }
/** 中心点 (925,925),明显在槽位外。 */
const OUTSIDE_FRAME = { x: 900, y: 900, w: 50, h: 50 }

/** 假壳:按 op 回放脚本化响应,记录全部请求。先例见 server-scenes.test.ts。 */
function fakeHelper(script: (req: HelperRequest) => Record<string, unknown> | Error) {
  const calls: HelperRequest[] = []
  return {
    calls,
    channel: {
      request: (req: HelperRequest) => {
        calls.push(req)
        const out = script(req)
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out)
      },
    },
  }
}

function defaultScript(req: HelperRequest): Record<string, unknown> {
  if (req.op === 'screen_info') return SCREEN_INFO
  // switchTo 的唤窗探测(真机实测补)默认"已经有窗口"——大多数用例不关心唤窗细节,
  // 这样默认脚本下 switchTo 的 app_info 检查一步到位,不会意外触发唤窗循环。
  // 专门测唤窗行为的用例(见"switchTo 唤窗"describe)会用自己的脚本覆盖这个分支。
  if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: INSIDE_FRAME }] }
  return {}
}

interface RegistryEntry { key: string, label: string, bundleId: string, cmd: string[] }

/**
 * 假 registry:list/commandFor/bundleFor/keyFor 按固定名册回放;add/remove 桩着,dock 用不到。
 * addResolved(A2b)真的可写(推入 entries),用来测自愈注册——传 undefined 保持旧行为
 * (拒绝,模拟"registry 也注册不了"这种极端情况)。
 */
function fakeRegistry(entries: RegistryEntry[]): AppsRegistry {
  return {
    async list() { return entries.map(e => ({ key: e.key, label: e.label })) },
    async listAll() { return entries.map(e => ({ key: e.key, label: e.label })) },
    async enable() { return { enabled: [], already: [], unknown: [] } },
    async commandFor(key: string) { return entries.find(e => e.key === key)?.cmd },
    async bundleFor(key: string) { return entries.find(e => e.key === key)?.bundleId },
    async keyFor(bundleId: string) {
      const found = entries.find(e => e.bundleId === bundleId)
      return found === undefined ? undefined : { key: found.key, label: found.label }
    },
    async add() { return { ok: false, reason: '假 registry 不支持' } },
    async remove() { return { ok: false, reason: '假 registry 不支持' } },
    async addResolved(info: { bundle_id: string, name: string }) {
      const key = `c-${info.name.toLowerCase()}`
      entries.push({ key, label: info.name, bundleId: info.bundle_id, cmd: ['open', '-b', info.bundle_id] })
      return { ok: true, key }
    },
  }
}

const ROSTER: RegistryEntry[] = [
  { key: 'claude', label: 'Claude', bundleId: CLAUDE_BUNDLE, cmd: ['open', '-a', 'Claude'] },
  { key: 'codex', label: 'Codex', bundleId: CODEX_BUNDLE, cmd: ['open', '-a', 'Codex'] },
]

/** lsappinfo 对给定 bundle 集合回 pid,其余回空;非 lsappinfo 命令记进 opens。先例见 server-scenes.test.ts。 */
function runCommandFactory(initiallyRunning: readonly string[]) {
  const running = new Set(initiallyRunning)
  const opens: string[][] = []
  const runCommand = async (cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> => {
    if (cmd[0] === 'lsappinfo') {
      const bundleId = cmd.at(-1)
      return { ok: true, stdout: bundleId !== undefined && running.has(bundleId) ? '"pid"=123\n' : '' }
    }
    opens.push([...cmd])
    return { ok: true, stdout: '' }
  }
  return { runCommand, running, opens }
}

describe('dockService(窗位叠 v2 spec V1–V6)', () => {
  it('defaultDockFile 落在 ~/.dsh/workbench/dock.json', () => {
    expect(defaultDockFile('/Users/example')).toBe('/Users/example/.dsh/workbench/dock.json')
  })

  it('行为规格1a:slotRect 未上报 → 不认领,view().note 如实说明,不发任何 helper 请求', async () => {
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    expect(helper.calls).toEqual([])
    const view = await svc.view()
    expect(view?.stack).toEqual([])
    expect(view?.note).toBe('窗位矩形未上报,拖拽认领暂不可用')
  })

  it('行为规格1b:界内且未在叠 → 认领:record original,set_window_frame+raise,置 current,持久化', async () => {
    const helper = fakeHelper(defaultScript)
    let changed = 0
    const file = await tmpFile()
    const svc = createDockService({
      file, helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep, onChanged: () => { changed++ },
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

    expect(changed).toBe(1)
    const view = await svc.view()
    expect(view?.note).toBeUndefined()
    expect(view?.stack).toEqual([{ key: 'claude', label: 'Claude', running: false, current: true }])

    // 贴合到槽位屏幕矩形,置前;顺序:先 set_window_frame 再 raise_window。
    const setCall = helper.calls.find(c => c.op === 'set_window_frame')
    const raiseCall = helper.calls.find(c => c.op === 'raise_window')
    expect(setCall).toEqual({ op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: { x: 100, y: 100, w: 400, h: 300 } })
    expect(raiseCall).toEqual({ op: 'raise_window', bundle_id: CLAUDE_BUNDLE, index: 0 })
    expect(helper.calls.indexOf(setCall!)).toBeLessThan(helper.calls.indexOf(raiseCall!))
    // 首次认领没有"上一个 current",不该有 hide_app。
    expect(helper.calls.some(c => c.op === 'hide_app')).toBe(false)

    // 落盘后重建实例仍在(原子写),original 记的是认领前的窗口原始位置,不是槽位矩形。
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as unknown
    expect(onDisk).toEqual({
      version: 1,
      stack: [{ app: 'claude', bundle_id: CLAUDE_BUNDLE, original: INSIDE_FRAME }],
      current: 'claude',
    })
  })

  it('行为规格1b:认领第二个应用时,先 hide_app 上一个 current', async () => {
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    helper.calls.length = 0
    await svc.handleMoved(CODEX_BUNDLE, INSIDE_FRAME)

    const hideCall = helper.calls.find(c => c.op === 'hide_app')
    expect(hideCall).toEqual({ op: 'hide_app', bundle_id: CLAUDE_BUNDLE })

    const view = await svc.view()
    expect(view?.stack).toEqual([
      { key: 'claude', label: 'Claude', running: false, current: false },
      { key: 'codex', label: 'Codex', running: false, current: true },
    ])
  })

  it('fix1:摆位+置前已成功时,隐藏上一个 current 抛错 → 认领仍然成立(不回滚),note 记原因', async () => {
    const helper = fakeHelper((req) => {
      if (req.op === 'hide_app') return new Error('隐藏失败:辅助功能未授权')
      return defaultScript(req)
    })
    let changed = 0
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep, onChanged: () => { changed++ },
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // 先认领 claude,没有前任,hide_app 不会被调用
    await svc.handleMoved(CODEX_BUNDLE, INSIDE_FRAME) // 认领 codex 时要隐藏 claude,但 hide_app 会抛错

    // 窗口已经摆位+置前,现实中已经在槽位里——认领必须成立:codex 入 stack 且是 current。
    const view = await svc.view()
    expect(view?.stack).toEqual([
      { key: 'claude', label: 'Claude', running: false, current: false },
      { key: 'codex', label: 'Codex', running: false, current: true },
    ])
    expect(view?.note).toBe('已认领,但隐藏上一个应用失败:隐藏失败:辅助功能未授权')
    expect(changed).toBe(2) // 两次认领都算完整成功,各触发一次 onChanged

    // 落盘也要反映认领成立,不是只在内存里假装成功。
    const setCalls = helper.calls.filter(c => c.op === 'set_window_frame')
    expect(setCalls.some(c => c.bundle_id === CODEX_BUNDLE)).toBe(true)
  })

  it('行为规格1:查不到 registry 键(未知 bundle)→ 不认领,note 如实说明,不移动窗口', async () => {
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(UNKNOWN_BUNDLE, INSIDE_FRAME)

    expect(helper.calls.some(c => c.op === 'set_window_frame')).toBe(false)
    const view = await svc.view()
    expect(view?.stack).toEqual([])
    expect(view?.note).toContain('认领失败')
    expect(view?.note).toContain(UNKNOWN_BUNDLE)
  })

  it('行为规格1c:界内且已在叠 → 视为手动整理,不动叠序、不重新 hide/raise', async () => {
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    const beforeStack = (await svc.view())?.stack
    helper.calls.length = 0

    await svc.handleMoved(CLAUDE_BUNDLE, { x: 160, y: 160, w: 90, h: 90 }) // 仍在界内,只是挪了挪

    // 断言的本意是"没有**改动**窗口/叠序",不是"一个调用都不许发":2026-08-25 双窗堆叠
    // 起,这一分支要多查一次 app_info 才能分辨"整理"和"第二扇窗进坞"——那是只读查询,
    // 不违反本意。所以改成点名那几个会改状态的 op 都没发生。
    const MUTATING = ['set_window_frame', 'raise_window', 'hide_app', 'unhide_app']
    expect(helper.calls.filter(c => MUTATING.includes(c.op))).toEqual([])
    const after = await svc.view()
    expect(after?.stack).toEqual(beforeStack)
    expect(after?.note).toBeUndefined()
  })

  it('行为规格6:同一窗口连续 5 次界内(已认领)只产生整理更新,不重复 hide/raise/set_frame', async () => {
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    helper.calls.length = 0

    for (let i = 0; i < 5; i++) {
      await svc.handleMoved(CLAUDE_BUNDLE, { x: 150 + i, y: 150 + i, w: 100, h: 100 })
    }

    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toEqual([])
    expect(helper.calls.filter(c => c.op === 'raise_window')).toEqual([])
    expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([])
  })

  it('行为规格1d:界外且在叠 → 除名(不挪窗),是 current 则 current=null,持久化', async () => {
    const helper = fakeHelper(defaultScript)
    let changed = 0
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep, onChanged: () => { changed++ },
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    changed = 0
    helper.calls.length = 0

    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME)

    expect(changed).toBe(1)
    expect(helper.calls.some(c => c.op === 'set_window_frame')).toBe(false) // 绝不替用户挪窗
    const view = await svc.view()
    expect(view?.stack).toEqual([])
  })

  it('switchTo:不在叠 → {ok:false, reason:"未认领:先把窗口拖进窗位"}', async () => {
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    const result = await svc.switchTo('claude')
    expect(result).toEqual({ ok: false, reason: '未认领:先把窗口拖进窗位' })
  })

  it('fix2:switchTo 时槽位矩形未知 → 独立文案(不复用 handleMoved 的拖拽文案)', async () => {
    const helper = fakeHelper(defaultScript)
    const file = await tmpFile()
    const { runCommand } = runCommandFactory([CLAUDE_BUNDLE])
    const registry = fakeRegistry(ROSTER)
    // 先用一个知道槽位矩形的实例完成认领。
    const adopter = createDockService({ file, helper: helper.channel, registry, runCommand, sleep: noSleep })
    adopter.setSlotRect(SLOT_PAGE_RECT)
    await adopter.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

    // 再用一个从没上报过槽位矩形的实例(如服务重启、页面还没来得及上报)调用 switchTo。
    const svc = createDockService({ file, helper: helper.channel, registry, runCommand, sleep: noSleep })
    const callsBefore = helper.calls.length
    const result = await svc.switchTo('claude')
    expect(result).toEqual({ ok: false, reason: '窗位矩形未上报,暂不能切换——刷新工作台页面后重试' })
    const view = await svc.view()
    expect(view?.note).toBe('窗位矩形未上报,暂不能切换——刷新工作台页面后重试')
    // M6:矩形检查挪到了所有副作用之前——矩形未知时这条切换是零 helper 窗口操作
    // (isRunning 探测走的是 runCommand,不占 helper.calls,这里断言的是真没碰过窗口)。
    expect(helper.calls.length).toBe(callsBefore)
  })

  it('switchTo:在叠且运行中 → unhide→set_frame→raise→隐藏上一个 current→置 current 落盘', async () => {
    const helper = fakeHelper(defaultScript)
    let changed = 0
    const { runCommand } = runCommandFactory([CLAUDE_BUNDLE, CODEX_BUNDLE])
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand, sleep: noSleep, onChanged: () => { changed++ },
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    await svc.handleMoved(CODEX_BUNDLE, INSIDE_FRAME) // current 现在是 codex,claude 已被隐藏
    changed = 0
    helper.calls.length = 0

    const result = await svc.switchTo('claude')
    expect(result).toEqual({ ok: true })
    expect(changed).toBe(1)

    // M6:矩形检查(screen_info)挪到了所有副作用之前——比 isRunning 之外唯一会摆窗的
    // unhide_app 更早,矩形查不到就不该先把窗口从隐藏里翻出来。unhide 之后补一次
    // app_info 唤窗探测(真机实测补:企微常驻后台无主窗)——defaultScript 默认"已经有
    // 窗口",这里探测一次就通过,不触发唤窗循环。
    expect(helper.calls).toEqual([
      { op: 'screen_info' },
      { op: 'unhide_app', bundle_id: CLAUDE_BUNDLE },
      { op: 'app_info', bundle_id: CLAUDE_BUNDLE },
      { op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: { x: 100, y: 100, w: 400, h: 300 } },
      { op: 'raise_window', bundle_id: CLAUDE_BUNDLE, index: 0 },
      { op: 'hide_app', bundle_id: CODEX_BUNDLE },
    ])

    const view = await svc.view()
    expect(view?.stack).toEqual([
      { key: 'claude', label: 'Claude', running: true, current: true },
      { key: 'codex', label: 'Codex', running: true, current: false },
    ])
  })

  it('switchTo:未运行且激活重试耗尽 → 原因如实透传,不切换 current', async () => {
    const helper = fakeHelper(defaultScript)
    const factory = runCommandFactory([]) // claude 起始未运行,且没人会让它跑起来
    const registry = fakeRegistry(ROSTER)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry, runCommand: factory.runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    // 先用"已运行"状态认领两个(避免认领步骤本身牵扯激活),codex 后认领成为 current,
    // 再让 claude 退出且没人能把它拉起来,验证 switchTo 会先尝试激活、失败后不改动 current。
    factory.running.add(CLAUDE_BUNDLE)
    factory.running.add(CODEX_BUNDLE)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    await svc.handleMoved(CODEX_BUNDLE, INSIDE_FRAME)
    factory.running.delete(CLAUDE_BUNDLE)

    const result = await svc.switchTo('claude')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('激活失败')
    const view = await svc.view()
    expect(view?.stack.find(t => t.key === 'codex')?.current).toBe(true) // current 仍是 codex,没切换成功
  }, 15_000)

  it('switchTo:未运行→激活成功后正常切换(runCommand 在 open 后转为运行中)', async () => {
    const helper = fakeHelper(defaultScript)
    const running = new Set<string>()
    const runCommand = async (cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> => {
      if (cmd[0] === 'lsappinfo') {
        const bundleId = cmd.at(-1)
        return { ok: true, stdout: bundleId !== undefined && running.has(bundleId) ? '"pid"=123\n' : '' }
      }
      if (cmd[0] === 'open' && cmd.includes('Claude')) running.add(CLAUDE_BUNDLE)
      return { ok: true, stdout: '' }
    }
    const registry = fakeRegistry(ROSTER)
    const svc = createDockService({ file: await tmpFile(), helper: helper.channel, registry, runCommand, sleep: noSleep })
    svc.setSlotRect(SLOT_PAGE_RECT)
    running.add(CLAUDE_BUNDLE) // 认领时先让它"在运行"
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    running.delete(CLAUDE_BUNDLE) // 之后模拟它退出了

    const result = await svc.switchTo('claude')
    expect(result).toEqual({ ok: true })
    expect(running.has(CLAUDE_BUNDLE)).toBe(true) // ensureRunningWith 确实把它拉起来了
  })

  it('switchTo:helper 请求失败 → 原因如实透传,note 记录', async () => {
    let failNow = false // 认领步骤本身也会发 set_window_frame,先让认领顺利完成再打开失败开关
    const helper = fakeHelper((req) => {
      if (req.op === 'set_window_frame' && failNow) return new Error('贴合失败:窗口没了')
      return defaultScript(req)
    })
    const { runCommand } = runCommandFactory([CLAUDE_BUNDLE])
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER), runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    failNow = true

    const result = await svc.switchTo('claude')
    expect(result).toEqual({ ok: false, reason: '贴合失败:窗口没了' })
    const view = await svc.view()
    expect(view?.note).toBe('贴合失败:窗口没了')
  })

  describe('switchTo 唤窗(真机实测:企业微信 running 但常驻后台、主窗口数=0)', () => {
    it('unhide 后 app_info 首次是零窗口 → 补发一次 open 唤窗,窗口出现后正常摆位+置前+ok:true', async () => {
      let appInfoCalls = 0
      const helper = fakeHelper((req) => {
        if (req.op === 'app_info') {
          appInfoCalls++
          return appInfoCalls === 1
            ? { running: true, hidden: false, windows: [] }
            : { running: true, hidden: false, windows: [{ index: 0, frame: INSIDE_FRAME }] }
        }
        return defaultScript(req)
      })
      const opens: string[][] = []
      const runCommand = async (cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> => {
        if (cmd[0] === 'lsappinfo') return { ok: true, stdout: '"pid"=1\n' } // 全程算在跑,不牵扯激活重试
        opens.push([...cmd])
        return { ok: true, stdout: '' }
      }
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER), runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // 认领(不经过 switchTo,不占 appInfoCalls)

      const result = await svc.switchTo('claude')

      expect(result).toEqual({ ok: true })
      expect(opens).toEqual([['open', '-a', 'Claude']]) // 唤窗命令只发了一次
      expect(appInfoCalls).toBe(2) // 第一次查到零窗口,补唤后第二次查到窗口就返回,不用等满 10 次
      const setCall = helper.calls.find(c => c.op === 'set_window_frame')
      expect(setCall).toEqual({ op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: { x: 100, y: 100, w: 400, h: 300 } })
      expect(helper.calls.some(c => c.op === 'raise_window' && c.bundle_id === CLAUDE_BUNDLE)).toBe(true)
    })

    it('唤窗后窗口始终没出现(等满上限)→ ok:false,原因是壳对 set_window_frame 的真实报错(不编新话);open 只发一次不是每轮都发', async () => {
      let appInfoCalls = 0
      let failSetFrame = false // 认领步骤本身也会发 set_window_frame,先让认领顺利完成再打开失败开关
      const helper = fakeHelper((req) => {
        if (req.op === 'app_info') { appInfoCalls++; return { running: true, hidden: false, windows: [] } }
        if (req.op === 'set_window_frame' && failSetFrame) return new Error('没有第 0 个窗口(共 0 个)')
        return defaultScript(req)
      })
      const opens: string[][] = []
      const runCommand = async (cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> => {
        if (cmd[0] === 'lsappinfo') return { ok: true, stdout: '"pid"=1\n' }
        opens.push([...cmd])
        return { ok: true, stdout: '' }
      }
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER), runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      failSetFrame = true

      const result = await svc.switchTo('claude')

      expect(result).toEqual({ ok: false, reason: '没有第 0 个窗口(共 0 个)' })
      expect(opens).toEqual([['open', '-a', 'Claude']]) // 等满上限期间只在第一轮补发过一次,不是每轮都发
      expect(appInfoCalls).toBe(10) // 等满了 DOCK_WINDOW_WAIT_TRIES
      const view = await svc.view()
      expect(view?.note).toBe('没有第 0 个窗口(共 0 个)') // 原样透传壳的真实报错,不重新编一句
    })
  })

  /**
   * 切换预算(2026-09-21 Ben:「今天点击标签切换应用经常卡住」)。
   *
   * 根因是壳侧每一次 AX 调用都在无限期同步等目标应用回话(负载 100–200 时一次切换要好几秒,
   * 负载降到 5 之后同一条路只要 40ms)。壳那边给每个 AXUIElement 上了 1 秒的消息时限;
   * 这里验的是服务端这一半:**先抬后藏、藏别家有预算、超了进后台队列、整件事不超过总预算**。
   *
   * 时钟是注入的假时钟,`sleep` 推进它 —— 耗时必须能被精确摆布,不能靠真等。
   */
  describe('switchTo 预算(2026-09-21 点标签切换经常卡住)', () => {
    /** 假时钟 + 会推进时钟的 sleep:唤窗每等一轮就真的"过去"500ms。 */
    function fakeClock() {
      let t = 1_000_000 // 不从 0 起,免得跟"未设置"这类缺省值混淆
      return {
        now: () => t,
        sleep: async (ms: number) => { t += ms },
      }
    }

    it('预算内的一次切换:记一条 recent_switches(抬窗耗时单独算,藏了 1 家,没有延后、没有超时)', async () => {
      const helper = fakeHelper(defaultScript)
      const clock = fakeClock()
      const { runCommand } = runCommandFactory([CLAUDE_BUNDLE, CODEX_BUNDLE])
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand, sleep: clock.sleep, now: clock.now,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      await svc.handleMoved(CODEX_BUNDLE, INSIDE_FRAME) // current = codex

      expect(await svc.switchTo('claude')).toEqual({ ok: true })

      const view = await svc.view()
      expect(view?.recent_switches).toHaveLength(1)
      const entry = view?.recent_switches?.[0]
      expect(entry?.app).toBe('claude')
      expect(entry?.ok).toBe(true)
      expect(entry?.hidden).toBe(1) // 上一位 current(codex)当场藏掉了
      expect(entry?.deferred).toBeUndefined() // 缺省即"没有延后",不摆一个恒为 0 的字段
      expect(entry?.timed_out).toBeUndefined()
      expect(entry?.total_ms).toBeGreaterThanOrEqual(entry?.raise_ms ?? 0)
      // 当场藏的那一家进 recent_hides,decision 说清是切换藏的(不跟事务官清理混)。
      expect(view?.recent_hides?.at(-1)).toMatchObject({ app: 'codex', decision: 'switch' })
    })

    it('★抬窗吃光总预算 → 藏别家一家都不当场藏,整批进后台队列;切换本身照样 ok,不让用户等收尾', async () => {
      // 唤窗永远查不到窗口:每轮 sleep 推进 500ms,总预算 3 秒因此会在第 7 轮到点。
      const helper = fakeHelper((req) => {
        if (req.op === 'app_info') return { running: true, hidden: false, windows: [] }
        return defaultScript(req)
      })
      const clock = fakeClock()
      const runCommand = async (cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> => {
        if (cmd[0] === 'lsappinfo') return { ok: true, stdout: '"pid"=1\n' }
        return { ok: true, stdout: '' }
      }
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand, sleep: clock.sleep, now: clock.now,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      await svc.handleMoved(CODEX_BUNDLE, INSIDE_FRAME) // current = codex
      helper.calls.length = 0

      const startedAt = clock.now()
      expect(await svc.switchTo('claude')).toEqual({ ok: true })
      const elapsed = clock.now() - startedAt

      // 整件事没超过总预算(SWITCH_TOTAL_BUDGET_MS=3000):唤窗到点就停,不再等满 10×500ms。
      expect(elapsed).toBeLessThanOrEqual(SWITCH_TOTAL_BUDGET_MS)
      expect(helper.calls.filter(c => c.op === 'app_info')).toHaveLength(6) // 6×500ms 就到点了,不是等满 10 次

      // 回给用户的那一刻,codex 还没被藏 —— 它进了后台队列。
      const view = await svc.view()
      const entry = view?.recent_switches?.[0]
      expect(entry?.ok).toBe(true)
      expect(entry?.hidden).toBe(0)
      expect(entry?.deferred).toBe(1)
      expect(entry?.raise_ms).toBe(SWITCH_TOTAL_BUDGET_MS)

      // 后台队列随后真的把它藏了(慢慢藏,不是丢掉)。
      await until(() => helper.calls.some(c => c.op === 'hide_app' && c.bundle_id === CODEX_BUNDLE))
      const after = await svc.view()
      expect(after?.recent_hides?.at(-1)).toMatchObject({ app: 'codex', decision: 'switch-deferred' })
    })

    it('★藏别家失败(壳超时/这家这次不动)→ 切换不算失败:窗已经抬起来了,如实把谁没动成记进 timed_out', async () => {
      let failHide = false
      const helper = fakeHelper((req) => {
        if (req.op === 'hide_app' && failHide) return new Error('壳响应超时')
        return defaultScript(req)
      })
      const clock = fakeClock()
      const { runCommand } = runCommandFactory([CLAUDE_BUNDLE, CODEX_BUNDLE])
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand, sleep: clock.sleep, now: clock.now,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      await svc.handleMoved(CODEX_BUNDLE, INSIDE_FRAME) // current = codex
      failHide = true

      expect(await svc.switchTo('claude')).toEqual({ ok: true })

      const view = await svc.view()
      // current 真的切过去了(用户点的那家在台上,这才是"切换成功"的定义)。
      expect(view?.stack.find(t => t.key === 'claude')?.current).toBe(true)
      expect(view?.note).toBeUndefined() // 收尾没做完不该冒一句让人以为切换出了事
      const entry = view?.recent_switches?.[0]
      expect(entry?.hidden).toBe(0)
      expect(entry?.timed_out).toEqual(['codex(壳响应超时)']) // 点名是谁、壳的原话
      // 没藏成的**不**进 recent_hides —— 进环就代表"已经藏掉了",那是假话。
      // (认领那条路也不记 hide,所以这一整个环到这里还是空的 ⇒ 字段缺省。)
      expect(view?.recent_hides).toBeUndefined()
    })

    it('摆位失败仍然是硬失败(只有"藏别家"那一段可以被牺牲),失败那一条也进 recent_switches', async () => {
      let failSetFrame = false
      const helper = fakeHelper((req) => {
        if (req.op === 'set_window_frame' && failSetFrame) return new Error('贴合失败:窗口没了')
        return defaultScript(req)
      })
      const clock = fakeClock()
      const { runCommand } = runCommandFactory([CLAUDE_BUNDLE])
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand, sleep: clock.sleep, now: clock.now,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      failSetFrame = true

      expect(await svc.switchTo('claude')).toEqual({ ok: false, reason: '贴合失败:窗口没了' })
      const view = await svc.view()
      expect(view?.recent_switches?.[0]).toMatchObject({ app: 'claude', ok: false })
    })

    it('观测环最多留 10 条(容量比别的环大,因为它是给人翻着看的)', async () => {
      const helper = fakeHelper(defaultScript)
      const clock = fakeClock()
      const { runCommand } = runCommandFactory([CLAUDE_BUNDLE, CODEX_BUNDLE])
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand, sleep: clock.sleep, now: clock.now,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      await svc.handleMoved(CODEX_BUNDLE, INSIDE_FRAME)

      for (let i = 0; i < 12; i++) await svc.switchTo(i % 2 === 0 ? 'claude' : 'codex')

      const view = await svc.view()
      expect(view?.recent_switches).toHaveLength(10)
      expect(view?.recent_switches?.at(-1)?.app).toBe('codex') // 最后一次是第 12 次(i=11)
    })
  })

  it('release:成功 → set_window_frame 回 original → unhide_app → 除名落盘', async () => {
    const helper = fakeHelper(defaultScript)
    let changed = 0
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep, onChanged: () => { changed++ },
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    changed = 0
    helper.calls.length = 0

    const result = await svc.release('claude')
    expect(result).toEqual({ ok: true })
    expect(changed).toBe(1)
    expect(helper.calls).toEqual([
      { op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: INSIDE_FRAME },
      { op: 'unhide_app', bundle_id: CLAUDE_BUNDLE },
    ])
    const view = await svc.view()
    expect(view?.stack).toEqual([])
  })

  it('release:不在叠 → {ok:false, reason:"未认领:先把窗口拖进窗位"}', async () => {
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    const result = await svc.release('claude')
    expect(result).toEqual({ ok: false, reason: '未认领:先把窗口拖进窗位' })
  })

  it('release:送回原位失败(尽力而为)→ 原因进返回值,但仍然 unhide 并除名', async () => {
    let failNow = false // 认领步骤本身也会发 set_window_frame,先让认领顺利完成再打开失败开关
    const helper = fakeHelper((req) => {
      if (req.op === 'set_window_frame' && failNow) return new Error('窗口已经被关掉了')
      return defaultScript(req)
    })
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    failNow = true
    helper.calls.length = 0

    const result = await svc.release('claude')
    expect(result).toEqual({ ok: false, reason: '窗口已经被关掉了' })
    // 尽力而为:unhide_app 仍然发了,叠里仍然除名。
    expect(helper.calls.some(c => c.op === 'unhide_app' && c.bundle_id === CLAUDE_BUNDLE)).toBe(true)
    const view = await svc.view()
    expect(view?.stack).toEqual([])
  })

  it('view():stack 按认领序,running 用 isRunning 现查,current 标记正确', async () => {
    const helper = fakeHelper(defaultScript)
    const { runCommand } = runCommandFactory([CODEX_BUNDLE])
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER), runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CODEX_BUNDLE, INSIDE_FRAME)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

    const view = await svc.view()
    expect(view?.stack).toEqual([
      { key: 'codex', label: 'Codex', running: true, current: false },
      { key: 'claude', label: 'Claude', running: false, current: true },
    ])
  })

  describe('S4(review,真机截图实证):view() 按 bundle_id 给标签标 im,不管 registry 键叫什么', () => {
    it('bundle_id 命中 APP_BUNDLES.wechat/wecom → 对应标签带 im 字段', async () => {
      const helper = fakeHelper(defaultScript)
      const wechatBundle = APP_BUNDLES.wechat!
      const wecomBundle = APP_BUNDLES.wecom!
      const roster = [
        ...ROSTER,
        { key: 'wechat', label: '微信', bundleId: wechatBundle, cmd: ['open', '-a', 'WeChat2'] },
        { key: 'wecom', label: '企业微信', bundleId: wecomBundle, cmd: ['open', '-a', '企业微信'] },
      ]
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(roster),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(wechatBundle, INSIDE_FRAME)
      await svc.handleMoved(wecomBundle, INSIDE_FRAME)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // 非 IM 应用,不该带 im

      const view = await svc.view()
      expect(view?.stack.find(t => t.key === 'wechat')?.im).toBe('wechat')
      expect(view?.stack.find(t => t.key === 'wecom')?.im).toBe('wecom')
      expect(view?.stack.find(t => t.key === 'claude')?.im).toBeUndefined()
    })

    it('微信被自愈注册成 c-<slug> 这样的自定义键(bundle id 反查不到基础键)→ im 仍然靠 bundle_id 认得出', async () => {
      const helper = fakeHelper((req) => {
        if (req.op === 'app_info') return { running: true, hidden: false, windows: [], name: 'WeChat2' }
        return defaultScript(req)
      })
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry([...ROSTER]),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      // registry 里没有任何键指向这个 bundle id——handleMoved 走自愈注册那条路,
      // 落地成一条 key 形如 c-wechat2 的自定义应用,不是字面量 'wechat'。
      await svc.handleMoved(APP_BUNDLES.wechat!, INSIDE_FRAME)

      const view = await svc.view()
      const tab = view?.stack[0]
      expect(tab?.key).not.toBe('wechat') // 确认走的是自愈注册,key 不是基础键
      expect(tab?.im).toBe('wechat') // 但 im 判定按 bundle_id,不受影响
    })
  })

  it('持久化:dock.json 原子写,重建实例仍在;写坏文件按空叠容错', async () => {
    const file = await tmpFile()
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file, helper: helper.channel, registry: fakeRegistry(ROSTER), runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

    const svc2 = createDockService({
      file, helper: fakeHelper(defaultScript).channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    const view2 = await svc2.view()
    expect(view2?.stack).toEqual([{ key: 'claude', label: 'Claude', running: false, current: true }])

    await writeFile(file, '{ 这不是合法 JSON')
    const svc3 = createDockService({
      file, helper: fakeHelper(defaultScript).channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    const view3 = await svc3.view()
    expect(view3?.stack).toEqual([])
  })

  it('写队列:并发的两次认领不丢更新,最终叠里两个都在', async () => {
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await Promise.all([
      svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME),
      svc.handleMoved(CODEX_BUNDLE, INSIDE_FRAME),
    ])
    const view = await svc.view()
    expect(view?.stack.map(t => t.key).sort()).toEqual(['claude', 'codex'])
  })

  it('observeTargets:回全量 registry bundle id', async () => {
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    expect((await svc.observeTargets()).sort()).toEqual([CLAUDE_BUNDLE, CODEX_BUNDLE].sort())
  })

  describe('C1:release 回声抑制(2s 窗口内忽略 original 帧的重新认领)', () => {
    it('release 后立刻 handleMoved(original 帧) → 不认领,不发任何摆位/置前调用', async () => {
      const helper = fakeHelper(defaultScript)
      let clock = 1_000_000
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep, now: () => clock,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      await svc.release('claude')
      helper.calls.length = 0

      // release 把窗口程序化送回 original(=INSIDE_FRAME),壳的回声 moved 事件带的就是这一帧。
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

      expect(helper.calls.every(c => c.op === 'screen_info')).toBe(true) // 只查了矩形,没摆位没置前
      const view = await svc.view()
      expect(view?.stack).toEqual([]) // 没有被重新认领回去
    })

    it('2s 过期后同一帧仍可再认领(用户真的又把窗口拖回来了)', async () => {
      const helper = fakeHelper(defaultScript)
      let clock = 1_000_000
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep, now: () => clock,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      await svc.release('claude')
      clock += 2001 // 抑制窗口(2s)已过期

      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

      const view = await svc.view()
      expect(view?.stack).toEqual([{ key: 'claude', label: 'Claude', running: false, current: true }])
    })
  })

  describe('A2(b):自愈注册——registry 认不出的 bundle 直接拿壳查到的展示名注册', () => {
    function scriptWithAppInfo(appInfoResult: Record<string, unknown> | Error) {
      return (req: HelperRequest): Record<string, unknown> => {
        if (req.op === 'app_info') { if (appInfoResult instanceof Error) throw appInfoResult; return appInfoResult }
        return defaultScript(req)
      }
    }

    it('keyFor 查不到 + app_info 给出 name → 自动注册并认领,onAppRegistered 被调用一次', async () => {
      const helper = fakeHelper((req) => {
        if (req.op === 'app_info') return { running: true, hidden: false, windows: [], name: 'NewApp' }
        return defaultScript(req)
      })
      let registered = 0
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry([...ROSTER]),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
        onAppRegistered: () => { registered++ },
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      await svc.handleMoved(UNKNOWN_BUNDLE, INSIDE_FRAME)

      expect(registered).toBe(1)
      const view = await svc.view()
      expect(view?.note).toBeUndefined()
      expect(view?.stack).toEqual([{ key: 'c-newapp', label: 'NewApp', running: false, current: true }])
      const setCall = helper.calls.find(c => c.op === 'set_window_frame')
      expect(setCall).toEqual({ op: 'set_window_frame', bundle_id: UNKNOWN_BUNDLE, index: 0, frame: { x: 100, y: 100, w: 400, h: 300 } })
    })

    it('app_info 请求被壳拒绝 → note 如实说明,不认领,不触发 onAppRegistered', async () => {
      const helper = fakeHelper(scriptWithAppInfo(new Error('工作台 App 断开')))
      let registered = 0
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry([...ROSTER]),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
        onAppRegistered: () => { registered++ },
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      await svc.handleMoved(UNKNOWN_BUNDLE, INSIDE_FRAME)

      expect(registered).toBe(0)
      const view = await svc.view()
      expect(view?.stack).toEqual([])
      expect(view?.note).toBe('认领失败:查不到应用信息(工作台 App 断开)')
    })

    it('app_info 给不出 name(字段缺失)→ 退回老文案,不装懂(D13)', async () => {
      const helper = fakeHelper(scriptWithAppInfo({ running: true, hidden: false, windows: [] }))
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry([...ROSTER]),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      await svc.handleMoved(UNKNOWN_BUNDLE, INSIDE_FRAME)

      const view = await svc.view()
      expect(view?.stack).toEqual([])
      expect(view?.note).toBe(`认领失败:应用清单里没有这个应用(${UNKNOWN_BUNDLE})`)
    })

    it('registry.addResolved 本身失败 → note 带上原因,不认领', async () => {
      const helper = fakeHelper(scriptWithAppInfo({ running: true, hidden: false, windows: [], name: 'NewApp' }))
      const registry = fakeRegistry([...ROSTER])
      registry.addResolved = async () => ({ ok: false, reason: '写盘失败' })
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry,
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      await svc.handleMoved(UNKNOWN_BUNDLE, INSIDE_FRAME)

      const view = await svc.view()
      expect(view?.stack).toEqual([])
      expect(view?.note).toBe('认领失败:自动注册应用失败(写盘失败)')
    })

    it('自动注册后 observeTargets() 的全量清单里出现新键(list() 已经包含它)', async () => {
      const helper = fakeHelper((req) => {
        if (req.op === 'app_info') return { running: true, hidden: false, windows: [], name: 'NewApp' }
        return defaultScript(req)
      })
      const entries = [...ROSTER]
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(entries),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      await svc.handleMoved(UNKNOWN_BUNDLE, INSIDE_FRAME)

      expect((await svc.observeTargets())).toContain(UNKNOWN_BUNDLE)
    })
  })

  describe('C2:handleMoved 里 screen_info 被拒绝时不抛出,如实记 note', () => {
    it('fake helper 的 screen_info reject → handleMoved resolve(不 reject),note 含原因', async () => {
      const helper = fakeHelper((req) => {
        if (req.op === 'screen_info') return new Error('工作台 App 断开')
        return defaultScript(req)
      })
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      await expect(svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)).resolves.toBeUndefined()

      const view = await svc.view()
      expect(view?.note).toBe('工作台 App 断开')
    })
  })

  describe('I3:setSlotRect(undefined) 清除上一次上报的矩形', () => {
    it('清除后 handleMoved → 不认领,note 如实说明矩形未上报', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      svc.setSlotRect(undefined) // 窗位隐藏/日历借位时客户端会清掉上一次的矩形

      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

      // 悬停高亮 v1 起,矩形每次变化(含清除)都会顺带推一次 hover_zone(screen_info 是它
      // 换算屏幕矩形要用到的)——那是这条 setSlotRect 调用本身的副作用,不是 handleMoved
      // 发的;这里只关心 handleMoved 没有因为矩形被清了就去移动/摆位任何窗口。
      expect(helper.calls.filter(c => c.op !== 'hover_zone' && c.op !== 'screen_info')).toEqual([])
      const view = await svc.view()
      expect(view?.stack).toEqual([])
      expect(view?.note).toBe('窗位矩形未上报,拖拽认领暂不可用')
    })

    it('清除后 switchTo → 独立文案(同未上报过一样)', async () => {
      const helper = fakeHelper(defaultScript)
      const file = await tmpFile()
      const { runCommand } = runCommandFactory([CLAUDE_BUNDLE])
      const registry = fakeRegistry(ROSTER)
      const svc = createDockService({ file, helper: helper.channel, registry, runCommand, sleep: noSleep })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      svc.setSlotRect(undefined)

      const result = await svc.switchTo('claude')
      expect(result).toEqual({ ok: false, reason: '窗位矩形未上报,暂不能切换——刷新工作台页面后重试' })
    })
  })

  describe('I4:noteObserveFailures——壳报来的挂载失败清单换成 note(M5:全量观察下先过滤噪音)', () => {
    it('写 note(经 registry.keyFor 换成 label),view() 可见', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      await svc.noteObserveFailures([CLAUDE_BUNDLE, CODEX_BUNDLE])

      const view = await svc.view()
      expect(view?.note).toBe('以下应用不支持拖拽认领:Claude、Codex')
    })

    it('M5:registry 查不到、也从未被认领过的 bundle → 当噪音丢弃,不写 note(全量观察下这是常态)', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      await svc.noteObserveFailures([UNKNOWN_BUNDLE])

      const view = await svc.view()
      expect(view?.note).toBeUndefined()
    })

    it('M5:registry 查不到,但这个 bundle 已经在窗位叠里(数据不一致的防御性兜底)→ 退回 bundle id 本身(D13)', async () => {
      const file = await tmpFile()
      // 直接造一条"已认领但 registry 反查不到"的叠——正常认领流程走不到这种状态
      // (handleMoved 认领前必须先经 keyFor/addResolved 解出键),这里只是覆盖防御分支,
      // 不让代码在这种理论上不该出现的情况下裸抛或悄悄吞掉。
      await saveDockFile(file, { version: 1, stack: [{ app: 'ghost', bundle_id: UNKNOWN_BUNDLE, original: INSIDE_FRAME }], current: null })
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file, helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      await svc.noteObserveFailures([UNKNOWN_BUNDLE])

      const view = await svc.view()
      expect(view?.note).toBe(`以下应用不支持拖拽认领:${UNKNOWN_BUNDLE}`)
    })

    it('空数组不写 note(常态)', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      await svc.noteObserveFailures([])

      const view = await svc.view()
      expect(view?.note).toBeUndefined()
    })
  })

  describe('F1(review,真机截图实证):noteObserveFailures 清除陈旧 note——上一轮失败,这轮全成功就该清', () => {
    it('先写 note,再传空数组(壳这轮 observe 全部重挂成功)→ note 被清除', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      await svc.noteObserveFailures([CLAUDE_BUNDLE])
      expect((await svc.view())?.note).toBe('以下应用不支持拖拽认领:Claude')

      await svc.noteObserveFailures([])

      expect((await svc.view())?.note).toBeUndefined()
    })

    it('先写 note,再传一批全被过滤成噪音的清单(等效于这轮没有真正失败)→ note 同样被清除', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      await svc.noteObserveFailures([CLAUDE_BUNDLE])
      expect((await svc.view())?.note).toBe('以下应用不支持拖拽认领:Claude')

      await svc.noteObserveFailures([UNKNOWN_BUNDLE]) // registry 不认识、也没被认领过——纯噪音

      expect((await svc.view())?.note).toBeUndefined()
    })

    it('不是 observe 失败写的 note(比如切换失败)不会被"这轮 observe 没失败"误清', async () => {
      let failNow = false // 认领步骤本身也会发 set_window_frame,先让认领顺利完成再打开失败开关
      const helper = fakeHelper((req) => {
        if (req.op === 'set_window_frame' && failNow) return new Error('切换失败:窗口没了')
        return defaultScript(req)
      })
      const { runCommand } = runCommandFactory([CLAUDE_BUNDLE])
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER), runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      failNow = true
      await svc.switchTo('claude') // 制造一条非 observe 失败的 note
      expect((await svc.view())?.note).toBe('切换失败:窗口没了')

      await svc.noteObserveFailures([]) // 这轮 observe 什么失败都没有

      expect((await svc.view())?.note).toBe('切换失败:窗口没了') // 原样不动,不是这里该管的
    })

    it('这轮真的有失败 → 覆盖掉上一轮的旧 note(不是清除,是换成新的)', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      await svc.noteObserveFailures([CLAUDE_BUNDLE])
      expect((await svc.view())?.note).toBe('以下应用不支持拖拽认领:Claude')

      await svc.noteObserveFailures([CODEX_BUNDLE])

      expect((await svc.view())?.note).toBe('以下应用不支持拖拽认领:Codex')
    })
  })

  describe('M7:note 的每次赋值都触发 onChanged(不去抖)', () => {
    it('"整理"分支(界内且已认领)不改叠序,但 note 赋值仍触发一次 onChanged', async () => {
      const helper = fakeHelper(defaultScript)
      let changed = 0
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep, onChanged: () => { changed++ },
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      changed = 0

      await svc.handleMoved(CLAUDE_BUNDLE, { x: 160, y: 160, w: 90, h: 90 }) // 仍在界内,只是挪了挪

      expect(changed).toBe(1)
    })

    it('noteObserveFailures 也会触发 onChanged', async () => {
      const helper = fakeHelper(defaultScript)
      let changed = 0
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep, onChanged: () => { changed++ },
      })

      await svc.noteObserveFailures([CLAUDE_BUNDLE])

      expect(changed).toBe(1)
    })
  })

  describe('S5(review,真机截图实证,取代旧的"矩形一变就跟随重贴"规则):只有 reason:\'resize\' 才跟随重贴在台窗口', () => {
    // 认领后标签栏出现把槶体往下挤,重报的新页面矩形(y 变大)。webview 在原点、scale=1,
    // 换算后的屏幕矩形与页面矩形数值相同——同款换算先例见 SLOT_PAGE_RECT 顶部注释。
    const NEW_PAGE_RECT = { x: 100, y: 160, w: 400, h: 300 }
    const NEW_SCREEN_RECT = { x: 100, y: 160, w: 400, h: 300 }

    it('被动上报(不传 reason,即便变化幅度很大)+ 有 current → 只存矩形、推悬停圈,不碰当前窗口', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // 认领,current=claude
      helper.calls.length = 0

      svc.setSlotRect(NEW_PAGE_RECT) // 不传 reason——S5 之前这里会触发跟随重贴,现在不该

      await until(() => helper.calls.some(c => c.op === 'hover_zone'))
      await new Promise(r => setTimeout(r, 30)) // 给"万一真触发了"留够反应时间
      // 悬停圈照常推(壳侧拖拽悬停高亮要实时,跟这次上报是不是被动的无关),但绝不该有
      // set_window_frame——这正是 S5 要堵住的"被动上报驱动真实窗口"。
      expect(helper.calls).toEqual([
        { op: 'screen_info' },
        { op: 'hover_zone', rect: NEW_SCREEN_RECT },
      ])
    })

    it('reason:\'resize\'(用户真的拖了窗位模块把手/slot basis 真的变了)+ 有 current → set_window_frame 用新的屏幕矩形重贴,不 raise', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // 认领,current=claude
      helper.calls.length = 0

      svc.setSlotRect(NEW_PAGE_RECT, 'resize') // 同步返回 void,重贴异步排队跑

      await until(() => helper.calls.some(c => c.op === 'set_window_frame'))
      // 矩形变化同时也会推一次悬停圈(悬停高亮 v1,合并复用同一次 screen_info 换算)——
      // 那条独立的行为专有 describe 覆盖,这里只钉住"跟随重贴不 raise"这条主线。
      // 2026-10-12 起重贴走完整的贴合路径(placeInSlot:unhide → 等窗 → 贴,不置前),所以多了 unhide_app 与一次 app_info。
      expect(helper.calls).toEqual([
        { op: 'screen_info' },
        { op: 'hover_zone', rect: NEW_SCREEN_RECT },
        { op: 'unhide_app', bundle_id: CLAUDE_BUNDLE },
        { op: 'app_info', bundle_id: CLAUDE_BUNDLE },
        { op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: NEW_SCREEN_RECT },
      ])
    })

    it('矩形不变(同值不同引用重报)→ 不发任何 helper 调用,即便传了 reason:\'resize\'', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      helper.calls.length = 0

      svc.setSlotRect({ ...SLOT_PAGE_RECT }, 'resize')

      await new Promise(r => setTimeout(r, 30)) // 给"万一真触发了"留够反应时间
      expect(helper.calls).toEqual([]) // 矩形没变,连悬停圈推送都不该有
    })

    it('无 current(还没认领任何应用)+ reason:\'resize\' → 推悬停圈,但不发 set_window_frame', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await until(() => helper.calls.some(c => c.op === 'hover_zone'))
      helper.calls.length = 0

      svc.setSlotRect(NEW_PAGE_RECT, 'resize')

      await until(() => helper.calls.some(c => c.op === 'hover_zone'))
      // 悬停圈推送不看"有没有认领窗口"——空槽位一样该有拖拽悬停的高亮反馈;
      // 只有跟随重贴(set_window_frame)才要求 current 存在。
      expect(helper.calls).toEqual([
        { op: 'screen_info' },
        { op: 'hover_zone', rect: NEW_SCREEN_RECT },
      ])
      expect(helper.calls.some(c => c.op === 'set_window_frame')).toBe(false)
    })

    it('helper 失败 + reason:\'resize\' → note 记原因,setSlotRect 本身不抛出', async () => {
      let failNow = false // 先让认领本身顺利完成(它也会发 set_window_frame),再打开失败开关
      const helper = fakeHelper((req) => {
        if (req.op === 'set_window_frame' && failNow) return new Error('贴合失败:窗口没了')
        return defaultScript(req)
      })
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      failNow = true

      expect(() => { svc.setSlotRect(NEW_PAGE_RECT, 'resize') }).not.toThrow()

      let view = await svc.view()
      const t0 = Date.now()
      while (view?.note === undefined) {
        if (Date.now() - t0 > 2000) throw new Error('等待超时:note 未出现')
        await new Promise(r => setTimeout(r, 5))
        view = await svc.view()
      }
      expect(view.note).toBe('窗位变化后自动适配失败:贴合失败:窗口没了')
    })
  })

  /**
   * 2026-09-21 fix/slot-refit-on-orientation。Ben:「我在横屏拉过来的时候,中间应用窗口
   * 是太长的,拉到竖屏之后应用窗口还是超出的」。
   *
   * 根因在客户端(壳窗口换屏时 resize 分两拍到位,最终那一拍不带 reason —— 见
   * tests/client-slot-refit-orientation.test.tsx),服务端这条路本来就通。这里把
   * **方向切换这个具体场景**单独钉一遍,免得将来有人收紧 reason 那道门时把它一起收掉:
   *   ① 横屏矩形 → 竖屏矩形(两个方向的槽形状差得远)+ reason → 当前在台的窗按新矩形贴一次;
   *   ② 同一份矩形重报 → 一次 set_window_frame 都不发;
   *   ③ 叠里其它家(不在台前的)一律不动 —— 切到它们时由 switchTo 照常按当时的槽贴。
   */
  describe('方向切换后重贴(2026-09-21):rect 变了就对**当前在台的那一扇**贴一次,叠里其它家不动', () => {
    /** 横屏下的槽(宽而矮)。webview 在原点、scale=1,换算后数值与页面矩形相同(同 SLOT_PAGE_RECT)。 */
    const LANDSCAPE_PAGE_RECT = { x: 188, y: 120, w: 1495, h: 879 }
    /** 竖屏下的槽(窄而高)——拖过去之后窗该缩成这个样子,不是停在横屏那份上。 */
    const PORTRAIT_PAGE_RECT = { x: 20, y: 900, w: 1400, h: 847 }

    it('★横屏矩形 → 竖屏矩形(带 reason)→ 只对 current 发一次 set_window_frame,用竖屏那份新矩形', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(LANDSCAPE_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // claude 认领
      await svc.handleMoved(CODEX_BUNDLE, INSIDE_FRAME) // codex 认领,claude 被藏起来
      helper.calls.length = 0

      svc.setSlotRect(PORTRAIT_PAGE_RECT, 'resize')

      await until(() => helper.calls.some(c => c.op === 'set_window_frame'))
      await new Promise(r => setTimeout(r, 30)) // 给"万一多贴了一次"留够反应时间
      const frames = helper.calls.filter(c => c.op === 'set_window_frame')
      expect(frames).toEqual([
        { op: 'set_window_frame', bundle_id: CODEX_BUNDLE, index: 0, frame: PORTRAIT_PAGE_RECT },
      ])
      // 叠里其它家(claude,此刻被藏着)一个字不动 —— 切回它时 switchTo 会按当时的槽贴。
      expect(frames.some(c => c.bundle_id === CLAUDE_BUNDLE)).toBe(false)
    })

    it('方向没真的变(同一份矩形重报)→ 一次 set_window_frame 都不发', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(LANDSCAPE_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      helper.calls.length = 0

      svc.setSlotRect({ ...LANDSCAPE_PAGE_RECT }, 'resize')

      await new Promise(r => setTimeout(r, 30))
      expect(helper.calls.some(c => c.op === 'set_window_frame')).toBe(false)
    })
  })

  describe('悬停高亮 v1:setSlotRect 推送 hover_zone(页面 1s 轮询做不了实时反馈,靠壳侧事件驱动)', () => {
    it('矩形从无到有 → 推 hover_zone,rect 是换算后的屏幕矩形', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      svc.setSlotRect(SLOT_PAGE_RECT)

      await until(() => helper.calls.some(c => c.op === 'hover_zone'))
      expect(helper.calls).toEqual([
        { op: 'screen_info' },
        { op: 'hover_zone', rect: { x: 100, y: 100, w: 400, h: 300 } },
      ])
    })

    it('矩形清除(undefined)→ 推 hover_zone {rect:null},不需要再查 screen_info', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await until(() => helper.calls.some(c => c.op === 'hover_zone'))
      helper.calls.length = 0

      svc.setSlotRect(undefined)

      await until(() => helper.calls.some(c => c.op === 'hover_zone'))
      // 壳侧走 AX 坐标不是页面坐标,清除不需要换算,不该多打一次 screen_info。
      expect(helper.calls).toEqual([{ op: 'hover_zone', rect: null }])
    })

    it('壳拒绝 hover_zone 请求 → 吞掉,不抛、不设 note,后续跟随重贴照常发生', async () => {
      const helper = fakeHelper((req) => {
        if (req.op === 'hover_zone') return new Error('壳暂时忙,拒收悬停圈')
        return defaultScript(req)
      })
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // 认领,current=claude

      // S5:跟随重贴需要 reason:'resize' 才会触发,这里就是要验证它——悬停圈推送失败
      // 不该拖累它(两者是各自独立的 best-effort)。
      svc.setSlotRect({ x: 100, y: 160, w: 400, h: 300 }, 'resize') // 矩形真的变了

      // 跟随重贴(set_window_frame)不该被悬停圈那次失败拖累——两者是各自独立的 best-effort。
      await until(() => helper.calls.some(c => c.op === 'set_window_frame' && c.frame.y === 160))
      const view = await svc.view()
      expect(view?.note).toBeUndefined() // 悬停圈推送失败是常态噪音,不值得抬升成 note
    })
  })

  describe('壳重启后呼吸圈永久消失(真机实证 2026-08-25):pushHoverZone 无条件重推悬停圈', () => {
    it('slotRect 已上报 → pushHoverZone 无条件推一次换算后的屏幕矩形(不依赖矩形是否变化)', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await until(() => helper.calls.some(c => c.op === 'hover_zone'))
      helper.calls.length = 0 // 清空 setSlotRect 自己那次推送,只看 pushHoverZone 这次

      await svc.pushHoverZone()

      // 矩形跟上一次上报的一模一样(壳重启,页面重挂上报同一矩形)——旧的
      // "矩形有变化才推"门槛会在这里挡住重推,pushHoverZone 必须无条件推。
      expect(helper.calls).toEqual([
        { op: 'screen_info' },
        { op: 'hover_zone', rect: { x: 100, y: 100, w: 400, h: 300 } },
      ])
    })

    it('slotRect 未上报 → pushHoverZone 推 {rect:null},不查 screen_info', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      await svc.pushHoverZone()

      expect(helper.calls).toEqual([{ op: 'hover_zone', rect: null }])
    })

    it('壳拒绝 hover_zone 请求 → pushHoverZone 吞掉,不抛出', async () => {
      const helper = fakeHelper((req) => {
        if (req.op === 'hover_zone') return new Error('壳暂时忙,拒收悬停圈')
        return defaultScript(req)
      })
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await until(() => helper.calls.some(c => c.op === 'hover_zone'))

      await expect(svc.pushHoverZone()).resolves.toBeUndefined()
    })
  })

  describe('S2(b)(review,真机截图实证):setSlotRect 忽略 8px 以内的噪声抖动', () => {
    it('每条边都在 8px 以内 → 零 helper 调用,不重贴、不重发悬停圈', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await until(() => helper.calls.some(c => c.op === 'hover_zone'))
      helper.calls.length = 0

      svc.setSlotRect({
        x: SLOT_PAGE_RECT.x + 5, y: SLOT_PAGE_RECT.y - 3, w: SLOT_PAGE_RECT.w + 7, h: SLOT_PAGE_RECT.h - 6,
      })

      await new Promise(r => setTimeout(r, 30)) // 给"万一真触发了"留够反应时间
      expect(helper.calls).toEqual([])
    })

    it('连续几次噪声抖动都不采纳,不会悄悄把存的矩形"磨"偏——真正的变化仍是按最初真实值算的', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // 认领,current=claude
      await until(() => helper.calls.some(c => c.op === 'hover_zone'))
      helper.calls.length = 0

      svc.setSlotRect({ ...SLOT_PAGE_RECT, x: SLOT_PAGE_RECT.x + 3 })
      svc.setSlotRect({ ...SLOT_PAGE_RECT, x: SLOT_PAGE_RECT.x - 4 })
      svc.setSlotRect({ ...SLOT_PAGE_RECT, y: SLOT_PAGE_RECT.y + 5 })
      await new Promise(r => setTimeout(r, 30))
      expect(helper.calls).toEqual([]) // 三次都被当噪声丢弃

      // 真正的变化(远超 8px)照常处理——矩形是绝对值,直接验证最终贴的就是这个新矩形
      // 本身,不是被上面那几次被丢弃的噪声值带偏累加出来的别的数。跟随重贴需要 S5 的
      // reason:'resize' 才会发生,这里传上去验证噪声门槛和 reason 门槛互不干扰。
      const realChange = { x: SLOT_PAGE_RECT.x, y: SLOT_PAGE_RECT.y + 60, w: SLOT_PAGE_RECT.w, h: SLOT_PAGE_RECT.h }
      svc.setSlotRect(realChange, 'resize')
      await until(() => helper.calls.some(c => c.op === 'set_window_frame'))
      const setCall = helper.calls.find(c => c.op === 'set_window_frame')
      expect(setCall).toEqual({ op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: realChange })
    })

    it('恰好 8px(边界值,"小于"不含等于)→ 仍然当作真正的变化,照常重发悬停圈', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await until(() => helper.calls.some(c => c.op === 'hover_zone'))
      helper.calls.length = 0

      svc.setSlotRect({ ...SLOT_PAGE_RECT, x: SLOT_PAGE_RECT.x + 8 })

      await until(() => helper.calls.some(c => c.op === 'hover_zone'))
      expect(helper.calls.some(c => c.op === 'hover_zone')).toBe(true)
    })
  })

  describe('S6(review,紧急小轮):moved 事件可观测环——验收拖拽认领靠直接证据,不靠 note/stack 这类代理指标', () => {
    it('screenRect 查不到(screen_info 被拒绝)→ 记一条 decision:no-slot', async () => {
      const helper = fakeHelper((req) => {
        if (req.op === 'screen_info') return new Error('工作台 App 断开')
        return defaultScript(req)
      })
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

      const view = await svc.view()
      expect(view?.recent_moves).toEqual([{ bundle_id: CLAUDE_BUNDLE, ts: expect.any(String), decision: 'no-slot' }])
    })

    it('矩形从未上报过(setSlotRect 没调过)→ 记一条 decision:no-slot', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

      const view = await svc.view()
      expect(view?.recent_moves).toEqual([{ bundle_id: CLAUDE_BUNDLE, ts: expect.any(String), decision: 'no-slot' }])
    })

    it('已认领 & 界内(手动整理)→ 记一条 decision:tidy', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // 先认领(这一条也会在环里留下 adopted)

      await svc.handleMoved(CLAUDE_BUNDLE, { x: 160, y: 160, w: 100, h: 100 }) // 还在槽位内挪了挪

      const view = await svc.view()
      // 2026-08-25 双窗堆叠起,这条环目多带一个可选 detail(判定依据),所以改用
      // toMatchObject 只钉住这条断言真正关心的三个字段——detail 是排障信息,
      // 它的具体措辞不该让这条用例变红。
      expect(view?.recent_moves?.at(-1)).toMatchObject({ bundle_id: CLAUDE_BUNDLE, decision: 'tidy' })
      expect(view?.recent_moves?.at(-1)?.ts).toEqual(expect.any(String))
    })

    it('已认领 & 拖出窗位(除名)→ 记一条 decision:outside', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

      await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME)

      const view = await svc.view()
      expect(view?.recent_moves?.at(-1)).toEqual({ bundle_id: CLAUDE_BUNDLE, ts: expect.any(String), decision: 'outside' })
    })

    it('未认领 & 窗位外(跟叠无关的普通移动)→ 记一条 decision:ignored', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME)

      const view = await svc.view()
      expect(view?.recent_moves).toEqual([{ bundle_id: CLAUDE_BUNDLE, ts: expect.any(String), decision: 'ignored' }])
    })

    it('C1 回声抑制命中(release 后 2s 内原地帧回弹)→ 记一条 decision:suppressed', async () => {
      const helper = fakeHelper(defaultScript)
      let clock = 1_000_000
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep, now: () => clock,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)
      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
      await svc.release('claude')

      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // release 的回声帧

      const view = await svc.view()
      expect(view?.recent_moves?.at(-1)).toEqual({ bundle_id: CLAUDE_BUNDLE, ts: expect.any(String), decision: 'suppressed' })
    })

    it('未认领 & 界内,自愈注册查 app_info 失败 → 记一条 decision:unknown-app', async () => {
      const helper = fakeHelper((req) => {
        if (req.op === 'app_info') return new Error('工作台 App 断开')
        return defaultScript(req)
      })
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry([...ROSTER]),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      await svc.handleMoved(UNKNOWN_BUNDLE, INSIDE_FRAME)

      const view = await svc.view()
      expect(view?.recent_moves).toEqual([{ bundle_id: UNKNOWN_BUNDLE, ts: expect.any(String), decision: 'unknown-app' }])
    })

    it('已认识的 bundle,但 set_window_frame 摆位失败 → 记一条 decision:adopt-failed', async () => {
      const helper = fakeHelper((req) => {
        if (req.op === 'set_window_frame') return new Error('贴合失败:窗口没了')
        return defaultScript(req)
      })
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

      const view = await svc.view()
      expect(view?.recent_moves).toEqual([{ bundle_id: CLAUDE_BUNDLE, ts: expect.any(String), decision: 'adopt-failed' }])
    })

    it('认领成功(摆位+置前都成功)→ 记一条 decision:adopted——这是 Ben 拖拽验收要直接看的那条证据', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

      const view = await svc.view()
      expect(view?.recent_moves).toEqual([{ bundle_id: CLAUDE_BUNDLE, ts: expect.any(String), decision: 'adopted' }])
    })

    it('一条 moved 事件都没收到过 → view() 不带 recent_moves 字段(缺省即无,同 note 的既有纪律)', async () => {
      const svc = createDockService({
        file: await tmpFile(), helper: fakeHelper(defaultScript).channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      const view = await svc.view()
      expect(view?.recent_moves).toBeUndefined()
    })

    it('环容量封顶 8 条:第 9 次调用把最老的一条挤出去,只留最近 8 条,按时间顺序', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      // 10 次跟叠无关的普通移动(existing===undefined && !inside → ignored),简单、
      // 互不干扰,专注验证环本身的容量行为,不掺认领这类有副作用的分支。
      for (let i = 0; i < 10; i++) {
        await svc.handleMoved(`${CODEX_BUNDLE}.${i}`, OUTSIDE_FRAME)
      }

      const view = await svc.view()
      expect(view?.recent_moves).toHaveLength(8)
      // 最老的两条(.0、.1)被挤出去了,留下的是 .2..9,顺序仍是先后到达的顺序。
      expect(view?.recent_moves?.map(m => m.bundle_id)).toEqual(
        Array.from({ length: 8 }, (_, i) => `${CODEX_BUNDLE}.${i + 2}`),
      )
    })
  })

  describe('recent_ax(Chromium AX 修复):ax_stale 诊断环 + note——先例见 recent_moves/S6', () => {
    const AX_INFO = { bundle_id: CLAUDE_BUNDLE, ax_err: -25204, ax_count: 0, cg_count: 3 }

    it('registry 认得这个 bundle → 推入环,且 setNote 提示已自动唤醒重试', async () => {
      const helper = fakeHelper(defaultScript)
      let changed = 0
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep, onChanged: () => { changed++ },
      })

      await svc.handleAxStale(AX_INFO)

      expect(changed).toBe(1)
      const view = await svc.view()
      expect(view?.recent_ax).toEqual([{ bundle_id: CLAUDE_BUNDLE, ts: expect.any(String), ax_err: -25204, ax_count: 0, cg_count: 3 }])
      expect(view?.note).toBe('「Claude」辅助功能通道休眠,已自动唤醒重试;若拖拽无反应请再拖一次')
    })

    it('registry 查不到这个 bundle(M5)→ 只进环,不写 note', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      await svc.handleAxStale({ bundle_id: UNKNOWN_BUNDLE, ax_err: -25204, ax_count: 0, cg_count: 3 })

      const view = await svc.view()
      expect(view?.recent_ax).toEqual([{ bundle_id: UNKNOWN_BUNDLE, ts: expect.any(String), ax_err: -25204, ax_count: 0, cg_count: 3 }])
      expect(view?.note).toBeUndefined()
    })

    it('ts 来自注入的 now() 时钟', async () => {
      const helper = fakeHelper(defaultScript)
      let clock = 1_700_000_000_000
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep, now: () => clock,
      })

      await svc.handleAxStale(AX_INFO)

      const view = await svc.view()
      expect(view?.recent_ax?.[0]?.ts).toBe(new Date(clock).toISOString())
    })

    it('一条 ax_stale 事件都没收到过 → view() 不带 recent_ax 字段(缺省即无,同 recent_moves 的既有纪律)', async () => {
      const svc = createDockService({
        file: await tmpFile(), helper: fakeHelper(defaultScript).channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      const view = await svc.view()
      expect(view?.recent_ax).toBeUndefined()
    })

    it('环容量封顶 8 条:第 9 次调用把最老的一条挤出去,只留最近 8 条,按时间顺序', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      for (let i = 0; i < 10; i++) {
        await svc.handleAxStale({ bundle_id: `${CODEX_BUNDLE}.${i}`, ax_err: -25204, ax_count: 0, cg_count: i })
      }

      const view = await svc.view()
      expect(view?.recent_ax).toHaveLength(8)
      expect(view?.recent_ax?.map(m => m.bundle_id)).toEqual(
        Array.from({ length: 8 }, (_, i) => `${CODEX_BUNDLE}.${i + 2}`),
      )
    })

    // 镜像 dock.ts 里的 AX_STALE_THROTTLE_MS——测试用例需要精确对齐节流边界,不导出
    // 常量就在这里复述一份数值,和源文件那个常量保持同步是这份测试自身的责任。
    const AX_STALE_THROTTLE_MS_TEST = 30_000

    describe('终审必修3:同 bundle 节流(30s),挡"环+note"整体', () => {
      it('间隔内同一 bundle 重复上报:只进环一次,note 不被重写', async () => {
        const helper = fakeHelper(defaultScript)
        let clock = 1_700_000_000_000
        const svc = createDockService({
          file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
          runCommand: runCommandFactory([]).runCommand, sleep: noSleep, now: () => clock,
        })

        await svc.handleAxStale(AX_INFO)
        const firstNote = (await svc.view())?.note
        expect(firstNote).toBe('「Claude」辅助功能通道休眠,已自动唤醒重试;若拖拽无反应请再拖一次')

        // 第二次上报换一份不同的诊断数值,若节流没挡住,环和 note 都会跟着变。
        clock += AX_STALE_THROTTLE_MS_TEST - 1_000 // 距首条不到 30s
        await svc.handleAxStale({ ...AX_INFO, ax_count: 9, cg_count: 9 })

        const view = await svc.view()
        expect(view?.recent_ax).toHaveLength(1) // 没有第二条被推进环
        expect(view?.recent_ax?.[0]?.ax_count).toBe(0) // 环里仍是第一条的原始数值,没被第二条覆盖
        expect(view?.note).toBe(firstNote) // note 没被重写
      })

      it('间隔外(达到/超过 30s):恢复正常上报,进环 + 重写 note', async () => {
        const helper = fakeHelper(defaultScript)
        let clock = 1_700_000_000_000
        const svc = createDockService({
          file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
          runCommand: runCommandFactory([]).runCommand, sleep: noSleep, now: () => clock,
        })

        await svc.handleAxStale(AX_INFO)
        clock += AX_STALE_THROTTLE_MS_TEST
        await svc.handleAxStale(AX_INFO)

        const view = await svc.view()
        expect(view?.recent_ax).toHaveLength(2)
      })

      it('不同 bundle 互不影响:节流只按各自的 bundle_id 独立计时', async () => {
        const helper = fakeHelper(defaultScript)
        let clock = 1_700_000_000_000
        const svc = createDockService({
          file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
          runCommand: runCommandFactory([]).runCommand, sleep: noSleep, now: () => clock,
        })

        await svc.handleAxStale(AX_INFO) // CLAUDE_BUNDLE
        clock += 1_000
        await svc.handleAxStale({ bundle_id: CODEX_BUNDLE, ax_err: -25204, ax_count: 0, cg_count: 1 })

        const view = await svc.view()
        expect(view?.recent_ax).toHaveLength(2) // 不同 bundle,第二条没被第一条的节流窗口挡住
      })
    })
  })

  describe('recent_rects(2026-08-25 真机实证):窗位矩形观测环——setSlotRect 每次调用都如实记一条,先例见 recent_moves/recent_ax', () => {
    it('第一次上报(此前无矩形)→ 记一条 stored:true', async () => {
      const helper = fakeHelper(defaultScript)
      let clock = 1_700_000_000_000
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep, now: () => clock,
      })

      svc.setSlotRect(SLOT_PAGE_RECT)

      const view = await svc.view()
      expect(view?.recent_rects).toEqual([
        { ts: new Date(clock).toISOString(), rect: SLOT_PAGE_RECT, stored: true },
      ])
    })

    it('reason:"resize" 一并记入环', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      svc.setSlotRect(SLOT_PAGE_RECT, 'resize')

      const view = await svc.view()
      expect(view?.recent_rects).toEqual([
        { ts: expect.any(String), rect: SLOT_PAGE_RECT, reason: 'resize', stored: true },
      ])
    })

    it('同值重报(rectEquals 挡下)→ 仍记一条,但 stored:false', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      svc.setSlotRect({ ...SLOT_PAGE_RECT }) // 同值不同引用,rectEquals 判定为没变

      const view = await svc.view()
      expect(view?.recent_rects).toHaveLength(2)
      expect(view?.recent_rects?.at(-1)).toEqual({ ts: expect.any(String), rect: SLOT_PAGE_RECT, stored: false })
    })

    it('8px 噪声门槛挡下 → 仍记一条,但 stored:false', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      svc.setSlotRect({ ...SLOT_PAGE_RECT, x: SLOT_PAGE_RECT.x + 3 }) // 3px < 8px 噪声门槛

      const view = await svc.view()
      expect(view?.recent_rects).toHaveLength(2)
      expect(view?.recent_rects?.at(-1)).toEqual({
        ts: expect.any(String), rect: { ...SLOT_PAGE_RECT, x: SLOT_PAGE_RECT.x + 3 }, stored: false,
      })
    })

    it('清除(undefined)也记入环,rect 序列化成 null', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })
      svc.setSlotRect(SLOT_PAGE_RECT)

      svc.setSlotRect(undefined)

      const view = await svc.view()
      expect(view?.recent_rects?.at(-1)).toEqual({ ts: expect.any(String), rect: null, stored: true })
    })

    it('setSlotRect 从未调用过 → view() 不带 recent_rects 字段(缺省即无,同 recent_moves/recent_ax 的既有纪律)', async () => {
      const svc = createDockService({
        file: await tmpFile(), helper: fakeHelper(defaultScript).channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      const view = await svc.view()
      expect(view?.recent_rects).toBeUndefined()
    })

    it('环容量封顶 8 条:第 9 次调用把最老的一条挤出去,只留最近 8 条,按时间顺序', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      // 10 次真正不同的矩形(每次都远超噪声门槛,确保每次都真的记录+存了新值)。
      for (let i = 0; i < 10; i++) {
        svc.setSlotRect({ ...SLOT_PAGE_RECT, x: SLOT_PAGE_RECT.x + i * 100 })
      }

      const view = await svc.view()
      expect(view?.recent_rects).toHaveLength(8)
      expect(view?.recent_rects?.map(r => r.rect?.x)).toEqual(
        Array.from({ length: 8 }, (_, i) => SLOT_PAGE_RECT.x + (i + 2) * 100),
      )
    })
  })

  /**
   * 评审补(2026-08-25 矩形上报只认壳内页面):http.ts 在 source !== 'app' 时业务层直接
   * 拒绝、根本不调用 setSlotRect——recordRejectedRect 是专供那条拒绝分支调用的方法,
   * 只往 recent_rects 环里记一条 rejected:true 的证据,绝不碰 slotRect 本身。
   */
  describe('recordRejectedRect(2026-08-25 矩形上报只认壳内页面,评审补):被拒上报只进环,不碰 slotRect', () => {
    it('记入环:rejected:true、stored:false', async () => {
      const helper = fakeHelper(defaultScript)
      let clock = 1_700_000_000_000
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep, now: () => clock,
      })

      svc.recordRejectedRect(SLOT_PAGE_RECT)

      const view = await svc.view()
      expect(view?.recent_rects).toEqual([
        { ts: new Date(clock).toISOString(), rect: SLOT_PAGE_RECT, stored: false, rejected: true },
      ])
    })

    it('rect:null(被拒的清除请求)→ 同样记入环,rejected:true', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      svc.recordRejectedRect(null)

      const view = await svc.view()
      expect(view?.recent_rects).toEqual([
        { ts: expect.any(String), rect: null, stored: false, rejected: true },
      ])
    })

    it('reason:"resize" 一并记入环', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      svc.recordRejectedRect(SLOT_PAGE_RECT, 'resize')

      const view = await svc.view()
      expect(view?.recent_rects).toEqual([
        { ts: expect.any(String), rect: SLOT_PAGE_RECT, reason: 'resize', stored: false, rejected: true },
      ])
    })

    it('slotRect 不受影响:被拒之后紧跟一次真正的 setSlotRect(同矩形)依然判定为"上一次是 undefined"、真的存', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      svc.recordRejectedRect(SLOT_PAGE_RECT) // 被拒——不该让 slotRect 变成 SLOT_PAGE_RECT
      svc.setSlotRect(SLOT_PAGE_RECT) // 如果上面那次偷偷存了,这里会被 rectEquals 判定"没变"→ stored:false

      const view = await svc.view()
      expect(view?.recent_rects).toHaveLength(2)
      expect(view?.recent_rects?.at(-1)).toEqual({ ts: expect.any(String), rect: SLOT_PAGE_RECT, stored: true })
    })

    it('环容量与 setSlotRect 共用同一个环(总数封顶 8,不是被拒/真存各自另开一份)', async () => {
      const helper = fakeHelper(defaultScript)
      const svc = createDockService({
        file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
        runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      })

      for (let i = 0; i < 5; i++) svc.recordRejectedRect({ ...SLOT_PAGE_RECT, x: SLOT_PAGE_RECT.x + i * 100 })
      for (let i = 5; i < 10; i++) svc.setSlotRect({ ...SLOT_PAGE_RECT, x: SLOT_PAGE_RECT.x + i * 100 })

      const view = await svc.view()
      expect(view?.recent_rects).toHaveLength(8)
      expect(view?.recent_rects?.map(r => r.rect?.x)).toEqual(
        Array.from({ length: 8 }, (_, i) => SLOT_PAGE_RECT.x + (i + 2) * 100),
      )
    })
  })

  describe('hideCurrent(W4:事务官标签占用窗位时把当前窗藏起来)', () => {
    const ORIGINAL = { x: 0, y: 0, w: 10, h: 10 }
    /** 两成员叠:claude 在台,codex 在后台。 */
    async function twoMemberFile(current: string | null): Promise<string> {
      const file = await tmpFile()
      await saveDockFile(file, {
        version: 1,
        stack: [
          { app: 'claude', bundle_id: CLAUDE_BUNDLE, original: ORIGINAL },
          { app: 'codex', bundle_id: CODEX_BUNDLE, original: ORIGINAL },
        ],
        current,
      })
      return file
    }
    /**
     * 壳脚本:按 bundle 回放 app_info 的可见性——`visible` 里的 bundle 报 running+未隐藏,
     * `notRunning` 里的报 running:false,其余报 hidden:true(藏得好好的)。
     */
    function visibilityScript(visible: readonly string[], notRunning: readonly string[] = []) {
      return (req: HelperRequest): Record<string, unknown> | Error => {
        if (req.op === 'app_info') {
          if (notRunning.includes(req.bundle_id)) return { running: false, hidden: false, windows: [] }
          return { running: true, hidden: !visible.includes(req.bundle_id), windows: [{ index: 0, frame: INSIDE_FRAME }] }
        }
        return {}
      }
    }
    function service(file: string, helper: ReturnType<typeof fakeHelper>) {
      return createDockService({
        file,
        helper: helper.channel,
        registry: fakeRegistry([...ROSTER]), // view() 要查展示名

        runCommand: async () => ({ ok: true, stdout: '' }),
        sleep: noSleep,
      })
    }

    it('藏起当前窗:发 hide_app、current 置 null、stack 成员一个不掉', async () => {
      const file = await twoMemberFile('claude')
      const helper = fakeHelper(() => ({}))
      const dock = service(file, helper)

      expect(await dock.hideCurrent()).toEqual({ ok: true })

      expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([
        { op: 'hide_app', bundle_id: CLAUDE_BUNDLE },
      ])
      const saved = JSON.parse(await readFile(file, 'utf8')) as { stack: unknown[], current: string | null }
      expect(saved.current).toBeNull()
      expect(saved.stack).toHaveLength(2) // 成员不掉——这是与 release 的根本区别
    })

    // 复现 Ben 报的 bug(设计-借鉴功能落位与资产区 §二):点「事务官」后窗位里偶尔有别的应用
    // 窗口盖在上面清理不干净——旧实现只藏 current 那一扇,别的成员被场景恢复/用户自己点回/
    // 双窗 secondIndex 露出来时就残留。
    it('复现:后台成员被别的路径露出来了(app_info 未隐藏)→ 一并 hide_app,并在 recent_hides 记谁被清了', async () => {
      const file = await twoMemberFile('claude')
      const helper = fakeHelper(visibilityScript([CLAUDE_BUNDLE, CODEX_BUNDLE]))
      const dock = service(file, helper)

      expect(await dock.hideCurrent()).toEqual({ ok: true })

      expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([
        { op: 'hide_app', bundle_id: CLAUDE_BUNDLE },
        { op: 'hide_app', bundle_id: CODEX_BUNDLE },
      ])
      const saved = JSON.parse(await readFile(file, 'utf8')) as { stack: unknown[], current: string | null }
      expect(saved.current).toBeNull()
      expect(saved.stack).toHaveLength(2)
      const view = await dock.view()
      expect(view?.recent_hides?.map(h => ({ app: h.app, bundle_id: h.bundle_id, decision: h.decision }))).toEqual([
        { app: 'claude', bundle_id: CLAUDE_BUNDLE, decision: 'current' },
        { app: 'codex', bundle_id: CODEX_BUNDLE, decision: 'stray' },
      ])
      expect(view?.recent_hides?.every(h => typeof h.ts === 'string')).toBe(true)
    })

    it('幂等:后台成员已经隐藏(app_info.hidden=true)或没在跑 → 不对它们发 hide_app', async () => {
      const file = await tmpFile()
      await saveDockFile(file, {
        version: 1,
        stack: [
          { app: 'claude', bundle_id: CLAUDE_BUNDLE, original: ORIGINAL },
          { app: 'codex', bundle_id: CODEX_BUNDLE, original: ORIGINAL },
          { app: 'kimi', bundle_id: UNKNOWN_BUNDLE, original: ORIGINAL },
        ],
        current: 'claude',
      })
      // claude 可见(在台),codex 藏着,kimi 压根没在跑。
      const helper = fakeHelper(visibilityScript([CLAUDE_BUNDLE], [UNKNOWN_BUNDLE]))
      const dock = service(file, helper)

      expect(await dock.hideCurrent()).toEqual({ ok: true })

      expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([
        { op: 'hide_app', bundle_id: CLAUDE_BUNDLE },
      ])
      expect((await dock.view())?.recent_hides?.map(h => h.app)).toEqual(['claude'])
    })

    it('本来就没有当前窗、成员全都藏着:只问 app_info,不发 hide_app,view 不带 recent_hides', async () => {
      const file = await twoMemberFile(null)
      const helper = fakeHelper(visibilityScript([]))
      const dock = service(file, helper)

      expect(await dock.hideCurrent()).toEqual({ ok: true })
      expect(helper.calls.every(c => c.op === 'app_info')).toBe(true)
      expect(await dock.view()).not.toHaveProperty('recent_hides')
    })

    it('事务官已在台(current=null)但某成员被露出来了 → 再点一次事务官能把它清掉', async () => {
      const file = await twoMemberFile(null)
      const helper = fakeHelper(visibilityScript([CODEX_BUNDLE]))
      const dock = service(file, helper)

      expect(await dock.hideCurrent()).toEqual({ ok: true })

      expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([
        { op: 'hide_app', bundle_id: CODEX_BUNDLE },
      ])
      const saved = JSON.parse(await readFile(file, 'utf8')) as { current: string | null }
      expect(saved.current).toBeNull()
      expect((await dock.view())?.recent_hides?.map(h => h.decision)).toEqual(['stray'])
    })

    it('壳报错:如实返回 ok:false + 原因,current 不动(不假装藏成功)', async () => {
      const file = await tmpFile()
      await saveDockFile(file, {
        version: 1,
        stack: [{ app: 'claude', bundle_id: CLAUDE_BUNDLE, original: ORIGINAL }],
        current: 'claude',
      })
      const helper = fakeHelper(() => new Error('壳没连上'))
      const dock = service(file, helper)

      const result = await dock.hideCurrent()
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('壳没连上')
      const saved = JSON.parse(await readFile(file, 'utf8')) as { current: string | null }
      expect(saved.current).toBe('claude') // 没藏成就不该说藏成了
    })

    it('当前窗藏成了、清理某个残留成员时壳报错:current 照常置 null,但 ok:false + note 点名是哪个成员', async () => {
      const file = await twoMemberFile('claude')
      const helper = fakeHelper((req) => {
        if (req.op === 'hide_app' && req.bundle_id === CODEX_BUNDLE) return new Error('AX 拒绝')
        return visibilityScript([CLAUDE_BUNDLE, CODEX_BUNDLE])(req)
      })
      const dock = service(file, helper)

      const result = await dock.hideCurrent()
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('codex')
      expect(result.reason).toContain('AX 拒绝')
      const saved = JSON.parse(await readFile(file, 'utf8')) as { current: string | null }
      expect(saved.current).toBeNull() // 当前那扇确实藏成了,current 如实置空
      const view = await dock.view()
      expect(view?.note).toBe(result.reason)
      expect(view?.recent_hides?.map(h => h.app)).toEqual(['claude']) // 没藏成的不算"被清了"
    })
  })
})

/**
 * 双窗堆叠(spec 2026-08-25「一个标签两半」)。
 *
 * 槽位屏幕矩形是 {x:100,y:100,w:400,h:300}(宽>高 → 左右劈),
 * 两半为 {100,100,196,300} 与 {304,100,196,300}(中缝 8px)。
 */
describe('双窗堆叠', () => {
  const SLOT_SCREEN = { x: 100, y: 100, w: 400, h: 300 }
  const SECOND_FRAME = { x: 200, y: 180, w: 120, h: 90 }

  /** 认领后:0 号窗贴在槽位上,1 号窗是用户即将拖进来的第二扇。 */
  function twoWindowScript(req: HelperRequest): Record<string, unknown> {
    if (req.op === 'screen_info') return SCREEN_INFO
    if (req.op === 'app_info') {
      return {
        running: true,
        hidden: false,
        windows: [
          { index: 0, frame: SLOT_SCREEN },
          { index: 1, frame: SECOND_FRAME },
        ],
      }
    }
    return {}
  }

  async function claimed(script = twoWindowScript) {
    const helper = fakeHelper(script)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    helper.calls.length = 0
    return { helper, svc }
  }

  it('第二扇窗拖进槽内 → 劈槽,两扇各贴一半、都置前', async () => {
    const { helper, svc } = await claimed()
    await svc.handleMoved(CLAUDE_BUNDLE, SECOND_FRAME)

    const frames = helper.calls.filter(c => c.op === 'set_window_frame')
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ index: 0, frame: { x: 100, y: 100, w: 196, h: 300 } })
    expect(frames[1]).toMatchObject({ index: 1, frame: { x: 304, y: 100, w: 196, h: 300 } })
    // 两扇都要置前,否则被别的窗压住就等于没铺开
    expect(helper.calls.filter(c => c.op === 'raise_window').map(c => (c as { index: number }).index)).toEqual([0, 1])

    const view = await svc.view()
    // 仍然只有一枚标签——「一个标签管两半」,不是拆成两个
    expect(view?.stack).toHaveLength(1)
    expect(view?.note).toBeUndefined()
  })

  it('已经是双窗态时,第三扇再动只当整理,不再劈', async () => {
    const { helper, svc } = await claimed()
    await svc.handleMoved(CLAUDE_BUNDLE, SECOND_FRAME)
    helper.calls.length = 0

    await svc.handleMoved(CLAUDE_BUNDLE, { x: 210, y: 190, w: 120, h: 90 })
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toEqual([])
  })

  it('槽里只有一扇窗时静默按整理处理,不写 note——挪窗是高频操作,不能每次都喊', async () => {
    const oneWindow = (req: HelperRequest): Record<string, unknown> => {
      if (req.op === 'screen_info') return SCREEN_INFO
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: SLOT_SCREEN }] }
      return {}
    }
    const { helper, svc } = await claimed(oneWindow)
    await svc.handleMoved(CLAUDE_BUNDLE, { x: 160, y: 160, w: 90, h: 90 })
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toEqual([])
    expect((await svc.view())?.note).toBeUndefined()
  })

  /**
   * 真机回归(2026-08-25 观测环实证):两扇窗的 frame **逐字相同**过
   * (`0:-1420,857,1399x819` 与 `1:-1420,857,1399x819`)。
   * 早先按 frame 反查身份的做法在这里必然认不出;改成数"槽里有几扇窗"之后,
   * 两扇都在槽内 = 双窗态,位置一样不再是问题。
   */
  it('两扇窗 frame 完全相同也能劈槽——判定看的是槽内窗口数,不是窗口身份', async () => {
    const identical = (req: HelperRequest): Record<string, unknown> => {
      if (req.op === 'screen_info') return SCREEN_INFO
      if (req.op === 'app_info') {
        return {
          running: true,
          hidden: false,
          windows: [{ index: 0, frame: SLOT_SCREEN }, { index: 1, frame: SLOT_SCREEN }],
        }
      }
      return {}
    }
    const { helper, svc } = await claimed(identical)
    await svc.handleMoved(CLAUDE_BUNDLE, SLOT_SCREEN)
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toHaveLength(2)
    expect((await svc.view())?.stack.find(t => t.key === 'claude')?.dual).toBe(true)
  })

  /**
   * 真机回归:终端按字符格对齐,请求贴 813 高、实际 819——早先 4px 容差的 frame
   * 比对会认不出入坞那扇。数窗口用的是中心点落点(insideRect),不吃这几像素误差。
   */
  it('入坞窗的实际尺寸和请求的差几像素(终端按字符格对齐)也照样认得出', async () => {
    const snapped = { x: SLOT_SCREEN.x, y: SLOT_SCREEN.y, w: SLOT_SCREEN.w - 1, h: SLOT_SCREEN.h + 6 }
    const script = (req: HelperRequest): Record<string, unknown> => {
      if (req.op === 'screen_info') return SCREEN_INFO
      if (req.op === 'app_info') {
        return {
          running: true,
          hidden: false,
          windows: [{ index: 0, frame: snapped }, { index: 1, frame: SECOND_FRAME }],
        }
      }
      return {}
    }
    const { helper, svc } = await claimed(script)
    await svc.handleMoved(CLAUDE_BUNDLE, SECOND_FRAME)
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toHaveLength(2)
    expect((await svc.view())?.note).toBeUndefined()
  })

  it('放出时两扇都回各自原位(Ben 定)', async () => {
    const { helper, svc } = await claimed()
    await svc.handleMoved(CLAUDE_BUNDLE, SECOND_FRAME)
    helper.calls.length = 0

    await svc.release('claude')
    const frames = helper.calls.filter(c => c.op === 'set_window_frame') as unknown as { index: number, frame: { x: number, y: number, w: number, h: number } }[]
    expect(frames).toHaveLength(2)
    // 主窗回它认领前那一帧,第二扇回它进坞前那一帧——各是各的,不能都送到同一个地方
    expect(frames[0]).toMatchObject({ index: 0, frame: INSIDE_FRAME })
    expect(frames[1]).toMatchObject({ index: 1, frame: SECOND_FRAME })
    expect((await svc.view())?.stack).toEqual([])
  })
})

/**
 * 程序化移动归位(2026-08-26 真机实证:微信重新登录后窗口不归位)。
 *
 * 断链现场:微信登录流程会整个重启应用、销毁旧主窗口、在默认位置新开一扇小窗
 * (819×654)。壳的 AXObserver 对这类"应用自己摆的窗口"照样报 moved 落定,落点在
 * 槽外时 handleMoved 只有"已认领&界外=用户拖出→除名"一种解释,微信因此被静默
 * 除名(recent_moves 观测环 01:46:57 decision:outside 实锤),标签消失,归位无门。
 * 企业微信侥幸没踩中,是因为它重启后自己恢复了退出前的窗口 frame(恰好=槽位),
 * 落进界内整理分支。
 *
 * 修复:壳侧落定上报带 dragged(事件风暴期间鼠标左键是否按下过)。dragged=false
 * =程序化移动(应用重建窗口/自动摆放):已认领的单窗应用一律贴回槽位(归位),
 * 已在槽位(±16px/尺寸下限容差)则什么都不做;绝不除名。dragged 缺省按 true
 * ——旧壳没有这个字段,一切按旧行为,部署兼容。
 */
describe('程序化移动归位(2026-08-26 微信重登不归位修复)', () => {
  /** 认领 claude 后清空调用记录,回一个可复用的现场。 */
  async function adopted(clockRef?: { value: number }) {
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
      ...(clockRef === undefined ? {} : { now: () => clockRef.value }),
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    helper.calls.length = 0
    return { helper, svc }
  }

  it('已认领应用程序化移出槽外(dragged:false) → 不除名,贴回槽位,记 decision:homed', async () => {
    const { helper, svc } = await adopted()

    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, false)

    const frames = helper.calls.filter(c => c.op === 'set_window_frame')
    expect(frames).toEqual([{ op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: { x: 100, y: 100, w: 400, h: 300 } }])
    const view = await svc.view()
    expect(view?.stack.map(s => s.key)).toEqual(['claude']) // 还在叠里,没有被当成拖出除名
    expect(view?.recent_moves?.at(-1)?.decision).toBe('homed')
  })

  it('归位不改写 original:放出时仍回认领前那一帧', async () => {
    const { helper, svc } = await adopted()
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, false)
    helper.calls.length = 0

    await svc.release('claude')

    const frames = helper.calls.filter(c => c.op === 'set_window_frame')
    expect(frames).toMatchObject([{ frame: INSIDE_FRAME }])
  })

  it('程序化落定已在槽位(容差内:位置±16px、尺寸不小于槽-32px) → 什么都不做,记 decision:settled', async () => {
    const { helper, svc } = await adopted()

    // 贴合回声的典型样子:应用按自己的网格/最小尺寸微调过(终端 1399×819 vs 请求 1400×813)。
    await svc.handleMoved(CLAUDE_BUNDLE, { x: 104, y: 98, w: 396, h: 290 }, false)

    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toEqual([])
    const view = await svc.view()
    expect(view?.stack.map(s => s.key)).toEqual(['claude'])
    expect(view?.recent_moves?.at(-1)?.decision).toBe('settled')
  })

  it('用户真实拖出(dragged:true) → 照旧除名,行为不变', async () => {
    const { svc } = await adopted()

    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true)

    expect((await svc.view())?.stack).toEqual([])
  })

  it('归位冷却:2s 内第二次程序化槽外落定不再摆位(挡应用钳制尺寸导致的回声循环),过期后恢复', async () => {
    const clockRef = { value: 1_000_000 }
    const { helper, svc } = await adopted(clockRef)

    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, false)
    clockRef.value += 500
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, false)

    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toHaveLength(1)
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('home-cooldown')

    clockRef.value += 2001
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, false)
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toHaveLength(2)
  })

  it('双窗态程序化移动 → 不自动归位(认不出哪扇,D13 如实降级),也不除名', async () => {
    // 第二扇进坞要靠 app_info 回两扇窗(数窗判定),用专用脚本。
    const SECOND = { x: 300, y: 150, w: 100, h: 100 }
    const dualHelper = fakeHelper((req) => {
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: INSIDE_FRAME }, { index: 1, frame: SECOND }] }
      return defaultScript(req)
    })
    const svcDual = createDockService({
      file: await tmpFile(), helper: dualHelper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svcDual.setSlotRect(SLOT_PAGE_RECT)
    await svcDual.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // 认领
    await svcDual.handleMoved(CLAUDE_BUNDLE, SECOND) // 劈槽双显
    dualHelper.calls.length = 0

    await svcDual.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, false)

    expect(dualHelper.calls.filter(c => c.op === 'set_window_frame')).toEqual([])
    const view = await svcDual.view()
    expect(view?.stack.map(s => s.key)).toEqual(['claude'])
  })

  it('归位摆位失败 → 如实记 note 与 decision:home-failed,叠不动', async () => {
    const helper = fakeHelper((req) => {
      if (req.op === 'set_window_frame') return new Error('窗口没了')
      return defaultScript(req)
    })
    const file = await tmpFile()
    await saveDockFile(file, { version: 1, stack: [{ app: 'claude', bundle_id: CLAUDE_BUNDLE, original: INSIDE_FRAME }], current: 'claude' })
    const svc = createDockService({
      file, helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    helper.calls.length = 0

    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, false)

    const view = await svc.view()
    expect(view?.stack.map(s => s.key)).toEqual(['claude'])
    expect(view?.note).toContain('窗口没了')
    expect(view?.recent_moves?.at(-1)?.decision).toBe('home-failed')
  })
})

describe('view() 的 isRunning 短缓存(2026-08-31 风暴修复)', () => {
  it('缓存窗口内连续 view() 每个 bundle 只问一次 lsappinfo,过期后重新问', async () => {
    // /state 每秒轮询,view() 原来每拍对叠里每个标签起一个 lsappinfo 子进程——
    // 七个标签=每秒七个子进程,风暴期间它们也在排队挨拖。"在不在跑"只驱动标签置灰,
    // 几秒的陈旧无感(刻度与 badges.ts 的 5 秒采样缓存同款),用短缓存砍掉子进程 churn。
    // 激活/唤起路径(switchTo/ensureRunningWith)不走缓存:那边要实时真相。
    let nowMs = 1_000_000
    let lsappinfoCalls = 0
    const inner = runCommandFactory([CLAUDE_BUNDLE]).runCommand
    const runCommand = async (cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> => {
      if (cmd[0] === 'lsappinfo') lsappinfoCalls += 1
      return inner(cmd)
    }
    const file = await tmpFile()
    await saveDockFile(file, {
      version: 1,
      stack: [{ app: 'claude', bundle_id: CLAUDE_BUNDLE, original: INSIDE_FRAME }],
      current: null,
    })
    const svc = createDockService({
      file, helper: fakeHelper(defaultScript).channel, registry: fakeRegistry(ROSTER),
      runCommand, sleep: noSleep, now: () => nowMs,
    })

    const v1 = await svc.view()
    expect(v1?.stack[0]?.running).toBe(true)
    expect(lsappinfoCalls).toBe(1)

    await svc.view()
    await svc.view()
    expect(lsappinfoCalls).toBe(1) // 窗口内不再起子进程

    nowMs += 5_001
    const v2 = await svc.view()
    expect(v2?.stack[0]?.running).toBe(true)
    expect(lsappinfoCalls).toBe(2) // 过期后重新问一次
  })
})

describe('标签拖拽排序(2026-09-02 Ben:想把 AI 那几个放一块,现在是先来后到)', () => {
  it('★reorder 按给定顺序重排 stack 并落盘;view() 立刻按新序返回', async () => {
    // 起因(Ben 原话):"有时候不小心拖出去了,再回来就到队尾了,我自己想把 AI 的都放一块"。
    // 叠序原本只由认领先后决定,没有任何人为干预的口子。
    const file = await tmpFile()
    await saveDockFile(file, {
      version: 1,
      stack: [
        { app: 'claude', bundle_id: CLAUDE_BUNDLE, original: INSIDE_FRAME },
        { app: 'codex', bundle_id: CODEX_BUNDLE, original: INSIDE_FRAME },
      ],
      current: null,
    })
    const svc = createDockService({
      file, helper: fakeHelper(defaultScript).channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })

    expect(await svc.reorder(['codex', 'claude'])).toEqual({ ok: true })
    expect((await svc.view())?.stack.map(t => t.key)).toEqual(['codex', 'claude'])
    // 落盘了:重建服务读同一文件,新序还在
    const again = createDockService({
      file, helper: fakeHelper(defaultScript).channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    expect((await again.view())?.stack.map(t => t.key)).toEqual(['codex', 'claude'])
  })

  it('★给的名单缺了成员 → 缺的那些按原顺序补在队尾(不丢标签)', async () => {
    const file = await tmpFile()
    await saveDockFile(file, {
      version: 1,
      stack: [
        { app: 'claude', bundle_id: CLAUDE_BUNDLE, original: INSIDE_FRAME },
        { app: 'codex', bundle_id: CODEX_BUNDLE, original: INSIDE_FRAME },
      ],
      current: null,
    })
    const svc = createDockService({
      file, helper: fakeHelper(defaultScript).channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    expect(await svc.reorder(['codex'])).toEqual({ ok: true })
    expect((await svc.view())?.stack.map(t => t.key)).toEqual(['codex', 'claude'])
  })

  it('名单里有不在叠里的键 → 忽略它,不凭空造成员', async () => {
    const file = await tmpFile()
    await saveDockFile(file, {
      version: 1,
      stack: [{ app: 'claude', bundle_id: CLAUDE_BUNDLE, original: INSIDE_FRAME }],
      current: null,
    })
    const svc = createDockService({
      file, helper: fakeHelper(defaultScript).channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    expect(await svc.reorder(['ghost', 'claude'])).toEqual({ ok: true })
    expect((await svc.view())?.stack.map(t => t.key)).toEqual(['claude'])
  })

  it('排序不碰窗口:一条 helper 请求都不发(它只是标签顺序,与贴合无关)', async () => {
    const file = await tmpFile()
    await saveDockFile(file, {
      version: 1,
      stack: [
        { app: 'claude', bundle_id: CLAUDE_BUNDLE, original: INSIDE_FRAME },
        { app: 'codex', bundle_id: CODEX_BUNDLE, original: INSIDE_FRAME },
      ],
      current: 'claude',
    })
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file, helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    await svc.reorder(['codex', 'claude'])
    expect(helper.calls).toEqual([])
    // current 也不受影响
    expect((await svc.view())?.stack.find(t => t.current)?.key).toBe('claude')
  })
})

/**
 * 程序化激活抑制(2026-09-09 从 Dock/⌘Tab 点回已认领的应用会丢标签,Ben 拍板修法)。
 *
 * 断链现场(docs/交接-0909-事务官标签残留窗口.md「验收中踩的坑」):`POST /activate` 一个
 * 已认领的企业微信,它被唤到前台时自己把窗口摆回槽位外,壳把这次移动报成 dragged=true,
 * handleMoved 按「已认领+界外=拖出」把它除名(recent_moves 一条 decision:outside 实锤)。
 * 2026-08-26 那次修复只接住了 dragged=false 这一支,这次 dragged 是 true,所以还是丢。
 *
 * 修法:对「刚被我们自己程序化激活」的 bundle 留一个短暂抑制期(同 release 的
 * ECHO_SUPPRESS_MS 一套):抑制期内 已认领+dragged=true+界外 不除名、只归位,记
 * decision:suppressed。抑制期只覆盖 /activate、switchTo、场景恢复这类**我们自己发起**的
 * 激活;抑制期外的 dragged=true 界外照旧除名(用户真拖出的行为一点不变)。
 */
describe('程序化激活抑制(2026-09-09 Dock/⌘Tab 点回已认领应用丢标签修复)', () => {
  const SLOT_SCREEN_RECT = { x: 100, y: 100, w: 400, h: 300 }

  /** 认领 claude 后清空调用记录,回一个可复用的现场(同 08-26 那组的 adopted)。 */
  async function adopted(clockRef: { value: number }, running: readonly string[] = []) {
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file: await tmpFile(), helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory(running).runCommand, sleep: noSleep, now: () => clockRef.value,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    helper.calls.length = 0
    return { helper, svc }
  }

  it('★复现:noteActivated 后应用自己把窗口摆到槽外(dragged:true)→ 不除名,贴回槽位,记 decision:suppressed', async () => {
    const clock = { value: 1_000_000 }
    const { helper, svc } = await adopted(clock)

    await svc.noteActivated('claude')
    clock.value += 300 // 壳侧 300ms 去抖之后才报 moved
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true)

    const view = await svc.view()
    expect(view?.stack.map(s => s.key)).toEqual(['claude']) // 标签还在
    expect(view?.stack[0]?.current).toBe(true)
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toEqual([
      { op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: SLOT_SCREEN_RECT },
    ])
    const last = view?.recent_moves?.at(-1)
    expect(last?.decision).toBe('suppressed')
    expect(last?.detail).toContain('homed') // 真机排障要看得出这条是"激活抑制+已归位",不是 release 回声
  })

  it('switchTo(点标签)本身就是我们发起的激活:切换后应用自摆槽外(dragged:true)→ 不除名,归位', async () => {
    const clock = { value: 1_000_000 }
    const { helper, svc } = await adopted(clock, [CLAUDE_BUNDLE])
    expect((await svc.switchTo('claude')).ok).toBe(true)
    helper.calls.length = 0

    clock.value += 300
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true)

    const view = await svc.view()
    expect(view?.stack.map(s => s.key)).toEqual(['claude'])
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toHaveLength(1)
    expect(view?.recent_moves?.at(-1)?.decision).toBe('suppressed')
  })

  it('抑制期外用户真拖出(dragged:true)→ 照旧除名 decision:outside,行为不变', async () => {
    const clock = { value: 1_000_000 }
    const { helper, svc } = await adopted(clock)

    await svc.noteActivated('claude')
    clock.value += ACTIVATE_SUPPRESS_MS + 1
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true)

    const view = await svc.view()
    expect(view?.stack).toEqual([])
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toEqual([]) // 绝不替用户挪窗
    expect(view?.recent_moves?.at(-1)?.decision).toBe('outside')
  })

  it('从未 noteActivated 过(纯用户拖出)→ 照旧除名,一条 suppressed 都不记', async () => {
    const clock = { value: 1_000_000 }
    const { svc } = await adopted(clock)

    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true)

    const view = await svc.view()
    expect(view?.stack).toEqual([])
    expect(view?.recent_moves?.some(m => m.decision === 'suppressed')).toBe(false)
  })

  it('抑制期长度 = 2 × ECHO_SUPPRESS_MS:release 回声 2s 就过期,激活抑制在 2s 后仍生效、4s 后失效', async () => {
    // 回声抑制只盖一次 set_window_frame 的去抖+一来一回;激活要盖 open/unhide → 应用自己
    // 重建/摆放窗口 → 壳去抖 这一整段,比单次回声长,取回声的两倍;再长就会把用户
    // 点回之后紧接着的真实拖出也吞掉。
    expect(ACTIVATE_SUPPRESS_MS).toBe(2 * ECHO_SUPPRESS_MS)

    const clock = { value: 1_000_000 }
    const { svc } = await adopted(clock)
    await svc.noteActivated('claude')

    clock.value += ECHO_SUPPRESS_MS + 1 // 回声抑制已过期,激活抑制还在
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true)
    expect((await svc.view())?.stack.map(s => s.key)).toEqual(['claude'])
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('suppressed')

    clock.value = 1_000_000 + ACTIVATE_SUPPRESS_MS + 1 // 激活抑制也过期
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true)
    expect((await svc.view())?.stack).toEqual([])
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('outside')
  })

  it('与 08-26 修复不冲突:抑制期内 dragged:false 仍走程序化归位分支,记 decision:homed 而不是 suppressed', async () => {
    const clock = { value: 1_000_000 }
    const { helper, svc } = await adopted(clock)

    await svc.noteActivated('claude')
    clock.value += 300
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, false)

    const view = await svc.view()
    expect(view?.stack.map(s => s.key)).toEqual(['claude'])
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toHaveLength(1)
    expect(view?.recent_moves?.at(-1)?.decision).toBe('homed')
  })

  it('抑制期内界内(dragged:true)→ 照旧当整理 decision:tidy,不因抑制期改变界内语义', async () => {
    const clock = { value: 1_000_000 }
    const { helper, svc } = await adopted(clock)

    await svc.noteActivated('claude')
    clock.value += 300
    await svc.handleMoved(CLAUDE_BUNDLE, { x: 160, y: 160, w: 100, h: 100 }, true)

    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toEqual([])
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('tidy')
  })

  it('归位冷却照样管抑制期内的归位:2s 内第二帧槽外落定不再摆位,仍记 suppressed(明细说明 home-cooldown)', async () => {
    const clock = { value: 1_000_000 }
    const { helper, svc } = await adopted(clock)

    await svc.noteActivated('claude')
    clock.value += 300
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true)
    clock.value += 500
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true)

    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toHaveLength(1)
    const view = await svc.view()
    expect(view?.stack.map(s => s.key)).toEqual(['claude'])
    const last = view?.recent_moves?.at(-1)
    expect(last?.decision).toBe('suppressed')
    expect(last?.detail).toContain('home-cooldown')
  })

  it('noteActivated 一个不在叠里的应用 → 空操作:它自己的槽外移动照旧 ignored,也不影响别的标签', async () => {
    const clock = { value: 1_000_000 }
    const { svc } = await adopted(clock)

    await svc.noteActivated('codex') // codex 未认领
    clock.value += 300
    await svc.handleMoved(CODEX_BUNDLE, OUTSIDE_FRAME, true)
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('ignored')

    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true) // claude 没被激活过,真拖出照旧除名
    expect((await svc.view())?.stack).toEqual([])
  })

  it('双窗态在抑制期内自摆槽外 → 不除名也不归位(认不出哪扇,D13 如实降级),记 suppressed', async () => {
    const clock = { value: 1_000_000 }
    const SECOND = { x: 300, y: 150, w: 100, h: 100 }
    const dualHelper = fakeHelper((req) => {
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: INSIDE_FRAME }, { index: 1, frame: SECOND }] }
      return defaultScript(req)
    })
    const svc = createDockService({
      file: await tmpFile(), helper: dualHelper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep, now: () => clock.value,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // 认领
    await svc.handleMoved(CLAUDE_BUNDLE, SECOND) // 劈槽双显
    dualHelper.calls.length = 0

    await svc.noteActivated('claude')
    clock.value += 300
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true)

    expect(dualHelper.calls.filter(c => c.op === 'set_window_frame')).toEqual([])
    const view = await svc.view()
    expect(view?.stack.map(s => s.key)).toEqual(['claude'])
    expect(view?.recent_moves?.at(-1)?.decision).toBe('suppressed')
  })

  it('release 清掉激活抑制:放出后立刻重新认领再拖出 → 照旧除名(标签都放走了,不该再替它挡)', async () => {
    const clock = { value: 1_000_000 }
    const { svc } = await adopted(clock)

    await svc.noteActivated('claude')
    await svc.release('claude')
    clock.value += 2001 // 让 C1 的回声抑制过期,好让下面这一拖真的重新认领
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME) // 用户又把它拖回窗位
    expect((await svc.view())?.stack.map(s => s.key)).toEqual(['claude'])

    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true) // 还在原来的 4s 激活抑制期内

    const view = await svc.view()
    expect(view?.stack).toEqual([])
    expect(view?.recent_moves?.at(-1)?.decision).toBe('outside')
  })

  it('release 回声抑制(C1)与激活抑制互不干扰:release 后 2s 内原地帧不重新认领,照旧', async () => {
    const clock = { value: 1_000_000 }
    const { svc } = await adopted(clock)
    await svc.noteActivated('claude')
    await svc.release('claude')

    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)

    const view = await svc.view()
    expect(view?.stack).toEqual([])
    expect(view?.recent_moves?.at(-1)?.decision).toBe('suppressed')
    expect(view?.recent_moves?.at(-1)?.detail).toBeUndefined() // C1 那条不带明细,与激活抑制的那条分得开
  })
})

/**
 * 弹层让开窗位(2026-09-11,Ben:「弹窗(包括现在的浮窗)一直是在应用下层的」)。
 *
 * 窗位里贴着的是真实原生窗,永远盖在 WKWebView 之上,网页里任何与窗位矩形重叠的弹层
 * (设置/任务卡/归档确认/日结/事务官浮窗)都会被它压住。修法不是 z-index(排不到操作系统
 * 窗口前面),而是**弹层打开 → 窗位让开(veil);弹层关闭 → 窗位回来(unveil)**。
 */
describe('veil / unveil(弹层让开窗位,2026-09-11)', () => {
  const ORIGINAL = { x: 0, y: 0, w: 10, h: 10 }
  const KIMI_BUNDLE = 'com.example.kimi'
  const ROSTER3: RegistryEntry[] = [...ROSTER, { key: 'kimi', label: 'Kimi', bundleId: KIMI_BUNDLE, cmd: ['open', '-a', 'Kimi'] }]

  async function threeMemberFile(current: string | null): Promise<string> {
    const file = await tmpFile()
    await saveDockFile(file, {
      version: 1,
      stack: [
        { app: 'claude', bundle_id: CLAUDE_BUNDLE, original: ORIGINAL },
        { app: 'codex', bundle_id: CODEX_BUNDLE, original: ORIGINAL },
        { app: 'kimi', bundle_id: KIMI_BUNDLE, original: ORIGINAL },
      ],
      current,
    })
    return file
  }

  /**
   * 壳脚本(同 hideCurrent 那组的 visibilityScript):`visible` 里的 bundle 报 running+未隐藏
   * ——就是压在窗位上的残留窗;`notRunning` 里的报没在跑;其余成员报藏得好好的。默认没有残留。
   */
  function veilScript(visible: readonly string[] = [], notRunning: readonly string[] = []) {
    return (req: HelperRequest): Record<string, unknown> | Error => {
      if (req.op === 'app_info') {
        if (notRunning.includes(req.bundle_id)) return { running: false, hidden: false, windows: [] }
        return { running: true, hidden: !visible.includes(req.bundle_id), windows: [{ index: 0, frame: INSIDE_FRAME }] }
      }
      return defaultScript(req)
    }
  }

  async function service(current: string | null, script: (req: HelperRequest) => Record<string, unknown> | Error = veilScript()) {
    const file = await threeMemberFile(current)
    const helper = fakeHelper(script)
    const svc = createDockService({
      file, helper: helper.channel, registry: fakeRegistry([...ROSTER3]),
      runCommand: runCommandFactory([CLAUDE_BUNDLE, CODEX_BUNDLE, KIMI_BUNDLE]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    return { file, helper, svc }
  }

  async function savedCurrent(file: string): Promise<string | null> {
    return (JSON.parse(await readFile(file, 'utf8')) as { current: string | null }).current
  }

  it('veil:把 current 那一扇 hide_app,记住是谁;current 不变(标签栏不跳到事务官),stack 不掉', async () => {
    const { file, helper, svc } = await service('claude')

    expect(await svc.veil()).toEqual({ ok: true })

    expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([{ op: 'hide_app', bundle_id: CLAUDE_BUNDLE }])
    expect(await savedCurrent(file)).toBe('claude')
    const view = await svc.view()
    expect(view?.stack).toHaveLength(3)
    expect(view?.veil).toEqual({ app: 'claude', depth: 1 })
  })

  it('veil 幂等+计数:连开两个弹层只 hide_app 一次;关第一个不 unhide,关最后一个才 unhide 并按窗位矩形重贴+置前', async () => {
    const { helper, svc } = await service('claude')

    await svc.veil()
    await svc.veil()
    expect(helper.calls.filter(c => c.op === 'hide_app')).toHaveLength(1)
    expect((await svc.view())?.veil).toEqual({ app: 'claude', depth: 2 })

    expect(await svc.unveil()).toEqual({ ok: true })
    expect(helper.calls.filter(c => c.op === 'unhide_app')).toHaveLength(0) // 还有一个弹层开着
    expect((await svc.view())?.veil).toEqual({ app: 'claude', depth: 1 })

    expect(await svc.unveil()).toEqual({ ok: true })
    expect(helper.calls.filter(c => c.op === 'unhide_app')).toEqual([{ op: 'unhide_app', bundle_id: CLAUDE_BUNDLE }])
    // 复用 switchTo 的贴合路径:unhide → set_window_frame(窗位屏幕矩形)→ raise_window
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toEqual([
      { op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: { x: 100, y: 100, w: 400, h: 300 } },
    ])
    expect(helper.calls.some(c => c.op === 'raise_window' && c.bundle_id === CLAUDE_BUNDLE)).toBe(true)
    expect((await svc.view())?.veil).toBeUndefined()
  })

  it('unveil 多关一次(计数已是 0)是空操作:不发任何 helper 请求、ok:true', async () => {
    const { helper, svc } = await service('claude')

    expect(await svc.unveil()).toEqual({ ok: true })
    expect(helper.calls.filter(c => c.op !== 'screen_info' && c.op !== 'hover_zone')).toEqual([]) // 那两条是 setSlotRect 推悬停圈的
    expect((await svc.view())?.veil).toBeUndefined()
  })

  it('current 为 null(事务官在台)时 veil 没有窗可让:不发 hide_app,但计数照记;unveil 也不动窗', async () => {
    const { helper, svc } = await service(null)

    expect(await svc.veil()).toEqual({ ok: true })
    expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([])
    expect((await svc.view())?.veil).toEqual({ depth: 1 })

    await svc.unveil()
    expect(helper.calls.filter(c => c.op === 'unhide_app' || c.op === 'set_window_frame')).toEqual([])
  })

  it('验收 4:veil 期间用户点了「Kimi」标签 → 关弹窗后 unveil 不动,不会把 Claude 又拉回来', async () => {
    const { file, helper, svc } = await service('claude')

    await svc.veil()
    expect(await svc.switchTo('kimi')).toEqual({ ok: true })
    helper.calls.length = 0

    expect(await svc.unveil()).toEqual({ ok: true })
    expect(helper.calls.filter(c => c.op === 'unhide_app' || c.op === 'set_window_frame' || c.op === 'raise_window' || c.op === 'hide_app')).toEqual([])
    expect(await savedCurrent(file)).toBe('kimi')
    expect((await svc.view())?.veil).toBeUndefined()
  })

  it('veil 期间点「事务官」(hideCurrent 把 current 置 null)→ unveil 同样不动', async () => {
    const { helper, svc } = await service('claude')

    await svc.veil()
    await svc.hideCurrent()
    helper.calls.length = 0

    await svc.unveil()
    expect(helper.calls.filter(c => c.op === 'unhide_app' || c.op === 'set_window_frame')).toEqual([])
  })

  it('veil 期间放出(release)了那扇窗 → unveil 不动(它已经不在叠里)', async () => {
    const { helper, svc } = await service('claude')

    await svc.veil()
    await svc.release('claude')
    helper.calls.length = 0

    await svc.unveil()
    expect(helper.calls).toEqual([])
  })

  it('veil 那次 hide_app 失败 → ok:false 带壳原因,但计数照记(弹层不能被卡住),之后 unveil 不会去 unhide 一扇没藏过的窗', async () => {
    const { helper, svc } = await service('claude', (req) => {
      if (req.op === 'hide_app') return new Error('AX 拒绝')
      return veilScript()(req)
    })

    expect(await svc.veil()).toEqual({ ok: false, reason: 'AX 拒绝' })
    expect((await svc.view())?.veil).toEqual({ depth: 1 })

    helper.calls.length = 0
    expect(await svc.unveil()).toEqual({ ok: true })
    expect(helper.calls.filter(c => c.op === 'unhide_app' || c.op === 'set_window_frame')).toEqual([])
  })

  it('unveil 重贴失败(壳断开/报错)→ ok:false 带原因、note 如实写;veil 状态照样清掉,不卡住下一次', async () => {
    let failFrames = false
    const { helper, svc } = await service('claude', (req) => {
      if (req.op === 'set_window_frame' && failFrames) return new Error('壳已断开')
      return veilScript()(req)
    })

    await svc.veil()
    failFrames = true
    expect(await svc.unveil()).toEqual({ ok: false, reason: '壳已断开' })
    expect((await svc.view())?.note).toBe('壳已断开')
    expect((await svc.view())?.veil).toBeUndefined()

    // 再开一次弹层:又是一次干净的 veil,不受上次失败影响
    helper.calls.length = 0
    await svc.veil()
    expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([{ op: 'hide_app', bundle_id: CLAUDE_BUNDLE }])
  })

  it('unveil 前窗位矩形变了(用户调过窗位高度)→ 按**当前**矩形重贴,不是 veil 时的那个', async () => {
    const { helper, svc } = await service('claude')

    await svc.veil()
    svc.setSlotRect({ x: 100, y: 100, w: 600, h: 500 }, 'resize')
    // 2026-10-12 起弹层开着时 resize 不重贴(让路那一扇正藏着),只推悬停圈;等它过去,下面看 unveil 用的是不是新矩形。
    await until(() => helper.calls.some(c => c.op === 'hover_zone'))
    await new Promise(r => setTimeout(r, 30))
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toEqual([])
    helper.calls.length = 0

    await svc.unveil()
    expect(helper.calls.filter(c => c.op === 'set_window_frame')).toEqual([
      { op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: { x: 100, y: 100, w: 600, h: 500 } },
    ])
  })

  it('unveil 给这扇窗留程序化激活抑制期:unhide 后应用自摆到槽外(dragged=true)不除名、只归位', async () => {
    let t = 1_000_000
    const file = await threeMemberFile('claude')
    const helper = fakeHelper(veilScript())
    const svc = createDockService({
      file, helper: helper.channel, registry: fakeRegistry([...ROSTER3]),
      runCommand: runCommandFactory([CLAUDE_BUNDLE]).runCommand, sleep: noSleep, now: () => t,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)

    await svc.veil()
    await svc.unveil()
    t += 500
    await svc.handleMoved(CLAUDE_BUNDLE, OUTSIDE_FRAME, true)

    const view = await svc.view()
    expect(view?.stack.map(s => s.key)).toEqual(['claude', 'codex', 'kimi']) // 标签还在
    expect(view?.recent_moves?.at(-1)?.decision).toBe('suppressed')
  })

  // 2026-09-16 Ben:窗位是 Claude,点设置后看到的是 Kimi——Kimi 早先切走时没藏成(AX 通道休眠)或被
  // 用户在 Dock/⌘Tab 点回又没除名,窗仍停在窗位那块矩形上;旧 veil 只 hide 了 current,Kimi 就露出来。
  describe('让路时一并清掉压在窗位上的残留窗(2026-09-16)', () => {
    it('★验收 1:Claude 在台、Kimi 窗停在同一位置没藏 → veil 两扇都 hide;unveil 只把 Claude 带回来,Kimi 不带回', async () => {
      const { file, helper, svc } = await service('claude', veilScript([CLAUDE_BUNDLE, KIMI_BUNDLE]))

      expect(await svc.veil()).toEqual({ ok: true })

      expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([
        { op: 'hide_app', bundle_id: CLAUDE_BUNDLE },
        { op: 'hide_app', bundle_id: KIMI_BUNDLE },
      ])
      // current 那扇不多问,其余成员各问一次 app_info
      expect(helper.calls.filter(c => c.op === 'app_info').map(c => c.bundle_id)).toEqual([CODEX_BUNDLE, KIMI_BUNDLE])
      expect(await savedCurrent(file)).toBe('claude') // current 不动、不落盘
      const view = await svc.view()
      expect(view?.veil).toEqual({ app: 'claude', depth: 1 })
      expect(view?.recent_hides?.map(h => ({ app: h.app, bundle_id: h.bundle_id, decision: h.decision }))).toEqual([
        { app: 'claude', bundle_id: CLAUDE_BUNDLE, decision: 'veil-current' },
        { app: 'kimi', bundle_id: KIMI_BUNDLE, decision: 'veil-stray' },
      ])
      expect(view?.recent_hides?.every(h => typeof h.ts === 'string')).toBe(true)
      expect(view?.note).toBeUndefined()

      helper.calls.length = 0
      expect(await svc.unveil()).toEqual({ ok: true })
      expect(helper.calls.filter(c => c.op === 'unhide_app')).toEqual([{ op: 'unhide_app', bundle_id: CLAUDE_BUNDLE }])
      expect(helper.calls.filter(c => c.op === 'set_window_frame').map(c => c.bundle_id)).toEqual([CLAUDE_BUNDLE])
      expect(helper.calls.filter(c => c.op === 'raise_window').map(c => c.bundle_id)).toEqual([CLAUDE_BUNDLE])
      expect(helper.calls.some(c => 'bundle_id' in c && c.bundle_id === KIMI_BUNDLE)).toBe(false) // 残留窗本来就不该露在窗位上,不带回
      expect(await savedCurrent(file)).toBe('claude')
      expect((await svc.view())?.stack).toHaveLength(3) // 标签一个不掉
    })

    it('只清明确 running 且未 hidden 的:已隐藏 / 没在跑 / app_info 报错的一律不动,不发多余 hide_app', async () => {
      const { helper, svc } = await service('claude', (req) => {
        if (req.op === 'app_info' && req.bundle_id === KIMI_BUNDLE) return new Error('AX 通道休眠')
        return veilScript([CLAUDE_BUNDLE], [CODEX_BUNDLE])(req)
      })

      expect(await svc.veil()).toEqual({ ok: true })

      expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([{ op: 'hide_app', bundle_id: CLAUDE_BUNDLE }])
      expect((await svc.view())?.recent_hides?.map(h => h.decision)).toEqual(['veil-current'])
      expect((await svc.view())?.veil).toEqual({ app: 'claude', depth: 1 })
    })

    it('字段缺失(壳答不上 hidden)也不动:不拿猜测去藏用户的窗', async () => {
      const { helper, svc } = await service('claude', (req) => {
        if (req.op === 'app_info') return { running: true, windows: [{ index: 0, frame: INSIDE_FRAME }] }
        return defaultScript(req)
      })

      await svc.veil()
      expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([{ op: 'hide_app', bundle_id: CLAUDE_BUNDLE }])
    })

    it('计数不变:第二个弹层打开时不再扫成员(不发 app_info、不发 hide_app);关最后一个才回', async () => {
      const { helper, svc } = await service('claude', veilScript([CLAUDE_BUNDLE, KIMI_BUNDLE]))

      await svc.veil()
      helper.calls.length = 0
      expect(await svc.veil()).toEqual({ ok: true })
      expect(helper.calls.filter(c => c.op === 'app_info' || c.op === 'hide_app')).toEqual([])
      expect((await svc.view())?.veil).toEqual({ app: 'claude', depth: 2 })

      await svc.unveil()
      expect(helper.calls.filter(c => c.op === 'unhide_app')).toEqual([])
      await svc.unveil()
      expect(helper.calls.filter(c => c.op === 'unhide_app')).toEqual([{ op: 'unhide_app', bundle_id: CLAUDE_BUNDLE }])
    })

    it('事务官在台(current=null)但 Kimi 压在窗位上 → veil 也清掉它(弹窗不能被残留窗盖住);unveil 不带回', async () => {
      const { helper, svc } = await service(null, veilScript([KIMI_BUNDLE]))

      expect(await svc.veil()).toEqual({ ok: true })
      expect(helper.calls.filter(c => c.op === 'hide_app')).toEqual([{ op: 'hide_app', bundle_id: KIMI_BUNDLE }])
      const view = await svc.view()
      expect(view?.veil).toEqual({ depth: 1 }) // 没有 current 可记
      expect(view?.recent_hides?.map(h => ({ app: h.app, decision: h.decision }))).toEqual([{ app: 'kimi', decision: 'veil-stray' }])

      helper.calls.length = 0
      await svc.unveil()
      expect(helper.calls.filter(c => c.op === 'unhide_app' || c.op === 'set_window_frame')).toEqual([])
    })

    it('清残留窗时壳报错(AX 失败)→ 弹层照开:ok:false、note 点名 kimi + 壳原话,失败的不进 recent_hides;Claude 藏成了所以 unveil 照常带回', async () => {
      const { helper, svc } = await service('claude', (req) => {
        if (req.op === 'hide_app' && req.bundle_id === KIMI_BUNDLE) return new Error('AX 通道休眠')
        return veilScript([CLAUDE_BUNDLE, KIMI_BUNDLE, CODEX_BUNDLE])(req)
      })

      const result = await svc.veil()
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('kimi')
      expect(result.reason).toContain('AX 通道休眠')
      // 一个清不掉不中断剩下的:codex 照样清
      expect(helper.calls.filter(c => c.op === 'hide_app').map(c => c.bundle_id)).toEqual([CLAUDE_BUNDLE, CODEX_BUNDLE, KIMI_BUNDLE])
      const view = await svc.view()
      expect(view?.note).toBe(result.reason)
      expect(view?.recent_hides?.map(h => ({ app: h.app, decision: h.decision }))).toEqual([
        { app: 'claude', decision: 'veil-current' },
        { app: 'codex', decision: 'veil-stray' },
      ])
      expect(view?.veil).toEqual({ app: 'claude', depth: 1 })

      helper.calls.length = 0
      expect(await svc.unveil()).toEqual({ ok: true })
      expect(helper.calls.filter(c => c.op === 'unhide_app')).toEqual([{ op: 'unhide_app', bundle_id: CLAUDE_BUNDLE }])
      expect((await svc.view())?.note).toBeUndefined() // 回来了,上次那句清理失败的 note 一并清掉
    })

    it('current 那扇 hide_app 失败(既有行为)→ 不再扫残留:AX 已经不通,多问只是多几条失败', async () => {
      const { helper, svc } = await service('claude', (req) => {
        if (req.op === 'hide_app') return new Error('AX 拒绝')
        return veilScript([CLAUDE_BUNDLE, KIMI_BUNDLE])(req)
      })

      expect(await svc.veil()).toEqual({ ok: false, reason: 'AX 拒绝' })
      expect(helper.calls.filter(c => c.op === 'app_info')).toEqual([])
      expect((await svc.view())?.recent_hides).toBeUndefined()
    })
  })
})

describe('窗口槽成员表下发给壳(2026-10-04,卡「常亮认窗口槽里的程序」)', () => {
  /**
   * 为什么壳要这张表:09-27 那条「只要工作台在前台就别让屏幕暗下去」要求工作台**自己**
   * 是最前面那个 App,而她用工作台的常态是点进槽里那扇**真窗**(Codex / Claude…)——
   * 那一刻最前面的是那一家,断言被放掉、屏暗、锁屏(维护者 10-04 量到的那一幕)。
   *
   * **一处主人**:谁在槽里只有 dock.json 那一叠知道,所以这张表只从 dock 这里出。
   * 对照测试(壳那一侧认不认这条 op)在 `slot-apps-shell-text.test.ts`。
   */

  /** 假壳 + 报了 `slot_apps` 这一格(真壳 hello 的 caps 里有它)。 */
  function newShell(script: (req: HelperRequest) => Record<string, unknown> | Error = defaultScript) {
    const helper = fakeHelper(script)
    return { calls: helper.calls, channel: { ...helper.channel, supports: (cap: string) => cap === 'slot_apps' } }
  }

  function slotPushes(calls: readonly HelperRequest[]): string[][] {
    return calls.filter(c => c.op === 'slot_apps').map(c => (c as { op: 'slot_apps', bundle_ids: string[] }).bundle_ids)
  }

  it('★★pushSlotApps 把此刻叠里每一家的 bundle id 发过去', async () => {
    const file = await tmpFile()
    await saveDockFile(file, {
      version: 1,
      stack: [
        { app: 'claude', bundle_id: CLAUDE_BUNDLE, original: INSIDE_FRAME },
        { app: 'codex', bundle_id: CODEX_BUNDLE, original: INSIDE_FRAME },
      ],
      current: 'codex',
    })
    const shell = newShell()
    const svc = createDockService({
      file, helper: shell.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    await svc.pushSlotApps()
    // 发的是**成员**不是 current:她点一下标签就换一个 current,而那一拍插件与壳之间
    // 总有先后 —— 发成员表则不管她停在哪一个标签上都算对。
    expect(slotPushes(shell.calls)).toEqual([[CLAUDE_BUNDLE, CODEX_BUNDLE]])
  })

  it('★叠是空的 → 照样发一次空表(她刚把最后一家拖出去,壳得知道槽空了)', async () => {
    const shell = newShell()
    const svc = createDockService({
      file: await tmpFile(), helper: shell.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    await svc.pushSlotApps()
    expect(slotPushes(shell.calls)).toEqual([[]])
  })

  it('★★叠变了就自动跟一发 —— 认领进来之后壳手里那张表是新的', async () => {
    const shell = newShell()
    const svc = createDockService({
      file: await tmpFile(), helper: shell.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    await until(() => slotPushes(shell.calls).length > 0)
    expect(slotPushes(shell.calls).at(-1)).toEqual([CLAUDE_BUNDLE])
  })

  it('★★除名之后也跟一发 —— 不然壳会把一个已经不在槽里的程序继续当成「在用工作台」', async () => {
    const file = await tmpFile()
    await saveDockFile(file, {
      version: 1,
      stack: [
        { app: 'claude', bundle_id: CLAUDE_BUNDLE, original: INSIDE_FRAME },
        { app: 'codex', bundle_id: CODEX_BUNDLE, original: INSIDE_FRAME },
      ],
      current: null,
    })
    const shell = newShell()
    const svc = createDockService({
      file, helper: shell.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    await svc.release('claude')
    await until(() => slotPushes(shell.calls).length > 0)
    expect(slotPushes(shell.calls).at(-1)).toEqual([CODEX_BUNDLE])
  })

  it('★★老壳没报这一格 → 一个字都不发(它会回「未知 op」,白跑一个往返)', async () => {
    const file = await tmpFile()
    await saveDockFile(file, {
      version: 1,
      stack: [{ app: 'claude', bundle_id: CLAUDE_BUNDLE, original: INSIDE_FRAME }],
      current: null,
    })
    // 没有 supports 的假壳 = 老壳(同 dock 里别的 caps 门的做法)。
    const helper = fakeHelper(defaultScript)
    const svc = createDockService({
      file, helper: helper.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    await svc.pushSlotApps()
    await svc.release('claude')
    expect(helper.calls.filter(c => c.op === 'slot_apps')).toEqual([])
  })

  it('★发不出去不升级成 note、也不把那次认领判成失败(那只是回到 10-04 之前的行为)', async () => {
    const shell = newShell((req) => {
      if (req.op === 'slot_apps') return new Error('壳断线了')
      return defaultScript(req)
    })
    const svc = createDockService({
      file: await tmpFile(), helper: shell.channel, registry: fakeRegistry(ROSTER),
      runCommand: runCommandFactory([]).runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await expect(svc.pushSlotApps()).resolves.toBeUndefined()
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    const view = await svc.view()
    expect(view?.stack.map(t => t.key)).toEqual(['claude'])
    expect(view?.note).toBeUndefined()
  })
})

/**
 * ★ **弹层摆回不把她退掉的那家开回来**(2026-10-19)。
 *
 * 维护者机器 11:38–12:26 微信被 `open -b` 了 39 次,每 2–7 分钟一次,整条路只有「开App」一行日志。
 * 查到的路:current 是微信、她退掉了微信;顶栏弹层开着时 veil 藏 current,关掉时 unveil →
 * `placeInSlot(item, rect, cmd)` → `waitForDockWindow` 第一拍没窗就跑 `cmd`(= `open -b` 微信)——
 * 她每开关一次弹层,微信就被开回来一次、摆进窗位。
 *
 * 钉三件事:① 让路期间她退掉了 current 那家 → unveil 一次 open 都不跑、不 unhide、不贴,
 * 那一格如实标「没开着」(标签上「点一下拉进来」);② 她没退掉 → 行为一字不变(放出来、重贴、置前);
 * ③ 她点标签(switchTo)照旧先开再拉 —— 那是她的指令。
 */
describe('弹层摆回不开回她退掉的那家(2026-10-19)', () => {
  const ORIGINAL = { x: 0, y: 0, w: 10, h: 10 }

  async function twoMemberFile(current: string | null): Promise<string> {
    const file = await tmpFile()
    await saveDockFile(file, {
      version: 1,
      stack: [
        { app: 'claude', bundle_id: CLAUDE_BUNDLE, original: ORIGINAL },
        { app: 'codex', bundle_id: CODEX_BUNDLE, original: ORIGINAL },
      ],
      current,
    })
    return file
  }

  /** 壳:`quit` 里的那家报没在跑、没窗;其余报在跑、藏着、有一扇窗。 */
  function script(quit: readonly string[]) {
    return (req: HelperRequest): Record<string, unknown> | Error => {
      if (req.op === 'app_info') {
        if (quit.includes(req.bundle_id)) return { running: false, hidden: false, windows: [] }
        return { running: true, hidden: true, windows: [{ index: 0, frame: INSIDE_FRAME }] }
      }
      return defaultScript(req)
    }
  }

  async function service(current: string | null, running: readonly string[], quit: readonly string[] = []) {
    const file = await twoMemberFile(current)
    const helper = fakeHelper(script(quit))
    const commands = runCommandFactory(running)
    const svc = createDockService({
      file, helper: helper.channel, registry: fakeRegistry([...ROSTER]),
      runCommand: commands.runCommand, sleep: noSleep,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    return { file, helper, svc, commands }
  }

  it('★让路期间她退掉了 current 那家 → unveil 零次 open、不 unhide、不贴;那一格标「没开着」', async () => {
    const { helper, svc, commands } = await service('claude', [CLAUDE_BUNDLE, CODEX_BUNDLE])
    expect(await svc.veil()).toEqual({ ok: true })
    // 弹层开着的时候她 ⌘Q 退掉了 Claude。
    commands.running.delete(CLAUDE_BUNDLE)
    helper.calls.length = 0

    expect(await svc.unveil()).toEqual({ ok: true })

    expect(commands.opens).toEqual([])
    expect(helper.calls.filter(c => c.op === 'unhide_app' || c.op === 'set_window_frame' || c.op === 'raise_window')).toEqual([])
    const tab = (await svc.view())?.stack.find(t => t.key === 'claude')
    expect(tab?.current).toBe(true)
    expect(tab?.unplaced).toContain('没开着')
    expect((await svc.view())?.veil).toBeUndefined()
  })

  it('★她没退掉 → 行为一字不变:unveil 放出来、按窗位矩形重贴、置前', async () => {
    const { helper, svc, commands } = await service('claude', [CLAUDE_BUNDLE, CODEX_BUNDLE])
    await svc.veil()
    helper.calls.length = 0

    expect(await svc.unveil()).toEqual({ ok: true })

    expect(helper.calls.map(c => c.op)).toEqual(['screen_info', 'unhide_app', 'app_info', 'set_window_frame', 'raise_window'])
    expect(commands.opens).toEqual([])
    expect((await svc.view())?.stack.find(t => t.key === 'claude')?.unplaced).toBeUndefined()
  })

  it('★退掉之后她点标签(switchTo)→ 照旧先开再拉(那是她的指令)', async () => {
    const { svc, commands } = await service('claude', [CODEX_BUNDLE], [CLAUDE_BUNDLE])
    await svc.veil()
    await svc.unveil()
    expect(commands.opens).toEqual([])

    // lsappinfo 假机器:open 之后那家就算在跑了(ensureRunningWith 校验那一下才过得去)。
    const original = commands.runCommand
    const runCommand = async (cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> => {
      const out = await original(cmd)
      if (cmd[0] === 'open') commands.running.add(CLAUDE_BUNDLE)
      return out
    }
    const file = await twoMemberFile('claude')
    const helper = fakeHelper(script([]))
    const byHand = createDockService({ file, helper: helper.channel, registry: fakeRegistry([...ROSTER]), runCommand, sleep: noSleep })
    byHand.setSlotRect(SLOT_PAGE_RECT)
    expect(await byHand.switchTo('claude')).toEqual({ ok: true })
    expect(commands.opens).toContainEqual(['open', '-a', 'Claude'])
  })
})
