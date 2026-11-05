/**
 * **每一家的额度**(2026-09-25,卡 O;统筹:「额度/余额要覆盖派活名单里的每一家 —— Muse、Manus、豆包现在额度那里什么都没有」)。
 *
 * 一个口:`quotaFor(id, ctx)`,**按 agent id 取**。每家只落在三格之一(`AgentQuotaState`):
 * ① 有数(剩多少、什么时候重置);② 这家本来就不按额度算(**查实过的**,写出处)→「不限」;
 * ③ 读不到 →「没接上:原因」,能一键接上的给入口。**认不出的 id 一律回 ③「没接上:还没找到这家的额度来源」,
 * 不报错、不返回空。**
 *
 * 每家从哪读(查实的经过见 docs/交接-0925-派活的眼睛.md「额度覆盖每一家」):
 *
 * | 家 | 从哪读 | 落哪格 |
 * |---|---|---|
 * | DeepSeek(`dsh`)| 采集器:官方余额 / 工作台中转今日用量 | ① / ③ |
 * | Claude / Codex / Kimi | 采集器(窗口型额度)| ① / ③(没接上时说怎么接)|
 * | GPT | 走工作台的服务(接口那只手):中转**每个令牌每天一个花费上限**,GPT 与 DeepSeek 花的是同一份 | ① / ③ |
 * | 豆包 | 豆包办公的「订阅与额度管理」页:**当前时段 + 近 7 天**两扇窗各「已用 N%」、重置那一行(卡 QD)| ① / ③ |
 * | Manus | 首页右上角那一格积分(壳 `read_texts` 只读那一格)、积分用完 / 快用完的横幅 | ① / ③ |
 * | Muse | 「使用情况」页上的「已使用 N%」、窗口上的「已用完使用额度」(Meta:免费档有用量上限,到了等刷新或升级)| ① / ③ |
 *
 * **显示哪些家、派活候选有哪些家不在这里定**(2026-09-25 卡 Z 起由 Agent 登记表定:`server/dispatchTargets.ts`);
 * 这里只回答「这一家还剩多少」。认不出的 id 一律回「没接上:还没找到这家的额度来源」—— 运行时新接上的一家就是这一格,
 * 不报错、不返回空。
 * 新接一家:`registerQuotaAdapter(id, adapter)`;要从窗口上读的,再给 `registerWindowQuota(id, spec)`。
 *
 * ★ **2026-09-26(卡 QS):读到过的数不因为一会儿没刷新就翻成「没接上」。**
 *
 * 维护者早上:「Claude 的额度怎么突然显示为未接入了」。那天 Claude 桌面端的用量记录从昨夜 20:42 起就没再更新
 * (它没在跑),取数那一层按老规矩判「那份记录太旧」→ 这一格翻成「没接上」;记录一刷新又回到「本周还剩 69%」。
 * 按第一次用的人看,「没接上」= **从没接上**,又吓人又不对 —— 20:42 那个数是真读到过的。
 *
 * 所以三格的判法(**各家一致,就在这一处 `quotaFor`**)是:
 *   ① **有数** —— 读到过就一直显示,带上「几点读到的」(`read_at`;超过一刻钟没读到新的就把时刻写进 `line`);
 *      离读到那一刻超过 6 小时再标灰(`stale`)并多说一句「Claude 桌面没在跑,数字可能旧」;
 *   ② **不限** —— 查实过的那几家(Manus 限时免费期间的 ∞、Muse 那一页上写着「无限制」时)。
 *      **「谁说了一句」不算查实**:豆包 09-26 上午按一句话写成「不限」,当晚就被他拿那一页的截图打回来了(卡 QD)——
 *      往后这一格只认「它自己界面上写着」这种出处;

 *   ③ **没接上** —— 只剩两种:**从没读到过**,或者**来源确实断了**(没装、钩子没装、凭据清空了、要先授权
 *      —— 那几种打 `no_stale`,上次那个数不许顶上来,理由同 `protocol.ts` 的 `UnknownQuota.no_stale`)。
 *
 * 「上次读到的值 + 时刻」记在**这个模块的内存里**(下面的 `remembered`),不落盘。三条理由:
 *   - 它说的是「这台服务这一次运行里读到过什么」;重启后第一次真读到就有了新的,读不到就如实回「没接上」;
 *   - 现成的账本 `~/.dsh/workbench/last-quota.json`(quota/persist.ts)**只存值、没有时刻**,
 *     拿它当「几点读到的」就是替他编一个时刻(D13:不编数);
 *   - 这是几行 JSON 大小的东西,落盘反而多一处要清理的真实数据。
 */
import type {
  AgentId, AgentQuotaFixView, AgentQuotaView, ClientsView, DispatchBalanceView, QuotaEntry, QuotaWindow,
} from '../protocol.ts'
import {
  QUOTA_AS_OF_STALE_AFTER_MS, QUOTA_STALE_VALUE, dispatchFamilyTitle, quotaAsOfClock, quotaAsOfWords,
} from '../protocol.ts'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { bundleForEntry } from './agentSources.ts'
// Antigravity 走原生那条路(2026-09-27,卡 AN):直接问它自己在本机的语言服务。
// 令牌是它自己放在命令行与日志里的,我们**现取现用、用完就丢**,一个字都不落地(见那个模块的文件头)。
import type { AntigravityGroup } from '../quota/antigravityNative.ts'
import type { HelperRequest } from './helperChannel.ts'
// 开集那条路(2026-09-26,卡 QO):通用正则、问模型那一段、判词采信不采信、重读的方子 —— 全是纯函数。
import type { OpenQuotaNumbers, OpenQuotaRecipe } from './openQuota.ts'
import {
  OPEN_QUOTA_BUDGET_WHY, OPEN_QUOTA_HINT, OPEN_QUOTA_MAX_JUDGE_GROUPS, OPEN_QUOTA_MAX_TOKENS,
  OPEN_QUOTA_NOT_SEEN, OPEN_QUOTA_PATTERNS, openQuotaEstimate, openQuotaMissShort, openQuotaMissWhy, openQuotaPrompt, openQuotaRecipe,
  openQuotaWorth, parseOpenQuotaVerdict, rereadOpenNumbers, trustOpenQuota,
} from './openQuota.ts'
import type { RelayProvidersView } from './relayProviders.ts'
import { API_HAND_PROVIDER_MISSING_WHY, relayHasProviderFor } from './relayProviders.ts'

// ───────────────────────── 人话的小零件 ─────────────────────────

/** 快用完了的线(同额度面板变黄那条)。 */
export const BALANCE_LOW_PCT = 15

/**
 * 窗口型那几格的判级(2026-10-23,卡 t-8e617888):耗尽 ≤1 / 低额 < `BALANCE_LOW_PCT` / 其余有数。
 * **一处判**:额度面板的横条与剩余额度告警读的是同一个函数,不许各写一套阈值。
 */
export function quotaLevelOfPct(leftPct: number): 'ok' | 'low' | 'empty' {
  const pct = Math.max(0, Math.min(100, Math.round(leftPct)))
  return pct <= 1 ? 'empty' : pct < BALANCE_LOW_PCT ? 'low' : 'ok'
}

/** 窗口名 → 人话。 */
export function windowName(label: string): string {
  if (label === '周' || /^7d$/i.test(label) || label === '7 天') return '本周'
  if (label === '月') return '本月'
  if (label === '今日') return '今天'
  const hours = /^(\d+)\s*h$/i.exec(label)
  if (hours !== null) return `${hours[1]} 小时窗口`
  return label
}

/** 名字嵌进中文句子:英文名两边留空格,中文名不留(「读不到 Kimi 的余额」「读不到豆包的余额」)。 */
export function inSentence(name: string): string {
  return /^[\x00-\x7F]+$/.test(name) ? ` ${name} ` : name
}

/**
 * 名字**起头**一句话:英文名后面留一个空格,中文名不留(「Manus 没开着」「豆包办公没开着」)。
 * 2026-09-26(卡 QD):豆包办公从「不限」改成从窗口上读之后,「没接上」那几句里第一次出现中文家名 ——
 * 原来那几处是写死的半角空格,念出来是「豆包办公 没开着」。英文名那几句一个字节没变。
 */
export function leadName(name: string): string {
  return /^[\x00-\x7F]+$/.test(name) ? `${name} ` : name
}

function titleOf(id: string): string {
  if (id === 'dsh') return 'DeepSeek'
  // 卡 Z:开集 —— 认不出的家名原样用它自己(界面上会被登记表里的名字盖掉)。
  return dispatchFamilyTitle(id)
}

