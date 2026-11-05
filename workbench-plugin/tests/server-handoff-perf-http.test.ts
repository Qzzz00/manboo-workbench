// @vitest-environment node
/**
 * 串联真机打点的收口(2026-09-24 第五轮):POST /perf/handoff 只收白名单数字,写一行 [性能] 进日志;GET 看最近每端一份。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { handoffPerfLine, parseHandoffPerf } from '../src/server/handoffPerf.ts'

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close(); vi.restoreAllMocks() })

const sample = {
  v: 1, side: 'desk', mode: 'degraded', degradeReason: 'gate-timeout', count: 700, paintMs: 12.34, syncMs: 3.2, gateMs: 460,
  firstFrameMs: 180, frames: 150, maxGapMs: 240, p95GapMs: 33, medianGapMs: 17, over50: 2, over100: 1,
  longtasks: null, longtaskMaxMs: null, longtaskTotalMs: null, viewport: '1512x982@2', secret: '不该收', at: 'x',
}

describe('parseHandoffPerf', () => {
  it('只留白名单字段;数字取一位小数;不认识的枚举 / 字段丢掉', () => {
    const r = parseHandoffPerf(sample, new Date('2026-09-24T04:00:00Z'))
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.side).toBe('desk'); expect(r.mode).toBe('degraded'); expect(r.degradeReason).toBe('gate-timeout')
    expect(r.paintMs).toBe(12.3); expect(r.longtasks).toBeNull(); expect(r.viewport).toBe('1512x982@2')
    expect(r).not.toHaveProperty('secret')
    expect(parseHandoffPerf({ ...sample, side: 'x' })).toHaveProperty('error')
    expect(parseHandoffPerf({ ...sample, mode: 'x' })).toHaveProperty('error')
    const odd = parseHandoffPerf({ ...sample, degradeReason: '<script>', viewport: '/Users/example' })
    expect(odd).toMatchObject({ degradeReason: '', viewport: '' })
  })
  it('日志那一行是人读得懂的数字', () => {
    const r = parseHandoffPerf(sample)
    if ("error" in r) throw new Error(String(r.error))
    const line = handoffPerfLine(r)
    expect(line).toContain('[性能] 串联 desk degraded(gate-timeout)')
    expect(line).toContain('最长间隔 240ms')
    expect(line).toContain('长任务 不支持')
  })
})

describe('POST /perf/handoff', () => {
  it('收下写一行日志;GET 回最近每端一份;坏 body 400', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tickIntervalMs: 0 })
    started.push(server)
    const res = await fetch(`${server.url}/perf/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) })
    expect(res.status).toBe(200)
    expect(log.mock.calls.some(c => String(c[0]).startsWith('[性能] 串联 desk'))).toBe(true)
    const view = await (await fetch(`${server.url}/perf/handoff`)).json() as Record<string, { maxGapMs: number }>
    expect(view.desk?.maxGapMs).toBe(240)
    const bad = await fetch(`${server.url}/perf/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ side: 'x' }) })
    expect(bad.status).toBe(400)
  })
})
