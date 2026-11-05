// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchEvent } from '../src/protocol.ts'
import type { CodexSessionFeedDeps } from '../src/server/codexSessionFeed.ts'
import { startCodexSessionFeed } from '../src/server/codexSessionFeed.ts'

type Listener = (eventType: string, filename: string | null) => void

function fakeDeps(files: Record<string, string>, index: string) {
  let listener: Listener | undefined
  const closeSpy = vi.fn()
  const readRollout = vi.fn(async (filePath: string) => {
    const content = files[filePath]
    if (content === undefined) throw new Error(`no such file: ${filePath}`)
    return content
  })
  const readSessionIndex = vi.fn(async () => index)

  const deps: CodexSessionFeedDeps = {
    watch: (_dir, l) => {
      listener = l
      return { close: closeSpy }
    },
    readRollout,
    readSessionIndex,
  }

  return {
    deps,
    closeSpy,
    readRollout,
    readSessionIndex,
    emit: (filename: string | null) => listener?.('change', filename),
  }
}

function sessionMeta(source: unknown, id = 'id-1', cwd = '/proj/a'): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: { id, cwd, source },
  })
}

function eventLine(timestamp: string, type: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type, ...payload },
  })
}

const CODEX_HOME = '/home/.codex'
const FILE = `${CODEX_HOME}/sessions/2026/08/20/rollout-x.jsonl`
const STARTED_AT = '2026-08-24T01:02:03.000Z'
const COMPLETE_AT = '2026-08-24T01:03:04.000Z'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startCodexSessionFeed', () => {
  it('writes an interactive lifecycle event as running with the indexed title', async () => {
    const files = { [FILE]: [sessionMeta('cli'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const index = `${JSON.stringify({ id: 'id-1', thread_name: '标题 A' })}\n`
    const { deps, emit } = fakeDeps(files, index)
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent, now: () => 1000 })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)

    expect(applyEvent).toHaveBeenCalledWith({
      agent: 'codex',
      session_id: 'id-1',
      project: '未归类',
      cwd: '/proj/a',
      type: 'running',
      title: '标题 A',
      ts: 1787533323,
    })

    feed.stop()
  })

  it('marks a lifecycle event with no proven project as 未归类', async () => {
    const files = { [FILE]: [sessionMeta('cli'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)

    expect((applyEvent.mock.calls[0]![0] as WorkbenchEvent).project).toBe('未归类')
    feed.stop()
  })

  it('reports task_complete as done immediately without a silence completion', async () => {
    const files = { [FILE]: [sessionMeta('vscode'), eventLine(COMPLETE_AT, 'task_complete')].join('\n') }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent, now: () => 2000 })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)

    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(applyEvent).toHaveBeenLastCalledWith({
      agent: 'codex',
      session_id: 'id-1',
      project: '未归类',
      cwd: '/proj/a',
      type: 'done',
      ts: 1787533384,
    })

    await vi.advanceTimersByTimeAsync(120_000)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    feed.stop()
  })

  it('does not create an event for subagent, guardian, or exec rollouts', async () => {
    const files = {
      [FILE]: [
        sessionMeta({ subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } }),
        eventLine(STARTED_AT, 'task_started'),
      ].join('\n'),
    }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)

    expect(applyEvent).not.toHaveBeenCalled()
    feed.stop()
  })

  it('reports turn_aborted as an interrupted error', async () => {
    const files = { [FILE]: [sessionMeta('appServer'), eventLine(COMPLETE_AT, 'turn_aborted')].join('\n') }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)

    expect(applyEvent).toHaveBeenCalledWith({
      agent: 'codex',
      session_id: 'id-1',
      project: '未归类',
      cwd: '/proj/a',
      type: 'error',
      reason: 'interrupted',
      ts: 1787533384,
    })
    feed.stop()
  })

  it('uses fallback title when the index has a bad line and no matching title', async () => {
    const files = {
      [FILE]: [
        sessionMeta('cli'),
        '{bad-rollout-line',
        eventLine(STARTED_AT, 'user_message', { message: '修复会话来源\n不要猜状态' }),
        eventLine(STARTED_AT, 'task_started'),
      ].join('\n'),
    }
    const { deps, emit } = fakeDeps(files, `{bad-index-line\n${JSON.stringify({ id: 'other', thread_name: '其它' })}`)
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)

    expect(applyEvent).toHaveBeenCalledWith({
      agent: 'codex',
      session_id: 'id-1',
      project: '未归类',
      cwd: '/proj/a',
      type: 'running',
      // 2026-09-25(卡 P):没有线程名时标题 = 第一句要求的前 20 来字(多行合成一句);另带「最近在做什么」。
      title: '修复会话来源，不要猜状态',
      activity: { line: '在想你说的「修复会话来源」', at: STARTED_AT },
      ts: 1787533323,
    })
    feed.stop()
  })

  it('reads a burst of writes once after debounce', async () => {
    const files = { [FILE]: [sessionMeta('cli'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps, emit, readRollout } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent, debounceMs: 200 })
    for (let i = 0; i < 10; i += 1) emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(200)

    expect(readRollout).toHaveBeenCalledTimes(1)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    feed.stop()
  })

  it('does not starve title refresh while a rollout keeps writing', async () => {
    const files = { [FILE]: [sessionMeta('vscode'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent, debounceMs: 200 })
    emit('2026/08/20/rollout-x.jsonl')
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      files[FILE] = [
        sessionMeta('vscode'),
        eventLine(STARTED_AT, 'user_message', { message: '持续写入时也要有标题' }),
        eventLine(STARTED_AT, 'task_started'),
      ].join('\n')
      emit('2026/08/20/rollout-x.jsonl')
    }
    await vi.advanceTimersByTimeAsync(100)

    expect(applyEvent).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'id-1',
      type: 'running',
      title: '持续写入时也要有标题',
    }))
    feed.stop()
  })

  it('does not replay history on startup and stops future callbacks', async () => {
    const files = { [FILE]: [sessionMeta('cli'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps, emit, readRollout, readSessionIndex, closeSpy } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent })
    await vi.advanceTimersByTimeAsync(5000)
    expect(readRollout).not.toHaveBeenCalled()
    expect(readSessionIndex).not.toHaveBeenCalled()
    expect(applyEvent).not.toHaveBeenCalled()

    feed.stop()
    expect(closeSpy).toHaveBeenCalledTimes(1)
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('ignores non-rollout file events and missing files', async () => {
    const { deps, emit, readRollout } = fakeDeps({}, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent })
    emit('2026/08/20')
    emit(null)
    emit('2026/08/20/missing.jsonl')
    await vi.advanceTimersByTimeAsync(500)

    expect(readRollout).toHaveBeenCalledTimes(1)
    expect(applyEvent).not.toHaveBeenCalled()
    feed.stop()
  })

  it('收尾确认重读:一阵写入的最后一笔丢了 fs 事件,也要在 confirmMs 后被补读出来(2026-08-26 真机漏 task_complete 的根因)', async () => {
    // 真机实况:任务收尾的最后一笔写入(task_complete/turn_aborted)常常是这阵写入的
    // 绝笔——它的 fs 事件要么被 FSEvents 合并进了已被去抖丢弃的批次,要么去抖读取
    // 恰好采样在这笔落盘之前。之后再无写入、再无事件,会话就永远卡在 running。
    const files = { [FILE]: [sessionMeta('vscode'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent, debounceMs: 200, confirmMs: 2000 })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(200)
    expect(applyEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'running' }))

    // task_complete 落盘,但**不 emit 任何 fs 事件**——模拟事件丢失。
    files[FILE] = [
      sessionMeta('vscode'),
      eventLine(STARTED_AT, 'task_started'),
      eventLine(COMPLETE_AT, 'task_complete'),
    ].join('\n')
    await vi.advanceTimersByTimeAsync(2000)

    expect(applyEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'done', ts: 1787533384 }))
    feed.stop()
  })

  it('收尾确认读到的内容没变时不重复上报,链条自行终止(不退化成常驻轮询)', async () => {
    const files = { [FILE]: [sessionMeta('vscode'), eventLine(COMPLETE_AT, 'task_complete')].join('\n') }
    const { deps, emit, readRollout } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent, debounceMs: 200, confirmMs: 2000 })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(200)
    expect(applyEvent).toHaveBeenCalledTimes(1)

    // 第一次确认重读:内容没变→不重复上报;之后不得再有任何读取(链条终止)。
    await vi.advanceTimersByTimeAsync(2000)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    const readsAfterConfirm = readRollout.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readRollout).toHaveBeenCalledTimes(readsAfterConfirm)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    feed.stop()
  })

  it('filename=null 的事件不再整个丢弃:已知文件全部安排重读(Node 文档:macOS 递归 watch 可能不给文件名)', async () => {
    const files = { [FILE]: [sessionMeta('vscode'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent, debounceMs: 200, confirmMs: 2000 })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(200)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000) // 收尾确认:没变,链条终止

    // task_complete 落盘;这次 FSEvents 只给了一个没有文件名的事件。
    files[FILE] = [
      sessionMeta('vscode'),
      eventLine(STARTED_AT, 'task_started'),
      eventLine(COMPLETE_AT, 'task_complete'),
    ].join('\n')
    emit(null)
    await vi.advanceTimersByTimeAsync(200)

    expect(applyEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'done' }))
    feed.stop()
  })

  it('请求驱动对账:FSEvents 整段静默时,reconcile() 对"仍在跑"的文件安排重读(2026-08-26 真机:完成落盘后 5 分 39 秒无任何事件)', async () => {
    const files = { [FILE]: [sessionMeta('vscode'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps, emit, readRollout } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, {
      codexHome: CODEX_HOME, applyEvent, debounceMs: 200, confirmMs: 2000, reconcileMinMs: 15_000,
    })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(2200) // 去抖读 + 收尾确认(没变,链终止)
    expect(applyEvent).toHaveBeenCalledTimes(1)

    // task_complete 落盘,FSEvents 彻底静默(不 emit)。过了限频窗口后,
    // 界面轮询 /state → reconcile 被调 → 补读出 done。
    files[FILE] = [
      sessionMeta('vscode'),
      eventLine(STARTED_AT, 'task_started'),
      eventLine(COMPLETE_AT, 'task_complete'),
    ].join('\n')
    await vi.advanceTimersByTimeAsync(15_000)
    feed.reconcile()
    await vi.advanceTimersByTimeAsync(200)
    expect(applyEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'done' }))

    // 已完成(终态)之后 reconcile 不再读这个文件;且 15s 限频内重复调用也不读。
    await vi.advanceTimersByTimeAsync(2000) // 让确认链也走完
    const reads = readRollout.mock.calls.length
    await vi.advanceTimersByTimeAsync(20_000)
    feed.reconcile()
    await vi.advanceTimersByTimeAsync(300)
    expect(readRollout).toHaveBeenCalledTimes(reads)
    feed.stop()
  })

  it('reconcile 限频:最短间隔内的重复调用不产生读取(请求驱动,但界面 1 秒一拍不能变成 1 秒一读)', async () => {
    const files = { [FILE]: [sessionMeta('vscode'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps, emit, readRollout } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, {
      codexHome: CODEX_HOME, applyEvent, debounceMs: 200, confirmMs: 2000, reconcileMinMs: 15_000,
    })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(2200)
    const reads = readRollout.mock.calls.length

    feed.reconcile() // 距上次事件/读取不足 15s → 不读
    await vi.advanceTimersByTimeAsync(300)
    expect(readRollout).toHaveBeenCalledTimes(reads)

    await vi.advanceTimersByTimeAsync(15_000)
    feed.reconcile() // 过了限频窗口,running 文件读一次(内容没变→指纹去重,不重复上报)
    await vi.advanceTimersByTimeAsync(300)
    expect(readRollout).toHaveBeenCalledTimes(reads + 1)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    feed.stop()
  })

  it('keeps a valid lifecycle event when another rollout line is malformed', async () => {
    const files = { [FILE]: [sessionMeta('cli'), '{broken', eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()

    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)

    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect((applyEvent.mock.calls[0]![0] as WorkbenchEvent).type).toBe('running')
    feed.stop()
  })
})

