// @vitest-environment node
/**
 * 引导归谁管(2026-09-18,Ben:「似乎电脑手机同时都能操作;如果手机已经扫码,优先手机的引导流程」)。
 *
 * 全是纯函数,所以这一份用例跑在 node 里、不起 jsdom —— 界面那一半在 client-firstrun.test.tsx。
 */
import { describe, expect, it } from 'vitest'
import {
  onboardingLeaderOf, phoneIdle, phoneProgressText, PHONE_IDLE_MS,
} from '../src/client/firstrun/onboardingLead.ts'

describe('onboardingLeaderOf', () => {
  it('服务端说了算:leader 有值就照它,哪怕手机没配过', () => {
    expect(onboardingLeaderOf({ leader: 'phone', phonePaired: false })).toBe('phone')
    expect(onboardingLeaderOf({ leader: 'desktop', phonePaired: true })).toBe('desktop')
  })

  it('还没人主导过:不论是否配过手机都由电脑主导', () => {
    expect(onboardingLeaderOf({ phonePaired: true })).toBe('desktop')
    expect(onboardingLeaderOf({ phonePaired: false })).toBe('desktop')
  })

  it('认不出来的值一律当没有 —— 老工作台、写坏的文件走同一条路', () => {
    expect(onboardingLeaderOf({ leader: '手机', phonePaired: false })).toBe('desktop')
    expect(onboardingLeaderOf({ leader: '', phonePaired: true })).toBe('desktop')
  })
})

describe('phoneIdle', () => {
  const now = Date.parse('2026-09-18T12:00:00Z')

  it('十分钟没动静才算没动静', () => {
    expect(phoneIdle({ leaderAt: '2026-09-18T11:51:00Z', now })).toBe(false)
    expect(phoneIdle({ leaderAt: '2026-09-18T11:50:00Z', now })).toBe(true)
    expect(PHONE_IDLE_MS).toBe(600_000)
  })

  it('**从来没有过动静**不算没动静:那多半是刚配上、还没开始,催人是最讨厌的', () => {
    expect(phoneIdle({ now })).toBe(false)
    expect(phoneIdle({ leaderAt: '不是时间', now })).toBe(false)
  })
})

describe('phoneProgressText', () => {
  it('第几步、共几步、这一步叫什么', () => {
    expect(phoneProgressText({ stage: 'branch', done: false, label: '② 分岔', step: 2, steps: 8 }))
      .toBe('现在到第 2 步(共 8 步):② 分岔')
  })

  it('不编数:服务端没给几步就不说几步,没给名字就说阶段 id', () => {
    expect(phoneProgressText({ stage: 'habits', done: false, label: '⑤ 习惯', step: 5 })).toBe('现在到第 5 步:⑤ 习惯')
    expect(phoneProgressText({ stage: 'habits', done: false })).toBe('现在到:habits')
  })

  it('做完了就说做完了', () => {
    expect(phoneProgressText({ stage: 'done', done: true, label: '完成', step: 8, steps: 8 })).toBe('引导已经做完了。')
  })
})
