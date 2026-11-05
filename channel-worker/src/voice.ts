/**
 * 电话里换音色(2026-09-23 第二版)。
 *
 * ## 第一版错在哪
 *
 * 第一版是「念三个名字给他挑」。真机第二通(Ben 13:00 复述):她念了「知性灿灿 / 可爱女生 /
 * 调皮公主」,他说 **「怎么都是女的」** —— 三个都是女声,而且他**一个都没听过**。
 * 病根两条:
 *   1. 8792 回的清单每条只有 id 和名字,**没有性别、没有风格**,工人只能按清单顺序取前三个,
 *      而清单头上正好连着三个女声;
 *   2. 音色这种东西**听得出来、想不出来**。念名字等于让他隔空猜一个嗓子。
 *
 * ## 这一版怎么做(Ben 的原话)
 *
 * > 「用户不大可能直接告诉你用哪个音色,要么就是你先播给他听,要么就是他模糊的描述,
 * >   然后你去音色库里挑。」
 *
 * 于是这里有三件纯函数:
 *   · **按描述打分挑**({@link parseWant} / {@link scoreVoice} / {@link pickByDescription})——
 *     「沉稳一点的男声」→ 性别硬过滤、风格与年龄感加分、**他不要过的往后排**;
 *   · **逐个播样音**({@link sampleLine})—— 真换过去再念一句固定的自我介绍,他听见的就是那个嗓子;
 *   · **他说的那个是哪一个**({@link matchSpoken})—— 序数(第二个)、模糊指代(那个男的 /
 *     那个沉稳的)、名字,都对得上;**对不上就问,绝不挑一个顶上**。
 *
 * 真相源仍在 8792(`avatar_voice_bindings` 的 `__call__` 那条保留行),这里**不存第二份**。
 * 纪律同 workbench.ts:每个方法回 `{ ok, text }`,不抛。换不成必须有话可说(D13)。
 */

/** 标签缺席时 8792 写的就是这两个字。**「未标」是一个真答案**,不当成「没有这一格」。 */
export const UNTAGGED = '未标'

/** 8792 回来的一个音色。`name` 是给人听的,`id` 是给机器的 —— **id 不念给他听**。 */
export interface VoiceOption {
  id: string
  name?: string
  /** 火山目录里那一列(「通用场景」「角色扮演」…)。 */
  scene?: string
  lang?: string
  /** 「男」「女」或 {@link UNTAGGED}。取自火山自己的 id 命名,这一格基本可信。 */
  gender?: string
  /** 「儿童」「少年」「青年」「成熟」或 {@link UNTAGGED}。 */
  age?: string
  /** 「沉稳」「活泼」「温柔」… 可以有好几个;判断不出来的是 `['未标']`。 */
  styles?: readonly string[]
  accent?: string
  /**
   * **这个嗓子会不会念中文**(8792 的 `speaks_chinese`,2026-09-28 卡 VC)。
   * `undefined` = 不知道(复刻音色一格语种都没有)—— **「不知道」不是「不会」**。
   */
  speaksChinese?: boolean
  /** 一句人话简介。念给他听的就是它。 */
  blurb?: string
  /** 这台后端的账号清单里有没有这一条。没有 = 未验,念之前要说一句。 */
  verified?: boolean
}

/** 他挑过的 / 念过他没要的(落在 8792 的 `voice-picks.json`)。 */
export interface VoiceHistory {
  picked: readonly string[]
  passed: readonly string[]
}

export interface VoiceList {
  provider_type?: string
  current?: VoiceOption
  voices: readonly VoiceOption[]
  history?: VoiceHistory
  /** 样音那一句(8792 说了算,**工人照抄**——盘上的缓存就是按它存的)。 */
  sample_text?: string
}

/**
 * 一次挑几个。**3** —— 电话里听得住的上限:四个以上他会忘了第一个是什么样。
 * 这一版每一个都真播出来,更不能多。
 */
export const MAX_SPOKEN_VOICES = 3

