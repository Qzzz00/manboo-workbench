// @vitest-environment node
/**
 * 小组件**派出去**(2026-10-01,设计 C2;维护者 09-28 15:5x 拍板「事务官自己不干活」)。
 *
 * 原来 `POST /devtool/confirm` 之后开一条事务官自己的会话让她把网页写出来
 * (交接-0928 第七节第 3 条:「**没做**」)。这一份钉改完之后的三件事:
 *
 *   ① **派给能写代码的那一家**:走既有派活管线(命令行那只手,在 `modules/` 里改),
 *      交代就是 `devToolBrief()` 那一份,**原样带上**;事务官自己的会话**一条都不开**;
 *   ② **一家都派不出去时如实说**(`NO_CODER_FOR_MODULE`),待确认那一条留着,
 *      **不退回让事务官自己写**;
 *   ③ **做完事务官验收**:判据是**模块清单里出现了这一格**,不是那一家说了什么。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEV_TOOL_DRAFT, type WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createCustomModulesService } from '../src/server/modules.ts'
import { createDevToolStore, NO_CODER_FOR_MODULE } from '../src/server/devTool.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 命令行那只手真被起起来的那一次(**假的**,一个进程都不起)。 */
interface Run { bin: string, argv: readonly string[], cwd: string }

async function serve(opts: { coder?: boolean, tickMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-devtool-dispatch-'))
  dirs.push(dir)
  const modulesDir = join(dir, 'modules')
  const store = createDevToolStore({ file: join(dir, 'dev-tools.json') })
  await store.load()
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const runs: Run[] = []
  /** 事务官自己那条会话开过没有。**这一卡之后应当永远是空的**。 */
  const butlerOpened: string[] = []
  const engineRig = engineHarness({ connected: () => false })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: opts.tickMs ?? 0,
    heartbeatMs: 0,
    tasks,
    modules: createCustomModulesService({ dir: modulesDir }),
    moduleOrigin: { port: 0 },
    // `acceptEveryMs`:验收那一拍默认 10 秒一次,用例等不起 —— **调快,不睡**。
    devTool: { store, modulesDir, random: () => 0.5, acceptEveryMs: 20 },
    butlerSession: { open: async (first: string) => { butlerOpened.push(first); return 'sess-1' } },
    /**
     * 「这家装了」:一律照 `opts.coder` 回(**不看这台机器的 /Applications** ——
     * 维护者卸了哪一家,用例就不该跟着红;同 server-dispatch-run-http 那一份的理由)。
     */
    appInstalled: () => opts.coder === true,
    /*
     * ★ 2026-10-03(卡「派活三只手收进引擎」):命令行那只手在引擎的登记表里了 —— `http.ts` 拿下面 `dispatchRun` 那几样
     * 往这个登记处登命令行那条通道。壳没连(窗口那条排不上),写代码的活只走命令行,与从前这条用例走的路同一条。
     */
    engine: engineRig.engine,
    engineRegistry: engineRig.registry,
    dispatchRun: {
      runCli: (cmd) => {
        runs.push({ bin: cmd.bin, argv: cmd.argv, cwd: cmd.cwd })
        return { pid: 4321, exited: new Promise(() => {}) }
      },
      /** 命令行那一份探得到 —— **假的**:这台机器上装没装与这几条用例无关。 */
      resolveCli: family => ({ found: true, family, bin: `/fake/${family}`, source: 'bundled' }),
      readFile: async () => undefined,
      resultDir: dir,
    },
  })
  started.push(server)
  return { url: server.url, modulesDir, store, tasks, runs, butlerOpened }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

/** 说一句「开发一个小工具……」,回那条待确认。 */
async function propose(url: string, said: string) {
  await post(url, '/butler/item', { text: `${DEV_TOOL_DRAFT}${said}` })
  const pending = (await state(url)).dev_tool?.pending[0]
  expect(pending).toBeDefined()
  return pending as NonNullable<typeof pending>
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let i = 0; i < 300 && !ok(value); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
    value = await read()
  }
  return value
}

