// @vitest-environment node
/**
 * DSH 会话的最新回合 → `SessionView.summary` 与回合列表(2026-09-15)。
 *
 * 出处:docs/交接-0914-butler-app.md 第五节第 1 条——手机上事务官那一侧只认 `summary`,
 * DSH 会话以前不填,手机上永远只有「在办 / 办完了」这类状态行。
 *
 * 事件形状照 DSH 0.1.2-rc.1 的类型(packages/core/session 的 SessionEventMap 与
 * packages/llm/llm 的 Message):`user/message` 的 data 就是 UserMessage,
 * `assistant/message` 的 data 是 `{ turn, step, message: AssistantMessage }`,
 * content 是 text / reasoning / tool-call 几种块。
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchEvent } from '../src/protocol.ts'
import {
  authorOfUserMessage,
  createDshSessionFeed,
  emptyDshFold,
  foldDshEvent,
  plainTextOf,
  SUMMARY_MAX,
  summarizeText,
  TURN_TEXT_MAX,
} from '../src/server/dshSessionFeed.ts'

const NOW_SEC = 1_788_925_678
const NOW_ISO = new Date(NOW_SEC * 1000).toISOString()

function ev(type: string, seq: number, data?: Record<string, unknown>) {
  return data === undefined ? { type, seq } : { type, seq, data }
}

function userMessage(text: string, source: Record<string, unknown> = { kind: 'user' }) {
  return { id: 'm-u', role: 'user', content: [{ type: 'text', text }], source }
}

function assistantMessage(content: Record<string, unknown>[], turn = 1, step = 1) {
  return { turn, step, message: { id: 'm-a', role: 'assistant', content, source: { kind: 'model' } } }
}

describe('plainTextOf(消息正文 → 给人看的纯文本)', () => {
  it('只取 text 块;reasoning 与 tool-call 块整块不要', () => {
    expect(plainTextOf([
      { type: 'reasoning', text: '我先想想' },
      { type: 'text', text: '好的,' },
      { type: 'tool-call', id: 'c1', name: 'write', arguments: '{"path":"a"}' },
      { type: 'text', text: '已经写好了。' },
    ])).toBe('好的,\n已经写好了。')
  })

  it('★围栏代码块整段去掉,前后正文保留', () => {
    const text = '改法如下:\n```ts\nconst a = 1\n```\n改完就好了。'
    expect(plainTextOf([{ type: 'text', text }])).toBe('改法如下:\n改完就好了。')
  })

  it('没闭合的围栏也从围栏起全部去掉(半截代码比没有更误导)', () => {
    expect(plainTextOf([{ type: 'text', text: '先看这段\n```\nfoo()\nbar()' }])).toBe('先看这段')
  })

  it('去掉之后什么都不剩 → undefined,不给空串', () => {
    expect(plainTextOf([{ type: 'text', text: '```\nonly code\n```' }])).toBeUndefined()
    expect(plainTextOf([{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }])).toBeUndefined()
    expect(plainTextOf([])).toBeUndefined()
    expect(plainTextOf('不是数组')).toBeUndefined()
  })

  it('坏块不抛:缺 text、text 不是字符串都跳过', () => {
    expect(plainTextOf([{ type: 'text' }, { type: 'text', text: 7 }, { type: 'text', text: '行' }])).toBe('行')
  })
})

describe('summarizeText(截 200 字,尾部加省略号)', () => {
  it('短的原样(去掉首尾空白)', () => {
    expect(summarizeText('  写好了。  ')).toBe('写好了。')
  })

  it(`★超过 ${SUMMARY_MAX} 字截断并加「…」`, () => {
    const long = '字'.repeat(SUMMARY_MAX + 50)
    const out = summarizeText(long)
    expect(out).toBe(`${'字'.repeat(SUMMARY_MAX)}…`)
    expect(out.length).toBe(SUMMARY_MAX + 1)
  })

  it('刚好 200 字不加省略号', () => {
    expect(summarizeText('字'.repeat(SUMMARY_MAX))).toBe('字'.repeat(SUMMARY_MAX))
  })
})

describe('foldDshEvent:回合文本进状态', () => {
  it('assistant/message 的文本记为本回合最新一段,turn/end 时变成 summary', () => {
    let state = emptyDshFold()
    state = foldDshEvent(state, ev('turn/start', 1)).state
    const step1 = foldDshEvent(state, ev('assistant/message', 2, assistantMessage([{ type: 'text', text: '我先看一下文件。' }])))
    expect(step1.turn).toEqual({ role: 'assistant', text: '我先看一下文件。' })
    state = step1.state
    state = foldDshEvent(state, ev('assistant/message', 3, assistantMessage([{ type: 'text', text: '改好了,黄历接上了。' }], 1, 2))).state
    const end = foldDshEvent(state, ev('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }))
    expect(end.state.summary).toBe('改好了,黄历接上了。')
    expect(end.event).toMatchObject({ type: 'done', reason: 'stop' })
  })

  it('★最后一步只有工具调用没有文字 → summary 取更早那段文字,不取空', () => {
    let state = emptyDshFold()
    state = foldDshEvent(state, ev('turn/start', 1)).state
    state = foldDshEvent(state, ev('assistant/message', 2, assistantMessage([{ type: 'text', text: '先改 a.ts。' }]))).state
    const toolOnly = foldDshEvent(state, ev('assistant/message', 3, assistantMessage([
      { type: 'tool-call', id: 'c1', name: 'edit', arguments: '{}' },
    ], 1, 2)))
    expect(toolOnly.turn).toBeUndefined()
    expect(toolOnly.state).toBe(state)
    state = toolOnly.state
    state = foldDshEvent(state, ev('turn/end', 4, { reason: { kind: 'completed' } })).state
    expect(state.summary).toBe('先改 a.ts。')
  })

  it('★整个回合一个字都没说 → turn/end 不填 summary,也不擦上一回合的', () => {
    let state = emptyDshFold()
    state = foldDshEvent(state, ev('turn/start', 1)).state
    state = foldDshEvent(state, ev('assistant/message', 2, assistantMessage([{ type: 'text', text: '第一回合说的。' }]))).state
    state = foldDshEvent(state, ev('turn/end', 3, { reason: { kind: 'completed' } })).state
    expect(state.summary).toBe('第一回合说的。')

    state = foldDshEvent(state, ev('turn/start', 4)).state
    expect(state.summary).toBe('第一回合说的。') // turn/start 不清空
    state = foldDshEvent(state, ev('assistant/message', 5, assistantMessage([{ type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }]))).state
    state = foldDshEvent(state, ev('turn/end', 6, { reason: { kind: 'completed' } })).state
    expect(state.summary).toBe('第一回合说的。')
  })

  it('summary 去代码块并截 200 字', () => {
    let state = emptyDshFold()
    const text = `结论:${'很'.repeat(300)}\n\`\`\`sh\nrm -rf build\n\`\`\`\n完。`
    state = foldDshEvent(state, ev('assistant/message', 2, assistantMessage([{ type: 'text', text }]))).state
    state = foldDshEvent(state, ev('turn/end', 3, { reason: { kind: 'completed' } })).state
    expect(state.summary).not.toContain('rm -rf')
    expect(state.summary?.length).toBe(SUMMARY_MAX + 1)
    expect(state.summary?.endsWith('…')).toBe(true)
  })

  it('出错/中断收尾的回合,说过的话照样进 summary(那是真说过的)', () => {
    let state = emptyDshFold()
    state = foldDshEvent(state, ev('assistant/message', 2, assistantMessage([{ type: 'text', text: '正在改…' }]))).state
    state = foldDshEvent(state, ev('turn/end', 3, { reason: { kind: 'aborted' } })).state
    expect(state.summary).toBe('正在改…')
  })

  it('user/message:来源是人(source.kind=user)才算一个回合;插件注入的上下文不算', () => {
    const human = foldDshEvent(emptyDshFold(), ev('user/message', 1, userMessage('把黄历接上')))
    expect(human.turn).toEqual({ role: 'user', text: '把黄历接上' })
    expect(human.event).toBeUndefined()

    const plugin = foldDshEvent(emptyDshFold(), ev('user/message', 2, userMessage('<context>…</context>', { kind: 'plugin', plugin: 'time-context' })))
    expect(plugin.turn).toBeUndefined()
  })

  it('坏数据不抛:message 缺失、content 不是数组', () => {
    expect(() => foldDshEvent(emptyDshFold(), ev('assistant/message', 1, { turn: 1 }))).not.toThrow()
    expect(foldDshEvent(emptyDshFold(), ev('assistant/message', 1, { turn: 1, message: { content: 'x' } })).turn).toBeUndefined()
    expect(() => foldDshEvent(emptyDshFold(), ev('user/message', 1, { content: null }))).not.toThrow()
  })
})

/**
 * 升到 0.1.7(卡 U3):上游默认 web 组合往会话里塞的系统消息多了好几种,而且**写法换了** ——
 * 0 代是 `{kind:'plugin', plugin:'X'}`,4 代拆平成 `{kind:'X'}`(上游 `rewritePluginSource`,
 * 并在 `message-sources.ts` 里硬拒再出现 `kind:'plugin'`)。两代都要认,认不出就会被当成「他说了一句」。
 */
