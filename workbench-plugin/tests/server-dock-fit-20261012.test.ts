// @vitest-environment node
/**
 * 窗口槽贴合的四条小修(2026-10-12,卡 `claude/ops-patch-1012`;运营同学 10-08 在 0.4.98 产物上改的「窗口槽基础适配」)。
 *
 * 他那台机器上看到的:外接屏 / 换布局之后当前那一扇窗跟不上槽位;一扇比槽位宽出几百像素的窗被当成「已在槽位」永远不贴回去;
 * 几家 Electron 客户端第一下 `set_window_frame` 只吃一半(位置到了、尺寸没到)。
 *
 * 钉四件事:
 *   ① 归位判定尺寸**两头都看**:比槽位宽出一截的窗也要贴回去;±32px 以内照旧算在槽位;
 *   ② 带 reason:'resize' 的新矩形 → 走**完整的贴合路径**(先 unhide 再贴,不置前),不是一条裸的 set_window_frame;
 *   ③ 弹层正开着(veil)时不重贴 —— 让路藏起来的那一扇由 unveil 自己带回来;
 *   ④ 程序化认领贴完等一拍再量一次,没贴准就再贴一次;贴准了就不多发。
 * 噪声门槛仍是 8px(他改成 2px 的那一条没合:8px 是按真机截图定的,见 dock.ts `SLOT_RECT_NOISE_THRESHOLD_PX`)。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HelperRect } from '../src/protocol.ts'
import { APP_BUNDLES } from '../src/server/activation.ts'
import type { AppsRegistry } from '../src/server/appsRegistry.ts'
import { createAppsRegistry } from '../src/server/appsRegistry.ts'
import { createDockService } from '../src/server/dock.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'

const noSleep = (): Promise<void> => Promise.resolve()

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'dock-fit-')), 'dock.json')
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 5))
  }
}

const CLAUDE_BUNDLE = 'com.example.claude'
const SLOT_PAGE_RECT = { x: 100, y: 100, w: 400, h: 300 }
const SLOT_SCREEN = { x: 100, y: 100, w: 400, h: 300 }
const PORTRAIT_PAGE_RECT = { x: 20, y: 900, w: 400, h: 847 }
const SCREEN_INFO = { webview: { x: 0, y: 0, w: 2000, h: 1200 }, scale: 1 }
const INSIDE_FRAME = { x: 150, y: 150, w: 100, h: 100 }

/** 假壳:记下每条请求;`app_info` 回此刻那一家的窗帧,`set_window_frame` 按 `apply` 决定吃多少。 */
function fakeShell(options: { apply?: (frame: HelperRect, nth: number) => HelperRect } = {}) {
  const calls: HelperRequest[] = []
  const frames = new Map<string, HelperRect>([[CLAUDE_BUNDLE, { x: 900, y: 50, w: 800, h: 600 }]])
  let sets = 0
  const channel = {
    request: (req: HelperRequest): Promise<Record<string, unknown>> => {
      calls.push(req)
      if (req.op === 'screen_info') return Promise.resolve(SCREEN_INFO)
      if (req.op === 'app_info') return Promise.resolve({ running: true, hidden: false, windows: [{ index: 0, frame: frames.get(req.bundle_id) }] })
      if (req.op === 'set_window_frame') {
        sets += 1
        frames.set(req.bundle_id, options.apply === undefined ? req.frame : options.apply(req.frame, sets))
      }
      return Promise.resolve({})
    },
  }
  return { calls, channel, frames }
}

function fakeRegistry(): AppsRegistry {
  const entries = [{ key: 'claude', label: 'Claude', bundleId: CLAUDE_BUNDLE, cmd: ['open', '-a', 'Claude'] }]
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
    async addResolved() { return { ok: false, reason: '假 registry 不支持' } },
  }
}

