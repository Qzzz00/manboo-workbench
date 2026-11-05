/**
 * 事务官要问的话、要批的事在外层答;点开一件事在工作台里看;DSH 原始界面上有「‹ 回工作台」;
 * 「事务官」标签上的气泡与「等你 n」同一个数(2026-09-25,卡 M;维护者点名的 bug)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingApprovalView, PendingQuestionView, WorkbenchState } from '../src/protocol.ts'
import { QuestionAsk } from '../src/client/QuestionAsk.tsx'
import { ApprovalAsk } from '../src/client/ApprovalAsk.tsx'
import { ItemTalk } from '../src/client/ItemTalk.tsx'
import { ButlerInbox } from '../src/client/ButlerInbox.tsx'
import { DockTabBar } from '../src/client/DockTabBar.tsx'
import { ReturnToWorkbench } from '../src/client/Workbench.tsx'
import { hisWords, questionRowText, waitingOnHim } from '../src/client/askModel.ts'
import { butlerConclusions } from '../src/client/butler.ts'
import { orbStatusLine } from '../src/client/butlerInbox.ts'

afterEach(() => { cleanup(); globalThis.localStorage?.clear() })

function stub(reply: (path: string, body: unknown) => { status?: number, body: unknown } = () => ({ body: { ok: true } })) {
  const calls: { path: string, method: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, method: init?.method ?? 'GET', body })
    const out = reply(url.pathname, body)
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const BASE = 'http://127.0.0.1:8791'

const QUESTION: PendingQuestionView = {
  id: 'q-1',
  session_id: 'session-07ed',
  task_id: 't-a8934b2a',
  task_title: '这个有点问题,你看三张卡片的左上角的小东西,跳起来的时候渲染的空间估计不够,你看…',
  at: '2026-09-25T05:49:11.000Z',
  questions: [{
    id: 'confirm_avatar_clip',
    header: '派活前对一遍',
    question: '行,这事我先不自己动手——你自己定的规矩,派活之前先跟你对一遍。\n\n要确认的:\n① 就是它们吧\n② 修在哪一层\n\n哪条不对说一下,都对就开工。',
    multi: false,
    options: [
      { label: '都对,开工 (Recommended)', text: '都对,开工(推荐)', note: '我按上面的默认理解派 Codex 去修。' },
      { label: '都对,但你自己做', text: '都对,但你自己做', note: '不派别家,我自己动手改。' },
      { label: '有不对的,我来说', text: '有不对的,我来说' },
    ],
  }],
}

const APPROVAL: PendingApprovalView = {
  id: 'a-1',
  session_id: 'session-07ed',
  task_id: 't-a8934b2a',
  task_title: '这个有点问题,你看三张卡片的左上角的小东西',
  tool: 'bash',
  reason: 'escalate sandbox to danger-full-access: headless Chrome 要写自己的用户目录与 crashpad 目录',
  at: '2026-09-25T06:00:00.000Z',
  say: '要开一个看不见的浏览器,把页面截下来看',
  why: '看不见的浏览器要写自己的用户目录与崩溃记录目录',
  scope: '这一条要能改这台电脑上的任何文件;平时只能改「工作台」文件夹和临时文件。',
  kind: { key: 'browser', title: '开看不见的浏览器截图' },
  raw: { reason: 'escalate sandbox to danger-full-access: headless Chrome 要写自己的用户目录与 crashpad 目录', command: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new' },
}

function baseState(extra: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [], sessions: [], quota: {}, now: '2026-09-25T06:00:00.000Z', stale: false,
    tasks: { tasks: [], sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] }, onboarding: { stage: 'done', done: true },
    ...extra,
  } as WorkbenchState
}

/** 外层看得见的字里不许出现的底层字样(维护者规矩第 3 条)。 */
const INTERNAL = /Bash|Think|Context injection|System prompt|danger-full-access|escalate|sandbox|Type your answer|Skip this question|Submit/

