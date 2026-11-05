/**
 * 「这台机器装好了没有」(2026-09-23 从零重装验收第 3 件)。
 *
 * 新装机器第一次启动,用户还没注册,本机网页的第一次 GET /state 就被例程当成「当天第一次露面」,
 * 跑了一次开工汇报;例程的结果又被座机当成一件「完成」排进台账 —— 座机页上于是写着
 * 「最近一次通话:17:01 · 完成 · 开工汇报 · 排着」,那时候他连账号都还没有。
 *
 * 判据两条,**都满足才算装好**:
 *   1. 注册过账号(`GET /account` 那一份的 `registered`;服务器账号、本机账号都算);
 *   2. 新用户引导走完了(引导阶段机的 `done`;没接引导服务的机器没有引导可走,算走完,
 *      与 `isFirstRun` 同一条口径)。
 *
 * 没装好时,例程(routines.ts)与座机主动来电(callOut.ts)的**自动那一半**都不动;
 * 他亲手点的(「现在跑一次」「回拨」「试铃」)照旧。
 *
 * `reason()` 是**同步**的:它挂在 1 秒节拍上,而账号那一问要读盘。所以账号那一格缓存着,
 * 过了 `refreshMs` 就在后台再问一次;**还没问到过就当没注册**(宁可晚一拍跑,不在没注册时跑)。
 */

export const SETUP_GATE_NOT_REGISTERED = '还没注册账号'
export const SETUP_GATE_ONBOARDING_PENDING = '新用户引导还没走完'

export interface SetupGateOptions {
  /** 注册过账号没有。抛了当没注册。 */
  registered: () => Promise<boolean>
  /** 引导走完了没有。`undefined` = 这台机器没有引导可走(算走完)。 */
  onboardingDone: () => boolean | undefined
  now?: () => number
  /** 账号那一格多久再问一次。缺省 5 秒。 */
  refreshMs?: number
}

export interface SetupGate {
  /** 没装好就回一句为什么;装好了回 undefined。 */
  reason: () => string | undefined
  /** 立刻再问一次账号(注册 / 登录成功之后调,省得等下一拍)。 */
  refresh: () => Promise<void>
}

export function createSetupGate(options: SetupGateOptions): SetupGate {
  const now = options.now ?? (() => Date.now())
  const refreshMs = options.refreshMs ?? 5000
  let registered = false
  let checkedAt: number | undefined
  let inflight: Promise<void> | undefined

  function refresh(): Promise<void> {
    if (inflight !== undefined) return inflight
    inflight = (async () => {
      try { registered = await options.registered() }
      catch { registered = false }
      finally {
        checkedAt = now()
        inflight = undefined
      }
    })()
    return inflight
  }

  return {
    reason() {
      if (checkedAt === undefined || now() - checkedAt >= refreshMs) void refresh()
      if (!registered) return SETUP_GATE_NOT_REGISTERED
      let done: boolean | undefined
      try { done = options.onboardingDone() }
      catch { done = false }
      if (done === false) return SETUP_GATE_ONBOARDING_PENDING
      return undefined
    },
    refresh,
  }
}
