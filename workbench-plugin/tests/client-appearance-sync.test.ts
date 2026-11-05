/**
 * Mac 端外观同步(2026-09-16):启动先拉服务端,有则以服务端为准并覆盖本地 localStorage;
 * 调参落本地的同时 PUT 到服务端(防抖 1 秒);服务端拉不到就照旧用本地,不报错;
 * /state.appearance_version 变了就重新拉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppearanceSync } from '../src/client/appearanceSync.ts'
import { createParticleSettingsStore } from '../src/client/particleSettingsStore.ts'
import { TUNING_DEFAULTS, TUNING_STORAGE_KEY } from '../src/client/swarm/core.js'

interface Call { method: string, url: string, body?: unknown }

function fakeServer(initial?: { version: number, preset: unknown }, options: { fail?: boolean } = {}) {
  const calls: Call[] = []
  let doc = initial === undefined ? undefined : { ...initial, updated_at: 't' }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    calls.push({ method, url, ...(body === undefined ? {} : { body }) })
    if (options.fail) throw new TypeError('network down')
    if (method === 'GET') {
      return doc === undefined
        ? new Response(JSON.stringify({ error: '还没有保存过外观' }), { status: 404 })
        : new Response(JSON.stringify(doc), { status: 200 })
    }
    const next = { version: (doc?.version ?? 0) + 1, preset: (body as { preset: unknown }).preset, updated_at: 't' }
    doc = next
    return new Response(JSON.stringify({ ok: true, version: next.version }), { status: 200 })
  }) as typeof fetch
  return { calls, fetchImpl, current: () => doc }
}

function memoryStorage() {
  const map = new Map<string, string>()
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, map }
}

const preset = (count: number) => ({ kind: 'butler-swarm-v4', version: 1, settings: { ...TUNING_DEFAULTS, count }, svg: '', fill: false })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createAppearanceSync', () => {
  it('服务端有配置:以它为准,覆盖本地 localStorage 与 store', async () => {
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(1800)))
    const store = createParticleSettingsStore(storage)
    expect(store.getSnapshot().preset.settings.count).toBe(1800)
    const server = fakeServer({ version: 3, preset: preset(6800) })
    const sync = createAppearanceSync({ store, baseUrl: 'http://127.0.0.1:8791', fetchImpl: server.fetchImpl, storage })
    await sync.start()
    expect(store.getSnapshot().preset.settings.count).toBe(6800)
    expect(JSON.parse(storage.getItem(TUNING_STORAGE_KEY)!)).toMatchObject({ settings: { count: 6800 } })
    expect(server.calls).toEqual([{ method: 'GET', url: 'http://127.0.0.1:8791/butler/appearance' }])
    // 拉回来的那份不会再被推回去。
    await vi.advanceTimersByTimeAsync(2000)
    expect(server.calls).toHaveLength(1)
    sync.stop()
  })

  it('服务端没存过(404):把本地这份立刻推上去,手机才有得继承', async () => {
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(1800)))
    const store = createParticleSettingsStore(storage)
    const server = fakeServer()
    const sync = createAppearanceSync({ store, baseUrl: 'http://127.0.0.1:8791', fetchImpl: server.fetchImpl, storage })
    await sync.start()
    expect(server.calls.map(c => c.method)).toEqual(['GET', 'PUT'])
    expect(server.calls[1]!.body).toEqual({ preset: preset(1800) })
    expect(server.current()).toMatchObject({ version: 1 })
    sync.stop()
  })

  it('调参:落本地的同时 PUT,连着改只发一次(防抖 1 秒)', async () => {
    const storage = memoryStorage()
    const store = createParticleSettingsStore(storage)
    const server = fakeServer({ version: 1, preset: preset(3600) })
    const sync = createAppearanceSync({ store, baseUrl: 'http://127.0.0.1:8791', fetchImpl: server.fetchImpl, storage })
    await sync.start()
    store.setField('count', 1800)
    store.setField('count', 2400)
    store.setField('particleSize', 1.5)
    expect(JSON.parse(storage.getItem(TUNING_STORAGE_KEY)!)).toMatchObject({ settings: { count: 2400, particleSize: 1.5 } })
    await vi.advanceTimersByTimeAsync(900)
    expect(server.calls.filter(c => c.method === 'PUT')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    const puts = server.calls.filter(c => c.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0]!.body).toMatchObject({ preset: { settings: { count: 2400, particleSize: 1.5 } } })
    expect(sync.version()).toBe(2)
    // 自己推上去的版本不会触发重新拉。
    sync.notice(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(server.calls.filter(c => c.method === 'GET')).toHaveLength(1)
    sync.stop()
  })

  it('/state.appearance_version 变了(别处改的)就重新拉并覆盖本地', async () => {
    const storage = memoryStorage()
    const store = createParticleSettingsStore(storage)
    const server = fakeServer({ version: 1, preset: preset(3600) })
    const sync = createAppearanceSync({ store, baseUrl: 'http://127.0.0.1:8791', fetchImpl: server.fetchImpl, storage })
    await sync.start()
    // 模拟另一处 PUT 了新版本。
    await server.fetchImpl('http://127.0.0.1:8791/butler/appearance', { method: 'PUT', body: JSON.stringify({ preset: preset(500) }) })
    sync.notice(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(store.getSnapshot().preset.settings.count).toBe(500)
    expect(JSON.parse(storage.getItem(TUNING_STORAGE_KEY)!)).toMatchObject({ settings: { count: 500 } })
    sync.stop()
  })

  it('服务端拉不到:照旧用本地,不报错,之后调参也只在本地', async () => {
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(1800)))
    const store = createParticleSettingsStore(storage)
    const server = fakeServer(undefined, { fail: true })
    const sync = createAppearanceSync({ store, baseUrl: 'http://127.0.0.1:8791', fetchImpl: server.fetchImpl, storage })
    await expect(sync.start()).resolves.toBeUndefined()
    expect(store.getSnapshot().preset.settings.count).toBe(1800)
    expect(store.getSnapshot().error).toBe('')
    store.setField('count', 900)
    await vi.advanceTimersByTimeAsync(1500)
    expect(store.getSnapshot().error).toBe('')
    expect(JSON.parse(storage.getItem(TUNING_STORAGE_KEY)!)).toMatchObject({ settings: { count: 900 } })
    sync.stop()
  })

  it('stop 之后不再推也不再拉', async () => {
    const storage = memoryStorage()
    const store = createParticleSettingsStore(storage)
    const server = fakeServer({ version: 1, preset: preset(3600) })
    const sync = createAppearanceSync({ store, baseUrl: 'http://127.0.0.1:8791', fetchImpl: server.fetchImpl, storage })
    await sync.start()
    sync.stop()
    store.setField('count', 700)
    sync.notice(9)
    await vi.advanceTimersByTimeAsync(2000)
    expect(server.calls).toHaveLength(1)
  })
})
