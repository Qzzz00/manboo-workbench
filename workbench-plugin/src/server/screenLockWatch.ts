/**
 * ★ **问壳「这一刻锁着屏没有」,解锁了就把排着的那几件重送**(2026-10-03,
 * 卡「锁屏时窗口型的家送不进」)。
 *
 * 挂在 `http.ts` 那根**既有的 1 秒节拍**上(同 `relayWatch.pump` / `callOut.pump`),
 * **内部限频**({@link SCREEN_LOCK_POLL_MS}):问一句锁没锁是只读的
 * (壳那一侧 `screen_info` 只读 NSScreen + `CGSessionCopyCurrentDictionary()`,不碰别人的窗口),
 * 但也没必要一秒一次。
 *
 * ## 为什么是「问」而不是「等壳推一条」
 *
 * 壳订了系统那两条分布式通知(`com.apple.screenIsLocked` / `…Unlocked`,见
 * `workbench-app/Sources/ScreenLock.swift`),但那是**壳自己**用来记日志与作废缓存的。
 * 工作台这一侧要答的是「此刻」:壳可能在锁屏之后才起来(launchd 重启、热更新换壳),
 * 那时一条通知都收不到 —— 只有问才答得对。推一条新事件还要动 helper 的事件协议(另一条接缝),
 * 这张卡不碰(交接第五节写明)。
 *
 * ## 三条纪律
 *
 * - **「不知道」不许当成「锁着」**:老壳不报那一格、壳没连上、这一拍失败 → {@link ScreenLockWatch.locked}
 *   回 `undefined`,窗口那一层照旧送(与 2026-10-03 之前一字不差);
 * - **一次只跑一轮重送**:重送要一条一条来(她说话的次序),上一轮没走完的后续节拍直接跳过;
 * - **刚起服务那一下也要重送一次**:盘上那本队可能是上一回锁屏时排下的(落盘,重启不丢)——
 *   所以「第一次问出来是没锁」也当一次解锁办(`undefined → false` 与 `true → false` 同样处理)。
 */

/** 多久问一次壳(毫秒)。她解锁之后最多迟这么久就开始重送。 */
export const SCREEN_LOCK_POLL_MS = 3000

export interface ScreenLockWatchDeps {
  /**
   * 问壳一句(`screen_info` 那一条只读 op;回 `undefined` = 不知道)。
   * 实现在 `index.ts` 的接线里:`helper.request({op:'screen_info'})` → `screenLockedOf(result)`。
   */
  ask: () => Promise<boolean | undefined>
  /**
   * 解锁了那一下把排着的那几件重送(`engine/lockQueue.drainLockQueue`)。
   *
   * 回那一轮的结果:`kept > 0` = 还有留着的(被闸拦下 / 又锁上了)→ **下一拍再来一轮**,
   * 不等下一次锁 / 解锁(不然那几条会一直躺着)。回 `undefined` = 不知道,按「没留」算。
   */
  drain: () => Promise<{ kept: number } | undefined>
  now?: () => number
  pollMs?: number
  /** 记一行(缺席 = 不记)。 */
  warn?: (line: string) => void
}

export interface ScreenLockWatch {
  /** 走一拍(挂在 1 秒节拍上;内部限频)。**绝不抛**。 */
  pump: () => Promise<void>
  /** 这一刻锁着屏没有(`undefined` = 还不知道 / 问不到)。窗口适配器读的就是这一格。 */
  locked: () => boolean | undefined
}

/** 锁 / 解锁那一刻记的两行(断言照常量,不逐字抄中文)。 */
export const SCREEN_LOCK_LOG_LOCKED = '[锁屏] 电脑锁上了,窗口型的家这会儿送不进(排进队,解锁再送)'
export const SCREEN_LOCK_LOG_UNLOCKED = '[锁屏] 电脑解锁了'

export function createScreenLockWatch(deps: ScreenLockWatchDeps): ScreenLockWatch {
  const now = deps.now ?? (() => Date.now())
  const pollMs = deps.pollMs ?? SCREEN_LOCK_POLL_MS
  const warn = deps.warn ?? ((): void => {})
  let locked: boolean | undefined
  let askedAt = 0
  let asking = false
  let draining = false
  /** 上一轮还留着东西(被闸拦下 / 又锁上了)→ 这一拍接着来一轮。 */
  let again = false

  return {
    locked: () => locked,
    async pump() {
      if (asking || draining) return
      const at = now()
      if (askedAt !== 0 && at - askedAt < pollMs) return
      askedAt = at
      asking = true
      let answer: boolean | undefined
      try { answer = await deps.ask() }
      catch { answer = undefined }
      finally { asking = false }
      /*
       * **问不到就什么都不改**:把 `locked` 抹成 `undefined` 会在壳抖一下的时候
       * 让一次锁屏变成「不知道」→ 照旧送 → 又是 09:04 那一幕。按「上一次知道的」办。
       */
      if (answer === undefined) return
      const was = locked
      locked = answer
      // 锁上了:记一行、什么都不送。`again` 清掉 —— 她解锁那一下照 `was === true` 走,本来就会来一轮。
      if (answer) {
        if (was !== true) warn(SCREEN_LOCK_LOG_LOCKED)
        again = false
        return
      }
      /*
       * 没锁。只在**变过来**的那一下重送:`true → false` 是她解锁了;
       * `undefined → false` 是刚起服务第一次问出来(盘上那本队可能是上一回锁屏时排下的)。
       * 本来就是 `false` 的那几拍什么都不做 —— 不然每 3 秒白走一轮空队。
       *
       * 例外(`again`):上一轮还留着东西(被闸拦下「离上一回太密」/ 中途又锁上了)——
       * 这一拍接着来一轮,不等下一次锁 / 解锁(不然那几条会一直躺着)。
       */
      if (was === false && !again) return
      if (was === true) warn(SCREEN_LOCK_LOG_UNLOCKED)
      draining = true
      try {
        const report = await deps.drain()
        again = (report?.kept ?? 0) > 0
      }
      catch (error) {
        warn(`[锁屏] 重送那一轮出错:${error instanceof Error ? error.message : String(error)}`)
        again = false
      }
      finally { draining = false }
    },
  }
}
