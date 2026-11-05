/**
 * 体检页上「出错怎么让人知道」那一块(2026-09-22)。
 *
 * 这一组盯的是**说没说清楚**,而不是好不好看:
 *   ① 开关默认开 → 第一次进来那段说明必须摊开,而且必须写着「报什么 / 不报什么 / 怎么关」;
 *   ② 看过一次之后收起来(但开关与那一句短说明还在);
 *   ③ 导出按下去要有话:「在打包…」→ 包在哪 → 能摊开看包内清单;
 *   ④ 报错带编号。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

import { SetupPage } from '../src/client/setup/SetupPage.tsx'
import type { WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)

const STATE = { sessions: [], quota: {} } as unknown as WorkbenchState

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface Calls { url: string, method: string, body?: string }

/**
 * 假 fetch。体检页起来时会问好几条路(status / apk / config),这里一律给一个够用的最小回包,
 * 只有 `/diag/*` 那几条按用例摆。
 */
function harness(options: {
  settings?: Record<string, unknown>
  exportResult?: unknown
  exportStatus?: number
} = {}) {
  const calls: Calls[] = []
  const settings = {
    report_enabled: true, notice_seen: false, sent_this_hour: 0, hourly_limit: 20, ...(options.settings ?? {}),
  }
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body === undefined ? {} : { body: String(init.body) }) })
    if (url.endsWith('/diag/settings') && (init?.method ?? 'GET') === 'GET') return reply(settings)
    if (url.endsWith('/diag/settings')) {
      const patch = JSON.parse(String(init?.body)) as { report_enabled: boolean }
      settings.report_enabled = patch.report_enabled
      return reply(settings)
    }
    if (url.endsWith('/diag/notice-seen')) { settings.notice_seen = true; return reply(settings) }
    if (url.endsWith('/diag/export')) {
      if (options.exportStatus !== undefined && options.exportStatus >= 400) {
        return reply({ error: '压包失败(ditto 退出码 1)', code: 'WB-123456' }, options.exportStatus)
      }
      return reply(options.exportResult ?? {
        ok: true,
        file: '/Users/example/Desktop/工作台诊断包-20260922-101530.zip',
        file_redacted: '/Users/<用户>/Desktop/工作台诊断包-20260922-101530.zip',
        bytes: 240_000,
        entries: [
          { path: '包内清单.md', bytes: 4096, note: '这份包里有什么、没有什么' },
          { path: '日志/web.stdout.log', bytes: 120_000, truncated: true, note: '工作台插件' },
        ],
        skipped: [{ what: '日志/butler.stdout.log', why: '这台机器上还没有这份日志' }],
        revealed: true,
      })
    }
    if (url.endsWith('/setup/status')) return reply({ items: [], all_ok: true, optional_pending: 0, checked_at: '2026-09-22T10:00:00Z' })
    if (url.endsWith('/setup/apk.json')) return reply({ available: false, path: '' })
    return reply({}, 404)
  }) as unknown as typeof fetch

  render(<SetupPage baseUrl="http://127.0.0.1:8791" fetchImpl={fetchImpl} state={STATE} onClose={() => {}} jobPollMs={0} />)
  return { calls, fetchImpl }
}

