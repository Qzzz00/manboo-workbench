/**
 * 「派活的眼睛」的两块界面(2026-09-25,卡 O):
 *
 * - 设置里「各家能做什么」:六家各三格(每格先写一个字:行 / 不行 / 没有 / 没查到,不靠颜色);
 *   「帮我接上」= `POST /agents/login`(缺那一份先装、再开它自己的登录页,账号密码不经手);打开这一节就现查一遍(连窗口);
 *   下面「每件事的上限」改两个数 = `POST /butler/budget`。
 * - 外层那件事的卡:花了多少 / 上限多少;「停掉这一件」= `POST /butler/item/stop`;到上限的三颗键;
 *   派不出去时为什么 + 「帮我接上」+「先交给 Codex 做」(= `POST /dispatch/run`,kind 照卡上那一格)。
 * 2026-10-22 起「各家能做什么」照评审页画成一张表(行就打勾、不行一道横线),每格凭什么、怎么修、额度收在每家的「详情」里;
 * 「每件事的上限」收进折叠。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentCapsPanel } from '../src/client/AgentCapsPanel.tsx'
import { QuotaPanel } from '../src/client/QuotaPanel.tsx'
import { emptyStateFor } from '../src/client/emptyState.ts'
import { forgetQuotaMemory, quotasFor } from '../src/server/agentQuota.ts'
import { ItemControls } from '../src/client/ItemControls.tsx'
import { budgetLine, stoppable } from '../src/client/itemControlsModel.ts'
import type { AgentCapsView, SessionView, TaskView, AgentQuotaView } from '../src/protocol.ts'
import { agentCapsFrom } from '../src/server/agentCaps.ts'

configure({ asyncUtilTimeout: 5_000 })
afterEach(() => { cleanup() })
/**
 * 「上次读到的那个数」记在 agentQuota 模块里(卡 QS)。这份文件下面那一块在**模块层**就算了一批
 * `quotasFor(...)`(有数那几家),于是记忆先被填上;不清零的话,上面那一块里同一家就会顶着那个数,
 * 用例的红绿取决于 describe 的先后 —— 同 server-agent-quota 那条老规矩,一条一条地立场景。
 */
beforeEach(() => { forgetQuotaMemory() })

/** 表里那一家点「详情」,返回摊开的那一块。 */
async function detail(title: string): Promise<HTMLElement> {
  const row = (await screen.findByRole('cell', { name: title })).closest('tr') as HTMLElement
  const open = within(row).getByRole('button', { name: '详情' })
  if (open.getAttribute('aria-expanded') !== 'true') await userEvent.click(open)
  return screen.getByRole('group', { name: `${title} 的详情` })
}

const CAPS: AgentCapsView = {
  ...agentCapsFrom({
    installed: { claude: true, codex: true, kimi: true, muse: true, manus: true, doubao: false },
    helper: { connected: true, authorized: true, newConversation: true, readReply: true },
    window: { kimi: { state: 'sheet', title: '设置', button: '取消', at: '2026-09-25T15:00:00.000Z' } },
    cli: { claude: { found: true, login: 'no' }, codex: { found: true, login: 'yes' } },
  }, { checked_at: '2026-09-25T07:03:00.000Z' }),
}

function fakeServer() {
  const posts: { path: string, body: Record<string, unknown> }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('http://wb', '')
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ path, body })
      if (path === '/agents/caps/check') return new Response(JSON.stringify(CAPS), { status: 200 })
      if (path === '/butler/budget') return new Response(JSON.stringify({ ok: true, cny: body.cny, minutes: body.minutes, note: `记下了:每件事到 ${String(body.cny)} 元或 ${String(body.minutes)} 分钟先停下来问你` }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, note: '开了一个窗口跑 Claude 自己的登录' }), { status: 200 })
    }
    if (path === '/agents/caps') return new Response(JSON.stringify(CAPS), { status: 200 })
    if (path === '/agents/quota') return new Response(JSON.stringify({ agents: quotasFor(['claude', 'codex', 'kimi', 'doubao', 'muse', 'manus'], { quota: {}, now: new Date('2026-09-25T10:00:00Z') }) }), { status: 200 })
    if (path === '/butler/budget') return new Response(JSON.stringify({ cny: 0.5, minutes: 10 }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, posts }
}

