// @vitest-environment node
/**
 * 「工作台开着时电脑不睡」(2026-09-28,卡 AW)。
 *
 * 维护者 09-28 早,新 Air、不插电:「电脑自己会锁屏,可能跟没插电有关系,一锁屏小米上就显示
 * 找不到你的电脑。」真相是睡过去才断,锁屏不碍事 —— 所以工作台在运行期间让整台电脑不因空闲睡眠,
 * 屏幕照样能黑能锁。壳那半的判断在 workbench-app/Sources/SystemAwakePolicy.swift(run-tests.sh 有用例),
 * 这个文件钉服务端这一截:落盘(缺席 = 开、脏值当没配)与 `POST /shell/system-awake`
 * (转成壳的 `system_awake` op;壳没接上时**如实**说要重开工作台,不谎报当场生效)。
 *
 * 写法对齐 server-shell-window-mode.test.ts(真 WS 假壳)与 server-app-config.test.ts(临时 app.json)。
 * 「非回环 → 403」那一条在 server-dock-http.test.ts 的共享清单里(那张清单是防漏机制本身)。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createAppConfig, loadAppConfigFile } from '../src/server/appConfig.ts'
import { createHelperChannel } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close()
  while (started.length) await started.pop()?.close()
})

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'wb-awake-')), 'app.json')
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

/** 假壳:记下收到的 req,对 `system_awake` 回 `{enabled, held}`(真壳就是这么回的)。 */
async function attachFakeShell(url: string, opts: { answer?: boolean } = {}) {
  const seen: Record<string, unknown>[] = []
  const ws = new WebSocket(`${url.replace('http', 'ws')}/helper`)
  sockets.push(ws)
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Record<string, unknown>
    if (msg.kind !== 'req') return
    seen.push(msg)
    if (msg.op !== 'system_awake') return
    if (opts.answer === false) {
      ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: false, error: '未知 op' }))
      return
    }
    ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { enabled: msg.enabled, held: msg.enabled } }))
  })
  await new Promise(r => ws.on('open', r))
  // 授权没给也照样该通:这条 op 一个窗口都不碰(helperChannel 的 AX_FREE_OPS 里有它)。
  ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: false, version: '1' }))
  return { seen }
}

async function serve(extra: Partial<Parameters<typeof startWorkbenchServer>[0]> = {}) {
  const server = await startWorkbenchServer({
    port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, ...extra,
  })
  started.push(server)
  return server
}

describe('app.json 的 system_awake_while_running', () => {
  it('★缺席 = 开(她买电脑不是为了守着它:默认就该「开着工作台就找得到」)', async () => {
    const file = tmpFile()
    expect((await loadAppConfigFile(file)).system_awake_while_running).toBeUndefined()
    // 读的一侧一律 `!== false`,所以缺席就是开。
    expect((await createAppConfig({ file }).get()).system_awake_while_running !== false).toBe(true)
  })

  it('★关掉落盘,重新读回来还是关着;别的键一个字不动', async () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ version: 1, lan_access: true, someone_else: { a: 1 } }))
    await createAppConfig({ file }).set({ system_awake_while_running: false })
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(raw.system_awake_while_running).toBe(false)
    expect(raw.someone_else).toEqual({ a: 1 })
    expect(raw.lan_access).toBe(true)
    expect((await createAppConfig({ file }).get()).system_awake_while_running).toBe(false)
  })

  it('脏值(字符串 "false")当没配过 → 还是开(壳那边 SystemAwakePolicy.settingOn 同一条规矩)', async () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ version: 1, system_awake_while_running: 'false' }))
    expect((await loadAppConfigFile(file)).system_awake_while_running).toBeUndefined()
  })
})

describe('/shell/system-awake', () => {
  it('★GET:没配过回 {enabled:true}', async () => {
    const server = await serve({ appConfig: createAppConfig({ file: tmpFile() }) })
    const res = await fetch(`${server.url}/shell/system-awake`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: true })
  })

  it('★POST:落盘 + 当场转成壳的 system_awake op(授权没给也照样通)', async () => {
    const file = tmpFile()
    const helper = createHelperChannel()
    const server = await serve({ helper, appConfig: createAppConfig({ file }) })
    const shell = await attachFakeShell(server.url)
    await until(() => helper.view().connected)

    const res = await fetch(`${server.url}/shell/system-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, enabled: false, applied: true })
    expect(shell.seen.map(m => ({ op: m.op, enabled: m.enabled }))).toEqual([{ op: 'system_awake', enabled: false }])
    expect((await loadAppConfigFile(file)).system_awake_while_running).toBe(false)
    // 再开回来:落盘与 op 都跟着走。
    await fetch(`${server.url}/shell/system-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect((await loadAppConfigFile(file)).system_awake_while_running).toBe(true)
    expect(shell.seen.map(m => m.enabled)).toEqual([false, true])
  })

  it('★壳没接上:落盘照样算数,但如实说要重开工作台才生效(不谎报)', async () => {
    const file = tmpFile()
    const server = await serve({ helper: createHelperChannel(), appConfig: createAppConfig({ file }) })
    const res = await fetch(`${server.url}/shell/system-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    const body = await res.json() as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.enabled).toBe(false)
    expect(body.applied).toBe(false)
    expect(String(body.reason)).toContain('工作台 App 未运行')
    expect((await loadAppConfigFile(file)).system_awake_while_running).toBe(false)
  })

  it('★旧壳不认这个 op:同样只说「重开工作台后生效」,不说已经生效', async () => {
    const helper = createHelperChannel()
    const server = await serve({ helper, appConfig: createAppConfig({ file: tmpFile() }) })
    await attachFakeShell(server.url, { answer: false })
    await until(() => helper.view().connected)

    const res = await fetch(`${server.url}/shell/system-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    const body = await res.json() as Record<string, unknown>
    expect(body.applied).toBe(false)
    expect(String(body.reason)).toContain('未知 op')
  })

  it('enabled 只认布尔:别的 400,一个字都不落盘', async () => {
    const file = tmpFile()
    const server = await serve({ appConfig: createAppConfig({ file }) })
    for (const bad of [{ enabled: 'false' }, { enabled: 0 }, {}]) {
      const res = await fetch(`${server.url}/shell/system-awake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bad),
      })
      expect(res.status).toBe(400)
    }
    expect((await loadAppConfigFile(file)).system_awake_while_running).toBeUndefined()
  })

  it('没接工作台开关的部署 → 404(不假装有一颗开关)', async () => {
    const server = await serve({})
    const res = await fetch(`${server.url}/shell/system-awake`)
    expect(res.status).toBe(404)
  })
})
