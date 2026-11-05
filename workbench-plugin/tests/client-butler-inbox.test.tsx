/**
 * 事务官档(2026-09-11 改版:中央声纹球 + 两侧事项卡片堆;2026-09-10 的事项收件箱是它的前身)。
 *
 * 守四件事:汇报条**是代码拼的、不编**;左右两堆各显示什么(状态点、等待原因、折叠);
 * 点一张卡要跳到它底下那段对话;输入一句话就是建一条事项(含「会话未开」的降级回执)。
 * 右下角浮窗的功能(全部暂停 / 试铃 / 在盯着的事 / 提议)并进这一档,一项不能少(PRD §9)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerInbox, type ButlerControls, type ButlerInboxProps } from '../src/client/ButlerInbox.tsx'
import { butlerReportLine, mineGroups } from '../src/client/butlerInbox.ts'
import { STYLE } from '../src/client/style.ts'
import type { SessionView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { BUTLER_SESSION_OFFLINE_NOTE } from '../src/protocol.ts'

afterEach(cleanup)

function state(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [],
    sessions: [],
    quota: {},
    now: '2026-09-10T09:00:00.000Z',
    stale: false,
    ...over,
  }
}

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't1', title: '把展示台的黄历接上', status: 'doing', direction: 'mine', source: { kind: 'manual' },
    created_at: '2026-09-10T01:00:00.000Z', updated_at: '2026-09-10T02:00:00.000Z',
    ...over,
  }
}

function tasksOf(...tasks: TaskView[]) {
  return { tasks, sprints: [], modules: [], project_meta: [] }
}

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'dsh', session_id: 's-1', project: '工作台', status: 'running',
    elapsed_sec: 10, unread: false, updated_at: '2026-09-10T09:00:00.000Z',
    ...over,
  }
}

function controls(over: Partial<ButlerControls> = {}): ButlerControls {
  return {
    paused: false,
    testRinging: false,
    onPause: vi.fn(),
    onTestRing: vi.fn(),
    onCancelWatch: vi.fn(),
    onDismissBrief: vi.fn(),
    proposals: [],
    ...over,
  }
}

function props(over: Partial<ButlerInboxProps> = {}): ButlerInboxProps {
  return {
    state: state(),
    baseUrl: 'http://127.0.0.1:8791',
    fetchImpl: vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })) as unknown as typeof fetch,
    onOpenConversation: vi.fn(),
    draft: '',
    onDraftChange: vi.fn(),
    visible: true,
    controls: controls(),
    ...over,
  }
}

describe('汇报条:代码生成,四段口径写死', () => {
  it('★在跑几件 / 等我确认几件 / 哨兵最近一次 / 排期赶不上几项', () => {
    // 第二个参数是「执行中的事项数」(2026-09-16 口径统一):与球下「执行 n」同一个数,不再自己数 sessions。
    const line = butlerReportLine(state({
      sessions: [session(), session({ session_id: 's-2' }), session({ session_id: 's-3', status: 'waiting' })],
      butler_inbox: {
        items: [
          { id: 'confirm:t1', kind: 'confirm', title: '甲', status: 'confirm' },
          { id: 'sentinel:w1', kind: 'sentinel', title: '构建产物出来了', at: '2026-09-10T11:20:00.000Z' },
          { id: 'risk:p1', kind: 'risk', title: 'Aiboo 排期赶不上' },
        ],
      },
      sentinel: {
        watches: [{
          id: 'w1', kind: 'file', target: '/tmp/a', note: '构建产物出来了',
          interval_sec: 60, cooldown_sec: 300, created_at: '2026-09-10T00:00:00.000Z', fires: 1,
          last_fired_at: '2026-09-10T11:20:00.000Z',
        }],
      },
    }), 2)

    expect(line).toContain('业务任务执行 2 件')
    // 2026-09-25(卡 M 追加):这一段数的是「等你」那一堆(src/waiting.ts),与球下「等你 n」、手机「等你确认」同一个数。
    expect(line).toContain('等你 1 件')
    expect(line).toContain('哨兵最近一次')
    expect(line).toContain('「构建产物出来了」')
    expect(line).toContain('排期赶不上 1 项')
  })

  it('一条监视项都没有 → 哨兵那段整段不说(说「没动静」会让人以为在盯着)', () => {
    expect(butlerReportLine(state(), 0)).toBe('业务任务执行 0 件 · 等你 0 件')
  })

  it('★执行数取不到(任务板没接 / 冻结)→ 那段不说,不写 0(2026-09-16)', () => {
    expect(butlerReportLine(state(), undefined)).toBe('等你 0 件')
  })

  it('在盯但一次都没命中 → 如实说「哨兵还没动静」', () => {
    const line = butlerReportLine(state({
      sentinel: {
        watches: [{
          id: 'w1', kind: 'port', target: '3080', note: 'DSH 掉了要知道',
          interval_sec: 60, cooldown_sec: 300, created_at: '2026-09-10T00:00:00.000Z', fires: 0,
        }],
      },
    }), 0)
    expect(line).toContain('哨兵还没动静')
  })

  it('排期一项都不赶不上 → 那段不说(「赶不上 0 项」是句废话)', () => {
    expect(butlerReportLine(state({ butler_inbox: { items: [] } }), 0)).not.toContain('排期')
  })

  it('★汇报条压成一行放在球下面,可点展开;「运行会话 n 个」与球下「执行 n」永远是同一个数', async () => {
    // 真机 2026-09-16:顶栏「运行会话 3 个」、球下「执行 0」——一条在数 sessions,一条在数事项。
    // 这里 sessions 里有一条 running 但没挂在任何事项上:两处都得说 0。
    render(<ButlerInbox {...props({ state: state({ sessions: [session()], tasks: tasksOf(), butler_inbox: { items: [] } }) })} />)
    const report = screen.getByRole('status', { name: '汇报条' })
    expect(report).toHaveTextContent('业务任务执行 0 件 · 等你 0 件')
    expect(screen.getByText('执行 0 · 排队 0 · 等你 0')).toBeInTheDocument()
    expect(report).toHaveAttribute('data-open', 'false')
    await userEvent.click(within(report).getByRole('button', { name: '展开汇报条' }))
    expect(report).toHaveAttribute('data-open', 'true')
  })
})

describe('mineGroups:「我交给事务官的」怎么分组', () => {
  it('在办与办完分两摞;取消也算办完(不是删掉)', () => {
    const groups = mineGroups(tasksOf(
      task({ id: 'a', status: 'todo' }),
      task({ id: 'b', status: 'done' }),
      task({ id: 'c', status: 'canceled' }),
      task({ id: 'd', status: 'blocked' }),
    ))
    expect(groups.open.map(item => item.id)).toEqual(['a', 'd'])
    expect(groups.finished.map(item => item.id)).toEqual(['b', 'c'])
  })

  it('★「等我确认」的不在下半区出现——它已经升到上半区了,同一条不摆两遍', () => {
    const groups = mineGroups(tasksOf(task({ id: 'a', status: 'confirm' })))
    expect(groups.open).toHaveLength(0)
    expect(groups.finished).toHaveLength(0)
  })

  it('看板上手建的卡(没有 direction)不算事项,不进收件箱', () => {
    const { direction: _dropped, ...plain } = task({ id: 'z' })
    expect(mineGroups(tasksOf(plain as TaskView)).open).toHaveLength(0)
  })
})

describe('中央的球与它下面那一行', () => {
  it('混合执行/审批事项在需留意收纳中仍提示有执行者运行，聚焦后保持工作状态', async () => {
    render(<ButlerInbox {...props({ state: state({
      tasks: tasksOf(task({ links: [{ agent: 'dsh', session_id: 's-1' }, { agent: 'codex', session_id: 's-2' }] })),
      butler_inbox: { items: [] },
      sessions: [session(), session({ agent: 'codex', session_id: 's-2', status: 'waiting', wait_reason: 'approval' })],
    }) })} />)
    expect(within(screen.getByLabelText('执行中的事项')).getByText('需留意')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '查看事项:把展示台的黄历接上' })).toHaveLength(1)
    // 2026-10-04:这一件在「需留意」里(挂的会话在等人),于是球下多一个「受阻 1」——
    // 历史阻塞从此只在这一行里出现,不再把球染红(见 client-orb-notice-20261004)。
    expect(screen.getByText('执行 1 · 排队 0 · 等你 0 · 受阻 1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '查看事项:把展示台的黄历接上' }))
    expect(screen.getByText('正在执行当前事项')).toBeInTheDocument()
  })
  it('待命:没有事项、输入框空着', () => {
    render(<ButlerInbox {...props({ state: state({ tasks: tasksOf(), butler_inbox: { items: [] } }) })} />)
    expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'idle')
    expect(screen.getByText('执行 0 · 排队 0 · 等你 0')).toBeInTheDocument()
  })

  it('没有真实执行会话证据时，记录进行中也不冒充正在执行', () => {
    render(<ButlerInbox {...props({ state: state({ tasks: tasksOf(task()), butler_inbox: { items: [] } }) })} />)
    expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'idle')
    expect(screen.getByText('执行 0 · 排队 0 · 等你 0')).toBeInTheDocument()
  })

  it('★有事项在执行,球就是在办(流沙),不必先点它(Ben 2026-09-16:进行中该一直转)', () => {
    render(<ButlerInbox {...props({ state: state({
      tasks: tasksOf(task({ links: [{ agent: 'dsh', session_id: 's-1' }], conversation: { agent: 'dsh', session_id: 's-1' } })),
      butler_inbox: { items: [] },
      sessions: [session()],
    }) })} />)
    expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'busy')
    expect(screen.getByText('正在执行 1 件')).toBeInTheDocument()
    expect(screen.getByText('执行 1 · 排队 0 · 等你 0')).toBeInTheDocument()
  })

  it('刚交办未开工进排队入口，业务执行舞台不画排队连线，球仍待命', () => {
    const { container } = render(<ButlerInbox {...props({ state: state({
      now: '2026-09-10T09:00:05.000Z',
      tasks: tasksOf(task({ status: 'todo', created_at: '2026-09-10T09:00:00.000Z', updated_at: '2026-09-10T09:00:00.000Z' })),
      butler_inbox: { items: [] },
    }) })} />)
    expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'idle')
    expect(screen.getByText('执行 0 · 排队 1 · 等你 0')).toBeInTheDocument()
    const stage = screen.getByLabelText('执行中的事项')
    expect(within(stage).queryByText('排队')).toBeNull()
    expect(screen.getByLabelText('会话与排队')).toHaveTextContent('排队')
    expect(container.querySelector('[data-task-link="t1"][data-pending="true"]')).toBeNull()
    expect(screen.queryByText('进行中')).not.toBeInTheDocument()
  })

  it('★进行中的卡显示「进行中 · n 分钟」,不是建卡时刻(2026-09-16 第 4 条)', () => {
    render(<ButlerInbox {...props({ state: state({
      now: '2026-09-10T09:12:30.000Z',
      tasks: tasksOf(task({ links: [{ agent: 'dsh', session_id: 's-1' }], conversation: { agent: 'dsh', session_id: 's-1' }, updated_at: '2026-09-10T09:00:00.000Z' })),
      butler_inbox: { items: [] },
      sessions: [session()],
    }) })} />)
    expect(within(screen.getByLabelText('执行中的事项')).getByText('进行中 · 12 分钟')).toBeInTheDocument()
  })

  it('★需要你:有「等我确认」的卡 → 琥珀色', () => {
    render(<ButlerInbox {...props({
      state: state({
        tasks: tasksOf(),
        butler_inbox: { items: [{ id: 'confirm:t1', kind: 'confirm', title: '甲', status: 'confirm' }] },
      }),
    })} />)
    const orb = screen.getByRole('img', { name: /^事务官:/ })
    expect(orb).toHaveAttribute('data-state', 'needs-you')
    expect(orb).toHaveAttribute('data-amber', 'true')
    expect(screen.getByText('执行 0 · 排队 0 · 等你 1')).toBeInTheDocument()
  })

  it('★聆听:本期没有电脑收音,输入框聚焦或有字就算聆听', async () => {
    const { rerender } = render(<ButlerInbox {...props()} />)
    await userEvent.click(screen.getByLabelText('交给事务官一件事'))
    expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'listening')
    await userEvent.tab()
    expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'idle')
    rerender(<ButlerInbox {...props({ draft: '记一笔' })} />)
    expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'listening')
  })

  it('★数字取不到(没接任务板)→ 那一行整行不显示,不编数', () => {
    render(<ButlerInbox {...props({ state: state() })} />)
    expect(screen.queryByText(/执行 \d+ · 排队/)).toBeNull()
  })
})

describe('左堆:事务官交给我的', () => {
  it('★显示状态点、等待原因与时间', () => {
    render(<ButlerInbox {...props({
      state: state({
        butler_inbox: {
          items: [
            { id: 'confirm:t1', kind: 'confirm', title: '黄历接上了', status: 'confirm', note: '1 件交付物', at: '2026-09-10T03:04:00.000Z' },
            { id: 'session:s-9', kind: 'session', title: '改排序', wait_reason: 'approval', conversation: { agent: 'dsh', session_id: 's-9' } },
          ],
        },
      }),
    })} />)

    const left = screen.getByLabelText('事项收纳')
    const cards = within(left).getAllByRole('listitem')
    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveAttribute('data-notice', 'confirmation')
    expect(within(cards[0] as HTMLElement).getByText('1 件交付物')).toBeInTheDocument()
    expect(within(cards[0] as HTMLElement).getByText(/等我确认/)).toBeInTheDocument()
    expect(within(cards[0] as HTMLElement).getByText(/\d{2}:\d{2}/)).toBeInTheDocument()
    expect(cards[1]).toHaveAttribute('data-notice', 'confirmation')
    expect(within(cards[1] as HTMLElement).getByText('等审批')).toBeInTheDocument()
  })

  it('摘要保留全部事项，点击其中一件展开；返回待机重新收纳', async () => {
    const items = ['甲', '乙', '丙', '丁', '戊'].map((title, index) => ({ id: `sentinel:${index}`, kind: 'sentinel' as const, title }))
    render(<ButlerInbox {...props({ state: state({ butler_inbox: { items } }) })} />)
    const storage = screen.getByLabelText('事项收纳')
    expect(within(storage).getAllByRole('listitem')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: '展开全部需要留意' }))
    expect(within(storage).getAllByRole('listitem')).toHaveLength(5)
    await userEvent.click(within(storage).getByRole('button', { name: '查看事项:戊' }))
    expect(within(screen.getByLabelText('当前聚焦事项')).getByText('戊')).toBeInTheDocument()
    expect(within(storage).getAllByRole('listitem')).toHaveLength(5)
    await userEvent.click(screen.getByRole('button', { name: '返回待机' }))
    expect(within(storage).getAllByRole('listitem')).toHaveLength(5)
  })

  it('★点一张卡 → 在工作台里看;最底下「看原始对话」才把那条会话交给上层去打开(卡 M)', async () => {
    const onOpenConversation = vi.fn()
    render(<ButlerInbox {...props({
      onOpenConversation,
      state: state({
        butler_inbox: {
          items: [{ id: 'session:s-9', kind: 'session', title: '改排序', conversation: { agent: 'dsh', session_id: 's-9' } }],
        },
      }),
    })} />)

    await userEvent.click(screen.getByRole('button', { name: '查看事项:改排序' }))
    // 整张摊在这一栏上面(不是挤在球下那一行里),没有「打开对话 ↗」那颗一点就换成 DSH 原始界面的键
    const sheet = screen.getByRole('dialog', { name: '当前聚焦事项' })
    expect(sheet).toHaveClass('ben-wb__item-sheet')
    expect(within(sheet).queryByRole('button', { name: /打开对话/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '看原始对话' }))
    expect(onOpenConversation).toHaveBeenCalledWith('s-9')
    await userEvent.click(within(sheet).getByRole('button', { name: '返回待机' }))
    expect(screen.queryByRole('dialog', { name: '当前聚焦事项' })).toBeNull()
  })

  it('★「等我确认」那档带一颗确认键 → 打看板那条唯一的改状态路由', async () => {
    const calls: { url: string, body: unknown }[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return { ok: true, json: async () => ({ ok: true }) }
    }) as unknown as typeof fetch

    render(<ButlerInbox {...props({
      fetchImpl,
      state: state({
        butler_inbox: { items: [{ id: 'confirm:t1', kind: 'confirm', title: '黄历接上了', status: 'confirm', task_id: 't1' }] },
      }),
    })} />)

    await userEvent.click(screen.getByRole('button', { name: '查看事项:黄历接上了' }))
    await userEvent.click(screen.getByRole('button', { name: '确认收下:黄历接上了' }))
    expect(calls).toEqual([{ url: 'http://127.0.0.1:8791/task/move', body: { id: 't1', status: 'done' } }])
  })

  it('别的档没有确认键——那几条不是"等我验收"', () => {
    render(<ButlerInbox {...props({
      state: state({ butler_inbox: { items: [{ id: 'sentinel:w1', kind: 'sentinel', title: '构建产物出来了' }] } }),
    })} />)
    expect(screen.queryByRole('button', { name: '确认收下:构建产物出来了' })).toBeNull()
  })

  it('★没有会话的那档(哨兵)不画成按钮——点了没反应比不给点更糟', () => {
    render(<ButlerInbox {...props({
      state: state({ butler_inbox: { items: [{ id: 'sentinel:w1', kind: 'sentinel', title: '构建产物出来了' }] } }),
    })} />)

    expect(screen.getByText('构建产物出来了')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开事项:构建产物出来了' })).toBeNull()
  })

  it('★打开会话抛了(DSH 里已经没有这条)→ 界面上如实说一句,不是"点了没反应"', async () => {
    const onOpenConversation = vi.fn(() => { throw new Error('unknown session') })
    render(<ButlerInbox {...props({
      onOpenConversation,
      state: state({
        butler_inbox: {
          items: [{ id: 'session:s-9', kind: 'session', title: '改排序', conversation: { agent: 'dsh', session_id: 's-9' } }],
        },
      }),
    })} />)

    await userEvent.click(screen.getByRole('button', { name: '查看事项:改排序' }))
    await userEvent.click(screen.getByRole('button', { name: '看原始对话' }))
    expect(await screen.findByText(/打不开/)).toBeInTheDocument()
  })

  it('★浮窗的「提议」并进左堆:灰点、待拍板', () => {
    render(<ButlerInbox {...props({
      controls: controls({
        proposals: [{
          id: 'p1', layer: 'transaction', module_id: 'projects', text: '给 Aiboo 定个 DDL',
          evidence_days: [], preview: '……', adopted: false,
        }],
      }),
    })} />)
    const left = screen.getByLabelText('事项收纳')
    const card = within(left).getByRole('listitem')
    expect(card).toHaveAttribute('data-notice', 'neutral')
    expect(within(card).getByText('给 Aiboo 定个 DDL')).toBeInTheDocument()
    expect(within(card).getByText('待拍板')).toBeInTheDocument()
  })

  it('空态如实说一句,不留白', () => {
    render(<ButlerInbox {...props()} />)
    expect(within(screen.getByLabelText('事项收纳')).getByText('事项数据未接入')).toBeInTheDocument()
  })
})

describe('右堆:我交给事务官的', () => {
  it('★在办的白点带状态;点开在工作台里看,「看原始对话」才跳到它那段对话(卡 M)', async () => {
    const onOpenConversation = vi.fn()
    render(<ButlerInbox {...props({
      onOpenConversation,
      state: state({
        tasks: tasksOf(task({ project_id: 'holo', conversation: { agent: 'dsh', session_id: 'sess-1' } })),
        projects: {
          projects: [{ id: 'holo', name: '展示台', stage: 'MVP 开发', links: [], session_count: 0, idle: false }],
          pending: [], scan_errors: [], scanned_at: '2026-09-10T00:00:00.000Z',
        },
      }),
    })} />)

    const right = screen.getByLabelText('事项收纳')
    const card = within(right).getByRole('listitem')
    expect(card).toHaveAttribute('data-notice', 'neutral')
    expect(within(card).getByText(/进行中/)).toBeInTheDocument()
    expect(within(card).getByText('展示台')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: '查看事项:把展示台的黄历接上' }))
    await userEvent.click(screen.getByRole('button', { name: '看原始对话' }))
    expect(onOpenConversation).toHaveBeenCalledWith('sess-1')
  })

  it('★开不出会话的那条在排队记录如实标「会话未开」,而不是装成在办', async () => {
    render(<ButlerInbox {...props({ state: state({ tasks: tasksOf(task({ status: 'todo' })) }) })} />)
    await userEvent.click(screen.getByText('排队 1 · 已取消 0'))
    expect(screen.getByText('会话未开')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开事项:把展示台的黄历接上' })).toBeNull()
  })

  it('办完的:会话没删,标「会话已归档」,点开照样能看', async () => {
    render(<ButlerInbox {...props({
      state: state({
        tasks: tasksOf(task({
          status: 'done',
          conversation: { agent: 'dsh', session_id: 'sess-1', archived_at: '2026-09-10T08:00:00.000Z' },
        })),
      }),
    })} />)

    const right = screen.getByLabelText('事项收纳')
    expect(within(right).getByRole('listitem')).toHaveAttribute('data-notice', 'completed')
    expect(within(right).getByText('会话已归档')).toBeInTheDocument()
    await userEvent.click(within(right).getByRole('button', { name: '查看事项:把展示台的黄历接上' }))
    expect(screen.getByRole('button', { name: '看原始对话' })).toBeInTheDocument()
  })

  it('空态如实说一句', () => {
    render(<ButlerInbox {...props()} />)
    expect(within(screen.getByLabelText('事项收纳')).getByText('事项数据未接入')).toBeInTheDocument()
  })
})

describe('球旁的抽屉:浮窗搬家过来的那几样,一项不能少(PRD §9)', () => {
  it('★全部暂停 / 试铃 都在,各触发各的回调;暂停态文案含「不控制 Agent 进程」', async () => {
    const onPause = vi.fn()
    const onTestRing = vi.fn()
    const { rerender } = render(<ButlerInbox {...props({ controls: controls({ onPause, onTestRing }) })} />)
    await userEvent.click(screen.getByRole('button', { name: '事务官抽屉' }))
    await userEvent.click(screen.getByRole('button', { name: '⏸ 全部暂停' }))
    await userEvent.click(screen.getByRole('button', { name: '🔔 试铃' }))
    expect(onPause).toHaveBeenCalledTimes(1)
    expect(onTestRing).toHaveBeenCalledTimes(1)

    // 同一个实例重渲染,抽屉还开着(它是这个组件自己的运行态)。
    rerender(<ButlerInbox {...props({ controls: controls({ paused: true, testRinging: true }) })} />)
    expect(screen.getByRole('button', { name: '▶ 恢复' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '🔕 停铃' })).toBeInTheDocument()
    expect(screen.getByText(/不控制 Agent 进程/)).toBeInTheDocument()
  })

  it('★在盯着的事:每条 note、目标、最近一次变化,✕ 取消', async () => {
    const onCancelWatch = vi.fn()
    render(<ButlerInbox {...props({
      controls: controls({
        onCancelWatch,
        sentinel: {
          watches: [{
            id: 'w1', kind: 'file', target: '/tmp/a', note: '构建产物出来了',
            interval_sec: 60, cooldown_sec: 300, created_at: '2026-09-10T00:00:00.000Z', fires: 0,
          }],
        },
      }),
    })} />)
    await userEvent.click(screen.getByRole('button', { name: '事务官抽屉' }))
    expect(screen.getByText('构建产物出来了')).toBeInTheDocument()
    expect(screen.getByText(/还没有变化/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '取消监视:构建产物出来了' }))
    expect(onCancelWatch).toHaveBeenCalledWith('w1')
  })

  /**
   * 「现在跑一遍」(2026-10-13,卡「早报:界面上能随时跑一遍…」):
   * 演示与展位要能当场重放早报,路由早就有(`POST /routine/run` / `POST /feed/run`),界面上一颗键都没有。
   */
  describe('现在跑一遍:早报与资讯各一颗键', () => {
    const routinesView = (running: ('morning' | 'evening' | 'lint')[] = []) => ({
      next: {}, running, config: { morning: { enabled: true, not_before: '06:00' }, evening: { enabled: true, at: '18:30' }, lint: { enabled: true, weekday: 5 } },
      last: {},
    })

    it('★没接例程服务 → 两颗键都不画(不画一颗按下去只会 404 的键)', async () => {
      render(<ButlerInbox {...props()} />)
      await userEvent.click(screen.getByRole('button', { name: '事务官抽屉' }))
      expect(screen.queryByRole('button', { name: '现在出一份早报' })).toBeNull()
      expect(screen.queryByRole('button', { name: '现在搜一轮' })).toBeNull()
    })

    it('★点「现在出一份早报」→ POST /routine/run {name:morning};回执说清出来了没有', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, run: { name: 'morning', status: 'ok' } }),
      })) as unknown as typeof fetch
      render(<ButlerInbox {...props({ fetchImpl, state: state({ routines: routinesView() as never }) })} />)
      await userEvent.click(screen.getByRole('button', { name: '事务官抽屉' }))
      await userEvent.click(screen.getByRole('button', { name: '现在出一份早报' }))
      expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8791/routine/run', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ name: 'morning' }),
      }))
      expect(await screen.findByText(/早报出来了/)).toBeInTheDocument()
    })

    it('★DSH 不在线那一份:回执如实说只有程序拼的部分', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, run: { name: 'morning', status: 'no_session', session_offline: true } }),
      })) as unknown as typeof fetch
      render(<ButlerInbox {...props({ fetchImpl, state: state({ routines: routinesView() as never }) })} />)
      await userEvent.click(screen.getByRole('button', { name: '事务官抽屉' }))
      await userEvent.click(screen.getByRole('button', { name: '现在出一份早报' }))
      expect(await screen.findByText(new RegExp(BUTLER_SESSION_OFFLINE_NOTE))).toBeInTheDocument()
    })

    it('★在跑时灰掉并写「在出了」(真相是 /state.routines.running)', async () => {
      render(<ButlerInbox {...props({ state: state({ routines: routinesView(['morning']) as never }) })} />)
      await userEvent.click(screen.getByRole('button', { name: '事务官抽屉' }))
      const button = screen.getByRole('button', { name: '在出了…' })
      expect(button).toBeDisabled()
      expect(screen.queryByRole('button', { name: '现在出一份早报' })).toBeNull()
    })

    it('★409(这条例程正在跑)如实说,不装成出来了', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: false, status: 409, json: async () => ({ error: '这条例程正在跑' }),
      })) as unknown as typeof fetch
      render(<ButlerInbox {...props({ fetchImpl, state: state({ routines: routinesView() as never }) })} />)
      await userEvent.click(screen.getByRole('button', { name: '事务官抽屉' }))
      await userEvent.click(screen.getByRole('button', { name: '现在出一份早报' }))
      expect(await screen.findByText('这条例程正在跑')).toBeInTheDocument()
    })

    it('★点「现在搜一轮」→ POST /feed/run;回执用服务端那一句人话', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true, json: async () => ({ date: '2026-10-13', added: 3, note: '资讯:1 个项目搜到 3 条' }),
      })) as unknown as typeof fetch
      render(<ButlerInbox {...props({ fetchImpl, state: state({ routines: routinesView() as never }) })} />)
      await userEvent.click(screen.getByRole('button', { name: '事务官抽屉' }))
      await userEvent.click(screen.getByRole('button', { name: '现在搜一轮' }))
      expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8791/feed/run', expect.objectContaining({ method: 'POST' }))
      expect(await screen.findByText('资讯:1 个项目搜到 3 条')).toBeInTheDocument()
    })

    it('资讯没启用 → 404 那句话原样说出来', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: false, status: 404, json: async () => ({ error: '资讯未启用' }),
      })) as unknown as typeof fetch
      render(<ButlerInbox {...props({ fetchImpl, state: state({ routines: routinesView() as never }) })} />)
      await userEvent.click(screen.getByRole('button', { name: '事务官抽屉' }))
      await userEvent.click(screen.getByRole('button', { name: '现在搜一轮' }))
      expect(await screen.findByText('资讯未启用')).toBeInTheDocument()
    })
  })

  it('抽屉里的提议区:没有可提的就如实写「证据不足,暂不提议」(门槛在 proposals.ts)', async () => {
    render(<ButlerInbox {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: '事务官抽屉' }))
    expect(screen.getByText(/证据不足,暂不提议/)).toBeInTheDocument()
  })
})

