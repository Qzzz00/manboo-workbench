/**
 * 他的规矩:一处存、处处读(2026-09-24 晚,卡 K;docs/设计-全局自进化-2026-09-24.md)。
 *
 * 维护者原话:「这些其实你都得写进事务官那边,不然以后我还得调教他一遍」;
 * 「……还分模版,这玩意不应该是全局的机制吗」;「重要的是机制真的生效了」。
 *
 * 以前的样子(设计第一节有证据):自进化只接在运营模板选题卡的「改一改」上;他在电话里、打字时、
 * 验收打回时说的规矩没有一个地方收;统筹手抄进「观察」的 11 条,电话、派活、验收三处读不到。
 *
 * 这个文件做四件事,都是**死算法、不经模型**:
 *
 *   ① **一张表**  `~/.dsh/workbench/rules.json`(只由工作台写)。明说的(`active`)当场生效;
 *                没明说、但在 ≥2 件不同的活上打回过同一处的记成「试用」(`trial`),下一件他通过就保留
 *                (`kept`),又打回同一处就撤(`reverted`)—— 判据与 evolve.ts 偏好那一截**同一份**
 *                (`findPreferences` / `verifyPreference` 原样复用,「选题」换成「哪件活」)。
 *   ② **四个时刻的那几段字**  AGENTS.md 标记段(每条新 DSH 会话第一次请求就带着)、电话人设里那一段、
 *                派活指令末尾那一段、验收时的清单 —— 全从这一张表拼。
 *   ③ **按规矩自查**  交回来的活里能机器查的机器查(蓝色、电话超两句、`**` 与路径),其余列成「要亲眼看的」。
 *                没过就给一句打回给那家的原话,这件事不进「等我确认」(合格才叫他)。
 *   ④ **从「观察」导入**  统筹写在 `用户-*.md`「观察」里的那几条(①…⑪ 各一条 + 加粗的总纲)一次导进表。
 *                2026-10-09(卡「学风格」)起 `/butler/rules/import` **不再走这里**:观察改走风格候选那一道
 *                (`habits.learnObservations` → 不同两件事上出现才试用);`importObservations` 只留给用例与统筹手工补种。
 *
 * 三条纪律:
 * - **只收他本人的话**:入口只有他明说规矩的那几格、打回原因、设置里改的。事项台账、通话纪要、
 *   引导出处说明一个字都不读(那是卡 A 修的误报的来路)。她自己验收的判断也不算他的反馈。
 * - **写家目录的路径全是注入的**(2026-09-04 事故纪律):表文件、AGENTS.md 都由调用方给,用例用临时目录。
 * - 表坏了 / 没有 = 一条都没有,**不抛**(一份读不懂的 json 不该让工作台起不来)。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ButlerRuleArea, ButlerRuleChannel, ButlerRuleEvidence, ButlerRuleReviewView, ButlerRuleStatus, ButlerRuleView,
  ButlerRuleViolation, ButlerRulesView,
} from '../protocol.ts'
import type { JobKind } from '../protocol.ts'
import { BUTLER_RULE_AREA_TITLES, BUTLER_RULE_CHANNELS, isButlerRuleArea } from '../protocol.ts'
import { echoedLine } from './dispatchReply.ts'
import { defaultUserLayerPrefsDir } from './userLayer.ts'
import { habitLive, sanitizeHabit, type StoredHabit } from './habits.ts'
import { STYLE_ID_PREFIX, sanitizeStyleState, type StyleState } from './styleHabits.ts'
import {
  OVERLAP_MIN, findPreferences, keywordsOf, normalizeSay, overlap, verifyPreference,
  type EvolvePreference, type EvolveReviewSay,
} from './evolve.ts'

// ───────────────────────────── 常量 ─────────────────────────────

/** 一条规矩最长多少字。再长就不是一条规矩,是一篇说明 —— 进 AGENTS.md 与电话里都会稀释别的。 */
export const RULE_MAX_CHARS = 240
/** 短名最长多少字(电话里列举时一条一个短名)。 */
export const RULE_TITLE_MAX = 16
/** 反馈留多少条(先进先出)。重复判据只看近 30 天(`PREF_WINDOW_DAYS`),四百条足够。 */
export const RULE_EVENTS_MAX = 400
/** 自查记录留多少件活。 */
export const RULE_REVIEWS_MAX = 200
/** 电话人设里「其余几条」最多列几个短名。 */
export const CALL_INDEX_MAX = 12
/** 自查时读一个文件最多读多少字节(大文件只看头上这一截)。 */
export const REVIEW_FILE_MAX_BYTES = 200_000
/** AGENTS.md 里这一段的标记名(`<!-- 引导:规矩:开始 -->`)。 */
export const RULES_BLOCK = '规矩'

// ───────────────────────────── 纯函数:归类、短名、明说 ─────────────────────────────

/**
 * 各块的字眼。**数命中几个,多的那块赢**;一样多按这张表的先后(全局 → 验收 → 说话 → 界面 → 内容)。
 * 一个都没命中 = 全局(宁可处处带着,也不漏在该用的时刻)。
 */
const AREA_WORDS: readonly (readonly [ButlerRuleArea, readonly string[]])[] = [
  ['all', ['全局', '不分模板', '不分渠道', '处处', '所有地方', '任何地方', '构建', '测试']],
  ['review', ['验收', '打回', '验一遍', '看一遍', '做完了', '测过', '真机', '真数据', '真壳', '截图', '线索', '合格']],
  ['say', ['电话', '通话', '每轮', '一句', '两句', '念', '口吻', '语气', '说话', '称呼', '叫我', '回话', '重复']],
  ['ui', [
    '蓝', '颜色', '配色', '深色', '浅色', '卡片', '边框', '框', '按钮', '界面', '页面', '首页', '光效', '光团', '粒子', '球',
    '输入框', '窗口', '布局', '图标', '字号', '字体', '动效', '横屏', '竖屏', '显示器', '座机页', '设置页', '项目区', '额度',
    '窗口槽', '莫比乌斯', 'ui',
  ]],
  ['content', ['标题', '文案', '开头', '选题', '封面', '正文', '口播', '小红书', '笔记', '段落', '结尾']],
]

/** 一条规矩归哪一块。 */
export function ruleAreaOf(text: string): ButlerRuleArea {
  const lower = text.toLowerCase()
  let best: { area: ButlerRuleArea, hits: number } | undefined
  for (const [area, words] of AREA_WORDS) {
    let hits = 0
    for (const word of words) if (lower.includes(word)) hits += 1
    if (hits === 0) continue
    if (best === undefined || hits > best.hits) best = { area, hits }
  }
  return best?.area ?? 'all'
}

/** 界面活的字眼(派活、验收时判「这件活是不是做界面的」)。 */
const UI_WORK_WORDS = [
  '界面', '页面', '网页', '首页', '设置页', '登录页', '落地页', '按钮', '样式', '颜色', '配色', '前端', 'ui', 'css', 'html',
  '布局', '图标', '动效', '光效', '粒子', '卡片', '输入框', '弹窗', '窗口', '小组件', '组件', '视觉', '主题', '深色', '截图',
]
/** 内容活的字眼。 */
const CONTENT_WORK_WORDS = ['文案', '标题', '选题', '小红书', '封面', '口播', '脚本', '正文', '笔记', '推文', '文章']

/** 一件活沾哪几块(除了全局)。**不经模型**:按字眼。 */
export function workAreasOf(text: string): ButlerRuleArea[] {
  const lower = text.toLowerCase()
  const out: ButlerRuleArea[] = []
  if (UI_WORK_WORDS.some(word => lower.includes(word))) out.push('ui')
  if (CONTENT_WORK_WORDS.some(word => lower.includes(word))) out.push('content')
  return out
}

/** 短名:第一个停顿之前那一截(破折号、冒号、逗号、分号、括号、句号),最长 16 字。 */
export function ruleTitleOf(text: string): string {
  const cut = text.split(/——|—|:|：|,|，|;|；|\(|（|。|!|！/u)[0] ?? text
  // 切出来太短(「光效(卡片、输入框…」只剩「光效」)就退回整句的头上那一截。
  const head = [...cut.trim()].length < 3 ? text.trim() : cut.trim()
  return [...head].length > RULE_TITLE_MAX ? `${[...head].slice(0, RULE_TITLE_MAX).join('')}…` : head
}

/** 规矩原文 → 进表前的样子:去首尾空白、压空白、去掉开头的序号与项目符号。 */
export function cleanRuleText(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*•]\s*/u, '')
    .replace(/^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*/u, '')
    .replace(/^\d+[.、)）]\s*/u, '')
    .replace(/[;；,，、]+$/u, '')
    .trim()
}

