// @vitest-environment node
/**
 * `/state.quiet`:**「此刻能不能出声」只在这一格**(2026-09-26,卡 QH)。
 *
 * 09-26 00:19 手机冷启动在念东西,而维护者的免打扰是 21:00–08:30。来电那条路早就照它只发通知不响铃,
 * 朗读没照它 —— 因为时段判断只长在座机那条路里。现在服务端把结论摆出来,手机与展示台都读这一格。
 *
 * 这一份钉四件事:时段内、时段外、跨天两侧、没接座机服务时缺席。外加一条:**座机关了不等于可以半夜念**。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { createCallOutService } from '../src/server/callOut.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

/** 维护者真机上设的那一档(`~/.dsh/workbench/call-out.json`)。 */
const QUIET = { quiet_from: '21:00', quiet_to: '08:30' }

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

async function serve(options: { at: string, withCallOut?: boolean, enabled?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-quiet-state-'))
  dirs.push(dir)
  const nowMs = Date.parse(options.at)
  const callOut = options.withCallOut === false
    ? undefined
    : createCallOutService({ file: join(dir, 'call-out.json'), now: () => nowMs })
  await callOut?.load()
  await callOut?.setConfig({ ...QUIET, ...(options.enabled === undefined ? {} : { enabled: options.enabled }) })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => Math.floor(nowMs / 1000) }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    ...(callOut === undefined ? {} : { callOut }),
  })
  started.push(server)
  return server
}

async function stateOf(server: WorkbenchServer): Promise<WorkbenchState> {
  const res = await fetch(`${server.url}/state`)
  expect(res.status).toBe(200)
  return await res.json() as WorkbenchState
}

describe('GET /state.quiet', () => {
  it('★时段内(撞出这张卡的那一刻,00:19):active + 08:30 后恢复 + 一句人话', async () => {
    const server = await serve({ at: '2026-09-26T00:19:00+08:00' })

    const state = await stateOf(server)

    expect(state.quiet).toEqual({ active: true, from: '21:00', to: '08:30', until: '08:30', reason: '免打扰时段' })
  })

  it('★时段外(下午两点):不静音,但时段两头照样带着(设置与界面要说得出「几点起不出声」)', async () => {
    const server = await serve({ at: '2026-09-26T14:00:00+08:00' })

    const state = await stateOf(server)

    expect(state.quiet).toEqual({ active: false, from: '21:00', to: '08:30' })
  })

  it('★跨天:21:00 那一刻起、到 08:29 都还在里头,08:30 整恢复', async () => {
    for (const [at, active] of [
      ['2026-09-25T20:59:00+08:00', false],
      ['2026-09-25T21:00:00+08:00', true],
      ['2026-09-26T00:19:00+08:00', true],
      ['2026-09-26T08:29:00+08:00', true],
      ['2026-09-26T08:30:00+08:00', false],
    ] as const) {
      const server = await serve({ at })
      expect((await stateOf(server)).quiet?.active, at).toBe(active)
    }
  })

  it('★座机关了不等于半夜可以念东西给他听:enabled=false 时这一格照旧 active', async () => {
    const server = await serve({ at: '2026-09-26T00:19:00+08:00', enabled: false })

    const state = await stateOf(server)

    expect(state.quiet?.active).toBe(true)
  })

  it('没接座机服务:整格缺席 —— 缺席按「能出声」算,不替他静音', async () => {
    const server = await serve({ at: '2026-09-26T00:19:00+08:00', withCallOut: false })

    const state = await stateOf(server)

    expect(state.quiet).toBeUndefined()
  })
})