describe('她问你的那一问(QuestionAsk)', () => {
  it('她的话 + 选项 + 「我自己说」;点一个选项就交(交的是原样的选项名)', async () => {
    const { impl, calls } = stub()
    const onReceipt = vi.fn()
    const { container } = render(<QuestionAsk question={QUESTION} baseUrl={BASE} fetchImpl={impl} onReceipt={onReceipt} />)
    expect(screen.getByText(/派活之前先跟你对一遍/)).toBeInTheDocument()
    expect(screen.getByText('派活前对一遍')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /都对,开工\(推荐\)/ })).toBeInTheDocument()
    expect(screen.getByLabelText('我自己说')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(INTERNAL)
    await userEvent.click(screen.getByRole('button', { name: /都对,开工\(推荐\)/ }))
    await waitFor(() => expect(calls).toEqual([{ path: '/questions/answer', method: 'POST', body: { id: 'q-1', answers: [{ id: 'confirm_avatar_clip', selected: ['都对,开工 (Recommended)'] }] } }]))
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith('答上了,接着办'))
  })

  it('「我自己说」:打一句回车就交,单选时只交他那句', async () => {
    const { impl, calls } = stub()
    render(<QuestionAsk question={QUESTION} baseUrl={BASE} fetchImpl={impl} />)
    await userEvent.type(screen.getByLabelText('我自己说'), '你自己能修吗,这其实属于你自己的界面{Enter}')
    await waitFor(() => expect(calls[0]?.body).toEqual({ id: 'q-1', answers: [{ id: 'confirm_avatar_clip', selected: [], custom: '你自己能修吗,这其实属于你自己的界面' }] }))
  })

  it('没交上(已经答过 / 服务端不收):原话摆出来', async () => {
    const { impl } = stub(() => ({ status: 409, body: { error: '这一问已经答过了,或者事务官已经不等了' } }))
    render(<QuestionAsk question={QUESTION} baseUrl={BASE} fetchImpl={impl} />)
    await userEvent.click(screen.getByRole('button', { name: /都对,但你自己做/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('这一问已经答过了')
  })

  it('两问 / 多选:点好了按「回复」一起交', async () => {
    const { impl, calls } = stub()
    const two: PendingQuestionView = {
      ...QUESTION,
      questions: [
        { id: 'a', question: '先做哪个?', multi: false, options: [{ label: 'x', text: 'x' }, { label: 'y', text: 'y' }] },
        { id: 'b', question: '哪几家?', multi: true, options: [{ label: 'Codex', text: 'Codex' }, { label: 'Kimi', text: 'Kimi' }] },
      ],
    }
    render(<QuestionAsk question={two} baseUrl={BASE} fetchImpl={impl} />)
    await userEvent.click(screen.getByRole('button', { name: 'y' }))
    await userEvent.click(screen.getByRole('button', { name: 'Codex' }))
    await userEvent.click(screen.getByRole('button', { name: 'Kimi' }))
    expect(calls).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: '回复' }))
    await waitFor(() => expect(calls[0]?.body).toEqual({ id: 'q-1', answers: [{ id: 'a', selected: ['y'] }, { id: 'b', selected: ['Codex', 'Kimi'] }] }))
  })

  it('收成一行:「「…」问你:派活前对一遍 · 展开」', async () => {
    const onExpand = vi.fn()
    render(<QuestionAsk question={QUESTION} baseUrl={BASE} fetchImpl={stub().impl} variant="row" onExpand={onExpand} />)
    expect(screen.getByText(questionRowText(QUESTION))).toBeInTheDocument()
    expect(questionRowText(QUESTION)).toBe('「这个有点问题,你看三张卡片的左上…」问你:派活前对一遍')
    await userEvent.click(screen.getByRole('button', { name: '展开' }))
    expect(onExpand).toHaveBeenCalled()
  })
})

describe('她要你批的事(ApprovalAsk)说人话', () => {
  it('要做什么、为什么、放开到多大;底层原话收在「看原始」里', async () => {
    const { container } = render(<ApprovalAsk approval={APPROVAL} baseUrl={BASE} fetchImpl={stub().impl} />)
    expect(screen.getByText('要开一个看不见的浏览器,把页面截下来看')).toBeInTheDocument()
    expect(screen.getByText(/为什么:看不见的浏览器/)).toBeInTheDocument()
    expect(screen.getByText(/这一条要能改这台电脑上的任何文件/)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(INTERNAL)
    await userEvent.click(screen.getByRole('button', { name: '看原始' }))
    expect(screen.getByLabelText('原始请求(开发者用)')).toHaveTextContent('escalate sandbox to danger-full-access')
  })

  it('「这件事里开看不见的浏览器截图都允许」→ POST scope:kind;回执说清以后不再问、能收回', async () => {
    const { impl, calls } = stub(() => ({ body: { ok: true, granted: '开看不见的浏览器截图', merged: 1 } }))
    const onReceipt = vi.fn()
    render(<ApprovalAsk approval={APPROVAL} baseUrl={BASE} fetchImpl={impl} onReceipt={onReceipt} />)
    await userEvent.click(screen.getByRole('button', { name: '这件事里开看不见的浏览器截图都允许' }))
    await waitFor(() => expect(calls[0]).toEqual({ path: '/approvals/answer', method: 'POST', body: { id: 'a-1', allow: true, scope: 'kind' } }))
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith('记下了:这件事里开看不见的浏览器截图都允许,同类的另外 1 条也一起放行了。后面同类的不再问你,在这件事里能收回。'))
  })

  it('分不出类的那一条没有第三颗键;老服务没有人话时退回原话', () => {
    const { reason: _r, say: _s, why: _w, scope: _c, kind: _k, raw: _raw, ...old } = APPROVAL
    render(<ApprovalAsk approval={{ ...old, reason: '要写 /etc/hosts' }} baseUrl={BASE} fetchImpl={stub().impl} />)
    expect(screen.getByText('要写 /etc/hosts')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /都允许/ })).toBeNull()
  })
})

