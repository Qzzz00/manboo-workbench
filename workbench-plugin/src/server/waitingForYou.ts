/**
 * 「在等你」—— **全仓只有这一份判断**(2026-09-25,卡 T;设计 docs/设计-Agent自动发现与统一接入-2026-09-25.md 第五节)。
 *
 * 维护者原话:「事务官那里显示有三个Claude会话在跑,这不对,而且现在会话的状态虽然不是待确认,但是你看你实际上是需要我确认
 * 才能做下一步的,所以事务官不能纯按照Agent的会话状态来判断是否由我确认,也有可能跟你这次一样,你并没有用弹窗的形式列出问题和选项」。
 * 当时统筹那条会话停着在等他回「额度提不提」:正文最后是三个选项和「你选哪个?回个数字就行」,没用弹窗,状态也只是「这一轮说完了」。
 *
 * 输入是统一的会话形状(卡 P `sessionDigest.turnsOf` 的输出:原文回合 + 末尾挂着的那一步),加上那家报的状态;输出:
 * 在不在等他、哪一类(选择 / 批准 / 要你去做 / 要你审)、一句人话的问题、选项、从什么时候开始等、依据(逐字摘的那一句)。
 *
 * 两种来源,满足一种就算:
 * 1. **形式上的**(`by: 'form'`):提问弹窗(Claude `AskUserQuestion`、Codex `request_user_input`)、等他批计划(`ExitPlanMode`)、
 *    权限弹窗(Claude 自己记着 `waiting` + `permission prompt`,或 hook 报的 `permission_prompt`)、Kimi 的 `blocked`;
 * 2. **内容上的**(`by: 'rules'`):那家最后一轮是在问他、让他选、让他批、让他去点或去跑一个命令、交了东西等他审。
 *    先按规则({@link factsOf});规则拿不准(`certainty: 'unsure'`)才问一次便宜的模型(这里只有提示词与核对,
 *    问模型、缓存、花费在 waitingService.ts),模型说的依据**逐字核过**才算数。
 *
 * 状态的优先级:**在等你 > 在跑 > 空闲**({@link loadOf});子任务的会话不单算一条,挂到它的主会话下({@link rollUpLoads})。
 *
 * 纪律:
 * - 纯函数,不碰文件、不碰网络;原文只在内存里过一遍,出去的是截过、洗过的一句 + 依据那一句;
 * - 拿不准就说拿不准,不替它编一个「在等你」(D13);判不出的原文也不往外带;
 * - 卡 N 的「会话最后是他要了东西、对方交了、他没回 →『在等你审』」就是这里的 `review`({@link reviewPending}),
 *   卡 N 那一处换成调这一份(约定写在 `.worktrees/留言-卡N-卡T.md`),全仓不留第二份。
 */
import { createHash } from 'node:crypto'
import type {
  EventReason, SessionAskFullView, SessionAskKind, SessionAskOption, SessionAskView, SessionStatus, SessionView, WaitReason,
} from '../protocol.ts'
import type { PendingStep, SessionTurn } from './sessionDigest.ts'

// ───────────────────────────── 形状 ─────────────────────────────

/** 判断要的那几样会话事实(卡 P `turnsOf` 输出的子集)。 */
export interface WaitInput {
  turns: readonly SessionTurn[]
  /** 末尾挂着、没等到结果的那一步(提问弹窗 / 等批计划 / 别的一步)。 */
  pending?: PendingStep
  /** 子任务的会话:它的话是说给主会话听的,不按内容判「在等他」。 */
  subagent?: boolean
}

/** 那家报的此刻状态(形式上的信号)。都可缺:缺了就只按内容判(卡 N 核进度时就是这样用的)。 */
export interface WaitSignals {
  status?: SessionStatus
  reason?: EventReason
  wait_reason?: WaitReason
  /** 这个状态从什么时候起(ISO)。 */
  status_since?: string
  /** Claude 自己记的「此刻在等什么」(`~/.claude/sessions/<pid>.json` 的 `waitingFor`:`permission prompt` / `input needed`)。 */
  waiting_for?: string
  /** 此刻(ISO)。给了才判「旧的空闲会话」。 */
  now?: string
  /** 那家叫什么(问题里用,「Kimi 停下来等你确认」);缺席说「它」。 */
  agent_name?: string
  /**
   * **「它真的停下来在等人」的直接证据**(2026-09-28,卡 KM)。
   * `'approval'` / `'question'`:记录里明写着的那一条(Kimi 的 `ApprovalRequest` / `QuestionRequest`,
   * 见 sessionDigest 的 `formal_wait`);`'unspecified'`:来源说得出「在等」但说不出等什么
   * (children 里那条子任务自己写着 `waiting`)。
   *
   * **缺席 = 没有证据**:那时候「状态是 waiting、又说不出等什么」不再算形式上的在等你 ——
   * Kimi 这一轮说完就记 `blocked`,照字面算的后果是每条都挂橙色角标,还替它编一句「它那边弹了个框等你点」。
   */
  formal_wait?: 'approval' | 'question' | 'unspecified'
}

/** 按内容读出来的(与那家报的状态无关的那一半);文字只在这里读一遍,之后只拿它来和状态拼。 */
export interface ContentVerdict {
  waiting: boolean
  certainty: 'sure' | 'unsure'
  kind?: SessionAskKind
  question?: string
  options?: SessionAskOption[]
  /** 依据:那家原话里的那一句(逐字,只去掉首尾空白)。 */
  quote?: string
  /** review:在等他审的那份东西(「参赛网页逐屏文案稿」)。 */
  what?: string
  rule: string
}

/** 一条会话的事实:从回合里读一遍就定下来的那些(文件没动就不用再读)。 */
export interface WaitFacts {
  /** 最后一句是他说的:球在那家那边。 */
  hisTurn: boolean
  /** 那家最后那段话(一条消息)是什么时候说的(ISO)。 */
  answerAt?: string
  /** 最后那段话是这一轮的最终回答(Claude `end_turn` / Codex `final_answer` / Kimi 那一步说完)。 */
  answerFinal?: boolean
  content?: ContentVerdict
  pending?: PendingStep
  subagent?: boolean
}

export interface WaitVerdict {
  /** 在等他的是这条会话底下的哪个子任务(缺席 = 主会话自己)。 */
  child?: { id: string, title?: string }
  waiting: boolean
  /** sure = 弹窗 / 规则说了算;unsure = 规则拿不准(有像在问的话,又不够确定)→ 可以问一次模型。 */
  certainty: 'sure' | 'unsure'
  kind?: SessionAskKind
  question?: string
  options?: SessionAskOption[]
  /**
   * **那一问的原文**(2026-10-04,卡 `claude/ask-with-context`;`SessionAskFullView`)。
   * 只有弹窗那一问 / 等批计划读得到(`by:'form'`)——`question` 是洗过截到 60 字的那一句,
   * 这一格一个字没洗没截。按内容判出来的那几条**缺席**:没有原文可给,不拿洗过的那句冒充。
   */
  full?: SessionAskFullView
  since?: string
  quote?: string
  what?: string
  by: 'form' | 'rules' | 'model'
  /** 哪一条规则(测试与排查用,不给他看)。 */
  rule: string
  /**
   * 权限弹窗那一步自己的命令 / 文件原字(2026-10-01,卡 AP;`PendingStep.marks`)。
   * 只给替她按批准弹窗那一路认弹窗用,**不进 `askViewOf`、不上 /state**。
   */
  marks?: string[]
}

/** 这条会话此刻的「分量」:在等你 > 在跑 > 空闲。 */
export type SessionLoad = 'waiting' | 'running' | 'idle'

const LOAD_RANK: Readonly<Record<SessionLoad, number>> = { waiting: 2, running: 1, idle: 0 }

/** 内容判出来的「在等你」多久以后算旧的(那家说完那句话之后他一直没理,就不再算等他)。 */
export const WAIT_MAX_AGE_MS = 12 * 3_600_000

// ───────────────────────────── 字 ─────────────────────────────

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u

function clipText(text: string, max: number): string {
  const chars = Array.from(text.trim())
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(1, max - 1)).join('').replace(/[\s，,、；;：:。.]+$/u, '')}…`
}

/** ``` 代码块换成等长的空白:位置不变(摘原文对得上),代码里的「?」「你」不算数。 */
function maskFences(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, block => block.replace(/[^\n]/g, ' '))
}

/** 去掉 markdown 记号(`**`、行内代码的反引号、行首的 # > - * 1.),只去记号不改字。 */
function plainLine(text: string): string {
  return text
    .replace(/\*\*|__|~~/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+•·]\s+)/, '')
    .trim()
}

/**
 * 一条路径换成**可读的占位**(2026-09-28,卡 RC)。
 *
 * 09-28 上午那一条挂在「等你」里的话是:「落在哪(她的工作目录还是 )需要你拍板后另开一张卡」——
 * 括号里缺了一截,因为这里原来把路径**删成空**。删成空的句子他看不懂,而"不露内部的东西"从来不要求把句子挖空:
 * 留最后一段(目录名 / 文件名)就够他认出是哪儿,前面那一串家目录一个字不露。
 * 最后一段拿不到、或者长得离谱(像个随机串) → 一句人话「你的某个文件夹」。
 */
