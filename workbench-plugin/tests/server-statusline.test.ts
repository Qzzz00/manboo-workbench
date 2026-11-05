// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

async function serve() {
  const service = createWorkbenchService({ now: () => 1_755_500_000 })
  const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0 })
  started.push(server)
  return server
}

async function post(url: string, body: unknown) {
  const res = await fetch(`${url}/statusline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

/** Claude Code statusLine 交到脚本手上的 stdin JSON（官方 schema 的相关子集）。 */
const payload = {
  session_id: 'abc123',
  cwd: '/Users/example/Documents/GitHub/desktop-workbench',
  transcript_path: '/Users/example/.claude/projects/x/abc123.jsonl',
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
}

describe('POST /statusline', () => {
  it('把 Claude 的额度存进快照，界面不必再等实测', async () => {
    const { url } = await serve()

    const res = await post(url, payload)
    expect(res.status).toBe(200)

    const snapshot = await state(url)
    expect(snapshot.quota.claude).toMatchObject({
      kind: 'quota',
      windows: [
        { label: '5h', left_pct: 76.5, reset_at: new Date(1738425600 * 1000).toISOString() },
        { label: '周', left_pct: 58.8, reset_at: new Date(1738857600 * 1000).toISOString() },
      ],
    })
    /**
     * 2026-10-02(卡 QA):**收到这一份的时刻要存下来**。推送是实时的,但这一格会落盘
     * (`last-quota.json`),重启之后顶回界面时可能已经几天前了 —— 真机上就躺着 09-26 22:10 那一份,
     * 到 10-02 还在。不写下时刻,界面就说不出它旧。
     */
    const asOf = (snapshot.quota.claude as { as_of?: string }).as_of
    expect(typeof asOf).toBe('string')
    expect(Math.abs(Date.now() - Date.parse(asOf as string))).toBeLessThan(60_000)
  })

  it('回一行给 statusLine 打印——这条命令还得负责显示状态栏', async () => {
    const { url } = await serve()

    const res = await post(url, payload)

    expect(String(res.body.line)).toContain('5h')
    expect(String(res.body.line)).toContain('76.5%')
  })

  it('旧版 Claude Code 不带 rate_limits：回 200 不报错，但额度保持未接入', async () => {
    const { url } = await serve()

    const res = await post(url, { session_id: 'abc' })
    expect(res.status).toBe(200)

    const snapshot = await state(url)
    expect(snapshot.quota.claude?.kind).toBe('unknown')
  })

  it('★已经收到过额度之后，再来一条不带 rate_limits 的不能把它抹掉', async () => {
    const { url } = await serve()
    await post(url, payload)

    // 真机日志里每条「带额度」后面同一秒都紧跟一条「无额度字段」——
    // Claude Code 会为不同会话各调一次 statusLine，只有其中一次带得出额度。
    // 原来这第二条会把刚存下的好数据覆盖成 unknown，于是界面永远是"未接入"。
    await post(url, { session_id: 'another-session' })

    const snapshot = await state(url)
    expect(snapshot.quota.claude?.kind).toBe('quota')
  })

  it('抹不掉的同时，状态栏那一行也还得照常打印出来', async () => {
    const { url } = await serve()
    await post(url, payload)

    const res = await post(url, { session_id: 'another-session' })

    expect(String(res.body.line)).toContain('76.5%')
  })

  it('坏 JSON 挡在门外，不写进状态', async () => {
    const { url } = await serve()

    const res = await fetch(`${url}/statusline`, { method: 'POST', body: '{ 半行' })
    expect(res.status).toBe(400)
  })

  it('只取额度，会话路径等字段一律不进快照——展示台不该拿到会话内容', async () => {
    const { url } = await serve()

    await post(url, payload)

    const snapshot = await state(url)
    expect(JSON.stringify(snapshot.quota)).not.toContain('transcript')
    expect(JSON.stringify(snapshot.quota)).not.toContain('abc123')
  })
})

const SCRIPT = fileURLToPath(new URL('../bin/claude-statusline.sh', import.meta.url))
const run = promisify(execFile)

// 脚本的调用痕迹默认写 ~/.dsh/workbench/statusline.log——那是真机上用来判断
// 「Claude Code 到底调没调 statusLine」的唯一凭据。测试若不改这个路径，每跑一次
// 就往真日志里塞两行（一条带额度、一条不带），和真实调用长得一模一样。
// 真机上就因此误判过一整天：日志里全是测试留下的痕迹，却被当成 Claude Code 的上报，
// 于是一路往"上报了但没送达"的方向查，而实际上 statusLine 一次都没被调用过。
const TRACE_DIR = mkdtempSync(join(tmpdir(), 'workbench-statusline-'))
const TRACE = join(TRACE_DIR, 'statusline.log')

afterAll(() => {
  rmSync(TRACE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 真的把脚本跑起来：这是 Claude Code 那头唯一的接触面，光测路由不算通。 */
async function statusline(port: number, stdin: string): Promise<string> {
  const child = run(SCRIPT, [], {
    env: { ...process.env, WORKBENCH_PORT: String(port), WORKBENCH_STATUSLINE_TRACE: TRACE },
  })
  child.child.stdin?.end(stdin)
  return (await child).stdout
}

describe('bin/claude-statusline.sh', () => {
  it('把 stdin 转交给服务，并打印服务回的那一行', async () => {
    const server = await serve()

    const printed = await statusline(server.port, JSON.stringify(payload))

    expect(printed).toBe('5h 76.5% · 周 58.8%')
  })

  it('工作台没起时不让状态栏空白或报错，退回显示模型与目录', async () => {
    // 61999 上没有服务，curl 会立刻连不上。
    const printed = await statusline(61999, JSON.stringify({
      model: { display_name: 'Opus' },
      cwd: '/Users/example/Documents/GitHub/desktop-workbench',
    }))

    expect(printed).toBe('Opus · desktop-workbench')
  })
})

describe('区分"没被调用"和"调用了但没带额度"', () => {
  it('上报了但没有 rate_limits 时，把话说清楚——否则界面只写"等上报"，看不出其实已经上报过了', async () => {
    const { url } = await serve()

    await post(url, { session_id: 'abc', model: { display_name: 'Opus' } })

    const snapshot = await state(url)
    expect(snapshot.quota.claude).toMatchObject({
      kind: 'unknown',
      note: expect.stringContaining('没带'),
    })
  })
})
