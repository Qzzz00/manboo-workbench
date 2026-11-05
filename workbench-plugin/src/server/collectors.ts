/**
 * 采集器 —— 用户层里「看一页数据」那一样(2026-09-23,`docs/设计-用户自己的那一层-2026-09-23.md` 第一、三节)。
 *
 * Ben 的定调:工作台分两层,本体只有一个;用户层(布局 / 小组件 / 采集器 / 技能 / 偏好)全在她机器上,
 * 由她的事务官动手写,但每样东西有硬边界、要验证、能撤。这个文件是**采集器**那一样:
 *
 *   一份定义(`~/.dsh/workbench/用户层/采集器/<名>.json`:哪一页、用哪个登录档案;2026-10-26 切割收尾
 *     前在工作目录,老位置一次性迁入、不再读)
 *     → 工作台用**她登着的那个浏览器档案**打开那一页、把看得见的字读回来
 *     → 落 `<工作目录>/数据/<名>/最新.txt`(+ 当天一份),`采集记录.jsonl` 追加一行
 *     → 小组件经 `GET /module/data?name=<名>` 读它,把字变成数画出来(解析是用户层里的代码,不在这里)
 *
 * ## 比创作者后台那条路(xhsCreator.ts)更紧的四条
 *
 * 1. **不点、不填、不提交。** 只有 `Page.navigate` + 读 `innerText`。创作者后台那一下「近30日」是专门拍过板的例外
 *    (决策记录 2026-09-22),通用采集器**不给**这个例外:`readPage` 不传 `switchTo`。
 * 2. **不解析。** 采回来的是页面上本来就有的字,一字不改。把字变成数是小组件的事(用户层里的代码,
 *    写错了看得见、能撤、页面改版了它自己会喊读不懂)。本体不解析没见过的页面。
 * 3. **闸在代码里**:同一采集器两次至少 {@link MIN_GAP_MS};一天最多 {@link DAILY_MAX} 次;一次只跑一个;
 *    未登录 / 验证码 / 风控页 → 停、当天例程不再试。判据复用 `xhsNoteText.wallOf`。
 * 4. **凭据一个字不碰**:定义里没有凭据字段;登录态只在 Chrome 档案目录里;连不上那个窗口**不偷偷开**。
 *
 * ## 落盘:定义进用户层,数据还在工作目录(2026-10-26 切割收尾)
 *
 * 采集器定义是「她订过的东西」,切割后进 `~/.dsh/workbench/用户层/采集器/<名>.json`(老位置
 * `<工作目录>/采集器/` 在升级后第一次启动一次性拷进:只拷不挪、幂等、她删过的不复活,
 * 见 `userLayer.ts` 的 `migrateLegacyFilesOnce`)。**采回来的数据不进用户层**:最新.txt 与
 * 采集记录.jsonl 仍落 `<工作目录>/数据/<名>/`(那是原始素材,与 账号/、选题/ 同一层)。
 * 撤 = 定义搬进 用户层 `采集器/.trash/`,数据不删。路径全部注入(2026-09-04 事故纪律),用例用临时目录跑。
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CollectorRecordView, CollectorView, CollectorsView } from '../protocol.ts'
import { localDateStr } from './brief.ts'
import { migrateLegacyFilesOnce } from './userLayer.ts'
import { wallOf } from './xhsNoteText.ts'

// ───────────────────────────── 常量(可推翻,理由在决策记录 2026-09-23 下午)─────────────────────────────

export const COLLECTORS_DIR = '采集器'
export const COLLECTOR_TRASH = '.trash'
export const DATA_DIR = '数据'
export const LATEST_FILE = '最新.txt'
export const RECORD_FILE = '采集记录.jsonl'
/** 登录档案目录名的前缀,与 Kimi 网页登录 / 创作者后台同一套(`login-profile-<名>`)。 */
export const PROFILE_PREFIX = 'login-profile-'
/** 同一采集器两次之间至少隔多久(与创作者后台同)。 */
export const MIN_GAP_MS = 10 * 60_000
/** 一天最多几次(例程 1 + 她手点 3)。 */
export const DAILY_MAX = 4
/** 名字上限。它同时是目录名与小组件里 `?name=` 那一格。 */
export const MAX_NAME = 24
/** 采回来的字最多留多少。一页后台的可见文字通常几千字;上限是防一页无限滚动的列表把盘写满。 */
export const MAX_CHARS = 200_000

// ───────────────────────────── 纯函数:定义与校验 ─────────────────────────────

