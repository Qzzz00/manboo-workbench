// @vitest-environment node
/**
 * 峰谷时间表落盘(2026-09-09)。Ben 在 SettingsDialog 改,改完要活过重启。
 * 原子写 + 容错读,与 read-marks.json / notes.json 同规格。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PEAK_SCHEDULE } from '../src/quota/peakHours.ts'
import { createPeakScheduleService, defaultPeakScheduleFile } from '../src/server/peakSchedule.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-peak-'))
  dirs.push(dir)
  return join(dir, 'peak-hours.json')
}

describe('峰谷时间表落盘', () => {
  it('落在 ~/.dsh/workbench/peak-hours.json,与其余落盘同一个目录', () => {
    expect(defaultPeakScheduleFile('/Users/example')).toBe('/Users/example/.dsh/workbench/peak-hours.json')
  })

  it('没有文件时用官方默认两段,不报错', async () => {
    const svc = createPeakScheduleService({ file: tempFile() })
    await svc.load()
    expect(svc.get()).toEqual(DEFAULT_PEAK_SCHEDULE)
  })

  it('存了就活过重启:另起一个实例读同一个文件', async () => {
    const file = tempFile()
    const first = createPeakScheduleService({ file })
    await first.load()
    await first.set({ periods: [{ start: '09:00', end: '11:30' }] })

    const second = createPeakScheduleService({ file })
    await second.load()
    expect(second.get().periods).toEqual([{ start: '09:00', end: '11:30' }])
  })

  it('写坏的文件按默认兜底,不让一份坏 JSON 把额度格弄哑', async () => {
    const file = tempFile()
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    const svc = createPeakScheduleService({ file })
    await svc.load()
    expect(svc.get()).toEqual(DEFAULT_PEAK_SCHEDULE)
  })

  it('内容不合法(段重叠/格式错)也按默认兜底', async () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ version: 1, schedule: { periods: [{ start: '25:00', end: '26:00' }] } }), 'utf8')
    const svc = createPeakScheduleService({ file })
    await svc.load()
    expect(svc.get()).toEqual(DEFAULT_PEAK_SCHEDULE)
  })

  it('set 拒绝不合法的时间表并原样保留旧表(抛错,由路由翻成 400)', async () => {
    const svc = createPeakScheduleService({ file: tempFile() })
    await svc.load()
    await expect(svc.set({ periods: [{ start: '12:00', end: '08:00' }] })).rejects.toThrow(/起点要早于终点/)
    expect(svc.get()).toEqual(DEFAULT_PEAK_SCHEDULE)
  })

  it('落盘文件带 version,方便以后认格式', async () => {
    const file = tempFile()
    const svc = createPeakScheduleService({ file })
    await svc.load()
    await svc.set({ periods: [{ start: '09:00', end: '11:30' }] })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1, schedule: { periods: [{ start: '09:00', end: '11:30' }] },
    })
  })
})