/**
 * 一条规矩的稳定 id:`rule:<归一化文本>`。**由文本拼**,不是随机数 —— 同一句话从电话里、从输入框里
 * 各来一次,要认成同一条(只多一条依据,不多一条规矩)。
 */
export function ruleId(text: string): string {
  return `rule:${normalizeSay(text).replace(/ /g, '-').slice(0, 80)}`
}

/**
 * 他这一句是不是**明说了一条以后都算数的规矩**。是就回那一句(原话),不是回 undefined。
 *
 * 判据只认字面上的「以后 / 今后 / 每次 / 一律 / 永远 / 别再 / 不要再 / 记住」,并且后面得跟着
 * 一个要求(要 / 不要 / 别 / 不许 / 必须 / 得 / 都 / 用 / 改成)——「以后再说」「以后有空看看」不算。
 * **宁可漏认不可错认**:漏认的那一句还在她的会话里,AGENTS.md 规矩段叫她自己记;
 * 错认的下场是把一句随口话当成永久规矩摆进每一条会话。
 * 「以后都这样」这种离了上下文就没意思的,也不在这里认(交给会话里的她,她知道「这样」是哪样)。
 */
export function explicitRuleOf(text: string): string | undefined {
  const sentences = text.split(/[。!?！？\n;；]+/u).map(one => one.trim()).filter(one => one !== '')
  for (const sentence of sentences) {
    const hit = /(以后|今后|往后|从现在起|从今天起|每次|每一次|一律|永远|别再|不要再|不许再|再也别|再也不要|记住)/u.exec(sentence)
    if (hit === null) continue
    // 问句不是规矩(「以后都要这样吗」);「我每次都得自己去找」「我以后要去北京」说的是他自己,不是给她的要求。
    if (/[吗呢么嘛]$/u.test(sentence)) continue
    if (/我\s*$/u.test(sentence.slice(Math.max(0, hit.index - 2), hit.index))) continue
    const after = sentence.slice(hit.index + hit[0].length)
    // 「别再 / 不要再 / 不许再 / 再也别 / 永远」本身就是要求;其余要看后面跟没跟一个要求。
    const selfDemanding = /^(别再|不要再|不许再|再也别|再也不要)$/u.test(hit[0])
      || (hit[0] === '永远' && /^(不要|别|不许|都|要)/u.test(after))
      // 「记住,…」「记住:…」是在立规矩;「记住这个文件在哪」是要她记一件事,不算。
      || (hit[0] === '记住' && /^[,\uFF0C:\uFF1A\s]/u.test(after))
    const demanding = selfDemanding || /(不要|别|不许|不能|不用|不必|必须|得|都要|都不|都用|都是|一律|要先|要用|用|改成|换成|先|直接)/u.test(after)
    if (!demanding) continue
    if (/^(以后|今后|往后)(再说|有空|看看|再看|再聊|再讲)/u.test(sentence.slice(hit.index))) continue
    // 离了上下文就没意思的(「以后都这样」「以后就这么办」)。
    const bare = sentence.replace(/(以后|今后|往后|每次|都|就|也|这样|这么办|这么做|照这个|按这个|来|吧|啊|哈|了|[,，、\s])/gu, '')
    if ([...bare].length < 3) continue
    const cleaned = cleanRuleText(sentence)
    if (cleaned === '' || [...cleaned].length > RULE_MAX_CHARS) continue
    return cleaned
  }
  return undefined
}

/**
 * 系统写的字的样子(通话纪要、引导出处说明、工作台拼的第一句)。**进表前再挡一道**:
 * 入口本来就只收他本人那几格,这一道防的是调用方传错字段。
 */
export function looksSystemWritten(text: string): boolean {
  return /^(时长[:：]|引导\s*[①②③④⑤⑥⑦⑧⑨⑩′″]|和事务官通了)/u.test(text.trim())
    || /(工作台事项 [a-z0-9-]+)|(工作台开工汇报|下班例程 \d{4})/u.test(text)
}

// ───────────────────────────── 纯函数:从「观察」导入 ─────────────────────────────

export interface ImportedRule {
  text: string
  /** 依据(那一条观察的「依据:」那一截,没有就是整条的日期)。 */
  why: string
  at: string
}

/**
 * `用户-*.md`「观察」一节 → 规矩。**只认两种写死的形状**(统筹 09-24 晚写的就是这两种):
 *
 * 1. 加粗标题后面跟着 ①…⑳ 一串:每一项一条规矩(「**他的验收标准**:① …;② …」);
 * 2. 加粗标题后面是一段话:整条是一条规矩,短名就是加粗那几个字(「**他说过一次的规矩全局生效**:不分模板…」)。
 *
 * 没有加粗的观察(「他喜欢听播客」这类)不是规矩,不导。
 */
export function rulesFromObservations(markdown: string): ImportedRule[] {
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => /^##\s*观察/u.test(line))
  if (start === -1) return []
  let end = lines.findIndex((line, index) => index > start && /^##\s/u.test(line))
  if (end === -1) end = lines.length
  const out: ImportedRule[] = []
  for (const line of lines.slice(start + 1, end)) {
    if (!/^\s*[-*]\s/u.test(line)) continue
    const bold = /\*\*(.+?)\*\*[:：]?\s*(.*)$/u.exec(line)
    if (bold === null) continue
    const head = (bold[1] ?? '').trim()
    const body = (bold[2] ?? '').trim()
    const date = /(\d{4}-\d{2}-\d{2})/u.exec(line)?.[1] ?? ''
    const why = (/依据[:：]\s*([^·]+)/u.exec(line)?.[1] ?? head).trim()
    const at = date === '' ? new Date(0).toISOString() : `${date}T12:00:00.000Z`
    if (/[①②③④⑤⑥⑦⑧⑨⑩]/u.test(body)) {
      for (const piece of body.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])/u)) {
        const text = cleanRuleText(piece.replace(/[。.]$/u, ''))
        if (text === '' || !/^[^①-⑳]/u.test(text)) continue
        out.push({ text: clipRule(text), why, at })
      }
      continue
    }
    const joiner = /^[(（]/u.test(body) ? '' : ':'
    const text = cleanRuleText(`${head}${body === '' ? '' : `${joiner}${body.replace(/[。.]$/u, '')}`}`)
    if (text !== '') out.push({ text: clipRule(text), why, at })
  }
  return out
}

function clipRule(text: string): string {
  const chars = [...text]
  return chars.length > RULE_MAX_CHARS ? `${chars.slice(0, RULE_MAX_CHARS - 1).join('')}…` : text
}

// ───────────────────────────── 纯函数:四个时刻的那几段字 ─────────────────────────────

/** 表里一条(落盘那一份)。 */
export interface StoredRule {
  id: string
  text: string
  title?: string
  area: ButlerRuleArea
  status: ButlerRuleStatus
  origin: ButlerRuleView['origin']
  evidence: ButlerRuleEvidence[]
  created_at: string
  updated_at: string
  /** 试用的起点(ISO)。验证只看这之后的派活。 */
  adopted_at?: string
  verdict?: string
}

/** 算数的那几种状态。 */
export function ruleCounts(rule: Pick<StoredRule, 'status'>): boolean {
  return rule.status === 'active' || rule.status === 'trial' || rule.status === 'kept'
}

function tag(area: ButlerRuleArea): string {
  return `〔${BUTLER_RULE_AREA_TITLES[area]}〕`
}

function trialMark(rule: Pick<StoredRule, 'status'>): string {
  return rule.status === 'trial' ? '(试用中)' : ''
}

/**
 * 排序:生效的在前,再按块(全局、说话、界面、验收、内容),同块内**按表序**(存进表里的先后,
 * 设置里「上移 / 下移」挪的就是这个;2026-10-23 起不再按记下的时刻重排 —— 那会把刚挪过的又摆回去)。
 * 排序是稳定的:同块同状态的顺序 = 传进来的顺序(= `state.rules` 的落盘顺序),而派活分工等匹配
 * 读的就是这一份(`counting()`),所以**表序就是匹配序**。
 */
function ordered<T extends Pick<StoredRule, 'status' | 'area'>>(rules: readonly T[]): T[] {
  const rank: Record<ButlerRuleArea, number> = { all: 0, say: 1, ui: 2, review: 3, content: 4 }
  return [...rules].sort((a, b) => {
    const sa = a.status === 'trial' ? 1 : 0
    const sb = b.status === 'trial' ? 1 : 0
    return (sa - sb) || (rank[a.area] - rank[b.area])
  })
}

/**
 * 有些规矩在这台机器上有**固定做法**,附在规矩后面一起带上(不是他的原话,是照他那条规矩落地的口径)。
 *
 * - 「电话不能被电脑上的构建、测试、派出去的活挤卡」(他的第 ⑩ 条):统筹 09-24 晚定的口径 ——
 *   构建 / 测试一律前缀 `taskpolicy -c utility`(`nice` 在这台 Mac 上不让 CPU,卡 D 实测),一次只跑一个;
 *   通话护栏在卡 D(`fix/call-under-load-and-name` 的 loadGuard)。
 */
