/**
 * 运营模板的**竖屏**(2026-09-21 第二张卡)。
 *
 * 上一版竖屏沿用的是做产品那一份 —— 切到运营模板再把壳拖到竖屏,三个新模块一个都不出现
 * (`docs/交接-0921-布局模板与运营横屏.md` 第七节第 2 条的「已知缺口」)。这一份钉那个缺口补上了:
 * 上 窗口槽 / 中 账号 + 待办(八环节)+ 发布计划 / 下 数据复盘 + 随手记 + 素材管理。
 *
 * 外加「账号」那一格里显示的到底是什么(名字 / 平台 / 最近一条笔记日期 / 进行中事项数),
 * 以及**做产品模板下一个字没变**。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { TemplateStateView, WorkbenchState } from '../src/protocol.ts'
import { PRODUCT_TEMPLATE, DEFAULT_MODULE_TITLES } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
import { templateStateView } from '../src/server/templateStore.ts'
import { TOPIC_STAGES } from '../src/protocol.ts'
import { TOPIC_OTHERS_LANE } from '../src/client/TodoModule.tsx'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'
const OPS_TEMPLATE = await loadStarterLayoutTemplate()
const OPS_STAGES = OPS_TEMPLATE.board_lanes

configure({ asyncUtilTimeout: 5_000 })

const REAL_WIDTH = window.innerWidth
const REAL_HEIGHT = window.innerHeight

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

afterEach(() => {
  cleanup()
  setViewport(REAL_WIDTH, REAL_HEIGHT)
  window.history.replaceState(null, '', '/')
})

function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

/** `template` 那一块由**服务端那个纯函数**现拼(不在测试里另写一份 —— 两份必走漂)。 */
function opsState(over: Partial<WorkbenchState> = {}): WorkbenchState {
  const template: TemplateStateView = templateStateView(OPS_TEMPLATE, {
    butlerCwd: '/Users/example/运营',
    hasBackup: true,
  })
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-09-21T10:03:00+08:00',
    stale: false,
    dock: { stack: [{ key: 'codex', label: 'ChatGPT', running: true, current: true }] },
    template,
    layout: {
      modules: OPS_TEMPLATE.portrait.map(m => ({ ...m })),
      butler: { corner: 'br', min: false },
      landscape: { modules: OPS_TEMPLATE.landscape.map(m => ({ ...m })) },
    },
    ...over,
  }
}

function productState(): WorkbenchState {
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-09-21T10:03:00+08:00',
    stale: false,
    dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
    layout: {
      modules: PRODUCT_TEMPLATE.portrait.map(m => ({ ...m })),
      butler: { corner: 'br', min: false },
    },
  }
}

function props(state: WorkbenchState, calls: { url: string, body: unknown }[] = []): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
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

/** 竖屏:Ben 那块 1440×2560。 */
async function renderPortrait(state: WorkbenchState, calls: { url: string, body: unknown }[] = []): Promise<void> {
  setViewport(1440, 2560)
  render(<WorkbenchOverlay {...props(state, calls)} />)
  await screen.findByRole('heading', { name: '工作台' })
  await waitFor(() => expect(document.querySelector('.ben-wb__row')).not.toBeNull())
}

/**
 * 模块标题,按它们在竖屏正文里从上到下的顺序。
 *
 * 只在 `.ben-wb__body` 里找 —— 顶栏与弹层里也有 `.ben-wb__ttl`。
 * 单模块的那一行没有 `.ben-wb__row` 包着(只有并排的才有),所以按行取会错位;
 * 「哪几格在同一行」由 tests/server-templates.test.ts 对着 `OPS_TEMPLATE.portrait` 钉。
 */
function moduleTitles(): string[] {
  const body = document.querySelector('.ben-wb__body')
  if (body === null) return []
  return [...body.querySelectorAll('.ben-wb__ttl')].map(node => node.textContent ?? '')
}

