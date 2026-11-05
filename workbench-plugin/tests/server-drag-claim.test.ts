/**
 * 拖窗认领的三态判定(2026-09-18,Ben 真机:「网易云音乐、终端可以拖拽进去,也有交互反馈,
 * Claude 和企业微信不行」)。
 *
 * 壳给服务端的「用户在拖没有」现在是**两条独立证据**:
 * - `dragged` —— 这轮 AX 事件风暴里左键按过没有(2026-08-26 微信重登那次加的);
 * - `pressed` —— **落定那一刻**左键还按着没有(这张卡新加)。
 *
 * 为什么要第二条:`dragged` 只在 **AX 事件回调里**采样。事件风暴起得比按键晚的那一拍
 * (应用第一帧 moved 迟到、壳刚重挂完观察者)按键状态压根没人读过,dragged 就是 false,
 * 首次那道门会把一次真实拖拽当成程序化移动挡掉。`pressed` 与事件时序无关,是第二道。
 *
 * 这一份钉的是**服务端**那一半:三态(true / false / 缺席)× pressed 的认领判定。
 * 壳那一半(AX 全灭时用 CGWindowList 兜底认出这次拖拽)在 workbench-app/Tests/main.swift。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDockService } from '../src/server/dock.ts'
import type { AppsRegistry } from '../src/server/appsRegistry.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'

const CLAUDE_BUNDLE = 'com.anthropic.claudefordesktop'
const SLOT_PAGE_RECT = { x: 100, y: 100, w: 400, h: 300 }
const SCREEN_INFO = { webview: { x: 0, y: 0, w: 2000, h: 1200 }, scale: 1 }
/** 中心点 (200,200),落在槽位屏幕矩形 [100,500]×[100,400] 内。 */
const INSIDE_FRAME = { x: 150, y: 150, w: 100, h: 100 }

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'dock-drag-')), 'dock.json')
}

function fakeHelper() {
  const calls: HelperRequest[] = []
  return {
    calls,
    channel: {
      request: (req: HelperRequest) => {
        calls.push(req)
        if (req.op === 'screen_info') return Promise.resolve(SCREEN_INFO as Record<string, unknown>)
        if (req.op === 'app_info') return Promise.resolve({ running: true, hidden: false, windows: [{ index: 0, frame: INSIDE_FRAME }] })
        return Promise.resolve({})
      },
    },
  }
}

function fakeRegistry(): AppsRegistry {
  return {
    async list() { return [{ key: 'claude', label: 'Claude' }] },
    async listAll() { return [{ key: 'claude', label: 'Claude' }] },
    async enable() { return { enabled: [], already: [], unknown: [] } },
    async commandFor() { return ['open', '-a', 'Claude'] },
    async bundleFor() { return CLAUDE_BUNDLE },
    async keyFor(bundleId: string) {
      return bundleId === CLAUDE_BUNDLE ? { key: 'claude', label: 'Claude' } : undefined
    },
    async add() { return { ok: false, reason: '假 registry 不支持' } },
    async remove() { return { ok: false, reason: '假 registry 不支持' } },
    async addResolved() { return { ok: false, reason: '假 registry 不支持' } },
  }
}

async function dockWith(firstRun: boolean | undefined) {
  const helper = fakeHelper()
  const svc = createDockService({
    file: await tmpFile(),
    helper: helper.channel,
    registry: fakeRegistry(),
    runCommand: async () => ({ ok: true, stdout: '' }),
    sleep: () => Promise.resolve(),
    ...(firstRun === undefined ? {} : { firstRun: () => firstRun }),
  })
  svc.setSlotRect(SLOT_PAGE_RECT)
  return { svc, helper }
}

/** 这次 moved 之后,叠里有没有这个应用。 */
async function adopted(svc: Awaited<ReturnType<typeof dockWith>>['svc']): Promise<boolean> {
  return ((await svc.view())?.stack.length ?? 0) > 0
}

