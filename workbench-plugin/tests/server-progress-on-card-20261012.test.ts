// @vitest-environment node
/**
 * 卡上「现在到哪」那一格摆哪一份(2026-10-12,卡 `claude/ops-patch-1012`;运营同学 10-09「跨设备同步」那一条)。
 *
 * 他看到的:办完的卡进度还写着「在做」;刚改过状态的卡挂着改之前核的那份 —— 手机与电脑各自拿旧进度盖住新状态。
 * 钉三件事:① 办完 / 取消以主状态为准;② 比卡还旧(过了两分钟余量)的进度藏起来;③ 两分钟以内的照旧下发(核对那一轮自己会动卡)。
 */
import { describe, expect, it } from 'vitest'
import type { TaskProgressView } from '../src/protocol.ts'
import { PROGRESS_CANCELED_LINE, PROGRESS_DONE_LINE, PROGRESS_STALE_GRACE_MS, progressOnCard } from '../src/server/progressOnCard.ts'

const STORED: TaskProgressView = {
  line: '11 屏已做完,逐屏文案稿在等你审', state: 'found', basis: [], checked_at: '2026-10-09T07:10:00.000Z', waiting_on: 'me', by: 'model',
}

describe('收场的卡以主状态为准', () => {
  it('★办完 → 「已完成」,时刻是 done_at(没有就 updated_at),规则拼的、没有依据', () => {
    const got = progressOnCard({ status: 'done', updated_at: '2026-10-09T08:00:00.000Z', done_at: '2026-10-09T07:59:00.000Z' }, STORED)
    expect(got).toEqual({ line: PROGRESS_DONE_LINE, state: 'found', basis: [], checked_at: '2026-10-09T07:59:00.000Z', waiting_on: 'nobody', by: 'rules' })
    expect(progressOnCard({ status: 'done', updated_at: '2026-10-09T08:00:00.000Z' }, undefined)?.checked_at).toBe('2026-10-09T08:00:00.000Z')
  })

  it('取消 → 「已取消」', () => {
    expect(progressOnCard({ status: 'canceled', updated_at: '2026-10-09T08:00:00.000Z' }, STORED)?.line).toBe(PROGRESS_CANCELED_LINE)
  })
})

describe('比卡还旧的进度不下发', () => {
  it('★卡在核对之后又改过(超过两分钟余量)→ 那份进度藏起来', () => {
    const later = new Date(Date.parse(STORED.checked_at) + PROGRESS_STALE_GRACE_MS + 1).toISOString()
    expect(progressOnCard({ status: 'doing', updated_at: later }, STORED)).toBeUndefined()
  })

  it('两分钟以内的改动(核对那一轮自己推的那一下)→ 照旧下发', () => {
    const soon = new Date(Date.parse(STORED.checked_at) + PROGRESS_STALE_GRACE_MS - 1).toISOString()
    expect(progressOnCard({ status: 'doing', updated_at: soon }, STORED)).toBe(STORED)
  })

  it('核对在卡改动之后 → 照旧下发;没核过 → 缺席;时刻认不出 → 照旧下发', () => {
    expect(progressOnCard({ status: 'doing', updated_at: '2026-10-09T07:00:00.000Z' }, STORED)).toBe(STORED)
    expect(progressOnCard({ status: 'doing', updated_at: '2026-10-09T07:00:00.000Z' }, undefined)).toBeUndefined()
    expect(progressOnCard({ status: 'doing', updated_at: '不是时刻' }, STORED)).toBe(STORED)
  })
})
