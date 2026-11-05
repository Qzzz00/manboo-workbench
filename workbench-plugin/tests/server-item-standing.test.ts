// @vitest-environment node
/**
 * 没办完的事项「停在哪」(2026-10-12,卡「没办完的事项说清楚」,`server/itemStanding.ts`)。
 * 卡的形状照运营同学 10-12 排查报告里那几类:阻塞、进行中但会话早说完了、派活没送成、几周没人动。
 */
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { ITEM_LIKELY_MOOT_DAYS, ITEM_STANDING_STALL_DAYS, itemStandingRequest, standingBadgeText, standingWaitingText } from '../src/protocol.ts'
import type { JobEvent } from '../src/server/jobLog.ts'
import { itemMover } from '../src/server/itemMover.ts'
import { itemStanding, stalledMorningLines, STALLED_MORNING_MAX, STALLED_MORNING_HEAD, type StandingContext } from '../src/server/itemStanding.ts'

const NOW = new Date('2026-10-12T09:00:00+08:00')
const DAY = 86_400_000

function ago(days: number, hours = 0): string {
  return new Date(NOW.getTime() - days * DAY - hours * 3_600_000).toISOString()
}

function task(id: string, extra: Partial<TaskView> = {}): TaskView {
  return {
    id,
    title: `事项 ${id}`,
    status: 'todo',
    direction: 'mine',
    source: { kind: 'manual' },
    created_at: ago(20),
    updated_at: ago(20),
    ...extra,
  }
}

function standing(t: TaskView, ctx: Omit<StandingContext, 'now' | 'mover'> = {}) {
  return itemStanding(t, { now: NOW, mover: itemMover(t), ...ctx })
}

/** 卡上挂好 /state 会给的那一格。 */
function withStanding(t: TaskView): TaskView {
  const view = standing(t)
  return view === undefined ? t : { ...t, standing: view }
}

/** 不是她交代的那种(没有 direction):看板卡,写了负责人才算事项。 */
function board(id: string, extra: Partial<TaskView> = {}): TaskView {
  const { direction: _mine, ...rest } = task(id, extra)
  return rest
}

describe('哪些事项算', () => {
  it('办完 / 取消 / 待排 / 随口问 / 不是事项的看板卡:不算(缺席)', () => {
    expect(standing(task('a', { status: 'done' }))).toBeUndefined()
    expect(standing(task('a', { status: 'canceled' }))).toBeUndefined()
    expect(standing(task('a', { status: 'backlog' }))).toBeUndefined()
    expect(standing(task('a', { status: 'doing', casual: true }))).toBeUndefined()
    expect(standing(board('a'))).toBeUndefined()
  })
})

describe('最后一条证据', () => {
  it('取最晚那一条,并说清来源:派活回执 / 会话 / 她的操作;卡上改动只在更晚时才算', () => {
    const t = task('a', {
      status: 'doing',
      origin: 'user',
      created_at: ago(9),
      updated_at: ago(8),
      client_dispatch: { hand: 'window', family: 'claude', status: 'sent', at: ago(6), text: 'x', seen_at: ago(5), reply_state: 'waiting' },
    })
    const view = standing(t)
    expect(view?.last).toEqual({ what: expect.stringContaining('Claude'), at: ago(5), source: 'dispatch' })
    // 她交代的那一下是她的操作。
    const fresh = standing(task('b', { origin: 'user', created_at: ago(1), updated_at: ago(1) }))
    expect(fresh?.last?.source).toBe('her')
  })

  it('会话:按卡上挂的那条会话现查;账上的事件也算派活回执', () => {
    const t = task('a', { status: 'doing', conversation: { agent: 'dsh', session_id: 's1' } })
    const view = standing(t, { sessions: new Map([['dsh:s1', { status: 'running', updated_at: ago(0, 1) }]]) })
    expect(view?.last?.source).toBe('session')
    const events: JobEvent[] = [{ at: ago(0, 2), job: 'a', step: 'assigned', family: 'codex' }]
    expect(standing(task('a', { status: 'doing' }), { jobEvents: events })?.last).toEqual({ what: expect.stringContaining('Codex'), at: ago(0, 2), source: 'dispatch' })
  })

  it('一条都取不到(时刻读不出)就缺席,不编', () => {
    const view = standing(task('a', { created_at: 'x', updated_at: 'y' }))
    expect(view?.last).toBeUndefined()
    expect(view?.idle_days).toBeUndefined()
  })
})

