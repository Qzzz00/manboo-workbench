/**
 * 「电话里派活犯傻」那一卡(2026-09-27,卡 MS)。三件:
 *
 * 1. **「给 X 发个信息」= 捎话**,名字听错了也认得出(21:17:「给 minus 发个信息问他国庆…」);
 * 2. **通话里出了结果当场说**,绝不广播一条铃把正在进行的这通电话收场
 *    (21:23:`座机响了:运行失败…(只发通知)` → `这一通收场:notified` → 手机挂断);
 * 3. 那一句当场说的话由代码从事实拼,不编。
 */
import { describe, expect, it } from 'vitest'
import { classifyCallTurn, looksLikeLookupOnly, looksLikeRelay } from '../src/butlerRoute.ts'
import { canonicalWho, matchSpokenFamily } from '../src/agentName.ts'
import { createRingMachine, inCallAnnounceText, type RingCall } from '../src/callOut.ts'

function call(patch: Partial<RingCall> = {}): RingCall {
  return {
    id: 'call-1',
    reason: 'failed',
    item_id: 't-8faa199e',
    title: '找豆包总结这几天聊的内容',
    at: '2026-09-27T13:23:00.000Z',
    silent: true,
    ...patch,
  }
}

describe('「给 X 发个信息 / 问问 X」走捎话', () => {
  it('★现场那一句:名字被 ASR 听成 minus,照样认出是捎话', () => {
    const said = '给 minus 发个信息问他国庆节中国法定节日是放几天'
    expect(looksLikeRelay(said)).toBe(true)
    expect(classifyCallTurn(said)).toBe('relay')
  })

  it('「问问豆包…」也是捎话', () => {
    expect(classifyCallTurn('问问豆包这几天我跟他聊了什么')).toBe('relay')
  })

  it('点着对象的老写法一条都没退步', () => {
    expect(classifyCallTurn('给那个 Claude、正在做统筹交接的那个会话窗口发个信息问一下进度')).toBe('relay')
  })

  it('没点着哪一家的不算捎话(不然一句闲聊会被往别人窗口里打)', () => {
    expect(looksLikeRelay('问一下现在几点')).toBe(false)
    expect(looksLikeRelay('告诉他我下午到')).toBe(false)
    // 问事项不再由词表分流(A2):不是捎话就交给模型。
    expect(classifyCallTurn('现在在办什么')).toBe('chat')
  })
})

describe('通话里出了结果:当场说,不响铃、不收场', () => {
  it('★正在通话里来的那一通:一个字都不往房里广播,按「只发了通知」收场', () => {
    const sent: string[] = []
    const settled: { outcome: string, text?: string }[] = []
    const announced: RingCall[] = []
    const ring = createRingMachine({
      send: line => sent.push(line),
      onAnswered: () => {},
      onSettled: (_one, outcome, text) => settled.push({ outcome, ...(text === undefined ? {} : { text }) }),
      inCall: () => true,
      onAnnounce: (one) => { announced.push(one); return true },
    })
    ring.ring(call())
    // 那条 `ring` 正是把手机那一面掀翻、把这通电话收场的那只手 —— 一条都不许发。
    expect(sent).toEqual([])
    expect(announced).toHaveLength(1)
    expect(settled).toEqual([{ outcome: 'notified', text: '通话里当场说了,没有另外响铃' }])
    expect(ring.current()).toBeUndefined()
  })

  it('说不出去(还没接上话)就排着,等这通挂了再响 —— 不丢掉这一条', () => {
    const sent: string[] = []
    let inCall = true
    const ring = createRingMachine({
      send: line => sent.push(line),
      onAnswered: () => {},
      onSettled: () => {},
      inCall: () => inCall,
      onAnnounce: () => false,
    })
    ring.ring(call({ silent: false }))
    expect(sent).toEqual([])
    inCall = false
    ring.hangup()
    expect(sent.map(line => (JSON.parse(line) as { type: string }).type)).toContain('ring')
  })

  it('没在通话里照旧响(这一条没改)', () => {
    const sent: string[] = []
    const ring = createRingMachine({ send: line => sent.push(line), onAnswered: () => {}, onSettled: () => {} })
    ring.ring(call({ silent: false }))
    expect(sent.map(line => (JSON.parse(line) as { type: string }).type)).toEqual(['ring'])
  })
})