describe('★过滤上游塞进来的系统消息(authorOfUserMessage,两代)', () => {
  it('★人真说的一句:kind=user', () => {
    expect(authorOfUserMessage({ kind: 'user' })).toEqual({ kind: 'human' })
  })

  it('★4 代的拆平写法:生产者自己的 kind 直接当系统消息滤掉', () => {
    // 这一串照抄上游 RELEASED_SAME_NAME_PRODUCERS 里跟我们有关的那几个
    for (const kind of ['schedule', 'time-context', 'subagent-settled', 'subagent-report', 'agent-instructions', 'skill-invocation', 'plan-mode', 'hooks-claude-code', 'webhook', 'runtime-context']) {
      expect(authorOfUserMessage({ kind }), kind).toEqual({ kind: 'system', producer: kind })
    }
  })

  it('★0 代的老写法:{kind:plugin, plugin:X} 同样滤掉,真正的生产者报 X', () => {
    expect(authorOfUserMessage({ kind: 'plugin', plugin: 'time-context' })).toEqual({ kind: 'system', producer: 'time-context' })
    expect(authorOfUserMessage({ kind: 'plugin', plugin: 'schedule' })).toEqual({ kind: 'system', producer: 'schedule' })
  })

  it('★白名单而不是黑名单:上游以后新加的生产者默认当系统消息,不漏进「他说了一句」', () => {
    expect(authorOfUserMessage({ kind: '某个还没出现的插件' })).toEqual({ kind: 'system', producer: '某个还没出现的插件' })
  })

  it('★后台任务做完唤醒那条 notice 要**认出来**(不是普通系统消息),summary 带上', () => {
    // 判据来自上游 jobs/tool-jobs/src/index.ts:createUserMessage({ source: {kind:'tool-jobs', form:'notice', summary} })
    expect(authorOfUserMessage({ kind: 'tool-jobs', form: 'notice', summary: 'bash pnpm test completed' }))
      .toEqual({ kind: 'job-notice', summary: 'bash pnpm test completed' })
    // 0 代的写法(真机上不会有 —— 0.1.2 没有 tool-jobs —— 但判据对两代同形)
    expect(authorOfUserMessage({ kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'x' }))
      .toEqual({ kind: 'job-notice', summary: 'x' })
  })

  it('tool-jobs 塞的别的东西(不是 notice 那一种)照旧当系统消息', () => {
    expect(authorOfUserMessage({ kind: 'tool-jobs', form: 'snapshot', sections: [] })).toEqual({ kind: 'system', producer: 'tool-jobs' })
  })

  it('source 缺席 / 形状不对 → 当人说的(0 代早期真文件里有不带 source 的 user/message,那时只有人能写这一格)', () => {
    expect(authorOfUserMessage(undefined)).toEqual({ kind: 'human' })
    expect(authorOfUserMessage({})).toEqual({ kind: 'human' })
    expect(authorOfUserMessage('user')).toEqual({ kind: 'human' })
    expect(authorOfUserMessage({ kind: '' })).toEqual({ kind: 'human' })
  })
})

