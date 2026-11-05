// @vitest-environment node
/**
 * 每件事的花费 / 时长上限,与外层「停掉这一件」(2026-09-25,卡 O;设计第一节第 6 条)。
 *
 * 维护者:「让事务官自己改代码太坑了,一个显示问题修了半小时,还没修好」—— 那一件 37 分钟、120 次模型、约 1.6 元,
 * 外层没有「停掉这一件」。这里钉住:钱与中转同一套价目;到上限先停(= DSH 底层页那颗停止键)、卡挂「阻塞 · 等你输入」、
 * 外层问继续 / 停 / 换一家;「停掉这一件」三种在跑的都真停。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import type { DshSessionUsage } from '../src/server/dshSessionFeed.ts'
import type { ItemBudgetDeps, OuterAsker } from '../src/server/itemBudget.ts'
import {
  ITEM_PRICES_CNY, budgetChoiceOf, budgetVerdict, costCnyOf, createBudgetStore, createItemBudget, parseBudgetConfig, priceTierOfModel, spentLine,
} from '../src/server/itemBudget.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { BUDGET_STUCK_UNKNOWN, budgetAskLine } from '../src/server/budgetPolicy.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let i = 0; i < 200 && !ok(value); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    value = await read()
  }
  return value
}

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-item-budget-'))
  dirs.push(dir)
  return dir
}

describe('价目:与工作台模型服务同一套', () => {
  it('★价目表与中转 relay/server/pricing.cjs 的 DEFAULT_PRICES_CNY 逐字相同', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'relay', 'server', 'pricing.cjs'), 'utf8')
    for (const [tier, prices] of Object.entries(ITEM_PRICES_CNY)) {
      const found = new RegExp(`'${tier}':\\s*\\[([^\\]]+)\\]`).exec(text)
      expect(found?.[1]?.split(',').map(one => Number(one.trim()))).toEqual([...prices])
    }
  })

  it('那一件的真数字:输入 1320 万(99% 命中缓存)、输出 12 万,Flash 价 ≈ 1.7 元(工作台当天记账 1.66)', () => {
    const cost = costCnyOf({ cacheReadTokens: 13_068_000, uncachedInputTokens: 132_000, outputTokens: 120_000, cacheWriteTokens: 0 }, 'deepseek-v4-flash')
    expect(cost).toBeGreaterThan(1.6)
    expect(cost).toBeLessThan(1.8)
    // 认不出的名字按 Pro(宁可多算)
    expect(priceTierOfModel('deepseek-chat')).toBe('deepseek-pro')
    expect(priceTierOfModel(undefined)).toBe('deepseek-pro')
    expect(costCnyOf(undefined, 'x')).toBeUndefined()
  })
})

describe('上限的配置', () => {
  it('默认 0.5 元 / 10 分钟;配坏了退回默认(不许变成「不设上限」);存 budget.json', async () => {
    expect(parseBudgetConfig({})).toEqual({ cny: 0.5, minutes: 10 })
    expect(parseBudgetConfig({ cny: -1, minutes: 0 })).toEqual({ cny: 0.5, minutes: 10 })
    const file = join(tmp(), 'budget.json')
    const store = createBudgetStore(file)
    expect(await store.load()).toEqual({ cny: 0.5, minutes: 10 })
    expect((await store.save({ cny: 1, minutes: 20 })).ok).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ cny: 1, minutes: 20 })
    expect((await store.save({ cny: 0, minutes: 20 })).ok).toBe(false)
  })
})

function butlerTask(patch: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-1', title: '修首页球的显示问题', status: 'doing', direction: 'mine',
    conversation: { agent: 'dsh', session_id: 's-1' }, source: { kind: 'manual' }, created_at: '', updated_at: '', ...patch,
  }
}

const usage = (patch: Partial<DshSessionUsage> = {}): DshSessionUsage => ({
  // 步数不再是一条线(2026-10-04 去掉了);这里的 8 步只是卡上那个事实。
  model: 'deepseek-v4-flash', steps: 8, run_ms: 4 * 60_000, running: true,
  tokenUsage: { cacheReadTokens: 2_000_000, uncachedInputTokens: 20_000, outputTokens: 20_000, cacheWriteTokens: 0 }, ...patch,
})

describe('判:到没到', () => {
  it('钱先到 / 时间先到都算;停下之后不再判', () => {
    const config = { cny: 0.5, minutes: 10 }
    expect(budgetVerdict(butlerTask(), config, usage()).over).toBe(false)
    const money = budgetVerdict(butlerTask(), config, usage({ tokenUsage: { cacheReadTokens: 8_000_000, uncachedInputTokens: 80_000, outputTokens: 40_000, cacheWriteTokens: 0 } }))
    expect(money.over).toBe(true)
    expect(money.why).toMatch(/^花了约 0\.\d\d 元$/)
    const time = budgetVerdict(butlerTask(), config, usage({ run_ms: 11 * 60_000 }))
    expect(time).toMatchObject({ over: true, why: '跑了 11 分钟' })
    expect(budgetVerdict(butlerTask({ budget: { limit_cny: 1, limit_minutes: 20, state: 'paused' } }), config, usage({ run_ms: 30 * 60_000 })).over).toBe(false)
    // ★ 2026-10-04:「走了 N 步」照旧是**事实**留在卡上;上限那一串里**没有步数**了(那条线不存在了)。
    expect(spentLine(time.view)).toBe('花了约 0.28 元 · 跑了 11 分钟 · 走了 8 步(上限 0.5 元 / 10 分钟)')
  })

  it('外层那一问的选项名 → 选择', () => {
    expect(budgetChoiceOf('继续')).toBe('continue')
    expect(budgetChoiceOf('停掉这一件')).toBe('stop')
    expect(budgetChoiceOf('换 Claude 来做')).toBe('switch')
    expect(budgetChoiceOf('我想想')).toBeUndefined()
  })
})

/**
 * `dir`:在**已有的**那个目录上再起一个服务(「重启」= 同一份 tasks.json 上重建服务,经纪人空了;同卡 U8 的做法),不再建卡。
 * `now`:重启后的「现在」(挂回来的那一问该带第一次停下来的时刻,不是这个)。
 */
