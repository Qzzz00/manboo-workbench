import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentCapsView, AgentCard, AgentEntryView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const DAY = '2026-10-22'
const AT = new Date(`${DAY}T08:00:00`).toISOString()
const note = (id: string): TaskView => ({ id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT })

function stateWith(opts: {
  registry?: AgentEntryView[]
  cards?: AgentCard[]
  caps?: AgentCapsView
  mcp?: NonNullable<WorkbenchState['tasks']>['mcp']
}): WorkbenchState {
  return {
    now: new Date(`${DAY}T12:00:00`).toISOString(),
    sessions: [],
    tasks: { tasks: [note('x')], sprints: [], modules: [], project_meta: [], goals: [], goal_sprints: [], agent_cards: opts.cards ?? [], session_proposals: [], squads: [], timers: [], mcp: opts.mcp ?? [] },
    agent_registry: { entries: opts.registry ?? [], asking: [], notices: [] },
    ...(opts.caps === undefined ? {} : { agent_caps: opts.caps }),
  } as unknown as WorkbenchState
}

/** 体检那一行的几种现成形状。 */
function capsRow(family: string, patch: Record<string, unknown>): AgentCapsView {
  return {
    agents: [{
      family, title: family,
      cells: {
        chat: { state: 'ok', note: 'n' },
        edit: { state: 'ok', via: 'cli', note: 'n' },
        collect: { state: 'ok', note: 'n' },
      },
      line: `${family} 那一行`,
      ...patch,
    }],
    line: 'l',
  } as unknown as AgentCapsView
}

function fakeFetch(handlers: Record<string, unknown> = {}) {
  const calls: { path: string, method: string, body?: Record<string, unknown> }[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path: url.pathname, method, ...(body === undefined ? {} : { body }) })
    const json = url.pathname === '/collab/canvas' ? { layout: { goals: {}, notes: {} } }
      : url.pathname === '/dispatch/skills' ? { builtin: ['huashu-report'], mine: [] }
        : url.pathname === '/collab/github' ? { state: 'unconfigured' }
          : url.pathname === '/token/personal' ? { tokens: [] }
            : url.pathname.endsWith('/trace') ? { events: [] }
              : handlers[url.pathname] ?? { ok: true }
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, impl }
}

const REGISTRY = [
  { id: 'codex', name: 'Codex', status: 'running' },
  { id: 'kimi', name: 'Kimi', status: 'idle' },
  { id: 'doubao', name: '豆包', status: 'running' },
] as unknown as AgentEntryView[]

async function openCards(state: WorkbenchState) {
  const user = userEvent.setup()
  const fetch = fakeFetch()
  render(<div style={{ position: 'relative' }}><CollabZone state={state} baseUrl="http://127.0.0.1:8791" fetchImpl={fetch.impl} presence={[]} visible nowMs={Date.parse(`${DAY}T12:00:00`)} timelineWidth={1228} /></div>)
  await user.click(screen.getByRole('button', { name: '设置' }))
  await user.click(within(screen.getByRole('navigation', { name: '设置' })).getByRole('button', { name: 'Agent 名片' }))
  const form = screen.getByRole('form', { name: '登记一张 Agent 名片' })
  return { user, fetch, form }
}

const posts = (calls: ReturnType<typeof fakeFetch>['calls'], path: string) => calls.filter(one => one.method === 'POST' && one.path === path)

