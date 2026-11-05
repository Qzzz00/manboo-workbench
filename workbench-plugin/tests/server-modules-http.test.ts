// @vitest-environment node
/**
 * 自定义模块容器的路由(2026-09-21,分支 feat/custom-module-container)。
 *
 *   GET  /modules                 清单(活着的 + 回收站)
 *   GET  /modules/<id>/<路径>      静态文件 —— **iframe 的 src 就是这条**
 *   POST /modules/<id>/remove     移进回收站
 *   POST /modules/<id>/restore    拿回来
 *   POST /butler/item             认出「开发一个小工具」那句话 → 待确认,**什么都不做**
 *   POST /devtool/confirm|cancel  他拍板之后才真派出去(2026-10-01 起:派给能写代码的那一家,不再是事务官自己写)
 *
 * 钉三样别的地方钉不住的事:**穿越走到路由上还是穿越**、**CSP 真的发出去了**、
 * **认出那一刻一张卡都没建**(提议流程的门槛在代码里,不是在文案里)。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
import { createTemplateService } from '../src/server/templateStore.ts'
import { DEFAULT_LANDSCAPE_MODULES } from '../src/client/layout.ts'
import type { WorkbenchLayout } from '../src/protocol.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { resetStarterTemplateSource, startRealUserLayer } from './helpers/starterLayer.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-21T02:00:00Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  // 全局模板来源是模块级状态:装过真实起步层也要复位,不然串到并行用例。
  resetStarterTemplateSource()
})

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-modules-http-'))
  dirs.push(dir)
  return dir
}

function seedModule(root: string, id: string, manifest: Record<string, unknown>, files: Record<string, string>): void {
  mkdirSync(join(root, id), { recursive: true })
  writeFileSync(join(root, id, 'module.json'), JSON.stringify(manifest), 'utf8')
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, id, name), body, 'utf8')
}

/** 开出来的 DSH 会话 id;undefined = 开不出来。 */
let openedFirstMessages: string[] = []
/**
 * 派出去的那几条交代(2026-10-01,C2):`POST /devtool/confirm` 之后**事务官不自己写**,
 * 走派活管线交给能写代码的那一家 —— 命令行那只手真被起起来的那一次就落在这儿。
 */
let dispatchedBriefs: string[] = []

async function serve(opts: { withModules?: boolean, withDevTool?: boolean, withTasks?: boolean, coder?: boolean } = {}) {
  const dir = tmpDir()
  const modulesDir = join(dir, 'modules')
  mkdirSync(modulesDir, { recursive: true })
  const modules = createCustomModulesService({ dir: modulesDir, now: () => Date.parse('2026-09-21T10:00:00Z') })
  const store = createDevToolStore({ file: join(dir, 'dev-tools.json') })
  await store.load()
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  openedFirstMessages = []
  dispatchedBriefs = []
  const service = createWorkbenchService({ now: () => NOW_SEC })
  /*
   * ★ 2026-10-03(卡「派活三只手收进引擎」):命令行那只手在引擎的登记表里了 —— `http.ts` 拿下面 `dispatchRun`
   * 那几样往这个登记处登命令行那条通道;没登记处就没有命令行,派活会「如实说没有能用的手」。壳没连,写代码只走命令行。
   */
  const engineRig = engineHarness({ connected: () => false })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    engine: engineRig.engine,
    engineRegistry: engineRig.registry,
    ...(opts.withModules === false ? {} : { modules, moduleOrigin: { port: 0 } }),
    ...(opts.withTasks === false ? {} : { tasks }),
    ...(opts.withDevTool === false
      ? {}
      : {
          devTool: {
            store,
            modulesDir,
            // 固定随机,module id 可预期。
            random: () => 0.5,
          },
        }),
    butlerSession: {
      open: async (first: string) => { openedFirstMessages.push(first); return 'sess-1' },
    },
    /**
     * 「这家装了」:照 `opts.coder` 回,**不看这台机器的 /Applications** —— 维护者装没装
     * Codex / Claude 都不该让这几条用例变色(同 server-dispatch-run-http 那一份的理由)。
     */
    appInstalled: () => opts.coder === true,
    dispatchRun: {
      runCli: (cmd) => {
        dispatchedBriefs.push(cmd.argv.join('\n'))
        return { pid: 4321, exited: new Promise<{ code: number | null }>(() => {}) }
      },
      resolveCli: family => ({ found: true, family, bin: `/fake/${family}`, source: 'bundled' }),
      resultDir: dir,
    },
  })
  started.push(server)
  return { url: server.url, origin: server.moduleOrigin(), modulesDir, store, tasks }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

