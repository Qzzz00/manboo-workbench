/**
 * **开集的额度读法**(2026-09-26,卡 QO)。维护者原话:「要有机制」。
 *
 * 登记表(卡 Q / 卡 Z)是开集:今天新接上 Grok Bot(`com.anysphere.sand`)、Antigravity
 * (`com.google.antigravity`),明天是任何一家。以前这几家的额度那一格永远写「没接上:还没找到这家的额度来源」
 * —— 写死了七家的读法,第八家就只能是一句死话。这个文件是那条**不写死**的路的前半截(**全是纯函数**):
 *
 * | 哪一步 | 谁做 | 在哪 |
 * |---|---|---|
 * | ① 对这家每一扇窗跑一次 `read_texts`,只认用量那类字 | 壳 + 读数器 | {@link OPEN_QUOTA_PATTERNS};读数器在 `agentQuota.ts` |
 * | ② 命中的那几小段(**按窗分组**)交给模型:这一页上有没有这家自己的用量数字 | 模型 | {@link openQuotaPrompt} / {@link parseOpenQuotaVerdict} |
 * | ③ 判词要带**原话引用**,而且原话与旁证都得真在这一扇窗的命中里 | 本文件 | {@link trustOpenQuota} |
 * | ④ 认出来之后按 10 分钟节流自动重读:**只用上次命中的那几条正则、不再叫模型** | 本文件 | {@link rereadOpenNumbers} |
 *
 * ## 为什么这么小心(D13:不编数)
 *
 * 卡 MQ 刚撞过一次:壳从只读第 0 扇窗改成**每扇都读**之后,聊天窗也进了读的范围 —— 而维护者跟 Muse 聊的
 * **正是额度**,那扇聊天窗的记录里明晃晃写着「周限额的 0%」「周额度只剩 1%」。见着百分号就当额度,
 * 工作台就会把**他对话里的一个数**当成这家的剩余额度摆在界面上。**假阳性比读不到坏得多。**
 *
 * 所以这里有三道门,少一道都不采信:
 * 1. **同一扇窗**:命中按窗分组(`byWindow`),一组一组地判 —— 不拿聊天窗里的一句话去配设置窗里的一个数;
 * 2. **同窗要有旁证**:那一组里除了数字,还得有「这是用量页」的界面字(页标题 / 档位 / 额度上限 / 重置那一行,
 *    {@link OPEN_EVIDENCE_IDS});旁证还得**短**({@link OPEN_EVIDENCE_MAX_CHARS})—— 界面标签都短,
 *    聊天里那句「你的周限额是多少来着」不短;
 * 3. **判词里的原话要对得上**:模型说的 `quote` / `evidence` 必须**逐字**是这一组命中里的某一段
 *    ({@link trustOpenQuota}),数字还得真出现在那句原话里。模型编一句话出来是不算的。
 *
 * ## 隐私边界(不许放宽)
 *
 * 壳 `read_texts` 只回**正则命中的那一小段**(≤80 字,`workbench-app/Sources/TextInsert.swift`),
 * 不回整窗。这个文件给的正则也是照这条线写的:数字类前后各留一小截上下文(光一个「used」对判词没用),
 * 旁证类**整格文字**(`^…$`)。**不许改成整窗回传** —— 那就等于把他的对话喂给模型了。
 *
 * ## 壳那一侧的两条硬上限(`SendTextPolicy`)
 *
 * - `readTextsMaxPatterns`:一次最多几条正则 —— {@link OPEN_QUOTA_PATTERNS} 不能超过它;
 * - `readTextsMaxMatches`:每扇窗最多回几段(`matchTexts` 是按窗调的,不是几扇合起来)。
 *
 * ★ **2026-09-27(卡 AG)这两个数抬高了一档**(8 → 12 条、12 → 24 段)。维护者原话:
 * 「为什么我肉眼都看到额度信息了,但是还说读不到或者读反了」—— Antigravity 的「Models & Usage」
 * 一页上有**两组模型 × 两条限额 = 四行**,老上限下组名那两行连一条正则都排不上(卡 QG 只好把两组并成一行)。
 * 所以这里多了第 9 条 {@link OPEN_QUOTA_PATTERNS} `group`(组名),**改了壳要重装壳**。
 *
 * ## 正则里不许写 `(?i)`
 *
 * 壳那边是 NSRegularExpression(ICU,认 `(?i)`),但这几条正则的用例是在 JS 里 `new RegExp(regex)` 跑的
 * —— JS 不认内联标志,`(?i)` 会变成一个字面量分组,规则就悄悄失效了。所以大小写一律写成字符组
 * (`[Uu]sed`)。代价:全大写的「USAGE」认不出 —— 宁可少认一种,不要一条静悄悄不生效的正则。
 */
import { estimateCallCny } from './agentJudge.ts'

/** 壳 `read_texts` 回来的一段命中(与 `agentQuota.ts` 的同一个形状,类型从那边借,不在这里再定一份)。 */
import type { WindowTextMatch } from './agentQuota.ts'

/**
 * 通用但**只认用量那类字**的正则,正好 8 条(壳的上限)。照卡 MQ 探针里那组缺省正则起步
 * (`workbench-app/Tools/main.swift` 的 `read-texts`),按这里的三道门收紧:
 *
 * - **数字类**({@link OPEN_NUMBER_IDS}):前后各留一小截上下文 —— 壳只回命中的那一段,
 *   光回一个「used」模型判不出什么;
 * - **旁证类**({@link OPEN_EVIDENCE_IDS}):**整格文字**才算(`^…$`),聊天里的一句话配不上。
 *   这一条是卡 MQ 给 Muse 定的规矩,这里照搬。
 */
