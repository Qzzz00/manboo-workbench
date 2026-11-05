/**
 * 请求驱动的采样缓存(机器 / 角标 / 日历三格共用,2026-10-21 从三份同样的写法里收出来)。
 *
 * 三条规矩:
 * - **最短间隔内回缓存**,不管上次是正常值还是 `{ error }` —— 错误结果同样不该在窗口内被下一次请求重新触发一轮进程开销。
 * - **single-flight**(2026-08-21 真机实测补的):冷启动时展示台按 1 秒轮询 `GET /state`,第一秒内的并发请求共享正在跑的那一轮,
 *   不各自起一轮子进程。
 * - **过期了不让碰上的那一拍干等**(2026-10-21 急修「8791 空转」):当场回上一份、后台补采,补采完了下一拍就是新的。
 *   原来到点那一次 `/state` 要现场等 `df` + `top -l 1` + `sysctl` / `osascript` 跑完,机器一忙就是好几秒,网页那一拍整个停住。
 *   只有头一回(还没有上一份)才等它采完 —— 不编一个空的。
 */
export function createSampleCache<T>(
  sampleOnce: () => Promise<T>,
  now: () => number,
  minIntervalSec: number,
): () => Promise<T> {
  let cache: { at: number, sample: T } | undefined
  let inFlight: Promise<T> | undefined

  function refresh(nowSec: number): Promise<T> {
    if (inFlight !== undefined) return inFlight
    const promise = sampleOnce()
      .then((sample) => {
        cache = { at: nowSec, sample }
        return sample
      })
      .finally(() => { inFlight = undefined })
    inFlight = promise
    return promise
  }

  return async () => {
    const nowSec = now()
    if (cache !== undefined && nowSec - cache.at < minIntervalSec) return cache.sample
    if (cache === undefined) return await refresh(nowSec)
    // 后台补采失败(采样函数自己抛了)只是这一轮没换上,上一份照回。
    refresh(nowSec).catch(() => {})
    return cache.sample
  }
}
