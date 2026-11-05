/**
 * 余量取数(纯函数)—— **从 display-client/src/display/displayFeed.ts 整份复制过来**。
 *
 * 为什么是复制而不是 import:展示台是独立部署的另一个前端(自带 workbenchProtocol.ts
 * 副本),两边不共享构建;而 Ben 明确要求"不要动展示台的东西,复制、复用过来"。
 * 数据源本来就是同一套服务——工作台 /state 的 quota 字段,展示台也是从这里读的,
 * 所以"同一套服务"这条天然成立,这里复制的只是把它翻成人话的那层。
 *
 * 复制自 display-client 时逐条保留了原有的诚实纪律(它们都是真机踩出来的):
 * - 未接入显式标出,**绝不用 0 冒充**——0 会被读成"额度耗尽",意思完全相反
 * - 余额型不画条:余额没有分母,画条要假设一个"满"值,会误导
 * - 逐窗口各写一行重置时刻,不只挑最紧的那个(只写一个会被读成整个额度那时才回来)
 * - 认不出的时间不占行,不把 ISO 串糊到界面上
 *
 * **与展示台那份副本从 2026-09-26(卡 QS)起有一处不同**:这一份多收一个 `agentQuota`
 * (`/state.agent_quota`,服务端 `agentQuota.ts` 一处判好的三格),**这一轮取不到数时写上次读到的那个数**
 * (带「昨晚 20:42 读到的」),而不是「未接入」。展示台没有这一路(它拿不到 agent_quota),
 * 照旧走「未接入 + 取数层那句说明」—— 那两句说明这一版也改成了人话,所以展示台上也不再出现「过期」这类内部词。
 */
import type { AgentId, AgentQuotaView, DeepSeekPeakView, QuotaEntry, QuotaStaleFix } from '../protocol.ts'
import { AGENT_IDS, QUOTA_STALE_VALUE, isClaudeDesktopGone, quotaAsOfStale, quotaAsOfWords, quotaStaleNote } from '../protocol.ts'

/**
 * **这台电脑上真有的那几家**(2026-09-27,卡 HC「不写死各家 AI」)。
 *
 * 维护者在全新 MacBook Air(只装了豆包办公与 Codex)上:「顶部栏也是一样,现在还是有 claude 和 kimi,
 * 你要全面检查一遍,每一个人电脑装的东西都不一样,千万不能写死,豆包办公还认不出来呢」。
 *
 * 服务端已经按探测把 `/state.agents` 筛过了(server/installedAgents.ts),所以客户端**只照它念**:
 * 额度那一排、纯净模式顶栏那一行都读这一份,没装的一家不出现。
 * `agents` 整格缺席(老服务端、只传 quota 的用例、展示台那份副本)→ 退回 `AGENT_IDS`,
 * 行为与这一版之前一字不差(D13:查不到不许冒充没有)。
 */
export function quotaAgentIds(state: { agents?: readonly { id: AgentId }[] }): readonly AgentId[] {
  const list = state.agents
  return list === undefined || list.length === 0 ? AGENT_IDS : list.map(one => one.id)
}

/**
 * ★ 2026-10-03:**接着、只是没有新的用量记录**时那一格的大字。
 *
 * 不是「未接入」(那是"还没接上这一家"),也不是 `QUOTA_STALE_VALUE`「读不到最新的」
 * (那一句的前提是**有一个旧数**在手上,这里连一个数都没有)。
 * 为什么它够短:格子里那一行放得下的就这么几个字,完整那句(带「最后一次 N 小时前」)
 * 在它下面那一行摊着。
 */
export const QUOTA_NO_RECORD_VALUE = '没有用量记录'

export type QuotaLevel = 'ok' | 'warn' | 'danger'

export interface QuotaBar {
  label: string
  /** 条长 = 剩余百分比。方向与余额一致:数字变小＝该慌了。 */
  pct: number
  level: QuotaLevel
  resetAt?: string
}

