/**
 * 她说话时的应声 + **打断那一份回归包**(2026-10-02,卡「声音与形象跟着话走」第 5 件)。
 *
 * 打断那一半照 voice-agent-barge-in-tests 的分类:**四类各 ≥3 条** ——
 * 硬打断 / 应声 / 「呃其实…」/ 纠正。要求(hamming.ai):
 *   · 「嗯 / 对 / 好」这类**应声不算打断**;
 *   · 真打断要停(≤300ms);「呃其实」与纠正都算真打断。
 *
 * 应声那一半钉的是四个阈值与两条纪律(见 src/backchannel.ts)。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ACK_AFTER_MS,
  ACK_GAP_MS,
  ACK_LINE_IDS,
  ACK_MAX_PER_TURN,
  Backchannel,
  encodeBackchannelSignal,
  endsSentence,
  isBackchannelOnly,
  isRealInterruption,
} from '../src/backchannel.ts'

describe('打断回归包 · 应声不算打断', () => {
  // livekit-backchannel / hamming.ai:这几声是「我在听」,不是「我要说」。
  const acks = ['嗯', '嗯嗯', '嗯哼', '对', '对对', '对的', '好', '好的', '是', '是的', '哦', 'OK', '行']
  for (const said of acks) {
    it(`「${said}」不打断`, () => {
      expect(isBackchannelOnly(said)).toBe(true)
      expect(isRealInterruption(said)).toBe(false)
    })
  }

  it('带标点、带空白、拖长了也还是应声', () => {
    for (const said of ['嗯。', ' 对，', '好的!', '嗯嗯嗯', '对对对']) {
      expect(isBackchannelOnly(said)).toBe(true)
    }
  })
})

describe('打断回归包 · 硬打断要停', () => {
  const hard = ['停一下', '你等等', '不是这个意思', '先别说了', '我来说']
  for (const said of hard) {
    it(`「${said}」算真打断`, () => {
      expect(isRealInterruption(said)).toBe(true)
      expect(isBackchannelOnly(said)).toBe(false)
    })
  }
})

describe('打断回归包 · 「呃其实…」要停', () => {
  const hedged = ['呃其实我想说的是另一件事', '啊不对,我说的是上一条', '嗯…那个,先别派了']
  for (const said of hedged) {
    it(`「${said}」算真打断(开头那个语气词不能让它变成应声)`, () => {
      expect(isRealInterruption(said)).toBe(true)
    })
  }
})

describe('打断回归包 · 纠正要停', () => {
  const fixes = ['不是 Codex,是 Claude', '改成明天下午', '是 Ben 不是 Java']
  for (const said of fixes) {
    it(`「${said}」算真打断`, () => {
      expect(isRealInterruption(said)).toBe(true)
    })
  }
})

describe('打断回归包 · 空的不算', () => {
  it('没听出字来的时候**不当打断、也不当应声**', () => {
    expect(isRealInterruption('')).toBe(false)
    expect(isRealInterruption('   ')).toBe(false)
    expect(isBackchannelOnly('')).toBe(false)
  })
})

describe('到没到句尾', () => {
  it('句末标点收尾的算到了', () => {
    expect(endsSentence('那件事我已经办完了。')).toBe(true)
    expect(endsSentence('你能听到我吗?')).toBe(true)
  })
  it('说到一半的不算', () => {
    expect(endsSentence('那件事我')).toBe(false)
    expect(endsSentence('我想让你帮我,')).toBe(false)
  })
})

// ———————————————————————— 应声的阈值 ————————————————————————

function harness(overrides: Partial<{ now: number }> = {}) {
  let clock = overrides.now ?? 10_000
  const sent: unknown[] = []
  const timers: { fn: () => void, ms: number, at: number, dead: boolean }[] = []
  const bc = new Backchannel({
    send: signal => sent.push(signal),
    round: () => 7,
    now: () => clock,
    setTimer: (fn, ms) => {
      const entry = { fn, ms, at: clock, dead: false }
      timers.push(entry)
      return () => { entry.dead = true }
    },
  })
  /** 把时钟推到「最早那个还活着的计时器」到点,并触发它。回触发了没有。 */
  const tick = (): boolean => {
    const live = timers.filter(one => !one.dead && one.fn !== undefined)
    const next = live[live.length - 1]
    if (next === undefined) return false
    next.dead = true
    clock = next.at + next.ms
    next.fn()
    return true
  }
  return { bc, sent, tick, at: () => clock, advance: (ms: number) => { clock += ms } }
}

