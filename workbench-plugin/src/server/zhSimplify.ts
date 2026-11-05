/**
 * 繁 → 简(2026-09-21)。**一行 I/O 都没有**,只有字形。
 *
 * ## 这一层为什么必须存在(先试过参数,按不住)
 *
 * whisper.cpp 转中文普通话时,**出来是繁体还是简体是它自己挑的**,命令行参数按不住。
 * 本机真跑(全表在 `docs/交接-0922-转写简繁.md` 第二节):
 *
 * | 试的是什么 | 46 秒口播 A | 39 秒口播 B |
 * |---|---|---|
 * | `-l zh`(现在的写法) | **繁体**(36.8% 的汉字是繁体) | **简体**(0%) |
 * | `--prompt「以下是简体中文普通话的转写,请使用简体中文。」` | 繁体 | — |
 * | 同上 + `--carry-initial-prompt` | 繁体 | — |
 * | `--prompt「今天天气不错……」`(无关简体长句)+ carry | 繁体 | — |
 * | `--prompt「简体中文。」+ carry` | **简体** | 简体 |
 * | `--prompt「请用简体中文输出。」+ carry` | **简体** | 简体 |
 *
 * 三条结论:
 * 1. **同一个模型、同一条命令,两段音频一繁一简** —— 这不是"whisper 输出繁体",
 *    是"whisper 随音频挑字形"。固定参数治不了它。
 * 2. **提示词能不能把它按成简体,看你写的是哪一句,而且没有道理可讲**:
 *    「以下是简体中文普通话的转写,请使用简体中文。」(长句,最像人话的那一句)——**没用,还是繁体**;
 *    「今天天气不错……」(一整段无关的简体)——**没用**;
 *    「简体中文。」(四个字)——**这一次成了**。加不加 `--carry-initial-prompt` 都一样。
 *    提示词改的是解码时的 token 分布,不是字形开关,所以它给不了保证。
 * 3. **顺带还会晃动识别质量,两个方向都有**(对着念稿子算字级编辑距离):
 *    口播 A 裸跑错 12 字、提示词逼简体错 14 字;
 *    口播 B 裸跑错 6 字,`--prompt「简体中文。」` 错 5 字,`--prompt「请用简体中文输出。」` 错 **12 字**
 *    (「完播率」被听成「玩玻璃」)。**为了字形去晃解码,换来的是一个没有保证的结果。**
 *
 * 所以:**转写照常跑(参数一个字不动),出来之后量一下,是繁体再转字形。**
 * 转换发生在文字层,碰不到解码,识别质量一个字不变。
 *
 * ## 用的是 OpenCC 的 `t2s`,不是 `tw2s`
 *
 * `opencc-js`(MIT;字表来自 `opencc-data`,Apache-2.0),**纯 JS、没有网络、没有原生依赖**,
 * 整份字表打进 `lib/index.js`(离线可用,这条是产品红线 —— 逐字稿不出这台机器)。
 *
 * 选 `t2s`(`TSPhrases` + `TSCharacters`)而不是 `tw2s`,理由是真跑量出来的:
 * `tw2s` 会把台湾**用词**反向换成大陆用词(「軟體」→「软件」),而且它**会动一份本来就是简体的文本**
 * —— 真跑那段纯简体转写,`tw2s` 动了 3 个字,`t2s` 一个字都没动。
 * 我们只想修字形,不想替人改用词,更不能在"没检测到繁体"的那一支上留下任何动文字的可能。
 *
 * ## 阈值 10%:为什么不是"有一个繁体字就转"
 *
 * 因为**内容里本来就可能有繁体字**:港台品牌名(「誠品書店」)、一句原样引用、一个招牌。
 * 那几个字是他要的东西,替他改掉就是改内容。真跑量出来的分档很干净:
 *
 * | 样本 | 繁体字占比 |
 * |---|---|
 * | whisper 出的繁体转写(真跑) | **36.8%** |
 * | 纯繁体的人写的一段话 | 21.8% |
 * | ——— 10% 这条线 ——— | |
 * | 简体里夹一个繁体品牌名 | 3.8% |
 * | 简体里夹一句繁体引用 | 3.7% |
 * | whisper 出的简体转写(真跑) | 0% |
 *
 * 线划在 10%:上面那一档最低 21.8%,下面那一档最高 3.8%,中间空得很开,
 * 挪到 8% 或 15% 结论都一样。**整份一起判,不逐行判** —— 逐行判会在同一份逐字稿里半边繁半边简。
 */
