/**
 * 资讯播客接 Aiboo 的 AIDJ「通勤播客」(2026-09-22)。
 *
 * Ben 原话:「**直接接就行,至于偏好,我们后面再调,你记着**。」
 * 决策记录 B6:「资讯播客直接接 Aiboo AIDJ」。
 *
 * 这个文件做两件事:
 *
 *   ① **取节目** `GET <aiboo>/api/dj/commute/today` → 归一化成手机认得的一份契约。
 *      Aiboo 那边的形状是 `{date,status,bed,topics[],segments[]}`,音频地址是**相对**的
 *      (`/uploads/tts/xxx.mp3`),这里把它拼成绝对地址,**手机直接从 Aiboo 拉音频**
 *      —— 所以出了局域网也听得了(上一版 `/feed/podcast` 的老毛病)。
 *
 *   ② **推信源** 把工作台当天搜到、打过分的资讯,压成一串关键词写进 Aiboo 的
 *      「今日兴趣点」(`POST <aiboo>/api/dj/mode-config` 的 `commute.interests`)。
 *      Aiboo 明天 07:00 生成节目时会拿它去搜。
 *
 * ## 三条自己给自己划的线
 *
 * - **只写 `commute.interests` 这一个字段**。主播是谁、几位、什么人设、多长,
 *   全是 Ben 在 Aiboo 后台填的。`POST /api/dj/mode-config` 是个**合并**接口,
 *   我们多带一个字段就会把他的配置改掉。所以这里的 body 永远只有那一个键。
 * - **Aiboo 回 404 不算错**。第四节那份补丁(`docs/补丁-Aiboo-接工作台信源-2026-09-22.md`)
 *   里的两条新接口,装了就走、没装就退回兴趣点那条老路。补丁装不装,工作台都跑得通。
 * - **不拿昨天的冒充今天**。缓存里那期不是今天的,状态就是 `stale` 并带上它是哪天的,
 *   界面照实说 —— 一段昨天的资讯播客比没有播客更坏。
 *
 * Aiboo 仓库对这张卡是**只读**的,一行都没改。它的接口长什么样、为什么是这几条,
 * 全文在 `docs/设计-资讯播客接AIDJ-2026-09-22.md`。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FeedProjectGroup } from './feed.ts'
import { topicOf } from './feed.ts'
import { localDateStr } from './brief.ts'

/**
 * Ben 那台阿里云(`Aiboo/docs/project-memory/features/aliyun-server-deploy.md`)。
 * 写成默认值是因为「用户环节不走命令行」:这个功能要**装上就能用**,
 * 不能先让人去哪儿填一个 IP。要换地址:`aidj-config.json` 的 `base_url`(只管电台),
 * 或 `endpoints.json` 的 `aiboo_url`(快报与电台的默认一起换,见 endpoints.ts)。
 */
export const DEFAULT_AIDJ_BASE = 'http://your-aiboo-host:3456'

/** Aiboo `modeConfig.MAX_INTERESTS_LEN`。推过去超了那边会自己截,我们先截好。 */
export const MAX_INTERESTS_CHARS = 500

/** 同一个项目最多往兴趣点里塞几个词 —— 不让一个项目把名额占满。 */
export const KEYWORDS_PER_PROJECT = 2

/** 节目单缓存多久(ms)。节目一天只生成一次,5 分钟足够躲开界面的连点。 */
export const PROGRAM_CACHE_MS = 5 * 60 * 1000

export interface AidjConfig {
  /** 总开关。关了就整块不去打 Aiboo,手机上退回单人口播。 */
  enabled: boolean
  /** Aiboo 服务器地址(不带末尾斜杠)。 */
  base_url: string
  /** 每天跑完资讯之后,要不要把当天条目推给 Aiboo 当信源。 */
  push_interests: boolean
  /**
   * Aiboo 的写路由凭据(2026-09-22)。**只在写请求上当 `X-Aidj-Token` 发出去**,
   * 与服务器 `.env` 里的 `AIDJ_WORKBENCH_TOKEN` 是同一把
   * (Aiboo `fix/dj-api-auth` · `server/middleware/djWriteAuth.cjs`)。
   *
   * 真值只落在 Ben 本机那份 `aidj-config.json` 与服务器的 `.env` 里:
   * **不进仓库、不进日志、不回显给手机**(回给手机的只有 `token_set`,见 `publicAidjConfig`)。
   * 缺席 = 没配。那就一个字节都不发,写路由回 401,工作台照旧静默退回 ——
   * 忘了配不会崩,只是白推。
   */
  token?: string
}

