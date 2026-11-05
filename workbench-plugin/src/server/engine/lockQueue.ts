/**
 * ★ **锁着屏时那几件活排的队**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
 *
 * 现场:2026-10-03 09:04 她在手机上给 Kimi 回了一句,电脑锁着屏 —— 窗口型的家起不出窗,
 * 那句话**就那么没了**(日志里只剩一行「一扇标准窗口都没有」)。10:30 她自己到电脑前重试才成。
 * 这一本就是「没了」改成「等着」:**她一解锁,按原顺序重送**。
 *
 * ## 三条纪律
 *
 * ① **落盘,重启不丢**(`~/.dsh/workbench/lock-queue.json`)。排着队的时候工作台可能被
 *    launchd 重启、可能热更新换版 —— 只在内存里就等于又「没了」一次。
 *    写盘失败**不许吞**:`persistError()` 一直说得出坏在哪,排不进去的当场说(调用方照它说实话)。
 * ② **原顺序**(先排的先送)。她连着答了三条,解锁之后的次序必须是她说话的次序。
 * ③ **同一句话只排一条**(去重的键见 {@link lockQueueKey};重送又撞上锁屏 = 原样留着,不排第二条、不丢)。
 *    排太久的自己过期({@link LOCK_QUEUE_TTL_MS})—— 隔了一天再把那句话送进去,比不送更糟。
 *
 * ## 为什么排的是 `Job` 而不是「那一条 HTTP 请求」
 *
 * `Job` 是契约(`engine/adapter.ts`),纯数据、落得了盘、重送就是再调一次 `Engine.run` ——
 * 送到照旧**落账**(`assigned → sent/seen`,引擎一处记)、照旧过闸、照旧换包换路。
 * 排「那一条请求」要把六条路由的 body 各存一份、重放时再把回包发给一个早就断了的连接,
 * 那是另一条管线(正是这条设计要删掉的东西)。
 *
 * **没搬过来的那一样**,`docs/交接-1003-锁屏时窗口型的家.md` 第二节写明:
 * 「捎话」在路由里送成之后会登记一条**回电**(`relayWatch.remember`),而那一步在 http 的闸里面 ——
 * 所以 {@link LockQueueDrainDeps.after} 留了一格,解锁重送成了之后由接线那一处补上它。
 */
import type { Job, JobResult } from './adapter.ts'

/** 排着队的一条。**没有她那句话以外的东西**:`Job` 本身就带着要送的字(落盘的也只有它)。 */
export interface LockQueueEntry {
  /** 排进来的时刻(ISO)。原顺序 = 这一格的先后。 */
  at: string
  /** 这一件(契约那份 `Job`,原样)。 */
  job: Job
  /** 解锁之后重送过几回(还撞上锁屏就加一,到 {@link LOCK_QUEUE_MAX_TRIES} 就丢并说一句)。 */
  tries: number
  /**
   * ★ **为什么排的**(2026-10-23,卡「捎话到没开着的会话留言等它醒」)。
   * `closed` = 那条会话没开着,留言等它醒;缺席 = 锁着屏那一路 / 老账。
   * 作废时(过期 / 到顶)据此说那一句(等它醒的那句留言要说「放了 12 小时…」;
   * 锁着屏那一路照旧不记 —— 那是另一张卡的事)。
   */
  reason?: LockQueueReason
}

/** 排着的那条是为什么排的。今天只有 `closed` 会传(锁屏那一路不传,老行为一字不变)。 */
export type LockQueueReason = 'locked' | 'closed'

/**
 * ★ **去重的键:哪一条会话 · 哪一种活 · 哪一句话**(2026-10-03)。
 *
 * **为什么不能只按 `Job.id`**(这一条是硬的,有用例钉着):会话那几条路的 `Job.id` 是
 * `jobKey.sessionJobId`(`session:<家>/<会话 id>`)—— 她往同一条 Kimi 会话里**连答两句**时
 * 两件活的 `id` 一模一样,按 `id` 去重就会**把她第二句话丢掉**。
 * 而「同一句话排两条」也不行(手机那一侧有幂等重试),所以键里要有那句话本身。
 */
export function lockQueueKey(job: Job): string {
  const item = dispatchItemOf(job)
  if (item !== undefined) return `dispatch\u0000${item}\u0000${job.family}`
  return `${job.id}\u0000${job.kind}\u0000${job.text}`
}

