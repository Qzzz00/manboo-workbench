// @vitest-environment node
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createUsageCollector, type UsageScanDiagnostic } from '../src/usage/collector.ts'

const homes: string[] = []
afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop() as string, { recursive: true, force: true })
})

function homeWithCodexFile(): { home: string, file: string, key: string } {
  const home = mkdtempSync(join(tmpdir(), 'usage-diagnostic-'))
  homes.push(home)
  const day = join(home, '.codex/sessions/2026/10/26')
  mkdirSync(day, { recursive: true })
  mkdirSync(join(home, '.claude/projects'), { recursive: true })
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const file = join(day, `rollout-2026-10-26T10-00-00-${id}.jsonl`)
  const line = JSON.stringify({ type: 'session_meta', payload: { cwd: '/synthetic/private-shape' } })
  writeFileSync(file, `${line}\n`)
  return { home, file, key: `codex:${id}` }
}

it('脱敏诊断能区分冷扫、稳态、追加、截短和新实例，不输出来源路径或正文', async () => {
  const { home, file } = homeWithCodexFile()
  const observed: UsageScanDiagnostic[] = []
  const collector = createUsageCollector({ home, onDiagnostic: row => observed.push(row) })
  await collector.refresh()
  await collector.refresh()
  appendFileSync(file, `${JSON.stringify({ type: 'turn_context', payload: { model: 'synthetic' } })}\n`)
  await collector.refresh()
  truncateSync(file, 8)
  await collector.refresh()
  const restarted = createUsageCollector({ home, onDiagnostic: row => observed.push(row) })
  await restarted.refresh()

  expect(observed).toHaveLength(5)
  // 第五轮是「新实例 + 账本还在」。账本只把已读偏移推进到**最后一个完整行**:这份文件
  // 截短后没有换行,落盘的偏移是 0,所以新实例把这 8 字节重放一遍(2026-10-28 第五轮,
  // 重放是为了半行写全了不漏;字节数与重启失忆时一样,账不再靠失忆)。聚合账已从账本恢复,
  // 重放解不出记录,不重复计入。
  expect(observed.map(row => [row.files, row.changed, row.bytes, row.rewinds])).toEqual([
    [1, 1, expect.any(Number), 0],
    [1, 0, 0, 0],
    [1, 1, expect.any(Number), 0],
    [1, 1, 8, 1],
    [1, 1, 8, 0],
  ])
  expect(observed[0]?.bytes).toBeGreaterThan(8)
  expect(observed[2]?.bytes).toBeGreaterThan(8)
  expect(observed.map(row => row.round)).toEqual([1, 2, 3, 4, 1])
  expect(observed[0]?.instance).toBe(observed[3]?.instance)
  expect(observed[4]?.instance).not.toBe(observed[0]?.instance)
  for (const row of observed) {
    expect(row.duration_ms).toBeGreaterThanOrEqual(0)
    expect(row.cpu_ms).toBeGreaterThanOrEqual(0)
    expect(row.concurrent).toBe(1)
  }
  expect(JSON.stringify(observed)).not.toMatch(/rollout|private-shape|aaaaaaaa/)
})
