/**
 * **电脑上那一格:说清为什么 + 一颗能点的键**(2026-10-02,卡 QK)。
 *
 * 卡 QA 之后这一格写的是大字「读不到最新的」+ 小字「上次 04:27」—— 她看完的下一个问题是
 * 「为什么」和「我能做什么」,而界面上一个字都没有。这一份钉三件事:
 *
 * 1. 那两句(为什么 / 配上什么就能实时)**摊在明面上**,不折进「▸ 说明」里;
 * 2. 那颗键点下去,带着服务端声明的去处(设置 →「各家的密钥与登录」→ Claude 那一行);
 * 3. **没有更实时来源的家一颗键都不画** —— 那一行照旧只说「上次 HH:MM」。
 *
 * 外加一条硬的:**那一行上不出现任何密钥**(AGENTS.md)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentQuotaView, ClientsView, QuotaEntry, QuotaStaleHint } from '../src/protocol.ts'
import { QUOTA_STALE_VALUE } from '../src/protocol.ts'
import { CLAUDE_LIVE_FIX, CLAUDE_LIVE_WHY, CLAUDE_STALE_WHY, quotaStaleHintFor } from '../src/quota/liveSources.ts'
import { QuotaPanel } from '../src/client/QuotaPanel.tsx'
import { AgentQuotaCells } from '../src/client/AgentQuotaCells.tsx'
import { SettingsDialog } from '../src/client/SettingsDialog.tsx'
import { GROUP } from './settingsGroup.ts'

afterEach(cleanup)

/** 现场那一刻:10-02 21:30。 */
const NOW = '2026-10-02T21:30:00+08:00'
/** 桌面端最后那个样本:04:27(17 小时前,过线)。 */
const AT_0427 = '2026-10-02T04:27:40+08:00'

const ON = { installed: true, connected: true }
const OFF = { installed: false, connected: false }
const CLIENTS: ClientsView = { claude: ON, codex: ON, kimi: ON, wechat: OFF, wecom: OFF }

/** Claude 那一家一定声明得出来(用例里顺手钉住 —— 不然下面几条断言等于没断)。 */
const HINT: QuotaStaleHint = quotaStaleHintFor('claude', () => false)!

/** 现场那一份(04:27 的样本算出来的两扇窗)+ 来源声明的那两句。 */
const SITE: QuotaEntry = {
  kind: 'quota',
  windows: [{ label: '5h', left_pct: 100 }, { label: '周', left_pct: 82 }],
  as_of: AT_0427,
  stale_hint: HINT,
}

describe('老四格那一格', () => {
  it('★大字「读不到最新的」,小字里为什么与出路都在,一个百分比都没有', () => {
    render(<QuotaPanel quota={{ claude: SITE }} now={NOW} clients={CLIENTS} agents={['claude']} />)
    const cell = screen.getByRole('listitem', { name: 'Claude' })
    expect(cell).toHaveTextContent(QUOTA_STALE_VALUE)
    expect(cell).toHaveTextContent('上次 04:27')
    expect(cell).toHaveTextContent(CLAUDE_STALE_WHY)
    expect(cell).toHaveTextContent(CLAUDE_LIVE_WHY)
    expect(cell).not.toHaveTextContent('%')
    expect(cell).not.toHaveTextContent('未接入')
    // 那几句摊在明面上(卡 QK):她不该为了看懂一格额度先点开一层「说明」。
    expect(cell.querySelector('details')).toBeNull()
    expect(cell.getAttribute('data-stale')).toBe('true')
  })

  it('★那颗键点下去 = 去设置里那一行(去处是服务端声明的,界面不判是哪一家)', async () => {
    const onUnlock = vi.fn()
    render(<QuotaPanel quota={{ claude: SITE }} now={NOW} clients={CLIENTS} agents={['claude']} onUnlock={onUnlock} />)
    const button = screen.getByRole('button', { name: CLAUDE_LIVE_FIX.label })
    button.click()
    expect(onUnlock).toHaveBeenCalledWith('settings', undefined, { group: 'agents', row: 'claude_api' })
  })

  it('★没有更实时来源的那一家:只说「上次 HH:MM」,一颗键都不画', () => {
    const { stale_hint: _none, ...bare } = SITE
    render(<QuotaPanel quota={{ codex: bare }} now={NOW} clients={CLIENTS} agents={['codex']} onUnlock={vi.fn()} />)
    const cell = screen.getByRole('listitem', { name: 'Codex' })
    expect(cell).toHaveTextContent('上次 04:27')
    expect(cell).not.toHaveTextContent(CLAUDE_LIVE_WHY)
    expect(cell.querySelector('button')).toBeNull()
  })

  it('★线以内那一格照画条、不画键(数还新的时候「配一把就能实时」是噪音)', () => {
    const fresh: QuotaEntry = { ...SITE, as_of: '2026-10-02T21:00:00+08:00' }
    render(<QuotaPanel quota={{ claude: fresh }} now={NOW} clients={CLIENTS} agents={['claude']} onUnlock={vi.fn()} />)
    const cell = screen.getByRole('listitem', { name: 'Claude' })
    expect(cell).toHaveTextContent('82%')
    expect(cell).not.toHaveTextContent(CLAUDE_LIVE_WHY)
    expect(cell.querySelector('button')).toBeNull()
  })

  it('`onUnlock` 没给(只传 quota 的那一批用例、纯展示)时不画键,那两句话照说', () => {
    render(<QuotaPanel quota={{ claude: SITE }} now={NOW} clients={CLIENTS} agents={['claude']} />)
    const cell = screen.getByRole('listitem', { name: 'Claude' })
    expect(cell).toHaveTextContent(CLAUDE_LIVE_WHY)
    expect(cell.querySelector('button')).toBeNull()
  })

  it('★那一格上不出现任何密钥(这条路上一个值都不经手)', () => {
    render(<QuotaPanel quota={{ claude: SITE }} now={NOW} clients={CLIENTS} agents={['claude']} onUnlock={vi.fn()} />)
    const text = screen.getByRole('listitem', { name: 'Claude' }).textContent ?? ''
    expect(text).not.toMatch(/sk-/)
    // 卡 SG:界面上不说这类词。
    expect(text).not.toContain('setup-token')
    expect(text).not.toContain('API Key')
  })
})

