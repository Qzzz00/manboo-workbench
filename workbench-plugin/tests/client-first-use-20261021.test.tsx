/**
 * 首次引导「装 → 认识 → 第一次有用」的电脑那一头(2026-10-21,卡「引导三件事」;设计稿第二节):
 *   · 事务官出场之前先问一句「想先试哪一件」,答了那一件排第一位;
 *   · 五问走完不直接进工作台:先「第一次有用」—— 三件各成一次才收尾「三样都通了,剩下的用到时我再问」;
 *     哪一件没成写清缺哪道门(一颗键或一句怎么办),每件都试过 / 缺门写清了才给先进工作台;
 *   · 没配手机的人,第三件换成在电脑上对她说一句;
 *   · 首页那张「现在能做什么」:三件主路各一行、实验里的几样标「内测中」。
 * 服务端没给 `first_use`(老工作台)时一切照旧(老用例钉着)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityCard } from '../src/client/CapabilityCard.tsx'
import { FirstUseStep, FIRST_USE_MISSING } from '../src/client/firstrun/FirstUseStep.tsx'
import { FirstRunFlow } from '../src/client/firstrun/FirstRunFlow.tsx'
import { FIRST_TRY_ASK, FIRST_USE_SAY, doorView, type FirstUsePathView, type FirstUseView, type MainPath } from '../src/mainPaths.ts'
import type { WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)

function path(one: MainPath, patch: Partial<FirstUsePathView> = {}): FirstUsePathView {
  const titles = { morning: '早报与播客', delegate: '交代一件事', call: '打个电话' }
  return { path: one, title: titles[one], state: 'todo', say: FIRST_USE_SAY[one], oks: 0, fails: 0, ...patch }
}

function firstUse(patch: Partial<FirstUseView> = {}): FirstUseView {
  return {
    order: ['morning', 'delegate', 'call'],
    call_mode: 'phone',
    paths: [path('morning'), path('delegate'), path('call')],
    day0: '2026-10-21',
    ...patch,
  }
}

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: '2026-10-21T10:00:00+08:00', stale: false, ...over }
}

interface Call { url: string, method: string, body?: Record<string, unknown> }

function fakeServer() {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const at = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? ''
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ url: at, method: init?.method ?? 'GET', ...(body === undefined ? {} : { body }) })
    const ok = (payload: unknown): Response => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
    if (at === '/setup/apk.json') return ok({ available: false, path: '/x', hint: '还没出过包' })
    if (at === '/first-use/try' && body?.path === 'delegate') return ok({ ok: true, id: 't1', family: 'codex', note: '交给 Codex 了,回来的结果会写在那张卡上,手机上也看得到。' })
    if (at === '/first-use/try') return ok({ ok: true, note: 'x' })
    if (at === '/butler/item') return ok({ ok: true, id: 't2' })
    if (at === '/agents/login') return ok({ ok: true, note: '登录窗口开了' })
    if (at === '/onboarding') return ok({ stage: 'done', done: true })
    if (init?.method === 'POST') return ok({ ok: true })
    return ok({})
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function flow(state: WorkbenchState, over: { initialStep?: Parameters<typeof FirstRunFlow>[0]['initialStep'], onDone?: () => void } = {}) {
  const server = fakeServer()
  const view = render(
    <FirstRunFlow
      baseUrl="http://x"
      fetchImpl={server.fetchImpl}
      state={state}
      onDone={over.onDone ?? (() => {})}
      turnsPollMs={0}
      {...(over.initialStep === undefined ? {} : { initialStep: over.initialStep })}
    />,
  )
  return { ...server, view }
}

describe('五问前那一问:想先试哪一件', () => {
  it('事务官出场之前先问;答了记下那一件,再往下走到分岔那两颗', async () => {
    const t = flow(snapshot({ first_use: firstUse() }), { initialStep: 'intro' })
    expect(await screen.findByText(FIRST_TRY_ASK)).toBeTruthy()
    expect(screen.getByRole('button', { name: '早报' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '交代一件事' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '交代一件事' }))
    expect(await screen.findByRole('button', { name: '已经有在做的事' })).toBeTruthy()
    expect(t.calls).toContainEqual({ url: '/first-use/prefer', method: 'POST', body: { path: 'delegate' } })
  })

  it('「都行,你定」= 不选,按早报 → 交代 → 电话', async () => {
    const t = flow(snapshot({ first_use: firstUse() }), { initialStep: 'intro' })
    await userEvent.click(await screen.findByRole('button', { name: '都行,你定' }))
    expect(await screen.findByRole('button', { name: '从一个新点子开始' })).toBeTruthy()
    expect(t.calls).toContainEqual({ url: '/first-use/prefer', method: 'POST', body: { path: '都行' } })
  })

  it('答过了(手机上 / 上一次)就不再问', async () => {
    flow(snapshot({ first_use: firstUse({ prefer: 'delegate', asked_at: '2026-10-21T01:00:00.000Z' }) }), { initialStep: 'intro' })
    expect(await screen.findByRole('button', { name: '已经有在做的事' })).toBeTruthy()
    expect(screen.queryByText(FIRST_TRY_ASK)).toBeNull()
  })
})

describe('第一次有用:三件各成一次才算引导结束', () => {
  const done = { stage: 'done' as const, done: true }

  it('五问走完不直接进工作台,先「第一次有用」;第一件是她选的那件', async () => {
    const onDone = vi.fn()
    const state = snapshot({ onboarding: done, first_use: firstUse({ prefer: 'delegate', order: ['delegate', 'morning', 'call'], paths: [path('delegate'), path('morning'), path('call')] }) })
    flow(state, { initialStep: 'intro', onDone })
    const list = await screen.findByRole('list', { name: '电脑两件事' })
    expect([...list.querySelectorAll('li')].map(one => one.getAttribute('data-path'))).toEqual(['delegate', 'morning'])
    expect(screen.getByText(FIRST_USE_SAY.delegate)).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('早报:点一下现跑一份', async () => {
    const t = flow(snapshot({ onboarding: done, first_use: firstUse() }), { initialStep: 'intro' })
    await userEvent.click(await screen.findByRole('button', { name: '出一份早报' }))
    expect(t.calls).toContainEqual({ url: '/first-use/try', method: 'POST', body: { path: 'morning' } })
  })

  it('交代:她写一件交出去;没想好就让它介绍这个项目', async () => {
    const state = snapshot({ onboarding: done, first_use: firstUse({ paths: [path('morning', { state: 'ok' }), path('delegate'), path('call')] }) })
    const t = flow(state, { initialStep: 'intro' })
    await userEvent.type(await screen.findByRole('textbox', { name: '交代一件事' }), '把下周的选题列出来')
    await userEvent.click(screen.getByRole('button', { name: '交给它' }))
    expect(t.calls).toContainEqual({ url: '/first-use/try', method: 'POST', body: { path: 'delegate', text: '把下周的选题列出来' } })
    expect(await screen.findByText(/交给 Codex 了/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '没想好,介绍一下这个项目' }))
    expect(t.calls.filter(one => one.url === '/first-use/try' && one.body?.path === 'delegate')).toHaveLength(2)
  })

  it('交代那一件缺登录:说清「先登录 Claude 或 Codex 其中一家」,给一颗键', async () => {
    const door = doorView('ai_login', { families: [{ family: 'claude', title: 'Claude' }] })
    const state = snapshot({ onboarding: done, first_use: firstUse({ paths: [path('morning', { state: 'ok' }), path('delegate', { state: 'missing', door }), path('call')] }) })
    const t = flow(state, { initialStep: 'intro' })
    expect(await screen.findByText(/先登录 Claude 或 Codex 其中一家/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '登录 Claude' }))
    expect(t.calls).toContainEqual({ url: '/agents/login', method: 'POST', body: { family: 'claude' } })
  })

  it('电话(配着手机):「手机上拨给我一下」,点了「我这就拨」才开始等', async () => {
    const state = snapshot({ onboarding: done, first_use: firstUse({ paths: [path('morning', { state: 'ok' }), path('delegate', { state: 'ok' }), path('call')] }) })
    const t = fakeServer()
    render(<FirstUseStep view={state.first_use!} baseUrl="http://x" fetchImpl={t.fetchImpl} onFinish={() => {}} />)
    expect(await screen.findByText(FIRST_USE_SAY.call)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '我这就拨' }))
    expect(t.calls).toContainEqual({ url: '/first-use/try', method: 'POST', body: { path: 'call' } })
  })

  it('没配手机(iPhone / 没手机):第三件换成在电脑上对她说一句', async () => {
    const state = snapshot({
      onboarding: done,
      first_use: firstUse({ call_mode: 'desk', paths: [path('morning', { state: 'ok' }), path('delegate', { state: 'ok' }), path('call', { say: FIRST_USE_SAY.call_desk })] }),
    })
    const t = fakeServer()
    render(<FirstUseStep view={state.first_use!} baseUrl="http://x" fetchImpl={t.fetchImpl} onFinish={() => {}} />)
    expect(await screen.findByText(FIRST_USE_SAY.call_desk)).toBeTruthy()
    await userEvent.type(screen.getByRole('textbox', { name: '对事务官说一句' }), '周五提醒我交报销')
    await userEvent.click(screen.getByRole('button', { name: '记下' }))
    expect(t.calls).toContainEqual({ url: '/butler/item', method: 'POST', body: { text: '周五提醒我交报销' } })
  })

  it('在这一屏上三样都成了:收尾那一句,点了才进工作台(写旗子)', async () => {
    const onDone = vi.fn()
    const state = snapshot({
      onboarding: done,
      first_use: firstUse({ closed_at: '2026-10-21T03:00:00.000Z', paths: [path('morning', { state: 'ok' }), path('delegate', { state: 'ok' }), path('call', { state: 'ok' })] }),
    })
    const t = flow(state, { initialStep: 'firstuse', onDone })
    expect(await screen.findByText('电脑上的两件事已经做成。')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '继续' }))
    await userEvent.click(await screen.findByRole('button', { name: '稍后再配，进工作台' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(t.calls).toContainEqual({ url: '/first-run', method: 'POST', body: { done: true } })
  })

  it('还有一件没试过:不给先进工作台;每件都试过或缺门写清了才给,而且不说「都好了」', async () => {
    const door = doorView('phone')
    const first = flow(snapshot({ onboarding: done, first_use: firstUse({ paths: [path('morning', { state: 'ok' }), path('delegate'), path('call', { state: 'missing', door })] }) }), { initialStep: 'intro' })
    await screen.findByRole('list', { name: '电脑两件事' })
    expect(screen.queryByRole('button', { name: /先进工作台/ })).toBeNull()
    first.view.unmount()

    flow(snapshot({ onboarding: done, first_use: firstUse({ paths: [path('morning', { state: 'ok' }), path('delegate', { state: 'ok' }), path('call', { state: 'missing', door })] }) }), { initialStep: 'intro' })
    expect(await screen.findByRole('button', { name: '继续' })).toBeTruthy()
    expect(screen.queryByText(/都好了/)).toBeNull()
  })
})

describe('三样早就都成过(重走一遍首次流程)', () => {
  it('五问走完照旧直接进工作台,不再走一遍第一次有用', async () => {
    const onDone = vi.fn()
    const state = snapshot({
      onboarding: { stage: 'done', done: true },
      first_use: firstUse({ closed_at: '2026-10-21T03:00:00.000Z', paths: [path('morning', { state: 'ok' }), path('delegate', { state: 'ok' }), path('call', { state: 'ok' })] }),
    })
    flow(state, { initialStep: 'intro', onDone })
    await userEvent.click(await screen.findByRole('button', { name: '稍后再配，进工作台' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })
})

describe('首页那张「现在能做什么」', () => {
  it('三件主路各一行(没成的写缺哪道门、给键),实验里的几样标「内测中」', async () => {
    const server = fakeServer()
    const state = snapshot({
      first_use: firstUse({ paths: [path('morning', { state: 'ok' }), path('delegate', { state: 'missing', door: doorView('ai_login', { families: [{ family: 'codex', title: 'Codex' }] }) }), path('call')] }),
      experiments: { audience: 'external', on: { video: true, meeting: false, handset: false, window_dispatch: false } },
    })
    render(<CapabilityCard state={state} baseUrl="http://x" fetchImpl={server.fetchImpl} />)
    const card = screen.getByRole('region', { name: '现在能做什么' })
    expect(card).toHaveTextContent('早报与播客')
    expect(card).toHaveTextContent('通了')
    expect(card).toHaveTextContent('缺一步:没登录 Claude 或 Codex')
    expect(card).toHaveTextContent('还没试过')
    expect(card).toHaveTextContent('视频(豆包出图 → 可灵出片)')
    expect(card).toHaveTextContent('内测中 · 没开')
    await userEvent.click(screen.getByRole('button', { name: '登录 Codex' }))
    expect(server.calls).toContainEqual({ url: '/agents/login', method: 'POST', body: { family: 'codex' } })
  })

  it('老工作台没给这一格:整张不出', () => {
    const server = fakeServer()
    const view = render(<CapabilityCard state={snapshot()} baseUrl="http://x" fetchImpl={server.fetchImpl} />)
    expect(view.container).toBeEmptyDOMElement()
  })

  it('点「收起」整张撤掉,本机记着:下次再摆也不出(2026-10-28 维护者「能去掉吗」)', async () => {
    const { readCapabilityDismissed } = await import('../src/client/CapabilityCard.tsx')
    globalThis.localStorage?.removeItem('ben-wb:capability:dismissed')
    try {
      const server = fakeServer()
      const state = snapshot({ first_use: firstUse({ paths: [path('morning', { state: 'ok' }), path('delegate', { state: 'ok' }), path('call')] }) })
      const first = render(<CapabilityCard state={state} baseUrl="http://x" fetchImpl={server.fetchImpl} />)
      expect(screen.getByRole('region', { name: '现在能做什么' })).toBeTruthy()
      await userEvent.click(screen.getByRole('button', { name: '收起' }))
      expect(first.container).toBeEmptyDOMElement()
      expect(readCapabilityDismissed()).toBe(true)
      first.unmount()
      const again = render(<CapabilityCard state={state} baseUrl="http://x" fetchImpl={server.fetchImpl} />)
      expect(again.container).toBeEmptyDOMElement()
    } finally {
      globalThis.localStorage?.removeItem('ben-wb:capability:dismissed')
    }
  })
})

describe('设置里的实验开关', () => {
  it('四样一样一行,勾一下打 POST /experiments;关着时那一句写在说明里', async () => {
    const { ExperimentsPanel } = await import('../src/client/ExperimentsPanel.tsx')
    const server = fakeServer()
    render(<ExperimentsPanel view={{ audience: 'external', on: { video: false, meeting: false, handset: false, window_dispatch: false } }} baseUrl="http://x" fetchImpl={server.fetchImpl} />)
    expect(screen.getByText(/这一类还在内测,我先不接/)).toBeTruthy()
    await userEvent.click(screen.getByRole('checkbox', { name: '会议录音转纪要' }))
    expect(server.calls).toContainEqual({ url: '/experiments', method: 'POST', body: { key: 'meeting', on: true } })
  })
})

describe('第一次有用那一屏自己说清在干什么', () => {
  it('看得见的标题 + 几件通了', async () => {
    const { FirstUseStep, FIRST_USE_TITLE } = await import('../src/client/firstrun/FirstUseStep.tsx')
    const server = fakeServer()
    render(<FirstUseStep view={firstUse({ paths: [path('morning', { state: 'ok' }), path('delegate'), path('call')] })} baseUrl="http://x" fetchImpl={server.fetchImpl} onFinish={() => {}} />)
    expect(screen.getByRole('heading', { name: FIRST_USE_TITLE })).toBeTruthy()
    expect(screen.getByText(/通了 1 \/ 3/)).toBeTruthy()
  })
})

describe('真机走一遍撞出来的两处(2026-10-21 隔离实例)', () => {
  it('先打招呼再问「想先试哪一件」', async () => {
    flow(snapshot({ first_use: firstUse() }), { initialStep: 'intro' })
    expect(await screen.findByText('你好,很高兴认识你,我是你的专属事务官。')).toBeTruthy()
    expect(screen.getByText(FIRST_TRY_ASK)).toBeTruthy()
  })

  it('排第一的那件缺一道门(没登录):不卡住,下一件照样能试;缺门那件的登录键还在', async () => {
    const door = doorView('ai_login', { families: [{ family: 'claude', title: 'Claude' }] })
    const state = snapshot({
      onboarding: { stage: 'done', done: true },
      first_use: firstUse({ prefer: 'delegate', order: ['delegate', 'morning', 'call'], paths: [path('delegate', { state: 'missing', door }), path('morning'), path('call')] }),
    })
    flow(state, { initialStep: 'intro' })
    expect(await screen.findByRole('button', { name: '出一份早报' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '登录 Claude' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '交给它' })).toBeNull()
  })
})

describe('招呼只打一次', () => {
  it('答完「想先试哪一件」,出场那一屏不再说「你好…」,只问从哪儿开始', async () => {
    flow(snapshot({ first_use: firstUse() }), { initialStep: 'intro' })
    await userEvent.click(await screen.findByRole('button', { name: '早报' }))
    expect(await screen.findByText('好。我们从哪儿开始?')).toBeTruthy()
    expect(screen.queryByText('你好,很高兴认识你,我是你的专属事务官。')).toBeNull()
  })
})

describe('那一句话跟着「现在轮到哪一件」', () => {
  it('前两件都缺门:说明电脑待补项，电话不挡主路', async () => {
    const state = snapshot({
      onboarding: { stage: 'done', done: true },
      first_use: firstUse({ call_mode: 'desk', paths: [path('delegate', { state: 'missing', door: doorView('ai_login') }), path('morning', { state: 'missing', door: doorView('model') }), path('call', { say: FIRST_USE_SAY.call_desk })] }),
    })
    flow(state, { initialStep: 'intro' })
    expect(await screen.findByText(FIRST_USE_MISSING, { selector: '.ben-wb__firstrun-say' })).toBeTruthy()
  })
})

describe('首页卡收成一行时', () => {
  it('那一句说「现在能做什么:通了 n / 3」', async () => {
    const { capabilityRowText } = await import('../src/client/CapabilityCard.tsx')
    expect(capabilityRowText(firstUse({ paths: [path('morning', { state: 'ok' }), path('delegate'), path('call')] }))).toBe('现在能做什么:通了 1 / 3')
  })
})
