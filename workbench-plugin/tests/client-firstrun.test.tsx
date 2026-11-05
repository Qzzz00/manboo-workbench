/** 电脑引导、旧手机会话兼容、末尾可选配对及工作台完成标记回归。 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FirstRunFlow } from '../src/client/firstrun/FirstRunFlow.tsx'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import { STYLE } from '../src/client/style.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'
import { GROUP, openGroup } from './settingsGroup.ts'

afterEach(cleanup)

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: '2026-09-17T10:00:00+08:00', stale: false, ...over }
}

interface Call { url: string, method: string, body?: Record<string, unknown> }

function fakeServer(options: {
  apk?: { available: boolean, path: string, url?: string, hint?: string, source?: 'cloud' | 'lan', version?: string, size?: number }
  /** /onboarding 回的阶段。 */
  stage?: string
  nickname?: string
  sessionFails?: string
  /** /onboarding/answer 回 400 带这句(阶段机不收)。 */
  answerFails?: string
  turns?: { seq: number, role: string, text: string, kind?: string }[]
  /** /onboarding/turns 回包上多出来的几格(busy、failed、scan、stage…)。 */
  turnsExtra?: Record<string, unknown>
  state?: WorkbenchState
  /** 账号与首次流程(给整屏那几条用例)。 */
  account?: { registered: boolean, logged_in: boolean, username?: string }
  firstRunDoneAt?: string
} = {}) {
  const calls: Call[] = []
  let firstRunDoneAt = options.firstRunDoneAt
  // 阶段机的一个小影子(2026-09-24):交了称呼到分岔、交了分岔到布局;交错了阶段照真的那样 409。
  let stage = options.stage ?? 'opening'
  let nickname = options.nickname
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? ''
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ url: path, method: init?.method ?? 'GET', ...(body === undefined ? {} : { body }) })
    const ok = (payload: unknown): Response => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
    const bad = (status: number, error: string): Response =>
      ({ ok: false, status, json: async () => ({ error }) }) as unknown as Response

    if (path === '/setup/apk.json') return ok(options.apk ?? { available: false, path: '/x', hint: '还没出过包' })
    if (path === '/account') {
      return options.account === undefined ? bad(404, '账号未启用') : ok(options.account)
    }
    if (path === '/first-run') {
      if (init?.method === 'POST') {
        firstRunDoneAt = body?.done === true ? '2026-09-17T10:00:00.000Z' : undefined
        return ok({ ok: true, ...(firstRunDoneAt === undefined ? {} : { done_at: firstRunDoneAt }) })
      }
      return ok(firstRunDoneAt === undefined ? {} : { done_at: firstRunDoneAt })
    }
    if (path === '/onboarding/session') {
      if (options.sessionFails !== undefined) return bad(409, options.sessionFails)
      return ok({ stage, session_id: 's1', first_message: 'x', seed: '开场', resumed: stage !== 'opening' })
    }
    if (path === '/onboarding') {
      return ok({ stage, done: false, ...(nickname === undefined ? {} : { nickname }) })
    }
    if (path === '/onboarding/answer') {
      if (options.answerFails !== undefined) return bad(400, options.answerFails)
      if (body?.key === 'nickname' && stage === 'opening') { nickname = String(body.value); stage = 'branch' }
      else if (body?.key === 'mode' && stage === 'branch') stage = 'template'
      else return bad(409, `现在在 ${stage},不能答 ${String(body?.stage)}.${String(body?.key)}`)
      return ok({ ok: true, stage, advanced: true, done: false })
    }
    if (path === '/onboarding/turns') {
      return ok({ turns: options.turns ?? [], busy: false, ended: false, stage: 'branch', done: false, seed: '你现在是已经有在做的事,还是想从一个新点子开始?', ...options.turnsExtra })
    }
    if (path === '/onboarding/say') return ok({ ok: true, session_id: 's1' })
    if (path === '/setup/status') return ok({ items: [], all_ok: true, optional_pending: 0, checked_at: '2026-09-17T10:00:00.000Z' })
    if (path.startsWith('/config/')) return bad(404, 'x')
    if (init?.method === 'POST') return ok({ ok: true })
    return ok(options.state ?? snapshot())
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function flow(server: ReturnType<typeof fakeServer>, over: Partial<Parameters<typeof FirstRunFlow>[0]> = {}) {
  return render(
    <FirstRunFlow
      baseUrl="http://x"
      fetchImpl={server.fetchImpl}
      state={over.state ?? snapshot()}
      onDone={over.onDone ?? (() => {})}
      turnsPollMs={0}
      {...(over.initialStep === undefined ? {} : { initialStep: over.initialStep })}
    />,
  )
}

