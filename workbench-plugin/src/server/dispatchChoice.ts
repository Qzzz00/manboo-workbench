/**
 * **派活挑手**(2026-09-25,卡 O「派活的眼睛」;设计第一节第 3、4、7 条)。
 *
 * 三个问题,一处回答(派活、确认点、看板负责人驱动(卡 N)、界面上那张选项表都读这一份):
 *
 * 1. **这是什么活**(`jobKindOf`):写代码 / 改文件的活,还是问一句话、写段文案这种只要一段字的活。
 *    写代码的活**必须**交给「能改本机文件」的那只手 —— 今天 = Claude / Codex 的命令行(`handsFor`);
 *    交给聊天窗,回来的只会是「我没法访问你的文件」。
 * 2. **派给谁**(`dispatchChoices`):他点了名就听他的;没点名按规矩表里「派活默认分工」选
 *    (`divisionOf`:写代码的活派 Claude、综合要审美的派 Codex、Lapis 的活派 Kimi……),
 *    选项里**列全能做这件活的几家**。「事务官自己做」这一项 2026-09-28(卡 BS2,设计 C1)**拿掉了**:
 *    事务官不干活;派不出去 / 到上限时的三选一是「继续等 / 停掉 / 换一家」。
 * 3. **还剩多少额度**(`balanceOf` → `agentQuota.ts` 的 `quotaFor`):确认点里写「派给 Claude(本周还剩约 62%)」;
 *    每一家都落在三格之一 —— 有数 / 不限(查实过的,豆包)/ 没接上:原因(Muse、Manus 读不到时说为什么);
 *    快用完 / 用完了明说并建议换一家(D13:读不到就说读不到,不装作知道);
 *    **额度按到期先花**(2026-10-28,任务书第 10 条,`expiryPickOf`):候选里有「快重置且剩得多」的一家
 *    (哪扇窗 `reset_at` 在 24 小时内、`left_pct` 一半以上)→ 默认改派那一家,理由里说清哪家几点重置还剩多少。
 *
 * 规矩表里那条分工**从哪来**:引导落地时从存档里抽(`divisionFromArchive` → `divisionRuleText`,来源标「引导」),
 * 统筹 09-25 手加的那一条是它的样板;两条说的是一回事时只留一条(见 `rules.ts` `adoptTitled`)。
 *
 * 全是纯函数。
 */
import type {
  AgentCapsView, AgentDispatchFamily, AgentId, CapFixView, DispatchBalanceView, DispatchChoiceView, DispatchChoicesView, DispatchDefaultFrom,
  DispatchHand, JobKind, QuotaEntry,
} from '../protocol.ts'
import { JOB_KIND_TITLES, dispatchFamilyTitle, isAgentDispatchFamily, quotaAsOfClock } from '../protocol.ts'
// CODE_CLI_FAMILIES / hasCodeCli 的唯一定义在 protocol.ts(卡「名片编辑表单重排」挪过去的),这里引协议那份。
import { CODE_CLI_FAMILIES, hasCodeCli } from '../protocol.ts'
import type { CapCliFact } from './agentCaps.ts'
import { dispatchHands } from './agentDispatch.ts'
import { canReadSkills, skillsUnreadableWhy } from './dispatchSkills.ts'
import { channelAllowedFor } from './engine/registry.ts'
import type { DispatchTarget } from './dispatchTargets.ts'
import { dispatchTargets, knownFamilyTargets, targetTitle } from './dispatchTargets.ts'
import type { QuotaAdapterContext } from './agentQuota.ts'
import { balanceFromQuota, quotaFor, windowName } from './agentQuota.ts'
import type { RelayProvidersView } from './relayProviders.ts'

export { BALANCE_LOW_PCT } from './agentQuota.ts'

// ───────────────────────── 1. 这是什么活 ─────────────────────────

/** 一听就是写代码 / 改文件(不管挂没挂项目)。 */
const CODE_STRONG = new RegExp([
  '写代码|改代码|写个脚本|写脚本|编程|重构|修\\s*bug|bug|报错|崩了|崩溃|单测|跑测试|加测试|构建|编译|打包|部署|上线|发版',
  '|提交|commit|分支|合并|merge|pull\\s*request|\\bPR\\b|接口|函数|组件|前端|后端|数据库',
  // 「修一下首页球的显示问题」「改一下设置页的布局」:动词 + 界面 / 代码里的东西。
  '|修(一下|好|掉)?[^,,。;;]{0,10}(问题|显示|bug|报错)|改(一下|掉)?[^,,。;;]{0,8}(界面|页面|样式|布局|按钮|代码|文件|配置)',
  '|\\.(tsx?|jsx?|py|swift|go|rs|java|kt|css|html|vue)\\b',
  /*
   * ★ **查一张卡的根因**(2026-10-29,任务书「中枢派到窗口手不按发送」):「查 t-xxx 和 t-yyy 为什么派发
   * done 了卡还挂在进行中」这一类,是进仓库查账 / 查代码的根因活 —— 桌面 App 的窗口拿不到仓库,
   * 派给它只会把字贴进输入框等不到结果。判据是「查 + 卡号」(问的是某张卡哪里不对劲,不是问世界常识),
   * 或「卡号 + 为什么/怎么回事」(卡号在前、问根因在后)两种语序。
   */
  '|查[^,,。;;\\n]{0,40}\\bt-[0-9a-z]{4,12}\\b|\\bt-[0-9a-z]{4,12}\\b[^,,。;;\\n]{0,30}(为什么|怎么回事)',
].join(''), 'i')
/** 在一个代码仓库里做事的那几个动词(配上「挂着代码项目」才算)。 */
const CODE_VERBS = /做|改|修|加|补|实现|打磨|接上|接好|收尾|优化|完善|搭|调|换成|去掉|挪|显示|布局|页面|界面|样式|按钮|架构|同步|读取/
/** 一听就是只要一段字的活。 */
const CHAT_ONLY = /用一句话|一句话回答|只读地|问一下|问问|是什么|有几个|有多少|几点|翻译|总结一下|摘要|润色|起(个)?名|取名|写(一段|一篇|个|篇)?(文案|稿子|标题|简介|介绍)|想(个|几个)?(点子|标题)|查(一下)?(资料|新闻)|推荐|解释一下/
/** 内容类的活(挂在代码项目下也不算写代码):视频、文案、海报、播客…… */
const CONTENT_WORDS = /视频|文案|海报|播客|资讯|素材|选题|写稿|稿子|汇报材料|演讲|PPT|表格|报名/
/**
 * ★ **要在这台电脑上动手的活**(2026-10-02,卡 AG)。
 *
 * 现场(Air 0.4.85)她的原话:「我让他打开网易云音乐,事务官不能分派让 ai 去打开,
 * 只有在命令里加了【豆包】,他才会通过豆包打开」。病根:这种话从前落进 `chat`,
 * 而 `chat` 没点名时是**故意不派**的(事务官自己答)—— 可这一件它答不了,它得有人去点、去开。
 *
 * 认的是**动作 + 这台电脑上的东西**:开 / 关 / 退出 / 播 / 停 / 点 / 截图 / 调亮 / 音量 / 切换……
 * **一个 App 的名字都不写**(写了就是「网易云 → 豆包」那种补丁)。
 * 认错的代价也小:确认点里会把这一句复述给她,她一句话就能纠正(`jobKindOf` 的 `explicit`)。
 */
