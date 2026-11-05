// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { emptyRegistry, registryView } from '../src/server/agentRegistry.ts'
import type { SessionView } from '../src/protocol.ts'

/**
 * 2026-09-26 晚(统筹):SDK 起的「What is 2+2?」探针已被认成 selfcheck、坞上不再数它,
 * 可登记表那一份(顶栏小灯、舞台、手机)照样数进了 Claude 的「做完未读 1」。
 * 规矩(卡 V):工作台 / 程序自己起的会话**不进舞台、不进列表、不计数** —— 登记表也一样。
 */
function session(id: string, extra: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'claude', session_id: id, project: 'x', status: 'done', elapsed_sec: 1, last_output_sec: 1,
    unread: true, updated_at: '2026-09-26T14:05:19.000Z', ...extra,
  } as SessionView
}

describe('登记表不数探针会话', () => {
  it('selfcheck 的会话不进 Claude 那一家的会话列表与计数', () => {
    const view = registryView({
      data: emptyRegistry(),
      running: () => true,
      sessions: [session('probe', { selfcheck: { by: 'sdk' } }), session('real')],
      bubbles: new Map(),
      now: new Date('2026-09-26T14:10:00.000Z'),
    })
    const claude = view.entries.find(one => one.id === 'claude')!
    expect(claude.sessions.map(one => one.session_id)).toEqual(['real'])
    expect(claude.counts.unread).toBe(1)
  })
})