describe('设置:各家能做什么', () => {
  it('★每家三格 + 一行额度,不靠颜色(每格先写一个字);打开就现查一遍(连窗口);Claude 那格给「帮我接上」', async () => {
    const { fetchImpl, posts } = fakeServer()
    render(<AgentCapsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    // 表上一格只画勾 / 横线;「行 / 不行 / 没有」那个字在格子的 title 与「详情」里写着(不靠颜色)
    const claudeRow = await detail('Claude')
    expect(claudeRow).toHaveTextContent('要让 Claude 直接改你电脑上的文件,还差一步:登录一次')
    expect(claudeRow).toHaveTextContent('不行')
    expect(await detail('Kimi')).toHaveTextContent('在 Kimi 那扇窗上点「取消」,把对话框关掉')
    expect(await detail('Muse')).toHaveTextContent('没有')
    // 额度那一行(三格之一):两家都还没读到,各自说清原因(★卡 QD:豆包办公不再是「不限」)。
    await waitFor(async () => expect(await detail('豆包办公'))
      .toHaveTextContent('额度:没接上 · 没接上:还没读过豆包办公窗口上的额度(豆包办公的额度只在它「订阅与额度管理」那一页上)'))
    expect(await detail('Muse')).toHaveTextContent('额度:没接上 · 没接上:还没读过 Muse 窗口上的额度(Muse 有用量上限,剩多少只在它自己的「使用情况」页上)')
    await waitFor(() => expect(posts.some(one => one.path === '/agents/caps/check')).toBe(true))
    expect(posts.some(one => one.path === '/agents/caps/check' && one.body.window === true)).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: '重新查一遍' }))
    await waitFor(() => expect(posts.some(one => one.path === '/agents/caps/check' && one.body.window === true)).toBe(true))
    await userEvent.click(within(await detail('Claude')).getByRole('button', { name: '帮我接上' }))
    await waitFor(() => expect(posts.some(one => one.path === '/agents/login' && one.body.family === 'claude')).toBe(true))
    expect(await screen.findByRole('status')).toHaveTextContent('自己的登录')
  })

  it('每件事的上限:改两个数、存 = POST /butler/budget', async () => {
    const { fetchImpl, posts } = fakeServer()
    render(<AgentCapsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await userEvent.click(await screen.findByText(/^每件事的上限 · /))
    const cny = await screen.findByRole('textbox', { name: '每件事最多花多少元' })
    await userEvent.clear(cny)
    await userEvent.type(cny, '1')
    await userEvent.click(screen.getByRole('button', { name: '存这两个数' }))
    await waitFor(() => expect(posts.find(one => one.path === '/butler/budget')?.body).toEqual({ cny: 1, minutes: 10 }))
  })
})

const RUNNING: SessionView = {
  agent: 'dsh', session_id: 's-1', project: '', status: 'running', elapsed_sec: 180, unread: false, updated_at: '2026-09-25T15:00:00.000Z',
} as SessionView

function task(patch: Partial<TaskView>): TaskView {
  return { id: 't-1', title: '修首页球的显示问题', status: 'doing', direction: 'mine', source: { kind: 'manual' }, created_at: '', updated_at: '', ...patch }
}

