/**
 * DeepSeek 余额查询（PRD §8.2）。
 *
 * 官方只有 `GET /user/balance` 这一个口子，返回 `is_available` 与 `balance_infos`
 * （币种 / 总余额 / 赠送余额 / 充值余额）。没有用量统计接口，所以这里只产出余额，
 * "今日消耗"由 dailySpend.ts 从两次读数推。
 *
 * 两条硬要求：
 * - API Key 只从环境变量进来，绝不落到日志、错误信息或返回值里。所有抛出的错误都过 `redact`。
 * - 拿不到 `balance_infos` 就报错，不编一个 0 出来（界面显示 0 会让人以为真没钱了）。
 */
import type { BalanceQuota } from '../protocol.ts'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** 最小化的 fetch 返回值形状，测试可以注入桩，实现里不依赖 DOM 的 Response。 */
export interface FetchLikeResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}

/** 可注入的 fetch。测试一律注入桩，不打真实网络。 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchLikeResponse>

export interface DeepSeekBalanceOptions {
  /** 只从环境变量取，调用方负责别把它写进文件。 */
  apiKey: string
  fetch: FetchLike
  /** 账号可能同时有多个币种，优先取这个；取不到就退回第一条。 */
  preferredCurrency?: string
}

interface BalanceInfo {
  currency?: unknown
  total_balance?: unknown
}

/** 把可能夹带 key 的文本抹掉，任何往外抛的字符串都要走这里。 */
function redact(text: string, apiKey: string): string {
  if (!apiKey) return text
  return text.split(apiKey).join('***')
}

function isBalanceInfo(value: unknown): value is BalanceInfo {
  return typeof value === 'object' && value !== null
}

/** 查一次账号余额，产出 BalanceQuota。失败一律抛错，由调用方降级成 UnknownQuota。 */
export async function fetchDeepSeekBalance(options: DeepSeekBalanceOptions): Promise<BalanceQuota> {
  const { apiKey, fetch: fetchImpl, preferredCurrency } = options

  let response: FetchLikeResponse
  try {
    response = await fetchImpl(BALANCE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    })
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`DeepSeek 余额查询失败：${redact(reason, apiKey)}`)
  }

  // 只报状态码，不回显响应体——响应体有可能把请求头原样带回来。
  if (!response.ok) throw new Error(`DeepSeek 余额查询失败：HTTP ${response.status}`)

  let body: unknown
  try {
    body = await response.json()
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`DeepSeek 余额响应不是合法 JSON：${redact(reason, apiKey)}`)
  }

  if (typeof body !== 'object' || body === null) {
    throw new Error('DeepSeek 余额响应格式异常：不是对象')
  }

  const payload = body as { is_available?: unknown, balance_infos?: unknown }
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos.filter(isBalanceInfo) : []
  if (infos.length === 0) {
    throw new Error('DeepSeek 余额响应缺少 balance_infos，拒绝编造余额')
  }

  const matched = preferredCurrency
    ? infos.find(info => info.currency === preferredCurrency)
    : undefined
  const picked = matched ?? infos[0]
  if (!picked) throw new Error('DeepSeek 余额响应缺少 balance_infos，拒绝编造余额')

  const currency = typeof picked.currency === 'string' ? picked.currency : ''
  const total = typeof picked.total_balance === 'string'
    ? picked.total_balance
    : typeof picked.total_balance === 'number'
      ? picked.total_balance.toFixed(2)
      : undefined

  if (!currency || total === undefined) {
    throw new Error('DeepSeek 余额响应缺少 balance_infos 中的币种或总余额')
  }

  return {
    kind: 'balance',
    currency,
    total,
    available: payload.is_available === true,
  }
}
