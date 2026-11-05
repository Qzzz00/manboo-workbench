// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentCapsView, AgentCard, AgentEntryView, CollabGoal, CollabPresence, TaskView } from '../src/protocol.ts'
import { UNSORTED_GOAL_ID } from '../src/protocol.ts'
import {
  type BoardLayout,
  GOAL_TITLE_H, NOTE_H, NOTE_W, arrowTargets, autoLayout, boardGoals, estimateNoteHeight, filterOptions, goalAt, matchesFilter,
  noteCost, railCards, replaySources, stampChoices, waitingStrip,
} from '../src/client/collab/collabModel.ts'

const AT = '2026-10-21T09:00:00.000Z'
const note = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })
const goal = (id: string, patch: Partial<CollabGoal> = {}): CollabGoal => ({ id, title: id, owner: 'me', status: 'open', created_at: AT, updated_at: AT, ...patch })

describe('板上有哪几块目标', () => {
  it('还在推的目标都在;「未归目标」只在有老卡时出现;随手问一句的不上板', () => {
    expect(boardGoals([goal('g-1')], [note('a', { goal_id: 'g-1' })]).map(one => one.id)).toEqual(['g-1'])
    expect(boardGoals([goal('g-1')], [note('a')]).map(one => one.id)).toEqual(['g-1', UNSORTED_GOAL_ID])
    expect(boardGoals([], [note('a', { casual: true })]).map(one => one.id)).toEqual([])
  })
  it('达成 / 不要了的目标:有便签才留着', () => {
    expect(boardGoals([goal('g-1', { status: 'dropped' })], []).map(one => one.id)).toEqual([])
    expect(boardGoals([goal('g-1', { status: 'reached' })], [note('a', { goal_id: 'g-1' })]).map(one => one.id)).toEqual(['g-1'])
  })
  it('便签挂了一个账上没有的目标 → 算进「未归目标」,不丢', () => {
    expect(boardGoals([], [note('a', { goal_id: 'g-gone' })]).map(one => one.id)).toEqual([UNSORTED_GOAL_ID])
  })
})