export const OPEN_QUOTA_PATTERNS: readonly { id: string, regex: string }[] = [
  // ── 数字类 ──
  { id: 'pct', regex: '[^\\n]{0,20}[0-9]{1,3}(?:\\.[0-9]+)?\\s*%[^\\n]{0,20}' },
  { id: 'used', regex: '[^\\n]{0,16}(?:已使用|已用完|已用|用了|剩余|还剩|剩下|[Uu]sed|[Rr]emaining|[Ll]eft)[^\\n]{0,28}' },
  { id: 'credits', regex: '[^\\n]{0,16}(?:积分|点数|余额|[Cc]redits?|[Pp]oints?|[Tt]okens?)[^\\n]{0,28}' },
  { id: 'times', regex: '[^\\n]{0,12}[0-9][0-9,]*(?:\\.[0-9]+)?\\s*(?:次|条消息|条|[Mm]essages?|[Rr]equests?)[^\\n]{0,20}' },
  // ── 旁证类(整格文字)──
  // 两支:老那一支照旧是**整格恰好是那几个词**(中文页标题「使用情况」「额度」都在这一支);
  // 卡 QG 新加的第二支只放**整格全是西文**的那一种 ——「Models & Usage」(Antigravity)、
  // 「Weekly Usage」「Usage & Billing」(Grok Bot)这类带前后缀的页标题 / 列名。
  // 为什么第二支只认西文、还不许带数:前后缀一放开,中文聊天里那句「我看了一下 Usage 那一页」
  // 「你这周额度只剩 1% 了」立刻也成了整格命中 —— 而界面上的页标题从来不带数字。
  // 整格文字这条线没动,旁证还要 ≤24 字({@link OPEN_EVIDENCE_MAX_CHARS}),两条都有用例钉着。
  { id: 'page', regex: '^(?:(?:使用情况|使用量|用量|额度|配额|账单|订阅|套餐|用量与额度|[Uu]sage|[Uu]sage (?:&|and) [Ll]imits|[Bb]illing|[Ss]ubscription|[Pp]lans?|[Cc]redits|[Qq]uota|[Ll]imits)|(?![^\\n]*[0-9])[A-Za-z][A-Za-z &/\'-]{0,11}(?:[Uu]sage|[Bb]illing|[Cc]redits|[Qq]uota|[Ss]ubscription|[Pp]lans?|[Ll]imits)[A-Za-z &/\'-]{0,12})$' },
  { id: 'plan', regex: '^(?:Free|Pro|Plus|Premium|Basic|Business|Team|Enterprise|Max)(?: (?:plan|tier|套餐))?$|^(?:免费|基础|专业|高级|旗舰|团队|企业)(?:版|档|套餐|计划|方案)$|^(?:[Uu]nlimited|无限制|不限量?)$' },
  // 「限额」这一条的前后**收得比别条紧**(后面只留 6 个字):放宽到 12 的时候,
  // 「你上次说的那个周限额到底是多少来着」这种一整格的聊天话也成了「旁证」——
  // 而它前面正好 8 个字、后面 11 个字。旁证宁可少认几种写法,不能让聊天话冒充界面标签。
  // 后面那一截照旧只留 6 个字;**只有「剩余 / Remaining」这一类结尾**才多让一点 ——
  // 真机 Antigravity 的条目名是「Weekly Limit Remaining」「Five Hour Limit Remaining」
  // (前缀「Five Hour 」正好 10 个字,所以前面放到 12)。
  { id: 'limit', regex: '^[^\\n]{0,12}(?:限额|上限|[Ll]imits?|[Qq]uota)(?:[^\\n]{0,6}|[^\\n]{0,2}(?:[Rr]emaining|[Ll]eft|剩余|还剩))$' },
  { id: 'reset', regex: '^[^\\n]{0,12}(?:重置|刷新|[Rr]esets? (?:on|at|in)|[Rr]enews? on)[^\\n]{0,12}$' },
  // ── 组名(第 9 条,2026-09-27 卡 AG)──
  // 一页用量里**这几行归谁**:Antigravity 的「Gemini Models」「Claude and GPT models」。
  // 与旁证类同样是**整格文字**,而且比旁证还紧:**整格全是西文、一个数都不许有、必须以
  // Model(s) 结尾**。为什么这么紧:组名放开一点点,中文聊天里的「这两个 models 都可以」
  // 立刻也成了一条组名,四行就会被安到一个他从没见过的名字底下 —— 行名错比读不到更难查。
  // 它既不算数字、也不算旁证({@link OPEN_NUMBER_IDS} / {@link OPEN_EVIDENCE_IDS} 都不含它):
  // 「Gemini Models」证明不了这是用量页,只说明这几行归哪一组。
  { id: 'group', regex: '^(?![^\\n]*[0-9])[A-Za-z][A-Za-z &/\'-]{0,26}[Mm]odels?$' },
]

/**
 * 壳一扇窗最多回几段(`SendTextPolicy.readTextsMaxMatches`)。**这里只是壳那个数的一份副本**,
 * 用来判「这一扇窗的命中是不是被上限挤爆了」—— 挤爆了就该照实说,而不是说「这页上没看见用量」。
 * 壳那边改了这里要跟着改(两边各有一条用例钉着下限)。
 */
export const OPEN_SHELL_MAX_MATCHES = 24

/** 组名那一条正则的 id(既不算数字,也不算旁证)。 */
export const OPEN_GROUP_ID = 'group'

/** 数字在哪几条正则上。 */
export const OPEN_NUMBER_IDS: readonly string[] = ['pct', 'used', 'credits', 'times']
/** 「这一扇窗上确实是用量 / 额度那一页」的旁证在哪几条正则上。 */
export const OPEN_EVIDENCE_IDS: readonly string[] = ['page', 'plan', 'limit', 'reset']

/**
 * 旁证最长多少字才算。界面标签都短(「使用情况」「Free plan」「Weekly limit resets on Oct 1」);
 * 聊天里那句「你上次说周限额是多少来着」也可能是一整格文字,但它长。这是第三道门里最便宜的那一道。
 */
export const OPEN_EVIDENCE_MAX_CHARS = 24

/** 判一页最多给模型多少输出(判词是一行 JSON)。 */
export const OPEN_QUOTA_MAX_TOKENS = 200

/**
 * 一页上最多认几条用量数字(卡 QG:Antigravity 四条 —— 周 / 5 小时 × 两组模型)。
 * 再多就不是一页用量了,多半是把满屏的百分比都当成了额度。
 */