const DESK_WORDS = new RegExp([
  // 「打开 X」「把 X 打开」「帮我打开 X」—— 开 / 关 / 退出 / 启动 / 装上那一类。
  '(打开|开一下|启动|运行|关掉|关闭|退出|杀掉|重启)\\s*[^,,。;;]{0,12}(应用|软件|程序|app|App|APP)?',
  // 播放 / 暂停 / 停 / 放一首 —— 媒体那一类。
  '|播放|放一首|放首|暂停|停掉|下一首|上一首|静音',
  // 点 / 按 / 勾 / 填 / 复制 / 粘贴 / 截图 —— 在界面上动手那一类。
  '|点一下|点开|按一下|勾(上|选)|截图|截个图|复制到|粘贴到',
  // 调亮 / 音量 / 切换输入法 / 连 Wi-Fi —— 系统设置那一类。
  '|调亮|调暗|亮度|音量|切换(输入法|桌面|壁纸)|连(上)?(wifi|Wi-Fi|无线)',
].join(''))

/** 这一类里不算「在电脑上动手」的那几个说法(「打开话题」是在工作台里开一条话题,不是去点哪个 App)。 */
const DESK_NOT = /打开话题|打开这条|打开那条|打开看板|打开卡|打开项目|打开链接|打开网页|打开文档|打开表格/

export interface JobKindContext {
  /** 他 / 调用方明说了。 */
  explicit?: JobKind
  /** 这件事挂的项目有代码仓库(有目录)。 */
  inRepo?: boolean
}

/**
 * 这是写代码的活还是聊天的活。**明说的优先**;没明说按字认:
 * 一听就是代码的 → 代码;一听就是问一句 / 写段文案的 → 聊天;挂在代码仓库里、又是「做 / 改 / 修」这类动词的 → 代码;
 * 其余 → 聊天(那种活交给聊天窗也回得来一段字,交错了代价最小)。
 * 认的结果会写进确认点(「这是写代码的活 → 派给 Claude」),他看一眼就能纠正。
 */
export function jobKindOf(text: string, ctx: JobKindContext = {}): { kind: JobKind, why: string } {
  if (ctx.explicit !== undefined) return { kind: ctx.explicit, why: ctx.explicit === 'code' ? '点明了是写代码的活' : '点明了是聊天 / 问答的活' }
  const said = text.trim()
  if (CHAT_ONLY.test(said) && !CODE_STRONG.test(said.replace(CHAT_ONLY, ''))) return { kind: 'chat', why: '只要一段话的活' }
  if (CODE_STRONG.test(said)) return { kind: 'code', why: '要改代码 / 文件' }
  /*
   * ★ 放在代码之**后**、聊天之**前**(2026-10-02,卡 AG):
   * 「打开 settings.tsx 把按钮改成深色」是改代码(上一条已经认走);
   * 「打开网易云音乐」是要在这台电脑上动手 —— 从前它一路落到最后那条兜底的 `chat` 里。
   */
  if (DESK_WORDS.test(said) && !DESK_NOT.test(said)) return { kind: 'desk', why: '要在你这台电脑上动手(开 / 关 / 点 / 调)' }
  if (ctx.inRepo === true && CONTENT_WORDS.test(said)) return { kind: 'chat', why: '内容类的活,不改代码' }
  if (ctx.inRepo === true && CODE_VERBS.test(said)) return { kind: 'code', why: '挂在代码项目下、要动手改的活' }
  return { kind: 'chat', why: '没看出要改代码' }
}

// ───────────────────────── 2. 哪只手 ─────────────────────────

/**
 * 这一家做这一类活按顺序用哪几只手。
 *
 * - 聊天的活:照 `AGENT_HAND_ORDER`(Ben 09-22 定的 A3:Claude 走窗口,命令行只作 Codex 备用)一字不变;
 * - **写代码的活只用能改本机文件的手**:Claude / Codex 都是命令行(在指定目录里改、不用人批);
 *   别家没有这只手 → 空表 = 这家做不了这件活(派活那一层据此不派、说清为什么)。
 *   Codex 的窗口不算:窗口里的会话只能改 Codex App 当前打开的那个项目,要批准时得有人在电脑前(见 agentCaps.ts 文件头)。
 */
export function handsFor(family: AgentDispatchFamily | DispatchTarget, kind: JobKind): readonly DispatchHand[] {
  const target = typeof family === 'string' ? undefined : family
  const id = target?.id ?? (family as string)
  /*
   * ★ **「哪种活留哪几条通道」只在登记表那一处**(2026-10-03,卡「派活三只手收进引擎」:`engine/registry.channelAllowedFor`)。
   * 从前这里自己写一遍「desk 只留窗口、code 只留命令行」,引擎挑通道时又是一份 —— 两份一漂,候选名单上列得出、派下去走不到。
   * 这里只剩两件事:候选名单上这一家有哪几只手(`target.hands`;写代码那一类看的是「这一家有没有写代码的命令行」,
   * 那是能力事实,主人在 `agentCaps.hasCodeCli`),再按登记表那条规矩过滤。
   *
   * 要在这台电脑上动手的活只用「本机窗口」那只手(2026-10-02,卡 AG):只走接口的那一家(今天 = GPT)在云上,
   * 它动不了她的电脑;命令行那只手只改文件,也不点界面 —— 这条判据就是 `channelAllowedFor('desk', …)`。
   */
  const pool: readonly DispatchHand[] = kind === 'code' ? (hasCodeCli(id) ? ['cli'] : []) : (target?.hands ?? dispatchHands(id))
  return pool.filter(hand => channelAllowedFor(kind, hand))
}

