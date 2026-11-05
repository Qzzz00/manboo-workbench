// @vitest-environment node
/**
 * DSH 会话文件从 0 代升到 4 代(卡 U3,2026-09-25;评估 docs/评估-DSH升级到0.1.7-2026-09-25.md 第七节 U3)。
 *
 * 三件事钉在这里:
 * 1. **同一个会话目录里有两代时只读数字最高的那一份**(`pickLatestGeneration`)。
 *    只认老名字 → 升级后新用量静默归零;两代全读 → 同一批消息算两遍(迁移会重排 seq)。
 * 2. **会话头两代都读得懂**,而且 4 代头上 `origin: 'subagent'` + `parentSession` 能认出子代理。
 * 3. **迁移演练**:一条会话被迁到 4 代之后,读出来的用量与迁移前一致 —— 不归零、也不翻倍。
 *
 * 用的 V4 文件不是手写的:`tests/fixtures/dsh-session-v4/` 里那两份是用
 * `~/.dsh/runtime-next` 里**上游 0.1.7-rc.2 自己的编解码器**生成、再用**上游自己的逐行准入与
 * 关系校验器**验过的(过程与出处见那个目录的 README.md 与 生成脚本.mjs)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  dshSubagentOf,
  parseDshSessionHeader,
  parseSessionLogName,
  pickLatestGeneration,
} from '../src/dshSessionFile.ts'
import type { SessionMetrics } from '../src/protocol.ts'
import { createDshSessionFeed } from '../src/server/dshSessionFeed.ts'
import { parseDshSession } from '../src/usage/dsh.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures/dsh-session-v4')
const v4 = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const PROJECT_DIR = '--Users-ben-Documents-GitHub-desktop-workbench--'

describe('哪一代(parseSessionLogName / pickLatestGeneration)', () => {
  it('★老名字是 0 代,`session.v4.jsonl` 是 4 代;压缩与明文都认', () => {
    expect(parseSessionLogName('session.jsonl')).toEqual({ version: 0, compressed: false, name: 'session.jsonl' })
    expect(parseSessionLogName('session.jsonl.zstd')).toEqual({ version: 0, compressed: true, name: 'session.jsonl.zstd' })
    expect(parseSessionLogName('session.v4.jsonl')).toEqual({ version: 4, compressed: false, name: 'session.v4.jsonl' })
    expect(parseSessionLogName('session.v4.jsonl.zstd')).toEqual({ version: 4, compressed: true, name: 'session.v4.jsonl.zstd' })
    // 以后再升一代也不用改代码
    expect(parseSessionLogName('session.v12.jsonl.zstd')?.version).toBe(12)
  })

  it('★不规范的名字一律不认(照上游 CANONICAL_LOG_FILENAME:`.v0`、大写、前导零、临时名都不是已提交代际)', () => {
    for (const name of [
      'session.v0.jsonl', // .v0 不是规范名(0 代就叫 session.jsonl)
      'session.V4.jsonl', // 大写
      'session.v04.jsonl', // 前导零
      'session.v4.jsonl.tmp', // 临时文件
      'session.lock', // 锁文件:只读纪律里明令不碰
      'session.v4.json',
      'sessions.v4.jsonl',
      'session.jsonl.gz',
      '',
    ]) expect(parseSessionLogName(name), name).toBeUndefined()
  })

  it('★两代并存时只挑数字最高的那一份(旧文件当自带备份,一个字节不碰)', () => {
    // 上游承诺「迁移不移动、不覆盖、不删除任何已提交代际」,所以真机上就是这个样子
    expect(pickLatestGeneration(['session.jsonl.zstd', 'session.v4.jsonl.zstd'])?.name).toBe('session.v4.jsonl.zstd')
    expect(pickLatestGeneration(['session.v4.jsonl.zstd', 'session.jsonl.zstd'])?.name).toBe('session.v4.jsonl.zstd')
    // 只有老的(还没被打开过、没迁移的会话):照旧读老的,不是读不到
    expect(pickLatestGeneration(['session.jsonl.zstd'])?.version).toBe(0)
    // 同一代里既有压缩又有明文:取压缩那份(生产形态)
    expect(pickLatestGeneration(['session.v4.jsonl', 'session.v4.jsonl.zstd'])?.compressed).toBe(true)
    // 一份规范名都没有
    expect(pickLatestGeneration(['session.lock', 'whatever.txt'])).toBeUndefined()
    expect(pickLatestGeneration([])).toBeUndefined()
  })
})

describe('会话头(parseDshSessionHeader)两代都读得懂', () => {
  it('★4 代真文件的头:version 4、cwd 在、不是子代理', () => {
    const header = parseDshSessionHeader(v4('session.v4.jsonl').split('\n')[0] as string)
    expect(header?.version).toBe(4)
    expect(header?.id).toBe('session-u3main')
    expect(header?.cwd).toBe('/Users/example/Documents/GitHub/desktop-workbench')
    expect(dshSubagentOf(header)).toBeUndefined()
  })

  it('★0 代的头没有 version 字段 → 记 0(不当坏数据)', () => {
    const header = parseDshSessionHeader(JSON.stringify({ type: 'session', id: 'session-old', createdAt: 1789468204357, cwd: '/Users/example/x' }))
    expect(header).toEqual({ id: 'session-old', version: 0, cwd: '/Users/example/x' })
  })

  it('不是会话头的那一行 / 解不开的行 → undefined,绝不抛', () => {
    expect(parseDshSessionHeader('{"type":"turn/start","seq":0}')).toBeUndefined()
    expect(parseDshSessionHeader('这不是 JSON')).toBeUndefined()
    expect(parseDshSessionHeader('[]')).toBeUndefined()
    expect(parseDshSessionHeader('')).toBeUndefined()
  })
})

describe('认 DSH 子代理(dshSubagentOf)', () => {
  it('★4 代真文件里的子代理:origin=subagent + parentSession 两个都在才算', () => {
    const header = parseDshSessionHeader(v4('subagent.session.v4.jsonl').split('\n')[0] as string)
    expect(header?.origin).toBe('subagent')
    expect(header?.delegationDepth).toBe(1)
    expect(dshSubagentOf(header)).toEqual({ id: 'session-u3sub', parent: 'session-u3main' })
  })

  it('★只有 parentSession(续接 / 开支线分叉出来的)**不算**子代理', () => {
    // parentSession 自己只说明「从谁那儿分叉来的」,不等于「是谁派出去的一项后台任务」;
    // origin 才是上游给子代理的标记。少了这一条,他一开支线就会凭空多出一项「后台任务」。
    expect(dshSubagentOf({ version: 4, id: 'session-b', parentSession: 'session-a' })).toBeUndefined()
  })

  it('只有 origin、没有 parentSession → 不算(挂不到任何父会话上)', () => {
    expect(dshSubagentOf({ version: 4, id: 'session-b', origin: 'subagent' })).toBeUndefined()
  })

  it('父亲就是自己 / 没有头 → 不算(防自挂成自己的子任务)', () => {
    expect(dshSubagentOf({ version: 4, id: 'session-a', origin: 'subagent', parentSession: 'session-a' })).toBeUndefined()
    expect(dshSubagentOf(undefined)).toBeUndefined()
  })
})

describe('用量解析对 4 代真文件(parseDshSession)', () => {
  it('★两段模型回答的用量、模型名、项目归属都对;工具结果与系统消息不计', () => {
    const records = parseDshSession(v4('session.v4.jsonl'), 'session-u3main', PROJECT_DIR, 4)
    // 只有两条 assistant/message 带 usage;tool/result(4 代的 tool 角色)、
    // tool-jobs 的 notice、time-context 那条都不是用量记录
    expect(records).toHaveLength(2)
    expect(records.map(r => r.model)).toEqual(['deepseek-flash', 'deepseek-flash'])
    expect(records.map(r => r.project)).toEqual(['desktop-workbench', 'desktop-workbench'])
    expect(records.map(r => r.source)).toEqual(['dsh', 'dsh'])
    expect(records.map(r => [r.input, r.output, r.cache_read, r.cache_write])).toEqual([[100, 10, 0, 0], [200, 20, 1000, 0]])
    expect(records.map(r => r.ts)).toEqual(['2026-09-15T10:30:11.357Z', '2026-09-15T10:30:20.357Z'])
  })

  it('★去重键用消息自己的 id,不用 seq —— 这样一条会话被迁移后不会重复计入', () => {
    const records = parseDshSession(v4('session.v4.jsonl'), 'session-u3main', PROJECT_DIR, 4)
    expect(records.map(r => r.key)).toEqual(['dsh:session-u3main:msg-asst-1', 'dsh:session-u3main:msg-asst-2'])
  })

  it('子代理会话自己的用量照常记(它就是一条普通会话)', () => {
    const records = parseDshSession(v4('subagent.session.v4.jsonl'), 'session-u3sub', PROJECT_DIR, 4)
    expect(records).toHaveLength(1)
    expect([records[0]?.input, records[0]?.output]).toEqual([30, 5])
    expect(records[0]?.key).toBe('dsh:session-u3sub:msg-sub-a')
  })
})

describe('把 4 代真事件流喂进 feed(卡 U3)', () => {
  /** 夹具第一行是会话头,其余每行一条事件。 */
  function eventsOf(file: string): { header: Record<string, unknown>, events: { type: string, seq?: number, data?: unknown }[] } {
    const [head, ...rest] = v4(file).split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
    return { header: head as Record<string, unknown>, events: rest as unknown as { type: string, seq?: number, data?: unknown }[] }
  }

  it('★「改了 n 个文件」:4 代的 tool/call 形状没变(callId / name / arguments),照旧数得出 1 个', () => {
    const setMetrics = vi.fn<(id: string, metrics: SessionMetrics) => void>()
    const feed = createDshSessionFeed({ applyEvent: vi.fn(), setMetrics, now: () => 1_789_468_204 })
    const { header, events } = eventsOf('session.v4.jsonl')
    feed.handleCreated('s-1', { cwd: header.cwd as string })
    for (const event of events) feed.handleEvent('s-1', event)
    expect(setMetrics).toHaveBeenCalledWith('s-1', expect.objectContaining({ files_changed: 1 }))
  })

  it('★整份流喂完:回合只有人那一句 + 她答的两段(notice、时间上下文、tool 角色结果都不在)', () => {
    const feed = createDshSessionFeed({ applyEvent: vi.fn(), setMetrics: vi.fn(), now: () => 1_789_468_204 })
    const { header, events } = eventsOf('session.v4.jsonl')
    feed.handleCreated('s-1', { cwd: header.cwd as string })
    for (const event of events) feed.handleEvent('s-1', event)
    expect(feed.turns('s-1', 50)!.map(turn => turn.role)).toEqual(['user', 'assistant', 'assistant'])
    // 4 代的工具结果是一等 `tool` 角色消息(V3 那个 tool-result 包装块已退役);它走的是
    // `tool/result` 事件,本来就不该变成一个回合 —— 这一条把它钉住。
    expect(events.some(event => event.type === 'tool/result')).toBe(true)
    expect(feed.turns('s-1', 50)!.some(turn => turn.text.includes('wrote 1 file'))).toBe(false)
  })

  it('★子代理那份流喂完:feed 从会话头认出它的父亲', () => {
    const feed = createDshSessionFeed({ applyEvent: vi.fn(), setMetrics: vi.fn(), now: () => 1_789_468_204 })
    const { header } = eventsOf('subagent.session.v4.jsonl')
    feed.handleCreated(header.id as string, {
      cwd: header.cwd as string,
      origin: header.origin as string,
      parentSession: header.parentSession as string,
    })
    expect(feed.parentOf('session-u3sub')).toBe('session-u3main')
  })
})