async function setup(opts: { running?: boolean, asker?: OuterAsker, cancelRunning?: boolean, resumeOk?: boolean, dir?: string, now?: Date, onLimit?: NonNullable<ItemBudgetDeps['onLimit']> } = {}) {
  const dir = opts.dir ?? tmp()
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  let id: string
  if (opts.dir === undefined) {
    const created = await tasks.create({ title: '修首页球的显示问题', status: 'todo', direction: 'mine', origin: 'user' })
    id = created.id as string
    await tasks.update(id, { conversation: { agent: 'dsh', session_id: 's-1' } })
    await tasks.move(id, 'doing')
  }
  else {
    id = (await tasks.list()).tasks[0]?.id as string
  }
  let current = usage({ run_ms: 11 * 60_000 })
  const cancels: string[] = []
  const said: string[] = []
  const killed: number[] = []
  const switched: string[] = []
  const excluded: (string | undefined)[] = []
  const resumed: string[] = []
  const laterFns: (() => void)[] = []
  const budget = createItemBudget({
    tasks,
    config: () => ({ cny: 0.5, minutes: 10 }),
    usage: () => current,
    cancelSession: async (sessionId) => { cancels.push(sessionId); return { ok: true, running: opts.cancelRunning !== false } },
    say: async (_sessionId, text) => { said.push(text); return true },
    ...(opts.asker === undefined ? {} : { asker: opts.asker }),
    switchCandidate: async (_taskId, exclude) => {
      excluded.push(exclude)
      return exclude === 'claude' ? { family: 'codex', title: 'Codex' } : { family: 'claude', title: 'Claude', note: '本周还剩约 62%' }
    },
    resumeCli: async (_taskId, family) => { resumed.push(family); return opts.resumeOk === false ? { ok: false, note: '没派出去' } : { ok: true, note: `已经让 ${family} 在命令行里接着做` } },
    switchTo: async (_taskId, family) => { switched.push(family); return { ok: true, note: `已经让 ${family} 在命令行里开始做` } },
    killPid: (pid) => { killed.push(pid) },
    now: () => opts.now ?? new Date('2026-09-25T15:00:00.000Z'),
    setTimer: () => 1,
    clearTimer: () => {},
    later: (fn) => { laterFns.push(fn) },
    ...(opts.onLimit === undefined ? {} : { onLimit: opts.onLimit }),
  })
  return { dir, tasks, id, budget, cancels, said, killed, switched, excluded, resumed, laterFns, setUsage: (next: DshSessionUsage) => { current = next } }
}

/** 记下每一问、留着答的口(答案的口按挂的先后排)。 */
function recordingAsker() {
  const asked: Parameters<OuterAsker['ask']>[0][] = []
  const answers: ((value: { kind: 'answer', answers: { id: string, selected: string[] }[] }) => void)[] = []
  const asker: OuterAsker = {
    ask: (req) => {
      asked.push(req)
      return { id: `q-${asked.length}`, answer: new Promise((resolve) => { answers.push(resolve) }) }
    },
  }
  return { asker, asked, answers }
}

