/**
 * 「有几个 agent 在跑」要念到客户端会话(2026-09-23 16:30 维护者真机:
 * Claude 与 Codex 都在跑,她只查了看板事项,答「一个都没有」)。
 */
import { describe, expect, it } from 'vitest'
import { agentSessionsOf, spokenAgentSessions } from '../src/workbench.ts'

const state = {
  sessions: [
    { agent: 'codex', status: 'running', title: '制作参赛网页', project: 'desktop-workbench', last_output_sec: 60 },
    { agent: 'claude', status: 'running', title: '', project: 'desktop-workbench', last_output_sec: 6000 },
    { agent: 'claude', status: 'waiting', title: '统筹交接', project: 'x' },
    { agent: 'codex', status: 'offline', title: '重写方案' },
    { agent: 'claude', status: 'done', title: '已完的' },
  ],
}

describe('客户端会话', () => {
  it('只取在跑与等回话的', () => {
    const got = agentSessionsOf(state)
    expect(got.map(s => s.status)).toEqual(['running', 'running', 'waiting'])
  })

  it('念出来:家名、标题、状态;很久没动静的如实标出', () => {
    const text = spokenAgentSessions(agentSessionsOf(state))
    expect(text).toContain('Codex:「制作参赛网页」,在跑')
    expect(text).toContain('Claude:desktop-workbench 里一条没起标题的,在跑(已经 100 分钟没动静')
    expect(text).toContain('Claude:「统筹交接」,在等他回话')
    expect(text).not.toContain('重写方案')
  })

  it('没有就明说没有;读不懂不抛', () => {
    expect(spokenAgentSessions(agentSessionsOf({ sessions: [] }))).toContain('没有在跑的会话')
    expect(agentSessionsOf(null)).toEqual([])
    expect(agentSessionsOf({ sessions: 'x' })).toEqual([])
  })
})
