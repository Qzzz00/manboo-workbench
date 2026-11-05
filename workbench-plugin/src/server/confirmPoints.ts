/**
 * 接需求先给确认点(2026-09-23,维护者 13:05 定)。
 *
 * 他的原话:
 *
 * > 「不只是这张卡的问题,是如果后面这种自然语言需求的传递都会被曲解,那么用户的体验
 * > 会非常差,这里最好是能当场给一些确认的点,不能假装自己搞懂了。」
 *
 * 当天的例子:他在电话里说「把音色改成可配置、通话中能改」,一路传下来被做成了
 * 「念三个名字让他挑」;他的本意是「他模糊描述、或者她播一段样音,**她去库里挑**」。
 * 中间没有任何一处停下来问一句 —— 所以那一处曲解一直走到了实现。
 *
 * ## 这个文件是什么
 *
 * 「确认点生成规则」的**唯一定义处**。三个入口(需求卡「梳理」、选题卡「构思」、
 * 通话里那几件工具)都从这里拿同一份确认点,**不各写一份**:
 * 三份规则一定会漂,而"她问了哪几件"正是这条规矩里唯一说得清的部分。
 *
 * 一行 I/O 都没有 —— 用例直接对着字符串断言。
 *
 * ## 规则(维护者 13:05 逐条)
 *
 * | 需求像哪一类 | 问哪三件 |
 * |---|---|
 * | **交互** | 用户怎么触发 / 看到什么 / 说不清时怎么办 |
 * | **数据** | 从哪来 / 多久一次 / 没数据时显示什么 |
 * | **动作** | 谁执行 / 失败怎么办 / 要不要二次确认 |
 *
 * 外加**一条必有的**:「怎么算做完」(验收)。子事项的验收标准就是从它生成的。
 *
 * **按需求类型挑 2–4 条,不许全问**(逐字)。一口气问八条与不问是同一种失败:
 * 他会只答最后一条。
 *
 * ## 三条分寸
 *
 * 1. **每条都带「她的默认理解」**。只问不答等于把活推回给他;带上默认理解之后,
 *    他可以只说「第二条不对」,别的默认就算数 —— 这是他要的「哪条不对说一下,都对就开工」。
 * 2. **确认点必须是会影响做法的分歧点**,不是复述废话。所以规则里写的是
 *    「用户怎么触发」而不是「你是想做一个音色功能对吗」。
 * 3. **他没答之前不派活**。这个文件只生成与成形,"不派活"由调用方按 `confirmed` 执行
 *    (需求卡在提示词里,通话里在工具的那道门上)。
 */

// ───────────────────── 只在这四类事上问她(2026-10-04) ─────────────────────

/**
 * ★ **只在这四类事上问她**(2026-10-04,卡 `claude/three-small-1004`;维护者点头)。
 *
 * 维护者原话:「别拿细枝末节来问我拍板」「总抛些无关紧要的给我拍版,你和事务官一个毛病」。
 * 运营同学 10-02 独立反馈同一个病:「频繁询问是否继续……每一步设置得太细了」。
 *
 * 从前这件事只说了**怎么问**(拿不准才问、一次只问一件、不复述),没说**问什么** ——
 * 于是「拿不准」被当成了「凡有分歧就问」,实现细节、默认值、要不要记一笔全摆到她面前。
 * 这四类是**问她的全集**:之外的一律自己定、照做、事后一句话说定了什么。
 *
 * 为什么是这四类:它们的共同点是**答案只有她知道,或者代价只有她能承担** ——
 * 改她的习惯只有她说得清、钱和额度是她的、对外的话收不回来、要她亲手做的事别人做不了。
 * 剩下的(用哪个默认值、文件叫什么名、记不记一笔)**答错了能改**,所以不值一次打扰。
 *
 * ## 这一条与已有那三道门各管什么(都不冲突,管的不是同一件事)
 *
 * | 哪一样 | 管什么 | 谁按下那一下 |
 * |---|---|---|
 * | **这一条**(只问四类) | 事务官**主动开口问她**之前,先看这一问属不属于那四类 | 事务官自己 |
 * | **「先问我」档**(`composer.MODE_LINES.ask`) | 这一件事**要不要派给别家 / 动她的文件**时先对一句 | 她选的档 |
 * | **派活闸**(`composer.createApprovalBroker` + 外层那张卡) | 派出去之前**界面上**那一下点头 | 她在卡上点 |
 * | **上限问话**(`budgetPolicy`) | 钱撞线了停下来问「接着做 / 停掉 / 换一家」 | 她答那一问 |
 *
 * 后三样都是**工作台**替她设的闸(她自己开的档、界面上的一下、撞线停住),
 * 这一条管的是**事务官嘴里那一问**。上限问话本来就落在「要花钱或额度」这一类里 ——
 * 同一个判据的两种形式,不是两条规矩。
 *
 * ## 与她自己规矩表里那一条不重复叠加
 *
 * 她本人会在规矩表里留一条同义的(「别拿细枝末节来问我」,由她亲口交给事务官 ——
 * 规矩表只认她 / 事务官 / 工作台按证据算)。那一条与这一条是**同一条**,不是两条:
 * AGENTS.md 里规矩段与技能段是并列写进去的(`hooksApply.wbSkillMergeInto`),
 * 两段各有一句同义的话时**照一条办**,不许为同一件事问两遍、也不许在回话里念两遍。
 * 写在技能正文里(`docs/技能/需求确认点.md`)—— **不去动用户那一层**:规矩表是她的,我们不删不改。
 */