describe('服务:到了先停下来问', () => {
  it('★到上限:先停那条会话(= DSH 停止键)、卡上写清花了多少、记下「这一次是我们停的」;生命周期照单挪到「阻塞 · 等你输入」', async () => {
    const { tasks, id, budget, cancels } = await setup()
    expect(await budget.tick()).toBe(1)
    expect(cancels).toEqual(['s-1'])
    const task = (await tasks.list()).tasks.find(one => one.id === id)
    expect(task?.budget?.state).toBe('paused')
    expect(task?.note).toBe('到上限了,先停下来了:花了约 0.28 元 · 跑了 11 分钟 · 走了 8 步(上限 0.5 元 / 10 分钟)。继续、停掉这一件,还是换 Claude 来做?')
    // 会话报「被停了」时生命周期问这一句:照单子办,不写「你停了它」
    expect(budget.expectedAbort('s-1')).toMatchObject({ status: 'blocked', blockReason: 'input' })
    expect(budget.expectedAbort('s-1')).toBeUndefined()
    // 停下来之后下一拍不再停第二次、不再问第二遍
    expect(await budget.tick()).toBe(0)
  })

  it('会话这会儿本来没在跑(停止键是空操作)→ 自己把卡挪到「阻塞 · 等你输入」', async () => {
    const { tasks, id, budget } = await setup({ cancelRunning: false })
    await budget.tick()
    const task = (await tasks.list()).tasks.find(one => one.id === id)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('input')
  })

  it('★外层问他(卡 M 那套):三个选项;他在外层答「继续」→ 上限加一档、叫她接着做', async () => {
    const asked: Parameters<OuterAsker['ask']>[0][] = []
    let answer: ((value: { kind: 'answer', answers: { id: string, selected: string[] }[] }) => void) | undefined
    const asker: OuterAsker = {
      ask: (req) => {
        asked.push(req)
        return { id: 'q-1', answer: new Promise((resolve) => { answer = resolve }) }
      },
    }
    const { tasks, id, budget, said } = await setup({ asker })
    await budget.tick()
    expect(asked[0]?.sessionId).toBe('s-1')
    expect(asked[0]?.questions[0]?.options?.map(one => one.label)).toEqual(['继续', '停掉这一件', '换 Claude 来做'])
    answer?.({ kind: 'answer', answers: [{ id: 'budget', selected: ['继续'] }] })
    // 条件只看读到的那一份(读盘可能在「继续」落盘之前开始、之后才回来,那时 said 已经有了 —— 高负载下见过这样读到旧的一份)。
    const task = await waitFor(async () => (await tasks.list()).tasks.find(one => one.id === id), one => one?.budget?.state === 'running' && one.status === 'doing')
    await waitFor(async () => said.length, n => n > 0)
    expect(task?.budget).toMatchObject({ state: 'running', extended: 1, limit_cny: 1, limit_minutes: 20 })
    expect(task?.status).toBe('doing')
    // ★ 2026-10-04:加档那一句里**没有步数**(「步数也加一档」那半条一起拆了)。
    expect(said[0]).toContain('上限加了一档(到 1 元 / 20 分钟)')
    expect(said[0]).not.toMatch(/步/)
    expect(task?.budget?.limit_steps).toBeUndefined()
  })

  it('卡上的键先答了:外层那一问撤掉(signal abort)', async () => {
    let signal: AbortSignal | undefined
    const asker: OuterAsker = { ask: (req) => { signal = req.signal; return { id: 'q', answer: new Promise(() => {}) } } }
    const { budget, id } = await setup({ asker })
    await budget.tick()
    expect(signal?.aborted).toBe(false)
    await budget.choose(id, 'continue')
    expect(signal?.aborted).toBe(true)
  })

  it('换一家:按挑手给的那家派出去(写代码的活),上限那一格记成停了', async () => {
    const { tasks, id, budget, switched } = await setup()
    await budget.tick()
    const done = await budget.choose(id, 'switch')
    expect(done.ok).toBe(true)
    expect(switched).toEqual(['claude'])
    expect((await tasks.list()).tasks.find(one => one.id === id)?.budget).toMatchObject({ state: 'stopped', note: '换给 Claude 做了' })
  })
})