describe('球下那一区:她问的、要批的排最前面;「等你 n」是同一个数', () => {
  function inboxProps(state: WorkbenchState, fetchImpl: typeof fetch) {
    return {
      state, baseUrl: BASE, fetchImpl, onOpenConversation: vi.fn(), draft: '', onDraftChange: vi.fn(), visible: true,
      controls: { paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] },
    }
  }

  it('提问一张、审批一张都在球下;点「都对,开工」直接交', async () => {
    const { impl, calls } = stub()
    const { container } = render(<ButlerInbox {...inboxProps(baseState({ questions: [QUESTION], approvals: [APPROVAL] }), impl)} />)
    const asks = [...container.querySelectorAll('.ben-wb__ask')].map(one => one.getAttribute('data-ask'))
    expect(asks.slice(0, 2)).toEqual(['question:q-1', 'approval:a-1'])
    await userEvent.click(screen.getByRole('button', { name: /都对,开工\(推荐\)/ }))
    await waitFor(() => expect(calls.some(call => call.path === '/questions/answer')).toBe(true))
  })

  it('「等你 n」= 她问你的 + 要你批的 + 办完了等你确认的(同一堆,见 tests/waiting-pile.test.tsx)', () => {
    const state = baseState({
      questions: [QUESTION],
      approvals: [APPROVAL],
      tasks: { tasks: [{ id: 't-9', title: '已经办完的', status: 'confirm', direction: 'mine', source: { kind: 'manual' }, created_at: 'x', updated_at: 'x', owner_ask: { kind: 'spend' as const, proposal: '买这个', basis: '核过的事实', by: 'butler', at: 'x' } }], sprints: [], modules: [], project_meta: [] },
      butler_inbox: { items: [{ id: 'confirm:t-9', kind: 'confirm', title: '已经办完的', status: 'confirm', task_id: 't-9' }] },
      sessions: [{ agent: 'dsh', session_id: 'session-07ed', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'x' }],
    })
    render(<ButlerInbox {...inboxProps(state, stub().impl)} />)
    expect(screen.getByText(/等你 3/, { selector: '.ben-wb__orb-counts' })).toBeInTheDocument()
    const pile = waitingOnHim(state)
    expect(pile.count).toBe(3)
    expect(pile.items.map(item => item.text)).toEqual([
      questionRowText(QUESTION),
      '「这个有点问题,你看三张卡片的左上…」要你批:要开一个看不见的浏览器,把页面截下来看',
      '「已经办完的」办完了,等你确认',
    ])
  })

  it('★她在等他答时球下说「等你回答」,不说「文字输入中」「正在执行」(卡 M 补,统筹真壳)', () => {
    const state = baseState({ questions: [QUESTION], sessions: [{ agent: 'dsh', session_id: 'session-07ed', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'x' }] })
    const { container } = render(<ButlerInbox {...inboxProps(state, stub().impl)} draft="我在打字" />)
    expect(container.querySelector('.ben-wb__particle-mode')?.textContent).toBe('等你回答')
    expect(orbStatusLine({ questions: 0, approvals: 1, typing: true, focusRunning: false, running: 1 })).toBe('等你批一件事')
    expect(orbStatusLine({ questions: 0, approvals: 0, typing: true, focusRunning: false, running: 1 })).toBe('文字输入中')
    expect(orbStatusLine({ questions: 0, approvals: 0, typing: false, focusRunning: false, running: 2 })).toBe('正在执行 2 件')
    expect(orbStatusLine({ preview: '说话', questions: 1, approvals: 0, typing: false, focusRunning: false, running: 0 })).toBe('说话')
  })

  it('★系统通知没弹出来(卡 M 补):事务官说一句人话、给一键去「系统设置 → 通知」;不进「等你」的数', () => {
    const state = baseState({ helper: { connected: true, authorized: true, notify: { permission: 'denied', last_post: { key: 'question:q-1', at: 'x', ok: false, error: '系统没让工作台发通知' } } } })
    const { container } = render(<ButlerInbox {...inboxProps(state, stub().impl)} />)
    expect(screen.getByText('系统没让我弹通知:去系统设置 → 通知里打开「工作台」')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '打开通知设置' })).toHaveAttribute('href', 'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=ai.ben.workbench')
    expect(container.querySelector('.ben-wb__orb-counts')?.textContent).toContain('等你 0')
    expect(butlerConclusions(state, 0)[0]).toBe('系统没让我弹通知:去系统设置 → 通知里打开「工作台」')
  })

  it('点了气泡 / 系统通知(focusAsk):「要你看的」整张摊开', async () => {
    const props = inboxProps(baseState({ questions: [QUESTION] }), stub().impl)
    const { rerender } = render(<ButlerInbox {...props} />)
    expect(screen.queryByRole('dialog', { name: '要你看的' })).toBeNull()
    rerender(<ButlerInbox {...props} focusAsk={{ key: 'question:q-1', at: 1 }} />)
    const sheet = await screen.findByRole('dialog', { name: '要你看的' })
    expect(within(sheet).getByText(/派活之前先跟你对一遍/)).toBeInTheDocument()
  })
})

