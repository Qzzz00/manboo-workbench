import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkbenchButton, WorkbenchOverlay, type MinimalWebSocket, type WorkbenchButtonProps, type WorkbenchOverlayProps,
} from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { ProjectsState, WorkbenchProject, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

/**
 * 悬停高亮 v1 起 WorkbenchOverlay 会开一条 WS 订 /live——测试必须喂一个假类,不然会退回
 * 全局 WebSocket 真的去连 baseUrl(真机实测踩过:会连到 Ben 本机正在跑的真实工作台服务)。
 * 这份文件不测悬停高亮,给个什么都不做的空壳就够。
 */
function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

afterEach(cleanup)

function project(overrides: Partial<WorkbenchProject> & Pick<WorkbenchProject, 'id' | 'name'>): WorkbenchProject {
  return { stage: 'MVP 开发', links: [], session_count: 0, idle: false, ...overrides }
}

function projectsState(projects: WorkbenchProject[]): ProjectsState {
  return { projects, pending: [], scan_errors: [], scanned_at: '2026-08-18T00:00:00.000Z' }
}

function snapshot(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [],
    sessions: [],
    quota: {},
    now: '2026-08-18T10:03:00+08:00',
    stale: false,
    ...overrides,
  }
}

/** 假 fetch：/state 返回给定快照。 */
function fakeFetch(state: WorkbenchState): typeof fetch {
  return vi.fn(async () => ({ ok: true, json: async () => state })) as unknown as typeof fetch
}

function props(options: {
  phase?: 'pending' | 'ready'
  error?: string
  state?: WorkbenchState
  fetchImpl?: typeof fetch
} = {}): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  if (options.error !== undefined) instance.actions.failOpening(options.error)
  const workspaceState = {
    items: [],
    phase: options.phase ?? 'ready',
    archivedSessionIds: [],
    state: 'idle',
    error: null,
    baselinesReady: true,
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
    serviceFetch: options.fetchImpl ?? fakeFetch(options.state ?? snapshot()),
    servicePollMs: 0,
    serviceWebSocket: fakeWebSocket(),
  }
}

/** 假 fetch：/state 返回给定快照，/project/status 记录调用。 */
function fakeFetchWithStatusCapture(
  state: WorkbenchState,
  calls: { id: string, text: string }[],
): typeof fetch {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/project/status')) {
      const body = JSON.parse(String(init?.body)) as { id: string, text: string }
      calls.push(body)
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
}

describe('WorkbenchOverlay', () => {
  it('renders project names and their signal text from the projected projects state', async () => {
    render(<WorkbenchOverlay {...props({
      state: snapshot({
        projects: projectsState([
          project({
            id: 'aiboo', name: 'Aiboo',
            signals: { branch: 'main', dirty_count: 2, worktrees: 1, cleanup_count: 0, idle_days: 0 },
          }),
        ]),
      }),
    })} />)

    expect(screen.getByRole('heading', { name: '工作台' })).toBeTruthy()
    // 2026-09-23:左上角不再是「DeepSeek Harness · Personal / Ben Workbench」——
    // 新用户看到的是产品自己的名字,不带上游品牌、不带维护者的名字。
    const header = document.querySelector('.ben-wb__header')
    expect(header?.textContent ?? '').not.toMatch(/Ben|DeepSeek Harness|Personal/i)
    expect(await screen.findByRole('heading', { name: 'Aiboo' })).toBeTruthy()
    expect(await screen.findByText('今天在动')).toBeTruthy()
    expect(await screen.findByText('main · 2 未提交 · 1 worktree')).toBeTruthy()
  })

  it('shows a loading state before DSH has supplied the Workspace baseline', () => {
    render(<WorkbenchOverlay {...props({ phase: 'pending' })} />)

    expect(screen.getByText('正在读取 DSH 项目…')).toBeTruthy()
  })

  it('reports "未接入" instead of fabricating data when the service has not returned a projects block', async () => {
    render(<WorkbenchOverlay {...props()} />)

    expect(await screen.findByText('项目区未接入:服务未返回 projects')).toBeTruthy()
  })

  it('keeps project-opening failures visible', () => {
    render(<WorkbenchOverlay {...props({ error: '无法进入 Aiboo，请稍后重试。' })} />)

    expect(screen.getByRole('alert')).toHaveTextContent('无法进入 Aiboo，请稍后重试。')
  })

  it('inherits DSH surfaces, labels, controls, and keyboard focus styling', () => {
    render(<WorkbenchOverlay {...props()} />)

    const styles = document.querySelector('style')?.textContent ?? ''
    expect(styles).toContain('background:var(--dsw-alias-bg-base)')
    expect(styles).toContain('color:var(--dsw-alias-label-primary)')
    expect(styles).toContain('var(--dsw-alias-bg-layer-1)')
    expect(styles).toContain('var(--dsw-alias-border-l2)')
    expect(styles).toContain('var(--dsw-alias-button-primary-fill)')
    expect(styles).toContain(':focus-visible')
    expect(styles).not.toContain('background:#f7f8fa;color:#17191c')
  })
})