export function ruleHow(text: string): string | undefined {
  if (/(构建|测试)/u.test(text) && /(挤卡|卡住|卡顿|挤掉)/u.test(text)) {
    return '做法:在这台 Mac 上跑构建、测试一律前缀 `taskpolicy -c utility`(别用 nice),一次只跑一个'
  }
  return undefined
}

function withHow(text: string): string {
  const how = ruleHow(text)
  return how === undefined ? text : `${text}(${how})`
}

/** AGENTS.md 的 API 地址(事务官的会话就在这台机器上,走回环)。 */
export const RULES_API = 'http://127.0.0.1:8791'

/**
 * `~/.dsh/AGENTS.md` 里「规矩」那一段的正文。**每条新会话第一次请求就带着**(DSH agent-instructions),
 * 所以她不用翻文件就知道;后半截「怎么用」把四个时刻写死,她照着做。
 * 一条都没有时回 undefined(调用方据此把整段摘掉,不留一个空段)。
 */
export function agentsRulesBlock(rules: readonly StoredRule[]): string | undefined {
  const counting = ordered(rules.filter(ruleCounts))
  if (counting.length === 0) return undefined
  const isStyle = (rule: StoredRule): boolean => rule.id.startsWith(STYLE_ID_PREFIX)
  const firm = counting.filter(rule => rule.status !== 'trial')
  const trial = counting.filter(rule => rule.status === 'trial' && !isStyle(rule))
  const styleTrial = counting.filter(rule => rule.status === 'trial' && isStyle(rule))
  return [
    '## 他的规矩(处处照做)',
    '',
    '> 工作台按「记住的规矩」那张表写的(电脑与手机的设置里都能看、能删改),不要手改这一段。',
    '> 他说过一次就全局生效:不分模板、不分渠道。办事、说话、派活、验收、摆界面时照做,不用他再交代;他问「我的规矩有哪些」,照这里直接答,不用翻文件,也不列确认点(确认点只在要派活、动他的文件时才问)。',
    '',
    ...firm.map(rule => `- ${tag(rule.area)}${withHow(rule.text)}`),
    ...(trial.length === 0 ? [] : [
      '',
      '试用中(他在不止一件活上打回过同一处,先照做;下一件他通过就留下,又打回就撤):',
      ...trial.map(rule => `- ${tag(rule.area)}${withHow(rule.text)}`),
    ]),
    ...(styleTrial.length === 0 ? [] : [
      '',
      '试用中的说话做事风格(他在不止一件事上说过或改过同一处,先照做;下一次交付他没再这么说就留下,又说了就撤):',
      ...styleTrial.map(rule => `- ${tag(rule.area)}${rule.text}`),
    ]),
    '',
    '### 什么时候用、怎么用',
    '',
    '1. **回他的话、打电话**:先对一遍〔说话〕〔全局〕那几条。',
    `2. **派活给别家 Agent**:指令末尾附「这件活要守的规矩」。走窗口、接口那两只手时工作台自己附;命令行那只手你自己附 ——`,
    `   \`curl -s '${RULES_API}/butler/rules/brief?for=dispatch&item=<事项 id>'\` 回来的 \`text\` 原样贴在 prompt 末尾。`,
    `3. **收回结果**:先按规矩自己看一遍 —— 报 \`POST ${RULES_API}/butler/item/dispatch\`(\`status:"done"\`)时带上 \`result\`(交回来的原文)和 \`files\`(改过的文件,相对 cwd),工作台会自查;`,
    '   回包里 `review.pass` 是 false,就把 `review.reject_text` 原样发回给那家让它改,改好再报,**这时别叫他**;过了才叫他验收,带截图。',
    '4. **摆界面、做小组件、改布局**:先对一遍〔界面〕那几条。',
    `5. **他说了新规矩**(「以后都…」「不要…」「别再…」)→ \`curl -s -X POST ${RULES_API}/butler/rules -H 'content-type: application/json' -d '{"text":"<他的原话>","channel":"butler"}'\`,回他一句「记下了:…」;`,
    `   他对交回来的东西不满意、打回 → \`POST ${RULES_API}/butler/rules/feedback\` \`{"kind":"revise","where":"<事项 id>","text":"<他的原话>"}\`。`,
  ].join('\n')
}

/**
 * 电话人设里那一段。**说话与全局那几条全文**(它们管她这一通怎么说),其余只列短名 ——
 * 电话提示词长了会稀释「每轮两句」,但他问「我的规矩有哪些」她得说得出来。
 */
export function callRulesBlock(rules: readonly StoredRule[]): string | undefined {
  const counting = ordered(rules.filter(ruleCounts))
  if (counting.length === 0) return undefined
  const full = counting.filter(rule => rule.area === 'say' || rule.area === 'all')
  const rest = counting.filter(rule => rule.area !== 'say' && rule.area !== 'all')
  const titles = rest.slice(0, CALL_INDEX_MAX).map(rule => rule.title ?? ruleTitleOf(rule.text))
  return [
    '【他立的规矩(处处算数;他问起你要说得出来,一次说两三条就停)】',
    ...full.map(rule => `- ${rule.text}${trialMark(rule)}`),
    ...(titles.length === 0 ? [] : [`- 办事、派活、验收时还要照做的:${titles.join('、')}${rest.length > titles.length ? ' 等' : ''}`]),
  ].join('\n')
}

/**
 * 送给别家 Agent 的字**不带 markdown 记号**(2026-09-25,卡 fix/reply-anchor)。
 *
 * 他那条「不露内部的东西(`**` 这类符号…)」原样送进 Codex,Codex 把我们的话当 markdown 画,
 * 反引号里的 `**` 被拆成一行一个「*」(0.2.96 真机 t-a7a07e82)—— 读回答时认不出那是我们自己的话。
 * 只改**送出去的那一份**,规矩表里他的原话一个字不动:反引号里的星号说成「星号」,
 * 裸的 `**` 也说成「星号」,别的行内代码去掉反引号(`taskpolicy -c utility` → taskpolicy -c utility)。
 */
export function plainForAgent(text: string): string {
  return text
    .replace(/`\s*\*+\s*`\s*/gu, '星号')
    .replace(/`([^`\n]+)`/gu, '$1')
    .replace(/\*\*/gu, '星号')
    .replace(/`/gu, '')
}

/**
 * 派活指令末尾那一段:全局 + 这件活沾的那几块(做界面的带界面那几条)。说话、验收那几条不带。
 *
 * ★ 2026-09-27(卡 MS):**聊天 / 问答 / 捎话那一类不带全局那一批**。
 *
 * 21:23 那一通「找豆包,让他把这几天我跟他聊的内容总结一下」,发给豆包的正文里附了一整段他的规矩:
 * 派活分工写着 Claude / Codex / Kimi、构建用 `taskpolicy`、设计上警惕打补丁…… 与这件活一点关系都没有,
 * 还把内部口径发到了一家外面的 AI 那里。维护者:「附规矩只附与这件活相关的」。
 *
 * 判据:`kind === 'chat'` 时**只留这件活真沾到的那几块**(界面 / 内容),全局那一批一条不留;
 * 一条都不沾就整段不附。写代码那一类一个字没改(全局那批正是给它的)。
 */
export function dispatchRulesBlock(
  rules: readonly StoredRule[],
  taskText: string,
  opts?: { kind?: JobKind | undefined },
): { text: string, ids: string[] } | undefined {
  // 「要在电脑上动手」那一类(2026-10-02,卡 AG)照聊天那一档:只附这件活真沾到的那几块规矩。
  const areas = opts?.kind === 'chat' || opts?.kind === 'desk'
    ? new Set<ButlerRuleArea>(workAreasOf(taskText))
    : new Set<ButlerRuleArea>(['all', ...workAreasOf(taskText)])
  const picked = ordered(rules.filter(rule => ruleCounts(rule) && areas.has(rule.area)))
  if (picked.length === 0) return undefined
  return {
    text: [
      '【他的规矩:这件活要守的(工作台按他说过的话附上;交回来会先按这些验,不合格会打回)】',
      ...picked.map(rule => `- ${plainForAgent(withHow(rule.text))}`),
    ].join('\n'),
    ids: picked.map(rule => rule.id),
  }
}

/** 派活原文 + 规矩那一段。**已经附过就不再附**(同一段话被转两手时不叠两遍)。 */
export function withDispatchRules(text: string, block: string | undefined): string {
  if (block === undefined || block.trim() === '') return text
  const head = block.split('\n')[0] ?? ''
  if (head !== '' && text.includes(head)) return text
  return `${text.trimEnd()}\n\n${block}`
}

