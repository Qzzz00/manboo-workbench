/**
 * 事务官那一页的卡**按会话画**(2026-09-26,卡 ST)。
 *
 * 维护者 19:10 原话:「Grok Bot 的标题显示不全,Muse 那个待确认的也不在上面显示,
 * 我发的任务随机抽查大部分都没变成卡片在事务官那一页展示出来」;
 * 19:20 拍板:「机器上正在跑的、我安排的事,不管是通过事务官发的还是直接在那家客户端里说的,就是一张卡。」
 *
 * 用的都是 09-26 19:10 从生产 `/state` 只读量来的真数据(对话名、最后一句、那一问)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerScene } from '../src/client/ButlerScene.tsx'
import { buildButlerScene } from '../src/client/butlerSceneModel.ts'
import type { AgentEntryView, AgentSessionView, WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)

const NOW = '2026-09-26T11:10:00.000Z'

function session(one: Partial<AgentSessionView> & { session_id: string }): AgentSessionView {
  return {
    agent: 'x', project: '', status: 'done', elapsed_sec: 60, unread: false, updated_at: NOW, via: 'window',
    ...one,
  } as AgentSessionView
}

function entry(one: Partial<AgentEntryView> & { id: string, name: string }): AgentEntryView {
  return {
    color: '#7f7f7f', found: { how: 'patrol', at: '', basis: '' }, sources: [], status: 'idle', gaps: {},
    sessions: [], counts: { running: 0, waiting: 0, unread: 0 },
    ...one,
  } as AgentEntryView
}

/** 09-26 19:10 真机那一份:Grok Bot 在问他、Muse 侧栏里六条对话、Claude 有一条文件型会话。 */
function stageState(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  const grok = entry({
    id: 'com.anysphere.sand',
    name: 'Grok Bot',
    color: '#4ea1ff',
    sessions: [session({
      agent: 'com.anysphere.sand',
      session_id: 'window:00f9389b',
      title: '看完后想怎么用?这一版先把标题读全,再决定要不要合',
      summary: '先推进哪件?你说一个我就动手,别的先放着,我这边都排好了顺序等你点头。',
      ask: { kind: 'choose', question: '先推进哪件?', since: NOW, by: 'rules' },
      unread: true,
    })],
  })
  const muse = entry({
    id: 'muse',
    name: 'Muse',
    color: '#c77dff',
    sessions: [
      session({ agent: 'muse', session_id: 'window:82c376e8', title: '主要聊天', summary: '评估时就盯三个指标:任务完成度、你中途救场的次数、返工率。', status: 'running' }),
      session({ agent: 'muse', session_id: 'window:aa', title: '把虚拟形象改为鲸鱼' }),
      session({ agent: 'muse', session_id: 'window:bb', title: '询问 Grok4.7 桌面客户端' }),
    ],
  })
  const claude = entry({
    id: 'claude',
    name: 'Claude',
    color: '#eb714d',
    sessions: [session({ agent: 'claude', session_id: 'd2ef4d6d', via: 'sessions', title: '工作台记忆与编排优化方案评估', summary: '已经把三条方案写进 docs,等你挑一个。' })],
  })
  return {
    agents: [], sessions: [], quota: {}, stale: false, now: NOW,
    tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
    butler_inbox: { items: [] },
    agent_registry: { entries: [entry({ id: 'dsh', name: '事务官', self: true }), claude, muse, grok], asking: [], notices: [] },
    ...overrides,
  } as WorkbenchState
}

