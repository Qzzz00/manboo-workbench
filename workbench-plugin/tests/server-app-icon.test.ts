// @vitest-environment node
/**
 * 坞上**每一格**的图标(2026-09-26,卡 LG2)。
 *
 * 维护者 18:05 看着坞:「做事做一半,现在只有 Agent 有 logo,你看着怪不怪」。
 * 卡 LG 只给登记表里的家取了图(`/agents/icon/:id` 只认登记表),可坞上一多半不是 Agent:
 * 微信、企业微信、Notion、终端、Finder、Pen —— 它们在登记表里判过了是 `not_agent`,
 * 那条路一辈子也给不了它们一张图。
 *
 * 这一份钉的就是新那条 `GET /apps/icon/<坞项的键>`:
 * 1. **不是 Agent 的家照样有图**(这张卡的核心:微信、终端、Finder 各取一张真 PNG);
 * 2. 键→包标识**只在服务端换算**,认不出那一格 = 404 + 一句人话;
 *    像路径的键(`../../etc`)压根走不到查表那一步;
 * 3. 取图与缓存与登记表那条**同一份**:Claude 那种「既在登记表里、又在坞上」的家只问壳一次;
 *    坞上十几格同时要图,同一个包也只问壳一次;
 * 4. 没装 / 壳是旧版 / 壳没接上 → 404(**不出错**),界面画中性小方块;
 * 5. 登记表那条 `/agents/icon/:id` 一字没变(不回归)。
 *
 * 壳与模型都是假的(tests/fixtures/agentWorld.ts),一扇真窗口都不碰。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentDiscovery, ICON_MIN_GAP_MS } from '../src/server/agentDiscovery.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import { isDockKey, resolveDockApp } from '../src/server/appIcons.ts'
import { createAppsRegistry } from '../src/server/appsRegistry.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import type { FakeApp } from './fixtures/agentWorld.ts'
import { chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

const CAPS_NEW = ['new_conversation', 'read_reply', 'agent_window', 'icon_color', 'app_icon']
const CAPS_OLD = ['new_conversation', 'read_reply', 'agent_window', 'icon_color']

/** 一台假 Mac 上的一个 App。`chat` 为真 = 它的窗看着像对话窗(会被判成 Agent)。 */
function app(over: Partial<FakeApp> & Pick<FakeApp, 'bundle_id' | 'name'> & { chat?: boolean }): FakeApp {
  const { chat = false, ...rest } = over
  return {
    running: true,
    category: 'public.app-category.productivity',
    ...(chat ? { probe: chatProbe(), read: () => chatRead({ answer: '好的' }) } : { probe: { windows: 1, inputs: [], send: [], lists: [], texts: { total: 3 } } }),
    ...rest,
  }
}

async function tmpAppsFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'app-icon-')), 'apps.json')
}

/**
 * 这台假 Mac 上的坞:Claude(是 Agent)+ 微信 / 终端 / Finder / Pen(都不是 Agent)。
 * 微信、终端是**基础键**(`APP_BUNDLES` 里写着);Finder、Pen 是自定义应用(apps.json 里登记的)。
 */
