import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ModuleHeader } from '../src/client/ModuleBox.tsx'
import { useWidgetReorder } from '../src/client/useWidgetReorder.ts'
import { branchModules, defaultLandscape, landscapeArrangement } from '../src/client/layout.ts'
import type { WorkbenchLayout } from '../src/protocol.ts'

let nextFrame: FrameRequestCallback | undefined
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { nextFrame = callback; return 1 }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn(() => { nextFrame = undefined }))
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const element = this as HTMLElement
    const id = element.dataset.moduleBox ?? element.dataset.landRegion ?? 'body'
    const boxes: Record<string, number[]> = {
      body: [0, 0, 1000, 700], side: [700, 0, 300, 500], deck: [0, 500, 1000, 200],
      projects: [700, 0, 300, 500], usage: [0, 500, 250, 200], quota: [250, 500, 250, 200],
      notes: [500, 500, 250, 200], files: [750, 500, 250, 200],
    }
    const [x = 0, y = 0, width = 0, height = 0] = boxes[id] ?? [0, 0, 0, 0]
    return new DOMRect(x, y, width, height)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); nextFrame = undefined })

function Fixture({ save }: { save: (layout: WorkbenchLayout) => void }) {
  const [layout, setLayout] = useState<WorkbenchLayout>({ modules: [], butler: { corner: 'br', min: false }, landscape: defaultLandscape() })
  const root = useRef<HTMLDivElement>(null)
  useWidgetReorder(root, layout, 'landscape', next => { save(next); setLayout(next) })
  const arrangement = landscapeArrangement(layout)
  const widget = (id: string) => <div key={id} data-module-box={id}>
    <ModuleHeader title={id} headingId={`h-${id}`} draggable={id !== 'projects'} onToggleHidden={() => {}} />
    <input aria-label={`${id} input`} />
  </div>
  return <main className="ben-wb"><div ref={root}>
    <div data-land-region="side">{arrangement.side.map(module => widget(module.id))}</div>
    <div data-land-region="deck">{arrangement.deck.map(module => widget(module.id))}</div>
  </div></main>
}
function header(id: string): HTMLElement { return screen.getByRole('heading', { name: id }).closest<HTMLElement>('.ben-wb__modhead')! }
function move(x: number, y: number, pointerId = 1) {
  fireEvent.pointerMove(document, { pointerId, clientX: x, clientY: y })
  act(() => { const callback = nextFrame; nextFrame = undefined; callback?.(0) })
}

it('moves a preview per animation frame and commits only on release', () => {
  const save = vi.fn()
  render(<Fixture save={save} />)
  fireEvent.pointerDown(header('notes'), { isPrimary: true, button: 0, pointerId: 1, clientX: 520, clientY: 510 })
  move(20, 530)
  expect(document.querySelector('.ben-wb__widget-ghost')).toHaveStyle({ transform: 'translate3d(-500px, 20px, 0)' })
  expect(document.querySelector('.ben-wb__widget-drop')).not.toHaveAttribute('hidden')
  expect(save).not.toHaveBeenCalled()
  fireEvent.pointerUp(document, { pointerId: 1, clientX: 20, clientY: 530 })
  expect(save).toHaveBeenCalledTimes(1)
  expect(landscapeArrangement(save.mock.calls[0]![0] as WorkbenchLayout).deck[0]?.id).toBe('notes')
  expect(document.querySelector('.ben-wb__widget-ghost')).toBeNull()
  expect(header('notes')).toHaveFocus()
})

it('moves from the deck into the sidebar and preserves the portrait branch', () => {
  const save = vi.fn()
  render(<Fixture save={save} />)
  fireEvent.pointerDown(header('notes'), { isPrimary: true, button: 0, pointerId: 1, clientX: 520, clientY: 510 })
  move(800, 300)
  fireEvent.pointerUp(document, { pointerId: 1, clientX: 800, clientY: 300 })
  const next = save.mock.calls[0]![0] as WorkbenchLayout
  expect(landscapeArrangement(next).side.map(module => module.id)).toEqual(['projects', 'notes'])
  expect(branchModules(next, 'portrait')).toEqual([])
})

it.each(['Escape', 'pointercancel', 'blur'])('cancels %s without changing layout or leaving a preview', reason => {
  const save = vi.fn()
  render(<Fixture save={save} />)
  fireEvent.pointerDown(header('notes'), { isPrimary: true, button: 0, pointerId: 1, clientX: 520, clientY: 510 })
  move(20, 530)
  if (reason === 'Escape') fireEvent.keyDown(document, { key: 'Escape' })
  else if (reason === 'pointercancel') fireEvent.pointerCancel(document, { pointerId: 1 })
  else fireEvent(window, new Event('blur'))
  fireEvent.pointerUp(document, { pointerId: 1, clientX: 20, clientY: 530 })
  expect(save).not.toHaveBeenCalled()
  expect(document.querySelector('.ben-wb__widget-ghost')).toBeNull()
  expect(document.querySelector('[data-widget-reordering]')).toBeNull()
})

it('ignores tiny movement, interactive controls, and a different pointer', () => {
  const save = vi.fn()
  render(<Fixture save={save} />)
  fireEvent.pointerDown(header('notes'), { isPrimary: true, button: 0, pointerId: 1, clientX: 520, clientY: 510 })
  move(522, 511)
  expect(document.querySelector('.ben-wb__widget-ghost')).toBeNull()
  move(20, 530, 2)
  fireEvent.pointerUp(document, { pointerId: 1, clientX: 522, clientY: 511 })
  fireEvent.pointerDown(screen.getByRole('button', { name: 'notes 收起' }), { isPrimary: true, button: 0, pointerId: 1, clientX: 520, clientY: 510 })
  move(20, 530)
  fireEvent.pointerUp(document, { pointerId: 1, clientX: 20, clientY: 530 })
  expect(save).not.toHaveBeenCalled()
  expect(document.querySelector('.ben-wb__widget-ghost')).toBeNull()
})

it('removes position arrows while keeping collapse and keyboard access', () => {
  const save = vi.fn()
  render(<Fixture save={save} />)
  expect(screen.queryByRole('button', { name: /上移|下移/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'notes 收起' }).querySelector('svg')).not.toBeNull()
  fireEvent.keyDown(header('usage'), { altKey: true, key: 'ArrowUp' })
  expect(landscapeArrangement(save.mock.calls[0]![0] as WorkbenchLayout).side.map(module => module.id)).toEqual(['projects', 'usage'])
})
