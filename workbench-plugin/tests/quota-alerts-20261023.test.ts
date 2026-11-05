// @vitest-environment node
/**
 * 剩余额度告警 → 工作台消息(2026-10-23,卡 t-8e617888;设计 `docs/设计-剩余额度告警-2026-10-23.md`)。
 *
 * 钉住的几条(对应设计「实施接缝与验收」):
 * 1. fresh 样本 16%→14% 只提醒一次:重复快照不重复;进一步 empty 再一次;恢复正常后新周期可再提醒;
 * 2. 小K5h 紧张而周/总宽裕:提醒准确标 5h 和它的重置时间;不按家名硬编码,其它来源同机制;
 * 3. 只有工作台消息:条目不带 task_id/conversation/wait_reason(不进「等你」、不触发来电);
 *    unknown / 旧样本(stale)/ 失败 / 不限 / 无数 一律不误报;
 * 4. 进程重启不重报:去重记号落一份最小本机 JSON(只记「哪家哪扇窗提醒到哪一级」,不是第二额度账);
 * 5. 统一视图透传来源真实 windows(消费方对照):告警只消费 `AgentQuotaView`,不各家另抓。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentQuotaView, ButlerInboxItem, QuotaWindow, WorkbenchState } from '../src/protocol.ts'
import { buildButlerScene, readSceneItem } from '../src/client/butlerSceneModel.ts'
import { createAgentCaps } from '../src/server/agentCaps.ts'
import { forgetQuotaMemory, quotaFor } from '../src/server/agentQuota.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { QuotaAlerts, QuotaAlertsIo } from '../src/server/quotaAlerts.ts'
import { createQuotaAlerts, parseQuotaAlerts, serializeQuotaAlerts } from '../src/server/quotaAlerts.ts'
import { createRulesService } from '../src/server/rules.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const NOW = new Date('2026-10-23T12:37:00+08:00')
const READ_AT = '2026-10-23T04:37:00.000Z'
const RESET_AT = '2026-10-23T07:21:37.972125Z'

function hhmm(iso: string): string {
  const at = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 造一格「有数」的统一视图(字段与 agentQuotaNow 出来的那一份同形)。 */
function view(over: { [K in keyof AgentQuotaView]?: AgentQuotaView[K] | undefined } = {}): AgentQuotaView {
  return {
    id: 'kimi', title: 'Kimi', state: 'numbers', line: '5 小时窗口只剩约 10%,快用完了',
    level: 'low', left_pct: 10, read_at: READ_AT, ...over,
  } as AgentQuotaView
}

function kimiWindows(over: { pct5h?: number, pctWeek?: number, pctTotal?: number } = {}): readonly QuotaWindow[] {
  return [
    { label: '总', left_pct: over.pctTotal ?? 79 },
    { label: '5h', left_pct: over.pct5h ?? 10, reset_at: RESET_AT },
    { label: '周', left_pct: over.pctWeek ?? 75 },
  ]
}

