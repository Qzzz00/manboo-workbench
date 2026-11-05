// @vitest-environment node
/**
 * 「看各家 AI 对话的最后几句」这一项授权(`read_session_content`,2026-09-25 卡 N;统筹定):
 * **并进引导 ③ 授权那一段一起问**;不是必答项(她漏问了不挡引导收尾),已经走完引导的人第一次核进度时在外层问一次。
 */
import { describe, expect, it } from 'vitest'
import { CONSENT_KEYS, QUESTION_MARKS, guardAnswer } from '../src/server/onboardingConsent.ts'
import { AUTH_KEY_DESC, CONSENT_LABEL, requiredKeys, stageDef } from '../src/server/onboardingStages.ts'

describe('引导 ③ 授权那一段一起问「看各家 AI 对话的最后几句」', () => {
  it('这一段的题里有它(三档:可以 / 要问 / 不可以),不是必答项;说清为什么要看、看了他得到什么、只读不存、相关几句会发给 AI 看', () => {
    const def = stageDef('authorization', 'existing')
    expect(def.keys.read_session_content?.kind).toBe('tri')
    expect(requiredKeys('authorization', 'existing')).not.toContain('read_session_content')
    const goals = def.goals.join('\n')
    expect(goals).toContain('最后几句')
    // 为什么要看、看了他得到什么(2026-09-25 维护者:「从常规用户的第一次使用角度」)。
    expect(goals).toContain('这样不用你一件件告诉我')
    expect(goals).toContain('会发给 AI 看一眼')
    expect(goals).toContain('不同意也没关系')
    // 2026-10-09 维护者拍板(行为账):各家 AI 的聊天正文照旧不存;她对事务官说的话存原文进本机行为账。
    expect(AUTH_KEY_DESC.read_session_content).toContain('各家 AI 的聊天正文不存')
    expect(AUTH_KEY_DESC.read_session_content).toContain('你对事务官说的话存原文进本机行为账')
    expect(AUTH_KEY_DESC.read_session_content).toContain('不进记忆仓库、不推远端、留 90 天')
    // 授权表是一张 Markdown 表:说明里不能有竖线
    expect(AUTH_KEY_DESC.read_session_content).not.toContain('|')
    expect(CONSENT_LABEL.read_session_content).toBe('看你跟各家 AI 的对话的最后几句(判断事情做到哪了)')
    // 一个英文词都不出现(他听到的是「对话的最后几句」,不是 key 名)。
    expect(goals).not.toMatch(/read_session_content|transcript|rollout/)
  })

  it('同别的授权一道门:记成「可以」要她问出口过这一题;他拒绝就不能记成可以', () => {
    expect(CONSENT_KEYS).toContain('read_session_content')
    expect(QUESTION_MARKS.authorization?.read_session_content).toContain('最后几句')
    const asked = '看板上每件事做到哪了,我想照你在 Claude、Codex 里跟这件事有关的对话来写,这样不用你一件件告诉我 —— 只看最后几句。可以、要问,还是不可以?'
    expect(guardAnswer({ stage: 'authorization', key: 'read_session_content', value: '可以', required: false, exchange: { asked, reply: '可以' } })).toEqual({ ok: true })
    expect(guardAnswer({ stage: 'authorization', key: 'read_session_content', value: '可以', required: false, exchange: { asked, reply: '不行' } }).ok).toBe(false)
    expect(guardAnswer({ stage: 'authorization', key: 'read_session_content', value: '可以', required: false, exchange: { asked: '你一天大概怎么分段?', reply: '可以' } }).ok).toBe(false)
  })
})
