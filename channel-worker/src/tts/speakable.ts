/**
 * 送去合成之前把字清一遍(2026-09-24 真机第五轮)。
 *
 * 维护者:「有几句 TTS 听上去很诡异,是语气不是内容」。查实:工人调 8792 从没传过 emotion,
 * 默认音色是火山「大模型 2.0」那一类(`zh_female_vv_uranus_bigtts`),它**按上下文自己揣摩语气** ——
 * 她说的话里常带「——」、「」、括号、省略号,还把 Ben 写成「B e n」,这些在字面上是排版,
 * 到了合成那头就成了拖长、顿住、换调门、一个字母一个字母地念。
 *
 * 这里只改**送去合成的那一份**;字幕、对话历史、日志照原样(调用方拿原文排字幕)。
 * 纯函数,不认识 LiveKit。
 *
 * 2026-10-02(卡「声音与形象跟着话走」)多了一件事:**句首那个语气标签在这一层剥掉**
 * ({@link speakableSpeech})。非在这一层不可 —— 下面 `DROPPED` 会把 `[` `]` 去掉、
 * 把「关心」两个字留下念出去,那正是这张卡最怕的声音。契约在 tone.ts。
 */
import { parseToneTag, stripToneTags, type SpokenTone } from './tone.ts'

/** 破折号、省略号 → 一个自然的停顿(逗号)。 */
const PAUSES = /\u2014\u2014|\u2014|--|\u2026\u2026|\u2026|\.{3,}/g

/** 引号、书名号、方括号这类只是排版的符号:直接去掉,字留着。 */
const DROPPED = /[\u300C\u300D\u300E\u300F\u201C\u201D"\u300A\u300B\u3010\u3011[\]`*#]/g

/** 括号:里面的话留着,前后换成逗号(「只在这台电脑上」前后停一下,不换调门)。 */
const BRACKETS = /[(\uFF08]([^()\uFF08\uFF09]*)[)\uFF09]/g

/**
 * 拆开写的字母(「B e n」「B-e-n」「B.E.N」)→ 合成一个词。至少两个单字母才算。
 * 前后不能紧挨着别的字母,免得把正常的英文单词误并。
 */
const SPELLED = /(?<![A-Za-z])[A-Za-z](?:[\s.\-\u00B7]+[A-Za-z](?![A-Za-z]))+/g

/** 字母之间的连字符 / 下划线(desktop-workbench)→ 空格,念成两个词而不是「杠」。 */
const JOINERS = /(?<=[A-Za-z0-9])[-_](?=[A-Za-z0-9])/g

/** 中文逗号(停顿统一用它)。 */
const COMMA = '\uFF0C'

/** 送去合成的那一句:清洗过的字 + 这一句的语气意图。 */
export interface SpeakablePiece extends SpokenTone {
  text: string
}

/**
 * **合成那条路的入口**:摘语气 → 剥标签 → 清洗。
 *
 * 顺序是死的:先摘再清洗。倒过来的话 `DROPPED` 已经把方括号吃掉了,`[关心]好。` 变成
 * `关心好。` —— 语气丢了,还多念两个字。
 */
export function speakableSpeech(text: string): SpeakablePiece {
  const parsed = parseToneTag(text)
  // 句中再冒出来的那些也扫掉(模型偶尔会写第二个);认不得的照样留着念。
  const said = cleanForSpeech(stripToneTags(parsed.text))
  return {
    ...(parsed.tone === undefined ? {} : { tone: parsed.tone }),
    ...(parsed.note === undefined ? {} : { note: parsed.note }),
    text: said,
  }
}

/** 只要清洗过的那几个字(老调用方与老用例走这条;与 09-24 逐字同行为)。 */
export function speakableText(text: string): string {
  return speakableSpeech(text).text
}

function cleanForSpeech(text: string): string {
  let out = text
  out = out.replace(SPELLED, match => match.replace(/[\s.\-\u00B7]+/g, ''))
  out = out.replace(JOINERS, ' ')
  out = out.replace(BRACKETS, `${COMMA}$1${COMMA}`)
  out = out.replace(/[()\uFF08\uFF09]/g, COMMA)
  out = out.replace(DROPPED, '')
  out = out.replace(PAUSES, COMMA)
  // 清理:连着的停顿并成一个;停顿紧跟句末标点就只留句末那个;开头的停顿去掉。
  out = out.replace(/\s*\uFF0C\s*/g, COMMA)
  out = out.replace(/([,\uFF0C\u3001])(?:\s*[,\uFF0C\u3001])+/g, '$1')
  out = out.replace(/[,\uFF0C]+(?=[\u3002!?\uFF01\uFF1F;\uFF1B:\uFF1A])/g, '')
  out = out.replace(/([\u3002!?\uFF01\uFF1F;\uFF1B:\uFF1A])[,\uFF0C]+/g, '$1')
  out = out.replace(/^[,\uFF0C\s]+/, '')
  return out.trim()
}
