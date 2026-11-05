// @vitest-environment node
/**
 * 繁 → 简(src/server/zhSimplify.ts)。2026-09-21 这张卡。
 *
 * ## 为什么要有这一层(先说清楚,免得后人以为是多此一举)
 *
 * **whisper.cpp 转中文普通话,输出的是繁体还是简体,是它自己挑的,参数按不住。**
 * 本机真跑(交接-0922-转写简繁 第二节有全表):同一份 `ggml-base`、同一条命令,
 * 一段 46 秒的口播出来 **36.8% 的字是繁体**;另一段 39 秒的口播出来 **一个繁体字都没有**。
 * 提示词按不住它:`--prompt「以下是简体中文普通话的转写,请使用简体中文。」` 出来**还是繁体**;
 * 换成四个字的 `--prompt「简体中文。」` 这一次成了 —— 哪一句管用没有道理可讲,
 * 因为提示词改的是解码时的 token 分布,不是字形开关。而且它会晃动识别质量,两个方向都有
 * (口播 B 裸跑错 6 字,`--prompt「请用简体中文输出。」` 错 12 字,「完播率」→「玩玻璃」)。
 *
 * 所以:**转写照常跑,出来之后量一下,是繁体再转。**
 *
 * ## 两条纪律
 *
 * 1. **只换字形,不换用词。** 用的是 OpenCC 的 `t2s`(`TSPhrases` + `TSCharacters`),
 *    **不是** `tw2s` —— `tw2s` 会把台湾用词反向换成大陆用词,而且实测它会**改动一份本来就是简体的文本**
 *    (真跑 clip2 那段纯简体,`tw2s` 动了 3 个字,`t2s` 一个字都没动)。
 *    这一条是这个文件里最要紧的一条:**转换器对简体文本必须是恒等的**。
 * 2. **整份一起判,不逐行判。** 逐行判会在同一份逐字稿里半边繁半边简。
 */
import { describe, expect, it } from 'vitest'
import {
  TRAD_RATIO_THRESHOLD, measureTraditional, simplifyCues, simplifyIfTraditional,
  simplifyLogLine, toSimplified,
} from '../src/server/zhSimplify.ts'

/** 真跑样本:`ggml-base` + `-l zh` 对 46 秒口播出来的那一段(原样,含它自己的错字)。 */
const 真跑繁体 = '大家好,今天這條我們只講一件事,一條比計的內容框架到底是怎麼搭出來的,開頭三秒必須給一個勾子,'
  + '要麼拋結論,要麼提一個讓人心裡一緊的問題,正文分三塊,先說問題有多常見,再說你採過哪個坑,'
  + '最後給一個今天就能做的動作,結尾不要說謝謝觀看,要給一個收藏的理由,比如這份清單你隨時能翻回來看,'
  + '節奏上,每十五秒換一個小話題,與素比平時快一點,停頓留在轉折的地方,記住,框架式骨頭,細節式肉,'
  + '骨頭搭不對,肉在好野力步起來。'

/** 真跑样本:同一个模型、同一条命令,另一段 39 秒口播出来的那一段 —— **本来就是简体**。 */
const 真跑简体 = '这期我们聊一个很多人都会采得坑,做内容之前没有把账号定位想清楚,你要先回答三个问题,'
  + '你是说给谁听的,他们现在最焦虑什么,你凭什么比别人说的好,这三个问题答不上来。选题就会越做越散,'
  + '粉丝也记不住你是干什么的,我的建议是先做二十七同一个方向的内容,把一件事说头,再考虑过,'
  + '数据不好看不要急着换赛道,先看完播率,完播不行就是开头的问题,不是方向的问题。'

/** 简体里夹了几个繁体专名 —— **这种不许动**,那几个字是内容本身。 */
const 夹专名 = '这次我们去台湾出差,顺便看了一下誠品書店的选品逻辑,回来写了一份复盘。'
  + '整体感受是他们的陈列比我们细致很多,值得学。'

describe('量:繁体字占多少', () => {
  it('真跑那段繁体转写,占比 36.8%', () => {
    const m = measureTraditional(真跑繁体)
    expect(m.han).toBe(182)
    expect(m.traditional).toBe(67)
    expect(m.ratio).toBeCloseTo(0.368, 3)
  })

  it('真跑那段简体转写,一个繁体字都没有', () => {
    const m = measureTraditional(真跑简体)
    expect(m.traditional).toBe(0)
    expect(m.ratio).toBe(0)
  })

  it('只数汉字:标点、数字、英文不进分母', () => {
    const m = measureTraditional('OK 2026 年,好。')
    expect(m.han).toBe(2) // 「年」「好」
  })

  it('一个汉字都没有时占比是 0,不除以零', () => {
    expect(measureTraditional('OK 123 !!!')).toEqual({ han: 0, traditional: 0, ratio: 0 })
  })
})

