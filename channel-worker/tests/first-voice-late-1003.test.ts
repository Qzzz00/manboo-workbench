/**
 * **旧回合的首句不许落进新回合**(2026-10-03,卡 fix/voice-route-zh;
 * 审计 `docs/审计材料/2026-10-03/voice.md` 附证 A)。
 *
 * 首句那一层本来就对轮号比过两次(问之前、问回来之后),漏掉的是**第三道窗口** ——
 * `speak` 里那一次 TTS 合成的 await。真机上那一截是几百毫秒到一两秒,
 * 而她在这段时间里完全可能又说了一句:
 *
 *   第一回合问出「好,我去问豆包。」→ 交给 8792 合成 →(她改口,第二回合开始)→
 *   合成回来了 → 原样塞进共享的那条垫场路 → **第二回合垫出的是上一件事的首句**。
 *
 * 她听见的是「我已改口,她仍在回答上一件事」。
 *
 * 两处修法,两条用例各钉一处:
 *   ① `speak` 多收一个 `guard` —— 合成回来之后、交给垫场那条路**之前**再问一次轮号;
 *   ② `FirstVoice.cancel()` —— 回合结束(agent 回到 listening / idle)时作废,
 *      因为第二回合如果是闲聊,压根不会 `start()`、轮号不会动。
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { FirstVoice } from '../src/firstVoice.ts'
import { WorkerFiller } from '../src/workerFiller.ts'

const 旧首句 = '好,我去问豆包。'
const 固定那句 = '我想想。'

/** 一条能手动放行的 TTS:`release()` 之前 `speak` 一直挂在合成上。 */
function harness() {
  let release!: () => void
  const synthesized = new Promise<void>((resolve) => { release = resolve })
  const filler = new WorkerFiller<number>({
    clip: () => ({ text: 固定那句, frames: [1] }),
    setTimer: () => () => { /* 这几条用例不推时钟 */ },
  })
  const verdicts: string[] = []
  const onDone = vi.fn()
  const first = new FirstVoice({
    ask: async ({ user }) => (user.includes('旧请求') ? 旧首句 : new Promise<string>(() => { /* 新回合这一问不回来 */ })),
    speak: async (text, guard) => {
      await synthesized
      // ★ 这一行就是修的那一处:合成完了,先看这一拍还算不算数。
      if (!guard.current()) { verdicts.push('late'); return 'late' }
      const got = filler.offerFirstVoice({ text, frames: [2], whole: true }) ? 'said' : 'late'
      verdicts.push(got)
      return got
    },
    onDone,
  })
  return { first, filler, release: () => release(), verdicts, onDone }
}

describe('★★ 旧回合的首句 TTS 晚到(审计 REPRO 4 的时序)', () => {
  it('★ 她又说了一句:合成回来的旧首句不许进新回合', async () => {
    const h = harness()
    h.filler.arm()
    const stale = h.first.start({ said: '旧请求' })
    await new Promise(resolve => setImmediate(resolve))
    // 第二回合开场:上一回合收尾、重新 arm、再问一句
    h.filler.endRound()
    h.filler.arm()
    void h.first.start({ said: '新请求' })
    // 这时候第一回合的 TTS 才回来
    h.release()
    await stale

    expect(h.first.seq).toBe(2)
    expect(h.verdicts).toEqual(['late'])
    // ★ 新回合拿不到旧首句(审计那一行:当时 take() 拿到的就是它)
    expect(h.filler.take()?.text).not.toBe(旧首句)
    // 过时的那一拍一条都不记(纪律 ②)
    expect(h.onDone).not.toHaveBeenCalled()
  })

  it('★ 回合结束就作废(cancel):第二回合是闲聊、压根不会再 start 的那一种', async () => {
    const h = harness()
    h.filler.arm()
    const stale = h.first.start({ said: '旧请求' })
    await new Promise(resolve => setImmediate(resolve))
    // 这一回合收尾了(agent 回到 listening),下一句是闲聊 —— 不会有新的 start
    h.filler.endRound()
    h.first.cancel()
    h.filler.arm()
    h.release()
    await stale

    expect(h.first.seq).toBe(2)
    expect(h.verdicts).toEqual(['late'])
    expect(h.filler.take()?.text).not.toBe(旧首句)
    expect(h.onDone).not.toHaveBeenCalled()
  })

  it('cancel() 不启动新的那一问(它只是把轮号推走)', async () => {
    const ask = vi.fn(async () => '好,我去办。')
    const first = new FirstVoice({ ask, speak: async () => 'said' })
    first.cancel()
    expect(ask).not.toHaveBeenCalled()
    expect(first.seq).toBe(1)
  })

  it('没人打断的那一回合照旧垫首句(这一条一个字没改)', async () => {
    const h = harness()
    h.filler.arm()
    const only = h.first.start({ said: '旧请求' })
    await new Promise(resolve => setImmediate(resolve))
    h.release()
    await only
    expect(h.verdicts).toEqual(['said'])
    expect(h.filler.take()?.text).toBe(旧首句)
    expect(h.onDone).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'said', text: 旧首句 }))
  })
})

/**
 * ——— 接线还在吗(读 `src/agent.ts` 源码比对)———
 *
 * 这一层要真起一个 LiveKit 会话才跑得到(AGENTS.md:没有对照测试就补一条,读源头文件比对)。
 */
describe('★ 接线还在吗(读 src/agent.ts)', () => {
  const SOURCE = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8')

  it('★ speak 在合成完、交给垫场那条路之前查一次轮号', () => {
    const block = SOURCE.slice(SOURCE.indexOf('speak: async (text'), SOURCE.indexOf('timeoutMs: deps.config.firstVoiceTimeoutMs'))
    expect(block).toContain('guard.current()')
    expect(block.indexOf('await synthesizeLine(text)')).toBeLessThan(block.indexOf('guard.current()'))
    expect(block.indexOf('guard.current()')).toBeLessThan(block.indexOf('offerFirstVoice'))
  })

  it('★ 回合结束那一处同时把首句作废', () => {
    expect(SOURCE).toContain('firstVoice?.cancel()')
    // 与「判定也该忘掉」是同一处(回到 listening / idle)
    const tail = SOURCE.slice(SOURCE.indexOf('firstVoice?.cancel()') - 400, SOURCE.indexOf('firstVoice?.cancel()') + 200)
    expect(tail).toContain('routing.end()')
  })
})