describe('自动摆:存过的位置照旧,没存过的按创建先后排进自己的目标区', () => {
  it('空目标只画一条标题线;有便签的区按格子排', () => {
    const goals = boardGoals([goal('g-1'), goal('g-2')], [note('a', { goal_id: 'g-1' }), note('b', { goal_id: 'g-1', created_at: '2026-10-21T10:00:00.000Z' })])
    const layout = autoLayout(goals, [note('a', { goal_id: 'g-1' }), note('b', { goal_id: 'g-1', created_at: '2026-10-21T10:00:00.000Z' })], { goals: {}, notes: {} })
    const g1 = layout.goals['g-1']
    const g2 = layout.goals['g-2']
    expect(g2?.h).toBe(GOAL_TITLE_H)
    expect(g1 !== undefined && g1.h > GOAL_TITLE_H).toBe(true)
    const a = layout.notes.a
    const b = layout.notes.b
    expect(a !== undefined && b !== undefined && a.x < b.x).toBe(true)
    // 便签在自己的区里
    expect(goalAt({ x: (a?.x ?? 0) + NOTE_W / 2, y: (a?.y ?? 0) + NOTE_H / 2 }, layout)).toBe('g-1')
  })
  it('存过的位置一个不动', () => {
    const layout = autoLayout(boardGoals([goal('g-1')], [note('a', { goal_id: 'g-1' })]), [note('a', { goal_id: 'g-1' })], {
      goals: { 'g-1': { x: 1000, y: 1000, w: 600, h: 400 } }, notes: { a: { x: 1050, y: 1080 } },
    })
    expect(layout.goals['g-1']).toEqual({ x: 1000, y: 1000, w: 600, h: 400 })
    expect(layout.notes.a).toEqual({ x: 1050, y: 1080 })
  })

  it('三行标题的卡不与下一张相交', () => {
    const longTitle = '钩子备份同秒不再互盖：这是一个超长的三行标题便签内容用来验证高度与下排卡片不重叠'
    const n1 = note('n1', { title: longTitle, goal_id: 'g-1', created_at: '2026-10-21T09:00:00.000Z' })
    const n2 = note('n2', { title: '卡2', goal_id: 'g-1', created_at: '2026-10-21T09:01:00.000Z' })
    const n3 = note('n3', { title: '下一排卡3', goal_id: 'g-1', created_at: '2026-10-21T09:02:00.000Z' })
    const goals = [goal('g-1')]
    const layout = autoLayout(goals, [n1, n2, n3], { goals: {}, notes: {} })
    const pos1 = layout.notes.n1
    const pos3 = layout.notes.n3
    expect(pos1).toBeDefined()
    expect(pos3).toBeDefined()
    expect(pos1!.x).toBe(pos3!.x)
    const h1 = estimateNoteHeight(n1)
    expect(pos3!.y).toBeGreaterThanOrEqual(pos1!.y + h1)
  })

  it('作废再恢复的目标照常有框、卡在框里', () => {
    const fridayGoal = goal('g-friday', { title: '周五(10-24)把仓库交接给研发', status: 'open' })
    const nextWeekGoal = goal('g-next', { title: '下周目标', status: 'open' })
    const fridayNotes = Array.from({ length: 12 }, (_, i) => note(`fn-${i}`, { goal_id: 'g-friday', title: `事项 ${i}` }))

    // 假设旧存档里 unsorted 占了 (0, 0),且 saved.notes 里的便签坐标都在 unsorted 区域
    const staleSaved: BoardLayout = {
      goals: {
        [UNSORTED_GOAL_ID]: { x: 0, y: 0, w: 600, h: 500 },
        'g-next': { x: 650, y: 0, w: 600, h: 500 },
      },
      notes: Object.fromEntries(fridayNotes.map((n, i) => [n.id, { x: 50 + (i % 2) * 200, y: 50 + Math.floor(i / 2) * 50 }])),
    }

    const layout = autoLayout(boardGoals([fridayGoal, nextWeekGoal], fridayNotes), fridayNotes, staleSaved)

    // 1. 周五目标框存在且有独立位置
    const fBox = layout.goals['g-friday']
    expect(fBox).toBeDefined()
    expect(fBox!.w).toBeGreaterThan(0)
    expect(fBox!.h).toBeGreaterThan(0)

    // 2. 周五目标框与现有的其它目标框(unsorted, g-next)不重叠
    for (const [gid, box] of Object.entries(layout.goals)) {
      if (gid === 'g-friday') continue
      const overlap = fBox!.x < box.x + box.w && fBox!.x + fBox!.w > box.x && fBox!.y < box.y + box.h && fBox!.y + fBox!.h > box.y
      expect(overlap).toBe(false)
    }

    // 3. 所有 12 张卡都在周五目标框内
    for (const fn of fridayNotes) {
      const pos = layout.notes[fn.id]
      expect(pos).toBeDefined()
      expect(goalAt({ x: pos!.x + NOTE_W / 2, y: pos!.y + NOTE_H / 2 }, layout)).toBe('g-friday')
    }
  })
})

describe('章:一排七个,走不到的灰掉', () => {
  it('待办能去在做、待领、卡住、不做;做完那一步要先过在做(照表能走到就亮)', () => {
    const choices = stampChoices('todo')
    expect(choices.map(one => one.stamp)).toEqual(['待领', '领了', '在做', '等你', '做完', '卡住', '不做'])
    expect(choices.find(one => one.status === 'done')?.path).toEqual(['doing', 'done'])
    expect(choices.find(one => one.status === 'todo')?.current).toBe(true)
  })
  it('做完 → 只能重开到在做,别的都走不到(灰)', () => {
    const choices = stampChoices('done')
    expect(choices.filter(one => one.path !== undefined && !one.current).map(one => one.status)).toContain('doing')
    expect(choices.find(one => one.status === 'canceled')?.path).toBeUndefined()
  })
})

describe('←/→:沿七态的次序挪到最近一个合法的章', () => {
  it('在做 ← 领了、→ 等你;待领没有左边', () => {
    expect(arrowTargets('doing')).toEqual({ prev: 'todo', next: 'confirm' })
    expect(arrowTargets('backlog')).toEqual({ next: 'todo' })
  })
})

