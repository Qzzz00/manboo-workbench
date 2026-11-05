/**
 * CLI 派活会话受信读回(2026-10-24,卡 1a):按登记 id 解析、不收路径、Kimi wire → 轮次、尚未同步=缺席。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { safeCliSessionId, findKimiCliWire, turnsFromKimiWire, readKimiCliSession } from '../src/server/cliSessionRead.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

describe('safeCliSessionId:形状闸', () => {
  it('正常 id 过;路径/点段/空不过', () => {
    expect(safeCliSessionId('session_54e05a40-2c52-40ba-bedb-a44f0d082177')).toBe(true)
    expect(safeCliSessionId('../etc/passwd')).toBe(false)
    expect(safeCliSessionId('a/b')).toBe(false)
    expect(safeCliSessionId('x')).toBe(false)
  })
})

describe('findKimiCliWire:按 id 在 CLI 会话目录里找 wire.jsonl(只下探两层)', () => {
  it('找到返回路径;没有/别家布局返回 undefined', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-cli-read-'))
    dirs.push(home)
    const dir = join(home, '.kimi-code', 'sessions', 'wd_x', 'session_abc-123')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'wire.jsonl'), '{}\n')
    expect(await findKimiCliWire(home, 'session_abc-123')).toBe(join(dir, 'wire.jsonl'))
    expect(await findKimiCliWire(home, 'session_nope')).toBeUndefined()
  })
})

describe('turnsFromKimiWire:桌面1.4与kimi-code两种写法都认;认不出的行跳过', () => {
  it('turn.prompt + append_message user/assistant(分片并入)', () => {
    const wire = [
      JSON.stringify({ type: 'turn.prompt', time: '2026-10-24T01:00:00Z', input: { content: '请只回复 QA_OK' } }),
      JSON.stringify({ type: 'context.append_message', time: '2026-10-24T01:00:01Z', message: { role: 'user', content: '补一句' } }),
      JSON.stringify({ type: 'context.append_message', time: '2026-10-24T01:00:02Z', message: { role: 'assistant', content: 'QA_OK' } }),
      JSON.stringify({ type: 'context.append_message', time: '2026-10-24T01:00:03Z', message: { role: 'assistant', content: ' 后结束' } }),
      'not json',
    ].join('\n')
    const turns = turnsFromKimiWire(wire)
    expect(turns.map(one => [one.k, one.text])).toEqual([
      ['ask', '请只回复 QA_OK'],
      ['ask', '补一句'],
      ['reply', 'QA_OK\n后结束'],
    ])
  })
})

describe('readKimiCliSession:文件缺席 = 尚未同步(undefined)', () => {
  it('有文件给轮次;没有给 undefined', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-cli-read2-'))
    dirs.push(home)
    expect(await readKimiCliSession(home, 'session_absent')).toBeUndefined()
    const dir = join(home, '.kimi', 'sessions', 'g', 'session_x1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'wire.jsonl'), JSON.stringify({ type: 'turn.prompt', input: { content: 'hi' } }) + '\n')
    const got = await readKimiCliSession(home, 'session_x1')
    expect(got?.turns).toEqual([{ k: 'ask', text: 'hi' }])
  })
})
