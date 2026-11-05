/**
 * 「以后都这样」与「这回这样」的分界(2026-09-23,Ben 第五通:他三次说「这个我记着了/记住」,
 * 而工人**什么都没落盘**,下一通照旧)。
 *
 * 规矩一句话:**长期偏好才落人设,只管这一通的不落**。为什么要有这条界:
 * 他在电话里说的话十句里有九句是这一通的上下文(「先别说这件事」「等会儿再讲」),
 * 把它们全写进人设,下一通她就会带着一屋子过期的指令开口 —— 那比不记更糟。
 *
 * 判断写成**可测的规则**而不是交给模型:模型每次判得不一样,而「她说记住了到底记没记」
 * 是这张卡最要紧的一条诚实(D13)。规则判不准的那一类由工具的回话如实说出来,
 * 不偷偷落一条、也不偷偷丢一条。
 *
 * 这个文件不碰网络、不碰磁盘。
 */

/**
 * 「从今往后」那一类的说法。他真要立一条长期规矩时,嘴里基本会出现其中一个。
 *
 * ★ **这张表以插件的提示词为源头,只许多不许少**(2026-10-22,卡「契约对照测试补齐」):
 * `workbench-plugin/src/server/rules.ts` 的 `explicitRuleOf` 认哪几个词,这张表就得有哪几个,
 * 由 `channel-worker/tests/prefs-rules-sync.test.ts` 读插件源码比对(漂了那条红给你看)。
 * 工人比插件多认的「默认 / 总是 / 一直 / 每回 / 从今以后 / 从此 / 下次开始」是这一头自己的词,
 * 照留(电话里判「以后都这样」够用,且 `judgePreference` 的现有用例钉着它们)。
 *
 * **「记住」「记着」不在这张表里,是对照里唯一允许缺的一个**:他说「这个你记住」时指的常常是
 * 这一通里的一件事(「记住我说的那三条」),而不是「以后都这样」。插件那边对「记住」是**条件认**
 * (`explicitRuleOf` 要求「记住,」后跟标点 / 空格、再接一个要求);这里整句 contains,放进来
 * 会把这一通的事写成长期规矩 —— 那是 09-23 事故的形状。要落长期,得有一个指向未来的词。
 */
export const LONG_TERM_WORDS = [
  '以后', '往后', '从今以后', '从现在起', '从今天起', '从此', '今后',
  '每次', '每回', '每一次', '一直', '默认', '总是', '一律',
  '下次开始', '以后都', '永远',
] as const

/** 「别再……」这一类:否定式的长期规矩,同样算。以插件那份为源头,只许多不许少。 */
export const NEGATIVE_LONG_TERM_WORDS = ['别再', '不要再', '不许再', '再也别', '再也不要', '以后别', '以后不要'] as const

/** 只管这一通的说法。出现这些词就**一定不落长期**,哪怕句子里也有「以后」。 */
const ONE_CALL_WORDS = [
  '这次', '这一次', '这回', '这一通', '这通', '就这一次', '这条', '刚才那件', '今天先',
] as const

export type PreferenceVerdict =
  /** 长期偏好:该写进人设。 */
  | { kind: 'long_term' }
  /** 只管这一通:不写,如实说一句。 */
  | { kind: 'one_call', reason: string }
  /** 看不出是哪一种:不写,**问他一句**再说(绝不替他决定)。 */
  | { kind: 'unclear', reason: string }

/**
 * 他这句话该不该进人设。
 *
 * 顺序是**先看「只管这一通」再看「以后」**:「这次以后再说」里两个词都有,
 * 而它显然不是一条长期规矩 —— 拿不准的时候宁可不写(写错一条要他手动去仓库里删)。
 */
export function judgePreference(text: string): PreferenceVerdict {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'unclear', reason: '这句话是空的' }
  for (const word of ONE_CALL_WORDS) {
    if (trimmed.includes(word)) {
      return { kind: 'one_call', reason: `他说的是「${word}」,那只管这一通,没往人设里写` }
    }
  }
  for (const word of [...LONG_TERM_WORDS, ...NEGATIVE_LONG_TERM_WORDS]) {
    if (trimmed.includes(word)) return { kind: 'long_term' }
  }
  return {
    kind: 'unclear',
    reason: '这句话里没有「以后 / 每次 / 别再」这类指向以后的说法,看不出是长期规矩还是只管这一通',
  }
}

/**
 * 写进人设的那一行。**用他的原话**,只掐掉多余空白、砍到一行以内。
 * 前面不加「Ben 说」之类的转述 —— 转述一次就走样一次,而这一行下一通会被她当规矩读。
 */
export function preferenceLine(text: string, day: string): string {
  const one = text.trim().replace(/\s+/g, ' ').slice(0, 120)
  return `- ${one}(${day})`
}
