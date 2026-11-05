// @vitest-environment node
/**
 * 事务官例程里「不经模型」的那一半(2026-09-15):
 * - 开工汇报三句的拼装:取不到就少一句,数字与记忆文件一致,绝不编数;
 * - 下班例程的机械步骤:布局快照覆盖(手写那节保留)、项目文件只追加不删、索引更新;
 * - 记忆索引重写:一行一文件,分节规则固定。
 */
import { describe, expect, it } from 'vitest'
import type { MeetingView, TodayTodosView, WorkbenchProject, WorkbenchState } from '../src/protocol.ts'
import {
  MEETING_TODAY_HEAD,
  TODAY_TODO_HEAD,
  TODAY_TODO_MAX,
  appendProgress,
  composeMorningReport,
  meetingTodayLines,
  memoryIndexSection,
  mergeLayoutMemory,
  newProjectFile,
  parseMemoryFacts,
  progressLine,
  renderMemoryIndex,
  stateFactsOf,
  todayTodoLines,
  updateProjectIndex,
} from '../src/server/routineMemory.ts'

const PROJECT_A = `# A

- **一句话**:待梳理

## 进展(倒序,一条一日期)
- 2026-09-14:改了登录页(依据:/state)
- 2026-09-10:建档

## 下一步
- 待梳理
`

const PROJECT_B = `# B

## 进展(倒序,一条一日期)
- 2026-09-14:发了 0.2 版
- 2026-09-13:修 bug

## 风险
- 待梳理
`

const USER = `# 用户:Ben

## 自述(Ben 写)
- (待补)

## 观察(事务官/统筹会话追加,倒序)
- 2026-09-14 · 喜欢一次只问一个问题(本次对话)
- 2026-09-10 · 要主动的总管(本次对话)
`

const DECISIONS = `# 决策记录

## 2026-09-14 · 平台顺序(已拍板,Ben)
- 先 Mac。

## 2026-09-11 · 事务官档改版(四处取舍待 Ben 认可)
实现时定的四处,**待拍板**:
1. 落点。

## 2026-09-09 · 任务状态机的三处取舍(**待拍板**)
- 取舍一。
`

function baseState(extra: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [],
    sessions: [],
    quota: {},
    now: '2026-09-15T01:00:00.000Z',
    stale: false,
    ...extra,
  }
}

describe('parseMemoryFacts:从记忆文件数出来的数字', () => {
  it('上次记住了什么 = 最近那一天的进展条数、项目名、观察条数', () => {
    const facts = parseMemoryFacts({
      projects: [{ name: 'A', text: PROJECT_A }, { name: 'B', text: PROJECT_B }],
      user: USER,
      decisions: DECISIONS,
    })
    expect(facts.last).toEqual({ date: '2026-09-14', progress: 2, projects: ['A', 'B'], observations: 1 })
    expect(facts.pending_decisions).toBe(2)
  })

  it('一条带日期的记录都没有 → last 缺席(不编一个日期)', () => {
    const facts = parseMemoryFacts({ projects: [{ name: 'A', text: '# A\n\n## 进展\n- 待梳理\n' }] })
    expect(facts.last).toBeUndefined()
    expect(facts.pending_decisions).toBeUndefined()
  })

  it('进展只认「## 进展」那一节里的日期行,别的节里的日期不算', () => {
    const text = '# C\n\n## 进展\n- 2026-09-12:x\n\n## 历史决定\n- 2026-09-14:这不是进展\n'
    const facts = parseMemoryFacts({ projects: [{ name: 'C', text }] })
    expect(facts.last).toEqual({ date: '2026-09-12', progress: 1, projects: ['C'], observations: 0 })
  })
})

