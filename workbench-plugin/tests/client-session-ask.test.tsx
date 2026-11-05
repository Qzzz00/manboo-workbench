/**
 * 别家会话在等你 —— 球下那一区的那张卡、「等你」那一堆里的那一件(2026-09-25,卡 T)。
 *
 * 维护者 09-25 晚定的规矩(交付前按「不懂技术、第一次装」的人过一遍):
 * ① 外层那张卡用一句人话说清是哪家在等、等他做什么(「Codex 在等你选:用方案 A 还是 B」),**不贴对方原文**;
 * ② 答了送不回去时,那句话他看得懂、知道去哪儿答(「这一问得在电脑上的 Claude 里回答」+「去回答」);
 * ③ 跟事务官的提问卡同一堆、同一个数。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionView, WorkbenchState } from '../src/protocol.ts'
import { SessionAsk } from '../src/client/SessionAsk.tsx'
import { ButlerInbox } from '../src/client/ButlerInbox.tsx'
import { waitingOnHim } from '../src/waiting.ts'

afterEach(() => { cleanup(); globalThis.localStorage?.clear() })

function stub(reply: (path: string, body: unknown) => { status?: number, body: unknown } = () => ({ body: { ok: true } })) {
  const calls: { path: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, body })
    const out = reply(url.pathname, body)
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const BASE = 'http://127.0.0.1:8791'

const LONG_ORIGINAL = '有件事需要你定:今天的模型额度只剩 0.58 元。电脑这台设备每天的上限是 5 元,今天已经花了 4.42 元。大头是上午事务官自己修卡片小头像(约 2.3 元)。'

function waitingSession(reply: 'desk' | 'window', patch: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'claude', session_id: 'd999', project: 'ben-dsh-workbench', status: 'waiting', reason: 'idle_prompt', wait_reason: 'input',
    title: '在等你:不只看会话状态', elapsed_sec: 600, unread: false, updated_at: '2026-09-25T09:34:23.000Z',
    ask: {
      kind: 'choose',
      question: '今天的模型额度只剩 0.58 元。',
      options: [{ label: '把上限提到 15 元(我推荐)', note: '我改中转上的设置' }, { label: '不提,今天省着用' }, { label: '你换成自己的 DeepSeek Key' }],
      since: '2026-09-25T09:34:23.000Z',
      quote: '你选哪个?回个数字就行。',
      by: 'rules',
      reply,
      ...(reply === 'desk' ? { where: '这一问得在电脑上的 Claude 里回答', reveal: true as const } : {}),
    },
    ...patch,
  }
}

describe('那张卡(SessionAsk)', () => {
  it('★一句人话说清哪家在等、等他做什么;选项摆出来;原话收着(点开才看),不贴整段', async () => {
    const { container } = render(<SessionAsk session={waitingSession('desk')} baseUrl={BASE} fetchImpl={stub().impl} />)
    expect(screen.getByText('Claude 在等你选')).toBeInTheDocument()
    expect(screen.getByText('今天的模型额度只剩 0.58 元。')).toBeInTheDocument()
    expect(screen.getByText('把上限提到 15 元(我推荐)')).toBeInTheDocument()
    expect(container.textContent).not.toContain(LONG_ORIGINAL.slice(20, 40))
    expect(screen.queryByText(/回个数字就行/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '它的原话' }))
    expect(screen.getByText('「你选哪个?回个数字就行。」')).toBeInTheDocument()
  })

  it('★送不回去:写清去哪儿答 +「去回答」(把那段对话调到前面);选项只摆字、不能点', async () => {
    const { impl, calls } = stub((path) => (path === '/sessions/reveal' ? { body: { ok: true, how: 'link' } } : { body: { ok: true } }))
    render(<SessionAsk session={waitingSession('desk')} baseUrl={BASE} fetchImpl={impl} />)
    expect(screen.getByText('这一问得在电脑上的 Claude 里回答')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /把上限提到 15 元/ })).toBeNull()
    expect(screen.queryByLabelText('我自己说')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '去回答' }))
    await waitFor(() => expect(calls).toEqual([{ path: '/sessions/reveal', body: { agent: 'claude', session_id: 'd999' } }]))
  })

  it('送得回去:点一个选项就送(送的是选项原话);「我自己说」回车也送', async () => {
    const { impl, calls } = stub(() => ({ body: { ok: true, route: 'window' } }))
    const onReceipt = vi.fn()
    render(<SessionAsk session={waitingSession('window')} baseUrl={BASE} fetchImpl={impl} onReceipt={onReceipt} />)
    await userEvent.click(screen.getByRole('button', { name: /不提,今天省着用/ }))
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith('送过去了,它接着办'))
    expect(calls[0]).toEqual({ path: '/sessions/answer', body: { agent: 'claude', session_id: 'd999', text: '不提,今天省着用' } })
    await userEvent.type(screen.getByLabelText('我自己说'), '先提到 10 元{Enter}')
    await waitFor(() => expect(calls[1]?.body).toEqual({ agent: 'claude', session_id: 'd999', text: '先提到 10 元' }))
  })

  it('终端里开的会话:只写去哪儿答,没有「去回答」(调不到那个终端)', () => {
    const { reveal: _reveal, ...ask } = waitingSession('desk').ask!
    render(<SessionAsk session={{ ...waitingSession('desk'), ask: { ...ask, where: '这一问得在电脑上开着 Claude 的那个终端窗口里回答' } }} baseUrl={BASE} fetchImpl={stub().impl} />)
    expect(screen.getByText('这一问得在电脑上开着 Claude 的那个终端窗口里回答')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '去回答' })).toBeNull()
  })

  it('本以为送得回去、窗口里却没找到那段对话:改成写清去哪儿答 +「去回答」', async () => {
    const { impl } = stub(() => ({ body: { ok: false, where: 'desk', why: '这一问得在电脑上的 Claude 里回答(窗口里没找到那段对话)', reveal: true } }))
    render(<SessionAsk session={waitingSession('window')} baseUrl={BASE} fetchImpl={impl} />)
    await userEvent.click(screen.getByRole('button', { name: /不提,今天省着用/ }))
    expect(await screen.findByText(/窗口里没找到那段对话/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '去回答' })).toBeInTheDocument()
  })

  it('「不用管这条」:按内容判出来的才有;点了就拿掉(POST /sessions/ask/dismiss);弹窗那种没有这颗', async () => {
    const { impl, calls } = stub(() => ({ body: { ok: true } }))
    const onReceipt = vi.fn()
    const { unmount } = render(<SessionAsk session={waitingSession('desk')} baseUrl={BASE} fetchImpl={impl} onReceipt={onReceipt} />)
    await userEvent.click(screen.getByRole('button', { name: '不用管这条' }))
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith('好,这条不算在等你了'))
    expect(calls).toEqual([{ path: '/sessions/ask/dismiss', body: { agent: 'claude', session_id: 'd999' } }])
    unmount()
    const form = waitingSession('desk')
    render(<SessionAsk session={{ ...form, ask: { ...form.ask!, by: 'form' } }} baseUrl={BASE} fetchImpl={impl} />)
    expect(screen.queryByRole('button', { name: '不用管这条' })).toBeNull()
  })

  /**
   * ★ **她自己打的那一句也送得进去**(2026-09-28,卡 AT)。维护者原话:「做半天还是不能送进去?……
   * 你就复制黏贴我贴在框里的文字输入进去不就好了吗。」弹框那一问从前只有一行
   * 「上面那几项我能替你点;要自己说一句,得在电脑上…」—— 新壳上这半句不该再出现,
   * 那儿该摆着「我自己说」那个框,打一句走 `POST /asks/answer {key, text}`。
   */
  function formAsk(extra: Record<string, unknown> = {}) {
    const one = waitingSession('desk')
    return { ...one, ask: { ...one.ask!, by: 'form' as const, press: true as const, ...extra } }
  }

  it('★弹框那一问 + 新壳(write:true):摆「我自己说」那个框,不再写「要自己说一句,得在电脑上…」', async () => {
    const { impl, calls } = stub(() => ({ body: { ok: true, confirmed: true, note: '已替你答了:先提到 10 元' } }))
    const onReceipt = vi.fn()
    const { container } = render(<SessionAsk session={formAsk({ write: true })} baseUrl={BASE} fetchImpl={impl} onReceipt={onReceipt} />)
    expect(container.textContent).not.toContain('要自己说一句')
    const box = screen.getByLabelText('我自己说')
    expect(box).toHaveAttribute('placeholder', '我自己说:直接写一句,替你写进它那个框')
    await userEvent.type(box, '先提到 10 元{Enter}')
    await waitFor(() => expect(calls[0]).toEqual({ path: '/asks/answer', body: { key: 'session:claude/d999', text: '先提到 10 元' } }))
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith('已替你答了:先提到 10 元'))
    // 选项照旧是能点的键(卡 WQ 那一路一个字没改),「去回答」也还在。
    expect(screen.getByRole('button', { name: /把上限提到 15 元/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '去回答' })).toBeInTheDocument()
  })

  it('★写进去了、没看到它收下:照服务端那句原话说,不说成答上了', async () => {
    const { impl } = stub(() => ({ body: { ok: true, confirmed: false, note: '把「先提到 10 元」写进去按了发送,但没看到它收下 —— 去电脑上的 Claude 看一眼' } }))
    render(<SessionAsk session={formAsk({ write: true })} baseUrl={BASE} fetchImpl={impl} />)
    await userEvent.type(screen.getByLabelText('我自己说'), '先提到 10 元{Enter}')
    expect(await screen.findByText(/没看到它收下/)).toBeInTheDocument()
  })

  it('★旧壳(没有 write):照旧那一行「上面那几项我能替你点;要自己说一句,…」,没有那个框', () => {
    render(<SessionAsk session={formAsk()} baseUrl={BASE} fetchImpl={stub().impl} />)
    expect(screen.getByText(/上面那几项我能替你点;要自己说一句/)).toBeInTheDocument()
    expect(screen.queryByLabelText('我自己说')).toBeNull()
  })

  it('收成一行:「Claude 在等你选:今天的模型额度只剩 0.58 元 · 展开」', async () => {
    const onExpand = vi.fn()
    render(<SessionAsk session={waitingSession('desk')} baseUrl={BASE} fetchImpl={stub().impl} variant="row" onExpand={onExpand} />)
    expect(screen.getByText('Claude 在等你选:今天的模型额度只剩 0.58 元')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '展开' }))
    expect(onExpand).toHaveBeenCalled()
  })
})