/**
 * ★ **派活的键是「这件事 + 派给哪家」**(2026-10-12,卡「锁屏派活排队」)。
 *
 * 与她那句话正相反:派活每派一次提示词都不一样(记号、规矩那一段会变),按字去重就会把同一件事排成两条、
 * 解锁后派出去两遍。而「同一件事给同一家派两遍」本来就不该有 —— 所以按事项 id + 家名,不按字、不按时间。
 * 没有事项 id 的派活不排(见 `Job.waitUnlock`),这里回 `undefined`。
 */
function dispatchItemOf(job: Job): string | undefined {
  if (job.kind !== 'dispatch') return undefined
  const item = job.itemId?.trim()
  return item === undefined || item === '' ? undefined : item
}

/** 排着的最多几条(她一晚上能答的条数远不到这个数;满了**丢最老的**并数得出丢了几条)。 */
export const LOCK_QUEUE_MAX = 50

/**
 * 排多久就不送了(毫秒)。
 *
 * 为什么要有这个数:隔了一天再把「嗯,就按这个来」送进一条她早就忘了的对话,
 * 比不送更糟 —— 到点了就丢,并且**说得出丢了几条**(`dropped()`),不装作送了。
 */
export const LOCK_QUEUE_TTL_MS = 12 * 60 * 60 * 1000

/** 同一件事解锁后最多重送几回(每回还撞上锁屏才算一回)。 */
export const LOCK_QUEUE_MAX_TRIES = 3

/** 落盘那两下(用例里换掉)。 */
export interface LockQueueIo {
  read: (file: string) => Promise<string | undefined>
  write: (file: string, text: string) => Promise<void>
}

export interface LockQueue {
  /**
   * 排一条(同一句话已经排着 = 不动它,回 `false`;同一件派活已经排着 = 换成这一次的交代,回 `true`)。
   * 回「排上了没有」—— **许了才许跟她说「解锁了我就送」**。
   *
   * `reason`(2026-10-23):等它醒的那一路传 `'closed'`(作废时据此记那一句);
   * 锁屏那一路不传,行为一字不变。
   */
  add: (job: Job, reason?: LockQueueReason) => boolean
  /**
   * ★ **同一件事别的手已经送成了:把排着的那条撤掉**(2026-10-12)。回「真撤掉了一条没有」(撤了才记那一行)。
   * 键同 {@link lockQueueKey}(派活 = 事项 id + 家名)。
   */
  withdraw: (job: Job) => boolean
  /** 排着的那几条(原顺序,副本)。 */
  list: () => readonly LockQueueEntry[]
  /** 送成了 / 过期了 / 到顶了 → 从队里拿掉(键见 {@link lockQueueKey})。 */
  drop: (key: string) => void
  /** 重送又撞上锁屏:回「还留着没有」(到顶了就丢,回 false)。 */
  retried: (key: string) => boolean
  /** 起服务时把盘上那本读回来(没有文件 = 空队)。 */
  load: () => Promise<void>
  /** 等落盘走完;上一次写盘坏了就抛。 */
  flush: () => Promise<void>
  /** 上一次写盘坏在哪(原话);`undefined` = 盘上这本是全的。 */
  persistError: () => string | undefined
  /** 过期 / 满了 / 到顶了一共丢过几条(丢了就说)。 */
  dropped: () => number
}

