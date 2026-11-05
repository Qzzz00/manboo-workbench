// @vitest-environment node
/**
 * 辅助功能授权框的时机(2026-09-23 从零重装验收)。
 *
 * 以前壳一启动就弹系统那个「“工作台”想控制这台电脑」,那时工作台页面都还没出来,
 * 新用户不知道为什么要给。现在壳启动只静默查;**弹框只在他点「去授权」时发生**:
 * POST /setup/open { pane: 'accessibility' } → 经 helper 通道发 `request_accessibility`
 * → 壳调带 prompt 的 AXIsProcessTrustedWithOptions(同时把「工作台」登记进系统设置那张表)。
 * 设置页照旧打开(系统框同一个进程里不一定每次都肯再弹,设置页保证按下去一定有反应)。
 *
 * 真 WS 假壳 + 注入的假 exec(一条 `open` 都不会真跑),写法对齐
 * server-shell-window-mode.test.ts 与 setup-http.test.ts。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createHelperChannel, type HelperChannel } from '../src/server/helperChannel.ts'
import { createSetupService } from '../src/server/setup/service.ts'
import { nodeSetupIo, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'

const started: WorkbenchServer[] = []
const sockets: WebSocket[] = []
const dirs: string[] = []

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close()
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const ACCESSIBILITY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

async function serve(helper: HelperChannel | undefined) {
  const home = mkdtempSync(join(tmpdir(), 'wb-setup-ax-home-'))
  dirs.push(home)
  const calls: string[][] = []
  const io: SetupIo = {
    ...nodeSetupIo(),
    exec: async (cmd) => { calls.push([...cmd]); return { ok: true, code: 0, out: '' } },
    uid: () => 501,
    currentNodeBinary: () => join(home, '不存在的-node'),
  }
  const setup = createSetupService({
    io,
    paths: setupPaths({ home, repoRoot: home, applicationsDir: join(home, 'Applications') }),
    pluginVersion: '9.9.9',
    scanRoots: async () => [],
    repoRoot: home,
    now: () => Date.now(),
    newId: () => 'job-1',
    apkUrl: () => 'http://127.0.0.1:8791/setup/apk',
    recheckMs: 0,
  })
  const server = await startWorkbenchServer({
    port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, usageIntervalMs: 0,
    setup,
    ...(helper === undefined ? {} : { helper }),
    remoteAddress: () => '127.0.0.1',
    credentialFile: join(home, 'credentials.json'),
  })
  started.push(server)
  return { server, calls }
}

/** 真 WS 假壳。`answer` 决定它怎么回 request_accessibility(unknown_op = 老壳)。 */
async function attachFakeShell(url: string, authorized: boolean, answer: 'grant' | 'deny' | 'unknown_op') {
  const seen: Record<string, unknown>[] = []
  const ws = new WebSocket(`${url.replace('http', 'ws')}/helper`)
  sockets.push(ws)
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Record<string, unknown>
    if (msg.kind !== 'req') return
    seen.push(msg)
    if (msg.op !== 'request_accessibility') return
    const res = answer === 'unknown_op'
      ? { kind: 'res', id: msg.id, ok: false, error: '未知 op:request_accessibility' }
      : { kind: 'res', id: msg.id, ok: true, result: { authorized: answer === 'grant' } }
    ws.send(JSON.stringify(res))
  })
  await new Promise(r => ws.on('open', r))
  ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized, version: '1' }))
  return { seen }
}

function open(url: string, pane: string): Promise<Response> {
  return fetch(`${url}/setup/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pane }),
  })
}

describe('POST /setup/open accessibility —— 弹授权框的时机', () => {
  it('★没授权:先让壳弹系统框(request_accessibility),再打开设置页', async () => {
    const helper = createHelperChannel()
    const { server, calls } = await serve(helper)
    const shell = await attachFakeShell(server.url, false, 'deny')
    await until(() => helper.view().connected)

    const res = await open(server.url, 'accessibility')
    expect(res.status).toBe(200)
    expect(shell.seen.map(m => m.op)).toEqual(['request_accessibility'])
    expect(calls).toContainEqual(['open', ACCESSIBILITY_URL])
  })

  it('★request_accessibility 不被授权门拦(它本身就是去要授权的那一下)', async () => {
    const helper = createHelperChannel()
    const { server } = await serve(helper)
    await attachFakeShell(server.url, false, 'grant')
    await until(() => helper.view().connected)

    await expect(helper.request({ op: 'request_accessibility' })).resolves.toEqual({ authorized: true })
  })

  it('已经授权了:不再叫壳弹框,只打开设置页', async () => {
    const helper = createHelperChannel()
    const { server, calls } = await serve(helper)
    const shell = await attachFakeShell(server.url, true, 'grant')
    await until(() => helper.view().connected)

    expect((await open(server.url, 'accessibility')).status).toBe(200)
    expect(shell.seen).toEqual([])
    expect(calls).toContainEqual(['open', ACCESSIBILITY_URL])
  })

  it('别的设置页(文稿文件夹等)不碰壳', async () => {
    const helper = createHelperChannel()
    const { server } = await serve(helper)
    const shell = await attachFakeShell(server.url, false, 'grant')
    await until(() => helper.view().connected)

    expect((await open(server.url, 'files')).status).toBe(200)
    expect(shell.seen).toEqual([])
  })

  it('老壳不认这个 op:照样打开设置页,不报错', async () => {
    const helper = createHelperChannel()
    const { server, calls } = await serve(helper)
    await attachFakeShell(server.url, false, 'unknown_op')
    await until(() => helper.view().connected)

    expect((await open(server.url, 'accessibility')).status).toBe(200)
    expect(calls).toContainEqual(['open', ACCESSIBILITY_URL])
  })

  it('壳没连上 / 没接线:直接打开设置页(少的只是那个系统框)', async () => {
    const helper = createHelperChannel()
    const a = await serve(helper)
    expect((await open(a.server.url, 'accessibility')).status).toBe(200)
    expect(a.calls).toContainEqual(['open', ACCESSIBILITY_URL])

    const b = await serve(undefined)
    expect((await open(b.server.url, 'accessibility')).status).toBe(200)
    expect(b.calls).toContainEqual(['open', ACCESSIBILITY_URL])
  })
})
