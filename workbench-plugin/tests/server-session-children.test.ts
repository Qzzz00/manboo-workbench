// @vitest-environment node
/**
 * 后台任务挂在主会话上(2026-09-25,卡 Q;设计第六节)。
 *
 * 维护者:「这种后台任务,事务官是看不到的,我其实也不建议分开展示,卡片会非常多,事务官的卡片里可以改成一张卡片里有
 * 后台任务的说明,就是多一层的意思」。这里用一条**假的 Claude 会话**(临时目录里,记录的格式照这台 Mac 上真的子代理记录):
 * 主会话旁边 `subagents/` 里三个子代理 —— 两个在跑、一个说完了。它们挂在主会话的 `children` 上,不单独成一条会话;
 * 事务官派出去的活从看板读,挂在派它的那条事务官会话底下。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { sessionBusy, sessionChildLine, sessionChildrenLine } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import type { SessionChildren } from '../src/server/sessionChildren.ts'
import { CHILD_DONE_KEEP_MS, CHILD_ORPHAN_MS, CHILD_STALE_MS, claudeChild, createSessionChildren, dispatchChild, readClaudeChildren, withAskedChild } from '../src/server/sessionChildren.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const NOW = Date.parse('2026-09-25T12:30:00.000Z')

/** 一个子代理的记录(每行一条,同真的 Claude 子代理记录:isSidechain、agentId、message.model、stop_reason)。 */
function agentLog(id: string, rows: { type: 'user' | 'assistant' | 'attachment', at: string, text?: string, tool?: { name: string, input: Record<string, unknown> }, end?: boolean }[]): string {
  return rows.map((row) => {
    const content = row.tool !== undefined
      ? [{ type: 'tool_use', id: 'toolu_x', name: row.tool.name, input: row.tool.input }]
      : row.type === 'user' && row.text !== undefined ? row.text : [{ type: 'text', text: row.text ?? '' }]
    const message = row.type === 'attachment'
      ? undefined
      : { role: row.type, content, ...(row.type === 'assistant' ? { model: 'claude-opus-5-5', stop_reason: row.end === true ? 'end_turn' : row.tool !== undefined ? 'tool_use' : null } : {}) }
    return JSON.stringify({ type: row.type, timestamp: row.at, isSidechain: true, agentId: id, sessionId: 'parent-1', ...(message === undefined ? { attachment: {} } : { message }) })
  }).join('\n') + '\n'
}

