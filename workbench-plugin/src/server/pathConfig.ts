/**
 * 路径可配的纯函数层(2026-09-17 卡 C,设计-电脑端登录台梳理 §四 + Ben §八④拍板)。
 *
 * ## 为什么单独一个文件
 *
 * 三处硬编码(扫描根 / 收件箱目录 / 事务官仓库)散落在 projectsService.ts、inbox.ts、index.ts,
 * 各有各的默认值。真要做成「登录台上能改」的东西,得有一个地方说清楚:默认是什么、
 * 现在生效的是什么、一条候选值合不合法、改完要不要重启。这里就是那个地方,
 * **一行 I/O 都没有**——读盘归 appConfig.ts,校验「目录真的在不在」归 HTTP 层(要 fs)。
 *
 * ## 命名前缀
 *
 * 导出一律 `wbPaths*` / `WB_PATHS_*`:同期还有一张卡在做登录台的服务端,
 * 前缀是为了两边的符号在同一个 src/server 下不会撞名。
 *
 * ## 默认值一个字都没改
 *
 * 三个扫描根与两个收件箱目录逐字照搬改造前写死的值(DEFAULT_SCAN_ROOTS、defaultInboxDirs),
 * 没配过的机器行为与改造前完全一样。事务官仓库**没有默认值**:猜错会把记忆写进别的仓库。
 */
import type { AppConfig, AppConfigScanRoot } from './appConfig.ts'
import { APP_CONFIG_DEPTH_MAX, APP_CONFIG_DEPTH_MIN } from './appConfig.ts'

/** 改了事务官仓库之后要说的那句话。HTTP 层与设置弹窗都用它,两处不各写一遍。 */
export const WB_PATHS_RESTART_REQUIRED_HINT
  = '事务官仓库改好了,但引导 / 授权 / 例程三块是在工作台启动时按这个路径接线的,'
    + '要 `launchctl kickstart -k gui/$(id -u)/ai.deepseek.dsh` 重启一次才会切过去。'

export interface WbPathsDefaults {
  scan_roots: AppConfigScanRoot[]
  inbox_dirs: string[]
  /** 事务官仓库没有默认值——不猜路径。 */
  butler_cwd?: undefined
}

/** 默认值(= 改造前写死的那几个)。 */
export function wbPathsDefaults(home: string): WbPathsDefaults {
  return {
    scan_roots: [
      { path: `${home}/Documents/GitHub`, depth: 1 },
      { path: `${home}/Documents/Codex`, depth: 2 },
      { path: `${home}/WeChatProjects`, depth: 1 },
    ],
    inbox_dirs: [`${home}/Downloads`, `${home}/Desktop`],
  }
}

/** 事务官仓库这一条到底从哪来的:环境变量 / app.json / 两处都没有。 */
export type WbPathsButlerSource = 'env' | 'app.json' | 'none'

export interface WbPathsEffective {
  scan_roots: readonly AppConfigScanRoot[]
  inbox_dirs: readonly string[]
  butler_cwd?: string
  butler_cwd_source: WbPathsButlerSource
}

export interface WbPathsContext {
  home: string
  /** `process.env.WORKBENCH_BUTLER_CWD`。空串按没配算(dsh-start 里留了个空值是常见事故)。 */
  envButlerCwd?: string | undefined
}

/**
 * 此刻真正生效的是什么。
 *
 * 优先级:环境变量 > app.json > 默认。前两项只对 butler_cwd 有区别——
 * 扫描根与收件箱目录没有环境变量入口,故意的:多一条入口就多一处"为什么没生效"的排查。
 */
export function wbPathsEffective(config: AppConfig, ctx: WbPathsContext): WbPathsEffective {
  const defaults = wbPathsDefaults(ctx.home)
  const env = ctx.envButlerCwd === undefined || ctx.envButlerCwd === '' ? undefined : ctx.envButlerCwd
  const fromFile = config.butler_cwd === undefined || config.butler_cwd === '' ? undefined : config.butler_cwd
  const butler = env ?? fromFile
  const source: WbPathsButlerSource = env !== undefined ? 'env' : (fromFile !== undefined ? 'app.json' : 'none')
  return {
    scan_roots: config.scan_roots ?? defaults.scan_roots,
    inbox_dirs: config.inbox_dirs ?? defaults.inbox_dirs,
    ...(butler === undefined ? {} : { butler_cwd: butler }),
    butler_cwd_source: source,
  }
}

/** 一条要落盘的补丁。butler_cwd 的空串保留原样,含义是「清掉」(见 appConfig.set)。 */
export interface WbPathsPatch {
  scan_roots?: AppConfigScanRoot[]
  inbox_dirs?: string[]
  butler_cwd?: string
}

export type WbPathsParsed =
  | { ok: true, patch: WbPathsPatch }
  | { ok: false, error: string }

/**
 * `~` 展开 + 去掉末尾多余的斜杠。
 *
 * 为什么要做 `~`:Ben 在输入框里手打路径,`~/Documents/GitHub` 是他会写的形式,
 * 而 Node 这一侧没有 shell 帮忙展开——不展开就是一个名叫 `~` 的相对目录,必然校验失败,
 * 而失败信息("要写绝对路径")对着一条看起来明明是绝对路径的输入会很莫名其妙。
 */