export const ASK_ONLY_FOUR_KINDS: readonly string[] = [
  '改她的使用习惯(她平时怎么用、以后都照哪个样子来)',
  '要花钱,或者要用掉额度',
  '对外怎么说(发布、发消息给别人、对外的口径)',
  '要她亲手做的事(登录、付款、验证码、给凭据)',
]

/** 自己定、不问她的那几样(举的是例子,**不是穷举** —— 凡不在四类里的都归这一档)。 */
export const ASK_SELF_DECIDE_EXAMPLES: readonly string[] = [
  '实现细节(用哪个办法、文件叫什么名、放在哪个目录)',
  '默认值(先按最可能的那个来)',
  '要不要记一笔(记忆、交接、日志)',
]

/**
 * 那四类拼成的一句话。`who` 是称呼(电话人设里用她的称呼,别处用「她」)。
 *
 * **断言用这个函数,不逐字抄中文**(AGENTS.md 的规矩):这一句的字只有一处定。
 */
export function askOnlyFourKindsLine(who = '她'): string {
  return `**只在这四类事上问${who}**:${ASK_ONLY_FOUR_KINDS.join(';')}。`
}

/** 另外那半句:四类之外自己定、照做、事后一句话说定了什么。 */
export function askSelfDecideLine(who = '她'): string {
  return `**此外一律自己定、照做** —— ${ASK_SELF_DECIDE_EXAMPLES.join('、')}这一类不要问${who}`
    + `,事后一句话告诉${who}定了什么。`
}

/** 两句连起来(事项第一条消息、技能正文、电话人设用的都是它)。 */
export function askOnlyFourKindsBlock(who = '她'): readonly string[] {
  return [askOnlyFourKindsLine(who), askSelfDecideLine(who)]
}

/** 需求像哪一类。**只有三类**,认不出就走兜底那一组(见 {@link FALLBACK_RULES})。 */
export type NeedKind = '交互' | '数据' | '动作'

export const NEED_KINDS: readonly NeedKind[] = ['交互', '数据', '动作']

/**
 * 一条确认点。
 *
 * `ask` 是问他的那一句;`guess` 是**她的默认理解** —— 他不答就按这个做,
 * 所以它必须是一个真能照着做的说法,不是「待定」。
 */
export interface ConfirmPoint {
  /** 问他的那一句(会影响做法的分歧点)。 */
  ask: string
  /** 她的默认理解。他不纠正就按这个做。 */
  guess: string
  /** 这条来自哪一类规则。`验收` 那条永远在最后。 */
  kind: NeedKind | '验收'
  /** 他答的那一句(还没答时缺席)。**不代他填**。 */
  answer?: string
}

/**
 * 认类型用的词。**一个需求可以同时像两类**(「把音色改成可配置、通话中能改」
 * 既是交互也是动作),那时两类的规则都进候选,再按 {@link CONFIRM_POINT_MAX} 截断。
 *
 * 判据只看他那句话里的字 —— 不交给模型:模型每次判得不一样,
 * 而「她问了哪几件」必须是一件说得清、复得现的事。
 */
