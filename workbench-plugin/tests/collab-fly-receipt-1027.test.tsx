// 真实回执飞线(2026-10-27,合并稿 7.1):只认任务账里新到的一条回执(谁交回、几点),
// 从执行者头像的实际位置飞到那件事项的卡,只飞一次;两头有一头看不见就不飞;减少动态效果时不飞。
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import type { TaskView } from '../src/protocol.ts'
import { receiptFlights } from '../src/client/collab/flyModel.ts'
import { FlyLayer } from '../src/client/collab/FlyLayer.tsx'

const AT = '2026-10-27T10:00:00.000Z'
const task = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: id, status: 'doing', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })
const receipt = (at: string, by?: string) => ({ kind: 'done' as const, text: '做完了', at, ...(by === undefined ? {} : { by }) })

describe('receiptFlights', () => {
  it('第一份快照不飞(那是旧账,不是此刻发生的)', () => {
    expect(receiptFlights(undefined, [task('t1', { receipt: receipt(AT, 'codex') })])).toEqual([])
  })
  it('★同一件事项来了一条新回执(时刻变了)→ 一条,从交回的那一家飞向这件', () => {
    const prev = [task('t1')]
    const next = [task('t1', { receipt: receipt('2026-10-27T10:05:00.000Z', 'codex') })]
    expect(receiptFlights(prev, next)).toEqual([{ key: 't1@2026-10-27T10:05:00.000Z', taskId: 't1', from: 'codex' }])
  })
  it('回执没变、没写谁交回、或是新冒出来的事项:不飞', () => {
    const same = [task('t1', { receipt: receipt(AT, 'codex') })]
    expect(receiptFlights(same, same)).toEqual([])
    expect(receiptFlights([task('t1')], [task('t1', { receipt: receipt(AT) })])).toEqual([])
    expect(receiptFlights([], [task('t2', { receipt: receipt(AT, 'codex') })])).toEqual([])
  })
})

describe('FlyLayer', () => {
  let reduce = false
  beforeEach(() => {
    reduce = false
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') ? reduce : false, media: q, addEventListener() {}, removeEventListener() {} }))
    // jsdom 没有排版:给头像与卡一个真实的位置,其余元素当作看不见。
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
      return ((this as HTMLElement).dataset?.flyFrom !== undefined || (this as HTMLElement).dataset?.noteId !== undefined ? [{}] : []) as unknown as DOMRectList
    })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const el = this as HTMLElement
      const r = el.dataset?.flyFrom !== undefined ? { left: 10, top: 10, width: 20, height: 20 } : el.dataset?.noteId !== undefined ? { left: 300, top: 200, width: 100, height: 60 } : { left: 0, top: 0, width: 0, height: 0 }
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} } as DOMRect
    })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  function stage(withPerson = true) {
    const root = createRef<HTMLDivElement>()
    const Board = ({ tasks }: { tasks: TaskView[] }) => (
      <div ref={root}>
        {withPerson && <button data-fly-from="codex">Codex</button>}
        <div data-note-id="t1">t1</div>
        <FlyLayer tasks={tasks} root={root} />
      </div>
    )
    return Board
  }
  const fresh = [task('t1', { receipt: receipt('2026-10-27T10:05:00.000Z', 'codex') })]

  it('★新回执到:画一条飞线,起点在头像中心、终点在卡中心;动画完了自己收掉;同一条不再飞', async () => {
    vi.useFakeTimers()
    const Board = stage()
    const view = render(<Board tasks={[task('t1')]} />)
    view.rerender(<Board tasks={fresh} />)
    const fly = document.querySelector<HTMLElement>('.ben-cl__fly')
    expect(fly).not.toBeNull()
    expect(fly).toHaveAttribute('data-task', 't1')
    expect(fly!.style.getPropertyValue('--fly-x0')).toBe('20px')
    expect(fly!.style.getPropertyValue('--fly-y1')).toBe('230px')
    // 下一份快照(每秒一份)照常来,不能把收线的定时器取消掉。
    view.rerender(<Board tasks={[...fresh]} />)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(document.querySelector('.ben-cl__fly')).toBeNull()
    view.rerender(<Board tasks={[...fresh]} />)
    expect(document.querySelector('.ben-cl__fly')).toBeNull()
    vi.useRealTimers()
  })
  it('★减少动态效果:不飞', () => {
    reduce = true
    const Board = stage()
    const view = render(<Board tasks={[task('t1')]} />)
    view.rerender(<Board tasks={fresh} />)
    expect(document.querySelector('.ben-cl__fly')).toBeNull()
  })
  it('头像不在板上(成员那排收起、或这一家没上板):不飞,不补播', () => {
    const Board = stage(false)
    const view = render(<Board tasks={[task('t1')]} />)
    view.rerender(<Board tasks={fresh} />)
    expect(document.querySelector('.ben-cl__fly')).toBeNull()
  })
})