/** 验收时要对的那几条:全局 + 验收 + 这件活沾的那几块(+ 调用方点名的,比如念出来的话要对「说话」那几条)。 */
export function reviewRules(rules: readonly StoredRule[], taskText: string, extra: readonly ButlerRuleArea[] = []): StoredRule[] {
  const areas = new Set<ButlerRuleArea>(['all', 'review', ...workAreasOf(taskText), ...extra])
  return ordered(rules.filter(rule => ruleCounts(rule) && areas.has(rule.area)))
}

// ───────────────────────────── 纯函数:能机器查的那几条 ─────────────────────────────

/** 一个文件(或一段回话)的全文。`path` 是相对路径,只用来报在哪。 */
export interface ReviewFile {
  path: string
  text: string
}

/** 十六进制色 → 色相 / 饱和度 / 亮度(0–360 / 0–1 / 0–1)。认不出回 undefined。 */
export function hslOfHex(hex: string): { h: number, s: number, l: number } | undefined {
  const raw = hex.replace(/^#/u, '')
  let r: number, g: number, b: number
  if (/^[\da-f]{3,4}$/iu.test(raw)) {
    r = Number.parseInt(`${raw[0]}${raw[0]}`, 16); g = Number.parseInt(`${raw[1]}${raw[1]}`, 16); b = Number.parseInt(`${raw[2]}${raw[2]}`, 16)
  }
  else if (/^[\da-f]{6}([\da-f]{2})?$/iu.test(raw)) {
    r = Number.parseInt(raw.slice(0, 2), 16); g = Number.parseInt(raw.slice(2, 4), 16); b = Number.parseInt(raw.slice(4, 6), 16)
  }
  else return undefined
  return hslOfRgb(r, g, b)
}

export function hslOfRgb(r: number, g: number, b: number): { h: number, s: number, l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/** 算不算「蓝」:色相 190°–260°、有颜色(饱和度 ≥ 0.3)、不是近黑近白。 */
export function isBlue(hsl: { h: number, s: number, l: number }): boolean {
  return hsl.h >= 190 && hsl.h <= 260 && hsl.s >= 0.3 && hsl.l >= 0.12 && hsl.l <= 0.9
}

const BLUE_NAMES = [
  'blue', 'navy', 'royalblue', 'dodgerblue', 'deepskyblue', 'steelblue', 'cornflowerblue', 'skyblue', 'lightskyblue',
  'mediumblue', 'darkblue', 'midnightblue', 'slateblue', 'mediumslateblue', 'lightblue', 'powderblue',
]

/** 一处蓝。 */
export interface BlueHit {
  path: string
  line: number
  what: string
}

/**
 * 找蓝色:十六进制、`rgb()`、`hsl()`、CSS 颜色名、Tailwind 的 `*-blue-* / *-sky-* / *-indigo-*`。
 * **只报前几处**(够她打回时说清在哪,不把整份文件念一遍)。
 */
export function findBlue(files: readonly ReviewFile[], limit = 3): BlueHit[] {
  const hits: BlueHit[] = []
  const nameRe = new RegExp(`(?<![\\w-])(${BLUE_NAMES.join('|')})(?![\\w-])`, 'iu')
  for (const file of files) {
    const lines = file.text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      let what: string | undefined
      for (const match of line.matchAll(/#([\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})(?![\da-z])/giu)) {
        const hsl = hslOfHex(match[0])
        if (hsl !== undefined && isBlue(hsl)) { what = match[0]; break }
      }
      if (what === undefined) {
        const rgb = /rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/iu.exec(line)
        if (rgb !== null && isBlue(hslOfRgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3])))) what = rgb[0]
      }
      if (what === undefined) {
        const hsl = /hsla?\(\s*(\d{1,3})(?:deg)?[\s,]+(\d{1,3})%[\s,]+(\d{1,3})%/iu.exec(line)
        if (hsl !== null && isBlue({ h: Number(hsl[1]), s: Number(hsl[2]) / 100, l: Number(hsl[3]) / 100 })) what = hsl[0]
      }
      if (what === undefined) {
        const tw = /(?<![\w-])(?:bg|text|border|from|to|via|ring|fill|stroke|outline|decoration|accent|caret|shadow)-(?:blue|sky|indigo)-\d{2,3}/u.exec(line)
        if (tw !== null) what = tw[0]
      }
      // 颜色名只在像 CSS / 样式的行里认(「blue」这个词在正文里出现不算)。
      if (what === undefined && /(color|background|border|fill|stroke|outline|shadow)\s*[:=]/iu.test(line)) {
        const named = nameRe.exec(line)
        if (named !== null) what = named[0]
      }
      if (what !== undefined) {
        hits.push({ path: file.path, line: index + 1, what })
        if (hits.length >= limit) return hits
      }
    }
  }
  return hits
}

/** 一段要念出来的话有几句(按句末标点数;没有句末标点的算一句)。 */
export function sentenceCount(text: string): number {
  const parts = text.split(/[。!?！？…]+/u).map(one => one.trim()).filter(one => one !== '')
  return parts.length
}

/** 回他的话里露出来的内部东西(`**`、绝对路径、家目录路径)。只查**给他看 / 念给他听**的那段字,不查代码。 */
export function findLeaks(text: string): string[] {
  const out: string[] = []
  if (text.includes('**')) out.push('有 `**` 符号')
  const path = /(\/Users\/[^\s,，。)）]+|~\/[^\s,，。)）]+)/u.exec(text)
  if (path !== null) out.push(`有文件路径 ${path[0]}`)
  return out
}

/** 这条规矩是在**禁**蓝(「不要蓝」「别用蓝色」「去掉蓝」),不是在要蓝。 */
export function forbidsBlue(ruleText: string): boolean {
  return /(不要|别|不许|禁止|不用|去掉|去|没有|不能|不准)[^,，;；。]{0,4}蓝/u.test(ruleText)
}

/** 这条规矩限了「一轮最多两句」。 */
export function limitsSentences(ruleText: string): boolean {
  return /(不超过|最多|至多|两句以内|≤\s*2)\s*(两|2)?\s*句/u.test(ruleText) || /两句以内/u.test(ruleText)
}

const CN_DIGITS: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }

/**
 * 电话每轮最多几句 —— 从算数的规矩里认(「电话每轮不超过两句」→ 2)。**机器执行那一半**:
 * 工人在流上掐(channel-worker/src/sentenceCap.ts)。没有这样一条就回 undefined(不掐)。
 * 只认「说话」「全局」两块里的;几条都限的取最严的。
 */
export function sayLimitOf(rules: readonly StoredRule[]): number | undefined {
  let best: number | undefined
  for (const rule of rules) {
    if (!ruleCounts(rule) || (rule.area !== 'say' && rule.area !== 'all')) continue
    const hit = /(?:不超过|最多|至多|不多于)\s*([一两二三四五1-5])\s*句/u.exec(rule.text) ?? /([一两二三四五1-5])\s*句以内/u.exec(rule.text)
    const n = hit === null ? undefined : CN_DIGITS[hit[1] as string]
    if (n !== undefined && (best === undefined || n < best)) best = n
  }
  return best
}

/** 这条规矩不许露内部的东西(`**`、路径)。 */
export function forbidsLeaks(ruleText: string): boolean {
  return /(不露|不许露|别露|不要露|不念路径|不要念路径)/u.test(ruleText) || (ruleText.includes('**') && /不/u.test(ruleText))
}

/** 这几个后缀的文件是界面(自查时按界面的活对规矩)。 */
const UI_FILE_RE = /\.(html?|css|scss|less|tsx|jsx|vue|svg)$/iu

export interface RuleReviewInput {
  /** 交回来的那段话(回复原文 / 结果摘要)。 */
  text?: string
  /** 改过的文件(全文)。 */
  files?: readonly ReviewFile[]
  /** 这件活原来是什么(判它沾哪几块)。 */
  taskText?: string
  /** 这段话是要念给他听的(电话)—— 才查「每轮不超过两句」。 */
  spoken?: boolean
  /** 交活的是哪家(打回原话里称呼它)。 */
  family?: string
  /**
   * 派活时我们在他原话之外加的那些字(交代那一句、「他的规矩」那一段)。**给了才查**
   * 「回答里夹着我们自己的指令」(2026-09-25):交回来的话里抄着它们 = 不合格。
   */
  instruction?: string
  at: string
}

/** 「回答里夹着我们自己的指令」那一条(不在规矩表里,是自查本身的一条;id 固定)。 */
export const ECHO_RULE_ID = 'echo-instruction'
export const ECHO_RULE_TITLE = '回答里夹着我们自己的指令'