export function pathPlaceholder(path: string): string {
  const last = path.replace(/[/\\]+$/, '').split(/[/\\]/).filter(one => one !== '' && one !== '.' && one !== '..' && one !== '~').pop() ?? ''
  const name = last.trim()
  if (name === '' || Array.from(name).length > 24) return '你的某个文件夹'
  return `「${name}」`
}

/**
 * 给他看的一句:去掉记号、网址、文件名(维护者规矩第 3 条:不露内部的东西),**路径换成可读的占位**
 * ({@link pathPlaceholder} —— 卡 RC:脱敏不许把句子挖空;严格脱敏只用在诊断上报那一路,
 * `diagnostics/redact.ts`),问号留着。洗完没剩什么意思 → undefined(调用方换一句,不拿空话凑)。
 */
export function speakable(text: string, max = 60): string | undefined {
  /**
   * 占位先收在一边、句子里只留一个记号(`\u0000n\u0000`),等别的规则都跑完再放回去。
   * 不这么做的话下面那条「光秃秃的文件名」会把刚换好的占位再啃掉半截(`「交接.md」`→`「交」`)。
   */
  const kept: string[] = []
  const hold = (one: string): string => `\u0000${kept.push(pathPlaceholder(one)) - 1}\u0000`
  const out = plainLine(text)
    .replace(/^\s*(?:\d{1,2}[.、)）](?!\d)|[①-⑨]|[A-Ea-e][.、)）](?=\s))\s*/, '')
    .replace(/https?:\/\/\S+/g, '')
    // 路径:/…、~/…、./…;a/b 形的(斜杠前至少一个英文数字 ——「今晚/明早」这种中文里的斜杠留着)
    .replace(/(?:^|(?<=[\s(（「『"'“=:：,，、]))(?:~|\.{1,2})?\/[^\s，。、；：）)」』"'”’？?！!]+/g, one => hold(one))
    .replace(/[A-Za-z0-9_.~-]+\/[^\s，。、；：）)」』"'”’？?！!]+/g, one => hold(one))
    // 光秃秃的文件名(不带路径的那种)照旧去掉;路径那几截此刻收在 kept 里,这条规则啃不到它。
    .replace(/[\w\u3400-\u9fff-]+\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|swift|py|sh|ya?ml|toml|html?|css|txt|log|plist|png|jpe?g|pdf|docx?|pptx?|xlsx?|csv|sqlite|dmg|zip|apk)\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。？！,.?!])/g, '$1')
    // 去掉路径之后两个汉字之间剩下的空格(「要不要把 也改了」)
    .replace(/([\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/gu, '$1')
    // 收在一边的占位放回去 —— 放回之后不再动它:那一截就是给他看的。
    .replace(/\u0000(\d+)\u0000[ \t]*/g, (_m, n: string) => kept[Number(n)] ?? '')
    .replace(/([\u3400-\u9fff」])[ \t]+(?=[\u3400-\u9fff「])/gu, '$1')
    .replace(/\s+([，。？！,.?!])/g, '$1')
    .trim()
  const cjk = out.match(/[\u3400-\u9fff]/gu)?.length ?? 0
  const words = out.match(/[A-Za-z]{2,}/g)?.length ?? 0
  if (cjk + words * 2 < 2) return undefined
  return clipText(out, max)
}

interface Sentence {
  /** 原文那一句(首尾空白去掉)。 */
  raw: string
  /** 去掉记号的一句(判断用)。 */
  clean: string
  /**
   * 认「在叫他 / 问他」用的那一句:引号里的字换成空引号 ——「再到『等你确认』里点 B」里的「等你确认」是界面上那一格的名字,
   * 「你说『先别合』」是转述他的话,都不是在叫他。
   */
  cue: string
  /** 在原文里的起止位置。 */
  start: number
  end: number
  /** 第几行(0 起)。 */
  line: number
}

/** 切句:句末标点(。!?;及全角)与换行;句末标点留在句子里。代码块里的不算。 */
function sentencesOf(text: string): Sentence[] {
  const masked = maskFences(text)
  const out: Sentence[] = []
  const pattern = /[^。！？!?；;\n]+[。！？!?；;]*/g
  for (const match of masked.matchAll(pattern)) {
    const start = match.index
    const end = start + match[0].length
    const raw = text.slice(start, end).trim()
    if (raw === '' || masked.slice(start, end).trim() === '') continue
    const clean = plainLine(raw)
    if (clean === '') continue
    const line = (masked.slice(0, start).match(/\n/g)?.length ?? 0)
    const cue = clean.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/g, '「」')
    out.push({ raw, clean, cue, start, end, line })
  }
  return out
}

/** 一句有没有意思(汉字两个以上或英文词两个以上);签名、分隔线、单个表情不算。 */
function meaningfulSentence(sentence: Sentence): boolean {
  const cjk = sentence.clean.match(/[\u3400-\u9fff]/gu)?.length ?? 0
  const words = sentence.clean.match(/[A-Za-z]{2,}/g)?.length ?? 0
  return cjk >= 2 || words >= 2
}

/**
 * 依据:那一句,连同同一行里紧挨着它、也在问他的那几句(「你选哪个?回个数字就行。」是一行里的两句,一起摘;
 * 「首页改好了。要不要我顺手…?」只摘后一句);太长就只摘那一句。
 */
function lineOf(text: string, sentence: Sentence, sentences: readonly Sentence[] = []): string {
  let start = sentence.start
  const sameLine = sentences.filter(one => one.line === sentence.line && one.start < sentence.start).sort((a, b) => b.start - a.start)
  for (const one of sameLine) {
    if (!cueLike(one.cue)) break
    start = one.start
  }
  const nextBreak = text.indexOf('\n', sentence.end)
  const rest = text.slice(start, nextBreak === -1 ? text.length : nextBreak).trim()
  return Array.from(rest).length <= 80 ? rest : sentence.raw
}

// ───────────────────────────── 规则 ─────────────────────────────

/** 要他亲手做的那几种动作(跑、登、给、装……)。 */
const DO_HARD = '跑|运行|执行|敲|输入|登录|登入|授权|允许|勾选|勾上|勾一下|打勾|开启|安装|重启|提供|上传|扫码|扫一下|插上|连上|复制|粘贴|填写|填上|充值|付款|购买|发给我|发我|贴给我|贴我|给我发|给我贴|传给我|传我'
/** 看一眼那几种(看、审、验收、试)。 */
const REVIEW_VERBS = '看一下|看看|看一眼|过目|过一遍|审一下|审阅|审核|检查一下|验收|试一下|试试|试用|体验一下|确认一下效果|确认效果|点评'

const DO_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?:需要|麻烦|请|得|劳驾|辛苦|要)(?:你|您)[^。！？!?\\n]{0,24}?(?:${DO_HARD})`),
  new RegExp(`(?:你|您)(?:需要|得|要|先|来|去)[^。！？!?\\n]{0,20}?(?:${DO_HARD})`),
  new RegExp(`(?:请|麻烦|需要)?(?:在|到|去)(?:终端|命令行|Terminal|系统设置|设置|浏览器|手机)[^。！？!?\\n]{0,20}?(?:${DO_HARD}|打开|点)`, 'i'),
  new RegExp(`(?:需要|麻烦|请|劳驾)(?:你|您)[^。！？!?\\n]{0,16}?(?:打开|点一下|点击|点开|按一下|拖|切到)`),
  /\b(?:please|you(?:'ll| will)? need to|you(?:'ll| will)? have to|you should|can you|could you)\s+(?:run|execute|click|open|log ?in|sign ?in|grant|allow|install|restart|paste|type|enter|provide|upload|send|share)\b/i,
]

const REVIEW_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?:请|麻烦|方便|需要|等)?(?:你|您)(?:先|有空|方便时|抽空)?(?:${REVIEW_VERBS})`),
  new RegExp(`(?:请|麻烦|方便|需要|等)(?:你|您)[^。！？!?\\n]{0,16}?(?:${REVIEW_VERBS})`),
  /等(?:你|您)(?:审|看|验收|过目|试|确认效果)/,
  /(?:方便|便于)(?:你|您)[^。！？!?\n]{0,12}(?:看|审|改|圈)/,
  /请(?:你|您)?(?:审|过目|验收)/,
  /\b(?:please )?(?:take a look|have a look|review (?:it|this|the)|give it a try)\b/i,
]

const CHOOSE_PATTERNS: readonly RegExp[] = [
  /(?:你|您)(?:想|要|打算|倾向|倾向于|更倾向|觉得)?(?:选|挑)(?:哪|一个|一种|一条|个)/,
  /(?:选|挑)哪(?:个|一个|种|条|套|版|样)?/,
  /回(?:个|一个|复|我)?(?:数字|编号|序号|字母|选项)/,
  /回[「"“]?[1-9A-Da-d一二三四][」"”]?(?:或|还是|、|就行|即可)/,
  /哪(?:个|一个|种|一种|条|一条|套|版|样|边)(?:方案|选项|方向|做法|路线|更好|好|合适|先)?[^。！？!?\n]{0,10}[？?]/,
  /(?:是|要|用|走|先)?[^。！？!?\n，,]{1,24}还是[^。！？!?\n]{1,30}[？?]/,
  /\b(?:which (?:one|option|do you)|pick (?:one|a number)|choose (?:one|between)|reply with (?:a|the) number)\b/i,
]