/** 8792 那一句没回来时的兜底样句。与 butler-server 的 `voiceSampleCache.SAMPLE_TEXT` 同一句。 */
export const FALLBACK_SAMPLE_TEXT = '老板你好,我是你的事务官,平时就用这个声音跟你说话。'

/** 念得出口的那个名字。没有名字就退回 id(如实,不编一个中文名)。 */
export function voiceLabel(voice: VoiceOption): string {
  const name = voice.name?.trim()
  return name === undefined || name === '' ? voice.id : name
}

/** 有没有真标上。`undefined`、空串、「未标」都算没标。 */
function tagged(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && value !== UNTAGGED
}

function realStyles(voice: VoiceOption): readonly string[] {
  return (voice.styles ?? []).filter(one => tagged(one))
}

// ─────────────────── 会不会念中文(2026-09-28,卡 VC) ───────────────────

/** lang / accent 里出现这些字 = 会念中文。 */
const CHINESE_LANG = /中文|中英|普通话|国语|汉语|多语种|多语言|mandarin|chinese|multi|zh/i
/** 明确是别的单一语种。**认得出来才算「不会」**,认不出来一律「不知道」。 */
const OTHER_LANG = /英文|英语|日文|日语|韩文|韩语|西语|西班牙|法语|葡萄牙|俄语|德语|阿拉伯|印尼|越南|泰语|english|japanese|korean|spanish/i

/**
 * 这个嗓子会不会念中文。`true` / `false` / `undefined`(**不知道**)。
 *
 * 2026-09-28 那一晚的病根:工人按「只要女生的」挑,挑出了英文女声 Dacey / Stokie,
 * 从此每一句中文都 `3011 unsupported language`,他打过去一直没声音。
 *
 * 口径与 8792 那一份**同一条**(butler-server/server/services/voiceLanguage.cjs):
 *   · 8792 给了 `speaks_chinese` → 照它(它手上有整张目录,不该在这头再推一遍);
 *   · 老 8792 没这一格 → 按 `lang` / `accent` 自己认一遍(至少认得出那三个英文的);
 *   · 什么都认不出来 → `undefined`。**「不知道」不当成「不会」**:复刻音色多半就是中文的,
 *     凭这一格划掉等于凭空少掉半张表。
 */
export function speaksChinese(voice: VoiceOption): boolean | undefined {
  if (voice.speaksChinese !== undefined) return voice.speaksChinese
  const lang = tagged(voice.lang) ? voice.lang as string : ''
  const accent = tagged(voice.accent) ? voice.accent as string : ''
  const both = `${lang} ${accent}`
  if (CHINESE_LANG.test(both)) return true
  if (OTHER_LANG.test(both)) return false
  return undefined
}

/** 他那句话里点到这个音色的名字了吗(「要 Stokie」「就那个 Dacey」)。 */
function namedByHim(voice: VoiceOption, want: VoiceWant): boolean {
  if (want.raw.length < 2) return false
  const label = voiceLabel(voice)
  return want.raw.includes(label) || label.includes(want.raw)
}

/**
 * 念不了中文的那一个,**先跟他说这一句**(2026-09-28,卡 VC)。
 *
 * 为什么不是直接换过去让他自己听:换过去他一个字都听不见 —— 连「这个行吗」都没有声音,
 * 他只会以为电话坏了(真机那一晚他就是这么以为的)。所以**先说,再等他一句坚持**。
 */
export function cannotSpeakChineseLine(voice: VoiceOption): string {
  return `「${voiceLabel(voice)}」是个只会念英文的嗓子,音色一个字没动。`
    + '**先原原本本跟他说这一句**:「这个只会念英文,中文会没声音」。'
    + '他听完还是要,就让他再说一次(「还是要这个」),我再换过去。'
}

// ───────────────────────── 他那句模糊的描述 → 想要什么 ─────────────────────────

