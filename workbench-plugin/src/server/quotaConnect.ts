/**
 * 「全部接上」—— Claude、Codex 一次看、一次点(2026-09-25,卡 fix/quota-and-slot-apps)。
 *
 * 维护者 09-24 引导完的原话:「授权要自己点就算了」—— 可以要他点,但**只点一次**。
 * 原来是两张解锁卡各一颗「点一下,工作台帮你接上」,各开一个框、各看一遍、各点一次「写入」。
 * 这里把两家并成一次:
 *
 *   preview → 两家各要写进哪个文件、写什么(干跑一次合并,连"会加几条、换掉几条旧的、
 *             状态栏动不动"都算好),外加 Kimi 那一句(它只能他自己登,工作台代不了);
 *   apply   → 逐家「备份 → 只合并工作台自己的那几条 → 写回」,**每家各自一份备份**,
 *             所以撤回仍然是一家一颗(`POST /config/hooks/revert {agent}`,一个字没改)。
 *
 * ## 纪律全部沿用 hooksApply.ts,这里一条新的都没加
 *
 * 只写工作台自己的条目、写前备份(备份没做成就一个字不写)、先看后写、能一键撤回。
 * 这个文件只做"两家并一次"这一件事:真写的仍是 `wbHooksApply`,预览的内容仍是
 * `wbHooksRender` / `wbHooksMergeInto` —— **看到的与写进去的是同一个函数算出来的**。
 *
 * ## 不是一个事务
 *
 * Claude 写成了、Codex 没写成(比如 `~/.codex/hooks.json` 被手工改坏了)时,**不回滚 Claude**:
 * 两家的文件互不相干,一家坏了不该连累另一家;每家的结果如实回出去,界面逐家说。
 * 想撤就逐家撤 —— 那正是「每家仍可一键撤回」。
 *
 * ## 哪几家要写
 *
 * 听探测(clientScan):装了、还没接上的才写。探测说没装 → 不写(不替他在一个没装的
 * 应用的配置目录里造文件);说接上了 → 不写(不白留一份备份)。探测还没结论(没扫过)→
 * 两家都当"要写"(写是幂等的,写错了也撤得回;而把"还不知道"当成"不用写",
 * 他点了「全部接上」却什么都没发生,那才是骗人)。调用方明着传了 `agents` 就照它写。
 *
 * **这个模块一个字都不认 `process.env.HOME`**:文件路径、I/O 全由调用方注入(生产在 http.ts
 * 从 `paths.applyHooks` 取,用例给临时目录)—— 2026-09-04 家目录被删事故之后的纪律。
 */
import type { AgentId, ClientsView, QuotaConnectView, QuotaEntry, QuotaProviderState } from '../protocol.ts'
import { CLIENT_LABELS, KIMI_LOGIN_HOW } from './clientScan.ts'
import type { WbHooksAgent, WbHooksRendered } from './hooksConfig.ts'
import { wbHooksRender } from './hooksConfig.ts'
import type { WbHooksApplyIo, WbHooksMergeResult } from './hooksApply.ts'
import { WB_HOOKS_CODEX_TRUST_HINT, wbHooksApply, wbHooksMergeInto, wbHooksRestartHint } from './hooksApply.ts'

/** 「全部接上」管的那几家:工作台能替他写配置的。Kimi 不在里面(它要他本人登录)。 */
export const CONNECT_ALL_AGENTS: readonly WbHooksAgent[] = ['claude', 'codex']

/**
 * 一家此刻的样子。
 * - `pending`:装了、没接上 → 要写;
 * - `unknown`:探测还没结论 → 也写(见文件头「哪几家要写」);
 * - `connected`:已经接上 → 不写;
 * - `not_installed`:没装 → 不写,也不提。
 */
export type ConnectAgentState = 'pending' | 'unknown' | 'connected' | 'not_installed'

export interface ConnectAllDeps {
  /** 两家配置文件的绝对路径(生产:~/.claude/settings.json、~/.codex/hooks.json)。 */
  files: Readonly<Record<WbHooksAgent, string>>
  io: WbHooksApplyIo['io']
  now: () => Date
  /**
   * 确保钩子脚本已经在固定位置(`~/.dsh/workbench/hooks/`,hookScripts.ts 的 `ensure`),回那个位置。
   * **放不成就一个字都不写**(写一条指着空位置的命令,就是几条静默失败的钩子),`error` 是给人看的那一句。
   *
   * 卡 R(2026-09-25)之前这里是「找本机仓库根」—— 普通用户机器上没有仓库,于是永远接不上。
   */
  hooksDir: () => Promise<{ ok: true, dir: string } | { ok: false, error: string }>
  /** 探测结论(`/state.clients` 的同一份)。没接 / 没扫过 → undefined。 */
  clients: () => ClientsView | undefined
}