describe('四种情况分开', () => {
  it('正常等她:等我确认 / 阻塞(不是出错)/ 字写进框没发出去 / 锁屏排着等解锁', () => {
    const confirm = standing(task('a', { status: 'confirm', updated_at: ago(1) }))
    expect(confirm).toMatchObject({ case: 'waiting_her', waiting_on: 'her' })
    expect(standing(task('a', { status: 'blocked', block_reason: 'input' }))).toMatchObject({ case: 'waiting_her', waiting_on: 'her' })
    const typed = standing(task('a', { status: 'blocked', client_dispatch: { hand: 'window', family: 'manus', status: 'typed', at: ago(1), text: 'x' } }))
    expect(typed).toMatchObject({ case: 'waiting_her', waiting_on: 'her' })
    expect(typed?.next).toContain('发送')
    const locked = standing(task('a', { status: 'doing', assignee: 'claude' }), {
      jobEvents: [
        { at: ago(0, 3), job: 'a', step: 'assigned', family: 'claude' },
        { at: ago(0, 2), job: 'a', step: 'waiting', family: 'claude', why: '电脑锁着' },
      ],
    })
    expect(locked).toMatchObject({ case: 'waiting_her', waiting_on: 'unlock' })
  })

  it('执行结束但结果没回写:会话已说完而卡还在进行中', () => {
    const t = task('a', { status: 'doing', conversation: { agent: 'dsh', session_id: 's1' }, updated_at: ago(3) })
    const view = standing(t, { sessions: new Map([['dsh:s1', { status: 'done', updated_at: ago(2) }]]) })
    expect(view).toMatchObject({ case: 'result_unwritten', waiting_on: 'nobody' })
    expect(view?.idle_days).toBe(2)
    // 派出去的那一家交回了、账上记了 replied,卡还在进行中 —— 同一种。
    const replied = standing(task('b', { status: 'doing', assignee: 'codex' }), {
      jobEvents: [{ at: ago(1), job: 'b', step: 'replied', family: 'codex' }],
    })
    expect(replied?.case).toBe('result_unwritten')
  })

  it('「已送达」不当成「已完成」:看见了那一句只说明送到了,它还在做', () => {
    const t = task('a', {
      status: 'doing',
      assignee: 'claude',
      client_dispatch: { hand: 'window', family: 'claude', status: 'sent', at: ago(0, 3), text: 'x', seen_at: ago(0, 2), reply_state: 'waiting' },
    })
    const view = standing(t)
    expect(view).toMatchObject({ case: 'in_motion', waiting_on: 'agent', agent: 'claude' })
    expect(view?.last?.what).toContain('送达')
    expect(view?.last?.what).not.toContain('完成')
  })

  it('通道失败后没再推进:没送成 / 等过头 / 出错阻塞;后来又送成了就不算', () => {
    const failed = standing(task('a', { status: 'doing', assignee: 'manus', client_dispatch: { hand: 'window', family: 'manus', status: 'failed', at: ago(2), text: 'x', reason: '找不到窗口' } }))
    expect(failed).toMatchObject({ case: 'channel_failed', waiting_on: 'nobody' })
    expect(failed?.last?.what).toContain('找不到窗口')
    expect(standing(task('a', { status: 'doing' }), { jobEvents: [{ at: ago(2), job: 'a', step: 'timeout', family: 'kimi' }] })?.case).toBe('channel_failed')
    expect(standing(task('a', { status: 'blocked', block_reason: 'error', note: '会话出错' }))?.case).toBe('channel_failed')
    const recovered = standing(task('a', { status: 'doing', assignee: 'kimi' }), {
      jobEvents: [
        { at: ago(2), job: 'a', step: 'timeout', family: 'kimi' },
        { at: ago(1), job: 'a', step: 'seen', family: 'kimi' },
      ],
    })
    expect(recovered?.case).toBe('in_motion')
  })

  it('她自己停掉的那次派活不算通道失败', () => {
    const view = standing(task('a', { status: 'doing', assignee: 'codex', dispatch: { family: 'codex', status: 'failed', stopped: 'user', started_at: ago(3), ended_at: ago(2) } }))
    expect(view?.case).not.toBe('channel_failed')
  })

  it(`多半不再需要:没人在等、${ITEM_LIKELY_MOOT_DAYS} 天以上没动静;不到就只是排着`, () => {
    const old = standing(task('a', { status: 'todo', updated_at: ago(ITEM_LIKELY_MOOT_DAYS + 1) }))
    expect(old).toMatchObject({ case: 'likely_moot', waiting_on: 'nobody', idle_days: ITEM_LIKELY_MOOT_DAYS + 1 })
    const recent = standing(task('a', { status: 'todo', updated_at: ago(2), created_at: ago(2) }))
    expect(recent).toMatchObject({ case: 'queued', waiting_on: 'nobody' })
    // 在等她的,多久都不算「不再需要」。
    expect(standing(task('a', { status: 'confirm', updated_at: ago(30) }))?.case).toBe('waiting_her')
  })

  it('等同事 / 别人:单独一档,不算没人在等', () => {
    expect(standing(board('a', { assignee: 'colleague', updated_at: ago(30) }))).toMatchObject({ case: 'waiting_others', waiting_on: 'others' })
  })
})

describe('停太久', () => {
  it('超过各档阈值才标 stalled;正常在做、排着、等别人不标', () => {
    expect(standing(task('a', { status: 'confirm', updated_at: ago(ITEM_STANDING_STALL_DAYS.waiting_her) }))?.stalled).toBe(true)
    expect(standing(task('a', { status: 'confirm', updated_at: ago(ITEM_STANDING_STALL_DAYS.waiting_her - 1) }))?.stalled).toBeUndefined()
    expect(standing(task('a', { status: 'todo', updated_at: ago(2), created_at: ago(2) }))?.stalled).toBeUndefined()
  })
})

