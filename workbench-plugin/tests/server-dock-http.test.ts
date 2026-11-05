// @vitest-environment node
/**
 * 窗位叠路由(spec 2026-08-24 窗位叠 v2 Task 3):/slot/rect /dock/switch /dock/release +
 * /state.dock。写法对齐 server-orchestration-http.test.ts 的既有先例——假 dock 记录调用做
 * 路由/403/404 各分支,末尾一条真集成(真 dockService + 真 WS 假壳)贯通到落盘。
 *
 * 终审 I3:W4 新加的第二条写路由 `/brief/dismiss` 的 403/404/200 三条也放在这个文件——
 * 它不属于窗位叠,但"非回环来源全部 403"那张共享清单在这里,而那张清单正是防漏机制
 * (Task 1 就是靠它把 /dock/hide 补进去的)。为一条路由另造一套启动辅助,只会让下一条
 * 新路由继续漏掉。清单标题已相应改成"本机写路由",不再只说窗位叠。
 */
import { BASE_KEYS } from '../src/server/appsRegistry.ts'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { HelperRect, LiveMessage, WorkbenchState } from '../src/protocol.ts'
import type { BriefService } from '../src/server/brief.ts'
import type { DockService } from '../src/server/dock.ts'
import { createDockService } from '../src/server/dock.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createHelperChannel } from '../src/server/helperChannel.ts'
import { createAppsRegistry } from '../src/server/appsRegistry.ts'
import { APP_COMMANDS } from '../src/server/apps.ts'

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

interface Call { fn: string, args: readonly unknown[] }

/** 假 dock:记录调用,switchTo/release/view 回预设值(先例见 fakeOrchestrator/fakeScenes)。 */
function fakeDock() {
  const calls: Call[] = []
  let switchResult: { ok: boolean, reason?: string } = { ok: true }
  let releaseResult: { ok: boolean, reason?: string } = { ok: true }
  let hideResult: { ok: boolean, reason?: string } = { ok: true }
  let veilResult: { ok: boolean, reason?: string } = { ok: true }
  let viewResult: WorkbenchState['dock'] = { stack: [] }

  const dock: DockService = {
    setSlotRect(rect: HelperRect | undefined, reason?: 'resize') {
      calls.push({ fn: 'setSlotRect', args: [rect, reason] })
    },
    recordRejectedRect(rect: HelperRect | null, reason?: 'resize') {
      calls.push({ fn: 'recordRejectedRect', args: [rect, reason] })
    },
    async pushSlotApps() {
      calls.push({ fn: 'pushSlotApps', args: [] })
    },
    async pushHoverZone() {
      calls.push({ fn: 'pushHoverZone', args: [] })
    },
    async handleMoved(bundleId: string, frame: HelperRect) {
      calls.push({ fn: 'handleMoved', args: [bundleId, frame] })
    },
    async handleAxStale(info: { bundle_id: string, ax_err: number, ax_count: number, cg_count: number }) {
      calls.push({ fn: 'handleAxStale', args: [info] })
    },
    async switchTo(app: string) {
      calls.push({ fn: 'switchTo', args: [app] })
      return switchResult
    },
    async release(app: string) {
      calls.push({ fn: 'release', args: [app] })
      return releaseResult
    },
    async reorder(keys: readonly string[]) {
      calls.push({ fn: 'reorder', args: [[...keys]] })
      return { ok: true }
    },
    async hideCurrent() {
      calls.push({ fn: 'hideCurrent', args: [] })
      return hideResult
    },
    async veil() {
      calls.push({ fn: 'veil', args: [] })
      return veilResult
    },
    async unveil() {
      calls.push({ fn: 'unveil', args: [] })
      return { ok: true }
    },
    async view() {
      calls.push({ fn: 'view', args: [] })
      return viewResult
    },
    async observeTargets() {
      calls.push({ fn: 'observeTargets', args: [] })
      return []
    },
    async noteObserveFailures(bundleIds: readonly string[]) {
      calls.push({ fn: 'noteObserveFailures', args: [bundleIds] })
    },
    async noteActivated(app: string) {
      calls.push({ fn: 'noteActivated', args: [app] })
    },
  }

  return {
    dock,
    calls,
    setSwitchResult: (r: { ok: boolean, reason?: string }) => { switchResult = r },
    setReleaseResult: (r: { ok: boolean, reason?: string }) => { releaseResult = r },
    setHideResult: (r: { ok: boolean, reason?: string }) => { hideResult = r },
    setVeilResult: (r: { ok: boolean, reason?: string }) => { veilResult = r },
    setViewResult: (r: WorkbenchState['dock']) => { viewResult = r },
  }
}

/** 假 brief:记录调用,view() 回一份固定投影(同 fakeDock 的写法)。 */
function fakeBrief() {
  const calls: string[] = []
  const brief: BriefService = {
    async view() {
      calls.push('view')
      return { date: '2026-08-25', topics: [], push: false }
    },
    async dismiss() {
      calls.push('dismiss')
    },
  }
  return { brief, calls }
}

/**
 * 壳 UA 标记(2026-08-26 矩形投毒案二审):`?ben-workbench=app`/source:'app' 谁都能带——
 * 真机实证有并行会话在真实浏览器里带着 app 参数开工作台页做小视口验证,把 1240×120 的
 * 假槽位矩形当壳的身份报了进来。壳的 WKWebView 现在带专属 UA 标记,几何上报的身份
 * 校验以它为准。测试默认带标记(模拟壳内页面),UA 门那组用例专门传别的 UA。
 */
const SHELL_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 BenWorkbenchShell/1'

async function post(url: string, path: string, body: unknown, userAgent = SHELL_UA) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function serve(extra: Partial<Parameters<typeof startWorkbenchServer>[0]> = {}) {
  const service = createWorkbenchService()
  const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0, ...extra })
  started.push(server)
  return { server, service, url: server.url }
}

const RECT: HelperRect = { x: 0, y: 0, w: 640, h: 480 }

