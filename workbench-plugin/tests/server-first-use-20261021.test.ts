// @vitest-environment node
/**
 * 三件主路成没成(2026-10-21,卡「引导三件事」;服务端 `server/firstUse.ts`)。
 *
 * 判法**全从现成的记录里看**,不另起一套状态:早报看例程那一次与当天播客,交代看卡上的派活记录
 * (只认协议路那两家 Claude / Codex),电话由建卡 / 捎话那几条路当场记。成与没成都记进行为账
 * (`事:'主路'`),「这台机器三件事各成没成、第几天成的」从行为账一条接口读得出。
 * 自检(安装器末尾那一遍)单独记:它不是她用出来的,不进行为账的数。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RoutineRun, TaskView } from '../src/protocol.ts'
import { createBehaviorLog } from '../src/server/behaviorLog.ts'
import {
  MAIN_PATH_EVENT,
  createFirstUseService,
  ledgerEventsOf,
  localDayOf,
  observeOutcomes,
  readinessDoor,
  summarizeMainPaths,
  type Readiness,
} from '../src/server/firstUse.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-first-use-'))
  dirs.push(dir)
  return dir
}

const TODAY = '2026-10-21'
const T0 = Date.parse('2026-10-21T09:00:00+08:00')

function run(patch: Partial<RoutineRun> = {}): RoutineRun {
  return { name: 'morning', date: TODAY, trigger: 'manual', started_at: '2026-10-21T01:00:00.000Z', finished_at: '2026-10-21T01:01:00.000Z', status: 'ok', ...patch }
}

function task(id: string, patch: Partial<TaskView> = {}): TaskView {
  return { id, title: id, status: 'doing', ...patch } as TaskView
}

const READY: Readiness = {
  model: true,
  coders: [{ family: 'claude', title: 'Claude', installed: true, login: 'yes' }, { family: 'codex', title: 'Codex', installed: true, login: 'no' }],
  worker: 'up',
  voice: true,
}

describe('从现成记录里看出成没成', () => {
  it('早报:例程出了、当天播客有文件 = 成', () => {
    const out = observeOutcomes({ morning: run(), podcast: { date: TODAY, file: true }, podcastWanted: true, tasks: [] })
    expect(out).toEqual([{ key: 'morning:2026-10-21T01:00:00.000Z:ok', path: 'morning', ok: true, at: '2026-10-21T01:01:00.000Z' }])
  })

  it('早报出了但播客没出声:没成,缺语音 / 缺模型 / 没资讯各说各的', () => {
    const voice = observeOutcomes({ morning: run(), podcast: { date: TODAY, file: false, error: '这台机器上的语音后端没接上,今天只有文字稿' }, podcastWanted: true, tasks: [] })
    expect(voice[0]).toMatchObject({ path: 'morning', ok: false, door: 'voice' })
    const model = observeOutcomes({ morning: run(), podcast: { date: TODAY, file: false, error: '模型服务还没接上,今天没有口播稿' }, podcastWanted: true, tasks: [] })
    expect(model[0]).toMatchObject({ ok: false, door: 'model' })
  })

  it('播客还没出来(没有当天的记录)= 还在路上,不算没成', () => {
    expect(observeOutcomes({ morning: run(), podcastWanted: true, tasks: [] })).toEqual([])
    expect(observeOutcomes({ morning: run(), podcast: { date: '2026-10-20', file: true }, podcastWanted: true, tasks: [] })).toEqual([])
  })

  it('播客关着的机器:早报出来就算成', () => {
    expect(observeOutcomes({ morning: run(), podcastWanted: false, tasks: [] })[0]).toMatchObject({ ok: true })
  })

  it('例程本身失败:没成,原因原话带上;跳过的不算', () => {
    const failed = observeOutcomes({ morning: run({ status: 'failed', note: '写不进记忆' }), podcastWanted: true, tasks: [] })
    expect(failed[0]).toMatchObject({ ok: false, door: 'other', note: '写不进记忆' })
    expect(observeOutcomes({ morning: run({ status: 'skipped' }), podcastWanted: true, tasks: [] })).toEqual([])
  })

  it('交代:派给 Claude / Codex 的活交回了 = 成;命令行与协议两条记录都认', () => {
    const out = observeOutcomes({
      podcastWanted: true,
      tasks: [
        task('t-cli', { dispatch: { family: 'claude', status: 'done', started_at: '2026-10-21T02:00:00.000Z', ended_at: '2026-10-21T02:03:00.000Z', reply: '介绍好了' } as NonNullable<TaskView['dispatch']> }),
        task('t-acp', { client_dispatch: { hand: 'window', family: 'codex', status: 'sent', at: '2026-10-21T02:00:00.000Z', text: 'x', reply: '这是一段介绍', reply_at: '2026-10-21T02:05:00.000Z' } as NonNullable<TaskView['client_dispatch']> }),
      ],
    })
    expect(out).toEqual([
      { key: 'delegate:t-cli:ok', path: 'delegate', ok: true, at: '2026-10-21T02:03:00.000Z', family: 'claude' },
      { key: 'delegate:t-acp:ok', path: 'delegate', ok: true, at: '2026-10-21T02:05:00.000Z', family: 'codex' },
    ])
  })

  it('交代:派不出去(没登录)= 没成,缺登录那道门;别的失败原话带上', () => {
    const out = observeOutcomes({
      podcastWanted: true,
      tasks: [
        task('t-block', { status: 'blocked', dispatch_block: { family: 'claude', kind: 'code', why: 'Claude 命令行没登录', fix: { kind: 'login_cli', family: 'claude', label: '登录 Claude' }, at: '2026-10-21T03:00:00.000Z' } }),
        task('t-fail', { dispatch: { family: 'codex', status: 'failed', started_at: '2026-10-21T03:00:00.000Z', ended_at: '2026-10-21T03:01:00.000Z', note: 'Codex 回了 429' } as NonNullable<TaskView['dispatch']> }),
      ],
    })
    expect(out).toEqual([
      { key: 'delegate:t-block:fail', path: 'delegate', ok: false, at: '2026-10-21T03:00:00.000Z', door: 'ai_login', family: 'claude', note: 'Claude 命令行没登录' },
      { key: 'delegate:t-fail:fail', path: 'delegate', ok: false, at: '2026-10-21T03:01:00.000Z', door: 'other', family: 'codex', note: 'Codex 回了 429' },
    ])
  })

  it('交代:豆包 / Kimi 那几家(读窗口)不算主路;还在跑的不算', () => {
    const out = observeOutcomes({
      podcastWanted: true,
      tasks: [
        task('t-doubao', { client_dispatch: { hand: 'window', family: 'doubao', status: 'sent', at: 'x', text: 'x', reply: '图好了', reply_at: '2026-10-21T02:05:00.000Z' } as NonNullable<TaskView['client_dispatch']> }),
        task('t-run', { dispatch: { family: 'codex', status: 'running', started_at: '2026-10-21T02:00:00.000Z' } as NonNullable<TaskView['dispatch']> }),
      ],
    })
    expect(out).toEqual([])
  })
})

describe('缺哪道门(还没试就看得出来的那几道)', () => {
  it('早报缺模型钥匙;交代一家都没装 / 都没登录;电话手机那一版要通话工人', () => {
    expect(readinessDoor('morning', { ...READY, model: false }, 'phone')?.door).toBe('model')
    expect(readinessDoor('morning', READY, 'phone')).toBeUndefined()
    expect(readinessDoor('delegate', { ...READY, coders: [] }, 'phone')?.door).toBe('ai_missing')
    const login = readinessDoor('delegate', { ...READY, coders: [{ family: 'claude', title: 'Claude', installed: true, login: 'no' }, { family: 'codex', title: 'Codex', installed: false, login: 'unknown' }] }, 'phone')
    expect(login?.door).toBe('ai_login')
    expect(login?.fixes.map(one => one.family)).toEqual(['claude'])
    expect(readinessDoor('delegate', READY, 'phone')).toBeUndefined()
    // 登录状态查不出来(unknown)不许说成没登录。
    expect(readinessDoor('delegate', { ...READY, coders: [{ family: 'codex', title: 'Codex', installed: true, login: 'unknown' }] }, 'phone')).toBeUndefined()
    // 这台没接派活能力表:一样不说缺。
    expect(readinessDoor('delegate', { model: true, worker: 'up' }, 'phone')).toBeUndefined()
    expect(readinessDoor('call', { ...READY, worker: 'down' }, 'phone')?.door).toBe('worker')
    // 电脑那一版(没配手机)不要通话工人。
    expect(readinessDoor('call', { ...READY, worker: 'down' }, 'desk')).toBeUndefined()
  })
})

describe('第几天成的', () => {
  it('从装好那天数起,当天是第 1 天', () => {
    const summary = summarizeMainPaths([
      { path: 'morning', ok: false, at: '2026-10-21T01:00:00.000Z', door: 'voice' },
      { path: 'morning', ok: true, at: '2026-10-23T01:00:00.000Z' },
      { path: 'morning', ok: true, at: '2026-10-24T01:00:00.000Z' },
      { path: 'delegate', ok: false, at: '2026-10-21T02:00:00.000Z', door: 'ai_login' },
    ], '2026-10-21')
    expect(summary.morning).toMatchObject({ ok: true, first_ok_at: '2026-10-23T01:00:00.000Z', ok_day: 3, first_fail_at: '2026-10-21T01:00:00.000Z', oks: 2, fails: 1 })
    expect(summary.delegate).toMatchObject({ ok: false, fails: 1, last_door: 'ai_login' })
    expect(summary.call).toMatchObject({ ok: false, oks: 0, fails: 0 })
  })

  it('本机日期:按这台机器的时区切天', () => {
    expect(localDayOf(Date.parse('2026-10-21T15:59:00Z'), -480)).toBe('2026-10-21')
    expect(localDayOf(Date.parse('2026-10-21T16:01:00Z'), -480)).toBe('2026-10-22')
  })

  it('行为账里那几条认得回来', () => {
    const events = ledgerEventsOf([
      { at: '2026-10-21T01:00:00.000Z', 端: '电脑', 事: MAIN_PATH_EVENT, 对象: '早报', 结果: '成' },
      { at: '2026-10-21T02:00:00.000Z', 端: '电脑', 事: MAIN_PATH_EVENT, 对象: '交代', 结果: '没成:没登录 Claude 或 Codex', 类: 'ai_login' },
      { at: '2026-10-21T02:00:00.000Z', 端: '电脑', 事: '说', 对象: '事务官', 结果: '交给事务官' },
    ])
    expect(events).toEqual([
      { path: 'morning', ok: true, at: '2026-10-21T01:00:00.000Z' },
      { path: 'delegate', ok: false, at: '2026-10-21T02:00:00.000Z', door: 'ai_login' },
    ])
  })
})

describe('服务:记账、去重、她选的那一件、收尾那一刻', () => {
  async function service() {
    const dir = tmp()
    let nowMs = T0
    const behaviorLog = createBehaviorLog({ dir: join(dir, '行为账'), now: () => new Date(nowMs) })
    const svc = createFirstUseService({ file: join(dir, 'first-use.json'), behaviorLog, now: () => nowMs })
    await svc.ready()
    return { svc, behaviorLog, dir, tick: (ms: number) => { nowMs += ms } }
  }

  it('同一件只记一次;记进行为账', async () => {
    const { svc, behaviorLog } = await service()
    const input = { morning: run(), podcast: { date: TODAY, file: true }, podcastWanted: true, tasks: [] }
    expect(await svc.observe(input)).toBe(true)
    expect(await svc.observe(input)).toBe(false)
    await behaviorLog.flush()
    const entries = (await behaviorLog.read({})).filter(one => one.事 === MAIN_PATH_EVENT)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ 端: '电脑', 对象: '早报', 结果: '成' })
  })

  it('她选的那一件排第一;三样都成那一刻记下,之后不再变', async () => {
    const { svc, tick } = await service()
    await svc.setPrefer('call')
    expect(svc.view({ readiness: READY, phonePaired: true }).order).toEqual(['call', 'morning', 'delegate'])
    await svc.observe({ morning: run(), podcast: { date: TODAY, file: true }, podcastWanted: true, tasks: [] })
    await svc.observe({ podcastWanted: true, tasks: [task('t1', { dispatch: { family: 'claude', status: 'done', started_at: 'x', ended_at: '2026-10-21T02:03:00.000Z', reply: '好' } as NonNullable<TaskView['dispatch']> })] })
    expect(svc.view({ readiness: READY, phonePaired: true }).closed_at).toBeUndefined()
    tick(60_000)
    await svc.record({ key: 'call:t-call', path: 'call', ok: true, at: new Date(T0 + 60_000).toISOString() }, '电话')
    const view = svc.view({ readiness: READY, phonePaired: true })
    expect(view.paths.map(one => one.state)).toEqual(['ok', 'ok', 'ok'])
    expect(view.closed_at).toBe(new Date(T0 + 60_000).toISOString())
    expect(view.paths.find(one => one.path === 'call')?.ok_day).toBe(1)
  })

  it('没成过的那一件:缺的那道门写在上面;试过没成的写它最后那一次的门', async () => {
    const { svc } = await service()
    await svc.observe({ podcastWanted: true, tasks: [task('t-block', { status: 'blocked', dispatch_block: { family: 'claude', kind: 'code', why: '没登录', fix: { kind: 'login_cli', family: 'claude', label: '登录 Claude' }, at: '2026-10-21T03:00:00.000Z' } })] })
    const view = svc.view({ readiness: { ...READY, model: false }, phonePaired: false })
    const byPath = Object.fromEntries(view.paths.map(one => [one.path, one]))
    expect(byPath.morning).toMatchObject({ state: 'missing', door: { door: 'model' } })
    expect(byPath.delegate).toMatchObject({ state: 'missing', door: { door: 'ai_login' }, fails: 1 })
    // 没配手机:第三件换成在电脑上说一句,不算缺门。
    expect(view.call_mode).toBe('desk')
    expect(byPath.call).toMatchObject({ state: 'todo' })
    expect(byPath.call?.say).toContain('电脑')
  })

  it('自检派出去的那张卡、自检跑的那一遍早报:不进行为账的数', async () => {
    const { svc, behaviorLog } = await service()
    await svc.selfcheck.run({
      readiness: async () => ({ ...READY, phonePaired: false }),
      morning: async () => ({ ok: true, startedAt: '2026-10-21T01:00:00.000Z' }),
      delegate: async () => ({ started: true, taskId: 't-self', family: 'claude', title: 'Claude' }),
      call: async () => ({ ok: false, door: 'phone' }),
    })
    await svc.observe({ morning: run(), podcast: { date: TODAY, file: true }, podcastWanted: true, tasks: [task('t-self', { dispatch: { family: 'claude', status: 'done', started_at: 'x', ended_at: '2026-10-21T01:03:00.000Z', reply: '介绍好了' } as NonNullable<TaskView['dispatch']> })] })
    await behaviorLog.flush()
    expect((await behaviorLog.read({})).filter(one => one.事 === MAIN_PATH_EVENT)).toEqual([])
    const check = svc.selfcheck.view()
    expect(check?.rows.map(one => one.state)).toEqual(['ok', 'ok', 'missing'])
    expect(check?.lines[2]).toMatch(/^打个电话:没成 —— 手机没配对/)
    expect(check?.ended_at).toBeDefined()
    expect(svc.view({ readiness: READY, phonePaired: false }).paths.every(one => one.oks === 0)).toBe(true)
  })

  it('自检里交代那件还没回:那一行「在路上」,不算没成', async () => {
    const { svc } = await service()
    await svc.selfcheck.run({
      readiness: async () => ({ ...READY, phonePaired: true }),
      morning: async () => ({ ok: false, door: 'model' }),
      delegate: async () => ({ started: true, taskId: 't-self', family: 'codex', title: 'Codex' }),
      call: async () => ({ ok: true }),
    })
    const check = svc.selfcheck.view()
    expect(check?.rows.map(one => one.state)).toEqual(['missing', 'pending', 'ok'])
    expect(check?.lines[1]).toBe('交代一件事:在路上 —— 派给 Codex 了,结果回来会出现在卡上')
  })

  it('落盘:重开之后她选的那一件、记过的那几笔、装好那天都还在', async () => {
    const dir = tmp()
    const file = join(dir, 'first-use.json')
    const first = createFirstUseService({ file, now: () => T0 })
    await first.ready()
    await first.setPrefer('delegate')
    await first.record({ key: 'call:x', path: 'call', ok: true, at: new Date(T0).toISOString() }, '电话')
    const again = createFirstUseService({ file, now: () => T0 + 3 * 86_400_000 })
    await again.ready()
    const view = again.view({ readiness: READY, phonePaired: true })
    expect(view.prefer).toBe('delegate')
    expect(view.day0).toBe(first.view({ readiness: READY, phonePaired: true }).day0)
    expect(view.paths.find(one => one.path === 'call')?.state).toBe('ok')
  })

  it('电话那一件没成过、她刚点了「我这就拨」:下一通电话的人设里多一段「先介绍自己,再问有什么要盯的」', async () => {
    const { svc, tick } = await service()
    // 平常打电话不出这一段:她得先在引导那一屏点了「我这就拨」。
    expect(svc.callBlock()).toBeUndefined()
    await svc.trying('call')
    const block = svc.callBlock()
    expect(block).toContain('有什么要我盯的')
    await svc.record({ key: 'call:t', path: 'call', ok: true, at: new Date(T0).toISOString() }, '电话')
    expect(svc.callBlock()).toBeUndefined()
    void tick
  })

  it('点了「我这就拨」超过一刻钟还没打:这一段不再出现', async () => {
    const { svc, tick } = await service()
    await svc.trying('call')
    tick(16 * 60_000)
    expect(svc.callBlock()).toBeUndefined()
  })
})

describe('写口播稿那一下连不上模型', () => {
  it('「没能写出今天的口播稿:fetch failed」归缺模型那道门', () => {
    const out = observeOutcomes({ morning: run(), podcast: { date: TODAY, file: false, error: '没能写出今天的口播稿:fetch failed' }, podcastWanted: true, tasks: [] })
    expect(out[0]).toMatchObject({ ok: false, door: 'model' })
  })
})

it('执行失败立即退出 trying，刷新服务后仍保留失败说明', async () => {
  const dir = tmp()
  const options = { file: join(dir, 'first-use.json'), now: () => T0 }
  const service = createFirstUseService(options)
  await service.trying('morning')
  await service.record({ key: 'failure:morning', path: 'morning', ok: false, at: new Date(T0).toISOString(), door: 'other', note: '服务暂时不可用' }, '电脑')
  const reloaded = createFirstUseService(options)
  await reloaded.ledgerSummary()
  const view = reloaded.view({ phonePaired: false, readiness: READY })
  expect(view.paths.find(one => one.path === 'morning')).toMatchObject({ state: 'missing', door: { text: expect.stringContaining('服务暂时不可用') } })
})
