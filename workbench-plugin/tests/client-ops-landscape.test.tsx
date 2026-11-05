/**
 * 运营模板的横屏真的按 Ben 那张草图铺出来了(2026-09-21 布局模板)。
 *
 * 草图(横版):顶部标签 = 事务官/ChatGPT/豆包/可灵/剪映/小红书;中间大区 = 应用工作界面;
 * 右侧 = 待办事项 + 发布计划;底部 = 数据复盘 + 随手记 + 素材管理。
 *
 * 这一份钉的是**看得见的东西**:哪几格在右侧栏、哪几格在底部、标题跟着模板换了没有、
 * 三个新模块里各自有什么。纯函数那一层在 client-publish-calendar / client-todo-lanes。
 *
 * 「做产品」那一支**一条断言都不该变** —— 同一份渲染路径,不给模板就是今天的样子,
 * 见最后一组。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { ProjectsState, TaskView, TemplateStateView, WorkbenchState } from '../src/protocol.ts'
import { OPS_ASSET_DIRS, DEFAULT_MODULE_TITLES } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
import { TOPIC_STAGES } from '../src/protocol.ts'
import { TOPIC_OTHERS_LANE } from '../src/client/TodoModule.tsx'
import { templateStateView } from '../src/server/templateStore.ts'
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

/**
 * 运营模板那一份 `/state`:布局是模板的横屏排布,`template` 那一块由**服务端那个纯函数**
 * 现拼(不在测试里另写一份 —— 两份必走漂)。
 */
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

/** 一个账号(= 项目区那一份,假数据)。字段按 ProjectsState 补齐,不然项目区自己会炸。 */
function account(name: string): ProjectsState {
  return {
    projects: [{ id: 'p-1', name, stage: '项目策划', links: [], session_count: 0, idle: false }],
    pending: [],
    scan_errors: [],
    scanned_at: '2026-09-21T02:00:00.000Z',
  }
}

