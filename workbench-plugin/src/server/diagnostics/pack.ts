/**
 * 一键诊断包(2026-09-22)。设置 → 体检与修复 → 「导出诊断包」按下去之后发生的事。
 *
 * Ben 原话:「我弄了台新 Mac,到时候就是脱机运行了,报错信息和日志什么的得准备好,
 * 不然你修复和优化都很不方便。」他不走命令行,所以"把现场发过来"必须是一颗按钮
 * 加一个能在微信里拖出去的文件。
 *
 * ## 这一版最要紧的一条:**白名单,不是黑名单**
 *
 * 常见做法是"把 `~/.dsh/workbench` 打包,排除掉几个凭据文件"。这一版不这么做。
 * 收进包里的每一样东西都在下面的 `CONFIG_FILES` / `logSourcesOf` 里**逐个写着名字**,
 * 没写的一律不进包。区别在于出错的方向:
 *
 *   - 黑名单漏一条 = 一把钥匙被发出去了,而且**没人会发现**;
 *   - 白名单漏一条 = 诊断包里少一样东西,下次补上。
 *
 * 2026-09-04 家目录被删那次的教训是同一条:危险操作要列清单,不要写通配。
 *
 * 白名单之外还有第二道(`EXCLUDED_NAMES` + 出包前的逐文件复查)—— 不是因为不信白名单,
 * 是因为以后会有人往 `CONFIG_FILES` 里加东西,而那个人未必记得这段注释。
 *
 * ## 凭据文件有哪些(《验收-从零重装清单-2026-09-17》第八、九节)
 *
 * `credentials.json`、`account.json`、`account-server.json`、`account-session.key`、
 * `channel.json`、`model.json`、`login-profile-…`(浏览器档案目录,里头有 cookie)、
 * `.env`、`.credentials.yaml`、`butler.json`(里头有 butler 的 token)。
 * **一律不进包**,一条都不例外。
 *
 * ## 体积
 *
 * 日志按尾巴取(每份最多 `PER_LOG_BYTES`),整包未压缩封顶 `TOTAL_BYTES`。
 * 超了先丢最老的轮转日志 —— 排障要的是"刚才",不是上周二。
 * 丢掉的每一条都写进清单,**不静悄悄地丢**。
 */
import { DIAG_COMPONENT_TITLES } from '../../diag.ts'
import type { ProcessHealthView } from '../../protocol.ts'
import { APP_OPEN_TAG } from '../appOpenLog.ts'
import type { SetupPaths } from '../setup/paths.ts'
import { dropFirstPartialLine, type DiagIo } from './io.ts'
import { redactJson, redactLines, redactPath, redactText, REDACTED } from './redact.ts'

/** 收最近几天的日志。7 天是卡上定的:再往前的东西在排"昨天开始不对劲"时没用。 */
export const DIAG_DAYS = 7

/** 单份日志最多取尾部这么多字节(2MB ≈ 两万行中文日志)。 */
export const PER_LOG_BYTES = 2 * 1024 * 1024

/** 整包未压缩封顶。超了从最老的轮转日志开始丢。 */
export const TOTAL_BYTES = 40 * 1024 * 1024

/**
 * 壳那段 `log show` 最多留这么多行。
 *
 * **2026-10-02 从 2000 提到 20000**(同一张卡的第三件:「壳统一日志只截 2000 行的问题
 * 一并看看能不能按时间窗取」)。10-02 排「网易云每隔 10s 自行打开」时,壳的那一段
 * **只覆盖到 10:36—11:27**(不到一小时)—— 要查的那一段早被 2000 行挤掉了。
 *
 * 做法是**先收窄时间窗、再给行数留富余**:面包屑那一段只要
 * {@link SHELL_LOG_WINDOW_HOURS} 小时(不是 7 天),行数给到两万 ——
 * 于是「最近 24 小时」基本是整段带走,而不是"最后 2000 行恰好只有 50 分钟"。
 * 真超了也**说出来**(那一段的小标题里写明一共多少行、留了多少),不静悄悄地丢。
 */