describe('当场说的那一句(代码拼的,不编)', () => {
  /*
   * ★ 2026-09-28(卡 CF 第 6 条)**改了口径**:失败那一句**不再念整条标题**。
   * 维护者那一通听到的是「插一句:『让豆包工作帮我查一下国庆节放几天假;① 归豆包工作办 ② …』没成:
   * 派给 豆包办公 没派出去:窗口:这台电脑上还没接上 doub」——「太啰嗦了……念了一遍经书」。
   * 现在有原因就只说那一句人话;一句原因都拿不到时才退回标题(下面那一条)。
   */
  /*
   * ★ 2026-10-13 下午(卡 A 第 3 条)**又改了一次口径**:字面「插一句:」去掉了。
   * 维护者两次点名(09-29「又来一个什么插一句」、10-13「总是说插一句」)—— 真人插话不会先报一声。
   */
  it('★失败那一种说清卡在哪,并把下一步交回给他(不念整条标题、不说「插一句」)', () => {
    const text = inCallAnnounceText(call({ note: '豆包的输入框里有你没发出去的字' }))
    expect(text).toBe('豆包的输入框里有你没发出去的字。你说下一步怎么办。')
    // 不许出现甩锅那一类话
    expect(text).not.toContain('我可不管')
    expect(text).not.toContain('插一句')
  })

  it('一句原因都没有时才退回标题(标题掐到这一句不超上限)', () => {
    expect(inCallAnnounceText(call())).toBe('「找豆包总结这几天聊的内容」没成。你说下一步怎么办。')
  })

  it('捎话回来了那一种是转述,不要他批(09-28 起:超时的跟踪也念这一句,不说「它回了」)', () => {
    expect(inCallAnnounceText(call({ reason: 'relay', title: 'Manus 那条', note: '放 8 天' })))
      .toBe('对了,Manus 那条 的跟踪结果:放 8 天。')
    expect(inCallAnnounceText(call({ reason: 'relay', title: 'Manus 那条' })))
      .toBe('对了,Manus 那条 的跟踪结果:暂时没有可读结果。')
  })

  /*
   * ★ 2026-10-13 下午:「等你一句话」那一种也不再把 `note` 原样接上 ——
   * 那一格是 8791 写给界面的(「到上限了,先停下来了:花了约 0.51 元 · 跑了 6 分钟 · 走了 51 步」)。
   */
  it('工作台没给那句原话就不编一句', () => {
    expect(inCallAnnounceText(call({ reason: 'ask' }))).toBe('「找豆包总结这几天聊的内容」等你一句话。')
  })
})

/**
 * 卡 MS 与卡 LK 合流(2026-09-27 合 main):**只读那道门优先,认名字两条路共用**。
 *
 * 两卡各自都对:LK 要的是「他说别发就一个字都不许发」,MS 要的是「名字听错了也认得出这是在点某一家」。
 * 叠在一起时顺序不能反 —— 认出是哪一家**不该**让一句「不要给他发信息」变成一次真发出去的话。
 */
describe('只读门优先于捎话判定', () => {
  it('★他明说别发,哪怕名字认得出来也不是捎话', () => {
    const said = '不要给他发信息,就看一眼 minus 在干什么'
    expect(looksLikeLookupOnly(said)).toBe(true)
    expect(looksLikeRelay(said)).toBe(false)
  })

  it('★整句只是问状态(一个送话动词都没有)也不是捎话 —— 名字听错了照样认得出是哪一家', () => {
    const said = 'minus 现在什么状态'
    expect(looksLikeRelay(said)).toBe(false)
    expect(looksLikeLookupOnly(said)).toBe(true)
    // 两条路认人用的是同一个函数,所以这一句里那一家也认得出来。
    expect(matchSpokenFamily(said)).toMatchObject({ kind: 'one', id: 'manus' })
  })

  it('★他真让发的那一句照旧是捎话(这道门没拦掉该捎的那一次)', () => {
    const said = '给 minus 发个信息问他国庆节中国法定节日是放几天'
    expect(looksLikeLookupOnly(said)).toBe(false)
    expect(looksLikeRelay(said)).toBe(true)
  })

  it('★看一眼与捎话认出来的是同一家(canonicalWho 两条路共用)', () => {
    expect(canonicalWho('看一眼 minus 在干什么')).toBe('看一眼 Manus 在干什么')
    expect(canonicalWho('给 minus 发个信息')).toBe('给 Manus 发个信息')
  })
})
