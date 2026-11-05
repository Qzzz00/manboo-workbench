/**
 * 引导答案的**对话凭据门**(2026-09-23,统筹从零重装自跑引导发现的三件事):
 *
 * - **I 先斩后奏的授权**:②′ 找项目时她没问就先调 `answer(read_scan_roots=true)`、再去看目录,
 *   事后才说「顺手把『能看那个目录』记成可以了」。会话日志里查实:写授权的是**模型**
 *   (turn 7 step 1 的 curl),服务端没有替它写。所以门关在服务端:授权类的 key 要记成
 *   「可以 / 要问」,得有**她问出口的那一句 + 他在那之后的回答**,而且回答不是拒绝。
 * - **H 确认上一题的「对」被当成下一题的答案**:①′ 布局她复述「那我先给你摆成产品研发那一套,对吗?」,
 *   他答「对」,她拿这个「对」记了 ② 分岔 `mode=existing` —— 分岔那一问从没问出口。
 *   (2026-09-23 起顺序改成 称呼 → 分岔 → 布局;守卫照样两头都管:称呼的「对」不算分岔,分岔顺口说的「做产品」不算布局。)
 *   所以必答项要记,得是他对**那一题**的回答:最近那一问(或他那句话)里要有这一题的字眼。
 * - **K 答非所问不追问**:④ 习惯里她问「开口说还是发文字」,他答「没有了」,她就收了这一段,那一项空着。
 *   所以 `habits.done` 之前,问出口的 `channel` 没答上就 409:追问一次,还不行按默认记并明说。
 *
 * 纯函数,没有 I/O。凭据从哪来由 http 层决定(DSH 会话那条路读回合表;电话那条路由工人带 `heard`)。
 * **拿不到任何凭据的调用方不在这里拦**(老测试、没绑回合表的调用)—— 见交接「与要求不一样处」。
 *
 * **门管到哪为止**(2026-09-23 统筹第三轮自跑 AA 收窄):只管授权类的 key(先斩后奏),与确实会被
 * 上一题的「对」误填的两个选项题(分岔 `mode`、布局 `template`,见 GUARDED_REQUIRED)。
 * 称呼、取名、习惯、人设这些普通题,他主动说出的明确答案直接收。
 *
 * 字眼表是**宽的**:只要问句或他的回答里出现了这一题的任何一个词就算问到了。
 * 它要拦的是「一个字都没提到这一题」,不是替模型挑措辞。
 */

import { ASK_TO_READ } from './projectBrief.ts'

/** 一问一答:她最近问出口的那句,和他在那之后说的那句。 */
export interface Exchange {
  asked: string
  reply: string
}

/** 回合表里的一条(与 onboardingTurns.OnboardingTurn 同形,这里只要这几个字段)。 */
export interface TurnLike {
  role: 'user' | 'assistant'
  text: string
  kind?: 'seed' | 'error'
}

/**
 * 从回合表里取「最近一问一答」:他说的最后一句,和那之前她说的最后一句(工作台替她说的
 * 「模型没接上」那种 `kind:'error'` 不算她问的)。他还没开过口 → undefined。
 */
export function lastExchange(turns: readonly TurnLike[]): Exchange | undefined {
  let replyAt = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role === 'user') { replyAt = i; break }
  }
  if (replyAt < 0) return undefined
  // 他连着说了几句(比如先「嗯」再补一句):几句拼起来算他的回答。
  let start = replyAt
  while (start - 1 >= 0 && turns[start - 1]?.role === 'user') start -= 1
  const reply = turns.slice(start, replyAt + 1).map(turn => turn.text).join('\n')
  for (let i = start - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn?.role === 'assistant' && turn.kind !== 'error') return { asked: turn.text, reply }
  }
  return { asked: '', reply }
}

/** 授权类的 key:记成「可以 / 要问」之前要他点过头。记「不可以」不用 —— 拒绝不会越权。 */
export const CONSENT_KEYS = [
  'read_scan_roots', 'read_session_titles', 'read_workbench_state', 'read_client_files', 'read_session_content',
  'write_docs', 'write_commit', 'write_api',
  // 不是授权表里的一项,是「替他按一下系统授权」(POST /onboarding/system-auth)。同一道门。
  'system_accessibility',
] as const