/** 一条选题(假数据)。`topic: false` 就是一件普通事项 —— 用来钉「其它事项」那一列。 */
function topicTask(
  over: Partial<TaskView> & { id: string, title: string },
  topic = true,
): TaskView {
  return {
    status: 'todo',
    source: { kind: 'manual' },
    created_at: '2026-09-21T02:00:00.000Z',
    updated_at: '2026-09-21T02:00:00.000Z',
    ...(topic ? { kind: 'topic' as const } : {}),
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

async function renderLandscape(state: WorkbenchState, calls: { url: string, body: unknown }[] = []): Promise<void> {
  setViewport(2560, 1440)
  render(<WorkbenchOverlay {...props(state, calls)} />)
  await screen.findByRole('heading', { name: '工作台' })
  await waitFor(() => expect(document.querySelector('.ben-wb__land-deck')).not.toBeNull())
}

function regionTitles(selector: string): string[] {
  const region = document.querySelector(selector)
  if (region === null) return []
  return [...region.querySelectorAll('.ben-wb__ttl')].map(node => node.textContent ?? '')
}

// ───────────────────────────────────────────────────────────────────────────
describe('① 运营横屏铺成草图的样子', () => {
  it('右侧栏从上到下:账号 / 选题池 / 今天的待办 / 发布计划', async () => {
    await renderLandscape(opsState())
    // 2026-09-21 选题池:这一格的标题从「待办事项」换成「选题池」(模板的 module_titles)。
    // 右侧栏那三格是一格一格铺进来的(`side_pct` 要等一次量宽),所以等到齐再断言 ——
    // 直接断言会在机器忙的时候只量到第一格(真机上一样是先出一格再出三格,不是 bug)。
    await waitFor(() => expect(regionTitles('.ben-wb__land-side')).toEqual(['账号', '选题池', '今天的待办', '发布计划']))
  })

  it('底部一排从左到右:数据复盘 / 随手记 / 素材管理', async () => {
    await renderLandscape(opsState())
    expect(regionTitles('.ben-wb__land-deck')).toEqual(['数据复盘', '随手记', '素材管理'])
  })

  it('中间大区还是窗位槽(应用工作界面),左栏还是应用标签', async () => {
    await renderLandscape(opsState())
    expect(regionTitles('.ben-wb__land-stage')).toEqual(['窗口槽'])
    expect(document.querySelector('.ben-wb__land-rail')).not.toBeNull()
  })

  it('消耗数据与余额在运营模板下是**收起**的(不是删掉)—— 布局工具条里还找得到', async () => {
    await renderLandscape(opsState())
    const all = [...document.querySelectorAll('.ben-wb__ttl')].map(n => n.textContent)
    expect(all).not.toContain('消耗数据')
    expect(all).not.toContain('余额 / 额度')
    // 收起的模块在布局工具条里有重新展开的入口(既有能力,这里只确认它认得这两格)。
    expect(screen.getByRole('button', { name: /消耗数据/ })).toBeInTheDocument()
  })
})

describe('②「项目」在运营模板里叫「账号」', () => {
  it('模块标题是「账号」,不是「项目区」', async () => {
    await renderLandscape(opsState())
    expect(regionTitles('.ben-wb__land-side')[0]).toBe('账号')
  })

  it('没有账号时说「还没有账号,引导里会问」', async () => {
    // 空态那一格只在「第一次用」时出场(既有闸门),所以这里给一份引导还没做完的 state。
    await renderLandscape(opsState({ onboarding: { stage: 'template', done: false } }))
    // 10-22 拍板 23:模板那一句拆成标题「还没有账号」与一句「引导里会问。」
    await waitFor(() => expect(screen.getByText('还没有账号')).toBeInTheDocument())
    expect(screen.getByText('引导里会问。')).toBeInTheDocument()
  })

  // 2026-10-21:项目区的看板下线(换成协作区),「未归账号」那一格跟着没了。
  // 2026-10-22「总览」也退役:接了任务账这格就是协作区,没有展示模式那一排;存着 board 的老布局照样。
  it('老布局存着看板:账号区那格就是协作区,没有「总览」那一排,也没有「未归账号」', async () => {
    await renderLandscape(opsState({
      layout: {
        modules: OPS_TEMPLATE.portrait.map(m => ({ ...m })),
        butler: { corner: 'br', min: false },
        projects_view: 'board',
        landscape: { modules: OPS_TEMPLATE.landscape.map(m => ({ ...m })) },
      },
      tasks: {
        tasks: [{
          id: 'x', title: '一件没归属的', status: 'todo',
          source: { kind: 'manual' }, created_at: '2026-09-21T02:00:00.000Z', updated_at: '2026-09-21T02:00:00.000Z',
        }],
        sprints: [], modules: [], project_meta: [],
      },
    }))
    await waitFor(() => expect(document.querySelector('.ben-wb__projects-collab')).not.toBeNull())
    expect(screen.queryByLabelText('账号区展示模式')).toBeNull()
    expect(screen.queryByRole('button', { name: '总览' })).toBeNull()
    expect(screen.queryByText('未归账号')).toBeNull()
  })

  it('做产品模板下那一句一个字没变', async () => {
    await renderLandscape({ ...productState(), onboarding: { stage: 'opening', done: false } })
    await waitFor(() => {
      expect(screen.getByText('引导里会帮你扫描已有的,或者从零建第一个。')).toBeInTheDocument()
    })
  })
})

/**
 * 2026-09-21 数据复盘接上自取之后,这一组守的是**「没接自取服务」那一支**:
 * `/state.xhs` 缺席(展示台、手机、以及这里的 opsState())时,这一格必须原样
 * 退回占位那一版。接上之后长什么样在 client-review-module.test.tsx。
 */
/*
 * ★ 2026-10-03:这一格的组件本体换成了运营同学(Air)自己写的那一份
 * (`user-layer/起步/小组件/review/index.js`)。她那一版**没有"没接上"那一支占位** ——
 * 没接自取时它照样把自己那套摆出来,只是每一项都写「未采集」。
 * 所以上一版那两条(占位那一句、灰着的指标名单)在这一格上不再成立,
 * 改成断言她那一版真正守住的事:一个编出来的数都没有、不可采集那两项连选项都没有。
 */
describe('③ 数据复盘:没接自取服务时一个数都不编', () => {
  it('两颗范围按钮 + 她那两颗动作键;一条「未采集」,没有一个数字顶替', async () => {
    await renderLandscape(opsState())
    expect(screen.getByRole('button', { name: '近 7 日' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '近 30 日' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新数据' })).toBeInTheDocument()
    expect(screen.getByText('已连接 0/0 个账号')).toBeInTheDocument()
    // 占比那一块照实说"算不出来",不画一个空环。
    expect(screen.getByText('部分账号缺少观看量，暂不计算占比。')).toBeInTheDocument()
  })

  it('指标下拉里只有可采集的那六项(没有「笔记发布数 / 平均观看时长」)', async () => {
    await renderLandscape(opsState())
    const picker = screen.getByLabelText('选择图表指标') as HTMLSelectElement
    expect([...picker.options].map(o => o.textContent))
      .toEqual(['观看', '曝光', '封面点击率', '点赞', '收藏', '涨粉'])
  })

  it('范围按钮是真的开关(点了状态跟着变)', async () => {
    await renderLandscape(opsState())
    act(() => { screen.getByRole('button', { name: '近 30 日' }).click() })
    await waitFor(() => expect(screen.getByRole('button', { name: '近 30 日' })).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByRole('button', { name: '近 7 日' })).toHaveAttribute('aria-pressed', 'false')
  })
})

/*
 * ★ 2026-10-03:这一格的**外层**换成了运营同学(Air)自己写的那一份
 * (`user-layer/起步/小组件/topics/index.js`):「创作选题 N / 其它事项 N」两个页签 + 一排阶段筛 +
 * 一个搜索框 + 一列卡片;本体那六列横向看板连同底下那行八环节流程说明搬进她的
 * 「选题详情」浮层里(`embedded`,见 TodoModule.tsx)。
 *
 * 所以下面这一组改成两层:**用户那一层**断言页签 / 筛 / 卡上的字 / 两张浮层;
 * 本体那一层(当前环节、推进一步、素材、两个日期)照旧断言,只是先点开「详情与素材」。
 * 契约那几条(`/task/create`、`/task/advance`、`/task/update`、`/topic/open` 的 body)
 * 一个字没放过。
 */
async function openTopicDetail(title: string): Promise<void> {
  const card = (await screen.findByText(title, { selector: '.ct-card .ct-title' })).closest('.ct-card') as HTMLElement
  const button = [...card.querySelectorAll('button')]
    .find(node => node.textContent === '详情与素材' || node.textContent === '查看事项') as HTMLButtonElement
  act(() => { button.click() })
  await screen.findByRole('dialog', { name: '选题详情' })
}

describe('④ 选题池:她那一版的两个页签 + 阶段筛,六列在「选题详情」里', () => {
  it('两个页签 + 每一段一颗筛按钮(一张卡都不会因为"它不是选题"而消失)', async () => {
    await renderLandscape(opsState())
    expect(screen.getByRole('button', { name: /创作选题 \d+/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /其它事项 \d+/ })).toBeInTheDocument()
    const filters = [...document.querySelectorAll('.ct-tabs[aria-label="筛选选题阶段"] button')]
      .map(n => n.textContent?.replace(/\s\d+$/, ''))
    expect(filters).toEqual(['全部', ...TOPIC_STAGES.map(s => (s === '发布' ? '待发布 / 已发布' : s))])
  })

  it('六段一列 + 末尾一条「其它事项」:在「选题详情」浮层里(空列不画)', async () => {
    await renderLandscape(opsState({
      tasks: { tasks: [topicTask({ id: 't-1', title: '露营锅具怎么选', stage: '初稿' })], sprints: [], modules: [], project_meta: [] },
    }))
    await openTopicDetail('露营锅具怎么选')
    const cols = [...document.querySelectorAll('.ben-wb__topics-col')].map(n => n.getAttribute('data-stage'))
    // 浮层里只装这一条,所以只画它那一列;六段 + 「其它事项」那一份名单本身没变。
    expect(cols).toEqual(['初稿'])
    expect([...TOPIC_STAGES, TOPIC_OTHERS_LANE]).toContain('初稿')
  })

  it('八环节没有丢,留在「选题详情」里当流程说明', async () => {
    await renderLandscape(opsState({
      tasks: { tasks: [topicTask({ id: 't-1', title: '露营锅具怎么选' })], sprints: [], modules: [], project_meta: [] },
    }))
    await openTopicDetail('露营锅具怎么选')
    expect(screen.getByText(`完整流程八环节:${OPS_STAGES.join(' → ')}`)).toBeInTheDocument()
  })

  it('右上方一颗「＋ 新建选题」;整格只有这一颗,不是每列一颗', async () => {
    await renderLandscape(opsState())
    expect(screen.getAllByRole('button', { name: '＋ 新建选题' })).toHaveLength(1)
  })

  /*
   * ★ 她那张新建表单里**没有优先级**(标题 / 账号 / 形式 / 计划发布日四样)。
   * 上一版这一条断言的是"四样含优先级一起发出去" —— 优先级这一项在她那一版里
   * 只有在「选题详情」里才改得到(本体那张表单还在那儿)。记在交接的「没验到 / 丢了什么」。
   */
  it('新建选题:标题 + 账号 + 图文/视频,三样一起发出去(她那张表单没有优先级)', async () => {
    const calls: { url: string, body: unknown }[] = []
    await renderLandscape(opsState({
      projects: account('户外号'),
    }), calls)
    act(() => { screen.getByRole('button', { name: '＋ 新建选题' }).click() })
    const input = await screen.findByLabelText('新选题标题')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '露营锅具怎么选')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const pick = (label: string, value: string): void => {
      const select = screen.getByLabelText(label) as HTMLSelectElement
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
        setter?.call(select, value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    pick('选题内容形式', '视频')
    pick('选题账号', 'p-1')
    act(() => { (input.closest('form') as HTMLFormElement).requestSubmit() })
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/task/create'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/task/create'))?.body).toEqual({
      title: '露营锅具怎么选',
      status: 'todo',
      kind: 'topic',
      content_type: '视频',
      stage: '灵感',
      project_id: 'p-1',
    })
  })

  it('★ 新建选题时填得上计划发布日,填了就跟着发出去', async () => {
    const calls: { url: string, body: unknown }[] = []
    await renderLandscape(opsState(), calls)
    act(() => { screen.getByRole('button', { name: '＋ 新建选题' }).click() })
    const input = await screen.findByLabelText('新选题标题')
    const type = (node: HTMLInputElement, value: string): void => {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(node, value)
        node.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    type(input as HTMLInputElement, '露营锅具怎么选')
    type(screen.getByLabelText('新选题计划发布日') as HTMLInputElement, '2026-09-25')
    act(() => { (input.closest('form') as HTMLFormElement).requestSubmit() })
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/task/create'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/task/create'))?.body).toMatchObject({ planned_at: '2026-09-25' })
  })

  it('不填计划发布日照样建得出来(**没有"默认今天"**,同优先级那条)', async () => {
    const calls: { url: string, body: unknown }[] = []
    await renderLandscape(opsState(), calls)
    act(() => { screen.getByRole('button', { name: '＋ 新建选题' }).click() })
    const input = await screen.findByLabelText('新选题标题')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '还没想好哪天发')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { (input.closest('form') as HTMLFormElement).requestSubmit() })
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/task/create'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/task/create'))?.body).not.toHaveProperty('planned_at')
  })

  it('★ 卡片展开后两个日期都能改;清空 = 传 null 清掉', async () => {
    const calls: { url: string, body: unknown }[] = []
    await renderLandscape(opsState({
      tasks: {
        tasks: [topicTask({ id: 't-1', title: '露营锅具怎么选', stage: '发布', planned_at: '2026-09-25', published_at: '2026-09-26' })],
        sprints: [], modules: [], project_meta: [],
      },
    }), calls)
    await openTopicDetail('露营锅具怎么选')
    const planned = await screen.findByLabelText('露营锅具怎么选 的计划发布日') as HTMLInputElement
    const published = screen.getByLabelText('露营锅具怎么选 的实际发布日') as HTMLInputElement
    expect(planned.value).toBe('2026-09-25')
    expect(published.value).toBe('2026-09-26')
    const type = (node: HTMLInputElement, value: string): void => {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(node, value)
        node.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    type(planned, '2026-09-28')
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/task/update'))).toBe(true))
    expect(calls.at(-1)?.body).toEqual({ id: 't-1', planned_at: '2026-09-28' })
    type(published, '')
    await waitFor(() => expect(calls.at(-1)?.body).toEqual({ id: 't-1', published_at: null }))
  })

  it('普通事项那张卡上**没有**这两个日期(它不是选题)', async () => {
    await renderLandscape(opsState({
      tasks: {
        tasks: [topicTask({ id: 't-9', title: '一件普通事项', due: '2026-09-25' }, false)],
        sprints: [], modules: [], project_meta: [],
      },
    }))
    // 用户那一层先把它摆在「其它事项」那个页签里(卡上写着「普通事项」)。
    // 这条卡带 `due`,所以月历那一格里也有一条同名的 chip —— 只在选题池那一格里找它。
    act(() => { screen.getByRole('button', { name: /其它事项 \d+/ }).click() })
    const own = [...document.querySelectorAll('.ct-card .ct-title')]
      .find(node => node.textContent === '一件普通事项') as HTMLElement
    const view = [...(own.closest('.ct-card') as HTMLElement).querySelectorAll('button')]
      .find(node => node.textContent === '查看事项') as HTMLButtonElement
    act(() => { view.click() })
    await screen.findByRole('dialog', { name: '选题详情' })
    expect(await screen.findByText('这条不是选题,是一件普通事项。')).toBeInTheDocument()
    expect(screen.queryByLabelText('一件普通事项 的计划发布日')).toBeNull()
    expect(screen.getByText('预期结束:2026-09-25')).toBeInTheDocument()
  })

  it('选题卡上写着类型 / 优先级 / 账号;展开后是当前环节 + 推进一步 + 素材', async () => {
    await renderLandscape(opsState({
      projects: account('户外号'),
      tasks: {
        tasks: [topicTask({ id: 't-1', title: '露营锅具怎么选', stage: '制作中', content_type: '视频', priority: 'high', project_id: 'p-1' })],
        sprints: [], modules: [], project_meta: [],
      },
    }))
    // 用户那一层的卡上写的是「阶段 · 账号 · 形式」那一行(优先级不在她那张卡上)。
    const card = (await screen.findByText('露营锅具怎么选', { selector: '.ct-card .ct-title' })).closest('.ct-card') as HTMLElement
    expect(card.textContent).toContain('制作中')
    expect(card.textContent).toContain('户外号')
    expect(card.textContent).toContain('视频')
    // 本体那张卡上那几颗标签(含优先级)在「选题详情」里。
    await openTopicDetail('露营锅具怎么选')
    const tags = [...document.querySelectorAll('.ben-wb__topics-card .ben-wb__topics-tag')].map(n => n.textContent)
    expect(tags).toContain('视频')
    expect(tags).toContain('高')
    expect(tags).toContain('户外号')
    // 六段 → 八环节的映射写在卡上(制作中 = 后期制作)。
    expect(await screen.findByText('当前环节:后期制作')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '推进一步 → 发布' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '素材' })).toBeInTheDocument()
  })

  it('「推进一步」打的是 /task/advance,只带 id —— 下一段由服务端说了算', async () => {
    const calls: { url: string, body: unknown }[] = []
    await renderLandscape(opsState({
      tasks: { tasks: [topicTask({ id: 't-1', title: '露营锅具怎么选', stage: '灵感' })], sprints: [], modules: [], project_meta: [] },
    }), calls)
    // 用户那一层卡上就有一颗「推进到初稿」,打的是同一条路由、同一份 body。
    act(() => { screen.getByRole('button', { name: '推进到初稿' }).click() })
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/task/advance'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/task/advance'))?.body).toEqual({ id: 't-1' })
  })

  it('到了「复盘」那颗按钮是灰的,写着已到复盘', async () => {
    await renderLandscape(opsState({
      tasks: { tasks: [topicTask({ id: 't-1', title: '收尾那条', stage: '复盘' })], sprints: [], modules: [], project_meta: [] },
    }))
    // 用户那一层:到了「复盘」就没有下一段了,卡上那一颗推进键整个不画。
    const card = (await screen.findByText('收尾那条', { selector: '.ct-card .ct-title' })).closest('.ct-card') as HTMLElement
    expect([...card.querySelectorAll('button')].map(n => n.textContent)).toEqual(['详情与素材', '安排发布日'])
    // 本体那一颗照旧灰着、写着已到复盘。
    await openTopicDetail('收尾那条')
    expect(await screen.findByRole('button', { name: '已到复盘' })).toBeDisabled()
  })

  it('「素材」打的是 /topic/open,带选题名', async () => {
    const calls: { url: string, body: unknown }[] = []
    await renderLandscape(opsState({
      tasks: { tasks: [topicTask({ id: 't-1', title: '露营锅具怎么选' })], sprints: [], modules: [], project_meta: [] },
    }), calls)
    await openTopicDetail('露营锅具怎么选')
    act(() => { screen.getByRole('button', { name: '素材' }).click() })
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/topic/open'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/topic/open'))?.body).toEqual({ name: '露营锅具怎么选' })
  })

  /**
   * **上一版建出来的八环节事项一张都不许消失。** 它们不是选题,所以落在「其它事项」那一列,
   * 并且照旧带着自己的环节 —— 换一种排法不该让已经在盘上的待办从界面上不见。
   */
  it('不是选题的在办事项落进「其它事项」,还带着它的八环节', async () => {
    await renderLandscape(opsState({
      tasks: {
        tasks: [topicTask({ id: 't-9', title: '上一版建的那件', module_id: 'lane:结构与脚本' }, false)],
        sprints: [], modules: [], project_meta: [],
      },
    }))
    // 用户那一层把它摆在「其它事项」那个页签里 —— 换一种排法没让它从界面上不见。
    act(() => { screen.getByRole('button', { name: /其它事项 \d+/ }).click() })
    await openTopicDetail('上一版建的那件')
    const card = document.querySelector('.ben-wb__topics-card')
    expect(card?.closest('.ben-wb__topics-col')?.getAttribute('data-stage')).toBe(TOPIC_OTHERS_LANE)
    expect([...(card?.querySelectorAll('.ben-wb__topics-tag') ?? [])].map(n => n.textContent)).toContain('结构与脚本')
  })
})

