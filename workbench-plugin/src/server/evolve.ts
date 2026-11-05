/**
 * 进化循环骨架(2026-09-22,卡 ⑥;docs/设计-运营事务官指挥做事-2026-09-22.md §五)。
 *
 * Ben 的原话:「变成一个能够持续进化的工作系统,结合我们开发一个小工具、小组件这样的能力,
 * 能够一些东西固化下来,通过事务官的自编程能力,逐步进化。」
 *
 * 这个文件是那条线的**最小版**,五步,每一步都能单独指出来:
 *
 *   ① **发现重复**  近 14 天她对事务官说过的话里,同一类请求出现 ≥3 次 → 一条候选
 *   ② **提议固化**  每天一次(挂在下班例程之后),候选进收件箱:「要不要把 X 固化成…」
 *   ③ **她点头**    三颗键:做 / 不要(以后不再提这一条)/ 以后再说
 *   ④ **走现有三条路** 技能 → `docs/技能/固化-<名>.md` + 写进 AGENTS.md 的标记段;
 *                     小组件 → 现有「开发一个小工具」链路(devTool.ts),**带描述预填,不自动发**;
 *                     模板固定一步 → 这一版只记进日志标「待做」
 *   ⑤ **留痕可撤**  `<工作目录>/进化日志.md` 一次一条(哪天、为什么、做成了什么、怎么撤)
 *
 * ## 三条硬边界
 *
 * 1. **不改工作台本体代码**。这一版"自编程"的上限就是两样:一份技能文档、一条走既有
 *    造模块链路的小组件请求。设计文档里钉死的那一句:「真正的『自己改自己』以固化技能与
 *    小组件为限,**不许改工作台本体代码**」。这个模块里没有任何一条写 `src/` 的路。
 * 2. **不接模型**。归一化与关键词重合都是死算法(见下面的阈值那一节),阈值写在常量里、
 *    可推翻。卡里明确写着「不要接模型」—— 一个会自己提议改自己的东西,判据必须是
 *    人读得懂、能一条条数出来的。
 * 3. **纯函数 + 一个落盘的仓**,跟 devTool.ts 同一套分法:`findRepeats`/`normalizeSay`/
 *    `keywordsOf` 一行 I/O 都没有,`createEvolveStore` 只管 `evolve.json` 那一份。
 *
 * ## 阈值(全部可推翻,改这里一处)
 *
 * | 常量 | 值 | 为什么是这个数 |
 * |---|---|---|
 * | `WINDOW_DAYS` | 14 | 卡里给的窗口。再长就会把两个月前那阵子的习惯翻出来当"最近在重复" |
 * | `REPEAT_MIN` | 3 | 设计文档 §五 1 的原话「同一类请求出现三次」。两次是巧合 |
 * | `OVERLAP_MIN` | 0.5 | 两句话的关键词**重合过半**才算同一类。低了会把"整理选题"和"整理素材"并成一类 |
 * | `MIN_KEYWORDS` | 2 | 只剩一个关键词的句子(「发一下」)不参与聚类——它跟谁都像 |
 *
 * 阈值不对不是 bug,是判断:`docs/决策记录.md` 的「技术选择(可推翻)」里记了这四个数。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEV_TOOL_DRAFT,
  type EvolveNoticeView, type EvolvePreferenceStatus, type EvolvePreferenceView, type EvolveProposalView, type EvolveWay,
} from '../protocol.ts'

// ───────────────────────────── 阈值 ─────────────────────────────

/** 往回看几天。 */
export const WINDOW_DAYS = 14
/** 同一类说过几次才算"在重复"。 */
export const REPEAT_MIN = 3
/** 两句话算同一类的关键词重合下限(overlap coefficient,0–1)。 */
export const OVERLAP_MIN = 0.5
/** 关键词少于这个数的句子不参与聚类。 */
export const MIN_KEYWORDS = 2
/** 同时挂着的提议上限。攒一屏没人点的提议 = 一条都没在办(同 devTool.ts 的 MAX_PENDING)。 */
export const MAX_PENDING = 3

/*
 * ## 2026-09-23 之后:偏好那一截(docs/设计-事务官自进化闭环-2026-09-23.md 第三节)
 *
 * 上面五步缺的是 Ben 点名的后半截:**调整之后「验证效果 → 保留或回滚」**,以及
 * 「一次临时要求 ≠ 长期偏好」的分辨。这一截落在一条真实流程上 —— 选题卡「做一篇内容」:
 *
 *   ⑥ **沉淀有依据的偏好**  她在 ≥ `PREF_MIN_TOPICS` 条**不同**选题上打回过同一处
 *                           (`审核记录.jsonl` 里 `action:'revise'` 的原话按关键词重合聚类)
 *                           → 记成一条偏好,状态「试用」。一条选题上说一次 = 这一篇的临时要求,
 *                           **只留在这条选题的把关记录里**,不进偏好。
 *   ⑦ **调整**              推进的话里多一段「她说过不止一次的偏好」(`topicRun.ts`),
 *                           `账号.md` 画像段里多一行(`accounts.ts`)—— 她不必再交代一遍。
 *   ⑧ **验证**              记下之后**下一次**推进(任何选题),她对那份产物「通过」且没再打回
 *                           同一处 → 保留;又打回了同一处 → 没见效 → **自动撤**。
 *   ⑨ **留痕可撤**          进化日志一条(way:'preference'),验证结论补一行;`/evolve/revert`
 *                           也能手撤。收件箱里至多 `NOTICE_MAX` 条提示,过期自己消失。
 *
 * 阈值同样可推翻,理由在下面那张表旁边。**仍然不接模型**:聚类用的是上面同一套二元组重合。
 */

/** 往回看几天的把关记录。一条选题要做好几天,14 天装不下两条选题的把关,所以比 WINDOW_DAYS 长。 */
export const PREF_WINDOW_DAYS = 30
/**
 * 同一句打回意见要在几条**不同**选题上出现过才算偏好。1 = 把临时要求当偏好(Ben 明令不许);
 * 3 = 要她讲三遍才学会(总纲里那句「她发现自己在讲第三遍同一件事,那是我没做到」)。取 2。
 */
export const PREF_MIN_TOPICS = 2
/** 推进的话里最多带几条偏好。再多事务官读不过来,她也记不住自己说过哪几条。 */
export const PREF_MAX_LINES = 6
/** 收件箱里同时最多几条提示(统筹给的数:「至多收件箱两条提示」)。 */
export const NOTICE_MAX = 2
/** 一条提示挂几天自己消失。它没有按钮 —— 要撤走 `/evolve/revert`。 */
export const NOTICE_TTL_DAYS = 3

/**
 * 归一化时丢掉的那些字。
 *
 * **只丢"哪句话里都有"的功能词**,不丢任何名词 —— 名词正是"这是哪一类活"的全部信息。
 * 这一份短得有点过分是故意的:宁可少丢几个词让两句话显得不那么像(漏报一条提议),
 * 也不要多丢几个词把两件不同的事并成一类(报一条她看不懂的提议)。
 */
const STOP_WORDS = new Set([
  '的', '了', '着', '过', '吗', '呢', '吧', '啊', '呀', '是', '在', '和', '与', '跟', '给',
  '把', '被', '我', '你', '他', '她', '它', '们', '这', '那', '一下', '一个', '一遍', '帮',
  '请', '麻烦', '要', '想', '就', '都', '也', '还', '再', '很', '太', '有', '没', '不',
  '今天', '明天', '昨天', '现在', '然后', '以及', '一些', '什么', '怎么', '可以', '能不能',
])

// ───────────────────────────── 纯函数:归一化与关键词 ─────────────────────────────

/**
 * 一句话 → 归一化文本。
 *
 * 四件事,都不改意思:
 * ① 「开发一个小工具」那句预填的开头切掉 —— 它是按钮塞进去的,不是她说的话;
 * ② 只取第一行(卡的标题就是第一行,后面是补充);
 * ③ 全角/半角标点、空白一律换成一个空格;
 * ④ 英文小写。
 *
 * **中文不分词、不转拼音**:分词要么带一个词典(几百 K)要么靠模型,两样卡里都排掉了。
 * 关键词由 `keywordsOf` 用二元组(bigram)切,见那个函数的注释。
 */
