import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import { SessionFeed } from '../src/client/SessionFeed.tsx'
import { groupByAgent } from '../src/client/sessionFeed.ts'

afterEach(cleanup)

function session(over: Partial<SessionView>): SessionView {
  return {
    agent: 'codex',
    session_id: '019a0000-0000-7000-8000-000000123456',
    project: 'KOUKOU',
    status: 'running',
    elapsed_sec: 12,
    unread: false,
    updated_at: '2026-08-24T10:03:00.000Z',
    ...over,
  }
}

/** 用例里的登记表(产品代码里没有名字表,名字来自 /state.agent_registry)。 */
const NAMES: Record<string, string> = { dsh: 'DSH', claude: 'Claude', codex: 'Codex', kimi: 'Kimi' }

function entriesOf(sessions: SessionView[]) {
  const ids = [...new Set(['dsh', 'claude', 'codex', 'kimi', ...sessions.map(one => one.agent)])]
  return ids.map(id => ({ id, name: NAMES[id] ?? id, sessions: sessions.filter(one => one.agent === id).map(one => ({ ...one, via: 'sessions' as const })) }))
}

function renderSessions(sessions: SessionView[]): void {
  render(
    <SessionFeed
      groups={groupByAgent(entriesOf(sessions))}
      offline={false}
      onRead={vi.fn()}
      onActivate={vi.fn()}
      badges={{}}
    />,
  )
}

describe('SessionFeed visible Codex identity', () => {
  it('keeps UUIDs with a shared time prefix distinguishable by their random tail', () => {
    renderSessions([
      session({ session_id: '01a00000-0000-7000-8000-000000123456' }),
      session({ session_id: '01a00000-0000-7000-8000-000000abcdef' }),
    ])

    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(within(codex).getByText(/会话 #123456/)).toBeInTheDocument()
    expect(within(codex).getByText(/会话 #abcdef/)).toBeInTheDocument()
  })

  it('shows an interrupted Codex turn as 已中断', () => {
    renderSessions([session({ status: 'error', reason: 'interrupted' })])

    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(within(codex).getByText(/已中断/)).toBeInTheDocument()
    expect(within(codex).queryByText(/出错了/)).not.toBeInTheDocument()
  })
})

/**
 * DSH 会话行上的三个数字(2026-09-09)。取数与形状见
 * docs/superpowers/research/2026-09-09-DSH会话投影可读性.md;
 * 这里钉死的是「拿不到就不显示」——占位、0、「未知」都会被读成有意义的数值。
 */
describe('SessionFeed 会话行上的数字', () => {
  it('★三个数字齐全时按「上下文 · 缓存命中 · 改了几个文件」排在一行', () => {
    renderSessions([session({
      agent: 'dsh',
      session_id: 'dsh-1',
      metrics: { context_tokens: 8805, cache_hit_pct: 75, files_changed: 2 },
    })])

    const dsh = screen.getByRole('region', { name: 'DSH' })
    expect(within(dsh).getByText(/上下文 8\.8k/)).toBeInTheDocument()
    expect(within(dsh).getByText(/缓存命中 75%/)).toBeInTheDocument()
    expect(within(dsh).getByText(/改了 2 个文件/)).toBeInTheDocument()
  })

  it('★缺哪个不显示哪个(绝不用 0 或占位顶替)', () => {
    renderSessions([session({ agent: 'dsh', session_id: 'dsh-2', metrics: { cache_hit_pct: 97 } })])

    const dsh = screen.getByRole('region', { name: 'DSH' })
    expect(within(dsh).getByText(/缓存命中 97%/)).toBeInTheDocument()
    expect(within(dsh).queryByText(/上下文/)).not.toBeInTheDocument()
    expect(within(dsh).queryByText(/个文件/)).not.toBeInTheDocument()
  })

  it('一个数字都没有的会话行,整段不渲染', () => {
    renderSessions([session({ agent: 'dsh', session_id: 'dsh-3' })])
    const dsh = screen.getByRole('region', { name: 'DSH' })
    expect(within(dsh).queryByText(/上下文|缓存命中|个文件/)).not.toBeInTheDocument()
  })

  it('上万 token 取整到 k,不摆一串小数', () => {
    renderSessions([session({ agent: 'dsh', session_id: 'dsh-4', metrics: { context_tokens: 125_400 } })])
    expect(within(screen.getByRole('region', { name: 'DSH' })).getByText(/上下文 125k/)).toBeInTheDocument()
  })
})

/**
 * 等待原因分类(2026-09-09 傍晚拍板第 4 条):会话行上直接把原因说出来,
 * 鼠标停在行上也是同一句。没判出原因的行**一个字都不多**——不写「原因未知」。
 */
describe('SessionFeed 等待原因', () => {
  it('等审批 / 等你输入 / 额度不足 三种等待各说各的话,并挂在行的 title 上', () => {
    renderSessions([
      session({ agent: 'claude', session_id: 'a1', status: 'waiting', reason: 'permission_prompt', wait_reason: 'approval', elapsed_sec: 90 }),
      session({ agent: 'claude', session_id: 'a2', status: 'waiting', reason: 'idle_prompt', wait_reason: 'input', elapsed_sec: 30 }),
      session({ agent: 'claude', session_id: 'a3', status: 'waiting', wait_reason: 'quota', elapsed_sec: 5 }),
    ])
    const claude = screen.getByRole('region', { name: 'Claude' })
    expect(within(claude).getByText(/等审批 1 分 30 秒/)).toBeInTheDocument()
    expect(within(claude).getByText(/等你输入 30 秒/)).toBeInTheDocument()
    expect(within(claude).getByText(/额度不足 5 秒/)).toBeInTheDocument()
    expect(within(claude).getByTitle('等待原因:等审批')).toBeInTheDocument()
    expect(within(claude).getByTitle('等待原因:额度不足')).toBeInTheDocument()
  })

  it('出错的会话:额度不足盖过「出错了」;来源只说出错就还是「出错了」', () => {
    renderSessions([
      session({ agent: 'dsh', session_id: 'e1', status: 'error', reason: 'error', wait_reason: 'quota' }),
      session({ agent: 'dsh', session_id: 'e2', status: 'error', reason: 'error', wait_reason: 'error' }),
    ])
    const dsh = screen.getByRole('region', { name: 'DSH' })
    expect(within(dsh).getByText(/额度不足/)).toBeInTheDocument()
    expect(within(dsh).getByText(/出错了/)).toBeInTheDocument()
  })

  it('刚完成但额度见底:「已完成 · 额度不足」——这条停下来以后接不上了', () => {
    renderSessions([session({ agent: 'claude', session_id: 'd1', status: 'done', wait_reason: 'quota' })])
    expect(within(screen.getByRole('region', { name: 'Claude' })).getByText(/已完成 · 额度不足/)).toBeInTheDocument()
  })

  it('★没判出原因的等待行照旧是「等你 / 等你下一句」,没有 title,不写「未知」', () => {
    renderSessions([
      session({ agent: 'kimi', session_id: 'k1', status: 'waiting', elapsed_sec: 10 }),
      session({ agent: 'claude', session_id: 'c1', status: 'waiting', reason: 'idle_prompt', elapsed_sec: 10 }),
    ])
    expect(within(screen.getByRole('region', { name: 'Kimi' })).getByText(/等你 10 秒/)).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Claude' })).getByText(/等你下一句 10 秒/)).toBeInTheDocument()
    expect(screen.queryByTitle(/等待原因/)).not.toBeInTheDocument()
    expect(screen.queryByText(/未知/)).not.toBeInTheDocument()
  })
})
