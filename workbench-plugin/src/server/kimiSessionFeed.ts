/**
 * Kimi 会话状态接入(2026-09-02,Ben 拍板的规范修订,详见交接-0902 §三.4)。
 *
 * **数据源是 Kimi 桌面版,不是命令行版**(2026-09-02 真机纠错):第一版盯的是
 * `~/.kimi-code`(kimi-code CLI 的会话日志),但 Ben 日常用的是 Kimi.app——他那边
 * 跑了十分钟,`~/.kimi-code` 一个字节都没动过,标签自然一直空着。桌面版把状态写在
 * `~/Library/Application Support/kimi-desktop/kimi-agent/` 下:
 *
 * - `conversation-statuses.json`:会话 id → `running` / `blocked` / `completed`;
 * - `conversation-context-usage.json`:同一批 id → `updatedAt`(ISO)、模型、上下文用量。
 *
 * 这比 CLI 那条路好:**有真状态,不用拿 mtime 猜**。三态直接落到工作台的语义上——
 * `running`→在跑(白点)、`blocked`→等你确认(黄点)、`completed`→完成(蓝点)。
 *
 * **这是全仓库第一条显式获准的轮询**:Kimi 完全没有 hook(对照 hooks.ts 头部的三家
 * 能力表),PRD §7.4 写明"若只能轮询,必须先修改规范再实施"——本文件是修订兑现,
 * 60 秒一轮,别的模块不得引用此处当"轮询也行"的先例。
 *
 * 不回放历史(与 codexSessionFeed 同一条纪律)**靠新鲜度一道门就够**:statuses 里躺着
 * 几十条历史 `completed`,但它们的 updatedAt 都是几十小时、几天前,被 idleOfflineMs
 * (默认 2 小时)挡在外面。新鲜的一律照报、状态是什么报什么——包括刚刚完成
 * (2026-09-02 真机教训:曾多加一道首次见到只报活跃态,结果把 Ben 那条 11 分钟前
 * 完成的会话整个漏掉,而它正是最该亮蓝点的一条)。已跟踪的变陈旧则转 offline 收尾。
 *
 * **标题与项目归属(2026-09-09 接上)**:来自 daimon 的 conversations.sqlite(kimiConversations.ts,
 * 调研见 docs/superpowers/research/2026-09-09-Kimi桌面版标题与归属.md),键与上面两份 JSON 一致。
 * 这条路是**请求驱动**的:只有这轮真有要报的会话才去 `readConversations()` 一次(读库那边
 * 还有自己的限频窗),空闲轮一次都不读;offline 收尾也不读。标题还没生成好的会话先不带标题报,
 * 记一个 `titlePending`,后面哪一轮标题到了就补报一次(状态没变也补),之后不再重复。
 * 库打不开/版本不对/没这条 → 与从前一模一样:短 id、归「未归类」,不抛、不编。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionStatus, WorkbenchEvent } from '../protocol.ts'
import type { KimiConversation } from './kimiConversations.ts'
import type { SessionDigest } from './sessionDigest.ts'
import { UNKNOWN_PROJECT } from './sessions.ts'

export interface KimiSessionFeedDeps {
  /** 读 conversation-statuses.json;文件不在/坏了返回 undefined。 */
  readStatuses: () => Promise<Record<string, unknown> | undefined>
  /** 读 conversation-context-usage.json(取 updatedAt);同上。 */
  readContextUsage: () => Promise<Record<string, unknown> | undefined>
  /**
   * conversation_key → 标题/工作区(kimiConversations.ts 的 lookup)。缺席或返回 undefined
   * 都退回"没有标题与归属"的现状;抛错同样按"这轮没拿到"处理。
   */
  readConversations?: () => ReadonlyMap<string, KimiConversation> | undefined
  /**
   * 读这条会话的记录文件(wire.jsonl)成人话:最近在做什么、没生成好标题时的第一句要求(2026-09-25,卡 P)。
   * 缺席(老用例)= 不读,事件与从前一模一样。
   */
  readDigest?: (file: string, name?: string) => Promise<SessionDigest | undefined>
}

export interface KimiSessionFeedOptions {
  applyEvent: (event: WorkbenchEvent) => void
  /** 当前 Unix 秒。 */
  now?: () => number
  /** 轮询间隔,默认 60 秒(规范修订批准的刻度)。 */
  intervalMs?: number
  /** 多久没更新就算这条会话结束了,默认 2 小时(与 codexSessionFeed 同刻度)。 */
  idleOfflineMs?: number
  /** cwd → 项目名(index.ts 接 resolveCodexProject:Git common root + 项目/目录规则)。拿不到就交给 sessions.ts 按 cwd 末段推。 */
  resolveProject?: (cwd: string) => Promise<string | undefined>
  /** 读到一条会话的记录文件就登记一下(2026-09-25,卡 P):点开看详情时按会话 id 找文件。 */
  onFile?: (sessionId: string, filePath: string, name?: string) => void
}

export interface KimiSessionFeed {
  stop: () => void
}

