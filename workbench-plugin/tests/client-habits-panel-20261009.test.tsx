/**
 * 设置里「它学到了什么」(2026-10-09,卡「它学到了什么」;设计-事务官从她的行为里学 第三节第 4 条)。
 *
 * 钉这几件:
 *   ① 没接习惯(404)→ 整节不出现;
 *   ② 三段:正在试用 / 已经留下 / 撤掉的;一条都没有时说人话(还在攒记录…),不空白;
 *   ③ **按通用形状显示任何一种**:不认识的种类照样一行,种类名用接口给的 `kind_title`,缺了有兜底;
 *      每条写清依据(哪几次、原话如有)、什么时候开始试用;不露 id;
 *   ④ 试用中与已留下的每条一颗「撤掉」,点了先确认、再打 `POST /habits/revoke {id}`;撤掉的写明不会再自己学回来;
 *   ⑤ 明说的规矩与选题偏好在同一页看得到口径(读 `GET /butler/rules`),指回「记住的规矩」;
 *   ⑥ 进化日志有摘要(读 `GET /evolve/log`),不露提议 id;还没有时如实说。
 * 2026-10-22(新 UI 第二轮 · 设置六组,照评审页):三段并排换成「每条一句 + 撤回 + 计数 / 试用 / 验证三格」,
 * 种类、依据、原话、开始试用收进每条下面的「依据 N 条」折叠;撤掉的收进「已撤下 N 条」;
 * 口径、规矩条数、进化日志收进「依据与判据」。「撤掉」改叫「撤回」,确认是一圈提醒框里的「撤回」。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { CONFIRMS } from '../src/client/ui/index.tsx'
import { afterEach, describe, expect, it } from 'vitest'
import {
  evolveLogDigest,
  HABIT_KIND_FALLBACK,
  HABITS_EMPTY_NOTE,
  HabitsPanel,
  habitKindTitle,
  habitSinceLine,
} from '../src/client/HabitsPanel.tsx'
import type { ButlerRulesView, HabitsView, HabitView } from '../src/protocol.ts'

configure({ asyncUtilTimeout: 5_000 })
afterEach(() => { cleanup() })

const DISPATCH: HabitView = {
  id: '分派:写代码的活 · Lapis→codex',
  kind: 'dispatch',
  kind_title: '默认分派',
  text: '写代码的活 · Lapis 这类事默认派给 Codex',
  status: 'trial',
  evidence: [
    { at: '2026-10-07T03:00:00.000Z', what: '10-07 11:00 推荐 Claude,她改派 Codex' },
    { at: '2026-10-08T05:00:00.000Z', what: '10-08 13:00 推荐 Claude,她改派 Codex' },
  ],
  applied: 1,
  adopted_at: '2026-10-08T05:00:03.000Z',
  updated_at: '2026-10-08T05:00:03.000Z',
}

/** 另一张卡会加的新种类:界面不认识它,也得照样显示。 */
const STYLE = {
  id: '风格:汇报短一点',
  kind: 'style',
  kind_title: '说话风格',
  text: '汇报先说结论,三句以内',
  status: 'kept',
  evidence: [{ at: '2026-10-06T02:00:00.000Z', what: '10-06 电话里嫌汇报太长', said: '你说重点就行' }],
  applied: 4,
  adopted_at: '2026-10-06T02:00:00.000Z',
  updated_at: '2026-10-08T02:00:00.000Z',
  verdict: '试用后她没再这么说',
} as unknown as HabitView

const NO_TITLE = { ...STYLE, id: '新种:x', kind: 'whatever', kind_title: undefined, text: '某个新学到的', status: 'trial', evidence: [] } as unknown as HabitView

const QUIET_GONE: HabitView = {
  id: '时段:12', kind: 'quiet', kind_title: '什么时候打电话', text: '12 点这个钟点不打电话,改成消息',
  status: 'reverted', evidence: [], applied: 0,
  adopted_at: '2026-10-05T04:00:00.000Z', updated_at: '2026-10-06T04:00:00.000Z', verdict: '12 点她接了一通',
}

const RULES: ButlerRulesView = {
  rules: [
    {
      id: 'rule:不要蓝', text: '不要蓝', title: '不要蓝', area: 'ui', status: 'active', origin: 'said', evidence: [],
      created_at: '2026-09-24T12:00:00.000Z', updated_at: '2026-09-24T12:00:00.000Z', editable: true,
    },
    {
      id: 'rule:标题', text: '标题别用感叹号', title: '标题', area: 'content', status: 'trial', origin: 'topic', evidence: [],
      created_at: '2026-09-24T12:00:00.000Z', updated_at: '2026-09-24T12:00:00.000Z', editable: false,
    },
  ],
  retired: [],
}