export interface ConnectAgentPreview {
  agent: WbHooksAgent
  name: string
  state: ConnectAgentState
  file: string
  /** 会写进去的那几条(要写的那几家才有)—— 界面原样摆出来给他看。 */
  content?: WbHooksRendered
  /** 干跑一次合并算出来的结果:会加几条、换掉几条旧的、状态栏怎么处理。 */
  will?: { added: number, replaced: number, status_line: WbHooksMergeResult['statusLine'] }
  /** 这一家这次写不了(文件是坏 JSON 等)。有它就不进 `apply`,原因原样给他看。 */
  error?: string
}

export interface KimiConnectView {
  state: 'pending' | 'connected'
  /** 他要做的那一步(只在 pending 时有)。与额度面板解锁卡上的是同一句。 */
  how?: string
}

export type ConnectAllPreview =
  | {
    ok: true
    agents: ConnectAgentPreview[]
    /** apply 不传 `agents` 时会写的那几家(按 Claude、Codex 的顺序)。空 = 这次没有要写的。 */
    apply: WbHooksAgent[]
    /** Kimi 装着时才有。它不在「全部接上」里 —— 登录要他本人,工作台代不了。 */
    kimi?: KimiConnectView
    /** 一整句人话(预览卡 / 引导落地那张卡原样显示)。 */
    line: string
  }
  | { ok: false, error: string }

export interface ConnectAgentResult {
  agent: WbHooksAgent
  name: string
  ok: boolean
  file: string
  backup_path?: string
  added?: number
  replaced?: number
  status_line?: WbHooksMergeResult['statusLine']
  error?: string
}

export type ConnectAllApplied =
  | {
    /** 要写的每一家都写成了(一家都不用写时也是 true)。 */
    ok: boolean
    results: ConnectAgentResult[]
    /** 没写的那几家与原因(已经接上 / 没装)。 */
    skipped: { agent: WbHooksAgent, name: string, state: ConnectAgentState }[]
    /** 写成了至少一家时才有:正开着的会话要重开一次才算数。 */
    restart_hint?: string
    kimi?: KimiConnectView
    line: string
  }
  | { ok: false, error: string }

function stateOf(agent: WbHooksAgent, clients: ClientsView | undefined): ConnectAgentState {
  const view = clients?.[agent]
  if (view === undefined) return 'unknown'
  if (!view.installed) return 'not_installed'
  return view.connected ? 'connected' : 'pending'
}

function kimiOf(clients: ClientsView | undefined): KimiConnectView | undefined {
  const view = clients?.kimi
  // 没装 / 没扫过 → 不提。没装 Kimi 的人不该被告知"Kimi 还要登一次"。
  if (view === undefined || !view.installed) return undefined
  return view.connected ? { state: 'connected' } : { state: 'pending', how: view.how ?? KIMI_LOGIN_HOW }
}

/** `/Users/example/.claude/settings.json` → `~/.claude/settings.json`(给人看的那一句里用短的)。 */
export function tildePath(path: string): string {
  const found = /^\/Users\/[^/]+\//.exec(path)
  return found === null ? path : `~/${path.slice(found[0].length)}`
}

/** 几句话连成一段:各句自带的句号先去掉再统一加,不出现「。。」。 */
function sentences(parts: readonly string[]): string {
  return `${parts.map(part => part.replace(/[。\s]+$/, '')).join('。')}。`
}

function kimiSentence(kimi: KimiConnectView | undefined): string | undefined {
  if (kimi?.state !== 'pending') return undefined
  return `Kimi ${kimi.how ?? KIMI_LOGIN_HOW}`
}

/**
 * 先看:两家各要写什么。**只读**,不备份、不写。
 */