describe('点开一件事:在工作台里看,不跳到 DSH 原始界面(ItemTalk)', () => {
  const TURNS = [
    { role: 'user', text: '这个有点问题,你看安排谁做一下\n\n这件按「先问我」办:要派给别家、或者要动他的文件,先把你的理解复述成 2–4 个确认点问他\n他附了文件(都在这台电脑上):\n- /Users/example/Documents/事务官/收件/截图.png\n\n(工作台事项 t-a8934b2a)要背景时再按 .dsh/skills/记忆/SKILL.md 查', at: '2026-09-25T05:46:24.000Z' },
    { role: 'assistant', text: '**行**,我先看一眼截图。', at: '2026-09-25T05:47:00.000Z' },
  ]

  it('在等他:状态一行 + 那一问就在这里答;对话只留他的原话;最底下「看原始对话」才切过去', async () => {
    const { impl, calls } = stub(path => (path.endsWith('/turns') ? { body: { session_id: 'session-07ed', turns: TURNS } } : { body: { ok: true } }))
    const onOpenRaw = vi.fn()
    const state = baseState({
      questions: [QUESTION],
      sessions: [{ agent: 'dsh', session_id: 'session-07ed', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'x' }],
    })
    const { container } = render(<ItemTalk state={state} taskId="t-a8934b2a" sessionId="session-07ed" version="v1" baseUrl={BASE} fetchImpl={impl} onOpenRaw={onOpenRaw} />)
    expect(screen.getByText('停下来在等你回答')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /都对,开工\(推荐\)/ })).toBeInTheDocument()
    expect(await screen.findByText('这个有点问题,你看安排谁做一下')).toBeInTheDocument()
    expect(screen.getByText('行,我先看一眼截图。')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/这件按「先问我」办|工作台事项|SKILL\.md|收件\/截图/)
    expect(container.textContent).not.toMatch(INTERNAL)
    expect(calls[0]).toMatchObject({ path: '/butler/item/t-a8934b2a/turns', method: 'GET' })
    await userEvent.click(screen.getByRole('button', { name: '看原始对话' }))
    expect(onOpenRaw).toHaveBeenCalledWith('session-07ed')
  })

  it('这件事里允许过的那一类:写出来、能收回', async () => {
    const { impl, calls } = stub(path => (path.endsWith('/turns') ? { body: { session_id: 's', turns: [] } } : { body: { ok: true } }))
    const onReceipt = vi.fn()
    render(<ItemTalk
      state={baseState({ approval_grants: [{ session_id: 's', task_id: 't', key: 'browser', title: '开看不见的浏览器截图', allowed: 2, at: 'x' }] })}
      taskId="t" sessionId="s" version="v" baseUrl={BASE} fetchImpl={impl} onReceipt={onReceipt}
    />)
    expect(screen.getByText('这件事里你允许过:开看不见的浏览器截图(已放行 2 次)')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '收回' }))
    // 记在这件事上的按事项收回(卡 M 追加:落盘、只对这件事有效);会话也带上(老服务只认它)。
    await waitFor(() => expect(calls.find(call => call.path === '/approvals/grant/revoke')?.body).toEqual({ session_id: 's', key: 'browser', task_id: 't' }))
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith('收回了:同类的又会一条条问你'))
  })

  it('事务官重启过(对话只在内存里):如实说一句', async () => {
    const { impl } = stub(() => ({ status: 404, body: { error: '没有这个会话' } }))
    render(<ItemTalk state={baseState()} taskId="t" sessionId="s" version="v" baseUrl={BASE} fetchImpl={impl} />)
    expect(await screen.findByText('这段对话在事务官上次重启之前,这里看不到了。')).toBeInTheDocument()
  })

  it('hisWords:只留他的原话', () => {
    expect(hisWords(TURNS[0]!.text)).toBe('这个有点问题,你看安排谁做一下')
    expect(hisWords('就一句')).toBe('就一句')
  })
})