export interface QuotaCell {
  agent: AgentId
  name: string
  value: string
  note: string
  level: QuotaLevel
  /** 余额型为 false:余额无分母,画条需假设"满"值,会误导。 */
  showBar: boolean
  bars: readonly QuotaBar[]
  /**
   * DeepSeek 那一格的峰谷一行(2026-09-09),形如「高峰 · 12:02 转低谷」。
   *
   * 服务端算好再下发(架构约束 C2),这里只翻成人话:客户端**不自己算时段**——
   * 一台机器上同时开着壳内页面与浏览器标签,各算各的迟早会不一致。
   * 服务端没给就整行缺席,不摆空壳。
   */
  peak?: string
  /**
   * 这一格写的是**上次读到的那个数**(这一轮没取到;服务端 `/state.agent_quota` 顶上来的,2026-09-26 卡 QS)。
   * 界面据此把 `note`(里面写着「昨晚 20:42 读到的」)**摊在明面上**,不折进「说明」里。
   */
  kept?: boolean
  /**
   * 上次读到的那个数**已经老了**(服务端那一格的 `stale`:超过 6 小时)。界面把这一格画淡;
   * `note` 里除了时刻还多一句「Claude 桌面没在跑,数字可能旧」。
   *
   * ★ 2026-10-03 多了一种**连一个数都没有**的情形走它:Claude 桌面端没再提供用量记录
   * (大字 `QUOTA_NO_RECORD_VALUE`)。这面旗子在界面上管的是两件事 —— **画淡** +
   * **那句话摊在明面上不折进「说明」**(QuotaPanel 的 `kept === true || stale === true`),
   * 这一种要的正是这两件;它不表示"这里有一个旧数字"(那是 `kept`)。
   */
  stale?: boolean
  /**
   * 「读不到最新」时那颗**入口键**(2026-10-02,卡 QK)。
   *
   * 这一家声明过「还有一条更实时的来源,但缺一样东西」时才有(`quota/liveSources.ts` 一处声明)。
   * 点一下去设置里那一行(`fix.at`)—— **这一格不做配置流程**,只负责把她送过去。
   * 缺席 = 没有更实时的来源,或者那一步还没有现成的去处:那时 `note` 里只有「上次 HH:MM」。
   */
  fix?: QuotaStaleFix
}

export interface QuotaThresholds {
  warnPct?: number
  warnBalance?: number
}

const NAMES: Record<AgentId, string> = {
  dsh: 'DeepSeek',
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
}

/** 窗口名在格里怎么写(评审页 0cf75042「5时 / 周」);服务端给的是 `5h`,手机与派活那句照旧用它。 */
export function windowShort(label: string): string {
  return label === '5h' ? '5时' : label
}

/**
 * 把额度窗口的重置时刻写成人话。
 * 直接打 ISO 串("周 窗口 2026-08-20T03:33:00.000Z 重置")又长又要心算,还撑破格子。
 */