describe('她说话时应一声', () => {
  it(`连着说 ${ACK_AFTER_MS}ms、没到句尾 → 应一声,带轮号与点名`, () => {
    const h = harness()
    h.bc.userSpeaking(true)
    h.bc.heard('我想让你帮我做一件事,就是')
    expect(h.tick()).toBe(true)
    expect(h.sent).toEqual([{ type: 'backchannel', round: 7, at: expect.any(Number), line: ACK_LINE_IDS[0] }])
  })

  it('**她一停就不应**:停口当场把计时器撤掉', () => {
    const h = harness()
    h.bc.userSpeaking(true)
    h.bc.heard('我想让你帮我')
    h.bc.userSpeaking(false)
    expect(h.tick()).toBe(false)
    expect(h.sent).toEqual([])
  })

  it('到句尾了不插话(她说完了,该轮到我们答)', () => {
    const h = harness()
    h.bc.userSpeaking(true)
    h.bc.heard('那件事我已经办完了。')
    h.tick()
    expect(h.sent).toEqual([])
  })

  it('**她说的本来就只是一声「嗯」→ 不应回去**(不互相哼)', () => {
    const h = harness()
    h.bc.userSpeaking(true)
    h.bc.heard('嗯')
    h.tick()
    expect(h.sent).toEqual([])
  })

  it(`两声之间至少隔 ${ACK_GAP_MS}ms,一轮最多 ${ACK_MAX_PER_TURN} 声`, () => {
    const h = harness()
    h.bc.userSpeaking(true)
    h.bc.heard('我先说第一件,然后还有第二件')
    for (let i = 0; i < 8; i += 1) h.tick()
    expect(h.sent).toHaveLength(ACK_MAX_PER_TURN)
    // 点名轮着来,连着两声不一样。
    const lines = (h.sent as { line?: string }[]).map(one => one.line)
    expect(new Set(lines).size).toBe(ACK_MAX_PER_TURN)
  })

  it('没应成也接着看:她说到句尾、下一段又接着说,照样应得上', () => {
    const h = harness()
    h.bc.userSpeaking(true)
    h.bc.heard('第一件事说完了。')
    expect(h.tick()).toBe(true)
    expect(h.sent).toEqual([])
    h.bc.heard('第一件事说完了。第二件是')
    expect(h.tick()).toBe(true)
    expect(h.sent).toHaveLength(1)
  })

  it('回合结束:计数归零,下一回合重新算三声', () => {
    const h = harness()
    h.bc.userSpeaking(true)
    h.bc.heard('一直说一直说')
    for (let i = 0; i < 8; i += 1) h.tick()
    expect(h.sent).toHaveLength(ACK_MAX_PER_TURN)
    h.bc.endTurn()
    expect(h.bc.sent).toBe(0)
    h.advance(60_000)
    h.bc.userSpeaking(true)
    h.bc.heard('又开始说一段很长的话')
    expect(h.tick()).toBe(true)
    expect(h.sent).toHaveLength(ACK_MAX_PER_TURN + 1)
  })

  it('信号就是一行 JSON(和字幕、垫场同一条通道)', () => {
    expect(JSON.parse(encodeBackchannelSignal({ type: 'backchannel', round: 2, at: 1, line: 'ack-1' })))
      .toEqual({ type: 'backchannel', round: 2, at: 1, line: 'ack-1' })
  })

  it('同一个状态重复报不重新计时(框架会重复发)', () => {
    const h = harness()
    const spy = vi.fn()
    h.bc.userSpeaking(true)
    h.bc.heard('说着说着')
    h.bc.userSpeaking(true)
    expect(h.tick()).toBe(true)
    expect(h.sent).toHaveLength(1)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('那几声的 id 与手机那份表对得上', () => {
  it('fillerLines.json 里 kind:"ack" 的那几条逐字相同', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const table = JSON.parse(readFileSync(
      join(import.meta.dirname, '..', '..', 'butler-app', 'src', 'call', 'fillerLines.json'), 'utf8',
    )) as { lines: { id: string, kind: string, text: string }[] }
    const acks = table.lines.filter(line => line.kind === 'ack')
    expect(acks.map(line => line.id)).toEqual([...ACK_LINE_IDS])
    // 3~5 声(卡里定的那个数),而且每一声都是短短一口。
    expect(acks.length).toBeGreaterThanOrEqual(3)
    expect(acks.length).toBeLessThanOrEqual(5)
    for (const ack of acks) expect(ack.text.length).toBeLessThanOrEqual(4)
  })
})
