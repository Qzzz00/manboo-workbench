import { describe, expect, it } from 'vitest'
import { APP_COMMANDS } from '../src/server/apps.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { createOrchestrator, pageRectToScreen } from '../src/server/orchestrator.ts'

const noSleep = (): Promise<void> => Promise.resolve()

/** 假壳:按 op 顺序回放脚本化响应,记录全部请求。 */
function fakeHelper(script: (req: HelperRequest) => Record<string, unknown> | Error) {
  const calls: HelperRequest[] = []
  return {
    calls,
    channel: {
      attach: () => {},
      connected: () => true,
      view: () => ({ connected: true, authorized: true }),
      onChange: () => {},
      request: (req: HelperRequest) => {
        calls.push(req)
        const out = script(req)
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out)
      },
    },
  }
}

const runningAlways = async (cmd: readonly string[]) =>
  ({ ok: true, stdout: cmd[0] === 'lsappinfo' ? '"pid"=1\n' : '' })

describe('pageRectToScreen(页面 CSS 坐标 → AX 全局坐标)', () => {
  it('平移+缩放:webview 原点偏移叠加,scale 逐项相乘,四舍五入到整数', () => {
    expect(pageRectToScreen({ x: 10, y: 20, w: 100, h: 200 }, { x: 2560, y: 0, w: 1440, h: 2560 }, 1))
      .toEqual({ x: 2570, y: 20, w: 100, h: 200 })
    expect(pageRectToScreen({ x: 10.4, y: 0, w: 99.6, h: 10 }, { x: 0, y: 0, w: 1440, h: 2560 }, 1))
      .toEqual({ x: 10, y: 0, w: 100, h: 10 })
  })
})