export function wbPathsNormalize(raw: string, home: string): string {
  let path = raw.trim()
  if (path === '~') path = home
  else if (path.startsWith('~/')) path = `${home}/${path.slice(2)}`
  // 末尾斜杠去掉(根目录 '/' 除外),不然同一个目录会以两种写法各存一份。
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

/**
 * 校验 PUT /config/paths 的 body。**只管形状与写法**,"这个目录真的在不在"要读盘,
 * 由 HTTP 层带着注入的 isDir 再走一遍(测试才能不碰真实文件系统)。
 *
 * 所有错误都是给人看的一句中文,指名道姓说第几条——"参数非法"这种话对 Ben 没有用。
 */
export function wbPathsParsePatch(body: unknown, home: string): WbPathsParsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body 要是一个对象' }
  }
  const raw = body as Record<string, unknown>
  const patch: WbPathsPatch = {}

  if (raw.scan_roots !== undefined) {
    if (!Array.isArray(raw.scan_roots)) return { ok: false, error: 'scan_roots 要是一个数组' }
    const roots: AppConfigScanRoot[] = []
    const seen = new Set<string>()
    for (let i = 0; i < raw.scan_roots.length; i++) {
      const entry = raw.scan_roots[i] as unknown
      const no = i + 1
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return { ok: false, error: `第 ${no} 个扫描根要是 { path, depth } 这样一个对象` }
      }
      const { path, depth } = entry as { path?: unknown, depth?: unknown }
      if (typeof path !== 'string' || path.trim() === '') return { ok: false, error: `第 ${no} 个扫描根的路径是空的` }
      if (typeof depth !== 'number' || !Number.isInteger(depth)
        || depth < APP_CONFIG_DEPTH_MIN || depth > APP_CONFIG_DEPTH_MAX) {
        return { ok: false, error: `第 ${no} 个扫描根的层数要在 ${APP_CONFIG_DEPTH_MIN}~${APP_CONFIG_DEPTH_MAX} 之间` }
      }
      const normalized = wbPathsNormalize(path, home)
      if (!normalized.startsWith('/')) return { ok: false, error: `第 ${no} 个扫描根要写绝对路径(以 / 开头)` }
      // 重了就说出来,不默默去重:两条同路径不同 depth,替他留哪一条都是替他做决定。
      if (seen.has(normalized)) return { ok: false, error: `扫描根 ${normalized} 写了两遍` }
      seen.add(normalized)
      roots.push({ path: normalized, depth })
    }
    patch.scan_roots = roots
  }

  if (raw.inbox_dirs !== undefined) {
    if (!Array.isArray(raw.inbox_dirs)) return { ok: false, error: 'inbox_dirs 要是一个数组' }
    const dirs: string[] = []
    const seen = new Set<string>()
    for (let i = 0; i < raw.inbox_dirs.length; i++) {
      const entry = raw.inbox_dirs[i] as unknown
      const no = i + 1
      if (typeof entry !== 'string' || entry.trim() === '') return { ok: false, error: `第 ${no} 个收件箱目录是空的` }
      const normalized = wbPathsNormalize(entry, home)
      if (!normalized.startsWith('/')) return { ok: false, error: `第 ${no} 个收件箱目录要写绝对路径(以 / 开头)` }
      if (seen.has(normalized)) return { ok: false, error: `收件箱目录 ${normalized} 写了两遍` }
      seen.add(normalized)
      dirs.push(normalized)
    }
    patch.inbox_dirs = dirs
  }

  if (raw.butler_cwd !== undefined) {
    if (typeof raw.butler_cwd !== 'string') return { ok: false, error: 'butler_cwd 要是一个字符串(留空表示清掉)' }
    const trimmed = raw.butler_cwd.trim()
    if (trimmed === '') {
      // 空串 = 清掉这一项,退回环境变量或"没配"。这是合法的一次修改,不是错误。
      patch.butler_cwd = ''
    }
    else {
      const normalized = wbPathsNormalize(trimmed, home)
      if (!normalized.startsWith('/')) return { ok: false, error: '事务官仓库要写绝对路径(以 / 开头)' }
      patch.butler_cwd = normalized
    }
  }

  if (patch.scan_roots === undefined && patch.inbox_dirs === undefined && patch.butler_cwd === undefined) {
    return { ok: false, error: '没有要改的东西:scan_roots / inbox_dirs / butler_cwd 至少给一个' }
  }
  return { ok: true, patch }
}

/** 这条补丁里要校验"真的存在且是目录"的所有路径(按它们在人话里的称呼配对)。 */
export function wbPathsDirsToCheck(patch: WbPathsPatch): { path: string, label: string }[] {
  const out: { path: string, label: string }[] = []
  for (const root of patch.scan_roots ?? []) out.push({ path: root.path, label: '扫描根' })
  for (const dir of patch.inbox_dirs ?? []) out.push({ path: dir, label: '收件箱目录' })
  if (patch.butler_cwd !== undefined && patch.butler_cwd !== '') {
    out.push({ path: patch.butler_cwd, label: '事务官仓库' })
  }
  return out
}

/** 改了这条补丁之后,要不要重启才能全部生效。 */
export function wbPathsRestartRequired(patch: WbPathsPatch): boolean {
  // 扫描根与收件箱目录都能热生效(前者下一次扫描就用新值,后者当场重挂监视);
  // 事务官仓库不行——引导 / 授权 / 例程是启动时按它接线的,见 index.ts。
  return patch.butler_cwd !== undefined
}