/**
 * 这一派真会走**窗口**那只手吗(2026-10-27,卡 `t-bd1c04ed` 第一批)—— `window_dispatch`
 * 实验门的判据。判据与 `dispatchRun` 挑手同一处(第 763-765 行那一支),一处不重写:
 * `kind` 缺席问 `target.hands`(窗口在前的照旧算会走窗口);`kind` 明说问 {@link handsFor}
 * —— 写代码的活只看 code CLI 那只手(Kimi 自 2026-10-22 在列,`protocol.CODE_CLI_FAMILIES`),
 * 命令行派活不该被「读窗口」那一家的实验门误挡;豆包这类没有 code 手的,回空表 ≠ 会走窗口,
 * 也不拿实验门拦(派活那一层照真实判据说「只能聊天」)。
 */
export function dispatchUsesWindowHand(input: {
  family: AgentDispatchFamily
  kind?: JobKind | undefined
  target?: DispatchTarget | undefined
}): boolean {
  const hands = input.kind === undefined
    ? (input.target?.hands ?? dispatchHands(input.family))
    : handsFor(input.target ?? input.family, input.kind)
  return hands.includes('window')
}

// ───────────────────────── 3. 还剩多少 ─────────────────────────

/**
 * 一家此刻还剩多少(派活确认点里那一句)。**一处算**:`agentQuota.ts` 的 `quotaFor(id)` —— 每家落在三格之一:
 * 有数(取最紧的那一格,「周还剩 74%」不许盖住「5 小时只剩 9%」)/ 不限(查实过的)/ 没接上:原因。
 * `ctx` 缺席 = 只看采集器那几格(老调用方);窗口上读的那几家(Manus、Muse)要 `ctx.window` 才读得到。
 */
export function balanceOf(
  family: AgentDispatchFamily | 'dsh',
  quota: Partial<Record<AgentId, QuotaEntry>>,
  ctx: Omit<QuotaAdapterContext, 'quota'> = { now: new Date() },
): DispatchBalanceView {
  const view = balanceFromQuota(quotaFor(family, { ...ctx, quota }))
  // The adapter's first-seen cache time is not a collection timestamp.
  const entry = quota[family as AgentId]
  if ((entry?.kind === 'quota' || entry?.kind === 'balance') && entry.as_of === undefined) {
    const { read_at: _readAt, ...rest } = view
    return rest
  }
  return view
}

/**
 * ★ **派活前额度预检**(2026-10-28,演示断点①):点名的那家额度**查实是 0** → 不派,回话建议换一张名片。
 *
 * 现场:演示前交代「让小G修手机 App LiveKit 重连竞态」,小G(=Codex)的额度早已 0%,
 * 工作台没核、照派,那家命令行一起就撞 usage limit —— 交代掉在地上,还得她自己回来收拾。
 *
 * 判据就一格:**有数、没过期、level 是「空」**(「本周额度用完了」那种,第 3 节那三档里头
 * 过线/没读到的数翻进「未核实」之后到不了这里)。「快用完」不是「用完」(照旧能派,确认点里
 * 提一句);「没读到数」更不是 —— 那是不知道还剩多少,不是零,照旧派、派的时候再看。
 *
 * **一处判**:选项表(那一家标 `ok:false` + 这句 why)与派活那一层(`dispatchRun` 卡挂「等你处理」)
 * 读的是同一个函数,不许两处各写一遍阈值。
 */
export function quotaBlockOf(input: {
  family: AgentDispatchFamily
  options: readonly DispatchChoiceView[]
}): { why: string } | undefined {
  const option = input.options.find(one => one.family === input.family)
  if (option?.balance?.state !== 'numbers' || option.balance.level !== 'empty') return undefined
  return { why: `${option.balance.text} —— 换一张名片吧` }
}

/**
 * ★ **额度按到期先花**(2026-10-28,任务书第 10 条;维护者 14:3x:「Kimi 月额度明天要重置了,
 * 这种场景要怎么做成机制」)。选人从前只看「还剩多少」,不看「什么时候重置」—— Kimi 月窗还剩 79%、
 * 明早 8 点就重置,不花就作废。机制:默认项没定死(他没点名、也不是项目规矩)时,候选里有
 * 「快重置且剩得多」的一家 → 默认改派那一家(剩得多 × 重置近 = 不用就作废)。
 *
 * 判据(**一处判**,选项表与派活那一层读同一个函数):
 * - 只认 **ok、有数、已核实不旧**(`balance` 那一格与「额度用完换人」同一套口径 —— 未核实 / 低额 /
 *   用完了的家不参与抢,那是另一种处置);
 * - **快重置** = 哪扇窗的 `reset_at` 在未来、`EXPIRY_SOON_MS` 以内(24 小时,盖住「明早 8 点重置」),
 *   而且那扇窗自己的周期比线长 —— 5 小时窗 /「今日」本来就一天内重置,「快重置」只说给周 / 月这种长窗听;
 * - **剩得多** = 那一扇窗 `left_pct` 在 `EXPIRY_RICH_LEFT_PCT` 以上(一半,与任务书例程那半句同一个数);
 * - 一家有几扇窗都够格时取重置最近的那扇;几家都够格时**重置近的赢,同时刻剩得多的赢**;
 * - 重置时刻 / 窗口名说人话用现成的(`quotaAsOfClock` / `windowName`),不另造一套写法。
 *
 * 例程那一半(重置前 6 小时把积压的研发活列成建议递给她)不在这一处,在例程。
 */
export const EXPIRY_SOON_MS = 24 * 60 * 60_000
export const EXPIRY_RICH_LEFT_PCT = 50
/** 理由里那半句的尾巴(用例引常量,不逐字抄)。 */
export const EXPIRY_PICK_TAIL = '先用它'

/**
 * 这一扇窗自己的周期多长(毫秒)。认得出是**短窗**的给真数 —— 5 小时窗 /「今日」本来就一天以内
 * 重置,「24 小时内重置」对它们永远是真话,「快重置」这句话只说给周期比线长的窗(周 / 月)听;
 * 认不出的(各家自己起的行名)当长窗算,宁可算进,不替它判「不急」。
 */
