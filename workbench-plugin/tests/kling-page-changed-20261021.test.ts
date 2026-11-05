// @vitest-environment node
/**
 * ★ **可灵改版了:快速失败,卡上写停在哪一步**(2026-10-21,卡「派活按家隔离」第 5 条)。
 *
 * 从前「等提示词框」按**拍数**数(50 拍 × 每拍一次 `focus_input`),注释写约 30 秒 ——
 * 可那一下 op 自己的超时是 15 秒,可灵卡住 / 页面改版时最坏 50 × 20 秒 ≈ 17 分钟。
 * 现在按**真花掉的时间**封顶,到点就停:「可灵的页面结构变了(或要先登录):停在 X 这一步,找了 N 秒没找到 Y」,不重试到死。
 */
import { describe, expect, it } from 'vitest'
import { KLING_LOAD_DEADLINE_MS, KLING_NAV_DEADLINE_MS, klingPageChangedSay, runKlingStep } from '../src/server/klingStep.ts'
import type { KlingHelper } from '../src/server/klingStep.ts'

type Req = Record<string, unknown> & { op: string }

/** 每一下 op 都花 `opMs`(假时钟往前拨),`answer` 回什么。 */
function slowHelper(clock: { ms: number }, opMs: number, answer: (req: Req) => Record<string, unknown>): { helper: KlingHelper, calls: Req[] } {
  const calls: Req[] = []
  return {
    calls,
    helper: { request: async (req) => { calls.push(req); clock.ms += opMs; return answer(req) } },
  }
}

describe('可灵改版:快速失败', () => {
  it('★等不到提示词框:到墙钟上限就停,卡上说「页面结构变了,停在等提示词框」;花掉的时间不超过上限加一下 op', async () => {
    const clock = { ms: 0 }
    const { helper } = slowHelper(clock, 15_000, (req) => {
      if (req.op === 'agent_press') return { found: true, pressed: true }
      if (req.op === 'focus_input') return { candidates: [] }
      return {}
    })
    const started = clock.ms
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, {
      openApp: async () => {},
      helper,
      sleep: async (ms) => { clock.ms += ms },
      now: () => clock.ms,
    })
    expect(got).toMatchObject({ kind: 'failed', step: 'load' })
    if (got.kind !== 'failed') return
    expect(got.why).toContain('页面结构变了')
    expect(got.why).toContain('「等提示词框」')
    // 导航两下各一次(找到就走)+ 等框:总共不超过两下导航 + 上限 + 一下 op。
    expect(clock.ms - started).toBeLessThanOrEqual(2 * 15_000 + KLING_LOAD_DEADLINE_MS + 15_000 + 2 * 15_000)
  })

  it('★导航那颗键一直找不到:到墙钟上限就停,说停在哪一步、哪颗键', async () => {
    const clock = { ms: 0 }
    const { helper, calls } = slowHelper(clock, 3_000, (req) => (req.op === 'agent_press' ? { found: false } : {}))
    const got = await runKlingStep({ imagePath: '/tmp/a.png', prompt: 'p' }, {
      openApp: async () => {},
      helper,
      sleep: async (ms) => { clock.ms += ms },
      now: () => clock.ms,
    })
    expect(got).toMatchObject({ kind: 'failed', step: 'open' })
    if (got.kind !== 'failed') return
    expect(got.why).toContain('页面结构变了')
    expect(got.why).toContain('「生成」')
    expect(clock.ms).toBeLessThanOrEqual(KLING_NAV_DEADLINE_MS + 3_000 + 1_000)
    expect(calls.filter(one => one.op === 'agent_press').length).toBeGreaterThan(1)
  })

  it('人话:哪一步、找什么、找了多久、不再重试', () => {
    expect(klingPageChangedSay({ step: '等提示词框', what: '可写的提示词框', waitedMs: 30_000 }))
      .toBe('可灵的页面结构变了(或要你先登录):停在「等提示词框」这一步,找了 30 秒没找到可写的提示词框 —— 不再重试,参考图在选题文件夹里')
  })
})