export const NEED_KIND_WORDS: Readonly<Record<NeedKind, readonly string[]>> = {
  交互: [
    '点', '按钮', '界面', '页面', '屏', '卡片', '弹', '显示', '看到', '选', '挑',
    '配置', '可配', '开关', '设置', '输入', '填', '拖', '说', '语音', '通话', '电话', '样音', '试听',
  ],
  数据: [
    '数据', '统计', '报表', '数字', '指标', '同步', '采集', '抓', '拉取', '刷新',
    '列表', '来源', '接口', '多久', '缓存', '历史', '记录条', '日志',
  ],
  动作: [
    '派', '派单', '发', '送', '删', '改', '写', '执行', '跑', '合并', '部署', '发版',
    '下单', '自动', '定时', '通知', '提醒', '重启', '导出', '上传', '下载', '换',
  ],
}

/** 一类规则里那三条(维护者 13:05 逐字)。 */
export const CONFIRM_POINT_RULES: Readonly<Record<NeedKind, readonly ConfirmPoint[]>> = {
  交互: [
    { kind: '交互', ask: '他从哪儿触发这件事', guess: '在他此刻正看着的那一处直接说 / 直接点,不新开一个入口' },
    { kind: '交互', ask: '触发之后他看到什么', guess: '当场看到结果本身,不是一句「已提交」' },
    { kind: '交互', ask: '他说不清楚的时候怎么办', guess: '她照他那句模糊的描述自己挑一个,并说清为什么挑它' },
  ],
  数据: [
    { kind: '数据', ask: '这些数从哪儿来', guess: '从这台机器上已经有的那一份来,不新接一个外部来源' },
    { kind: '数据', ask: '多久取一次', guess: '他看的时候现取一次,不后台常驻扫' },
    { kind: '数据', ask: '没有数的时候显示什么', guess: '明写「还没有」,不显示 0 也不留空' },
  ],
  动作: [
    // 2026-10-02(与 09-28「事务官自己不干活」、base-086「desk 按能力选家」同一条):默认派出去。
    { kind: '动作', ask: '这件事派给谁', guess: '按这台机器上各家的能力挑一家派出去,不自己办' },
    { kind: '动作', ask: '做失败了怎么办', guess: '当场如实说没成,并说清卡在哪一步,不重试不掩盖' },
    { kind: '动作', ask: '动手之前要不要再问他一句', guess: '不可逆的那一步要问一句,别的直接做' },
  ],
}

/**
 * 三类都不像时的候选。**不是"没有确认点"** —— 一句谁也归不了类的需求,
 * 最该问的恰恰是范围与归属。
 */
export const FALLBACK_RULES: readonly ConfirmPoint[] = [
  { kind: '动作', ask: '这件事派给谁、动的是哪一处', guess: '按各家的能力挑一家派出去,动的是工作台这一处,不牵别的' },
  { kind: '交互', ask: '这一版要做到哪儿为止', guess: '先做最小的一条能用的路,别的留到下一版' },
]

/** 必有的那一条,**永远排最后**。子事项的验收标准从它生成。 */
export const ACCEPTANCE_POINT: ConfirmPoint = {
  kind: '验收',
  ask: '怎么算做完',
  guess: '他照着走一遍、结果跟他说的一样,就算做完',
}

/** 一次最多几条(维护者:2–4 个,**不许全问**)。 */
export const CONFIRM_POINT_MAX = 4
/** 一次最少几条:一条分歧点 + 验收。少于这个就不成其为"确认"。 */
export const CONFIRM_POINT_MIN = 2
/**
 * 电话里最多念几条。
 *
 * ——— 2026-10-02 从 3 改成 1(卡「电话里像个活人」)———
 *
 * 09-23 维护者定的是「最多念 3 条、每条一句」;Air 那几通量出来的后果是
 * 「要你确认三点 / 跟你核三条」**8 次**,连「让豆包查个天气」也过一遍。
 * 她的原话:「太啰嗦了,我只是提交了一个简单的事情……念了一遍经书」。
 *
 * 规矩没变(澄清环节在不可改清单上):**拿不准才问**。变的是一次问几件 ——
 * 电话里只问**最要紧的那一条**。卡面上那一段({@link formatConfirmBlock})不受这一条管:
 * 屏幕上的列表看得过来,嘴里念不过来。
 */
