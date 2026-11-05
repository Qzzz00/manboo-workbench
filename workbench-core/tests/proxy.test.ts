import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { startCore, type Core } from '../src/server.ts'
import { UPSTREAM_DOWN_TEXT, REMOTE_REFUSED_TEXT, interfaceTarget } from '../src/proxy.ts'
import { freePort, startFakeUpstream, until, type FakeUpstream } from './fakeUpstream.ts'

/** 这台机器眼下一个非回环的 IPv4(没有网卡就跳过那条真网卡用例)。 */
const lanAddress = Object.values(networkInterfaces()).flat().find(i => i !== undefined && i.family === 'IPv4' && !i.internal)?.address

let core: Core | undefined
let upstream: FakeUpstream | undefined
afterEach(async () => {
  await core?.close(); core = undefined
  await upstream?.stop(); upstream = undefined
})

interface Reply { status: number, headers: Record<string, string | string[] | undefined>, body: Buffer }

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: Buffer | string): Promise<Reply> {
  return callAt('127.0.0.1', port, method, path, headers, body)
}

function callAt(host: string, port: number, method: string, path: string, headers: Record<string, string> = {}, body?: Buffer | string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

describe('转发保真', () => {
  it('方法、路径与查询串、请求头、请求体原样到上游;状态码、响应头、响应体原样回来', async () => {
    upstream = await startFakeUpstream()
    upstream.on('/echo', (req, res) => {
      res.writeHead(418, 'I am a teapot', { 'x-from-upstream': 'yes', 'set-cookie': ['a=1', 'b=2'], 'content-type': 'text/plain' })
      res.end(`got ${req.method}`)
    })
    core = await startCore({ port: 0, upstream: upstream.url })

    const reply = await call(core.port, 'PUT', '/echo?x=1&y=%E4%B8%AD', { 'x-custom': '中'.length.toString(), authorization: 'Bearer test-only' }, '{"a":1}')
    expect(reply.status).toBe(418)
    expect(reply.headers['x-from-upstream']).toBe('yes')
    expect(reply.headers['set-cookie']).toEqual(['a=1', 'b=2'])
    expect(reply.body.toString()).toBe('got PUT')

    const seen = upstream.lastSeen()!
    expect(seen.method).toBe('PUT')
    expect(seen.url).toBe('/echo?x=1&y=%E4%B8%AD')
    expect(seen.headers['x-custom']).toBe('1')
    expect(seen.headers.authorization).toBe('Bearer test-only')
    expect(seen.headers.host).toBe(`127.0.0.1:${core.port}`)
    expect(seen.headers['x-forwarded-for']).toBe('127.0.0.1')
    expect(seen.body.toString()).toBe('{"a":1}')
  })

  it('二进制请求体与响应体一个字节不差;DELETE / PATCH / HEAD 照转', async () => {
    upstream = await startFakeUpstream()
    const blob = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 256))
    upstream.on('/bin', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(blob.length) })
      res.end(req.method === 'HEAD' ? undefined : blob)
    })
    core = await startCore({ port: 0, upstream: upstream.url })

    const post = await call(core.port, 'POST', '/bin', { 'content-type': 'application/octet-stream' }, blob)
    expect(Buffer.compare(upstream.lastSeen()!.body, blob)).toBe(0)
    expect(Buffer.compare(post.body, blob)).toBe(0)
    for (const method of ['DELETE', 'PATCH']) {
      const reply = await call(core.port, method, '/bin')
      expect(reply.status).toBe(200)
      expect(upstream.lastSeen()!.method).toBe(method)
    }
    const head = await call(core.port, 'HEAD', '/bin')
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(blob.length))
    expect(head.body.length).toBe(0)
  })

  it('流式响应边到边转:上游第二块还没写,第一块已经到客户端', async () => {
    upstream = await startFakeUpstream()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    upstream.on('/stream', async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      await gate
      res.end('data: two\n\n')
    })
    core = await startCore({ port: 0, upstream: upstream.url })

    const received: string[] = []
    const done = new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: core!.port, path: '/stream' }, (res) => {
        expect(res.headers['content-type']).toBe('text/event-stream')
        res.on('data', (c: Buffer) => received.push(c.toString()))
        res.on('end', () => resolve())
      })
      req.on('error', reject)
      req.end()
    })
    await until(() => received.join('').includes('one'), '第一块先到')
    expect(received.join('')).not.toContain('two')
    release()
    await done
    expect(received.join('')).toBe('data: one\n\ndata: two\n\n')
  })

  it('/snapshot/layout.md 这类插件自己的路径照转,只有 /events、/snapshot 两条精确路径归座机服务', async () => {
    upstream = await startFakeUpstream()
    upstream.on('/snapshot/layout.md', (_req, res) => { res.writeHead(200); res.end('# 布局') })
    core = await startCore({ port: 0, upstream: upstream.url })
    const reply = await call(core.port, 'GET', '/snapshot/layout.md')
    expect(reply.body.toString()).toBe('# 布局')
  })
})

