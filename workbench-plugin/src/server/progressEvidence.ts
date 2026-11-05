/**
 * 进度靠证据 —— **纯函数那一半**(2026-09-25,卡 N;设计 docs/设计-谁来做与进度靠证据-2026-09-25.md 第一节第 5 条)。
 *
 * 维护者:「感觉事务官对于现在实现的进展是来自我的描述,没有来自自己扫描或者确认的进度,这里有一段巨大的空白」。
 * 统筹核过:看板上十张卡的状态与备注全来自引导口述;Codex 里做参赛网页那条会话的真实进展是「11 屏已做完 → 他要了
 * 逐屏文案稿去审」,可落地派的第一件照旧话写「架构还差一截」,他真正的下一步没人管。
 *
 * 这个文件只管「判」,没有 I/O(读仓库、读会话、问模型、写盘都在 progressSources.ts / progress.ts):
 *
 * 1. **证据条目**({@link EvidenceItem}):仓库的提交 / 发版记录 / 交接与设计文档 / 决策记录、派出去的活交回来的话、
 *    各家会话的最后几轮(Codex 的 rollout、Claude 的 transcript)、他自己说的(口述)。每条都有出处、时刻、原文。
 * 2. **挑证据**({@link pickCandidates}):先认**直连**(卡上 links 指到的会话、派活记号认出来的会话、这张卡自己派出去交回来的话、
 *    卡上交代里点名的那条会话「制作参赛网页」),再按**字面覆盖**挑(卡的标题去掉项目 / 冲刺 / 模块这些大家都有的字,
 *    剩下的字有多少在那条证据里出现)。
 * 3. **判**:模型读挑出来的证据写一句「现在到哪」,**每一句都要附原文摘录**;摘录逐字核过在原文里才算数
 *    ({@link verifyJudgement}),核不上的整条丢掉 → 没有一条核得上 = 「还没看到进展,要你说一句」。
 *    模型没接 / 到了花费上限 / 没回:规则那一套({@link rulesJudge})只拿原话当依据,不写原话里没有的字。
 * 4. **证据里冒出来的下一步**({@link proposalsFrom}):会话里说的「还差 X」、交回来的话里「还差 Y」,
 *    看板上没有的 → 建成「待排」的卡,在「等你确认」里问他要不要加。
 *
 * **口述只当起点**:卡上的描述(引导里他说的)一并交给模型,对不上的写进 `mismatch`,问他。
 */
import { createHash } from 'node:crypto'
import type { ProgressBasisKind, ProgressState, TaskAssignee, TaskProgressView, TaskView } from '../protocol.ts'
import { ASSIGNEE_NAMES, PROGRESS_NONE_LINE, isTaskAssigneeValue, shortMoment } from '../protocol.ts'
import type { SessionTurn as RawTurn } from './sessionDigest.ts'
// 「在等你审」的判据全仓只有一份(卡 T);合并卡 W 09-25 按 .worktrees/留言-卡N-卡T.md 的约定接过来。
import { judgeWaiting } from './waitingForYou.ts'

// ———————————————————————————— 证据条目 ————————————————————————————

export interface EvidenceItem {
  /** 稳定键:`<kind>:<ref>[#…]`。同一份证据两次评估之间是同一个键(没变就不重问模型)。 */
  id: string
  kind: ProgressBasisKind
  /** 给人看的出处(人话):「Codex 里「制作参赛网页」那段对话」「更新说明 0.2.98」「项目里的一次改动(还没并进正式版)」。提交号、路径在 `ref`。 */
  source: string
  /** 对得上的那个东西:会话记录文件、文档路径、提交号、事项 id。 */
  ref?: string
  /** 这条证据的时刻(ISO)。 */
  at?: string
  /** 会话标题 / 提交标题 / 文档标题(拿来比对,也给模型看)。 */
  title?: string
  /** 拿来比对与给模型看的那一段(已截短)。**摘录只能从这里摘**。 */
  text: string
  /** 这条证据直接挂在哪几张卡上(派出去交回来的话、卡上 links 指到的会话、派活记号认出来的会话)。 */
  taskIds?: readonly string[]
  /** 会话类:最后一句是谁说的。他说的 = 球在那家;那家说的 = 球多半在他。 */
  lastBy?: 'him' | 'agent'
  /** 哪个项目的(项目 id)。认不出缺席。 */
  project?: string
  /** 提交:已经在主线上(合进 main 了)。「这几天的总账」只看主线,别的分支上的提交还没算数。 */
  main?: boolean
  /**
   * 提交与文档:**还没合进主线**(出处后面写「还没并进正式版」)。认得出主线时才标;
   * 「现在到哪」里说「还没并进正式版」要有一条这样的依据撑着,说「已上线」不能全靠这样的依据({@link mergeClaimsBacked})。
   */
  unmerged?: true
  /** 文档类(`kind:'handoff'`)是哪一种:工作记录(交接)/ 设计稿 / 验收记录。逻辑按它分,不看出处那几个字(出处是给人看的)。 */
  doc?: 'handoff' | 'design' | 'acceptance'
  /**
   * 会话最后是「他要了一份东西自己先看 → 那家交了 → 他没再回话」:球在他那儿。`what` = 那份东西在等他审(「参赛网页逐屏文案稿在等你审」),
   * `quote` = 那家交东西那一句(逐字,拿来当依据)。见 {@link pendingForHim}。
   */
  pending?: { what: string, quote: string }
}

/**
 * 证据要的一轮:他说的一句 / 那家这一轮的回答(中间的工具调用、思考、半截旁白一概不要)。
 * **读法只有一份**:会话记录文件怎么解析在 `server/sessionDigest.ts`(卡 P,`turnsOf` / `readSessionTurns` 的原文出口),
 * 这里只把它回的原文回合排成证据要的样子({@link evidenceTurns})。
 */
export interface EvidenceTurn {
  role: 'him' | 'agent'
  text: string
  at?: string
}

/** 截短(按码点),超了加「…」。 */
export function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}

/** 空白压成一个空格、去掉 markdown 记号(`**`、行内代码的反引号、链接只留字)。给模型看、给人看都用它。 */
export function plainText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`+/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ———————————————————————————— 读会话:Codex ————————————————————————————

/**
 * 给人看的那几句(卡上的「现在到哪」、依据的出处与摘录、对不上那一句、冒出来的下一步)**不出现开发的东西**
 *(2026-09-25 卡 N;维护者:「从常规用户的第一次使用角度」;统筹:「界面上不许出现证据来源里的文件名、路径、提交号」):
 * 网址、路径、带扩展名的文件名(中文名的留名字、去掉扩展名)、提交号 / 会话号、分支名、提交标题前面的 `feat:` 这类前缀,一概拿掉;
 * 拿完剩下的空括号、多余的标点收一收。只动给人看的字,判的时候核的是原文(核完才过这一道)。
 */
/** 提交标题前面那一截(「chore: 0.2.99 —— …」「fix(卡): …」「merge: …」)。 */
const COMMIT_PREFIX = /^\s*(?:feat|fix|chore|docs|refactor|test|perf|build|ci|style|merge|revert|hotfix|release)(?:\([^)]*\))?\s*[:\uFF1A]\s*/i

export function peopleText(text: string): string {
  const EXT = '(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|swift|py|sh|zsh|ya?ml|toml|html?|css|txt|log|plist|lock|png|jpe?g|gif|webp|svg|pdf|docx?|pptx?|xlsx?|csv|sqlite|db|dmg|zip|apk|tgz)'
  let out = text
    .replace(/`/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(COMMIT_PREFIX, '')
    // 「合进 main」「main 分支」:说人话(与出处里的「还没并进正式版」同一种说法)。
    .replace(/(?:合|并)(?:进|到|入)\s*main\b[ \t]*/gi, '并进正式版')
    .replace(/\bmain\s*(?:分支|branch)/gi, '正式版')
    // 分支名(feat/site、fix/avatar-headroom)。
    .replace(/\b(?:feat|fix|chore|docs|refactor|test|perf|build|ci|style|hotfix|release|origin)\/[\w./-]+/gi, '')
    // 会话号(uuid)、提交号(七位以上十六进制、里面既有数字又有字母)。
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi, '')
  // 路径:以 / ~/ ./ ../ 开头的(前面不紧挨字母汉字 ——「Codex/Claude」不是路径)、两个斜杠以上的英文相对路径、带扩展名的相对路径;
  // 中文文件名只去掉路径与扩展名,名字留着(「参赛网页逐屏文案稿」)。
  const SEG = '[^\\s/,\uFF0C\u3002;\uFF1B\u3001:\uFF1A「」『』()\uFF08\uFF09\\[\\]]+'
  const keepName = (whole: string): string => {
    const last = whole.split('/').filter(one => one !== '').pop() ?? ''
    const name = last.replace(new RegExp(`\\.${EXT}$`, 'i'), '')
    return /[\u3400-\u9fff]/u.test(name) ? name : ''
  }
  out = out
    .replace(new RegExp(`(?<![\\w\\u3400-\\u9fff])(?:~|\\.{1,2})?\\/(?:${SEG}\\/)*${SEG}`, 'g'), keepName)
    .replace(/[\w.-]+(?:\/[\w.-]+){2,}/g, keepName)
    .replace(new RegExp(`(?:${SEG}\\/)+${SEG}\\.${EXT}\\b`, 'gi'), keepName)
  out = out.replace(new RegExp(`([^\\s,\uFF0C\u3002;\uFF1B\u3001:\uFF1A「」『』()\uFF08\uFF09]*)\\.${EXT}\\b`, 'gi'), (_whole: string, name: string) => (/[\u3400-\u9fff]/u.test(name) ? name : ''))
  return out
    .replace(/[(\uFF08]\s*[,\uFF0C\u3001;\uFF1B]?\s*[)\uFF09]/g, '')
    .replace(/「\s*」|『\s*』/g, '')
    .replace(/([(\uFF08])\s*[,\uFF0C\u3001;\uFF1B]\s*/g, '$1')
    .replace(/\s*[,\uFF0C\u3001;\uFF1B]\s*([)\uFF09])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,\uFF0C\u3002;\uFF1B!\uFF01?\uFF1F)\uFF09])/g, '$1')
    .replace(/^[\s,\uFF0C\u3001;\uFF1B:\uFF1A\u2014\-·]+|[\s,\uFF0C\u3001;\uFF1B:\uFF1A\u2014\-·]+$/g, '')
    .trim()
}