/**
 * 按规矩自查一件交回来的活。**能机器查的机器查**(蓝色、念出来超两句、露路径与 `**`、
 * 回答里抄着我们派活时附的交代与规矩),其余那几条列成「要亲眼看的」(短名)—— 不假装全查过了。
 */
export function reviewAgainstRules(rules: readonly StoredRule[], input: RuleReviewInput): ButlerRuleReviewView {
  const uiFiles = (input.files ?? []).some(file => UI_FILE_RE.test(file.path))
  const applicable = reviewRules(rules, [input.taskText ?? '', input.text ?? '', uiFiles ? '界面' : ''].join('\n'), input.spoken === true ? ['say'] : [])
  const files: ReviewFile[] = [...(input.files ?? []), ...(input.text === undefined || input.text === '' ? [] : [{ path: '交回来的话', text: input.text }])]
  const violations: ButlerRuleViolation[] = []
  const byEye: string[] = []
  const checked: string[] = []
  for (const rule of applicable) {
    let machine = false
    if (forbidsBlue(rule.text)) {
      machine = true
      const hits = findBlue(files)
      if (hits.length > 0) {
        violations.push({
          rule_id: rule.id,
          rule: rule.title ?? ruleTitleOf(rule.text),
          why: hits.map(hit => `${hit.path} 第 ${hit.line} 行 ${hit.what} 是蓝色`).join(';'),
        })
      }
    }
    if (input.spoken === true && limitsSentences(rule.text) && input.text !== undefined) {
      machine = true
      const n = sentenceCount(input.text)
      if (n > 2) violations.push({ rule_id: rule.id, rule: rule.title ?? ruleTitleOf(rule.text), why: `这一轮说了 ${n} 句` })
    }
    if (input.spoken === true && forbidsLeaks(rule.text) && input.text !== undefined) {
      machine = true
      const leaks = findLeaks(input.text)
      if (leaks.length > 0) violations.push({ rule_id: rule.id, rule: rule.title ?? ruleTitleOf(rule.text), why: leaks.join(';') })
    }
    checked.push(rule.id)
    if (!machine) byEye.push(rule.title ?? ruleTitleOf(rule.text))
  }
  // 交回来的话里抄着我们自己的指令(2026-09-25,0.2.96 真机 Codex 那一单):不是它答的,不能当结果交给他。
  if (input.instruction !== undefined && input.instruction.trim() !== '' && input.text !== undefined && input.text !== '') {
    const echoed = echoedLine(input.text, input.instruction)
    if (echoed !== undefined) {
      violations.push({
        rule_id: ECHO_RULE_ID,
        rule: ECHO_RULE_TITLE,
        why: `回答里有这一句「${plainForAgent(echoed)}」,那是我们派活时附的交代,只交结果、别复述它`,
      })
    }
    checked.push(ECHO_RULE_ID)
  }
  const pass = violations.length === 0
  return {
    pass,
    violations,
    by_eye: byEye,
    ...(pass ? {} : { reject_text: rejectText(input.family, violations) }),
    checked,
    at: input.at,
  }
}

/**
 * 打回给那家的原话。**说清哪一条、在哪、改完再交**,不带情绪、不带我们内部的词。
 * 它也是送进那家窗口的字,同派活那一段一样不带 markdown 记号(`plainForAgent`)。
 */
export function rejectText(family: string | undefined, violations: readonly ButlerRuleViolation[]): string {
  const who = family === undefined || family === '' ? '' : `${family},`
  return [
    `${who}这一版按他的规矩不能交,先改这几处再交回来(别的不用动):`,
    ...violations.map((one, index) => plainForAgent(`${index + 1}. ${one.rule} —— ${one.why}`)),
  ].join('\n')
}

// ───────────────────────────── 纯函数:重复出现 → 试用 → 保留 / 撤 ─────────────────────────────

/** 一条反馈(他的):派活出去了(`run`)、他通过了(`pass`)、他打回了(`revise`,带原话)。 */
export interface RuleEvent {
  at: string
  kind: 'run' | 'pass' | 'revise'
  /** 哪件活(事项 id / 需求卡名)。 */
  where: string
  /** 这件活沾哪块(`run` 与 `pass` 靠它对上)。 */
  area: ButlerRuleArea
  text?: string
  channel: ButlerRuleChannel
}

/** 反馈 → evolve.ts 那一截认的形状(「选题」= 哪件活,「页签」= 哪一块)。 */
export function asReviewSays(events: readonly RuleEvent[]): EvolveReviewSay[] {
  return events.map(event => ({
    topic: event.where,
    tab: event.area,
    action: event.kind,
    at: event.at,
    ...(event.text === undefined ? {} : { text: event.text }),
  }))
}

/** 两句话是不是在说同一处(关键词重合 ≥ OVERLAP_MIN,与 evolve.ts 同一把尺)。 */
export function sameRule(a: string, b: string): boolean {
  return overlap(keywordsOf(normalizeSay(a)), keywordsOf(normalizeSay(b))) >= OVERLAP_MIN
}

/** 一条试用的规矩 → evolve.ts 的偏好形状(只为了原样复用 `verifyPreference`)。 */
function asPreference(rule: StoredRule): EvolvePreference {
  return {
    id: rule.id,
    text: rule.text,
    topics: [...new Set(rule.evidence.map(one => one.where ?? ''))],
    evidence: rule.evidence.map(one => ({ topic: one.where ?? '', tab: rule.area, at: one.at, text: one.text })),
    status: 'trial',
    adopted_at: rule.adopted_at ?? rule.created_at,
  }
}

/** 试用的这一条验出结论没有。 */
export function verifyRule(rule: StoredRule, events: readonly RuleEvent[]): { status: ButlerRuleStatus, why: string } {
  const verdict = verifyPreference(asPreference(rule), asReviewSays(events))
  if (verdict.status === 'kept') return { status: 'kept', why: verdict.why.replace(/《(.+?)》推进之后她/u, '《$1》交回来之后他') }
  if (verdict.status === 'reverted') return { status: 'reverted', why: verdict.why.replace(/《(.+?)》推进之后她/u, '《$1》交回来之后他') }
  return { status: 'trial', why: verdict.why }
}

/** 从反馈里找新的试用规矩(≥2 件不同的活上打回过同一处),已有的(任何状态)与说的是同一处的都跳过。 */
export function inferRules(events: readonly RuleEvent[], known: readonly StoredRule[], nowMs: number): StoredRule[] {
  const candidates = findPreferences({ reviews: asReviewSays(events), nowMs })
  const at = new Date(nowMs).toISOString()
  const out: StoredRule[] = []
  for (const candidate of candidates) {
    if (known.some(rule => rule.id === ruleId(candidate.text) || sameRule(rule.text, candidate.text))) continue
    if (out.some(rule => sameRule(rule.text, candidate.text))) continue
    const text = cleanRuleText(candidate.text)
    out.push({
      id: ruleId(text),
      text,
      title: ruleTitleOf(text),
      area: ruleAreaOf(text),
      status: 'trial',
      origin: 'repeated',
      evidence: candidate.evidence.map(one => ({ channel: 'review' as const, at: one.at, text: one.text, where: one.topic })),
      created_at: at,
      updated_at: at,
      adopted_at: at,
    })
  }
  return out
}

// ───────────────────────────── 落盘 + 服务 ─────────────────────────────

/** 规矩与习惯的真源(2026-10-26 切割收尾):`~/.dsh/workbench/用户层/偏好/rules.json`(老位置 ~/.dsh/workbench/rules.json 一次性迁进,不再读)。 */
export function defaultRulesFile(home = process.env.HOME ?? ''): string {
  return join(defaultUserLayerPrefsDir(home), 'rules.json')
}

/** 自查记录(一件活最近一次)。 */
export interface RuleReviewRecord extends ButlerRuleReviewView {
  item_id: string
  family?: string
}

interface RulesFile {
  version: 1
  rules: StoredRule[]
  events: RuleEvent[]
  reviews: RuleReviewRecord[]
  synced?: { ok: boolean, at?: string, note?: string }
  /**
   * 从行为账里数出来的习惯(2026-10-09,`habits.ts`)。**同一张表、同一套状态**(试用 / 留下 / 撤),
   * 学与验都在 `habits.ts`;这里只管落盘。决策那四样不进 AGENTS.md(接在派活推荐、来电、早报、审批上,不是一段话);
   * **风格那一种**(`kind: 'style'`)试用中 / 留下的投影成规矩(`styleRules`),跟规矩走同一条路进四处。
   */
  habits?: StoredHabit[]
  /** 风格那一截认到哪了、认出的候选、今天问了几次模型(`styleHabits.ts`)。 */
  style?: StyleState
}

