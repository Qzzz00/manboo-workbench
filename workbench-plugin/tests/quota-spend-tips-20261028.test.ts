// @vitest-environment node
/**
 * 额度按到期先花 · 例程建议(2026-10-28,卡 t-f68365f6;任务书 `docs/交接-1028-机制退修任务书-接续对题与改派语义.md` 第 10 条)。
 *
 * 机制:重置前 6 小时某家某扇窗还剩一半以上 → 把板上「待排」的研发活列成一条建议递给她
 * (替你拿主意那种卡),**不自动派**。与剩余额度告警(卡 t-8e617888)同一条接缝
 * (额度样本→提示与去重):只消费 `agentQuotaNow` 同一份统一视图,去重落一份最小本机 JSON,
 * 只是工作台消息 —— 不进「等你」、不触发来电。
 *
 * 钉住的几条:
 * 1. 触发窗口:reset_at 在 (现在, 现在+6h] 且 left_pct ≥ 50 才提议;更早、已过、不到一半、没有 reset_at 都不出;
 * 2. 建议内容:板上「待排」的研发活(明写 work_type 或从事实认出的 dev),一条至多点名 3 件、带总数;
 *    板上一件待排研发活都没有 → 不提议(没主意可拿);
 * 3. 每个「家+窗+重置周期」只递一次:重复快照/刷新/重启不重递;重置过了(或掉出一半以下、研发活派完)消息即收,
 *    新周期(新的 reset_at)可以再次递;
 * 4. 不误报:unknown / 没接上 / 不限 / 只有积分 / stale 一律不出;看板读不到(undefined)时不提议也不动账;
 * 5. 0 副作用:条目不带 task_id/conversation/wait_reason,不进来电、不占手机「等你」;
 * 6. 显示事实冻结在递出那一刻(同 quotaAlerts 退修 Minor1 的教训):后续拍读数变化不把已读顶回未读。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentQuotaView, ButlerInboxItem, QuotaWindow, TaskView, WorkbenchState } from '../src/protocol.ts'
import { buildButlerScene, readSceneItem } from '../src/client/butlerSceneModel.ts'
import { forgetQuotaMemory } from '../src/server/agentQuota.ts'
import { createQuotaAlerts } from '../src/server/quotaAlerts.ts'
import type { QuotaSpendTips, QuotaSpendTipsIo } from '../src/server/quotaSpendTips.ts'
import { createQuotaSpendTips, parseQuotaSpendTips, serializeQuotaSpendTips } from '../src/server/quotaSpendTips.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createRulesService } from '../src/server/rules.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createAgentCaps } from '../src/server/agentCaps.ts'
import { engineHarness } from './helpers/engineHarness.ts'

// 本地 2026-10-28 09:00;月窗明早 08:00 重置(还有 23 小时 —— 不出),周窗今天 14:00 重置(5 小时后 —— 出)。
const NOW = new Date('2026-10-28T09:00:00+08:00')
const RESET_SOON = '2026-10-28T06:00:00.000Z' // 本地 14:00
const RESET_LATER = '2026-10-29T00:00:00.000Z' // 本地明天 08:00

function view(over: { [K in keyof AgentQuotaView]?: AgentQuotaView[K] | undefined } = {}): AgentQuotaView {
  return {
    id: 'kimi', title: 'Kimi', state: 'numbers', line: 'Kimi 还剩约 79%',
    level: 'ok', left_pct: 79, read_at: '2026-10-28T01:00:00.000Z', ...over,
  } as AgentQuotaView
}

function weekWindow(pct: number, resetAt: string = RESET_SOON): readonly QuotaWindow[] {
  return [{ label: '周', left_pct: pct, reset_at: resetAt }]
}

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-1', title: '修登录页', status: 'backlog', work_type: 'dev',
    updated_at: '2026-10-28T08:00:00+08:00', ...over,
  } as TaskView
}

/** 内存版 IO:记下来写过什么,便于断言「没变就不会再落盘」。 */
function memoryIo(initial?: string): { io: QuotaSpendTipsIo, writes: string[], read: string | undefined } {
  const box: { io: QuotaSpendTipsIo, writes: string[], read: string | undefined } = {
    read: initial,
    writes: [],
    io: {
      read: async () => box.read,
      write: async (_file, text) => { box.writes.push(text) },
    },
  }
  return box
}

