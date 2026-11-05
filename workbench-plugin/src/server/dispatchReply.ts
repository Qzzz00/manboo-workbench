/**
 * 派出去的活,**回答怎么从那家的窗口里读回来**(2026-09-24,卡 F「手机远程派活六家」)。
 *
 * 壳那条 `read_reply` 原语只做一件事:在那扇窗的辅助功能树里按文档顺序找到**我们送进去的那一句**
 * (开头带「工作台派活 xxxxxx」的记号),把它**之后**、输入框**之前**的那些文字节点原样交回来。
 * 那一串里除了回答,还夹着界面上的字 —— 时间戳、「复制 / 点赞 / 点踩」、「Worked for 19s」、
 * 「Task completed」、猜你想问的三个问题……这个文件把它们摘掉,拼成一段给人看的回答。
 *
 * **全是纯函数**,每一条规则都来自 2026-09-24 在这台机器上六家真跑出来的那一串(交接第二节贴了原样),
 * 不是猜的。认不出的字**留着**:多留一个按钮字比吞掉半句回答好。
 */
import type { ClientDispatchFamily } from '../protocol.ts'
// 时间戳那一行的判据只有一份(读窗那一层的纯函数),这里复用,不另开一份正则。
import { isStampLine } from './agentWindowModel.ts'
import { acceptanceBlock } from './noteReceipt.ts'

/** 回答最多留多少字(卡上、手机上、电话里念的都是它;全文在那家自己的窗口里)。 */
export const REPLY_MAX_CHARS = 4000

