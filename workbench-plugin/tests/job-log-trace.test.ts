/**
 * **一本只追加的任务日志**(2026-10-02,卡 AG;`docs/设计-重构-接缝与技术债-2026-09-30.md` 第 1 段 B 的起步)。
 *
 * 维护者 10-02:「你不要拿着打补丁的心态,网易云是一个例子,你要有机制上的调整」。
 * 机制的第一样就是**账**:今天「指派 → 投递 → 完成 / 超时 / 读不到 → 已打电话」四步
 * 没有一条管线能从落盘数据完整查回来(根子 3),于是每条路只好各自猜「这件事还动不动得」。
 *
 * 这一份守的口径:
 * ① **只追加**:写进去的那一条谁都不许改、不许删(满了只从最老的丢,且说得出丢了几条);
 * ② **四步查得回来**:`traceOf` 从事件里数出指派 / 投递 / 完成 / 已打电话,数不出来的那一格**缺席**,不编;
 * ③ 日志那一行里**没有她的话**:只有时刻、事项、哪一家、什么动作、为什么。
 */
import { describe, expect, it } from 'vitest'
import {
  JOB_LOG_MAX,
  createJobLog,
  jobLogLine,
  trimJobEvents,
  traceOf,
} from '../src/server/jobLog.ts'
import type { JobEvent } from '../src/server/jobLog.ts'

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 9, 2, 10, 0, seconds)).toISOString()
}

describe('任务日志:只追加', () => {
  it('append 回那一条,events 按先后给回来', () => {
    let tick = 0
    const log = createJobLog({ now: () => new Date(Date.UTC(2026, 9, 2, 10, 0, tick += 1)) })
    log.append({ job: 't-1', step: 'assigned', family: 'doubao' })
    log.append({ job: 't-1', step: 'sent', family: 'doubao', bundle_id: 'com.work.pc.doubao' })
    log.append({ job: 't-2', step: 'assigned', family: 'codex' })
    const mine = log.events('t-1')
    expect(mine.map(one => one.step)).toEqual(['assigned', 'sent'])
    expect(mine[0]?.at).toBe(at(1))
    expect(log.events('t-2')).toHaveLength(1)
    expect(log.all()).toHaveLength(3)
  })

  it('来源事件按事项、会话和来源事件号幂等,同事项的另一会话独立保留', () => {
    const log = createJobLog()
    const base = { job: 't-1', step: 'started' as const, family: 'codex', agent: 'codex' as const,
      session_id: 's-1', source_round: 'r-1', source_event_id: 'e-1', occurred_at: at(1), observed_at: at(2) }
    log.append(base)
    log.append(base)
    log.append({ ...base, session_id: 's-2', source_event_id: 'e-1' })
    expect(log.all()).toHaveLength(2)
    expect(log.all().map(one => one.session_id)).toEqual(['s-1', 's-2'])
  })
  it('压缩任务账时来源事件和旧轮次仍保留', () => {
    const sourceEvent = (round: string, id: string): JobEvent => ({ job: 't-1', step: 'ended', at: at(1), agent: 'codex', session_id: 's-1', source_round: round, source_event_id: id })
    const kept = trimJobEvents([sourceEvent('r-1', 'e-1'), sourceEvent('r-2', 'e-2'), { job: 't-old', step: 'done', at: at(2) }], 1)
    expect(kept.map(one => one.source_round)).toEqual(['r-1', 'r-2'])
    expect(kept).toHaveLength(2)
  })

  it('给回去的是副本:外面改不动账上那一条', () => {
    const log = createJobLog()
    log.append({ job: 't-1', step: 'assigned', family: 'doubao' })
    const taken = log.events('t-1') as JobEvent[]
    taken.push({ at: at(9), job: 't-1', step: 'done' })
    expect(log.events('t-1')).toHaveLength(1)
  })

  /*
   * ★ 2026-10-02(卡 AG2)这一条改了口径:原来是「满了只从最老的丢」,现在是
   * **「满了只丢已经收场那几件的;还没收场的一条都不丢」**(落盘那一版的规矩,
   * 口径同 `relayWatch.trimRelayWaits`)。理由:一件事还没收场就把它的账截掉,
   * 等于把「这件事还动不动得」「来过几回」的依据扔了 —— 而那正是这本账存在的理由。
   * 丢谁那一段是纯函数 `trimJobEvents`,用例在 `job-log-persist.test.ts`。
   */
  it('满了只丢已收场那几件的,而且数得出丢了几条', () => {
    const log = createJobLog({ max: 3 })
    for (let i = 0; i < 5; i += 1) log.append({ job: `t-${i}`, step: 'assigned' })
    // 五件事一件都没收场 → 一条都不丢(宁可超一点,也不丢还在办的那几件的账)。
    expect(log.all()).toHaveLength(5)
    expect(log.dropped()).toBe(0)
    // 收场了的那几件才让位。
    for (let i = 0; i < 3; i += 1) log.append({ job: `t-${i}`, step: 'done' })
    expect(log.dropped()).toBeGreaterThan(0)
    expect(log.events('t-4')).toHaveLength(1)
  })

  it('默认上限是导出的那个常量', () => {
    expect(JOB_LOG_MAX).toBeGreaterThan(100)
  })
})

