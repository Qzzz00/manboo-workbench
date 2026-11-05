// @vitest-environment node
/**
 * `/state` 的开销守卫(2026-10-21 急修「8791 空转」)。
 *
 * 网页每秒打一次 `/state`,每一次都现组一整份。0.4.143 装上后整屏黑、「直接卡死了」那一回,
 * 根子在用量首扫(`usage-codex-long-lines-20261021.test.ts` 钉着),但每拍现组的那一份也是常驻的开销:
 * 0.4.142 在维护者那份数据上(隔离实例、9GB Codex 会话、197 张卡)稳态 `/state` 中位 90ms、一包 465,971 字节。
 *
 * 这里搭一份像样的场面(200 张卡、40 条会话、用量采集器读过一份带 2MB 长行的 Codex 会话),连打 60 次:
 *   ① 60 次的累计耗时低于 0.4.142 的 60 × 90ms;
 *   ② 每一包都小于 0.4.142 那一包;
 *   ③ 一包不随次数长(同一份场面打 60 次,最后一包与第一包一样大);
 *   ④ 会话表那一层每拍只算有限几次(不随卡数 / 会话数翻倍)。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createUsageCollector } from '../src/usage/collector.ts'

/** 0.4.142 在维护者那份数据上的实测(隔离实例,2026-10-21 20:37–20:40,稳态 3 分钟)。 */
const BASELINE_142_STATE_P50_MS = 90
const BASELINE_142_STATE_BYTES = 465_971
const ROUNDS = 60

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function codexHome(dir: string): void {
  const day = join(dir, '.codex/sessions/2026/10/21')
  mkdirSync(day, { recursive: true })
  mkdirSync(join(dir, '.claude/projects'), { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/example/Documents/GitHub/desktop-workbench' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'A'.repeat(2 * 1024 * 1024) } }),
    JSON.stringify({ timestamp: '2026-10-21T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10 }, total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } } }),
  ]
  writeFileSync(join(day, 'rollout-2026-10-21T10-00-00-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jsonl'), `${lines.join('\n')}\n`)
}

async function scene(): Promise<{ url: string, overlays: () => number }> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-state-guard-'))
  dirs.push(dir)
  codexHome(dir)
  let overlays = 0
  const service = createWorkbenchService({
    overlay: (views: readonly SessionView[]) => { overlays += 1; return views },
  })
  for (let i = 0; i < 40; i++) {
    service.applyEvent({ agent: i % 2 === 0 ? 'claude' : 'codex', session_id: `s-${i}`, type: i % 5 === 0 ? 'waiting' : 'running', ...(i % 5 === 0 ? { reason: 'permission_prompt' as const } : {}) })
  }
  const usage = createUsageCollector({ home: dir })
  await usage.refresh()
  let n = 0
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    usageIntervalMs: 0,
    usage,
    tasks: createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` }),
    paths: { home: dir },
  } as never)
  started.push(server)
  for (let i = 0; i < 200; i++) {
    await fetch(`${server.url}/task/create`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: `第 ${i} 件:${'写一段说明 '.repeat(8)}` }),
    })
  }
  return { url: server.url, overlays: () => overlays }
}

describe('/state 连打 60 次', () => {
  it('★累计耗时低于 0.4.142 的 60 × 90ms、每一包小于 0.4.142 那一包、一包不随次数长;会话表那一层每拍只算有限几次', async () => {
    const { url, overlays } = await scene()
    await (await fetch(`${url}/state`)).arrayBuffer()
    const before = overlays()
    const sizes: number[] = []
    const started = performance.now()
    for (let i = 0; i < ROUNDS; i++) {
      const res = await fetch(`${url}/state`)
      expect(res.status).toBe(200)
      sizes.push((await res.arrayBuffer()).byteLength)
    }
    const spent = performance.now() - started
    const perRound = (overlays() - before) / ROUNDS
    console.log(`[守卫] /state ×${ROUNDS}:累计 ${spent.toFixed(0)}ms、一包 ${sizes[0]} 字节、会话表每拍算 ${perRound.toFixed(1)} 次`)
    expect(spent).toBeLessThan(ROUNDS * BASELINE_142_STATE_P50_MS)
    expect(Math.max(...sizes)).toBeLessThan(BASELINE_142_STATE_BYTES)
    expect(sizes[sizes.length - 1]).toBe(sizes[0])
    expect(perRound).toBeLessThanOrEqual(6)
  }, 120_000)
})
