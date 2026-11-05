/**
 * Claude 会话:从会话文件跟着读(2026-09-02 起是「重启后捞回来」,2026-09-25 卡 P 改成「跟着读」)。
 *
 * ## 为什么有这条路
 *
 * Claude Code 的状态**本来靠 hook 推送**(hooks.ts),而会话表只活在 DSH 进程内存里。两种情况下 hook 指望不上:
 * 1. 重启前就在跑的会话要等下一次 hook 事件才会重新出现(2026-09-02 真机:两个 Claude 会话在跑,标签一个气泡都没有);
 * 2. **这台机器根本没接 hook**(接 hook 是设置里一颗可选的按钮,hooksApply.ts)—— 2026-09-25 维护者机器上
 *    `~/.claude/settings.json` 就是 `{}`。于是 Claude 会话**只能**从这条路进来,而旧版这条路只做一件事:
 *    捞一次「还在跑」,**标题、在做什么一概没读,之后也再不看它**——事务官页上两张「Claude 的一条会话 /
 *    等待下一次进度回传」,其中一条早就说完了还挂着「进行中 · 19 分钟」。
 *
 * ## 现在做什么(请求驱动 + 15 秒限频,同 codex reconcile;不是常驻轮询)
 *
 * 每一轮看最近写过的会话文件(2 小时内动过的):
 * - **状态**:Claude Code 2.1 起自己在 `~/.claude/sessions/<pid>.json` 记着「此刻开着的会话」——`status: busy / idle`
 *   和那个进程还在不在。有这份就照它(busy = 在跑,idle = 这一轮说完了、在等他);桌面 App 的会话不在这份里
 *   = 已经关了。没有这份(老版命令行)才退回看文件末尾那条记录(`end_turn` = 说完了,其余 = 还在干活)。
 *   2026-09-25(卡 T):那份里还有 `status: waiting` + `waitingFor`(`permission prompt` 权限弹窗 / `input needed` 提问弹窗)——
 *   没接 hook 的机器上「在等你批准」只有这里看得到:报成 waiting(权限弹窗 = 等审批,提问弹窗 = 等你输入)。
 * - **标题与在做什么**:读文件头尾各一段(sessionDigest.ts),标题用桌面 App 里的会话名 / `custom-title`,
 *   没有就第一句要求的前 20 来字;在做什么是一句人话 + 那一刻。
 * - **hook 在管的会话**(收到过它的 hook 事件):状态听 hook 的(它能分出「等你批准」),这里只补标题与在做什么。
 *
 * 三条纪律:
 * 1. **窗口里的一律报,只有「已经关掉 / 中断」那种第一次见到时不报**(2026-09-26,卡 V 改)。
 *    老规矩是「启动不回放」——第一次见到就说完了的一概不报,免得重启后凭空冒一堆未读蓝点。
 *    但已读簿(`readMarks.ts`)补上之后那个顾虑没了(他标过已读的不会翻回未读),而「不回放」
 *    反而让**做完的会话整条看不见**:09-26 他桌面里三条做完的会话在 `/state` 里一条都没有,
 *    Claude 标签上本该是蓝色的「3」,结果一个蓝点都没有。详见 scan 里那一段。
 * 2. **hook 在管的不改状态**(不跟推送打架)——**除了**文件说「报错结束 / 被掐断」那两种(以文件为准并记日志)。
 * 3. **只读**:`.json` 只读那几格(pid / sessionId / name / status / waitingFor / hostSessionId),同目录的 `.key` 文件**一个字节都不碰**。
 */