/** 他要的是什么样的嗓子。每一格都可以缺席(他没说就是没说,**不替他填**)。 */
export interface VoiceWant {
  gender?: string
  age?: string
  styles: readonly string[]
  lang?: string
  /** 他原话里剩下的那些字,用来跟名字对一对(「要那个灿灿」)。 */
  raw: string
}

const GENDER_WORDS: readonly (readonly [string, RegExp])[] = [
  ['男', /男声|男的|男生|男人|男性|男士|小伙|大叔|哥哥|叔叔/],
  ['女', /女声|女的|女生|女人|女性|女士|姑娘|姐姐|阿姨/],
]

const AGE_WORDS: readonly (readonly [string, RegExp])[] = [
  ['儿童', /小孩|童声|小朋友|奶声/],
  ['少年', /少年|半大/],
  ['青年', /年轻|青年|年青|小伙|姑娘|学生|后生/],
  ['成熟', /成熟|年长|上年纪|中年|大叔|阿姨|长辈/],
]

const STYLE_WORDS: readonly (readonly [string, RegExp])[] = [
  ['沉稳', /沉稳|稳重|稳一点|稳点|踏实|靠谱|正式/],
  ['活泼', /活泼|开朗|有活力|欢快|跳脱|外向|精神/],
  ['温柔', /温柔|柔一点|柔和|轻柔|软一点/],
  ['知性', /知性|文静|有文化|有修养|斯文/],
  ['甜美', /甜美|甜一点|甜的/],
  ['清新', /清新|清爽|干净/],
  ['磁性', /磁性|低沉|低一点|浑厚/],
  ['高冷', /高冷|冷一点|霸气|强势|御姐/],
  ['亲切', /亲切|温暖|暖一点|亲和|贴心/],
  ['古风', /古风|古装|古典/],
  ['解说腔', /解说|播音|主播|配音/],
]

/** 描述里这些词表示「别要现在这个」,不表示他要什么 —— 对名字时先剔掉。 */
const CHANGE_WORDS = /换|重新|再来|别的|其它|其他|不要这个|不喜欢/g

/**
 * 他那句话 → 想要什么。**推不出来就留空**:留空的那几格在打分里是 0 分,
 * 不是「随便」也不是「都行」—— 那两种说法会让分数被一句废话带偏。
 */
export function parseWant(said: string | undefined): VoiceWant {
  const text = (said ?? '').trim()
  const styles = STYLE_WORDS.filter(([, re]) => re.test(text)).map(([tag]) => tag)
  const gender = GENDER_WORDS.find(([, re]) => re.test(text))?.[0]
  const age = AGE_WORDS.find(([, re]) => re.test(text))?.[0]
  const lang = /英文|英语|English/i.test(text) ? '英文' : undefined
  return {
    ...(gender === undefined ? {} : { gender }),
    ...(age === undefined ? {} : { age }),
    ...(lang === undefined ? {} : { lang }),
    styles,
    raw: text.replace(CHANGE_WORDS, '').trim(),
  }
}

/** 他一个字都没说时的「想要什么」:**和现在这个不一样**(Ben:「按和现在不同性别/风格挑三个」)。 */
export function wantOtherThan(current: VoiceOption | undefined): VoiceWant {
  const gender = current?.gender
  const flip = gender === '男' ? '女' : (gender === '女' ? '男' : undefined)
  return { ...(flip === undefined ? {} : { gender: flip }), styles: [], raw: '' }
}

// ───────────────────────────────── 打分 ─────────────────────────────────

/** 性别对上加这么多、对不上扣这么多。**扣得比加得多**:他说男声,女声就不该挤进前三。 */
const GENDER_HIT = 6
const GENDER_MISS = -9
const AGE_HIT = 3
const STYLE_HIT = 3
/** 他原话里的字出现在名字里(「要那个灿灿」)。 */
const NAME_HIT = 4
/** 念过他没要的 / 他从前挑过的:往后排,**不是拉黑**(库里就这么多,拉黑几轮就没得挑了)。 */
const PASSED_PENALTY = -4
const PICKED_PENALTY = -2
/** 账号清单里查不到(未验):排在后面 —— 换过去可能根本出不了声。 */
const UNVERIFIED_PENALTY = -5

