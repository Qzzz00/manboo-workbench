/**
 * 工人这一侧的主动来电(2026-09-21):振铃状态机 + 接起来那一刻说什么。
 *
 * 钉三条路:**接起**(她这才开口)、**60 秒没人接**(记未接,不重拨)、**取消**
 * (掉线 / 工人退出 —— 不按未接记);外加「正响着又来一通」要排队,
 * 以及夜间静默那一通**压根不等人接**。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  RING_HANGUP_TEXTS,
  RING_REASON_TITLES,
  RING_TIMEOUT_MS,
  createCallState,
  createRingMachine,
  parseRingCall,
  ringInstructions,
  ringOpener,
  shouldRing,
  type RingCall,
} from '../src/callOut.ts'
import { CALL_RPC_ACTIONS, handleRpcRequest, isAllowedRpcPath, parseRpcRequest, type RpcCallPort, type RpcWorkbenchPort } from '../src/rpc.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

function call(patch: Partial<RingCall> = {}): RingCall {
  return {
    id: 'call-1',
    reason: 'confirm',
    item_id: 'task-1',
    title: '把首页文案改一版',
    at: '2026-09-21T06:00:00.000Z',
    silent: false,
    ...patch,
  }
}

/** 一台手动推进的计时器:测试里不真等 60 秒。 */
function fakeTimers() {
  const pending: { fn: () => void, at: number }[] = []
  let clock = 0
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const row = { fn, at: clock + ms }
      pending.push(row)
      return { cancel: () => { const i = pending.indexOf(row); if (i >= 0) pending.splice(i, 1) } }
    },
    advance(ms: number) {
      clock += ms
      for (const row of pending.filter(one => one.at <= clock)) {
        pending.splice(pending.indexOf(row), 1)
        row.fn()
      }
    },
  }
}

function machine(overrides: Partial<Parameters<typeof createRingMachine>[0]> = {}) {
  const timers = fakeTimers()
  const sent: string[] = []
  /** 点名发出去的那几条(2026-09-23 的补发那条路)。广播不进这一本。 */
  const aimed: { to: string, line: string }[] = []
  const answered: RingCall[] = []
  const settled: { call: RingCall, outcome: string, text?: string }[] = []
  const ring = createRingMachine({
    send: line => sent.push(line),
    sendTo: (to, line) => aimed.push({ to, line }),
    onAnswered: one => answered.push(one),
    onSettled: (one, outcome, text) => settled.push({ call: one, outcome, ...(text === undefined ? {} : { text }) }),
    now: timers.now,
    setTimer: timers.setTimer,
    ...overrides,
  })
  const messages = () => sent.map(line => JSON.parse(line) as Record<string, unknown>)
  const aimedAt = () => aimed.map(one => ({ to: one.to, message: JSON.parse(one.line) as Record<string, unknown> }))
  return { ring, timers, messages, aimed, aimedAt, answered, settled }
}