describe('外层「停掉这一件」', () => {
  it('★事务官自己在办的:停那条 DSH 会话,卡上写清花了多少;生命周期照单挪回待办', async () => {
    const { tasks, id, budget, cancels } = await setup()
    const stopped = await budget.stopItem(id)
    expect(stopped.ok).toBe(true)
    expect(cancels).toEqual(['s-1'])
    const expected = budget.expectedAbort('s-1')
    expect(expected?.status).toBe('todo')
    expect(expected?.note).toContain('你停掉了这一件:花了约')
    expect((await tasks.list()).tasks.find(one => one.id === id)?.budget?.state).toBe('stopped')
  })

  it('停了却一直没等到「被停了」那一下:5 秒后兜底自己挪回待办', async () => {
    const { tasks, id, budget, laterFns } = await setup()
    await budget.stopItem(id)
    laterFns.forEach(fn => fn())
    const task = await waitFor(async () => (await tasks.list()).tasks.find(one => one.id === id), one => one?.status === 'todo')
    expect(task?.status).toBe('todo')
  })

  it('派给别家命令行的:杀那个进程;派进窗口还在等回答的:不再等(那家窗口里那一句停不了,如实说)', async () => {
    const { tasks, budget, killed } = await setup()
    const cli = await tasks.create({ title: '让 Codex 改一下 README', status: 'todo', direction: 'mine', origin: 'user' })
    const cliId = cli.id as string
    await tasks.update(cliId, { dispatch: { family: 'codex', status: 'running', hand: 'cli', cwd: '/repo', pid: 4242, started_at: 'x' } })
    await tasks.move(cliId, 'doing')
    const win = await tasks.create({ title: '让 Kimi 查一下', status: 'todo', direction: 'mine', origin: 'user' })
    const winId = win.id as string
    await tasks.update(winId, { clientDispatch: { hand: 'window', family: 'kimi', status: 'sent', at: 'x', text: 'y', marker: '工作台派活 abc', reply_state: 'waiting' } })
    await tasks.move(winId, 'doing')
    const one = await budget.stopItem(cliId)
    expect(one.note).toContain('停了 Codex 在后台做的那一件')
    expect(killed).toEqual([4242])
    const two = await budget.stopItem(winId)
    expect(two.note).toContain('不再等 Kimi 的回答')
    const list = (await tasks.list()).tasks
    // 他停的:记成「停下来的」(不是没做成),界面不染红、收件箱不问「要我自己来吗」。
    expect(list.find(t => t.id === cliId)).toMatchObject({ status: 'todo', dispatch: { status: 'failed', stopped: 'user' } })
    expect(list.find(t => t.id === winId)?.client_dispatch?.reply_state).toBe('unreadable')
  })

  it('什么都没在跑:如实说,409', async () => {
    const { tasks, budget } = await setup()
    const idle = await tasks.create({ title: '一件没开始的', status: 'todo', direction: 'mine', origin: 'user' })
    const result = await budget.stopItem(idle.id as string)
    expect(result).toMatchObject({ ok: false, status: 409 })
  })
})

describe('派给那家命令行的活到时长上限停下来了(统筹拍板 ③):三颗键', () => {
  async function paused() {
    const rig = await setup()
    const one = await rig.tasks.create({ title: '让 Claude 修一下 Echo 的登录', status: 'todo', direction: 'mine', origin: 'user' })
    const cliId = one.id as string
    await rig.tasks.update(cliId, {
      dispatch: { family: 'claude', status: 'failed', stopped: 'cap', hand: 'cli', cwd: '/wt/echo', pid: 5151, started_at: 'x', kind: 'code' },
      budget: { limit_cny: 0.5, limit_minutes: 10, run_minutes: 11, state: 'paused', note: '到时长上限了', cli_family: 'claude', switch_to: 'Codex' },
      note: '到时长上限了',
    })
    await rig.tasks.move(cliId, 'doing')
    await rig.tasks.move(cliId, 'blocked')
    return { ...rig, cliId }
  }

  it('继续 = 同一家、同一个目录再派一次接着做;上限那一格回到「在跑」、记一次加时', async () => {
    const { budget, tasks, cliId, resumed, said } = await paused()
    const done = await budget.choose(cliId, 'continue')
    expect(done.ok).toBe(true)
    expect(done.note).toContain('又派给 Claude 接着做了')
    expect(resumed).toEqual(['claude'])
    expect(said).toEqual([])
    const task = (await tasks.list()).tasks.find(one => one.id === cliId)
    expect(task?.budget).toMatchObject({ state: 'running', extended: 1, cli_family: 'claude' })
    expect(task?.budget?.note).toBeUndefined()
  })

  it('停掉这一件(卡上那颗键 / 外层「停掉这一件」都一样):卡回「待办」,写清改过的东西在哪;不回 409', async () => {
    const { budget, tasks, cliId, killed } = await paused()
    const done = await budget.stopItem(cliId)
    expect(done).toMatchObject({ ok: true })
    expect(killed).toEqual([])
    const task = (await tasks.list()).tasks.find(one => one.id === cliId)
    expect(task?.status).toBe('todo')
    expect(task?.note).toBe('你停掉了这一件:Claude 在后台到时长上限停下的那一次就算完了,改过的东西留在 /wt/echo;要接着做就在卡上再交代一句')
    expect(task?.budget?.state).toBe('stopped')
    expect(task?.dispatch?.stopped).toBe('user')
  })

  it('换一家:不换回它自己(挑手时把这一家排除)', async () => {
    const { budget, cliId, switched, excluded } = await paused()
    const done = await budget.choose(cliId, 'switch')
    expect(done.ok).toBe(true)
    expect(excluded).toEqual(['claude'])
    expect(switched).toEqual(['codex'])
  })
})

