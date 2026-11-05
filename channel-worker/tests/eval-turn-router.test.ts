/**
 * 离线对照用的那两件:**从日志里配出题目**、**把成绩算出来**(src/evalLog.ts)。
 *
 * 为什么要钉它:整份评估的可信度全押在「标注是怎么来的」这一件事上 ——
 * 配错一行,准确率就是编的。下面的日志片段是**真机日志的形状**(逐行照抄那几种前缀)。
 */
import { describe, expect, it } from 'vitest'
import { formatScore, parseEvalSamples, scoreOutcomes } from '../src/evalLog.ts'

/** 真机日志的样子(前缀、全角冒号、「、」分隔的工具名都照抄)。 */
const LOG = [
  '[channel-worker] 进房:ws://127.0.0.1:7880 / wb-room,身份 wb-channel-worker',
  '[channel-worker] 她说:喂,我在,你说。',
  '[channel-worker] 他说(ASR):你是谁？',
  '[channel-worker] 回合计时 #3 {"round":3,"at":1790138286736,"asr_ms":264}',
  '[channel-worker] 他说(ASR):什么事啊？',
  '[channel-worker] 工具 wb_list_doing → 成了:待办:音色可配置。',
  '[channel-worker] 她调了工具:wb_list_doing',
  '[channel-worker] 他说(ASR):可以了，我们验下一个吧？你能不能换音色？',
  '[channel-worker] 她调了工具:wb_decide_item、wb_set_voice',
  '[channel-worker] 他说(ASR):先这样吧，挂了。',
  '',
].join('\n')

describe('从日志里配题目', () => {
  it('一条「他说」配上它后面、下一条「他说」之前的工具行', () => {
    const samples = parseEvalSamples(LOG)
    expect(samples.map(one => one.label)).toEqual(['chat', 'act', 'act', 'chat'])
    expect(samples[1]?.tools).toEqual(['wb_list_doing'])
    expect(samples[2]?.tools).toEqual(['wb_decide_item', 'wb_set_voice'])
    expect(samples[0]?.tools).toEqual([])
  })

  it('每一条都带着原文与行号(每一条都要能翻回日志去查)', () => {
    const samples = parseEvalSamples(LOG)
    expect(samples[0]).toMatchObject({ text: '你是谁？', line: 3 })
    expect(samples[3]?.text).toBe('先这样吧，挂了。')
  })

  it('第一条「他说」之前就有的工具行(开场白那一轮)丢掉,不挂到任何一条上', () => {
    const samples = parseEvalSamples('[channel-worker] 她调了工具:wb_list_doing\n[channel-worker] 他说(ASR):喂。')
    expect(samples).toHaveLength(1)
    expect(samples[0]?.label).toBe('chat')
  })

  it('同一回合里同一件工具调两次只算一件', () => {
    const samples = parseEvalSamples([
      '[channel-worker] 他说(ASR):换音色。',
      '[channel-worker] 她调了工具:wb_set_voice',
      '[channel-worker] 她调了工具:wb_set_voice',
    ].join('\n'))
    expect(samples[0]?.tools).toEqual(['wb_set_voice'])
  })

  it('认不出来的行一概跳过,空的「他说」不算题目', () => {
    expect(parseEvalSamples('随便一行框架日志\n[channel-worker] 他说(ASR):   ')).toHaveLength(0)
  })
})

describe('算成绩:漏判与误判分开数', () => {
  const samples = parseEvalSamples(LOG)

  it('全对', () => {
    const outcomes = samples.map(sample => ({ sample, got: sample.label, reason: '', ms: 0 }))
    const score = scoreOutcomes(outcomes)
    expect(score).toMatchObject({ total: 4, correct: 4, missed: 0, overCalled: 0 })
    expect(score.accuracy).toBe(1)
  })

  it('该办事判成闲聊 = 漏判(贵的那一种);闲聊判成办事 = 误判', () => {
    const outcomes = samples.map(sample => ({ sample, got: 'chat' as const, reason: '', ms: 2 }))
    const score = scoreOutcomes(outcomes)
    expect(score).toMatchObject({ total: 4, correct: 2, missed: 2, overCalled: 0 })

    const 反过来 = samples.map(sample => ({ sample, got: 'act' as const, reason: '', ms: 2 }))
    expect(scoreOutcomes(反过来)).toMatchObject({ correct: 2, missed: 0, overCalled: 2 })
  })

  it('耗时:总和、平均、最慢', () => {
    const outcomes = samples.map((sample, index) => ({ sample, got: sample.label, reason: '', ms: index * 10 }))
    const score = scoreOutcomes(outcomes)
    expect(score.msTotal).toBe(60)
    expect(score.msMax).toBe(30)
    expect(score.msAvg).toBe(15)
  })

  it('一行人话成绩', () => {
    const score = scoreOutcomes(samples.map(sample => ({ sample, got: sample.label, reason: '', ms: 1 })))
    const line = formatScore('规则法', score)
    expect(line).toContain('4/4')
    expect(line).toContain('漏判 0')
    expect(line).toContain('误判 0')
  })

  it('一条题目都没有也算得出来(不许除零炸掉)', () => {
    expect(scoreOutcomes([])).toMatchObject({ total: 0, accuracy: 0, msAvg: 0 })
  })
})