const APPROVE_PATTERNS: readonly RegExp[] = [
  /要不要/,
  /可不可以|能不能(?:先)?(?:开始|继续|合|发|推|动手|上)/,
  /(?:可以|行|好|对|同意|OK|ok|没问题|合适|妥)(?:吗|么|嘛)/,
  /(?:需要|要)我[^。！？!?\n]{0,30}(?:吗|么)|(?:需要|要)我(?:继续|先|去|把|帮|再|直接|现在|马上|顺手|顺便|接着)[^。！？!?\n]{0,30}[？?]/,
  /(?:我|我们)(?:就|先|现在)?(?:继续|开始|动手|合进|合并|发版|推送|提交|上线|部署)(?:吗|了吗|？|\?)/,
  /(?:需要|等|请|要)(?:你|您)(?:批|批准|确认|点头|拍板|同意|放行|授权|定一下|定个|定|说一声|回个话|一句话)/,
  /待(?:你|您)?拍板/,
  /(?:你|您)(?:批|点头|拍板|同意|确认)(?:一下|了|的话|后)/,
  /(?:如果|要是|若)(?:你|您)?(?:同意|可以|没问题|觉得(?:可以|行|没问题|OK)|OK|ok|点头|批了?)[^。！？!?\n]{0,24}(?:我|就)/,
  /是否(?:要|需要|继续|可以|同意|先|现在)?[^。！？!?\n]{0,20}[？?]/,
  /\b(?:shall I|should I|do you want me to|want me to|may I|ok to (?:proceed|continue|merge))\b/i,
]

/** 客套的收尾:「有问题随时叫我」「还有别的需要吗?」—— 不算在等他。 */
const CLOSER = /(?:有|如有|若有|要是有)(?:任何|什么|其他|其它|别的)?(?:问题|需要|想法|疑问)(?:的话)?[，,]?\s*(?:随时|可以|再)?(?:告诉|叫|找|说|跟|问)|(?:需要|想要)(?:的话|什么)[，,]?\s*(?:随时)?(?:告诉|叫|找)我|还有(?:什么|别的|其他|其它)(?:需要|要)?(?:我)?(?:帮忙|做|处理|帮你|要做)?(?:的)?(?:吗|嘛)?|随时(?:叫|找|告诉|跟)我|\blet me know if\b|\banything else\b|\bfeel free to\b|\bhappy to help\b/i

/** 它自己接着干:「我先去跑测试,稍后汇报」—— 不算在等他。 */
const WORKING = /(?:我|我们)(?:先|这就|马上|现在|接着|继续)(?:去|来)?(?:做|改|跑|写|查|修|推进|处理|看|实现|跟进|等)|(?:正在|还在)(?:跑|做|改|写|查|等)|稍后(?:汇报|回来|再)|跑完(?:再|我)/

/** 像是在等他、又不够确定(交给模型那一档):「建议下一步…」「你觉得呢」「等你…」、句子中间夹着的问(「这样行不行呢,…」)。 */
const SUGGEST = /(?:建议|推荐)(?:你|您)?(?:下一步|接下来|先|可以)|下一步(?:可以|建议|打算|计划)|(?:你|您)(?:看|觉得)(?:怎么样|如何|呢)|等(?:你|您)(?!审|看|批|确认|拍板)|(?:行不行|好不好|对不对|是不是|妥不妥)|(?:吗|呢)[，,]/

/** 否定 / 假设在前:「不需要你跑」「如果需要你可以自己跑」—— 不是在叫他做。 */
function negatedBefore(clean: string, index: number): boolean {
  const before = clean.slice(Math.max(0, index - 6), index)
  return /(?:不|无需|无须|不用|不必|没必要|别|免得|以免)$/.test(before)
}

function conditionalBefore(clean: string, index: number): boolean {
  return /(?:如果|若|要是|如需|假如|万一|需要的话)/.test(clean.slice(0, index))
}

function firstMatch(patterns: readonly RegExp[], clean: string): RegExpExecArray | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(clean)
    if (match !== null) return match
  }
  return undefined
}

/** 这一句是不是在问(以问号收尾,或以「吗 / 呢 / 么」收尾)。 */
function isQuestion(clean: string): boolean {
  return /[？?]\s*[)）」』"”]*$/.test(clean) || /(?:吗|呢|么|嘛)[。.]?\s*$/.test(clean)
}

function addressesHim(clean: string): boolean {
  return /[你您]|\byou\b/i.test(clean) || /(?:吗|呢|么|哪|什么|怎么|如何|多少|几|是否|要不要|还是)/.test(clean)
}

/** 这一句本身就在问他 / 叫他(摘依据时往前带上同一行里这样的句子)。 */
function cueLike(clean: string): boolean {
  return isQuestion(clean) || [DO_PATTERNS, CHOOSE_PATTERNS, APPROVE_PATTERNS, REVIEW_PATTERNS].some(patterns => firstMatch(patterns, clean) !== undefined)
}

// ───────────────────────────── 选项 ─────────────────────────────

const OPTION_LINE = /^\s*(?:[-*•·]\s*)?(?:\*\*)?\s*(?:(\d{1,2})[.、)）:：]|[(（](\d{1,2})[)）]|([①-⑨])|([A-Ea-e])[.、)）:：]|[(（]([A-Ea-e])[)）]|(?:方案|选项|选择)\s*([一二三四五六七八九\dA-Ea-e])\s*[：:、.)）]?)\s*(.+)$/

const CIRCLED = '①②③④⑤⑥⑦⑧⑨'
const CN_NUM = '一二三四五六七八九'

function optionOrdinal(match: RegExpExecArray): number | undefined {
  const digit = match[1] ?? match[2]
  if (digit !== undefined) return Number.parseInt(digit, 10)
  if (match[3] !== undefined) return CIRCLED.indexOf(match[3]) + 1
  const letter = match[4] ?? match[5]
  if (letter !== undefined) return letter.toUpperCase().charCodeAt(0) - 64
  const named = match[6]
  if (named !== undefined) {
    if (/\d/.test(named)) return Number.parseInt(named, 10)
    if (CN_NUM.includes(named)) return CN_NUM.indexOf(named) + 1
    return named.toUpperCase().charCodeAt(0) - 64
  }
  return undefined
}

interface OptionGroup {
  firstLine: number
  lastLine: number
  options: SessionAskOption[]
}

/**
 * 一个选项那一行 → label + note:
 * - 加粗的那一截就是选项本身(「**把上限提到 15 元(我推荐)**:我改中转…」→ label「把上限提到 15 元(我推荐)」,后面是 note);
 * - 没加粗的按「——」「:」分(「保持 10 元 —— 撞到了就停」→ label「保持 10 元」、note「撞到了就停」)。
 */
function optionOf(body: string): SessionAskOption | undefined {
  const bold = /^\s*\*\*(.+?)\*\*\s*[：:，,。—\-–]*\s*(.*)$/.exec(body)
  if (bold !== null && bold[1] !== undefined && plainLine(bold[1]) !== '') {
    const label = plainLine(bold[1]).replace(/[：:，,。]\s*$/, '')
    const note = plainLine(bold[2] ?? '')
    return { label: clipText(label, 40), ...(note === '' ? {} : { note: clipText(note, 60) }) }
  }
  const plain = plainLine(body).replace(/[：:]\s*$/, '')
  if (plain === '') return undefined
  const split = /^(.{1,40}?)\s*(?:——|—|--|：|:|\s-\s)\s*(.+)$/.exec(plain)
  if (split !== null && split[1] !== undefined && split[2] !== undefined && split[1].trim() !== '') {
    const note = split[2].trim()
    return { label: clipText(split[1], 40), ...(note === '' ? {} : { note: clipText(note, 60) }) }
  }
  return { label: clipText(plain, 40) }
}

/** 原文里所有「1. 2. 3.」「A. B.」「方案一 / 方案二」这种连着编号的组(至少两项,从 1 / A / ① / 一 起)。 */
function optionGroups(text: string): OptionGroup[] {
  const lines = maskFences(text).split('\n')
  const groups: OptionGroup[] = []
  let current: (OptionGroup & { next: number }) | undefined
  const close = (): void => {
    if (current !== undefined && current.options.length >= 2) groups.push({ firstLine: current.firstLine, lastLine: current.lastLine, options: current.options })
    current = undefined
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    const match = OPTION_LINE.exec(line)
    const ordinal = match === null ? undefined : optionOrdinal(match)
    if (match !== null && ordinal !== undefined) {
      const option = optionOf(match[7] ?? '')
      if (option !== undefined && ordinal === 1) {
        close()
        current = { firstLine: i, lastLine: i, options: [option], next: 2 }
        continue
      }
      if (option !== undefined && current !== undefined && ordinal === current.next) {
        current.options.push(option)
        current.lastLine = i
        current.next += 1
        continue
      }
    }
    // 缩进的续行(选项底下那行说明)不打断这一组;别的都打断。
    if (current !== undefined && /^\s{2,}\S/.test(line) && i === current.lastLine + 1) continue
    close()
  }
  close()
  return groups
}

