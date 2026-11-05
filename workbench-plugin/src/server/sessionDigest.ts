/**
 * 各家会话读成人话(2026-09-25,卡 P「在跑的会话写清是什么」;卡 N「进度靠证据」共用这一份)。
 *
 * 维护者 09-25 下午原话:「事务官中并没有显示会话的标题和内容」—— 电脑事务官页上两张
 * 「Claude · 进行中 · 14 分钟 / Claude 的一条会话 / 等待下一次进度回传」,一个字的内容都没有。
 * 根因:Claude 那两条是**没装 hook 的机器上从会话文件捞回来的**(claudeSessionRecover),捞的时候
 * 只判了「还在跑」,标题、在做什么一概没读;Codex 新版会话文件(`item_completed` / `response_item`)
 * 里第一句要求的写法也变了,老的读法读不到。
 *
 * 这个文件只做一件事:**给一段会话记录(头一段 + 尾一段),说出三样东西**——
 *
 * 1. **标题**:那家自己的标题(Claude 桌面 App 的会话名 / `custom-title`;Codex `thread_name`;
 *    Kimi 生成好的标题);没有就取他那条会话**第一句要求的前 20 来字**;
 * 2. **最近在做什么**:从最后几条记录里挑一句人话 + 那一刻(界面写「· 3 分钟前」)。
 *    挑法按可信度:它自己说的那句旁白 / 正在做的那一步计划 > 带中文说明的那一步操作 > 按操作种类说一句
 *    (「在改文件」「在跑测试」)。**不出现工具名、路径、英文键名、`**` 这类记号**(维护者规矩第 3 条);
 *    读不到就缺席 —— 界面写「读不到它在做什么」,不写占位话;
 * 3. **最近几轮**:一轮 = 他说的一句 + 它这一轮最后说的 + 这一轮做了什么(**数出来的**:
 *    「改了 3 个文件、跑了 2 次测试」),点开会话时给他看。
 *
 * 纪律:
 * - **不经模型**。全是从记录里挑、数、截出来的(「不经模型的地方坚决不经模型」);
 * - **只读、不存原文**:这里出去的都是截过的人话,原文不进 /state、不落盘;
 * - **头尾各读一段、有上限**(`readSessionDigest`):会话文件几十 MB 很常见(统筹那条 38MB),
 *   标题在头上、最近几轮在尾上,中间那一大段不碰;
 * - 认不出的记录一律跳过,不猜(D13)。三家的记录格式都是**未公开的**,换版本就可能变:
 *   认不出时宁可缺席,也不拿半截字段拼一句像样的话。
 *
 * 三家会话文件的形状(2026-09-25 真机实测,Claude Code 2.1.280 / Codex Desktop 0.155 / Kimi 桌面版 wire 1.4):
 * - Claude `~/.claude/projects/<目录>/<id>.jsonl`:`user` / `assistant`(content 块:text / tool_use / tool_result / thinking)、
 *   `custom-title`、`last-prompt`、`summary`;人说的话 `origin.kind === 'human'`(子任务回报是 `task-notification`)。
 * - Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`:新版 `event_msg.item_completed`(UserMessage / AgentMessage /
 *   CommandExecution / FileChange / McpToolCall …)+ `response_item`;老版 `event_msg.user_message` / `agent_message` /
 *   `exec_command_begin`。开头几条 `role:user` 是注入的上下文(`<environment_context>` 等),不是他说的话。
 * - Kimi 桌面版 `…/kimi-code/home/sessions/…/wire.jsonl`:`turn.prompt`、`context.append_loop_event`
 *   (content.part / tool.call / step.end)、`tools.update_store`(key `todo`)。
 */
import { open, stat } from 'node:fs/promises'

/**
 * 会话记录是哪一种**文件格式**(不是「哪一家」:哪一家按字符串处理,由调用方登记 —— 卡 Q 做运行时自动发现,
 * 新接进来的一家只要它的记录是这几种格式之一就能直接读;新格式在这里加一个读法)。
 */
export type DigestFormat = 'claude-transcript' | 'codex-rollout' | 'kimi-wire'

/** 最近在做什么:一句人话 + 那一刻(ISO)。 */
export interface DigestActivity {
  line: string
  at: string
}

/** 一轮 = 他说一句 + 它这一轮干的。字段各自可缺(尾巴窗口从一轮中间切进来时没有 ask)。 */
export interface DigestRound {
  /** 他那句话(人话,去掉系统注入 / 标签 / 路径,截 80 字)。 */
  ask?: string
  /** 它这一轮最后说的(截 120 字);已登记原件可保留最终答复原字，其余默认人话摘要。 */
  reply?: string
  /** 这一轮做了什么,数出来的(「改了 3 个文件、跑了 2 次测试」)。 */
  did?: string
  /** 这一轮最后一条可认记录的时刻(ISO)。 */
  at?: string
}

export type DigestTitleSource = 'name' | 'custom' | 'summary' | 'first_ask' | 'first_reply' | 'image'

/**
 * **最后一条可认记录说明这条会话停在哪儿**(2026-09-25,卡 V「会话状态说真话」)。
 *
 * 原来状态是**按会话文件最近有没有改动猜**的(claudeSessionRecover 的 `looksRunning`:末尾那条
 * `stop_reason !== 'end_turn'` 就算在跑),于是 09-25 晚维护者屏上三张 Claude 卡都写「进行中」——
 * 其中两条是能力体检用 `claude -p` 探的一句,命令行没登录,一条 `authentication_failed` 的记录就结束了。
 * 那条记录的 `stop_reason` 是 `stop_sequence`,不是 `end_turn`,于是被当成「还在干活」挂了 53 分钟。
 *
 * 现在**从记录本身判**,五种:
 * - `ended`   这一轮说完了(它给出了最终回答);
 * - `failed`  这一轮是**报错**结束的(带原文,人话由 src/humanError.ts 翻);
 * - `aborted` 这一轮被**掐断**了(他按了停 / 上游撤回);
 * - `working` 最后一条是它在干活(工具调用、旁白、计划);
 * - `asked`   最后一条是**他说的话**——它还没开口(要么正在想,要么写到这儿就没人写了)。
 *
 * `working` / `asked` 到底是「在跑」还是「中断」,要再看**还有没有进程在写这个文件**(见 sessionOutcome.ts)——
 * 光看记录分不出来,而这正是原来「按修改时间猜」的那一半错误。
 */
export type SessionMark = 'ended' | 'failed' | 'aborted' | 'working' | 'asked'

/** 这一轮报错结束时,原文留在这里(英文原样)。人话由 src/humanError.ts 翻,原文进「看原始」。 */
export interface DigestFailure {
  /** 那家自己的错误码(Claude `error` 字段:`authentication_failed` / `rate_limit` …)。 */
  code?: string
  /** 那条记录里的原话(英文原样,截 200)。**只用于翻人话与「看原始」,不直接上界面。** */
  raw?: string
}

/** 报错原文最长留多少(「看原始」里够看清是哪一类,又不至于把一大段日志搬进 /state)。 */
export const FAILURE_RAW_MAX = 200

export interface SessionDigest {
  format: DigestFormat
  /** 从记录里读到的会话 id(读不到时缺席,调用方用文件名 / 自己知道的 id)。 */
  session_id?: string
  title?: string
  title_source?: DigestTitleSource
  cwd?: string
  activity?: DigestActivity
  /** 最近几轮,旧 → 新。 */
  rounds: DigestRound[]
  /** 最后一条可认记录说明「这一轮说完了」(Claude end_turn / Codex task_complete / Kimi step.end end_turn)。 */
  ended?: boolean
  /**
   * 最后一条可认记录停在哪儿(2026-09-25,卡 V)。一条可认记录都没有 → 缺席,**不猜**。
   * `ended` 是它的旧名(只分「说完了 / 没说完」),留着不动:卡 N 的证据评估与老用例都读它。
   */
  mark?: SessionMark
  /** `mark === 'failed'` 时的原文(英文)。 */
  failure?: DigestFailure
  /** 最后一条可认记录的时刻(ISO)。 */
  last_at?: string
  /** 这一轮他开口的那一刻(尾巴里最后一句他的话;没有就缺席)。「进行中 · n 分钟」从这里算。 */
  turn_at?: string
  /**
   * **形式上的等待信号**(2026-09-25,卡 V;内容上的判断归卡 T,这里只报「文件里有没有这个信号」):
   * 记录里明写着它停下来在等人 —— Kimi `ApprovalRequest`(等批准)/ `QuestionRequest`(在问他)。
   * Claude 的权限弹窗**不写进会话文件**(78 份真机文件里一条都没有),只走 hook(Notification),
   * 所以 Claude 这一格永远缺席 —— 缺席 = 「文件里没有形式信号」,不等于「不在等他」。
   */
  formal_wait?: 'approval' | 'question'
}

/** 标题「前 20 来字」(卡 P 任务书原话)。那家自己的正式标题放宽到 40。 */
export const TITLE_FROM_ASK_MAX = 20
export const TITLE_MAX = 40
export const ACTIVITY_MAX = 36
export const ROUND_ASK_MAX = 80
export const ROUND_REPLY_MAX = 120
export const DIGEST_ROUNDS = 6

// ───────────────────────────── 人话 ─────────────────────────────

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/u
const CJK_GLOBAL_RE = /[\u3400-\u9fff\uf900-\ufaff]/gu

/**
 * 整段就是注入进来的(系统提醒、子任务回报、斜杠命令展开、压缩摘要、Codex 开头那几段上下文)——
 * 这些都不是他说的话,也不是它在做的事。前缀匹配足够:它们都是固定模板开头。
 */
const INJECTED_PREFIXES = [
  '<system-reminder', '<task-notification', '<local-command', '<command-', '<user-prompt-submit-hook',
  '<bash-input', '<bash-stdout', '<bash-stderr', 'Caveat:', 'This session is being continued',
  'Base directory for this skill', '[Image', '[Request interrupted',
  '<environment_context', '<user_instructions', '<recommended_plugins', '<app-context', '# AGENTS.md',
  '<permissions', '<skills_instructions', '<multi_agent', '<turn_aborted', 'The following is the Codex agent history',
] as const

export function isInjectedText(text: string): boolean {
  const trimmed = text.trimStart()
  return INJECTED_PREFIXES.some(prefix => trimmed.startsWith(prefix))
}

/** 夹在正文里的标签块:Kimi 的 `<meta …/>`、`<attachment>…</attachment>`,Claude 偶尔夹的 `<system-reminder>…</system-reminder>`。 */
export function stripTagBlocks(text: string): string {
  return text
    .replace(/<(system-reminder|attachment|task-notification|command-[a-z]+|local-command-[a-z]+)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<meta\b[^>]*\/>/g, ' ')
}