describe('振铃状态机', () => {
  it('响一通:往房里广播 ring,带理由、标题与响到什么时候为止', () => {
    const { ring, messages, timers } = machine()
    ring.ring(call())
    const [first] = messages()
    expect(first).toMatchObject({ type: 'ring', call_id: 'call-1', reason: 'confirm', title: '把首页文案改一版', silent: false })
    expect(first!.until).toBe(timers.now() + RING_TIMEOUT_MS)
  })

  it('**接起来之前一个字都不说**;接起来那一刻才 onAnswered', () => {
    const { ring, answered, settled, messages } = machine()
    ring.ring(call())
    expect(answered).toEqual([])
    expect(ring.current()?.id).toBe('call-1')

    expect(ring.answer('call-1')).toEqual({ ok: true })
    expect(answered.map(one => one.id)).toEqual(['call-1'])
    expect(settled[0]).toMatchObject({ outcome: 'answered' })
    expect(messages().at(-1)).toMatchObject({ type: 'ring_end', call_id: 'call-1', outcome: 'answered' })
    expect(ring.answered()?.id).toBe('call-1')
  })

  it('接起一个对不上的 id 就如实拒 —— 铃可能刚好在他按下去那一刻超时了', () => {
    const { ring, answered } = machine()
    ring.ring(call())
    expect(ring.answer('别的')).toMatchObject({ ok: false })
    expect(answered).toEqual([])
    // 没有电话在响时更不能接
    ring.answer('call-1')
    expect(ring.answer('call-1')).toMatchObject({ ok: false })
  })

  it('60 秒没人接 → 未接,**不重拨**', () => {
    const { ring, settled, timers, messages } = machine()
    ring.ring(call())
    timers.advance(RING_TIMEOUT_MS - 1)
    expect(settled).toEqual([])
    timers.advance(1)
    expect(settled[0]).toMatchObject({ outcome: 'missed' })
    expect(settled[0]?.text).toContain('60 秒')
    expect(messages().filter(one => one.type === 'ring').length).toBe(1)
  })

  it('他按「稍后」= 未接(不是另一种状态)', () => {
    const { ring, settled } = machine()
    ring.ring(call())
    expect(ring.later('call-1')).toEqual({ ok: true })
    expect(settled[0]).toMatchObject({ outcome: 'missed', text: '他按了「稍后」' })
  })

  it('正响着又来一通就排队;前一通了结之后它才响', () => {
    const { ring, messages, timers } = machine()
    ring.ring(call({ id: 'a' }))
    ring.ring(call({ id: 'b' }))
    expect(messages().filter(one => one.type === 'ring').map(one => one.call_id)).toEqual(['a'])
    timers.advance(RING_TIMEOUT_MS)
    expect(messages().filter(one => one.type === 'ring').map(one => one.call_id)).toEqual(['a', 'b'])
  })

  it('**通话中不响下一通**;他挂了才响', () => {
    const { ring, messages } = machine()
    ring.ring(call({ id: 'a' }))
    ring.answer('a')
    ring.ring(call({ id: 'b' }))
    expect(messages().filter(one => one.type === 'ring').map(one => one.call_id)).toEqual(['a'])
    ring.hangup()
    expect(messages().filter(one => one.type === 'ring').map(one => one.call_id)).toEqual(['a', 'b'])
  })

  /**
   * ——— 是谁接的(2026-09-22 晚,Ben 20:50 真机那一条) ———
   *
   * 手机与话筒同时在房里时,`ring_end{answered}` 里**明着写是谁接的**。
   * 房里另一台据此知道「这一通不归我出声」—— 不放她的声音、不推自己的麦克风。
   * 0921 那版刻意没有这一格(「手机能推断,够用」);今天不够用了,
   * 因为推断出来的结论要拿去决定扬声器开不开,推错就是「他对着话筒说话,
   * 声音却从手机里出来」。
   */
  describe('接起时广播「是谁接的」', () => {
    it('★ 话筒接的 → ring_end 带 by:handset', () => {
      const { ring, messages } = machine()
      ring.ring(call())
      expect(ring.answer('call-1', 'handset')).toEqual({ ok: true })
      expect(messages().at(-1)).toMatchObject({ type: 'ring_end', call_id: 'call-1', outcome: 'answered', by: 'handset' })
    })

    it('★ 手机接的 → ring_end 带 by:phone', () => {
      const { ring, messages } = machine()
      ring.ring(call())
      ring.answer('call-1', 'phone')
      expect(messages().at(-1)).toMatchObject({ outcome: 'answered', by: 'phone' })
    })

    it('★ 带上接起那一台的 identity(2026-09-23 晚:广播先于回话到,手机靠它认出「是我」)', () => {
      const { ring, messages } = machine()
      ring.ring(call())
      ring.answer('call-1', 'phone', 'wb-phone-dev1')
      expect(messages().at(-1)).toMatchObject({ outcome: 'answered', by: 'phone', by_identity: 'wb-phone-dev1' })
    })

    it('没说是谁接的就**不编一个**(老的调用方 / 用例):那一格整个缺席', () => {
      const { ring, messages } = machine()
      ring.ring(call())
      ring.answer('call-1')
      expect(messages().at(-1)).not.toHaveProperty('by')
      expect(messages().at(-1)).not.toHaveProperty('by_identity')
    })
  })

  /**
   * ——— 话筒挂机那条路(2026-09-22,待拍板 E1) ———
   *
   * 三条路各自该发什么:手机挂的**不发**(它本来就知道)、话筒挂的与工人补刀的**发一条
   * `hung_up`**(手机上那面「字幕 + 挂断」靠它自己收掉)。三条都不再 ack 8791 ——
   * 这一通在接起来那一刻就记成 answered 了。
   */
  describe('挂断要不要广播', () => {
    it('**话筒挂机 → 广播 ring_end{outcome:"hung_up"}**,手机据此收掉那面', () => {
      const { ring, messages, settled } = machine()
      ring.ring(call())
      ring.answer('call-1')
      const before = settled.length
      ring.hangup('handset')
      expect(messages().at(-1)).toMatchObject({
        type: 'ring_end', call_id: 'call-1', outcome: 'hung_up', by: 'handset', text: RING_HANGUP_TEXTS.handset,
      })
      // 台账上不该多出一行:这一通的收场在接起来那一刻就已经记过了。
      expect(settled).toHaveLength(before)
    })

    it('**手机自己挂的不广播** —— 再发回去只是一条回声', () => {
      const { ring, messages } = machine()
      ring.ring(call())
      ring.answer('call-1')
      const before = messages().length
      ring.hangup('phone')
      expect(messages()).toHaveLength(before)
      expect(messages().filter(one => one.outcome === 'hung_up')).toEqual([])
    })

    it('工人自己补的那一刀(房里没人了)照样广播,缺省就是这一种', () => {
      const { ring, messages } = machine()
      ring.ring(call())
      ring.answer('call-1')
      ring.hangup()
      expect(messages().at(-1)).toMatchObject({ outcome: 'hung_up', text: RING_HANGUP_TEXTS.worker })
      // `worker` 不是一台设备,所以那一格整个缺席 —— 不拿「工人」冒充一台机器。
      expect(messages().at(-1)).not.toHaveProperty('by')
    })

    it('没有在通话里就什么都不发 —— 不能凭空宣布一通电话挂了', () => {
      const { ring, messages } = machine()
      ring.hangup('handset')
      expect(messages()).toEqual([])
      // 只是响着(没人接起)也一样:没接起来的电话挂不了。
      ring.ring(call())
      const before = messages().length
      ring.hangup('handset')
      expect(messages()).toHaveLength(before)
    })

    it('广播完排着的下一通照旧开始响(挂断的老行为一个字没变)', () => {
      const { ring, messages } = machine()
      ring.ring(call({ id: 'a' }))
      ring.answer('a')
      ring.ring(call({ id: 'b' }))
      ring.hangup('handset')
      expect(messages().filter(one => one.type === 'ring').map(one => one.call_id)).toEqual(['a', 'b'])
    })
  })

  /**
   * ——— 晚进房的那一位要补一份铃(2026-09-23 真机 10:27) ———
   *
   * 工人刚重启就排了一通铃,那一刻房里只有座机话筒,手机几秒后才回来。
   * `ring` 是一次性广播,手机一声没响,60 秒后台账上却记了一条「未接」。
   */
  describe('响铃中新参与者进房', () => {
    it('★ 响着的时候补发给它一份 —— **同一个 call_id、同一个 until**,一个字节不重编', () => {
      const { ring, messages, aimedAt } = machine()
      ring.ring(call())
      const broadcast = messages()[0]!
      expect(ring.resendRingTo('phone-1')).toBe(true)
      expect(aimedAt()).toHaveLength(1)
      expect(aimedAt()[0]?.to).toBe('phone-1')
      // 逐字相同:重新算一次 until 等于偷偷把这一通延长,手机那根倒计时会比工人那根晚到点。
      expect(aimedAt()[0]?.message).toEqual(broadcast)
      expect(aimedAt()[0]?.message.type).toBe('ring')
    })

    it('★ **点名发,不全房重播** —— 广播那一本一条都没多', () => {
      const { ring, messages } = machine()
      ring.ring(call())
      const before = messages().length
      ring.resendRingTo('phone-1')
      expect(messages()).toHaveLength(before)
    })

    it('★ 不在响就不发:待机、已接起、超时之后都一条不补', () => {
      const { ring, aimed, timers } = machine()
      // 待机
      expect(ring.resendRingTo('phone-1')).toBe(false)
      // 已接起(通话中)——他手里正拿着电话,补一条铃过去是在说假话
      ring.ring(call())
      ring.answer('call-1', 'handset')
      expect(ring.resendRingTo('phone-1')).toBe(false)
      ring.hangup('handset')
      // 超时之后
      ring.ring(call({ id: 'call-2' }))
      timers.advance(RING_TIMEOUT_MS)
      expect(ring.resendRingTo('phone-1')).toBe(false)
      expect(aimed).toEqual([])
    })

    it('夜间静默那一通**没有可补的**:它压根没响过', () => {
      const { ring, aimed } = machine()
      ring.ring(call({ id: 'night', silent: true }))
      expect(ring.resendRingTo('phone-1')).toBe(false)
      expect(aimed).toEqual([])
    })

    it('排着的那一通开始响之后,补发的是**新的那一条**(新 call_id、新 until)', () => {
      const { ring, timers, aimedAt, messages } = machine()
      ring.ring(call({ id: 'a' }))
      ring.ring(call({ id: 'b' }))
      timers.advance(RING_TIMEOUT_MS)
      ring.resendRingTo('phone-1')
      const second = messages().filter(one => one.type === 'ring').at(-1)!
      expect(aimedAt().at(-1)?.message).toEqual(second)
      expect(aimedAt().at(-1)?.message.call_id).toBe('b')
    })

    it('没接 sendTo 的调用方(老用例)什么都不做,**也不退回广播**', () => {
      const sent: string[] = []
      const bare = createRingMachine({
        send: line => sent.push(line),
        onAnswered: () => {},
        onSettled: () => {},
        log: () => {},
      })
      bare.ring(call())
      const before = sent.length
      expect(bare.resendRingTo('phone-1')).toBe(false)
      expect(sent).toHaveLength(before)
    })
  })

  it('掉线 / 工人退出:正响着的与排着的一律取消,**不按未接记**', () => {
    const { ring, settled } = machine()
    ring.ring(call({ id: 'a' }))
    ring.ring(call({ id: 'b' }))
    ring.cancel('和房间断开了')
    expect(settled.map(one => `${one.call.id}:${one.outcome}`)).toEqual(['a:canceled', 'b:canceled'])
  })

  it('夜间静默那一通**不等人接**:发出去就记 notified,马上轮到下一通', () => {
    const { ring, settled, messages, timers } = machine()
    ring.ring(call({ id: 'night', silent: true }))
    expect(settled[0]).toMatchObject({ outcome: 'notified' })
    // 没响过就没有要收掉的来电页 —— 不发 ring_end。
    expect(messages().filter(one => one.type === 'ring_end')).toEqual([])
    timers.advance(RING_TIMEOUT_MS * 2)
    expect(settled).toHaveLength(1)
  })

  it('记账那一步抛了也要让她开口 —— 他已经把电话拿起来了', () => {
    const { ring } = machine()
    const answered: RingCall[] = []
    const boom = createRingMachine({
      send: () => {},
      onAnswered: one => answered.push(one),
      onSettled: () => { throw new Error('台账炸了') },
      log: () => {},
    })
    boom.ring(call())
    expect(boom.answer('call-1')).toEqual({ ok: true })
    expect(answered).toHaveLength(1)
    expect(ring.current()).toBeUndefined()
  })
})