function windowSpanMs(label: string): number | undefined {
  const hours = /^(\d+)\s*h$/i.exec(label)
  if (hours !== null) return Number(hours[1]) * 3_600_000
  if (label === '今日' || label === '今天') return 24 * 3_600_000
  return undefined
}

export interface ExpiryPick { option: DispatchChoiceView, why: string }

export function expiryPickOf(input: {
  options: readonly DispatchChoiceView[]
  quota: Partial<Record<AgentId, QuotaEntry>>
  now: Date
}): ExpiryPick | undefined {
  const nowMs = input.now.getTime()
  let best: { pick: ExpiryPick, resetMs: number, left: number } | undefined
  for (const option of input.options) {
    if (!option.ok) continue
    const balance = option.balance
    if (balance?.state !== 'numbers' || balance.level !== 'ok' || balance.stale === true) continue
    if (balance.read_at === undefined || !Number.isFinite(Date.parse(balance.read_at))) continue
    const entry = input.quota[option.family as AgentId]
    if (entry?.kind !== 'quota') continue
    for (const win of entry.windows) {
      if (win.reset_at === undefined) continue
      // 短窗(5 小时 / 今日)本来就一天内重置,谈不上「快」 —— 这句话只说给长窗(周 / 月 / 认不出的)听。
      const span = windowSpanMs(win.label)
      if (span !== undefined && span <= EXPIRY_SOON_MS) continue
      const resetMs = Date.parse(win.reset_at)
      // 重置时刻已过(读数是上一轮的)或超出「快重置」的线 → 这一扇不算。
      if (!Number.isFinite(resetMs) || resetMs <= nowMs || resetMs - nowMs > EXPIRY_SOON_MS) continue
      const left = Math.max(0, Math.min(100, Math.round(win.left_pct)))
      if (left < EXPIRY_RICH_LEFT_PCT) continue
      const clock = quotaAsOfClock(win.reset_at, input.now)
      if (clock === undefined) continue
      if (best !== undefined && (best.resetMs < resetMs || (best.resetMs === resetMs && best.left >= left))) continue
      best = {
        pick: { option, why: `${option.title} ${windowName(win.label)}还剩约 ${left}%,${clock} 重置,${EXPIRY_PICK_TAIL}` },
        resetMs,
        left,
      }
    }
  }
  return best?.pick
}

// ───────────────────────── 4. 分工(规矩表里那一条)─────────────────────────

/**
 * **一家能在这台电脑上动手的都没有**时如实说的那一句(2026-10-02,卡 AG)。**一处写**:
 * `default_why`、`line`、用例都用它 —— 这一类事务官自己不干,挑不出来就说挑不出来,不自己顶上。
 */
export const DESK_NO_HAND_WHY = '这台电脑上没有一家能替你动手(要一家装在本机、工作台送得进话的)'

/** 规矩表里「派活默认分工」那一条的标题。**唯一定义处**:引导落地写它、去重认它、挑手读它。 */
export const DIVISION_TITLE = '派活默认分工'

export interface Division {
  /** 写代码的活派谁。 */
  code?: AgentDispatchFamily
  /** 要在这台电脑上动手的活派谁(2026-10-02,卡 AG)。 */
  desk?: AgentDispatchFamily
  /** 综合、要审美的活派谁。 */
  synth?: AgentDispatchFamily
  /** 某个项目的活派谁(名字 + 别名,比如「Lapis」+ 仓库名「Echo」)。 */
  projects: readonly { name: string, aliases: readonly string[], family: AgentDispatchFamily }[]
}

/**
 * 一段字里点到的几家(按出现先后,去重)。
 *
 * ★ 2026-09-25(卡 Z):**认哪几个名字从登记表来**(`targets`;每家认它的名字 + `agentSources.ts` 里记的别名,
 * 比如「豆包」也写作 `doubao`)—— 运行时新接上一家,他写「Lapis 的活派 XX」也认得出。
 * 没传(老调用方)退回「写过专门接法的那几家」。整词匹配:英文名要求词边界,中文名直接找。
 */
export function familiesIn(text: string, targets?: readonly DispatchTarget[]): AgentDispatchFamily[] {
  const hits: { family: AgentDispatchFamily, at: number }[] = []
  for (const target of targets ?? knownFamilyTargets()) {
    let at = -1
    for (const word of [target.title, ...target.aliases, target.id]) {
      const needle = word.trim()
      if (needle.length < 2 || needle.includes('.')) continue
      const pattern = /^[\x20-\x7f]+$/.test(needle)
        ? new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
        : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      const found = pattern.exec(text)
      if (found !== null && (at === -1 || found.index < at)) at = found.index
    }
    if (at >= 0) hits.push({ family: target.id, at })
  }
  return hits.sort((a, b) => a.at - b.at).map(one => one.family)
}



const CODE_SUBJECT = /写代码|代码|编程|开发|研发/
const SYNTH_SUBJECT = /综合|审美|设计|创意|文案/
/** 「在电脑上动手的活派 X」那一类说法(2026-10-02,卡 AG)。 */
const DESK_SUBJECT = /电脑上(动手|操作)|动电脑|操作电脑|桌面操作|开关(应用|软件)|点界面/

/**
 * 从一条规矩的字里读出分工。认的是「X 的活派 Y」这种说法(统筹 09-25 手加那条、引导落地写的那条都是这个说法):
 * 「写代码的活派 Claude;综合、要审美的活派 Codex;Lapis(仓库 Echo)的活派 Kimi」。认不出回 undefined。
 */
export function divisionOfText(text: string, targets?: readonly DispatchTarget[]): Division | undefined {
  const body = text.includes(DIVISION_TITLE) ? text.slice(text.indexOf(DIVISION_TITLE) + DIVISION_TITLE.length).replace(/^[::\s]+/, '') : text
  const out: { code?: AgentDispatchFamily, desk?: AgentDispatchFamily, synth?: AgentDispatchFamily, projects: { name: string, aliases: string[], family: AgentDispatchFamily }[] } = { projects: [] }
  for (const clause of body.split(/[;;。\n]/)) {
    const found = /^\s*(.+?)的活(?:都|一律)?(?:派给|派|交给|给)\s*([A-Za-z]+|豆包)/.exec(clause)
    if (found === null) continue
    const subject = (found[1] as string).trim()
    const family = familiesIn(found[2] as string, targets)[0]
    if (family === undefined) continue
    if (DESK_SUBJECT.test(subject)) { out.desk ??= family; continue }
    if (CODE_SUBJECT.test(subject)) { out.code ??= family; continue }
    if (SYNTH_SUBJECT.test(subject)) { out.synth ??= family; continue }
    const name = subject.replace(/[((][^))]*[))]/g, '').trim()
    const aliases = [...subject.matchAll(/[((]([^))]*)[))]/g)].map(m => (m[1] as string).replace(/^仓库(名)?\s*/, '').trim()).filter(one => one !== '')
    if (name !== '') out.projects.push({ name, aliases, family })
  }
  return out.code === undefined && out.desk === undefined && out.synth === undefined && out.projects.length === 0 ? undefined : out
}

