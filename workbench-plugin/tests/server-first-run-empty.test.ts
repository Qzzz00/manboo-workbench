/**
 * 第一次用:服务端那一半 —— **工作台自己不往窗位里放任何东西**(2026-09-18)。
 *
 * Ben 真机原话:「我是第一次用啊……窗口槽里也什么都有了。」两条:
 * ① 窗位清单在首次期间默认一个都不出现(他亲手加过的除外);
 * ② 没认领过的应用在首次期间只认**真实拖拽**,程序化移动一律不认领。
 *
 * 两条都**不传就不启用**,既有那一大批用例一条都不受影响 —— 这一份里专门有用例钉这件事。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_KEYS, createAppsRegistry, loadAppsFile } from '../src/server/appsRegistry.ts'
import { createDockService } from '../src/server/dock.ts'
import { APP_BUNDLES } from '../src/server/activation.ts'
import type { AppsRegistry } from '../src/server/appsRegistry.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'

const noOsascript = async () => ({ ok: false, stdout: '' })
const noSleep = (): Promise<void> => Promise.resolve()

async function tmpFile(prefix: string, name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), prefix)), name)
}

function keysOf(list: readonly { key: string }[]): string[] {
  return list.map(row => row.key)
}

// ── ① 窗位清单 ────────────────────────────────────────────────────────────────

describe('窗位应用清单:第一次用时默认一个都不出现', () => {
  it('★引导还没做完 → 清单是空的(不是七家全在,也不是"扫到的那几家")', async () => {
    const registry = createAppsRegistry({
      file: await tmpFile('apps-first-', 'apps.json'),
      runOsascript: noOsascript,
      installedKeys: () => new Set(['claude', 'wechat']),
      firstRun: () => true,
    })
    expect(keysOf(await registry.list())).toEqual([])
  })

  it('引导做完 → 立刻回到「默认值随探测走」那一版的样子', async () => {
    let done = false
    const registry = createAppsRegistry({
      file: await tmpFile('apps-first-', 'apps.json'),
      runOsascript: noOsascript,
      installedKeys: () => new Set(['claude', 'wechat']),
      firstRun: () => !done,
    })
    expect(keysOf(await registry.list())).toEqual([])
    done = true
    expect(keysOf(await registry.list())).toEqual(['claude', 'wechat', 'term', 'calendar'])
  })

  it('★他亲手加过的(enabled)压过这一档 —— 首次也照样在清单里', async () => {
    const file = await tmpFile('apps-first-', 'apps.json')
    const registry = createAppsRegistry({
      file, runOsascript: noOsascript, firstRun: () => true,
    })
    // 拖一扇微信窗进窗位 = 自愈注册;它会记一笔 enabled(「他亲手加过」)。
    const added = await registry.addResolved({ bundle_id: APP_BUNDLES.wechat as string, name: '微信' })
    expect(added).toEqual({ ok: true, key: 'wechat' })
    expect((await loadAppsFile(file)).enabled).toEqual(['wechat'])
    // 首次期间清单里只有他刚放进去的那一个 —— 「是他选的才开」。
    expect(keysOf(await registry.list())).toEqual(['wechat'])
  })

  it('★不传 firstRun → 跟这一版之前一模一样(七家全在)', async () => {
    const registry = createAppsRegistry({ file: await tmpFile('apps-first-', 'apps.json'), runOsascript: noOsascript })
    expect(keysOf(await registry.list())).toEqual([...BASE_KEYS])
  })
})

// ── ② 窗位叠 ──────────────────────────────────────────────────────────────────

const CLAUDE_BUNDLE = 'com.example.claude'
const SLOT_PAGE_RECT = { x: 100, y: 100, w: 400, h: 300 }
const SCREEN_INFO = { webview: { x: 0, y: 0, w: 2000, h: 1200 }, scale: 1 }
/** 中心点 (200,200),落在槽位屏幕矩形 [100,500]x[100,400] 内。 */
const INSIDE_FRAME = { x: 150, y: 150, w: 100, h: 100 }

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
    file: await tmpFile('dock-first-', 'dock.json'),
    helper: helper.channel,
    registry: fakeRegistry(),
    runCommand: async () => ({ ok: true, stdout: '' }),
    sleep: noSleep,
    ...(firstRun === undefined ? {} : { firstRun: () => firstRun }),
  })
  svc.setSlotRect(SLOT_PAGE_RECT)
  return { svc, helper }
}

describe('窗位叠:第一次用时不自动认领', () => {
  it('★首次 + 程序化移动(dragged=false)→ 不认领,叠还是空的,也不冒一句 note 出来', async () => {
    const { svc, helper } = await dockWith(true)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, false)
    const view = await svc.view()
    expect(view?.stack).toEqual([])
    expect(view?.note).toBeUndefined()
    // 一次摆窗都不该发生 —— 用户这会儿压根没在跟窗位打交道。
    expect(helper.calls.some(c => c.op === 'set_window_frame')).toBe(false)
    // 观测环里如实记着这一条(排障时一眼看得出是"首次不认领",不是事件没到)。
    expect(view?.recent_moves?.at(-1)?.decision).toBe('first-run')
  })

  it('★首次 + 他真的拖了一扇窗进来 → 照常认领:空态那句话写的就是「把常用的窗口拖进来」', async () => {
    const { svc } = await dockWith(true)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, true)
    const view = await svc.view()
    expect(view?.stack).toEqual([{ key: 'claude', label: 'Claude', running: false, current: true }])
  })

  it('引导做完 → 程序化移动又能认领了(这一版之前的行为)', async () => {
    const { svc } = await dockWith(false)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, false)
    expect((await svc.view())?.stack).toHaveLength(1)
  })

  it('★不传 firstRun → 跟这一版之前一模一样', async () => {
    const { svc } = await dockWith(undefined)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, false)
    expect((await svc.view())?.stack).toHaveLength(1)
  })

  it('首次那一档只挡"没认领过的":已经在叠里的应用自己动窗,照旧归位', async () => {
    let first = false
    const helper = fakeHelper()
    const svc = createDockService({
      file: await tmpFile('dock-first-', 'dock.json'),
      helper: helper.channel,
      registry: fakeRegistry(),
      runCommand: async () => ({ ok: true, stdout: '' }),
      sleep: noSleep,
      firstRun: () => first,
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(CLAUDE_BUNDLE, INSIDE_FRAME, true) // 他亲手拖进来
    first = true
    await svc.handleMoved(CLAUDE_BUNDLE, { x: 900, y: 900, w: 50, h: 50 }, false) // 应用自己重建了窗
    // 还在叠里 —— 首次那道门只管"没认领过的",不会把他已经放好的窗弄丢。
    expect((await svc.view())?.stack).toHaveLength(1)
  })
})