describe('接起来之后说什么', () => {
  /**
   * ——— 开场白(2026-09-23 定、**2026-10-13 维护者收回重定**)———
   *
   * 09-23 她定的是「只说一句『有个事要跟你确认一下』,那件事等他接话再由模型说」——
   * 理由是「念标题就是公文」。10-13 上午她收回了:
   * 「接起来也不说事,还要我来问,问完她垫了一句我想想,我气笑了。」
   *
   * 所以这一组现在钉的是:**同一句就把事说清**(称呼 + 这件事是什么 + 她要做什么),
   * 而「不念公文」那条规矩留着 —— 办法是把标题里的格式字眼拆开再拼成人话
   * (`plainRingSubject`),不是把整行标题念出去。不自我介绍、不摆选项照旧。
   */
  it('★开场同一句就把事说清:称呼 + 这件事 + 她要做什么(格式字眼不念)', () => {
    const line = ringOpener(call(), { address: '老板' })
    expect(line).toBe('老板,把首页文案改一版办完了,等你验收。')
    expect(line).not.toContain('task-1')
    expect(line).not.toContain('批准')
    expect(line).not.toContain('我打给你是因为')
    // 从前那一句没有内容,正是维护者 10-13 要去掉的
    expect(line).not.toBe('老板,有件事跟你确认一下。')
  })

  it('★不自我介绍:第一句里没有「我是」「是我」这种话', () => {
    for (const reason of ['confirm', 'failed', 'done'] as const) {
      const line = ringOpener(call({ reason }), { address: '姚总' })
      expect(line.startsWith('姚总,')).toBe(true)
      expect(line).not.toContain('是我')
      expect(line).not.toContain('我是')
    }
  })

  it('三种理由各一句,失败那一通说的是「卡住了」+ 问下一步', () => {
    expect(ringOpener(call({ reason: 'failed' }), { address: '老板' })).toBe('老板,把首页文案改一版卡住了,你说下一步怎么办。')
    expect(ringOpener(call({ reason: 'done' }), { address: '老板' })).toContain('办完了')
  })

  it('不给称呼就退回「老板」,**绝不直呼其名**', () => {
    expect(ringOpener(call()).startsWith('老板,')).toBe(true)
    expect(ringOpener(call(), { address: '  ' }).startsWith('老板,')).toBe(true)
  })

  it('并进来的那几件不进开场白 —— 报数是汇报,不是打招呼', () => {
    const line = ringOpener(call({ reason: 'done', merged: [{ item_id: 'x', title: '甲' }, { item_id: 'y', title: '乙' }] }))
    expect(line).not.toContain('2 件')
    expect(line).not.toContain('甲')
  })

  it('提示词把三句人话与三个 decision 一一对上,并交代「开场白别再念一遍」', () => {
    const text = ringInstructions('我是事务官。', call())
    expect(text).toContain('我是事务官。')
    expect(text).toContain('decision=approve')
    expect(text).toContain('decision=redo')
    expect(text).toContain('decision=later')
    expect(text).toContain('一个字都不要重复')
    expect(text).toContain('task-1')
  })

  /** 标题从开场白里拿掉了,那它去哪了:**进了提示词**,让她照着讲人话而不是照着念。 */
  it('★标题挪进提示词:明着写「不要把标题原样念出来」', () => {
    const text = ringInstructions('我是事务官。', call(), { address: '姚总' })
    expect(text).toContain('把首页文案改一版')
    expect(text).toContain('不要把标题原样念出来')
    // 开场白原文也带进去 —— 她得知道自己已经说过哪一句、已经叫过他什么。
    expect(text).toContain(ringOpener(call(), { address: '姚总' }))
    expect(text).toContain('不要自我介绍')
  })

  /**
   * ★ **没调工具就不许说「我去重派一次」,派成了也不许许诺回电**(2026-10-01)。
   * Air 09-29 那通电话的日志:她说「我去重派一次,有结果打电话告诉你」,这一回合里**只调了查进度那件工具** ——
   * 一下都没再派,也没有任何东西会在有结果时打回来(派出去成了只记在看板上,维护者 09-30 定)。
   */
  describe('不许许诺没做的事、也不许许诺回电(2026-10-01)', () => {
    it('「等你确认」「卡住了」那两通里明着写这两条', () => {
      for (const reason of ['confirm', 'failed'] as const) {
        const text = ringInstructions('我是事务官。', call({ reason }))
        expect(text).toContain('不许说没做的事')
        expect(text).toContain('不许许诺回电')
        expect(text).toContain('查一下进度不是派活')
      }
    })

    it('只转述的那两通(汇报 / 捎话回音)不摆这一段 —— 那里根本没有派活这回事', () => {
      for (const reason of ['done', 'relay'] as const) {
        expect(ringInstructions('我是事务官。', call({ reason }))).not.toContain('不许许诺回电')
      }
    })
  })

  it('「完成」那一通只是汇报:明说不要替他改状态', () => {
    const text = ringInstructions('我是事务官。', call({ reason: 'done' }))
    expect(text).toContain('只是汇报')
    expect(text).not.toContain('decision=approve')
  })

  /**
   * 2026-09-23,Ben 第四通真机:来意是「等你确认」,他没接这个话茬,她**追了两轮**。
   * 前一版提示词里那句「听不清、他说的不是这三类,就**再问一遍**」正是出处。
   */
  describe('「等你确认」只问一次(2026-09-23)', () => {
    it('明着写:开场问一次,他没接就顺着聊,挂断前也不重提', () => {
      const text = ringInstructions('我是事务官。', call())
      expect(text).toContain('这个问题只问一次')
      expect(text).toContain('不要追问')
      expect(text).toContain('挂断之前也不要再提它')
    })

    it('「再问一遍」那句话从提示词里没了', () => {
      for (const reason of ['confirm', 'failed', 'done'] as const) {
        expect(ringInstructions('我是事务官。', call({ reason }))).not.toContain('再问一遍')
      }
    })

    it('他没给说法就什么都不落 —— 但也绝不自己挑一个', () => {
      const text = ringInstructions('我是事务官。', call({ reason: 'failed' }))
      expect(text).toContain('什么都不落')
      expect(text).toContain('绝不自己挑一个')
    })

    it('「完成」那一类同一个口径', () => {
      const text = ringInstructions('我是事务官。', call({ reason: 'done' }))
      expect(text).toContain('这个问题只问一次')
      expect(text).toContain('不要追问')
    })

    it('他自己问起来不算追问 —— 那一句照实再说一次是可以的', () => {
      expect(ringInstructions('我是事务官。', call())).toContain('那是他自己开的口,不算追问')
    })

    /** 「关于我自己」那段是**底子**的一部分:来电这一通里也得在她眼前(agent.ts 的 wearRing)。 */
    it('底子原样带进这一通的提示词(人设 + 关于我自己)', () => {
      const base = '我是事务官。\n\n——— 关于我自己 ———\n- 接话模型:deepseek-v4-flash'
      const text = ringInstructions(base, call())
      expect(text).toContain('——— 关于我自己 ———')
      expect(text).toContain('- 接话模型:deepseek-v4-flash')
    })
  })
})

