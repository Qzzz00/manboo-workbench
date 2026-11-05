/**
 * 自定义模块容器(2026-09-21)。
 *
 * 一个自定义模块就是 `~/.dsh/workbench/modules/<id>/` 下的一份 `module.json` 加一堆静态文件。
 * 这个文件管四件事:**列出来**、**读出来**(带路径穿越防护的静态服务)、**移进回收站**、
 * **从回收站拿回来**。
 *
 * ## 三条边界
 *
 * 1. **没有写接口。** 模块的文件是 DSH 用它自己的手(文件系统)写进去的 —— 它本来就是个
 *    会写文件的 Agent。工作台这边再开一个"帮你写文件"的路由,等于把一条新的写入路径挂在
 *    浏览器能打到的端口上,而那条路径没有任何人需要。**能少一条口子就少一条。**
 * 2. **不删。** `remove` 是 `rename` 进 `.trash/`,不是 `rm`(2026-09-04 那条事故纪律)。
 *    回收站里的东西这个文件一个字都不会去清理 —— 满了由 Ben 自己在 Finder 里处理。
 * 3. **不认识凭据、不执行任何东西。** 读文件只读、按扩展名给 content-type,一律不执行。
 *
 * ## 路径穿越
 *
 * `/modules/<id>/<rel>` 这条路由是**唯一**把 URL 里的字符串拼进文件路径的地方,所以防护
 * 写在这里、只写一遍:id 必须过白名单正则;rel 逐段检查(空段、`.`、`..`、以 `.` 开头、
 * 反斜杠、NUL 一律否);拼完之后再用 `realpath` 量一次 —— **软链接指到目录外面的那一档,
 * 只有 realpath 抓得住**(前两道都只看字符串)。
 */
