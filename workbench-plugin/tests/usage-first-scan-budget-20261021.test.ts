/**
 * 用量首扫的**耗时与分配上限**(2026-10-21 急修「8791 空转」的守卫)。
 *
 * DSH 每次重启,用量游标都从零开始,首轮要把 `~/.codex/sessions` 与 `~/.claude/projects` 从头扫一遍
 * (维护者那台 9.7GB + 2GB,一行最长 21MB)。原来切行时尾巴每块整段拼一遍、整段复制一份,
 * 一行多长代价就按平方涨:那份数据上扫一遍要搬 558GB 缓冲,首扫 166 秒、CPU 300 秒、峰值 1.6GB。
 *
 * 这里造一份小号的同款数据(12 份 Codex 会话共约 48MB、每份夹着两行 1.5MB 的「图片」,4 份 Claude 会话),
 * 首轮扫一遍,钉:
 *   ① 切行拼出来 / 复制出来的字节(`Buffer.concat` + `Buffer.from` 的产出)不超过数据总量的 2 倍 —— 线性;
 *      老写法在这份数据上是几十倍;
 *   ② 首轮 3 秒内扫完、第二轮(没有新增)0.5 秒内、几乎不再分配;
 *   ③ 计数对:每份 Codex 两轮 token_count、每份 Claude 三条 usage。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUsageCollector } from '../src/usage/collector.ts'

const CODEX_FILES = 12
const CLAUDE_FILES = 4
const LONG_LINE_BYTES = 1_500_000
/** 首轮扫完的时限(毫秒)。新写法本机约零点几秒;老写法在这份数据上要好几秒到十几秒。 */
const FIRST_SCAN_MS = 3000
/** 切行拼 / 复制出来的字节,最多是数据总量的几倍。 */
const ALLOC_FACTOR = 2

let tmp: string | undefined
afterEach(() => {
  vi.restoreAllMocks()
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  tmp = undefined
})

function corpus(): { home: string, bytes: number } {
  tmp = mkdtempSync(join(tmpdir(), 'usage-first-scan-'))
  let bytes = 0
  const write = (path: string, lines: readonly string[]): void => {
    const text = `${lines.join('\n')}\n`
    writeFileSync(path, text)
    bytes += Buffer.byteLength(text)
  }
  for (let i = 0; i < CODEX_FILES; i++) {
    const day = join(tmp, `.codex/sessions/2026/10/${String(10 + (i % 3)).padStart(2, '0')}`)
    mkdirSync(day, { recursive: true })
    const id = `${String(i).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`
    const image = (n: number): string => JSON.stringify({ timestamp: '2026-10-21T10:00:00Z', type: 'response_item', payload: { type: 'function_call_output', output: `图${n}:${'A'.repeat(LONG_LINE_BYTES)}` } })
    const count = (n: number): string => JSON.stringify({ timestamp: `2026-10-21T10:0${n}:00Z`, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, total_token_usage: { input_tokens: 100 * n, cached_input_tokens: 40 * n, output_tokens: 10 * n, total_tokens: 110 * n } } } })
    write(join(day, `rollout-2026-10-21T10-00-00-${id}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/example/Documents/GitHub/desktop-workbench' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6' } }),
      image(1), count(1),
      ...Array.from({ length: 200 }, (_, k) => JSON.stringify({ type: 'response_item', payload: { type: 'message', content: `第 ${k} 句话:${'说'.repeat(200)}` } })),
      image(2), count(2),
    ])
  }
  const project = join(tmp, '.claude/projects/-Users-ben-Documents-GitHub-desktop-workbench')
  mkdirSync(project, { recursive: true })
  for (let i = 0; i < CLAUDE_FILES; i++) {
    const call = (n: number): string => JSON.stringify({ timestamp: '2026-10-21T10:00:00Z', cwd: '/Users/example/Documents/GitHub/desktop-workbench', requestId: `r-${i}-${n}`, message: { model: 'claude-opus-5-5', usage: { input_tokens: 7, output_tokens: 3 } } })
    const tool = JSON.stringify({ timestamp: '2026-10-21T10:00:01Z', type: 'user', message: { content: `截图:${'B'.repeat(LONG_LINE_BYTES)}` } })
    write(join(project, `${String(i).padStart(8, '0')}-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl`), [call(1), tool, call(2), tool, call(3)])
  }
  return { home: tmp, bytes }
}

/** 数 `Buffer.concat` 与 `Buffer.from` 产出的字节(切行拼尾巴、复制尾巴都走这两处)。 */
function countCopies(): { bytes: () => number } {
  let total = 0
  const concat = Buffer.concat.bind(Buffer)
  const from = Buffer.from.bind(Buffer) as (...args: unknown[]) => Buffer
  vi.spyOn(Buffer, 'concat').mockImplementation(((list: readonly Uint8Array[], length?: number) => {
    const out = concat(list, length)
    total += out.length
    return out
  }) as typeof Buffer.concat)
  vi.spyOn(Buffer, 'from').mockImplementation(((...args: unknown[]) => {
    const out = from(...args)
    total += out.length
    return out
  }) as typeof Buffer.from)
  return { bytes: () => total }
}

describe('用量首扫的耗时与分配上限', () => {
  it('★首轮:拼 / 复制出来的字节不超过数据总量的 2 倍、3 秒内扫完;第二轮几乎不再分配;计数对', async () => {
    const { home, bytes } = corpus()
    const collector = createUsageCollector({ home })
    const copies = countCopies()

    const started = performance.now()
    await collector.refresh()
    const firstMs = performance.now() - started
    const firstCopied = copies.bytes()

    const again = performance.now()
    await collector.refresh()
    const secondMs = performance.now() - again
    const secondCopied = copies.bytes() - firstCopied
    vi.restoreAllMocks()

    expect(firstCopied).toBeLessThanOrEqual(bytes * ALLOC_FACTOR)
    expect(firstMs).toBeLessThan(FIRST_SCAN_MS)
    expect(secondCopied).toBeLessThan(64 * 1024)
    expect(secondMs).toBeLessThan(500)

    const view = collector.view()
    expect('error' in view).toBe(false)
    if ('error' in view) return
    const sum = (source: string): number => view.days.reduce((acc, day) => acc + (day.by_source[source]?.input ?? 0), 0)
    expect(sum('codex')).toBe(CODEX_FILES * 2 * 60)
    expect(sum('claude')).toBe(CLAUDE_FILES * 3 * 7)
  }, 60_000)
})
