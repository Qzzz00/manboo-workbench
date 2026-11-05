/**
 * Claude 额度采集（响应头路）——**唯一实时的一条**。
 *
 * 前面三条路都不是实时的，各自断在别人手里（详见 docs/交接-0821-Claude额度延迟.md
 * 的「已经排除的」1–7）。真正的实时值只存在于 Anthropic 服务端，而客户端侧唯一的
 * 反映就是**每次推理请求的响应头**：
 *
 * ```
 * anthropic-ratelimit-unified-5h-utilization: 0.8          ← 0–1，已用比例
 * anthropic-ratelimit-unified-5h-reset:       1787292000   ← epoch 秒
 * anthropic-ratelimit-unified-7d-utilization: 0.19
 * anthropic-ratelimit-unified-7d-reset:       1787644800
 * ```
 *
 * 所以这里**自己发一条极小的推理请求，只为读它的响应头**。
 *
 * ## 凭据：`claude setup-token`，不是钥匙串里那个
 *
 * 官方命令 `claude setup-token` 签发一个长期 token（作用域 `user:inference`），
 * 专门给程序用。**不要**再去读钥匙串 `Claude Code-credentials`——2026-08-21 实测
 * 那个条目里的 accessToken / refreshToken 都已经被抹成空串。
 *
 * **不要打 `/api/oauth/usage`。** setup-token 没有 `user:profile` 作用域，打它是 403；
 * 而且那个端点本来就对 Max 用户凶狠限流（见交接文档已排除第 2 条）。
 *
 * 依据：steipete/CodexBar#1894（作者在四个订阅账号上验过）。
 * 本机验证 2026-08-21 11:31：响应头 5h 0.8 / 7d 0.19，与桌面端 Usage 页面
 * 「80% used / 19% used」、reset「14:00 / 周二 16:00」逐条吻合。
 *
 * ## 代价与边界
 *
 * - 每次约 1 个输出 token。对 Max 是零头，但**不是零**——测量本身会吃一点点额度。
 *   所以调用频率由 collector 控（Ben 定的 60 秒），这里不自带定时器。
 * - `max_tokens: 1` 会让回复在第一个 token 处被截断，那正是我们要的：只要头，不要内容。
 *   响应体一概不读、不记。
 * - **只有统一的订阅窗口**。桌面端 Usage 页面上那个按模型分的周窗口（如 Fable 18%）
 *   响应头里没有，别去猜。
 * - model id 会随版本下架，所以备了回退列表：一个 404/400 就换下一个。
 *
 * ## 纪律
 *
 * - token 只进请求头，**不进返回值、note、日志、错误信息**。
 * - 形状不对就抛错标"未接入"，绝不猜一个数出来。
 * - 留痕只记**头名**不记值（`note` 里那份就是头名清单）。
 */
import type { QuotaWindow, WindowQuota } from '../protocol.ts'
import type { FetchLike } from './deepseek.ts'
import { windowFromUsedPercentage } from './claude.ts'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

/**
 * 按新到旧试。model id 下架时上游回 404 `not_found_error`，换下一个即可。
 * 挑最便宜的打头——我们只要响应头，模型是什么无所谓。
 */
export const FALLBACK_MODELS: readonly string[] = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5',
  'claude-opus-5',
]

/** 响应头前缀 → 界面标签。顺序即展示顺序：短窗口在前，与另外两条路保持一致。 */
const WINDOWS: readonly (readonly [string, string])[] = [
  ['anthropic-ratelimit-unified-5h', '5h'],
  ['anthropic-ratelimit-unified-7d', '周'],
]

export interface ClaudeHeaderQuotaOptions {
  /** `claude setup-token` 签发的长期 token。只进请求头。 */
  token: string
  fetch?: FetchLike
  /** 覆盖回退列表，测试用。 */
  models?: readonly string[]
}

/** 只认 0–1 的比例。上游要是哪天改成 0–100，这里会抛错而不是把 80% 当成 0.8%。 */
function usedPercentFrom(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const ratio = Number(raw)
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return undefined
  return ratio * 100
}