/** 临时目录里一条 Claude 主会话 + 三个子代理(两个在跑、一个说完了)。 */
function fakeClaudeSession(): { transcript: string } {
  const root = mkdtempSync(join(tmpdir(), 'wb-children-'))
  dirs.push(root)
  const project = join(root, 'projects', '-Users-ben-proj')
  mkdirSync(join(project, 'parent-1', 'subagents'), { recursive: true })
  const transcript = join(project, 'parent-1.jsonl')
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: '2026-09-25T12:00:00.000Z', message: { role: 'user', content: '把这几张卡派下去' } })}\n`)
  const sub = join(project, 'parent-1', 'subagents')
  const write = (id: string, description: string, log: string, mtime: number): void => {
    writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description, requestShape: 'background' }))
    writeFileSync(join(sub, `agent-${id}.jsonl`), log)
    utimesSync(join(sub, `agent-${id}.jsonl`), new Date(mtime), new Date(mtime))
  }
  write('a1', '卡 T:在等你看内容', agentLog('a1', [
    { type: 'user', at: '2026-09-25T12:01:00.000Z', text: '你是卡 T……' },
    { type: 'assistant', at: '2026-09-25T12:20:00.000Z', text: '先把会话里最后一问认出来。' },
    { type: 'assistant', at: '2026-09-25T12:28:00.000Z', tool: { name: 'Bash', input: { command: 'npx vitest run tests/waiting.test.ts' } } },
    { type: 'attachment', at: '2026-09-25T12:28:01.000Z' },
  ]), NOW - 60_000)
  write('a2', '卡 O:派活的眼睛', agentLog('a2', [
    { type: 'user', at: '2026-09-25T12:02:00.000Z', text: '你是卡 O……' },
    { type: 'assistant', at: '2026-09-25T12:29:00.000Z', tool: { name: 'Edit', input: { file_path: '/x/agentQuota.ts' } } },
  ]), NOW - 30_000)
  write('a3', '卡 P:会话标题', agentLog('a3', [
    { type: 'user', at: '2026-09-25T11:00:00.000Z', text: '你是卡 P……' },
    { type: 'assistant', at: '2026-09-25T11:40:00.000Z', text: '做完了,提交号 b21048c2。', end: true },
  ]), NOW - 50 * 60_000)
  return { transcript }
}

function claudeSession(over: Partial<SessionView> = {}): SessionView {
  return { agent: 'claude', session_id: 'parent-1', project: 'workbench', status: 'done', elapsed_sec: 600, unread: false, updated_at: '2026-09-25T12:10:00.000Z', ...over }
}

describe('一个 Claude 子代理的记录 → 一项后台任务', () => {
  it('说完了的(end_turn)→ 办完了,在做什么是它最后那句话;描述是派它时写的那一句;型号记下(界面不露)', () => {
    const child = claudeChild({
      id: 'a3', parent: 'parent-1', meta: { description: '卡 P:会话标题' },
      head: agentLog('a3', [{ type: 'user', at: '2026-09-25T11:00:00.000Z', text: '你是卡 P' }]),
      tail: agentLog('a3', [{ type: 'assistant', at: '2026-09-25T11:40:00.000Z', text: '做完了,提交号 b21048c2。', end: true }]),
      mtimeMs: NOW - 50 * 60_000, nowMs: NOW,
    })
    expect(child).toMatchObject({ id: 'a3', parent_session_id: 'parent-1', title: '卡 P:会话标题', status: 'done', started_at: '2026-09-25T11:00:00.000Z', ended_at: '2026-09-25T11:40:00.000Z', model: 'claude-opus-5-5' })
    expect(child.activity?.line).toContain('做完了')
  })

  it('最后在用工具、记录刚动过 → 在跑,在做什么说人话(不露工具名);一小时没动又没说完 → 当它停了', () => {
    const tail = agentLog('a1', [{ type: 'assistant', at: '2026-09-25T12:28:00.000Z', tool: { name: 'Bash', input: { command: 'npx vitest run' } } }])
    const running = claudeChild({ id: 'a1', parent: 'parent-1', head: '', tail, mtimeMs: NOW - 60_000, nowMs: NOW })
    expect(running.status).toBe('running')
    expect(running.activity?.line).toBe('在跑测试')
    expect(running.ended_at).toBeUndefined()
    expect(running.title).toBe('一项后台任务')
    const stale = claudeChild({ id: 'a1', parent: 'parent-1', head: '', tail, mtimeMs: NOW - CHILD_STALE_MS - 1, nowMs: NOW })
    expect(stale.status).toBe('done')
  })

  /**
   * 2026-09-26 晚(统筹):维护者关掉了旧统筹那个窗口,它派的卡 AC 跟着被掐掉,最后一条记录是一次工具调用 ——
   * 没说完、也不会再写。原来要等满一小时才当它停了,这一小时里旧统筹那张卡一直写「在跑 1」、坞上 Claude 数成 2。
   * **主会话自己也 20 分钟没动**时,子代理 20 分钟没动就当它停了(主会话还在动就照旧等一小时:它可能在等一个长任务)。
   */
  it('主会话也不动了:子代理 20 分钟没动又没说完 → 当它停了;主会话还在动 → 照旧等满一小时', () => {
    const tail = agentLog('a1', [{ type: 'assistant', at: '2026-09-25T12:28:00.000Z', tool: { name: 'Bash', input: { command: 'npx vitest run' } } }])
    const silent = NOW - CHILD_ORPHAN_MS - 1
    expect(claudeChild({ id: 'a1', parent: 'p', head: '', tail, mtimeMs: silent, nowMs: NOW, parentMtimeMs: NOW - CHILD_ORPHAN_MS - 1 }).status).toBe('done')
    expect(claudeChild({ id: 'a1', parent: 'p', head: '', tail, mtimeMs: silent, nowMs: NOW, parentMtimeMs: NOW - 60_000 }).status).toBe('running')
    expect(claudeChild({ id: 'a1', parent: 'p', head: '', tail, mtimeMs: NOW - 5 * 60_000, nowMs: NOW, parentMtimeMs: NOW - CHILD_ORPHAN_MS - 1 }).status).toBe('running')
  })

  it('接口报错 → 出错了', () => {
    const tail = `${JSON.stringify({ type: 'assistant', timestamp: '2026-09-25T12:28:00.000Z', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 529 overloaded' }], model: '<synthetic>' } })}\n`
    expect(claudeChild({ id: 'x', parent: 'p', head: '', tail, mtimeMs: NOW, nowMs: NOW }).status).toBe('error')
  })
})