/**
 * 「到上限了,先停下来了」那一问跨重启(2026-09-26;交接-0926 第四节第 1 条,跟卡 U8 同一个形状)。
 * `pause()` 把卡上那一格落成 paused 之后,下一拍 tick 不会再问第二遍(对的,防重复);可提问经纪人只在内存里,
 * 重启后那一问就永远不在球下「等你」与手机「等你确认」里了 —— 卡上三颗键还在,但他眼里是「看到的问题凭空消失了」。
 * 账已经在卡上(state / note / paused_at),不另落文件:起服务时照卡把那一问原样挂回,只挂问,不停会话、不写卡。
 * 「重启」在这里就是**在同一份 tasks.json 上重建一个服务**,同热更新那一下。
 */
describe('重启之后「到上限了」那一问还在', () => {
  it('★到上限 → 挂一问 → 重启 → resume:原话、选项、会话原样挂回,at 是第一次停下来的时刻;不重新停会话、不重新写卡;答「继续」照旧生效', async () => {
    const first = recordingAsker()
    const { dir, tasks, id, budget } = await setup({ asker: first.asker })
    await budget.tick()
    expect(first.asked).toHaveLength(1)
    // 第一次问就是「现在」,不带 at
    expect(first.asked[0]?.at).toBeUndefined()
    const before = (await tasks.list()).tasks.find(one => one.id === id)
    expect(before?.budget).toMatchObject({ state: 'paused', paused_at: '2026-09-25T15:00:00.000Z', switch_to: 'Claude' })
    budget.stop()

    // ── 重启:同一份 tasks.json 上重建服务(经纪人空了),第二天早上起来,只叫 resume ──
    const again = recordingAsker()
    const restarted = await setup({ dir, asker: again.asker, now: new Date('2026-09-26T09:00:00.000Z') })
    expect(again.asked).toEqual([])
    expect(await restarted.budget.resume()).toBe(1)
    expect(again.asked).toHaveLength(1)
    expect(again.asked[0]?.sessionId).toBe('s-1')
    // 带上第一次问他的时刻,不是重启的这一刻
    expect(again.asked[0]?.at).toBe('2026-09-25T15:00:00.000Z')
    // 原话与三个选项逐字相同
    expect(again.asked[0]?.questions).toEqual(first.asked[0]?.questions)
    /*
      * 2026-10-04:挂回来那一问与当时那一问**逐字相同**,而且两样都照**卡上那一格**记的
      * (重启后 usage 读不到了):卡在哪(这一件没报 → 那句如实话)+ 已经花了多少钱。
      */
    expect(again.asked[0]?.questions[0]?.question).toBe(budgetAskLine({ title: '修首页球的显示问题', candidateTitle: 'Claude', spentCny: 0.28 }))
    expect(again.asked[0]?.questions[0]?.question).toContain('已经花了 0.28 元')
    expect(again.asked[0]?.questions[0]?.question).toContain(BUDGET_STUCK_UNKNOWN)
    expect(again.asked[0]?.questions[0]?.question).not.toMatch(/分钟|步/)
    // 只挂问:没再停一次会话、卡一个字没动
    expect(restarted.cancels).toEqual([])
    expect((await restarted.tasks.list()).tasks.find(one => one.id === id)).toEqual(before)
    // 只跑一次
    expect(await restarted.budget.resume()).toBe(0)
    expect(again.asked).toHaveLength(1)

    // 他在挂回来的那一问上答「继续」→ 照旧走 choose:上限加一档、叫她接着做
    again.answers[0]?.({ kind: 'answer', answers: [{ id: 'budget', selected: ['继续'] }] })
    const task = await waitFor(async () => (await restarted.tasks.list()).tasks.find(one => one.id === id), one => one?.budget?.state === 'running' && one.status === 'doing')
    await waitFor(async () => restarted.said.length, n => n > 0)
    expect(task?.budget).toMatchObject({ state: 'running', extended: 1, limit_cny: 1, limit_minutes: 20 })
    expect(restarted.said[0]).toContain('上限加了一档(到 1 元 / 20 分钟)')
  })

  it('挂回来的那一问,卡上的键先答了:外层那一问照样撤掉(signal abort)', async () => {
    const first = recordingAsker()
    const { dir, id, budget } = await setup({ asker: first.asker })
    await budget.tick()
    budget.stop()
    const again = recordingAsker()
    const restarted = await setup({ dir, asker: again.asker })
    await restarted.budget.resume()
    expect(again.asked[0]?.signal?.aborted).toBe(false)
    await restarted.budget.choose(id, 'continue')
    expect(again.asked[0]?.signal?.aborted).toBe(true)
  })

  it('他答掉之后重启:不再挂(卡上那一格已经不是 paused)', async () => {
    const first = recordingAsker()
    const { dir, tasks, id, budget } = await setup({ asker: first.asker })
    await budget.tick()
    await budget.choose(id, 'continue')
    expect((await tasks.list()).tasks.find(one => one.id === id)?.budget?.state).toBe('running')
    budget.stop()
    const again = recordingAsker()
    const restarted = await setup({ dir, asker: again.asker })
    expect(await restarted.budget.resume()).toBe(0)
    expect(again.asked).toEqual([])
  })

  it('卡办完 / 取消了不挂;命令行那种到时长上限停的本来就只有卡上三颗键、没问过外层,也不挂', async () => {
    const first = recordingAsker()
    const { dir, tasks, id, budget } = await setup({ asker: first.asker })
    await budget.tick()
    budget.stop()
    // 那张停在上限上的卡他直接取消了
    expect((await tasks.move(id, 'canceled')).ok).toBe(true)
    // 另一张:办完了,上限那一格还是 paused
    const done = await tasks.create({ title: '办完的那件', status: 'todo', direction: 'mine', origin: 'user' })
    await tasks.update(done.id as string, { conversation: { agent: 'dsh', session_id: 's-2' }, budget: { limit_cny: 0.5, limit_minutes: 10, state: 'paused', paused_at: '2026-09-25T15:00:00.000Z', note: '到上限了,先停下来了' } })
    await tasks.move(done.id as string, 'doing')
    await tasks.move(done.id as string, 'done')
    // 再一张:派给 Codex 命令行的到时长上限停下来了(统筹拍板 ③),卡上三颗键在等他
    const cli = await tasks.create({ title: 'Codex 在后台做的那件', status: 'todo', direction: 'mine', origin: 'user' })
    await tasks.update(cli.id as string, { budget: { limit_cny: 0.5, limit_minutes: 10, state: 'paused', paused_at: '2026-09-25T15:00:00.000Z', note: '到时长上限了', cli_family: 'codex' } })
    await tasks.move(cli.id as string, 'blocked')
    const again = recordingAsker()
    const restarted = await setup({ dir, asker: again.asker })
    expect(await restarted.budget.resume()).toBe(0)
    expect(again.asked).toEqual([])
  })
})