function props(fetchImpl: typeof fetch, state: WorkbenchState): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true,
    recentWorkspaceId: undefined,
  }
  return {
    useStore: selector => selector(instance.getSnapshot()),
    actions: instance.actions,
    useWorkspaces: selector => selector(workspaceState as never),
    useSessions: selector => selector({} as never),
    ...UNUSED_STANDARD_PROPS,
    openWorkspace: async () => {},
    openSession: () => {},
    serviceFetch: fetchImpl,
    servicePollMs: 0,
    serviceWebSocket: (): MinimalWebSocket => ({ onmessage: null, onclose: null, close: () => {} }),
  }
}

describe('① 手机端装好了吗', () => {
  it('没出过包说明暂时不能下载,不给一个打不开的二维码', async () => {
    const server = fakeServer({ apk: { available: false, path: '/x', hint: '在仓库 butler-app/ 里跑一次 `pnpm android:debug`' } })
    flow(server, { initialStep: 'phone' })
    expect(await screen.findByText(/暂时没有可下载的手机安装包/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '已装,去配对' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '先不配,纯电脑用' })).toBeTruthy()
  })

  /**
   * 二维码底下那一行小字(2026-09-18「包一律放阿里云服务器」)。Ben 真机反馈:
   * 「扫码下载是失效的,IP 是局域网。」这一行要让人当场知道这张码在哪儿才扫得通。
   */
  it('云上那份:二维码底下写「扫码下载(公网)」', async () => {
    const server = fakeServer({
      apk: { available: true, path: '(在阿里云上,这台电脑上没有)', url: 'https://api.aibooo.cn/updates/0.2.42/app.apk', source: 'cloud', version: '0.2.42' },
    })
    flow(server, { initialStep: 'phone' })
    expect(await screen.findByText('扫码下载(公网)')).toBeTruthy()
    expect(screen.queryByText('同一 Wi‑Fi 下扫码')).toBeNull()
  })

  it('退回局域网那份:写「同一 Wi‑Fi 下扫码」—— 出了这间屋子那张码是废的,不能不说', async () => {
    const server = fakeServer({
      apk: { available: true, path: '/x/butler.apk', url: 'http://192.168.1.7:8791/setup/apk', source: 'lan' },
    })
    flow(server, { initialStep: 'phone' })
    expect(await screen.findByText('同一 Wi‑Fi 下扫码')).toBeTruthy()
    expect(screen.queryByText('扫码下载(公网)')).toBeNull()
  })

  it('「先不配,纯电脑用」→ 直接见事务官', async () => {
    const server = fakeServer()
    flow(server, { initialStep: 'phone' })
    await userEvent.click(await screen.findByRole('button', { name: '先不配,纯电脑用' }))
    expect(await screen.findByRole('button', { name: '已经有在做的事' })).toBeTruthy()
  })

  it('「已装,去配对」→ 先开局域网开关,再要一个配对码', async () => {
    const server = fakeServer()
    flow(server, { initialStep: 'phone' })
    await userEvent.click(await screen.findByRole('button', { name: '已装,去配对' }))
    await waitFor(() => {
      expect(server.calls.some(call => call.url === '/lan' && call.body?.enabled === true)).toBe(true)
      expect(server.calls.some(call => call.url === '/pair/start')).toBe(true)
    })
  })
})

describe('② 配对', () => {
  it('把二维码与 6 位码摆出来(跟设置里那一节同一份 /state.pairing)', async () => {
    const state = snapshot({ pairing: { code: '004217', expires_at: '2026-09-17T10:05:00+08:00', qr: 'wb://x' } })
    const server = fakeServer({ state })
    flow(server, { state, initialStep: 'pair' })
    expect(await screen.findByText('004217')).toBeTruthy()
  })

  it('**多出一台设备**才算配上;一进去就有设备(以前配过)不算', async () => {
    const before = snapshot({ devices: [{ id: 'a', name: '旧手机', platform: 'android', created_at: '', last_seen_at: '' }] })
    const server = fakeServer({ state: before })
    // 2026-09-24 起配过手机的人缺省**不再经过**手机 / 配对两屏(见下一组);这里点名从第一屏开始,只钉「比进来时多」这一条。
    const view = flow(server, { state: before, initialStep: 'phone' })
    // 从第一屏点进配对:进去那一刻记下"已经有 1 台"。
    await userEvent.click(await screen.findByRole('button', { name: '已装,去配对' }))
    expect(await screen.findByRole('button', { name: '先跳过配对' })).toBeTruthy()

    const after = snapshot({
      devices: [
        { id: 'a', name: '旧手机', platform: 'android', created_at: '', last_seen_at: '' },
        { id: 'b', name: '新手机', platform: 'android', created_at: '', last_seen_at: '' },
      ],
    })
    view.rerender(
      <FirstRunFlow baseUrl="http://x" fetchImpl={server.fetchImpl} state={after} onDone={() => {}} turnsPollMs={0} initialStep="phone" />,
    )
    expect(await screen.findByText(/配上了/)).toBeTruthy()
  })
})