/** 某个音色**有多合他那句描述**。分数只在同一次挑选里比大小,绝对值没有意义。 */
export function scoreVoice(voice: VoiceOption, want: VoiceWant, history?: VoiceHistory): number {
  let score = 0
  if (want.gender !== undefined && tagged(voice.gender)) {
    score += voice.gender === want.gender ? GENDER_HIT : GENDER_MISS
  }
  if (want.age !== undefined && tagged(voice.age) && voice.age === want.age) score += AGE_HIT
  const styles = realStyles(voice)
  for (const one of want.styles) if (styles.includes(one)) score += STYLE_HIT
  if (want.lang !== undefined && voice.lang === want.lang) score += AGE_HIT
  // 他原话里的字落在名字上 —— 这一条压过标签:他要的就是那个名字。
  // 两头都对一对:「要那个灿灿」(名字里含他说的)与「要 Stokie」(他那句里含名字)都算(卡 VC)。
  if (namedByHim(voice, want)) score += NAME_HIT
  if (voice.verified === false) score += UNVERIFIED_PENALTY
  if (history?.passed.includes(voice.id) === true) score += PASSED_PENALTY
  if (history?.picked.includes(voice.id) === true) score += PICKED_PENALTY
  return score
}

export interface PickInput {
  want: VoiceWant
  /** 这一通电话里已经念过的(「换一批」时用来避开)。 */
  offered?: readonly string[]
  count?: number
}

/**
 * 挑出这一批要播给他听的几个。
 *
 * - **正在用的那个不挑**:他要的是「换一个」;
 * - **念不了中文的不挑**(2026-09-28,卡 VC)—— 除非他点名要那一个、或者明说要英文的。
 *   真机那一晚「只要女生的再换」挑出了英文女声 Dacey,他那一整通电话一个字都没听见;
 * - **这一通念过的不再挑**(`offered`)—— 「换一批」就该是新面孔;
 * - 按 {@link scoreVoice} 从高到低,同分按目录顺序(稳定,用例才钉得住);
 * - 一个都不剩(库翻完了)→ 回空数组,由调用方如实说,**不回头再念一遍老的**。
 */
export function pickByDescription(list: VoiceList, input: PickInput): readonly VoiceOption[] {
  const current = list.current?.id
  const offered = new Set(input.offered ?? [])
  const wantsOtherLang = input.want.lang !== undefined && input.want.lang !== '中文'
  const pool = list.voices.filter((one) => {
    if (one.id === current || offered.has(one.id)) return false
    // 念不了中文的:只在他点名要、或者明说「要个英文的」时才进池子。
    if (speaksChinese(one) === false) return wantsOtherLang || namedByHim(one, input.want)
    return true
  })
  const scored = pool.map((voice, index) => ({ voice, index, score: scoreVoice(voice, input.want, list.history) }))
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index))
  return scored.slice(0, input.count ?? MAX_SPOKEN_VOICES).map(one => one.voice)
}

// ──────────────────────── 播给他听的那几句 ────────────────────────

const ORDINALS = ['第一个', '第二个', '第三个'] as const

/** 第几个。超出三个就说「下一个」—— 电话里没人数到第四。 */
export function ordinalOf(index: number): string {
  return ORDINALS[index] ?? '下一个'
}

/** 这一条的标签怎么说成人话。**没标就说「这个没标」**,不编。 */
export function describeVoice(voice: VoiceOption): string {
  const blurb = voice.blurb?.trim()
  if (blurb !== undefined && blurb !== '') return blurb
  const bits: string[] = []
  if (tagged(voice.gender)) bits.push(`${voice.gender}声`)
  if (tagged(voice.age)) bits.push(`${voice.age}感`)
  const styles = realStyles(voice)
  if (styles.length > 0) bits.push(styles.join('、'))
  return bits.length === 0 ? '这个音色库里没标性别和风格,听听看' : bits.join(',')
}

