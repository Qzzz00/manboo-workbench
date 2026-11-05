// @vitest-environment node
/**
 * 各家 Agent 客户端的 **logo**(2026-09-26,卡 LG)。
 *
 * 维护者原话:「增加一个功能,就是现在电脑上有多少个 Agent 客户端,把对应的 logo 也搞上;
 * 桌面端的应用标签,也加各家的 logo icon」。
 *
 * 沿的是卡 Q 那条取图标主色的路:壳新增一个只读 op(`app_icon`,只碰 NSWorkspace、不碰辅助功能),
 * 插件把取到的那张图放在**内存**里(不进 agents.json,理由见 server/agentIcons.ts),
 * 界面按 `GET /agents/icon/<登记表 id>` 当一张 PNG 取;登记表条目多一格 `icon: true/false`。
 *
 * 这一份钉三件事:
 * 1. 取到了 → 那一格是真、接口回得出一张 PNG(带 ETag / Cache-Control,带 If-None-Match 回 304);
 * 2. 没取到(这台电脑上没装 / 壳回了一串不是 PNG 的东西)→ 那一格是假、接口 404,**不出错**;
 * 3. **壳是旧版**(没有 `app_icon` 这件本事)→ 一个请求都不发,一律退回色点。
 *
 * 壳与模型都是假的(tests/fixtures/agentWorld.ts)。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { ICON_MIN_GAP_MS } from '../src/server/agentDiscovery.ts'
import { ICON_MAX_BYTES, etagMatches, iconEtag, isPng, parseIconResponse } from '../src/server/agentIcons.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import type { FakeApp } from './fixtures/agentWorld.ts'
import { FAKE_ICON_PNG, chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

const CAPS_NEW = ['new_conversation', 'read_reply', 'agent_window', 'icon_color', 'app_icon']
const CAPS_OLD = ['new_conversation', 'read_reply', 'agent_window', 'icon_color']

const app = (over: Partial<FakeApp> & Pick<FakeApp, 'bundle_id' | 'name'>): FakeApp => ({
  running: true, category: 'public.app-category.productivity',
  probe: chatProbe(), read: () => chatRead({ answer: '好的' }), ...over,
})

function world(apps: FakeApp[], caps = CAPS_NEW) {
  let clock = new Date('2026-09-26T02:00:00Z')
  const shell = fakeShell(apps, { caps })
  const discovery = createAgentDiscovery({
    store: createMemoryRegistryStore(),
    helper: shell.helper,
    judge: fakeModel(Object.fromEntries(apps.map(one => [one.name, 'ai_agent' as const]))).judge,
    remainingCny: async () => 4,
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  /** 跑够几拍:接上、读颜色、取图标各要一拍,每一拍之间要过取图标那道最小间隔。 */
  const settle = async (times = 6): Promise<void> => {
    for (let i = 0; i < times; i += 1) {
      await discovery.tick()
      clock = new Date(clock.getTime() + ICON_MIN_GAP_MS)
    }
  }
  return { discovery, shell, settle, advance: (ms: number) => { clock = new Date(clock.getTime() + ms) } }
}

describe('纯函数:壳回的那一份 → 一张能发给界面的 PNG', () => {
  it('是不是 PNG:头八个字节说了算(不把一串来历不明的东西当图片发出去)', () => {
    const png = new Uint8Array(Buffer.from(FAKE_ICON_PNG, 'base64'))
    expect(isPng(png)).toBe(true)
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]))).toBe(false)
    expect(isPng(new Uint8Array(0))).toBe(false)
  })

  it('★壳说没取到 / 回了坏东西 / 回了一张太大的:一律当没取到(界面退回色点,不报错)', () => {
    const at = '2026-09-26T02:00:00Z'
    expect(parseIconResponse({ found: false, why: '这台电脑上没装这个应用' }, at)).toBeUndefined()
    expect(parseIconResponse({}, at)).toBeUndefined()
    expect(parseIconResponse({ png: 123 }, at)).toBeUndefined()
    expect(parseIconResponse({ png: '' }, at)).toBeUndefined()
    // 能解出字节、但不是 PNG。
    expect(parseIconResponse({ png: Buffer.from('这不是一张 PNG').toString('base64') }, at)).toBeUndefined()
    // 太大的(超过上限)也不要。
    const huge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(ICON_MAX_BYTES + 1)])
    expect(parseIconResponse({ png: huge.toString('base64') }, at)).toBeUndefined()
    // 真的那一张认得出来。
    const ok = parseIconResponse({ found: true, png: FAKE_ICON_PNG }, at)
    expect(ok?.png.length).toBeGreaterThan(8)
    expect(ok?.at).toBe(at)
  })

  it('ETag:内容一样就一样,内容变了才变;If-None-Match 认 W/ 前缀与多个值', () => {
    const a = new Uint8Array(Buffer.from(FAKE_ICON_PNG, 'base64'))
    const b = new Uint8Array(Buffer.from(FAKE_ICON_PNG, 'base64'))
    expect(iconEtag(a)).toBe(iconEtag(b))
    expect(iconEtag(a)).not.toBe(iconEtag(new Uint8Array([...a, 1])))
    const tag = iconEtag(a)
    expect(etagMatches(tag, tag)).toBe(true)
    expect(etagMatches(`W/${tag}`, tag)).toBe(true)
    expect(etagMatches(`"other", ${tag}`, tag)).toBe(true)
    expect(etagMatches('*', tag)).toBe(true)
    expect(etagMatches('"other"', tag)).toBe(false)
    expect(etagMatches(undefined, tag)).toBe(false)
    expect(etagMatches('', tag)).toBe(false)
  })
})

