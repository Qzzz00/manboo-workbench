/**
 * 体检页末尾那颗「把各家 Agent 的记忆拷给事务官」(2026-09-22)。
 *
 * fetch 全是假的:这颗按钮真按下去会去读他电脑上 Claude / Codex / Kimi 的文件,
 * 用例里**一条请求都不能真发出去**。断言的是「探到什么就显示什么、授权三档各是什么样、
 * 重复点显示的是不是这一趟真写的那几份」。
 *
 * 三档授权(Ben 2026-09-22 定的 C5)与「可重复点」是卡上点名要覆盖的,逐条在这儿。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryImportPanel, familyLine, importedLine } from '../src/client/setup/MemoryImportPanel.tsx'
import type { MemoryImportView, MemoryProbeView } from '../src/client/setup/setupApi.ts'

afterEach(cleanup)

/** 这台机器上:Claude 45 份、Codex 1 份 md(SQLite 看得见没拷)、Kimi 未查到、工作台不拷。 */
function probeView(over: Partial<MemoryProbeView> = {}): MemoryProbeView {
  return {
    allowed: true,
    status: '可以',
    wired: true,
    note: '可以拷。点下面那颗按钮,只读它们的,原件一个字不动。',
    families: [
      { family: 'claude', label: 'Claude', count: 45, left: [] },
      { family: 'codex', label: 'Codex', count: 1, left: ['/x/.codex/memories_1.sqlite:SQLite,不是文本,这次没拷'] },
      { family: 'kimi', label: 'Kimi', count: 0, left: [] },
      { family: 'dsh', label: '工作台', count: 1, left: [], skip: '这一份本来就是事务官自己的(~/.dsh/AGENTS.md),不用拷' },
    ],
    ...over,
  }
}

interface Stub { impl: typeof fetch, calls: string[], imported: MemoryImportView }

function stub(probe: MemoryProbeView, imported?: Partial<MemoryImportView>): Stub {
  const state: Stub = {
    calls: [],
    imported: {
      ok: true,
      note: '拷过来了:Claude 45 份、Codex 1 份;Kimi 在这台电脑上没找到记忆文件。',
      written: ['docs/记忆/来自-Claude/a.md', 'docs/记忆/来自-Claude/来源.md'],
      added: ['docs/记忆/来自-Claude/a.md', 'docs/记忆/来自-Claude/来源.md'],
      ...imported,
    },
    impl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      state.calls.push(`${init?.method ?? 'GET'} ${url}`)
      const body = url.endsWith('/onboarding/memories') ? probe : state.imported
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch,
  }
  return state
}

describe('先探一眼,再决定', () => {
  it('一进来就探,每家一行;0 份写「未查到」不写「0 份」;工作台那一份写明不用拷', async () => {
    const s = stub(probeView())
    render(<MemoryImportPanel baseUrl="http://x" fetchImpl={s.impl} />)

    await screen.findByText(/Claude:45 份/)
    expect(screen.getByText(/Kimi:未查到/)).toBeInTheDocument()
    expect(screen.queryByText(/Kimi:0 份/)).not.toBeInTheDocument()
    expect(screen.getByText(/工作台:.*事务官自己/)).toBeInTheDocument()
    // 看见了没拷的那一样要说出来,不闷声吞掉。
    expect(screen.getByText(/Codex:1 份 · 另有 1 样看见了没拷/)).toBeInTheDocument()
    expect(s.calls).toEqual(['GET http://x/onboarding/memories'])
  })

  it('这台工作台没接这一档:说一句,而且没有那颗按钮', async () => {
    const s = stub(probeView({ wired: false, families: [], note: '这台工作台没接「拷别家记忆」这一档,探不了,也拷不了。' }))
    render(<MemoryImportPanel baseUrl="http://x" fetchImpl={s.impl} />)
    await screen.findByText(/没接「拷别家记忆」这一档/)
    expect(screen.queryByRole('button', { name: '拷过来' })).not.toBeInTheDocument()
  })
})

