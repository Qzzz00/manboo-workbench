import { describe, expect, it } from 'vitest'
import { parseClaudeLine } from '../src/usage/claude.ts'
import { parseCodexFile } from '../src/usage/codex.ts'
import { parseDshSession } from '../src/usage/dsh.ts'

const CLAUDE_LINE = JSON.stringify({
  timestamp: '2026-08-24T10:58:06.797Z',
  cwd: '/Users/example/Documents/GitHub/desktop-workbench/.claude/worktrees/abc',
  requestId: 'req-1',
  message: {
    model: 'claude-fable-5',
    usage: {
      input_tokens: 2,
      output_tokens: 696,
      cache_creation_input_tokens: 17731,
      cache_read_input_tokens: 34658,
    },
  },
})

describe('parseClaudeLine', () => {
  it('取出四类 token、时间、归拢后的项目、模型', () => {
    expect(parseClaudeLine(CLAUDE_LINE, 'sess-1')).toEqual({
      ts: '2026-08-24T10:58:06.797Z',
      project: 'desktop-workbench',
      model: 'claude-fable-5',
      source: 'claude',
      input: 2,
      output: 696,
      cache_write: 17731,
      cache_read: 34658,
      session: 'sess-1',
      key: 'req-1',
    })
  })

  it('没有 usage 的行返回 undefined（用户消息、工具结果等）', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'user' }), 'sess-1')).toBeUndefined()
  })

  it('坏 JSON 返回 undefined 而不是抛错', () => {
    expect(parseClaudeLine('{ 不是 json', 'sess-1')).toBeUndefined()
  })
})