export interface CollectorDef {
  version: 1
  name: string
  url: string
  /** 登录档案名(`login-profile-<profile>`)。 */
  profile: string
  created_at: string
  note?: string
}

/** 名字能不能当目录名。同 `isSafeDeckName`:一段、不拐弯。 */
export function checkCollectorName(raw: unknown): { ok: true, name: string } | { ok: false, error: string } {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name === '') return { ok: false, error: '得给这个采集器起个名字(比如「店铺」)' }
  if (name.length > MAX_NAME) return { ok: false, error: `名字最多 ${MAX_NAME} 个字` }
  if (/[/\\]/.test(name) || name.includes('..') || name.startsWith('.') || name.includes('\n')) {
    return { ok: false, error: '名字不能带 / 或 \\,不能有 ..,也不能以点开头' }
  }
  return { ok: true, name }
}

/** 只认 https,而且地址里不许带账号密码(`https://user:pass@…`)—— 定义文件里不该出现凭据。 */
export function checkCollectorUrl(raw: unknown): { ok: true, url: string } | { ok: false, error: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { ok: false, error: '要那一页的网址(从浏览器地址栏复制)' }
  let parsed: URL
  try { parsed = new URL(text) }
  catch { return { ok: false, error: '这不是一个完整的网址(要以 https:// 开头)' } }
  if (parsed.protocol !== 'https:') return { ok: false, error: '只认 https:// 开头的网址' }
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, error: '网址里不能带账号密码' }
  return { ok: true, url: parsed.toString() }
}

/** 档案名:小写字母数字下划线连字符,1–32。缺省用采集器自己一个档案(**不与创作者后台串号**)。 */
export function checkProfileName(raw: unknown, fallback: string): { ok: true, profile: string } | { ok: false, error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, profile: fallback }
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(text)) return { ok: false, error: '档案名只能是小写字母、数字、下划线或连字符(32 字以内)' }
  return { ok: true, profile: text }
}

/** 采集器缺省的档案名:`collector-<名>`,名字里的中文原样保留会进不了目录名,所以按名字算一个稳定的短码。 */
export function defaultProfileFor(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return `collector-${hash.toString(36)}`
}

export function parseCollectorDef(text: string): CollectorDef | undefined {
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { return undefined }
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const name = checkCollectorName(record.name)
  const url = checkCollectorUrl(record.url)
  if (!name.ok || !url.ok) return undefined
  const profile = checkProfileName(record.profile, defaultProfileFor(name.name))
  if (!profile.ok) return undefined
  return {
    version: 1,
    name: name.name,
    url: url.url,
    profile: profile.profile,
    created_at: typeof record.created_at === 'string' ? record.created_at : '',
    ...(typeof record.note === 'string' && record.note.trim() !== '' ? { note: record.note.trim() } : {}),
  }
}

// ───────────────────────────── 纯函数:闸 ─────────────────────────────

export type CollectorTrigger = 'manual' | 'routine'

/** 一行采集记录(`采集记录.jsonl`)。`status` 之外的字段有才出。 */
export type CollectorRecord = CollectorRecordView

/**
 * 现在能不能采。回 undefined = 能;否则回一句人话。
 *
 * - 两次之间至少 MIN_GAP_MS(**任何一次尝试都算**,失败的也算 —— 失败后立刻再试是轰炸);
 * - 一天最多 DAILY_MAX 次尝试;
 * - 例程那条路:今天已经跑过例程、或今天撞过墙(未登录 / 验证码 / 风控)→ 今天不再试。
 */
export function gateOf(records: readonly CollectorRecord[], trigger: CollectorTrigger, nowMs: number): string | undefined {
  const today = localDateStr(nowMs)
  const todays = records.filter(one => localDateStr(Date.parse(one.at)) === today)
  const last = records[records.length - 1]
  if (last !== undefined) {
    const gap = nowMs - Date.parse(last.at)
    if (Number.isFinite(gap) && gap >= 0 && gap < MIN_GAP_MS) {
      return `上一次是 ${Math.round(gap / 60_000)} 分钟前,两次之间至少隔 ${MIN_GAP_MS / 60_000} 分钟`
    }
  }
  if (todays.length >= DAILY_MAX) return `今天已经采过 ${todays.length} 次(上限 ${DAILY_MAX}),明天再说`
  if (trigger === 'routine') {
    if (todays.some(one => one.trigger === 'routine')) return '今天例程已经采过一次'
    if (todays.some(one => one.status === 'logged_out' || one.status === 'captcha' || one.status === 'blocked')) {
      return '今天撞过一次墙(未登录 / 验证码 / 风控),例程今天不再试'
    }
  }
  return undefined
}

