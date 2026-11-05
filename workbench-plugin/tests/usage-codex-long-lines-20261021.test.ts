/**
 * Codex 用量追读遇上**超长的一行**(2026-10-21 急修「8791 空转」)。
 *
 * 真机 `~/.codex/sessions` 9GB,单份 rollout 里一行(嵌着图片的工具输出)最长 21MB、超过 1MB 的成百上千行。
 * 原来的追读每到一块(64KB)就把「没换行的尾巴」与新块整段拼一遍、整段找换行、再整段复制一份 —— 一行有多长,
 * 这一行的代价就按长度的平方涨:一份 474MB 的文件切行要 44 秒。DSH 每次重启游标归零、首轮从头扫,
 * 进程就一连几分钟 100% CPU、RSS 在 200MB 到 900MB 之间来回跳,`/state` 要几秒。
 *
 * 钉三件事:
 *   ① 一行跨好几十块也照常计数,而且读得完(时限按「修之前要好几秒、修之后零点几秒」之间取);
 *   ② 跨两轮的超长半行:下一轮拼上,只计一次;
 *   ③ 解析之前的预筛不改结果:只有 session_meta / turn_context / token_count 三种行有用,
 *      别的行里**提到**这几个词也照旧不计;Claude 那边没有 `"usage"` 的行不可能带用量。
 *   ④ 字节上找词(`linesMentioning`):按先后、一行只出一次、末行没换行也算、多字节字原样。
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCodexLineParser } from '../src/usage/codex.ts'
import { createUsageCollector, linesMentioning } from '../src/usage/collector.ts'

const CWD = '/Users/example/Documents/GitHub/desktop-workbench'
const meta = JSON.stringify({ type: 'session_meta', payload: { cwd: CWD, source: 'cli', timestamp: '2026-10-21T10:00:00Z' } })
const turn = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6' } })
const count = (n: number): string => JSON.stringify({
  timestamp: `2026-10-21T10:0${n}:00Z`,
  type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, total_token_usage: { input_tokens: 100 * n, cached_input_tokens: 40 * n, output_tokens: 10 * n, total_tokens: 110 * n } } },
})
/** 一行嵌着「图片」的工具输出:`bytes` 字节上下,中间夹几个多字节字(块边界切在字中间也得拼得回来)。 */
const bigOutput = (bytes: number): string => JSON.stringify({
  timestamp: '2026-10-21T10:00:30Z',
  type: 'response_item',
  payload: { type: 'function_call_output', output: `图片:${'A'.repeat(bytes)}完` },
})
const SESSION = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const KEY = `codex:${SESSION}`

let tmp: string | undefined
afterEach(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  tmp = undefined
})

function rig(lines: readonly string[]) {
  tmp = mkdtempSync(join(tmpdir(), 'usage-codex-long-'))
  const day = join(tmp, '.codex/sessions/2026/10/21')
  mkdirSync(day, { recursive: true })
  mkdirSync(join(tmp, '.claude/projects'), { recursive: true })
  const file = join(day, `rollout-2026-10-21T10-00-00-${SESSION}.jsonl`)
  writeFileSync(file, `${lines.join('\n')}\n`)
  return { file, collector: createUsageCollector({ home: tmp }) }
}

describe('Codex 追读遇上超长的一行', () => {
  it('★一行 24MB 跨几百块:照常计数,而且两秒内读完(修之前这一行要好几秒)', async () => {
    const { collector } = rig([meta, turn, count(1), bigOutput(24 * 1024 * 1024), count(2)])
    const started = performance.now()
    await collector.refresh()
    const spent = performance.now() - started
    const totals = collector.sessionTotals([KEY])[KEY]
    expect(totals?.input).toBe(120)
    expect(totals?.output).toBe(20)
    expect(spent).toBeLessThan(2000)
  }, 30_000)

  it('★跨两轮的超长半行:下一轮拼上,只计一次', async () => {
    const half = count(2)
    const { file, collector } = rig([meta, turn, count(1)])
    appendFileSync(file, `${bigOutput(3 * 1024 * 1024)}\n${half.slice(0, 30)}`)
    await collector.refresh()
    expect(collector.sessionTotals([KEY])[KEY]?.input).toBe(60)
    appendFileSync(file, `${half.slice(30)}\n${count(3)}\n`)
    await collector.refresh()
    expect(collector.sessionTotals([KEY])[KEY]?.input).toBe(180)
  }, 30_000)

  it('预筛不改结果:别的行里提到 token_count 也不计;三种有用的行照认', () => {
    const parser = createCodexLineParser(SESSION)
    const mention = JSON.stringify({ type: 'response_item', payload: { type: 'message', content: '"type":"token_count" 只是一段话里提到' } })
    for (const line of [meta, turn, mention, count(1), bigOutput(1024)]) parser.push(line)
    expect(parser.records).toHaveLength(1)
    expect(parser.records[0]).toMatchObject({ model: 'gpt-5.6', input: 60, output: 10, cache_read: 40 })
    expect(parser.records[0]?.project).not.toBe('(未知)')
  })
})

describe('linesMentioning:字节上找词,只解码命中的行', () => {
  it('按先后、一行只出一次、末行没换行也算、多字节字原样', () => {
    const region = Buffer.from(['甲 token_count 又 turn_context', '乙 没有', 'session_meta 丙', '丁 token_count'].join('\n'))
    expect(linesMentioning(region, ['token_count', 'turn_context', 'session_meta'])).toEqual([
      '甲 token_count 又 turn_context', 'session_meta 丙', '丁 token_count',
    ])
  })

  it('一个都没提到 → 空;空区域 → 空', () => {
    expect(linesMentioning(Buffer.from('a\nb\n'), ['token_count'])).toEqual([])
    expect(linesMentioning(Buffer.alloc(0), ['token_count'])).toEqual([])
  })
})

describe('Claude 用量:没有 "usage" 的行先筛掉,结果不变', () => {
  it('超长的工具结果行不计,带 usage 的那几行照计', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'usage-claude-long-'))
    const dir = join(tmp, '.claude/projects/-Users-ben-Documents-GitHub-desktop-workbench')
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(tmp, '.codex/sessions'), { recursive: true })
    const call = (id: string): string => JSON.stringify({
      timestamp: '2026-10-21T10:00:00Z', cwd: CWD, requestId: id,
      message: { model: 'claude-opus-5-5', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } },
    })
    const toolResult = JSON.stringify({ timestamp: '2026-10-21T10:00:01Z', type: 'user', message: { content: `图片:${'B'.repeat(4 * 1024 * 1024)}` } })
    writeFileSync(join(dir, 'dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl'), `${[call('r1'), toolResult, call('r2')].join('\n')}\n`)
    const collector = createUsageCollector({ home: tmp })
    await collector.refresh()
    const key = 'claude:dddddddd-dddd-dddd-dddd-dddddddddddd'
    expect(collector.sessionTotals([key])[key]).toMatchObject({ input: 14, output: 6 })
  }, 30_000)
})