const LOG = [
  '# 进化日志',
  '',
  '## 2026-10-07 试用习惯(默认分派):写代码的活 · Lapis 这类事默认派给 Codex',
  '',
  '- **为什么**:10-07 11:00 推荐 Claude,她改派 Codex',
  '- **提议 id**:`分派:写代码的活 · Lapis→codex`',
  '- **留下**:2026-10-08 —— 下一次她照派了(习惯 id `分派:写代码的活 · Lapis→codex`)',
  '',
].join('\n')

function fakeServer(options: { habits: HabitsView | null, rules?: ButlerRulesView | null, log?: string | null }) {
  let habits = options.habits
  const posts: { path: string, body: Record<string, unknown> }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('http://wb', '')
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ path, body })
      if (path === '/habits/revoke' && habits !== null) {
        const all = [...habits.trial, ...habits.kept]
        const gone = all.find(one => one.id === body.id)
        habits = {
          trial: habits.trial.filter(one => one.id !== body.id),
          kept: habits.kept.filter(one => one.id !== body.id),
          retired: gone === undefined ? habits.retired : [{ ...gone, status: 'removed' }, ...habits.retired],
        }
      }
      return new Response(JSON.stringify({ ok: true, note: '撤掉了,以后不再自己学回来。' }), { status: 200 })
    }
    if (path === '/habits') {
      return habits === null
        ? new Response(JSON.stringify({ error: '习惯没接上' }), { status: 404 })
        : new Response(JSON.stringify(habits), { status: 200 })
    }
    if (path === '/butler/rules') {
      return options.rules == null
        ? new Response(JSON.stringify({ error: '规矩表未启用' }), { status: 404 })
        : new Response(JSON.stringify(options.rules), { status: 200 })
    }
    if (path === '/evolve/log') {
      return options.log == null
        ? new Response(JSON.stringify({ error: '还没有进化日志' }), { status: 404 })
        : new Response(JSON.stringify({ text: options.log }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, posts }
}

describe('它学到了什么 · 纯函数', () => {
  it('种类名用接口给的,缺了有兜底', () => {
    expect(habitKindTitle(STYLE)).toBe('说话风格')
    expect(habitKindTitle(NO_TITLE)).toBe(HABIT_KIND_FALLBACK)
  })

  it('什么时候开始试用 / 用上几次 / 留下撤掉的理由', () => {
    expect(habitSinceLine(DISPATCH)).toMatch(/10-08 \d\d:\d\d 开始试用/u)
    expect(habitSinceLine(DISPATCH)).toContain('用上 1 次')
    expect(habitSinceLine(QUIET_GONE)).toContain('12 点她接了一通')
  })

  it('进化日志摘要:一段一行,带上最新那一句结论,不露 id', () => {
    const digest = evolveLogDigest(LOG, 5)
    expect(digest).toHaveLength(1)
    expect(digest[0]?.title).toBe('2026-10-07 试用习惯(默认分派):写代码的活 · Lapis 这类事默认派给 Codex')
    expect(digest[0]?.latest).toContain('留下')
    expect(JSON.stringify(digest)).not.toContain('id')
  })
})

describe('它学到了什么 · 页面', () => {
  it('① 没接习惯 → 整节不出现', async () => {
    const { fetchImpl } = fakeServer({ habits: null })
    const { container } = render(<HabitsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(container.querySelector('section')).toBeNull()
  })

  it('② 一条都没有 → 说人话;口径入口照旧在', async () => {
    const { fetchImpl } = fakeServer({ habits: { trial: [], kept: [], retired: [] } })
    render(<HabitsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(await screen.findByText(HABITS_EMPTY_NOTE)).toBeInTheDocument()
    expect(screen.getByText('0 条试用 · 0 条留下')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '依据与判据' })).toBeInTheDocument()
    expect(screen.queryByText(/已撤下/u)).toBeNull()
  })

  it('③ 任何一种都按同一个形状显示:种类、人话、依据、原话、开始试用;不露 id', async () => {
    const { fetchImpl } = fakeServer({ habits: { trial: [DISPATCH, NO_TITLE], kept: [STYLE], retired: [QUIET_GONE] } })
    const user = userEvent.setup()
    const { container } = render(<HabitsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(await screen.findByText('写代码的活 · Lapis 这类事默认派给 Codex')).toBeInTheDocument()
    expect(screen.getByText('汇报先说结论,三句以内')).toBeInTheDocument()
    expect(screen.getByText('某个新学到的')).toBeInTheDocument()
    // 每条三格各自数:计数 = 依据条数,试用 = 用上几次,验证 = 验过留下记 1
    const dispatch = screen.getByText('写代码的活 · Lapis 这类事默认派给 Codex').closest('.ben-wb__slearn') as HTMLElement
    expect(within(dispatch).getByRole('group', { name: '计数 2' })).toBeInTheDocument()
    expect(within(dispatch).getByRole('group', { name: '试用 1' })).toBeInTheDocument()
    expect(within(dispatch).getByRole('group', { name: '验证 0' })).toBeInTheDocument()
    const style = screen.getByText('汇报先说结论,三句以内').closest('.ben-wb__slearn') as HTMLElement
    expect(within(style).getByRole('group', { name: '验证 1' })).toBeInTheDocument()
    // 种类、依据、原话、开始试用收在每条下面的「依据 N 条」里;撤掉的在「已撤下 N 条」里
    for (const fold of ['依据 2 条', '依据 0 条', '依据 1 条', '已撤下 1 条']) await user.click(screen.getByText(fold))
    expect(screen.getByText(/^说话风格 · /u)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`^${HABIT_KIND_FALLBACK} · `, 'u'))).toBeInTheDocument()
    expect(screen.getByText('12 点这个钟点不打电话,改成消息')).toBeInTheDocument()
    expect(screen.getByText(/10-07 11:00 推荐 Claude,她改派 Codex/u)).toBeInTheDocument()
    expect(screen.getByText(/「你说重点就行」/u)).toBeInTheDocument()
    expect(container.textContent).toMatch(/开始试用/u)
    expect(container.textContent).not.toContain('分派:')
    expect(container.textContent).not.toContain('/habits')
  })

  it('④ 撤掉:先确认,再打 /habits/revoke;撤掉的写明不会再自己学回来', async () => {
    const { fetchImpl, posts } = fakeServer({ habits: { trial: [DISPATCH], kept: [STYLE], retired: [QUIET_GONE] } })
    const user = userEvent.setup()
    render(<HabitsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await screen.findByText('写代码的活 · Lapis 这类事默认派给 Codex')
    // 试用中与留下的各一颗;撤掉的没有(它们在「已撤下」里只有「恢复」)
    expect(screen.getAllByRole('button', { name: '撤回' })).toHaveLength(2)
    await user.click(screen.getByText('已撤下 1 条'))
    expect(screen.getByText(/不会再自己学回来/u)).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: '撤回' })[0]!)
    expect(posts).toHaveLength(0)
    // 10-22 起是共用的确认弹层「撤回这个做法?」(CONFIRMS.withdrawHabit)
    const ask = screen.getByRole('dialog', { name: CONFIRMS.withdrawHabit.title })
    expect(ask).toHaveTextContent('不会再自己学回来')
    await user.click(within(ask).getByRole('button', { name: CONFIRMS.withdrawHabit.confirm }))
    await waitFor(() => expect(posts).toEqual([{ path: '/habits/revoke', body: { id: DISPATCH.id } }]))
    expect(await screen.findByText('撤掉了,以后不再自己学回来。')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByRole('button', { name: '撤回' })).toHaveLength(1))
  })

  it('⑤ 明说的规矩与选题偏好:同一页看得到条数,指回「记住的规矩」', async () => {
    const { fetchImpl } = fakeServer({ habits: { trial: [], kept: [], retired: [] }, rules: RULES })
    const user = userEvent.setup()
    render(<HabitsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await user.click(await screen.findByRole('button', { name: '依据与判据' }))
    expect(await screen.findByText(/你明说的规矩 1 条/u)).toBeInTheDocument()
    expect(screen.getByText(/选题上学到的偏好 1 条/u)).toBeInTheDocument()
    expect(screen.getByText(/记住的规矩/u)).toBeInTheDocument()
  })

  it('⑥ 进化日志:有摘要;没有时如实说', async () => {
    const withLog = fakeServer({ habits: { trial: [], kept: [], retired: [] }, log: LOG })
    const user = userEvent.setup()
    const first = render(<HabitsPanel baseUrl="http://wb" fetchImpl={withLog.fetchImpl} />)
    await user.click(await screen.findByRole('button', { name: '依据与判据' }))
    await user.click(await screen.findByRole('button', { name: /进化日志/u }))
    expect(await screen.findByText(/写代码的活 · Lapis 这类事默认派给 Codex$/u)).toBeInTheDocument()
    expect(first.container.textContent).not.toContain('提议 id')
    first.unmount()

    const noLog = fakeServer({ habits: { trial: [], kept: [], retired: [] } })
    render(<HabitsPanel baseUrl="http://wb" fetchImpl={noLog.fetchImpl} />)
    await user.click(await screen.findByRole('button', { name: '依据与判据' }))
    await user.click(await screen.findByRole('button', { name: /进化日志/u }))
    expect(await screen.findByText(/还没有进化日志/u)).toBeInTheDocument()
  })
})