export const CONFIRM_POINT_SPOKEN_MAX = 1

/**
 * 这句需求像哪几类。**按 {@link NEED_KINDS} 的顺序回**,一个都不像回空数组。
 *
 * 只数命中了几个词、不算权重:一句需求里出现「按钮」就是交互的事,
 * 出现两次也还是同一件事。
 */
export function classifyNeed(text: string): NeedKind[] {
  const said = typeof text === 'string' ? text : ''
  if (said.trim() === '') return []
  return NEED_KINDS.filter(kind => NEED_KIND_WORDS[kind].some(word => said.includes(word)))
}

/**
 * 按这句需求挑 2–4 条确认点,**最后一条永远是「怎么算做完」**。
 *
 * 挑法:命中的每一类**先各出第一条**,再回头补第二条、第三条 —— 一个需求同时像两类时,
 * 「用户怎么触发」和「失败怎么办」都该问到,而不是把交互那三条占满。
 *
 * `max` 收在 {@link CONFIRM_POINT_MIN}…{@link CONFIRM_POINT_MAX} 之间:
 * 问八条与不问是同一种失败(他会只答最后一条)。
 */
/**
 * 「这件事谁去执行」那两条的**默认理解要看派给谁**(2026-09-27,卡 MS)。
 *
 * 21:23 那一通他说「找豆包,让他把这几天我跟他聊的内容总结一下」,电话里念给他的确认点是
 * 「这件事归谁办、动的是哪一处(我先按『事务官自己办,动的是工作台这一处』理解)」——
 * 他点名的是豆包,这三条模板一条都不对。
 *
 * 只换这一条的说法,别的一个字不动;没点名(`who` 缺席)时行为与 09-27 之前一字不差。
 */
// 2026-10-02:这两句改成了「派给谁」(事务官不自己干活),旧写法留在表里 —— 旧卡上存着的是旧句子。
const EXECUTOR_ASKS: readonly string[] = [
  '这件事派给谁', '这件事派给谁、动的是哪一处',
  '这件事谁去执行', '这件事归谁办、动的是哪一处',
]

export function pointForWho(point: ConfirmPoint, who: string | undefined): ConfirmPoint {
  const name = who?.trim() ?? ''
  if (name === '' || !EXECUTOR_ASKS.includes(point.ask)) return point
  return { ...point, ask: '这件事派给谁', guess: `派给 ${name} 做,我只跟进、回了告诉你` }
}

export function buildConfirmPoints(input: { need: string, max?: number, who?: string }): ConfirmPoint[] {
  const want = Math.max(CONFIRM_POINT_MIN, Math.min(input.max ?? CONFIRM_POINT_MAX, CONFIRM_POINT_MAX))
  const kinds = classifyNeed(input.need)
  const pools = kinds.length === 0
    ? [FALLBACK_RULES]
    : kinds.map(kind => CONFIRM_POINT_RULES[kind])

  const picked: ConfirmPoint[] = []
  const room = want - 1 // 留给验收那一条
  for (let round = 0; picked.length < room; round += 1) {
    let addedThisRound = false
    for (const pool of pools) {
      if (picked.length >= room) break
      const one = pool[round]
      if (one === undefined) continue
      picked.push(pointForWho({ ...one }, input.who))
      addedThisRound = true
    }
    if (!addedThisRound) break
  }
  // 兜底那一组也可能被 max 压到 0 条:至少留一条分歧点,否则「确认」只剩验收一句。
  if (picked.length === 0) picked.push(pointForWho({ ...(pools[0]?.[0] ?? FALLBACK_RULES[0] as ConfirmPoint) }, input.who))
  picked.push({ ...ACCEPTANCE_POINT })
  return picked
}

/** 那几条里有没有验收那一条。**必须有** —— 用例拿它钉着。 */
export function hasAcceptancePoint(points: readonly ConfirmPoint[]): boolean {
  return points.some(one => one.kind === '验收')
}

/** ①②③④。超过四条用「(5)」这种写法,不至于拼出一个看不懂的符号。 */
const CIRCLED = ['①', '②', '③', '④'] as const

