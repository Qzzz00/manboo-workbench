// @vitest-environment node
/**
 * 从行为账里数出习惯(2026-10-09,卡「数出习惯」;设计 `docs/设计-事务官从她的行为里学-2026-10-09.md` 第三节第 2、4、5 条)。
 * 全靠计数,不经模型:试用 → 下一次没纠正就留 / 纠正了自动撤 → 撤过的不再自动学回来。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BEHAVIOR_EVENTS, type BehaviorEntry } from '../src/server/behaviorLog.ts'
import { dispatchChoices } from '../src/server/dispatchChoice.ts'
import { EVOLVE_LOG_NAME } from '../src/server/evolve.ts'
import {
  FOUR_KINDS, HABIT_KIND_TITLES, briefHabitText, createHabitService, dispatchClassOf, findBriefHabit, findDispatchHabits,
  findNoAskHabits, findQuietHabits, firstSeenByDay, fourKindOf, noAskLearnable, verifyHabit, type StoredHabit,
} from '../src/server/habits.ts'
import { createRulesService } from '../src/server/rules.ts'

/** 本机时间(用例跑在哪个时区都对得上「几点」)。月份从 1 起。 */
function local(month: number, day: number, hour: number, minute = 0): string {
  return new Date(2026, month - 1, day, hour, minute).toISOString()
}
const ms = (iso: string): number => Date.parse(iso)

function e(at: string, 事: string, rest: Partial<BehaviorEntry> = {}): BehaviorEntry {
  return { at, 端: '电脑', 事, 对象: '', 结果: '', ...rest }
}

const CODE_LAPIS = dispatchClassOf('code', 'Lapis')

function dispatch(at: string, item: string, recommended: string, chosen: string, 类 = CODE_LAPIS): BehaviorEntry {
  return e(at, BEHAVIOR_EVENTS.dispatch, { 对象: `${item} 改首页`, 推荐: recommended, 结果: chosen, 类 })
}

function call(at: string, answered: boolean): BehaviorEntry {
  return e(at, BEHAVIOR_EVENTS.call, { 端: '电话', 对象: 'confirm · 一件事', 结果: answered ? '接了' : '没接' })
}

function seen(at: string, end: '电脑' | '手机' = '电脑', first = false): BehaviorEntry {
  return e(at, BEHAVIOR_EVENTS.seen, { 端: end, 对象: '工作台', 结果: first ? '当天第一次' : '在' })
}

function approval(at: string, 类: string, allow: boolean, 对象 = '要在「app」这个仓库里跑一条命令'): BehaviorEntry {
  return e(at, BEHAVIOR_EVENTS.decide, { 对象, 结果: allow ? '同意' : '不同意', 类 })
}

describe('同一类事怎么分(可数,不靠模型)', () => {
  it('派活:活的种类 + 挂的项目', () => {
    expect(dispatchClassOf('code', 'Lapis')).toBe('写代码的活 · Lapis')
    expect(dispatchClassOf('chat')).toBe('聊天 / 问答的活')
    expect(dispatchClassOf('desk', '  ')).toBe('要在你电脑上动手的活')
  })

  it('要不要问:只认「同类都允许」那两类(开浏览器截图 / 同一个仓库里动手)', () => {
    expect(noAskLearnable('browser')).toBe(true)
    expect(noAskLearnable('repo:/Users/her/app')).toBe(true)
    expect(noAskLearnable('Bash')).toBe(false)
    expect(noAskLearnable('')).toBe(false)
  })
})

