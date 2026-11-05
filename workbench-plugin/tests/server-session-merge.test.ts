// @vitest-environment node
/**
 * 同一 agent + session_id 无论从哪条路进来都必须落在同一行（真机 0.1.26 报的重复行）。
 *
 * 两条路的字段丰俭不同：/hook 那条带 cwd/project，/event 那条可能只有裸的 agent+id+type。
 * 合不上的后果不是多一行好看不好看——是"等你"那行永远留在榜首响铃，点了也清不掉。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

async function serve() {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_755_500_000 }),
    tickIntervalMs: 0,
  })
  started.push(server)
  return server
}

async function post(url: string, path: string, body: unknown): Promise<Response> {
  return await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

describe('同一会话跨路由合并', () => {
  it('先 /hook 注入 waiting，再 /event 发裸 done，仍然只有一行', async () => {
    const server = await serve()

    await post(server.url, '/hook/claude', {
      session_id: 'test-cal',
      cwd: '/Users/example/Documents/GitHub/desktop-workbench',
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    })
    await post(server.url, '/event', { agent: 'claude', session_id: 'test-cal', type: 'done' })

    const snapshot = await state(server.url)
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]).toMatchObject({
      agent: 'claude',
      session_id: 'test-cal',
      status: 'done',
      // 裸 done 不带 cwd/project，先前已知的归属不能被擦掉。
      project: 'desktop-workbench',
    })
  })
})