export const SHELL_LOG_LINES = 20_000

/**
 * 壳那段「全级别面包屑」只取最近这么多小时。
 *
 * 24 小时是维护者定的下限(「至少覆盖最近 24 小时」):她发诊断包多半是"今天出的事",
 * 而壳的 default 级别里有我们自己 NSLog 的每一行(含 2026-10-02 起每一次开 App 那一行),
 * 7 天的量在一台天天开着的机器上能到几十万行 —— 窗开那么大,等于又回到"被挤掉"。
 * error / fault 那一段照旧取整 {@link DIAG_DAYS} 天(它本来就稀疏,留得越久越有用)。
 */
export const SHELL_LOG_WINDOW_HOURS = 24

/** `log show` 给多久。它要翻系统的统一日志库,7 天在慢机器上能跑十几秒。 */
export const SHELL_LOG_TIMEOUT_MS = 60_000

/**
 * **绝不进包的文件名**(第二道门,白名单之外的保险)。
 * 命中的文件在出包前被剔出去,并在清单里留一行「按规则剔除」。
 */
export const EXCLUDED_NAMES: readonly string[] = [
  'credentials.json',
  'account.json',
  'account-server.json',
  'account-session.key',
  'channel.json',
  'model.json',
  '.env',
  '.credentials.yaml',
  'butler.json',
  'devices.json',
]

/** 绝不进包的目录名前缀(浏览器登录档案:cookie、localStorage 全在里头)。 */
export const EXCLUDED_DIR_PREFIXES: readonly string[] = ['login-profile-']

export function isExcludedName(name: string): boolean {
  if (EXCLUDED_NAMES.includes(name)) return true
  return EXCLUDED_DIR_PREFIXES.some(prefix => name.startsWith(prefix))
}

/**
 * 进包的配置文件。**逐个写名字**(理由见文件头)。
 * 卡上点名的四样:app.json / template / layout / dock —— layout 在 `/state` 的快照里,
 * 落盘那一份就是 `dock.json` 与 `scenes.json`。
 */
export const CONFIG_FILES: readonly { name: string, title: string }[] = [
  { name: 'app.json', title: '工作台开关(局域网、扫描根、事务官目录)' },
  { name: 'template.json', title: '当前模板' },
  { name: 'dock.json', title: '窗位与布局' },
  { name: 'scenes.json', title: '场景' },
  { name: 'appearance.json', title: '外观' },
  { name: 'peak-hours.json', title: '峰谷时段' },
]

export interface DiagLogSource {
  /** 绝对路径。 */
  path: string
  /** 包内文件名。 */
  name: string
  /** 谁写的,人话。 */
  owner: string
}

/**
 * 要收哪几份日志。轮转出来的兄弟文件(`<名字>.2026-09-21`,见 rotate.ts)
 * 由 `collectLogs` 现扫,这里只列**活着的那一份**。
 */
export function logSourcesOf(paths: SetupPaths): readonly DiagLogSource[] {
  return [
    { path: `${paths.logsDir}/web.stdout.log`, name: 'web.stdout.log', owner: '工作台插件(跑在 DSH 里)' },
    { path: `${paths.logsDir}/web.stderr.log`, name: 'web.stderr.log', owner: '工作台插件' },
    { path: `${paths.logsDir}/butler.stdout.log`, name: 'butler.stdout.log', owner: '语音后端 butler-server' },
    { path: `${paths.logsDir}/butler.stderr.log`, name: 'butler.stderr.log', owner: '语音后端 butler-server' },
    { path: `${paths.dshHome}/workbench/logs/channel-worker.log`, name: 'channel-worker.log', owner: '通话工人(本机房间)' },
    // 云房间那一条(2026-10-22,卡 M6):登录且中转配了房间才有。没有这个文件就照老样子跳过。
    { path: `${paths.dshHome}/workbench/logs/channel-worker-relay.log`, name: 'channel-worker-relay.log', owner: '通话工人(云房间)' },
  ]
}

