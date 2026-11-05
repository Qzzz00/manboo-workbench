/**
 * 语气 —— **契约就在这一个文件里**(2026-10-02,卡「声音与形象跟着话走」)。
 *
 * ## 为什么要它
 *
 * 维护者 09-24:「有几句 TTS 听上去很诡异,**是语气不是内容**」。查实(设计-活人感标准与前端差距-2026-10-02
 * 第三节):工人调 8792 从没传过语气参数,默认音色(火山大模型 2.0 的 `zh_female_vv_uranus_bigtts`)
 * 全靠自己揣摩 —— 同一句「好的」有时像在赌气。而模型其实知道这句话该用什么语气,
 * 只是我们从来没问它、也没把这个意图传下去。
 *
 * 所以:**回话里每句开头带一个语气标签**,念之前剥掉,语气本身接到三个地方 ——
 * 声音(8792 → 火山)、形象(手机 Live2D 的表情)、字幕(**不显示标签**)。
 *
 * ## 为什么一处定义
 *
 * 这一格要穿过四个互不 import 的子目录(工人 / 8792 / 手机 / 插件的人设),
 * 按 AGENTS.md「接缝与卡的规矩」它得有一个主人。主人是**这个文件**:
 *   · 短列表与别名在这里(id 是英文、跨进程不变;标签是中文、给模型写与给人看);
 *   · 剥标签在这里(`parseToneTag` / `stripToneTags`);
 *   · 8792 那头的 `server/config/toneMap.json`、手机那头的 `live2d/toneExpressions.json`
 *     都**按 id 建表**,改这里的 id 就要改那两张表(有对照用例:tone-1002.test.ts / tts-tone.test.mjs)。
 *
 * ## 三条纪律
 *
 *   ① **id 不超过十个**。再多模型挑不准,映射表也养不住(STELLA #501 的账:没有对应就退回中性)。
 *   ② **认不得的标签不吞字**。`[兴高采烈]好。` → 语气缺席,`[兴高采烈]好。` 原样留着念出去。
 *      吞掉的话她那句话就少了几个字,而那比语气不对严重得多。
 *   ③ **只认句首那一个**。中间冒出来的由 `stripToneTags` 扫掉(模型偶尔会在句中再写一个),
 *      但不拿它当这一句的语气 —— 一句话一个语气。
 *
 * 纯函数,不认识 LiveKit、不认识 fetch。
 */

/**
 * 短列表。**七个**,id 是英文(跨进程那一格就是它),标签是中文(模型写的是标签)。
 *
 * 挑这七个的理由:电话里真用得上的就这几种 —— 平时(calm)、她办成了(happy)、
 * 她问他好不好(care)、她办不成(sorry)、她催他(urgent)、夜里 / 他小声(soft)、
 * 她在问他一件事(ask)。再细分下去模型挑不准,火山那头也没有对应的 emotion。
 */
export const TONES = ['calm', 'happy', 'care', 'sorry', 'urgent', 'soft', 'ask'] as const

export type Tone = (typeof TONES)[number]

/** id → 中文标签。**模型写的是标签**(句首 `[关心]`),日志里也念这个。 */
export const TONE_LABELS: Record<Tone, string> = {
  calm: '平静',
  happy: '高兴',
  care: '关心',
  sorry: '歉意',
  urgent: '着急',
  soft: '轻声',
  ask: '疑问',
}

/**
 * 别名。模型不一定逐字写标签 —— 09-23 那几通里它写过「中性」「开心」「抱歉」。
 * **只收那几个真见过 / 一眼就是同一个意思的**,不做近义词推断(推错比缺席糟)。
 */