import { readdir, open, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { EventReason, HumanErrorView, SelfcheckView, SessionActivity, SessionStatus, WorkbenchEvent } from '../protocol.ts'
import { isHumanTurnRecord, isSdkDrivenRecord, isSelfcheckAsk, isSelfcheckCwd } from '../protocol.ts'
import { humanError } from '../humanError.ts'
import { FAILURE_RAW_MAX, isInjectedText, readSessionDigest, type DigestFailure, type SessionDigest, type SessionMark } from './sessionDigest.ts'
import { judgeSessionOutcome } from './sessionOutcome.ts'
import { UNKNOWN_PROJECT } from './sessions.ts'

/** Claude Code 自己记的一条「此刻开着的会话」(`~/.claude/sessions/<pid>.json`)。 */
export interface ClaudeLiveSession {
  /** 桌面 App / 命令行里这条会话的名字(他在侧栏看到的那个)。 */
  name?: string
  /**
   * `busy` / `shell` = 在跑;`idle` = 这一轮说完了;`waiting` = 停下来等他(权限弹窗、提问弹窗 —— 看 `waitingFor`)。
   * 别的值照原样,这里不认就退回看文件。
   */
  status?: string
  /**
   * `status: waiting` 时在等什么(2026-09-25 卡 T 从 Claude Code 2.1.280 读出来的两种):`permission prompt`(权限弹窗)、
   * `input needed`(提问弹窗 / 对话框)。没接 hook 的机器上,「在等你批准」只有这一处看得到。
   */
  waitingFor?: string
  /**
   * 这条会话在 Claude 桌面 App 里的编号(`local_<…>`)。App 自己的深链 `claude://code/continue?session=` 认的是它,
   * 不是会话文件的 id(卡 T「去回答」用;从 Claude.app 包里的深链校验读出来的)。
   */
  hostSessionId?: string
  /** 进入这个状态的时刻(毫秒)。 */
  statusSinceMs?: number
  /** 那个进程还在不在。不在的那份是残留,不算。 */
  alive: boolean
}

export interface ClaudeSessionRecoverDeps {
  /** 列出最近可能活跃的 transcript 路径(生产实现只看 mtime 新的,见 default 实现)。 */
  listRecentTranscripts: () => Promise<string[]>
  statMtimeMs: (filePath: string) => Promise<number | undefined>
  /** 读文件尾部若干字节(判活只需要最后几条记录)。 */
  readTail: (filePath: string) => Promise<string>
  /** 读一条会话成人话(标题、在做什么)。缺席 = 只判跑没跑(老用例)。 */
  readDigest?: (filePath: string, name?: string) => Promise<SessionDigest | undefined>
  /** 此刻开着的会话(会话 id → 名字 / 忙闲 / 进程在不在)。缺席或回 undefined = 这版 Claude 不记,按文件判。 */
  readLiveSessions?: () => Promise<ReadonlyMap<string, ClaudeLiveSession> | undefined>
}

export interface ClaudeSessionRecoverOptions {
  applyEvent: (event: WorkbenchEvent) => void
  /** hook 在管状态的会话只补标题与在做什么,走这条(不建行、不改状态)。 */
  setDetail?: (sessionId: string, detail: { title?: string, activity?: SessionActivity, selfcheck?: SelfcheckView }) => void
  /** 读到一条会话的文件就登记一下 —— 点开看详情(`GET /sessions/digest`)时按会话 id 找文件。 */
  onFile?: (sessionId: string, filePath: string, name?: string) => void
  /** 当前 Unix 秒。 */
  now?: () => number
  /**
   * **hook 在管的**会话 id(收到过它的 hook 事件)。这些会话的状态听 hook 的,这里只补标题与在做什么。
   * (2026-09-25 以前这里传的是「工作台已知的所有 Claude 会话」——包括这条路自己报过的,于是报过一次就再也不看,
   * 说完了也一直挂着「进行中」。)
   */
  knownSessionIds: () => readonly string[]
  /** 多久没写就不算活跃,默认 2 小时(与 codexSessionFeed.idleOfflineMs 同刻度)。 */
  idleMs?: number
  /** 两轮扫描的最短间隔,默认 15 秒(与 codex reconcile 同刻度)。 */
  minIntervalMs?: number
  /** 用可验证证据把 cwd 解析成项目名;缺证据显式「未归类」。 */
  resolveProject?: (cwd: string) => Promise<string | undefined>
  /**
   * **这条会话是工作台自己起的吗**(2026-09-25,卡 V 给卡 O 留的口子)。
   *
   * 起探针的那一半知道得最准(环境变量 `WORKBENCH_SELFCHECK` 只有起的人看得到,会话文件里没有),
   * 所以卡 O 的能力体检 / 派活探针在 `spawn` 的时候把会话 id 记下来,这里问它一声。
   * 缺席时退回只看会话文件的两条证据(`selfcheckOfTail`:自检目录、第一句的自检前缀)。
   * 约定的三样写在 protocol.ts 一处(`SELFCHECK_ENV` / `SELFCHECK_PREFIX` / `SELFCHECK_DIRNAME`)。
   */
  selfcheckOf?: (sessionId: string) => SelfcheckView | undefined
  /** 往服务端日志写一行(钩子与文件矛盾时记一条)。缺省不写。 */
  log?: (line: string) => void
  /**
   * ~~「这一轮说完了」的会话算不算在等他~~ —— **2026-09-26(卡 V 补)起这一格没有用了,留着只为不破调用方。**
   *
   * 卡 T 当初要它是因为:说完了的会话根本**不进会话表**(那时的「启动不回放」),于是
   * `overlayWaiting` 没有一行可以把 `ask` 挂上去 —— 在等他的那一问就整条看不见。所以它得
   * 反过来说一句「这条在等他,回放它」。
   *
   * 现在窗口内的会话(含说完了的)一律进表,`overlayWaiting` 出 `/state` 时照旧把 `ask` 叠上去,
   * 卡 T 要的东西一样不少,不必再有这条反向的口子。**新代码别传它。**
   */
  waitingIfIdle?: (sessionId: string) => boolean
}

export interface ClaudeSessionRecover {
  /** 请求驱动的一次扫描(内部限频,失败静默)。 */
  recover: () => void
}

/**
 * **尾巴最后一条可认记录停在哪儿**(2026-09-25,卡 V 重写;原来叫 `looksRunning`,只分「说完了 / 没说完」)。
 *
 * 老读法:末尾那条 `stop_reason !== 'end_turn'` 就算「还在干活」。而 Claude Code 把**上游报错**
 * 也写成一条 `assistant` 记录 —— `isApiErrorMessage: true` + `error: '<码>'`,`stop_reason` 是
 * `stop_sequence`。于是 09-25 那两条「登录失败、一句话就完了」的探针被读成「进行中」,挂了 53 分钟。
 *
 * 现在逐种认(记账用的记录一概跳过:`attachment` / `queue-operation` / `last-prompt` / `atis-latch` /
 * `custom-title` / `cost-state` / `ai-title` / `system` / `file-history-*` …—— 78 份真机文件里它们占一大半,
 * 老读法虽然也跳过它们,但没有「报错」和「他刚说完话」这两档):
 * - `assistant` + `isApiErrorMessage` → `failed`(带码与原文);
 * - `assistant` + `stop_reason: 'max_tokens'` → `failed`(这一轮被长度顶掉了);
 * - `assistant` + `stop_reason: 'end_turn'` → `ended`;
 * - `assistant` 别的(`tool_use` …) → `working`;
 * - `user` 里是工具结果 → `working`(工具回来了,它还得接着干);
 * - `user` 是他真说的话 → `asked`(它还没开口)。
 *
 * 一条可认记录都没有 → `mark` 缺席,**不猜**。
 */
export function markOfTail(tailText: string): { mark?: SessionMark, failure?: DigestFailure } {
  let mark: SessionMark | undefined
  let failure: DigestFailure | undefined
  for (const line of tailText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed[0] !== '{') continue
    let row: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(trimmed)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      row = value as Record<string, unknown>
    }
    catch {
      continue // 尾部截断的半行很正常,跳过
    }
    if (row.type !== 'assistant' && row.type !== 'user') continue
    const message = typeof row.message === 'object' && row.message !== null ? row.message as Record<string, unknown> : undefined
    if (row.type === 'assistant') {
      if (row.isApiErrorMessage === true) {
        const content = Array.isArray(message?.content) ? message.content : []
        const raw = content
          .map(block => (typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined))
          .find(block => block?.type === 'text' && typeof block.text === 'string')?.text
        mark = 'failed'
        failure = {
          ...(typeof row.error === 'string' && row.error !== '' ? { code: row.error } : {}),
          ...(typeof raw === 'string' && raw.trim() !== '' ? { raw: raw.replace(/\s+/g, ' ').trim().slice(0, FAILURE_RAW_MAX) } : {}),
        }
        continue
      }
      if (message?.stop_reason === 'max_tokens') { mark = 'failed'; failure = { code: 'max_tokens' }; continue }
      mark = message?.stop_reason === 'end_turn' ? 'ended' : 'working'
      failure = undefined
      continue
    }
    // user:工具结果那种不是他说的话,它还在干活。
    const content = message?.content
    const isToolResult = Array.isArray(content) && content.some(block =>
      typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'tool_result')
    if (isToolResult) { mark = 'working'; failure = undefined; continue }
    /**
     * **不是他说的话的那几种 `user` 记录一概跳过**(2026-09-26,卡 V 补;真机 `b75d1d3e` 抓出来的)。
     *
     * Claude 在**最终回答之后**还会往文件尾上追几条 `user` 记录,而它们一个字都不是他说的:
     * `isMeta: true` 的 `<local-command-caveat>`、斜杠命令的展开(`<command-name>/model</command-name>`)、
     * 命令的输出(`<local-command-stdout>`)。老读法把它们当成「他刚说完话、它还没开口」,于是一条
     * **明明说完了**的会话被判成 `asked` —— 再配上「写它的进程已经没了」就成了**中断**。
     *
     * 判据与 `sessionDigest.claudeAsk` 一套(`isMeta` / `isCompactSummary` / `isVisibleInTranscriptOnly` /
     * `origin.kind !== 'human'` / 整段是注入模板),所以两条路对同一份文件永远给同一个结论 ——
     * 用例 `digest 读出来的 mark 与只读尾巴的那一份一致` 钉着这一条。
     */
    if (row.isMeta === true || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) continue
    const origin = typeof row.origin === 'object' && row.origin !== null ? row.origin as Record<string, unknown> : undefined
    if (origin !== undefined && typeof origin.kind === 'string' && origin.kind !== 'human') continue
    if (typeof content === 'string' && (content.trim() === '' || isInjectedText(content))) continue
    if (Array.isArray(content)) {
      const said = content
        .map(block => (typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined))
        .find(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
      if (said !== undefined && isInjectedText(said.text as string)) continue
    }
    mark = 'asked'
    failure = undefined
  }
  return { ...(mark === undefined ? {} : { mark }), ...(failure === undefined ? {} : { failure }) }
}