describe('自动上报那一格', () => {
  it('第一次进来:开关是开的,而且把「报什么 / 不报什么 / 怎么关」摊开说', async () => {
    harness()
    const box = await screen.findByLabelText('出错怎么让人知道')
    expect(await screen.findByRole('checkbox', { name: '出错自动报告给开发者' })).toBeChecked()
    expect(box).toHaveTextContent('这一项默认是开着的')
    expect(box).toHaveTextContent('报什么')
    expect(box).toHaveTextContent('不报什么')
    expect(box).toHaveTextContent('不想报')
    // 最要紧的两句:不报密钥、不报他说过的话
    expect(box).toHaveTextContent('密码与密钥')
    expect(box).toHaveTextContent('跟事务官说过的话')
  })

  it('第一次显示完就记一笔「看过了」', async () => {
    const h = harness()
    await screen.findByLabelText('出错怎么让人知道')
    await waitFor(() => expect(h.calls.some(call => call.url.endsWith('/diag/notice-seen'))).toBe(true))
  })

  it('看过之后收起长说明,但开关与一句短的还在', async () => {
    harness({ settings: { notice_seen: true } })
    const box = await screen.findByLabelText('出错怎么让人知道')
    expect(box).not.toHaveTextContent('这一项默认是开着的')
    expect(box).toHaveTextContent('随时可以关')
    expect(screen.getByRole('checkbox', { name: '出错自动报告给开发者' })).toBeChecked()
  })

  it('关得掉,而且关了之后界面上写着「关着」', async () => {
    const h = harness()
    const box = await screen.findByLabelText('出错怎么让人知道')
    await userEvent.click(await screen.findByRole('checkbox', { name: '出错自动报告给开发者' }))
    await waitFor(() => expect(box).toHaveTextContent('关着'))
    const posted = h.calls.find(call => call.url.endsWith('/diag/settings') && call.method === 'POST')
    expect(JSON.parse(posted?.body ?? '{}')).toEqual({ report_enabled: false })
  })

  it('没登录时如实说「报错只留在本机」,不假装报出去了', async () => {
    harness({ settings: { relay_url: undefined } })
    const box = await screen.findByLabelText('出错怎么让人知道')
    expect(box).toHaveTextContent('还没连上服务器')
  })

  it('连上了就说这一小时报了几条', async () => {
    harness({ settings: { notice_seen: true, relay_url: 'https://api.aibooo.cn', sent_this_hour: 3 } })
    const box = await screen.findByLabelText('出错怎么让人知道')
    expect(box).toHaveTextContent('这一小时已经报了 3 / 20 条')
  })
})

describe('导出诊断包', () => {
  it('那句说明里写着「密钥不进包」与「有一份包内清单」', async () => {
    harness()
    const box = await screen.findByLabelText('导出诊断包')
    expect(box).toHaveTextContent('一个字节都不进去')
    expect(box).toHaveTextContent('包内清单')
  })

  it('点了之后:包在哪、多大、几项,而且说访达选中了没有', async () => {
    harness()
    await userEvent.click(await screen.findByRole('button', { name: '导出诊断包' }))
    const box = await screen.findByLabelText('导出诊断包')
    await waitFor(() => expect(box).toHaveTextContent('/Users/<用户>/Desktop/工作台诊断包-20260922-101530.zip'))
    expect(box).toHaveTextContent('访达里已经帮你选中它了')
  })

  it('包内清单摊得开:每一项、以及"没收进来的"都看得见', async () => {
    harness()
    await userEvent.click(await screen.findByRole('button', { name: '导出诊断包' }))
    const list = await screen.findByLabelText('包内清单')
    expect(list).toHaveTextContent('包内清单.md')
    expect(list).toHaveTextContent('日志/web.stdout.log')
    expect(list).toHaveTextContent('前面截断过')
    expect(list).toHaveTextContent('没收:日志/butler.stdout.log')
  })

  it('导不出来时把服务端那句话与**编号**一起显示 —— 他念编号就能对上', async () => {
    harness({ exportStatus: 500 })
    await userEvent.click(await screen.findByRole('button', { name: '导出诊断包' }))
    const alert = await screen.findByText(/压包失败/)
    expect(alert).toHaveTextContent('编号 WB-123456')
  })

  it('业务失败(ok:false)也照样把话显示出来,不做成"点了没反应"', async () => {
    harness({ exportResult: { ok: false, error: '桌面写不进去(没权限?)' } })
    await userEvent.click(await screen.findByRole('button', { name: '导出诊断包' }))
    expect(await screen.findByText(/桌面写不进去/)).toBeInTheDocument()
  })
})
