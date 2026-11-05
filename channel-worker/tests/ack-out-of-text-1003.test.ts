/**
 * **她说的那一声「嗯 / 对 / 好」不进交给模型的文本**(2026-10-03,维护者拍板「抹掉」;
 * 来处是 `docs/交接-1003-中文打断判法.md` 第六节第 2 条那条待拍板)。
 *
 * 10-03 早那张卡把应声判成「不打断」之后,工人这边**整段不进回合**了,
 * 可框架那一头仍然把它攒着:`onEndOfTurn` 回 `false` 时 `audioTranscript` 不清
 * (`node_modules/@livekit/agents/dist/voice/audio_recognition.js` 第 1266–1275 行),
 * 下一句最终转写照旧 `audioTranscript += ' ' + transcript`(第 862–863 行)——
 * 于是交给模型的那份文本是「嗯 帮我把这条派给 Codex」。
 *
 * 这一包钉四件:
 *   ① **剥的是判定命中的那一截**,一个字都不多剥(纯函数 {@link stripLeadingAcks});
 *   ② `BargeIn` 记下来的就是它真丢掉的那几段(只记 final —— 框架只把 final 攒进 `audioTranscript`);
 *   ③ 卡上点名的三条用例:「嗯……帮我把这条派给 Codex」/「嗯」单独一句不是回合 /「嗯,不对」照旧全文;
 *   ④ **接线对照**(读 `src/agent.ts` 的源码):`onUserTurnCompleted` 这个口子接上了、
 *      剥完回写的是那条用户消息的 content、开关关着时一个字都不动。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACK_WORDS, makeIsBackchannelOnly } from '../src/backchannel.ts'
import { BargeIn, stripLeadingAcks } from '../src/bargeIn.ts'
import { channelWorkerConfigOf } from '../src/config.ts'

const SRC_DIR = join(import.meta.dirname, '..', 'src')
const read = (name: string): string => readFileSync(join(SRC_DIR, name), 'utf8')

// ———————————————————— ① 剥那一截 ————————————————————

describe('stripLeadingAcks:只剥开头那几段判定命中的应声', () => {
  it('卡上那条用例:「嗯 帮我把这条派给 Codex」→ 模型收到的是「帮我把这条派给 Codex」', () => {
    const got = stripLeadingAcks('嗯 帮我把这条派给 Codex', ['嗯'])
    expect(got.text).toBe('帮我把这条派给 Codex')
    expect(got.stripped).toEqual(['嗯'])
  })

  it('应声带标点也剥得掉(ASR 回来的是「嗯。」)', () => {
    expect(stripLeadingAcks('嗯。 帮我把这条派给 Codex', ['嗯。']).text).toBe('帮我把这条派给 Codex')
  })

  it('连着两声应声,两段都剥(按记下来的顺序)', () => {
    const got = stripLeadingAcks('嗯 对 帮我把这条派给 Codex', ['嗯', '对'])
    expect(got.text).toBe('帮我把这条派给 Codex')
    expect(got.stripped).toEqual(['嗯', '对'])
  })

  it('**一个字都不多剥**:下一句开头也是「嗯」时,只剥记下来的那一截', () => {
    // 「嗯,不对」是真打断(判成 stop、照旧全文),前面那一声「嗯」才是被丢掉的那一段。
    const got = stripLeadingAcks('嗯 嗯,不对', ['嗯'])
    expect(got.text).toBe('嗯,不对')
    expect(got.stripped).toEqual(['嗯'])
  })

  it('没记下任何一段 → 原文一个字不动', () => {
    const got = stripLeadingAcks('嗯,不对', [])
    expect(got.text).toBe('嗯,不对')
    expect(got.stripped).toEqual([])
  })

  it('记下的那一段不在开头 → 不剥(不猜它去哪儿了)', () => {
    const got = stripLeadingAcks('帮我把这条派给 Codex 嗯', ['嗯'])
    expect(got.text).toBe('帮我把这条派给 Codex 嗯')
    expect(got.stripped).toEqual([])
  })

  it('剥到最后一个字都不剩 → **退回原文**(宁可多一声嗯,不许交一句空话上去)', () => {
    const got = stripLeadingAcks('嗯', ['嗯'])
    expect(got.text).toBe('嗯')
    expect(got.stripped).toEqual([])
  })

  it('空的 / 全是空白也退回原文', () => {
    expect(stripLeadingAcks('', ['嗯']).text).toBe('')
    expect(stripLeadingAcks('   ', ['嗯']).text).toBe('   ')
  })

  it('开头的空白照框架那条路 trimStart 过,所以剥完也顺手去掉分隔的那一个空格', () => {
    expect(stripLeadingAcks('嗯   帮我查一下天气', ['嗯']).text).toBe('帮我查一下天气')
  })
})

// ———————————————————— ② BargeIn 记的就是它真丢掉的那几段 ————————————————————

describe('BargeIn:丢掉的那几段应声记下来,交给回合入口去剥', () => {
  function make(): { gate: BargeIn, stops: string[] } {
    const stops: string[] = []
    const gate = new BargeIn({
      stop: why => stops.push(why),
      now: () => 1000,
      setTimer: () => () => {},
    })
    return { gate, stops }
  }

  it('她手上有话、他只应了一声 → 判 ack,而且那一段被记下来', () => {
    const { gate, stops } = make()
    gate.agentHasFloor(true)
    gate.userSpeaking(true)
    expect(gate.heard('嗯', true)).toBe('ack')
    expect(gate.droppedAcks).toEqual(['嗯'])
    expect(stops).toHaveLength(0)
  })

  it('**只记 final** —— 框架只把 final 攒进 audioTranscript,中间结果那几条会被它自己清掉', () => {
    const { gate } = make()
    gate.agentHasFloor(true)
    gate.userSpeaking(true)
    expect(gate.heard('嗯', false)).toBe('ack')
    expect(gate.droppedAcks).toEqual([])
    expect(gate.heard('嗯', true)).toBe('ack')
    expect(gate.droppedAcks).toEqual(['嗯'])
  })

  it('真打断那一段不记(它本来就要原样进回合)', () => {
    const { gate } = make()
    gate.agentHasFloor(true)
    gate.userSpeaking(true)
    expect(gate.heard('嗯,不对', true)).toBe('stop')
    expect(gate.droppedAcks).toEqual([])
  })

  it('她手上没话时的那一声「好」判 turn,不记 —— 那是他的一句答复', () => {
    const { gate } = make()
    gate.userSpeaking(true)
    expect(gate.heard('好', true)).toBe('turn')
    expect(gate.droppedAcks).toEqual([])
  })

  it('takeDroppedAcks 取一次就清空(一回合算一次账)', () => {
    const { gate } = make()
    gate.agentHasFloor(true)
    gate.userSpeaking(true)
    gate.heard('嗯', true)
    gate.heard('对', true)
    expect(gate.takeDroppedAcks()).toEqual(['嗯', '对'])
    expect(gate.droppedAcks).toEqual([])
    expect(gate.takeDroppedAcks()).toEqual([])
  })

  it('同一段里丢了两声,顺序照听见的来', () => {
    const { gate } = make()
    gate.agentHasFloor(true)
    gate.userSpeaking(true)
    gate.heard('嗯', true)
    gate.heard('对', true)
    expect(gate.droppedAcks).toEqual(['嗯', '对'])
  })

  it('掐过之后那一段整个算打断,不再往里记', () => {
    const { gate } = make()
    gate.agentHasFloor(true)
    gate.userSpeaking(true)
    expect(gate.heard('等一下', true)).toBe('stop')
    // 掐过之后框架那两道门让路,这一段照旧提交 —— 后面来的转写一律当 stop。
    expect(gate.heard('嗯', true)).toBe('stop')
    expect(gate.droppedAcks).toEqual([])
  })

  it('运营那层改过的词表照样算数(应声这一头与打断那一头同一把判子)', () => {
    const stops: string[] = []
    const gate = new BargeIn({
      stop: why => stops.push(why),
      now: () => 1000,
      setTimer: () => () => {},
      isAck: makeIsBackchannelOnly([...ACK_WORDS, '嗯呐']),
    })
    gate.agentHasFloor(true)
    gate.userSpeaking(true)
    expect(gate.heard('嗯呐', true)).toBe('ack')
    expect(gate.droppedAcks).toEqual(['嗯呐'])
  })
})

// ———————————————————— ③ 卡上点名的三条,一条一条走完整条路 ————————————————————

describe('卡上点名的三条用例(判 → 记 → 剥,一条链走完)', () => {
  /** 把一通话里的几段转写喂进去,回「框架那头会交给模型的那句话」。 */
  function run(segments: readonly { text: string, floor: boolean }[]): { committed: string, turn: string[] } {
    const gate = new BargeIn({ stop: () => {}, now: () => 1000, setTimer: () => () => {} })
    // 框架那头攒的那一份(audio_recognition.js 第 862–863 行:`+= ' ' + transcript` 再 trimStart)。
    let audioTranscript = ''
    // 工人这边进回合的那几段(hearFinalText 收到的)。
    const turn: string[] = []
    for (const one of segments) {
      gate.agentHasFloor(one.floor)
      gate.userSpeaking(true)
      const verdict = gate.heard(one.text, true)
      audioTranscript = `${audioTranscript} ${one.text}`.trimStart()
      if (verdict !== 'ack') turn.push(one.text)
    }
    return { committed: stripLeadingAcks(audioTranscript, gate.takeDroppedAcks()).text, turn }
  }

  it('「嗯……帮我把这条派给 Codex」→ 模型收到的是「帮我把这条派给 Codex」', () => {
    const got = run([
      { text: '嗯', floor: true },
      { text: '帮我把这条派给 Codex', floor: true },
    ])
    expect(got.committed).toBe('帮我把这条派给 Codex')
    expect(got.turn).toEqual(['帮我把这条派给 Codex'])
  })

  it('「嗯」单独一句不是一个回合 —— 工人这边一段都不进回合', () => {
    const got = run([{ text: '嗯', floor: true }])
    expect(got.turn).toEqual([])
    // 剩下的那句话是空的 → 退回原文(不许把一句空话交上去;她手上没话了那一声「嗯」才是答复)。
    expect(got.committed).toBe('嗯')
  })

  it('「嗯,不对」是真打断 —— **照旧全文**', () => {
    const got = run([{ text: '嗯,不对', floor: true }])
    expect(got.committed).toBe('嗯,不对')
    expect(got.turn).toEqual(['嗯,不对'])
  })

  it('她手上没话的时候那一声「好」照旧原样交上去', () => {
    const got = run([{ text: '好', floor: false }])
    expect(got.committed).toBe('好')
    expect(got.turn).toEqual(['好'])
  })
})