/** 回给手机 / 界面的那一份偏好:**把令牌换成一个布尔**。 */
export interface PublicAidjConfig {
  enabled: boolean
  base_url: string
  push_interests: boolean
  /** 存没存那把令牌。真值任何时候都不出这台机器。 */
  token_set: boolean
}

/** 偏好 → 能给出去的那一份。凭据不回显,这是唯一的出口。 */
export function publicAidjConfig(config: AidjConfig): PublicAidjConfig {
  return {
    enabled: config.enabled,
    base_url: config.base_url,
    push_interests: config.push_interests,
    token_set: (config.token ?? '') !== '',
  }
}

/**
 * 缺省那一份:**两个开关都关着**(2026-09-30 维护者拍板:「现在确实用的少,先关掉吧」)。
 *
 * 关着 = 一次请求都不发(`program()` 直接回 `off`、`push()` 直接返回),
 * 早报那一路退回接 Aiboo 之前的老样子(自己合成单人口播)。
 *
 * **已经在用的人不受影响**:偏好一落盘就是完整的一份(`setConfig` 写的是整份 JSON,
 * 带 `enabled` / `push_interests` 两个布尔),`parseAidjConfig` 认布尔就以文件为准 ——
 * 只有从来没动过这个开关(没有 `aidj-config.json`)的人落到这份缺省上。
 */
export const DEFAULT_AIDJ_CONFIG: AidjConfig = {
  enabled: false,
  base_url: DEFAULT_AIDJ_BASE,
  push_interests: false,
}

/** Aiboo `/api/dj/commute/today` 的回包(**它的形状,不是我们的**)。字段全部当不可信。 */
export interface AidjRawPayload {
  date?: unknown
  status?: unknown
  bed?: unknown
  topics?: unknown
  segments?: unknown
}

/** 一张话题卡片(就是 Aiboo 念的那条资讯)。 */
export interface AidjTopic {
  id: string
  title: string
  summary: string
  url: string
  source: string
  /** 栏目名(「今日资讯」「为你关注」「快讯」…)。 */
  section?: string
}

/** 一段口播。**按播放顺序**排好的。 */
export interface AidjSegment {
  id: string
  /** 主播名(显示用)。 */
  speaker: string
  text: string
  /** 绝对音频地址。**缺席 = 那一行 TTS 失败了**,客户端按字数停留、把文字显示出来。 */
  audio_url?: string
  /** Aiboo **按字数估**的毫秒数。只用来做没有音频时的停留,不拿它报时长。 */
  duration_ms: number
  /** opening / flash / analysis / dig / closing。 */
  tier?: string
  /** 这一段在讲哪张话题卡片。 */
  topic_id?: string
}

/** 音乐床。Aiboo 现在恒为 null(它自己拿掉了),字段留着。 */
export interface AidjBed {
  url: string
  title?: string
  artist?: string
}

export interface AidjProgram {
  date: string
  status: 'ready' | 'empty'
  topics: AidjTopic[]
  segments: AidjSegment[]
  hosts: string[]
  bed?: AidjBed
  /** 各段 `duration_ms` 之和。**是估的**,名字里带 estimated 就是为了不让人当成真时长。 */
  estimated_total_ms: number
}

export interface AidjView {
  /**
   * - `ready` 有今天的节目
   * - `empty` Aiboo 活着,但今天还没生成(07:00 之前就是这样)
   * - `stale` 取回来的是别的日子那期 —— **不播**
   * - `off`   偏好里关了
   * - `error` 连不上 / 回了读不懂的东西
   */
  status: 'ready' | 'empty' | 'stale' | 'off' | 'error'
  program?: AidjProgram
  /** 为什么没有。Aiboo / 网络的原话,**不改写、不粉饰**。 */
  error?: string
  fetched_at: number
}