/**
 * 播一个样音要对模型说的那段话。**调用方必须先把音色真换过去再返回它** ——
 * 他听见的那一句就是用这个嗓子合出来的,这才叫「播给他听」。
 *
 * 样句**一字不差地念**:8792 那边的样音缓存就是按这一句的 sha1 存的,改一个字就不命中。
 */
export function sampleLine(input: {
  voice: VoiceOption
  index: number
  total: number
  sampleText?: string
  /** 这一批是按他哪句话挑的。有就带一句,让他知道不是随便抓的。 */
  because?: string
}): string {
  const trimmed = input.sampleText?.trim()
  const sample = trimmed === undefined || trimmed === '' ? FALLBACK_SAMPLE_TEXT : trimmed
  const because = input.because?.trim()
  const head = input.index === 0 && because !== undefined && because !== ''
    ? `按「${because}」挑了 ${input.total} 个,一个一个念给他听。`
    : ''
  const more = input.index + 1 < input.total
    ? '要听下一个就再调用一次这件工具(什么都不用填)。'
    : '这是这一批最后一个了。'
  const unverified = input.voice.verified === false
    ? '(这一个不在账号清单里,**先说一句「这个我没验过」**)'
    : ''
  // 念不了中文的那一个(他点名要来的):**这一句必须先说**,否则他只会听见一片安静。
  const english = speaksChinese(input.voice) === false
    ? '**先说一句「这个只会念英文,中文会没声音」**,再念下面这些。'
    : ''
  return `${english}${head}嗓子已经换成${ordinalOf(input.index)}「${voiceLabel(input.voice)}」了${unverified}。`
    + `先说一句「${ordinalOf(input.index)},${describeVoice(input.voice)}」,`
    + `紧接着**一字不差**念这一句:「${sample}」`
    + `念完问他一句「这个行吗?」。${more}`
    + '他说「就这个 / 第几个 / 那个沉稳的」→ 再调用一次,把 which 填成他的原话;'
    + '他说「都不要 / 换一批」→ 再调用一次,action 填 again。'
}

// ───────────────────── 他说的那个是哪一个 ─────────────────────

/** 序数:他说得出的各种说法。 */
const ORDINAL_WORDS: readonly (readonly [number, RegExp])[] = [
  [0, /第一|第1|头一个|头个|最先|前面那个|刚才第一/],
  [1, /第二|第2|中间那个/],
  [2, /第三|第3|最后一个|最后那个|末一个/],
]

export type SpokenMatch =
  | { kind: 'one', voice: VoiceOption }
  | { kind: 'many', voices: readonly VoiceOption[] }
  | { kind: 'none' }

/**
 * 他那句话指的是哪一个。**先在这一批里找**(他只听过这几个),找不到再去整张单子里对名字。
 *
 * 认四种说法:
 *   ① 序数 —— 「第二个」「最后那个」;
 *   ② 性别 —— 「那个男的」;
 *   ③ 风格/年龄 —— 「那个沉稳的」「年轻那个」;
 *   ④ 名字 —— 「知性灿灿」「灿灿」。
 *
 * ②③ 在这一批里**撞了两个**就回 `many`,由调用方问他一句。**绝不挑一个顶上**:
 * 换错嗓子他一耳朵就听得出来,而那正是这张卡在修的毛病。
 */