describe('转:只换字形', () => {
  it('繁体样本 → 简体', () => {
    expect(toSimplified(真跑繁体)).toContain('今天这条我们只讲一件事')
    expect(toSimplified('謝謝觀看')).toBe('谢谢观看')
  })

  /**
   * ★ 这一条是选 `t2s` 而不是 `tw2s` 的理由(真跑量出来的):
   * `tw2s` 对这段纯简体文本动了 3 个字,`t2s` 一个字都没动。
   * 转换器对简体必须是恒等的 —— 不然「没检测到繁体也没事,转一遍总没坏处」这种想法就会出事。
   */
  it('★ 简体样本一个字都不动(恒等)', () => {
    expect(toSimplified(真跑简体)).toBe(真跑简体)
  })

  it('不改用词:台湾说法照旧,只把字形换过来', () => {
    // 「軟體」这个词在 tw2s 下会变成「软件」;t2s 只换字形 → 「软体」。
    expect(toSimplified('軟體')).toBe('软体')
  })
})

describe('判:超过阈值才转', () => {
  it('阈值是 10%,写死在常量里', () => {
    expect(TRAD_RATIO_THRESHOLD).toBe(0.1)
  })

  it('繁体样本(36.8%)→ 转', () => {
    const r = simplifyIfTraditional(真跑繁体)
    expect(r.converted).toBe(true)
    expect(r.text).toContain('开头三秒必须给一个勾子')
  })

  it('简体样本(0%)→ 一个字都不动', () => {
    const r = simplifyIfTraditional(真跑简体)
    expect(r.converted).toBe(false)
    expect(r.text).toBe(真跑简体)
  })

  /**
   * ★ 混合样本:简体里夹着「誠品書店」这种繁体专名(3.8%),**不转**。
   * 阈值存在的全部理由就是这一条:那几个字是他要的内容,不是 whisper 的毛病。
   */
  it('★ 简体夹繁体专名(3.8%,不到线)→ 不转,「誠品書店」四个字原样留着', () => {
    const m = measureTraditional(夹专名)
    expect(m.ratio).toBeLessThan(TRAD_RATIO_THRESHOLD)
    const r = simplifyIfTraditional(夹专名)
    expect(r.converted).toBe(false)
    expect(r.text).toContain('誠品書店')
  })

  it('刚好等于阈值也转(≥,不是 >)', () => {
    // 十个汉字里一个繁体 → 正好 10%。
    const r = simplifyIfTraditional('这是一句话裡面有十个字')
    expect(r.measure.ratio).toBeCloseTo(1 / 11, 5) // 十一个汉字里一个,还不到线
    expect(r.converted).toBe(false)
    const 正好 = simplifyIfTraditional('這是一句话有十个字')
    expect(正好.measure.ratio).toBeGreaterThanOrEqual(TRAD_RATIO_THRESHOLD)
    expect(正好.converted).toBe(true)
  })
})

describe('整份一起判,不逐行判', () => {
  const 繁体逐字稿 = [
    { start: 0, end: 3, text: '大家好,今天這條我們只講一件事,' },
    { start: 3, end: 6, text: '開頭三秒必須給一個勾子。' },
    { start: 6, end: 9, text: '好。' }, // 这一行单看一个繁体字都没有
  ]

  it('★ 整份超过线时,每一行都转 —— 包括单看是简体的那一行', () => {
    const r = simplifyCues(繁体逐字稿)
    expect(r.converted).toBe(true)
    expect(r.cues[0]?.text).toBe('大家好,今天这条我们只讲一件事,')
    expect(r.cues[1]?.text).toBe('开头三秒必须给一个勾子。')
    expect(r.cues[2]?.text).toBe('好。') // 本来就没得转,但也没被弄坏
  })

  it('时间戳一个都不动', () => {
    const r = simplifyCues(繁体逐字稿)
    expect(r.cues.map(c => [c.start, c.end])).toEqual([[0, 3], [3, 6], [6, 9]])
  })

  it('整份不到线时,原样返回(繁体专名一个字不变)', () => {
    const 简体逐字稿 = [
      { start: 0, end: 4, text: '这次我们去台湾出差,顺便看了一下誠品書店的选品逻辑,' },
      { start: 4, end: 8, text: '回来写了一份复盘。整体感受是他们的陈列比我们细致很多,值得学。' },
    ]
    const r = simplifyCues(简体逐字稿)
    expect(r.measure.ratio).toBeLessThan(TRAD_RATIO_THRESHOLD)
    expect(r.converted).toBe(false)
    expect(r.cues[0]?.text).toContain('誠品書店')
  })

  it('空逐字稿不炸', () => {
    expect(simplifyCues([])).toEqual({ cues: [], converted: false, measure: { han: 0, traditional: 0, ratio: 0 } })
  })
})

describe('日志:转了就记一行', () => {
  it('一行里有占比、阈值、和「转成简体」这句话', () => {
    const line = simplifyLogLine(measureTraditional(真跑繁体))
    expect(line).toContain('36.8%')
    expect(line).toContain('10%')
    expect(line).toContain('简体')
  })
})