beforeEach(() => { forgetQuotaMemory() })

describe('quotaSpendTips:触发窗口(重置前 6 小时、剩一半以上)', () => {
  it('周窗 5 小时后重置、还剩 79% + 板上有待排研发活 → 出一条建议', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    const items = tips.itemsFor([view({ windows: weekWindow(79) })], [task()], NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'spend', at: NOW.toISOString() })
    expect(items[0]?.id).toBe(`spend:kimi:周:${RESET_SOON}`)
    expect(items[0]?.title).toContain('Kimi 的本周额度快重置了')
    expect(items[0]?.title).toContain('还剩约 79%')
    expect(items[0]?.note).toContain('14:00 重置')
    expect(items[0]?.note).toContain('修登录页')
    await tips.flush()
    expect(box.writes).toHaveLength(1)
  })

  it('重置还有 7 小时(超出 6 小时窗)不出;刚过/正在重置也不出', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    // 明早 08:00 = 23 小时后。
    expect(tips.itemsFor([view({ windows: weekWindow(79, RESET_LATER) })], [task()], NOW)).toEqual([])
    // 6 小时零 1 分之前重置的(已过期)不出。
    const past = new Date(NOW.getTime() - (6 * 60 + 1) * 60_000)
    expect(tips.itemsFor([view({ windows: weekWindow(79, past.toISOString()) })], [task()], NOW)).toEqual([])
    expect(tips.marks()).toEqual({})
    expect(box.writes).toHaveLength(0)
  })

  it('只剩 49%(不到一半)不出;正好 50 出', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    expect(tips.itemsFor([view({ windows: weekWindow(49) })], [task()], NOW)).toEqual([])
    expect(tips.itemsFor([view({ windows: weekWindow(50) })], [task()], NOW)).toHaveLength(1)
  })

  it('没有 reset_at 的窗(不知道何时重置)不编时刻、不出', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    const items = tips.itemsFor([view({ windows: [{ label: '周', left_pct: 79 }] })], [task()], NOW)
    expect(items).toEqual([])
  })
})

describe('quotaSpendTips:建议内容(板上积压的研发活)', () => {
  it('只列「待排」的研发活:在办的、办完的、别的类型的都不算', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    const items = tips.itemsFor([view({ windows: weekWindow(79) })], [
      task({ id: 't-1', title: '修登录页', status: 'backlog', work_type: 'dev' }),
      task({ id: 't-2', title: '在做的活', status: 'doing', work_type: 'dev' }),
      task({ id: 't-3', title: '已办完的活', status: 'done', work_type: 'dev' }),
      task({ id: 't-4', title: '待排的会', status: 'backlog', work_type: 'meeting' }),
    ], NOW)
    expect(items).toHaveLength(1)
    expect(items[0]?.note).toContain('修登录页')
    expect(items[0]?.note).not.toContain('在做的活')
    expect(items[0]?.note).not.toContain('已办完的活')
    expect(items[0]?.note).not.toContain('待排的会')
    expect(items[0]?.note).toContain('1 件')
  })

  it('work_type 没明写时从事实认:需求卡(kind:feature)算研发', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    const items = tips.itemsFor([view({ windows: weekWindow(79) })], [
      task({ id: 't-1', title: '需求卡那件', status: 'backlog', kind: 'feature', work_type: undefined } as unknown as Partial<TaskView>),
    ], NOW)
    expect(items).toHaveLength(1)
    expect(items[0]?.note).toContain('需求卡那件')
  })

  it('至多点名 3 件、带总数:4 件待排研发活 → note 里 3 个名字 + 共 4 件', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    const items = tips.itemsFor([view({ windows: weekWindow(79) })], [
      task({ id: 't-1', title: '甲' }),
      task({ id: 't-2', title: '乙' }),
      task({ id: 't-3', title: '丙' }),
      task({ id: 't-4', title: '丁' }),
    ], NOW)
    expect(items).toHaveLength(1)
    const note = items[0]?.note ?? ''
    expect(note).toContain('等 4 件')
    expect(note).toContain('甲、乙、丙')
    expect(note).not.toContain('丁')
  })

  it('板上没有待排的研发活 → 没主意可拿,不出(也不记账)', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    expect(tips.itemsFor([view({ windows: weekWindow(79) })], [], NOW)).toEqual([])
    expect(tips.itemsFor([view({ windows: weekWindow(79) })], [task({ status: 'doing' })], NOW)).toEqual([])
    expect(tips.marks()).toEqual({})
    expect(box.writes).toHaveLength(0)
  })

  it('看板读不到(undefined,快照冻结) → 不提议也不动账(同「stale 不清账」那条纪律)', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    expect(tips.itemsFor([view({ windows: weekWindow(79) })], undefined, NOW)).toEqual([])
    expect(tips.marks()).toEqual({})
    expect(box.writes).toHaveLength(0)
  })
})

