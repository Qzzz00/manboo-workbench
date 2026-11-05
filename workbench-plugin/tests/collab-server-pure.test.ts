// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionView, TaskView, WorkbenchProject } from '../src/protocol.ts'
import { createPresenceBoard, presenceOfJob, PRESENCE_TTL_MS } from '../src/server/collabPresence.ts'
import { sessionProposals, singleOpenGoal } from '../src/server/collabProposals.ts'
import { canvasFileOf, layoutOfCanvas, parseLayout } from '../src/server/collabCanvas.ts'
import { createPersonalTokens, PERSONAL_TOKEN_PREFIX } from '../src/server/personalToken.ts'
import { goalRisks } from '../src/server/collabRisk.ts'

const AT = '2026-10-21T09:00:00.000Z'

describe('Agent 小鼠标:由任务账的事件推(设计稿 3.4 表)', () => {
  const on = (step: Parameters<typeof presenceOfJob>[0]['step']) => presenceOfJob({ at: AT, job: 't-1', step, family: 'codex' })
  it('指派 → 滑向便签;送达 → 在便签上干活;交回 → 盖章', () => {
    expect(on('assigned')).toEqual({ actor: { kind: 'agent', id: 'codex' }, on_note: 't-1', state: 'moving', at: AT })
    expect(on('sent')?.state).toBe('working')
    expect(on('seen')?.state).toBe('working')
    expect(on('waiting')).toMatchObject({ on_note: 't-1', state: 'working' })
    expect(on('replied')?.state).toBe('stamping')
    expect(on('done')?.state).toBe('stamping')
  })
  it('超时 / 读不到 / 没送出 / 闸拦下 / 到上限 → 回名片(没有 on_note)', () => {
    for (const step of ['timeout', 'unreadable', 'not_sent', 'gate_block', 'budget_stop'] as const) {
      expect(on(step)).toEqual({ actor: { kind: 'agent', id: 'codex' }, state: 'idle', at: AT })
    }
  })
  it('电话、闸放行这类与板无关;没写哪一家的不画', () => {
    expect(on('called')).toBeUndefined()
    expect(on('gate_pass')).toBeUndefined()
    expect(presenceOfJob({ at: AT, job: 't-1', step: 'assigned' })).toBeUndefined()
  })
  it('在内存里记每个 Agent 最后一个样子,过时的不再给', () => {
    let now = Date.parse(AT)
    const board = createPresenceBoard(() => now)
    board.apply({ actor: { kind: 'agent', id: 'codex' }, on_note: 't-1', state: 'working', at: AT })
    board.apply({ actor: { kind: 'agent', id: 'codex' }, state: 'idle', at: AT })
    expect(board.list()).toEqual([{ actor: { kind: 'agent', id: 'codex' }, state: 'idle', at: AT }])
    now += PRESENCE_TTL_MS + 1
    expect(board.list()).toEqual([])
  })
})

describe('他直接开的会话:提议挂到哪个目标', () => {
  const session = (patch: Partial<SessionView>): SessionView => ({
    agent: 'codex', session_id: 's-1', project: 'desktop-workbench', status: 'running', elapsed_sec: 10, unread: false, updated_at: AT, title: '修铃声', ...patch,
  }) as SessionView
  const project = { id: 'desktop-workbench', name: 'desktop-workbench', stage: 'active', links: [], session_count: 1, idle: false, path: '/repo' } as unknown as WorkbenchProject
  const note = (patch: Partial<TaskView>): TaskView => ({ id: 't-1', title: 'x', status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })

  it('认得项目 → 挂到那个项目最近一个还在推的目标', () => {
    const got = sessionProposals({
      sessions: [session({})],
      tasks: [],
      goals: [
        { id: 'g-old', title: '旧', owner: 'me', status: 'open', project_id: 'desktop-workbench', created_at: AT, updated_at: '2026-10-01T00:00:00.000Z' },
        { id: 'g-new', title: '座机', owner: 'me', status: 'open', project_id: 'desktop-workbench', created_at: AT, updated_at: AT },
        { id: 'g-done', title: '完了', owner: 'me', status: 'reached', project_id: 'desktop-workbench', created_at: AT, updated_at: '2026-10-21T10:00:00.000Z' },
      ],
      projects: [project],
      dismissed: [],
      nowMs: Date.parse(AT),
    })
    expect(got).toEqual([{ agent: 'codex', session_id: 's-1', title: '修铃声', project_id: 'desktop-workbench', goal_id: 'g-new', at: AT }])
  })
  // 10-22 第三轮 4(维护者定 B):有几个目标时默认选中按会话标题与目标名匹配度最高的那个。
  // 10-28 任务书 11(维护者 15:0x「这种能不能别问我」):对得上就带 goal_id 直接放,不问。
  it('多个目标、标题对得上 → 带 goal_id(直接放,不问)', () => {
    const got = sessionProposals({
      sessions: [session({ title: '座机铃声换一版' })],
      tasks: [],
      goals: [
        { id: 'g-new', title: '登录页', owner: 'me', status: 'open', project_id: 'desktop-workbench', created_at: AT, updated_at: AT },
        { id: 'g-phone', title: '座机来电', owner: 'me', status: 'open', created_at: AT, updated_at: '2026-10-01T00:00:00.000Z' },
      ],
      projects: [project],
      dismissed: [],
      nowMs: Date.parse(AT),
    })
    expect(got[0]?.goal_id).toBe('g-phone')
  })
  it('只有一个还在推的目标时给出它(直接放进去);零个或多个都不给', () => {
    const goal = (id: string, status: 'open' | 'reached') => ({ id, title: id, owner: 'me' as const, status, created_at: AT, updated_at: AT })
    expect(singleOpenGoal([goal('g-1', 'open'), goal('g-2', 'reached')])).toBe('g-1')
    expect(singleOpenGoal([])).toBeUndefined()
    expect(singleOpenGoal([goal('g-1', 'open'), goal('g-2', 'open')])).toBeUndefined()
  })
  // 10-28 任务书 11:标题与目标名有共同片段、或会话项目与目标同一个项目,才算对得上;都对不上不猜,留给她选(问时默认新目标)。
  it('多个在推目标、标题与项目都对不上 → 不猜,提议新目标(问,默认选项)', () => {
    const got = sessionProposals({
      sessions: [session({ title: '修铃声', project: '别处' })],
      tasks: [],
      goals: [
        { id: 'g-web', title: '登录页', owner: 'me', status: 'open', created_at: AT, updated_at: AT },
        { id: 'g-site', title: '官网', owner: 'me', status: 'open', created_at: AT, updated_at: AT },
      ],
      projects: [project],
      dismissed: [],
      nowMs: Date.parse(AT),
    })
    expect(got[0]).toMatchObject({ new_goal_title: '修铃声' })
    expect(got[0]?.goal_id).toBeUndefined()
  })
  it('认不出目标 → 提议新目标〈标题〉', () => {
    const got = sessionProposals({ sessions: [session({ project: '别的' })], tasks: [], goals: [], projects: [], dismissed: [], nowMs: Date.parse(AT) })
    expect(got[0]).toMatchObject({ new_goal_title: '修铃声' })
    expect(got[0]?.goal_id).toBeUndefined()
  })
  it('已经挂在某张便签上的、事务官自己的、他说过「不挂」的、三天前的都不提', () => {
    const got = sessionProposals({
      sessions: [
        session({ session_id: 'linked' }),
        session({ agent: 'dsh', session_id: 'mine' }),
        session({ session_id: 'nope' }),
        session({ session_id: 'old', updated_at: '2026-10-10T00:00:00.000Z' }),
      ],
      tasks: [note({ links: [{ agent: 'codex', session_id: 'linked' }] })],
      goals: [],
      projects: [],
      dismissed: ['codex:nope'],
      nowMs: Date.parse(AT),
    })
    expect(got).toEqual([])
  })
})