/** 每一题的字眼。问句或他的回答里出现任何一个就算「问到这一题了」。 */
export const QUESTION_MARKS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  // 2026-09-23 起顺序是 ① 称呼 → ② 分岔 → ①′ 布局。分岔句是中性的(「已经有在做的事,还是从一个新点子开始」),
  // 运营模板不再换它,原先收的「平台 / 账号 / 方向」拿掉 —— 留着的话他在称呼那一题顺口说一句「我做账号的」就能被当成答了分岔。
  branch: { mode: ['已有', '已经有', '从零', '点子', '新项目', '在做', '做着', '从头', '新的'] },
  // 布局在分岔**之后**问:他答分岔时常常顺口带出「我在做个产品」「我做自媒体的」,那不是选了布局。
  // 所以这一题只认**她问出口的那一句**里有这些字(见 ASKED_ONLY),他那句里有不算。
  template: { template: ['产品', '研发', '运营', '自媒体', '布局'] },
  projects: {
    // 2026-09-24(已有项目拉齐):问句改成「……读读它的说明和最近的记录……只读不改,可以吗?」,
    // 他改口时她也可能只问「那我读一下它的说明,可以吗?」—— 「读」也算问到这一题。
    read_scan_roots: ['目录', '文件夹', '仓库', '放代码', '找一下', '看一眼', '扫', '读'],
    read_session_titles: ['会话', '标题'],
    read_workbench_state: ['工作台状态', '状态'],
    read_client_files: ['Claude', 'Codex', 'Kimi', '客户端', '记着'],
  },
  authorization: {
    write_docs: ['记忆', '文档', 'docs', '写', '记下'],
    write_commit: ['提交', 'commit', 'push', '版本', '备份', '存一'],
    write_api: ['接口', '事项', '收件箱', '看板'],
    read_client_files: ['Claude', 'Codex', 'Kimi', '客户端', '记着'],
    // 卡 N(2026-09-25):判断事情做到哪了要看对话的最后几轮。
    read_session_content: ['最后几句', '最后几轮', '对话', '会话', '做到哪', '进度'],
    read_scan_roots: ['目录', '文件夹', '仓库', '放代码', '扫', '读'],
    read_session_titles: ['会话', '标题'],
    read_workbench_state: ['工作台状态', '状态'],
    system_accessibility: ['辅助功能', '系统', '开关', '窗口', '窗位'],
  },
}

/**
 * 「要问出口才收」的必答项(2026-09-23 统筹第三轮自跑 AA 起**只剩这两项**)。
 *
 * 这道门本意只拦一件事:确认上一题时他说的「对」被当成**这一题**的答案。会被这样误填的只有
 * 两个选项题 —— ② 分岔(existing / fresh)与 ①′ 布局(product / ops)。
 *
 * 称呼、取名、习惯、人设这些普通题**他主动说出的明确答案直接收**,不要求她先问过:
 * 真机上他说「就叫小管家」,门把 `butler_name` 挡回去,她只好说「我先按流程这一题正式问一次:
 * 给我取个名字吧……是小管家,对吗?」—— 逼她把内部规矩念给他听,维护者最反感这一类。
 * 这些题的值本身(一个称呼、一个名字、1–5 的旋钮)也不会被一个「对」字填出来。
 */
export const GUARDED_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  branch: ['mode'],
  template: ['template'],
}

/**
 * 只认问句的必答项(2026-09-23)。表里的字眼**只在她问出口的那句里**算数,他那句里出现了不算 ——
 * 因为上一题的回答天然会带这些字:分岔答「我在做个产品」,布局那一题并没有问出口。
 */
export const ASKED_ONLY: Readonly<Record<string, readonly string[]>> = {
  template: ['template'],
}

/** 拒绝时给模型的「照样子问」那一句。 */
const CONSENT_ASK_EXAMPLE: Readonly<Record<string, string>> = {
  // 2026-09-24(维护者拍板):找它、读它一起问,问一句就够。与 projectBrief.ts 的 ASK_TO_READ 同一句。
  read_scan_roots: `比如「${ASK_TO_READ}」`,
  read_client_files: '比如「你电脑上 Claude、Codex、Kimi 里各自记着一些东西,我能读一读吗?只读,一个字都不改」',
  write_docs: '比如「我会往我这边的记忆文件夹里写你的偏好和项目,每次存一个版本,只在这台电脑上 —— 可以、要问,还是不可以?」',
  write_commit: '比如「每次写完存一个版本、以后能翻回去,只在这台电脑上,可以吗?」',
  write_api: '比如「建事项、往收件箱放东西、挪看板,这些要不要让我直接做?默认是不行的」',
  read_session_content: '比如「看板上每件事做到哪了,我想照你在 Claude、Codex 里跟这件事有关的对话来写,这样不用你一件件告诉我 —— 只看最后几句,不改不存,判的时候相关几句会发给 AI 看一眼。可以、要问,还是不可以?」',
  system_accessibility: '比如「我要替你把别的应用窗口摆进窗位、把话送进 Claude 的输入框,这得你在系统里给我开一个『辅助功能』的开关。我现在帮你把那一页打开,可以吗?」',
}