export function matchSpoken(
  offered: readonly VoiceOption[],
  said: string,
  all: readonly VoiceOption[] = [],
): SpokenMatch {
  const want = said.trim()
  if (want === '') return { kind: 'none' }

  const ordinal = ORDINAL_WORDS.find(([, re]) => re.test(want))?.[0]
  if (ordinal !== undefined) {
    const hit = offered[ordinal]
    return hit === undefined ? { kind: 'none' } : { kind: 'one', voice: hit }
  }

  // 名字先于标签:他说得出名字就是指那一个,没有歧义可言。
  const byName = offered.find(one => voiceLabel(one) === want)
    ?? all.find(one => voiceLabel(one) === want)
    ?? offered.find(one => voiceLabel(one).includes(want))
    ?? all.find(one => voiceLabel(one).includes(want))
  if (byName !== undefined) return { kind: 'one', voice: byName }

  const parsed = parseWant(want)
  const byTag = offered.filter((one) => {
    if (parsed.gender === undefined && parsed.age === undefined && parsed.styles.length === 0) return false
    if (parsed.gender !== undefined && one.gender !== parsed.gender) return false
    if (parsed.age !== undefined && one.age !== parsed.age) return false
    const styles = realStyles(one)
    if (parsed.styles.length > 0 && !parsed.styles.some(s => styles.includes(s))) return false
    return true
  })
  if (byTag.length === 1) return { kind: 'one', voice: byTag[0] as VoiceOption }
  if (byTag.length > 1) return { kind: 'many', voices: byTag }
  return { kind: 'none' }
}

/** 撞了好几个时问他的那一句。**只念名字**。 */
export function askWhichLine(voices: readonly VoiceOption[]): string {
  const names = voices.map(one => `「${voiceLabel(one)}」`).join('、')
  return `${names}都对得上他那句话,音色一个字没动。问他一句是哪一个(**只念名字,不要念 id**)。`
}

// ───────────────────────────── 8792 那一头 ─────────────────────────────

export interface VoiceClient {
  /** 现在是哪一个 + 能换成哪几个(带标签)。取不到回 `{ ok:false, text }`。 */
  list: () => Promise<{ ok: true, list: VoiceList } | { ok: false, text: string }>
  /**
   * 换成这一个。**回的是 8792 认下来的那个**,不是我们发上去的。
   * `preview` = 只是播给他听听:照换(不换就听不见),但**不记进「他挑过的」**。
   */
  set: (voiceId: string, options?: { preview?: boolean }) => Promise<{ ok: true, voice: VoiceOption } | { ok: false, text: string }>
  /** 这几个念过了他没要。**失败无声**(记不上不该挡住换音色)。 */
  passed: (voiceIds: readonly string[]) => Promise<void>
  /** 把这个音色的样音**先合出来落盘**(预热下一个候选)。**失败无声**。 */
  warm: (voiceId: string) => Promise<void>
}

export interface VoiceClientDeps {
  /** 8792 的地址(`config.butlerUrl`)。 */
  butlerUrl: string
  fetchImpl?: typeof fetch
}

/** 8792 的错误一律 `{ error: 一句人话 }`;取不到就给一句能照着做的兜底。 */
function errorOf(body: unknown, fallback: string): string {
  const message = (body as { error?: unknown } | null)?.error
  return typeof message === 'string' && message !== '' ? message : fallback
}