describe('主会话旁边的子代理目录', () => {
  it('★三个子代理:在跑的两个排前面,说完的那个在后;各自的描述与在做什么', async () => {
    const { transcript } = fakeClaudeSession()
    const children = await readClaudeChildren(transcript, 'parent-1', NOW)
    expect(children.map(one => [one.title, one.status])).toEqual([
      ['卡 O:派活的眼睛', 'running'],
      ['卡 T:在等你看内容', 'running'],
      ['卡 P:会话标题', 'done'],
    ])
    expect(children[0]?.activity?.line).toBe('在改文件')
    expect(sessionChildrenLine(children)).toBe('内含 3 项后台任务 · 在跑 2')
    expect(sessionChildLine(children[2]!, new Date(NOW).toISOString())).toMatch(/^办完了 · 做完了/)
  })

  it('没有子代理目录的会话 → 一项都没有(不编)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-children-none-'))
    dirs.push(root)
    expect(await readClaudeChildren(join(root, 'nothing.jsonl'), 'nothing', NOW)).toEqual([])
  })
})

describe('挂到会话表上', () => {
  it('★主会话自己说完了、底下还有两个在跑:它挂着 3 项;子任务不单独成一条会话;这一条算「在办」一次', async () => {
    const { transcript } = fakeClaudeSession()
    const sessions = [claudeSession(), claudeSession({ agent: 'codex', session_id: 'other', status: 'running' })]
    const tracker = createSessionChildren({
      sessions: () => sessions,
      fileOf: (agent, id) => (agent === 'claude' && id === 'parent-1' ? transcript : undefined),
      now: () => new Date(NOW),
      setInterval: () => 1,
      clearInterval: () => {},
    })
    await tracker.refresh()
    const attached = tracker.attach(sessions)
    expect(attached).toHaveLength(2)
    expect(attached[0]?.children).toHaveLength(3)
    expect(attached[1]?.children).toBeUndefined()
    expect(sessionBusy(attached[0]!)).toBe(true)
    expect(attached.filter(sessionBusy)).toHaveLength(2)
  })

  it('★卡 T 判出来在等他的是底下哪一个子任务(ask.child):那一项记成「等你」,主卡那一行跟着说「等你 1」', async () => {
    const { transcript } = fakeClaudeSession()
    const asking = claudeSession({ status: 'waiting', ask: { kind: 'choose', question: '派活前对一遍', since: '2026-09-25T12:29:00.000Z', by: 'form', child: { id: 'agent-a2', title: '卡 O:派活的眼睛' } } })
    const tracker = createSessionChildren({
      sessions: () => [asking],
      fileOf: () => transcript,
      now: () => new Date(NOW),
      setInterval: () => 1,
      clearInterval: () => {},
    })
    await tracker.refresh()
    const [main] = tracker.attach([asking])
    expect(main?.children?.find(one => one.id === 'a2')?.status).toBe('waiting')
    expect(sessionChildrenLine(main?.children)).toBe('内含 3 项后台任务 · 在跑 1 · 等你 1')
    // 没点名哪一个:不动。
    expect(withAskedChild(main?.children ?? [], undefined)).toBe(main?.children)
  })

  it('事务官派出去的活:挂在派它的那条事务官会话底下(命令行在跑 / 窗口那只手回话了)', async () => {
    const tasks = [
      { id: 't-1', title: '修一下小头像', conversation: { agent: 'dsh', session_id: 'dsh-1' }, dispatch: { family: 'codex', status: 'running', started_at: '2026-09-25T12:00:00.000Z' } },
      { id: 't-2', title: '写周报', conversation: { agent: 'dsh', session_id: 'dsh-1' }, client_dispatch: { hand: 'window', family: 'kimi', status: 'sent', at: '2026-09-25T11:00:00.000Z', text: '写周报', reply: '周报写好了。', reply_at: '2026-09-25T11:05:00.000Z' } },
      { id: 't-3', title: '没派出去的', conversation: { agent: 'dsh', session_id: 'dsh-1' } },
    ] as unknown as TaskView[]
    expect(dispatchChild(tasks[0]!)).toMatchObject({ id: 'dispatch:t-1', parent_session_id: 'dsh-1', title: '修一下小头像', status: 'running' })
    expect(dispatchChild(tasks[1]!)).toMatchObject({ status: 'done', activity: { line: '周报写好了。' } })
    expect(dispatchChild(tasks[2]!)).toBeUndefined()
    const dsh: SessionView = { agent: 'dsh', session_id: 'dsh-1', project: '事务官', status: 'done', elapsed_sec: 0, unread: false, updated_at: '2026-09-25T12:00:00.000Z' }
    // 时刻必须喂进去(同这一份里别的几例):办完的那几项只挂 CHILD_DONE_KEEP_MS 以内的,
    // 拿真时钟去比这一份写死的时刻,过了那道窗「窗口那只手回话了」那一项就会被滤掉。
    const trackerOf = (nowMs: number): SessionChildren => createSessionChildren({
      sessions: () => [dsh], fileOf: () => undefined, tasks: async () => tasks,
      now: () => new Date(nowMs), setInterval: () => 1, clearInterval: () => {},
    })
    const tracker = trackerOf(NOW)
    await tracker.refresh()
    expect(tracker.attach([dsh])[0]?.children?.map(one => one.id)).toEqual(['dispatch:t-1', 'client_dispatch:t-2'])
    // 办完那一项过了十二小时就不再挂着(卡 Q 的设计),在跑的那一项照旧。
    const later = trackerOf(NOW + CHILD_DONE_KEEP_MS + 60_000)
    await later.refresh()
    expect(later.attach([dsh])[0]?.children?.map(one => one.id)).toEqual(['dispatch:t-1'])
  })

  it('★8791 上:/state.sessions 里那条主会话带着 children(卡 N、卡 T 读的就是这一份)', async () => {
    const { transcript } = fakeClaudeSession()
    const service = createWorkbenchService({})
    service.applyEvent({ agent: 'claude', session_id: 'parent-1', type: 'done', cwd: '/Users/example/proj', ts: Math.floor(NOW / 1000) - 60 })
    const tracker = createSessionChildren({
      sessions: () => service.getState().sessions,
      fileOf: (agent, id) => (agent === 'claude' && id === 'parent-1' ? transcript : undefined),
      now: () => new Date(NOW),
      setInterval: () => 1,
      clearInterval: () => {},
    })
    await tracker.refresh()
    const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0, heartbeatMs: 0, sessionChildren: tracker })
    started.push(server)
    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    const parent = state.sessions.find(one => one.session_id === 'parent-1')
    expect(parent?.children?.map(one => one.title)).toEqual(['卡 O:派活的眼睛', '卡 T:在等你看内容', '卡 P:会话标题'])
    // 子任务不单独成一条会话。
    expect(state.sessions.filter(one => one.agent === 'claude')).toHaveLength(1)
  })
})

