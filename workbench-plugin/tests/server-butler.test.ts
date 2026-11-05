// @vitest-environment node
/**
 * 事务官本机后端(butler-server)在工作台这一侧的接线(2026-09-11)。
 * 服务层:状态探测(缓存、不编数、令牌不外泄)、启停(只走 launchctl,没装就如实报错;停止可按 pid 兜底)、代理。
 * HTTP 面:/state.butler、/butler/* 路由、写只认回环。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createButlerService, type ButlerService } from '../src/server/butler.ts'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import type { WorkbenchState } from '../src/protocol.ts'

const TOKEN = 'a'.repeat(64)

async function configFile(content: unknown = { version: 1, port: 18792, token: TOKEN }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'butler-cfg-test-'))
  const file = join(dir, 'butler.json')
  if (content !== null) await writeFile(file, JSON.stringify(content))
  return file
}

/** 假的 fetch:记录请求,按 healthy 决定 /health 怎么答。 */
function fakeFetch(opts: { healthy?: boolean, body?: Record<string, unknown> } = {}) {
  const calls: { url: string, init?: RequestInit | undefined }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (opts.healthy === false) throw new Error('ECONNREFUSED')
    const body = opts.body ?? { ok: true, avatarCount: 3, voiceCount: 5, pid: 4242 }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
      json: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
    }
  }) as unknown as typeof fetch
  return { impl, calls }
}

function recorder(answers: Record<string, boolean> = {}) {
  const cmds: string[][] = []
  const runCommand = async (cmd: readonly string[]) => {
    cmds.push([...cmd])
    const key = cmd.slice(0, 2).join(' ')
    return { ok: answers[key] ?? true, stdout: '' }
  }
  return { cmds, runCommand }
}

describe('createButlerService · 状态', () => {
  it('后端在跑:running + 端口 + 两个数字;请求头带令牌,视图里没有令牌', async () => {
    const { impl, calls } = fakeFetch()
    const service = createButlerService({ configFile: await configFile(), runCommand: recorder().runCommand, fetchImpl: impl, cacheMs: 0 })
    const view = await service.view()
    expect(view).toEqual({ running: true, port: 18792, avatarCount: 3, voiceCount: 5 })
    expect(calls[0]?.url).toBe('http://127.0.0.1:18792/health')
    expect((calls[0]?.init?.headers as Record<string, string>)['x-workbench-token']).toBe(TOKEN)
    expect(JSON.stringify(view)).not.toContain(TOKEN)
  })

  it('后端没起:running:false,数字整个缺席(不填 0)', async () => {
    const { impl } = fakeFetch({ healthy: false })
    const service = createButlerService({ configFile: await configFile(), runCommand: recorder().runCommand, fetchImpl: impl, cacheMs: 0 })
    expect(await service.view()).toEqual({ running: false, port: 18792 })
  })

  it('后端在跑但没给数字:只报 running,不编数', async () => {
    const { impl } = fakeFetch({ body: { ok: true } })
    const service = createButlerService({ configFile: await configFile(), runCommand: recorder().runCommand, fetchImpl: impl, cacheMs: 0 })
    expect(await service.view()).toEqual({ running: true, port: 18792 })
  })

  it('没有 butler.json(后端从没起过):端口按默认 8792,不带令牌头', async () => {
    const { impl, calls } = fakeFetch({ healthy: false })
    const service = createButlerService({ configFile: await configFile(null), runCommand: recorder().runCommand, fetchImpl: impl, cacheMs: 0 })
    expect(await service.view()).toEqual({ running: false, port: 8792 })
    expect(calls[0]?.url).toBe('http://127.0.0.1:8792/health')
    expect(calls[0]?.init?.headers).toEqual({})
  })

  it('语音合成钥匙的那一格原样带上(有没有、从哪来、一句人话);形状不对就缺席(2026-09-23)', async () => {
    const note = '服务器还没下发语音合成的钥匙,她暂时开不了口(要维护者在服务器上补,不用自己去设置里填)。'
    const { impl } = fakeFetch({ body: { ok: true, tts: { ready: false, source: 'none', note } } })
    const service = createButlerService({ configFile: await configFile(), runCommand: recorder().runCommand, fetchImpl: impl, cacheMs: 0 })
    expect(await service.view()).toEqual({ running: true, port: 18792, tts: { ready: false, source: 'none', note } })

    const bad = fakeFetch({ body: { ok: true, tts: { ready: 'yes', source: 'mars' } } })
    const service2 = createButlerService({ configFile: await configFile(), runCommand: recorder().runCommand, fetchImpl: bad.impl, cacheMs: 0 })
    expect(await service2.view()).toEqual({ running: true, port: 18792 })
  })

  it('3 秒内重复 view() 不重探(1 秒轮询 /state 不该变成每秒打后端)', async () => {
    const { impl, calls } = fakeFetch()
    let now = 1000
    const service = createButlerService({ configFile: await configFile(), runCommand: recorder().runCommand, fetchImpl: impl, now: () => now })
    await service.view()
    now += 1000
    await service.view()
    expect(calls).toHaveLength(1)
    now += 2500
    await service.view()
    expect(calls).toHaveLength(2)
  })
})