describe('8791 交下来的那一条', () => {
  it('读得懂的照单收下', () => {
    expect(parseRingCall({ id: 'a', reason: 'failed', item_id: 't', title: '甲', at: 'x', silent: true }))
      .toMatchObject({ id: 'a', reason: 'failed', silent: true })
  })

  it('缺字段 / 理由不认识都回 undefined,**绝不抛**(它跨进程来)', () => {
    expect(parseRingCall(null)).toBeUndefined()
    expect(parseRingCall({ id: 'a', reason: '随便', item_id: 't', title: '甲' })).toBeUndefined()
    expect(parseRingCall({ reason: 'done', item_id: 't', title: '甲' })).toBeUndefined()
  })
})

describe('房间代理上那三条', () => {
  const workbench: RpcWorkbenchPort = {
    callAsDevice: async () => ({ status: 200, body: {} }),
    renewTicket: async () => ({ token: 't', expires_at: 1 }),
  }

  it('answer / later 必须带 call_id', () => {
    expect(parseRpcRequest(JSON.stringify({ id: '1', type: 'call', action: 'answer' }))).toMatchObject({ ok: false })
    expect(parseRpcRequest(JSON.stringify({ id: '1', type: 'call', action: 'answer', call_id: 'c' })))
      .toEqual({ ok: true, request: { id: '1', type: 'call', action: 'answer', call_id: 'c' } })
    expect(CALL_RPC_ACTIONS).toContain('hangup')
  })

  it('接起那一条走到 port.answer,回话原样带回去', async () => {
    const port: RpcCallPort = {
      greet: vi.fn(async () => ({ ok: true })),
      answer: vi.fn(async () => ({ ok: true })),
      later: vi.fn(async () => ({ ok: false, error: '这会儿没有电话在响' })),
    }
    expect(await handleRpcRequest({ id: 'a', type: 'call', action: 'answer', call_id: 'c1' }, { deviceId: 'd', workbench, call: port }))
      .toEqual({ id: 'a', type: 'call', ok: true })
    // identity 没给(老的接线 / 这条用例)就不带 by —— 见 rpc.ts 那段注释。
    expect(port.answer).toHaveBeenCalledWith('c1', undefined)
    expect(await handleRpcRequest({ id: 'b', type: 'call', action: 'later', call_id: 'c1' }, { deviceId: 'd', workbench, call: port }))
      .toEqual({ id: 'b', type: 'call', ok: false, error: '这会儿没有电话在响' })
  })

  it('老包挂断时不发 hangup,新包发了也不该炸 —— port 上没有它就当成了', async () => {
    const port: RpcCallPort = { greet: async () => ({ ok: true }), answer: async () => ({ ok: true }), later: async () => ({ ok: true }) }
    expect(await handleRpcRequest({ id: 'a', type: 'call', action: 'hangup' }, { deviceId: 'd', workbench, call: port }))
      .toEqual({ id: 'a', type: 'call', ok: true })
  })

  /**
   * ★ 2026-09-22 晚(Ben:「响铃应该是手机发出,而不是话筒,话筒自己是用来对话的」)。
   *
   * 接起那一条也要带上**是哪一台接的**:工人拿它把接话对象钉到那一台上
   * (谁接谁说话),并把它写进 `ring_end{answered}` 的广播里,
   * 让房里另一台知道「这一通不归我出声」。身份与种类都来自凭证里签的属性,
   * **不是设备自称的** —— 房里的自称一个字都不能信(同挂断那一条的理由)。
   */
  it('★ 接起把「谁接的」(身份 + 种类)带给 port', async () => {
    const seen: unknown[] = []
    const port: RpcCallPort = {
      greet: async () => ({ ok: true }),
      answer: async (_callId, by) => { seen.push(by); return { ok: true } },
      later: async () => ({ ok: true }),
    }
    await handleRpcRequest(
      { id: 'a', type: 'call', action: 'answer', call_id: 'c1' },
      { deviceId: 'd', workbench, call: port, kind: 'handset', identity: 'wb-phone-pi-1' },
    )
    // 没有 wb_kind 的老手机:种类缺省当手机。
    await handleRpcRequest(
      { id: 'b', type: 'call', action: 'answer', call_id: 'c1' },
      { deviceId: 'd', workbench, call: port, identity: 'wb-phone-a1' },
    )
    expect(seen).toEqual([
      { identity: 'wb-phone-pi-1', kind: 'handset' },
      { identity: 'wb-phone-a1', kind: 'phone' },
    ])
  })

  /**
   * 2026-09-22(待拍板 E1):挂机那一条**手机和话筒发的是同一条**
   * (交接-0921-树莓派话筒进房 第三节:提机/挂机不另起名字)。谁发的由凭证里签的
   * `wb_kind` 分辨 —— 不让设备在消息里自称,房里的自称一个字都不能信。
   */
  it('挂断把「发这条的是什么设备」带给 port;缺省当手机(老手机的凭证里没有 wb_kind)', async () => {
    const seen: string[] = []
    const port: RpcCallPort = {
      greet: async () => ({ ok: true }),
      answer: async () => ({ ok: true }),
      later: async () => ({ ok: true }),
      hangup: async (by) => { seen.push(by); return { ok: true } },
    }
    await handleRpcRequest({ id: 'a', type: 'call', action: 'hangup' }, { deviceId: 'd', workbench, call: port, kind: 'handset' })
    await handleRpcRequest({ id: 'b', type: 'call', action: 'hangup' }, { deviceId: 'd', workbench, call: port, kind: 'phone' })
    await handleRpcRequest({ id: 'c', type: 'call', action: 'hangup' }, { deviceId: 'd', workbench, call: port })
    expect(seen).toEqual(['handset', 'phone', 'phone'])
  })
})