/**
 * 老名字,留给老用例(「还在干活吗」)。**新代码别用**:它把「出错」「被掐断」「他刚说完话」
 * 都糊成一个布尔,而那正是 09-25 那三张假「进行中」卡的来路。
 */
export function looksRunning(tailText: string): boolean {
  const { mark } = markOfTail(tailText)
  return mark === 'working' || mark === 'asked'
}

/**
 * 探针**只看会话文件**就能认的几条证据,按硬度排:
 * 1. 跑在自检目录里(`cwd`);
 * 2. 第一句带自检前缀(`prefix`);
 * 3. **没有人往这条会话里打过字**(`sdk`,过渡那一条,见 protocol.ts 的 `isSdkDrivenRecord`)——
 *    卡 O 的探针还没换成前两样之前,靠它认出维护者这台上那三条。
 *    这一条**只在整条尾巴里一句人说的话都没有**时才算(`turnOrigin: 'human'`)——
 *    统筹那条真会话里有 83 条「他的话经程序转进来」的记录,少了这道保险就会把它当探针藏掉。
 */
export function selfcheckOfTail(tailText: string, cwd: string | undefined): SelfcheckView | undefined {
  if (isSelfcheckCwd(cwd)) return { by: 'cwd' }
  let sdk = false
  let human = false
  for (const line of tailText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed[0] !== '{') continue
    let row: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(trimmed)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      row = value as Record<string, unknown>
    }
    catch { continue }
    // 「这一轮是谁发起的」写在每条记录上,不只 user 那几条。
    if (isSdkDrivenRecord(row)) sdk = true
    // 他往这条会话里打过字 → 这是他的会话,下面那一条兜底不许把它当探针。
    if (isHumanTurnRecord(row)) human = true
    if (row.type === 'last-prompt' && isSelfcheckAsk(typeof row.lastPrompt === 'string' ? row.lastPrompt : undefined)) return { by: 'prefix' }
    if (row.type !== 'user') continue
    const content = (typeof row.message === 'object' && row.message !== null ? (row.message as Record<string, unknown>).content : undefined)
    if (typeof content === 'string') { if (isSelfcheckAsk(content)) return { by: 'prefix' } ; continue }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined
      if (b?.type === 'text' && isSelfcheckAsk(typeof b.text === 'string' ? b.text : undefined)) return { by: 'prefix' }
    }
  }
  return sdk && !human ? { by: 'sdk' } : undefined
}

