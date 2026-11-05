/**
 * 「模型服务」那一节的数据层(浏览器侧)。
 *
 * 纪律同 credentials.ts:**只往外送,不往回取**。服务端的 GET 里本来就没有凭证
 * (只有「领到了没有」与两个数字),这里也不保留任何看起来像钥匙的东西。
 *
 * 服务没起、路由没启用(旧版本插件)时一律当作「用工作台提供的服务、还没接上」,
 * 界面照常渲染 —— 这一节不该因为拉不到状态就整块消失。
 */
export type ModelMode = 'relay' | 'own'

export interface ModelUsageView {
  day: string
  used_tokens: number
  daily_token_limit: number
  remaining_tokens: number
  /** 2026-09-23 起中转按元算额度。老中转没有这三格 → 界面回退显示 token 数。 */
  used_cny?: number
  daily_cost_limit_cny?: number
  remaining_cny?: number
}

export interface ModelStatusView {
  mode: ModelMode
  relay_url: string
  relay_token_configured: boolean
  own_key_configured: boolean
  /** own 档自己接的端点:地址与模型名(2026-10-23)。都不是秘密,预填那两格用。 */
  own_base_url: string
  own_model: string
  ready: boolean
  usage?: ModelUsageView
  usage_error?: string
  /** 这台接没接中转(2026-10-21)。只有服务端明说 false 才算没接;缺席(老插件)= 按接了。 */
  relay_configured?: boolean
  /** 服务端压根没开这一节(旧插件)。界面据此提示「升级一下工作台」。 */
  unavailable?: boolean
}

export const EMPTY_MODEL_STATUS: ModelStatusView = {
  mode: 'relay',
  relay_url: '',
  relay_token_configured: false,
  own_key_configured: false,
  own_base_url: '',
  own_model: '',
  ready: false,
}

function toView(body: unknown): ModelStatusView {
  const raw = (body ?? {}) as Record<string, unknown>
  const usage = raw.usage as Record<string, unknown> | undefined
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    mode: raw.mode === 'own' ? 'own' : 'relay',
    relay_url: typeof raw.relay_url === 'string' ? raw.relay_url : '',
    ...(raw.relay_configured === false ? { relay_configured: false } : {}),
    relay_token_configured: raw.relay_token_configured === true,
    own_key_configured: raw.own_key_configured === true,
    own_base_url: typeof raw.own_base_url === 'string' ? raw.own_base_url : '',
    own_model: typeof raw.own_model === 'string' ? raw.own_model : '',
    ready: raw.ready === true,
    ...(usage === undefined ? {} : {
      usage: {
        day: typeof usage.day === 'string' ? usage.day : '',
        used_tokens: num(usage.used_tokens),
        daily_token_limit: num(usage.daily_token_limit),
        remaining_tokens: num(usage.remaining_tokens),
        ...(typeof usage.daily_cost_limit_cny === 'number' && Number.isFinite(usage.daily_cost_limit_cny)
          ? {
              used_cny: num(usage.used_cny),
              daily_cost_limit_cny: usage.daily_cost_limit_cny,
              remaining_cny: num(usage.remaining_cny),
            }
          : {}),
      },
    }),
    ...(typeof raw.usage_error === 'string' ? { usage_error: raw.usage_error } : {}),
  }
}