describe('其余几家那一行(/state.agent_quota)', () => {
  /** 机制每家都适用:哪天别的一家声明了更实时的来源,这一行也该有那颗键。 */
  const stale: AgentQuotaView = {
    id: 'claude',
    title: 'Claude',
    state: 'numbers',
    line: `${QUOTA_STALE_VALUE},上次 04:27 · ${CLAUDE_STALE_WHY} · ${CLAUDE_LIVE_WHY}`,
    read_at: AT_0427,
    stale: true,
    stale_hint: HINT,
  }

  it('★旧了的那一行给那颗键,去处是声明里那一份', () => {
    const onFix = vi.fn()
    render(<AgentQuotaCells quotas={[stale]} onFix={onFix} />)
    screen.getByRole('button', { name: CLAUDE_LIVE_FIX.label }).click()
    expect(onFix).toHaveBeenCalledWith({ group: 'agents', row: 'claude_api' })
  })

  it('★没声明的那一行(今天从窗口上读的那几家全是这一档)一颗键都不多', () => {
    const { stale_hint: _none, ...bare } = stale
    render(<AgentQuotaCells quotas={[{ ...bare, id: 'manus', title: 'Manus' }]} onFix={vi.fn()} />)
    expect(screen.getByRole('listitem', { name: 'Manus' }).querySelector('button')).toBeNull()
  })

  it('还不旧的那一行不画键', () => {
    const { stale: _old, ...fresh } = stale
    render(<AgentQuotaCells quotas={[{ ...fresh, line: '本周还剩约 82%', left_pct: 82 }]} onFix={vi.fn()} />)
    expect(screen.getByRole('listitem', { name: 'Claude' }).querySelector('button')).toBeNull()
  })
})

describe('那颗键落到哪:设置 →「各家的密钥与登录」→ Claude 那一行', () => {
  /** 这一屏的每条路都回一份形状对的空包 —— 这一份只看「开在哪一组、点亮哪一行」。 */
  const thinFetch = (): typeof fetch => vi.fn(async (input: unknown) => {
    const url = String(input)
    const body = url.includes('/credentials')
      ? { deepseek: { configured: false }, kimi_web: { configured: false }, claude_api: { configured: false } }
      : {}
    return { ok: true, status: 200, json: async () => body } as Response
  }) as unknown as typeof fetch

  it('★`openAt` 把这一屏直接开在「各家 AI 与账号」那一组(她不必在六组里找)', () => {
    render(
      <SettingsDialog
        baseUrl="http://127.0.0.1:8791"
        fetchImpl={thinFetch()}
        onClose={vi.fn()}
        openAt={CLAUDE_LIVE_FIX.at}
      />,
    )
    expect(screen.getByRole('tab', { name: GROUP.agents }).getAttribute('aria-selected')).toBe('true')
  })

  it('★被点名那一行自己站出来(data-focus),别的行不动', async () => {
    render(
      <SettingsDialog
        baseUrl="http://127.0.0.1:8791"
        fetchImpl={thinFetch()}
        onClose={vi.fn()}
        openAt={CLAUDE_LIVE_FIX.at}
      />,
    )
    // 被点名那一家的「管理 / 去填」先摊开(没接上的那几家收在「暂不可用」里,也一起摊开)
    const row = await screen.findByLabelText('Claude 的密钥')
    const holder = row.closest('[data-cred]')
    expect(holder?.getAttribute('data-focus')).toBe('true')
    // 点亮一行 ≠ 替她填一个字:那个框仍然是空的(密钥**永不回显**)。
    expect(row).toHaveValue('')
    const other = screen.getByText('DeepSeek').closest('[data-cred]')
    expect(other?.getAttribute('data-focus')).toBeNull()
  })

  it('没给 `openAt`(顶栏那颗齿轮)时:开在默认那一组,一行都不点亮 —— 老行为一字不差', async () => {
    render(<SettingsDialog baseUrl="http://127.0.0.1:8791" fetchImpl={thinFetch()} onClose={vi.fn()} />)
    expect(screen.getByRole('tab', { name: GROUP.butler }).getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[data-focus="true"]')).toBeNull()
  })
})
