/**
 * 事务官页上「某家在跑的会话」那几张卡(2026-09-25,卡 P)。
 *
 * 维护者 09-25 下午原话:「事务官中并没有显示会话的标题和内容」—— 截图上两张
 * 「Claude · 进行中 · 14 分钟 / Claude 的一条会话 / 等待下一次进度回传」。
 * 钉住:① 标题是那家自己的标题;② 标题下面那一行是「最近在做什么 · 几分钟前」,读不到就说读不到,
 * 不写占位话;③ 点开在工作台里看(项目、现在怎样、最近几轮),不露会话 id、不跳 DSH。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerScene } from '../src/client/ButlerScene.tsx'
import { agentTitle, buildButlerScene, sceneProgressLine } from '../src/client/butlerSceneModel.ts'
import type { SessionDigestView, SessionView, WorkbenchState } from '../src/protocol.ts'
import { SESSION_ACTIVITY_UNKNOWN, agoLabel, sessionDisplayTitle } from '../src/protocol.ts'

afterEach(cleanup)

const NOW = '2026-09-25T07:20:00.000Z'

function session(patch: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'claude', session_id: 'd9991aac-5e0e-4ba6-8dcf-7170236b3763', project: 'ben-dsh-workbench', status: 'running',
    elapsed_sec: 14 * 60, unread: false, updated_at: '2026-09-25T07:16:08.000Z',
    title: 'Desktop-workbench 统筹交接',
    activity: { line: '先说结论：大约 16:30 能先用上第一批', at: '2026-09-25T07:17:00.000Z' },
    ...patch,
  }
}

/** 用例里的登记表名字(卡 Q 起界面只从 /state.agent_registry 取名字;产品代码里没有这张表)。 */
const NAMES: Record<string, string> = { dsh: '事务官', claude: 'Claude', codex: 'Codex', kimi: 'Kimi' }

function state(sessions: SessionView[]): WorkbenchState {
  const ids = [...new Set(sessions.map(one => one.agent))]
  return {
    agents: [], sessions, quota: {}, stale: false, now: NOW,
    tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
    butler_inbox: { items: [] },
    // 服务端每一拍都带的那一份(卡 Q):各家的会话挂在登记表的条目上。
    agent_registry: {
      entries: ids.map(id => ({
        id, name: NAMES[id] ?? id, found: { how: 'sessions' as const, at: '', basis: '' }, sources: [], status: 'running' as const, gaps: {},
        sessions: sessions.filter(one => one.agent === id).map(one => ({ ...one, via: 'sessions' as const })),
        counts: { running: 0, waiting: 0, unread: 0 },
      })),
      asking: [], notices: [],
    },
  }
}

describe('卡片上写清是什么、在做什么', () => {
  it('★标题是那家自己的标题;标题下面是「在做什么 · 几分钟前」', () => {
    const scene = buildButlerScene(state([session()]))
    const card = scene.items.find(item => item.external !== undefined)!
    expect(card.title).toBe('Desktop-workbench 统筹交接')
    expect(card.progress).toBe('先说结论：大约 16:30 能先用上第一批 · 3 分钟前')
  })

  it('★读不到在做什么 →「读不到它在做什么」;标题读不到 →「Claude 的一条会话」(最后的退路)', () => {
    const { title: _title, activity: _activity, ...bare } = session()
    const scene = buildButlerScene(state([bare]))
    const card = scene.items.find(item => item.external !== undefined)!
    expect(card.title).toBe('Claude 的一条会话')
    expect(card.progress).toBe(SESSION_ACTIVITY_UNKNOWN)
  })

  it('★整个台上不再出现「等待下一次进度回传」这种占位话', () => {
    render(<ButlerScene state={state([session(), session({ session_id: 'x2', agent: 'codex', title: '补完参赛网页架构', activity: { line: '在跑测试', at: '2026-09-25T07:19:30.000Z' } })])} onOpen={vi.fn()} onConfirm={vi.fn()}>粒子</ButlerScene>)
    const stage = screen.getByLabelText('执行中的事项')
    expect(stage.textContent).not.toContain('等待下一次进度回传')
    expect(within(stage).getByText('Desktop-workbench 统筹交接')).toBeInTheDocument()
    expect(within(stage).getByText('先说结论：大约 16:30 能先用上第一批 · 3 分钟前')).toBeInTheDocument()
    expect(within(stage).getByText('在跑测试 · 刚刚')).toBeInTheDocument()
  })

  it('事项自己的卡:挂着的会话在跑且有「在做什么」就用它;都没有也写「读不到它在做什么」', () => {
    expect(sceneProgressLine({ pending: false, executors: [{ id: 'dsh:s', label: 'dsh / s', offline: false, session: session({ agent: 'dsh', activity: { line: '在改文件', at: '2026-09-25T07:10:00.000Z' } }) }] }, NOW)).toBe('在改文件 · 10 分钟前')
    expect(sceneProgressLine({ pending: false, executors: [] }, NOW)).toBe(SESSION_ACTIVITY_UNKNOWN)
    expect(sceneProgressLine({ pending: true, executors: [] }, NOW)).toBe('会话开启中')
  })

  it('几分钟前:刚刚 / n 分钟前 / n 小时前;时刻坏了不写', () => {
    expect(agoLabel('2026-09-25T07:19:40.000Z', NOW)).toBe('刚刚')
    expect(agoLabel('2026-09-25T07:05:00.000Z', NOW)).toBe('15 分钟前')
    expect(agoLabel('2026-09-25T04:20:00.000Z', NOW)).toBe('3 小时前')
    expect(agoLabel('坏的', NOW)).toBeUndefined()
    expect(sessionDisplayTitle({ title: '  ' }, 'Kimi')).toBe('Kimi 的一条会话')
    // 哪一家按字符串认:自动发现的一家(卡 Q)没进名字表也照样有标题,用它自己的 id。
    expect(sessionDisplayTitle({}, agentTitle('muse'))).toBe('muse 的一条会话')
  })
})

