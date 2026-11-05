/**
 * 声纹球与两侧卡片堆的纯函数(2026-09-11,docs/设计-事务官完整材料.md §5.1 与附录 A3)。
 *
 * 守四件事:球的四态怎么从 /state 映射出来(优先级写死);球下那一行「在办 n · 等你 m」
 * 数字取不到就整行不显示(不编数);堆最多露 3 张、其余折成「还有 n 件」;卡片上的
 * 状态点(白/黄/蓝/灰)按什么定。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Orb } from '../src/client/Orb.tsx'
import {
  elapsedLabel, foldStack, inboxCard, leftStack, mineCard, orbCounts, orbCountsLine, orbState, proposalCard, rightStack,
  STACK_VISIBLE_MAX,
} from '../src/client/orb.ts'
import { STYLE } from '../src/client/style.ts'
import type { ButlerInboxItem, TaskView, WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)

function state(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: '2026-09-11T09:00:00.000Z', stale: false, ...over }
}

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't1', title: '把展示台的黄历接上', status: 'doing', direction: 'mine', source: { kind: 'manual' },
    created_at: '2026-09-11T01:00:00.000Z', updated_at: '2026-09-11T02:00:00.000Z',
    ...over,
  }
}

function tasksOf(...tasks: TaskView[]) {
  return { tasks, sprints: [], modules: [], project_meta: [] }
}

describe('球的四态映射(优先级:需要你 > 聆听 > 在办 > 待命)', () => {
  it('什么都没有 → 待命', () => {
    expect(orbState({ needsYou: false, listening: false, busy: false })).toBe('idle')
  })
  it('在办 → 在办(缓慢脉动)', () => {
    expect(orbState({ needsYou: false, listening: false, busy: true })).toBe('busy')
  })
  it('输入框聚焦/有字 → 聆听,压过在办', () => {
    expect(orbState({ needsYou: false, listening: true, busy: true })).toBe('listening')
  })
  it('★有「等我确认」的卡 → 需要你(琥珀),压过一切', () => {
    expect(orbState({ needsYou: true, listening: true, busy: true })).toBe('needs-you')
  })
})

describe('球下那一行「在办 n · 等你 m」', () => {
  it('★tasks 或 butler_inbox 任一取不到 → 整行不显示(不编数)', () => {
    expect(orbCounts(state())).toBeUndefined()
    expect(orbCounts(state({ tasks: tasksOf() }))).toBeUndefined()
    expect(orbCounts(state({ butler_inbox: { items: [] } }))).toBeUndefined()
  })
  it('在办 = 我交给事务官且还没办完的;等你 = 收件箱里「等我确认」的', () => {
    const counts = orbCounts(state({
      tasks: tasksOf(task({ id: 'a' }), task({ id: 'b', status: 'done' }), task({ id: 'c', status: 'confirm' })),
      butler_inbox: {
        items: [
          { id: 'confirm:c', kind: 'confirm', title: '甲', status: 'confirm' },
          { id: 'sentinel:w', kind: 'sentinel', title: '乙' },
        ],
      },
    }))
    expect(counts).toEqual({ working: 1, waiting: 1 })
    expect(orbCountsLine({ working: 1, waiting: 1 })).toBe('在办 1 · 等你 1')
  })
})

describe('堆的折叠:最多露 3 张,其余折成「还有 n 件」', () => {
  it('上限是 3', () => {
    expect(STACK_VISIBLE_MAX).toBe(3)
  })
  it('5 件 → 露 3、折 2', () => {
    const folded = foldStack(['a', 'b', 'c', 'd', 'e'])
    expect(folded.shown).toEqual(['a', 'b', 'c'])
    expect(folded.rest).toBe(2)
  })
  it('正好 3 件 → 全露,不折', () => {
    expect(foldStack(['a', 'b', 'c'])).toEqual({ shown: ['a', 'b', 'c'], rest: 0 })
  })
  it('0 件 → 空', () => {
    expect(foldStack([])).toEqual({ shown: [], rest: 0 })
  })
})

describe('卡片状态点(白/黄/蓝/灰)', () => {
  const item = (over: Partial<ButlerInboxItem>): ButlerInboxItem => ({ id: 'x', kind: 'session', title: '改排序', ...over })

  it('等我确认的卡 = 蓝(完成待验收);等着的会话/哨兵/排期 = 黄(要我看一眼)', () => {
    expect(inboxCard(item({ kind: 'confirm', status: 'confirm' })).dot).toBe('blue')
    expect(inboxCard(item({ kind: 'session', wait_reason: 'approval' })).dot).toBe('yellow')
    expect(inboxCard(item({ kind: 'sentinel' })).dot).toBe('yellow')
    expect(inboxCard(item({ kind: 'risk' })).dot).toBe('yellow')
  })
  it('等待原因原样带在卡上', () => {
    expect(inboxCard(item({ kind: 'session', wait_reason: 'approval' })).waitLabel).toBe('等审批')
  })
  it('我交给事务官的:进行中 = 白;阻塞 = 黄 + 原因;待办没开会话 = 灰 + 「会话未开」;办完 = 灰', () => {
    expect(mineCard(task({ status: 'doing', conversation: { agent: 'dsh', session_id: 's' } })).dot).toBe('white')
    const blocked = mineCard(task({ status: 'blocked', block_reason: 'input' }))
    expect(blocked.dot).toBe('yellow')
    expect(blocked.waitLabel).toBe('等你输入')
    const todo = mineCard(task({ status: 'todo' }))
    expect(todo.dot).toBe('gray')
    expect(todo.note).toBe('会话未开')
    expect(mineCard(task({ status: 'done' })).dot).toBe('gray')
  })
  it('卡上那句话(2026-09-16):服务端记的 note 优先——「你停了它」「会话未开」「出错原话」', () => {
    expect(mineCard(task({ status: 'todo', conversation: { agent: 'dsh', session_id: 's' }, note: '你停了它' })).note).toBe('你停了它')
    expect(mineCard(task({ status: 'blocked', block_reason: 'error', conversation: { agent: 'dsh', session_id: 's' }, note: '模型路由不可用' })).note).toBe('模型路由不可用')
    expect(mineCard(task({ status: 'todo', note: '会话未开' })).note).toBe('会话未开')
  })
  it('elapsedLabel:进行中多久了——不到 1 分钟「刚开始」,整分钟,过 1 小时带小时;解析不出不编', () => {
    expect(elapsedLabel('2026-09-11T09:00:00.000Z', '2026-09-11T09:00:30.000Z')).toBe('刚开始')
    expect(elapsedLabel('2026-09-11T08:48:00.000Z', '2026-09-11T09:00:30.000Z')).toBe('12 分钟')
    expect(elapsedLabel('2026-09-11T07:30:00.000Z', '2026-09-11T09:00:30.000Z')).toBe('1 小时 30 分钟')
    expect(elapsedLabel('nope', '2026-09-11T09:00:30.000Z')).toBeUndefined()
    expect(elapsedLabel('2026-09-11T09:00:00.000Z', '')).toBeUndefined()
    expect(elapsedLabel('2026-09-11T09:10:00.000Z', '2026-09-11T09:00:00.000Z')).toBeUndefined()
  })
  it('卡上带项目名(按 project_id 查到才带,查不到不编)', () => {
    expect(mineCard(task({ project_id: 'aiboo' }), [{ id: 'aiboo', name: 'Aiboo' }]).context).toBe('Aiboo')
    expect(mineCard(task({ project_id: 'nope' }), [{ id: 'aiboo', name: 'Aiboo' }]).context).toBeUndefined()
  })
  it('提议 = 灰点 + 「待拍板」', () => {
    const card = proposalCard({
      id: 'p1', layer: 'transaction', module_id: 'projects', text: '给 Aiboo 定个 DDL',
      evidence_days: [], preview: '……', adopted: false,
    })
    expect(card.dot).toBe('gray')
    expect(card.label).toBe('待拍板')
    expect(card.title).toBe('给 Aiboo 定个 DDL')
  })
})

describe('两堆各装什么', () => {
  it('左堆 = 收件箱四档(服务端顺序原样)+ 提议(排在后面)', () => {
    const cards = leftStack(state({
      butler_inbox: { items: [{ id: 'confirm:t1', kind: 'confirm', title: '甲', status: 'confirm' }] },
    }), [{ id: 'p1', layer: 'transaction', module_id: 'm', text: '提一个', evidence_days: [], preview: 'x', adopted: false }])
    expect(cards.map(card => card.title)).toEqual(['甲', '提一个'])
  })
  it('右堆 = 我交给事务官的:在办在前、办完在后;「等我确认」的不在这里(已升到左堆)', () => {
    const cards = rightStack(state({
      tasks: tasksOf(
        task({ id: 'done', status: 'done', updated_at: '2026-09-11T05:00:00.000Z' }),
        task({ id: 'old', status: 'doing', updated_at: '2026-09-11T01:00:00.000Z' }),
        task({ id: 'new', status: 'doing', updated_at: '2026-09-11T03:00:00.000Z' }),
        task({ id: 'confirm', status: 'confirm' }),
      ),
    }))
    expect(cards.map(card => card.id)).toEqual(['new', 'old', 'done'])
  })
})

describe('Orb 组件', () => {
  it('把状态写在 data-state 上,琥珀写在 data-amber 上', () => {
    render(<Orb state="busy" amber={false} />)
    const orb = screen.getByRole('img', { name: /^事务官:/ })
    expect(orb).toHaveAttribute('data-state', 'busy')
    expect(orb).toHaveAttribute('data-amber', 'false')
  })
  it('给了 onClick 就是一颗按钮(纯净模式点球展开)', () => {
    render(<Orb state="idle" amber onClick={() => {}} />)
    expect(screen.getByRole('button', { name: /^事务官:/ })).toHaveAttribute('data-amber', 'true')
  })
  it('★prefers-reduced-motion 时全部静止(样式里有那条媒体查询)', () => {
    expect(STYLE).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*ben-wb__orb[^}]*animation:\s*none/)
  })
  it('四态各有自己的动效或颜色规则(纯 CSS,没有图片)', () => {
    expect(STYLE).toContain('.ben-wb__orb[data-state=listening]')
    expect(STYLE).toContain('.ben-wb__orb[data-state=busy]')
    expect(STYLE).toContain('.ben-wb__orb[data-amber=true]')
    expect(STYLE).not.toMatch(/ben-wb__orb[^}]*url\(/)
  })
})