describe('三个选择走现有入口', () => {
  it('关掉 = 挪进取消;重派 = 负责人驱动再派一次;继续:结果回来了 = 收进等我确认、不再需要 = 接着推、其余 = 打开这件', () => {
    const t = task('a', { status: 'doing' })
    expect(itemStandingRequest(t.id, 'result_unwritten', 'close')).toEqual({ path: '/task/move', body: { id: 'a', status: 'canceled' } })
    expect(itemStandingRequest(t.id, 'channel_failed', 'redispatch')).toEqual({ path: '/item/drive', body: { task_id: 'a' } })
    expect(itemStandingRequest(t.id, 'result_unwritten', 'continue')).toEqual({ path: '/task/move', body: { id: 'a', status: 'confirm' } })
    expect(itemStandingRequest(t.id, 'likely_moot', 'continue')).toEqual({ path: '/item/drive', body: { task_id: 'a' } })
    expect(itemStandingRequest(t.id, 'waiting_her', 'continue')).toEqual({ open: true })
  })

  it('每一档给哪几颗:不再需要不给重派(继续就是再推一次);没派过的等她不给重派', () => {
    expect(standing(task('a', { updated_at: ago(30) }))?.actions).toEqual(['continue', 'close'])
    expect(standing(task('a', { status: 'confirm' }))?.actions).toEqual(['continue', 'close'])
    expect(standing(task('a', { status: 'doing', assignee: 'manus', client_dispatch: { hand: 'window', family: 'manus', status: 'failed', at: ago(2), text: 'x' } }))?.actions)
      .toEqual(['continue', 'close', 'redispatch'])
  })
})

describe('早报里那一段', () => {
  it('只列停太久的那几件,最久的在前,最多几件,多的说「另外 N 件」;一件都没有就整段不出', () => {
    const tasks = Array.from({ length: STALLED_MORNING_MAX + 2 }, (_, index) => {
      const t = task(`t${index}`, { title: `第 ${index} 件`, status: 'confirm', updated_at: ago(3 + index) })
      return withStanding(t)
    })
    const lines = stalledMorningLines(tasks)
    expect(lines[0]).toBe(STALLED_MORNING_HEAD)
    expect(lines).toHaveLength(1 + STALLED_MORNING_MAX + 1)
    expect(lines[1]).toContain(`第 ${STALLED_MORNING_MAX + 1} 件`)
    expect(lines.at(-1)).toContain('另外 2 件')
    expect(stalledMorningLines([{ ...task('x', { status: 'todo', updated_at: ago(1), created_at: ago(1) }) }])).toEqual([])
  })

  it('她自己的待办不在这一段(早报另有「你自己的」那一句)', () => {
    const own = board('me', { assignee: 'me', updated_at: ago(30) })
    expect(stalledMorningLines([withStanding(own)])).toEqual([])
  })

  it('每一行说清是哪种、停了几天、下一步', () => {
    const t = task('a', { title: '换首页截图', status: 'doing', conversation: { agent: 'dsh', session_id: 's1' }, updated_at: ago(3) })
    const view = standing(t, { sessions: new Map([['dsh:s1', { status: 'done', updated_at: ago(2) }]]) })
    const lines = stalledMorningLines([{ ...t, ...(view === undefined ? {} : { standing: view }) }])
    expect(lines[1]).toContain('换首页截图')
    expect(lines[1]).toContain('2 天')
    expect(lines[1]).toContain(view?.next ?? '?')
  })
})

describe('卡面上那一格与「在等谁」', () => {
  it('只给要留意的:结果没收进卡 / 没派成 / 多半不需要;等她的只在停太久时;正常的不出字', () => {
    expect(standingBadgeText({ case: 'result_unwritten', idle_days: 2 })).toBe('结果回来了没收进卡 · 停了 2 天')
    expect(standingBadgeText({ case: 'channel_failed', idle_days: 0 })).toBe('没派成,停着')
    expect(standingBadgeText({ case: 'waiting_her', idle_days: 1 })).toBeUndefined()
    expect(standingBadgeText({ case: 'waiting_her', idle_days: 4, stalled: true })).toBe('等你 · 停了 4 天')
    expect(standingBadgeText({ case: 'in_motion', idle_days: 9 })).toBeUndefined()
    expect(standingBadgeText(undefined)).toBeUndefined()
  })

  it('在等谁:她 / 某家 / 解锁电脑 / 别人 / 没人', () => {
    expect(standingWaitingText({ waiting_on: 'agent' }, 'Claude')).toBe('在等 Claude')
    expect(standingWaitingText({ waiting_on: 'unlock' })).toBe('在等你解锁电脑')
    expect(standingWaitingText({ waiting_on: 'nobody' })).toBe('没人在等')
  })
})