/** 行首的派活标签(「【工作台派活 371c3b】」)是我们自己打的记号,不是他的话。 */
export function stripLeadingTags(text: string): string {
  return text.replace(/^\s*(?:【[^】\n]{1,24}】\s*)+/, '')
}

/**
 * 一个「脏」片段 = 不许露给他的东西:网址、路径、文件名、代码标识符、英文键名、提交号 / 会话号、工具名、命令行开关。
 * 挑一句人话时**截在第一个脏片段之前**,再退回上一个分句边界(见 cleanSentence)——
 * 「确认这张界面的上下文,使用 `ben-work-context` 技能」→「确认这张界面的上下文」。
 */
const DIRTY_PATTERNS: readonly RegExp[] = [
  /https?:\/\/\S+/i,
  /<\/?[A-Za-z][^>]*>/,
  // 路径:/…、~/…、./…、../…
  /(?:^|[\s(（[「『"'“‘=:：,，、])(?:~|\.{1,2})?\/[^\s，。、；：）)」』"'”’]*/,
  // a/b 形的相对路径(斜杠前那一段至少有一个字母)。只从一段的开头试、字母前只收数字点横线 ——
  // 写成两个 `[\w.-]*` 夹一个字母的话,一长串没有斜杠的字母(base64、压缩过的代码)会回溯成三次方,卡住服务。
  /(?<![\w.-])[\d.-]*[A-Za-z_][\w.-]*\/[\w./-]+/,
  // 文件名
  /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|swift|py|sh|zsh|ya?ml|toml|html?|css|txt|log|plist|lock|png|jpe?g|gif|pdf|docx?|pptx?|xlsx?|csv|sqlite|db|dmg|zip|apk|tgz)\b/i,
  // snake_case / SCREAMING_CASE
  /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/,
  // camelCase
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/,
  // 三段以上的 PascalCase(ButlerTaskStage);两段的多是产品名(WeChat、DeepSeek、GitHub),放过
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+){2,}\b/,
  // kebab-case 三段以上(ben-work-context、会话号的一截)
  /\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/,
  // a.b 形的标识符(state.sessions、item.external)
  /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*(?:\.[\w$]+)*\b/,
  // 命令行开关
  /(?:^|\s)--?[A-Za-z][\w-]*/,
  // 提交号 / 会话号(十六进制、带字母也带数字、七位以上)
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/,
  // 工具名(只认首字母大写的写法:英文旁白里的 read / edit 是动词,放过)
  /\b(?:Bash|Think|Grep|Glob|MultiEdit|NotebookEdit|WebFetch|WebSearch|TodoWrite|ToolSearch|SendMessage|AskUserQuestion|TaskStop|Read|Edit|Write)\b/,
  /\b(?:exec_command|apply_patch|update_plan|tool_use|tool_result)\b/,
]

/** 反引号里的东西:含中文、又不像路径 / 标识符的留字(`工作台`),其余整段算脏。 */
function unwrapInlineCode(sentence: string): string {
  return sentence.replace(/`([^`\n]{1,40})`/g, (whole, inner: string) => {
    if (CJK_RE.test(inner) && !/[/\\._]/.test(inner)) return inner
    return '\u0000' // 占位:下面把它当脏片段处理
  })
}

function firstDirtyIndex(sentence: string): number {
  let first = sentence.indexOf('\u0000')
  if (first === -1) first = Number.POSITIVE_INFINITY
  for (const pattern of DIRTY_PATTERNS) {
    const match = pattern.exec(sentence)
    if (match !== null) {
      // 路径那条会连带吃进前面一个分隔符,位置往后挪到路径本身
      const lead = match[0].length - match[0].trimStart().length
      const index = match.index + (/^[\s(（[「『"'“‘=:：,，、]/.test(match[0]) ? Math.max(1, lead) : 0)
      if (index < first) first = index
    }
  }
  return Number.isFinite(first) ? first : -1
}

/** 有多少「意思」:汉字一个算一份,英文单词一个算两份。 */
function meaningful(text: string): number {
  const cjk = text.match(CJK_GLOBAL_RE)?.length ?? 0
  const words = text.match(/[A-Za-z]{2,}/g)?.length ?? 0
  return cjk + words * 2
}

const CLAUSE_BOUNDARY = /[，,、；;：:]/
const TRAILING_JUNK = /[\s，,、；;：:（(「『“‘"'\-—–=+*#>|~^\\/]+$/u
const LEADING_JUNK = /^[\s，,、；;：:。.！!？?）)」』”’"'\-—–*#>|~^]+/u

/** 一句话洗干净:去 markdown 记号、截在第一个脏片段前、退回上一个分句边界。洗完没意思了就 undefined。 */
function cleanSentence(raw: string, minMeaning: number): string | undefined {
  let sentence = unwrapInlineCode(raw)
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .replace(/[`]/g, '')
  const dirty = firstDirtyIndex(sentence)
  if (dirty !== -1) {
    let cut = sentence.slice(0, dirty).replace(TRAILING_JUNK, '')
    // 截断落在一个分句中间时,退回上一个分句边界(那半截通常是「使用」「见」这种没说完的话)。
    const chars = Array.from(cut)
    for (let i = chars.length - 1; i > 0; i--) {
      if (CLAUSE_BOUNDARY.test(chars[i]!)) {
        const before = chars.slice(0, i).join('').replace(TRAILING_JUNK, '')
        if (meaningful(before) >= 4) cut = before
        break
      }
    }
    sentence = cut
  }
  sentence = sentence.replace(/\u0000/g, '').replace(/\s+/g, ' ').replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '').trim()
  return meaningful(sentence) >= minMeaning ? sentence : undefined
}