// ───────────────────────────── 在等他审(卡 N 那一处换成这一份) ─────────────────────────────

/** 他那句话里要了一份东西、说自己先看(卡 N `pendingForHim` 的原判据,一字未改)。 */
const WANTS_TO_LOOK = /(?:给我|发我|整理|做|出|写|导出)[^。!?\n]{0,20}(?:文档|文件|稿|清单|截图|表|页面|版本)|(?:自己|我)先看|我看看|我过目|我审/
/** 那家那句话里交了东西(同上;「『』」也认,文件扩展名去掉)。 */
const DELIVERED = /已(?:经)?(?:整理|写|做|生成|导出|放|存|推送)(?:成|好|进|到)?\s*(?:了)?\s*[「『]?([^\s。,,::;;「」『』()()]{2,24})/

/**
 * 会话最后一来一回是不是「他要了一份东西自己先看,那家交了,之后他没回话」—— 球在他那儿(卡 N 09-25 的判据,搬到这里只留一份)。
 * 维护者 09-24 晚在 Codex 里说「给我一个文档…我自己先看着看看」,Codex 交了「参赛网页逐屏文案稿」,之后一直没回。
 * `what` = 那份东西(不带「在等你审」);`quote` = 那家交东西那一句(截 80 字)。认不出就不说。
 */
export function reviewPending(ask: string | undefined, answer: string): { what: string, quote: string } | undefined {
  if (ask === undefined || !WANTS_TO_LOOK.test(ask)) return undefined
  const delivered = DELIVERED.exec(answer)
  if (delivered === null || delivered[1] === undefined) return undefined
  const what = delivered[1].replace(/[了的]$/, '').replace(/\.(?:md|docx?|pdf|txt|html?|pptx?|xlsx?|csv)$/i, '')
  if (what === '') return undefined
  const sentence = answer.split(/[。!?;\n！？；]+/)
    .map(one => one.replace(/^[^「]*「|」$/g, '').trim())
    .find(one => one.includes(what)) ?? what
  return { what, quote: clipText(sentence, 80) }
}

// ───────────────────────────── 最后一来一回 ─────────────────────────────

export interface LastExchange {
  hisTurn: boolean
  /** 他最后说的那句(那家最后那段话之前)。 */
  ask?: SessionTurn
  /** 那家最后那段话(一条消息可能被记成好几段:最后一段往前、同一分钟里都是「最终回答」的并起来)。 */
  answer?: { text: string, at?: string, final: boolean }
}

export function lastExchange(turns: readonly SessionTurn[]): LastExchange {
  const lastIndex = turns.length - 1
  const last = turns[lastIndex]
  if (last === undefined) return { hisTurn: false }
  if (last.k === 'ask') return { hisTurn: true, ask: last }
  const parts: SessionTurn[] = [last]
  let i = lastIndex - 1
  if (last.final === true) {
    const lastMs = last.at === undefined ? Number.NaN : Date.parse(last.at)
    for (; i >= 0; i -= 1) {
      const turn = turns[i]!
      if (turn.k !== 'reply' || turn.final !== true) break
      const ms = turn.at === undefined ? Number.NaN : Date.parse(turn.at)
      if (Number.isFinite(lastMs) && Number.isFinite(ms) && lastMs - ms > 120_000) break
      parts.unshift(turn)
    }
  }
  let ask: SessionTurn | undefined
  for (; i >= 0; i -= 1) {
    const turn = turns[i]!
    if (turn.k === 'ask') { ask = turn; break }
  }
  return {
    hisTurn: false,
    ...(ask === undefined ? {} : { ask }),
    answer: { text: parts.map(part => part.text).join('\n\n'), ...(last.at === undefined ? {} : { at: last.at }), final: last.final === true },
  }
}

// ───────────────────────────── 按内容判 ─────────────────────────────

/** 只看最后这么多字(和 Claude Code 自己那套判断的尺度差不多):在问他的话都在末尾。 */
const TAIL_CHARS = 700

/** 「三个选项」「两条路」这种只报个数的引子,当不了问题。 */
const COUNT_LEAD = /^(?:这里|下面|有|给你|我给)?(?:[一二两三四五六七八九十\d]+)\s*(?:个|条|种|套)?(?:选项|选择|方案|办法|路|条路|做法|方向)[：:]?$/

/** 「有件事需要你定」「要你拍板」:整段话在等他定的那一句(选项前面没有问句时拿它当问题)。 */
const DECIDE_LEAD = /(?:需要|要|请|等)(?:你|您)(?:来)?(?:定|决定|拿主意|拍板|选)|要你定|你定一下|待(?:你|您)?拍板/

interface Candidate {
  kind: SessionAskKind
  rule: string
  sentence: Sentence
  options?: SessionAskOption[]
  question?: string
}

function contentOf(candidate: Candidate, text: string, all: readonly Sentence[], certainty: 'sure' | 'unsure'): ContentVerdict {
  const question = candidate.question ?? speakable(candidate.sentence.raw)
  return {
    waiting: certainty === 'sure',
    certainty,
    kind: candidate.kind,
    ...(question === undefined ? {} : { question }),
    ...(candidate.options === undefined ? {} : { options: candidate.options }),
    quote: lineOf(text, candidate.sentence, all),
    rule: certainty === 'sure' ? candidate.rule : `unsure:${candidate.rule}`,
  }
}

/** 选项那一组的问题:选项前两行里在问的那句 > 整段里「要你定」的那句 > 像样的引子 > 让他选的那一句。 */
function chooseQuestion(group: OptionGroup, all: readonly Sentence[], cue: Sentence): string | undefined {
  const before = all.filter(sentence => sentence.line < group.firstLine)
  const near = before.filter(sentence => sentence.line >= group.firstLine - 2)
  const asked = [...near].reverse().find(sentence => isQuestion(sentence.clean))
  if (asked !== undefined) return speakable(asked.raw)
  const decide = [...before].reverse().find(sentence => DECIDE_LEAD.test(sentence.clean))
  if (decide !== undefined) {
    // 「有件事需要你定:今天的模型额度只剩 0.58 元」→「今天的模型额度只剩 0.58 元」(开头那句「在等你选」已经说了要他定)。
    const topic = decide.clean.replace(/^[^：:]{0,16}(?:需要|要|请|等)(?:你|您)(?:来)?(?:定|决定|拿主意|拍板|选)[^：:]{0,6}[：:]\s*/, '')
    return speakable(topic === '' ? decide.raw : topic)
  }
  // 引子:从选项往上找第一句像样的(「三个选择:」这种只报个数的跳过,往上一句)。
  for (const lead of [...near].reverse()) {
    const cleaned = lead.clean.replace(/[：:]\s*$/, '')
    if (COUNT_LEAD.test(cleaned)) continue
    const said = speakable(cleaned)
    if (said !== undefined) return said
  }
  // 实在只有「你选哪个?回个数字就行」这种:说有几个选项等他选,不拿那句空话当问题。
  if (/^(?:你|您)?(?:选|挑)哪|^回(?:个|一个|复|我)?(?:数字|编号|序号|字母)/.test(cue.clean)) return `有 ${group.options.length} 个选项等你选`
  return speakable(cue.raw)
}

/**
 * 这段话是说给**统筹 / 父会话**听的吗(2026-09-27,卡 WY)。
 *
 * 09-26 那 9 条「等你」里有一条是会话 d4ac442e 写给统筹的汇报(「留一条待拍板:cookie 修…」),
 * 按内容判成了「Claude 在等你点头」。维护者 09-27:「等你」只放他不点头就卡住的事 —— 一张卡
 * 向统筹交差,他点不点头都不影响那张卡往下走,由统筹接着办。
 *
 * 只认**明写了对象**的那几句(分支卡的固定说法),不做语义猜测:猜错的代价是把真的卡住的事吞掉。
 * 光有「待拍板」三个字不算(他自己也会收到「待拍板:悬停亮不亮光」那种问);要「留一条待拍板」
 * 这种交差的说法,或者句子里点了统筹 / 父会话的名。
 */
const TO_BOSS = /(统筹|父会话|主会话接手|留一条待拍板|报可合并|可合并」|「可合并)/

export function toBossLine(sentences: readonly Sentence[]): string | undefined {
  const hit = [...sentences].reverse().find(sentence => TO_BOSS.test(sentence.clean))
  return hit === undefined ? undefined : clipText(hit.raw.trim(), 80)
}

/**
 * 那家最后那段话是不是在等他(与状态无关的那一半)。
 *
 * 1. 他要了东西、那家交了(卡 N 那一条)→ 等你审;
 * 2. 末尾的每一句按类认:要你去做 / 列了选项让你选 / 让你选 / 叫你看 / 要你批 / 在问你;
 * 3. **离末尾近**(最后两句、最后一段,或它后面只剩客套话)的按优先级 做 > 选(带选项)> 选 > 审 > 批 > 问 → 在等你(sure);
 *    只在前面一点出现、后面又接着说了别的(「要我配一个吗?……真正的大头还在…」)→ 拿不准(unsure,可以问模型);
 * 4. 都没有:客套收尾 / 自己接着干 / 汇报 → 不等;末尾几句里夹着问句、「建议下一步」→ 拿不准。
 */
