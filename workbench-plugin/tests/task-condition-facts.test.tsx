import React from 'react'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { GoalBoardSummary } from '../src/protocol.ts'
import { GOAL_CONDITION_TITLES } from '../src/client/collab/collabContract.ts'
import * as scene from '../src/client/ButlerScene.tsx'

afterEach(cleanup)
it('红例3：退回后消费 B 正式回退事实，旧交付响应不能盖回当前轮', async () => {
  let state = 'delivered'
  const api = { post: async () => ({ ok: true, body: {} }), get: async <T,>() => ({ summary: {
    goal_id: 'g-one', conditions: { items: [{ id: 'c-one', task_id: 't-one', text: '真实闭环', state }] },
  } as GoalBoardSummary }) as T }
  const { rerender } = render(<scene.TaskConditionFacts taskId="t-one" goalId="g-one" revision="round-1" api={api} />)
  await screen.findByText(GOAL_CONDITION_TITLES.delivered)
  state = 'rework'
  rerender(<scene.TaskConditionFacts taskId="t-one" goalId="g-one" revision="round-2" api={api} />)
  await screen.findByText(GOAL_CONDITION_TITLES.rework)
  await waitFor(() => expect(screen.queryByText(GOAL_CONDITION_TITLES.delivered)).toBeNull())
})