describe('orchestrator.snap / unsnap', () => {
  const slot = { x: 40, y: 900, w: 1360, h: 1200 }

  it('完整贴合链:激活→screen_info→app_info→记原位→set_frame→回读一致→raise→snapped', async () => {
    const target = { x: 40, y: 900, w: 1360, h: 1200 } // webview 原点 0,0、scale 1 时与 slot 相同
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      if (req.op === 'set_window_frame') return { frame: req.frame }
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    expect(await orch.snap('term', slot)).toEqual({ ok: true })
    expect(orch.snapView()).toEqual({ app: 'term', state: 'snapped' })
    const setCall = helper.calls.find(c => c.op === 'set_window_frame')
    expect(setCall).toMatchObject({ bundle_id: 'com.apple.Terminal', index: 0, frame: target })
    expect(helper.calls.some(c => c.op === 'raise_window')).toBe(true)
  })

  it('unsnap 把窗口送回贴合前的原位', async () => {
    const originalFrame = { x: 5, y: 6, w: 700, h: 500 }
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: originalFrame }] }
      if (req.op === 'set_window_frame') return { frame: req.frame }
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    expect(await orch.snap('term', slot)).toEqual({ ok: true })

    expect(await orch.unsnap()).toEqual({ ok: true })

    const setCalls = helper.calls.filter(c => c.op === 'set_window_frame')
    const lastSet = setCalls[setCalls.length - 1]
    expect(lastSet).toMatchObject({ bundle_id: 'com.apple.Terminal', index: 0, frame: originalFrame })
    expect(orch.snapView()).toBeUndefined()
  })

  it('换贴另一个应用时先送回上一个(不留乱窗)', async () => {
    const termOriginal = { x: 5, y: 6, w: 700, h: 500 }
    const claudeOriginal = { x: 50, y: 60, w: 800, h: 600 }
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') {
        const frame = req.bundle_id === 'com.apple.Terminal' ? termOriginal : claudeOriginal
        return { running: true, hidden: false, windows: [{ index: 0, frame }] }
      }
      if (req.op === 'set_window_frame') return { frame: req.frame }
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    expect(await orch.snap('term', slot)).toEqual({ ok: true })
    expect(await orch.snap('claude', slot)).toEqual({ ok: true })

    const setCalls = helper.calls.filter(c => c.op === 'set_window_frame')
    // 顺序:1) term 贴到槽位 2) 换贴前先把 term 送回原位 3) claude 贴到槽位
    expect(setCalls.length).toBe(3)
    expect(setCalls[1]).toMatchObject({ bundle_id: 'com.apple.Terminal', index: 0, frame: termOriginal })
    expect(setCalls[2]).toMatchObject({ bundle_id: 'com.anthropic.claudefordesktop', index: 0, frame: slot })
  })

  it('回读不符→重试一次→仍不符→failed+实际值写进 reason(绝不装成功)', async () => {
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      if (req.op === 'set_window_frame') return { frame: { x: 0, y: 0, w: 300, h: 300 } } // 永远落不到位
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    const result = await orch.snap('term', slot)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('300')
    expect(orch.snapView()).toMatchObject({ app: 'term', state: 'failed' })
    expect(helper.calls.filter(c => c.op === 'set_window_frame').length).toBe(2)
  })

  it('回读误差 ≤16px 算到位(终端类应用会把尺寸吸附到字符网格,实测 800→797)', async () => {
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      if (req.op === 'set_window_frame') {
        const f = req.frame
        // +15/-15 混着测,四个维度都验到边界内仍算到位。
        return { frame: { x: f.x + 15, y: f.y - 15, w: f.w - 3, h: f.h + 15 } }
      }
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    const result = await orch.snap('term', slot)
    expect(result.ok).toBe(true)
    // w/h 都在 16px 容差内被判到位,但 3px/15px 的差仍 >2px——如实标注(F2),不影响 ok。
    expect(orch.snapView()).toMatchObject({ app: 'term', state: 'snapped', reason: expect.stringContaining('1357×1215') })
  })

  it('回读与槽位分毫不差(w/h 差 ≤2px):snapped 不带 reason(F2 exact-fit)', async () => {
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      if (req.op === 'set_window_frame') return { frame: req.frame } // 原样回读,零偏差
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    const result = await orch.snap('term', slot)
    expect(result.ok).toBe(true)
    expect(orch.snapView()).toEqual({ app: 'term', state: 'snapped' })
  })

  it('尺寸受应用最小尺寸限制、差值超过 2px 但在政策容差内:snapped 且带 reason 如实标注(F2)', async () => {
    const bigSlot = { x: 40, y: 900, w: 900, h: 600 }
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      if (req.op === 'set_window_frame') return { frame: { x: req.frame.x, y: req.frame.y, w: 960, h: 640 } } // 企微最小尺寸,超出槽位
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    const result = await orch.snap('term', bigSlot)
    expect(result.ok).toBe(true)
    expect(orch.snapView()).toEqual({
      app: 'term',
      state: 'snapped',
      reason: '已贴合,尺寸受应用限制:实际 960×640(槽位 900×600)',
    })
  })

  it('尺寸只设下限不设上限:实际比槽位大也算到位(企微实测最小尺寸 960×640 > 槽位 900×600)', async () => {
    const bigSlot = { x: 40, y: 900, w: 900, h: 600 }
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      if (req.op === 'set_window_frame') return { frame: { x: req.frame.x, y: req.frame.y, w: 960, h: 640 } }
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    const result = await orch.snap('term', bigSlot)
    expect(result.ok).toBe(true)
  })

  it('尺寸比槽位小但在 32px 内算到位(终端字符网格向下取整,实测 -19px)', async () => {
    const gridSlot = { x: 40, y: 900, w: 1360, h: 600 }
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      if (req.op === 'set_window_frame') return { frame: { x: req.frame.x, y: req.frame.y, w: req.frame.w, h: 581 } } // 600-19
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    const result = await orch.snap('term', gridSlot)
    expect(result.ok).toBe(true)
  })

  it('尺寸达标但位置偏了 300px 仍判失败(位置钳制不因尺寸宽松而放过)', async () => {
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      if (req.op === 'set_window_frame') return { frame: { x: req.frame.x + 300, y: req.frame.y, w: req.frame.w, h: req.frame.h } }
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    const result = await orch.snap('term', slot)
    expect(result.ok).toBe(false)
  })

  it('尺寸比槽位小超过 32px 判失败', async () => {
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      if (req.op === 'set_window_frame') return { frame: { x: req.frame.x, y: req.frame.y, w: req.frame.w - 100, h: req.frame.h } }
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    const result = await orch.snap('term', slot)
    expect(result.ok).toBe(false)
  })

  it('应用没有窗口:有限重试等待后 failed「没有可贴合的窗口」', async () => {
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [] }
      return {}
    })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    const result = await orch.snap('term', slot)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('没有可贴合的窗口')
    expect(helper.calls.filter(c => c.op === 'app_info').length).toBe(10)
  })

  it('微信2 实测:后台运行但零窗口→补发一次 open 唤窗→窗口出现后继续贴合', async () => {
    let appInfoCalls = 0
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') {
        appInfoCalls += 1
        if (appInfoCalls === 1) return { running: true, hidden: false, windows: [] }
        return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      }
      if (req.op === 'set_window_frame') return { frame: req.frame }
      return {}
    })
    const opens: (readonly string[])[] = []
    const runCommand = async (cmd: readonly string[]) => {
      if (cmd[0] === 'open') opens.push(cmd)
      return { ok: true, stdout: cmd[0] === 'lsappinfo' ? '"pid"=1\n' : '' }
    }
    const orch = createOrchestrator({ helper: helper.channel, runCommand, sleep: noSleep })
    const result = await orch.snap('wechat', slot)
    expect(result.ok).toBe(true)
    // 已在运行(lsappinfo 有 pid),ensureRunningWith 不发 open——这一次 open 只来自
    // waitForWindow 的补唤窗,一次顶多补一次。
    expect(opens).toEqual([APP_COMMANDS.wechat])
  })

  it('激活失败原因原样透传(ensureRunning 的 reason)', async () => {
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      return {}
    })
    const neverRunning = async (cmd: readonly string[]) => ({ ok: true, stdout: cmd[0] === 'lsappinfo' ? '' : '' })
    const orch = createOrchestrator({ helper: helper.channel, runCommand: neverRunning, sleep: noSleep })
    const result = await orch.snap('term', slot)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('激活失败')
    expect(helper.calls.some(c => c.op === 'screen_info' || c.op === 'app_info')).toBe(false)
  })

  it('helper 未授权:request reject 的原因进 failed reason', async () => {
    const helper = fakeHelper(() => new Error('辅助功能未授权'))
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep })
    const result = await orch.snap('term', slot)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('辅助功能未授权')
    expect(orch.snapView()).toMatchObject({ app: 'term', state: 'failed', reason: '辅助功能未授权' })
  })
})