describe('项目区（v5 spec D1–D4：算/状态/零散/DDL 置顶于窗口槽之前，A3 起会话区已下线）', () => {
  it('项目区先于窗口槽渲染（DOM 顺序，默认布局 order:projects→slot→widgets）', async () => {
    render(<WorkbenchOverlay {...props({
      state: snapshot({ projects: projectsState([project({ id: 'aiboo', name: 'Aiboo' })]) }),
    })} />)

    const headings = await screen.findAllByRole('heading', { level: 2 })
    const titles = headings.map(h => h.textContent ?? '')
    const projectIdx = titles.findIndex(t => t === '项目区')
    const slotIdx = titles.findIndex(t => t === '窗口槽')
    expect(projectIdx).toBeGreaterThanOrEqual(0)
    expect(slotIdx).toBeGreaterThan(projectIdx)
  })

  it('状态过期的行带「待日结确认」文案与 --stale 类', async () => {
    render(<WorkbenchOverlay {...props({
      state: snapshot({
        projects: projectsState([
          project({
            id: 'aiboo',
            name: 'Aiboo',
            status: {
              text: '旧状态', review: 'confirmed', author: '你', updated_at: '2026-08-10T00:00:00.000Z', stale: true,
            },
          }),
        ]),
      }),
    })} />)

    const staleTag = await screen.findByText('待日结确认')
    expect(staleTag.closest('.ben-wb__pj-status')).toHaveClass('ben-wb__pj-status--stale')
  })

  it('signal_error 的项目如实显示「未接入」，不编数字', async () => {
    render(<WorkbenchOverlay {...props({
      state: snapshot({
        projects: projectsState([project({ id: 'broken', name: '坏仓库', signal_error: '目录不存在' })]),
      }),
    })} />)

    const signalRow = await screen.findByText('未接入:目录不存在')
    // spec D13：未接入必须醒目，不能跟正常的算行同色同款。
    expect(signalRow).toHaveClass('ben-wb__pj-calc--error')
  })

  it('点状态行进入编辑，确认后 POST /project/status 带正确 body', async () => {
    const calls: { id: string, text: string }[] = []
    const state = snapshot({
      projects: projectsState([
        project({
          id: 'aiboo',
          name: 'Aiboo',
          status: {
            text: '旧状态', review: 'confirmed', author: '你', updated_at: '2026-08-10T00:00:00.000Z', stale: false,
          },
        }),
      ]),
    })

    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchWithStatusCapture(state, calls) })} />)

    const statusRow = await screen.findByRole('button', { name: /旧状态/ })
    await userEvent.click(statusRow)

    const input = await screen.findByRole('textbox', { name: /编辑状态/ })
    await userEvent.clear(input)
    await userEvent.type(input, '新状态文本')
    await userEvent.click(screen.getByRole('button', { name: '确认' }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ id: 'aiboo', text: '新状态文本' })
  })

  it('scanErrorTexts 用醒目「未接入」样式渲染', async () => {
    render(<WorkbenchOverlay {...props({
      state: snapshot({
        projects: {
          projects: [], pending: [], scan_errors: [{ root: '/x/y', reason: '权限不足' }], scanned_at: '2026-08-18T00:00:00.000Z',
        },
      }),
    })} />)

    const errorText = await screen.findByText('/x/y 未接入:权限不足')
    expect(errorText).toHaveClass('ben-wb__pj-scanerr')
  })

  it('点行头展开出「零散/DDL」两行', async () => {
    render(<WorkbenchOverlay {...props({
      state: snapshot({
        projects: projectsState([
          project({
            id: 'aiboo',
            name: 'Aiboo',
            links: ['a', 'b', 'c'],
            ddl: { date: '2026-08-25', title: '评审' },
          }),
        ]),
      }),
    })} />)

    const head = await screen.findByRole('button', { name: /Aiboo/ })
    expect(screen.queryByText(/条零散记录/)).toBeNull()

    await userEvent.click(head)

    expect(await screen.findByText(/3 条零散记录/)).toBeTruthy()
    expect(await screen.findByText(/评审/)).toBeTruthy()
  })
})

