/**
 * Codex 会话状态接入：把 `~/.codex/sessions` 的文件写入事件翻成工作台事件。
 *
 * fs.watch 只负责通知“文件有新写入”，短去抖后读取整份 rollout；会话边界、来源过滤、
 * 标题回退和生命周期判断都集中在 codexRollout.ts。没有结束事件时不猜 done。
 * 启动时不回放历史，避免旧会话在插件启动时伪装成新活动。
 */
import { watch as fsWatch } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkbenchEvent } from '../protocol.ts'
import { ROLLOUT_GAP_LINE, parseCodexRollout } from './codexRollout.ts'
import type { CodexRolloutEvent } from './codexRollout.ts'
import { codexActiveRollouts } from './codexThreadIndex.ts'
import { digestCodex } from './sessionDigest.ts'
import { UNKNOWN_PROJECT } from './sessions.ts'

export interface CodexSessionFeedDeps {
  watch: (
    dir: string,
    listener: (eventType: string, filename: string | null) => void,
  ) => { close: () => void, unref?: () => void }
  /** 读一份完整 rollout；文件删除/移动时由调用方忽略本次事件。 */
  readRollout: (filePath: string) => Promise<string>
  /** 读整份 `session_index.jsonl` 的文本；文件不存在时返回空字符串。 */
  readSessionIndex: () => Promise<string>
  /**
   * 查文件 mtime(毫秒);文件没了返回 undefined。reconcile 的空闲收尾与发现路径靠它,
   * 缺省(老测试没传)时这两条路整个不启用,既有用例行为不变。
   */
  statMtimeMs?: (filePath: string) => Promise<number | undefined>
  /**
   * 列出"最近两天日期目录"下的 rollout 路径(2026-09-02 真机铁证:macOS 递归 watch
   * 的目录事件可能不带文件名,onFsEvent 的兜底只能重读**认识的**文件——当天新会话
   * 整天缺席)。只在 reconcile 里请求驱动地调用,不是常驻轮询。
   */
  listRecentRollouts?: () => Promise<string[]>
}

export interface CodexSessionFeedOptions {
  codexHome: string
  /** 吃进一条上报——生产传 `service.applyEvent`。 */
  applyEvent: (event: WorkbenchEvent) => void
  /** 当前 Unix 秒；rollout 没有可解析时间戳时作为接收时间兜底。 */
  now?: () => number
  /** 写入事件的短去抖窗口，默认 500ms。 */
  debounceMs?: number
  /** 去抖读取后的收尾确认重读间隔，默认 2000ms（见 handleFileWrite 上方注释）。 */
  confirmMs?: number
  /** reconcile() 对同一文件两次读取的最短间隔，默认 15000ms（见 reconcile 注释）。 */
  reconcileMinMs?: number
  /**
   * 空闲收尾阈值(毫秒),默认 2 小时(2026-09-02 Ben 拍板:「rollout 文件超过 2 小时
   * 没动就当会话已结束」)。Codex 没有结束事件,done/error/running 都可能永远滞留——
   * 白点只进不出,标签上攒了 8 白 1 红全是十几小时前的老会话。超过阈值没动的文件由
   * reconcile 补发一条 offline;同一阈值也用作发现路径的「新鲜度」门(闲过头的未知
   * 文件不回放,与「启动不回放历史」同一条纪律)。
   */
  idleOfflineMs?: number
  /** 用可验证 Git/目录证据解析项目；缺证据时显式返回「未归类」。 */
  resolveProject?: (cwd: string) => Promise<string | undefined>
  /** 读到一条会话的文件就登记一下(2026-09-25,卡 P):点开看详情时按会话 id 找文件。 */
  onFile?: (sessionId: string, filePath: string, name?: string) => void
}

/** 按 id 查 `session_index.jsonl` 里的 thread_name；索引坏行不影响其余标题。 */
function lookupThreadName(indexText: string, id: string): string | undefined {
  for (const line of indexText.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as { id?: unknown, thread_name?: unknown }
      if (row.id === id && typeof row.thread_name === 'string' && row.thread_name !== '') {
        return row.thread_name
      }
    }
    catch {
      // 逐行容错：一行坏索引不能遮蔽后续合法标题。
    }
  }
  return undefined
}

