/**
 * 设置里「记住的规矩」那一节(2026-09-24 晚,卡 K)。
 *
 * 钉五件:
 *   ① 没接规矩表(404)→ 整节不出现;
 *   ② 一条一行:规矩原文 + 哪来的、哪天、试用到哪了;**不露 id、英文键名**(他的规矩 ③);
 *   ③ 删 = `POST /butler/rules/remove`,改字 = `POST /butler/rules/update`,写一条 = `POST /butler/rules`(channel=settings);
 *   ④ 一条都没有时给「从记忆里的『观察』学风格」那一颗键(2026-10-10 改字:观察不再直接导成规矩,送去认风格候选);
 *   ⑤ 删了的在「不再照做的」里,点「恢复」回来。
 * 2026-10-22(新 UI 第二轮 · 设置六组,照评审页):删是那一行右边的 ✕(「撤下规矩」),来路那一行改成
 * 「哪来的 · MM-DD HH:mm · 管哪一块」,删了的收在「已撤下 N 条 · 展开 ›」里。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { RulesPanel, ruleMetaLine } from '../src/client/RulesPanel.tsx'
import type { ButlerRuleView, ButlerRulesView } from '../src/protocol.ts'

configure({ asyncUtilTimeout: 5_000 })
afterEach(() => { cleanup() })

const BLUE: ButlerRuleView = {
  id: 'rule:不要蓝', text: '不要蓝(球的「完成」色也不要)', title: '不要蓝', area: 'ui', status: 'active', origin: 'said',
  evidence: [{ channel: 'call', at: '2026-09-24T12:00:00.000Z', text: '不要蓝' }],
  created_at: '2026-09-24T12:00:00.000Z', updated_at: '2026-09-24T12:00:00.000Z', editable: true,
}
const TRIAL: ButlerRuleView = {
  ...BLUE, id: 'rule:按钮颜色太跳', text: '按钮颜色太跳,换灰色', title: '按钮颜色太跳', status: 'trial', origin: 'repeated', evidence: [],
}
const REMOVED: ButlerRuleView = { ...BLUE, id: 'rule:只做深色', text: '只做深色', title: '只做深色', status: 'removed' }

/** 本机时间 `MM-DD HH:mm`(来路那一行的写法;用例按跑的那台机器的时区算)。 */
function stamp(iso: string): string {
  const at = new Date(iso)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`
}

/** 一台假服务:记下每一次 POST,GET 回当前那份表。 */
function fakeServer(initial: ButlerRulesView | null) {
  let view = initial
  const posts: { path: string, body: Record<string, unknown> }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace('http://wb', '')
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ path, body })
      if (path === '/butler/rules/remove' && view !== null) {
        const gone = view.rules.find(one => one.id === body.id)
        view = { rules: view.rules.filter(one => one.id !== body.id), retired: gone === undefined ? view.retired : [{ ...gone, status: 'removed' }, ...view.retired] }
      }
      return new Response(JSON.stringify({ ok: true, note: '好了。' }), { status: 200 })
    }
    if (view === null) return new Response(JSON.stringify({ error: '规矩表未启用' }), { status: 404 })
    return new Response(JSON.stringify(view), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, posts }
}

describe('记住的规矩', () => {
  it('① 没接规矩表 → 整节不出现', async () => {
    const { fetchImpl } = fakeServer(null)
    const { container } = render(<RulesPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(container.querySelector('.ben-wb__rules')).toBeNull()
  })

  it('② 一条一行,带来路与试用状态;不露 id', async () => {
    const { fetchImpl } = fakeServer({ rules: [BLUE, TRIAL], retired: [] })
    const { container } = render(<RulesPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(await screen.findByText('不要蓝(球的「完成」色也不要)')).toBeInTheDocument()
    expect(screen.getByText(`电话里说的 · ${stamp(BLUE.created_at)} · 界面`)).toBeInTheDocument()
    expect(screen.getByText(/试用中/u)).toBeInTheDocument()
    expect(container.textContent).not.toContain('rule:')
  })

  it('③ 删、改字、写一条新的:打对的路', async () => {
    const { fetchImpl, posts } = fakeServer({ rules: [BLUE], retired: [] })
    const user = userEvent.setup()
    render(<RulesPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await screen.findByText('不要蓝(球的「完成」色也不要)')

    await user.click(screen.getByRole('button', { name: '改' }))
    const box = screen.getByLabelText('改这条规矩')
    await user.clear(box)
    await user.type(box, '不要蓝')
    await user.click(screen.getByRole('button', { name: '存' }))
    await waitFor(() => expect(posts.some(one => one.path === '/butler/rules/update' && one.body.text === '不要蓝')).toBe(true))

    await user.type(screen.getByLabelText('写一条新规矩'), '以后派活先截图给我看')
    await user.click(screen.getByRole('button', { name: '记下' }))
    await waitFor(() => expect(posts).toContainEqual({ path: '/butler/rules', body: { text: '以后派活先截图给我看', channel: 'settings' } }))

    await user.click(screen.getByRole('button', { name: '撤下规矩' }))
    await waitFor(() => expect(posts).toContainEqual({ path: '/butler/rules/remove', body: { id: 'rule:不要蓝' } }))
  })

  it('④ 一条都没有:给「从记忆里的『观察』学风格」', async () => {
    const { fetchImpl, posts } = fakeServer({ rules: [], retired: [] })
    const user = userEvent.setup()
    render(<RulesPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await user.click(await screen.findByRole('button', { name: '从记忆里的「观察」学风格' }))
    await waitFor(() => expect(posts).toContainEqual({ path: '/butler/rules/import', body: { from: 'observations' } }))
  })

  it('⑤ 删了的在「已撤下 N 条」里(原「不再照做的」),能恢复', async () => {
    const { fetchImpl, posts } = fakeServer({ rules: [BLUE], retired: [REMOVED] })
    const user = userEvent.setup()
    render(<RulesPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await user.click(await screen.findByText('已撤下 1 条'))
    await user.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(posts).toContainEqual({ path: '/butler/rules/restore', body: { id: 'rule:只做深色' } }))
  })

  it('⑥ 上移 / 下移:打 /butler/rules/move(同块的两条都亮)', async () => {
    const { fetchImpl, posts } = fakeServer({ rules: [BLUE, { ...BLUE, id: 'rule:只做深色', text: '只做深色', title: '只做深色' }], retired: [] })
    const user = userEvent.setup()
    render(<RulesPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await screen.findByText('只做深色')
    const downs = screen.getAllByRole('button', { name: '下移规矩' })
    const ups = screen.getAllByRole('button', { name: '上移规矩' })
    expect(ups).toHaveLength(2)
    expect(downs).toHaveLength(2)
    // 同块(界面)里挨着:第一条下移亮、上移灰;第二条上移亮、下移灰。
    expect(ups[0]).toBeDisabled()
    expect(downs[0]).toBeEnabled()
    expect(ups[1]).toBeEnabled()
    expect(downs[1]).toBeDisabled()
    await user.click(downs[0] as HTMLElement)
    await waitFor(() => expect(posts).toContainEqual({ path: '/butler/rules/move', body: { id: 'rule:不要蓝', dir: 'down' } }))
    await user.click(ups[1] as HTMLElement)
    await waitFor(() => expect(posts).toContainEqual({ path: '/butler/rules/move', body: { id: 'rule:只做深色', dir: 'up' } }))
  })

  it('⑥′ 跨块的那一颗置灰:界面在上、说话在下,两颗都挨不着', async () => {
    const SAY: ButlerRuleView = {
      ...BLUE, id: 'rule:电话每轮不超过两句', text: '电话每轮不超过两句', title: '电话每轮不超过两句', area: 'say',
    }
    const { fetchImpl } = fakeServer({ rules: [BLUE, SAY], retired: [] })
    render(<RulesPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await screen.findByText('不要蓝(球的「完成」色也不要)')
    for (const name of ['上移规矩', '下移规矩']) {
      for (const btn of screen.getAllByRole('button', { name })) expect(btn).toBeDisabled()
    }
  })

  it('来路那一行:明说 / 重复学到 / 选题卡', () => {
    expect(ruleMetaLine(BLUE)).toBe(`电话里说的 · ${stamp(BLUE.created_at)} · 界面`)
    expect(ruleMetaLine(TRIAL)).toContain('你在不止一件活上打回过同一处')
    expect(ruleMetaLine({ ...BLUE, origin: 'topic', evidence: [] })).toContain('选题卡上学到的')
  })
})
