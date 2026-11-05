import { describe, expect, it } from 'vitest'
import { withCardTitles } from '../src/server/sessionTitleFallback.ts'
import type { SessionView } from '../src/protocol.ts'

const view = (over: Partial<SessionView>): SessionView => ({
  agent: 'codex', session_id: 's-1', project: 'desktop-workbench', status: 'done', elapsed_sec: 1, unread: false, updated_at: '2026-10-23T01:21:03.000Z', title: '', ...over,
} as SessionView)

describe('没名字的会话借挂着它的那张卡的标题(2026-10-23)', () => {
  it('★exec 起的 Codex 线程没名字 → 用卡的标题;有名字的一字不动;没卡挂的照旧空着', () => {
    const sessions = [
      view({ session_id: '01a1660e', title: '' }),
      view({ session_id: '01a15c8d', title: '用 Lieflat 语法重设计工作台' }),
      view({ session_id: '019e8c5f', title: '' }),
    ]
    const tasks = [
      { title: '梳理:从人的角度看对话与协作的 UI/UX', links: [{ agent: 'codex' as const, session_id: '01a1660e' }] },
      { title: '别的卡', links: [{ agent: 'codex' as const, session_id: '01a15c8d' }] },
    ]
    const out = withCardTitles(sessions, tasks)
    expect(out.map(one => one.title)).toEqual(['梳理:从人的角度看对话与协作的 UI/UX', '用 Lieflat 语法重设计工作台', ''])
  })

  it('同一条会话挂了两张卡:先登记的那张说了算;家名不同的不混', () => {
    const sessions = [view({ agent: 'codex', session_id: 'x' }), view({ agent: 'claude', session_id: 'x' })]
    const tasks = [
      { title: '甲', links: [{ agent: 'codex' as const, session_id: 'x' }] },
      { title: '乙', links: [{ agent: 'codex' as const, session_id: 'x' }] },
    ]
    expect(withCardTitles(sessions, tasks).map(one => one.title)).toEqual(['甲', ''])
  })

  it('没有任何卡挂会话:原样回(不新建对象之外的东西)', () => {
    const sessions = [view({ session_id: 'a' })]
    expect(withCardTitles(sessions, [])).toEqual(sessions)
  })
})
