/**
 * 接话模型的 key 从哪来。**只读、只在内存里**:
 *
 *   1. 环境变量 `DEEPSEEK_API_KEY`(统筹会话临时跑一次用这个,最不留痕);
 *   2. `~/.dsh/workbench/credentials.json` 的 `keys.deepseek` —— 工作台设置里那一格填的就是它
 *      (workbench-plugin/src/server/credentials.ts,权限 0600)。任务卡里写的 `~/.dsh/settings.yaml`
 *      在本机实测**没有**这个字段(那份只有 ui-onboarding 与 agent-default-model),真相在 credentials.json。
 *
 * 两处都没有就返回 undefined ——**不去 DSH 运行时里翻**,那里面是 DSH 自己的登录态,不是
 * api.deepseek.com 的 key,拿来当 Bearer 只会得到一串 401。没有 key 时工人照常起,只是
 * 接不了话:`/channel/status` 与日志都会如实说「没有接话模型的 key」。
 *
 * 纪律:这个模块**只回 key 本身**,绝不打印、绝不写文件、绝不进任何回给房间的消息。
 * 想知道「配了没有」用 `deepseekKeyConfigured()`,它只回布尔。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 工作台存凭据的地方(与 workbench-plugin 的 defaultCredentialFile 同一处)。 */
export function defaultCredentialsFile(home: string = homedir()): string {
  return join(home, '.dsh', 'workbench', 'credentials.json')
}

/** credentials.json 文本 → deepseek 的 key。坏 JSON、缺字段都只是「没有」,不抛。 */
export function deepseekKeyOfCredentials(text: string): string | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(text) as unknown }
  catch { return undefined }
  const keys = (parsed as { keys?: unknown } | null)?.keys
  const key = (keys as { deepseek?: unknown } | null)?.deepseek
  return typeof key === 'string' && key.trim() !== '' ? key.trim() : undefined
}

export interface DeepseekKeyDeps {
  env?: Record<string, string | undefined>
  credentialsFile?: string
  readFileImpl?: (file: string) => Promise<string>
}

export async function loadDeepseekKey(deps: DeepseekKeyDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env
  const fromEnv = env.DEEPSEEK_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const read = deps.readFileImpl ?? ((file: string) => readFile(file, 'utf8'))
  try {
    return deepseekKeyOfCredentials(await read(deps.credentialsFile ?? defaultCredentialsFile()))
  }
  catch {
    // 第一次用本来就没有这个文件,不是错误。
    return undefined
  }
}

/** 只回「配了没有」。日志、状态、给房间的消息里只允许出现这个。 */
export async function deepseekKeyConfigured(deps: DeepseekKeyDeps = {}): Promise<boolean> {
  return (await loadDeepseekKey(deps)) !== undefined
}
