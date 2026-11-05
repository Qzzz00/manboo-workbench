/**
 * 道别即挂断(2026-09-23 晚,维护者真机 0.2.73:「说了拜拜之后没有真的拜拜」)。
 *
 * 钉四件事:
 * 1. ★★ **别误挂**:转述(「他跟我说了拜拜」)、「别挂」、道别之后又说了新的事 —— 否决;闲聊回合也不递工具;
 * 2. ★★ **等她那句道别播完再挂**:她还在 thinking / speaking 不挂,回到 listening 之后再等一小截才挂;
 * 3. ★ **等挂时他又说了话 → 不挂**;只是出声(噪声)没有识别结果 → 多等一会儿照挂;
 * 4. 工具与挂断那一条路:没有 endCall 就没有这件工具;ring_end / call_state 线上的样子老手机认得。
 */
import { describe, expect, it } from 'vitest'
import {
  END_CALL_ACCEPTED_TEXT,
  FAREWELL_MAX_WAIT_MS,
  FAREWELL_TAIL_MS,
  FAREWELL_USER_TAIL_MS,
  TOOL_END_CALL,
  createFarewellHangup,
  endCallVeto,
  offersEndCall,
} from '../src/farewell.ts'
import { RING_HANGUP_TEXTS, createCallState, createRingMachine, type RingCall } from '../src/callOut.ts'
import { createChannelTools } from '../src/tools.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

function fakeTimers() {
  const pending: { fn: () => void, at: number }[] = []
  let clock = 0
  return {
    setTimer: (fn: () => void, ms: number) => {
      const row = { fn, at: clock + ms }
      pending.push(row)
      return { cancel: () => { const i = pending.indexOf(row); if (i >= 0) pending.splice(i, 1) } }
    },
    advance(ms: number) {
      clock += ms
      for (const row of pending.filter(one => one.at <= clock)) {
        const i = pending.indexOf(row)
        if (i < 0) continue
        pending.splice(i, 1)
        row.fn()
      }
    },
  }
}

function machine() {
  const timers = fakeTimers()
  let hung = 0
  const lines: string[] = []
  const bye = createFarewellHangup({ hangup: () => { hung += 1 }, setTimer: timers.setTimer, log: line => lines.push(line) })
  return { bye, timers, hung: () => hung, lines }
}

describe('否决与递工具:别误挂', () => {
  it.each([
    '拜拜',
    '好,拜拜',
    '好的老板再见',
    '行,先这样吧,拜拜啦',
    '没事了,挂了吧',
    '好嘞,就这样吧,谢谢你',
    '晚安',
    'OK bye',
  ])('明确的道别「%s」→ 不否决、闲聊回合递挂断那一件', (said) => {
    expect(endCallVeto(said)).toBeUndefined()
    expect(offersEndCall(said)).toBe(true)
  })

  it.each([
    '他跟我说了拜拜',
    '她说再见就走了',
    '我老婆刚才叫我挂了电话',
  ])('★★ 转述「%s」→ 否决、不递工具', (said) => {
    expect(endCallVeto(said)).toMatch(/^没挂:他是在转述/)
    expect(offersEndCall(said)).toBe(false)
  })

  it.each([
    '先别挂',
    '别挂了,还有件事',
    '不挂了',
  ])('★★ 「%s」→ 否决', (said) => {
    expect(endCallVeto(said)).toMatch(/^没挂:/)
    expect(offersEndCall(said)).toBe(false)
  })

  it.each([
    ['拜拜,哦对了明天提醒我开会', '明天提醒我开会'],
    ['先这样吧,把那个文案再改一版', '把那个文案再改一版'],
    ['没事了吗', '吗'],
    ['明天再见到他的时候提醒我', '到他的时候提醒我'],
  ])('★★ 道别之后又说了新的事「%s」→ 否决,并说出后面那句', (said, rest) => {
    const veto = endCallVeto(said)
    expect(veto).toMatch(/^没挂:他道别之后又说了别的事/)
    expect(veto).toContain(rest)
    expect(offersEndCall(said)).toBe(false)
  })

  it('没有道别词 → 不否决(由模型判),但闲聊回合也不递这一件', () => {
    expect(endCallVeto('好嘞,那就到这里')).toBeUndefined()
    expect(offersEndCall('好嘞,那就到这里')).toBe(false)
    expect(offersEndCall('你是谁')).toBe(false)
  })

  it('原话是空的(打字那条路、没识别结果)→ 不否决,也不递', () => {
    expect(endCallVeto('')).toBeUndefined()
    expect(endCallVeto('   ')).toBeUndefined()
    expect(offersEndCall('')).toBe(false)
  })

  it('先道别、再说新事、最后又道别 → 以最后那个道别为准,不否决', () => {
    expect(endCallVeto('拜拜,哦对了那个记下来了吧,好那拜拜')).toBeUndefined()
  })
})