/** AGENTS.md 那一段怎么写、怎么摘(生产接 hooksApply.ts 的 wbSkillApply / wbSkillRevert,带备份纪律)。 */
export interface RulesAgentsPort {
  apply: (body: string) => Promise<{ ok: boolean, changed?: boolean, error?: string }>
  revert: () => Promise<{ ok: boolean, changed?: boolean, error?: string }>
}

export interface RulesServiceOptions {
  file: string
  now?: () => number
  agents?: RulesAgentsPort
  /**
   * 选题卡偏好那一截(evolve.ts,运营模板)还在算数的那几条。**只读投影**:设置里那张表要看全,
   * 撤这几条走 `/evolve/revert`(路由认 `pref:` 开头的 id)。缺席 = 没接进化循环。
   */
  topicPreferences?: () => readonly { id: string, text: string, status: 'trial' | 'kept' | 'reverted', adopted_at: string, verdict?: string }[]
  /**
   * 事务官记忆里「用户-*.md」的全文(导入「观察」那几条用)。生产读 `<工作目录>/docs/记忆/用户-*.md`;
   * 缺席 = 这台服务不知道工作目录在哪,导入如实说做不了。
   */
  observations?: () => Promise<string | undefined>
}

export type RulesResult = { ok: true, rule: ButlerRuleView, added: boolean, note: string } | { ok: false, error: string }

export interface RulesService {
  load: () => Promise<void>
  view: () => ButlerRulesView
  /** 算数的那几条(含选题卡偏好的投影)。 */
  counting: () => StoredRule[]
  add: (input: { text: string, area?: unknown, channel: ButlerRuleChannel, where?: string, said?: string }) => Promise<RulesResult>
  update: (id: string, patch: { text?: unknown, area?: unknown }) => Promise<RulesResult>
  remove: (id: string) => Promise<RulesResult>
  restore: (id: string) => Promise<RulesResult>
  /**
   * 上移 / 下移一条(2026-10-23,卡「分层第二刀一」;审计 P2:后加的固定分工被旧的盖住)。
   * 与设置页那两颗键同一个判据:在**同块**(生效/试用 × 五块)里找相邻的还算数的一条换位置 ——
   * 别的块跨过去找,撤下 / 撤回的不占位;同块一个方向上没有可换的了如实回不动。
   * 表序就是匹配序(`counting()` 按落盘顺序出),挪完同步 AGENTS.md 那一段。
   */
  move: (id: string, dir: 'up' | 'down') => Promise<RulesResult>
  /** 记一条他的反馈,并学一遍(验试用的、找新的)。 */
  feedback: (event: Omit<RuleEvent, 'at'> & { at?: string }) => Promise<{ adopted: number, kept: number, reverted: number, note: string }>
  learn: () => Promise<{ adopted: number, kept: number, reverted: number, note: string }>
  importObservations: (markdown: string) => Promise<{ added: number, skipped: number, rules: ButlerRuleView[] }>
  /**
   * 引导里他说的、按**标题**认的那一条(2026-09-25,卡 O:「派活默认分工」)。表里已经有同标题的:
   * 还算数 → 只多记一条「引导里」的依据(**用他 / 统筹写的那句话,不改字**);他删过 / 撤过 → 什么都不做(尊重他删的);
   * 没有 → 新记一条,来源标「引导」。
   */
  adoptTitled: (input: { title: string, text: string, said: string }) => Promise<{ ok: boolean, added: boolean, note: string, rule?: ButlerRuleView }>
  /** 表里有没有这个标题的一条(还算数的)。 */
  hasTitled: (title: string) => boolean
  /** 从事务官记忆里「用户-*.md」的「观察」一节导入(统筹 / 他在设置里点一次)。 */
  importFromMemory: () => Promise<{ ok: true, added: number, skipped: number, rules: ButlerRuleView[] } | { ok: false, error: string }>
  /** 四个时刻的那几段字。 */
  brief: (moment: 'dispatch' | 'say' | 'agents' | 'review', taskText?: string, kind?: JobKind) => { text?: string, ids: string[] }
  /** 电话每轮最多几句(规矩表里有这一条才有;工人在流上掐)。 */
  sayLimit: () => number | undefined
  review: (input: Omit<RuleReviewInput, 'at'> & { itemId?: string }) => Promise<ButlerRuleReviewView>
  /** 这件活最近一次自查没过、还没重新派 → 回一句卡上的话(生命周期据此不进「等我确认」)。 */
  heldBack: (itemId: string) => string | undefined
  /** 重新派出去了:清掉那一件的「没过」。 */
  clearReview: (itemId: string) => Promise<void>
  /** 表 → AGENTS.md 那一段(没变就不写,写前备份)。 */
  sync: () => Promise<{ ok: boolean, changed: boolean, error?: string }>
  /** 习惯那一截(全部状态;`habits.ts` 读写)。 */
  habits: () => readonly StoredHabit[]
  putHabits: (habits: readonly StoredHabit[]) => Promise<void>
  styleState: () => StyleState | undefined
  putStyleState: (state: StyleState) => Promise<void>
}

/**
 * 风格习惯(试用中 / 留下的)→ 规矩的样子:块是「全局」—— 说话、派活、交回自查、AGENTS.md 四处都带(与规矩同一条路);
 * 聊天 / 动手那两类派活本来就不附全局那一批(卡 MS),风格照这条规矩不附。只读投影:撤走 `/habits/revoke`。
 */
export function styleRules(habits: readonly StoredHabit[]): StoredRule[] {
  return habits
    .filter(habit => habit.kind === 'style' && habitLive(habit))
    .map(habit => ({
      id: habit.id,
      text: habit.text,
      title: ruleTitleOf(habit.text),
      area: 'all' as const,
      status: habit.status,
      origin: 'repeated' as const,
      evidence: [],
      created_at: habit.adopted_at,
      updated_at: habit.updated_at,
      adopted_at: habit.adopted_at,
    }))
}

function viewOf(rule: StoredRule, editable = true): ButlerRuleView {
  return {
    id: rule.id,
    text: rule.text,
    title: rule.title ?? ruleTitleOf(rule.text),
    area: rule.area,
    status: rule.status,
    origin: rule.origin,
    evidence: rule.evidence,
    created_at: rule.created_at,
    updated_at: rule.updated_at,
    ...(rule.verdict === undefined ? {} : { verdict: rule.verdict }),
    editable,
  }
}

function sanitizeRule(value: unknown): StoredRule | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.text !== 'string' || raw.text.trim() === '') return undefined
  const statuses: readonly ButlerRuleStatus[] = ['active', 'trial', 'kept', 'reverted', 'removed']
  const origins: readonly ButlerRuleView['origin'][] = ['said', 'repeated', 'observation', 'topic', 'onboarding']
  const status = statuses.includes(raw.status as ButlerRuleStatus) ? raw.status as ButlerRuleStatus : 'active'
  const origin = origins.includes(raw.origin as ButlerRuleView['origin']) ? raw.origin as ButlerRuleView['origin'] : 'said'
  const at = typeof raw.created_at === 'string' ? raw.created_at : new Date(0).toISOString()
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.filter((one): one is ButlerRuleEvidence => typeof one?.text === 'string' && typeof one.at === 'string'
      && (BUTLER_RULE_CHANNELS as readonly unknown[]).includes(one.channel))
    : []
  return {
    id: raw.id,
    text: raw.text,
    ...(typeof raw.title === 'string' && raw.title !== '' ? { title: raw.title } : {}),
    area: isButlerRuleArea(raw.area) ? raw.area : ruleAreaOf(raw.text),
    status,
    origin,
    evidence,
    created_at: at,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : at,
    ...(typeof raw.adopted_at === 'string' ? { adopted_at: raw.adopted_at } : {}),
    ...(typeof raw.verdict === 'string' ? { verdict: raw.verdict } : {}),
  }
}