/**
 * 条件等待(异步版):handleMoved/observe 都要等壳回 res 才算数,不能用固定 tick/sleep 赌它跑完了没有,
 * 得反复重取状态直到条件成立——同款纪律先例见 tests/server-helper-events.test.ts 的 until,
 * 这里额外允许 cond 是异步的(要发一次 fetch,或读一份可变数组)。
 */
async function untilAsync<T>(fetchState: () => Promise<T>, cond: (state: T) => boolean, ms = 3000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const state = await fetchState()
    if (cond(state)) return state
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

/** 同步条件版,授权翻转不用发请求——先例见 tests/server-helper-events.test.ts。 */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('窗位叠路由(Task 3)', () => {
  describe('POST /slot/rect', () => {
    it('校验:rect 必须是 {x,y,w,h} 四项有限数字,缺一样 400,不转呼', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      expect((await post(url, '/slot/rect', { source: 'app' })).status).toBe(400)
      expect((await post(url, '/slot/rect', { rect: { x: 0, y: 0, w: 640 }, source: 'app' })).status).toBe(400)
      expect((await post(url, '/slot/rect', { rect: { x: 0, y: 0, w: 640, h: Number.NaN }, source: 'app' })).status).toBe(400)
      expect(fake.calls).toEqual([])
    })

    it('成功:不传 reason → 转呼 dock.setSlotRect(rect, undefined),200 {ok:true}', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/slot/rect', { rect: RECT, source: 'app' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'setSlotRect', args: [RECT, undefined] }])
    })

    it('I3:{rect:null} → 转呼 dock.setSlotRect(undefined, undefined) 清除,200 {ok:true}', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/slot/rect', { rect: null, source: 'app' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'setSlotRect', args: [undefined, undefined] }])
    })

    it('S5:body 带 reason:\'resize\' → 原样透传给 dock.setSlotRect(rect, \'resize\')', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/slot/rect', { rect: RECT, reason: 'resize', source: 'app' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'setSlotRect', args: [RECT, 'resize'] }])
    })

    it('S5:reason 是不认识的值(非字面量 \'resize\')→ 保守当没传,转呼 setSlotRect(rect, undefined)', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/slot/rect', { rect: RECT, reason: 'bogus', source: 'app' })
      expect(res.status).toBe(200)
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'setSlotRect', args: [RECT, undefined] }])
    })

    /**
     * 真机实证(2026-08-25 矩形上报只认壳内页面):壳内 WKWebView、Chrome 里开的工作台
     * 标签、浏览器窗格各自按自己的视口量矩形上报,互相矛盾的合法值交替覆盖会把窗位贴合
     * 位置搞乱——source !== 'app' 一律不进 dock.setSlotRect(含 rect:null 清除这条路径)。
     * 业务拒绝不是接口出错(先例 /snap):HTTP 层仍是 200、{ok:false, reason} 如实回出去。
     * 缺 source 字段(旧版页面标签、没跟上这条规则的调用方)天然落进同一条拒绝路径,
     * 不需要额外识别版本号。
     */
    it('缺 source → 200 {ok:false, reason},不转呼 dock.setSlotRect(旧版页面标签天然被拒)——但转呼 recordRejectedRect 留证', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/slot/rect', { rect: RECT })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: '仅壳内页面可上报窗位矩形' })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'recordRejectedRect', args: [RECT, undefined] }])
    })

    it('source 不是 "app"(比如浏览器标签自报的其它标识)→ 200 {ok:false, reason},不转呼 setSlotRect', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/slot/rect', { rect: RECT, source: 'browser-tab' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: '仅壳内页面可上报窗位矩形' })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'recordRejectedRect', args: [RECT, undefined] }])
    })

    it('source 缺失/错误时,{rect:null} 清除路径同样被拒,不转呼 setSlotRect(但同样转呼 recordRejectedRect(null, ...))', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const noSource = await post(url, '/slot/rect', { rect: null })
      expect(noSource.status).toBe(200)
      expect(noSource.body).toEqual({ ok: false, reason: '仅壳内页面可上报窗位矩形' })

      const wrongSource = await post(url, '/slot/rect', { rect: null, source: 'browser-tab' })
      expect(wrongSource.status).toBe(200)
      expect(wrongSource.body).toEqual({ ok: false, reason: '仅壳内页面可上报窗位矩形' })

      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([
        { fn: 'recordRejectedRect', args: [null, undefined] },
        { fn: 'recordRejectedRect', args: [null, undefined] },
      ])
    })

    /**
     * 矩形投毒案二审(2026-08-26 真机实证):带 source:'app' 但 UA 没有壳标记的上报
     * (真实浏览器里带 app 参数打开的工作台页)一律拒绝——URL 参数与 body 字段都是
     * 页面自己说的,唯 UA 是壳的 WKWebView 配置进去的,浏览器页面不会自带。拒绝走
     * 与 source 校验同一条路:200 {ok:false}、recordRejectedRect 留证、绝不进 setSlotRect。
     */
    it('source:"app" 但 UA 无壳标记(浏览器伪装壳)→ 拒绝,不转呼 setSlotRect,记 rejected 留证', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/slot/rect', { rect: RECT, source: 'app' }, 'Mozilla/5.0 (Macintosh) Chrome/151.0')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: '仅壳内页面可上报窗位矩形' })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'recordRejectedRect', args: [RECT, undefined] }])
    })

    it('UA 无壳标记时 {rect:null} 清除路径同样被拒——浏览器标签的一次卸载不能抹掉壳报的真值', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/slot/rect', { rect: null, source: 'app' }, 'Mozilla/5.0 (Macintosh) Chrome/151.0')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: '仅壳内页面可上报窗位矩形' })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'recordRejectedRect', args: [null, undefined] }])
    })

    /**
     * 评审补(2026-08-25):被拒的上报不能让 recent_rects 环失明——单元测起,不依赖假 dock,
     * 直接验证真 dockService 的 recordRejectedRect 只进环、不碰 slotRect(用 setSlotRect
     * 也从没被真正调用过来间接证明,handleMoved 认领判定继续走"矩形未知"分支)。这一条在
     * server-dock.test.ts 里更完整(单测 createDockService),这里只确认 http.ts 接线正确:
     * 被拒请求之后 /state.dock.recent_rects 能看到一条 rejected:true 的记录。
     */
    it('真集成:被拒上报之后 /state.dock.recent_rects 能看到 rejected:true 的记录,slotRect 未被污染', async () => {
      const dockFile = join(await mkdtemp(join(tmpdir(), 'dock-http-')), 'dock.json')
      const appsFile = join(await mkdtemp(join(tmpdir(), 'apps-http-')), 'apps.json')
      const registry = createAppsRegistry({ file: appsFile, runOsascript: async () => ({ ok: false, stdout: '' }) })
      const helper = createHelperChannel()
      const dock = createDockService({
        file: dockFile,
        helper,
        registry,
        runCommand: async () => ({ ok: false, stdout: '' }),
        sleep: () => Promise.resolve(),
      })
      const { url } = await serve({ dock })

      // 缺 source,被拒——但环里该留一条证据,而不是悄无声息地什么都没发生。
      const res = await post(url, '/slot/rect', { rect: RECT })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: '仅壳内页面可上报窗位矩形' })

      const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
      expect(state.dock?.recent_rects).toEqual([
        { ts: expect.any(String), rect: RECT, stored: false, rejected: true },
      ])

      // slotRect 没被真的存进去:带 source:'app' 的正常上报应该被判定为"和上一次(未上报
      // 过,undefined)不同"而真的存,不会因为被拒的那次已经"存过"RECT 而被 rectEquals
      // 误判成"没变"从而跳过 stored:true。
      const okRes = await post(url, '/slot/rect', { rect: RECT, source: 'app' })
      expect(okRes.status).toBe(200)
      const state2 = await (await fetch(`${url}/state`)).json() as WorkbenchState
      const lastEntry = state2.dock?.recent_rects?.at(-1)
      expect(lastEntry).toEqual({ ts: expect.any(String), rect: RECT, stored: true })
    })
  })

  describe('POST /dock/switch', () => {
    it('校验:app 必须是非空字符串,否则 400,不转呼', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      expect((await post(url, '/dock/switch', {})).status).toBe(400)
      expect((await post(url, '/dock/switch', { app: '' })).status).toBe(400)
      expect((await post(url, '/dock/switch', { app: 123 })).status).toBe(400)
      expect(fake.calls).toEqual([])
    })

    it('转呼 dock.switchTo(app) 并原样回结果', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/dock/switch', { app: 'claude' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'switchTo', args: ['claude'] }])
    })

    it('业务失败(dock 回 ok:false)时 HTTP 层仍是 200,原样透传 reason', async () => {
      const fake = fakeDock()
      fake.setSwitchResult({ ok: false, reason: '未认领:先把窗口拖进窗位' })
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/dock/switch', { app: 'claude' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: '未认领:先把窗口拖进窗位' })
    })
  })

  describe('POST /dock/release', () => {
    it('校验:app 必须是非空字符串,否则 400,不转呼', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      expect((await post(url, '/dock/release', {})).status).toBe(400)
      expect(fake.calls).toEqual([])
    })

    it('转呼 dock.release(app) 并原样回结果', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/dock/release', { app: 'claude' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'release', args: ['claude'] }])
    })

    it('业务失败时 HTTP 层仍是 200,原样透传 reason', async () => {
      const fake = fakeDock()
      fake.setReleaseResult({ ok: false, reason: '未认领:先把窗口拖进窗位' })
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/dock/release', { app: 'claude' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: '未认领:先把窗口拖进窗位' })
    })
  })

  describe('POST /dock/hide(W4)', () => {
    it('转发到 dock.hideCurrent(),200 回 { ok: true }', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await fetch(`${url}/dock/hide`, { method: 'POST' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'hideCurrent', args: [] }])
    })

    it('未启用窗位叠 → 404', async () => {
      const { url } = await serve()

      const res = await fetch(`${url}/dock/hide`, { method: 'POST' })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /dock/veil(弹层让开窗位,2026-09-11)', () => {
    it('{on:true} → dock.veil(),200 原样回执行结果', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/dock/veil', { on: true })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'veil', args: [] }])
    })

    it('{on:false} → dock.unveil()', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/dock/veil', { on: false })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([{ fn: 'unveil', args: [] }])
    })

    it('让路失败照样 200 + { ok:false, reason }——那是执行结果,不是接口出错', async () => {
      const fake = fakeDock()
      fake.setVeilResult({ ok: false, reason: 'AX 拒绝' })
      const { url } = await serve({ dock: fake.dock })

      const res = await post(url, '/dock/veil', { on: true })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: 'AX 拒绝' })
    })

    it('on 不是布尔 / body 不是 JSON → 400,不转呼', async () => {
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock })

      expect((await post(url, '/dock/veil', { on: 'yes' })).status).toBe(400)
      expect((await post(url, '/dock/veil', {})).status).toBe(400)
      const res = await fetch(`${url}/dock/veil`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
      expect(res.status).toBe(400)
      expect(fake.calls.filter(c => c.fn !== 'view')).toEqual([])
    })

    it('未启用窗位叠 → 404', async () => {
      const { url } = await serve()
      expect((await post(url, '/dock/veil', { on: true })).status).toBe(404)
    })
  })

  describe('POST /debug/helper(ax_probe 白名单透传,Chromium AX 修复)', () => {
    it('非回环来源 → 403,不转呼', async () => {
      const helper = createHelperChannel()
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock, helper, isLoopback: () => false })

      const res = await post(url, '/debug/helper', { op: 'ax_probe', action: 'get' })
      expect(res.status).toBe(403)
    })

    it('dock 未接线 → 404「窗位叠未启用」(与 /slot/rect 同款"未接线"语义)', async () => {
      const helper = createHelperChannel()
      const { url } = await serve({ helper })

      const res = await post(url, '/debug/helper', { op: 'ax_probe', action: 'get' })
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: '窗位叠未启用' })
    })

    it('body 不是合法 JSON → 400', async () => {
      const helper = createHelperChannel()
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock, helper })

      const res = await fetch(`${url}/debug/helper`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ 这不是合法 JSON',
      })
      expect(res.status).toBe(400)
    })

    it('op 不是 ax_probe → 400(白名单,不是通用 op 注入口)', async () => {
      const helper = createHelperChannel()
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock, helper })

      const res = await post(url, '/debug/helper', { op: 'observe', bundle_ids: [] })
      expect(res.status).toBe(400)
    })

    it('透传成功 → 200 {ok:true, result},其余字段原样并入 helper.request', async () => {
      const helper = createHelperChannel()
      const fake = fakeDock()
      const { url, server } = await serve({ dock: fake.dock, helper, heartbeatMs: 0 })

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
      await new Promise(r => ws.on('open', r))
      const received: unknown[] = []
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string, action?: string, bundle_id?: string, attr?: string }
        if (msg.kind === 'req' && msg.op === 'ax_probe') {
          received.push({ action: msg.action, bundle_id: msg.bundle_id, attr: msg.attr })
          ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { value: true } }))
        }
      })
      ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
      await until(() => helper.view().authorized)

      const res = await post(url, '/debug/helper', { op: 'ax_probe', action: 'get', bundle_id: 'com.example.app', attr: 'AXFocused' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, result: { value: true } })
      expect(received).toEqual([{ action: 'get', bundle_id: 'com.example.app', attr: 'AXFocused' }])
      ws.close()
    })

    it('helper 拒绝(未连)→ 200 {ok:false, reason}(业务失败不是接口错误,先例 /snap)', async () => {
      const helper = createHelperChannel()
      const fake = fakeDock()
      const { url } = await serve({ dock: fake.dock, helper })

      const res = await post(url, '/debug/helper', { op: 'ax_probe', action: 'get' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: '工作台 App 未运行' })
    })

    it('终审必修2:body 里带 id/kind 时,helper.request 收到的对象不含这两个字段(不能覆盖信封)', async () => {
      const helper = createHelperChannel()
      const fake = fakeDock()
      const { url, server } = await serve({ dock: fake.dock, helper, heartbeatMs: 0 })

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
      await new Promise(r => ws.on('open', r))
      const received: Record<string, unknown>[] = []
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg.kind === 'req' && msg.op === 'ax_probe') {
          received.push(msg)
          ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: {} }))
        }
      })
      ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
      await until(() => helper.view().authorized)

      // body 里塞进一个巨大的 id 和一个伪造的 kind——如果 http.ts 把整个 body 铺进
      // req(...raw),helperChannel 的 `{kind:'req', id, ...req}` 会被这两个键覆盖,
      // 发到线上的消息就不再是服务端自己分配的 id/kind 了。
      const res = await post(url, '/debug/helper', { op: 'ax_probe', action: 'get', id: 999999, kind: 'evil' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, result: {} })
      expect(received).toHaveLength(1)
      expect(received[0]?.kind).toBe('req') // 没被 body 里的 'evil' 顶替
      expect(received[0]?.id).not.toBe(999999) // 没被 body 里的 999999 顶替,是服务端自己分配的号
      ws.close()
    })
  })

  it('/state.dock 反映 dock.view()', async () => {
    const fake = fakeDock()
    const view: WorkbenchState['dock'] = { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] }
    fake.setViewResult(view)
    const { url } = await serve({ dock: fake.dock })

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.dock).toEqual(view)
  })

  describe('未接线 dock:/slot/rect /dock/switch /dock/release 均 404「窗位叠未启用」', () => {
    it('三条路由都 404,/state 不带 dock 字段', async () => {
      const { url } = await serve()

      const rect = await post(url, '/slot/rect', { rect: RECT })
      expect(rect.status).toBe(404)
      expect(rect.body).toEqual({ error: '窗位叠未启用' })

      const sw = await post(url, '/dock/switch', { app: 'claude' })
      expect(sw.status).toBe(404)
      expect(sw.body).toEqual({ error: '窗位叠未启用' })

      const rel = await post(url, '/dock/release', { app: 'claude' })
      expect(rel.status).toBe(404)
      expect(rel.body).toEqual({ error: '窗位叠未启用' })

      const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
      expect(state.dock).toBeUndefined()
    })
  })

  /**
   * 这张清单是防漏机制本身:每加一条本机写路由就往这里加一行,漏加的那条就没有人
   * 会发现它没挡住外来请求(终审 I3 抓到的正是 /brief/dismiss 漏在清单外)。
   * 标题不再只说"窗位叠"——清单里现在有快报那条,写窗位叠就是一句跟内容对不上的话。
   */
  describe('非回环来源(isLoopback: () => false):全部本机写路由 403,不转呼', () => {
    it('/slot/rect /dock/switch /dock/release /dock/hide /dock/veil /brief/dismiss /highlight /shell/window-mode /shell/system-awake /shell/away-keep-awake 全部 403', async () => {
      const fake = fakeDock()
      const brief = fakeBrief()
      const { url } = await serve({ dock: fake.dock, brief: brief.brief, isLoopback: () => false })

      expect((await post(url, '/slot/rect', { rect: RECT })).status).toBe(403)
      expect((await post(url, '/dock/switch', { app: 'claude' })).status).toBe(403)
      expect((await post(url, '/dock/release', { app: 'claude' })).status).toBe(403)
      expect((await post(url, '/dock/hide', {})).status).toBe(403)
      expect((await post(url, '/dock/veil', { on: true })).status).toBe(403)
      // 服务真的接了线才发这一条——不然 404 会抢在 403 前面返回,测出来的就不是"挡住了"。
      expect((await post(url, '/brief/dismiss', {})).status).toBe(403)
      // 光圈(2026-09-10):不接线也照样先判回环——403 在 404 之前(与上面那条相反,
      // 是因为这条路由的顺序就是先 isLoopback 再判 highlight 有没有接线,不必为它假接一个)。
      expect((await post(url, '/highlight', { region: 'slot' })).status).toBe(403)
      // 壳窗口前台/桌面两档(2026-09-18):同 /highlight,这条路由也是先判回环再判接没接线,
      // 所以不接 helper 也测得出 403(它动的是本机屏幕上那扇窗的层级,更没道理让外面的人碰)。
      expect((await post(url, '/shell/window-mode', { mode: 'front', source: 'app' })).status).toBe(403)
      // 「工作台开着时电脑不睡」那颗开关(2026-09-28,卡 AW):同上,先判回环 ——
      // 这台电脑睡不睡由坐在它前面的人决定,不由外面一条请求决定。
      expect((await post(url, '/shell/system-awake', { enabled: false })).status).toBe(403)
      // 「出门时电脑不睡」那颗开关(2026-10-03,卡「出门时电脑不睡」):同上,先判回环 ——
      // 她家里那块屏亮不亮,不由外面一条请求决定(GET 也挡:连「这台接没接这颗开关」都不该问出来)。
      expect((await post(url, '/shell/away-keep-awake', { enabled: true })).status).toBe(403)
      expect((await fetch(`${url}/shell/away-keep-awake`)).status).toBe(403)
      expect(fake.calls).toEqual([])
      expect(brief.calls.filter(c => c !== 'view')).toEqual([])
    })
  })

  /**
   * 终审 I3:W4 的第二条写路由,原本 403/404/200 三条测试全缺(Task 1 给 /dock/hide
   * 补过同样的三条,这条新路由在同一个分支里被漏掉了)。403 那条在上面的共享清单里。
   */
  describe('POST /brief/dismiss(W4)', () => {
    it('成功:转呼 brief.dismiss(),200 {ok:true}', async () => {
      const brief = fakeBrief()
      const { url } = await serve({ brief: brief.brief })

      const res = await post(url, '/brief/dismiss', {})
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(brief.calls.filter(c => c !== 'view')).toEqual(['dismiss'])
    })

    it('未接线 brief → 404「快报未启用」', async () => {
      const { url } = await serve()

      const res = await post(url, '/brief/dismiss', {})
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: '快报未启用' })
    })
  })

  describe('/apps/add·/apps/remove 成功后重发 observe(onAppsChanged)', () => {
    it('业务成功才调用 onAppsChanged;业务失败不调用', async () => {
      const fake = fakeDock()
      let changed = 0
      const registry = createAppsRegistry({
        file: join(await mkdtemp(join(tmpdir(), 'apps-observe-')), 'apps.json'),
        runOsascript: async (cmd) => (
          cmd.includes('id of app "Notion"') ? { ok: true, stdout: 'notion.id\n' } : { ok: false, stdout: '' }
        ),
      })
      const { url } = await serve({ dock: fake.dock, registry, onAppsChanged: () => { changed++ } })

      // 找不到应用:业务失败(ok:false),清单没变,不该重发。
      const failAdd = await post(url, '/apps/add', { name: '不存在的App' })
      expect(failAdd.body).toEqual({ ok: false, reason: '找不到应用:不存在的App' })
      expect(changed).toBe(0)

      // 真加成了:业务成功,该重发一次。
      const okAdd = await post(url, '/apps/add', { name: 'Notion' })
      expect(okAdd.body).toMatchObject({ ok: true })
      expect(changed).toBe(1)

      // 不存在的键:业务失败,不该重发。A5 起基础应用改为可删(退出清单,不再拒绝),
      // 这里换一个真的业务失败场景来验证"失败不重发"这条纪律。
      const failRemove = await post(url, '/apps/remove', { key: 'c-nope' })
      expect(failRemove.body).toEqual({ ok: false, reason: '没有这个应用' })
      expect(changed).toBe(1)

      // A5:基础应用现在可删——业务成功,该重发一次。
      const okBaseRemove = await post(url, '/apps/remove', { key: 'claude' })
      expect(okBaseRemove.body).toEqual({ ok: true })
      expect(changed).toBe(2)

      const key = (okAdd.body as { key: string }).key
      const okRemove = await post(url, '/apps/remove', { key })
      expect(okRemove.body).toEqual({ ok: true })
      expect(changed).toBe(3)
    })
  })

  describe('真集成:WS 假壳 → /slot/rect → moved 落定 → /state.dock 反映认领 → dock.json 落盘', () => {
    it('拖进窗位落定后,认领在 /state.dock 与 dock.json 上都能看到', async () => {
      const dockFile = join(await mkdtemp(join(tmpdir(), 'dock-http-')), 'dock.json')
      const appsFile = join(await mkdtemp(join(tmpdir(), 'apps-http-')), 'apps.json')
      const registry = createAppsRegistry({ file: appsFile, runOsascript: async () => ({ ok: false, stdout: '' }) })
      const helper = createHelperChannel()
      const dock = createDockService({
        file: dockFile,
        helper,
        registry,
        // isRunning 探测用,用不上真进程——恒回"没在跑"即可,不影响认领判定。
        runCommand: async () => ({ ok: false, stdout: '' }),
        sleep: () => Promise.resolve(),
      })
      // 事件源接线是 index.ts 的职责(http.ts 对 dock 内部一无所知),这里手动复刻同一条线,
      // 好让 WS 假壳发出的 moved 事件真的驱动到 dockService。悬停高亮 v1 起 HelperEvent
      // 是 moved|hover 的并集,这里只认 moved,同 index.ts 的接线纪律。
      helper.onEvent((event) => {
        if (event.kind !== 'moved') return
        void dock.handleMoved(event.bundle_id, event.frame)
      })

      const { url, server } = await serve({ helper, dock, registry, heartbeatMs: 0 })

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
      await new Promise(r => ws.on('open', r))
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string }
        if (msg.kind !== 'req') return
        // screen_info:webview 在原点、scale=1,页面矩形与屏幕矩形直接相等,方便断言。
        if (msg.op === 'screen_info') {
          ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { webview: { x: 0, y: 0, w: 2000, h: 1200 }, scale: 1 } }))
          return
        }
        // app_info/set_window_frame/raise_window 一律回空对象成功——这条集成只关心认领链路,
        // 不测 orchestrator 的回读校验。
        ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: {} }))
      })
      ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
      await until(() => helper.view().authorized)

      const slotRect: HelperRect = { x: 100, y: 100, w: 400, h: 300 }
      const rectRes = await post(url, '/slot/rect', { rect: slotRect, source: 'app' })
      expect(rectRes.status).toBe(200)

      // 中心点 (200,200),落在槽位屏幕矩形 [100,500]x[100,400] 内——先例见 tests/server-dock.test.ts。
      const insideFrame: HelperRect = { x: 150, y: 150, w: 100, h: 100 }
      ws.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.anthropic.claudefordesktop', frame: insideFrame }))

      // handleMoved 是异步的(要等壳回 res 才落盘),轮询 /state.dock 等它跑完,禁固定 sleep。
      const state = await untilAsync(
        async () => (await fetch(`${url}/state`)).json() as Promise<WorkbenchState>,
        s => (s.dock?.stack.length ?? 0) > 0,
      )

      expect(state.dock?.stack).toEqual([{ key: 'claude', label: 'Claude', running: false, current: true }])

      const onDisk = JSON.parse(await readFile(dockFile, 'utf8')) as { stack: { app: string, bundle_id: string }[], current: string | null }
      expect(onDisk.stack).toEqual([{ app: 'claude', bundle_id: 'com.anthropic.claudefordesktop', original: insideFrame }])
      expect(onDisk.current).toBe('claude')

      ws.close()
    })
  })

  describe('helper.onChange(connect+authorized) → 下发 observe(index.ts 接线复刻,回归 fix-round-1)', () => {
    /**
     * http.ts 对 dockService 内部一无所知——observe 下发是 index.ts 的职责(见 brief 要求4),
     * 这里手动复刻 index.ts 里那段闭包的原样写法,钉住"连上且授权就下发全量 observe"这条线,
     * 不是只测 dockService.observeTargets() 本身(server-dock.test.ts 已经测过那个单元)。
     */
    function wireObserve(helper: ReturnType<typeof createHelperChannel>, dock: DockService): void {
      helper.onChange(() => {
        if (helper.view().authorized) {
          void dock.observeTargets()
            .then(ids => helper.request({ op: 'observe', bundle_ids: ids }))
            .then((res) => {
              const failed = res.failed
              // S3(review,真机截图实证):不管这一轮 failed 是不是空,都要调
              // noteObserveFailures——之前只在非空时才调,意味着"这轮全部挂载成功"
              // 永远走不到 noteObserveFailures 里"传空清单就顺手清掉陈旧 note"那条分支,
              // 陈旧 note 因此只能靠重启工作台服务才会消失。noteObserveFailures 自己已经
              // 处理好空清单这个入参,这里不用重复判断。
              const bundleIds = Array.isArray(failed) ? failed.filter((id): id is string => typeof id === 'string') : []
              // 微轮修复:noteObserveFailures 的 Promise 必须就地挂 .catch——`void` 直接丢弃
              // 会让它跟外层这条 .then/.catch 链断开联系,它自己一旦拒绝(比如落盘时磁盘
              // 写满)就是又一个未处理拒绝,外层的 .catch 接不住已经跟它断链的 Promise。
              dock.noteObserveFailures(bundleIds).catch(() => {})
            })
            .catch(() => {})
        }
      })
    }

    it('壳 hello(authorized:true) 后收到 op:observe,bundle_ids 是全量 registry 目标(基础七应用);壳回 ok 时 request 正常 resolve', async () => {
      const appsFile = join(await mkdtemp(join(tmpdir(), 'apps-observe-wire-')), 'apps.json')
      const dockFile = join(await mkdtemp(join(tmpdir(), 'dock-observe-wire-')), 'dock.json')
      // 全新落盘、没加过任何自定义应用——registry.list() 只有 APP_BUNDLES 的基础七个键。
      const registry = createAppsRegistry({ file: appsFile, runOsascript: async () => ({ ok: false, stdout: '' }) })
      const helper = createHelperChannel()
      const dock = createDockService({
        file: dockFile, helper, registry,
        runCommand: async () => ({ ok: false, stdout: '' }),
        sleep: () => Promise.resolve(),
      })
      wireObserve(helper, dock)

      const { server } = await serve({ helper, dock, registry, heartbeatMs: 0 })

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
      await new Promise(r => ws.on('open', r))
      // 只记 bundle_ids 本体(而不是整条消息):msg.bundle_ids 在 observe 分支里必然存在,
      // 存成 { bundle_ids?: string[] } 反而在 exactOptionalPropertyTypes 下徒增一层 undefined 噪音。
      const observedBundleIds: string[][] = []
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string, bundle_ids?: string[] }
        if (msg.kind === 'req' && msg.op === 'observe' && msg.bundle_ids !== undefined) {
          observedBundleIds.push(msg.bundle_ids)
          ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: {} }))
        }
      })
      ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))

      await until(() => observedBundleIds.length > 0)

      const expected = await dock.observeTargets()
      // 卡 HC(2026-09-27):基础键从 APP_COMMANDS 现长(AI 那几家来自知识表),这里读常量、不写死个数。
      expect(expected).toHaveLength(BASE_KEYS.length)
      expect(observedBundleIds[0]?.slice().sort()).toEqual(expected.slice().sort())

      ws.close()
    })

    it('壳对 observe 回 ok:false:被 .catch(()=>{}) 吞掉,不炸测试进程、连接照常可用', async () => {
      const appsFile = join(await mkdtemp(join(tmpdir(), 'apps-observe-fail-')), 'apps.json')
      const dockFile = join(await mkdtemp(join(tmpdir(), 'dock-observe-fail-')), 'dock.json')
      const registry = createAppsRegistry({ file: appsFile, runOsascript: async () => ({ ok: false, stdout: '' }) })
      const helper = createHelperChannel()
      const dock = createDockService({
        file: dockFile, helper, registry,
        runCommand: async () => ({ ok: false, stdout: '' }),
        sleep: () => Promise.resolve(),
      })
      wireObserve(helper, dock)

      const { server } = await serve({ helper, dock, registry, heartbeatMs: 0 })

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
      await new Promise(r => ws.on('open', r))
      let observeSeen = false
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string }
        if (msg.kind === 'req' && msg.op === 'observe') {
          observeSeen = true
          // 故意回失败——闭包里的 .catch(() => {}) 得吞得住,不能把这条拒绝变成未捕获异常。
          ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: false, error: '假装壳这次订阅失败了' }))
        }
      })
      ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))

      await until(() => observeSeen)
      // 给 .then().catch() 链一点时间跑完;这条 await 本身如果抛出(比如未捕获拒绝冒泡),
      // 测试就会失败——这正是本例要钉住的"吞得住、不炸"。
      await new Promise(r => setTimeout(r, 50))

      // 连接没被这次失败拖垮:通道仍然是"已连接且已授权"。
      expect(helper.view()).toEqual({ connected: true, authorized: true })

      ws.close()
    })

    it('I4:壳回 result.failed 非空 → dock.noteObserveFailures 写 note,/state.dock.note 可见', async () => {
      const appsFile = join(await mkdtemp(join(tmpdir(), 'apps-observe-failed-')), 'apps.json')
      const dockFile = join(await mkdtemp(join(tmpdir(), 'dock-observe-failed-')), 'dock.json')
      const registry = createAppsRegistry({ file: appsFile, runOsascript: async () => ({ ok: false, stdout: '' }) })
      const helper = createHelperChannel()
      const dock = createDockService({
        file: dockFile, helper, registry,
        runCommand: async () => ({ ok: false, stdout: '' }),
        sleep: () => Promise.resolve(),
      })
      wireObserve(helper, dock)

      const { url, server } = await serve({ helper, dock, registry, heartbeatMs: 0 })

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
      await new Promise(r => ws.on('open', r))
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string }
        if (msg.kind === 'req' && msg.op === 'observe') {
          // 壳挂载失败一个基础应用(claude),回执带上挂载失败清单。
          ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { failed: ['com.anthropic.claudefordesktop'] } }))
        }
      })
      ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))

      const state = await untilAsync(
        async () => (await fetch(`${url}/state`)).json() as Promise<WorkbenchState>,
        s => s.dock?.note !== undefined,
      )
      expect(state.dock?.note).toBe('以下应用不支持拖拽认领:Claude')

      ws.close()
    })

    it('S3(review,真机截图实证):壳 hello 后先回一次带 failed 的 observe(写 note),重连再回一次 failed:[] → note 被清掉', async () => {
      const appsFile = join(await mkdtemp(join(tmpdir(), 'apps-observe-clear-')), 'apps.json')
      const dockFile = join(await mkdtemp(join(tmpdir(), 'dock-observe-clear-')), 'dock.json')
      const registry = createAppsRegistry({ file: appsFile, runOsascript: async () => ({ ok: false, stdout: '' }) })
      const helper = createHelperChannel()
      const dock = createDockService({
        file: dockFile, helper, registry,
        runCommand: async () => ({ ok: false, stdout: '' }),
        sleep: () => Promise.resolve(),
      })
      wireObserve(helper, dock)

      const { url, server } = await serve({ helper, dock, registry, heartbeatMs: 0 })

      // 第一条连接:壳报挂载失败,note 被写上。
      const ws1 = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
      await new Promise(r => ws1.on('open', r))
      ws1.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string }
        if (msg.kind === 'req' && msg.op === 'observe') {
          ws1.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { failed: ['com.anthropic.claudefordesktop'] } }))
        }
      })
      ws1.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))

      await untilAsync(
        async () => (await fetch(`${url}/state`)).json() as Promise<WorkbenchState>,
        s => s.dock?.note !== undefined,
      )
      ws1.close()

      // 第二条连接(模拟壳重连/授权状态变化触发新一轮 observe):这次全部挂载成功,
      // 回执里 failed 是空数组——之前的 bug 是这种情况根本走不到 noteObserveFailures,
      // 陈旧 note 永远留着;修复后应该被清掉。
      const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
      await new Promise(r => ws2.on('open', r))
      ws2.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string }
        if (msg.kind === 'req' && msg.op === 'observe') {
          ws2.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { failed: [] } }))
        }
      })
      ws2.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))

      const cleared = await untilAsync(
        async () => (await fetch(`${url}/state`)).json() as Promise<WorkbenchState>,
        s => s.dock?.note === undefined,
      )
      expect(cleared.dock?.note).toBeUndefined()

      ws2.close()
    })

    it('微轮修复:noteObserveFailures 本身 reject(注入,模拟磁盘写满等)不产生未处理拒绝,连接照常可用', async () => {
      const appsFile = join(await mkdtemp(join(tmpdir(), 'apps-observe-failed-reject-')), 'apps.json')
      const dockFile = join(await mkdtemp(join(tmpdir(), 'dock-observe-failed-reject-')), 'dock.json')
      const registry = createAppsRegistry({ file: appsFile, runOsascript: async () => ({ ok: false, stdout: '' }) })
      const helper = createHelperChannel()
      const realDock = createDockService({
        file: dockFile, helper, registry,
        runCommand: async () => ({ ok: false, stdout: '' }),
        sleep: () => Promise.resolve(),
      })
      // 注入一个会 reject 的 noteObserveFailures——模拟真实写盘失败(磁盘写满等),
      // 不依赖把 dockFile 所在目录改成不可写(权限操作在沙箱/CI 里不总是可控)。
      let noteAttempts = 0
      const dock: DockService = {
        ...realDock,
        noteObserveFailures: async () => {
          noteAttempts++
          throw new Error('磁盘写满(注入)')
        },
      }
      wireObserve(helper, dock)

      const { server } = await serve({ helper, dock, registry, heartbeatMs: 0 })

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
      await new Promise(r => ws.on('open', r))
      let observeSeen = false
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string }
        if (msg.kind === 'req' && msg.op === 'observe') {
          observeSeen = true
          ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { failed: ['com.anthropic.claudefordesktop'] } }))
        }
      })
      ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))

      await until(() => observeSeen)
      // 给 noteObserveFailures 的拒绝一点时间冒出来;这条 await 本身如果抛出(未处理拒绝
      // 冒泡到测试进程),测试就会失败——这正是本例要钉住的"就地 .catch 接住,不炸"。
      await new Promise(r => setTimeout(r, 50))

      expect(noteAttempts).toBe(1)
      // 连接没被这次注入的拒绝拖垮:通道仍然是"已连接且已授权",流程照常继续。
      expect(helper.view()).toEqual({ connected: true, authorized: true })

      ws.close()
    })
  })

  describe('悬停高亮 v1:壳发 hover → http.ts 转广播给 /live(helper.onEvent 支持多监听器)', () => {
    it('壳推 {kind:hover,inside} → 所有 /live 订阅者原样收到 {kind:hover,inside}', async () => {
      const helper = createHelperChannel()
      const { url, server } = await serve({ helper, heartbeatMs: 0 })

      // /live 订阅者——先例见 tests/server-http.test.ts 的 live() 助手,这里就地精简一份。
      const liveWs = new WebSocket(`${url.replace('http://', 'ws://')}/live`)
      const liveMessages: LiveMessage[] = []
      liveWs.on('message', raw => liveMessages.push(JSON.parse(String(raw)) as LiveMessage))
      await new Promise(resolve => liveWs.once('open', resolve))
      await until(() => liveMessages.some(m => m.kind === 'snapshot')) // 先吃掉连上就推的那份首帧快照

      const helperWs = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
      await new Promise(resolve => helperWs.on('open', resolve))
      helperWs.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
      await until(() => helper.view().authorized)

      helperWs.send(JSON.stringify({ kind: 'hover', inside: true }))
      await until(() => liveMessages.some(m => m.kind === 'hover'))

      const hoverMessages = liveMessages.filter(m => m.kind === 'hover')
      expect(hoverMessages).toEqual([{ kind: 'hover', inside: true }])

      helperWs.close()
      liveWs.close()
    })

    it('moved 事件不会被误广播成 hover(type-narrow 两条监听器互不干扰)', async () => {
      const helper = createHelperChannel()
      const { url, server } = await serve({ helper, heartbeatMs: 0 })

      const liveWs = new WebSocket(`${url.replace('http://', 'ws://')}/live`)
      const liveMessages: LiveMessage[] = []
      liveWs.on('message', raw => liveMessages.push(JSON.parse(String(raw)) as LiveMessage))
      await new Promise(resolve => liveWs.once('open', resolve))
      await until(() => liveMessages.some(m => m.kind === 'snapshot'))

      const helperWs = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
      await new Promise(resolve => helperWs.on('open', resolve))
      helperWs.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
      await until(() => helper.view().authorized)

      helperWs.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.example.app', frame: { x: 0, y: 0, w: 1, h: 1 } }))
      // moved 不该产生任何 hover 广播;给它一点时间证明真的没有,而不是刚好还没到。
      await new Promise(resolve => setTimeout(resolve, 80))

      expect(liveMessages.some(m => m.kind === 'hover')).toBe(false)

      helperWs.close()
      liveWs.close()
    })
  })
})

