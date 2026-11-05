/**
 * **一句话排进发布计划**(2026-10-13,卡「演示 · 座机一句话往自媒体日历里记发布计划」;周三 10-14 演示场景 4)。
 *
 * 维护者 10-12 晚的原话:「拿起座机告诉事务官,操作小组件,比如自媒体运营那个日历那里,
 * 告知计划几号发布一个什么视频,然后就能看到那一天会有一个事项,悬浮上去就能看到相关内容。」
 *
 * ## 这一层管什么
 *
 * 只管**认话**:这一句是不是在排一条发布计划、排在哪一天、排的是什么。
 * 真正落盘的是「卡片内填」那一格已经在用的那条路(一张 `kind:'topic'` 的卡 + `planned_at`,
 * 见 `client/PublishModule.tsx` 文件头的两状态表)—— **不另起一套存储**,
 * 所以电话里说出来的那一条与她在日历上点一天填出来的那一条是同一种条目。
 *
 * ## 为什么自己认日子,不复用 `meetingPrep.parseMeetingWhen`
 *
 * 那一份认的是「哪天 + 几点」,而且:
 *   · **不认光秃秃的「18 号」**(它的 `DAY_RE` 只认「M 月 N 日」);
 *   · 认不出日子时**退回「今天」**,而排发布计划认不出日子要**回问一句**(统筹定,见决策记录);
 *   · 它把挨在一起的「日子 + 上下午 + 点钟」拼成一截,句子两头散着的不拼 ——
 *     「晚上我们定一下,10 月 20 号发视频」在那边会算成今天。
 * 中文数字那张表是**同一份**(`cnNumberOf`,主人在 `meetingPrep.ts`),没抄第二份。
 *
 * ## 认到多宽(2026-10-13 下午维护者拍板:不带「发布」的自然说法也要进日历)
 *
 * 场景 4 真机那一句是「呃,我20号计划要发一个视频,是做我们大赛的整个回顾。」——
 * 发布动词那一关它本来就过(「要发」+「发一个」),**卡住的是主题**:旧认法只在「视频」前面找,
 * 而那一句的「视频」前面只剩「计划要发一个」。现在:
 *
 *   · 发布动词照旧那一张({@link PUBLISH_CUE}):「发布 / 发表 / 上线 / 更新 / 要发 / 想发 / 打算发 /
 *     准备发 / 计划发」,外加**带量词的「发一个 / 发个 / 发条 / 发一条」**(光一个「发」仍不算);
 *   · 主题:先在「视频」前面找(「关于 X 的」那一截最准),**找不到就在后半句找**
 *     ({@link SUBJECT_AFTER}:「是做 / 是关于…的 / 讲 / 内容是」);
 *   · **两头都找不到主题 → 回问一句**({@link PUBLISH_PLAN_ASK_SUBJECT}),一张卡都不建、一个主题都不猜;
 *   · 日子只说了「N 号」= **从工作台的钟算起最近的那个 N 号**(本月还没到就本月、已经过了就下月,
 *     见 {@link nearestDayOfMonth});说不清(「月底」)照旧回问 {@link PUBLISH_PLAN_ASK_DAY}。
 *
 * 一行 I/O 都没有,用例直接对着字符串断言。
 */
import type { TaskView, TopicContentType } from '../protocol.ts'
import { localDateStr } from './brief.ts'
import { cnNumberOf } from './meetingPrep.ts'

// ───────────────────────────── 日子 ─────────────────────────────

const CN_NUM = '[零一二两三四五六七八九十]{1,3}'
const MONTH_DAY = new RegExp(`(\\d{1,2}|${CN_NUM})\\s*月\\s*(\\d{1,2}|${CN_NUM})\\s*[日号]`)
/**
 * 光秃秃的「18 号」。
 *
 * 前面不许紧挨着「月」或数字 —— 那是「10 月 20 号」的后半截,归上面那一条。
 * **用后顾断言而不是「前面一个不是这些的字」**:后者会把「十八号」里的「十」吃掉当前缀,
 * 剩给数字那一组的只有「八」(真量过:回 11 月 8 号)。
 */