/** 按字(码点)截断,带「…」。 */
export function clip(text: string, max: number): string {
  const chars = Array.from(text.trim())
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(1, max - 1)).join('').replace(/[\s，,、；;：:。.]+$/u, '')}…`
}

/**
 * 一段(可能很长、带 markdown 与代码的)文字 → 一句能给他看的人话。
 *
 * 逐句找:第一句洗完还有意思的就用它(「现在 15:13。先说结论:……」第一句只剩「现在」,跳到第二句)。
 * 表格行、分隔线、代码块整段不看。都洗没了就 undefined —— 调用方换下一个来源,别拿空话凑。
 *
 * `minMeaning`:一句至少要有多少「意思」(汉字一个一份、英文单词一个两份)才算数。
 * 它的旁白默认 3(「好的。」「现在 15:13。」这种跳过,「改好了。」留下);**他说的话**给 1 —— 「可以」「修一下」就是他的原话。
 */
export function humanize(raw: unknown, max: number, minMeaning = 3): string | undefined {
  for (const clean of cleanSentences(raw, minMeaning)) return clip(clean, max)
  return undefined
}

/**
 * 同 {@link humanize},但**接着往下拼**直到够长(标题、他那句话、它那一轮的回答用这个):
 * 「修复会话来源\n不要猜状态」→「修复会话来源，不要猜状态」。句与句之间:前一句没有句末标点就补一个「，」。
 */
export function humanizeText(raw: unknown, max: number, minMeaning = 3): string | undefined {
  let out = ''
  for (const clean of cleanSentences(raw, minMeaning)) {
    out = out === '' ? clean : /[。！？!?…]$/u.test(out) ? `${out}${clean}` : `${out}，${clean}`
    if (Array.from(out).length >= max) break
  }
  return out === '' ? undefined : clip(out, max)
}

/**
 * 一句最多看多少个字符。给他看的一句最长一百来字;再长的「一句」是没有句末标点的一大段(贴进来的日志、
 * base64、压缩过的代码),只看开头这一截 —— 几条脏片段的正则在超长的一段上是平方级的,不设限会卡住服务。
 */
const SENTENCE_SCAN_MAX = 1000

/** 超长的一句只留开头一截;截断处落在一个英文片段中间的话,把那半截去掉(半截的 `foo.t` 会被错认成别的东西)。 */
function boundSentence(sentence: string): string {
  if (sentence.length <= SENTENCE_SCAN_MAX) return sentence
  let end = SENTENCE_SCAN_MAX
  // 截在代理对中间的话退一格
  const last = sentence.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  const next = sentence.charCodeAt(end)
  if (next > 0x20 && next < 0x7f) {
    while (end > 0) {
      const code = sentence.charCodeAt(end - 1)
      if (!(code > 0x20 && code < 0x7f)) break
      end -= 1
    }
  }
  return sentence.slice(0, end)
}

/** 一段文字逐句洗干净(见 cleanSentence),按原顺序给出洗完还有意思的那些句子。 */
function* cleanSentences(raw: unknown, minMeaning: number): Generator<string> {
  if (typeof raw !== 'string' || raw.trim() === '') return
  const text = stripLeadingTags(stripTagBlocks(raw)).replace(/```[\s\S]*?(?:```|$)/g, '\n')
  const lines = text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('|') && !/^[-=*_]{3,}$/.test(line) && !isInjectedText(line))
    .map(line => line.replace(/^(?:#{1,6}\s+|>\s*|[-*+•]\s+|\d{1,2}[.)、]\s*)/, ''))
  for (const line of lines) {
    for (const sentence of line.split(/(?<=[。！？!?])\s*/u)) {
      const clean = cleanSentence(boundSentence(sentence), minMeaning)
      if (clean !== undefined) yield clean
    }
  }
}

// ───────────────────────────── 操作种类 ─────────────────────────────

/** 一步操作属于哪一类(用来说「在做什么」与数「做了什么」)。 */
export type ToolVerb =
  | 'read' | 'edit' | 'test' | 'build' | 'commit' | 'push' | 'git' | 'install' | 'search' | 'web'
  | 'run' | 'agent' | 'ask_user' | 'screen' | 'plan' | 'message' | 'wait' | 'other'

/** 此刻在做这一类时说的那句(不出现工具名)。 */
export const VERB_NOW: Record<ToolVerb, string> = {
  read: '在看文件',
  edit: '在改文件',
  test: '在跑测试',
  build: '在构建',
  commit: '在提交改动',
  push: '在推送改动',
  git: '在看改动记录',
  install: '在装依赖',
  search: '在查找',
  web: '在查网页',
  run: '在跑命令',
  agent: '派了助手去做事',
  ask_user: '在等你回答一个问题',
  screen: '在操作电脑界面',
  plan: '在排步骤',
  message: '在给别的会话传话',
  wait: '在等后台的结果',
  other: '在用别的工具',
}

/** 数「这一轮做了什么」时的说法与先后(重要的在前,最多说三样)。 */
const VERB_DID: readonly { verb: ToolVerb, say: (n: number) => string }[] = [
  { verb: 'edit', say: n => `改了 ${n} 个文件` },
  { verb: 'test', say: n => `跑了 ${n} 次测试` },
  { verb: 'build', say: n => `构建了 ${n} 次` },
  { verb: 'commit', say: n => `提交了 ${n} 次` },
  { verb: 'push', say: n => `推送了 ${n} 次` },
  { verb: 'agent', say: n => `派了 ${n} 次助手` },
  { verb: 'screen', say: n => `在界面上操作了 ${n} 步` },
  { verb: 'web', say: n => `查了 ${n} 次网页` },
  { verb: 'ask_user', say: n => `问了你 ${n} 次` },
  { verb: 'run', say: n => `跑了 ${n} 条命令` },
  { verb: 'read', say: n => `看了 ${n} 个文件` },
  { verb: 'search', say: n => `查找了 ${n} 次` },
]

/** 一条命令行属于哪一类。连着好几段的(`cd x && git status && …`)按最「重」的那一段算。 */
export function classifyCommand(raw: unknown): ToolVerb {
  if (typeof raw !== 'string' || raw.trim() === '') return 'run'
  const cmd = raw.replace(/\s+/g, ' ')
  if (/\b(?:vitest|jest|pytest|mocha|playwright test|go test|cargo test|swift test|xcodebuild test)\b|\b(?:npm|pnpm|yarn)(?: run)? test\b|run-(?:web-)?tests\.sh|\btest\.sh\b/.test(cmd)) return 'test'
  if (/\bgit\b(?: -C \S+)? commit\b/.test(cmd)) return 'commit'
  if (/\bgit\b(?: -C \S+)? push\b/.test(cmd)) return 'push'
  if (/\b(?:tsc|tsdown|webpack|esbuild|swiftc|xcodebuild|gradlew?|cargo build|go build|make)\b|\bvite build\b|\b(?:npm|pnpm|yarn)(?: run)? build\b|build\.sh\b|typecheck\b/.test(cmd)) return 'build'
  if (/\b(?:npm|pnpm|yarn) (?:install|add|i)\b|\bpip3? install\b|\bbrew install\b/.test(cmd)) return 'install'
  if (/\bgit\b/.test(cmd)) return 'git'
  const head = cmd.replace(/^(?:cd \S+ (?:&&|;) ?)+/, '').replace(/^(?:taskpolicy -c \w+ |nice -n \d+ )+/, '').trim()
  if (/^(?:cat|head|tail|less|more|nl|wc|sed -n|bat|open)\b/.test(head)) return 'read'
  if (/^(?:grep|rg|find|fd|ls|tree|ag)\b/.test(head)) return 'search'
  if (/^(?:curl|wget)\b/.test(head)) return 'web'
  return 'run'
}

/**
 * 一步工具调用属于哪一类。Claude / Kimi 的工具名几乎一样(Read、Edit、Bash…),DSH 是小写(read、edit、bash、
 * str_replace_editor)—— 不分大小写认。
 */
export function classifyTool(name: unknown, input: unknown): ToolVerb {
  if (typeof name !== 'string') return 'other'
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  if (/^str_replace_editor$/i.test(name)) return args.command === 'view' ? 'read' : 'edit'
  if (/^(?:read|notebookread|readmediafile|readfile|read_file|view_image|view)$/i.test(name)) return 'read'
  if (/^(?:edit|multiedit|write|notebookedit|strreplace|writefile|write_file|editfile|edit_file|apply_patch)$/i.test(name)) return 'edit'
  if (/^(?:bash|shell|exec_command|runcommand|run_command)$/i.test(name)) return classifyCommand(args.command ?? args.cmd)
  if (/^(?:grep|glob|ls|search|findfiles|find_files|list_dir)$/i.test(name)) return 'search'
  if (/^(?:websearch|webfetch|fetchurl|fetch|web_search|web_fetch)$/i.test(name)) return 'web'
  if (/^(?:task|agent|agentswarm|spawn_agent|followup_task|wait_agent)$/i.test(name)) return 'agent'
  if (/^(?:askuserquestion|exitplanmode|request_user_input(?:_async)?)$/i.test(name)) return 'ask_user'
  if (/^(?:todowrite|todolist|update_plan|taskcreate|taskupdate)$/i.test(name)) return 'plan'
  if (/^(?:sendmessage|send_message)$/i.test(name)) return 'message'
  if (/^(?:monitor|taskoutput|wait)$/i.test(name)) return 'wait'
  if (/computer|browser|chrome|screenshot/i.test(name)) return 'screen'
  return 'other'
}

/** 一步工具调用此刻在做什么(一句人话,不出现工具名)。带中文说明的直接用说明。 */
export function activityOfTool(name: unknown, input: unknown): string {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  if (typeof args.description === 'string' && CJK_RE.test(args.description)) {
    const line = humanize(args.description, ACTIVITY_MAX)
    if (line !== undefined) return line
  }
  return VERB_NOW[classifyTool(name, args)]
}

// ───────────────────────────── 三家记录 → 同一种事件 ─────────────────────────────

/**
 * 三家的记录先翻成同一种事件,后面的轮次 / 在做什么 / 标题一份代码。
 * `o`:这条事件出自文件里哪一行(那一行开头的字节偏移;只有按行带偏移读进来时才有 —— 完整对话的分页与附件定位用它)。
 */
export type DigestEvent = DigestEventBody & { o?: number }
type DigestEventBody =
  | { k: 'ask', text: string, image: boolean, at?: string }
  | { k: 'say', text: string, final: boolean, at?: string }
  | { k: 'tool', verb: ToolVerb, files: readonly string[], detail?: string, at?: string }
  | { k: 'plan', text: string, at?: string }
  | { k: 'end', at?: string }
  // 卡 V:报错结束 / 被掐断 / 形式上停下来等人。这三种原来一概没有,于是「出错」与「中断」都被读成「在跑」。
  | { k: 'fail', code?: string, raw?: string, at?: string }
  | { k: 'abort', at?: string }
  | { k: 'wait', formal: 'approval' | 'question', at?: string }

export interface ParsedMeta {
  sessionId?: string
  cwd?: string
  customTitle?: string
  summaryTitle?: string
  lastPrompt?: string
  /** 这条会话是不是子任务派出来的(Claude `isSidechain`、Codex `session_meta.payload.source.subagent`)。 */
  subagent?: boolean
  /** 子任务挂在哪条主会话下(Claude 子任务记录里的 `sessionId`;Codex `parent_thread_id`)。卡 T:子任务不单算一条。 */
  parentId?: string
  /** 这条会话是从哪儿开的(Claude `entrypoint`:claude-desktop / cli…;Codex `source`:vscode / cli / exec)。卡 T:答了往哪送。 */
  entry?: string
}

export interface Parsed {
  meta: ParsedMeta
  events: DigestEvent[]
  /** 这一段末尾还挂着、没等到结果的那一步(卡 T「在等你」的形式信号,见 {@link PendingStep})。 */
  pending?: PendingStep
}

/** 一行记录 + 它在文件里的起始字节偏移(按行带偏移读进来时才有)。 */
export interface SourceRow {
  row: Record<string, unknown>
  o?: number
}

function sourceRows(text: string): SourceRow[] {
  return jsonLines(text).map(row => ({ row }))
}

/** 每处理完一行,把这一行新出的事件盖上它的偏移(`continue` 多,所以在下一行开头 / 循环结束时补盖)。 */
function offsetStamper(events: DigestEvent[]): { next: (o: number | undefined) => void, done: () => void } {
  let from = 0
  let current: number | undefined
  const stamp = (): void => {
    if (current === undefined) return
    for (let i = from; i < events.length; i++) {
      const event = events[i]!
      if (event.o === undefined) events[i] = { ...event, o: current }
    }
  }
  return {
    next(o) { stamp(); from = events.length; current = o },
    done() { stamp(); from = events.length },
  }
}

function jsonLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed[0] !== '{') continue
    try {
      const value: unknown = JSON.parse(trimmed)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) rows.push(value as Record<string, unknown>)
    }
    catch {
      // 头尾截断的半行、坏行:跳过,不让一行拖垮整段。
    }
  }
  return rows
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isoOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 秒还是毫秒:2001 年以后的毫秒数都大于 1e12
    return new Date(value > 1e12 ? value : value * 1000).toISOString()
  }
  return undefined
}

function withAt<T extends object>(event: T, at: string | undefined): T & { at?: string } {
  return at === undefined ? event : { ...event, at }
}

/** Claude 一条 user 记录里他说的那句(注入的、子任务回报、工具结果都不算)。 */
export function claudeAsk(row: Record<string, unknown>): { text: string, image: boolean } | undefined {
  if (row.isMeta === true || row.isCompactSummary === true || row.isSidechain === true || row.isVisibleInTranscriptOnly === true) return undefined
  const origin = asRecord(row.origin)
  if (origin !== undefined && typeof origin.kind === 'string' && origin.kind !== 'human') return undefined
  const content = asRecord(row.message)?.content
  if (typeof content === 'string') {
    return isInjectedText(content) || content.trim() === '' ? undefined : { text: content, image: false }
  }
  if (!Array.isArray(content)) return undefined
  let image = false
  let text: string | undefined
  for (const block of content) {
    const b = asRecord(block)
    if (b === undefined) continue
    if (b.type === 'tool_result') return undefined // 工具结果那一类 user 记录整条不是人话
    if (b.type === 'image') image = true
    if (b.type === 'text' && typeof b.text === 'string' && text === undefined && !isInjectedText(b.text) && b.text.trim() !== '') text = b.text
  }
  if (text === undefined && !image) return undefined
  return { text: text ?? '', image }
}

/** 「[Request interrupted by user]」/「…for tool use]」那一行(整条就这一句)。 */
function claudeInterrupted(content: unknown): boolean {
  const texts = typeof content === 'string'
    ? [content]
    : Array.isArray(content) ? content.map(asRecord).flatMap(b => (b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [])) : []
  return texts.some(text => text.trimStart().startsWith('[Request interrupted'))
}

function filesOf(value: unknown): string[] {
  return typeof value === 'string' && value !== '' ? [value] : []
}

// ───────────── 挂着没回的那一步(2026-09-25,卡 T「在等你:不只看会话状态」) ─────────────

/** 一步里带的问题原文不超过这么长(只在内存里判断用;出去的都是判断模块截过的一句)。 */
const PENDING_TEXT_MAX = 2000

function rawClip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/** 提问弹窗里的一问(Claude AskUserQuestion / Codex request_user_input 的 questions[i]),原样只收字。 */
function pendingQuestions(value: unknown): NonNullable<PendingStep['questions']> {
  const out: NonNullable<PendingStep['questions']> = []
  for (const raw of Array.isArray(value) ? value : []) {
    const one = asRecord(raw)
    if (one === undefined) continue
    // Codex 的 `request_user_input_async` 只有 title(+ 字符串选项);两种都认。
    const question = typeof one.question === 'string' ? one.question : typeof one.title === 'string' ? one.title : undefined
    if (question === undefined || question.trim() === '') continue
    const options: { label: string, note?: string }[] = []
    for (const option of Array.isArray(one.options) ? one.options : []) {
      if (typeof option === 'string' && option.trim() !== '') { options.push({ label: rawClip(option, 200) }); continue }
      const record = asRecord(option)
      if (record === undefined || typeof record.label !== 'string' || record.label.trim() === '') continue
      options.push({ label: rawClip(record.label, 200), ...(typeof record.description === 'string' && record.description.trim() !== '' ? { note: rawClip(record.description, 400) } : {}) })
    }
    out.push({
      question: rawClip(question, PENDING_TEXT_MAX),
      ...(typeof one.header === 'string' && one.header.trim() !== '' ? { header: rawClip(one.header, 200) } : {}),
      options,
      ...(one.multiSelect === true ? { multi: true } : {}),
    })
  }
  return out
}

/** Claude 的一步 tool_use → 挂着的那一步(提问 / 等他批计划 / 别的一步)。 */
function claudePendingOf(name: unknown, input: Record<string, unknown>, at: string | undefined): PendingStep | undefined {
  if (typeof name !== 'string' || name === '') return undefined
  if (/^askuserquestion$/i.test(name)) {
    const questions = pendingQuestions(input.questions)
    return withAt({ kind: 'question' as const, tool: name, questions }, at)
  }
  if (/^exitplanmode$/i.test(name)) {
    const plan = typeof input.plan === 'string' ? rawClip(input.plan, PENDING_TEXT_MAX) : undefined
    return withAt({ kind: 'plan' as const, tool: name, ...(plan === undefined ? {} : { detail: plan }) }, at)
  }
  const detail = typeof input.description === 'string' && input.description.trim() !== '' ? rawClip(input.description, 400) : undefined
  const marks = ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern', 'query']
    .map(field => input[field])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map(value => rawClip(value, 200))
    .slice(0, 3)
  return withAt({ kind: 'tool' as const, tool: name, verb: classifyTool(name, input), ...(detail === undefined ? {} : { detail }), ...(marks.length === 0 ? {} : { marks }) }, at)
}

/** 还开着的那几步里挑一步:提问 / 批计划优先(那是明着在等他),其次最后开的那一步。 */
function pickPending(open: ReadonlyMap<string, PendingStep>): PendingStep | undefined {
  const steps = [...open.values()]
  return [...steps].reverse().find(step => step.kind !== 'tool') ?? steps[steps.length - 1]
}

function parseClaude(text: string): Parsed {
  return parseClaudeRows(sourceRows(text))
}

function parseClaudeRows(rows: readonly SourceRow[]): Parsed {
  const meta: ParsedMeta = {}
  const events: DigestEvent[] = []
  const stamper = offsetStamper(events)
  /** 发出去了、还没等到结果的那几步(按 tool_use id)。他又开口了就全清(他已经往下说了)。 */
  const open = new Map<string, PendingStep>()
  for (const { row, o } of rows) {
    stamper.next(o)
    if (typeof row.sessionId === 'string' && meta.sessionId === undefined) meta.sessionId = row.sessionId
    if (typeof row.cwd === 'string' && row.cwd !== '') meta.cwd = row.cwd
    if (typeof row.entrypoint === 'string' && row.entrypoint !== '' && meta.entry === undefined) meta.entry = row.entrypoint
    // 子任务的会话从第一条起就是 sidechain;老版本主会话里夹的几条 sidechain 不算(只看第一条带这个字段的)。
    if (typeof row.isSidechain === 'boolean' && meta.subagent === undefined) {
      meta.subagent = row.isSidechain
      // 子任务的记录里 `sessionId` 就是它挂着的那条主会话(文件在 `<主会话>/subagents/agent-*.jsonl`)。
      if (row.isSidechain && typeof row.sessionId === 'string' && row.sessionId !== '') meta.parentId = row.sessionId
    }
    const at = isoOf(row.timestamp)
    if (row.type === 'custom-title' && typeof row.customTitle === 'string' && row.customTitle.trim() !== '') meta.customTitle = row.customTitle
    else if (row.type === 'summary' && typeof row.summary === 'string' && row.summary.trim() !== '') meta.summaryTitle = row.summary
    else if (row.type === 'last-prompt' && typeof row.lastPrompt === 'string') meta.lastPrompt = row.lastPrompt
    else if (row.type === 'user') {
      const ask = claudeAsk(row)
      if (ask !== undefined) {
        events.push(withAt({ k: 'ask' as const, text: ask.text, image: ask.image }, at))
        open.clear()
      }
      else {
        // 工具结果回来了:那一步不再挂着。
        const content = asRecord(row.message)?.content
        // 她按了停:Claude Code 记一条「[Request interrupted by user…]」(不是她的话,claudeAsk 已滤掉),这一轮是被掐断的。
        if (claudeInterrupted(content)) events.push(withAt({ k: 'abort' as const }, at))
        for (const block of Array.isArray(content) ? content : []) {
          const b = asRecord(block)
          if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') open.delete(b.tool_use_id)
        }
      }
    }
    else if (row.type === 'assistant') {
      const message = asRecord(row.message)
      const content = message?.content
      if (!Array.isArray(content)) continue
      /**
       * **这一条是报错**(2026-09-25,卡 V,真机实证):Claude Code 把上游的错误也写成一条 `assistant` 记录,
       * 带 `isApiErrorMessage: true` + `error: '<码>'`,正文就是那句英文(「Not logged in · Please run /login」),
       * 而 `stop_reason` 是 `stop_sequence` —— 不是 `end_turn`。于是老读法两头都错:
       * 状态判成「还在跑」,「在做什么」写成那句英文。这里整条按 `fail` 收,**不当它是它说的话**。
       * (78 份真机文件里见过的码:`rate_limit`、`authentication_failed`。)
       */
      if (row.isApiErrorMessage === true) {
        const text = content.map(asRecord).find(b => b?.type === 'text' && typeof b.text === 'string')?.text
        events.push(withAt({
          k: 'fail' as const,
          ...(typeof row.error === 'string' && row.error !== '' ? { code: row.error } : {}),
          ...(typeof text === 'string' && text.trim() !== '' ? { raw: clip(text.replace(/\s+/g, ' ').trim(), FAILURE_RAW_MAX) } : {}),
        }, at))
        continue
      }
      const final = message?.stop_reason === 'end_turn'
      // 这一轮**被长度顶掉了**(`max_tokens`):也是一种「结束但没说完」,按报错收(人话「这一轮太长,被截断了」)。
      if (message?.stop_reason === 'max_tokens') {
        for (const block of content) {
          const b = asRecord(block)
          if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') events.push(withAt({ k: 'say' as const, text: b.text, final: false }, at))
        }
        events.push(withAt({ k: 'fail' as const, code: 'max_tokens' }, at))
        continue
      }
      for (const block of content) {
        const b = asRecord(block)
        if (b === undefined) continue
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
          events.push(withAt({ k: 'say' as const, text: b.text, final }, at))
        }
        else if (b.type === 'tool_use') {
          const input = asRecord(b.input) ?? {}
          const step = claudePendingOf(b.name, input, at)
          if (step !== undefined) open.set(typeof b.id === 'string' && b.id !== '' ? b.id : `#${open.size}`, step)
          const verb = classifyTool(b.name, input)
          if (verb === 'plan') {
            // TodoWrite:正在做的那一步(activeForm 是「正在跑测试」这种现在进行时,正合适)。
            const todos = Array.isArray(input.todos) ? input.todos : []
            const doing = todos.map(asRecord).find(todo => todo?.status === 'in_progress')
            const line = doing?.activeForm ?? doing?.content
            if (typeof line === 'string') events.push(withAt({ k: 'plan' as const, text: line }, at))
            continue
          }
          const detail = typeof input.description === 'string' ? input.description : undefined
          events.push(withAt({
            k: 'tool' as const,
            verb,
            files: verb === 'edit' || verb === 'read' ? filesOf(input.file_path ?? input.notebook_path ?? input.path) : [],
            ...(detail === undefined ? {} : { detail }),
          }, at))
        }
      }
      if (final) events.push(withAt({ k: 'end' as const }, at))
    }
  }
  stamper.done()
  const pending = pickPending(open)
  return { meta, events, ...(pending === undefined ? {} : { pending }) }
}