/**
 * ——— 房间白名单(2026-09-22,待拍板 E2) ———
 *
 * 座机页上那颗「批准」打的是 `POST /task/move`。出了局域网它只能走房间代理,
 * 而这条以前不在白名单里 —— 按下去什么都没发生。
 */
describe('「批准」那条路', () => {
  it('★`POST /task/move` 在房间白名单里', () => {
    expect(isAllowedRpcPath('POST', '/task/move')).toBe(true)
  })

  it('★「清空未接」`POST /call/missed/clear` 也在白名单里(出了局域网也得按得动)', () => {
    expect(isAllowedRpcPath('POST', '/call/missed/clear')).toBe(true)
    expect(isAllowedRpcPath('GET', '/call/missed/clear')).toBe(false)
  })

  it('★**只开这一条**:同一个处理分支下别的看板路由一条都没放进来', () => {
    for (const path of ['/task/create', '/task/update', '/task/delete', '/sprint/create', '/module/create', '/board/project']) {
      expect(isAllowedRpcPath('POST', path)).toBe(false)
    }
    // 方法也要对得上:GET /task/move 不是白名单里那一条。
    expect(isAllowedRpcPath('GET', '/task/move')).toBe(false)
  })
})

/**
 * ——— 打进打出同一张页(2026-09-23,Ben 12:45 真机 0.2.68) ———
 *
 * 他的原话:「我拿起话筒确实是打出去了,但是手机上没有变化,这不对,
 * 打过来和打过去都应该是显示同一个页面。」
 *
 * 来电那条路早就有信号(`ring` → `ring_end{answered,by}`),**拨出那条一个字都没广播** ——
 * 手机根本不知道房里正在通话。这一段钉的就是那条统一信号:`call_state`。
 */
