import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COLLECT_PROMISE_LINES, COLLECT_PROMISE_TITLE, CredentialPanel, OWN_KEYS_SUMMARY } from '../src/client/CredentialPanel.tsx'

afterEach(cleanup)

/** 小红书那一家那一块(`data-cred=xhs`)。 */
const xhsRow = (): HTMLElement => screen.getByText('小红书创作者中心').closest('[data-cred]') as HTMLElement

const KEY = 'sk-not-a-real-key-0123456789'
const BASE = 'http://127.0.0.1:8791'

function stubFetch(initial = { deepseek: false, kimi_web: false, claude_api: false }) {
  const state = { ...initial }
  const calls: { url: string, method: string, body?: string }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body === undefined ? {} : { body: String(init.body) }) })
    if (url.endsWith('/login')) {
      if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) }
      return { ok: true, status: 200, json: async () => ({ state: 'waiting', message: '请在打开的窗口里登录' }) }
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { provider: keyof typeof state, key: string }
      state[body.provider] = body.key !== ''
    }
    return {
      ok: true,
      status: 200,
      json: async () => Object.fromEntries(
        Object.entries(state).map(([k, v]) => [k, { configured: v }]),
      ),
    }
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('CredentialPanel', () => {
  it('零服务器档自带的三格(博查、火山识别一对)和 DeepSeek 同一种填法', async () => {
    render(<CredentialPanel baseUrl={BASE} fetchImpl={stubFetch().impl} />)
    // 不算进「暂不可用 N 家」,另收一折;每一格照别家那样点「去填」露出框。
    await userEvent.click(await screen.findByText(OWN_KEYS_SUMMARY))
    for (const name of ['博查搜索', '火山识别 · App ID', '火山识别 · Access Token']) {
      const row = screen.getByText(name).closest('[data-cred]') as HTMLElement
      await userEvent.click(within(row).getByRole('button', { name: '去填' }))
      expect(screen.getByLabelText(`${name} 的密钥`)).toBeTruthy()
    }
  })

  it('DeepSeek 和 Claude 走填 Key，Kimi 走登录按钮', async () => {
    const { impl } = stubFetch()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} />)

    expect(screen.getByLabelText('DeepSeek 的密钥')).toBeTruthy()
    // Claude 走 `claude setup-token`，不走浏览器登录态——claude.ai 的服务端重放
    // 会吃反机器人验证页（交接文档已排除第 7 条）。
    expect(screen.getByLabelText('Claude 的密钥')).toBeTruthy()
    await waitFor(() => expect(screen.getAllByRole('button', { name: '登录 ↗' })).toHaveLength(1))
  })

  it('两个 Key 框各写各的——共用一个草稿会串台，还可能把 Key 提交给错的一家', async () => {
    const { impl, calls } = stubFetch()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} />)

    await userEvent.type(screen.getByLabelText('DeepSeek 的密钥'), 'ds-key')
    expect((screen.getByLabelText('Claude 的密钥') as HTMLInputElement).value).toBe('')

    await userEvent.type(screen.getByLabelText('Claude 的密钥'), 'sk-ant-setup')
    expect((screen.getByLabelText('DeepSeek 的密钥') as HTMLInputElement).value).toBe('ds-key')

    // 第二个「保存」是 Claude 那一行（KEY_ROWS 的顺序：DeepSeek、Claude）
    await userEvent.click(screen.getAllByRole('button', { name: '保存' })[1]!)
    const posted = calls.find(c => c.method === 'POST' && !c.url.endsWith('/login'))
    expect(JSON.parse(String(posted?.body))).toEqual({ provider: 'claude_api', key: 'sk-ant-setup' })
  })

  it('点登录会让工作台去开窗口，并显示等待提示——不要求他自己复制 Cookie', async () => {
    const { impl, calls } = stubFetch()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} />)

    await userEvent.click(await screen.findByRole('button', { name: '登录 ↗' }))

    const posted = calls.find(c => c.url.endsWith('/login') && c.method === 'POST')
    expect(JSON.parse(String(posted?.body))).toEqual({ provider: 'kimi_web' })
    expect(await screen.findByRole('status')).toBeTruthy()
  })

  it('已登录时按钮变成"重新登录"，且绝不显示 Cookie', async () => {
    const { impl } = stubFetch({ deepseek: false, kimi_web: true, claude_api: false })
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} />)

    // 2026-10-22 起状态在那一行的副行里:「已登录 · 登录一次长期有效…」,按钮写「重新登录 ↗」
    await waitFor(() => expect(screen.getByText(/^已登录 · /)).toBeTruthy())
    expect(screen.getByRole('button', { name: '重新登录 ↗' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('kimi_session')
  })

  it('Key 保存后立刻清空输入框——不在界面上多留一秒', async () => {
    const { impl } = stubFetch()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} />)
    const input = screen.getByLabelText('DeepSeek 的密钥') as HTMLInputElement

    await userEvent.type(input, KEY)
    await userEvent.click(screen.getAllByRole('button', { name: '保存' })[0]!)

    await waitFor(() => expect(input.value).toBe(''))
  })

  it('输入框是 password 且关掉自动填充', () => {
    const { impl } = stubFetch()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} />)

    const input = screen.getByLabelText('DeepSeek 的密钥')
    expect(input.getAttribute('type')).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
  })
})