export interface AidjPushResult {
  ok: boolean
  /** 一句人话,拼进那一轮资讯的 note。 */
  note: string
}

/** —— 纯函数 —— */

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * 相对路径 → 绝对地址。已经是绝对的原样回(哪天 Aiboo 换了 CDN 不用改这里)。
 * 空的回 undefined —— **不编一个地址出来**。
 */
export function aidjAudioUrl(base: string, path: unknown): string | undefined {
  const value = str(path).trim()
  if (value === '') return undefined
  if (/^https?:\/\//i.test(value)) return value
  return `${base.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`
}

/** Aiboo 的回包 → 我们的契约。**不抛**:回包再怎么怪,最坏也只是一份空节目。 */
export function normalizeCommute(raw: AidjRawPayload, base: string): AidjProgram {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as AidjRawPayload
  const topics: AidjTopic[] = []
  if (Array.isArray(obj.topics)) {
    for (const value of obj.topics) {
      if (typeof value !== 'object' || value === null) continue
      const row = value as Record<string, unknown>
      const id = str(row.id)
      if (id === '') continue
      topics.push({
        id,
        title: str(row.title),
        summary: str(row.summary),
        url: str(row.url),
        source: str(row.source),
        ...(str(row.section) === '' ? {} : { section: str(row.section) }),
      })
    }
  }

  const segments: AidjSegment[] = []
  const hosts: string[] = []
  if (Array.isArray(obj.segments)) {
    for (const value of obj.segments) {
      if (typeof value !== 'object' || value === null) continue
      const row = value as Record<string, unknown>
      const text = str(row.text).trim()
      // 既没字又没音的一段:播不出来也读不出来,丢掉。
      if (text === '') continue
      const speaker = str(row.speaker, '主播')
      if (!hosts.includes(speaker)) hosts.push(speaker)
      const audio = aidjAudioUrl(base, row.audio_url)
      const topicId = str(row.topicId)
      segments.push({
        id: str(row.id) === '' ? `seg-${segments.length}` : str(row.id),
        speaker,
        text,
        ...(audio === undefined ? {} : { audio_url: audio }),
        duration_ms: typeof row.duration_ms === 'number' && Number.isFinite(row.duration_ms)
          ? Math.max(0, Math.round(row.duration_ms))
          : 0,
        ...(str(row.tier) === '' ? {} : { tier: str(row.tier) }),
        ...(topicId === '' ? {} : { topic_id: topicId }),
      })
    }
  }

  let bed: AidjBed | undefined
  if (typeof obj.bed === 'object' && obj.bed !== null) {
    const row = obj.bed as Record<string, unknown>
    const id = str(row.id)
    // 取流要按 queue_item_id(`/api/track/stream?id=`),没有 id 就拼不出地址。
    if (id !== '') {
      bed = {
        url: `${base.replace(/\/+$/, '')}/api/track/stream?id=${encodeURIComponent(id)}`,
        ...(str(row.title) === '' ? {} : { title: str(row.title) }),
        ...(str(row.artist) === '' ? {} : { artist: str(row.artist) }),
      }
    }
  }

  return {
    date: str(obj.date),
    // **以段落数为准**,不认它自己报的 status:一份 status=ready 但没有段落的回包播不出东西。
    status: segments.length > 0 ? 'ready' : 'empty',
    topics,
    segments,
    hosts,
    ...(bed === undefined ? {} : { bed }),
    estimated_total_ms: segments.reduce((sum, s) => sum + s.duration_ms, 0),
  }
}

/**
 * 当天资讯 → 一串给 Aiboo 的「今日兴趣点」关键词。
 *
 * 规矩:按分数降序、0 分不要、「不看了」的不要、每个项目最多 `perProject` 个、
 * 去重、整串截到 500 字。
 *
 * **为什么是关键词不是条目**:Aiboo 现在唯一能从外面写进去的信源钩子就是这个字符串
 * (它拿去 `aihot.search()`)。想让它真念我们搜到的那几条,要装那份补丁 —— 见设计页第四节。
 */
export function interestKeywords(
  groups: readonly FeedProjectGroup[],
  opts: { perProject?: number, maxChars?: number } = {},
): string[] {
  const perProject = opts.perProject ?? KEYWORDS_PER_PROJECT
  const maxChars = opts.maxChars ?? MAX_INTERESTS_CHARS
  const picked: string[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    const rows = [...group.items]
      .filter(item => item.score > 0 && item.feedback !== 'mute')
      .sort((a, b) => b.score - a.score)
    let taken = 0
    for (const row of rows) {
      if (taken >= perProject) break
      const word = topicOf(row.title)
      if (word === undefined || seen.has(word)) continue
      seen.add(word)
      picked.push(word)
      taken += 1
    }
  }
  // 截:一个词一个词地加,加到再加就超了为止(不在词中间切断)。
  const out: string[] = []
  let length = 0
  for (const word of picked) {
    const next = length === 0 ? word.length : length + 1 + word.length
    if (next > maxChars) break
    out.push(word)
    length = next
  }
  return out
}

/** 偏好里 `aidj` 那一块。认不出的字段一律走默认,**不抛**。 */
export function parseAidjConfig(raw: unknown, fallback: AidjConfig = DEFAULT_AIDJ_CONFIG): AidjConfig {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  let base = fallback.base_url
  if (typeof obj.base_url === 'string') {
    const trimmed = obj.base_url.trim().replace(/\/+$/, '')
    // 只认 http/https。一行配置不该能把请求打到 file:// 或别的协议上去。
    if (/^https?:\/\/[^\s]+$/i.test(trimmed)) base = trimmed
  }
  // 令牌:给了字符串就以它为准(空串 = 清掉,换令牌时要清得掉);
  // 别的类型一律当没说,**不把原来那把冲掉**。
  let token = fallback.token
  if (typeof obj.token === 'string') {
    const trimmed = obj.token.trim()
    token = trimmed === '' ? undefined : trimmed
  }
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : fallback.enabled,
    base_url: base,
    push_interests: typeof obj.push_interests === 'boolean' ? obj.push_interests : fallback.push_interests,
    ...(token === undefined ? {} : { token }),
  }
}

