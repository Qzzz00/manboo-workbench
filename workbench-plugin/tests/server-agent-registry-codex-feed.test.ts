// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { emptyRegistry, registryView } from '../src/server/agentRegistry.ts'
import type { RegistryFile } from '../src/server/agentRegistry.ts'
import type { SessionView } from '../src/protocol.ts'

/**
 * Codex 的对话以**会话文件**为准(2026-09-27,卡 CX)。
 *
 * 维护者 13:15:「codex 的运行中的数量也不对,现在应该是两条」。当时 `/state` 里 codex 这一家
 * `sources` 写着 `kind: sessions, ok: false`,在跑的只有读窗口那一路造出来的
 * `window:…` 那一条 —— 文件那条路有料却一条都没进来(根因见 codexRollout/codexSessionFeed)。
 *
 * 这张用例钉的是**拼起来那一步的口径**:文件那一路有会话时,窗口读法只补标题这类缺席的字,
 * **不再单独造一条会话**,所以「在跑」的数就是文件里那几条,不会重复数。
 */
function codexSession(id: string, extra: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'codex', session_id: id, project: '工作台', status: 'running',
    elapsed_sec: 10, last_output_sec: 3, unread: false,
    updated_at: '2026-09-27T05:24:32.000Z', ...extra,
  } as SessionView
}

/** 登记表里 codex 已接上、且读窗口读到过一份(窗口标题是 App 自己那一截)。 */
function connectedCodex(): RegistryFile {
  const data = emptyRegistry()
  data.apps['com.openai.codex'] = {
    bundle_id: 'com.openai.codex',
    name: 'Codex',
    state: 'connected',
    found: { how: 'sessions', at: '2026-09-27T05:00:00.000Z', basis: '它的会话文件' },
    last: {
      status: 'running',
      since: '2026-09-27T05:00:00.000Z',
      title: '增加Claude环境检测能力',
      titles: ['增加Claude环境检测能力'],
      at: '2026-09-27T05:24:00.000Z',
      unread: false,
      gaps: {},
    },
  }
  return data
}

describe('Codex:文件那一路有会话时不再另造窗口会话(卡 CX)', () => {
  it('两条文件会话都在跑 → 数 2,且一条 window: 的都没有', () => {
    const view = registryView({
      data: connectedCodex(),
      running: () => true,
      sessions: [codexSession('thread-today'), codexSession('thread-old-day')],
      bubbles: new Map(),
      now: new Date('2026-09-27T05:25:00.000Z'),
    })
    const codex = view.entries.find(one => one.id === 'codex')!
    expect(codex.sessions.map(one => one.session_id).sort()).toEqual(['thread-old-day', 'thread-today'])
    expect(codex.sessions.every(one => one.via === 'sessions')).toBe(true)
    expect(codex.counts.running).toBe(2)
    expect(codex.sources.find(one => one.kind === 'sessions')?.ok).toBe(true)
  })

  it('文件里那条会话还没有标题时,窗口读到的标题只是补上来的那一份', () => {
    const view = registryView({
      data: connectedCodex(),
      running: () => true,
      sessions: [codexSession('thread-today')],
      bubbles: new Map(),
      now: new Date('2026-09-27T05:25:00.000Z'),
    })
    const codex = view.entries.find(one => one.id === 'codex')!
    expect(codex.title).toBe('增加Claude环境检测能力')
    expect(codex.sessions).toHaveLength(1)
  })

  it('做完 + 没看过 → 未读数按文件那几条算(蓝点跟 Claude 那一路同口径)', () => {
    const view = registryView({
      data: connectedCodex(),
      running: () => true,
      sessions: [
        codexSession('thread-today', { status: 'done', unread: true }),
        codexSession('thread-old-day', { status: 'done', unread: false }),
      ],
      bubbles: new Map(),
      now: new Date('2026-09-27T05:25:00.000Z'),
    })
    const codex = view.entries.find(one => one.id === 'codex')!
    expect(codex.counts.unread).toBe(1)
    expect(codex.counts.running).toBe(0)
  })
})