describe('硬边界:四类永远要问,学不掉', () => {
  it('四类各认得出', () => {
    expect(fourKindOf('派给 Claude(本周还剩约 62%)')).toBe(FOUR_KINDS.spend)
    expect(fourKindOf('到上限了:继续 / 停掉 / 换一家')).toBe(FOUR_KINDS.spend)
    expect(fourKindOf('npm publish')).toBe(FOUR_KINDS.outward)
    expect(fourKindOf('git push origin main')).toBe(FOUR_KINDS.outward)
    expect(fourKindOf('把这段发给王老师')).toBe(FOUR_KINDS.outward)
    expect(fourKindOf('打开登录页让她输验证码')).toBe(FOUR_KINDS.byHand)
    expect(fourKindOf('security find-generic-password -s x')).toBe(FOUR_KINDS.byHand)
    expect(fourKindOf('改她的规矩表 rules.json')).toBe(FOUR_KINDS.habit)
    expect(fourKindOf('写进 ~/.dsh/AGENTS.md')).toBe(FOUR_KINDS.habit)
    expect(fourKindOf('pnpm vitest run tests/a.test.ts')).toBeUndefined()
  })

  it('同一类她连着点头很多次,只要沾四类就不出「不问」', () => {
    const now = ms(local(10, 9, 12))
    const rows = [
      approval(local(10, 5, 10), 'repo:/Users/her/site', true, '要在「site」这个仓库里跑一条命令:git push'),
      approval(local(10, 6, 10), 'repo:/Users/her/site', true, '要在「site」这个仓库里跑一条命令:git push'),
      approval(local(10, 7, 10), 'repo:/Users/her/site', true, '要在「site」这个仓库里跑一条命令:git push'),
      approval(local(10, 7, 11), 'repo:/Users/her/site', true, '要在「site」这个仓库里跑一条命令:git push'),
      // 派活闸、上限问话:要用掉额度
      ...[5, 6, 7, 8].map(day => e(local(10, day, 9), BEHAVIOR_EVENTS.dispatch, { 对象: 'T1', 结果: '同意', 推荐: 'Claude', 类: '派活' })),
      ...[5, 6, 7, 8].map(day => e(local(10, day, 9), BEHAVIOR_EVENTS.decide, { 对象: 'T1 到上限了', 结果: '继续', 类: '上限' })),
    ]
    expect(findNoAskHabits(rows, [], now)).toEqual([])
  })

  it('试用中的「不问」也拦不住一条沾四类的:照旧问', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-habit-four-'))
    dirs.push(dir)
    const { habits } = await service(dir, [
      approval(local(10, 5, 10), 'repo:/Users/her/app', true),
      approval(local(10, 6, 10), 'repo:/Users/her/app', true),
      approval(local(10, 7, 10), 'repo:/Users/her/app', true),
    ], local(10, 8, 9))
    await habits.learn()
    expect(habits.noAsk({ kind: 'repo:/Users/her/app', subject: 'pnpm test' })).toBe('不问:repo:/Users/her/app')
    expect(habits.noAsk({ kind: 'repo:/Users/her/app', subject: 'git push origin main' })).toBeUndefined()
    expect(habits.noAsk({ kind: 'repo:/Users/her/app', subject: 'pnpm test', say: '要发布到小红书' })).toBeUndefined()
    expect(habits.noAsk({ kind: 'repo:/Users/her/other', subject: 'pnpm test' })).toBeUndefined()
  })

  it('表里被手改出一条沾四类的「不问」,也不认', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-habit-four2-'))
    dirs.push(dir)
    const { habits, rules } = await service(dir, [], local(10, 8, 9))
    const bad: StoredHabit = {
      id: '不问:派活', kind: 'noask', 类: '派活', value: '', text: '派活不问', status: 'kept',
      evidence: [], applied: [], created_at: local(10, 1, 0), updated_at: local(10, 1, 0), adopted_at: local(10, 1, 0),
    }
    await rules.putHabits([bad])
    expect(habits.noAsk({ kind: '派活', subject: 'x' })).toBeUndefined()
  })
})

