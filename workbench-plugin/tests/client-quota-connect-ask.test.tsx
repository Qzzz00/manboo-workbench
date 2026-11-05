/**
 * 球下面那张「额度还差一步」(2026-09-25,卡 fix/quota-and-slot-apps)。
 *
 * 设计第二节第 2、5 条:球下面只放一两张要他处理的卡(如「3 家额度一键接上」);维护者:「授权要自己点就算了」
 * —— 可以要他点,但只点一次。断言写的是他在屏幕上看得到什么:
 *   ① 引导没做完 / 没有要处理的 → 这张卡不出现;微信企微永远不在上面;
 *   ② 「全部接上」**就地展开**(不弹窗):先看 → 一次写入 → 每家各一颗撤回;
 *   ③ 「登录 Kimi」开登录窗口,那一句说清要他自己登、登一次就好;
 *   ④ 「先不」收起来。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuotaConnectView, WorkbenchState } from '../src/protocol.ts'
import { QuotaConnectAsk, quotaAskLine } from '../src/client/QuotaConnectAsk.tsx'

afterEach(cleanup)

const BEN: QuotaConnectView = {
  providers: [
    { agent: 'dsh', label: 'DeepSeek', state: 'connected' },
    { agent: 'claude', label: 'Claude', state: 'one_click' },
    { agent: 'codex', label: 'Codex', state: 'one_click' },
    { agent: 'kimi', label: 'Kimi', state: 'login' },
  ],
  one_click: true,
  line: 'DeepSeek 已接上;Claude、Codex 要你点一次「全部接上」;Kimi 要你自己登一次',
}

/** 只填这张卡读得到的几格;onboarding 只用得到 done(isFirstTime 只看它)。 */
function state(over: Record<string, unknown> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: '2026-09-25T09:30:00+08:00', stale: false, onboarding: { done: true }, quota_connect: BEN, ...over } as unknown as WorkbenchState
}

const PREVIEW = {
  ok: true,
  agents: [
    { agent: 'claude', name: 'Claude', state: 'pending', file: '/Users/b/.claude/settings.json', content: {}, will: { added: 4, replaced: 0, status_line: 'added' } },
    { agent: 'codex', name: 'Codex', state: 'pending', file: '/Users/b/.codex/hooks.json', content: {}, will: { added: 3, replaced: 0, status_line: 'none' } },
  ],
  apply: ['claude', 'codex'],
  kimi: { state: 'pending', how: '要你自己登一次' },
  line: '要写 2 家',
}
const APPLIED = {
  ok: true,
  results: [
    { agent: 'claude', name: 'Claude', ok: true, file: '/Users/b/.claude/settings.json', backup_path: '/Users/b/.claude/settings.json.bak-工作台-1' },
    { agent: 'codex', name: 'Codex', ok: true, file: '/Users/b/.codex/hooks.json' },
  ],
  skipped: [],
  restart_hint: '各自关掉、重新开一个',
  line: 'Claude、Codex 接上了。',
}