describe('composeMorningReport:三句加一问,取不到就少一句', () => {
  const facts = parseMemoryFacts({
    projects: [{ name: 'A', text: PROJECT_A }, { name: 'B', text: PROJECT_B }],
    user: USER,
    decisions: DECISIONS,
  })

  it('三块都齐:三句 + 问句,数字与记忆文件一致', () => {
    const state = stateFactsOf(baseState({
      sessions: [
        { agent: 'dsh', session_id: 's1', project: 'x', status: 'running', elapsed_sec: 1, unread: false, updated_at: '' },
        { agent: 'dsh', session_id: 's2', project: 'x', status: 'waiting', elapsed_sec: 1, unread: false, updated_at: '' },
        { agent: 'claude', session_id: 's3', project: 'x', status: 'running', elapsed_sec: 1, unread: false, updated_at: '' },
      ],
      sentinel: { watches: [{ id: 'w1', kind: 'file', target: '/x', note: 'n', interval_sec: 60, enabled: true, created_at: '' } as never] },
      tasks: { tasks: [{ id: 't1', title: 'x', status: 'confirm', created_at: '', updated_at: '' }], sprints: [], modules: [], project_meta: {} } as never,
      projects: {
        projects: [{ id: 'p', name: 'P', stage: 'mvp', links: [], session_count: 0, idle: false, risk: { level: 'late', reason: 'r', window_days: 14 } } as never],
        pending: [], scan_errors: [], scanned_at: '',
      },
    }))
    const report = composeMorningReport({ memory: facts, state })
    expect(report.sentences).toEqual([
      '上次 9月14日 记了 2 个项目的进展(A、B)、1 条关于你的观察。',
      '今天在盯:哨兵 1 项、1 条会话在跑、1 条在等你、1 个项目排期赶不上。',
      '等你拍板:决策记录 2 段待拍板、1 张卡等你确认。',
    ])
    expect(report.question).toBe('今天先做哪件?')
    expect(report.text).toBe(`${report.sentences.join('\n')}\n今天先做哪件?`)
  })

  it('停太久的那一段(2026-10-12):排在三句之后、进度之前;缺席或空 = 逐字相同', () => {
    const state = stateFactsOf(baseState())
    const plain = composeMorningReport({ state })
    expect(composeMorningReport({ state, stalled: [] }).text).toBe(plain.text)
    const report = composeMorningReport({ state, stalled: ['停太久的几件:', '- 「a」:停了 3 天;看一眼'], progress: ['进度那一行'] })
    expect(report.text).toBe('今天没有在盯的事。\n\n停太久的几件:\n- 「a」:停了 3 天;看一眼\n\n进度那一行\n今天先做哪件?')
  })

  it('没有记忆仓库 → 第一句没有;/state 里没有 tasks 与决策记录 → 第三句没有;不编 0', () => {
    const report = composeMorningReport({ state: stateFactsOf(baseState()) })
    expect(report.sentences).toEqual(['今天没有在盯的事。'])
    expect(report.text).toBe('今天没有在盯的事。\n今天先做哪件?')
  })

  it('有决策记录但一段待拍板都没有、看板没有等确认的卡 → 如实说「没有等你拍板的」', () => {
    const memory = parseMemoryFacts({ projects: [], decisions: '# 决策记录\n\n## 2026-09-14 · x(已拍板)\n- y\n' })
    const state = stateFactsOf(baseState({ tasks: { tasks: [], sprints: [], modules: [], project_meta: {} } as never }))
    const report = composeMorningReport({ memory, state })
    expect(report.sentences).toEqual(['今天没有在盯的事。', '没有等你拍板的。'])
  })

  it('哨兵 0 项、会话 0 条时那几段不说,不写「哨兵 0 项」', () => {
    const state = stateFactsOf(baseState({
      sentinel: { watches: [] },
      projects: { projects: [], pending: [], scan_errors: [], scanned_at: '' },
    }))
    expect(composeMorningReport({ state }).sentences).toEqual(['今天没有在盯的事。'])
  })

  it('项目多于三个只点前三个名字,后面加「等」', () => {
    const many = ['A', 'B', 'C', 'D'].map(name => ({ name, text: `# ${name}\n\n## 进展\n- 2026-09-14:x\n` }))
    const report = composeMorningReport({ memory: parseMemoryFacts({ projects: many }), state: stateFactsOf(baseState()) })
    expect(report.sentences[0]).toBe('上次 9月14日 记了 4 个项目的进展(A、B、C 等)。')
  })
})

