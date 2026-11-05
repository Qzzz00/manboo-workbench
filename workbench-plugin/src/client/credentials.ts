/**
 * 工作台里填 API Key 的数据层（浏览器侧）。
 *
 * 纪律（AGENTS.md：不展示或写入凭据）：
 * - **只往外送，不往回取**。服务端的 GET 只回"配了没有"，这里也只保留两个布尔。
 *   界面永远不显示 Key，要改就重填一次。
 * - Key 不进任何错误信息、不进 state、不进 localStorage。
 * - 服务没起时当作"都没配"而不是报错：界面照常渲染，Ben 看到"未填"就知道该填。
 */
export type CredentialProvider =
  | 'deepseek' | 'kimi_web' | 'claude_api'
  // 零服务器档自带的钥匙(2026-10-21):搜索直连博查、电话里听懂说话直连火山识别(两格一对)。
  | 'bocha' | 'volc_asr_app_id' | 'volc_asr_access_token'

const PROVIDERS: readonly CredentialProvider[] = ['deepseek', 'kimi_web', 'claude_api', 'bocha', 'volc_asr_app_id', 'volc_asr_access_token']

export type CredentialStatusView = Record<CredentialProvider, boolean>

export const EMPTY_CREDENTIAL_STATUS: CredentialStatusView = Object.fromEntries(PROVIDERS.map(one => [one, false])) as CredentialStatusView

const EMPTY = EMPTY_CREDENTIAL_STATUS

function toView(body: unknown): CredentialStatusView {
  const raw = (body ?? {}) as Partial<Record<CredentialProvider, { configured?: unknown }>>
  return Object.fromEntries(PROVIDERS.map(one => [one, raw[one]?.configured === true])) as CredentialStatusView
}

export async function fetchCredentialStatus(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialStatusView> {
  try {
    const res = await fetchImpl(`${baseUrl}/credentials`)
    if (!res.ok) return EMPTY
    return toView(await res.json())
  }
  catch {
    return EMPTY
  }
}

/** 提交一家的 Key。空字符串＝清除这一家。 */
export async function submitCredential(
  baseUrl: string,
  provider: CredentialProvider,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialStatusView> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, key }),
    })
  }
  catch {
    // 底层错误信息可能把请求体（含 Key）带出来，这里一律换成自己的措辞。
    throw new Error('连不上工作台服务，Key 没有保存')
  }

  if (!res.ok) throw new Error(`保存失败：HTTP ${res.status}`)
  return toView(await res.json())
}

/** 一次登录抓取的进展。只有状态和人话，不含 Cookie。 */
export interface LoginProgressView {
  state: 'idle' | 'opening' | 'waiting' | 'done' | 'failed'
  message?: string
}

/** 让工作台开一个登录窗口。立刻返回——登录要花时间，进度另外轮询。 */
export async function startLogin(
  baseUrl: string,
  provider: 'kimi_web',
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    })
  }
  catch {
    throw new Error('连不上工作台服务，没能打开登录窗口')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `打开登录窗口失败：HTTP ${res.status}`)
  }
}

export async function fetchLoginProgress(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LoginProgressView> {
  try {
    const res = await fetchImpl(`${baseUrl}/login`)
    if (!res.ok) return { state: 'idle' }
    return await res.json() as LoginProgressView
  }
  catch {
    return { state: 'idle' }
  }
}

/** 手动兜底：他自己确认登录完了，让工作台立刻抓一次。 */
export async function captureLoginNow(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LoginProgressView> {
  const res = await fetchImpl(`${baseUrl}/login/capture`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `抓取失败：HTTP ${res.status}`)
  }
  return await res.json() as LoginProgressView
}

/** 放弃这一次登录，把状态清掉——否则界面会一直卡在"等你登录"。 */
export async function cancelLogin(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    await fetchImpl(`${baseUrl}/login/cancel`, { method: 'POST' })
  }
  catch {
    // 清不掉也不该把界面卡住，本地状态照样重置。
  }
}

/**
 * Claude 额度「一键接上」(2026-10-03,卡「不让用户知道什么叫 setup-token」)。
 *
 * 维护者原话:「你得考虑产品化啊,你不说我咋知道要咋弄啊。」她按一颗键,工作台自己去开浏览器
 * 让她用 Claude 账号授权一次,密钥由工作台自己收下 —— 界面上不出现终端、不出现那条命令的名字,
 * **也照旧不出现密钥**(这一层只收 state / message / 到期日)。
 */
export interface ClaudeConnectView {
  state: 'idle' | 'opening' | 'waiting' | 'done' | 'failed'
  message: string
  /** 这把密钥到哪天。读不到就缺席(界面那一行于是只写「实时」,不编一个日子)。 */
  expires_at?: string
}

const CONNECT_STATES: readonly ClaudeConnectView['state'][] = ['idle', 'opening', 'waiting', 'done', 'failed']

/**
 * 认一份进度。**认不出就当这台服务没接这条路**(回 undefined)——
 * 界面据此整颗键不画,只剩粘一串密钥那条退路。不摆一颗点了没用的按钮。
 */
function toConnectView(body: unknown): ClaudeConnectView | undefined {
  const raw = (body ?? {}) as { state?: unknown, message?: unknown, expires_at?: unknown }
  if (!CONNECT_STATES.includes(raw.state as ClaudeConnectView['state'])) return undefined
  return {
    state: raw.state as ClaudeConnectView['state'],
    message: typeof raw.message === 'string' ? raw.message : '',
    ...(typeof raw.expires_at === 'string' && raw.expires_at !== '' ? { expires_at: raw.expires_at } : {}),
  }
}

/** 这台服务接了这条路吗 + 此刻走到哪了。接不上 / 认不出 → undefined(整颗键不画)。 */
export async function fetchClaudeConnect(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaudeConnectView | undefined> {
  try {
    const res = await fetchImpl(`${baseUrl}/quota/connect/claude`)
    if (!res.ok) return undefined
    return toConnectView(await res.json())
  }
  catch {
    return undefined
  }
}

/** 按「接上」。立刻返回 —— 授权要她在浏览器里走几十秒到几分钟,进度另外轮询。 */
export async function startClaudeConnect(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaudeConnectView> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/quota/connect/claude`, { method: 'POST' })
  }
  catch {
    throw new Error('连不上工作台服务,没能开始')
  }
  const body = await res.json().catch(() => ({})) as { error?: string }
  if (!res.ok) throw new Error(body.error ?? `没能开始:HTTP ${res.status}`)
  return toConnectView(body) ?? { state: 'opening', message: '正在打开浏览器…' }
}

/** 放弃这一次:把子进程杀干净、状态清掉,否则界面会一直挂着「等你授权」。 */
export async function cancelClaudeConnect(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    await fetchImpl(`${baseUrl}/quota/connect/claude/cancel`, { method: 'POST' })
  }
  catch {
    // 清不掉也不该把界面卡住,本地状态照样重置。
  }
}