describe('上游不在', () => {
  it('上游不在回 502 而不是 503:8791 的契约里 503 已经是「这项能力本机没配」(手机据此关语音 60 秒)', async () => {
    const port = await freePort()
    core = await startCore({ port: 0, upstream: `http://127.0.0.1:${port}` })
    const reply = await call(core.port, 'POST', '/api/tts', {}, '{}')
    expect(reply.status).not.toBe(503)
    expect(reply.status).toBe(502)
  })

  it('上游根本没起:回 502 和一句人话,不假装有数据', async () => {
    const port = await freePort()
    core = await startCore({ port: 0, upstream: `http://127.0.0.1:${port}` })
    const reply = await call(core.port, 'GET', '/state')
    expect(reply.status).toBe(502)
    const body = JSON.parse(reply.body.toString()) as Record<string, unknown>
    expect(body.error).toBe(UPSTREAM_DOWN_TEXT)
    expect(body).not.toHaveProperty('agents')
    expect(reply.headers['retry-after']).toBeDefined()
  })

  it('上游停了回 502,上游回来后同一个客户端下一次请求就恢复(像 DSH 重启)', async () => {
    upstream = await startFakeUpstream({ agents: [] })
    core = await startCore({ port: 0, upstream: upstream.url })
    expect((await call(core.port, 'GET', '/state')).status).toBe(200)

    await upstream.stop()
    expect((await call(core.port, 'GET', '/state')).status).toBe(502)
    expect((await call(core.port, 'POST', '/call/claim', {}, '{}')).status).toBe(502)

    await upstream.start()
    const back = await call(core.port, 'GET', '/state')
    expect(back.status).toBe(200)
    expect(JSON.parse(back.body.toString())).toEqual({ agents: [] })
  })

  it('请求在飞时上游断了、还没回头:502;已经回了头:客户端那一头也断开,不补一个假结尾', async () => {
    upstream = await startFakeUpstream()
    upstream.on('/hang', (req) => { req.socket.destroy() })
    upstream.on('/half', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('part')
      setTimeout(() => res.socket?.destroy(), 30)
    })
    core = await startCore({ port: 0, upstream: upstream.url })
    expect((await call(core.port, 'GET', '/hang')).status).toBe(502)
    await expect(call(core.port, 'GET', '/half')).rejects.toThrow()
  })

  it('上游接了连接却迟迟不回头(DSH 卡死):到期回 502 upstream_timeout,不让客户端永远挂着', async () => {
    upstream = await startFakeUpstream()
    upstream.on('/stuck', () => { /* 一声不吭 */ })
    core = await startCore({ port: 0, upstream: upstream.url, upstreamHeadersTimeoutMs: 100 })
    const started = Date.now()
    const reply = await call(core.port, 'GET', '/stuck')
    expect(reply.status).toBe(502)
    expect(reply.status).not.toBe(503)
    expect(JSON.parse(reply.body.toString())).toMatchObject({ code: 'upstream_timeout' })
    expect(reply.headers['retry-after']).toBeDefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('期限只管回头之前:已经回了头的长流(SSE、长轮询)写得再慢也照转', async () => {
    upstream = await startFakeUpstream()
    upstream.on('/slow', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.flushHeaders()
      setTimeout(() => res.end('late'), 300)
    })
    core = await startCore({ port: 0, upstream: upstream.url, upstreamHeadersTimeoutMs: 100 })
    const reply = await call(core.port, 'GET', '/slow')
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe('late')
  })
})

