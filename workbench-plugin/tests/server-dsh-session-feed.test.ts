// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SessionMetrics, WorkbenchEvent } from '../src/protocol.ts'
import {
  cacheHitPct,
  createDshSessionFeed,
  emptyDshFold,
  foldDshEvent,
  isWriteTool,
  metricsFrom,
} from '../src/server/dshSessionFeed.ts'

/**
 * DSH 自家会话接入(2026-09-09)。
 *
 * 事件序列与投影形状全部来自实测,不是照源码猜的——
 * 见 docs/superpowers/research/2026-09-09-DSH会话投影可读性.md。
 * 那份调研的两条硬结论钉在这里:
 * ① 生产(web)形态下 dsh-context 的 contextTimeline 是**瘦头**,没有 fileOps,
 *    所以「改了 n 个文件」只能自己从 tool/call 数;
 * ② DSH 没有「等你下一句」这一档,只有 approval/asked 才是「等你」。
 */

const NOW_SEC = 1_788_925_678

function ev(type: string, seq: number, data?: Record<string, unknown>) {
  return data === undefined ? { type, seq } : { type, seq, data }
}

describe('foldDshEvent(把 DSH 原生事件翻成工作台事件)', () => {
  it('turn/start → 在跑', () => {
    const out = foldDshEvent(emptyDshFold(), ev('turn/start', 4))
    expect(out.event).toEqual({ type: 'running' })
  })

  it('★approval/asked → 等你确认(可响铃的那一档;实测:只读模式下改文件真的会弹)', () => {
    const out = foldDshEvent(emptyDshFold(), ev('approval/asked', 471, { id: 'a1', toolName: 'edit' }))
    // wait_reason:2026-09-09 拍板第 4 条的分类,DSH 这一档能可靠判定(下面那个 describe 专门钉它)。
    expect(out.event).toEqual({ type: 'waiting', reason: 'permission_prompt', wait_reason: 'approval' })
  })

  it('approval/decided → 回到在跑(你处理完了,它接着干)', () => {
    const out = foldDshEvent(emptyDshFold(), ev('approval/decided', 472, { id: 'a1', outcome: 'rejected' }))
    expect(out.event).toEqual({ type: 'running' })
  })

  it('turn/end completed → 完成(蓝点)', () => {
    const out = foldDshEvent(emptyDshFold(), ev('turn/end', 213, { turn: 1, reason: { kind: 'completed' } }))
    // ended 是给事项过渡看的(2026-09-16),不进 WorkbenchEvent。
    expect(out.event).toEqual({ type: 'done', reason: 'stop', ended: { kind: 'done' } })
  })

  it('turn/end error → 出错', () => {
    const out = foldDshEvent(emptyDshFold(), ev('turn/end', 99, { reason: { kind: 'error', error: { message: 'boom' } } }))
    expect(out.event).toEqual({ type: 'error', reason: 'error', wait_reason: 'error', ended: { kind: 'error', detail: 'boom' } })
  })

  it('turn/end aborted → 已中断(界面上是"已中断",不是"出错了")', () => {
    const out = foldDshEvent(emptyDshFold(), ev('turn/end', 99, { reason: { kind: 'aborted' } }))
    expect(out.event).toEqual({ type: 'error', reason: 'interrupted', ended: { kind: 'aborted' } })
  })

  it('★没有「等你下一句」:turn/end 的其它成因不许伪造成 waiting', () => {
    // DSH 不区分"答完了"和"在等你说下一句",两者都是 completed。
    // 假造一条 idle_prompt 会让 DSH 会话平白多出黄点——同 hooks.ts 对 Codex 的处理,不补。
    const out = foldDshEvent(emptyDshFold(), ev('turn/end', 99, { reason: { kind: 'blocked' } }))
    expect(out.event).toEqual({ type: 'done', reason: 'stop', ended: { kind: 'done' } })
  })

  it('session/title → 只更新标题,不改状态', () => {
    const out = foldDshEvent(emptyDshFold(), ev('session/title', 39, { title: '读取note.txt并原样回复' }))
    expect(out.event).toBeUndefined()
    expect(out.state.title).toBe('读取note.txt并原样回复')
  })

  it('认不出的事件原样返回同一个 state(和投影单元同一条纪律:没变就别制造变化)', () => {
    const state = emptyDshFold()
    const out = foldDshEvent(state, ev('assistant/chunk', 13))
    expect(out.state).toBe(state)
    expect(out.event).toBeUndefined()
  })

  it('坏事件不抛:data 缺失、类型不对都当没看见', () => {
    expect(() => foldDshEvent(emptyDshFold(), ev('turn/end', 1))).not.toThrow()
    expect(foldDshEvent(emptyDshFold(), ev('turn/end', 1)).event).toEqual({ type: 'done', reason: 'stop', ended: { kind: 'done' } })
    expect(() => foldDshEvent(emptyDshFold(), { type: 'tool/call', seq: 2, data: { name: 5 } } as never)).not.toThrow()
  })
})

