/**
 * 中文断句(2026-09-18)。为什么要有它:框架自带那个只认英文的 `. ! ?`,
 * 中文句号一个都不认 —— 一整段话才合成一次,首字延迟等于整段的合成时间。
 */
import { describe, expect, it } from 'vitest'
import { ChineseSentenceTokenizer, MIN_PIECE, SOFT_BREAK_AT, splitChineseSentences } from '../src/tts/sentences.ts'

const OPENING
  = '你好,很高兴认识你,我是你的专属事务官。我能够帮助你更轻松、更有条理的经营你的事业,为了后面的工作能顺利开展,我需要对你和你正在做的事有一些了解,首先,你希望我怎么称呼你?'

describe('splitChineseSentences', () => {
  it('中文句号断得开(框架那个断不开,这正是这个文件存在的理由)', () => {
    expect(splitChineseSentences('你好,这是第一句。这是第二句。')).toEqual(['你好,这是第一句。', '这是第二句。'])
  })

  it('开场白:第一块短到能立刻出声,而且一个字都没丢', () => {
    const pieces = splitChineseSentences(OPENING)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces[0]?.length).toBeLessThanOrEqual(SOFT_BREAK_AT + 4)
    expect(pieces.join('')).toBe(OPENING)
  })

  it('够长了才在逗号处断:短句不切碎', () => {
    expect(splitChineseSentences('好,记下了。')).toEqual(['好,记下了。'])
    const long = splitChineseSentences('这件事我先去问一下对方那边的排期和预算,问清楚了再回来告诉你。')
    expect(long.length).toBe(2)
    expect(long[0]?.endsWith(',')).toBe(true)
  })

  it('太短的一块并进相邻那块(「好。」不单独合成一次)', () => {
    const pieces = splitChineseSentences('好。我这就去办这件事情。')
    expect(pieces).toEqual(['好。我这就去办这件事情。'])
    expect(pieces.every(piece => piece.length >= MIN_PIECE)).toBe(true)
  })

  it('空白与空串:不产出空块', () => {
    expect(splitChineseSentences('   ')).toEqual([])
    expect(splitChineseSentences('')).toEqual([])
  })

  it('接进框架那一层:tokenize 与纯函数同一个结果', () => {
    const tokenizer = new ChineseSentenceTokenizer()
    expect(tokenizer.tokenize(OPENING)).toEqual(splitChineseSentences(OPENING))
    // stream() 要能拿出来(它是框架的 BufferedSentenceStream,这里只确认接得上)
    const stream = tokenizer.stream()
    expect(typeof stream.pushText).toBe('function')
    stream.close()
  })

  /**
   * 2026-09-23 加的两个口子。两个都**缺省缺席**:不配就和以前一字不差。
   */
  it('软断点门槛可调:调小了第一句更短(更早出声,代价是接缝多)', () => {
    const text = '我看了一下你今天的安排,上午有两件事要确认,下午空着。'
    const wide = splitChineseSentences(text)
    const narrow = splitChineseSentences(text, 6)
    expect(narrow.length).toBeGreaterThan(wide.length)
    expect((narrow[0] as string).length).toBeLessThan((wide[0] as string).length)
    // 一个字都不丢:两种切法接起来都等于原文。
    expect(narrow.join('')).toBe(text)
    expect(wide.join('')).toBe(text)
    // 门槛读不懂(0、负数、NaN)就退回默认,不把一句话切成一个字一块。
    expect(splitChineseSentences(text, 0)).toEqual(wide)
    expect(splitChineseSentences(text, Number.NaN)).toEqual(wide)
  })

  it('onFirstText 只叫一次,而且一个字都不吞', async () => {
    let calls = 0
    const tokenizer = new ChineseSentenceTokenizer({ onFirstText: () => { calls += 1 } })
    const stream = tokenizer.stream()
    stream.pushText('你好,')
    expect(calls).toBe(1)
    stream.pushText('这是第一句。这是第二句。')
    expect(calls).toBe(1)
    stream.endInput()
    const pieces: string[] = []
    for await (const event of stream) pieces.push(event.token)
    expect(pieces.join('')).toBe('你好,这是第一句。这是第二句。')
  })

  it('onFirstText 自己抛也不吞她的话', () => {
    const tokenizer = new ChineseSentenceTokenizer({ onFirstText: () => { throw new Error('炸了') } })
    const stream = tokenizer.stream()
    expect(() => stream.pushText('你好。')).not.toThrow()
    stream.close()
  })
})