/**
 * 已经配过手机就不从「手机端装好了吗?」「配对」两屏开始(2026-09-24,卡 fix/phone-nav-back,维护者拍板):
 * 维护者看到电脑停在「手机端装好了吗?」以为没配对,其实手机早就配上了。
 * 直接去**点完配对之后的同一个去处**(事务官出场;手机主导时是「在手机上继续」);没配过的新用户流程不变。
 */
describe('已经配过手机', () => {
  const phone = { id: 'p1', name: 'Pixel', platform: 'android', created_at: '', last_seen_at: '' }

  it('★`/state.devices` 非空:起始一屏不是手机 / 配对,是事务官出场', async () => {
    const state = snapshot({ devices: [phone] })
    flow(fakeServer({ state }), { state })
    expect(await screen.findByRole('button', { name: '已经有在做的事' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '第一次用' }).dataset.step).toBe('intro')
    expect(screen.queryByRole('button', { name: '已装,去配对' })).toBeNull()
    expect(screen.queryByText('手机端装好了吗?')).toBeNull()
  })

  it('★没配过的新用户也直接从电脑事务官出场开始', async () => {
    const state = snapshot({ devices: [] })
    flow(fakeServer({ state }), { state })
    expect(await screen.findByRole('button', { name: '已经有在做的事' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '第一次用' }).dataset.step).toBe('intro')
  })

  it('已配对也由电脑主导，不自动等待手机', async () => {
    const state = snapshot({ devices: [phone], onboarding: { stage: 'branch', done: false } })
    flow(fakeServer({ state }), { state })
    expect(await screen.findByRole('button', { name: '已经有在做的事' })).toBeTruthy()
    expect(screen.queryByText('手机端装好了吗?')).toBeNull()
  })

  it('设备状态晚到一拍也保留电脑出场，不闪手机页', async () => {
    const server = fakeServer()
    const view = flow(server, { state: snapshot() })
    expect(await screen.findByRole('button', { name: '已经有在做的事' })).toBeTruthy()
    view.rerender(
      <FirstRunFlow baseUrl="http://x" fetchImpl={server.fetchImpl} state={snapshot({ devices: [phone] })} onDone={() => {}} turnsPollMs={0} />,
    )
    expect(await screen.findByRole('button', { name: '已经有在做的事' })).toBeTruthy()
    expect(screen.queryByText('手机端装好了吗?')).toBeNull()
  })

  it('已经点进配对屏了,手机这时才出现 = 刚配上:照旧说「配上了」,不跳走', async () => {
    const server = fakeServer()
    const view = flow(server, { state: snapshot({ devices: [] }), initialStep: 'phone' })
    await userEvent.click(await screen.findByRole('button', { name: '已装,去配对' }))
    expect(await screen.findByRole('button', { name: '先跳过配对' })).toBeTruthy()
    view.rerender(
      <FirstRunFlow baseUrl="http://x" fetchImpl={server.fetchImpl} state={snapshot({ devices: [phone] })} onDone={() => {}} turnsPollMs={0} />,
    )
    expect(await screen.findByText(/配上了/)).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '第一次用' }).dataset.step).toBe('pair')
  })
})

/**
 * 引导会话**只在界面上答的都记进阶段机之后**才开(2026-09-24,卡 fix/firstrun-session-after-answers):
 * 会话第一条消息是开会话那一刻按阶段写的。先开会话、后交称呼与分岔,模型拿到的是「问称呼」那一版 ——
 * 对话屏上摆着布局那一问,他答「产品研发」,她又问「我该怎么称呼你呢」(统筹 14:32 在 0.2.81 上复现)。
 */
function onboardingWrites(server: ReturnType<typeof fakeServer>): string[] {
  return server.calls
    .filter(call => call.method === 'POST' && (call.url === '/onboarding/answer' || call.url === '/onboarding/session'))
    .map(call => call.url === '/onboarding/answer' ? `${String(call.body?.stage)}.${String(call.body?.key)}=${String(call.body?.value)}` : 'session')
}

