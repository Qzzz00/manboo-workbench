/**
 * 额度采集循环：把 collectQuota 的结果周期性送进 WorkbenchService。
 *
 * 为什么要单独有这一层：collectQuota 只负责"取一次数"，service 只负责"存状态"，
 * 在此之前**没有任何人把两者接起来**——所以 /state 里四家额度恒为 unknown，
 * 展示台的余额栏一直显示"未接入"。
 *
 * 三条纪律：
 * - **失败不许清空**。取数失败时保留上一轮已知值，界面继续显示最后已知额度
 *   （与架构约束 C1 同一初衷：上游挂了，看板也不能跟着变空）。
 *   把已知值抹成 unknown 或 0 会被误读成"额度耗尽"。
 *   这条原来只在"整轮 collect 抛错"时兑现，**单家失败并不算**——单家失败会得到一条
 *   unknown，照样写进去，把好数字盖掉。真机上就这么翻过车：Kimi 的接口偶尔一次
 *   `fetch failed`（同一轮里 DeepSeek 的网络请求还是好的，所以不是断网），那一格就
 *   立刻变"未接入"，下一轮又自己好了——看板一闪一闪。现在给单家失败留几轮宽限：
 *   宽限内保住上次已知值，超了才如实标未接入（真的掉线、登录态失效仍会在十分钟内浮出来）。
 * - **账本要接力**。collectQuota 返回的 spend 是"今日已消耗"的账本，
 *   必须在轮次之间传下去；每轮都从零建基线的话，"今日已花"永远显示 0。
 * - **claude 那一格也要拉**。原先这里写着"不碰 claude"，理由是它由 statusLine 推上来。
 *   2026-08-20 实测推翻了那个前提：桌面端拉起的 Claude Code 不渲染终端状态栏，
 *   从不执行 statusLine 命令，于是那一格常年"未接入"（详见 quota/claudeDesktop.ts）。
 *   现在改成拉取为主、推送兜底，两者的取舍在 collect.ts 的 collectClaude 里。
 *   仍然成立的是那条担心：**别把已知真值覆盖成 unknown**——所以每轮都要把当前已知值
 *   传进 collect，让它在拉不到时能退回去。
 */
import type { AgentId, QuotaEntry } from '../protocol.ts'
import { quotaAsOfStale } from '../protocol.ts'
import type { CollectQuotaOptions, CollectQuotaResult } from './collect.ts'
import { collectQuota } from './collect.ts'
import type { ClaudeScopedGate } from './claudeScopedGate.ts'
import { createClaudeScopedGate } from './claudeScopedGate.ts'
import { createClaudeRenewGate } from './claudeRenewGate.ts'
import type { DailySpendState } from './dailySpend.ts'
import { localDay } from './dailySpend.ts'
import { DEFAULT_TIME_ZONE } from './collect.ts'
import type { PeakSchedule } from './peakHours.ts'
import type { RelayView } from './relay.ts'
import { RELAY_WINDOW_LABEL } from './relay.ts'
import type { CredentialProvider, Credentials } from '../server/credentials.ts'
import { defaultCredentialFile, loadCredentials, saveCredential } from '../server/credentials.ts'
import type { WorkbenchService } from '../server/service.ts'

/**
 * 整家共用的额度窗口标签(2026-09-09)。见底了整家都动不了,才算「额度不足」。
 *
 * 反例是 Claude 那些**按模型**的周窗口(claudeScoped.ts 拿 `scope.model.display_name`
 * 当标签,如「Claude Fable 5.1」):那一栏归零只挡一个模型,换个模型照样干活——
 * 拿它给整家的会话打「额度不足」就是在编(D13)。所以这里是白名单而不是"任一窗口"。
 *
 * 中转那条「今日」也在名单里(2026-09-18):走中转时它是**唯一**的一条路,
 * 今日上限用完了整家就真的动不了了 —— 那正是这份白名单要认的那种见底。
 */
const SHARED_WINDOW_LABELS: ReadonlySet<string> = new Set(['5h', '周', '总', RELAY_WINDOW_LABEL])