function clock(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * 「几点读到的」写成人话(2026-09-26,卡 QS):今天只写几点(「今天」是废话);昨天写「昨天 09:15」,
 * 昨天傍晚以后写「昨晚 20:42」(维护者原话就是这么说的);更早写「09-24 20:42」(同额度格里重置时刻那一套写法)。
 * 认不出的时刻回 undefined —— 界面上宁可不写,也不糊一个 ISO 串或编一个时刻(D13)。
 *
 * 2026-10-02(卡 QA):实现搬进 `protocol.ts` 的 `quotaAsOfClock` —— 展示台与手机各有一份协议副本,
 * 同一套写法两处各写一遍迟早长不一样,所以**契约那一处**出函数,这里只留个名字(老的 import 不用改)。
 */
export const readWhen = quotaAsOfClock

/** ③ 没接上。`short` 给派活确认点括号里用;`no_stale` = 来源确实断了,上次读到的数不许顶上来。 */
function unconnected(id: string, why: string, extra: { short?: string, fix?: AgentQuotaFixView, no_stale?: true } = {}): AgentQuotaView {
  return {
    id,
    title: titleOf(id),
    state: 'unconnected',
    line: `没接上:${why}`,
    ...(extra.short === undefined ? {} : { short: `没接上:${extra.short}` }),
    why,
    ...(extra.fix === undefined ? {} : { fix: extra.fix }),
    ...(extra.no_stale === undefined ? {} : { no_stale: true }),
  }
}

/**
 * 采集器那一格(窗口型 / 余额型)→ ① 有数;取不到回 undefined(调用方再决定说哪种「没接上」)。
 * 窗口型**取最紧的那一格**(「周还剩 74%」不许盖住「5 小时只剩 9%」)。
 */
function numbersFromEntry(id: string, entry: QuotaEntry | undefined, prefix = ''): AgentQuotaView | undefined {
  if (entry === undefined || entry.kind === 'unknown') return undefined
  const title = titleOf(id)
  /**
   * **截至时刻用来源自己给的那个**(2026-10-02,卡 QA)。
   *
   * 在此之前这一格没有时刻,`withMemory` 只能退回「这次运行里第一次看见这个值」的时刻 —— 那是个
   * 代用品:服务一重启就变成「刚读到的」,04:27 的数于是在 21:3x 看起来崭新。桌面端那条路
   * **知道样本自己的时刻**(`as_of`),拿过来当 `read_at`,那一格才说得出自己的年纪。
   */
  const dated = {
    ...(entry.as_of === undefined ? {} : { read_at: entry.as_of }),
    ...(entry.source === undefined ? {} : { source: entry.source }),
    // 过线那一格该说什么(2026-10-02,卡 QK):**各家额度来源自己声明的那一份,原样带过来**。
    // 这里一个家名都不写 —— 以前这是 `STALE_HINTS` 那张按家名写死的表(见 `dated`)。
    ...(entry.stale_hint === undefined ? {} : { stale_hint: entry.stale_hint }),
  }
  if (entry.kind === 'balance') {
    const total = Number(entry.total)
    if (!entry.available || !Number.isFinite(total)) return undefined
    const level = total <= 0 ? 'empty' : total < 5 ? 'low' : 'ok'
    const line = total <= 0 ? `${prefix}余额用完了` : `${prefix}余额还有 ${entry.total} ${entry.currency}`
    return { id, title, state: 'numbers', line, level, left: { text: entry.total, unit: entry.currency, amount: total }, ...dated }
  }
  let tightest: { label: string, left_pct: number, reset_at?: string } | undefined
  for (const window of entry.windows) {
    if (!Number.isFinite(window.left_pct)) continue
    if (tightest === undefined || window.left_pct < tightest.left_pct) tightest = window
  }
  if (tightest === undefined) return undefined
  const level = quotaLevelOfPct(tightest.left_pct)
  const pct = Math.max(0, Math.min(100, Math.round(tightest.left_pct)))
  const name = windowName(tightest.label)
  const reset = tightest.reset_at === undefined ? {} : { reset_at: tightest.reset_at }
  /**
   * **来源真实的那几扇窗全透传**(2026-10-23,卡 t-8e617888):`windows` 这一格契约上早有
   * (形状 = 老四格那份 `QuotaWindow`),但采集器这几家以前只顶「最紧的一扇」,
   * 告警想说清「真正紧张的是哪一扇」就没了依据 —— 在这里补齐,告警只消费统一视图,
   * 不各家另抓。消费方对照用例:tests/quota-alerts-20261023.test.ts。
   */
  const windows = { windows: entry.windows }
  if (level === 'empty') return { id, title, state: 'numbers', line: `${prefix}${name}额度用完了`, level, left_pct: pct, ...reset, ...dated, ...windows }
  if (level === 'low') return { id, title, state: 'numbers', line: `${prefix}${name}只剩约 ${pct}%,快用完了`, level, left_pct: pct, ...reset, ...dated, ...windows }
  return { id, title, state: 'numbers', line: `${prefix}${name}还剩约 ${pct}%`, level, left_pct: pct, ...reset, ...dated, ...windows }
}

// ───────────────────────── 从窗口上读的那几家 ─────────────────────────

/** 壳 `read_texts` 回来的一段命中(只有命中的那一小段,带位置;`window` = 在这个 App 的第几扇窗上)。 */
export interface WindowTextMatch { id: string, text: string, x: number, y: number, window?: number }

/** 从窗口上读的那几家:最近一次读成的 + 最近一次尝试。 */
export interface WindowQuotaReading {
  /** 最近一次**找到了**额度那几格的时候(读到的那几小段,**同一扇窗上的**)。 */
  last?: { at: string, matches: readonly WindowTextMatch[], width?: number }
  /**
   * 最近一次尝试:没读成是为什么(`found:false` = 窗口读到了,但额度那一格这会儿不在窗口上)。
   * `offspace` = 这个 App 有几扇窗**不在这会儿显示着的那个桌面(Space)上** —— 辅助功能看不见它们
   * (2026-09-26 卡 MQ;卡 MQ2 起这个数是壳真去数的,不是减出来的)。
   * `hidden` = 这个 App 这会儿**被藏起来了**(⌘H,或者工作台自己把它藏回去)—— 藏着的窗一扇都读不到,
   * 而他要做的下一步跟「窗在别的桌面上」完全不同(点一下图标放出来 vs 切桌面),所以分开记(卡 MQ2)。
   */
  attempt?: { at: string, found: boolean, error?: WindowReadError, note?: string, offspace?: number, hidden?: boolean }
}

/**
 * 读窗口没读成的几种。
 *
 * ★ `app_asleep`(2026-09-26,卡 QD 真机撞出来的):**那个 App** 的辅助功能通道这会儿没开
 * —— Chromium 那几家(豆包办公、Manus、Grok Bot、Antigravity)刚起来、或者很久没有辅助功能客户端
 * 读过它时,壳敲了门(`AXManualAccessibility`)树也不是当场就建好,第一下回 -25204。
 * **这与 `no_ax`(工作台自己还没被授权)是两件事**:后者要他去系统设置里点一下,
 * 前者过一会儿就好 —— 混在一起报,界面上会写「工作台 App 还没有辅助功能权限」(一句假话),
 * 而且 `no_ax` 打着 `no_stale`,连上次真读到的那个数都被压掉。
 * 实测(豆包办公,19:0x):第一下 3017ms 回 -25204,紧接着第二下 704ms 就把那一页八小段全读到了。
 */
export type WindowReadError = 'no_helper' | 'no_ax' | 'old_shell' | 'not_running' | 'no_window' | 'app_asleep' | 'failed'

/**
 * **额度在哪一页、怎么自己到那一页**(2026-10-03,卡 QZ)。
 *
 * 维护者 10-03:「不用写原因,我要的是解决」—— 格子停在 09-26 不是因为话说得不清,
 * 是因为**没人替她去那一页**。所以一家一条,写在这一家的读法旁边(不另起一张按家名的表)。
 *
 * - `page` —— 页名,**查实过的原话**(就是 `patterns` 里那条 `page` 正则认的那几个字、
 *   也是界面上那句话里念的那一个)。
 * - `link` —— 一条能**直接开到那一页**的深链。**查实过才写**:2026-10-03 在维护者机器上
 *   逐个读了各家 `Info.plist`,豆包(`com.bot.pc.doubao`)**连 `CFBundleURLTypes` 都没有**;
 *   Muse(`hatch` / `endo-window`)、Manus(`manus`)、Grok Bot(`grokbot` / `sand`)注册了 scheme,
 *   但**没有一条查实过能开到额度那一页** —— 所以今天这一格一家都不写(D13:不猜一条深链去开她的 App)。
 * - `press` —— 没有深链时照这几颗键按过去(标签原话;壳按 `agent_press` 那套识别认,不另写一套)。
 * - `back` —— 读完**按原路按回去**那几颗键的原话(2026-10-03,卡 QP)。只在走过 `quota_page`
 *   那条路(不抢焦点那条)之后按;认不到就只把窗藏回去 —— 她眼前照旧什么都没多,
 *   只是那家留在了额度页上。
 *
 * ★ **2026-10-03(卡 QP):`press` 不再只能在她亲手点「读一下」时走。**
 * 新壳有了一条不叫台前的 `quota_page`(只 `unhide`、只 `AXPress`),所以**自动那一轮也能翻页**;
 * 老壳(没有这一格 caps)照旧 —— 只有她亲手点时才走 `agent_press`(那一条会把那家叫到台前)。
 *
 * ★ **这三格今天一格都没填**,是查实的结果,不是忘了(2026-10-03 在维护者机器上用
 * `probe quota-keys` / `probe quota-page` 逐家量过,见 `docs/交接-1003-壳后台翻到额度页.md` 第 4 节):
 * - Muse(`com.meta.endo`):主窗侧栏那几颗键是 `Library` / `Goals` / `Ideas` / `Feed` / `Search` / `Chat`
 *   —— **没有一颗通向「使用情况」**;那一页在它**设置那扇窗**上,而设置的入口是它菜单栏里的
 *   「设置…」,菜单项的亮 / 灰跟着「谁在台前」变(见壳 `TextInsert.openNewConversation` 那段)——
 *   也就是说**非得抢焦点**,这条 op 到不了。真按一颗(`Library` → 回 `Chat`)量过:后台 `AXPress`
 *   按得动、不抢焦点、按完藏回去,所以**路是通的,缺的是一颗通向那一页的键**。
 * - 豆包(`com.bot.pc.doubao`):这台机器上它的**辅助功能通道压根不通**(放出来之后仍回 -25204,
 *   连一扇窗都列不出,三次都一样)—— 它今天读不到额度**不是「没翻到那一页」**,是更前面一步坏了。
 * - Manus(`im.manus.desktop`):没在跑(卡里说了不起它);它的额度在**首页**,
 *   而后台起它那一支(卡 QZ)起来就在首页,多半压根不用按键。
 *
 * ★ **2026-10-03(卡「豆包闪一下 / Grok 读键字」,维护者 21:4x 原话「行,处理吧」):多两格。**
 *
 * - `front_ok` —— 这几颗键**非在台前按不动**,而且维护者同意「只在那一格真坏了的时候闪一下」。
 *   今天只有豆包(`com.bot.pc.doubao`):它那颗键弹的是 Chromium 交给系统画的**原生弹出菜单**,
 *   后台 `AXPress` 回 success 而整扇窗的树一个字没变(卡 QT 真机:visited 388 → 388,
 *   应用元素底下也没多出 `AXMenu`)。所以这一格**既是许可、也是限制**:
 *   没拿到「闪」这一下的那几轮**一颗都不按**(背着台前按只是每 10 分钟白按一下她的 App,D13)。
 *   什么时候才闪,两道门在 `reachPage` 里:这一格的数真过了线(`worthUnhiding`,2 小时)+
 *   同一家 90 分钟最多一次(`QUOTA_FRONT_GAP_MS`)。
 * - `read_titles` —— 读这一家的时候**连「键身上的字」也读**(壳 `read_texts` 的 `include_titles`)。
 *   今天只有 Grok Bot:它的额度写在一颗 `AXMenuItem` 身上(「SuperGrok 6%」),
 *   而整扇窗的静态字里一个百分号都没有(卡 QT 真机:89 块字、命中 0)。
 *   **这一格必须按家声明、不许全局打开** —— Muse / 豆包那条「这确实是额度那一页」的旁证是按
 *   **整格静态字**认的(`^使用情况$` / `^(?:订阅与额度管理|标准套餐)$`),一颗叫「使用情况」的
 *   侧栏键会把那条旁证骗过去,那比读不到坏得多(卡 MQ 的老教训:假阳性比读不到坏)。
 */
export interface QuotaPageReach {
  page: string
  link?: string
  press?: readonly string[]
  back?: readonly string[]
  /** 这几颗键非台前不可(= 只在那一格真坏了的时候闪一下,过不了那两道门就一颗都不按)。 */
  front_ok?: boolean
  /**
   * 闪到台前那一下,**第一颗键用合成鼠标点击按**(壳 `quota_page` 的 `click`;2026-10-04 卡「豆包台前点一下」)。
   *
   * 只有豆包:它那颗「标准套餐」`AXPress` 回 success 而那一页压根不开(卡「豆包闪一下」真机
   * `menu_roots: 0`),她自己点就开 —— 维护者 10-04 拍板「可以」。
   * 要 `front_ok` 一起才作数(壳那边 `clicksThisStep` 的第 2、3 条),而且**这份壳得会这一下**
   * (caps `quota_click`);不会就一下都不闪(闪过去也只是白按)。
   */
  front_click?: boolean
  /** 读这一家时连「键身上的字」也读(壳的 `include_titles`;**只给查实过的那一家**)。 */
  read_titles?: boolean
}

/** 这一家要从窗口上找的那几小段(正则;`top` = 只认顶栏这么多点以内)。 */
export interface WindowQuotaSpec {
  bundleId: string
  patterns: readonly { id: string, regex: string, top?: number }[]
  /** 读到的那几小段 → 这一格;认不出回 undefined(= 这会儿额度那一格不在窗口上)。 */
  parse: (last: NonNullable<WindowQuotaReading['last']>) => AgentQuotaView | undefined
  /** 额度在哪一页、怎么到那一页(2026-10-03,卡 QZ)。缺席 = 这一家说不出页名,照旧只读一次。 */
  reach?: QuotaPageReach
}

/**
 * **把一个 App 在后台拉起来**:`open -g -b <包标识>`。
 *
 * `-g`(不激活)是这一下的要害 —— 少了它,10 分钟一轮的读额度会把她正在用的窗口顶掉
 * (维护者 10-03:「起完藏到后台,不抢她的焦点」)。按**包标识**拉(同 `agentSources.openCommandFor`),
 * 所以运行时新接上的一家也拉得起来。
 */
export function backgroundOpenCommand(bundleId: string): readonly string[] {
  return ['open', '-g', '-b', bundleId]
}

/** **开一条深链**,同样不抢焦点(`open -g <地址>`)。 */
export function backgroundLinkCommand(url: string): readonly string[] {
  return ['open', '-g', url]
}

/**
 * 这一轮对这一家该走哪一步(**一处判**,窗口型与开集那条路共用)。
 *
 * - `in_use` —— 它在前台 = **她正用着它**:这一轮一个指头都不碰(连格子都不写,原因只进日志);
 * - `launch` —— 它没在跑:**她亲手点「读一下」才**后台起它(`backgroundOpenCommand`),起完藏到后台再读;
 *   自动那一轮记 `not_running` 不起它(2026-10-19:她关掉的 App 不由工作台开回来);
 * - `read` —— 在跑(藏着也算):直接读,藏着的由壳放出来读完藏回去。
 *
 * **问不出来(`undefined`:老壳不会 `running_apps`、或者这一下没回话)照旧只读一次** ——
 * 不凭空拉起一个 App、也不凭空跳过一轮(D13:查不到不许冒充查到了)。
 */
export type QuotaReadStep = 'in_use' | 'launch' | 'read'

export function quotaReadStepFor(app: { running: boolean, active: boolean } | undefined): QuotaReadStep {
  if (app === undefined) return 'read'
  if (app.active) return 'in_use'
  return app.running ? 'read' : 'launch'
}

/**
 * ★ **藏着的那一家,这一轮值不值得为它放一次窗**(2026-10-03,卡 QZ)。
 *
 * 这是 09-27 那条拍板**唯一说对了的那一半**:壳放出来那一下虽然**不 activate**(不抢焦点、不叫台前),
 * 可那几扇窗**确实会露在屏上**一两秒 —— 维护者当时看见的「依次闪过 manus、muse、豆包、Grok bot
 * 四个应用」就是这一下。所以这张卡没有把那半句简单丢掉,而是把它**换了个判据**:
 *
 * - **这一格的数还没过线 → 不放**(线 = `QUOTA_AS_OF_STALE_AFTER_MS`)。界面上写着的还是一个
 *   当得起「此刻」的数,为它闪一下她的屏幕是纯粹的打扰 —— 没坏的不去修。
 * - **过了线 → 放**。那一格此刻写的是「读不到最新的」,一两秒的一闪换回一个真数,值。
 *   10 分钟一轮,所以一格最多旧 10 分钟。
 * - **她亲手点了「读一下」→ 一律放**(她正在等这一下,不存在打扰)。
 * - **没藏起来的那一家压根不经过这道门**:读它一个窗都不用动,一次都不闪。
 *
 * 这样「闪过」从「每 10 分钟四家各一次」变成「只在某一格真的坏了的时候」。
 */
export function worthUnhiding(input: { lastAt?: string, byHand: boolean, now: Date }): boolean {
  if (input.byHand) return true
  if (input.lastAt === undefined) return true
  const age = input.now.getTime() - new Date(input.lastAt).getTime()
  if (!Number.isFinite(age) || age < 0) return true
  return age > QUOTA_AS_OF_STALE_AFTER_MS
}

/** 还没认出过用量页的一家,两次试「全套认一遍」(要叫模型)之间至少隔多久(2026-09-27)。 */
export const QUOTA_FIRST_TRY_GAP_MS = 30 * 60_000

/**
 * 读到的数**多久之后不许再冒充当下**。
 *
 * - 2026-09-26(卡 QS)这里是 6 小时,过线只**标灰** + 多说一句「…没在跑,数字可能旧」,那个百分比照显示。
 * - 2026-10-02(卡 QA)维护者 21:3x:「本机上的 Claude 额度,一晚上了,还是 100%」—— 标灰不够。
 *   她看见的还是一个百分比,还是把它当此刻的用量;那个 100% 是桌面端 **04:27** 落的样本
 *   (`{fh:0, sd:18}`,5 小时窗口刚重置)算出来的,而她整晚都在用 Claude。
 *   所以线收到 **2 小时**、过线**连百分比都不出**,只说「读不到最新的,上次 04:27」。
 *
 * 线与那几句话都在**契约那一处**(`protocol.ts` 的 `QUOTA_AS_OF_STALE_AFTER_MS` / `quotaAsOfWords`),
 * 这里只是个别名 —— 老的 import 不用改。
 */
export const QUOTA_STALE_AFTER_MS = QUOTA_AS_OF_STALE_AFTER_MS

/**
 * **切走那一下之后等多久才读**(2026-09-27,卡 AG 追加)。
 *
 * 连着 Cmd-Tab 按五下是一件事,不是五件事:这个窗口里来的几下并成一次读。
 * 1.2 秒:比一次 Cmd-Tab 的手速宽,又短到他切回工作台时那个数已经是新的。
 */
export const QUOTA_NUDGE_DEBOUNCE_MS = 1_200

/**
 * **后台起一个 App 之后等多久再把它藏回去**(2026-10-03,卡 QZ)。
 *
 * 1.2 秒:`open -g -b` 回来的那一刻进程刚起,窗还没建出来 —— 这会儿 `hide_app` 等于藏一个还没有窗的 App,
 * 它随后把窗建出来仍旧露在屏上。比一次冷启动的首帧宽一点,又短到整条链(起 → 藏 → 读)还在几秒之内。
 * 起不来那一支压根走不到这里(命令就没跑成)。
 */
export const QUOTA_LAUNCH_SETTLE_MS = 1_200

/** **替她走到那一页之后等多久再读**(卡 QZ)。深链 / 按一颗键之后那一页要渲一拍,900ms 同卡 QD 那条「再看一眼」。 */
export const QUOTA_REACH_SETTLE_MS = 900

/**
 * ★ **开完一条深链之后等多久再读**(2026-10-03,卡 QT)。
 *
 * 900ms 那一格是给「在同一扇窗里换一片界面」定的;深链要的是**另开一扇窗**,那扇窗得先建出来、
 * 它里面那一层网页树还得建一遍。真机上量到的(Muse,`probe quota-link com.meta.endo endo-window://settings`):
 *
 * - 开完 **1.5 秒**那一下读:三扇窗都列得出,「使用情况」那一页上一条都没命中;
 * - 几秒之后再读:`使用情况` / `Free plan` / `Weekly limit resets on Oct 8` / `0% used` 四条全命中。
 *
 * 所以这一支单给一格 2.5 秒。**没量到「2.5 秒一定够」**(没法在她机器上反复关掉那扇设置窗再开),
 * 这是照那两次之间取的一个数;真不够也不会错一个数:那扇设置窗开着不会自己关,下一轮(10 分钟)就读到了。
 */
export const QUOTA_LINK_SETTLE_MS = 2_500

/**
 * ★ **同一家最快隔多久才再后台起一次**(2026-10-03,卡 QZ)。
 *
 * 为什么非有这条线不可:10-02 Air 那位运营同学撞上的正是反面
 * ——「我让他打开网易云音乐……完成后每隔 10s 又自行打开。。不断弹窗」(那件事治出了
 * `appOpenLog.ts` 整个文件)。10 分钟那一轮接回来之后,**一个被她亲手退掉的 App
 * 会每 10 分钟被工作台重新拉起一次** —— 那是同一个毛病,只是慢了六十倍。
 *
 * 90 分钟:**比那条「读到的数多久就不许再冒充当下」的线(`QUOTA_AS_OF_STALE_AFTER_MS`,2 小时)短**
 * —— 所以一格不会因为「那家没开着」就越过那条线变成「读不到最新的」;
 * 又比 10 分钟那一轮长九倍 —— 她退掉的 App 一天最多被拉起十几次里的几次,而不是每一轮。
 *
 * 另有一道更要紧的门在它前面(`worthLaunching`):**这一格的数还没过线就压根不拉** ——
 * 没坏的东西不去修,也就不去动她的 App。
 *
 * ★ **2026-10-19 起这条线只给她亲手点「读一下」那一下用。** 自动那一轮对没在跑的家**一律不起**
 * (`readOne` / `readOpenWindow` 的 `press` / `byHand` 那道门在这两道之前):这张表只在内存里,
 * 插件一重启就清零,维护者 10-19 关掉的千问办公 / Muse / Grok Bot / Manus 就是这样被一轮轮开回来的。
 */
export const QUOTA_LAUNCH_GAP_MS = 90 * 60_000

/**
 * ★ **同一家最快隔多久才再「闪一下台前」**(2026-10-03,卡「豆包闪一下」)。
 *
 * 维护者 21:4x 拍板的原话里就有这个数:「只在那一格真坏了(过 2 小时线)时叫到台前闪一下换一个真数,
 * 读完立刻恢复,**90 分钟最多一次**」。
 *
 * 为什么与后台拉起那条线(`QUOTA_LAUNCH_GAP_MS`)同一个数,还要单写一格:两件事的**代价不一样**
 * —— 拉起一个 App 她多半看不见(`open -g` + 立刻藏回去),而闪一下台前她**一定看得见**
 * (正在打字的话还会被抢走一两秒焦点)。所以这一格是一条独立的闸,哪天要把它收到更长
 * (比如半天一次),改这里一个数就行,不连累后台拉起那条。
 *
 * 90 分钟同样比那条 2 小时线短 —— 所以一格不会因为「这一轮没闪」就一直停在「读不到最新的」上。
 */
export const QUOTA_FRONT_GAP_MS = 90 * 60_000

/**
 * **切回工作台时,放了多久的那几家值得补读一遍**(卡 AG 追加)。
 *
 * 90 秒:他在那家里做完一件事再切回来,多半不止这么久;短于这个数的多半是他来回切了两下,
 * 那一下再读一遍是白读(还要动他的 App)。10 分钟那一轮照旧兜底。
 */
export const QUOTA_CATCHUP_AGE_MS = 90_000

/**
 * 超过这么久没读到新的,就把「几点读到的」写进那一句。
 *
 * 刚读到的数写时刻是噪音(「本周还剩约 62% · 22:41 读到的」,而这会儿就是 22:41);
 * 一刻钟往上就该写清 —— Claude 桌面端十几分钟才落一个样本,Manus / Muse 是十分钟看一眼窗口,
 * 这个岁数上的数还算「这会儿的」,再往上就得让人看见它的年纪。
 */
export const QUOTA_DATED_AFTER_MS = 15 * 60 * 1000

// ───────────────────────── 适配器 ─────────────────────────

export interface QuotaAdapterContext {
  /** `/state.quota`(老的四家:DeepSeek / Claude / Codex / Kimi)。 */
  quota: Partial<Record<AgentId, QuotaEntry>>
  /** `/state.clients`(装没装、接没接)。 */
  clients?: ClientsView
  modelMode?: 'relay' | 'own'
  /** 接口那只手(GPT)能不能用 —— 走工作台的服务。 */
  apiReady?: boolean
  /**
   * 中转上配了哪几家上游(2026-09-26,卡 GH;`relayProviders.ts`)。**缺席 = 从没问到过 → 当一家都没配**。
   *
   * 走接口那只手的那几家里,「中转没配这家」与「这台电脑没接上模型服务」是两件事,得说得出区别 ——
   * 前者要去服务器上加一把 Key(不是他能做的),后者他自己在设置里点一下就好。
   */
  relayProviders?: RelayProvidersView
  /** 从窗口上读到的(按 id)。 */
  window?: Readonly<Record<string, WindowQuotaReading | undefined>>
  /**
   * **开集那条路**读到的(按 id,2026-09-26 卡 QO):登记表里新接上、还没有专门读法的那几家。
   *
   * 这一格在不在,就是「这一家有没有那条路」:**缺席** = 连读都谈不上(只走接口、没有本机窗口的那几家),
   * 那一格照旧是「没接上:还没找到这家的额度来源」;**在**(哪怕是空的 `{}`)= 可以读,
   * 那一格给「读一下」。读数器 `openReadings(families)` 就是按这个口径给每一家都留一格的。
   */
  open?: Readonly<Record<string, OpenQuotaReading | undefined>>
  now: Date
}

export type QuotaAdapter = (ctx: QuotaAdapterContext) => AgentQuotaView

const adapters = new Map<string, QuotaAdapter>()
const windowSpecs = new Map<string, WindowQuotaSpec>()

/** 新接一家的额度(卡 Q 的登记表接进来时用)。同 id 再登记 = 换掉。 */
export function registerQuotaAdapter(id: string, adapter: QuotaAdapter): void {
  adapters.set(id, adapter)
}

/**
 * ★ **「额度在哪一页、怎么到那一页」就这一张表**(2026-10-03,卡 QT)。
 *
 * 卡 QZ 把 `reach` 写在 `WindowQuotaSpec` 里(「写在这一家的读法旁边,不另起一张按家名的表」),
 * 可那样一来**开集那几家压根没有格子可填** —— Grok Bot / Antigravity 不走 `windowSpecs`,
 * 卡 QP 的交接因此写着「开集那几家没有 `reach` 这张表」,读不到也到不了那一页。
 *
 * 这里把那张表**原地挪成两条路共用的一张**:`registerWindowQuota` 顺手把它那一格登进来
 * (所以窗口型那三家一个字都不用改,`WindowQuotaSpec.reach` 仍旧是声明它的地方),
 * 开集那几家用 `registerQuotaReach` 登同一张表。查的时候两条路都走 `quotaReachFor`。
 */
const reaches = new Map<string, QuotaPageReach>()

/** 这一家的额度要从它的窗口上读:给壳的那几条正则。 */
export function registerWindowQuota(id: string, spec: WindowQuotaSpec): void {
  windowSpecs.set(id, spec)
  // `reach` 进那张两条路共用的表(声明它的地方还是这一家的读法旁边)。
  if (spec.reach !== undefined) reaches.set(id, spec.reach)
}

/**
 * 开集那一家的「额度在哪一页」(同一张表;窗口型那几家由 `registerWindowQuota` 代登)。
 *
 * ★ **2026-10-04 起今天一处都没有人叫它**:唯一用过它的那一家(Grok Bot)这一天搬成了窗口型
 * (`GROK_BOT_WINDOW.reach`,**一家一处**)。这一口留着不删 —— 「`reach` 是窗口型与开集
 * **共用**的一张表」是 10-03 的拍板(见 `docs/决策记录.md`),开集那条路上的下一家
 * (比如哪天要给 Antigravity 声明页名)填的就是这里;撤了它,开集那几家又回到「压根没有格子可填」。
 */
export function registerQuotaReach(id: string, reach: QuotaPageReach): void {
  reaches.set(id, reach)
}

/** 这一家额度在哪一页、怎么到那一页(**一处查**:窗口型与开集同一张表)。 */
export function quotaReachFor(id: string): QuotaPageReach | undefined {
  return reaches.get(id)
}

/** 要从窗口上读额度的那几家(读数服务照这张表去读)。 */
export function windowQuotaSpecs(): ReadonlyMap<string, WindowQuotaSpec> {
  return windowSpecs
}

/** 这一家有**专门的**额度读法吗(`quotaFor` 认得出)。开集那条路只管认不出的那几家。 */
export function hasQuotaAdapter(id: string): boolean {
  return adapters.has(id)
}

/**
 * 该走**开集读法**的那几家(2026-09-26,卡 QO):派活名单里**有本机窗口**(有包标识)、
 * 又**没有专门读法**的那几家 —— 今天是 Grok Bot、Antigravity,以后是任何一家。
 *
 * 有专门读法的一个都不动(Claude / Codex / Kimi / DeepSeek / Manus / Muse / 豆包 / GPT);
 * 没有本机窗口的(只走接口那几家)也不列 —— 它的窗口压根不在这台电脑上,读不了,给按钮是骗人。
 */
export function openQuotaFamilies(
  targets: readonly { id: string, title: string, bundle_id?: string }[],
): OpenQuotaFamily[] {
  const out: OpenQuotaFamily[] = []
  for (const one of targets) {
    if (one.bundle_id === undefined || one.bundle_id === '' || hasQuotaAdapter(one.id)) continue
    out.push({ id: one.id, title: one.title, bundleId: one.bundle_id })
  }
  return out
}

// ───────────────────── 上次读到的那个数(卡 QS,一处记、一处顶)─────────────────────

/** 记着的那一份:上次读到的值 + 读到它的时刻。 */
interface Remembered { view: AgentQuotaView, at: string, key: string }

/** 只在内存里(理由见文件头)。键 = agent id。 */
const remembered = new Map<string, Remembered>()

/** 忘掉记着的那个数(用例之间清零;真机上没人叫它 —— 来源断了那几种靠 `no_stale` 判,不靠清缓存)。 */
export function forgetQuotaMemory(id?: string): void {
  if (id === undefined) remembered.clear()
  else remembered.delete(id)
}

/** 同一个数就算「还是那一次读到的」:值没变时**不把时刻往后推**,否则界面永远写「刚读到的」。 */
function valueKey(view: AgentQuotaView): string {
  return JSON.stringify([view.state, view.line, view.level, view.left_pct, view.left, view.reset_at])
}

/**
 * 过线时**为什么读不到 / 她能做什么**那两句,从 `view.stale_hint` 来 —— 由各家额度来源自己声明
 * (`quota/liveSources.ts` 一处),这一层一个家名都不写。
 *
 * - 2026-10-02(卡 QA)去掉了原来的「…,数字可能旧」:过线之后那个数根本不出了,再说「数字可能旧」
 *   是在说一个界面上已经没有的东西。也去掉了通用那一句(原「这会儿读不到新的,数字可能旧」)——
 *   它和「读不到最新的」是同一句话,说两遍是噪音。
 * - 2026-10-02(卡 QK)这里原来是一张按家名写死的表(`STALE_HINTS = { claude: 'Claude 桌面没在跑' }`),
 *   搬进了那一处声明,并多出第二句(2026-10-03 起是「点一下「接上」就实时」)与一个入口。
 *   **没声明的那几家仍然一句都不多说**:不替哪一家编一个原因(D13)。
 */
function staleWords(view: AgentQuotaView): readonly string[] {
  const hint = view.stale_hint
  return [
    ...(hint?.why === undefined ? [] : [hint.why]),
    ...(hint?.live === undefined ? [] : [hint.live.why]),
  ]
}

/**
 * 有数的那一格 + 「截至什么时候」。`line` 与 `short` 同一套措辞 —— 额度区、派活确认那一行、
 * 手机上那一句、电话里念的,读的是同一句。
 *
 * 三档(2026-10-02,卡 QA 收紧了第三档):
 * - **一刻钟以内** —— 不写时刻(「本周还剩约 62% · 22:41 读到的」而这会儿就是 22:41,是噪音);
 * - **一刻钟到 2 小时** —— 照说那个数,后面缀「截至 04:27」;
 * - **过 2 小时** —— **一个百分比都不出**,只说「读不到最新的,上次 04:27」,并标灰。
 *   原先这一档是「标灰但照说那个数」(卡 QS 的 6 小时线),现场证明不够:那个 100% 挂了一整晚,
 *   她看的还是那个数。所以把 `left_pct` / `left` / `reset_at` / `level` / `windows` **全摘掉** ——
 *   留一个,手机那一行(`quotaRowWords`)、展示台那条横条就又把百分比画回来了。
 *
 * 2026-10-02(卡 QK)第三档多出两句:**为什么读不到**、**配上什么就能实时**(`staleWords`,
 * 由各家额度来源自己声明)。`stale_hint` 本身**不摘**:电脑那一格要按它画那颗入口键
 * (手机与展示台只念那两句)。
 */
function dated(view: AgentQuotaView, at: string, now: Date): AgentQuotaView {
  const when = readWhen(at, now)
  const age = now.getTime() - new Date(at).getTime()
  // 时刻认不出 / 时钟倒着走:原样给,不编一个时刻。
  if (when === undefined || !Number.isFinite(age) || age < 0) return quiet({ ...view, read_at: at })
  if (age > QUOTA_STALE_AFTER_MS) {
    const { left_pct: _pct, left: _left, reset_at: _reset, level: _level, windows: _windows, ...rest } = view
    return quiet({
      ...rest,
      read_at: at,
      stale: true,
      // 「读不到最新的,上次 04:27」+ 来源声明过的那两句(为什么 / 配上什么就能实时)。
      line: [quotaAsOfWords(at, now) ?? QUOTA_STALE_VALUE, ...staleWords(view)].join(' · '),
      // 派活确认点括号里那一句(「派给 Claude(读不到最新的,上次 04:27)」):时刻**要留着** ——
      // 只写「读不到最新的」她没法判断这一家值不值得派。
      short: quotaAsOfWords(at, now) ?? QUOTA_STALE_VALUE,
    })
  }
  if (age <= QUOTA_DATED_AFTER_MS) return quiet({ ...view, read_at: at })
  const tail = quotaAsOfWords(at, now) ?? `${when} 读到的`
  const said = {
    ...view,
    read_at: at,
    line: `${view.line} · ${tail}`,
    short: `${view.short ?? view.line} · ${tail}`,
  }
  // 读到过数就不挂键(2026-09-27 维护者:「这几个按钮可还没解决喔」)。
  return quiet(said)
}

/**
 * **数读到了、还不旧的那一行不挂指路键**(2026-09-26 晚,卡 QG)。
 *
 * 维护者 22:40:「muse 和豆包办公都已经取到了,为什么还有那两个按钮啊?」
 * —— 那两颗键是「这一轮没读成」挂上去的(`windowQuota`),可行上明明写着 97%。有数的时候它们不是
 * 「还差一步」,只是「想再读一次」:打上 `quiet`,界面把它们收进「▸ 说明」里,只留一颗「再读一次」。
 *
 * 旧了(`stale`)或者压根没读到的那一格不打 —— 那时候他确实得去开一趟那一页。
 */
function quiet(view: AgentQuotaView): AgentQuotaView {
  const fix = view.fix
  if (fix === undefined || fix.quiet === true) return view
  if (view.state !== 'numbers' && view.state !== 'unlimited') return view
  return { ...view, fix: { ...fix, quiet: true } }
}

/**
 * 三格的最后一道(**卡 QS 的全部改法就在这里**):
 * - 这一轮读到了数 / 读到「不限」→ 记下来(带时刻),有数的那一格按岁数写上时刻、老了标灰;
 * - 这一轮没读到,而且**来源确实断了**(`no_stale`)→ 照实说「没接上」,上次那个数不许顶上来;
 * - 这一轮没读到,但**读到过** → 顶上上次那个数(带时刻;这一轮的原因里还挂着键的那几种 —— 「去授权」
 *   「装新版工作台 App」「去接上」—— 跟着给。2026-09-30 起从窗口上读的那几家没读成时一颗键都不挂了,
 *   所以那几家走到这儿只剩那个数);
 * - 压根没读到过 → 「没接上」,原样。
 */
function withMemory(id: string, view: AgentQuotaView, now: Date): AgentQuotaView {
  if (view.state === 'numbers' || view.state === 'unlimited') {
    const key = valueKey(view)
    const kept = remembered.get(id)
    // 时刻从哪来:适配器自己知道的(从窗口上读的那几家带 `read_at`)用它的;别家用「第一次看见这个值」的时刻。
    const at = view.read_at ?? (kept !== undefined && kept.key === key ? kept.at : now.toISOString())
    remembered.set(id, { view, at, key })
    // 「不限」不会因为读不到新的而变味(Manus 限时免费期的「∞」是它自己写的),不写时刻、不标灰。
    return view.state === 'unlimited' ? quiet(view) : dated(view, at, now)
  }
  if (view.no_stale === true) return view
  const kept = remembered.get(id)
  if (kept === undefined) return view
  const fix = view.fix
  const shown = { ...kept.view, ...(fix === undefined ? {} : { fix }) }
  return kept.view.state === 'unlimited' ? quiet(shown) : dated(shown, kept.at, now)
}

/**
 * 一家此刻的额度。
 *
 * ★ **2026-09-26(卡 QO):没有专门读法的那一家不再是一句死话。**
 *
 * 维护者:「要有机制」。登记表里新接上的任何一家(今天 Grok Bot、Antigravity),只要它**有本机窗口**,
 * 就走开集那条路(`ctx.open` 里有它一格):还没读过 → 那一格给「读一下」;读到了 → 就是「有数」。
 * `ctx.open` 里**整个没有**这一格的(只走接口、没有窗口可读的那几家)才是老那句
 * 「没接上:还没找到这家的额度来源」—— 不报错、不返回空。
 */
export function quotaFor(id: string, ctx: QuotaAdapterContext): AgentQuotaView {
  const adapter = adapters.get(id)
  if (adapter === undefined) {
    const reading = ctx.open?.[id]
    // 连开集那条路都没有:老那句。没有适配器 = 从来没读过一次,谈不上「上次读到的数」,不必打 no_stale。
    if (reading === undefined) return unconnected(id, '还没找到这家的额度来源')
    return withMemory(id, openQuotaCell(id, reading), ctx.now)
  }
  let view: AgentQuotaView
  try { view = adapter(ctx) }
  catch { view = unconnected(id, '这次没读成') }
  return withMemory(id, view, ctx.now)
}

/** 几家一起(额度区、`/state.agent_quota`)。 */
export function quotasFor(ids: readonly string[], ctx: QuotaAdapterContext): AgentQuotaView[] {
  return ids.map(id => quotaFor(id, ctx))
}

/**
 * 「读一下」按完,那颗键底下说的那一句(2026-09-26,卡 MQ3)。
 *
 * ★ 原来这句话是**写死的**:界面上不论读成没读成,都回「读过了,这一格会跟着变」——
 * 维护者 18:50 点 Muse / Manus 的「读一下」,看到的就是这句,可那一格一个字没变(藏着的窗读不到)。
 * 一句与真实结果无关的话,比不说话坏:他会以为是界面坏了,或者以为读到了一个数没显示出来。
 *
 * 所以这句话**照这一格此刻的话说**(`short` 优先,没有就 `line`),再按「这一轮到底读到没读到」分三种:
 *
 * | 这一轮 | 那一格 | 说什么 |
 * |---|---|---|
 * | 读到了 | 有数 / 不限 | `读到了:还剩约 97%` |
 * | 没读到 | 没接上 | `读了,不在「使用情况」页上` / `读了,这页上没看见用量` |
 * | 没读到 | 还摆着上次那个数(卡 QS) | `读了,没读到新的;这一格还是上次那个数(剩 2,690 积分)` |
 *
 * `found` 来自读数器那一笔尝试(`readings()[id].attempt.found` / 开集那边同名的一格)——
 * **不拿「那一格有没有数」当读成了**:卡 QS 起读不到的时候上次那个数照摆着,拿它当「读到了」
 * 就又是一句假话(D13)。
 */
export function quotaCheckSaid(view: AgentQuotaView | undefined, found: boolean): string {
  // 面板上压根没有这一格(叫的不是面板上那颗键):只说做过了,不编结果。
  if (view === undefined) return '读过了'
  const said = (view.short ?? view.line).replace(/^没接上[::]\s*/, '')
  if (found) return `读到了:${said}`
  if (view.state === 'unconnected') return `读了,${said}`
  return `读了,没读到新的;这一格还是上次那个数(${said})`
}

/** 派活确认点括号里那一句(三格各一种说法;没接上带原因)。 */
export function balanceFromQuota(view: AgentQuotaView): DispatchBalanceView {
  const text = view.short ?? view.line
  if (view.state === 'numbers') {
    return {
      // 过线那一档没有 `level`(卡 QA 把它和百分比一起摘掉了):那是「读不到」,不是「额度充足」——
      // 顶成 `ok` 会让派活确认点把一家 17 小时没读到数的家说成随便派。
      level: view.level ?? (view.stale === true ? 'unknown' : 'ok'),
      text,
      ...(view.read_at === undefined ? {} : { read_at: view.read_at }),
      state: 'numbers',
      ...(view.left_pct === undefined ? {} : { left_pct: view.left_pct }),
      ...(view.reset_at === undefined ? {} : { reset_at: view.reset_at }),
      // 上次读到的、已经老了的那个数(卡 QS):`text` 里已经带着时刻与那一句,这里只多给一面旗子,那一行画淡。
      ...(view.stale === true ? { stale: true } : {}),
    }
  }
  if (view.state === 'unlimited') return { level: 'ok', text: '不限', state: 'unlimited' }
  return { level: 'unknown', text, state: 'unconnected', ...(view.fix === undefined ? {} : { fix: view.fix }) }
}

// DeepSeek(工作台模型服务 / 自己的 Key)。
registerQuotaAdapter('dsh', (ctx) => {
  const entry = ctx.quota.dsh
  if (ctx.modelMode === 'relay') {
    return numbersFromEntry('dsh', entry, '工作台模型服务')
      ?? unconnected('dsh', '读不到工作台模型服务今天还剩多少', { short: '读不到工作台服务今天还剩多少' })
  }
  const got = numbersFromEntry('dsh', entry)
  if (got !== undefined) return got
  if (entry?.kind === 'unknown' && entry.no_stale === true) {
    // 来源确实断了(一把 Key 都没有 / 换了来源):上次那个数是另一份来源取的,不许顶上来。
    return unconnected('dsh', '没走工作台的服务,也没填 DeepSeek Key', {
      short: '没接模型服务',
      fix: { kind: 'unlock', label: '去接上', hint: '去设置 → 模型服务,二选一', desk_only: true },
      no_stale: true,
    })
  }
  return unconnected('dsh', '这次没取到余额', { short: '这次没取到余额' })
})

/** Claude / Codex / Kimi:采集器那一格;没接上时照「全部接上」/「自己登一次」那套说。 */
function clientAdapter(id: 'claude' | 'codex' | 'kimi'): QuotaAdapter {
  return (ctx) => {
    const got = numbersFromEntry(id, ctx.quota[id])
    if (got !== undefined) return got
    const client = ctx.clients?.[id]
    const title = titleOf(id)
    // 下面两种是**来源确实断了**(没装 / 钩子没装):上次读到的数不许顶上来(`no_stale`,卡 QS)。
    if (client !== undefined && !client.installed) return unconnected(id, `${title} 没装在这台电脑上`, { short: '没装', no_stale: true })
    if (client !== undefined && !client.connected) {
      return id === 'kimi'
        ? unconnected(id, '要你自己登一次 Kimi(账号密码工作台不经手)', {
          short: '要你自己登一次 Kimi',
          fix: { kind: 'unlock', label: '去登录', hint: '设置 → 额度凭据 →「登录 Kimi」', desk_only: true },
          no_stale: true,
        })
        : unconnected(id, `工作台还没接上 ${title} 的额度`, {
          short: '点一次「全部接上」',
          fix: { kind: 'unlock', label: '全部接上', hint: '先看一眼要写什么,确认一次就接上,写完能撤回', desk_only: true },
          no_stale: true,
        })
    }
    /**
     * 装了、接上了,只是**这一轮没取到**(卡 QS 撞见的那一种:Claude 桌面端几小时没落新样本)。
     * 这是「没读到新的」,不是「没接上」—— 读到过的话 `quotaFor` 会把上次那个数顶上来,带着几点读到的。
     * 采集层的原话(「…用量记录已过期」这类)**不往界面上搬**:那是内部词,而且他要的是「数字可能旧」这个意思。
     */
    return unconnected(id, '这次没取到', { short: '这次没取到' })
  }
}
registerQuotaAdapter('claude', clientAdapter('claude'))
registerQuotaAdapter('codex', clientAdapter('codex'))
registerQuotaAdapter('kimi', clientAdapter('kimi'))

// GPT:走工作台的服务(接口那只手)。中转按**每个令牌每天一个花费上限**记账(relay/server/index.cjs),
// GPT 与 DeepSeek 花的是同一份 —— 所以它的「还剩多少」就是工作台服务今天那一格。
registerQuotaAdapter('gpt', (ctx) => {
  if (ctx.apiReady !== true) {
    // 来源确实断了(接口那只手没接上):上次那个数是另一份来源取的,不许顶上来。
    return unconnected('gpt', 'GPT 走工作台的服务,这台电脑还没接上', { short: '工作台的服务没接上', no_stale: true })
  }
  /*
   * ★ 中转上没配 OpenAI(2026-09-26,卡 GH):**这一家这会儿压根派不出去**,谈不上「还剩多少」。
   * 名单里本来就不该有它(`dispatchTargets` 已经把它挡在外面),所以走到这儿的只有「他点名了 GPT」
   * 那一条路 —— 那时如实说是中转那边的事,别让他去设置里瞎点。
   */
  if (!relayHasProviderFor('gpt', ctx.relayProviders)) {
    return unconnected('gpt', `GPT 走工作台的服务,${API_HAND_PROVIDER_MISSING_WHY}`, { short: API_HAND_PROVIDER_MISSING_WHY, no_stale: true })
  }
  if (ctx.modelMode === 'relay') {
    const got = numbersFromEntry('gpt', ctx.quota.dsh, '工作台服务')
    if (got !== undefined) return { ...got, source: '走工作台的服务,与 DeepSeek 花同一份今日额度' }
  }
  return unconnected('gpt', '读不到工作台服务今天还剩多少', { short: '读不到工作台服务今天还剩多少' })
})

/**
 * 从窗口上读的那一家,额度那一格在哪、没读到时怎么说。
 * `missed` 是**读过窗口、但那一格这会儿不在窗口上**时的那句(不给就用 `why`);它得跟 `why` 说得出区别 ——
 * 维护者 2026-09-26 点了 Muse 的「读一下」,读是读了(Muse 开着、不在「使用情况」页),界面上却一个字没变,他以为没反应。
 */
interface WindowWhereItIs { why: string, short: string, hint: string, missed?: string, missedShort?: string }

/**
 * 从窗口上读的那几家没读到时,按最近一次尝试说清原因 + 一键入口。
 * `name` 给了就用它念这一家(开集那条路:名字来自登记表,`titleOf` 只认得出写死的那几家)。
 */
function windowUnconnected(id: string, reading: WindowQuotaReading | undefined, whereItIs: WindowWhereItIs, name?: string): AgentQuotaView {
  const title = name ?? titleOf(id)
  const attempt = reading?.attempt
  /**
   * 该他自己去点的那一步:**并进那句话里**(2026-09-30 维护者拍板把「叫到台前」那一整套键删掉,见 `docs/决策记录.md`)。
   * 原来这几支各挂一颗键(叫到台前 / 打开 X / 放出 X)—— 键全删了,话一个字不少:
   * 它本来就写在键旁边(`fix.hint`),现在直接进 `line`,电脑与手机读的是同一句。
   */
  const andHint = (why: string): string => `${why} —— ${whereItIs.hint}`
  if (attempt === undefined) {
    return unconnected(id, andHint(`还没读过${inSentence(title)}窗口上的额度(${whereItIs.why})`), { short: whereItIs.short })
  }
  if (attempt.error === undefined) {
    // 读过了、窗口也读到了,只是额度那一格这会儿不在窗口上(Manus 不在首页、Muse 不在「使用情况」页)。
    // 要写上几点读过、现在差哪一步 —— 跟「从没读过」说同一句话,他点完「读一下」看不出动过。
    const when = clock(attempt.at)
    const read = `${when === '' ? '' : `${when} `}读过${inSentence(title)}的窗口`
    // ★ 2026-09-26(卡 MQ / MQ2):辅助功能**只列这会儿显示着的那个桌面(Space)上的窗** ——
    // 卡 MQ2 在维护者机器上同一刻对照采样钉死了这条:Muse 的设置窗开在眼前时 `AXWindows` 里有它、
    // 「使用情况」页上那几行全读得到;它一到别的桌面上,AX 里就没有它了(换主窗 / 焦点窗 / 应用元素的
    // children / 敲门再等一拍,哪条路都没有)。读不到的时候把这件事**补在后面**说:
    // 主句还是「那一格不在窗口上」(他多半就是没打开那一页),但得让他知道还有这么一种可能,
    // 不然「明明开着啊」这口气没处出。**不抢主句** —— Muse 那两扇登录 / 欢迎的老窗一直挂在别的桌面上,
    // 抢了主句就会天天说「有窗在别的桌面上」,把真正该做的那一步(去打开「使用情况」)盖掉。
    //
    // 这个数是壳**真去数**的「不在当前桌面上的有几扇」(卡 MQ2 改;原来是「系统说有几扇 − AX 读到几扇」
    // 减出来的,窗都在眼前、只是 AX 少露一扇时会白叫他去别的桌面找)。
    // 藏起来了要先说藏起来(卡 MQ2):藏着的 App 每一扇窗都不在任何桌面上,这时候说
    // 「有 N 扇窗在别的桌面上」会让他去别的桌面找一扇根本不在那儿的窗。
    //
    // ★ 2026-09-26(卡 MQ3):**新壳上这一支几乎不再出场** —— 藏它的手本来就是工作台自己的窗口槽,
    // 所以壳在读之前先把它放出来、读完藏回去(`TextInsert.readTexts`),`app_hidden` 于是是 false,
    // 剩下的就只有「不在那一页」和「在别的桌面上」这两句真话。留着这一支是为了两种情形:
    // 装着的还是老壳(没有这套机制),或者放出来那一下没成(App 正在退之类)。
    // 那时候这句话仍旧是对的 —— 不去删它,也不让它冒充别的原因(D13)。
    const elsewhere = attempt.hidden === true
      ? '(它这会儿是藏起来的 —— 藏着的窗一扇都读不到,点一下它的图标把它放出来,再点一次)'
      : attempt.offspace !== undefined && attempt.offspace > 0
        ? `(它另有 ${attempt.offspace} 扇窗不在你这会儿看着的桌面上,那几扇读不到 —— 要找的那一页要是开在那边,切到那个桌面、或把那扇窗拖过来,再点一次)`
        : ''
    return unconnected(id, andHint(`${read},${whereItIs.missed ?? whereItIs.why}${elsewhere}`), {
      short: whereItIs.missedShort ?? whereItIs.short,
    })
  }
  switch (attempt.error) {
    case 'not_running':
      return unconnected(id, andHint(`${leadName(title)}没开着,读不了它窗口上的额度`), { short: `${leadName(title)}没开着` })
    case 'no_window':
      // ★ 卡 MQ2(2026-09-26):**藏起来的时候别说「没有窗口」** —— 实测维护者这台机器上 Muse 多数时候
      // 是藏着的(⌘H 或者工作台自己藏回去),窗好好地开着四扇,只是一扇都不在任何桌面上、读不到。
      // 说「没有窗口」他会去开新窗;真该做的是把它放出来。
      // 卡 MQ3 起新壳自己就把它放出来读了(上面 `elsewhere` 那段),这一支只剩老壳 / 放不出来两种情形。
      if (attempt.hidden === true) {
        // 这一支自己那句里已经有一个「——」了,再用 `andHint` 接一个就是一句话两道破折号:
        // 这里改用「,再」把该他做的下一步串下去(放出来之后要去的仍是那一页)。
        return unconnected(id, `${leadName(title)}这会儿是藏起来的,藏着的窗读不到 —— 点一下它的图标把它放出来,再${whereItIs.hint}`, {
          short: `${leadName(title)}藏起来了`,
        })
      }
      return unconnected(id, andHint(`${leadName(title)}开着,但没有窗口`), { short: `${leadName(title)}没有窗口` })
    case 'no_helper':
      return unconnected(id, `工作台 App 没连上,读不了${inSentence(title)}的窗口`, { short: '工作台 App 没连上' })
    /*
     * ★ 卡 QD:**那个 App** 这会儿不让读(Chromium 那几家刚起来时就这样,壳敲过门了,树还没建好)。
     * 不打 `no_stale` —— 这不是「来源断了」,上次真读到的那个数照样该顶上来(带着几点读到的)。
     * 也**不许**说成「工作台 App 还没有辅助功能权限」:那是一句假话,还会把他领到系统设置里白点一遍。
     */
    case 'app_asleep':
      return unconnected(id, andHint(`${leadName(title)}这会儿还没让工作台读它窗口上的字(它刚起来时会这样,过一会儿它自己再读一次)`), {
        short: '这次没读成',
      })
    // 下面两种是**来源确实断了**(这台机器这会儿根本没有读它窗口的本事):要他先去做那一步,
    // 拿上次的数顶上来只会让他以为不用管(`no_stale`,卡 QS)。
    case 'no_ax':
      return unconnected(id, `工作台 App 还没有辅助功能权限,读不了${inSentence(title)}的窗口`, {
        short: '要先授权辅助功能',
        fix: { kind: 'grant_ax', label: '去授权', hint: '系统设置 → 隐私与安全性 → 辅助功能,打开「工作台」', desk_only: true },
        no_stale: true,
      })
    case 'old_shell':
      return unconnected(id, `要新版工作台 App 才读得到${inSentence(title)}窗口上的额度`, {
        short: '要新版工作台 App',
        fix: { kind: 'update_shell', label: '装新版工作台 App', hint: '设置 → 关于 → 检查更新', desk_only: true },
        no_stale: true,
      })
    case 'failed':
      return unconnected(id, andHint(`这次没读成${attempt.note === undefined ? '' : `(${attempt.note})`}`), { short: '这次没读成' })
    default:
      return unconnected(id, andHint(whereItIs.why), { short: whereItIs.short })
  }
}

/**
 * 上次在它窗口上读到的那几小段。
 *
 * ★ 2026-09-26(卡 QS):**不再按岁数一刀切**。原来读过 12 小时以上就当没读到(翻成「没接上」),
 * 那正是维护者今早撞见的那件事的同一个毛病 —— 读到过的数照给,几点读到的、老没老由 `quotaFor` 一处写上。
 *
 * 只有两种不给:**要先授权辅助功能**、**要新版工作台 App** —— 这台机器这会儿根本没有读它窗口的本事,
 * 这时候摆一个旧数会让他以为不用管那一步(同 `no_stale` 那条纪律)。
 */
function lastRead(reading: WindowQuotaReading | undefined): WindowQuotaReading['last'] {
  const error = reading?.attempt?.error
  if (error === 'no_ax' || error === 'old_shell') return undefined
  return reading?.last
}

/**
 * 从窗口上读的那几家(Manus / Muse)合起来的一格:**上次读到的那个数**。
 *
 * 读到过、这一轮没读成时数照给(「几点读到的」「数字可能旧」由 `quotaFor` 写上)。
 *
 * ★ 2026-09-30(维护者拍板把「叫到台前」那一整套键删掉):原来这一支还把「没读成」那一格的键搬过来挂在
 * 有数的那一行上 —— 那颗键只有「叫到台前」一种,键删了,这一支跟着删:有数就只摆那个数,
 * 该他去打开哪一页那句话留在**真读不到**的那一格里(`windowUnconnected`)。
 */
function windowQuota(
  id: string,
  reading: WindowQuotaReading | undefined,
  parse: (last: NonNullable<WindowQuotaReading['last']>) => AgentQuotaView | undefined,
  whereItIs: WindowWhereItIs,
  /**
   * 界面上念这一家的名字(2026-10-04,卡「Grok 读已用」)。
   *
   * 写死接法的那几家(Manus / Muse / 豆包办公)家名就是它的 id,`titleOf` 认得出;
   * **从登记表来的那几家 id 是它的包标识**(Grok Bot = `com.anysphere.sand`)——
   * 那时 `titleOf` 会把「com.anysphere.sand」原样摆进那句话里。这一格就是那句话里的名字
   * (`/state.agent_quota` 那一层照旧用登记表里的名字盖 `view.title`,见 http 的 `agentQuotaNow`)。
   */
  name?: string,
): AgentQuotaView {
  const last = lastRead(reading)
  const got = last === undefined ? undefined : parse(last)
  if (got === undefined) return windowUnconnected(id, reading, whereItIs, name)
  return got
}

/**
 * Manus:**积分**。首页右上角那一格(✦ 1,234;限时免费期间是 ∞)—— 只在首页露出来,所以读到的数带时刻;
 * 另外两条横幅:「积分已用完,将于 X 重置」「积分即将用完,将于 X 重置」(Manus 自己的文案,中英两份)。
 * 壳只回命中的那一小段(`read_texts`),他的任务标题、对话内容一个字都不读。
 */
export const MANUS_WINDOW: WindowQuotaSpec = {
  bundleId: bundleForEntry('manus') as string,
  patterns: [
    { id: 'credits', regex: '^(?:[0-9][0-9,]*(?:\\.[0-9]+)?[KkMm]?|∞)$', top: 120 },
    { id: 'empty', regex: '积分已用完[^。]{0,30}重置|No credits left\\. Resets on [^.]{1,40}' },
    { id: 'low', regex: '积分即将用完[^。]{0,30}重置|Running low\\. Resets on [^.]{1,40}' },
  ],
  parse: last => manusQuotaOf(last),
  // 积分那一格就在它首页右上角(页名用「首页」—— 那一页上没有标题可抄,这是它自己的说法)。
  // 深链:包里注册了 `manus` 这条 scheme(2026-10-03 读 Info.plist 查实),但**没查实过**哪条地址
  // 开得到首页 / 积分那一格,所以不写(D13)。
  reach: { page: '首页' },
}
registerWindowQuota('manus', MANUS_WINDOW)

/** Manus 那几小段 → ① 有数(或 ∞ = 限时不限);认不出回 undefined。 */
export function manusQuotaOf(last: NonNullable<WindowQuotaReading['last']>): AgentQuotaView | undefined {
  const base = { id: 'manus', title: titleOf('manus'), read_at: last.at }
  const when = `${clock(last.at)} 在 Manus 窗口上读到的`
  const empty = last.matches.find(one => one.id === 'empty')
  if (empty !== undefined) {
    return { ...base, state: 'numbers', level: 'empty', line: `积分用完了(${empty.text})`, short: '积分用完了', source: when }
  }
  // 顶栏里的数字可能不止一个(通知角标之类):认**最右**的那一个,而且要在窗口右半边(积分那一格在右上角)。
  const half = last.width === undefined || last.width <= 0 ? 0 : last.width / 2
  const credits = last.matches
    .filter(one => one.id === 'credits' && one.x >= half)
    .sort((left, right) => right.x - left.x)[0]
  const low = last.matches.find(one => one.id === 'low')
  if (credits === undefined) {
    if (low !== undefined) return { ...base, state: 'numbers', level: 'low', line: `积分快用完了(${low.text})`, short: '积分快用完了', source: when }
    return undefined
  }
  if (credits.text === '∞') {
    return { ...base, state: 'unlimited', line: '不限', short: '不限', source: `Manus 限时免费期间积分写的是「∞」(${when})` }
  }
  const plain = credits.text.replace(/,/g, '')
  const unit = /[KkMm]$/.test(plain) ? plain.slice(-1).toUpperCase() : ''
  const amount = Number(unit === '' ? plain : plain.slice(0, -1)) * (unit === 'K' ? 1000 : unit === 'M' ? 1_000_000 : 1)
  const level = low !== undefined ? 'low' : Number.isFinite(amount) && amount <= 0 ? 'empty' : 'ok'
  const line = level === 'empty' ? '积分用完了' : `剩 ${credits.text} 积分${level === 'low' ? ',快用完了' : ''}`
  return {
    ...base,
    state: 'numbers',
    level,
    line,
    left: { text: credits.text, unit: '积分', ...(Number.isFinite(amount) ? { amount } : {}) },
    source: when,
  }
}

registerQuotaAdapter('manus', ctx => windowQuota('manus', ctx.window?.manus, manusQuotaOf, {
  why: 'Manus 的积分只在它首页右上角那一格,这会儿窗口不在首页',
  short: '积分只在它首页右上角',
  hint: '在 Manus 里回到首页,右上角那一格就是积分;工作台看一眼就记下',
  missed: '积分只在它首页右上角那一格,这会儿窗口不在首页',
}))

/**
 * Muse:**按用量限**(Meta 帮助中心:免费档有用量上限,到了等它刷新或升级;付费档按周给 token)。
 * 剩多少只在它自己的「使用情况」页上(中文「已使用 38%」,英文那半边写「2% used」);
 * 用完了窗口上会写「已用完使用额度」。
 *
 * ★ **2026-09-26(卡 MQ):那个百分比要有「这确实是那一页」的旁证才认。**
 *
 * 壳从只读第 0 扇窗改成**每一扇都读**之后,聊天窗也在读的范围里了 —— 而他和 Muse 聊的**正是额度**:
 * 实测他那扇聊天窗的记录里就写着「周限额的 0%」「周额度只剩 1%」。要是见着百分号就当额度,
 * 工作台会把**他对话里的一个数**当成 Muse 的剩余额度显示出来 —— 那比读不到坏得多(D13:不编数)。
 *
 * 所以规矩是:百分比**只在同一扇窗上还看得见那一页的记号**时才算数 —— 页标题(「使用情况」/「Usage」)、
 * 档位(「Free plan」)、重置那一行(「Weekly limit resets on Oct 1」)任意一条。这三条都是**整格文字**
 * (`^…$`),聊天记录里不会正好有一整段就是这几个字。差这一条旁证就回 undefined,
 * 界面上照旧说「这会儿不在『使用情况』页上」—— 宁可说读不到,不给一个假数。
 * 「无限制」同理(别处的「无限制」说的是别的事)。
 */
export const MUSE_WINDOW: WindowQuotaSpec = {
  bundleId: bundleForEntry('muse') as string,
  patterns: [
    { id: 'used', regex: '已使用\\s*[0-9]{1,3}\\s*%|[0-9]{1,3}\\s*%\\s*used' },
    { id: 'empty', regex: '^(?:已用完(?:使用额度)?|No remaining usage)[。.]?$' },
    { id: 'page', regex: '^(?:使用情况|使用量|用量|Usage)$' },
    { id: 'plan', regex: '^(?:Free|Pro|Premium|Business) plan$|^(?:免费|专业|高级)(?:版|档|计划|方案)$' },
    { id: 'reset', regex: '^(?:Weekly|Monthly|Daily) limit resets? on [^\\n]{1,24}$|^(?:每周|每月|每日)额度[^\\n]{0,8}重置[^\\n]{0,20}$' },
    { id: 'unlimited', regex: '^(?:无限制|Unlimited)$' },
  ],
  parse: last => museQuotaOf(last),
  /*
   * 页名就是上面那条 `page` 正则认的第一个写法(「使用情况」在它设置里)。
   *
   * ★ **2026-10-03(卡 QT):深链查实了 —— `endo-window://settings`。**
   *
   * 卡 QZ 只查到「注册了 `hatch` / `endo-window` 两条 scheme」,没查实哪条开到哪里,所以空着;
   * 卡 QP 接着把 Muse 判成「路是通的,缺一颗通向那一页的键」(它主窗侧栏那几颗键里确实没有)。
   * 10-03 在二进制里找到的那一行是 `endo-window://permissions` —— 也就是说
   * `endo-window://<窗名>` 开的是**它自己的某一扇窗**,而窗名那一组里有 `settings`
   * (`main` / `settings` / `login` / `onboarding` / `permissions` / `debug`)。
   *
   * 真机上开了一次(`probe quota-link com.meta.endo endo-window://settings`),量到的是:
   *
   *   windows: [0] 1640x945 title_kind=settings, [1] 1496x971 聊天主窗, [2] 620x191
   *   read_texts(第 0 扇):「使用情况」(249,151) / 「Free plan」(267,195)
   *                        /「Weekly limit resets on Oct 8」(267,214) /「0% used」(1397,195)
   *
   * 那四条正是上面 `patterns` 要的四条(`page` / `plan` / `reset` / `used`)—— **额度那一页就是
   * 设置窗的第一页(通用)**,一颗键都不用按。`front_before` = `front_after`(没抢焦点)、
   * `hidden_before: true → hidden_after: false`(**它把藏着的那家放出来了** —— 所以读完要自己藏回去,
   * 见 `readOne` 的 `finally`)。
   *
   * 只开它自己注册的 scheme、只给一个窗名、**一个参数都不传**(D13:不猜一条带参数的深链去开她的 App)。
   */
  reach: { page: '使用情况', link: 'endo-window://settings' },
}
registerWindowQuota('muse', MUSE_WINDOW)

/** 「这一扇窗上确实是『使用情况』那一页」的旁证:页标题 / 档位 / 重置那一行,任意一条。 */
function museOnUsagePage(last: NonNullable<WindowQuotaReading['last']>): WindowTextMatch | undefined {
  return last.matches.find(one => one.id === 'page' || one.id === 'plan' || one.id === 'reset')
}

/** Muse 那几小段 → ① 有数 / ② 不限;认不出(或没有那一页的旁证)回 undefined。 */
export function museQuotaOf(last: NonNullable<WindowQuotaReading['last']>): AgentQuotaView | undefined {
  const base = { id: 'muse', title: titleOf('muse'), read_at: last.at }
  const when = `${clock(last.at)} 在 Muse 窗口上读到的`
  if (last.matches.some(one => one.id === 'empty')) {
    return { ...base, state: 'numbers', level: 'empty', left_pct: 0, line: '用量用完了(Muse 窗口上写着「已用完使用额度」)', short: '用量用完了', source: when }
  }
  const onPage = museOnUsagePage(last)
  const used = last.matches.find(one => one.id === 'used')
  if (used !== undefined && onPage !== undefined) {
    const pct = Number(/([0-9]{1,3})/.exec(used.text)?.[1])
    if (Number.isFinite(pct)) {
      const left = Math.max(0, Math.min(100, 100 - pct))
      const level = left <= 1 ? 'empty' : left < BALANCE_LOW_PCT ? 'low' : 'ok'
      const line = level === 'empty' ? '用量用完了' : level === 'low' ? `只剩约 ${left}%,快用完了` : `还剩约 ${left}%`
      // 重置那一行读到了就一起写进出处(几号重置是他最想知道的第二件事);**不折算成时刻**——
      // 「Oct 1」没有年份也没有时区,折出来的那个时刻是编的(D13)。原话照抄,他自己看得懂。
      const reset = last.matches.find(one => one.id === 'reset')
      const quoted = `「${used.text}」${reset === undefined ? '' : `、「${reset.text}」`}`
      return { ...base, state: 'numbers', level, left_pct: left, line, source: `${when}(「使用情况」页上写着${quoted})` }
    }
  }
  if (last.matches.some(one => one.id === 'page') && last.matches.some(one => one.id === 'unlimited')) {
    return { ...base, state: 'unlimited', line: '不限', source: `${when}(「使用情况」页上写着「无限制」)` }
  }
  return undefined
}

registerQuotaAdapter('muse', ctx => windowQuota('muse', ctx.window?.muse, museQuotaOf, {
  why: 'Muse 有用量上限,剩多少只在它自己的「使用情况」页上',
  short: '剩多少只在它的「使用情况」页上',
  // ★ 卡 MQ2(2026-09-26)补了半句「在这个桌面上」:那扇设置窗只要不在这会儿显示着的桌面上,
  // 系统就不让工作台看见它 —— 少这半句,他照着做完还是读不到,而界面上还是那句话。
  hint: '在 Muse 的设置里打开「使用情况」,那扇窗留在你这会儿看着的桌面上,工作台看一眼就记下',
  missed: '这会儿不在「使用情况」页上;在 Muse 的设置里打开「使用情况」,切走时工作台会自己读一次',
  missedShort: '不在「使用情况」页上',
}))

/**
 * 豆包办公:**窗口型额度**,和 Claude 一样的两扇窗(2026-09-26,卡 QD)。
 *
 * ★ **原来这一格写的是「不限」,撤掉。** 09-26 上午按维护者一句话(「豆包本身是不限制额度的」)写了
 * `state:'unlimited'`;当天 19:00 他把豆包办公里那一页截图发来:「豆包办公是有额度的,你又糊弄我」。
 * 那一页(「标准套餐 · 订阅与额度管理」)上明写着两条:
 *
 *     当前时段        已用 <1%       ▁▁▁▁▁▁▁▁      4 小时 45 分钟后重置
 *     近 7 天         已用 <1%       ▁▁▁▁▁▁▁▁      10月2日 16:02 重置
 *
 * 就是「一个约 5 小时的滚动时段 + 一个 7 天窗」—— 与 Claude 那两条(5h / 周)同一种东西,
 * 所以这里**不另造形状**:读出来的两扇窗就按老四格那份 `QuotaWindow` 给,`line` / `level` 交给
 * `numbersFromEntry` 说(「5 小时窗口还剩约 99%」),界面上画出来的也是老四格那两条横条。
 *
 * 旁证那条门同 Muse(卡 MQ 那条纪律):壳一次读这个 App 的**每一扇窗**,他跟豆包聊天的那扇也在里面,
 * 而人跟 Agent 聊的正可能是额度。所以百分比**只在同一扇窗上还看得见那一页的整格标题**
 * (「订阅与额度管理」/「标准套餐」)时才算数;差这一条就回 undefined,界面照旧说「不在那一页上」。
 * **宁可说读不到,不给一个假数**(D13)。
 */
export const DOUBAO_WINDOW: WindowQuotaSpec = {
  bundleId: bundleForEntry('doubao') as string,
  patterns: [
    // 旁证:那一页的标题 / 副标题,**整格文字**(聊天里的一句话配不上)。
    { id: 'page', regex: '^(?:订阅与额度管理|标准套餐)$' },
    // 两扇窗各自的那一格小标题(也是分组的锚:同一行的「已用 N%」、下一行的重置都归它)。
    { id: 'window_5h', regex: '^当前时段$' },
    { id: 'window_7d', regex: '^近 ?7 ?天$' },
    // 「已用 38%」/「已用 <1%」(小于 1 它就写「<1%」)。
    { id: 'used', regex: '^已用\\s*<?\\s*[0-9]{1,3}\\s*%$' },
    /*
     * ★ **一个字都没用过的时候它不写百分比,写「未消耗」**(2026-10-04 卡「豆包台前点一下」真机)。
     *
     * 那一页上两行(「当前时段」/「近 7 天」)右边各一格 `AXStaticText`(966,381)/(966,490)
     * 写的就是这两个字 —— 整格相等,不是一句话里的几个字。原来只有「已用 N%」那一条正则,
     * 于是那一页读到了、数却一条都配不上(真机:`page` ×2 + 两个小标题命中,`used` 0 条)。
     * 「未消耗」= 已用 0% = 还剩 100%(`doubaoLeftPct` 里一处折),不是猜的语义。
     */
    { id: 'used_none', regex: '^未消耗$' },
    { id: 'reset_rel', regex: '^[0-9]+ ?小时(?: ?[0-9]+ ?分钟)?后重置$|^[0-9]+ ?分钟后重置$' },
    { id: 'reset_abs', regex: '^[0-9]{1,2}月[0-9]{1,2}日 ?[0-9]{1,2}:[0-9]{2} ?重置$' },
  ],
  parse: last => doubaoQuotaOf(last),
  /*
   * 页名就是上面那条 `page` 正则认的那一个(头像 →「订阅与额度管理」)。
   *
   * **深链永远没有**:2026-10-03 读 `/Applications/Doubao.app/Contents/Info.plist` ——
   * 压根没有 `CFBundleURLTypes`,一条 scheme 都不注册(官网版 2.30.4,Developer ID
   * 「Beijing Chuntian Zhiyun Technology」,不是 App Store 版;`NSPrincipalClass` 是
   * `BrowserCrApplication` —— 它是个 Chromium)。
   *
   * ★ **2026-10-03(卡 QT)查实的三件事,`press` 这一格因此仍旧空着:**
   *
   * ① 卡 QP 写的「豆包的辅助功能通道压根不通(-25204,一扇窗都列不出)」**不对** ——
   *    通道是通的:`probe read-texts com.bot.pc.doubao --no-unhide` 读到 102 块字 / 走 517 个节点 / 127ms。
   *    那几次 -25204 是**间歇**的:一按下键它忙起来的那一分钟里,「放出来再读」会回
   *    「一扇标准窗口都没有」,而同一刻「按原样读」照旧读得到(这正是这张卡把读额度改成
   *    「先按原样读、放窗只当第二眼」的由来,见 `readOne`)。
   * ② 通向那一页的入口**认出来了**:侧栏最底下一颗 `AXPopUpButton`,身上写着「<账号名> 标准套餐」,
   *    里面那一截静态字是「标准套餐」(`probe quota-keys com.bot.pc.doubao --at 60,945` 的整条链)。
   *    壳原来的角色白名单里没有 `AXPopUpButton` —— 补上之后 `probe quota-page com.bot.pc.doubao 标准套餐`
   *    连按三次都回 `found:true, pressed:true, how:ax_press`,`front_before == front_after`(没抢焦点)、
   *    读完藏回去了。
   * ③ **可是按下去什么都没发生**:按完在同一次放出来里再照一遍(`--keys`),那扇窗的树与按之前
   *    一模一样(visited 388 → 388,那颗 `AXPopUpButton` 还在原处),应用元素底下也没有多出
   *    任何 `AXMenu`。它弹的是 Chromium 交给系统画的**原生弹出菜单** —— 原生菜单要那家在台前才跟踪得住,
   *    后台按下去不弹。「订阅与额度管理」在那张菜单里,所以这条路到不了。
   *
   * 于是填一颗 `press` 也只是每 10 分钟白按一下她的 App(D13:不写一个办不到的步骤),
   * 这一格**空着是查实的结果**。剩下的路写在 `docs/交接-1003-三家额度自动读到.md`。
   * 她自己哪天把豆包停在那一页上,这一轮(不放窗、127ms)就读到了 —— 那条路一直是通的。
   *
   * ★ **2026-10-03 第二轮(卡「豆包闪一下」):把它叫到台前也不行 —— 这一格因此仍旧空着。**
   *
   * 维护者 21:4x 拍板的前提是「那张原生菜单**只在台前跟踪得住**」。这张卡把那一下做出来
   * (壳 `quota_page` 的 `front: true`)、在这台机器上真跑了一遍 —— **前提不成立**:
   *
   * ```
   * probe quota-page com.bot.pc.doubao 标准套餐 订阅与额度管理 --front
   *   → front_got: true(真叫到台前了)、ms 2613、第一颗 found/pressed: true(ax_press)
   *     stuck: 「订阅与额度管理」、menu_roots: 0 ←★ 应用元素底下一棵不是窗的树都没有
   *     front_before == front_after(台前还回去了)、hidden_settled: true(藏回去了)
   * ```
   *
   * 也就是说:**台前按下去那张菜单照样不进辅助功能树**(背景那一次是 visited 388 → 388,
   * 这一次两趟合起来 776,树里照旧只有那颗 `AXPopUpButton` 自己)。
   * 顺带查实:那颗键身上那个 `AXShowMenu` **不是「打开它自己的菜单」** ——
   * `probe quota-keys --at 60,945` 整条链上**每一个节点**(`AXWebArea` / 十来层 `AXGroup` /
   * 连那截静态字)都带着 `AXShowMenu`,那是 Chromium 给每个节点挂的「右键菜单」动作。
   *
   * 所以那一轮 `press` + `front_ok` 两格都空着。剩下的只有一条路 ——「**只在台前、对着那颗键
   * 合成一次鼠标点击**」,而 `quota_page` 从第一天起写着「一次鼠标点击都不合成」。
   *
   * ★ **2026-10-04(卡「豆包台前点一下」):维护者拍板「可以」,这三格因此填上了。**
   *
   * 真机量到的(`probe quota-page com.bot.pc.doubao 标准套餐 订阅与额度管理 --front --click`):
   *
   * ```
   * → front_got: true、how: front_click、click_rect {x:204,y:989,w:232,h:49}(点之前现取的)
   *   front_before == front_after(台前还回去了)、hidden_settled: true(藏回去了)、ms 1992
   *   ★ menu_roots: 0,而且 CGWindowList 这几秒里一扇多出来的窗都没有(`--watch-menu`)
   *     → **这条路上压根没有「原生菜单」这回事**:点下去直接在窗口里开一层
   *       `AXWebArea「订阅与额度管理 - 豆包」`(448,97 600x777)
   * ```
   *
   * 两条由此定下来:
   *
   * ① `press` 只有**一颗**「标准套餐」——「订阅与额度管理」是那一页的**标题**(`page` 那条正则认的
   *    就是它),不是一颗键:两次 `--front --click` 里它都「认不出」(壳走完整棵树 793 个节点)。
   *    填第二颗只会每次换回一个 `stuck`(D13)。
   * ② 到了那一页之后**按原样读得到、而且一直停在那儿**:10-04 07:3x 起每 45 秒读一次,
   *    连着十来轮都命中(149–226ms、一扇窗不动、`app_hidden: true`)——
   *    `page` ×2(「标准套餐」/「订阅与额度管理」)+「当前时段」+「近 7 天」+ 两格「未消耗」。
   *    所以「动手一次之后工作台能自己静默读」这句**是真的**(交接里有那张表)。
   *
   * 没查实的一条照实记:**那一下点完立刻把它藏回去,那一页活不活得下来**。
   * 量到的两次里,台前还回去 + 藏回去的那一次(m1)之后那一页没留下来,而这一轮结束时
   * 它**没被藏回去**的那一次(m2)留下来了 —— 两次点的是同一颗键、同一个矩形,
   * 哪一下真把它翻过去的没分开量(见 `docs/交接-1004-豆包台前点一下.md` 第 3 节)。
   * 真机装上之后要盯的第一件事就是这一条:她点一次「读一下」,那一格有没有当场变成今天。
   */
  reach: { page: '订阅与额度管理', press: ['标准套餐'], front_ok: true, front_click: true },
}
registerWindowQuota('doubao', DOUBAO_WINDOW)

/**
 * 同一行算多远(点)。那一页上「当前时段」与它右边的「已用 <1%」是**同一行**(y 差几点),
 * 重置那一行在它底下、又在下一格小标题之上 —— 所以分组只要一条规矩:
 * 「归给 y 在它之上(或同一行)的**最后**那个小标题」。这点余量是给「同一行渲染时差几点」留的,
 * 不是给猜的:两格之间隔着一根横条,差着几十点,12 点碰不到下一格。
 */
const DOUBAO_SAME_ROW = 12

/** 一扇窗的三段:小标题(锚)、「已用 N%」、重置那一行。 */
interface DoubaoGroup { label: string, marker: WindowTextMatch, used?: WindowTextMatch, reset?: WindowTextMatch }

/**
 * 按位置(y)把那两组三段各自配成一组(同 Manus 靠 x 认「顶栏右半边」那种写法:位置是这一页上
 * 唯一说得清「这个百分比是哪一扇窗的」的东西 —— 两行字一模一样,只有前后关系不同)。
 */
export function doubaoWindowGroups(matches: readonly WindowTextMatch[]): DoubaoGroup[] {
  const seen = new Set<string>()
  const groups: DoubaoGroup[] = []
  for (const marker of [...matches].sort((left, right) => left.y - right.y)) {
    if (marker.id !== 'window_5h' && marker.id !== 'window_7d') continue
    // 同一个小标题读到两回(极少见)只认上面那个:多出来的一格会把下面那一组的重置抢走。
    if (seen.has(marker.id)) continue
    seen.add(marker.id)
    groups.push({ label: marker.id === 'window_5h' ? '5h' : '周', marker })
  }
  for (const one of matches) {
    // `used_none`(「未消耗」)与「已用 N%」占**同一格**:它们在那一页上就是同一个位置的两种写法。
    const slot = one.id === 'used' || one.id === 'used_none'
      ? 'used'
      : one.id === 'reset_rel' || one.id === 'reset_abs' ? 'reset' : undefined
    if (slot === undefined) continue
    let owner: DoubaoGroup | undefined
    for (const group of groups) if (group.marker.y <= one.y + DOUBAO_SAME_ROW) owner = group
    // 没有归属(它在第一格小标题之上)就丢掉 —— 那一页上头还有「升级至付费订阅」那两行入口。
    if (owner === undefined || owner[slot] !== undefined) continue
    owner[slot] = one
  }
  return groups
}

/**
 * 「已用 N%」→ 还剩多少。**「已用 <1%」当 1% 算**(剩 99):它说的是「不到 1%」,
 * 按 1% 折等于把剩余说少一点点 —— 宁可少说剩余,不多报(同额度这一路的老口径)。
 *
 * ★ 2026-10-04:**「未消耗」= 已用 0% = 还剩 100%**(那一页上一个字都没用过时就写这两个字)。
 * 这一条**整格相等**才认 —— 它是那一行右边一整格静态字,不是一句话里的两个字。
 */
function doubaoLeftPct(text: string): number | undefined {
  if (text === '未消耗') return 100
  const used = Number(/([0-9]{1,3})/.exec(text)?.[1])
  if (!Number.isFinite(used)) return undefined
  return Math.max(0, Math.min(100, 100 - used))
}

/**
 * 重置那一行 → 时刻。**这两种都折得出来,跟 Muse 那句「Oct 1」不是一回事**:
 * - 相对(「4 小时 45 分钟后重置」)是相对**读到它的那一刻**说的,而那一刻我们知道(`at`)→ 折出来是准的;
 * - 绝对(「10月2日 16:02 重置」)缺的只有年份,而 7 天窗的重置一定在往后不远处 → 取本地年份;
 *   折出来落在读到那一刻之前一天多的,说的是明年(12 月读到「1月2日」那一下)。
 *
 * (Muse 那句「Weekly limit resets on Oct 1」没有年份**也没有时刻**,折出来的「几点」是编的,所以那边只抄原话。)
 */
export function doubaoResetAt(text: string, atIso: string): string | undefined {
  const at = new Date(atIso)
  if (Number.isNaN(at.getTime())) return undefined
  const hm = /^([0-9]+) ?小时(?: ?([0-9]+) ?分钟)?后重置$/.exec(text)
  if (hm !== null) return new Date(at.getTime() + (Number(hm[1]) * 60 + Number(hm[2] ?? 0)) * 60_000).toISOString()
  const mm = /^([0-9]+) ?分钟后重置$/.exec(text)
  if (mm !== null) return new Date(at.getTime() + Number(mm[1]) * 60_000).toISOString()
  const abs = /^([0-9]{1,2})月([0-9]{1,2})日 ?([0-9]{1,2}):([0-9]{2}) ?重置$/.exec(text)
  if (abs === null) return undefined
  const fold = (year: number): Date => new Date(year, Number(abs[1]) - 1, Number(abs[2]), Number(abs[3]), Number(abs[4]))
  const when = fold(at.getFullYear())
  const folded = when.getTime() < at.getTime() - 86_400_000 ? fold(at.getFullYear() + 1) : when
  return Number.isNaN(folded.getTime()) ? undefined : folded.toISOString()
}

/** 「这一扇窗上确实是『订阅与额度管理』那一页」的旁证(整格标题;优先拿页名那一条来念)。 */
function doubaoOnQuotaPage(last: NonNullable<WindowQuotaReading['last']>): WindowTextMatch | undefined {
  const pages = last.matches.filter(one => one.id === 'page')
  return pages.find(one => one.text === '订阅与额度管理') ?? pages[0]
}

/**
 * 豆包办公那几小段 → ① 有数(两扇窗);没有那一页的旁证、或者一扇窗都配不齐,回 undefined。
 *
 * `line` / `level` / `left_pct` / `reset_at` 全由 `numbersFromEntry` 按**最紧的那一扇**说
 * ——「5 小时只剩 9%」不许被「周还剩 74%」盖住,这条是老四格一直的规矩,豆包照用,不另写一套。
 */
export function doubaoQuotaOf(last: NonNullable<WindowQuotaReading['last']>): AgentQuotaView | undefined {
  const page = doubaoOnQuotaPage(last)
  if (page === undefined) return undefined
  const windows: QuotaWindow[] = []
  const quoted: string[] = []
  for (const group of doubaoWindowGroups(last.matches)) {
    if (group.used === undefined) continue
    const left = doubaoLeftPct(group.used.text)
    if (left === undefined) continue
    const reset = group.reset === undefined ? undefined : doubaoResetAt(group.reset.text, last.at)
    windows.push({ label: group.label, left_pct: left, ...(reset === undefined ? {} : { reset_at: reset }) })
    // 出处里写**那一页上的原话**(他一眼能对上截图);重置那一行也照抄,折出来的时刻另走 `reset_at`。
    quoted.push(`「${group.marker.text} ${group.used.text}」`)
    if (group.reset !== undefined) quoted.push(`「${group.reset.text}」`)
  }
  const got = windows.length === 0 ? undefined : numbersFromEntry('doubao', { kind: 'quota', windows })
  if (got === undefined) return undefined
  const when = `${clock(last.at)} 在${inSentence(titleOf('doubao'))}窗口上读到的`
  return { ...got, windows, read_at: last.at, source: `${when}(「${page.text}」页上写着${quoted.join('、')})` }
}

registerQuotaAdapter('doubao', ctx => windowQuota('doubao', ctx.window?.doubao, doubaoQuotaOf, {
  why: '豆包办公的额度只在它「订阅与额度管理」那一页上',
  short: '额度只在它「订阅与额度管理」那一页上',
  // ★ 2026-10-04(卡「豆包台前点一下」):这两句话跟着能力改了 —— 她不用自己去豆包里点了,
  // 点「读一下」工作台会闪一下它、点开那一页再读完还原(自动那一轮不闪她的屏,见 `reachPage`)。
  hint: '点一下「读一下」,工作台会闪一下豆包办公、替你点开「订阅与额度管理」那一页再读,读完立刻把台前与窗口都还原',
  missed: '这会儿不在「订阅与额度管理」那一页上;点一下「读一下」,工作台闪一下豆包办公替你点开那一页(自动那几轮不闪你的屏)',
  missedShort: '不在「订阅与额度管理」那一页上',
}))

// ───────────────── 开集那条路(2026-09-26,卡 QO:新接上的任何一家)─────────────────

/** 该走开集读法的一家:登记表 id、界面上的名字、它那个 App 的包标识。 */
export interface OpenQuotaFamily { id: string, title: string, bundleId: string }

/**
 * ★ **Grok Bot 的额度在哪一页**(2026-10-03,卡 QT)。
 *
 * 开集那几家从前**压根没有格子可填**(卡 QP 的交接:「它们没有 `reach` 这张表」)——
 * 这张卡把 `reach` 挪成两条路共用的一张(`registerQuotaReach` / `quotaReachFor`),
 * 开集那条链(`readOpenWindow`)也接上了,所以这里能填了。
 *
 * **真机量到的(`probe quota-keys com.anysphere.sand`,10-03):**
 *
 *   AXMenuItem (22,708) 220x30  ['SuperGrok 6%']      ← 额度就是这一行
 *   AXMenuItem (22,740) 220x30  ['Get Grok Bot for mobile']
 *   AXMenuItem (22,772) 220x30  ['Support']
 *   AXMenuItem (22,804) 220x30  ['Settings']
 *   AXMenuItem (22,847) 220x30  ['Add account']
 *   AXMenuItem (22,879) 220x30  ['Log out']
 *
 * **`press` 这一格空着,是查实的结果**,两条都挡着:
 *
 * ① 「SuperGrok 6%」是那颗键**身上的字**(`AXMenuItem` 的 title),不是一块 `AXStaticText` ——
 *    而 `read_texts` 按设计只收 `AXStaticText` 的 `AXValue`(见壳 `TextInsert.staticTexts`)。
 *    同一刻用额度那几条正则读它,`text_nodes: 89`、命中 **0** 条;整扇窗的静态字里一个百分号都没有。
 *    也就是说 Grok Bot 这一格**不是「没翻到那一页」,是那个数压根不在我们读的那一类节点上**。
 * ② 那六行只在**她的账号菜单开着**的时候才在树上(10-03 那一刻恰好开着:六行都有真实矩形)。
 *    菜单收起来时通向它的那颗键叫什么、按不按得动,**没量到**(那一刻菜单正开着,
 *    开着的时候树里认不出那颗触发键)。
 *
 * 所以今天只写页名:格子上说得出「额度在它账号菜单那一行上」,而不去按一颗没查实的键
 * (D13)。剩下的路写在 `docs/交接-1003-三家额度自动读到.md`。
 *
 * ★ **2026-10-03 第二轮(卡「Grok 读键字」):量齐了三件事,`read_titles` 因此填上、`press` 仍旧空着。**
 *
 * 维护者 21:4x 拍板「让 `read_texts` **按家声明**地也读键上的字」。这张卡把那一格做出来
 * (壳 `read_texts` 的 `include_titles`),并在这台机器上把卡 QT 没量到的那几件量齐了:
 *
 * 1. **账号菜单收起来的时候那六行真的不在树上**,而通向它的那颗键叫
 *    **`Open account menu`**(`AXPopUpButton` (16,919) 36×36 —— 卡 QT 那一刻菜单正开着,所以没看见它);
 * 2. **后台 `AXPress` 它按得开**:`probe quota-page com.anysphere.sand "Open account menu"`
 *    → `found/pressed: true`、77ms、`front_before == front_after`(没抢焦点)、读完照旧藏着;
 *    **等一拍之后**那六行进了树(`AXMenuItem (22,708) ['SuperGrok 0%']` 就是额度那一行)——
 *    它是**网页里的 ARIA 菜单**,与豆包那张原生菜单不是一回事(那张台前也不进树);
 * 3. **带 `include_titles` 之后那一行真读到了**:用**生产那九条开集正则**读,
 *    `text_nodes` 83 → 90、命中 `pct 'SuperGrok 0%'`(不带那一格时命中 0)。
 *
 * **可是那个数今天还用不了**,两条各自挡着(所以 `press` 空着,不每 10 分钟去开她的账号菜单):
 *
 * - **同一扇窗上没有旁证**:整扇窗只命中那一条 `pct`,`page` / `plan` / `limit` / `reset` 一条都没有
 *   (拿 `supergrok|usage|limit|reset|remaining|used|subscription|upgrade|billing|plan` 这一组词
 *   再读一遍也只有那一行)。而开集那条路按设计「**只有数字的那一组一律不问模型**」——
 *   那正是聊天窗的样子,这道门不能为一家放宽(`openQuota.ts` 的三道门)。
 * - **「N%」是已用还是剩余没查实**:这台机器 09-27 落盘的那一份判词是在它
 *   **Usage & Billing 那一页**上判的(`measure: used_pct`、旁证「Usage & Billing」、列名「Weekly Usage」),
 *   而账号菜单这一行上一个字的说明都没有;量到的两个样本(10-03 20:0x「6%」→ 22:5x「0%」)
 *   两种解释都讲得通(周窗重置 / 她把最后 6% 用掉了)。**宁可读不到,不给一个方向都可能反的数。**
 * - 顺带查实:菜单项**从后台按不动**(`probe quota-page … Settings` 回 `pressed: true`,
 *   而那一页压根没换、树一个字没变)—— 所以「按开菜单 → 进 Settings → 翻到 Usage & Billing」
 *   那条路这一版也到不了(那一页正是 09-27 读到过数的地方)。
 *
 * 下一步要什么、怎么接,写在 `docs/交接-1003-豆包闪一下与Grok读键字.md` 第 6 节。
 *
 * ★ **2026-10-04(卡「Grok 读已用」):维护者答了那一句,这一家因此从开集那条路搬到窗口型。**
 *
 * 维护者 10-04 原话:「**SuperGrok N% 是已用**」(0% = 没用过)。挡着的两条于此全没了:
 *
 * - **旁证那道门不再适用**:那道门是**开集那条路**的(同一扇窗上既有数字又有界面字才值得问模型)。
 *   窗口型这条路**压根不问模型** —— 认不认是这一家自己那条**整格相等**的正则说的,
 *   而「`^SuperGrok\s*[0-9]{1,3}\s*%$`」自带旁证:整格就这么长,前面写着它自己的套餐名。
 * - **口径定了**:`used_pct` —— 与 09-27 落盘那份判词(`measure: used_pct`、列名「Weekly Usage」)同一个方向,
 *   折算照 Muse / 开集那条老规矩(「已用 N%」→「还剩约 (100−N)%」,`left_pct` 填剩余)。
 *
 * 于是 `press` 填上**已查实的那颗键**(`Open account menu`:后台 `AXPress` 按得开、不抢焦点、量过 77ms),
 * `front_ok` **仍旧空着**(这一家压根不需要台前;10-03 22:4x 那条规矩:凡会把 App 顶到前台的
 * 动作自动那一轮一律不许走)。**一家一处**:`registerQuotaReach` 那一行撤掉了 ——
 * 这张表现在由 `registerWindowQuota` 代登(声明它的地方是 `GROK_BOT_WINDOW.reach`),
 * 而 `registerQuotaAdapter` 一登,`openQuotaFamilies` 就不再把它算进开集(`hasQuotaAdapter`),
 * 开集那条路一轮都不再读它。
 *
 * ★ **已知副作用,如实写**:按开的那张菜单**从后台收不回去**(10-03 量过三条:菜单开着时那颗触发键
 * 不在树上、菜单项后台按不动、叫到台前也不会让它自己收)。所以 `back` 这一格空着,
 * 而第一眼**按原样读**那条老规矩正好把这件事压到最小:那一行已经在树上时(菜单开着)
 * 第一眼就读到了,一颗键都不按(`readOne`:读到就 return)。按一次之后菜单留在开着的状态 ——
 * Grok Bot 本身照旧藏着(她眼前看不见),她下次打开它随手点一下窗口里别处就收了。
 */
export const GROK_BOT_FAMILY_ID = 'com.anysphere.sand'

/**
 * 界面上念这一家的名字(**退路**)。
 *
 * 它的登记表 id 是包标识,`titleOf` 认不出 —— 不给这一格,「没接上」那几句里会写着
 * 「还没读过 com.anysphere.sand 窗口上的额度」。`/state.agent_quota` 那一层照旧用登记表里的名字
 * 盖 `view.title`(http 的 `agentQuotaNow`),这一格只管句子里念出来的那几个字。
 */
export const GROK_BOT_TITLE = 'Grok Bot'

/**
 * ★ **Grok Bot:窗口型额度**(2026-10-04,卡「Grok 读已用」)。
 *
 * 那个数在它账号菜单里**一颗 `AXMenuItem` 身上的字**(`AXTitle`:「SuperGrok 0%」),
 * 所以这一家声明 `read_titles`(壳 `include_titles`,只给它一家 —— 见上面那段)。
 */
export const GROK_BOT_WINDOW: WindowQuotaSpec = {
  bundleId: GROK_BOT_FAMILY_ID,
  patterns: [
    /*
     * **整格相等**(卡 MQ 那条纪律:整格才算,一句话里提到配不上)。
     *
     * 真机那一行原样是「SuperGrok 0%」(`AXMenuItem (22,708) 220x30`)。两处留空白余量:
     * 名字与数之间(真机是一个空格)、数与百分号之间(真机没有空格)—— 它哪天改了排版不至于白读。
     * 不认「Grok N%」之类别的写法:没量到过,写上去就是猜(D13)。
     */
    { id: 'used', regex: '^SuperGrok\\s*[0-9]{1,3}\\s*%$' },
  ],
  parse: last => grokBotQuotaOf(last),
  reach: {
    page: '账号菜单那一行(SuperGrok N% = 已用)',
    /*
     * 已查实按得开的那一颗(10-03:`probe quota-page com.anysphere.sand "Open account menu"`
     * → `found/pressed: true`、`ax_press`、77ms、`front_before == front_after`、读完照旧藏着;
     * **等一拍**那六行才进树 —— 壳按完等的那一拍 `QUOTA_REACH_SETTLE_MS` 900ms 正是它)。
     * 它是**网页里的 ARIA 菜单**,与豆包那张原生菜单不是一回事(那张台前也不进树)。
     */
    press: ['Open account menu'],
    /*
     * `back` 空着**是查实的结果**:菜单开着时那颗触发键不在树上、菜单项从后台按不动
     * (10-03 量过 `probe quota-page … Settings`:回 `pressed: true` 而那一页压根没换)。
     * 填一颗只是白按一下她的 App。菜单留开着这件事如实记在交接里,不假装收回去了。
     */
    // ★ 这一家**声明**了「连键身上的字也读」(壳 `include_titles`)。只给它一家 ——
    // Muse / 豆包那条「这确实是额度那一页」的旁证是按整格静态字认的,一开就被一颗同名的键骗过去。
    read_titles: true,
  },
}
registerWindowQuota(GROK_BOT_FAMILY_ID, GROK_BOT_WINDOW)

/**
 * Grok Bot 那一行 →(**「N%」是已用**,维护者 2026-10-04 拍板);认不出回 undefined。
 *
 * 折算与 Muse / 开集那条路一模一样(`openQuotaView` 的 `used_pct`):「已用 N%」→「还剩约 (100−N)%」,
 * `left_pct` 填**剩余**(界面上那条横条、派活确认点里那一句读的都是它)。
 * 出处写**那一行的原话** + 这个数是已用 —— 她一眼能对上她自己看到的那一行。
 */
export function grokBotQuotaOf(last: NonNullable<WindowQuotaReading['last']>): AgentQuotaView | undefined {
  const used = last.matches.find(one => one.id === 'used')
  if (used === undefined) return undefined
  const pct = Number(/([0-9]{1,3})/.exec(used.text)?.[1])
  if (!Number.isFinite(pct)) return undefined
  const left = Math.max(0, Math.min(100, 100 - pct))
  const level = left <= 1 ? 'empty' : left < BALANCE_LOW_PCT ? 'low' : 'ok'
  const line = level === 'empty' ? '用量用完了' : level === 'low' ? `只剩约 ${left}%,快用完了` : `还剩约 ${left}%`
  return {
    id: GROK_BOT_FAMILY_ID,
    title: GROK_BOT_TITLE,
    read_at: last.at,
    state: 'numbers',
    level,
    left_pct: left,
    line,
    source: `${clock(last.at)} 在 ${GROK_BOT_TITLE} 账号菜单那一行上读到的(「${used.text}」—— 那个数是已用)`,
  }
}

registerQuotaAdapter(GROK_BOT_FAMILY_ID, ctx => windowQuota(
  GROK_BOT_FAMILY_ID,
  ctx.window?.[GROK_BOT_FAMILY_ID],
  grokBotQuotaOf,
  {
    why: '额度只在它账号菜单那一行上(「SuperGrok N%」= 已用)',
    short: '额度只在它账号菜单那一行上',
    // 这一家不用她动手:那颗键后台按得开(量过 77ms、不抢焦点)。真按不动时下面那句话才出场。
    hint: '不用你动手:工作台会在后台按一次它的账号菜单,把「SuperGrok N%」那一行读回来',
    missed: '这会儿没读到「SuperGrok N%」那一行(它只在账号菜单开着时才读得到)',
    missedShort: '没读到账号菜单那一行',
  },
  GROK_BOT_TITLE,
))

/**
 * 开集那条路读到的一家:**认出来的那一份**(带方子,重读照它就地再算)+ 最近一次尝试。
 *
 * 与从窗口上读的那几家(`WindowQuotaReading`)同一套骨架,多了两样:`recipe`(重读时不叫模型靠它)、
 * `budget`(今天判额度的模型钱花完了 —— 那是这条路独有的一种「这次没读成」)。
 */
export interface OpenQuotaReading {
  /**
   * ★ **原生那条路最近一次读到的**(2026-09-27,卡 AN;今天只有 Antigravity 有)。
   *
   * 「直接问它自己」比「看它窗口」好得多(不要辅助功能、不受「只看得见当前桌面」限制、不会被聊天内容污染、
   * 不会读反口径、天生分好组、带真的重置时刻、不用他去开那一页),所以 **`openQuotaCell` 优先摆它**。
   * 但两条路各记一格、**谁新摆谁**:原生那条哑掉(他把 Antigravity 关了、它换了令牌、接口改了)时,
   * 窗口读法那一份就是唯一还能说话的那一条,不能被一个更旧的原生数压住。
   */
  native?: { at: string, view: AgentQuotaView }
  /**
   * 原生那条路**这一次**卡在哪一步(说人话,`readAntigravityNative` 抛的那一句)。
   * 两条路都没数时,这一句要进那一格 —— 不许一句笼统的「读不到」(D13)。
   */
  nativeWhy?: string
  /**
   * 界面上念这一家的名字(登记表里那个)。`titleOf` 只认得出写死的那几家,开集这几家的名字只有登记表知道
   * —— 那一格里「打开 Grok Bot」「读过 Grok Bot 的窗口」念的就得是它。
   */
  title?: string
  /** 最近一次**认出来**的时候。`window` = 在这个 App 的第几扇窗上认出来的(下次先试那一扇)。 */
  found?: { at: string, window: number, view: AgentQuotaView, recipe: OpenQuotaRecipe }
  /**
   * 最近一次尝试。`found:false` 时:`error` = 连窗口都没读到;`budget` = 今天判额度的模型钱到上限了;
   * `why` = 读到窗口了、但这一页上没看见用量(或者模型这次没判成)。
   */
  attempt?: {
    at: string
    found: boolean
    error?: WindowReadError
    note?: string
    offspace?: number
    why?: string
    /**
     * 同一步的**短说法**(2026-09-27,卡 AG)。长的那句进额度那一行,短的这句进
     * 派活确认点的括号与「读一下」按完那句话 —— 那两处只有一行,摆一整段会把别的字挤没。
     */
    whyShort?: string
    budget?: string
  }
}

/** 还没读过它窗口上的用量时那一句。 */
const OPEN_NEVER_READ = '还没读过它窗口上的用量'

/**
 * 一份读出来的数 → 那一格(**`line` 用它的原话折成人话,`source` 写几点在谁的窗口上读到的、原话是什么**)。
 *
 * 折算只做一步:`used_pct` 的「已使用 38%」折成「还剩约 62%」。别的一律照原话 ——
 * 重置那一句**不折算成时刻**(「Oct 1」没有年份也没有时区,折出来的那个时刻是编的,D13),原话照抄。
 */
export function openQuotaView(input: {
  id: string
  title: string
  at: string
  numbers: OpenQuotaNumbers
}): AgentQuotaView {
  const { id, title, at, numbers } = input
  const when = `${clock(at)} 在${inSentence(title)}的窗口上读到的`
  // 出处把**每一条**的原话都写上(卡 QG:Antigravity 那一页四条,一条不落)。
  const said: { text: string, label?: string, group?: string }[] = [
    { text: numbers.quote.text, ...(numbers.label === undefined ? {} : { label: numbers.label }), ...(numbers.group === undefined ? {} : { group: numbers.group }) },
    ...(numbers.extra ?? []).map(one => ({
      text: one.quote.text,
      ...(one.label === undefined ? {} : { label: one.label }),
      ...(one.group === undefined ? {} : { group: one.group }),
    })),
    ...(numbers.reset === undefined ? [] : [{ text: numbers.reset }]),
  ]
  // 一条不落,而且**原话归原话**:行名与数各自加引号,不拼成一句它没说过的话。
  // 只有一条数时不写行名(「Usage」「已使用 38%」里那个行名是噪音);好几条时非写不可 ——
  // 不然出处就是「100%」、「100%」、「98%」、「100%」,谁也认不出哪一条是哪一行(卡 QG)。
  const rowNames = (numbers.extra?.length ?? 0) > 0
  // ★ 卡 AG:组名也照抄进出处(「Gemini Models」「Weekly Limit Remaining」「100%」)——
  // 这一页上四个「100%」里有两个一字不差,不写组名谁也认不出哪一条是哪一组的。
  const quoted = `${when}:${said.map((one) => {
    if (one.label === undefined || !rowNames) return `「${one.text}」`
    return `${one.group === undefined ? '' : `「${one.group}」`}「${one.label}」「${one.text}」`
  }).join('、')}`
  const base = { id, title, read_at: at, source: quoted }
  if (numbers.kind === 'unlimited') return { ...base, state: 'unlimited', line: '不限', short: '不限' }
  const measure = numbers.measure
  if (measure === 'left_amount') {
    const amount = numbers.value
    const unit = numbers.unit ?? ''
    const text = numbers.text ?? ''
    // 「还剩多少个」没有总数,所以判不出「快用完了」—— 不替他编一条线,只认 0(用完了)。
    const level = amount !== undefined && amount <= 0 ? 'empty' : 'ok'
    const line = level === 'empty' ? `${unit === '' ? '' : unit}用完了` : `剩 ${text}${unit === '' ? '' : ` ${unit}`}`
    return {
      ...base,
      state: 'numbers',
      level,
      line,
      left: { text, unit, ...(amount === undefined ? {} : { amount }) },
    }
  }
  const leftOf = (one: { measure: 'used_pct' | 'left_pct' | 'left_amount', value?: number }): number =>
    Math.max(0, Math.min(100, Math.round(one.measure === 'used_pct' ? 100 - (one.value ?? 0) : one.value ?? 0)))
  // 这一页上不止一条(卡 QG:Antigravity 的周限额 / 5 小时限额):一行一条横条,**同名的那一行
  // 取最紧的那一个**(读不回组名 ——「Gemini Models」「Claude and GPT models」没有哪条正则认得出,
  // 壳一次只收 8 条正则,已经占满)。`line` 照老规矩只说最紧的那一扇(同豆包办公)。
  // 这里只剩百分比那两种(「剩多少个」上面已经回了)。
  const pct: 'used_pct' | 'left_pct' = measure === 'used_pct' ? 'used_pct' : 'left_pct'
  const all: { measure: 'used_pct' | 'left_pct', value?: number, label?: string, group?: string, x: number, y: number }[] = [
    {
      measure: pct,
      ...(numbers.value === undefined ? {} : { value: numbers.value }),
      ...(numbers.label === undefined ? {} : { label: numbers.label }),
      ...(numbers.group === undefined ? {} : { group: numbers.group }),
      x: numbers.quote.x,
      y: numbers.quote.y,
    },
    ...(numbers.extra ?? []).map(one => ({
      measure: one.measure,
      value: one.value,
      ...(one.label === undefined ? {} : { label: one.label }),
      ...(one.group === undefined ? {} : { group: one.group }),
      x: one.quote.x,
      y: one.quote.y,
    })),
  ]
  // ★ 卡 AG:**照页面上的先后排**(上面的先说),不照模型 `items` 里的顺序 ——
  // 模型是按「同一个数字写法」挨个列的,于是两组的「100%」会连在一起,画出来的表跟他眼前那一页对不上。
  all.sort((a, b) => (a.y - b.y) || (a.x - b.x))
  // ★ 卡 AG:**一行一条,照它页面怎么列就怎么列**。认人认的是「组名 + 行名」——
  // Antigravity 的「Weekly Limit Remaining」两组各有一条,只按行名认就会把两组并成一条
  // (卡 QG 当时组名读不回来,只能那么并;现在读得回来了,就照它列)。
  const rows: { label: string, left_pct: number, group?: string }[] = []
  for (const one of all) {
    if (one.label === undefined) continue
    const left = leftOf(one)
    const same = rows.find(row => row.label === one.label && row.group === one.group)
    if (same === undefined) rows.push({ label: one.label, left_pct: left, ...(one.group === undefined ? {} : { group: one.group }) })
    else same.left_pct = Math.min(same.left_pct, left)
  }
  // 一行一条横条只在**每一条都有自己的行名**时才画(缺一个名字就画不成一张表,那就照老样子只画一条)。
  const many = rows.length > 1 && all.every(one => one.label !== undefined)
  const left = many ? Math.min(...rows.map(one => one.left_pct)) : leftOf({ measure: pct, ...(numbers.value === undefined ? {} : { value: numbers.value }) })
  const level = left <= 1 ? 'empty' : left < BALANCE_LOW_PCT ? 'low' : 'ok'
  const line = level === 'empty' ? '用量用完了' : level === 'low' ? `只剩约 ${left}%,快用完了` : `还剩约 ${left}%`
  return { ...base, state: 'numbers', level, line, left_pct: left, ...(many ? { windows: rows } : {}) }
}

/**
 * ★ **Antigravity 走原生那条路读回来的 → 那一格**(2026-09-27,卡 AN)。
 *
 * 取数那一半在 `quota/antigravityNative.ts`(**它的令牌是它自己放在命令行与日志里的,我们现取现用、
 * 用完就丢**,一个字都不落地);这里只做「翻成界面上那一格」,和窗口读法那条(`openQuotaView`)
 * 出的是**同一副骨架** —— 电脑页面那四条横条、手机上那一段细账,都是现成的 `AgentQuotaView.windows`,
 * 一行界面代码都不用改(卡 AG 已经做好)。
 *
 * 与窗口读法的三处不同,全是原生这条路白拿的:
 * - 组名 / 行名是**它自己给的** `displayName`,不是正则认出来的;
 * - 剩余是**它自己给的** `remainingFraction`,不会读反口径(卡 QG 那个「5% 读成只剩 5%」根本不存在);
 * - 重置是**带时区的真时刻**(`resetTime`),不是「Oct 1」那种不敢折算的字样。
 *
 * `line` 照老规矩只说**最紧的那一行**(同豆包办公、同窗口读法)—— 派活确认点、手机通知里读的是它。
 * 一条限额都没给就**抛错**(走「这会儿读不到」、退回窗口读法),不画一张空表(D13)。
 */
export function antigravityNativeView(input: {
  id: string
  title: string
  at: string
  groups: readonly AntigravityGroup[]
}): AgentQuotaView {
  const { id, title, at, groups } = input
  // 照它页面怎么列就怎么列:组的先后、组里限额的先后,都照它给的顺序(不重排、不按数字大小排)。
  const rows: { label: string, left_pct: number, reset_at?: string, group: string }[] = []
  for (const group of groups) {
    for (const bucket of group.buckets) {
      rows.push({
        label: bucket.label,
        left_pct: bucket.leftPct,
        ...(bucket.resetAt === undefined ? {} : { reset_at: bucket.resetAt }),
        group: group.name,
      })
    }
  }
  if (rows.length === 0) throw new Error('Antigravity 的语言服务一条用量都没给')
  // 出处写清**走的是哪一条路**(维护者要能一眼看出这个数是直接问来的、还是从窗口上看来的),
  // 四条原话一条不落:**组名 / 行名 / 数各自带引号**,不拼成一句它没说过的话(同 `openQuotaView`)。
  const quoted = rows.map(one => `「${one.group}」「${one.label}」「${one.left_pct}%」`).join('、')
  const source = `${clock(at)} 直接问 Antigravity 在本机的语言服务读到的:${quoted}`
  // 最紧的那一行说话(同名同组不会重复,所以不用像窗口读法那样合并)。
  const tight = rows.reduce((a, b) => (b.left_pct < a.left_pct ? b : a))
  const left = tight.left_pct
  const level = left <= 1 ? 'empty' : left < BALANCE_LOW_PCT ? 'low' : 'ok'
  const line = level === 'empty' ? '用量用完了' : level === 'low' ? `只剩约 ${left}%,快用完了` : `还剩约 ${left}%`
  return {
    id,
    title,
    state: 'numbers',
    level,
    line,
    left_pct: left,
    read_at: at,
    source,
    ...(tight.reset_at === undefined ? {} : { reset_at: tight.reset_at }),
    // 一条时不画表(照老四格那副骨架只画一条横条);两条往上才一行一条。
    ...(rows.length > 1 ? { windows: rows } : {}),
  }
}


/**
 * 开集那条路的一格(三格之一)。
 *
 * - 认出来过 → **有数 / 不限**;这一轮没读成时那个数照给(几点读到的、老没老由 `quotaFor` 一处写上,卡 QS),
 *   几点读到的、老没老照写(2026-09-30 起不再挂键:该他自己去打开哪一页那句话写在真读不到的那一格里);
 * - 从没认出来 → 「没接上:原因」+「读一下」。原因分得清:还没读过 / 这页上没看见用量 /
 *   它没开着 / 要先授权辅助功能 / 今天判额度的模型钱用完了;
 * - **要先授权辅助功能、要新版壳**这两种打 `no_stale`(同 `lastRead` 那条纪律):这台机器这会儿根本没有
 *   读它窗口的本事,摆一个旧数会让他以为不用管那一步。
 */
function openQuotaCell(id: string, reading: OpenQuotaReading): AgentQuotaView {
  const attempt = reading.attempt
  const found = reading.found
  const title = reading.title ?? titleOf(id)
  /**
   * ★ **卡 AN(2026-09-27):原生那条路是主路,窗口读法是兜底。**
   *
   * 判法是**谁新摆谁**,不是「有原生就一定用原生」:原生那条哑掉(他把 Antigravity 关了、
   * 它换了令牌、接口改了)之后,上次那个原生数会越来越旧,而窗口读法这会儿可能刚读到新的
   * —— 那时候摆一个更旧的数就是骗人。两条路的出处各自写着自己是哪一条
   * (「直接问 … 在本机的语言服务读到的」/「在 … 的窗口上读到的」),所以他一眼看得出走的是哪条。
   */
  const native = reading.native
  if (native !== undefined && (found === undefined || Date.parse(native.at) >= Date.parse(found.at))) {
    return { ...native.view, title }
  }
  if (found !== undefined && attempt?.found === true) return found.view
  const blind = attempt?.error === 'no_ax' || attempt?.error === 'old_shell'
  // 两条路都没数时,原生这条卡在哪一步也要说出来(它是主路)——不许一句笼统的「读不到」(D13)。
  const alsoNative = reading.nativeWhy === undefined ? '' : `;直接问它自己那条路这会儿也不行:${reading.nativeWhy}`
  const neverRead = reading.nativeWhy === undefined
    ? OPEN_NEVER_READ
    : `直接问它自己那条路读不到:${reading.nativeWhy}`
  const base = attempt === undefined
    // 2026-09-30:那颗键删了,该他去打开哪一页那句话(`OPEN_QUOTA_HINT`)并进这一句里。
    ? unconnected(id, `${neverRead} —— ${OPEN_QUOTA_HINT}`, { short: OPEN_NEVER_READ })
    : attempt.budget !== undefined
      ? unconnected(id, OPEN_QUOTA_BUDGET_WHY, { short: OPEN_QUOTA_BUDGET_WHY })
      : windowUnconnected(id, { attempt }, {
        why: neverRead,
        short: OPEN_NEVER_READ,
        hint: OPEN_QUOTA_HINT,
        missed: `${attempt.why ?? OPEN_QUOTA_NOT_SEEN}${alsoNative}`,
        missedShort: attempt.whyShort ?? attempt.why ?? OPEN_QUOTA_NOT_SEEN,
      }, title)
  const said = { ...base, title }
  if (found === undefined || blind) return said
  // 认出来过 → 那个数照摆(2026-09-30:原来这里把「没读成」那一格的键搬过来,键删了就只剩这个数)。
  return found.view
}

// ───────────────────────── 读窗口的那一下(I/O)─────────────────────────

export interface WindowQuotaReaderDeps {
  /** 壳的通道。 */
  request: (req: HelperRequest, timeoutMs: number) => Promise<Record<string, unknown>>
  /**
   * 壳此刻:连没连上、有没有辅助功能权限、会不会 `read_texts`。
   *
   * `quotaPage`(2026-10-03,卡 QP)= 这份壳会不会那条**不抢焦点**的翻页 op(`quota_page`)。
   * 缺席 / false = 老壳 —— 那时自动那一轮一颗键都不按(行为与 0.4.90 一字不差),
   * 只有她亲手点「读一下」时才走 `agent_press`(那一条会把那家叫到台前)。
   *
   * ★ 2026-10-03(卡「豆包闪一下 / Grok 读键字」)多两格,都是**壳 caps 里那一格的名字**:
   * - `readTitles`(caps `read_titles`)= `read_texts` 收得了 `include_titles`
   *   (按家声明地连「键身上的字」也读);
   * - `quotaFront`(caps `quota_front`)= `quota_page` 收得了 `front`(叫到台前按、按完立刻还原)。
   *
   * 两格缺席 / false = 老壳:插件**压根不发**那两格,声明了 `read_titles` / `front_ok` 的那两家
   * 照旧停在今天那句话上(不假装读到了)。
   *
   * ★ 2026-10-04(卡「豆包台前点一下」)再多一格:
   * - `quotaClick`(caps `quota_click`)= `quota_page` 收得了 `click`(台前那一支里**第一颗键**
   *   用合成鼠标点击按)。缺席 / false = 老壳:声明了 `front_click` 的那一家(豆包)**一下都不闪**
   *   —— 闪过去只会白按一下(`AXPress` 那颗键回 success 而那一页压根不开,卡「豆包闪一下」查实)。
   */
  helper: () => {
    connected: boolean, authorized: boolean, readTexts: boolean,
    quotaPage?: boolean, readTitles?: boolean, quotaFront?: boolean, quotaClick?: boolean,
  }
  now?: () => Date
  /** 等一拍(卡 QD 的「再看一眼」;用例里注入一个立刻回的)。缺席 = 真的等。 */
  wait?: (ms: number) => Promise<void>
  /** 读完一轮(有变化才叫),`/state` 借此推一次快照。 */
  onChanged?: () => void
  /**
   * 上次**真读到**的那几小段落盘(2026-09-26,统筹):原来只记在内存里,每装一次插件 / 重启一次服务
   * 读到过的数就没了,那一格翻回「没接上」,要他再去打开那一页 —— 维护者:「刚才有一个版本 Muse 是能读取到额度的了,
   * 但是更新之后又不行了」。落盘的只有命中的那几小段(≤80 字/段)与时刻,不是整窗;「几点读到的」「数字可能旧」照 QS 口径。
   * 缺席 = 只在内存里(用例)。
   */
  store?: {
    load: () => { lasts?: Record<string, NonNullable<WindowQuotaReading['last']>>, opens?: Record<string, NonNullable<OpenQuotaReading['found']>> } | undefined
    save: (data: { lasts: Record<string, NonNullable<WindowQuotaReading['last']>>, opens: Record<string, NonNullable<OpenQuotaReading['found']>> }) => void
  }
  /**
   * 排一件事到几毫秒之后做(事件触发重读的防抖用;2026-09-27,卡 AG 追加)。
   * 缺省 = `setTimeout`(`unref` 掉,不拖住退出)。用例注入一个「记下来、我自己点火」的。
   */
  schedule?: (fn: () => void, ms: number) => void
  /**
   * ★ **原生那条路**(2026-09-27,卡 AN):这一家能不能「直接问它自己」?
   *
   * 回 `undefined` = **这一家没有这条路**(照旧只走窗口读法);回一格 = 读到了;
   * **抛错** = 这条路这会儿不行(那一句话进 `nativeWhy`,并退回窗口读法)。
   * 今天只有 Antigravity 有(`quota/antigravityNative.ts`);缺席 = 一家都没有(用例里的默认)。
   */
  readNative?: (family: OpenQuotaFamily, at: string) => Promise<AgentQuotaView | undefined>
  /**
   * **开集那条路**问一次模型(2026-09-26,卡 QO):「这一页上有没有这家自己的用量数字?」
   * 走的是工作台的模型服务,与登记表判「这是不是 Agent」同一支手(`index.ts` 的 `judgeAgent`)。
   * 缺席 = 判不了(那一格说「模型服务没接上」,不瞎猜)。
   */
  judgeQuota?: (prompt: string, maxTokens: number) => Promise<string>
  /**
   * 开集那条路的花费闸门与记账。**共用登记表那一份每日上限**(`agentJudge` 的 `budgetGate` / `spend`,
   * 记在 `~/.dsh/workbench/agents.json` 的 `budget` 上)—— 卡 QO:「别另起一套模型调用与记账」。
   * 缺席 = 不记账(用例里用)。
   */
  judgeBudget?: {
    gate: (estimateCny: number) => Promise<{ ok: true } | { ok: false, why: string }>
    spend: (cny: number) => Promise<void>
  }
  /**
   * **我要去翻这几家的窗口了**(2026-09-27,卡 BB)。读额度这一路会 unhide 藏着的家、把它每一扇窗
   * 都读一遍(卡 MQ3 / AG),窗口上的字那一下会整页换。登记表那一路(`agentDiscovery`)拿两次读数的差
   * 判「它回了一句」,所以要先跟它说一声:这几家下一拍**只重新起算**,不冒气泡、不记未读。
   * 两条路就此分开 —— 读额度**永远不许**变成会话状态的一次变化。缺席 = 没接线(用例、老路径)。
   */
  onWindowTouched?: (bundleIds: readonly string[]) => void
  /**
   * ★ **跑一条命令**(2026-10-03,卡 QZ)。**只用来 `open -g -b <包>` / `open -g <深链>`** ——
   * 把一个没在跑的 App 在后台拉起来、或者开一条深链。**两样都只在她亲手点「读一下」时跑**
   * (深链 0.4.93 起如此;拉起 2026-10-19 起如此):自动那一轮只读在跑的家,这个执行器一次都不碰。
   *
   * `index.ts` 传进来的是**记「开App」那一行的那个执行器**(`withOpenCommandLog(runCommandRaw)`),
   * 所以读额度拉起过谁、几点拉的、开没开成,日志里一行不少(2026-10-02「诊断包加两样」第一样)。
   * **缺席 = 不拉、不开**(用例默认、老路径):与这一版之前一字不差。
   */
  runCommand?: (cmd: readonly string[]) => Promise<{ ok: boolean }>
  /**
   * 一行日志。**起不来 / 到不了那一页 / 她正用着那家**这几种只进这里,**一个字都不进格子**
   * (维护者 2026-10-03 第 4 条:「原因只进日志,不写格子」)。
   * `console` 那一层已经替每行盖了时间(`logStamp.ts`),这里不再自己盖。缺席 = 不记。
   */
  log?: (line: string) => void
  /**
   * 要从窗口上读的那几家(缺席 = 全局那张表 `windowQuotaSpecs()`)。
   * 给用例一份自己的表,免得往全局那张表里塞一家假的、污染别的用例。
   */
  /**
   * 她亲手从窗口槽清单里删掉的那几家(apps.json 的 `disabled`,按家名;2026-10-12,卡 `claude/ops-patch-1012`)。
   * 额度这一路也不碰它们:不起它、不读它、不翻它的页 —— 运营同学 10-09 撞到的就是 Muse 已在 disabled 里,
   * 额度采集器照旧 `open -g -b com.meta.endo` 把它反复拉起来。缺席 = 一家都没删(老行为)。
   */
  disabled?: () => Promise<ReadonlySet<string>> | ReadonlySet<string>
  specs?: ReadonlyMap<string, WindowQuotaSpec>
}

/** 读额度这条链的日志行首(排障时 `grep 额度`)。用例引常量,不逐字抄中文。 */
export const QUOTA_READ_LOG_TAG = '[额度]'

/** 壳回来的错误话 → 哪一种没读成。 */
export function readErrorOf(message: string): WindowReadError {
  if (/未知 op/.test(message)) return 'old_shell'
  if (/没在运行/.test(message)) return 'not_running'
  if (/一扇标准窗口都没有/.test(message)) return 'no_window'
  // ★卡 QD:壳这句(`SendTextPolicy.axDisabled`)说的是**那个 App** 回了 -25204,不是工作台没被授权
  //(工作台被没被授权由 `helper().authorized` 先判过了,压根走不到这儿)。分开才说得出真话。
  if (/辅助功能通道关着/.test(message)) return 'app_asleep'
  if (/not trusted|未授权/.test(message)) return 'no_ax'
  if (/未连接|没连上|断开/.test(message)) return 'no_helper'
  return 'failed'
}

function matchesOf(raw: unknown): WindowTextMatch[] {
  if (!Array.isArray(raw)) return []
  const out: WindowTextMatch[] = []
  for (const one of raw) {
    if (typeof one !== 'object' || one === null) continue
    const item = one as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.text !== 'string') continue
    out.push({
      id: item.id,
      text: item.text.slice(0, 80),
      x: typeof item.x === 'number' ? item.x : 0,
      y: typeof item.y === 'number' ? item.y : 0,
      // 老壳不带 `window`(它只读第 0 扇)—— 当成都在第 0 扇,下面分组后照旧只有一组。
      window: typeof item.window === 'number' ? item.window : 0,
    })
  }
  return out
}