export function parseRecords(text: string | undefined): CollectorRecord[] {
  if (text === undefined) return []
  const out: CollectorRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const one = JSON.parse(line) as CollectorRecord
      if (typeof one.at === 'string' && typeof one.status === 'string') out.push(one)
    }
    catch { /* 半行 / 坏字:跳过。 */ }
  }
  return out
}

// ───────────────────────────── 服务 ─────────────────────────────

/** 浏览器那一侧,只要这两样(`XhsBrowser` 结构上满足)。**没有 `switchTo`**:通用采集器不点任何东西。 */
export interface CollectorBrowser {
  openWindow: (profileDir: string, url: string) => Promise<number>
  readPage: (profileDir: string, url: string) => Promise<{ href: string, title: string, text: string }>
}

export interface CollectorsServiceOptions {
  /** 工作目录。缺席 = 采集器整块不可用(如实说,不猜一条路径)。数据(`数据/<名>/`)落这里。 */
  workdir: () => string | undefined
  /** 采集器定义目录(2026-10-26 切割收尾):`~/.dsh/workbench/用户层/采集器/`。定义的真源。 */
  defsDir: string
  /**
   * 老定义位置(2026-10-26 切割收尾):`<工作目录>/采集器/`。在而 `.迁过` 标记不在时,
   * load() 把里面的 `*.json` 一次性拷进 `defsDir`(只拷不挪、幂等、她删过的不复活)。
   * 缺席(新机器/测试没给)= 不迁。
   */
  legacyDefsDir?: () => string | undefined
  /** 登录档案的父目录(`~/.dsh/workbench`)。 */
  profileRoot: string
  browser: CollectorBrowser
  now?: () => number
  onChanged?: () => void
}

export interface CollectorsService {
  load: () => Promise<void>
  view: () => CollectorsView
  add: (input: { name: unknown, url: unknown, profile?: unknown, note?: unknown }) => Promise<{ ok: true, collector: CollectorView } | { ok: false, error: string }>
  /** 开登录窗口(她自己登;这里不填任何东西)。 */
  login: (name: string) => Promise<{ ok: true, note: string } | { ok: false, error: string }>
  run: (name: string, trigger: CollectorTrigger) => Promise<{ ok: true, record: CollectorRecord } | { ok: false, error: string, record?: CollectorRecord }>
  /** 例程:每个采集器各采一次(过闸的才采)。回给例程 note 的几句。 */
  runForRoutine: () => Promise<string[]>
  /** 撤:定义搬进 `.trash/`,数据不删。 */
  remove: (name: string) => Promise<{ ok: true, note: string } | { ok: false, error: string }>
  /** 小组件读的那一份:`最新.txt` + 最后一条记录。 */
  latest: (name: string) => Promise<{ ok: true, name: string, at?: string, text: string, last?: CollectorRecord } | { ok: false, error: string }>
}

async function readIfThere(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') }
  catch { return undefined }
}