const TONE_ALIASES: Readonly<Record<string, Tone>> = {
  中性: 'calm', 平淡: 'calm', neutral: 'calm',
  开心: 'happy', 高兴: 'happy', 愉快: 'happy',
  关心: 'care', 体贴: 'care', 温柔: 'care', gentle: 'care',
  歉意: 'sorry', 抱歉: 'sorry', 道歉: 'sorry', sad: 'sorry',
  着急: 'urgent', 急: 'urgent', 催: 'urgent',
  轻声: 'soft', 小声: 'soft', 悄悄: 'soft',
  疑问: 'ask', 问: 'ask', 询问: 'ask',
}

/** 那一句自然语言语气指令最多几个字。再长就不是「语气」而是在改台词了。 */
export const TONE_NOTE_MAX = 20

/** 句首那个标签能有多长(标签本身,不含指令)。写不下「兴高采烈」正是想要的。 */
const TONE_WORD_MAX = 8

/**
 * 任意输入 → 合法 id。认不得回 `undefined`(**不退回 calm**)——
 * 「没说」与「说了平静」是两件事:没说的那一句不该把 context_texts 占掉。
 */
export function normalizeTone(raw: unknown): Tone | undefined {
  if (typeof raw !== 'string') return undefined
  const said = raw.trim()
  if (said === '') return undefined
  const lower = said.toLowerCase()
  if ((TONES as readonly string[]).includes(lower)) return lower as Tone
  const byLabel = (Object.keys(TONE_LABELS) as Tone[]).find(tone => TONE_LABELS[tone] === said)
  if (byLabel !== undefined) return byLabel
  return TONE_ALIASES[said] ?? TONE_ALIASES[lower]
}

/** 拼一个标签。人设里的例子、用例、日志都用它,免得三处各写一遍方括号。 */
export function toneTagOf(tone: Tone, note?: string): string {
  const said = (note ?? '').trim()
  return said === '' ? `[${TONE_LABELS[tone]}]` : `[${TONE_LABELS[tone]}|${said}]`
}

/**
 * 一个标签:`[关心]`、`【关心】`、`[关心|说慢一点]`、`[关心:说慢一点]`(全角冒号也认)。
 * 分隔符用竖线或冒号:中文里句首很少真的写方括号,而这三个符号在排版上都不会单独出现。
 */
const TAG = new RegExp(
  `[\\[\u3010]\\s*([^\\]\u3011\\n|\uFF5C:\uFF1A]{1,${TONE_WORD_MAX}})`
  + `\\s*(?:[|\uFF5C:\uFF1A]\\s*([^\\]\u3011\\n]{0,80}))?\\s*[\\]\u3011]`,
)

export interface SpokenTone {
  tone?: Tone
  /** ≤ {@link TONE_NOTE_MAX} 字的自然语言语气指令。超了就当没写。 */
  note?: string
}

export interface ToneParse extends SpokenTone {
  /** 剥掉标签之后的话。认不得的标签原样留在里面(纪律 ②)。 */
  text: string
}

function noteOf(raw: string | undefined): string | undefined {
  const said = (raw ?? '').trim()
  if (said === '' || said.length > TONE_NOTE_MAX) return undefined
  return said
}

/**
 * 句首那一个。认得出就摘走并剥掉;认不得就**一个字都不动**。
 */
export function parseToneTag(text: string): ToneParse {
  const head = text.replace(/^\s+/, '')
  const matched = TAG.exec(head)
  if (matched === null || matched.index !== 0) return { text: text.trim() }
  const tone = normalizeTone(matched[1])
  if (tone === undefined) return { text: text.trim() }
  const note = noteOf(matched[2])
  return {
    tone,
    ...(note === undefined ? {} : { note }),
    text: head.slice(matched[0].length).trim(),
  }
}

/**
 * 把**所有**认得出的标签扫掉(句首那个也在内)。字幕、纪要、日志这三份用它 ——
 * 屏幕上出现一个「[关心]」会被当成乱码,而它本来是给嘴和脸看的。
 */
export function stripToneTags(text: string): string {
  const all = new RegExp(TAG.source, 'g')
  return text.replace(all, (whole, word: string) => (normalizeTone(word) === undefined ? whole : '')).trim()
}