/**
 * 摘录给人看的那一版。摘录是逐字摘的原话:里面要是夹着文件名、路径、提交号、网址这些,**整句不给看** ——
 * 剥掉之后剩下的常常是半句(「改了 和,还差文案」),半句话比不给更糟;剥完只剩三个字以内的也不给。
 * 提交标题前面那一截(「fix(派活):」)、反引号这类记号剥掉不算。不给摘录时依据照样有出处与时刻。
 */
export function shownQuote(quote: string): string {
  const shown = peopleText(quote)
  const core = (text: string): string => text.replace(/[\s`,\uFF0C\u3002\u3001;\uFF1B:\uFF1A!\uFF01?\uFF1F()\uFF08\uFF09「」『』\-\u2014·.\u2026]/g, '')
  if (core(shown) !== core(quote.replace(COMMIT_PREFIX, ''))) return ''
  return [...core(shown)].length >= 4 ? shown : ''
}

/** 他那句话里夹着的 App 注入块(浏览器上下文、「文件」清单、环境块)去掉,只留他打的字。 */
export function cleanRequest(text: string): string {
  let out = text
  // Codex 桌面版:「# Files mentioned by the user: … ## My request: <他的话>」
  const mine = /##\s*My request:\s*([\s\S]*)$/.exec(out)
  if (mine !== null) out = mine[1] ?? ''
  // 语音那一路:<realtime_delegation> <input>他说的</input> …
  const spoken = /<input>([\s\S]*?)<\/input>/.exec(out)
  if (spoken !== null && /<realtime_delegation>/.test(out)) out = spoken[1] ?? ''
  out = out
    .replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/g, '')
    .replace(/<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/g, (_m, inner: string) => {
      const answer = /"answer"\s*:\s*"([^"]*)"/.exec(inner)
      return answer === null ? '' : answer[1] ?? ''
    })
  return plainText(out)
}

/** 他那句话里夹着的系统提醒(Claude 偶尔把 `<system-reminder>…</system-reminder>` 夹在他那一段中间)。 */
function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
}

/**
 * 卡 P 那一份读法回的原文回合 → 证据要的「他说的 / 那家这一轮的回答」。
 *
 * - 他说的:App 夹进来的上下文块剥掉({@link cleanRequest}),剩下空的(只贴了图)不要;
 * - 那家说的:**一轮只留这一轮的回答** —— 有最终回答(Claude `end_turn`、Codex `final_answer`)就拼这几段;
 *   这一轮还没说完(或老格式没标最终)就留这一轮最后那一句;中间的旁白不要;
 * - 相邻两句一模一样(新旧两种写法各记一遍)只留一句。
 */
export function evidenceTurns(raw: readonly RawTurn[]): EvidenceTurn[] {
  const out: EvidenceTurn[] = []
  let round: RawTurn[] = []
  const flush = (): void => {
    if (round.length === 0) return
    const finals = round.filter(one => one.final === true)
    const picked = finals.length > 0 ? finals : [round[round.length - 1] as RawTurn]
    const text = plainText(picked.map(one => one.text).join('\n'))
    const at = picked[picked.length - 1]?.at
    if (text !== '') out.push({ role: 'agent', text, ...(at === undefined ? {} : { at }) })
    round = []
  }
  for (const turn of raw) {
    if (turn.k === 'reply') { round.push(turn); continue }
    flush()
    const text = cleanRequest(stripReminders(turn.text))
    if (text !== '') out.push({ role: 'him', text, ...(turn.at === undefined ? {} : { at: turn.at }) })
  }
  flush()
  const deduped: EvidenceTurn[] = []
  for (const turn of out) {
    const last = deduped[deduped.length - 1]
    if (last !== undefined && last.role === turn.role && last.text === turn.text) continue
    deduped.push(turn)
  }
  return deduped
}

/**
 * 一段会话的最后几轮 → 一条证据的正文:「他最后说:… / Codex 最后答:…」(各自截短)。
 * 最后一句是谁说的记在 `lastBy`:他说的 = 那家还欠他一个回答(或者正在做);那家说的 = 球多半在他那边。
 */
export function sessionEvidenceText(turns: readonly EvidenceTurn[], agentName: string, maxTurns = 4): { text: string, at?: string, lastBy?: 'him' | 'agent' } {
  const tail = turns.slice(-maxTurns)
  if (tail.length === 0) return { text: '' }
  // 最后那一轮给得长一点(那是「现在到哪」的主要依据),前面几轮只留个头。
  const parts = tail.map((turn, index) => turn.role === 'him'
    ? `他说:「${clip(turn.text, 220)}」`
    : `${agentName} 答:「${clip(turn.text, index >= tail.length - 2 ? 520 : 240)}」`)
  const last = tail[tail.length - 1] as EvidenceTurn
  return { text: parts.join('\n'), ...(last.at === undefined ? {} : { at: last.at }), lastBy: last.role }
}

/** 测试时留下的会话(「[派活测试]」「派活的连通测试」):不当任何一张卡的证据。 */
export function isTestSession(turns: readonly EvidenceTurn[]): boolean {
  return isTestAsk(turns.find(turn => turn.role === 'him')?.text)
}

/** 他的第一句(卡 P 读法回的 `first_ask`)是不是测试时留下的。 */
export function isTestAsk(firstAsk: string | undefined): boolean {
  return firstAsk !== undefined && /\[(?:派活测试|测试)|连通测试/.test(firstAsk)
}

/**
 * 会话最后一来一回是不是「他要了一份东西自己先看,那家交了,之后他没回话」—— 这时候球在他那儿
 * (维护者 09-24 晚在 Codex 里说「给我一个文档…我自己先看着看看」,Codex 交了「参赛网页逐屏文案稿」,之后一直没回)。
 * 认两样:他那句里有「给我 / 发我 / 整理 …… 文档 / 稿 / 文件 …… 看 / 审」;那家那句里有「已整理成 / 已写好 / 已做成 X」。
 * 认不出就不说 —— 这只是给「在等谁」一个确定的来源,不替模型下别的结论。
 */
export function pendingForHim(turns: readonly EvidenceTurn[]): { what: string, quote: string } | undefined {
  const verdict = judgeWaiting({ turns: turns.map(one => evidenceTurnAsSessionTurn(one)) })
  if (!verdict.waiting || verdict.kind !== 'review' || verdict.what === undefined || verdict.quote === undefined) return undefined
  return { what: `${verdict.what}在等你审`, quote: verdict.quote }
}

/** 一轮证据 → 卡 T 那份判据要的形状。证据这边一轮只留一段回答,所以那一段都是最终回答。 */
function evidenceTurnAsSessionTurn(turn: EvidenceTurn): RawTurn {
  return {
    k: turn.role === 'him' ? 'ask' : 'reply',
    text: turn.text,
    ...(turn.at === undefined ? {} : { at: turn.at }),
    ...(turn.role === 'agent' ? { final: true as const } : {}),
  }
}

/** 他说的第一句里有没有派活记号(「【工作台派活 371c3b】」)→ 这条会话就是那张卡派出去的。 */
export function dispatchMarkerOf(turns: readonly EvidenceTurn[]): string | undefined {
  return dispatchMarkerIn(turns.find(turn => turn.role === 'him')?.text)
}

/** 同上,直接看他的第一句(卡 P 读法回的 `first_ask`,不截:大文件的尾巴里读不到第一句)。 */
export function dispatchMarkerIn(firstAsk: string | undefined): string | undefined {
  if (firstAsk === undefined) return undefined
  const match = /工作台派活 ([0-9a-zA-Z]{4,})/.exec(firstAsk)
  return match === null ? undefined : match[1]
}

// ———————————————————————————— 读仓库:发版记录、文档、决策记录 ————————————————————————————

export interface ReleaseRow { version: string, date: string, text: string, handoff?: string }

/**
 * `docs/发版记录.md` 的表 → 一行一版。日期列只写了「09-25」,年份按「离今天最近的那一年」补(跨年那几天不猜错)。
 */
export function releaseRows(md: string, now: Date): ReleaseRow[] {
  const out: ReleaseRow[] = []
  for (const line of md.split('\n')) {
    const cells = line.split('|').map(cell => cell.trim())
    // | 版本 | 日期 | 你会看到什么 | 交接 |  → ['', v, d, text, handoff, '']
    if (cells.length < 5) continue
    const version = cells[1] ?? ''
    const date = cells[2] ?? ''
    if (!/^\d+\.\d+\.\d+/.test(version) || !/^\d{1,2}-\d{1,2}$/.test(date)) continue
    const [month, day] = date.split('-').map(Number) as [number, number]
    let year = now.getFullYear()
    const candidate = new Date(year, month - 1, day)
    if (candidate.getTime() - now.getTime() > 60 * 86_400_000) year -= 1
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const handoff = (cells[4] ?? '').replace(/`/g, '').trim()
    out.push({ version, date: iso, text: plainText(cells[3] ?? ''), ...(handoff === '' ? {} : { handoff }) })
  }
  return out
}

/**
 * 一份交接 / 设计 / 验收文档 → 标题 + 一段摘要(优先「一句话」那一节,其次标题下面第一段正文)。
 */
/** 文档开头那种「这件活的范围 / 出处」的行(分支、worktree、设计与决策在哪、截图放哪)。 */
const DOC_META_LINE = /^(?:[-*]\s*)?(?:\*\*)?(?:分支|提交|worktree|截图|灰度|版本号|与最新|出处|来源|依据|先读|设计依据|决策记录那一节|决策与待拍板)/

