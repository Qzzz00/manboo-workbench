import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ButlerInbox } from '../src/client/ButlerInbox.tsx'
import type { WorkbenchState } from '../src/protocol.ts'
import type { SayCardPayload } from '../src/client/sayCards.ts'

const state: WorkbenchState = { agents: [], sessions: [], quota: {}, now: '2026-10-24T00:00:00Z', stale: false }
const controls = { paused: false, testRinging: false, proposals: [], onPause() {}, onTestRing() {}, onCancelWatch() {}, onDismissBrief() {} }
const result = (id: string): SayCardPayload => ({ say_id: id, say: { screen: `${id}待答` }, ask: { ask_id: `ask-${id}`, question: `${id}确认吗` } })
const choices = {
  ask: { ask: { ask_id: 'ask-A', question: 'A确认吗' } },
  hold: { hold: { hold_id: 'hold-A', reason: 'external', question: 'A确认吗' } },
  suggest: { suggest: { suggest_id: 'suggest-A', line: 'A建议', default_action: 'keep', options: [{ id: 'codex', label: '选Codex' }] } },
  decided: { decided: [{ decided_id: 'decided-A', item_index: 0, field: 'who', chosen: 'Claude', why: 'A分工', alternatives: [{ id: 'codex', label: 'Codex' }] }] },
} satisfies Record<string, Partial<SayCardPayload>>
type Kind = keyof typeof choices
const label = (kind: Kind) => kind === 'suggest' ? '选Codex' : kind === 'decided' ? '改为 Codex' : '确认'
const original = (kind: Kind): SayCardPayload => ({ say_id: 'A', say: { screen: 'A待处理' }, ...(kind === 'decided' ? { items: [{ kind: '办', title: 'A受控事项', status: 'done', card_id: 'fixture-card-A' }] } : {}), ...choices[kind] })
function App({ fetchImpl, orientation = 'portrait', baseUrl = 'http://127.0.0.1:9693' }: { fetchImpl: typeof fetch; orientation?: 'portrait' | 'landscape'; baseUrl?: string }) {
  const [draft, setDraft] = useState('')
  return <ButlerInbox state={state} controls={controls} fetchImpl={fetchImpl} baseUrl={baseUrl} draft={draft} onDraftChange={setDraft} visible onOpenConversation={() => {}} orientation={orientation} />
}
function pending() {
  let resolve!: (response: Response) => void, reject!: (error: Error) => void
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
async function send(text: string) {
  fireEvent.change(screen.getByLabelText('交给事务官一件事'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: '交给事务官' }))
}
afterEach(cleanup)
const httpEvidence: unknown[] = []
afterAll(() => { const root = process.env.COLLAB_1C_C1_EVIDENCE_DIR; if (root) { mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'http-cases.json'), JSON.stringify({ boundary: 'Production ButlerInbox React in jsdom, real loopback HTTP with explicitly controlled legal response fixtures; no model/Agent or business API capability claim.', cases: httpEvidence }, null, 2)) } })