describe('默认分派', () => {
  const now = ms(local(10, 9, 12))

  it('同一类事,推荐 A、她改成 B,在两件不同的事上 → 试用「这类事默认给 B」', () => {
    const rows = [
      dispatch(local(10, 3, 14, 20), 'T12', 'claude', 'codex'),
      dispatch(local(10, 5, 9, 10), 'T15', 'claude', 'codex'),
    ]
    const found = findDispatchHabits(rows, [], now)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: `分派:${CODE_LAPIS}→codex`, kind: 'dispatch', 类: CODE_LAPIS, value: 'codex', status: 'trial' })
    expect(found[0]?.text).toContain('Codex')
    expect(found[0]?.evidence.map(one => one.what).join('\n')).toMatch(/T12[\s\S]*Claude[\s\S]*Codex[\s\S]*T15/u)
  })

  it('同一件事改两次不算两次;别的类不串;推荐与她选的一样不算', () => {
    expect(findDispatchHabits([
      dispatch(local(10, 3, 14), 'T12', 'claude', 'codex'),
      dispatch(local(10, 3, 15), 'T12', 'claude', 'codex'),
    ], [], now)).toEqual([])
    expect(findDispatchHabits([
      dispatch(local(10, 3, 14), 'T12', 'claude', 'codex'),
      dispatch(local(10, 4, 14), 'T13', 'claude', 'codex', dispatchClassOf('chat')),
    ], [], now)).toEqual([])
    expect(findDispatchHabits([
      dispatch(local(10, 3, 14), 'T12', 'codex', 'codex'),
      dispatch(local(10, 4, 14), 'T13', 'codex', 'codex'),
    ], [], now)).toEqual([])
  })

  it('最近那一次她照推荐派了 → 不试用(她已经不改了)', () => {
    expect(findDispatchHabits([
      dispatch(local(10, 3, 14), 'T12', 'claude', 'codex'),
      dispatch(local(10, 4, 14), 'T13', 'claude', 'codex'),
      dispatch(local(10, 5, 14), 'T14', 'claude', 'claude'),
    ], [], now)).toEqual([])
  })

  it('没派成的也算她选的那一家', () => {
    expect(findDispatchHabits([
      dispatch(local(10, 3, 14), 'T12', 'claude', 'codex(没派成)'),
      dispatch(local(10, 4, 14), 'T13', 'claude', 'codex'),
    ], [], now)).toHaveLength(1)
  })

  it('试用之后:下一次推荐 B 她照派 = 留;改成别家 = 撤', () => {
    const [habit] = findDispatchHabits([
      dispatch(local(10, 3, 14), 'T12', 'claude', 'codex'),
      dispatch(local(10, 4, 14), 'T13', 'claude', 'codex'),
    ], [], ms(local(10, 4, 15)))
    if (habit === undefined) throw new Error('应当有一条')
    expect(verifyHabit(habit, [dispatch(local(10, 5, 9), 'T20', 'codex', 'codex')], now).status).toBe('kept')
    const back = verifyHabit(habit, [dispatch(local(10, 5, 9), 'T20', 'codex', 'kimi')], now)
    expect(back.status).toBe('reverted')
    expect(back.why).toContain('T20')
    // 推荐的不是 B(她点了名)→ 不算这一条的验证
    expect(verifyHabit(habit, [dispatch(local(10, 5, 9), 'T20', 'kimi', 'kimi')], now).status).toBe('trial')
  })

  it('接进派活推荐:没点名时这类事默认给 B,并说清是试用的习惯', () => {
    const view = dispatchChoices({
      text: '修一下首页的报错',
      kind: 'code',
      project: { name: 'Lapis', path: '/x/lapis' },
      quota: {},
      installed: () => true,
      learned: (kind, project) => (dispatchClassOf(kind, project) === CODE_LAPIS ? { family: 'codex', why: '按你的习惯(试用中)' } : undefined),
    })
    expect(view.default).toBe('codex')
    expect(view.default_why).toContain('按你的习惯')
    const named = dispatchChoices({
      text: '修一下首页的报错', kind: 'code', project: { name: 'Lapis', path: '/x/lapis' }, named: 'claude', quota: {}, installed: () => true,
      learned: () => ({ family: 'codex', why: '按你的习惯(试用中)' }),
    })
    expect(named.default).toBe('claude')
  })
})

describe('什么时候找她', () => {
  const now = ms(local(10, 9, 20))

  it('同一个钟点、两天都没接、从没接过 → 试用「这个时段不打电话、改发消息」', () => {
    const found = findQuietHabits([
      call(local(10, 5, 13, 10), false),
      call(local(10, 6, 13, 40), false),
      call(local(10, 6, 15, 0), true),
    ], [], now)
    expect(found.map(one => one.id)).toEqual(['时段:13'])
    expect(found[0]?.text).toContain('13:00')
  })

  it('一天没接两次不够;那个钟点接过一次也不算', () => {
    expect(findQuietHabits([call(local(10, 5, 13, 10), false), call(local(10, 5, 13, 40), false)], [], now)).toEqual([])
    expect(findQuietHabits([
      call(local(10, 4, 13, 5), true),
      call(local(10, 5, 13, 10), false),
      call(local(10, 6, 13, 40), false),
    ], [], now)).toEqual([])
  })

  it('试用里她在那个钟点接了一通 = 撤;改成消息的那一通过去了、她没接电话 = 留', () => {
    const [habit] = findQuietHabits([call(local(10, 5, 13, 10), false), call(local(10, 6, 13, 40), false)], [], ms(local(10, 6, 20)))
    if (habit === undefined) throw new Error('应当有一条')
    expect(verifyHabit(habit, [call(local(10, 7, 13, 30), true)], now).status).toBe('reverted')
    const used = { ...habit, applied: [{ at: local(10, 7, 13, 20), where: 'T3' }] }
    expect(verifyHabit(used, [], ms(local(10, 7, 13, 50))).status).toBe('trial')
    expect(verifyHabit(used, [], ms(local(10, 7, 14, 1))).status).toBe('kept')
  })
})