/**
 * 「登录小红书创作者中心」那一栏(2026-09-21 数据复盘自取)。
 *
 * 它与上面那几家的**根本不同**:这条路一个凭据都不取 —— 登录态只在那个专用
 * Chrome 档案里。所以这一栏不在 `/credentials` 的状态里,它的「已接上」来自
 * `/state.xhs.login`,由上层当 prop 传进来。
 */
describe('CredentialPanel:小红书创作者中心那一栏', () => {
  function xhsStub() {
    const calls: { url: string, method: string }[] = []
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.endsWith('/xhs/login') || url.endsWith('/xhs/login/new')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, message: '已经打开创作者中心。请在那个窗口里自己登录,登完不要关它。' }) }
      }
      return { ok: true, status: 200, json: async () => ({ deepseek: { configured: false }, kimi_web: { configured: false }, claude_api: { configured: false } }) }
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  it('★没接自取服务时那一栏整块不出现(不画一颗点了没用的按钮)', () => {
    const { impl } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} />)
    expect(screen.queryByText('小红书创作者中心')).toBeNull()
  })

  it('没登录时那一行的按钮写「登录 ↗」(2026-10-22 前写「登录小红书创作者中心」)', () => {
    const { impl } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: false }} />)
    expect(screen.getByText('小红书创作者中心')).toBeInTheDocument()
    // 2026-10-22 起名字是那一行的标题,按钮照评审页只写「登录 ↗」(Kimi 那一行也是这颗,所以认准小红书那一行)
    const row = xhsRow()
    expect(within(row).getByRole('button', { name: '登录 ↗' })).toBeInTheDocument()
    expect(row.querySelector('.ben-wb__srow-label small')?.textContent).toMatch(/^未登录 · /)
  })

  it('登上了显示「已接上 · 昵称」;读不到昵称时只说「已接上」(**不编一个名字**)', () => {
    const { impl } = xhsStub()
    const { unmount } = render(
      <CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: true, nickname: '假昵称·用例用的' }} />,
    )
    expect(screen.getByText(/^已接上 · 假昵称·用例用的 · /)).toBeInTheDocument()
    unmount()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: true }} />)
    expect(screen.getByText(/^已接上 · 数据复盘/)).toBeInTheDocument()
  })

  it('★那一段风控自保的话逐字在界面上(卡里第 5 条)', () => {
    const { impl } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: false }} />)
    const note = screen.getByText(/这是用你自己的登录/)
    expect(note.textContent).toContain('在你自己电脑上、读你自己的后台页面,不经过任何服务器')
    expect(note.textContent).toContain('登录信息不存进工作台的任何文件')
    expect(note.textContent).toContain('两次之间至少隔 10 分钟')
  })

  it('点一下打 POST /xhs/login,回话原样上屏', async () => {
    const { impl, calls } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: false }} />)
    await userEvent.click(within(xhsRow()).getByRole('button', { name: '登录 ↗' }))
    await waitFor(() => expect(screen.getByText(/请在那个窗口里自己登录/)).toBeInTheDocument())
    expect(calls.some(call => call.url === `${BASE}/xhs/login` && call.method === 'POST')).toBe(true)
  })

  it('★这一栏不提交任何凭据:整个过程里没有一次带 body 的 POST /credentials', async () => {
    const { impl, calls } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: false }} />)
    await userEvent.click(within(xhsRow()).getByRole('button', { name: '登录 ↗' }))
    await waitFor(() => expect(screen.getByText(/请在那个窗口里自己登录/)).toBeInTheDocument())
    expect(calls.filter(call => call.url.endsWith('/credentials') && call.method === 'POST')).toEqual([])
  })
})