const BARE_DAY = new RegExp(`(?<![月\\d])(\\d{1,2}|${CN_NUM})\\s*[日号]`)
/** 顺序就是判据:「大后天」要排在「后天」前面(它里头也有「后天」两个字)。 */
const RELATIVE: readonly (readonly [RegExp, number])[] = [
  [/今天|今儿|今日/, 0], [/明天|明儿|明日/, 1], [/大后天/, 3], [/后天/, 2],
]
const WEEKDAY = /(下下|下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/
const WEEKDAY_ORDER = '一二三四五六日'
/** 她在说日子,可是说不清是哪一天 —— 回问一句,不猜(统筹定)。 */
const VAGUE_DAY = /月底|月末|月初|下个?月|这个?月|本月|这周|本周|下周(?![一二三四五六日天])|过几天|回头|年底|最近|找[个一]?时间|有空/

export interface PublishDay {
  /** 本地日期 `YYYY-MM-DD`。认不出就缺席。 */
  day?: string
  /** 原话里那一截(「18 号」「下周三」)。认出「她在说日子」就有。 */
  phrase?: string
  /** 她说了日子,可是说不清是哪一天(「月底」)。 */
  vague?: true
}

/** 这个月里有没有这一天(2 月 30 号没有)。 */
function dayExists(year: number, month: number, day: number): boolean {
  const at = new Date(year, month - 1, day)
  return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day
}

/**
 * 「N 号」= **从工作台的钟算起最近的那个 N 号**(统筹定):本月还没到就本月,
 * 已经过了就下个月;这个月没有这一天(31 号撞上 2 月)就再往后找,最多找一年。
 */
function nearestDayOfMonth(nowMs: number, day: number): string | undefined {
  if (!Number.isInteger(day) || day < 1 || day > 31) return undefined
  const now = new Date(nowMs)
  for (let ahead = 0; ahead <= 12; ahead++) {
    const probe = new Date(now.getFullYear(), now.getMonth() + ahead, 1)
    if (!dayExists(probe.getFullYear(), probe.getMonth() + 1, day)) continue
    if (ahead === 0 && day < now.getDate()) continue
    return localDateStr(new Date(probe.getFullYear(), probe.getMonth(), day).getTime())
  }
  return undefined
}

/** 「M 月 N 日」:直接取;这个月份今年已经过了就算明年。 */
function monthDay(nowMs: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(month) || month < 1 || month > 12) return undefined
  const now = new Date(nowMs)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
    if (!dayExists(year, month, day)) continue
    const at = new Date(year, month - 1, day)
    if (at.getTime() < today.getTime()) continue
    return localDateStr(at.getTime())
  }
  return undefined
}

/** 「周三」= 这个周三(今天就是今天);「下周三」= 下一个自然周的周三。 */
function weekday(nowMs: number, word: string, next: string | undefined): string {
  const now = new Date(nowMs)
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = word === '天' ? 7 : WEEKDAY_ORDER.indexOf(word) + 1
  const todayIso = base.getDay() === 0 ? 7 : base.getDay()
  if (next === undefined) base.setDate(base.getDate() + ((target - todayIso + 7) % 7))
  else base.setDate(base.getDate() + (7 - todayIso + 1) + (target - 1) + (next === '下下' ? 7 : 0))
  return localDateStr(base.getTime())
}

/**
 * 这一句里说的是哪一天。**顺序就是判据**:「M 月 N 日」→ 相对日子 → 周几 → 光秃秃的「N 号」→ 说不清。
 *
 * 「10 月 20 号」里也有一个「20 号」,所以明确的那一条必须先走。
 */
export function parsePublishDay(said: string, nowMs: number): PublishDay {
  const text = said.trim()
  if (text === '') return {}
  const md = MONTH_DAY.exec(text)
  if (md !== null) {
    const day = monthDay(nowMs, cnNumberOf(md[1] ?? ''), cnNumberOf(md[2] ?? ''))
    return { phrase: md[0].trim(), ...(day === undefined ? {} : { day }) }
  }
  for (const [re, ahead] of RELATIVE) {
    const hit = re.exec(text)
    if (hit === null) continue
    const now = new Date(nowMs)
    return { phrase: hit[0], day: localDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead).getTime()) }
  }
  const week = WEEKDAY.exec(text)
  if (week !== null) return { phrase: week[0].trim(), day: weekday(nowMs, week[2] ?? '', week[1]) }
  const bare = BARE_DAY.exec(text)
  if (bare !== null) {
    const day = nearestDayOfMonth(nowMs, cnNumberOf(bare[1] ?? ''))
    return { phrase: bare[0].trim(), ...(day === undefined ? {} : { day }) }
  }
  if (VAGUE_DAY.test(text)) return { vague: true }
  return {}
}

/** `2026-10-18` → 「10 月 18 号」(嘴里念的那一种)。 */
export function spokenDay(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day)
  if (m === null) return day
  return `${Number(m[1])} 月 ${Number(m[2])} 号`
}

// ───────────────────────────── 认话 ─────────────────────────────