export const OPEN_QUOTA_MAX_ITEMS = 6

/**
 * 一次读里最多问模型几组(= 几扇窗)。一个人开着好几扇窗是常态,但每问一次都是钱;
 * 用量页几乎总在前一两扇里(壳按 AX 的窗口顺序回),问不到就等他点「读一下」时再说。
 */
export const OPEN_QUOTA_MAX_JUDGE_GROUPS = 2

/** 认不出时那一句(界面上、判词里都是它)。 */
export const OPEN_QUOTA_NOT_SEEN = '这页上没看见用量'

/** 怎么读出来(「读一下」旁边那一句)。 */
export const OPEN_QUOTA_HINT = '打开它显示用量/额度的那一页,切走时工作台会自己读一次'

/** 今天判额度的模型钱花完了。 */
export const OPEN_QUOTA_BUDGET_WHY = '今天判额度的模型额度用完了,明天再读'

/**
 * **一个数是「已用」还是「剩余」,照同一扇窗上的原话数出来,不问模型**(2026-09-26 晚,卡 QG)。
 *
 * 维护者 22:15 截图:Grok Bot 的 Usage & Billing 页上写着「Weekly Usage」「Resets in 7 days」「5%」
 * —— 那是**已用 5%**(还剩 95%)。而那一格的原话只有「5%」三个字符:已用还是剩余全在别的格子里写着,
 * 模型猜了一个,猜反了,面板画出一条橙色的「只剩 5%」。
 *
 * 所以口径这件事**不归模型**:
 * 1. 数字那一句自己说得清(「已使用 38%」「剩 1,234 积分」)→ 照它;
 * 2. 说不清 → 同一扇窗上**离它最近**的那一句「已用 / 剩余」字说了算(Antigravity 的
 *    「Weekly Limit Remaining」就在那个 100% 的左边);
 * 3. 一句强字都没有 → 退到「用量 / Usage」这类**弱字**(Grok Bot 的「Weekly Usage」= 这一列是已用);
 * 4. 还是没有 → `undefined`,**不采信**(D13:宁可读不到,也不猜一个口径)。
 *
 * 「最近」按 |Δx| + 4|Δy| 算:同一行(y 一样)的那一句先说话 —— 界面上标签与数字就是同一行左右摆的。
 */
const OPEN_USED_WORDS = /已使用|已用完|已用|用掉|用了|[Uu]sed/
const OPEN_LEFT_WORDS = /剩|余下|余额|[Rr]emaining|[Ll]eft/
/** 弱的一类:页标题 / 列名里的「用量」「Usage」—— 一句强字都没有时才拿它当口径。 */
const OPEN_USAGE_WORDS = /用量|使用情况|使用量|[Uu]sage/

export type OpenQuotaSide = 'used' | 'left'

function sideOfText(text: string, weak: boolean): OpenQuotaSide | undefined {
  const used = OPEN_USED_WORDS.test(text)
  const left = OPEN_LEFT_WORDS.test(text)
  // 一句里两样都有(「已用 38%,剩余 62%」)= 这一句说不清,让别的句子说。
  if (used && left) return undefined
  if (used) return 'used'
  if (left) return 'left'
  return weak && OPEN_USAGE_WORDS.test(text) ? 'used' : undefined
}

/** 同一扇窗上离得多近(同一行优先:纵向的差算四倍)。 */
function apart(a: WindowTextMatch, b: WindowTextMatch): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) * 4
}

function nearest(quote: WindowTextMatch, list: readonly WindowTextMatch[]): WindowTextMatch | undefined {
  let best: WindowTextMatch | undefined
  for (const one of list) if (best === undefined || apart(one, quote) < apart(best, quote)) best = one
  return best
}

/** 这个数是「已用」还是「剩余」(见上面那一段)。 */
export function openQuotaSide(quote: WindowTextMatch, matches: readonly WindowTextMatch[]): OpenQuotaSide | undefined {
  const own = sideOfText(quote.text, false)
  if (own !== undefined) return own
  const others = matches.filter(one => one !== quote)
  const strong = nearest(quote, others.filter(one => sideOfText(one.text, false) !== undefined))
  if (strong !== undefined) return sideOfText(strong.text, false)
  const ownWeak = sideOfText(quote.text, true)
  if (ownWeak !== undefined) return ownWeak
  const weak = nearest(quote, others.filter(one => sideOfText(one.text, true) !== undefined))
  return weak === undefined ? undefined : sideOfText(weak.text, true)
}

/** 行标签能从哪几条正则来(**不含重置那一条** —— 「Resets in 7 days」当行名没意义)。 */
const OPEN_LABEL_IDS: readonly string[] = ['limit', 'page', 'plan']

/**
 * 这个数那一行叫什么:同窗**离它最近**的那一句界面字,**原样照抄**
 * (Antigravity 的「Weekly Limit Remaining」/「Five Hour Limit Remaining」)。找不到就没有标签。
 */
export function openQuotaLabel(quote: WindowTextMatch, matches: readonly WindowTextMatch[]): string | undefined {
  const one = nearest(quote, matches.filter(x => x !== quote && OPEN_LABEL_IDS.includes(x.id)))
  return one === undefined ? undefined : one.text.trim()
}

/**
 * 这个数归**哪一组**(2026-09-27,卡 AG)。
 *
 * 组名是**段落标题**,不是同一行的标签 —— 所以不能用 {@link openQuotaLabel} 那套「离得最近」:
 * 「Claude and GPT models」离 Gemini 那一组的最后一行可能比「Gemini Models」还近。
 * 界面上段落标题永远在它管的那几行**上面**,所以只认 `y` 不大于这个数的那几条,取**最靠下**的一个;
 * 同一行并排两个组名(极少)时再比 `x`。一条组名都没有、或者这个数在第一条组名上面 → 不归任何一组
 * (D13:宁可没有组名,不把它安到一个错的组里)。
 */