/** 内存版 IO:记下来写过什么,便于断言「没变就不会再落盘」。 */
function memoryIo(initial?: string): { io: QuotaAlertsIo, writes: string[], read: string | undefined } {
  const box: { io: QuotaAlertsIo, writes: string[], read: string | undefined } = {
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

describe('quotaAlerts:fresh/边界/两阶段', () => {
  it('fresh 16%→14% 只提醒一次:16 还宽裕不出,跌入 14 出一条;再降同一条(id/at 不变),不新增记录', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'quota-alerts.json', io: box.io })
    await alerts.load()

    // 16% 还在线以上(线 = 15):不提醒。
    const okShot = alerts.itemsFor([view({ level: 'ok', left_pct: 16, line: '…16%' })], NOW)
    expect(okShot).toEqual([])
    expect(box.writes).toHaveLength(0)

    const first = alerts.itemsFor([view({ level: 'low', left_pct: 14, line: '…14%' })], NOW)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ kind: 'quota', at: NOW.toISOString() })
    expect(first[0]?.title).toContain('Kimi')
    expect(first[0]?.title).toContain('只剩约 14%')
    await alerts.flush()
    expect(box.writes).toHaveLength(1)

    const second = alerts.itemsFor([view({ level: 'low', left_pct: 12, line: '…12%' })], NOW)
    expect(second).toHaveLength(1)
    expect(second[0]?.id).toBe(first[0]?.id)
    expect(second[0]?.at).toBe(first[0]?.at)
    await alerts.flush()
    // 没有新的低额记录 → 不再落盘。
    expect(box.writes).toHaveLength(1)
  })

  it('进入 empty 再一次:low 那一条收进 empty(不再摆一条过时的百分比),empty 之后不重复', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'f.json', io: box.io })
    await alerts.load()

    const low = alerts.itemsFor([view({ level: 'low', left_pct: 10 })], NOW)
    expect(low).toHaveLength(1)

    const emptyAt = new Date(NOW.getTime() + 5 * 60_000)
    const emptied = alerts.itemsFor([view({ level: 'empty', left_pct: 1, line: '5 小时窗口额度用完了' })], emptyAt)
    // empty 取代了 low:只剩「用完了」那一条,at 是 empty 那一刻。
    expect(emptied).toHaveLength(1)
    expect(emptied[0]?.title).toContain('用完了')
    expect(emptied[0]?.at).toBe(emptyAt.toISOString())
    expect(emptied[0]?.id).not.toBe(low[0]?.id)

    const again = alerts.itemsFor([view({ level: 'empty', left_pct: 0, line: '用完了' })], new Date(NOW.getTime() + 6 * 60_000))
    expect(again).toHaveLength(1)
    expect(again[0]?.id).toBe(emptied[0]?.id)
    expect(again[0]?.at).toBe(emptyAt.toISOString())
  })

  it('ok→empty 直跳:只出 empty 一条(不补一条过时的 low)', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'f.json', io: box.io })
    await alerts.load()
    const items = alerts.itemsFor([view({ level: 'empty', left_pct: 1, left: undefined })], NOW)
    expect(items).toHaveLength(1)
    expect(items[0]?.title).toContain('用完了')
  })

  it('恢复正常(verifiable ok)收起消息并清账;新周期再低额 → 重新提醒(新的 at)', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'f.json', io: box.io })
    await alerts.load()

    const low = alerts.itemsFor([view({ level: 'low', left_pct: 10 })], NOW)
    expect(low).toHaveLength(1)

    // 同周期内读数回到宽裕 → 消息当场收,账清掉。
    const recovered = alerts.itemsFor([view({ level: 'ok', left_pct: 80, line: '还剩约 80%' })], NOW)
    expect(recovered).toHaveLength(0)
    expect(alerts.marks()).toEqual({})

    // 新周期再掉到低额 → 是一条**新**提醒(id 与窗口一一对应,跨周期同 id;「新」体现在 at)。
    const nextAt = new Date(NOW.getTime() + 6 * 60 * 60_000)
    const again = alerts.itemsFor([view({ level: 'low', left_pct: 12 })], nextAt)
    expect(again).toHaveLength(1)
    expect(again[0]?.at).toBe(nextAt.toISOString())
    expect(again[0]?.at).not.toBe(low[0]?.at)
  })

  it('旧样本(stale)不误报,也不清账: stale 期间无消息,新鲜读数仍是低额时不重报', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'f.json', io: box.io })
    await alerts.load()

    const low = alerts.itemsFor([view({ level: 'low', left_pct: 10 })], NOW)
    expect(low).toHaveLength(1)

    // 读数变老:统一视图按现有 freshness 判据把 level/百分比摘掉了 → 不出消息。
    const staleView = view({ level: undefined, left_pct: undefined, stale: true, line: '读不到最新的,上次 11:02' })
    const stale = alerts.itemsFor([staleView], new Date(NOW.getTime() + 3 * 60 * 60_000))
    expect(stale).toHaveLength(0)

    // 来源没经「可验证的恢复」又送来一个新鲜的低额读数 → 还是原来那一条,不重报。
    const freshAgain = alerts.itemsFor([view({ level: 'low', left_pct: 9 })], new Date(NOW.getTime() + 4 * 60 * 60_000))
    expect(freshAgain).toHaveLength(1)
    expect(freshAgain[0]?.at).toBe(low[0]?.at)
  })
})