/** —— 服务 —— */

export interface AidjServiceOptions {
  /**
   * 偏好从哪儿读写。**另起一个文件**,不塞进 `feed-config.json` ——
   * 那会让 `feed.ts` 反过来 import 这个文件,两边互相 import。
   */
  configFile?: string
  /** 直接给一份偏好(测试用)。给了就以它为准,不碰文件。 */
  config?: () => AidjConfig
  /** 打桩用。缺省是全局 fetch。 */
  fetch?: typeof fetch
  now?: () => number
  /** 今天是哪天(本地)。打桩用。 */
  today?: () => string
  /** 一次请求最多等多久。 */
  timeoutMs?: number
  /** 没在偏好里另填地址时用哪台(endpoints.json 的 `aiboo_url`)。缺省 {@link DEFAULT_AIDJ_BASE}。 */
  defaultBase?: string
}

export interface AidjService {
  /** 从偏好文件读一遍(没有文件就是默认)。 */
  load(): Promise<void>
  /** 今天那期节目(带缓存)。 */
  program(): Promise<AidjView>
  /** 把当天资讯推给 Aiboo 当信源。**不抛** —— 它不该连累整轮资讯。 */
  push(groups: readonly FeedProjectGroup[], date: string): Promise<AidjPushResult>
  config(): AidjConfig
  /** 能给出去的那一份(**没有令牌**)。路由回给手机的就是它。 */
  publicConfig(): PublicAidjConfig
  /** 改偏好(手机上那个开关)。落盘。 */
  setConfig(patch: unknown): Promise<AidjConfig>
}