/** 他在拒绝。只在授权类的 key 上用:「不用」「别」「不行」这些,记成「可以」就是越权。 */
const REFUSAL = /不(行|可以|要|用|准|给|想|必|了吧)|别(看|找|扫|读|碰|动)|算了|免了|no\b|拒绝/i
/**
 * 「不用问我」「不用每次都问」「不用管我」是嫌问得多,**不是拒绝**(2026-09-24 已有项目拉齐:
 * 他改口「可以,你去看吧,不用问我了」—— 以前「不用」两个字就把这一句判成不同意,还叫她记成 false)。
 * 判拒绝之前先把这几种说法摘掉。
 */
const NOT_A_REFUSAL = /不用(再|每次|老是?|都|一直)*(都)?(问|管|跟我说|征求|请示|确认)/g

function refuses(reply: string): boolean {
  return REFUSAL.test(reply.replace(NOT_A_REFUSAL, ''))
}

function mentions(text: string, marks: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return marks.some(mark => lower.includes(mark.toLowerCase()))
}

/** 是不是在「给」这一项(可以 / 要问)。false、「不可以」不算。 */
function grants(value: unknown): boolean {
  return value === true || value === '可以' || value === 'ask' || value === '要问'
}

export type GuardVerdict = { ok: true } | { ok: false, error: string }

/**
 * 一条 `answer` 该不该收。`exchange` 缺席 = 这一条路上拿不到凭据,不拦(由调用方决定要不要给)。
 *
 * `seed` 是这一阶段的种子句,拒绝时原样带给模型 ——「先照这句问出口,等他答了再记」。
 */
export function guardAnswer(input: {
  stage: string
  key: string
  value: unknown
  required: boolean
  exchange: Exchange | undefined
  seed?: string
}): GuardVerdict {
  const { stage, key, value, exchange } = input
  if (exchange === undefined) return { ok: true }
  const marks = QUESTION_MARKS[stage]?.[key]
  const isConsent = (CONSENT_KEYS as readonly string[]).includes(key)

  if (isConsent) {
    if (!grants(value)) return { ok: true }
    const asked = exchange.asked
    if (asked === '' || marks === undefined || !mentions(asked, marks) || !/[??]|吗|么|行不行|好不好|可不可以|能不能/.test(asked)) {
      return {
        ok: false,
        error: `${key} 还不能记成「可以」:我没看到你问过他、他点过头。**先问后看**:`
          + `先说清为什么要、问一句(${CONSENT_ASK_EXAMPLE[key] ?? '比如「……可以吗?」'}),`
          + '等他说可以再记;他没答之前别去看、别去找、别去开。' + NO_INTERNAL_TALK,
      }
    }
    // 记「要问」本来就是收着的那一档:他说「不行,每次先问我」时记它是对的,不拦。
    if ((value === true || value === '可以') && refuses(exchange.reply)) {
      return { ok: false, error: `他刚才说的是「${exchange.reply.slice(0, 40)}」,听着是不同意:这一项记成 false(不可以),别替他答应。` }
    }
    return { ok: true }
  }

  if (!input.required || marks === undefined) return { ok: true }
  if (GUARDED_REQUIRED[stage]?.includes(key) !== true) return { ok: true }
  const askedOnly = ASKED_ONLY[stage]?.includes(key) === true
  if (mentions(exchange.asked, marks) || (!askedOnly && mentions(exchange.reply, marks))) return { ok: true }
  return {
    ok: false,
    error: `这一题他还没答:你最近问的「${exchange.asked.slice(0, 40)}」不是这一题,他那句「${exchange.reply.slice(0, 20)}」是在答那一句。`
      + `**别把他对上一题的「对」当成这一题的答案** —— 自然地把这一题问出来${input.seed === undefined ? '' : `(照样子说:「${input.seed}」)`},等他答了再记。`
      + NO_INTERNAL_TALK,
  }
}

/**
 * 被拦之后别把「拦」这件事念给他听(AA)。每一句 409 都带着它。
 */
export const NO_INTERNAL_TALK
  = '**别跟他说「按流程」「系统那边」「工作台要求」「正式问一次」这类内部话** —— 直接问,像头一回问那样。'