describe('reconcile 的发现与空闲收尾(2026-09-02 Ben 拍板:文件 2 小时没动就当会话已结束)', () => {
  const NEW_FILE = `${CODEX_HOME}/sessions/2026/09/02/rollout-new.jsonl`

  it('running 会话的文件超过空闲阈值没动 → reconcile 补发 offline,且只发一次', async () => {
    const files = { [FILE]: [sessionMeta('cli'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()
    const feed = startCodexSessionFeed({
      ...deps,
      statMtimeMs: async (p: string) => (p === FILE ? 1_000_000 : undefined),
      listRecentRollouts: async () => [],
    }, { codexHome: CODEX_HOME, applyEvent, now: () => 10_000, idleOfflineMs: 7_200_000 })

    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ type: 'running' })

    // now=10_000s → 10,000,000ms;mtime=1,000,000ms → 空闲 9,000,000ms > 阈值 7,200,000ms
    feed.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(applyEvent.mock.calls[1]![0]).toMatchObject({
      agent: 'codex', session_id: 'id-1', type: 'offline',
    })

    // 再对账一次:不重复补发。
    feed.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    feed.stop()
  })

  it('done 会话同样按空闲阈值转 offline(白点「只进不出」的根治)', async () => {
    const files = { [FILE]: [sessionMeta('cli'), eventLine(COMPLETE_AT, 'task_complete')].join('\n') }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()
    const feed = startCodexSessionFeed({
      ...deps,
      statMtimeMs: async () => 1_000_000,
      listRecentRollouts: async () => [],
    }, { codexHome: CODEX_HOME, applyEvent, now: () => 10_000, idleOfflineMs: 7_200_000 })

    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ type: 'done' })

    feed.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(applyEvent.mock.calls[1]![0]).toMatchObject({ type: 'offline' })
    feed.stop()
  })

  it('没有任何 fs 事件时,reconcile 发现新鲜 mtime 的新 rollout 并上报(macOS 目录事件丢文件名的兜底)', async () => {
    const files = { [NEW_FILE]: [sessionMeta('cli', 'id-new'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps } = fakeDeps(files, '')
    const applyEvent = vi.fn()
    // now=10_000s;新文件 mtime=9,990,000ms → 只闲了 10 秒,新鲜。
    const feed = startCodexSessionFeed({
      ...deps,
      statMtimeMs: async () => 9_990_000,
      listRecentRollouts: async () => [NEW_FILE],
    }, { codexHome: CODEX_HOME, applyEvent, now: () => 10_000 })

    feed.reconcile()
    await vi.advanceTimersByTimeAsync(500) // 发现走 scheduleRead,同样吃去抖窗口
    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ session_id: 'id-new', type: 'running' })
    feed.stop()
  })

  it('陈旧 mtime 的未知文件不回放(启动不回放历史的纪律,对发现路径同样成立)', async () => {
    const files = { [NEW_FILE]: [sessionMeta('cli', 'id-old'), eventLine(STARTED_AT, 'task_started')].join('\n') }
    const { deps, readRollout } = fakeDeps(files, '')
    const applyEvent = vi.fn()
    const feed = startCodexSessionFeed({
      ...deps,
      statMtimeMs: async () => 1_000_000, // 闲了 2.5 小时
      listRecentRollouts: async () => [NEW_FILE],
    }, { codexHome: CODEX_HOME, applyEvent, now: () => 10_000 })

    feed.reconcile()
    await vi.advanceTimersByTimeAsync(500)
    expect(readRollout).not.toHaveBeenCalled()
    expect(applyEvent).not.toHaveBeenCalled()
    feed.stop()
  })
})

