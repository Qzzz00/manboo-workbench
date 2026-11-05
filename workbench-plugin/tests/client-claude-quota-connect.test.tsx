/**
 * Claude 那一格的「一键接上」,界面这一头(2026-10-03,卡「不让用户知道什么叫 setup-token」)。
 *
 * 维护者 15:0x:「你得考虑产品化啊,你不说我咋知道要咋弄啊。」所以这一组钉的是**她看得见什么**:
 * - 没接上 → 一颗「接上」+ 一句人话(不出现终端、不出现那条命令的名字);
 * - 接上了 → 「实时 · 密钥到 X」+「换一把」;
 * - 接的过程里 → 那几句进度 + 一颗「取消」;
 * - 额度那一格「没接上」时也要有一颗能按的键(`AgentQuotaCells`)。
 * 2026-10-22 起设置里照评审页:没接上的那几家收在「暂不可用 N 家」里,粘密钥的框收在那一家的「管理 / 去填」里。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_CONNECT_BUTTON, CLAUDE_CONNECT_INVITE, CLAUDE_LIVE_LINE, CLAUDE_RECONNECT_BUTTON, CredentialPanel,
} from '../src/client/CredentialPanel.tsx'
import { AgentQuotaCells } from '../src/client/AgentQuotaCells.tsx'
import { CLAUDE_LIVE_FIX } from '../src/quota/liveSources.ts'
import type { AgentQuotaView } from '../src/protocol.ts'

afterEach(cleanup)

/** 没接上的那几家收在「暂不可用 N 家 · 展开 ›」里:先摊开。 */
async function openUnavailable(): Promise<void> {
  await userEvent.click(await screen.findByText(/^暂不可用 \d+ 家$/))
}
/** 那一家那一块(`data-cred`)。 */
const cred = (id: string): HTMLElement => document.querySelector(`[data-cred=${id}]`) as HTMLElement
/** 摊开那一家填密钥的框(「管理」或「去填」)。 */
async function openKey(id: string): Promise<void> {
  await userEvent.click(within(cred(id)).getByRole('button', { name: /^(管理|去填)$/ }))
}

const BASE = 'http://127.0.0.1:8791'
const FAKE_TOKEN = 'sk-ant-oat01-0000000000000000000000000000-fake-for-tests'

/**
 * 一份假服务。`connect` 缺席 = 这台服务没接那条路(路由 404),界面据此整颗键不画。
 */