describe('通话状态那条统一信号', () => {
  function board() {
    const sent: string[] = []
    let clock = 1_000
    const state = createCallState({ send: line => sent.push(line), now: () => clock })
    return {
      state,
      sent,
      tick: (ms: number) => { clock += ms },
      messages: () => sent.map(line => JSON.parse(line) as Record<string, unknown>),
    }
  }

  it('★ 话筒拨出接通 → 广播 in_call,带 by:handset 与起始时刻;**没有 call_id**(他自己拨的那通不为哪件事)', () => {
    const { state, messages } = board()
    expect(state.enter('handset')).toBe(true)
    expect(messages()).toHaveLength(1)
    expect(messages()[0]).toMatchObject({ type: 'call_state', state: 'in_call', by: 'handset', started_at: 1_000 })
    expect(messages()[0]).not.toHaveProperty('call_id')
  })

  it('★ 话筒接起来电 → 同一条 in_call,这一通带着 call_id', () => {
    const { state, messages } = board()
    state.enter('handset', 'call-1')
    expect(messages()[0]).toMatchObject({ type: 'call_state', state: 'in_call', by: 'handset', call_id: 'call-1' })
  })

  it('★ 挂断 → 广播 idle,带是谁挂的与这一通的起始时刻', () => {
    const { state, tick, messages } = board()
    state.enter('handset', 'call-1')
    tick(30_000)
    expect(state.leave('handset')).toBe(true)
    expect(messages().at(-1)).toMatchObject({
      type: 'call_state', state: 'idle', by: 'handset', call_id: 'call-1', started_at: 1_000,
    })
  })

  it('★ 幂等:同一通重复 enter 只广播一次', () => {
    const { state, messages } = board()
    state.enter('handset', 'call-1')
    expect(state.enter('handset', 'call-1')).toBe(false)
    expect(state.enter('handset')).toBe(false)
    expect(messages().filter(one => one.state === 'in_call')).toHaveLength(1)
  })

  it('★ 幂等:没有在通话里就不广播 idle —— 不能凭空宣布一通电话挂了', () => {
    const { state, messages } = board()
    expect(state.leave('handset')).toBe(false)
    expect(messages()).toEqual([])
    state.enter('handset')
    state.leave('handset')
    expect(state.leave('worker')).toBe(false)
    expect(messages().filter(one => one.state === 'idle')).toHaveLength(1)
  })

  it('超时 / 掉线那一刀(by:worker)同样广播 —— 一条如实的广播不该看有没有人听才发', () => {
    const { state, messages } = board()
    state.enter('handset')
    state.leave('worker')
    expect(messages().at(-1)).toMatchObject({ state: 'idle', by: 'worker' })
  })

  it('手机拨出的那一通也照发 —— 谁在通话由 `by` 说了算,手机自己那条路不认它', () => {
    const { state, messages } = board()
    state.enter('phone')
    expect(messages().at(-1)).toMatchObject({ state: 'in_call', by: 'phone' })
  })

  it('★ in_call 带通话那一台的 identity;不知道就缺席', () => {
    const { state, messages } = board()
    state.enter('phone', 'call-1', 'wb-phone-dev1')
    expect(messages().at(-1)).toMatchObject({ state: 'in_call', by: 'phone', by_identity: 'wb-phone-dev1' })
    state.leave('phone')
    expect(messages().at(-1)).not.toHaveProperty('by_identity')
    state.enter('handset')
    expect(messages().at(-1)).not.toHaveProperty('by_identity')
  })

  it('挂完再拨是新的一通:起始时刻跟着走', () => {
    const { state, tick, messages } = board()
    state.enter('handset')
    state.leave('handset')
    tick(5_000)
    expect(state.enter('handset')).toBe(true)
    expect(messages().at(-1)).toMatchObject({ state: 'in_call', started_at: 6_000 })
  })

  it('发不出去不许把工人带走(房间那条路随时可能抛)', () => {
    const sent: string[] = []
    const state = createCallState({
      send: () => { throw new Error('房间断了') },
      log: line => sent.push(line),
    })
    expect(() => state.enter('handset')).not.toThrow()
    // 抛了就当这一条没发出去:下一次还能再宣布一遍,而不是永远卡在「已经广播过了」。
    expect(sent).toHaveLength(1)
  })
})

