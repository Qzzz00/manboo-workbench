/**
 * 就绪检查(2026-09-17,登录台关 1~7 的体检那一半)。
 *
 * 每一项做的事都一样:**去看一眼真实世界**,然后回三句话 —— 现在是什么样(detail)、
 * 算不算就绪(state)、不就绪的话怎么修(fix)。没有一项会去"推断"或"假定";
 * 看不到就说看不到(先例:D13 不编数,取不到标未接入)。
 *
 * 一条容易踩的坑写在前面:**这份体检自己就跑在被体检的进程里**。工作台插件活着,
 * 说明 node / runtime / profile / 插件这四项必然已经装过一轮 —— 但它们仍要真的去看文件,
 * 因为"跑着的那一份"和"磁盘上现在那一份"可以不是同一份(0907 事故里老进程正是靠
 * 已被删除、仍映射在内存里的文件活着的)。
 */
import { APP_BUNDLES } from '../activation.ts'
import { probeInstalled, wbHookCommands } from '../clientScan.ts'
import { WB_HOOK_SCRIPT, wbHooksDir } from '../hooksConfig.ts'
// Codex 放没放行工作台的钩子那一项(2026-10-21):问 Codex 自己,这里只写人话。
import { CODEX_TRUST_HOW, type CodexHookTrust } from '../codexHookTrust.ts'
// 运营技能接没接上那一项(2026-09-22,卡 ①)。判断是纯函数,这里只负责读一次文件 + 写人话。
import { opsSkillsAttachState } from '../opsSkills.ts'
import {
  accessibilityKindOf, grantHistoryOf, parseDesignatedRequirement, parseGrantRecord, parseShellSignature, probeTccRecord,
  type AccessibilityKind, type ShellSignatureKind,
} from './accessibility.ts'
// 「完全磁盘访问」那一项(2026-10-13,手机看文件时电脑弹 node 的授权框)。
import { FULL_DISK_WHY, probeFullDiskAccess, type FullDiskAccessKind } from './fullDiskAccess.ts'
import { NO_RELAY_NOTE, parseModelConfig, relayConfigured } from '../modelConfig.ts'
import type { SetupIo } from './io.ts'
import type { SetupItem, SetupItemState, SetupStatus } from './types.ts'
import type { SetupPaths } from './paths.ts'
import { LOCKED_DSH_VERSION, MIN_NODE_MAJOR, DSH_LAUNCHD_LABEL, BUTLER_LAUNCHD_LABEL } from './paths.ts'
import { readRuntimeDrift } from './dshRuntimeLock.ts'

/** 判「壳比源码旧」时的宽限(毫秒)。理由见 checkShellApp 里那一处。 */
const SHELL_MTIME_GRACE_MS = 5_000

/** 壳通道那一份视图里体检用得上的两格。窄接口:不 import HelperChannel,免得把这块绑到它的形状上。 */
export interface SetupHelperView { connected: boolean, authorized: boolean, reason?: string }

export interface SetupStatusDeps {
  io: SetupIo
  paths: SetupPaths
  /** 仓库里的插件版本(package.json)。profile 里装的那份比它旧 = stale。 */
  pluginVersion: string
  /** 壳(工作台.app)的连接与辅助功能授权。不传就把这一项如实标成「壳没接线,判断不了」。 */
  helper?: () => SetupHelperView
  /** 项目扫描根。生产接卡 C 的 /config/paths;它还没合并时传默认三条。 */
  scanRoots: () => Promise<readonly string[]>
  /**
   * **源码仓库**在哪(desktop-workbench 那一份)。只用来:装启动脚本/plist 时从哪儿取、
   * 以及把装进去的那几份跟仓库副本比对。
   *
   * 双击安装包装出来的机器上**没有这个东西**(安装器只带产物),所以它会缺席,
   * 那几项体检随之如实说「没法跟仓库副本比对」—— 不是绿灯,也不是红灯。
   */
  repoRoot?: string
  /**
   * **事务官/引导的落脚目录**(app.json 的 `butler_cwd`,环境变量 `WORKBENCH_BUTLER_CWD` 优先)。
   *
   * 2026-09-18 起它与 `repoRoot` 分开了:开发机上两者碰巧是同一个目录(仓库本身),
   * 而装出来的机器上落脚点是 `~/Documents/工作台`、源码仓库压根不存在。
   * 做成函数是因为它在设置里改得动,体检每次要问最新的那个值。
   */
  butlerCwd?: () => Promise<string | undefined>
  /**
   * 当前布局模板 id(2026-09-22,卡 ①)。**决定「该有哪几段技能」** ——
   * 自媒体运营模板下该有十段运营技能 + 基础那几段,做产品模板下只该有基础那几段。
   *
   * 不传 = 这台服务没接模板服务(既有那批用例),那时按"没选过"办,
   * 与 `/config/ops-skills` 那条路的口径一字不差。
   */
  templateId?: () => string | undefined
  /**
   * Codex 放没放行工作台的钩子(2026-10-21,卡「Codex 钩子信任」;生产是 codexHookTrust.ts 那个带缓存的探针)。
   * 不传 = 这台服务没接这一问(既有那批用例),那一项整个缺席。
   */
  codexHookTrust?: () => Promise<CodexHookTrust>
  now: () => number
}

/** 各家客户端的官网(没装时给的下载去处)。只放官网首页/下载页,不猜具体安装包地址。 */
const CLIENT_ROWS: readonly { key: string, label: string, bundle: string, url: string }[] = [
  { key: 'claude', label: 'Claude 桌面版', bundle: APP_BUNDLES.claude ?? '', url: 'https://claude.ai/download' },
  { key: 'codex', label: 'ChatGPT(Codex)', bundle: APP_BUNDLES.codex ?? '', url: 'https://openai.com/chatgpt/download/' },
  { key: 'kimi', label: 'Kimi 桌面版', bundle: APP_BUNDLES.kimi ?? '', url: 'https://www.kimi.com/' },
  { key: 'wechat', label: '微信', bundle: APP_BUNDLES.wechat ?? '', url: 'https://weixin.qq.com/' },
  { key: 'wecom', label: '企业微信', bundle: APP_BUNDLES.wecom ?? '', url: 'https://work.weixin.qq.com/' },
]

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * 把 dsh-start 归一化后再比:`WORKBENCH_BUTLER_CWD` 那一行的值是**渲染出来的**
 * (每台机器的仓库路径不同),不该因为它不同就报「脚本旧了」。其余每一个字都要一样。
 */
export function normalizeDshStart(text: string): string {
  return text
    .replace(/^export WORKBENCH_BUTLER_CWD=.*$/m, 'export WORKBENCH_BUTLER_CWD=<配置值>')
    .replace(/\s+$/, '')
}

/** 从 web.stdout.log 里捞**最新**一条带 token 的地址。没有就 undefined。 */
export function latestWebToken(log: string): string | undefined {
  const matches = log.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s"']+/g)
  return matches === null ? undefined : matches[matches.length - 1]
}