/** Codex 那几段文字块(content 数组里 text / input_text / output_text / Text)拼起来;有图片记一笔。 */
function codexText(content: unknown): { text: string, image: boolean } {
  if (typeof content === 'string') return { text: content, image: false }
  const parts: string[] = []
  let image = false
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = asRecord(block)
      if (b === undefined) continue
      if (typeof b.text === 'string') parts.push(b.text)
      if (typeof b.type === 'string' && /image/i.test(b.type)) image = true
    }
  }
  return { text: parts.join('\n'), image }
}

/** `*** Update File: a/b.ts` 这类补丁头里的文件。 */
function patchFiles(patch: unknown): string[] {
  if (typeof patch !== 'string') return []
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(match => match[1]!.trim())
}

function codexCommand(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const last = value[value.length - 1]
    return typeof last === 'string' ? last : undefined
  }
  return undefined
}

function parseCodex(text: string): Parsed {
  return parseCodexRows(sourceRows(text))
}

function parseCodexRows(sourced: readonly SourceRow[]): Parsed {
  const meta: ParsedMeta = {}
  const rows = sourced.map(one => one.row)
  // 新版同一句话会出现两遍(item_completed 一遍、response_item 一遍),先看这段里有没有新版的写法,只认一份。
  const hasItemUser = rows.some(row => asRecord(row.payload)?.type === 'item_completed' && asRecord(asRecord(row.payload)?.item)?.type === 'UserMessage')
  const hasItemAgent = rows.some(row => asRecord(row.payload)?.type === 'item_completed' && asRecord(asRecord(row.payload)?.item)?.type === 'AgentMessage')
  const hasItemCommand = rows.some(row => asRecord(row.payload)?.type === 'item_completed' && asRecord(asRecord(row.payload)?.item)?.type === 'CommandExecution')
  const hasEventUser = rows.some(row => row.type === 'event_msg' && asRecord(row.payload)?.type === 'user_message')
  const hasEventAgent = rows.some(row => row.type === 'event_msg' && asRecord(row.payload)?.type === 'agent_message')
  const events: DigestEvent[] = []
  const stamper = offsetStamper(events)
  /** 问他的那几问(request_user_input,按 call_id)还没等到回答的。他又开口了就全清。 */
  const open = new Map<string, PendingStep>()
  const pushAsk = (said: string, image: boolean, at: string | undefined): void => {
    events.push(withAt({ k: 'ask' as const, text: said, image }, at))
    open.clear()
  }
  for (const { row, o } of sourced) {
    stamper.next(o)
    const payload = asRecord(row.payload)
    if (payload === undefined) continue
    const at = isoOf(row.timestamp)
    if (row.type === 'session_meta') {
      const id = payload.id ?? payload.session_id
      if (typeof id === 'string' && meta.sessionId === undefined) meta.sessionId = id
      if (typeof payload.cwd === 'string' && payload.cwd !== '') meta.cwd = payload.cwd
      // 他开的会话 source 是一个字符串(cli / vscode / exec…);子任务派出来的是 `{ subagent: … }`(见 codexRollout.ts)。
      const source = asRecord(payload.source)
      if (meta.subagent === undefined) meta.subagent = source !== undefined && 'subagent' in source
      if (typeof payload.source === 'string' && payload.source !== '' && meta.entry === undefined) meta.entry = payload.source
      // 子任务挂在哪条主会话下(卡 T):`parent_thread_id`,老一点的写在 `source.subagent.thread_spawn` 里。
      const spawn = asRecord(asRecord(source?.subagent)?.thread_spawn)
      const parent = payload.parent_thread_id ?? spawn?.parent_thread_id
      if (typeof parent === 'string' && parent !== '' && meta.parentId === undefined) meta.parentId = parent
      continue
    }
    if (row.type === 'event_msg') {
      if (payload.type === 'item_completed') {
        const item = asRecord(payload.item)
        if (item === undefined) continue
        if (item.type === 'UserMessage') {
          const { text: said, image } = codexText(item.content)
          if (!isInjectedText(said) && (said.trim() !== '' || image)) pushAsk(said, image, at)
        }
        else if (item.type === 'AgentMessage') {
          const { text: said } = codexText(item.content)
          if (said.trim() !== '') events.push(withAt({ k: 'say' as const, text: said, final: item.phase === 'final_answer' }, at))
        }
        else if (item.type === 'CommandExecution') {
          const parsedCmd = Array.isArray(item.parsed_cmd) ? asRecord(item.parsed_cmd[0]) : undefined
          const kind = parsedCmd?.type
          const verb: ToolVerb = kind === 'read' ? 'read' : kind === 'search' || kind === 'list_files' ? 'search' : classifyCommand(codexCommand(item.command))
          const file = kind === 'read' ? (parsedCmd?.path ?? parsedCmd?.name) : undefined
          events.push(withAt({ k: 'tool' as const, verb, files: filesOf(file) }, at))
        }
        else if (item.type === 'FileChange') {
          events.push(withAt({ k: 'tool' as const, verb: 'edit' as const, files: Object.keys(asRecord(item.changes) ?? {}) }, at))
        }
        else if (item.type === 'McpToolCall') {
          const verb: ToolVerb = /computer|browser|chrome|screen/i.test(`${String(item.server)} ${String(item.tool)}`) ? 'screen' : 'other'
          events.push(withAt({ k: 'tool' as const, verb, files: [] }, at))
        }
        else if (item.type === 'Extension' && typeof item.kind === 'string' && /search|web/i.test(item.kind)) {
          events.push(withAt({ k: 'tool' as const, verb: 'web' as const, files: [] }, at))
        }
        else if (item.type === 'ImageView') {
          events.push(withAt({ k: 'tool' as const, verb: 'read' as const, files: [] }, at))
        }
        else if (item.type === 'SubAgentActivity' || item.type === 'CollabAgentToolCall') {
          events.push(withAt({ k: 'tool' as const, verb: 'agent' as const, files: [] }, at))
        }
        continue
      }
      if (payload.type === 'user_message' && !hasItemUser) {
        const said = typeof payload.message === 'string' ? payload.message : ''
        const image = Array.isArray(payload.images) && payload.images.length > 0
        if (!isInjectedText(said) && (said.trim() !== '' || image)) pushAsk(said, image, at)
      }
      else if (payload.type === 'agent_message' && !hasItemAgent) {
        if (typeof payload.message === 'string' && payload.message.trim() !== '') events.push(withAt({ k: 'say' as const, text: payload.message, final: payload.phase === 'final_answer' }, at))
      }
      else if (payload.type === 'exec_command_begin' && !hasItemCommand) {
        events.push(withAt({ k: 'tool' as const, verb: classifyCommand(codexCommand(payload.command)), files: [] }, at))
      }
      else if (payload.type === 'patch_apply_begin') {
        events.push(withAt({ k: 'tool' as const, verb: 'edit' as const, files: Object.keys(asRecord(payload.changes) ?? {}) }, at))
      }
      /**
       * Codex 的结束标记(2026-09-25 卡 V 在 60 份真机 rollout 上数过:`task_complete` 277 条,
       * 55/60 份文件最后一条就是它;另外 5 份最后一条是 `thread_settings_applied` —— 那是开了没说话的空会话)。
       * 原来 `turn_aborted` 与它并成一个 `end`:被掐断的那一轮会被说成「说完了」。现在分开。
       */
      else if (payload.type === 'turn_aborted') {
        events.push(withAt({ k: 'abort' as const }, at))
      }
      // 上游报错那一条(`error` / `stream_error`)。真机这 60 份里没撞到,按 Codex 事件命名收着;认不出就不猜。
      else if (payload.type === 'error' || payload.type === 'stream_error') {
        const raw = typeof payload.message === 'string' ? payload.message : undefined
        events.push(withAt({
          k: 'fail' as const,
          ...(raw === undefined || raw.trim() === '' ? {} : { raw: clip(raw.replace(/\s+/g, ' ').trim(), FAILURE_RAW_MAX) }),
        }, at))
      }
      else if (payload.type === 'task_complete') {
        events.push(withAt({ k: 'end' as const }, at))
      }
      continue
    }
    if (row.type === 'response_item') {
      if (payload.type === 'message') {
        const { text: said, image } = codexText(payload.content)
        if (payload.role === 'user' && !hasItemUser && !hasEventUser && !isInjectedText(said) && (said.trim() !== '' || image)) {
          pushAsk(said, image, at)
        }
        else if (payload.role === 'assistant' && !hasItemAgent && !hasEventAgent && said.trim() !== '') {
          events.push(withAt({ k: 'say' as const, text: said, final: payload.phase === 'final_answer' }, at))
        }
        continue
      }
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const name = payload.name
        let args: Record<string, unknown> = {}
        if (typeof payload.arguments === 'string') {
          try { args = asRecord(JSON.parse(payload.arguments)) ?? {} }
          catch { args = {} }
        }
        if (name === 'update_plan') {
          const plan = Array.isArray(args.plan) ? args.plan : []
          const doing = plan.map(asRecord).find(step => step?.status === 'in_progress')
          if (typeof doing?.step === 'string') events.push(withAt({ k: 'plan' as const, text: doing.step }, at))
          continue
        }
        if (name === 'apply_patch') {
          events.push(withAt({ k: 'tool' as const, verb: 'edit' as const, files: patchFiles(payload.input ?? args.input ?? args.patch) }, at))
          continue
        }
        if (name === 'exec') {
          // 新版把命令包在一段脚本里;真正跑的命令另有 CommandExecution 记录。没有那种记录的老会话才从脚本里抠。
          if (!hasItemCommand && typeof payload.input === 'string') {
            for (const match of payload.input.matchAll(/exec_command\(\{\s*cmd:\s*"((?:[^"\\]|\\.)*)"/g)) {
              events.push(withAt({ k: 'tool' as const, verb: classifyCommand(match[1]), files: [] }, at))
            }
          }
          continue
        }
        if (name === 'shell' || name === 'exec_command') {
          if (!hasItemCommand) events.push(withAt({ k: 'tool' as const, verb: classifyCommand(codexCommand(args.command ?? args.cmd)), files: [] }, at))
          continue
        }
        // 「问你一句」(Codex 的提问弹窗):挂着,等他回答(卡 T)。同步那种等到结果回来就不挂了;
        // 异步那种(`_async`)结果当场就回「问出去了」,真回答是他后来说的那句 —— 只有他开口才算答了。
        if (typeof name === 'string' && /^request_user_input(?:_async)?$/.test(name)) {
          const callId = typeof payload.call_id === 'string' && payload.call_id !== '' ? payload.call_id : `#${open.size}`
          open.set(name.endsWith('_async') ? `async:${callId}` : callId, withAt({ kind: 'question' as const, tool: name, questions: pendingQuestions(args.questions) }, at))
        }
        // 协作那几样(派助手、传话、等回话)与「问你一句」;认不出的工具也记一步(说「在用别的工具」),不丢。
        if (typeof name === 'string') events.push(withAt({ k: 'tool' as const, verb: classifyTool(name, args), files: [] }, at))
        continue
      }
      if ((payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') && typeof payload.call_id === 'string') {
        open.delete(payload.call_id)
        continue
      }
      if (payload.type === 'web_search_call') events.push(withAt({ k: 'tool' as const, verb: 'web' as const, files: [] }, at))
    }
  }
  stamper.done()
  const pending = pickPending(open)
  return { meta, events, ...(pending === undefined ? {} : { pending }) }
}