/**
 * 一次 `read_texts` 回来的几扇窗,**按窗分开**(2026-09-26,卡 MQ)。
 *
 * 为什么非分不可:那几条 parse 判的是「**同一扇窗上**同时看见了什么」——
 * Muse 要「使用情况」那一页连同那个百分比,Manus 要顶栏右半边那一格积分(靠这扇窗的宽度定「右半边」)。
 * 把几扇窗的命中倒进一个篮子里,就可能拿聊天窗里的一句话去配设置窗里的一个数,读出一个**假数** ——
 * 那比读不到还坏(实测:他和 Muse 聊的就是额度,聊天记录里明晃晃写着「周限额的 0%」)。
 */
export function byWindow(
  matches: readonly WindowTextMatch[],
  sizes: readonly { index: number, w?: number }[],
): { window: number, matches: WindowTextMatch[], width?: number }[] {
  const order: number[] = []
  const bucket = new Map<number, WindowTextMatch[]>()
  for (const one of matches) {
    const at = one.window ?? 0
    if (!bucket.has(at)) { bucket.set(at, []); order.push(at) }
    bucket.get(at)?.push(one)
  }
  return order.map(at => {
    const width = sizes.find(one => one.index === at)?.w
    return { window: at, matches: bucket.get(at) ?? [], ...(typeof width === 'number' ? { width } : {}) }
  })
}

