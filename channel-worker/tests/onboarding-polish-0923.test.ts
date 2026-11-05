/**
 * 引导对话打磨(2026-09-23 统筹第三轮从零重装自跑 + 维护者手机真机)在电话这一头的部分:
 *   T 开场白走预合成缓存(不经模型、不等合成);
 *   U / V 称呼直接用、一次只问一件;Y / W / AA 一段一段来、喊停就停、不说内部话。
 * 工作台那一头的回放在 workbench-plugin/tests/server-onboarding-consent-http.test.ts 末尾。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OnboardingBrief } from '../src/onboarding.ts'
import { ONBOARDING_OPENING_LINE, ONBOARDING_PREWARM_LINES, PHONE_TURN_RULES, buildOnboardingInstructions } from '../src/onboarding.ts'
import { GreetingCache, openerSpeech } from '../src/tts/greeting.ts'

function brief(over: Partial<OnboardingBrief> = {}): OnboardingBrief {
  return {
    stage: 'opening',
    label: '① 开场',
    done: false,
    seed: ONBOARDING_OPENING_LINE,
    speak_seed: true,
    goals: ['用户希望被怎么称呼'],
    keys: [{ name: 'nickname', kind: 'string', desc: '称呼(以后就这么叫)', required: true }],
    answered: {},
    ...over,
  }
}

describe('T:引导开场白走预合成', () => {
  it('工人这份开场白与工作台 OPENING_LINE 逐字相同(不然缓存永远不命中)', () => {
    const stages = readFileSync(join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'server', 'onboardingStages.ts'), 'utf8')
    expect(stages).toContain(`= '${ONBOARDING_OPENING_LINE}'`)
    expect(ONBOARDING_PREWARM_LINES).toContain(ONBOARDING_OPENING_LINE)
  })

  it('预热之后,简报里的种子句直接拿到音频(say 看见 audio 就跳过 TTS);没预热照样有这一句', async () => {
    const asked: string[] = []
    const cache = new GreetingCache({
      synthesize: async (text) => { asked.push(text); return { pcm: Buffer.alloc(4800), sampleRate: 24000 } },
      lines: () => [...ONBOARDING_PREWARM_LINES],
    })
    const cold = openerSpeech(cache, brief().seed as string)
    expect(cold.cached).toBe(false)
    expect(cold.text).toBe(ONBOARDING_OPENING_LINE)
    await cache.warm()
    expect(asked).toEqual([ONBOARDING_OPENING_LINE])
    const hot = openerSpeech(cache, brief().seed as string)
    expect(hot.cached).toBe(true)
    expect(hot.audio).toBeDefined()
  })

  it('引导开场**不**直接发预合成帧:紧跟的换提示词会把它截断(09-24 维护者真机「语音听不到」)', () => {
    const agent = readFileSync(join(import.meta.dirname, '..', 'src', 'agent.ts'), 'utf8')
    expect(agent).not.toContain('const speech = openerSpeech(greetings, seed)')
    // 2026-09-27 起这一句改成「切成两块、第一小句不可打断」(onboarding.ts speakOpeningLine),
    // 仍然只给字、不给 audio —— 那一条 09-24 的账没变,钉它的用例在
    // tests/voice-onboarding-latency-0927.test.ts。
    expect(agent).toContain('speakOpeningLine(seed, (piece, options)')
  })
})

describe('U / V:称呼直接用、一次只问一件', () => {
  it('开场那一段不再要「我叫你 X,对吗?」,不问「是拼音吗」', () => {
    const text = buildOnboardingInstructions({ brief: brief() })
    expect(text).not.toContain('**立刻念给他听**「我叫你<称呼>,对吗?」')
    expect(text).toContain('不再问「我叫你 X,对吗?」')
    expect(text).toContain('「是拼音吗」')
    expect(text).toContain('一次只问一件事')
  })
})

describe('Y / W / AA:一段一段来、喊停就停、不说内部话', () => {
  it('每一段的系统提示都带这四条', () => {
    for (const stage of ['opening', 'authorization', 'habits', 'naming']) {
      const text = buildOnboardingInstructions({ brief: brief({ stage, label: stage, speak_seed: false, answered: { opening: ['nickname'] }, nickname: 'Ben' }) })
      for (const rule of PHONE_TURN_RULES) expect(text).toContain(rule)
    }
    const rules = PHONE_TURN_RULES.join('\n')
    expect(rules).toContain('一段一段来')
    expect(rules).toContain('「下一步」')
    for (const phrase of ['按流程', '系统那边', '正式问一次']) expect(rules).toContain(phrase)
  })

  it('③ 授权段简报里已经摘掉的读目录,就不出「你可以去找他的项目」那一整段', () => {
    const text = buildOnboardingInstructions({
      brief: brief({
        stage: 'authorization', label: '③ 授权补全', speak_seed: false, nickname: 'Ben',
        answered: { opening: ['nickname'], projects: ['read_scan_roots', 'done'] },
        goals: ['**已经答过的授权,这一段不再问**:看你放代码的那个目录(可以)'],
        keys: [{ name: 'write_docs', kind: 'tri', desc: '写记忆', required: true }],
      }),
    })
    expect(text).not.toContain('【这一段你可以去找他的项目】')
    expect(text).toContain('已经答过的授权,这一段不再问')
  })
})
