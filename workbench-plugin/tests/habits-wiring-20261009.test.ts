// @vitest-environment node
/**
 * 数出来的习惯接到用的地方(2026-10-09,卡「数出习惯」):
 * 来电(这个时段不打电话、改发消息)、早报(挪到她第一次露面前)、审批(这类不问,做完告诉她 —— 四类照旧问)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wireApprovalAnswerer } from '../src/index.ts'
import { createApprovalGrants } from '../src/server/butlerAsks.ts'
import { callOutKey, planCallOuts } from '../src/server/callOut.ts'
import { createApprovalBroker } from '../src/server/composer.ts'
import { createRoutinesService } from '../src/server/routines.ts'

describe('来电:学到的时段里只发消息', () => {
  const now = new Date(2026, 9, 9, 13, 20).getTime()
  const quiet = { from: '23:00', to: '08:00' }
  // 「运行失败」本来就要响(callOutRings);「办完了等你验收」默认只发通知,不算用上。
  const confirm = { key: callOutKey('failed', 't1'), reason: 'failed' as const, item_id: 't1', title: '卡住了', at: new Date(now - 60_000).toISOString() }

  it('本来要响的那一通改成只发通知(理由「habit」),并报出用上了哪条', () => {
    const plan = planCallOuts({ events: [confirm], seen: new Set(), waiting: [], now, quiet, newId: () => 'c1', habitQuiet: () => '时段:13' })
    expect(plan.created[0]).toMatchObject({ silent: true, silent_reason: 'habit' })
    expect(plan.habitApplied).toEqual([{ id: '时段:13', item_id: 't1' }])
  })

  it('不在那个时段 / 本来就不响的,不算用上', () => {
    const off = planCallOuts({ events: [confirm], seen: new Set(), waiting: [], now, quiet, newId: () => 'c1', habitQuiet: () => undefined })
    expect(off.created[0]?.silent).toBe(false)
    expect(off.habitApplied ?? []).toEqual([])
    const done = { ...confirm, key: callOutKey('done', 't2'), reason: 'done' as const, item_id: 't2' }
    const silent = planCallOuts({ events: [done], seen: new Set(), waiting: [], now, quiet, newId: () => 'c2', habitQuiet: () => '时段:13' })
    expect(silent.created[0]?.silent_reason).toBe('done')
    expect(silent.habitApplied ?? []).toEqual([])
  })

  it('「等你回答」那一问也一样', () => {
    const ask = { ...confirm, key: callOutKey('ask', 't3'), reason: 'ask' as const, item_id: 't3' }
    const plan = planCallOuts({ events: [ask], seen: new Set(), waiting: [], now, quiet, newId: () => 'c3', habitQuiet: () => '时段:13' })
    expect(plan.created[0]).toMatchObject({ silent: true, silent_reason: 'habit' })
    expect(plan.habitApplied).toEqual([{ id: '时段:13', item_id: 't3' }])
  })
})

describe('早报:学到的时刻到了就先备好;她自己定了时刻不动', () => {
  const dirs: string[] = []
  afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

  async function harness(learned: string | undefined, config?: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'wb-habit-brief-'))
    dirs.push(dir)
    const configFile = join(dir, 'routines.json')
    if (config !== undefined) (await import('node:fs')).writeFileSync(configFile, JSON.stringify(config))
    const clock = { ms: new Date(2026, 9, 9, 8, 40).getTime() }
    const sent: string[] = []
    const routines = createRoutinesService({
      configFile,
      stateFile: join(dir, 'routines-state.json'),
      now: () => clock.ms,
      skipRetryMs: 0,
      learnedMorningAt: () => learned,
      session: { open: async (message: string) => { sent.push(message); return 's' } },
    })
    await routines.load()
    routines.attach({ readState: async () => ({ agents: [], sessions: [], quota: {}, now: new Date(clock.ms).toISOString(), stale: false }) })
    return { routines, clock, sent }
  }

  it('08:50 学到的:08:49 不跑、08:50 跑(她还没露面)', async () => {
    const h = await harness('08:50')
    h.clock.ms = new Date(2026, 9, 9, 8, 49).getTime()
    h.routines.pump()
    await new Promise(r => setTimeout(r, 20))
    expect(h.sent.filter(m => m.includes('开工'))).toHaveLength(0)
    h.clock.ms = new Date(2026, 9, 9, 8, 50).getTime()
    h.routines.pump()
    await vi.waitFor(() => expect(h.routines.view().last.morning?.trigger).toBe('schedule'))
  })

  it('她比学到的时刻早露面:照旧露面就开工', async () => {
    const h = await harness('08:50')
    h.clock.ms = new Date(2026, 9, 9, 8, 30).getTime()
    h.routines.sighted()
    await vi.waitFor(() => expect(h.routines.view().last.morning?.trigger).toBe('sighting'))
  })

  it('她自己设了时刻:学到的不顶替', async () => {
    const h = await harness('08:50', { morning: { enabled: true, at: '10:00', not_before: '06:00' } })
    h.clock.ms = new Date(2026, 9, 9, 9, 0).getTime()
    h.routines.pump()
    await new Promise(r => setTimeout(r, 20))
    expect(h.routines.view().last.morning).toBeUndefined()
  })
})

describe('审批:这类不问,做完告诉她;沾四类的照旧问', () => {
  const REPO = '/Users/her/app'
  function session(command: string) {
    const events = [{ type: 'tool/call', data: { callId: 'c-1', name: 'bash', arguments: JSON.stringify({ command, sandbox_permissions: 'workspace-write', justification: '要改仓库' }) } }]
    return { id: 's-1', header: { cwd: '/Users/her/工作台' }, seq: events.length, eventAt: (seq: number) => events[seq] }
  }
  function wire(noAsk: (input: { kind?: string, subject?: string, say?: string }) => string | undefined) {
    let listener: ((req: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const ctx = { on: vi.fn((name: string, fn: never) => { if (name === 'approval/request') listener = fn }) as never, inject: vi.fn() }
    const broker = createApprovalBroker()
    const grants = createApprovalGrants()
    const applied: { id: string, where: string }[] = []
    wireApprovalAnswerer(ctx, broker, {
      grants,
      home: '/Users/her',
      tempRoots: ['/tmp'],
      repoRootOf: path => (path.startsWith(REPO) ? REPO : undefined),
      taskOf: async () => ({ id: 'T8', status: 'doing' }),
      habits: { noAsk, applied: async (id, where) => { applied.push({ id, where }) } },
    })
    const call = (command: string, next: () => Promise<unknown>) =>
      listener!({ agent: { session: session(command) }, toolName: 'bash', callId: 'c-1', reason: 'escalate sandbox to workspace-write: 要改仓库' }, next)
    return { broker, grants, applied, call }
  }

  it('学到「不问」的那一类:直接放行、卡上看得见放行了几次(能收回)、记一笔用上了', async () => {
    const seen: unknown[] = []
    const { broker, grants, applied, call } = wire((input) => { seen.push(input); return input.kind === `repo:${REPO}` ? `不问:repo:${REPO}` : undefined })
    const next = vi.fn(async () => 'rejected')
    expect(await call(`cd ${REPO} && pnpm test`, next)).toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
    expect(broker.list()).toEqual([])
    expect(grants.list()[0]).toMatchObject({ key: `repo:${REPO}`, task_id: 'T8', allowed: 1 })
    expect(applied).toEqual([{ id: `不问:repo:${REPO}`, where: 'T8' }])
    expect(seen[0]).toMatchObject({ kind: `repo:${REPO}`, subject: `cd ${REPO} && pnpm test` })
  })

  it('习惯那边说要问(沾四类 / 没学到)→ 照旧挂一条问她', async () => {
    const { broker, applied, call } = wire(() => undefined)
    void call(`cd ${REPO} && git push origin main`, async () => 'unavailable')
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    expect(applied).toEqual([])
  })
})
