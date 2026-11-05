// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KimiConversation } from '../src/server/kimiConversations.ts'
import type { KimiSessionFeedDeps } from '../src/server/kimiSessionFeed.ts'
import { defaultKimiAgentDir, startKimiSessionFeed } from '../src/server/kimiSessionFeed.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const NOW_SEC = 1_788_325_000 // 2026-09-02T13:36:40+08:00 附近
const FRESH = new Date((NOW_SEC - 600) * 1000).toISOString() // 10 分钟前
const STALE = new Date((NOW_SEC - 10_800) * 1000).toISOString() // 3 小时前

const KEY_A = 'agent:main:main:conversation:6fd4128b-688c-44e9-9194-50a13cc8d783'
const KEY_B = 'agent:main:main:conversation:4ca74f9d-3d49-45cd-a412-db53897fc89b'
const ID_A = '6fd4128b-688c-44e9-9194-50a13cc8d783'
const ID_B = '4ca74f9d-3d49-45cd-a412-db53897fc89b'

function fakeDeps(store: { statuses: Record<string, unknown>, usage: Record<string, unknown> }): KimiSessionFeedDeps {
  return {
    readStatuses: async () => ({ ...store.statuses }),
    readContextUsage: async () => ({ ...store.usage }),
  }
}

/**
 * 2026-09-02 真机纠错:第一版盯 `~/.kimi-code`(CLI),而 Ben 用的是 Kimi 桌面版——
 * 跑了十分钟标签一直空着。桌面版在 kimi-agent/*.json 里给的是**真状态**,
 * 这份测试钉死三态映射、不回放历史、以及空闲收尾。
 */