/** lsappinfo 一律说在跑;别的命令记下来。 */
function fakeRunCommand() {
  const ran: string[][] = []
  return {
    ran,
    runCommand: async (cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> => {
      if (cmd[0] === 'lsappinfo') return { ok: true, stdout: '"pid"=123\n' }
      ran.push([...cmd])
      return { ok: true, stdout: '' }
    },
  }
}

async function adopted(shell = fakeShell()) {
  const svc = createDockService({
    file: await tmpFile(), helper: shell.channel, registry: fakeRegistry(),
    runCommand: fakeRunCommand().runCommand, sleep: noSleep,
  })
  svc.setSlotRect(SLOT_PAGE_RECT)
  await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
  shell.calls.length = 0
  return { shell, svc }
}

const setFrames = (calls: HelperRequest[]) => calls.filter(c => c.op === 'set_window_frame')

describe('① 归位判定尺寸两头都看', () => {
  it('★比槽位宽出 300px、位置却对着 → 不再算「已在槽位」,贴回去(decision:homed)', async () => {
    const { shell, svc } = await adopted()
    await svc.handleMoved(CLAUDE_BUNDLE, { x: 100, y: 100, w: 700, h: 300 }, false)
    expect(setFrames(shell.calls)).toEqual([{ op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: SLOT_SCREEN }])
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('homed')
  })

  it('尺寸差在 ±32px 以内(应用按网格 / 最小尺寸微调那一下)→ 照旧什么都不做(decision:settled)', async () => {
    for (const frame of [{ x: 100, y: 100, w: 380, h: 300 }, { x: 100, y: 100, w: 420, h: 320 }]) {
      const { shell, svc } = await adopted()
      await svc.handleMoved(CLAUDE_BUNDLE, frame, false)
      expect(setFrames(shell.calls)).toEqual([])
      expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('settled')
    }
  })
})

describe('② 带 reason:resize 的新矩形走完整贴合路径', () => {
  it('★先 unhide 再贴、不置前;贴的是新矩形', async () => {
    const { shell, svc } = await adopted()
    svc.setSlotRect(PORTRAIT_PAGE_RECT, 'resize')
    await until(() => setFrames(shell.calls).length > 0)
    await new Promise(r => setTimeout(r, 30))
    const ops = shell.calls.map(c => c.op)
    expect(ops.indexOf('unhide_app')).toBeGreaterThanOrEqual(0)
    expect(ops.indexOf('unhide_app')).toBeLessThan(ops.indexOf('set_window_frame'))
    expect(ops).not.toContain('raise_window')
    expect(setFrames(shell.calls)).toEqual([{ op: 'set_window_frame', bundle_id: CLAUDE_BUNDLE, index: 0, frame: PORTRAIT_PAGE_RECT }])
    expect((await svc.view())?.note).toBeUndefined()
  })

  it('没带 reason 的被动上报照旧只推悬停圈,一扇窗都不碰(S5 那条没动)', async () => {
    const { shell, svc } = await adopted()
    svc.setSlotRect(PORTRAIT_PAGE_RECT)
    await until(() => shell.calls.some(c => c.op === 'hover_zone'))
    await new Promise(r => setTimeout(r, 30))
    expect(setFrames(shell.calls)).toEqual([])
    expect(shell.calls.some(c => c.op === 'unhide_app')).toBe(false)
  })
})

describe('④ 程序化认领贴完再量一眼', () => {
  async function claimRig(apply?: (frame: HelperRect, nth: number) => HelperRect) {
    const dir = await mkdtemp(join(tmpdir(), 'dock-fit-claim-'))
    const appsFile = join(dir, 'apps.json')
    await writeFile(appsFile, JSON.stringify({ version: 1, apps: [], disabled: [], enabled: ['claude'] }))
    const shell = fakeShell(apply === undefined ? {} : { apply })
    const bundle = APP_BUNDLES.claude as string
    shell.frames.set(bundle, { x: 900, y: 50, w: 800, h: 600 })
    const registry = createAppsRegistry({ file: appsFile, runOsascript: async () => ({ ok: false, stdout: '' }) })
    const dock = createDockService({ file: join(dir, 'dock.json'), helper: shell.channel, registry, runCommand: fakeRunCommand().runCommand, sleep: noSleep })
    dock.setSlotRect(SLOT_PAGE_RECT)
    await dock.view()
    await new Promise(r => setTimeout(r, 5))
    shell.calls.length = 0
    return { dock, shell, bundle }
  }

  it('★第一下只吃了位置、尺寸没到 → 等一拍再贴一次;第二下贴准了就停', async () => {
    const { dock, shell, bundle } = await claimRig((frame, nth) => (nth === 1 ? { ...frame, w: 800, h: 600 } : frame))
    const report = await dock.claimEnabled?.()
    expect(report?.results).toEqual([{ app: 'claude', label: 'Claude', state: 'claimed' }])
    expect(setFrames(shell.calls).map(c => c.op === 'set_window_frame' && [c.bundle_id, c.frame])).toEqual([[bundle, SLOT_SCREEN], [bundle, SLOT_SCREEN]])
  })

  it('第一下就贴准了 → 只发一条,不多贴', async () => {
    const { dock, shell, bundle } = await claimRig()
    await dock.claimEnabled?.()
    expect(setFrames(shell.calls).map(c => c.op === 'set_window_frame' && c.bundle_id)).toEqual([bundle])
  })
})

describe('③ 弹层正开着时不重贴', () => {
  it('★veil 之后来的 resize → 一条 set_window_frame 都不发;让路那一扇由 unveil 带回来', async () => {
    const { shell, svc } = await adopted()
    await svc.veil()
    shell.calls.length = 0
    svc.setSlotRect(PORTRAIT_PAGE_RECT, 'resize')
    await until(() => shell.calls.some(c => c.op === 'hover_zone'))
    await new Promise(r => setTimeout(r, 30))
    expect(setFrames(shell.calls)).toEqual([])
    await svc.unveil()
    await until(() => setFrames(shell.calls).length > 0)
    expect(setFrames(shell.calls).at(-1)?.frame).toEqual(PORTRAIT_PAGE_RECT)
  })
})