export function createRulesService(options: RulesServiceOptions): RulesService {
  const now = options.now ?? (() => Date.now())
  let state: RulesFile = { version: 1, rules: [], events: [], reviews: [] }

  async function save(): Promise<void> {
    await mkdir(dirname(options.file), { recursive: true })
    await writeFile(options.file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  const iso = (): string => new Date(now()).toISOString()

  /** 选题卡偏好的投影(只读)。 */
  function topicRules(): StoredRule[] {
    return (options.topicPreferences?.() ?? []).map(pref => ({
      id: pref.id,
      text: pref.text,
      title: ruleTitleOf(pref.text),
      area: 'content' as const,
      status: pref.status,
      origin: 'topic' as const,
      evidence: [],
      created_at: pref.adopted_at,
      updated_at: pref.adopted_at,
      adopted_at: pref.adopted_at,
      ...(pref.verdict === undefined ? {} : { verdict: pref.verdict }),
    }))
  }

  function counting(): StoredRule[] {
    return [...state.rules, ...topicRules(), ...styleRules(state.habits ?? [])].filter(ruleCounts)
  }

  function find(id: string): StoredRule | undefined {
    return state.rules.find(rule => rule.id === id)
  }

  async function put(rule: StoredRule): Promise<void> {
    // 原处替换、不动位置:表序就是匹配序(上移 / 下移挪出来的),改个字 / 多记一条依据不该把这条甩到块尾。
    const index = state.rules.findIndex(one => one.id === rule.id)
    state = {
      ...state,
      rules: index < 0
        ? [...state.rules, rule]
        : [...state.rules.slice(0, index), rule, ...state.rules.slice(index + 1)],
    }
    await save()
  }

  async function sync(): Promise<{ ok: boolean, changed: boolean, error?: string }> {
    const port = options.agents
    if (port === undefined) return { ok: false, changed: false, error: '没接 AGENTS.md(这台服务不知道家目录在哪)' }
    const body = agentsRulesBlock(counting())
    const done = body === undefined ? await port.revert() : await port.apply(body)
    const synced = done.ok
      ? { ok: true, at: iso() }
      : { ok: false, at: iso(), note: done.error ?? '写不进 AGENTS.md' }
    state = { ...state, synced }
    try { await save() }
    catch { /* 同步状态落不下只是少一行提示,不连累规矩本身 */ }
    return done.ok ? { ok: true, changed: done.changed ?? true } : { ok: false, changed: false, error: synced.note ?? '写不进 AGENTS.md' }
  }

  /** 表变了之后的收尾:同步 AGENTS.md。**同步失败不连累这一次记下**(表已经落盘,下一次启动还会再同步)。 */
  async function after(): Promise<string> {
    const synced = await sync().catch(error => ({ ok: false, changed: false, error: String(error) }))
    return synced.ok ? '每条新会话、下一通电话都会带着。' : `表里记下了,但这次没写进 AGENTS.md(${synced.error ?? '原因不明'}),下次启动再补。`
  }

  async function learn(): Promise<{ adopted: number, kept: number, reverted: number, note: string }> {
    let kept = 0
    let reverted = 0
    for (const rule of state.rules) {
      if (rule.status !== 'trial') continue
      const verdict = verifyRule(rule, state.events)
      if (verdict.status === 'trial') continue
      await put({ ...rule, status: verdict.status, verdict: verdict.why, updated_at: iso() })
      if (verdict.status === 'kept') kept += 1
      else reverted += 1
    }
    const fresh = inferRules(state.events, state.rules, now())
    for (const rule of fresh) await put(rule)
    const adopted = fresh.length
    if (adopted + kept + reverted > 0) await after()
    const notes: string[] = []
    if (adopted > 0) notes.push(`记下 ${adopted} 条试用的规矩`)
    if (kept > 0) notes.push(`${kept} 条试用的验过了,留下`)
    if (reverted > 0) notes.push(`${reverted} 条试用的没见效,撤了`)
    return { adopted, kept, reverted, note: notes.length === 0 ? '没有新的规矩,试用中的也还没验出结果' : notes.join(';') }
  }

  async function add(input: { text: string, area?: unknown, channel: ButlerRuleChannel, where?: string, said?: string }): Promise<RulesResult> {
    const text = cleanRuleText(typeof input.text === 'string' ? input.text : '')
    if (text === '') return { ok: false, error: '规矩是空的' }
    if ([...text].length > RULE_MAX_CHARS) return { ok: false, error: `一条规矩太长了(上限 ${RULE_MAX_CHARS} 字),说短一点` }
    if (looksSystemWritten(text)) return { ok: false, error: '这像是工作台自己写的字(通话纪要 / 引导出处),不是他说的规矩,没记' }
    const at = iso()
    const evidence: ButlerRuleEvidence = {
      channel: input.channel,
      at,
      text: (input.said ?? text).trim().slice(0, RULE_MAX_CHARS),
      ...(input.where === undefined ? {} : { where: input.where }),
    }
    const area = isButlerRuleArea(input.area) ? input.area : ruleAreaOf(text)
    // 同一条(同一句,或说的是同一处)已经在表里:只多一条依据;删过 / 撤过的**他又明说了一遍 → 重新生效**。
    const same = state.rules.find(rule => rule.id === ruleId(text)) ?? state.rules.find(rule => sameRule(rule.text, text))
    if (same !== undefined) {
      const revived = !ruleCounts(same) || same.status === 'trial'
      const next: StoredRule = {
        ...same,
        status: revived ? 'active' : same.status,
        origin: same.origin === 'repeated' && revived ? 'said' : same.origin,
        evidence: [...same.evidence, evidence].slice(-10),
        updated_at: at,
      }
      await put(next)
      const note = revived ? `又说了一遍,重新生效:「${next.text}」。${await after()}` : `这一条已经在表里了:「${next.text}」,多记了一条依据。`
      return { ok: true, rule: viewOf(next), added: false, note }
    }
    const rule: StoredRule = {
      id: ruleId(text),
      text,
      title: ruleTitleOf(text),
      area,
      status: 'active',
      origin: input.channel === 'observation' ? 'observation' : 'said',
      evidence: [evidence],
      created_at: at,
      updated_at: at,
    }
    await put(rule)
    return { ok: true, rule: viewOf(rule), added: true, note: `记下了:「${text}」。${await after()}` }
  }

  async function importObservations(markdown: string): Promise<{ added: number, skipped: number, rules: ButlerRuleView[] }> {
    const found = rulesFromObservations(markdown)
    let added = 0
    let skipped = 0
    const rules: ButlerRuleView[] = []
    for (const one of found) {
      const done = await add({ text: one.text, channel: 'observation', said: one.why })
      if (done.ok && done.added) { added += 1; rules.push(done.rule) }
      else skipped += 1
    }
    return { added, skipped, rules }
  }

  function titledOf(title: string): StoredRule | undefined {
    return state.rules.find(rule => (rule.title ?? ruleTitleOf(rule.text)) === title || rule.text.startsWith(`${title}:`) || rule.text.startsWith(`${title}：`))
  }

  async function adoptTitled(input: { title: string, text: string, said: string }): Promise<{ ok: boolean, added: boolean, note: string, rule?: ButlerRuleView }> {
    const text = cleanRuleText(input.text)
    if (text === '') return { ok: false, added: false, note: '规矩是空的' }
    if ([...text].length > RULE_MAX_CHARS) return { ok: false, added: false, note: `一条规矩太长了(上限 ${RULE_MAX_CHARS} 字)` }
    const at = iso()
    const evidence: ButlerRuleEvidence = { channel: 'onboarding', at, text: input.said.trim().slice(0, RULE_MAX_CHARS) }
    const same = titledOf(input.title)
    if (same !== undefined) {
      if (!ruleCounts(same)) return { ok: true, added: false, note: `「${input.title}」你删过,不再加`, rule: viewOf(same) }
      if (same.evidence.some(one => one.channel === 'onboarding')) return { ok: true, added: false, note: `「${input.title}」已经在表里了`, rule: viewOf(same) }
      const next: StoredRule = { ...same, evidence: [...same.evidence, evidence].slice(-10), updated_at: at }
      await put(next)
      return { ok: true, added: false, note: `「${input.title}」已经在表里了,多记了一条引导里的依据`, rule: viewOf(next) }
    }
    const rule: StoredRule = {
      id: ruleId(text),
      text,
      title: input.title,
      area: 'all',
      status: 'active',
      origin: 'onboarding',
      evidence: [evidence],
      created_at: at,
      updated_at: at,
    }
    await put(rule)
    return { ok: true, added: true, note: `记下了:「${text}」。${await after()}`, rule: viewOf(rule) }
  }

  return {
    adoptTitled,
    hasTitled: title => { const one = titledOf(title); return one !== undefined && ruleCounts(one) },
    async load() {
      try {
        const raw = JSON.parse(await readFile(options.file, 'utf8')) as Partial<RulesFile>
        state = {
          version: 1,
          rules: Array.isArray(raw.rules) ? raw.rules.map(sanitizeRule).filter((one): one is StoredRule => one !== undefined) : [],
          events: Array.isArray(raw.events)
            ? raw.events.filter((one): one is RuleEvent => typeof one?.where === 'string' && typeof one.at === 'string'
              && (one.kind === 'run' || one.kind === 'pass' || one.kind === 'revise'))
            : [],
          reviews: Array.isArray(raw.reviews) ? raw.reviews.filter((one): one is RuleReviewRecord => typeof one?.item_id === 'string') : [],
          ...(raw.synced === undefined ? {} : { synced: raw.synced }),
          ...(Array.isArray(raw.habits)
            ? { habits: raw.habits.map(sanitizeHabit).filter((one): one is StoredHabit => one !== undefined) }
            : {}),
          ...((): { style?: StyleState } => { const style = sanitizeStyleState(raw.style); return style === undefined ? {} : { style } })(),
        }
      }
      catch { state = { version: 1, rules: [], events: [], reviews: [] } }
    },

    view() {
      const own = state.rules.map(rule => viewOf(rule))
      const topic = topicRules().map(rule => viewOf(rule, false))
      const all = [...own, ...topic]
      const live = ordered(all.filter(ruleCounts))
      const retired = all.filter(rule => !ruleCounts(rule)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      return { rules: live, retired, ...(state.synced === undefined ? {} : { synced: state.synced }) }
    },

    counting,

    add,

    async update(id, patch) {
      const rule = find(id)
      if (rule === undefined) return { ok: false, error: '没有这条规矩(选题卡的偏好只能撤,不能改字)' }
      const text = patch.text === undefined ? rule.text : cleanRuleText(typeof patch.text === 'string' ? patch.text : '')
      if (text === '') return { ok: false, error: '规矩改成空的了 —— 不要这条就点删除' }
      if ([...text].length > RULE_MAX_CHARS) return { ok: false, error: `一条规矩太长了(上限 ${RULE_MAX_CHARS} 字)` }
      const area = patch.area === undefined ? rule.area : (isButlerRuleArea(patch.area) ? patch.area : undefined)
      if (area === undefined) return { ok: false, error: '不认识这一块(要 全局 / 说话 / 界面 / 验收 / 内容 之一)' }
      // 改了字 = 他亲手定的:试用的也就此算明说。**id 不跟着字变**(撤销、依据都挂在这个 id 上)。
      const next: StoredRule = {
        ...rule,
        text,
        title: ruleTitleOf(text),
        area,
        status: rule.status === 'trial' && text !== rule.text ? 'active' : rule.status,
        updated_at: iso(),
      }
      await put(next)
      return { ok: true, rule: viewOf(next), added: false, note: `改好了。${await after()}` }
    },

    async remove(id) {
      const rule = find(id)
      if (rule === undefined) return { ok: false, error: '没有这条规矩' }
      if (rule.status === 'removed') return { ok: false, error: '这条已经删过了' }
      // **不从表里抹掉**:留底,设置里能恢复;以后不再照做。
      const next: StoredRule = { ...rule, status: 'removed', updated_at: iso() }
      await put(next)
      return { ok: true, rule: viewOf(next), added: false, note: `删了:「${rule.text}」,以后不再照做。${await after()}` }
    },

    async restore(id) {
      const rule = find(id)
      if (rule === undefined) return { ok: false, error: '没有这条规矩' }
      if (ruleCounts(rule)) return { ok: false, error: '这条本来就算数' }
      const next: StoredRule = { ...rule, status: 'active', updated_at: iso() }
      await put(next)
      return { ok: true, rule: viewOf(next), added: false, note: `恢复了:「${rule.text}」。${await after()}` }
    },

    async move(id, dir) {
      const index = state.rules.findIndex(one => one.id === id)
      if (index < 0) return { ok: false, error: '没有这条规矩' }
      /*
       * 与设置页那两颗键同一个判据:只在**同块**(生效/试用 × 五块,见 ordered() 的分组)里找相邻项
       * (2026-10-23 修复,统筹验收 P2:初版找数组里相邻的任意算数规矩,隔着别的块换位置,
       * 排序后被块序盖回去 —— ok:true 可见顺序却纹丝不动)。别的块的不算邻居,跨过去接着找;
       * 撤下 / 撤回的是留底,既不算数也不占位。同块一个方向上没有可换的了,如实回不动。
       */
      const groupOf = (rule: StoredRule): string => `${rule.status === 'trial' ? 'trial' : 'firm'}:${rule.area}`
      const group = groupOf(state.rules[index] as StoredRule)
      const step = dir === 'up' ? -1 : 1
      let other = index
      let neighbor: StoredRule | undefined
      for (;;) {
        other += step
        if (other < 0 || other >= state.rules.length) break
        const candidate = state.rules[other] as StoredRule
        if (!ruleCounts(candidate)) continue
        if (groupOf(candidate) !== group) continue
        neighbor = candidate
        break
      }
      if (neighbor === undefined) {
        return { ok: false, error: dir === 'up' ? '上面没有同块的规矩了' : '下面没有同块的规矩了' }
      }
      const rules = [...state.rules]
      const moved = rules[index] as StoredRule
      rules[index] = neighbor
      rules[other] = moved
      state = { ...state, rules }
      await save()
      const where = dir === 'up' ? '前面' : '后面'
      return { ok: true, rule: viewOf(moved), added: false, note: `挪到「${neighbor.title ?? ruleTitleOf(neighbor.text)}」${where}了。${await after()}` }
    },

    async feedback(event) {
      const text = event.text?.trim()
      if (event.kind === 'revise' && (text === undefined || text === '')) {
        return { adopted: 0, kept: 0, reverted: 0, note: '打回要带一句原话,没记' }
      }
      if (text !== undefined && looksSystemWritten(text)) {
        return { adopted: 0, kept: 0, reverted: 0, note: '这像是工作台自己写的字,不是他的反馈,没记' }
      }
      const row: RuleEvent = {
        at: event.at ?? iso(),
        kind: event.kind,
        where: event.where,
        area: event.area,
        channel: event.channel,
        ...(text === undefined || text === '' ? {} : { text }),
      }
      state = { ...state, events: [...state.events, row].slice(-RULE_EVENTS_MAX) }
      await save()
      return learn()
    },

    learn,

    importObservations,

    async importFromMemory() {
      const source = options.observations
      if (source === undefined) return { ok: false, error: '不知道事务官的工作目录在哪,读不到「观察」' }
      let text: string | undefined
      try { text = await source() }
      catch { text = undefined }
      if (text === undefined || text.trim() === '') return { ok: false, error: '工作目录里没有 docs/记忆/用户-*.md,没东西可导' }
      return { ok: true, ...(await importObservations(text)) }
    },

    sayLimit() { return sayLimitOf(counting()) },

    brief(moment, taskText, kind) {
      const rules = counting()
      if (moment === 'agents') {
        const text = agentsRulesBlock(rules)
        return { ...(text === undefined ? {} : { text }), ids: rules.map(rule => rule.id) }
      }
      if (moment === 'say') {
        const text = callRulesBlock(rules)
        return { ...(text === undefined ? {} : { text }), ids: rules.map(rule => rule.id) }
      }
      if (moment === 'review') {
        const picked = reviewRules(rules, taskText ?? '')
        return {
          ...(picked.length === 0 ? {} : { text: ['【验收时要对的规矩】', ...picked.map(rule => `- ${rule.text}`)].join('\n') }),
          ids: picked.map(rule => rule.id),
        }
      }
      // `kind`(卡 MS):聊天 / 问答那一类只附这件活真沾到的那几块,不附全局那一批。
      const block = dispatchRulesBlock(rules, taskText ?? '', ...(kind === undefined ? [] : [{ kind }]))
      return block === undefined ? { ids: [] } : { text: block.text, ids: block.ids }
    },

    async review(input) {
      const result = reviewAgainstRules(counting(), { ...input, at: iso() })
      if (input.itemId !== undefined && input.itemId !== '') {
        const record: RuleReviewRecord = {
          ...result,
          item_id: input.itemId,
          ...(input.family === undefined ? {} : { family: input.family }),
        }
        state = { ...state, reviews: [...state.reviews.filter(one => one.item_id !== input.itemId), record].slice(-RULE_REVIEWS_MAX) }
        await save()
      }
      return result
    },

    heldBack(itemId) {
      const record = state.reviews.find(one => one.item_id === itemId)
      if (record === undefined || record.pass) return undefined
      const who = record.family === undefined ? '那家' : ` ${record.family} `
      return `按他的规矩自查没过(${record.violations.map(one => one.rule).join('、')}),已打回给${who}改,改好交回来再叫他。`
    },

    async clearReview(itemId) {
      if (!state.reviews.some(one => one.item_id === itemId)) return
      state = { ...state, reviews: state.reviews.filter(one => one.item_id !== itemId) }
      await save()
    },

    sync,

    habits: () => state.habits ?? [],

    async putHabits(habits) {
      const styleOf = (list: readonly StoredHabit[]): string => JSON.stringify(styleRules(list).map(rule => [rule.id, rule.status]))
      const before = styleOf(state.habits ?? [])
      state = { ...state, habits: [...habits] }
      await save()
      // 风格那几条变了(试用 / 留下 / 撤)→ AGENTS.md 那一段跟着改,每条新会话就带着。
      if (styleOf(habits) !== before) await after()
    },

    styleState: () => state.style,

    async putStyleState(style) {
      state = { ...state, style }
      await save()
    },
  }
}