export function normalizeSay(raw: string): string {
  let text = raw.trim()
  if (text.startsWith(DEV_TOOL_DRAFT)) text = text.slice(DEV_TOOL_DRAFT.length)
  text = (text.split('\n')[0] ?? '').trim()
  // 标点、空白 → 空格。范围里写的是 ASCII 标点 + 中文全角标点 + 各种空白。
  text = text.replace(/[\s!-/:-@[-`{-~、-〿！-･]+/gu, ' ')
  return text.toLowerCase().trim()
}

/**
 * 归一化文本 → 关键词集合。
 *
 * - **英文/数字**按空格切成词,长度 1 的丢掉(`a`、`3` 跟谁都像);
 * - **中文**切成相邻两字的二元组(「整理评论区」→ 整理/理评/评论/论区),再把整段里
 *   出现在停用词表里的那些整词去掉。二元组不是分词,但对"这两句话是不是在说同一件事"
 *   这个问题够用,而且**不需要词典** —— 这正是这一版要的:判据能一条条数出来。
 *
 * 注意二元组会把「整理评论区问题」与「整理评论区的问题」切得几乎一样(只差「理的」那一格),
 * 这正是我们要的:她两次说法不会逐字相同。
 */
export function keywordsOf(normalized: string): Set<string> {
  const out = new Set<string>()
  for (const chunk of normalized.split(' ')) {
    if (chunk === '') continue
    if (STOP_WORDS.has(chunk)) continue
    // 纯 ASCII(英文/数字)当一个词。
    if (/^[\da-z]+$/.test(chunk)) {
      if (chunk.length > 1) out.add(chunk)
      continue
    }
    const chars = [...chunk]
    // 整词命中停用词表的先摘掉(「一下」「今天」这种两字词)。
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const gram = `${chars[i]}${chars[i + 1]}`
      if (STOP_WORDS.has(gram)) continue
      if (STOP_WORDS.has(chars[i] as string) && STOP_WORDS.has(chars[i + 1] as string)) continue
      out.add(gram)
    }
    // 一个字的 chunk 切不出二元组,只要它不是停用词就自己算一个。
    if (chars.length === 1 && !STOP_WORDS.has(chars[0] as string)) out.add(chars[0] as string)
  }
  return out
}

/**
 * 两句话像不像:**重合系数**(交集 ÷ 较小那一边的大小),0–1。
 *
 * 为什么不是 Jaccard(交集 ÷ 并集):她说同一件事时长短差很多 ——「整理评论区问题」与
 * 「把评论区里读者问的那些问题整理成选题」是同一件事,Jaccard 会因为后者长而压到 0.3 以下。
 * 重合系数只问"短的那句是不是基本被长的那句包住了",这正是这里要判的。
 *
 * 任一边为空回 0(**不是 1**):没有关键词不等于"跟谁都一样"。
 */
export function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const word of small) if (big.has(word)) hit += 1
  return hit / small.size
}

// ───────────────────────────── 纯函数:重复检测 ─────────────────────────────

/** 一条"她说过的话"。生产从事项台账里取(`direction:'mine'` 的卡),用例直接造。 */
export interface EvolveSay {
  /** 事项 id(或别的稳定 id)。同一条只数一次。 */
  id: string
  /** 原话。标题或全文都行 —— 归一化只取第一行。 */
  text: string
  /** 说的时刻(ISO)。认不出的丢掉,**不拿"现在"顶**(D13)。 */
  at: string
}

/** 一条"疑似可固化"。 */
export interface EvolveCandidate {
  /** 稳定 id:`evolve:<代表句的归一化文本>`。同一簇在两天之间必须是同一个 id,否则"不要"记不住。 */
  id: string
  /** 代表句(簇里**最短**的那一条原话)。短的那句更接近"这件事本身",长的带着当次的细节。 */
  sample: string
  /** 这一簇里的全部原话(按时间先后)。提议卡上摆出来 —— 她要能看见"我哪三次说过"。 */
  says: readonly EvolveSay[]
  /** 重合过的关键词(排序后),给提议正文里那句「共同点」用。 */
  shared: readonly string[]
}

/**
 * 近 `WINDOW_DAYS` 天的话 → 疑似可固化的候选。
 *
 * 算法(贪心单链聚类,一遍扫完):
 * 1. 窗口外的、认不出时刻的、关键词不够 `MIN_KEYWORDS` 的,先丢掉;
 * 2. 按时间从早到晚扫;每一条跟**已有簇的代表句**比 `overlap`,≥ `OVERLAP_MIN` 就并进去
 *    (并进最像的那一簇,分数相同取先建的那一簇 —— 结果与输入顺序无关这件事由用例钉着);
 * 3. 一簇满 `REPEAT_MIN` 条才出候选。
 *
 * **不做传递闭包**:A 像 B、B 像 C 但 A 不像 C 时,不把三条并成一簇 —— 那正是把
 * 「整理选题」「整理素材」「素材清单」滚成一团的路。代价是偶尔把一件事分成两簇(各自不够三次,
 * 于是这一天不提议),这比提一条她看不懂的建议好。
 */
export function findRepeats(input: {
  says: readonly EvolveSay[]
  /** 现在(ms)。窗口从这里往回数。 */
  nowMs: number
  /** 这些 id 不要再提(她点过「不要」的)。 */
  declined?: readonly string[]
}): EvolveCandidate[] {
  const cutoff = input.nowMs - WINDOW_DAYS * 86_400_000
  const seen = new Set<string>()
  const rows: { say: EvolveSay, ms: number, norm: string, words: Set<string> }[] = []
  for (const say of input.says) {
    if (seen.has(say.id)) continue
    const ms = Date.parse(say.at)
    if (Number.isNaN(ms) || ms < cutoff || ms > input.nowMs) continue
    const norm = normalizeSay(say.text)
    if (norm === '') continue
    const words = keywordsOf(norm)
    if (words.size < MIN_KEYWORDS) continue
    seen.add(say.id)
    rows.push({ say, ms, norm, words })
  }
  rows.sort((a, b) => (a.ms - b.ms) || a.say.id.localeCompare(b.say.id))

  const clusters = greedyClusters(rows)

  const out: EvolveCandidate[] = []
  for (const cluster of clusters) {
    if (cluster.members.length < REPEAT_MIN) continue
    // 代表句取最短的那一条(同长取最早的)。
    const rep = [...cluster.members].sort((a, b) => (a.norm.length - b.norm.length) || (a.ms - b.ms))[0]
    if (rep === undefined) continue
    // 共同关键词 = 在簇里**过半**的成员身上都出现过的那些。
    const count = new Map<string, number>()
    for (const member of cluster.members) for (const word of member.words) count.set(word, (count.get(word) ?? 0) + 1)
    const shared = [...count.entries()]
      .filter(([, n]) => n * 2 >= cluster.members.length)
      .map(([word]) => word)
      .sort()
    const id = candidateId(rep.norm)
    if (input.declined?.includes(id) === true) continue
    out.push({
      id,
      sample: rep.say.text.trim(),
      says: cluster.members.map(member => member.say),
      shared,
    })
  }
  // 出现次数多的排前面;一样多按 id 排(稳定)。
  out.sort((a, b) => (b.says.length - a.says.length) || a.id.localeCompare(b.id))
  return out
}

/**
 * 贪心单链聚类(`findRepeats` 与 `findPreferences` 共用同一份)。
 *
 * 每一条跟**已有簇的代表句**比 `overlap`,≥ `OVERLAP_MIN` 就并进去(并进最像的那一簇,
 * 分数相同取先建的那一簇);**不做传递闭包**(理由在 findRepeats 的注释里)。
 * 调用方先把 rows 按时间排好 —— 簇的代表句是最早那一条,结果才与扫描顺序无关。
 */
function greedyClusters<Row extends { words: Set<string> }>(rows: readonly Row[]): { head: Set<string>, members: Row[] }[] {
  const clusters: { head: Set<string>, members: Row[] }[] = []
  for (const row of rows) {
    let best: { cluster: typeof clusters[number], score: number } | undefined
    for (const cluster of clusters) {
      const score = overlap(cluster.head, row.words)
      if (score < OVERLAP_MIN) continue
      if (best === undefined || score > best.score) best = { cluster, score }
    }
    if (best === undefined) clusters.push({ head: row.words, members: [row] })
    else best.cluster.members.push(row)
  }
  return clusters
}

/**
 * 候选的稳定 id。**由归一化文本直接拼**,不是随机数 —— 她点过「不要」之后我们要在
 * 下一天、下一次重启之后认出同一条来。归一化文本里的空格换成 `-`。
 */
export function candidateId(normalized: string): string {
  return `evolve:${normalized.replace(/ /g, '-')}`
}

// ───────────────────────────── 纯函数:偏好(⑥ 沉淀、⑧ 验证)─────────────────────────────

/**
 * 一条把关记录,**跨选题**的那一份形状:比 `DeckReviewEntry` 多一个 `topic`。
 * 生产从每条选题的 `审核记录.jsonl` 里读(`topicRun.ts` 的 `readAllTopicReviews`),用例直接造。
 */
export interface EvolveReviewSay {
  /** 哪条选题(目录名 = 卡的标题)。 */
  topic: string
  /** 对哪一份产物(页签名)。 */
  tab: string
  /** `run` / `pass` / `revise` / `self` …(不做枚举,同 accounts.ts 那条:读到什么算什么)。 */
  action: string
  /** 「改一改」时她说的那一句;`run` 时她补的那一句。 */
  text?: string
  /** ISO 时刻。 */
  at: string
}

/** 一条偏好(机读那一份;人读的一行由 `preferenceLine` 拼)。 */
export interface EvolvePreference {
  /** 稳定 id:`pref:<代表句的归一化文本>`。撤过的靠它认出来,不再自动记第二遍。 */
  id: string
  /** 代表句 = 那几次里**最短**的原话。 */
  text: string
  /** 在哪几条选题上说过(按时间先后,不重复)。 */
  topics: string[]
  /** 那几次的原话,一条一行 —— 日志里要摆出来,她要能看见"我凭什么记这一条"。 */
  evidence: { topic: string, tab: string, at: string, text: string }[]
  status: EvolvePreferenceStatus
  /** 记下来的时刻(ISO)。验证只看这之后的推进。 */
  adopted_at: string
  verified_at?: string
  /** 验证的结论(人话)。 */
  verdict?: string
}

export function preferenceId(normalized: string): string {
  return `pref:${normalized.replace(/ /g, '-')}`
}

/** 一条把关记录 → 它的关键词集合;不是打回、没说话、说得太短的回 undefined(不参与)。 */
function reviseWords(say: EvolveReviewSay): { norm: string, words: Set<string> } | undefined {
  if (say.action !== 'revise') return undefined
  const text = say.text?.trim() ?? ''
  if (text === '') return undefined
  const norm = normalizeSay(text)
  if (norm === '') return undefined
  const words = keywordsOf(norm)
  if (words.size < MIN_KEYWORDS) return undefined
  return { norm, words }
}

/**
 * 近 `PREF_WINDOW_DAYS` 天的把关记录 → 新的偏好候选(状态「试用」)。
 *
 * 判据只有一条:**同一类打回意见在 ≥ `PREF_MIN_TOPICS` 条不同选题上出现过**。
 * 同一条选题上打回两次同一处,不是偏好 —— 那是事务官上一轮没改对,归那条选题的把关记录管。
 * `known` 里的 id(已记下的、撤过的)不再出。
 */
export function findPreferences(input: {
  reviews: readonly EvolveReviewSay[]
  nowMs: number
  known?: readonly string[]
}): EvolvePreference[] {
  const cutoff = input.nowMs - PREF_WINDOW_DAYS * 86_400_000
  const rows: { say: EvolveReviewSay, ms: number, norm: string, words: Set<string> }[] = []
  for (const say of input.reviews) {
    const ms = Date.parse(say.at)
    if (Number.isNaN(ms) || ms < cutoff || ms > input.nowMs) continue
    const parsed = reviseWords(say)
    if (parsed === undefined) continue
    rows.push({ say, ms, ...parsed })
  }
  rows.sort((a, b) => (a.ms - b.ms) || a.say.topic.localeCompare(b.say.topic, 'en'))

  const out: EvolvePreference[] = []
  for (const cluster of greedyClusters(rows)) {
    const topics: string[] = []
    for (const member of cluster.members) if (!topics.includes(member.say.topic)) topics.push(member.say.topic)
    if (topics.length < PREF_MIN_TOPICS) continue
    const rep = [...cluster.members].sort((a, b) => (a.norm.length - b.norm.length) || (a.ms - b.ms))[0]
    if (rep === undefined) continue
    const id = preferenceId(rep.norm)
    if (input.known?.includes(id) === true) continue
    out.push({
      id,
      text: (rep.say.text ?? '').trim(),
      topics,
      evidence: cluster.members.map(member => ({
        topic: member.say.topic, tab: member.say.tab, at: member.say.at, text: (member.say.text ?? '').trim(),
      })),
      status: 'trial',
      adopted_at: new Date(input.nowMs).toISOString(),
    })
  }
  out.sort((a, b) => (b.topics.length - a.topics.length) || a.id.localeCompare(b.id))
  return out
}

/** 这句打回是不是在说同一处(与偏好的代表句关键词重合 ≥ OVERLAP_MIN)。 */
export function reviseMatches(preference: Pick<EvolvePreference, 'text'>, say: EvolveReviewSay): boolean {
  const parsed = reviseWords(say)
  if (parsed === undefined) return false
  return overlap(keywordsOf(normalizeSay(preference.text)), parsed.words) >= OVERLAP_MIN
}

export interface PreferenceVerdict {
  status: EvolvePreferenceStatus
  /** 人话:凭什么这么判。 */
  why: string
}

/**
 * ⑧ 验证:记下之后**下一次推进**的结果说了算。
 *
 * 只看 `adopted_at` 之后的 `run`(那之前推进的话里还没带这一条,结果与它无关)。
 * 每一次 `run` 之后,在**同一条选题**上往后看:
 * - 她又打回了、而且说的是同一处 → `reverted`(没见效);
 * - 她对推进那一段的产物点了「通过」→ `kept`;
 * - 打回的是别处 → 不算数,接着往后看;
 * - 又一次 `run` → 这一轮到此为止,看下一轮。
 * 一轮都没有结论 → 仍是 `trial`。
 *
 * **第一个有结论的说了算**。同一条偏好不会在一次验证里既保留又撤。
 */
export function verifyPreference(preference: EvolvePreference, reviews: readonly EvolveReviewSay[]): PreferenceVerdict {
  // 稳定排序:同一毫秒内的几条保持读进来的先后(文件里的追加顺序)。「之后」按位置判,不按时刻判 ——
  // 她点「推进」与点「通过」可能落在同一毫秒里(用例里就是),拿时刻比会把那一次漏掉。
  const sorted = [...reviews].filter(one => !Number.isNaN(Date.parse(one.at))).sort((a, b) => a.at.localeCompare(b.at))
  const runs = sorted.filter(one => one.action === 'run' && one.at >= preference.adopted_at)
  if (runs.length === 0) return { status: 'trial', why: '记下之后还没推进过新的一段' }
  for (const run of runs) {
    const after = sorted.slice(sorted.indexOf(run) + 1).filter(one => one.topic === run.topic)
    for (const one of after) {
      if (one.action === 'run') break
      if (one.action === 'revise' && reviseMatches(preference, one)) {
        return { status: 'reverted', why: `《${run.topic}》推进之后她又打回了同一处:「${(one.text ?? '').trim()}」` }
      }
      if (one.action === 'pass' && one.tab === run.tab) {
        return { status: 'kept', why: `《${run.topic}》推进之后她通过了 ${one.tab},没再打回同一处` }
      }
    }
  }
  return { status: 'trial', why: '推进过了,她还没对那份产物把关' }
}

/** 一条偏好在话里、在 `账号.md` 里、在收件箱里**同一行**。 */
export function preferenceLine(preference: EvolvePreference): string {
  const where = preference.topics.map(topic => `《${topic}》`).join('')
  const state = preference.status === 'kept' ? '已验证' : preference.status === 'reverted' ? '已撤' : '试用中'
  return `「${preference.text}」—— 在${where}上都打回过(${state},${preference.adopted_at.slice(0, 10)} 起)`
}

export function preferenceView(preference: EvolvePreference): EvolvePreferenceView {
  return {
    id: preference.id,
    text: preference.text,
    topics: preference.topics,
    status: preference.status,
    adopted_at: preference.adopted_at,
    ...(preference.verdict === undefined ? {} : { verdict: preference.verdict }),
    line: preferenceLine(preference),
  }
}

/** 验证结论补在日志那一条底下的一行。**不删原来那一段**,与「已撤」同一条纪律。 */
export function renderVerdictLine(preference: EvolvePreference, date: string): string {
  const head = preference.status === 'kept' ? '已验证保留' : preference.status === 'reverted' ? '已撤(没见效)' : '仍在试用'
  return `- **${head}**:${date} —— ${preference.verdict ?? ''}(偏好 id \`${preference.id}\`)\n`
}

/**
 * 在日志里某一条底下补一行(找 `- **提议 id**:\`<id>\`` 那一行)。
 * 一模一样的一行已经在了就不写第二遍;找不到那一条时原样回并说没找到(同 markUndone)。
 */
export function annotateLog(text: string | undefined, id: string, line: string): { text: string, marked: boolean } {
  const original = text ?? ''
  const needle = `- **提议 id**:\`${id}\``
  const at = original.lastIndexOf(needle)
  if (at === -1) return { text: original, marked: false }
  const lineEnd = original.indexOf('\n', at)
  const cut = lineEnd === -1 ? original.length : lineEnd + 1
  // 这一条底下已经有同样那一行了(撤两次、验两次)就不重复写。
  const tail = original.slice(cut)
  const block = tail.slice(0, tail.indexOf('\n## ') === -1 ? tail.length : tail.indexOf('\n## '))
  if (block.includes(line.trimEnd())) return { text: original, marked: true }
  return { text: `${original.slice(0, cut)}${line}${original.slice(cut)}`, marked: true }
}

// ───────────────────────────── 纯函数:提议正文 ─────────────────────────────

/** 三条路各自的名字。**一处定义**:提议卡上、日志里、路由校验用的是同一份。 */
export const EVOLVE_WAY_TITLES: Record<EvolveWay, string> = {
  skill: '一条技能',
  tool: '一个小组件',
  template: '模板里的固定一步',
}

/**
 * 候选 → 提议卡上那两段字。**不经模型**,全部从候选里拼出来。
 *
 * `ask` 是问句(卡的第一行),`plan` 是「它准备怎么做、会碰什么」——
 * 设计文档 §五 2 点名要这一段:她得在点头之前知道这一下会动到什么。
 */
export function evolveAsk(candidate: EvolveCandidate): string {
  return `这 ${candidate.says.length} 次你都在说「${candidate.sample}」—— 要不要把它固化下来?`
}

export function evolvePlan(candidate: EvolveCandidate, way: EvolveWay): string {
  if (way === 'skill') {
    return [
      `做成${EVOLVE_WAY_TITLES.skill}:我起草一份 docs/技能/固化-<名>.md(照你这几次说的话写成步骤),`,
      '**先是草稿**,你过一遍再说;你认了我才把它写进事务官的 AGENTS.md 标记段。',
      '会碰的东西:仓库里多一份技能文档 + ~/.dsh/AGENTS.md 里多一段(段外一个字不动,写之前先备份)。',
      '撤:删那份文件,并把那一段从 AGENTS.md 里摘掉。',
    ].join('')
  }
  if (way === 'tool') {
    return [
      `做成${EVOLVE_WAY_TITLES.tool}:走「开发一个小工具」那条老路 —— 我把这句需求预填好,`,
      '**不替你发出去**;你改完点确认,才由 DSH 去做那个小网页,做好在窗位叠多一个标签。',
      '会碰的东西:确认之前一个字节都不写;确认之后只在 modules/ 下新建它自己那个目录。',
      '撤:走窗位叠里那个标签的回收(模块进回收站)。',
    ].join('')
  }
  return [
    `做成${EVOLVE_WAY_TITLES.template}:这一版**还没做** —— 我只在进化日志里记一条「待做」,`,
    '等模板那条路通了再回来接。会碰的东西:只往进化日志里加一行,别的什么都不动。',
  ].join('')
}

/** 候选默认建议走哪条路。**只是默认值**,卡上三条都点得动。 */
export function suggestWay(candidate: EvolveCandidate): EvolveWay {
  // 带"看/查/表/图/统计/算"这类字眼的更像要一块界面;别的默认做成技能(写一份步骤最便宜、最好撤)。
  const toolish = ['看板', '统计', '算一', '计算', '图表', '倒计', '计时', '清单', '打卡']
  const norm = normalizeSay(candidate.sample)
  return toolish.some(word => norm.includes(word)) ? 'tool' : 'skill'
}

/** 候选 → 一条待她点头的提议。`created_at` 由调用方给(测试注入固定时钟)。 */
export function proposalOf(candidate: EvolveCandidate, createdAt: string): EvolveProposalView {
  const way = suggestWay(candidate)
  return {
    id: candidate.id,
    ask: evolveAsk(candidate),
    sample: candidate.sample,
    times: candidate.says.length,
    says: candidate.says.map(say => say.text.trim()),
    suggested_way: way,
    plans: { skill: evolvePlan(candidate, 'skill'), tool: evolvePlan(candidate, 'tool'), template: evolvePlan(candidate, 'template') },
    created_at: createdAt,
  }
}

// ───────────────────────────── 纯函数:技能草稿与名字 ─────────────────────────────

/** 固化出来的技能文件都叫这个前缀。**一处定义**:文件名、AGENTS.md 的标记段名、撤销时都用它。 */
export const EVOLVE_SKILL_PREFIX = '固化-'
/** 技能目录。与 opsSkills.ts 的 OPS_SKILL_DIR 同一个值 —— 那边是 import 不进来的纯清单,这里由守卫用例钉着两者相等。 */
export const EVOLVE_SKILL_DIR = 'docs/技能'
/** 仓库里那份人读的模板。代码起草的正文与它的小标题由守卫用例钉着一致。 */
export const EVOLVE_SKILL_TEMPLATE_DOC = `${EVOLVE_SKILL_DIR}/固化-模板.md`

/** 起草的技能正文里必有的几个小标题。**一处定义**,守卫用例拿它去核模板文件。 */
export const EVOLVE_SKILL_SECTIONS = ['什么时候用', '怎么做', '产物落在哪', '这一份是怎么来的'] as const

/**
 * 技能段名 = 文件名(去掉 .md)。同 opsSkills.ts 那条 F1:
 * 名字改了而标记段名忘了改的话,老那一段会永远留在 AGENTS.md 里没人摘得掉。
 */
export function evolveSkillName(name: string): string {
  return `${EVOLVE_SKILL_PREFIX}${name}`
}

export function evolveSkillDoc(name: string): string {
  return `${EVOLVE_SKILL_DIR}/${evolveSkillName(name)}.md`
}

/**
 * 技能名能不能做文件名。规矩照 `accounts.ts` 的 `safeAccountName`:
 * 不能空、不能带路径分隔符或 `..`、不能以点开头、长度有限。
 *
 * 这道闸不是形式主义 —— 它挡的是"在用户仓库里按一个候选句子建文件"。
 */
export function safeSkillName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  if (name === '' || name.length > 24) return undefined
  if (/[/\\]/.test(name) || name.includes('..') || name.startsWith('.')) return undefined
  if (name.includes('\n')) return undefined
  return name
}

/**
 * 起草一份技能文档。**是草稿**:开头那句话就写着「这是草稿,先由她把关」。
 *
 * 正文里的每一条都从她自己的原话来 —— 这份文档不该出现任何一句她没说过的"步骤"。
 * 真正把它写成好用的技能,是她(或事务官在会话里)之后的事;这里只负责把
 * 「她这几次到底说了什么」摆成一个能改的骨架。
 */
export function evolveSkillDraft(input: { name: string, proposal: EvolveProposalView, date: string }): string {
  return [
    `# ${evolveSkillName(input.name)}`,
    '',
    '> 这份是事务官的技能。**它现在是草稿** —— 由工作台从你最近说过的话里起草,还没人把过关。',
    `> 起草依据:${input.date} 之前的 14 天里,你说过 ${input.proposal.times} 次同一类的话(原话在最后一节)。`,
    '> 改完它就是定稿;不要它就删掉这个文件,并在设置里把这一段从 AGENTS.md 摘掉。',
    '',
    `## ${EVOLVE_SKILL_SECTIONS[0]}`,
    '',
    `他说「${input.proposal.sample}」这一类话的时候。`,
    '',
    `## ${EVOLVE_SKILL_SECTIONS[1]}`,
    '',
    '<!-- 这一节等你填。工作台不替你编步骤:下面那几句原话是全部依据,再多一个字都是猜的。 -->',
    '',
    `## ${EVOLVE_SKILL_SECTIONS[2]}`,
    '',
    '<!-- 这一节等你填。写清相对工作目录的路径,事务官照着落文件。 -->',
    '',
    `## ${EVOLVE_SKILL_SECTIONS[3]}`,
    '',
    ...input.proposal.says.map(say => `- ${say}`),
    '',
  ].join('\n')
}

// ───────────────────────────── 纯函数:进化日志 ─────────────────────────────

/** 日志文件名。落在**工作目录**里(不是仓库):它是她的东西,跟 `账号/`、`选题/` 同一层。 */
export const EVOLVE_LOG_NAME = '进化日志.md'

export function evolveLogPath(workdir: string): string {
  return join(workdir, EVOLVE_LOG_NAME)
}

/** 日志文件的抬头。文件不存在时先写它。 */
export const EVOLVE_LOG_HEAD = [
  '# 进化日志',
  '',
  '> 事务官每固化一样东西,这里多一条:哪天、为什么、做成了什么、怎么撤。',
  '> 一条一段,**只追加不改写**。撤销之后原来那一条留着,底下补一行「已撤」。',
  '',
].join('\n')

export interface EvolveLogEntry {
  /** 提议 id(撤销时按它找回这一条)。 */
  id: string
  /** 哪天。 */
  date: string
  /** 为什么(她这几次说过什么)。 */
  why: string
  /** 做成了什么。 */
  what: string
  /** 怎么撤。 */
  how_to_undo: string
  /**
   * 走的哪条路。撤销时按它决定怎么撤。`preference` 是 2026-09-23 加的第四种(偏好那一截);
   * `habit` 是 2026-10-09 从行为账数出来的习惯(`habits.ts`,撤走 `/habits/revoke`,不进 evolve.json)。
   */
  way: EvolveWay | 'preference' | 'habit'
  /** 技能那条路起的名字(`way:'skill'` 才有)。撤销时按它找那份文件与那个标记段。 */
  skill_name?: string
  /** 技能那一段接进 AGENTS.md 了没。草稿写下来、她还没把关时是 false。 */
  wired?: boolean
}

/** 一条日志 → 一段 Markdown。四行,顺序就是卡里那四个词。 */
export function renderLogEntry(entry: EvolveLogEntry): string {
  return [
    `## ${entry.date} ${entry.what}`,
    '',
    `- **为什么**:${entry.why}`,
    `- **做成了什么**:${entry.what}`,
    `- **怎么撤**:${entry.how_to_undo}`,
    `- **提议 id**:\`${entry.id}\``,
    '',
  ].join('\n')
}

/** 撤销时补在那一条下面的一行。**不删原来那一段** —— 撤了也是发生过的事。 */
export function renderUndoLine(id: string, date: string): string {
  return `- **已撤**:${date}(提议 id \`${id}\`)\n`
}

/**
 * 往日志正文里追加一条。**纯函数**:读进来的全文进,写回去的全文出。
 * 文件还不存在(`undefined`)时先铺抬头。
 */
export function appendLog(text: string | undefined, entry: EvolveLogEntry): string {
  const base = text === undefined || text.trim() === '' ? EVOLVE_LOG_HEAD : text.replace(/\s*$/, '\n\n')
  return `${base}${renderLogEntry(entry)}`
}

/**
 * 在日志里给某一条补上「已撤」。找不到那一条时**原样回并说没找到** —— 不在文件末尾
 * 凭空补一行:一条找不到来源的「已撤」比没有更让人糊涂。
 */
export function markUndone(text: string | undefined, id: string, date: string): { text: string, marked: boolean } {
  const original = text ?? ''
  const needle = `- **提议 id**:\`${id}\``
  const at = original.lastIndexOf(needle)
  if (at === -1) return { text: original, marked: false }
  const lineEnd = original.indexOf('\n', at)
  const cut = lineEnd === -1 ? original.length : lineEnd + 1
  // 同一条撤两次不重复写。
  if (original.slice(cut, cut + 200).startsWith('- **已撤**')) return { text: original, marked: true }
  return { text: `${original.slice(0, cut)}${renderUndoLine(id, date)}${original.slice(cut)}`, marked: true }
}

/** 「上次固化的 X 用了没」那一句(复盘/下班例程里问的)。没有已做的就整句缺席。 */
export function reviewLine(done: readonly EvolveLogEntry[]): string | undefined {
  const last = done[done.length - 1]
  if (last === undefined) return undefined
  return `上次固化的「${last.what}」(${last.date})用了没、好不好用?不好用就撤掉:${last.how_to_undo}`
}

// ───────────────────────────── 落盘:evolve.json ─────────────────────────────

export function defaultEvolveFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/evolve.json`
}

export interface EvolveFile {
  version: 1
  /** 等她点头的。 */
  pending: EvolveProposalView[]
  /** 她点过「不要」的候选 id。**以后不再提这一条**。 */
  declined: string[]
  /** 已经固化过的(进化日志的机读那一份;人读的在 `进化日志.md`)。 */
  done: EvolveLogEntry[]
  /** 上一次扫过的日期(`YYYY-MM-DD`)。一天只提一次。 */
  scanned_on?: string
  /** 偏好(2026-09-23)。三种状态都留着 —— 撤过的要认得出来,不再自动记第二遍。 */
  preferences?: EvolvePreference[]
  /** 收件箱里那几条提示(至多 NOTICE_MAX 条,新的在后)。 */
  notices?: EvolveNoticeView[]
}

export interface EvolveStore {
  load: () => Promise<void>
  pending: () => readonly EvolveProposalView[]
  declined: () => readonly string[]
  done: () => readonly EvolveLogEntry[]
  scannedOn: () => string | undefined
  find: (id: string) => EvolveProposalView | undefined
  /** 加一批提议(已在 pending / declined / done 里的跳过)。回真正加进去的条数。 */
  add: (proposals: readonly EvolveProposalView[]) => Promise<number>
  /** 撤下一条。`decline:true` 同时记进「以后不再提」。 */
  drop: (id: string, options?: { decline?: boolean }) => Promise<boolean>
  /** 记一条已固化。 */
  finish: (entry: EvolveLogEntry) => Promise<void>
  /** 从已固化里摘掉(撤销)。 */
  unfinish: (id: string) => Promise<EvolveLogEntry | undefined>
  markScanned: (date: string) => Promise<void>
  /** 偏好(全部状态)。 */
  preferences: () => readonly EvolvePreference[]
  /** 记一条 / 改一条(按 id 换)。 */
  putPreference: (preference: EvolvePreference) => Promise<void>
  /** 提示(不判过期,过期由 view 判)。 */
  notices: () => readonly EvolveNoticeView[]
  /** 加一条提示;只留最新 NOTICE_MAX 条。 */
  pushNotice: (notice: EvolveNoticeView) => Promise<void>
}

export function createEvolveStore(options: { file: string }): EvolveStore {
  let state: EvolveFile = { version: 1, pending: [], declined: [], done: [] }

  const save = async (): Promise<void> => {
    await mkdir(dirname(options.file), { recursive: true })
    await writeFile(options.file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(options.file, 'utf8')) as Partial<EvolveFile>
        // 文件坏了 / 没有 = 一条都没有。**不抛**:一份读不懂的 json 不该让工作台起不来(同 devTool.ts)。
        state = {
          version: 1,
          pending: Array.isArray(raw.pending)
            ? raw.pending.filter((item): item is EvolveProposalView => typeof item?.id === 'string' && typeof item.ask === 'string')
            : [],
          declined: Array.isArray(raw.declined) ? raw.declined.filter((id): id is string => typeof id === 'string') : [],
          done: Array.isArray(raw.done)
            ? raw.done.filter((item): item is EvolveLogEntry => typeof item?.id === 'string' && typeof item.date === 'string')
            : [],
          ...(typeof raw.scanned_on === 'string' ? { scanned_on: raw.scanned_on } : {}),
          preferences: Array.isArray(raw.preferences)
            ? raw.preferences.filter((item): item is EvolvePreference => typeof item?.id === 'string' && typeof item.text === 'string' && typeof item.adopted_at === 'string')
            : [],
          notices: Array.isArray(raw.notices)
            ? raw.notices.filter((item): item is EvolveNoticeView => typeof item?.id === 'string' && typeof item.title === 'string' && typeof item.at === 'string')
            : [],
        }
      }
      catch { state = { version: 1, pending: [], declined: [], done: [] } }
    },
    pending() { return state.pending },
    declined() { return state.declined },
    done() { return state.done },
    scannedOn() { return state.scanned_on },
    find(id) { return state.pending.find(item => item.id === id) },
    async add(proposals) {
      const known = new Set([
        ...state.pending.map(item => item.id),
        ...state.declined,
        ...state.done.map(item => item.id),
      ])
      const fresh = proposals.filter(item => !known.has(item.id))
      if (fresh.length === 0) return 0
      const room = Math.max(0, MAX_PENDING - state.pending.length)
      const take = fresh.slice(0, room)
      if (take.length === 0) return 0
      state = { ...state, pending: [...state.pending, ...take] }
      await save()
      return take.length
    },
    async drop(id, dropOptions) {
      // **挂着的那几条里没有这一条就回 false**,而不是顺手记一条「不要」——
      // 那样调用方分不清"她拒了一条"与"根本没有这一条",路由也就回不出 404。
      const next = state.pending.filter(item => item.id !== id)
      if (next.length === state.pending.length) return false
      const declined = dropOptions?.decline === true && !state.declined.includes(id)
        ? [...state.declined, id]
        : state.declined
      state = { ...state, pending: next, declined }
      await save()
      return true
    },
    async finish(entry) {
      state = { ...state, pending: state.pending.filter(item => item.id !== entry.id), done: [...state.done, entry] }
      await save()
    },
    async unfinish(id) {
      const entry = state.done.find(item => item.id === id)
      if (entry === undefined) return undefined
      state = { ...state, done: state.done.filter(item => item.id !== id) }
      await save()
      return entry
    },
    async markScanned(date) {
      state = { ...state, scanned_on: date }
      await save()
    },
    preferences() { return state.preferences ?? [] },
    async putPreference(preference) {
      const rest = (state.preferences ?? []).filter(item => item.id !== preference.id)
      state = { ...state, preferences: [...rest, preference] }
      await save()
    },
    notices() { return state.notices ?? [] },
    async pushNotice(notice) {
      const next = [...(state.notices ?? []).filter(item => item.id !== notice.id), notice]
      state = { ...state, notices: next.slice(-NOTICE_MAX) }
      await save()
    },
  }
}

// ───────────────────────────── 服务:把五步串起来 ─────────────────────────────

/**
 * 这个模块碰盘的全部出口。**注入的** —— 2026-09-04 家目录被删事故之后的纪律:
 * 凡是写用户盘的代码都必须把路径与写法做成可注入参数,用例里用临时目录跑。
 */
export interface EvolveIo {
  /** 读不到(不存在/没权限)回 undefined,**不抛**。 */
  readFile: (file: string) => Promise<string | undefined>
  writeFile: (file: string, text: string) => Promise<void>
  /** 删一个文件。不存在时当成删过了(回 false),不抛。 */
  removeFile: (file: string) => Promise<boolean>
}

/** 技能段那条口(生产接 hooksApply.ts 的 wbSkillApply/wbSkillRevert,它带着备份纪律)。 */
export interface EvolveSkillPort {
  apply: (name: string, body: string) => Promise<{ ok: boolean, error?: string }>
  revert: (name: string) => Promise<{ ok: boolean, removed?: boolean, error?: string }>
}

/** 小组件那条口(生产接现有 devTool 那条链路的 store.add)。**预填,不自动发**。 */
export type EvolveToolPort = (input: { request: string, restate: string }) => Promise<{ ok: boolean, error?: string }>

export interface EvolveServiceOptions {
  store: EvolveStore
  io: EvolveIo
  /** 她说过的话从哪来。生产从事项台账取(`direction:'mine'` 的卡),用例直接给。 */
  says: () => Promise<readonly EvolveSay[]>
  now?: () => number
  /** 工作目录(`进化日志.md` 落这里)。缺席 = 日志写不了,固化那一步如实失败、一个字不写。 */
  workdir?: string
  /** 仓库根(`docs/技能/` 落这里)。缺席 = 技能那条路不可用,如实说。 */
  repo?: string
  skill?: EvolveSkillPort
  tool?: EvolveToolPort
  /**
   * 她的把关记录从哪来(2026-09-23,偏好那一截)。生产读每条选题的 `审核记录.jsonl`
   * (`topicRun.ts` 的 `readAllTopicReviews`),用例直接给。缺席 = 偏好那一截整个不动。
   */
  reviews?: () => Promise<readonly EvolveReviewSay[]>
  /**
   * 他亲口交代过的那些话的全文(标题与全文都算,2026-09-25)。给 `revalidate` 认「摆着的提议还靠不靠得住」:
   * 一条提议的那几句话在这里一句都找不到,说明它是拿系统写的字凑出来的(通话纪要、引导出处说明),撤下。
   * 缺席 = 不做这一步(用例与老接线原样)。
   */
  spoken?: () => Promise<readonly string[]>
}

export interface EvolveService {
  load: () => Promise<void>
  /**
   * 把摆着的提议里**已经找不到出处**的撤下(2026-09-25):那几句话在他亲口交代的卡里一句都没有了。
   * 不记「不要」(不是她拒的),回撤了几条。没接 `spoken` 时什么都不做。
   */
  revalidate?: () => Promise<number>
  view: () => import('../protocol.ts').EvolveStateView
  /** 扫一遍。`force` 之外一天只扫一次(`scanned_on`)。回一句人话给例程的 note。 */
  scan: (options?: { force?: boolean }) => Promise<{ added: number, note: string }>
  /** 她点「做」。`name` 只有技能那条路要(文件名)。 */
  accept: (input: { id: string, way?: EvolveWay, name?: unknown }) => Promise<{ ok: true, note: string } | { ok: false, error: string }>
  /** 草稿她过了,接进 AGENTS.md 的技能段。 */
  wire: (id: string) => Promise<{ ok: true, note: string } | { ok: false, error: string }>
  /** 她点「不要」——以后不再提这一条。 */
  decline: (id: string) => Promise<boolean>
  /** 她点「以后再说」——这次撤下,下次扫到还会再提。 */
  later: (id: string) => Promise<boolean>
  /** 撤一条已固化的。 */
  revert: (id: string) => Promise<{ ok: true, note: string } | { ok: false, error: string }>
  /** 进化日志全文(读不到回 undefined)。 */
  log: () => Promise<string | undefined>
  /**
   * ⑥⑧ 学一遍(2026-09-23):先验证试用中的偏好(保留 / 撤),再从把关记录里找新的。
   * 挂在两处:每次把关之后(http.ts 的 `/topic/review`)与下班例程之后。回一句人话。
   */
  learn: () => Promise<{ adopted: number, kept: number, reverted: number, note: string }>
  /** 还在生效的偏好各一行(已验证的在前),推进的话与 `账号.md` 画像段用。最多 PREF_MAX_LINES 条。 */
  preferenceLines: () => readonly string[]
}

/** `YYYY-MM-DD`(本地)。与 brief.ts 的 localDateStr 同一个口径,那边 import 得进来就不另写。 */
function dateStr(ms: number): string {
  const at = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

export function createEvolveService(options: EvolveServiceOptions): EvolveService {
  const now = options.now ?? (() => Date.now())
  const store = options.store

  /** 往 `进化日志.md` 追加一条。**没配工作目录就整件事停下** —— 留不了痕就别动手。 */
  async function writeLog(entry: EvolveLogEntry): Promise<{ ok: boolean, error?: string }> {
    const workdir = options.workdir
    if (workdir === undefined || workdir === '') {
      return { ok: false, error: '没配工作目录,进化日志没地方写 —— 留不了痕的事不做。' }
    }
    const file = evolveLogPath(workdir)
    try {
      const before = await options.io.readFile(file)
      await options.io.writeFile(file, appendLog(before, entry))
      return { ok: true }
    }
    catch (error) { return { ok: false, error: `进化日志写不下:${String(error)}` } }
  }

  /** 还在生效的:已验证的在前、再按记下的先后。 */
  function activePreferences(): EvolvePreference[] {
    return store.preferences()
      .filter(item => item.status !== 'reverted')
      .sort((a, b) => (a.status === b.status ? a.adopted_at.localeCompare(b.adopted_at) : a.status === 'kept' ? -1 : 1))
  }

  /** 验证结论 / 手撤 → 日志那一条底下补一行。没配工作目录就只改状态、如实少一行。 */
  async function annotate(preference: EvolvePreference, date: string): Promise<boolean> {
    const workdir = options.workdir
    if (workdir === undefined || workdir === '') return false
    const file = evolveLogPath(workdir)
    const before = await options.io.readFile(file)
    const marked = annotateLog(before, preference.id, renderVerdictLine(preference, date))
    if (marked.marked) await options.io.writeFile(file, marked.text)
    return marked.marked
  }

  /** 见 EvolveService.revalidate。**不用 this**:调用方拿去解构成裸函数也不会散架。 */
  async function revalidate(): Promise<number> {
    if (options.spoken === undefined) return 0
    let spoken: readonly string[]
    try { spoken = await options.spoken() }
    catch { return 0 }
    const alive = new Set(spoken.map(normalizeSay).filter(text => text !== ''))
    let dropped = 0
    for (const proposal of store.pending()) {
      if (proposal.says.some(say => alive.has(normalizeSay(say)))) continue
      if (await store.drop(proposal.id)) dropped += 1
    }
    return dropped
  }

  return {
    async load() { await store.load() },

    view() {
      const review = reviewLine(store.done())
      const active = activePreferences().map(preferenceView)
      const cutoff = now() - NOTICE_TTL_DAYS * 86_400_000
      const notices = store.notices().filter(notice => Date.parse(notice.at) >= cutoff)
      return {
        pending: store.pending(),
        ...(review === undefined ? {} : { review }),
        ...(active.length === 0 ? {} : { preferences: active }),
        ...(notices.length === 0 ? {} : { notices }),
      }
    },

    preferenceLines() {
      return activePreferences().slice(0, PREF_MAX_LINES).map(preferenceLine)
    },

    async learn() {
      const source = options.reviews
      if (source === undefined) return { adopted: 0, kept: 0, reverted: 0, note: '没接把关记录,偏好那一截没动' }
      let reviews: readonly EvolveReviewSay[]
      try { reviews = await source() }
      catch (error) { return { adopted: 0, kept: 0, reverted: 0, note: `没读到把关记录:${String(error)}` } }
      const date = dateStr(now())
      const at = new Date(now()).toISOString()
      const notes: string[] = []
      let kept = 0
      let reverted = 0
      let adopted = 0

      // ⑧ 先验证试用中的:结论一出就落状态、日志补一行、收件箱一条。
      for (const preference of store.preferences()) {
        if (preference.status !== 'trial') continue
        const verdict = verifyPreference(preference, reviews)
        if (verdict.status === 'trial') continue
        const next: EvolvePreference = { ...preference, status: verdict.status, verified_at: at, verdict: verdict.why }
        await store.putPreference(next)
        await annotate(next, date)
        if (verdict.status === 'kept') {
          kept += 1
          await store.pushNotice({
            id: `${next.id}:kept`, kind: 'kept', at,
            title: `上次记下的偏好见效了,保留:${preferenceLine(next)}`,
            note: `${verdict.why}。以后推进的话里一直带着它;不要了可以撤。`,
          })
        }
        else {
          reverted += 1
          await store.pushNotice({
            id: `${next.id}:reverted`, kind: 'reverted', at,
            title: `上次记下的偏好没见效,撤了:「${next.text}」`,
            note: `${verdict.why}。推进的话里不再带这一条;它还留在进化日志里。`,
          })
        }
      }

      // ⑥ 再找新的。**留不了痕的不记**:日志写不下时这一条跳过,如实说。
      const known = store.preferences().map(item => item.id)
      for (const candidate of findPreferences({ reviews, nowMs: now(), known })) {
        const where = candidate.evidence.map(one => `「${one.text}」(《${one.topic}》,${one.at.slice(0, 10)})`).join(' / ')
        const entry: EvolveLogEntry = {
          id: candidate.id, date, way: 'preference',
          why: `近 ${PREF_WINDOW_DAYS} 天在 ${candidate.topics.length} 条不同选题上都打回过同一处:${where}`,
          what: `记下一条偏好(试用):「${candidate.text}」`,
          how_to_undo: 'POST /evolve/revert { id } 手撤;下一条选题上她又打回同一处时工作台自己撤。撤了推进的话里就不再带这一条。',
        }
        const wrote = await writeLog(entry)
        if (!wrote.ok) { notes.push(wrote.error ?? '进化日志写不下'); continue }
        await store.putPreference(candidate)
        adopted += 1
        await store.pushNotice({
          id: `${candidate.id}:adopted`, kind: 'adopted', at,
          title: `记下一条你说过不止一次的偏好:「${candidate.text}」`,
          note: `在${candidate.topics.map(topic => `《${topic}》`).join('')}上都打回过同一处。下一条选题推进时我先照它做,不用你再交代;不对就撤(进化日志里有怎么撤)。`,
        })
      }

      if (adopted + kept + reverted === 0 && notes.length === 0) notes.push('把关记录里没有新的偏好,试用中的也还没验出结果')
      else {
        if (adopted > 0) notes.push(`记下 ${adopted} 条偏好(试用)`)
        if (kept > 0) notes.push(`${kept} 条偏好验证见效,保留`)
        if (reverted > 0) notes.push(`${reverted} 条偏好没见效,撤了`)
      }
      return { adopted, kept, reverted, note: notes.join(';') }
    },

    revalidate,

    async scan(scanOptions) {
      // 先把靠不住的撤了,再看今天扫没扫过 —— 撤这一步不该等到明天(2026-09-25)。
      await revalidate().catch(() => 0)
      const today = dateStr(now())
      if (scanOptions?.force !== true && store.scannedOn() === today) {
        return { added: 0, note: '今天已经扫过一遍了' }
      }
      let says: readonly EvolveSay[]
      try { says = await options.says() }
      catch (error) { return { added: 0, note: `没读到你说过的话:${String(error)}` } }
      const candidates = findRepeats({ says, nowMs: now(), declined: store.declined() })
      const added = await store.add(candidates.map(candidate => proposalOf(candidate, new Date(now()).toISOString())))
      await store.markScanned(today)
      // **一条都没有时如实说**,不编一条凑数(D13)。
      const note = added === 0
        ? `近 ${WINDOW_DAYS} 天没发现值得固化的重复`
        : `发现 ${added} 件反复在做的事,提议摆进收件箱了`
      return { added, note }
    },

    async accept(input) {
      const proposal = store.find(input.id)
      if (proposal === undefined) return { ok: false, error: '没有这条提议(可能已经处理过了)' }
      const way = input.way ?? proposal.suggested_way
      const date = dateStr(now())
      const why = `近 ${WINDOW_DAYS} 天说过 ${proposal.times} 次:${proposal.says.join(' / ')}`

      if (way === 'template') {
        // 模板固定一步:**这一版只记一条「待做」**,一个文件都不动(卡里钉死的)。
        const entry: EvolveLogEntry = {
          id: proposal.id, date, why, way,
          what: `待做:把「${proposal.sample}」做成模板里的固定一步`,
          how_to_undo: '还没做任何事,不用撤;不想要了在进化日志里划掉这一条。',
        }
        const wrote = await writeLog(entry)
        if (!wrote.ok) return { ok: false, error: wrote.error ?? '进化日志写不下' }
        await store.finish(entry)
        return { ok: true, note: '记下了,等模板那条路通了再回来接。' }
      }

      if (way === 'tool') {
        const tool = options.tool
        if (tool === undefined) return { ok: false, error: '这台服务没接「开发一个小工具」那条链路' }
        // **预填,不自动发**:那条链路自己还有一道「我理解的是…,它叫什么?」的门。
        const restate = proposal.sample
        const done = await tool({ request: `${DEV_TOOL_DRAFT}${restate}`, restate })
        if (!done.ok) return { ok: false, error: done.error ?? '那条需求没排进去' }
        const entry: EvolveLogEntry = {
          id: proposal.id, date, why, way,
          what: `把「${proposal.sample}」提成了一条小组件需求(还没发,等你在输入框上面那张卡里确认)`,
          how_to_undo: '那张卡上点「不做了」;已经做出来的小组件在窗位叠那个标签上走回收。',
        }
        const wrote = await writeLog(entry)
        if (!wrote.ok) return { ok: false, error: wrote.error ?? '进化日志写不下' }
        await store.finish(entry)
        return { ok: true, note: '需求预填好了,在输入框上面那张卡里 —— 你改完点确认才发出去。' }
      }

      // 技能:先落一份草稿文档,**不接进 AGENTS.md**(那一步等她过一遍,见 wire)。
      const repo = options.repo
      if (repo === undefined || repo === '') {
        return { ok: false, error: '不知道仓库在哪,写不了 docs/技能/。先在设置里把「事务官仓库目录」指到仓库根。' }
      }
      const name = safeSkillName(input.name)
      if (name === undefined) return { ok: false, error: '得给这条技能起个名字(不超过 24 个字,不能带 / 或 ..)' }
      const file = join(repo, evolveSkillDoc(name))
      if (await options.io.readFile(file) !== undefined) {
        return { ok: false, error: `${evolveSkillDoc(name)} 已经有了 —— 换个名字,免得把那一份覆盖掉` }
      }
      try { await options.io.writeFile(file, evolveSkillDraft({ name, proposal, date })) }
      catch (error) { return { ok: false, error: `技能草稿写不下:${String(error)}` } }
      const entry: EvolveLogEntry = {
        id: proposal.id, date, why, way, skill_name: name, wired: false,
        what: `起草了一条技能 ${evolveSkillDoc(name)}(草稿,还没接进事务官)`,
        how_to_undo: `删掉 ${evolveSkillDoc(name)};接进去了的话再把「${evolveSkillName(name)}」那一段从 ~/.dsh/AGENTS.md 摘掉。`,
      }
      const wrote = await writeLog(entry)
      if (!wrote.ok) return { ok: false, error: wrote.error ?? '进化日志写不下' }
      await store.finish(entry)
      return { ok: true, note: `草稿在 ${evolveSkillDoc(name)} —— 你过一遍、把「怎么做」那一节填了,再接进事务官。` }
    },

    async wire(id) {
      const entry = store.done().find(item => item.id === id)
      if (entry === undefined) return { ok: false, error: '没有这条固化记录' }
      if (entry.way !== 'skill' || entry.skill_name === undefined) return { ok: false, error: '这一条不是技能那条路' }
      const skill = options.skill
      if (skill === undefined) return { ok: false, error: '这台服务没接「代写事务官技能」' }
      const repo = options.repo
      if (repo === undefined || repo === '') return { ok: false, error: '不知道仓库在哪,读不到那份技能' }
      const body = await options.io.readFile(join(repo, evolveSkillDoc(entry.skill_name)))
      // 读不到就**一个字都不写**(同 opsSkills 那条:半份技能比没有技能更坏)。
      if (body === undefined) return { ok: false, error: `读不到 ${evolveSkillDoc(entry.skill_name)},一个字都没写` }
      const applied = await skill.apply(evolveSkillName(entry.skill_name), body.trim())
      if (!applied.ok) return { ok: false, error: applied.error ?? '技能段没写进去' }
      await store.unfinish(id)
      await store.finish({ ...entry, wired: true })
      return { ok: true, note: '接进去了。正开着的那条事务官会话还是旧的系统提示 —— 新开一条它才读得到。' }
    },

    async decline(id) { return store.drop(id, { decline: true }) },
    async later(id) { return store.drop(id) },

    async revert(id) {
      // 偏好那一截(2026-09-23):手撤 = 状态改成 reverted、日志补一行。**不删**那一条,也不从仓里删。
      if (id.startsWith('pref:')) {
        const preference = store.preferences().find(item => item.id === id)
        if (preference === undefined) return { ok: false, error: '没有这条偏好' }
        if (preference.status === 'reverted') return { ok: false, error: '这条偏好已经撤过了' }
        const next: EvolvePreference = { ...preference, status: 'reverted', verified_at: new Date(now()).toISOString(), verdict: '她手动撤的' }
        await store.putPreference(next)
        const marked = await annotate(next, dateStr(now()))
        return { ok: true, note: `撤了,推进的话里不再带「${next.text}」${marked ? '' : ';进化日志里没找到那一条,没补「已撤」'}` }
      }
      const entry = store.done().find(item => item.id === id)
      if (entry === undefined) return { ok: false, error: '没有这条固化记录' }
      const steps: string[] = []
      if (entry.way === 'skill' && entry.skill_name !== undefined) {
        if (entry.wired === true) {
          const reverted = await options.skill?.revert(evolveSkillName(entry.skill_name))
          if (reverted === undefined) return { ok: false, error: '这台服务没接「代写事务官技能」,那一段摘不掉' }
          if (!reverted.ok) return { ok: false, error: reverted.error ?? '那一段没摘掉' }
          steps.push('从 AGENTS.md 摘掉了那一段')
        }
        const repo = options.repo
        if (repo !== undefined && repo !== '') {
          const gone = await options.io.removeFile(join(repo, evolveSkillDoc(entry.skill_name)))
          steps.push(gone ? `删了 ${evolveSkillDoc(entry.skill_name)}` : `${evolveSkillDoc(entry.skill_name)} 本来就不在`)
        }
      }
      else if (entry.way === 'tool') {
        // 小组件走**现有回收**:那是窗位叠那个标签上的事,这里不越过它去删别人的目录。
        steps.push('小组件那一条走窗位叠里的回收(这里不替你删模块目录)')
      }
      else steps.push('模板那一条本来就没动过文件')

      // 日志里**不删原来那一段**,底下补一行「已撤」—— 撤了也是发生过的事。
      const workdir = options.workdir
      if (workdir !== undefined && workdir !== '') {
        const file = evolveLogPath(workdir)
        const before = await options.io.readFile(file)
        const marked = markUndone(before, id, dateStr(now()))
        if (marked.marked) await options.io.writeFile(file, marked.text)
        else steps.push('进化日志里没找到那一条,没补「已撤」')
      }
      await store.unfinish(id)
      return { ok: true, note: steps.join(';') }
    },

    async log() {
      const workdir = options.workdir
      if (workdir === undefined || workdir === '') return undefined
      return options.io.readFile(evolveLogPath(workdir))
    },
  }
}