export async function connectAllPreview(deps: ConnectAllDeps): Promise<ConnectAllPreview> {
  const scripts = await deps.hooksDir()
  if (!scripts.ok) return { ok: false, error: scripts.error }
  const hooksDir = scripts.dir
  const clients = deps.clients()

  const agents: ConnectAgentPreview[] = []
  for (const agent of CONNECT_ALL_AGENTS) {
    const state = stateOf(agent, clients)
    const file = deps.files[agent]
    const row: ConnectAgentPreview = { agent, name: CLIENT_LABELS[agent], state, file }
    if (state === 'pending' || state === 'unknown') {
      row.content = wbHooksRender(agent, hooksDir)
      // 干跑一次合并:跟 apply 用的是同一个函数,文件坏了在这里就能如实说,不等他点了才报错。
      const merged = wbHooksMergeInto(await deps.io.readFile(file), agent, hooksDir)
      if (merged.ok) row.will = { added: merged.result.added, replaced: merged.result.replaced, status_line: merged.result.statusLine }
      else row.error = merged.error
    }
    agents.push(row)
  }
  const apply = agents.filter(row => (row.state === 'pending' || row.state === 'unknown') && row.error === undefined).map(row => row.agent)
  const kimi = kimiOf(clients)

  const parts: string[] = []
  if (apply.length > 0) {
    const where = agents.filter(row => apply.includes(row.agent)).map(row => `${row.name}(${tildePath(row.file)})`).join('、')
    parts.push(`要写 ${apply.length} 家:${where}。只加工作台自己的那几条,原来的一个字不动;写之前各自另存一份,写完每家都能单独撤回`)
  }
  for (const row of agents) {
    if (row.error !== undefined) parts.push(`${row.name} 这次写不了:${row.error}`)
  }
  const done = agents.filter(row => row.state === 'connected').map(row => row.name)
  if (done.length > 0) parts.push(`${done.join('、')} 已经接上了,不用再写`)
  const kimiLine = kimiSentence(kimi)
  if (kimiLine !== undefined) parts.push(kimiLine)
  if (parts.length === 0) parts.push('这台电脑上没有要接的:Claude、Codex 都没装')

  return {
    ok: true,
    agents,
    apply,
    ...(kimi === undefined ? {} : { kimi }),
    line: sentences(parts),
  }
}

/** 两家并一句的「要重开会话」。只写成一家时照那一家原来那句说。 */
function restartHintFor(written: readonly WbHooksAgent[]): string | undefined {
  if (written.length === 0) return undefined
  if (written.length === 1) return wbHooksRestartHint(written[0] as WbHooksAgent)
  return `正开着的 Claude Code 窗口和 Codex 会话还是旧配置 —— 各自关掉、重新开一个,工作台才收得到它们的动静。${WB_HOOKS_CODEX_TRUST_HINT}`
}

/**
 * 再写:逐家「备份 → 合并 → 写回」。`agents` 不传 = 预览里那份 `apply`(装了、没接上的那几家)。
 */
export async function connectAllApply(
  deps: ConnectAllDeps,
  input: { agents?: readonly WbHooksAgent[] } = {},
): Promise<ConnectAllApplied> {
  const scripts = await deps.hooksDir()
  // 脚本没放好就**整件事不做** —— 一家都不写,不是写一半。
  if (!scripts.ok) return { ok: false, error: scripts.error }
  const hooksDir = scripts.dir
  const clients = deps.clients()

  const wanted = input.agents === undefined
    ? CONNECT_ALL_AGENTS.filter((agent) => {
      const state = stateOf(agent, clients)
      return state === 'pending' || state === 'unknown'
    })
    : CONNECT_ALL_AGENTS.filter(agent => input.agents?.includes(agent))
  const skipped = CONNECT_ALL_AGENTS
    .filter(agent => !wanted.includes(agent))
    .map(agent => ({ agent, name: CLIENT_LABELS[agent], state: stateOf(agent, clients) }))
    // 没装的不提(同额度面板:没装的那家不出现)。
    .filter(row => row.state !== 'not_installed')

  const results: ConnectAgentResult[] = []
  for (const agent of wanted) {
    const file = deps.files[agent]
    const name = CLIENT_LABELS[agent]
    // 一家一次备份、一家一次写 —— 一家失败不拦另一家(见文件头「不是一个事务」)。
    const out = await wbHooksApply({ io: deps.io, now: deps.now }, { agent, file, hooksDir })
    if (!out.ok) {
      results.push({ agent, name, ok: false, file, error: out.error })
      continue
    }
    results.push({
      agent,
      name,
      ok: true,
      file,
      ...(out.backup_path === undefined ? {} : { backup_path: out.backup_path }),
      added: out.added,
      replaced: out.replaced,
      status_line: out.statusLine,
    })
  }

  const written = results.filter(row => row.ok).map(row => row.agent)
  const failed = results.filter(row => !row.ok)
  const kimi = kimiOf(clients)
  const parts: string[] = []
  if (written.length > 0) parts.push(`${written.map(agent => CLIENT_LABELS[agent]).join('、')} 接上了`)
  for (const row of failed) parts.push(`${row.name} 没写成:${row.error ?? '原因没拿到'}`)
  if (results.length === 0) {
    parts.push(skipped.length > 0 ? `${skipped.map(row => row.name).join('、')} 已经接上了,这次什么都没写` : '这次没有要写的')
  }
  const restart = restartHintFor(written)
  if (restart !== undefined) parts.push(restart)
  const kimiLine = kimiSentence(kimi)
  if (kimiLine !== undefined) parts.push(kimiLine)

  return {
    ok: failed.length === 0,
    results,
    skipped,
    ...(restart === undefined ? {} : { restart_hint: restart }),
    ...(kimi === undefined ? {} : { kimi }),
    line: sentences(parts),
  }
}

