import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readFirstLineBounded } from '../src/server/sessionSources.ts'
import { createCodexLineParser, parseCodexFile } from '../src/usage/codex.ts'
import { createUsageCollector } from '../src/usage/collector.ts'

const meta = JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/example/Documents/GitHub/desktop-workbench', source: 'cli', timestamp: '2026-09-11T10:00:00Z' } })
const turn = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6' } })
const count = (n: number): string => JSON.stringify({ timestamp: `2026-09-11T10:0${n}:00Z`, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } } } })

let tmp: string | undefined
afterEach(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  tmp = undefined
})

describe('Codex rollout 逐行解析(2026-09-11,1GB 文件撞字符串上限之后)', () => {
  it('逐行喂与整份喂结果一字不差', () => {
    const text = [meta, turn, count(1), count(2)].join('\n')
    const parser = createCodexLineParser('s1')
    for (const line of text.split('\n')) parser.push(line)
    expect(parser.records).toEqual(parseCodexFile(text, 's1'))
    expect(parser.records).toHaveLength(2)
    expect(parser.records[0]?.model).toBe('gpt-5.6')
    expect(parser.records[0]?.input).toBe(60)
  })

  it('一份读不了的 rollout 只让 codex 标 partial 并计数,其余文件照常入账', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'usage-codex-'))
    const day = join(tmp, '.codex/sessions/2026/09/11')
    mkdirSync(day, { recursive: true })
    mkdirSync(join(tmp, '.claude/projects'), { recursive: true })
    writeFileSync(join(day, 'rollout-2026-09-11T10-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'), [meta, turn, count(1)].join('\n'))
    const bad = join(day, 'rollout-2026-09-11T11-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl')
    writeFileSync(bad, [meta, count(2)].join('\n'))
    chmodSync(bad, 0o000)
    const collector = createUsageCollector({ home: tmp })
    await collector.refresh()
    const view = collector.view()
    expect('error' in view).toBe(false)
    if ('error' in view) return
    expect(view.sources.codex).toEqual({ status: 'partial', note: '1 份会话文件读不了,已跳过' })
    expect(collector.sessionTotals(['codex:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'])).toHaveProperty('codex:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    chmodSync(bad, 0o644)
  })
})

describe('会话源只读文件头一个窗口', () => {
  it('首行之后哪怕跟着几 MB 也只回首行', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'first-line-'))
    const file = join(tmp, 'r.jsonl')
    writeFileSync(file, `${meta}\n${'x'.repeat(3 * 1024 * 1024)}\n`)
    expect(await readFirstLineBounded(file, 64 * 1024)).toBe(meta)
  })

  it('首行比窗口还长就整段返回,由调用方当坏行处理', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'first-line-'))
    const file = join(tmp, 'r.jsonl')
    writeFileSync(file, `${'y'.repeat(100)}\n`)
    expect(await readFirstLineBounded(file, 10)).toBe('y'.repeat(10))
  })
})