/*
 * ★ 2026-10-03:这一格的组件本体换成了运营同学(Air)自己写的那一份
 * (`user-layer/起步/小组件/publish/index.js`)。日期格上没有 `data-date` 了(她那一格按
 * `aria-label` 认人),「回到本月」那颗叫「今天」,填写表单是一张浮层。
 * 下面这一组守的事没变:画哪个月、哪一条落在哪一天、逾期、点一天建一条计划发布的选题。
 */
/** 她那一格的日期格:按 aria-label 开头认(`2026-09-25,…`)。 */
function dayCell(date: string): HTMLButtonElement | null {
  return [...document.querySelectorAll('.cp-day')]
    .find(node => (node.getAttribute('aria-label') ?? '').startsWith(date)) as HTMLButtonElement | undefined ?? null
}

describe('⑤ 发布计划是一张月历,分「未发布 / 已发布」两个状态', () => {
  it('画的是 now 那个月,不读时钟', async () => {
    await renderLandscape(opsState())
    expect(screen.getByText('2026 年 09 月')).toBeInTheDocument()
    // 9 月 21 号那一格在,而且被标成「今天」。
    const today = dayCell('2026-09-21')
    expect(today).not.toBeNull()
    expect(today).toHaveAttribute('data-today', 'true')
    expect(today?.getAttribute('aria-label')).toContain('，今天')
  })

  it('翻月:上个月 / 下个月 / 回到本月(她那颗叫「今天」)', async () => {
    await renderLandscape(opsState())
    act(() => { screen.getByRole('button', { name: '下个月' }).click() })
    await waitFor(() => expect(screen.getByText('2026 年 10 月')).toBeInTheDocument())
    act(() => { screen.getByRole('button', { name: '今天' }).click() })
    await waitFor(() => expect(screen.getByText('2026 年 09 月')).toBeInTheDocument())
  })

  it('两颗状态按钮,**默认亮着「未发布」**(Ben:UI 层面优先表现未发布的)', async () => {
    await renderLandscape(opsState())
    const bar = document.querySelector('.cp-tabs[aria-label="发布状态"]')
    expect([...(bar?.querySelectorAll('button') ?? [])].map(n => n.textContent)).toEqual(['未发布', '已发布'])
    expect(screen.getByRole('button', { name: '未发布' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '已发布' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('未发布视图:选题按**计划发布日**落格,普通事项的 `due` 照旧也在', async () => {
    await renderLandscape(opsState({
      tasks: {
        tasks: [
          topicTask({ id: 't1', title: '发 9 月 25 号那条', planned_at: '2026-09-25' }),
          topicTask({ id: 't2', title: '同一天的第二条', planned_at: '2026-09-25' }),
          topicTask({ id: 't3', title: '一件普通事项', due: '2026-09-26' }, false),
        ],
        sprints: [], modules: [], project_meta: [],
      },
    }))
    const cell = dayCell('2026-09-25')
    expect(cell?.textContent).toContain('2')
    expect(cell?.textContent).toContain('发 9 月 25 号那条')
    expect(cell).toHaveAttribute('aria-label', '2026-09-25，2条未发布，点击填写发布计划')
    expect(dayCell('2026-09-26')?.textContent).toContain('一件普通事项')
  })

  it('已经发出去的**不在未发布视图里**,切到「已发布」按实际发布日回溯', async () => {
    await renderLandscape(opsState({
      tasks: {
        tasks: [
          topicTask({ id: 't1', title: '已经发了那条', planned_at: '2026-09-15', published_at: '2026-09-17' }),
          topicTask({ id: 't2', title: '还没发那条', planned_at: '2026-09-25' }),
        ],
        sprints: [], modules: [], project_meta: [],
      },
    }))
    // 未发布视图:计划日那一格是空的,只剩还没发的那条。
    expect(dayCell('2026-09-15')?.textContent).not.toContain('已经发了那条')
    expect(dayCell('2026-09-25')?.textContent).toContain('还没发那条')
    act(() => { screen.getByRole('button', { name: '已发布' }).click() })
    await waitFor(() => {
      expect(dayCell('2026-09-17')?.textContent).toContain('已经发了那条')
    })
    expect(dayCell('2026-09-17')).toHaveAttribute('aria-label', '2026-09-17，1条已发布，点击填写发布计划')
    expect(dayCell('2026-09-25')?.textContent).not.toContain('还没发那条')
  })

  it('今天之前还没发的那一天标「逾期」;今天与以后不标;已发布视图里一天都不标', async () => {
    await renderLandscape(opsState({
      tasks: {
        tasks: [
          topicTask({ id: 't1', title: '早该发了', planned_at: '2026-09-18' }),
          topicTask({ id: 't2', title: '今天要发', planned_at: '2026-09-21' }),
          topicTask({ id: 't3', title: '发过了', planned_at: '2026-09-15', published_at: '2026-09-16' }),
        ],
        sprints: [], modules: [], project_meta: [],
      },
    }))
    // ★ 她那一格把逾期标在 `data-late` 上、靠配色说话,**没有写「逾期」那两个字**
    //   (上一版写了,而且写进了可访问名)。这一条照她那一版断言,记在交接里。
    const late = dayCell('2026-09-18')
    expect(late).toHaveAttribute('data-late', 'true')
    expect(dayCell('2026-09-21')).toHaveAttribute('data-late', 'false')
    act(() => { screen.getByRole('button', { name: '已发布' }).click() })
    await waitFor(() => expect(dayCell('2026-09-16')?.textContent).toContain('发过了'))
    expect(dayCell('2026-09-16')).toHaveAttribute('data-late', 'false')
  })

  it('点一天 → 就地建一条**计划那天发**的选题(预填 planned_at)', async () => {
    const calls: { url: string, body: unknown }[] = []
    await renderLandscape(opsState(), calls)
    act(() => { (dayCell('2026-09-25') as HTMLButtonElement).click() })
    // 她那一版:点一天开的是一张浮层(role=dialog aria-modal),表单在浮层里。
    const dialog = await screen.findByRole('dialog', { name: '填写发布计划' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const input = screen.getByLabelText('发布内容标题')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '拍开箱视频')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { screen.getByRole('button', { name: '保存发布计划' }).click() })
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/task/create'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/task/create'))?.body)
      .toMatchObject({ title: '拍开箱视频', kind: 'topic', stage: '灵感', planned_at: '2026-09-25', status: 'todo', content_type: '视频' })
  })

  /*
   * ★ 她那张浮层**只建选题**(没有「建成什么」那一颗),所以"从月历改建成一件普通事项"
   * 这条路在这一格上没有了。`due` 那条老路本身一个字没改:盘上带 `due` 的普通事项照旧
   * 落在月历上(上面那条用例钉着),读法在 `publishDayOf` 里,用例在
   * tests/client-publish-calendar.test.ts。丢了哪条入口记在交接里。
   */
  it('她那张浮层里没有「建成什么」那一颗(只建选题)', async () => {
    await renderLandscape(opsState())
    act(() => { (dayCell('2026-09-25') as HTMLButtonElement).click() })
    await screen.findByRole('dialog', { name: '填写发布计划' })
    expect(screen.queryByLabelText('建成什么')).toBeNull()
    // 形式那一颗在(图文 / 视频),它是选题才有的东西。
    expect([...(screen.getByLabelText('内容形式') as HTMLSelectElement).options].map(o => o.textContent))
      .toEqual(['图文', '视频'])
  })

  it('★ 新建那张表单带账号选择器:选了就带 project_id,**下一次默认上次那个**', async () => {
    const calls: { url: string, body: unknown }[] = []
    await renderLandscape(opsState({ projects: account('小红书·露营') }), calls)
    act(() => { (dayCell('2026-09-25') as HTMLButtonElement).click() })
    await screen.findByRole('dialog', { name: '填写发布计划' })
    const input = screen.getByLabelText('发布内容标题')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '拍开箱视频')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const picker = screen.getByLabelText('发布账号') as HTMLSelectElement
    expect([...picker.options].map(o => o.textContent)).toEqual(['稍后选择', '小红书·露营'])
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
      setter?.call(picker, 'p-1')
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => { screen.getByRole('button', { name: '保存发布计划' }).click() })
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/task/create'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/task/create'))?.body).toMatchObject({ project_id: 'p-1' })

    // 再点一天:账号还停在上次那个(建完不清空 —— 一周的内容多半是同一个号)。
    act(() => { (dayCell('2026-09-26') as HTMLButtonElement).click() })
    await waitFor(() => expect((screen.getByLabelText('发布账号') as HTMLSelectElement).value).toBe('p-1'))
  })

  /*
   * ★ 她那一版两处跟上一版反过来,照她的接:
   * 1. 一个账号都没有时那颗下拉**照样画**,里面只有「稍后选择」—— 上一版整颗不画;
   * 2. 「已发布」那一支点一天**也给填写表单**(她那张浮层不分视图)—— 上一版只列出那天发了什么。
   * 两条都记在 docs/交接-1003-运营同学六组件原封接入.md 的「她那一版与上一版的差」。
   */
  it('一个账号都没有时那颗下拉照样画,里面只有「稍后选择」', async () => {
    await renderLandscape(opsState())
    act(() => { (dayCell('2026-09-25') as HTMLButtonElement).click() })
    await screen.findByRole('dialog', { name: '填写发布计划' })
    expect([...(screen.getByLabelText('发布账号') as HTMLSelectElement).options].map(o => o.textContent))
      .toEqual(['稍后选择'])
  })

  it('「已发布」那一支点一天:那天发了什么列在浮层里', async () => {
    await renderLandscape(opsState({
      tasks: {
        tasks: [topicTask({ id: 't1', title: '已经发了那条', published_at: '2026-09-17' })],
        sprints: [], modules: [], project_meta: [],
      },
    }))
    act(() => { screen.getByRole('button', { name: '已发布' }).click() })
    await waitFor(() => expect(dayCell('2026-09-17')?.textContent).toContain('已经发了那条'))
    act(() => { (dayCell('2026-09-17') as HTMLButtonElement).click() })
    const dialog = await screen.findByRole('dialog', { name: '填写发布计划' })
    expect(dialog.textContent).toContain('当天已有 1 条内容')
    expect(dialog.textContent).toContain('已经发了那条')
  })
})