/** Kimi 的 turn.prompt:`<meta …/>` 与 `<attachment>…</attachment>` 去掉之后才是他说的。 */
function kimiPrompt(input: unknown): { text: string, image: boolean } {
  const { text, image } = codexText(input)
  return { text: stripTagBlocks(text).trim(), image }
}

/** `<meta … timestamp="2026-09-07 15:07" />`:本地时间,没有时区,按这台机器的时区读。 */
function kimiMetaTime(input: unknown): string | undefined {
  const { text } = codexText(input)
  const match = /timestamp="(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?"/.exec(text)
  if (match === null) return undefined
  return isoOf(`${match[1]}T${match[2]}:${match[3] ?? '00'}`)
}

function parseKimi(text: string, fallbackAt?: string): Parsed {
  return parseKimiRows(sourceRows(text), fallbackAt)
}

function parseKimiRows(sourced: readonly SourceRow[], fallbackAt?: string): Parsed {
  const meta: ParsedMeta = {}
  const events: DigestEvent[] = []
  const stamper = offsetStamper(events)
  // Kimi 的循环事件不带时刻;带时刻的只有 usage.record / tools.update_store / 开场 metadata / 提问里的 meta。
  // 在它们之间的事件按「上一个已知时刻」算 —— 最近在做什么的「几分钟前」宁可偏早,不编一个更新的。
  let known: string | undefined
  for (const { row, o } of sourced) {
    stamper.next(o)
    const stamp = isoOf(row.time) ?? isoOf(row.created_at) ?? isoOf(row.timestamp)
    if (stamp !== undefined) known = stamp
    /**
     * **另一种 Kimi 会话文件**(2026-09-25 卡 V 在维护者这台上撞到:`~/.kimi/sessions/<摘要>/<id>/wire.jsonl`,
     * 头一条 `{"type":"metadata","protocol_version":"1.10"}`,往后每条都是 `{timestamp, message:{type,payload}}`)。
     * 与桌面版 wire 1.4(`turn.prompt` / `context.append_loop_event`)是两套写法。这里**只认它的停在哪儿**:
     * 232 份真机文件里 64/80 最后一条是 `TurnEnd`(说完了)、14 份 `StepRetry`、1 份 `StepInterrupted`、1 份 `StepBegin`;
     * 另外 `ApprovalRequest` 140 条、`QuestionRequest` 1 条 —— 那是**形式上停下来等人**的直接证据。
     * 标题与「在做什么」这一套写法还没读(那得另起一份读法),所以只报 mark / formal_wait,其余缺席、不猜。
     */
    const wrapped = asRecord(row.message)
    if (wrapped !== undefined && typeof wrapped.type === 'string') {
      const kind = wrapped.type
      if (kind === 'TurnEnd') events.push(withAt({ k: 'end' as const }, known))
      else if (kind === 'StepInterrupted' || kind === 'TurnAbort') events.push(withAt({ k: 'abort' as const }, known))
      else if (kind === 'TurnError' || kind === 'StepError') events.push(withAt({ k: 'fail' as const, code: kind }, known))
      else if (kind === 'ApprovalRequest') events.push(withAt({ k: 'wait' as const, formal: 'approval' as const }, known))
      else if (kind === 'QuestionRequest') events.push(withAt({ k: 'wait' as const, formal: 'question' as const }, known))
      else if (kind === 'ApprovalResponse' || kind === 'TurnBegin' || kind === 'StepBegin' || kind === 'StepRetry' || kind === 'ToolCall') {
        // 答复过了 / 又动起来了:抹掉上一条形式等待(它已经不在等了),并算「在干活」。
        events.push(withAt({ k: 'tool' as const, verb: 'other' as const, files: [] }, known))
      }
      continue
    }
    if (row.type === 'turn.prompt') {
      const promptAt = kimiMetaTime(row.input)
      if (promptAt !== undefined) known = promptAt
      const { text: said, image } = kimiPrompt(row.input)
      if (said !== '' || image) events.push(withAt({ k: 'ask' as const, text: said, image }, known))
      continue
    }
    if (row.type === 'tools.update_store' && row.key === 'todo' && Array.isArray(row.value)) {
      const doing = row.value.map(asRecord).find(todo => todo?.status === 'in_progress')
      if (typeof doing?.title === 'string') events.push(withAt({ k: 'plan' as const, text: doing.title }, known))
      continue
    }
    if (row.type !== 'context.append_loop_event') continue
    const event = asRecord(row.event)
    if (event === undefined) continue
    if (event.type === 'content.part') {
      const part = asRecord(event.part)
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
        events.push(withAt({ k: 'say' as const, text: part.text, final: false }, known))
      }
    }
    else if (event.type === 'tool.call') {
      const args = asRecord(event.args) ?? {}
      const verb = classifyTool(event.name, args)
      if (verb === 'plan') continue // 计划本身走 tools.update_store 那条
      const detail = typeof args.description === 'string' ? args.description : undefined
      events.push(withAt({
        k: 'tool' as const,
        verb,
        files: verb === 'edit' || verb === 'read' ? filesOf(args.file_path ?? args.path) : [],
        ...(detail === undefined ? {} : { detail }),
      }, known))
    }
    else if (event.type === 'step.end' && event.finishReason === 'end_turn') {
      // 这一步说完就是这一轮说完:上一段文字是最终回答。
      for (let i = events.length - 1; i >= 0; i--) {
        const last = events[i]!
        if (last.k === 'say') { events[i] = { ...last, final: true }; break }
        if (last.k === 'ask') break
      }
      events.push(withAt({ k: 'end' as const }, known))
    }
    /**
     * 这一步**不是说完**结束的(2026-09-25,卡 V):`error` 报错、`aborted` / `interrupted` 被掐断。
     * `tool_calls` 是「这一步交给工具了」,下一步还会接着来 —— 那不是结束,不收。
     */
    else if (event.type === 'step.end' && typeof event.finishReason === 'string') {
      if (/error|fail/i.test(event.finishReason)) events.push(withAt({ k: 'fail' as const, code: event.finishReason }, known))
      else if (/abort|interrupt|cancel/i.test(event.finishReason)) events.push(withAt({ k: 'abort' as const }, known))
    }
  }
  stamper.done()
  // 整段都没有一个时刻(老文件):用文件的修改时刻兜住,不然界面连「几分钟前」都说不出。
  if (fallbackAt !== undefined) {
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!
      if (event.at === undefined) events[i] = { ...event, at: fallbackAt }
    }
  }
  return { meta, events }
}