describe('底部输入框:输入即建事项', () => {
  it('多行输入：Enter 交办，Shift+Enter 和中文合成确认不误发', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ say_id: 'say-1', items: [], say: { screen: '记下了。', spoken: '记下了。' } }) })) as unknown as typeof fetch
    render(<ButlerInbox {...props({ fetchImpl, draft: '整理第一项\n再核对第二项' })} />)
    const input = screen.getByLabelText('交给事务官一件事')
    expect(input.tagName).toBe('TEXTAREA')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(fetchImpl).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8791/butler/say', expect.objectContaining({ body: JSON.stringify({ text: '整理第一项\n再核对第二项', entrance: 'desktop' }) }))
    expect(await screen.findByText('记下了。')).toBeInTheDocument()
  })
  /**
   * 「接着刚才那件说了」(2026-09-25,卡 Y):服务端把这句话说进了上一件那条会话里、**没建新卡**,
   * 回执就不能说「事项已建下」—— 看板上并没有多一张卡,那是句假话。
   */
  it('★回执说 carried_on → 那一句写「接着刚才那件说了」,不说「事项已建下」', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ say_id: 'say-2', items: [], say: { screen: '接着刚才那件说了', spoken: '接着刚才那件说了' } }),
    })) as unknown as typeof fetch
    render(<ButlerInbox {...props({ fetchImpl, draft: '第二个按你说的来' })} />)
    await userEvent.click(screen.getByRole('button', { name: '交给事务官' }))
    expect(await screen.findByText('接着刚才那件说了')).toBeInTheDocument()
    expect(screen.queryByText('事项已建下')).toBeNull()
  })
  /**
   * 本体的毛病(2026-09-28 卡 FB,2026-10-01 重做):服务端认出这句话说的是工作台自己哪儿不对,
   * **一张卡都没建、一家都没派**,回的是那条反馈与事务官那一句。回执里不许出现「已建下」
   * (同 `carried_on` 那一条的理由:看板上并没有多一张卡)。
   */
  it('★回执带 feedback → 照服务端那一句摆,不说「已建下」', async () => {
    const note = '这是工作台本身的问题,我已经反馈给开发者了,修好会随更新到你这。'
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ say_id: 'say-feedback-1', items: [], say: { screen: note, spoken: note }, feedback: { id: 'fb-1', status: 'sent' }, note }),
    })) as unknown as typeof fetch
    render(<ButlerInbox {...props({ fetchImpl, draft: '发布计划那里没有标记今天是哪一天,这个不方便' })} />)
    await userEvent.click(screen.getByRole('button', { name: '交给事务官' }))
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8791/butler/say', expect.objectContaining({ body: expect.stringContaining('"entrance":"desktop"') }))
    expect(await screen.findByText(note)).toBeInTheDocument()
    expect(screen.queryByText('事项已建下')).toBeNull()
    expect(screen.queryByText(`已建下,${note}`)).toBeNull()
  })
  it('★回车 → POST /butler/say,并把草稿清掉', async () => {
    const calls: { url: string, body: unknown }[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return { ok: true, json: async () => ({ say_id: 'say-3', items: [], say: { screen: '记下了。', spoken: '记下了。' } }) }
    }) as unknown as typeof fetch
    const onDraftChange = vi.fn()

    render(<ButlerInbox {...props({ fetchImpl, onDraftChange, draft: '把展示台的黄历接上' })} />)
    await userEvent.click(screen.getByRole('button', { name: '交给事务官' }))

    expect(calls).toEqual([{ url: 'http://127.0.0.1:8791/butler/say', body: { text: '把展示台的黄历接上', entrance: 'desktop' } }])
    expect(onDraftChange).toHaveBeenCalledWith('')
  })

  it('★服务端说「会话未开」→ 当场如实回执,不假装事务官接了', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, json: async () => ({ say_id: 'say-4', items: [], say: { screen: '会话未开', spoken: '会话未开' } }),
    })) as unknown as typeof fetch

    render(<ButlerInbox {...props({ fetchImpl, draft: '记一笔' })} />)
    await userEvent.click(screen.getByRole('button', { name: '交给事务官' }))
    expect(await screen.findByText('会话未开')).toBeInTheDocument()
  })

  it('服务没应答 → 如实说一句,草稿不清掉(清了那句话就真没了)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('connection refused') }) as unknown as typeof fetch
    const onDraftChange = vi.fn()

    render(<ButlerInbox {...props({ fetchImpl, onDraftChange, draft: '记一笔' })} />)
    await userEvent.click(screen.getByRole('button', { name: '交给事务官' }))

    expect(await screen.findByText(/没应答/)).toBeInTheDocument()
    expect(onDraftChange).not.toHaveBeenCalledWith('')
  })

  it('两件相同备选的决定只回送所点原件的 decided_id', async () => {
    const requests: Record<string, unknown>[] = []
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      return { ok: true, json: async () => requests.length === 1 ? {
        say_id: 'two', items: [], say: { screen: '两件已按原分工安排。' },
        decided: [0, 1].map(index => ({ decided_id: `d-${index}`, item_index: index, field: 'who', chosen: 'Claude', why: '默认分工', alternatives: [{ id: 'agent:codex', label: 'Codex' }] })),
      } : { say_id: 'updated', items: [], say: { screen: '服务端确认第二件改选。' } } }
    }) as unknown as typeof fetch
    render(<ButlerInbox {...props({ fetchImpl, draft: '按原分工安排两件事' })} />)
    await userEvent.click(screen.getByRole('button', { name: '交给事务官' }))
    const buttons = await screen.findAllByRole('button', { name: '改为 Codex' })
    await userEvent.click(buttons[1]!)
    expect(requests[1]).toEqual({ text: '改为 Codex', entrance: 'desktop', ctx: { decided: { decided_id: 'd-1', choice: 'agent:codex' }, last_say_id: 'two' } })
    expect(await screen.findByText('服务端确认第二件改选。')).toBeInTheDocument()
  })

  it('空白输入不发请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    render(<ButlerInbox {...props({ fetchImpl, draft: '   ' })} />)
    await userEvent.click(screen.getByRole('button', { name: '交给事务官' }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('★统一输入框(2026-09-24):禁用的语音占位去掉了(电脑还没有收音,等有了再加),换成 +、@、模式三颗', () => {
    render(<ButlerInbox {...props()} />)
    expect(screen.queryByRole('button', { name: '语音(还没做)' })).toBeNull()
    expect(screen.getByRole('button', { name: '添加' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '交给谁' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^模式:先问我$/ })).toBeInTheDocument()
  })
})

describe('纯净模式下的这一档(同一份组件)', () => {
  it.each(['Escape', '外部属性'] as const)('空输入聚焦后通过%s收回，再展开不残留文字输入状态', async trigger => {
    const onPureCollapse = vi.fn()
    const inputProps = props({ pure: true, pureExpanded: true, onPureExpand: vi.fn(), onPureCollapse })
    const { rerender } = render(<ButlerInbox {...inputProps} />)
    await userEvent.click(screen.getByLabelText('交给事务官一件事'))
    expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'listening')
    if (trigger === 'Escape') {
      await userEvent.keyboard('{Escape}')
      expect(onPureCollapse).toHaveBeenCalledTimes(1)
    }
    rerender(<ButlerInbox {...inputProps} pureExpanded={false} />)
    expect(screen.getByRole('button', { name: /^事务官:/ })).toHaveAttribute('data-state', 'idle')
    rerender(<ButlerInbox {...inputProps} />)
    expect(screen.getByRole('img', { name: /^事务官:/ })).toHaveAttribute('data-state', 'idle')
  })
  it('★pure 且未展开:只有球(可点)与那一行,没有卡片、汇报条、输入框', () => {
    const onPureExpand = vi.fn()
    render(<ButlerInbox {...props({
      pure: true, pureExpanded: false, onPureExpand, onPureCollapse: vi.fn(),
      state: state({ tasks: tasksOf(task()), butler_inbox: { items: [{ id: 'sentinel:1', kind: 'sentinel', title: '甲' }] } }),
    })} />)
    expect(screen.getByText('执行 0 · 排队 0 · 等你 0')).toBeInTheDocument()
    expect(screen.queryByLabelText('事务官交给我的')).toBeNull()
    expect(screen.queryByRole('status', { name: '汇报条' })).toBeNull()
    expect(screen.queryByLabelText('交给事务官一件事')).toBeNull()
    expect(screen.queryByText('甲')).toBeNull()
  })

  it('★pure 且展开:卡片堆 + 输入框都在;点空白处收回', async () => {
    const onPureCollapse = vi.fn()
    render(<ButlerInbox {...props({
      pure: true, pureExpanded: true, onPureExpand: vi.fn(), onPureCollapse,
      state: state({ butler_inbox: { items: [{ id: 'sentinel:1', kind: 'sentinel', title: '甲' }] } }),
    })} />)
    expect(screen.getByText('甲')).toBeInTheDocument()
    expect(screen.getByLabelText('交给事务官一件事')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('ben-wb-pure-backdrop'))
    expect(onPureCollapse).toHaveBeenCalledTimes(1)
  })
})