/** 项目区那一格的正文(断言"里面有什么"时别把整页样式表也算进去)。 */
function projectsText(): string {
  return document.querySelector('.ben-wb__projects')?.textContent ?? ''
}

// ───────────────────────────────────────────────────────────────────────────
describe('① 运营竖屏铺成三行', () => {
  // 2026-09-21 选题池:中间那一格的标题从「待办事项」换成「选题池」,位置一格没挪。
  it('从上到下:窗口槽 → 账号 / 选题池 / 今天的待办 / 发布计划 → 数据复盘 / 随手记 / 素材管理', async () => {
    await renderPortrait(opsState())
    expect(moduleTitles()).toEqual([
      '窗口槽',
      '账号', '选题池', '今天的待办', '发布计划',
      '数据复盘', '随手记', '素材管理',
    ])
  })

  it('中间那三格的顺序与横屏右侧栏从上到下一个字不差(转屏不用重新找东西在哪儿)', async () => {
    await renderPortrait(opsState())
    expect(moduleTitles().slice(1, 5)).toEqual(['账号', '选题池', '今天的待办', '发布计划'])
  })

  it('消耗数据与余额在竖屏下也是**收起**的(不是删掉)—— 布局工具条里还找得回来', async () => {
    await renderPortrait(opsState())
    expect(moduleTitles()).not.toContain('消耗数据')
    expect(moduleTitles()).not.toContain('余额 / 额度')
    expect(screen.getByRole('button', { name: /消耗数据/ })).toBeInTheDocument()
  })

  /*
   * ★ 2026-10-03:选题池那一格的外层换成运营同学(Air)自己写的那一份
   * (`user-layer/起步/小组件/topics/index.js`)。她那一版不是六列横向看板,而是
   * 「创作选题 N / 其它事项 N」两个页签 + 一排阶段筛 + 一列卡片;
   * 本体那六列(连同底下那行八环节流程说明)搬进她的「选题详情」浮层里
   * (`embedded`,见 TodoModule.tsx)。
   *
   * 所以上一版那两条(六列 data-stage 的顺序、底下那行八环节)在这一格上不再成立 ——
   * 它们改成断言**她那一版的形状**:每一段都有一颗筛按钮(六段 + 其它事项都在,
   * 一张卡都不会因为"它不是选题"而消失),这是那两条真正要守的事。
   */
  it('选题池在竖屏下是她那一版:两个页签 + 六段 + 「其它事项」各一颗筛按钮', async () => {
    await renderPortrait(opsState())
    expect(screen.getByRole('button', { name: /创作选题 \d+/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /其它事项 \d+/ })).toBeInTheDocument()
    const filters = [...document.querySelectorAll('.ct-tabs[aria-label="筛选选题阶段"] button')]
      .map(n => n.textContent?.replace(/\s\d+$/, ''))
    expect(filters).toEqual(['全部', ...TOPIC_STAGES.map(s => (s === '发布' ? '待发布 / 已发布' : s))])
    expect(TOPIC_OTHERS_LANE).toBe('其它事项')
  })

  it(`做产品模板的竖屏一个字没变:项目区 / 消耗数据 / 余额 / 窗口槽 / 随手记 / ${DEFAULT_MODULE_TITLES.files}`, async () => {
    await renderPortrait(productState())
    expect(moduleTitles()).toEqual(['项目区', '消耗数据', '余额 / 额度', '窗口槽', '随手记', DEFAULT_MODULE_TITLES.files])
    // 三个新模块在做产品模板下一个都不出现。
    for (const title of ['选题池', '待办事项', '发布计划', '数据复盘']) expect(moduleTitles()).not.toContain(title)
  })
})