/** 规矩表里读分工:标题是「派活默认分工」的那条优先,其余里第一条读得出的。 */
export function divisionOf(rules: readonly { text: string, title?: string }[], targets?: readonly DispatchTarget[]): Division | undefined {
  const titled = rules.filter(rule => rule.title === DIVISION_TITLE || rule.text.startsWith(DIVISION_TITLE))
  for (const rule of [...titled, ...rules.filter(rule => !titled.includes(rule))]) {
    if (!/的活(?:都|一律)?(?:派给|派|交给|给)/.test(rule.text)) continue
    const found = divisionOfText(rule.text, targets)
    if (found !== undefined) return found
  }
  return undefined
}

/** 分工 → 规矩表里那一条的字(引导落地写进去的就是它)。 */
export function divisionRuleText(division: Division): string | undefined {
  const parts: string[] = []
  if (division.code !== undefined) parts.push(`写代码的活派 ${dispatchFamilyTitle(division.code)}`)
  if (division.desk !== undefined) parts.push(`在电脑上动手的活派 ${dispatchFamilyTitle(division.desk)}`)
  if (division.synth !== undefined) parts.push(`综合、要审美的活派 ${dispatchFamilyTitle(division.synth)}`)
  for (const project of division.projects) {
    const alias = project.aliases.length === 0 ? '' : `(仓库 ${project.aliases.join('、')})`
    parts.push(`${project.name}${alias}的活派 ${dispatchFamilyTitle(project.family)}`)
  }
  if (parts.length === 0) return undefined
  return `${DIVISION_TITLE}:${parts.join(';')}。问他派给谁时,这几家都要列成选项,默认项按这个分工选;他点名了就听他的。`
}

/** 引导存档里的所有字(递归收 answers 底下的字符串)。 */
function archiveTexts(value: unknown, depth = 0): string[] {
  if (depth > 6) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(one => archiveTexts(one, depth + 1))
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(one => archiveTexts(one, depth + 1))
  return []
}

/**
 * 引导存档 → 分工。他在引导里说的(`answers.habits.other` 那一段最常见):
 * 「Claude 擅长写代码,额度 Max 二十倍,大部分代码工作放这边」→ 写代码 = Claude;
 * 「Codex 用 GPT6 后审美好,倾向让它做综合性的事」→ 综合 = Codex;
 * 「Lapis 项目:仓库名还叫 Echo……Kimi 现在专门负责它」→ Lapis = Kimi(项目那一半用落地已经抽好的 `projects`)。
 *
 * **一句话里只点到一家**才认(两家挤在一句里分不清谁干什么,宁可漏认)。什么都没认出来回 undefined。
 */
export function divisionFromArchive(
  answers: unknown,
  projects: readonly { name: string, repo?: string, owner?: string }[] = [],
  targets?: readonly DispatchTarget[],
): Division | undefined {
  let code: AgentDispatchFamily | undefined
  let synth: AgentDispatchFamily | undefined
  for (const text of archiveTexts(answers)) {
    for (const sentence of text.split(/[。;;\n]/)) {
      // 逗号隔开的半句也各算一句(「Codex 用 GPT6 后审美好,倾向让它做综合性的事」整句只点到 Codex 一家)。
      const families = familiesIn(sentence, targets)
      if (families.length !== 1) continue
      const family = families[0] as AgentDispatchFamily
      if (code === undefined && /写代码|代码工作|编程/.test(sentence) && !/不(写|擅长|会)/.test(sentence)) code = family
      if (synth === undefined && /综合|审美/.test(sentence)) synth = family
    }
  }
  const owned = projects
    // 项目归谁:他在引导里填的那个名字,是不是一家能派活的(开集 —— 登记表说谁在;人那三档不算)。
    .filter(one => isAgentDispatchFamily(one.owner))
    .map(one => ({ name: one.name, aliases: one.repo === undefined || one.repo === one.name ? [] : [one.repo], family: one.owner as AgentDispatchFamily }))
  if (code === undefined && synth === undefined && owned.length === 0) return undefined
  return { ...(code === undefined ? {} : { code }), ...(synth === undefined ? {} : { synth }), projects: owned }
}

/** 这件活挂的项目 / 字里点到的项目,按分工该派谁。 */
function projectFamily(division: Division | undefined, text: string, projectName: string | undefined): { family: AgentDispatchFamily, name: string } | undefined {
  if (division === undefined) return undefined
  const hay = `${projectName ?? ''} ${text}`.toLowerCase()
  for (const project of division.projects) {
    const names = [project.name, ...project.aliases].map(one => one.toLowerCase()).filter(one => one !== '')
    if (names.some(name => hay.includes(name))) return { family: project.family, name: project.name }
  }
  return undefined
}

// ───────────────────────── 5. 选项表 ─────────────────────────