export interface DiagPackEntry {
  /** 包内路径。 */
  path: string
  /** 原文件在哪(**脱敏过**:`/Users/<用户>/…`)。现造的那几份没有这一格。 */
  from?: string
  bytes: number
  /** 前面被砍掉过。 */
  truncated?: boolean
  note?: string
}

export interface DiagPackSkipped {
  what: string
  why: string
}

export interface DiagPackStage {
  /** 暂存目录里那棵树(zip 之前)。 */
  dir: string
  entries: readonly DiagPackEntry[]
  skipped: readonly DiagPackSkipped[]
  /** 未压缩总字节。 */
  bytes: number
}

export interface DiagSnapshotSource {
  /** 包内文件名(不含目录)。 */
  name: string
  title: string
  load: () => Promise<unknown>
}

export interface DiagPackDeps {
  io: DiagIo
  paths: SetupPaths
  /** 现在几点(毫秒)。测试注入固定时钟。 */
  now: () => number
  pluginVersion: string
  /** `/state`、`/channel/status`、`/call/log`、体检结果 …… 取不到就整格缺席,不编。 */
  snapshots: readonly DiagSnapshotSource[]
  /**
   * 插件进程自己的内存与事件循环(2026-10-19;`processHealth.view()`)。
   * 进概要而不是快照:它是「这份包是在一个什么状态的进程里导出来的」,与版本、机器并列。取不到就缺席。
   */
  process?: () => ProcessHealthView | undefined
  /** 装着的产物记录(`~/.dsh/updates/installed.json`),读不到就缺席。 */
  days?: number
  perLogBytes?: number
  totalBytes?: number
}

/** `2026-09-22T10:15:00` → `20260922-101500`,当文件名用。本地时区,因为 Ben 看的是本地时间。 */
export function stampOf(atMs: number, tzOffsetMinutes: number): string {
  const shifted = new Date(atMs + tzOffsetMinutes * 60_000)
  const iso = shifted.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
}

/** 包(与暂存目录)的名字。 */
export function packNameOf(atMs: number, tzOffsetMinutes: number): string {
  return `工作台诊断包-${stampOf(atMs, tzOffsetMinutes)}`
}