describe('parseCodexFile', () => {
  const file = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-08-24T09:44:32.491Z',
      payload: { cwd: '/Users/example/Documents/GitHub/KOUKOU', model: 'gpt-5' },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-24T09:45:00.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 },
        },
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-24T09:46:00.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 300, output_tokens: 40, total_tokens: 340 },
          last_token_usage: { input_tokens: 200, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 30 },
        },
      },
    }),
  ].join('\n')

  it('用本轮增量而不是累计值——累计求和会重复计数', () => {
    const records = parseCodexFile(file, 'sess-c')
    expect(records).toHaveLength(2)
    expect(records[0]?.input).toBe(100)
    expect(records[1]?.input).toBe(150)
    expect(records.reduce((sum, r) => sum + r.input, 0)).toBe(250)
  })

  it('项目取自文件头的 session_meta.cwd,并已归拢', () => {
    expect(parseCodexFile(file, 'sess-c')[0]?.project).toBe('KOUKOU')
  })

  /**
   * 口径回归(2026-08-26 真机):Codex 的 input_tokens **包含** cached_input_tokens
   * (15,416 条真实记录验证:total_tokens = input + output 且 cached ≤ input 恒成立),
   * 而 Claude 的 input_tokens 不含缓存读。不扣掉缓存,Codex 项目在「input+output」
   * 计费口径下被放大几十倍,把 Claude 项目(工作台)整个挤出排行榜。
   */
  it('input 扣掉缓存读部分,与 Claude 口径对齐;缓存读单独记账', () => {
    const second = parseCodexFile(file, 'sess-c')[1]
    expect(second?.input).toBe(150)
    expect(second?.cache_read).toBe(50)
  })

  /**
   * ★ 2026-10-02 运营同学 Air 那一版:同一轮的**回声**不再计第二遍。
   *
   * 真机上她那份 rollout 里成片出现这种成对的 `token_count`:后一条的 `last_token_usage`
   * 与前一条一字不差,`total_token_usage` 也一字不差 —— 那是同一轮被写了两遍,不是又烧了一轮。
   * `key` 那把尺子按**文件内序号**算,分不开它们,于是她那一格的数字虚高。
   * 判据是**累计值有没有动**:没动就是回声。
   */
  it('★累计值一个字没动 = 同一轮的回声,只计一次', () => {
    const echo = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-08-26T09:00:00.000Z', payload: { cwd: '/x' } }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-26T09:01:00.000Z',
        payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
        } },
      }),
      // 同一轮又写了一遍:累计值一字不差。
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-26T09:01:00.000Z',
        payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
        } },
      }),
      // 累计值动了:这才是真的下一轮。
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-26T09:02:00.000Z',
        payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 220, cached_input_tokens: 0, output_tokens: 25, total_tokens: 245 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 15 },
        } },
      }),
    ].join('\n')
    const records = parseCodexFile(echo, 'sess-echo')
    expect(records).toHaveLength(2)
    expect(records.reduce((sum, one) => sum + one.input, 0)).toBe(220)
  })

  it('老日志整块没有累计值时,行为与上一版相同(只能信序号那把尺子)', () => {
    const noTotals = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-08-26T09:00:00.000Z', payload: { cwd: '/x' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-08-26T09:01:00.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 7, output_tokens: 1 } } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-08-26T09:02:00.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 7, output_tokens: 1 } } } }),
    ].join('\n')
    expect(parseCodexFile(noTotals, 'sess-old')).toHaveLength(2)
  })

  it('缓存大于输入的脏数据收敛到 0,不出负数', () => {
    const dirty = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-08-25T09:00:00.000Z', payload: { cwd: '/x' } }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-25T09:01:00.000Z',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 99, output_tokens: 1 } } },
      }),
    ].join('\n')
    expect(parseCodexFile(dirty, 'sess-dirty')[0]?.input).toBe(0)
  })

  /**
   * 去重回归(2026-08-26):collector 对 Codex 是「文件变长就整份重解析」,记录若没有
   * key,同一会话每增长一次旧记录就重复计入一次。key 按会话内序号生成,重解析后稳定。
   */
  it('记录带稳定去重 key,整份重解析不会重复计数', () => {
    const first = parseCodexFile(file, 'sess-c')
    const second = parseCodexFile(file, 'sess-c')
    expect(first[0]?.key).toBeDefined()
    expect(first.map(r => r.key)).toEqual(second.map(r => r.key))
    expect(first[0]?.key).not.toBe(first[1]?.key)
  })

  /**
   * 回归(2026-08-25 真机):模型名原先从 session_meta.model 取,但 Codex 根本不在
   * 那里记——真机上 8.4B token 全部落进「(未知)」,模型页 100% 一格,等于没有。
   * 真正的位置是 turn_context.payload.model,而且**每轮可能变**(换模型/换 effort)。
   */
  it('模型名取自 turn_context,并且跟随每轮变化', () => {
    const withTurns = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-08-25T09:00:00.000Z',
        payload: { cwd: '/Users/example/Documents/GitHub/KOUKOU', model_provider: 'openai' },
      }),
      JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-08-25T09:00:01.000Z',
        payload: { model: 'gpt-5.6-sol', effort: 'high' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-25T09:01:00.000Z',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } } },
      }),
      JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-08-25T09:02:00.000Z',
        payload: { model: 'gpt-5.6-mini' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-25T09:03:00.000Z',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 20, output_tokens: 2 } } },
      }),
    ].join('\n')

    const records = parseCodexFile(withTurns, 'sess-t')
    expect(records.map(r => r.model)).toEqual(['gpt-5.6-sol', 'gpt-5.6-mini'])
  })

  it('turn_context 出现之前的用量记为未知,不编造模型名', () => {
    const early = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-08-25T09:00:00.000Z', payload: { cwd: '/x' } }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-25T09:01:00.000Z',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 1 } } },
      }),
    ].join('\n')
    expect(parseCodexFile(early, 'sess-e')[0]?.model).toBe('(未知)')
  })
})

/**
 * DSH 会话日志的真实形态(2026-09-15 真机取证 `~/.dsh/sessions/…/session.jsonl.zstd`,DSH 0.1.2-rc.1):
 * 用量只在 `assistant/message` 事件的 `data.usage` 里,字段是驼峰 `inputTokens / outputTokens /
 * cacheReadTokens / reasoningTokens / totalTokens`,时间是 `time`(epoch 毫秒),模型在
 * `data.message.source.model`。`assistant/chunk` 的 `data.chunk.usage` 是流式中间态,与 message 重复。
 * 原先的解析器按 Claude 的 `usage.input_tokens` 猜的,和真文件一条都对不上,已改写。
 */
const DSH_HEADER = JSON.stringify({ type: 'session', version: 0, id: 'session-aaaa', createdAt: 1789468204357, cwd: '/Users/example/Documents/GitHub/desktop-workbench', delegationDepth: 0 })
const DSH_CONTEXT = JSON.stringify({ type: 'request/context', seq: 12, time: 1789468204542, data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1000000 } })
/** model 传 null 表示 message.source 里没带模型(默认参数遇到 undefined 会被填回默认值,所以用 null)。 */
function dshMessage(seq: number, usage: Record<string, number>, model: string | null = 'deepseek-v4-flash'): string {
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time: 1789468206067,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [], source: model === null ? { kind: 'model' } : { kind: 'model', provider: 'deepseek-official', model }, id: `msg-${seq}` },
      usage,
    },
  })
}
const DSH_CHUNK = JSON.stringify({ type: 'assistant/chunk', seq: 100, time: 1789468206061, data: { chunk: { usage: { inputTokens: 9743, outputTokens: 231, cacheReadTokens: 128 } } } })