import { readFile, mkdir, readdir, realpath, rename, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { CustomModuleView } from '../protocol.ts'

export function defaultModulesDir(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/modules`
}

/** 回收站在模块目录**里面**:一个目录搬一次家就完事,不跨设备、不跨卷。 */
export const TRASH_DIR_NAME = '.trash'

/** 入口文件名。字段留在 module.json 里是为了以后能换,不是为了现在能换。 */
export const MODULE_ENTRY = 'index.html'

/**
 * 模块 id 的白名单。小写字母数字与连字符,首字符不能是连字符,最长 40。
 *
 * **白名单不是黑名单**:不去列"不许出现 `..`",而是列"只许出现这些字符" ——
 * 少一次"还有什么没想到"的机会。`.` 不在表里,所以 `..`、`.trash`、隐藏目录全进不来。
 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

export function isModuleId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

/** 落盘的那一份 `module.json`。`version` 现在只有 1;以后加字段一律 additive。 */
export interface ModuleManifest {
  version?: 1
  id?: string
  name?: string
  icon?: string
  created_at?: string
  source?: string
  entry?: string
}

/**
 * 能端出去的文件类型表。**白名单**,同 id 那条理由。
 *
 * 表里没有的扩展名一律不给(`kind: 'type'`),不是退回 `application/octet-stream` ——
 * 那等于"什么都给,只是浏览器不认",而一个小工具用不到表外的东西。
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
}

export function contentTypeOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  return CONTENT_TYPES[path.slice(dot + 1).toLowerCase()]
}

/**
 * 模块网页的 CSP 搬走了(2026-09-22,C7「自定义模块真边界」)。
 *
 * 它现在按**来源**现算,在 `server/moduleOrigin.ts` 的 `moduleCsp()` 里 —— 原因是
 * 那块 iframe 加了 `sandbox`,文档成了**不透明来源**,而不透明来源里的 `'self'`
 * 谁都不匹配:连模块自己的 `assets/app.css` 都会被拦掉。所以两个 origin 要写实名。
 */

export interface ModuleFileHit {
  /** 绝对路径,已经过 realpath 校验。 */
  path: string
  contentType: string
  size: number
}

export type ModuleFileMiss =
  | { kind: 'id' }       // id 不合法
  | { kind: 'path' }     // 路径里有不许出现的东西(穿越、隐藏文件、反斜杠…)
  | { kind: 'type' }     // 扩展名不在白名单里
  | { kind: 'missing' }  // 这个模块/这个文件不存在

export interface CustomModulesService {
  /** 还活着的那些,按 created_at 升序(先做的在左边 —— 标签是往右长的)。 */
  list: () => Promise<readonly CustomModuleView[]>
  /** 回收站里的那些,按移进去的先后倒序(刚删的在最上面)。 */
  trash: () => Promise<readonly CustomModuleView[]>
  /** 静态文件。`rel` 是 `/modules/<id>/` 之后那一段,空串等于入口文件。 */
  file: (id: string, rel: string) => Promise<ModuleFileHit | ModuleFileMiss>
  remove: (id: string) => Promise<{ ok: boolean, error?: string }>
  restore: (id: string) => Promise<{ ok: boolean, error?: string }>
  /** 这个 id 此刻存不存在(建模块前查重用)。 */
  exists: (id: string) => Promise<boolean>
}

export interface CustomModulesServiceOptions {
  dir: string
  now?: () => number
}

/** 目录名 + module.json → 一条能端给客户端的记录。读不出来 / 字段坏了就回 undefined,不编。 */
export function moduleViewOf(id: string, raw: unknown): CustomModuleView | undefined {
  if (!isModuleId(id)) return undefined
  const manifest = (raw ?? {}) as ModuleManifest
  const name = typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : undefined
  // 名字是标签上那几个字。没有名字的模块在标签栏上是一格空白 —— 与其画一格空白,
  // 不如**退回用 id 当名字**:id 至少是真的,而且是用户自己那条目录的名字。
  const icon = typeof manifest.icon === 'string' && manifest.icon.trim() !== '' ? manifest.icon.trim() : undefined
  const createdAt = typeof manifest.created_at === 'string' ? manifest.created_at : ''
  const source = manifest.source === 'user' ? 'user' : 'dsh'
  const entry = typeof manifest.entry === 'string' && manifest.entry !== '' ? manifest.entry : MODULE_ENTRY
  return {
    id,
    name: name ?? id,
    ...(icon === undefined ? {} : { icon }),
    created_at: createdAt,
    source,
    entry,
  }
}

/**
 * URL 里那一段相对路径 → 安全的相对路径。不安全就回 undefined。
 *
 * 纯函数、不碰 I/O:路径穿越这件事该在能单独测的地方判完,而不是混在一堆 await 里。
 * realpath 那一道(软链接)在 `file()` 里,字符串这一道在这里。
 */
export function safeRelPath(rel: string): string | undefined {
  let decoded: string
  try { decoded = decodeURIComponent(rel) }
  catch { return undefined }
  if (decoded === '' || decoded === '/') return MODULE_ENTRY
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined
  const parts = decoded.split('/').filter((part, index, all) => !(part === '' && index === all.length - 1))
  const out: string[] = []
  for (const part of parts) {
    if (part === '') return undefined            // `a//b`:含糊,直接否
    if (part === '.' || part === '..') return undefined
    if (part.startsWith('.')) return undefined   // 隐藏文件与 .trash 一并挡在外面
    out.push(part)
  }
  if (out.length === 0) return MODULE_ENTRY
  return out.join('/')
}

/**
 * 回收站里重名时补在后面的那串时间戳。**只有数字与连字符**,必须过得了 `ID_RE` ——
 * 过不了就等于那一份在界面上消失(见 remove 里的注释)。
 */