describe('createButlerService · 启停与打开', () => {
  it('启动走 launchctl kickstart -k gui/<uid>/ai.deepseek.butler', async () => {
    const rec = recorder()
    const service = createButlerService({ configFile: await configFile(), runCommand: rec.runCommand, fetchImpl: fakeFetch().impl, uid: 501 })
    expect(await service.start()).toEqual({ ok: true })
    expect(rec.cmds).toEqual([['launchctl', 'kickstart', '-k', 'gui/501/ai.deepseek.butler']])
  })

  it('launchd 项没装时不绕过 launchd 自己拉,如实指到登录台一键装(2026-09-17 风暴后撤掉兜底)', async () => {
    const rec = recorder({ 'launchctl kickstart': false })
    const service = createButlerService({ configFile: await configFile(), runCommand: rec.runCommand, fetchImpl: fakeFetch().impl, uid: 501 })
    const result = await service.start()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ai.deepseek.butler')
    expect(result.error).toContain('一键装')
    // 只试过 launchctl,没有别的起法。
    expect(rec.cmds).toEqual([['launchctl', 'kickstart', '-k', 'gui/501/ai.deepseek.butler']])
  })

  it('停止走 launchctl kill SIGTERM;launchd 不认时按 /health 的 pid 发 SIGTERM', async () => {
    const rec = recorder({ 'launchctl kill': false })
    const killed: number[] = []
    const service = createButlerService({
      configFile: await configFile(), runCommand: rec.runCommand, fetchImpl: fakeFetch().impl, uid: 501, cacheMs: 0,
      killProcess: (pid) => { killed.push(pid); return true },
    })
    expect(await service.stop()).toEqual({ ok: true })
    expect(rec.cmds).toEqual([['launchctl', 'kill', 'SIGTERM', 'gui/501/ai.deepseek.butler']])
    expect(killed).toEqual([4242])
  })

  it('本来就没在跑时停止如实说「本来就没在跑」', async () => {
    const rec = recorder({ 'launchctl kill': false })
    const service = createButlerService({ configFile: await configFile(), runCommand: rec.runCommand, fetchImpl: fakeFetch({ healthy: false }).impl, cacheMs: 0, killProcess: () => false })
    expect(await service.stop()).toEqual({ ok: false, error: '本来就没在跑' })
  })

  it('打开配置后台 = open http://127.0.0.1:<port>/admin/', async () => {
    const rec = recorder()
    const service = createButlerService({ configFile: await configFile(), runCommand: rec.runCommand, fetchImpl: fakeFetch().impl })
    expect(await service.open()).toEqual({ ok: true })
    expect(rec.cmds).toEqual([['open', 'http://127.0.0.1:18792/admin/']])
  })
})

describe('createButlerService · 代理', () => {
  it('转发方法/路径/query/body,带上令牌', async () => {
    const { impl, calls } = fakeFetch()
    const service = createButlerService({ configFile: await configFile(), runCommand: recorder().runCommand, fetchImpl: impl })
    const res = await service.proxy({ method: 'POST', path: '/admin/tts-models?x=1', contentType: 'application/json', body: Buffer.from('{"a":1}') })
    expect(res.status).toBe(200)
    expect(calls[0]?.url).toBe('http://127.0.0.1:18792/admin/tts-models?x=1')
    expect(calls[0]?.init?.method).toBe('POST')
    expect((calls[0]?.init?.headers as Record<string, string>)['x-workbench-token']).toBe(TOKEN)
    expect(Buffer.from(calls[0]?.init?.body as Uint8Array).toString()).toBe('{"a":1}')
  })

  it('额外请求头(设备 id / X-Forwarded-* / Range)一起送到后端;后端的 ETag/Range/Cache 头带回,别的头不带', async () => {
    const calls: { url: string, init?: RequestInit | undefined }[] = []
    const impl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 206,
        headers: new Headers({ 'content-type': 'application/zip', 'etag': '"sha"', 'content-range': 'bytes 0-3/10', 'accept-ranges': 'bytes', 'x-powered-by': 'nope', 'set-cookie': 'a=b' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      }
    }) as unknown as typeof fetch
    const service = createButlerService({ configFile: await configFile(), runCommand: recorder().runCommand, fetchImpl: impl })
    const res = await service.proxy({
      method: 'GET', path: '/api/avatars/a1/bundle.zip',
      headers: { 'x-workbench-device': 'dev_1', 'x-forwarded-host': '10.86.37.27:8791', 'x-forwarded-prefix': '/butler/proxy', 'range': 'bytes=0-3' },
    })
    const sent = calls[0]?.init?.headers as Record<string, string>
    expect(sent).toMatchObject({ 'x-workbench-token': TOKEN, 'x-workbench-device': 'dev_1', 'x-forwarded-host': '10.86.37.27:8791', 'x-forwarded-prefix': '/butler/proxy', 'range': 'bytes=0-3' })
    expect(res.status).toBe(206)
    expect(res.contentType).toBe('application/zip')
    expect(res.headers).toEqual({ 'etag': '"sha"', 'content-range': 'bytes 0-3/10', 'accept-ranges': 'bytes' })
    expect(Buffer.from(res.body)).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('后端没起 → 502 + 人话', async () => {
    const service = createButlerService({ configFile: await configFile(), runCommand: recorder().runCommand, fetchImpl: fakeFetch({ healthy: false }).impl })
    const res = await service.proxy({ method: 'GET', path: '/health' })
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body.toString())).toEqual({ error: '本机后端没在跑' })
  })
})