export function createCollectorsService(options: CollectorsServiceOptions): CollectorsService {
  const now = options.now ?? (() => Date.now())
  let items: CollectorView[] = []
  let inFlight = false

  const workdir = (): string | undefined => {
    const dir = options.workdir()
    return dir === undefined || dir === '' ? undefined : dir
  }
  /** 定义的真源(用户层);老位置只在迁移那一程读。 */
  const defsRoot = (): string => options.defsDir
  const dataDir = (root: string, name: string): string => join(root, DATA_DIR, name)
  const profileDirOf = (profile: string): string => join(options.profileRoot, `${PROFILE_PREFIX}${profile}`)

  /** 老位置 → 用户层的一次性迁移(2026-10-26):老目录里的 *.json 逐份拷;回没迁成的名,view() 如实说。 */
  async function migrateLegacyDefs(): Promise<{ failed: string[], markerError?: string }> {
    const legacyDir = options.legacyDefsDir?.()
    if (legacyDir === undefined || legacyDir === '') return { failed: [] }
    let names: string[]
    try {
      names = (await readdir(legacyDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'))
        .map(entry => entry.name)
    }
    catch (error) {
      // 老位置不在(ENOENT)= 没什么可迁;读不准(权限/I/O)≠ 没有 —— 如实报,view() 看得见。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { failed: [] }
      return { failed: [], markerError: `老位置 ${legacyDir} 读不出来(${(error as Error).message}):这次没迁,下次启动再试` }
    }
    const result = await migrateLegacyFilesOnce(options.defsDir, names.map(name => ({ from: join(legacyDir, name), to: join(options.defsDir, name) })))
    return { failed: result.failed, ...(result.markerError === undefined ? {} : { markerError: result.markerError }) }
  }

  async function readDefs(): Promise<CollectorDef[]> {
    let names: string[]
    try {
      names = (await readdir(defsRoot(), { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, 'en'))
    }
    catch { return [] }
    const out: CollectorDef[] = []
    for (const file of names) {
      const text = await readIfThere(join(defsRoot(), file))
      if (text === undefined) continue
      const def = parseCollectorDef(text)
      // 文件名与定义里的名字要对得上;对不上的整个不进清单(不猜哪个是对的)。
      if (def !== undefined && file === `${def.name}.json`) out.push(def)
    }
    return out
  }

  async function readRecords(root: string, name: string): Promise<CollectorRecord[]> {
    return parseRecords(await readIfThere(join(dataDir(root, name), RECORD_FILE)))
  }

  async function viewOf(root: string, def: CollectorDef): Promise<CollectorView> {
    const records = await readRecords(root, def.name)
    const last = records[records.length - 1]
    const lastOk = [...records].reverse().find(one => one.status === 'ok')
    return {
      name: def.name,
      url: def.url,
      profile: def.profile,
      created_at: def.created_at,
      ...(def.note === undefined ? {} : { note: def.note }),
      ...(last === undefined ? {} : { last }),
      ...(lastOk === undefined ? {} : { latest_at: lastOk.at }),
      today: records.filter(one => localDateStr(Date.parse(one.at)) === localDateStr(now())).length,
    }
  }

  async function refresh(): Promise<void> {
    const root = workdir()
    if (root === undefined) { items = []; return }
    const defs = await readDefs()
    const next: CollectorView[] = []
    for (const def of defs) next.push(await viewOf(root, def))
    items = next
    options.onChanged?.()
  }

  async function findDef(name: string): Promise<{ root: string, def: CollectorDef } | { error: string }> {
    const root = workdir()
    if (root === undefined) return { error: '还没配工作目录,采集器没地方落(设置 → 目录)' }
    const checked = checkCollectorName(name)
    if (!checked.ok) return { error: checked.error }
    const text = await readIfThere(join(defsRoot(), `${checked.name}.json`))
    const def = text === undefined ? undefined : parseCollectorDef(text)
    if (def === undefined) return { error: `没有叫「${checked.name}」的采集器` }
    return { root, def }
  }

  async function appendRecord(root: string, name: string, record: CollectorRecord): Promise<void> {
    await mkdir(dataDir(root, name), { recursive: true })
    await writeFile(join(dataDir(root, name), RECORD_FILE), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
  }

  /** 老位置还有几份没迁成 / 终态记录没写成(二轮验收:持久化失败也不谎称已迁),下次启动再试。 */
  let legacyMigrationFailed: string[] = []
  let legacyMigrationMarkerError: string | undefined

  return {
    async load() {
      const migrated = await migrateLegacyDefs()
      legacyMigrationFailed = migrated.failed
      legacyMigrationMarkerError = migrated.markerError
      await refresh()
    },

    view() {
      const root = workdir()
      if (root === undefined) return { items: [], note: '还没配工作目录,采集器整块不可用' }
      const notes = [
        ...(legacyMigrationFailed.length === 0
          ? []
          : [`老位置还有 ${legacyMigrationFailed.length} 份采集器定义没迁成(下次启动再试):${legacyMigrationFailed.join('、')}`]),
        ...(legacyMigrationMarkerError === undefined ? [] : [legacyMigrationMarkerError]),
      ]
      return { items, ...(notes.length === 0 ? {} : { note: notes.join(';') }) }
    },

    async add(input) {
      const root = workdir()
      if (root === undefined) return { ok: false, error: '还没配工作目录,采集器没地方落(设置 → 目录)' }
      const name = checkCollectorName(input.name)
      if (!name.ok) return { ok: false, error: name.error }
      const url = checkCollectorUrl(input.url)
      if (!url.ok) return { ok: false, error: url.error }
      const profile = checkProfileName(input.profile, defaultProfileFor(name.name))
      if (!profile.ok) return { ok: false, error: profile.error }
      const file = join(defsRoot(), `${name.name}.json`)
      if (await readIfThere(file) !== undefined) return { ok: false, error: `已经有一个叫「${name.name}」的采集器了,换个名字或先撤掉它` }
      const note = typeof input.note === 'string' ? input.note.trim() : ''
      const def: CollectorDef = {
        version: 1, name: name.name, url: url.url, profile: profile.profile,
        created_at: new Date(now()).toISOString(),
        ...(note === '' ? {} : { note }),
      }
      await mkdir(defsRoot(), { recursive: true })
      await writeFile(file, `${JSON.stringify(def, null, 2)}\n`, 'utf8')
      await refresh()
      return { ok: true, collector: await viewOf(root, def) }
    },

    async login(name) {
      const found = await findDef(name)
      if ('error' in found) return { ok: false, error: found.error }
      try {
        await options.browser.openWindow(profileDirOf(found.def.profile), found.def.url)
        return { ok: true, note: `开了一个浏览器窗口,请你自己在里面登录;登好了说一声我再采。我不替你填任何东西。` }
      }
      catch (error) {
        return { ok: false, error: `登录窗口开不起来:${(error as Error).message}` }
      }
    },

    async run(name, trigger) {
      const found = await findDef(name)
      if ('error' in found) return { ok: false, error: found.error }
      const { root, def } = found
      if (inFlight) return { ok: false, error: '另一个采集器正在跑,一次只跑一个' }
      const records = await readRecords(root, def.name)
      const gated = gateOf(records, trigger, now())
      if (gated !== undefined) return { ok: false, error: gated }
      inFlight = true
      const at = new Date(now()).toISOString()
      try {
        let page: { href: string, title: string, text: string }
        try { page = await options.browser.readPage(profileDirOf(def.profile), def.url) }
        catch (error) {
          const record: CollectorRecord = { at, trigger, status: 'window_closed', message: `那个登录窗口没开着,或连不上:${(error as Error).message}` }
          await appendRecord(root, def.name, record)
          return { ok: false, error: record.message as string, record }
        }
        const wall = wallOf(page.href, page.text)
        if (wall !== undefined) {
          const record: CollectorRecord = { at, trigger, status: wall.state, href: page.href, message: wall.message }
          await appendRecord(root, def.name, record)
          return { ok: false, error: wall.message, record }
        }
        const text = page.text.length > MAX_CHARS ? page.text.slice(0, MAX_CHARS) : page.text
        const dir = dataDir(root, def.name)
        await mkdir(dir, { recursive: true })
        const stamp = [`# ${def.name}`, `# 采于 ${at}`, `# 页面 ${page.href}`, `# 标题 ${page.title}`, ''].join('\n')
        await writeFile(join(dir, LATEST_FILE), `${stamp}${text}\n`, 'utf8')
        await writeFile(join(dir, `${localDateStr(now())}.txt`), `${stamp}${text}\n`, 'utf8')
        const record: CollectorRecord = { at, trigger, status: 'ok', href: page.href, chars: text.length }
        await appendRecord(root, def.name, record)
        return { ok: true, record }
      }
      finally {
        inFlight = false
        await refresh()
      }
    },

    async runForRoutine() {
      const root = workdir()
      if (root === undefined) return []
      const lines: string[] = []
      for (const def of await readDefs()) {
        const done = await this.run(def.name, 'routine')
        if (done.ok) lines.push(`「${def.name}」采到了 ${done.record.chars ?? 0} 字`)
        else lines.push(`「${def.name}」这次没采:${done.error}`)
      }
      return lines
    },

    async remove(name) {
      const found = await findDef(name)
      if ('error' in found) return { ok: false, error: found.error }
      const { def } = found
      const trash = join(defsRoot(), COLLECTOR_TRASH)
      await mkdir(trash, { recursive: true })
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
      await rename(join(defsRoot(), `${def.name}.json`), join(trash, `${def.name}.${stamp}.json`))
      await refresh()
      return { ok: true, note: `撤了「${def.name}」:定义搬进 用户层/采集器/${COLLECTOR_TRASH}/,${DATA_DIR}/${def.name}/ 里采过的东西没删。` }
    },

    async latest(name) {
      const found = await findDef(name)
      if ('error' in found) return { ok: false, error: found.error }
      const { root, def } = found
      const text = await readIfThere(join(dataDir(root, def.name), LATEST_FILE))
      const records = await readRecords(root, def.name)
      const last = records[records.length - 1]
      const lastOk = [...records].reverse().find(one => one.status === 'ok')
      if (text === undefined) return { ok: true, name: def.name, text: '', ...(last === undefined ? {} : { last }) }
      return { ok: true, name: def.name, text, ...(lastOk === undefined ? {} : { at: lastOk.at }), ...(last === undefined ? {} : { last }) }
    },
  }
}
