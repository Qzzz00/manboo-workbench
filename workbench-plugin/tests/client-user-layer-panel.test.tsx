/**
 * 设置 →「这台电脑」→「用户层」那一节(2026-10-21,卡「分层第一刀」)。
 *
 * 她要看得到四样:目录在哪(一颗「在访达中打开」,不碰终端)、装了什么、哪个坏了(人话)、
 * 四族是插件(现在还装在工作台里面)。没接用户层(GET /user-layer 404)整节不出现。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { UserLayerPayload } from '../src/protocol.ts'
import { UserLayerPanel } from '../src/client/UserLayerPanel.tsx'
import { createUserLayerRegistry } from '../src/client/userLayer.tsx'

afterEach(cleanup)

const PAYLOAD: UserLayerPayload = {
  contract: 1,
  dir: '/Users/x/.dsh/workbench/用户层',
  web_widgets_dir: '/Users/x/.dsh/workbench/用户层/网页小组件',
  folders: [{ name: '小组件', live: true, what: '…' }, { name: '插件', live: false, what: '…' }],
  slots: [{ id: 'files', name: '素材管理' }, { id: 'publish', name: '发布计划' }, { id: 'notes', name: '随手记' }],
  plugins: [
    { id: 'display', name: '展示台', where: 'built-in', order: 1, note: '已是独立目录' },
    { id: 'meeting', name: '会议', where: 'built-in', order: 3, note: '牵连三处' },
  ],
  widgets: [
    { id: 'files', name: '素材管理', status: 'ok', replaces: 'files', author: '运营同学', rev: 'aaaaaaaaaaaa' },
    { id: 'publish', name: '发布计划', status: 'broken', replaces: 'publish', problem: '找不到 index.js' },
    { id: 'topics', name: '选题池', status: 'broken', replaces: 'todo', problem: 'contract 应该是 1' },
    { id: 'notes', name: '随手记', status: 'ok', replaces: 'notes', rev: 'bbbbbbbbbbbb' },
    { id: 'review', name: '数据复盘', status: 'ok', replaces: 'review', rev: 'cccccccccccc', rolled_back: 'review/index.js 运行出错:x' },
  ],
}

function fakeFetch(calls: string[], payload: UserLayerPayload | null = PAYLOAD): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url.replace('http://h', '')}`)
    if (url.endsWith('/user-layer') && payload === null) return new Response('{}', { status: 404 })
    if (url.endsWith('/user-layer')) return new Response(JSON.stringify(payload), { status: 200 })
    if (url.endsWith('/user-layer/reveal')) return new Response('{"ok":true}', { status: 200 })
    if (url.endsWith('/user-layer/fix')) {
      calls.push(`body ${String(init?.body)}`)
      return new Response('{"ok":true,"dispatch_note":"交给 Codex 改了,只改用户层目录"}', { status: 200 })
    }
    if (url.endsWith('/restore')) {
      calls.push(`body ${String(init?.body)}`)
      return new Response('{"ok":true}', { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

describe('用户层那一节', () => {
  it('★目录、装了什么、哪个坏了(人话)、四族插件', async () => {
    const calls: string[] = []
    render(<UserLayerPanel baseUrl="http://h" fetchImpl={fakeFetch(calls)} registry={createUserLayerRegistry()} />)
    expect(await screen.findByRole('heading', { name: '用户层' })).toBeTruthy()
    expect(screen.getByText(PAYLOAD.dir)).toBeTruthy()
    const files = document.querySelector('[data-widget-id="files"]')!
    expect(files.textContent).toContain('素材管理')
    expect(files.textContent).toContain('在用')
    expect(files.textContent).toContain('运营同学')
    const publish = document.querySelector('[data-widget-id="publish"]')!
    expect(publish.textContent).toContain('没装上')
    expect(publish.textContent).toContain('找不到 index.js')
    // 发布计划本体没有自带的那一版:不说「先用自带的」,说格子里写着原因
    expect(publish.textContent).toContain('先空着')
    expect(document.querySelector('[data-widget-id="topics"]')!.textContent).toContain('先用工作台自带的那一版')
    // 插件清单收在「插件 N 样 · 展开 ›」里(2026-10-22 照评审页的折叠)
    await userEvent.click(screen.getByText(/^插件 \d+ 样$/))
    const plugins = document.querySelector('[data-plugins]')!
    expect(plugins.textContent).toContain('展示台')
    expect(plugins.textContent).toContain('会议')
    expect(plugins.textContent).toContain('现在还装在工作台里面')
  })

  it('页面上装的时候坏了(清单是好的):也说出来', async () => {
    const registry = createUserLayerRegistry()
    registry.install({ id: 'notes', name: '随手记', status: 'ok', replaces: 'notes', export: 'X', rev: 'bbbbbbbbbbbb' }, 'module.exports = {}')
    render(<UserLayerPanel baseUrl="http://h" fetchImpl={fakeFetch([])} registry={registry} />)
    await screen.findByRole('heading', { name: '用户层' })
    const notes = document.querySelector('[data-widget-id="notes"]')!
    expect(notes.textContent).toContain('没装上')
    expect(notes.textContent).toContain('「X」')
  })

  it('★「在访达中打开」:POST /user-layer/reveal,不让她碰终端', async () => {
    const calls: string[] = []
    render(<UserLayerPanel baseUrl="http://h" fetchImpl={fakeFetch(calls)} registry={createUserLayerRegistry()} />)
    await userEvent.click(await screen.findByRole('button', { name: '在访达中打开' }))
    await waitFor(() => expect(calls).toContain('POST /user-layer/reveal'))
  })

  it('「重新看一遍」再拉一次清单', async () => {
    const calls: string[] = []
    render(<UserLayerPanel baseUrl="http://h" fetchImpl={fakeFetch(calls)} registry={createUserLayerRegistry()} />)
    await userEvent.click(await screen.findByRole('button', { name: '重新看一遍' }))
    await waitFor(() => expect(calls.filter(one => one === 'GET /user-layer')).toHaveLength(2))
  })

  it('一格都没有:说一句放哪里', async () => {
    render(<UserLayerPanel baseUrl="http://h" fetchImpl={fakeFetch([], { ...PAYLOAD, widgets: [] })} registry={createUserLayerRegistry()} />)
    // 2026-10-23 起布局块也有一句「还没有…」,这里钉的是小组件那一句:指到「小组件」目录。
    expect(await screen.findByText(/放进「小组件」目录/)).toBeTruthy()
  })

  it('没接用户层:整节不出现', async () => {
    const calls: string[] = []
    const { container } = render(<UserLayerPanel baseUrl="http://h" fetchImpl={fakeFetch(calls, null)} registry={createUserLayerRegistry()} />)
    await act(async () => { await waitFor(() => expect(calls).toContain('GET /user-layer')) })
    expect(container.innerHTML).toBe('')
  })
})

describe('自愈两件', () => {
  it('★新改的坏了在用上一版:说清楚', async () => {
    render(<UserLayerPanel baseUrl="http://h" fetchImpl={fakeFetch([])} registry={createUserLayerRegistry()} />)
    await screen.findByRole('heading', { name: '用户层' })
    const review = document.querySelector('[data-widget-id="review"]')!
    expect(review.textContent).toContain('在用上一版')
    expect(review.textContent).toContain('review/index.js 运行出错')
  })

  it('★说一句「派去改」:POST /user-layer/fix,回执上屏', async () => {
    const calls: string[] = []
    render(<UserLayerPanel baseUrl="http://h" fetchImpl={fakeFetch(calls)} registry={createUserLayerRegistry()} />)
    await userEvent.type(await screen.findByLabelText('想改用户层里的什么'), '素材管理按名字排')
    await userEvent.click(screen.getByRole('button', { name: '派去改' }))
    expect(await screen.findByText(/只改用户层目录/)).toBeTruthy()
    expect(calls).toContain('POST /user-layer/fix')
    expect(calls).toContain('body {"said":"素材管理按名字排"}')
  })
})

describe('分层自愈:画好过的版本能选回(2026-10-23)', () => {
  const WITH_HISTORY: UserLayerPayload = {
    ...PAYLOAD,
    widgets: [
      {
        id: 'files', name: '素材管理', status: 'ok', replaces: 'files', rev: 'dddddddddddd',
        history: [
          { rev: 'dddddddddddd', at: '2026-10-23T12:00:00.000Z' },
          { rev: 'aaaaaaaaaaaa', at: '2026-10-22T09:30:00.000Z' },
        ],
      },
      { id: 'notes', name: '随手记', status: 'ok', replaces: 'notes', rev: 'bbbbbbbbbbbb' },
    ],
  }

  it('画好过两版:折叠里列出来;点「选回这一版」POST restore,回执上屏', async () => {
    const calls: string[] = []
    render(<UserLayerPanel baseUrl="http://h" fetchImpl={fakeFetch(calls, WITH_HISTORY)} registry={createUserLayerRegistry()} />)
    await screen.findByRole('heading', { name: '用户层' })
    await userEvent.click(screen.getByText('画好过 2 版'))
    expect(document.querySelector('[data-history-rev="dddddddddddd"]')?.textContent).toContain('dddddddddddd')
    expect(document.querySelector('[data-history-rev="aaaaaaaaaaaa"]')?.textContent).toContain('aaaaaaaaaaaa')
    // 选回较早的那一版(第二颗键)
    await userEvent.click(screen.getAllByRole('button', { name: '选回这一版' })[1]!)
    await waitFor(() => expect(calls).toContain('POST /user-layer/widgets/files/restore'))
    expect(calls).toContain('body {"rev":"aaaaaaaaaaaa"}')
    expect(await screen.findByText(/已选回/)).toBeTruthy()
  })

  it('没有存下版本的格子:不出这一折', async () => {
    render(<UserLayerPanel baseUrl="http://h" fetchImpl={fakeFetch([], WITH_HISTORY)} registry={createUserLayerRegistry()} />)
    await screen.findByRole('heading', { name: '用户层' })
    expect(screen.queryByText('画好过 1 版')).toBeNull()
    expect(document.querySelector('[data-widget-id="notes"]')?.textContent).not.toContain('画好过')
  })
})