describe('外层那件事的卡', () => {
  it('★事务官自己在办:花了多少 / 上限多少 + 「停掉这一件」= POST /butler/item/stop', async () => {
    const { fetchImpl, posts } = fakeServer()
    const one = task({ conversation: { agent: 'dsh', session_id: 's-1' }, budget: { limit_cny: 0.5, limit_minutes: 10, spent_cny: 0.14, run_minutes: 3.4, state: 'running', model: 'deepseek-v4-flash' } })
    render(<ItemControls task={one} sessions={[RUNNING]} baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(screen.getByText('花了约 0.14 元 · 跑了 3 分钟(上限 0.5 元 / 10 分钟) · deepseek-v4-flash')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '停掉这一件' }))
    await waitFor(() => expect(posts).toEqual([{ path: '/butler/item/stop', body: { id: 't-1' } }]))
  })

  it('到上限停下来了:三颗键(继续 / 停掉这一件 / 换 Claude 来做)', async () => {
    const { fetchImpl, posts } = fakeServer()
    const one = task({ status: 'blocked', conversation: { agent: 'dsh', session_id: 's-1' }, budget: { limit_cny: 0.5, limit_minutes: 10, spent_cny: 0.52, state: 'paused', note: '到上限了,先停下来了', switch_to: 'Claude' } })
    render(<ItemControls task={one} sessions={[RUNNING]} baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(screen.getByText('到上限了,先停下来了')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '换 Claude 来做' }))
    await waitFor(() => expect(posts).toEqual([{ path: '/butler/item/budget', body: { id: 't-1', choice: 'switch' } }]))
    // 2026-10-04:每件**非终态**事项末尾多一颗「取消事项」(走 /task/move,见 client-item-cancel-20261004)。
    expect(screen.getAllByRole('button').map(one => one.textContent)).toEqual(['继续', '停掉这一件', '换 Claude 来做', '取消事项'])
  })

  it('★派不出去(Claude 还差一步):为什么 + 「帮我接上」+「先交给 Codex 做」(kind 照卡上那一格)', async () => {
    const { fetchImpl, posts } = fakeServer()
    const one = task({
      status: 'blocked',
      dispatch_block: {
        family: 'claude', kind: 'code', why: '要让 Claude 直接改你电脑上的文件,还差一步:登录一次', at: 'x',
        fix: { kind: 'login_cli', family: 'claude', label: '帮我接上', hint: '会开一个窗口跑 Claude 自己的登录,账号密码在它自己的登录页上填,工作台不经手', desk_only: true },
        alternatives: [{ family: 'codex', title: 'Codex', note: '5 小时窗口还剩约 80%' }, { family: 'dsh', title: '事务官自己做' }],
      },
    })
    render(<ItemControls task={one} sessions={[]} baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(screen.getByText('要让 Claude 直接改你电脑上的文件,还差一步:登录一次')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '帮我接上' }))
    await userEvent.click(screen.getByRole('button', { name: '先交给 Codex 做' }))
    await waitFor(() => expect(posts).toEqual([
      { path: '/agents/login', body: { family: 'claude' } },
      { path: '/dispatch/run', body: { item_id: 't-1', app: 'codex', kind: 'code' } },
    ]))
  })

  it('卡上的备注已经说了的那一句不再念一遍(到上限 / 派不出去);不在电脑前只补一句修法在哪', async () => {
    const { blockLine, pausedLine } = await import('../src/client/itemControlsModel.ts')
    const why = '要让 Claude 直接改你电脑上的文件,还差一步:登录一次'
    const fix = { kind: 'login_cli' as const, family: 'claude' as const, label: '帮我接上', desk_only: true }
    const blocked = task({ note: `没派给 Claude:${why}(点「帮我接上」)`, dispatch_block: { family: 'claude', kind: 'code', why, at: 'x', fix } })
    expect(blockLine(blocked, true)).toBeUndefined()
    expect(blockLine(blocked, false)).toBe('要在电脑前点「帮我接上」')
    const { note: _said, ...unsaid } = blocked
    expect(blockLine(unsaid, true)).toBe(why)
    const note = '到上限了,先停下来了:花了约 0.52 元'
    expect(pausedLine(task({ note, budget: { limit_cny: 0.5, limit_minutes: 10, state: 'paused', note } }))).toBeUndefined()
    expect(pausedLine(task({ budget: { limit_cny: 0.5, limit_minutes: 10, state: 'paused', note } }))).toBe(note)
    render(<ItemControls task={blocked} sessions={[]} baseUrl="http://wb" fetchImpl={fetch} />)
    expect(screen.queryByText(why)).toBeNull()
    expect(screen.getByRole('button', { name: '帮我接上' })).toBeInTheDocument()
  })

  it('什么都没有的卡:整块不画;判据', () => {
    // 2026-10-04:「整块不画」现在只剩**终态**那两种 —— 非终态的卡上至少还有一颗「取消事项」。
    const { container } = render(<ItemControls task={task({ status: 'done' })} sessions={[]} baseUrl="http://wb" fetchImpl={fetch} />)
    expect(container.querySelector('[data-testid="item-controls"]')).toBeNull()
    expect(stoppable(task({ dispatch: { family: 'codex', status: 'running', hand: 'cli', started_at: 'x', pid: 1 } }), [])).toBe(true)
    expect(stoppable(task({ client_dispatch: { hand: 'window', family: 'kimi', status: 'sent', at: 'x', text: 'y', reply_state: 'waiting' } }), [])).toBe(true)
    expect(stoppable(task({ status: 'done', client_dispatch: { hand: 'window', family: 'kimi', status: 'sent', at: 'x', text: 'y', reply_state: 'waiting' } }), [])).toBe(false)
    expect(budgetLine({ limit_cny: 0.5, limit_minutes: 10, state: 'running' })).toBe('还没算出花了多少(上限 0.5 元 / 10 分钟)')
  })
})