/*
 * ★ 2026-10-03:这一格的外层换成了运营同学(Air)自己写的那一份
 * (`user-layer/起步/小组件/files/index.js`)。素材那一排在她的「素材入口」那一页里(`.cf-grid`),
 * 每颗按钮的可访问名是「定位<文件夹名>」;本体那一排(`.ben-wb__assets`)
 * 在第二页「整理与图谱」里。
 */
describe('⑥ 素材管理:七个固定子文件夹', () => {
  it('七颗按钮,名字与顺序照 Ben 的草图', async () => {
    await renderLandscape(opsState())
    const row = document.querySelector('.cf-grid')
    const names = [...(row?.querySelectorAll('button') ?? [])]
      .map(n => (n.getAttribute('aria-label') ?? '').replace(/^定位/, ''))
    // 「账号」那个文件夹也在模板的 folders 里,但它不是素材 —— 这一行按 asset_dirs 的顺序出,
    // 账号排在最前面(模板里它就在第一条)。这里只确认七个素材子文件夹一个不少、顺序对。
    for (const dir of OPS_ASSET_DIRS) expect(names).toContain(dir)
    expect(names.filter(n => (OPS_ASSET_DIRS as readonly string[]).includes(n ?? ''))).toEqual([...OPS_ASSET_DIRS])
  })

  it('点一个 → 在 Finder 里打开那个绝对路径', async () => {
    const calls: { url: string, body: unknown }[] = []
    await renderLandscape(opsState(), calls)
    act(() => { screen.getByRole('button', { name: '定位脚本' }).click() })
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/files/reveal'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/files/reveal'))?.body)
      .toEqual({ path: '/Users/example/运营/素材/脚本' })
  })

  /*
   * ★ 她那一页里那个 `.cf-grid` 容器**恒在**(她的代码无条件画它),
   * 没有素材目录时里面一颗按钮都没有 —— 上一版是整条不画。
   * 守的事没变:不摆一排点不开的按钮。
   */
  it('做产品模板下一颗按钮都没有', async () => {
    await renderLandscape(productState())
    expect(document.querySelectorAll('.cf-grid button')).toHaveLength(0)
  })

  it('没配工作目录:也一颗按钮都没有', async () => {
    const template = templateStateView(OPS_TEMPLATE, { hasBackup: false })
    await renderLandscape(opsState({ template }))
    expect(document.querySelectorAll('.cf-grid button')).toHaveLength(0)
  })
})

