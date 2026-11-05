// @vitest-environment node
/**
 * ★ **`/shell/away-keep-awake`**(2026-10-03,卡「出门时电脑不睡」)。
 *
 * 写法对齐 `server-system-awake.test.ts`(临时 app.json + 真 WS 假壳)——
 * 那颗开关是这一颗的近亲,两处的分寸要一样:**落盘照样算数,壳没接上就如实说要重开工作台**。
 * 「非回环 → 403」那两条在 `server-dock-http.test.ts` 的共享清单里(那张清单是防漏机制本身)。
 *
 * 判断本身与下发的时机在 `server-away-awake.test.ts`;壳那一半在 `workbench-app/run-tests.sh`。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createAppConfig, loadAppConfigFile } from '../src/server/appConfig.ts'
import { createAwayAwakeWatch } from '../src/server/awayAwake.ts'
import type { DevicesView, PairedKinds } from '../src/server/deviceDirectory.ts'
import { createHelperChannel } from '../src/server/helperChannel.ts'
import type { HelperChannel } from '../src/server/helperChannel.ts'
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
  return join(mkdtempSync(join(tmpdir(), 'wb-away-')), 'app.json')
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

/** 假壳:记下收到的 req,对 `away_awake` 回 `{active, held}`(真壳就是这么回的)。 */
async function attachFakeShell(url: string, opts: { answer?: boolean } = {}) {
  const seen: Record<string, unknown>[] = []
  const ws = new WebSocket(`${url.replace('http', 'ws')}/helper`)
  sockets.push(ws)
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Record<string, unknown>
    if (msg.kind !== 'req') return
    seen.push(msg)
    if (msg.op !== 'away_awake') return
    if (opts.answer === false) {
      ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: false, error: '未知 op' }))
      return
    }
    ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { active: msg.active, held: msg.active } }))
  })
  await new Promise(r => ws.on('open', r))
  // 授权没给也照样该通:这条 op 一个窗口都不碰(helperChannel 的 AX_FREE_OPS 里有它)。
  ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: false, version: '1' }))
  return { seen }
}

const PHONE = 'dev-phone-1'
const paired: PairedKinds = new Map([[PHONE, 'phone']])

function roomWithPhone(): DevicesView {
  return {
    devices: [{ identity: `wb-phone-${PHONE}`, device_id: PHONE, name: '小米', kind: 'phone' }],
    reported_at: '2026-10-03T12:00:00.000Z',
    stale: false,
  }
}

function watchOf(helper: HelperChannel, file: string, devices: () => DevicesView) {
  return createAwayAwakeWatch({
    settingOn: async () => (await loadAppConfigFile(file)).away_keep_awake === true,
    devices,
    paired: async () => paired,
    send: async active => { await helper.request({ op: 'away_awake', active }) },
    connected: () => helper.view().connected,
  })
}

async function serve(extra: Partial<Parameters<typeof startWorkbenchServer>[0]> = {}) {
  const server = await startWorkbenchServer({
    port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, ...extra,
  })
  started.push(server)
  return server
}

describe('app.json 的 away_keep_awake', () => {
  it('★★缺席 = **关**(与「电脑不睡」那颗相反:她看不见自己家的屏亮不亮)', async () => {
    const file = tmpFile()
    expect((await loadAppConfigFile(file)).away_keep_awake).toBeUndefined()
    expect((await createAppConfig({ file }).get()).away_keep_awake === true).toBe(false)
  })

  it('★开了落盘,重新读回来还是开着;别的键一个字不动', async () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ version: 1, lan_access: true, system_awake_while_running: false, someone_else: { a: 1 } }))
    await createAppConfig({ file }).set({ away_keep_awake: true })
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(raw.away_keep_awake).toBe(true)
    expect(raw.lan_access).toBe(true)
    expect(raw.system_awake_while_running, '旁边那颗开关一个字不动').toBe(false)
    expect(raw.someone_else).toEqual({ a: 1 })
    expect((await createAppConfig({ file }).get()).away_keep_awake).toBe(true)
  })

  it('★脏值(字符串 "true")当没配过 → 还是关', async () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ version: 1, away_keep_awake: 'true' }))
    expect((await loadAppConfigFile(file)).away_keep_awake).toBeUndefined()
  })
})