describe('同一堆、同一个数', () => {
  function state(extra: Partial<WorkbenchState> = {}): WorkbenchState {
    return {
      agents: [], sessions: [], quota: {}, now: '2026-09-25T10:00:00.000Z', stale: false,
      tasks: { tasks: [], sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] }, onboarding: { stage: 'done', done: true },
      ...extra,
    } as WorkbenchState
  }

  it('★别家会话在等你的,进「等你」那一堆(事务官自己的、没在等的不进);一句人话四种说法', () => {
    const kinds: SessionView[] = [
      waitingSession('desk'),
      { ...waitingSession('desk'), agent: 'codex', session_id: 'c1', ask: { kind: 'approve', question: '要不要合进 main?', since: 'x', by: 'rules' } },
      { ...waitingSession('desk'), agent: 'kimi', session_id: 'k1', ask: { kind: 'do', question: '需要你在系统设置里勾上辅助功能。', since: 'x', by: 'rules' } },
      { ...waitingSession('desk'), agent: 'codex', session_id: 'c2', ask: { kind: 'review', question: '参赛网页逐屏文案稿在等你审', since: 'x', by: 'rules' } },
      { ...waitingSession('desk'), agent: 'dsh', session_id: 'dsh-1' },
      { agent: 'claude', session_id: 'idle', project: '', status: 'done', elapsed_sec: 1, unread: false, updated_at: 'x' },
    ]
    const pile = waitingOnHim(state({ sessions: kinds }))
    expect(pile.count).toBe(4)
    expect(pile.items.map(item => [item.key, item.verb, item.text])).toEqual([
      ['session:claude/d999', '答', 'Claude 在等你选:今天的模型额度只剩 0.58 元'],
      ['session:codex/c1', '批', 'Codex 在等你点头:要不要合进 main?'],
      ['session:kimi/k1', '做', 'Kimi 在等你动手:需要你在系统设置里勾上辅助功能'],
      ['session:codex/c2', '审', 'Codex 在等你看:参赛网页逐屏文案稿'],
    ])
  })

  it('★子任务在等他:冒到主会话那张卡上、同一堆同一个数,那句话说清是哪家的哪个子任务', async () => {
    const main = waitingSession('desk', {
      ask: { kind: 'approve', question: '它要跑测试,等你批准', since: 'x', by: 'form', child: { id: 'agent-a7', title: '跑一遍测试' }, reply: 'desk', where: '这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)', reveal: true },
    })
    const untitled = { ...waitingSession('desk'), agent: 'codex' as const, session_id: 'c9', ask: { kind: 'choose' as const, question: '额度按天算还是按月算?', since: 'x', by: 'form' as const, child: { id: 't2' } } }
    const pile = waitingOnHim(state({ sessions: [main, untitled] }))
    expect(pile.count).toBe(2)
    expect(pile.items.map(item => item.text)).toEqual([
      'Claude 的子任务「跑一遍测试」在等你点头:它要跑测试,等你批准',
      'Codex 的子任务在等你选:额度按天算还是按月算?',
    ])
    render(<SessionAsk session={main} baseUrl={BASE} fetchImpl={stub().impl} />)
    expect(screen.getByText('Claude 的子任务「跑一遍测试」在等你点头')).toBeInTheDocument()
    expect(screen.getByText('这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '去回答' })).toBeInTheDocument()
  })

  /**
   * 口径改了(2026-09-27,卡 DD:同一件「等你」只摆一处,维护者拍板**留球旁的卡**)。
   * 原来这里钉的是「球下那一区里是那张卡」—— 那条会话此刻在台上有一张会话卡、卡上已经写着那一问,
   * 两处摆同一句话就是维护者截图里那个毛病。现在:台上那张写着,球下不摆;「等你 1」照旧算上它。
   */
  it('★台上那张卡写着这一问 → 球下不摆;「等你 n」照旧算上它', async () => {
    const props = {
      state: state({ sessions: [waitingSession('desk')] }), baseUrl: BASE, fetchImpl: stub().impl, onOpenConversation: vi.fn(), draft: '', onDraftChange: vi.fn(), visible: true,
      controls: { paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] },
    }
    const { container } = render(<ButlerInbox {...props} />)
    const card = container.querySelector('[data-task-card="session:claude/d999"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('等你选:今天的模型额度只剩 0.58 元')
    expect(container.querySelector('.ben-wb__asks [data-ask="session:claude/d999"]')).toBeNull()
    expect(screen.getByText(/等你 1/, { selector: '.ben-wb__orb-counts' })).toBeInTheDocument()
  })
})