/** 从尾部记录里取某个字段的最后一个非空字符串值(cwd / entrypoint 每条记录都带);取不到就 undefined,不猜。 */
function lastStringField(tailText: string, field: string): string | undefined {
  for (const line of tailText.split('\n').reverse()) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value = (JSON.parse(trimmed) as Record<string, unknown>)[field]
      if (typeof value === 'string' && value !== '') return value
    }
    catch {
      continue
    }
  }
  return undefined
}

/** 这一轮报过什么(指纹),下一轮一样就不再报。 */
interface Tracked {
  mtime: number
  liveKey: string
  /** 报过的状态;第一次见就是说完了的(不回放)记 undefined。 */
  status?: SessionStatus
  fingerprint?: string
}

export function createClaudeSessionRecover(
  deps: ClaudeSessionRecoverDeps,
  options: ClaudeSessionRecoverOptions,
): ClaudeSessionRecover {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idleMs = options.idleMs ?? 7_200_000
  const minIntervalMs = options.minIntervalMs ?? 15_000
  let lastRunAt = 0
  let running = false
  const tracked = new Map<string, Tracked>()

  async function projectOf(cwd: string | undefined): Promise<string | undefined> {
    if (cwd === undefined || options.resolveProject === undefined) return undefined
    try {
      return await options.resolveProject(cwd)
    }
    catch {
      return undefined
    }
  }

  /**
   * **状态从会话文件本身判**(2026-09-25,卡 V 重写)。两条证据喂给 `judgeSessionOutcome`:
   *
   * 1. **文件说它停在哪儿**(`mark`:说完了 / 报错了 / 被掐断 / 在干活 / 他刚说完话);
   * 2. **进程表说还有没有人在写**(`~/.claude/sessions/<pid>.json` 那一份是「此刻开着的会话」)。
   *
   * 老写法两处错:
   * - 状态一律退回 `looksRunning`(末尾不是 `end_turn` 就算在跑),报错那条被当成「还在干活」;
   * - 「不在那份里 = 已经关了」**只对 `entrypoint === 'claude-desktop'` 的会话生效**,
   *   而 `claude -p` 一次性运行根本不进那份(实测:维护者这台 5 份 pid 文件里一条探针都没有),
   *   于是探针永远走「猜」的那条路。现在推广成:**那份在、而这条会话不在里面 → 没人在写它**。
   *
   * 一个例外(防抖):文件刚刚还动过(`GRACE_MS` 内)就**不敢说没人在写** ——
   * 一条刚起的会话可能还没把自己的 pid 文件写出来,这时候说「中断」会闪一下假状态。
   */
  const GRACE_MS = 60_000
  function outcomeOf(
    live: ReadonlyMap<string, ClaudeLiveSession> | undefined,
    id: string,
    tail: string,
    digest: SessionDigest | undefined,
    mtime: number,
    growing: boolean,
  ): { status: SessionStatus, reason?: EventReason, why: string, since?: number, failure?: DigestFailure, waitingFor?: string } | undefined {
    const mine = live?.get(id)
    const fromTail = markOfTail(tail)
    const mark = digest?.mark ?? fromTail.mark
    const failure = digest?.failure ?? fromTail.failure
    const lastAtMs = digest?.last_at === undefined ? undefined : Date.parse(digest.last_at)
    const at = lastAtMs !== undefined && Number.isFinite(lastAtMs) ? lastAtMs : mtime
    // 那份「开着的会话」在,而这条不在里面(或它的进程没了)→ 没人在写它。刚动过的不下这个结论。
    const writerAlive = live === undefined
      ? undefined
      : mine?.alive === true
        ? true
        : logicalMsNow() - at < GRACE_MS ? undefined : false
    const outcome = judgeSessionOutcome({
      ...(mark === undefined ? {} : { mark }),
      ...(writerAlive === undefined ? {} : { writerAlive }),
      // 卡 T 从 `~/.claude/sessions/<pid>.json` 读出来的两格也算「进程忙不忙」:`shell` 是它在跑命令。
      ...(mine?.status === 'busy' || mine?.status === 'shell' ? { writerBusy: true } : mine?.status === 'idle' ? { writerBusy: false } : {}),
      /**
       * **形式上停下来等人**:卡 T 发现 Claude 把权限弹窗 / 提问弹窗写进了那份 pid 文件
       * (`status: 'waiting'` + `waitingFor`)—— 那比会话文件里的信号更直接,优先用它;
       * 会话文件里的(Kimi 的 `ApprovalRequest`)作后备。两者都没有就缺席,**不自己判内容**(那一半归卡 T)。
       */
      ...(mine?.alive === true && mine.status === 'waiting'
        ? { formalWait: /permission/i.test(mine.waitingFor ?? '') ? 'approval' as const : 'question' as const }
        : digest?.formal_wait === undefined ? {} : { formalWait: digest.formal_wait }),
      ...(lastAtMs === undefined || !Number.isFinite(lastAtMs) ? {} : { lastAtMs }),
      mtimeMs: mtime,
      nowMs: logicalMsNow(),
      growing,
    })
    // 一条可认记录都没有:**不下结论**,这一轮什么都不报(拿不准就不替他改状态)。
    if (outcome === undefined) return undefined
    // 进入这个状态的时刻:那份「开着的会话」记着就用它(它比记录准)。
    const since = mine?.alive === true && mine.statusSinceMs !== undefined ? mine.statusSinceMs : undefined
    return {
      status: outcome.status,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      why: outcome.why,
      ...(since === undefined ? {} : { since }),
      ...(failure === undefined ? {} : { failure }),
      ...(mine?.waitingFor === undefined ? {} : { waitingFor: mine.waitingFor }),
    }
  }

  function logicalMsNow(): number {
    return now() * 1000
  }

  async function scan(): Promise<void> {
    const logicalMs = now() * 1000
    const hooked = new Set(options.knownSessionIds())
    let live: ReadonlyMap<string, ClaudeLiveSession> | undefined
    try {
      live = await deps.readLiveSessions?.()
    }
    catch {
      live = undefined
    }
    const paths = await deps.listRecentTranscripts()
    for (const filePath of paths) {
      const sessionId = basename(filePath).replace(/\.jsonl$/, '')
      const mtime = await deps.statMtimeMs(filePath)
      if (mtime === undefined) continue
      const before = tracked.get(sessionId)
      if (logicalMs - mtime > idleMs) {
        // 空闲收尾:报过、还没 offline 的补一条 offline(同 codexSessionFeed 的纪律);hook 在管的不插手。
        if (before?.status !== undefined && before.status !== 'offline' && !hooked.has(sessionId)) {
          options.applyEvent({ agent: 'claude', session_id: sessionId, project: '', type: 'offline', ts: now() })
          tracked.set(sessionId, { ...before, status: 'offline' })
        }
        continue
      }
      const liveInfo = live?.get(sessionId)
      if (liveInfo?.name !== undefined) options.onFile?.(sessionId, filePath, liveInfo.name)
      else options.onFile?.(sessionId, filePath)
      const liveKey = liveInfo === undefined ? '-' : `${liveInfo.alive ? 1 : 0}|${liveInfo.status ?? ''}|${liveInfo.waitingFor ?? ''}|${liveInfo.name ?? ''}|${liveInfo.statusSinceMs ?? ''}`
      // 文件没动、那份「开着的会话」也没变:这一轮没有新东西,一个字节都不读。
      if (before !== undefined && before.mtime === mtime && before.liveKey === liveKey) continue

      const tail = await deps.readTail(filePath)
      const digest = deps.readDigest === undefined ? undefined : await deps.readDigest(filePath, liveInfo?.name)
      const detail = {
        ...(digest?.title === undefined ? {} : { title: digest.title }),
        ...(digest?.activity === undefined ? {} : { activity: digest.activity }),
      }

      const cwd = digest?.cwd ?? lastStringField(tail, 'cwd')
      const growing = before !== undefined && mtime > before.mtime
      const outcome = outcomeOf(live, sessionId, tail, digest, mtime, growing)
      /**
       * **这条会话是工作台自己起的吗**(2026-09-25,卡 V)。三条证据,任一命中就算,
       * 顺序按硬度:起的那一半记下的(卡 O 传 `selfcheckOf`,环境变量那条只有起的人知道)>
       * 自检目录 > 第一句的自检前缀。认出来的**不进舞台、不进列表、不计入「执行」**(protocol.ts `SELFCHECK_*`)。
       */
      const selfcheck = options.selfcheckOf?.(sessionId) ?? selfcheckOfTail(tail, cwd)

      if (hooked.has(sessionId)) {
        // hook 管状态;这里只补标题、在做什么,以及「这是不是工作台 / 程序自己起的」。
        // 最后那一样是 2026-09-26 晚补的(统筹):SDK 起的一次性会话走钩子,原来一路被当成他的,坞上 Claude 那格一颗假蓝 1。
        if (detail.title !== undefined || detail.activity !== undefined || selfcheck !== undefined) {
          options.setDetail?.(sessionId, { ...detail, ...(selfcheck === undefined ? {} : { selfcheck }) })
        }
        /**
         * **钩子和文件矛盾时以文件为准,并记一行日志**(2026-09-25,卡 V 任务书)。
         * 钩子分得出「等你批准」,文件分不出 —— 所以平时以钩子为准。但文件说「这一轮报错结束了 /
         * 被掐断了」而钩子还挂着「在跑 / 在等你」时,文件赢:钩子是推送,漏一条就永远挂着,
         * 文件是会话自己写下的事实。(09-25 之前没有这条路,一条 SessionEnd 丢了就挂到 2 小时空闲清扫。)
         */
        if (outcome !== undefined && (outcome.status === 'error' || outcome.reason === 'interrupted')) {
          options.log?.(`[会话状态] claude/${sessionId} 钩子在管,但文件说「${outcome.why}」—— 以文件为准`)
          const humanised = outcome.status === 'error' ? humanError(outcome.failure ?? {}) : undefined
          options.applyEvent({
            agent: 'claude',
            session_id: sessionId,
            project: '',
            ...(cwd === undefined ? {} : { cwd }),
            type: outcome.status,
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
            ...detail,
            ...(selfcheck === undefined ? {} : { selfcheck }),
            ...(humanised === undefined ? {} : { human_error: humanised as HumanErrorView }),
            status_why: outcome.why,
            ts: Math.floor(mtime / 1000),
          })
          tracked.set(sessionId, { mtime, liveKey, status: outcome.status })
          continue
        }
        tracked.set(sessionId, { mtime, liveKey })
        continue
      }

      // 认不出这份记录:不下结论,谁也不动。
      if (outcome === undefined) {
        tracked.set(sessionId, { ...(before ?? {}), mtime, liveKey })
        continue
      }
      const { status, since, waitingFor } = outcome
      /**
       * 第一次见到就不在跑的会话要不要报。
       *
       * **2026-09-26(卡 V 补,维护者:「现在应该是 3 完成 1 进行中」)——「做完了」现在要报。**
       *
       * 原来的规矩(2026-09-02)是「启动不回放」:第一次见到就已经说完了的一概不报,免得
       * **重启之后凭空冒出一堆未读蓝点**(那天真机上重启七八次,他早就看过的完成会话每次都翻回未读)。
       * 但那条规矩当时是唯一的办法 —— **已读簿(`readMarks.ts`)是同一天才补上的**。现在已读簿在:
       * 他标过已读的会话即使重新报一次 `done`,`applyEvent` 也不会再把它翻回未读。
       * 所以「不回放」这一半已经没有必要,反而**让做完的会话整条看不见** ——
       * 09-26 他桌面里三条做完的 Claude 会话(`6302f07d` / `ff8b7326` / …)在 `/state` 里一条都没有,
       * Claude 标签上本该是蓝色的「3」,结果一个蓝点都没有。
       *
       * 现在:**在这一轮扫描范围内的(`idleMs`,默认 2 小时,按它最后一条记录的时刻算)一律报**,
       * 做完的进「完成 · 未读」那一档(蓝点),他点过就灭、并且跨重启记住。
       *
       * 仍然**不报**的只有一种:`offline`(已经关掉的、或者判成中断的)—— 那种第一次见到就报一条
       * 「中断」毫无用处(他没在等它,也点不动它),而且会把上一命的残留会话拖进列表。
       */
      if (before?.status === undefined && status === 'offline') {
        tracked.set(sessionId, { mtime, liveKey })
        continue
      }
      /**
       * **两小时的窗口按「它什么时候结束的」算,不按文件什么时候被碰过算**(2026-09-26,卡 V 补)。
       *
       * 上面那道闸用的是文件修改时刻(`mtime`)—— 必须如此:不读文件就只有它,而这一轮要在几十份文件里
       * 挑出该读的几份。但 mtime 会被**与这一轮无关的写入**刷新(会话还开在桌面 App 里时,Claude 会往
       * 文件尾上追 `atis-latch` / `custom-title` 这类记账记录)。于是一条三小时前就说完的会话可能因为
       * 五分钟前被碰过一下,又被当成「最近的」报进列表。
       *
       * 读完 digest 之后我们知道它**自己记的最后一刻**(`last_at`),就用它再核一遍:
       * 已经说完 / 已经收场的会话,结束超过 `idleMs` 就不新报(报过的走上面那条空闲收尾)。
       * **在跑的不核**(它正在写,`last_at` 本来就该是新的;真要核反而会把一条跑了三小时的会话踢掉)。
       */
      if (before?.status === undefined && status !== 'running' && status !== 'waiting') {
        const endedAt = digest?.last_at === undefined ? undefined : Date.parse(digest.last_at)
        if (endedAt !== undefined && Number.isFinite(endedAt) && logicalMs - endedAt > idleMs) {
          tracked.set(sessionId, { mtime, liveKey })
          continue
        }
      }
      if (before?.status === 'offline' && status === 'offline') {
        tracked.set(sessionId, { ...before, mtime, liveKey })
        continue
      }
      const fingerprint = [status, outcome.reason ?? '', waitingFor ?? '', detail.title ?? '', detail.activity?.line ?? '', detail.activity?.at ?? ''].join('|')
      if (before?.fingerprint === fingerprint && before.status === status) {
        tracked.set(sessionId, { ...before, mtime, liveKey })
        continue
      }
      const project = await projectOf(cwd)
      // 进入这个状态的时刻:「开着的会话」那份记着就用它;在跑的用这一轮他开口的那一刻;都没有用文件修改时刻。
      const sinceSec = since !== undefined
        ? Math.floor(since / 1000)
        : status === 'running' && digest?.turn_at !== undefined
          ? Math.floor(Date.parse(digest.turn_at) / 1000)
          : Math.floor(mtime / 1000)
      /** 出错那一档翻成人话 + 一键入口(「Not logged in · Please run /login」→「Claude 命令行还没登录」)。 */
      const humanised = status === 'error' ? humanError(outcome.failure ?? {}) : undefined
      options.applyEvent({
        agent: 'claude',
        session_id: sessionId,
        // offline 那条留空 project,让 sessions.ts 沿用上一次已知值(别把已归类的冲回「未归类」)
        project: status === 'offline' ? '' : project ?? UNKNOWN_PROJECT,
        ...(cwd === undefined ? {} : { cwd }),
        type: status,
        // 「中断」是 offline + interrupted;别的 offline 照旧 reason: 'offline'。
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : status === 'offline' ? { reason: 'offline' as const } : {}),
        /**
         * 停下来等他那一档的分类(卡 T):**权限弹窗 = 等审批**(响铃规则只认它);
         * 提问弹窗 = 等你输入(不响铃)。卡 V:`idle_prompt` 本身不再进 waiting 档
         * (那是空闲,见 hooks.ts),所以走到这里的 waiting 一定是**形式上真的在等人**。
         */
        ...(status === 'waiting'
          ? /permission/i.test(waitingFor ?? '')
            ? { wait_reason: 'approval' as const }
            : (/input/i.test(waitingFor ?? '') ? { wait_reason: 'input' as const } : {})
          : {}),
        ...detail,
        ...(selfcheck === undefined ? {} : { selfcheck }),
        ...(humanised === undefined ? {} : { human_error: humanised as HumanErrorView }),
        ...(digest?.formal_wait === undefined ? {} : { formal_wait: digest.formal_wait }),
        status_why: outcome.why,
        ts: Number.isFinite(sinceSec) ? sinceSec : Math.floor(mtime / 1000),
      })
      tracked.set(sessionId, { mtime, liveKey, status, fingerprint })
    }
  }

  return {
    recover() {
      const nowMs = now() * 1000
      if (running || nowMs - lastRunAt < minIntervalMs) return
      lastRunAt = nowMs
      running = true
      void scan().catch(() => {}).finally(() => { running = false })
    },
  }
}