export interface CodexSessionFeed {
  stop: () => void
  /**
   * 请求驱动的对账:对所有"最后一次上报还是 running"的 rollout 安排一次限频重读。
   * 由 GET /state 的组装路径调用——跟 badges/machine/calendar 的"请求驱动 + min-interval"
   * 是同一条纪律,不是常驻轮询:没人看工作台就一次都不会读。
   *
   * 为什么需要它(2026-08-26 真机铁证):task_complete 10:55:18 落盘后,FSEvents 对
   * **所有**监听进程(包括独立探针)整整静默到 11:00:58 才倾泻积压事件——完成状态因此
   * 晚了 5 分 39 秒。事件层整段熄火时,收尾确认(它以收到过事件为前提)也无从触发,
   * 只有"有人在看"这个真实需求能兜底。终态(done/error/offline)文件不在对账范围,
   * 正在跑的通常只有一两个,15s 限频下成本可忽略。
   */
  reconcile: () => void
}

export function startCodexSessionFeed(
  deps: CodexSessionFeedDeps,
  options: CodexSessionFeedOptions,
): CodexSessionFeed {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const debounceMs = options.debounceMs ?? 500
  const confirmMs = options.confirmMs ?? 2000
  const reconcileMinMs = options.reconcileMinMs ?? 15_000
  const idleOfflineMs = options.idleOfflineMs ?? 7_200_000
  const fileDebounce = new Map<string, ReturnType<typeof setTimeout>>()
  const confirmTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // 每个文件最近一次真正上报过的事件指纹与状态——收尾确认重读时靠指纹判断"内容有没有变",
  // reconcile 靠 type 判断"还在不在跑"。指纹必须把 title 算进去:持续写入的会话靠反复
  // 重读把迟到的 user_message/thread_name 补成标题(见 scheduleRead 的固定窗口注释),
  // 只比 type/ts 会把标题更新也当成"没变"吞掉。
  const lastApplied = new Map<string, { fingerprint: string, type: string, sessionId: string }>()
  // 每个文件最近一次实际读取的时刻(毫秒),reconcile 的限频依据。
  const lastReadAt = new Map<string, number>()
  // sweep(发现+空闲收尾)上次真正跑过的时刻(毫秒),同 reconcileMinMs 限频。
  let lastSweepAt = 0
  /** 每个文件上次在 sweep 里见到的 mtime——用来发现"终态文件又被写了"(见 sweep 内注释)。 */
  const lastMtimeSeen = new Map<string, number>()
  let stopped = false

  /**
   * 读一次 rollout 并上报;返回"这次是否上报了新内容"。
   *
   * 收尾确认(2026-08-26 真机根因,两条 Codex 会话双双卡死 running 实证):任务收尾的
   * 最后一笔写入(task_complete/turn_aborted)往往是这一阵写入的**绝笔**——它的 fs 事件
   * 要么被 FSEvents 合并进已被去抖窗口丢弃的批次,要么去抖读取恰好采样在这笔落盘之前
   * (readRollout 先 stat 后读,天然有这道缝)。之后文件再无写入、再无事件,没有任何
   * 机会重读,会话就永远卡在 running——直到下一次有人碰这个文件。所以每次去抖读取完成后
   * 由 scheduleConfirm 安排**一次**收尾重读;重读发现内容变了(说明确实有事件丢了)才再
   * 续一次,内容没变就到此为止。链条根在真实的 fs 事件上、静默即终止,不是常驻轮询。
   */
  async function handleFileWrite(filePath: string): Promise<boolean> {
    if (stopped) return false
    lastReadAt.set(filePath, Date.now())
    // 读之前先记下这一刻的 mtime 当基线:sweep 靠"mtime 比基线前进了"判断
    // "这个文件在我们读过之后又被写了"(见 sweep 里那段注释)。放在读之前而不是之后,
    // 宁可基线偏旧——偏旧最多多读一次,偏新会把真正的新写入漏掉。
    if (deps.statMtimeMs !== undefined) {
      try {
        const mtime = await deps.statMtimeMs(filePath)
        if (mtime !== undefined) lastMtimeSeen.set(filePath, mtime)
      }
      catch {
        // 记不到基线不影响这次读取本身。
      }
    }
    let text: string
    try {
      text = await deps.readRollout(filePath)
    }
    catch {
      // 文件可能在事件触发和读取之间被删掉/挪走了，忽略本次事件。
      return false
    }
    if (stopped) return false

    const snapshot = parseCodexRollout(text)
    if (snapshot === undefined || snapshot.event === undefined) return false

    let indexText: string
    try {
      indexText = await deps.readSessionIndex()
    }
    catch {
      indexText = ''
    }
    if (stopped) return false
    const threadName = lookupThreadName(indexText, snapshot.id)
    // 标题与最近在做什么(2026-09-25,卡 P):同一份文字再读成人话。标题 = Codex 自己的线程名;
    // 没有就第一句要求的前 20 来字(新版会话文件里那句在 item_completed 里,老的 fallbackTitle 读不到)。
    const digest = digestCodex({ head: text, tail: text, ...(threadName === undefined ? {} : { name: threadName }) })
    const title = threadName ?? digest.title ?? snapshot.fallbackTitle
    const activity = digest.activity
    options.onFile?.(snapshot.id, filePath, threadName)

    /**
     * **状态跨过缺口沿用上一次已知的那个**(2026-09-27,卡 LK)。
     *
     * 大文件只读头尾两段,真正最后那条生命周期事件可能落在中间(他那条 23MB 的对话里
     * 离文件尾 4.1MB)。那时 `snapshot.event` 是**头上**捡的一条,不是最后一条 ——
     * 而我们一直在盯这个文件,上一次上报的状态是它还在尾巴里时读到的,比头上那条新。
     * 所以:缺口前捡来的状态,一律让上一次已知的那个盖过去(D13:宁可用旧的真话,不用新的假话)。
     */
    const previous = lastApplied.get(filePath)
    const event: CodexRolloutEvent = snapshot.eventFromHead === true && previous !== undefined && previous.type !== 'offline'
      // 时刻照旧用头上那条的(状态没变 → applyEvent 不会重算计时);
      // **不能让它落到 now()**,否则「最后一次动静」会被说成「刚刚」。
      ? { type: previous.type as CodexRolloutEvent['type'], ...(snapshot.event.ts === undefined ? {} : { ts: snapshot.event.ts }) }
      : snapshot.event

    /**
     * **「最后一次动静」跟文件走,不跟生命周期事件走**(2026-09-27,卡 LK):
     * 一条在跑的对话四个小时里不会再有一条 `task_started`,但每一步都在写 `item_completed`。
     */
    const outputTs = snapshot.lastTs
    // 指纹带上「在做什么」与「最后一次动静」:它们变了也要报一次(状态没变、标题没变,只是它又往前走了一步)。
    const fingerprint = [snapshot.id, event.type, event.reason ?? '', event.ts ?? '', outputTs ?? '', title ?? '', activity?.line ?? '', activity?.at ?? ''].join('|')
    if (lastApplied.get(filePath)?.fingerprint === fingerprint) return false

    let project: string | undefined
    if (snapshot.cwd !== undefined && options.resolveProject !== undefined) {
      try {
        project = await options.resolveProject(snapshot.cwd)
      }
      catch {
        project = undefined
      }
    }
    if (stopped) return false

    lastApplied.set(filePath, { fingerprint, type: event.type, sessionId: snapshot.id })
    options.applyEvent({
      agent: 'codex',
      session_id: snapshot.id,
      project: project ?? UNKNOWN_PROJECT,
      ...(snapshot.cwd === undefined ? {} : { cwd: snapshot.cwd }),
      type: event.type,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...(title === undefined ? {} : { title }),
      ...(activity === undefined ? {} : { activity }),
      ts: event.ts ?? now(),
      // 比状态那一刻新才带上(带的是同一个数就不必多一格,老用例的事件形状也不变)。
      ...(outputTs !== undefined && outputTs > (event.ts ?? 0) ? { output_ts: outputTs } : {}),
    })
    return true
  }

  /** 安排一次收尾确认重读;读到新内容才续一次,否则链条终止。同文件重复安排时后到覆盖先到。 */
  function scheduleConfirm(filePath: string): void {
    if (stopped) return
    const existing = confirmTimers.get(filePath)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      confirmTimers.delete(filePath)
      void handleFileWrite(filePath).then((changed) => {
        if (changed) scheduleConfirm(filePath)
      })
    }, confirmMs)
    timer.unref?.()
    confirmTimers.set(filePath, timer)
  }

  /** 给一个具体文件安排去抖读取(完成后自带一次收尾确认)。同文件已有去抖窗口时忽略。 */
  function scheduleRead(filePath: string): void {
    const existing = fileDebounce.get(filePath)
    // 固定窗口而不是每次写入都重置：长会话持续输出时也要定期重读，
    // 否则首个 task_started 之后的 user_message 永远等不到静默窗口，标题会一直空着。
    if (existing !== undefined) return
    // 新的去抖读取会在完成后自己安排收尾确认,先把旧的确认取消掉,别叠着读两遍。
    const pendingConfirm = confirmTimers.get(filePath)
    if (pendingConfirm !== undefined) {
      clearTimeout(pendingConfirm)
      confirmTimers.delete(filePath)
    }
    const timer = setTimeout(() => {
      fileDebounce.delete(filePath)
      void handleFileWrite(filePath).then(() => scheduleConfirm(filePath))
    }, debounceMs)
    timer.unref?.()
    fileDebounce.set(filePath, timer)
  }

  function onFsEvent(_eventType: string, filename: string | null): void {
    if (stopped) return
    // Node 文档明说:macOS 上(尤其递归 watch)事件可能不带文件名。原来这里一律丢弃——
    // 等于把"sessions/ 下有东西变了,但不知道是哪个"这条真实信号扔掉。诚实的解释是:
    // 凡是我们已经认识的 rollout 都可能就是变的那个,全部安排一次去抖重读(去抖 + 指纹
    // 去重兜住成本:没变的文件读一次、一条都不会重复上报)。没见过的新文件确实救不回来,
    // 但新会话总会伴随大量带名事件,实际观察里从没缺席过。
    if (filename === null) {
      for (const knownFile of lastApplied.keys()) scheduleRead(knownFile)
      return
    }
    if (!filename.endsWith('.jsonl')) return
    scheduleRead(join(options.codexHome, 'sessions', filename))
  }

  const watcher = deps.watch(join(options.codexHome, 'sessions'), onFsEvent)
  watcher.unref?.()

  return {
    stop() {
      stopped = true
      watcher.close()
      for (const timer of fileDebounce.values()) clearTimeout(timer)
      fileDebounce.clear()
      for (const timer of confirmTimers.values()) clearTimeout(timer)
      confirmTimers.clear()
    },
    reconcile() {
      if (stopped) return
      const nowMs = Date.now()
      for (const [filePath, applied] of lastApplied) {
        if (applied.type !== 'running') continue // 终态文件不对账,不会有"完成事件还在路上"
        if (nowMs - (lastReadAt.get(filePath) ?? 0) < reconcileMinMs) continue
        scheduleRead(filePath)
      }
      // 发现 + 空闲收尾(2026-09-02):同样请求驱动、同样限频,失败静默——sweep 内部
      // 自己兜错,不能让一次 stat 失败把 reconcile 的既有职责连累了。
      void sweep(nowMs).catch(() => {})
    },
  }

  /**
   * 发现与空闲收尾(2026-09-02,Ben 拍板语义):
   * - **空闲收尾**:已上报过、还没 offline 的会话,文件超过 idleOfflineMs 没动(或文件
   *   没了)就补发一条 offline——白点/红点从此有出口。事件的 project 留空,让
   *   sessions.ts 沿用上一次已知值,别把已归类的会话冲回「未归类」。
   * - **发现**:最近两天目录里出现了 lastApplied 不认识、mtime 又新鲜(空闲未超阈)的
   *   rollout → 安排一次常规读取。这是 macOS 递归 watch 目录事件丢文件名的兜底——
   *   onFsEvent 那条只能重读认识的文件,当天新会话可能整天缺席(真机实证)。
   * 两条都吃 statMtimeMs 依赖;没提供(老测试)就整个不启用。
   */
  async function sweep(nowMs: number): Promise<void> {
    if (deps.statMtimeMs === undefined) return
    if (nowMs - lastSweepAt < reconcileMinMs) return
    lastSweepAt = nowMs
    // 空闲判定用注入时钟(now() 秒),不用 Date.now()——测试的 mtime 都按逻辑时钟造。
    const logicalMs = now() * 1000

    for (const [filePath, applied] of [...lastApplied]) {
      if (stopped) return
      let mtime: number | undefined
      try {
        mtime = await deps.statMtimeMs(filePath)
      }
      catch {
        continue
      }
      const idle = mtime === undefined ? Number.POSITIVE_INFINITY : logicalMs - mtime
      // 已闲成 offline 的也要比这一下:她闲两小时回来接着用同一条对话,文件又写了,
      // 这里不看的话唯一通路就是 fs 事件,它一丢,这条对话就一直挂着「掉线」。
      if (applied.type === 'offline') {
        if (mtime !== undefined && idle <= idleOfflineMs && mtime > (lastMtimeSeen.get(filePath) ?? mtime)) {
          scheduleRead(filePath)
        }
        continue
      }
      if (idle <= idleOfflineMs) {
        // 终态文件被重新写入(2026-09-02 真机:Mac 重启后 Codex 恢复 9/01 的旧会话并
        // 接着跑)。reconcile 的既有那条只重读 type==='running' 的文件,发现路径又跳过
        // 已知文件——**唯一通路是 fs 事件,而 macOS 上它不可靠**(0826 实证静默 5 分
        // 39 秒)。所以这里顺带比一次 mtime:比上次读取时前进了就重读一遍。
        // 只是 stat + 比大小,没有新增任何读文件的开销;没动的文件一个字节都不碰。
        // 基线在 handleFileWrite 里读文件前就记下了,这里只比大小:前进了就说明
        // 我们读过之后它又被写了,重读一遍。没动的文件一个字节都不碰。
        if (mtime !== undefined && mtime > (lastMtimeSeen.get(filePath) ?? mtime)) {
          scheduleRead(filePath)
        }
        continue
      }
      lastApplied.set(filePath, { ...applied, type: 'offline' })
      options.applyEvent({
        agent: 'codex',
        session_id: applied.sessionId,
        project: '',
        type: 'offline',
        ts: now(),
      })
    }

    if (deps.listRecentRollouts === undefined) return
    let candidates: string[]
    try {
      candidates = await deps.listRecentRollouts()
    }
    catch {
      return
    }
    for (const filePath of candidates) {
      if (stopped) return
      if (lastApplied.has(filePath) || fileDebounce.has(filePath)) continue
      let mtime: number | undefined
      try {
        mtime = await deps.statMtimeMs(filePath)
      }
      catch {
        continue
      }
      if (mtime === undefined) continue
      if (logicalMs - mtime > idleOfflineMs) continue // 闲过头的未知文件不回放
      scheduleRead(filePath)
    }
  }
}