export function defaultAidjConfigFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/aidj-config.json`
}

function errorNote(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[A-Za-z0-9_-]{32,}/g, '…').slice(0, 200)
}

export function createAidjService(opts: AidjServiceOptions): AidjService {
  const now = opts.now ?? (() => Date.now())
  const today = opts.today ?? (() => localDateStr(now()))
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? 12000
  let cache: { at: number, view: AidjView } | undefined
  const fallback: AidjConfig = opts.defaultBase === undefined ? DEFAULT_AIDJ_CONFIG : { ...DEFAULT_AIDJ_CONFIG, base_url: opts.defaultBase }
  let stored: AidjConfig = fallback

  const config = (): AidjConfig => (opts.config === undefined ? stored : opts.config())

  function base(): string {
    return config().base_url.replace(/\/+$/, '')
  }

  async function call(path: string, init?: { method: string, body: unknown }): Promise<
    { ok: true, status: number, body: unknown } | { ok: false, error: string }
  > {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    // 令牌**只跟着写请求走**:Aiboo 的读路由(取节目单)维持匿名,
    // 带过去只是让一把凭据多在网上跑一趟。没配就一个头都不加。
    const token = init === undefined ? '' : (config().token ?? '')
    try {
      const response = await doFetch(`${base()}${path}`, {
        ...(init === undefined ? {} : { method: init.method, body: JSON.stringify(init.body) }),
        headers: {
          'content-type': 'application/json',
          ...(token === '' ? {} : { 'x-aidj-token': token }),
        },
        signal: controller.signal,
      })
      let body: unknown
      try { body = await response.json() }
      catch { body = undefined }
      if (!response.ok) return { ok: true, status: response.status, body }
      if (body === undefined) return { ok: false, error: `Aiboo(${base()})回了一段读不懂的内容` }
      return { ok: true, status: response.status, body }
    }
    catch (error) {
      return { ok: false, error: `连不上 Aiboo(${base()}):${errorNote(error)}` }
    }
    finally { clearTimeout(timer) }
  }

  async function fetchProgram(): Promise<AidjView> {
    const ms = now()
    const result = await call('/api/dj/commute/today')
    if (!result.ok) return { status: 'error', error: result.error, fetched_at: ms }
    if (result.status !== 200) {
      return { status: 'error', error: `Aiboo 取今天的播客回了 ${result.status}`, fetched_at: ms }
    }
    const program = normalizeCommute(result.body as AidjRawPayload, base())
    if (program.status === 'empty') {
      return { status: 'empty', program, fetched_at: ms }
    }
    const day = today()
    // 日期对不上就**不播**。一段昨天的资讯播客比没有播客更坏。
    if (program.date !== '' && program.date !== day) {
      return {
        status: 'stale',
        error: `Aiboo 上最新的一期是 ${program.date} 的,今天(${day})这期还没生成`,
        fetched_at: ms,
      }
    }
    return { status: 'ready', program, fetched_at: ms }
  }

  return {
    config,

    publicConfig: () => publicAidjConfig(config()),

    async load(): Promise<void> {
      if (opts.configFile === undefined) return
      try {
        stored = parseAidjConfig(JSON.parse(await readFile(opts.configFile, 'utf8')), fallback)
        // 10-21 之前存偏好会把默认地址一并写进去,那不是她挑的地址 —— 按「没填」算,跟着 endpoints 走。
        if (stored.base_url === DEFAULT_AIDJ_BASE) stored = { ...stored, base_url: fallback.base_url }
      }
      catch { stored = fallback }
    },

    async setConfig(patch: unknown): Promise<AidjConfig> {
      const obj = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>
      stored = parseAidjConfig({ ...config(), ...obj }, config())
      // 偏好一变,上一次取回来的那期就可能来自别的地址了 —— 缓存作废。
      cache = undefined
      if (opts.configFile !== undefined) {
        const tmp = `${opts.configFile}.${randomUUID()}.tmp`
        await mkdir(dirname(opts.configFile), { recursive: true })
        // 地址等于默认那一份就不落盘:默认地址归 endpoints.json 管,写死在这里以后就换不动了。
        const { base_url: baseUrl, ...rest } = stored
        await writeFile(tmp, `${JSON.stringify(baseUrl === fallback.base_url ? rest : stored, null, 2)}\n`)
        await rename(tmp, opts.configFile)
      }
      return stored
    },

    async program(): Promise<AidjView> {
      if (!config().enabled) return { status: 'off', fetched_at: now() }
      const ms = now()
      // 只缓存拿得到东西的那两种(ready / empty)。**失败不进缓存** ——
      // 否则一次抖动会让界面在接下来五分钟里一直重复同一句错话。
      if (cache !== undefined && ms - cache.at < PROGRAM_CACHE_MS) return cache.view
      const view = await fetchProgram()
      if (view.status === 'ready' || view.status === 'empty') cache = { at: ms, view }
      else cache = undefined
      return view
    },

    async push(groups, date): Promise<AidjPushResult> {
      const current = config()
      // 整块关着(2026-09-30 起这就是缺省)→ **一个字都不往早报的 note 里加**:
      // 每天说一遍「AIDJ 关着」是噪音,他压根没打开过它。单独把「推信源」关了才说一句。
      if (!current.enabled) return { ok: false, note: '' }
      if (!current.push_interests) return { ok: false, note: '「把资讯推给 Aiboo」关着' }
      const words = interestKeywords(groups)
      // 空串推过去 = 把他在后台填的兴趣点清掉。宁可不推。
      if (words.length === 0) return { ok: false, note: '今天没有够得上的条目,没往 Aiboo 推' }

      // ① 先试条目接口(那份补丁)。装了就走它 —— 它带着项目名与分数,信息最全。
      const items = groups.flatMap(group => group.items
        .filter(item => item.score > 0 && item.feedback !== 'mute')
        .map(item => ({
          id: item.id,
          title: item.title,
          summary: item.why,
          url: item.url,
          source: item.source ?? '',
          project: item.project_name,
          score: item.score,
        })))
      const pushed = await call('/api/dj/commute/source', { method: 'POST', body: { date, items } })
      if (!pushed.ok) return { ok: false, note: `没能把资讯推给 Aiboo:${pushed.error}` }
      if (pushed.status === 200) {
        await call('/api/dj/commute/regenerate', { method: 'POST', body: { date } })
        return { ok: true, note: `已把 ${items.length} 条条目推给 Aiboo 当今天的信源` }
      }
      // 401/403 = Aiboo 把写路由关上了而这边没配对令牌(2026-09-22)。
      // **就此打住**:兴趣点那条也是写路由,拿同一把令牌再敲一次只会再吃一个 401。
      // 说一句人话让 Ben 去设置里填 —— 注意这句里**不带令牌本身**。
      if (pushed.status === 401 || pushed.status === 403) {
        return {
          ok: false,
          note: current.token === undefined
            ? 'Aiboo 的写接口要凭据,设置里的「Aiboo 令牌」还空着,今天没推成'
            : 'Aiboo 不认这把「Aiboo 令牌」(401),今天没推成',
        }
      }
      // 404 = Aiboo 还没装补丁。**不算错**,退回兴趣点那条老路。
      if (pushed.status !== 404) {
        return { ok: false, note: `Aiboo 收条目时回了 ${pushed.status},退回推兴趣点` }
      }

      // ② 兴趣点。**body 里永远只有 commute.interests 这一个字段**(见文件头第一条线)。
      const interests = words.join(',')
      const set = await call('/api/dj/mode-config', { method: 'POST', body: { commute: { interests } } })
      if (!set.ok) return { ok: false, note: `没能把兴趣点推给 Aiboo:${set.error}` }
      if (set.status !== 200) return { ok: false, note: `Aiboo 收兴趣点时回了 ${set.status}` }
      await call('/api/dj/commute/regenerate', { method: 'POST', body: { date } })
      return { ok: true, note: `已把今天的兴趣点推给 Aiboo:${interests}` }
    },
  }
}