describe('终态文件被重新写入时也要重读(2026-09-02 真机:重启后 Codex 恢复旧会话并接着跑,标签一直显示旧状态)', () => {
  it('★已报 done 的文件 mtime 前进 → reconcile 重读并报出新的 running', async () => {
    // 真机现场:Mac 重启后 Codex 恢复了 9/01 的四条会话,它们被发现路径按"最后一条
    // 生命周期事件=task_complete"报成 done。之后 Ben 让其中一条跑起来(文件里确实
    // 追加了 task_started),但工作台纹丝不动——因为 reconcile 只重读 type==='running'
    // 的文件,发现路径又跳过已知文件,**唯一通路是 fs 事件,而 macOS 上它不可靠**
    // (0826 已实证静默 5 分 39 秒)。改法:对账时顺带比 mtime,前进了就重读。
    const files = {
      [FILE]: [sessionMeta('cli'), eventLine(STARTED_AT, 'task_started'), eventLine(COMPLETE_AT, 'task_complete')].join('\n'),
    }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()
    let mtime = 9_990_000
    const feed = startCodexSessionFeed({
      ...deps,
      statMtimeMs: async () => mtime,
      listRecentRollouts: async () => [FILE],
    }, { codexHome: CODEX_HOME, applyEvent, now: () => 10_000, reconcileMinMs: 0 })

    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)
    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ type: 'done' })

    // 会话被恢复并接着跑:文件追加 task_started,mtime 前进,但**没有 fs 事件**。
    files[FILE] += `\n${eventLine('2026-08-24T01:10:00.000Z', 'task_started')}`
    mtime = 9_995_000
    feed.reconcile()
    await vi.advanceTimersByTimeAsync(600)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(applyEvent.mock.calls[1]![0]).toMatchObject({ type: 'running' })
    feed.stop()
  })

  it('★已闲成 offline 的文件又被写了 → reconcile 重读,报回 running(10-04 真机:Codex 闲两小时后接着干,气泡和「正在办」一直没它)', async () => {
    const files = {
      [FILE]: [sessionMeta('cli'), eventLine(STARTED_AT, 'task_started')].join('\n'),
    }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()
    let mtime = 1_000_000
    let nowSec = 1_000
    const feed = startCodexSessionFeed({
      ...deps,
      statMtimeMs: async () => mtime,
      listRecentRollouts: async () => [FILE],
    }, { codexHome: CODEX_HOME, applyEvent, now: () => nowSec, reconcileMinMs: 0, idleOfflineMs: 7_200_000 })

    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)
    expect(applyEvent.mock.calls.at(-1)![0]).toMatchObject({ type: 'running' })

    // 两个多小时没动 → offline。
    nowSec = 10_000
    feed.reconcile()
    // 把这次对账顺手排的那次重读、收尾确认都走完:文件没变,它仍是 offline。
    await vi.advanceTimersByTimeAsync(5_000)
    expect(applyEvent.mock.calls.at(-1)![0]).toMatchObject({ type: 'offline' })
    const before = applyEvent.mock.calls.length

    // 她回来接着用:文件追加一轮,mtime 前进,但**没有 fs 事件**。
    files[FILE] += `\n${eventLine('2026-08-24T01:10:00.000Z', 'task_started')}`
    mtime = 9_995_000
    feed.reconcile()
    await vi.advanceTimersByTimeAsync(600)
    expect(applyEvent.mock.calls.length).toBeGreaterThan(before)
    expect(applyEvent.mock.calls.at(-1)![0]).toMatchObject({ type: 'running', session_id: 'id-1' })
    feed.stop()
  })

  it('mtime 没动就不重读(不把对账变成轮询式全量重解析)', async () => {
    const files = {
      [FILE]: [sessionMeta('cli'), eventLine(COMPLETE_AT, 'task_complete')].join('\n'),
    }
    const { deps, emit, readRollout } = fakeDeps(files, '')
    const applyEvent = vi.fn()
    const feed = startCodexSessionFeed({
      ...deps,
      statMtimeMs: async () => 9_990_000,
      listRecentRollouts: async () => [FILE],
    }, { codexHome: CODEX_HOME, applyEvent, now: () => 10_000, reconcileMinMs: 0 })

    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)
    const readsAfterFirst = readRollout.mock.calls.length

    feed.reconcile()
    await vi.advanceTimersByTimeAsync(600)
    expect(readRollout.mock.calls.length).toBe(readsAfterFirst)
    feed.stop()
  })
})