describe('现在等你', () => {
  /** 事务官核过、标了四类拍板请求的「等你」(2026-10-26,卡「事务官页接管队列」)。 */
  const ask = { kind: 'spend' as const, proposal: '买这个', basis: '核过的事实', by: 'butler', at: '2026-10-21T10:00:00.000Z' }
  it('章是「等你」、且带四类拍板请求的便签,按回执时间先后;加上会话挂目标的提议', () => {
    const items = waitingStrip([
      note('late', { status: 'confirm', owner_ask: ask, receipt: { kind: 'done', text: 'x', at: '2026-10-21T11:00:00.000Z' } }),
      note('early', { status: 'confirm', owner_ask: ask, updated_at: '2026-10-21T08:00:00.000Z' }),
      note('other', { status: 'doing' }),
    ], [{ agent: 'codex', session_id: 's', title: '修铃声', new_goal_title: '修铃声', at: AT }])
    expect(items.map(one => one.key)).toEqual(['note:early', 'note:late', 'proposal:codex:s'])
  })

  it('章是「等你」、但没标四类拍板请求的,不进「现在等你」(待核验队列不摊给他;未知不自动放行)', () => {
    const items = waitingStrip([
      note('unmarked', { status: 'confirm' }),
      note('bad-kind', { status: 'confirm', owner_ask: { ...ask, kind: 'unknown' as never } }),
      note('asked', { status: 'confirm', owner_ask: ask }),
    ], [])
    expect(items.map(one => one.key)).toEqual(['note:asked'])
  })
})

describe('筛选:筛掉的变淡不消失', () => {
  const notes = [
    note('a', { project_id: 'p1', assignee: 'codex', labels: ['声音'], module: '铃声', goal_id: 'g-1', props: { 客户: '甲' } }),
    note('b', { project_id: 'p2', assignee: 'colleague', status: 'doing' }),
  ]
  const goals = [goal('g-1', { version: 'v1' })]
  it('选项从板上现有的里来;「同事」按「你」算', () => {
    const options = filterOptions(notes, goals, [])
    expect(options.assignee).toEqual(['codex', 'me'])
    expect(options.version).toEqual(['v1'])
    expect(options.prop).toEqual(['客户=甲'])
  })
  it('多选之间是「或」,维度之间是「且」;版本继承目标的', () => {
    expect(matchesFilter(notes[0] as TaskView, goals, [], { project: ['p1'], version: ['v1'] })).toBe(true)
    expect(matchesFilter(notes[1] as TaskView, goals, [], { project: ['p1'] })).toBe(false)
    expect(matchesFilter(notes[1] as TaskView, goals, [], { stamp: ['doing'], assignee: ['me'] })).toBe(true)
    expect(matchesFilter(notes[0] as TaskView, goals, [], { prop: ['客户=甲'], label: ['声音'], module: ['铃声'] })).toBe(true)
  })
  it('冲刺筛选 = 只亮那几个目标', () => {
    const sprints = [{ id: 's', title: 's', goal_ids: ['g-1'], created_at: AT, updated_at: AT }]
    expect(matchesFilter(notes[0] as TaskView, goals, sprints, { sprint: ['s'] })).toBe(true)
    expect(matchesFilter(notes[1] as TaskView, goals, sprints, { sprint: ['s'] })).toBe(false)
  })
})

