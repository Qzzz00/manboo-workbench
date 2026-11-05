/**
 * 引导对话打磨(2026-09-23 统筹第三轮从零重装自跑 + 维护者手机真机)的话术与纯函数。
 * 对话回放式的 http 用例在 server-onboarding-consent-http.test.ts 末尾「第三轮自跑」那几段。
 */
import { describe, expect, it } from 'vitest'
import { guardAnswer, wantsToMoveOn } from '../src/server/onboardingConsent.ts'
import {
  AUTH_KEY_DESC, PLAN_GOALS, TURN_RULES, firstMessage, keyBriefs, requiredKeys, stageDef,
} from '../src/server/onboardingStages.ts'

const base = { baseUrl: 'http://127.0.0.1:8791', answered: {}, resumed: false } as const

describe('AA:门只管授权与分岔 / 布局', () => {
  it('称呼、取名、人设:他主动说的明确答案直接收(没有「问出口」也收)', () => {
    const exchange = { asked: '那我就话少一点,先说结论。', reply: '就叫小管家' }
    expect(guardAnswer({ stage: 'naming', key: 'butler_name', value: '小管家', required: true, exchange })).toEqual({ ok: true })
    expect(guardAnswer({ stage: 'opening', key: 'nickname', value: 'Ben', required: true, exchange: { asked: '', reply: 'Ben' } })).toEqual({ ok: true })
    expect(guardAnswer({ stage: 'persona', key: 'persona', value: '沉稳', required: true, exchange })).toEqual({ ok: true })
    expect(guardAnswer({ stage: 'wrapup', key: 'evening_routine', value: '18:00', required: true, exchange })).toEqual({ ok: true })
  })

  it('分岔的「对」照样拦;授权没问出口照样拦', () => {
    const yes = { asked: '好,Ben。', reply: '对' }
    expect(guardAnswer({ stage: 'branch', key: 'mode', value: 'existing', required: true, exchange: yes }).ok).toBe(false)
    expect(guardAnswer({ stage: 'authorization', key: 'write_docs', value: true, required: true, exchange: yes }).ok).toBe(false)
  })

  it('提示词里禁止「按流程」「系统那边」「正式问一次」', () => {
    const rules = TURN_RULES.join('\n')
    for (const phrase of ['按流程', '系统那边', '正式问一次']) expect(rules).toContain(phrase)
    const message = firstMessage({ ...base, stage: 'naming', mode: 'existing' })
    expect(message).toContain('不说内部话')
    expect(stageDef('naming', 'existing').goals.join('\n')).toContain('就直接记')
  })
})

describe('U / V:称呼直接用、一次只问一件', () => {
  it('开场清单不再要「我叫你 X,对吗?」,也不问「是拼音吗」', () => {
    const goals = stageDef('opening', undefined).goals.join('\n')
    expect(goals).not.toContain('我叫你<称呼>,对吗')
    expect(goals).toContain('不再问「对吗」')
    expect(goals).toContain('「是拼音吗」')
    expect(stageDef('opening', undefined).keys.nickname?.desc).not.toContain('复述确认')
  })

  it('每一段的第一条消息都带「一次只问一件事」', () => {
    for (const stage of ['opening', 'branch', 'projects', 'authorization', 'habits'] as const) {
      expect(firstMessage({ ...base, stage, mode: 'existing' })).toContain('一次只问一件事')
    }
  })
})

describe('Y:一段一段来', () => {
  it('第一条消息带「一段一段来」;授权段 goals 第一条就是「这一段只问授权」', () => {
    expect(firstMessage({ ...base, stage: 'authorization', mode: 'existing' })).toContain('一段一段来')
    expect(stageDef('authorization', 'existing').goals[0]).toContain('这一段只问授权')
  })
})

describe('X:写记忆 / 存版本的说法与实际一致', () => {
  it('不说「本仓库」「push」「远端」之外的吓人话;明说只在这台电脑上、不推远端', () => {
    expect(AUTH_KEY_DESC.write_docs).toContain('记忆文件夹')
    expect(AUTH_KEY_DESC.write_docs).not.toContain('本仓库')
    expect(AUTH_KEY_DESC.write_commit).toContain('不推到任何远端')
    expect(AUTH_KEY_DESC.write_commit).not.toMatch(/push/i)
    const goals = stageDef('authorization', 'existing').goals.join('\n')
    expect(goals).toContain('只在这台电脑上')
    expect(goals).toContain('不说「仓库」「docs」「提交」「推上去」')
  })
})

describe('Z:前面答过的授权,③ 里不再问', () => {
  const carried = { read_scan_roots: true, read_client_files: '可以' }
  it('keys 摘掉、必答项算已答、goals 第一条说明', () => {
    expect(keyBriefs('authorization', 'existing', undefined, carried).map(key => key.name)).not.toContain('read_scan_roots')
    expect(requiredKeys('authorization', 'existing', undefined, carried)).toEqual(['write_docs', 'write_commit', 'write_api'])
    expect(requiredKeys('authorization', 'existing')).toContain('read_client_files')
    const def = stageDef('authorization', 'existing', undefined, carried)
    expect(def.goals[0]).toContain('看你放代码的那个目录(可以)')
    expect(firstMessage({ ...base, stage: 'authorization', mode: 'existing', carried })).toContain('已经答过的授权,这一段不再问')
  })

  it('别的阶段不受影响;没带 carried 与原来逐字相同', () => {
    expect(stageDef('projects', 'existing', undefined, carried)).toBe(stageDef('projects', 'existing'))
    expect(stageDef('authorization', 'existing', undefined, {})).toBe(stageDef('authorization', 'existing'))
  })
})

describe('W:喊停就停', () => {
  it('「没了,下一步」「先这样」算要往下走;单独一句「没有了」不算(那是 K 的答非所问)', () => {
    expect(wantsToMoveOn('没了,下一步')).toBe(true)
    expect(wantsToMoveOn('先这样吧')).toBe(true)
    expect(wantsToMoveOn('跳过')).toBe(true)
    expect(wantsToMoveOn('没有了')).toBe(false)
    expect(wantsToMoveOn('开口说')).toBe(false)
  })

  it('方案那几条与每段的第一条消息都写了「他说下一步就收」', () => {
    expect(PLAN_GOALS.join('\n')).toContain('「下一步」')
    expect(firstMessage({ ...base, stage: 'projects', mode: 'existing' })).toContain('他喊停就停')
  })
})
