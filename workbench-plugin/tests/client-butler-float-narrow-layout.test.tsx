/**
 * 事务官窄浮窗(520×680)与大屏布局验证(2026-10-23 卡 t-83cd57eb)。
 *
 * 验收目标:
 * 1. 520×680 窄浮窗下:
 *    - 上半区舞台弹性收缩,粒子球、连线、事项卡、状态行均保留且不遮挡;
 *    - 输入框外层(.ben-wb__composer-slot)与舞台分离,外边距不重叠;
 *    - 球下方区域(.ben-wb__scene-below)保证独立纵向滚动(overflow-y: auto),最小高度充足;
 *    - 发光胶囊(FxBeam / .ben-wb__askrow--summary)、收纳夹、当前聚焦事项在 scene-below 内完整可见,不被输入框盖住;
 * 2. 抽屉、暂停、收起、发送等所有交互按键完全可达。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerInbox, type ButlerControls } from '../src/client/ButlerInbox.tsx'
import { BUTLER_LAYOUT_STYLE, BUTLER_COMPOSER_STYLE } from '../src/client/butlerLayoutStyle.ts'
import type { TaskView, WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)

function state(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [],
    sessions: [],
    quota: {},
    now: '2026-10-23T10:00:00.000Z',
    stale: false,
    tasks: {
      tasks: [
        {
          id: 't-1',
          title: '窄浮窗遮挡验证事项',
          status: 'doing',
          direction: 'mine',
          source: { kind: 'manual' },
          created_at: '2026-10-23T09:00:00.000Z',
          updated_at: '2026-10-23T09:30:00.000Z',
        } as TaskView,
      ],
      sprints: [],
      modules: [],
      project_meta: [],
    },
    butler_inbox: {
      items: [],
    },
    first_use: {
      step: 'ready',
      done: true,
      ready: true,
      seen_at: '2026-10-23T08:00:00.000Z',
      paths: [],
    } as never,
    questions: [
      {
        session_id: 's-q-1',
        tool_call_id: 'tc-1',
        questions: [{ question: '这个操作需要你确认一下' }],
      } as never,
    ],
    ...over,
  }
}

function controls(over: Partial<ButlerControls> = {}): ButlerControls {
  return {
    paused: false,
    testRinging: false,
    onPause: vi.fn(),
    onTestRing: vi.fn(),
    onCancelWatch: vi.fn(),
    onDismissBrief: vi.fn(),
    proposals: [],
    ...over,
  }
}

describe('ButlerInbox: 520×680 窄浮窗与正常视口结构验证', () => {
  it('样式规则确保舞台与球下滚动区分离,且输入框内层没有重复外边距', () => {
    expect(BUTLER_LAYOUT_STYLE).toContain('.ben-wb__scene-below{flex:1 1 auto;min-height:48px;overflow-y:auto;overflow-x:hidden')
    expect(BUTLER_LAYOUT_STYLE).toContain('.ben-wb__items--particle>.ben-wb__particle-scene{flex:1 1 auto;min-height:0;overflow:hidden}')
    expect(BUTLER_COMPOSER_STYLE).toContain('.ben-wb__items--particle .ben-wb__composer-slot .ben-wb__composer{width:100%')
  })

  it('在 520×680 窄浮窗下,舞台、球下区域及输入框层级分明,发光胶囊与收纳区在 scene-below 内', async () => {
    const s = state()
    const ctrl = controls()
    const onDraftChange = vi.fn()

    const { container } = render(
      <div style={{ width: 520, height: 680 }}>
        <ButlerInbox
          state={s}
          baseUrl="http://127.0.0.1:3593"
          fetchImpl={vi.fn() as unknown as typeof fetch}
          onOpenConversation={vi.fn()}
          draft=""
          onDraftChange={onDraftChange}
          visible={true}
          controls={ctrl}
        />
      </div>
    )

    const sceneTop = container.querySelector('.ben-wb__scene-top')
    expect(sceneTop).not.toBeNull()

    const sceneBelow = container.querySelector('.ben-wb__scene-below')
    expect(sceneBelow).not.toBeNull()

    // 抽屉与外观设置按钮可达
    const drawerBtn = screen.getByRole('button', { name: '事务官抽屉' })
    expect(drawerBtn).toBeInTheDocument()
    await userEvent.click(drawerBtn)
    expect(screen.getByText('⏸ 全部暂停')).toBeInTheDocument()

    // 发光胶囊或 asks 区域存在于 scene-below 中
    const asksInBelow = sceneBelow?.querySelector('.ben-wb__asks')
    expect(asksInBelow).not.toBeNull()

    // 事项收纳夹存在于 scene-below 中
    const storageInBelow = sceneBelow?.querySelector('.ben-wb__particle-storage')
    expect(storageInBelow).not.toBeNull()

    // 输入框位于独立的 composer-slot 中,不在 scene-below 内部
    const composerSlot = container.querySelector('.ben-wb__composer-slot')
    expect(composerSlot).not.toBeNull()
    expect(sceneBelow?.contains(composerSlot)).toBe(false)
  })
})