/** 壳回来的每扇窗的宽高(老壳没有这一格,那就只有第 0 扇、宽度取 `window.w`)。 */
function sizesOf(result: Record<string, unknown>): { index: number, w?: number }[] {
  const raw = result.windows
  const fallbackWidth = typeof (result.window as { w?: unknown } | undefined)?.w === 'number'
    ? (result.window as { w: number }).w
    : undefined
  if (!Array.isArray(raw)) return [{ index: 0, ...(fallbackWidth === undefined ? {} : { w: fallbackWidth }) }]
  const out: { index: number, w?: number }[] = []
  for (const one of raw) {
    if (typeof one !== 'object' || one === null) continue
    const item = one as Record<string, unknown>
    if (typeof item.index !== 'number') continue
    out.push({ index: item.index, ...(typeof item.w === 'number' ? { w: item.w } : {}) })
  }
  return out.length === 0 ? [{ index: 0, ...(fallbackWidth === undefined ? {} : { w: fallbackWidth }) }] : out
}

/**
 * 从窗口上读额度的那几家的读数(Manus、Muse)。**只读**:壳 `read_texts` 只回命中的那一小段,不激活、不动焦点。
 * 一次读一家、一家一次最多 8 秒;同一时刻只跑一轮。读到的留着(带时刻),没读到的记下为什么。
 */