// ───────────────────────────── 事件 → 轮次 / 在做什么 / 标题 ─────────────────────────────

export function didLine(counts: ReadonlyMap<ToolVerb, number>): string | undefined {
  const parts: string[] = []
  for (const { verb, say } of VERB_DID) {
    const n = counts.get(verb) ?? 0
    if (n > 0) parts.push(say(n))
    if (parts.length === 3) break
  }
  return parts.length === 0 ? undefined : parts.join('、')
}

interface RoundBuilder {
  ask?: string
  image: boolean
  reply?: string
  at?: string
  counts: Map<ToolVerb, number>
  files: Map<ToolVerb, Set<string>>
}

function newRound(): RoundBuilder {
  return { image: false, counts: new Map(), files: new Map() }
}

function finishRound(round: RoundBuilder): DigestRound | undefined {
  // 文件类按「几个文件」数,别的按「几次」数。
  const counts = new Map(round.counts)
  for (const [verb, files] of round.files) {
    if (files.size > 0) counts.set(verb, files.size)
  }
  const did = didLine(counts)
  const ask = round.ask ?? (round.image ? '发来一张图片' : undefined)
  if (ask === undefined && round.reply === undefined && did === undefined) return undefined
  return {
    ...(ask === undefined ? {} : { ask }),
    ...(round.reply === undefined ? {} : { reply: round.reply }),
    ...(did === undefined ? {} : { did }),
    ...(round.at === undefined ? {} : { at: round.at }),
  }
}

function buildRounds(events: readonly DigestEvent[], limit: number, finalReply?: 'excerpt'): DigestRound[] {
  const rounds: DigestRound[] = []
  let current: RoundBuilder | undefined
  const flush = (): void => {
    if (current === undefined) return
    const done = finishRound(current)
    if (done !== undefined) rounds.push(done)
    current = undefined
  }
  for (const event of events) {
    if (event.k === 'ask') {
      flush()
      current = newRound()
      const ask = humanizeText(event.text, ROUND_ASK_MAX, 1)
      if (ask !== undefined) current.ask = ask
      current.image = event.image
      if (event.at !== undefined) current.at = event.at
      continue
    }
    current ??= newRound()
    if (event.at !== undefined) current.at = event.at
    if (event.k === 'say') {
      // 原件读回的最终答复可能只有一个标识符；不能套用活动摘要清洗后变成「没回复」。
      const reply = finalReply === 'excerpt' && event.final
        ? clip(event.text, ROUND_REPLY_MAX)
        : humanizeText(event.text, ROUND_REPLY_MAX)
      if (reply !== undefined) current.reply = reply
    }
    else if (event.k === 'tool') {
      if (event.verb === 'other' || event.verb === 'plan' || event.verb === 'wait' || event.verb === 'message') continue
      if ((event.verb === 'edit' || event.verb === 'read') && event.files.length > 0) {
        const set = current.files.get(event.verb) ?? new Set<string>()
        for (const file of event.files) set.add(file)
        current.files.set(event.verb, set)
      }
      else {
        current.counts.set(event.verb, (current.counts.get(event.verb) ?? 0) + 1)
      }
    }
  }
  flush()
  return rounds.slice(-limit)
}

/**
 * 最近在做什么。从最后往前看这一轮(他最后那句话之后)的事件:
 * 1. 最近几步里有它说的那句旁白 / 正在做的那一步计划 / 带中文说明的一步操作 → 用那句;
 * 2. 没有 → 按最后一步的种类说一句(「在跑测试」);
 * 3. 这一轮只有他那句话、它还没动 →「在想你说的『……』」;
 * 4. 这一轮说完了 → 它最后说的那句(界面上配「刚完成」/ 状态一起看)。
 */
function buildActivity(events: readonly DigestEvent[], lastPrompt?: string): { line: string, at?: string } | undefined {
  let start = 0
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.k === 'ask') { start = i; break }
  }
  const turn = events.slice(start)
  const lastAt = lastAtOf(turn)
  const stamp = (event: DigestEvent): { at?: string } => {
    const at = event.at ?? lastAt
    return at === undefined ? {} : { at }
  }
  // 往回最多看这么几步:再往前的旁白说的是「刚才」,不是「现在」。
  const LOOKBACK = 4
  let steps = 0
  for (let i = turn.length - 1; i >= 0 && steps < LOOKBACK; i--) {
    const event = turn[i]!
    if (event.k === 'end') continue
    if (event.k === 'ask') break
    steps += 1
    if (event.k === 'say' || event.k === 'plan') {
      const line = humanize(event.text, ACTIVITY_MAX)
      if (line !== undefined) return { line, ...stamp(event) }
      continue
    }
    if (event.k === 'tool' && event.detail !== undefined && CJK_RE.test(event.detail)) {
      const line = humanize(event.detail, ACTIVITY_MAX)
      if (line !== undefined) return { line: event.verb === 'agent' ? clip(`派助手:${line}`, ACTIVITY_MAX) : line, ...stamp(event) }
    }
  }
  // 按最后一步的种类说一句;「别的工具」那一类说不出什么,先往前找一步说得清的。
  const tools = turn.filter((event): event is Extract<DigestEvent, { k: 'tool' }> => event.k === 'tool')
  const lastTool = [...tools].reverse().find(event => event.verb !== 'other') ?? tools[tools.length - 1]
  if (lastTool !== undefined) return { line: VERB_NOW[lastTool.verb], ...stamp(lastTool) }
  const ask = turn[0]
  if (ask !== undefined && ask.k === 'ask') {
    const said = humanize(ask.text, 16, 1) ?? (lastPrompt === undefined ? undefined : humanize(lastPrompt, 16, 1))
    if (said !== undefined) return { line: `在想你说的「${said}」`, ...stamp(ask) }
    if (ask.image) return { line: '在看你发的图片', ...stamp(ask) }
  }
  return undefined
}