describe('等她那句道别播完再挂', () => {
  it('★★ 模型说要挂那一刻她还在这一回合里:不挂;回到 listening 之后再等一小截才挂,只挂一次', () => {
    const { bye, timers, hung } = machine()
    bye.agentState('thinking')
    expect(bye.request()).toBe(true)
    timers.advance(5_000)
    expect(hung()).toBe(0)
    bye.agentState('speaking')
    timers.advance(3_000)
    expect(hung()).toBe(0)
    bye.agentState('listening')
    timers.advance(FAREWELL_TAIL_MS - 1)
    expect(hung()).toBe(0)
    timers.advance(1)
    expect(hung()).toBe(1)
    expect(bye.pending).toBe(false)
    timers.advance(FAREWELL_MAX_WAIT_MS)
    expect(hung()).toBe(1)
  })

  it('★★ request 之前那个陈旧的 listening 不算:工具是在回合里调的,一律等她下一次收尾', () => {
    const { bye, timers, hung } = machine()
    bye.agentState('listening')
    bye.request()
    timers.advance(FAREWELL_TAIL_MS * 3)
    expect(hung()).toBe(0)
    bye.agentState('listening')
    timers.advance(FAREWELL_TAIL_MS)
    expect(hung()).toBe(1)
  })

  it('★ 同一回合里先说了一段、调工具时切回 thinking、再说道别:中间那次切换不挂', () => {
    const { bye, timers, hung } = machine()
    bye.request()
    bye.agentState('speaking')
    bye.agentState('thinking')
    timers.advance(FAREWELL_TAIL_MS * 2)
    bye.agentState('speaking')
    timers.advance(FAREWELL_TAIL_MS * 2)
    expect(hung()).toBe(0)
    bye.agentState('listening')
    timers.advance(FAREWELL_TAIL_MS)
    expect(hung()).toBe(1)
  })

  it('收尾之后那一小截里她又开口了(框架又起一段):那一截作废,等这一段收尾', () => {
    const { bye, timers, hung } = machine()
    bye.request()
    bye.agentState('listening')
    timers.advance(FAREWELL_TAIL_MS / 2)
    bye.agentState('speaking')
    timers.advance(FAREWELL_TAIL_MS * 2)
    expect(hung()).toBe(0)
    bye.agentState('listening')
    timers.advance(FAREWELL_TAIL_MS)
    expect(hung()).toBe(1)
  })

  it('重复 request 不重来,也不多挂一次', () => {
    const { bye, timers, hung } = machine()
    expect(bye.request()).toBe(true)
    expect(bye.request()).toBe(false)
    bye.agentState('listening')
    timers.advance(FAREWELL_TAIL_MS)
    expect(hung()).toBe(1)
  })

  it('保险丝:她的状态一直没回来,到上限照挂;但他正在说话时不挂', () => {
    const a = machine()
    a.bye.request()
    a.timers.advance(FAREWELL_MAX_WAIT_MS)
    expect(a.hung()).toBe(1)

    const b = machine()
    b.bye.request()
    b.bye.userSpeaking(true)
    b.timers.advance(FAREWELL_MAX_WAIT_MS)
    expect(b.hung()).toBe(0)
  })
})

