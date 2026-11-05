// @vitest-environment node
/**
 * 诊断包概要里带上「导出这份包的那个进程」的内存与事件循环(2026-10-19,卡「插件内存增长与 GC 抖动」)。
 * 单独一份用例文件:`diag-pack.test.ts` 同期有别的卡在改,少撞。
 */
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { nodeDiagIo } from '../src/server/diagnostics/io.ts'
import { stageDiagPackage, type DiagPackDeps } from '../src/server/diagnostics/pack.ts'
import type { ProcessHealthView } from '../src/protocol.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const PROCESS: ProcessHealthView = {
  rss_mb: 412.3, heap_used_mb: 180, heap_total_mb: 260, heap_limit_mb: 4288, external_mb: 12.5,
  up_sec: 4 * 86_400 + 20 * 3600, started_at: '2026-10-14T06:00:00.000Z',
  loop_p50_ms: 1.2, loop_p99_ms: 2100, loop_max_ms: 3400, sampled_at: '2026-10-19T02:00:00.000Z',
}

function deps(process?: DiagPackDeps['process']): DiagPackDeps {
  const home = temp('wb-diag-process-home-')
  const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
  mkdirSync(`${paths.dshHome}/workbench`, { recursive: true })
  const io = nodeDiagIo(nodeSetupIo())
  return {
    // 外部命令(sw_vers / log show …)一律不真跑:这份用例只看概要里 process 那一格,真跑 `log show` 要十几秒。
    io: { ...io, exec: async () => ({ ok: false, code: 1, out: '' }) },
    paths,
    now: () => Date.parse('2026-10-19T02:15:30.000Z'),
    pluginVersion: '0.4.138',
    snapshots: [],
    ...(process === undefined ? {} : { process }),
  }
}

async function summaryOf(input: DiagPackDeps): Promise<Record<string, unknown>> {
  const stage = temp('wb-diag-process-stage-')
  await stageDiagPackage(input, stage)
  return JSON.parse(readFileSync(join(stage, '概要.json'), 'utf8')) as Record<string, unknown>
}

describe('概要.json · process 那一格', () => {
  it('接了采样器:原样带上(rss / heap / 上限 / 起了多久 / 事件循环)', async () => {
    const summary = await summaryOf(deps(() => PROCESS))
    expect(summary.process).toEqual(PROCESS)
  })

  it('没接采样器:整格缺席,不编', async () => {
    const summary = await summaryOf(deps())
    expect(summary).not.toHaveProperty('process')
  })

  it('采样器答 undefined(取不到)或抛了:整格缺席,包照样出', async () => {
    expect(await summaryOf(deps(() => undefined))).not.toHaveProperty('process')
    expect(await summaryOf(deps(() => { throw new Error('没了') }))).not.toHaveProperty('process')
  })
})
