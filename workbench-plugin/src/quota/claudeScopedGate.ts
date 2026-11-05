/**
 * 按模型周窗口(Fable / Opus …)那条路的限频闸门 + 缓存。
 *
 * ## 为什么非有不可(2026-08-26 真机根因)
 *
 * claudeScoped.ts 自己的注释早就写着「这个端点不是给高频轮询用的」,但采集器那头
 * 的 60 秒快路跑的是**整轮采集**——里头就包含这个端点。于是它被每分钟打一次。
 * 实测该端点的惩罚窗口 `retry-after: 161` 秒:60 秒就再问一次,等于惩罚还没到期
 * 又去敲门,**永远待在惩罚里出不来**。返回恒定 429,而 429 在调用方被归进
 * 「限流、网络抖动,下一轮自己会好」那一档静默丢弃——"下一轮"正是让它好不了的原因。
 * 结果就是 Fable 那一栏无声无息地消失,界面上没有任何痕迹可查。
 *
 * 判据(同日实测,可复现):同一个 token 打这个端点回 429 且带 retry-after;
 * 换一个明显无效的 token 打回的是 401 authentication_error。两者形状不同,
 * 所以那 429 是**货真价实的频率限流**,不是认证问题。
 *
 * ## 为什么限频必须和缓存绑在一起
 *
 * 只限频不缓存会更糟:采集器仍每分钟跑一轮,十五轮里十四轮拿不到窗口,
 * 那一栏就变成每分钟闪断一次。所以闸门在限频期内要继续交出上次取到的窗口。
 * 周窗口一周才变一次,陈旧几分钟没有任何代价;整栏消失才是真问题。
 * 这跟采集器里 GRACE_ROUNDS「保住上次已知值,别让一次抖动把整格打成未接入」
 * 是同一条纪律,只是粒度落到单条采集路上。
 *
 * ## 为什么状态放在这里而不是 collect.ts
 *
 * collect.ts 是「取一次数」的无状态层,测试全靠它无状态才好写。跨轮次的记忆
 * (上次何时打过、上次取到什么)属于采集**循环**,和 collector.ts 里已有的
 * failures / spend 是同一类东西。闸门因此做成可注入对象:生产在 collector 里
 * 建一个、每轮传进去;不传就退回原来那套无状态行为,既有测试一个字节不用改。
 */
import type { QuotaWindow } from '../protocol.ts'

/** 缺省限频间隔:15 分钟。周窗口一周才变一次,再密没有意义,只会重新招来限流。 */
const DEFAULT_MIN_INTERVAL_MS = 15 * 60 * 1000

/**
 * **手上还有窗口可交**时,连续失败到第几轮才出声。
 * 那种情况下界面并没有少一栏,只是数据可能陈旧,1 轮就报会被网络抖动刷屏。
 */
const NOTE_AFTER_FAILURES = 2

/** 一栏都交不出时那句话。要说清楚**少的是哪一栏**,否则看的人不知道界面缺了什么。 */
const MISSING_NOTE = 'Fable 等按模型窗口暂缺:用量端点取不到(已退避,稍后自动重试)'

/** 还能交出旧窗口时那句话:栏没少,只是可能不是最新的。 */
const STALE_NOTE = 'Fable 等按模型窗口暂用上次取到的值:用量端点连续取不到'

export interface ClaudeScopedOutcome {
  windows: QuotaWindow[]
  note?: string
}

export interface ClaudeScopedFailure {
  /** 429 的 `retry-after`(秒)。端点说了等多久就等多久,不自作主张提前去撞。 */
  retryAfterSec?: number
  /** 值得当场顶到界面上的话术(目前只有 403「要重新登录」那一种)。 */
  note?: string
}

export interface ClaudeScopedGate {
  /**
   * 当前毫秒时刻。时钟归闸门自己管——调用方(collect.ts)是无状态层,
   * 不该另外持有一份时间源,否则两处时钟不一致会算错退避。
   */
  nowMs: () => number
  /** 现在该不该真去打端点。false = 用缓存顶上。 */
  shouldFetch: (nowMs: number) => boolean
  /** 此刻能交出的东西(限频期内走这条)。 */
  cached: () => ClaudeScopedOutcome
  /** 取到了:换上新窗口、清掉诊断话术、进入限频期。 */
  onSuccess: (nowMs: number, windows: QuotaWindow[]) => ClaudeScopedOutcome
  /** 没取到:按 retry-after 退避,保住上次窗口,连续失败够多轮就带上诊断话术。 */
  onFailure: (nowMs: number, failure: ClaudeScopedFailure) => ClaudeScopedOutcome
}

export interface ClaudeScopedGateOptions {
  minIntervalMs?: number
  /** 当前毫秒时刻。生产用 Date.now,测试注入可控时钟。 */
  now?: () => number
}

export function createClaudeScopedGate(options: ClaudeScopedGateOptions = {}): ClaudeScopedGate {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS

  let nextAllowedAtMs = 0
  let windows: QuotaWindow[] = []
  let note: string | undefined
  let failures = 0

  const snapshot = (): ClaudeScopedOutcome => ({
    windows: [...windows],
    ...(note === undefined ? {} : { note }),
  })

  const now = options.now ?? (() => Date.now())

  return {
    nowMs: now,

    shouldFetch(nowMs) {
      return nowMs >= nextAllowedAtMs
    },

    cached: snapshot,

    onSuccess(nowMs, fresh) {
      windows = [...fresh]
      note = undefined
      failures = 0
      nextAllowedAtMs = nowMs + minIntervalMs
      return snapshot()
    },

    onFailure(nowMs, failure) {
      failures += 1
      // 端点给了 retry-after 就听它的,但不短于限频间隔——刚解禁就再去撞
      // 只会把惩罚续上,那正是这次事故的成因。
      const backoffMs = Math.max(minIntervalMs, (failure.retryAfterSec ?? 0) * 1000)
      nextAllowedAtMs = nowMs + backoffMs
      // 出声的时机按「界面上到底缺没缺东西」来定,这才是那条纪律的本意:
      // - 403「要重新登录」:当场就报,它不会自己好,等下去只是白白多瞒一轮。
      // - 手上一个窗口都没有 → **那一栏真的空了**,第一次失败就得出声。
      //   2026-08-26 实测 retry-after 会一路涨到 2730 秒(45 分钟),攒两轮再报
      //   等于让人对着一栏空白干等三刻钟,那正是这次事故里最难查的部分。
      // - 还能交出上次的窗口 → 栏没少,只是可能陈旧,攒够两轮再提，免得抖一下就留话。
      note = failure.note
        ?? (windows.length === 0
          ? MISSING_NOTE
          : failures >= NOTE_AFTER_FAILURES ? STALE_NOTE : undefined)
      return snapshot()
    },
  }
}
