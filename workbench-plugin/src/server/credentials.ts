/**
 * 凭据存储：Ben 在工作台里填 API Key，存到这里，额度采集从这里取。
 *
 * AGENTS.md 写死「不展示或写入 API Key、密码、Cookie、Token 或其他凭据」。
 * 这条约束在这里的落法是：
 *
 * - **只存一处**，`~/.dsh/workbench/credentials.json`，**权限 0600**。不进仓库、
 *   不进 DSH 的会话日志、不进任何 note 或错误信息。
 * - **永不回显**。给浏览器的只有 `credentialStatus()`——它只回"配了没有"，
 *   连长度和前缀都不给。要改就重填一次，不提供"看一眼当前值"。
 * - 文件读坏了返回空而不是抛：一份坏掉的凭据文件不该把整台服务带走，
 *   界面会因此显示"未配置"，那正是此时的真实状态。
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 需要凭据才能取数的三家。Codex 读本地文件，不需要。
 *
 * - `deepseek`：官方 API Key（官方只开放 /user/balance 这一个口子，没有别的路）。
 * - `kimi_web`：网页端的 authorization 头（登录时拦一次真实请求抓到的）。
 *   **不是** cookie——那个接口光有 cookie 会 401；也**不是** `sk-kimi-` 那个 Coding Plan Key——
 *   那个只能拿到 Code 部分的窗口，拿不到「Kimi + Code 合并」的总使用量，
 *   而总量才是先见底的那个数。
 * - `claude_api`：`claude setup-token` 签发的长期 token（作用域 `user:inference`）。
 *   拿它发一条 1 token 的推理请求，只为读响应头里的实时窗口（见 quota/claudeHeaders.ts）。
 *   **不是**钥匙串 `Claude Code-credentials` 里那个——2026-08-21 实测那里面已经被抹空。
 *   Claude 这一格没它也能显示（退回桌面端那份 15 分钟的本地文件），只是不实时。
 */
export type CredentialProvider =
  | 'deepseek' | 'kimi_web' | 'claude_api'
  | 'bocha' | 'volc_asr_app_id' | 'volc_asr_access_token'

/**
 * 后三格是「零服务器档」自带的钥匙(2026-10-21,局域网 M7):没接中转时搜索直连博查(`bocha`)、
 * 电话里听懂说话直连火山识别(`volc_asr_app_id` + `volc_asr_access_token`,两格都填才算有,见 {@link volcAsrOf})。
 * 接了中转的机器填了也先用自己的。
 */
export const CREDENTIAL_PROVIDERS: readonly CredentialProvider[] = [
  'deepseek', 'kimi_web', 'claude_api', 'bocha', 'volc_asr_app_id', 'volc_asr_access_token',
]

export type Credentials = Partial<Record<CredentialProvider, string>>

/** 能安全发给浏览器的形状：只有"配了没有"。 */
export type CredentialStatus = Record<CredentialProvider, { configured: boolean }>

export function isCredentialProvider(value: unknown): value is CredentialProvider {
  return typeof value === 'string' && CREDENTIAL_PROVIDERS.includes(value as CredentialProvider)
}

/** 默认落盘位置：跟 DSH 的其它本机状态放一起，不进仓库。 */
export function defaultCredentialFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/credentials.json`
}

export async function loadCredentials(file: string): Promise<Credentials> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    // 第一次用本来就没有这个文件，不是错误。
    return {}
  }

  try {
    const parsed = JSON.parse(text) as { keys?: unknown }
    if (typeof parsed !== 'object' || parsed === null) return {}
    const keys = parsed.keys
    if (typeof keys !== 'object' || keys === null) return {}

    const out: Credentials = {}
    for (const provider of CREDENTIAL_PROVIDERS) {
      const value = (keys as Record<string, unknown>)[provider]
      if (typeof value === 'string' && value !== '') out[provider] = value
    }
    return out
  }
  catch {
    // 文件被写坏了。返回空 = 界面显示"未配置"，那正是此刻的真实状态。
    return {}
  }
}

/** 存一家的 Key。传空字符串＝清除这一家。写完把权限收到 0600。 */
export async function saveCredential(
  file: string,
  provider: CredentialProvider,
  key: string,
): Promise<void> {
  const current = await loadCredentials(file)
  const next: Credentials = { ...current }
  if (key === '') delete next[provider]
  else next[provider] = key

  await mkdir(dirname(file), { recursive: true })
  // 文件里只有 keys 这一个字段。不写时间戳、不写来源、不写任何可能被顺手打进日志的东西。
  await writeFile(file, `${JSON.stringify({ keys: next }, null, 2)}\n`, { mode: 0o600 })
  // writeFile 的 mode 只在新建时生效，已存在的文件要显式收一次。
  await chmod(file, 0o600)
}

/** 火山识别那一对。两格都填了才回;只交给回环上的通话工人(`/channel/credentials`)。 */
export function volcAsrOf(credentials: Credentials): { app_id: string, access_token: string } | undefined {
  const appId = credentials.volc_asr_app_id
  const token = credentials.volc_asr_access_token
  return appId === undefined || token === undefined ? undefined : { app_id: appId, access_token: token }
}

/** 给浏览器看的状态。绝不包含 Key 本身。 */
export async function credentialStatus(file: string): Promise<CredentialStatus> {
  const credentials = await loadCredentials(file)
  return Object.fromEntries(
    CREDENTIAL_PROVIDERS.map(provider => [provider, { configured: credentials[provider] !== undefined }]),
  ) as CredentialStatus
}