describe('「等你回答」那一通(2026-09-25,卡 M:事务官在 DSH 会话里问他 / 要他批)', () => {
  it('8791 交下来的 ask 认得;来电页那一行叫「等你回答」', () => {
    expect(parseRingCall({ id: 'a', reason: 'ask', item_id: 't-1', title: '「修小头像」问你:派活前对一遍', at: 'x', silent: false })).toMatchObject({ reason: 'ask', item_id: 't-1' })
    expect(RING_REASON_TITLES.ask).toBe('等你回答')
  })

  it('★开场同一句就把这一问说清(2026-10-13;从前只说「有件事要问你一下」)', () => {
    const line = ringOpener(call({ reason: 'ask', title: '「修小头像」问你:派活前对一遍', note: '选项:都对,开工 / 都对,但你自己做' }), { address: '老板' })
    expect(line).toBe('老板,修小头像 派活前对一遍,你说一句。')
    // 格式字眼(「」与「问你:」)不念;选项照旧不进开场白
    expect(line).not.toContain('问你:')
    expect(line).not.toContain('「')
    expect(line).not.toMatch(/选项|开工/)
  })

  it('提示词让她把他的原话用 wb_answer_ask 交上去,不替他挑、不用 wb_decide_item', () => {
    const text = ringInstructions('人设', call({ reason: 'ask', title: '「修小头像」问你:派活前对一遍', note: '选项:都对,开工 / 都对,但你自己做' }))
    expect(text).toContain('wb_answer_ask')
    expect(text).toContain('原话')
    expect(text).not.toContain('wb_decide_item')
    expect(text).toContain('理由:等你回答')
  })

  it('「等你回答」那一通并进了后面几问(卡 M 追加):提示里说不止这一问,交完一问按回话里的下一问接着问', () => {
    const text = ringInstructions('人设', call({ reason: 'ask', title: '「修小头像」问你:派活前对一遍', merged: [{ item_id: 't-2', title: '「修小头像」要你批:要开一个看不见的浏览器' }] }))
    expect(text).toContain('这一通里不止这一问,后面还有:「修小头像」要你批:要开一个看不见的浏览器')
    expect(text).toContain('一问一问答下去')
    expect(text).not.toContain('也完成了')
  })
})

describe('「回话来了」那一通(2026-09-27,卡 CB:他让事务官捎的那句话,那边回了)', () => {
  /**
   * 维护者原话:「我在手机上问了事务官,理论上事务官去问了对应的 AI 之后,**事务官得回电话给我**。」
   *
   * 这一组钉的是**电话里那一半**:认得出这一类、开场只一句、接起来是**转述**(不是又要他决定一件事)。
   * 什么时候该有这一通在 8791(workbench-plugin 的 server/relayWatch.ts)。
   */
  const relay = () => call({
    reason: 'relay',
    item_id: 'relay:r-1a2b3c',
    title: 'Claude 「Desktop-workbench 统筹交接」',
    note: '你手机上让我捎的那句话,它回了。它的原话:正在写交接,大概还要十分钟',
  })

  it('8791 交下来的 relay 认得;来电页那一行叫「回话来了」', () => {
    expect(parseRingCall({ id: 'a', reason: 'relay', item_id: 'relay:r-1', title: 'Claude 「统筹交接」', at: 'x', silent: false }))
      .toMatchObject({ reason: 'relay', item_id: 'relay:r-1' })
    expect(RING_REASON_TITLES.relay).toBe('回话来了')
  })

  it('★开场说清是哪一条回的;回话正文仍留给下一句(2026-10-13)', () => {
    const line = ringOpener(relay(), { address: '老板' })
    expect(line).toContain('回话了')
    expect(line).not.toContain('十分钟')
    expect(line).not.toContain('我是')
  })

  it('★接起来是**转述**:说清哪条会话回的、照着工作台那一句念,长的先说要点', () => {
    const text = ringInstructions('人设', relay())
    expect(text).toContain('理由:回话来了')
    expect(text).toContain('Claude 「Desktop-workbench 统筹交接」')
    expect(text).toContain('长的先说要点')
    expect(text).toContain('工作台记的一句:你手机上让我捎的那句话,它回了。它的原话:正在写交接,大概还要十分钟')
  })

  it('★这一通不要他决定什么:不落状态、不问批不批,也不念那条 id', () => {
    const text = ringInstructions('人设', relay())
    expect(text).not.toContain('wb_decide_item')
    expect(text).not.toContain('wb_answer_ask')
    expect(text).not.toContain('decision=approve')
    expect(text).toContain('**不要**问他批不批')
    expect(text).not.toContain('relay:r-1a2b3c')
  })

  it('他让「再去问一句」:用捎话那件工具把他的原话捎回去,不自己组织语言', () => {
    const text = ringInstructions('人设', relay())
    expect(text).toContain('捎话那件工具')
    expect(text).toContain('原话')
  })

  it('还没回的那一通:照着工作台那一句如实说,不猜它在干嘛', () => {
    const text = ringInstructions('人设', call({
      reason: 'relay',
      item_id: 'relay:r-1a2b3c',
      title: 'Claude 「Desktop-workbench 统筹交接」',
      note: '你手机上让我捎的那句话,捎进去 21 分钟了,它还没回。',
    }))
    expect(text).toContain('捎进去 21 分钟了,它还没回。')
    expect(text).toContain('如实说还没回')
  })
})