describe('★foldDshEvent 对系统消息与唤醒 notice(卡 U3)', () => {
  it('★4 代的时间上下文:不进回合、不动状态、不动 summary', () => {
    const state = { ...emptyDshFold(), summary: '上一句还在' }
    const out = foldDshEvent(state, ev('user/message', 9, userMessage('Current time: …', { kind: 'time-context' })))
    expect(out.turn).toBeUndefined()
    expect(out.notice).toBeUndefined()
    expect(out.event).toBeUndefined()
    expect(out.state).toBe(state) // 同一个引用:上层据此判断「什么都没变」
  })

  it('★唤醒 notice:报一条 notice,但**不当他说的话**(turn 缺席,summary 不动)', () => {
    const state = { ...emptyDshFold(), summary: '上一句还在' }
    const out = foldDshEvent(state, ev('user/message', 10, userMessage(
      'background job job-7 (bash: pnpm test) finished completed. Read its output with job_output.',
      { kind: 'tool-jobs', form: 'notice', summary: 'bash pnpm test completed' },
    )))
    expect(out.notice).toEqual({ kind: 'job-done', summary: 'bash pnpm test completed' })
    expect(out.turn).toBeUndefined()
    expect(out.state.summary).toBe('上一句还在')
  })
})

describe('createDshSessionFeed:summary 随 turn/end 上报,回合列表可查', () => {
  function harness() {
    const applyEvent = vi.fn<(event: WorkbenchEvent) => void>()
    const feed = createDshSessionFeed({ applyEvent, setMetrics: vi.fn(), now: () => NOW_SEC })
    return { applyEvent, feed }
  }

  it('★turn/end 那条 done 事件带 summary;turn/start 那条 running 事件不清空它', () => {
    const { applyEvent, feed } = harness()
    feed.handleCreated('s1', '/tmp/x')
    feed.handleEvent('s1', ev('turn/start', 1))
    feed.handleEvent('s1', ev('user/message', 2, userMessage('把黄历接上')))
    feed.handleEvent('s1', ev('assistant/message', 3, assistantMessage([{ type: 'text', text: '黄历接上了,展示台已能显示。' }])))
    feed.handleEvent('s1', ev('turn/end', 4, { reason: { kind: 'completed' } }))

    expect(applyEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      agent: 'dsh', session_id: 's1', type: 'done', summary: '黄历接上了,展示台已能显示。',
    }))

    feed.handleEvent('s1', ev('turn/start', 5))
    expect(applyEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'running', summary: '黄历接上了,展示台已能显示。',
    }))
  })

  it('取不到文本的回合:done 事件不带 summary 字段(不编)', () => {
    const { applyEvent, feed } = harness()
    feed.handleCreated('s1')
    feed.handleEvent('s1', ev('turn/start', 1))
    feed.handleEvent('s1', ev('turn/end', 2, { reason: { kind: 'completed' } }))
    expect(applyEvent.mock.calls.at(-1)![0]).not.toHaveProperty('summary')
  })

  it('★turns():按时间顺序给 user/assistant 回合,带 ISO 时刻;limit 只取最后几条', () => {
    const { feed } = harness()
    feed.handleCreated('s1')
    feed.handleEvent('s1', ev('user/message', 1, userMessage('第一句')))
    feed.handleEvent('s1', ev('assistant/message', 2, assistantMessage([{ type: 'text', text: '回第一句' }])))
    feed.handleEvent('s1', ev('user/message', 3, userMessage('第二句')))
    feed.handleEvent('s1', ev('assistant/message', 4, assistantMessage([{ type: 'text', text: '回第二句' }], 2)))

    expect(feed.turns('s1', 20)).toEqual([
      { role: 'user', text: '第一句', at: NOW_ISO },
      { role: 'assistant', text: '回第一句', at: NOW_ISO },
      { role: 'user', text: '第二句', at: NOW_ISO },
      { role: 'assistant', text: '回第二句', at: NOW_ISO },
    ])
    expect(feed.turns('s1', 2)!.map(turn => turn.text)).toEqual(['第二句', '回第二句'])
  })

  it('不认识的会话 → undefined(HTTP 层据此 404);认识但还没说过话 → 空数组', () => {
    const { feed } = harness()
    expect(feed.turns('nobody', 20)).toBeUndefined()
    feed.handleCreated('s1')
    expect(feed.turns('s1', 20)).toEqual([])
  })

  it(`回合正文同样去代码块,单条截 ${TURN_TEXT_MAX} 字`, () => {
    const { feed } = harness()
    feed.handleCreated('s1')
    const text = `${'长'.repeat(TURN_TEXT_MAX + 10)}\n\`\`\`\ncode\n\`\`\``
    feed.handleEvent('s1', ev('assistant/message', 1, assistantMessage([{ type: 'text', text }])))
    const [turn] = feed.turns('s1', 1)!
    expect(turn!.text).toBe(`${'长'.repeat(TURN_TEXT_MAX)}…`)
  })

  it('会话没了(disposed)回合也跟着丢,不留僵尸', () => {
    const { feed } = harness()
    feed.handleCreated('s1')
    feed.handleEvent('s1', ev('user/message', 1, userMessage('x')))
    feed.handleDisposed('s1')
    expect(feed.turns('s1', 20)).toBeUndefined()
  })

  it('★与事项生命周期共存:onSessionEnd 触发时 summary 已经先经 applyEvent 写进去了(交付物要能拿到它)', () => {
    // butlerLifecycle 的 summaryOf 读的是 service 里那条会话此刻的 summary;顺序反了,交付物就只能写「会话已结束,去看对话」。
    const seen: { summaryAtEnd?: string | undefined, endKind?: string } = {}
    let latestSummary: string | undefined
    const feed = createDshSessionFeed({
      applyEvent: (event) => { latestSummary = event.summary },
      setMetrics: vi.fn(),
      now: () => NOW_SEC,
      onSessionEnd: (_sessionId, end) => { seen.summaryAtEnd = latestSummary; seen.endKind = end.kind },
    })
    feed.handleCreated('s1')
    feed.handleEvent('s1', ev('turn/start', 1))
    feed.handleEvent('s1', ev('assistant/message', 2, assistantMessage([{ type: 'text', text: '黄历接上了。' }])))
    feed.handleEvent('s1', ev('turn/end', 3, { reason: { kind: 'completed' } }))
    expect(seen).toEqual({ summaryAtEnd: '黄历接上了。', endKind: 'done' })
  })

  it('哨兵前缀的会话一律不认(同一个桶的边界)', () => {
    const { feed } = harness()
    feed.handleEvent('sentinel:w1', ev('user/message', 1, userMessage('x')))
    expect(feed.turns('sentinel:w1', 20)).toBeUndefined()
  })
})
