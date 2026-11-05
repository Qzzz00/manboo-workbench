/**
 * 「现在在不在通话」(2026-09-25,卡 Q「Agent 自动发现与统一接入」)。
 *
 * 设计第 3 条:平时低频巡一遍,**通话中暂停(沿用 loadGuard)**。通话护栏(channel-worker/src/loadGuard.ts)
 * 用的判据是工人自己的 `inCall()`(普通来去电、引导那一通都算)—— 这里就用**同一个口径**:工人在 `inCall()`
 * 翻转时、以及通话中每 30 秒报一次 `POST /channel/call-state { in_call }`,工作台记下来,巡检每一拍先问它。
 *
 * 两道兜底,**同 loadGuard 的纪律**:
 * - 报「在通话」只管 `ttlMs`(缺省 90 秒):工人崩了、没来得及报挂断,巡检最多停一分半就自己回来;
 * - 一通最多算 90 分钟(同 `LOAD_GUARD_MAX_ACTIVE_MS`):「通话状态」卡住了,巡检不会一直停着。
 */

export const CALL_STATE_TTL_MS = 90_000
export const CALL_STATE_MAX_MS = 90 * 60_000

export interface CallState {
  /**
   * 工人报一次。`source`(2026-10-22,卡 M6):两条工人各报各的(`lan` / `relay`),哪一条在通话都算在通话 ——
   * 不然一条刚起报一句「不在」,就把另一条正在打的那通盖掉了。不带 = 老工人。
   */
  report: (inCall: boolean, source?: string) => void
  /** 此刻算不算在通话。 */
  inCall: () => boolean
  view: () => { in_call: boolean, since?: string }
}

export function createCallState(options: { now?: () => number, ttlMs?: number, maxMs?: number } = {}): CallState {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? CALL_STATE_TTL_MS
  const maxMs = options.maxMs ?? CALL_STATE_MAX_MS
  /** 每条工人那一份(键是路线;老工人 = 空串)。 */
  const sources = new Map<string, { lastTrueAt: number, since: number }>()

  function liveOf(one: { lastTrueAt: number, since: number }, t: number): boolean {
    if (t - one.lastTrueAt > ttlMs) return false
    // 这一通护满了:放开,直到工人报一次「挂了」(或者报过期了)才算下一通(同 loadGuard 的 #expired)。
    if (t - one.since > maxMs) return false
    return true
  }

  function inCall(): boolean {
    const t = now()
    return [...sources.values()].some(one => liveOf(one, t))
  }

  return {
    report(value, source = '') {
      const t = now()
      if (value) {
        // 上一通的报早就过期了(工人崩过)才算新的一通;**护满 90 分钟那一通接着报「在通话」不算新的一通**,
        // 不然「一通最多 90 分钟」形同虚设。
        const last = sources.get(source)
        sources.set(source, { lastTrueAt: t, since: last === undefined || t - last.lastTrueAt > ttlMs ? t : last.since })
      }
      else {
        sources.delete(source)
      }
    },
    inCall,
    view() {
      const t = now()
      const live = [...sources.values()].filter(one => liveOf(one, t))
      if (live.length === 0) return { in_call: false }
      return { in_call: true, since: new Date(Math.min(...live.map(one => one.since))).toISOString() }
    },
  }
}
