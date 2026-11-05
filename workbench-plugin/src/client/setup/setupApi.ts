/**
 * 初始化页跟服务端说话的那几句(2026-09-17)。
 *
 * 两条纪律:
 * - **失败不静默**:这一页跟看板不一样 —— 看板的规矩是"失败了等下一拍轮询"(postSilently),
 *   而这里 Ben 正盯着一个按钮等结果,吞掉错误等于"点了没反应"。所以这里每个函数要么回
 *   结果、要么抛,由组件把话显示出来。
 * - **卡 C 的接口按契约调**:`/config/paths` 与 `/config/hooks` 是另一张卡在做的
 *   (2026-09-17 并行)。它还没合并时服务端会回 404 —— 这里把 404 翻成
 *   `{ pending: true }`,界面据此显示"这一步等另一半合并",而不是报一个吓人的错。
 */
import type { DiagSendView, DiagSettingsView, FeedbackListView } from '../../diag.ts'
import type { SetupApkView, SetupInstallStep, SetupJobView, SetupPane, SetupStatus } from '../../server/setup/types.ts'
import { CodedError } from '../ErrorNote.tsx'

/**
 * 服务端回的错 → 一个**带编号**的 Error(2026-09-22)。
 *
 * `/setup/*`、`/update/*`、`/diag/*` 上的错误从这一版起回 `{ error, code }`
 * (server/http.ts 的 `sendCodedError`),同一个编号也写进了本机日志。
 * 这里把它原样带上去,界面上 `ErrorNote` 显示成「…… 编号 WB-123456」。
 *
 * 老服务端(没有 `code`)照样能用:那一格缺席,界面就不显示编号 —— **不编一个出来**。
 */
async function parse<T>(res: Response, what: string): Promise<T> {
  let body: unknown
  try { body = await res.json() }
  catch { throw new CodedError(`${what}:服务端回的不是 JSON(HTTP ${res.status})`) }
  if (!res.ok) {
    const raw = (body ?? {}) as { error?: unknown, code?: unknown }
    const message = typeof raw.error === 'string' ? raw.error : `${what}失败(HTTP ${res.status})`
    throw new CodedError(message, typeof raw.code === 'string' ? raw.code : undefined)
  }
  return body as T
}