describe('/shell/away-keep-awake', () => {
  it('★GET:没配过回 {enabled:false};没接那一拍时另两格**缺席**(不编一个 false)', async () => {
    const server = await serve({ appConfig: createAppConfig({ file: tmpFile() }) })
    const res = await fetch(`${server.url}/shell/away-keep-awake`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false })
  })

  it('★★POST 打开:落盘 + 当场下发 `away_awake {active:true}`(手机正在外面连着)', async () => {
    const file = tmpFile()
    const helper = createHelperChannel()
    const server = await serve({
      helper, appConfig: createAppConfig({ file }), awayAwake: watchOf(helper, file, roomWithPhone),
    })
    const shell = await attachFakeShell(server.url)
    await until(() => helper.view().connected)

    const res = await fetch(`${server.url}/shell/away-keep-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, enabled: true, phone_away: true, active: true, applied: true })
    expect(shell.seen.map(m => ({ op: m.op, active: m.active }))).toEqual([{ op: 'away_awake', active: true }])
    expect((await loadAppConfigFile(file)).away_keep_awake).toBe(true)
  })

  it('★★POST 关掉:下发 `active:false` —— 壳当场回到「只看前台」那一套', async () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ version: 1, away_keep_awake: true }))
    const helper = createHelperChannel()
    const server = await serve({
      helper, appConfig: createAppConfig({ file }), awayAwake: watchOf(helper, file, roomWithPhone),
    })
    const shell = await attachFakeShell(server.url)
    await until(() => helper.view().connected)

    const res = await fetch(`${server.url}/shell/away-keep-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(await res.json()).toEqual({ ok: true, enabled: false, phone_away: true, active: false, applied: true })
    expect(shell.seen.map(m => m.active)).toEqual([false])
    expect((await loadAppConfigFile(file)).away_keep_awake).toBe(false)
  })

  it('★★开关开着但手机**没在外面**:下发 false、`active:false` —— 与今天逐字相同', async () => {
    const file = tmpFile()
    const helper = createHelperChannel()
    const empty: DevicesView = { devices: [], reported_at: '2026-10-03T12:00:00.000Z', stale: false }
    const server = await serve({
      helper, appConfig: createAppConfig({ file }), awayAwake: watchOf(helper, file, () => empty),
    })
    const shell = await attachFakeShell(server.url)
    await until(() => helper.view().connected)

    const res = await fetch(`${server.url}/shell/away-keep-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(await res.json()).toEqual({ ok: true, enabled: true, phone_away: false, active: false, applied: true })
    expect(shell.seen.map(m => m.active)).toEqual([false])
  })

  it('★★「不知道」(工人掉线,那份表旧了)→ `phone_away` 那一格**不摆**,active 照旧 false', async () => {
    const file = tmpFile()
    const helper = createHelperChannel()
    const stale: DevicesView = { ...roomWithPhone(), stale: true }
    const server = await serve({
      helper, appConfig: createAppConfig({ file }), awayAwake: watchOf(helper, file, () => stale),
    })
    await attachFakeShell(server.url)
    await until(() => helper.view().connected)

    const res = await fetch(`${server.url}/shell/away-keep-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    const body = await res.json() as Record<string, unknown>
    expect(body).toEqual({ ok: true, enabled: true, active: false, applied: true })
    expect('phone_away' in body).toBe(false)
  })

  it('★壳没接上:落盘照样算数,但如实说要重开工作台(不谎报)', async () => {
    const file = tmpFile()
    const helper = createHelperChannel()
    const server = await serve({
      helper, appConfig: createAppConfig({ file }), awayAwake: watchOf(helper, file, roomWithPhone),
    })
    const res = await fetch(`${server.url}/shell/away-keep-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    const body = await res.json() as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.enabled).toBe(true)
    expect(body.applied).toBe(false)
    expect(String(body.reason)).toContain('重开工作台')
    expect((await loadAppConfigFile(file)).away_keep_awake).toBe(true)
  })

  it('★旧壳不认这个 op:同样只说「重开工作台后生效」,原话往上传', async () => {
    const file = tmpFile()
    const helper = createHelperChannel()
    const server = await serve({
      helper, appConfig: createAppConfig({ file }), awayAwake: watchOf(helper, file, roomWithPhone),
    })
    await attachFakeShell(server.url, { answer: false })
    await until(() => helper.view().connected)

    const res = await fetch(`${server.url}/shell/away-keep-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    const body = await res.json() as Record<string, unknown>
    expect(body.applied).toBe(false)
    expect(String(body.reason)).toContain('未知 op')
  })

  it('★没接那一拍(老宿主):落盘算数,如实说壳那头不生效', async () => {
    const file = tmpFile()
    const server = await serve({ helper: createHelperChannel(), appConfig: createAppConfig({ file }) })
    const res = await fetch(`${server.url}/shell/away-keep-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    const body = await res.json() as Record<string, unknown>
    expect(body.applied).toBe(false)
    expect(String(body.reason)).toContain('重开工作台')
    expect((await loadAppConfigFile(file)).away_keep_awake).toBe(true)
  })

  it('enabled 只认布尔:别的 400,一个字都不落盘', async () => {
    const file = tmpFile()
    const server = await serve({ appConfig: createAppConfig({ file }) })
    for (const bad of [{ enabled: 'true' }, { enabled: 1 }, {}]) {
      const res = await fetch(`${server.url}/shell/away-keep-awake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bad),
      })
      expect(res.status).toBe(400)
    }
    expect((await loadAppConfigFile(file)).away_keep_awake).toBeUndefined()
  })

  it('没接工作台开关的部署 → 404(不假装有一颗开关)', async () => {
    const server = await serve({})
    expect((await fetch(`${server.url}/shell/away-keep-awake`)).status).toBe(404)
  })

  it('★★旁边那颗「工作台开着时电脑不睡」一个字不动(两颗是两件事)', async () => {
    const file = tmpFile()
    const server = await serve({ appConfig: createAppConfig({ file }) })
    await fetch(`${server.url}/shell/away-keep-awake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    // 整机那颗照旧「缺席 = 开」,没被这一颗带着改。
    expect(await (await fetch(`${server.url}/shell/system-awake`)).json()).toEqual({ enabled: true })
    expect((await loadAppConfigFile(file)).system_awake_while_running).toBeUndefined()
  })
})