describe('名片编辑表单:六段', () => {
  it('六段按 1→6 排:名字 → 哪一家 →(命令行家)仓库/模型/强度/智能体文件 → 擅长什么 → 带哪些技能 → 分配哪些 MCP → 共享', async () => {
    const { user, form } = await openCards(stateWith({ registry: REGISTRY, caps: capsRow('codex', {}) }))
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    const order = ['名字', '哪一家', '仓库(本地路径)', '模型', '强度', '智能体文件', '擅长什么', '带哪些技能', '分配哪些 MCP', '共享']
    const text = form.textContent ?? ''
    let at = -1
    for (const one of order) {
      const next = text.indexOf(one, at + 1)
      expect(next, `「${one}」应按六段顺序出现`).toBeGreaterThan(at)
      at = next
    }
  })

  it('段3 只在命令行家(claude/codex/kimi)出现;选豆包消失', async () => {
    const { user, form } = await openCards(stateWith({ registry: REGISTRY }))
    expect(within(form).queryByLabelText('仓库(本地路径)')).toBeNull()
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    expect(within(form).getByLabelText('仓库(本地路径)')).toBeInTheDocument()
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'kimi')
    expect(within(form).getByLabelText('仓库(本地路径)')).toBeInTheDocument()
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'doubao')
    expect(within(form).queryByLabelText('仓库(本地路径)')).toBeNull()
    expect(within(form).queryByLabelText('模型')).toBeNull()
  })

  it('模型下拉:第一项「缺省,由那家自己定」;claude 给 sonnet/opus/haiku,codex 只有缺省;kimi 给 kimi-for-coding', async () => {
    const reg = [...REGISTRY, { id: 'claude', name: 'Claude', status: 'running' }] as unknown as AgentEntryView[]
    const { user, form } = await openCards(stateWith({ registry: reg }))
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'claude')
    let model = within(form).getByLabelText('模型')
    expect(within(model).getByRole('option', { name: '缺省,由那家自己定' })).toBeInTheDocument()
    expect(within(model).getByRole('option', { name: 'sonnet' })).toBeInTheDocument()
    expect(within(model).getByRole('option', { name: 'opus' })).toBeInTheDocument()
    expect(within(model).getByRole('option', { name: 'haiku' })).toBeInTheDocument()
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    model = within(form).getByLabelText('模型')
    expect(within(model).getByRole('option', { name: '缺省,由那家自己定' })).toBeInTheDocument()
    expect(within(model).queryByRole('option', { name: 'sonnet' })).toBeNull()
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'kimi')
    model = within(form).getByLabelText('模型')
    expect(within(model).getByRole('option', { name: 'kimi-for-coding' })).toBeInTheDocument()
  })

  it('强度选项字:缺省 / 低 / 中 / 高(值仍是 low/medium/high)', async () => {
    const { user, form } = await openCards(stateWith({ registry: REGISTRY }))
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    const effort = within(form).getByLabelText('强度')
    expect(within(effort).getByRole('option', { name: '缺省' })).toHaveValue('')
    expect(within(effort).getByRole('option', { name: '低' })).toHaveValue('low')
    expect(within(effort).getByRole('option', { name: '中' })).toHaveValue('medium')
    expect(within(effort).getByRole('option', { name: '高' })).toHaveValue('high')
  })

  it('「选文件夹」用 webkitdirectory 推出目录填进仓库栏;选不出来不动', async () => {
    const { user, form } = await openCards(stateWith({ registry: REGISTRY }))
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    const repo = within(form).getByLabelText('仓库(本地路径)')
    const picker = within(form).getByLabelText('选文件夹', { selector: 'input' })
    expect(picker).toHaveAttribute('webkitdirectory')
    const file = new File(['x'], 'index.ts')
    Object.defineProperty(file, 'webkitRelativePath', { value: '我的项目/src/index.ts' })
    await user.upload(picker, file)
    expect(repo).toHaveValue('我的项目/src')
    // 取消选择(空文件列表)不动现在的值
    fireEvent.change(picker, { target: { files: [] } })
    expect(repo).toHaveValue('我的项目/src')
  })

  it('智能体文件「打开」:有仓库时 POST /files/reveal 仓库+文件;文件不存在再开它所在目录', async () => {
    const { user, form, fetch } = await openCards(stateWith({ registry: REGISTRY, caps: capsRow('codex', {}) }))
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    await user.type(within(form).getByLabelText('仓库(本地路径)'), '/repo/k')
    await user.type(within(form).getByLabelText('智能体文件'), 'docs/卡/agents/kimi-coder.md')
    await user.click(within(form).getByRole('button', { name: '打开' }))
    await waitFor(() => expect(posts(fetch.calls, '/files/reveal').length).toBeGreaterThan(0))
    expect(posts(fetch.calls, '/files/reveal')[0]?.body).toEqual({ path: '/repo/k/docs/卡/agents/kimi-coder.md' })
  })

  it('「打开」键在仓库空着时不给按', async () => {
    const { user, form } = await openCards(stateWith({ registry: REGISTRY }))
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    expect(within(form).getByRole('button', { name: '打开' })).toBeDisabled()
  })

  it('时长上限(分钟)在段 3(命令家家)出现,缺省 120;选窗口家(豆包)不显示(2026-10-23 卡「派活给名片的四处」③)', async () => {
    const { user, form } = await openCards(stateWith({ registry: REGISTRY }))
    expect(within(form).queryByLabelText('时长上限(分钟)')).toBeNull()
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'kimi')
    const minutes = within(form).getByLabelText('时长上限(分钟)')
    expect(minutes).toBeInTheDocument()
    expect(minutes).toHaveValue('120')
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'doubao')
    expect(within(form).queryByLabelText('时长上限(分钟)')).toBeNull()
  })

  it('存的时候:填了时长上限 → payload 带 budget.minutes;清空 → 不带(不动那一格)', async () => {
    const { user, form, fetch } = await openCards(stateWith({ registry: REGISTRY, caps: capsRow('kimi', {}) }))
    const fill = async (minutes?: string): Promise<void> => {
      await user.type(within(form).getByLabelText('名字'), '小K')
      await user.selectOptions(within(form).getByLabelText('哪一家'), 'kimi')
      const field = within(form).getByLabelText('时长上限(分钟)')
      if (minutes !== undefined) {
        await user.clear(field)
        if (minutes !== '') await user.type(field, minutes)
      }
      await user.click(within(form).getByRole('button', { name: '存名片' }))
    }
    // 缺省 120 原样提交。
    await fill()
    await waitFor(() => expect(posts(fetch.calls, '/collab/agent/save').length).toBe(1))
    expect(posts(fetch.calls, '/collab/agent/save')[0]?.body).toMatchObject({ budget: { minutes: 120 } })
    // 清空再存:不带上限(服务端不动老卡那一格)。
    await fill('')
    await waitFor(() => expect(posts(fetch.calls, '/collab/agent/save').length).toBe(2))
    expect(posts(fetch.calls, '/collab/agent/save')[1]?.body).not.toHaveProperty('budget')
    // 改成 90:照数带。
    await fill('90')
    await waitFor(() => expect(posts(fetch.calls, '/collab/agent/save').length).toBe(3))
    expect(posts(fetch.calls, '/collab/agent/save')[2]?.body).toMatchObject({ budget: { minutes: 90 } })
  })

  it('改(回填):老卡的时长上限照原样填回格子里', async () => {
    const existing = {
      id: 'agent:local:2' as AgentCard['id'], name: '小K', owner: 'me' as const, hand: 'kimi',
      runtime: { family: 'kimi' }, budget: { minutes: 90 },
      shared: { to: 'none' as const }, created_at: AT, updated_at: AT,
    }
    const { user, form } = await openCards(stateWith({ registry: REGISTRY, cards: [existing] }))
    await user.click(screen.getByRole('button', { name: '改' }))
    expect(within(form).getByLabelText('时长上限(分钟)')).toHaveValue('90')
  })

  it('段6「共享」缺省折着;点标题展开,展开后见 共享给谁 / 能动哪些仓库 / 每天上限', async () => {
    const { user, form } = await openCards(stateWith({ registry: REGISTRY }))
    const fold = within(form).getByRole('button', { name: '共享' })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    expect(within(form).queryByText('共享给谁')).toBeNull()
    await user.click(fold)
    expect(fold).toHaveAttribute('aria-expanded', 'true')
    expect(within(form).getByText('共享给谁')).toBeInTheDocument()
    expect(within(form).getByLabelText('能动哪些仓库')).toBeInTheDocument()
    expect(within(form).getByLabelText('每天上限(元)')).toBeInTheDocument()
  })
})