describe('WorkbenchButton', () => {
  it('reopens the Workbench from the DSH sidebar', async () => {
    const instance = createWorkbenchStore().create()
    instance.actions.close()
    const buttonProps: WorkbenchButtonProps = {
      wide: true,
      useStore: selector => selector(instance.getSnapshot()),
      actions: instance.actions,
      useWorkspaces: selector => selector({} as never),
      useSessions: selector => selector({} as never),
      ...UNUSED_STANDARD_PROPS,
    }

    render(<WorkbenchButton {...buttonProps} />)
    await userEvent.click(screen.getByRole('button', { name: '打开工作台' }))

    expect(instance.getSnapshot().open).toBe(true)
  })
})

/**
 * W4 整分支终审补的两条接缝用例。两条都**必须在 WorkbenchOverlay 这一层跑**:
 * 单独渲染 Butler 的话,`narrowForced`/`brief` 是固定的 prop,谁也不会因为按了按钮
 * 而改变——两条缺陷恰恰都发生在"按钮 → 服务端 → 下一拍快照 → 界面"这一整圈上,
 * 组件级用例结构性地看不见它们(这正是九个任务各自全绿、合起来才漏的原因)。
 */
describe('W4 接缝(整分支终审):浮窗上按下去的按钮要真的有事发生', () => {
  /** 有窗在台前的 dock 快照——不然 butlerActive 为真会把浮窗压成窄条,快报/输入框整块不渲染。 */
  const dockWithCurrent = () => ({
    stack: [{ key: 'claude', label: 'Claude', running: true, current: true }],
  })
  const TOPIC = {
    id: 'd1', section: '今日资讯', title: 'MetaRoCE 发布', summary: '摘要',
    url: 'https://a.example', source: 'Meta', tier: 'flash',
  }

  it('C3:点「划走今晨快报」→ 服务端记下之后,快报真的从界面上消失(不只是发了一次请求)', async () => {
    let dismissed = false
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (String(url).endsWith('/brief/dismiss')) dismissed = true
        return { ok: true, json: async () => ({ ok: true }) }
      }
      return {
        ok: true,
        json: async () => snapshot({
          dock: dockWithCurrent(),
          brief: {
            date: '2026-08-25',
            push: false,
            topics: [TOPIC],
            // 服务端在 dismissed 时才带这个字段(缺省即无),跟真实投影一致。
            ...(dismissed ? { dismissed: true } : {}),
          },
        }),
      }
    }) as unknown as typeof fetch

    render(<WorkbenchOverlay {...props({ fetchImpl })} servicePollMs={30} />)

    // 10-22 第三轮 2:浮窗里是事务官那一页,快报在它的抽屉里。
    await userEvent.click(await screen.findByRole('button', { name: '事务官抽屉' }))
    await screen.findByText('MetaRoCE 发布')
    await userEvent.click(screen.getByRole('button', { name: '划走今晨快报' }))
    await waitFor(() => expect(screen.queryByText('MetaRoCE 发布')).toBeNull())
    // 整块都走了,不是只掉了条目——用 ✕ 本身做锚点:页面上另有一张 WidgetsModule 的
    // 待退休空壳快报卡也叫「今晨快报」,按文字查会误命中它(Task 7 的 id 撞车同源)。
    expect(screen.queryByRole('button', { name: '划走今晨快报' })).toBeNull()
  })

  /*
   * I1 两条(「跟事务官说一句」回车复制、失败兜底)10-22 第三轮 2 退休:浮窗里换成了窗口槽那一页事务官
   * (同一组件、只挂一处),原来那颗输入框不再画;那一页自己的输入见 client-butler-* 那几份测试。
   */
})