/**
 * ★ **2026-10-04,卡「事务官上限只看钱」**(维护者拍板,经工作台捎话「开」)。
 *
 * ## 这一组重放的就是那次事故(10-04 早,事项 `t-63a9291b`)
 *
 * 维护者在手机上让事务官发一份文件。事务官每件事默认一条线 0.5 元 / 10 分钟 / **15 步**,
 * 哪样先到就停下来问「要不要继续」。第一轮它花 14 步去 grep 工作台源码找怎么发文件,
 * 撞 15 步线停了;她点继续 → 30 步,又撞;再点 → 45 步才办完。
 * **钱远没到,是步数线先到的**(事件流 `scratchpad/butler-file-session.jsonl`:
 * seq 92 = turn 1 停在 step 15,seq 170/171 = turn 2 又停在 step 15)。
 * 她看到的就是「中间阻塞了两次」。
 *
 * 维护者 09-23 的尺子:「用户不在乎一通电话花了多少 Tokens,只在乎花了多少钱」。
 * 所以这一版:**去掉步数线,只留钱**(时间保留现状,去掉它只改 `BUDGET_MINUTES_LINE` 一处)。
 */
describe('★ 上限只看钱:那次事故重放(卡「事务官上限只看钱」)', () => {
  const config = { cny: 0.5, minutes: 10 }

  /** 那次事故的用量形状:便宜、又快,**只有步数高** —— 钱与时间都离线很远。 */
  const grinding = (steps: number): DshSessionUsage => usage({
    steps,
    run_ms: 60_000,
    tokenUsage: { cacheReadTokens: 1000, uncachedInputTokens: 100, outputTokens: 100, cacheWriteTokens: 0 },
  })

  it('★15 步、30 步、45 步都不再算「到了」(就是那次事故里停的那三下)', () => {
    for (const steps of [15, 30, 45, 999]) {
      const verdict = budgetVerdict(butlerTask(), config, grinding(steps))
      expect(verdict.over).toBe(false)
      expect(verdict.line).toBeUndefined()
    }
  })

  it('★同样的过程一次都不停(去步数线之前这里会停三次)', async () => {
    const { asker, asked } = recordingAsker()
    const { tasks, id, budget, cancels, setUsage } = await setup({ asker })
    for (const steps of [15, 30, 45]) {
      setUsage(grinding(steps))
      expect(await budget.tick()).toBe(0)
    }
    expect(cancels).toEqual([])
    expect(asked).toEqual([])
    // 一次都没停 → 卡上压根没写过上限那一格,卡照旧在「正在做」。
    const task = (await tasks.list()).tasks.find(one => one.id === id)
    expect(task?.budget).toBeUndefined()
    expect(task?.status).toBe('doing')
  })

  it('★钱到线照旧停,理由是钱,账上记的线是 money', async () => {
    const { budget, cancels, setUsage } = await setup()
    // 便宜模型跑很多步也到不了 0.5 元;真花到钱才停。
    setUsage(usage({ steps: 99, run_ms: 60_000, tokenUsage: { cacheReadTokens: 8_000_000, uncachedInputTokens: 80_000, outputTokens: 40_000, cacheWriteTokens: 0 } }))
    const verdict = budgetVerdict(butlerTask(), config, usage({ tokenUsage: { cacheReadTokens: 8_000_000, uncachedInputTokens: 80_000, outputTokens: 40_000, cacheWriteTokens: 0 } }))
    expect(verdict).toMatchObject({ over: true, line: 'money' })
    expect(verdict.why).toMatch(/^花了约 0\.\d\d 元$/)
    expect(await budget.tick()).toBe(1)
    expect(cancels).toEqual(['s-1'])
  })

  it('时间那条线保留现状(账上那一格记 time)', () => {
    const verdict = budgetVerdict(butlerTask(), config, usage({ run_ms: 11 * 60_000 }))
    expect(verdict).toMatchObject({ over: true, why: '跑了 11 分钟', line: 'time' })
  })

  it('★「继续」里步数那一半拆干净:不加步数、不写 limit_steps、那句话里没有「步」', async () => {
    const { tasks, id, budget, said } = await setup()
    await budget.tick()
    expect((await budget.choose(id, 'continue')).ok).toBe(true)
    const task = (await tasks.list()).tasks.find(one => one.id === id)
    expect(task?.budget).toMatchObject({ state: 'running', extended: 1, limit_cny: 1, limit_minutes: 20 })
    expect(task?.budget?.limit_steps).toBeUndefined()
    expect(said[0]).not.toMatch(/步/)
  })

  it('★老卡上带着 limit_steps:读得懂、不再用,老数据不坏', async () => {
    // 落盘里老的那一格照旧收得下(`tasks.sanitizeBudget`)——
    const old = butlerTask({ budget: { limit_cny: 0.5, limit_minutes: 10, limit_steps: 15, state: 'running' } })
    // —— 但判的时候一个字都不看它,视图里也不再带它出去。
    const verdict = budgetVerdict(old, config, grinding(99))
    expect(verdict.over).toBe(false)
    expect(verdict.view.limit_steps).toBeUndefined()
    expect(spentLine(verdict.view)).not.toMatch(/上限[^)]*步/)
  })

  it('派给那家命令行的活照旧不受这几条线管(花的是那家自己的额度,只管时间)', () => {
    const cli = butlerTask({ budget: { limit_cny: 0.5, limit_minutes: 10, state: 'running', cli_family: 'claude' } })
    expect(budgetVerdict(cli, config, usage({ steps: 99 })).over).toBe(false)
  })
})