/** `store` 的落盘实现:一份小 JSON,原子写(先写临时文件再改名),读坏了当没有。 */
export function windowQuotaFileStore(file: string): NonNullable<WindowQuotaReaderDeps['store']> {
  return {
    load: () => {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: number, lasts?: unknown, opens?: unknown }
        if (raw.version !== 1 || typeof raw.lasts !== 'object' || raw.lasts === null) return undefined
        const lasts: Record<string, NonNullable<WindowQuotaReading['last']>> = {}
        for (const [id, last] of Object.entries(raw.lasts as Record<string, unknown>)) {
          const one = last as { at?: unknown, matches?: unknown, width?: unknown }
          if (typeof one?.at !== 'string' || !Array.isArray(one.matches)) continue
          lasts[id] = { at: one.at, matches: one.matches as WindowTextMatch[], ...(typeof one.width === 'number' ? { width: one.width } : {}) }
        }
        // ★ 2026-09-27(卡 AG 追加,维护者答「要」):**开集那两家(Grok Bot / Antigravity)也落盘**。
        // 卡 QG 那份交接里写着它们只在内存里,工作台一重启就回到「还没读过它窗口上的用量」,
        // 要他再去打开一趟那一页 —— 与 Muse / 豆包办公那条纪律不一致,现在统一。
        // 老文件没有这一格(`opens` 缺席)= 空的,一个字都不用迁。
        const opens: Record<string, NonNullable<OpenQuotaReading['found']>> = {}
        if (typeof raw.opens === 'object' && raw.opens !== null) {
          for (const [id, found] of Object.entries(raw.opens as Record<string, unknown>)) {
            const one = found as { at?: unknown, window?: unknown, view?: unknown, recipe?: unknown }
            if (typeof one?.at !== 'string' || typeof one.window !== 'number') continue
            if (typeof one.view !== 'object' || one.view === null || typeof one.recipe !== 'object' || one.recipe === null) continue
            opens[id] = one as NonNullable<OpenQuotaReading['found']>
          }
        }
        return { lasts, opens }
      }
      catch { return undefined }
    },
    save: (data) => {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ version: 1, ...data }), { mode: 0o600 })
      renameSync(tmp, file)
    },
  }
}