import * as OpenCC from 'opencc-js/t2cn'

/**
 * 繁体字占汉字的比例到这条线就转。真跑分档见文件头那张表(上面一档 21.8%,下面一档 3.8%)。
 * **`>=`,不是 `>`**。
 */
export const TRAD_RATIO_THRESHOLD = 0.1

/** 只换字形的那一支:`t2s`。对简体是恒等的(用例钉着)。 */
const convert: (text: string) => string = OpenCC.Converter({ from: 't', to: 'cn' })

/** 汉字才进分母:标点、数字、英文、空白都不算。 */
const HAN = /\p{Script=Han}/u

export interface TradMeasure {
  /** 一共多少个汉字。 */
  han: number
  /** 其中多少个字**单看就是繁体**(转过去跟自己不一样)。 */
  traditional: number
  /** `traditional / han`;一个汉字都没有时是 0(**不除以零**)。 */
  ratio: number
}

/**
 * 量一段文字里繁体字占多少。
 *
 * **按字量,不按词量**:词级的替换(`TSPhrases`)在这里不参与,
 * 免得「一个词被换掉」在分子里算成好几个字,把占比撑高。
 */
export function measureTraditional(text: string): TradMeasure {
  let han = 0
  let traditional = 0
  for (const ch of text) {
    if (!HAN.test(ch)) continue
    han++
    if (convert(ch) !== ch) traditional++
  }
  return { han, traditional, ratio: han === 0 ? 0 : traditional / han }
}

/** 繁 → 简。**只换字形,不换用词**(「軟體」→「软体」,不是「软件」)。 */
export function toSimplified(text: string): string {
  return convert(text)
}

/** 这一步的结论:转没转、当时量出来是多少。产物头上那句话与日志那一行都照它写。 */
export interface SimplifyOutcome {
  /** 到底转没转。**转了才记日志**。 */
  converted: boolean
  measure: TradMeasure
}

export interface SimplifyResult extends SimplifyOutcome {
  /** 转过的(或原样的)文字。 */
  text: string
}

/** 超过阈值才转;不到线**一个字都不动**(那几个繁体字是内容本身)。 */
export function simplifyIfTraditional(text: string): SimplifyResult {
  const measure = measureTraditional(text)
  if (measure.ratio < TRAD_RATIO_THRESHOLD) return { text, converted: false, measure }
  return { text: convert(text), converted: true, measure }
}

/**
 * 逐字稿整份一起判。**时间戳一个都不动** —— 这张卡改的是字形,不是时间轴。
 *
 * 判的是**所有行拼起来**的那个占比:单看一行只有「好。」两个字的,
 * 不该因为自己这一行没有繁体字就留在繁体那一半里。
 */
export function simplifyCues<T extends { text: string }>(
  cues: readonly T[],
): SimplifyOutcome & { cues: T[] } {
  const measure = measureTraditional(cues.map(cue => cue.text).join('\n'))
  if (measure.ratio < TRAD_RATIO_THRESHOLD) return { cues: [...cues], converted: false, measure }
  return { cues: cues.map(cue => ({ ...cue, text: convert(cue.text) })), converted: true, measure }
}

/** 占比写成人看的那种百分比(一位小数;整数就不写那个 `.0`,免得阈值印成「10.0%」)。 */
export function percentOf(ratio: number): string {
  return `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`
}

/** 转了之后记的那一行。**只在真转了的时候用**。 */
export function simplifyLogLine(measure: TradMeasure): string {
  return `转写出来是繁体(${measure.han} 个汉字里 ${measure.traditional} 个是繁体,占 ${percentOf(measure.ratio)},`
    + `超过 ${percentOf(TRAD_RATIO_THRESHOLD)} 这条线),已经按 OpenCC 的繁→简字表转成简体(只换字形,没改用词)。`
}