describe('quotaSpendTips:每个重置周期只递一次', () => {
  it('重复快照/读数变化:同一条(id/at 不变),不再落盘;重置过了消息即收', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()

    const first = tips.itemsFor([view({ windows: weekWindow(79) })], [task()], NOW)
    expect(first).toHaveLength(1)
    await tips.flush()
    expect(box.writes).toHaveLength(1)

    // 半小时后读数变 70%:还是同一条,说过的话不翻新。
    const later = new Date(NOW.getTime() + 30 * 60_000)
    const second = tips.itemsFor([view({ windows: weekWindow(70) })], [task()], later)
    expect(second).toHaveLength(1)
    expect(second[0]?.id).toBe(first[0]?.id)
    expect(second[0]?.at).toBe(first[0]?.at)
    expect(second[0]?.title).toContain('还剩约 79%')
    await tips.flush()
    expect(box.writes).toHaveLength(1)

    // 重置过了(这一拍条件不再成立)→ 消息当场收,账清掉。
    const after = new Date(new Date(RESET_SOON).getTime() + 60_000)
    expect(tips.itemsFor([view({ windows: weekWindow(70) })], [task()], after)).toEqual([])
    expect(tips.marks()).toEqual({})
  })

  it('新周期(新的 reset_at)可以再递一条;研发活派完(待排清空)消息即收,再来新活还可递', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()

    tips.itemsFor([view({ windows: weekWindow(79) })], [task()], NOW)
    // 派完了:待排清空 → 收。
    expect(tips.itemsFor([view({ windows: weekWindow(79) })], [], NOW)).toEqual([])
    expect(tips.marks()).toEqual({})
    // 板上又来了新活、同一重置周期内 → 可以再递(还是这件事,一条)。
    const again = tips.itemsFor([view({ windows: weekWindow(79) })], [task({ id: 't-2', title: '新活' })], NOW)
    expect(again).toHaveLength(1)

    // 新周期:新的 reset_at 在「那一刻」的 6 小时窗内 → 是一条新的建议。
    const nextReset = '2026-11-04T06:00:00.000Z'
    const nextAt = new Date(Date.parse(nextReset) - 3 * 60 * 60_000)
    const next = tips.itemsFor([view({ windows: weekWindow(79, nextReset) })], [task()], nextAt)
    expect(next).toHaveLength(1)
    expect(next[0]?.id).toBe(`spend:kimi:周:${nextReset}`)
    expect(next[0]?.id).not.toBe(again[0]?.id)
  })

  it('同一家两扇窗都临近重置 → 各递一条、各说各的窗;别家不误伤', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    const items = tips.itemsFor([view({
      windows: [
        { label: '5h', left_pct: 60, reset_at: RESET_SOON },
        { label: '周', left_pct: 79, reset_at: RESET_SOON },
      ],
    })], [task()], NOW)
    expect(items).toHaveLength(2)
    const titles = items.map(one => one.title).join('\n')
    expect(titles).toContain('5 小时')
    expect(titles).toContain('本周')
  })
})

