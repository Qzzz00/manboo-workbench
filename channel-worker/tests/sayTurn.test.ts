import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { postSayTurn, SAY_OUTCOME_UNKNOWN_LINE, SAY_TIMEOUT_MS, uncertainSayReplyOf, type SayReply } from '../src/sayTurn.ts'

describe('telephone /butler/say consumer', () => {
  it('posts the final transcript with phone context and returns server spoken text', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ text: '周四把样片发给客户', entrance: 'call', ctx: { last_say_id: 's6' } })
      return new Response(JSON.stringify({ say_id: 's7', say: { screen: 'screen', spoken: '我先记下了。' }, items: [] }), { status: 200 })
    })
    const result = await postSayTurn({ baseUrl: 'http://127.0.0.1:8791', text: '周四把样片发给客户', ctx: { last_say_id: 's6' }, fetchImpl })
    expect(result.kind).toBe('reply')
    if (result.kind === 'reply') expect(result.reply.say.spoken).toBe('我先记下了。')
  })

  it('falls back on the configured timeout window', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const result = await postSayTurn({ baseUrl: 'http://127.0.0.1:8791', text: '你好', timeoutMs: 5, fetchImpl })
    expect(result).toMatchObject({ kind: 'fallback', timedOut: true })
    expect(SAY_TIMEOUT_MS).toBe(3000)
  })

  it('times out a real local HTTP request at the production three second limit', async () => {
    const server = createServer((_req, _res) => { /* Deliberately leave the local test request pending. */ })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('local HTTP server did not bind')
    const started = Date.now()
    try {
      const result = await postSayTurn({ baseUrl: `http://127.0.0.1:${address.port}`, text: '超时门' })
      expect(result).toMatchObject({ kind: 'fallback', timedOut: true })
      expect(Date.now() - started).toBeGreaterThanOrEqual(SAY_TIMEOUT_MS - 300)
      expect(Date.now() - started).toBeLessThan(SAY_TIMEOUT_MS + 1500)
    }
    finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }, 6000)

  it('maps HTTP 409 still_running to an uncertain result without retrying or changing the client key', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ text: '同一句', client_key: 'same-key' })
      return new Response(JSON.stringify({ error: '这句还在办,结果未知;请稍候重试或到看板上核对,不会重复执行。', code: 'still_running' }), { status: 409 })
    })
    const result = await postSayTurn({ baseUrl: 'http://127.0.0.1:8791', text: '同一句', clientKey: 'same-key', fetchImpl })
    expect(result).toMatchObject({ kind: 'fallback', reason: 'still_running', outcomeUncertain: true })
    expect(SAY_OUTCOME_UNKNOWN_LINE).toContain('结果还不确定')
    expect(SAY_OUTCOME_UNKNOWN_LINE).not.toContain('没有办理')
    expect(uncertainSayReplyOf(result)?.say).toEqual({ screen: SAY_OUTCOME_UNKNOWN_LINE, spoken: SAY_OUTCOME_UNKNOWN_LINE })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed replies so callers use the genuine fallback', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ say: { spoken: '' } }), { status: 200 }))
    expect((await postSayTurn({ baseUrl: 'http://127.0.0.1:8791', text: '嗯', fetchImpl })).kind).toBe('fallback')
  })
})