describe('改了几个文件(自己数,因为生产形态的投影里没有 fileOps)', () => {
  it('写类工具才算,读/搜不算', () => {
    expect(isWriteTool('write')).toBe(true)
    expect(isWriteTool('edit')).toBe(true)
    expect(isWriteTool('str_replace_editor')).toBe(true)
    expect(isWriteTool('read')).toBe(false)
    expect(isWriteTool('glob')).toBe(false)
    expect(isWriteTool('grep')).toBe(false)
    expect(isWriteTool('bash')).toBe(false) // 看不出改了哪个文件,宁可少数也不猜
  })

  it('★同一个文件改两次只算一个', () => {
    let state = emptyDshFold()
    state = foldDshEvent(state, ev('tool/call', 1, { name: 'write', arguments: '{"path":"/w/a.txt","content":"x"}' })).state
    state = foldDshEvent(state, ev('tool/call', 2, { name: 'edit', arguments: '{"path":"/w/a.txt"}' })).state
    state = foldDshEvent(state, ev('tool/call', 3, { name: 'edit', arguments: '{"file_path":"/w/b.txt"}' })).state
    expect(state.filesChanged).toBe(2)
  })

  it('参数不是 JSON、或者没有路径字段,就不计数(不猜)', () => {
    let state = emptyDshFold()
    state = foldDshEvent(state, ev('tool/call', 1, { name: 'write', arguments: '不是 JSON' })).state
    state = foldDshEvent(state, ev('tool/call', 2, { name: 'write', arguments: '{"content":"x"}' })).state
    expect(state.filesChanged).toBe(0)
  })
})