/** 这本队落在哪(与账、看板同一个目录)。 */
export function defaultLockQueueFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/lock-queue.json`
}

/** 盘上那一段 → 几条排着的(读不懂的那几条丢掉,整本不受带累)。 */
export function parseLockQueue(text: string | undefined): LockQueueEntry[] {
  if (text === undefined || text.trim() === '') return []
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { return [] }
  const rows = Array.isArray(raw) ? raw : (raw as { queue?: unknown })?.queue
  if (!Array.isArray(rows)) return []
  const out: LockQueueEntry[] = []
  for (const one of rows) {
    if (typeof one !== 'object' || one === null) continue
    const row = one as Record<string, unknown>
    const job = row.job
    if (typeof job !== 'object' || job === null) continue
    const typed = job as Partial<Job>
    // 认得出是一件活才留:四格缺一格都重送不出去(不猜一个)。
    if (typeof typed.id !== 'string' || typed.id === '') continue
    if (typeof typed.family !== 'string' || typed.family === '') continue
    if (typeof typed.kind !== 'string' || typeof typed.text !== 'string') continue
    if (typeof typed.target !== 'object' || typed.target === null) continue
    out.push({
      at: typeof row.at === 'string' && row.at !== '' ? row.at : new Date(0).toISOString(),
      job: job as Job,
      tries: typeof row.tries === 'number' && Number.isFinite(row.tries) ? row.tries : 0,
      ...(row.reason === 'closed' || row.reason === 'locked' ? { reason: row.reason as LockQueueReason } : {}),
    })
  }
  return out
}

/** 队里自己丢掉一条的那三种缘由。 */
export type LockDropWhy = 'expired' | 'overflow' | 'tries'

export function createLockQueue(options?: {
  file?: string
  io?: LockQueueIo
  now?: () => Date
  max?: number
  ttlMs?: number
  maxTries?: number
  /**
   * 队里**自己**丢掉一条时报一声(过期 / 满了丢最老的 / 重送到顶;2026-10-12)。
   * 派活据此把卡上「解锁就送」那一格摘掉 —— 不许留一个不会兑现的诺。送成 / 撤掉那几下不报(那是调用方自己拿掉的)。
   */
  onDrop?: (row: LockQueueEntry, why: LockDropWhy) => void
}): LockQueue {
  const now = options?.now ?? (() => new Date())
  const file = options?.file
  const io = options?.io ?? nodeLockQueueIo()
  const max = options?.max ?? LOCK_QUEUE_MAX
  const ttlMs = options?.ttlMs ?? LOCK_QUEUE_TTL_MS
  const maxTries = options?.maxTries ?? LOCK_QUEUE_MAX_TRIES
  let queue: LockQueueEntry[] = []
  let dropped = 0
  let persistError: string | undefined
  let chain: Promise<void> = Promise.resolve()
  const told = (row: LockQueueEntry, why: LockDropWhy): void => {
    try { options?.onDrop?.(row, why) }
    catch { /* 报一声出错不许带累这本队 */ }
  }

  /** 整本重写(这本队很小:最多 {@link LOCK_QUEUE_MAX} 条)。**坏了不吞**。 */
  function persist(): void {
    if (file === undefined) return
    chain = chain.then(async () => {
      await io.write(file, `${JSON.stringify({ queue }, null, 2)}\n`)
      persistError = undefined
    }, async (error: unknown) => {
      persistError = error instanceof Error ? error.message : String(error)
    }).catch((error: unknown) => {
      persistError = error instanceof Error ? error.message : String(error)
    })
  }

  /** 过期的先丢(每次动队之前走一遍)。 */
  function expire(): void {
    const nowMs = now().getTime()
    const kept = queue.filter(one => nowMs - Date.parse(one.at) < ttlMs || Number.isNaN(Date.parse(one.at)))
    if (kept.length !== queue.length) {
      for (const one of queue) if (!kept.includes(one)) told(one, 'expired')
      dropped += queue.length - kept.length
      queue = kept
    }
  }

  return {
    add(job, reason) {
      expire()
      const key = lockQueueKey(job)
      const same = queue.find(one => lockQueueKey(one.job) === key)
      /*
       * ★ 同一件派活又来一次(她又点了一下 / 解锁重派又撞上锁屏):**换成这一次的交代**,
       * 排进来的时刻与重送回数不动(原顺序不变、到顶照旧会停),回「排着」—— 它确实排着。
       * 她那句话照老规矩:同一句已经排着 = 不动、回 false。
       */
      if (same !== undefined && dispatchItemOf(job) !== undefined) {
        same.job = job
        // 为什么排的跟着最初那一下(换交代不改缘由;老账 / 锁屏那一路缺席照旧)。
        if (reason !== undefined && same.reason === undefined) same.reason = reason
        persist()
        return true
      }
      if (same !== undefined) return false
      queue.push({ at: now().toISOString(), job, tries: 0, ...(reason === undefined ? {} : { reason }) })
      // 满了丢**最老的**(她最近说的那几句更要紧)。
      while (queue.length > max) {
        const gone = queue.shift()
        if (gone !== undefined) told(gone, 'overflow')
        dropped += 1
      }
      persist()
      return true
    },
    list() { expire(); return queue.map(one => ({ ...one, job: { ...one.job } })) },
    withdraw(job) {
      const key = lockQueueKey(job)
      const kept = queue.filter(one => lockQueueKey(one.job) !== key)
      if (kept.length === queue.length) return false
      queue = kept
      persist()
      return true
    },
    drop(key) {
      const kept = queue.filter(one => lockQueueKey(one.job) !== key)
      if (kept.length === queue.length) return
      queue = kept
      persist()
    },
    retried(key) {
      const one = queue.find(row => lockQueueKey(row.job) === key)
      if (one === undefined) return false
      one.tries += 1
      if (one.tries >= maxTries) {
        queue = queue.filter(row => lockQueueKey(row.job) !== key)
        told(one, 'tries')
        dropped += 1
        persist()
        return false
      }
      persist()
      return true
    },
    async load() {
      if (file === undefined) return
      const text = await io.read(file).catch((error: unknown) => {
        persistError = error instanceof Error ? error.message : String(error)
        return undefined
      })
      const read = parseLockQueue(text)
      // 盘上的排在前面(它们比这一趟里新排的早),再按老规矩过期 + 封顶。
      queue = [...read, ...queue]
      expire()
      while (queue.length > max) { queue.shift(); dropped += 1 }
    },
    async flush() {
      await chain
      if (persistError !== undefined) throw new Error(persistError)
    },
    persistError() { return persistError },
    dropped() { return dropped },
  }
}

export function nodeLockQueueIo(): LockQueueIo {
  return {
    async read(file) {
      const { readFile } = await import('node:fs/promises')
      try { return await readFile(file, 'utf8') }
      catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return undefined
        throw error
      }
    },
    async write(file, text) {
      const { mkdir, rename, writeFile } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, file)
    },
  }
}

/**
 * ★ **两条连着重送之间隔多久**(毫秒)。
 *
 * 为什么非得有这个数(写这张卡时真撞上的):闸给「替她答 / 捎话」那几样的间隔是 **1.5 秒**
 * (`GATE_LIMITS.answer_send` / `relay_send`;键是**会话**,所以同一条会话里连着两句用的是同一个键)。
 * 重送那一轮要是一条接一条地发,**第二句必然撞上「离上一回太密」被闸拦下** ——
 * 而那一下回的是 `blocked`、不是 `screenLocked`,照「别的失败」办就把她第二句话**丢了**。
 * 所以隔开一点再送;另有一道保险:被闸拦下的那几条**留在队里**(见 {@link drainLockQueue})。
 */
export const LOCK_DRAIN_GAP_MS = 1600

export interface LockQueueDrainDeps {
  queue: LockQueue
  /** 重送就是再调一次引擎(落账、过闸、换包换路一样都不在这儿)。 */
  run: (job: Job) => Promise<JobResult>
  /** 两条之间隔多久(缺省 {@link LOCK_DRAIN_GAP_MS};用例里给 0)。 */
  gapMs?: number
  sleep?: (ms: number) => Promise<void>
  /**
   * 送完之后那一下(接线那一处补的:捎话送成了要登记一条**回电**)。
   * 缺席 = 不做(只重送、只落账)。抛了不影响这一条已经送出去的事实,只记一行。
   */
  after?: (job: Job, result: JobResult) => Promise<void>
  /** 记一行(缺席 = `console.log`)。 */
  warn?: (line: string) => void
  /**
   * ★ **重送之前问一句:这件事还在等吗**(2026-10-12,卡「锁屏派活排队」)。
   * 回一句话 = 不在等了(卡收了 / 换给别家 / 别的手已经派出去)→ 撤掉、**一下都不送**、记一行;
   * 回 `undefined` = 还在等,照常送。缺席 = 不问(老行为)。
   * 判据是卡上的事实(接线那一处给),**不按排了多久猜**。
   */
  stillWanted?: (job: Job) => Promise<string | undefined>
  /**
   * ★ **这一轮只送该送的那几条**(2026-10-23,卡「捎话到没开着的会话留言等它醒」)。
   * 回 false = 这一条还没到该送的时候(那条会话还睡着 / 不是这一拍管的路)→ **留在队里**,
   * 记进 `kept`,下一拍再看。缺席 = 全送(老行为一字不变)。
   * 巡登记表那一拍传它(「哪条会话的 socket 在了才送哪条」);解锁那一拍不传。
   */
  shouldSend?: (job: Job) => Promise<boolean>
  /** 这一轮开始记的那一行(缺席 = {@link LOCK_DRAIN_LOG}「解锁了…」;巡登记表那一拍传自己的)。 */
  log?: string
}

/** 这一轮重送的结果(给日志与用例看)。 */
export interface LockDrainReport {
  sent: number
  /** 还锁着 / 被闸拦下 / 还留着的那几条(**下一拍再来一轮**,见 `screenLockWatch`)。 */
  kept: number
  /** 送不出去(不是锁屏那一类)、从队里拿掉的那几条。 */
  failed: number
  /** 不在等了、撤掉没送的那几条(有才摆这一格)。 */
  withdrawn?: number
}

/** 排着的那条撤掉时记的那一行的头(断言照常量;引擎「别的手送成了」那一处也用它)。 */
export const LOCK_WITHDRAW_LOG = '[锁屏] 撤掉排着等解锁的那条'

/** 解锁了那一下记的那一行(断言照常量,不逐字抄中文)。 */
export const LOCK_DRAIN_LOG = '[锁屏] 解锁了,把排着的那几件按原顺序重送'

/**
 * ★ **她一解锁:按原顺序重送**(2026-10-03)。
 *
 * - **原顺序**:一条一条来(不并发 —— 并发送进同一家的几条对话会乱序,而那是她说话的次序),
 *   两条之间隔 {@link LOCK_DRAIN_GAP_MS}(理由见那个常量:闸的间隔);
 * - 送出去了(`confirmed` / `unconfirmed`)→ 从队里拿掉,{@link LockQueueDrainDeps.after} 补那一下;
 * - 还撞上锁屏(她又锁了 / 刚解锁那一瞬)→ **留着**(`retried` 计一回,到顶就丢并说一句);
 * - ★ **被闸拦下**(`blocked`:离上一回太密 / 这件事收场了)→ **也留着**:
 *   「太密」下一拍就不密了,「收场了」则会在到顶之后(3 回)自己丢掉 —— **不许当成送不出去而丢**;
 * - 别的失败(那扇窗上的事实:输入框没接住、它没装了)→ 拿掉:再排下去只会每次解锁都重撞一遍。
 */
export async function drainLockQueue(deps: LockQueueDrainDeps): Promise<LockDrainReport> {
  const warn = deps.warn ?? ((line: string) => { console.log(line) })
  const gapMs = deps.gapMs ?? LOCK_DRAIN_GAP_MS
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.() }))
  const rows = deps.queue.list()
  if (rows.length === 0) return { sent: 0, kept: 0, failed: 0 }
  warn(`${deps.log ?? LOCK_DRAIN_LOG}(${rows.length} 件)`)
  let sent = 0
  let kept = 0
  let failed = 0
  let withdrawn = 0
  let first = true
  for (const row of rows) {
    // 不在等了就撤掉(不送、不隔那 1.6 秒 —— 一个 op 都没发)。问的时候出错 = 不知道,照常送。
    const gone = await deps.stillWanted?.(row.job).catch(() => undefined)
    if (gone !== undefined) {
      deps.queue.drop(lockQueueKey(row.job))
      withdrawn += 1
      warn(`${LOCK_WITHDRAW_LOG}:${row.job.family} · ${gone}`)
      continue
    }
    /*
     * 这一拍只送该送的那几条(2026-10-23):巡登记表那一拍传 `shouldSend` ——
     * 哪条会话的 socket 在了才送哪条,还睡着的**留在队里**、计进 `kept`,下一拍再看。
     * 问的时候出错 = 不知道醒没醒,照「没醒」留着(不重送 —— 重送了也只是再撞「没开着」)。
     */
    if (deps.shouldSend !== undefined && !(await deps.shouldSend(row.job).catch(() => false))) {
      kept += 1
      continue
    }
    // 两条之间隔开(第一条不等);理由见 {@link LOCK_DRAIN_GAP_MS}。
    if (!first && gapMs > 0) await sleep(gapMs)
    first = false
    let out: JobResult
    try { out = await deps.run(row.job) }
    catch (error) {
      // 引擎按契约「绝不抛」,真抛了也不许把这一件丢掉:留着下一回解锁再送。
      warn(`[锁屏] ${row.job.family} 这一件重送时出错:${error instanceof Error ? error.message : String(error)}`)
      if (deps.queue.retried(lockQueueKey(row.job))) kept += 1
      else failed += 1
      continue
    }
    /*
     * 还锁着 / 那条会话还没开 / 或者**被闸拦下**:三种都留着。
     * 闸那一下尤其要紧 —— 她往同一条会话里连答了两句时,两件活在闸上是**同一个键**
     * (`jobKey.sessionJobId`),间隔 1.5 秒;真撞上了下一拍再来就过了。
     * 当成「送不出去」丢掉就等于把她第二句话丢了(这张卡的全部意思就是不丢)。
     *
     * ★ 2026-10-23(卡「捎话留言等它醒」):重送又撞上「那条会话没开着」(`sessionClosed`)
     * 也留着 —— 那一下多半是「登记表说有、送那一刻又没了」,下一拍再来就过了。
     */
    if (out.screenLocked === true || out.sessionClosed === true || out.blocked === true) {
      if (deps.queue.retried(lockQueueKey(row.job))) kept += 1
      else failed += 1
      continue
    }
    deps.queue.drop(lockQueueKey(row.job))
    if (out.delivered === 'not_sent') { failed += 1; continue }
    sent += 1
    if (deps.after !== undefined) {
      await deps.after(row.job, out).catch((error: unknown) => {
        warn(`[锁屏] ${row.job.family} 这一件送到了,可送完那一下没做成:${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
  return { sent, kept, failed, ...(withdrawn === 0 ? {} : { withdrawn }) }
}