/** 本机时区的 `YYYY-MM-DD HH:MM` → ISO(不写死时区,换台机器跑结果一样)。 */
function isoAt(day: string, hhmm: string): string {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number]
  const [h, mi] = hhmm.split(':').map(Number) as [number, number]
  return new Date(y, mo - 1, d, h, mi).toISOString()
}

function planned(over: Partial<MeetingView> = {}): MeetingView {
  return {
    id: 'm1',
    title: '跟品牌方对脚本',
    date: '2026-09-15',
    started_at: isoAt('2026-09-15', '09:00'),
    status: 'planned',
    segments: 0,
    todos: [],
    unsure: [],
    prep: { said: '下午两点跟品牌方对脚本', card_status: 'ready' },
    ...over,
  }
}

describe('早报里的「今天要开的会」(2026-10-13):素材全在 /state.meetings.upcoming,不另起扫描', () => {
  it('今天那几场才念;一场都没有 → 空数组(不写「今天没有会」)', () => {
    expect(meetingTodayLines([], '2026-09-15')).toEqual([])
    const others = [planned({ id: 'y', date: '2026-09-14' }), planned({ id: 't', date: '2026-09-16' })]
    expect(meetingTodayLines(others, '2026-09-15')).toEqual([])
  })

  it('一行写几点、跟谁、预案卡好了没', () => {
    const lines = meetingTodayLines([planned({
      prep: {
        said: '下午两点跟品牌方对脚本',
        when: '下午两点',
        scheduled_at: isoAt('2026-09-15', '14:00'),
        people: { value: [{ alias: '小林' }, { alias: '阿杜' }], from: 'said' },
        card_status: 'ready',
      },
    })], '2026-09-15')
    expect(lines[0]).toBe(MEETING_TODAY_HEAD)
    expect(lines[1]).toBe('- 14:00「跟品牌方对脚本」(跟 小林、阿杜);预案卡好了')
    expect(lines).toHaveLength(2)
  })

  it('还差哪一问就先说那一问(预案卡的状态让位)', () => {
    const lines = meetingTodayLines([planned({
      prep: {
        said: '今天跟品牌方对脚本',
        scheduled_at: isoAt('2026-09-15', '14:00'),
        card_status: 'answers',
        ask: { id: 'scope', text: '这是内部会还是外部会?' },
      },
    })], '2026-09-15')
    expect(lines[1]).toBe('- 14:00「跟品牌方对脚本」;还差一问:这是内部会还是外部会?')
  })

  it('几点说不准就用她那句原话;连那句都没有也不编时刻', () => {
    const vague = meetingTodayLines([planned({ prep: { said: '今天下午跟品牌方对脚本', when: '下午', card_status: 'making' } })], '2026-09-15')
    expect(vague[1]).toBe('- 下午「跟品牌方对脚本」;预案卡在做')
    const none = meetingTodayLines([planned({ prep: { said: '跟品牌方对脚本', card_status: 'failed', card_error: '额度到了' } })], '2026-09-15')
    expect(none[1]).toBe('- 没说几点「跟品牌方对脚本」;预案卡没做成(额度到了)')
  })

  it('目的还没说清 → 如实说是在等她一句,不说预案卡好了没', () => {
    const lines = meetingTodayLines([planned({
      prep: { said: '今天开个会', scheduled_at: isoAt('2026-09-15', '10:30'), card_status: 'goal', goal_unclear: true },
    })], '2026-09-15')
    expect(lines[1]).toBe('- 10:30「跟品牌方对脚本」;目的还没说清,等你一句')
  })
})

