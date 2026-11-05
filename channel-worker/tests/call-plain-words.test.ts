/**
 * **通话里那几句话说人话**(2026-09-28,卡 CF;维护者第二通电话)。
 *
 * 他的原话:「太啰嗦了,我只是提交了一个简单的事情,确认一次……念了一遍经书,又来一个什么插一句」。
 * 真机上那一句是:
 *
 * > 插一句:「让豆包工作帮我查一下国庆节放几天假;① 归豆包工作办 ② 只问清楚放假天数 ③ …」没成:
 * > 派给 豆包办公 没派出去:窗口:这台电脑上还没接上 doub
 *
 * 一句话里有:整条标题(连三条确认点都念进去了)、内部前缀「窗口:」、被截断的包标识。
 * 这一份钉住:**失败播报只有一句人话**,不念整条标题、不念内部字段。
 */
import { describe, expect, it } from 'vitest'
import { inCallAnnounceText, type RingCall } from '../src/callOut.ts'
import { spokenSafe } from '../src/spokenSafe.ts'

function call(patch: Partial<RingCall> = {}): RingCall {
  return {
    id: 'call-1',
    reason: 'failed',
    item_id: 'task-1',
    title: '让豆包工作帮我查一下国庆节放几天假;① 归豆包工作办 ② 只问清楚放假天数 ③ 它回了天数就算完事',
    at: '2026-09-28T08:00:00.000Z',
    silent: false,
    ...patch,
  }
}

describe('派活失败:一句人话', () => {
  it('有原因就只念原因,不念整条标题', () => {
    const said = inCallAnnounceText(call({ note: '派给 豆包办公 没派出去:这台电脑上还没接上 豆包办公;现在能派的是 Codex' }))
    expect(said).toContain('没派出去')
    expect(said).not.toContain('①')
    expect(said).not.toContain('让豆包工作帮我查一下国庆节放几天假')
  })

  it('内部前缀与包标识不念给他听', () => {
    const said = inCallAnnounceText(call({ note: '派给 豆包办公 没派出去:窗口:com.work.pc.doubao 的输入框没找到;接口:服务器没配 豆包(火山方舟)(缺 RELAY_DOUBAO_KEY)' }))
    expect(said).not.toContain('窗口:')
    expect(said).not.toContain('com.work.pc.doubao')
    expect(said).not.toContain('RELAY_DOUBAO_KEY')
    expect(said).not.toContain('接口:')
  })

  it('一句原因都没有时才退回标题(短短一句,不是三条确认点)', () => {
    const said = inCallAnnounceText(call({ title: '把首页文案改一版' }))
    expect(said).toContain('把首页文案改一版')
  })

  it('这一句本来就短:不超过 60 字', () => {
    const said = inCallAnnounceText(call({ note: '派给 豆包办公 没派出去:这台电脑上还没接上 豆包办公;现在能派的是 Codex、Claude、Kimi、Muse、Manus 一大串' }))
    expect([...said].length).toBeLessThanOrEqual(60)
  })
})

describe('她嘴里不许有的那几个词(卡 CF 第 7 条)', () => {
  it('骂人的话当场拦下来', () => {
    // 真机那一句:「……缺一把豆包火山的钥匙。狗东西接不」——模型自己生的,不是称呼表里的。
    expect(spokenSafe('事就卡在这一步:缺一把钥匙。狗东西接不上')).toBe('事就卡在这一步:缺一把钥匙。接不上')
    expect(spokenSafe('他妈的没派出去')).toBe('没派出去')
  })

  it('好好的一句话一个字不动', () => {
    expect(spokenSafe('派出去了,结果回来我告诉你。')).toBe('派出去了,结果回来我告诉你。')
  })
})
