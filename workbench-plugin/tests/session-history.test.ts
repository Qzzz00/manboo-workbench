// @vitest-environment node
/**
 * 手机「最近的对话」的来源(2026-10-01;维护者:「每一个智能体只显示一个最近会话,昨晚我主要是和你聊,起码三四个会话」)。
 *
 * 原来列的是**这次开机以来的会话表**,关掉的会话一条都不列。现在从各家的会话记录文件读:
 * ① 每家多条,按最后动静排,近 7 天;② 分页(游标往下翻,不重不漏);
 * ③ 工作台自己起的(自检目录 / 自检前缀)、子任务、一句话都没说的空会话不列;
 * ④ 窗口型那几家(没有记录文件)也列,如实标「只能看最新一句」;
 * ⑤ 标题与卡片同一套取法(那家自己的名 > custom-title > 第一句前 20 来字);状态从会话表带上(手机据此把在跑的留在「正在办」)。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SELFCHECK_DIRNAME, SELFCHECK_PREFIX } from '../src/protocol.ts'
import { createSessionHistory, PER_FAMILY_MAX, WINDOW_ONLY_PER_AGENT } from '../src/server/sessionHistory.ts'

const NOW = Date.parse('2026-10-01T09:00:00Z')
const HOUR = 3_600_000

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

const line = (row: unknown) => JSON.stringify(row)

function claudeSession(id: string, ask: string, reply: string, options: { cwd?: string, title?: string } = {}): string {
  return [
    line({ type: 'user', sessionId: id, cwd: options.cwd ?? '/Users/example/Documents/GitHub/desktop-workbench', timestamp: '2026-09-30T13:00:00Z', origin: { kind: 'human' }, message: { role: 'user', content: ask } }),
    line({ type: 'assistant', sessionId: id, timestamp: '2026-09-30T13:01:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] } }),
    ...(options.title === undefined ? [] : [line({ type: 'custom-title', customTitle: options.title, sessionId: id })]),
  ].join('\n')
}

function home() {
  const root = mkdtempSync(join(tmpdir(), 'wb-history-'))
  dirs.push(root)
  const claude = join(root, '.claude')
  const codex = join(root, '.codex')
  const write = (file: string, text: string, ageMs: number) => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
    const t = (NOW - ageMs) / 1000
    utimesSync(file, t, t)
  }
  return { root, claude, codex, write }
}

describe('各家最近的对话:从会话记录文件读', () => {
  it('昨晚三四条 Claude 会话都在(每家多条),按最后动静排;七天前的不列', async () => {
    const h = home()
    const proj = join(h.claude, 'projects', '-Users-ben-Documents-GitHub-desktop-workbench')
    h.write(join(proj, 'aaaa-1.jsonl'), claudeSession('aaaa-1', '把手机最近会话查一下', '查到了。'), 10 * HOUR)
    h.write(join(proj, 'aaaa-2.jsonl'), claudeSession('aaaa-2', '统筹交接', '好的', { title: '统筹交接 10-01' }), 9 * HOUR)
    h.write(join(proj, 'aaaa-3.jsonl'), claudeSession('aaaa-3', '座机为什么没起来', '多半是供电'), 8 * HOUR)
    h.write(join(proj, 'aaaa-4.jsonl'), claudeSession('aaaa-4', '参赛视频改一下', '改好了'), 1 * HOUR)
    h.write(join(proj, 'old.jsonl'), claudeSession('old', '很久以前', '嗯'), 8 * 24 * HOUR)
    const history = createSessionHistory({ claudeHome: h.claude, codexHome: h.codex, now: () => NOW })
    const view = await history.page({})
    expect(view.items.map(item => item.session_id)).toEqual(['aaaa-4', 'aaaa-3', 'aaaa-2', 'aaaa-1'])
    expect(view.items.every(item => item.agent === 'claude')).toBe(true)
    expect(view.items.find(item => item.session_id === 'aaaa-2')?.title).toBe('统筹交接 10-01')
    expect(view.items.find(item => item.session_id === 'aaaa-1')?.title).toBe('把手机最近会话查一下')
    expect(view.items[0]?.last_line).toEqual({ who: 'ai', text: '改好了' })
    expect(view.items[0]?.last_at).toBe(new Date(NOW - HOUR).toISOString())
    expect(view.items.find(item => item.session_id === 'aaaa-1')?.project).toBeUndefined()
    expect(view.next).toBeUndefined()
    expect(view.days).toBe(7)
  })

  it('分页:游标往下翻,不重不漏', async () => {
    const h = home()
    const proj = join(h.claude, 'projects', 'p')
    for (let i = 1; i <= 5; i++) h.write(join(proj, `s${i}.jsonl`), claudeSession(`s${i}`, `第 ${i} 条`, '好'), i * HOUR)
    const history = createSessionHistory({ claudeHome: h.claude, codexHome: h.codex, now: () => NOW })
    const first = await history.page({ limit: 2 })
    expect(first.items.map(item => item.session_id)).toEqual(['s1', 's2'])
    expect(first.next).toBeDefined()
    const second = await history.page({ limit: 2, before: first.next })
    expect(second.items.map(item => item.session_id)).toEqual(['s3', 's4'])
    const third = await history.page({ limit: 2, before: second.next })
    expect(third.items.map(item => item.session_id)).toEqual(['s5'])
    expect(third.next).toBeUndefined()
  })

  it('工作台自己起的、子任务、空会话不列;子任务目录里的文件不算', async () => {
    const h = home()
    const proj = join(h.claude, 'projects', 'p')
    h.write(join(proj, 'mine.jsonl'), claudeSession('mine', '她自己的', '好'), HOUR)
    h.write(join(proj, 'probe.jsonl'), claudeSession('probe', `${SELFCHECK_PREFIX}能力体检`, 'ok'), HOUR)
    h.write(join(proj, 'probe-dir.jsonl'), claudeSession('probe-dir', '派活探针', 'ok', { cwd: `/tmp/${SELFCHECK_DIRNAME}/x` }), HOUR)
    h.write(join(proj, 'empty.jsonl'), line({ type: 'summary', summary: 'x' }), HOUR)
    h.write(join(proj, 'mine', 'subagents', 'agent-1.jsonl'), claudeSession('mine', '子任务', 'ok'), HOUR)
    h.write(join(proj, 'side.jsonl'), [line({ type: 'user', isSidechain: true, sessionId: 'mine', timestamp: '2026-09-30T13:00:00Z', message: { role: 'user', content: '子任务' } })].join('\n'), HOUR)
    const history = createSessionHistory({ claudeHome: h.claude, codexHome: h.codex, now: () => NOW })
    expect((await history.page({})).items.map(item => item.session_id)).toEqual(['mine'])
  })

  it('Codex:按日期目录找 rollout,标题用 thread_name;子任务不列', async () => {
    const h = home()
    const id = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001'
    const sub = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002'
    const day = join(h.codex, 'sessions', '2026', '09', '30')
    const rollout = (sid: string, source: unknown) => [
      line({ type: 'session_meta', timestamp: '2026-09-30T12:00:00Z', payload: { id: sid, cwd: '/Users/example/x', source } }),
      line({ type: 'event_msg', timestamp: '2026-09-30T12:00:01Z', payload: { type: 'user_message', message: '做参赛网页' } }),
      line({ type: 'event_msg', timestamp: '2026-09-30T12:05:00Z', payload: { type: 'agent_message', message: '做好了第一版', phase: 'final_answer' } }),
    ].join('\n')
    h.write(join(day, `rollout-2026-09-30T12-00-00-${id}.jsonl`), rollout(id, 'vscode'), 2 * HOUR)
    h.write(join(day, `rollout-2026-09-30T12-00-00-${sub}.jsonl`), rollout(sub, { subagent: { thread_spawn: { parent_thread_id: id } } }), 2 * HOUR)
    writeFileSync(join(h.codex, 'session_index.jsonl'), `${line({ id, thread_name: '制作参赛网页' })}\n`)
    const history = createSessionHistory({ claudeHome: h.claude, codexHome: h.codex, now: () => NOW })
    const view = await history.page({})
    expect(view.items.map(item => [item.agent, item.session_id, item.title])).toEqual([['codex', id, '制作参赛网页']])
    expect(await history.locate('codex', id)).toMatchObject({ format: 'codex-rollout' })
    expect(await history.locate('codex', sub)).toMatchObject({ format: 'codex-rollout' })
  })

  it('窗口型那几家也列,标 window_only;状态从会话表带上;事务官自己不列', async () => {
    const h = home()
    const proj = join(h.claude, 'projects', 'p')
    h.write(join(proj, 'live.jsonl'), claudeSession('live', '在跑的这条', '在改'), 0)
    h.write(join(proj, 'gone.jsonl'), claudeSession('gone', '关掉的这条', '好'), 3 * HOUR)
    const history = createSessionHistory({
      claudeHome: h.claude,
      codexHome: h.codex,
      now: () => NOW,
      liveSessions: () => [
        { agent: 'claude', session_id: 'live', status: 'running', project: '工作台', updated_at: new Date(NOW).toISOString() },
      ],
      windowSessions: () => [
        { agent: 'doubao', session_id: 'window:doubao:1', title: '帮我写个标题', status: 'done', updated_at: new Date(NOW - 2 * HOUR).toISOString(), activity: { line: '写好了三个', at: new Date(NOW - 2 * HOUR).toISOString() } },
        { agent: 'dsh', session_id: 'window:dsh:1', title: '事务官', status: 'done', updated_at: new Date(NOW).toISOString() },
      ],
    })
    const view = await history.page({})
    // 窗口型没有真实的最后动静(会话表里那个时刻是工作台读窗口的时刻)→ 排在有记录文件的后面、不带时间(2026-10-01)。
    expect(view.items.map(item => item.session_id)).toEqual(['live', 'gone', 'window:doubao:1'])
    expect(view.items[0]).toMatchObject({ status: 'running', project: '工作台' })
    expect(view.items[2]).toMatchObject({ agent: 'doubao', window_only: true, title: '帮我写个标题', last_line: { who: 'ai', text: '写好了三个' } })
    expect(view.items[2]).not.toHaveProperty('last_at')
  })

  it('★ 不许被一家刷屏(维护者 10-01:「最近10个全是 manus 的」):读窗口的时刻不算最后动静,窗口型每家最多 3 条', async () => {
    const h = home()
    const proj = join(h.claude, 'projects', 'p')
    for (const [i, id] of ['c1', 'c2', 'c3', 'c4'].entries()) h.write(join(proj, `${id}.jsonl`), claudeSession(id, `Claude 第 ${i + 1} 条`, '好'), (i + 5) * HOUR)
    const readAt = new Date(NOW).toISOString()
    const manus = Array.from({ length: 8 }, (_, i) => ({ agent: 'manus', session_id: `window:manus:${i}`, title: `老对话 ${i}`, status: 'done' as const, updated_at: readAt }))
    const history = createSessionHistory({ claudeHome: h.claude, codexHome: h.codex, now: () => NOW, windowSessions: () => manus })
    const view = await history.page({})
    expect(view.items.slice(0, 4).map(item => item.agent)).toEqual(['claude', 'claude', 'claude', 'claude'])
    expect(view.items.filter(item => item.agent === 'manus')).toHaveLength(3)
    expect(view.items.filter(item => item.agent === 'manus').every(item => item.last_at === undefined)).toBe(true)
  })

  it('只看某一家(agent=)', async () => {
    const h = home()
    h.write(join(h.claude, 'projects', 'p', 'c1.jsonl'), claudeSession('c1', '一', '好'), HOUR)
    const history = createSessionHistory({
      claudeHome: h.claude,
      codexHome: h.codex,
      now: () => NOW,
      windowSessions: () => [{ agent: 'doubao', session_id: 'window:doubao:1', status: 'done', updated_at: new Date(NOW).toISOString() }],
    })
    expect((await history.page({ agent: 'doubao' })).items.map(item => item.agent)).toEqual(['doubao'])
    expect((await history.page({ agent: 'claude' })).items.map(item => item.session_id)).toEqual(['c1'])
  })

  /*
   * ★ 固定入口那一档(2026-10-03,卡「手机各家最近会话固定入口」)。维护者原话:
   * 「给他一个固定的入口,固定显示每一家最近的十个会话,最好是按项目分好的。」
   * 分页那一档(limit/before)一个字没动 —— 上面那几条用例就是它。
   */
  it('★ per_family:每家各取最近那么多条、一次全给;回包里 `per_family` 说清用上的是几;不分页', async () => {
    const h = home()
    const proj = join(h.claude, 'projects', 'p')
    for (const [i, id] of ['c1', 'c2', 'c3', 'c4'].entries()) h.write(join(proj, `${id}.jsonl`), claudeSession(id, `Claude 第 ${i + 1} 条`, '好'), (i + 1) * HOUR)
    const day = join(h.codex, 'sessions', '2026', '09', '30')
    const ids = ['0199aaaa-bbbb-7ccc-8ddd-eeeeffff0011', '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0012', '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0013']
    for (const [i, id] of ids.entries()) {
      h.write(join(day, `rollout-2026-09-30T12-00-00-${id}.jsonl`), [
        line({ type: 'session_meta', timestamp: '2026-09-30T12:00:00Z', payload: { id, cwd: '/Users/example/x', source: 'vscode' } }),
        line({ type: 'event_msg', timestamp: '2026-09-30T12:00:01Z', payload: { type: 'user_message', message: `Codex 第 ${i + 1} 条` } }),
        line({ type: 'event_msg', timestamp: '2026-09-30T12:05:00Z', payload: { type: 'agent_message', message: '做好了', phase: 'final_answer' } }),
      ].join('\n'), (i + 1) * HOUR)
    }
    const history = createSessionHistory({ claudeHome: h.claude, codexHome: h.codex, now: () => NOW })
    const view = await history.page({ per_family: 2 })
    expect(view.per_family).toBe(2)
    expect(view.next).toBeUndefined()
    expect(view.items.filter(item => item.agent === 'claude').map(item => item.session_id)).toEqual(['c1', 'c2'])
    expect(view.items.filter(item => item.agent === 'codex').map(item => item.session_id)).toEqual([ids[0], ids[1]])
    // 整份还是新的在前(手机按出场顺序分组,组的先后就是「哪一家最近动过」)。
    expect(view.items.map(item => item.agent)).toEqual(['claude', 'codex', 'claude', 'codex'])
  })

  it('per_family:数不够就有几条给几条;夹在 1…PER_FAMILY_MAX;老调用方(不带它)照旧有 next、没有 per_family', async () => {
    const h = home()
    const proj = join(h.claude, 'projects', 'p')
    for (const [i, id] of ['c1', 'c2', 'c3'].entries()) h.write(join(proj, `${id}.jsonl`), claudeSession(id, `第 ${i + 1} 条`, '好'), (i + 1) * HOUR)
    const history = createSessionHistory({ claudeHome: h.claude, codexHome: h.codex, now: () => NOW })
    expect((await history.page({ per_family: 10 })).items.map(item => item.session_id)).toEqual(['c1', 'c2', 'c3'])
    expect((await history.page({ per_family: 999 })).per_family).toBe(PER_FAMILY_MAX)
    expect((await history.page({ per_family: 0 })).per_family).toBe(1)
    const old = await history.page({ limit: 2 })
    expect(old.per_family).toBeUndefined()
    expect(old.next).toBeDefined()
  })

  it('per_family:窗口型那几家每家也到 per_family 条(分好组就不存在刷屏了),时间照旧缺席', async () => {
    const h = home()
    const readAt = new Date(NOW).toISOString()
    const manus = Array.from({ length: 8 }, (_, i) => ({ agent: 'manus', session_id: `window:manus:${i}`, title: `老对话 ${i}`, status: 'done' as const, updated_at: readAt }))
    const history = createSessionHistory({ claudeHome: h.claude, codexHome: h.codex, now: () => NOW, windowSessions: () => manus })
    expect((await history.page({ per_family: 5 })).items).toHaveLength(5)
    expect((await history.page({ per_family: 5 })).items.every(item => item.last_at === undefined && item.window_only === true)).toBe(true)
    // 不带 per_family 的那一档照旧每家 3 条。
    expect((await history.page({})).items).toHaveLength(WINDOW_ONLY_PER_AGENT)
  })

  it('per_family:按项目分组要的那一格 —— `project` 由 cwd 解出来(手机不自己猜项目)', async () => {
    const h = home()
    h.write(join(h.claude, 'projects', 'p', 'c1.jsonl'), claudeSession('c1', '一', '好', { cwd: '/Users/example/Documents/GitHub/desktop-workbench' }), HOUR)
    h.write(join(h.claude, 'projects', 'p', 'c2.jsonl'), claudeSession('c2', '二', '好', { cwd: '/tmp/没有项目' }), 2 * HOUR)
    const history = createSessionHistory({
      claudeHome: h.claude,
      codexHome: h.codex,
      now: () => NOW,
      resolveProject: async cwd => (cwd.includes('desktop-workbench') ? '工作台' : undefined),
    })
    const view = await history.page({ per_family: 10 })
    expect(view.items.map(item => [item.session_id, item.project])).toEqual([['c1', '工作台'], ['c2', undefined]])
  })

  it('locate:不收路径 —— 带斜杠、带 .. 的 id 一律认不出', async () => {
    const h = home()
    h.write(join(h.claude, 'projects', 'p', 'c1.jsonl'), claudeSession('c1', '一', '好'), HOUR)
    const history = createSessionHistory({ claudeHome: h.claude, codexHome: h.codex, now: () => NOW })
    expect(await history.locate('claude', 'c1')).toMatchObject({ file: join(h.claude, 'projects', 'p', 'c1.jsonl'), format: 'claude-transcript' })
    expect(await history.locate('claude', '../p/c1')).toBeUndefined()
    expect(await history.locate('claude', 'nope')).toBeUndefined()
  })

  it('locate 先认各家接入登记过的(自动发现的那一家也读得到)', async () => {
    const h = home()
    const file = join(h.root, 'elsewhere', 'k1.jsonl')
    h.write(file, claudeSession('k1', '一', '好'), HOUR)
    const history = createSessionHistory({
      claudeHome: h.claude,
      codexHome: h.codex,
      now: () => NOW,
      registered: () => [{ agent: 'kimi', session_id: 'k1', file, format: 'kimi-wire', name: 'Kimi 那条' }],
    })
    expect(await history.locate('kimi', 'k1')).toMatchObject({ file, format: 'kimi-wire', name: 'Kimi 那条' })
  })
})
