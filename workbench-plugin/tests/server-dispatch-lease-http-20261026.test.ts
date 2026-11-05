// @vitest-environment node
/**
 * 执行租约的真 HTTP 验收(2026-10-26,卡「事务官机制D」t-ea3ba424)。
 *
 * 一整条隔离的 8791(真路由、真派发器、真任务账、真租约文件);命令行那家是**假 CLI 可执行件**
 * (runCli 注入,永不 spawn 真进程):起一条假进程、回执走过「POST /dispatch/run → 真启动回执」
 * 的完整 HTTP 链。钉四件事:
 *   1. 正常入口第一次派 → 真回执 ok:true、hand:'cli'(假 pid),进程在跑;
 *   2. 同卡立刻再派(并发/自动路的化身)→ 200 但 ok:false,话里指认占用者、不重复派;
 *   3. 不同卡、同一项目目录 → 同样拒(树级互斥);
 *   4. 假进程退出(exit 回调,真终态证据)→ 租约放 → 同卡能再派。
 * ★ 通道是注入的假件:这是派发链与租约的源码级验收,不证明真 Codex/Kimi 二进制行为。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import type { ProjectsService } from '../src/server/projectsService.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import type { AgentCli } from '../src/server/agentDispatch.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-26T09:05:00.000Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-lease-http-'))
  dirs.push(dir)
  return dir
}

interface Harness {
  url: string
  tasks: ReturnType<typeof createTasksService>
  lease: ReturnType<typeof import('../src/server/executionLease.ts').createExecutionLeaseStore>
  alivePids: Set<number>
  outputs: Map<string, string>
  runCalls: { pid: number, logFile: string }[]
  resolves: Map<number, (outcome: { code: number | null }) => void>
  /** 让某个假进程退出(exit-observed)。 */
  exit: (pid: number, code: number, reply: string) => Promise<void>
}