export function circledIndex(index: number): string {
  return CIRCLED[index] ?? `(${index + 1})`
}

/**
 * **固定形状**(维护者 13:05 逐字)。三个入口出的都是这一段,一个字不差:
 *
 * ```
 * 我理解的是:<一句>。
 * 要确认的:
 * ① <问他的那一句>(我先按「<她的默认理解>」理解)
 * ② …
 * 哪条不对说一下,都对就开工。
 * ```
 *
 * 为什么把默认理解写进去:只问不答等于把活推回给他。带上默认理解之后他可以
 * 只说「第二条不对」,别的就算数。
 */
export function formatConfirmBlock(input: {
  understanding: string
  points: readonly ConfirmPoint[]
}): string {
  const lines = [`我理解的是:${input.understanding.trim()}。`, '要确认的:']
  input.points.forEach((one, index) => {
    lines.push(`${circledIndex(index)} ${one.ask}(我先按「${one.guess}」理解)`)
  })
  lines.push('哪条不对说一下,都对就开工。')
  return lines.join('\n')
}

/**
 * 电话里念的那一段(维护者第 4 条:**最多念 3 条、每条一句**)。
 *
 * 与 {@link formatConfirmBlock} 的差别只有两处:条数上限、以及不带括号
 * —— 括号在嘴里念出来是一串听不懂的停顿,所以默认理解改成「我先按…来」接在后面。
 */
export function spokenConfirmBlock(input: {
  understanding: string
  points: readonly ConfirmPoint[]
}): string {
  const few = input.points.slice(0, CONFIRM_POINT_SPOKEN_MAX)
  /*
   * ——— 2026-10-02:只念一条、而且不复述(卡「电话里像个活人」)———
   *
   * 以前这一段是「我理解的是:<她刚说的那句话>。要确认的:① … ② … ③ …
   * 哪条不对说一下」。三处毛病,逐条量过(docs/分析-和事务官说话为什么费劲-2026-10-02.md):
   *   · **复述**:她刚说完,她知道自己说了什么 —— 复述只是把时间还给她;
   *   · **列条**:①②③ 念出来是一串听不懂的停顿;
   *   · **三条**:她要的是「那一个会改做法的点」,不是一张表。
   *
   * 现在就一句:**那一个点 + 我按什么做**。她答一声就开工,不答也能开工。
   */
  const one = few[0]
  if (one === undefined) return `${input.understanding.trim()},我这就去办。`
  return `${one.ask}?我按「${one.guess}」办。`
}

/* ──────────────────────── 简单的事:只确认一句 ──────────────────────── */

/**
 * **一句话说得清的打听**(2026-09-28,卡 CF 第 6 条)。
 *
 * 维护者第二通电话:「太啰嗦了,我只是提交了一个简单的事情,确认一次……念了一遍经书」。
 * 那件事是「让豆包工作帮我查一下国庆节放几天假」—— 点了名、要的是一个数,
 * 而她念的是「这件事归谁办、动的是哪一处」「这一版要做到哪儿为止」「怎么算做完」。
 * 三条确认点是为**含糊或者要动东西的活**造的(卡 13:05 那天的例子是「把音色改成可配置」),
 * 拿来问「国庆放几天」就是念经。
 *
 * 判据三条,**全都要满足**(判据在代码里,不交给模型 —— 「她问了几条」必须复得现):
 * 1. **他点了名**(`who`):谁办这件事已经没有分歧;
 * 2. **话短**(≤ {@link SIMPLE_ERRAND_MAX_CHARS} 字):一句话;
 * 3. **是打听、不是动手**:命中打听词,且**一个动手词都没有**。
 */
export const SIMPLE_ERRAND_MAX_CHARS = 40

/** 打听:要一个答案、一个数、一句话。 */
const LOOKUP_WORDS: readonly string[] = [
  '查', '问', '看一下', '看看', '搜', '找一下', '打听', '几天', '几号', '多少', '多久', '是不是', '怎么走', '天气', '汇率', '翻译',
]

/** 动手:要改东西、要做出来 —— 这一类照旧过三条。 */
const DOING_WORDS: readonly string[] = [
  '改', '加', '做个', '做一个', '开发', '实现', '写个', '写一个', '删', '导出', '部署', '发版', '上线', '重构',
  '合并', '提交', '下单', '买', '发给', '发到', '通知', '定时',
]