/** 进程还在不在:发 0 号信号只问不杀。不在(ESRCH)→ false;别的错(没权限)按在。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 读 `~/.claude/sessions/*.json`(Claude Code 2.1 起每个开着的会话一份)。**只读 `.json`**,同目录的 `.key` 不碰。
 * 目录不在 / 一份都读不出 → undefined(这版 Claude 不记,调用方按文件判)。
 */
export async function readClaudeLiveSessions(claudeHome: string): Promise<ReadonlyMap<string, ClaudeLiveSession> | undefined> {
  const dir = join(claudeHome, 'sessions')
  let names: string[]
  try {
    names = await readdir(dir)
  }
  catch {
    return undefined
  }
  const out = new Map<string, ClaudeLiveSession>()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>
      const sessionId = raw.sessionId
      const pid = raw.pid
      if (typeof sessionId !== 'string' || sessionId === '' || typeof pid !== 'number') continue
      const entry: ClaudeLiveSession = {
        alive: processAlive(pid),
        ...(typeof raw.name === 'string' && raw.name.trim() !== '' ? { name: raw.name.trim() } : {}),
        ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
        ...(typeof raw.waitingFor === 'string' && raw.waitingFor.trim() !== '' ? { waitingFor: raw.waitingFor.trim() } : {}),
        ...(typeof raw.hostSessionId === 'string' && /^local_[A-Za-z0-9-]{1,64}$/.test(raw.hostSessionId) ? { hostSessionId: raw.hostSessionId } : {}),
        ...(typeof raw.statusUpdatedAt === 'number' ? { statusSinceMs: raw.statusUpdatedAt } : {}),
      }
      // 同一条会话被两个进程开着(少见):活着的那份说了算。
      const prior = out.get(sessionId)
      if (prior === undefined || (!prior.alive && entry.alive)) out.set(sessionId, entry)
    }
    catch {
      // 单份坏了不拦别的。
    }
  }
  return out.size === 0 ? undefined : out
}