describe('startKimiSessionFeed(Kimi 桌面版 kimi-agent 状态)', () => {
  it('默认状态目录指向 Kimi 桌面版的 kimi-agent', () => {
    expect(defaultKimiAgentDir('/Users/example'))
      .toBe('/Users/example/Library/Application Support/kimi-desktop/kimi-agent')
  })

  it('★首轮:新鲜的会话一律上报,刚完成的也算(2026-09-02 真机:Ben 的会话 6 分钟前完成,被漏掉了)', async () => {
    // 第一版这里写的是"首次见到只报活跃态",想挡住那几十条历史 completed——**多余且有害**:
    // 历史本来就被新鲜度门挡在外面(它们是 52 小时、13 天前的),这条规则实际挡掉的是
    // "刚刚完成、正等你验收"那一条,恰恰是最该亮蓝点的。新鲜就报,状态是什么报什么。
    const store = {
      statuses: { [KEY_A]: 'running', [KEY_B]: 'completed' },
      usage: { [KEY_A]: { updatedAt: FRESH }, [KEY_B]: { updatedAt: FRESH } },
    }
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed(fakeDeps(store), { applyEvent, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)

    expect(applyEvent).toHaveBeenCalledTimes(2)
    const byId = new Map(applyEvent.mock.calls.map(c => [c[0].session_id, c[0]]))
    expect(byId.get(ID_A)).toMatchObject({ agent: 'kimi', type: 'running', project: '未归类' })
    expect(byId.get(ID_B)).toMatchObject({ agent: 'kimi', type: 'done' })
    feed.stop()
  })

  it('★blocked 而记录里找不到待批的那一条 → 做完未读(蓝点),不是等你确认(2026-09-28 卡 KM);running→completed 的转变照旧报 done', async () => {
    // 真机取证:Kimi 每说完一轮等他下一句就记 `blocked`,所以光有这个字不算「停下来等你确认」。
    const store = {
      statuses: { [KEY_A]: 'blocked' },
      usage: { [KEY_A]: { updatedAt: FRESH } },
    }
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed(fakeDeps(store), { applyEvent, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ type: 'done' })

    // 会话完成:状态与 updatedAt 一起变 → 报 done
    store.statuses[KEY_A] = 'completed'
    store.usage[KEY_A] = { updatedAt: new Date((NOW_SEC - 30) * 1000).toISOString() }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(applyEvent.mock.calls[1]![0]).toMatchObject({ session_id: ID_A, type: 'done' })
    feed.stop()
  })

  it('状态没变就不重复上报', async () => {
    const store = { statuses: { [KEY_A]: 'running' }, usage: { [KEY_A]: { updatedAt: FRESH } } }
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed(fakeDeps(store), { applyEvent, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    feed.stop()
  })

  it('★闲够阈值 → 转 offline 一次(白点有出口);陈旧的历史一开始就不跟踪', async () => {
    const store = { statuses: { [KEY_A]: 'running' }, usage: { [KEY_A]: { updatedAt: FRESH } } }
    const applyEvent = vi.fn()
    let nowSec = NOW_SEC
    const feed = startKimiSessionFeed(fakeDeps(store), {
      applyEvent, now: () => nowSec, idleOfflineMs: 7_200_000,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent).toHaveBeenCalledTimes(1)

    nowSec += 8_000 // updatedAt 已经是 8,600 秒前 > 7,200 秒
    await vi.advanceTimersByTimeAsync(60_000)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(applyEvent.mock.calls[1]![0]).toMatchObject({ session_id: ID_A, type: 'offline' })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(applyEvent).toHaveBeenCalledTimes(2) // 不重复收尾
    feed.stop()
  })

  it('一上来就是陈旧的会话:一条都不报(启动不回放历史)', async () => {
    const store = {
      statuses: { [KEY_A]: 'running', [KEY_B]: 'completed' },
      usage: { [KEY_A]: { updatedAt: STALE }, [KEY_B]: { updatedAt: STALE } },
    }
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed(fakeDeps(store), { applyEvent, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent).not.toHaveBeenCalled()
    feed.stop()
  })

  it('读不到状态文件(没装桌面版)→ 一条都不报,也不抛', async () => {
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed(
      { readStatuses: async () => undefined, readContextUsage: async () => undefined },
      { applyEvent, now: () => NOW_SEC },
    )
    await vi.advanceTimersByTimeAsync(60_000)
    expect(applyEvent).not.toHaveBeenCalled()
    feed.stop()
  })

  it('stop 之后定时器不再跑', async () => {
    const store = { statuses: {} as Record<string, unknown>, usage: {} as Record<string, unknown> }
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed(fakeDeps(store), { applyEvent, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)
    feed.stop()
    store.statuses[KEY_A] = 'running'
    store.usage[KEY_A] = { updatedAt: FRESH }
    await vi.advanceTimersByTimeAsync(180_000)
    expect(applyEvent).not.toHaveBeenCalled()
  })
})

/**
 * 等待原因分类(2026-09-09 傍晚拍板第 4 条):Kimi 桌面版只有一个 `blocked`,
 * 分不出是等审批还是在问你问题——四种原因一种都**不填**(D13:判不出就不填)。
 */
describe('startKimiSessionFeed · wait_reason', () => {
  it('★blocked 没有证据 → done,一样不带 wait_reason(卡 KM 改判;有证据那一路见 kimi-blocked-not-ask.test.ts)', async () => {
    const store = {
      statuses: { [KEY_A]: 'blocked' },
      usage: { [KEY_A]: { updatedAt: FRESH } },
    }
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed(fakeDeps(store), { applyEvent, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)

    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(applyEvent.mock.calls[0]?.[0]).toMatchObject({ agent: 'kimi', type: 'done' })
    expect(applyEvent.mock.calls[0]?.[0]).not.toHaveProperty('wait_reason')
    feed.stop()
  })
})

/**
 * 2026-09-09:标题与归属接上 daimon 的 conversations.sqlite(调研见
 * docs/superpowers/research/2026-09-09-Kimi桌面版标题与归属.md)。这里不碰 SQLite——
 * 读库的形状由 kimi-conversations.test.ts 钉,这份只钉会话流怎么用它:
 * 带上就报、拿不到就退回现状、标题后到补报一次、没事不读库。
 */
describe('startKimiSessionFeed(标题与项目归属,2026-09-09)', () => {
  const ECHO = '/Users/example/Documents/GitHub/Echo/echo'

  function depsWith(store: { statuses: Record<string, unknown>, usage: Record<string, unknown> }, conversations: () => ReadonlyMap<string, KimiConversation> | undefined): KimiSessionFeedDeps {
    return { ...fakeDeps(store), readConversations: conversations }
  }

  it('★有标题有工作区:事件带 title 与 cwd,project 走归属解析', async () => {
    const store = { statuses: { [KEY_A]: 'running' }, usage: { [KEY_A]: { updatedAt: FRESH } } }
    const conversations = new Map<string, KimiConversation>([[KEY_A, { title: 'Aiboo项目梳理与可行性调研', cwd: ECHO }]])
    const applyEvent = vi.fn()
    const resolveProject = vi.fn(async (cwd: string) => cwd === ECHO ? 'Echo' : undefined)
    const feed = startKimiSessionFeed(depsWith(store, () => conversations), { applyEvent, now: () => NOW_SEC, resolveProject })
    await vi.advanceTimersByTimeAsync(0)

    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(applyEvent.mock.calls[0]![0]).toEqual({
      agent: 'kimi', session_id: ID_A, type: 'running', ts: NOW_SEC - 600,
      title: 'Aiboo项目梳理与可行性调研', cwd: ECHO, project: 'Echo',
    })
    feed.stop()
  })

  it('归属解析拿不到/抛错:不填 project(留给 sessions.ts 按 cwd 末段推),cwd 照带', async () => {
    const store = { statuses: { [KEY_A]: 'running', [KEY_B]: 'running' }, usage: { [KEY_A]: { updatedAt: FRESH }, [KEY_B]: { updatedAt: FRESH } } }
    const conversations = new Map<string, KimiConversation>([[KEY_A, { cwd: ECHO }], [KEY_B, { cwd: '/tmp/boom' }]])
    const applyEvent = vi.fn()
    const resolveProject = vi.fn(async (cwd: string) => {
      if (cwd === '/tmp/boom') throw new Error('git 炸了')
      return undefined
    })
    const feed = startKimiSessionFeed(depsWith(store, () => conversations), { applyEvent, now: () => NOW_SEC, resolveProject })
    await vi.advanceTimersByTimeAsync(0)

    expect(applyEvent).toHaveBeenCalledTimes(2)
    const byId = new Map(applyEvent.mock.calls.map(c => [c[0].session_id, c[0]]))
    expect(byId.get(ID_A)).toEqual({ agent: 'kimi', session_id: ID_A, type: 'running', ts: NOW_SEC - 600, cwd: ECHO })
    expect(byId.get(ID_B)).toEqual({ agent: 'kimi', session_id: ID_B, type: 'running', ts: NOW_SEC - 600, cwd: '/tmp/boom' })
    feed.stop()
  })

  it('★库打不开(undefined)/表里没这条:退回现状——短 id、未归类、没有 title/cwd,不抛', async () => {
    const store = { statuses: { [KEY_A]: 'running', [KEY_B]: 'completed' }, usage: { [KEY_A]: { updatedAt: FRESH }, [KEY_B]: { updatedAt: FRESH } } }
    const applyEvent = vi.fn()
    const resolveProject = vi.fn()
    const feedA = startKimiSessionFeed(depsWith(store, () => undefined), { applyEvent, now: () => NOW_SEC, resolveProject })
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    for (const call of applyEvent.mock.calls) {
      expect(call[0]).toMatchObject({ project: '未归类' })
      expect(call[0]).not.toHaveProperty('title')
      expect(call[0]).not.toHaveProperty('cwd')
    }
    expect(resolveProject).not.toHaveBeenCalled()
    feedA.stop()

    applyEvent.mockClear()
    const feedB = startKimiSessionFeed(depsWith(store, () => new Map()), { applyEvent, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ project: '未归类' })
    feedB.stop()
  })

  it('readConversations 抛错也当"这轮没拿到",会话照报', async () => {
    const store = { statuses: { [KEY_A]: 'running' }, usage: { [KEY_A]: { updatedAt: FRESH } } }
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed(depsWith(store, () => { throw new Error('SQLITE_BUSY') }), { applyEvent, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ session_id: ID_A, type: 'running', project: '未归类' })
    feed.stop()
  })

  it('★标题后到(首轮 title_status 还没 generated):状态没变也补报一次带标题的,之后不再重复', async () => {
    const store = { statuses: { [KEY_A]: 'running' }, usage: { [KEY_A]: { updatedAt: FRESH } } }
    const conversations = new Map<string, KimiConversation>([[KEY_A, { cwd: ECHO }]])
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed(depsWith(store, () => conversations), { applyEvent, now: () => NOW_SEC, resolveProject: async () => 'Echo' })
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(applyEvent.mock.calls[0]![0]).not.toHaveProperty('title')

    await vi.advanceTimersByTimeAsync(60_000) // 标题还没好:不重复
    expect(applyEvent).toHaveBeenCalledTimes(1)

    conversations.set(KEY_A, { title: '刚生成的标题', cwd: ECHO })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(applyEvent.mock.calls[1]![0]).toEqual({
      agent: 'kimi', session_id: ID_A, type: 'running', ts: NOW_SEC - 600, title: '刚生成的标题', cwd: ECHO, project: 'Echo',
    })

    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    feed.stop()
  })

  it('★请求驱动:没有要报的会话就不读库;有要报的一轮只读一次', async () => {
    const store = { statuses: { [KEY_A]: 'running', [KEY_B]: 'running' }, usage: { [KEY_A]: { updatedAt: FRESH }, [KEY_B]: { updatedAt: FRESH } } }
    const conversations = new Map<string, KimiConversation>([[KEY_A, { title: 'A', cwd: ECHO }], [KEY_B, { title: 'B', cwd: ECHO }]])
    const readConversations = vi.fn(() => conversations)
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed(depsWith(store, readConversations), { applyEvent, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(readConversations).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readConversations).toHaveBeenCalledTimes(1) // 两轮没变化,一次都没读

    store.usage[KEY_A] = { updatedAt: new Date((NOW_SEC - 30) * 1000).toISOString() }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readConversations).toHaveBeenCalledTimes(2)
    expect(applyEvent).toHaveBeenCalledTimes(3)
    feed.stop()
  })

  it('陈旧收尾(offline)不读库、不带标题,project 留空沿用上次', async () => {
    const store = { statuses: { [KEY_A]: 'running' }, usage: { [KEY_A]: { updatedAt: FRESH } } }
    const readConversations = vi.fn(() => new Map<string, KimiConversation>([[KEY_A, { title: 'A', cwd: ECHO }]]))
    const applyEvent = vi.fn()
    let nowSec = NOW_SEC
    const feed = startKimiSessionFeed(depsWith(store, readConversations), { applyEvent, now: () => nowSec })
    await vi.advanceTimersByTimeAsync(0)
    nowSec += 8_000
    await vi.advanceTimersByTimeAsync(60_000)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(applyEvent.mock.calls[1]![0]).toEqual({ agent: 'kimi', session_id: ID_A, type: 'offline', project: '', ts: nowSec })
    expect(readConversations).toHaveBeenCalledTimes(1)
    feed.stop()
  })

  it('没配 readConversations(旧 deps 形状)行为与从前一模一样', async () => {
    const store = { statuses: { [KEY_A]: 'running' }, usage: { [KEY_A]: { updatedAt: FRESH } } }
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed(fakeDeps(store), { applyEvent, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(applyEvent.mock.calls[0]![0]).toEqual({ agent: 'kimi', session_id: ID_A, type: 'running', ts: NOW_SEC - 600, project: '未归类' })
    feed.stop()
  })
})

describe('Kimi 会话写清在做什么(2026-09-25,卡 P)', () => {
  it('有记录文件就读一眼:事件带「在做什么」,标题没生成好时先用第一句要求;文件登记下来', async () => {
    const store = { statuses: { [KEY_A]: 'running' }, usage: { [KEY_A]: { updatedAt: FRESH } } }
    const conversations = new Map<string, KimiConversation>([[KEY_A, { cwd: '/Users/example/Documents/GitHub/Echo', records: '/k/wire.jsonl' }]])
    const readDigest = vi.fn(async () => ({
      format: 'kimi-wire' as const, title: '先整体读一遍仓库', rounds: [],
      activity: { line: '解析 0.63 测试反馈 PDF', at: FRESH },
    }))
    const onFile = vi.fn()
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed({ ...fakeDeps(store), readConversations: () => conversations, readDigest }, { applyEvent, onFile, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({
      session_id: ID_A, type: 'running', title: '先整体读一遍仓库',
      activity: { line: '解析 0.63 测试反馈 PDF', at: FRESH },
    })
    expect(readDigest).toHaveBeenCalledWith('/k/wire.jsonl', undefined)
    expect(onFile).toHaveBeenCalledWith(ID_A, '/k/wire.jsonl', undefined)
    feed.stop()
  })

  it('读记录文件出错不挡上报(照旧只带状态与标题)', async () => {
    const store = { statuses: { [KEY_A]: 'running' }, usage: { [KEY_A]: { updatedAt: FRESH } } }
    const conversations = new Map<string, KimiConversation>([[KEY_A, { title: 'Kimi 回答一小时分钟数', records: '/k/wire.jsonl' }]])
    const applyEvent = vi.fn()
    const feed = startKimiSessionFeed({ ...fakeDeps(store), readConversations: () => conversations, readDigest: async () => { throw new Error('EACCES') } }, { applyEvent, now: () => NOW_SEC })
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ session_id: ID_A, type: 'running', title: 'Kimi 回答一小时分钟数' })
    expect(applyEvent.mock.calls[0]![0].activity).toBeUndefined()
    feed.stop()
  })
})