describe('登记表那一格 icon:取到了没', () => {
  it('★运行时接上的一家,壳给得出图标 → icon 是真;给不出的那一家是假(界面退回色点)', async () => {
    const w = world([
      app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: true }),
      app({ bundle_id: 'com.example.plain', name: 'Plain AI' }),
    ])
    await w.settle()
    const entries = w.discovery.view().entries
    expect(entries.find(one => one.id === 'com.example.fooai')?.icon).toBe(true)
    expect(entries.find(one => one.id === 'com.example.plain')?.icon).toBe(false)
    // 图片本身**不在**快照里(一张十几 KB,每秒一拍的快照塞不下)。
    expect(JSON.stringify(w.discovery.view())).not.toContain(FAKE_ICON_PNG.slice(0, 24))
  })

  it('★壳是旧版(没有 app_icon 这件本事):一个请求都不发,每一家都是假', async () => {
    const w = world([app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: true })], CAPS_OLD)
    await w.settle()
    expect(w.shell.calls.some(one => one.op === 'app_icon')).toBe(false)
    expect(w.discovery.view().entries.every(one => one.icon === false)).toBe(true)
    expect(w.discovery.icon('com.example.fooai')).toBeUndefined()
  })

  it('壳回了一串不是 PNG 的东西:当没取到(icon 是假),不抛、不把它发出去', async () => {
    const w = world([app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: 'bad' })])
    await w.settle()
    expect(w.shell.calls.some(one => one.op === 'app_icon' && one.bundle_id === 'com.example.fooai')).toBe(true)
    expect(w.discovery.view().entries.find(one => one.id === 'com.example.fooai')?.icon).toBe(false)
    expect(w.discovery.icon('com.example.fooai')).toBeUndefined()
  })

  it('取过的不再取(七天内);只问登记表里那几家,不问随手传来的一个包', async () => {
    const w = world([app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: true })])
    await w.settle()
    const asked = w.shell.calls.filter(one => one.op === 'app_icon').length
    expect(asked).toBeGreaterThan(0)
    await w.settle()
    expect(w.shell.calls.filter(one => one.op === 'app_icon')).toHaveLength(asked)
    // 问过的每一个包,要么是登记表里接上了的,要么是工作台自己 / 有专门读法的那几家 —— 不会是随手一个。
    const askedBundles = w.shell.calls.filter(one => one.op === 'app_icon').map(one => (one as { bundle_id: string }).bundle_id)
    expect(askedBundles).toContain('com.example.fooai')
    expect(askedBundles).toContain('ai.ben.workbench')
    expect(askedBundles).not.toContain('com.example.chatter')
    // 不在登记表里的 id 问不出图(接口那一侧就是 404)。
    expect(w.discovery.icon('com.example.chatter')).toBeUndefined()
    expect(w.discovery.icon('')).toBeUndefined()
  })

  it('他说「这不是 Agent」之后,那一家的图也拿不到了(它已经不在登记表里)', async () => {
    const w = world([app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: true })])
    await w.settle()
    expect(w.discovery.icon('com.example.fooai')).toBeDefined()
    await w.discovery.notAgent('com.example.fooai')
    expect(w.discovery.icon('com.example.fooai')).toBeUndefined()
  })
})