describe('点开:在工作台里看,不露会话 id、不跳 DSH', () => {
  const digest: SessionDigestView = {
    agent: 'claude', session_id: 'd9991aac-5e0e-4ba6-8dcf-7170236b3763', title: 'Desktop-workbench 统筹交接', project: 'ben-dsh-workbench',
    status: 'running', elapsed_sec: 840,
    activity: { line: '先说结论：大约 16:30 能先用上第一批', at: '2026-09-25T07:17:00.000Z' },
    rounds: [
      { ask: '两件都交给卡 P', reply: '两件都交给了卡 P,按下面的做法来。', did: '派了 1 次助手', at: '2026-09-25T07:00:44.000Z' },
      { ask: '还有多久', reply: '先说结论：大约 16:30 能先用上第一批，四张卡全部合进去。', at: '2026-09-25T07:16:08.000Z' },
    ],
    read_at: NOW,
  }

  it('★项目、现在怎样、在做什么、最近几轮;没有「打开对话」、没有会话 id', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => digest }))
    render(<ButlerScene state={state([session()])} onOpen={vi.fn()} onConfirm={vi.fn()} talk={{ baseUrl: '/svc', fetchImpl: fetchImpl as unknown as typeof fetch }}>粒子</ButlerScene>)
    await userEvent.click(screen.getByRole('button', { name: '查看事项:Desktop-workbench 统筹交接' }))
    const focus = screen.getByLabelText('当前聚焦事项')
    expect(within(focus).getByText('在「ben-dsh-workbench」项目里')).toBeInTheDocument()
    expect(within(focus).getByText('Claude · 进行中 · 14 分钟')).toBeInTheDocument()
    expect(within(focus).getByText('先说结论：大约 16:30 能先用上第一批 · 3 分钟前')).toBeInTheDocument()
    expect(await within(focus).findByText('还有多久')).toBeInTheDocument()
    expect(within(focus).getByText('两件都交给了卡 P,按下面的做法来。')).toBeInTheDocument()
    expect(fetchImpl).toHaveBeenCalledWith('/svc/sessions/digest?agent=claude&id=d9991aac-5e0e-4ba6-8dcf-7170236b3763')
    expect(focus.textContent).not.toMatch(/d9991aac|claude \/|打开对话/)
  })

  it('读不到那条会话的记录:说读不到(服务端那句人话),不拿别的凑', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({ error: '读不到这条会话的记录' }) }))
    render(<ButlerScene state={state([session()])} onOpen={vi.fn()} onConfirm={vi.fn()} talk={{ baseUrl: '/svc', fetchImpl: fetchImpl as unknown as typeof fetch }}>粒子</ButlerScene>)
    await userEvent.click(screen.getByRole('button', { name: '查看事项:Desktop-workbench 统筹交接' }))
    expect(await within(screen.getByLabelText('当前聚焦事项')).findByText('读不到这条会话的记录')).toBeInTheDocument()
  })

  it('没接取数(老调用方):只画卡片上已有的几样,不画「最近几轮」', async () => {
    render(<ButlerScene state={state([session()])} onOpen={vi.fn()} onConfirm={vi.fn()}>粒子</ButlerScene>)
    await userEvent.click(screen.getByRole('button', { name: '查看事项:Desktop-workbench 统筹交接' }))
    const focus = screen.getByLabelText('当前聚焦事项')
    expect(within(focus).getByText('Claude · 进行中 · 14 分钟')).toBeInTheDocument()
    expect(within(focus).queryByLabelText('最近几轮')).toBeNull()
  })
})
