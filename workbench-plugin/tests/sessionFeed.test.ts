// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SessionView, WorkbenchState } from '../src/protocol.ts'
import {
  activationTarget, agentLamp, groupByAgent, offlineState, peopleChips, quotaSummary, sortSessions,
} from '../src/client/sessionFeed.ts'

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'dsh',
    session_id: 'a7c1',
    project: '扣扣直聘',
    status: 'running',
    elapsed_sec: 60,
    unread: false,
    updated_at: '2026-08-18T10:03:00.000Z',
    ...over,
  }
}

describe('sortSessions', () => {
  it('「等你确认」置顶，其次「刚完成」，最后「在跑」', () => {
    const sorted = sortSessions([
      session({ session_id: 'run', status: 'running' }),
      session({ session_id: 'done', status: 'done', unread: true }),
      session({ session_id: 'wait', status: 'waiting', reason: 'permission_prompt' }),
    ])

    expect(sorted.map(s => s.session_id)).toEqual(['wait', 'done', 'run'])
  })

  it('同为「等你确认」时等得久的在前', () => {
    const sorted = sortSessions([
      session({ session_id: '短', status: 'waiting', elapsed_sec: 10 }),
      session({ session_id: '长', status: 'waiting', elapsed_sec: 600 }),
    ])

    expect(sorted.map(s => s.session_id)).toEqual(['长', '短'])
  })
})

/** 登记表里的几家(用例里的数据;产品代码里没有这张表,名字来自 /state.agent_registry)。 */
function entry(id: string, name: string, sessions: SessionView[] = []) {
  return { id, name, sessions: sessions.map(one => ({ ...one, agent: id, via: 'sessions' as const })) }
}

describe('groupByAgent', () => {
  it('★按 Agent 登记表分组:登记表里有几家就几组(运行时新接上的一家也有一组),没会话的那家也要出现', () => {
    const groups = groupByAgent([
      entry('dsh', '事务官'),
      entry('claude', 'Claude', [session({ agent: 'claude' })]),
      entry('com.meta.endo', 'Muse'),
    ])
    expect(groups.map(g => g.agent)).toEqual(['dsh', 'claude', 'com.meta.endo'])
    expect(groups.map(g => g.name)).toEqual(['事务官', 'Claude', 'Muse'])
    expect(groups.find(g => g.agent === 'claude')?.sessions).toHaveLength(1)
    expect(groups.find(g => g.agent === 'dsh')?.sessions).toHaveLength(0)
  })

  it('组内按等待优先排序，并给出该组的等待/在跑计数', () => {
    const groups = groupByAgent([entry('dsh', '事务官', [
      session({ agent: 'dsh', session_id: 'r', status: 'running' }),
      session({ agent: 'dsh', session_id: 'w', status: 'waiting' }),
    ])])
    const dsh = groups.find(g => g.agent === 'dsh')

    expect(dsh?.sessions.map(s => s.session_id)).toEqual(['w', 'r'])
    expect(dsh?.waiting).toBe(1)
    expect(dsh?.running).toBe(1)
  })
})

describe('agentLamp', () => {
  it('有等待是黄，纯在跑是绿，离线或无会话是灰', () => {
    expect(agentLamp({ id: 'dsh', online: true, connected: true, waiting: 1, running: 0 })).toBe('amber')
    expect(agentLamp({ id: 'dsh', online: true, connected: true, waiting: 0, running: 2 })).toBe('teal')
    expect(agentLamp({ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 })).toBe('off')
    expect(agentLamp({ id: 'dsh', online: false, connected: true, waiting: 1, running: 0 })).toBe('off')
  })
})

describe('quotaSummary', () => {
  it('余额型给数字，窗口型给最紧的一条', () => {
    const text = quotaSummary({
      dsh: { kind: 'balance', currency: 'CNY', total: '218.40', available: true },
      claude: { kind: 'quota', windows: [{ label: '5h', left_pct: 31 }, { label: '周', left_pct: 74 }] },
    })

    expect(text).toContain('218.40')
    expect(text).toContain('31%')
    // 只报最紧那条，不把 74% 也堆上来。
    expect(text).not.toContain('74%')
  })

  it('未接入的来源不进摘要，不用 0 冒充', () => {
    const text = quotaSummary({ codex: { kind: 'unknown', note: '取数方式待实测' } })

    expect(text).not.toContain('0')
    expect(text).toBe('')
  })
})