describe('台上的卡按会话画(卡 ST)', () => {
  it('★每一条会话各一张卡:文件型 /state.sessions 那条 + 窗口型每条对话;没挂事项也是卡', () => {
    const model = buildButlerScene(stageState())
    // 事项板上一条都没登记(维护者 19:20:「事项板上有没有登记不影响它成卡」),台上照样五张。
    expect(model.items.filter(item => item.executing).map(item => item.title)).toEqual(['主要聊天'])
    expect(model.stage.map(item => item.title)).toEqual([
      // 在跑的那条(它已经作为「没挂事项的在跑会话」进了 items,台上不重复摆第二张)
      '主要聊天',
      // 等你
      '看完后想怎么用?这一版先把标题读全,再决定要不要合',
    ])
    /*
     * **空闲的老对话不上台**(2026-09-26 晚,维护者看着台上一排「Initiating A New Conversation」「Grok Bot 的一条会话」:
     * 「多了好多乱七八糟,感觉好久之前的任务啊」)。台上是「此刻在动 / 在等他 / 做完他还没看」的;
     * 空闲的那几条在各家标签与会话列表里,不占台。
     */
    expect(model.stage.map(item => item.sessionCard?.status)).toEqual(['在跑', '等你'])
    expect(model.stage.map(item => item.sessionCard?.tone)).toEqual(['running', 'ask'])
    // 同一条会话只有一张卡(在跑那条不会既是 items 里那张、又另成一张)。
    expect(new Set(model.stage.map(item => item.id)).size).toBe(model.stage.length)
  })

  it('普通窗口散会话与待问不占业务执行舞台，保留可打开的会话入口', () => {
    render(<ButlerScene state={stageState()} onOpen={vi.fn()} onConfirm={vi.fn()}>粒子</ButlerScene>)
    expect(screen.getByLabelText('执行中的事项').children).toHaveLength(0)
    const sessions = screen.getByLabelText('会话与排队')
    const button = within(sessions).getByRole('button', { name: /看完后想怎么用/ })
    expect(button).toHaveTextContent('等你')
    fireEvent.click(button)
    expect(screen.getByLabelText('当前聚焦事项')).toHaveTextContent('看完后想怎么用')
  })

  it('业务数只取公共清单的事项，散会话与待验不凑数', () => {
    const state = stageState({ running: { count: 1, items: [{ key: 'session:muse:pm', agent: 'muse', session_id: 'pm', text: '统筹' }] }, waiting: { count: 2, items: [] } })
    render(<ButlerScene state={state} onOpen={vi.fn()} onConfirm={vi.fn()}>粒子</ButlerScene>)
    expect(screen.getByRole('button', { name: '业务任务正在执行 0 件' })).toBeInTheDocument()
    expect(screen.getByText(/未关联事项的会话 1/)).toBeInTheDocument()
  })

  it('已关联的来源归事项详情;那家 App 没开(offline)的不摆上台', () => {
    const base = stageState()
    const registry = base.agent_registry!
    const state: WorkbenchState = {
      ...base,
      tasks: { ...base.tasks!, tasks: [{
        id: 't-9', title: '把标题读全', status: 'doing', direction: 'mine', source: { kind: 'manual' },
        created_at: NOW, updated_at: NOW, links: [{ agent: 'claude', session_id: 'd2ef4d6d' }],
      }] },
      agent_registry: {
        ...registry,
        entries: registry.entries.map(one => one.id === 'claude'
          // Claude 那条做完、他还没看(做完未读才上台;空闲的不上)。
          ? { ...one, sessions: one.sessions.map(s => ({ ...s, unread: true })) }
          : one.id !== 'muse' ? one : { ...one, sessions: one.sessions.map(s => ({ ...s, status: 'offline' as const })) }),
      },
    } as WorkbenchState
    const model = buildButlerScene(state)
    // Muse 三条全 offline → 一张都不摆(顶栏那句「Muse 没开」才是它的去处)。
    expect(model.stage.some(item => item.sessionCard?.agent === 'muse')).toBe(false)
    // The linked source remains visible in the owning item's details, including its result.
    expect(model.stage.map(item => item.title)).toEqual(['看完后想怎么用?这一版先把标题读全,再决定要不要合'])
    expect(model.items.find(item => item.id === 't-9')?.executors.map(one => one.id)).toEqual(['claude:d2ef4d6d'])
  })
})
