/**
 * 今晨快报(W4):从 AiDJ 电台取当天的资讯条目,落盘缓存,并按触发规则算出"该不该推"。
 *
 * 内容源(2026-08-25 实测公开免登录,Access-Control-Allow-Origin: *):
 *   GET http://your-aiboo-host:3456/api/dj/commute/today
 *   → { date, bed, topics: [...], segments: [...], status: 'ready' | 'empty' }
 * 由 AiDJ 的 scheduler 每天 07:00 预生成(Aiboo 仓库 server/dj/commutePodcast.cjs)。
 * 那几十段 TTS 音频本单元完全不碰——浮窗要的是文本。
 *
 * **为什么走服务端而不是客户端直连**:CORS 是 `*`,客户端能直连。但触发状态必须跨客户端
 * 唯一——这台机器上同时有多个页面客户端(壳内 WKWebView、浏览器开的 3080 标签,
 * 0.1.58「矩形投毒案」已实锤),计数存浏览器本地就会变成每个客户端各推一次,
 * 「一天最多一次」与「划走后当天不再推」两条直接失效。
 *
 * 落盘 ~/.dsh/workbench/brief.json,原子写 + 容错读(与 dock.json/scenes.json 同规格)。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BriefTopic, BriefView } from '../protocol.ts'

/** Aiboo 云的默认地址;可在 endpoints.json 的 `aiboo_url` 里换或关(endpoints.ts)。 */
const DEFAULT_BRIEF_BASE = 'http://your-aiboo-host:3456'
const COMMUTE_PATH = '/api/dj/commute/today'
/** 上游是外网服务,不能让它把 /state 拖住——超时就当没取到,如实报,不阻塞别的模块。 */
const FETCH_TIMEOUT_MS = 6000

export interface BriefFile {
  version: 1
  date: string
  fetched_at: number
  topics: BriefTopic[]
  /** 推过的时刻(ms);null = 当天还没推过。 */
  pushed_at: number | null
  dismissed: boolean
  /**
   * 上一次**尝试**取数的时刻(ms),不管成不成功(评审修复轮 1·Important)。
   * 必须落盘、不能只活在进程内存里——否则进程重启(尤其 crash-loop)会让新实例的
   * 内存节流变量清零,下一拍立刻无视 60s 节流窗口再打上游,它挡的是对 Ben 线上
   * 服务的洪水,节流状态本身就不能是易失的。缺省 0(与 emptyFile 一致)。
   */
  last_attempt_at: number
}

export interface BriefService {
  view(): Promise<BriefView | undefined>
  dismiss(): Promise<void>
}

export interface BriefServiceOptions {
  file: string
  /** 内容源的根地址。缺省 = Aiboo 云;`null` = 关了,一次都不连、快报整块缺席。 */
  baseUrl?: string | null
  fetchImpl?: typeof fetch
  now?: () => number
}