describe('三个数字(实测值直接搬进来)', () => {
  it('★上下文优先用 token-meter 的 contextPressure(厂商回报),不是 dsh-context 的估算', () => {
    const metrics = metricsFrom({
      contextPressure: { pressureTokens: 8805, projectedTokens: 8814, contextWindow: 1_000_000 },
      contextTimeline: { current: { total: 8951 } },
      tokenUsage: undefined,
      filesChanged: 0,
    })
    expect(metrics.context_tokens).toBe(8805)
  })

  it('contextPressure 缺席时退回 dsh-context 的 contextTimeline.current.total', () => {
    const metrics = metricsFrom({
      contextPressure: undefined,
      contextTimeline: { current: { total: 8951 } },
      tokenUsage: undefined,
      filesChanged: 0,
    })
    expect(metrics.context_tokens).toBe(8951)
  })

  it('★缓存命中与用量面板同一口径:读 /(读 + 未命中输入)', () => {
    // 实测值:uncachedInput 8651 / cacheRead 25472 → 74.6% → 75%
    expect(cacheHitPct({ uncachedInputTokens: 8651, outputTokens: 300, cacheReadTokens: 25472, cacheWriteTokens: 0 }))
      .toBe(75)
  })

  it('分母为 0 时不报 0%(0% 会被读成「一次没命中」)', () => {
    expect(cacheHitPct({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
      .toBeUndefined()
  })

  it('★一个都拿不到就整个 metrics 为空——留空,绝不编数(D13)', () => {
    const metrics = metricsFrom({
      contextPressure: undefined, contextTimeline: undefined, tokenUsage: undefined, filesChanged: 0,
    })
    expect(metrics).toEqual({})
  })

  it('文件数为 0 时也不显示(没改过文件 ≠ 要在行上占一格)', () => {
    const metrics = metricsFrom({
      contextPressure: { pressureTokens: 100 }, contextTimeline: undefined, tokenUsage: undefined, filesChanged: 0,
    })
    expect(metrics).toEqual({ context_tokens: 100 })
  })
})

describe('createDshSessionFeed(接线:事件进 → 工作台事件出)', () => {
  function harness() {
    const applyEvent = vi.fn()
    const setMetrics = vi.fn()
    const feed = createDshSessionFeed({
      applyEvent,
      setMetrics,
      now: () => NOW_SEC,
      resolveProject: async cwd => (cwd === '/Users/example/Documents/GitHub/Aiboo' ? 'Aiboo' : undefined),
    })
    return { applyEvent, setMetrics, feed }
  }

  it('★会话开始:先如实报一条(项目还没查出来),查到项目名再补报一条同状态的', async () => {
    // 项目归属要查 git,是异步的;状态变化不能等它——等它就意味着"点亮"永远慢一拍。
    // 补报是幂等的:同状态重复上报在 sessions.ts 里认成"没进入新状态",计时不会被打断。
    const { applyEvent, feed } = harness()
    feed.handleCreated('s1', '/Users/example/Documents/GitHub/Aiboo')
    feed.handleEvent('s1', ev('turn/start', 4))

    expect(applyEvent).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'dsh', session_id: 's1', type: 'running', cwd: '/Users/example/Documents/GitHub/Aiboo',
    }))
    expect(applyEvent.mock.calls[0]![0]).not.toHaveProperty('project')

    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(2))
    expect(applyEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      agent: 'dsh', session_id: 's1', type: 'running', project: 'Aiboo',
    }))
  })

  it('标题先落进 state,下一条状态上报时带出去(标题事件本身不制造状态变化)', async () => {
    const { applyEvent, feed } = harness()
    feed.handleCreated('s1', '/tmp/x')
    feed.handleEvent('s1', ev('session/title', 9, { title: '读取note.txt并原样回复' }))
    expect(applyEvent).not.toHaveBeenCalled()

    feed.handleEvent('s1', ev('turn/end', 10, { reason: { kind: 'completed' } }))
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalled())
    expect(applyEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'done', title: '读取note.txt并原样回复',
    }))
  })

  it('session/disposed → 离线,并把这条会话的内存状态丢掉', async () => {
    const { applyEvent, feed } = harness()
    feed.handleCreated('s1', '/tmp/x')
    feed.handleEvent('s1', ev('turn/start', 1))
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalled())
    applyEvent.mockClear()

    feed.handleDisposed('s1')
    expect(applyEvent).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'dsh', session_id: 's1', type: 'offline', reason: 'offline',
    }))
    expect(feed.size()).toBe(0)
  })

  it('★投影变化只写数字,不制造状态事件(否则每条 token 都会推一次快照)', () => {
    const { applyEvent, setMetrics, feed } = harness()
    feed.handleCreated('s1', '/tmp/x')
    feed.handleProjection('s1', 'tokenUsage', {
      uncachedInputTokens: 8651, outputTokens: 300, cacheReadTokens: 25472, cacheWriteTokens: 0,
    })
    feed.handleProjection('s1', 'contextPressure', { pressureTokens: 8805, contextWindow: 1_000_000 })

    expect(applyEvent).not.toHaveBeenCalled()
    expect(setMetrics).toHaveBeenLastCalledWith('s1', { context_tokens: 8805, cache_hit_pct: 75 })
  })

  it('文件计数进 metrics:改了两个文件就报 2', () => {
    const { setMetrics, feed } = harness()
    feed.handleCreated('s1', '/tmp/x')
    feed.handleEvent('s1', ev('tool/call', 1, { name: 'write', arguments: '{"path":"/w/a.txt"}' }))
    feed.handleEvent('s1', ev('tool/call', 2, { name: 'edit', arguments: '{"path":"/w/b.txt"}' }))
    expect(setMetrics).toHaveBeenLastCalledWith('s1', { files_changed: 2 })
  })

  it('★没见过 session/created 的会话也照收(先收到事件也不能丢),项目退回未归类', async () => {
    const { applyEvent, feed } = harness()
    feed.handleEvent('s9', ev('turn/start', 1))
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalled())
    const event = applyEvent.mock.calls[0]![0] as Record<string, unknown>
    expect(event.session_id).toBe('s9')
    expect(event.cwd).toBeUndefined()
  })

  it('★项目归属查询抛错也不能让上报丢掉(C2 同款兜底)', async () => {
    const applyEvent = vi.fn()
    const feed = createDshSessionFeed({
      applyEvent,
      setMetrics: vi.fn(),
      now: () => NOW_SEC,
      resolveProject: async () => { throw new Error('git 挂了') },
    })
    feed.handleCreated('s1', '/tmp/x')
    feed.handleEvent('s1', ev('turn/start', 1))
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalled())
    expect(applyEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'running', cwd: '/tmp/x' }))
  })
})

/**
 * 验收:把 2026-09-09 探针在灰度 web 实例上**真实录到**的那条会话原样回放一遍。
 * 事件顺序、工具名、投影数值全部照抄探针日志(session 7609c43c),
 * 不是照源码构造的——这条用例塌了就说明我们对 DSH 的理解和真机对不上了。
 */