export interface ChoicesInput {
  text: string
  kind?: JobKind
  project?: { name?: string, path?: string }
  /** 他点了名的那家(卡上的负责人 / 原话里的「让 X 做」)。 */
  named?: AgentDispatchFamily
  caps?: AgentCapsView
  quota: Partial<Record<AgentId, QuotaEntry>>
  /** 额度适配器要的其余几样(装没装、模型从哪来、窗口上读到的 Manus 积分 / Muse 用量)。缺席 = 只看采集器那几格。 */
  quotaCtx?: Omit<QuotaAdapterContext, 'quota' | 'apiReady'>
  division?: Division
  /**
   * 能接活的每一家(2026-09-25,卡 Z:Agent 登记表算出来的 `dispatchTargets`)。
   * **有它就只认它** —— 缺席才退回「写过专门接法、装着的那几家」(老调用方、用例)。
   */
  targets?: readonly DispatchTarget[]
  /** 那家的 app 装没装(**只在 `targets` 缺席时**用来筛退路那一份)。 */
  installed: (family: AgentDispatchFamily) => boolean
  /** 接口那只手接得上(GPT 只有它)。 */
  apiReady?: boolean
  /**
   * 写代码的那几家,命令行此刻探到的事实(2026-10-22 卡 C 收尾):`found` = 这台电脑上 `resolveAgentCli` 真探到;
   * `login` = 登没登(Kimi 没有只本地的查法,只会是 `unknown`)。**带了它,「能换的几家」就只算
   * `found` 且登录状态不是 `no` 的家** —— 没装 / 还没探到的不列,别推荐一家这台机器上根本没有的命令行。
   * 缺席(老调用方) = 没有这一份事实,照旧只看体检那一格,一字不变。
   */
  cliFacts?: Readonly<Partial<Record<AgentDispatchFamily, CapCliFact>>>
  /**
   * 中转上配了哪几家上游(2026-09-26,卡 GH;`relayProviders.ts`)。**只在 `targets` 缺席时**用来筛退路那一份
   * (生产走 `targets`,里面已经筛过了);另外传给额度适配器,好让「中转没配这家」说得出来。
   */
  relayProviders?: RelayProvidersView
  /**
   * 从行为账里数出来的默认分派(2026-10-09,`habits.ts` 的 `dispatchDefault`):这一类事她改派过同一家 ≥2 次。
   * 排在「她点了名」之后、「规矩里归谁」之前 —— 她正是在按规矩推荐的那家上一再改派,才学出这一条。
   */
  learned?: (kind: JobKind, project?: string) => { family: AgentDispatchFamily, why: string } | undefined
  /**
   * 这件活带了哪几件技能(2026-10-21,卡 S)。带了就按「改文件」那一类算,读不了技能目录的那几家照列、标成不能派。
   * 缺席或空表 = 一字不变。
   */
  skills?: readonly string[]
}

/** 带技能的活为什么算「改文件」那一类(确认点里那半句)。 */
export const SKILLS_KIND_WHY = '带了技能,要在本机目录里读技能、写成果'

function capCell(caps: AgentCapsView | undefined, family: AgentDispatchFamily, cell: 'chat' | 'edit'): { state: string, note?: string, fix?: CapFixView } | undefined {
  const row = caps?.agents.find(one => one.family === family)
  if (row === undefined) return undefined
  const one = row.cells[cell]
  return { state: one.state, note: one.note, ...(one.fix === undefined ? {} : { fix: one.fix }) }
}

function quotaCtxOf(input: ChoicesInput): Omit<QuotaAdapterContext, 'quota'> {
  return {
    now: new Date(),
    ...input.quotaCtx,
    ...(input.apiReady === undefined ? {} : { apiReady: input.apiReady }),
    ...(input.relayProviders === undefined ? {} : { relayProviders: input.relayProviders }),
  }
}

/**
 * 候选里不在登记表那一份上的那一家(他点名了一家还没接上的、或者写代码那一档里没装的 Claude / Codex):
 * **照样列出来**,按它自己的专门接法算手与名字,选项上如实写它这会儿为什么用不了。
 */
function bareTarget(family: AgentDispatchFamily, all: readonly DispatchTarget[]): DispatchTarget {
  const found = all.find(one => one.id === family)
  if (found !== undefined) return found
  return { id: family, title: targetTitle(all, family), hands: dispatchHands(family), aliases: [], from_registry: false }
}

function optionFor(target: DispatchTarget, input: ChoicesInput, kind: JobKind): DispatchChoiceView {
  const family = target.id
  // 名字从登记表来(卡 Z):新接上一家,确认点里就是它自己的名字。
  const title = target.title
  const balance = balanceOf(family, input.quota, quotaCtxOf(input))
  const hands = handsFor(target, kind)
  if (kind === 'code') {
    if (hands.length === 0) {
      return { family, title, ok: false, why: `${title} 只能聊天,改不了你电脑上的文件`, balance }
    }
    const cell = capCell(input.caps, family, 'edit')
    if (cell !== undefined && cell.state === 'no') {
      return { family, title, ok: false, hand: 'cli', why: cell.note ?? `${title} 这会儿改不了你电脑上的文件`, ...(cell.fix === undefined ? {} : { fix: cell.fix }), balance }
    }
    /*
     * ★ **「能换的几家」只算命令行真探到、且登录状态不是 `no` 的**(2026-10-22 卡 C 收尾):
     * `hasCodeCli` 是能力事实(这一家有派活用的命令行),可这台电脑上**装没装**是另一回事 ——
     * Kimi 进了 `CODE_CLI_FAMILIES` 之后,没装 Kimi 的机器也把它列成「能换的」推荐给了用户。
     * Kimi 的登录状态只会是 `unknown`(没有只本地的查法),装了(`found`)就照列;没装 / 还没探到的不列。
     * 话照体检那一格的说(那一格把这些原因早就写成了一句人话)。
     */
    if (input.cliFacts !== undefined) {
      const fact = input.cliFacts[family]
      if (fact === undefined || !fact.found) {
        return { family, title, ok: false, hand: 'cli', why: cell?.note ?? (fact === undefined ? `还没查到 ${title} 能不能直接改你电脑上的文件,派的时候再看` : `这台电脑上没装 ${title}`), balance }
      }
      if (fact.login === 'no') {
        return { family, title, ok: false, hand: 'cli', why: cell?.note ?? `${title} 这会儿改不了你电脑上的文件`, balance }
      }
    }
    const unsure = cell === undefined || cell.state === 'unknown'
    return { family, title, ok: true, hand: 'cli', ...(unsure ? { why: `还没查到 ${title} 能不能直接改你电脑上的文件,派的时候再看` } : {}), balance }
  }
  const cell = capCell(input.caps, family, 'chat')
  if (cell !== undefined && cell.state === 'no') {
    return { family, title, ok: false, ...(hands[0] === undefined ? {} : { hand: hands[0] }), why: cell.note ?? `${title} 这会儿送不进去`, ...(cell.fix === undefined ? {} : { fix: cell.fix }), balance }
  }
  return { family, title, ok: true, ...(hands[0] === undefined ? {} : { hand: hands[0] }), balance }
}

