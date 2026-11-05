// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createJobLog } from '../src/server/jobLog.ts'
const source = { job: 'qa-task', step: 'started' as const, agent: 'codex', session_id: 'qa-session', source_round: 'round-1', source_event_id: 'event-1' }
describe('来源事件持久化与通知顺序', () => {
  it('追加尚未完成时不通知，落盘完成后才通知', async () => {
    let release = () => {}, notified = false, persisted = false
    const hold = new Promise<void>(resolve => { release = resolve })
    const log = createJobLog({ file: '/qa/jobs', io: { read: async () => '', rewrite: async () => {}, append: async () => { await hold; persisted = true } } })
    log.listen!(() => { expect(persisted).toBe(true); notified = true })
    log.append(source); await Promise.resolve(); expect(notified).toBe(false)
    release(); await log.flush(); expect(notified).toBe(true)
  })
  it('落盘失败不广播，flush明确失败而不是回包成功', async () => {
    let notified = false
    const log = createJobLog({ file: '/qa/jobs', warn: () => {}, io: { read: async () => '', rewrite: async () => {}, append: async () => { throw new Error('qa disk unavailable') } } })
    log.listen!(() => { notified = true }); log.append(source)
    await expect(log.flush()).rejects.toThrow('qa disk unavailable'); expect(notified).toBe(false)
  })
})