// ── 首次期间的三态 × pressed ──────────────────────────────────────────────────

describe('首次 + 没认领过:dragged 三态 × 鼠标按下', () => {
  it('★dragged=true(壳看见了拖拽)→ 认领', async () => {
    const { svc } = await dockWith(true)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, true)
    expect(await adopted(svc)).toBe(true)
  })

  it('★dragged=false + pressed=true(AX 漏采了事件风暴,但落定那一刻手还按着)→ 认领', async () => {
    const { svc } = await dockWith(true)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, false, true)
    expect(await adopted(svc)).toBe(true)
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('adopted')
  })

  it('★dragged=false + pressed=false(两条证据都没有)→ 不认领,这才是程序化移动', async () => {
    const { svc, helper } = await dockWith(true)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, false, false)
    expect(await adopted(svc)).toBe(false)
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('first-run')
    // 一次摆窗都不该发生。
    expect(helper.calls.some(c => c.op === 'set_window_frame')).toBe(false)
  })

  it('★dragged 缺席(旧壳)→ 按 true 走旧行为:认领', async () => {
    const { svc } = await dockWith(true)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME)
    expect(await adopted(svc)).toBe(true)
  })

  it('dragged=false + pressed 缺席(旧壳)→ 跟这一版之前一模一样:不认领', async () => {
    const { svc } = await dockWith(true)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, false)
    expect(await adopted(svc)).toBe(false)
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('first-run')
  })

  it('dragged=true + pressed=true(两条都有)→ 认领,与只有一条时同一个结果', async () => {
    const { svc } = await dockWith(true)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, true, true)
    expect(await adopted(svc)).toBe(true)
  })
})

// ── pressed 只在首次那道门上说话,别的分支一个字都不看它 ──────────────────────

describe('pressed 的作用面刻意做窄', () => {
  it('★引导做完 → 首次那道门本来就不在,pressed 是什么都认领', async () => {
    const { svc } = await dockWith(false)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, false, false)
    expect(await adopted(svc)).toBe(true)
  })

  it('★不传 firstRun → 跟这一版之前一模一样(这一大批既有用例的口径)', async () => {
    const { svc } = await dockWith(undefined)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, false, false)
    expect(await adopted(svc)).toBe(true)
  })

  it('已认领 + 程序化移动(dragged=false)+ pressed=true:照旧归位,不因为 pressed 就改判成拖拽', async () => {
    const { svc, helper } = await dockWith(false)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, true) // 先认领
    const before = helper.calls.length
    // 应用自己把窗摆到了槽外,而这一刻用户手里正按着鼠标在干别的事。
    await svc.handleMoved(CLAUDE_BUNDLE, { x: 900, y: 900, w: 300, h: 200 }, false, true)
    // 还在叠里(没被当成"拖出去"除名),而且发生过一次归位摆位。
    expect(await adopted(svc)).toBe(true)
    expect(helper.calls.slice(before).some(c => c.op === 'set_window_frame')).toBe(true)
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('homed')
  })

  it('已认领 + dragged=true + 界外:照旧除名 —— pressed 不参与这一支', async () => {
    const { svc } = await dockWith(false)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, true)
    await svc.handleMoved(CLAUDE_BUNDLE, { x: 900, y: 900, w: 300, h: 200 }, true, true)
    expect(await adopted(svc)).toBe(false)
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('outside')
  })

  it('首次 + 界外 + pressed=true:界外就是界外,pressed 不能把它拉进来', async () => {
    const { svc } = await dockWith(true)
    await svc.handleMoved(CLAUDE_BUNDLE, { x: 1500, y: 900, w: 300, h: 200 }, false, true)
    expect(await adopted(svc)).toBe(false)
    // 跟叠无关的一帧:既不认领,也不该记成 first-run(那是"界内但挡下了"才有的话)。
    expect((await svc.view())?.recent_moves?.at(-1)?.decision).toBe('ignored')
  })
})
