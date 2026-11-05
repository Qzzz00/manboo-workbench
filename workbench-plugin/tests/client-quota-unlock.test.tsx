/**
 * 每个区域单独解锁 —— 真渲染那一半(额度面板的三态 + 顶上那一小行)。
 *
 * Ben 是 PM、不写代码:这几条断言写的全是他在屏幕上能不能看到某句话,
 * 而不是组件内部长什么样。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientsView, QuotaEntry } from '../src/protocol.ts'
import { QuotaPanel } from '../src/client/QuotaPanel.tsx'

afterEach(cleanup)
// 这套 jsdom 里 window.localStorage 压根不存在(实测),清也无从清起——组件两处都包了 try/catch。
beforeEach(() => { try { window.localStorage?.clear() } catch { /* 无痕环境 */ } })

const NOW = '2026-09-17T10:30:00+08:00'
const BALANCE: QuotaEntry = { kind: 'balance', currency: 'CNY', total: '218.40', available: true, today_spent: '3.21' }
const WINDOWS: QuotaEntry = { kind: 'quota', windows: [{ label: '周', left_pct: 62 }] }
const QUOTA = { dsh: BALANCE, claude: WINDOWS, codex: WINDOWS, kimi: WINDOWS }

/** 没走中转、也没填 Key:服务端那面 `no_stale` 旗子就是这个结论(quota/collect.ts)。 */
const NOT_WIRED: QuotaEntry = {
  kind: 'unknown',
  note: '还没接 DeepSeek(去设置里填自己的 API Key,或用工作台提供的服务)',
  no_stale: true,
}

const OFF = { installed: false, connected: false }
const ON = { installed: true, connected: true }
function view(over: Partial<ClientsView> = {}): ClientsView {
  return { claude: OFF, codex: OFF, kimi: OFF, wechat: OFF, wecom: OFF, ...over }
}

describe('额度面板的三态(2026-09-17「每个区域单独解锁」)', () => {
  it('★没扫过(clients 缺席)→ 四家照旧全在,一个字都没变', () => {
    render(<QuotaPanel quota={QUOTA} now={NOW} />)
    for (const name of ['DeepSeek', 'Claude', 'Codex', 'Kimi']) {
      expect(screen.getByText(name)).toBeTruthy()
    }
    expect(screen.queryByText(/还没接上/)).toBeNull()
  })

  it('★没装的那家整块不出现:屏幕上连名字都找不到', () => {
    render(<QuotaPanel quota={QUOTA} now={NOW} clients={view({ claude: ON })} />)
    expect(screen.getByText('Claude')).toBeTruthy()
    expect(screen.queryByText('Kimi')).toBeNull()
    expect(screen.queryByText('Codex')).toBeNull()
    // 也不该冒出一句"未接入"来替它们占位。
    expect(screen.queryByText('未接入')).toBeNull()
  })

  it('装了没接上 → 一张解锁卡:名字 + 那句人话 + 一颗按钮', () => {
    render(
      <QuotaPanel
        quota={QUOTA} now={NOW}
        clients={view({ kimi: { installed: true, connected: false, how: '去设置 → 额度凭据,点「登录 Kimi」。' } })}
        onUnlock={() => {}}
      />,
    )
    expect(screen.getByLabelText('Kimi 还没接上')).toBeTruthy()
    expect(screen.getByText('去设置 → 额度凭据,点「登录 Kimi」。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '去设置里接上' })).toBeTruthy()
    // 解锁卡上没有任何数字——没接上就是没有数字,不拿 0 或者旧值糊弄。
    expect(screen.queryByText('62%')).toBeNull()
  })

  it('接上了才显示数字', () => {
    render(<QuotaPanel quota={QUOTA} now={NOW} clients={view({ kimi: ON })} />)
    expect(screen.getByText('62%')).toBeTruthy()
    expect(screen.queryByText(/还没接上/)).toBeNull()
  })

  it('按钮把去处交出去:Kimi → 设置,Claude → 初始化页', () => {
    const onUnlock = vi.fn()
    render(
      <QuotaPanel
        quota={QUOTA} now={NOW}
        clients={view({
          kimi: { installed: true, connected: false, how: '登录一次' },
          claude: { installed: true, connected: false, how: '贴钩子' },
        })}
        onUnlock={onUnlock}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '去设置里接上' }))
    expect(onUnlock).toHaveBeenCalledWith('settings', 'kimi')
    fireEvent.click(screen.getByRole('button', { name: '点一下,工作台帮你接上' }))
    expect(onUnlock).toHaveBeenCalledWith('apply', 'claude')
  })

  it('没给 onUnlock 时卡片照出,只是没有那颗按钮(那句 how 本来就能照做)', () => {
    render(<QuotaPanel quota={QUOTA} now={NOW} clients={view({ kimi: { installed: true, connected: false, how: '登录一次' } })} />)
    expect(screen.getByText('登录一次')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /接上|钩子/ })).toBeNull()
  })
})