export async function fetchModelStatus(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelStatusView> {
  try {
    const res = await fetchImpl(`${baseUrl}/model`)
    if (res.status === 404) return { ...EMPTY_MODEL_STATUS, unavailable: true }
    if (!res.ok) return EMPTY_MODEL_STATUS
    return toView(await res.json())
  }
  catch {
    return EMPTY_MODEL_STATUS
  }
}

export interface ModelUpdateView {
  status: ModelStatusView
  hints: string[]
}

async function post(
  baseUrl: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<ModelUpdateView> {
  let res: Response
  try { res = await fetchImpl(`${baseUrl}${path}`, init) }
  catch { throw new Error('连不上工作台服务,这次没有改成') }
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : `改不成:HTTP ${res.status}`)
  return {
    status: toView(body.status),
    hints: Array.isArray(body.hints) ? body.hints.filter((h): h is string => typeof h === 'string') : [],
  }
}

export async function switchModelMode(
  baseUrl: string,
  mode: ModelMode,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelUpdateView> {
  return post(baseUrl, '/model', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  }, fetchImpl)
}

export async function reissueModelToken(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelUpdateView> {
  return post(baseUrl, '/model/reissue', { method: 'POST' }, fetchImpl)
}

/**
 * 保存 own 档自己接的端点(2026-10-23,卡「事务官换Key」):地址与模型名。
 * 两颗都非秘密;Key 不从这里走(各家的登录与密钥那一节)。
 */
export async function updateOwnModel(
  baseUrl: string,
  patch: { own_base_url?: string, own_model?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ModelUpdateView> {
  return post(baseUrl, '/model', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'own', ...patch }),
  }, fetchImpl)
}

/** 「试一下」:打一句话回来。message 是模型的半句话或一句人话错因,不含任何凭证。 */
export async function tryModel(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean, message: string }> {
  let res: Response
  try { res = await fetchImpl(`${baseUrl}/model/try`, { method: 'POST' }) }
  catch { throw new Error('连不上工作台服务,这次没能试') }
  const body = await res.json().catch(() => ({})) as { ok?: unknown, message?: unknown }
  if (!res.ok) throw new Error(typeof body.message === 'string' ? body.message : `试不成:HTTP ${res.status}`)
  return { ok: body.ok === true, message: typeof body.message === 'string' ? body.message : '' }
}

/**
 * 顶上那条「模型服务还没接上」横幅里的**重试**(2026-09-18)。
 *
 * 走 `/model/auto-setup` 而不是 `/model/reissue`:重试要**守住同一条判据** ——
 * 他要是在这中间自己填了 DeepSeek Key、或者手动切成了「用我自己的账号」,这一下就什么都不该做。
 * reissue 是"不管三七二十一重领一把",那是设置里那颗按钮的语义,不是横幅的。
 */
export async function retryModelAutoSetup(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelUpdateView> {
  return post(baseUrl, '/model/auto-setup', { method: 'POST' }, fetchImpl)
}

/** 「今天用了 3.2 万 / 5 万」里那两个数字怎么写成人话。 */
export function formatTokens(value: number): string {
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')} 万`
  return String(value)
}

/** 「¥0.38」「¥5」:上限写干净,已花写到分。 */
export function formatCny(value: number, cents = false): string {
  if (cents) return `¥${value.toFixed(2)}`
  return `¥${String(Math.round(value * 100) / 100)}`
}

/**
 * 用量那一行的两句话。中转给了元就说钱(维护者 09-23:用户只在乎花了多少钱),
 * 老中转没有元字段就回退成原来的 token 说法。
 */
export function usageLines(usage: ModelUsageView): { used: string, limit: string } {
  if (usage.daily_cost_limit_cny !== undefined) {
    return {
      used: `今天花了 ${formatCny(usage.used_cny ?? 0, true)}`,
      limit: `上限 ${formatCny(usage.daily_cost_limit_cny)}`,
    }
  }
  return {
    used: `今天已经用了 ${formatTokens(usage.used_tokens)}`,
    limit: `今日上限 ${formatTokens(usage.daily_token_limit)}`,
  }
}

/** 今天的额度用完了没有。按元的中转看 remaining_cny,老中转看 remaining_tokens。 */
export function usageExhausted(usage: ModelUsageView): boolean {
  if (usage.daily_cost_limit_cny !== undefined) return (usage.remaining_cny ?? 0) <= 0
  return usage.remaining_tokens === 0
}

/** 用量条的百分比,0–100,越界夹住。有元按元算,没有按 token。 */
export function usagePercent(usage: ModelUsageView): number {
  const [used, limit] = usage.daily_cost_limit_cny !== undefined
    ? [usage.used_cny ?? 0, usage.daily_cost_limit_cny]
    : [usage.used_tokens, usage.daily_token_limit]
  if (limit <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)))
}
