/**
 * 「现在在不在通话」报给工作台(2026-09-25,卡 Q「Agent 自动发现与统一接入」)。
 *
 * 工作台那边平时低频巡一遍各家 Agent 的窗口(读辅助功能树,要花 CPU);设计第 3 条:**通话中暂停,沿用 loadGuard**。
 * 通话护栏(loadGuard.ts)用的判据是这里的 `inCall()`(普通来去电、引导那一通都算)—— 工作台不知道这件事,
 * 所以由工人报:`inCall()` 一翻转就报一次,通话中每 30 秒再报一次(工作台那边「在通话」只算 90 秒,
 * 工人崩了没来得及报挂断,巡检最多停一分半就自己回来;见 workbench-plugin/src/server/callState.ts)。
 *
 * 报不出去(工作台没起来、正在重启)不要紧:下一拍接着报。旧工作台没有这个口(404)就当报过了,不反复敲门。
 */

export const CALL_STATE_TICK_MS = 2000
export const CALL_STATE_HEARTBEAT_MS = 30_000

export interface CallStateReportDeps {
  /** 此刻在不在通话(与通话护栏同一个 `inCall`)。 */
  isActive: () => boolean
  /** 报一次。回「报到了没有」,**不抛**。 */
  send: (inCall: boolean) => Promise<boolean>
  now?: () => number
  heartbeatMs?: number
}

export class CallStateReporter {
  readonly #deps: CallStateReportDeps
  #last: boolean | undefined
  #sentAt = 0
  #timer: ReturnType<typeof setInterval> | undefined
  #busy = false

  constructor(deps: CallStateReportDeps) {
    this.#deps = deps
  }

  /** 看一眼:变了就报;通话中隔 30 秒再报一次。 */
  async tick(): Promise<void> {
    if (this.#busy) return
    this.#busy = true
    try {
      const active = this.#deps.isActive()
      const t = (this.#deps.now ?? Date.now)()
      const changed = active !== this.#last
      const heartbeat = active && t - this.#sentAt >= (this.#deps.heartbeatMs ?? CALL_STATE_HEARTBEAT_MS)
      if (!changed && !heartbeat) return
      if (await this.#deps.send(active)) {
        this.#last = active
        this.#sentAt = t
      }
    }
    catch { /* 报不出去:下一拍再报 */ }
    finally { this.#busy = false }
  }

  start(intervalMs = CALL_STATE_TICK_MS): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => { void this.tick() }, intervalMs)
    this.#timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.#timer !== undefined) { clearInterval(this.#timer); this.#timer = undefined }
  }
}

/**
 * 真的去报:`POST <工作台>/channel/call-state { in_call, route? }`。3 秒报不到就算这次没报到。
 * `route`(2026-10-22,卡 M6):两条工人各报各的,一条刚起报「不在」不盖掉另一条正在打的那通。
 */
export function postCallState(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  route?: () => 'lan' | 'relay' | undefined,
): (inCall: boolean) => Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, '')
  return async (inCall) => {
    try {
      const which = route?.()
      const res = await fetchImpl(`${base}/channel/call-state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ in_call: inCall, ...(which === undefined ? {} : { route: which }) }),
        signal: AbortSignal.timeout(3000),
      })
      // 404 = 旧工作台没这个口:当报过了,不每两秒敲一次门。
      return res.ok || res.status === 404
    }
    catch { return false }
  }
}