describe('DeepSeek 那一格随 model.json 的 mode', () => {
  // 2026-09-18:中转用量由服务端给成一条「今日」窗口,不再拿官方账户的 today_spent 冒充
  // (「凭据清空后还显示 ¥2.26」那张卡)。屏幕上此时不该有任何一个钱数。
  it('relay:「工作台提供的服务 · 今日用量」,任何钱数都不再出现', () => {
    const relay: QuotaEntry = { kind: 'quota', windows: [{ label: '今日', left_pct: 62 }] }
    render(<QuotaPanel quota={{ ...QUOTA, dsh: relay }} now={NOW} modelMode="relay" />)
    expect(screen.getByText('工作台提供的服务 · 今日用量')).toBeTruthy()
    expect(screen.queryByText(/¥/)).toBeNull()
  })

  it('own / 缺席:照旧显示账号余额', () => {
    render(<QuotaPanel quota={QUOTA} now={NOW} modelMode="own" />)
    expect(screen.getByText('¥218.40')).toBeTruthy()
    cleanup()
    render(<QuotaPanel quota={QUOTA} now={NOW} />)
    expect(screen.getByText('¥218.40')).toBeTruthy()
  })

  /**
   * 2026-09-21:第三种状态 —— 没走中转、也没填 Key。以前是一行字,现在是
   * 和别家一模一样的解锁卡(决策记录 09-18 留给 Ben 那两条里的第 ②)。
   */
  it('★没走中转又没填 Key → 一张解锁卡,两颗按钮,一个数字都没有', () => {
    render(<QuotaPanel quota={{ ...QUOTA, dsh: NOT_WIRED }} now={NOW} modelMode="own" onUnlock={() => {}} />)
    expect(screen.getByLabelText('DeepSeek 还没接上')).toBeTruthy()
    expect(screen.getByRole('button', { name: '用我们的服务(推荐)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '填自己的 Key' })).toBeTruthy()
    // 没接上就是没有数字:不拿 0、不拿上一次那笔钱糊弄。
    expect(screen.queryByText(/¥/)).toBeNull()
    // 也不该长得像报错。
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('★两颗按钮各把去处交出去:一颗切中转,一颗开「模型服务」那一节', () => {
    const onUnlock = vi.fn()
    render(<QuotaPanel quota={{ ...QUOTA, dsh: NOT_WIRED }} now={NOW} modelMode="own" onUnlock={onUnlock} />)
    fireEvent.click(screen.getByRole('button', { name: '用我们的服务(推荐)' }))
    expect(onUnlock).toHaveBeenCalledWith('relay', undefined)
    fireEvent.click(screen.getByRole('button', { name: '填自己的 Key' }))
    expect(onUnlock).toHaveBeenCalledWith('model', undefined)
  })

  it('★接上之后照常:relay 有今日用量、own 有余额,解锁卡都不出现', () => {
    const relay: QuotaEntry = { kind: 'quota', windows: [{ label: '今日', left_pct: 62 }] }
    render(<QuotaPanel quota={{ ...QUOTA, dsh: relay }} now={NOW} modelMode="relay" onUnlock={() => {}} />)
    expect(screen.queryByLabelText('DeepSeek 还没接上')).toBeNull()
    cleanup()
    render(<QuotaPanel quota={QUOTA} now={NOW} modelMode="own" onUnlock={() => {}} />)
    expect(screen.queryByLabelText('DeepSeek 还没接上')).toBeNull()
    expect(screen.getByText('¥218.40')).toBeTruthy()
  })
})

describe('解锁进度那一小行', () => {
  it('写清楚已接上几家、哪家还差一步', () => {
    render(
      <QuotaPanel
        quota={QUOTA} now={NOW}
        clients={view({ claude: ON, kimi: ON, codex: { installed: true, connected: false, how: '贴钩子' } })}
      />,
    )
    // 2026-09-25 起 DeepSeek 也算一家(QUOTA.dsh 取到了余额 = 接上了),排在最前。
    expect(screen.getByRole('status').textContent).toContain('已接上 3 家:DeepSeek、Claude、Kimi')
    expect(screen.getByRole('status').textContent).toContain('Codex 装了还没接:贴钩子')
  })

  it('★维护者那台机器:微信企微装着、有额度的三家都没接 → 不出现「已接上 … 微信」,有一颗「全部接上」', () => {
    const onUnlock = vi.fn()
    render(
      <QuotaPanel
        quota={{ ...QUOTA, dsh: NOT_WIRED }} now={NOW}
        clients={view({
          claude: { installed: true, connected: false, how: '点一下,工作台帮你接上' },
          codex: { installed: true, connected: false, how: '点一下,工作台帮你接上' },
          kimi: { installed: true, connected: false, how: '要你自己登一次' },
          wechat: { installed: true, connected: false },
          wecom: { installed: true, connected: false },
        })}
        onUnlock={onUnlock}
      />,
    )
    const line = screen.getByRole('status').textContent ?? ''
    expect(line).not.toMatch(/微信|企业微信/)
    expect(line).not.toContain('已接上')
    fireEvent.click(screen.getByRole('button', { name: '全部接上' }))
    expect(onUnlock).toHaveBeenCalledWith('apply-all')
  })

  it('只有一家能代写时不画「全部接上」(卡片上那颗就是同一件事)', () => {
    render(
      <QuotaPanel
        quota={QUOTA} now={NOW}
        clients={view({ claude: ON, codex: { installed: true, connected: false, how: '点一下' } })}
        onUnlock={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: '全部接上' })).toBeNull()
  })

  it('★可关,而且不是弹窗:它就在面板里,关掉之后整行消失', () => {
    render(<QuotaPanel quota={QUOTA} now={NOW} clients={view({ claude: ON })} />)
    expect(screen.getByRole('status')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '不再提示' }))
    expect(screen.queryByRole('status')).toBeNull()
    // 没有任何 dialog/alertdialog —— 不弹窗是硬要求。
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('★关掉之后,每秒一次的轮询重渲染不会把它带回来', () => {
    const { rerender } = render(<QuotaPanel quota={QUOTA} now={NOW} clients={view({ claude: ON })} />)
    fireEvent.click(screen.getByRole('button', { name: '不再提示' }))
    // 轮询推进:同一份 clients,只有时钟在走。
    rerender(<QuotaPanel quota={QUOTA} now="2026-09-17T10:31:00+08:00" clients={view({ claude: ON })} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('★又装上一家(那句话变了)→ 这条他没见过的新消息会自己回来', () => {
    const { rerender } = render(<QuotaPanel quota={QUOTA} now={NOW} clients={view({ claude: ON })} />)
    fireEvent.click(screen.getByRole('button', { name: '不再提示' }))
    rerender(<QuotaPanel quota={QUOTA} now={NOW} clients={view({ claude: ON, kimi: ON })} />)
    // DeepSeek 取到了余额也算一家(2026-09-25),所以是 3 家。
    expect(screen.getByRole('status').textContent).toContain('已接上 3 家')
  })

  it('★读不到 localStorage 时组件照样不崩 —— 关的动作只是不跨刷新记住', () => {
    // 壳里、无痕窗口里也可能读不到 localStorage。读写两处都包了 try/catch,
    // 这一条就是那两个 catch 的证据(浏览器里跨刷新记住那一半在交接文档的浏览器验收里)。
    //
    // 2026-09-25:这一条原来靠「这台 jsdom 没有 localStorage(实测)」这个**环境前提**站着的,
    // jsdom 升上来之后它有了 `window.localStorage`,前提没了、这条就红。红的不是代码,是环境
    // (D 类)。前提现在由这条用例自己造:先把 localStorage 盖掉再挂组件,完了原样还回去 ——
    // 壳里、无痕窗口里读不到它这件事,以后不靠"这台机器碰巧没有"来保证。
    Object.defineProperty(window, 'localStorage', { value: undefined, configurable: true })
    try {
      expect(window.localStorage).toBeUndefined()
      render(<QuotaPanel quota={QUOTA} now={NOW} clients={view({ claude: ON })} />)
      fireEvent.click(screen.getByRole('button', { name: '不再提示' }))
      expect(screen.queryByRole('status')).toBeNull()
    } finally {
      delete (window as unknown as { localStorage?: unknown }).localStorage
    }
  })

  it('还没扫过 / 一家都没扫到 → 这一行不出现', () => {
    render(<QuotaPanel quota={QUOTA} now={NOW} />)
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()
    render(<QuotaPanel quota={QUOTA} now={NOW} clients={view()} />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