export function createWindowQuotaReader(deps: WindowQuotaReaderDeps) {
  const now = deps.now ?? (() => new Date())
  const wait = deps.wait ?? (async (ms: number) => { await new Promise<void>(resolve => { setTimeout(resolve, ms) }) })
  const readings: Record<string, WindowQuotaReading> = {}
  const restored = deps.store?.load()
  for (const [id, last] of Object.entries(restored?.lasts ?? {})) readings[id] = { last }
  let running: Promise<void> | undefined
  let lastRunAt = 0
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => {
    const timer: unknown = setTimeout(fn, ms)
    // Node 的 Timeout 有 unref(浏览器里没有);别让一条重读的定时器拖着进程不退。
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as { unref: () => void }).unref()
  })
  function persist(): void {
    if (deps.store === undefined) return
    const lasts: Record<string, NonNullable<WindowQuotaReading['last']>> = {}
    for (const [id, reading] of Object.entries(readings)) if (reading.last !== undefined) lasts[id] = reading.last
    // ★ 卡 AG 追加(2026-09-27):开集那几家认出来的那一份也一起落(数 + 方子)。
    const opens: Record<string, NonNullable<OpenQuotaReading['found']>> = {}
    for (const [id, reading] of Object.entries(openReads)) if (reading.found !== undefined) opens[id] = reading.found
    try { deps.store.save({ lasts, opens }) } catch { /* 落盘失败只是下次重启后要重读,不影响这一次 */ }
  }

  const specsOf = (): ReadonlyMap<string, WindowQuotaSpec> => deps.specs ?? windowSpecs
  /** 她删掉的那几家(见 `WindowQuotaReaderDeps.disabled`);问不出来当一家都没删,不让这一轮整个作废。 */
  const disabledNow = async (): Promise<ReadonlySet<string>> => {
    try { return (await deps.disabled?.()) ?? new Set<string>() }
    catch { return new Set<string>() }
  }
  /**
   * 这一家「额度在哪一页、怎么到那一页」(**一处查**,窗口型与开集共用,2026-10-03 卡 QT)。
   *
   * 先看这一轮用的那张 specs(用例注进来的那一份也算 —— 声明 `reach` 的地方还是这一家的读法旁边),
   * 再看那张两条路共用的表(`quotaReachFor`:开集那几家登在那儿)。
   */
  const reachOf = (id: string): QuotaPageReach | undefined => specsOf().get(id)?.reach ?? quotaReachFor(id)
  /**
   * ★ **这一家读的时候要不要连「键身上的字」也读**(2026-10-03,卡「Grok 读键字」)。
   *
   * 两条都成立才带这一格:这一家**声明**过(`reach.read_titles`)+ 这份壳会这一下(caps `read_titles`)。
   * 缺一条就压根不带 —— 老壳那一头照旧只收静态字,Grok Bot 那一格停在今天那句话上(不假装读到了)。
   *
   * **为什么不许全局打开**(维护者 21:4x 原话里就有这一句):Muse / 豆包那条「这确实是额度那一页」
   * 的旁证是按**整格静态字**认的,一颗叫「使用情况」的侧栏键会把那条旁证骗过去 ——
   * 那比读不到坏得多(卡 MQ:假阳性比读不到坏)。
   */
  const includeTitlesFor = (id: string): { include_titles?: true } =>
    reachOf(id)?.read_titles === true && deps.helper().readTitles === true ? { include_titles: true } : {}
  const say = (line: string): void => {
    try { deps.log?.(`${QUOTA_READ_LOG_TAG} ${line}`) }
    catch { /* 记不下不连累这一次读 */ }
  }

  // ───── 卡 QZ(2026-10-03):这一轮该不该碰这一家、碰之前要不要先把它起来 ─────

  /**
   * 这一轮这几个 App 在不在跑 / 哪一个在前台(壳的 `running_apps`,**不碰辅助功能**)。
   * 一轮只问一次(十几个 App 的 `NSWorkspace` 清单,一次几毫秒);问不出来回 `undefined`
   * —— 老壳不会这个 op,那时整条链退回「照旧只读一次」。
   */
  async function runningAppsNow(): Promise<Map<string, { running: boolean, active: boolean, hidden: boolean }> | undefined> {
    /*
     * **壳没连 / 没授权 / 老壳:一个字都不问**(这条老规矩在 `readOne` 的三道门上,这里照着再挡一遍)。
     * 那几种情形下面那一趟读压根不会发生,先问一句「谁在跑」只是白占一次来回。
     */
    const helper = deps.helper()
    if (!helper.connected || !helper.authorized || !helper.readTexts) return undefined
    try {
      const raw = await deps.request({ op: 'running_apps' }, 4_000)
      if (raw.ok === false) return undefined
      const result = (raw.result ?? raw) as Record<string, unknown>
      if (!Array.isArray(result.apps)) return undefined
      const out = new Map<string, { running: boolean, active: boolean, hidden: boolean }>()
      for (const one of result.apps) {
        if (typeof one !== 'object' || one === null) continue
        const row = one as Record<string, unknown>
        if (typeof row.bundle_id !== 'string' || row.bundle_id === '') continue
        out.set(row.bundle_id, { running: true, active: row.active === true, hidden: row.hidden === true })
      }
      return out
    }
    catch { return undefined }
  }

  /** 这一家此刻什么样(在 `running_apps` 里就是在跑;整张表问不出来回 `undefined`)。 */
  function appStateOf(
    apps: Map<string, { running: boolean, active: boolean, hidden: boolean }> | undefined,
    bundleId: string,
  ): { running: boolean, active: boolean, hidden: boolean } | undefined {
    if (apps === undefined) return undefined
    return apps.get(bundleId) ?? { running: false, active: false, hidden: false }
  }

  /**
   * **后台起它、起完藏到后台**(卡 QZ)。`open -g -b`(不激活)起来之后再 `hide_app` 一下
   * —— `-g` 只保证不抢焦点,它自己那扇窗还是会露在屏上;藏起来之后 `read_texts` 的
   * unhide → 读 → 藏回去那一套接着跑,她眼前从头到尾什么都没有。
   *
   * 回 false = 起不来(命令没跑成 / 没这条路):这一句只进日志。
   */
  /**
   * 上一次后台起这一家是什么时候(按 id;只在内存里)。2026-10-19 起只有她点「读一下」才会起,
   * 所以「重启清零」只影响她连点两下之间的那条 90 分钟线,不再让自动那一轮多起一次。
   */
  const launchedAt = new Map<string, number>()
  /**
   * ★ 上一次**闪一下台前**是什么时候(按 id,2026-10-03 卡「豆包闪一下」)。
   *
   * 同 `launchedAt` 只在内存里:重启一次允许再闪一次 —— 重启那会儿那一格多半真的旧了,
   * 而「90 分钟最多一次」防的是「每 10 分钟闪一次」,不是「这台机器一辈子只闪一次」。
   */
  const frontedAt = new Map<string, number>()
  /**
   * 放过一次窗还是没读到数的那几家(2026-10-08 真机:Muse「使用情况」那扇设置窗没开着,
   * 每 10 分钟放出来一扇对话框、读不到、藏回去 —— 她看见的就是「时不时闪一下」,而且永远白闪)。
   * 在这里的,自动那一轮不再为它放窗;她亲手点「读一下」照放,读到了就从这里拿掉。
   */
  const futileUnhide = new Set<string>()

  /**
   * **这一下值不值得去拉起她的 App**(卡 QZ 的两道门;两条都过才拉)。
   *
   * ① **这一格的数还没过线就不拉** —— 界面上写的还是一个当得起「此刻」的数,没有什么要修的,
   *    那就别去动她的 App(`QUOTA_AS_OF_STALE_AFTER_MS` 是同一条线:过了线界面才不出百分比)。
   * ② **同一家 90 分钟内只拉一次**(`QUOTA_LAUNCH_GAP_MS`)—— 挡住「她退掉的 App 每 10 分钟被拉起一次」
   *    (10-02 那位运营同学撞上的就是这个毛病的快放版)。
   *
   * `lastAt` 缺席 = 这一家从没读到过数:那就是**最该去拉一次**的时候(第 ① 道门放行)。
   *
   * ★ 2026-10-19 起**只在她亲手点「读一下」时才问这两道门**;自动那一轮压根走不到这儿
   * (`readOne` 的 `press` / `readOpenWindow` 的 `byHand` 那道门在前,没在跑的家一律不起)。
   */
  function worthLaunching(id: string, lastAt: string | undefined): boolean {
    const t = now().getTime()
    const since = launchedAt.get(id)
    if (since !== undefined && t - since < QUOTA_LAUNCH_GAP_MS) {
      say(`${id} 没在跑,但刚起过一次(${QUOTA_LAUNCH_GAP_MS / 60_000} 分钟内只起一次),这一轮不起`)
      return false
    }
    if (lastAt !== undefined) {
      const age = t - new Date(lastAt).getTime()
      if (Number.isFinite(age) && age >= 0 && age <= QUOTA_AS_OF_STALE_AFTER_MS) {
        say(`${id} 没在跑,但这一格的数还不旧,这一轮不起它`)
        return false
      }
    }
    return true
  }

  async function launchHidden(id: string, bundleId: string): Promise<boolean> {
    if (deps.runCommand === undefined) return false
    launchedAt.set(id, now().getTime())
    const opened = await deps.runCommand(backgroundOpenCommand(bundleId)).catch(() => ({ ok: false }))
    if (!opened.ok) { say(`${id} 没在跑,后台起它也起不来(${bundleId})`); return false }
    // 等一拍让它把窗建出来,再藏回后台。藏不成不算失败 —— 读那一下照样能读(壳自己会 unhide)。
    await wait(QUOTA_LAUNCH_SETTLE_MS)
    try { await deps.request({ op: 'hide_app', bundle_id: bundleId }, 4_000) }
    catch { /* 藏不成只是她可能看见一扇窗,不该让这一次读整个作废 */ }
    say(`${id} 没在跑,已在后台起它并藏回去(${bundleId})`)
    return true
  }

  /**
   * **按那几颗键过去**(卡 QP)。`op` 两种,差别只有一件:
   *
   * - `quota_page` —— 新壳那条**不抢焦点**的(只 `unhide`、只 `AXPress`):自动那一轮走这条;
   * - `agent_press` —— 老那条(点之前把那家叫到台前):只有她亲手点「读一下」时才走。
   *
   * 回「按动过没有」+「是不是因为这份壳不会这个 op」(后者让调用方退回老那条路)。
   * 按完等一拍(`QUOTA_REACH_SETTLE_MS`,900ms —— 同卡 QD 那条「等一拍再看一眼」的节奏:
   * Chromium 那几家换一页要渲一拍才在辅助功能树上)。
   *
   * ★ **2026-10-03(卡 QT):`quota_page` 那条路一串键只发一条 op。**
   *
   * 卡 QP 那一版一颗键一条 op。真机上量到这对**弹出式菜单走不通**:这条 op 每次返回前都把那家
   * 照原样藏回去,弹出来的那张菜单跟着收了 —— 第二条 op 再放出来时,下一颗键压根不在树上。
   * 所以新壳收 `labels`(一次放出来里挨个按完再一次藏回去);
   * 老那条 `agent_press` 仍旧一颗一条(它本来就把那家叫到了台前,菜单不会收)。
   */
  async function pressThrough(
    id: string, bundleId: string, op: 'quota_page' | 'agent_press', labels: readonly string[],
    opts: { front?: boolean, click?: boolean } = {},
  ): Promise<{ pressed: boolean, unknownOp: boolean }> {
    // `quota_page` 一次把一串都给它(见上面那段);`agent_press` 照旧一颗一条。
    const chunks: readonly (readonly string[])[] = op === 'quota_page' ? [labels] : labels.map(one => [one])
    let pressed = false
    for (const chunk of chunks) {
      const said = chunk.join(' → ')
      try {
        const raw = await deps.request(
          op === 'quota_page'
            ? {
                op, bundle_id: bundleId, label: chunk[0] as string, labels: chunk,
                /*
                 * ★ `front`(卡「豆包闪一下」)**只在调用方明着要的那一下才带**:
                 * 壳那一侧缺这一格就不碰台前,所以常态下这条 op 的样子一个字没变。
                 */
                ...(opts.front === true ? { front: true } : {}),
                /*
                 * ★ `click`(卡「豆包台前点一下」)同一条纪律:**只在调用方明着要的那一下才带**。
                 * 壳那一侧缺这一格就一下都不点(后台那一支压根走不到那里)。
                 */
                ...(opts.click === true ? { click: true } : {}),
              }
            : { op, bundle_id: bundleId, label: chunk[0] as string },
          8_000,
        )
        const result = (raw.result ?? raw) as Record<string, unknown>
        /*
         * 老壳(或者壳的 caps 报错了):「未知 op」→ 回给调用方,让它退回老那条路,
         * **不**记成「按不到这颗键」(那是两件事,混了日志就骗人)。
         */
        if (raw.ok === false && readErrorOf(typeof raw.error === 'string' ? raw.error : '') === 'old_shell') {
          return { pressed, unknownOp: true }
        }
        if (raw.ok === false || result.found !== true || result.pressed === false) {
          // 「没走到」(树太大 / 它这会儿很慢)与「它没这颗键」壳分得开,日志照它那句原话记。
          // 一串键的时候壳还回「卡在哪一颗」(`stuck` / `pressed_count`),那句话照它的记。
          const why = typeof result.note === 'string' ? result.note : (typeof raw.error === 'string' ? raw.error : '')
          const stuck = typeof result.stuck === 'string' ? `「${result.stuck}」那一颗` : ''
          say(`${id} 按不到「${said}」这一步${stuck === '' ? '' : `(卡在${stuck})`}${why === '' ? '' : `:${why}`}`)
          return { pressed, unknownOp: false }
        }
        pressed = true
      }
      catch { say(`${id} 按「${said}」没按成`); return { pressed, unknownOp: false } }
    }
    if (pressed) await wait(QUOTA_REACH_SETTLE_MS)
    return { pressed, unknownOp: false }
  }

  /**
   * **照原样藏回去**(2026-10-03,卡 QT)。只在「这一轮开始时它是藏着的、而我们这一轮把它放出来了」
   * 时叫 —— 今天只有开深链那一下会这样(见 `readOne`)。藏不回去不改这一次读的结论。
   */
  async function hideBack(id: string, bundleId: string): Promise<void> {
    try { await deps.request({ op: 'hide_app', bundle_id: bundleId }, 4_000) }
    catch { say(`${id} 开完深链没藏回去(她眼前可能留着一扇窗)`) }
  }

  /**
   * **替她走到额度那一页**(卡 QZ;2026-10-03 卡 QP 补上「自动那一轮也能按键」)。
   *
   * 顺序:深链优先 → 新壳那条不抢焦点的 `quota_page` → 她亲手点时才走老那条 `agent_press`。
   *
   * 回「走动过没有」+「走的是哪条路」(`quota_page` 那条才按原路按回去:老那条本来就把那家
   * 叫到了台前,那时她正看着,再按回去没意义)。到不了那一页只进日志(格子摆上次那个数)。
   */
  async function reachPage(
    id: string, bundleId: string, mayPress: boolean, opts: { reallyBroken?: boolean } = {},
  ): Promise<{ walked: boolean, by?: 'link' | 'quota_page' | 'agent_press', fronted?: boolean }> {
    // ★ 卡 QT:**一处查** —— 窗口型与开集那两条路查的是同一张表(`quotaReachFor`)。
    const reach = reachOf(id)
    if (reach === undefined) return { walked: false }
    if (reach.link !== undefined && deps.runCommand !== undefined) {
      // ★ 2026-10-03 22:4x 热修(0.4.93):深链**只在她亲手点「读一下」时开**。`open -g <深链>` 对 URL 不生效,
      // 照样把那家顶到台前 —— 0.4.92 装上后 Muse 每轮自动读、她一切走就又被顶上来(5 分钟 22 次,她关都关不掉)。
      if (!mayPress) {
        say(`${id} 自动那一轮不开深链(会把它顶到台前);她点「读一下」时才开`)
        return { walked: false }
      }
      const opened = await deps.runCommand(backgroundLinkCommand(reach.link)).catch(() => ({ ok: false }))
      // 深链开的是**另一扇窗**,那扇窗要先建出来、里面那层网页树还要建一遍 —— 比换一页等得久(卡 QT 真机)。
      if (opened.ok) { await wait(QUOTA_LINK_SETTLE_MS); return { walked: true, by: 'link' } }
      say(`${id} 的深链开不了(${reach.page})`)
      return { walked: false }
    }
    if (reach.press === undefined || reach.press.length === 0) {
      say(`${id} 这会儿不在「${reach.page}」页上,这一轮到不了那一页`)
      return { walked: false }
    }
    /*
     * ★ **这几颗键非台前不可的那一家(`front_ok`,2026-10-03 卡「豆包闪一下」)。**
     *
     * 豆包那颗键弹的是系统画的原生弹出菜单 —— 后台 `AXPress` 回 success 而树一个字没变
     * (卡 QT 真机)。所以这一家只有两种走法:**闪一下台前按完**,或者**一颗都不按**;
     * 背着台前按下去只是每 10 分钟白按一下她的 App(D13:不走一个办不到的步骤)。
     *
     * 维护者 21:4x 拍板的三道门,一条都不许少:
     * ① 壳会这一下(caps `quota_front` + `quota_page`)—— 老壳压根不发;
     * ② **这一格真坏了**(`reallyBroken`:同 `worthUnhiding` 那条 2 小时线 / 从没读到过 /
     *    她亲手点的)—— 没坏的不去闪她的屏(同「没坏的不去修」那条老规矩);
     * ③ 同一家 **90 分钟最多闪一次**(`QUOTA_FRONT_GAP_MS`)。
     * 外加 0.4.92 Muse 事故之后那一条:**顶到台前的动作自动那一轮一律不走**,只在她亲手点「读一下」时闪。
     */
    if (reach.front_ok === true) {
      if (!mayPress) {
        say(`${id} 这会儿不在「${reach.page}」页上;那几颗键非台前不可,自动那一轮不闪她的屏;她点「读一下」时才闪`)
        return { walked: false }
      }
      const helper = deps.helper()
      if (helper.quotaFront !== true || helper.quotaPage !== true) {
        say(`${id} 这会儿不在「${reach.page}」页上;那几颗键非台前不可,而这份壳还不会「闪一下」那一下,这一轮不翻`)
        return { walked: false }
      }
      /*
       * ★ 2026-10-04(卡「豆包台前点一下」):这一家要的是**台前那一下合成点击**(`front_click`)。
       * 这份壳不会那一下(caps `quota_click`)就**一下都不闪** —— 闪过去也只是白按一颗
       * (`AXPress` 那颗「标准套餐」回 success 而那一页压根不开,卡「豆包闪一下」真机查实),
       * 换回来的是一个 `stuck` 加一次她看得见的闪屏(D13:不走一个办不到的步骤)。
       */
      if (reach.front_click === true && helper.quotaClick !== true) {
        say(`${id} 这会儿不在「${reach.page}」页上;那一页要台前点一下才开,而这份壳还不会那一下,这一轮不闪`)
        return { walked: false }
      }
      if (opts.reallyBroken !== true) {
        say(`${id} 这会儿不在「${reach.page}」页上,但这一格的数还不旧 —— 不为它闪她的屏`)
        return { walked: false }
      }
      const t = now().getTime()
      const since = frontedAt.get(id)
      if (since !== undefined && t - since < QUOTA_FRONT_GAP_MS) {
        say(`${id} 刚闪过一次(${QUOTA_FRONT_GAP_MS / 60_000} 分钟最多一次),这一轮不闪`)
        return { walked: false }
      }
      frontedAt.set(id, t)
      // 日志里那一行就是维护者会看的那一句(她眼前确实闪了一下,得有一处说明白为什么)。
      say(`${id} 这一格真坏了:闪了一下${titleOf(id)}换一个真数(叫到台前${reach.front_click === true ? '点一下' : '按'}「${reach.press.join(' → ')}」,按完立刻把台前与隐藏状态都还原)`)
      const flashed = await pressThrough(id, bundleId, 'quota_page', reach.press,
        { front: true, ...(reach.front_click === true ? { click: true } : {}) })
      if (flashed.pressed) return { walked: true, by: 'quota_page', fronted: true }
      if (flashed.unknownOp) say(`${id} 这份壳报了会「闪一下」其实不会,这一轮没按成`)
      return { walked: false }
    }
    /*
     * ★ 新壳:**自动那一轮也翻页** —— `quota_page` 只 `unhide`、只 `AXPress`,一次鼠标点击都不合成,
     * 所以不用把那家叫到台前(卡 QZ 唯一没闭合的那半边就是这个)。
     */
    if (deps.helper().quotaPage === true) {
      const walked = await pressThrough(id, bundleId, 'quota_page', reach.press)
      if (walked.pressed) return { walked: true, by: 'quota_page' }
      if (!walked.unknownOp) return { walked: false }
      say(`${id} 这份壳还不会 quota_page(报了会、其实不会),退回老那条路`)
    }
    /*
     * 老壳:`agent_press` 点之前要把那家叫到台前(抢焦点),所以**只有她亲手点「读一下」时才走** ——
     * 自动那一轮一颗键都不按(行为与 0.4.90 一字不差)。
     */
    if (!mayPress) {
      say(`${id} 这会儿不在「${reach.page}」页上;这份壳翻页要把它叫到台前,自动这一轮不翻`)
      return { walked: false }
    }
    const byHand = await pressThrough(id, bundleId, 'agent_press', reach.press)
    return byHand.pressed ? { walked: true, by: 'agent_press' } : { walked: false }
  }

  /**
   * **读完按原路按回去**(卡 QP)。只在走过 `quota_page` 那条路之后走:同一条不抢焦点的路按回去,
   * 她眼前照旧什么都没多。没声明 `back` / 认不到那颗键 → 就只把窗藏回去(壳自己藏),
   * 那家留在额度页上 —— 如实记一行,不假装回去了。
   */
  async function walkBack(id: string, bundleId: string, opts: { fronted?: boolean } = {}): Promise<void> {
    const back = reachOf(id)?.back
    if (back === undefined || back.length === 0) return
    /*
     * ★ **闪过台前那一条不按回去**(2026-10-03,卡「豆包闪一下」)。
     *
     * 按回去那几颗键与按过去那几颗同样非台前不可 —— 也就是同一轮里**再闪她一下**,
     * 而维护者拍的是「闪一下」。那家留在额度那一页上这件事本身还是好的:
     * 下一轮按原样读(127ms、一扇窗都不动)就读到了。如实记一行,不假装按回去了。
     */
    if (opts.fronted === true) {
      say(`${id} 不按回原来那一页(按回去同样非台前不可 = 再闪她一下);它留在「${reachOf(id)?.page ?? ''}」上,下一轮按原样就读得到`)
      return
    }
    const done = await pressThrough(id, bundleId, 'quota_page', back)
    if (!done.pressed) say(`${id} 按不回原来那一页(它留在「${reachOf(id)?.page ?? ''}」上了)`)
  }

  /** 记下这一次尝试(读到了就换掉上一次的读数,没读到留着上一次的)。回:这一格对外说的话变没变。 */
  function note(id: string, attempt: NonNullable<WindowQuotaReading['attempt']>, last?: WindowQuotaReading['last']): boolean {
    const before = JSON.stringify({ last: readings[id]?.last, found: readings[id]?.attempt?.found, error: readings[id]?.attempt?.error })
    const keep = last ?? readings[id]?.last
    readings[id] = { ...(keep === undefined ? {} : { last: keep }), attempt }
    if (last !== undefined) persist()
    return JSON.stringify({ last: readings[id]?.last, found: attempt.found, error: attempt.error }) !== before
  }

  /**
   * 读一家。
   *
   * ★ **2026-10-03(卡 QZ):这一下不再只是「读」,是「自己走到能读的地方再读」。**
   *
   * `step`(`quotaReadStepFor`,一处判):
   * - 她正用着那家(它在前台)→ **这一轮一个指头都不碰**,连 `readings` 都不写(原因只进日志);
   * - 它没在跑 → 自动那一轮**不起它**、记 `not_running`(格子照旧摆上次那个数,2026-10-19);
   *   她亲手点「读一下」才后台起它、藏回去,再读;起不来同样记 `not_running`;
   * - 在跑(藏着也算)→ 直接读。
   *
   * 读完**没读到那几个数**时再替她走一趟额度那一页(`reachPage`:深链优先 → 新壳那条不抢焦点的
   * `quota_page` → 老壳只在她亲手点「读一下」时按),走动过就再读一遍;
   * 走的是 `quota_page` 那条就**按原路按回去**(`walkBack`,卡 QP)。
   */
  async function readOne(
    id: string,
    spec: WindowQuotaSpec,
    opts: { press?: boolean, apps?: Map<string, { running: boolean, active: boolean, hidden: boolean }> } = {},
  ): Promise<boolean> {
    const at = now().toISOString()
    // 卡 BB:读它的窗口之前先跟登记表那一路说一声(每一条读额度的路都要说,不只事件触发那一条)。
    try { deps.onWindowTouched?.([spec.bundleId]) } catch { /* 说一声失败不连累这一次读 */ }
    const helper = deps.helper()
    if (!helper.connected) return note(id, { at, found: false, error: 'no_helper' })
    if (!helper.authorized) return note(id, { at, found: false, error: 'no_ax' })
    if (!helper.readTexts) return note(id, { at, found: false, error: 'old_shell' })
    const app = appStateOf(opts.apps, spec.bundleId)
    const step = quotaReadStepFor(app)
    /*
     * ★ 她正用着那家:**这一轮什么都不做,也什么都不记**(卡 QZ 第 4 条)。
     * 不记成一次「没读成」是关键 —— 记了,界面就会说「读过它的窗口,但不在那一页」,
     * 而我们压根没读(D13:不说一句没发生的事)。
     */
    if (step === 'in_use') { say(`${id} 这会儿在前台(她在用),这一轮不碰`); return false }
    /*
     * ★ **放窗只当第二眼**(2026-10-03,卡 QT):藏着的那一家**先按原样读一遍**,
     * 读到了就一次都不放窗;读不到、而且这一格的数真过了线(`worthUnhiding`),才放出来再读一遍。
     *
     * 卡 QZ / 卡 MQ3 的前提是「藏起来的 App 窗一扇都不在任何桌面上,辅助功能什么都读不到」——
     * 10-03 在这台机器上逐家量过,**那句话不成立**(`probe read-texts <包> --no-unhide`):
     *
     *   豆包办公  102 块字 / 517 个节点 / 127ms     Muse  85 块字 / 2 扇窗 / 440ms
     *   Grok Bot   89 块字 / 1 扇窗  /  64ms
     *
     * 三家都是藏着的,三家都读得到 —— 也就是说那一下放窗**本来就不必**。
     * 于是 09-27 那句「依次闪过 manus、muse、豆包、Grok bot 四个应用」在这一版里彻底没有了:
     * 常态下一轮读四家,她眼前**一扇窗都不动**。
     *
     * 放窗这一支留着不删,因为它换回来的是**另外几扇窗**(同一台机器上量到的):Muse 藏着时
     * `AXWindows` 只有 2 扇、放出来是 3 扇,而「使用情况」那一页就在多出来的那一扇(设置窗)上。
     * 所以口径是「按原样读不到 → 才值得放一次窗」,而不是「一律放」或「一律不放」。
     */
    const hiddenNow = app?.hidden === true
    /**
     * ★ **这一格「真坏了」没有**(2026-10-03,卡「豆包闪一下」)。
     *
     * 与放窗那道门同一条线、同一个函数(`worthUnhiding`:过了那 2 小时 / 从没读到过 / 她亲手点的)
     * —— 维护者 21:4x 的原话就是「过 2 小时线」。这里单独算一遍,是因为**放窗那一格对没藏起来的
     * 那一家恒为真**(`!hiddenNow ||`),而「要不要闪她的屏」与「它这会儿藏没藏着」是两件事。
     */
    const reallyBroken = worthUnhiding({
      ...(readings[id]?.last?.at === undefined ? {} : { lastAt: readings[id]?.last?.at }),
      byHand: opts.press === true,
      now: now(),
    })
    const mayUnhide = !hiddenNow || (reallyBroken && (opts.press === true || !futileUnhide.has(id)))
    if (hiddenNow && reallyBroken && !mayUnhide) say(`${id} 上回放窗也没读到,自动那一轮不再为它放窗;她点「读一下」时再放`)
    let launched = false
    if (step === 'launch') {
      /*
       * ★ **自动那一轮对没在跑的家一律不起**(2026-10-19)。维护者当天关掉一批 App,千问办公 / Muse / Grok Bot / Manus
       * 又被这一路 `open -g -b` 开了回来(90 分钟那条线只在内存里,插件一重启就再来一轮)。
       * 没在跑的那一格如实记 `not_running`(上一次的数照摆、带时刻),**只有她亲手点「读一下」才起它**(那是她的指令)。
       */
      if (opts.press !== true) {
        say(`${id} 没在跑,自动那一轮不起它(她关掉的 App 不由工作台开回来);她点「读一下」时才起`)
        return note(id, { at, found: false, error: 'not_running' })
      }
      // 「读一下」那一下的两道门(`worthLaunching`):数还不旧就不去动她的 App;同一家 90 分钟内只起一次。
      if (!worthLaunching(id, readings[id]?.last?.at)) return note(id, { at, found: false, error: 'not_running' })
      launched = await launchHidden(id, spec.bundleId)
      if (!launched) return note(id, { at, found: false, error: 'not_running' })
    }
    try {
      // **不给 index**:新壳据此把这个 App 的每一扇窗都读一遍(老壳不认这一条,照旧只读第 0 扇)。
      // 一个人开着好几扇窗是常态,没有哪一扇天生是第 0 扇 —— 写死第 0 扇就是掷骰子(2026-09-26,卡 MQ)。
      /*
       * `unhide` —— 要不要为这一眼把藏着的那家放出来。
       *
       * 卡 QZ 这里写死 `true`(「藏着的家一律放出来读」,否掉 09-27 那条「自动那几路一律不放」);
       * ★ 卡 QT(2026-10-03)改成**两眼**:第一眼一律 `false`(按原样读,她眼前什么都不动),
       * 读不到才用 `mayUnhide` 那一眼。理由与真机数见上面 `mayUnhide` 那一段。
       * 「闪过」那件事剩下的一半仍由壳消化:`TextInsert.readTexts` 放出来**不 activate**、读完原样藏回去。
       */
      const ask = async (unhide: boolean): Promise<Record<string, unknown>> =>
        await deps.request({
          op: 'read_texts', bundle_id: spec.bundleId, patterns: spec.patterns, unhide,
          // ★ 卡「Grok 读键字」:**只有声明过的那一家**才多带这一格(见 `includeTitlesFor`)。
          ...includeTitlesFor(id),
        }, 8_000)
      /** 壳那一趟 + 记一笔。回「这一次读到没读到」与「这一格对外说的话变没变」。 */
      const once = async (unhide = false): Promise<{ found: boolean, changed: boolean }> => {
        const tried = now().toISOString()
        let raw = await ask(unhide)
        /*
         * ★ **等一拍再看一眼**(2026-09-26,卡 QD;同 `AgentWindow.probe` 那条「第二眼」的教训,
         * 只是那一条当时没落到读额度这一路上)。
         *
         * 真机实测(豆包办公,Chromium 那一类):第一下回「辅助功能通道关着…-25204」(3017ms),
         * 紧接着第二下 704ms 就把那一页八小段全读到了 —— 壳敲门(`AXManualAccessibility`)之后,
         * Chromium 要花一会儿把整棵网页树建出来,**敲了门不等于树当场就好**。
         * 不重这一下,豆包办公 / Grok Bot / Antigravity 这几家凉着的时候永远读不到,
         * 而他点「读一下」看到的是一句「这次没读成」。只重**这一种**,只重一次:
         * 别的没读成(没开着、没有窗口、老壳)重了也是白重,还多占他电脑 8 秒。
         */
        if (raw.ok === false && readErrorOf(typeof raw.error === 'string' ? raw.error : '') === 'app_asleep') {
          await wait(900)
          raw = await ask(unhide)
        }
        // 「这家这会儿藏起来了」壳在两支里都回(读成了的那支在 `result` 里,没读成那支在顶层)——
        // 藏着的 App 多半连窗都读不到(`no_window`),而那时候最该说的就是这一句(卡 MQ2)。
        //
        // ★ 卡 MQ3(2026-09-26)口径变了:新壳**读之前先把藏着的放出来、读完藏回去**,所以这一格
        // 问的是「放出来之后还藏着吗」——几乎永远是 false。老壳没有这套机制,照旧回 true,那时候
        // 「点一下它的图标把它放出来」仍旧是他该做的下一步,所以这条线一个字不改。
        const hiddenOf = (from: Record<string, unknown>): { hidden?: boolean } => from.app_hidden === true ? { hidden: true } : {}
        if (raw.ok === false) {
          const message = typeof raw.error === 'string' ? raw.error : ''
          return {
            found: false,
            changed: note(id, { at: tried, found: false, error: readErrorOf(message), ...hiddenOf(raw), ...(message === '' ? {} : { note: message.slice(0, 60) }) }),
          }
        }
        const result = (raw.result ?? raw) as Record<string, unknown>
        const offspace = {
          ...hiddenOf(result),
          ...(typeof result.offspace_windows === 'number' && result.offspace_windows > 0
            ? { offspace: result.offspace_windows }
            : {}),
        }
        const sizes = sizesOf(result)
        // 一扇一扇地问 parse:**第一扇认得出的那扇算数**(窗口顺序就是壳给的顺序,
        // 所以老壳一直读的那扇仍然先问 —— Manus 这一家的行为一个字没变)。
        for (const group of byWindow(matchesOf(result.matches), sizes)) {
          const last = { at: tried, matches: group.matches, ...(group.width === undefined ? {} : { width: group.width }) }
          if (spec.parse(last) !== undefined) return { found: true, changed: note(id, { at: tried, found: true, ...offspace }, last) }
        }
        // 一扇都认不出:Manus 不在首页、Muse 不在「使用情况」页(或者那扇窗在别的桌面上,`offspace`)。
        return { found: false, changed: note(id, { at: tried, found: false, ...offspace }) }
      }
      /*
       * ★ 第二眼要不要放窗(卡 QT)。
       *
       * - 它藏着 + 这一格的数真过了线(或者她亲手点的)→ 放。Muse 藏着时少一扇窗
       *   (「使用情况」就在那一扇设置窗上,真机量到:藏着 2 扇 / 放出来 3 扇),这一眼换回来的正是它;
       * - **这一轮是我们把它起来、又自己藏起来的** → 也放。那一下的「藏」是工作台自己按的,
       *   不是她的意思;而「值不值得动这个 App」在前面那道 `worthLaunching` 上已经判过了,更严。
       * - 它本来就没藏起来 → 不必(第一眼就是原样)。
       */
      const secondLook = (): boolean => (hiddenNow && mayUnhide) || launched
      // ★ 第一眼:**按原样读**(不放窗 —— 她眼前一动不动)。读到了,这一轮到此为止。
      const first = await once()
      if (first.found) return first.changed
      let changed = first.changed
      if (secondLook()) {
        const unhidden = await once(true)
        if (unhidden.changed) changed = true
        if (unhidden.found) { futileUnhide.delete(id); return changed }
        if (hiddenNow) futileUnhide.add(id)
      }
      else if (hiddenNow) say(`${id} 藏在后台、这一格的数又还不旧,这一轮不为它放窗(按原样那一眼没读到)`)
      /*
       * ★ **还是没读到那几个数 → 替她走一趟额度那一页,再读一遍**(2026-10-03,卡 QZ)。
       * 走不动(没声明 / 深链开不了 / 老壳 + 自动那一轮)就照旧:格子摆上次那个数,原因只进日志。
       */
      const walked = await reachPage(id, spec.bundleId, opts.press === true, { reallyBroken })
      if (!walked.walked) return changed
      /*
       * 走过之后那一眼:**深链那一条要放窗**(卡 QT 真机:`open -g endo-window://settings` 会把藏着的
       * 那家放出来,那一刻它已经不是藏着的了;而那扇刚开的设置窗要读得到,这一眼得照新状态读)。
       *
       * ★ **闪过台前那一条按原样读**(2026-10-03,卡「豆包闪一下」):那一下壳已经把台前还给她、
       * 把那家原样藏回去了,而这一家按原样就读得到(真机:豆包 102 块字 / 127ms,一扇窗都不动)。
       * 再放一次窗等于同一轮里闪她第二下 —— 换不回任何东西。
       */
      const again = await once(walked.fronted === true ? false : (walked.by === 'link' ? true : secondLook()))
      if (again.changed) changed = true
      /*
       * 按动了、那一页却还是没读到那几个数(它按了没反应 / 翻过去的不是那一页):
       * **如实记一行,不重试第三次**(重了也是白重,还多占她电脑八秒)。格子照旧摆上次那个数。
       */
      if (!again.found) say(`${id} 走到「${reachOf(id)?.page ?? ''}」之后还是没读到那几个数(按了没反应?),这一轮就到这儿`)
      /*
       * ★ **读完按原路按回去**(卡 QP)。只在走过 `quota_page` 那条不抢焦点的路之后 ——
       * 老那条(`agent_press`)本来就把那家叫到了台前,她正看着,再按回去没意义;
       * 深链那条也不按(它没按过键,没有「原路」)。
       */
      if (walked.by === 'quota_page') await walkBack(id, spec.bundleId, { ...(walked.fronted === true ? { fronted: true } : {}) })
      /*
       * ★ **开过深链的,读完自己把它藏回去**(2026-10-03,卡 QT 真机量到的一件事)。
       *
       * `open -g <深链>` 会把**藏着的**那家放出来(Muse:`hidden_before: true → hidden_after: false`)。
       * 壳那一头的「读完原样藏回去」看的是**它自己这一下放没放过**(`readTexts` 的 `wasHidden`)——
       * 深链放出来的那一下不算,所以紧接着那一眼读完它**不会**藏它,她眼前就留着一扇窗。
       * 这一句是补那一下:这一轮开始时它是藏着的,就照原样藏回去。
       */
      if (walked.by === 'link' && hiddenNow) await hideBack(id, spec.bundleId)
      return changed
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return note(id, { at, found: false, error: readErrorOf(message), note: message.slice(0, 60) })
    }
    finally {
      /*
       * ★ **我们起的那一家,读完藏回去**(卡 QZ:「读完窗口状态与读前一致」)。
       * 本来在跑的一个指头都不碰(藏着的那一家由壳自己放出来、读完原样藏回去);
       * 只有「这一轮是我们把它起来的」才藏 —— 她眼前从头到尾什么都没多出来。
       * `finally` 不是讲究:上面有好几条 return,漏一条就把她的 App 永远留在外面了。
       */
      if (launched) {
        try { await deps.request({ op: 'hide_app', bundle_id: spec.bundleId }, 4_000) }
        catch { /* 藏不回去只是她可能看见一扇窗,不改这一次读的结论 */ }
      }
    }
  }

  /**
   * 读一轮(只读 `ids` 里的几家;缺席 = 全读)。同一时刻只跑一轮,重复叫的等同一轮。
   *
   * `press`(2026-10-03,卡 QZ)= 这一轮**可以把那家叫到台前去按键** —— 只有她亲手点「读一下」时给。
   * 原来这里是 `unhide`(「只有他点『读一下』才放出藏着的家」),卡 QZ 把放出来改成一律放,
   * 这一格于是换成了「按不按键」:老壳按一颗键要把那家叫到台前,那才是真会打扰她的一下。
   *
   * ★ 卡 QP(2026-10-03)之后这一格**不再是「能不能翻页」的总开关**:新壳有了一条不抢焦点的
   * `quota_page`,自动那一轮也翻页(见 `reachPage`);这一格只管「要不要走老那条会抢焦点的路」。
   */
  async function refresh(ids?: readonly string[], opts: { press?: boolean } = {}): Promise<void> {
    if (running !== undefined) return await running
    lastRunAt = now().getTime()
    running = (async () => {
      let changed = false
      const touched: string[] = []
      // 卡 QZ:一轮只问一次「谁在跑 / 谁在前台」(壳的 `running_apps`,不碰辅助功能)。
      const apps = await runningAppsNow()
      const off = await disabledNow()
      for (const [id, spec] of specsOf()) {
        if (ids !== undefined && !ids.includes(id)) continue
        // 她删掉的那一家:不碰、不起、不记(格子照旧摆上次那个数;原因只进日志,同「她正用着」那一条)。
        if (off.has(id)) { say(`${id} 已从窗口槽清单里删掉(apps.json disabled),这一轮不起它也不读它`); continue }
        touched.push(spec.bundleId)
        if (await readOne(id, spec, { ...(opts.press === true ? { press: true } : {}), ...(apps === undefined ? {} : { apps }) })) changed = true
      }
      // 卡 BB:读完再说一声 —— 读完把藏着的家藏回去那一下,窗口上的字还会再换一次。
      if (touched.length > 0) { try { deps.onWindowTouched?.(touched) } catch { /* 说一声失败不连累这一轮 */ } }
      if (changed) deps.onChanged?.()
    })().finally(() => { running = undefined })
    return await running
  }

  /**
   * 节流过的「顺手读一轮」(挂在一秒一拍的 /state 上;同 agentCaps.pump 那条老规矩):离上一轮不到 `maxAgeMs` 就什么都不做。
   * 读是后台的,不等它。缺省 10 分钟一轮:Manus 是 Electron,读它的辅助功能树要它把网页那一层的树建出来,
   * 读得太勤是在他电脑上白花力气;派活确认前(`/dispatch/choices`)另按 1 分钟泵一次。
   */
  function pump(maxAgeMs = 10 * 60_000): void {
    if (running !== undefined) return
    if (now().getTime() - lastRunAt < maxAgeMs) return
    void refresh().catch(() => {})
  }

  // ───────── 开集那条路(2026-09-26,卡 QO:没有专门读法的那几家)─────────

  const openReads: Record<string, OpenQuotaReading> = {}
  // 重启前认出来过的那几家(卡 AG 追加):数与方子都在,重启后那一格照旧有数、按方子重读。
  for (const [id, found] of Object.entries(restored?.opens ?? {})) openReads[id] = { found }
  /** 上一次「只用上次那几条正则」的重读没认出来 → 下一轮读全套、再叫一次模型(= 判词变了)。 */
  const openCheapFailed = new Set<string>()
  let openRunning: Promise<void> | undefined
  let lastOpenRunAt = 0

  /** 记下开集这一家的这一次尝试。回:这一格对外说的话变没变。 */
  function noteOpen(
    id: string,
    attempt: NonNullable<OpenQuotaReading['attempt']>,
    found?: OpenQuotaReading['found'],
  ): boolean {
    const before = openShape(openReads[id])
    const keep = found ?? openReads[id]?.found
    const was = openReads[id]
    openReads[id] = {
      ...(keep === undefined ? {} : { found: keep }),
      // ★ 卡 AN:原生那两格不归这一次窗口读法管,原样留着(谁新摆谁在 `openQuotaCell` 里判)。
      ...(was?.native === undefined ? {} : { native: was.native }),
      ...(was?.nativeWhy === undefined ? {} : { nativeWhy: was.nativeWhy }),
      attempt,
    }
    if (found !== undefined) persist()
    return openShape(openReads[id]) !== before
  }

  /** 这一格对外说的话(变没变就看它)。 */
  function openShape(one: OpenQuotaReading | undefined): string {
    return JSON.stringify({
      line: one?.found?.view.line, at: one?.found?.at, found: one?.attempt?.found,
      error: one?.attempt?.error, why: one?.attempt?.why, budget: one?.attempt?.budget,
      nativeLine: one?.native?.view.line, nativeAt: one?.native?.at, nativeWhy: one?.nativeWhy,
    })
  }

  /**
   * ★ **原生那条路先试**(2026-09-27,卡 AN)。
   *
   * 它**根本不碰壳**:不要辅助功能授权、不用把他藏起来的窗放出来、不遍历几百段字、不叫模型
   * —— 所以既快又不花钱,读成了就**整个跳过窗口读法那一趟**。
   *
   * 读到的那一份**不落盘**:它靠 Antigravity 开着才拿得到(端口与令牌每次启动都变),
   * 重启之后原地再读一次就好;落一个盘上的旧数反而会把窗口读法那份新的压住。
   *
   * 回 `{ done: true }` = 读成了,这一家这一轮到此为止;`{ done: false }` = 这一家没这条路 /
   * 这条路这会儿不行,接着走窗口读法。
   */
  async function readNativeOne(family: OpenQuotaFamily): Promise<{ done: boolean, changed: boolean }> {
    const fn = deps.readNative
    if (fn === undefined) return { done: false, changed: false }
    const at = now().toISOString()
    try {
      const view = await fn(family, at)
      // 这一家没有原生那条路 —— 照旧只走窗口读法。
      if (view === undefined) return { done: false, changed: false }
      const before = openShape(openReads[family.id])
      const was = openReads[family.id]
      // 读成了就把上一次那句「卡在哪一步」擦掉(它说的是上一次,留着会误导)。
      const next: OpenQuotaReading = { ...(was ?? {}), native: { at, view } }
      delete next.nativeWhy
      openReads[family.id] = next
      return { done: true, changed: openShape(openReads[family.id]) !== before }
    }
    catch (error) {
      // 说清卡在哪一步(D13:不编一个数),然后退回窗口读法那条兜底。
      const why = (error instanceof Error ? error.message : String(error)).slice(0, 120)
      const before = openShape(openReads[family.id])
      openReads[family.id] = { ...(openReads[family.id] ?? {}), nativeWhy: why }
      return { done: false, changed: openShape(openReads[family.id]) !== before }
    }
  }

  /**
   * 读一家开集的额度。
   *
   * 两条路:
   * - **省钱那条**(`full=false`,认出来过、上一次重读还成):只带上次命中的那几条正则去读,
   *   照上次的方子就地再算(`rereadOpenNumbers`)—— **不叫模型**。算不出来就记一笔,下一轮走全套;
   * - **全套那条**(`full=true`,或者从没认出来过、或者上次重读算不出来):八条正则全带,
   *   按窗分组,**同窗既有数字又有界面字**的那几组才值得花钱,交给模型判;判词还要
   *   `trustOpenQuota` 把原话逐字对回命中里才采信。
   *
   * 全套那条路里也**先试一遍方子**:判词没变(只有数变了)就不必再叫模型 —— 卡 QO:
   * 「判词变了才再叫一次模型」。
   */
  async function readOpenOne(
    family: OpenQuotaFamily,
    full: boolean,
    apps: Map<string, { running: boolean, active: boolean, hidden: boolean }> | undefined,
    byHand: boolean,
  ): Promise<boolean> {
    // ★ 卡 AN:先试「直接问它自己」那条(不碰壳、不叫模型);它成了就不必再翻他的窗口。
    const native = await readNativeOne(family)
    if (native.done) return native.changed
    const changed = await readOpenWindow(family, full, apps, byHand)
    return changed || native.changed
  }

  /**
   * 窗口读法那一趟(卡 QO / 卡 AG 那一套;卡 QZ 起前面多了「她在用就不碰」那一步)。
   * `byHand` = 她亲手点「读一下」(2026-10-19):只有这一下才许把没在跑的家起来;`full` 管的是「全套认一遍、要不要叫模型」。
   */
  async function readOpenWindow(
    family: OpenQuotaFamily,
    full: boolean,
    apps: Map<string, { running: boolean, active: boolean, hidden: boolean }> | undefined,
    byHand: boolean,
  ): Promise<boolean> {
    // 卡 BB:同 readOne —— 翻它的窗口之前先说一声,那一下的字变化不算「它回了一句」。
    try { deps.onWindowTouched?.([family.bundleId]) } catch { /* 说一声失败不连累这一次读 */ }
    const at = now().toISOString()
    const helper = deps.helper()
    if (!helper.connected) return noteOpen(family.id, { at, found: false, error: 'no_helper' })
    if (!helper.authorized) return noteOpen(family.id, { at, found: false, error: 'no_ax' })
    if (!helper.readTexts) return noteOpen(family.id, { at, found: false, error: 'old_shell' })
    // 卡 QZ:开集那几家(今天 Grok Bot / Antigravity)与窗口型那三家走同一条链 —— 一处判(`quotaReadStepFor`)。
    const app = appStateOf(apps, family.bundleId)
    const step = quotaReadStepFor(app)
    if (step === 'in_use') { say(`${family.id} 这会儿在前台(她在用),这一轮不碰`); return false }
    /*
     * 同 `readOne`:藏着的那一家,数还不旧就不为它放一次窗(她那一屏不该为一个好数闪一下)。
     * 这条路的「她亲手点的」拿 `full` 当判据 —— 它有两个来源:她点「读一下」,以及
     * 「她刚从一家还没认出过用量页的家切走」(`runNudge` 的 `fresh`)。后者那一刻那家**刚在前台**、
     * 不可能是藏着的,所以这道门对它压根不生效 —— 用 `full` 不会放错一次窗。
     */
    const openLastAt = [openReads[family.id]?.native?.at, openReads[family.id]?.found?.at]
      .filter((one): one is string => one !== undefined).sort().pop()
    // ★ 卡 QT:同 `readOne` —— 第一眼按原样读(不放窗),放窗只当第二眼。
    const hiddenNow = app?.hidden === true
    // ★ 卡「豆包闪一下」:同 `readOne` —— 「这一格真坏了没有」与「它藏没藏着」是两件事,单算一遍。
    const reallyBroken = worthUnhiding({
      ...(openLastAt === undefined ? {} : { lastAt: openLastAt }),
      byHand: full,
      now: now(),
    })
    const mayUnhide = !hiddenNow || (reallyBroken && (full || !futileUnhide.has(family.id)))
    if (hiddenNow && reallyBroken && !mayUnhide) say(`${family.id} 上回放窗也没读到,自动那一轮不再为它放窗;她点「读一下」时再放`)
    let launched = false
    if (step === 'launch') {
      /*
       * ★ 同 `readOne`(2026-10-19):自动那一轮不起没在跑的家。这条路的判据是 `byHand`,**不是 `full`** ——
       * `full` 还有一个来源是「她刚从一家没认出过用量页的家切走」(`runNudge` 的 `fresh`):她 ⌘Q 退掉那家、
       * 焦点换到别家,那一轮跟着来,此刻它已经没在跑,拿 `full` 当「她的指令」就会把她刚关的 App 开回来。
       */
      if (!byHand) {
        say(`${family.id} 没在跑,自动那一轮不起它(她关掉的 App 不由工作台开回来);她点「读一下」时才起`)
        return noteOpen(family.id, { at, found: false, error: 'not_running' })
      }
      // 两道门同 `readOne`;「上次读到数」的时刻是上面算好的那一份(原生那条 / 窗口读法那份里新的那个)。
      if (!worthLaunching(family.id, openLastAt)) return noteOpen(family.id, { at, found: false, error: 'not_running' })
      launched = await launchHidden(family.id, family.bundleId)
      if (!launched) return noteOpen(family.id, { at, found: false, error: 'not_running' })
    }
    try {
      /** 最近那一眼读到没读到(`noteOpen` 每一支都写 `attempt.found`)。 */
      const gotIt = (): boolean => openReads[family.id]?.attempt?.found === true
      /** 第二眼要不要放窗(同 `readOne`:藏着 + 过线 / 她亲手点的 / 这一轮是我们起的)。 */
      const secondLook = (): boolean => (hiddenNow && mayUnhide) || launched
      // ★ 第一眼:按原样读(不放窗)。
      let changed = await readOpenWindowTexts(family, full, at, false)
      if (gotIt()) return changed
      // ★ 第二眼:按原样读不到、而且值得为它放一次窗才放。
      if (secondLook()) {
        if (await readOpenWindowTexts(family, full, now().toISOString(), true)) changed = true
        if (gotIt()) { futileUnhide.delete(family.id); return changed }
        if (hiddenNow) futileUnhide.add(family.id)
      }
      else if (hiddenNow) say(`${family.id} 藏在后台、这一格的数又还不旧,这一轮不为它放窗(按原样那一眼没读到)`)
      /*
       * ★ **开集那几家也走「替她翻到额度那一页」**(2026-10-03,卡 QT)。
       *
       * 卡 QP 的交接写着「开集那几家压根没有 `reach` 这张表,所以这一步没给它们」——
       * 这张卡把那张表挪成两条路共用的一张(`quotaReachFor`),这条链于是接上了。
       * 没登记 `reach` 的那几家(今天 Antigravity)`reachPage` 第一行就回「没有」,行为一字不变。
       */
      const walked = await reachPage(family.id, family.bundleId, full, { reallyBroken })
      if (!walked.walked) return changed
      // 闪过台前那一条按原样读(同 `readOne`:壳已经把那家原样藏回去了,再放一次窗等于闪她第二下)。
      const againUnhide = walked.fronted === true ? false : (walked.by === 'link' ? true : secondLook())
      if (await readOpenWindowTexts(family, full, now().toISOString(), againUnhide)) changed = true
      if (walked.by === 'quota_page') await walkBack(family.id, family.bundleId, { ...(walked.fronted === true ? { fronted: true } : {}) })
      if (walked.by === 'link' && hiddenNow) await hideBack(family.id, family.bundleId)
      return changed
    }
    finally {
      // 我们起的那一家读完藏回去(同 `readOne` 的 `finally`;她眼前什么都不多)。
      if (launched) {
        try { await deps.request({ op: 'hide_app', bundle_id: family.bundleId }, 4_000) }
        catch { /* 藏不回去不改这一次读的结论 */ }
      }
    }
  }

  /** 真去读那一趟(卡 QO / 卡 AG 那一套;卡 QT 起多一格「这一眼放不放窗」)。 */
  async function readOpenWindowTexts(family: OpenQuotaFamily, full: boolean, at: string, unhide: boolean): Promise<boolean> {
    const recipe = openReads[family.id]?.found?.recipe
    const cheap = !full && recipe !== undefined && !openCheapFailed.has(family.id)
    const patterns = cheap && recipe !== undefined
      ? OPEN_QUOTA_PATTERNS.filter(one => one.id === recipe.quote.id || one.id === recipe.evidence.id || one.id === 'reset')
      : OPEN_QUOTA_PATTERNS
    try {
      // **不给 index**:新壳据此把每一扇窗都读一遍。重读时也不给 —— 壳那边「指名第几扇」数的是
      // 另一份窗口清单(只算标准窗),同一个序号指的可能是另一扇窗(见 TextInsert.readTexts)。
      // 所以「只重读那扇窗」是靠**先试上次那一扇 + 骨架对得上才算**做到的,不是靠 index。
      // 卡 QZ 这里写死 `true`;★ 卡 QT 改成由上面那两眼决定(第一眼按原样、放窗只当第二眼;理由同 `readOne`)。
      // ★ 卡「Grok 读键字」:声明过的那一家多带一格 `include_titles`(Grok Bot 的额度写在一颗键身上)。
      const raw = await deps.request({
        op: 'read_texts', bundle_id: family.bundleId, patterns, unhide, ...includeTitlesFor(family.id),
      }, 8_000)
      if (raw.ok === false) {
        const message = typeof raw.error === 'string' ? raw.error : ''
        return noteOpen(family.id, { at, found: false, error: readErrorOf(message), ...(message === '' ? {} : { note: message.slice(0, 60) }) })
      }
      const result = (raw.result ?? raw) as Record<string, unknown>
      const offspace = typeof result.offspace_windows === 'number' && result.offspace_windows > 0
        ? { offspace: result.offspace_windows }
        : {}
      const groups = byWindow(matchesOf(result.matches), sizesOf(result))
      /**
       * ★ 卡 AG(2026-09-27):读不到的时候**说清卡在哪一步**,不再一句「这页上没看见用量」。
       * 读了几扇窗、看了几段字是壳一起回来的(`window_count` / `text_nodes`),照数说话。
       */
      const scan = {
        groups,
        ...(typeof result.window_count === 'number' ? { windowCount: result.window_count } : {}),
        ...(typeof result.text_nodes === 'number' ? { textNodes: result.text_nodes } : {}),
      }
      const remembered = openReads[family.id]?.found?.window
      // 上次认出来的那一扇先试(窗口顺序会变,所以只当「先试谁」用,不当身份用)。
      const ordered = remembered === undefined
        ? groups
        : [...groups].sort((a, b) => Number(b.window === remembered) - Number(a.window === remembered))
      if (recipe !== undefined) {
        for (const group of ordered) {
          const again = rereadOpenNumbers(recipe, group.matches)
          if (again === undefined) continue
          openCheapFailed.delete(family.id)
          const view = openQuotaView({ id: family.id, title: family.title, at, numbers: again })
          return noteOpen(family.id, { at, found: true, ...offspace }, { at, window: group.window, view, recipe: openQuotaRecipe(again) })
        }
      }
      if (cheap) {
        // 只读了上次那几条正则,算不出来 —— 这一轮先不叫模型(可能就是它没开着那一页),
        // 记一笔,下一轮读全套再判。那一格照旧摆上次那个数(带几点读到的,卡 QS)。
        openCheapFailed.add(family.id)
        return noteOpen(family.id, { at, found: false, ...offspace, why: openQuotaMissWhy(scan), whyShort: openQuotaMissShort(scan) })
      }
      openCheapFailed.delete(family.id)
      const worth = ordered.filter(one => openQuotaWorth(one.matches)).slice(0, OPEN_QUOTA_MAX_JUDGE_GROUPS)
      if (worth.length === 0) return noteOpen(family.id, { at, found: false, ...offspace, why: openQuotaMissWhy(scan), whyShort: openQuotaMissShort(scan) })
      const judge = deps.judgeQuota
      if (judge === undefined) return noteOpen(family.id, { at, found: false, ...offspace, why: '模型服务没接上,判不了这一页上的用量' })
      for (const group of worth) {
        const prompt = openQuotaPrompt({ title: family.title, matches: group.matches })
        const estimate = openQuotaEstimate(prompt)
        const gate = deps.judgeBudget === undefined ? { ok: true as const } : await deps.judgeBudget.gate(estimate)
        // 今天判额度的模型钱到上限了:照实说,明天再读(不偷偷不显示)。
        if (!gate.ok) return noteOpen(family.id, { at, found: false, ...offspace, budget: gate.why })
        await deps.judgeBudget?.spend(estimate)
        let said: string
        try { said = await judge(prompt, OPEN_QUOTA_MAX_TOKENS) }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return noteOpen(family.id, { at, found: false, ...offspace, why: `问模型没问成:${message.slice(0, 40)}` })
        }
        const verdict = parseOpenQuotaVerdict(said)
        if (verdict === undefined) continue
        const trusted = trustOpenQuota(verdict, group.matches)
        if (!trusted.ok) continue
        const view = openQuotaView({ id: family.id, title: family.title, at, numbers: trusted.numbers })
        return noteOpen(family.id, { at, found: true, ...offspace }, { at, window: group.window, view, recipe: openQuotaRecipe(trusted.numbers) })
      }
      return noteOpen(family.id, {
        at, found: false, ...offspace,
        why: openQuotaMissWhy({ ...scan, modelSaidNone: true }),
        whyShort: openQuotaMissShort({ ...scan, modelSaidNone: true }),
      })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return noteOpen(family.id, { at, found: false, error: readErrorOf(message), note: message.slice(0, 60) })
    }
  }

  /**
   * 读一轮开集的那几家。`full`(他点了「读一下」)= 八条正则全带、判词变了就再叫一次模型;
   * 缺省 = 省钱那条(认出来过的只带上次那几条正则,不叫模型)。同一时刻只跑一轮。
   */
  /**
   * 读一轮开集那几家。`full` = 全套认一遍(八条通用正则、判词变了再叫模型);`onlyKnown` = 只读认出来过的;
   * `byHand`(2026-10-19)= 她亲手点「读一下」—— **只有这一下才许把没在跑的家起来**,自动那几路(10 分钟 / 切走 / 切回来 / 体检顺手读)都不带。
   */
  async function refreshOpen(families: readonly OpenQuotaFamily[], opts: { full?: boolean, onlyKnown?: boolean, byHand?: boolean } = {}): Promise<void> {
    if (openRunning !== undefined) return await openRunning
    lastOpenRunAt = now().getTime()
    openRunning = (async () => {
      let changed = false
      const touched: string[] = []
      // 卡 QZ:一轮只问一次「谁在跑 / 谁在前台」(同 `refresh`)。
      const apps = families.length === 0 ? undefined : await runningAppsNow()
      for (const family of families) {
        // ★ 卡 AG 追加:事件触发那一路只读**认出来过的**(有方子的)那几家 ——
        // 没方子的要走全套、要叫模型,那是他点「读一下」时才该花的钱,不是他切一下窗口就花的。
        // ★ 卡 AN 补:原生那条路的那几家也算「认出来过」—— 它连模型都不叫,比按方子重读还便宜,
        // 没道理让他切一下窗口读不到新数(卡 AG 那条 `onlyKnown` 本来只想挡住「要叫模型」的那几家)。
        const known = openReads[family.id]?.found?.recipe !== undefined || openReads[family.id]?.native !== undefined
        if (opts.onlyKnown === true && !known) continue
        touched.push(family.bundleId)
        if (await readOpenOne(family, opts.full === true, apps, opts.byHand === true)) changed = true
      }
      // 卡 BB:读完再说一声(同 refresh)。
      if (touched.length > 0) { try { deps.onWindowTouched?.(touched) } catch { /* 说一声失败不连累这一轮 */ } }
      if (changed) deps.onChanged?.()
    })().finally(() => { openRunning = undefined })
    return await openRunning
  }

  /** 节流过的「顺手读一轮」开集那几家(同 `pump`:缺省 10 分钟一轮,不等它)。 */
  function pumpOpen(families: readonly OpenQuotaFamily[], maxAgeMs = 10 * 60_000): void {
    if (openRunning !== undefined || families.length === 0) return
    if (now().getTime() - lastOpenRunAt < maxAgeMs) return
    void refreshOpen(families).catch(() => {})
  }

  // ───────── 事件触发的重读(2026-09-27,卡 AG 追加)─────────
  //
  // 维护者 10:45:「10 分钟一轮这个解法会不会太不优雅了,我听着延迟大,用户还是可感知的」。
  // **额度只在他用那家的时候变**,所以不必定时翻他的窗口:他一从那家切走就读那一家
  // (`nudge`),切回工作台就把放了一会儿的那几家补一遍(`catchUp`)。两条路都**只重读
  // 认出来过的那几家、不叫模型**,所以是几百毫秒的事。10 分钟那一轮留着兜底。

  /** 开集那几家是谁 —— 只有 HTTP 那一层数得出来(要登记表),连上之后由它塞进来。 */
  let openFamiliesFn: (() => readonly OpenQuotaFamily[]) | undefined
  const nudgeBundles = new Set<string>()
  let nudgeScheduled = false

  function bindOpenFamilies(fn: () => readonly OpenQuotaFamily[]): void {
    openFamiliesFn = fn
  }

  /** 这几个包标识对应的窗口型那几家(Muse / Manus / 豆包办公)。 */
  function specIdsFor(bundles: ReadonlySet<string>): string[] {
    return [...specsOf()].filter(([, spec]) => bundles.has(spec.bundleId)).map(([id]) => id)
  }

  function runNudge(): void {
    nudgeScheduled = false
    const bundles = new Set(nudgeBundles)
    nudgeBundles.clear()
    if (bundles.size === 0) return
    // 先跟登记表那一路说一声(卡 BB):我这就去翻它们的窗口,那一下的字变化不算「它回了一句」。
    try { deps.onWindowTouched?.([...bundles]) } catch { /* 说一声失败不连累这一轮重读 */ }
    const ids = specIdsFor(bundles)
    if (ids.length > 0) void refresh(ids).catch(() => {})
    const families = (openFamiliesFn?.() ?? []).filter(one => bundles.has(one.bundleId))
    if (families.length > 0) {
      /*
       * 2026-09-27(维护者:「读一下这个东西就不要了吧,不止交互,包括功能」)—— 「读一下」那颗键与 10 分钟那一轮都撤了,
       * 一家**还没认出过用量页**的,只有在这里(他从那家切走)才有机会第一次认。认一次要叫模型,
       * 所以同一家 30 分钟内最多试一次全套;认出来过的照旧只按方子重读、不叫模型。
       */
      const t = now().getTime()
      const known = (one: OpenQuotaFamily): boolean => openReads[one.id]?.found?.recipe !== undefined || openReads[one.id]?.native !== undefined
      const fresh = families.filter(one => !known(one) && t - (openFirstTry.get(one.id) ?? 0) >= QUOTA_FIRST_TRY_GAP_MS)
      for (const one of fresh) openFirstTry.set(one.id, t)
      const knownOnes = families.filter(known)
      void (async () => {
        if (knownOnes.length > 0) await refreshOpen(knownOnes, { onlyKnown: true })
        if (fresh.length > 0) await refreshOpen(fresh, { full: true })
      })().catch(() => {})
    }
  }

  /**
   * 他刚从这几家切走了 → 过一会儿(防抖)重读它们。
   * **防抖**:连着 Cmd-Tab 按五下只排一次(`QUOTA_NUDGE_DEBOUNCE_MS`),读一次。
   */
  /**
   * 原生那条路(Antigravity 的本机语言服务)顺手问一次(2026-09-27)。**只问本机服务,一扇窗都不碰**
   * —— 撤掉定时读窗口之后,重启 / 刷新页面那一刻它那一格会「没接上」直到他切走那家;这一路补上。
   * 节流:整体 60 秒最多泵一次;某一家原生读数不到 3 分钟不重复问。
   */
  let lastNativePumpAt = 0
  const nativeInFlight = new Set<string>()
  function pumpNative(families: readonly OpenQuotaFamily[]): void {
    if (deps.readNative === undefined || families.length === 0) return
    const t = now().getTime()
    if (t - lastNativePumpAt < 60_000) return
    lastNativePumpAt = t
    let changed = false
    const due = families.filter((one) => {
      const at = openReads[one.id]?.native?.at
      return !nativeInFlight.has(one.id) && (at === undefined || t - new Date(at).getTime() >= 3 * 60_000)
    })
    if (due.length === 0) return
    void (async () => {
      for (const one of due) {
        nativeInFlight.add(one.id)
        try { if ((await readNativeOne(one)).changed) changed = true }
        finally { nativeInFlight.delete(one.id) }
      }
      if (changed) deps.onChanged?.()
    })().catch(() => {})
  }

  /** 还没认出过用量页的那一家,上一次试全套是什么时候(见 runNudge)。 */
  const openFirstTry = new Map<string, number>()

  function nudge(bundleIds: readonly string[]): void {
    for (const one of bundleIds) if (one !== '') nudgeBundles.add(one)
    if (nudgeBundles.size === 0 || nudgeScheduled) return
    nudgeScheduled = true
    schedule(runNudge, QUOTA_NUDGE_DEBOUNCE_MS)
  }

  /**
   * 他切回工作台了 → 把**超过 `maxAgeMs` 没读到新数**的那几家顺手补一遍
   * (刚读过的不动 —— 他来回切两下不该变成来回读两遍)。
   */
  function catchUp(maxAgeMs = QUOTA_CATCHUP_AGE_MS): void {
    const t = now().getTime()
    const old = (at: string | undefined): boolean => at === undefined || t - new Date(at).getTime() >= maxAgeMs
    for (const [id, spec] of specsOf()) if (old(readings[id]?.last?.at)) nudgeBundles.add(spec.bundleId)
    for (const one of openFamiliesFn?.() ?? []) {
      const read = openReads[one.id]
      // ★ 卡 AN:原生那条路按**它自己**上次读到的时刻算岁数(窗口读法那份可能压根没有)。
      if (read?.native !== undefined) { if (old(read.native.at)) nudgeBundles.add(one.bundleId); continue }
      if (read?.found?.recipe !== undefined && old(read.found.at)) nudgeBundles.add(one.bundleId)
    }
    if (nudgeBundles.size === 0 || nudgeScheduled) return
    nudgeScheduled = true
    schedule(runNudge, QUOTA_NUDGE_DEBOUNCE_MS)
  }

  return {
    readings: (): Readonly<Record<string, WindowQuotaReading>> => ({ ...readings }),
    refresh,
    pump,
    pumpNative,
    /**
     * 开集那几家此刻读到的(按 id)。**给了 `families` 就给每一家都留一格**(哪怕还没读过)——
     * `quotaFor` 靠「这一格在不在」判「这一家有没有开集那条路」,有才给「读一下」。
     */
    openReadings: (families?: readonly OpenQuotaFamily[]): Readonly<Record<string, OpenQuotaReading>> => {
      const out: Record<string, OpenQuotaReading> = { ...openReads }
      // 名字用**这一刻**登记表里的(他刚在设置里改过名,那一格就该跟着改)。
      for (const family of families ?? []) out[family.id] = { ...(openReads[family.id] ?? {}), title: family.title }
      return out
    },
    refreshOpen,
    pumpOpen,
    bindOpenFamilies,
    nudge,
    catchUp,
  }
}

export type WindowQuotaReader = ReturnType<typeof createWindowQuotaReader>