describe('派活确认点(卡 O):能派给的几家一家一行', () => {
  /**
   * 2026-09-28(卡 UX):这一问默认**只摆这次问的那一家**,别家收成一行「其他可选:…」+「展开看额度」——
   * 展开之后才一家一行(字一个没少)。大字第一行改成「把「…」派给 Manus?」。
   */
  it('★这次问的那家摆在眼前;展开之后每家一行、各带额度那一格;长句不再挤成一行省略号', async () => {
    const { ApprovalRows } = await import('../src/client/composer/ApprovalRows.tsx')
    render(<ApprovalRows baseUrl="http://wb" fetchImpl={fetch} approvals={[{
      id: 'a', session_id: 'dispatch:t-1', tool: '派给 Manus(剩 1,234 积分)', say: '派给 Manus(剩 1,234 积分)', reason: '聊天 / 问答的活 → 派给 Manus(剩 1,234 积分);也能派给……', at: 'x',
      options: [
        { family: 'manus', title: 'Manus', quota: '剩 1,234 积分', state: 'numbers', chosen: true },
        { family: 'doubao', title: '豆包', quota: '不限', state: 'unlimited' },
        { family: 'muse', title: 'Muse', quota: '没接上:剩多少只在它的「使用情况」页上', state: 'unconnected' },
        { family: 'dsh', title: '事务官自己做', quota: '用 deepseek-v4-flash,大概 10 分钟内、不超过 0.5 元(到了先停下来问你)' },
      ],
    }]} />)
    expect(Array.from(screen.getByRole('list', { name: '这次问的那一家' }).querySelectorAll('li')).map(li => li.textContent))
      .toEqual(['Manus剩 1,234 积分'])
    expect(screen.getByText('其他可选:豆包 / Muse / 事务官自己做', { exact: false })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '展开看额度' }))
    const rows = screen.getByRole('list', { name: '能派给的几家' }).querySelectorAll('li')
    expect(Array.from(rows).map(li => li.textContent)).toEqual([
      '豆包不限',
      'Muse没接上:剩多少只在它的「使用情况」页上',
      '事务官自己做用 deepseek-v4-flash,大概 10 分钟内、不超过 0.5 元(到了先停下来问你)',
    ])
    // 大字第一行是这一问本身;这张没配上卡(查不到事项)时说「这件事」。
    expect(screen.getByText('把这件事派给 Manus?')).toBeInTheDocument()
  })
})