export function isSimpleErrand(input: { need: string, who?: string }): boolean {
  const said = typeof input.need === 'string' ? input.need.trim() : ''
  const who = input.who?.trim() ?? ''
  if (said === '' || who === '') return false
  if ([...said].length > SIMPLE_ERRAND_MAX_CHARS) return false
  if (DOING_WORDS.some(word => said.includes(word))) return false
  return LOOKUP_WORDS.some(word => said.includes(word))
}

/**
 * 简单那一档念的**一句**确认(维护者给的样子:「让豆包工作查国庆放几天,对吧?」)。
 * 他那句话里已经带着那一家的名字时不再说一遍 —— 电话里重复一个名字听起来像没听懂。
 */
export function spokenSimpleConfirm(input: { understanding: string, who?: string }): string {
  const said = input.understanding.trim().replace(/[。.!!??]+$/u, '')
  const who = input.who?.trim() ?? ''
  const head = who === '' || said.includes(who) ? said : `让 ${who} ${said}`
  return `${head},对吧?对我就开工。`
}

/* ──────────────────────── 产物里那一节 ──────────────────────── */

/** 顶部那一节叫什么。`需求.md` 与 `框架.md` 用的是**同一个名字**。 */
export const CONFIRM_SECTION_TITLE = '确认点'
/** 验收标准那一节叫什么。由确认点生成,**不是她另写一份**。 */
export const ACCEPTANCE_SECTION_TITLE = '验收标准'

/**
 * 顶部那一节的正文。
 *
 * 没确认时第一行就写着「**未确认 —— 没答之前不派活**」:这张卡被人半路接手时,
 * 一眼看得出还不能往下走。
 */
export function formatConfirmSection(input: {
  points: readonly ConfirmPoint[]
  confirmed: boolean
  at?: string
  /** 他改了哪几条(序号从 1 起)。空 = 他说「都对」。 */
  changed?: readonly number[]
}): string {
  const lines = [`## ${CONFIRM_SECTION_TITLE}`, '']
  if (input.confirmed) {
    const when = input.at === undefined || input.at.trim() === '' ? '' : `(${input.at.trim()})`
    const changed = input.changed === undefined || input.changed.length === 0
      ? '他说都对。'
      : `他改了第 ${input.changed.map(one => circledIndex(one - 1)).join('、')} 条。`
    lines.push(`> **已确认**${when} —— ${changed}`)
  }
  else {
    lines.push('> **未确认** —— 他还没逐条答。**没答之前不派活。**')
  }
  lines.push('')
  input.points.forEach((one, index) => {
    lines.push(`${index + 1}. ${one.ask}`)
    lines.push(`   - 我的默认理解:${one.guess}`)
    lines.push(`   - 他说:${one.answer === undefined || one.answer.trim() === '' ? '(还没答)' : one.answer.trim()}`)
  })
  return `${lines.join('\n')}\n`
}

/**
 * 验收标准那一节。**从确认点生成**(维护者第 3 条:「子事项的验收标准从确认点生成」)。
 *
 * 每条确认点出一行:他答了就用他那句,没答就用她的默认理解 —— 后者也要写出来,
 * 否则「按默认做」这件事没有留痕,半年后没人说得清当时默认的是什么。
 */
export function acceptanceLines(points: readonly ConfirmPoint[]): string[] {
  return points.map((one) => {
    const said = one.answer === undefined || one.answer.trim() === '' ? undefined : one.answer.trim()
    return said === undefined ? `${one.ask}:${one.guess}(按默认)` : `${one.ask}:${said}`
  })
}

export function formatAcceptanceSection(points: readonly ConfirmPoint[]): string {
  const lines = [`## ${ACCEPTANCE_SECTION_TITLE}`, '', `> 由${CONFIRM_SECTION_TITLE}生成,一条确认点一行。`, '']
  for (const line of acceptanceLines(points)) lines.push(`- ${line}`)
  return `${lines.join('\n')}\n`
}

/** 一份产物里 `## <标题>` 那一节的正文(含标题行)。没有回 undefined。 */
export function sectionOf(text: string, title: string): string | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === `## ${title}`)
  if (start < 0) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if ((lines[i] as string).startsWith('## ')) { end = i; break }
  }
  return `${lines.slice(start, end).join('\n').trimEnd()}\n`
}

