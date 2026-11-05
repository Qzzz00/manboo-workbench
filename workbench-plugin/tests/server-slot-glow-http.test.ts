// @vitest-environment node
/**
 * 窗口槽那圈流线光只绑「真拖进一个新应用、放手」这一个动作(2026-09-25,卡 P)。
 *
 * 维护者原话:「窗口槽的流线光效时不时自己闪一下,其实没拖新应用进去」。
 * 根因:光绑在「悬停进圈」这个状态上,而壳对程序化挪窗(点标签切换时我们把窗摆进槽、应用自己缩放、
 * 截图把藏着的应用放出来)也报进圈;服务端一收到进圈就亮原生光圈、页面也亮自己那圈。
 *
 * 真集成:真 dockService + 真 highlightService + 真 http(/live 广播)+ WS 假壳。
 * ① 回放一串**不是拖拽**的更新(点标签切换、同一个矩形再报一次(刷新)、壳重连、同一个应用重复上报、
 *    截图把藏着的应用放出来、悬停进出圈)→ 原生光圈 0 次、页面「放下」广播 0 次;
 * ② 回放一次真拖入(左键按着把一个新应用拖进槽、落定)→ 原生光圈 1 次、页面「放下」广播 1 次。
 * ③(2026-09-25 卡 P 补三)事务官(程序来的请求)切窗、放开窗位、建事项、挪状态 → **壳收到 0 次**
 *    光效请求(连那行字都不让壳画),页面 /live 收到对应的一行字(挂在哪由页面对着真实的元素定)。
 *    维护者 0.3.1:「事务官正在挪任务卡的状态」连同一圈光框挂错了地方;统筹:「流线光效只属于他亲手把新应用拖进
 *    窗口槽、松手那一下」。
 */
import { mkdtempSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { HelperRect } from '../src/protocol.ts'
import { createAppsRegistry } from '../src/server/appsRegistry.ts'
import { createDockService } from '../src/server/dock.ts'
import { createHelperChannel } from '../src/server/helperChannel.ts'
import { createHighlightService } from '../src/server/highlight.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const started: WorkbenchServer[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  while (sockets.length) sockets.pop()?.close()
  while (started.length) await started.pop()?.close()
})

const SHELL_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 BenWorkbenchShell/1'
const CLAUDE = 'com.anthropic.claudefordesktop'
const CODEX = 'com.openai.codex'
const INSIDE: HelperRect = { x: 150, y: 150, w: 100, h: 100 }

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 10))
  }
}
const settle = () => new Promise(r => setTimeout(r, 120))

async function setup(caps: readonly string[] = ['activation', 'highlight_label', 'rehide']) {
  const dockFile = join(await mkdtemp(join(tmpdir(), 'slot-glow-')), 'dock.json')
  const appsFile = join(await mkdtemp(join(tmpdir(), 'slot-glow-apps-')), 'apps.json')
  const registry = createAppsRegistry({ file: appsFile, runOsascript: async () => ({ ok: false, stdout: '' }) })
  const helper = createHelperChannel()
  const highlight = createHighlightService({ helper })
  const dock = createDockService({
    file: dockFile, helper, registry,
    runCommand: async (cmd: readonly string[]) => ({ ok: true, stdout: cmd[0] === 'lsappinfo' ? '"pid"=1\n' : '' }),
    sleep: () => Promise.resolve(),
    followActivation: true,
  })
  // index.ts 那几条接线原样复刻:moved → dock.handleMoved,activation → dock.handleActivation。
  helper.onEvent((event) => {
    if (event.kind === 'moved') void dock.handleMoved(event.bundle_id, event.frame, event.dragged, event.pressed)
    if (event.kind === 'activation') { const { kind: _k, ...info } = event; void dock.handleActivation?.(info) }
  })
  const service = createWorkbenchService()
  // 看板(真的,落临时目录):事务官建事项、挪状态那几条要真能走通。
  let n = 0
  const tasks = createTasksService({ file: join(mkdtempSync(join(tmpdir(), 'slot-glow-tasks-')), 'tasks.json'), newId: () => `t-${++n}` })
  const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0, heartbeatMs: 0, helper, dock, registry, highlight, tasks })
  started.push(server)

  // 假壳:记下它收到的每一次打光(不管带不带光、带不带字)。
  const lit: unknown[] = []
  const shell = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
  sockets.push(shell)
  await new Promise(r => shell.on('open', r))
  shell.on('message', (data) => {
    const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string, rect?: unknown }
    if (msg.kind !== 'req') return
    if (msg.op === 'highlight_region' && msg.rect !== null) lit.push(msg.rect)
    if (msg.op === 'screen_info') {
      shell.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { webview: { x: 0, y: 0, w: 2000, h: 1200 }, scale: 1 } }))
      return
    }
    if (msg.op === 'app_info') {
      shell.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { running: true, hidden: false, windows: [{ index: 0, frame: INSIDE }], name: 'X' } }))
      return
    }
    shell.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: {} }))
  })
  shell.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1', caps }))
  await until(() => helper.view().authorized)

  // 页面那条 /live:记下「放下」广播与事务官那一行字。
  const drops: unknown[] = []
  const notes: Record<string, unknown>[] = []
  const live = new WebSocket(`ws://127.0.0.1:${server.port}/live`)
  sockets.push(live)
  await new Promise(r => live.on('open', r))
  live.on('message', (data) => {
    const msg = JSON.parse(String(data)) as { kind: string, note?: Record<string, unknown> }
    if (msg.kind === 'slot_drop') drops.push(msg)
    if (msg.kind === 'actor_note' && msg.note !== undefined) notes.push(msg.note)
  })

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': SHELL_UA, ...headers }, body: JSON.stringify(body) })
    return res.json() as Promise<Record<string, unknown>>
  }
  const slot = { x: 100, y: 100, w: 400, h: 300 }
  await post('/slot/rect', { rect: slot, source: 'app' })
  const shellSend = (msg: Record<string, unknown>) => shell.send(JSON.stringify(msg))
  return { dock, helper, highlight, lit, drops, notes, post, slot, shellSend, server }
}