describe('名片编辑表单:存的时候 hand 由家自动推出', () => {
  it('命令行家且体检 edit 格 ok-via-cli → hand cli', async () => {
    const { user, form, fetch } = await openCards(stateWith({ registry: REGISTRY, caps: capsRow('codex', {}) }))
    await user.type(within(form).getByLabelText('名字'), '代码 Agent')
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    await user.click(within(form).getByRole('button', { name: '存名片' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/agent/save').length).toBe(1))
    expect(posts(fetch.calls, '/collab/agent/save')[0]?.body).toMatchObject({ hand: 'cli', runtime: { family: 'codex' } })
  })

  it('命令行家但 edit 格没探到命令行 → hand window', async () => {
    const caps = capsRow('codex', { cells: { chat: { state: 'ok', note: 'n' }, edit: { state: 'no', note: '没登录' }, collect: { state: 'ok', note: 'n' } } })
    const { user, form, fetch } = await openCards(stateWith({ registry: REGISTRY, caps }))
    await user.type(within(form).getByLabelText('名字'), '代码 Agent')
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    await user.click(within(form).getByRole('button', { name: '存名片' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/agent/save').length).toBe(1))
    expect(posts(fetch.calls, '/collab/agent/save')[0]?.body).toMatchObject({ hand: 'window', runtime: { family: 'codex' } })
  })

  it('非命令行家(豆包)→ hand window;体检整份缺席 → hand window', async () => {
    const { user, form, fetch } = await openCards(stateWith({ registry: REGISTRY }))
    await user.type(within(form).getByLabelText('名字'), '文案 Agent')
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'doubao')
    await user.click(within(form).getByRole('button', { name: '存名片' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/agent/save').length).toBe(1))
    expect(posts(fetch.calls, '/collab/agent/save')[0]?.body).toMatchObject({ hand: 'window', runtime: { family: 'doubao' } })
  })
})

describe('名片编辑表单:哪一家那一格', () => {
  it('体检那行的小字照抄 line;caps 缺席时小字与键都不出现', async () => {
    const { user, form } = await openCards(stateWith({ registry: REGISTRY, caps: capsRow('codex', { line: 'Codex 能聊天、能改本机文件(命令行)、能收回结果' }) }))
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    expect(within(form).getByText('Codex 能聊天、能改本机文件(命令行)、能收回结果')).toBeInTheDocument()
    cleanup()
    const again = await openCards(stateWith({ registry: REGISTRY }))
    await again.user.selectOptions(within(again.form).getByLabelText('哪一家'), 'codex')
    expect(within(again.form).queryByText('Codex 能聊天、能改本机文件(命令行)、能收回结果')).toBeNull()
  })

  it('没装(claude/codex)给「去装」,点了 POST /agents/login {family};别家没装只摆小字不摆键', async () => {
    const caps = {
      agents: [
        { family: 'codex', title: 'Codex', installed: false, cells: { chat: { state: 'na', note: '没装' }, edit: { state: 'na', note: '没装' }, collect: { state: 'na', note: '没装' } }, line: '这台电脑上没装 Codex' },
        { family: 'kimi', title: 'Kimi', installed: false, cells: { chat: { state: 'na', note: '没装' }, edit: { state: 'na', note: '没装' }, collect: { state: 'na', note: '没装' } }, line: '这台电脑上没装 Kimi' },
      ],
      line: 'l',
    } as unknown as AgentCapsView
    const { user, form, fetch } = await openCards(stateWith({ registry: REGISTRY, caps }))
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    expect(within(form).getByRole('button', { name: '去装' })).toBeInTheDocument()
    expect(within(form).queryByRole('button', { name: '去登录' })).toBeNull()
    await user.click(within(form).getByRole('button', { name: '去装' }))
    await waitFor(() => expect(posts(fetch.calls, '/agents/login')).toHaveLength(1))
    expect(posts(fetch.calls, '/agents/login')[0]?.body).toEqual({ family: 'codex' })
    cleanup()
    const kimiCase = await openCards(stateWith({ registry: REGISTRY, caps }))
    await kimiCase.user.selectOptions(within(kimiCase.form).getByLabelText('哪一家'), 'kimi')
    expect(within(kimiCase.form).getByText('这台电脑上没装 Kimi')).toBeInTheDocument()
    expect(within(kimiCase.form).queryByRole('button', { name: '去装' })).toBeNull()
  })

  it('edit 格 fix 是 login_cli 时给「去登录」,点了 POST /agents/login {family}', async () => {
    const caps = capsRow('codex', {
      cells: {
        chat: { state: 'ok', note: 'n' },
        edit: { state: 'no', note: '还差一步:登录一次', fix: { kind: 'login_cli', family: 'codex', label: '登录 Codex' } },
        collect: { state: 'ok', note: 'n' },
      },
    })
    const { user, form, fetch } = await openCards(stateWith({ registry: REGISTRY, caps }))
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    expect(within(form).getByRole('button', { name: '去登录' })).toBeInTheDocument()
    await user.click(within(form).getByRole('button', { name: '去登录' }))
    await waitFor(() => expect(posts(fetch.calls, '/agents/login')).toHaveLength(1))
    expect(posts(fetch.calls, '/agents/login')[0]?.body).toEqual({ family: 'codex' })
  })

  it('「哪只手」下拉与「豆包 · 去修」那排键没了', async () => {
    const reg = [
      { id: 'codex', name: 'Codex', status: 'running' },
      { id: 'kimi', name: 'Kimi', status: 'unknown' },
    ] as unknown as AgentEntryView[]
    const { form } = await openCards(stateWith({ registry: reg }))
    expect(within(form).queryByLabelText('哪只手')).toBeNull()
    expect(within(form).queryByLabelText('命令行')).toBeNull()
    expect(within(form).queryByRole('button', { name: /去修/ })).toBeNull()
  })
})

describe('名片编辑表单:改(回填)', () => {
  it('老卡(hand 是登记表 id、无 runtime)→ 下拉选中那家;不在表里的模型名追加成 option(值不丢)', async () => {
    const old = {
      id: 'agent:local:old' as AgentCard['id'], name: '老卡', owner: 'me' as const, hand: 'codex',
      model: { name: 'gpt-5-codex' },
      shared: { to: 'none' as const }, created_at: AT, updated_at: AT,
    }
    const { user, form } = await openCards(stateWith({ registry: REGISTRY, cards: [old] }))
    await user.click(screen.getByRole('button', { name: '改' }))
    expect(within(form).getByLabelText('哪一家')).toHaveValue('codex')
    const model = within(form).getByLabelText('模型')
    expect(within(model).getByRole('option', { name: 'gpt-5-codex' })).toBeInTheDocument()
    expect(model).toHaveValue('gpt-5-codex')
  })

  it('改已有名片时名字旁有「换头像」键,点了打开更换头像(AvatarEditor 挂上)', async () => {
    const existing = {
      id: 'agent:local:1' as AgentCard['id'], name: '代码 Agent', owner: 'me' as const, hand: 'codex',
      runtime: { family: 'codex' }, shared: { to: 'none' as const }, created_at: AT, updated_at: AT,
    }
    const { user, form } = await openCards(stateWith({ registry: REGISTRY, cards: [existing] }))
    expect(within(form).queryByRole('button', { name: '换头像' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '改' }))
    await user.click(within(form).getByRole('button', { name: '换头像' }))
    expect(screen.getByRole('dialog', { name: '更换头像 · 代码 Agent' })).toBeInTheDocument()
  })
})

describe('名片编辑表单:MCP 空态', () => {
  it('库里没有:一行「库里还没有,」+ 键「去工作室 MCP 库加」,点了切到 MCP 页签', async () => {
    const { user, form } = await openCards(stateWith({ registry: REGISTRY }))
    expect(within(form).getByText('库里还没有,')).toBeInTheDocument()
    await user.click(within(form).getByRole('button', { name: '去工作室 MCP 库加' }))
    expect(screen.getByRole('heading', { name: '工作室 MCP 库' })).toBeInTheDocument()
  })
})