describe('「事务官」标签上的气泡', () => {
  it('有等他的就出一个数(与「等你 n」同一个数);点它 = 切过来并摊开', async () => {
    const onOpen = vi.fn()
    render(<DockTabBar
      dock={undefined} sessions={[]} badges={{}} baseUrl={BASE} fetchImpl={stub().impl} butlerActive={false} onSelectButler={vi.fn()} dwellReadMs={undefined}
      butlerWaiting={{ count: 2, lines: ['「x」问你:派活前对一遍', '「y」要你批:要跑一条命令'], onOpen }}
    />)
    const dot = screen.getByRole('button', { name: '看等你的 2 件' })
    expect(dot).toHaveTextContent('2')
    await userEvent.click(dot)
    expect(onOpen).toHaveBeenCalled()
  })

  it('那一格贴着顶(左栏最上头):气泡朝下开,不顶出屏幕;下面那些标签照旧朝上开', () => {
    const rectAt = (top: number) => ({ top, bottom: top + 16, left: 150, right: 166, width: 16, height: 16, x: 150, y: top, toJSON: () => ({}) }) as DOMRect
    const lines = ['「x」问你:派活前对一遍', '「y」要你批:要跑一条命令']
    render(<DockTabBar
      dock={undefined} sessions={[]} badges={{}} baseUrl={BASE} fetchImpl={stub().impl} butlerActive={false} onSelectButler={vi.fn()} dwellReadMs={undefined}
      butlerWaiting={{ count: 2, lines, onOpen: vi.fn() }}
    />)
    const dot = screen.getByRole('button', { name: '看等你的 2 件' })
    const holder = dot.closest('.ben-wb__dock-badge')!
    const spy = vi.spyOn(dot, 'getBoundingClientRect').mockReturnValue(rectAt(40))
    fireEvent.mouseEnter(holder)
    let bubble = holder.querySelector<HTMLElement>('.ben-wb__dock-badge-bubble')!
    expect(bubble.style.top).toBe('62px')
    expect(bubble.style.bottom).toBe('auto')
    fireEvent.mouseLeave(holder)
    spy.mockReturnValue(rectAt(600))
    fireEvent.mouseEnter(holder)
    bubble = holder.querySelector<HTMLElement>('.ben-wb__dock-badge-bubble')!
    expect(bubble.style.top).toBe('')
    expect(bubble.style.bottom).toBe(`${window.innerHeight - 600 + 6}px`)
  })

  it('0 件不画', () => {
    render(<DockTabBar
      dock={undefined} sessions={[]} badges={{}} baseUrl={BASE} fetchImpl={stub().impl} butlerActive={false} onSelectButler={vi.fn()} dwellReadMs={undefined}
      butlerWaiting={{ count: 0, lines: [], onOpen: vi.fn() }}
    />)
    expect(screen.queryByRole('button', { name: /看等你的/ })).toBeNull()
  })
})

describe('DSH 原始界面上的「‹ 回工作台」', () => {
  it('醒目的一颗,点了就回来', async () => {
    const onReturn = vi.fn()
    render(<ReturnToWorkbench onReturn={onReturn} />)
    await userEvent.click(screen.getByRole('button', { name: '回工作台' }))
    expect(onReturn).toHaveBeenCalled()
  })
})

describe('右下角那个小浮窗的第一句', () => {
  it('有在等他的一问 / 一条要批的:先说它,不再写「一切正常」', () => {
    const lines = butlerConclusions(baseState({ questions: [QUESTION], approvals: [APPROVAL] }), 0)
    expect(lines.slice(0, 2)).toEqual([questionRowText(QUESTION), '「这个有点问题,你看三张卡片的左上…」要你批:要开一个看不见的浏览器,把页面截下来看'])
  })
})
