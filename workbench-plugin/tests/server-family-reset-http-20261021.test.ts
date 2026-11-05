// @vitest-environment node
/**
 * ★ **「重置这一家」那一条 8791 接口**(2026-10-21,卡「派活按家隔离」)。
 *
 * 接缝:8791 接口(主人 = 统筹)。消费方只有工作台网页那颗键(电话里暂不做,手机 / 房间代理不放行这一条)。
 * 钉住:门(本机 / 配对设备)、参数、一次真重置(通道撤了、闸清了、壳撤读、重开窗、两本账),别家不动。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createActionGate } from '../src/server/actionGate.ts'
import { createBehaviorLog } from '../src/server/behaviorLog.ts'
import { createFamilyLanes } from '../src/server/familyLanes.ts'
import { familyResetJobKey } from '../src/server/familyReset.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-family-reset-'))
  dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const now = () => new Date()
  const familyLanes = createFamilyLanes({ now })
  const actionGate = createActionGate({ phaseOf: () => 'open', now })
  const jobLog = createJobLog({ now })
  const helperCalls: HelperRequest[] = []
  const opened: string[] = []
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    familyLanes,
    actionGate,
    jobLog,
    behaviorLog: createBehaviorLog({ dir: join(dir, 'behavior') }),
    reopenApp: async (bundle) => { opened.push(bundle); return { ok: true } },
    helper: {
      attach: () => {},
      view: () => ({ connected: true, authorized: true }) as never,
      connected: () => true,
      supports: cap => cap === 'read_lanes',
      onChange: () => {},
      onEvent: () => {},
      request: async (req) => { helperCalls.push(req); return { cancelled: 1 } },
    },
  })
  started.push(server)
  return { url: server.url, familyLanes, actionGate, jobLog, helperCalls, opened }
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}/dispatch/family/reset`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('POST /dispatch/family/reset', () => {
  it('★清通道、清闸、壳撤读、重开窗,两本账各记一笔;别家不动', async () => {
    const w = await serve()
    const hung = w.familyLanes.run('doubao', 'read', () => new Promise(() => {}))
    const kimiBusy = w.familyLanes.run('kimi', 'read', () => new Promise(() => {}))
    void kimiBusy
    for (let i = 0; i < 3; i += 1) w.actionGate.allow({ job: 't', family: 'doubao', action: 'dispatch_send' })
    const got = await post(w.url, { family: 'doubao' })
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ ok: true, abandoned: 1, gate_cleared: 1, shell_cancelled: 1, reopened: true })
    expect(String(got.body.note)).toContain('已重置')
    await expect(hung).resolves.toMatchObject({ ok: false, why: 'reset' })
    expect(w.familyLanes.view('kimi').busy).toBe(true)
    expect(w.helperCalls[0]).toMatchObject({ op: 'cancel_reads' })
    expect((w.helperCalls[0] as { bundle_ids: string[] }).bundle_ids).toContain('com.bot.pc.doubao')
    expect(w.opened).toHaveLength(1)
    expect(w.jobLog.all().some(one => one.job === familyResetJobKey('doubao') && one.step === 'lane_reset')).toBe(true)
  })

  it('不带 family → 400', async () => {
    const w = await serve()
    expect((await post(w.url, {})).status).toBe(400)
  })
})