describe('等挂的时候他又说话了', () => {
  it('★★ 他又说了一句(有识别结果)→ 不挂了,之后她收尾也不挂', () => {
    const { bye, timers, hung, lines } = machine()
    bye.request()
    bye.agentState('speaking')
    bye.userSpeaking(true)
    bye.agentState('listening') // 被他打断
    bye.userSpeaking(false)
    bye.heard('等一下,还有个事')
    timers.advance(FAREWELL_MAX_WAIT_MS * 2)
    expect(hung()).toBe(0)
    expect(bye.pending).toBe(false)
    expect(lines.join('\n')).toContain('不挂了')
  })

  it('★ 只是出了声(噪声、回声),没有识别结果 → 多等一会儿(给识别留时间)照挂', () => {
    const { bye, timers, hung } = machine()
    bye.request()
    bye.agentState('listening')
    bye.userSpeaking(true)
    timers.advance(FAREWELL_TAIL_MS * 3)
    expect(hung()).toBe(0)
    bye.userSpeaking(false)
    timers.advance(FAREWELL_TAIL_MS)
    expect(hung()).toBe(0)
    timers.advance(FAREWELL_USER_TAIL_MS - FAREWELL_TAIL_MS)
    expect(hung()).toBe(1)
  })

  it('空的识别结果不算说话', () => {
    const { bye, timers, hung } = machine()
    bye.request()
    bye.heard('  ')
    bye.agentState('listening')
    timers.advance(FAREWELL_TAIL_MS)
    expect(hung()).toBe(1)
  })

  it('他自己先挂了 / 人走了(reset)→ 不再挂第二次', () => {
    const { bye, timers, hung } = machine()
    bye.request()
    bye.reset()
    bye.agentState('listening')
    timers.advance(FAREWELL_MAX_WAIT_MS)
    expect(hung()).toBe(0)
  })

  it('挂断回调抛了不带走工人', () => {
    const timers = fakeTimers()
    const bye = createFarewellHangup({ hangup: () => { throw new Error('房间断了') }, setTimer: timers.setTimer })
    bye.request()
    bye.agentState('listening')
    expect(() => timers.advance(FAREWELL_TAIL_MS)).not.toThrow()
  })
})

describe('工具', () => {
  const workbench = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch })
  interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }

  it('没传 endCall 就没有这件工具(调不通的工具比没有更糟)', () => {
    expect(Object.keys(createChannelTools({ workbench }))).not.toContain(TOOL_END_CALL)
  })

  it('传了:模型调它 → 回 endCall 给的那句;没有参数', async () => {
    let asked = 0
    const tools = createChannelTools({ workbench, endCall: () => { asked += 1; return { ok: true, text: END_CALL_ACCEPTED_TEXT } } }) as unknown as Record<string, FakeTool>
    expect(Object.keys(tools)).toContain(TOOL_END_CALL)
    await expect(tools[TOOL_END_CALL]!.execute({}, {} as never)).resolves.toBe(END_CALL_ACCEPTED_TEXT)
    expect(asked).toBe(1)
  })

  it('被否决时回的是那句理由(模型照着接着聊)', async () => {
    const veto = endCallVeto('他跟我说了拜拜')!
    const tools = createChannelTools({ workbench, endCall: () => ({ ok: false, text: veto }) }) as unknown as Record<string, FakeTool>
    await expect(tools[TOOL_END_CALL]!.execute({}, {} as never)).resolves.toBe(veto)
  })
})

describe('由她挂:线上的样子(老手机 0.2.73 认得)', () => {
  const call: RingCall = { id: 'call-1', reason: 'confirm', item_id: 't', title: '改文案', at: '2026-09-23T12:00:00.000Z', silent: false }

  it('★★ 来电那一通:广播 ring_end{hung_up},**不带 by**,那句人话说是她挂的', () => {
    const sent: string[] = []
    const ring = createRingMachine({ send: line => sent.push(line), onAnswered: () => {}, onSettled: () => {} })
    ring.ring(call)
    ring.answer('call-1', 'phone')
    ring.hangup('butler')
    const last = JSON.parse(sent.at(-1)!) as Record<string, unknown>
    expect(last).toMatchObject({ type: 'ring_end', call_id: 'call-1', outcome: 'hung_up', text: RING_HANGUP_TEXTS.butler })
    expect(last).not.toHaveProperty('by')
  })

  it('★★ call_state{idle} 上写 by:"worker"(老手机只认 phone/handset/worker 三个词)', () => {
    const sent: string[] = []
    const state = createCallState({ send: line => sent.push(line) })
    state.enter('handset')
    expect(state.leave('butler')).toBe(true)
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({ type: 'call_state', state: 'idle', by: 'worker' })
    // 再挂一次什么都不发(派放下听筒时那一条 hangup 走到这儿就是这样)。
    expect(state.leave('handset')).toBe(false)
    expect(sent).toHaveLength(2)
  })
})