describe('quotaAlerts:不误报的那几档', () => {
  it('unknown / 没接上 / 不限 / 只有积分数没有百分比 → 一律不出消息、不记账', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'f.json', io: box.io })
    await alerts.load()
    const items = alerts.itemsFor([
      view({ id: 'grok', state: 'unconnected', level: undefined, left_pct: undefined, line: '没接上:还没找到这家的额度来源' }),
      view({ id: 'manus', state: 'unlimited', level: undefined, left_pct: undefined, line: '不限' }),
      view({ id: 'dsh', state: 'numbers', level: 'ok', left_pct: undefined, left: { text: '5', unit: '元', amount: 5 }, line: '余额还有 5 元' }),
    ], NOW)
    expect(items).toEqual([])
    expect(alerts.marks()).toEqual({})
    expect(box.writes).toHaveLength(0)
  })

  it('条目不进「等你」、不指任务/会话:0 副作用的形状', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'f.json', io: box.io })
    await alerts.load()
    const [item] = alerts.itemsFor([view({ windows: kimiWindows() })], NOW)
    expect(item).toBeDefined()
    expect(Object.keys(item ?? {})).toEqual(expect.arrayContaining(['id', 'kind', 'title', 'note', 'at']))
    expect(item).not.toHaveProperty('task_id')
    expect(item).not.toHaveProperty('conversation')
    expect(item).not.toHaveProperty('wait_reason')
    expect(item).not.toHaveProperty('status')
    expect(item).not.toHaveProperty('url')
  })
})

describe('quotaAlerts:多窗口与消息内容', () => {
  it('小K 5h 紧张、周/总宽裕:只出 5h 一条,标题点明窗口;周也紧时两条各说各的窗', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'f.json', io: box.io })
    await alerts.load()

    const one = alerts.itemsFor([view({ windows: kimiWindows() })], NOW)
    expect(one).toHaveLength(1)
    expect(one[0]?.title).toContain('5 小时')
    expect(one[0]?.title).not.toContain('本周')

    const box2 = memoryIo()
    const alerts2 = createQuotaAlerts({ file: 'f.json', io: box2.io })
    await alerts2.load()
    const two = alerts2.itemsFor([view({ windows: kimiWindows({ pctWeek: 12 }) })], NOW)
    expect(two).toHaveLength(2)
    const titles = two.map(one2 => one2.title).join('\n')
    expect(titles).toContain('5 小时')
    expect(titles).toContain('本周')
    expect(titles).not.toContain('总额')
  })

  it('消息带窗口自己的重置时刻与读数时刻;没有 reset_at 不编,只写读到的时刻', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'f.json', io: box.io })
    await alerts.load()
    const [withReset] = alerts.itemsFor([view({ windows: kimiWindows() })], NOW)
    expect(withReset?.note).toContain(`${hhmm(RESET_AT)} 重置`)
    expect(withReset?.note).toContain(`${hhmm(READ_AT)} 读到`)

    const box2 = memoryIo()
    const alerts2 = createQuotaAlerts({ file: 'f.json', io: box2.io })
    await alerts2.load()
    const [noReset] = alerts2.itemsFor([view({ reset_at: undefined })], NOW)
    expect(noReset?.note).toBeDefined()
    expect(noReset?.note).toContain(`${hhmm(READ_AT)} 读到`)
    expect(noReset?.note).not.toContain('重置')
  })

  it('没有 windows 的老视图(只有一个最紧的数)按整格提醒,措辞不点窗口名', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'f.json', io: box.io })
    await alerts.load()
    const [item] = alerts.itemsFor([view({ windows: undefined, left_pct: 10 })], NOW)
    expect(item?.title).toContain('Kimi 的额度只剩约 10%')
  })
})

