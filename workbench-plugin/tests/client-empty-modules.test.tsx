/**
 * 第一次用:屏幕上真的长什么样(2026-09-18)。
 *
 * Ben 是 PM、不写代码 —— 这几条断言写的全是他第一次打开工作台时**能不能在屏幕上看到某句话**,
 * 不是组件内部长什么样。取数那一半的用例在 client-empty-state.test.ts。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { ButlerInbox, type ButlerControls } from '../src/client/ButlerInbox.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { emptyStateFor } from '../src/client/emptyState.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

/** 见 client-notes-files.test.tsx 顶部注释:不喂假 WS 会真的去连 8791 端口。 */
function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-09-18T10:03:00+08:00',
    stale: false,
    ...over,
  }
}

/** 第一次用:引导阶段机在、但还没做完。这是这一整份用例的前提。 */
function firstRun(over: Partial<WorkbenchState> = {}): WorkbenchState {
  // dock: { stack: [] } = 窗位叠接上了、里面一个都没有(裸机的真实样子)。
  // 整格缺席是"这台服务没接窗位叠",那一档不该出空态 —— 见 emptyState.ts 里 slot 那一支。
  return snapshot({ onboarding: { stage: 'opening', done: false }, dock: { stack: [] }, ...over })
}

function fakeFetch(read: () => WorkbenchState, calls: { url: string, body: unknown }[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => ({ ...read() }) }
  }) as unknown as typeof fetch
}

function props(fetchImpl: typeof fetch): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle',
    error: null, baselinesReady: true, recentWorkspaceId: undefined,
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
    serviceWebSocket: fakeWebSocket(),
  }
}

/** pollMs:默认只问一次(同既有用例);要验"状态变了界面跟着变"就传一个很小的值。 */
function renderWorkbench(read: () => WorkbenchState, calls: { url: string, body: unknown }[] = [], pollMs = 0) {
  return render(<WorkbenchOverlay {...props(fakeFetch(read, calls))} servicePollMs={pollMs} />)
}

describe('第一次打开工作台:每个模块都是一句引导,不是空白也不是旧样子', () => {
  it('★窗口槽 / 项目区 / 消耗数据 / 余额额度 / 随手记 / 系统文件夹,六格各说各的那一句', async () => {
    renderWorkbench(() => firstRun())
    for (const line of [
      '把常用的应用从屏幕上拖进这块槽里,它就会出现在这排标签里。',
      // 10-22 拍板 23:每格「图标 + 标题 + 一句」,下面是那一句
      '引导里会帮你扫描已有的,或者从零建第一个。',
      '接入一家的记录后,这里开始显示每日用量。',
      '已有账号可以在设置里连接。未接入不会显示为 0%。',
      '不用先想好归到哪个项目。',
    ]) {
      expect(await screen.findByText(line), line).toBeTruthy()
    }
    /*
     * ★ 2026-10-23(卡「系统文件夹改成Graphify图谱」):files 那一格本体换成 GraphView。
     * 首次那一刻项目区还没有带本机路径的项目,这一格如实说那一句 —— 不摆一颗点了
     * 必错的键(图谱要对着一个真实目录生成,没有 path 就没有可生成的对象)。
     */
    expect(await screen.findByText('项目区里还没有带本机路径的项目')).toBeTruthy()
    // 没有 path 的项目,就没有可装的图谱 / 可生成的图谱:这两颗键一颗都不该出现。
    expect(screen.queryByRole('button', { name: '装上' })).toBeNull()
    expect(screen.queryByRole('button', { name: '重建图谱' })).toBeNull()
  })

  it('图谱那一格:项目区有一个带本机路径的项目、graphify 还没装 → 一句实话 + 一颗「装上」', async () => {
    // 真实可控 HTTP 夹具:/graphify/status 由这一份答,其余 GET 照常回工作台状态。
    const state = firstRun({ projects: { projects: [{ id: 'p1', name: '短片项目', stage: '待整理', path: '/tmp/短片', links: [], session_count: 0, idle: true }], pending: [], scan_errors: [], scanned_at: '2026-10-23T10:00:00+08:00' } })
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) }
      if (String(url).includes('/graphify/status')) return { ok: true, json: async () => ({ installed: false, generatedAt: null, hasHtml: false, running: false }) }
      return { ok: true, json: async () => ({ ...state }) }
    }) as unknown as typeof fetch
    render(<WorkbenchOverlay {...props(fetchImpl)} />)
    expect(await screen.findByText('生成图谱要先装 graphify')).toBeTruthy()
    expect(screen.getByRole('button', { name: '装上' })).toBeTruthy()
  })

  it('★消耗数据整块不画图表 —— 首次那一刻不该是一堆"未接入"加空轨道', async () => {
    renderWorkbench(() => firstRun())
    await screen.findByText('还没有消耗记录')
    // UsagePanel 的三个页签("总览/项目/模型")一个都不该在。
    expect(screen.queryByRole('button', { name: '总览' })).toBeNull()
    expect(screen.queryByText('用量未接入')).toBeNull()
  })

  it('★余额额度整块不画格子 —— 四格并排的「未接入」比一句"还没接上"吓人得多', async () => {
    renderWorkbench(() => firstRun())
    await screen.findByText('还没有接上额度')
    expect(screen.queryByLabelText('客户端余额与额度')).toBeNull()
    expect(screen.queryByText('未接入')).toBeNull()
  })

  it('项目区整格换成空态:第一次进来该看见的是下一步做什么', async () => {
    renderWorkbench(() => firstRun())
    await screen.findByText(/还没有项目/)
    expect(screen.queryByRole('group', { name: '项目区展示模式' })).toBeNull()
  })

  it('随手记那个输入框照旧在 —— 它本身就是这一格的出路,不能被空态顶掉', async () => {
    renderWorkbench(() => firstRun())
    await waitFor(() => expect(document.querySelector('.ben-wb__emptyfirst[data-module=notes]')).not.toBeNull())
    expect(screen.getByLabelText('记录灵感或当天安排')).toBeTruthy()
  })

  it('★「开始引导」那颗按钮真的把人送回首次流程(擦掉旗子,那几屏再来一次)', async () => {
    const calls: { url: string, body: unknown }[] = []
    renderWorkbench(() => firstRun(), calls)
    const button = await screen.findByRole('button', { name: '开始引导' })
    await userEvent.click(button)
    await waitFor(() => {
      expect(calls.some(c => c.url.endsWith('/first-run') && (c.body as { done?: boolean }).done === false)).toBe(true)
    })
  })
})