/**
 * 他明说要往下走了(W,2026-09-23):「没了,下一步」「先这样」「跳过」。
 * 这时本段收尾,不再追问;问过没答上的可选项按默认记并明说。
 * 单独一句「没有了」**不算** —— K 那一回正是拿「没有了」去答「开口说还是发文字」,那是答非所问。
 */
export const MOVE_ON = /下一步|下一段|下一个|往下(走|说|聊)?|先这样|就这样吧?|就这些|跳过|够了|不聊了|别问了|不用问了/

export function wantsToMoveOn(reply: string): boolean {
  return MOVE_ON.test(reply)
}

/**
 * **他不耐烦了:剩下的别问了,直接进页面**(2026-09-27,卡 OB;统筹按维护者 19:55 授权定)。
 *
 * 现场原话(新 Air 上那一遍 15 问、11 分钟):「你好啰嗦啊」「管你屁事,半天了我怎么还没进页面啊」
 * 「都行,快点让开」「我让你走开啊」—— 而事务官仍依次问了音乐、性格、取名。
 *
 * 所以这个判据**写在代码里**(词表),不靠模型自觉:命中就把剩下的按默认落盘、立刻收尾进页面
 * (见 onboarding.ts 的 `skipRest`,入口在 `/onboarding/say` 与 `/onboarding/skip-rest`)。
 *
 * 词表只收**明确的不耐烦与"别问了"**,不收单独一句「没有了」「都行」——
 * 那两句是答非所问(见 {@link MOVE_ON} 与 K 那一条),不是喊停整段引导。
 */
export const IMPATIENT
  = /跳过|快点|快些|别问了|不要问了|不用问了?|别啰嗦|好啰嗦|太啰嗦|啰嗦|罗嗦|让开|走开|滚开|闭嘴|进页面|让我进去|先进去|进去吧|够了没|烦死|好烦|烦不烦|管你屁事|废话|磨叽|墨迹|别墨迹/

export function wantsToSkipRest(text: string): boolean {
  return IMPATIENT.test(text)
}

/**
 * 问出口了、他却没给有效回答的那几项(K)。一段收尾(`done: true`)之前查:
 * 这一段她问过的话里提到了它,而它没记上 → 不收,让她追问一次、还不行按默认记并明说。
 *
 * 现在只盯 ④ 习惯的「开口说还是发文字」(`channel`)—— 那是真机上漏掉的那一项;
 * 别的可选项他说「不用」就是答了,不追。
 */
export const ASKED_OPTIONAL: Readonly<Record<string, Readonly<Record<string, { marks: readonly string[], fallback: string }>>>> = {
  habits: {
    channel: { marks: ['开口说', '发文字', '语音', '打字', '出声', '念给你'], fallback: '文字为主(默认,他没明说)' },
  },
}

export function unansweredAsked(input: {
  stage: string
  answeredKeys: readonly string[]
  /** 这一段开始以后她说过的话。 */
  askedTexts: readonly string[]
}): { key: string, fallback: string } | undefined {
  const table = ASKED_OPTIONAL[input.stage]
  if (table === undefined) return undefined
  for (const [key, def] of Object.entries(table)) {
    if (input.answeredKeys.includes(key)) continue
    if (input.askedTexts.some(text => mentions(text, def.marks))) return { key, fallback: def.fallback }
  }
  return undefined
}


/**
 * 引导落地那一问「都摆好了……第一件交给 Codex 接着做参赛网页,行吗?」他点头了吗(2026-09-24 晚,卡 feat/onboarding-materialize)。
 *
 * 程序调 `/onboarding/materialize/apply`(工人的 setup_apply、DSH 会话的 curl)时带着他刚才那句话:
 * 听着是不同意、要等、要改 → 不落(409),她去问要改哪一件;「视频那件不用,其余可以」这种算点头(skip 由调用方带)。
 * 页面按钮与手机按钮是他本人的手,不走这里。
 */
const SETUP_REFUSAL = /不行|不要落|先别|别落|别派|别急|等等|等一下|不对|不可以|回头再说|先不|算了|改一下|我再看看|再想想/
const SETUP_APPROVAL = /可以|行|好的?|就这样|没问题|对|嗯|派吧|开始吧|搞吧|ok|同意|落吧|去吧|是的|没错|摆吧|就按|按这个|办吧/i

export function approvesSetup(reply: string): boolean {
  const text = reply.trim()
  if (text === '') return false
  if (SETUP_REFUSAL.test(text)) return false
  // 他在问问题(「那个视频是谁做的?」)不是点头 —— 先答他。
  if (/[??]\s*$/.test(text) || /(吗|呢)\s*$/.test(text)) return false
  return SETUP_APPROVAL.test(text)
}