function resetSecondsFrom(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

/**
 * 从响应头里翻出两个窗口。
 *
 * 两个都读不出来就抛错，由调用方降级——只读出一个也照样给，少一栏总比整格空掉强
 *（与 claudeDesktop.ts 同一取舍）。
 */
export function parseUnifiedRateLimitHeaders(headers: {
  get: (name: string) => string | null
}): WindowQuota {
  const windows: QuotaWindow[] = []
  const seen: string[] = []

  for (const [prefix, label] of WINDOWS) {
    const used = usedPercentFrom(headers.get(`${prefix}-utilization`))
    if (used === undefined) continue
    seen.push(`${prefix}-utilization`)

    const reset = resetSecondsFrom(headers.get(`${prefix}-reset`))
    if (reset !== undefined) seen.push(`${prefix}-reset`)
    windows.push(windowFromUsedPercentage(used, label, reset))
  }

  if (windows.length === 0) {
    throw new Error('响应里没有 anthropic-ratelimit-unified-*-utilization 头（上游改了？）')
  }

  // 留痕只记头名不记值：一栏静默消失和"上游改了头名"在界面上长得一样，
  // Kimi 那次就是靠这份清单才看清真相。
  return { kind: 'quota', windows, note: `响应头: ${seen.join(', ')}` }
}

/**
 * 这一把密钥**被上游拒了**(2026-10-03,卡「一键接上」第 3 条)。
 *
 * 为什么要把它单独标出来:401/403 与「网络抖了一下」在界面上长得一样 —— 都退回桌面端那份旧文件 ——
 * 可她要做的下一步完全不同(**再接一次**,而不是等它自己好)。过期的 token 永远不会自己好,
 * 闷声退回去的结果就是那一格挂着一个越来越旧的数、一句提示都没有。
 *
 * **只有每一次尝试都被拒才算**:其中一次是 404(model 下架)那种就不算 —— 那说明密钥是好的。
 */
export interface ClaudeKeyRejected { rejected?: true }

/** 这个错是「密钥被拒」吗。调用方(`quota/collect.ts`)据此换一句人话 + 把那颗「接上」键放回来。 */
export function claudeKeyRejected(error: unknown): boolean {
  return (error as ClaudeKeyRejected | undefined)?.rejected === true
}

/**
 * 发一条 1 token 的推理请求，只为读它的响应头。
 *
 * @throws 三个 model 都不成、或响应头里没有窗口时抛错，由调用方降级到本地文件那条路。
 *   错误上带 `rejected: true` = 这把密钥被拒了(见 `claudeKeyRejected`)。
 */
export async function fetchClaudeHeaderQuota(
  options: ClaudeHeaderQuotaOptions,
): Promise<WindowQuota> {
  const fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const models = options.models ?? FALLBACK_MODELS
  const failures: string[] = []
  /** 每次尝试的 HTTP 状态(发不出去的那次不记 —— 那是网络,不是密钥)。 */
  const statuses: number[] = []

  for (const model of models) {
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await fetchImpl(MESSAGES_URL, {
        method: 'POST',
        headers: {
          // token 只出现在这里。下面任何一条错误路径都不许把它带出去。
          'authorization': `Bearer ${options.token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
    }
    catch {
      // 网络抖动。别把 fetch 的错误原样抛出去——它可能把 URL 和头一起打出来。
      failures.push(`${model}: 请求发不出去`)
      continue
    }

    // 关键：**限流头在失败响应上也在**。429 的时候恰恰最该把数字读出来，
    // 所以先试着解析，解析不出来再按失败处理。
    try {
      return parseUnifiedRateLimitHeaders(responseHeaders(response))
    }
    catch {
      statuses.push(response.status)
      failures.push(`${model}: HTTP ${response.status}，响应头里没有窗口`)
    }
  }

  const failed: Error & ClaudeKeyRejected = new Error(`Claude 响应头取数失败（${failures.join('；')}）`)
  // 每一次都是 401/403 = 这把密钥被拒了(而不是某个 model 下架、或者网络抖了一下)。
  if (statuses.length > 0 && statuses.every(status => status === 401 || status === 403)) failed.rejected = true
  throw failed
}

/**
 * FetchLike 没约定 headers，但真实 fetch 和测试桩都给得出。
 * 拿不到就退化成"什么头都没有"，交给上面抛错——绝不猜。
 */
function responseHeaders(response: unknown): { get: (name: string) => string | null } {
  const headers = (response as { headers?: { get?: unknown } }).headers
  if (headers !== undefined && typeof headers.get === 'function') {
    return headers as { get: (name: string) => string | null }
  }
  return { get: () => null }
}
