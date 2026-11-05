// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createTasksService } from '../src/server/tasks.ts'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('任务账诊断默认关闭，显式开启只给读写类别与数值，不泄露标题或路径', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tasks-io-numeric-')); homes.push(home)
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const tasks = createTasksService({ file: join(home, 'tasks.json') })
  const created = await tasks.create({ title: '私人标题-不可入诊断' })
  expect(created.ok).toBe(true)
  expect(log).not.toHaveBeenCalled()
  vi.stubEnv('WORKBENCH_TASK_IO_DIAGNOSTICS', '1')
  await tasks.list()
  await tasks.update(created.id!, { title: '第二个私人标题' })
  await tasks.list()
  const output = log.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('[task-io] '))
  expect(output.length).toBeGreaterThanOrEqual(2)
  const rows = output.map(line => JSON.parse(line.slice('[task-io] '.length)) as Record<string, unknown>)
  expect(rows.some(row => row.operation === 'parse')).toBe(true)
  expect(rows.some(row => row.operation === 'save')).toBe(true)
  expect(rows.some(row => row.operation === 'parse' && row.caller === 'write')).toBe(true)
  expect(rows.some(row => row.operation === 'save' && row.cause === 'mutation')).toBe(true)
  for (const line of output) {
    expect(line).not.toContain(home)
    expect(line).not.toContain('私人标题')
    expect(line).not.toContain('第二个私人标题')
  }
  for (const row of rows) {
    expect(typeof row.bytes).toBe('number')
    expect(typeof row.duration_ms).toBe('number')
    expect(['list', 'write', 'other']).toContain(row.caller)
    if (row.operation === 'save') {
      expect(typeof row.site_line).toBe('number')
      expect(typeof row.site_column).toBe('number')
      expect(row.site_line).toBeGreaterThan(0)
      expect(row.site_column).toBeGreaterThan(0)
    }
  }
})