function stub(options: {
  configured?: boolean
  connect?: { state: string, message: string, expires_at?: string }
  /** 按下那一颗之后服务端回什么(缺省 = 与上面那份相同:用例只看一个定格的时候用得上)。 */
  afterPress?: { state: string, message: string, expires_at?: string }
} = {}) {
  const state = { deepseek: false, kimi_web: false, claude_api: options.configured === true }
  const calls: { url: string, method: string }[] = []
  let pressed = false
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.endsWith('/quota/connect/claude') || url.endsWith('/quota/connect/claude/cancel')) {
      if (options.connect === undefined) {
        return { ok: false, status: 404, json: async () => ({ error: '这台工作台没接「一键接上」' }) }
      }
      if (init?.method === 'POST') pressed = true
      const now = pressed ? (options.afterPress ?? options.connect) : options.connect
      return { ok: true, status: 200, json: async () => now }
    }
    if (url.endsWith('/login')) return { ok: true, status: 200, json: async () => ({ state: 'idle' }) }
    return {
      ok: true,
      status: 200,
      json: async () => Object.fromEntries(Object.entries(state).map(([k, v]) => [k, { configured: v }])),
    }
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('设置里 Claude 那一行', () => {
  it('★ 没接上:一颗「接上」+ 那句人话 —— 界面上不出现终端、也不出现那条命令的名字', async () => {
    const { impl } = stub({ connect: { state: 'idle', message: '' } })
    render(<CredentialPanel baseUrl={BASE} fetchImpl={impl} />)
    await openUnavailable()

    expect(await screen.findByRole('button', { name: CLAUDE_CONNECT_BUTTON })).toBeInTheDocument()
    expect(within(cred('claude_api')).getByText(text => text.includes(CLAUDE_CONNECT_INVITE))).toBeInTheDocument()
    for (const jargon of ['setup-token', '终端', 'Terminal', '命令行里']) {
      expect(document.body.textContent).not.toContain(jargon)
    }
  })

  it('★ 点一下打 POST /quota/connect/claude,并显示「正在打开浏览器…」+ 一颗取消', async () => {
    const { impl, calls } = stub({
      connect: { state: 'idle', message: '' },
      afterPress: { state: 'opening', message: '正在打开浏览器…' },
    })
    render(<CredentialPanel baseUrl={BASE} fetchImpl={impl} />)
    await openUnavailable()

    await userEvent.click(await screen.findByRole('button', { name: CLAUDE_CONNECT_BUTTON }))

    await waitFor(() => expect(screen.getByText(/正在打开浏览器/)).toBeInTheDocument())
    expect(calls.some(one => one.url === `${BASE}/quota/connect/claude` && one.method === 'POST')).toBe(true)
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
  })

  it('★ 已经接上:写「实时 · 密钥到 X」,键变「换一把」', async () => {
    const { impl } = stub({
      configured: true,
      connect: { state: 'done', message: '接上了 · 本周还剩 81%', expires_at: '2027-01-02' },
    })
    render(<CredentialPanel baseUrl={BASE} fetchImpl={impl} />)

    expect(await screen.findByText(`${CLAUDE_LIVE_LINE} · 密钥到 2027-01-02`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: CLAUDE_RECONNECT_BUTTON })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: CLAUDE_CONNECT_BUTTON })).toBeNull()
    // 那一行的状态字也跟着说人话(不是「已配置」这种内部词)。
    expect(within(cred('claude_api')).getByText(/^实时/)).toBeInTheDocument()
    expect(cred('claude_api').textContent).not.toContain('已配置')
  })

  it('到期日读不到就只写「实时」—— 不编一个日子(D13)', async () => {
    const { impl } = stub({ configured: true, connect: { state: 'done', message: '接上了' } })
    render(<CredentialPanel baseUrl={BASE} fetchImpl={impl} />)
    await waitFor(() => expect(screen.getByRole('button', { name: CLAUDE_RECONNECT_BUTTON })).toBeInTheDocument())
    expect(document.body.textContent).not.toContain('密钥到')
  })

  it('没成的时候那句话原样上屏,键还能再按', async () => {
    const { impl } = stub({ connect: { state: 'failed', message: '没成:授权没走完,再试一次' } })
    render(<CredentialPanel baseUrl={BASE} fetchImpl={impl} />)
    await openUnavailable()
    expect(await screen.findByText('没成:授权没走完,再试一次')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: CLAUDE_CONNECT_BUTTON })).toBeEnabled()
  })

  it('★ 这台服务没接这条路:整颗键不画,只剩粘一串密钥那条退路(不摆点了没用的按钮)', async () => {
    const { impl } = stub({})
    render(<CredentialPanel baseUrl={BASE} fetchImpl={impl} />)
    await openUnavailable()
    await openKey('claude_api')
    await waitFor(() => expect(screen.getByLabelText('Claude 的密钥')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: CLAUDE_CONNECT_BUTTON })).toBeNull()
  })

  it('★ 整个过程里界面一个字节的密钥都没有(回包里也不该有,这里再钉一次界面)', async () => {
    const { impl } = stub({
      configured: true,
      connect: { state: 'done', message: '接上了 · 本周还剩 81%', expires_at: '2027-01-02' },
    })
    render(<CredentialPanel baseUrl={BASE} fetchImpl={impl} />)
    await waitFor(() => expect(screen.getByRole('button', { name: CLAUDE_RECONNECT_BUTTON })).toBeInTheDocument())
    await openKey('claude_api')
    expect(document.body.textContent).not.toContain(FAKE_TOKEN)
    expect(document.body.textContent).not.toContain('sk-ant-')
    // 粘密钥那个框是 password,而且不回显(老纪律,这里顺手再钉一次)。
    expect(screen.getByLabelText('Claude 的密钥').getAttribute('type')).toBe('password')
    expect((screen.getByLabelText('Claude 的密钥') as HTMLInputElement).value).toBe('')
  })

  it('DeepSeek 那一行给出「去哪拿」那条能点的链接(卡里第 4 条:没接上就得有能按的 / 能照做的)', async () => {
    const { impl } = stub({})
    render(<CredentialPanel baseUrl={BASE} fetchImpl={impl} />)
    await openUnavailable()
    await openKey('deepseek')
    const link = await screen.findByRole('link', { name: /去 DeepSeek 开放平台拿一串/ })
    expect(link.getAttribute('href')).toContain('platform.deepseek.com')
  })
})

describe('额度那一格「没接上」时也要有一颗能按的键', () => {
  const view = (extra: Partial<AgentQuotaView> = {}): AgentQuotaView => ({
    id: 'claude',
    title: 'Claude',
    state: 'unconnected',
    line: '没接上:还没授权过',
    why: '还没授权过',
    stale_hint: { live: { why: '点一下「接上」就实时', fix: CLAUDE_LIVE_FIX } },
    ...extra,
  })

  it('★ 没接上 + 声明过「有一条更实时的路」→ 画那颗入口键(以前只有「读不到最新」那一档才画)', () => {
    const onFix = vi.fn()
    render(<AgentQuotaCells quotas={[view()]} onFix={onFix} />)
    const button = screen.getByRole('button', { name: CLAUDE_LIVE_FIX.label })
    button.click()
    expect(onFix).toHaveBeenCalledWith(CLAUDE_LIVE_FIX.at)
  })

  it('没声明过的那几家照旧什么都不多(不凭空长出一颗按钮)', () => {
    // 这一份**压根没有** stale_hint(不是「有但是 undefined」)—— 缺席就是缺席。
    const noDecl: AgentQuotaView = {
      id: 'manus', title: 'Manus', state: 'unconnected', line: '没接上:Manus 没开着', why: 'Manus 没开着',
    }
    render(<AgentQuotaCells quotas={[noDecl]} onFix={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('读不到最新那一档照旧画(这一版没动它)', () => {
    render(<AgentQuotaCells quotas={[view({ state: 'numbers', stale: true, line: '读不到最新的,上次 04:27' })]} onFix={vi.fn()} />)
    expect(screen.getByRole('button', { name: CLAUDE_LIVE_FIX.label })).toBeInTheDocument()
  })
})