describe('验收:回放真机录到的一条 DSH 会话', () => {
  it('★状态一路走到「等你确认」再回到完成,三个数字都对得上', async () => {
    const events: WorkbenchEvent[] = []
    const metrics: SessionMetrics[] = []
    const feed = createDshSessionFeed({
      applyEvent: e => events.push(e),
      setMetrics: (_id, m) => metrics.push(m),
      now: () => NOW_SEC,
    })

    feed.handleCreated('7609c43c', '/private/tmp/probe/ws')
    feed.handleEvent('7609c43c', ev('turn/start', 5))
    feed.handleEvent('7609c43c', ev('session/title', 9, { title: '在当前目录操作文件并确认' }))
    feed.handleEvent('7609c43c', ev('tool/call', 123, { name: 'write', arguments: '{"file_path":"/private/tmp/probe/ws/probe-web.txt","content":"hello-web"}' }))
    feed.handleEvent('7609c43c', ev('tool/call', 125, { name: 'glob', arguments: '{"pattern":"*.txt"}' }))
    feed.handleEvent('7609c43c', ev('tool/call', 161, { name: 'read', arguments: '{"file_path":"/private/tmp/probe/ws/note.txt"}' }))
    feed.handleEvent('7609c43c', ev('tool/call', 202, { name: 'edit', arguments: '{"file_path":"/private/tmp/probe/ws/note.txt"}' }))
    feed.handleProjection('7609c43c', 'tokenUsage', {
      uncachedInputTokens: 8651, outputTokens: 300, cacheReadTokens: 25472, cacheWriteTokens: 0,
    })
    feed.handleProjection('7609c43c', 'contextPressure', {
      pressureTokens: 8805, projectedTokens: 8814, contextWindow: 1_000_000,
    })
    feed.handleProjection('7609c43c', 'contextTimeline', {
      current: { total: 8951 }, contextWindow: 1_000_000, detailRev: 10,
    })
    feed.handleEvent('7609c43c', ev('turn/end', 213, { turn: 1, reason: { kind: 'completed' } }))
    feed.handleEvent('7609c43c', ev('approval/asked', 471, { id: 'a1', toolName: 'edit' }))
    feed.handleEvent('7609c43c', ev('approval/decided', 472, { id: 'a1', outcome: 'rejected' }))
    feed.handleEvent('7609c43c', ev('turn/end', 557, { turn: 2, reason: { kind: 'completed' } }))

    expect(events.map(e => `${e.type}${e.reason === undefined ? '' : `/${e.reason}`}`)).toEqual([
      'running', 'done/stop', 'waiting/permission_prompt', 'running', 'done/stop',
    ])
    // 标题在第二条以后才有(session/title 排在 turn/start 之后)——如实反映,不回填。
    expect(events[0]?.title).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ agent: 'dsh', session_id: '7609c43c', title: '在当前目录操作文件并确认' })
    // 读/搜工具不算:真机这一轮 write ×1、edit ×1、read ×1、glob ×1 → 改了 2 个文件。
    expect(metrics.at(-1)).toEqual({ context_tokens: 8805, cache_hit_pct: 75, files_changed: 2 })
  })
})

/**
 * 与哨兵共用 `agent:'dsh'` 这个桶(2026-09-09,哨兵先并入 main)。
 * 哨兵的会话 id 是 `sentinel:<监视项 id>`、状态是 waiting/idle_prompt,由它自己生灭;
 * 我们只管真实 DSH 会话(UUID)。两条线在同一个桶里各管各的,谁也不许收掉谁。
 */
describe('与哨兵共用 dsh 会话桶', () => {
  it('★session/disposed 只收自己报过的会话:没报过就不发 offline', () => {
    const applyEvent = vi.fn()
    const feed = createDshSessionFeed({ applyEvent, setMetrics: vi.fn(), now: () => NOW_SEC })

    // 实测:网页上光是点开输入框,DSH 就会 created 两条从没走到 turn/start 的会话。
    feed.handleCreated('never-ran', '/tmp/x')
    feed.handleDisposed('never-ran')
    expect(applyEvent).not.toHaveBeenCalled()

    feed.handleCreated('ran', '/tmp/x')
    feed.handleEvent('ran', ev('turn/start', 1))
    applyEvent.mockClear()
    feed.handleDisposed('ran')
    expect(applyEvent).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'ran', type: 'offline' }))
  })

  it('★哨兵命名空间的 id 一律不认,四个入口都不动它', () => {
    const applyEvent = vi.fn()
    const setMetrics = vi.fn()
    const feed = createDshSessionFeed({ applyEvent, setMetrics, now: () => NOW_SEC })

    feed.handleCreated('sentinel:w1', '/tmp/x')
    feed.handleEvent('sentinel:w1', ev('turn/start', 1))
    feed.handleProjection('sentinel:w1', 'tokenUsage', { uncachedInputTokens: 1, cacheReadTokens: 3 })
    feed.handleDisposed('sentinel:w1')

    expect(applyEvent).not.toHaveBeenCalled()
    expect(setMetrics).not.toHaveBeenCalled()
    expect(feed.size()).toBe(0)
  })

  it('会话 id 用 DSH 给的真 id,不自造——撞不上哨兵的 `sentinel:` 前缀', () => {
    const applyEvent = vi.fn()
    const feed = createDshSessionFeed({ applyEvent, setMetrics: vi.fn(), now: () => NOW_SEC })
    feed.handleEvent('ce314aa2-d5f1-404e-af9f-26057609c43c', ev('turn/start', 1))
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({
      agent: 'dsh', session_id: 'ce314aa2-d5f1-404e-af9f-26057609c43c',
    })
  })
})