/**
 * 这一家是不是已经没额度了(2026-09-09 傍晚拍板第 4 条的「额度不足」那一档)。
 *
 * 判据尽量硬,**含糊一律算没见底**(D13:不确定就不填,而不是先标上再说):
 * - 余额型(DeepSeek):账号不可用,或余额 ≤ 0。
 * - 窗口型:某条**整家共用**的窗口剩 0%。
 * - unknown:取不到数 ≠ 没额度,不算。
 *
 * 429 不在这里判:我们撞到的 429 全部来自 Claude 的**认证/用量端点限流**
 * (claudeScopedGate / claudeRenewGate 的整段注释),那是"你敲太快了",不是"你没额度了",
 * 而且那条路上会话照样能跑。把它算成额度不足会在界面上写一句假话。
 */
export function quotaExhausted(entry: QuotaEntry | undefined, now: Date = new Date()): boolean {
  if (entry === undefined) return false
  /**
   * **过线的数不拿来算见底**(2026-10-02,卡 QA)。那一格界面上已经不出百分比了
   * (说的是「读不到最新的,上次 04:27」),这里却照它算出一句「额度不足」挂到整家的会话上,
   * 等于拿一份 17 小时前的数替她下结论 —— 同这一段开头那条「含糊一律算没见底」。
   */
  if (entry.kind !== 'unknown' && quotaAsOfStale(entry.as_of, now)) return false
  if (entry.kind === 'balance') {
    if (!entry.available) return true
    const total = Number.parseFloat(entry.total)
    return Number.isFinite(total) && total <= 0
  }
  if (entry.kind === 'quota') {
    return entry.windows.some(window => SHARED_WINDOW_LABELS.has(window.label) && window.left_pct <= 0)
  }
  return false
}

/** 由本循环负责写入的来源。四家都在，claude 走"拉取为主、推送兜底"（见文件头第三条纪律）。 */
const PULLED: readonly AgentId[] = ['dsh', 'codex', 'kimi', 'claude']

/** 默认采集间隔：额度是慢变量，五分钟足够，也不至于把上游接口打烦。 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

/**
 * 单家连续失败几轮之内保住上次已知值。
 *
 * 按默认间隔算是十分钟：足够盖过一次网络抖动，又不至于把"真的掉线了"藏太久。
 */
const GRACE_ROUNDS = 2

/**
 * statusLine 推上来的值在多久之内算"比拉取新鲜"。
 *
 * 桌面端不执行 statusLine（anthropics/claude-code#41456，至今未修），所以这条推送
 * 平时根本不会来；但终端里跑 CLI 时它会来，而且**比拉取新鲜得多**——桌面端那份用量
 * 记录每 15 分钟才落一个样本，推送则是实时的，还带 resets_at。
 * 十分钟内来过推送就别让拉取覆盖它。
 */
const PUSH_FRESH_MS = 10 * 60 * 1000

/**
 * Claude 专用的快节奏间隔。
 *
 * 为什么只有 Claude 有：它是唯一有**实时源**的一家（自发 1 token 请求读响应头，
 * 见 quota/claudeHeaders.ts）。另外三家的上游本身就是慢变量，跟着一起提频只会
 * 白打接口——而且 Kimi 每轮取数都要换发 refresh token，提频等于自找麻烦。
 *
 * 60 秒是 Ben 2026-08-21 定的，依据是 30 天 4081 个样本算出的变化速率：
 * 5h 窗口重度使用时中位 0.27 个百分点/分钟、p90 是 1.0。60 秒最坏落后约 1 个点，
 * 10 秒是 0.2 个——板子显示整数百分比，**肉眼分不出来**，但请求量差 6 倍。
 *
 * 没填 setup-token 时这个循环照常跑，只是每轮都退回本地文件那条路（见 collect.ts
 * 的 collectClaude），代价是一次文件读，可以忽略。
 */
const DEFAULT_CLAUDE_INTERVAL_MS = 60 * 1000

