/**
 * **「能派谁」只有一份答案**(2026-09-28,卡 CF;维护者新 Air 上「派活全挂」那两通电话)。
 *
 * 真机上的三件事(诊断包 工作台诊断包-20260928-155543 / -160317):
 *
 * 1. Air 上豆包办公的包标识是 `com.work.pc.doubao`(不是维护者旧机器上的 `com.bot.pc.doubao`),
 *    于是登记表把它登记成 **id = 包标识、名字 = 「豆包工作」**;电话里派活按家名 `doubao` 找 target,
 *    对不上 → 「这台电脑上还没接上 doubao;现在能派的是 豆包工作」。
 * 2. Codex 装着(`installed_agents` 里有 `com.openai.codex`),但它没跑过、没会话文件 →
 *    **登记表里一条都没有** → 窗口那只手也派不出去。
 * 3. 他说「豆包工作」/「Codex」时,`/confirm/points` 拿到的是**显示名**,而那一头只认家名 →
 *    确认点里写成「事务官自己办」,他点的名被丢了。
 *
 * 这一份钉住:**认家(卡 FX)、本机探测(卡 HC)、派活候选(卡 Z)是同一份名单**。
 */
import { describe, expect, it } from 'vitest'
import type { AgentEntryView, AgentRegistryView } from '../src/protocol.ts'
import { AGENT_APP_CANDIDATES } from '../src/server/installedAgents.ts'
import { bindingForApp, bindingForBundle, bundleIdsOf, FAMILY_SOURCES } from '../src/server/agentSources.ts'
import { dispatchTargets, targetFromEntry } from '../src/server/dispatchTargets.ts'
import { matchSpokenFamily } from '../src/server/spokenFamily.ts'
import { registryView } from '../src/server/agentRegistry.ts'
import { emptyRegistry } from '../src/server/agentRegistry.ts'

describe('豆包办公的两个包标识都认得', () => {
  it('新 Air 上那个包标识认成 doubao 这一家', () => {
    expect(bindingForBundle('com.work.pc.doubao')?.agent).toBe('doubao')
    expect(bindingForBundle('com.bot.pc.doubao')?.agent).toBe('doubao')
  })

  it('两个包标识都进本机探测的候选(装了哪个都探得到,家名都是 doubao)', () => {
    const doubao = AGENT_APP_CANDIDATES.filter(one => one.id === 'doubao').map(one => one.bundle_id)
    expect(doubao).toContain('com.bot.pc.doubao')
    expect(doubao).toContain('com.work.pc.doubao')
  })

  it('bundleIdsOf 把主包标识排在前(拉起它用的是这一个)', () => {
    const doubao = FAMILY_SOURCES.find(one => one.agent === 'doubao')
    expect(bundleIdsOf(doubao)[0]).toBe('com.bot.pc.doubao')
  })

  it('显示名也能认成某一家(包标识换了、名字换了皮的那一台)', () => {
    expect(bindingForApp({ bundle_id: 'com.doubao.unknown', name: '豆包工作' })?.agent).toBe('doubao')
    // 谁也不像的一家照旧认不出 —— 不猜(D13)。
    expect(bindingForApp({ bundle_id: 'com.acme.thing', name: 'Acme 助手' })).toBeUndefined()
  })
})

describe('登记表:窗口型那一条按包标识/显示名归到某一家', () => {
  it('Air 上那条「豆包工作」登记成 doubao / 豆包办公', () => {
    const data = emptyRegistry()
    data.apps['com.work.pc.doubao'] = {
      bundle_id: 'com.work.pc.doubao',
      name: '豆包工作',
      state: 'connected',
      found: { how: 'patrol', at: '2026-09-28T07:07:55.546Z', basis: '窗口里有对话区' },
    }
    const view = registryView({ data, sessions: [], bubbles: new Map(), running: () => true, now: new Date('2026-09-28T08:00:00.000Z') })
    const entry = view.entries.find(one => one.id === 'doubao')
    expect(entry).toBeDefined()
    expect(entry?.name).toBe('豆包办公')
    expect(entry?.bundle_id).toBe('com.work.pc.doubao')
    // 派活那一份认得出它(家名 doubao 就是登记表 id)。
    expect(targetFromEntry(entry!)?.id).toBe('doubao')
  })
})

describe('装了、开着就能派(登记表里还没有它也算)', () => {
  const entry = (patch: Partial<AgentEntryView> & { id: string, name: string }): AgentEntryView => ({
    sources: [],
    status: 'idle',
    found: { how: 'patrol', at: '2026-09-28T07:00:00.000Z', basis: '窗口里有对话区' },
    gaps: {},
    sessions: [],
    counts: { running: 0, waiting: 0, unread: 0 },
    ...patch,
  })
  const registry: AgentRegistryView = {
    entries: [
      entry({ id: 'dsh', name: '事务官', self: true }),
      entry({ id: 'doubao', name: '豆包办公', bundle_id: 'com.work.pc.doubao', app_running: true }),
    ],
    asking: [],
    notices: [],
  }

  it('探到装了的 Codex 进派活候选(它还没跑过、登记表里没有它)', () => {
    const targets = dispatchTargets({
      registry,
      installedAgents: [
        { id: 'codex', name: 'Codex', bundle_id: 'com.openai.codex' },
        { id: 'doubao', name: '豆包工作', bundle_id: 'com.work.pc.doubao' },
      ],
    })
    const ids = targets.map(one => one.id)
    expect(ids).toContain('doubao')
    expect(ids).toContain('codex')
    // 同一家不许出现两遍(登记表那条优先,名字用登记表里的)。
    expect(ids.filter(one => one === 'doubao')).toHaveLength(1)
    expect(targets.find(one => one.id === 'doubao')?.title).toBe('豆包办公')
    expect(targets.find(one => one.id === 'codex')?.bundle_id).toBe('com.openai.codex')
    expect(targets.find(one => one.id === 'codex')?.hands).toContain('window')
  })

  it('没探到过(那一格缺席)时一字不变:只有登记表那几家', () => {
    expect(dispatchTargets({ registry }).map(one => one.id)).toEqual(['doubao'])
  })

  it('他说「豆包工作」「豆包办公」「Codex」都认成同一份名单里的那一家', () => {
    const targets = dispatchTargets({
      registry,
      installedAgents: [{ id: 'codex', name: 'Codex', bundle_id: 'com.openai.codex' }],
    })
    const families = targets.map(one => ({ id: one.id, title: one.title, aliases: one.aliases }))
    for (const said of ['让豆包工作查一下', '让豆包办公查一下', '换给 Codex 去做']) {
      const match = matchSpokenFamily(said, families)
      expect(match.kind).toBe('one')
    }
    expect((matchSpokenFamily('让豆包工作查一下', families) as { id: string }).id).toBe('doubao')
    expect((matchSpokenFamily('换给 Codex 去做', families) as { id: string }).id).toBe('codex')
  })
})