export function openQuotaGroup(quote: WindowTextMatch, matches: readonly WindowTextMatch[]): string | undefined {
  let best: WindowTextMatch | undefined
  for (const one of matches) {
    if (one.id !== OPEN_GROUP_ID || one === quote || one.y > quote.y) continue
    if (best === undefined || one.y > best.y || (one.y === best.y && Math.abs(one.x - quote.x) < Math.abs(best.x - quote.x))) best = one
  }
  return best === undefined ? undefined : best.text.trim()
}

/** 一条数那一行的身份:组名 + 行名(重读时靠它把同骨架的几段分给各行)。 */
function rowKey(group: string | undefined, label: string | undefined): string {
  return `${group ?? ''}\u0000${label ?? ''}`
}

// ───────────────────────── 值不值得问模型 ─────────────────────────

function isNumberHit(one: WindowTextMatch): boolean {
  return OPEN_NUMBER_IDS.includes(one.id)
}

function isEvidenceHit(one: WindowTextMatch): boolean {
  return OPEN_EVIDENCE_IDS.includes(one.id) && [...one.text.trim()].length <= OPEN_EVIDENCE_MAX_CHARS
}

/**
 * 这一扇窗上的命中值不值得花一次模型钱:**同窗既有数字、也有「这是用量页」的界面字**。
 *
 * 只有数字的那一组一律不问 —— 那正是聊天窗的样子(他跟 AI 聊额度,记录里有百分比,没有页标题)。
 * 不问 = 不花钱,也不给模型机会把聊天里的数说成额度。
 */
export function openQuotaWorth(matches: readonly WindowTextMatch[]): boolean {
  return matches.some(isNumberHit) && matches.some(isEvidenceHit)
}

// ───────────────────────── 问模型 ─────────────────────────

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length <= max ? flat : `${chars.slice(0, max).join('')}…`
}

/** 一行里不许出现分隔符与换行(同 `agentJudge` 的 `cell`:一段原话不能把清单拆坏)。 */
function row(text: string): string {
  return clip(text.replace(/[|\n\r]/g, ' '), 80)
}

/**
 * 问模型那一段:「这一页上有没有这家自己的用量 / 额度数字?是哪一句?剩多少、什么时候重置?」
 *
 * 三件事写死在话里:**对话里说的不算**、**答有数必须同时给数字原话与旁证原话**、**拿不准答 none**。
 * 模型答了什么并不等于工作台就采信 —— {@link trustOpenQuota} 还要把原话逐字对回命中里。
 */
export function openQuotaPrompt(input: { title: string, matches: readonly WindowTextMatch[] }): string {
  const rows = input.matches.map((one, index) => [
    String(index + 1), isNumberHit(one) ? '数字' : '界面字', row(one.text),
  ].join('|'))
  return [
    `你在帮一个桌面工作台读「${clip(input.title, 40)}」这个应用**自己窗口上**的用量 / 额度。`,
    '下面几小段字是从它的**同一扇窗**上按正则摘下来的(每段不超过 80 字,窗口里别的字一个都没摘)。',
    '判断:这一扇窗上有没有**这家自己的**用量 / 额度数字?是哪一句?剩多少、什么时候重置?',
    '规矩:',
    '- 只认它自己的用量页 / 额度页 / 账单页上的数字。**对话里说的话不算** —— 人跟 AI 聊天时也会说',
    '  「只剩 1%」「周限额」,那不是这个应用的额度。',
    '- 所以要答有数,必须同时指出两样:数字那一句的**原话**,和「这一扇窗是用量页」的**旁证原话**',
    '  (页标题、档位、额度 / 上限、重置时间这一类**短的界面字**,不是一句话)。',
    '- 两样都要**原样照抄**下面清单里的某一整段,一个字都不许改、不许拼接、不许自己写。',
    '- 看不出来就答 none。**宁可说没看见,也不要给一个错的数。**',
    '这一扇窗上摘到的几段(每行:序号|哪一类|原话):',
    ...rows,
    '- 这一页上**这家自己的**用量数字不止一个(周限额一个、5 小时限额一个,几组模型各一份)时,',
    '  把每一句的原话都列进 items(quote 那一句也算一条,列不列都行)。',
    '只回一行 JSON,不要别的字:',
    '{"kind":"numbers|unlimited|none","quote":"数字那一句的原话","evidence":"旁证那一句的原话","measure":"used_pct|left_pct|left_amount","value":38,"unit":"积分","items":["另一句的原话"],"reset":"重置那一句的原话","reason":"一句中文理由"}',
    '- measure:used_pct / left_pct = 这个数是百分比;left_amount = 还剩多少个(积分 / 次 / 条),',
    '  这时 value 是那个数、unit 写单位。**「已用」还是「剩余」不用你判** —— 工作台照这一页上',
    '  自己的原话(Usage / used / 已用 → 已用;Remaining / 剩余 → 剩余)数,你判错也不算数。',
    '- kind=unlimited(这一页明写着不限 / 无限制)时 quote 写那一句「不限」的原话,evidence 照样要,不要 measure。',
    '- kind=none 时只回 kind 与 reason。',
    '- reset 可有可无:读到了就把那一句原话照抄过来,**不要自己折算成日期**。',
  ].join('\n')
}

/** 模型回的那一段里的第一个 JSON 对象(它常在前后加几句话或者代码围栏)。 */
function firstObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  }
  catch { return undefined }
}

export type OpenQuotaMeasure = 'used_pct' | 'left_pct' | 'left_amount'

const MEASURES: readonly OpenQuotaMeasure[] = ['used_pct', 'left_pct', 'left_amount']

function isMeasure(value: unknown): value is OpenQuotaMeasure {
  return typeof value === 'string' && (MEASURES as readonly string[]).includes(value)
}

export interface OpenQuotaVerdict {
  kind: 'numbers' | 'unlimited' | 'none'
  /** 数字那一句的原话(模型说的;还要对回命中里才算)。 */
  quote?: string
  /** 「这是用量页」的旁证原话。 */
  evidence?: string
  measure?: OpenQuotaMeasure
  value?: number
  unit?: string
  /** 重置那一句的原话(**不折算成时刻** —— 折出来的那个时刻是编的,D13)。 */
  reset?: string
  /**
   * 这一页上**不止一个**用量数字时,每一句的原话(2026-09-26 晚,卡 QG:Antigravity 的
   * 「Models & Usage」上周限额与 5 小时限额各一条,两组模型各一份,一共四条)。
   * 口径与行标签**不归模型**({@link openQuotaSide} / {@link openQuotaLabel}),它只管指出哪几句是数。
   */
  items?: readonly string[]
  reason: string
}