/**
 * 这件活的选项表 + 默认项 + 确认点里那一句。
 *
 * 默认项的次序:**他点了名 → 规矩里这个项目归谁 → 规矩里这一类活归谁 →(写代码的活)第一家能改文件的 →(聊天的活)事务官自己**。
 * 按规矩挑到的那家做不了这类活(Lapis 归 Kimi,可这件要改文件)→ 落到下一条,并在 `default_why` 里说清;
 * 默认那家额度用完了 → 换成下一家额度没用完的,说清为什么换。**他点了名的不换**(做不了就如实说,由他定)。
 */
export function dispatchChoices(input: ChoicesInput): DispatchChoicesView {
  const inRepo = input.project?.path !== undefined && input.project.path !== ''
  const withSkills = (input.skills?.length ?? 0) > 0
  const { kind, why: kindWhy } = withSkills
    ? { kind: 'code' as const, why: SKILLS_KIND_WHY }
    : jobKindOf(input.text, { ...(input.kind === undefined ? {} : { explicit: input.kind }), inRepo })
  /*
   * ★ **候选从哪来**(2026-09-25,卡 Z):`input.targets` —— Agent 登记表算出来的那一份
   * (`dispatchTargets`:登记表里判成 Agent、接上了的每一家 + 只走接口的 GPT)。
   * 缺席(老调用方、用例)退回「写过专门接法、装着的那几家」。写代码的活只列能改本机文件的那几家。
   */
  const all = input.targets ?? dispatchTargets({
    installed: family => input.installed(family),
    ...(input.apiReady === undefined ? {} : { apiReady: input.apiReady }),
    ...(input.relayProviders === undefined ? {} : { relayProviders: input.relayProviders }),
  })
  /*
   * ★ **要在这台电脑上动手的活:候选 = 能动这台电脑的那几家**(2026-10-02,卡 AG)。
   * 筛的是**能力**(`handsFor(target,'desk')` 非空 = 有本机窗口那只手),不是哪一家的名字 ——
   * 新接上一家能操作电脑的客户端,它自动就在这张单子上。
   */
  const candidates: DispatchTarget[] = kind === 'code'
    ? CODE_CLI_FAMILIES.map(family => all.find(one => one.id === family) ?? bareTarget(family, all))
    : kind === 'desk'
      ? all.filter(one => handsFor(one, 'desk').length > 0)
      : [...all]
  // 他点了名、或者规矩里这个项目归它的那家,就算做不了也列出来(说清为什么做不了),别让他以为我们没看见。
  const byProject = projectFamily(input.division, input.text, input.project?.name)
  for (const extra of [input.named, byProject?.family]) {
    if (extra !== undefined && extra !== 'dsh' && !candidates.some(one => one.id === extra)) candidates.push(bareTarget(extra, all))
  }
  /*
   * ★ 本机没有的那一家(候选表里垫的空壳目标):照实说没装,**不算能派**(2026-10-01 Air:没装 Claude,
   * 事务官却说「换 Claude 来做」「也可以先交给 Claude 做」—— 那两处都从这里挑 ok 的)。点了名的照样列出来。
   */
  const options: DispatchChoiceView[] = candidates.map(target => (all.some(one => one.id === target.id)
    ? optionFor(target, input, kind)
    : { family: target.id, title: target.title, ok: false, why: `这台电脑上没装 ${target.title}`, balance: balanceOf(target.id, input.quota, quotaCtxOf(input)) }))
    // 带技能的活(卡 S):读不了技能目录的那几家照列、标成不能派 —— 原因就是这一条,登录之类的修法帮不上。
    .map(({ fix, ...option }) => (withSkills && !canReadSkills(option.family)
      ? { ...option, ok: false, why: skillsUnreadableWhy(option.title) }
      : { ...option, ...(fix === undefined ? {} : { fix }) }))

  for (const option of options) {
    const balance = option.balance
    if (balance?.state === 'numbers' && (balance.stale === true || balance.read_at === undefined || !Number.isFinite(Date.parse(balance.read_at)) || Date.parse(balance.read_at) > quotaCtxOf(input).now.getTime())) {
      option.balance = { ...balance, level: 'unknown', text: `额度未核实（${balance.text}）` }
    }
  }
  /*
   * ★ 派活前额度预检(2026-10-28,演示断点①):他点名的那家额度查实是 0 → 那一家标成派不出去,
   * 话里带「换一张名片」。与「没装」同款处置:他点了名的照列、不替他换 —— 他一句话就能改派。
   */
  if (input.named !== undefined) {
    const block = quotaBlockOf({ family: input.named, options })
    if (block !== undefined) {
      const named = options.find(one => one.family === input.named)
      if (named !== undefined) options[options.indexOf(named)] = { ...named, ok: false, why: block.why }
    }
  }
  const find = (family: AgentDispatchFamily | undefined): DispatchChoiceView | undefined => options.find(one => one.family === family)
  let chosen: DispatchChoiceView | undefined
  let from: DispatchDefaultFrom = 'fallback'
  let why = ''
  if (input.named !== undefined) {
    chosen = find(input.named)
    from = 'named'
    why = `你点名要 ${targetTitle(all, input.named)} 做`
  }
  if (chosen === undefined && input.named === undefined) {
    const habit = input.learned?.(kind, input.project?.name)
    const one = find(habit?.family)
    if (habit !== undefined && one !== undefined && one.ok) { chosen = one; from = 'learned'; why = habit.why }
  }
  if (chosen === undefined && byProject !== undefined) {
    const one = find(byProject.family)
    if (one !== undefined && (one.ok || one.fix !== undefined)) { chosen = one; from = 'project_rule'; why = `按规矩:${byProject.name} 的活派 ${one.title}` }
    else why = `按规矩 ${byProject.name} 的活派 ${targetTitle(all, byProject.family)},但它${kind === 'code' ? '改不了你电脑上的文件' : '这会儿用不了'};`
  }
  if (chosen === undefined) {
    const ruled = kind === 'code'
      ? input.division?.code
      : kind === 'desk'
        ? input.division?.desk
        : (SYNTH_SUBJECT.test(input.text) || /方案|规划|整理|调研/.test(input.text) ? input.division?.synth : undefined)
    const one = find(ruled)
    if (one !== undefined) { chosen = one; from = 'rule'; why += `按规矩:${kind === 'code' ? '写代码' : kind === 'desk' ? '在电脑上动手' : '综合、要审美'}的活派 ${one.title}` }
  }
  if (chosen === undefined && kind === 'code') {
    const one = options.find(option => option.ok) ?? options.find(option => option.fix !== undefined)
    if (one !== undefined) { chosen = one; why += `${one.title} 能改你电脑上的文件` }
  }
  /*
   * ★ **要在电脑上动手的活:没点名也要挑一家**(2026-10-02,卡 AG)。
   * `chat` 那条路「没点名就不派」是对的 —— 事务官自己答得了;这一类它答不了,
   * 不派就等于她那句话掉在地上(Air 0.4.85 现场)。挑第一家能动这台电脑的,
   * 然后把 `line` 复述给她点头(点头那一道在确认点,`confirmPoints.ts`)。
   */
  if (chosen === undefined && kind === 'desk') {
    const one = options.find(option => option.ok) ?? options.find(option => option.fix !== undefined)
    if (one !== undefined) { chosen = one; why += `${one.title} 能在你这台电脑上动手;事务官自己不干这一类活` }
  }
  /*
   * 挑不到一家(2026-09-28,卡 BS2):以前这里落到「事务官自己做」那一项上,那一项已经拿掉 ——
   * **没有默认项**,如实说没有一家能做 / 这一件不用派。写代码的活由他接一家上来或换一家,
   * 聊天的活事务官在对话里直接答(那不是派活)。
   */
  if (chosen === undefined) why += kind === 'code' ? '没有一家能改你电脑上的文件' : kind === 'desk' ? DESK_NO_HAND_WHY : '没点名的聊天活事务官自己答,不用派'

  // 默认那家额度用完了(他没点名时)→ 换下一家额度没用完、派得出去的。
  if (input.named === undefined && chosen !== undefined && (chosen.balance?.level === 'empty' || chosen.balance?.level === 'low' || chosen.ok && chosen.balance?.level === 'unknown' && from !== 'project_rule')) {
    const picked = chosen
    const others = options.filter(option => option.family !== picked.family && option.ok)
    const verified = (option: DispatchChoiceView): boolean => option.balance?.level === 'ok' && option.balance.stale !== true
      && (option.balance.state === 'unlimited' || option.balance.read_at !== undefined && Number.isFinite(Date.parse(option.balance.read_at)))
    const next = others.find(verified) ?? (picked.balance?.level === 'low' || picked.balance?.level === 'empty' ? others.find(option => option.balance?.level === 'unknown') : undefined) ?? (picked.balance?.level === 'empty' ? others.find(option => option.balance?.level === 'low') : undefined)
    if (next !== undefined) {
      why += `;但 ${picked.title} ${picked.balance?.text ?? ''},这次建议派 ${next.title}`
      why += next.balance?.level === 'low' ? `(${next.balance.text}；没有额度更宽裕的可用人选)` : verified(next) ? `(${next.balance?.text ?? ''})` : '(额度未核实,不代表额度更足)'
      chosen = next
      from = 'fallback'
    }
    else why += picked.balance?.level === 'unknown' ? ';额度未核实，保留原分工建议' : ';没有额度已核实且不低的替代人选'
  }
  /*
   * ★ 额度按到期先花(2026-10-28,任务书第 10 条):默认项(他没点名、也不是项目规矩)落定后,
   * 候选里有「快重置且剩得多」的一家 → 默认改派那一家,理由里说清哪家几点重置还剩多少
   * (「Kimi 本月还剩约 79%,08:00 重置,先用它」)。默认那家自己就是赢家时不换,理由也不重复这一句;
   * 他点了名的与项目规矩不在这一刀(点名听他,项目归谁是另一句拍板过的话)。
   */
  if (input.named === undefined && chosen !== undefined && from !== 'project_rule') {
    const pick = expiryPickOf({ options, quota: input.quota, now: quotaCtxOf(input).now })
    if (pick !== undefined && pick.option.family !== chosen.family) {
      why += `;${pick.why}`
      chosen = pick.option
      from = 'fallback'
    }
  }
  if (input.named !== undefined && chosen?.balance !== undefined && chosen.balance.level !== 'ok') why += `;${chosen.balance.text}`
  const marked = options.map(option => (chosen !== undefined && option.family === chosen.family ? { ...option, recommended: true } : option))
  return {
    kind,
    kind_why: kindWhy,
    ...(chosen === undefined ? {} : { default: chosen.family, default_from: from }),
    default_why: why.replace(/^;/, ''),
    options: marked,
    line: choiceLine(kind, chosen, marked),
  }
}