describe('POST /dock/reorder(2026-09-02 标签拖拽排序)', () => {
  it('把顺序透传给 dock.reorder,并广播新快照', async () => {
    const fake = fakeDock()
    const { url } = await serve({ dock: fake.dock })
    const res = await post(url, '/dock/reorder', { keys: ['codex', 'claude'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(fake.calls.filter(c => c.fn === 'reorder')).toEqual([{ fn: 'reorder', args: [['codex', 'claude']] }])
  })

  it('keys 不是字符串数组 → 400,一次都不转呼', async () => {
    const fake = fakeDock()
    const { url } = await serve({ dock: fake.dock })
    expect((await post(url, '/dock/reorder', { keys: 'codex' })).status).toBe(400)
    expect((await post(url, '/dock/reorder', { keys: [1, 2] })).status).toBe(400)
    expect(fake.calls.filter(c => c.fn === 'reorder')).toEqual([])
  })
})

describe('POST /activate 与窗位叠的接线(2026-09-09 Dock/⌘Tab 点回已认领应用丢标签修复)', () => {
  it('dock 已接线 → 先 dock.noteActivated(app) 再发 open(抑制标记必须先于应用自摆窗口的 moved 事件存在)', async () => {
    const fake = fakeDock()
    const order: string[] = []
    const runCommand = async (cmd: readonly string[]) => { order.push(`run:${cmd.join(' ')}`); return { ok: true, stdout: '' } }
    const { url } = await serve({ dock: fake.dock, runCommand })
    const originalNote = fake.dock.noteActivated
    fake.dock.noteActivated = async (app: string) => { order.push(`note:${app}`); await originalNote(app) }

    const res = await post(url, '/activate', { app: 'claude' })

    expect(res.status).toBe(200)
    expect(order).toEqual(['note:claude', `run:${(APP_COMMANDS.claude ?? []).join(' ')}`])
  })

  it('dock 未接线 → /activate 照旧只发 open,不因缺窗位叠而失败', async () => {
    const calls: (readonly string[])[] = []
    const runCommand = async (cmd: readonly string[]) => { calls.push(cmd); return { ok: true, stdout: '' } }
    const { url } = await serve({ runCommand })

    const res = await post(url, '/activate', { app: 'claude' })

    expect(res.status).toBe(200)
    expect(calls).toEqual([APP_COMMANDS.claude])
  })

  it('未知 app → 404,且不调 dock.noteActivated(激活根本没发生)', async () => {
    const fake = fakeDock()
    const runCommand = async () => ({ ok: true, stdout: '' })
    const { url } = await serve({ dock: fake.dock, runCommand })

    const res = await post(url, '/activate', { app: '不存在的app' })

    expect(res.status).toBe(404)
    expect(fake.calls.filter(c => c.fn === 'noteActivated')).toEqual([])
  })
})
