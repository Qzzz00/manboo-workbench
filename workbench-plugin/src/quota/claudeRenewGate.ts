/**
 * OAuth 续期的失败退避闸门(2026-09-02 真机:面板 alert 长期停在
 * 「自动续期没成功:Claude 续期失败(HTTP 429)」)。
 *
 * ## 为什么非有不可
 *
 * 续期这条路原来是**无状态**的:access token 一过期,每轮采集(60 秒)都会尝试续一次。
 * 429 的意思是"你敲太快了",而我们的反应是下一分钟接着敲——永远待在惩罚里出不来。
 * 这与 claudeScopedGate 顶部记的那次事故是同一形状,只是这次落在 oauth/token 上,
 * 而且更值得当心:那条路撞的是读接口,这条路撞的是**认证端点**,撞多了有被上游
 * 进一步惩罚的风险。
 *
 * ## 退避策略
 *
 * 失败即进退避,并按连续失败次数指数增长(10 分钟 → 20 → 40 …,封顶 2 小时):
 * 429 越撞越久是限流的通行做法;而 400 invalid_grant 这类"这张 refresh token 已废"
 * 的失败,再快也换不出新 token,退避同样合理——两者都只有"人回来重新登录"才解得开。
 * 成功即清零:CLI 重新登录后下一次过期要能立刻续上,不该被上一轮的惩罚拖住。
 *
 * ## 为什么状态放在这里
 *
 * 同 claudeScopedGate 的理由:collect.ts 是"取一次数"的无状态层,跨轮次的记忆属于
 * 采集循环。做成可注入对象——生产在 collector 建一个每轮传入,不传就退回原来那套
 * 无状态行为(既有测试一行不用改)。
 */

/** 缺省首次退避:10 分钟。 */
const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000
/** 退避上限:2 小时。再久就该等人回来重新登录了,没必要退到天荒地老。 */
const MAX_INTERVAL_MS = 2 * 60 * 60 * 1000

export interface ClaudeRenewGate {
  /** 现在允不允许发起一次续期。false = 还在退避窗口里。 */
  shouldTry: (nowMs: number) => boolean
  /** 退避到期时刻(ms)——诊断/测试用。 */
  nextAllowedAtMs: () => number
  /** 退避期内该对用户说的话(上次失败原因的复述,不编新话)。 */
  waitingNote: () => string | undefined
  /** 续期失败:按次数指数退避,记住原因。 */
  onFailure: (nowMs: number, detail: string) => void
  /** 续期成功(或 CLI 抢先续上了):清零。 */
  onSuccess: (nowMs: number) => void
}

export interface ClaudeRenewGateOptions {
  minIntervalMs?: number
  maxIntervalMs?: number
}

export function createClaudeRenewGate(options: ClaudeRenewGateOptions = {}): ClaudeRenewGate {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const maxIntervalMs = options.maxIntervalMs ?? MAX_INTERVAL_MS

  let nextAllowed = 0
  let failures = 0
  let lastDetail: string | undefined

  return {
    shouldTry(nowMs) {
      return nowMs >= nextAllowed
    },
    nextAllowedAtMs() {
      return nextAllowed
    },
    waitingNote() {
      return lastDetail
    },
    onFailure(nowMs, detail) {
      failures += 1
      const backoff = Math.min(minIntervalMs * 2 ** (failures - 1), maxIntervalMs)
      nextAllowed = nowMs + backoff
      lastDetail = detail
    },
    onSuccess(nowMs) {
      failures = 0
      nextAllowed = nowMs
      lastDetail = undefined
    },
  }
}