async function serve(): Promise<Harness> {
  const dir = temp()
  const repoDir = join(dir, 'repo')
  mkdtempSync(repoDir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${Math.random().toString(36).slice(2, 9)}` })
  const alivePids = new Set<number>()
  const outputs = new Map<string, string>()
  const runCalls: Harness['runCalls'] = []
  const resolves = new Map<number, (outcome: { code: number | null }) => void>()
  let nextPid = 5000
  const cli = {
    resolveCli: (family: string): AgentCli => ({ found: true, family: family as AgentCli extends { family: infer F } ? F : never, bin: `/fake/${family}`, source: 'path' }),
    runCli: (cmd: { logFile: string }) => {
      let resolve!: (outcome: { code: number | null }) => void
      const exited = new Promise<{ code: number | null }>((res) => { resolve = res })
      const pid = nextPid++
      alivePids.add(pid)
      resolves.set(pid, resolve)
      runCalls.push({ pid, logFile: cmd.logFile })
      void exited.then(() => { alivePids.delete(pid) })
      return { pid, exited }
    },
    resultDir: dir,
    now: () => new Date(NOW_SEC * 1000),
  }
  const engine = engineHarness({
    helper: { connected: () => true, supports: () => true, request: async () => ({ ok: true, result: {} }) },
    installed: () => undefined,
    cli,
  })
  const { createExecutionLeaseStore } = await import('../src/server/executionLease.ts')
  const lease = createExecutionLeaseStore({ file: join(dir, 'leases.json') })
  const projects = {
    async getProjectsState() {
      return { projects: [{ id: 'p-1', name: '试验项目', path: repoDir, repos: [], resources: [] }] } as never
    },
  } as unknown as ProjectsService
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    projects,
    engine: engine.engine,
    engineRegistry: engine.registry,
    installedAgents: {
      pump: () => {},
      view: () => ({ agents: [{ family: 'codex', id: 'codex', name: 'Codex', bundle_id: 'com.anthropic.codex', installed: true }], line: '' }),
      installedIds: () => new Set(['codex']),
    } as never,
    appInstalled: () => false,
    dispatchRun: {
      lease,
      alive: pid => alivePids.has(pid),
      readFile: async (file: string) => outputs.get(file),
      resultDir: dir,
      pollMs: 60_000,
    },
  })
  started.push(server)
  return {
    url: server.url, tasks, lease, alivePids, outputs, runCalls, resolves,
    async exit(pid, code, reply) {
      const call = runCalls.find(one => one.pid === pid)
      if (call === undefined) throw new Error(`no fake run ${pid}`)
      const outputFile = call.logFile.replace(/\.jsonl$/, '')
      outputs.set(call.logFile, '{"type":"turn.completed"}\n')
      outputs.set(outputFile, reply)
      resolves.get(pid)?.({ code })
      await new Promise(resolve => setTimeout(resolve, 40))
    },
  }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function codeTaskInRepo(h: Harness, title: string): Promise<string> {
  const created = await h.tasks.create({ title, status: 'doing' })
  const id = created.id as string
  await h.tasks.update(id, { projectId: 'p-1' })
  return id
}

describe('POST /dispatch/run + 执行租约(真 HTTP)', () => {
  it('★正常入口第一次派 → 真启动回执;同卡立刻再派 → 拒(不重复派);别卡同树 → 拒', async () => {
    const h = await serve()
    const a = await codeTaskInRepo(h, 'HTTP 租约 A')
    const first = await post(h.url, '/dispatch/run', { item_id: a, app: 'codex', kind: 'code', text: '把这件事办了' })
    if (first.body.ok !== true) console.log('DEBUG first=', JSON.stringify(first.body))
    expect(first.status).toBe(200)
    expect(first.body.ok).toBe(true)
    expect(first.body.hand).toBe('cli')
    expect(h.runCalls).toHaveLength(1)
    // 同卡再派(自动/并发路的化身):不重复派,话里指认占用者。
    const again = await post(h.url, '/dispatch/run', { item_id: a, app: 'codex', kind: 'code', text: '把这件事办了' })
    expect(again.status).toBe(200)
    expect(again.body.ok).toBe(false)
    expect(String(again.body.note)).toContain('重复派')
    // 别卡同树。
    const b = await codeTaskInRepo(h, 'HTTP 租约 B')
    const other = await post(h.url, '/dispatch/run', { item_id: b, app: 'codex', kind: 'code', text: '同树另一件' })
    expect(other.body.ok).toBe(false)
    expect(String(other.body.note)).toContain('同一工作区')
    expect(h.runCalls).toHaveLength(1)
    // 租约文件里看得见活跃记录(持久,不靠内存)。
    const active = await h.lease.activeForTask(a)
    expect(active?.task_id).toBe(a)
    expect(active?.pid).toBe(h.runCalls[0]?.pid)
  })

  it('★假进程退出(真终态证据)→ 租约放 → 同卡能再派,真起第二个进程', async () => {
    const h = await serve()
    const a = await codeTaskInRepo(h, '退出后重派')
    const first = await post(h.url, '/dispatch/run', { item_id: a, app: 'codex', kind: 'code', text: '办' })
    expect(first.body.ok).toBe(true)
    const pid1 = h.runCalls[0]?.pid as number
    // 进程还在跑时重派:拒(终态证据是退出,不是任何文本)。
    const during = await post(h.url, '/dispatch/run', { item_id: a, app: 'codex', kind: 'code', text: '办' })
    expect(during.body.ok).toBe(false)
    await h.exit(pid1, 0, '做完了:HTTP 验收交卷')
    const card = (await h.tasks.list()).tasks.find(one => one.id === a)!
    expect(card.dispatch?.status).toBe('done')
    const second = await post(h.url, '/dispatch/run', { item_id: a, app: 'codex', kind: 'code', text: '办' })
    expect(second.body.ok).toBe(true)
    expect(h.runCalls).toHaveLength(2)
    // 第一份租约已带终态证据。
    const active = await h.lease.activeForTask(a)
    expect(active?.run_id).not.toBe(undefined)
  })
})