/**
 * ★ **撞线之前 / 撞线时说清卡在哪**(2026-10-04 第 2 条)。
 *
 * 维护者:不是光问「要不要继续」,而是一句人话「我在找 X,试了 A、B,还差 C;已经花了 N 元」——
 * 由**事务官**在停下时给出(它最清楚),工作台把它放进那条问话里;它没给就照实说「它没说卡在哪」,不编。
 * **手机 / 电话 / 电脑三处问话都用这一句**(三处读的都是 `OuterAsker` 挂的那一问,正文只在
 * `budgetPolicy.budgetAskLine` 里生成 —— 所以这里钉那一问的正文就够了)。
 */
describe('★ 撞线那一问里要有「卡在哪」(卡「事务官上限只看钱」第 2 条)', () => {
  it('★事务官报过卡在哪 → 那一问里原样带着它与已经花了多少元', async () => {
    const { asker, asked } = recordingAsker()
    const { tasks, id, budget } = await setup({ asker })
    const noted = await budget.stuck(id, '我在找把文件发到手机上的那条路,试了翻源码、读技能,还差一条现成的接口')
    expect(noted.ok).toBe(true)
    expect((await tasks.list()).tasks.find(one => one.id === id)?.budget?.stuck).toContain('我在找把文件发到手机上的那条路')
    await budget.tick()
    const question = asked[0]?.questions[0]?.question as string
    expect(question).toContain('我在找把文件发到手机上的那条路')
    expect(question).toContain('已经花了 0.28 元')
    expect(question).not.toContain(BUDGET_STUCK_UNKNOWN)
  })

  it('★它没报 → 照实说「它没说卡在哪」(不编一个原因)', async () => {
    const { asker, asked } = recordingAsker()
    const { budget } = await setup({ asker })
    await budget.tick()
    expect(asked[0]?.questions[0]?.question).toContain(BUDGET_STUCK_UNKNOWN)
  })

  it('报一句不动卡的状态、不触发判上限(只是把实情先摆好)', async () => {
    const { tasks, id, budget, cancels } = await setup()
    await budget.stuck(id, '卡在登录那一步')
    const task = (await tasks.list()).tasks.find(one => one.id === id)
    expect(task?.status).toBe('doing')
    expect(task?.budget?.state).toBe('running')
    expect(cancels).toEqual([])
  })

  it('空字符串 = 撤掉上一句(它自己说清不卡了)', async () => {
    const { tasks, id, budget } = await setup()
    await budget.stuck(id, '卡在登录那一步')
    await budget.stuck(id, '')
    expect((await tasks.list()).tasks.find(one => one.id === id)?.budget?.stuck).toBeUndefined()
  })

  it('★她点「继续」→ 上一轮的「卡在哪」清掉(不许拿旧话当新话用)', async () => {
    const { tasks, id, budget } = await setup()
    await budget.stuck(id, '上一轮卡在这儿')
    await budget.tick()
    await budget.choose(id, 'continue')
    const after = (await tasks.list()).tasks.find(one => one.id === id)?.budget
    expect(after?.stuck).toBeUndefined()
    expect(after?.stuck_at).toBeUndefined()
  })

  it('没有这件事 / 不是事务官自己在办的 → 如实回不行', async () => {
    const { tasks, budget } = await setup()
    expect((await budget.stuck('t-nope', 'x')).ok).toBe(false)
    const other = await tasks.create({ title: '派给别家的那件', status: 'todo', direction: 'mine', origin: 'user' })
    expect((await budget.stuck(other.id as string, 'x')).ok).toBe(false)
  })
})

