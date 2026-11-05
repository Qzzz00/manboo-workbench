/** 设置弹窗里的「目录」一节(2026-09-17 卡 C 第 6 条:扫描根 / 收件箱目录 / 事务官仓库)。 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog } from '../src/client/SettingsDialog.tsx'
import { GROUP, openGroup } from './settingsGroup.ts'

afterEach(cleanup)

const PATHS = {
  scan_roots: null,
  inbox_dirs: null,
  butler_cwd: null,
  defaults: {
    scan_roots: [
      { path: '/Users/example/Documents/GitHub', depth: 1 },
      { path: '/Users/example/Documents/Codex', depth: 2 },
    ],
    inbox_dirs: ['/Users/example/Downloads', '/Users/example/Desktop'],
  },
  effective: {
    scan_roots: [
      { path: '/Users/example/Documents/GitHub', depth: 1 },
      { path: '/Users/example/Documents/Codex', depth: 2 },
    ],
    inbox_dirs: ['/Users/example/Downloads', '/Users/example/Desktop'],
    butler_cwd: null,
    butler_cwd_source: 'none',
  },
}

/** 一个会记下所有请求的 fetch;/config/paths 的 GET 回 PATHS,PUT 由 over 决定。 */
function stub(over: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const calls: { url: string, method: string, body: any }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const custom = over(url, init)
    if (custom !== undefined) return custom
    if (url.endsWith('/config/paths')) {
      const payload = init?.method === 'PUT' ? { ok: true, restart_required: false, ...PATHS } : PATHS
      return { ok: true, status: 200, json: async () => payload } as Response
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

async function open(over?: Parameters<typeof stub>[0]) {
  const { impl, calls } = stub(over)
  render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} />)
  await openGroup(GROUP.advanced)
  await screen.findByRole('heading', { name: '目录' })
  return { calls }
}

describe('目录一节', () => {
  it('挂载就把当前配置读回来,没配过时把默认值摆出来当底稿', async () => {
    await open()
    await waitFor(() => expect(screen.getByLabelText('第 1 个扫描根')).toHaveValue('/Users/example/Documents/GitHub'))
    expect(screen.getByLabelText('第 2 个扫描根')).toHaveValue('/Users/example/Documents/Codex')
    expect(screen.getByLabelText('第 1 个收件箱目录')).toHaveValue('/Users/example/Downloads')
    // 没配过要说清楚"现在用的是默认值",不然看着像已经配过了。
    expect(screen.getByText(/还没配过/)).toBeInTheDocument()
  })

  it('depth 是 1~3 的下拉,不让手打', async () => {
    await open()
    const select = await screen.findByLabelText('第 1 个扫描根的层数') as HTMLSelectElement
    expect([...select.options].map(o => o.value)).toEqual(['1', '2', '3'])
    expect(select.value).toBe('1')
  })

  it('加一个扫描根、删一个收件箱目录,再保存 → PUT 带上改完的整份清单', async () => {
    const { calls } = await open()
    await waitFor(() => expect(screen.getByLabelText('第 1 个扫描根')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: '加一个扫描根' }))
    await userEvent.type(screen.getByLabelText('第 3 个扫描根'), '/Users/example/WeChatProjects')
    await userEvent.selectOptions(screen.getByLabelText('第 3 个扫描根的层数'), '3')
    await userEvent.click(screen.getByRole('button', { name: '删掉第 2 个收件箱目录' }))
    await userEvent.click(screen.getByRole('button', { name: '保存目录' }))

    await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true))
    const put = calls.find(c => c.method === 'PUT')!
    expect(put.url).toBe('http://x/config/paths')
    expect(put.body.scan_roots).toEqual([
      { path: '/Users/example/Documents/GitHub', depth: 1 },
      { path: '/Users/example/Documents/Codex', depth: 2 },
      { path: '/Users/example/WeChatProjects', depth: 3 },
    ])
    expect(put.body.inbox_dirs).toEqual(['/Users/example/Downloads'])
  })

  it('★服务端拒了就把服务端那句原话摆出来,不谎称保存了', async () => {
    await open((url, init) => url.endsWith('/config/paths') && init?.method === 'PUT'
      ? ({ ok: false, status: 400, json: async () => ({ error: '收件箱目录 /nope 不存在' }) } as Response)
      : undefined)
    await waitFor(() => expect(screen.getByLabelText('第 1 个扫描根')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: '保存目录' }))
    await waitFor(() => expect(screen.getByText('收件箱目录 /nope 不存在')).toBeInTheDocument())
  })

  it('★改了事务官仓库、服务端说要重启:把那句话原样显示,不说"已生效"', async () => {
    await open((url, init) => url.endsWith('/config/paths') && init?.method === 'PUT'
      ? ({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            restart_required: true,
            hint: '事务官仓库改好了,但……要 kickstart 重启一次才会切过去。',
            ...PATHS,
          }),
        } as Response)
      : undefined)
    await waitFor(() => expect(screen.getByLabelText('事务官仓库目录')).toBeInTheDocument())
    await userEvent.type(screen.getByLabelText('事务官仓库目录'), '/Users/example/Documents/GitHub/desktop-workbench')
    await userEvent.click(screen.getByRole('button', { name: '保存目录' }))
    await waitFor(() => expect(screen.getByText(/kickstart 重启一次/)).toBeInTheDocument())
    expect(screen.queryByText('已保存,已经生效')).not.toBeInTheDocument()
  })

  it('保存成功且不用重启:如实说一句"已经生效"', async () => {
    await open()
    await waitFor(() => expect(screen.getByLabelText('第 1 个扫描根')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: '保存目录' }))
    await waitFor(() => expect(screen.getByText('已保存,已经生效')).toBeInTheDocument())
  })

  it('接口回 404(没接路径配置)时整节不出现,不摆一个点不动的空表单', async () => {
    const { impl } = stub(url => url.endsWith('/config/paths')
      ? ({ ok: false, status: 404, json: async () => ({ error: '路径配置未启用' }) } as Response)
      : undefined)
    render(<SettingsDialog baseUrl="http://x" fetchImpl={impl} onClose={() => {}} />)
    await openGroup(GROUP.advanced)
    await waitFor(() => expect(screen.queryByRole('heading', { name: '目录' })).not.toBeInTheDocument())
  })
})