/** 桌面版的三态 → 工作台会话状态。认不出的状态整条丢掉,不猜(D13)。 */
function mapStatus(raw: unknown): SessionStatus | undefined {
  if (raw === 'running') return 'running'
  if (raw === 'blocked') return 'waiting'
  if (raw === 'completed') return 'done'
  return undefined
}

/**
 * **Kimi 的 `blocked` 到底是不是「在等你」,以记录文件为准**(2026-09-27,卡 LK)。
 *
 * 真机现场(维护者 21:2x 那一通):事务官说 Kimi「弹了个框等你点」「在等他回话」——
 * 而 Kimi 那条对话跑了一整天,那一刻它的 `wire.jsonl` 还在长(21:31 还在写)。
 * 根因:桌面版 `conversation-statuses.json` 里写的是 `blocked`,我们原来**照字面**
 * 翻成「等你确认」。`blocked` 在 Kimi 那边包含「这一步被挡着」的各种情形,
 * 不等于「停下来在问你」。
 *
 * **2026-09-28,卡 KM 收紧一格**:维护者「我发现 Kimi 每次都是待确认」—— 那条对话它一段总结交代完了、
 * 没弹任何框,坞上还是橙色的「1」。真机取证:`conversation-statuses.json` 里**这一轮说完就记 `blocked`**
 * (其余历史条目才是 `completed`)。所以 `blocked` 连「形式上等你」都不是,它只是「没 completed」。
 * 判据变成一句:**找得到真的待批/待答请求才算等你,找不到就是这一轮说完了**。
 *
 * - 记录里**明写着形式等待**(`ApprovalRequest` / `QuestionRequest` → `formal_wait`)→ 真的在等你;
 * - 记录里最后一条是**它在干活**(`mark === 'working'`)、或**最后一句是他说的**(`mark === 'asked'`,
 *   球在 Kimi 那边)→ 在跑;
 * - 其余(说完一轮 `ended`、认不出、连记录都读不到)→ **`done`,做完未读(蓝点)**:
 *   没有证据就不说「等你确认」(D13 —— 不猜的意思是不编一个框,不是照抄它那个字)。
 *   它这一轮末尾顺口问的那一句另有去处:卡 T 按内容判出来的 `ask`(不占运行状态,见 waitingForYou)。
 *
 * 只动 `blocked` 这一个字。`running` / `completed` 是它自己说得清的,不碰。
 */
export function resolveKimiStatus(raw: SessionStatus, digest: SessionDigest | undefined): SessionStatus {
  if (raw !== 'waiting') return raw
  if (digest?.formal_wait !== undefined) return 'waiting'
  if (digest?.mark === 'working' || digest?.mark === 'asked') return 'running'
  return 'done'
}

/** `agent:main:main:conversation:<uuid>` → `<uuid>`。认不出形状就原样用,不丢会话。 */
function conversationId(key: string): string {
  return key.split(':').pop() ?? key
}