/**
 * 把一节**放到顶部**(已经有同名的就原地换掉)。
 *
 * 三档:
 * 1. 已经有 `## <标题>` → 原地换,**别的一个字不动**(同 `wbSkillApply` 的分寸:段外不动);
 * 2. 还没有、但有别的 `## ` → 插在**第一个 `## ` 之前**(于是它是第一节 = 顶部);
 * 3. 一个二级标题都没有 → 整段放在最前面。
 *
 * 为什么不是"插在文件第一行":`需求.md` 第一行通常是 `# <需求名>`,
 * 把确认点塞在标题之上会让这份文件读起来像是两份东西拼的。
 */
export function upsertSection(text: string, title: string, section: string): string {
  const body = section.endsWith('\n') ? section : `${section}\n`
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === `## ${title}`)
  if (start >= 0) {
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if ((lines[i] as string).startsWith('## ')) { end = i; break }
    }
    const before = lines.slice(0, start).join('\n')
    const after = lines.slice(end).join('\n')
    return `${before}${before === '' ? '' : '\n'}${body}${after === '' ? '' : `\n${after}`}`
  }
  const first = lines.findIndex(line => line.startsWith('## '))
  if (first >= 0) {
    const before = lines.slice(0, first).join('\n').trimEnd()
    const after = lines.slice(first).join('\n')
    return `${before === '' ? '' : `${before}\n\n`}${body}\n${after}`
  }
  const trimmed = text.trimEnd()
  return trimmed === '' ? body : `${trimmed}\n\n${body}`
}

/** 把确认点与验收标准两节都放进这一份产物(顺序:确认点在前)。 */
export function applyConfirmSections(input: {
  text: string
  points: readonly ConfirmPoint[]
  confirmed: boolean
  at?: string
  changed?: readonly number[]
}): string {
  const withConfirm = upsertSection(input.text, CONFIRM_SECTION_TITLE, formatConfirmSection({
    points: input.points,
    confirmed: input.confirmed,
    ...(input.at === undefined ? {} : { at: input.at }),
    ...(input.changed === undefined ? {} : { changed: input.changed }),
  }))
  // 还没确认时**不写验收标准** —— 一份按默认理解编出来的验收标准会被当成他定过的。
  if (!input.confirmed) return withConfirm
  return upsertSection(withConfirm, ACCEPTANCE_SECTION_TITLE, formatAcceptanceSection(input.points))
}

/* ──────────────────────── 交给事务官的那段指令 ──────────────────────── */

/**
 * 「先复述、再给确认点」那一段,拼进推进提示词里。
 *
 * 为什么把候选确认点也给它:不给的话它会自己编几条,而编出来的多半是复述废话
 * (「你是想做一个音色功能对吗」)—— 那正是这条规矩要治的病。
 */
export function confirmInstruction(input: {
  /** 产物文件名(`需求.md` / `框架.md`)。确认点那一节写进它的顶部。 */
  file: string
  /** 他那句需求(可空:卡上还没有 desc 时就是空的)。 */
  need?: string
  points: readonly ConfirmPoint[]
}): string {
  const lines: string[] = []
  lines.push('★ **先给确认点,不要假装自己搞懂了**(维护者 2026-09-23 定的通用规矩)。')
  lines.push('  动手之前**先**照这个形状说一段,一个字都不要多:')
  lines.push('')
  lines.push('  ```')
  for (const line of formatConfirmBlock({
    understanding: input.need === undefined || input.need.trim() === '' ? '<用一句话复述他要的那件事>' : input.need.trim(),
    points: input.points,
  }).split('\n')) lines.push(`  ${line}`)
  lines.push('  ```')
  lines.push('')
  lines.push(`  上面那几条是按他这句需求挑的候选(规则见技能《${CONFIRM_SKILL_NAME}》)。`)
  lines.push('  不合适可以换,但**条数仍然是 2–4 条**、**必须有「怎么算做完」那一条**,')
  lines.push('  而且每条都要是**会影响做法的分歧点**,不是复述废话。')
  lines.push(`  同一段话写进 ${input.file} 顶部的「${CONFIRM_SECTION_TITLE}」节。`)
  lines.push('  **他没逐条答之前不要往下做、更不要派活**;他说「都对 / 开工」或者逐条纠正之后,')
  lines.push(`  把他说的写回那一节,再让她去卡上点一下 —— 工作台会把「${ACCEPTANCE_SECTION_TITLE}」按确认点生成。`)
  return lines.join('\n')
}

