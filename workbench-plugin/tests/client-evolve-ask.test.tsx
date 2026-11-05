/**
 * 「这 3 次你都在说 X —— 要不要把它固化下来?」那张卡(2026-09-22,卡 ⑥ 进化循环)。
 *
 * 钉的是**那道门**:在她按下「做」之前一条请求都不发;三颗键各发各的路;
 * 「不要」与「以后再说」的差别写在卡上(一颗会让某件事永远消失的按钮,不说清楚就是陷阱);
 * 技能那条路**必须先起名字**才点得动「做」——那一下会在她的仓库里建文件。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { EvolveProposalView } from '../src/protocol.ts'
import { EvolveAsk } from '../src/client/EvolveAsk.tsx'

afterEach(cleanup)

const PROPOSAL: EvolveProposalView = {
  id: 'evolve:评论区问题整理成选题',
  ask: '这 3 次你都在说「评论区问题整理成选题」—— 要不要把它固化下来?',
  sample: '评论区问题整理成选题',
  times: 3,
  says: ['把评论区里的问题整理成选题', '把评论区的问题整理一下变成选题', '评论区问题整理成选题'],
  suggested_way: 'skill',
  plans: {
    skill: '做成一条技能:我起草一份 docs/技能/固化-<名>.md',
    tool: '做成一个小组件:走「开发一个小工具」那条老路',
    template: '做成模板里的固定一步:这一版还没做',
  },
  created_at: '2026-09-22T12:00:00.000Z',
}

function stub(reply: { ok?: boolean, error?: string, note?: string } = { ok: true }) {
  const calls: { path: string, body: Record<string, unknown> }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      path: new URL(String(input)).pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {},
    })
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('待确认的固化提议', () => {
  it('★卡上摆出问句与"我哪三次说过"——她要能看出我凭什么提这一条', () => {
    const net = stub()
    render(<EvolveAsk proposal={PROPOSAL} baseUrl="http://x" fetchImpl={net.impl} />)
    expect(screen.getByText(PROPOSAL.ask)).toBeTruthy()
    for (const say of PROPOSAL.says) expect(screen.getByText(say)).toBeTruthy()
    // 默认那条路的「它准备怎么做、会碰什么」就在卡上。
    expect(screen.getByText(PROPOSAL.plans.skill)).toBeTruthy()
    // 光渲染不发任何请求。
    expect(net.calls).toEqual([])
  })

  it('★三颗键:做 / 不要 / 以后再说;两者的差别写在卡上', () => {
    const net = stub()
    render(<EvolveAsk proposal={PROPOSAL} baseUrl="http://x" fetchImpl={net.impl} />)
    expect(screen.getByRole('button', { name: '做' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '不要' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '以后再说' })).toBeTruthy()
    expect(screen.getByText(/以后不再提这一条/)).toBeTruthy()
  })

  it('★技能那条路没起名字之前「做」点不动——那一下会在她的仓库里建文件', async () => {
    const net = stub()
    render(<EvolveAsk proposal={PROPOSAL} baseUrl="http://x" fetchImpl={net.impl} />)
    expect((screen.getByRole('button', { name: '做' }) as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(screen.getByLabelText('给这条技能起个名字'), '评论区选题')
    expect((screen.getByRole('button', { name: '做' }) as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: '做' }))
    expect(net.calls).toEqual([{ path: '/evolve/accept', body: { id: PROPOSAL.id, way: 'skill', name: '评论区选题' } }])
  })

  it('★换一条路,卡上那段「会碰什么」跟着换;小组件那条不用起名字', async () => {
    const net = stub()
    render(<EvolveAsk proposal={PROPOSAL} baseUrl="http://x" fetchImpl={net.impl} />)
    await userEvent.click(screen.getByRole('radio', { name: '一个小组件' }))
    expect(screen.getByText(PROPOSAL.plans.tool)).toBeTruthy()
    expect(screen.queryByLabelText('给这条技能起个名字')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '做' }))
    expect(net.calls).toEqual([{ path: '/evolve/accept', body: { id: PROPOSAL.id, way: 'tool' } }])
  })

  it('★「不要」与「以后再说」各发各的路', async () => {
    const net = stub()
    render(<EvolveAsk proposal={PROPOSAL} baseUrl="http://x" fetchImpl={net.impl} />)
    await userEvent.click(screen.getByRole('button', { name: '不要' }))
    await userEvent.click(screen.getByRole('button', { name: '以后再说' }))
    expect(net.calls.map(call => call.path)).toEqual(['/evolve/decline', '/evolve/later'])
    expect(net.calls.every(call => call.body.id === PROPOSAL.id)).toBe(true)
  })

  it('★服务端说没办成就如实摆出来,卡不本地乐观撤下去', async () => {
    const net = stub({ ok: false, error: '不知道仓库在哪' })
    render(<EvolveAsk proposal={PROPOSAL} baseUrl="http://x" fetchImpl={net.impl} />)
    await userEvent.type(screen.getByLabelText('给这条技能起个名字'), '评论区选题')
    await userEvent.click(screen.getByRole('button', { name: '做' }))
    expect(screen.getByRole('alert').textContent).toBe('不知道仓库在哪')
    expect(screen.getByText(PROPOSAL.ask)).toBeTruthy()
  })
})