/**
 * 等待原因分类(2026-09-09 傍晚拍板第 4 条)。DSH 能可靠判两种:
 * approval/asked → 等审批;turn/end 的 error / max-tokens → 出错。
 * aborted 是「有人按了停止」,不是出错也不是等待——不填(D13)。额度不足不在这里判,由采集器打标。
 */
describe('foldDshEvent · wait_reason', () => {
  it('approval/asked → approval', () => {
    const out = foldDshEvent(emptyDshFold(), ev('approval/asked', 1, { id: 'a1', toolName: 'edit' }))
    expect(out.event).toEqual({ type: 'waiting', reason: 'permission_prompt', wait_reason: 'approval' })
  })

  it('turn/end error / max-tokens → error', () => {
    for (const kind of ['error', 'max-tokens']) {
      const out = foldDshEvent(emptyDshFold(), ev('turn/end', 2, { reason: { kind } }))
      expect(out.event).toEqual({ type: 'error', reason: 'error', wait_reason: 'error', ended: { kind: 'error' } })
    }
  })

  it('aborted(已中断)与 completed / turn/start 都不填 wait_reason', () => {
    expect(foldDshEvent(emptyDshFold(), ev('turn/end', 3, { reason: { kind: 'aborted' } })).event)
      .toEqual({ type: 'error', reason: 'interrupted', ended: { kind: 'aborted' } })
    expect(foldDshEvent(emptyDshFold(), ev('turn/end', 4, { reason: { kind: 'completed' } })).event)
      .toEqual({ type: 'done', reason: 'stop', ended: { kind: 'done' } })
    expect(foldDshEvent(emptyDshFold(), ev('turn/start', 5)).event).toEqual({ type: 'running' })
  })

  it('接线层把 wait_reason 原样带进上报', () => {
    const applyEvent = vi.fn<(event: WorkbenchEvent) => void>()
    const feed = createDshSessionFeed({ applyEvent, setMetrics: vi.fn(), now: () => NOW_SEC })
    feed.handleCreated('s1', '/Users/example/Documents/GitHub/DouDou')
    feed.handleEvent('s1', ev('approval/asked', 1, { id: 'a1', toolName: 'edit' }))
    expect(applyEvent).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'dsh', type: 'waiting', wait_reason: 'approval' }))
    feed.handleEvent('s1', ev('turn/end', 2, { reason: { kind: 'aborted' } }))
    expect(applyEvent.mock.lastCall?.[0]).not.toHaveProperty('wait_reason')
  })
})