describe('activationTarget（会话区点击激活，agent 映射 claude/codex/kimi，dsh 无动作）', () => {
  it('claude/codex/kimi 映射自己', () => {
    expect(activationTarget('claude')).toBe('claude')
    expect(activationTarget('codex')).toBe('codex')
    expect(activationTarget('kimi')).toBe('kimi')
  })

  it('dsh 行无动作', () => {
    expect(activationTarget('dsh')).toBeNull()
  })
})

describe('peopleChips（人找我角标，badges 驱动）', () => {
  it('数字 > 0 原样透出', () => {
    const chips = peopleChips({ wechat: 3 })
    expect(chips.find(c => c.app === 'wechat')?.value).toBe(3)
  })

  it('数字为 0 时视为已接入无消息（value 仍是 0，不是 null）', () => {
    const chips = peopleChips({ wechat: 0 })
    expect(chips.find(c => c.app === 'wechat')?.value).toBe(0)
  })

  it('null 或缺省 key 都视为未接入', () => {
    const chips = peopleChips({ wecom: null })
    expect(chips.find(c => c.app === 'wecom')?.value).toBeNull()
    expect(peopleChips({}).every(c => c.value === null)).toBe(true)
  })

  it('固定两家：微信/企业微信（2026-08-22 真机实况：微信双开假设作废，仅存 WeChat2）', () => {
    const chips = peopleChips({})
    expect(chips.map(c => c.app)).toEqual(['wechat', 'wecom'])
    expect(chips.map(c => c.label)).toEqual(['微信', '企业微信'])
  })
})

describe('offlineState', () => {
  /**
   * ★ 2026-09-27(卡 HC「不写死各家 AI」):兜底快照里**一家都不编**。
   *
   * 原来这里造四条 `connected:false` 的假行,可这会儿连 /state 都还没读到过 ——
   * 凭什么知道这台电脑上装着 Claude 和 Kimi?维护者在只装了豆包办公与 Codex 的全新 Air 上
   * 看到的那两家,一部分就是从这类占位里来的:「每一个人电脑装的东西都不一样,千万不能写死」。
   *
   * 架构约束 C1 要的是**看板别死**(照旧显示上次已知状态 + 明示「Agent 掉线」),
   * 不是凑几行家名出来 —— `stale: true` 已经把话说清了。
   */
  it('★服务连不上时给一份 stale 的空快照:一家都不编,也不抛错', () => {
    const state = offlineState()

    expect(state.stale).toBe(true)
    expect(state.sessions).toEqual([])
    expect(state.agents).toEqual([])
  })
})

describe('fetchState', () => {
  it('服务连不上时退回 stale 快照，不把异常抛给界面', async () => {
    const { fetchState } = await import('../src/client/sessionFeed.ts')
    const failing = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))

    const state = await fetchState('http://127.0.0.1:8791', failing as unknown as typeof fetch)

    expect(state.stale).toBe(true)
    expect(state.sessions).toEqual([])
  })

  it('服务返回非 200 时也退回 stale 快照', async () => {
    const { fetchState } = await import('../src/client/sessionFeed.ts')
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const state = await fetchState('http://127.0.0.1:8791', bad as unknown as typeof fetch)

    expect(state.stale).toBe(true)
  })

  it('正常时原样返回服务给的快照', async () => {
    const { fetchState } = await import('../src/client/sessionFeed.ts')
    const snapshot: WorkbenchState = {
      agents: [], sessions: [session()], quota: {}, now: '2026-08-18T10:03:00.000Z', stale: false,
    }
    const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => snapshot })

    const state = await fetchState('http://127.0.0.1:8791', ok as unknown as typeof fetch)

    expect(state.sessions).toHaveLength(1)
    expect(state.stale).toBe(false)
  })
})
