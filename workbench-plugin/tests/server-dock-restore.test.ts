// @vitest-environment node
/**
 * 起来之后把「当前那一扇」摆回窗位(2026-09-25,卡 fix/slot-current-empty)。
 *
 * 统筹 0.2.88 真壳验收:插件重载后窗口槽停在「Kimi」标签(dock.json 的 current 是 kimi),
 * 槽里却是一整块空的深色区 —— 服务端重启后没有人把 current 那扇窗重新摆回来(页面报来的矩形按 S5
 * 只存不动窗)。这里钉的是:
 * 1. 矩形稳住之后把 current 摆回去:unhide → 贴到窗位 → 压在窗位上的别的成员藏起来;**不置前、不激活**;
 * 2. 摆不回来(没开着 / 没有窗 / 壳摆不动)→ 那一格记「没在窗位里」+ 原因,引导做完了就回事务官那一页;
 * 3. 平时 current 被藏起来 / 没开着 → view 里那一格带 unplaced(槽里写原因、标签写「点一下拉进来」);
 *    弹层让路时不算(那是故意藏的);
 * 4. 没开这一档(keepCurrentInSlot 缺省)时一个请求都不多发。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HelperRect } from '../src/protocol.ts'
import type { AppsRegistry } from '../src/server/appsRegistry.ts'
import { createDockService, loadDockFile, saveDockFile } from '../src/server/dock.ts'
import type { DockFile } from '../src/server/dock.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'

const KIMI = 'com.moonshot.kimichat'
const CLAUDE = 'com.anthropic.claudefordesktop'
const CODEX = 'com.openai.codex'

/** 页面矩形 {195,133,1640,868} + webview 在 (0,62) → 屏幕上的窗位 {195,195,1640,868}(维护者那台机器的数)。 */
const PAGE_RECT = { x: 195, y: 133, w: 1640, h: 868 }
const SCREEN_INFO = { webview: { x: 0, y: 62, w: 2560, h: 1378 }, scale: 1 }
const SLOT: HelperRect = { x: 195, y: 195, w: 1640, h: 868 }
const ELSEWHERE: HelperRect = { x: 700, y: 300, w: 900, h: 600 }

interface World {
  running: Set<string>
  hidden: Set<string>
  /** 开着但一扇窗都没有的。 */
  windowless: Set<string>
  /** 壳整个不通(辅助功能没授权 / 没连上)。 */
  helperDown?: string
  /** 各家窗此刻在哪(缺省 ELSEWHERE);set_window_frame 会改它。 */
  frames: Map<string, HelperRect>
}

function fakeShell(world: World) {
  const calls: HelperRequest[] = []
  const channel = {
    request: (req: HelperRequest): Promise<Record<string, unknown>> => {
      calls.push(req)
      if (world.helperDown !== undefined) return Promise.reject(new Error(world.helperDown))
      if (req.op === 'screen_info') return Promise.resolve(SCREEN_INFO)
      if (req.op === 'app_info') {
        const running = world.running.has(req.bundle_id)
        const frame = world.frames.get(req.bundle_id) ?? ELSEWHERE
        const windows = !running || world.windowless.has(req.bundle_id) ? [] : [{ index: 0, frame }]
        return Promise.resolve({ running, hidden: world.hidden.has(req.bundle_id), windows })
      }
      // 同真壳:没有窗就摆不了(「没有第 0 个窗口(共 0 个)」)。
      if ((req.op === 'set_window_frame' || req.op === 'raise_window')
        && (!world.running.has(req.bundle_id) || world.windowless.has(req.bundle_id))) {
        return Promise.reject(new Error('没有第 0 个窗口(共 0 个)'))
      }
      if (req.op === 'set_window_frame') world.frames.set(req.bundle_id, req.frame)
      if (req.op === 'unhide_app') world.hidden.delete(req.bundle_id)
      if (req.op === 'hide_app') world.hidden.add(req.bundle_id)
      return Promise.resolve({})
    },
  }
  return { calls, channel }
}