describe('③ 事务官出场', () => {
  it('两个按钮;选了分岔、阶段停在开场 → 先去问称呼,**这时不开会话**', async () => {
    const server = fakeServer({ stage: 'opening' })
    flow(server, { initialStep: 'intro' })
    await userEvent.click(await screen.findByRole('button', { name: '从一个新点子开始' }))
    expect(await screen.findByLabelText('称呼')).toBeTruthy()
    expect(onboardingWrites(server)).toEqual([])
  })

  it('★答完称呼:先记称呼、再记分岔,**最后**才开会话,然后进文字引导', async () => {
    const server = fakeServer({ stage: 'opening' })
    flow(server, { initialStep: 'intro' })
    await userEvent.click(await screen.findByRole('button', { name: '已经有在做的事' }))
    await userEvent.type(await screen.findByLabelText('称呼'), 'Ben')
    await userEvent.click(screen.getByRole('button', { name: '就这么叫' }))
    expect(await screen.findByLabelText('说一句')).toBeTruthy()
    expect(onboardingWrites(server)).toEqual(['opening.nickname=Ben', 'branch.mode=existing', 'session'])
  })

  it('称呼那一项没记上(阶段机回了人话):人话上屏,不开会话', async () => {
    const server = fakeServer({ stage: 'opening', answerFails: 'nickname:要是非空字符串' })
    flow(server, { initialStep: 'intro' })
    await userEvent.click(await screen.findByRole('button', { name: '已经有在做的事' }))
    await userEvent.type(await screen.findByLabelText('称呼'), 'Ben')
    await userEvent.click(screen.getByRole('button', { name: '就这么叫' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('要是非空字符串')
    expect(onboardingWrites(server)).toEqual(['opening.nickname=Ben'])
    expect(screen.getByLabelText('称呼')).toBeInTheDocument()
  })

  it('会话没开成、他再点一次「就这么叫」:只重开会话,已经记上的称呼与分岔不再交一遍(再交会被 409)', async () => {
    const server = fakeServer({ stage: 'opening', sessionFails: '会话通道没接上,这句话说不进去' })
    const onDone = vi.fn()
    flow(server, { initialStep: 'intro', onDone })
    await userEvent.click(await screen.findByRole('button', { name: '已经有在做的事' }))
    await userEvent.type(await screen.findByLabelText('称呼'), 'Ben')
    await userEvent.click(screen.getByRole('button', { name: '就这么叫' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('会话通道没接上')
    const again = screen.getByRole('button', { name: '就这么叫' })
    await waitFor(() => expect(again).toBeEnabled())
    await userEvent.click(again)
    await waitFor(() => expect(onboardingWrites(server)).toEqual(['opening.nickname=Ben', 'branch.mode=existing', 'session', 'session']))
    expect(screen.getByRole('alert')).toHaveTextContent('会话通道没接上')
    expect(onDone).not.toHaveBeenCalled()
  })

  it('★答完称呼进对话屏:模型先前照念的开场问称呼不再当字幕,显示当前阶段那一问(维护者 09-24:称呼问了两遍)', async () => {
    const ask = '你好,很高兴认识你,我是你的专属事务官。……首先,你希望我怎么称呼你?'
    const next = '你想先把哪个项目交给我?说个名字就行,我先只录这一个。'
    const server = fakeServer({ stage: 'opening', turns: [{ seq: 1, role: 'assistant', text: ask, kind: 'seed' }], turnsExtra: { stage: 'projects', seed: next } })
    flow(server, { initialStep: 'intro' })
    await userEvent.click(await screen.findByRole('button', { name: '已经有在做的事' }))
    await userEvent.type(await screen.findByLabelText('称呼'), 'Ben')
    await userEvent.click(screen.getByRole('button', { name: '就这么叫' }))
    expect(await screen.findByText(next)).toBeTruthy()
    expect(screen.queryByText(ask)).toBeNull()
  })

  it('称呼已经答过了(阶段在分岔):不再问一遍;**先**记分岔、再开会话,进对话', async () => {
    const server = fakeServer({ stage: 'branch', nickname: 'Ben' })
    flow(server, { initialStep: 'intro' })
    await userEvent.click(await screen.findByRole('button', { name: '从一个新点子开始' }))
    expect(await screen.findByLabelText('说一句')).toBeTruthy()
    expect(screen.queryByLabelText('称呼')).toBeNull()
    expect(onboardingWrites(server)).toEqual(['branch.mode=fresh', 'session'])
  })

  it('称呼与分岔都记过了(上次会话没开成、或手机上答过):一项都不再交,直接开会话', async () => {
    const server = fakeServer({ stage: 'template', nickname: 'Ben' })
    flow(server, { initialStep: 'intro' })
    await userEvent.click(await screen.findByRole('button', { name: '已经有在做的事' }))
    expect(await screen.findByLabelText('说一句')).toBeTruthy()
    expect(onboardingWrites(server)).toEqual(['session'])
  })

  it('开不了会话:服务端那句人话原样显示;引导没走完不给跳过(维护者 09-23 拍板),按钮还能再点', async () => {
    const server = fakeServer({ stage: 'branch', nickname: 'Ben', sessionFails: '会话通道没接上,这句话说不进去' })
    const onDone = vi.fn()
    flow(server, { initialStep: 'intro', onDone })
    await userEvent.click(await screen.findByRole('button', { name: '已经有在做的事' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('会话通道没接上')
    expect(screen.queryByRole('button', { name: /进工作台|以后再说/ })).toBeNull()
    expect(screen.getByRole('button', { name: '已经有在做的事' })).toBeEnabled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('文字引导:回合显示出来,说一句走 /onboarding/say', async () => {
    const server = fakeServer({ stage: 'branch', nickname: 'Ben', turns: [{ seq: 1, role: 'assistant', text: '你好啊' }] })
    flow(server, { initialStep: 'chat' })
    expect(await screen.findByText('你好啊')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('说一句'), '我有个项目')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      expect(server.calls.some(call => call.url === '/onboarding/say' && call.body?.text === '我有个项目')).toBe(true)
    })
  })

  it('配了手机就提一句"手机上也能接着聊"', async () => {
    const state = snapshot({ devices: [{ id: 'b', name: '手机', platform: 'android', created_at: '', last_seen_at: '' }] })
    const server = fakeServer({ state })
    flow(server, { state, initialStep: 'chat' })
    expect(await screen.findByText(/手机已连接/)).toBeTruthy()
  })
})

describe('③ 手机已配对:电脑上只读(2026-09-18)', () => {
  const phone = { id: 'b', name: '手机', platform: 'android', created_at: '', last_seen_at: '' }

  function ledByPhone(over: Partial<NonNullable<WorkbenchState['onboarding']>> = {}) {
    return snapshot({
      devices: [phone],
      onboarding: { leader: 'phone', stage: 'branch', done: false, label: '② 分岔', step: 2, steps: 8, ...over },
    })
  }

  it('第 ③ 屏换成只读进度:不出那两颗分岔按钮,也不出输入框', async () => {
    const state = ledByPhone()
    const server = fakeServer({ state })
    flow(server, { state, initialStep: 'intro' })
    expect(await screen.findByText('现在到第 2 步(共 8 步):② 分岔')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '已经有在做的事' })).toBeNull()
    expect(screen.queryByLabelText('说一句')).toBeNull()
  })

  it('文字引导那一屏同样只读(输入框没了)', async () => {
    const state = ledByPhone()
    const server = fakeServer({ state })
    flow(server, { state, initialStep: 'chat' })
    expect(await screen.findByLabelText('在手机上继续')).toBeTruthy()
    expect(screen.queryByLabelText('说一句')).toBeNull()
    // 2026-09-23 维护者拍板:引导必须走完,只读那一屏上也不留跳过的路。
    expect(screen.queryByRole('button', { name: /进工作台/ })).toBeNull()
  })

  it('进度跟着 /state.onboarding 走:手机上答完一项,这一行就变', async () => {
    const state = ledByPhone()
    const server = fakeServer({ state })
    const view = flow(server, { state, initialStep: 'intro' })
    expect(await screen.findByText(/② 分岔/)).toBeTruthy()
    const next = snapshot({
      devices: [phone],
      onboarding: { leader: 'phone', stage: 'habits', done: false, label: '⑤ 习惯', step: 5, steps: 8 },
    })
    view.rerender(
      <FirstRunFlow baseUrl="http://x" fetchImpl={server.fetchImpl} state={next} onDone={() => {}} turnsPollMs={0} initialStep="intro" />,
    )
    expect(await screen.findByText('现在到第 5 步(共 8 步):⑤ 习惯')).toBeTruthy()
  })

  it('「改在电脑上做」落一笔 desktop,那三屏立刻回来', async () => {
    const state = ledByPhone()
    const server = fakeServer({ state })
    // 点完之后 /state 那一份还没变(它一秒一拍),所以这里模拟服务端已经改过:leader=desktop。
    const view = flow(server, { state, initialStep: 'intro' })
    await userEvent.click(await screen.findByRole('button', { name: '改在电脑上做' }))
    await waitFor(() => {
      expect(server.calls.some(call => call.url === '/onboarding/leader' && call.body?.leader === 'desktop')).toBe(true)
    })
    const after = snapshot({
      devices: [phone],
      onboarding: { leader: 'desktop', stage: 'branch', done: false, label: '② 分岔', step: 2, steps: 8 },
    })
    view.rerender(
      <FirstRunFlow baseUrl="http://x" fetchImpl={server.fetchImpl} state={after} onDone={() => {}} turnsPollMs={0} initialStep="intro" />,
    )
    expect(await screen.findByRole('button', { name: '已经有在做的事' })).toBeTruthy()
  })

  it('手机那边十分钟没动静:问一句,但**不自动切回来**', async () => {
    const state = ledByPhone({ leader: 'phone', leader_at: '2026-09-17T10:00:00.000Z' })
    const server = fakeServer({ state })
    render(
      <FirstRunFlow
        baseUrl="http://x"
        fetchImpl={server.fetchImpl}
        state={state}
        onDone={() => {}}
        turnsPollMs={0}
        initialStep="intro"
        now={() => Date.parse('2026-09-17T10:20:00.000Z')}
      />,
    )
    expect(await screen.findByText('手机那边没动静,改在电脑上做?')).toBeTruthy()
    // 还在只读那一屏上 —— 切不切由人按。
    expect(screen.queryByRole('button', { name: '已经有在做的事' })).toBeNull()
  })

  it('电脑主导(leader=desktop)时照旧是那三屏,哪怕手机配过', async () => {
    const state = ledByPhone({ leader: 'desktop' })
    const server = fakeServer({ state })
    flow(server, { state, initialStep: 'intro' })
    expect(await screen.findByRole('button', { name: '已经有在做的事' })).toBeTruthy()
  })
})

describe('旗子', () => {
  it('没有任何跳过引导的按钮(维护者 09-23:「直接去掉跳过引导的按钮吧,这不现实」)', async () => {
    const server = fakeServer({ stage: 'branch' })
    const onDone = vi.fn()
    for (const step of ['phone', 'intro', 'chat'] as const) {
      const view = flow(server, { initialStep: step, onDone })
      await screen.findByRole('dialog', { name: '第一次用' })
      expect(screen.queryByRole('button', { name: /跳过,直接进工作台|先到这儿|以后再说/ })).toBeNull()
      view.unmount()
    }
    expect(server.calls.some(call => call.url === '/first-run' && call.method === 'POST')).toBe(false)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('跳过配手机不是跳过引导:「先不配」只是去见事务官,不写旗子', async () => {
    const server = fakeServer()
    const onDone = vi.fn()
    flow(server, { onDone, initialStep: 'phone' })
    await userEvent.click(await screen.findByRole('button', { name: '先不配,纯电脑用' }))
    expect(await screen.findByRole('button', { name: '已经有在做的事' })).toBeTruthy()
    expect(server.calls.some(call => call.url === '/first-run' && call.method === 'POST')).toBe(false)
  })

  it('对话里引导走完(turns 回 done):写旗子进工作台', async () => {
    const server = fakeServer({ stage: 'branch', turnsExtra: { done: true, stage: 'done' } })
    const onDone = vi.fn()
    flow(server, { initialStep: 'chat', onDone })
    await userEvent.click(await screen.findByRole('button', { name: '稍后再配，进工作台' }))
    await waitFor(() => {
      expect(server.calls.some(call => call.url === '/first-run' && call.body?.done === true)).toBe(true)
      expect(onDone).toHaveBeenCalledTimes(1)
    })
  })

  it('手机上做完了(/state.onboarding.done):电脑这边到事务官那一屏就直接进,只写一次旗子', async () => {
    const state = snapshot({ onboarding: { stage: 'done', done: true } })
    const server = fakeServer({ state })
    const onDone = vi.fn()
    flow(server, { state, initialStep: 'intro', onDone })
    await userEvent.click(await screen.findByRole('button', { name: '稍后再配，进工作台' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(server.calls.filter(call => call.url === '/first-run' && call.body?.done === true)).toHaveLength(1)
  })

  it('引导已 done 也不在手机/配对两屏自动走(「重新走一遍首次流程」要让人看得到)', async () => {
    const state = snapshot({ onboarding: { stage: 'done', done: true } })
    const onDone = vi.fn()
    flow(fakeServer({ state }), { state, onDone, initialStep: 'phone' })
    expect(await screen.findByRole('button', { name: '已装,去配对' })).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('整屏那道门', () => {
  it('登录了、旗子没写:注册完看到的就是这三屏的第一屏', async () => {
    const server = fakeServer({ account: { registered: true, logged_in: true, username: 'ben' } })
    render(<WorkbenchOverlay {...props(server.fetchImpl, snapshot())} />)
    expect(await screen.findByRole('dialog', { name: '第一次用' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '设置' })).toBeNull()
  })

  it('旗子写过了:直接进工作台,这三屏不出现', async () => {
    const server = fakeServer({
      account: { registered: true, logged_in: true, username: 'ben' },
      firstRunDoneAt: '2026-09-17T09:00:00.000Z',
    })
    render(<WorkbenchOverlay {...props(server.fetchImpl, snapshot())} />)
    expect(await screen.findByRole('button', { name: '设置' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '第一次用' })).toBeNull()
  })

  it('引导走完之后就换成工作台', async () => {
    const done = snapshot({ onboarding: { stage: 'done', done: true } })
    const server = fakeServer({ account: { registered: true, logged_in: true, username: 'ben' }, state: done })
    render(<WorkbenchOverlay {...props(server.fetchImpl, done)} />)
    await userEvent.click(await screen.findByRole('button', { name: '稍后再配，进工作台' }))
    expect(await screen.findByRole('button', { name: '设置' })).toBeTruthy()
  })

  it('设置里「重新走一遍首次流程」把旗子擦掉,那三屏再来一次', async () => {
    const server = fakeServer({
      account: { registered: true, logged_in: true, username: 'ben' },
      firstRunDoneAt: '2026-09-17T09:00:00.000Z',
    })
    render(<WorkbenchOverlay {...props(server.fetchImpl, snapshot())} />)
    await userEvent.click(await screen.findByRole('button', { name: '设置' }))
    // 2026-09-28(卡 SG):体检那一行收进「高级」那一组,先切过去。入口一个没少。
    await openGroup(GROUP.advanced)
    await userEvent.click(await screen.findByRole('button', { name: '重新走一遍首次流程' }))
    expect(await screen.findByRole('dialog', { name: '第一次用' })).toBeTruthy()
    expect(server.calls.some(call => call.url === '/first-run' && call.body?.done === false)).toBe(true)
  })
})

describe('刚登录进来(2026-09-24 串联去卡顿)', () => {
  it('首次流程那面旗子问回来之前先空着,不把整块工作台先渲染一遍再换成引导屏;登录屏问回来的账号直接用,不再问一遍 /account', async () => {
    let loggedIn = false
    let releaseFirstRun: (() => void) | undefined
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? ''
      calls.push(path)
      const ok = (payload: unknown): Response => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
      if (path === '/account') return ok({ registered: true, logged_in: loggedIn, ...(loggedIn ? { username: 'ben' } : {}) })
      if (path === '/account/login') { loggedIn = true; return ok({ username: 'ben' }) }
      if (path === '/first-run') { await new Promise<void>(resolve => { releaseFirstRun = resolve }); return ok({}) }
      if (path === '/setup/apk.json') return ok({ available: false, path: '/x' })
      if (path.startsWith('/config/')) return { ok: false, status: 404, json: async () => ({ error: 'x' }) } as unknown as Response
      return ok(snapshot())
    }) as unknown as typeof fetch
    render(<WorkbenchOverlay {...props(fetchImpl, snapshot())} />)
    const form = await screen.findByRole('dialog', { name: '登录' })
    const inputs = form.querySelectorAll('input')
    await userEvent.type(inputs[0]!, 'ben')
    await userEvent.type(inputs[1]!, 'hunter22')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '登录' })).toBeNull())
    // 旗子还没问回来:既不是工作台本体(没有「设置」),也不是引导屏。
    expect(screen.queryByRole('button', { name: '设置' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '第一次用' })).toBeNull()
    expect(calls.filter(path => path === '/account').length).toBe(2) // 挂载一次 + 登录屏自己问的一次,Workbench 不再问第三次
    releaseFirstRun?.()
    expect(await screen.findByRole('dialog', { name: '第一次用' })).toBeTruthy()
  })
})

describe('粒子球舞台(2026-09-23,维护者:「注册之后粒子球就应该要出现了」)', () => {
  function stageRoot(): HTMLElement {
    return screen.getByRole('dialog', { name: '第一次用' })
  }

  it('第一屏就有球(小的,让出二维码);事务官出场之后是大的,卡片退成无边框', async () => {
    const server = fakeServer()
    flow(server, { initialStep: 'phone' })
    expect(await screen.findByRole('button', { name: '已装,去配对' })).toBeTruthy()
    expect(stageRoot().querySelector('.ben-wb__onb-orb')).not.toBeNull()
    expect(stageRoot().dataset.orb).toBe('small')
    await userEvent.click(screen.getByRole('button', { name: '先不配,纯电脑用' }))
    await screen.findByRole('button', { name: '已经有在做的事' })
    expect(stageRoot().dataset.orb).toBe('large')
    expect(stageRoot().querySelector('.ben-wb__onb-body')).not.toBeNull()
  })

  it('每一屏都没有卡片框(2026-09-23 维护者:「不需要弹窗」):没有卡片容器,舞台样式里也不画框和底色', async () => {
    const server = fakeServer()
    flow(server, { initialStep: 'phone' })
    await screen.findByRole('button', { name: '已装,去配对' })
    expect(stageRoot().querySelector('.ben-wb__firstrun-card')).toBeNull()
    expect(stageRoot().dataset.layout).toBe('center')
    await userEvent.click(screen.getByRole('button', { name: '先不配,纯电脑用' }))
    await screen.findByRole('button', { name: '已经有在做的事' })
    expect(stageRoot().querySelector('.ben-wb__firstrun-card')).toBeNull()
    // 舞台、正文、二维码三块的样式规则里一律没有 border / background
    for (const selector of ['.ben-wb__onb-body{', '.ben-wb__onb-qr{', '.ben-wb__onb .ben-wb__account-form{']) {
      const at = STYLE.indexOf(selector)
      expect(at, selector).toBeGreaterThanOrEqual(0)
      const rule = STYLE.slice(at, STYLE.indexOf('}', at))
      expect(rule, selector).not.toMatch(/border|background/)
    }
    expect(STYLE).not.toMatch(/\.ben-wb__firstrun-card\{/)
    expect(STYLE).not.toMatch(/\.ben-wb__account-card\{/)
  })

  it('对话屏输入框贴底(chat 排版),其余屏居中', async () => {
    flow(fakeServer(), { initialStep: 'chat' })
    await screen.findByRole('textbox', { name: '说一句' })
    expect(stageRoot().dataset.layout).toBe('chat')
  })

  it('字幕只放她最近那一句;你那句小字在下面;前面的对话点开才出', async () => {
    const server = fakeServer({
      turns: [
        { seq: 1, role: 'assistant', text: '你好,怎么称呼?' },
        { seq: 2, role: 'user', text: '叫我小本' },
        { seq: 3, role: 'assistant', text: '小本你好,你在做什么项目?' },
      ],
    })
    flow(server, { initialStep: 'chat' })
    expect(await screen.findByText('小本你好,你在做什么项目?')).toBeTruthy()
    expect(screen.queryByText('你好,怎么称呼?')).toBeNull()
    expect(screen.getByText('叫我小本')).toBeTruthy()
    expect(screen.queryByRole('list', { name: '对话' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '看前面的对话(3)' }))
    expect(screen.getByRole('list', { name: '对话' })).toHaveTextContent('你好,怎么称呼?')
  })

  it('还没有回合:字幕是阶段种子句', async () => {
    flow(fakeServer(), { initialStep: 'chat' })
    expect(await screen.findByText('你现在是已经有在做的事,还是想从一个新点子开始?')).toBeTruthy()
  })

  it('回合出错:那句人话上屏,不能只剩你自己的话', async () => {
    const server = fakeServer({
      turns: [
        { seq: 1, role: 'user', text: '我做产品研发' },
        { seq: 2, role: 'assistant', text: '我这边模型没接上,正在重连。', kind: 'error' },
      ],
      turnsExtra: { failed: true },
    })
    flow(server, { initialStep: 'chat' })
    const trouble = await screen.findByText('我这边模型没接上,正在重连。')
    expect(trouble).toHaveAttribute('data-trouble', 'true')
    await waitFor(() => expect(stageRoot().dataset.cue).toBe('trouble'))
  })

  it('只有 failed 旗子(旧回合没带那句话):给默认人话', async () => {
    const server = fakeServer({ turns: [{ seq: 1, role: 'assistant', text: '你好' }], turnsExtra: { failed: true } })
    flow(server, { initialStep: 'chat' })
    expect(await screen.findByText(/模型没接上/)).toBeTruthy()
  })

  it('你说完、回合早停了、45 秒没回话:一句人话', async () => {
    const server = fakeServer({ turns: [{ seq: 1, role: 'user', text: '我做产品', at: '2026-09-23T10:00:00.000Z' } as never] })
    render(
      <FirstRunFlow
        baseUrl="http://x"
        fetchImpl={server.fetchImpl}
        state={snapshot()}
        onDone={() => {}}
        turnsPollMs={0}
        initialStep="chat"
        now={() => Date.parse('2026-09-23T10:01:00.000Z')}
      />,
    )
    expect(await screen.findByText(/好一会儿没回上话/)).toBeTruthy()
  })

  it('扫描有进度:工作态 + 「已看 N/M」+ 进度条', async () => {
    const server = fakeServer({
      turns: [{ seq: 1, role: 'assistant', text: '我看一下你的仓库' }],
      turnsExtra: { busy: true, stage: 'projects', scan: { scanning: true, done: 3, total: 12, current: '/Users/x/Documents/GitHub/demo' } },
    })
    flow(server, { initialStep: 'chat' })
    expect(await screen.findByText('正在找你的项目… 已看 3/12 · …/GitHub/demo')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '扫描进度' })).toHaveAttribute('aria-valuenow', '25')
  })

  it('扫描拿不到进度:只有「正在找你的项目…」,没有条', async () => {
    const server = fakeServer({ turnsExtra: { busy: true, stage: 'projects' } })
    flow(server, { initialStep: 'chat' })
    expect(await screen.findByText('正在找你的项目…')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('等模型:状态行「在想…」', async () => {
    const server = fakeServer({ turns: [{ seq: 1, role: 'assistant', text: '你好' }], turnsExtra: { busy: true, stage: 'habits' } })
    flow(server, { initialStep: 'chat' })
    expect(await screen.findByText('在想…')).toBeTruthy()
  })

  it('只留「手机上也能接着聊」(换设备接着同一段引导);不留跳过的出口', async () => {
    const state = snapshot({ devices: [{ id: 'b', name: '手机', platform: 'android', created_at: '', last_seen_at: '' }] })
    flow(fakeServer({ state }), { state, initialStep: 'chat' })
    expect(await screen.findByText(/手机已连接/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /进工作台/ })).toBeNull()
  })
})

it('完成旧引导后设置保留添加手机或座机入口', async () => {
  const state = snapshot({ lan: { enabled: false, port: 8791, advertising: false }, devices: [] })
  const server = fakeServer({ account: { registered: true, logged_in: true, username: 'tester' }, firstRunDoneAt: '2026-10-21T09:00:00Z', state })
  render(<WorkbenchOverlay {...props(server.fetchImpl, state)} />)
  await userEvent.click(await screen.findByRole('button', { name: '设置' }))
  await openGroup(GROUP.devices)
  await userEvent.click(await screen.findByRole('button', { name: '添加手机或座机' }))
  expect(server.calls.some(call => call.url === '/pair/start')).toBe(true)
  expect(server.calls.some(call => call.url === '/pair/revoke' || call.url === '/onboarding/restart')).toBe(false)
})
