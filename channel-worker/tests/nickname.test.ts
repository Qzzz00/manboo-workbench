/**
 * 问称呼那一轮(2026-09-25,卡 fix/call-under-load-and-name)。
 *
 * 维护者:「为什么总是第一次听名字的时候听不清」—— 最近四次引导的第一遍识别:
 * 「教我变就可以了」「编辑」「叫我变就了」(他说的是 Ben)。这里钉住:
 *   ① 问称呼那一段才带上下文,记下称呼就撤;上下文进了火山开场帧的 corpus(dialog_ctx 形状);
 *   ② 那几种一眼就看得出没听准的,判得出来、原因说得出口;说得清楚的(含英文名)一个都不误判;
 *   ③ 提示只加在这一次调模型的副本上,而且叫她请他**打字**,不是「再说一遍」。
 */
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildCorpus, buildStartFrame, DIALOG_CONTEXT_CHAR_BUDGET } from '../src/asr/volcProtocol.ts'
import { NICKNAME_ASR_CONTEXT, awaitingNickname, nicknameCandidate, nicknameDoubt, nicknameDoubtNote, withNicknameDoubt } from '../src/nickname.ts'
import { ONBOARDING_OPENING_LINE, buildOnboardingInstructions, type OnboardingBrief } from '../src/onboarding.ts'

describe('什么时候算「在等他的称呼」', () => {
  it('第一段、称呼还没记下 → 在等', () => {
    expect(awaitingNickname({ stage: 'opening' })).toBe(true)
    expect(awaitingNickname({ stage: 'opening', nickname: '  ' })).toBe(true)
  })
  it('记下了、或者已经到后面几段 → 不等了(上下文撤掉,提示也不加)', () => {
    expect(awaitingNickname({ stage: 'opening', nickname: 'Ben' })).toBe(false)
    expect(awaitingNickname({ stage: 'opening', answered: { opening: ['nickname'] } })).toBe(false)
    expect(awaitingNickname({ stage: 'branch' })).toBe(false)
    expect(awaitingNickname(undefined)).toBe(false)
  })
})

describe('问话当上下文交给火山', () => {
  it('上下文的第一条就是开场白最后那句问话', () => {
    expect(ONBOARDING_OPENING_LINE.endsWith(NICKNAME_ASR_CONTEXT[0] as string)).toBe(true)
  })

  it('开场帧里 corpus.context 是 dialog_ctx 的形状', () => {
    const frame = buildStartFrame([], { dialog: NICKNAME_ASR_CONTEXT })
    const request = JSON.parse(gunzipSync(frame.subarray(12)).toString()) as { request: { corpus?: { context?: string } } }
    const context = JSON.parse(request.request.corpus?.context ?? '{}') as { context_type?: string, context_data?: { text: string }[], hotwords?: unknown }
    expect(context.context_type).toBe('dialog_ctx')
    expect(context.context_data?.map(one => one.text)).toEqual([...NICKNAME_ASR_CONTEXT])
    expect(context.hotwords).toBeUndefined()
  })

  it('热词与对话上下文合在同一个 JSON 里', () => {
    const context = JSON.parse(buildCorpus(['工作台'], ['你希望我怎么称呼你?'])?.context ?? '{}') as Record<string, unknown>
    expect(context).toEqual({ hotwords: [{ word: '工作台' }], context_type: 'dialog_ctx', context_data: [{ text: '你希望我怎么称呼你?' }] })
  })

  it('两样都没有就不带 corpus(与改之前一字不差)', () => {
    expect(buildCorpus([], [])).toBeUndefined()
    const request = JSON.parse(gunzipSync(buildStartFrame().subarray(12)).toString()) as { request: Record<string, unknown> }
    expect(request.request.corpus).toBeUndefined()
  })

  it('上下文超预算:留最近的,丢最早的', () => {
    const long = '很'.repeat(DIALOG_CONTEXT_CHAR_BUDGET - 10)
    const context = JSON.parse(buildCorpus([], ['最早那句,应该被丢掉', long, '最近这句'])?.context ?? '{}') as { context_data: { text: string }[] }
    expect(context.context_data.map(one => one.text)).toEqual([long, '最近这句'])
  })
})

describe('没听准的判得出来(nicknameDoubt)', () => {
  it.each([
    ['教我变就可以了', '叫我'],
    ['叫我变就了', '一个字「变」'],
    ['本', '一个字「本」'],
    ['呃,就可以了', '没听出名字'],
  ])('「%s」→ 没把握(%s)', (heard, reason) => {
    expect(nicknameDoubt(heard)).toContain(reason)
  })

  it.each([
    ['你就叫我 Ben 就可以了'],
    ['Ben'],
    ['叫我老王'],
    ['我叫张伟'],
    ['小明吧'],
    // 「编辑」这种「不像个名字」交给模型判(提示词里有例子),这里宁可少判不可错判。
    ['编辑'],
  ])('「%s」→ 不误判', (heard) => {
    expect(nicknameDoubt(heard)).toBeUndefined()
  })

  it('拿得出名字:剥掉「叫我」「就可以了」「吧」', () => {
    expect(nicknameCandidate('你就叫我小王就行了吧')).toBe('小王')
    expect(nicknameCandidate('教我变就可以了')).toBe('变')
  })
})

describe('提示只加在这一次的副本上,而且是请他打字', () => {
  class FakeCtx {
    messages: { role: string, content: string }[] = []
    copy(): FakeCtx { const next = new FakeCtx(); next.messages = [...this.messages]; return next }
    addMessage(params: { role: 'system', content: string }): void { this.messages.push(params) }
  }

  it('原来那份一个字不动;副本多一行', () => {
    const original = new FakeCtx()
    const hinted = withNicknameDoubt(original, '称呼只听出一个字「变」')
    expect(original.messages).toHaveLength(0)
    expect(hinted.messages).toHaveLength(1)
    expect(hinted.messages[0]?.role).toBe('system')
  })

  it('叫她请他在屏幕下面的输入框里打出来,不是再说一遍', () => {
    const note = nicknameDoubtNote('称呼只听出一个字「变」')
    expect(note).toContain('输入框里把名字打出来')
    expect(note).toContain('别请他再说一遍')
    expect(note).toContain('称呼只听出一个字「变」')
  })
})

describe('提示词里问称呼那一段(只改了这一段)', () => {
  const opening: OnboardingBrief = {
    stage: 'opening',
    label: '① 开场',
    done: false,
    seed: ONBOARDING_OPENING_LINE,
    speak_seed: true,
    goals: ['用户希望被怎么称呼'],
    keys: [{ name: 'nickname', kind: 'string', desc: '称呼(以后就这么叫)', required: true }],
    answered: {},
  }

  it('没听准:请他在屏幕下面的输入框里打出来,不再「请他再说一遍」', () => {
    const text = buildOnboardingInstructions({ brief: opening })
    expect(text).toContain('手机屏幕下面的输入框里打出来')
    expect(text).toContain('不要请他再说一遍')
    expect(text).toContain('「变」「编辑」')
    expect(text).not.toContain('才请他再说一遍')
  })

  it('称呼记下之后的那几段不带这一句(改的只是问称呼那一段)', () => {
    const later = buildOnboardingInstructions({ brief: { ...opening, stage: 'branch', label: '② 分岔', nickname: 'Ben', answered: { opening: ['nickname'] } } })
    expect(later).not.toContain('手机屏幕下面的输入框里打出来')
  })
})
