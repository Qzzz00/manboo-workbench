// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const SCRIPT = fileURLToPath(new URL('../bin/agent-hook.sh', import.meta.url))
const run = promisify(execFile)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 造一份最小可用的 transcript：一条用户消息 + 一条 assistant 回复，结构照抄本机实测样例。 */
function transcriptFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hook-route-transcript-'))
  dirs.push(dir)
  const file = join(dir, 'ses-a7c1.jsonl')
  const lines = [
    { type: 'user', message: { role: 'user', content: '把 Claude 会话标题接上，别再全显示（无标题）' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '收到，这就改。' }] } },
  ]
  writeFileSync(file, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
  return file
}

async function serve() {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_755_500_000 }),
    tickIntervalMs: 0,
  })
  started.push(server)
  return server
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

async function hook(port: number, agent: string, payload: unknown): Promise<string> {
  const child = run(SCRIPT, [agent], { env: { ...process.env, WORKBENCH_PORT: String(port) } })
  child.child.stdin?.end(JSON.stringify(payload))
  return (await child).stdout
}

describe('bin/agent-hook.sh → POST /hook/:agent', () => {
  it('Claude 的权限询问走完全程，落到快照里成为一条"等你确认"', async () => {
    const server = await serve()

    await hook(server.port, 'claude', {
      session_id: 'ses-a7c1',
      cwd: '/Users/example/Documents/GitHub/DouDou',
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    })

    const snapshot = await state(server.url)
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]).toMatchObject({
      agent: 'claude',
      session_id: 'ses-a7c1',
      project: 'DouDou',
      status: 'waiting',
      reason: 'permission_prompt',
    })
    expect(snapshot.agents.find(a => a.id === 'claude')).toMatchObject({ connected: true, online: true })
  })

  it('认不出的 hook 事件回 200 但不写状态——不能让 Claude 那头看到报错', async () => {
    const server = await serve()

    await hook(server.port, 'claude', { session_id: 'x', hook_event_name: 'PreCompact' })

    expect((await state(server.url)).sessions).toHaveLength(0)
  })

  it('带 transcript_path 时，Stop 落到快照里带上标题和摘要——这是本次修的那个"（无标题）"', async () => {
    const server = await serve()
    const transcriptPath = transcriptFixture()

    await hook(server.port, 'claude', {
      session_id: 'ses-a7c1',
      cwd: '/Users/example/Documents/GitHub/DouDou',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
    })

    const snapshot = await state(server.url)
    expect(snapshot.sessions[0]).toMatchObject({
      title: '把 Claude 会话标题接上，别再全显示（无标题）',
      summary: '收到，这就改。',
    })
  })

  it('工作台没起时脚本静默退出，绝不拖慢或打断 agent', async () => {
    const printed = await hook(61999, 'claude', { session_id: 'x', hook_event_name: 'Stop' })

    expect(printed).toBe('')
  })
})