interface TitlePick {
  title: string
  source: DigestTitleSource
}

export function pickTitle(options: { name?: string | undefined, meta: ParsedMeta, head: readonly DigestEvent[] }): TitlePick | undefined {
  const named = humanTitle(options.name, TITLE_MAX)
  if (named !== undefined) return { title: named, source: 'name' }
  const custom = humanTitle(options.meta.customTitle, TITLE_MAX)
  if (custom !== undefined) return { title: custom, source: 'custom' }
  const summary = humanTitle(options.meta.summaryTitle, TITLE_MAX)
  if (summary !== undefined) return { title: summary, source: 'summary' }
  let image = false
  for (const event of options.head) {
    if (event.k !== 'ask') continue
    // 标题要能认出是哪件事:两个字以上(「好」「嗯」跳过,看下一句)。
    const ask = humanizeText(event.text, TITLE_FROM_ASK_MAX, 2)
    if (ask !== undefined) return { title: ask, source: 'first_ask' }
    image ||= event.image
  }
  for (const event of options.head) {
    if (event.k !== 'say') continue
    const reply = humanizeText(event.text, TITLE_FROM_ASK_MAX)
    if (reply !== undefined) return { title: reply, source: 'first_reply' }
  }
  return image ? { title: '看一张图片', source: 'image' } : undefined
}

/**
 * 那家自己的标题:基本照原样(他在 App 里看到的就是这几个字),只去掉换行与首尾空白、截 40 字。
 * 英文标题照留(「Pin the clock in call-out test ①」是那家生成的名字,不是键名)。
 */
function humanTitle(raw: string | undefined, max: number): string | undefined {
  if (raw === undefined) return undefined
  const text = raw.replace(/\s+/g, ' ').trim()
  return text === '' ? undefined : clip(text, max)
}

function lastAtOf(events: readonly DigestEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const at = events[i]!.at
    if (at !== undefined) return at
  }
  return undefined
}

function endedOf(events: readonly DigestEvent[]): boolean | undefined {
  const last = events[events.length - 1]
  if (last === undefined) return undefined
  return last.k === 'end'
}

/**
 * 最后一条可认记录停在哪儿(2026-09-25,卡 V)。**只看最后那一条** —— 一条会话文件是一路往后追加的,
 * 「它停在哪儿」就是最后那条记录说的事。形式等待(`wait`)不算一种停法:它上面还得有在干活的记录,
 * 所以跳过它往前找(答复过了会补一条 `tool`,那条才是最后的)。
 *
 * 一条可认记录都没有 → `undefined`,**不猜**(空文件、刚建的文件、整段都是记账记录)。
 */
function markOf(events: readonly DigestEvent[]): SessionMark | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.k === 'wait') continue
    if (event.k === 'end') return 'ended'
    if (event.k === 'fail') return 'failed'
    if (event.k === 'abort') return 'aborted'
    if (event.k === 'ask') return 'asked'
    return 'working' // say / tool / plan
  }
  return undefined
}

/** `mark === 'failed'` 那条的原文。 */
function failureOf(events: readonly DigestEvent[]): DigestFailure | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.k !== 'fail') continue
    const out: DigestFailure = { ...(event.code === undefined ? {} : { code: event.code }), ...(event.raw === undefined ? {} : { raw: event.raw }) }
    return Object.keys(out).length === 0 ? {} : out
  }
  return undefined
}

/**
 * 记录里明写着的**形式等待**信号。只在它是最后一条有效记录时才算 —— 中间那条早就被答复过了。
 * (答复 / 又动起来时 parseKimi 会补一条 `tool`,所以这里只要看末尾有没有 `wait` 就够。)
 */
function formalWaitOf(events: readonly DigestEvent[]): 'approval' | 'question' | undefined {
  const last = events[events.length - 1]
  return last?.k === 'wait' ? last.formal : undefined
}

export interface DigestInput {
  /** 文件开头那一段(标题、第一句要求在这里)。文件不大时与 tail 相同。 */
  head: string
  /** 文件末尾那一段(最近几轮、在做什么在这里)。 */
  tail: string
  /** 那家客户端自己的会话名(Claude 桌面 App `~/.claude/sessions/<pid>.json` 的 `name`;Kimi 生成好的标题;Codex `thread_name`)。 */
  name?: string
  /** 记录里一个时刻都没有时(Kimi 老文件)用的兜底时刻:文件修改时刻。 */
  fallbackAt?: string
  rounds?: number
  /** 已登记原件读回：最终答复只截长度，不按活动摘要规则删代码/短答。 */
  finalReply?: 'excerpt'
}

function assemble(format: DigestFormat, head: Parsed, tail: Parsed, input: DigestInput): SessionDigest {
  const meta: ParsedMeta = { ...head.meta, ...definedOnly(tail.meta) }
  // custom-title 取「最后一条」:尾巴里有就是尾巴的(他中途改过名)。
  const title = pickTitle({ name: input.name, meta, head: head.events })
  const activity = buildActivity(tail.events, meta.lastPrompt)
  const rounds = buildRounds(tail.events, input.rounds ?? DIGEST_ROUNDS, input.finalReply)
  // 尾巴整段都落在最近这一轮里(一句他的话都没有):这一轮就是他最后那句要求的那一轮 ——
  // Claude 每次他说话都会记一条 `last-prompt`,拿它补上。尾巴里有好几轮时第一轮是从中间切进来的,不补(对不上是哪句)。
  const only = rounds[0]
  if (rounds.length === 1 && only !== undefined && only.ask === undefined && meta.lastPrompt !== undefined) {
    const ask = humanizeText(meta.lastPrompt, ROUND_ASK_MAX, 1)
    if (ask !== undefined) rounds[0] = { ask, ...only }
  }
  const lastAt = lastAtOf(tail.events)
  const ended = endedOf(tail.events)
  const mark = markOf(tail.events)
  const failure = mark === 'failed' ? failureOf(tail.events) : undefined
  const formalWait = formalWaitOf(tail.events)
  const turnAt = [...tail.events].reverse().find(event => event.k === 'ask')?.at
  // 那一刻:事件自己的时刻 > 这一段最后一个时刻 > 文件修改时刻。都没有就不说(说不出「几分钟前」的一句不如不说)。
  const activityAt = activity?.at ?? lastAt ?? input.fallbackAt
  return {
    format,
    ...(meta.sessionId === undefined ? {} : { session_id: meta.sessionId }),
    ...(title === undefined ? {} : { title: title.title, title_source: title.source }),
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    ...(activity === undefined || activityAt === undefined ? {} : { activity: { line: activity.line, at: activityAt } }),
    rounds,
    ...(ended === undefined ? {} : { ended }),
    ...(mark === undefined ? {} : { mark }),
    ...(failure === undefined ? {} : { failure }),
    ...(formalWait === undefined ? {} : { formal_wait: formalWait }),
    ...(lastAt === undefined ? {} : { last_at: lastAt }),
    ...(turnAt === undefined ? {} : { turn_at: turnAt }),
  }
}

function definedOnly(meta: ParsedMeta): ParsedMeta {
  const out: ParsedMeta = {}
  if (meta.sessionId !== undefined) out.sessionId = meta.sessionId
  if (meta.cwd !== undefined) out.cwd = meta.cwd
  if (meta.customTitle !== undefined) out.customTitle = meta.customTitle
  if (meta.summaryTitle !== undefined) out.summaryTitle = meta.summaryTitle
  if (meta.lastPrompt !== undefined) out.lastPrompt = meta.lastPrompt
  if (meta.subagent !== undefined) out.subagent = meta.subagent
  if (meta.parentId !== undefined) out.parentId = meta.parentId
  if (meta.entry !== undefined) out.entry = meta.entry
  return out
}

/** Claude 会话记录 → 读成人话。 */
export function digestClaude(input: DigestInput): SessionDigest {
  const head = parseClaude(input.head)
  const tail = input.tail === input.head ? head : parseClaude(input.tail)
  return assemble('claude-transcript', head, tail, input)
}

/** Codex 会话记录 → 读成人话。`name` 传 `session_index.jsonl` 里的 `thread_name`。 */
export function digestCodex(input: DigestInput): SessionDigest {
  const head = parseCodex(input.head)
  const tail = input.tail === input.head ? head : parseCodex(input.tail)
  return assemble('codex-rollout', head, tail, input)
}

/** Kimi 桌面版 wire.jsonl → 读成人话。`name` 传 conversations.sqlite 里生成好的标题。 */
export function digestKimi(input: DigestInput): SessionDigest {
  const head = parseKimi(input.head, input.fallbackAt)
  const tail = input.tail === input.head ? head : parseKimi(input.tail, input.fallbackAt)
  return assemble('kimi-wire', head, tail, input)
}

export function digestOf(format: DigestFormat, input: DigestInput): SessionDigest {
  return format === 'claude-transcript' ? digestClaude(input) : format === 'codex-rollout' ? digestCodex(input) : digestKimi(input)
}

// ───────────────────────────── 原文回合(卡 N 的证据评估用;不经 humanize) ─────────────────────────────

/**
 * 一条原文:他说的(`ask`)或它说的(`reply`)。**原样,不截不洗** —— 证据评估要拿整段原话核模型给的逐字摘录
 * (「已整理成『参赛网页逐屏文案稿.md』」这种关键的一句,humanize 会在文件名处截掉)。
 * 只给本机上的评估用:不进 /state、不落盘、不给界面。送去模型之前问不问 `read_session_content` 是调用方的事。
 */
export interface SessionTurn {
  k: 'ask' | 'reply'
  text: string
  at?: string
  /** 他只贴了图(text 可能是空的)。 */
  image?: true
  /** reply:这一段是这一轮的最终回答(Claude `end_turn`、Codex `phase: final_answer`、Kimi 这一步 `end_turn`)。 */
  final?: true
}