// ───────────────────────────────────────────────────────────────────────────
/** 项目区那一格里的账号数据(服务端 accountSource 拼好的形状)。 */
function withAccounts(): WorkbenchState {
  return opsState({
    projects: {
      projects: [
        {
          id: '小食堂',
          name: '小食堂',
          stage: '待整理',
          path: '/Users/example/运营/账号/小食堂',
          account: { platform: '小红书', note_count: 12, last_note_at: '2026-09-20', idle_days: 1, open_tasks: 3 },
          detail: [
            { label: '定位', text: '一个人做饭' },
            { label: '平台', text: '小红书' },
          ],
          links: [],
          session_count: 0,
          idle: false,
        },
        {
          id: '新号',
          name: '新号',
          stage: '待整理',
          path: '/Users/example/运营/账号/新号',
          account: { platform: '抖音', note_count: 0 },
          links: [],
          session_count: 0,
          idle: false,
        },
      ],
      pending: [],
      scan_errors: [],
      scanned_at: '2026-09-21T02:03:00.000Z',
    },
  })
}

describe('②「账号」那一格里显示什么', () => {
  it('一行一个账号,名字就是文件夹名', async () => {
    await renderPortrait(withAccounts())
    await waitFor(() => expect(screen.getByRole('button', { name: /小食堂/ })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /新号/ })).toBeInTheDocument()
  })

  it('「算」行是:平台 · 最近一条笔记的日期 · 几件进行中', async () => {
    await renderPortrait(withAccounts())
    await waitFor(() => expect(screen.getByText('小红书 · 最近笔记 9-20 · 3 件进行中')).toBeInTheDocument())
    // 账号那一格里一条 git 词都不该有(分支 / 未提交 / worktree / 无仓库)。
    for (const word of ['分支', '未提交', 'worktree', '无仓库']) {
      expect(projectsText()).not.toContain(word)
    }
  })

  it('一条笔记都没有的新号:如实说「还没有笔记」,**不显示「今天有笔记」也不显示 0 天**', async () => {
    await renderPortrait(withAccounts())
    await waitFor(() => expect(screen.getByText('抖音 · 还没有笔记')).toBeInTheDocument())
    expect(screen.getByText('还没有笔记', { selector: '.ben-wb__pj-activity' })).toBeInTheDocument()
  })

  it('没接看板(open_tasks 缺席)时不写「0 件进行中」——「一件都没有」和「数不出来」不是一回事', async () => {
    await renderPortrait(withAccounts())
    await waitFor(() => expect(screen.getByText('抖音 · 还没有笔记')).toBeInTheDocument())
    expect(screen.queryByText(/0 件进行中/)).toBeNull()
  })

  it('展开一条:账号.md 里写了的那几项列出来(没写的不出现)', async () => {
    await renderPortrait(withAccounts())
    const head = await screen.findByRole('button', { name: /小食堂/ })
    act(() => { head.click() })
    await waitFor(() => expect(screen.getByText('定位:一个人做饭')).toBeInTheDocument())
    expect(screen.getByText('平台:小红书')).toBeInTheDocument()
    expect(screen.queryByText(/风格:/)).toBeNull()
  })

  it('没有账号时说「还没有账号,引导里会问」', async () => {
    // 空态那一格只在「第一次用」时出场(既有闸门)。
    await renderPortrait(opsState({ onboarding: { stage: 'template', done: false } }))
    // 10-22 拍板 23:模板那一句拆成标题「还没有账号」与一句「引导里会问。」
    await waitFor(() => expect(screen.getByText('还没有账号')).toBeInTheDocument())
    expect(screen.getByText('引导里会问。')).toBeInTheDocument()
  })

  it('没配工作目录:项目区上面如实挂一行「未接入」,不假装「还没有账号」', async () => {
    await renderPortrait(opsState({
      projects: {
        projects: [],
        pending: [],
        scan_errors: [{ root: '账号', reason: '还没配工作目录,不知道去哪儿找账号文件夹(设置 → 目录 → 工作目录)' }],
        scanned_at: '2026-09-21T02:03:00.000Z',
      },
    }))
    await waitFor(() => expect(screen.getByText(/账号 未接入:还没配工作目录/)).toBeInTheDocument())
  })
})