/** 送进去那句话开头的记号。**同一件事项永远同一个记号**(取事项 id 的前 6 位),读回复时靠它找到我们那一句。 */
export function dispatchMarker(taskId: string): string {
  const short = taskId.replace(/^t-/, '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 6)
  return `工作台派活 ${short === '' ? taskId.slice(0, 6) : short}`
}

/** 交代那一句的固定部分(命令行那只手不存送出去的原文,收结果时拿它和规矩那一段拼回「我们的指令」)。 */
export const DISPATCH_NOTE_TEXT = '这是工作台转交的活,做完直接回结果,我在手机上看。'
/** 交代那一句里认得出的那几个字(读回答时靠它分开「他的原话」与「我们加的」)。 */
const DISPATCH_NOTE_KEY = '这是工作台转交的活'

/**
 * 送进那家窗口的那段话。**他的原话一个字不改**,前面一个记号、后面一段交代:
 *
 * - 记号(「【工作台派活 1a2b3c】」):读回复时找得到我们这一句,也让他在那家的对话列表里认得出这是派的活;
 * - 工作目录(挂了项目才有):活在哪个仓库里干,是验收时第一个要问的;
 * - 「他在手机上」:那家要是弹一个"要不要允许"的框,他在外面点不到 —— 请它先别做那一步、在回答里说清楚。
 */
/** 重派 / 退修那一段要交代的几样(2026-10-28,卡「重派派发词带补话与轮次」;拼法见 {@link dispatchPrompt})。 */
export interface DispatchRework {
  /**
   * 这是第几轮。**不另记一本**:卡上 `round` 由服务端在 confirm/done → doing 时 +1(`tasks.move`),
   * 拼派发词那一刻新一轮还没挪状态,所以这里传 `round + 1`。
   */
  round: number
  /** 上一轮交回里认出的可合并号(`可合并 <sha>`)。 */
  merge?: string
  /** 上一轮所在的独立工作区分支(命令行那一轮记在卡上的 `branch`)。 */
  branch?: string
  /** 认不出可合并号 / 分支时,带上一轮交回的开头一句(截断)。 */
  replyHead?: string
  /** 上一轮派发之后新落的用户评论(补话 / 退修要求),原句逐条。 */
  supplements: readonly string[]
}

export function dispatchPrompt(input: { taskId: string, said: string, cwd?: string, project?: string, acceptance?: readonly string[], cli?: { worktree?: string | undefined, branch?: string | undefined, cardFile?: string | undefined }, rework?: DispatchRework }): string {
  const lines = [`【${dispatchMarker(input.taskId)}】${input.said.trim()}`]
  if (input.rework !== undefined) {
    /*
     * ★ **重派 / 退修**(2026-10-28,卡「重派派发词带补话与轮次」;0.4.170 真机第二句的机制洞):
     * 退修那句补话落卡了,可派发词里一个字都没有 —— 执行者原样又报了一遍「可合并」。
     * 轮次、上一轮交回(可合并号 / 分支)、上一轮之后新落的用户评论(原句逐条)都从这里带上。
     *
     * ★ 段落在**交代行之前**:交代那一句之后的内容才算「我们自己的指令」(`instructionOf`),
     * 退修要求被回答复述天经地义,不许因此判「回答里夹带着指令」。
     */
    const rework = input.rework
    const prevBits = [
      rework.merge === undefined ? undefined : `可合并 ${rework.merge}`,
      rework.branch === undefined ? undefined : `分支 ${rework.branch}`,
      rework.merge === undefined && rework.branch === undefined && rework.replyHead !== undefined ? rework.replyHead : undefined,
    ].filter((one): one is string => one !== undefined && one.trim() !== '')
    lines.push('', `这是第 ${rework.round} 轮${prevBits.length === 0 ? '' : `,上一轮交回的是「${prevBits.join(',')}」`}。这些是退修要求,逐条照做:`)
    for (const one of rework.supplements) lines.push(`- ${one}`)
  }
  lines.push('')
  const where = input.cwd === undefined
    ? (input.project === undefined ? '' : `这件事属于「${input.project}」项目。`)
    : `工作目录:${input.cwd}${input.project === undefined ? '' : `(「${input.project}」项目)`}。`
  // 这一句尽量短,**不提"批准 / 确认框"**:2026-09-24 实测,交代写得越长,那家越爱在回答里逐条回应
  // 交代本身(Kimi:「没有任何需要你批准的步骤……」),Manus 还把那句话存成了它记忆里的一条「偏好」
  // —— 那是在他的账号里留了东西。结果要干净,交代就只说结果往哪儿交。
  lines.push(`(${where}${DISPATCH_NOTE_TEXT})`)
  // 协作区(2026-10-21):便签上写了验收就带编号附上,并要回执三态;没写就一字不加(老卡的派活说明不变)。
  const accept = acceptanceBlock(input.acceptance)
  if (accept !== '') lines.push(accept)
  // 命令行那只手(2026-10-22 卡 D):多带三行 —— 仓库(独立工作区绝对路径与分支)、卡文件、交回格式。
  // 窗口手与接口手的说明书不变(cli 字段缺席,一字不加)。
  if (input.cli !== undefined) {
    if (input.cli.worktree !== undefined) {
      lines.push(`仓库:在独立工作区 ${input.cli.worktree} 里改${input.cli.branch === undefined ? '' : `,分支 ${input.cli.branch}`}(不动你正用的那份目录)。`)
    }
    if (input.cli.cardFile !== undefined) lines.push(`卡:先读 ${input.cli.cardFile},按那张卡做,做完交回。`)
    lines.push(CLI_RECEIPT_LINE)
  }
  return lines.join('\n')
}

/** 命令行那只手交回格式的固定一句(断言照它;「做完 / 有异议 / 卡住」开头与回执三态同一个口径)。 */
export const CLI_RECEIPT_LINE = '交回:最后一句话以「做完:」「有异议:」或「卡住:」开头,三五句说清做了什么、改了哪些文件。'


/** 各家都有的界面字(整行等于它才摘)。 */
const COMMON_CHROME = new Set([
  '复制', '复制回复', '点赞', '点踩', '重试', '重新生成', '分享', '编辑', '回复', '更多', '更多选项', '留下心情',
  '从此处创建分支', 'Copy', 'Retry', 'Edit', 'Share', 'Regenerate', 'Like', 'Dislike',
  'ChatGPT said:', 'You said:', 'Claude said:',
  'Task completed', 'Agent todo completed', 'Thinking', '思考中', '已深度思考',
  'Read', 'Write', 'Bash', 'Grep', 'Glob',
  // 折叠 / 展开的按钮字(2026-09-25,卡 O):引导落地派的第一件(Codex,t-371c3ba9),交付物开头夹着「Show more」——
  // 那是 Codex 把长回答折起来时挂的一颗键,读屏树里是单独一截,拼句时跟回答粘成了「Show more已接着原有11屏…」。
  'Show more', 'Show less', 'See more', 'Read more', 'Show all', 'Expand', 'Collapse',
  '显示更多', '显示全部', '查看更多', '查看全部', '展开', '展开全部', '收起',
])

/** 整行像界面字的几种形状:时间戳、「Worked for 19s」、「搜索 1 个关键词,参考 5 篇资料」。 */
const CHROME_PATTERNS: readonly RegExp[] = [
  /^\d{1,2}:\d{2}(:\d{2})?$/,
  /^(worked|working|thought|thinking) for \d+\s*[smh]/i,
  /^已(深度)?思考(（|\()?(用时)?\s*\d+/,
  /^搜索\s*\d+\s*个关键词/,
  /^参考\s*\d+\s*篇资料/,
  /^Ran \d+ commands?/,
]

/**
 * 读到这一行就**到此为止**(它之后是推荐问题、输入区那一排按钮):
 * Manus 的「Task completed」、豆包输入框上面那排「快速 / 图像生成 / 帮我写作…」。
 */
const CUT_AT: Readonly<Partial<Record<ClientDispatchFamily, readonly string[]>>> = {
  manus: ['Task completed'],
  doubao: ['快速', '图像生成', '帮我写作', '解题答疑'],
}

/** 一截标签最多这么长(真机上两三个标签会挤在一个节点里:「豆包 快速」)。 */
const INPUT_BAR_LABEL_MAX = 16

/**
 * 「16:9」「4:3」这种**画面比例**不是时刻(时刻的分钟一定两位)——
 * 加粗会把它单独切成一截,当时间戳剔掉就是吞掉回答里的一截(2026-10-13,卡 F;
 * 这条回话里本来就在说「横版 16:9」)。
 */
const ASPECT_RATIO = /^\d{1,2}\s*[:：]\s*\d$/

/**
 * ★ **输入栏那一排标签**(2026-10-13,卡 F;真机 13:46 派给豆包办公那一条)。
 *
 * 那一条读回来的尾巴是「正在生成图片」「对话」「豆包 快速」—— 状态行加输入框那一块的
 * 模式页签与模型选择,卡上、手机上、电话里念的都是同一格(`client_dispatch.reply`)。
 *
 * **判两样,缺一样都不剔**(所以回答正文里的「豆包」二字一个不动):
 * ① **位置**:只看那一串的**尾巴** —— 壳读回话读到输入框为止(`read_reply` 里那个 `\0INPUT` 记号),
 *    豆包办公那条退路(`readRelayEvidence` 读整扇窗)也只收输入框上面那几行,
 *    所以这一串的尾巴就是**紧挨输入区**的那几个控件;
 * ② **词表**:整截(或整截按空白切开的每一段)都是这一家输入栏上那几个已知标签;
 *    模型标签按**形状**另判(见 {@link MODEL_LABEL}),版本号不写死。
 *
 * 从尾巴往前走,遇到第一截不是标签的就停。
 *
 * ★ **新版豆包的尾巴不一样**(2026-10-13 晚,卡 Q;演示机那台的模型页签写「豆包 2.1 Lite」):
 * 20:55 那单是「调用工具生成图片」+「本地电脑」「项目」「豆包 2.1 Lite」「中」,
 * 20:31 那单中间还夹着「按需确认」。进度行「调用工具生成图片」**照留** ——
 * 接力那一层靠它判「它还在出图」(`videoChain.CHAIN_IMAGE_WORKING_TEXT`)。
 */
const INPUT_BAR_LABELS: Readonly<Partial<Record<ClientDispatchFamily, readonly string[]>>> = {
  /*
   * 真机读出来的那几个:模式页签(对话 / 图像生成 / 帮我写作 / 解题答疑)与模型选择(豆包 / 快速)。
   * ★ 2026-10-13 晚(卡 Q)加上**新版豆包**那几个(演示机 20:55 与 20:31 两单真读到的):
   * 「本地电脑」「项目」「按需确认」与模型标签后面那个「Lite」。
   */
  // ★ 2026-10-13 夜(卡 U):演示机 22:18 那单 reply 是「本地电脑项目按需确认技能插件豆包 2.1 Lite中」—— 多一个「技能插件」。
  doubao: ['对话', '豆包', '快速', '图像生成', '帮我写作', '解题答疑', '本地电脑', '项目', '按需确认', '技能插件', 'Lite'],
}

/**
 * ★ **模型标签那一截**(2026-10-13 晚,卡 Q):新版豆包写「豆包 2.1 Lite」。
 * 判的是「豆包 + 空格 + 数字」那个**形状**,不只列演示机这一个版本号 —— 它下回升级到 2.2 / 3.0 也认得出。
 */
const MODEL_LABEL: Readonly<Partial<Record<ClientDispatchFamily, RegExp>>> = {
  doubao: /^豆包\s+\d[\d.]*(\s+[A-Za-z][\w.-]*)?$/u,
}

/**
 * ★ **模型标签后面那个状态字**(2026-10-13 晚,卡 Q)。
 *
 * 演示机两单的尾巴都是「…豆包 2.1 Lite」+「中」。**只在紧挨着模型标签时才剔**:
 * 正文最后一个字是「中」的真回话(「图我放在素材文件夹中」)不许误伤,
 * 单独一截的「中」前面不是模型标签也照留(那是它自己的字)。
 */
const MODEL_TAIL_CHAR = '中'

function isModelLabel(text: string, family: ClientDispatchFamily): boolean {
  const re = MODEL_LABEL[family]
  return re !== undefined && re.test(text.trim())
}

/** 这一截整个是那家输入栏上的标签吗(按空白切开,每一段都得在词表里;模型标签按形状另判)。 */
export function isInputBarLabel(text: string, family: ClientDispatchFamily): boolean {
  const labels = INPUT_BAR_LABELS[family]
  if (labels === undefined) return false
  const line = text.trim()
  if (line === '' || [...line].length > INPUT_BAR_LABEL_MAX) return false
  if (isModelLabel(line, family)) return true
  return line.split(/\s+/u).every(one => labels.includes(one))
}

/** 那一串尾巴上紧挨输入区的那几截标签剔掉(见 {@link INPUT_BAR_LABELS})。 */
export function dropInputBarTail(lines: readonly string[], family: ClientDispatchFamily): string[] {
  let end = lines.length
  // 先看最后那个「中」:只有紧挨着模型标签的那一个才是界面字(见 {@link MODEL_TAIL_CHAR})。
  if (end >= 2 && (lines[end - 1] as string).trim() === MODEL_TAIL_CHAR && isModelLabel(lines[end - 2] as string, family)) end -= 1
  while (end > 0 && isInputBarLabel(lines[end - 1] as string, family)) end -= 1
  return lines.slice(0, end)
}

/**
 * 读屏用的**播报**:「前缀 + 整段回答」挤在一个节点里(那家给无障碍用的,回答本身在别的节点里还有一份)。
 *
 * 2026-09-25 真系统(0.2.97,事项 t-fc1ed853):Codex 答完那几秒挂着一个「Response complete: 一天有24个小时。」,
 * 连着两次读都在,于是交上去的是「Response complete: 一天有24个小时。\n一天有24个小时。」——多了英文状态字,回答还重了一遍。
 * 灰度(Codex 不在窗口槽里)没读到它:它只在那几秒里、只在窗口在前时出现。
 * 处理:**先放一边**;真回答那几行一行都没有时才用它(去掉前缀)。按家列 + 通用那几种说法。
 */
const ANNOUNCE_PREFIXES: Readonly<Partial<Record<ClientDispatchFamily, readonly string[]>>> = {
  codex: ['Response complete:'],
}
const ANNOUNCE_GENERIC = /^(response complete|response finished|assistant said|assistant responded|chatgpt said|chatgpt responded)\s*[:：]\s*/iu

/** 一行是读屏播报就回播报里的那段回答(可能是空串);不是就 undefined。 */
function announcementOf(line: string, family: ClientDispatchFamily): string | undefined {
  for (const prefix of ANNOUNCE_PREFIXES[family] ?? []) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim()
  }
  const hit = ANNOUNCE_GENERIC.exec(line)
  return hit === null ? undefined : line.slice(hit[0].length).trim()
}

/**
 * 读屏用的**状态字**(整行就是它,不带回答):按家列 + 通用。维护者规矩:不露英文键名 / 内部的东西。
 * 通用那一条认「完成了 / 在生成 / 已复制」这类说法,中英文都认,末尾带不带标点都算。
 */
const A11Y_STATUS: Readonly<Partial<Record<ClientDispatchFamily, readonly string[]>>> = {
  codex: ['Response complete', 'Responding', 'Copied', 'Thinking'],
  // 「正在生成图片」:2026-10-13 13:46 真机读出来的那一行状态(出参考图那一下),不是它说给她听的话。
  doubao: ['已复制', '复制成功', '正在生成图片'],
  kimi: ['已复制', '复制成功'],
}
const A11Y_STATUS_GENERIC = /^(response (complete|finished|stopped)|responding|generating( response)?|thinking|copied( to clipboard)?|message sent|stopped generating|loading|已复制|复制成功|正在生成|生成中|已停止(生成)?|回答完成)[\s.。!！…:：]*$/iu

function isA11yStatus(line: string, family: ClientDispatchFamily): boolean {
  const bare = line.replace(/[\s.。!！…:：]+$/u, '')
  return (A11Y_STATUS[family] ?? []).includes(bare) || A11Y_STATUS_GENERIC.test(line)
}

/**
 * 相邻两行**一模一样**(按 `matchKey` 比:空格、标点不同也算一样)只留一行。
 * 读屏播报、流式输出重画时,同一句会在树里挂两份;交给他的只要一份。
 */
export function dropAdjacentDuplicates(lines: readonly string[]): string[] {
  const out: string[] = []
  let previous = ''
  for (const line of lines) {
    const key = matchKey(line)
    if (key !== '' && key === previous) continue
    out.push(line)
    previous = key
  }
  return out
}

/** 回答末尾"猜你想问"那几行(豆包、Manus 实测都是三条问句)。**连着两条以上**才算,只有一条可能是回答自己在问。 */
function dropTrailingSuggestions(lines: string[]): string[] {
  const isQuestion = (line: string): boolean => /[?？]$/.test(line.trim()) && line.trim().length <= 40
  let tail = 0
  for (let i = lines.length - 1; i >= 0 && isQuestion(lines[i] as string); i -= 1) tail += 1
  return tail >= 2 ? lines.slice(0, lines.length - tail) : lines
}

export interface ExtractedReply {
  /** 拼好的回答;一个字都没有就是空串。 */
  text: string
  /** 回答被截断过(超过 REPLY_MAX_CHARS)。 */
  truncated: boolean
}

/**
 * 比对用:**只留字母、数字、汉字**(2026-09-25,卡 fix/reply-anchor)。
 *
 * 那家的窗口会把我们送进去的话当 markdown 画出来:「- 」变成列表、反引号里的 `**` 变成一行一个「*」、
 * 行内代码被拆成三截 —— 读回来的每一截都不再是我们原话的"子串",只比空白的老办法认不出它们是我们自己那条消息,
 * 于是把我们派活指令的后半截当成了回答(0.2.96 真机 t-a7a07e82,Codex)。去掉所有标点与符号再比,就认得出来。
 */
export function matchKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 一截字**整截**都在我们送进去的那段话里吗(按 `matchKey` 比)。 */
function withinPrompt(key: string, promptKey: string): boolean {
  return key !== '' && promptKey.includes(key)
}

/**
 * 我们自己那条消息在读回来的那一串里**到哪儿为止**(回 `texts` 里第一条不属于它的下标)。
 *
 * 规矩(2026-09-25):**锚点是我们整条消息的末尾,不是开头那一句**。从我们那一句(带记号的那一截)往后看:
 * - 整截都在我们原话里、而且够长(比对串 ≥ 4 个字)→ 是我们的;
 * - 只剩标点符号(「-」「*」「`」)→ 是 markdown 画出来的碎片,算我们的;
 * - 很短、又恰好在我们原话里(≤ 3 个字)→ **先不认**:往后看,后面还有一截"够长的我们的"才算夹在我们消息中间的碎片
 *   (加粗把「做法」切出来那种);后面没有了,它就是回答(「四个。」这种短回答不能被吞掉);
 * - 遇到第一截不在我们原话里的,我们的消息到此为止。
 */
export function ownMessageEnd(texts: readonly string[], prompt: string): number {
  const promptKey = matchKey(prompt)
  const marker = matchKey(dispatchMarkerOf(prompt))
  let end = 0
  for (let i = 0; i < texts.length; i += 1) {
    const raw = (texts[i] as string).replace(/\u0000INPUT/g, '')
    const key = matchKey(raw)
    const isMarker = marker !== '' && key.includes(marker)
    if (i === 0 || isMarker) { end = i + 1; continue }
    if (key === '') continue
    if (key.length >= 4 && withinPrompt(key, promptKey)) { end = i + 1; continue }
    if (withinPrompt(key, promptKey)) continue
    break
  }
  // 末尾那几截纯符号碎片也是我们的(不影响回答:它们拼进回答里也会被摘掉)。
  while (end < texts.length && matchKey(texts[end] as string) === '' && (texts[end] as string).replace(/\u0000INPUT/g, '').trim() !== '') end += 1
  return end
}

/**
 * 送进去那段话里**我们自己加的交代**(他的原话之外):交代那一句、「他的规矩」那一段。
 * 返工那条(「【工作台派活 xxxxxx 返工】打回的原话」)记号之后整条都是我们写的。
 *
 * 交代那一句前头的「工作目录:/Users/…(「X」项目)。」**不算**:那是活在哪儿干,
 * 回答里提到仓库路径天经地义,不能因此判它「抄了我们的指令」。
 */
export function instructionOf(prompt: string): string {
  const lines = prompt.split('\n')
  const at = lines.findIndex(line => line.includes(DISPATCH_NOTE_KEY))
  if (at >= 1) {
    const note = lines[at] as string
    return [note.slice(note.indexOf(DISPATCH_NOTE_KEY)), ...lines.slice(at + 1)].join('\n')
  }
  return prompt.replace(/^\s*【[^】\n]*】/u, '')
}

/** 回答里夹着我们指令里的一截,要多长才算(比对串的字数;汉字一字算一个)。复述一两个词不算。 */
const ECHO_MIN_KEY = 12

/**
 * `reply` 里夹着 `instruction` 里的**哪一句**(2026-09-25)。回夹进来的那一句(给人看的原样),没有就 undefined。
 *
 * 按**整行**比,也按一行里被句读隔开的**每一截**比(规矩一行常常很长,那家只复述半行);
 * 两边都先 `matchKey`(只留字母数字汉字),所以 markdown 画成什么样、标点全角半角都不影响。
 * 卡 K 的自查(「回答里夹着我们自己的指令 = 不合格」)与派活收回答时用的是同一个判据。
 */
export function echoedLine(reply: string, instruction: string): string | undefined {
  const replyKey = matchKey(reply)
  if (replyKey === '') return undefined
  for (const line of instruction.split('\n')) {
    for (const piece of [line, ...line.split(/[。!?！？;；,，:：()（）【】「」]/u)]) {
      const key = matchKey(piece)
      if (key.length >= ECHO_MIN_KEY && replyKey.includes(key)) {
        // 给人看的那一句不带 markdown 记号(它会上卡、上手机;他的规矩:不露 `**` 这类符号)。
        const shown = piece.replace(/[`*]+/gu, '').trim().replace(/^[-·•]\s*/u, '')
        return shown.length > 40 ? `${shown.slice(0, 40)}…` : shown
      }
    }
  }
  return undefined
}

/**
 * 读回来的回答里夹着**我们自己派活指令里的话**(2026-09-25)。回夹进来的那一句,没有就 undefined。
 *
 * 锚点找对了、整行的复述也剥掉了之后,这里应该永远是空的;不空就说明回答和我们那条消息没分开
 * (或者那家把我们的交代抄进了回答),**这一段不能当结果交给他验收**。
 */
export function promptLeaked(reply: string, prompt: string): string | undefined {
  return echoedLine(reply, instructionOf(prompt))
}

/**
 * 把 `read_reply` 交回来的那一串拼成回答。
 *
 * @param texts 壳交回来的文字节点(第一条就是我们那一句,或它的开头)
 * @param prompt 我们送进去的那一整段(用来认出我们自己那条消息到哪儿为止)
 */
export function extractReply(texts: readonly string[], opts: { family: ClientDispatchFamily, prompt: string }): ExtractedReply {
  const promptKey = matchKey(opts.prompt)
  const instructionKey = matchKey(instructionOf(opts.prompt))
  const lines: string[] = []
  /** 整行都在**他的原话**里的那几行(先放一边:回答全是它们时才留,见下)。 */
  const saidEcho = new Set<number>()
  /** 读屏播报里的那段回答(先放一边:真回答一行都没有时才用)。 */
  const announced: string[] = []
  /**
   * Claude 桌面版给**每一条**回答都挂一行「Claude responded: <全文>」(读屏用的)。
   *
   * ★ 2026-09-28(卡 RC)改了取法:**取最后那一行,不是第一行**。09-28 上午那一件
   * (t-eade4c97「验证自我迭代能力」)收回来的结果是「所有核心自我迭代相关的测试全过。再快速扫一眼整套…」
   * —— 那是 Claude **中途**那一条过程话:它自己也挂了一行「Claude responded:」,而这里读到第一行就
   * `return` 了,它后面那段真正的交代(最后在问他「落在哪」)一个字都没进来。
   * 一个回合里有几条消息就有几行,**最后那一行才是最后那一段完整回答**。
   */
  const wholeAnswers: string[] = []
  // 锚点是我们整条消息的末尾(ownMessageEnd),不是开头那一句。
  for (const raw of texts.slice(ownMessageEnd(texts, opts.prompt))) {
    // 折叠键的字偶尔跟回答挤在同一截里(「Show more已接着原有11屏…」):只剥开头那几个字,后面的回答照留。
    const line = raw.replace(/\u0000INPUT/g, '').trim().replace(/^(?:show more|show less|see more|read more|显示更多|查看更多|展开全部)\s*(?=\S)/iu, '')
    if (line === '') continue
    // Claude 桌面版给整段回答挂了一行「Claude responded: <全文>」(读屏用的),它就是那一条回答本身。
    // 先收着往后看 —— 一个回合里有几条消息就有几行,**最后那一行**才是最后那一段完整回答(卡 RC)。
    if (/^Claude responded:\s*/.test(line)) {
      const whole = line.replace(/^Claude responded:\s*/, '').trim()
      if (whole !== '') wholeAnswers.push(whole)
      continue
    }
    if ((CUT_AT[opts.family] ?? []).includes(line)) break
    // 读屏播报(「Response complete: <回答>」)与状态字(「Copied」「已复制」):不是回答本身。
    const announcement = announcementOf(line, opts.family)
    if (announcement !== undefined) { if (announcement !== '') announced.push(announcement); continue }
    if (isA11yStatus(line, opts.family)) continue
    if (COMMON_CHROME.has(line)) continue
    if (CHROME_PATTERNS.some(re => re.test(line))) continue
    /*
     * 整行只有日期 / 星期 / 时刻 = 那条消息头上的时间戳(2026-10-13,卡 F:真机那一条把「今天 13:46」
     * 拼进了回话)。判据用读窗那一层**现成的那一份**(`agentWindowModel.isStampLine`,按形状判不按词表),
     * 不在这里另开一份正则;画面比例那一种形状例外(见 {@link ASPECT_RATIO})。
     */
    if (isStampLine(line) && !ASPECT_RATIO.test(line)) continue
    // Muse 的消息前面会挂「助手消息:」「你:」(读屏用的前缀)。
    if (line === '你:' || line === '你：') continue
    // 回答里夹着我们自己指令里的**整句**(够长的)一律剥掉:那是我们的,不是它答的。
    const key = matchKey(line)
    if (key.length >= 8 && withinPrompt(key, instructionKey)) continue
    // 只剩符号的碎片(markdown 画出来的「*」「`」)不进回答。
    if (key === '' && /^[\s\-*`_~>#|]+$/.test(line)) continue
    // 整行都在他的原话里:多半是我们那条消息没认全剩下的一截,也可能是回答在复述他的问题 —— 都不是答案本身。
    if (key.length >= 8 && withinPrompt(key, promptKey)) saidEcho.add(lines.length)
    lines.push(line.replace(/^助手消息[:：]\s*/, ''))
  }
  // Claude 桌面版那一路:有「Claude responded:」这几行时,最后那一行就是最后那一段完整回答(卡 RC)。
  if (wholeAnswers.length > 0) return cap(wholeAnswers[wholeAnswers.length - 1] as string)
  // 回答**只有**复述他原话的那几行(「把这句原样念一遍」这种活)就留着 —— 不能交一个空回答上去;
  // 真回答一行都没有、只有读屏播报时,用播报里的那段。
  const answer = lines.filter((_, index) => !saidEcho.has(index))
  const chosen = answer.length > 0 ? answer : announced.length > 0 ? announced : lines
  // 尾巴上紧挨输入区的那几截标签(「对话」「豆包 快速」)最后剔一道,见 {@link INPUT_BAR_LABELS}。
  const kept = dropInputBarTail(dropTrailingSuggestions(dropAdjacentDuplicates(chosen)), opts.family)
  return cap(joinFragments(kept))
}

/** 一段话是不是已经说完一句(下一段另起一行)。 */
const SENTENCE_END = /[。！？!?；;：:」』”)）\]】…]$/
/** 下一段是另起的一块(列表、标题、编号)。 */
const BLOCK_START = /^([-*•·]|\d+[.、)]|#{1,6}\s|[(（]?\d+[)）])/

/**
 * 把辅助功能树里的一截一截拼回一段话。**加粗、行内代码会把一句话切成几截**(2026-09-24 实测 Kimi:
 * 「一年有」「4 个季节」「(春、夏、秋、冬)。」是三个节点),一律按换行拼就成了一截一行。
 * 判据:上一截已经说完一句(句号、问号、冒号、右括号……)或者下一截是列表 / 标题,才另起一行;
 * 否则接着拼 —— 两边都是英文字母数字时中间补一个空格,中文直接连上。
 */
export function joinFragments(parts: readonly string[]): string {
  let out = ''
  for (const part of parts) {
    const piece = part.trim()
    if (piece === '') continue
    if (out === '') { out = piece; continue }
    if (SENTENCE_END.test(out) || BLOCK_START.test(piece)) { out += `\n${piece}`; continue }
    const ascii = /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(piece)
    out += ascii ? ` ${piece}` : piece
  }
  return out.trim()
}

function cap(text: string): ExtractedReply {
  if (text.length <= REPLY_MAX_CHARS) return { text, truncated: false }
  return { text: `${text.slice(0, REPLY_MAX_CHARS)}…`, truncated: true }
}

/**
 * 从我们送进去的那段话里把记号取回来(「工作台派活 1a2b3c」)。取不到回空串。
 *
 * 2026-09-27(卡 CB)多认一种:**捎话**那个记号(「事务官捎话 a1b2c3」,`sessionRelay.relayMark`)。
 * 捎话读回话走的是同一条路(壳 `read_reply` 按记号找我们那一句 + 这里摘界面字),而捎话时
 * **他的原话一个字都没存**(轻账那条纪律)—— 所以 `prompt` 给的只有记号本身,
 * `ownMessageEnd` 必须认得出它,否则锚不住我们那一句。两个记号不会同时出现在一段话里。
 */
function dispatchMarkerOf(prompt: string): string {
  const m = /(?:工作台派活|事务官捎话) [0-9a-zA-Z]+/.exec(prompt)
  return m === null ? '' : m[0]
}

/**
 * 回答**稳住了没有**:同一段回答连着两次读回来一字不差、而且那家窗口里没有「停止」键,
 * 才算它说完了。只看一次的话,流式输出读到一半就会被当成结果交上去。
 */
export function replySettled(input: { previous?: string, current: string, busy: boolean }): boolean {
  if (input.busy) return false
  if (input.current.trim() === '') return false
  return input.previous !== undefined && input.previous === input.current
}