describe('早报挪到她第一次露面前', () => {
  const morning = { not_before: '06:00' }

  it('每天第一次露面:重启重复记的「当天第一次」、手机后台过了半夜多记的,都不带偏', () => {
    const days = firstSeenByDay([
      seen(local(10, 6, 9, 5), '电脑', true),
      seen(local(10, 6, 9, 30), '电脑', true), // 工作台重启又记了一次「当天第一次」
      seen(local(10, 6, 23, 50), '手机'),
      seen(local(10, 7, 0, 20), '手机'), // 手机在后台还在轮询:算前一天,不算 10-07 一早
      seen(local(10, 7, 9, 0), '手机', true),
      seen(local(10, 7, 9, 2), '电脑', true),
    ], '06:00')
    expect(days.get('2026-10-06')).toBe(9 * 60 + 5)
    expect(days.get('2026-10-07')).toBe(9 * 60)
  })

  it('没设早报时刻(露面才开工)、三天以上露面 → 试用「早报提前备好」= 中位数前 10 分钟', () => {
    const rows = [
      seen(local(10, 5, 9, 0)), seen(local(10, 6, 9, 20)), seen(local(10, 7, 8, 50)), seen(local(10, 8, 9, 10)),
    ]
    const habit = findBriefHabit(rows, [], ms(local(10, 9, 7)), morning)
    expect(habit?.id).toBe('早报:08:55')
    expect(habit?.text).toBe(briefHabitText('08:55', '09:05'))
    // 她自己定了时刻:不动她的设置
    expect(findBriefHabit(rows, [], ms(local(10, 9, 7)), { ...morning, at: '07:30' })).toBeUndefined()
    // 只有两天:不够
    expect(findBriefHabit(rows.slice(0, 2), [], ms(local(10, 9, 7)), morning)).toBeUndefined()
  })

  it('试用的第二天她在那之后才露面 = 留;比它还早 = 撤', () => {
    const habit = findBriefHabit([seen(local(10, 5, 9)), seen(local(10, 6, 9)), seen(local(10, 7, 9))], [], ms(local(10, 8, 7)), morning)
    if (habit === undefined) throw new Error('应当有一条')
    expect(verifyHabit(habit, [seen(local(10, 9, 9, 3))], ms(local(10, 9, 12))).status).toBe('kept')
    expect(verifyHabit(habit, [seen(local(10, 9, 8, 10))], ms(local(10, 9, 12))).status).toBe('reverted')
  })
})

describe('要不要问她', () => {
  const now = ms(local(10, 9, 12))
  const repo = 'repo:/Users/her/app'

  it('同一类她连着三次原样点头、跨两天 → 试用「不问,做完告诉她」', () => {
    const found = findNoAskHabits([
      approval(local(10, 5, 10), repo, true),
      approval(local(10, 6, 10), repo, true),
      approval(local(10, 6, 11), repo, true),
    ], [], now)
    expect(found.map(one => one.id)).toEqual([`不问:${repo}`])
    expect(found[0]?.text).toContain('app')
  })

  it('中间说过一次不行就从头数;都在同一天不算', () => {
    expect(findNoAskHabits([
      approval(local(10, 4, 10), repo, true),
      approval(local(10, 5, 10), repo, true),
      approval(local(10, 6, 10), repo, false),
      approval(local(10, 6, 11), repo, true),
      approval(local(10, 7, 11), repo, true),
    ], [], now)).toEqual([])
    expect(findNoAskHabits([
      approval(local(10, 6, 10), repo, true),
      approval(local(10, 6, 11), repo, true),
      approval(local(10, 6, 12), repo, true),
    ], [], now)).toEqual([])
  })

  it('试用里:放行过的那件事她打回 / 收回「同类都允许」= 撤;那件事通过了 = 留', () => {
    const [habit] = findNoAskHabits([
      approval(local(10, 5, 10), repo, true), approval(local(10, 6, 10), repo, true), approval(local(10, 6, 11), repo, true),
    ], [], ms(local(10, 6, 12)))
    if (habit === undefined) throw new Error('应当有一条')
    const used = { ...habit, applied: [{ at: local(10, 7, 9), where: 'T8' }] }
    const review = (result: string): BehaviorEntry => e(local(10, 7, 15), BEHAVIOR_EVENTS.review, { 对象: 'T8 改首页', 结果: result })
    expect(verifyHabit(used, [review('打回')], now).status).toBe('reverted')
    expect(verifyHabit(used, [review('通过')], now).status).toBe('kept')
    expect(verifyHabit(used, [e(local(10, 7, 10), BEHAVIOR_EVENTS.decide, { 对象: 'T8', 结果: '收回同类都允许', 类: repo })], now).status).toBe('reverted')
    expect(verifyHabit(used, [], now).status).toBe('trial')
  })
})