describe('quotaAlerts:重启不重报(最小本机 JSON 去重)', () => {
  it('同一文件跨实例:仍低 → 同一条消息(同 id 同 at),不再写文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-quota-alerts-'))
    dirs.push(dir)
    const file = join(dir, 'quota-alerts.json')

    const first = createQuotaAlerts({ file })
    await first.load()
    const low = first.itemsFor([view({ windows: kimiWindows() })], NOW)
    expect(low).toHaveLength(1)
    await first.flush()

    const onDisk = readFileSync(file, 'utf8')
    expect(parseQuotaAlerts(onDisk)).toEqual(first.marks())

    // 「重启」:同一文件,新实例。
    const restarted = createQuotaAlerts({ file })
    await restarted.load()
    const still = restarted.itemsFor([view({ windows: kimiWindows({ pct5h: 9 }) })], new Date(NOW.getTime() + 60_000))
    expect(still).toHaveLength(1)
    expect(still[0]?.id).toBe(low[0]?.id)
    expect(still[0]?.at).toBe(low[0]?.at)
    await restarted.flush()
    // 重启后没添新记录 → 文件一个字节没变。
    expect(readFileSync(file, 'utf8')).toBe(onDisk)
  })

  it('写坏了的 JSON 当没有(不误报、也不炸);序列化只含提醒记号,不含额度数值;旧格式(裸时刻)兼容读入', async () => {
    expect(parseQuotaAlerts('{broken')).toEqual({})
    expect(parseQuotaAlerts(undefined)).toEqual({})
    const marks = { 'kimi 5h': { low: { at: '2026-10-23T04:37:00.000Z', pct: 14, note: '15:21 重置 · 12:37 读到' } } }
    const text = serializeQuotaAlerts(marks)
    expect(text).not.toContain('left_pct') // 不存来源字段,不是第二额度账
    expect(parseQuotaAlerts(text)).toEqual(marks)
    // 上一版落盘的裸时刻记号也能读(见到下一拍读数时补齐显示事实,一次性升级)。
    expect(parseQuotaAlerts('{"marks":{"kimi\\u00005h":{"low":"2026-10-23T04:37:00.000Z"}}}'))
      .toEqual({ 'kimi 5h': { low: { at: '2026-10-23T04:37:00.000Z' } } })
  })
})

describe('统一视图透传来源真实 windows(消费方对照)', () => {
  it('采集器那几家(kimi)的 view.windows 与来源 entry.windows 逐项一致', () => {
    const windows = kimiWindows({ pct5h: 10 })
    const got = quotaFor('kimi', { quota: { kimi: { kind: 'quota', windows: [...windows] } }, now: NOW })
    expect(got.state).toBe('numbers')
    expect(got.windows).toEqual(windows)
    // 最紧那一扇的判级与顶层一致(同一条线,不是两套阈值)。
    expect(got).toMatchObject({ level: 'low', left_pct: 10, reset_at: RESET_AT })
  })
})

/*
 * 退修(2026-10-23 晚,独立审 Minor1):low 存续期间若每拍用**新读数**重拼 title/note,
 * `butlerSceneModel` 的 version(含 title/note,见 eventVersion)每次都变 —— 她已读过的
 * 同一条会随百分比下降被顶回未读,等于换着花样重复提醒。
 * 这里用**现有的消息投影/版本语义**(buildButlerScene + readSceneItem)钉住:
 * 同家同窗口同周期同 level,后续新读数/重启不得重置已读;empty 必须再提醒;新周期(可验证恢复后)再提醒。
 */