export function defaultBriefFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/brief.json`
}

/** 本地日期 YYYY-MM-DD——快报是"今晨"的东西,必须按本地时区切天,不能用 UTC。 */
export function localDateStr(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function emptyFile(date: string): BriefFile {
  return { version: 1, date, fetched_at: 0, topics: [], pushed_at: null, dismissed: false, last_attempt_at: 0 }
}

async function loadBriefFile(file: string, date: string): Promise<BriefFile> {
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch { return emptyFile(date) }
  try {
    const parsed = JSON.parse(text) as Partial<BriefFile> | null
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.topics)) return emptyFile(date)
    return {
      version: 1,
      date: typeof parsed.date === 'string' ? parsed.date : date,
      fetched_at: typeof parsed.fetched_at === 'number' ? parsed.fetched_at : 0,
      topics: parsed.topics as BriefTopic[],
      pushed_at: typeof parsed.pushed_at === 'number' ? parsed.pushed_at : null,
      dismissed: parsed.dismissed === true,
      // 旧存档(本轮修复之前落盘的)没有这个字段,缺省当 0——不是"刚试过",是"不知道"。
      last_attempt_at: typeof parsed.last_attempt_at === 'number' ? parsed.last_attempt_at : 0,
    }
  }
  catch { return emptyFile(date) } // 写坏了按空处理,先例见 loadDockFile
}

async function saveBriefFile(file: string, data: BriefFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await rename(tmp, file)
}

/**
 * 触发规则(Ben 2026-08-25 定)。纯函数,便于穷举单测。
 * 原规则②「额度触底/多会话等确认时并推一次」已去掉——内容源换成 AI 行业资讯之后,
 * 拿额度触底当推资讯的理由说不通;那两个工作信号已各有归宿(事务官结论 + 标签黄徽章)。
 */
export function shouldPushBrief(file: BriefFile, todayStr: string): boolean {
  if (file.date !== todayStr) return true // 跨天重置
  if (file.dismissed) return false        // 划走后当天不再推
  return file.pushed_at === null          // 一天最多一次
}

/** 只挑认识的字段,且全部按字符串收——上游多给的字段不带进来,少给的不让它变成 undefined 混进 JSON。 */
function toTopic(raw: unknown): BriefTopic | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.title !== 'string') return undefined
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    id: r.id,
    section: str(r.section),
    title: r.title,
    summary: str(r.summary),
    url: str(r.url),
    source: str(r.source),
    tier: str(r.tier),
  }
}

export function createBriefService(opts: BriefServiceOptions): BriefService {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => Date.now())

  /**
   * 写队列(评审修复轮 1·Critical,先例见 dock.ts:load→改→save 不排队会丢更新)。
   *
   * 三条触发规则里最核心的两条——"一天最多一次""划走后当天不再推"——本质上都是
   * "读当前状态、按规则决定、写回"的读改写,必须整段串行化。这台机器上同时存在
   * 多个页面客户端(壳内 WKWebView + 浏览器标签),`/state` 又是 1s 一次轮询:
   * 两个客户端的 GET /state 在同一 tick 附近到达,若各自的 view() 都在对方
   * saveBriefFile 完成前读到 pushed_at:null,就会各自算出 push:true、各自写回,
   * 同一天推两次;dismiss() 与 view() 之间同理会互相覆盖。把服务端当唯一权威的
   * 全部意义就在于此——没有写队列,这个"跨客户端唯一"就只是名义上的。
   *
   * 取数(fetchToday)本身**不**放进这个队列:它可能长达 FETCH_TIMEOUT_MS(6s),
   * 塞进队列会让并发的 /state 排成长队。是否发起取数由 lastAttemptMs 的同步
   * check-and-set 天然去重(JS 单线程,判断和赋值之间没有 await,两个并发调用
   * 不会同时通过判断——见下方 view() 里的用法)。取到的结果只是候选值(闭包在
   * 各自那次 view() 调用里),真正落盘时在队列内重新读一次当前文件,只在
   * "仍然对得上今天且仍未取到"时才把候选结果并进去——不会用取数期间已经过期的
   * 旧值覆盖掉队列里其它操作(dismiss/别的 view)已经写入的东西。
   */
  let writeQueue: Promise<void> = Promise.resolve()
  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * 上一次尝试取数的时刻;失败后至少隔这么久才再试,别让 1s 轮询变成对上游的洪水。
   * 初值 0 只是"这个进程还没读过盘",不代表"从没试过"——view() 每次都会用
   * 落盘的 BriefFile.last_attempt_at 兜底这个内存变量(取较大值),所以进程重启
   * (含 crash-loop)不会让节流形同虚设(评审修复轮 1·Important)。
   */
  let lastAttemptMs = 0
  const RETRY_AFTER_MS = 60_000

  async function fetchToday(): Promise<{ topics: BriefTopic[] } | { error: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetchImpl(`${(opts.baseUrl ?? DEFAULT_BRIEF_BASE).replace(/\/+$/, '')}${COMMUTE_PATH}`, { signal: controller.signal })
      if (!res.ok) return { error: `快报接口回了 ${res.status}` }
      const doc = await res.json() as { status?: unknown, topics?: unknown }
      if (doc.status !== 'ready') return { topics: [] } // 今天还没生成——不是错误,就是没有
      const topics = Array.isArray(doc.topics)
        ? doc.topics.map(toTopic).filter((t): t is BriefTopic => t !== undefined)
        : []
      return { topics }
    }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
    finally { clearTimeout(timer) }
  }

  return {
    async view(): Promise<BriefView | undefined> {
      if (opts.baseUrl === null) return undefined
      const ms = now()
      const today = localDateStr(ms)

      // 只读探测,不是权威读——决定"要不要发起取数"用。权威的读改写全在下面的
      // 队列任务里重新读一次,这里读到的 data 不直接拿去算 push/落盘。
      const peek = await loadBriefFile(opts.file, today)
      const peekToday = peek.date === today ? peek : emptyFile(today)
      // 用磁盘值兜底内存节流变量:进程重启后内存是 0,但磁盘记得上一个进程试过没有。
      lastAttemptMs = Math.max(lastAttemptMs, peekToday.last_attempt_at)

      // 是否发起取数,判断和赋值之间不能有 await——两个并发 view() 都在这行前排队等
      // 各自的 loadBriefFile 完成,谁先到这行谁同步地把 lastAttemptMs 设成 ms,
      // 后到的那个再判断时窗口已经不够,天然只有一个会真的调用 fetchToday。
      let fetched: { topics: BriefTopic[] } | { error: string } | undefined
      if (peekToday.fetched_at === 0 && ms - lastAttemptMs >= RETRY_AFTER_MS) {
        lastAttemptMs = ms
        fetched = await fetchToday()
      }

      return enqueueWrite(async () => {
        // 权威读:队列内串行执行,这次读到的必然是上一个队列任务(别的 view/dismiss)
        // 落盘之后的最新状态,不会跟别的操作交错读到中间态。
        let data = await loadBriefFile(opts.file, today)

        // 跨天:整份重置(pushed_at/dismissed/last_attempt_at 一并归零),再取新的。
        if (data.date !== today) data = emptyFile(today)

        let error: string | undefined
        // data.fetched_at === 0 这道门在队列内重新判一次:如果取数期间别的并发 view()
        // 已经抢先把今天的数据落盘了,这里就不该用自己那份可能过期的 fetched 结果覆盖。
        if (fetched !== undefined && data.fetched_at === 0) {
          data.last_attempt_at = ms
          if ('error' in fetched) { error = fetched.error }
          else {
            data.topics = fetched.topics
            data.fetched_at = ms
          }
          await saveBriefFile(opts.file, data)
        }

        // 没有内容就不推、不摆空壳(诚实边界)——push 只在真有条目时才可能为 true。
        const push = data.topics.length > 0 && shouldPushBrief(data, today)
        if (push) {
          data.pushed_at = ms
          await saveBriefFile(opts.file, data)
        }

        return {
          date: data.date,
          topics: data.topics,
          push,
          ...(error === undefined ? {} : { error }),
          // 终审 C3:划走这件事必须投影出去,不然客户端点了 ✕ 只是发了一次请求,
          // 下一拍拿回来的 topics 一条不少,界面纹丝不动。缺省即"没划走"。
          ...(data.dismissed ? { dismissed: true } : {}),
        }
      })
    },

    async dismiss(): Promise<void> {
      const today = localDateStr(now())
      await enqueueWrite(async () => {
        const data = await loadBriefFile(opts.file, today)
        if (data.date !== today) return // 划的是昨天那张,不该影响今天
        data.dismissed = true
        await saveBriefFile(opts.file, data)
      })
    },
  }
}