// ───────────────────────────── 服务:落表、进化日志、撤 ─────────────────────────────

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

async function service(dir: string, entries: BehaviorEntry[], nowIso: string) {
  const clock = { now: ms(nowIso) }
  const rules = createRulesService({ file: join(dir, 'rules.json'), now: () => clock.now })
  await rules.load()
  const ledger = { rows: [...entries] }
  const workdir = join(dir, '工作台')
  const habits = createHabitService({
    store: rules,
    behavior: { read: async () => ledger.rows },
    now: () => clock.now,
    workdir,
    io: {
      readFile: async (file) => { try { return readFileSync(file, 'utf8') } catch { return undefined } },
      writeFile: async (file, text) => {
        const { mkdirSync, writeFileSync } = await import('node:fs')
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, text, 'utf8')
      },
    },
    morning: () => ({ not_before: '06:00' }),
  })
  await habits.load()
  return { habits, rules, ledger, clock, logFile: join(workdir, EVOLVE_LOG_NAME) }
}

describe('习惯服务', () => {
  it('试用 → 进化日志一行(带证据)→ 下一次没纠正就留 → 日志里补一行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-habit-svc-'))
    dirs.push(dir)
    const s = await service(dir, [
      dispatch(local(10, 3, 14, 20), 'T12', 'claude', 'codex'),
      dispatch(local(10, 5, 9, 10), 'T15', 'claude', 'codex'),
    ], local(10, 5, 10))
    const first = await s.habits.learn()
    expect(first.adopted).toBe(1)
    expect(s.habits.dispatchDefault('code', 'Lapis')?.family).toBe('codex')
    expect(s.habits.dispatchDefault('chat')).toBeUndefined()
    const log = readFileSync(s.logFile, 'utf8')
    expect(log).toContain('试用')
    expect(log).toContain('T12')
    expect(log).toContain('T15')
    expect(log).toContain(`分派:${CODE_LAPIS}→codex`)

    s.ledger.rows.push(dispatch(local(10, 6, 9), 'T20', 'codex', 'codex'))
    s.clock.now = ms(local(10, 6, 10))
    const second = await s.habits.learn()
    expect(second.kept).toBe(1)
    expect(s.habits.view().kept.map(one => one.id)).toEqual([`分派:${CODE_LAPIS}→codex`])
    expect(readFileSync(s.logFile, 'utf8')).toMatch(/留下[\s\S]*T20/u)
    // 落在规矩表那一份里(同一个文件,不另起一套)
    expect(JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8')).habits[0].status).toBe('kept')
  })

  it('纠正了自动撤;撤过的同一条不再自动学回来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-habit-svc2-'))
    dirs.push(dir)
    const s = await service(dir, [
      dispatch(local(10, 3, 14), 'T12', 'claude', 'codex'),
      dispatch(local(10, 4, 14), 'T13', 'claude', 'codex'),
    ], local(10, 4, 15))
    await s.habits.learn()
    s.ledger.rows.push(dispatch(local(10, 5, 9), 'T20', 'codex', 'claude'))
    s.clock.now = ms(local(10, 5, 10))
    expect((await s.habits.learn()).reverted).toBe(1)
    expect(s.habits.dispatchDefault('code', 'Lapis')).toBeUndefined()
    expect(readFileSync(s.logFile, 'utf8')).toMatch(/撤了[\s\S]*T20/u)
    // 她又改了两次同样的 → 同一条不再试用
    s.ledger.rows.push(dispatch(local(10, 6, 9), 'T21', 'claude', 'codex'), dispatch(local(10, 7, 9), 'T22', 'claude', 'codex'))
    s.clock.now = ms(local(10, 7, 10))
    expect((await s.habits.learn()).adopted).toBe(0)
    expect(s.habits.view().retired.map(one => one.status)).toEqual(['reverted'])
  })

  it('她点「撤掉」:不再照做、日志补一行、以后不再学回来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-habit-svc3-'))
    dirs.push(dir)
    const s = await service(dir, [call(local(10, 5, 13, 10), false), call(local(10, 6, 13, 40), false)], local(10, 6, 20))
    await s.habits.learn()
    expect(s.habits.quietNow(ms(local(10, 7, 13, 30)))).toBe('时段:13')
    expect(s.habits.quietNow(ms(local(10, 7, 14, 30)))).toBeUndefined()
    const done = await s.habits.revoke('时段:13')
    expect(done.ok).toBe(true)
    expect(s.habits.quietNow(ms(local(10, 7, 13, 30)))).toBeUndefined()
    expect(readFileSync(s.logFile, 'utf8')).toContain('她撤掉了')
    expect((await s.habits.revoke('时段:13')).ok).toBe(false)
    expect((await s.habits.revoke('没有这条')).ok).toBe(false)
    s.ledger.rows.push(call(local(10, 8, 13, 10), false))
    s.clock.now = ms(local(10, 8, 20))
    expect((await s.habits.learn()).adopted).toBe(0)
  })

  it('用上一次就记一笔(看得见用了几次);早报时刻给例程', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-habit-svc4-'))
    dirs.push(dir)
    const s = await service(dir, [seen(local(10, 5, 9)), seen(local(10, 6, 9)), seen(local(10, 7, 9))], local(10, 8, 7))
    await s.habits.learn()
    expect(s.habits.briefAt()).toBe('08:50')
    await s.habits.applied('早报:08:50', '2026-10-08')
    const view = s.habits.view()
    expect(view.trial[0]).toMatchObject({ id: '早报:08:50', applied: 1, kind_title: HABIT_KIND_TITLES.brief })
  })
})

