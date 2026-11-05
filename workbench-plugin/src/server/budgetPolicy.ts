/**
 * **到上限了怎么办:一处规则**(2026-10-02 起;2026-10-04「上限只看钱」重写)。
 *
 * ## 现在的规矩(2026-10-04 维护者拍板,经工作台捎话「开」)
 *
 * 1. **只有钱这一条线**。步数线整条去掉({@link BUDGET_LINE});时间线**保留现状**,
 *    而且做成「去掉它只改一处」的样子 —— 那一处就是 {@link BUDGET_MINUTES_LINE}。
 * 2. **撞线时说清卡在哪**({@link budgetAskLine}):不是光问「要不要继续」,而是
 *    「我在找 X,试了 A、B,还差 C;已经花了 N 元 —— 接着做、停掉这一件?」。
 *    那半句**由事务官自己给**(它最清楚,`POST /butler/item/stuck`),工作台只把它放进这一问里;
 *    它没给就照实说 {@link BUDGET_STUCK_UNKNOWN},**不编**。手机 / 电话 / 电脑三处问的是同一句
 *    (三处都读 `OuterAsker` 挂的那一问,而那一问的正文只在这个函数里生成)。
 * 3. **撞线的事记下来**:每次撞线往现成的那本任务账上追一条(`jobLog.ts` 的 `budget_stop`),
 *    同一类事反复撞线就在日结里提一句({@link budgetRepeatLine})。**不自动调高线**。
 *
 * ## 为什么去掉步数线(10-04 早那次事故,事项 `t-63a9291b`)
 *
 * 维护者在手机上让事务官发一份文件。第一轮它花 14 步去 grep 工作台源码找「怎么把文件发到手机上」,
 * 第 15 步撞上 `BUTLER_STEP_LIMIT = 15` 停了;她点继续 → 30 步,又撞;再点 → 45 步才办完。
 * **钱远没到,是步数线先到的**(事件流 `scratchpad/butler-file-session.jsonl` seq 92 / 170 / 171:
 * turn 1 停在 step 15,turn 2 又停在 step 15)。她看到的就是「中间阻塞了两次」。
 *
 * 这与 10-02 运营同学(Air)的原话是同一件事:
 *
 * > 「他会经常播报消耗额度(比如 10 分钟跑了多少步到达上限,20 分钟跑了多少步到达上限),
 * >   并询问是否继续。我觉得这个过程比较多余,就是他每一步设置得太细了。」
 *
 * 而维护者 09-23 早已说过尺子是什么:
 *
 * > 「用户不在乎一通电话花了多少 Tokens,只在乎花了多少钱」
 *
 * 10-02 那张「撞的全是步数线」的账(诊断包 `工作台诊断包-20261002-112711`:三件事 15/15、45/45、15/30 步,
 * 钱分别只用掉 0.127 / 0.295 / 0.083 元)在 `docs/交接-1002-语音交代慢与老问上限.md` 第一节 ——
 * 两天两份证据指的是同一件事,所以这一版不是再调一次配置,是把那条线拿掉。
 *
 * 步数是**我们的**内部度量,不是她的度量;它跟她要付的钱不是一回事(便宜模型跑 45 步也许两毛钱)。
 * 止损这件事本身留着 —— 留的是**钱**那条线。09-28 卡 BS2 当初加步数线是为了止损
 * (`docs/设计-事务官做什么不做什么与思考分档-2026-09-28.md` 第五节第 2 条),
 * 这一版把那个目的交还给钱那条线,**而不是把它调高**(调高就是打补丁,10-02 维护者已经否过一次)。
 *
 * ## 10-02 那一半留着 / 改掉的
 *
 * - **留着**:自动续那一套**没有**回来(`AUTO_EXTEND_MAX` / `autoExtend` 10-02 已全删)。到了真停、问一句。
 * - **改掉**:10-02 定的「问她那一句不念消耗额度」里的**钱**那一项,10-04 由维护者改口 ——
 *   这一问里**要**有「已经花了 N 元」(她在乎的正是这个数)。分钟与步数照旧不念:
 *   分钟是另一条线、步数这一版已经不存在了。
 *
 * **这个文件只有纯函数**,没有时钟、没有 I/O:真停是 `itemBudget.ts` 那一侧的事。
 */

/** 给人看的钱:到分(「0.52」)。**问她那一句与卡上那一句同一个写法**。 */
export function yuan(value: number): string {
  return value < 0.01 && value > 0 ? '不到 0.01' : value.toFixed(2)
}

/**
 * 还剩几条线。2026-10-04 起**步数不在里面了**(整条去掉,不是调高);
 * `time` 这一条由 {@link BUDGET_MINUTES_LINE} 一处开关。
 */
export type BudgetLine = 'money' | 'time'

/** 账上与交接里怎么称这条线(断言照这张表,不逐字抄中文)。 */
export const BUDGET_LINE_TITLES: Readonly<Record<BudgetLine, string>> = {
  money: '钱',
  time: '时间',
}