describe('Codex 会话写清是什么(2026-09-25,卡 P)', () => {
  it('新版会话文件(item_completed):第一句要求当标题、最近那句旁白当「在做什么」;读到的文件登记下来', async () => {
    const files = {
      [FILE]: [
        sessionMeta('vscode', '01a0d715'),
        JSON.stringify({ timestamp: STARTED_AT, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/proj/a</cwd>' }] } }),
        eventLine(STARTED_AT, 'task_started'),
        JSON.stringify({ timestamp: STARTED_AT, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '【工作台派活 371c3b】把参赛网页架构剩下的补完' }] } } }),
        JSON.stringify({ timestamp: COMPLETE_AT, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: '我先检查最近提交和未提交改动，再补剩余网页架构。' }], phase: 'commentary' } } }),
      ].join('\n'),
    }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()
    const onFile = vi.fn()
    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent, onFile })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)
    expect(applyEvent).toHaveBeenCalledWith(expect.objectContaining({
      session_id: '01a0d715',
      type: 'running',
      title: '把参赛网页架构剩下的补完',
      activity: { line: '我先检查最近提交和未提交改动，再补剩余网页架构。', at: COMPLETE_AT },
    }))
    expect(onFile).toHaveBeenCalledWith('01a0d715', FILE, undefined)
    feed.stop()
  })

  it('状态没变、它又往前走了一步:「在做什么」变了也报一次', async () => {
    const base = [sessionMeta('vscode'), eventLine(STARTED_AT, 'task_started'), eventLine(STARTED_AT, 'user_message', { message: '跑测试' })]
    const files = { [FILE]: [...base, eventLine(STARTED_AT, 'exec_command_begin', { command: ['bash', '-lc', 'rg foo'] })].join('\n') }
    const { deps, emit } = fakeDeps(files, '')
    const applyEvent = vi.fn()
    const feed = startCodexSessionFeed(deps, { codexHome: CODEX_HOME, applyEvent, confirmMs: 100_000 })
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)
    expect(applyEvent).toHaveBeenLastCalledWith(expect.objectContaining({ activity: { line: '在查找', at: STARTED_AT } }))
    files[FILE] = [...base, eventLine(COMPLETE_AT, 'exec_command_begin', { command: ['bash', '-lc', 'npx vitest run'] })].join('\n')
    emit('2026/08/20/rollout-x.jsonl')
    await vi.advanceTimersByTimeAsync(500)
    expect(applyEvent).toHaveBeenCalledTimes(2)
    expect(applyEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'running', activity: { line: '在跑测试', at: COMPLETE_AT } }))
    feed.stop()
  })
})