describe('parseDshSession(真实 DSH 事件格式)', () => {
  it('assistant/message 的 data.usage 记一条:毫秒时间转 ISO、驼峰字段对齐、缓存写为 0、去重键用消息 id', () => {
    const text = [DSH_HEADER, DSH_CONTEXT, dshMessage(188, { inputTokens: 9743, outputTokens: 231, totalTokens: 10102, cacheReadTokens: 128, reasoningTokens: 0 })].join('\n')
    const records = parseDshSession(text, 'session-aaaa', '--Users-ben-Documents-GitHub-desktop-workbench--')
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      ts: '2026-09-15T10:30:06.067Z',
      project: 'desktop-workbench',
      model: 'deepseek-v4-flash',
      source: 'dsh',
      input: 9743,
      output: 231,
      cache_read: 128,
      cache_write: 0,
      session: 'session-aaaa',
      // 去重键用**消息自己的 id**,不用 seq(2026-09-25 卡 U3 改):一条会话被上游从 0 代迁到 4 代时
      // seq 会重排,而 message.id 跨代不变 —— 这样迁移前后同一条消息只算一次。理由见 usage/dsh.ts 文件头。
      key: 'dsh:session-aaaa:msg-188',
    })
  })

  it('★取不到消息 id 时才退回 `v<代号>:<seq>`(带代号,免得两代不同的消息撞成同一个键)', () => {
    const noId = JSON.stringify({
      type: 'assistant/message', seq: 7, time: 1789468206067,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [], source: { kind: 'model', model: 'deepseek-flash' } }, usage: { inputTokens: 5, outputTokens: 1 } },
    })
    expect(parseDshSession([DSH_HEADER, noId].join('\n'), 's', '--x--', 0)[0]?.key).toBe('dsh:s:v0:7')
    expect(parseDshSession([DSH_HEADER, noId].join('\n'), 's', '--x--', 4)[0]?.key).toBe('dsh:s:v4:7')
  })

  it('项目优先取会话头的 cwd——目录名把横杠全编码掉了,desktop-workbench 会被还原成 desktop/workbench', () => {
    const text = [DSH_HEADER, dshMessage(1, { inputTokens: 1, outputTokens: 1 })].join('\n')
    expect(parseDshSession(text, 's', '--Users-ben-Documents-GitHub-desktop-workbench--')[0]?.project).toBe('desktop-workbench')
    // 没有会话头时只能退回目录名解码(横杠歧义无法消除,但总比一长串横杠强)
    const headless = dshMessage(1, { inputTokens: 1, outputTokens: 1 })
    expect(parseDshSession(headless, 's', '--Users-ben-Documents-GitHub-DouDou--')[0]?.project).toBe('DouDou')
  })

  it('assistant/chunk 的流式用量不计——它与随后的 message 是同一次调用', () => {
    const text = [DSH_HEADER, DSH_CHUNK, dshMessage(188, { inputTokens: 9743, outputTokens: 231, cacheReadTokens: 128 })].join('\n')
    const records = parseDshSession(text, 's', '--x--')
    expect(records).toHaveLength(1)
    expect(records[0]?.input).toBe(9743)
  })

  it('message 没带模型时用最近一条 request/context 的模型,再没有就「(未知)」', () => {
    const withContext = [DSH_HEADER, DSH_CONTEXT, dshMessage(2, { inputTokens: 1, outputTokens: 1 }, null)].join('\n')
    expect(parseDshSession(withContext, 's', '--x--')[0]?.model).toBe('deepseek-v4-flash')
    const bare = [DSH_HEADER, dshMessage(2, { inputTokens: 1, outputTokens: 1 }, null)].join('\n')
    expect(parseDshSession(bare, 's', '--x--')[0]?.model).toBe('(未知)')
  })

  it('只有会话头、没有用量的文件返回空数组;坏行与缺 time 的行跳过', () => {
    expect(parseDshSession(DSH_HEADER, 'sess-d', '--Users-ben--')).toEqual([])
    const noTime = JSON.stringify({ type: 'assistant/message', seq: 3, data: { message: {}, usage: { inputTokens: 5, outputTokens: 5 } } })
    const text = [DSH_HEADER, '{not json', noTime, '', dshMessage(4, { inputTokens: 7, outputTokens: 8 })].join('\n')
    const records = parseDshSession(text, 's', '--x--')
    expect(records.map(record => record.input)).toEqual([7])
  })
})
