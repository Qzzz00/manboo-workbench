// @vitest-environment node
/**
 * 峰谷时段的 HTTP 面(2026-09-09):/state 下发当前峰谷,POST /peak-schedule 改时间表。
 * 写只认回环——与 /credentials /layout /note/* 同一条规矩。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkbenchService } from '../src/server/service.ts'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { DEFAULT_PEAK_SCHEDULE, type PeakSchedule } from '../src/quota/peakHours.ts'
import { validatePeakSchedule } from '../src/quota/peakHours.ts'
import type { WorkbenchState } from '../src/protocol.ts'

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()!.close() })

/** 内存版时间表服务:与 peakSchedule.ts 同一份校验,不碰磁盘。 */
function memorySchedule(initial: PeakSchedule = DEFAULT_PEAK_SCHEDULE) {
  let current = initial
  return {
    load: async () => {},
    get: () => current,
    set: async (schedule: unknown) => {
      const checked = validatePeakSchedule(schedule)
      if (!checked.ok) throw new Error(checked.error)
      current = checked.schedule
      return checked.schedule
    },
  }
}

async function serve(over: { peakSchedule?: ReturnType<typeof memorySchedule>, isLoopback?: () => boolean } = {}) {
  const service = createWorkbenchService()
  const server = await startWorkbenchServer({
    port: 0, service, tickIntervalMs: 0, heartbeatMs: 0,
    ...(over.peakSchedule === undefined ? {} : { peakSchedule: over.peakSchedule }),
    ...(over.isLoopback === undefined ? {} : { isLoopback: over.isLoopback }),
  })
  started.push(server)
  return server
}

async function getState(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

async function post(url: string, body: unknown) {
  const res = await fetch(`${url}/peak-schedule`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('/state 下发当前峰谷', () => {
  it('接了时间表就带 deepseek_peak:峰谷、下一次切换、当前时间表', async () => {
    const server = await serve({ peakSchedule: memorySchedule() })
    const state = await getState(server.url)
    expect(state.deepseek_peak?.phase === 'peak' || state.deepseek_peak?.phase === 'offpeak').toBe(true)
    expect(state.deepseek_peak?.next_switch).toMatch(/^\d{2}:\d{2}$/)
    expect(state.deepseek_peak?.periods).toEqual(DEFAULT_PEAK_SCHEDULE.periods)
  })

  it('没接就整个字段缺席,额度格那一行不出现(不摆空壳)', async () => {
    const server = await serve()
    expect((await getState(server.url)).deepseek_peak).toBeUndefined()
  })
})

describe('POST /peak-schedule', () => {
  it('改完立刻生效,/state 里是新表', async () => {
    const server = await serve({ peakSchedule: memorySchedule() })
    const result = await post(server.url, { periods: [{ start: '09:00', end: '11:30' }] })
    expect(result.status).toBe(200)
    expect((await getState(server.url)).deepseek_peak?.periods).toEqual([{ start: '09:00', end: '11:30' }])
  })

  it('不合法的表回 400 且把人话原样带上,旧表不动', async () => {
    const server = await serve({ peakSchedule: memorySchedule() })
    const result = await post(server.url, { periods: [{ start: '12:00', end: '08:00' }] })
    expect(result.status).toBe(400)
    expect(String(result.body.error)).toContain('起点要早于终点')
    expect((await getState(server.url)).deepseek_peak?.periods).toEqual(DEFAULT_PEAK_SCHEDULE.periods)
  })

  it('非回环来源一律 403——热点网段上的别人不许改这台机器的设置', async () => {
    const server = await serve({ peakSchedule: memorySchedule(), isLoopback: () => false })
    const result = await post(server.url, { periods: [{ start: '09:00', end: '11:30' }] })
    expect(result.status).toBe(403)
  })

  it('没接时间表服务时 404,说清楚是没启用', async () => {
    const server = await serve()
    const result = await post(server.url, { periods: [{ start: '09:00', end: '11:30' }] })
    expect(result.status).toBe(404)
  })

  it('body 不是 JSON 回 400', async () => {
    const server = await serve({ peakSchedule: memorySchedule() })
    const res = await fetch(`${server.url}/peak-schedule`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{坏的',
    })
    expect(res.status).toBe(400)
  })
})
