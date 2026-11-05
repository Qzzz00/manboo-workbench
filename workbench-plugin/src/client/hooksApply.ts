/**
 * 「点一下,工作台帮你接上」—— 前台这一半的取数与文案(纯函数 + 三个 fetch,不碰 DOM)。
 *
 * 界面上的顺序是 Ben 拍板里那四条中的第三条:**先看后写**。
 * 所以这里有三步,缺一不可:
 *
 *   1. `loadHooksPreview` —— `GET /config/hooks?agent=`:要写进哪个文件、要写什么;
 *   2. `applyHooks`       —— `POST /config/hooks/apply`:真写,回执里带备份路径;
 *   3. `revertHooks`      —— `POST /config/hooks/revert`:一键撤回。
 *
 * 失败一律**说出来**(跟初始化页同一条纪律,不是看板那种"等下一拍轮询"):
 * 他正盯着一个按钮等结果,吞掉错误等于"点了没反应"。
 */

export type HooksAgent = 'claude' | 'codex'

export const HOOKS_AGENT_NAMES: Readonly<Record<HooksAgent, string>> = {
  claude: 'Claude',
  codex: 'Codex',
}

export interface HooksPreview {
  agent: HooksAgent
  /** 会写进哪个文件。服务端没接代写时缺席。 */
  file?: string
  /** 这台服务接没接代写。false 时界面退回"照着复制"那条老路,不画一颗按不动的按钮。 */
  canApply: boolean
  /** 要写进去的那几条,原样(界面上直接 JSON.stringify 摆出来给他看)。 */
  content: unknown
}

export interface HooksApplied {
  backupPath?: string
  added: number
  replaced: number
  /** 他自己配过状态栏时是 `kept_user` —— 那一条**没动**,要如实告诉他。 */
  statusLine: 'added' | 'replaced' | 'kept_user' | 'none'
  restartHint: string
}

export interface HooksReverted {
  backupPath?: string
  removed: number
  note: string
}

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

interface RawPreview {
  agent: HooksAgent
  file?: string
  can_apply?: boolean
  hooks: unknown
  statusLine?: unknown
}

export async function loadHooksPreview(baseUrl: string, agent: HooksAgent, fetchImpl: typeof fetch = fetch): Promise<HooksPreview> {
  const res = await fetchImpl(`${baseUrl}/config/hooks?agent=${encodeURIComponent(agent)}`)
  const body = await parse<RawPreview>(res, '看一眼要写什么')
  return {
    agent,
    ...(body.file === undefined ? {} : { file: body.file }),
    canApply: body.can_apply === true,
    // 摆出来的就是要写进去的那份(两条路吐的是同一个渲染结果)。
    content: body.statusLine === undefined ? { hooks: body.hooks } : { hooks: body.hooks, statusLine: body.statusLine },
  }
}

export async function applyHooks(baseUrl: string, agent: HooksAgent, fetchImpl: typeof fetch = fetch): Promise<HooksApplied> {
  const res = await fetchImpl(`${baseUrl}/config/hooks/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent }),
  })
  const body = await parse<{
    backup_path?: string, added: number, replaced: number
    status_line: HooksApplied['statusLine'], restart_hint: string
  }>(res, '接上')
  return {
    ...(body.backup_path === undefined ? {} : { backupPath: body.backup_path }),
    added: body.added,
    replaced: body.replaced,
    statusLine: body.status_line,
    restartHint: body.restart_hint,
  }
}

export async function revertHooks(baseUrl: string, agent: HooksAgent, fetchImpl: typeof fetch = fetch): Promise<HooksReverted> {
  const res = await fetchImpl(`${baseUrl}/config/hooks/revert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent }),
  })
  const body = await parse<{ backup_path?: string, removed: number, note: string }>(res, '撤回')
  return {
    ...(body.backup_path === undefined ? {} : { backupPath: body.backup_path }),
    removed: body.removed,
    note: body.note,
  }
}

/** `/Users/example/.claude/settings.json` → `~/.claude/settings.json`。界面上摆短的那一份,标题里用。 */
export function shortHome(path: string): string {
  const found = /^\/Users\/[^/]+\//.exec(path)
  return found === null ? path : `~/${path.slice(found[0].length)}`
}