/**
 * **时间那条线还在吗**(2026-10-04:维护者只拍了「去掉步数线」,时间线**保留现状**,
 * 去不去留在待拍板里 —— `docs/决策记录.md` 10-04 那一节)。
 *
 * 要去掉它:**把这一个值改成 `false`**,别的一个字都不用动
 * (`itemBudget.budgetVerdict` 只在这一处读它;卡面与问话那几句都是按「有没有判出来」现拼的)。
 * 类型写成 `boolean` 而不是字面量 `true`,就是为了那一天改这一个字不会连带报一串「这个条件恒真」。
 */
export const BUDGET_MINUTES_LINE: boolean = true

/**
 * 事务官没说卡在哪时,那一问里照实写的半句(**不编一个原因**,同 D13)。
 *
 * 它该说的时候会说:技能里写了「撞线之前把卡在哪报一句」(`POST /butler/item/stuck`)。
 * 没报就是没报 —— 让她看见「它没说」,比替它编一句「正在处理」有用。
 */
export const BUDGET_STUCK_UNKNOWN = '它没说卡在哪'

export interface BudgetAskInput {
  /** 她那件事的标题。 */
  title: string
  /** 「换 X 来做」那一家;缺席 = 这会儿没有能换的。 */
  candidateTitle?: string
  /** 事务官自己报的「我在找 X,试了 A、B,还差 C」;缺席 = 它没说。 */
  stuck?: string
  /** 到这一刻花了多少元;缺席 = 还没算出来(不写 0)。 */
  spentCny?: number
}

/**
 * **问她那一句**(手机 / 电话 / 电脑三处同一句)。
 *
 * 形状照维护者 10-04 的话:「不是光问要不要继续,而是一句人话:我在找 X,试了 A、B,还差 C;
 * 已经花了 N 元」。所以这一句里有三样:**卡在哪**(事务官给的,没给就照实说)、
 * **已经花了多少钱**(她在乎的那个数)、**让她挑**(接着做 / 停掉 / 换一家)。
 *
 * 分钟与步数不进这一句:步数这一版不存在了,分钟是另一条线(她 10-02 说过「每一步设置得太细」)。
 */
export function budgetAskLine(input: BudgetAskInput): string {
  const stuck = input.stuck === undefined || input.stuck.trim() === '' ? BUDGET_STUCK_UNKNOWN : input.stuck.trim()
  const money = input.spentCny === undefined ? '花了多少还没算出来' : `已经花了 ${yuan(input.spentCny)} 元`
  const tail = input.candidateTitle === undefined ? '' : `,还是换 ${input.candidateTitle} 来做`
  return `「${input.title}」这件先停下来了 —— ${stuck};${money}。接着做、停掉这一件${tail}?`
}

// ───────────────────────── 同一类事反复撞线 ─────────────────────────

/**
 * 几次算「反复」(2026-10-04 第 3 条)。**到了只提一句,不自动调高线** ——
 * 维护者的话是「缺一个正规做法」:该补的是那类事的做法,不是那条线的数。
 */
export const BUDGET_REPEAT_MIN = 3

/** 账上那一条撞线记录里,日结要数的那两格。 */
export interface BudgetStopRecord {
  /** 哪类事(`JobKind`:`code` 写代码 / `chat` 聊天问答 / `desk` 要在她电脑上动手)。数不出来就缺席。 */
  kind?: string
  /** 撞的哪条线。 */
  line?: BudgetLine
}

/** 这几类事的念法(同 `protocol.JOB_KIND_TITLES`;这里不 import protocol,只认得出就行)。 */
const KIND_TITLES: Readonly<Record<string, string>> = {
  code: '写代码 / 改文件',
  chat: '聊天 / 问答',
  desk: '要在你电脑上动手',
}

/**
 * 日结 / 早报里那一句(2026-10-04 第 3 条)。**数出来的**:同一类事撞线 ≥ {@link BUDGET_REPEAT_MIN} 次才说。
 * 一次都不够就回 `undefined`(整句缺席,不写「今天没撞线」—— 那是另一句话,日结别处已经有)。
 *
 * `kind` 数不出来的那几条**不并成一类**:不知道是哪类事,就说不出「这类事缺一个正规做法」。
 */
export function budgetRepeatLine(stops: readonly BudgetStopRecord[], min = BUDGET_REPEAT_MIN): string | undefined {
  const counts = new Map<string, number>()
  for (const one of stops) {
    if (one.kind === undefined || one.kind === '') continue
    counts.set(one.kind, (counts.get(one.kind) ?? 0) + 1)
  }
  const hot = [...counts.entries()]
    .filter(([, count]) => count >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (hot.length === 0) return undefined
  const parts = hot.map(([kind, count]) => `${KIND_TITLES[kind] ?? kind}(${count} 次)`)
  return `这类事常撞线,缺一个正规做法:${parts.join('、')}`
}