export function startKimiSessionFeed(
  deps: KimiSessionFeedDeps,
  options: KimiSessionFeedOptions,
): KimiSessionFeed {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const intervalMs = options.intervalMs ?? 60_000
  const idleOfflineMs = options.idleOfflineMs ?? 7_200_000
  /**
   * 会话 id → 上次见到的指纹(状态+更新时刻)、"我们有没有为它出过声"、
   * 以及"报的时候标题还没生成好"(有 reader 才可能为 true)。
   */
  const seen = new Map<string, { fingerprint: string, emitted: boolean, titlePending: boolean }>()
  let stopped = false
  let ticking = false

  function emitOffline(id: string): void {
    options.applyEvent({
      agent: 'kimi',
      session_id: id,
      // offline 留空归属,沿用上一次已知值(先例见 codexSessionFeed.sweep)。
      project: '',
      type: 'offline',
      ts: now(),
    })
  }

  async function emit(id: string, type: SessionStatus, tsSec: number, info: KimiConversation | undefined): Promise<void> {
    let project: string | undefined
    if (info?.cwd !== undefined && options.resolveProject !== undefined) {
      try {
        project = await options.resolveProject(info.cwd)
      }
      catch {
        project = undefined // 归属失败不该让会话消失,cwd 照带,由 sessions.ts 按末段推。
      }
    }
    // 最近在做什么(2026-09-25,卡 P):有记录文件就读一眼尾巴;读不到就不带,界面写「读不到它在做什么」。
    let digest: SessionDigest | undefined
    if (info?.records !== undefined) {
      options.onFile?.(id, info.records, info.title)
      if (deps.readDigest !== undefined) {
        try {
          digest = await deps.readDigest(info.records, info.title)
        }
        catch {
          digest = undefined
        }
      }
    }
    if (stopped) return
    const title = info?.title ?? digest?.title
    /**
     * 「最后一次动静」以记录文件末尾那一条为准(2026-09-27,卡 LK)。
     * `conversation-context-usage.json` 的 `updatedAt` 是**上下文用量**那一份的时刻,
     * 不一定跟着每一步走;记录文件每一步都在写。走 `output_ts` 那一格 ——
     * 它只管「多久没动静」,不动「跑了多久」。
     */
    const lastMs = digest?.last_at === undefined ? Number.NaN : Date.parse(digest.last_at)
    const outputTs = Number.isFinite(lastMs) ? Math.floor(lastMs / 1000) : undefined
    options.applyEvent({
      agent: 'kimi',
      session_id: id,
      // 有 cwd 但解析不出项目:不填 project,sessions.ts 会按 cwd 末段推;连 cwd 都没有才标「未归类」。
      ...(project !== undefined ? { project } : info?.cwd !== undefined ? {} : { project: UNKNOWN_PROJECT }),
      ...(info?.cwd === undefined ? {} : { cwd: info.cwd }),
      ...(title === undefined ? {} : { title }),
      ...(digest?.activity === undefined ? {} : { activity: digest.activity }),
      ...(digest?.formal_wait === undefined ? {} : { formal_wait: digest.formal_wait }),
      type: resolveKimiStatus(type, digest),
      ts: tsSec,
      ...(outputTs !== undefined && outputTs > tsSec ? { output_ts: outputTs } : {}),
    })
  }

  async function tick(): Promise<void> {
    if (stopped || ticking) return
    ticking = true
    try {
      const statuses = await deps.readStatuses()
      if (statuses === undefined) return
      const usage = await deps.readContextUsage() ?? {}
      const logicalMs = now() * 1000

      // 请求驱动:这轮第一条真要报的会话才去读库,读一次全轮共用;空闲轮一次都不读。
      const hasReader = deps.readConversations !== undefined
      let conversations: ReadonlyMap<string, KimiConversation> | undefined
      let conversationsLoaded = false
      const lookupConversation = (key: string): KimiConversation | undefined => {
        if (!conversationsLoaded) {
          conversationsLoaded = true
          try {
            conversations = deps.readConversations?.()
          }
          catch {
            conversations = undefined // 库正被 checkpoint(SQLITE_BUSY)之类:这轮没拿到,不抛。
          }
        }
        return conversations?.get(key)
      }

      const liveIds = new Set<string>()
      for (const [key, rawStatus] of Object.entries(statuses)) {
        if (stopped) return
        const type = mapStatus(rawStatus)
        if (type === undefined) continue
        const id = conversationId(key)
        liveIds.add(id)

        const entry = usage[key]
        const updatedAt = typeof entry === 'object' && entry !== null
          ? (entry as { updatedAt?: unknown }).updatedAt
          : undefined
        const updatedMs = typeof updatedAt === 'string' ? Date.parse(updatedAt) : Number.NaN
        const hasTime = Number.isFinite(updatedMs)
        const fresh = hasTime && logicalMs - updatedMs <= idleOfflineMs
        const fingerprint = `${String(rawStatus)}|${hasTime ? updatedMs : 'no-time'}`
        const prev = seen.get(id)

        if (!fresh) {
          // 陈旧:已经为它出过声的收个尾,没出过声的(几十条历史 completed)只记不报。
          if (prev?.emitted === true) emitOffline(id)
          seen.set(id, { fingerprint, emitted: false, titlePending: false })
          continue
        }

        const changed = prev === undefined || prev.fingerprint !== fingerprint
        if (!changed && prev.titlePending !== true) continue

        const info = lookupConversation(key)
        // 状态没变、只是在等标题:标题还没到就再等一轮,别重复报。
        if (!changed && info?.title === undefined) continue

        // 新鲜就报,状态是什么报什么(2026-09-02 真机修正)。
        // 原来这里对"首次见到"多加了一道"只报活跃态"的限制,想挡住那几十条历史
        // completed——**多余且有害**:历史本来就被上面的新鲜度门挡住了(实测都是
        // 52 小时、13 天前的),这条规则实际挡掉的是"刚刚完成、正等你验收"那一条,
        // 恰恰最该亮蓝点。Ben 的会话 13:29 完成、13:40 重启,就这么被漏掉了。
        await emit(id, type, Math.floor(updatedMs / 1000), info)
        if (stopped) return
        seen.set(id, { fingerprint, emitted: true, titlePending: hasReader && info?.title === undefined })
      }

      // 从 statuses 里整个消失的(会话被删),已出过声的收尾。
      for (const [id, state] of [...seen]) {
        if (liveIds.has(id)) continue
        if (state.emitted) emitOffline(id)
        seen.delete(id)
      }
    }
    finally {
      ticking = false
    }
  }

  void tick()
  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

/** 生产用 deps:Kimi 桌面版的 kimi-agent 状态目录。读坏/读不到一律 undefined,不抛。 */
export function defaultKimiSessionFeedDeps(agentDir: string): KimiSessionFeedDeps {
  const readJson = async (name: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(agentDir, name), 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
    }
    catch {
      return undefined // 没装 Kimi 桌面版/文件正被重写,都按"这轮没读到"处理。
    }
  }
  return {
    readStatuses: () => readJson('conversation-statuses.json'),
    readContextUsage: () => readJson('conversation-context-usage.json'),
  }
}

/** 默认状态目录:~/Library/Application Support/kimi-desktop/kimi-agent。 */
export function defaultKimiAgentDir(home: string): string {
  return join(home, 'Library', 'Application Support', 'kimi-desktop', 'kimi-agent')
}