const POMODORO = '<!doctype html><meta charset="utf-8"><title>番茄钟</title><body>25:00'

// ───────────────────────────────────────────────────────────────────────────
describe('GET /modules 与 /state.modules', () => {
  it('★清单进 /state(窗位叠那一排标签读它),回收站只在 GET /modules 里', async () => {
    const { url, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro', { name: '番茄钟', created_at: '2026-09-21T10:00:00+08:00', source: 'dsh' }, { 'index.html': POMODORO })
    expect((await state(url)).modules).toMatchObject([
      { id: 'pomodoro', name: '番茄钟', created_at: '2026-09-21T10:00:00+08:00', source: 'dsh', entry: 'index.html' },
    ])
    // 2026-09-22 起还多一条:那块 iframe 的 src(在单开的那个来源上,签着这个模块的令牌)。
    expect((await state(url)).modules?.[0]?.frame_url).toContain('/modules/pomodoro/index.html?wb=')

    await post(url, '/modules/pomodoro/remove', {})
    // 移进回收站之后:标签栏读的那一份里没有它了,GET /modules 的 trash 里有。
    expect((await state(url)).modules).toEqual([])
    const listed = await (await fetch(`${url}/modules`)).json() as { modules: unknown[], trash: { id: string }[] }
    expect(listed.modules).toEqual([])
    expect(listed.trash.map(m => m.id)).toEqual(['pomodoro'])
  })

  it('★DSH 在盘上写完,下一次 /state 就有了 —— 标签"当场出现"靠的就是这条,没有谁通知谁', async () => {
    const { url, modulesDir } = await serve()
    expect((await state(url)).modules).toEqual([])
    seedModule(modulesDir, 'tool-abc', { name: '今日待发', created_at: '2026-09-21T11:00:00+08:00' }, { 'index.html': '<p>x</p>' })
    expect((await state(url)).modules?.map(m => m.name)).toEqual(['今日待发'])
  })

  it('没接自定义模块服务时:/modules 404,/state.modules 整块缺席', async () => {
    const { url } = await serve({ withModules: false })
    expect((await fetch(`${url}/modules`)).status).toBe(404)
    expect((await state(url)).modules).toBeUndefined()
  })
})

describe('GET /modules/<id>/<路径>(2026-09-22 起在单开的那个来源上)', () => {
  /** 这一格 iframe 的 src —— 服务端签好的那条(带令牌)。 */
  const frameOf = async (url: string, id: string): Promise<string> =>
    (await state(url)).modules?.find(m => m.id === id)?.frame_url as string

  it('★老路已经不端文件了:同源打开模块这件事没有了(C7 关掉的就是这道门)', async () => {
    const { url, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro', { name: '番茄钟' }, { 'index.html': POMODORO })
    const res = await fetch(`${url}/modules/pomodoro/index.html`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('25:00')
  })

  it('★入口文件端得出来,而且带着按来源写实名的 CSP(sandbox 之后 `self` 谁都不匹配)', async () => {
    const { url, origin, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro', { name: '番茄钟' }, { 'index.html': POMODORO })
    const res = await fetch(await frameOf(url, 'pomodoro'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toContain(`script-src ${origin} 'unsafe-inline'`)
    expect(res.headers.get('content-security-policy')).toContain(`connect-src ${origin} ${url}`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // 页面正文一个字没改,只在文档头上多了容器注入的那段前言。
    expect(await res.text()).toContain('25:00')
  })

  it('目录本身(不带文件名)= 入口文件', async () => {
    const { url, origin, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro', { name: '番茄钟' }, { 'index.html': POMODORO })
    const wb = new URL(await frameOf(url, 'pomodoro')).searchParams.get('wb') as string
    expect(await (await fetch(`${origin}/modules/pomodoro/?wb=${encodeURIComponent(wb)}`)).text()).toContain('25:00')
  })

  it('★路径穿越走到路由上还是穿越:`..`、编码过的 `..`、软链接,三条都不给', async () => {
    const { origin: url, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro', { name: '番茄钟' }, { 'index.html': POMODORO })
    writeFileSync(join(modulesDir, 'secret.json'), '{"token":"不该被读到"}', 'utf8')
    symlinkSync(join(modulesDir, 'secret.json'), join(modulesDir, 'pomodoro', 'leak.json'))

    for (const path of [
      '/modules/pomodoro/../secret.json',
      '/modules/pomodoro/%2e%2e/secret.json',
      '/modules/pomodoro/leak.json',
      '/modules/..%2fsecret.json',
    ]) {
      const res = await fetch(`${url as string}${path}`, { redirect: 'manual' })
      expect(res.status, path).not.toBe(200)
      expect(await res.text(), path).not.toContain('不该被读到')
    }
    // 盘上那份一个字没少。
    expect(readFileSync(join(modulesDir, 'secret.json'), 'utf8')).toContain('不该被读到')
  })

  it('表外的扩展名不给(白名单),不存在的文件 404,两句原因不一样', async () => {
    const { origin, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro', { name: '番茄钟' }, { 'index.html': POMODORO, 'run.sh': 'rm -rf /' })
    const type = await fetch(`${origin as string}/modules/pomodoro/run.sh`)
    expect(type.status).toBe(400)
    expect((await type.json() as { error: string }).error).toBe('这种文件不给')
    // 不存在的文件回的是一句人话的 HTML,不是 json —— 那一格要么是页面要么是白屏,
    // 白屏是这一档最难查的故障(见 moduleOrigin.ts 的 sendNotice)。
    const missing = await fetch(`${origin as string}/modules/pomodoro/nope.html`)
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('模块里没有这个文件')
  })
})

describe('移除与恢复', () => {
  it('★移除 = 搬进 .trash,文件一个字节都没删;恢复回来照样打得开', async () => {
    const { url, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro', { name: '番茄钟' }, { 'index.html': POMODORO })
    const before = (await state(url)).modules?.[0]?.frame_url as string
    expect((await post(url, '/modules/pomodoro/remove', {})).body).toEqual({ ok: true })
    expect(readFileSync(join(modulesDir, '.trash', 'pomodoro', 'index.html'), 'utf8')).toBe(POMODORO)
    // 移走之后:盘上那份还在(回收站里),但这条路端不出来了。
    expect((await fetch(before)).status).toBe(404)

    expect((await post(url, '/modules/pomodoro/restore', {})).body).toEqual({ ok: true })
    const after = (await state(url)).modules?.[0]?.frame_url as string
    expect(after).not.toBe(before)                       // 新的一把
    expect((await fetch(after)).status).toBe(200)
  })

  it('拒绝是 200 + 一句人话(同 /scene/save 那套),不是接口错', async () => {
    const { url } = await serve()
    const gone = await post(url, '/modules/nothing/remove', {})
    expect(gone.status).toBe(200)
    expect(gone.body).toMatchObject({ ok: false, error: '没有这个模块' })
  })

  it('认不出的 id → 400;认不出的动作 → 404', async () => {
    const { url } = await serve()
    expect((await post(url, '/modules/..%2f..%2fetc/remove', {})).status).toBe(400)
    expect((await post(url, '/modules/pomodoro/delete', {})).status).toBe(404)
  })
})

describe('认出「开发一个小工具」那句话', () => {
  it('★认出来那一刻:一张卡都没建、一条会话都没开、盘上一个字节都没写', async () => {
    const { url, modulesDir } = await serve()
    const res = await post(url, '/butler/item', { text: `${DEV_TOOL_DRAFT}一个番茄钟,25 分钟一轮` })
    expect(res.body.ok).toBe(true)
    expect(res.body.note).toBe('先确认一下我理解得对不对')

    const snapshot = await state(url)
    expect(snapshot.tasks?.tasks).toEqual([])          // 没建卡
    expect(openedFirstMessages).toEqual([])            // 没开会话
    expect(snapshot.modules).toEqual([])               // 盘上没有模块
    // 待确认那一条进了 /state,界面据此摆确认卡。
    expect(snapshot.dev_tool?.pending).toHaveLength(1)
    expect(snapshot.dev_tool?.pending[0]?.restate).toBe('一个番茄钟,25 分钟一轮')
    expect(snapshot.dev_tool?.pending[0]?.module_id).toMatch(/^tool-[0-9a-z]{6}$/)
    // 没接草图端口 → 整条缺席,不拿模板话冒充。
    expect(snapshot.dev_tool?.pending[0]?.sketch).toBeUndefined()
    expect(modulesDir).toContain('modules')
  })

  it('★光点了按钮没接着说:如实要他再说一句,不替他编一个需求', async () => {
    const { url } = await serve()
    const res = await post(url, '/butler/item', { text: DEV_TOOL_DRAFT })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('还没说它要做什么')
    expect((await state(url)).dev_tool?.pending).toEqual([])
  })

  it('★普通事项一个字不变地照旧走原来那条路(建卡 + 开会话)', async () => {
    const { url } = await serve()
    await post(url, '/butler/item', { text: '把上周的账单核一遍' })
    expect((await state(url)).tasks?.tasks.map(t => t.title)).toEqual(['把上周的账单核一遍'])
    expect(openedFirstMessages).toHaveLength(1)
    expect((await state(url)).dev_tool?.pending).toEqual([])
  })

  it('没接 devTool 时:那句话就是一条普通事项(这块功能之前的行为)', async () => {
    const { url } = await serve({ withDevTool: false })
    await post(url, '/butler/item', { text: `${DEV_TOOL_DRAFT}一个番茄钟` })
    expect((await state(url)).tasks?.tasks).toHaveLength(1)
    expect((await state(url)).dev_tool).toBeUndefined()
  })
})

describe('确认之后才派出去', () => {
  /*
   * ★ 2026-10-01(设计 C2「小组件派出去」):这一条原来叫「确认 → 建卡 + 开会话」——
   * 事务官自己在那条会话里写网页。现在事务官**只写交代 + 验收**,网页派给能写代码的那一家。
   * 专钉这件事的那一份在 `tests/server-dev-tool-dispatch.test.ts`;这里只钉「这条路的出口变了」。
   */
  it('★确认 → 建卡 + 派给能写代码的那一家,交代里带着完整的产出规范(事务官不自己写)', async () => {
    const { url, modulesDir } = await serve({ coder: true })
    await post(url, '/butler/item', { text: `${DEV_TOOL_DRAFT}一个番茄钟,25 分钟一轮` })
    const pending = (await state(url)).dev_tool?.pending[0]
    const confirmed = await post(url, '/devtool/confirm', { id: pending?.id, name: '番茄钟' })
    expect(confirmed.status).toBe(200)
    expect(confirmed.body).toMatchObject({ ok: true, module_id: pending?.module_id, name: '番茄钟', dispatch_ok: true })

    // 事务官自己那条会话**一条都没开**。
    expect(openedFirstMessages).toEqual([])
    expect(dispatchedBriefs).toHaveLength(1)
    const first = dispatchedBriefs[0] as string
    expect(first).toContain('一个番茄钟,25 分钟一轮')
    expect(first).toContain(join(modulesDir, String(pending?.module_id)))
    expect(first).toContain('不许引任何外网地址')
    expect(first).toContain('不给凭据、不给 shell')
    // 卡建下来了,而且走的是既有那条「我交给事务官」(direction:'mine')。
    expect((await state(url)).tasks?.tasks[0]).toMatchObject({ direction: 'mine', status: 'doing' })
    // 确认掉的那一条不再挂在待确认里。
    expect((await state(url)).dev_tool?.pending).toEqual([])
  })

  it('★这台电脑上没有能写代码的 Agent:如实说,需求留着,不退回让事务官自己写', async () => {
    const { url } = await serve({ coder: false })
    await post(url, '/butler/item', { text: `${DEV_TOOL_DRAFT}一个番茄钟` })
    const pending = (await state(url)).dev_tool?.pending[0]
    const res = await post(url, '/devtool/confirm', { id: pending?.id, name: '番茄钟' })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toBe(NO_CODER_FOR_MODULE)
    expect(openedFirstMessages).toEqual([])
    expect(dispatchedBriefs).toEqual([])
    expect((await state(url)).tasks?.tasks).toEqual([])
    expect((await state(url)).dev_tool?.pending).toHaveLength(1)
  })

  it('★没起名字就不确认(标签上要写字)', async () => {
    const { url } = await serve()
    await post(url, '/butler/item', { text: `${DEV_TOOL_DRAFT}一个番茄钟` })
    const pending = (await state(url)).dev_tool?.pending[0]
    const res = await post(url, '/devtool/confirm', { id: pending?.id, name: '  ' })
    expect(res.status).toBe(400)
    // 需求还在,他能补个名字再点一次。
    expect((await state(url)).dev_tool?.pending).toHaveLength(1)
    expect(openedFirstMessages).toEqual([])
  })

  it('★「不做了」:就地作废,一张卡都不留', async () => {
    const { url } = await serve()
    await post(url, '/butler/item', { text: `${DEV_TOOL_DRAFT}一个番茄钟` })
    const pending = (await state(url)).dev_tool?.pending[0]
    expect((await post(url, '/devtool/cancel', { id: pending?.id })).body).toEqual({ ok: true })
    expect((await state(url)).dev_tool?.pending).toEqual([])
    expect((await state(url)).tasks?.tasks).toEqual([])
    expect(openedFirstMessages).toEqual([])
  })

  it('认不出的 id → 404(不静默成功)', async () => {
    const { url } = await serve()
    expect((await post(url, '/devtool/confirm', { id: '不存在', name: 'x' })).status).toBe(404)
    expect((await post(url, '/devtool/cancel', { id: '不存在' })).status).toBe(404)
  })

  it('★草图端口接上了就有草图(这一版 index.ts 没接,所以这里打桩验通路)', async () => {
    const dir = tmpDir()
    const modulesDir = join(dir, 'modules')
    mkdirSync(modulesDir, { recursive: true })
    const store = createDevToolStore({ file: join(dir, 'dev-tools.json') })
    await store.load()
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      tasks: createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => 't-1' }),
      modules: createCustomModulesService({ dir: modulesDir }),
      devTool: { store, modulesDir, sketch: async need => `满屏一个大圆环,中间是剩余分钟数(${need})` },
    })
    started.push(server)
    await post(server.url, '/butler/item', { text: `${DEV_TOOL_DRAFT}一个番茄钟` })
    const snapshot = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(snapshot.dev_tool?.pending[0]?.sketch).toBe('满屏一个大圆环,中间是剩余分钟数(一个番茄钟)')
  })

  it('★草图端口抛了不影响主线:没有草图,需求照样记下', async () => {
    const dir = tmpDir()
    const modulesDir = join(dir, 'modules')
    mkdirSync(modulesDir, { recursive: true })
    const store = createDevToolStore({ file: join(dir, 'dev-tools.json') })
    await store.load()
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      tasks: createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => 't-1' }),
      devTool: { store, modulesDir, sketch: async () => { throw new Error('模型没应答') } },
    })
    started.push(server)
    const res = await post(server.url, '/butler/item', { text: `${DEV_TOOL_DRAFT}一个番茄钟` })
    expect(res.body.ok).toBe(true)
    const snapshot = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(snapshot.dev_tool?.pending).toHaveLength(1)
    expect(snapshot.dev_tool?.pending[0]?.sketch).toBeUndefined()
  })
})

describe('切模板不动自定义模块', () => {
  it('★切到运营模板:布局换了,自定义模块一格都没动,文件一个字节都没碰', async () => {
    const dir = tmpDir()
    const modulesDir = join(dir, 'modules')
    mkdirSync(modulesDir, { recursive: true })
    seedModule(modulesDir, 'pomodoro', { name: '番茄钟', created_at: '2026-09-21T10:00:00+08:00' }, { 'index.html': POMODORO })
    let layout: WorkbenchLayout | undefined = {
      modules: [],
      butler: { corner: 'br', min: false },
      landscape: { modules: DEFAULT_LANDSCAPE_MODULES.map(m => ({ ...m })) },
    }
    // ops 模板从用户层来(2026-10-23,分层二刀二):真实 UserLayer 服务(起步层=仓库真文件)
    // ensure→scan,provider 与全局来源同一份快照;不在夹具里另造 ops 配置。
    const userLayer = await startRealUserLayer(join(dir, '用户层'))
    const template = createTemplateService({
      file: join(dir, 'template.json'),
      backupsDir: join(dir, 'backups'),
      readLayout: () => Promise.resolve(layout),
      writeLayout: (next) => { layout = next; return Promise.resolve() },
      templates: () => userLayer.layoutTemplates(),
    })
    await template.load()
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      template,
      modules: createCustomModulesService({ dir: modulesDir }),
      moduleOrigin: { port: 0 },
    })
    started.push(server)

    const before = (await (await fetch(`${server.url}/state`)).json() as WorkbenchState).modules
    const applied = await post(server.url, '/template/apply', { id: 'ops' })
    expect(applied.body.ok).toBe(true)

    const after = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    // 模板确实换了(证明这一条不是因为 apply 压根没生效才"没动")。
    expect(after.template?.id).toBe('ops')
    // 自定义模块那一份逐字相同,文件照样端得出来。
    expect(after.modules).toEqual(before)
    expect(await (await fetch(after.modules?.[0]?.frame_url as string)).text()).toContain('25:00')
  })
})