describe('事务官页那张卡的颜色', () => {
  it('他按的停止(interrupted)不染红;到上限停下来等他回话是琥珀(同等他批)', async () => {
    const { buildButlerScene } = await import('../src/client/butlerSceneModel.ts')
    const base = { now: '2026-09-25T15:00:00.000Z', stale: false, agents: [], quota: {}, butler_inbox: { items: [] } }
    const stoppedSession = { ...RUNNING, status: 'error', reason: 'interrupted' } as SessionView
    const stopped = task({ status: 'todo', conversation: { agent: 'dsh', session_id: 's-1' }, links: [{ agent: 'dsh', session_id: 's-1' }] })
    const scene1 = buildButlerScene({ ...base, sessions: [stoppedSession], tasks: { tasks: [stopped] } } as never)
    expect(scene1.items[0]?.notice).not.toBe('failed')
    const paused = task({ status: 'blocked', block_reason: 'input', conversation: { agent: 'dsh', session_id: 's-1' }, budget: { limit_cny: 0.5, limit_minutes: 10, state: 'paused' } })
    const scene2 = buildButlerScene({ ...base, sessions: [stoppedSession], tasks: { tasks: [paused] } } as never)
    expect(scene2.items[0]?.notice).toBe('confirmation')
  })
})

describe('额度区:老四格之外的那几家(统筹 09-25:Muse、Manus、豆包不许什么都没有)', () => {
  const AT = '2026-09-25T09:40:00.000Z'
  const QUOTAS = quotasFor(['claude', 'doubao', 'muse', 'manus'], {
    quota: { claude: { kind: 'quota', windows: [{ label: '周', left_pct: 62 }] } },
    now: new Date('2026-09-25T10:00:00.000Z'),
    window: {
      manus: { last: { at: AT, width: 1200, matches: [{ id: 'credits', text: '1,234', x: 1100, y: 20 }] }, attempt: { at: AT, found: true } },
      // 豆包办公的「订阅与额度管理」页开着(卡 QD):两扇窗 → 面板上两条横条。
      doubao: { last: { at: AT, matches: [
        { id: 'page', text: '订阅与额度管理', x: 520, y: 212 },
        { id: 'window_5h', text: '当前时段', x: 420, y: 400 },
        { id: 'used', text: '已用 <1%', x: 860, y: 400 },
        { id: 'window_7d', text: '近 7 天', x: 420, y: 500 },
        { id: 'used', text: '已用 <1%', x: 860, y: 500 },
      ] }, attempt: { at: AT, found: true } },
    },
  })

  function server() {
    const posts: { path: string, body: unknown }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ path: String(input).replace('http://wb', ''), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    return { posts, fetchImpl }
  }

  /**
   * ★ 2026-09-30 维护者拍板把「带我过去」全删(见 `docs/决策记录.md` 末尾那一条):
   * 没接上的那一行**一颗键都不画**,该她自己去打开哪一页那句人话直接摆在行上那句话里
   *(服务端 `windowUnconnected` 把原来 `fix.hint` 那句并进了 `line` / `why`)。
   */
  it('★每家一格、三格之一(有数 / 不限 / 没接上:原因);老四格里的 Claude 不重复画;没接上的只说一句话、不摆键(2026-09-30 维护者拍板全删)', async () => {
    const { posts, fetchImpl } = server()
    render(<QuotaPanel quota={{}} now="2026-09-25T10:00:00.000Z" agentQuota={QUOTAS} baseUrl="http://wb" fetchImpl={fetchImpl} />)
    const doubao = screen.getByRole('listitem', { name: '豆包办公' })
    // ★卡 QD(2026-09-26):窗口型额度 → 照老四格画**两条**横条(当前时段 / 近 7 天),不再是一句「不限」。
    expect(doubao.querySelectorAll('.ben-wb__usage-qbar')).toHaveLength(2)
    expect([...doubao.querySelectorAll('.ben-wb__usage-qlabel')].map(one => one.textContent)).toEqual(['5时', '周'])
    expect([...doubao.querySelectorAll('.ben-wb__usage-qpct')].map(one => one.textContent)).toEqual(['99%', '99%'])
    expect(doubao).not.toHaveTextContent('不限')
    expect(doubao).toHaveTextContent('在豆包办公窗口上读到的')
    const manus = screen.getByRole('listitem', { name: 'Manus' })
    expect(manus).toHaveTextContent('1,234 积分')
    expect(manus).toHaveTextContent('在 Manus 窗口上读到的')
    const muse = screen.getByRole('listitem', { name: 'Muse' })
    expect(muse).toHaveTextContent('没接上')
    expect(muse).toHaveTextContent('Muse 有用量上限,剩多少只在它自己的「使用情况」页上')
    expect(screen.getAllByRole('listitem', { name: 'Claude' })).toHaveLength(1)
    // 该她自己去点的那一步:写在行上那句话里(原来写在「带我过去」旁边)。
    expect(muse).toHaveTextContent('在 Muse 的设置里打开「使用情况」,那扇窗留在你这会儿看着的桌面上,工作台看一眼就记下')
    // 键全没了:这一行上一颗按钮都不画,自然也没有任何请求发出去。
    expect(within(muse).queryAllByRole('button')).toHaveLength(0)
    await waitFor(() => expect(posts).toEqual([]))
  })

  /**
   * 2026-09-26(卡 SM,按卡 QS 交接第八节第 2 条改的新意思):「还没接上任何一家的凭据」那一句
   * 现在也看 `/state.agent_quota` —— **哪一家摆着一个真数字,这一句就不出场**。所以原来那一例
   * (Manus 摆着「1,234 积分」、整块同时压一句「还没接上任何一家」)在新意思下压根不成立,
   * 拆成两例:① 有一个真数字 → 那一句不出场;② 真的一个数都没有 → 那一句出场,其余几家照画。
   */
  it('★屏幕上摆着一个真数字(哪一家都算)→ 整块不再说「还没接上任何一家」', () => {
    // 老四格这一轮一格数都没有(quota 是空的),但 Manus 那一行是「1,234 积分」。
    expect(emptyStateFor('quota', { onboarding: { done: false }, quota: {}, agent_quota: QUOTAS })).toBeUndefined()
    render(<QuotaPanel quota={{}} now="2026-09-25T10:00:00.000Z" agentQuota={QUOTAS} />)
    expect(screen.queryByText(/还没接上任何一家/)).toBeNull()
    expect(screen.getByRole('listitem', { name: 'Manus' })).toHaveTextContent('1,234 积分')
  })

  it('一个真数字都没有(那一句真该出场)时,其余几家照画 —— 每家都要有一行', () => {
    // 刚装好的那台:有数那几家换成各自「没接上」(豆包办公 09-26 起也在这一路里 —— 那一页没开着就是没接上)。
    const fresh = QUOTAS.map(one => (one.state === 'numbers'
      ? { id: one.id, title: one.title, state: 'unconnected' as const, line: `没接上:${one.title} 没开着` }
      : one))
    const empty = emptyStateFor('quota', { onboarding: { done: false }, quota: {}, agent_quota: fresh })
    expect(empty?.title).toBe('还没有接上额度')
    render(<QuotaPanel quota={{}} now="2026-09-25T10:00:00.000Z" agentQuota={fresh} empty={empty as never} />)
    expect(screen.getByText(empty?.line as string)).toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: '豆包办公' })).toHaveTextContent('没接上')
    expect(screen.getByRole('listitem', { name: 'Muse' })).toHaveTextContent('没接上')
    expect(screen.queryByRole('button', { name: '带我过去' })).toBeNull()
  })
})

