// @vitest-environment node
/**
 * `/evolve/*` 那几条路与 `/state.evolve`(2026-09-22,卡 ⑥ 进化循环)。
 *
 * 钉四件:
 * 1. **没接这条链路时一律 404**,`/state.evolve` 缺席、收件箱里那一档一条不出 ——
 *    这块功能之前的行为一字不变(additive 可选那条老纪律);
 * 2. 接上之后提议**同时**进 `/state.evolve.pending` 与 `/state.butler_inbox`,
 *    两处是同一条(id 相等)—— 一处数据两处用,不各存一份;
 * 3. 三颗键各打各的路,`accept` 的 `way` 认不出时**不猜**(退回服务给的默认);
 * 4. 服务说没办成时回 400 并把原话带上 —— 不静默吞掉(D13)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import {
  candidateId, createEvolveService, createEvolveStore, proposalOf, type EvolveService,
} from '../src/server/evolve.ts'

const NOW = Date.parse('2026-09-22T12:00:00Z')
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const CANDIDATE = {
  id: candidateId('评论区问题整理成选题'),
  sample: '评论区问题整理成选题',
  says: [
    { id: 'a', text: '把评论区里的问题整理成选题', at: new Date(NOW - 10 * 86_400_000).toISOString() },
    { id: 'b', text: '把评论区的问题整理一下变成选题', at: new Date(NOW - 6 * 86_400_000).toISOString() },
    { id: 'c', text: '评论区问题整理成选题', at: new Date(NOW - 2 * 86_400_000).toISOString() },
  ],
  shared: [],
}

async function start(evolve?: EvolveService): Promise<WorkbenchServer> {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => Math.floor(NOW / 1000) }),
    tickIntervalMs: 0,
    ...(evolve === undefined ? {} : { evolve }),
  })
  started.push(server)
  return server
}

/** 一台真服务(仓与日志全落在临时目录里,**一行都不碰 ~/.dsh**)。 */
function realService(): { service: EvolveService, files: Map<string, string>, tools: unknown[] } {
  const home = mkdtempSync(join(tmpdir(), 'wb-evolve-routes-'))
  dirs.push(home)
  const files = new Map<string, string>()
  const tools: unknown[] = []
  const service = createEvolveService({
    store: createEvolveStore({ file: join(home, 'evolve.json') }),
    io: {
      readFile: async file => files.get(file),
      writeFile: async (file, text) => { files.set(file, text) },
      removeFile: async file => files.delete(file),
    },
    repo: join(home, 'repo'),
    workdir: join(home, 'work'),
    now: () => NOW,
    says: async () => CANDIDATE.says,
    tool: async input => { tools.push(input); return { ok: true } },
  })
  return { service, files, tools }
}

const post = async (url: string, path: string, body: unknown) => {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('没接这条链路', () => {
  it('★/evolve/* 一律 404,/state.evolve 缺席,收件箱里一条不多', async () => {
    const server = await start()
    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.evolve).toBeUndefined()
    expect(state.butler_inbox?.items.some(item => item.kind === 'evolve')).toBe(false)
    expect((await fetch(`${server.url}/evolve`)).status).toBe(404)
    expect((await post(server.url, '/evolve/scan', {})).status).toBe(404)
    expect((await post(server.url, '/evolve/accept', { id: 'x' })).status).toBe(404)
  })
})

describe('接上之后', () => {
  it('★扫一遍 → 提议同时进 /state.evolve 与收件箱,两处是同一条', async () => {
    const { service } = realService()
    await service.load()
    const server = await start(service)
    const scanned = await post(server.url, '/evolve/scan', {})
    expect(scanned.status).toBe(200)
    expect(scanned.body.added).toBe(1)

    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    const proposal = state.evolve?.pending[0]
    expect(proposal?.times).toBe(3)
    const item = state.butler_inbox?.items.find(row => row.kind === 'evolve')
    expect(item?.id).toBe(proposal?.id)
    expect(item?.title).toBe(proposal?.ask)
  })

  it('★「不要」与「以后再说」各打各的路,提议当场从 /state 撤下去', async () => {
    const { service } = realService()
    await service.load()
    const server = await start(service)
    await post(server.url, '/evolve/scan', {})
    const id = CANDIDATE.id

    expect((await post(server.url, '/evolve/later', { id })).body.note).toContain('下次还会问')
    let state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.evolve?.pending).toEqual([])

    // 「以后再说」之后再扫还会提;「不要」之后就不提了。
    await post(server.url, '/evolve/scan', { force: true })
    expect((await post(server.url, '/evolve/decline', { id })).body.note).toContain('以后不提')
    await post(server.url, '/evolve/scan', { force: true })
    state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.evolve?.pending).toEqual([])
  })

  it('★没说是哪一条 → 400;没有这一条 → 404', async () => {
    const { service } = realService()
    await service.load()
    const server = await start(service)
    expect((await post(server.url, '/evolve/accept', {})).status).toBe(400)
    expect((await post(server.url, '/evolve/decline', { id: 'evolve:没有' })).status).toBe(404)
  })

  it('★小组件那条路:预填进现有链路 + 日志可读;`way` 认不出时不猜,退回服务给的默认', async () => {
    const { service, tools } = realService()
    await service.load()
    const server = await start(service)
    await post(server.url, '/evolve/scan', {})
    const done = await post(server.url, '/evolve/accept', { id: CANDIDATE.id, way: '随便编一个' })
    // 认不出的 way 被丢掉 → 走服务给的默认(这条候选默认是技能),于是因为"没起名字"被挡下。
    expect(done.status).toBe(400)
    expect(String(done.body.error)).toContain('名字')
    expect(tools).toEqual([])

    const asTool = await post(server.url, '/evolve/accept', { id: CANDIDATE.id, way: 'tool' })
    expect(asTool.status).toBe(200)
    expect(tools).toHaveLength(1)

    const log = await fetch(`${server.url}/evolve/log`)
    expect(log.status).toBe(200)
    expect(String((await log.json() as { text: string }).text)).toContain('进化日志')
  })

  it('★还没固化过任何东西时 /evolve/log 如实 404,不回一份空模板冒充', async () => {
    const { service } = realService()
    await service.load()
    const server = await start(service)
    expect((await fetch(`${server.url}/evolve/log`)).status).toBe(404)
  })

  it('★回看那一句固化过之后才出现在 /state', async () => {
    const { service } = realService()
    await service.load()
    const server = await start(service)
    await post(server.url, '/evolve/scan', {})
    let state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.evolve?.review).toBeUndefined()
    await post(server.url, '/evolve/accept', { id: CANDIDATE.id, way: 'template' })
    state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.evolve?.review).toContain('用了没')
  })
})