// ── HTTP 面 ────────────────────────────────────────────────────────────────
const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()!.close() })

function memoryButler(over: Partial<ButlerService> = {}): ButlerService & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    view: async () => ({ running: true, port: 8792, avatarCount: 2 }),
    adminUrl: async () => 'http://127.0.0.1:8792/admin/',
    start: async () => { calls.push('start'); return { ok: true } },
    stop: async () => { calls.push('stop'); return { ok: false, error: '本来就没在跑' } },
    open: async () => { calls.push('open'); return { ok: true } },
    proxy: async (req) => {
      calls.push(`proxy ${req.method} ${req.path}`)
      return { status: 201, contentType: 'application/json', body: Buffer.from(JSON.stringify({ echoed: req.body?.toString() ?? '' })) }
    },
    ...over,
  }
}

async function serve(over: { butler?: ButlerService, isLoopback?: () => boolean } = {}) {
  const service = createWorkbenchService()
  const server = await startWorkbenchServer({
    port: 0, service, tickIntervalMs: 0, heartbeatMs: 0,
    ...(over.butler === undefined ? {} : { butler: over.butler }),
    ...(over.isLoopback === undefined ? {} : { isLoopback: over.isLoopback }),
  })
  started.push(server)
  return server
}

describe('/state.butler', () => {
  it('接了就带 { running, port, avatarCount?, voiceCount? };没给的数字缺席', async () => {
    const server = await serve({ butler: memoryButler() })
    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.butler).toEqual({ running: true, port: 8792, avatarCount: 2 })
    expect(state.butler).not.toHaveProperty('voiceCount')
  })

  it('没接就整个字段缺席', async () => {
    const server = await serve()
    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.butler).toBeUndefined()
    expect((await fetch(`${server.url}/butler/status`)).status).toBe(404)
  })

  it('探测抛错不连累 /state', async () => {
    const server = await serve({ butler: memoryButler({ view: async () => { throw new Error('boom') } }) })
    const res = await fetch(`${server.url}/state`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as WorkbenchState).butler).toBeUndefined()
  })
})

describe('/butler/* 路由', () => {
  it('start/stop/open 只认回环,远端 403 且不执行', async () => {
    const butler = memoryButler()
    const server = await serve({ butler, isLoopback: () => false })
    for (const action of ['start', 'stop', 'open']) {
      const res = await fetch(`${server.url}/butler/${action}`, { method: 'POST' })
      expect(res.status, action).toBe(403)
    }
    expect(butler.calls).toEqual([])
  })

  it('本机 POST /butler/start 执行并回 {ok};失败时把服务端的话原样带回', async () => {
    const butler = memoryButler()
    const server = await serve({ butler })
    expect(await (await fetch(`${server.url}/butler/start`, { method: 'POST' })).json()).toEqual({ ok: true })
    expect(await (await fetch(`${server.url}/butler/stop`, { method: 'POST' })).json()).toEqual({ ok: false, error: '本来就没在跑' })
    expect(await (await fetch(`${server.url}/butler/open`, { method: 'POST' })).json()).toEqual({ ok: true })
    expect(butler.calls).toEqual(['start', 'stop', 'open'])
  })

  it('GET /butler/status 给当前状态', async () => {
    const server = await serve({ butler: memoryButler() })
    expect(await (await fetch(`${server.url}/butler/status`)).json()).toEqual({ running: true, port: 8792, avatarCount: 2 })
  })

  it('/butler/proxy/<path> 原样转发(含 query 与 body),回上游状态码与 body', async () => {
    const butler = memoryButler()
    const server = await serve({ butler })
    const res = await fetch(`${server.url}/butler/proxy/admin/tts-models?kind=tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}',
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ echoed: '{"name":"x"}' })
    expect(butler.calls).toEqual(['proxy POST /admin/tts-models?kind=tts'])
  })
})
