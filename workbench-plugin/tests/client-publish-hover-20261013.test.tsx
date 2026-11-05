/**
 * 发布计划:悬浮在某一条上看到相关内容(2026-10-13,卡「演示 · 座机一句话记发布计划」)。
 *
 * 维护者 10-12 晚:「悬浮上去就能看到相关内容」。钉四件:
 *   ① 那几行是从卡上**现有的字段**拼的(标题 / 内容形式 / 账号 / 发没发 / 原话 / 来源),缺的那一行整行不出现(D13);
 *   ② 原话与来源的存法只有一处(`protocol.ts` 的 `publishPlanDescOf` 写、`publishPlanDescParts` 读);
 *   ③ 鼠标移上去那一块出现、移开就收,**是这一格的孩子**(不铺整屏,同 10-12 那张卡的规矩);
 *   ④ `title=` 那个原生提示与它说的是同一份内容(鼠标之外的那条路)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { publishPlanDescOf } from '../src/protocol.ts'
import { publishHoverOf, publishHoverText } from '../src/client/PublishModule.tsx'
import { starterWidget } from './helpers/starterLayer.ts'

// 2026-10-21:这几格搬进了用户层(`user-layer/起步/小组件/`),经本体的加载口装出来。
const PublishModule = starterWidget('publish')

afterEach(cleanup)

const BOX = { id: 'publish', title: '发布计划', basisPct: 30, dragging: false, onResizeStart: () => {}, onResizeMove: () => {}, onResizeEnd: () => {} }
const NOON_1013 = new Date(2026, 9, 13, 12, 0).toISOString()
const SAID = '计划 18 号发一个关于秋天穿搭的视频'

function plan(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-1',
    title: '秋天穿搭的视频',
    desc: publishPlanDescOf({ said: SAID, from: '电话', at: new Date(2026, 9, 12, 19, 30) }),
    status: 'todo',
    kind: 'topic',
    content_type: '视频',
    planned_at: '2026-10-18',
    direction: 'mine',
    origin: 'user',
    source: { kind: 'manual' },
    created_at: '2026-10-12T11:30:00.000Z',
    updated_at: '2026-10-12T11:30:00.000Z',
    ...over,
  } as TaskView
}

describe('悬浮那几行怎么拼', () => {
  it('★标题 / 内容形式 · 账号 · 待发布 / 原话 / 来源', () => {
    const view = publishHoverOf(plan({ project_id: 'p-1' }), { account: '露营账号' })
    expect(view.title).toBe('秋天穿搭的视频')
    expect(view.meta).toBe('视频 · 露营账号 · 待发布 2026-10-18')
    expect(view.said).toBe(SAID)
    expect(view.source).toBe('电话 10-12 19:30')
    expect(publishHoverText(view)).toContain('来源:电话 10-12 19:30')
  })

  it('★她自己在日历上填的那几条没有原话与来源 —— 那两行整行不出现,不编', () => {
    const noDesc = plan()
    delete (noDesc as { desc?: unknown }).desc
    expect(publishHoverOf(noDesc).said).toBeUndefined()
    expect(publishHoverOf(noDesc).source).toBeUndefined()
    // 老卡的 desc 是一段普通备注(没有来源那一行):整段当备注读
    expect(publishHoverOf(plan({ desc: '记得带三脚架' })).said).toBe('记得带三脚架')
    expect(publishHoverOf(plan({ desc: '记得带三脚架' })).source).toBeUndefined()
  })

  it('发过的那一条按实际发布日说', () => {
    expect(publishHoverOf(plan({ published_at: '2026-10-19' })).meta).toBe('视频 · 已发布 2026-10-19')
  })
})

describe('月历上悬浮', () => {
  function paint(tasks: readonly TaskView[]) {
    return render(
      <PublishModule
        box={BOX} header={<h3 id="p">发布计划</h3>} headingId="p"
        baseUrl="http://127.0.0.1:8791" fetchImpl={fetch} tasks={tasks} now={NOON_1013} projects={[{ id: 'p-1', name: '露营账号' }]}
      />,
    )
  }

  it('★鼠标移到那一条上:标题、是什么、原话、来源都看得到;移开就收', () => {
    paint([plan({ project_id: 'p-1' })])
    const chip = document.querySelector('.cp-chip') as HTMLElement
    expect(chip).not.toBeNull()
    expect(document.querySelector('.cp-hover')).toBeNull()
    act(() => { fireEvent.mouseOver(chip) })
    const card = screen.getByRole('note', { name: '这一条的详情' })
    expect(card.textContent).toContain('秋天穿搭的视频')
    expect(card.textContent).toContain('视频 · 露营账号 · 待发布 2026-10-18')
    expect(card.textContent).toContain(SAID)
    expect(card.textContent).toContain('来源:电话 10-12 19:30')
    // 这一块是这一格的孩子,不是铺在整屏上的层
    expect(document.querySelector('.ben-wb__publish-card')).toContainElement(card)
    act(() => { fireEvent.mouseOut(chip) })
    expect(document.querySelector('.cp-hover')).toBeNull()
  })

  it('★`title=` 那个原生提示说的是同一份内容(鼠标之外的那条路)', () => {
    paint([plan({ project_id: 'p-1' })])
    const chip = document.querySelector('.cp-chip') as HTMLElement
    expect(chip.getAttribute('title')).toBe(publishHoverText(publishHoverOf(plan({ project_id: 'p-1' }), { account: '露营账号' })))
  })

  it('悬浮那一块不是 position:fixed(10-12 那张卡的规矩没破)', () => {
    paint([plan()])
    const css = [...document.querySelectorAll('style')].map(node => node.textContent ?? '').join('\n')
    expect(css).toContain('.cp-hover{position:absolute')
    expect(css).not.toContain('position:fixed')
  })
})