/**
 * ★ **把撞线的事记下来**(2026-10-04 第 3 条)。每次撞线一条:哪件事、哪类事、撞的哪条线、
 * 卡在哪那句话 —— 落在**现成的**那本任务账上(`jobLog.ts` 的 `budget_stop`),不另起一个数据库。
 * 「哪类事」由接线那一侧按标题现判(`server/http.ts` 里 `jobKindOf`),所以这里钉的是**报出来的那四样**。
 * **不自动调高线。**
 */
describe('★ 撞线记一条(卡「事务官上限只看钱」第 3 条)', () => {
  it('★撞线那一刻报一条:哪件事、哪条线、为什么、卡在哪', async () => {
    const limits: unknown[] = []
    const { id, budget } = await setup({ onLimit: one => limits.push(one) })
    await budget.stuck(id, '我在找发文件那条路,还差一条接口')
    await budget.tick()
    expect(limits).toEqual([{
      taskId: id,
      title: '修首页球的显示问题',
      line: 'time',
      why: '跑了 11 分钟',
      stuck: '我在找发文件那条路,还差一条接口',
    }])
  })

  it('没报卡在哪 → 那一格缺席(由接线那一侧照实写,不在这里编)', async () => {
    const limits: { stuck?: string }[] = []
    const { budget } = await setup({ onLimit: one => limits.push(one) })
    await budget.tick()
    expect(limits).toHaveLength(1)
    expect(limits[0]?.stuck).toBeUndefined()
  })

  it('★不自动调高线:撞完线之后卡上那一格还是原来的数(她不点继续就不加档)', async () => {
    const { tasks, id, budget } = await setup()
    await budget.tick()
    const after = (await tasks.list()).tasks.find(one => one.id === id)?.budget
    expect(after).toMatchObject({ state: 'paused', limit_cny: 0.5, limit_minutes: 10 })
    expect(after?.extended).toBeUndefined()
  })

  it('记账那一下抛了也不连累停这件事', async () => {
    const { tasks, id, budget, cancels } = await setup({ onLimit: () => { throw new Error('账落不了盘') } })
    expect(await budget.tick()).toBe(1)
    expect(cancels).toEqual(['s-1'])
    expect((await tasks.list()).tasks.find(one => one.id === id)?.budget?.state).toBe('paused')
  })
})