/**
 * 维护者 10-09 拍板(花钱):学到的早报时刻**只在前一天露过面的日子**按时刻提前备好;
 * 连着不来就不白花一次模型额度,那天等她露面再照老办法开工。
 */
describe('早报学到的时刻:前一天露过面才提前跑(10-09 拍板)', () => {
  const dirs: string[] = []
  afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

  it('★前一天(10-07)露过面 → 10-08 早上给出学到的时刻', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-habit-brief-gate-'))
    dirs.push(dir)
    const s = await service(dir, [seen(local(10, 5, 9)), seen(local(10, 6, 9)), seen(local(10, 7, 9))], local(10, 8, 7))
    await s.habits.learn()
    expect(s.habits.briefAt()).toBe('08:50')
  })

  it('★前一天没露面 → 不按学到的时刻提前跑(回 undefined,例程照露面开工)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-habit-brief-gate2-'))
    dirs.push(dir)
    const s = await service(dir, [seen(local(10, 3, 9)), seen(local(10, 4, 9)), seen(local(10, 5, 9))], local(10, 6, 7))
    await s.habits.learn()
    expect(s.habits.view().trial.map(one => one.id)).toContain('早报:08:50')
    s.clock.now = ms(local(10, 8, 7))
    expect(s.habits.briefAt()).toBeUndefined()
  })

  it('当天新记的露面(noteSeen)即时算进去:不用等下一次学', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-habit-brief-gate3-'))
    dirs.push(dir)
    const s = await service(dir, [seen(local(10, 3, 9)), seen(local(10, 4, 9)), seen(local(10, 5, 9))], local(10, 6, 7))
    await s.habits.learn()
    expect(s.habits.view().trial.map(one => one.id)).toContain('早报:08:50')
    s.habits.noteSeen(local(10, 7, 21))
    s.clock.now = ms(local(10, 8, 7))
    expect(s.habits.briefAt()).toBe('08:50')
  })
})