const WORLD: FakeApp[] = [
  app({ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', chat: true, logo: true }),
  app({ bundle_id: 'com.tencent.xinWeChat', name: '微信', logo: true }),
  app({ bundle_id: 'com.apple.Terminal', name: 'Terminal', logo: true }),
  app({ bundle_id: 'com.apple.finder', name: 'Finder', logo: true }),
  app({ bundle_id: 'dev.pencil.desktop', name: 'Pen', logo: true }),
  // 登记过、可这台电脑上没装(壳如实说「没装」)。
  app({ bundle_id: 'com.example.gone', name: 'Gone', installed: false }),
]

async function world(apps: FakeApp[] = WORLD, caps = CAPS_NEW) {
  let clock = new Date('2026-09-26T10:05:00Z')
  const shell = fakeShell(apps, { caps })
  const discovery = createAgentDiscovery({
    store: createMemoryRegistryStore(),
    helper: shell.helper,
    // 只有窗看着像对话窗的那几家才会被问模型;这里一律判成 Agent(不是 Agent 的那几家压根到不了模型)。
    judge: fakeModel(Object.fromEntries(apps.map(one => [one.name, 'ai_agent' as const]))).judge,
    remainingCny: async () => 4,
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  const registry = createAppsRegistry({
    file: await tmpAppsFile(),
    runOsascript: async (cmd) => {
      const name = /id of app "(.+)"/.exec(cmd[2] ?? '')?.[1]
      const found = apps.find(one => one.name === name)
      return found === undefined ? { ok: false, stdout: '' } : { ok: true, stdout: `${found.bundle_id}\n` }
    },
  })
  // Finder / Pen:自定义应用(坞上那两格的键就是这么来的)。
  const finder = await registry.add('Finder')
  const pen = await registry.add('Pen')
  const settle = async (times = 6): Promise<void> => {
    for (let i = 0; i < times; i += 1) {
      await discovery.tick()
      clock = new Date(clock.getTime() + ICON_MIN_GAP_MS)
    }
  }
  return { discovery, registry, shell, settle, keys: { finder: finder.key!, pen: pen.key! } }
}

async function serve(apps: FakeApp[] = WORLD, caps = CAPS_NEW) {
  const w = await world(apps, caps)
  const service = createWorkbenchService({})
  const server = await startWorkbenchServer({
    port: 0, service, tickIntervalMs: 0, heartbeatMs: 0, agents: w.discovery, registry: w.registry,
  })
  started.push(server)
  await w.settle()
  return { ...w, url: server.url }
}

/** 问壳要过几次这个包的图标。 */
function askedFor(shell: { calls: readonly Record<string, unknown>[] }, bundleId: string): number {
  return shell.calls.filter(one => one.op === 'app_icon' && one.bundle_id === bundleId).length
}

describe('纯函数:坞上那一格是哪个包', () => {
  it('键长什么样才收:基础键 / c-slug / t-slug 收;像路径、带点、带中文、空的一律拒', () => {
    expect(isDockKey('term')).toBe(true)
    expect(isDockKey('c-wechat')).toBe(true)
    expect(isDockKey('t-doubao')).toBe(true)
    expect(isDockKey('c-app-2')).toBe(true)
    expect(isDockKey('')).toBe(false)
    expect(isDockKey('../../etc/passwd')).toBe(false)
    expect(isDockKey('/Applications/微信.app')).toBe(false)
    expect(isDockKey('com.tencent.xinWeChat')).toBe(false) // 包标识不是键 —— 不许绕过换算
    expect(isDockKey('微信')).toBe(false)
    expect(isDockKey('-term')).toBe(false)
    expect(isDockKey('a'.repeat(65))).toBe(false)
  })

  it('★基础键查 APP_BUNDLES、自定义应用查 apps.json;认不出就 undefined(不猜一个包)', async () => {
    const w = await world()
    expect(await resolveDockApp('wechat', w.registry)).toEqual({ key: 'wechat', bundle_id: 'com.tencent.xinWeChat' })
    expect(await resolveDockApp('term', w.registry)).toEqual({ key: 'term', bundle_id: 'com.apple.Terminal' })
    expect(await resolveDockApp(w.keys.finder, w.registry)).toEqual({ key: w.keys.finder, bundle_id: 'com.apple.finder' })
    expect(await resolveDockApp('c-nothing', w.registry)).toBeUndefined()
    expect(await resolveDockApp('  term  ', w.registry)).toEqual({ key: 'term', bundle_id: 'com.apple.Terminal' })
  })

  it('像路径的键连查表那一步都走不到(bundleFor 一次都没被叫)', async () => {
    let asked = 0
    const lookup = { bundleFor: async () => { asked += 1; return 'com.whatever' } }
    expect(await resolveDockApp('../../etc/passwd', lookup)).toBeUndefined()
    expect(await resolveDockApp('/Applications/微信.app', lookup)).toBeUndefined()
    expect(asked).toBe(0)
  })

  it('基础键被「删过」(bundleFor 不给)时照样退回 APP_BUNDLES —— 坞上那一格还在,就该有图', async () => {
    const w = await world()
    await w.registry.remove('term')
    expect(await w.registry.bundleFor('term')).toBeUndefined()
    expect(await resolveDockApp('term', w.registry)).toEqual({ key: 'term', bundle_id: 'com.apple.Terminal' })
  })
})

/**
 * 按需取那一层(`discovery.appIcon`)自己的纪律。这里的壳**慢**(手动放行),
 * 才验得出「十几格同时要图,同一个包只问壳一次」——走 HTTP 的那几条太快,
 * 第一趟在第二个请求进来之前就已经把缓存填好了,钉不住这条。
 */
describe('按需取一张图(坞上十几格同时要)', () => {
  /** 一个可以卡住的假壳:`release()` 之前 `app_icon` 那一趟不回。 */
  function slowShell() {
    const calls: string[] = []
    let letGo: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { letGo = resolve })
    return {
      calls,
      release: (): void => letGo?.(),
      helper: {
        connected: () => true,
        supports: () => true,
        request: async (req: { op: string, bundle_id?: string }): Promise<Record<string, unknown>> => {
          if (req.op !== 'app_icon') return { apps: [] }
          calls.push(req.bundle_id ?? '')
          await gate
          return { found: false, why: '渲不出它的图标' }
        },
      },
    }
  }

  function discoveryWith(helper: ReturnType<typeof slowShell>['helper']) {
    return createAgentDiscovery({
      store: createMemoryRegistryStore(),
      helper: helper as never,
      now: () => new Date('2026-09-26T10:05:00Z'),
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
    })
  }

  it('★同一个包同时要五遍:只问壳一次(那条长连上不白跑四趟)', async () => {
    const shell = slowShell()
    const discovery = discoveryWith(shell.helper)
    const all = Promise.all([1, 2, 3, 4, 5].map(() => discovery.appIcon('com.apple.Terminal')))
    // 五个都已经进来了,才放行那一趟。
    await Promise.resolve()
    expect(shell.calls).toEqual(['com.apple.Terminal'])
    shell.release()
    expect(await all).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(shell.calls).toEqual(['com.apple.Terminal'])
  })

  it('★没取到的那一家:一天之内不再问壳(一格没装的应用不会每刷一次页面就问一遍系统)', async () => {
    const shell = slowShell()
    const discovery = discoveryWith(shell.helper)
    const first = discovery.appIcon('com.example.gone')
    shell.release()
    expect(await first).toBeUndefined()
    expect(shell.calls).toHaveLength(1)
    expect(await discovery.appIcon('com.example.gone')).toBeUndefined()
    expect(shell.calls).toHaveLength(1)
  })

  it('壳没接上 / 是旧版 → undefined,一个请求都不发', async () => {
    const shell = slowShell()
    const offline = discoveryWith({ ...shell.helper, connected: () => false })
    expect(await offline.appIcon('com.apple.Terminal')).toBeUndefined()
    const old = discoveryWith({ ...shell.helper, supports: (cap: string) => cap !== 'app_icon' } as never)
    expect(await old.appIcon('com.apple.Terminal')).toBeUndefined()
    expect(shell.calls).toHaveLength(0)
  })
})

describe('GET /apps/icon/:key', () => {
  it('★★不是 Agent 的那几家照样有图:微信、终端、Finder、Pen 各回一张真 PNG', async () => {
    const { url, discovery, keys } = await serve()
    // 先确认它们真的**不在登记表里**(判过了不是 Agent)—— 不然这一条就白验了。
    const ids = discovery.view().entries.map(one => one.id)
    expect(ids).not.toContain('com.tencent.xinWeChat')
    expect(ids).not.toContain('com.apple.finder')
    for (const key of ['wechat', 'term', keys.finder, keys.pen]) {
      const res = await fetch(`${url}/apps/icon/${key}`)
      expect(res.status, key).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
      expect(res.headers.get('cache-control')).toContain('must-revalidate')
      expect(res.headers.get('etag')).toBeTruthy()
      const body = new Uint8Array(await res.arrayBuffer())
      // 真 PNG 的头八个字节。
      expect([...body.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    }
  })

  it('带 If-None-Match 回来就 304(过期那一趟只有几十字节的头)', async () => {
    const { url } = await serve()
    const first = await fetch(`${url}/apps/icon/wechat`)
    const etag = first.headers.get('etag')!
    const again = await fetch(`${url}/apps/icon/wechat`, { headers: { 'if-none-match': etag } })
    expect(again.status).toBe(304)
    expect(again.headers.get('etag')).toBe(etag)
    expect(new Uint8Array(await again.arrayBuffer())).toHaveLength(0)
    // `W/` 前缀与多个值也认。
    expect((await fetch(`${url}/apps/icon/wechat`, { headers: { 'if-none-match': `"nope", W/${etag}` } })).status).toBe(304)
  })

  it('★认不出这一格 → 404 + 一句人话(界面画中性小方块);像路径的键同样 404', async () => {
    const { url, shell } = await serve()
    for (const key of ['c-nothing', '..%2F..%2Fetc', 'com.tencent.xinWeChat']) {
      const res = await fetch(`${url}/apps/icon/${key}`)
      expect(res.status, key).toBe(404)
      expect((await res.json() as { error: string }).error).toContain('认不出这一格是哪个应用')
    }
    // 认不出的那几个一次也没去问壳。
    expect(shell.calls.filter(one => one.op === 'app_icon' && String(one.bundle_id).includes('etc'))).toHaveLength(0)
  })

  it('★这台电脑上没装那一家 → 404 + 一句人话,不是错误', async () => {
    const w = await serve()
    const added = await w.registry.add('Gone')
    const res = await fetch(`${w.url}/apps/icon/${added.key}`)
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toContain('没取到')
  })

  it('★壳是旧版(没有 app_icon 这件本事)→ 404,而且一个请求都不发', async () => {
    const { url, shell } = await serve(WORLD, CAPS_OLD)
    const res = await fetch(`${url}/apps/icon/wechat`)
    expect(res.status).toBe(404)
    expect(shell.calls.filter(one => one.op === 'app_icon')).toHaveLength(0)
  })

  it('壳回了一串不是 PNG 的东西 → 404(不把来历不明的字节当图片发给界面)', async () => {
    const { url } = await serve([app({ bundle_id: 'com.apple.Terminal', name: 'Terminal', logo: 'bad' })])
    expect((await fetch(`${url}/apps/icon/term`)).status).toBe(404)
  })

  it('窗位清单没接线 → 404「窗口编排未启用」(不是 500)', async () => {
    const w = await world()
    const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService({}), tickIntervalMs: 0, heartbeatMs: 0, agents: w.discovery })
    started.push(server)
    const res = await fetch(`${server.url}/apps/icon/wechat`)
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toContain('窗口编排未启用')
  })

  it('★取图与缓存和登记表那条是同一份:再要一遍不问壳', async () => {
    const { url, shell } = await serve()
    const before = askedFor(shell, 'com.tencent.xinWeChat')
    await fetch(`${url}/apps/icon/wechat`)
    expect(askedFor(shell, 'com.tencent.xinWeChat')).toBe(before + 1)
    // 第二趟:缓存命中,壳一次都不问。
    await fetch(`${url}/apps/icon/wechat`)
    expect(askedFor(shell, 'com.tencent.xinWeChat')).toBe(before + 1)
  })

  it('★Claude 既在登记表里又在坞上:两条路各回一张图,壳只渲过一次', async () => {
    const { url, shell } = await serve()
    // 巡检已经替登记表取过 Claude 的图(卡 LG 那条路)。
    const asked = askedFor(shell, 'com.anthropic.claudefordesktop')
    expect(asked).toBe(1)
    const viaRegistry = await fetch(`${url}/agents/icon/claude`)
    const viaDock = await fetch(`${url}/apps/icon/claude`)
    expect([viaRegistry.status, viaDock.status]).toEqual([200, 200])
    // 同一份缓存 → 同一个 ETag,而且壳没被再问一遍。
    expect(viaDock.headers.get('etag')).toBe(viaRegistry.headers.get('etag'))
    expect(askedFor(shell, 'com.anthropic.claudefordesktop')).toBe(asked)
  })

  it('登记表那条路不回归:/agents/icon/:id 照旧(取到 200、不在表里 404)', async () => {
    const { url } = await serve()
    expect((await fetch(`${url}/agents/icon/claude`)).status).toBe(200)
    // 微信判过了不是 Agent —— 登记表那条路照旧给不了它图(它的图走 /apps/icon)。
    const res = await fetch(`${url}/agents/icon/com.tencent.xinWeChat`)
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toContain('还没有取到图标')
  })
})
