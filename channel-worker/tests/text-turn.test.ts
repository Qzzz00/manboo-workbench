/**
 * 「把文字当成他说的话」测试口(2026-09-27,卡 TT)。
 *
 * 钉三件事:
 *   ① 送进去的**就是真回合那条路**(替身模型 / 替身回合函数验调用顺序与参数);
 *   ② 三道门:关着 404、非本机 403、口令不对 401;
 *   ③ 一回合什么时候算收尾(状态口径与 filler / latency 一致),回给统筹的是哪几样。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  deliverTextTurn,
  handleTextTurnRequest,
  isLoopbackAddress,
  startTextTurnServer,
  TEXT_TURN_DEFAULT_PORT,
  TEXT_TURN_TOKEN_HEADER,
  TextTurnCollector,
  textTurnSettingsOf,
  type TextTurnPort,
} from '../src/textTurn.ts'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('开关', () => {
  it('默认关着', () => {
    const settings = textTurnSettingsOf({})
    expect(settings.on).toBe(false)
    expect(settings.note).toContain('关着')
  })

  it('WORKBENCH_CHANNEL_TEXT_TURN=1 才开;端口与口令文件可改', () => {
    expect(textTurnSettingsOf({ WORKBENCH_CHANNEL_TEXT_TURN: '1' }).on).toBe(true)
    expect(textTurnSettingsOf({ WORKBENCH_CHANNEL_TEXT_TURN: 'on' }).on).toBe(true)
    expect(textTurnSettingsOf({ WORKBENCH_CHANNEL_TEXT_TURN: 'off' }).on).toBe(false)
    expect(textTurnSettingsOf({}).port).toBe(TEXT_TURN_DEFAULT_PORT)
    const custom = textTurnSettingsOf({
      WORKBENCH_CHANNEL_TEXT_TURN: '1',
      WORKBENCH_CHANNEL_TEXT_TURN_PORT: '8999',
      WORKBENCH_CHANNEL_TEXT_TURN_TOKEN_FILE: '/tmp/x.token',
    })
    expect(custom.port).toBe(8999)
    expect(custom.tokenFile).toBe('/tmp/x.token')
  })

  it('那句人话里不会有口令(它这会儿还没生成)', () => {
    expect(textTurnSettingsOf({ WORKBENCH_CHANNEL_TEXT_TURN: '1' }).note).toContain('口令在')
  })
})

describe('送进去的是真回合那条路', () => {
  it('字幕 → 真回合函数 → 回合提交,三步同序同参', () => {
    const order: string[] = []
    const caption = vi.fn((role: 'me' | 'butler', text: string, final: boolean) => {
      order.push(`caption:${role}:${text}:${final}`)
    })
    const hear = vi.fn((text: string) => { order.push(`hear:${text}`) })
    // 替身模型:只记下框架公开的那个回合提交口被怎么调的。
    const session = { generateReply: vi.fn((options: { userInput: string }) => { order.push(`reply:${options.userInput}`) }) }

    const got = deliverTextTurn({ text: '  给 minus 发个信息问国庆放几天  ', caption, hear, session })

    expect(got.ok).toBe(true)
    expect(order).toEqual([
      'caption:me:给 minus 发个信息问国庆放几天:true',
      'hear:给 minus 发个信息问国庆放几天',
      'reply:给 minus 发个信息问国庆放几天',
    ])
    // 送进去的是**定稿**:final 一定是 true,原文两头的空白去掉,中间一个字不改。
    expect(session.generateReply).toHaveBeenCalledWith({ userInput: '给 minus 发个信息问国庆放几天' })
  })

  it('空话不送;没有嘴时如实说一句,不假装送进去了', () => {
    const caption = vi.fn()
    const hear = vi.fn()
    const session = { generateReply: vi.fn() }
    expect(deliverTextTurn({ text: '   ', caption, hear, session })).toEqual({ ok: false, error: '这句话是空的' })
    expect(deliverTextTurn({ text: '在吗', caption, hear, session: undefined }).ok).toBe(false)
    expect(caption).not.toHaveBeenCalled()
    expect(hear).not.toHaveBeenCalled()
    expect(session.generateReply).not.toHaveBeenCalled()
  })

  it('回合提交抛了就把原因带回去(字幕已经推了,这是实话)', () => {
    const got = deliverTextTurn({
      text: '在吗',
      caption: vi.fn(),
      hear: vi.fn(),
      session: { generateReply: () => { throw new Error('会话已经关了') } },
    })
    expect(got).toEqual({ ok: false, error: '会话已经关了' })
  })
})

describe('一回合什么时候算收尾', () => {
  it('thinking↔speaking 来回不算完,回到 listening 才收;她说的逐段、工具、计时都回', async () => {
    const collector = new TextTurnCollector({ graceMs: 1, timeoutMs: 5000 })
    collector.agentState('thinking')
    collector.butler('好,我记一下')
    collector.agentState('speaking')
    collector.agentState('thinking')
    collector.tool({ name: 'wb_relay_to_session', result: '{"ok":true}' })
    collector.agentState('speaking')
    collector.butler('发过去了')
    collector.agentState('listening')
    const got = await collector.done()
    expect(got.ok).toBe(true)
    expect(got.said).toEqual(['好,我记一下', '发过去了'])
    expect(got.tools).toEqual([{ name: 'wb_relay_to_session', result: '{"ok":true}' }])
    expect(got.timedOut).toBeUndefined()
  })

  it('还没开始想就先来一条 listening 不算收尾', async () => {
    const collector = new TextTurnCollector({ graceMs: 1, timeoutMs: 60 })
    collector.agentState('listening')
    const got = await collector.done()
    // 一直没进 thinking:等到超时,如实标出来,不假装跑完了。
    expect(got.timedOut).toBe(true)
    expect(got.said).toEqual([])
  })
})

describe('三道门', () => {
  const port = (): TextTurnPort => ({
    say: async () => ({ ok: true, said: ['好'], tools: [], ms: 1 }),
    hangup: async () => ({ ok: true }),
  })

  it('关着的时候连这个口都不承认:404', async () => {
    const got = await handleTextTurnRequest(
      { method: 'POST', url: '/say', remoteAddress: '127.0.0.1', token: 'right', body: '{"text":"在吗"}' },
      { enabled: false, token: 'right', port },
    )
    expect(got.status).toBe(404)
  })

  it('不是本机:403(口令对也不行)', async () => {
    const got = await handleTextTurnRequest(
      { method: 'POST', url: '/say', remoteAddress: '192.168.1.9', token: 'right', body: '{"text":"在吗"}' },
      { enabled: true, token: 'right', port },
    )
    expect(got.status).toBe(403)
  })

  it('口令不对 / 没带:401', async () => {
    for (const token of ['wrong', undefined]) {
      const got = await handleTextTurnRequest(
        { method: 'POST', url: '/say', remoteAddress: '::1', token, body: '{"text":"在吗"}' },
        { enabled: true, token: 'right', port },
      )
      expect(got.status).toBe(401)
    }
  })

  it('回环的三种写法都算本机,别的都不算', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('10.0.0.2')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('过了三道门:/say 交给真口子,/hangup 也是;工人还没进房回 503', async () => {
    const said: string[] = []
    const live: TextTurnPort = {
      say: async (text) => { said.push(text); return { ok: true, said: ['好,我去安排'], tools: [{ name: 'wb_new_item' }], ms: 12 } },
      hangup: async () => ({ ok: true }),
    }
    const ok = await handleTextTurnRequest(
      { method: 'POST', url: '/say', remoteAddress: '127.0.0.1', token: 'right', body: '{"text":"加个导出 PDF"}' },
      { enabled: true, token: 'right', port: () => live },
    )
    expect(ok.status).toBe(200)
    expect(said).toEqual(['加个导出 PDF'])
    expect(ok.body).toMatchObject({ ok: true, said: ['好,我去安排'], heard: '加个导出 PDF' })

    const bye = await handleTextTurnRequest(
      { method: 'POST', url: '/hangup', remoteAddress: '127.0.0.1', token: 'right', body: '' },
      { enabled: true, token: 'right', port: () => live },
    )
    expect(bye.status).toBe(200)

    const notYet = await handleTextTurnRequest(
      { method: 'POST', url: '/say', remoteAddress: '127.0.0.1', token: 'right', body: '{"text":"在吗"}' },
      { enabled: true, token: 'right', port: () => undefined },
    )
    expect(notYet.status).toBe(503)
  })

  it('没有 text / 读不懂的 JSON / 别的路径都不往回合里送', async () => {
    const ctx = { enabled: true, token: 'right', port }
    expect((await handleTextTurnRequest({ method: 'POST', url: '/say', remoteAddress: '127.0.0.1', token: 'right', body: '{}' }, ctx)).status).toBe(400)
    expect((await handleTextTurnRequest({ method: 'POST', url: '/say', remoteAddress: '127.0.0.1', token: 'right', body: '{oops' }, ctx)).status).toBe(400)
    expect((await handleTextTurnRequest({ method: 'POST', url: '/whatever', remoteAddress: '127.0.0.1', token: 'right', body: '' }, ctx)).status).toBe(404)
    expect((await handleTextTurnRequest({ method: 'GET', url: '/say', remoteAddress: '127.0.0.1', token: 'right', body: '' }, ctx)).status).toBe(404)
  })
})

describe('真起一个壳(只绑回环、口令文件 600)', () => {
  it('口令文件是 600(别人读不到它)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'text-turn-'))
    const tokenFile = join(dir, 'token')
    const server = await startTextTurnServer({
      settings: { on: true, port: 8893, tokenFile, note: '' },
      port: () => undefined,
      log: () => { /* 用例里不打日志 */ },
      token: 'testtoken',
    })
    try {
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
      expect(server.tokenFile).toBe(tokenFile)
    }
    finally {
      await server.close()
    }
  })

  it('壳子端到端:带口令的 /say 真的走到口子上', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'text-turn-'))
    const tokenFile = join(dir, 'token')
    const heard: string[] = []
    // 端口挑一个不常用的,免得撞上跑着的工人。
    const settings = { on: true, port: 8894, tokenFile, note: '' }
    const server = await startTextTurnServer({
      settings,
      port: () => ({
        say: async (text) => { heard.push(text); return { ok: true, said: ['好,我挑几个给你听'], tools: [], ms: 3 } },
        hangup: async () => ({ ok: true }),
      }),
      log: () => { /* 安静 */ },
      token: 'testtoken',
    })
    try {
      const res = await fetch(`http://127.0.0.1:${settings.port}/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TEXT_TURN_TOKEN_HEADER]: 'testtoken' },
        body: JSON.stringify({ text: '我想换个音色' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, said: ['好,我挑几个给你听'] })
      expect(heard).toEqual(['我想换个音色'])

      const bad = await fetch(`http://127.0.0.1:${settings.port}/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TEXT_TURN_TOKEN_HEADER]: 'nope' },
        body: JSON.stringify({ text: '我想换个音色' }),
      })
      expect(bad.status).toBe(401)
    }
    finally {
      await server.close()
    }
  })
})