describe('早报里的「今天的待办」(2026-10-13):读 /state.today_todos,最多 5 条', () => {
  function view(items: TodayTodosView['items']): TodayTodosView {
    return { date: '2026-09-15', tomorrow: '2026-09-16', items }
  }

  it('没接(缺席)、一条都没有、今天的都办完了 → 空数组', () => {
    expect(todayTodoLines(undefined)).toEqual([])
    expect(todayTodoLines(view([]))).toEqual([])
    expect(todayTodoLines(view([{ id: 'a', title: '发那条片子', due: '2026-09-15', done: true, overdue: false }]))).toEqual([])
  })

  it('还没办的照原样念,逾期的写明原定哪天;已办完的不念', () => {
    const lines = todayTodoLines(view([
      { id: 'a', title: '剪完周五那条', due: '2026-09-15', done: false, overdue: false },
      { id: 'b', title: '回品牌方的脚本', due: '2026-09-12', done: false, overdue: true },
      { id: 'c', title: '发那条片子', due: '2026-09-15', done: true, overdue: false },
    ]))
    expect(lines).toEqual([
      TODAY_TODO_HEAD,
      '- 「剪完周五那条」',
      '- 「回品牌方的脚本」(逾期,原定 9月12日)',
    ])
  })

  it('超过 5 条只念 5 条,末尾一行「还有 N 条」', () => {
    const many = Array.from({ length: TODAY_TODO_MAX + 3 }, (_, i) => ({
      id: `t${i}`, title: `第 ${i + 1} 件`, due: '2026-09-15', done: false, overdue: false,
    }))
    const lines = todayTodoLines(view(many))
    expect(lines).toHaveLength(1 + TODAY_TODO_MAX + 1)
    expect(lines[1]).toBe('- 「第 1 件」')
    expect(lines[TODAY_TODO_MAX]).toBe(`- 「第 ${TODAY_TODO_MAX} 件」`)
    expect(lines[TODAY_TODO_MAX + 1]).toBe('还有 3 条')
  })
})

describe('composeMorningReport:今天的会与今天的待办两段(2026-10-13)', () => {
  it('排在三句之后、停太久之前;缺席或空 = 逐字相同', () => {
    const state = stateFactsOf(baseState())
    const plain = composeMorningReport({ state })
    expect(composeMorningReport({ state, meetings: [], todos: [] }).text).toBe(plain.text)
    const report = composeMorningReport({
      state,
      meetings: [MEETING_TODAY_HEAD, '- 14:00「对脚本」;预案卡好了'],
      todos: [TODAY_TODO_HEAD, '- 「剪完周五那条」'],
      stalled: ['停太久的几件:', '- 「a」:停了 3 天;看一眼'],
    })
    expect(report.text).toBe([
      '今天没有在盯的事。',
      '',
      `${MEETING_TODAY_HEAD}\n- 14:00「对脚本」;预案卡好了`,
      '',
      `${TODAY_TODO_HEAD}\n- 「剪完周五那条」`,
      '',
      '停太久的几件:\n- 「a」:停了 3 天;看一眼',
    ].join('\n') + '\n今天先做哪件?')
  })
})

describe('appendProgress:只追加不删', () => {
  it('新的一条插在「## 进展」标题下面第一行(倒序),旧内容一字不动', () => {
    const { text, changed } = appendProgress(PROJECT_A, '- 2026-09-15:今天有活动(依据:/state)')
    expect(changed).toBe(true)
    const lines = text.split('\n')
    const heading = lines.findIndex(line => line.startsWith('## 进展'))
    expect(lines[heading + 1]).toBe('- 2026-09-15:今天有活动(依据:/state)')
    expect(lines[heading + 2]).toBe('- 2026-09-14:改了登录页(依据:/state)')
    // 旧文件的每一行都还在,而且顺序不变。
    const old = PROJECT_A.split('\n')
    let cursor = 0
    for (const line of old) {
      const at = lines.indexOf(line, cursor)
      expect(at, `旧行不见了:${line}`).toBeGreaterThanOrEqual(cursor)
      cursor = at + 1
    }
  })

  it('同一条已经在了 → 不重复追加(同一天跑两次下班例程)', () => {
    const once = appendProgress(PROJECT_A, '- 2026-09-15:x').text
    const twice = appendProgress(once, '- 2026-09-15:x')
    expect(twice.changed).toBe(false)
    expect(twice.text).toBe(once)
  })

  it('文件里没有「## 进展」节 → 在末尾补一节再追加,不改前面', () => {
    const { text } = appendProgress('# X\n\n- **一句话**:y\n', '- 2026-09-15:z')
    expect(text.startsWith('# X\n\n- **一句话**:y\n')).toBe(true)
    expect(text).toContain('## 进展(倒序,一条一日期)\n- 2026-09-15:z')
  })
})

