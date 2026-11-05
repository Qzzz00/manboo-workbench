/**
 * 文件拖放归工作台(2026-09-25,卡 fix/shell-web-capabilities)。
 *
 * 维护者 09-24:「我尝试拖拽一些文件,直接显示不支持」。根因:DSH 压在工作台浮层下面、永远挂着的
 * 对话栏(ui-attachment ComposerAttachments)在 document 上挂了整页文件拖放 —— 盖「当前无法添加图片」,
 * 并把 dropEffect 压成 none,工作台输入框收不到文件。见 src/client/fileDropGuard.ts 文件头。
 *
 * 这里测守卫自己的规矩与它在浮层上的开关;**真 WebKit 里**的复现与修复实测在
 * workbench-app/run-web-tests.sh(拖真文件、读网页收到的 dataTransfer.files)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { carriesFiles, installFileDropGuard } from '../src/client/fileDropGuard.ts'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

const DRAG_TYPES = ['dragenter', 'dragover', 'dragleave', 'drop'] as const

/** jsdom 没有 DragEvent / DataTransfer:造一个带 dataTransfer 的普通可取消冒泡事件。 */
function dragEvent(type: string, types: string[]): { event: Event, dataTransfer: { types: string[], dropEffect: string } } {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const dataTransfer = { types, dropEffect: 'uninitialized', files: [] }
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return { event, dataTransfer }
}

/** 上游那套的替身:挂在 document 冒泡阶段,记下看到了什么。 */
function upstreamSpy(): { seen: string[], remove: () => void } {
  const seen: string[] = []
  const listener = (event: Event): void => { seen.push(event.type) }
  for (const type of DRAG_TYPES) document.addEventListener(type, listener)
  return { seen, remove: () => { for (const type of DRAG_TYPES) document.removeEventListener(type, listener) } }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  cleanup()
  document.body.innerHTML = ''
})

describe('守卫本身', () => {
  it('★装上之后,document 上那套(DSH 对话栏的附件)看不到带文件的拖放;拆掉之后照常', () => {
    const upstream = upstreamSpy()
    cleanups.push(upstream.remove)
    const target = document.body.appendChild(document.createElement('div'))
    const uninstall = installFileDropGuard(document)
    for (const type of DRAG_TYPES) target.dispatchEvent(dragEvent(type, ['Files']).event)
    expect(upstream.seen).toEqual([])
    uninstall()
    target.dispatchEvent(dragEvent('dragover', ['Files']).event)
    expect(upstream.seen).toEqual(['dragover'])
  })

  it('★工作台自己的落点(输入框)先接住:它设的「复制进来」原样保留,不被改成 none', () => {
    const zone = document.body.appendChild(document.createElement('div'))
    zone.addEventListener('dragover', (event) => {
      event.preventDefault()
      ;(event as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect = 'copy'
    })
    cleanups.push(installFileDropGuard(document))
    const { event, dataTransfer } = dragEvent('dragover', ['Files'])
    zone.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(dataTransfer.dropEffect).toBe('copy')
  })

  it('没有落点的地方:明确「放不下」(dropEffect none);松手也不让浏览器把文件当网页打开', () => {
    const blank = document.body.appendChild(document.createElement('div'))
    cleanups.push(installFileDropGuard(document))
    const over = dragEvent('dragover', ['Files'])
    blank.dispatchEvent(over.event)
    expect(over.event.defaultPrevented).toBe(true)
    expect(over.dataTransfer.dropEffect).toBe('none')
    const drop = dragEvent('drop', ['Files'])
    blank.dispatchEvent(drop.event)
    expect(drop.event.defaultPrevented).toBe(true)
    // dragenter / dragleave 只拦不改:它们不决定能不能放。
    const enter = dragEvent('dragenter', ['Files'])
    blank.dispatchEvent(enter.event)
    expect(enter.event.defaultPrevented).toBe(false)
    expect(enter.dataTransfer.dropEffect).toBe('uninitialized')
  })

  it('页面内部的拖(看板卡片、标签排序:types 里没有 Files)一个不碰', () => {
    const upstream = upstreamSpy()
    cleanups.push(upstream.remove)
    cleanups.push(installFileDropGuard(document))
    const card = document.body.appendChild(document.createElement('div'))
    const { event, dataTransfer } = dragEvent('dragover', ['text/plain'])
    card.dispatchEvent(event)
    expect(upstream.seen).toEqual(['dragover'])
    expect(event.defaultPrevented).toBe(false)
    expect(dataTransfer.dropEffect).toBe('uninitialized')
  })

  it('carriesFiles:数组与类数组(老 WebKit 的 DOMStringList)都认;没有 dataTransfer 不算', () => {
    expect(carriesFiles({ types: ['text/uri-list', 'Files'] } as unknown as DataTransfer)).toBe(true)
    expect(carriesFiles({ types: { length: 1, 0: 'Files' } } as unknown as DataTransfer)).toBe(true)
    expect(carriesFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false)
    expect(carriesFiles(null)).toBe(false)
    expect(carriesFiles(undefined)).toBe(false)
  })
})

// ── 浮层上的开关 ──

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: '2026-09-25T10:00:00+08:00', stale: false, ...over }
}

