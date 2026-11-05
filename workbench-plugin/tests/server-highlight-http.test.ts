// @vitest-environment node
/**
 * 事务官动了哪一块 → `/live` 上一条「一行字」(2026-09-25 卡 P 补三),不再让壳画光圈。
 *
 * 维护者 0.3.1 截图:「事务官正在挪任务卡的状态」连同一圈光框挂在工作台左上角,任务卡却在右边的看板里
 * (服务端按布局参数重算「看板在哪」再让壳画,算漂了)。统筹定:程序做的动作一律只出一行字,页面挂在真实的
 * 元素上画;服务端只广播「哪个动作、哪张卡、一句话」。这里钉路由那一半:
 * - 写动作(窗口槽 / 看板)前后广播 `actor_note`,看板的带卡号;他自己在页面上点的不广播;
 * - 「拖进来松手」那一下的光服务(highlight)**一次都不被叫去画**这些;
 * - `POST /highlight`(事务官手动指一下)也只是一行字;`region:null` 收掉;非回环 403;不依赖壳(不再 404)。
 * 真壳那条(假壳收到 0 次光效请求、亲手拖入 1 次)在 tests/server-slot-glow-http.test.ts。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { HelperRect, WorkbenchState } from '../src/protocol.ts'
import type { DockService } from '../src/server/dock.ts'
import type { ScenesService } from '../src/server/scenes.ts'
import type { HighlightService } from '../src/server/highlight.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const started: WorkbenchServer[] = []
const sockets: WebSocket[] = []
const dirs: string[] = []
afterEach(async () => {
  while (sockets.length) sockets.pop()?.close()
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 真任务看板(落在临时目录):建卡 / 改卡 / 挪状态那三条要真的能改到东西。 */
function realTasks() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-actor-note-'))
  dirs.push(dir)
  let n = 0
  return createTasksService({
    file: join(dir, 'tasks.json'),
    now: () => Math.floor(Date.parse('2026-09-25T09:00:00Z') / 1000),
    newId: () => `t-${++n}`,
  })
}

const SHELL_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 BenWorkbenchShell/1'
/** 事务官的工具调用:没有 Origin、也不是壳里的页面。 */
const BUTLER_UA = 'curl/8.7.1'
const RECT: HelperRect = { x: 10, y: 20, w: 300, h: 400 }

/** 假「拖进来松手」光服务:只记调用。 */
function fakeHighlight() {
  const calls: { fn: string, args: readonly unknown[] }[] = []
  const highlight: HighlightService = {
    setSlotRect(rect: HelperRect | undefined) { calls.push({ fn: 'setSlotRect', args: [rect] }) },
    async drop() { calls.push({ fn: 'drop', args: [] }); return true },
    async idle() {},
  }
  return { highlight, calls }
}

function fakeDock() {
  const dock: DockService = {
    setSlotRect() {},
    recordRejectedRect() {},
    async pushHoverZone() {},
    async pushSlotApps() {},
    async handleMoved() {},
    async handleAxStale() {},
    async switchTo() { return { ok: true } },
    async release() { return { ok: true } },
    async reorder() { return { ok: true } },
    async hideCurrent() { return { ok: true } },
    async veil() { return { ok: true } },
    async unveil() { return { ok: true } },
    async view() { return { stack: [] } as WorkbenchState['dock'] },
    async observeTargets() { return [] },
    async noteObserveFailures() {},
    async noteActivated() {},
  }
  return dock
}

function fakeScenes() {
  const scenes: ScenesService = {
    async list() { return [] },
    async save() { return { ok: true } },
    async create() { return { ok: true, id: 's-1' } },
    async rename() { return true },
    async remove() { return true },
    async restore() { return { ok: true, apps: [] } },
  }
  return scenes
}

async function post(url: string, path: string, body: unknown, userAgent = BUTLER_UA) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function serve(extra: Partial<Parameters<typeof startWorkbenchServer>[0]> = {}) {
  const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, ...extra })
  started.push(server)
  // 页面那条 /live:记下「一行字」那两种消息。
  const notes: Record<string, unknown>[] = []
  const live = new WebSocket(`ws://127.0.0.1:${server.port}/live`)
  sockets.push(live)
  await new Promise(resolve => live.on('open', resolve))
  live.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Record<string, unknown>
    if (msg.kind === 'actor_note' || msg.kind === 'actor_note_clear') notes.push(msg)
  })
  const settle = () => new Promise(resolve => setTimeout(resolve, 60))
  const noteOf = (msg: Record<string, unknown>) => msg.note as Record<string, unknown>
  return { url: server.url, notes, settle, noteOf }
}