/** lsappinfo:`-only pid` 回 pid;带 `-only hidden` 的再回 Hidden。别的命令记下来。 */
function fakeCommands(world: World) {
  const commands: string[][] = []
  const runCommand = async (cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> => {
    commands.push([...cmd])
    if (cmd[0] === 'lsappinfo') {
      const bundle = cmd.at(-1) ?? ''
      if (!world.running.has(bundle)) return { ok: true, stdout: '' }
      const hidden = cmd.includes('hidden') ? `"Hidden"=${world.hidden.has(bundle) ? 'true' : 'false'}\n` : ''
      return { ok: true, stdout: `"pid"=321\n${hidden}` }
    }
    return { ok: true, stdout: '' }
  }
  return { commands, runCommand }
}

function fakeRegistry(): AppsRegistry {
  const roster = [
    { key: 'kimi', label: 'Kimi', bundle: KIMI },
    { key: 'claude', label: 'Claude', bundle: CLAUDE },
    { key: 'codex', label: 'Codex', bundle: CODEX },
  ]
  return {
    async list() { return roster.map(r => ({ key: r.key, label: r.label })) },
    async listAll() { return roster.map(r => ({ key: r.key, label: r.label })) },
    async enable() { return { enabled: [], already: [], unknown: [] } },
    async commandFor(key: string) { return ['open', '-a', roster.find(r => r.key === key)?.label ?? key] },
    async bundleFor(key: string) { return roster.find(r => r.key === key)?.bundle },
    async keyFor(bundleId: string) {
      const found = roster.find(r => r.bundle === bundleId)
      return found === undefined ? undefined : { key: found.key, label: found.label }
    },
    async add() { return { ok: false } },
    async remove() { return { ok: false } },
    async addResolved() { return { ok: false } },
  }
}

const STACK: DockFile = {
  version: 1,
  stack: [
    { app: 'codex', bundle_id: CODEX, original: ELSEWHERE },
    { app: 'claude', bundle_id: CLAUDE, original: ELSEWHERE },
    { app: 'kimi', bundle_id: KIMI, original: ELSEWHERE },
  ],
  current: 'kimi',
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 用例里写世界状态用数组,省得每条都 new Set。 */
interface WorldInput {
  running?: string[]
  hidden?: string[]
  windowless?: string[]
  helperDown?: string
  frames?: Record<string, HelperRect>
}

async function setup(over: {
  world?: WorldInput
  dock?: DockFile
  keepCurrentInSlot?: boolean
  firstRun?: boolean
} = {}) {
  const file = join(await mkdtemp(join(tmpdir(), 'dock-restore-')), 'dock.json')
  await saveDockFile(file, over.dock ?? STACK)
  const world: World = {
    running: new Set(over.world?.running ?? [KIMI, CLAUDE, CODEX]),
    hidden: new Set(over.world?.hidden ?? [KIMI]),
    windowless: new Set(over.world?.windowless ?? []),
    ...(over.world?.helperDown === undefined ? {} : { helperDown: over.world.helperDown }),
    frames: new Map(Object.entries(over.world?.frames ?? {})),
  }
  const shell = fakeShell(world)
  const commands = fakeCommands(world)
  const dock = createDockService({
    file,
    helper: shell.channel,
    registry: fakeRegistry(),
    runCommand: commands.runCommand,
    sleep: () => Promise.resolve(),
    ...(over.keepCurrentInSlot === false ? {} : { keepCurrentInSlot: true }),
    restoreSettleMs: 20,
    ...(over.firstRun === undefined ? {} : { firstRun: () => over.firstRun === true }),
  })
  return { dock, world, shell, commands, file }
}

/** 等写队列里那一轮摆回跑完(摆回在计时器里排进写队列;view 不进写队列,拿 reorder 当"排在它后面"的探针)。 */
async function settle(dock: Awaited<ReturnType<typeof setup>>['dock']): Promise<void> {
  await sleep(60)
  await dock.reorder([])
}

const ops = (calls: readonly HelperRequest[], op: HelperRequest['op']) => calls.filter(call => call.op === op)

describe('起来之后把 current 摆回窗位', () => {
  it('★维护者那一幕:current 是 Kimi(被藏着),别的成员露在窗位上 → Kimi 摆回窗位,别的藏起来,不置前', async () => {
    const { dock, world, shell, file } = await setup({ world: { hidden: [KIMI] } })
    dock.setSlotRect(PAGE_RECT)
    await settle(dock)

    // 把它从藏着里放出来,贴到窗位上。
    expect(ops(shell.calls, 'unhide_app').map(call => call.op === 'unhide_app' && call.bundle_id)).toContain(KIMI)
    const framed = ops(shell.calls, 'set_window_frame').map(call => call.op === 'set_window_frame' && [call.bundle_id, call.frame])
    expect(framed).toEqual([[KIMI, SLOT]])
    // **不置前、不激活**:这一下不是他点的。
    expect(ops(shell.calls, 'raise_window')).toEqual([])
    // 露在窗位上的别的成员藏起来,不然 Kimi 在它们下面。
    expect(ops(shell.calls, 'hide_app').map(call => call.op === 'hide_app' && call.bundle_id).sort()).toEqual([CLAUDE, CODEX].sort())
    expect(world.hidden.has(KIMI)).toBe(false)

    const saved = await loadDockFile(file)
    expect(saved.current).toBe('kimi')
    const view = await dock.view()
    expect(view?.stack.find(tab => tab.key === 'kimi')?.unplaced).toBeUndefined()
    expect(view?.recent_moves?.at(-1)?.decision).toBe('restored')
    expect(view?.recent_hides?.map(row => row.decision)).toEqual(['restore-stray', 'restore-stray'])
  })

  it('矩形还在变就不摆(等它稳住,S5 那条假矩形的教训);稳住之后按最新那个矩形摆', async () => {
    const { dock, shell } = await setup()
    dock.setSlotRect({ x: 195, y: 40, w: 1640, h: 960 }) // 半截布局量出来的
    await sleep(10)
    dock.setSlotRect(PAGE_RECT)
    await settle(dock)
    expect(ops(shell.calls, 'set_window_frame').map(call => call.op === 'set_window_frame' && call.frame)).toEqual([SLOT])
  })

  it('只摆一次:之后页面再报同一个矩形、或者矩形变了(不是拖把手),都不再动窗(S5 照旧)', async () => {
    const { dock, shell } = await setup()
    dock.setSlotRect(PAGE_RECT)
    await settle(dock)
    const before = ops(shell.calls, 'set_window_frame').length
    dock.setSlotRect({ x: 195, y: 180, w: 1640, h: 820 })
    await settle(dock)
    expect(ops(shell.calls, 'set_window_frame').length).toBe(before)
  })

  it('★Kimi 没开着 → 不替他开;那一格记「没开着」,引导做完了就回事务官那一页(current 置空)', async () => {
    const { dock, commands, file } = await setup({ world: { running: [CLAUDE, CODEX], hidden: [] } })
    dock.setSlotRect(PAGE_RECT)
    await settle(dock)
    expect(commands.commands.filter(cmd => cmd[0] === 'open')).toEqual([])
    expect((await loadDockFile(file)).current).toBeNull()
    const view = await dock.view()
    expect(view?.stack.find(tab => tab.key === 'kimi')?.unplaced).toBe('Kimi 没开着')
    expect(view?.note).toContain('先回到事务官这一页')
    expect(view?.recent_moves?.at(-1)?.decision).toBe('restore-failed')
  })

  it('开着但一扇窗都没有 → 不补发 open(那会把它激活到最前);记原因、回事务官页', async () => {
    const { dock, commands, file } = await setup({ world: { windowless: [KIMI] } })
    dock.setSlotRect(PAGE_RECT)
    await settle(dock)
    expect(commands.commands.filter(cmd => cmd[0] === 'open')).toEqual([])
    expect((await loadDockFile(file)).current).toBeNull()
    expect((await dock.view())?.stack.find(tab => tab.key === 'kimi')?.unplaced).toContain('没有打开的窗口')
  })

  it('引导还没做完(屏上是引导)→ 记原因,但 current 不动', async () => {
    const { dock, file } = await setup({ world: { running: [CLAUDE, CODEX] }, firstRun: true })
    dock.setSlotRect(PAGE_RECT)
    await settle(dock)
    expect((await loadDockFile(file)).current).toBe('kimi')
  })

  it('壳不通(还没授权)→ 什么都不摆、不改 current;壳连上(noteShellReady)之后再摆', async () => {
    const { dock, world, shell, file } = await setup({ world: { helperDown: '辅助功能未授权' } })
    dock.setSlotRect(PAGE_RECT)
    await settle(dock)
    expect((await loadDockFile(file)).current).toBe('kimi')
    expect(ops(shell.calls, 'set_window_frame')).toEqual([])

    delete world.helperDown
    dock.noteShellReady?.()
    await settle(dock)
    expect(ops(shell.calls, 'set_window_frame').map(call => call.op === 'set_window_frame' && call.bundle_id)).toEqual([KIMI])
  })

  it('壳重启过(noteShellReady)→ 再看一次;已经好好露在窗位上就一个字不动(他可能正在用它)', async () => {
    const { dock, shell } = await setup()
    dock.setSlotRect(PAGE_RECT)
    await settle(dock)
    const before = shell.calls.length
    dock.noteShellReady?.()
    await settle(dock)
    const after = shell.calls.slice(before).map(call => call.op)
    expect(after).not.toContain('set_window_frame')
    expect(after).not.toContain('hide_app')
    expect(after).not.toContain('unhide_app')
  })

  it('原来就露着、只是不在窗位上(被挪到别的屏了)→ 摆回来,但不去藏别家(他可能正在用其中一扇)', async () => {
    const { dock, shell } = await setup({ world: { hidden: [] } })
    dock.setSlotRect(PAGE_RECT)
    await settle(dock)
    expect(ops(shell.calls, 'set_window_frame').map(call => call.op === 'set_window_frame' && [call.bundle_id, call.frame])).toEqual([[KIMI, SLOT]])
    expect(ops(shell.calls, 'hide_app')).toEqual([])
    expect(ops(shell.calls, 'raise_window')).toEqual([])
  })

  it('current 本来就是空(事务官那一页)→ 什么都不做', async () => {
    const { dock, shell } = await setup({ dock: { ...STACK, current: null } })
    dock.setSlotRect(PAGE_RECT)
    await settle(dock)
    expect(shell.calls.filter(call => call.op !== 'screen_info' && call.op !== 'hover_zone')).toEqual([])
  })

  it('没开这一档(keepCurrentInSlot 缺省)→ 一个请求都不多发(既有用例的行为逐字不变)', async () => {
    const { dock, shell } = await setup({ keepCurrentInSlot: false })
    dock.setSlotRect(PAGE_RECT)
    await settle(dock)
    expect(ops(shell.calls, 'set_window_frame')).toEqual([])
    expect(ops(shell.calls, 'unhide_app')).toEqual([])
  })
})

describe('平时:当前那一扇其实不在窗位里 → view 里那一格带 unplaced', () => {
  /** 先让起来之后那一轮摆回走完(Kimi 好好在窗位里),再模拟"之后它出了事"。 */
  async function placed(world?: WorldInput) {
    const ctx = await setup({ world: { hidden: [], ...world } })
    ctx.dock.setSlotRect(PAGE_RECT)
    await settle(ctx.dock)
    expect((await ctx.dock.view())?.stack.find(tab => tab.key === 'kimi')?.unplaced).toBeUndefined()
    return ctx
  }

  it('★被藏起来了(⌘H、别的应用把它藏了)→「Kimi 被藏起来了」;点标签拉回来就消失', async () => {
    const { dock, world } = await placed()
    world.hidden.add(KIMI)
    // 状态缓存 3 秒;拉一次(switchTo)会让它当场作废 —— 这里先等缓存过期再看。
    await dock.reorder([]) // 写队列里走一个活 = 缓存作废
    expect((await dock.view())?.stack.find(tab => tab.key === 'kimi')?.unplaced).toBe('Kimi 被藏起来了')
    expect((await dock.switchTo('kimi')).ok).toBe(true)
    expect((await dock.view())?.stack.find(tab => tab.key === 'kimi')?.unplaced).toBeUndefined()
  })

  it('没开着(他把 Kimi 退了)→「Kimi 没开着」;不是当前那一格的不问', async () => {
    const { dock, world, commands } = await placed()
    world.running.delete(KIMI)
    await dock.reorder([])
    commands.commands.length = 0
    const view = await dock.view()
    expect(view?.stack.find(tab => tab.key === 'kimi')?.unplaced).toBe('Kimi 没开着')
    expect(view?.stack.find(tab => tab.key === 'codex')?.unplaced).toBeUndefined()
    // 只问当前那一家的「藏没藏」。
    expect(commands.commands.filter(cmd => cmd.includes('hidden')).map(cmd => cmd.at(-1))).toEqual([KIMI])
  })

  it('弹层让路(veil)时 current 是故意藏的 → 不算空槽', async () => {
    const { dock } = await placed()
    await dock.veil()
    expect((await dock.view())?.stack.find(tab => tab.key === 'kimi')?.unplaced).toBeUndefined()
  })

  it('没开这一档 → view 不去问藏没藏', async () => {
    const { dock, commands } = await setup({ keepCurrentInSlot: false, world: { hidden: [KIMI] } })
    const view = await dock.view()
    expect(view?.stack.find(tab => tab.key === 'kimi')?.unplaced).toBeUndefined()
    expect(commands.commands.filter(cmd => cmd.includes('hidden'))).toEqual([])
  })

  it('点标签切换没切成 → 那一格记原因(标签上写「点一下拉进来」);再切成了就清掉', async () => {
    const { dock, world } = await setup({ keepCurrentInSlot: false, dock: { ...STACK, current: 'codex' }, world: { hidden: [], windowless: [CLAUDE] } })
    dock.setSlotRect(PAGE_RECT)
    const failed = await dock.switchTo('claude')
    expect(failed.ok).toBe(false)
    expect((await dock.view())?.stack.find(tab => tab.key === 'claude')?.unplaced).toBeDefined()
    world.windowless.delete(CLAUDE)
    expect((await dock.switchTo('claude')).ok).toBe(true)
    expect((await dock.view())?.stack.find(tab => tab.key === 'claude')?.unplaced).toBeUndefined()
  })
})