describe('phone say continuation context', () => {
  it('carries the last say id and exact yes/no confirmation id across turns', async () => {
    const { SayConversation } = await import('../src/sayTurn.ts')
    const conversation = new SayConversation()
    conversation.accept({ say_id: 's1', items: [], ask: { ask_id: 'ask-7', question: '要我派给 Claude 吗？' }, say: { screen: 'screen', spoken: '我建议派给 Claude。' } })
    expect(conversation.contextFor('yes')).toEqual({ last_say_id: 's1', confirmed: { ask_id: 'ask-7', choice: '是' }, in_call: true })
    expect(conversation.contextFor('no')).toEqual({ last_say_id: 's1', confirmed: { ask_id: 'ask-7', choice: '否' }, in_call: true })
    expect(conversation.contextFor(undefined)).toEqual({ last_say_id: 's1', in_call: true })
  })

  it('confirms the first outstanding asks[] entry and retains every unanswered question', async () => {
    const { SayConversation } = await import('../src/sayTurn.ts')
    const conversation = new SayConversation()
    conversation.accept({
      say_id: 's1', items: [],
      ask: { ask_id: 'ask-2', question: '继续创建吗？' },
      asks: [
        { ask_id: 'hold-1', question: '先确认对外动作？' },
        { ask_id: 'ask-2', question: '继续创建吗？' },
        { ask_id: 'ask-3', question: '需要通知团队吗？' },
      ],
      hold: { hold_id: 'hold-1', reason: 'external', question: '先确认对外动作？' },
      say: { screen: 'screen', spoken: '先确认第一项。' },
    })
    expect(conversation.contextFor('yes')).toEqual({ last_say_id: 's1', confirmed: { ask_id: 'hold-1', choice: '是' }, in_call: true })

    conversation.accept({
      say_id: 's1', items: [], ask: { ask_id: 'ask-2', question: '继续创建吗？' },
      asks: [
        { ask_id: 'ask-2', question: '继续创建吗？' },
        { ask_id: 'ask-3', question: '需要通知团队吗？' },
      ],
      say: { screen: 'screen', spoken: '再确认创建。' },
    })
    expect(conversation.contextFor('no')).toEqual({ last_say_id: 's1', confirmed: { ask_id: 'ask-2', choice: '否' }, in_call: true })

    conversation.accept({ say_id: 's1', items: [], asks: [{ ask_id: 'ask-3', question: '需要通知团队吗？' }], say: { screen: 'screen', spoken: '还有一项。' } })
    expect(conversation.contextFor('yes')).toEqual({ last_say_id: 's1', confirmed: { ask_id: 'ask-3', choice: '是' }, in_call: true })
  })

  it('keeps pending confirmation after a transport failure and clears it only after a server reply', async () => {
    const { SayConversation } = await import('../src/sayTurn.ts')
    const conversation = new SayConversation()
    conversation.accept({ say_id: 's1', items: [], hold: { hold_id: 'hold-2', reason: 'external', question: '确认吗？' }, say: { screen: 'screen', spoken: '等你确认。' } })
    const answered = conversation.contextFor('no')
    conversation.failed()
    expect(conversation.contextFor('no')).toEqual(answered)
    conversation.accept({ say_id: 's2', items: [], say: { screen: 'screen', spoken: '已取消。' } })
    expect(conversation.contextFor('no')).toEqual({ last_say_id: 's2', in_call: true })
  })

  it('does not carry pending confirmation into the next call', async () => {
    const { SayConversation } = await import('../src/sayTurn.ts')
    const conversation = new SayConversation()
    conversation.accept({ say_id: 's1', items: [], ask: { ask_id: 'ask-1', question: '继续吗？' }, say: { screen: 'screen', spoken: '确认吗？' } })
    conversation.reset()
    expect(conversation.contextFor('yes')).toEqual({ in_call: true })
  })
})

describe('telephone server speech budget', () => {
  it('limits server spoken text with the existing per-turn budget', async () => {
    const { SentenceBudget } = await import('../src/sentenceCap.ts')
    const { capSaySpoken } = await import('../src/sayTurn.ts')
    const budget = new SentenceBudget()
    expect(capSaySpoken('第一句。第二句。第三句。', budget, 2)).toBe('第一句。第二句。')
  })
})

describe('pending telephone acknowledgement', () => {
  it('does not pre-ack a response already returned', async () => {
    const { sayPendingAckDue } = await import('../src/sayTurn.ts')
    expect(await sayPendingAckDue(Promise.resolve(), 20)).toBe(false)
  })

  it('offers the retained local first acknowledgement only while the server request is still pending', async () => {
    const { sayPendingAckDue } = await import('../src/sayTurn.ts')
    expect(await sayPendingAckDue(new Promise<void>(() => {}), 5)).toBe(true)
  })
})