describe('会话结束端口(2026-09-16 事项生命周期闭环)', () => {
  function harness() {
    const onSessionEnd = vi.fn()
    const feed = createDshSessionFeed({ applyEvent: vi.fn(), setMetrics: vi.fn(), now: () => NOW_SEC, onSessionEnd })
    return { feed, onSessionEnd }
  }

  it('turn/end completed → 报 done,带时刻与改过的文件数', () => {
    const { feed, onSessionEnd } = harness()
    feed.handleEvent('s1', ev('turn/end', 3, { reason: { kind: 'completed' } }))
    // filesChanged 从 2026-09-25(卡 Y)起一起报:事项那边据此判「这一轮算不算一件事」。
    expect(onSessionEnd).toHaveBeenCalledWith('s1', { kind: 'done', ts: NOW_SEC, filesChanged: 0 })
  })

  it('★改过文件的那条会话 → 结束时把文件数一起报上去(卡 Y 的判据之一)', () => {
    const { feed, onSessionEnd } = harness()
    feed.handleEvent('s1', ev('tool/call', 1, { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/a.ts' }) }))
    feed.handleEvent('s1', ev('turn/end', 3, { reason: { kind: 'completed' } }))
    expect(onSessionEnd).toHaveBeenCalledWith('s1', { kind: 'done', ts: NOW_SEC, filesChanged: 1 })
  })

  it('★turn/end error → 报 error,把 DSH 给的原话带出来(max-tokens 同档,没原话就不编)', () => {
    const { feed, onSessionEnd } = harness()
    feed.handleEvent('s1', ev('turn/end', 3, { reason: { kind: 'error', error: { message: '模型路由不可用', code: 'UNKNOWN' } } }))
    expect(onSessionEnd).toHaveBeenCalledWith('s1', { kind: 'error', ts: NOW_SEC, detail: '模型路由不可用', filesChanged: 0 })
    feed.handleEvent('s2', ev('turn/end', 3, { reason: { kind: 'max-tokens' } }))
    expect(onSessionEnd).toHaveBeenLastCalledWith('s2', { kind: 'error', ts: NOW_SEC, filesChanged: 0 })
  })

  it('turn/end aborted → 报 aborted(他自己按的停,不是出错)', () => {
    const { feed, onSessionEnd } = harness()
    feed.handleEvent('s1', ev('turn/end', 3, { reason: { kind: 'aborted', reason: { kind: 'user' } } }))
    expect(onSessionEnd).toHaveBeenCalledWith('s1', { kind: 'aborted', ts: NOW_SEC, filesChanged: 0 })
  })

  it('turn/start、approval、标题都不算结束;哨兵前缀的 id 不认', () => {
    const { feed, onSessionEnd } = harness()
    feed.handleEvent('s1', ev('turn/start', 1))
    feed.handleEvent('s1', ev('approval/asked', 2))
    feed.handleEvent('s1', ev('session/title', 3, { title: 'x' }))
    feed.handleEvent('sentinel:w1', ev('turn/end', 4, { reason: { kind: 'completed' } }))
    expect(onSessionEnd).not.toHaveBeenCalled()
  })

  /**
   * 评估第四节里**唯一要接的上游功能**:bash 超过 120 秒自动转后台任务,做完往会话塞一条 notice
   * 把她唤醒。第六节验收第 6 条:「这条 notice 不出现在『她说了什么』和手机字幕里」,
   * 同时「不断、做完会话自己接着说」—— 所以过滤不能把转态那条路一起滤掉。
   */
  it('★后台任务做完唤醒:notice 不进回合,但那一回合照样走到 turn/end → 事项转态', () => {
    const applyEvent = vi.fn<(event: WorkbenchEvent) => void>()
    const onSessionEnd = vi.fn()
    const feed = createDshSessionFeed({ applyEvent, setMetrics: vi.fn(), now: () => NOW_SEC, onSessionEnd })
    feed.handleCreated('s1', '/tmp/x')
    // 第一回合:她起了个后台任务就先答完了
    feed.handleEvent('s1', ev('turn/start', 1, { turn: 1 }))
    feed.handleEvent('s1', ev('assistant/message', 2, { turn: 1, step: 1, message: { id: 'm-a1', role: 'assistant', content: [{ type: 'text', text: '测试在后台跑着,跑完我说。' }], source: { kind: 'model' } } }))
    feed.handleEvent('s1', ev('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }))
    // 任务做完了 → 上游 followup 一条 notice,把 idle 的她唤醒:新回合开起来
    feed.handleEvent('s1', ev('turn/start', 4, { turn: 2 }))
    feed.handleEvent('s1', ev('user/message', 5, {
      id: 'm-job', role: 'user',
      content: [{ type: 'text', text: 'background job job-7 (bash: pnpm test) finished completed. Read its output with job_output.' }],
      source: { kind: 'tool-jobs', form: 'notice', summary: 'bash pnpm test completed' },
    }))
    feed.handleEvent('s1', ev('assistant/message', 6, { turn: 2, step: 1, message: { id: 'm-a2', role: 'assistant', content: [{ type: 'text', text: '测试全绿,438 个文件都过了。' }], source: { kind: 'model' } } }))
    feed.handleEvent('s1', ev('turn/end', 7, { turn: 2, reason: { kind: 'completed' } }))

    // ① 那条 notice 一个字都没进回合列表(手机字幕、「她说了什么」读的就是这个)
    expect(feed.turns('s1', 20)!.map(turn => turn.text)).toEqual(['测试在后台跑着,跑完我说。', '测试全绿,438 个文件都过了。'])
    expect(feed.turns('s1', 20)!.every(turn => turn.role === 'assistant')).toBe(true)
    // ② summary 是她说的那一句,不是 notice 的原文
    expect(applyEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'done', summary: '测试全绿,438 个文件都过了。' }))
    // ③ 转态那条路照旧走通:两个回合各报一次结束,事项据此进「等你确认」
    expect(onSessionEnd).toHaveBeenCalledTimes(2)
    expect(onSessionEnd).toHaveBeenLastCalledWith('s1', { kind: 'done', ts: NOW_SEC, filesChanged: 0 })
  })

  it('★只有一条 notice、她一个字没说:不凭空造回合,也不把 summary 擦成 notice 原文', () => {
    const applyEvent = vi.fn<(event: WorkbenchEvent) => void>()
    const feed = createDshSessionFeed({ applyEvent, setMetrics: vi.fn(), now: () => NOW_SEC })
    feed.handleCreated('s1', '/tmp/x')
    feed.handleEvent('s1', ev('user/message', 1, { id: 'm-job', role: 'user', content: [{ type: 'text', text: 'background job job-9 finished failed.' }], source: { kind: 'tool-jobs', form: 'notice', summary: 'bash x failed' } }))
    expect(feed.turns('s1', 20)).toEqual([])
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('★定时任务提醒 / 时间上下文这类系统消息也一条都不进回合(两代的写法都试)', () => {
    const feed = createDshSessionFeed({ applyEvent: vi.fn(), setMetrics: vi.fn(), now: () => NOW_SEC })
    feed.handleCreated('s1', '/tmp/x')
    feed.handleEvent('s1', ev('user/message', 1, { id: 'm1', role: 'user', content: [{ type: 'text', text: '[SCHEDULE REMINDER] 九点再核一次进度' }], source: { kind: 'schedule' } }))
    feed.handleEvent('s1', ev('user/message', 2, { id: 'm2', role: 'user', content: [{ type: 'text', text: 'Current time: …' }], source: { kind: 'time-context' } }))
    feed.handleEvent('s1', ev('user/message', 3, { id: 'm3', role: 'user', content: [{ type: 'text', text: '子代理结算' }], source: { kind: 'subagent-settled' } }))
    // 0 代的老写法
    feed.handleEvent('s1', ev('user/message', 4, { id: 'm4', role: 'user', content: [{ type: 'text', text: '<context>…</context>' }], source: { kind: 'plugin', plugin: 'agent-instructions' } }))
    // 人真说的那一句要在
    feed.handleEvent('s1', ev('user/message', 5, { id: 'm5', role: 'user', content: [{ type: 'text', text: '把回归跑一遍' }], source: { kind: 'user' } }))
    expect(feed.turns('s1', 20)!.map(turn => turn.text)).toEqual(['把回归跑一遍'])
  })
})

/**
 * 认 DSH 子代理(卡 U3,接卡 Q 的 children)。0.1.7 里子代理就是一条普通会话,
 * `session/created` 送过来的 `session.header` 上带 `origin: 'subagent'` 与 `parentSession`。
 */
describe('★子代理出身(parentOf,卡 U3)', () => {
  function feedOf() {
    return createDshSessionFeed({ applyEvent: vi.fn(), setMetrics: vi.fn(), now: () => NOW_SEC })
  }

  it('★origin=subagent + parentSession → 认出父会话', () => {
    const feed = feedOf()
    feed.handleCreated('child-1', { cwd: '/tmp/x', origin: 'subagent', parentSession: 'parent-1' })
    expect(feed.parentOf('child-1')).toBe('parent-1')
  })

  it('★普通会话、以及只带 parentSession 的分叉会话都不算子代理', () => {
    const feed = feedOf()
    feed.handleCreated('top-1', { cwd: '/tmp/x' })
    feed.handleCreated('fork-1', { cwd: '/tmp/x', parentSession: 'top-1' })
    expect(feed.parentOf('top-1')).toBeUndefined()
    expect(feed.parentOf('fork-1')).toBeUndefined()
  })

  it('老调用法(第二个参数直接给 cwd 字符串)照旧管用,cwd 照样进上报', () => {
    const applyEvent = vi.fn<(event: WorkbenchEvent) => void>()
    const feed = createDshSessionFeed({ applyEvent, setMetrics: vi.fn(), now: () => NOW_SEC })
    feed.handleCreated('s1', '/Users/example/Documents/GitHub/DouDou')
    feed.handleEvent('s1', ev('turn/start', 1))
    expect(applyEvent).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/Users/example/Documents/GitHub/DouDou' }))
    expect(feed.parentOf('s1')).toBeUndefined()
  })

  it('不认识的会话 → undefined;哨兵那条不记出身', () => {
    const feed = feedOf()
    feed.handleCreated('sentinel:w1', { origin: 'subagent', parentSession: 'p' })
    expect(feed.parentOf('sentinel:w1')).toBeUndefined()
    expect(feed.parentOf('nobody')).toBeUndefined()
  })

  it('★会话被收掉(session/disposed)之后出身还记得 —— 不然子代理一办完就从父卡底下掉出来、在列表上凭空多一行', () => {
    const feed = feedOf()
    feed.handleCreated('child-1', { cwd: '/tmp/x', origin: 'subagent', parentSession: 'parent-1' })
    feed.handleEvent('child-1', ev('turn/start', 1))
    feed.handleEvent('child-1', ev('turn/end', 2, { reason: { kind: 'completed' } }))
    feed.handleDisposed('child-1')
    // 会话表里那一行还在(状态被报成 offline),所以出身也得还在
    expect(feed.parentOf('child-1')).toBe('parent-1')
  })
})

describe('会话结束端口:端口抛错', () => {
  it('端口抛了不能带走上报本身(事件回调里绝不抛)', () => {
    const applyEvent = vi.fn()
    const feed = createDshSessionFeed({ applyEvent, setMetrics: vi.fn(), now: () => NOW_SEC, onSessionEnd: () => { throw new Error('boom') } })
    expect(() => feed.handleEvent('s1', ev('turn/end', 3, { reason: { kind: 'completed' } }))).not.toThrow()
    expect(applyEvent).toHaveBeenCalledWith(expect.objectContaining({ session_id: 's1', type: 'done' }))
  })
})

describe('事务官自己的会话:最近在做什么(2026-09-25,卡 P)', () => {
  it('她说一段话 → 那段话第一句人话;调一个工具 → 按种类说一句(不出现工具名)', () => {
    const setDetail = vi.fn()
    const feed = createDshSessionFeed({ applyEvent: () => {}, setMetrics: () => {}, setDetail, now: () => NOW_SEC })
    feed.handleCreated('s1', '/tmp/x')
    feed.handleEvent('s1', ev('turn/start', 0))
    feed.handleEvent('s1', ev('assistant/message', 1, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '我先读一下 `docs/交接.md`，再核对最近的提交。' }] } }))
    expect(setDetail).toHaveBeenLastCalledWith('s1', { activity: { line: '我先读一下', at: new Date(NOW_SEC * 1000).toISOString() } })
    feed.handleEvent('s1', ev('tool/call', 2, { name: 'bash', arguments: JSON.stringify({ command: 'cd /x && npx vitest run' }) }))
    expect(setDetail).toHaveBeenLastCalledWith('s1', { activity: { line: '在跑测试', at: new Date(NOW_SEC * 1000).toISOString() } })
    feed.handleEvent('s1', ev('tool/call', 3, { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'str_replace', path: '/x/a.ts' }) }))
    expect(setDetail).toHaveBeenLastCalledWith('s1', { activity: { line: '在改文件', at: new Date(NOW_SEC * 1000).toISOString() } })
  })
})