export function formatResetAt(iso: string, now: Date = new Date()): string | undefined {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return undefined

  const pad = (n: number): string => String(n).padStart(2, '0')
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`

  const dayOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((dayOf(at) - dayOf(now)) / 86_400_000)

  if (days === 0) return `今天 ${clock}`
  if (days === 1) return `明天 ${clock}`
  // 更远的只给日期:几天后的重置精确到分是噪音,还会把额度格撑到折行。
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * 服务端那一格(`/state.agent_quota` 的 `AgentQuotaView`)→ 大字那一格。
 * 老四格与「其余几家」那几格用的是**同一个**说法(2026-09-26 卡 QS 起老四格取不到数时也走它)。
 */
export function quotaValue(view: AgentQuotaView): string {
  if (view.state === 'unlimited') return '不限'
  if (view.state === 'unconnected') return '没接上'
  if (view.level === 'empty') return '用完了'
  if (view.left_pct !== undefined) return `${view.left_pct}%`
  if (view.left !== undefined) return `${view.left.text} ${view.left.unit}`
  return view.short ?? view.line
}

/** 下面那一行:有数写整句(里面带着几点读到的),不限写出处,没接上写原因。 */
export function quotaNote(view: AgentQuotaView): string {
  if (view.state === 'unconnected') return view.why ?? view.line.replace(/^没接上:/, '')
  if (view.state === 'unlimited') return view.source ?? '这家不按额度算'
  return view.source === undefined ? view.line : `${view.line} · ${view.source}`
}

function levelForPct(pct: number, warnPct: number): QuotaLevel {
  if (pct <= 0) return 'danger'
  return pct < warnPct ? 'warn' : 'ok'
}

/**
 * 每个窗口各自一行「窗口名 时刻 重置」,顺序与进度条一致。
 * 只挑最紧的写会被读成整个额度那时才回来;时间认不出的窗口不占行。
 */
function resetNote(bars: readonly QuotaBar[], now: Date): string {
  const lines = bars
    .map(bar => (bar.resetAt === undefined ? undefined : formatResetAt(bar.resetAt, now)))
    .map((when, index) => (when === undefined ? undefined : `${bars[index]?.label} ${when} 重置`))
    .filter((line): line is string => line !== undefined)
  return lines.length === 0 ? '剩余' : lines.join(' · ')
}

/** 峰谷翻成人话。只有 DeepSeek 那一格有:峰谷是 DeepSeek 官方的计费时段。 */
function peakLine(peak: DeepSeekPeakView | undefined): string | undefined {
  if (peak === undefined) return undefined
  const label = peak.phase === 'peak' ? '高峰' : '低谷'
  const next = peak.next_phase === 'peak' ? '高峰' : '低谷'
  return `${label} · ${peak.next_switch} 转${next}`
}

function cellFor(
  agent: AgentId,
  entry: QuotaEntry | undefined,
  t: QuotaThresholds,
  now: Date,
  peak?: DeepSeekPeakView,
  view?: AgentQuotaView,
): QuotaCell {
  const warnPct = t.warnPct ?? 20
  const warnBalance = t.warnBalance ?? 20
  // 峰谷是时段,跟这一格有没有取到余额无关——没填 Key 时也照说。
  const peakOf = agent === 'dsh' ? peakLine(peak) : undefined
  const base = {
    agent, name: NAMES[agent],
    ...(peakOf === undefined ? {} : { peak: peakOf }),
  }

  if (entry === undefined || entry.kind === 'unknown') {
    /**
     * ★ 2026-09-26(卡 QS;维护者:「Claude 的额度怎么突然显示为未接入了」)。
     *
     * 这一轮没取到数**不等于**这一家没接上:Claude 桌面端几小时没报新用量时,昨夜 20:42 那个数
     * 仍然是真读到过的。服务端 `agentQuota.ts` 的 `quotaFor` 一处判好了三格,这里照它说 ——
     * 有数就写那个数 + 「几点读到的」(老了再标灰),**「未接入」只留给它也说没接上的时候**。
     * 没有 `view`(老宿主、展示台那份副本、只传 quota 的用例)时照这一版之前那样走。
     *
     * 不画条:顶上来的是「最紧的那一格」一个数,画不出每个窗口各剩多少 —— 画一条假的比不画糟。
     */
    if (view !== undefined && view.state !== 'unconnected') {
      const level: QuotaLevel = view.level === 'empty' ? 'danger' : view.level === 'low' ? 'warn' : 'ok'
      return {
        ...base,
        value: quotaValue(view),
        note: quotaNote(view),
        level,
        showBar: false,
        bars: [],
        kept: true,
        ...(view.stale === true ? { stale: true } : {}),
        // 入口键(卡 QK):服务端那一句里已经说了「配一把就能实时」,这里再给她一颗能点的
        // —— 只有真旧了才给,数还新的时候那一步不是「还差一步」。
        ...(view.stale === true && view.stale_hint?.live?.fix !== undefined
          ? { fix: view.stale_hint.live.fix }
          : {}),
      }
    }
    /**
     * ★ 2026-10-03:**「未接入」不许顶在 Claude 桌面端那一种上面**(维护者 10-03 午后:
     * 「Claude 额度格如实显示『Claude 桌面端没再提供』不再追」)。
     *
     * 钩子接着、文件也在,只是 `plan-usage-history.json` 的最后一个样本已经几小时前了
     * (桌面端这段时间没在跑)。写「未接入」等于告诉她"去接一下",而她什么都不用做。
     * 认这一种靠的是取数层那句话本身(`protocol.ts` 的 `CLAUDE_DESKTOP_GONE`,
     * 一份字两头读);**服务端那句笼统的 `why`(「这次没取到」)在这一种上让位**。
     *
     * `stale: true`:这一格画淡、而且那句话**摊在明面上**不折进「说明」里(见 QuotaPanel
     * 的 `kept === true || stale === true` 那一支)—— 她要一眼看见为什么没有数。
     * **不加新数据源、不碰凭据**:这张卡只换这一格说的话。
     */
    if (isClaudeDesktopGone(entry?.note)) {
      return {
        ...base,
        value: QUOTA_NO_RECORD_VALUE,
        note: entry?.note ?? QUOTA_NO_RECORD_VALUE,
        level: 'ok',
        showBar: false,
        bars: [],
        stale: true,
      }
    }
    // 未接入:显式标出。绝不用 0 冒充——0 会被读成"额度耗尽",是完全相反的意思。
    // 原因优先用服务端那句人话(`why`);取数层的原话(entry.note)是退路。
    return { ...base, value: '未接入', note: view?.why ?? entry?.note ?? '取数方式待实测', level: 'ok', showBar: false, bars: [] }
  }

  /**
   * ★ 2026-10-02(卡 QA;维护者 21:3x:「本机上的 Claude 额度,一晚上了,还是 100%」)。
   *
   * 这一格读的是 `/state.quota` 的原始 entry,在此之前**一个字都不说这个数多大年纪** ——
   * 04:27 的 100% 在 21:3x 还画着满条。过了那条线(2 小时)就**不出百分比、不画条**,
   * 只写「读不到最新的 / 上次 04:27」并把整格画淡。线以内照画,小字里缀上「截至 HH:MM」。
   * `as_of` 缺席(老宿主、这条来源没给)→ 与这一版之前一字不差,不替它编一个时刻(D13)。
   */
  const asOf = quotaAsOfWords(entry.as_of, now)
  if (quotaAsOfStale(entry.as_of, now)) {
    /**
     * ★ 2026-10-02(卡 QK):小字里**说清为什么、再给一个入口**。
     *
     * 卡 QA 之后这一格只写「读不到最新的 / 上次 04:27」—— 不骗人了,但她仍然不知道为什么、
     * 也不知道能做什么。那两句(「Claude 桌面没在跑」「点一下「接上」就实时」)
     * 由各家额度来源自己声明、跟着 entry 过来(`entry.stale_hint`),拼法三端共用一处
     * (`quotaStaleNote`);没声明的那几家这一行与卡 QA 一字不差,只有「上次 HH:MM」。
     */
    const fix = entry.stale_hint?.live?.fix
    return {
      ...base,
      value: QUOTA_STALE_VALUE,
      // 「读不到最新的,上次 04:27」里后半句落在小字上(大字那一格放不下一整句)。
      note: quotaStaleNote(entry.as_of, now, entry.stale_hint),
      level: 'ok',
      showBar: false,
      bars: [],
      stale: true,
      ...(fix === undefined ? {} : { fix }),
    }
  }

  if (entry.kind === 'balance') {
    const total = Number(entry.total)
    const level: QuotaLevel = !entry.available || total <= 0
      ? 'danger'
      : total < warnBalance ? 'warn' : 'ok'
    const spent = entry.today_spent === undefined ? '账号余额' : `账号余额 · 今日消耗 ¥${entry.today_spent}`
    return {
      ...base,
      value: entry.available ? `¥${entry.total}` : '不可用',
      note: asOf === undefined ? spent : `${spent} · ${asOf}`,
      level,
      showBar: false,
      bars: [],
    }
  }

  const bars: QuotaBar[] = entry.windows.map(w => ({
    label: w.label,
    pct: w.left_pct,
    level: levelForPct(w.left_pct, warnPct),
    ...(w.reset_at === undefined ? {} : { resetAt: w.reset_at }),
  }))
  const tightest = [...bars].sort((left, right) => left.pct - right.pct)[0]
  // entry.alert 是"有话要对 Ben 说"那一路(protocol.ts):比如某一栏这次取不到、
  // 或者要重新登录。跟重置时刻拼在同一行显示——**不能像以前那样被整个覆盖掉**:
  // 服务端那条"不许闷声少一栏"的纪律以前全写在不渲染的 note 里,等于没写,
  // Fable 那栏消失了一整天,界面上一个字的线索都没有。
  const resets = resetNote(bars, now)
  // 重置时刻说「什么时候回来」,截至时刻说「这个数多大年纪」—— 两样都要,少一样就有一问答不上来。
  const note = [resets, ...(asOf === undefined ? [] : [asOf]), ...(entry.alert === undefined ? [] : [entry.alert])]
  return {
    ...base,
    value: tightest === undefined ? '未接入' : `${tightest.pct}%`,
    note: note.join(' · '),
    level: tightest?.level ?? 'ok',
    showBar: true,
    bars,
  }
}

/**
 * 四家各一格,顺序固定。缺的那家也出现(标"未接入")。
 *
 * @param now 算「今天/明天」的基准时刻。**必须由调用方按时间推移传新的值**——
 *   额度几小时才变一次,若只在额度变化时重算,跨过午夜后会一直挂着昨天算出来的
 *   那句「明天 11:33」。
 * @param peak DeepSeek 峰谷(2026-09-09,服务端算好的 /state.deepseek_peak)。
 *   不传就没有那一行。
 * @param agentQuota 服务端一处判好的三格(2026-09-26,卡 QS,`/state.agent_quota`)。
 *   **只在这一轮没取到数时用得上**:那一格说「上次读到的是 62%、昨晚 20:42 读到的」就照它说,
 *   而不是写「未接入」。不传就照这一版之前那样走(展示台那份副本、只传 quota 的用例)。
 * @param agents **这台电脑上真有的那几家**(2026-09-27,卡 HC:`/state.agents` 的 id,
 *   服务端已经按探测筛过)。维护者在只装了豆包办公与 Codex 的全新 Air 上看到这一排里
 *   照样有 Claude 与 Kimi —— 原话:「千万不能写死」。**不传就退回 `AGENT_IDS`**
 *   (展示台那份副本、只传 quota 的那一批用例),行为与这一版之前一字不差。
 */
export function quotaCells(
  quota: Partial<Record<AgentId, QuotaEntry>>,
  thresholds: QuotaThresholds = {},
  now: Date = new Date(),
  peak?: DeepSeekPeakView,
  agentQuota?: readonly AgentQuotaView[],
  agents: readonly AgentId[] = AGENT_IDS,
): QuotaCell[] {
  return agents.map(agent => cellFor(agent, quota[agent], thresholds, now, peak, agentQuota?.find(one => one.id === agent)))
}

/**
 * 纯净模式顶栏的额度摘要(2026-09-11):四家各一段「名字 值」,用「·」连——额度格收起了,
 * 这一行是它的替身。「未接入」照样写出来(D13:不编数,也不闷声少一家)。
 */
export function quotaSummaryLine(cells: readonly QuotaCell[]): string {
  return cells.map(cell => `${cell.name} ${cell.value}`).join(' · ')
}
