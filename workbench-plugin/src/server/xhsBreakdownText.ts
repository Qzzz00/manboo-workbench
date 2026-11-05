/**
 * 爆款拆解的**纯文本层**(2026-09-22):SRT 怎么读、抽哪几帧、提示词怎么拼、
 * 模型回的东西怎么读成结构、`拆解.md` 长什么样。**一行 I/O 都没有**。
 *
 * 依据:决策记录 2026-09-22 **C6「拆解产物带时间戳」**(Ben 定);
 * 预研第二节 F 小节:**Claude 与 GPT 都不能吃视频**(官方文档钉死),
 * 所以这一条的形态就是白板原话那样 ——「提取字幕导出后发给模型分析得出内容框架」;
 * 预研实验六那一条最要紧的发现:**ASR 会无中生有**(faster-whisper 在实验里凭空
 * 插进来一句原文根本没说的「点个关注」)。这正是 C6 的由来 ——
 * **产物里每一段都带时间戳,他能回去核对原片**。
 *
 * ## 这份文件里三条"不编"的纪律
 *
 * 1. **时间戳不是模型给的,是转写给的。** 模型只被允许引用我们喂给它的那几个时间点;
 *    它写了一个清单之外的时间戳,{@link parseFrameworkReply} 当场把那一条丢掉。
 * 2. **转写为空就不拼提示词、不调模型。** 一份"从没有字的视频里分析出来的内容框架"
 *    是纯编的,比没有更糟。
 * 3. **每一段都写明依据**(第几秒那句原话),同数据复盘那张卡「建议必带依据」的口径。
 */
import { TRAD_RATIO_THRESHOLD, percentOf, type SimplifyOutcome } from './zhSimplify.ts'

/** 内容框架的五段。逐字取自这张卡的任务书(开头 / 正文结构 / 结尾 / 钩子 / 节奏)。 */
export const FRAMEWORK_SECTIONS = ['开头', '正文结构', '结尾', '钩子', '节奏'] as const
export type FrameworkSection = typeof FRAMEWORK_SECTIONS[number]

/** 抽帧的上下限。任务书:6~12 帧。 */
export const FRAMES_MIN = 6
export const FRAMES_MAX = 12

/** 转写出来的一行(带时间戳)。 */
export interface TranscriptCue {
  /** 开始秒数。 */
  start: number
  /** 结束秒数。 */
  end: number
  text: string
}

/** `00:01:02,345` → 62.345。读不出来回 undefined,**不猜 0**。 */
export function srtTimeToSeconds(raw: string): number | undefined {
  const hit = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(raw.trim())
  if (hit === null) return undefined
  const [, h, m, s, ms] = hit
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number((ms ?? '0').padEnd(3, '0')) / 1000
}