export function judgeContent(answer: string, ask?: string): ContentVerdict {
  const text = answer.replace(/\r\n?/g, '\n')
  const all = sentencesOf(text).filter(meaningfulSentence)
  if (all.length === 0) return { waiting: false, certainty: 'sure', rule: 'empty' }

  // ⓪ 这段话**不是说给他听的**(2026-09-27,卡 WY;设计第五节 C):一张卡写给统筹 / 写给父会话的汇报
  //    (「交回统筹」「留一条待拍板」「可合并」)会被下面几条按内容判成「在等你点头」。对象不是他,就不进「等你」。
  //    只挡**内容上**这一路;形式上的(权限弹窗、提问弹窗)照旧算 —— 那种确实只有他能点。
  const boss = toBossLine(all)
  if (boss !== undefined) return { waiting: false, certainty: 'sure', quote: boss, rule: 'to-boss' }

  // ① 他要了东西、那家交了
  const delivered = reviewPending(ask, text)
  if (delivered !== undefined) {
    return {
      waiting: true, certainty: 'sure', kind: 'review',
      question: clipText(`${delivered.what}在等你审`, 60), quote: delivered.quote, what: delivered.what, rule: 'review:delivered',
    }
  }

  const tailFrom = Math.max(0, text.length - TAIL_CHARS)
  const tail = all.filter(sentence => sentence.end > tailFrom)
  const last = tail[tail.length - 1] ?? all[all.length - 1]!
  const masked = maskFences(text)
  const paragraphBreak = masked.trimEnd().search(/\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/)
  const lastParagraphFrom = paragraphBreak === -1 ? 0 : paragraphBreak
  /** 离末尾近:最后两句、最后一段,或它后面只剩客套话 / 「我先接着做」。 */
  const nearEnd = (sentence: Sentence): boolean => {
    const after = tail.filter(one => one.start > sentence.start)
    return after.length <= 1 || sentence.start >= lastParagraphFrom || after.every(one => CLOSER.test(one.clean) || WORKING.test(one.clean))
  }
  const backwards = [...tail].reverse()
  const candidates: Candidate[] = []

  // 要你去做(叫他看一眼的「请你打开手机看一下效果」算审,不算做;「如果需要你可以…」是假设,拿不准)
  let conditionalDo: Sentence | undefined
  for (const sentence of backwards) {
    const match = firstMatch(DO_PATTERNS, sentence.cue)
    if (match === undefined || negatedBefore(sentence.cue, match.index)) continue
    if (new RegExp(`(?:${REVIEW_VERBS})`).test(sentence.cue) && !new RegExp(`(?:${DO_HARD})`).test(sentence.cue)) continue
    if (conditionalBefore(sentence.cue, match.index)) { conditionalDo ??= sentence; continue }
    candidates.push({ kind: 'do', rule: 'do', sentence })
    break
  }

  // 列了选项让你选 / 让你选
  const chooser = backwards.find(sentence => firstMatch(CHOOSE_PATTERNS, sentence.cue) !== undefined)
  const groups = optionGroups(text)
  const tailFirstLine = masked.slice(0, tailFrom).split('\n').length - 1
  const group = [...groups].reverse().find(one => one.lastLine >= tailFirstLine - 1 || (chooser !== undefined && Math.abs(chooser.line - one.lastLine) <= 3))
  const lastAsksChoice = isQuestion(last.clean) && /哪|选|还是|which|pick|choose/i.test(last.clean)
  if (group !== undefined && (chooser !== undefined || lastAsksChoice)) {
    const cue = chooser ?? last
    const question = chooseQuestion(group, all, cue)
    candidates.push({ kind: 'choose', rule: 'choose:options', sentence: cue, options: group.options, ...(question === undefined ? {} : { question }) })
  }
  else if (chooser !== undefined) {
    candidates.push({ kind: 'choose', rule: 'choose:ask', sentence: chooser })
  }

  // 叫你看 / 审 / 验收
  for (const sentence of backwards) {
    const match = firstMatch(REVIEW_PATTERNS, sentence.cue)
    if (match === undefined || negatedBefore(sentence.cue, match.index) || CLOSER.test(sentence.cue) || conditionalBefore(sentence.cue, match.index)) continue
    candidates.push({ kind: 'review', rule: 'review:ask', sentence })
    break
  }

  // 要你批
  for (const sentence of backwards) {
    const match = firstMatch(APPROVE_PATTERNS, sentence.cue)
    if (match === undefined || negatedBefore(sentence.cue, match.index) || CLOSER.test(sentence.cue)) continue
    candidates.push({ kind: 'approve', rule: 'approve', sentence })
    break
  }

  // 在问你:最后一句像样的话(客套的收尾往前跳)是一个冲着他的问句
  const lastReal = backwards.find(sentence => !CLOSER.test(sentence.cue))
  if (lastReal !== undefined && isQuestion(lastReal.clean) && addressesHim(lastReal.cue)) {
    candidates.push({ kind: 'choose', rule: 'question', sentence: lastReal })
  }

  const near = candidates.filter(candidate => nearEnd(candidate.sentence))
  if (near.length > 0) return contentOf(near[0]!, text, all, 'sure')
  if (candidates.length > 0) {
    // 在前面问了一句、后面又接着说别的:拿不准。取离末尾最近的那一个。
    const latest = [...candidates].sort((a, b) => b.sentence.start - a.sentence.start)[0]!
    return contentOf(latest, text, all, 'unsure')
  }
  if (conditionalDo !== undefined) return { waiting: false, certainty: 'unsure', kind: 'do', rule: 'unsure:conditional-do', quote: lineOf(text, conditionalDo, all) }

  // 不等:客套收尾 / 自己接着干 / 汇报。末尾几句里还夹着问句、「建议下一步」这种的 → 拿不准。
  if (CLOSER.test(last.clean)) return { waiting: false, certainty: 'sure', rule: 'closer' }
  if (WORKING.test(last.clean)) return { waiting: false, certainty: 'sure', rule: 'working' }
  const doubtful = tail.slice(-3).find(sentence => (isQuestion(sentence.clean) && !CLOSER.test(sentence.clean)) || SUGGEST.test(sentence.clean))
  if (doubtful !== undefined) return { waiting: false, certainty: 'unsure', rule: 'unsure:tail', quote: lineOf(text, doubtful, all) }
  return { waiting: false, certainty: 'sure', rule: 'report' }
}

/**
 * 一条会话的事实(读一遍回合就定下来的那些)。文件没动就不必再算,之后只和那家报的状态拼({@link decide})。
 * 原文到这里为止:出去的只有截过的问题、选项、依据那一句。
 */
export function factsOf(input: WaitInput): WaitFacts {
  const exchange = lastExchange(input.turns)
  const facts: WaitFacts = {
    hisTurn: exchange.hisTurn,
    ...(input.pending === undefined ? {} : { pending: input.pending }),
    ...(input.subagent === true ? { subagent: true } : {}),
  }
  if (exchange.answer === undefined) return facts
  return {
    ...facts,
    ...(exchange.answer.at === undefined ? {} : { answerAt: exchange.answer.at }),
    answerFinal: exchange.answer.final,
    content: judgeContent(exchange.answer.text, exchange.ask?.text),
  }
}

// ───────────────────────────── 形式 × 内容 × 状态 ─────────────────────────────

const VERB_ASKS: Readonly<Record<string, string>> = {
  edit: '要改文件',
  test: '要跑测试',
  build: '要构建',
  commit: '要提交改动',
  push: '要推送改动',
  git: '要动代码仓库',
  install: '要装依赖',
  web: '要上网查',
  run: '要跑一条命令',
  read: '要看文件',
  search: '要查找文件',
  agent: '要派助手去做事',
  screen: '要操作电脑界面',
  message: '要给别的会话传话',
}

/** 句首的那一家:「Claude 要…」(英文名后面空一格,同维护者看惯的「派 Codex 去修」);没给名字说「它」。 */
function nameOf(signals: WaitSignals): string {
  const name = signals.agent_name?.trim() || '它'
  return /[A-Za-z0-9]$/.test(name) ? `${name} ` : name
}

/**
 * 弹窗里那一问的**原文**那一格(2026-10-04,卡 `claude/ask-with-context`):一个字不洗、一个字不截 ——
 * `sessionDigest.pendingQuestions` 收字那一处已经按 2000 / 200 / 400 收过口,这里原样端过来。
 *
 * 为什么另起一格而不是把 `question` 放宽:那一句**不止一处在用** —— 来电里念的就是它(`sessionAskRowText`
 * 还要再截到 28)、球下那一区的抬头、卡面上那一行、系统通知。放宽它等于让电话去念一百多字的原文。
 * 两格并存:短的那一句照旧,原文只在她点开那一条时摆。
 */
function fullOf(step: NonNullable<PendingStep['questions']>[number]): SessionAskFullView {
  const options = step.options
    .map(option => ({ label: option.label, ...(option.note === undefined ? {} : { note: option.note }) }))
    .filter(option => option.label.trim() !== '')
  return {
    question: step.question,
    ...(step.header === undefined || step.header.trim() === '' ? {} : { header: step.header }),
    ...(options.length === 0 ? {} : { options }),
  }
}

