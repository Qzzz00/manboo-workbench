/**
 * ★ **巡登记表:哪条会话醒过来了,就把排着的那几件重送**(2026-10-23,
 * 卡「捎话到没开着的会话留言等它醒」)。
 *
 * 与 {@link ../screenLockWatch.ts `screenLockWatch`} 同款的一拍:
 * 挂在 `http.ts` 那根**既有的 1 秒节拍**上,内部限频({@link SESSION_AWAKE_POLL_MS})。
 *
 * ## 为什么要有这一拍
 *
 * 07:36 那三下送到的是一条**没在跑**的会话(进程 07:37 才起)。留言排进队之后,不能只靠人
 * 再捎一次 —— 那条会话一醒(登记表里出现它的 socket),就把排着的那几句**按原顺序送进去**。
 * 判据是登记表上的事实({@link ./lockQueue.ts `drainLockQueue`} 的 `shouldSend`,接线那一处给:
 * `engine/adapters/claude.ts` 的 `claudeSessionOpen`),**不按排了多久猜**。
 *
 * ## 三条纪律(与 `screenLockWatch` 同款)
 *
 * - **只重送醒过来的那一条会话的留言**:排着的那几条里,别的会话的照旧留着(下一拍再看);
 *   锁着屏那一路(等解锁的)不归这一拍 —— 它由 `screenLockWatch` 管;
 * - **一次只跑一轮重送**:上一轮没走完的后续节拍直接跳过(不然两条 drain 会同时送同一条);
 * - **起服务那一下也要跑一轮**:盘上那本队可能是上一回「没开着」时排下的(落盘,重启不丢)。
 */
import type { LockDrainReport } from './engine/lockQueue.ts'

/** 多久巡一次登记表(毫秒)。那条会话醒了之后,最多迟这么久才送进去。 */
export const SESSION_AWAKE_POLL_MS = 5000

/** 巡登记表那一拍开始重送时记的那一行(断言照常量,不逐字抄中文)。 */
export const SESSION_AWAKE_LOG = '[留言] 巡登记表:哪条会话的 socket 在了,把排着的那几件按原顺序重送'

export interface SessionAwakeWatchDeps {
  /**
   * 这一轮把排着的那几件里**醒过来的那条会话**的留言重送
   * (`engine/lockQueue.drainLockQueue` + `shouldSend` 过滤)。
   *
   * 回那一轮的结果:`kept > 0` = 还有留着的(别的会话还睡着 / 被闸拦下)→ 下一拍再来一轮,
   * 不用等下一次醒(不然那几条会一直躺着)。回 `undefined` = 不知道,按「没留」算。
   */
  drain: () => Promise<LockDrainReport | undefined>
  now?: () => number
  pollMs?: number
  /** 记一行(缺席 = 不记)。 */
  warn?: (line: string) => void
}

export interface SessionAwakeWatch {
  /** 走一拍(挂在 1 秒节拍上;内部限频)。**绝不抛**。 */
  pump: () => Promise<void>
}

export function createSessionAwakeWatch(deps: SessionAwakeWatchDeps): SessionAwakeWatch {
  const now = deps.now ?? (() => Date.now())
  const pollMs = deps.pollMs ?? SESSION_AWAKE_POLL_MS
  const warn = deps.warn ?? ((): void => {})
  let ranAt = 0
  let draining = false

  return {
    async pump() {
      if (draining) return
      const at = now()
      if (ranAt !== 0 && at - ranAt < pollMs) return
      ranAt = at
      draining = true
      try {
        await deps.drain()
      }
      catch (error) {
        warn(`[留言] 重送那一轮出错:${error instanceof Error ? error.message : String(error)}`)
      }
      finally { draining = false }
    },
  }
}
