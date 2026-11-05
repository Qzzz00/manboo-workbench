/**
 * 采集类三项的**编排**(2026-09-22):评论区采集 ① + 笔记采集 ② 是同一次读取,
 * 爆款拆解 ③ 接在 ② 的产物上(xhsBreakdown.ts)。
 *
 * 真碰网络在 `xhsNoteBrowser.ts`,解析在 `xhsNoteText.ts`(**选型与许可证判断写在那个文件头**),
 * 拆解在 `xhsBreakdown.ts` / `xhsBreakdownText.ts`。这里只管:
 * **什么时候允许去采、采回来落到哪、每一次都记一条看得见的记录**。
 *
 * ## ①② 为什么是同一次读取
 *
 * 预研第四节:一次打开页面,把正文、标签、评论、视频直链一起读回来,
 * **比开两次省一半的请求量,而请求量就是风险量**。所以只有一条
 * `POST /collect/note {url}`,出来两份产物(笔记.md + 评论.md)。
 *
 * ## 三道闸(都是代码里的闸,不是文档里的劝告)
 *
 * | 闸 | 值 | 为什么 |
 * |---|---|---|
 * | 同一条链接多久内不重采 | {@link SAME_URL_GAP_MS} 10 分钟 | 同一条笔记十分钟内不会变;重采只多一次请求 |
 * | 一天最多采几条 | {@link DEFAULT_DAILY_MAX} 30(可配) | 一天三十条是"一个人在认真看",三百条是爬虫 |
 * | 一次只处理一条 | `inFlight` | 不做批量、不做队列 —— 队列是批量的第一步 |
 *
 * **上限改哪儿**:`~/.dsh/workbench/xhs-collect.json` 里的 `daily_max`。
 * 没做界面(理由同数据复盘那张卡的 `xhs-selectors.json`:这个数稳定下来之前,
 * 给一个半专业用户递一把他不需要的螺丝刀不是帮他)。
 *
 * ## 停下来的四种情况(一种都不重试、不绕过)
 *
 * 未登录 / 风控页 / 验证码 / 这条打不开 —— 判据在 `xhsNoteText.wallOf`,
 * 这里只负责**如实写进记录并把原话交给界面**。
 * 绝不自动过验证码,绝不换个地址再试一次。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { XhsCollectLogView, XhsCollectView } from '../protocol.ts'
import { localDateStr } from './brief.ts'
import type { NotePageRead, XhsNoteBrowser } from './xhsNoteBrowser.ts'
import type { CollectedComment, CollectedNote } from './xhsNoteText.ts'
import {
  COLLECT_DIR_NAME, COMMENTS_FILE_NAME, NOTE_FILE_NAME,
  noteDirName, parseNoteLink, parseNotePayload, renderCommentsMd, renderNoteMd,
} from './xhsNoteText.ts'

/** 同一条链接多久内不重采。任务书写死 10 分钟。 */
export const SAME_URL_GAP_MS = 10 * 60 * 1000

/** 一天最多采几条(可配)。任务书:默认 30。 */
export const DEFAULT_DAILY_MAX = 30

/** 记录留多少条。够看一眼"最近都采了什么",不无限长。 */
export const LOG_MAX = 50

/** 工作目录没配时那句话。同 `MEETING_NO_WORKDIR` 的口径:**不猜一个路径**。 */
export const COLLECT_NO_WORKDIR = '还没配「工作目录」(事务官仓库),采集的东西没地方落。'

export interface StoredCollectLog extends XhsCollectLogView {}

export interface CollectFile {
  version: 1
  /** 一天上限。手改这个文件就能改。 */
  daily_max: number
  /** 每条链接最近一次**开始采**的时刻(不论成败)。频率闸看它。 */
  last: Record<string, number>
  /** 哪一天采了几次(本地日期 → 次数)。只留最近几天。 */
  days: Record<string, number>
  logs: StoredCollectLog[]
}

export function emptyCollectFile(): CollectFile {
  return { version: 1, daily_max: DEFAULT_DAILY_MAX, last: {}, days: {}, logs: [] }
}