function say(value: unknown, max = 80): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? clip(value, max) : undefined
}

/** 解一行判词。回不出约定的形状就 undefined(当这一轮没判出来,不替它编一个)。 */
export function parseOpenQuotaVerdict(text: string): OpenQuotaVerdict | undefined {
  const raw = firstObject(text)
  if (raw === undefined) return undefined
  const kind = raw.kind
  if (kind !== 'numbers' && kind !== 'unlimited' && kind !== 'none') return undefined
  const value = typeof raw.value === 'number' ? raw.value : typeof raw.value === 'string' ? Number(raw.value.replace(/,/g, '')) : Number.NaN
  const items = Array.isArray(raw.items)
    ? raw.items.map(one => say(one)).filter((one): one is string => one !== undefined).slice(0, OPEN_QUOTA_MAX_ITEMS)
    : undefined
  return {
    kind,
    ...(items === undefined || items.length === 0 ? {} : { items }),
    ...(say(raw.quote) === undefined ? {} : { quote: say(raw.quote) as string }),
    ...(say(raw.evidence) === undefined ? {} : { evidence: say(raw.evidence) as string }),
    ...(isMeasure(raw.measure) ? { measure: raw.measure } : {}),
    ...(Number.isFinite(value) ? { value } : {}),
    ...(say(raw.unit, 12) === undefined ? {} : { unit: say(raw.unit, 12) as string }),
    ...(say(raw.reset) === undefined ? {} : { reset: say(raw.reset) as string }),
    reason: say(raw.reason) ?? '模型没给理由',
  }
}

// ───────────────────────── 采信不采信 ─────────────────────────

/**
 * 认出来的一份读数(判词 + 对回命中之后的那两段原话)。
 * `text` 是数字那一段的原话里**那个数的写法**(「1,234」「38」)—— 界面上照它写,不改成 1234。
 */
export interface OpenQuotaNumbers {
  kind: 'numbers' | 'unlimited'
  measure?: OpenQuotaMeasure
  /** 折算过的数(百分比 0–100;积分 / 次是个数)。 */
  value?: number
  /** 那个数在原话里的写法。 */
  text?: string
  unit?: string
  /** 数字那一段命中(原话 + 是哪条正则)。 */
  quote: WindowTextMatch
  /** 旁证那一段命中。 */
  evidence: WindowTextMatch
  /** 重置那一句的原话(照抄,不折算)。 */
  reset?: string
  /** 这一条那一行叫什么(同窗最近的那一句界面字,原样照抄;卡 QG)。 */
  label?: string
  /** 这一条归哪一组(页面上它上面最近的那一条组名,原样照抄;卡 AG)。 */
  group?: string
  /**
   * 这一页上**另外几条**用量数字(卡 QG:Antigravity 的周限额 / 5 小时限额,两组模型各一份)。
   * 只收百分比那一种 —— 几条不同单位的余额没法比大小,也画不成一行一条横条。
   */
  extra?: readonly OpenQuotaEntry[]
}

/** 一页上多出来的那几条用量数字里的一条(卡 QG)。 */
export interface OpenQuotaEntry {
  measure: 'used_pct' | 'left_pct'
  /** 折算前那个数(原话里的写法在 `text`)。 */
  value: number
  text: string
  label?: string
  /** 归哪一组(卡 AG)。 */
  group?: string
  quote: WindowTextMatch
}

/** 原话里第一个数(「已使用 38%」→ {text:'38', amount:38};「剩 1,234 积分」→ {text:'1,234', amount:1234})。 */
export function firstNumberOf(text: string): { text: string, amount: number } | undefined {
  const hit = /[0-9][0-9,]*(?:\.[0-9]+)?/.exec(text)
  if (hit === null) return undefined
  const amount = Number(hit[0].replace(/,/g, ''))
  return Number.isFinite(amount) ? { text: hit[0], amount } : undefined
}

function sameText(a: string, b: string): boolean {
  return a.trim() === b.trim()
}

const UNLIMITED_WORD = /不限|无限|[Uu]nlimited/

/**
 * 判词可信吗。**三样都要对得上**,差一样就不采信(界面上照旧说读不到 —— D13:宁可读不到,不给假数):
 *
 * 1. `quote` 逐字是这一组命中里的某一段,而且那一段是**数字类**的正则命中的;
 * 2. `evidence` 逐字是这一组里的另一段,而且是**旁证类**、而且够短({@link OPEN_EVIDENCE_MAX_CHARS});
 * 3. 有数时:`measure` 说得清是哪一种、`value` 在范围里,而且**那个数真的出现在 `quote` 那句原话里**
 *    —— 模型把「已使用 38%」读成 83% 这种,在这里就被挡住了。
 */