function questionView(step: NonNullable<PendingStep['questions']>[number] | undefined): { question?: string, options?: SessionAskOption[], quote?: string, full?: SessionAskFullView } {
  if (step === undefined) return {}
  const question = speakable(step.question) ?? (step.header === undefined ? undefined : speakable(step.header))
  const options = step.options
    .map(option => ({ label: clipText(plainLine(option.label), 40), ...(option.note === undefined ? {} : { note: clipText(plainLine(option.note), 60) }) }))
    .filter(option => option.label !== '')
  return {
    ...(question === undefined ? {} : { question }),
    ...(options.length === 0 ? {} : { options }),
    quote: clipText(step.question.trim(), 80),
    full: fullOf(step),
  }
}

/** 形式上的「在等你」:提问弹窗、等批计划、权限弹窗、Kimi 的 blocked。不是 → undefined。 */
function formVerdict(facts: WaitFacts, signals: WaitSignals): WaitVerdict | undefined {
  const pending = facts.pending
  const since = pending?.at ?? signals.status_since ?? facts.answerAt
  const at = since === undefined ? {} : { since }
  if (pending?.kind === 'question') {
    const view = questionView(pending.questions?.[0])
    return { waiting: true, certainty: 'sure', kind: 'choose', question: view.question ?? `${nameOf(signals)}在问你一个问题`, ...(view.options === undefined ? {} : { options: view.options }), ...(view.quote === undefined ? {} : { quote: view.quote }), ...(view.full === undefined ? {} : { full: view.full }), ...at, by: 'form', rule: 'form:question' }
  }
  if (pending?.kind === 'plan') {
    const firstLine = pending.detail?.split('\n').map(line => plainLine(line)).find(line => line !== '')
    return {
      waiting: true, certainty: 'sure', kind: 'approve', question: `${nameOf(signals)}排好了计划,等你批了再动手`,
      ...(firstLine === undefined ? {} : { quote: clipText(firstLine, 80) }),
      /**
       * 等批计划那一条的「原文」就是**那份计划**(2026-10-04):她点开要看的就是它。
       * 上面那一句人话("排好了计划,等你批了再动手")压根没说计划是什么 ——
       * 这正是维护者说的「我都不知道发生了什么」。
       */
      ...(pending.detail === undefined || pending.detail.trim() === '' ? {} : { full: { question: pending.detail } }),
      ...at, by: 'form', rule: 'form:plan',
    }
  }
  const waitingFor = signals.waiting_for?.toLowerCase()
  const permission = signals.reason === 'permission_prompt' || signals.wait_reason === 'approval' || waitingFor?.includes('permission') === true
  if (permission) {
    const what = pending?.kind === 'tool'
      ? (pending.detail !== undefined && CJK.test(pending.detail) ? speakable(pending.detail, 40) : undefined) ?? (pending.verb === undefined ? undefined : VERB_ASKS[pending.verb])
      : undefined
    return {
      waiting: true, certainty: 'sure', kind: 'approve',
      question: what === undefined ? `${nameOf(signals)}要你批准一步操作` : `${nameOf(signals)}${what.startsWith('要') ? what : `要${what}`},等你批准`,
      ...(pending?.kind === 'tool' && pending.detail !== undefined ? { quote: clipText(pending.detail, 80) } : {}),
      ...(pending?.kind === 'tool' && pending.marks !== undefined && pending.marks.length > 0 ? { marks: pending.marks } : {}),
      ...at, by: 'form', rule: 'form:permission',
    }
  }
  if (waitingFor?.includes('input') === true) {
    // Claude 在等他回答(提问弹窗 / 对话框),记录里又没读到那一问:按内容补一句,读不到就说在问你。
    const content = facts.content?.waiting === true ? facts.content : undefined
    return { waiting: true, certainty: 'sure', kind: content?.kind ?? 'choose', question: content?.question ?? `${nameOf(signals)}在问你一个问题`, ...(content?.options === undefined ? {} : { options: content.options }), ...(content?.quote === undefined ? {} : { quote: content.quote }), ...at, by: 'form', rule: 'form:input' }
  }
  /**
   * 那家自己说「在等你」、又没说是等你干什么(Kimi 的 `blocked`、children 里写着 `waiting` 的子任务)。
   *
   * **2026-09-28,卡 KM:这一支要证据**(`signals.formal_wait`)。原来只要「状态 waiting + 说不出等什么」
   * 就挂一个 `by:'form'` 的「停下来等你确认」—— 而 Kimi 每说完一轮就记 `blocked`,于是它每条会话都被说成
   * 「停下来等你确认」,运行状态被改成 waiting(坞上橙色角标),答话那一路还按 `by:'form'` 补一句
   * 「它那边弹了个框等你点」,框是编的。没有证据就不出手:交给内容判断(`by:'rules'`,只挂 ask、不改运行状态)。
   */
  const formal = signals.formal_wait
  if (formal !== undefined && signals.status !== 'running' && signals.wait_reason !== 'input') {
    const content = facts.content?.waiting === true ? facts.content : undefined
    // 说得清是哪一类就说清(卡 KM:「有真审批请求才算等你,并说清是什么」);说不清才回到「停下来等你确认」。
    const plain = formal === 'approval'
      ? `${nameOf(signals)}要你批准一步操作`
      : formal === 'question' ? `${nameOf(signals)}在问你一个问题` : `${nameOf(signals)}停下来等你确认`
    return { waiting: true, certainty: 'sure', kind: content?.kind ?? (formal === 'question' ? 'choose' : 'approve'), question: content?.question ?? plain, ...(content?.options === undefined ? {} : { options: content.options }), ...(content?.quote === undefined ? {} : { quote: content.quote }), ...at, by: 'form', rule: 'form:blocked' }
  }
  return undefined
}

function notWaiting(rule: string, certainty: 'sure' | 'unsure' = 'sure', by: WaitVerdict['by'] = 'rules'): WaitVerdict {
  return { waiting: false, certainty, by, rule }
}

/**
 * 事实 × 那家报的状态 → 在不在等他。顺序:
 * 1. 会话没了(offline)→ 不等;
 * 2. 形式上的(弹窗、等批、blocked)→ 在等你;
 * 3. 在跑 → 不等(它最后那段话是半截旁白,不是在问他);出错 → 不等(出错另有红点);
 * 4. 子任务 → 不按内容判(它的话是说给主会话的);最后一句是他说的 → 不等(球在那家);
 * 5. 按内容:在等你(sure)/ 拿不准(unsure,可以问模型)/ 不等;那句话说完超过 {@link WAIT_MAX_AGE_MS} → 旧的,不等。
 */
export function decide(facts: WaitFacts, signals: WaitSignals = {}): WaitVerdict {
  if (signals.status === 'offline') return notWaiting('offline')
  const form = formVerdict(facts, signals)
  if (form !== undefined) return form
  if (signals.status === 'running') return notWaiting('running')
  if (signals.status === 'error') return notWaiting('error')
  if (facts.subagent === true) return notWaiting('subagent')
  if (facts.hisTurn) return notWaiting('his-turn')
  const content = facts.content
  if (content === undefined) return notWaiting('empty')
  if (signals.now !== undefined && facts.answerAt !== undefined) {
    const age = Date.parse(signals.now) - Date.parse(facts.answerAt)
    if (Number.isFinite(age) && age > WAIT_MAX_AGE_MS) return notWaiting('stale')
  }
  if (!content.waiting) return { waiting: false, certainty: content.certainty, by: 'rules', rule: content.rule, ...(content.quote === undefined ? {} : { quote: content.quote }) }
  return {
    waiting: true,
    certainty: content.certainty,
    ...(content.kind === undefined ? {} : { kind: content.kind }),
    ...(content.question === undefined ? {} : { question: content.question }),
    ...(content.options === undefined ? {} : { options: content.options }),
    ...(facts.answerAt === undefined ? {} : { since: facts.answerAt }),
    ...(content.quote === undefined ? {} : { quote: content.quote }),
    ...(content.what === undefined ? {} : { what: content.what }),
    by: 'rules',
    rule: content.rule,
  }
}

/** 一步到位:回合 + 状态 → 在不在等他(卡 N 核进度时只给回合)。 */
export function judgeWaiting(input: WaitInput, signals: WaitSignals = {}): WaitVerdict {
  return decide(factsOf(input), signals)
}

// ───────────────────────────── 子任务在等他:冒到主会话上 ─────────────────────────────

/**
 * 主会话底下的一个子任务(后台任务),照设计第六节「会话形状加一层 children」那几格里判断要用的:
 * 哪一个、派它时的说明、状态、挂着没结果的那一步。卡 Q 的 `children` 形状合进来之后由它给;之前 waitingService 先从 Claude 的子任务文件读一份。
 */
export interface ChildTask {
  id: string
  /** 派它时的那句说明(Claude 子任务 `.meta.json` 的 description)。 */
  title?: string
  status: 'running' | 'waiting' | 'done' | 'error'
  /** 挂着没结果的那一步(提问 / 批计划 / 别的一步)。 */
  pending?: PendingStep
  /** 最后动的那一刻(ISO)。 */
  updated_at?: string
}