describe('写动作前后广播一行字(不让壳画任何东西)', () => {
  it('★看板:建事项挂任务那一块(没卡号),改卡 / 挪状态挂那张卡(带卡号)', async () => {
    const fake = fakeHighlight()
    const t = await serve({ highlight: fake.highlight, tasks: realTasks() })
    expect((await post(t.url, '/task/create', { title: '通知测试' })).body).toEqual({ ok: true, id: 't-1' })
    await post(t.url, '/task/update', { id: 't-1', title: '通知测试(改)' })
    await post(t.url, '/task/move', { id: 't-1', status: 'doing' })
    await t.settle()
    const seen = t.notes.map(t.noteOf).map(n => [n.action, n.region, n.task_id, n.text])
    expect(seen).toContainEqual(['task.create', 'board', undefined, '事务官正在建事项'])
    expect(seen).toContainEqual(['task.update', 'board', 't-1', '事务官正在改任务卡'])
    expect(seen).toContainEqual(['task.move', 'board', 't-1', '事务官正在挪任务卡的状态'])
    expect(fake.calls.filter(c => c.fn === 'drop')).toEqual([])
  })

  it('窗口槽(切窗、放开、恢复场景)挂窗口槽', async () => {
    const fake = fakeHighlight()
    const t = await serve({ highlight: fake.highlight, dock: fakeDock(), scenes: fakeScenes() })
    await post(t.url, '/dock/switch', { app: 'claude' })
    await post(t.url, '/dock/release', { app: 'claude' })
    await post(t.url, '/scene/restore', { id: 's-1' })
    await t.settle()
    const actions = [...new Set(t.notes.map(t.noteOf).map(n => `${String(n.action)}→${String(n.region)}`))]
    expect(actions).toEqual(['dock.switch→slot', 'dock.release→slot', 'scene.restore→slot'])
    expect(fake.calls.filter(c => c.fn === 'drop')).toEqual([])
  })

  it('他自己在页面上点的(壳内页面 / 浏览器):一条都不广播', async () => {
    const t = await serve({ dock: fakeDock(), tasks: realTasks() })
    await post(t.url, '/dock/switch', { app: 'claude' }, SHELL_UA)
    await post(t.url, '/task/create', { title: '他自己建的' }, SHELL_UA)
    await t.settle()
    expect(t.notes).toEqual([])
  })

  it('没接「拖进来松手」那一下的光服务时,写动作照跑、字照出(出字不依赖壳)', async () => {
    const t = await serve({ dock: fakeDock() })
    const res = await post(t.url, '/dock/switch', { app: 'claude' })
    expect(res.status).toBe(200)
    await t.settle()
    expect(t.notes.length).toBeGreaterThan(0)
  })
})

describe('POST /highlight:事务官手动指一下,也只是一行字', () => {
  it('非回环来源 → 403,不广播', async () => {
    const t = await serve({ isLoopback: () => false })
    expect((await post(t.url, '/highlight', { region: 'board' })).status).toBe(403)
    await t.settle()
    expect(t.notes).toEqual([])
  })

  it('region 合法 → 广播一行字(截到 40 字);不依赖壳,没接光服务也不 404', async () => {
    const t = await serve()
    const res = await post(t.url, '/highlight', { region: 'files', label: '合'.repeat(50) })
    expect(res).toEqual({ status: 200, body: { ok: true } })
    await t.settle()
    const note = t.noteOf(t.notes[0]!)
    expect(note).toMatchObject({ action: 'point', region: 'files' })
    expect(String(note.text)).toHaveLength(40)
  })

  it('region:null → 收掉页面上挂着的字', async () => {
    const t = await serve()
    expect((await post(t.url, '/highlight', { region: null })).status).toBe(200)
    await t.settle()
    expect(t.notes).toEqual([{ kind: 'actor_note_clear' }])
  })

  it('认不出的 region → 400,不广播(不按名字猜一块)', async () => {
    const t = await serve()
    expect((await post(t.url, '/highlight', { region: '任务板' })).status).toBe(400)
    await t.settle()
    expect(t.notes).toEqual([])
  })
})

describe('矩形:只剩窗口槽槽体那一块(给「拖进来松手」那一下)', () => {
  it('/slot/rect 上报 → setSlotRect;rect:null → 清掉', async () => {
    const fake = fakeHighlight()
    const t = await serve({ highlight: fake.highlight, dock: fakeDock() })
    await post(t.url, '/slot/rect', { rect: RECT, source: 'app' }, SHELL_UA)
    await post(t.url, '/slot/rect', { rect: null, source: 'app' }, SHELL_UA)
    expect(fake.calls.filter(c => c.fn === 'setSlotRect').map(c => c.args)).toEqual([[RECT], [undefined]])
  })

  it('不是壳内页面报的矩形 → 连光服务也不喂(与 /slot/rect 同一道门)', async () => {
    const fake = fakeHighlight()
    const t = await serve({ highlight: fake.highlight, dock: fakeDock() })
    await post(t.url, '/slot/rect', { rect: RECT, source: 'app' }, 'Mozilla/5.0 Chrome/140')
    expect(fake.calls).toEqual([])
  })
})