export function trustOpenQuota(verdict: OpenQuotaVerdict, matches: readonly WindowTextMatch[]):
{ ok: true, numbers: OpenQuotaNumbers } | { ok: false, why: string } {
  if (verdict.kind === 'none') return { ok: false, why: OPEN_QUOTA_NOT_SEEN }
  const quoteText = verdict.quote
  const evidenceText = verdict.evidence
  if (quoteText === undefined || evidenceText === undefined) return { ok: false, why: '判词里没有原话引用,不采信' }
  const quote = matches.find(one => isNumberHit(one) && sameText(one.text, quoteText))
    // 「不限」那一句可能是旁证类那几条正则命中的(「无限制」是整格文字)。
    ?? (verdict.kind === 'unlimited' ? matches.find(one => sameText(one.text, quoteText)) : undefined)
  if (quote === undefined) return { ok: false, why: '判词引的那一句不在这扇窗的命中里,不采信' }
  const evidence = matches.find(one => one !== quote && isEvidenceHit(one) && sameText(one.text, evidenceText))
  if (evidence === undefined) return { ok: false, why: '判词里没有「这是用量页」的旁证,不采信' }
  const reset = verdict.reset === undefined
    ? undefined
    : matches.find(one => sameText(one.text, verdict.reset as string))?.text
  const tail = { quote, evidence, ...(reset === undefined ? {} : { reset }) }
  if (verdict.kind === 'unlimited') {
    // 「不限」也要有原话:别处的「无限制」说的是别的事(同卡 MQ 给 Muse 定的规矩)。
    if (!UNLIMITED_WORD.test(quote.text)) return { ok: false, why: '判词说不限,可原话里没有「不限 / 无限制」,不采信' }
    return { ok: true, numbers: { kind: 'unlimited', ...tail } }
  }
  const measure = verdict.measure
  if (measure === undefined) return { ok: false, why: '判词没说这个数是「已用」还是「还剩」,不采信' }
  const inQuote = firstNumberOf(quote.text)
  if (inQuote === undefined) return { ok: false, why: '判词引的那一句里没有数,不采信' }
  // 模型给的数要与原话里的那个数对得上(给了别的数 = 它在自己算,不采信)。
  if (verdict.value !== undefined && Math.abs(verdict.value - inQuote.amount) > 0.001) {
    return { ok: false, why: '判词里的数与原话里的那个数不一样,不采信' }
  }
  // ★ 已用还是剩余,**照同窗的原话数出来**(卡 QG)—— 模型说的那个 measure 只用来分
  // 「百分比」与「剩多少个」这两种形状,已用 / 剩余以原话为准,数不出来就不采信。
  const side = openQuotaSide(quote, matches)
  if (side === undefined) return { ok: false, why: '同一扇窗上看不出这个数是「已用」还是「剩余」,不采信' }
  const label = openQuotaLabel(quote, matches)
  const group = openQuotaGroup(quote, matches)
  const labelled = { ...(label === undefined ? {} : { label }), ...(group === undefined ? {} : { group }) }
  if (measure === 'left_amount') {
    // 「剩多少个」没有总数:同窗说的要是「已用多少个」,那还剩多少算不出来 —— 不采信。
    if (side !== 'left') return { ok: false, why: '同一扇窗上说的是「已用多少」,没有总数算不出还剩多少,不采信' }
    return {
      ok: true,
      numbers: { kind: 'numbers', measure, value: inQuote.amount, text: inQuote.text, unit: verdict.unit ?? '', ...labelled, ...tail },
    }
  }
  if (inQuote.amount < 0 || inQuote.amount > 100) {
    return { ok: false, why: '判词说是百分比,可原话里那个数不在 0–100 里,不采信' }
  }
  const pick: 'used_pct' | 'left_pct' = side === 'used' ? 'used_pct' : 'left_pct'
  const extra = extraEntries(verdict.items ?? [], matches, [quote, evidence])
  return {
    ok: true,
    numbers: {
      kind: 'numbers',
      measure: pick,
      value: inQuote.amount,
      text: inQuote.text,
      ...labelled,
      ...(extra.length === 0 ? {} : { extra }),
      ...tail,
    },
  }
}

/**
 * 判词 `items` 里**另外那几句**(卡 QG)。每一句照样要**逐字**在这一扇窗的命中里、要是数字类、
 * 要有数、要在 0–100 里;口径与行标签照样是数出来的。对不上的那一句**只丢它自己**,不拦整条
 * —— 主那一条已经过了三道门,不该被多出来的一句拖垮。
 */
function extraEntries(
  items: readonly string[],
  matches: readonly WindowTextMatch[],
  taken: readonly WindowTextMatch[],
): OpenQuotaEntry[] {
  const used = new Set<WindowTextMatch>(taken)
  const out: OpenQuotaEntry[] = []
  for (const text of items) {
    if (out.length >= OPEN_QUOTA_MAX_ITEMS) break
    // 同一页上「100%」常常出现好几次(Antigravity 就是):一句原话认一段命中,认过的不再认。
    const one = matches.find(m => !used.has(m) && isNumberHit(m) && sameText(m.text, text))
    if (one === undefined) continue
    const side = openQuotaSide(one, matches)
    if (side === undefined) continue
    const num = firstNumberOf(one.text)
    if (num === undefined || num.amount < 0 || num.amount > 100) continue
    used.add(one)
    const label = openQuotaLabel(one, matches)
    const group = openQuotaGroup(one, matches)
    out.push({
      measure: side === 'used' ? 'used_pct' : 'left_pct',
      value: num.amount,
      text: num.text,
      ...(label === undefined ? {} : { label }),
      ...(group === undefined ? {} : { group }),
      quote: one,
    })
  }
  return out
}

// ───────────────────────── 认出来之后的自动重读 ─────────────────────────

/** 一句原话的骨架:数字换成 `#`。「已使用 38%」与「已使用 41%」同骨架,「已用完使用额度」不同。 */
export function openQuotaSkeleton(text: string): string {
  return text.trim().replace(/[0-9][0-9,]*(?:\.[0-9]+)?/g, '#')
}

/** 上次认出来的那一份里、重读时要照着再算一遍的几样(不含界面上那一格 —— 那个在 `agentQuota.ts`)。 */
export interface OpenQuotaRecipe {
  kind: 'numbers' | 'unlimited'
  measure?: OpenQuotaMeasure
  unit?: string
  /** 数字那一句:哪条正则命中的、原话的骨架。 */
  quote: { id: string, skeleton: string }
  /** 旁证那一句。 */
  evidence: { id: string, skeleton: string }
  /** 主那一条那一行叫什么(重读时靠它把同骨架的几段分给各行;卡 QG)。 */
  label?: string
  /** 主那一条归哪一组(卡 AG:两组里同名的「Weekly Limit Remaining」靠它分得开)。 */
  group?: string
  /** 这一页上另外那几条(卡 QG)。 */
  extra?: readonly { id: string, skeleton: string, measure: 'used_pct' | 'left_pct', label?: string, group?: string }[]
}