/**
 * 采集类那一段承诺(2026-09-22)。
 *
 * ★ 这一组钉的是一件**性质**上的事,不是排版:
 * 采集类与数据复盘**是两件事**(预研 3.1)——那条读的是他自己的后台,
 * 这条读的是**别人的笔记和别人的评论**。所以两段话必须分开写,
 * 而且采集那段里**不许出现**「读你自己的后台页面」这种在这里是假的话。
 */
describe('采集类:单独一段承诺', () => {
  const collect = { today: 2, daily_max: 30, workdir_ready: true }

  /** 这一组不打任何接口,`/credentials` 那一次回一份"都没配"就够了。 */
  function xhsStub() {
    const impl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ deepseek: { configured: false }, kimi_web: { configured: false }, claude_api: { configured: false } }),
    })) as unknown as typeof fetch
    return { impl }
  }

  it('★ 没接采集服务时整段不出现 —— 承诺只在功能真在这台机器上时才说', () => {
    const { impl } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: true }} />)
    expect(screen.queryByText(COLLECT_PROMISE_TITLE)).toBeNull()
  })

  it('★ 九句逐字都在界面上', () => {
    const { impl } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} collect={collect} />)
    for (const line of COLLECT_PROMISE_LINES) {
      expect(screen.getByText(line)).toBeInTheDocument()
    }
  })

  it('★ 与数据复盘那段分开:采集这段里不出现「读你自己的后台页面」', () => {
    const { impl } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: true }} collect={collect} />)
    const block = screen.getByText(COLLECT_PROMISE_TITLE).closest('[data-cred]')
    expect(block?.textContent).not.toContain('读你自己的后台页面')
    // 而数据复盘那一段还在,一个字没被动过。
    expect(screen.getByText(/读你自己的后台页面/).textContent).toContain('两次之间至少隔 10 分钟')
  })

  it('★ 每一条红线都在那段话里能找到出处', () => {
    const { impl } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} collect={collect} />)
    const block = screen.getByText(COLLECT_PROMISE_TITLE).closest('[data-cred]')
    const said = block?.textContent ?? ''
    for (const promise of ['只从你给的链接进', '不点任何东西', '不做任何伪装', '不会替你过验证码', '每天有上限', '不经过任何服务器']) {
      expect(said).toContain(promise)
    }
    // 滚动这件事**说出来**,不藏着(Ben 2026-09-22 B2:滚动不算点,但要说清楚)。
    expect(said).toContain('往下滚')
  })

  it('今天采了几条 / 上限多少,摆在那一行上', () => {
    const { impl } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} collect={collect} />)
    expect(screen.getByText('今天 2 / 30 条')).toBeInTheDocument()
  })

  it('工作目录没配时如实说这一块用不了', () => {
    const { impl } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} collect={{ ...collect, workdir_ready: false }} />)
    expect(screen.getByText(/没地方落/)).toBeInTheDocument()
  })

  it('缺本机工具时把那句人话原样摆上去', () => {
    const { impl } = xhsStub()
    render(
      <CredentialPanel
        expanded
        baseUrl={BASE}
        fetchImpl={impl}
        collect={{ ...collect, tools: { ffmpeg: false, whisper: false, model: false, note: '爆款拆解还差:假工具一、假工具二。' } }}
      />,
    )
    expect(screen.getByText('爆款拆解还差:假工具一、假工具二。')).toBeInTheDocument()
  })
})

