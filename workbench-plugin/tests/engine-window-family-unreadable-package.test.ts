// @vitest-environment node
/**
 * **同一家多个客户端:读不到的那一个包不连累读得到的那一个**(2026-10-03,运营维护包审计末节第二项)。
 *
 * 现场(Air):App Store 版豆包 `com.bot.neotix.doubao` 读不到(登记表 `unreadable` 那一截,id 归到 `doubao`),
 * 豆包办公 `com.work.pc.doubao` 接着。外层 `dispatchTargets.unreadableBlockOf` 早已按包放行,
 * 可窗口适配器里那份判据按**家名**命中 —— 外层放行、内层照样拦「读不到豆包的窗口」。
 * 派活、捎话、替她答三条路都过这一条通道,所以三条都钉。
 */
import { describe, expect, it } from 'vitest'
import type { Job } from '../src/server/engine/adapter.ts'
import { dispatchUnreadableSay } from '../src/protocol.ts'
import { emptyRegistry, registryView, type RegistryFile } from '../src/server/agentRegistry.ts'
import { dispatchTargets, unreadableBlockOf } from '../src/server/dispatchTargets.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const NOW = new Date('2026-10-03T09:00:00.000Z')
const APPSTORE = 'com.bot.neotix.doubao'
const WORK = 'com.work.pc.doubao'

function airRegistry(): RegistryFile {
  const data = emptyRegistry()
  data.apps[WORK] = { bundle_id: WORK, name: '豆包工作', state: 'connected', found: { how: 'patrol', at: '2026-10-03T08:00:00.000Z', basis: '窗口里有对话区' } }
  for (const [bundle, name] of [[APPSTORE, '豆包'], ['com.moonshot.kimichat.kmp.mac', 'Kimi']] as const) {
    data.apps[bundle] = {
      bundle_id: bundle,
      name,
      state: 'candidate',
      verdict: { kind: 'ai_agent', reason: `${name} 的桌面客户端`, by: 'model', stage: 'identity', at: '2026-10-03T08:00:00.000Z' },
      structure: { pass: false, surface: false, input: false, send: false, new_chat: false, why: '不像对话窗口:没有输入框', at: '2026-10-03T08:10:00.000Z' },
    }
  }
  return data
}

function air() {
  const registry = registryView({ data: airRegistry(), sessions: [], bubbles: new Map(), running: () => true, now: NOW })
  const unreadable = (registry.unreadable ?? []).map(one => ({ id: one.id, name: one.name, bundle_id: one.bundle_id }))
  return { registry, unreadable }
}

type Installed = readonly { bundle_id: string, name?: string, running?: boolean }[]
function rig(doubao: Installed) {
  const { unreadable } = air()
  return engineHarness({
    unreadable: () => unreadable,
    installed: family => (family === 'doubao' ? doubao : undefined),
    nameOf: family => (family === 'doubao' ? '豆包' : family),
  })
}

const BOTH_WORK_RUNNING: Installed = [{ bundle_id: APPSTORE, name: '豆包', running: false }, { bundle_id: WORK, name: '豆包工作', running: true }]
const BOTH_APPSTORE_RUNNING: Installed = [{ bundle_id: APPSTORE, name: '豆包', running: true }, { bundle_id: WORK, name: '豆包工作', running: false }]

const dispatch = (over: Partial<Job> = {}): Job => ({ id: 't-1', itemId: 't-1', family: 'doubao', kind: 'dispatch', target: { kind: 'new' }, text: '帮我整理一下桌面', expect: 'ack', ...over })
const relay = (): Job => ({ id: 'r-1', itemId: 't-1', family: 'doubao', kind: 'relay', target: { kind: 'session', sessionId: 'window:abc' }, text: '进行到哪了', marks: ['进行到哪了'], expect: 'ack' })
const answer = (): Job => ({ id: 'a-1', itemId: 't-1', family: 'doubao', kind: 'answer', target: { kind: 'session', sessionId: 'window:abc' }, text: '用第二个方案', marks: ['用第二个方案'], expect: 'ack' })

describe('同一家多个客户端:按具体包判读不读得到', () => {
  it('前提:外层这一家放行(既有判据,没改)', () => {
    const { registry, unreadable } = air()
    expect(unreadable.find(one => one.bundle_id === APPSTORE)?.id).toBe('doubao')
    expect(unreadableBlockOf({ family: 'doubao', targets: dispatchTargets({ registry }), unreadable })).toBeUndefined()
  })

  for (const [label, installed] of [['豆包办公开着', BOTH_WORK_RUNNING], ['App Store 版开着、豆包办公没开', BOTH_APPSTORE_RUNNING]] as const) {
    it(`★${label}:派活送进豆包办公,不说「读不到」`, async () => {
      const h = rig(installed)
      const out = await h.engine.run(dispatch())
      expect(out.why ?? '').not.toContain('读不到')
      expect(out.delivered).not.toBe('not_sent')
      expect(h.sentTo()).toEqual([WORK])
    })

    it(`★${label}:捎话、替她答同一条通道,一样送进豆包办公`, async () => {
      for (const one of [relay(), answer()]) {
        const h = rig(installed)
        const out = await h.engine.run(one)
        expect(out.why ?? '', one.kind).not.toContain('读不到')
        expect(h.sentTo(), one.kind).toEqual([WORK])
      }
    })
  }

  it('只装着读不到的那一个包 → 照旧当场说读不到,一个字都不送', async () => {
    const h = rig([{ bundle_id: APPSTORE, name: '豆包', running: true }])
    const out = await h.engine.run(dispatch())
    expect(out.delivered).toBe('not_sent')
    // 名字是登记表给那一条的(现取,不抄中文)。
    const name = air().unreadable.find(one => one.bundle_id === APPSTORE)?.name ?? ''
    expect(out.why).toContain(dispatchUnreadableSay({ name, others: [] }))
    expect(h.sentTo()).toEqual([])
  })

  it('点名要读不到的那个包(job.package)→ 拦,不偷换成另一个包', async () => {
    const h = rig(BOTH_WORK_RUNNING)
    const out = await h.engine.run(dispatch({ package: APPSTORE }))
    expect(out.delivered).toBe('not_sent')
    expect(h.sentTo()).toEqual([])
  })

  it('整家都没有读得到的包(新版 Kimi:一个包都解析不出)→ 照旧按家名拦', async () => {
    const { unreadable } = air()
    const h = engineHarness({ unreadable: () => unreadable, installed: () => undefined, nameOf: () => 'Kimi' })
    const out = await h.engine.run(dispatch({ family: 'kimi' }))
    expect(out.delivered).toBe('not_sent')
    expect(h.sentTo()).toEqual([])
  })
})