/** 没过确认点时,后面几态那一段硬话。**这一层从来不起活**,所以"不派活"说给事务官听。 */
export function notConfirmedWarning(file: string): string {
  return [
    `★ **这条还没过确认点**(${file} 顶部的「${CONFIRM_SECTION_TITLE}」节里没有"已确认")。`,
    '  **这一步不要派活、不要动代码**。先回到第一步把确认点问完 —— 一次被曲解的需求',
    '  派出去之后,几家 AI 做出来的全是错的那一版。',
  ].join('\n')
}

/** 这份技能的段名。**与 `opsSkills.ts` 里那一条逐字相同**(改一处忘另一处是迟早的事)。 */
export const CONFIRM_SKILL_NAME = '需求确认点'

/* ──────────────────────── 收界面/事务官传回来的那几条 ──────────────────────── */

/** 一条确认点最长多少字。太长的多半是把整段稿子塞进来了。 */
export const CONFIRM_FIELD_MAX = 400

/**
 * 把 body 里的 `points` 收成 {@link ConfirmPoint}[]。**宽进严出**:
 * 认不出形状就说清哪一条不对,一个字都不代它补。
 *
 * `kind` 不收 —— 它是规则内部的事,回传回来只会出现一个规则里没有的类。
 * 一律按「验收那一条是最后一条」还原:那正是 {@link buildConfirmPoints} 的约定。
 */
export function parseConfirmPoints(value: unknown): { ok: true, points: ConfirmPoint[] } | { ok: false, error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'points 必须是一个数组' }
  if (value.length < CONFIRM_POINT_MIN || value.length > CONFIRM_POINT_MAX) {
    return { ok: false, error: `确认点要 ${CONFIRM_POINT_MIN}–${CONFIRM_POINT_MAX} 条(现在是 ${value.length} 条)` }
  }
  const points: ConfirmPoint[] = []
  for (const [index, raw] of value.entries()) {
    const one = raw as { ask?: unknown, guess?: unknown, answer?: unknown } | null
    const ask = typeof one?.ask === 'string' ? one.ask.trim() : ''
    const guess = typeof one?.guess === 'string' ? one.guess.trim() : ''
    if (ask === '') return { ok: false, error: `第 ${index + 1} 条没有 ask(问他的那一句)` }
    if (guess === '') return { ok: false, error: `第 ${index + 1} 条没有 guess(她的默认理解)—— 只问不答等于把活推回给他` }
    if (ask.length > CONFIRM_FIELD_MAX || guess.length > CONFIRM_FIELD_MAX) {
      return { ok: false, error: `第 ${index + 1} 条太长了(一条最多 ${CONFIRM_FIELD_MAX} 字)` }
    }
    const answer = typeof one?.answer === 'string' ? one.answer.trim() : ''
    if (answer.length > CONFIRM_FIELD_MAX) {
      return { ok: false, error: `第 ${index + 1} 条他那句话太长了(最多 ${CONFIRM_FIELD_MAX} 字)` }
    }
    points.push({
      ask,
      guess,
      kind: index === value.length - 1 ? '验收' : '动作',
      ...(answer === '' ? {} : { answer }),
    })
  }
  return { ok: true, points }
}

/**
 * **他改了哪几条**(序号从 1 起)。判据就一件看得见的事:那一条上有没有他的话。
 *
 * 不收调用方传进来的 `changed`:那样就有两处在说同一件事,而两处一定会漂。
 */
export function changedIndexes(points: readonly ConfirmPoint[]): number[] {
  return points
    .map((one, index) => (one.answer === undefined || one.answer.trim() === '' ? 0 : index + 1))
    .filter(one => one > 0)
}

/** 留痕那一行里的 `points`:一条一行「<问的那一句>:<最后算数的答案>」。 */
export function confirmTrace(points: readonly ConfirmPoint[]): string[] {
  return acceptanceLines(points)
}