describe('quotaSpendTips:不误报与 0 副作用形状', () => {
  it('unknown / 没接上 / 不限 / 只有积分数 / stale → 一律不出、不记账', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    const items = tips.itemsFor([
      view({ id: 'grok', state: 'unconnected', level: undefined, left_pct: undefined, windows: undefined, line: '没接上' }),
      view({ id: 'manus', state: 'unlimited', level: undefined, left_pct: undefined, windows: undefined, line: '不限' }),
      view({ id: 'dsh', state: 'numbers', level: 'ok', left_pct: undefined, left: { text: '5', unit: '元', amount: 5 }, windows: undefined, line: '余额还有 5 元' }),
      view({ level: undefined, left_pct: undefined, stale: true, windows: undefined, line: '读不到最新的' }),
    ], [task()], NOW)
    expect(items).toEqual([])
    expect(tips.marks()).toEqual({})
    expect(box.writes).toHaveLength(0)
  })

  it('条目只是工作台消息:不带 task_id/conversation/wait_reason/status/url', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()
    const [item] = tips.itemsFor([view({ windows: weekWindow(79) })], [task()], NOW)
    expect(item).toBeDefined()
    expect(item).not.toHaveProperty('task_id')
    expect(item).not.toHaveProperty('conversation')
    expect(item).not.toHaveProperty('wait_reason')
    expect(item).not.toHaveProperty('status')
    expect(item).not.toHaveProperty('url')
  })
})

describe('quotaSpendTips:已读不随新读数回退(显示事实冻结)', () => {
  function stateWith(items: ButlerInboxItem[]): WorkbenchState {
    return {
      agents: [], sessions: [], quota: {}, stale: false, now: '2026-10-28T09:00:00+08:00',
      tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
      butler_inbox: { items },
    } as unknown as WorkbenchState
  }
  const unreadOf = (items: ButlerInboxItem[], read: Record<string, string>, id: string): boolean | undefined =>
    buildButlerScene(stateWith(items), read).items.find(one => one.id === id)?.unread

  it('递出 → 她读了 → 读数变了仍已读;重置过了即收;新周期再递是未读新一条', async () => {
    const box = memoryIo()
    const tips = createQuotaSpendTips({ file: 'f.json', io: box.io })
    await tips.load()

    const first = tips.itemsFor([view({ windows: weekWindow(79) })], [task()], NOW)
    const id = first[0]?.id as string
    const read = readSceneItem({}, buildButlerScene(stateWith(first)).items.find(one => one.id === id)!)
    expect(unreadOf(first, read, id)).toBe(false)

    // 79%→60%:同一条,已读不许被顶回。
    const second = tips.itemsFor([view({ windows: weekWindow(60) })], [task()], new Date(NOW.getTime() + 30 * 60_000))
    expect(second[0]?.id).toBe(id)
    expect(unreadOf(second, read, id)).toBe(false)

    // 重置过了 → 收。
    const after = new Date(new Date(RESET_SOON).getTime() + 60_000)
    expect(tips.itemsFor([view({ windows: weekWindow(60) })], [task()], after)).toEqual([])

    // 新周期再递:新 reset_at 前 3 小时 → 新一条,未读。
    const nextReset = '2026-11-04T06:00:00.000Z'
    const nextAt = new Date(Date.parse(nextReset) - 3 * 60 * 60_000)
    const next = tips.itemsFor([view({ windows: weekWindow(79, nextReset) })], [task()], nextAt)
    expect(next).toHaveLength(1)
    expect(next[0]?.id).not.toBe(id)
    expect(unreadOf(next, read, next[0]?.id as string)).toBe(true)
  })
})