describe('★迁移演练:同一条会话从 0 代到 4 代,用量不归零、也不翻倍', () => {
  /**
   * 照真形态造同一条会话的 0 代样子:seq 与 4 代**不一样**(上游 v1→v2 把 assistant/chunk
   * 并进 message 少了行,v3→v4 的迁移阶段自己从 0 发号),但两代里同一条消息的 `id` 一样。
   * 这个 seq 差就是「两代全读会算两遍」的根源,也是去重键改用 message.id 的理由。
   */
  const legacy = [
    JSON.stringify({ type: 'session', id: 'session-u3main', createdAt: 1789468204357, cwd: '/Users/example/Documents/GitHub/desktop-workbench' }),
    JSON.stringify({ type: 'assistant/chunk', seq: 7, time: 1789468211000, data: { chunk: {} } }),
    JSON.stringify({ type: 'assistant/message', seq: 8, time: 1789468211357, data: { turn: 1, step: 1, message: { id: 'msg-asst-1', role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 0, reasoningTokens: 0 } } }),
    JSON.stringify({ type: 'assistant/message', seq: 21, time: 1789468220357, data: { turn: 2, step: 1, message: { id: 'msg-asst-2', role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: { inputTokens: 200, outputTokens: 20, totalTokens: 1220, cacheReadTokens: 1000, reasoningTokens: 0 } } }),
  ].join('\n') + '\n'

  it('★迁移前后同一条会话的数字一致(0 代读出来的 = 4 代读出来的)', () => {
    const before = parseDshSession(legacy, 'session-u3main', PROJECT_DIR, 0)
    const after = parseDshSession(v4('session.v4.jsonl'), 'session-u3main', PROJECT_DIR, 4)
    const total = (rows: ReturnType<typeof parseDshSession>) =>
      rows.reduce((sum, r) => ({ input: sum.input + r.input, output: sum.output + r.output, cache_read: sum.cache_read + r.cache_read }), { input: 0, output: 0, cache_read: 0 })
    expect(total(after)).toEqual(total(before))
    expect(total(after)).toEqual({ input: 300, output: 30, cache_read: 1000 })
  })

  it('★两代的 seq 真的不一样(所以 seq 当不了跨代去重键)', () => {
    const legacySeqs = legacy.split('\n').filter(l => l.includes('assistant/message')).map(l => JSON.parse(l).seq)
    const v4Seqs = v4('session.v4.jsonl').split('\n').filter(l => l.startsWith('{"type":"assistant/message"')).map(l => JSON.parse(l).seq)
    expect(legacySeqs).toEqual([8, 21])
    expect(v4Seqs).not.toEqual(legacySeqs)
  })

  it('★迁移中途两代都被读到过也不会翻倍:去重键逐字相同', () => {
    const before = parseDshSession(legacy, 'session-u3main', PROJECT_DIR, 0)
    const after = parseDshSession(v4('session.v4.jsonl'), 'session-u3main', PROJECT_DIR, 4)
    expect(after.map(r => r.key)).toEqual(before.map(r => r.key))
  })
})
