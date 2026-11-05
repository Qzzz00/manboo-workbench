/**
 * 统一输入框(2026-09-24,docs/设计-统一输入框-2026-09-24.md):一个组件、几种裁剪。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../src/client/composer/Composer.tsx'
import {
  TRIMS, atQuery, canSend, dropAtQuery, filterAgents, handLine, isSendKey, itemBody, modeTitle, uploadName, usesSayPath,
  type ComposerDraft,
} from '../src/client/composer/composerModel.ts'
import { BEAM } from '../src/client/fx/fxModel.ts'
import type { ComposerOptionsView } from '../src/protocol.ts'

afterEach(cleanup)

const OPTIONS: ComposerOptionsView = {
  agents: [
    { family: 'dsh', title: '事务官自己', hands: [], ready: true, in_slot: false },
    { family: 'codex', title: 'Codex', hands: [{ hand: 'window', ready: true }, { hand: 'cli', ready: true }], ready: true, in_slot: true },
    { family: 'kimi', title: 'Kimi', hands: [{ hand: 'window', ready: false, why: '这台电脑上没装它' }], ready: false, in_slot: false },
  ],
  modes: [
    { id: 'plan', title: '只出方案', hint: 'a' },
    { id: 'ask', title: '先问我', hint: 'b' },
    { id: 'auto', title: '自动办', hint: 'c' },
  ],
  mode: 'ask',
  models: [
    { provider: 'workbench-relay', id: 'deepseek-v4-flash', title: 'V4 Flash', images: true },
    { provider: 'workbench-relay', id: 'deepseek-v4-pro', title: 'V4 Pro', images: false },
  ],
  model: { provider: 'workbench-relay', id: 'deepseek-v4-flash' },
  recent: [{ kind: 'item', id: 't-1', title: '导出 PDF', note: '在办' }],
}

function fakeFetch() {
  const calls: { url: string, method: string, body: unknown }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace('http://x', '')
    const body = init?.body instanceof Blob ? `blob:${init.body.size}` : init?.body === undefined ? undefined : JSON.parse(String(init.body))
    calls.push({ url: path, method: init?.method ?? 'GET', body })
    if (path === '/composer/options') return { ok: true, status: 200, json: async () => OPTIONS }
    if (path.startsWith('/composer/upload')) {
      const name = decodeURIComponent(path.split('name=')[1] ?? '')
      return { ok: true, status: 200, json: async () => ({ ok: true, id: name, name, type: 'image/png', bytes: 4, image: true }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }) as unknown as typeof fetch
  return { impl, calls }
}

function Harness({ trim = 'butler' as const, onSubmit, fetchImpl }: { trim?: 'butler' | 'onboarding', onSubmit: (d: ComposerDraft) => Promise<boolean>, fetchImpl: typeof fetch }) {
  const [text, setText] = useState('')
  return (
    <Composer
      trim={trim}
      text={text}
      onTextChange={setText}
      onSubmit={async (d) => { const ok = await onSubmit(d); if (ok) setText(''); return ok }}
      fxName="composer"
      fxSpec={BEAM.composer}
      placeholder="有什么事"
      ariaLabel="框"
      sendLabel="发"
      current={{ mode: 'ask', model: { provider: 'workbench-relay', id: 'deepseek-v4-flash', title: 'V4 Flash', images: true } }}
      baseUrl="http://x"
      fetchImpl={fetchImpl}
    />
  )
}

describe('composerModel', () => {
  it('只把无附件/引用/@/显式档或模型的纯文本发到 /say', () => {
    const base: ComposerDraft = { text: '接着聊', attachments: [], refs: [] }
    expect(usesSayPath(base)).toBe(true)
    expect(usesSayPath({ ...base, mode: 'auto' })).toBe(false)
    expect(usesSayPath({ ...base, model: { provider: 'workbench-relay', id: 'm-1' } })).toBe(false)
    expect(usesSayPath({ ...base, agent: { family: 'codex', title: 'Codex' } })).toBe(false)
    expect(usesSayPath({ ...base, refs: [{ kind: 'item', id: 't-1', title: '原件' }] })).toBe(false)
  })
  it('四种裁剪:引导与通话只有文字 + 发送;事务官全套;手机首页全套且胶囊合一、有按住说话', () => {
    expect(TRIMS.onboarding).toEqual({ plus: false, at: false, mode: false, model: false, voice: false, pillsMerged: false })
    expect(TRIMS.call.plus).toBe(false)
    expect(TRIMS.butler).toMatchObject({ plus: true, at: true, mode: true, model: true, voice: false })
    expect(TRIMS['phone-home']).toMatchObject({ plus: true, at: true, mode: true, model: true, voice: true, pillsMerged: true })
  })

  it('isSendKey:回车发,Shift 换行,输入法合成中不发', () => {
    expect(isSendKey({ key: 'Enter', shiftKey: false })).toBe(true)
    expect(isSendKey({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(isSendKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
    expect(isSendKey({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false)
  })

  it('atQuery:行首或空白后的 @ 才算;dropAtQuery 拿掉那一段', () => {
    expect(atQuery('让 @co', 5)).toEqual({ start: 2, query: 'co' })
    expect(atQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(atQuery('mail@x', 6)).toBeUndefined()
    expect(atQuery('@co 做', 6)).toBeUndefined()
    expect(dropAtQuery('让 @co', 2, 5)).toBe('让 ')
  })

  it('filterAgents + handLine', () => {
    expect(filterAgents(OPTIONS.agents, 'cod').map(one => one.family)).toEqual(['codex'])
    expect(handLine(OPTIONS.agents[1]!)).toBe('窗口 · 后台(备用)')
    expect(handLine(OPTIONS.agents[2]!)).toBe('这台电脑上没装它')
    expect(handLine(OPTIONS.agents[0]!)).toBe('不 @ 就是它')
  })

  it('canSend:有字或有传好的附件;还在传就不发', () => {
    expect(canSend({ text: '', attachments: [], refs: [] })).toBe(false)
    expect(canSend({ text: 'a', attachments: [], refs: [] })).toBe(true)
    expect(canSend({ text: '', attachments: [{ key: 'k', name: 'a', image: true, view: { id: 'a', name: 'a', type: '', bytes: 1, image: true } }], refs: [] })).toBe(true)
    expect(canSend({ text: 'a', attachments: [{ key: 'k', name: 'a', image: true }], refs: [] })).toBe(false)
  })

  it('itemBody:只带有的;交给事务官自己不带 assignee', () => {
    expect(itemBody({ text: ' 做 ', attachments: [], refs: [] }, { orientation: 'portrait' })).toEqual({ text: '做', orientation: 'portrait' })
    expect(itemBody({
      text: '做',
      agent: { family: 'codex', title: 'Codex' },
      attachments: [{ key: 'k', name: 'a.png', image: true, view: { id: 'a.png', name: 'a.png', type: 'image/png', bytes: 1, image: true } }, { key: 'e', name: 'b', image: false, error: 'x' }],
      refs: [{ kind: 'item', id: 't-1', title: 'x' }],
    })).toEqual({ text: '做', assignee: 'codex', attachments: [{ id: 'a.png' }], refs: [{ kind: 'item', id: 't-1' }] })
    expect(itemBody({ text: '做', agent: { family: 'dsh', title: '事务官自己' }, attachments: [], refs: [] })).toEqual({ text: '做' })
  })

  it('modeTitle 与 uploadName', () => {
    expect(modeTitle(undefined, undefined)).toBe('先问我')
    expect(modeTitle(OPTIONS, 'plan')).toBe('只出方案')
    expect(uploadName({ name: 'image.png', type: 'image/png' }, new Date('2026-09-24T10:11:12Z'))).toBe('截图-20260924-101112.png')
    expect(uploadName({ name: '需求.pdf', type: 'application/pdf' })).toBe('需求.pdf')
  })
})

describe('Composer', () => {
  it('引导裁剪:没有 +、@、模式、模型;回车发', async () => {
    const { impl } = fakeFetch()
    const onSubmit = vi.fn(async () => true)
    render(<Harness trim="onboarding" onSubmit={onSubmit} fetchImpl={impl} />)
    expect(screen.queryByRole('button', { name: '添加' })).toBeNull()
    expect(screen.queryByRole('button', { name: /模式/ })).toBeNull()
    await userEvent.type(screen.getByLabelText('框'), '我叫 Ben{Enter}')
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: '我叫 Ben' }))
  })

  it('事务官裁剪:胶囊上写当前的档与模型;挂载时不发任何请求(菜单点开才拉)', () => {
    const { impl } = fakeFetch()
    render(<Harness onSubmit={async () => true} fetchImpl={impl} />)
    expect(screen.getByRole('button', { name: '模式:先问我' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '模型:deepseek-v4-flash' })).toHaveTextContent('V4 Flash')
    expect(impl).not.toHaveBeenCalled()
  })

  it('打 @ → 现拉候选 → 选 Codex → 成一枚片,正文里的 @ 拿掉;发出去带 assignee', async () => {
    const { impl, calls } = fakeFetch()
    const submitted: ComposerDraft[] = []
    render(<Harness onSubmit={async (d) => { submitted.push(d); return true }} fetchImpl={impl} />)
    await userEvent.type(screen.getByLabelText('框'), '把导出做了 @co')
    await waitFor(() => expect(calls.some(c => c.url === '/composer/options')).toBe(true))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Codex/ }))
    expect(screen.getByText('@Codex')).toBeInTheDocument()
    expect((screen.getByLabelText('框') as HTMLTextAreaElement).value).toBe('把导出做了 ')
    await userEvent.click(screen.getByRole('button', { name: '发' }))
    expect(itemBody(submitted[0]!)).toMatchObject({ text: '把导出做了', assignee: 'codex' })
  })

  it('候选里用不了的那家灰着、写原因', async () => {
    const { impl } = fakeFetch()
    render(<Harness onSubmit={async () => true} fetchImpl={impl} />)
    await userEvent.click(screen.getByRole('button', { name: '交给谁' }))
    const kimi = await screen.findByRole('menuitem', { name: /Kimi/ })
    expect(kimi).toHaveAttribute('data-ready', 'false')
    expect(kimi).toHaveTextContent('这台电脑上没装它')
  })

  it('粘贴图片 → 上传 → 片;发出去带 attachments,成功后片清掉', async () => {
    const { impl, calls } = fakeFetch()
    const submitted: ComposerDraft[] = []
    render(<Harness onSubmit={async (d) => { submitted.push(d); return true }} fetchImpl={impl} />)
    const file = new File(['PNG!'], 'shot.png', { type: 'image/png' })
    fireEvent.paste(screen.getByLabelText('框'), { clipboardData: { files: { length: 1, item: () => file } } })
    await waitFor(() => expect(calls.some(c => c.url.startsWith('/composer/upload?name=shot.png'))).toBe(true))
    expect(await screen.findByText('shot.png')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '发' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: '发' }))
    expect(itemBody(submitted[0]!)).toEqual({ text: '', attachments: [{ id: 'shot.png' }] })
    await waitFor(() => expect(screen.queryByText('shot.png')).toBeNull())
  })

  it('拖进来一个文件 → 同样上传成片', async () => {
    const { impl, calls } = fakeFetch()
    const { container } = render(<Harness onSubmit={async () => true} fetchImpl={impl} />)
    const file = new File(['%PDF'], '需求.pdf', { type: 'application/pdf' })
    const root = container.querySelector('.wb-cmp') as HTMLElement
    const over = { types: ['Files'], files: { length: 1, item: () => file }, dropEffect: 'uninitialized' }
    fireEvent.dragOver(root, { dataTransfer: over })
    expect(root).toHaveAttribute('data-dragging', 'true')
    // 明说「复制进来」:不写的话壳(WebKit)按 Finder 给的操作挑成「移动」,光标上没有绿色加号(真引擎实测)。
    expect(over.dropEffect).toBe('copy')
    fireEvent.drop(root, { dataTransfer: { types: ['Files'], files: { length: 1, item: () => file } } })
    await waitFor(() => expect(calls.some(c => c.url.startsWith('/composer/upload'))).toBe(true))
    expect(root).toHaveAttribute('data-dragging', 'false')
  })

  it('「+」里有四样;引用一个事项 → 片;发出去带 refs', async () => {
    const { impl } = fakeFetch()
    const submitted: ComposerDraft[] = []
    render(<Harness onSubmit={async (d) => { submitted.push(d); return true }} fetchImpl={impl} />)
    await userEvent.click(screen.getByRole('button', { name: '添加' }))
    const items = screen.getAllByRole('menuitem').map(one => one.textContent)
    expect(items.map(t => t?.split(/[也把在]/)[0])).toEqual(['加文件 / 图片', '引用一个事项或项目', '录音 / 会议', '指定谁来办'])
    await userEvent.click(screen.getByRole('menuitem', { name: /引用一个事项或项目/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /导出 PDF/ }))
    expect(screen.getByText('# 导出 PDF')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('框'), '接着做{Enter}')
    expect(itemBody(submitted[0]!)).toMatchObject({ refs: [{ kind: 'item', id: 't-1' }] })
  })

  it('换档 → POST /composer/choice(记成默认),胶囊立刻变', async () => {
    const { impl, calls } = fakeFetch()
    const submitted: ComposerDraft[] = []
    render(<Harness onSubmit={async (draft) => { submitted.push(draft); return true }} fetchImpl={impl} />)
    await userEvent.click(screen.getByRole('button', { name: '模式:先问我' }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /自动办/ }))
    expect(calls.find(c => c.url === '/composer/choice')?.body).toEqual({ mode: 'auto' })
    expect(screen.getByRole('button', { name: '模式:自动办' })).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('框'), '接着派这件{Enter}')
    expect(submitted[0]).toMatchObject({ mode: 'auto' })
    expect(itemBody(submitted[0]!)).toMatchObject({ mode: 'auto' })
  })

  it('换模型 → 列的是模型名,选了记成默认', async () => {
    const { impl, calls } = fakeFetch()
    const submitted: ComposerDraft[] = []
    render(<Harness onSubmit={async (draft) => { submitted.push(draft); return true }} fetchImpl={impl} />)
    await userEvent.click(screen.getByRole('button', { name: '模型:deepseek-v4-flash' }))
    const pro = await screen.findByRole('menuitemradio', { name: /deepseek-v4-pro/ })
    expect(pro).toHaveTextContent('只看文字')
    await userEvent.click(pro)
    expect(calls.find(c => c.url === '/composer/choice')?.body).toEqual({ model: { provider: 'workbench-relay', id: 'deepseek-v4-pro' } })
    // 新一轮提交继续带本次明确选择的模型，旧的 /butler/item 消费路由据此保留。
    await userEvent.type(screen.getByLabelText('框'), '用这个模型{Enter}')
    expect(submitted[0]?.model).toEqual({ provider: 'workbench-relay', id: 'deepseek-v4-pro' })
    expect(itemBody(submitted[0]!)).toMatchObject({ model: { provider: 'workbench-relay', id: 'deepseek-v4-pro' } })
  })

  it('没接住(onSubmit 回 false)→ 片留着', async () => {
    const { impl } = fakeFetch()
    render(<Harness onSubmit={async () => false} fetchImpl={impl} />)
    await userEvent.click(screen.getByRole('button', { name: '交给谁' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Codex/ }))
    await userEvent.type(screen.getByLabelText('框'), '做{Enter}')
    await act(async () => {})
    expect(screen.getByText('@Codex')).toBeInTheDocument()
  })

  it('自定义名片在 @ 候选展示专属名称,未就绪时不诱导发送', async () => {
    const cardAgent = {
      family: 'kimi' as const,
      title: '小K',
      hands: [{ hand: 'cli' as const, ready: false, why: '名片分派待公共接线' }],
      ready: false,
      in_slot: false,
    }
    const filtered = filterAgents([cardAgent], '小K')
    expect(filtered).toHaveLength(1)
    expect(handLine(cardAgent)).toBe('名片分派待公共接线')
  })

  it('未就绪候选(ready: false): canSend禁发, itemBody不带assignee, 按钮disabled, 回车/点击均不发起请求并亮why', async () => {
    // 1. canSend 纯函数守卫
    const unreadyDraft: ComposerDraft = {
      text: '整理代码',
      agent: { family: 'kimi', title: '小K', ready: false, why: '名片分派待公共接线' },
      attachments: [],
      refs: [],
    }
    expect(canSend(unreadyDraft)).toBe(false)
    expect(itemBody(unreadyDraft)).toEqual({ text: '整理代码' }) // 绝不带 assignee: 'kimi'

    const readyDraft: ComposerDraft = {
      text: '整理代码',
      agent: { family: 'codex', title: 'Codex', ready: true },
      attachments: [],
      refs: [],
    }
    expect(canSend(readyDraft)).toBe(true)
    expect(itemBody(readyDraft)).toEqual({ text: '整理代码', assignee: 'codex' })

    // 2. 组件交互守卫: 点击未就绪候选、按钮禁用、点击与 Enter 均不触发 onSubmit
    const onSubmit = vi.fn(async () => true)
    const { impl } = fakeFetch()
    render(<Harness onSubmit={onSubmit} fetchImpl={impl} />)

    // 点开 @ 菜单
    await userEvent.click(screen.getByRole('button', { name: '交给谁' }))
    // OPTIONS 里 Kimi 的 ready 是 false (why: '这台电脑上没装它')
    const kimiItem = await screen.findByRole('menuitem', { name: /Kimi/ })
    await userEvent.click(kimiItem)

    // 选中未就绪候选后:
    // (a) 提示信息呈现
    expect(screen.getByText('这台电脑上没装它')).toBeInTheDocument()
    // (b) 发送按钮真实 disabled
    const sendBtn = screen.getByRole('button', { name: '发' })
    expect(sendBtn).toBeDisabled()

    // (c) 尝试点击发送按钮 -> 无任何 onSubmit 调用
    fireEvent.click(sendBtn)
    expect(onSubmit).not.toHaveBeenCalled()

    // (d) 在输入框键入文本后按 Enter -> 拦截, 无 onSubmit 调用
    const input = screen.getByLabelText('框')
    await userEvent.type(input, '帮我看下这个{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()

    // (e) 切回已就绪候选 (Codex) -> 按钮恢复可用, 回车发送成功
    await userEvent.click(screen.getByRole('button', { name: /交给谁/ }))
    const codexItem = await screen.findByRole('menuitem', { name: /Codex/ })
    await userEvent.click(codexItem)
    expect(sendBtn).not.toBeDisabled()
    await userEvent.type(input, '{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

describe('ApprovalRows:「先问我」的批准在档上点', async () => {
  const { ApprovalRows } = await import('../src/client/composer/ApprovalRows.tsx')
  it('一条都没有 → 不渲染', () => {
    const { container } = render(<ApprovalRows approvals={[]} baseUrl="http://x" fetchImpl={fakeFetch().impl} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('允许这一次 → POST /approvals/answer {allow:true};回执说一句', async () => {
    const { impl, calls } = fakeFetch()
    const onReceipt = vi.fn()
    render(<ApprovalRows approvals={[{ id: 'a-1', session_id: 's', task_id: 't-1', task_title: '改 hosts', tool: 'bash', reason: '要写 /etc/hosts', at: 'x' }]} baseUrl="http://x" fetchImpl={impl} onReceipt={onReceipt} />)
    expect(screen.getByText('「改 hosts」要你批一件事')).toBeInTheDocument()
    expect(screen.getByText('要写 /etc/hosts')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '允许这一次' }))
    expect(calls).toEqual([{ url: '/approvals/answer', method: 'POST', body: { id: 'a-1', allow: true } }])
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith('批了,接着办'))
  })
})