/**
 * 两条对话都在跑就数两条(2026-09-27,卡 CX;维护者 13:15:「codex 的运行中的数量也不对,
 * 现在应该是两条」)。真机当时:一条 09-27 开的、一条 09-23 开今天还在写的,
 * 后者的 rollout 落在 4 天前的日期目录里 —— 发现路径只列今天和昨天时它整条缺席。
 */
describe('Codex 会话以文件为准:几条对话就是几条(卡 CX)', () => {
  const TODAY_FILE = `${CODEX_HOME}/sessions/2026/09/27/rollout-today.jsonl`
  const OLD_DAY_FILE = `${CODEX_HOME}/sessions/2026/09/23/rollout-old-day.jsonl`

  function userThread(id: string): string {
    return [
      JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd: '/proj/a', source: 'vscode', thread_source: 'user', parent_thread_id: null },
      }),
      eventLine(STARTED_AT, 'task_started'),
    ].join('\n')
  }

  it('两条 user 线程(一条在老日期目录)都被发现、各上报一条 running', async () => {
    const files = { [TODAY_FILE]: userThread('thread-today'), [OLD_DAY_FILE]: userThread('thread-old-day') }
    const { deps } = fakeDeps(files, '')
    const applyEvent = vi.fn()
    const feed = startCodexSessionFeed({
      ...deps,
      statMtimeMs: async () => 9_990_000, // 都只闲了 10 秒,新鲜
      listRecentRollouts: async () => [TODAY_FILE, OLD_DAY_FILE],
    }, { codexHome: CODEX_HOME, applyEvent, now: () => 10_000 })

    feed.reconcile()
    await vi.advanceTimersByTimeAsync(500)
    const running = applyEvent.mock.calls.map(([event]) => event as WorkbenchEvent).filter(one => one.type === 'running')
    expect(running.map(one => one.session_id).sort()).toEqual(['thread-old-day', 'thread-today'])
    feed.stop()
  })

  it('同一条对话的审查子会话不另算一条(source 是对象、指向父对话)', async () => {
    const child = `${CODEX_HOME}/sessions/2026/09/27/rollout-guardian.jsonl`
    const files = {
      [TODAY_FILE]: userThread('thread-today'),
      [child]: [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'thread-guardian',
            cwd: '/proj/a',
            source: { subagent: { other: 'guardian' } },
            thread_source: 'guardian_review',
            parent_thread_id: 'thread-today',
          },
        }),
        eventLine(STARTED_AT, 'task_started'),
      ].join('\n'),
    }
    const { deps } = fakeDeps(files, '')
    const applyEvent = vi.fn()
    const feed = startCodexSessionFeed({
      ...deps,
      statMtimeMs: async () => 9_990_000,
      listRecentRollouts: async () => [TODAY_FILE, child],
    }, { codexHome: CODEX_HOME, applyEvent, now: () => 10_000 })

    feed.reconcile()
    await vi.advanceTimersByTimeAsync(500)
    expect(applyEvent.mock.calls.map(([event]) => (event as WorkbenchEvent).session_id)).toEqual(['thread-today'])
    feed.stop()
  })
})
