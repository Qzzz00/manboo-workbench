/**
 * Codex 剩余额度卡:两个来源**按窗口合并**,5 小时与一周各自保留(2026-10-12,卡 `claude/ops-patch-1012`;
 * 运营同学 10-09 在 0.4.98 产物上修的那一条,移植进 `src/client/codexQuota.ts`)。
 *
 * 他撞到的:Codex 偶尔先回周额度、稍后才回 5h。老逻辑「任一来源有值就整组覆盖」——
 * `/state.quota.codex` 里只有「周」那一扇时,`/state.agent_quota` 里仍有效的「5h」被整组丢掉,
 * 卡上 5 小时那一行就没了(或者把「周」当成第一扇摆到 5 小时那个位置)。
 *
 * 钉五件事:
 *   ① 两个来源按「5h / 周」合并,同一扇以 `/state.quota` 那一份为准;
 *   ② 只有「周」时:5 小时那一行**缺席**、大字写「等 5h 那一扇」,不把「周」当 5h 摆;
 *   ③ 一个数都没有 → 照旧「暂未读取」;
 *   ④ 认不出 5h / 周写法的别的窗口照旧退回第一扇(总比一张空卡实在);
 *   ⑤ 一个数都不推算 —— 两个来源里没有的扇一律缺席。
 */
import { describe, expect, it } from 'vitest'
import type { AgentQuotaView, QuotaEntry } from '../src/protocol.ts'
import { CODEX_QUOTA_FIVE_PENDING, CODEX_QUOTA_UNREAD, codexQuotaOf } from '../src/client/codexQuota.ts'

const weeklyOnly: QuotaEntry = { kind: 'quota', windows: [{ label: '周', left_pct: 81.6 }], as_of: '2026-10-09T09:00:00+08:00' } as QuotaEntry
const fiveOnly: QuotaEntry = { kind: 'quota', windows: [{ label: '5h', left_pct: 42.4, reset_at: '2026-10-09T14:00:00+08:00' }], as_of: '2026-10-09T09:00:00+08:00' } as QuotaEntry

function agentView(windows: readonly { label: string, left_pct: number }[]): AgentQuotaView {
  return { id: 'codex', title: 'Codex', state: 'numbers', line: 'x', windows } as AgentQuotaView
}

describe('两个来源按窗口合并', () => {
  it('★/state.quota 只有「周」、agent_quota 里有「5 小时」→ 两扇都在,5 小时不丢', () => {
    const view = codexQuotaOf({ codex: weeklyOnly }, [agentView([{ label: '5 小时', left_pct: 9 }, { label: '本周', left_pct: 55 }])])
    expect(view.five).toEqual({ label: '5 小时', leftPct: 9 })
    // 同一扇(周)两边都有:以 /state.quota 那一份为准。
    expect(view.weekly).toEqual({ label: '周', leftPct: 82 })
    expect(view.head).toBe('9%')
  })

  it('/state.quota 只有「5h」、agent_quota 只有「周」→ 两扇都在', () => {
    const view = codexQuotaOf({ codex: fiveOnly }, [agentView([{ label: '本周', left_pct: 55 }])])
    expect(view.five?.leftPct).toBe(42)
    expect(view.weekly?.leftPct).toBe(55)
  })

  it('★只有「周」→ 5 小时那一行缺席、大字说「等 5h 那一扇」,不把「周」当 5h 摆', () => {
    const view = codexQuotaOf({ codex: weeklyOnly }, undefined)
    expect(view.five).toBeUndefined()
    expect(view.weekly?.leftPct).toBe(82)
    expect(view.head).toBe(CODEX_QUOTA_FIVE_PENDING)
  })

  it('一个数都没有 → 照旧「暂未读取」', () => {
    const view = codexQuotaOf({}, undefined)
    expect(view.five).toBeUndefined()
    expect(view.weekly).toBeUndefined()
    expect(view.head).toBe(CODEX_QUOTA_UNREAD)
  })

  it('认不出 5h / 周写法的窗口 → 退回第一扇(行为与 10-04 那一版相同)', () => {
    const odd: QuotaEntry = { kind: 'quota', windows: [{ label: '今日', left_pct: 30 }], as_of: 'x' } as QuotaEntry
    const view = codexQuotaOf({ codex: odd }, undefined)
    expect(view.five?.label).toBe('今日')
    expect(view.head).toBe('30%')
  })
})