function fakeFetch(state: WorkbenchState) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const reply = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
    const miss = (): Response => ({ ok: false, status: 404, json: async () => ({ error: 'x' }) }) as unknown as Response
    if (String(url).includes('/account') || String(url).includes('/first-run')) return miss()
    if (String(url).includes('/config/') || String(url).includes('/setup/')) return miss()
    if (init?.method === 'POST') return reply({ ok: true })
    return reply(state)
  }) as unknown as typeof fetch
}

function overlayProps() {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true,
    recentWorkspaceId: undefined,
  }
  const props: WorkbenchOverlayProps = {
    useStore: selector => selector(instance.getSnapshot()),
    actions: instance.actions,
    useWorkspaces: selector => selector(workspaceState as never),
    useSessions: selector => selector({} as never),
    ...UNUSED_STANDARD_PROPS,
    openWorkspace: async () => {},
    openSession: () => {},
    serviceFetch: fakeFetch(snapshot()),
    servicePollMs: 0,
    serviceWebSocket: (): MinimalWebSocket => ({ onmessage: null, onclose: null, close: () => {} }),
  }
  return { instance, props }
}

describe('工作台浮层上的开关', () => {
  it('★浮层开着:拖文件到工作台上,DSH 对话栏那套收不到(不再整屏盖「当前无法添加图片」)', async () => {
    const upstream = upstreamSpy()
    cleanups.push(upstream.remove)
    const { props } = overlayProps()
    render(<WorkbenchOverlay {...props} />)
    const overlay = await waitFor(() => screen.getByLabelText('工作台'))
    overlay.dispatchEvent(dragEvent('dragenter', ['Files']).event)
    overlay.dispatchEvent(dragEvent('dragover', ['Files']).event)
    expect(upstream.seen).toEqual([])
  })

  it('浮层关了(进了 DSH 原生会话页):守卫拆掉,DSH 自己的拖图照常', async () => {
    const upstream = upstreamSpy()
    cleanups.push(upstream.remove)
    const { instance, props } = overlayProps()
    const view = render(<WorkbenchOverlay {...props} />)
    await waitFor(() => screen.getByLabelText('工作台'))
    instance.actions.close()
    view.rerender(<WorkbenchOverlay {...props} />)
    await waitFor(() => expect(screen.queryByLabelText('工作台')).toBeNull())
    const native = document.body.appendChild(document.createElement('div'))
    native.dispatchEvent(dragEvent('dragover', ['Files']).event)
    expect(upstream.seen).toEqual(['dragover'])
  })

  it('★关了再开:工作台回得来(以前关浮层时 hook 数对不上,React 报错、这一格被换成崩溃占位,再也点不回来)', async () => {
    const { instance, props } = overlayProps()
    const view = render(<WorkbenchOverlay {...props} />)
    await waitFor(() => screen.getByLabelText('工作台'))
    instance.actions.close()
    view.rerender(<WorkbenchOverlay {...props} />)
    await waitFor(() => expect(screen.queryByLabelText('工作台')).toBeNull())
    instance.actions.open()
    view.rerender(<WorkbenchOverlay {...props} />)
    expect(await screen.findByLabelText('工作台')).toBeInTheDocument()
  })
})