export function docSummary(md: string, max = 200): { title: string, text: string } {
  const lines = md.split('\n')
  const titleLine = lines.find(line => /^#\s+/.test(line))
  const title = titleLine === undefined ? '' : plainText(titleLine.replace(/^#\s+/, ''))
  const oneLiner = lines.findIndex(line => /^#{2,3}\s.*一句话/.test(line))
  const start = oneLiner >= 0 ? oneLiner + 1 : (titleLine === undefined ? 0 : lines.indexOf(titleLine) + 1)
  const body: string[] = []
  for (let i = start; i < lines.length && body.join('').length < max; i += 1) {
    const line = lines[i] as string
    if (/^#{1,3}\s/.test(line) && body.length > 0) break
    // 开头那几行常是「分支 X(worktree Y),从 origin/main 开,不合并、不部署」这类**这件活的范围**,不是它做到哪了 ——
    // 真看板副本上撞到过:「部署上线」被一份交接开头的「不合并 main,不部署」撑成了「未部署」。
    if (line.trim() === '' || /^>/.test(line.trim()) || DOC_META_LINE.test(line.trim()) || /worktree|origin\/main|merge-tree|docs\//.test(line)) continue
    if (/^```/.test(line.trim())) continue
    body.push(line.trim())
  }
  // 只留第一句:交接写下那一刻的附注(「但真系统里现在装的还是旧版」)几个小时后就过时了,标题与第一句才是这份文档说的那件事。
  const plain = plainText(body.join(' '))
  const first = /^[\s\S]*?[。!?\uFF01\uFF1F]/.exec(plain)
  return { title, text: clip(first === null ? plain : first[0], max) }
}

export interface DecisionSection { heading: string, date: string, text: string }

/** `docs/决策记录.md` 里 `## 2026-09-25 · xxx` 那种一节一节 → 标题、日期、开头一段。 */
export function decisionSections(md: string, max = 360): DecisionSection[] {
  const out: DecisionSection[] = []
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^##\s+(\d{4}-\d{2}-\d{2})\s*[·・:-]?\s*(.*)$/.exec(lines[i] as string)
    if (match === null) continue
    const body: string[] = []
    for (let j = i + 1; j < lines.length && body.join('').length < max; j += 1) {
      const line = lines[j] as string
      if (/^##\s/.test(line)) break
      if (line.trim() !== '') body.push(line.trim())
    }
    out.push({ heading: plainText(match[2] ?? ''), date: match[1] as string, text: clip(plainText(body.join(' ')), max) })
  }
  return out
}

// ———————————————————————————— 比对:这条证据说的是不是这件事 ————————————————————————————

/** 这几个说法在这个产品里说的是一回事(比对前先换成同一个字)。 */
const SYNONYMS: readonly (readonly [RegExp, string])[] = [
  [/派单|下发|发活/g, '派活'],
  [/余额/g, '额度'],
  [/网站/g, '网页'],
  [/截屏/g, '截图'],
  [/部署上线|上线部署/g, '部署上线'],
  // 「改工作台自己」「事务官自己修的」说的就是自我迭代(设计第一节第 6 条)。
  [/事务官自己修|自己修的|自修|改工作台自己|改自己/g, '自我迭代'],
]

/** 全角转半角、大小写合一、同义说法换成同一个字。 */
export function normalizeText(text: string): string {
  let out = text.normalize('NFKC').toLowerCase()
  for (const [pattern, word] of SYNONYMS) out = out.replace(pattern, word)
  return out
}

/** 卡的标题里「大家都有、说明不了是哪一件」的字:动作词、程度词。 */
const GENERIC_WORDS = ['收尾', '完成', '准确', '一下', '相关', '进一步', '问题', '事情', '能力', '处理', '搞定', '弄好', '做好', '整理好', '准备好']

/** 比对只看这几类字:汉字、字母、数字。 */
function isWordChar(ch: string): boolean {
  return /[\p{Script=Han}a-z0-9]/u.test(ch)
}

/**
 * 一张卡拿来比对的「主语」:标题(换成同义说法)+ 每个字算不算数。
 * **不算数的字**:项目名、冲刺名、模块名里出现过的两字词(「参赛」在「参赛材料」模块里人人都有)、动作 / 程度词、标点。
 */
export function cardSubject(title: string, context: readonly string[]): { text: string, weight: boolean[] } {
  const text = normalizeText(title)
  const chars = [...text]
  const weight = chars.map(isWordChar)
  const contextBigrams = new Set<string>()
  for (const name of context) {
    const c = [...normalizeText(name)].filter(isWordChar)
    for (let i = 0; i + 1 < c.length; i += 1) contextBigrams.add(`${c[i]}${c[i + 1]}`)
  }
  for (let i = 0; i + 1 < chars.length; i += 1) {
    if (contextBigrams.has(`${chars[i]}${chars[i + 1]}`) && /\p{Script=Han}/u.test(chars[i] as string)) { weight[i] = false; weight[i + 1] = false }
  }
  for (const word of GENERIC_WORDS) {
    let from = text.indexOf(word)
    while (from >= 0) {
      const index = [...text.slice(0, from)].length
      for (let k = 0; k < [...word].length; k += 1) weight[index + k] = false
      from = text.indexOf(word, from + word.length)
    }
  }
  // 纯数字 / 日期(「9/28」「10-04」)不拿来比:截止日在每份文档里都可能出现。
  for (let i = 0; i < chars.length; i += 1) if (/[0-9]/.test(chars[i] as string)) weight[i] = false
  return { text, weight }
}

/**
 * 主语有多少「算数的字」在这段证据里连着出现过(至少两个字连着才算,单字到处都是)。0–1。
 *
 * 为什么不按词频 / 词向量:中文没有空格,切词本身就会出错;而「这张卡的字有几成出现在那段话里」是他自己
 * 也会用的判法 —— 「注册域名」和一段只提到「注册页」的话,覆盖一半,只能当候选交给模型去判,不能当证据。
 */
export function coverage(subject: { text: string, weight: readonly boolean[] }, evidence: string): number {
  const chars = [...subject.text]
  const total = subject.weight.filter(Boolean).length
  if (total === 0) return 0
  const hay = normalizeText(evidence)
  const covered = new Array<boolean>(chars.length).fill(false)
  for (let i = 0; i < chars.length; i += 1) {
    if (!isWordChar(chars[i] as string)) continue
    // 从 i 起能连着对上的最长一段(≥ 2 个字)。
    let best = 0
    for (let j = i + 2; j <= chars.length; j += 1) {
      const piece = chars.slice(i, j).join('')
      if (!isWordChar(chars[j - 1] as string)) break
      if (hay.includes(piece)) best = j - i
      else break
    }
    for (let k = 0; k < best; k += 1) covered[i + k] = true
  }
  let hit = 0
  for (let i = 0; i < chars.length; i += 1) if (subject.weight[i] === true && covered[i] === true) hit += 1
  return hit / total
}

/**
 * 主语里**连着**出现在证据里的最长那一段占几成(0–1)。`coverage` 允许「部署」「上线」分散在两处也算满分,
 * 拿来挑候选够了(模型再判);规则那一套自己下结论时要这一把更严的尺:整个主语差不多原样出现过才算。
 */
export function contiguity(subject: { text: string, weight: readonly boolean[] }, evidence: string): number {
  const chars = [...subject.text]
  const total = subject.weight.filter(Boolean).length
  if (total === 0) return 0
  const hay = normalizeText(evidence)
  let best = 0
  for (let i = 0; i < chars.length; i += 1) {
    for (let j = chars.length; j >= i + 2; j -= 1) {
      if (!hay.includes(chars.slice(i, j).join(''))) continue
      let weighted = 0
      for (let k = i; k < j; k += 1) if (subject.weight[k] === true) weighted += 1
      if (weighted > best) best = weighted
      break
    }
  }
  return best / total
}

/**
 * 标题里用「/」「+」「、」「和」并起来的几件(「额度显示 / 会话读取」)拆开各比各的,取最好的那件 ——
 * 一条只讲「额度」的发版记录也是这张卡的证据。
 */
export function titleParts(title: string): string[] {
  const parts = title.split(/\s*(?:[/／+＋、]|\s和\s)\s*/).map(one => one.trim()).filter(one => [...one].filter(isWordChar).length >= 2)
  return parts.length <= 1 ? [title] : [title, ...parts]
}

/** 一张卡要拿去核的样子(从 TaskView 摘的那几样 + 它所在的项目 / 冲刺 / 模块叫什么)。 */
export interface EvalCard {
  id: string
  title: string
  /** 卡上写的(引导口述、他交代的原话)。只当起点。 */
  desc?: string
  status: TaskView['status']
  assignee?: TaskAssignee
  assignee_note?: string
  due?: string
  project_id?: string
  /** 项目名、冲刺名、模块名(比对时这些字不算数)。 */
  context: readonly string[]
  /** 卡上 links / conversation 指到的会话 id。 */
  sessionIds: readonly string[]
  /** 卡上交代里点名的那条会话(「接着『制作参赛网页』那条会话」)。 */
  namedSessions: readonly string[]
  updated_at?: string
  done_at?: string
}

export interface Candidate {
  ev: EvidenceItem
  score: number
  /** 直连(挂在这张卡上的会话 / 这张卡派出去交回来的话 / 卡上点名的会话),不靠字面。 */
  strong: boolean
}

/** 卡上交代 / 描述里用「」点名的会话名(「接着『制作参赛网页』那条会话」)。 */
export function namedSessionsIn(texts: readonly (string | undefined)[]): string[] {
  const out = new Set<string>()
  for (const text of texts) {
    if (text === undefined) continue
    for (const match of text.matchAll(/[「『]([^」』]{2,30})[」』](?:那条|这条)?会话/g)) out.add((match[1] as string).trim())
  }
  return [...out]
}

/** 一条证据配这张卡的分数:标题整体与拆开的几件取最好的。 */
export function scoreEvidence(card: EvalCard, ev: EvidenceItem): number {
  const hay = `${ev.title ?? ''}\n${ev.text}`
  let best = 0
  for (const part of titleParts(card.title)) {
    // 覆盖与「连着出现」各占一半:一段长会话里「手机」「派活」「汇报」散落各处,不如一条发版记录里「远程派活」连着出现像。
    const subject = cardSubject(part, card.context)
    const score = 0.5 * coverage(subject, hay) + 0.5 * contiguity(subject, hay)
    if (score > best) best = score
  }
  return best
}

// ———————————————————————————— 打分增量化(8791 第四轮) ————————————————————————————

/**
 * (卡, 证据) 对的分数缓存:pickCandidates 每拍对全板证据重打分是 8791 空转热点之一,
 * 指纹没变就复用上一次的分数。每个服务一份,进程内活多久都行 —— 指纹挡着,旧条目命中不了。
 */
export interface ScoreCache {
  get: (key: string) => number | undefined
  set: (key: string, score: number) => void
}

const SCORE_CACHE_CAPACITY = 4096
/** 容量按 FIFO 清一半:打分是纯函数,清了重算即可,不需要精确的 LRU。 */
export function createScoreCache(capacity = SCORE_CACHE_CAPACITY): ScoreCache {
  const scores = new Map<string, number>()
  return {
    get: (key) => scores.get(key),
    set: (key, score) => {
      if (scores.has(key)) scores.delete(key)
      scores.set(key, score)
      if (scores.size > capacity) {
        const drop = Math.floor(capacity / 2)
        for (const old of scores.keys()) {
          scores.delete(old)
          if (scores.size <= drop) break
        }
      }
    },
  }
}

const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex')
/**
 * 打分键同时含卡与证据的内容指纹:卡改了名 / 上下文变了、证据长了新内容(只看前 800 字,后面长了不重算 ——
 * 打分只读全文的归一化包含关系,尾巴上新的一句改变不了主语的覆盖),指纹才变、自动重算;没变才复用。
 */
function scoreKeyOf(card: EvalCard, ev: EvidenceItem): string {
  return `${card.id} ${digestOf(`${card.title}${card.context.join('')}`)} ${ev.id} ${digestOf(`${ev.title ?? ''}${ev.text.slice(0, 800)}`)}`
}

export interface PickOptions {
  /** 字面覆盖到多少才当候选(交给模型判)。 */
  minScore?: number
  /** 每张卡最多几条候选(直连的不占名额上限的一半以上)。 */
  maxPerCard?: number
  /** (卡, 证据) 分数缓存:同指纹的对不再重调 score。 */
  scoreCache?: ScoreCache
  /** 打分函数(测试 seam):缺席 = {@link scoreEvidence}。 */
  score?: (card: EvalCard, ev: EvidenceItem) => number
}

export const CANDIDATE_MIN_SCORE = 0.45
export const CANDIDATES_PER_CARD = 6

/**
 * 同分时先看哪一类:交回来的话、会话最后几轮说的是「现在」,交接与发版记录是给人看的总结,提交标题最干。
 * (决策记录是「为什么这么定」,不是「做到哪了」,排在后面。)
 */
const KIND_RANK: Readonly<Record<EvidenceItem['kind'], number>> = {
  dispatch: 0, item: 0, said: 0, session: 1, handoff: 2, release: 3, commit: 4, decision: 5,
}

/**
 * 每张卡挑几条证据:直连的在前(新的在前),字面覆盖够的补上(分高的在前,同分新的在前)。
 * 会话类同一条会话只留一条(同一条会话的几种来源:卡上 links、派活记号、字面,算一条)。
 */
export function pickCandidates(cards: readonly EvalCard[], evidence: readonly EvidenceItem[], options: PickOptions = {}): Map<string, Candidate[]> {
  const minScore = options.minScore ?? CANDIDATE_MIN_SCORE
  const max = options.maxPerCard ?? CANDIDATES_PER_CARD
  const scoreOf = options.score ?? scoreEvidence
  const scoreCache = options.scoreCache
  const rarity = rarityOf(evidence)
  const out = new Map<string, Candidate[]>()
  for (const card of cards) {
    const picked = new Map<string, Candidate & { rare: number }>()
    for (const ev of evidence) {
      const linked = (ev.taskIds ?? []).includes(card.id)
        || (ev.kind === 'session' && ev.ref !== undefined && card.sessionIds.some(id => ev.ref?.includes(id) === true))
        || (ev.kind === 'session' && ev.title !== undefined && card.namedSessions.includes(ev.title))
      // 别的项目的证据不配这张卡(卡挂了项目、证据也认得出项目时才比)。
      if (!linked && card.project_id !== undefined && ev.project !== undefined && ev.project !== card.project_id) continue
      // linked 照旧不打分;非 linked 先查指纹缓存,没变就复用上拍的分数。
      let score: number
      if (linked) score = 1
      else if (scoreCache === undefined) score = scoreOf(card, ev)
      else {
        const key = scoreKeyOf(card, ev)
        const hit = scoreCache.get(key)
        if (hit !== undefined) score = hit
        else { score = scoreOf(card, ev); scoreCache.set(key, score) }
      }
      if (!linked && score < minScore) continue
      // 决策记录是「当时定了什么」,不是做到哪了;而且一节常常很长、什么词都有 —— 要主语差不多原样出现才配这张卡
      //(「打磨自媒体布局」配不上「引导里先问布局」那一节)。
      if (!linked && ev.kind === 'decision' && !subjectVerbatim(card, `${ev.title ?? ''}\n${ev.text}`)) continue
      // 证据项自己那一套 key(不是 `jobKey` 那个会话键;两者从不互相比对,2026-10-03 查过)。
      const key = ev.kind === 'session' ? `session:${ev.ref ?? ev.id}` : ev.id
      const have = picked.get(key)
      const rare = rarity(card, ev)
      if (have === undefined || (linked && !have.strong) || score > have.score) picked.set(key, { ev, score, strong: linked, rare })
    }
    const ranked = [...picked.values()].sort((a, b) => {
      if (a.strong !== b.strong) return a.strong ? -1 : 1
      if (Math.abs(a.score - b.score) > 0.05) return b.score - a.score
      // 同分:对上的字越少见越像(「额度」只在几条证据里出现,「显示」「会话」到处都是)。
      if (Math.abs(a.rare - b.rare) > 0.05) return b.rare - a.rare
      if (KIND_RANK[a.ev.kind] !== KIND_RANK[b.ev.kind]) return KIND_RANK[a.ev.kind] - KIND_RANK[b.ev.kind]
      return (b.ev.at ?? '').localeCompare(a.ev.at ?? '')
    })
    // 两条说的是同一段话(派出去的活交回来的话 = 那家那条会话的最后一轮)只留排在前面那条。
    const kept: Candidate[] = []
    const seen: string[] = []
    for (const one of ranked) {
      const body = quoteKey(answerParts(one.ev.text)).slice(0, 400)
      if (body.length >= 20 && seen.some(other => other.includes(body.slice(0, 120)) || body.includes(other.slice(0, 120)))) continue
      seen.push(body)
      kept.push({ ev: one.ev, score: one.score, strong: one.strong })
      if (kept.length >= max) break
    }
    out.set(card.id, kept)
  }
  return out
}

/**
 * 同分时排先后用的「像不像」(0–1):对上的两字词**越少见、在那条证据里出现得越多**越像
 * (「额度」只在几条证据里出现、而在「额度只列有额度的家」那一版里出现三次;「显示」「会话」到处都是)。
 * 只在同分时拿来排先后,不拿来决定要不要(那是覆盖与连着出现的事)。
 */
function rarityOf(evidence: readonly EvidenceItem[]): (card: EvalCard, ev: EvidenceItem) => number {
  const df = new Map<string, number>()
  const tf = new Map<string, Map<string, number>>()
  for (const ev of evidence) {
    const chars = [...normalizeText(`${ev.title ?? ''}\n${ev.text}`)].filter(isWordChar)
    const counts = new Map<string, number>()
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const bigram = `${chars[i]}${chars[i + 1]}`
      counts.set(bigram, (counts.get(bigram) ?? 0) + 1)
    }
    tf.set(ev.id, counts)
    for (const bigram of counts.keys()) df.set(bigram, (df.get(bigram) ?? 0) + 1)
  }
  const n = Math.max(1, evidence.length)
  const idf = (bigram: string): number => Math.log((n + 1) / ((df.get(bigram) ?? 0) + 1))
  return (card, ev) => {
    const counts = tf.get(ev.id)
    if (counts === undefined) return 0
    let best = 0
    for (const part of titleParts(card.title)) {
      const subject = cardSubject(part, card.context)
      const chars = [...subject.text]
      let hit = 0
      let all = 0
      for (let i = 0; i + 1 < chars.length; i += 1) {
        if (subject.weight[i] !== true || subject.weight[i + 1] !== true) continue
        const bigram = `${chars[i]}${chars[i + 1]}`
        const weight = idf(bigram)
        all += weight
        const count = counts.get(bigram) ?? 0
        if (count > 0) hit += weight * Math.min(2, 1 + Math.log(count))
      }
      if (all > 0) best = Math.max(best, hit / (2 * all))
    }
    return best
  }
}

// ———————————————————————————— 判:问模型 + 逐字核摘录 ————————————————————————————

/** 模型回的一张卡(核之前的样子)。 */
export interface RawJudgement {
  id: string
  found: boolean
  now?: string
  waiting_on?: string
  /** 在等他做的那件事(「审逐屏文案稿」),要有摘录撑着。 */
  waiting_for?: { what: string, e: string, quote: string }
  basis: { e: string, quote: string }[]
  next: { title: string, owner?: string, e: string, quote: string }[]
  mismatch?: string
}

/** 核过的一张卡。 */
export interface Judgement {
  taskId: string
  state: ProgressState
  line: string
  basis: { ev: EvidenceItem, quote: string }[]
  waiting_on?: TaskProgressView['waiting_on']
  mismatch?: string
  next: ProposedStep[]
  by: 'model' | 'rules'
}

export interface ProposedStep {
  title: string
  owner?: TaskAssignee
  quote: string
  ev: EvidenceItem
  /** 哪张卡的证据里冒出来的。 */
  fromTask: string
}

/** 核摘录时的归一:去掉空白、标点、markdown 记号,全角转半角。 */
export function quoteKey(text: string): string {
  return normalizeText(text).replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 摘录是不是逐字在原文里(归一之后)。太短的(≤ 3 个字)不算 —— 那种什么都能「在原文里」。 */
export function quoteFound(quote: string, evidenceText: string): boolean {
  const key = quoteKey(quote)
  if ([...key].length < 4) return false
  return quoteKey(evidenceText).includes(key)
}

/** 说「还没并进正式版 / 还没合」的那一截。 */
const SAYS_UNMERGED = /还没(?:有)?(?:并|合)(?:进|到|入|并)?(?:正式版|主线|main)?|未(?:并|合)(?:进|入)|没(?:并|合)进|还在分支/
/** 说「已经上线 / 发了版」的那一截。 */
const SAYS_SHIPPED = /已(?:经)?上线|上线了|已(?:经)?发(?:了)?版|发了版|已(?:经)?发布|已(?:经)?并进正式版/

/**
 * 「现在到哪」里关于「并没并进正式版」的那一截要有依据撑着(2026-09-25 真看板副本上撞到:0.2.99 已经发了、依据是主线上的提交与发版记录,
 * 模型却写「还没并进正式版」—— 它把总账里别的卡那几份分支交接的标签套到了这张上)。**同 {@link numbersBacked} 一个道理:一句话里的每个说法都要有依据**:
 * - 说「还没并进正式版」,依据里却没有一条还没合进主线的 → 这一截拿掉;
 * - 说「已上线 / 发了版」,依据却全是还没合进主线的 → 这一截换成「还没并进正式版」。
 * 按逗号、分号切成几截,只动说这件事的那几截;全拿掉了回空串(调用方退回摘录)。
 */
export function mergeClaimsBacked(line: string, basis: readonly Pick<EvidenceItem, 'unmerged' | 'kind'>[]): string {
  const anyUnmerged = basis.some(ev => ev.unmerged === true)
  const allUnmerged = basis.length > 0 && basis.every(ev => ev.unmerged === true)
  const SEP = /([,\uFF0C;\uFF1B\u3001\u3002])/
  const EDGE = /^[\s,\uFF0C;\uFF1B\u3001]+|[\s,\uFF0C;\uFF1B\u3001]+$/g
  const parts = line.split(SEP)
  const out: string[] = []
  let changed = false
  for (let i = 0; i < parts.length; i += 2) {
    let part = parts[i] as string
    const sep = parts[i + 1] ?? ''
    if (!anyUnmerged && SAYS_UNMERGED.test(part)) {
      part = part.replace(SAYS_UNMERGED, '').replace(EDGE, '')
      changed = true
    }
    else if (allUnmerged && SAYS_SHIPPED.test(part)) {
      part = part.replace(SAYS_SHIPPED, '还没并进正式版')
      changed = true
    }
    if (part.trim() === '') continue
    out.push(part, sep)
  }
  if (!changed) return line
  return out.join('').replace(/[\s,\uFF0C;\uFF1B\u3001]+$/, '').trim()
}

/** 「现在到哪」那一句里的数字(「11 屏」「22 项」)必须在核过的摘录或卡的标题里出现过 —— 不许凭空多出一个数。 */
export function numbersBacked(line: string, backing: readonly string[]): boolean {
  const numbers = line.match(/\d+(?:\.\d+)*/g) ?? []
  if (numbers.length === 0) return true
  const hay = backing.map(one => one.normalize('NFKC')).join('\n')
  return numbers.every(num => hay.includes(num))
}

const WAITING_ON: Readonly<Record<string, TaskProgressView['waiting_on']>> = {
  me: 'me', him: 'me', user: 'me', 他: 'me', 你: 'me',
  agent: 'agent', ai: 'agent',
  others: 'others', colleague: 'others', other: 'others', 同事: 'others', 别人: 'others',
  nobody: 'nobody', none: 'nobody',
}

/** 模型回的 JSON → 一张一张的判断(形状不对的那一张丢掉,不整份丢)。 */
/**
 * 模型回的那段字不是一整份合法 JSON 时(真看板副本上撞到过:第二件漏了 `"basis":[`,整批三件全作废、退回规则),
 * **一件一件捞**:从每个 `{"id":"T…` 起按括号配对切出那一件,能解析的留下,解析不了的那一件丢掉(退回规则)。
 * 引号里的括号不算(按字符串状态走)。一件都捞不到回 undefined。
 */
export function salvageJudgeItems(text: string): { items: unknown[] } | undefined {
  const items: unknown[] = []
  const starts: number[] = []
  const re = /\{\s*"id"\s*:\s*"T\d+"/g
  for (let match = re.exec(text); match !== null; match = re.exec(text)) starts.push(match.index)
  for (const start of starts) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i] as string
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try { items.push(JSON.parse(text.slice(start, i + 1))) }
          catch { /* 这一件坏了,丢掉 */ }
          break
        }
      }
    }
  }
  return items.length === 0 ? undefined : { items }
}

export function parseJudgeReply(value: unknown): RawJudgement[] | undefined {
  const items = (value as { items?: unknown } | undefined)?.items
  if (!Array.isArray(items)) return undefined
  const out: RawJudgement[] = []
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue
    const one = raw as Record<string, unknown>
    if (typeof one.id !== 'string') continue
    const basis = Array.isArray(one.basis)
      ? one.basis.filter((b): b is { e: string, quote: string } => typeof b === 'object' && b !== null && typeof (b as { e?: unknown }).e === 'string' && typeof (b as { quote?: unknown }).quote === 'string')
      : []
    const next = Array.isArray(one.next)
      ? one.next.filter((n): n is { title: string, owner?: string, e: string, quote: string } => typeof n === 'object' && n !== null
        && typeof (n as { title?: unknown }).title === 'string' && typeof (n as { e?: unknown }).e === 'string' && typeof (n as { quote?: unknown }).quote === 'string')
      : []
    out.push({
      id: one.id,
      found: one.found === true,
      ...(typeof one.now === 'string' ? { now: one.now } : {}),
      ...(typeof one.waiting_on === 'string' ? { waiting_on: one.waiting_on } : {}),
      ...(typeof one.waiting_for === 'object' && one.waiting_for !== null
        && typeof (one.waiting_for as { what?: unknown }).what === 'string' && (one.waiting_for as { what: string }).what.trim() !== ''
        && typeof (one.waiting_for as { e?: unknown }).e === 'string' && typeof (one.waiting_for as { quote?: unknown }).quote === 'string'
        ? { waiting_for: one.waiting_for as { what: string, e: string, quote: string } }
        // 平铺的那种写法(问模型时用它:少一层括号,少写错一回)。
        : typeof one.wait_what === 'string' && one.wait_what.trim() !== '' && typeof one.wait_e === 'string' && typeof one.wait_quote === 'string'
          ? { waiting_for: { what: one.wait_what, e: one.wait_e, quote: one.wait_quote } }
          : {}),
      basis,
      next,
      ...(typeof one.mismatch === 'string' && one.mismatch.trim() !== '' ? { mismatch: one.mismatch.trim() } : {}),
    })
  }
  return out
}

const OWNER_WORDS: Readonly<Record<string, TaskAssignee>> = {
  me: 'me', him: 'me', 他: 'me', 你: 'me', 事务官: 'dsh', butler: 'dsh', 同事: 'colleague', 别人: 'other',
}

function ownerOf(value: string | undefined): TaskAssignee | undefined {
  if (value === undefined) return undefined
  const key = value.trim().toLowerCase()
  if (isTaskAssigneeValue(key)) return key
  return OWNER_WORDS[key] ?? OWNER_WORDS[value.trim()]
}

/**
 * 模型那一份逐条核:
 * - 依据:`e` 得是交给它的那几条之一,`quote` 得**逐字**在那条原文里(归一之后)—— 核不上的丢掉;
 * - 一条依据都没核上 → 「还没看到进展,要你说一句」(不管它说自己找没找到);
 * - 「现在到哪」那一句里的数字得在核过的摘录或标题里出现过,不然这一句不用,退回摘录本身;
 * - 下一步同样要核摘录;标题最多 16 个字。
 */
/**
 * 这一句摘录说的是不是这件事:直连的证据(挂在这张卡上的会话、它自己交回来的话)算;否则要**实打实说到这张卡的主语**:
 *
 * - 标题分成几截的(「额度显示 / 会话读取」),按每一截比,整个标题不算一截(整个标题里的字太多,沾一个就过,等于没比);
 * - 一截里算数的字不超过四个(「部署上线」「注册域名」「额度显示」;「参赛视频」去掉冲刺名只剩「视频」时整个标题原样)→ 要这一截差不多原样出现
 *   ({@link subjectVerbatim});
 * - 更长的一截 → 摘录里要有它至少两个不同的两字词。
 *
 * 真看板副本上撞到过的几种,都是只沾了一个词:「部署上线」被「能直接部署到 GitHub Pages」(那件活的要求)撑成「还没做,只定了要部署上线」;
 * 「额度显示 / 会话读取」被卡 O 交接里「还剩多少额度」撑成「设计出来了」;「打磨自媒体布局」被「引导里先问布局」撑成进展;
 * 模型拿一句真实但不相干的话(「改了 14 个文件,还没提交」)给一张卡当依据。宁可「还没看到进展,要你说一句」,不拿沾边的话充数。
 */
export function relatedQuote(quote: string, card: EvalCard, strong: boolean): boolean {
  if (strong) return true
  const said = normalizeText(quote)
  const all = titleParts(card.title)
  const parts = all.length > 1 ? all.slice(1) : all
  for (const part of parts) {
    const subject = cardSubject(part, card.context)
    if (subject.weight.filter(Boolean).length <= 4) {
      if (subjectVerbatim({ title: part, context: card.context }, quote)) return true
      continue
    }
    const chars = [...subject.text]
    const hits = new Set<string>()
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const bigram = `${chars[i]}${chars[i + 1]}`
      if (subject.weight[i] === true && subject.weight[i + 1] === true && said.includes(bigram)) hits.add(bigram)
    }
    if (hits.size >= 2) return true
  }
  return false
}

export function verifyJudgement(
  raw: RawJudgement,
  card: EvalCard,
  evidenceByKey: ReadonlyMap<string, EvidenceItem>,
  /** 直连这张卡的证据 id(挂在卡上的会话、它自己交回来的话、点名的会话)。 */
  strongIds: ReadonlySet<string> = new Set(),
  /** 同一轮核的别的卡(认「这一句说的其实是另一张卡的事」)。 */
  others: readonly EvalCard[] = [],
): Judgement {
  const basis: { ev: EvidenceItem, quote: string }[] = []
  for (const one of raw.basis) {
    const ev = evidenceByKey.get(one.e)
    if (ev === undefined) continue
    if (!quoteFound(one.quote, `${ev.title ?? ''}\n${ev.text}`)) continue
    if (!relatedQuote(one.quote, card, strongIds.has(ev.id))) continue
    if (basis.some(b => b.ev.id === ev.id && quoteKey(b.quote) === quoteKey(one.quote))) continue
    basis.push({ ev, quote: clip(one.quote.trim(), 80) })
  }
  const next: ProposedStep[] = []
  for (const one of raw.next) {
    const ev = evidenceByKey.get(one.e)
    if (ev === undefined || !quoteFound(one.quote, `${ev.title ?? ''}\n${ev.text}`)) continue
    const title = clip(plainText(one.title).replace(/[。.!\uFF01]+$/, ''), 16)
    if ([...title].length < 2) continue
    const owner = ownerOf(one.owner)
    next.push({ title, ...(owner === undefined ? {} : { owner }), quote: clip(one.quote.trim(), 80), ev, fromTask: card.id })
  }
  if (basis.length === 0) {
    return { taskId: card.id, state: 'none', line: PROGRESS_NONE_LINE, basis: [], next, by: 'model' }
  }
  const quotes = basis.map(b => b.quote)
  const said = raw.now === undefined ? '' : clip(plainText(raw.now), 60)
  // 说的是另一张卡的进展(没有一条直连这张卡的依据撑着时):不算,当没找到。
  if (said !== '' && !basis.some(b => strongIds.has(b.ev.id)) && saysAnotherCard(said, card, others)) {
    return { taskId: card.id, state: 'none', line: PROGRESS_NONE_LINE, basis: [], next: [], by: 'model' }
  }
  // 出处上的版本号、日子(「更新说明 0.2.85」)也是交给它的证据,可以说。
  const backing = [...quotes, card.title, ...basis.flatMap(b => [b.ev.source, b.ev.title ?? ''])]
  // 卡上的字是对他说的:「在等他审」→「在等你审」。
  // 数字要有依据撑着;「并没并进正式版」也要({@link mergeClaimsBacked})。
  const claimed = said === '' ? '' : mergeClaimsBacked(said, basis.map(b => b.ev))
  let line = (claimed !== '' && numbersBacked(claimed, backing) ? claimed : clip(quotes[0] as string, 60)).replace(/等他/g, '等你')
  const waiting = raw.waiting_on === undefined ? undefined : WAITING_ON[raw.waiting_on.trim().toLowerCase()] ?? WAITING_ON[raw.waiting_on.trim()]
  /*
   * 在等他做什么(「逐屏文案稿在等你审」):模型单给一格,**也要有逐字摘录撑着**;核得上、而「现在到哪」那一句里还没说,
   * 就接在后面 —— 维护者最要紧的那一句是「现在球在我这儿、要我干什么」,不能被别的进展盖掉。
   */
  const wait = raw.waiting_for
  // 直连这张卡的会话里认出「球在他那儿」(pendingForHim):那一句**一定**要说,依据是那家交东西的那一句。
  for (const ev of [...evidenceByKey.values()].filter(one => strongIds.has(one.id) && one.pending !== undefined)) {
    const pending = ev.pending as { what: string, quote: string }
    // 那一句已经说了在等他(「…在等你审」「等你看」)就不再接一遍,只把依据补上。
    if (!/等(?:你|他)/.test(line) && !quoteKey(line).includes(quoteKey(pending.what.replace(/在等你审$/, '')))) {
      line = `${line.replace(/[。.]$/, '')};${pending.what}`
    }
    if (!basis.some(b => b.ev.id === ev.id)) basis.push({ ev, quote: pending.quote })
  }
  if (waiting === 'me' && wait !== undefined) {
    const ev = evidenceByKey.get(wait.e)
    const what = clip(plainText(wait.what).replace(/^(?:在)?等(?:你|他)/, '').replace(/[。.]$/, ''), 20)
    if (ev !== undefined && quoteFound(wait.quote, `${ev.title ?? ''}\n${ev.text}`) && [...what].length >= 2 && !/等(?:你|他)/.test(line) && !quoteKey(line).includes(quoteKey(what))) {
      line = `${line.replace(/[。.]$/, '')};${what}在等你`
      if (!basis.some(b => b.ev.id === ev.id && quoteKey(b.quote) === quoteKey(wait.quote))) basis.push({ ev, quote: clip(wait.quote.trim(), 80) })
    }
  }
  const mismatch = raw.mismatch === undefined ? undefined : clip(plainText(raw.mismatch), 80)
  const pendingSeen = [...evidenceByKey.values()].some(one => strongIds.has(one.id) && one.pending !== undefined)
  return {
    taskId: card.id,
    state: mismatch === undefined ? 'found' : 'mismatch',
    line,
    basis,
    ...(pendingSeen ? { waiting_on: 'me' as const } : waiting === undefined ? {} : { waiting_on: waiting }),
    ...(mismatch === undefined ? {} : { mismatch }),
    next,
    by: 'model',
  }
}

/** 时刻 → 「09-24 20:17」(本地时区)。 */
export function shortAt(iso: string | undefined): string {
  // 给人看、会存下来的那几句用(「9月24日 20:17」;只有日子的只写「9月25日」,不补一个编出来的钟点)。真身在 protocol.ts。
  return shortMoment(iso)
}

/**
 * 问模型那两段话里的时刻:「09-24 20:17」/ 只有日子的「09-25」(本地时区)。和开头「现在是 2026-09-25 15:10」同一种写法,
 * 模型比新旧不用换算;这一种不给人看(给人看的用 {@link shortAt})。
 */
export function promptAt(iso: string | undefined): string {
  if (iso === undefined) return ''
  const day = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso)
  if (day !== null) return `${day[1]}-${day[2]}`
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 出处的短说法(规则拼的那一句用,卡面地方小):去掉书名号里那一截 ——「Codex 里那段对话」「更新说明 0.2.87」「Codex 交回来的话」。 */
export function briefSource(source: string): string {
  return source.replace(/「[^」]*」/g, '').replace(/\s{2,}/g, ' ').trim() || source
}

export interface JudgePrompt {
  system: string
  user: string
  /** 提示词里的证据编号(E1、E2…)→ 证据。 */
  keys: Map<string, EvidenceItem>
}

/**
 * 问模型的那两段话。**只给挑出来的证据**(每条已截短),卡上写的(口述)一并给,并说清只当起点。
 * 回一个 JSON:每张卡 found / now / waiting_on / basis[{e, quote}] / next[{title, owner, e, quote}] / mismatch。
 */
export function buildJudgePrompt(input: {
  now: Date
  cards: readonly EvalCard[]
  candidates: ReadonlyMap<string, readonly Candidate[]>
  /** 这几天的总账(最新几版发版记录、最新的交接与验收、最近的提交):每张卡都能引,用来判「新的说法推翻了旧的」。 */
  recent?: readonly EvidenceItem[]
}): JudgePrompt {
  const keys = new Map<string, EvidenceItem>()
  const keyOf = new Map<string, string>()
  const line = (key: string, ev: EvidenceItem): string => {
    const when = promptAt(ev.at)
    // 「球在他那儿」那一句是我们从会话结构认出来的,另起一行给模型看,**不算原文**(摘录只能从原文里摘)。
    const pending = ev.pending === undefined ? '' : `\n↳ 工作台看出来:最后一来一回是他要了东西自己先看、那家交了、之后他没回话(${ev.pending.what})`
    return `${key} [${ev.source}${when === '' ? '' : ` · ${when}`}]${ev.title !== undefined && !ev.source.includes(ev.title) ? ` 标题「${clip(ev.title, 40)}」` : ''}\n${ev.text}${pending}`
  }
  const recentLines: string[] = []
  for (const ev of input.recent ?? []) {
    if (keyOf.has(ev.id)) continue
    const key = `E${keyOf.size + 1}`
    keyOf.set(ev.id, key)
    keys.set(key, ev)
    recentLines.push(line(key, ev))
  }
  const evidenceLines: string[] = []
  for (const card of input.cards) {
    for (const candidate of input.candidates.get(card.id) ?? []) {
      if (keyOf.has(candidate.ev.id)) continue
      const key = `E${keyOf.size + 1}`
      keyOf.set(candidate.ev.id, key)
      keys.set(key, candidate.ev)
      evidenceLines.push(line(key, candidate.ev))
    }
  }
  const cardLines = input.cards.map((card, index) => {
    const who = card.assignee === undefined ? '没写' : `${ASSIGNEE_NAMES[card.assignee]}${card.assignee_note === undefined ? '' : `(${card.assignee_note})`}`
    // 做到哪了的证据在前(新的在前),设计与决策(打算 / 定了什么)排在后面、标出来 —— 模型爱挑最新的那条,而最新的常常是一份还没做的设计。
    const isPlan = (ev: EvidenceItem): boolean => ev.kind === 'decision' || (ev.kind === 'handoff' && ev.doc === 'design')
    const refs = [...(input.candidates.get(card.id) ?? [])]
      .sort((a, b) => Number(isPlan(a.ev)) - Number(isPlan(b.ev)) || (b.ev.at ?? '').localeCompare(a.ev.at ?? ''))
      .map((c) => {
        const key = keyOf.get(c.ev.id)
        const when = promptAt(c.ev.at)
        const note = [when, isPlan(c.ev) ? (c.ev.kind === 'decision' ? '决策' : '设计') : ''].filter(Boolean).join(',')
        return key === undefined ? '' : `${key}${note === '' ? '' : `(${note})`}`
      })
      .filter(Boolean).join('、')
    const said = card.desc === undefined ? '' : `;卡上写的(口述,只当起点):${clip(plainText(card.desc), 160)}`
    return `T${index + 1} 「${card.title}」(负责:${who};卡在「${STATUS_WORDS[card.status]}」${card.due === undefined ? '' : `;截止 ${card.due}`}${said})—— 可看的证据(做到哪了的在前、新的在前;设计 / 决策在后):${refs === '' ? '无' : refs}`
  })
  const today = `${input.now.getFullYear()}-${String(input.now.getMonth() + 1).padStart(2, '0')}-${String(input.now.getDate()).padStart(2, '0')} ${String(input.now.getHours()).padStart(2, '0')}:${String(input.now.getMinutes()).padStart(2, '0')}`
  /*
   * 先后顺序为了模型那头的前缀缓存:规矩(每一轮都一样)全在 system;user 开头是「现在几点 + 总账」(同一轮的每一批都一样),
   * 这一批的卡与证据放最后。一轮十几张卡分三批,后两批的前一大半都吃缓存。
   */
  const user = [
    `现在是 ${today}。`,
    '',
    ...(recentLines.length === 0 ? [] : ['【这几天的总账】(新的在前;每件事都能引;用来判新的说法有没有推翻旧的)', ...recentLines, '']),
    '【要核的事】',
    ...cardLines,
    '',
    '【证据】(E 编号后面方括号里是出处与时刻;总账里的也算证据)',
    ...evidenceLines,
    '',
    '按规矩回 JSON。',
  ].join('\n')
  return { system: JUDGE_SYSTEM, user, keys }
}

/** 问模型的规矩(每一轮一字不变,好吃前缀缓存)。 */
export const JUDGE_SYSTEM = [
  '你是进度核对员:只根据给你的证据判断看板上每件事现在到哪了。不许编,每一句判断都附逐字摘录;新的证据推翻旧的;证据里没有的就说没找到。',
  '',
  '规矩:',
  '1. 只按证据说,不编。「现在到哪」一句话,不超过 30 个字,**写给不懂技术、第一次用的人看**,一眼能懂(「11 屏已做完,逐屏文案稿在等你审」):不出现文件名、路径、提交号、分支名、英文缩写与键名;不说「发版、合并、分支、提交、仓库」这类开发的词(说「更新上线了」「还没并进正式版」「改好了」)。只写证据里**直接写着的这件事**的状态:不推因果、不补依赖(「等 X」只有证据明写在等 X 才能写),别的事的进展不算这件事的进展。卡的标题只是个名字:证据说的就是这件事(同一个网页、同一个功能)就算,不必字字对上。',
  '2. 同一件事新旧说法对不上,以时刻新的为准:先看最新的那条证据(看方括号里的时刻,也看总账)。旧的工作记录说「真系统装的还是旧版」,后来的验收记录说「真系统上派通了」→ 按派通了说,旧那句不许再写进「现在到哪」。出处里标着「还没并进正式版」的是还没合的活:可以说「做了…,还没并进正式版」,不能说成已经上线、已经在用。',
  '3. 「项目里记下的决定」「设计稿」说的是「定了什么 / 打算怎么做」,不是做到哪了:做到哪了按「更新说明」「工作记录」「验收记录」、各家的对话、交回来的话说(哪怕它们比设计稿早 —— 设计里要做的事还没做)。设计稿里写的「现在撞到的问题」可以当现状引;只有决定 / 设计稿说到这件事时,写「定了…」「设计出来了,还没做」。',
  '4. 球在他那边的,「现在到哪」里要点明在等他做什么:会话最后是他要了一份东西(文档、稿子、截图)说自己先看,那家已经交了、之后没有他的回话 → 写「<那份东西>在等你审」;等他点头、等他给材料同理。',
  '5. 每一句判断都要附依据:basis 里写证据编号 e 和一段**逐字**从那条证据里抄的原文 quote(10 到 60 个字,一个字不改,不要省略号),而且 quote 里得有说这件事的字。抄不出来就算没找到。',
  '6. 证据没直接说到这件事,就当没找到:found=false、basis 空、now 空。同一个词用在别的事上不算 —— 这件是「做安装包」而证据只提到「能直接部署到某某平台」的要求;这件是「给新电脑装好某套布局」而证据说的是「引导里先问布局」—— 都是没找到。',
  '7. waiting_on:现在球在谁那儿 —— me(等他:审、点头、给材料)/ agent(某家 AI 还在做)/ others(等同事或别人)/ nobody(做完了没人在等)。waiting_on 是 me 时,wait_what 写在等他做的那件事(不超过 12 个字,如「审逐屏文案稿」),wait_e / wait_quote 是撑着它的证据编号与逐字摘录;不是 me 就三格都写空串。',
  '8. next:证据里明说还差、还要做、下一步的事(「还差文案定稿、真实界面素材和下载地址」),而且更新的证据没说已经做了;一件一条,title 不超过 16 个字,owner 写 me / claude / codex / kimi / colleague / other / unknown,也要附 e 与逐字 quote。没有就空。',
  '9. mismatch:只有卡上写的**状态**和证据**相反**才写一句(同样写给第一次用的人看,不说「证据」,说「我看到的」)—— 「卡上还在待办,可我看到已经做完、上线了」;「卡上说做完了,可我看到还差…」。证据没提到卡上写的某些话、或者只说到一部分,不算对不上,写空串。',
  '',
  '只回这一个 JSON 对象,不要别的字、不要代码块:',
  '{"items":[{"id":"T1","found":true,"now":"","waiting_on":"me","wait_what":"","wait_e":"E1","wait_quote":"","basis":[{"e":"E1","quote":""}],"next":[{"title":"","owner":"me","e":"E1","quote":""}],"mismatch":""}]}',
].join('\n')

const STATUS_WORDS: Readonly<Record<TaskView['status'], string>> = {
  backlog: '待排', todo: '待办', doing: '进行中', confirm: '等我确认', done: '完成', blocked: '阻塞', canceled: '取消',
}

/** 模型回的 JSON 里的 T 编号 → 卡 id。 */
export function judgementsFromModel(
  reply: unknown,
  cards: readonly EvalCard[],
  keys: ReadonlyMap<string, EvidenceItem>,
  candidates?: ReadonlyMap<string, readonly Candidate[]>,
  /** 这一轮核的全部卡(不只这一批):认「说的是另一张卡的事」用。缺席 = 只看这一批。 */
  allCards: readonly EvalCard[] = cards,
): Map<string, Judgement> | undefined {
  const parsed = parseJudgeReply(reply)
  if (parsed === undefined) return undefined
  const out = new Map<string, Judgement>()
  for (const raw of parsed) {
    const index = Number(/^T(\d+)$/.exec(raw.id.trim())?.[1] ?? Number.NaN) - 1
    const card = Number.isInteger(index) ? cards[index] : cards.find(one => one.id === raw.id)
    if (card === undefined || out.has(card.id)) continue
    // 说找到了、却一条依据都没给(多半是那一件写坏了、依据被切到外面去了):当这一件没答,退回规则那一套。
    if (raw.found && raw.basis.length === 0) continue
    const strong = new Set((candidates?.get(card.id) ?? []).filter(one => one.strong).map(one => one.ev.id))
    out.set(card.id, verifyJudgement(raw, card, keys, strong, allCards.filter(one => one.id !== card.id)))
  }
  return out
}

// ———————————————————————————— 规则那一套(没接模型 / 到了上限 / 模型没回) ————————————————————————————

/** 一段话里第一句(到句号 / 换行为止)。 */
export function firstSentence(text: string, max = 60): string {
  const body = text.replace(/^[^「]*「/, '').replace(/」[\s\S]*$/, '')
  const match = /^[\s\S]*?[。!?\n\uFF01\uFF1F]/.exec(body)
  return clip((match === null ? body : match[0]).replace(/[。\n]$/, '').trim(), max)
}

/**
 * 界面上的字、改动清单那几行(「Show more」「Edited 7 files+199」「-31 Undo docs/….md+12」「Show 4 more files」)
 * 不是回答 —— 读窗口那只手偶尔会把它们一并读回来。拿来当依据之前剥掉。
 */
export function isNoiseLine(line: string): boolean {
  const text = line.trim()
  if (text === '') return true
  if (/^(?:Show more|Show less|Show \d+ more files?|Edited \d+ files?|Undo|Copy|Copied|Retry|Thinking|Working for \d+s)/i.test(text)) return true
  if (/^[+-]\d+(?:\s|$)/.test(text)) return true
  // 一行里主要是文件路径 + 改动行数(「docs/计划-xx.md+12」「site/tests/a.test.mjs+52」)。
  if (/[\w一-鿿./-]+\.(?:md|ts|tsx|js|mjs|json|css|html|swift)[+-]\d+/.test(text)) return true
  return false
}

/** 一段话切成句子(句号、问号、叹号、分号、换行)。 */
export function sentencesOf(text: string): string[] {
  return text.split(/[。!?;\n\uFF01\uFF1F\uFF1B]+/)
    .map(one => one.replace(/^[^「]*「|」$/g, '').trim())
    .filter(one => [...one].length >= 4 && !isNoiseLine(one))
}

/** 证据正文里「X 答:「…」」那几段(那家说的);没有这种段落的(文档、发版记录)整段算。 */
export function answerParts(text: string): string {
  const parts = [...text.matchAll(/答:「([\s\S]*?)」(?=\n他说:|\n[^\n]*答:|$)/g)].map(match => match[1] as string)
  return parts.length === 0 ? text : parts.join('\n')
}

/**
 * 那一段里**说的就是这件事**的那一句:按卡的主语覆盖得最多的一句(一样多取靠后的 —— 越往后越接近「现在」);
 * 一句都沾不上时退回那家最后一句回答的第一句。
 */
export function bestSentence(card: EvalCard, text: string, max = 60): string {
  let best: { sentence: string, score: number } | undefined
  // 只从那家说的话里挑(他的问题不是进度);带文件路径的那种清单行不挑。
  for (const sentence of sentencesOf(answerParts(text)).filter(one => !/\/[\w\u4e00-\u9fff.-]+\.(?:md|ts|tsx|js|mjs|json)\b/.test(one))) {
    let score = 0
    for (const part of titleParts(card.title)) score = Math.max(score, coverage(cardSubject(part, card.context), sentence))
    if (score > 0 && (best === undefined || score >= best.score)) best = { sentence, score }
  }
  if (best !== undefined) return clip(best.sentence, max)
  const agentAnswer = /答:「([^」]*)」?\s*$/.exec(text)?.[1]
  return firstSentence(agentAnswer ?? text, max)
}

/** 规则判「在等谁」:卡在等我确认 → 他;会话最后一句是那家说的且在请他看 / 审 / 确认 → 他。其余说不准。 */
function rulesWaiting(card: EvalCard, top: Candidate | undefined): TaskProgressView['waiting_on'] | undefined {
  if (card.status === 'confirm') return 'me'
  // 「在等你」全仓只有一份判据(卡 T 的 `judgeWaiting`;合并卡 W 09-25 照 .worktrees/留言-卡N-卡T.md 的约定换)。
  // 原来那条正则会把「我给你整理好了」「你看,这里…」「再到『等你确认』里点 B」都认成等他;那一份只认离末尾近的、不在引号里的。
  if (top?.ev.lastBy === 'agent' && judgeWaiting({ turns: [{ k: 'reply', text: top.ev.text, final: true }] }).waiting) return 'me'
  if (top?.ev.lastBy === 'him') return 'agent'
  return undefined
}

/**
 * 规则那一套:**只拿原话当依据、只摘不写**。
 * - 有直连的证据(派出去交回来的话、挂在卡上的会话)→ 「<出处> <时刻>:<那一句的第一句>」;
 * - 只有字面覆盖够高(≥ 0.8)的 → 同上;
 * - 都没有 → 「还没看到进展,要你说一句」。
 * 规则不出「下一步」(那要读懂句子,交给模型)。
 */
/**
 * 这张卡的主语差不多原样出现在这段话里(连着出现八成以上;「部署」「上线」分在两处不算)。
 * 去掉项目 / 冲刺名之后只剩两个字的主语(「参赛视频」→「视频」)太短,到处都有 —— 这时要整个标题原样出现才算。
 */
export function subjectVerbatim(card: Pick<EvalCard, 'title' | 'context'>, text: string): boolean {
  return titleParts(card.title).some((part) => {
    const subject = cardSubject(part, card.context)
    const strict = subject.weight.filter(Boolean).length >= 3
      ? subject
      : { text: subject.text, weight: [...subject.text].map(ch => isWordChar(ch) && !/[0-9]/.test(ch)) }
    return contiguity(strict, text) >= 0.8
  })
}

/**
 * 模型写的「现在到哪」其实说的是**另一张卡**的事(真看板副本上撞到过:「参赛视频」那张写成了「网页架构收尾已交,还差文案定稿与素材」)。
 * 判法:这一句里一个字都没沾这张卡的主语,却几乎原样说着另一张卡的主语。
 */
export function saysAnotherCard(line: string, card: Pick<EvalCard, 'id' | 'title' | 'context'>, others: readonly Pick<EvalCard, 'id' | 'title' | 'context'>[]): boolean {
  if (titleParts(card.title).some(part => coverage(cardSubject(part, card.context), line) > 0)) return false
  return others.some(other => other.id !== card.id && titleParts(other.title).some((part) => {
    const subject = cardSubject(part, other.context)
    return subject.weight.filter(Boolean).length >= 3 && contiguity(subject, line) >= 0.6
  }))
}

export function rulesJudge(card: EvalCard, candidates: readonly Candidate[]): Judgement {
  // 规则自己下结论只认两种:直连的,或者整个主语差不多原样出现在那条证据里(见 subjectVerbatim)。
  const verbatim = (one: Candidate): boolean => subjectVerbatim(card, `${one.ev.title ?? ''}\n${one.ev.text}`)
  const top = candidates.find(one => one.strong) ?? candidates.find(one => one.score >= 0.8 && verbatim(one))
  if (top === undefined) return { taskId: card.id, state: 'none', line: PROGRESS_NONE_LINE, basis: [], next: [], by: 'rules' }
  // 文档那几类:标题就是它说的那件事(「手机远程派活 —— 六家都能派、都能把结果收回来」);发版记录取那一行的第一截。
  const docTitle = top.ev.kind === 'handoff' && top.ev.title !== undefined
    ? peopleText(top.ev.title.replace(/^(?:交接|设计|验收报告)\s*(?:\d{4}-\d{2}-\d{2}|\d{4})?[::\uFF1A\s·]*/, '')).trim()
    : undefined
  const quote = docTitle !== undefined && docTitle !== ''
    ? clip(docTitle, 60)
    : top.ev.kind === 'release' ? firstSentence(top.ev.text.replace(/^①\s*/, ''), 60) : bestSentence(card, top.ev.text, 60)
  const waiting = rulesWaiting(card, top)
  // 直连的会话里认出「球在他那儿」:规则那一套也要说出来(那一句是确定的,不用模型)。出处与时刻在依据里,这一句不重复。
  const pending = candidates.find(one => one.strong && one.ev.pending !== undefined)?.ev
  if (pending?.pending !== undefined) {
    return {
      taskId: card.id,
      state: 'found',
      line: clip(pending.pending.what, 70),
      basis: [{ ev: pending, quote: pending.pending.quote }, ...(pending.id === top.ev.id ? [] : [{ ev: top.ev, quote }])],
      waiting_on: 'me',
      next: [],
      by: 'rules',
    }
  }
  return {
    taskId: card.id,
    state: 'found',
    // 规则拼的:哪儿说的(短说法)+ 原话(截在书名号里面,右括号不丢)。时刻在依据里(卡上悬停、打开卡都看得到)。
    line: `${briefSource(top.ev.source)}:「${clip(quote, Math.max(12, 66 - [...briefSource(top.ev.source)].length))}」`,
    basis: [{ ev: top.ev, quote }],
    ...(waiting === undefined ? {} : { waiting_on: waiting }),
    next: [],
    by: 'rules',
  }
}

// ———————————————————————————— 落到卡上 ————————————————————————————

/**
 * 一张卡的判断 → 挂在卡上的那一格(`TaskView.progress`)。**这里出去的每个字都是给人看的**:过一遍 {@link peopleText}
 *(不出现文件名、路径、提交号、分支名;摘录见 {@link shownQuote}:夹着这些的整句不给看,只给出处)。判的时候核的是原文,核完才到这一步。
 */
export function progressView(judgement: Judgement, checkedAt: string, previous?: Pick<TaskProgressView, 'line' | 'state'>): TaskProgressView {
  const line = judgement.state === 'none' ? judgement.line : (peopleText(judgement.line) || PROGRESS_NONE_LINE)
  const state = judgement.state !== 'none' && line === PROGRESS_NONE_LINE ? 'none' : judgement.state
  const changed = previous === undefined ? true : previous.line !== line || previous.state !== state
  const mismatch = judgement.mismatch === undefined ? '' : peopleText(judgement.mismatch)
  return {
    line,
    state,
    basis: state === 'none' ? [] : judgement.basis.map(({ ev, quote }) => {
      const shown = shownQuote(quote)
      return {
        kind: ev.kind,
        source: peopleText(ev.source) || ev.source,
        ...(ev.ref === undefined ? {} : { ref: ev.ref }),
        ...(ev.at === undefined ? {} : { at: ev.at }),
        ...(shown === '' ? {} : { quote: shown }),
      }
    }),
    checked_at: checkedAt,
    ...(judgement.waiting_on === undefined ? {} : { waiting_on: judgement.waiting_on }),
    ...(mismatch === '' || state !== 'mismatch' ? {} : { mismatch }),
    by: judgement.by,
    changed,
  }
}

// ———————————————————————————— 证据里冒出来的下一步 ————————————————————————————

/**
 * 两个标题说的是不是同一件事(字面覆盖任一方向 ≥ 0.6)。`context` 是它们所在的项目 / 冲刺 / 模块叫什么 ——
 * 「参赛文案」去掉「参赛」剩「文案」,和「文案定稿」就是一件事;不去掉,两边都只覆盖一半。
 */
export function sameThing(a: string, b: string, context: readonly string[] = []): boolean {
  const left = coverage(cardSubject(a, context), b)
  const right = coverage(cardSubject(b, context), a)
  return Math.max(left, right) >= 0.6
}

/**
 * 下一步 → 要建的卡。看板上已经有同一件(在办或办完的都算)、以前提过(他点过头或说不要)的一律不再提;
 * 同一轮里重复的并成一条。一轮最多 `max` 条(别一次往他盘上倒一堆)。
 */
export function proposalsFrom(
  steps: readonly ProposedStep[],
  board: readonly Pick<TaskView, 'title'>[],
  proposedBefore: readonly string[],
  max = 3,
  /** 项目 / 冲刺 / 模块叫什么(比同一件事时不算数的字)。 */
  context: readonly string[] = [],
): ProposedStep[] {
  const out: ProposedStep[] = []
  for (const step of steps) {
    // 取消掉的也算「已经有了」:他取消过的事不该换个说法又冒出来。
    if (board.some(task => sameThing(task.title, step.title, context))) continue
    if (proposedBefore.some(title => sameThing(title, step.title, context))) continue
    if (out.some(one => sameThing(one.title, step.title, context))) continue
    out.push(step)
    if (out.length >= max) break
  }
  return out
}