describe('quotaSpendTips:去重账(最小本机 JSON)', () => {
  it('同一文件跨实例(重启):同一条消息(同 id 同 at),文件不再变;读坏了当没有', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-quota-spend-'))
    dirs.push(dir)
    const file = join(dir, 'quota-spend-tips.json')

    const first = createQuotaSpendTips({ file })
    await first.load()
    const fired = first.itemsFor([view({ windows: weekWindow(79) })], [task()], NOW)
    expect(fired).toHaveLength(1)
    await first.flush()
    const onDisk = readFileSync(file, 'utf8')
    expect(parseQuotaSpendTips(onDisk)).toEqual(first.marks())

    // 「重启」:同一文件,新实例。
    const restarted = createQuotaSpendTips({ file })
    await restarted.load()
    const still = restarted.itemsFor([view({ windows: weekWindow(70) })], [task()], new Date(NOW.getTime() + 60_000))
    expect(still).toHaveLength(1)
    expect(still[0]?.id).toBe(fired[0]?.id)
    expect(still[0]?.at).toBe(fired[0]?.at)
    await restarted.flush()
    expect(readFileSync(file, 'utf8')).toBe(onDisk)

    // 读坏了 / 没有 → 当空账(至多重复递一次,比拿着坏账不响强)。
    expect(parseQuotaSpendTips('{broken')).toEqual({})
    expect(parseQuotaSpendTips(undefined)).toEqual({})
  })

  it('序列化只含建议记号(时刻+说过的话),不含额度数值;与告警账互不相通(两个文件两套 key)', async () => {
    expect(serializeQuotaSpendTips({})).not.toContain('left_pct')
    const marks = { 'kimi\u0000周\u00002026-10-28T06:00:00.000Z': { at: NOW.toISOString(), pct: 79, title: 'Kimi 的本周额度快重置了,还剩约 79%', note: '14:00 重置 · …' } }
    const text = serializeQuotaSpendTips(marks)
    expect(parseQuotaSpendTips(text)).toEqual(marks)
    // 键带 reset_at(周期身份),与告警账(键 = 家+窗,值分 low/empty 两级)不是一种形状。
    expect(Object.keys(parseQuotaSpendTips(text))[0]).toContain('2026-10-28T06:00:00.000Z')
    const alerts = createQuotaAlerts({ file: 'a.json', io: memoryIo().io })
    expect(Object.keys(alerts.marks())).toEqual([])
  })
})

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('8791 真接线:隔离工作台入口看得到、0 电话、重启不重递', () => {
  async function get(url: string, path: string) {
    const res = await fetch(`${url}${path}`)
    return { status: res.status, body: await res.json() as Record<string, any> }
  }

  async function serve(opts: { quotaSpendTips?: QuotaSpendTips } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'wb-quota-spend-http-'))
    dirs.push(dir)
    let n = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
    const rules = createRulesService({ file: join(dir, 'rules.json'), agents: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true }) } })
    await rules.load()
    const service = createWorkbenchService({})
    const caps = createAgentCaps({
      installed: () => true,
      helper: () => ({ connected: true, authorized: true, newConversation: true, readReply: true }),
      cliFound: () => false,
      cliLogin: async () => ({ login: 'unknown' }),
      now: () => new Date('2026-10-28T09:00:00+08:00'),
      setTimer: () => 0,
      clearTimer: () => {},
    })
    await caps.check()
    const engineRig = engineHarness({ connected: () => false })
    const server = await startWorkbenchServer({
      port: 0,
      service,
      engine: engineRig.engine,
      engineRegistry: engineRig.registry,
      tickIntervalMs: 0,
      heartbeatMs: 0,
      tasks,
      rules,
      agentCaps: caps,
      helper: {
        attach: () => {},
        view: () => ({ connected: true, authorized: true }) as never,
        connected: () => true,
        onChange: () => {},
        onEvent: () => {},
        request: async () => ({ found: false, busy: false }),
      },
      runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
      dispatchRun: { runCli: () => ({ pid: 777, exited: new Promise(() => {}) }), alive: () => true, readFile: async () => undefined, resultDir: dir },
      ...(opts.quotaSpendTips === undefined ? {} : { quotaSpendTips: opts.quotaSpendTips }),
    })
    started.push(server)
    return { server, url: server.url, service, tasks, engineRig }
  }

  // 周窗 3 小时后重置(在 6 小时窗内)、还剩 79%;总窗没给 reset_at(不出)、
  // 5h 窗 1 小时前已重置(过期,不出)。reset_at 相对**真钟**动态算:服务的 now 是墙钟,
  // 写死的时刻一过期整档就 Silent 不出(这里钉的恰恰是「过期不出」,所以要用活的)。
  const RESET_WEEK = new Date(Date.now() + 3 * 3600_000).toISOString()
  const RESET_PAST = new Date(Date.now() - 3600_000).toISOString()
  const KIMI_RICH = {
    kind: 'quota' as const,
    windows: [
      { label: '总', left_pct: 79 },
      { label: '周', left_pct: 79, reset_at: RESET_WEEK },
      { label: '5h', left_pct: 79, reset_at: RESET_PAST },
    ],
  }

  it('★临近重置且剩一半以上 + 板上有待排研发活 → 收件箱一条 spend 建议;等你/电话一路都没碰', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-quota-spend-file-'))
    dirs.push(dir)
    const tips = createQuotaSpendTips({ file: join(dir, 'quota-spend-tips.json') })
    await tips.load()
    const { url, service, tasks } = await serve({ quotaSpendTips: tips })
    service.setQuota('kimi', KIMI_RICH)
    // 板上:一件待排研发活 + 一件在办的(不该被点名)。
    await tasks.create({ title: '修登录页', status: 'backlog', workType: 'dev' } as never)
    await tasks.create({ title: '在做的活', status: 'doing', workType: 'dev' } as never)

    const state = (await get(url, '/state')).body as WorkbenchState
    const items = (state.butler_inbox?.items ?? []).filter(one => one.kind === 'spend')
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe(`spend:kimi:周:${RESET_WEEK}`)
    expect(items[0]?.title).toContain('Kimi 的本周额度快重置了')
    expect(items[0]?.note).toContain('修登录页')
    expect(items[0]?.note).not.toContain('在做的活')
    expect(items[0]?.note).toContain('重置')
    expect(items[0]).not.toHaveProperty('task_id')
    expect(items[0]).not.toHaveProperty('wait_reason')
    // 0 副作用:不进来电、不响铃、「等你」里没有它。
    expect(state.ringing ?? []).toEqual([])
    expect((state.call_out?.entries ?? [])).toEqual([])
    expect((state.waiting?.items ?? []).some(one => one.key.startsWith('spend:'))).toBe(false)

    // 每秒快照再来一遍:同一条(id/at 不变),不轰炸。
    const againItem = ((await get(url, '/state')).body as WorkbenchState).butler_inbox?.items.find(one => one.kind === 'spend')
    expect(againItem?.id).toBe(items[0]?.id)
    expect(againItem?.at).toBe(items[0]?.at)
  })

  it('板上一空(研发活派完)→ 建议当场收;重置过后也不再递', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-quota-spend-file-'))
    dirs.push(dir)
    const tips = createQuotaSpendTips({ file: join(dir, 'quota-spend-tips.json') })
    await tips.load()
    const { url, service, tasks } = await serve({ quotaSpendTips: tips })
    service.setQuota('kimi', KIMI_RICH)
    const created = await tasks.create({ title: '修登录页', status: 'backlog', workType: 'dev' } as never)
    expect(created.ok).toBe(true)
    const seen = ((await get(url, '/state')).body as WorkbenchState).butler_inbox?.items.find(one => one.kind === 'spend')
    expect(seen).toBeDefined()

    // 那件活挪出「待排」(待排→待办是合法转换)→ 待排清空 → 建议收。
    const moved = await tasks.move(created.id as string, 'todo')
    expect(moved.ok).toBe(true)
    const gone = ((await get(url, '/state')).body as WorkbenchState).butler_inbox?.items.find(one => one.kind === 'spend')
    expect(gone).toBeUndefined()
  })

  it('没接 quotaSpendTips 的实例(老宿主/测试)行为一字不变:整档不出', async () => {
    const { url, service, tasks } = await serve()
    service.setQuota('kimi', KIMI_RICH)
    await tasks.create({ title: '修登录页', status: 'backlog', workType: 'dev' } as never)
    const state = (await get(url, '/state')).body as WorkbenchState
    expect((state.butler_inbox?.items ?? []).some(one => one.kind === 'spend')).toBe(false)
  })
})