/**
 * 多账号(2026-09-22):设置里那一栏要能一个账号一行、并且能再开一个纯净档案。
 * Ben 原话:「再开一个纯净的,我登录第二个账号」。
 */
describe('CredentialPanel:小红书那一栏的多账号', () => {
  function xhsStub() {
    const calls: { url: string, method: string, body?: string }[] = []
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      })
      if (url.includes('/xhs/login')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, message: '已经打开创作者中心。' }) }
      }
      return { ok: true, status: 200, json: async () => ({ deepseek: { configured: false }, kimi_web: { configured: false }, claude_api: { configured: false } }) }
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  const two = [
    { profile: 'login-profile-xhs_creator', index: 1, name: '测试号甲', connected: true },
    { profile: 'login-profile-xhs_creator-2', index: 2, name: '测试号乙', connected: false },
  ]

  it('一个账号一行,状态各说各的', () => {
    const { impl } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: true, accounts: two }} />)
    // 2026-10-22 起一个账号一行:名字是标题,状态是副行
    expect(screen.getByText('测试号甲').closest('.ben-wb__srow')).toHaveTextContent('已接上')
    expect(screen.getByText('测试号乙').closest('.ben-wb__srow')).toHaveTextContent('未登录或登录态过期')
    expect(screen.getByText(/^已接上 1\/2 个账号 · /)).toBeInTheDocument()
  })

  it('★已经有账号时那颗按钮写的是「再登录一个账号」,打的是 /xhs/login/new', async () => {
    const { impl, calls } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: true, accounts: two }} />)
    await act(async () => { screen.getByRole('button', { name: '再登录一个账号 ↗' }).click() })
    expect(calls.some(call => call.url === `${BASE}/xhs/login/new` && call.method === 'POST')).toBe(true)
  })

  it('一个账号都没有时仍然是那一行的「登录 ↗」(2026-10-22 前写「登录小红书创作者中心」),打的是 /xhs/login', async () => {
    const { impl, calls } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: false, accounts: [] }} />)
    await act(async () => { within(xhsRow()).getByRole('button', { name: '登录 ↗' }).click() })
    expect(calls.some(call => call.url === `${BASE}/xhs/login` && call.method === 'POST')).toBe(true)
  })

  it('★点某一行的「重新登录」带上那一个档案的序号', async () => {
    const { impl, calls } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: true, accounts: two }} />)
    // 第二个号那一行的按钮(它没登录,所以写的是「登录」)。
    const row = screen.getByText('测试号乙').closest('.ben-wb__srow')
    await act(async () => { (row?.querySelector('button') as HTMLButtonElement).click() })
    const hit = calls.find(call => call.url === `${BASE}/xhs/login` && call.method === 'POST')
    expect(hit?.body).toBe(JSON.stringify({ profile: 2 }))
  })

  it('★整个过程一个凭据都不提交(这条路什么都不取)', async () => {
    const { impl, calls } = xhsStub()
    render(<CredentialPanel expanded baseUrl={BASE} fetchImpl={impl} xhs={{ connected: true, accounts: two }} />)
    await act(async () => { screen.getByRole('button', { name: '再登录一个账号 ↗' }).click() })
    for (const call of calls) {
      for (const word of ['cookie', 'token', 'password', 'secret']) {
        expect((call.body ?? '').toLowerCase()).not.toContain(word)
      }
    }
  })
})