describe('类名不与 Wiki 收件箱相撞(0.2.16 热修的回归保护:0.2.15 的 ben-wb__inbox* 把 Wiki 收件箱整屏盖住了)', () => {
  it('★事务官档渲染出来的任何元素都不带 ben-wb__inbox* / ben-wb__wiki* 类名', () => {
    const { container } = render(<ButlerInbox {...props({
      state: state({
        tasks: tasksOf(task()),
        butler_inbox: { items: [{ id: 'confirm:t1', kind: 'confirm', title: '甲', status: 'confirm', task_id: 't1' }] },
      }),
      draft: '有字',
    })} />)
    const classes = new Set<string>()
    for (const el of container.querySelectorAll('[class]')) el.classList.forEach(name => classes.add(name))
    const clashing = [...classes].filter(name => name.startsWith('ben-wb__inbox') || name.startsWith('ben-wb__wiki'))
    expect(clashing).toEqual([])
    // 根元素是 ben-wb__items(盖在槽体上的浮层),不是 Wiki 收件箱那个 ben-wb__inbox。
    expect(container.firstElementChild).toHaveClass('ben-wb__items')
  })

  it('★样式里 inset:0 那条浮层规则只挂在 .ben-wb__items 上,.ben-wb__inbox 永远不是浮层', () => {
    expect(STYLE).toMatch(/\.ben-wb__items\{[^}]*position:absolute;inset:0/)
    expect(STYLE).not.toMatch(/\.ben-wb__inbox\{[^}]*inset:0/)
    // 事务官档那一段样式里不许再出现 Wiki 的前缀(`ben-wb__inbox-`)。
    const section = STYLE.slice(STYLE.indexOf('事务官档改版'), STYLE.indexOf('齿轮弹窗'))
    expect(section).not.toContain('ben-wb__inbox')
  })
})