/**
 * 发现路径回看多少天的日期目录(见 `listRecentRollouts` 上方注释)。
 * 一条对话的 rollout 一直写在**它开始那一天**的目录里,所以这个数就是"一条对话最长能连开几天
 * 还被发现路径认出来"。
 */
export const DISCOVER_DAYS = 30

/** 对话总表里回看多久内有动静的对话(新鲜度仍由 sweep 的 mtime 那道门把着)。 */
const ACTIVE_LOOKBACK_MS = 2 * 86_400_000

/** 生产用 deps：真实 fs.watch + fs/promises，与 quota/codexWatch.ts 同一套读法。 */
export function defaultCodexSessionFeedDeps(codexHome: string): CodexSessionFeedDeps {
  const headBytes = 256 * 1024
  const tailBytes = 256 * 1024
  return {
    watch: (dir, listener) => {
      try {
        return fsWatch(dir, { recursive: true }, listener)
      }
      catch {
        // 目录可能还不存在（没装 Codex），等价于监听不到任何事件。
        return { close: () => {} }
      }
    },
    readRollout: async (filePath) => {
      const handle = await open(filePath, 'r')
      try {
        const { size } = await handle.stat()
        if (size <= headBytes + tailBytes) return await handle.readFile('utf8')

        const head = Buffer.alloc(headBytes)
        const tail = Buffer.alloc(tailBytes)
        await handle.read(head, 0, head.length, 0)
        await handle.read(tail, 0, tail.length, size - tail.length)
        // 中间那一大段没读 —— 明说一句(见 codexRollout.ts 的 ROLLOUT_GAP_LINE):
        // 不说的话解析那头会把头上那条生命周期事件当成「最后一条」,状态与时刻全跟着错。
        return `${head.toString('utf8')}\n${ROLLOUT_GAP_LINE}\n${tail.toString('utf8')}`
      }
      finally {
        await handle.close()
      }
    },
    readSessionIndex: async () => {
      try {
        return await readFile(join(codexHome, 'session_index.jsonl'), 'utf8')
      }
      catch {
        return ''
      }
    },
    statMtimeMs: async (filePath) => {
      try {
        return (await stat(filePath)).mtimeMs
      }
      catch {
        return undefined
      }
    },
    /**
     * 列出"最近 {@link DISCOVER_DAYS} 天日期目录"下的 rollout 路径。
     *
     * 2026-09-27 真机根因(卡 CX,维护者:「codex 的运行中的数量也不对,现在应该是两条」):
     * 原来只列**今天和昨天**两个目录。Codex 的 rollout 文件名按**会话开始那一天**落目录,
     * 之后一直往同一个文件里追加——他那条 09-23 开的对话(`sessions/2026/09/23/rollout-…`)
     * 09-27 13:32 还在写,却永远不在这两个目录里,于是发现路径整整四天都看不见它;
     * 唯一的通路是 fs 事件,而 macOS 上它会丢文件名(onFsEvent 那一条只能重读**认识的**文件),
     * 结果这条真在跑的对话一条都没进 `/state.sessions`,数出来只有一条。
     *
     * 现在按日期目录名回看 {@link DISCOVER_DAYS} 天。**只 readdir、不读文件**:
     * 新鲜度照旧由 sweep 的 `statMtimeMs` + `idleOfflineMs` 那道门把着,闲过头的老文件不回放。
     * 为什么是 30 天而不是整棵树:整棵树近千个文件,每次 sweep 都要 stat 一遍;
     * 一条连开 30 天以上的对话是极端情况,真出现了它也会伴随带文件名的 fs 事件被认出来。
     */
    listRecentRollouts: async () => {
      const out: string[] = []
      for (let dayOffset = 0; dayOffset < DISCOVER_DAYS; dayOffset += 1) {
        const d = new Date(Date.now() - dayOffset * 86_400_000)
        const dir = join(
          codexHome, 'sessions',
          String(d.getFullYear()),
          String(d.getMonth() + 1).padStart(2, '0'),
          String(d.getDate()).padStart(2, '0'),
        )
        try {
          for (const name of await readdir(dir)) {
            if (name.endsWith('.jsonl')) out.push(join(dir, name))
          }
        }
        catch {
          // 那一天没开过 Codex、目录根本没建出来是常态,不算错。
        }
      }
      // 开得比 30 天还早、今天接着用的那条(10-08 真机:08-20 开的对话)—— 按 Codex 自己的对话总表补上。
      for (const path of codexActiveRollouts({ codexHome, sinceMs: Date.now() - ACTIVE_LOOKBACK_MS })) {
        if (!out.includes(path)) out.push(path)
      }
      return out
    },
  }
}