// ———————————————————— ④ 开关 ————————————————————

describe('开关:WORKBENCH_CHANNEL_ACK_OUT_OF_TEXT', () => {
  it('不配 = 开(维护者拍板「抹掉」)', () => {
    expect(channelWorkerConfigOf({}).ackOutOfText).toBe(true)
  })

  it('=off 就逐字回到上游行为(那一声嗯接在下一句前面一起交上去)', () => {
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_ACK_OUT_OF_TEXT: 'off' }).ackOutOfText).toBe(false)
  })
})

// ———————————————————— ⑤ 接线对照(读 src/agent.ts 的源码) ————————————————————

describe('接线对照:agent.ts 真把这一处接在回合入口上', () => {
  const agentSrc = read('agent.ts')

  it('接的是上游那个口子 `onUserTurnCompleted`(回合提交前、调模型前)', () => {
    expect(agentSrc).toContain('agent.onUserTurnCompleted')
  })

  it('剥完回写的是那条用户消息的 content,而且用的是 BargeIn 记下的那几段', () => {
    const at = agentSrc.indexOf('agent.onUserTurnCompleted')
    expect(at).toBeGreaterThan(0)
    const hook = agentSrc.slice(at, at + 2000)
    expect(hook).toContain('takeDroppedAcks')
    expect(hook).toContain('stripLeadingAcks')
    expect(hook).toContain('.content')
  })

  it('开关关着时一个字都不剥', () => {
    const at = agentSrc.indexOf('agent.onUserTurnCompleted')
    const hook = agentSrc.slice(at, at + 2000)
    expect(hook).toContain('ackOutOfText')
  })
})