export function defaultCollectFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/xhs-collect.json`
}

/** 读。**读坏了当没有**(退回空的),一份坏文件不该让整块功能消失。 */
export async function loadCollectFile(file: string): Promise<CollectFile> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<CollectFile>
    const max = typeof parsed.daily_max === 'number' && parsed.daily_max > 0
      ? Math.floor(parsed.daily_max)
      : DEFAULT_DAILY_MAX
    return {
      version: 1,
      daily_max: max,
      last: typeof parsed.last === 'object' && parsed.last !== null ? parsed.last : {},
      days: typeof parsed.days === 'object' && parsed.days !== null ? parsed.days : {},
      logs: Array.isArray(parsed.logs) ? parsed.logs.slice(0, LOG_MAX) : [],
    }
  }
  catch { return emptyCollectFile() }
}

export async function saveCollectFile(file: string, data: CollectFile): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
}

/** 只留最近 7 天的计数 —— 这个文件没有理由越长越大。 */
export function pruneDays(days: Record<string, number>, today: string): Record<string, number> {
  const keep = new Set<string>()
  const base = new Date(`${today}T00:00:00`)
  for (let i = 0; i < 7; i++) {
    const day = new Date(base.getTime() - i * 86_400_000)
    keep.add(localDateStr(day.getTime()))
  }
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(days)) if (keep.has(key)) out[key] = value
  return out
}

export type CollectGate =
  | { ok: true }
  | { ok: false, reason: string }

/** 两道闸的判据,抽出来是为了用例能单独钉住它(不必跑一整轮采集)。 */
export function checkGates(file: CollectFile, url: string, nowMs: number): CollectGate {
  const today = localDateStr(nowMs)
  const used = file.days[today] ?? 0
  if (used >= file.daily_max) {
    return { ok: false, reason: `今天已经采了 ${used} 条,到上限了(每天最多 ${file.daily_max} 条)。明天再来。` }
  }
  const last = file.last[url]
  if (last !== undefined && nowMs - last < SAME_URL_GAP_MS) {
    const wait = Math.ceil((SAME_URL_GAP_MS - (nowMs - last)) / 60_000)
    return { ok: false, reason: `这条刚采过,${wait} 分钟后再来(同一条笔记十分钟内不会变)。` }
  }
  return { ok: true }
}

export interface CollectNoteResult {
  ok: boolean
  message: string
  /** 落在哪个文件夹(绝对路径)。失败时缺席。 */
  dir?: string
  comments?: number
  /** 采到的那条笔记本身 —— 拆解那一步接着用,不重新打开页面。 */
  note?: CollectedNote
}

export interface XhsCollectServiceOptions {
  file: string
  /** 专用 Chrome 档案目录(与数据复盘同一个,`login-profile-xhs_creator`)。 */
  profileDir: string
  /** 工作目录。**没配就整块拒绝**,不猜路径。 */
  workdir: () => string | undefined
  browser: XhsNoteBrowser
  now?: () => number
  onChanged?: () => void
  /** 本机有没有 ffmpeg / whisper.cpp / 模型。缺省不问(界面上那一块缺席)。 */
  tools?: () => Promise<XhsCollectView['tools']>
  /**
   * ③ 爆款拆解怎么跑。**不传 = 这台机器上拆解这一步没接**(`/collect/breakdown` 如实说),
   * 而不是假装能拆。生产上接的是 `xhsBreakdown.runBreakdown`;用例里换成桩。
   */
  breakdown?: (note: CollectedNote, dir: string, url: string) => Promise<{ ok: boolean, message: string, file?: string }>
}

export interface XhsCollectService {
  load: () => Promise<void>
  view: () => Promise<XhsCollectView>
  /** ①② 同一次读取。 */
  collectNote: (rawUrl: unknown) => Promise<CollectNoteResult>
  /** 记一条记录(拆解那一步也走这条,记录是同一份)。 */
  log: (entry: XhsCollectLogView) => Promise<void>
  /**
   * 顶上那句「正在…」。拆解要跑好几分钟(下模型、转写、抽帧),
   * **一句都不说等于让他对着转圈干等** —— 记忆「用户环节不走命令行」的另一面。
   * 它不进采集记录:记录记的是"做过什么",不是"做到哪一步了"。
   */
  say: (line: string) => void
  /** 这条链接的产物落在哪个文件夹(拆解那一步要用)。没采过回 undefined。 */
  dirOf: (url: string) => string | undefined
  /**
   * ③ 拆解已经采过的那一条。
   *
   * ★ **拆解不会自己再开一次页面**:它用的是这一轮采集读回来的那份数据。
   * 只有在"这条还没采过"时才先采一次(那一次照样过频率闸与日上限)。
   * 理由还是那一句:请求量就是风险量。
   */
  breakdown: (url: unknown) => Promise<{ ok: boolean, message: string, file?: string }>
}

export function createXhsCollectService(options: XhsCollectServiceOptions): XhsCollectService {
  const now = options.now ?? (() => Date.now())
  let file: CollectFile = emptyCollectFile()
  let note: string | undefined
  let inFlight = false
  /**
   * 这一轮采到的笔记本身。**只在内存里**,进程重启就没了 —— 这是故意的:
   * 视频直链是带签名、有时效的,存进盘里只会留下一条过一阵就打不开的地址,
   * 还得解释"为什么昨天采的今天拆不了"。要拆就当场拆。
   */
  const notes = new Map<string, CollectedNote>()

  async function persist(): Promise<void> {
    await saveCollectFile(options.file, file)
    options.onChanged?.()
  }

  async function load(): Promise<void> {
    file = await loadCollectFile(options.file)
  }

  async function log(entry: XhsCollectLogView): Promise<void> {
    file = { ...file, logs: [entry, ...file.logs].slice(0, LOG_MAX) }
    await persist()
  }

  function say(line: string): void {
    note = line
    options.onChanged?.()
  }

  function dirOf(url: string): string | undefined {
    return file.logs.find(one => one.url === url && one.ok && one.dir !== undefined)?.dir
  }

  async function view(): Promise<XhsCollectView> {
    const today = localDateStr(now())
    const tools = options.tools === undefined ? undefined : await options.tools()
    return {
      today: file.days[today] ?? 0,
      daily_max: file.daily_max,
      logs: file.logs,
      workdir_ready: options.workdir() !== undefined,
      ...(note === undefined ? {} : { note }),
      ...(tools === undefined ? {} : { tools }),
    }
  }

  async function collectNote(rawUrl: unknown): Promise<CollectNoteResult> {
    const link = parseNoteLink(rawUrl)
    if (!link.ok) { note = link.reason; return { ok: false, message: link.reason } }

    const workdir = options.workdir()
    if (workdir === undefined) { note = COLLECT_NO_WORKDIR; return { ok: false, message: COLLECT_NO_WORKDIR } }

    if (inFlight) return { ok: false, message: '上一条还没采完 —— 一次只处理一条。' }

    const nowMs = now()
    const gate = checkGates(file, link.link.url, nowMs)
    if (!gate.ok) { note = gate.reason; return { ok: false, message: gate.reason } }

    inFlight = true
    // ★ 闸先落再去采:失败也算一次。不然"打不开就不算数"会变成"一直重试一直不算数"。
    const today = localDateStr(nowMs)
    file = {
      ...file,
      last: { ...file.last, [link.link.url]: nowMs },
      days: pruneDays({ ...file.days, [today]: (file.days[today] ?? 0) + 1 }, today),
    }

    const at = new Date(nowMs).toISOString()
    const fail = async (reason: string): Promise<CollectNoteResult> => {
      note = reason
      await log({ at, url: link.link.url, ok: false, kind: 'note', reason })
      return { ok: false, message: reason }
    }

    try {
      let page: NotePageRead
      try { page = await options.browser.readNote(options.profileDir, link.link.url) }
      catch (error) {
        return await fail(error instanceof Error ? error.message : '打不开那一页')
      }

      const parsed = parseNotePayload(page.payload, link.link.id, page.href, page.text)
      if (parsed.state !== 'ok' || parsed.note === undefined) {
        return await fail(parsed.message)
      }

      const collected: CollectedNote = parsed.note
      const comments: readonly CollectedComment[] = parsed.comments ?? []
      const meta = { at, url: link.link.url }
      const dir = join(workdir, COLLECT_DIR_NAME, noteDirName(today, collected.title))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, NOTE_FILE_NAME), renderNoteMd(collected, meta), 'utf8')
      await writeFile(
        join(dir, COMMENTS_FILE_NAME),
        renderCommentsMd(comments, meta, collected.title, parsed.comment_total),
        'utf8',
      )

      note = undefined
      notes.set(link.link.url, collected)
      await log({
        at, url: link.link.url, ok: true, kind: 'note',
        comments: comments.length, dir, scrolls: page.scrolls,
      })
      return {
        ok: true,
        message: `采到了:${comments.length} 条评论(滚了 ${page.scrolls} 下),落在 ${dir}`,
        dir,
        comments: comments.length,
        note: collected,
      }
    }
    finally { inFlight = false }
  }

  async function breakdown(rawUrl: unknown): Promise<{ ok: boolean, message: string, file?: string }> {
    const runner = options.breakdown
    if (runner === undefined) return { ok: false, message: '这台机器上还没接爆款拆解。' }
    const link = parseNoteLink(rawUrl)
    if (!link.ok) { note = link.reason; return { ok: false, message: link.reason } }

    let collected = notes.get(link.link.url)
    let dir = dirOf(link.link.url)
    if (collected === undefined || dir === undefined) {
      // 还没采过(或者工作台重启过)—— 先采一次。这一次照样过闸。
      const first = await collectNote(rawUrl)
      if (!first.ok || first.note === undefined || first.dir === undefined) {
        return { ok: false, message: first.message }
      }
      collected = first.note
      dir = first.dir
    }

    const at = new Date(now()).toISOString()
    let result: { ok: boolean, message: string, file?: string }
    try { result = await runner(collected, dir, link.link.url) }
    catch (error) { result = { ok: false, message: error instanceof Error ? error.message : '拆解没跑成' } }

    note = result.ok ? undefined : result.message
    await log({
      at, url: link.link.url, ok: result.ok, kind: 'breakdown', dir,
      ...(result.ok ? {} : { reason: result.message }),
    })
    return result
  }

  return { load, view, collectNote, log, say, dirOf, breakdown }
}

/**
 * HTTP 层看到的那一面(`/collect/*` 三条路由用它)。
 *
 * 单独一个接口而不是直接用 {@link XhsCollectService},是为了 `http.ts` 不必 import
 * `xhsBreakdown.ts` —— 那个文件拽着 `node:child_process`,而 http 层没有理由认识它。
 */
export interface XhsCollectApi {
  view: () => Promise<XhsCollectView>
  /** ①② 同一次读取。 */
  collectNote: (url: unknown) => Promise<{ ok: boolean, message: string, dir?: string, comments?: number }>
  /** ③ 拆解。要先采过这条链接 —— 拆的是已经落盘的那份,**不再开一次页面**。 */
  breakdown: (url: unknown) => Promise<{ ok: boolean, message: string, file?: string }>
}
