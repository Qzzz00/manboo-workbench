// @vitest-environment node
/**
 * 各家的颜色从它自己 App 的图标来(2026-09-25,卡 Q;维护者:「Claude 是橙色的,能不能配个同色系的卡通形象,
 * 其他的 Agent 也是使用同色系的卡通形象」)。
 *
 * 不写死每家的颜色:壳读图标的主色(`icon_colors`,workbench-app 的 IconColor 挑,有单测),登记表按一处定的规则
 * (`agentColor`)提亮成深色底上看得清的那一个,会话卡的小头像、事务官舞台、顶栏小灯、手机都读这一格。
 * 取不到图标 → 中性灰,不猜。
 */
import { describe, expect, it } from 'vitest'
import { AGENT_MONO_COLOR, AGENT_NEUTRAL_COLOR } from '../src/protocol.ts'
import { COLOR_MIN_GAP_MS, createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { agentColor, colorHsl, createMemoryRegistryStore, parseRegistry } from '../src/server/agentRegistry.ts'
import type { FakeApp } from './fixtures/agentWorld.ts'
import { chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'

/** 两个颜色是不是同色系:色相差得不多。 */
function sameFamily(a: string, b: string, maxDegrees = 12): boolean {
  const x = colorHsl(a)
  const y = colorHsl(b)
  if (x === undefined || y === undefined) return false
  const d = Math.abs(x.h - y.h)
  return Math.min(d, 360 - d) <= maxDegrees
}

describe('一处定的规则:图标主色 → 界面上的颜色', () => {
  it('★有颜色的图标:色相不动,同色系;太深的提亮一档(深色底上看得清)', () => {
    // Claude 的图标这台 Mac 上量出来是 #eb714d(橙),本来就够亮:基本不动。
    expect(sameFamily(agentColor('#eb714d'), '#eb714d')).toBe(true)
    expect(colorHsl(agentColor('#eb714d'))?.l).toBeCloseTo(colorHsl('#eb714d')?.l ?? 0, 1)
    // Muse 的图标量出来是 #1571e2(偏深的蓝):色相不动,亮度提到 0.62。
    const muse = agentColor('#1571e2')
    expect(sameFamily(muse, '#1571e2')).toBe(true)
    expect(colorHsl(muse)?.l).toBeCloseTo(0.62, 2)
    // 很深的红:提亮之后仍是红。
    expect(sameFamily(agentColor('#5a0a0a'), '#ff0000')).toBe(true)
    expect(colorHsl(agentColor('#5a0a0a'))?.l).toBeGreaterThan(0.55)
  })

  it('黑白图标(ChatGPT / Codex / Kimi 那种)→ 浅的中性色;取不到 / 认不出 → 中性灰', () => {
    expect(agentColor('#181919')).toBe(AGENT_MONO_COLOR)
    expect(agentColor('#e2e2e4')).toBe(AGENT_MONO_COLOR)
    expect(agentColor(undefined)).toBe(AGENT_NEUTRAL_COLOR)
    expect(agentColor('orange')).toBe(AGENT_NEUTRAL_COLOR)
    expect(AGENT_MONO_COLOR).not.toBe(AGENT_NEUTRAL_COLOR)
  })

  it('登记表文件里的颜色读得回来;坏的那一格丢掉', () => {
    const data = parseRegistry(JSON.stringify({ version: 1, apps: {}, colors: { a: { color: '#112233', at: '2026-09-25T02:00:00Z' }, b: { color: 'red', at: '2026-09-25T02:00:00Z' }, c: 'x' } }))
    expect(data.colors).toEqual({ a: { color: '#112233', at: '2026-09-25T02:00:00Z' }, b: { at: '2026-09-25T02:00:00Z' } })
  })
})

describe('登记表里的颜色从它自己的图标来', () => {
  function world(apps: FakeApp[], caps = ['new_conversation', 'read_reply', 'agent_window', 'icon_color']) {
    let clock = new Date('2026-09-25T02:00:00Z')
    const shell = fakeShell(apps, { caps })
    const discovery = createAgentDiscovery({
      store: createMemoryRegistryStore(),
      helper: shell.helper,
      judge: fakeModel(Object.fromEntries(apps.map(app => [app.name, 'ai_agent' as const]))).judge,
      remainingCny: async () => 4,
      now: () => clock,
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
    })
    return { discovery, shell, advance: (ms: number) => { clock = new Date(clock.getTime() + ms) } }
  }
  const app = (over: Partial<FakeApp> & Pick<FakeApp, 'bundle_id' | 'name'>): FakeApp => ({
    running: true, category: 'public.app-category.productivity', probe: chatProbe(), read: () => chatRead({ answer: '好的' }), ...over,
  })

  it('★运行时接上的一家,给它一个假图标(主色偏深的蓝):它的颜色与图标同色系、提亮过;没图标的那一家是中性灰', async () => {
    const w = world([
      app({ bundle_id: 'com.example.fooai', name: 'Foo AI', icon: '#1571e2' }),
      app({ bundle_id: 'com.example.plain', name: 'Plain AI' }),
    ])
    await w.discovery.tick() // 扫、判身份、读颜色(这时两家都还没接上:只读得到专门读法那几家与工作台自己)
    await w.discovery.tick() // 接上 Foo AI(一拍看一家结构)
    w.advance(COLOR_MIN_GAP_MS)
    await w.discovery.tick() // 接上 Plain AI;新接上的那一家下一拍就读颜色
    w.advance(COLOR_MIN_GAP_MS)
    await w.discovery.tick()
    const entries = w.discovery.view().entries
    const foo = entries.find(one => one.id === 'com.example.fooai')
    const plain = entries.find(one => one.id === 'com.example.plain')
    expect(foo?.color).toBeDefined()
    expect(sameFamily(foo?.color ?? '', '#1571e2')).toBe(true)
    expect(foo?.color).toBe(agentColor('#1571e2'))
    expect(plain?.color).toBe(AGENT_NEUTRAL_COLOR)
    // 颜色记在登记表里(下次起来不用再读)。
    expect(w.discovery.data().colors['com.example.fooai']?.color).toBe('#1571e2')
    // 事务官自己那一格也有颜色(工作台自己的图标;这台假 Mac 上没有 → 中性灰)。
    expect(entries.find(one => one.self === true)?.color).toBe(AGENT_NEUTRAL_COLOR)
  })

  it('读过的不再读(七天内);壳是旧版(没有这个本事)→ 一个都不读、一律中性灰', async () => {
    const w = world([app({ bundle_id: 'com.example.fooai', name: 'Foo AI', icon: '#eb714d' })])
    for (let i = 0; i < 3; i += 1) { await w.discovery.tick(); w.advance(COLOR_MIN_GAP_MS) }
    const asked = w.shell.calls.filter(one => one.op === 'icon_colors').length
    for (let i = 0; i < 3; i += 1) { await w.discovery.tick(); w.advance(COLOR_MIN_GAP_MS) }
    expect(w.shell.calls.filter(one => one.op === 'icon_colors')).toHaveLength(asked)

    const old = world([app({ bundle_id: 'com.example.fooai', name: 'Foo AI', icon: '#eb714d' })], ['new_conversation', 'read_reply', 'agent_window'])
    for (let i = 0; i < 3; i += 1) { await old.discovery.tick(); old.advance(COLOR_MIN_GAP_MS) }
    expect(old.shell.calls.some(one => one.op === 'icon_colors')).toBe(false)
    expect(old.discovery.view().entries.find(one => one.id === 'com.example.fooai')?.color).toBe(AGENT_NEUTRAL_COLOR)
  })
})
