import { describe, expect, it } from 'vitest'
import { createSayDecisionPublisher, roomReplayEnabled } from '../src/roomDecisionReplay.ts'
import { handleTextTurnRequest } from '../src/textTurn.ts'
import { isAllowedRpcPath } from '../src/rpc.ts'
import type { SayReply } from '../src/sayTurn.ts'
const reply = (id = 'say-a'): SayReply => ({ say_id: id, items: [], say: { screen: '受控真实计划结果', spoken: '记下了。' }, ask: { ask_id: 'ask-a', question: '确认吗？' } })
const env = { WORKBENCH_CHANNEL_TEXT_TURN: '1', WORKBENCH_CHANNEL_ROOM_REPLAY_QA: '1', WB_FIXTURE_CAPTURE_ROOT: '/tmp/qa-replay', HOME: '/tmp/qa-replay/iso/home' }
describe('默认关闭的生产决定卡QA原包重送', () => {
  it('同时要求文字口、显式QA开关及隔离HOME；根目录不能放宽到/', () => {
    expect(roomReplayEnabled({})).toBe(false)
    expect(roomReplayEnabled(env)).toBe(true)
    expect(roomReplayEnabled({ ...env, HOME: '/Users/personal' })).toBe(false)
    expect(roomReplayEnabled({ ...env, HOME: '/tmp/qa-replay-other/home' })).toBe(false)
    expect(roomReplayEnabled({ ...env, WB_FIXTURE_CAPTURE_ROOT: '/' })).toBe(false)
    expect(roomReplayEnabled({ ...env, WB_FIXTURE_CAPTURE_ROOT: '/tmp/..', HOME: '/Users/personal' })).toBe(false)
    expect(roomReplayEnabled({ ...env, WORKBENCH_CHANNEL_TEXT_TURN: '0' })).toBe(false)
    expect(roomReplayEnabled({ ...env, WORKBENCH_CHANNEL_ROOM_REPLAY_QA: '0' })).toBe(false)
  })
  it('正常路径仅发一次且不开QA时不保留事件', async () => {
    const sent: string[] = []
    const publisher = createSayDecisionPublisher({ publish: async packet => { sent.push(packet) } })
    await publisher.send(reply(), 'call-qa')
    expect(sent).toHaveLength(1)
    expect(publisher.qa).toBeUndefined()
  })
  it('只捕获实际成功发送的不可变原包，经同一publisher逐字重送', async () => {
    const sent: string[] = []
    const publisher = createSayDecisionPublisher({ qa: true, publish: async packet => { sent.push(packet) } })
    const r = reply(); await publisher.send(r, 'call-qa'); r.say.screen = '调用者改动'
    const saved = publisher.qa!.list()[0]!
    expect(saved.packet).toBe(sent[0]); expect(JSON.parse(saved.packet)).toMatchObject({ event_id: saved.event_id, call_id: 'call-qa', say: { screen: '受控真实计划结果' } })
    saved.packet = '外部篡改'; await publisher.qa!.replay(saved.event_id)
    expect(sent).toEqual([sent[0], sent[0]])
    expect(await publisher.qa!.replay('unknown')).toBe(false); expect(sent).toHaveLength(2)
    await publisher.send(reply('say-b'), 'call-qa')
    expect(JSON.parse(sent[2]!).event_id).not.toBe(JSON.parse(sent[0]!).event_id)
  })
  it('发送失败不冒实际已发；只在成功后可见', async () => {
    let finish!: () => void
    const p = createSayDecisionPublisher({ qa: true, publish: () => new Promise<void>(resolve => { finish = resolve }) })
    const pending = p.send(reply()); expect(p.qa!.list()).toEqual([]); finish(); await pending; expect(p.qa!.list()).toHaveLength(1)
    const failed = createSayDecisionPublisher({ qa: true, publish: async () => { throw new Error('offline') } })
    await expect(failed.send(reply())).rejects.toThrow('offline'); expect(failed.qa!.list()).toEqual([])
  })
  it('QA最多保留最近32个唯一原包，不造历史产品能力', async () => {
    const p = createSayDecisionPublisher({ qa: true, publish: async () => {} })
    for (let i = 0; i < 35; i++) await p.send(reply('say-' + i))
    expect(p.qa!.list()).toHaveLength(32); expect(p.qa!.list()[0]!.event_id).toContain('say-3:')
  })
})
describe('复用现有文字口的本地鉴权与精确ID入口', () => {
  it('不向普通手机房间RPC开放QA路径', () => {
    expect(isAllowedRpcPath('GET', '/qa/room-decisions')).toBe(false)
    expect(isAllowedRpcPath('POST', '/qa/room-decisions/replay')).toBe(false)
  })
  const request = { method: 'POST', url: '/qa/room-decisions/replay', remoteAddress: '127.0.0.1', token: 'controlled', body: '{"event_id":"say-a:ask:ask-a"}' }
  it('默认404、非回环403、错令牌401、未知ID404、任意payload400', async () => {
    const p = createSayDecisionPublisher({ qa: true, publish: async () => {} }); await p.send(reply())
    const ctx = { enabled: true, token: 'controlled', port: () => undefined, roomReplay: () => p.qa }
    expect((await handleTextTurnRequest(request, { ...ctx, roomReplay: () => undefined })).status).toBe(404)
    expect((await handleTextTurnRequest({ ...request, remoteAddress: '192.0.2.1' }, ctx)).status).toBe(403)
    expect((await handleTextTurnRequest({ ...request, token: 'wrong' }, ctx)).status).toBe(401)
    expect((await handleTextTurnRequest({ ...request, body: '{"event_id":"unknown"}' }, ctx)).status).toBe(404)
    expect((await handleTextTurnRequest({ ...request, body: '{"event_id":"x","payload":{}}' }, ctx)).status).toBe(400)
    expect((await handleTextTurnRequest(request, ctx)).status).toBe(200)
    const got = await handleTextTurnRequest({ ...request, method: 'GET', url: '/qa/room-decisions' }, ctx)
    expect(got.status).toBe(200); expect(got.body.events).toEqual(p.qa!.list())
  })
})
