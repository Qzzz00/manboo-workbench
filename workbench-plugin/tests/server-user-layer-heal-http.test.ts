// @vitest-environment node
/**
 * 分层自愈完善 · 那几条 HTTP 路(2026-10-23,卡「分层自愈完善」):
 *
 *   POST /user-layer/report { id, rev, ok, problem?, style_rev? }   上报带上样式指纹;坏版落盘跨重启
 *   GET  /user-layer          设置那一节的清单里,每格带存下的可用版本历史(最多 3 份)
 *   POST /user-layer/widgets/<id>/restore { rev, style_rev? }      选回历史里的某一版
 *   POST /user-layer/fix      派活成功即记账;那一家交回来后挂在既有 tick 上核对本体越界:
 *                             动了本体 → 拒装(回退这次改的用户层文件、卡上说一句、证据留着)
 *
 * 门:一律只认本机;网页小组件的令牌打不到。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService, type TasksService } from '../src/server/tasks.ts'
import { createExecutionLeaseStore } from '../src/server/executionLease.ts'
import { createUserLayerService, type UserLayerService } from '../src/server/userLayer.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const MANIFEST = { contract: 1, id: 'files', name: '素材管理', replaces: 'files', export: 'FilesModule' }
const CODE_V1 = 'module.exports = { FilesModule: () => "v1" }'
const CODE_V2 = 'module.exports = { FilesModule: () => "v2" }'

async function serve(): Promise<{ url: string, userLayer: UserLayerService, tasks: TasksService, bodyDir: string, widgetDir: string, home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'wb-user-layer-heal-http-'))
  dirs.push(home)
  const bodyDir = join(home, '本体')
  mkdirSync(join(bodyDir, 'lib'), { recursive: true })
  writeFileSync(join(bodyDir, 'lib', 'index.js'), '本体代码 v1', 'utf8')
  const userLayer = createUserLayerService({ dir: join(home, '用户层'), bodyDir })
  await userLayer.ensure()
  const widgetDir = join(userLayer.dir, '小组件', 'files')
  mkdirSync(widgetDir, { recursive: true })
  writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify(MANIFEST), 'utf8')
  writeFileSync(join(widgetDir, 'index.js'), CODE_V1, 'utf8')
  const engineRig = engineHarness({ connected: () => false })
  const tasks = createTasksService({ file: join(home, 'tasks.json'), newId: () => 't-heal' })
  const server = await startWorkbenchServer({
    engine: engineRig.engine,
    engineRegistry: engineRig.registry,
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    userLayer,
    appInstalled: () => true,
    dispatchRun: {
      runCli: (cmd) => ({ pid: 4321, exited: new Promise<{ code: number | null }>(() => {}) }),
      resolveCli: family => ({ found: true, family, bin: `/fake/${family}`, source: 'bundled' }),
      resultDir: home,
      // 测试隔离(2026-10-27 Root 验收退修):每个用例自己的租约 store(文件在 home 临时目录,随
      // afterEach 清掉)。缺席时 http 在 VITEST 下用 `/tmp/wb-test-leases-${process.pid}.json` —— 同
      // 进程内所有用例共享,前序用例的假 PID(4321,永不退出)把固定任务 id t-heal 一直占着,后序
      // 用例被「不重复派」挡住。走显式 lease 注入(http 里它优先于 VITEST 默认);生产防重复派发保护不动。
      lease: createExecutionLeaseStore({ file: join(home, 'execution-leases.json') }),
    },
  })
  started.push(server)
  return { url: server.url, userLayer, tasks, bodyDir, widgetDir, home }
}

async function stateWidget(url: string): Promise<{ rev?: string, style_rev?: string, status: string, problem?: string, rolled_back?: string }> {
  const state = await (await fetch(`${url}/state`)).json() as { user_layer: { widgets: { id: string, rev?: string, style_rev?: string, status: string, problem?: string, rolled_back?: string }[] } }
  const widget = state.user_layer.widgets.find(one => one.id === 'files')
  if (widget === undefined) throw new Error('state 里没有 files')
  return widget
}

describe('POST /user-layer/report 带样式指纹:坏版落盘、跨重启不再重试、改好自动恢复', () => {
  it('报坏(带 style_rev)→ /state 判坏;文件改好(指纹变)→ 自动恢复 ok', async () => {
    const { url, widgetDir } = await serve()
    const before = await stateWidget(url)
    const res = await fetch(`${url}/user-layer/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'files', rev: before.rev, ok: false, problem: '画这一格时出错:x', style_rev: before.style_rev }) })
    expect(res.status).toBe(200)
    expect((await stateWidget(url)).status).toBe('broken')
    // 跨重启不再重试:新服务实例(起服务时把坏版本小表读回来)——这里用 /state 再验一次同一拍仍判坏
    expect((await stateWidget(url)).problem).toBe('画这一格时出错:x')
    // 改好(新指纹)自动恢复
    writeFileSync(join(widgetDir, 'index.js'), CODE_V2, 'utf8')
    expect((await stateWidget(url)).status).toBe('ok')
  })

  it('样式指纹不是字符串:400,当没传', async () => {
    const { url } = await serve()
    const before = await stateWidget(url)
    const res = await fetch(`${url}/user-layer/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'files', rev: before.rev, ok: true, style_rev: 42 }) })
    expect(res.status).toBe(400)
  })
})

describe('GET /user-layer 带历史;POST restore 选回', () => {
  it('画好过两版 → 清单里这一格带两条历史;选回第一版 → /state 的指纹变回第一版', async () => {
    const { url, widgetDir } = await serve()
    const v1 = await stateWidget(url)
    await fetch(`${url}/user-layer/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'files', rev: v1.rev, ok: true, style_rev: v1.style_rev }) })
    writeFileSync(join(widgetDir, 'index.js'), CODE_V2, 'utf8')
    const v2 = await stateWidget(url)
    expect(v2.rev).not.toBe(v1.rev)
    await fetch(`${url}/user-layer/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'files', rev: v2.rev, ok: true, style_rev: v2.style_rev }) })

    const payload = await (await fetch(`${url}/user-layer`)).json() as { widgets: { id: string, history?: { rev: string, at: string }[] }[] }
    const history = payload.widgets.find(one => one.id === 'files')?.history ?? []
    expect(history).toHaveLength(2)
    expect(history[0]?.rev).toBe(v2.rev)
    expect(history[1]?.rev).toBe(v1.rev)

    const restored = await fetch(`${url}/user-layer/widgets/files/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rev: v1.rev, style_rev: v1.style_rev }) })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toEqual({ ok: true })
    expect((await stateWidget(url)).rev).toBe(v1.rev)
    expect(readFileSync(join(widgetDir, 'index.js'), 'utf8')).toBe(CODE_V1)
  })

  it('选一份没存下的:如实回不行', async () => {
    const { url } = await serve()
    const res = await fetch(`${url}/user-layer/widgets/files/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rev: '000000000000' }) })
    expect(res.status).toBe(400)
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: false, reason: expect.any(String) })
  })

  it('rev 不是字符串:400', async () => {
    const { url } = await serve()
    const res = await fetch(`${url}/user-layer/widgets/files/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"rev":42}' })
    expect(res.status).toBe(400)
  })
})

describe('修复交回守门(fix → 记账;tick 上核对:本体被动过就拒装)', () => {
  it('派活成功 → 待核记账;那一家交回来、本体没动 → tick 后记账清掉,修复结果保留', async () => {
    const { url, userLayer, tasks, widgetDir, home } = await serve()
    const res = await fetch(`${url}/user-layer/fix`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ said: '素材管理按名字排' }) })
    const body = await res.json() as { ok?: boolean, id?: string }
    expect(body.ok).toBe(true)
    await vi.waitFor(async () => { expect(await userLayer.pendingFixGuards()).toContain(body.id) })
    // 那一家改好了用户层里那一格
    writeFileSync(join(widgetDir, 'index.js'), CODE_V2, 'utf8')
    // 交回来:命令行那只手结束
    await tasks.update(body.id as string, { dispatch: { family: 'codex', status: 'done', hand: 'cli', cwd: userLayer.dir, started_at: new Date().toISOString(), ended_at: new Date().toISOString() } })
    started[started.length - 1]!.tick()
    await vi.waitFor(async () => { expect(await userLayer.pendingFixGuards()).toEqual([]) })
    // 修复结果保留;没留证据目录
    expect(readFileSync(join(widgetDir, 'index.js'), 'utf8')).toBe(CODE_V2)
    expect(existsSync(join(userLayer.dir, '.修复'))).toBe(false)
    void home
  })

  it('本体被改过 → 拒装:窗口内变过的一份不丢、那一格先不端(改一个码就回来)、卡上说一句、证据长留;本体原样不动', async () => {
    const { url, userLayer, tasks, widgetDir, bodyDir, home } = await serve()
    const res = await fetch(`${url}/user-layer/fix`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ said: '改点什么' }) })
    const body = await res.json() as { ok?: boolean, id?: string }
    await vi.waitFor(async () => { expect(await userLayer.pendingFixGuards()).toContain(body.id) })
    // 先给这一格一个「上一版」(报一次 ok),拒装时才端得回来
    const before = await stateWidget(url)
    await fetch(`${url}/user-layer/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'files', rev: before.rev, ok: true, style_rev: before.style_rev }) })
    // 那一家越界:改了本体,还改了用户层(也可能她自己在窗口内改的 —— 分不清,一律保留)
    writeFileSync(join(bodyDir, 'lib', 'index.js'), '本体代码 被改', 'utf8')
    writeFileSync(join(widgetDir, 'index.js'), 'module.exports = { FilesModule: () => "窗口内变的" }', 'utf8')
    await tasks.update(body.id as string, { dispatch: { family: 'codex', status: 'done', hand: 'cli', cwd: userLayer.dir, started_at: new Date().toISOString(), ended_at: new Date().toISOString() } })
    started[started.length - 1]!.tick()
    await vi.waitFor(async () => { expect(await userLayer.pendingFixGuards()).toEqual([]) })
    // 窗口内的样子原样保留(不回退成 CODE_V1);本体不动;卡上有一句;证据与备份留着
    expect(readFileSync(join(widgetDir, 'index.js'), 'utf8')).toBe('module.exports = { FilesModule: () => "窗口内变的" }')
    expect(readFileSync(join(bodyDir, 'lib', 'index.js'), 'utf8')).toBe('本体代码 被改')
    const after = await stateWidget(url)
    expect(after.rolled_back).toMatch(/先不装/)
    const list = await tasks.list()
    const card = list.tasks.find(one => one.id === body.id)
    expect(card?.note).toContain('本体')
    expect(card?.note).toContain('保留')
    expect(readFileSync(join(userLayer.dir, '.修复', body.id as string, 'record.json'), 'utf8')).toContain('lib/index.js')
    expect(existsSync(join(userLayer.dir, '.修复', body.id as string, '之前', '小组件', 'files', 'index.js'))).toBe(true)
    void home
  })

  it('守门记账本身失败:不静默,卡上落一句(2026-10-23 独立审 Minor 2)', async () => {
    const { url, userLayer, tasks, home } = await serve()
    // .修复 变成一个普通文件:记账一定会失败
    writeFileSync(join(userLayer.dir, '.修复'), '占着', 'utf8')
    const res = await fetch(`${url}/user-layer/fix`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ said: '改点什么' }) })
    const body = await res.json() as { ok?: boolean, id?: string }
    expect(body.ok).toBe(true)
    await vi.waitFor(async () => {
      const card = (await tasks.list()).tasks.find(one => one.id === body.id)
      expect(card?.note).toContain('守门')
    })
    void url; void userLayer; void home
  })
})