/** 她说的是哪一种内容。**用她自己的那个词**进标题,不改写成「视频 / 图文」。 */
const CONTENT_WORDS: readonly (readonly [string, TopicContentType])[] = [
  ['短视频', '视频'], ['小视频', '视频'], ['视频', '视频'], ['短片', '视频'], ['片子', '视频'], ['vlog', '视频'],
  ['图文', '图文'], ['笔记', '图文'], ['文章', '图文'], ['稿子', '图文'], ['帖子', '图文'],
]
/** 发布那一类的说法。光一个「发」不算 —— 要带量词或者是「发布 / 要发」这种。 */
const PUBLISH_CUE = new RegExp(`发布|发表|上线|更新|要发|想发|打算发|准备发|计划发|发\\s*(?:\\d{1,2}|${CN_NUM})?\\s*[个条支篇则张部期]`)
/** 这几句不是在排计划:真发出去、转发、问话。宁可漏认 —— 漏的那一句照旧当一件普通事项。 */
const NOT_A_PLAN = /发到|发给|发过去|发出去|已经发|发完|上传|转发|重发|[?？]\s*$|吗[?？]?\s*$/
/** 她在排计划的信号(没认出日子时靠它;两样都没有就不是排计划)。 */
const PLAN_CUE = /计划|打算|准备|安排|排期|定在|想发|要发/
/** 「关于 / 讲 / 聊」后面那一截最贴近她说的主题。 */
const ABOUT = /(?:关于|有关|讲|聊|说)\s*([^,，。;；、!！]{1,30})$/
/**
 * ★ **主题在后半句**(2026-10-13 下午,场景 4 真机那一句)。
 *
 * 她说的是「呃,我20号计划要发一个视频,是做我们大赛的整个回顾。」—— 「视频」前面只剩
 * 「计划要发一个」,主题整个在后半句。所以认不出主题时往「视频」后面那一截找:
 * 剥掉引子(是做 / 是关于…的 / 讲 / 内容是)剩下的那一截就是她要发的内容。
 *
 * **必须有引子才算**:没有引子的后半句多半不是主题(「20 号发一个视频,到时候提醒我」),
 * 硬认成主题就等于替她编了一条计划 —— 那种宁可回问一句。
 */
const SUBJECT_AFTER = /^[\s,，。.、;；:：]*(?:(?:内容|主题|说的|讲的|做的)\s*是|是?\s*(?:做|搞|拍|关于|有关|讲|聊|说))\s*(.+)$/u
/** 摘出来只剩一个连接词 / 指代词的,不算认出了主题。 */
const NOT_A_SUBJECT = /^(?:关于|有关|这个?|那个?|一个|什么|内容|东西)$/
/** 主题前面那一截「计划 18 号发一个」。贪婪 `.*` 取**最后**那个发布动词。 */
const BEFORE_SUBJECT = new RegExp(`^.*(?:发布|发表|上线|更新|发)\\s*(?:\\d{1,2}|${CN_NUM})?\\s*[个条支篇则张部期]?\\s*`)

export interface PublishPlanSaid {
  /** 她要发的是关于什么(原话里摘出来,不改写)。{@link subjectUnknown} 在时是空的。 */
  subject: string
  /** 她自己用的那个词(「短视频」「笔记」)。 */
  word: string
  /** 卡上那两格里的内容形式。 */
  contentType: TopicContentType
  /** 卡的标题:`<主题>的<她那个词>`。{@link subjectUnknown} 在时是空的。 */
  title: string
  /** 排在哪一天(`YYYY-MM-DD`)。**说不清就缺席** —— 调用方回问一句,不猜。 */
  day?: string
  /**
   * ★ 她在排计划,可是**没说清要发什么**(2026-10-13 下午):「我 20 号要发一个视频」。
   * 调用方照 {@link PUBLISH_PLAN_ASK_SUBJECT} 回问一句,**一张卡都不建、一个主题都不猜**
   * (同「日子说不清」那一档的做法)。
   */
  subjectUnknown?: true
}

/** 没说清哪天时回问的那一句。 */
export const PUBLISH_PLAN_ASK_DAY = '这条打算哪天发?说个日子(「18 号」「10 月 20 日」「下周三」都行),我就记进发布计划。'
/** 没说清要发什么时回问的那一句(2026-10-13 下午;固定流程那一句话 ≤ 25 字)。 */
export const PUBLISH_PLAN_ASK_SUBJECT = '这条是关于什么的?说一句我就记上。'

/**
 * 「计划 18 号发一个关于秋天穿搭的视频」→ 一条发布计划。认不出就 `undefined`(照普通事项走,不硬套)。
 *
 * **故意不认的**:「帮我做一个 XXX 的视频」(那是「出图进可灵」那条接力要的句子,
 * 没有发布动词所以天然不沾)、「把那条视频发到小红书」(真发出去)、问话、没说主题的。
 */
