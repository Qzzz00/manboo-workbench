/**
 * 动效配角(2026-09-23):状态 → 效果的映射,以及「一屏最多一种强效果」「看不见就不跑」两条纪律。
 * 设计见 docs/设计-动效配角-2026-09-23.md。认的是我们自己包的那一层 `.ben-fx[data-fx]`,不认库内部结构。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_AVATAR, BEAM, agentOfExecutorLabel, avatarFor, avatarStateOfDispatch, avatarStateOfGroup, avatarStateOfSession,
  beamSize, confirmPulse, isStrong, onboardingFx, strongFx,
} from '../src/client/fx/fxModel.ts'
import { FxBeam, fxSupported } from '../src/client/fx/Fx.tsx'
import { FX_STYLE } from '../src/client/fx/fxStyle.ts'
import { STYLE } from '../src/client/style.ts'
import { ButlerScene } from '../src/client/ButlerScene.tsx'
import { ButlerInbox, type ButlerInboxProps } from '../src/client/ButlerInbox.tsx'
import { SessionFeed } from '../src/client/SessionFeed.tsx'
import { TaskCard } from '../src/client/TaskCard.tsx'
import { FirstRunFlow } from '../src/client/firstrun/FirstRunFlow.tsx'
import { SlotZone } from '../src/client/SlotZone.tsx'
import { createRef } from 'react'
import type { SessionView, TaskView, WorkbenchState } from '../src/protocol.ts'
import type { AgentGroup } from '../src/client/sessionFeed.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('映射(纯函数)', () => {
  it('强效果最多一个:交办在路上 > 要你处理的卡;台上在跑的卡不再单独走光;看不见一律没有', () => {
    expect(strongFx({ visible: true, composerBusy: true })).toBe('composer')
    expect(strongFx({ visible: true, composerBusy: false })).toBeNull()
    expect(strongFx({ visible: false, composerBusy: true })).toBeNull()
  })

  it('待确认呼吸:看得见且有东西才呼吸', () => {
    expect(confirmPulse({ visible: true, count: 2 })).toBe(true)
    expect(confirmPulse({ visible: true, count: 0 })).toBe(false)
    expect(confirmPulse({ visible: false, count: 2 })).toBe(false)
  })

  it('引导:在想 / 找项目 → 输入框光;说话、出错、待命都不亮;任何时候都不给小球(主球就是她)', () => {
    expect(onboardingFx('thinking')).toEqual({ beam: true })
    expect(onboardingFx('working')).toEqual({ beam: true })
    for (const cue of ['idle', 'listening', 'speaking', 'trouble'] as const) expect(onboardingFx(cue)).toEqual({ beam: false })
  })

  it('强弱与库参数:走的光是强效果,呼吸是弱效果;三种 kind 对上库的 size', () => {
    expect(isStrong(BEAM.composer.kind)).toBe(true)
    expect(isStrong(BEAM.ask.kind)).toBe(true)
    expect(isStrong(BEAM.confirm.kind)).toBe(false)
    expect([beamSize('line'), beamSize('rotate'), beamSize('pulse')]).toEqual(['line', 'md', 'pulse-inner'])
    // 2026-09-24 全局去蓝:每一处光都是黑白灰(mono),关色相漂移。
    for (const spec of Object.values(BEAM)) expect([spec.tone, spec.staticColors]).toEqual(['mono', true])
    // 要你处理的那张卡那一圈比库默认(1.96 秒)慢,不抢球。
    expect(BEAM.ask.duration).toBeGreaterThan(1.96)
  })

  it('头像:各家一个、互不相同;在跑=忙,等你/跑完/出错=醒着,离线/查不到=睡着', () => {
    const types = Object.values(AGENT_AVATAR).map(one => one.type)
    expect(new Set(types).size).toBe(types.length)
    expect(avatarStateOfSession('running')).toBe('working')
    expect(avatarStateOfSession('waiting')).toBe('default')
    expect(avatarStateOfSession('error')).toBe('default')
    expect(avatarStateOfSession('offline')).toBe('sleeping')
    expect(avatarStateOfSession(undefined)).toBe('sleeping')
    expect(avatarStateOfGroup(['done', 'running'])).toBe('working')
    expect(avatarStateOfGroup(['done'])).toBe('default')
    expect(avatarStateOfGroup([])).toBe('sleeping')
    expect(avatarStateOfDispatch('running')).toBe('working')
    expect(avatarStateOfDispatch('failed')).toBe('default')
    expect(agentOfExecutorLabel('codex / abc')).toBe('codex')
    // 登记表里运行时新接上的一家也认(卡 Q):不再只认写死的四家。
    expect(agentOfExecutorLabel('com.meta.endo / window:1')).toBe('com.meta.endo')
    expect(agentOfExecutorLabel('没有斜杠')).toBeUndefined()
    // 头像:老几家照旧;新来的一家按 id 算一个,同一个 id 永远同一个样子,名字用登记表里的。
    expect(avatarFor('claude').type).toBe('pebble')
    expect(avatarFor('com.example.fooai', 'Foo AI')).toEqual(avatarFor('com.example.fooai', 'Foo AI'))
    expect(avatarFor('com.example.fooai', 'Foo AI').label).toBe('Foo AI')
  })
})

function matchMediaStub(reduce = false) {
  return (query: string) => ({
    matches: reduce && query.includes('reduced-motion'), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })
}

describe('FxBeam', () => {
  it('没有 matchMedia 的环境只画里面的东西,外层照样挂 data-fx', () => {
    expect(fxSupported()).toBe(false)
    const { container } = render(<FxBeam name="t" spec={BEAM.composer} active><input aria-label="框" /></FxBeam>)
    const wrap = container.querySelector('.ben-fx[data-fx=t]')!
    expect(wrap).toHaveAttribute('data-fx-active', 'true')
    expect(wrap.querySelector('[data-beam]')).toBeNull()
    expect(screen.getByLabelText('框')).toBeInTheDocument()
  })

  it('支持时用 border-beam 包起来;亮 / 灭切换不重建里面的输入框(不丢焦点)', () => {
    vi.stubGlobal('matchMedia', matchMediaStub())
    const { container, rerender } = render(<FxBeam name="t" spec={BEAM.composer} active={false}><input aria-label="框" /></FxBeam>)
    const input = screen.getByLabelText('框')
    expect(container.querySelector('[data-beam]')).not.toBeNull()
    rerender(<FxBeam name="t" spec={BEAM.composer} active><input aria-label="框" /></FxBeam>)
    expect(screen.getByLabelText('框')).toBe(input)
    expect(container.querySelector('.ben-fx[data-fx=t]')).toHaveAttribute('data-fx-active', 'true')
  })

  it('包的那一层不占版面(display: contents)', () => {
    expect(FX_STYLE).toMatch(/\.ben-fx\{display:contents\}/)
  })
})

// ——— 装到界面上 ———

const base: WorkbenchState = { agents: [], sessions: [], quota: {}, stale: false, now: '2026-09-23T12:00:00Z', butler_inbox: { items: [] } }

function task(over: Partial<TaskView>): TaskView {
  return { id: 't', title: '事项', status: 'doing', direction: 'mine', source: { kind: 'manual' }, created_at: '', updated_at: '2026-09-23T10:00:00Z', ...over } as TaskView
}
function session(over: Partial<SessionView>): SessionView {
  return { agent: 'codex', session_id: 's', status: 'running', project: '', elapsed_sec: 1, unread: false, updated_at: 'v1', ...over } as SessionView
}
function sceneState(): WorkbenchState {
  return {
    ...base,
    tasks: {
      tasks: [
        task({ id: 'a', title: '写登录页', links: [{ agent: 'codex', session_id: 's1' }], updated_at: '2026-09-23T10:00:00Z' }),
        task({ id: 'b', title: '审代码', links: [{ agent: 'claude', session_id: 's2' }], updated_at: '2026-09-23T11:00:00Z' }),
        task({ id: 'c', title: '验收报告', status: 'confirm' }),
      ],
      sprints: [], modules: [], project_meta: [],
    },
    sessions: [session({ agent: 'codex', session_id: 's1' }), session({ agent: 'claude', session_id: 's2' })],
  }
}

function activeBeams(container: HTMLElement, name: string): Element[] {
  return [...container.querySelectorAll(`.ben-fx[data-fx=${name}][data-fx-active=true]`)]
}

describe('事务官档', () => {
  it('★台上两张都在跑:两张一个样(谁都不单独走光);他点开一张,只多一个「你点开的」小字,不多光;派出去的那几家各一个头像', () => {
    // 维护者 0.3.1:「为什么只有一个有光效,另一个没有」—— 以前「当前事项」那张单独走一圈光。
    const { container } = render(<ButlerScene state={sceneState()} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
    const cards = () => [...container.querySelectorAll('[data-task-card]')].filter(card => card.textContent?.includes('进行中'))
    expect(cards()).toHaveLength(2)
    const looks = () => cards().map(card => ({
      beams: card.querySelectorAll('.ben-fx[data-fx-active=true], [data-beam]').length,
      tag: card.querySelector('.ben-wb__task-current')?.textContent ?? null,
    }))
    expect(looks()).toEqual([{ beams: 0, tag: null }, { beams: 0, tag: null }])
    expect(activeBeams(container, 'current-card')).toHaveLength(0)
    const avatars = [...container.querySelectorAll('.ben-fx[data-fx=avatar]')].map(one => [one.getAttribute('data-fx-agent'), one.getAttribute('data-fx-state')])
    expect(avatars).toEqual(expect.arrayContaining([['codex', 'working'], ['claude', 'working']]))
    // 点开「写登录页」那张:只多一个小字,光效照旧一样(都没有)。
    act(() => { fireEvent.click(screen.getByRole('button', { name: '查看事项:写登录页' })) })
    expect(looks().map(one => one.beams)).toEqual([0, 0])
    expect(looks().map(one => one.tag).filter(Boolean)).toEqual(['你点开的'])
    expect(container.querySelector('[data-task-card] [aria-pressed=true] .ben-wb__task-current')).toHaveTextContent('你点开的')
  })

  it('待确认那一夹有东西时呼吸,切走(visible=false)就停', () => {
    const { container, rerender } = render(<ButlerScene state={sceneState()} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
    expect(activeBeams(container, 'confirm')).toHaveLength(1)
    rerender(<ButlerScene state={sceneState()} visible={false} onConfirm={vi.fn()} onOpen={vi.fn()}>粒子</ButlerScene>)
    expect(activeBeams(container, 'confirm')).toHaveLength(0)
  })

  it('交办在路上:输入框亮、卡片让位(一屏一种强效果);交完卡片回来', async () => {
    let finish: (value: unknown) => void = () => {}
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/butler/item')) return new Promise(resolve => { finish = resolve })
      return { ok: true, json: async () => ({}) }
    })
    const props: ButlerInboxProps = {
      state: sceneState(), baseUrl: '/service', fetchImpl: fetchImpl as unknown as typeof fetch, onOpenConversation: vi.fn(),
      draft: '帮我查一下', onDraftChange: vi.fn(), visible: true,
      controls: { paused: false, testRinging: false, onPause: vi.fn(), onTestRing: vi.fn(), onCancelWatch: vi.fn(), onDismissBrief: vi.fn(), proposals: [] },
    }
    const { container } = render(<ButlerInbox {...props} />)
    expect(activeBeams(container, 'composer')).toHaveLength(0)
    fireEvent.keyDown(screen.getByLabelText('交给事务官一件事'), { key: 'Enter' })
    expect(activeBeams(container, 'composer')).toHaveLength(1)
    await act(async () => { finish({ ok: true, json: async () => ({ ok: true }) }) })
    expect(activeBeams(container, 'composer')).toHaveLength(0)
    // 台上在跑的卡自始至终不单独走光(卡 P 补三)。
    expect(activeBeams(container, 'current-card')).toHaveLength(0)
  })
})

describe('窗口槽那圈光(2026-09-24 自制虚线呼吸换成 border-beam;2026-09-25 卡 P 起只绑「放下」)', () => {
  it('★悬在槽上不亮光(只有提示字);真拖进来放手那一下才亮;灭了就灭;槽体不重挂(ResizeObserver 不白报一次矩形)', () => {
    // 维护者:「窗口槽的流线光效时不时自己闪一下,其实没拖新应用进去」—— 光绑「放下」这个动作,不绑悬停这个状态。
    vi.stubGlobal('matchMedia', matchMediaStub())
    const bodyRef = createRef<HTMLDivElement>()
    const props = { helper: { connected: true, authorized: true } as never, snap: undefined, dockNote: undefined, bodyRef }
    const { container, rerender } = render(<SlotZone {...props} dropHover={false} />)
    const body = bodyRef.current
    expect(activeBeams(container, 'slot-hover')).toHaveLength(0)
    rerender(<SlotZone {...props} dropHover />)
    expect(activeBeams(container, 'slot-hover')).toHaveLength(0)
    expect(container.querySelector('.ben-wb__slot-body')?.getAttribute('data-hover')).toBe('true')
    rerender(<SlotZone {...props} dropHover={false} dropFlash />)
    expect(activeBeams(container, 'slot-hover')).toHaveLength(1)
    expect(container.querySelector('[data-beam] .ben-wb__slot-body')).toBe(body)
    expect(bodyRef.current).toBe(body)
    rerender(<SlotZone {...props} dropHover={false} />)
    expect(activeBeams(container, 'slot-hover')).toHaveLength(0)
    expect(bodyRef.current).toBe(body)
  })

  it('原来的蓝色虚线呼吸下线了;光与「要你处理的卡」那一圈同一套参数', () => {
    expect(STYLE).not.toMatch(/ben-wb-hover-breathe/)
    expect(BEAM.slotHover.duration).toBe(BEAM.ask.duration)
    expect(beamSize(BEAM.slotHover.kind)).toBe('md')
  })
})

describe('会话区与看板', () => {
  it('会话区每组一个头像:有一条在跑就是忙,整体掉线就睡', () => {
    const groups = [
      { agent: 'codex' as const, sessions: [session({ status: 'done' }), session({ session_id: 'x', status: 'running' })], waiting: 0, running: 1 },
      { agent: 'kimi' as const, sessions: [], waiting: 0, running: 0 },
    ] as unknown as AgentGroup[]
    const props = { groups, onRead: vi.fn(), onActivate: vi.fn(), badges: {} }
    const { container, rerender } = render(<SessionFeed {...props} offline={false} />)
    const states = () => [...container.querySelectorAll('.ben-fx[data-fx=avatar]')].map(one => `${one.getAttribute('data-fx-agent')}:${one.getAttribute('data-fx-state')}`)
    expect(states()).toEqual(['codex:working', 'kimi:sleeping'])
    rerender(<SessionFeed {...props} offline />)
    expect(states()).toEqual(['codex:sleeping', 'kimi:sleeping'])
  })

  it('看板卡的派活小标带那一家的头像;没派过活就没有', () => {
    const noop = () => {}
    const dispatched = task({ dispatch: { family: 'claude', status: 'running', cwd: '~/x', started_at: '' } as NonNullable<TaskView['dispatch']> })
    const { container, rerender } = render(<TaskCard task={dispatched} sessions={[]} sessionUsage={{}} nowMs={0} onOpen={noop} onDragStart={noop} onDragEnd={noop} />)
    const avatar = container.querySelector('.ben-wb__task-dispatch .ben-fx[data-fx=avatar]')
    expect(avatar).toHaveAttribute('data-fx-agent', 'claude')
    expect(avatar).toHaveAttribute('data-fx-state', 'working')
    rerender(<TaskCard task={task({})} sessions={[]} sessionUsage={{}} nowMs={0} onOpen={noop} onDragStart={noop} onDragEnd={noop} />)
    expect(container.querySelector('.ben-fx[data-fx=avatar]')).toBeNull()
  })
})

describe('引导对话屏', () => {
  function onboardingFetch(extra: Record<string, unknown>) {
    return vi.fn(async (url: string) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0]
      const payload = path === '/onboarding/turns'
        ? { turns: [{ seq: 1, role: 'assistant', text: '我先看看你电脑上在做的项目。' }], busy: true, ended: false, done: false, ...extra }
        : path === '/onboarding' ? { stage: 'projects', done: false } : {}
      return { ok: true, status: 200, json: async () => payload } as unknown as Response
    }) as unknown as typeof fetch
  }

  it('扫描时(她那句刚出来也一样):主球工作态、输入框走光,状态行前没有小粒子(维护者 09-23)', async () => {
    const fetchImpl = onboardingFetch({ stage: 'projects', scan: { scanning: true, phase: 'repos', done: 14, total: 38, current: 'desktop-workbench' } })
    const { container } = render(<FirstRunFlow baseUrl="http://x" fetchImpl={fetchImpl} state={{ agents: [], sessions: [], quota: {}, now: base.now, stale: false } as WorkbenchState} onDone={() => {}} turnsPollMs={0} initialStep="chat" />)
    expect(await screen.findByText(/正在找你的项目/)).toBeInTheDocument()
    expect(container.querySelector('.ben-wb__onb')).toHaveAttribute('data-cue', 'working')
    expect(container.querySelector('.ben-wb__onb-orb')).toHaveAttribute('data-mode', 'working')
    expect(container.querySelector('.ben-fx[data-fx=onboarding-input]')).toHaveAttribute('data-fx-active', 'true')
    expect(container.querySelector('[data-fx=thinking]')).toBeNull()
  })

  it('在想:输入框走光,也不放小粒子', async () => {
    const fetchImpl = onboardingFetch({ stage: 'habits', turns: [{ seq: 1, role: 'user', text: '九点' }] })
    const { container } = render(<FirstRunFlow baseUrl="http://x" fetchImpl={fetchImpl} state={{ agents: [], sessions: [], quota: {}, now: base.now, stale: false } as WorkbenchState} onDone={() => {}} turnsPollMs={0} initialStep="chat" />)
    expect(await screen.findByText('在想…')).toBeInTheDocument()
    expect(container.querySelector('.ben-fx[data-fx=onboarding-input]')).toHaveAttribute('data-fx-active', 'true')
    expect(container.querySelector('[data-fx=thinking]')).toBeNull()
  })
})