describe('任务日志:四步查得回来', () => {
  const events: readonly JobEvent[] = [
    { at: at(1), job: 't-1', step: 'assigned', family: 'doubao' },
    { at: at(2), job: 't-1', step: 'sent', family: 'doubao', bundle_id: 'com.work.pc.doubao' },
    { at: at(3), job: 't-1', step: 'seen', family: 'doubao' },
    { at: at(4), job: 't-1', step: 'replied', family: 'doubao' },
    { at: at(5), job: 't-1', step: 'called', family: 'doubao' },
  ]

  it('指派 / 投递 / 完成 / 已打电话 四格都数出来', () => {
    const trace = traceOf('t-1', events)
    expect(trace.assigned?.at).toBe(at(1))
    expect(trace.delivered?.at).toBe(at(2))
    expect(trace.finished?.at).toBe(at(4))
    expect(trace.called?.at).toBe(at(5))
    expect(trace.events).toHaveLength(5)
  })

  it('没走到的那一格缺席 —— 不拿别的步骤顶上', () => {
    const trace = traceOf('t-1', events.slice(0, 2))
    expect(trace.assigned).toBeDefined()
    expect(trace.delivered).toBeDefined()
    expect(trace.finished).toBeUndefined()
    expect(trace.called).toBeUndefined()
  })

  it('超时 / 读不到也算「完成」那一格(收场了就是收场了)', () => {
    expect(traceOf('t-1', [{ at: at(1), job: 't-1', step: 'timeout' }]).finished?.step).toBe('timeout')
    expect(traceOf('t-1', [{ at: at(1), job: 't-1', step: 'unreadable' }]).finished?.step).toBe('unreadable')
  })

  it('按规矩不打电话也记在「已打电话」那一格里(说得出为什么不打)', () => {
    const trace = traceOf('t-1', [{ at: at(1), job: 't-1', step: 'no_call', why: '静音时段' }])
    expect(trace.called?.step).toBe('no_call')
    expect(trace.called?.why).toBe('静音时段')
  })

  it('别人的事项不混进来', () => {
    expect(traceOf('t-9', events).events).toHaveLength(0)
  })
})

describe('任务日志:那一行里没有她的话', () => {
  it('只有时刻、事项、哪一家、什么动作、为什么', () => {
    const line = jobLogLine({ at: at(7), job: 't-1', step: 'gate_block', family: 'doubao', action: 'reply_watch', why: '这件已经收场了' })
    expect(line).toContain('t-1')
    expect(line).toContain('doubao')
    expect(line).toContain('这件已经收场了')
    expect(line).toContain(at(7))
  })

  it('缺席的那几格不占位置', () => {
    const line = jobLogLine({ at: at(7), job: 't-1', step: 'assigned' })
    expect(line).toContain('t-1')
    expect(line).not.toContain('undefined')
  })
})