/**
 * 写完之后那一句。**必须把三件事说全**:接上了、备份在哪、要重开会话。
 *
 * 备份那一句不是给程序看的:他后悔了、或者哪天想自己比对,靠的就是这个路径。
 * 「撤回」按钮在旁边,所以这里不劝他做什么,只把事实摆齐。
 */
export function appliedLine(agent: HooksAgent, applied: HooksApplied): string {
  const parts = [`已经接上 ${HOOKS_AGENT_NAMES[agent]} 了。`]
  if (applied.replaced > 0) parts.push(`(之前那 ${applied.replaced} 条旧的已经换掉,没有重复。)`)
  parts.push(applied.backupPath === undefined
    ? '这个文件原来不存在,是工作台新建的 —— 所以没有备份可留。'
    : `改之前那一份备份在:${applied.backupPath}。`)
  if (applied.statusLine === 'kept_user') {
    parts.push('你自己配过状态栏,那一条工作台没动 —— 顶栏的额度显示可能因此还是你原来那套。')
  }
  parts.push(applied.restartHint)
  return parts.join(' ')
}

export function revertedLine(agent: HooksAgent, reverted: HooksReverted): string {
  if (reverted.removed === 0) return `${HOOKS_AGENT_NAMES[agent]} 那边本来就没有工作台的条目,什么都没改。`
  return `已经撤回了(摘掉 ${reverted.removed} 条,别的一个字没动)。${reverted.backupPath === undefined ? '' : `撤之前那一份备份在:${reverted.backupPath}。`}`
}

// ———————————————————— 「全部接上」(2026-09-25):Claude、Codex 一次看、一次点 ————————————————————

/** 一家在「全部接上」里的样子(服务端 quotaConnect.ts 的同名形状,前端不 import 服务端)。 */
export interface ConnectAllAgentPreview {
  agent: HooksAgent
  name: string
  state: 'pending' | 'unknown' | 'connected' | 'not_installed'
  file: string
  content?: unknown
  will?: { added: number, replaced: number, status_line: HooksApplied['statusLine'] }
  error?: string
}

export interface ConnectAllPreviewView {
  agents: readonly ConnectAllAgentPreview[]
  /** 点「一次写入」时会写的那几家。空 = 这次没有要写的。 */
  apply: readonly HooksAgent[]
  kimi?: { state: 'pending' | 'connected', how?: string }
  line: string
}

export interface ConnectAllResultRow {
  agent: HooksAgent
  name: string
  ok: boolean
  file: string
  backup_path?: string
  status_line?: HooksApplied['statusLine']
  error?: string
}

export interface ConnectAllAppliedView {
  ok: boolean
  results: readonly ConnectAllResultRow[]
  restart_hint?: string
  kimi?: { state: 'pending' | 'connected', how?: string }
  line: string
}

export async function loadConnectAllPreview(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ConnectAllPreviewView> {
  const res = await fetchImpl(`${baseUrl}/quota/connect-all/preview`)
  return await parse<ConnectAllPreviewView>(res, '看一眼要写什么')
}

export async function applyConnectAll(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ConnectAllAppliedView> {
  const res = await fetchImpl(`${baseUrl}/quota/connect-all/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  return await parse<ConnectAllAppliedView>(res, '全部接上')
}

/**
 * 写完之后一家那一行。**不摊路径**(维护者的眼睛第 3 条「不露内部的东西」):只说另存了没有;
 * 另存在哪收在框里「另存的那几份在哪」那一格(他后悔了、想比对,靠的就是它)。
 */
export function connectedRowLine(row: ConnectAllResultRow): string {
  if (!row.ok) return `${row.name} 没写成:${row.error ?? '原因没拿到'}`
  const parts = [`${row.name} 接上了,`]
  parts.push(row.backup_path === undefined
    ? '它的配置原来是空的,是工作台新建的(没有旧的可留)。'
    : '改之前那一份已经另存好了。')
  if (row.status_line === 'kept_user') parts.push('你自己配过状态栏,那一条没动。')
  return parts.join('')
}
