// @vitest-environment node
/**
 * 探 8792 要分清「它没回」与「我自己慢得等不到回」(2026-10-19,卡「插件内存增长与 GC 抖动」)。
 *
 * 10-19 真机:插件进程一直在做全量回收,事件循环一卡几秒,`AbortSignal.timeout(1500)` 到点时
 * /health 其实已经回了;12 次误报「语音后端探不到了」。钉的是:
 * - 超时 + 本进程事件循环 p99 高于探测超时 → 沿用上一次的结论,不翻成「没在跑」;
 * - 超时 + 事件循环正常 → 照旧「没在跑」(真没回);
 * - 连接被拒(不是超时)→ 不管自己慢不慢都是「没在跑」;
 * - 没有上一次时只能按「没在跑」;
 * - 那一行日志 10 分钟一次。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUTLER_PROBE_TIMEOUT_MS, BUTLER_SELF_SLOW_LOG_EVERY_MS, BUTLER_SELF_SLOW_LOG_TAG, createButlerService,
} from '../src/server/butler.ts'

async function configFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'butler-slow-test-'))
  const file = join(dir, 'butler.json')
  await writeFile(file, JSON.stringify({ version: 1, port: 18792 }))
  return file
}

type Answer = 'ok' | 'timeout' | 'refused'

/** 假 fetch:按剧本一次一答。 */
function scripted(script: Answer[]) {
  const impl = (async () => {
    const next = script.shift() ?? 'ok'
    if (next === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    if (next === 'refused') throw new Error('ECONNREFUSED')
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true, avatarCount: 3, pid: 4242 }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }) as unknown as typeof fetch
  return impl
}

function harness(script: Answer[], loopP99: () => number | undefined) {
  let now = 1_000_000
  const lines: string[] = []
  const servicePromise = configFile().then(file => createButlerService({
    configFile: file,
    runCommand: async () => ({ ok: true, stdout: '' }),
    fetchImpl: scripted(script),
    cacheMs: 0,
    now: () => now,
    loopDelayP99Ms: loopP99,
    log: line => lines.push(line),
  }))
  return { service: servicePromise, lines, advance: (ms: number) => { now += ms } }
}

describe('探 8792 · 超时时问一句「是我自己慢吗」', () => {
  it('上一次在跑 + 超时 + 事件循环 p99 高于探测超时 → 沿用「在跑」,记一行', async () => {
    const h = harness(['ok', 'timeout'], () => 2600)
    const service = await h.service
    expect((await service.view()).running).toBe(true)
    const view = await service.view()
    expect(view).toEqual({ running: true, port: 18792, avatarCount: 3 })
    expect(h.lines).toHaveLength(1)
    expect(h.lines[0]?.startsWith(BUTLER_SELF_SLOW_LOG_TAG)).toBe(true)
    expect(h.lines[0]).toContain('p99=2600ms')
    expect(h.lines[0]).toContain(`${BUTLER_PROBE_TIMEOUT_MS}ms`)
  })

  it('超时 + 事件循环正常 → 真没回,照旧「没在跑」,不记那一行', async () => {
    const h = harness(['ok', 'timeout'], () => 12)
    const service = await h.service
    await service.view()
    expect(await service.view()).toEqual({ running: false, port: 18792 })
    expect(h.lines).toHaveLength(0)
  })

  it('超时 + 事件循环没量到(undefined)→ 不猜,照旧「没在跑」', async () => {
    const h = harness(['ok', 'timeout'], () => undefined)
    const service = await h.service
    await service.view()
    expect(await service.view()).toEqual({ running: false, port: 18792 })
  })

  it('连接被拒(不是超时)→ 自己再慢也是「没在跑」', async () => {
    const h = harness(['ok', 'refused'], () => 9000)
    const service = await h.service
    await service.view()
    expect(await service.view()).toEqual({ running: false, port: 18792 })
    expect(h.lines).toHaveLength(0)
  })

  it('没有上一次 + 超时 + 自己慢 → 只能按「没在跑」,日志里说明没有上一次', async () => {
    const h = harness(['timeout'], () => 2600)
    const service = await h.service
    expect(await service.view()).toEqual({ running: false, port: 18792 })
    expect(h.lines[0]).toContain('没有上一次')
  })

  it('上一次「没在跑」+ 超时 + 自己慢 → 沿用「没在跑」(不编一个在跑)', async () => {
    const h = harness(['refused', 'timeout'], () => 2600)
    const service = await h.service
    await service.view()
    expect(await service.view()).toEqual({ running: false, port: 18792 })
    expect(h.lines[0]).toContain('没在跑')
  })

  it(`那一行 ${BUTLER_SELF_SLOW_LOG_EVERY_MS / 60_000} 分钟一次:GC 风暴里每 3 秒探一次不刷屏`, async () => {
    const h = harness(['ok', 'timeout', 'timeout', 'timeout'], () => 2600)
    const service = await h.service
    await service.view()
    await service.view()
    h.advance(3000)
    await service.view()
    expect(h.lines).toHaveLength(1)
    h.advance(BUTLER_SELF_SLOW_LOG_EVERY_MS)
    await service.view()
    expect(h.lines).toHaveLength(2)
  })
})
