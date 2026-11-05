/**
 * 电话里交代一件事,电脑只办一次(2026-10-12,卡「手机交代只执行一次」)。
 *
 * 模型重试、或者把同一句话当成两轮都调了一次「记下 / 派活 / 补一句 / 捎话」:工人在
 * {@link CALL_REPEAT_WINDOW_MS} 之内对**同一件、同一句**带同一个 `client_key`,8791 按它只办一次、回第一次那份。
 * 过了这一阵、或者换了一句,就是新的一件。
 */
import { describe, expect, it } from 'vitest'
import { CALL_REPEAT_WINDOW_MS, createWorkbenchClient } from '../src/workbench.ts'

function stub() {
  const calls: { path: string, body: Record<string, unknown> }[] = []
  let now = 1_000_000
  const client = createWorkbenchClient({
    baseUrl: 'http://127.0.0.1:8791',
    now: () => now,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      return new Response(JSON.stringify({ ok: true, id: 'item-1' }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  return { client, calls, tick: (ms: number) => { now += ms } }
}

describe('电话里同一句话调两次', () => {
  it('记下一件:两次带同一个号', async () => {
    const t = stub()
    await t.client.rememberItem('把周报整理一下', 'codex')
    await t.client.rememberItem(' 把周报整理一下 ', 'codex')
    const keys = t.calls.map(c => c.body.client_key)
    expect(typeof keys[0]).toBe('string')
    expect(keys[1]).toBe(keys[0])
  })

  it('换一句、换一家都是新的一件', async () => {
    const t = stub()
    await t.client.rememberItem('把周报整理一下', 'codex')
    await t.client.rememberItem('把周报整理一下', 'claude')
    await t.client.rememberItem('把月报整理一下', 'codex')
    expect(new Set(t.calls.map(c => c.body.client_key)).size).toBe(3)
  })

  it('过了那一阵再说同一句:新的一件(她可能真要再办一次)', async () => {
    const t = stub()
    await t.client.rememberItem('订一下会议室')
    t.tick(CALL_REPEAT_WINDOW_MS + 1)
    await t.client.rememberItem('订一下会议室')
    expect(t.calls[1]!.body.client_key).not.toBe(t.calls[0]!.body.client_key)
  })

  it('补一句、捎话也带号;同一句重复调用同一个号', async () => {
    const t = stub()
    await t.client.handToButler('item-1', '先别发')
    await t.client.handToButler('item-1', '先别发')
    await t.client.relayToSession({ who: 'Codex', text: '继续' })
    await t.client.relayToSession({ who: 'Codex', text: '继续' })
    const [a, b, c, d] = t.calls.map(x => x.body.client_key)
    expect(a).toBe(b)
    expect(c).toBe(d)
    expect(a).not.toBe(c)
  })
})
