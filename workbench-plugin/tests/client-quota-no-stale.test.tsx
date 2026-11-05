/**
 * 凭据清空之后额度面板长什么样(2026-09-18,Ben 真机:「清空凭据后 DeepSeek 仍显示 ¥2.26」)。
 *
 * 这一份只管**屏幕上有没有那个数字**,取数那一半在 tests/quota-no-stale.test.ts。
 * 三句话:
 * 1. 走中转时,屏幕上永远不该出现「¥ 账号余额」—— 那笔钱不是他此刻在花的账户;
 * 2. 没接上的那一家不给数字(解锁卡或「未接入」),绝不拿上一次采样顶上;
 * 3. Claude / Codex 的百分比来自本机客户端的记录 —— **有就显示**,没接上才收起来。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientsView, QuotaEntry } from '../src/protocol.ts'
import { QuotaPanel } from '../src/client/QuotaPanel.tsx'
import { quotaAreas } from '../src/client/areaUnlock.ts'
import { quotaCells } from '../src/client/quotaCells.ts'

afterEach(cleanup)
beforeEach(() => { try { window.localStorage?.clear() } catch { /* 无痕环境 */ } })

const NOW = '2026-09-18T10:30:00+08:00'
const BALANCE: QuotaEntry = { kind: 'balance', currency: 'CNY', total: '2.26', available: true, today_spent: '2.26' }
/** 服务端在走中转时给的那一条:今日用量剩 62%。 */
const RELAY: QuotaEntry = { kind: 'quota', windows: [{ label: '今日', left_pct: 62 }] }
const NO_KEY: QuotaEntry = { kind: 'unknown', note: '还没接 DeepSeek(去设置里填自己的 API Key,或用工作台提供的服务)', no_stale: true }
const WINDOWS: QuotaEntry = { kind: 'quota', windows: [{ label: '周', left_pct: 29 }] }

const OFF = { installed: false, connected: false }
const ON = { installed: true, connected: true }
function view(over: Partial<ClientsView> = {}): ClientsView {
  return { claude: OFF, codex: OFF, kimi: OFF, wechat: OFF, wecom: OFF, ...over }
}

describe('DeepSeek:凭据没配就不给数字', () => {
  /**
   * 2026-09-21:这一格从「一行字」换成了解锁卡(那张卡留给 Ben 的第 ② 条,他拍了「要」)。
   * 这条用例守的那句话一个字没变 —— **屏幕上一个钱数都没有**;变的只是那句话长什么样。
   */
  it('★unknown「还没接 DeepSeek」→ 一张解锁卡,屏幕上一个钱数都没有', () => {
    render(<QuotaPanel quota={{ dsh: NO_KEY }} now={NOW} />)
    // 另外三家本来就没传,照旧是「未接入」。
    expect(screen.getAllByText('未接入').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('DeepSeek 还没接上')).toBeTruthy()
    expect(screen.queryByText(/¥/)).toBeNull()
  })

  it('★走中转:报中转的今日用量,官方余额那一笔永远不出现', () => {
    render(<QuotaPanel quota={{ dsh: RELAY }} now={NOW} modelMode="relay" />)
    expect(screen.getByText('工作台提供的服务 · 今日用量')).toBeTruthy()
    expect(screen.getByText('62%')).toBeTruthy()
    expect(screen.queryByText(/¥/)).toBeNull()
  })

  it('★走中转但服务端还给着一条余额(切换那一瞬)→ 也不许把那笔钱画出来', () => {
    render(<QuotaPanel quota={{ dsh: BALANCE }} now={NOW} modelMode="relay" />)
    expect(screen.queryByText('¥2.26')).toBeNull()
    expect(screen.getByText(/还没接上/)).toBeTruthy()
  })

  it('走中转、中转那边的计量取不到 → 把服务端那句原因照实说出来,不编数', () => {
    const entry: QuotaEntry = { kind: 'unknown', note: '工作台提供的服务 · 今日用量还没接上(中转没能给出用量(HTTP 404))' }
    render(<QuotaPanel quota={{ dsh: entry }} now={NOW} modelMode="relay" />)
    expect(screen.getByText(/HTTP 404/)).toBeTruthy()
    expect(screen.queryByText(/¥/)).toBeNull()
  })
})

describe('Claude / Codex:百分比来自本机客户端的记录', () => {
  it('★没接上(区域解锁那套 connected=false)→ 只有解锁卡,没有数字', () => {
    render(
      <QuotaPanel
        quota={{ claude: WINDOWS, codex: WINDOWS }}
        now={NOW}
        clients={view({
          claude: { installed: true, connected: false, how: '点一下就帮你接上' },
          codex: { installed: true, connected: false, how: '点一下就帮你接上' },
        })}
      />,
    )
    expect(screen.getByLabelText('Claude 还没接上')).toBeTruthy()
    expect(screen.getByLabelText('Codex 还没接上')).toBeTruthy()
    expect(screen.queryByText('29%')).toBeNull()
  })

  it('★接上了、而且真有数 → 照常显示(这一条刻意保留:把他机器上真有的数藏起来才是编)', () => {
    render(<QuotaPanel quota={{ claude: WINDOWS }} now={NOW} clients={view({ claude: ON })} />)
    expect(screen.getAllByText('29%').length).toBeGreaterThan(0)
  })

  it('纯函数那一层同样如此:没接上的那一家出 unlock,不出 cell', () => {
    const areas = quotaAreas(quotaCells({ claude: WINDOWS }, {}, new Date(NOW)), view({ claude: { installed: true, connected: false } }))
    expect(areas.map(a => a.kind)).toEqual(['quota', 'unlock'])
    // 第一格是 DeepSeek(它没有桌面客户端,永远在)。
    expect(areas[0]?.agent).toBe('dsh')
  })
})
