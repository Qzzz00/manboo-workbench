// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  reduceExecution,
  restoreExecution,
  waitUserExecution,
  EXECUTION_PHASES,
  TERMINAL_PHASES,
  type ExecutionRecord,
} from '../src/server/taskExecution.ts'

const running = (): ExecutionRecord => ({
  taskId: 't-fixture', version: 4, planVersion: 2,
  attemptId: 'attempt-2', phase: 'running',
  next: { kind: 'observe', reason: 'await_result', wakeAt: 1000 },
})

describe('execution responsibility', () => {
  it('ignores a late receipt from a previous attempt', () => {
    const current = running()
    expect(reduceExecution(current, {
      kind: 'returned', attemptId: 'attempt-1', planVersion: 1, receiptId: 'old',
    })).toEqual(current)
  })
  it('keeps missing evidence with the system for recovery', () => {
    const next = reduceExecution(running(), {
      kind: 'verification_missing', attemptId: 'attempt-2', planVersion: 2,
      reason: 'missing_test_output',
    })
    expect(next.phase).toBe('recovering')
    expect(next.next?.kind).toBe('recover')
    expect(next.next?.reason).toBe('missing_test_output')
  })
  it('does not treat an execution receipt as delivered', () => {
    const next = reduceExecution(running(), {
      kind: 'returned', attemptId: 'attempt-2', planVersion: 2, receiptId: 'new',
    })
    expect(next.phase).toBe('verifying')
    expect(next.next?.kind).toBe('verify')
  })
})

describe('执行身份与恢复记录(第一批第 1 步补的红例)', () => {
  it('取消后旧计划不再出新动作:同版本 cancel → canceled 且无 next;迟到的旧版本 cancel 原样忽略', () => {
    const canceled = reduceExecution(running(), { kind: 'cancel_requested', planVersion: 2 })
    expect(canceled.phase).toBe('canceled')
    expect(canceled.next).toBeNull()
    // 已取消的记录不再被任何迟到事实推回推进中。
    const late = reduceExecution(canceled, { kind: 'returned', attemptId: 'attempt-2', planVersion: 2, receiptId: 'new' })
    expect(late).toEqual(canceled)
    // 指向旧计划的 cancel 不能取消当前计划。
    const current = running()
    expect(reduceExecution(current, { kind: 'cancel_requested', planVersion: 1 })).toEqual(current)
  })

  it('next=null 只在 delivered / canceled;结果不明一律带 reconcile 动作', () => {
    for (const phase of EXECUTION_PHASES) {
      const record: ExecutionRecord = {
        taskId: 't-fixture', version: 1, planVersion: 1, attemptId: null, phase, next: null,
      }
      const restored = restoreExecution(record)
      if ((TERMINAL_PHASES as readonly string[]).includes(phase)) {
        expect(restored.next).toBeNull()
        expect(restored.phase).toBe(phase)
      } else {
        expect(restored.phase).toBe('reconciling')
        expect(restored.next?.kind).toBe('reconcile')
      }
    }
  })

  it('等待本人带 ask 且 reason 写清决定对象', () => {
    const next = waitUserExecution(running(), 'confirm_budget_increase')
    expect(next.phase).toBe('waiting_user')
    expect(next.next?.kind).toBe('ask')
    expect(next.next?.reason).toBe('confirm_budget_increase')
  })
})
