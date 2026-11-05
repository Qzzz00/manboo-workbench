/**
 * 响铃判定（纯函数）。
 *
 * PRD §7.2 的铃声克制原则是硬要求：四家 agent 并行，响多了用户两天内就会静音，产品即失效。
 * 因此这里只放行三条同时成立的情况：等审批、超时、不在冷却期内。
 */
import type { AgentId, EventReason, SessionStatus, WaitReason } from '../protocol.ts'
import { RING_AFTER_SEC, RING_COOLDOWN_SEC } from '../protocol.ts'
import { sessionKey } from './sessions.ts'

/** 参与响铃判定所需的最小字段，SessionView 可直接传进来。 */
export interface RingCandidate {
  agent: AgentId
  session_id: string
  status: SessionStatus
  reason?: EventReason
  /**
   * 等待原因(2026-09-09)。**判定里一个字都不用它**——拍板第 4 条明写「响铃规则不变」:
   * 分类是给界面看的,不是给铃用的。列在这里只是让 SessionView 能整条传进来。
   */
  wait_reason?: WaitReason
  elapsed_sec: number
}

export interface RingSignal {
  agent: AgentId
  session_id: string
}

/** 会话主键 → 上次响铃时刻（Unix 秒）。 */
export type RingLog = Readonly<Record<string, number>>

export function shouldRing(
  candidate: RingCandidate,
  lastRingAtSec: number | undefined,
  nowSec: number,
): boolean {
  // 只有「等你确认」响；「刚完成」永不响铃。
  if (candidate.status !== 'waiting') return false
  // 「等你下一句」不值得打断，只有等审批才响。
  if (candidate.reason !== 'permission_prompt') return false
  // 「持续超过」——正好卡在阈值上还不算超过。
  if (candidate.elapsed_sec <= RING_AFTER_SEC) return false
  // 同一会话两次响铃的间隔不得小于冷却时间。
  if (lastRingAtSec !== undefined && nowSec - lastRingAtSec < RING_COOLDOWN_SEC) return false
  return true
}

/** 遍历当前会话挑出该响的那些，并返回更新后的响铃台账（不改传入的那份）。 */
export function collectRings(
  candidates: readonly RingCandidate[],
  ringLog: RingLog,
  nowSec: number,
): { rings: RingSignal[], ringLog: RingLog } {
  const next: Record<string, number> = { ...ringLog }
  const rings: RingSignal[] = []

  for (const candidate of candidates) {
    const key = sessionKey(candidate.agent, candidate.session_id)
    if (!shouldRing(candidate, ringLog[key], nowSec)) continue
    rings.push({ agent: candidate.agent, session_id: candidate.session_id })
    next[key] = nowSec
  }

  return { rings, ringLog: next }
}
