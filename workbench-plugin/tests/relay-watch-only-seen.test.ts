// @vitest-environment node
/**
 * **「只盯不发」账上记 `seen`,不记 `sent`**(2026-10-03,卡「接缝清理」第 1 条;
 * 决策记录「2026-10-03 早」⑦)。
 *
 * 前因(`docs/交接-1002-引擎接线与删复制品.md` 第六节 ⑤):`watch_only`
 * (`POST /sessions/relay {watch_only:true}` —— 她那句话**她自己已经发进去了**,要的是「它回了告诉我」)
 * 在核实「那句话在对话区里看得见」之后记了一条 `sent`。`found` 的意思确实是「这句话在那边」,
 * 可那一下**不是我们送的**,记成 `sent` 与「一个字不说成送到了」那条纪律擦边。
 *
 * 守三条:
 * ① `watch_only` 那一路账上是 `assigned` + `seen`,**没有 `sent`**;
 * ② 新开一条捎话(真送了)照旧 `assigned` + `sent` —— 不许把两件事记成一样;
 * ③ **消费方照旧看得见「投递」**:`seen` 在四步表的 `DELIVERED` 里,所以
 *    `GET /jobs/<id>/trace` 的「投递」那一格有值 —— `watch_only` 的活不会从此永远显示「没送」。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { traceOf } from '../src/server/jobLog.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { createEngineRelayReader, createRelayWatchService } from '../src/server/relayWatch.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const LOOPBACK = '127.0.0.1'
const NOW = new Date('2026-10-03T00:41:00.000Z')
const NOW_SEC = Math.floor(NOW.getTime() / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fakeMdns(): MdnsAdvertiser {
  let on = false
  return { async start() { on = true }, async stop() { on = false }, active: () => on }
}

/** 真巡检服务 + 真引擎 + 真账 + 假壳(壳那一眼答「看见了」/「没看见」)。 */
function watchService(options: { dir: string, found: boolean }) {
  const h = engineHarness({
    installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }],
    nameOf: sessionAgentName,
    reply: (req: HelperRequest) => (req.op === 'read_reply'
      ? { found: options.found, busy: false, texts: [] }
      : { submitted: true, method: 'ax_value' }),
  })
  const service = createRelayWatchService({
    file: join(options.dir, 'relay.json'),
    reader: createEngineRelayReader({ engine: h.engine }),
    jobLog: h.log,
    newId: () => 'w-1',
    pollMs: 1_000_000,
  })
  return { h, service }
}

describe('只盯不发:账上那一步', () => {
  it('★「只盯不发」= assigned + seen,一条 sent 都没有', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-watch-only-'))
    try {
      const { h, service } = watchService({ dir, found: true })
      await service.load()
      await service.remember({
        agent: 'claude',
        session_id: 'placeholder-1',
        session_placeholder: true,
        watch_only: true,
        title: '刚才的会话',
        mark: '事务官捎话 a1b2c3',
        from: 'call',
        bundle_id: 'com.anthropic.claudefordesktop',
      })
      const mine = h.events().filter(one => one.job === 'relay:w-1')
      expect(mine.map(one => one.step)).toEqual(['assigned', 'seen'])
      expect(mine.some(one => one.step === 'sent')).toBe(false)
      // 包标识照旧记上(读回话要按真那扇窗读)。
      expect(mine[1]).toMatchObject({ family: 'claude', bundle_id: 'com.anthropic.claudefordesktop' })
    }
    finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('★新开一条捎话(真送了)照旧记 sent —— 两件事不许记成一样', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-watch-only-'))
    try {
      const { h, service } = watchService({ dir, found: true })
      await service.load()
      // `relayNewConversation.ts` 那一路:占位 id,但**没有** `watch_only`。
      await service.remember({
        agent: 'claude', session_id: 'placeholder-2', session_placeholder: true,
        title: '新会话', mark: '事务官捎话 d4e5f6', from: 'phone',
      })
      expect(h.events().filter(one => one.job === 'relay:w-1').map(one => one.step)).toEqual(['assigned', 'sent'])
    }
    finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('★四步表照旧看得见「投递」:`seen` 算一次投递(不会显示成「没送」)', () => {
    const events = [
      { at: '2026-10-03T00:41:00.000Z', job: 'relay:w-1', step: 'assigned' as const, family: 'claude' },
      { at: '2026-10-03T00:41:01.000Z', job: 'relay:w-1', step: 'seen' as const, family: 'claude' },
    ]
    const trace = traceOf('relay:w-1', events)
    expect(trace.assigned?.step).toBe('assigned')
    expect(trace.delivered?.step).toBe('seen')
    expect(trace.finished).toBeUndefined()
  })
})

describe('POST /sessions/relay {watch_only:true} → GET /jobs/<id>/trace', () => {
  async function serve(options: { found: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'wb-watch-only-http-'))
    dirs.push(dir)
    const service = createWorkbenchService({ now: () => NOW_SEC })
    service.applyEvent({ agent: 'claude', session_id: 'd9991aac', project: 'desktop-workbench', type: 'running', title: '统筹交接', ts: NOW_SEC - 180 })
    const { h, service: watch } = watchService({ dir, found: options.found })
    await watch.load()
    const answer = createSessionJobs({
      engine: h.engine,
      registry: h.registry,
      sessions: () => service.getState().sessions,
      agentName: sessionAgentName,
    })
    await h.registry.targets()
    const server = await startWorkbenchServer({
      port: 0,
      service,
      tickIntervalMs: 0,
      heartbeatMs: 0,
      sessionAnswer: answer,
      relayWatch: watch,
      engine: h.engine,
      engineRegistry: h.registry,
      jobLog: h.log,
      pairing: createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' }),
      lan: { config: createAppConfig({ file: join(dir, 'app.json') }), mdns: fakeMdns(), lanAddress: () => '10.86.37.27', name: '测试工作台', version: '0.0.0' },
      remoteAddress: () => LOOPBACK,
    })
    started.push(server)
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${server.url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> }
    }
    return { h, call }
  }

  it('★核到那句话在对话区里 → 登记回电,账上 assigned + seen;`trace` 的「投递」那一格是 seen', async () => {
    const { h, call } = await serve({ found: true })
    const relay = await call('/sessions/relay', { who: 'Claude', text: '这周选题定了吗', watch_only: true })
    expect(relay.body).toMatchObject({ ok: true, watched: true })
    // 回包那句话照旧明说「没有重发消息」—— 这一路一个字都没送。
    expect(String(relay.body.note)).toContain('没有重发')
    expect(h.events().filter(one => one.job === 'relay:w-1').map(one => one.step)).toEqual(['assigned', 'seen'])

    const trace = await call('/jobs/relay:w-1/trace')
    expect(trace.status).toBe(200)
    expect(trace.body).toMatchObject({ job: 'relay:w-1' })
    expect((trace.body.assigned as { step?: string } | undefined)?.step).toBe('assigned')
    // ★ 消费方那一格:`seen` 照旧算「投递」—— 不会显示成「没送」。
    expect((trace.body.delivered as { step?: string } | undefined)?.step).toBe('seen')
  })

  it('那句话在对话区里核不到 → 一条都不登记、账上一行都不记(也没重发)', async () => {
    const { h, call } = await serve({ found: false })
    const relay = await call('/sessions/relay', { who: 'Claude', text: '这周选题定了吗', watch_only: true })
    expect(relay.body).toMatchObject({ ok: false })
    expect(String(relay.body.note)).toContain('没有重发')
    expect(h.events().filter(one => one.job === 'relay:w-1')).toEqual([])
  })
})