/**
 * DSH(事务官自己)的子代理(卡 U3,2026-09-25;评估第四节说这一条「现在没接」)。
 *
 * 0.1.7 里子代理**就是一条普通会话** —— 没有 Claude 那种 `subagents/` 目录,认它只靠会话头上
 * `origin: 'subagent'` + `parentSession`(`session/created` 的 `session.header` 上就有,
 * 与它落盘那份 `session.v4.jsonl` 的首行是同一份东西)。所以这一家**不读文件**。
 */
describe('★DSH 子代理挂到父会话底下(卡 U3)', () => {
  const dshSession = (over: Partial<SessionView> = {}): SessionView => ({
    agent: 'dsh', session_id: 'dsh-parent', project: '事务官', status: 'running',
    elapsed_sec: 10, unread: false, updated_at: '2026-09-25T12:29:00.000Z', ...over,
  })

  function trackerOf(sessions: readonly SessionView[], parents: Record<string, string>, tasks?: TaskView[]) {
    return createSessionChildren({
      sessions: () => sessions,
      fileOf: () => undefined,
      dshParentOf: id => parents[id],
      ...(tasks === undefined ? {} : { tasks: async () => tasks }),
      now: () => new Date(NOW),
      setInterval: () => 1,
      clearInterval: () => {},
    })
  }

  it('★子代理会话挂成父会话底下的一项,标题、状态、在做什么都从会话表现成的那几格来', async () => {
    const parent = dshSession()
    const child = dshSession({
      session_id: 'dsh-child', status: 'running', title: '查一下这三个文件里谁读会话',
      activity: { line: '在翻 usage/dsh.ts', at: '2026-09-25T12:29:30.000Z' },
    })
    const tracker = trackerOf([parent, child], { 'dsh-child': 'dsh-parent' })
    await tracker.refresh()
    const attached = tracker.attach([parent, child])
    expect(attached.find(one => one.session_id === 'dsh-parent')?.children).toEqual([{
      id: 'dsh-child',
      parent_session_id: 'dsh-parent',
      title: '查一下这三个文件里谁读会话',
      status: 'running',
      activity: { line: '在翻 usage/dsh.ts', at: '2026-09-25T12:29:30.000Z' },
    }])
  })

  it('★子代理自己那一行从会话表里摘掉(卡 Q:子任务不单独成一条会话)', async () => {
    const parent = dshSession()
    const child = dshSession({ session_id: 'dsh-child', title: '查一下' })
    const tracker = trackerOf([parent, child], { 'dsh-child': 'dsh-parent' })
    await tracker.refresh()
    expect(tracker.attach([parent, child]).map(one => one.session_id)).toEqual(['dsh-parent'])
  })

  it('★不是子代理的 DSH 会话照旧自己站一行(只带 parentSession 的分叉会话由 parentOf 判掉,这里看不到)', async () => {
    const parent = dshSession()
    const loose = dshSession({ session_id: 'dsh-loose' })
    const tracker = trackerOf([parent, loose], {})
    await tracker.refresh()
    expect(tracker.attach([parent, loose]).map(one => one.session_id)).toEqual(['dsh-parent', 'dsh-loose'])
    expect(tracker.attach([parent, loose])[0]?.children).toBeUndefined()
  })

  it('★子代理与「派出去的活」挂在同一条父会话上时两种都在(不是互相顶掉)', async () => {
    const parent = dshSession({ session_id: 'dsh-1' })
    const child = dshSession({ session_id: 'dsh-child', title: '查一下' })
    const tasks = [{
      id: 't-1', title: '修一下小头像', conversation: { agent: 'dsh', session_id: 'dsh-1' },
      dispatch: { family: 'codex', status: 'running', started_at: '2026-09-25T12:00:00.000Z' },
    }] as unknown as TaskView[]
    const tracker = trackerOf([parent, child], { 'dsh-child': 'dsh-1' }, tasks)
    await tracker.refresh()
    const children = tracker.attach([parent, child])[0]?.children
    expect(children?.map(one => one.id).sort()).toEqual(['dispatch:t-1', 'dsh-child'])
  })

  it('状态映射:办完 / 出错 / 等你照搬,offline 记「办完了」(会话被收掉不是出错)', async () => {
    const parent = dshSession()
    const cases: [SessionView['status'], string][] = [['done', 'done'], ['error', 'error'], ['waiting', 'waiting'], ['offline', 'done']]
    for (const [status, expected] of cases) {
      const child = dshSession({ session_id: 'dsh-child', status, title: '查一下' })
      const tracker = trackerOf([parent, child], { 'dsh-child': 'dsh-parent' })
      await tracker.refresh()
      expect(tracker.attach([parent, child])[0]?.children?.[0]?.status, status).toBe(expected)
    }
  })

  it('没有标题时退到它最近说的那一段;都没有才写兜底那句(不留空标题)', async () => {
    const parent = dshSession()
    const bySummary = dshSession({ session_id: 'c1', summary: '三个文件里只有一个读会话。' })
    const blank = dshSession({ session_id: 'c2' })
    const tracker = trackerOf([parent, bySummary, blank], { c1: 'dsh-parent', c2: 'dsh-parent' })
    await tracker.refresh()
    const titles = tracker.attach([parent, bySummary, blank])[0]?.children?.map(one => one.title)
    expect(titles).toContain('三个文件里只有一个读会话。')
    expect(titles).toContain('一项后台任务')
  })

  it('★退到 summary 时也照卡 P 的规矩洗:带路径的那一句洗完没意思了 → 写兜底那句,不把路径摆到卡上', async () => {
    const parent = dshSession()
    const pathy = dshSession({ session_id: 'c1', summary: '只有 usage/dsh.ts 一个读者。' })
    const tracker = trackerOf([parent, pathy], { c1: 'dsh-parent' })
    await tracker.refresh()
    expect(tracker.attach([parent, pathy])[0]?.children?.[0]?.title).toBe('一项后台任务')
  })

  it('这一版 DSH 不给出身(没传 dshParentOf)→ 一项都不挂,会话表一个字不动,与从前一样', async () => {
    const parent = dshSession()
    const child = dshSession({ session_id: 'dsh-child' })
    const tracker = createSessionChildren({
      sessions: () => [parent, child], fileOf: () => undefined,
      now: () => new Date(NOW), setInterval: () => 1, clearInterval: () => {},
    })
    await tracker.refresh()
    expect(tracker.attach([parent, child]).map(one => one.session_id)).toEqual(['dsh-parent', 'dsh-child'])
  })
})