/**
 * 子任务里有没有在等他的。两种:
 * 1. 它自己明着在问(提问弹窗、批计划,或 children 里写着 `waiting`);
 * 2. 主会话停在权限弹窗上(Claude 的子任务要权限时,弹窗挂在主会话上),而这个子任务有一步挂着 —— 就是它要批。
 * 子任务说的话是说给主会话的,不按内容判。
 */
export function childWaitOf(children: readonly ChildTask[], signals: WaitSignals): WaitVerdict | undefined {
  const tag = (child: ChildTask, verdict: WaitVerdict): WaitVerdict => ({ ...verdict, child: { id: child.id, ...(child.title === undefined ? {} : { title: child.title }) } })
  const as = { agent_name: '它' }
  for (const child of children) {
    const explicit = child.pending?.kind === 'question' || child.pending?.kind === 'plan'
    if (!explicit && child.status !== 'waiting') continue
    // children 里只写着「等你」、说不出等什么的:按「停下来等你确认」说,不编问题。
    // 子任务自己写着 `waiting` 就是证据(卡 KM:`formal_wait: 'unspecified'`),与 Kimi 那个「说完一轮也记 blocked」不同。
    const verdict = decide(
      { hisTurn: false, ...(child.pending === undefined ? {} : { pending: child.pending }) },
      { status: 'waiting', formal_wait: 'unspecified', ...as, ...(child.updated_at === undefined ? {} : { status_since: child.updated_at }) },
    )
    if (verdict.waiting) return tag(child, verdict)
  }
  const permission = signals.reason === 'permission_prompt' || signals.wait_reason === 'approval' || /permission/i.test(signals.waiting_for ?? '')
  if (!permission) return undefined
  const stuck = [...children].filter(child => child.pending?.kind === 'tool' && child.status !== 'done')
    .sort((a, b) => (b.pending?.at ?? b.updated_at ?? '').localeCompare(a.pending?.at ?? a.updated_at ?? ''))[0]
  if (stuck === undefined) return undefined
  return tag(stuck, decide({ hisTurn: false, pending: stuck.pending! }, { status: 'waiting', waiting_for: 'permission prompt', ...as }))
}

/**
 * 主会话自己的判断 + 子任务在等他的那一个 → 叠到主会话上的那一个。主会话自己在等他就用它自己的 ——
 * 除非那只是一个权限弹窗、而它挂着的那一步是「派助手」(或没读到):那是子任务要的权限,说清是哪个子任务。
 */
export function withChildWait(own: WaitVerdict, facts: Pick<WaitFacts, 'pending'>, child: WaitVerdict | undefined): WaitVerdict {
  if (child === undefined) return own
  if (!own.waiting) return child
  const unclearPermission = own.rule === 'form:permission' && (facts.pending === undefined || facts.pending.verb === 'agent')
  return unclearPermission ? child : own
}

// ───────────────────────────── 优先级与子任务 ─────────────────────────────

/** 在等你 > 在跑 > 空闲。那家报的「在等」只有判断也说在等才算等(Claude 空闲一分钟就发的 idle_prompt 不算)。 */
export function loadOf(status: SessionStatus | undefined, verdict?: Pick<WaitVerdict, 'waiting'>): SessionLoad {
  if (verdict?.waiting === true) return 'waiting'
  if (status === 'running') return 'running'
  return 'idle'
}

export function heavier(a: SessionLoad, b: SessionLoad): SessionLoad {
  return LOAD_RANK[b] > LOAD_RANK[a] ? b : a
}

export interface LoadEntry {
  key: string
  /** 子任务挂着的主会话的 key(不是子任务就缺席)。 */
  parent?: string
  load: SessionLoad
}

/**
 * 子任务的会话不单算一条,挂到它的主会话下:主会话的分量 = 它自己和它所有子任务里最重的那个。
 * 回来的只有主会话(子任务一条都不出现);主会话不在表里的子任务也不单算(说不清它是谁的,不凭空冒一条)。
 */
export function rollUpLoads(entries: readonly LoadEntry[]): Map<string, { load: SessionLoad, children: string[] }> {
  const out = new Map<string, { load: SessionLoad, children: string[] }>()
  for (const entry of entries) {
    if (entry.parent !== undefined) continue
    out.set(entry.key, { load: entry.load, children: [] })
  }
  for (const entry of entries) {
    if (entry.parent === undefined) continue
    const main = out.get(entry.parent)
    if (main === undefined) continue
    main.load = heavier(main.load, entry.load)
    main.children.push(entry.key)
  }
  return out
}

// ───────────────────────────── 给 /state 的那一格 ─────────────────────────────

/** 答了往哪送(sessionAnswer.ts 定):哪条路 + 送不回去时去哪儿答那一句。 */
export interface AskReply {
  reply: NonNullable<SessionAskView['reply']>
  where?: string
  /** 「去回答」能把那段对话 / 那个 App 调到前面。 */
  reveal?: true
  /**
   * **它明写的那几个选项工作台能替他点**(2026-09-28,卡 WQ;壳的 `agent_press`)。
   * 只在真有选项时才往视图上落(见 {@link askViewOf}):没有选项的时候「能点」没有意义。
   */
  press?: true
  /**
   * **她自己打的那一句也送得进去**(2026-09-28,卡 AT;壳的 `agent_write_ask` 写进面板里那个自由作答框)。
   * 与 `press` 不同:这一格**不要求它明写了选项** —— 她那句话写进面板里那个框,有没有选项都成立。
   */
  write?: true
  /** 权限弹窗那一问(2026-10-01,卡 AP):不摆输入框,读得了 / 读到的那几颗键(见 `SessionAskView.permission`)。 */
  permission?: SessionAskView['permission']
}

export function askViewOf(verdict: WaitVerdict, fallbackSince: string, reply?: AskReply): SessionAskView | undefined {
  if (!verdict.waiting || verdict.kind === undefined) return undefined
  const question = verdict.question ?? '停下来在等你'
  const quote = verdict.quote === undefined ? undefined : clipText(plainLine(verdict.quote), 80)
  const options = verdict.options === undefined || verdict.options.length === 0 ? undefined : verdict.options
  const hasOptions = options !== undefined
  return {
    kind: verdict.kind,
    question,
    ...(options === undefined ? {} : { options }),
    /**
     * **那一问的原文**(2026-10-04,卡 `claude/ask-with-context`):读到了就原样带上,
     * 读不到就缺席 —— 界面照旧摆上面那一句短的。
     */
    ...(verdict.full === undefined ? {} : { full: verdict.full }),
    // 「能替他点」只在真有选项时算数(卡 WQ):没有选项的框上没有一项可点。
    ...(reply?.press === true && hasOptions ? { press: true as const } : {}),
    // 「她自己那句话送得进去」不看有没有选项(卡 AT):面板里那个自由作答框跟选项是两回事。
    ...(reply?.write === true ? { write: true as const } : {}),
    since: verdict.since ?? fallbackSince,
    ...(quote === undefined || quote === '' ? {} : { quote }),
    by: verdict.by,
    ...(verdict.child === undefined ? {} : { child: verdict.child }),
    ...(reply === undefined ? {} : { reply: reply.reply }),
    ...(reply?.where === undefined ? {} : { where: reply.where }),
    ...(reply?.reveal === true ? { reveal: true as const } : {}),
    ...(reply?.permission === undefined ? {} : { permission: reply.permission }),
  }
}

/**
 * 把判断叠到会话表上(出视图时叠一层,同 sessions.ts 的额度叠加:不写进会话记录,答了 / 又跑起来的下一拍自己就消失)。
 *
 * - **形式上**在等你(`by: 'form'` —— 提问弹窗、等他批计划、权限弹窗、那家自己报「blocked」)
 *   → `status: 'waiting'` + `ask`:它**真的卡在那儿动不了了**,运行状态就该是「在等你」。
 *   那家自己没说原因的补一个(批 → `approval`,其余 → `input`);`reason` 缺席时补 `idle_prompt`
 *   (按内容判出来的**不响铃**:响铃规则只认 `permission_prompt`,拍板写死的);
 * - **内容上**在等你(`by: 'rules'` / `'model'` —— 它这一轮说完了,而那段话是在问他 / 让他选 / 让他去做)
 *   → **只挂 `ask`,不动运行状态**(2026-09-26,卡 V 补;见下面那一大段);
 * - 那家报「在等」(Claude 空闲一分钟就发的 `idle_prompt`)而判断说没在等他 → 按空闲摆(`done`);
 * - 自己空闲、子任务还在跑 → 在跑;
 * - 事务官自己的会话(dsh)不碰:她问他的话走卡 M 的外层提问,那边已经数过了。
 *
 * ## 为什么内容判断不动运行状态(2026-09-26,维护者:「现在应该是 3 完成 1 进行中」)
 *
 * 0.4.4 装上之后维护者截图:Claude 标签上是「1 白 + 1 橙」,而他桌面里那四条会话是**一条在跑、三条做完了**。
 * 那颗橙点是这么来的:`修 profile 补丁里 cookie 那一行的 id 写错` 这条**已经说完了**(会话文件最后一条是
 * 最终回答,`~/.claude/sessions/<pid>.json` 也说 `idle`),但它最后那段话里留了一句「要不要提示他重新登…」——
 * 按内容判是「在问他」,于是这里把 `status` 从 `done` 改写成 `waiting`,它就从蓝点那一档挪进了橙点那一档。
 *
 * 两件事被混成了一个字段:
 * - **运行状态**(在跑 / 说完了 / 出错 / 中断):这是会话文件与进程表说的事实,卡 V 判的那一套;
 * - **有没有一问在等他**:这是卡 T 读出来的内容,挂在 `ask` 上。
 *
 * 一条**说完了、顺口问了他一句**的会话,在「几条在跑、几条做完」这个口径里就是**做完了**;
 * 「有一问等你答」另有去处 —— `ask` 已经进了 `src/waiting.ts` 的 `waitingOnHim`(那一堆喂「事务官」标签的
 * 琥珀气泡、球下「等你 n」、手机「等你确认」),**一处都没少**,只是不再占用那家客户端标签上的运行状态档。
 * 形式上真卡住的(`by: 'form'`)照旧改运行状态:那时候它确实动不了。
 */