export function publishPlanOf(said: string, nowMs: number): PublishPlanSaid | undefined {
  const text = said.trim()
  if (text === '' || text.length > 200) return undefined
  if (NOT_A_PLAN.test(text)) return undefined
  if (!PUBLISH_CUE.test(text)) return undefined
  const found = CONTENT_WORDS.find(([word]) => text.toLowerCase().includes(word.toLowerCase()))
  if (found === undefined) return undefined
  const [word, contentType] = found
  const when = parsePublishDay(text, nowMs)
  if (when.phrase === undefined && when.vague !== true && !PLAN_CUE.test(text)) return undefined
  const at = text.toLowerCase().indexOf(word.toLowerCase())
  let head = text.slice(0, at).trim().replace(/[的之]$/, '').trim()
  const about = ABOUT.exec(head)
  head = about?.[1] !== undefined ? about[1] : head.replace(BEFORE_SUBJECT, '')
  let subject = cleanSubject(head)
  if (subject === '') {
    // 主题在后半句(「…发一个视频,是做我们大赛的整个回顾」)—— 2026-10-13 下午那一句。
    const after = SUBJECT_AFTER.exec(text.slice(at + word.length))
    subject = cleanSubject(after?.[1] ?? '')
  }
  const day = when.day === undefined ? {} : { day: when.day }
  // 认下来了,可是她没说要发什么:**回问一句**(调用方的事),一个主题都不猜。
  if (subject === '') return { subject: '', word, contentType, title: '', subjectUnknown: true, ...day }
  return { subject, word, contentType, title: `${subject}的${word}`, ...day }
}

/** 摘出来那一截:去掉引号、句末标点与挂在尾巴上的「的」。拿不出主题就回空串。 */
function cleanSubject(raw: string): string {
  const subject = raw
    .replace(/[「」『』"“”]/g, '')
    .replace(/[。.!！?？,，、;；:：\s]+$/u, '')
    .replace(/的$/u, '')
    .trim()
  return [...subject].length < 2 || NOT_A_SUBJECT.test(subject) ? '' : subject
}

// ───────────────────────────── 回话 ─────────────────────────────

/**
 * ★ **模型那条路递来的标题**(2026-10-13 下午,`POST /publish/plan`)。
 *
 * 电话里模型调 `wb_publish_plan` 时填的 `title` 多半只有主题(「大赛回顾」),
 * 而「一句话记发布计划」那条路落的标题是 `<主题>的<内容形式>` —— 两条路要落成**同一种卡**,
 * 所以这里统一补上;她自己已经说成「…的视频 / …的笔记」的不再补第二遍。
 * 拿不出标题(空的 / 只有标点)回空串,由调用方回问一句。
 */
export function publishPlanTitleOf(title: string, contentType: TopicContentType): string {
  const text = (typeof title === 'string' ? title : '')
    .replace(/[「」『』"“”]/g, '')
    .replace(/[。.!！?？,，、;；:：\s]+$/u, '')
    .trim()
  if (text === '') return ''
  return CONTENT_WORDS.some(([word]) => text.toLowerCase().endsWith(word.toLowerCase())) ? text : `${text}的${contentType}`
}

/** 记上之后回的那一句(电话里念的就是它)。 */
export function publishPlanReply(plan: { title: string }, day: string): string {
  return `好,记进发布计划了:${spokenDay(day)},${plan.title}`
}

/** 同一天同一条已经在盘上 —— 不重复记,如实说一句。 */
export function publishPlanAlreadyReply(plan: { title: string }, day: string): string {
  return `${spokenDay(day)}的发布计划里已经有「${plan.title}」了,没重复记。`
}

/** 电话里先确认那一句(`/confirm/points` 的 `spoken`)。 */
export function publishPlanConfirmLine(plan: PublishPlanSaid, day: string): string {
  return `我把它记进发布计划:${spokenDay(day)},${plan.title} —— 对吗?`
}

// ───────────────────────────── 去重 ─────────────────────────────

/** 比标题时不计空白与引号 —— 「秋天穿搭的视频」与「 秋天穿搭的视频 」是同一条。 */
function sameTitle(a: string, b: string): boolean {
  const flat = (one: string): string => one.replace(/[\s「」『』"“”]/g, '')
  return flat(a) === flat(b)
}

/**
 * 这一天的发布计划里已经有这一条了吗(2026-10-13:同一天同一条重复说不重复记)。
 * 取消掉的那张不算 —— 它已经不是一条计划了(同 `publishDayOf` 的老规矩)。
 */
export function samePublishPlanOn(tasks: readonly TaskView[], day: string, title: string): TaskView | undefined {
  return tasks.find(one => one.status !== 'canceled'
    && (one.planned_at ?? '').slice(0, 10) === day
    && sameTitle(one.title, title))
}