describe('C1 desktop choice response ownership', () => {
  for (const kind of Object.keys(choices) as Kind[]) {
    for (const outcome of ['success', 'http-error', 'offline'] as const) {
      it(`${kind}: B先回后A迟到${outcome}不覆盖B/草稿/nextctx`, async () => {
        const a = pending(); const requests: Record<string, any>[] = []
        const fetchImpl = (async (_url, init) => {
          const body = JSON.parse(String(init?.body)); requests.push(body)
          if (requests.length === 1) return response(original(kind))
          if (requests.length === 2) return a.promise
          return response(result(body.text))
        }) as typeof fetch
        render(<App fetchImpl={fetchImpl} orientation={kind === 'decided' ? 'landscape' : 'portrait'} />)
        await send('A'); await screen.findByText('A待处理')
        fireEvent.click(screen.getByRole('button', { name: label(kind) }))
        await send('B'); await screen.findByText('B待答')
        fireEvent.change(screen.getByLabelText('交给事务官一件事'), { target: { value: 'C草稿' } })
        await act(async () => { if (outcome === 'offline') a.reject(new Error('controlled offline')); else a.resolve(response(outcome === 'success' ? { say_id: 'A-next', say: { screen: 'A迟到回执' } } : { error: 'A迟到错误' }, outcome === 'http-error' ? 409 : 200)) })
        expect(screen.getByText('B待答')).toBeInTheDocument()
        expect(screen.getByText('B确认吗')).toBeInTheDocument()
        expect(screen.queryByText('A迟到回执')).toBeNull(); expect(screen.queryByText('A迟到错误')).toBeNull(); expect(screen.queryByText('工作台服务没应答，选择尚未确认。')).toBeNull()
        expect(screen.getByLabelText('交给事务官一件事')).toHaveValue('C草稿')
        fireEvent.click(screen.getByRole('button', { name: '交给事务官' }))
        await screen.findByText('C草稿待答'); expect(requests.at(-1)!.ctx.last_say_id).toBe('B')
      })
    }
    it(`${kind}: 单选择有效、重复点击只发一次且不清新草稿`, async () => {
      const a = pending(); const requests: Record<string, any>[] = []
      const fetchImpl = (async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return requests.length === 1 ? response(original(kind)) : a.promise }) as typeof fetch
      render(<App fetchImpl={fetchImpl} />); await send('A'); await screen.findByText('A待处理')
      const button = screen.getByRole('button', { name: label(kind) }); fireEvent.click(button); fireEvent.click(button)
      fireEvent.change(screen.getByLabelText('交给事务官一件事'), { target: { value: '新草稿' } })
      await act(async () => a.resolve(response({ say_id: 'A-next', say: { screen: 'A有效回执' } })))
      expect(await screen.findByText('A有效回执')).toBeInTheDocument(); expect(requests).toHaveLength(2)
      expect(screen.getByLabelText('交给事务官一件事')).toHaveValue('新草稿')
    })
  }
  it.each(['http-error', 'offline'] as const)('单选择%s保原卡与草稿，解锁后可正常重试', async outcome => {
    let calls = 0
    const fetchImpl = (async () => { calls++; if (calls === 1) return response(original('ask')); if (calls === 2) { if (outcome === 'offline') throw new Error('controlled offline'); return response({ error: '本次选择未确认' }, 409) } return response({ say_id: 'A-next', say: { screen: 'A重试有效' } }) }) as typeof fetch
    render(<App fetchImpl={fetchImpl} />); await send('A'); await screen.findByText('A待处理'); fireEvent.change(screen.getByLabelText('交给事务官一件事'), { target: { value: '新草稿' } }); fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await screen.findByText(outcome === 'offline' ? '工作台服务没应答，选择尚未确认。' : '本次选择未确认')
    expect(screen.getByText('A待处理')).toBeInTheDocument(); expect(screen.getByLabelText('交给事务官一件事')).toHaveValue('新草稿')
    const button = screen.getByRole('button', { name: '确认' }); expect(button).toBeEnabled(); fireEvent.click(button)
    expect(await screen.findByText('A重试有效')).toBeInTheDocument(); expect(calls).toBe(3); expect(screen.getByLabelText('交给事务官一件事')).toHaveValue('新草稿')
  })
  it('A迟到后下一句实际发送的last_say_id仍归B', async () => {
    const a = pending(); const requests: Record<string, any>[] = []
    const fetchImpl = (async (_url, init) => { const body = JSON.parse(String(init?.body)); requests.push(body); return body.ctx?.confirmed ? a.promise : response(body.text === 'A' ? original('ask') : result(body.text)) }) as typeof fetch
    render(<App fetchImpl={fetchImpl} />); await send('A'); await screen.findByText('A待处理'); fireEvent.click(screen.getByRole('button', { name: '确认' })); await send('B'); await screen.findByText('B待答')
    await act(async () => a.resolve(response({ say_id: 'A-next', say: { screen: 'A迟到回执' } })))
    await send('C'); await screen.findByText('C待答'); expect(requests.at(-1)!.ctx.last_say_id).toBe('B')
  })
  it('旧A不能锁住B的新确认，旧finally也不能解开B在途锁', async () => {
    const a = pending(), b = pending(); const requests: Record<string, any>[] = []
    const fetchImpl = (async (_url, init) => { const body = JSON.parse(String(init?.body)); requests.push(body); if (body.ctx?.confirmed) return body.ctx.confirmed.ask_id === 'ask-A' ? a.promise : b.promise; return response(result(body.text)) }) as typeof fetch
    render(<App fetchImpl={fetchImpl} />); await send('A'); await screen.findByText('A确认吗'); fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await send('B'); await screen.findByText('B确认吗'); const button = screen.getByRole('button', { name: '确认' }); expect(button).toBeEnabled(); fireEvent.click(button)
    await act(async () => a.resolve(response({ say_id: 'A-next', say: { screen: 'A迟到回执' } })))
    expect(button).toBeDisabled(); fireEvent.click(button); expect(requests).toHaveLength(4)
    await act(async () => b.resolve(response({ say_id: 'B-next', say: { screen: 'B有效回执' } })))
    expect(await screen.findByText('B有效回执')).toBeInTheDocument(); await send('C'); await screen.findByText('C确认吗'); expect(requests.at(-1)!.ctx.last_say_id).toBe('B-next')
  })
  it('B离线保草稿与A卡，旧A成功不能清掉B离线回执', async () => {
    const a = pending(); let calls = 0
    const fetchImpl = (async () => { calls++; if (calls === 1) return response(original('ask')); if (calls === 2) return a.promise; throw new Error('controlled offline') }) as typeof fetch
    render(<App fetchImpl={fetchImpl} />); await send('A'); await screen.findByText('A待处理'); fireEvent.click(screen.getByRole('button', { name: '确认' })); await send('B')
    await screen.findByText('工作台服务没应答,这句话还留在框里')
    const stillPending = screen.getByRole('button', { name: '确认' }); expect(stillPending).toBeDisabled(); fireEvent.click(stillPending); expect(calls).toBe(3)
    await act(async () => a.resolve(response({ say_id: 'A-next', say: { screen: 'A迟到回执' } })))
    expect(screen.getByText('A待处理')).toBeInTheDocument(); expect(screen.getByText('工作台服务没应答,这句话还留在框里')).toBeInTheDocument(); expect(screen.getByLabelText('交给事务官一件事')).toHaveValue('B')
  })
  it.each([{ orientation: 'portrait', fail: false }, { orientation: 'portrait', fail: true }, { orientation: 'landscape', fail: false }, { orientation: 'landscape', fail: true }] as const)('真实HTTP受控延时：$orientation / error=$fail 生产React保B及下一句ctx', async ({ orientation, fail }) => {
    let held: ServerResponse | undefined; const requests: Record<string, any>[] = []
    const server = createServer(async (req, res) => { if (req.method !== 'POST' || req.url !== '/butler/say') { res.writeHead(404, { 'content-type': 'application/json' }).end('{}'); return } let text = ''; for await (const part of req) text += part; const body = JSON.parse(text); requests.push(body); if (body.ctx?.confirmed) { held = res; return } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body.text === 'A' ? original('ask') : result(body.text))) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('no controlled HTTP port')
    try {
      let consumed!: () => void; const consumedResponse = new Promise<void>(resolve => { consumed = resolve });
      const transport: typeof fetch = async (input, init) => { const res = await fetch(input, init); const parse = res.json.bind(res); res.json = async () => { const payload = await parse(); if (payload.say_id === 'A-next' || payload.error === 'A迟到错误') consumed(); return payload }; return res };
      render(<App fetchImpl={transport} orientation={orientation} baseUrl={`http://127.0.0.1:${address.port}`} />)
      await send('A'); await screen.findByText('A待处理'); fireEvent.click(screen.getByRole('button', { name: '确认' })); await waitFor(() => expect(held).toBeDefined())
      await send('B'); await screen.findByText('B待答')
      await act(async () => { held!.setHeader('content-type', 'application/json'); held!.statusCode = fail ? 409 : 200; held!.end(JSON.stringify(fail ? { error: 'A迟到错误' } : { say_id: 'A-next', say: { screen: 'A迟到回执' } })); await consumedResponse })
      expect(screen.getByText('B待答')).toBeInTheDocument(); expect(screen.queryByText('A迟到错误')).toBeNull(); httpEvidence.push({ orientation, delayedStatus: fail ? 409 : 200, address: `127.0.0.1:${address.port}`, afterLateA: screen.getByRole('region', { name: '事务官处理结果' }).textContent, requests }); await send('C'); await screen.findByText('C待答'); expect(requests.at(-1)!.ctx.last_say_id).toBe('B')
    } finally { cleanup(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
  })
})