export function overlayWaiting(
  views: readonly SessionView[],
  verdicts: ReadonlyMap<string, WaitVerdict>,
  childLoads: ReadonlyMap<string, SessionLoad> = new Map(),
  options: { nowSec: number, replyOf?: (view: SessionView, ask: Pick<WaitVerdict, 'by' | 'child' | 'kind' | 'since' | 'quote'>) => AskReply | undefined } = { nowSec: Math.floor(Date.now() / 1000) },
): SessionView[] {
  return views.map((view) => {
    if (view.agent === 'dsh') return view
    const key = `${view.agent}:${view.session_id}`
    const verdict = verdicts.get(key)
    const child = childLoads.get(key) ?? 'idle'
    if (verdict?.waiting === true) {
      const fallbackSince = new Date((options.nowSec - view.elapsed_sec) * 1000).toISOString()
      const ask = askViewOf(verdict, fallbackSince, options.replyOf?.(view, { by: verdict.by, ...(verdict.child === undefined ? {} : { child: verdict.child }), ...(verdict.kind === undefined ? {} : { kind: verdict.kind }), ...(verdict.since === undefined ? {} : { since: verdict.since }), ...(verdict.quote === undefined ? {} : { quote: verdict.quote }) }))
      if (ask === undefined) return view
      const sinceMs = Date.parse(ask.since)
      const elapsed = view.status === 'waiting' || !Number.isFinite(sinceMs) ? view.elapsed_sec : Math.max(0, options.nowSec - Math.floor(sinceMs / 1000))
      /**
       * **按内容判出来的只挂 `ask`,运行状态原样**(2026-09-26,卡 V 补;理由见函数头那一大段)。
       * 一条说完了、顺口问了他一句的会话,在「几条在跑、几条做完」那个口径里就是**做完了**;
       * 「有一问等你答」走 `waitingOnHim`(事务官标签的琥珀气泡、球下「等你 n」、手机「等你确认」),一处都没少。
       */
      if (verdict.by !== 'form') return { ...view, ask }
      return {
        ...view,
        status: 'waiting',
        reason: view.status === 'waiting' && view.reason !== undefined ? view.reason : 'idle_prompt',
        wait_reason: view.wait_reason ?? (ask.kind === 'approve' ? 'approval' : 'input'),
        elapsed_sec: elapsed,
        ask,
      }
    }
    const idleNotice = view.status === 'waiting' && view.reason === 'idle_prompt' && verdict !== undefined && !verdict.waiting
    if (child === 'running' && (view.status === 'done' || idleNotice)) {
      const { wait_reason: _dropped, ...rest } = view
      return { ...rest, status: 'running' }
    }
    if (idleNotice) {
      const { wait_reason: _dropped, ...rest } = view
      return { ...rest, status: 'done' }
    }
    return view
  })
}

// ───────────────────────────── 拿不准时问一次模型(提示词与核对;问与缓存在 waitingService.ts) ─────────────────────────────

export interface WaitModelExchange {
  /** 他最后说的那句(截 300 字)。 */
  ask?: string
  /** 那家最后那段话(截最后 1500 字)。 */
  answer: string
  /** 那家说那段话的时刻(ISO)。 */
  at?: string
}

/** 送去模型的那一段:只有最后一来一回,截过。 */
export function modelExchangeOf(input: WaitInput): WaitModelExchange | undefined {
  const exchange = lastExchange(input.turns)
  if (exchange.answer === undefined) return undefined
  const answer = maskFences(exchange.answer.text).replace(/\s+\n/g, '\n').trim()
  const chars = Array.from(answer)
  const clippedAnswer = chars.length > 1500 ? `…${chars.slice(-1500).join('')}` : answer
  const ask = exchange.ask?.text.trim()
  return {
    ...(ask === undefined || ask === '' ? {} : { ask: clipText(ask, 300) }),
    answer: clippedAnswer,
    ...(exchange.answer.at === undefined ? {} : { at: exchange.answer.at }),
  }
}

/** 按消息缓存的键:同一段话只问一次(内容的哈希,不带会话 id —— 同一句话在哪条会话里都是同一个判断)。 */
export function waitMessageKey(exchange: WaitModelExchange): string {
  return createHash('sha256').update(`${exchange.ask ?? ''}\u0000${exchange.answer}`).digest('hex').slice(0, 32)
}

export function waitModelPrompt(exchange: WaitModelExchange, agentName = 'AI 助手'): { system: string, user: string } {
  return {
    system: '你判断一个 AI 助手的最后一条回复是不是停下来在等用户。只回一个 JSON 对象,不要别的文字,不要代码块。',
    user: [
      `用户最后说的:「${exchange.ask ?? '(没有)'}」`,
      `${agentName} 最后回复(原文,可能截断了开头):`,
      '<<<',
      exchange.answer,
      '>>>',
      '',
      '判断规则:',
      '1. waiting:这条回复停下来等用户 —— 让他选、让他批准或确认、让他亲手去做一件事(点、跑命令、登录、给材料)、让他看或审交出来的东西;用户不回话它就不会往下做。只是汇报做完了、客套地说「有问题随时找我」、说自己接下来要做什么、给一句可做可不做的建议(「如果需要你可以…」「建议下一步…」),都不算。',
      '2. kind:choose(让他选,或回答一个问题)/ approve(问能不能做、要不要继续)/ do(要他亲手去做一件事)/ review(交了东西等他看、审、验收)。不在等就写空串。',
      '3. question:它要用户定 / 做 / 看的那件事本身,一句中文,用「你」称呼用户,不超过 20 个字,不要以「等你」「等他」「问你」开头,不要路径、代码、英文键名(例:「这版能不能先合」「要不要配一个每周清理的定时任务」「在终端里跑一条命令」)。不在等就写空串。',
      '4. options:回复里明写的选项,逐字抄选项本身;没有就空数组。',
      '5. quote:从回复里逐字摘出能证明「在等他」的那一句,不超过 60 个字;不在等就写空串。',
      '',
      '只回:{"waiting":true,"kind":"choose","question":"","options":[],"quote":""}',
    ].join('\n'),
  }
}

function squash(text: string): string {
  return text.replace(/\s+/g, '').replace(/[*`]/g, '')
}

/**
 * 模型回的 JSON → 判断。**依据要逐字核过**:quote 不在原话里 → 整条不算(回 undefined,调用方当「判不出」);
 * 选项只留原话里真有的。模型说不在等 → 不等。
 */
export function parseWaitModelReply(value: unknown, exchange: WaitModelExchange): WaitVerdict | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (raw.waiting === false) return { waiting: false, certainty: 'sure', by: 'model', rule: 'model:no' }
  if (raw.waiting !== true) return undefined
  const kind = typeof raw.kind === 'string' && ['choose', 'approve', 'do', 'review'].includes(raw.kind) ? raw.kind as SessionAskKind : undefined
  const quote = typeof raw.quote === 'string' ? raw.quote.trim() : ''
  if (kind === undefined || quote === '') return undefined
  const haystack = squash(exchange.answer)
  if (!haystack.includes(squash(quote))) return undefined
  // 模型偶尔还是写成「等他看这版行不行」:开头那截去掉、「他」换成「你」(卡片抬头已经说了「在等你…」)。
  const asked = typeof raw.question === 'string'
    ? raw.question.trim().replace(/^(?:在)?(?:等|问|要|请)(?:他|你|用户)(?:的)?(?:去|来)?/, '').replace(/他/g, '你')
    : ''
  const question = asked === '' ? undefined : speakable(asked)
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .filter((one): one is string => typeof one === 'string' && one.trim() !== '')
    .filter(one => haystack.includes(squash(one)))
    .map(one => ({ label: clipText(plainLine(one), 40) }))
  return {
    waiting: true,
    certainty: 'sure',
    kind,
    ...(question === undefined ? {} : { question }),
    ...(options.length === 0 ? {} : { options }),
    ...(exchange.at === undefined ? {} : { since: exchange.at }),
    quote: clipText(quote, 80),
    by: 'model',
    rule: 'model:yes',
  }
}