describe('progressLine:一条进展怎么写', () => {
  const project: WorkbenchProject = {
    id: 'p1', name: 'A', stage: 'MVP 开发', path: '/x/A', links: [], session_count: 0, idle: false,
    signals: { branch: 'main', dirty_count: 3, worktrees: 1, cleanup_count: 0, idle_days: 0, recent_commits: 5 },
  }

  it('带日期、依据与数字;有任务板时带卡的数', () => {
    const line = progressLine(project, '2026-09-15', {
      tasks: [
        { id: 't1', title: 'a', status: 'doing', project_id: 'p1', created_at: '', updated_at: '' },
        { id: 't2', title: 'b', status: 'done', project_id: 'p1', done_at: '2026-09-15T08:00:00.000Z', created_at: '', updated_at: '' },
        { id: 't3', title: 'c', status: 'done', project_id: 'other', done_at: '2026-09-15T08:00:00.000Z', created_at: '', updated_at: '' },
      ],
      sprints: [], modules: [], project_meta: {},
    } as never)
    expect(line).toBe('- 2026-09-15:今天有活动——分支 `main`,未提交 3 处,近 14 天 5 次提交;看板:在办 1 张、今天办完 1 张(依据:/state.projects[A].signals、/state.tasks;下班例程自动追加)')
  })

  it('没有任务板 → 看板那一段整段不写;recent_commits 缺席也不写 0', () => {
    const line = progressLine({ ...project, signals: { ...project.signals!, recent_commits: undefined } as never }, '2026-09-15')
    expect(line).toBe('- 2026-09-15:今天有活动——分支 `main`,未提交 3 处(依据:/state.projects[A].signals;下班例程自动追加)')
  })
})

describe('newProjectFile:新项目建档', () => {
  it('字段固定,第一条进展是建档', () => {
    const text = newProjectFile('Z', '/x/Z', '2026-09-15')
    expect(text.startsWith('# Z\n')).toBe(true)
    expect(text).toContain('- **路径**:`/x/Z`')
    expect(text).toContain('## 进展(倒序,一条一日期)\n- 2026-09-15:建档(下班例程按项目区扫描生成,内容待事务官梳理核实)')
  })
})

describe('updateProjectIndex:只改「最近活动」列与快照日期', () => {
  const INDEX = `# 项目索引(快照 2026-09-10)

> 一行一个项目。

| 项目 | 一句话 | 阶段 | 最近活动 | 路径 | 文件 |
|---|---|---|---|---|---|
| A | 做 A 的 | MVP 开发 | 闲置 3 天 | \`/x/A\` | [项目/A.md](项目/A.md) |
| B | 待梳理 | 待梳理 | 今天在动 | \`/x/B\` | [项目/B.md](项目/B.md) |
`

  it('按 signals 改活动列;没给 signals 的行不动;新项目补一行', () => {
    const text = updateProjectIndex(INDEX, '2026-09-15', [
      { name: 'A', idle_days: 0, path: '/x/A' },
      { name: 'Z', idle_days: 0, path: '/x/Z' },
    ])
    expect(text).toContain('# 项目索引(快照 2026-09-15)')
    expect(text).toContain('| A | 做 A 的 | MVP 开发 | 今天在动 | `/x/A` | [项目/A.md](项目/A.md) |')
    expect(text).toContain('| B | 待梳理 | 待梳理 | 今天在动 | `/x/B` | [项目/B.md](项目/B.md) |')
    expect(text).toContain('| Z | 待梳理 | 待梳理 | 今天在动 | `/x/Z` | [项目/Z.md](项目/Z.md) |')
  })

  it('闲置天数写成「闲置 N 天」', () => {
    const text = updateProjectIndex(INDEX, '2026-09-15', [{ name: 'B', idle_days: 4, path: '/x/B' }])
    expect(text).toContain('| B | 待梳理 | 待梳理 | 闲置 4 天 | `/x/B` |')
  })
})