describe('会话用哪一家哪个模型(2026-10-23 运行时 P1:模型设置变更后要能重指受控会话)', () => {
  it('request/header 的 config 里同时记 provider 与模型;selectionOf 供重指编排用', () => {
    const feed = createDshSessionFeed({ applyEvent: () => {}, setMetrics: () => {}, now: () => NOW_SEC })
    feed.handleCreated('s1', '/tmp/x')
    // 建册了但还没说过话:认识、selection 为空(重指编排据「provider 缺席」跳过它);
    // 压根没见过的会话 id 才回 undefined。
    expect(feed.selectionOf('s1')).toEqual({})
    expect(feed.selectionOf('s-never')).toBeUndefined()
    feed.handleEvent('s1', ev('request/header', 1, { header: { config: { provider: 'workbench-own', model: 'qa-brain-a' } } }))
    expect(feed.selectionOf('s1')).toEqual({ provider: 'workbench-own', model: 'qa-brain-a' })
    // 换模型后第二次请求:selectionOf 跟着变(重指过的会话下次就是这个)。
    feed.handleEvent('s1', ev('request/header', 2, { header: { config: { provider: 'workbench-own', model: 'qa-brain-b' } } }))
    expect(feed.selectionOf('s1')).toEqual({ provider: 'workbench-own', model: 'qa-brain-b' })
    // 只给 model 不给 provider(上游旧形状):model 照记,provider 缺席,不编。
    feed.handleEvent('s2', ev('request/header', 3, { header: { config: { model: 'deepseek-v4-flash' } } }))
    expect(feed.selectionOf('s2')).toEqual({ model: 'deepseek-v4-flash' })
  })
})


it('modelSelection.next优先于旧header，usage仍是实际请求；空/异常投影不伪造选择', () => {
  const feed = createDshSessionFeed({ applyEvent: vi.fn(), setMetrics: vi.fn() })
  const old = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const next = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  feed.handleEvent('s', ev('request/header', 1, { header: { config: old } }))
  feed.handleProjection('s', 'modelSelection', { lastUsed: old, next })
  feed.handleEvent('s', ev('request/header', 2, { header: { config: old } }))
  expect(feed.selectionOf('s')).toEqual(next)
  expect(feed.selections()).toEqual([{ sessionId: 's', ...next }])
  expect(feed.usage('s')?.model).toBe(old.model)
  feed.handleProjection('s', 'modelSelection', { lastUsed: next, next })
  expect(feed.selectionOf('s')).toEqual(next)
  feed.handleProjection('s', 'modelSelection', { lastUsed: old, next: null })
  expect(feed.selectionOf('s')).toEqual(old)
  feed.handleProjection('s', 'modelSelection', { next: { provider: 1, model: 'bad' } })
  expect(feed.selectionOf('s')).toEqual(old)
})
