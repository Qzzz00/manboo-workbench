/**
 * 外观首次播种(2026-09-16,交接-0916-外观首次播种):
 * - 服务端 404「还没有保存过外观」+ 本地 localStorage 有合法 preset → 立刻 PUT 一次且只一次(带 icon 与自定义 SVG),
 *   成功后本地记 seededVersion;
 * - 404 + 本地没存过(store 里只是默认值)→ 不 PUT,不拿编出来的默认值去占服务端;
 * - 服务端有、本地也有且不同 → 以服务端为准覆盖本地,并在外观设置里给一次「已改用 Mac 上保存的外观(版本 n)」;
 * - /state.appearance_version 变了 → 重新拉;
 * - 「选中图标」随 preset 一起 PUT / 拉(icon 字段)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppearanceSync, SEEDED_STORAGE_KEY } from '../src/client/appearanceSync.ts'
import { createParticleSettingsStore, ICON_STORAGE_KEY } from '../src/client/particleSettingsStore.ts'
import { BuiltinGlyphCache, TUNING_DEFAULTS, TUNING_STORAGE_KEY } from '../src/client/swarm/core.js'

interface Call { method: string, url: string, body?: unknown }
interface Doc { version: number, preset: unknown, icon?: string, updated_at: string }

function fakeServer(initial?: { version: number, preset: unknown, icon?: string }) {
  const calls: Call[] = []
  let doc: Doc | undefined = initial === undefined ? undefined : { ...initial, updated_at: 't' }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ method, url: String(input), ...(body === undefined ? {} : { body }) })
    if (method === 'GET') {
      return doc === undefined
        ? new Response(JSON.stringify({ error: '还没有保存过外观' }), { status: 404 })
        : new Response(JSON.stringify(doc), { status: 200 })
    }
    const icon = body?.icon
    doc = { version: (doc?.version ?? 0) + 1, preset: body?.preset, updated_at: 't', ...(typeof icon === 'string' ? { icon } : {}) }
    return new Response(JSON.stringify({ ok: true, version: doc.version, updated_at: 't' }), { status: 200 })
  }) as typeof fetch
  return { calls, fetchImpl, current: () => doc, puts: () => calls.filter(c => c.method === 'PUT'), gets: () => calls.filter(c => c.method === 'GET') }
}

function memoryStorage() {
  const map = new Map<string, string>()
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, map }
}

const preset = (count: number, extra: Partial<{ svg: string, fill: boolean }> = {}) =>
  ({ kind: 'butler-swarm-v4', version: 1, settings: { ...TUNING_DEFAULTS, count }, svg: '', fill: false, ...extra })
const base = 'http://127.0.0.1:8791'
const url = `${base}/butler/appearance`

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('首次播种:404 + 本地有合法 preset', () => {
  it('立刻 PUT 一次,带图标与自定义 SVG;成功后记 seededVersion', async () => {
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(6800, { svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>', fill: true })))
    storage.setItem(ICON_STORAGE_KEY, 'mood-smile')
    const store = createParticleSettingsStore(storage)
    const server = fakeServer()
    const sync = createAppearanceSync({ store, baseUrl: base, fetchImpl: server.fetchImpl, storage })
    await sync.start()
    expect(server.calls.map(c => c.method)).toEqual(['GET', 'PUT'])
    const put = server.puts()[0]!
    expect(put.url).toBe(url)
    expect(put.body).toMatchObject({ preset: { settings: { count: 6800 }, fill: true }, icon: 'mood-smile' })
    expect((put.body as { preset: { svg: string } }).preset.svg).toContain('<svg')
    expect(server.current()).toMatchObject({ version: 1, icon: 'mood-smile' })
    expect(storage.getItem(SEEDED_STORAGE_KEY)).toBe('1')
    expect(sync.version()).toBe(1)
    // 播种不算「改用服务端的」,不提示。
    expect(store.getSnapshot().message).toBe('')
    sync.stop()
  })

  it('只推一次:同一会话里再来一次 404(版本通知触发重新拉)也不重复 PUT', async () => {
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(6800)))
    const store = createParticleSettingsStore(storage)
    const server = fakeServer()
    const sync = createAppearanceSync({ store, baseUrl: base, fetchImpl: server.fetchImpl, storage })
    await sync.start()
    expect(server.puts()).toHaveLength(1)
    // 服务端文件被人清掉、版本号变了、GET 又是 404:同一份本地配置不再推第二遍。
    const again = fakeServer()
    const wrapped = createAppearanceSync({ store, baseUrl: base, fetchImpl: again.fetchImpl, storage })
    await wrapped.start()
    expect(again.puts()).toHaveLength(1) // 新会话(比如刷新页面)会再播:服务端确实什么都没有,本地就是真相
    // 同一实例上:
    let gone = true
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && gone) return new Response(JSON.stringify({ error: '还没有保存过外观' }), { status: 404 })
      return server.fetchImpl(input, init)
    }) as typeof fetch
    const one = createAppearanceSync({ store, baseUrl: base, fetchImpl: flaky, storage })
    const before = server.puts().length
    await one.start() // 404 → 播一次
    expect(server.puts()).toHaveLength(before + 1)
    one.notice(99) // 别处版本变了 → 重新拉 → 还是 404 → 不再推同一份
    await vi.advanceTimersByTimeAsync(2000)
    expect(server.puts()).toHaveLength(before + 1)
    gone = false
    sync.stop(); wrapped.stop(); one.stop()
  })

  it('本地又调过参(与上次播种的不一样)→ 404 时会再播一次', async () => {
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(6800)))
    storage.setItem(SEEDED_STORAGE_KEY, '1')
    const store = createParticleSettingsStore(storage)
    const server = fakeServer()
    const sync = createAppearanceSync({ store, baseUrl: base, fetchImpl: server.fetchImpl, storage })
    await sync.start()
    // seededVersion 是上次的,但服务端现在什么都没有、本地这份也没推过 → 推。
    expect(server.puts()).toHaveLength(1)
    sync.stop()
  })
})

describe('404 + 本地没存过', () => {
  it('不 PUT:默认值不占服务端,手机照旧用核心默认', async () => {
    const storage = memoryStorage()
    const store = createParticleSettingsStore(storage)
    expect(store.getSnapshot().stored).toBe(false)
    const server = fakeServer()
    const sync = createAppearanceSync({ store, baseUrl: base, fetchImpl: server.fetchImpl, storage })
    await sync.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(server.calls.map(c => c.method)).toEqual(['GET'])
    expect(storage.getItem(SEEDED_STORAGE_KEY)).toBeNull()
    // 之后第一次拖滑杆:落本地即成「有」,防抖后正常 PUT。
    store.setField('count', 1800)
    expect(store.getSnapshot().stored).toBe(true)
    await vi.advanceTimersByTimeAsync(1100)
    expect(server.puts()).toHaveLength(1)
    expect(server.puts()[0]!.body).toMatchObject({ preset: { settings: { count: 1800 } } })
    sync.stop()
  })

  it('404 是「外观同步未接线」(服务端没接这一块):本地有也不推,推了也是 404', async () => {
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(6800)))
    const store = createParticleSettingsStore(storage)
    const calls: string[] = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? 'GET')
      return new Response(JSON.stringify({ error: '外观同步未接线' }), { status: 404 })
    }) as typeof fetch
    const sync = createAppearanceSync({ store, baseUrl: base, fetchImpl, storage })
    await sync.start()
    expect(calls).toEqual(['GET'])
    sync.stop()
  })

  it('本地那份坏了(normalizeTuning/parse 不过)也不 PUT', async () => {
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, '{"kind":"other"}')
    const store = createParticleSettingsStore(storage)
    expect(store.getSnapshot().stored).toBe(false)
    const server = fakeServer()
    const sync = createAppearanceSync({ store, baseUrl: base, fetchImpl: server.fetchImpl, storage })
    await sync.start()
    expect(server.calls.map(c => c.method)).toEqual(['GET'])
    sync.stop()
  })
})

describe('服务端有', () => {
  it('本地也有且不同:以服务端为准覆盖本地,外观设置里提示一次「已改用 Mac 上保存的外观(版本 n)」', async () => {
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(1800)))
    const store = createParticleSettingsStore(storage)
    const server = fakeServer({ version: 4, preset: preset(6800) })
    const sync = createAppearanceSync({ store, baseUrl: base, fetchImpl: server.fetchImpl, storage })
    await sync.start()
    expect(store.getSnapshot().preset.settings.count).toBe(6800)
    expect(JSON.parse(storage.getItem(TUNING_STORAGE_KEY)!)).toMatchObject({ settings: { count: 6800 } })
    expect(store.getSnapshot().message).toBe('已改用 Mac 上保存的外观(版本 4)')
    expect(store.getSnapshot().error).toBe('')
    // 不会把拉回来的推回去。
    await vi.advanceTimersByTimeAsync(2000)
    expect(server.puts()).toHaveLength(0)
    sync.stop()
  })

  it('本地与服务端一样:不提示', async () => {
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(6800)))
    const store = createParticleSettingsStore(storage)
    const server = fakeServer({ version: 2, preset: preset(6800) })
    const sync = createAppearanceSync({ store, baseUrl: base, fetchImpl: server.fetchImpl, storage })
    await sync.start()
    expect(store.getSnapshot().message).toBe('')
    sync.stop()
  })

  it('本地没存过、服务端有:直接用服务端的,不提示(没有「改用」可言)', async () => {
    const storage = memoryStorage()
    const store = createParticleSettingsStore(storage)
    const server = fakeServer({ version: 2, preset: preset(6800) })
    const sync = createAppearanceSync({ store, baseUrl: base, fetchImpl: server.fetchImpl, storage })
    await sync.start()
    expect(store.getSnapshot().preset.settings.count).toBe(6800)
    expect(store.getSnapshot().stored).toBe(true)
    expect(store.getSnapshot().message).toBe('')
    sync.stop()
  })

  it('/state.appearance_version 变了(别处改的)→ 重新拉、覆盖本地、再提示一次;自己推上去的版本不拉', async () => {
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(6800)))
    const store = createParticleSettingsStore(storage)
    const server = fakeServer({ version: 2, preset: preset(6800) })
    const sync = createAppearanceSync({ store, baseUrl: base, fetchImpl: server.fetchImpl, storage })
    await sync.start()
    expect(server.gets()).toHaveLength(1)
    // 同版本、undefined:不拉。
    sync.notice(2); sync.notice(undefined)
    await vi.advanceTimersByTimeAsync(10)
    expect(server.gets()).toHaveLength(1)
    // 别处改了(比如另一个浏览器窗口):版本 3 → 拉,覆盖本地,提示。
    await server.fetchImpl(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: preset(500) }) })
    sync.notice(3)
    await vi.advanceTimersByTimeAsync(10)
    expect(server.gets()).toHaveLength(2)
    expect(store.getSnapshot().preset.settings.count).toBe(500)
    expect(store.getSnapshot().message).toBe('已改用 Mac 上保存的外观(版本 3)')
    // 自己调参推上去的版本 4:不再拉。
    store.setField('count', 900)
    await vi.advanceTimersByTimeAsync(1100)
    expect(sync.version()).toBe(4)
    sync.notice(4)
    await vi.advanceTimersByTimeAsync(10)
    expect(server.gets()).toHaveLength(2)
    sync.stop()
  })
})

describe('选中图标 icon 往返', () => {
  it('选了图标 → 本地记下并随 preset PUT;拉到服务端的 icon → 写进 store 与本地', async () => {
    vi.spyOn(BuiltinGlyphCache.prototype, 'get').mockResolvedValue({ glyph: new Float32Array([0, 1]), svg: '<svg/>', warnings: [] })
    const storage = memoryStorage()
    storage.setItem(TUNING_STORAGE_KEY, JSON.stringify(preset(6800)))
    const store = createParticleSettingsStore(storage)
    const server = fakeServer({ version: 1, preset: preset(6800) })
    const sync = createAppearanceSync({ store, baseUrl: base, fetchImpl: server.fetchImpl, storage })
    await sync.start()
    expect(store.getSnapshot().icon).toBeUndefined()
    await store.selectIcon('mood-smile')
    expect(store.getSnapshot().icon).toBe('mood-smile')
    expect(storage.getItem(ICON_STORAGE_KEY)).toBe('mood-smile')
    await vi.advanceTimersByTimeAsync(1100)
    expect(server.puts()).toHaveLength(1)
    expect(server.puts()[0]!.body).toEqual({ preset: preset(6800), icon: 'mood-smile' })
    expect(server.current()).toMatchObject({ version: 2, icon: 'mood-smile' })
    sync.stop()

    // 另一台/另一窗口拉:icon 跟着回来。
    const storage2 = memoryStorage()
    const store2 = createParticleSettingsStore(storage2)
    const sync2 = createAppearanceSync({ store: store2, baseUrl: base, fetchImpl: server.fetchImpl, storage: storage2 })
    await sync2.start()
    expect(store2.getSnapshot().icon).toBe('mood-smile')
    expect(storage2.getItem(ICON_STORAGE_KEY)).toBe('mood-smile')
    // 拉回来的 icon 不会再被推回去。
    await vi.advanceTimersByTimeAsync(2000)
    expect(server.puts()).toHaveLength(1)
    sync2.stop()
  })

  it('图标加载失败不记为选中', async () => {
    vi.spyOn(BuiltinGlyphCache.prototype, 'get').mockRejectedValue(new Error('没有这个图标'))
    const storage = memoryStorage()
    const store = createParticleSettingsStore(storage)
    await store.selectIcon('nope')
    expect(store.getSnapshot().icon).toBeUndefined()
    expect(storage.getItem(ICON_STORAGE_KEY)).toBeNull()
  })
})
