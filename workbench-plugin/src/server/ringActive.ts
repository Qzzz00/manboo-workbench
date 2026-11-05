/**
 * 「当前正在响的是谁」的台账（纯函数）。
 *
 * 2026-08-25 实测补上的一块：在此之前响铃状态**只活在消息流里**，谁也不持有——
 * 服务端没有、快照里没有。后果有两条，都是真机上撞出来的：
 * - 树莓派一断线重连就永久丢失这次响铃，回到待机态，POP 按键按下去什么也不做
 *   （复现：起铃 → 重启 phone-bridge → 展示台还在响，派却没再进 ringing）；
 * - 网页那个「🔕停铃」只认 dsh:test-ring 一个键，真响铃根本停不掉，
 *   只能干等展示台 60 秒兜底自停（当天两次真响铃，一次 6.8 秒停掉、一次撑满 60 秒）。
 *
 * 有了台账，重连的订阅者能从快照里知道现在在响什么，停铃也能对真实的键下手。
 */
import type { ActiveRing, AgentId } from '../protocol.ts'
import { sessionKey } from './sessions.ts'

export type { ActiveRing }

/** 会话主键 → 起铃时刻（Unix 毫秒）。
 *
 * 用毫秒而不是秒：时限来自 testRingResetMs（毫秒），换算成整秒后测试里几十毫秒的
 * 时限会被 Math.floor 抹成 0，于是永不过期——真机上表现为「超时后再按变成空停铃」。 */
export type RingActive = Readonly<Record<string, number>>

/** 记一条起铃。同一会话重复起铃只刷新时刻，不重复堆积。 */
export function startRing(active: RingActive, ring: ActiveRing, nowMs: number): RingActive {
  return { ...active, [sessionKey(ring.agent, ring.session_id)]: nowMs }
}

/** 摘掉一条。不在台账里就原样返回——幽灵停铃不该报错，也不该改动别的。 */
export function stopRing(active: RingActive, ring: ActiveRing): RingActive {
  const key = sessionKey(ring.agent, ring.session_id)
  if (!(key in active)) return active
  const next = { ...active }
  delete next[key]
  return next
}

/**
 * 清掉已经超时的。
 *
 * 展示台响铃 60 秒会兜底自停（ringVisibleMs），台账不跟着清就会一直留着早就不响的条目，
 * 让重连的派进一个根本不存在的响铃态。「持续超过」才算过期——正好卡在时限上还算在响，
 * 与 ring.ts 的响铃判定同款语义。
 */
export function pruneRings(active: RingActive, nowMs: number, ttlMs: number): RingActive {
  const next: Record<string, number> = {}
  for (const [key, startedAt] of Object.entries(active)) {
    if (nowMs - startedAt > ttlMs) continue
    next[key] = startedAt
  }
  return next
}

/** 摊平成可以塞进快照的形状。 */
export function listRings(active: RingActive): ActiveRing[] {
  return Object.keys(active).map((key) => {
    const at = key.indexOf(':')
    return { agent: key.slice(0, at) as AgentId, session_id: key.slice(at + 1) }
  })
}
