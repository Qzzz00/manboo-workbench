// @vitest-environment node
/**
 * 习惯的小尾巴(2026-10-10,决策记录 2026-10-09 傍晚「三张卡留的待拍板」):
 *
 * 1. 新学到一条开始试用时,在事务官收件箱里说一句「新学到一条:…,正在试用」(带依据,点进去能撤);
 *    不按种类写死;同一条只说一次;她撤了或点了「知道了」就收。
 * 2. 撤错能恢复:撤掉的(她撤的、自动撤的)手动恢复 → 重新进试用、照常验证、日志记一行;只认她本人。
 *    「撤掉的不再自动学回来」照旧。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ButlerInboxItem, HabitsView } from '../src/protocol.ts'
import { BEHAVIOR_EVENTS, createBehaviorLog, type BehaviorEntry } from '../src/server/behaviorLog.ts'
import { HABIT_NOTICE_HEAD, deriveButlerInbox, habitItems } from '../src/server/butlerInbox.ts'
import { EVOLVE_LOG_NAME } from '../src/server/evolve.ts'
import { HABIT_NOTICES_MAX, createHabitService, habitView, sanitizeHabit, type StoredHabit } from '../src/server/habits.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createRulesService } from '../src/server/rules.ts'
import { createWorkbenchService } from '../src/server/service.ts'

function local(month: number, day: number, hour: number, minute = 0): string {
  return new Date(2026, month - 1, day, hour, minute).toISOString()
}
const ms = (iso: string): number => Date.parse(iso)

function call(at: string, answered: boolean): BehaviorEntry {
  return { at, 端: '电话', 事: BEHAVIOR_EVENTS.call, 对象: 'confirm · 一件事', 结果: answered ? '接了' : '没接' }
}

function stored(over: Partial<StoredHabit> = {}): StoredHabit {
  const at = local(10, 6, 20)
  return {
    id: '时段:13', kind: 'quiet', 类: '13 点', value: '13', text: '13:00–14:00 不打电话,改发消息',
    status: 'trial', evidence: [{ at, what: '10-05 13:10 那一通没接' }, { at, what: '10-06 13:40 那一通没接' }], applied: [],
    created_at: at, updated_at: at, adopted_at: at, ...over,
  }
}

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function service(entries: BehaviorEntry[], nowIso: string) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-habit-tail-'))
  dirs.push(dir)
  const clock = { now: ms(nowIso) }
  const rules = createRulesService({ file: join(dir, 'rules.json'), now: () => clock.now })
  await rules.load()
  const ledger = { rows: [...entries] }
  const workdir = join(dir, '工作台')
  let changed = 0
  const habits = createHabitService({
    store: rules,
    behavior: { read: async () => ledger.rows },
    now: () => clock.now,
    workdir,
    io: {
      readFile: async (file) => { try { return readFileSync(file, 'utf8') } catch { return undefined } },
      writeFile: async (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text, 'utf8') },
    },
    morning: () => ({ not_before: '06:00' }),
    onChanged: () => { changed += 1 },
  })
  return { habits, rules, ledger, clock, logFile: join(workdir, EVOLVE_LOG_NAME), changed: () => changed, dir }
}

describe('新学到一条:收件箱里说一句', () => {
  it('学到一条试用 → 提示里有它;她点「知道了」就收,同一条不再说', async () => {
    const s = await service([call(local(10, 5, 13, 10), false), call(local(10, 6, 13, 40), false)], local(10, 6, 20))
    expect(s.habits.notices()).toEqual([])
    await s.habits.learn()
    expect(s.habits.notices().map(one => one.id)).toEqual(['时段:13'])
    const before = s.changed()
    expect((await s.habits.seen('时段:13')).ok).toBe(true)
    expect(s.changed()).toBeGreaterThan(before)
    expect(s.habits.notices()).toEqual([])
    // 再看一次也不出错,也不会冒回来
    expect((await s.habits.seen('时段:13')).ok).toBe(true)
    expect((await s.habits.seen('没有这条')).ok).toBe(false)
    expect(s.habits.notices()).toEqual([])
  })

  it('她撤了就收;验出结论(留下 / 自动撤)也不再说', async () => {
    const s = await service([], local(10, 7, 9))
    await s.rules.putHabits([
      stored(),
      stored({ id: '早报:08:50', kind: 'brief', 类: '早报', value: '08:50', text: '早报 08:50 备好' }),
      stored({ id: '不问:browser', kind: 'noask', 类: 'browser', value: '', text: '「开看不见的浏览器截图」这类不问,做完告诉她', status: 'kept' }),
    ])
    expect(s.habits.notices().map(one => one.id).sort()).toEqual(['早报:08:50', '时段:13'].sort())
    await s.habits.revoke('时段:13')
    expect(s.habits.notices().map(one => one.id)).toEqual(['早报:08:50'])
  })

  it('不按种类写死:风格那一种同样说;一次最多说几条,新的在前', async () => {
    const s = await service([], local(10, 7, 9))
    const many = Array.from({ length: HABIT_NOTICES_MAX + 2 }, (_, n) => stored({
      id: `风格:x${n}`, kind: 'style', 类: `维度${n}`, value: `x${n}`, text: `第 ${n} 条`, adopted_at: local(10, 6, 8 + n), updated_at: local(10, 6, 8 + n),
    }))
    await s.rules.putHabits(many)
    const shown = s.habits.notices()
    expect(shown).toHaveLength(HABIT_NOTICES_MAX)
    expect(shown[0]?.id).toBe(`风格:x${HABIT_NOTICES_MAX + 1}`)
    expect(shown[0]?.kind_title).toBe('说话和做事风格')
  })

  it('「看过了」落盘:读盘把关不丢这一格', () => {
    const one = sanitizeHabit({ ...stored(), noticed_at: local(10, 7, 9) })
    expect(one?.noticed_at).toBe(local(10, 7, 9))
    expect(sanitizeHabit(stored())?.noticed_at).toBeUndefined()
  })
})

describe('收件箱那一档', () => {
  it('标题「新学到一条:<人话>,正在试用」,底下依据摘要,带回习惯 id', () => {
    const items = habitItems([habitView(stored())])
    expect(items).toHaveLength(1)
    const item = items[0] as ButlerInboxItem
    expect(item).toMatchObject({ id: 'habit:时段:13', kind: 'habit', habit: { id: '时段:13' }, at: local(10, 6, 20) })
    expect(item.title).toBe(`${HABIT_NOTICE_HEAD}13:00–14:00 不打电话,改发消息,正在试用`)
    expect(item.note).toContain('10-05 13:10 那一通没接')
    expect(item.note).toContain('10-06 13:40 那一通没接')
    expect(item.note).toContain('撤掉')
  })

  it('依据多了只摘两条、说一共几条;风格那种有原话就引', () => {
    const habit = habitView(stored({
      evidence: [1, 2, 3, 4].map(n => ({ at: local(10, n, 9), what: `第 ${n} 次` })),
    }))
    const note = habitItems([habit])[0]?.note ?? ''
    expect(note).toContain('第 3 次')
    expect(note).toContain('第 4 次')
    expect(note).not.toContain('第 1 次')
    expect(note).toContain('共 4 条')
    const said = habitItems([{ ...habit, evidence: [{ at: local(10, 1, 9), what: '电脑上回话', said: '太长了' }] }])[0]?.note ?? ''
    expect(said).toContain('「太长了」')
  })

  it('进 deriveButlerInbox;没给就整档不出', () => {
    const base = { sessions: [], agents: [], stale: false } as unknown as Parameters<typeof deriveButlerInbox>[0]
    expect(deriveButlerInbox(base).items.filter(one => one.kind === 'habit')).toEqual([])
    const items = deriveButlerInbox({ ...base, habits: [habitView(stored())] }).items
    expect(items.filter(one => one.kind === 'habit').map(one => one.id)).toEqual(['habit:时段:13'])
  })
})

describe('撤错能恢复', () => {
  it('她撤掉的 → 恢复:重新试用、照常用上、日志记一行、不再冒提示;试用从恢复那一刻算', async () => {
    const s = await service([call(local(10, 5, 13, 10), false), call(local(10, 6, 13, 40), false)], local(10, 6, 20))
    await s.habits.learn()
    await s.habits.revoke('时段:13')
    expect(s.habits.quietNow(ms(local(10, 7, 13, 30)))).toBeUndefined()
    s.clock.now = ms(local(10, 7, 9))
    const done = await s.habits.restore('时段:13')
    expect(done.ok).toBe(true)
    if (done.ok) {
      expect(done.habit).toMatchObject({ status: 'trial', adopted_at: local(10, 7, 9) })
      expect(done.habit.verdict).toBeUndefined()
      expect(done.note).toContain('重新试用')
    }
    expect(s.habits.quietNow(ms(local(10, 7, 13, 30)))).toBe('时段:13')
    expect(s.habits.notices()).toEqual([])
    expect(readFileSync(s.logFile, 'utf8')).toContain('她恢复了')
    // 照常验证:恢复之后那个钟点她接了一通 → 自动撤
    s.ledger.rows.push(call(local(10, 7, 13, 20), true))
    s.clock.now = ms(local(10, 7, 20))
    expect((await s.habits.learn()).reverted).toBe(1)
    // 自动撤的也能恢复
    expect((await s.habits.restore('时段:13')).ok).toBe(true)
  })

  it('恢复之前的验证记录不算数:恢复前那一通接了的,恢复后不拿来撤', async () => {
    const s = await service([], local(10, 7, 9))
    await s.rules.putHabits([stored({ status: 'removed', verdict: '她点了撤掉' })])
    s.ledger.rows.push(call(local(10, 7, 13, 20), true))
    s.clock.now = ms(local(10, 7, 20))
    await s.habits.restore('时段:13')
    expect((await s.habits.learn()).reverted).toBe(0)
    expect(s.habits.view().trial.map(one => one.id)).toEqual(['时段:13'])
  })

  it('还在算数的不能恢复;没有这条 / 同一类正有另一条在算数时说清楚', async () => {
    const s = await service([], local(10, 7, 9))
    await s.rules.putHabits([
      stored(),
      stored({ id: '风格:长短.短', kind: 'style', 类: '长短', value: '长短.短', text: '先给要点', status: 'removed' }),
      stored({ id: '风格:长短.长', kind: 'style', 类: '长短', value: '长短.长', text: '说具体一点', status: 'kept' }),
    ])
    const live = await s.habits.restore('时段:13')
    expect(live).toMatchObject({ ok: false })
    expect((await s.habits.restore('没有这条'))).toEqual({ ok: false, error: '没有这条习惯' })
    const clash = await s.habits.restore('风格:长短.短')
    expect(clash.ok).toBe(false)
    if (!clash.ok) expect(clash.error).toContain('说具体一点')
  })

  it('撤掉的不再自动学回来照旧:恢复后再撤,同样的证据也不再学', async () => {
    const s = await service([call(local(10, 5, 13, 10), false), call(local(10, 6, 13, 40), false)], local(10, 6, 20))
    await s.habits.learn()
    await s.habits.revoke('时段:13')
    await s.habits.restore('时段:13')
    await s.habits.revoke('时段:13')
    s.ledger.rows.push(call(local(10, 8, 13, 10), false), call(local(10, 9, 13, 10), false))
    s.clock.now = ms(local(10, 9, 20))
    expect((await s.habits.learn()).adopted).toBe(0)
    expect(s.habits.view().retired.map(one => one.status)).toEqual(['removed'])
  })
})

describe('8791:POST /habits/restore、/habits/seen,/state 里的那一档', () => {
  const PAGE = { origin: 'http://127.0.0.1:3080' }

  async function serve() {
    const dir = mkdtempSync(join(tmpdir(), 'wb-habit-tail-http-'))
    dirs.push(dir)
    const rules = createRulesService({ file: join(dir, 'rules.json') })
    await rules.load()
    const behaviorLog = createBehaviorLog({ dir: join(dir, '行为账') })
    const habits = createHabitService({ store: rules, behavior: behaviorLog })
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService({}), tickIntervalMs: 0, heartbeatMs: 0, rules, habits, behaviorLog,
    })
    started.push(server)
    const request = async (path: string, init: { body?: unknown, headers?: Record<string, string> } = {}) => {
      const res = await fetch(`${server.url}${path}`, {
        method: init.body === undefined ? 'GET' : 'POST',
        headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
      const text = await res.text()
      return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
    }
    const entries = async (): Promise<BehaviorEntry[]> => { await behaviorLog.flush(); return behaviorLog.read({}) }
    return { request, rules, entries }
  }

  it('收件箱里有那一句;她点「知道了」(只认她本人)就收', async () => {
    const t = await serve()
    await t.rules.putHabits([stored({ adopted_at: new Date().toISOString() })])
    const inbox = async () => ((await t.request('/state')).body.butler_inbox as { items: ButlerInboxItem[] }).items.filter(one => one.kind === 'habit')
    expect((await inbox()).map(one => one.habit?.id)).toEqual(['时段:13'])
    expect((await t.request('/habits/seen', { body: { id: '时段:13' } })).status).toBe(403)
    expect((await t.request('/habits/seen', { body: { id: '没有' }, headers: PAGE })).status).toBe(404)
    expect((await t.request('/habits/seen', { body: {}, headers: PAGE })).status).toBe(400)
    expect((await t.request('/habits/seen', { body: { id: '时段:13' }, headers: PAGE })).status).toBe(200)
    expect(await inbox()).toEqual([])
  })

  it('恢复:只认她本人;撤过的才能恢复;记进行为账', async () => {
    const t = await serve()
    await t.rules.putHabits([stored({ status: 'removed', verdict: '她点了撤掉' })])
    expect((await t.request('/habits/restore', { body: { id: '时段:13' } })).status).toBe(403)
    expect((await t.request('/habits/restore', { body: { id: '没有' }, headers: PAGE })).status).toBe(404)
    const done = await t.request('/habits/restore', { body: { id: '时段:13' }, headers: PAGE })
    expect(done.status).toBe(200)
    expect(String(done.body.note)).toContain('重新试用')
    expect((await t.request('/habits/restore', { body: { id: '时段:13' }, headers: PAGE })).status).toBe(409)
    const view = (await t.request('/habits')).body as unknown as HabitsView
    expect(view.trial.map(one => one.id)).toEqual(['时段:13'])
    expect((await t.entries()).filter(e => e.事 === '拍板').map(e => e.结果)).toEqual(['恢复习惯'])
  })
})