describe('orchestrator + registry(spec S4:自定义应用也能贴合)', () => {
  const slot = { x: 40, y: 900, w: 1360, h: 1200 }

  it('registry 认识的自定义键:走 registry.commandFor/bundleFor 解析,贴合成功', async () => {
    const helper = fakeHelper((req) => {
      if (req.op === 'screen_info') return { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 }
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: { x: 5, y: 6, w: 700, h: 500 } }] }
      if (req.op === 'set_window_frame') return { frame: req.frame }
      return {}
    })
    const registry = {
      commandFor: async (key: string) => (key === 'c-notion' ? ['open', '-a', 'Notion'] : undefined),
      bundleFor: async (key: string) => (key === 'c-notion' ? 'notion.id' : undefined),
    }
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep, registry })
    expect(await orch.snap('c-notion', slot)).toEqual({ ok: true })
    expect(orch.snapView()).toMatchObject({ app: 'c-notion', state: 'snapped' })
  })

  it('registry 不认识的键:失败且不发任何 helper 请求(不瞎猜)', async () => {
    const helper = fakeHelper(() => ({}))
    const registry = {
      commandFor: async () => undefined,
      bundleFor: async () => undefined,
    }
    const orch = createOrchestrator({ helper: helper.channel, runCommand: runningAlways, sleep: noSleep, registry })
    const result = await orch.snap('c-nope', slot)
    expect(result).toEqual({ ok: false, reason: '不认识这个应用:c-nope' })
    expect(helper.calls.length).toBe(0)
  })
})