/** 一份读数 → 重读时照它再算的方子。 */
export function openQuotaRecipe(numbers: OpenQuotaNumbers): OpenQuotaRecipe {
  return {
    kind: numbers.kind,
    ...(numbers.measure === undefined ? {} : { measure: numbers.measure }),
    ...(numbers.unit === undefined ? {} : { unit: numbers.unit }),
    ...(numbers.label === undefined ? {} : { label: numbers.label }),
    ...(numbers.group === undefined ? {} : { group: numbers.group }),
    quote: { id: numbers.quote.id, skeleton: openQuotaSkeleton(numbers.quote.text) },
    evidence: { id: numbers.evidence.id, skeleton: openQuotaSkeleton(numbers.evidence.text) },
    ...(numbers.extra === undefined || numbers.extra.length === 0
      ? {}
      : { extra: numbers.extra.map(one => ({
          id: one.quote.id,
          skeleton: openQuotaSkeleton(one.quote.text),
          measure: one.measure,
          ...(one.label === undefined ? {} : { label: one.label }),
          ...(one.group === undefined ? {} : { group: one.group }),
        })) }),
  }
}

/**
 * 按上次的方子**就地再算一遍**(**不叫模型**,卡 QO 第 ③ 条)。
 *
 * 认的是「同一条正则、同一个骨架」:「已使用 38%」变成「已使用 41%」照算(只有数变了);
 * 变成「已用完使用额度」就**不算**(骨架变了 = 那一页说的不是原来那件事),回 undefined ——
 * 调用方据此知道「判词变了」,该再叫一次模型。
 */
export function rereadOpenNumbers(recipe: OpenQuotaRecipe, matches: readonly WindowTextMatch[]): OpenQuotaNumbers | undefined {
  const pool = [...matches]
  /**
   * 同一条正则、同一个骨架的命中在一页上常常有好几段(Antigravity 的四个「100%」/「98%」
   * 都是 `pct` + 骨架 `#%`)。所以按**行标签**认人:标签对得上的那一段才是上次那一行;
   * 标签对不上就按出现顺序拿下一段。认过的从池子里拿走 —— 两行不会认到同一段。
   */
  const take = (id: string, skeleton: string, label?: string, group?: string): WindowTextMatch | undefined => {
    const cands = pool.filter(one => one.id === id && openQuotaSkeleton(one.text) === skeleton)
    if (cands.length === 0) return undefined
    // ★ 卡 AG:认人要**组名 + 行名**一起认 —— Antigravity 一页上「Weekly Limit Remaining」
    // 有两条(Gemini 一条、Claude and GPT 一条),只按行名认就会把两组的数串行。
    const want = label === undefined && group === undefined ? undefined : rowKey(group, label)
    const pick = (want === undefined
      ? undefined
      : cands.find(one => rowKey(openQuotaGroup(one, matches), openQuotaLabel(one, matches)) === want)) ?? cands[0]
    if (pick === undefined) return undefined
    pool.splice(pool.indexOf(pick), 1)
    return pick
  }
  const quote = take(recipe.quote.id, recipe.quote.skeleton, recipe.label, recipe.group)
  if (quote === undefined) return undefined
  const evidence = take(recipe.evidence.id, recipe.evidence.skeleton)
  if (evidence === undefined) return undefined
  const reset = matches.find(one => one.id === 'reset' && one !== quote && one !== evidence)?.text
  const label = openQuotaLabel(quote, matches)
  const group = openQuotaGroup(quote, matches)
  const tail = {
    quote,
    evidence,
    ...(reset === undefined ? {} : { reset }),
    ...(label === undefined ? {} : { label }),
    ...(group === undefined ? {} : { group }),
  }
  if (recipe.kind === 'unlimited') return { kind: 'unlimited', ...tail }
  const measure = recipe.measure
  if (measure === undefined) return undefined
  const inQuote = firstNumberOf(quote.text)
  if (inQuote === undefined) return undefined
  // 口径照旧是**数出来的**(卡 QG)。这一页换了说法(原来写 Usage,现在写 Remaining)=
  // 判词变了 → 回 undefined,让调用方走全套、再叫一次模型。
  const side = openQuotaSide(quote, matches)
  if (side === undefined) return undefined
  if (measure === 'left_amount') {
    if (side !== 'left') return undefined
  }
  else if ((side === 'used' ? 'used_pct' : 'left_pct') !== measure) return undefined
  if (measure !== 'left_amount' && (inQuote.amount < 0 || inQuote.amount > 100)) return undefined
  const extra: OpenQuotaEntry[] = []
  for (const one of recipe.extra ?? []) {
    const hit = take(one.id, one.skeleton, one.label, one.group)
    if (hit === undefined) return undefined
    const itsSide = openQuotaSide(hit, matches)
    if (itsSide === undefined || (itsSide === 'used' ? 'used_pct' : 'left_pct') !== one.measure) return undefined
    const num = firstNumberOf(hit.text)
    if (num === undefined || num.amount < 0 || num.amount > 100) return undefined
    const itsLabel = openQuotaLabel(hit, matches)
    const itsGroup = openQuotaGroup(hit, matches)
    extra.push({
      measure: one.measure,
      value: num.amount,
      text: num.text,
      ...(itsLabel === undefined ? {} : { label: itsLabel }),
      ...(itsGroup === undefined ? {} : { group: itsGroup }),
      quote: hit,
    })
  }
  return {
    kind: 'numbers',
    measure,
    value: inQuote.amount,
    text: inQuote.text,
    ...(recipe.unit === undefined ? {} : { unit: recipe.unit }),
    ...(extra.length === 0 ? {} : { extra }),
    ...tail,
  }
}

// ───────────────────────── 读不到时,卡在哪一步 ─────────────────────────