describe('「等你」那一堆里要他定的(卡 O;统筹:「阻塞·等你输入」属于只有他能做的就进那一堆)', () => {
  it('★派不出去 / 到上限停下来了 → 各算一件「要你定」;那件事已经有一问挂在外层(卡 M 的提问)就不再算', async () => {
    const { waitingOnHim } = await import('../src/waiting.ts')
    const blocked = task({ id: 't-b', title: '修一下首页球的显示问题', status: 'blocked', block_reason: 'input', dispatch_block: { family: 'claude', kind: 'code', why: '要让 Claude 直接改你电脑上的文件,还差一步:登录一次', at: 'x', fix: { kind: 'login_cli', family: 'claude', label: '帮我接上' } } })
    const paused = task({ id: 't-p', title: '整理一下待办', status: 'blocked', block_reason: 'input', budget: { limit_cny: 0.5, limit_minutes: 10, state: 'paused', cli_family: 'claude' } })
    const asked = task({ id: 't-q', title: '已经在外层问了的', status: 'blocked', block_reason: 'input', budget: { limit_cny: 0.5, limit_minutes: 10, state: 'paused' } })
    const done = task({ id: 't-d', title: '办完了', status: 'done', budget: { limit_cny: 0.5, limit_minutes: 10, state: 'paused' } })
    const pile = waitingOnHim({
      tasks: { tasks: [blocked, paused, asked, done] },
      questions: [{ id: 'q1', session_id: 's', task_id: 't-q', task_title: '已经在外层问了的', at: 'x', questions: [{ id: 'budget', question: '到上限了', multi: false, options: [] }] }],
    } as never)
    expect(pile.items.map(one => [one.key, one.kind, one.verb])).toEqual([
      ['question:q1', 'question', '答'],
      ['decide:t-b', 'decide', '答'],
      ['decide:t-p', 'decide', '答'],
    ])
    expect(pile.items[1]?.text).toBe('「修一下首页球的显示问题」派给 Claude 还差一步,要你接上或者先交给别家')
    expect(pile.items[2]?.text).toBe('「整理一下待办」到上限先停下来了,继续还是停')
    expect(pile.count).toBe(3)
  })
})