/**
 * 确认点里那一句:「写代码的活 → 派给 Claude(本周还剩约 62%);也能派给 Codex(…)、豆包(不限)、Muse(没接上:…)」。
 * **能换的每一家都列上、各带额度那一格**(有数 / 不限 / 没接上:原因)—— 统筹 09-25:派活确认里每一家都要有,
 * 没有空白、没有占位句。
 *
 * `chosen` 缺席 = 挑不到一家(2026-09-28,卡 BS2:「事务官自己做」那一项拿掉之后就有这一种):
 * 头一截如实说没有一家能做 / 这一件不用派,后面照旧把能换的几家列上。
 */
export function choiceLine(kind: JobKind, chosen: DispatchChoiceView | undefined, options: readonly DispatchChoiceView[]): string {
  const quotaText = (option: DispatchChoiceView): string => option.balance?.text ?? '没接上:还没找到这家的额度来源'
  const head = chosen === undefined
    ? (kind === 'code'
        ? `${JOB_KIND_TITLES[kind]} → 没有一家能改你电脑上的文件`
        : kind === 'desk'
          ? `${JOB_KIND_TITLES[kind]} → ${DESK_NO_HAND_WHY}`
          : `${JOB_KIND_TITLES[kind]} → 这一件事务官自己答,不用派`)
    : `${JOB_KIND_TITLES[kind]} → 派给 ${chosen.title}(${quotaText(chosen)})`
  const warn = chosen === undefined
    ? ''
    : !chosen.ok && chosen.why !== undefined
        ? `;${chosen.why}${chosen.fix === undefined ? '' : `(点「${chosen.fix.label}」)`}`
        : chosen.balance?.level === 'low' || chosen.balance?.level === 'empty' ? ',可以换一家' : ''
  const others = options.filter(option => option.family !== chosen?.family && option.ok)
  const names = others.map(option => `${option.title}(${quotaText(option)})`)
  const tail = names.length === 0 ? '' : `;${chosen === undefined ? '能派给' : '也能派给'} ${names.join('、')}`
  return `${head}${warn}${tail}`
}