/**
 * **读不到的时候说清卡在哪一步**(2026-09-27,卡 AG;决策记录里那条通则)。
 *
 * 维护者 10:22 的原话:「**为什么我肉眼都看到额度信息了,但是还说读不到或者读反了**」。
 * 那一刻那一格上只有一句 {@link OPEN_QUOTA_NOT_SEEN} ——「这页上没看见用量」。这句话把**四件完全不同的事**
 * 说成了同一件,而这四件事要他做的下一步各不相同:
 *
 * | 真正卡在哪 | 他该做什么 |
 * |---|---|
 * | 那一页压根没开在任何一扇读得到的窗上(真机 09-27 10:3x:1 扇窗、261 段字、0 命中) | 去打开「Models & Usage」 |
 * | 读到了数,可没有一句「这是用量页」的界面字 | 什么也做不了 —— **是规则该改** |
 * | 认出是用量页,却一个数都没读到 | 同上 |
 * | 这扇窗的命中顶到了壳的段数上限,后面的被挤掉了 | **升级工作台 App** |
 *
 * 所以这里照**数出来的东西**说话:读了几扇窗、几段字、读到了几段带数的字、认出哪几句界面字。
 * 一个字都不编 —— 读到什么就说什么(D13)。
 *
 * ★ **带数的那几段一个字都不往外抄**(隐私,卡 QO 立的那条线):`pct` / `used` 这几条正则命中的
 * 很可能就是**他对话里的一句话**(真机上 Antigravity 那扇聊天窗唯一的命中是
 * 「前 5 秒彻底甩开 99% 的纯软件聊天框项目」)。那一句不该被抄到额度面板上,所以这里**只报几段**。
 * 界面字那几段(`page` / `plan` / `limit` / `group`)照抄 —— 它们按定义是**整格的短界面标签**,
 * 三道门已经把聊天话挡在外面了。
 *
 * 「那扇窗在别的桌面上 / 它这会儿被藏起来了」这两步**不在这里说**:那两句由 `agentQuota.ts` 的
 * `windowUnconnected` 统一补在后面(七家与开集那几家同一句话),在这里再说一遍就重复了。
 */
/** {@link openQuotaMissWhy} / {@link openQuotaMissShort} 要的那几样(同一份,两句话各说长短)。 */
export interface OpenQuotaMiss {
  /** 这一次按窗分好组的命中。 */
  groups: readonly { window: number, matches: readonly WindowTextMatch[] }[]
  /** 壳一共读了几扇窗。 */
  windowCount?: number
  /** 壳一共看了几段文字(正则命中之前的总数)。 */
  textNodes?: number
  /** 模型判了 `none`(而不是压根没轮到模型)。 */
  modelSaidNone?: boolean
}

export function openQuotaMissWhy(input: OpenQuotaMiss): string {
  const all = input.groups.flatMap(one => [...one.matches])
  const numbers = all.filter(isNumberHit)
  const evidence = all.filter(isEvidenceHit)
  const scanned = `读了 ${input.windowCount ?? input.groups.length} 扇窗、看了 ${input.textNodes ?? 0} 段字`
  // 顶到上限 = 后面的命中被挤掉了(卡 QG 读不回组名正是卡在这一步)。这句话**追加**在主句后面:
  // 主句说的是这一轮看见了什么,这一句说的是「你看见的可能还不全」。
  const capped = input.groups.some(one => one.matches.length >= OPEN_SHELL_MAX_MATCHES)
  const tail = capped
    ? `;而且这扇窗的命中顶到了 ${OPEN_SHELL_MAX_MATCHES} 段的上限,后面的被挤掉了 —— 要升级工作台 App`
    : ''
  // 界面字那几段照抄(最多三段);带数的只报几段,**原话一个字不抄**(见上面那一段)。
  const labels = all.filter(one => isEvidenceHit(one) || one.id === OPEN_GROUP_ID)
  const shown = (list: readonly WindowTextMatch[]): string => list.slice(0, 3).map(one => `「${one.text}」`).join('')
  const counted = `${numbers.length} 段带数的字`
  if (input.modelSaidNone === true) {
    const saw = labels.length === 0 ? `${counted}` : `${shown(labels)} 这几句界面字、${counted}`
    return `${scanned},读到了 ${saw},模型判这一页上没有它自己的用量数字${tail}`
  }
  if (numbers.length === 0 && evidence.length === 0) {
    return `${scanned},一条用量数字、一句用量页的界面字都没读到 —— 它显示用量的那一页多半没开着${tail}`
  }
  if (evidence.length === 0) {
    return `${scanned},读到了 ${counted},可这扇窗上没有一句「这是用量页」的界面字(页标题 / 档位 / 上限 / 重置)—— 规则没认出这一页${tail}`
  }
  if (numbers.length === 0) {
    return `${scanned},认出这是用量页(${shown(evidence)}),可一个用量数字都没读到 —— 规则没认出那几个数${tail}`
  }
  return `${scanned},读到了 ${counted}、也认出是用量页(${shown(evidence)}),可这一轮没凑成一条读数${tail}`
}

/**
 * 同一件事的**短说法**(2026-09-27,卡 AG)。
 *
 * 长的那一句进「额度那一行」;短的这一句进**派活确认点的括号**与「读一下」按完那句话 ——
 * 那两处只有一行的地方,摆一整段会把别的字挤没。两句说的是**同一步**,不是两件事。
 */
export function openQuotaMissShort(input: OpenQuotaMiss): string {
  const all = input.groups.flatMap(one => [...one.matches])
  const numbers = all.filter(isNumberHit)
  const evidence = all.filter(isEvidenceHit)
  if (input.groups.some(one => one.matches.length >= OPEN_SHELL_MAX_MATCHES)) return '这扇窗的命中顶到了上限'
  if (input.modelSaidNone === true) return '模型判这页上没有它的用量'
  if (numbers.length === 0 && evidence.length === 0) return '用量那一页没开着'
  if (evidence.length === 0) return '规则没认出这是用量页'
  if (numbers.length === 0) return '规则没认出那几个数'
  return '这一轮没凑成一条读数'
}

// ───────────────────────── 花费(不另起一套记账)─────────────────────────

/**
 * 判一页额度估计花多少(元)。**与登记表判「这是不是 Agent」用同一支尺**
 * (`agentJudge.estimateCallCny`,往高了估),记账也记在登记表那一份每日上限上 —— 卡 QO:
 * 「别另起一套模型调用与记账」。
 */
export function openQuotaEstimate(prompt: string): number {
  return estimateCallCny([...prompt].length, OPEN_QUOTA_MAX_TOKENS)
}