/** 生产用 deps:~/.claude/projects 下各项目目录里的 *.jsonl,只读尾部 64KB;标题与在做什么读头尾各 256KB。 */
export function defaultClaudeSessionRecoverDeps(claudeHome: string): ClaudeSessionRecoverDeps {
  const root = join(claudeHome, 'projects')
  const tailBytes = 64 * 1024
  return {
    listRecentTranscripts: async () => {
      const out: string[] = []
      let dirs: string[]
      try {
        dirs = await readdir(root)
      }
      catch {
        return out // 没装 Claude Code
      }
      for (const dir of dirs) {
        try {
          for (const name of await readdir(join(root, dir))) {
            if (name.endsWith('.jsonl')) out.push(join(root, dir, name))
          }
        }
        catch {
          // 单个项目目录读不了不拦别的
        }
      }
      return out
    },
    statMtimeMs: async (filePath) => {
      try {
        return (await stat(filePath)).mtimeMs
      }
      catch {
        return undefined
      }
    },
    readTail: async (filePath) => {
      const handle = await open(filePath, 'r')
      try {
        const { size } = await handle.stat()
        const start = Math.max(0, size - tailBytes)
        const buffer = Buffer.alloc(size - start)
        await handle.read(buffer, 0, buffer.length, start)
        return buffer.toString('utf8')
      }
      finally {
        await handle.close()
      }
    },
    readDigest: (filePath, name) => readSessionDigest({ format: 'claude-transcript', file: filePath, ...(name === undefined ? {} : { name }) }),
    readLiveSessions: () => readClaudeLiveSessions(claudeHome),
  }
}