/** 秒 → `00:12`(不足一小时)或 `01:02:03`。产物里逐字用它。 */
export function stampOf(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${two(h)}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

/**
 * 读 whisper.cpp `-osrt` 出来的那份 SRT。
 *
 * **坏掉的块整块跳过,不半信半疑地收一半**:一条时间戳读不出来的字幕行,
 * 它的文字落到哪一秒我们就不知道了,而这张卡的全部意义就是那个时间戳能对上原片。
 */
export function parseSrt(raw: string): TranscriptCue[] {
  const out: TranscriptCue[] = []
  for (const block of raw.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (lines.length < 2) continue
    const timeLine = lines.find(line => line.includes('-->'))
    if (timeLine === undefined) continue
    const [fromRaw, toRaw] = timeLine.split('-->')
    const start = srtTimeToSeconds(fromRaw ?? '')
    const end = srtTimeToSeconds(toRaw ?? '')
    if (start === undefined || end === undefined) continue
    const text = lines.slice(lines.indexOf(timeLine) + 1).join(' ').trim()
    if (text === '') continue
    out.push({ start, end, text })
  }
  return out
}

/**
 * 逐字稿头上那一句繁简的话。**转没转都要说**:
 * 转了要说(他看到的字形不是机器原话的字形),没转也要说(不然他以为这一步根本没跑)。
 */
export function simplifyLine(outcome: SimplifyOutcome): string {
  const 占比 = percentOf(outcome.measure.ratio)
  const 线 = percentOf(TRAD_RATIO_THRESHOLD)
  if (outcome.converted) {
    return '> ⚠️ **原始转写是繁体字,已经替你转成简体。** whisper.cpp 转中文时字形是它自己挑的'
      + '(同一档模型、同一条命令,有的音频出繁体、有的出简体,提示词按不住)。'
      + `这一份里繁体字占 ${占比},过了 ${线} 那条线,所以按 OpenCC 的繁→简字表转了一遍:`
      + '**只换字形,没改用词,时间戳一个都没动**。'
  }
  return `> 这一份不用转:繁体字占 ${占比},没到 ${线} 那条线(过线才转成简体)。`
    + 'whisper.cpp 转中文时字形是它自己挑的,所以每一份都量一次 —— 夹在里面的繁体字是内容本身,不替你改。'
}

/** 逐字稿.md。**每一行都带时间戳** —— 它是拆解.md 每一条依据的落脚点。 */
export function renderTranscriptMd(
  cues: readonly TranscriptCue[],
  meta: { at: string, url: string, model: string, simplify?: SimplifyOutcome },
): string {
  const lines = [
    '# 逐字稿(机器转写)',
    '',
    `> 转写于 ${meta.at},来源:${meta.url}`,
    `> 用的是本机的 whisper.cpp(\`${meta.model}\` 这一档),**音频一个字节都没上传**。`,
    '> ⚠️ **这是机器转写,可能有出入**:同音词会错,极少数情况下还会凭空多出一句原片没说的话。',
    ...(meta.simplify === undefined ? [] : [simplifyLine(meta.simplify)]),
    '> 每一行前面那个时间戳就是给你回去核对原片用的。',
    '',
  ]
  if (cues.length === 0) {
    lines.push('(一句都没转出来。可能是这条视频没有人声,也可能是转写失败 —— 两种我分不清,所以不猜。)', '')
    return lines.join('\n')
  }
  for (const cue of cues) lines.push(`- \`${stampOf(cue.start)}\` ${cue.text}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * 抽哪几帧:封面(第 0 秒)+ 之后均匀铺开,一共 6~12 张。
 *
 * 为什么不是"每 15 秒一帧":一条 30 秒的视频那样只有 2 帧(少了),
 * 一条 10 分钟的有 40 帧(多得没必要,还贵)。**按时长在 6~12 之间铺**,
 * 两头都有下限上限,数量可预期。
 */
export function frameTimes(durationSec: number, max = FRAMES_MAX, min = FRAMES_MIN): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0]
  // 大致每 15 秒一帧,再夹到 [min, max]。
  const want = Math.min(max, Math.max(min, Math.round(durationSec / 15)))
  const out: number[] = []
  for (let i = 0; i < want; i++) {
    // 最后一帧留一点余量,别正好踩在末尾(常是黑帧)。
    out.push(Math.min(durationSec - 0.2, (durationSec * i) / want))
  }
  return out.map(one => Math.max(0, Math.round(one * 10) / 10))
}

// ───────────────────────── 提示词 ─────────────────────────

export interface FrameworkInput {
  title?: string
  desc?: string
  tags: readonly string[]
  cues: readonly TranscriptCue[]
  /** 抽了哪几帧(秒)。图文笔记就是图的序号位,时长写 0。 */
  frames: readonly number[]
  /** 图文笔记走这条:直接把图交给视觉模型时,这里写图片有几张。 */
  images?: number
}

/** 模型只许引用这几个时间点。**清单之外的一律丢掉**(见 parseFrameworkReply)。 */
export function allowedStamps(cues: readonly TranscriptCue[]): string[] {
  return [...new Set(cues.map(cue => stampOf(cue.start)))]
}

/**
 * 图文笔记没有时间轴,**它的"时间戳"是第几张图**。
 *
 * C6 要的时间戳,要的其实是「每一段都能回去核对原件」这件事。
 * 视频里那个位置叫 `01:23`,图文里叫「图 3」—— 作用一模一样,所以两条走同一套闸:
 * 模型引用的位置必须在清单里,不在就丢掉那一条。
 */
export function imageStamps(count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => `图 ${index + 1}`)
}

/**
 * 拼提示词。
 *
 * ★ 三句硬话写在提示词里,与数据复盘那张卡的「数字已经算好了,你不要再算」同一个路数:
 * - 时间戳只能从我给的清单里挑;
 * - 转写可能有错,拿不准就说拿不准;
 * - 不评价这条内容好不好,只拆它是怎么搭的。
 */
export function buildFrameworkPrompt(input: FrameworkInput): string {
  const stamps = input.images === undefined ? allowedStamps(input.cues) : imageStamps(input.images)
  const lines = [
    '你在帮一个做小红书的运营同事拆解一条别人的爆款笔记。她要的是**这条内容是怎么搭起来的**,不是它好不好。',
    '',
    '## 这条笔记',
    `- 标题:${input.title ?? '(没采到)'}`,
    `- 短文案:${input.desc ?? '(没采到)'}`,
    `- 标签:${input.tags.length === 0 ? '(没采到)' : input.tags.map(tag => `#${tag}`).join(' ')}`,
    input.images === undefined ? `- 抽了 ${input.frames.length} 帧画面` : `- 这是图文笔记,一共 ${input.images} 张图`,
    '',
    ...(input.images === undefined
      ? [
          '## 机器转写的逐字稿(每行前面是这句话在原片里的时间)',
          '',
          ...input.cues.map(cue => `[${stampOf(cue.start)}] ${cue.text}`),
          '',
        ]
      : [
          '## 这是图文笔记',
          '',
          `一共 ${input.images} 张图。**我没有把图本身给你看** —— 我们这条模型通道只收文字。`,
          '所以画面上有什么你不知道,**不要编**:凡是要看图才说得出来的话一律别说,',
          '只从标题、短文案、标签这三样能看出来的地方拆。看不出来的那一段就不写那一段。',
          '',
        ]),
    '## 你要输出的',
    '',
    `五段,每段一行,格式逐字是 \`<段名>|<时间戳>|<一两句话>\`。段名只能是这五个:${FRAMEWORK_SECTIONS.join(' / ')}。`,
    '',
    '- **开头**:前几秒在做什么(自报家门 / 抛结论 / 提问 / 场景)',
    '- **正文结构**:中间分成几块、每块在干什么',
    '- **结尾**:最后怎么收、有没有给关注/收藏的理由',
    '- **钩子**:哪一句最抓人、它抓的是什么情绪或利益',
    '- **节奏**:语速、停顿、换话题的频率给人什么感觉',
    '',
    '## 三条硬要求',
    '',
    `1. **位置只能从这个清单里挑,一个都不许自己编**:${stamps.join(' ')}`,
    ...(input.images === undefined
      ? ['2. **这份逐字稿是机器转的,可能有错字、极少数情况下会凭空多出一句原片没说的话。**'
          + '哪一句你觉得不对劲,就在那一段里明说「这句可能是转写错了」,不要顺着它往下编。']
      : ['2. **你没看见图。** 凡是要看图才说得出来的,一个字都别写。']),
    '3. **不评价好坏,不给改进建议,不预测数据**。她要的是拆解,不是点评。',
  ]
  return lines.join('\n')
}

export interface FrameworkItem {
  section: FrameworkSection
  /** `01:23`(视频)或 `图 3`(图文)。**一定在清单里** —— 不在的整条丢掉。 */
  stamp: string
  text: string
}

/**
 * 读模型回的那几行。
 *
 * **三种丢掉**:段名不认识的、时间戳不在清单里的、正文空的。
 * 同一段回了两条只留第一条。一条都没留下 → 回空数组,调用方据此**不写产物**。
 */
export function parseFrameworkReply(reply: string, stamps: readonly string[]): FrameworkItem[] {
  const allowed = new Set(stamps)
  const known = new Set<string>(FRAMEWORK_SECTIONS)
  const seen = new Set<string>()
  const out: FrameworkItem[] = []
  for (const line of reply.split('\n')) {
    const parts = line.trim().replace(/^[-*\d.\s]+/, '').split('|')
    if (parts.length < 3) continue
    const section = (parts[0] ?? '').trim()
    const stamp = (parts[1] ?? '').trim()
    const text = parts.slice(2).join('|').trim()
    if (!known.has(section) || seen.has(section)) continue
    if (!allowed.has(stamp)) continue
    if (text === '') continue
    seen.add(section)
    out.push({ section: section as FrameworkSection, stamp, text })
  }
  return out
}

/** 一段时间戳对应的原话(产物里那一行「依据」念的就是它)。 */
export function quoteAt(cues: readonly TranscriptCue[], stamp: string): string | undefined {
  const hit = cues.find(cue => stampOf(cue.start) === stamp)
  return hit?.text
}

export interface BreakdownMeta {
  at: string
  url: string
  title?: string
  /** 转写用的哪一档模型。 */
  asr_model: string
  /** 视频多少秒。图文笔记没有。 */
  duration?: number
  /** 抽了几帧 / 几张图。 */
  frames: number
  /** 图文笔记:true。产物头上那句话不一样(没有转写这回事)。 */
  images_only?: boolean
}

/**
 * 拆解.md。**C6:每一段都带时间戳,而且每一段底下贴着那个时间点的原话。**
 *
 * 一条都没有 → 这个函数不该被调用(调用方负责),但它仍然如实说,不画一个空框架。
 */
export function renderBreakdownMd(
  items: readonly FrameworkItem[],
  cues: readonly TranscriptCue[],
  meta: BreakdownMeta,
): string {
  const lines = [
    `# ${meta.title ?? '这条笔记'} · 爆款拆解`,
    '',
    `> 拆解于 ${meta.at},来源:${meta.url}`,
    ...(meta.images_only === true
      ? [
          `> 这是图文笔记,没有语音可转。下面每一段后面的「图 N」就是它在原帖里第几张图。`,
          '> ⚠️ **模型没有看见图本身**(我们这条模型通道只收文字),所以它只从标题、短文案、标签拆。',
        ]
      : [
          `> 转写在本机做的(whisper.cpp \`${meta.asr_model}\`),${meta.duration === undefined ? '' : `视频 ${stampOf(meta.duration)},`}`
          + `抽了 ${meta.frames} 帧画面。`,
          '> ⚠️ **逐字稿是机器转的,可能有出入。** 每一段后面那个时间戳就是给你回去核对原片用的。',
        ]),
    '',
  ]
  if (items.length === 0) {
    lines.push('(这一次没拆出东西来。模型回的内容一条都对不上逐字稿里的时间点,我不把对不上的写进来。)', '')
    return lines.join('\n')
  }
  for (const item of items) {
    lines.push(`## ${item.section} · \`${item.stamp}\``)
    lines.push('')
    lines.push(item.text)
    const quote = quoteAt(cues, item.stamp)
    if (quote !== undefined) {
      lines.push('')
      lines.push(`> 依据:\`${item.stamp}\` 那一句「${quote}」(机器转写)`)
    }
    lines.push('')
  }
  if (meta.images_only !== true) lines.push('完整逐字稿在同一个文件夹的《逐字稿》里,每一行都带时间戳。', '')
  return lines.join('\n')
}