export interface StartQuotaCollectorOptions {
  service: WorkbenchService
  /** 可注入的采集实现，测试用桩；缺省走真实 collectQuota。 */
  collect?: (options: CollectQuotaOptions) => Promise<CollectQuotaResult>
  /** 采集间隔；0 表示不起定时器，只能手动 collectOnce（测试与一次性采集用）。 */
  intervalMs?: number
  /** Claude 单家的快节奏间隔；0 表示不起这个定时器。缺省 60 秒。 */
  claudeIntervalMs?: number
  /** 按模型周窗口那条路的限频闸门；不传就自己建一个，测试可注入可控时钟。 */
  claudeScopedGate?: ClaudeScopedGate
  /** 采集失败时的告知渠道，缺省吞掉（这里不该把 stderr 刷满）。 */
  onError?: (error: unknown) => void
  /** 每轮采完（哪怕数字没变）调一次，用来把快照推给展示台。 */
  onUpdated?: () => void
  /**
   * 上一次 statusLine 把 Claude 额度推上来的时刻（epoch ms），没推过就返回 undefined。
   *
   * 只用来判新鲜度：推送在 PUSH_FRESH_MS 内来过，这一轮就不用拉取的值去盖它。
   * 进程重启后从 last-quota.json 恢复的推送值**没有时间**，因此一律按"不新鲜"处理——
   * 那份可能是几小时前的，让它压住每 15 分钟刷新的拉取值会把界面钉在陈旧数字上。
   */
  claudePushedAt?: () => number | undefined
  /** 凭据落盘位置，缺省 ~/.dsh/workbench/credentials.json。 */
  credentialFile?: string
  /**
   * 可注入的凭据读取。测试必须注入：默认实现是真实文件 I/O，
   * 在 fake timer 下不会在 advanceTimersByTime 内完成，会让"到点采了没有"的断言失真。
   */
  readCredentials?: () => Promise<Credentials>
  /**
   * 可注入的凭据写入。Kimi 每次续期都会换发新的 refresh token，必须立刻落盘。
   * 测试必须注入，理由同 readCredentials。
   */
  writeCredential?: (provider: CredentialProvider, value: string) => Promise<void>
  /**
   * 当前峰谷时间表(2026-09-09)。每轮现取——Ben 在设置里改完不必等重启,下一轮就按新表分账。
   * 不接就不分账,今日消耗只有总数(如实缺席,不硬塞进某一边)。
   */
  peakSchedule?: () => PeakSchedule | undefined
  /**
   * 消耗账本的落盘账簿(quota/spendLedger.ts)。接了才有两件事:
   * 日结拿得到**昨天**的峰谷两笔;当天重启后接着记而不是重新建基线。
   * 不接就退回原来的纯内存行为。
   */
  spendLedger?: SpendLedgerPort
  /**
   * 每轮现读一次「此刻走不走工作台中转」(2026-09-18,quota/relay.ts)。
   *
   * **每轮现读**而不是启动时读一次:Ben 在设置里切完模型服务,下一轮那一格就该换说法,
   * 不该等重启(同 peakSchedule 那条)。不接 = 这台服务没接中转,照官方余额那条老路走。
   */
  readRelay?: () => Promise<RelayView>
  /**
   * 把落盘那份(last-quota.json)里某一家的记录删掉。凭据被清空时用。
   *
   * 不接也能跑:今天只有 claude 会落盘(persist.ts 的 PUSHED),而 claude 的百分比
   * 不靠凭据。接上是为了这条纪律不留缺口 —— 那份文件里一旦存下别家的数,
   * 清空凭据之后它会在下次重启时又冒出来。
   */
  forgetLastQuota?: (agent: AgentId) => void
}

/**
 * 哪一把凭据没了，就作废哪一家的采样(2026-09-18)。
 *
 * **`claude_api` 故意不在表里**:Claude 那一格的百分比来自本机客户端的用量记录
 * (`~/Library/Application Support/Claude/…`,见 quota/claudeDesktop.ts),那把 token 只
 * 决定"实不实时"。删掉它之后那一格照样有真数 —— 把它抹成"未接入"才是编(D13),
 * 而且下一分钟的快路会立刻把同一个数字再写回来,界面只会闪一下。
 */
const CREDENTIAL_AGENT: Partial<Record<CredentialProvider, AgentId>> = {
  deepseek: 'dsh',
  kimi_web: 'kimi',
}

/** 凭据刚被清空时,那一格写什么。一句人话 + 一步出路,不给空白。 */
const FORGOTTEN_NOTE: Partial<Record<AgentId, string>> = {
  dsh: '还没接 DeepSeek(去设置里填自己的 API Key,或用工作台提供的服务)',
  kimi: '未登录 Kimi（在工作台点登录）',
}