export function trashStamp(ms: number): string {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

export function createCustomModulesService(options: CustomModulesServiceOptions): CustomModulesService {
  const root = options.dir
  const trashRoot = join(root, TRASH_DIR_NAME)
  const now = options.now ?? Date.now

  const manifestOf = async (dir: string, id: string): Promise<CustomModuleView | undefined> => {
    let raw: unknown
    try { raw = JSON.parse(await readFile(join(dir, id, 'module.json'), 'utf8')) }
    catch { return undefined }
    return moduleViewOf(id, raw)
  }

  const listIn = async (dir: string): Promise<CustomModuleView[]> => {
    let entries: string[]
    try { entries = await readdir(dir) }
    catch { return [] }  // 目录还没建 = 一个自定义模块都没有,不是错
    const out: CustomModuleView[] = []
    for (const entry of entries) {
      // `.trash` 天然过不了 ID_RE(首字符是点),不用另写一条判断。
      if (!isModuleId(entry)) continue
      const view = await manifestOf(dir, entry)
      if (view !== undefined) out.push(view)
    }
    return out
  }

  return {
    async list() {
      const all = await listIn(root)
      return all.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    },

    async trash() {
      const all = await listIn(trashRoot)
      return all.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
    },

    async exists(id) {
      if (!isModuleId(id)) return false
      try { return (await stat(join(root, id))).isDirectory() }
      catch { return false }
    },

    async file(id, rel) {
      if (!isModuleId(id)) return { kind: 'id' }
      const safe = safeRelPath(rel)
      if (safe === undefined) return { kind: 'path' }
      const contentType = contentTypeOf(safe)
      if (contentType === undefined) return { kind: 'type' }
      const moduleDir = join(root, id)
      const target = resolve(moduleDir, safe)
      // 第一道之后再量一次:字符串层面干净不代表落到盘上干净 —— 模块目录里放一条指向
      // `~/.ssh` 的软链接,上面三道一道都拦不住,只有 realpath 抓得住。
      let realTarget: string
      let realDir: string
      try {
        realTarget = await realpath(target)
        realDir = await realpath(moduleDir)
      }
      catch { return { kind: 'missing' } }
      if (realTarget !== realDir && !realTarget.startsWith(realDir + sep)) return { kind: 'path' }
      let info: Awaited<ReturnType<typeof stat>>
      try { info = await stat(realTarget) }
      catch { return { kind: 'missing' } }
      if (!info.isFile()) return { kind: 'missing' }
      return { path: realTarget, contentType, size: info.size }
    },

    async remove(id) {
      if (!isModuleId(id)) return { ok: false, error: '认不出这个模块' }
      const from = join(root, id)
      try { if (!(await stat(from)).isDirectory()) return { ok: false, error: '认不出这个模块' } }
      catch { return { ok: false, error: '没有这个模块' } }
      await mkdir(trashRoot, { recursive: true })
      // 回收站里已经有同名的:**不覆盖**(覆盖就是删掉了前一次那份)。带上时间戳另存一份。
      //
      // 时间戳只用数字(`20260921-100000`),**不是 ISO 原样**:ISO 里的 `T`/`Z` 是大写,
      // 过不了 ID_RE,于是那一份在回收站里列不出来、也恢复不回去 —— 一份"还在盘上但
      // 界面上不存在"的东西,比直接说删不掉更糟。用例钉着这一条。
      let to = join(trashRoot, id)
      try {
        await stat(to)
        to = join(trashRoot, `${id}-${trashStamp(now())}`)
      }
      catch { /* 不存在,正是常态 */ }
      try { await rename(from, to) }
      catch (error) { return { ok: false, error: `移进回收站失败:${String(error)}` } }
      return { ok: true }
    },

    async restore(id) {
      if (!isModuleId(id)) return { ok: false, error: '认不出这个模块' }
      const from = join(trashRoot, id)
      try { if (!(await stat(from)).isDirectory()) return { ok: false, error: '回收站里没有这个模块' } }
      catch { return { ok: false, error: '回收站里没有这个模块' } }
      const to = join(root, id)
      // 同名的还在用着:**不覆盖、不改名**,如实说一句让人自己处置 —— 恢复一件东西
      // 不该顺手把另一件正在用的盖掉。
      try {
        await stat(to)
        return { ok: false, error: `已经有一个叫 ${id} 的模块在用了,先把它移走再恢复` }
      }
      catch { /* 不存在,正是常态 */ }
      try { await rename(from, to) }
      catch (error) { return { ok: false, error: `恢复失败:${String(error)}` } }
      return { ok: true }
    },
  }
}