describe('wb_answer_ask 那一下(POST /asks/voice)', () => {
  function client(reply: { status: number, body: unknown }) {
    const calls: { url: string, body: unknown }[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify(reply.body), { status: reply.status })
    }) as typeof fetch
    return { calls, workbench: createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl }) }
  }

  it('原话交过去;选中了哪个选项就照实说', async () => {
    const { calls, workbench } = client({ status: 200, body: { ok: true, kind: 'question', picked: '都对,但你自己做' } })
    const result = await workbench.answerAsk('t-1', '你自己做吧')
    expect(calls).toEqual([{ url: 'http://127.0.0.1:8791/asks/voice', body: { item_id: 't-1', said: '你自己做吧' } }])
    expect(result).toEqual({ ok: true, text: '交上去了:他选的是「都对,但你自己做」,它接着办。一句话跟他确认就行。' })
  })

  it('还有下一问(卡 M 追加:接连几问只响一次):回话里带上下一问与它的 item_id,她接着问;他说先这样就停', async () => {
    const { workbench } = client({ status: 200, body: { ok: true, kind: 'approval', allow: true, next: { item_id: 't-2', title: '「修小头像」要你批:要开一个看不见的浏览器', note: '为什么:要写临时目录' } } })
    const result = await workbench.answerAsk('t-1', '行')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('批了,它接着办。')
    expect(result.text).toContain('还有下一问:「修小头像」要你批:要开一个看不见的浏览器')
    expect(result.text).toContain('item_id 用 t-2')
    expect(result.text).toContain('先这样')
  })

  /**
   * ★ **他说的那一句不在那几项里**(2026-09-28,卡 AT):工作台把他那句**原话**写进了那家提问面板里的
   * 自由作答框、按了面板自己那颗发送键(回包带 `custom`)。核实过才说答上了 —— 与替他点那一项同一条规矩。
   */
  it('★他说了一句不在选项里的:替他写进那个框、发出去了,核实过就照实说', async () => {
    const { workbench } = client({ status: 200, body: { ok: true, kind: 'session', custom: '换成江浙菜,清淡一点', confirmed: true } })
    const result = await workbench.answerAsk('session:d777', '换成江浙菜,清淡一点')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('把他那句「换成江浙菜,清淡一点」写进那个框、发出去了')
    expect(result.text).toContain('那一问已经收了')
  })

  it('★写进去了、没看到它收下:照工作台那句话如实说,绝不说成答上了', async () => {
    const { workbench } = client({ status: 200, body: { ok: true, kind: 'session', custom: '换成江浙菜', confirmed: false, note: '把「换成江浙菜」写进去按了发送,但没看到它收下 —— 去电脑上的 Codex 看一眼' } })
    const result = await workbench.answerAsk('session:d777', '换成江浙菜')
    expect(result.text).toContain('没看到它收下')
    expect(result.text).toContain('别说成答上了')
  })

  it('说中了某一项:照旧「替他点了…」那一句(卡 WQ 一个字没改)', async () => {
    const { workbench } = client({ status: 200, body: { ok: true, kind: 'session', picked: '川菜', confirmed: true } })
    const result = await workbench.answerAsk('session:d777', '就川菜吧')
    expect(result.text).toContain('替他点了「川菜」')
  })

  /** ★ 权限弹窗(2026-10-01,卡 AP):他说「批准 / 拒绝」,工作台替他按了弹窗上那颗键 —— 照「批准 / 拒绝」说,不念英文键名当选项。 */
  it('★权限弹窗:替他批准了 / 拒绝了,核实过就照实说;没按上如实说', async () => {
    const ok = await client({ status: 200, body: { ok: true, kind: 'session', picked: 'Allow once', approved: 'once', confirmed: true } }).workbench.answerAsk('session:h1', '批准')
    expect(ok.text).toContain('替他批准了这一次')
    expect(ok.text).toContain('Allow once')
    const no = await client({ status: 200, body: { ok: true, kind: 'session', picked: 'Deny', approved: 'deny', confirmed: true } }).workbench.answerAsk('session:h1', '拒绝')
    expect(no.text).toContain('替他拒绝了')
    const stuck = await client({ status: 200, body: { ok: true, kind: 'session', picked: 'Allow once', approved: 'once', confirmed: false, note: '按了「Allow once」,可那个弹窗还在 —— 没按上,去电脑上的 Claude 看一眼' } }).workbench.answerAsk('session:h1', '批准')
    expect(stuck.text).toContain('没按上')
    expect(stuck.text).toContain('别说成答上了')
  })

  it('没听出批不批(400):那句人话原样带回,告诉他手机上也能答', async () => {
    const { workbench } = client({ status: 400, body: { error: '没听出是批还是不批' } })
    const result = await workbench.answerAsk('t-1', '嗯')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('没听出是批还是不批')
    expect(result.text).toContain('等你确认')
  })
})

describe('座机只为「他不点头就卡住」的事响(2026-09-27,卡 WY)', () => {
  const call = (reason: RingCall['reason'], title: string): Pick<RingCall, 'reason' | 'title'> => ({ reason, title })

  it('事务官自己的提议交下来也不响(老 8791 兜底):派单提议、进度要你说一句、要加上吗', () => {
    expect(shouldRing(call('ask', '「参赛视频」问你:进度要你说一句'))).toBe(false)
    expect(shouldRing(call('ask', '「打磨自媒体布局」要你批:这张派给 Claude 开工?'))).toBe(false)
    expect(shouldRing(call('confirm', '要加上吗:真实界面素材'))).toBe(false)
  })

  it('真卡住的照旧响:别家在问他、要他批、办完了等他验收;汇报那一类不归这道门管', () => {
    expect(shouldRing(call('ask', '「导出 PDF」问你:用方案 A 还是 B'))).toBe(true)
    expect(shouldRing(call('ask', '「导出 PDF」要你批:要在这个仓库里跑一条命令'))).toBe(true)
    expect(shouldRing(call('confirm', '黄历接上了'))).toBe(true)
    expect(shouldRing(call('failed', '下班例程'))).toBe(true)
    expect(shouldRing(call('done', '下班例程'))).toBe(true)
  })
})