/**
 * 采集循环用得到的账簿口子。只要这两件事,所以这里按最小面写——
 * 测试注入一个两方法的对象即可,不必造整份 SpendLedger。
 */
export interface SpendLedgerPort {
  record: (state: DailySpendState) => void
  resume: (date: string) => DailySpendState | undefined
}

export interface QuotaCollector {
  /** 立刻采一轮。失败时**不抛**，只走 onError，调用方不必包 try。 */
  collectOnce: () => Promise<void>
  /** 只重采 Claude 一家。失败时**不抛**，理由同上。 */
  collectClaudeOnce: () => Promise<void>
  /**
   * 某一家的凭据被清空了 —— **当场**作废它的上一次采样(2026-09-18)。
   *
   * 为什么不只是"重采一轮就好":重采要打好几家的接口,中间那几秒界面上还挂着用
   * 已经删掉的 Key 取来的余额;而且重采回来的 unknown 在老逻辑里还会被宽限留住。
   * 所以这是一个**同步**的动作,调用方(POST /credentials)照旧再触发一轮采集。
   *
   * 不认识的 provider(如 `claude_api`,见 CREDENTIAL_AGENT 的注释)什么都不做。
   */
  forgetCredential: (provider: CredentialProvider) => void
  stop: () => void
}

export function startQuotaCollector(options: StartQuotaCollectorOptions): QuotaCollector {
  const { service, onError } = options
  const collect = options.collect ?? collectQuota
  const readCredentials = options.readCredentials
    ?? (() => loadCredentials(options.credentialFile ?? defaultCredentialFile()))
  const writeCredential = options.writeCredential
    ?? (async (provider: CredentialProvider, value: string) => {
      await saveCredential(options.credentialFile ?? defaultCredentialFile(), provider, value)
    })
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS

  let spend: DailySpendState | undefined
  let stopped = false
  /** 每家连续失败了几轮，用来算宽限。取到数就归零。 */
  const failures = new Map<AgentId, number>()
  /**
   * 按模型周窗口(Fable/Opus)那条路的限频闸门(2026-08-26)。
   *
   * 建在这里、两条采集路共用同一个:它记的是"上次何时打过那个端点、上次取到什么",
   * 跟上面的 failures / spend 一样是**跨轮次**的记忆,属于采集循环而不是取数层。
   * 不建这个闸门的话,60 秒那条路会每分钟打一次 usage 端点,而它的惩罚窗口是
   * 161 秒——永远在惩罚里出不来,Fable 那栏就此静默消失(详见 claudeScopedGate.ts)。
   */
  const claudeScopedGate = options.claudeScopedGate ?? createClaudeScopedGate()
  /**
   * OAuth 续期的失败退避闸门(2026-09-02)。同上一条的理由建在这里、两条采集路共用:
   * 续期失败原来是无状态的,过期 token 每分钟都会再撞一次**认证端点**,429 因此
   * 永远出不来(真机 alert 长期停在「自动续期没成功:续期失败(HTTP 429)」)。
   * 详见 claudeRenewGate.ts。
   */
  const claudeRenewGate = createClaudeRenewGate()

  async function collectOnce(): Promise<void> {
    if (stopped) return
    try {
      // 每轮都重读一次凭据：Ben 在工作台填完会立刻触发一轮，这样那一轮就能用上新 Key。
      let credentials: Credentials = {}
      try {
        credentials = await readCredentials()
      }
      catch {
        // 读不到就当没配，界面会显示"未填"，那正是此时的真实状态。
      }

      // 当前已知的 claude 额度要传进去：拉不到桌面端记录时，collect 会退回到它，
      // 而不是把界面上一个真数字降级成"未接入"。
      const knownClaude = service.getState().quota.claude
      // DeepSeek 那一格同样传回去,但用途相反:collect 据此判断"这条旧数还能不能代表现在"
      // ——走中转时上一轮那笔官方余额说的是另一个账户的钱(2026-09-18)。
      const knownDsh = service.getState().quota.dsh

      // 此刻走不走中转。读 model.json 失败一律当"没走"——照官方余额那条老路走,
      // 绝不因为读一个配置文件失败就让这一格整片消失。
      let relay: RelayView | undefined
      try { relay = await options.readRelay?.() }
      catch { relay = undefined }

      // 进程刚起来、当天已经采过的话,从落盘账簿接着记——不然重启一次
      // "今日消耗"就从零重新建基线,当天前面花的钱全部消失。
      if (spend === undefined) {
        spend = options.spendLedger?.resume(localDay(new Date(), DEFAULT_TIME_ZONE))
      }
      const schedule = options.peakSchedule?.()

      const result = await collect({
        ...(spend === undefined ? {} : { spend }),
        ...(schedule === undefined ? {} : { peakSchedule: schedule }),
        credentials,
        claude: knownClaude,
        dsh: knownDsh,
        ...(relay === undefined ? {} : { relay }),
        claudeScopedGate,
        claudeRenewGate,
        // Kimi 的 access token 只活 15 分钟，每轮取数前都要用 refresh token 换新的，
        // 而服务端每次都会**换发**一个新的 refresh token——不当场存下来，下一轮就登不上了。
        onKimiRefreshed: async (refreshToken) => {
          try {
            await writeCredential('kimi_web', refreshToken)
          }
          catch (error) {
            // 存不下不该让整轮采集作废：这一轮的数字已经拿到了，
            // 只是下一轮可能要重登。把错报出去，界面和日志能看见。
            onError?.(error)
          }
        },
      })
      if (stopped) return
      const pushedAt = options.claudePushedAt?.()
      const pushIsFresh = pushedAt !== undefined && Date.now() - pushedAt < PUSH_FRESH_MS
      const before = service.getState().quota

      for (const agent of PULLED) {
        const entry = result.quota[agent]
        if (entry === undefined) continue

        // 终端里跑着 CLI 时，推上来的值比拉取新鲜，还带重置时间——别覆盖它。
        if (agent === 'claude' && pushIsFresh) continue

        if (entry.kind !== 'unknown') {
          failures.set(agent, 0)
          service.setQuota(agent, entry)
          // 会话侧的「额度不足」那一档(拍板第 4 条):只在**这一轮真的取到数**时才改结论。
          // 取不到就保持上次的判断,不因为一次抖动把标去掉、再加回来。
          service.setQuotaExhausted(agent, quotaExhausted(entry))
          continue
        }

        // 这一家这轮没取到。宽限期内保住上次已知值，别让一次抖动把整格打成"未接入"。
        const rounds = (failures.get(agent) ?? 0) + 1
        failures.set(agent, rounds)
        // 只有"本来有个好数字"才值得保。压根没有已知值时必须把 unknown 写进去，
        // 否则界面既没有数字也没有原因，比写明"未接入"更难查。
        //
        // `no_stale` 的那种 unknown 不走宽限(2026-09-18):它说的不是"这一轮没取到",
        // 是"这一家根本没接 / 换了来源"——上一轮那个数字是用一把已经不在的 Key 取的,
        // 留一轮都是在界面上写一句假话(protocol.ts 的 UnknownQuota.no_stale)。
        const known = before[agent]
        if (entry.no_stale !== true && known !== undefined && known.kind !== 'unknown' && rounds <= GRACE_ROUNDS) continue

        service.setQuota(agent, entry)
        // 「额度不足」是上一次**真的取到数**时算出来的结论;数字都作废了,结论也不能留着
        // ——不然会话上会挂着一条用已经不存在的账户算出来的「额度不足」。
        if (entry.no_stale === true) service.setQuotaExhausted(agent, false)
      }
      // 采完就推。额度没有 event 触发广播，不主动推展示台就得等重连。
      options.onUpdated?.()
      // 账本只在成功时推进；失败那轮保持原样，下一轮仍从上次成功处接力。
      if (result.spend !== undefined) {
        spend = result.spend
        // 落盘由账簿自己异步做(失败静默),这里不等它,采集不该被一次写盘拖住。
        options.spendLedger?.record(result.spend)
      }
    }
    catch (error) {
      // 保留上一轮已知额度，什么都不动。
      onError?.(error)
    }
  }

  /**
   * 只重采 Claude 一家，给那个 60 秒的快节奏用。
   *
   * 和 collectOnce 共用同一套纪律，一条都不许绕：
   * - **推送新鲜就不覆盖**（终端里跑 CLI 时那条带 resets_at，比什么都准）。
   * - **失败走 GRACE_ROUNDS 宽限**，保住上次已知值，绝不把好数字打成"未接入"。
   *
   * 但**不碰账本**：today_spent 是 DeepSeek 那条余额差分算出来的，
   * 跟 Claude 无关，让它继续由五分钟那轮推进。
   */
  async function collectClaudeOnce(): Promise<void> {
    if (stopped) return
    try {
      let credentials: Credentials = {}
      try {
        credentials = await readCredentials()
      }
      catch {
        // 读不到就当没配：collectClaude 会静静退回本地文件那条路。
      }

      const before = service.getState().quota
      // only:['claude'] —— 这条路的名字和注释一直写着"只重采 Claude 一家",
      // 但实现一直在跑整轮采集:另外三家的上游都是慢变量,每分钟陪跑纯属白打接口;
      // Kimi 更糟,这条路没接 onKimiRefreshed,每分钟换发一个新 refresh token 然后丢掉。
      // 点名之后那三家连接口都不打,Kimi 那颗雷也就跟着拆了。
      const result = await collect({
        credentials,
        claude: before.claude,
        claudeScopedGate,
        claudeRenewGate,
        only: ['claude'],
      })
      if (stopped) return

      const entry = result.quota.claude
      if (entry === undefined) return

      const pushedAt = options.claudePushedAt?.()
      if (pushedAt !== undefined && Date.now() - pushedAt < PUSH_FRESH_MS) return

      if (entry.kind !== 'unknown') {
        failures.set('claude', 0)
        service.setQuota('claude', entry)
        service.setQuotaExhausted('claude', quotaExhausted(entry))
      }
      else {
        const rounds = (failures.get('claude') ?? 0) + 1
        failures.set('claude', rounds)
        const known = before.claude
        if (!(known !== undefined && known.kind !== 'unknown' && rounds <= GRACE_ROUNDS)) {
          service.setQuota('claude', entry)
        }
      }
      options.onUpdated?.()
    }
    catch (error) {
      // 保留上一轮已知额度，什么都不动。
      onError?.(error)
    }
  }

  const timer = intervalMs > 0 ? setInterval(() => { void collectOnce() }, intervalMs) : undefined
  // 别让这个定时器把进程钉住不退出（与 http.ts 的 tick 定时器同样处理）。
  timer?.unref?.()

  const claudeIntervalMs = options.claudeIntervalMs ?? DEFAULT_CLAUDE_INTERVAL_MS
  const claudeTimer = claudeIntervalMs > 0
    ? setInterval(() => { void collectClaudeOnce() }, claudeIntervalMs)
    : undefined
  claudeTimer?.unref?.()

  /**
   * 凭据被清空 → 那一家的采样当场作废(2026-09-18)。三件事一起做，缺一件都会漏数:
   *
   * 1. 内存里那一格换成 `no_stale` 的 unknown（界面立刻不再显示旧数字）;
   * 2. 「额度不足」的结论一起去掉（它是拿已经不在的账户算出来的）;
   * 3. 落盘那份里同一家的记录删掉（否则重启之后它又被顶上来）。
   *
   * 还要把失败计数清零:不清的话紧接着的那一轮若取不到数，会以为"已经失败好几轮了"，
   * 反而不影响结论——但清零能保证语义干净:作废之后是**重新开始数**。
   */
  function forgetCredential(provider: CredentialProvider): void {
    const agent = CREDENTIAL_AGENT[provider]
    if (agent === undefined) return
    failures.set(agent, 0)
    service.setQuota(agent, {
      kind: 'unknown',
      no_stale: true,
      ...(FORGOTTEN_NOTE[agent] === undefined ? {} : { note: FORGOTTEN_NOTE[agent] as string }),
    })
    service.setQuotaExhausted(agent, false)
    options.forgetLastQuota?.(agent)
    options.onUpdated?.()
  }

  return {
    collectOnce,
    collectClaudeOnce,
    forgetCredential,
    stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      if (claudeTimer !== undefined) clearInterval(claudeTimer)
    },
  }
}