export async function fetchSetupStatus(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<SetupStatus> {
  return await parse<SetupStatus>(await fetchImpl(`${baseUrl}/setup/status`), '就绪检查')
}

export async function startSetupInstall(baseUrl: string, step: SetupInstallStep, fetchImpl: typeof fetch = fetch): Promise<SetupJobView> {
  const res = await fetchImpl(`${baseUrl}/setup/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step }),
  })
  return await parse<SetupJobView>(res, '开始安装')
}

export async function fetchSetupJob(baseUrl: string, id: string, fetchImpl: typeof fetch = fetch): Promise<SetupJobView> {
  return await parse<SetupJobView>(await fetchImpl(`${baseUrl}/setup/install/${encodeURIComponent(id)}`), '查安装进度')
}

export async function openSetupPane(baseUrl: string, pane: SetupPane, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${baseUrl}/setup/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pane }),
  })
  await parse<{ ok: true }>(res, '打开系统设置')
}

export async function fetchSetupApk(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<SetupApkView> {
  return await parse<SetupApkView>(await fetchImpl(`${baseUrl}/setup/apk.json`), '查手机端的包')
}

/** 生成配对码。复用设置弹窗里那条现成的路(`POST /pair/start`),不另起一套。 */
export async function startPairing(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${baseUrl}/pair/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  await parse<{ ok: true }>(res, '生成配对码')
}

/** 开/关「允许手机在局域网访问」。同样是现成的路(`POST /lan`)。 */
export async function setLanAccess(baseUrl: string, enabled: boolean, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${baseUrl}/lan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  await parse<{ ok: true }>(res, '改局域网开关')
}

// ─────────────────── 以下是**卡 C 的接口**(2026-09-17 并行) ───────────────────

/** `GET /config/paths` 的形状(按卡 C 的契约写;它合并前服务端回 404)。 */
/**
 * 卡 C 真实回的形状(2026-09-17 合并时对齐):顶层三项是**配置值,没配就是 null**;
 * 真正生效的在 `effective` 里(配置值 ?? 默认值)。界面只画 effective,免得对着 null 调 join(0.2.36 首发就踩了这一下)。
 */
export interface ConfigPathsScanRoot { path: string, depth: number }
export interface ConfigPathsView {
  scan_roots: readonly ConfigPathsScanRoot[] | null
  inbox_dirs: readonly string[] | null
  butler_cwd: string | null
  effective: {
    scan_roots: readonly ConfigPathsScanRoot[]
    inbox_dirs: readonly string[]
    butler_cwd?: string
    butler_cwd_source?: string
  }
}

/** 拿不到就是"那半边还没合并",不是错误。 */
export type MaybePending<T> = { pending: true } | { pending: false, value: T }

export async function fetchConfigPaths(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<MaybePending<ConfigPathsView>> {
  const res = await fetchImpl(`${baseUrl}/config/paths`)
  if (res.status === 404) return { pending: true }
  return { pending: false, value: await parse<ConfigPathsView>(res, '读路径配置') }
}

export async function putConfigPaths(baseUrl: string, patch: { scan_roots?: ConfigPathsScanRoot[], inbox_dirs?: string[], butler_cwd?: string }, fetchImpl: typeof fetch = fetch): Promise<MaybePending<ConfigPathsView>> {
  const res = await fetchImpl(`${baseUrl}/config/paths`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (res.status === 404) return { pending: true }
  return { pending: false, value: await parse<ConfigPathsView>(res, '保存路径配置') }
}

/** `GET /config/hooks?agent=claude|codex`:该往 settings.json 里写什么(卡 C 的契约)。 */
export interface ConfigHooksView {
  agent: string
  /** 直接可以粘进去的那段 JSON。 */
  settings?: unknown
  /** 一句照着做的话(比如那条 cp 命令)。 */
  hint?: string
}

export async function fetchConfigHooks(baseUrl: string, agent: string, fetchImpl: typeof fetch = fetch): Promise<MaybePending<ConfigHooksView>> {
  const res = await fetchImpl(`${baseUrl}/config/hooks?agent=${encodeURIComponent(agent)}`)
  if (res.status === 404) return { pending: true }
  return { pending: false, value: await parse<ConfigHooksView>(res, '读钩子配置') }
}

// ─────────────────── 诊断包与自动上报(2026-09-22) ───────────────────

export interface DiagExportEntry { path: string, bytes: number, from?: string, truncated?: boolean, note?: string }
export interface DiagExportSkipped { what: string, why: string }
export type DiagExportResponse =
  | { ok: true, file: string, file_redacted: string, bytes: number, entries: DiagExportEntry[], skipped: DiagExportSkipped[], revealed: boolean }
  | { ok: false, error: string }

/** 打一个诊断包。**慢**(要读日志、跑 `log show`、压包),界面要显示"在打包…"。 */
export async function exportDiagPackage(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<DiagExportResponse> {
  const res = await fetchImpl(`${baseUrl}/diag/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  return await parse<DiagExportResponse>(res, '导出诊断包')
}

/** 「发诊断包」:起一趟,立刻回(2026-10-21)。结果用 `fetchDiagSend` 去问。 */
export async function sendDiagPackage(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<DiagSendView> {
  const res = await fetchImpl(`${baseUrl}/diag/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  return await parse<DiagSendView>(res, '发诊断包')
}

/** 最近那一趟「发诊断包」。没发过回 `{ state: 'none' }`。 */
export async function fetchDiagSend(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<DiagSendView | { state: 'none' }> {
  return await parse<DiagSendView | { state: 'none' }>(await fetchImpl(`${baseUrl}/diag/send`), '看诊断包发没发出去')
}

export async function fetchDiagSettings(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<DiagSettingsView> {
  return await parse<DiagSettingsView>(await fetchImpl(`${baseUrl}/diag/settings`), '读诊断设置')
}

export async function setDiagReportEnabled(baseUrl: string, enabled: boolean, fetchImpl: typeof fetch = fetch): Promise<DiagSettingsView> {
  const res = await fetchImpl(`${baseUrl}/diag/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ report_enabled: enabled }),
  })
  return await parse<DiagSettingsView>(res, '改诊断设置')
}

/** 「那段说明我看过了」。**失败不报错**:它只是一面旗子,下次再显示一遍也不伤人。 */
export async function markDiagNoticeSeen(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  try { await fetchImpl(`${baseUrl}/diag/notice-seen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) }
  catch { /* 下次进来再说一遍 */ }
}

/**
 * 「我反馈过的问题」(2026-09-28,卡 FB)。体检页那一行读它:发了几条、各自什么状态。
 *
 * **不吞错**(同这一页的纪律):读不到就抛,那一行整块不出现 —— 摆一个「0 条」出来
 * 比不摆更糟,她会以为自己说过的话一条都没记下。
 */
export async function fetchFeedbackList(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<FeedbackListView> {
  return await parse<FeedbackListView>(await fetchImpl(`${baseUrl}/diag/feedback`), '读反馈过的问题')
}
/**
 * 各家 Agent 的记忆(2026-09-22,体检页末尾那颗按钮)。
 *
 * 两条都**不吞错**(同这一页的纪律):探不到就抛,界面把话摆出来。
 * 「拷」这一条服务端回的是 200 + `ok:false`(授权不到位),**那不是错误**
 * —— 它是一句要原样显示的人话,所以不在这里翻成异常。
 */
export interface MemoryProbeFamilyView {
  family: string
  label: string
  count: number
  left: readonly string[]
  skip?: string
}

export interface MemoryProbeView {
  allowed: boolean
  status: string
  wired: boolean
  families: readonly MemoryProbeFamilyView[]
  note: string
}

export interface MemoryImportView {
  ok: boolean
  note: string
  written: readonly string[]
  added: readonly string[]
}

export async function fetchAgentMemories(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<MemoryProbeView> {
  return await parse<MemoryProbeView>(await fetchImpl(`${baseUrl}/onboarding/memories`), '查各家的记忆')
}

export async function importAgentMemories(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<MemoryImportView> {
  const res = await fetchImpl(`${baseUrl}/onboarding/import-memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  return await parse<MemoryImportView>(res, '拷各家的记忆')
}