describe('GET /agents/icon/:id', () => {
  async function serve(apps: FakeApp[], caps = CAPS_NEW) {
    const w = world(apps, caps)
    const service = createWorkbenchService({})
    const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0, heartbeatMs: 0, agents: w.discovery })
    started.push(server)
    await w.settle()
    return { ...w, url: server.url }
  }

  it('★取到了:回一张真 PNG,带 ETag 与 Cache-Control;快照里那一格也是真', async () => {
    const { url, discovery } = await serve([app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: true })])
    const res = await fetch(`${url}/agents/icon/com.example.fooai`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('must-revalidate')
    const etag = res.headers.get('etag')
    expect(etag).toBeTruthy()
    const body = new Uint8Array(await res.arrayBuffer())
    expect(isPng(body)).toBe(true)
    expect(res.headers.get('content-length')).toBe(String(body.length))
    // 界面那一格与接口说的是同一件事。
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.agent_registry?.entries.find(one => one.id === 'com.example.fooai')?.icon).toBe(true)
    expect(discovery.icon('com.example.fooai')?.etag).toBe(etag)
  })

  it('★带 If-None-Match 回来:304,不再传那十几 KB', async () => {
    const { url } = await serve([app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: true })])
    const first = await fetch(`${url}/agents/icon/com.example.fooai`)
    const etag = first.headers.get('etag') as string
    await first.arrayBuffer()
    const again = await fetch(`${url}/agents/icon/com.example.fooai`, { headers: { 'if-none-match': etag } })
    expect(again.status).toBe(304)
    expect(again.headers.get('etag')).toBe(etag)
    expect(new Uint8Array(await again.arrayBuffer())).toHaveLength(0)
  })

  it('★没取到 / 不在登记表里 / 壳是旧版:一律 404 说人话(界面 onError 退回色点,不空白)', async () => {
    const { url } = await serve([
      app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: true }),
      app({ bundle_id: 'com.example.plain', name: 'Plain AI' }),
    ])
    for (const path of ['/agents/icon/com.example.plain', '/agents/icon/com.example.nobody', '/agents/icon/']) {
      const res = await fetch(`${url}${path}`)
      expect(res.status).toBe(404)
      expect(typeof (await res.json() as { error?: unknown }).error).toBe('string')
    }
    const old = await serve([app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: true })], CAPS_OLD)
    expect((await fetch(`${old.url}/agents/icon/com.example.fooai`)).status).toBe(404)
  })

  it('登记表没启用(老装法):404「登记表未启用」,与 /agents 那几条同一句', async () => {
    const service = createWorkbenchService({})
    const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0, heartbeatMs: 0 })
    started.push(server)
    const res = await fetch(`${server.url}/agents/icon/com.example.fooai`)
    expect(res.status).toBe(404)
    expect((await res.json() as { error?: string }).error).toBe('登记表未启用')
  })

  /**
   * **图标清单**(2026-09-26,卡 LG3:手机客户端上也要显示各家的 logo)。
   * 手机取图要带设备令牌,`<img>` 设不了请求头 —— 拿不到浏览器那套自动的 304。
   * 所以它先问这一份清单(一份小 JSON):etag 没变的那几张一个图片请求都不发。
   */
  describe('GET /agents/icons(手机先问这一份,再决定哪几张要重取)', () => {
    it('★只列真取到了图的那几家,每一行是 id + etag + 多大;etag 与那一张的响应头逐字相同', async () => {
      const { url } = await serve([
        app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: true }),
        app({ bundle_id: 'com.example.plain', name: 'Plain AI' }),
      ])
      const res = await fetch(`${url}/agents/icons`)
      expect(res.status).toBe(200)
      const body = await res.json() as { icons: { id: string, etag: string, bytes: number }[] }
      // 没取到图的那一家**不在清单里** —— 手机据此知道「这一家就是没有图」,不再为它发请求。
      expect(body.icons.map(one => one.id)).not.toContain('com.example.plain')
      const row = body.icons.find(one => one.id === 'com.example.fooai')
      expect(row).toBeDefined()
      expect(row?.bytes).toBeGreaterThan(0)
      const one = await fetch(`${url}/agents/icon/com.example.fooai`)
      expect(row?.etag).toBe(one.headers.get('etag'))
      expect(row?.bytes).toBe(Number(one.headers.get('content-length')))
    })

    it('壳是旧版(没有 app_icon)/ 他说过「这不是 Agent」:清单是空的,不是出错', async () => {
      const old = await serve([app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: true })], CAPS_OLD)
      expect((await (await fetch(`${old.url}/agents/icons`)).json() as { icons: unknown[] }).icons).toEqual([])
      const now = await serve([app({ bundle_id: 'com.example.fooai', name: 'Foo AI', logo: true })])
      await now.discovery.notAgent('com.example.fooai')
      expect((await (await fetch(`${now.url}/agents/icons`)).json() as { icons: unknown[] }).icons).toEqual([])
    })

    it('登记表没启用(老装法):404「登记表未启用」,与 /agents/icon/:id 同一句', async () => {
      const service = createWorkbenchService({})
      const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0, heartbeatMs: 0 })
      started.push(server)
      const res = await fetch(`${server.url}/agents/icons`)
      expect(res.status).toBe(404)
      expect((await res.json() as { error?: string }).error).toBe('登记表未启用')
    })
  })
})

/**
 * 2026-09-26 深夜(统筹真壳自核):每装一次插件(用户那边就是每一次热更新),图标只在内存里、全得重取;
 * 一拍 3 张、两拍隔一分钟,维护者这台九家要三分钟才长齐,坞上 Kimi / Muse / Manus / Grok Bot /
 * Antigravity / 豆包办公那几格这三分钟里都是一颗小色点 —— 看着就像「logo 又没了」。
 * 一拍要能把一台电脑上常见的那十来家一次取完(一张十几 KB,十二张也就两百来 KB)。
 */
describe('重启之后图标一拍取齐', () => {
  it('一拍能取的张数够一台电脑上常见的十来家', async () => {
    const { ICON_PER_TICK } = await import('../src/server/agentIcons.ts')
    expect(ICON_PER_TICK).toBeGreaterThanOrEqual(12)
  })
})