describe('名片栏:本机 Agent + 你', () => {
  it('你在最前;本机登记表里的几家(事务官除外)带在不在线与在哪张便签上;登记的名片跟在后面', () => {
    const entries = [
      { id: 'dsh', name: '事务官', self: true, status: 'idle' },
      { id: 'codex', name: 'Codex', status: 'running' },
      { id: 'kimi', name: 'Kimi', status: 'unknown' },
    ] as unknown as AgentEntryView[]
    const presence: CollabPresence[] = [{ actor: { kind: 'agent', id: 'codex' }, on_note: 'a', state: 'working', at: AT }]
    const cards = railCards(entries, [{ id: 'agent:local:1', name: '代码 Agent', owner: 'me', hand: 'codex', shared: { to: 'none' }, created_at: AT, updated_at: AT }], presence)
    expect(cards.map(one => [one.id, one.online, one.onNote])).toEqual([
      ['me', true, undefined], ['codex', true, 'a'], ['kimi', false, undefined], ['agent:local:1', true, undefined],
    ])
  })

  const ENTRIES = [
    { id: 'codex', name: 'Codex', status: 'running' },
    { id: 'doubao', name: '豆包', status: 'running' },
  ] as unknown as AgentEntryView[]
  const capsWith = (edit: Record<string, unknown>): AgentCapsView => ({
    agents: [{ family: 'codex', title: 'Codex', cells: { chat: { state: 'ok', note: '' }, edit, collect: { state: 'ok', note: '' } }, line: '' }],
    line: '',
  } as unknown as AgentCapsView)
  const cardOf = (hand: string, runtime?: { family: string }): AgentCard => ({
    id: `agent:local:${hand}${runtime?.family ?? ''}`, name: hand, owner: 'me', hand,
    ...(runtime === undefined ? {} : { runtime }), shared: { to: 'none' }, created_at: AT, updated_at: AT,
  })
  const onlineOf = (cards: AgentCard[], caps?: AgentCapsView): boolean[] =>
    railCards(ENTRIES, cards, [], '我', caps).filter(one => one.kind === 'card').map(one => one.online)

  it('hand 语义(2026-10-22 卡「名片编辑表单重排」):cli 看体检 edit 格 ok-via-cli;window 查登记表那家;老卡(hand=登记表 id)照旧', () => {
    // cli 且探到命令行 → 在线;没探到 / 体检缺席 → 不在线
    expect(onlineOf([cardOf('cli', { family: 'codex' })], capsWith({ state: 'ok', via: 'cli', note: '' }))).toEqual([true])
    expect(onlineOf([cardOf('cli', { family: 'codex' })], capsWith({ state: 'no', note: '' }))).toEqual([false])
    expect(onlineOf([cardOf('cli', { family: 'codex' })])).toEqual([false])
    // window → 登记表里那家活着算在线
    expect(onlineOf([cardOf('window', { family: 'doubao' })])).toEqual([true])
    expect(onlineOf([cardOf('window', { family: 'kimi' })])).toEqual([false])
    // 老卡:hand 是登记表 id,照旧判
    expect(onlineOf([cardOf('codex')])).toEqual([true])
    expect(onlineOf([cardOf('kimi')])).toEqual([false])
  })
})

describe('便签花费一行:取得到才写', () => {
  it('挂着的会话用量加起来 + 事务官那一件的钱;一样都取不到就缺席', () => {
    expect(noteCost(note('a'), {})).toBeUndefined()
    expect(noteCost(note('a', { links: [{ agent: 'codex', session_id: 's' }] }), { 'codex:s': { input: 10000, cache_write: 0, output: 5000 } as never })).toBe('1.5 万 token')
    expect(noteCost(note('a', { budget: { limit_cny: 5, limit_minutes: 30, state: 'running', spent_cny: 1.2 } }), {})).toBe('¥1.20')
  })
})

describe('执行回放:Codex / Claude / 事务官有记录的才回放,窗口型如实说没有', () => {
  it('挂着的会话 + 派活那家的会话;窗口型那家标没有记录', () => {
    const sources = replaySources(note('a', {
      links: [{ agent: 'codex', session_id: 's1' }],
      conversation: { agent: 'dsh', session_id: 'd1' },
      client_dispatch: { hand: 'window', family: 'doubao', status: 'sent', at: AT, text: 'x' } as never,
    }))
    expect(sources).toEqual([
      { agent: 'dsh', session_id: 'd1', recorded: true },
      { agent: 'codex', session_id: 's1', recorded: true },
      { agent: 'doubao', recorded: false },
    ])
  })
})

describe('回执正文不重复说是哪一种', () => {
  it('剥掉开头的「做完:」「有异议 ——」「卡住:」', async () => {
    const { receiptBody } = await import('../src/client/collab/collabModel.ts')
    expect(receiptBody('做完:1 提机 0.6 秒接通')).toBe('1 提机 0.6 秒接通')
    expect(receiptBody('有异议:第三张版权不清楚')).toBe('第三张版权不清楚')
    expect(receiptBody('回执:卡住:没权限')).toBe('没权限')
    expect(receiptBody('中秋是八月十五')).toBe('中秋是八月十五')
  })
})
