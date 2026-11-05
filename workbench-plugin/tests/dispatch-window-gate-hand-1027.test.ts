// @vitest-environment node
/**
 * 实验门按**最终执行通道**判,不按 family 判(2026-10-27,卡 `t-bd1c04ed` 第一批;
 * 交接 `docs/交接-1027-委托派发机制第一批.md` 设计第 1 条)。
 *
 * 现场:管理者按家派 Kimi 得 409 window_dispatch —— 根因是 `/dispatch/run` 在解析执行手
 * **之前**按 family 判实验门,而 Kimi 自 2026-10-22 起有 code CLI 这只手
 * (`protocol.CODE_CLI_FAMILIES` 含 kimi):写代码的活 `handsFor(kimi,'code')` = `['cli']`,
 * 根本不碰窗口。门要照 `dispatchRun` 同一判据(`dispatchChoice.dispatchUsesWindowHand`)
 * 只拦「真会走窗口手」的那一派;窗口实验保护本身保留(聊天 / 桌面活 / kind 缺席照旧拦)。
 *
 * 这台 8791 接了 appConfig 且 audience=external → window_dispatch 关着(与线上同档)。
 *
 * 2026-10-29 入口归一退修:/butler/item 进理解中枢(前三条 /dispatch/run 用例不动);
 * 「点 Kimi 的活不再『还在内测』」改写为中枢 dispatch to:kimi(代码活走命令行那只手,
 * 不碰窗口),真实判据(没归项目)随后落卡。旧用例「聊天的活 → 窗口实验一张卡不建」删除:
 * /butler/item 主路不再查 window_dispatch 这道门(A#12 批 3 才动;中枢主路本来不查这道门,
 * 三处不一致审计已记)。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXPERIMENT_OFF_LINE } from '../src/mainPaths.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { fakeHubModel, type FakeHubModel } from './helpers/fakeHubModel.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

async function serve(hubModel?: FakeHubModel) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-window-gate-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const helperCalls: HelperRequest[] = []
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> => {
    helperCalls.push(req)
    if (req.op === 'send_text') return { method: 'ax_value', submitted: req.submit === true, new_conversation: '新聊天' }
    return { found: false, busy: false }
  }
  const engine = engineHarness({ helper: { connected: () => true, supports: () => true, request } })
  const model = hubModel
  if (model !== undefined) {
    // 中枢 dispatch to:kimi 的代码活走命令行这只手:登记一只假 Kimi CLI(与派活用例同登记法)。
    let pid = 70000
    engine.registry.register((await import('../src/server/engine/adapters/cli.ts')).createCliAdapter('kimi', {
      resolveCli: () => ({ found: true, family: 'kimi', bin: 'kimi-qa', source: 'path' }),
      runCli: (cmd: { logFile: string }) => {
        writeFileSync(cmd.logFile, [
          JSON.stringify({ role: 'assistant', content: 'qa 改完了' }),
          JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'qa-kimi-session' }),
        ].join('\n'))
        writeFileSync(cmd.logFile.replace(/\.jsonl$/, ''), '')
        return { pid: ++pid, exited: Promise.resolve({ code: 0 }) }
      },
      resultDir: dir,
      now: () => new Date(),
    }))
  }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    engine: engine.engine,
    engineRegistry: engine.registry,
    helper: {
      attach: () => {},
      view: () => ({ connected: true, authorized: true }) as never,
      connected: () => true,
      onChange: () => {},
      onEvent: () => {},
      request,
    },
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    appInstalled: () => true,
    appConfig: createAppConfig({ file: join(dir, 'app.json') }),
    sourceRepo: async () => false,
    ...(model === undefined ? {} : { model: model.service as never, fetchImpl: model.fetchImpl }),
  })
  started.push(server)
  return { url: server.url, server, tasks, helperCalls }
}

const PAGE = { origin: 'http://127.0.0.1:3080' }

describe('实验门按最终执行通道判(2026-10-27)', () => {
  it('window_dispatch 关着 + Kimi 的写代码活(kind:code)→ **不** 409:照命令行那只手走到真实判据(这张卡没归项目 → 如实拦,不碰窗口)', async () => {
    const { url, tasks, helperCalls } = await serve()
    const created = await tasks.create({ title: '把登录脚本重构成模块', direction: 'mine', status: 'todo' })
    const r = await post(url, '/dispatch/run', { item_id: created.id, app: 'kimi', kind: 'code' }, PAGE)
    expect(r.status).toBe(200)
    expect(r.body.experiment_off).toBeUndefined()
    expect(String(r.body.note ?? '')).not.toContain(EXPERIMENT_OFF_LINE)
    // 真实判据拦下:没归项目,不知道在哪个仓库里改 —— 不假装派出去,也不碰窗口。
    expect(r.body.ok).toBe(false)
    expect(helperCalls.filter(one => one.op === 'send_text')).toEqual([])
  })

  it('window_dispatch 关着 + Kimi 不带 kind(会按窗口那只手)→ 照旧 409,一句实验话术,不派', async () => {
    const { url, tasks, helperCalls } = await serve()
    const created = await tasks.create({ title: '中秋节是几月几日', direction: 'mine', status: 'todo' })
    const r = await post(url, '/dispatch/run', { item_id: created.id, app: 'kimi' }, PAGE)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: EXPERIMENT_OFF_LINE, experiment_off: 'window_dispatch' })
    expect(helperCalls.filter(one => one.op === 'send_text')).toEqual([])
  })

  it('window_dispatch 关着 + 豆包写代码的活 → 不拿实验门拦(它根本没有 code 手):照真实判据说「只能聊天」,不碰窗口', async () => {
    const { url, tasks, helperCalls } = await serve()
    const created = await tasks.create({ title: '写一个登录脚本', direction: 'mine', status: 'todo' })
    const r = await post(url, '/dispatch/run', { item_id: created.id, app: 'doubao', kind: 'code' }, PAGE)
    expect(r.status).toBe(200)
    expect(r.body.experiment_off).toBeUndefined()
    expect(r.body.ok).toBe(false)
    expect(String(r.body.note ?? '')).toContain('只能聊天')
    expect(helperCalls.filter(one => one.op === 'send_text')).toEqual([])
  })

  it('/butler/item 点名 Kimi + 明说 kind:code → 不再「还在内测」:中枢 dispatch to:kimi(代码活走命令行那只手),真实判据随后落卡(没归项目)', async () => {
    const text = '把登录脚本重构成模块'
    const model = fakeHubModel({ [text]: [{ name: 'dispatch', new: { title: text }, to: 'kimi', text }] })
    const { url, server, tasks, helperCalls } = await serve(model)
    const r = await post(url, '/butler/item', { text, assignee: 'kimi', kind: 'code', source: 'call' }, PAGE)
    expect(r.status).toBe(200)
    expect(r.body.experiment_off).toBeUndefined()
    expect(String(r.body.note ?? '')).not.toContain(EXPERIMENT_OFF_LINE)
    expect(r.body).toMatchObject({ ok: true })
    // 中枢 dispatch 是后台接的:drain 到落定再读卡 —— 真实判据(没归项目)由派活那一层写回卡上。
    await server.drainDispatches()
    const card = (await tasks.list()).tasks[0]
    expect(String(card?.dispatch_block?.why ?? card?.note ?? '')).toContain('项目')
    expect(card?.conversation).toBeUndefined()
    // 代码活走命令行那只手:窗口一次都没碰。
    expect(helperCalls.filter(one => one.op === 'send_text')).toEqual([])
  })
})