describe('确认之后派给能写代码的那一家', () => {
  it('★派出去了:命令行那只手在 modules/ 里跑,交代里带着产出规范;事务官自己一条会话都没开', async () => {
    const { url, modulesDir, runs, butlerOpened, tasks } = await serve({ coder: true })
    const pending = await propose(url, '一个番茄钟,25 分钟一轮')
    const confirmed = await post(url, '/devtool/confirm', { id: pending.id, name: '番茄钟' })

    expect(confirmed.status).toBe(200)
    expect(confirmed.body).toMatchObject({ ok: true, module_id: pending.module_id, name: '番茄钟', dispatch_ok: true })
    // 派给了一家别的 Agent(哪一家由派活那张选项表挑 —— 这里只钉「不是事务官」)。
    expect(confirmed.body.assignee).not.toBe('dsh')
    expect(String(confirmed.body.dispatch_note)).toContain('交给')

    // ① 事务官自己那条会话**一条都没开**(09-28「事务官自己不干活」在这里是一道代码门槛)。
    expect(butlerOpened).toEqual([])

    // ② 真起了命令行那只手,而且就在模块那个落点上(不是她的仓库、也不是一条新开的工作树)。
    expect(runs).toHaveLength(1)
    expect(runs[0]?.cwd).toBe(modulesDir)
    // ③ 交代**原样带上**:落点、module.json、九条白名单、不许外网,一条都没被重新组织掉。
    const said = runs[0]?.argv.join('\n') ?? ''
    expect(said).toContain('一个番茄钟,25 分钟一轮')
    expect(said).toContain(join(modulesDir, pending.module_id))
    expect(said).toContain('就这九条,别的一条都打不通')
    expect(said).toContain('不许引任何外网地址')

    // 卡上落着负责人,状态是「进行中」;待确认那一条清掉了。
    const board = (await tasks.list()).tasks
    expect(board[0]?.status).toBe('doing')
    expect(board[0]?.assignee).toBe(confirmed.body.assignee)
    expect((await state(url)).dev_tool?.pending).toEqual([])
  })

  it('★派活记录落了盘:派给了谁、在等哪一格出现', async () => {
    const { url, store } = await serve({ coder: true })
    const pending = await propose(url, '一个番茄钟')
    await post(url, '/devtool/confirm', { id: pending.id, name: '番茄钟' })
    expect(store.dispatched()).toMatchObject([{ module_id: pending.module_id, name: '番茄钟' }])
    expect(store.dispatched()[0]?.family).not.toBe('dsh')
  })
})

describe('一家都派不出去', () => {
  it('★如实说「这台没有能写代码的 Agent」,需求留着,**不退回让事务官自己写**', async () => {
    const { url, runs, butlerOpened, tasks } = await serve({ coder: false })
    const pending = await propose(url, '一个番茄钟')
    const res = await post(url, '/devtool/confirm', { id: pending.id, name: '番茄钟' })

    expect(res.status).toBe(409)
    expect(String(res.body.error)).toBe(NO_CODER_FOR_MODULE)
    // 一个字都没办:没建卡、没开会话、没起进程,那条需求还在(装上一家再点一次)。
    expect((await tasks.list()).tasks).toEqual([])
    expect(butlerOpened).toEqual([])
    expect(runs).toEqual([])
    expect((await state(url)).dev_tool?.pending).toHaveLength(1)
  })
})

describe('事务官验收(读模块清单)', () => {
  it('★那一格真出现在清单里 → 卡上一句「做好了」,这一条不再等', async () => {
    const { url, modulesDir, store, tasks } = await serve({ coder: true, tickMs: 30 })
    const pending = await propose(url, '一个番茄钟')
    await post(url, '/devtool/confirm', { id: pending.id, name: '番茄钟' })
    expect(store.dispatched()).toHaveLength(1)

    // 「那一家干完活」由这份用例扮演:照交代把两个文件落进 modules/<id>/。
    const target = join(modulesDir, pending.module_id)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'index.html'), '<!doctype html><body>25:00', 'utf8')
    writeFileSync(join(target, 'module.json'), JSON.stringify({
      version: 1, id: pending.module_id, name: '番茄钟', created_at: '2026-10-01T09:00:00+08:00', source: 'dsh', entry: 'index.html',
    }), 'utf8')

    const board = await waitFor(async () => (await tasks.list()).tasks, list => (list[0]?.note ?? '').includes('做好了'))
    expect(board[0]?.note).toContain('番茄钟')
    expect(board[0]?.note).toContain(pending.module_id)
    expect(store.dispatched()).toEqual([])
  })
})