describe('退修 Minor1:同一条消息已读不随新读数回退', () => {
  function stateWith(items: ButlerInboxItem[]): WorkbenchState {
    return {
      agents: [], sessions: [], quota: {}, stale: false, now: '2026-10-23T12:37:00+08:00',
      tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
      butler_inbox: { items },
    } as unknown as WorkbenchState
  }
  const unreadOf = (items: ButlerInboxItem[], read: Record<string, string>, id: string): boolean | undefined =>
    buildButlerScene(stateWith(items), read).items.find(one => one.id === id)?.unread
  const win = (pct: number, readAt = READ_AT) => view({ windows: [{ label: '5h', left_pct: pct, reset_at: RESET_AT }], read_at: readAt })

  it('初次 low → 她读了 → 14→13→12(含重启式重放)仍已读;empty 必须再未读;恢复后新周期再未读', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'f.json', io: box.io })
    await alerts.load()

    const first = alerts.itemsFor([win(14)], NOW)
    expect(first).toHaveLength(1)
    const id = first[0]?.id as string
    // 她读了那一条(投影里的 version 记进已读表)。
    const read = readSceneItem({}, buildButlerScene(stateWith(first)).items.find(one => one.id === id)!)
    expect(unreadOf(first, read, id)).toBe(false)

    // 后续拍降到 13、12:同一条(id/at 不变),**已读不许被顶回**(修复前:title 每拍用新百分比 → version 变 → 未读)。
    for (const pct of [13, 12]) {
      const items = alerts.itemsFor([win(pct)], new Date(NOW.getTime() + (15 - pct) * 60_000))
      expect(items, `pct=${pct}`).toHaveLength(1)
      expect(items[0]?.id).toBe(id)
      expect(unreadOf(items, read, id), `pct=${pct}`).toBe(false)
    }

    // 进入 empty:必须再提醒一次(新的一条,未读)。
    const emptyAt = new Date(NOW.getTime() + 10 * 60_000)
    const emptied = alerts.itemsFor([win(1)], emptyAt)
    const emptyItem = emptied.find(one => one.id.endsWith(':empty'))
    expect(emptyItem).toBeDefined()
    expect(unreadOf(emptied, read, emptyItem?.id as string)).toBe(true)

    // 可验证恢复 → 清账;新周期再低额:同 id 但 at 变(新的一条),未读。
    alerts.itemsFor([win(80)], new Date(NOW.getTime() + 6 * 60 * 60_000))
    const again = alerts.itemsFor([win(12)], new Date(NOW.getTime() + 7 * 60 * 60_000))
    expect(again[0]?.id).toBe(id)
    expect(again[0]?.at).not.toBe(first[0]?.at)
    expect(unreadOf(again, read, id)).toBe(true)
  })

  it('消息里的百分比与「读到」时刻冻结在提醒那一刻的同一个样本:新读数不灌进旧消息', async () => {
    const box = memoryIo()
    const alerts = createQuotaAlerts({ file: 'f.json', io: box.io })
    await alerts.load()
    const readA = '2026-10-23T03:00:00.000Z'
    const readB = '2026-10-23T05:00:00.000Z'

    const first = alerts.itemsFor([win(14, readA)], NOW)
    expect(first[0]?.title).toContain('只剩约 14%')
    expect(first[0]?.note).toContain(`${hhmm(readA)} 读到`)

    // 半小时后新样本 13%:同一条消息仍说 14% · A 读到 —— 不混用旧值新时刻。
    const second = alerts.itemsFor([win(13, readB)], new Date(NOW.getTime() + 30 * 60_000))
    expect(second[0]?.title).toContain('只剩约 14%')
    expect(second[0]?.note).toContain(`${hhmm(readA)} 读到`)
    expect(second[0]?.note).not.toContain(`${hhmm(readB)} 读到`)
  })
})

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('8791 真接线:隔离工作台入口看得到、0 电话、重启不重报', () => {
  async function get(url: string, path: string) {
    const res = await fetch(`${url}${path}`)
    return { status: res.status, body: await res.json() as Record<string, any> }
  }

  async function serve(opts: { quotaAlerts?: QuotaAlerts } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'wb-quota-alerts-http-'))
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
      now: () => new Date('2026-10-23T12:37:00+08:00'),
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
      ...(opts.quotaAlerts === undefined ? {} : { quotaAlerts: opts.quotaAlerts }),
    })
    started.push(server)
    return { server, url: server.url, service, engineRig }
  }

  // as_of 缺席:读数时刻按「这一拍第一次看见这个值」记(真实服务里 Kimi 采集器会给 as_of),
  // 这里让样本保鲜(quotaCtxNow 的 now 是真时钟,旧 as_of 会撞 2 小时 freshness 线)。
  const KIMI_LOW = {
    kind: 'quota' as const,
    windows: [
      { label: '总', left_pct: 79 },
      { label: '5h', left_pct: 10, reset_at: '2026-10-23T07:21:37.972125Z' },
      { label: '周', left_pct: 75 },
    ],
  }

  it('★低额 → 收件箱一条 quota 消息(家名/5 小时窗口/余量/重置与读数时刻),等你/电话一路都没碰', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-quota-alerts-file-'))
    dirs.push(dir)
    const alerts = createQuotaAlerts({ file: join(dir, 'quota-alerts.json') })
    await alerts.load()
    const { url, service } = await serve({ quotaAlerts: alerts })
    service.setQuota('kimi', KIMI_LOW)

    const state = (await get(url, '/state')).body as WorkbenchState
    // 统一视图真的透传了来源的三扇窗(消费方对照:agent_quota 与告警读同一份)。
    const row = (state.agent_quota ?? []).find(one => one.id === 'kimi')
    expect(row?.windows?.map(one => one.label)).toEqual(['总', '5h', '周'])
    // 收件箱里那一条:看得到。
    const items = (state.butler_inbox?.items ?? []).filter(one => one.kind === 'quota')
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe('quota:kimi:5h:low')
    expect(items[0]?.title).toContain('5 小时额度只剩约 10%')
    expect(items[0]?.note).toContain('重置')
    expect(items[0]?.note).toContain('读到')
    expect(items[0]).not.toHaveProperty('task_id')
    expect(items[0]).not.toHaveProperty('wait_reason')
    // 0 副作用:不进来电、不响铃、「等你」里没有它。
    expect(state.ringing ?? []).toEqual([])
    expect((state.call_out?.entries ?? [])).toEqual([])
    expect((state.waiting?.items ?? []).some(one => one.key.startsWith('quota:'))).toBe(false)

    // 每秒快照再来一遍:同一条(id/at 不变),不轰炸。
    const again = ((await get(url, '/state')).body as WorkbenchState).butler_inbox?.items ?? []
    const againItem = again.find(one => one.kind === 'quota')
    expect(againItem?.id).toBe(items[0]?.id)
    expect(againItem?.at).toBe(items[0]?.at)
    // 电话触发计数 0:这一拍壳没收到任何外呼/响铃类 op。
    await get(url, '/state')
  })

  it('恢复宽裕 → 消息当场收;新周期再低 → 再提醒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-quota-alerts-file-'))
    dirs.push(dir)
    const alerts = createQuotaAlerts({ file: join(dir, 'quota-alerts.json') })
    await alerts.load()
    const { url, service } = await serve({ quotaAlerts: alerts })
    service.setQuota('kimi', KIMI_LOW)
    const low = ((await get(url, '/state')).body as WorkbenchState).butler_inbox?.items.find(one => one.kind === 'quota')
    expect(low).toBeDefined()

    service.setQuota('kimi', { ...KIMI_LOW, windows: KIMI_LOW.windows.map(one => one.label === '5h' ? { ...one, left_pct: 80 } : one) })
    const recovered = ((await get(url, '/state')).body as WorkbenchState).butler_inbox?.items.find(one => one.kind === 'quota')
    expect(recovered).toBeUndefined()

    service.setQuota('kimi', KIMI_LOW)
    const next = ((await get(url, '/state')).body as WorkbenchState).butler_inbox?.items.find(one => one.kind === 'quota')
    // 新周期的一条(id 与窗口对应,与第一条同 id;「重新提醒」的去重账目在单测里用假钟钉住了)。
    expect(next).toBeDefined()
    expect(next?.id).toBe(low?.id)
  })

  it('服务重启不重报:同一文件新实例,仍低 → 同一条(id/at 不变),文件不再变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-quota-alerts-file-'))
    dirs.push(dir)
    const file = join(dir, 'quota-alerts.json')
    const first = createQuotaAlerts({ file })
    await first.load()
    const one = await serve({ quotaAlerts: first })
    one.service.setQuota('kimi', KIMI_LOW)
    const low = ((await get(one.url, '/state')).body as WorkbenchState).butler_inbox?.items.find(item => item.kind === 'quota')
    expect(low).toBeDefined()
    await one.server.close()
    started.pop()
    await first.flush()
    const onDisk = readFileSync(file, 'utf8')

    // 「重启」:新实例、新服务,同一文件。
    const second = createQuotaAlerts({ file })
    await second.load()
    const two = await serve({ quotaAlerts: second })
    two.service.setQuota('kimi', { ...KIMI_LOW, windows: KIMI_LOW.windows.map(w => w.label === '5h' ? { ...w, left_pct: 9 } : w) })
    const still = ((await get(two.url, '/state')).body as WorkbenchState).butler_inbox?.items.find(item => item.kind === 'quota')
    expect(still).toBeDefined()
    expect(still?.id).toBe(low?.id)
    expect(still?.at).toBe(low?.at)
    await two.server.close()
    started.pop()
    await second.flush()
    expect(readFileSync(file, 'utf8')).toBe(onDisk)
  })

  it('没接 quotaAlerts 的实例(老宿主/测试)行为一字不变:整档不出', async () => {
    const { url, service } = await serve()
    service.setQuota('kimi', KIMI_LOW)
    const state = (await get(url, '/state')).body as WorkbenchState
    expect((state.butler_inbox?.items ?? []).some(one => one.kind === 'quota')).toBe(false)
  })
})