export interface SessionTurns {
  format: DigestFormat
  session_id?: string
  cwd?: string
  /** 是不是子任务派出来的会话(Claude `isSidechain`、Codex `session_meta.payload.source.subagent`)。子任务不算他的证据。 */
  subagent?: boolean
  /** 第一句要求原文(头上那一段里他说的第一句;不截)。认「【工作台派活 xxxxxx】」记号、认项目用。 */
  first_ask?: string
  /**
   * 这条会话的标题,与卡片上那一行同一个取法({@link SessionDigest.title}:那家自己的名 > custom-title > summary > 第一句前 20 来字)。
   * 卡 N 的证据出处写「Codex · <标题>」用它,两边说的是同一个名字。
   */
  title?: string
  /**
   * 尾巴那一段里的原文回合,旧 → 新。他说的只认他亲口说的(系统注入、子任务回报、工具结果不算);
   * 它说的只认文字(Claude 的 text 块、Codex 的 AgentMessage / agent_message、Kimi 的文字段),不含思考与工具调用。
   */
  turns: SessionTurn[]
  /** 子任务挂在哪条主会话下(Claude 子任务记录里的 `sessionId`;Codex `parent_thread_id`)。不是子任务就缺席。卡 T:子任务不单算一条。 */
  parent_id?: string
  /** 尾巴末尾还挂着、没等到结果的那一步(提问弹窗 / 等他批计划 / 别的一步)。卡 T「在等你」的形式信号。 */
  pending?: PendingStep
  /**
   * 最后一条可认记录停在哪儿(同 {@link SessionDigest.mark},以尾巴为准)。
   * 收回答按记号找那一轮时用它判「这一轮收尾了没有」(`transcriptReply.ts`,2026-10-12)。
   */
  mark?: SessionMark
  /** 从哪儿开的(Claude `entrypoint`:claude-desktop / cli…;Codex `source`:vscode / cli / exec)。卡 T:答了往哪送。 */
  entry?: string
}

/**
 * 会话末尾还挂着、没等到结果的那一步(2026-09-25,卡 T「在等你:不只看会话状态」)。
 *
 * - `question`:在问他(Claude `AskUserQuestion`、Codex `request_user_input` / `_async`)—— 这就是提问弹窗,明着在等他;
 * - `plan`:排好了计划等他批(Claude `ExitPlanMode`);
 * - `tool`:别的一步发出去了还没结果 —— **光看记录分不出是在跑还是在等他批**,要配上那家报的状态
 *   (Claude 的 `~/.claude/sessions/<pid>.json` 写着 `waiting` + `permission prompt`)才算等批准。
 *
 * 字是原样的(有上限),只在本机上判断用;出去给界面的是判断模块(waitingForYou.ts)截过、洗过的一句。
 */
export interface PendingStep {
  kind: 'question' | 'plan' | 'tool'
  /** 那一步的工具原名(判断用,不给他看)。 */
  tool: string
  at?: string
  /** question:问题与选项,原样。 */
  questions?: { question: string, header?: string, options: { label: string, note?: string }[], multi?: true }[]
  /** plan:计划原文;tool:那一步自己带的说明(Bash 的 description 这种)。 */
  detail?: string
  /** tool:那一步属于哪一类(改文件 / 跑命令 / 上网……)。 */
  verb?: ToolVerb
  /**
   * tool:那一步自己的命令 / 文件 / 网址原字(2026-10-01,卡 AP)。**只给替她按批准弹窗那一路认弹窗用**
   * (那家的权限弹窗上画的就是这几个字),不进问题、不上 /state。
   */
  marks?: string[]
}

/** 按行(带偏移)解析一段记录 —— 完整对话(sessionTranscript.ts)倒着分页读时用,与 {@link digestOf} 同一套读法。 */
export function parseRowsOf(format: DigestFormat, rows: readonly SourceRow[], fallbackAt?: string): Parsed {
  return format === 'claude-transcript' ? parseClaudeRows(rows) : format === 'codex-rollout' ? parseCodexRows(rows) : parseKimiRows(rows, fallbackAt)
}

function parseOf(format: DigestFormat, text: string, fallbackAt?: string): Parsed {
  return format === 'claude-transcript' ? parseClaude(text) : format === 'codex-rollout' ? parseCodex(text) : parseKimi(text, fallbackAt)
}

/** 同一份记录 → 原文回合(与 {@link digestOf} 同一套解析,只是不读成人话;`name` 同 digestOf,只用来取标题)。 */
export function turnsOf(format: DigestFormat, input: Pick<DigestInput, 'head' | 'tail' | 'fallbackAt' | 'name'>): SessionTurns {
  const head = parseOf(format, input.head, input.fallbackAt)
  const tail = input.tail === input.head ? head : parseOf(format, input.tail, input.fallbackAt)
  const meta: ParsedMeta = { ...head.meta, ...definedOnly(tail.meta) }
  const title = pickTitle({ name: input.name, meta, head: head.events })
  // 子任务与否以开头为准(子任务从第一条起就是;尾巴里的半截看不出来)。
  const subagent = head.meta.subagent ?? tail.meta.subagent
  const firstAsk = head.events.find(event => event.k === 'ask')
  const mark = markOf(tail.events)
  const turns: SessionTurn[] = []
  for (const event of tail.events) {
    if (event.k === 'ask') {
      turns.push({ k: 'ask', text: event.text, ...(event.at === undefined ? {} : { at: event.at }), ...(event.image ? { image: true as const } : {}) })
    }
    else if (event.k === 'say') {
      turns.push({ k: 'reply', text: event.text, ...(event.at === undefined ? {} : { at: event.at }), ...(event.final ? { final: true as const } : {}) })
    }
  }
  return {
    format,
    ...waitingSignalsOf(head, tail),
    ...(meta.sessionId === undefined ? {} : { session_id: meta.sessionId }),
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    ...(subagent === undefined ? {} : { subagent }),
    ...(firstAsk === undefined || firstAsk.k !== 'ask' ? {} : { first_ask: firstAsk.text }),
    ...(title === undefined ? {} : { title: title.title }),
    ...(mark === undefined ? {} : { mark }),
    turns,
  }
}

/** 卡 T 要的三样:挂在哪条主会话下、从哪儿开的(以开头为准)、末尾挂着的那一步(以尾巴为准 —— 最新的样子)。 */
function waitingSignalsOf(head: Parsed, tail: Parsed): Pick<SessionTurns, 'parent_id' | 'pending' | 'entry'> {
  const parent = head.meta.parentId ?? tail.meta.parentId
  const entry = head.meta.entry ?? tail.meta.entry
  return {
    ...(parent === undefined ? {} : { parent_id: parent }),
    ...(tail.pending === undefined ? {} : { pending: tail.pending }),
    ...(entry === undefined ? {} : { entry }),
  }
}

// ───────────────────────────── 读文件(有上限) ─────────────────────────────

export interface ReadDigestOptions {
  /** 头一段读多少(默认 256KB)。第一条记录里贴了截图的会话一行就能几百 KB —— 头上找不到标题 / 第一句时按 4 倍往上长,封顶 maxHeadBytes。 */
  headBytes?: number
  maxHeadBytes?: number
  /** 尾一段读多少(默认 256KB;点开看详情时调用方可给大一点)。 */
  tailBytes?: number
  rounds?: number
  finalReply?: DigestInput['finalReply']
}

/** 头上有没有标题或第一句要求 —— 没有就得往下多读一截(同 transcript.ts 的「够用就停」)。 */
function headHasTitle(format: DigestFormat, head: string): boolean {
  if (format === 'claude-transcript') {
    const parsed = parseClaude(head)
    return parsed.meta.customTitle !== undefined || parsed.events.some(event => event.k === 'ask')
  }
  if (format === 'codex-rollout') return parseCodex(head).events.some(event => event.k === 'ask')
  return parseKimi(head).events.some(event => event.k === 'ask')
}

async function readSlice(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<string> {
  if (length <= 0) return ''
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead).toString('utf8')
}

/** 读一条会话文件的头尾各一段(有上限)。文件不在 / 读不了 → undefined。只读:`open(…, 'r')`。 */
export async function readHeadTail(
  ref: { format: DigestFormat, file: string },
  options: ReadDigestOptions,
): Promise<{ head: string, tail: string, fallbackAt: string } | undefined> {
  const headBytes = options.headBytes ?? 256 * 1024
  const maxHeadBytes = Math.max(headBytes, options.maxHeadBytes ?? 4 * 1024 * 1024)
  const tailBytes = options.tailBytes ?? 256 * 1024
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(ref.file, 'r')
  }
  catch {
    return undefined
  }
  try {
    const info = await handle.stat()
    const size = info.size
    const fallbackAt = new Date(info.mtimeMs).toISOString()
    let head: string
    let tail: string
    if (size <= headBytes + tailBytes) {
      head = await readSlice(handle, 0, size)
      tail = head
    }
    else {
      let length = headBytes
      head = await readSlice(handle, 0, length)
      while (!headHasTitle(ref.format, head) && length < maxHeadBytes && length < size) {
        length = Math.min(length * 4, maxHeadBytes, size)
        head = await readSlice(handle, 0, length)
      }
      tail = await readSlice(handle, size - tailBytes, tailBytes)
    }
    return { head, tail, fallbackAt }
  }
  catch {
    return undefined
  }
  finally {
    await handle.close()
  }
}

/**
 * 读一条会话文件(头尾各一段),读成人话。文件不在 / 读不了 → undefined(界面写「读不到」,不猜)。
 * 只读:`open(…, 'r')`,不改文件的任何东西。
 */
export async function readSessionDigest(
  ref: { format: DigestFormat, file: string, name?: string },
  options: ReadDigestOptions = {},
): Promise<SessionDigest | undefined> {
  const read = await readHeadTail(ref, options)
  if (read === undefined) return undefined
  return digestOf(ref.format, {
    ...read,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(options.rounds === undefined ? {} : { rounds: options.rounds }),
    ...(options.finalReply === undefined ? {} : { finalReply: options.finalReply }),
  })
}

/**
 * 读一条会话文件的原文回合(卡 N 的证据评估用;见 {@link SessionTurns})。与 {@link readSessionDigest} 同一套头尾读法与上限。
 * 文件不在 / 读不了 → undefined。
 */
export async function readSessionTurns(
  ref: { format: DigestFormat, file: string, name?: string },
  options: Pick<ReadDigestOptions, 'headBytes' | 'maxHeadBytes' | 'tailBytes'> = {},
): Promise<SessionTurns | undefined> {
  const read = await readHeadTail(ref, options)
  return read === undefined ? undefined : turnsOf(ref.format, { ...read, ...(ref.name === undefined ? {} : { name: ref.name }) })
}

/** 文件的修改时刻(毫秒);没了回 undefined。给跟读的那几条路判「这份动过没有」。 */
export async function fileMtimeMs(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs
  }
  catch {
    return undefined
  }
}
