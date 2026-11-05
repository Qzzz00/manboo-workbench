// @vitest-environment node
/**
 * ★ **重置这一家**(2026-10-21,卡「派活按家隔离」第 4 条)。
 *
 * 从前清通道只有三种办法:停单件、关掉重开那家 App、重启插件(重启又清掉会话登记表,手机 404)。
 * 现在一颗键:清闸计数、撤销在等的读(插件这一侧 + 壳那一侧)、重开那扇窗 —— 不重启插件,别家一点不动。
 * 重置这一下记进任务账(这一家每件还开着的事一行 + 这一下本身一行)与行为账。
 */
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { createActionGate } from '../src/server/actionGate.ts'
import { FAMILY_RESET_BEHAVIOR, familyResetJobKey, resetFamily } from '../src/server/familyReset.ts'
import { createFamilyLanes } from '../src/server/familyLanes.ts'
import { createJobLog } from '../src/server/jobLog.ts'

function card(id: string, over: Partial<TaskView>): TaskView {
  return { id, title: id, status: 'doing', direction: 'mine', ...over } as TaskView
}

describe('重置这一家', () => {
  it('★清计数、撤在等的读(两侧)、重开窗、清卡上「通道堵了」;别家不动;两本账各记一笔', async () => {
    const now = () => new Date('2026-10-21T08:00:00Z')
    const lanes = createFamilyLanes({ now })
    const hung = lanes.run('doubao', 'read', () => new Promise(() => {}))
    const queued = lanes.run('doubao', 'read', async () => 'x')
    const gate = createActionGate({ phaseOf: () => 'open', now })
    for (let i = 0; i < 3; i += 1) { gate.allow({ job: 'a', family: 'doubao', action: 'dispatch_send' }); gate.allow({ job: 'k', family: 'kimi', action: 'dispatch_send' }) }
    const jobLog = createJobLog({ now })
    const updates: { id: string, patch: unknown }[] = []
    const helperOps: unknown[] = []
    const opened: string[] = []
    const behavior: unknown[] = []
    const tasks = [
      card('a', { client_dispatch: { hand: 'window', family: 'doubao', status: 'sent', at: '2026-10-21T07:59:00Z', text: 't', marker: 'm', reply_state: 'waiting', bundle_id: 'com.work.pc.doubao' }, dispatch_lane: { family: 'doubao', state: 'jammed', since: '2026-10-21T07:59:30Z', note: '豆包 的窗口卡住了' } }),
      card('b', { status: 'doing', dispatch_lane: { family: 'doubao', state: 'queued', since: '2026-10-21T07:59:40Z', note: '排着', behind: 'a', input: { said: 's' } } }),
      card('k', { client_dispatch: { hand: 'window', family: 'kimi', status: 'sent', at: '2026-10-21T07:59:00Z', text: 't', marker: 'm2', reply_state: 'waiting' } }),
      card('old', { status: 'done', client_dispatch: { hand: 'window', family: 'doubao', status: 'sent', at: '2026-10-20T07:59:00Z', text: 't', marker: 'm3', reply_state: 'done' } }),
    ]
    const out = await resetFamily({
      lanes,
      gate,
      jobLog,
      name: family => (family === 'doubao' ? '豆包' : family),
      now,
      packagesOf: () => ['com.bot.pc.doubao'],
      helper: { supports: cap => cap === 'read_lanes', request: async (req) => { helperOps.push(req); return { cancelled: 2 } } },
      openApp: async (bundle) => { opened.push(bundle); return { ok: true } },
      tasks: { list: async () => ({ tasks }), update: async (id, patch) => { updates.push({ id, patch }); return true } },
      behavior: (input) => { behavior.push(input) },
    }, 'doubao')

    expect(out.ok).toBe(true)
    expect(out.note).toContain('豆包')
    expect(out).toMatchObject({ cancelled_reads: 1, abandoned: 1, gate_cleared: 1, shell_cancelled: 2, reopened: true, open_jobs: 2 })
    await expect(hung).resolves.toMatchObject({ ok: false, why: 'reset' })
    await expect(queued).resolves.toMatchObject({ ok: false, why: 'reset' })
    // 别家的闸照算。
    expect(gate.allow({ job: 'k', family: 'kimi', action: 'dispatch_send' })).toMatchObject({ ok: false, why: 'too_many' })
    expect(gate.allow({ job: 'a', family: 'doubao', action: 'dispatch_send' })).toMatchObject({ ok: true })
    // 壳那一侧:这一家的每个包(卡上真送进去的那个也算)。
    expect(helperOps).toEqual([{ op: 'cancel_reads', bundle_ids: ['com.bot.pc.doubao', 'com.work.pc.doubao'] }])
    // 重开那扇窗:卡上真送进去的那个包优先。
    expect(opened).toEqual(['com.work.pc.doubao'])
    // 卡上「通道堵了」那一格清掉;排着的那件不动(它等前一件,前一件还开着)。
    expect(updates).toEqual([{ id: 'a', patch: { dispatchLane: null } }])
    // 任务账:这一家每件还开着的事一行 + 这一下本身一行;行为账一笔。
    const resets = jobLog.all().filter(one => one.step === 'lane_reset')
    expect(resets.map(one => one.job).sort()).toEqual(['a', 'b', familyResetJobKey('doubao')].sort())
    expect(resets.every(one => one.family === 'doubao')).toBe(true)
    expect(behavior).toEqual([expect.objectContaining({ 事: FAMILY_RESET_BEHAVIOR, 对象: '豆包' })])
  })

  it('老壳不认「撤读」:照样清插件这一侧,话里如实说壳那一侧没撤', async () => {
    const now = () => new Date('2026-10-21T08:00:00Z')
    const out = await resetFamily({
      lanes: createFamilyLanes({ now }),
      gate: createActionGate({ phaseOf: () => 'open', now }),
      name: () => '豆包',
      now,
      packagesOf: () => ['com.bot.pc.doubao'],
      helper: { supports: () => false, request: async () => { throw new Error('不该发') } },
      tasks: { list: async () => ({ tasks: [] }), update: async () => true },
    }, 'doubao')
    expect(out.ok).toBe(true)
    expect(out.shell_cancelled).toBeUndefined()
    expect(out.note).toContain('工作台 App')
  })
})