describe('板.canvas:JSON Canvas,只存位置与分组', () => {
  it('布局 → 文件 → 布局 往返;目标是 group,便签是 text(text 写标题)', () => {
    const layout = { goals: { 'g-1': { x: 0, y: 0, w: 400, h: 300 } }, notes: { 't-1': { x: 20, y: 40 } } }
    const file = canvasFileOf(layout, { goals: [{ id: 'g-1', title: '座机' }], notes: [{ id: 't-1', title: '换铃声' }] })
    expect(file.nodes).toContainEqual(expect.objectContaining({ id: 'g-1', type: 'group', label: '座机', x: 0, y: 0, width: 400, height: 300 }))
    expect(file.nodes).toContainEqual(expect.objectContaining({ id: 't-1', type: 'text', text: '换铃声', x: 20, y: 40 }))
    expect(file.edges).toEqual([])
    expect(layoutOfCanvas(file)).toEqual(layout)
  })
  it('只认数字坐标;坏节点挑掉', () => {
    expect(layoutOfCanvas({ nodes: [{ id: 'x', type: 'text', x: 'a', y: 0 }, { id: 't-2', type: 'text', x: 1, y: 2, wb: { kind: 'note' } }], edges: [] }))
      .toEqual({ goals: {}, notes: { 't-2': { x: 1, y: 2 } } })
    expect(parseLayout({ goals: { g: { x: 1, y: 2, w: 3, h: 4 } }, notes: { n: { x: 'bad' } } })).toEqual({ goals: { g: { x: 1, y: 2, w: 3, h: 4 } }, notes: {} })
  })
})

describe('个人访问令牌:只显示一次、存哈希', () => {
  it('发一枚 → 盘上只有哈希;认得它、认不得别的;收回后谁都认不得', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'pat-')), 'personal-token.json')
    const tokens = createPersonalTokens({ file, now: () => new Date(AT) })
    expect(await tokens.status()).toEqual({ issued: false })
    const token = await tokens.issue()
    expect(token.startsWith(PERSONAL_TOKEN_PREFIX)).toBe(true)
    const disk = await readFile(file, 'utf8')
    expect(disk).not.toContain(token)
    expect(await tokens.verify(token)).toBe(true)
    expect(await tokens.verify(`${token}x`)).toBe(false)
    expect(await tokens.status()).toMatchObject({ issued: true, created_at: AT })
    await tokens.revoke()
    expect(await tokens.verify(token)).toBe(false)
  })
})

describe('排期风险只在目标有截止日时算', () => {
  it('没有 due 的目标不算', () => {
    const risks = goalRisks([
      { id: 'g-1', title: 'a', owner: 'me', status: 'open', created_at: AT, updated_at: AT },
      { id: 'g-2', title: 'b', owner: 'me', status: 'open', due: '2026-10-22', created_at: AT, updated_at: AT },
    ], [{ id: 't', title: 't', status: 'todo', goal_id: 'g-2', source: { kind: 'manual' }, created_at: AT, updated_at: AT }], Date.parse(AT) / 1000)
    expect(risks['g-1']).toBeUndefined()
    expect(risks['g-2']?.level).toBeDefined()
  })
})
