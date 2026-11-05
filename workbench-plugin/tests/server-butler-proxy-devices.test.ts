// @vitest-environment node
/**
 * 手机经 8791 打本机后端(2026-09-14,材料第 7 节第 5 项第二刀):
 * /butler/proxy/* 对持设备令牌的非本机来源开放,转发时带 X-Workbench-Device 与 X-Forwarded-*;
 * 手机只能到公开面(/api/*、/uploads/*、/health),/admin/* 仍只有本机能经代理进;
 * GET 也认 ?token=(WebView 里 <img>/<audio> 设不了请求头),转发前把 token 从 query 里摘掉。
 * ASR 是普通 HTTP POST(Aiboo 手机端把录音转成 wav 再 POST),不需要 WebSocket 转发。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppConfig } from '../src/server/appConfig.ts'
import type { ButlerProxyRequest, ButlerService } from '../src/server/butler.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { createNotesService } from '../src/server/notes.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

function fakeMdns(): MdnsAdvertiser {
  let on = false
  return { async start() { on = true }, async stop() { on = false }, active: () => on }
}

function recordingButler(): ButlerService & { requests: ButlerProxyRequest[] } {
  const requests: ButlerProxyRequest[] = []
  return {
    requests,
    view: async () => ({ running: true, port: 8792 }),
    adminUrl: async () => 'http://127.0.0.1:8792/admin/',
    start: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    open: async () => ({ ok: true }),
    proxy: async (req) => {
      requests.push(req)
      return {
        status: 200,
        contentType: 'application/json',
        headers: { etag: '"abc"', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400' },
        body: Buffer.from(JSON.stringify({ path: req.path, body: req.body?.toString() ?? '' })),
      }
    },
  }
}

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-butler-proxy-'))
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const butler = recordingButler()
  const remote = { address: LOOPBACK }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    notes: createNotesService({ file: join(dir, 'notes.json') }),
    pairing,
    butler,
    lan: { config, mdns: fakeMdns(), lanAddress: () => '10.86.37.27', name: '测试工作台', version: '0.0.0' },
    remoteAddress: () => remote.address,
  })
  started.push(server)
  const call = async (path: string, init: { method?: string, body?: string, contentType?: string, token?: string, from?: string, headers?: Record<string, string> } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.contentType === undefined ? {} : { 'content-type': init.contentType }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
        ...(init.headers ?? {}),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, text, headers: res.headers, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const pair = async () => {
    expect((await call('/lan', { body: JSON.stringify({ enabled: true }), contentType: 'application/json' })).status).toBe(200)
    const startRes = await call('/pair/start', { method: 'POST' })
    const code = (startRes.body.pairing as { code: string }).code
    const claim = await call('/pair/claim', { body: JSON.stringify({ code, device_name: 'Ben 的 iPhone', platform: 'ios' }), contentType: 'application/json', from: PHONE })
    expect(claim.status).toBe(200)
    return { token: claim.body.token as string, deviceId: claim.body.device_id as string }
  }
  return { server, butler, call, pair }
}

describe('/butler/proxy/* 与设备令牌', () => {
  it('非本机不带令牌 → 401,后端没收到任何请求', async () => {
    const t = await serve()
    await t.pair()
    const res = await t.call('/butler/proxy/api/avatars', { from: PHONE })
    expect(res.status).toBe(401)
    expect(t.butler.requests).toEqual([])
  })

  it('带令牌 → 200,后端收到 X-Workbench-Device 与 X-Forwarded-*(host 是手机请求里的 8791 地址)', async () => {
    const t = await serve()
    const { token, deviceId } = await t.pair()
    const res = await t.call('/butler/proxy/api/avatars?x=1', { from: PHONE, token })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ path: '/api/avatars?x=1', body: '' })
    expect(t.butler.requests).toHaveLength(1)
    const req = t.butler.requests[0]!
    expect(req.method).toBe('GET')
    // fetch 不让改 Host 头,这里手机"看到的地址"就是测试服务器自己的地址;真机上是 10.x.x.x:8791。
    expect(req.headers).toMatchObject({
      'x-workbench-device': deviceId,
      'x-forwarded-host': t.server.url.replace('http://', ''),
      'x-forwarded-proto': 'http',
      'x-forwarded-prefix': '/butler/proxy',
    })
    // 设备令牌本身绝不往后端送。
    expect(JSON.stringify(req)).not.toContain(token)
    // 后端给的缓存/Range 头原样带回给手机。
    expect(res.headers.get('etag')).toBe('"abc"')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
  })

  it('本机来源照旧:不带设备头,但同样带 X-Forwarded-*;能进 /admin/*', async () => {
    const t = await serve()
    const res = await t.call('/butler/proxy/admin/tts-models', { body: '{"name":"x"}', contentType: 'application/json' })
    expect(res.status).toBe(200)
    const req = t.butler.requests[0]!
    expect(req.path).toBe('/admin/tts-models')
    expect(req.contentType).toBe('application/json')
    expect(req.body?.toString()).toBe('{"name":"x"}')
    expect(req.headers?.['x-workbench-device']).toBeUndefined()
    expect(req.headers?.['x-forwarded-prefix']).toBe('/butler/proxy')
  })

  it('手机只能到公开面:/api/*、/uploads/*、/health 放行;/admin/* 与别的路径 403,后端不收', async () => {
    const t = await serve()
    const { token } = await t.pair()
    for (const p of ['/butler/proxy/api/tts', '/butler/proxy/uploads/portraits/a.png', '/butler/proxy/health']) {
      expect((await t.call(p, { from: PHONE, token, method: 'GET' })).status, p).toBe(200)
    }
    expect(t.butler.requests).toHaveLength(3)
    for (const p of [
      '/butler/proxy/admin/tts-models', '/butler/proxy/admin/avatars', '/butler/proxy/', '/butler/proxy/admin',
      // fetch 会把这些归一化成 /admin/…,得在门口就拦下。
      '/butler/proxy/api/../admin/tts-models', '/butler/proxy/api/%2e%2e/admin/tts-models', '/butler/proxy/api/..%5cadmin/tts-models',
    ]) {
      const res = await t.call(p, { from: PHONE, token, method: 'GET' })
      expect(res.status, p).toBe(403)
      expect(res.body.error, p).toBe('手机只能访问本机后端的公开接口')
    }
    expect(t.butler.requests).toHaveLength(3)
  })

  it('POST 的 body 与 content-type 原样转发,音频回包的 content-type 原样带回', async () => {
    const t = await serve()
    const { token } = await t.pair()
    t.butler.proxy = async (req) => {
      t.butler.requests.push(req)
      return { status: 200, contentType: 'audio/mpeg', body: Buffer.from('ID3fake') }
    }
    const res = await fetch(`${t.server.url}/butler/proxy/api/tts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{"text":"早"}',
    })
    // 这一发没走 t.call,来源是回环;只验证 body / content-type 双向透传。
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('ID3fake')
    expect(t.butler.requests.at(-1)?.body?.toString()).toBe('{"text":"早"}')
    expect(t.butler.requests.at(-1)?.contentType).toBe('application/json')
  })

  it('GET 也认 ?token=(WebView 里 <img>/<audio> 设不了请求头),转发前把 token 摘掉;POST 不认', async () => {
    const t = await serve()
    const { token, deviceId } = await t.pair()
    const res = await t.call(`/butler/proxy/uploads/portraits/p.png?token=${encodeURIComponent(token)}&v=2`, { from: PHONE })
    expect(res.status).toBe(200)
    const req = t.butler.requests.at(-1)!
    expect(req.path).toBe('/uploads/portraits/p.png?v=2')
    expect(req.headers?.['x-workbench-device']).toBe(deviceId)
    expect(JSON.stringify(req)).not.toContain(token)

    const post = await t.call(`/butler/proxy/api/tts?token=${encodeURIComponent(token)}`, { from: PHONE, body: '{}', contentType: 'application/json' })
    expect(post.status).toBe(401)
    // 别的路径的 GET 也不认 query 令牌:只给代理开这个口。
    expect((await t.call(`/state?token=${encodeURIComponent(token)}`, { from: PHONE })).status).toBe(401)
  })

  it('Range 头透传(手机分段下 Live2D 包)', async () => {
    const t = await serve()
    const { token } = await t.pair()
    await t.call('/butler/proxy/api/avatars/a1/bundle.zip', { from: PHONE, token, headers: { range: 'bytes=0-99' } })
    expect(t.butler.requests.at(-1)?.headers?.range).toBe('bytes=0-99')
  })
})
