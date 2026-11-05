// @vitest-environment node
/**
 * 「发诊断包」(2026-10-21,内测发版底座):打包 → 传到中转 → 回六位编号。
 *
 * 打包走的是「导出诊断包」那一条(白名单与脱敏同一份,`diag-pack.test.ts` 钉着),这里只钉「发」那一半:
 *
 * 1. 用这台电脑的设备令牌传 `POST <中转>/v1/diag/pack`,传成了**本机不留副本**、也**不弹访达**
 *    (她可能是在手机上按的,电脑那边突然弹个窗没人看);
 * 2. 传不上去(没登录 / 中转不通 / 中转拒了)**包不丢**:挪到桌面,说清在哪、为什么;
 * 3. 是一条作业:起了立刻回,跑着时再按一次回同一条,看最近一趟有自己的口。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { nodeDiagIo, type DiagIo } from '../src/server/diagnostics/io.ts'
import { createDiagService } from '../src/server/diagnostics/service.ts'

const AT = Date.parse('2026-10-21T02:15:30.000Z')
const TZ = 8 * 60
const RELAY = 'http://relay.invalid'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface Upload { url: string, headers: Record<string, string>, bytes: Uint8Array }

function machine(options: {
  link?: { relayUrl: string, token: string } | undefined
  relay?: (upload: Upload) => Response | Promise<Response>
}) {
  const home = temp('wb-diag-send-home-')
  const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
  mkdirSync(`${paths.dshHome}/workbench`, { recursive: true })
  mkdirSync(paths.logsDir, { recursive: true })
  writeFileSync(`${paths.dshHome}/workbench/app.json`, JSON.stringify({ version: 1, lan_access: true }))
  writeFileSync(`${paths.logsDir}/web.stdout.log`, '[工作台] 起来了\n')
  const outDir = temp('wb-diag-send-desktop-')
  const stageRoot = temp('wb-diag-send-stage-')
  const opened: string[][] = []
  const real = nodeDiagIo(nodeSetupIo())
  const io: DiagIo = {
    ...real,
    exec: async (cmd, opts) => {
      if (cmd[0] === 'log') return { ok: true, code: 0, out: '' }
      if (cmd[0] === 'open') { opened.push([...cmd]); return { ok: true, code: 0, out: '' } }
      return await real.exec(cmd, opts)
    },
  }
  const uploads: Upload[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body = init?.body
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body as BodyInit).arrayBuffer())
    const upload = { url, headers, bytes }
    uploads.push(upload)
    if (options.relay === undefined) throw new Error('fetch failed')
    return await options.relay(upload)
  }) as typeof fetch
  const service = createDiagService({
    io,
    paths,
    now: () => AT,
    pluginVersion: '0.4.143',
    tzOffsetMinutes: TZ,
    outDir,
    stageRoot,
    snapshots: [],
    link: async () => options.link,
    fetchImpl,
  })
  return { service, outDir, stageRoot, uploads, opened }
}

const LINK = { relayUrl: RELAY, token: 'wb_test_device_token_0001' }

function relayOk(): Response {
  return new Response(JSON.stringify({ code: '7KQ2MX', bytes: 1234, expires_at: '2026-10-28T02:15:30.000Z', retention_days: 7 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('发诊断包', () => {
  it('★传成了:设备令牌、zip、版本号头都对;回编号与到期时刻;本机不留副本、不弹访达', async () => {
    const m = machine({ link: LINK, relay: () => relayOk() })
    const started = m.service.send()
    expect(started.state).toBe('running')
    await m.service.waitSend(started.id)
    const view = m.service.sendView()
    expect(view?.state).toBe('done')
    expect(view?.code).toBe('7KQ2MX')
    expect(view?.expires_at).toBe('2026-10-28T02:15:30.000Z')
    expect(view?.kept).toBeUndefined()

    expect(m.uploads).toHaveLength(1)
    const up = m.uploads[0] as Upload
    expect(up.url).toBe(`${RELAY}/v1/diag/pack`)
    expect(up.headers.authorization).toBe(`Bearer ${LINK.token}`)
    expect(up.headers['content-type']).toBe('application/zip')
    expect(up.headers['x-workbench-version']).toBe('0.4.143')
    expect([...up.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])

    expect(readdirSync(m.outDir)).toEqual([])
    expect(readdirSync(m.stageRoot).flatMap(name => readdirSync(join(m.stageRoot, name)))).toEqual([])
    expect(m.opened).toEqual([])
  }, 60_000)

  it('★没登录(取不到设备令牌)→ 不发,包挪到桌面并说在哪', async () => {
    const m = machine({ link: undefined })
    const started = m.service.send()
    await m.service.waitSend(started.id)
    const view = m.service.sendView()
    expect(view?.state).toBe('failed')
    expect(view?.error).toContain('登录')
    expect(view?.kept?.file).toBe(join(m.outDir, view?.kept?.name ?? ''))
    expect(readdirSync(m.outDir)).toEqual([view?.kept?.name])
    expect(m.uploads).toEqual([])
  }, 60_000)

  it('★中转不通(出门又没网)→ 包挪到桌面,话里说传不上去', async () => {
    const m = machine({ link: LINK })
    const started = m.service.send()
    await m.service.waitSend(started.id)
    const view = m.service.sendView()
    expect(view?.state).toBe('failed')
    expect(view?.error).toContain('传不上去')
    expect(readdirSync(m.outDir)).toEqual([view?.kept?.name])
  }, 60_000)

  it('中转拒了(比如今天传满了)→ 原样带上中转那句人话,包照样留着', async () => {
    const m = machine({
      link: LINK,
      relay: () => new Response(JSON.stringify({ error: { message: '这台设备今天已经传了 10 个诊断包', code: 'diag_pack_rate_limited' } }), { status: 429 }),
    })
    const started = m.service.send()
    await m.service.waitSend(started.id)
    const view = m.service.sendView()
    expect(view?.state).toBe('failed')
    expect(view?.error).toContain('今天已经传了 10 个')
    expect(view?.kept?.name).toMatch(/^工作台诊断包-\d{8}-\d{6}\.zip$/)
  }, 60_000)

  it('跑着时再按一次 → 回同一条(不打第二个包);没发过时看不到任何一趟', async () => {
    const m = machine({ link: LINK, relay: () => relayOk() })
    expect(m.service.sendView()).toBeUndefined()
    const first = m.service.send()
    const again = m.service.send()
    expect(again.id).toBe(first.id)
    await m.service.waitSend(first.id)
    expect(m.uploads).toHaveLength(1)
  }, 60_000)
})