/** `.env` 里 DEEPSEEK_API_KEY 有没有非空值。**只回布尔,绝不把值带出这个函数**。 */
export function envHasDeepseekKey(text: string): boolean {
  const line = text.split('\n').find(row => /^\s*(export\s+)?DEEPSEEK_API_KEY\s*=/.test(row))
  if (line === undefined) return false
  const value = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
  return value !== ''
}

/** credentials.json 里 keys.deepseek 有没有值。同样只回布尔。 */
export function credentialsHaveDeepseekKey(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { keys?: Record<string, unknown> } | null
    const value = parsed?.keys?.deepseek
    return typeof value === 'string' && value !== ''
  }
  catch { return false }
}

/**
 * Claude 的四个 hook + statusLine 指到哪儿去了(数条数、收路径;判「接没接上」在 checkClaudeHooks)。
 *
 * 0907 事故教出来的:命令行里的绝对路径一失效,表现是"会话永远显示在跑",不看一眼根本不知道。
 * 卡 R(2026-09-25)起,工作台自己的那几条只该指钩子脚本的固定位置 `~/.dsh/workbench/hooks/`
 * (不再是「本机仓库」—— 装好的机器上没有仓库)。
 */
export function claudeHooksPointAt(settingsText: string): { hooks: number, statusLine: boolean, paths: readonly string[] } {
  let parsed: unknown
  try { parsed = JSON.parse(settingsText) }
  catch { return { hooks: 0, statusLine: false, paths: [] } }
  const root = (parsed ?? {}) as Record<string, unknown>
  const paths = new Set<string>()
  let hooks = 0
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (typeof record.command === 'string') {
      hooks += 1
      for (const found of record.command.match(/\/[^\s"']+/g) ?? []) paths.add(found)
    }
    for (const child of Object.values(record)) walk(child)
  }
  walk(root.hooks)
  const statusLineCommand = (root.statusLine as { command?: unknown } | undefined)?.command
  const statusLine = typeof statusLineCommand === 'string' && statusLineCommand !== ''
  if (statusLine) {
    for (const found of (statusLineCommand as string).match(/\/[^\s"']+/g) ?? []) paths.add(found)
  }
  return { hooks, statusLine, paths: [...paths] }
}

export interface SetupStatusService {
  check: () => Promise<SetupStatus>
  /** 上一次体检的结论(没检查过就 undefined)。给 /state.setup_required 用,**不触发新的体检**。 */
  lastAllOk: () => boolean | undefined
  /** 上一次体检是什么时候(毫秒)。http.ts 的节流靠它。 */
  lastCheckedAt: () => number | undefined
  /**
   * 上一次体检的逐项结果(没检查过就 undefined)。**不触发新的体检** —— 顶上那两条横幅
   * (缺授权 / 缺 DeepSeek 密钥,2026-09-17)靠它,免得为了画一条横幅每拍跑十几条子命令。
   */
  lastItems: () => readonly SetupItem[] | undefined
  /**
   * 上一次体检里辅助功能那一项是哪一种(2026-09-18)。同样**不触发新的体检**。
   * 没检查过、或者这台机器上压根没这一项时 undefined。
   */
  lastAccessibility: () => AccessibilityKind | undefined
  /**
   * 上一次体检里「完全磁盘访问」那一项是哪一种(2026-10-13)。同样**不触发新的体检** ——
   * 那一下虽然只是一个 readdir,但它走 TCC,不该挂在每秒一拍的 /state 上。
   */
  lastFullDiskAccess: () => FullDiskAccessKind | undefined
}

export function createSetupStatus(deps: SetupStatusDeps): SetupStatusService {
  let lastAllOk: boolean | undefined
  let lastCheckedAt: number | undefined
  let lastItems: readonly SetupItem[] | undefined
  /**
   * 上一次体检里辅助功能那一项的**种类**(2026-09-18)。跟 lastItems 同一拍写、同一拍读
   * —— 顶上那条横幅要靠它把「还差一个授权」与「那条记录是旧的」分开说。单独存一格而不是
   * 塞进 SetupItem:那是所有体检项共用的形状,为一项加一个只有它会用的字段,下一个人
   * 照着加第二个就散了。
   */
  let lastAccessibility: AccessibilityKind | undefined
  /** 同上,「完全磁盘访问」那一项的结论(2026-10-13)。顶上那条横幅要靠它。 */
  let lastFullDiskAccess: FullDiskAccessKind | undefined

  async function check(): Promise<SetupStatus> {
    const items: SetupItem[] = []
    const { io } = deps

    // ── 关 1 · 运行时(第 1 步)──────────────────────────────────────────────
    items.push(await checkNode(deps))
    items.push(await checkRuntime(deps))
    items.push(await checkProfile(deps))
    items.push(await checkDshStart(deps))
    items.push(await checkLaunchd(deps))
    items.push(await checkShellApp(deps))
    items.push(await checkButlerServer(deps))
    items.push(await checkChannelWorker(deps))

    // ── 第 2 步 · 仓库在哪 ─────────────────────────────────────────────────
    items.push(await checkRepoRoot(deps))
    // 技能接没接上(2026-09-22,卡 ①)。跟仓库同一步:这几段技能的正文就在那个仓库里。
    items.push(await checkOpsSkills(deps))

    // ── 关 2 · 系统授权(第 3 步)──────────────────────────────────────────
    const accessibility = await checkAccessibility(deps)
    items.push(accessibility.item)
    items.push(await checkDocuments(deps))
    // 2026-10-13:手机看文件那条路要的是「完全磁盘访问」,跟上面那一项不是同一个授权。
    const fullDisk = await checkFullDiskAccess(deps)
    items.push(fullDisk.item)
    items.push(await checkCalendar(deps))

    // ── 关 3 · 登录与密钥(第 3~4 步)───────────────────────────────────────
    items.push(await checkWebCookie(deps))
    items.push(await checkDeepseekKey(deps))
    items.push(await checkClaudeHooks(deps))

    // ── 关 4 · 各家客户端(第 5 步)────────────────────────────────────────
    for (const row of CLIENT_ROWS) items.push(await checkClient(io, row))
    const codexHooks = await checkCodexHooks(deps)
    if (codexHooks !== undefined) items.push(codexHooks)

    // all_ok 只看**非可选**项:没装微信、没发布事务官后端,不该让初始化页天天自己弹出来。
    const allOk = items.every(item => item.optional === true || item.state === 'ok')
    const optionalPending = items.filter(item => item.optional === true && item.state !== 'ok').length
    lastAllOk = allOk
    lastCheckedAt = deps.now()
    lastItems = items
    lastAccessibility = accessibility.kind
    lastFullDiskAccess = fullDisk.kind
    return { items, all_ok: allOk, optional_pending: optionalPending, checked_at: iso(deps.now()) }
  }

  return {
    check,
    lastAllOk: () => lastAllOk,
    lastCheckedAt: () => lastCheckedAt,
    lastItems: () => lastItems,
    lastAccessibility: () => lastAccessibility,
    lastFullDiskAccess: () => lastFullDiskAccess,
  }
}

// ───────────────────────────── 逐项体检 ─────────────────────────────

async function checkNode(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const info = await io.stat(paths.nodeBin)
  const base = { key: 'node', label: '自有 node', step: 1 } as const
  const fix = `一键装会把这会儿跑着的这条 node(${io.currentNodeBinary()})复制到 ${paths.nodeBin} —— 自有一份是因为 macOS 的文件夹授权认二进制,借别人家会自动更新的 node 等于把授权寿命交给别人(0827 事故)。`
  if (info === undefined) {
    return { ...base, state: 'missing', detail: `${paths.nodeBin} 不存在`, fix, action: { kind: 'install', step: 'node', label: '装一份自有 node' } }
  }
  const probe = await io.exec([paths.nodeBin, '-p', 'process.versions.node'])
  const version = probe.out.trim().split('\n').pop() ?? ''
  const major = Number(version.split('.')[0])
  if (!probe.ok || !Number.isInteger(major)) {
    return { ...base, state: 'missing', detail: `${paths.nodeBin} 在,但跑不起来(退出码 ${probe.code})`, fix, action: { kind: 'install', step: 'node', label: '重装一份' } }
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      ...base,
      state: 'stale',
      detail: `v${version},低于 v${MIN_NODE_MAJOR}`,
      fix: `${fix} 通道层工人是直接跑 TypeScript 的,Node 必须 ≥ ${MIN_NODE_MAJOR}。`,
      action: { kind: 'install', step: 'node', label: '换成这条 node' },
    }
  }
  return { ...base, state: 'ok', detail: `v${version}` }
}

async function checkRuntime(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const base = { key: 'runtime', label: 'DSH 运行时', step: 1 } as const
  const fix = `一键装会把仓库里的锁定清单(dsh ${LOCKED_DSH_VERSION} 与它的整棵依赖树)写进 ${paths.runtimeDir},再 npm ci 照单装。网络慢很正常,断了再点一次会接着装。`
  const text = await io.readFile(paths.runtimeDshPackageJson)
  if (text === undefined) {
    return { ...base, state: 'missing', detail: `${paths.runtimeDir} 里没有 @deepseek-ai/dsh`, fix, action: { kind: 'install', step: 'runtime', label: '装运行时' } }
  }
  let version = ''
  try { version = String((JSON.parse(text) as { version?: unknown }).version ?? '') }
  catch { version = '' }
  if (version === '') {
    return { ...base, state: 'missing', detail: '装了,但 package.json 读不出版本号', fix, action: { kind: 'install', step: 'runtime', label: '重装运行时' } }
  }
  /**
   * 判据只有一处(2026-09-26,卡 U6):`readRuntimeDrift` —— 顶层版本与整棵依赖树同一个判断。
   * 「检查更新」、`/state.update`、启动时那条提示读的都是它,所以这里**不再自己比一遍版本号**:
   * 两处各判一次正是 09-26 那一幕的成因(体检说 stale,检查更新说没有新版)。
   */
  const drift = await readRuntimeDrift(io, paths.runtimeDir)
  if (drift.drifted) {
    // 顶层版本就不对(常态:换了 DSH 版本)与顶层对了只是依赖漂(09-23 cordis 那次)分开说,
    // 两句话要照着查的东西不一样。
    const topLevelOff = version !== LOCKED_DSH_VERSION
    return {
      ...base,
      state: 'stale',
      detail: topLevelOff
        ? `装的是 ${version},锁定版本是 ${LOCKED_DSH_VERSION}`
        : `dsh ${version},但依赖跟锁定清单对不上:${drift.detail}`,
      fix: topLevelOff
        ? `${fix} 本仓库锁死 DSH 版本(C3),不跟随上游。`
        : `${fix} 依赖漂了的 DSH 会一启动就崩(页面白屏)。`,
      action: { kind: 'install', step: 'runtime', label: topLevelOff ? `装回 ${LOCKED_DSH_VERSION}` : '照锁定清单重装' },
    }
  }
  return { ...base, state: 'ok', detail: version }
}

async function checkProfile(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths, pluginVersion } = deps
  const base = { key: 'profile', label: 'profile web 与插件', step: 1 } as const
  const patch = await io.readFile(paths.profilePatchYml)
  if (patch === undefined) {
    return {
      ...base,
      state: 'missing',
      detail: `${paths.profileDir} 还没建`,
      fix: '一键装会建出 profile 并写好 cordis.patch.yml(把工作台插件 insert 进去,并把网页 cookie 寿命拉长)。',
      action: { kind: 'install', step: 'profile', label: '建 profile' },
    }
  }
  if (!patch.includes('ben-workbench')) {
    return {
      ...base,
      state: 'stale',
      detail: 'profile 在,但 cordis.patch.yml 里没有把工作台 insert 进去',
      fix: '没有这条 insert,插件不会被加载,8791 整台服务都不存在。一键装会补上。',
      action: { kind: 'install', step: 'profile', label: '补 insert' },
    }
  }
  const installed = await io.readFile(paths.profilePluginPackageJson)
  if (installed === undefined) {
    return {
      ...base,
      state: 'missing',
      detail: 'profile 在,但里面没装工作台插件',
      fix: '一键装会在仓库里 build + pack,再 `dsh plugin --profile web add` 进去。',
      action: { kind: 'install', step: 'plugin', label: '装插件' },
    }
  }
  let installedVersion = ''
  try { installedVersion = String((JSON.parse(installed) as { version?: unknown }).version ?? '') }
  catch { installedVersion = '' }
  if (installedVersion !== pluginVersion) {
    return {
      ...base,
      state: 'stale',
      detail: `profile 里装的是插件 ${installedVersion === '' ? '(读不出版本)' : installedVersion},仓库里是 ${pluginVersion}`,
      fix: '一键装会重新 build + pack + add,然后要重启一次 DSH 才生效(最后一步「重启」)。',
      action: { kind: 'install', step: 'plugin', label: `装 ${pluginVersion}` },
    }
  }
  return { ...base, state: 'ok', detail: `profile web · 插件 ${installedVersion}` }
}

async function checkDshStart(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const base = { key: 'dsh_start', label: '启动脚本 dsh-start', step: 1 } as const
  const fix = '一键装会把仓库里那三份 cp 到 ~/.dsh/bin 并 chmod 755。事务官的落脚目录不在脚本里(2026-09-18 起),在 app.json —— 第一次装脚本时按你在第 2 步选的仓库记一笔,之后改它只改设置。'
  const installed = await io.readFile(paths.dshStart)
  if (installed === undefined) {
    return { ...base, state: 'missing', detail: `${paths.dshStart} 不存在(launchd 指着它,没有它 DSH 重启就起不来)`, fix, action: { kind: 'install', step: 'scripts', label: '装启动脚本' } }
  }
  if (paths.repoDshStart === undefined) {
    return { ...base, state: 'ok', detail: '脚本在(没配仓库路径,没法跟仓库副本比对)' }
  }
  const repo = await io.readFile(paths.repoDshStart)
  if (repo === undefined) {
    return { ...base, state: 'ok', detail: '脚本在(仓库里那份读不到,没法比对)' }
  }
  if (normalizeDshStart(installed) !== normalizeDshStart(repo)) {
    return {
      ...base,
      state: 'stale',
      detail: '脚本在,但内容跟仓库里那份对不上',
      fix: `${fix} 差异通常意味着仓库里改过环境变量(比如新增了一个),而本机还是老的。`,
      action: { kind: 'install', step: 'scripts', label: '按仓库覆盖' },
    }
  }
  const info = await io.stat(paths.dshStart)
  if (info !== undefined && !info.executable) {
    return { ...base, state: 'stale', detail: '内容对得上,但没有执行位', fix: '一键装会 chmod 755。', action: { kind: 'install', step: 'scripts', label: '补执行位' } }
  }
  return { ...base, state: 'ok', detail: '与仓库副本一致' }
}

async function checkLaunchd(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const base = { key: 'launchd_dsh', label: `开机自启 ${DSH_LAUNCHD_LABEL}`, step: 1 } as const
  const fix = '一键装会按仓库 deploy/ 里的模板写 plist(把 $HOME 换成本机路径),再 launchctl bootstrap 一次。'
  const plist = await io.stat(paths.dshPlist)
  if (plist === undefined) {
    return { ...base, state: 'missing', detail: `${paths.dshPlist} 不存在`, fix, action: { kind: 'install', step: 'launchd', label: '装 launchd 项' } }
  }
  const printed = await io.exec(['launchctl', 'print', `gui/${io.uid()}/${DSH_LAUNCHD_LABEL}`])
  if (!printed.ok) {
    return { ...base, state: 'missing', detail: 'plist 在,但 launchd 里没有这一项(没 bootstrap 过,或刚被卸掉)', fix, action: { kind: 'install', step: 'launchd', label: '装载进 launchd' } }
  }
  return { ...base, state: 'ok', detail: 'plist 在,launchd 认得' }
}

async function checkShellApp(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const base = { key: 'shell_app', label: '壳 App(工作台.app)', step: 1 } as const
  const fix = '一键装会跑 workbench-app/build.sh 再 ditto 到 /Applications。这台机器上有「工作台本机签名」证书的话(`bash deploy/codesign-identity.sh` 建),签名身份不变,**更新不会掉辅助功能授权**;没有那张证书就是 ad-hoc 签名,每次重建都得去系统设置里把「工作台」关一次再开。'
  const binary = await io.stat(paths.shellAppBinary)
  if (binary === undefined) {
    return { ...base, state: 'missing', detail: `${paths.shellApp} 不在(没有壳就只剩网页看板:窗位、场景、光圈全失效)`, fix, action: { kind: 'install', step: 'shell', label: '构建并安装壳' } }
  }
  const builtAt = iso(binary.mtimeMs)
  const signed = await shellSignature(deps)
  const stamp = `构建于 ${builtAt} · ${signed}`
  if (paths.repoShellSourcesDir === undefined) {
    return { ...base, state: 'ok', detail: `已安装 · ${stamp}` }
  }
  const listed = await io.readdir(paths.repoShellSourcesDir)
  if (!listed.ok) {
    return { ...base, state: 'ok', detail: `已安装 · ${stamp}(仓库源码目录读不到,没法判断新旧)` }
  }
  let newestSource = 0
  for (const name of listed.names) {
    const info = await io.stat(`${paths.repoShellSourcesDir}/${name}`)
    if (info !== undefined && info.mtimeMs > newestSource) newestSource = info.mtimeMs
  }
  // 宽限 5 秒:`build.sh` 跑完到 `ditto` 落地之间有几百毫秒,源码与产物的 mtime 几乎同刻;
  // 严格 `>` 会把"刚刚才装好的那一份"判成旧的。真正"源码改过了"的差距是分钟级起步。
  if (newestSource > binary.mtimeMs + SHELL_MTIME_GRACE_MS) {
    return {
      ...base,
      state: 'stale',
      detail: `已安装的这份构建于 ${builtAt},仓库里的源码 ${iso(newestSource)} 之后还改过 · ${signed}`,
      fix,
      action: { kind: 'install', step: 'shell', label: '重新构建并安装' },
    }
  }
  return { ...base, state: 'ok', detail: `已安装 · ${stamp}` }
}

/**
 * 装着的那份壳是「签名固定」还是「ad-hoc」,一句话。
 *
 * 问的是产物本身:`codesign -d -r -` 给的 designated requirement 就是 TCC 认的那条线。
 * `certificate leaf = H"…"` ⇒ 固定证书,重建不换,授权跨更新保留;
 * `cdhash H"…"` ⇒ ad-hoc,每次构建都换,系统当新 App,授权必掉。
 * 读不出来就如实说读不出来 —— 不猜(D13)。
 */
async function shellSignature(deps: SetupStatusDeps): Promise<string> {
  const kind = await shellSignatureKind(deps)
  if (kind === 'unknown') return '签名读不出来'
  if (kind === 'certificate') return '签名身份固定(更新不掉授权)'
  return '签名是 ad-hoc(每次重建都要重新授权辅助功能)'
}

/** 同一次 `codesign -d -r -`,只回种类。辅助功能那一项拿它分「真没授权」与「旧记录」。 */
async function shellSignatureKind(deps: SetupStatusDeps): Promise<ShellSignatureKind> {
  const shown = await deps.io.exec(['codesign', '-d', '-r', '-', deps.paths.shellApp])
  return parseShellSignature(shown.out)
}

async function checkButlerServer(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const base = { key: 'butler_server', label: '事务官本机后端(形象与音色)', step: 1, optional: true } as const
  const fix = '一键装会把仓库 butler-server/ 发到 ~/.dsh/butler-server(带 node_modules),装 butler-start 与 launchd 项。'
  const entry = await io.stat(paths.butlerServerEntry)
  if (entry === undefined) {
    return { ...base, state: 'missing', detail: `${paths.butlerServerEntry} 不在(没有它:没形象、没语音)`, fix, action: { kind: 'install', step: 'butler', label: '发布本机后端' } }
  }
  const start = await io.stat(paths.butlerStart)
  if (start === undefined) {
    return { ...base, state: 'missing', detail: '后端代码在,但 ~/.dsh/bin/butler-start 不在', fix, action: { kind: 'install', step: 'scripts', label: '装启动脚本' } }
  }
  const plist = await io.stat(paths.butlerPlist)
  if (plist === undefined) {
    return {
      ...base,
      state: 'missing',
      detail: '代码与启动脚本都在,但没有 launchd 项(设置页的「启动」只走 launchctl,装上才起得来)',
      fix: '一键装会按 butler-server/launchd/ 里那份模板写 plist 并 bootstrap,之后崩了会自动拉起。',
      action: { kind: 'install', step: 'launchd', label: '装 launchd 项' },
    }
  }
  return { ...base, state: 'ok', detail: '代码、启动脚本、launchd 项都在' }
}

async function checkChannelWorker(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const base = { key: 'channel_worker', label: '通道层工人(手机通话)', step: 1, optional: true } as const
  const fix = '一键装会把仓库 channel-worker/ 整个同步过去 —— **必须带 node_modules**:Silero VAD 的 onnxruntime 是原生模块,只拷源码起不来。'
  const entry = await io.stat(paths.channelWorkerEntry)
  if (entry === undefined) {
    return { ...base, state: 'missing', detail: `${paths.channelWorkerDir} 不在(没有它:手机打不了电话)`, fix, action: { kind: 'install', step: 'worker', label: '同步工人' } }
  }
  const native = await io.stat(paths.channelWorkerNativeDep)
  if (native === undefined) {
    return { ...base, state: 'stale', detail: '工人代码在,但 node_modules 里没有 @livekit/rtc-node(只拷了源码)', fix, action: { kind: 'install', step: 'worker', label: '连依赖一起同步' } }
  }
  const start = await io.stat(paths.channelStart)
  if (start === undefined) {
    return { ...base, state: 'missing', detail: '工人代码在,但 ~/.dsh/bin/channel-start 不在', fix, action: { kind: 'install', step: 'scripts', label: '装启动脚本' } }
  }
  return { ...base, state: 'ok', detail: '工人目录、原生依赖、启动脚本都在' }
}

async function checkRepoRoot(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io } = deps
  // 先问 butlerCwd(app.json / 环境变量),没接这条线时才退回 repoRoot ——
  // 后者在开发机上正好是同一个目录,既有用例因此一个字不用改。
  const repoRoot = (await deps.butlerCwd?.()) ?? deps.repoRoot
  const base = { key: 'butler_cwd', label: '事务官与引导的落脚目录', step: 2 } as const
  if (repoRoot === undefined || repoRoot === '') {
    return {
      ...base,
      state: 'missing',
      detail: '没配。事务官的会话开在 DSH 自己的目录里,引导整块(/onboarding/*)不启用',
      fix: '在这一步选一个目录:它会写进 ~/.dsh/workbench/app.json 的 butler_cwd,重启后生效。**不猜路径**——猜错会把记忆写进别的仓库。',
      action: { kind: 'config', target: 'paths', label: '选仓库目录' },
    }
  }
  const info = await io.stat(repoRoot)
  if (info === undefined || !info.isDirectory) {
    return {
      ...base,
      state: 'missing',
      detail: `配的是 ${repoRoot},但这个目录不存在`,
      fix: '换一个真实存在的目录,或者把仓库克隆回那个位置。',
      action: { kind: 'config', target: 'paths', label: '重选目录' },
    }
  }
  return { ...base, state: 'ok', detail: repoRoot }
}

/**
 * 事务官读不读得到那几份运营技能(2026-09-22,卡 ①「技能一键接上」)。
 *
 * ## 判据:`~/.dsh/AGENTS.md` 里有没有那几个标记段
 *
 * 不比内容、不比新旧 —— 内容对不对齐由「重新接上」那颗按钮负责(它幂等)。这里只回答
 * 一句话:**当前模板该有的那几段在不在**,外加"不该有的还剩没剩"(切回做产品却没摘干净,
 * 事务官会在做产品模板下继续按运营那套做事,那是最难查的一种"切了没生效")。
 *
 * ## 为什么标成可选
 *
 * 少了它,看板 / 窗位 / 会话这条主路照常成立(`SetupItem.optional` 那条判据) ——
 * 于是它不该让初始化页天天自己弹出来。但它**照常在体检页上亮一盏灯**,并且
 * 设置 → 模板那一节还有一行更显眼的状态。**这条是可推翻的**(决策记录里记了一份):
 * 哪天认为"运营模板下没技能 = 不可用",把 optional 去掉即可。
 */
async function checkOpsSkills(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const base = { key: 'ops_skills', label: '事务官的运营技能', step: 2, optional: true } as const
  const templateId = deps.templateId?.()
  const text = await io.readFile(paths.dshAgentsMd)
  const state = opsSkillsAttachState(text, templateId)
  const fix = '切模板时工作台会自动接一次;没接上就去设置 → 模板那一节点「重新接上」。'
    + '它写的只是 AGENTS.md 里那几个标记段,段外一个字不动,写前先备份。'

  if (text === undefined) {
    return {
      ...base,
      state: 'missing',
      // 文件不在 ≠ 出错:引导还没走过的机器上本来就没有这份文件。如实说,不吓人。
      detail: `${paths.dshAgentsMd} 还不存在,事务官一段技能都读不到`,
      fix,
      action: { kind: 'config', target: 'template', label: '去接上技能' },
    }
  }
  if (state.absent.length > 0) {
    return {
      ...base,
      state: 'missing',
      detail: `该有 ${state.expected.length} 段,现在有 ${state.attached.length} 段;缺:${state.absent.join('、')}`,
      fix,
      action: { kind: 'config', target: 'template', label: '重新接上' },
    }
  }
  if (state.stray.length > 0) {
    return {
      ...base,
      // 多出来的那几段是"旧模板留下的",按 stale 办(有、但跟现在这个模板对不上)。
      state: 'stale',
      detail: `${state.attached.length} 段都在,但还剩 ${state.stray.length} 段上个模板的没摘掉:${state.stray.join('、')}`,
      fix,
      action: { kind: 'config', target: 'template', label: '重新接上' },
    }
  }
  return {
    ...base,
    state: 'ok',
    detail: templateId === 'ops'
      ? `自媒体运营模板,${state.attached.length} 段技能都在 ${paths.dshAgentsMd} 里`
      : `当前模板该有的 ${state.attached.length} 段都在,运营那几段按规矩没写`,
  }
}

/**
 * 辅助功能那一项。2026-09-18 起分出**第四种**结局:「开关在、但那条记录是旧签名的壳」
 * —— 判断本身全在 accessibility.ts(纯函数 + 一次只读探测),这里只负责把结论写成人话。
 *
 * 回的是 `{ item, kind }` 而不是光一个 item:顶上那条横幅要的是 kind(机器可读),
 * 从 detail 那句中文里反解出来迟早解错(先例:`ben-wb__card` 那种靠字面对齐的东西都塌过)。
 */
async function checkAccessibility(deps: SetupStatusDeps): Promise<{ item: SetupItem, kind: AccessibilityKind }> {
  const base = { key: 'accessibility', label: '辅助功能授权', step: 3 } as const
  const view = deps.helper?.()
  if (view === undefined) {
    return {
      kind: 'unreachable',
      item: {
        ...base,
        state: 'needs_user',
        detail: '壳通道没接线,判断不了(这不是"没授权",是"看不到")',
        fix: '先把壳装上并打开;壳连上之后这一项会自己变。',
        action: { kind: 'open_pane', pane: 'accessibility', label: '去授权' },
      },
    }
  }
  if (!view.connected) {
    return {
      kind: 'unreachable',
      item: {
        ...base,
        state: 'needs_user',
        detail: `壳没连上(${view.reason ?? '工作台.app 没在运行'})`,
        fix: '先打开 /Applications/工作台.app;连上之后再看这一项。',
        action: { kind: 'open_pane', pane: 'accessibility', label: '去授权' },
      },
    }
  }
  if (!view.authorized) {
    // 这几下只在"连上了但没授权"这一支跑:体检本身有节流(SETUP_RECHECK_MS),
    // 而正常情况下压根到不了这里。sqlite3 那一下几乎必然失败,失败就是 'unknown'。
    const shown = await deps.io.exec(['codesign', '-d', '-r', '-', deps.paths.shellApp])
    const signature = parseShellSignature(shown.out)
    const record = await probeTccRecord(deps.io)
    // 2026-09-23:这台机器上**以前**授权过哪个签名(见 accessibility.ts 文件头的修正那一节)。
    const grant = grantHistoryOf(
      parseGrantRecord(await deps.io.readFile(deps.paths.accessibilityGrantJson)),
      parseDesignatedRequirement(shown.out),
    )
    const kind = accessibilityKindOf({ helper: view, signature, record, grant })
    if (kind === 'stale_record') {
      return {
        kind,
        item: {
          ...base,
          state: 'needs_user',
          detail: record === 'present'
            ? '系统设置里有「工作台」这条记录、开关也在,但壳报未授权 —— 那条记录对应的是旧签名的壳'
            : '这台机器以前给「工作台」授权过,但那是旧签名的壳;现在这份换了签名,系统把它当成另一个 App —— 系统设置里那条开关记的还是旧的',
          fix: '系统设置 → 隐私与安全性 → 辅助功能,把「工作台」**选中按 − 移除**,再按 + 重新添加 /Applications/工作台.app,然后点一下工作台窗口(激活时重查授权)。以后更新不会再要这一步。',
          action: { kind: 'open_pane', pane: 'accessibility', label: '去授权' },
        },
      }
    }
    return {
      kind,
      item: {
        ...base,
        state: 'needs_user',
        detail: '「工作台」还没有辅助功能授权:它要替你把别的应用窗口摆进窗位、拖进来认领、把话送进 Claude/Codex 的输入框,这些都要它',
        fix: '点「去授权」:系统会弹一个框,点「打开系统设置」,在「辅助功能」里把「工作台」打开,开完点一下工作台窗口(激活时重查授权)。没弹框就在已经打开的那一页里找「工作台」。开关已经开着却还是这样,就把它关一次再开。',
        action: { kind: 'open_pane', pane: 'accessibility', label: '去授权' },
      },
    }
  }
  await rememberGrant(deps)
  return { kind: 'ok', item: { ...base, state: 'ok', detail: '壳已连上且已授权' } }
}

/**
 * 看到已授权时,把壳此刻的签名要求记一笔(2026-09-23)。以后再报未授权,才分得清
 * 「从没授权过」和「授权过的是旧签名」。只在变了时写;读不出签名、写失败都吞掉 ——
 * 这一笔记不上,最坏只是以后按「还没授权」说,那是安全的那一边。
 */
async function rememberGrant(deps: SetupStatusDeps): Promise<void> {
  try {
    const shown = await deps.io.exec(['codesign', '-d', '-r', '-', deps.paths.shellApp])
    const requirement = parseDesignatedRequirement(shown.out)
    if (requirement === undefined) return
    const recorded = parseGrantRecord(await deps.io.readFile(deps.paths.accessibilityGrantJson))
    if (recorded === requirement) return
    await deps.io.writeFile(deps.paths.accessibilityGrantJson, `${JSON.stringify({ requirement, seen_at: new Date(deps.now()).toISOString() }, null, 2)}\n`)
  }
  catch {
    // 见上:记不上不是故障。
  }
}

async function checkDocuments(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const base = { key: 'documents', label: '文稿文件夹授权', step: 3 } as const
  const roots = await deps.scanRoots()
  if (roots.length === 0) {
    return { ...base, state: 'ok', detail: '没有配扫描根,不需要这项授权' }
  }
  const denied: string[] = []
  const missing: string[] = []
  for (const root of roots) {
    const listed = await io.readdir(root)
    if (listed.ok) continue
    if (listed.code === 'EPERM' || listed.code === 'EACCES') denied.push(root)
    else missing.push(root)
  }
  if (denied.length > 0) {
    return {
      ...base,
      state: 'needs_user',
      detail: `读不动:${denied.join('、')}(EPERM —— 授权认二进制,给的是 ${paths.nodeBin})`,
      fix: `系统设置 → 隐私与安全性 → 文件和文件夹,给 ${paths.nodeBin} 勾上「文稿文件夹」。重启 DSH 后系统也可能自己弹一次授权框,点允许即可。`,
      action: { kind: 'open_pane', pane: 'files', label: '去授权' },
    }
  }
  if (missing.length > 0) {
    return {
      ...base,
      state: 'ok',
      detail: `能读(${missing.join('、')}这几个目录不存在,不是权限问题)`,
    }
  }
  return { ...base, state: 'ok', detail: `${roots.length} 个扫描根都读得动` }
}

/**
 * 「完全磁盘访问」给没给(2026-10-13)。判法与探针的理由在 `setup/fullDiskAccess.ts` 文件头。
 *
 * 这一格**是可选的**,判据按 SetupItem.optional 那条写死的规矩走:少了它主路
 * (看板 + 窗位 + 会话)仍然成立 —— 坏掉的是手机上看电脑文件那一条。所以它不拖住
 * `all_ok`(不该让纯电脑用的人天天被初始化页弹脸),缺着那件事由顶上那条横幅说
 * (`/state.setup_alerts.file_access` → client/NeedBar.tsx)。
 *
 * 三颗键不是堆按钮:打开那一页 → 把隐藏目录里那条 node 翻出来拖进去 → 回来确认,
 * 少一步她就做不完(`.dsh` 在系统设置的选文件框里翻不到)。
 */
async function checkFullDiskAccess(deps: SetupStatusDeps): Promise<{ item: SetupItem, kind: FullDiskAccessKind }> {
  const { paths } = deps
  const base = { key: 'full_disk_access', label: '完全磁盘访问(手机看文件)', step: 3, optional: true } as const
  const probed = await probeFullDiskAccess(deps.io, paths.home)
  if (probed.kind === 'ok') {
    return { kind: 'ok', item: { ...base, state: 'ok', detail: `列得动 ${probed.path} —— 这条服务(${paths.nodeBin})已经有完全磁盘访问,手机取文件不会再弹框` } }
  }
  /**
   * 「加完要不要重启」这一句**按日志说**,不按常识猜:2026-10-13 在维护者这台机器上,
   * 一个 10-12 21:17 就起来的 8791 进程在 09:51 那次授权之后(**没重启**)读到的是
   * `Allowed (System Set)` —— 当场生效。详见 fullDiskAccess.ts 文件头。
   */
  const fix = `${FULL_DISK_WHY}点「打开系统设置那一页」,再点「在访达里显示要加的那个文件」把 ${paths.nodeBin} 拖进那张表`
    + '(`.dsh` 是隐藏目录,在选文件框里翻不到它,所以要这一下);加完点「再核一次」,一般当场就生效、不用重启 —— 要是核了还说没给,再重启一次工作台(第 1 步末尾那颗键)。'
  const action = { kind: 'open_pane' as const, pane: 'all_files' as const, label: '打开系统设置那一页' }
  const extras = [
    { kind: 'open_pane' as const, pane: 'node_binary' as const, label: '在访达里显示要加的那个文件' },
    { kind: 'recheck' as const, label: '再核一次' },
  ]
  if (probed.kind === 'denied') {
    return {
      kind: 'denied',
      item: {
        ...base,
        state: 'needs_user',
        detail: `列不动 ${probed.path}(EPERM)—— 还没给过完全磁盘访问;手机每取一次文件,电脑上就弹一个「node 想要访问…」等人点`,
        fix,
        action,
        extras,
      },
    }
  }
  return {
    kind: 'unknown',
    item: {
      ...base,
      state: 'needs_user',
      detail: '判断不了:那几条只有完全磁盘访问才列得动的目录在这台机器上都不在(说不出给没给,也不当成给了)',
      fix,
      action,
      extras,
    },
  }
}

async function checkCalendar(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io } = deps
  const base = { key: 'calendar', label: '日历授权', step: 3, optional: true } as const
  const probe = await io.exec(
    ['osascript', '-e', 'tell application "Calendar" to count calendars'],
    { timeoutMs: 20_000 },
  )
  if (!probe.ok) {
    return {
      ...base,
      state: 'needs_user',
      detail: `问不到日历(osascript 退出码 ${probe.code})`,
      fix: '系统设置 → 隐私与安全性 → 日历,允许 DSH 宿主进程访问。没弹过框的话,这条探测本身会触发一次系统弹框,点允许即可。',
      action: { kind: 'open_pane', pane: 'calendar', label: '去授权' },
    }
  }
  return { ...base, state: 'ok', detail: `读到 ${probe.out.trim().split('\n').pop() ?? '?'} 个日历` }
}

/**
 * DSH 网页的登录态(第 3 步的第一屏)。
 *
 * ★这一项判的是**能不能种出 cookie**,不是"这台浏览器此刻有没有 cookie" ——
 * 后者服务端根本看不到(cookie 在浏览器里,8791 这边没有那个浏览器的请求)。
 * 能看到的事实有两条,而且够用:
 *   ① `$DSH_HOME/.credentials.yaml` 在不在 —— 它是 cookie 的签名密钥,**重启不变**;
 *      丢了(再来一次家目录事故)= 所有 cookie 立刻作废,必须重新引导一次;
 *   ② 日志里有没有本次启动的 token —— 有它才补得出一个带 token 的地址。
 * 所以:密钥在 = ok(你现在能看到这一页,本身就说明这台浏览器的 cookie 有效),
 * 但按钮一直留着,换浏览器 / 壳重建之后拿它再种一次。
 */
async function checkWebCookie(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const base = { key: 'web_cookie', label: 'DSH 网页登录态', step: 3 } as const
  const log = await io.readFile(paths.webStdoutLog)
  const token = log === undefined ? undefined : latestWebToken(log)
  const secret = await io.stat(paths.dshCredentialsYaml)
  if (secret === undefined) {
    return {
      ...base,
      state: 'missing',
      detail: `${paths.dshCredentialsYaml} 不在:签名密钥还没生成,或者随家目录一起丢了`,
      fix: 'DSH 起来过一次就会生成它。先把运行时与 launchd 装好、重启一次,再回来种 cookie。',
      ...(token === undefined ? {} : { action: { kind: 'web_login' as const, label: '用最新 token 开一次' } }),
    }
  }
  if (token === undefined) {
    return {
      ...base,
      state: 'ok',
      detail: '签名密钥在;日志里暂时没有本次启动的 token(多半是日志被轮转过),现有 cookie 不受影响',
    }
  }
  return {
    ...base,
    state: 'ok',
    detail: '签名密钥在,能补发 token;你现在看得到这一页,说明这台浏览器的 cookie 有效',
    action: { kind: 'web_login', label: '再种一次 cookie(换浏览器/壳重建后用)' },
  }
}

/**
 * DeepSeek 密钥那一项。2026-09-23 起**先看模型从哪儿来**(`model.json` 的 mode):
 *
 * 默认是工作台提供的模型服务(中转),新用户自始至终不需要 DeepSeek Key —— 09-23 从零重装
 * 自跑时顶上却挂着「还没填 DeepSeek 密钥(额度与事务官接话要它)」,两半都不对:
 * 事务官接话走中转令牌,额度那一格走中转用量(quota/relay.ts,走中转时一次都不问官方余额)。
 *
 * 所以只有他**自己切到「用自己的 Key」**时才查那两处。中转还没接上是另一件事,
 * 归顶上「模型服务还没接上 → 重试」那一条说(modelAutoSetup),不在这里催他填 Key。
 * `model.json` 不在 = 什么都没配过 = 构建缺省(同 modelConfig.parseModelConfig):我们的构建是中转;
 * 开源构建没带中转(2026-10-21,零服务器档)= 只能用自己的 Key,这时就该催,话里不提「切回工作台的服务」。
 */
async function checkDeepseekKey(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const model = parseModelConfig(await io.readFile(paths.modelJson), () => '')
  if (model.mode === 'relay') {
    return {
      key: 'deepseek_key',
      label: 'DeepSeek 密钥(可选)',
      step: 4,
      optional: true,
      state: 'ok',
      detail: model.relay_token === undefined
        ? '用的是工作台提供的模型服务,不需要 DeepSeek 密钥(模型服务还没接上的话,顶上那条「重试」会说)'
        : '用的是工作台提供的模型服务,不需要 DeepSeek 密钥',
    }
  }
  const base = { key: 'deepseek_key', label: 'DeepSeek 密钥(两处)', step: 4 } as const
  const envText = await io.readFile(paths.dshEnvFile)
  const credText = await io.readFile(paths.credentialsJson)
  const inEnv = envText !== undefined && envHasDeepseekKey(envText)
  const inCred = credText !== undefined && credentialsHaveDeepseekKey(credText)
  if (inEnv && inCred) return { ...base, state: 'ok', detail: '两处都配了' }
  const where = [inEnv ? undefined : `${paths.dshEnvFile}(DSH 自己用)`, inCred ? undefined : '工作台设置里那一格(额度与工人接话)']
    .filter((x): x is string => x !== undefined)
  return {
    ...base,
    state: 'needs_user',
    detail: `还差:${where.join('、')}`,
    fix: relayConfigured(model)
      ? '你选了「用自己的 DeepSeek Key」。在设置里那格填一次 key,工作台会同时写这两处。**这是密钥,只能你本人填**——填完永不回显。不想填就切回「用工作台提供的服务」。'
      : `${NO_RELAY_NOTE},模型用你自己的 DeepSeek Key。在设置里那格填一次 key,工作台会同时写这两处。**这是密钥,只能你本人填**——填完永不回显。`,
    action: { kind: 'config', target: 'credentials', label: '去填密钥' },
  }
}

/**
 * Claude 的钩子接没接上(第 4 步)。**与额度面板同一个判据**(clientScan.ts;卡 R,2026-09-25):
 * 配置里有工作台自己的 hook、指着钩子脚本的固定位置(`~/.dsh/workbench/hooks/agent-hook.sh`)、
 * 那个脚本真在、能执行。两处各判一套,就会出现「体检说好了、额度面板说没接上」的夹缝。
 *
 * 卡 R 之前这里「有任意一条 hook 就算好」,修法那一句还叫他去仓库里抄模板、换成本机仓库路径 ——
 * 装好的机器上没有仓库。现在修法只有一颗按钮,指着旧位置(开发仓库)的条目也是点它换过去。
 */
async function checkClaudeHooks(deps: SetupStatusDeps): Promise<SetupItem> {
  const { io, paths } = deps
  const base = { key: 'claude_hooks', label: 'Claude 的四个 hook 与状态栏', step: 4 } as const
  const action = { kind: 'config', target: 'hooks', label: '看该写什么' } as const
  const text = await io.readFile(paths.claudeSettings)
  const fix = '点「帮我接上 Claude」:工作台先给你看一眼要写什么,原来的配置另存一份,写完随时能撤回。'
  if (text === undefined) {
    return { ...base, state: 'needs_user', detail: 'Claude 的配置文件还没有:会话区收不到 Claude 的动静,会话会一直显示"在跑"', fix, action }
  }
  const ours = wbHookCommands(text)
  if (ours.length === 0) {
    return { ...base, state: 'needs_user', detail: 'Claude 的配置文件在,但里面没有工作台的 hook', fix, action }
  }
  const dir = wbHooksDir(paths.home)
  const script = dir === undefined ? undefined : `${dir}/${WB_HOOK_SCRIPT}`
  const moveFix = '点「帮我接上 Claude」换到新位置:旧的那几条会被换掉,别的设置一个字不动,换完随时能撤回。'
  if (script === undefined || !ours.includes(script)) {
    return { ...base, state: 'stale', detail: '工作台的 hook 还指着旧位置(开发用的源码目录),工作台升级或换机之后会失效', fix: moveFix, action }
  }
  const info = await io.stat(script)
  if (info?.isFile !== true || !info.executable) {
    return { ...base, state: 'stale', detail: 'hook 指着的那个小脚本不在了(重启一次工作台会放回去)', fix: moveFix, action }
  }
  const found = claudeHooksPointAt(text)
  return { ...base, state: 'ok', detail: `${ours.length} 条 hook${found.statusLine ? ' + 状态栏' : '(没有状态栏那一行)'}` }
}

/**
 * Codex 放没放行工作台的钩子(第 5 步,可选;2026-10-21)。
 *
 * 新版 Codex 对没放行过的钩子**静悄悄跳过**:配置里写着我们那三条,Codex 一条都不跑,也不报错。
 * 10-21 维护者那台就是这样 —— 三条写进去近一个月,一次都没跑过。这一项问 Codex 自己
 * (codexHookTrust.ts),再告诉她去 Codex 的哪一页点哪颗。她要做的只有点一次;命令只指固定位置,
 * 工作台升级不会让它失效(hooksConfig.ts 的 `wbHooksRender`)。
 *
 * 配置里压根没有工作台的钩子时不出这一项 —— 那是额度面板「全部接上」那颗按钮的事,这里不催没接过的人。
 */
async function checkCodexHooks(deps: SetupStatusDeps): Promise<SetupItem | undefined> {
  if (deps.codexHookTrust === undefined) return undefined
  const trust = await deps.codexHookTrust()
  if (trust.state === 'not_wired') return undefined
  const base = { key: 'codex_hooks', label: 'Codex 的三个钩子', step: 5, optional: true } as const
  const recheck = { kind: 'recheck', label: '再核一次' } as const
  // 少了它们会怎样:会话区靠 Codex 的会话文件也能看到对话,缺的是这两样(交接里有逐条依赖)。
  const missing = '会话区里 Codex 的会话关了要等两小时才收起,派给 Codex 在后台跑的活也不出现在会话区'
  const how = `${CODEX_TRUST_HOW},再回来点「再核一次」。只要点这一次,工作台以后升级不会让它失效。那一页顶上的「全部信任」会把别的工具装的钩子一起放行,看清再点。`
  switch (trust.state) {
    case 'trusted':
      return { ...base, state: 'ok', detail: `${trust.count} 条都已在 Codex 里放行` }
    case 'needs_review':
      return {
        ...base,
        state: 'needs_user',
        detail: trust.modified === trust.pending
          ? `Codex 记得的和现在的对不上(${trust.modified} 条改过或挪了位置),重新放行之前它不跑:${missing}`
          : `Codex 还没放行工作台的钩子(${trust.pending} 条),没放行之前它一条都不跑:${missing}`,
        fix: how,
        action: recheck,
      }
    case 'disabled':
      return {
        ...base,
        state: 'needs_user',
        detail: `工作台的钩子在 Codex 里被关掉了(${trust.disabled} 条):${missing}`,
        fix: '打开 ChatGPT 里的 Codex → 设置 →「钩子」,把命令里带 agent-hook.sh 的那几条的开关打开,再回来点「再核一次」。',
        action: recheck,
      }
    case 'not_loaded':
      return {
        ...base,
        state: 'needs_user',
        detail: `Codex 的配置里写着工作台的钩子,但 Codex 没认出来:${missing}`,
        fix: `打开 ChatGPT 里的 Codex → 设置 →「钩子」看一眼:列着带 agent-hook.sh 的条目就点「信任」;一条都没列,多半是 Codex 那边的钩子功能被关了。看完回来点「再核一次」。`,
        action: recheck,
      }
    case 'unknown':
      return {
        ...base,
        state: 'needs_user',
        detail: '问不到 Codex 放没放行工作台的钩子(Codex 这次没回话)',
        fix: `自己看一眼:${CODEX_TRUST_HOW}(已经写着信任的就不用动),再回来点「再核一次」。`,
        action: recheck,
      }
  }
}

async function checkClient(io: SetupIo, row: { key: string, label: string, bundle: string, url: string }): Promise<SetupItem> {
  const base = { key: `client_${row.key}`, label: row.label, step: 5, optional: true } as const
  if (row.bundle === '') {
    return { ...base, state: 'needs_user', detail: '这家的 bundle id 没登记,查不了', fix: '在 server/activation.ts 的 APP_BUNDLES 里补一条。', action: { kind: 'link', url: row.url, label: '去官网' } }
  }
  // 2026-09-17「每个区域单独解锁」:探测挪去 server/clientScan.ts,体检页与看板共用同一条。
  // 两处各写一份 mdfind 的话,同一台机器上「体检说装了、看板说没装」迟早出现。
  const probe = await probeInstalled(io, row.bundle)
  if (probe === undefined || !probe.found) {
    return {
      ...base,
      state: 'needs_user',
      detail: probe === undefined ? `查不出来(mdfind 没跑成,bundle id ${row.bundle})` : `没找到(bundle id ${row.bundle})`,
      fix: '装了之后工作台才认得它的窗口与会话。没装也能用工作台,只是这一家整块不出现(不显示、不催)。',
      action: { kind: 'link', url: row.url, label: '去下载' },
    }
  }
  return { ...base, state: 'ok', detail: probe.path ?? row.bundle }
}