function stringOf(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

function voiceOf(raw: unknown): VoiceOption | undefined {
  const one = (raw ?? {}) as Record<string, unknown>
  if (typeof one.id !== 'string' || one.id.trim() === '') return undefined
  const styles = Array.isArray(one.styles)
    ? one.styles.filter((s): s is string => typeof s === 'string' && s !== '')
    : undefined
  return {
    id: one.id.trim(),
    ...(stringOf(one.name) === undefined ? {} : { name: one.name as string }),
    ...(stringOf(one.scene) === undefined ? {} : { scene: one.scene as string }),
    ...(stringOf(one.lang) === undefined ? {} : { lang: one.lang as string }),
    ...(stringOf(one.gender) === undefined ? {} : { gender: one.gender as string }),
    ...(stringOf(one.age) === undefined ? {} : { age: one.age as string }),
    ...(styles === undefined ? {} : { styles }),
    ...(stringOf(one.accent) === undefined ? {} : { accent: one.accent as string }),
    // 8792 的 `speaks_chinese`(2026-09-28,卡 VC)。老 8792 没这一格 → 缺席 = 不知道,
    // 由 speaksChinese() 按 lang / accent 自己再认一遍。
    ...(typeof one.speaks_chinese === 'boolean' ? { speaksChinese: one.speaks_chinese } : {}),
    ...(stringOf(one.blurb) === undefined ? {} : { blurb: one.blurb as string }),
    ...(typeof one.verified === 'boolean' ? { verified: one.verified } : {}),
  }
}

function idsOf(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((one): one is string => typeof one === 'string' && one !== '') : []
}

/** 8792 的回包 → VoiceList。**读不懂的条目挑掉,绝不抛**(它跨进程来)。 */
export function parseVoiceList(body: unknown): VoiceList {
  const raw = (body ?? {}) as Record<string, unknown>
  const voices = Array.isArray(raw.voices)
    ? raw.voices.flatMap((one) => { const parsed = voiceOf(one); return parsed === undefined ? [] : [parsed] })
    : []
  const current = voiceOf(raw.current)
  const history = (raw.history ?? undefined) as Record<string, unknown> | undefined
  return {
    ...(typeof raw.provider_type === 'string' ? { provider_type: raw.provider_type } : {}),
    ...(current === undefined ? {} : { current }),
    ...(history === undefined ? {} : { history: { picked: idsOf(history.picked), passed: idsOf(history.passed) } }),
    ...(stringOf(raw.sample_text) === undefined ? {} : { sample_text: raw.sample_text as string }),
    voices,
  }
}

export function createVoiceClient(deps: VoiceClientDeps): VoiceClient {
  const doFetch = deps.fetchImpl ?? fetch
  const base = deps.butlerUrl.replace(/\/+$/, '')

  async function json(path: string, init?: RequestInit): Promise<{ status: number, body: unknown }> {
    const res = await doFetch(`${base}${path}`, init)
    const raw = await res.text()
    let body: unknown = {}
    try { body = raw === '' ? {} : JSON.parse(raw) }
    catch { body = { error: '回包不是 JSON' } }
    return { status: res.status, body }
  }

  async function post(path: string, payload: unknown): Promise<void> {
    await json(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  return {
    async list() {
      let result: { status: number, body: unknown }
      try { result = await json('/api/voices') }
      catch { return { ok: false, text: '语音后端连不上,查不到能换哪些音色。如实告诉他。' } }
      if (result.status !== 200) {
        return { ok: false, text: `查不到能换的音色:${errorOf(result.body, `语音后端回了 ${result.status}`)}。如实告诉他。` }
      }
      return { ok: true, list: parseVoiceList(result.body) }
    },

    async set(voiceId, options) {
      const want = voiceId.trim()
      if (want === '') return { ok: false, text: '没说要换成哪个,音色一个字没动。' }
      let result: { status: number, body: unknown }
      try {
        result = await json('/api/voices/current', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voice_id: want, ...(options?.preview === true ? { preview: true } : {}) }),
        })
      }
      catch { return { ok: false, text: '语音后端连不上,音色没换成。如实告诉他。' } }
      if (result.status !== 200) {
        return { ok: false, text: `没换成:${errorOf(result.body, `语音后端回了 ${result.status}`)}。如实告诉他。` }
      }
      const voice = voiceOf((result.body as { voice?: unknown } | null)?.voice)
      // 8792 说成了却没回音色:这时候说「换好了」是在赌。如实说一句,让他自己听。
      if (voice === undefined) return { ok: false, text: '语音后端说换了,但没告诉我换成了哪个。如实告诉他,让他听听看。' }
      return { ok: true, voice }
    },

    // 下面两件**失败无声**:记不上一笔、预热不成,都不该让电话里少一句话。
    async passed(voiceIds) {
      const ids = voiceIds.filter(one => one.trim() !== '')
      if (ids.length === 0) return
      try { await post('/api/voices/passed', { voice_ids: ids }) }
      catch { /* 见上 */ }
    },

    async warm(voiceId) {
      const want = voiceId.trim()
      if (want === '') return
      try { await post('/api/voices/sample', { voice_id: want }) }
      catch { /* 见上 */ }
    },
  }
}