/** 事务官(程序)来的请求:没有 Origin、也不是壳里的页面。 */
const BUTLER = { 'user-agent': 'dsh-butler/1' }

describe('窗口槽那圈光只绑「真拖进一个新应用、放手」', () => {
  it('★一串不是拖拽的更新:原生光圈 0 次、页面「放下」广播 0 次;一次真拖入:各 1 次', async () => {
    const t = await setup()
    // 先认领两家(模拟以前拖进来的),再把计数清零 —— 下面只数「之后」的。
    t.shellSend({ kind: 'moved', bundle_id: CLAUDE, frame: INSIDE, dragged: true, pressed: false })
    await until(() => t.drops.length === 1)
    t.shellSend({ kind: 'moved', bundle_id: CODEX, frame: INSIDE, dragged: true, pressed: false })
    await until(() => t.drops.length === 2)
    await settle()
    t.lit.length = 0
    t.drops.length = 0

    // ① 点标签切换(页面点的):壳会把窗摆进槽 → 程序化的 moved(没人按鼠标)
    await t.post('/dock/switch', { app: 'claude' }, { origin: 'http://127.0.0.1:3080' })
    t.shellSend({ kind: 'moved', bundle_id: CLAUDE, frame: INSIDE, dragged: false, pressed: false })
    // ② 刷新:页面把同一个矩形再报一次
    await t.post('/slot/rect', { rect: t.slot, source: 'app' })
    // ③ 同一个应用重复上报(已认领,落在槽里 = 整理)
    t.shellSend({ kind: 'moved', bundle_id: CODEX, frame: INSIDE, dragged: true, pressed: false })
    t.shellSend({ kind: 'moved', bundle_id: CODEX, frame: INSIDE, dragged: true, pressed: false })
    // ④ 截图快捷键这类瞬时激活:藏着的被放出来又收回去
    t.shellSend({ kind: 'activation', bundle_id: CODEX, verdict: 'transient', reason: 'overlay', was_hidden: true, dwell_ms: 4000 })
    // ⑤ 悬停进出圈(老壳对程序化挪窗也会报)
    t.shellSend({ kind: 'hover', inside: true })
    t.shellSend({ kind: 'hover', inside: false })
    // ⑥ 壳重连
    t.shellSend({ kind: 'hello', role: 'helper', authorized: true, version: '1' })
    await settle()
    await settle()
    expect(t.lit).toEqual([])
    expect(t.drops).toEqual([])

    // 真拖入一个新应用:左键按着拖进槽、落定。
    t.shellSend({ kind: 'moved', bundle_id: 'com.tencent.WeWorkMac', frame: INSIDE, dragged: true, pressed: true })
    await until(() => t.drops.length === 1)
    await settle()
    expect(t.lit).toHaveLength(1)
    expect(t.drops).toEqual([{ kind: 'slot_drop', native: true }])
  })

  it('程序化挪窗碰巧落进槽(没人按鼠标):照旧认领,但不亮光', async () => {
    const t = await setup()
    t.shellSend({ kind: 'moved', bundle_id: CLAUDE, frame: INSIDE, dragged: false, pressed: false })
    await until(() => (t.dock !== undefined))
    await settle()
    await settle()
    const view = await t.dock.view()
    expect(view?.stack.map(tab => tab.key)).toEqual(['claude'])
    expect(t.lit).toEqual([])
    expect(t.drops).toEqual([])
  })

  for (const caps of [['activation', 'highlight_label', 'rehide'], ['activation']]) {
    it(`★事务官切窗、放开窗位、建事项、挪状态:壳收到 0 次光效请求,页面收到对应的一行字(壳 caps: ${caps.join(',')})`, async () => {
      const t = await setup(caps)
      t.shellSend({ kind: 'moved', bundle_id: CLAUDE, frame: INSIDE, dragged: true, pressed: false })
      await until(() => t.drops.length === 1)
      t.shellSend({ kind: 'moved', bundle_id: CODEX, frame: INSIDE, dragged: true, pressed: false })
      await until(() => t.drops.length === 2)
      await settle()
      t.lit.length = 0
      t.drops.length = 0

      expect((await t.post('/dock/switch', { app: 'claude' }, BUTLER)).ok).toBe(true)
      expect((await t.post('/dock/release', { app: 'codex' }, BUTLER)).ok).toBe(true)
      expect(await t.post('/task/create', { title: '通知测试', status: 'todo' }, BUTLER)).toEqual({ ok: true, id: 't-1' })
      expect((await t.post('/task/move', { id: 't-1', status: 'doing' }, BUTLER)).ok).toBe(true)
      await t.highlight.idle()
      await settle()
      expect(t.lit).toEqual([])
      expect(t.drops).toEqual([])
      const said = new Set(t.notes.map(note => `${String(note.region)}|${String(note.task_id ?? '')}|${String(note.text)}`))
      expect(said).toEqual(new Set([
        'slot||事务官正在切换窗位',
        'slot||事务官正在放开窗位里的应用',
        'board||事务官正在建事项',
        'board|t-1|事务官正在挪任务卡的状态',
      ]))

      // 他亲手把一个新应用拖进来、松手:照旧亮一次。
      t.shellSend({ kind: 'moved', bundle_id: 'com.tencent.WeWorkMac', frame: INSIDE, dragged: true, pressed: true })
      await until(() => t.drops.length === 1)
      await settle()
      expect(t.lit).toHaveLength(1)
    })
  }
})