describe('非本机来源', () => {
  it('没配 CORE_UPSTREAM_REMOTE 时非本机来源一律 403,一个字节都不转给插件(插件会把转来的请求当本机)', async () => {
    upstream = await startFakeUpstream()
    core = await startCore({ port: 0, upstream: upstream.url, isLoopback: () => false })
    const reply = await call(core.port, 'GET', '/state')
    expect(reply.status).toBe(403)
    expect(JSON.parse(reply.body.toString()).error).toBe(REMOTE_REFUSED_TEXT)
    expect(upstream.lastSeen()).toBeUndefined()
  })

  it('写死的 CORE_UPSTREAM_REMOTE 是回环地址:起不来(那等于把远端请求当本机)', async () => {
    upstream = await startFakeUpstream()
    await expect(startCore({ port: 0, upstream: upstream.url, upstreamRemote: 'http://127.0.0.1:1' })).rejects.toThrow(/回环/)
  })

  it.skipIf(lanAddress === undefined)('写死的 CORE_UPSTREAM_REMOTE:非本机来源转到那一个地址,本机来源仍走 CORE_UPSTREAM;/snapshot 只给本机', async () => {
    upstream = await startFakeUpstream()
    const lanSide = await startFakeUpstream({}, 0, '0.0.0.0')
    upstream.on('/who', (_q, res) => { res.end('loopback-side') })
    lanSide.on('/who', (_q, res) => { res.end('lan-side') })
    let remote = false
    core = await startCore({ port: 0, upstream: upstream.url, upstreamRemote: `http://${lanAddress}:${lanSide.port}`, isLoopback: () => !remote })
    try {
      expect((await call(core.port, 'GET', '/who')).body.toString()).toBe('loopback-side')
      remote = true
      expect((await call(core.port, 'GET', '/who')).body.toString()).toBe('lan-side')
      expect((await call(core.port, 'GET', '/snapshot')).status).toBe(403)
    }
    finally { await lanSide.stop() }
  })
})


describe('非本机来源走「进来的那块网卡」(CORE_UPSTREAM_REMOTE=interface)', () => {
  it('interfaceTarget:用客户端连进来的那个本机地址 + 上游端口;那个地址是回环就不给(绝不把远端请求转成回环来源)', () => {
    expect(interfaceTarget('192.168.1.20', 8790)).toEqual({ host: '192.168.1.20', port: 8790 })
    expect(interfaceTarget('::ffff:10.0.0.5', 8790)).toEqual({ host: '10.0.0.5', port: 8790 })
    expect(interfaceTarget('127.0.0.1', 8790)).toBeUndefined()
    expect(interfaceTarget('::1', 8790)).toBeUndefined()
    expect(interfaceTarget(undefined, 8790)).toBeUndefined()
  })

  it('被判成非本机、但进来的网卡是回环时:403,不转', async () => {
    upstream = await startFakeUpstream()
    core = await startCore({ port: 0, upstream: upstream.url, upstreamRemote: 'interface', isLoopback: () => false })
    expect((await call(core.port, 'GET', '/state')).status).toBe(403)
    expect(upstream.lastSeen()).toBeUndefined()
  })

  it.skipIf(lanAddress === undefined)('真网卡:从局域网地址进来的请求,插件那头看到的来源不是回环(它会照旧认设备令牌)', async () => {
    upstream = await startFakeUpstream({}, 0, '0.0.0.0')
    core = await startCore({ port: 0, host: '0.0.0.0', upstream: upstream.url, upstreamRemote: 'interface' })
    const viaLan = await callAt(lanAddress!, core.port, 'GET', '/state')
    expect(viaLan.status).toBe(200)
    const seen = upstream.lastSeen()!
    expect(seen.remoteAddress?.replace(/^::ffff:/, '')).toBe(lanAddress)
    expect(seen.headers['x-forwarded-for']).toBe(lanAddress)
    // 同一台 core,回环进来的仍走回环那条
    await call(core.port, 'GET', '/state')
    expect(upstream.lastSeen()!.remoteAddress?.replace(/^::ffff:/, '')).toBe('127.0.0.1')
  })
})