/**
 * **读到数的那一行不挂催她的键**(2026-09-26 晚,卡 QG)。维护者 22:40 原话:
 * 「muse 和豆包办公都已经取到了,为什么还有那两个按钮啊?」
 *
 * ★ 2026-09-30 维护者拍板把「带我过去」那一整套键全删(见 `docs/决策记录.md` 末尾那一条):
 * 服务端连 `fix` 都不给了,所以这一侧钉的是**更硬的一条** —— 有数的那一行上一颗按钮都没有。
 * 这里仍留一个带 `fix.quiet` 的假数据,钉住 `quiet` 那条收纳规矩本身没坏(别的家还用得上,
 * 比如 Kimi 的「去登录」、工作台服务的「去接上」)。
 */
describe('已经读到数的那一行:行上一颗键都不画(卡 QG → 2026-09-30 维护者拍板全删)', () => {
  const READ: AgentQuotaView = {
    id: 'muse',
    title: 'Muse',
    state: 'numbers',
    level: 'ok',
    left_pct: 97,
    line: '还剩约 97% · 21:52 读到的',
    short: '还剩约 97% · 21:52 读到的',
    read_at: '2026-09-25T09:40:00.000Z',
    source: '21:52 在 Muse 窗口上读到的(「使用情况」页上写着「3% used」)',
    fix: { kind: 'grant_ax', label: '去授权', hint: '在 Muse 的设置里打开「使用情况」', desk_only: true, quiet: true },
  }

  it('★行上一颗键都不画;「说明」里也没有「再读一次」(2026-09-27 撤了,他切走那家时自己会读)', async () => {
    render(<QuotaPanel quota={{}} now="2026-09-25T10:00:00.000Z" agentQuota={[READ]} baseUrl="http://wb" />)
    const muse = screen.getByRole('listitem', { name: 'Muse' })
    expect(muse).toHaveTextContent('97%')
    expect(within(muse).queryAllByRole('button')).toHaveLength(0)
    expect(within(muse).queryByRole('button', { name: '再读一次' })).toBeNull()
  })
})
