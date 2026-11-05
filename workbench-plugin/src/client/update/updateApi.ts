/**
 * 「更新」那一节跟服务端说话的三句(2026-09-18)。
 *
 * 纪律照 `client/setup/setupApi.ts`:**失败不静默**。Ben 正盯着一个按钮等结果,
 * 吞掉错误等于"点了没反应"(看板上那条 postSilently 的规矩在这里绝不适用)。
 *
 * 一处例外写在下面:`/update/check` 本身**不抛**没网 —— 服务端已经把"取不到清单"
 * 翻成一条带 `error` 的正常视图了,界面照着显示一句人话就好。
 */
import type { SetupJobView } from '../../server/setup/types.ts'
import type { UpdateChannel, UpdateCheckView, UpdateJobView } from '../../server/update/types.ts'

async function parse<T>(res: Response, what: string): Promise<T> {
  let body: unknown
  try { body = await res.json() }
  catch { throw new Error(`${what}:服务端回的不是 JSON(HTTP ${res.status})`) }
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error
    throw new Error(typeof error === 'string' ? error : `${what}失败(HTTP ${res.status})`)
  }
  return body as T
}

export async function checkUpdate(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<UpdateCheckView> {
  return await parse<UpdateCheckView>(await fetchImpl(`${baseUrl}/update/check`), '检查更新')
}

export async function applyUpdate(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<UpdateJobView> {
  const res = await fetchImpl(`${baseUrl}/update/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  return await parse<UpdateJobView>(res, '开始更新')
}

/**
 * 查进度。走的是**登录台那条一模一样的路**(`/setup/install/:job` 两边的 id 都认),
 * 所以进度框那个组件、那套 1 秒轮询,一份代码两处用。
 */
export async function fetchUpdateJob(baseUrl: string, id: string, fetchImpl: typeof fetch = fetch): Promise<UpdateJobView> {
  return await parse<UpdateJobView>(await fetchImpl(`${baseUrl}/update/job/${encodeURIComponent(id)}`), '查更新进度')
}

/**
 * 「装运行环境」那颗按钮(2026-09-26,卡 U6)。
 *
 * **不走 `/update/apply`**:这一趟不联网、不要清单 —— 要装的东西与判据都在本机
 * (见 server/setup/runtimeRepair.ts)。回的是 `SetupJobView`,所以进度照登录台那条路
 * (`/setup/install/:job`,`client/setup/setupApi.ts` 的 `fetchSetupJob`)去问。
 */
export async function installRuntime(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<SetupJobView> {
  const res = await fetchImpl(`${baseUrl}/update/runtime`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  return await parse<SetupJobView>(res, '装运行环境')
}

/** 切更新通道(2026-10-21)。回的是按新通道查的那一趟,界面直接拿它重画。 */
export async function setUpdateChannel(baseUrl: string, channel: UpdateChannel, fetchImpl: typeof fetch = fetch): Promise<UpdateCheckView> {
  const res = await fetchImpl(`${baseUrl}/update/channel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel }),
  })
  return await parse<UpdateCheckView>(res, '切更新通道')
}