describe('★非首次照旧:一个字都不变', () => {
  // 2026-10-22「总览」退役:项目区不再有展示模式那一排;没接任务账时照旧是项目行那一屏(`.ben-wb__projects .ben-wb__scroll`)。
  it('引导做完 → 六句话一句都没有,项目区回到项目行那一屏', async () => {
    renderWorkbench(() => snapshot({ onboarding: { stage: 'done', done: true } }))
    await waitFor(() => expect(document.querySelector('.ben-wb__projects .ben-wb__scroll')).not.toBeNull())
    expect(screen.queryByText(/还没有项目/)).toBeNull()
    expect(screen.queryByText(/把常用的窗口拖进来/)).toBeNull()
    expect(screen.queryByText(/还没有消耗记录/)).toBeNull()
  })

  it('这台服务没接引导(onboarding 缺席)→ 同样一个字不变', async () => {
    renderWorkbench(() => snapshot())
    await waitFor(() => expect(document.querySelector('.ben-wb__projects .ben-wb__scroll')).not.toBeNull())
    expect(document.querySelector('.ben-wb__emptyfirst[data-module=notes]')).toBeNull()
  })
})

describe('★数据来了空态就退场', () => {
  it('随手记多了一条 → 那一格的空态退场,别的几格照旧空着', async () => {
    let state = firstRun()
    renderWorkbench(() => state, [], 20)
    await waitFor(() => expect(document.querySelector('.ben-wb__emptyfirst[data-module=notes]')).not.toBeNull())

    state = firstRun({ notes: [{ id: 'n1', text: '记一句', created_at: '2026-09-18T01:00:00.000Z' }] })
    await waitFor(() => expect(document.querySelector('.ben-wb__emptyfirst[data-module=notes]')).toBeNull())
    expect(screen.getByText('记一句')).toBeTruthy()
    // 别的几格还没有数据,照旧空着 —— 退场是一格一格的,不是整片一起。
    expect(screen.getByText(/还没有项目/)).toBeTruthy()
  })

  it('引导做完那一刻 → 整片空态一起退场', async () => {
    let state = firstRun()
    renderWorkbench(() => state, [], 20)
    await screen.findByText(/还没有项目/)

    state = snapshot({ onboarding: { stage: 'done', done: true } })
    await waitFor(() => expect(screen.queryByText(/还没有项目/)).toBeNull())
    expect(screen.queryByText(/把常用的窗口拖进来/)).toBeNull()
    expect(screen.queryByText(/还没有接上额度/)).toBeNull()
  })

  it('★有残留数据就显示数据:窗位叠里有认领过的窗,窗口槽那一句就不出现', async () => {
    renderWorkbench(() => firstRun({
      dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
    }))
    await screen.findByText(/还没有项目/)
    expect(screen.queryByText(/把常用的窗口拖进来/)).toBeNull()
  })
})

/** 事务官那一档在窗位槽里是**懒挂载**的(点过「事务官」才挂),所以单独渲染这个组件来验。 */
describe('事务官会话区', () => {
  const controls: ButlerControls = {
    paused: false, testRinging: false, onPause: () => {}, onTestRing: () => {},
    onCancelWatch: () => {}, onDismissBrief: () => {}, proposals: [],
  }

  function renderInbox(state: WorkbenchState) {
    const view = emptyStateFor('butler', state)
    return render(
      <ButlerInbox
        state={state}
        baseUrl="http://127.0.0.1:8791"
        fetchImpl={(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch}
        onOpenConversation={() => {}}
        draft=""
        onDraftChange={() => {}}
        visible
        controls={controls}
        {...(view === undefined ? {} : { empty: view })}
      />,
    )
  }

  it('★第一次用、手上一件事都没有 → 一句「打字说第一句」,输入框还在', () => {
    renderInbox(firstRun())
    expect(screen.getByText(/打字说第一句/)).toBeTruthy()
    expect(screen.getByLabelText('交给事务官一件事')).toBeTruthy()
  })

  it('配过手机 → 那句话里多半句「手机上也可以」', () => {
    renderInbox(firstRun({
      devices: [{ id: 'd1', name: 'Ben 的手机', platform: 'android', created_at: '', last_seen_at: '' }],
    }))
    expect(screen.getByText(/手机上也可以/)).toBeTruthy()
  })

  it('非首次 → 那句话不出现', () => {
    renderInbox(snapshot({ onboarding: { stage: 'done', done: true } }))
    expect(screen.queryByText(/打字说第一句/)).toBeNull()
  })
})