// ———————————————— 四家接没接上(只读,给球下面那张卡与引导落地的预览用) ————————————————

const PROVIDER_LABELS: Readonly<Record<AgentId, string>> = { dsh: 'DeepSeek', claude: 'Claude', codex: 'Codex', kimi: 'Kimi' }

/** DeepSeek 没接时那一步。与额度面板那张解锁卡是同一件事(两条路随他挑)。 */
export const DEEPSEEK_SETUP_HOW = '去设置 → 模型服务,二选一:用工作台提供的服务(不用填任何东西),或者填你自己的 DeepSeek Key。'

/** Claude / Codex 没接时那一步。 */
export const ONE_CLICK_HOW = '点一次「全部接上」:先看一眼要写什么,确认一次就都接上,写完每家都能单独撤回。'

/**
 * DeepSeek 接没接上。判据与前台 areaUnlock.ts 的 deepseekProgress 逐字相同(两边构建独立,前端不 import 服务端):
 * 走中转 = 接上;服务端**确定**一把 Key 都没有(`no_stale`)= 没接;取到过余额 / 额度 = 接上;其余说不出来。
 */
function deepseekState(entry: QuotaEntry | undefined, modelMode: 'relay' | 'own' | undefined): QuotaProviderState {
  if (modelMode === 'relay') return 'connected'
  if (entry === undefined) return 'unknown'
  if (entry.kind === 'unknown') return entry.no_stale === true ? 'setup' : 'unknown'
  return 'connected'
}

function clientState(agent: 'claude' | 'codex' | 'kimi', clients: ClientsView): QuotaProviderState {
  const view = clients[agent]
  if (!view.installed) return 'not_installed'
  if (view.connected) return 'connected'
  return agent === 'kimi' ? 'login' : 'one_click'
}

/**
 * 有额度的四家各自接没接上(2026-09-25)。**纯函数**:吃的是 `/state` 里现成的三格(clients / quota / model_mode),
 * 所以服务端 composeState 与引导落地的预览拿到的是同一份。`clients` 还没扫过 → undefined(不冒充"都没装")。
 */
export function quotaConnectStatus(input: {
  clients?: ClientsView | undefined
  quota: Partial<Record<AgentId, QuotaEntry>>
  model_mode?: 'relay' | 'own' | undefined
}): QuotaConnectView | undefined {
  const clients = input.clients
  if (clients === undefined) return undefined
  const rows: { agent: AgentId, label: string, state: QuotaProviderState, note?: string }[] = []
  const dsh = deepseekState(input.quota.dsh, input.model_mode)
  rows.push({
    agent: 'dsh',
    label: PROVIDER_LABELS.dsh,
    state: dsh,
    ...(dsh === 'setup' ? { note: DEEPSEEK_SETUP_HOW } : {}),
    ...(dsh === 'connected' && input.model_mode === 'relay' ? { note: '用的是工作台提供的服务' } : {}),
  })
  for (const agent of ['claude', 'codex', 'kimi'] as const) {
    const state = clientState(agent, clients)
    const note = state === 'one_click' ? ONE_CLICK_HOW : state === 'login' ? (clients.kimi.how ?? KIMI_LOGIN_HOW) : undefined
    rows.push({ agent, label: PROVIDER_LABELS[agent], state, ...(note === undefined ? {} : { note }) })
  }

  const names = (state: QuotaProviderState): string[] => rows.filter(row => row.state === state).map(row => row.label)
  const parts: string[] = []
  if (names('connected').length > 0) parts.push(`${names('connected').join('、')} 已接上`)
  if (names('one_click').length > 0) parts.push(`${names('one_click').join('、')} 要你点一次「全部接上」`)
  if (names('login').length > 0) parts.push(`${names('login').join('、')} 要你自己登一次`)
  if (names('setup').length > 0) parts.push(`${names('setup').join('、')} 还没接,去设置里二选一`)
  return {
    providers: rows,
    one_click: rows.some(row => row.state === 'one_click'),
    line: parts.length === 0 ? '有额度的几家这会儿还说不出接没接上' : parts.join(';'),
  }
}