/** 摆包过程中的累加器。`renderManifest` 收它,所以它必须导出。 */
export interface DiagStageAccum {
  entries: DiagPackEntry[]
  skipped: DiagPackSkipped[]
  bytes: number
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 摆一棵暂存树。**只写 `dir` 之下**,一个字节都不往别处写。
 * zip 与"在访达里选中"是下一步的事(service.ts),这里只管"包里有什么"。
 */
export async function stageDiagPackage(deps: DiagPackDeps, dir: string): Promise<DiagPackStage> {
  const io = deps.io
  const days = deps.days ?? DIAG_DAYS
  const perLog = deps.perLogBytes ?? PER_LOG_BYTES
  const total = deps.totalBytes ?? TOTAL_BYTES
  const at = deps.now()
  const staged: DiagStageAccum = { entries: [], skipped: [], bytes: 0 }

  async function put(path: string, text: string, extra: Omit<DiagPackEntry, 'path' | 'bytes'> = {}): Promise<void> {
    const size = bytesOf(text)
    if (staged.bytes + size > total) {
      staged.skipped.push({ what: path, why: `整包已经到了上限 ${Math.round(total / 1024 / 1024)}MB` })
      return
    }
    await io.writeFile(`${dir}/${path}`, text)
    staged.entries.push({ path, bytes: size, ...extra })
    staged.bytes += size
  }

  /* ── 一、概要:版本、机器、这份包是怎么来的 ───────────────────────────── */
  const summary = await summaryOf(deps, at)
  await put('概要.json', `${JSON.stringify(summary, null, 2)}\n`)

  /* ── 二、快照:/state、/channel/status、/call/log、体检结果 ───────────── */
  for (const source of deps.snapshots) {
    let value: unknown
    try { value = await source.load() }
    catch (error) {
      staged.skipped.push({ what: `快照/${source.name}`, why: `取不到:${redactText(errorTextOf(error))}` })
      continue
    }
    if (value === undefined) {
      staged.skipped.push({ what: `快照/${source.name}`, why: '这一块没接线(比如通话层没启用)' })
      continue
    }
    await put(`快照/${source.name}`, `${JSON.stringify(redactJson(value), null, 2)}\n`, { note: source.title })
  }

  /* ── 三、配置:白名单里那几份 ────────────────────────────────────────── */
  for (const file of CONFIG_FILES) {
    const from = `${deps.paths.dshHome}/workbench/${file.name}`
    if (isExcludedName(file.name)) {
      // 白名单与黑名单打架时**黑名单赢**。这一条永远不该触发;触发了说明有人往
      // CONFIG_FILES 里加错了东西,而清单会把它摆出来。
      staged.skipped.push({ what: `配置/${file.name}`, why: '按凭据规则剔除' })
      continue
    }
    const text = await io.readFile(from)
    if (text === undefined) {
      staged.skipped.push({ what: `配置/${file.name}`, why: '这台机器上没有这个文件' })
      continue
    }
    let value: unknown
    try { value = JSON.parse(text) }
    catch {
      staged.skipped.push({ what: `配置/${file.name}`, why: '文件不是合法 JSON(本身就是个线索,已记在这里)' })
      continue
    }
    await put(`配置/${file.name}`, `${JSON.stringify(redactJson(value), null, 2)}\n`, {
      from: redactPath(from),
      note: file.title,
    })
  }

  /* ── 四、日志:最近 N 天,轮转出来的也算 ─────────────────────────────── */
  const logs = await collectLogs(io, deps.paths, { at, days, perLog })
  // 新的在前:总量超了先丢最老的那几份(排障要的是"刚才",不是上周二)。
  for (const log of logs.found) {
    await put(`日志/${log.name}`, log.text, {
      from: redactPath(log.path),
      ...(log.truncated ? { truncated: true } : {}),
      note: `${log.owner}${log.truncated ? `(只留了尾部 ${Math.round(perLog / 1024 / 1024)}MB)` : ''}`,
    })
  }
  staged.skipped.push(...logs.skipped)

  /* ── 五、壳的统一日志 ───────────────────────────────────────────────── */
  const shell = await shellLogOf(io, days)
  if (shell.ok) await put('日志/壳-统一日志.txt', shell.text, { note: shell.note })
  else staged.skipped.push({ what: '日志/壳-统一日志.txt', why: shell.why })

  /* ── 六、复查:白名单里混进凭据了吗 ─────────────────────────────────── */
  const offenders = staged.entries.filter(entry => isExcludedName(entry.path.split('/').pop() ?? ''))
  for (const entry of offenders) {
    await io.rmrf(`${dir}/${entry.path}`)
    staged.entries = staged.entries.filter(item => item !== entry)
    staged.bytes -= entry.bytes
    staged.skipped.push({ what: entry.path, why: '出包前复查时按凭据规则剔除' })
  }

  /* ── 七、清单。**最后写** —— 它要把上面所有决定都写进去 ─────────────── */
  const manifest = renderManifest({ stage: staged, summary, at, days, perLog, total })
  await io.writeFile(`${dir}/包内清单.md`, manifest)
  staged.entries.unshift({ path: '包内清单.md', bytes: bytesOf(manifest), note: '这份包里有什么、没有什么、脱敏规则' })
  staged.bytes += bytesOf(manifest)

  return { dir, entries: staged.entries, skipped: staged.skipped, bytes: staged.bytes }
}

function errorTextOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface DiagSummary {
  made_at: string
  plugin_version: string
  /** 各组件版本 / 装着的那一份。取不到的写「取不到」,**不猜**。 */
  components: Record<string, string>
  machine: Record<string, string>
  /** 导出这份包的那个插件进程:rss / heap / 堆上限 / 起了多久 / 事件循环 p99。没接采样器或取不到就缺席。 */
  process?: ProcessHealthView
  rules: { days: number, per_log_mb: number, total_mb: number }
}

async function summaryOf(deps: DiagPackDeps, at: number): Promise<DiagSummary> {
  const io = deps.io
  const paths = deps.paths
  const components: Record<string, string> = { [`${DIAG_COMPONENT_TITLES.plugin}(插件)`]: deps.pluginVersion }

  const jsonVersion = async (file: string): Promise<string> => {
    const text = await io.readFile(file)
    if (text === undefined) return '取不到(文件不在)'
    try {
      const value = JSON.parse(text) as { version?: unknown }
      return typeof value.version === 'string' ? value.version : '取不到(没有 version 这一格)'
    }
    catch { return '取不到(不是合法 JSON)' }
  }
  components['DSH 运行时'] = await jsonVersion(paths.runtimeDshPackageJson)
  components['profile 里装着的插件'] = await jsonVersion(paths.profilePluginPackageJson)

  const node = await io.exec([paths.nodeBin, '-p', 'process.versions.node'], { timeoutMs: 10_000 })
  components['自有 node'] = node.ok ? node.out.trim() : '取不到(没装或跑不起来)'

  const shell = await io.stat(paths.shellAppBinary)
  components['壳 App'] = shell === undefined
    ? '没装'
    : `装着(${new Date(shell.mtimeMs).toISOString()})`
  components['语音后端 butler-server'] = (await io.stat(paths.butlerServerEntry)) === undefined ? '没装' : '装着'
  components['通话工人 channel-worker'] = (await io.stat(paths.channelWorkerEntry)) === undefined ? '没装' : '装着'

  // 热更新那份记录:每样产物装的是哪一份(sha 前 12 位够对账,全写太长)。
  const installed = await io.readFile(paths.installedJson)
  if (installed !== undefined) {
    try {
      const parsed = JSON.parse(installed) as { version?: unknown, assets?: Record<string, { sha256?: unknown, version?: unknown }> }
      if (typeof parsed.version === 'string') components['上一次更新装到的版本'] = parsed.version
      for (const [kind, record] of Object.entries(parsed.assets ?? {})) {
        const sha = typeof record?.sha256 === 'string' ? record.sha256.slice(0, 12) : '?'
        const version = typeof record?.version === 'string' ? record.version : '?'
        components[`产物 ${kind}`] = `${version} / ${sha}`
      }
    }
    catch { components['上一次更新装到的版本'] = '取不到(installed.json 不是合法 JSON)' }
  }

  const machine: Record<string, string> = {}
  const sw = await io.exec(['sw_vers'], { timeoutMs: 10_000 })
  machine.macOS = sw.ok ? sw.out.trim().split('\n').join(' / ') : '取不到'
  const arch = await io.exec(['uname', '-m'], { timeoutMs: 10_000 })
  machine['芯片'] = arch.ok ? arch.out.trim() : '取不到'
  const uptime = await io.exec(['uptime'], { timeoutMs: 10_000 })
  machine['开机多久'] = uptime.ok ? redactText(uptime.out.trim()) : '取不到'
  const disk = await io.exec(['df', '-h', paths.home], { timeoutMs: 10_000 })
  machine['家目录所在盘'] = disk.ok ? redactText(disk.out.trim().split('\n').slice(-1)[0] ?? '') : '取不到'

  let processView: ProcessHealthView | undefined
  try { processView = deps.process?.() }
  catch { processView = undefined }

  return {
    made_at: new Date(at).toISOString(),
    plugin_version: deps.pluginVersion,
    components,
    machine,
    ...(processView === undefined ? {} : { process: processView }),
    rules: {
      days: deps.days ?? DIAG_DAYS,
      per_log_mb: Math.round((deps.perLogBytes ?? PER_LOG_BYTES) / 1024 / 1024),
      total_mb: Math.round((deps.totalBytes ?? TOTAL_BYTES) / 1024 / 1024),
    },
  }
}

interface CollectedLog extends DiagLogSource {
  text: string
  truncated: boolean
  mtimeMs: number
}

/**
 * 把每份日志(含轮转出来的兄弟)读进来、脱敏、按时间新到旧排。
 *
 * 「最近 7 天」按**文件的修改时间**筛,不按每行的时间戳解析:各组件的日志行格式
 * 各写各的(`[channel-worker] …`、`dsh web: …`、NSLog 的),解析它们等于维护五套格式,
 * 而每多一套就多一次"解析错了于是整份日志被扔掉"的机会。
 */
export async function collectLogs(
  io: DiagIo,
  paths: SetupPaths,
  options: { at: number, days: number, perLog: number },
): Promise<{ found: readonly CollectedLog[], skipped: readonly DiagPackSkipped[] }> {
  const cutoff = options.at - options.days * 86_400_000
  const found: CollectedLog[] = []
  const skipped: DiagPackSkipped[] = []

  for (const source of logSourcesOf(paths)) {
    const dir = source.path.slice(0, source.path.lastIndexOf('/'))
    const base = source.name
    const listing = await io.readdir(dir)
    const siblings = listing.ok
      ? listing.names.filter(name => name === base || name.startsWith(`${base}.`))
      : []
    if (siblings.length === 0) {
      skipped.push({ what: `日志/${base}`, why: listing.ok ? '这台机器上还没有这份日志' : `读不到目录:${listing.code}` })
      continue
    }
    for (const name of siblings) {
      const path = `${dir}/${name}`
      const tail = await io.readTail(path, options.perLog)
      if (tail === undefined) { skipped.push({ what: `日志/${name}`, why: '读不到(没权限?)' }); continue }
      if (tail.mtimeMs < cutoff) { skipped.push({ what: `日志/${name}`, why: `比 ${options.days} 天还老` }); continue }
      if (tail.size === 0) { skipped.push({ what: `日志/${name}`, why: '空文件' }); continue }
      const body = dropFirstPartialLine(tail.text, tail.truncated)
      found.push({
        path,
        name,
        owner: source.owner,
        text: `${redactLines(body.split('\n')).join('\n')}\n`,
        truncated: tail.truncated,
        mtimeMs: tail.mtimeMs,
      })
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { found, skipped }
}

/**
 * 壳那一段。**这里有一件真事要写清楚**:
 *
 * 卡上写的是「只取 error/fault」。可壳里一行 `os_log` 都没有,12 处全是 `NSLog`
 * (workbench-app/Sources/WindowControl.swift),而 **NSLog 落在 default 级别** ——
 * 按 error/fault 筛,我们自己打的那些字一行都不会出现。
 *
 * 所以这里跑**两条**:
 *   ① error / fault:系统替这个进程记的那些(崩溃、TCC 拒绝、连不上);
 *   ② 全级别的尾巴:我们自己 NSLog 的那些面包屑,封顶 `SHELL_LOG_LINES` 行。
 * 两段各带一行小标题,看包的人一眼知道哪段是哪段。
 */
async function shellLogOf(io: DiagIo, days: number): Promise<{ ok: true, text: string, note: string } | { ok: false, why: string }> {
  const base = ['log', 'show', '--style', 'syslog']
  const errorsOnly = await io.exec(
    [...base, '--last', `${days}d`, '--predicate', 'process == "workbench" AND (messageType == error OR messageType == fault)'],
    { timeoutMs: SHELL_LOG_TIMEOUT_MS },
  )
  /*
   * ★ **按时间窗取,不是按行数取**(2026-10-02)。从前这一段也是 `--last 7d`、再留最后 2000 行:
   * 10-02 真机上那 2000 行只覆盖了 50 分钟,要查的那一段早被挤掉。现在先把窗收到 24 小时
   * (`--last 24h` 由系统替我们筛,比我们解析每行的时间稳当得多),行数封顶留到两万当保险。
   */
  const all = await io.exec(
    [...base, '--last', `${SHELL_LOG_WINDOW_HOURS}h`, '--predicate', 'process == "workbench"'],
    { timeoutMs: SHELL_LOG_TIMEOUT_MS },
  )
  if (!errorsOnly.ok && !all.ok) {
    return { ok: false, why: `log show 跑不起来(退出码 ${all.code})。这台机器上多半还没装壳。` }
  }
  const tail = (text: string): string => redactLines(text.split('\n').filter(line => line !== '').slice(-SHELL_LOG_LINES)).join('\n')
  /** 这一段到底留了多少、丢了多少。**丢了就说**(同整包那条纪律)。 */
  const kept = (text: string): string => {
    const total = text.split('\n').filter(line => line !== '').length
    return total > SHELL_LOG_LINES
      ? `这 ${SHELL_LOG_WINDOW_HOURS} 小时里一共 ${total} 行,只留了最后 ${SHELL_LOG_LINES} 行(前面 ${total - SHELL_LOG_LINES} 行没进包)`
      : `这 ${SHELL_LOG_WINDOW_HOURS} 小时里一共 ${total} 行,一行都没落下`
  }
  const text = [
    '# 壳(可执行文件名 workbench)的统一日志',
    '',
    `## 一、error / fault(最近 ${days} 天)`,
    '(系统替这个进程记的:崩溃、授权被拒、连不上。壳自己的 NSLog 不在这一段里 —— NSLog 落在 default 级别。)',
    '',
    errorsOnly.ok ? tail(errorsOnly.out) : `取不到(退出码 ${errorsOnly.code})`,
    '',
    `## 二、全级别(最近 ${SHELL_LOG_WINDOW_HOURS} 小时)`,
    '(壳自己 NSLog 的那些面包屑在这一段里 —— 含 2026-10-02 起**每一次打开 / 激活 / 叫到台前一个 App**'
    + `那一行,行首是「${APP_OPEN_TAG}」。)`,
    '',
    all.ok ? kept(all.out) : '',
    '',
    all.ok ? tail(all.out) : `取不到(退出码 ${all.code})`,
    '',
  ].join('\n')
  return {
    ok: true,
    text,
    note: `error/fault 取 ${days} 天;壳自己那些面包屑按时间窗取最近 ${SHELL_LOG_WINDOW_HOURS} 小时`,
  }
}

/** 包里那份《包内清单》。**它是这份包的说明书,也是脱敏规则的公开承诺**。 */
export function renderManifest(input: {
  stage: DiagStageAccum
  summary: DiagSummary
  at: number
  days: number
  perLog: number
  total: number
}): string {
  const { stage, summary, days } = input
  const lines: string[] = []
  lines.push('# 工作台诊断包 · 包内清单')
  lines.push('')
  lines.push(`生成时间:${summary.made_at}`)
  lines.push(`工作台版本:${summary.plugin_version}`)
  lines.push(`收集范围:最近 ${days} 天`)
  lines.push('')
  lines.push('## 一、这份包里**没有**什么')
  lines.push('')
  lines.push('下面这些文件**一个字节都不会进包**,不论它们在不在这台机器上:')
  lines.push('')
  for (const name of EXCLUDED_NAMES) lines.push(`- \`${name}\``)
  for (const prefix of EXCLUDED_DIR_PREFIXES) lines.push(`- \`${prefix}*/\`(浏览器登录档案:cookie 与本地存储都在里头)`)
  lines.push('')
  lines.push('做法是**白名单**:进包的每一样东西都在代码里逐个写着名字')
  lines.push('(`workbench-plugin/src/server/diagnostics/pack.ts`),没写的一律不收。')
  lines.push('出包前还会再复查一遍文件名,命中上面这张表的当场剔掉。')
  lines.push('')
  lines.push('## 二、脱敏规则')
  lines.push('')
  lines.push('进包的**每一个字符串**都过一遍下面这几条(`diagnostics/redact.ts`):')
  lines.push('')
  lines.push('| 擦掉的东西 | 换成 |')
  lines.push('|---|---|')
  lines.push(`| \`Authorization: Bearer …\` | \`Bearer ${REDACTED}\` |`)
  lines.push(`| \`?token=…\`、\`api_key=…\`、\`secret=…\`、\`password=…\`、\`cookie=…\` | \`${REDACTED}\` |`)
  lines.push(`| 设备令牌 \`wb_…\` | \`wb_${REDACTED}\` |`)
  lines.push(`| \`sk-…\` 形状的模型 Key | \`sk-${REDACTED}\` |`)
  lines.push(`| JWT(\`eyJ….….…\`,LiveKit 进房凭证就是这个形状) | \`eyJ${REDACTED}\` |`)
  lines.push('| 家目录里的用户名 `/Users/你的名字/` | `/Users/<用户>/` |')
  lines.push(`| JSON 里键名是 token / secret / key / password / cookie / credential… 的那一格 | \`${REDACTED}\` |`)
  lines.push('')
  lines.push('**路径本身留着**:排障多半要看"它在找哪个文件",整条抹掉等于把病历撕了。')
  lines.push('换掉的只有 `/Users/` 后面那一段名字。')
  lines.push('')
  lines.push('## 三、包里有什么')
  lines.push('')
  lines.push('| 包内路径 | 大小 | 来自 | 说明 |')
  lines.push('|---|---:|---|---|')
  for (const entry of stage.entries) {
    const size = entry.bytes >= 1024 * 1024
      ? `${(entry.bytes / 1024 / 1024).toFixed(1)}MB`
      : `${Math.max(1, Math.round(entry.bytes / 1024))}KB`
    lines.push(`| \`${entry.path}\` | ${size} | ${entry.from ?? '现生成'} | ${entry.note ?? ''}${entry.truncated === true ? '(**前面截断过**)' : ''} |`)
  }
  lines.push('')
  lines.push('## 四、没收进来的,以及为什么')
  lines.push('')
  if (stage.skipped.length === 0) lines.push('(这一次一样都没落下。)')
  else {
    lines.push('| 没收 | 为什么 |')
    lines.push('|---|---|')
    for (const item of stage.skipped) lines.push(`| \`${item.what}\` | ${item.why} |`)
  }
  lines.push('')
  lines.push('## 五、体积与截断规则')
  lines.push('')
  lines.push(`- 单份日志只取**尾部 ${Math.round(input.perLog / 1024 / 1024)}MB**;截断过的在上表里标着。`)
  lines.push(`- 整包未压缩封顶 **${Math.round(input.total / 1024 / 1024)}MB**;超了从**最老的轮转日志**开始丢,丢掉的都写在第四节。`)
  lines.push(`- 壳的统一日志:error / fault 取最近 ${days} 天;壳自己 NSLog 的那些面包屑`)
  lines.push(`  **按时间窗取最近 ${SHELL_LOG_WINDOW_HOURS} 小时**(封顶 ${SHELL_LOG_LINES} 行,真截了会在那一段开头说清一共多少行)。`)
  lines.push('')
  lines.push('## 六、这份包能给谁')
  lines.push('')
  lines.push('给做这个工作台的人。它里头没有你的密码、没有你的密钥、没有你跟事务官说过的话,')
  lines.push('但它有你的文件路径(名字已换成 `<用户>`)、项目名、应用名与日志。')
  lines.push('觉得哪一条不该发出去,直接从 zip 里删掉那个文件再发 —— 少一样只是少一条线索。')
  lines.push('')
  return `${lines.join('\n')}\n`
}
