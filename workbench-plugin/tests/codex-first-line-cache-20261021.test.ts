/**
 * 项目区认 Codex 会话归属时**首行读一次就记住**(2026-10-21 急修「8791 空转」)。
 *
 * 项目区 30 秒扫一轮,每一轮把 `~/.codex/sessions` 下每一份 rollout 的开头读 64KB 取首行(cwd 在那里)——
 * 维护者那台 1099 份,一轮 70MB,常年每秒两三 MB 的读盘。rollout 只往后追加,首行写下就不会变。
 *
 * 钉四件事:
 *   ① 首行完整读到过 → 之后文件变长也不再读,照回那一行;
 *   ② 首行还没写完(窗口里没换行、文件也没到窗口那么大)→ 不记,下一次照读;
 *   ③ 文件变短(被另起一份同名文件)→ 重读;
 *   ④ 文件没了 → 照旧抛(调用方按坏行算),也不留着那一条;
 *   ⑤ 记下来的是收过的那几格(首行平均 22KB,原样记一千多份是 25MB),会话归属算出来一模一样。
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexSessionCwds, createFirstLineCache, keepSessionMetaFields, readFirstLineBounded } from '../src/server/sessionSources.ts'

let tmp: string | undefined
afterEach(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  tmp = undefined
})

function file(content: string): string {
  tmp = mkdtempSync(join(tmpdir(), 'first-line-cache-'))
  const path = join(tmp, 'rollout.jsonl')
  writeFileSync(path, content)
  return path
}

describe('首行读一次就记住', () => {
  it('★首行完整读到过 → 文件变长也不再读', async () => {
    const path = file('{"type":"session_meta","payload":{"cwd":"/a"}}\n{"x":1}\n')
    let reads = 0
    const cache = createFirstLineCache({ windowBytes: 64 * 1024, onRead: () => { reads += 1 } })
    expect(await cache.read(path)).toBe('{"type":"session_meta","payload":{"cwd":"/a"}}')
    appendFileSync(path, '{"x":2}\n'.repeat(100))
    expect(await cache.read(path)).toBe('{"type":"session_meta","payload":{"cwd":"/a"}}')
    expect(reads).toBe(1)
  })

  it('首行还没写完 → 不记,写完了再读到整行', async () => {
    const path = file('{"type":"session_meta","payl')
    let reads = 0
    const cache = createFirstLineCache({ windowBytes: 64 * 1024, onRead: () => { reads += 1 } })
    expect(await cache.read(path)).toBe('{"type":"session_meta","payl')
    appendFileSync(path, 'oad":{"cwd":"/b"}}\n')
    expect(await cache.read(path)).toBe('{"type":"session_meta","payload":{"cwd":"/b"}}')
    expect(reads).toBe(2)
  })

  it('首行比窗口还长 → 截断的那一段也记住(再读也是同一段)', async () => {
    const path = file(`${'y'.repeat(100)}\n`)
    let reads = 0
    const cache = createFirstLineCache({ windowBytes: 10, onRead: () => { reads += 1 } })
    expect(await cache.read(path)).toBe('y'.repeat(10))
    expect(await cache.read(path)).toBe('y'.repeat(10))
    expect(reads).toBe(1)
  })

  it('文件变短(另起一份同名文件)→ 重读;文件没了 → 照旧抛', async () => {
    const path = file('{"type":"session_meta","payload":{"cwd":"/long/long/long"}}\n{"x":1}\n')
    const cache = createFirstLineCache({ windowBytes: 64 * 1024 })
    expect(await cache.read(path)).toContain('/long/long/long')
    writeFileSync(path, '{"type":"session_meta","payload":{"cwd":"/c"}}\n')
    expect(await cache.read(path)).toBe('{"type":"session_meta","payload":{"cwd":"/c"}}')
    rmSync(path)
    await expect(cache.read(path)).rejects.toThrow()
  })
})

describe('记下来的是收过的那几格,会话归属算出来一模一样', () => {
  it('★收过与原样:codexSessionCwds 的结果相同;没用的字段不留', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'first-line-keep-'))
    const lines = [
      JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id: 'x', cwd: '/a', timestamp: '2026-10-21T10:00:00Z', source: 'cli', base_instructions: { text: 'z'.repeat(30_000) } } }),
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/b', source: 'exec' } }),
      JSON.stringify({ type: 'session_meta', payload: { source: 'vscode' } }),
      JSON.stringify({ type: 'response_item', payload: { cwd: '/c' } }),
      '{"type":"session_meta","payl',
    ]
    const files = lines.map((line, i) => { const path = join(tmp as string, `r${i}.jsonl`); writeFileSync(path, `${line}\n`); return path })
    const listFiles = async () => files
    const raw = await codexSessionCwds('', { listFiles, readFirstLine: file => readFirstLineBounded(file, 64 * 1024) })
    const cache = createFirstLineCache({ windowBytes: 64 * 1024, keep: keepSessionMetaFields })
    const kept = await codexSessionCwds('', { listFiles, readFirstLine: file => cache.read(file) })
    const again = await codexSessionCwds('', { listFiles, readFirstLine: file => cache.read(file) })
    expect(kept).toEqual(raw)
    expect(again).toEqual(raw)
    expect(keepSessionMetaFields(lines[0] as string).length).toBeLessThan(200)
  })
})