describe('授权三档', () => {
  it('★「可以」:按钮按得下去,点了真发 POST,并显示这一趟写了哪几份', async () => {
    const s = stub(probeView())
    render(<MemoryImportPanel baseUrl="http://x" fetchImpl={s.impl} />)
    const button = await screen.findByRole('button', { name: '拷过来' })
    expect(button).toBeEnabled()

    await userEvent.click(button)
    await waitFor(() => expect(s.calls).toContain('POST http://x/onboarding/import-memories'))
    await screen.findByText(/这一趟写了 2 个文件/)
    // 写了哪几份要摆出来 —— 不是一句"好了"。
    expect(screen.getByLabelText('写了哪几份')).toHaveTextContent('docs/记忆/来自-Claude/a.md')
  })

  it('★「要问」(缺省):那颗按钮按不下去,旁边写清现在是哪一档、去哪放开', async () => {
    const s = stub(probeView({
      allowed: false,
      status: '要问',
      note: '现在拷不了:授权表里「读各家客户端文件」是「要问」,不是「可以」。去引导里那一问答「可以」,或者直接改 docs/记忆/授权.md。',
    }))
    render(<MemoryImportPanel baseUrl="http://x" fetchImpl={s.impl} />)

    await screen.findByText(/授权:要问/)
    expect(screen.getByRole('button', { name: '拷过来' })).toBeDisabled()
    expect(screen.getByText(/去引导里那一问答「可以」/)).toBeInTheDocument()
    // 一条请求都没发出去过(除了那次探)。
    expect(s.calls).toEqual(['GET http://x/onboarding/memories'])
  })

  it('★「不可以」:同样按不下去', async () => {
    const s = stub(probeView({ allowed: false, status: '不可以', note: '现在拷不了:……是「不可以」。' }))
    render(<MemoryImportPanel baseUrl="http://x" fetchImpl={s.impl} />)
    await screen.findByText(/授权:不可以/)
    expect(screen.getByRole('button', { name: '拷过来' })).toBeDisabled()
  })
})

describe('可重复点', () => {
  it('★第二次点:这一趟一份都没写就如实说「没有新的」,不再报一遍 45 份', async () => {
    const s = stub(probeView(), { written: [], added: [] })
    render(<MemoryImportPanel baseUrl="http://x" fetchImpl={s.impl} />)
    await userEvent.click(await screen.findByRole('button', { name: '拷过来' }))

    await screen.findByText(/这一趟没有新的,仓库里那几份一个字节都没动/)
    expect(screen.queryByLabelText('写了哪几份')).not.toBeInTheDocument()
    // 拷完会再探一眼:那几个数可能变了。
    await waitFor(() => expect(s.calls.filter(one => one.includes('/onboarding/memories')).length).toBe(2))
  })

  it('★再点一次:新增与刷新分得开(第二次多半是「新增 1 份、刷新 1 份」)', () => {
    expect(importedLine({
      ok: true,
      note: '拷过来了:Claude 3 份。',
      written: ['docs/记忆/来自-Claude/b.md', 'docs/记忆/来自-Claude/来源.md'],
      added: ['docs/记忆/来自-Claude/b.md'],
    })).toContain('新增 1 份、刷新 1 份')
  })

  it('服务端说没拷(ok:false)就原样显示它那句话,不自己编一句', () => {
    expect(importedLine({ ok: false, note: '没拷:授权表里……是「要问」。', written: [], added: [] }))
      .toBe('没拷:授权表里……是「要问」。')
  })
})

describe('一家那一行怎么写', () => {
  it('整家不拷的照它那句理由写;0 份是「未查到」;有几样没拷的就说几样', () => {
    expect(familyLine({ family: 'claude', label: 'Claude', count: 45, left: [] })).toBe('45 份')
    expect(familyLine({ family: 'kimi', label: 'Kimi', count: 0, left: [] })).toContain('未查到')
    expect(familyLine({ family: 'dsh', label: '工作台', count: 1, left: [], skip: '本来就是它自己的' })).toBe('本来就是它自己的')
    expect(familyLine({ family: 'codex', label: 'Codex', count: 1, left: ['x'] })).toBe('1 份 · 另有 1 样看见了没拷')
  })
})