describe('mergeLayoutMemory:快照覆盖,手写那一节保留', () => {
  const GENERATED = '# 工作台布局(快照 2026-09-15)\n\n## 模块与位置\n| a |\n\n## 字段来源\n- x\n'
  const EXISTING = '# 工作台布局(快照 2026-09-10)\n\n## 模块与位置\n| 旧 |\n\n## 每个模块里有什么(能力清单的 UI 视角)\n- 项目区:总览\n- 随手记:便签\n\n## 怎么重新生成\n读 /state\n'

  it('生成的部分整段替换,「每个模块里有什么」原样接在字段来源之前', () => {
    const text = mergeLayoutMemory(GENERATED, EXISTING)
    expect(text).not.toContain('| 旧 |')
    expect(text).toContain('## 每个模块里有什么(能力清单的 UI 视角)\n- 项目区:总览\n- 随手记:便签\n')
    expect(text.indexOf('## 每个模块里有什么')).toBeLessThan(text.indexOf('## 字段来源'))
    expect(text).not.toContain('## 怎么重新生成')
  })

  it('没有旧文件 → 就是生成的那份', () => {
    expect(mergeLayoutMemory(GENERATED, undefined)).toBe(GENERATED)
  })
})

describe('renderMemoryIndex:一行一文件', () => {
  it('分节规则固定;每行 = 文件 — 标题 — 一句话 — 日期', () => {
    expect(memoryIndexSection('决策记录.md')).toBe('事实与决定(先读)')
    expect(memoryIndexSection('记忆/用户-Ben.md')).toBe('记忆')
    expect(memoryIndexSection('记忆/项目/A.md')).toBe('记忆·项目')
    expect(memoryIndexSection('设计-x.md')).toBe('设计')
    expect(memoryIndexSection('交接-0915-x.md')).toBe('交接(过程)')
    expect(memoryIndexSection('superpowers/research/x.md')).toBe('调研与审计')
    expect(memoryIndexSection('superpowers/specs/x.md')).toBe('规格')
    expect(memoryIndexSection('superpowers/plans/x.md')).toBe('计划(历史)')
    expect(memoryIndexSection('计划-x.md')).toBe('计划(历史)')
    expect(memoryIndexSection('project-memory/x.md')).toBe('记忆副本(~/.claude 的镜像)')
    expect(memoryIndexSection('硬件-x.md')).toBe('其它')

    const text = renderMemoryIndex([
      { rel: '决策记录.md', title: '决策记录', summary: '一条一段', date: '2026-09-14' },
      { rel: '记忆/项目/A.md', title: 'A', summary: '项目记忆文件', date: '2026-09-15' },
      { rel: '交接-0915-x.md', title: '交接 x', summary: '', date: '2026-09-15' },
    ], '2026-09-15')
    expect(text.startsWith('# 记忆索引(全仓库 docs 一行一文件;2026-09-15 由下班例程重写)')).toBe(true)
    expect(text).toContain('## 事实与决定(先读)\n- [docs/决策记录.md](决策记录.md) — 决策记录 — 一条一段 — 2026-09-14')
    expect(text).toContain('## 记忆·项目\n- [docs/记忆/项目/A.md](记忆/项目/A.md) — A — 项目记忆文件 — 2026-09-15')
    expect(text).toContain('- [docs/交接-0915-x.md](交接-0915-x.md) — 交接 x — 2026-09-15')
    expect(text).not.toContain('## 记忆\n\n')
  })
})
