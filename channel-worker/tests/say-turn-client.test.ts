import { describe, expect, it } from 'vitest'
import { createWorkbenchClient } from '../src/workbench.ts'

describe('WorkbenchClient.sayTurn', () => {
  it('posts phone text with context and idempotent client key and preserves response', async () => {
    const calls: { path: string, body: Record<string, unknown> }[] = []
    const client = createWorkbenchClient({
      baseUrl: 'http://127.0.0.1:8791/',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response(JSON.stringify({ say_id: 's7', items: [], say: { screen: 'screen', spoken: '原样念我。' } }), { status: 200 })
      }) as typeof fetch,
    })
    const ctx = { last_say_id: 's6', confirmed: { ask_id: 'a1', choice: '否' }, in_call: true }
    const first = await client.sayTurn({ text: '先别做', ctx })
    const second = await client.sayTurn({ text: '先别做', ctx })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.path).toBe('/butler/say')
    expect(calls[0]?.body).toMatchObject({ text: '先别做', entrance: 'call', ctx })
    expect(calls[1]?.body.client_key).toBe(calls[0]?.body.client_key)
    expect(first).toEqual({ ok: true, reply: { say_id: 's7', items: [], say: { screen: 'screen', spoken: '原样念我。' } } })
    expect(second).toEqual(first)
  })

  it('classifies the real 3 second abort and retries with the same idempotency key', async () => {
    const bodies: Record<string, unknown>[] = []
    let call = 0
    const client = createWorkbenchClient({
      baseUrl: 'http://127.0.0.1:8791',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        call += 1
        if (call === 1) return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
        return new Response(JSON.stringify({ say_id: 's8', items: [], say: { screen: 'screen', spoken: '补做完成。' } }), { status: 200 })
      }) as typeof fetch,
    })
    const first = await client.sayTurn({ text: '再试一次' })
    const second = await client.sayTurn({ text: '再试一次' })
    expect(first).toMatchObject({ ok: false, timedOut: true })
    expect(second).toMatchObject({ ok: true, reply: { say_id: 's8', say: { spoken: '补做完成。' } } })
    expect(bodies[1]?.client_key).toBe(bodies[0]?.client_key)
  }, 7000)

  it('keeps deliberate repeated identical turns distinct when given per-turn keys', async () => {
    const bodies: Record<string, unknown>[] = []
    const client = createWorkbenchClient({
      baseUrl: 'http://127.0.0.1:3793',
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ say_id: `s${bodies.length}`, items: [], say: { screen: '好', spoken: '好' } }), { status: 200 })
      }) as typeof fetch,
    })
    await client.sayTurn({ text: '再试一次', clientKey: 'turn-one' })
    await client.sayTurn({ text: '再试一次', clientKey: 'turn-two' })
    expect(bodies.map(one => one.client_key)).toEqual(['turn-one', 'turn-two'])
  })
})