function fakeFetch() {
  const calls: { url: string, method: string, body?: string }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
    const body = url.endsWith('/quota/connect-all/apply') ? APPLIED
      : url.endsWith('/quota/connect-all/preview') ? PREVIEW
        : url.endsWith('/login') ? (init?.method === 'POST' ? { ok: true } : { state: 'waiting', message: '等你在窗口里登录…' })
          : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('球下面那张「额度还差一步」', () => {
  it('★维护者那台机器:一句话只说要他处理的两件事,微信企微不在上面;三颗键', () => {
    render(<QuotaConnectAsk state={state()} baseUrl="http://x" fetchImpl={fakeFetch().impl} />)
    const card = screen.getByRole('region', { name: '额度还差一步' })
    expect(card).toHaveTextContent('Claude、Codex 点一次「全部接上」就都接上')
    expect(card).toHaveTextContent('Kimi 要你自己登一次(账号密码工作台不经手),登一次以后就不用再登')
    expect(card.textContent).not.toMatch(/微信|企业微信/)
    expect(screen.getByRole('button', { name: '全部接上' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '登录 Kimi' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '先不' })).toBeInTheDocument()
  })

  it('★引导还没做完 → 不出现(那会儿这块地方归引导);没有要处理的 → 不出现', () => {
    render(<QuotaConnectAsk state={state({ onboarding: { done: false } })} baseUrl="http://x" />)
    expect(screen.queryByRole('region', { name: '额度还差一步' })).toBeNull()
    cleanup()
    const allOn: QuotaConnectView = { ...BEN, one_click: false, providers: BEN.providers.map(row => ({ ...row, state: 'connected' as const })) }
    render(<QuotaConnectAsk state={state({ quota_connect: allOn })} baseUrl="http://x" />)
    expect(screen.queryByRole('region', { name: '额度还差一步' })).toBeNull()
    cleanup()
    const { quota_connect: _gone, ...noView } = state()
    render(<QuotaConnectAsk state={noView as WorkbenchState} baseUrl="http://x" />)
    expect(screen.queryByRole('region', { name: '额度还差一步' })).toBeNull()
  })

  it('★「全部接上」就地展开(不弹窗):先看 → 一次写入 → 每家各一颗撤回;「知道了」之后这张卡收起', async () => {
    const { calls, impl } = fakeFetch()
    render(<QuotaConnectAsk state={state()} baseUrl="http://x" fetchImpl={impl} />)
    fireEvent.click(screen.getByRole('button', { name: '全部接上' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '一次写入(2 家)' }))
    expect(await screen.findByRole('button', { name: '撤回 Claude' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤回 Codex' })).toBeInTheDocument()
    expect(calls.filter(call => call.method === 'POST').map(call => call.url)).toEqual(['http://x/quota/connect-all/apply'])
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    // 探测要过一拍才跟上:同一句话不再冒出来。
    expect(screen.queryByRole('region', { name: '额度还差一步' })).toBeNull()
  })

  it('「登录 Kimi」:开登录窗口(POST /login {provider:kimi_web}),那一句说清在窗口里登一次就好', async () => {
    const { calls, impl } = fakeFetch()
    render(<QuotaConnectAsk state={state()} baseUrl="http://x" fetchImpl={impl} />)
    fireEvent.click(screen.getByRole('button', { name: '登录 Kimi' }))
    expect(await screen.findByText(/登录窗口开了 —— 在那个窗口里登一次就好/)).toBeInTheDocument()
    const login = calls.find(call => call.url === 'http://x/login' && call.method === 'POST')
    expect(JSON.parse(login?.body ?? '{}')).toEqual({ provider: 'kimi_web' })
  })

  it('「先不」:这一句收起来', () => {
    render(<QuotaConnectAsk state={state()} baseUrl="http://x" fetchImpl={fakeFetch().impl} />)
    fireEvent.click(screen.getByRole('button', { name: '先不' }))
    expect(screen.queryByRole('region', { name: '额度还差一步' })).toBeNull()
  })

  it('quotaAskLine:只有 Kimi 要登 → 只说 Kimi;只有一家要点 → 只说那一家', () => {
    const kimiOnly: QuotaConnectView = { ...BEN, one_click: false, providers: BEN.providers.map(row => (row.agent === 'kimi' ? row : { ...row, state: 'connected' as const })) }
    expect(quotaAskLine(kimiOnly)).toBe('Kimi 要你自己登一次(账号密码工作台不经手),登一次以后就不用再登。')
    const codexOnly: QuotaConnectView = { ...BEN, providers: BEN.providers.map(row => (row.agent === 'codex' ? row : { ...row, state: 'connected' as const })) }
    expect(quotaAskLine(codexOnly)).toBe('Codex 点一次「全部接上」就都接上(先看要写什么,写完每家都能单独撤回)。')
  })
})
