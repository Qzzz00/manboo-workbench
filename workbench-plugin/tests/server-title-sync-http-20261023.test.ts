// @vitest-environment node
/**
 * 借名卡随来源改名 —— **走真 /state 的隔离执行**(2026-10-23,卡 A)。
 *
 * `syncBorrowedCardTitles` 挂在 composeState 读路径上:这里起一台隔离 8791,
 * 用会话事件把来源会话改名,下一拍 GET /state 里那张卡的名就跟着变;
 * 用户经 /task/update 改过名 → 再改来源名,卡不再被覆盖。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import type { TaskView } from '../src/protocol.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { placeSession } from '../src/server/collabRoutes.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-23T08:00:00.000Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('借名的卡随来源改名(走真 /state)', () => {
  it('会话改名 → 下一拍 /state 卡名跟上;用户改过名 → 不再覆盖', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-title-sync-'))
    dirs.push(dir)
    let n = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
    const service = createWorkbenchService({ now: () => NOW_SEC })
    const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0, tasks })
    started.push(server)

    // 挂进来的会话带著名(placeSession 借名建卡)。
    service.applyEvent({ agent: 'codex', session_id: 'x-1', type: 'running', title: '梳理报告', ts: NOW_SEC })
    const placed = await placeSession(tasks, { agent: 'codex', sessionId: 'x-1', body: { title: '梳理报告' } })
    expect(placed.ok).toBe(true)
    if (!placed.ok) throw new Error('placeSession 失败')
    const cardId = placed.id

    const cardOf = async (): Promise<TaskView | undefined> => {
      const res = await fetch(`${server.url}/state`)
      const state = await res.json() as { tasks?: { tasks?: TaskView[] } }
      return state.tasks?.tasks?.find(one => one.id === cardId)
    }

    expect((await cardOf())?.title).toBe('梳理报告')

    // 来源会话改名 → 下一拍 /state 里卡名跟上(同步挂在读路径上)。
    service.applyEvent({ agent: 'codex', session_id: 'x-1', type: 'running', title: '梳理报告 v2', ts: NOW_SEC + 1 })
    expect((await cardOf())?.title).toBe('梳理报告 v2')

    // 用户手动改卡名 → title_from 变 custom;来源再改名,卡不再被覆盖。
    await fetch(`${server.url}/task/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: cardId, title: '我自己的名字' }),
    })
    expect((await cardOf())?.title).toBe('我自己的名字')
    service.applyEvent({ agent: 'codex', session_id: 'x-1', type: 'running', title: '梳理报告 v3', ts: NOW_SEC + 2 })
    expect((await cardOf())?.title).toBe('我自己的名字')
  })
})