describe('⑦ 网页型应用:窗口槽里不再摆(PR #4,维护者按截图要求去掉)', () => {
  it('自媒体模板登记了可灵 / 小红书 / 可画,窗口槽里也一颗都不画', async () => {
    await renderLandscape(opsState())
    for (const label of ['可灵', '小红书', '可画']) {
      expect(screen.queryByLabelText(`打开 ${label}(网页)`)).toBeNull()
    }
    expect(document.querySelector('.ben-wb__dock-web')).toBeNull()
  })

  it('做产品模板下一颗都没有', async () => {
    await renderLandscape(productState())
    expect(document.querySelector('.ben-wb__dock-web')).toBeNull()
  })
})

describe('⑧ 做产品模板:一个字都没变', () => {
  it('没接模板服务时,横屏还是今天那五个区域、那四格底部', async () => {
    await renderLandscape(productState())
    expect(regionTitles('.ben-wb__land-side')).toEqual(['项目区'])
    expect(regionTitles('.ben-wb__land-deck')).toEqual(['消耗数据', '余额 / 额度', '随手记', DEFAULT_MODULE_TITLES.files])
    expect(regionTitles('.ben-wb__land-stage')).toEqual(['窗口槽'])
  })

  it('三个新模块一个都不出现', async () => {
    await renderLandscape(productState())
    const all = [...document.querySelectorAll('.ben-wb__ttl')].map(n => n.textContent)
    expect(all).not.toContain('待办事项')
    expect(all).not.toContain('发布计划')
    expect(all).not.toContain('数据复盘')
  })
})
