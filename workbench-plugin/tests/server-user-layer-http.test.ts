// @vitest-environment node
/**
 * 用户层的四条路(2026-10-21,卡「分层第一刀」):
 *
 *   GET  /state.user_layer                  客户端据此装哪几格(清单 + 指纹)
 *   GET  /user-layer                        设置里那一节:目录、骨架、清单、能替哪几格、插件清单
 *   GET  /user-layer/widgets/<id>/code      一格的入口代码(只端清单过了的那一份)
 *   POST /user-layer/reveal                 在访达里打开用户层目录
 *
 * 门:后三条只认本机(它们说的是这台 Mac 的一个目录);网页小组件的令牌一条都打不到。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createCustomModulesService } from '../src/server/modules.ts'
import { createModuleTokens } from '../src/server/moduleOrigin.ts'
import { FAMILY_PLUGINS, USER_LAYER_CONTRACT, USER_LAYER_CONTRACT_FILE, createUserLayerService } from '../src/server/userLayer.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { readFileSync } from 'node:fs'
import { STARTER_LAYOUTS_DIR } from './helpers/starterLayer.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

async function serve(opts: { withLayer?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wb-user-layer-http-'))
  dirs.push(home)
  const opened: string[][] = []
  const userLayer = createUserLayerService({
    dir: join(home, '用户层'),
    runCommand: async (cmd) => { opened.push([...cmd]); return { ok: true, stdout: '' } },
  })
  await userLayer.ensure()
  const widget = join(home, '用户层', '小组件', 'files')
  mkdirSync(widget, { recursive: true })
  writeFileSync(join(widget, 'widget.json'), JSON.stringify({ contract: 1, id: 'files', name: '素材管理', replaces: 'files', export: 'FilesModule' }), 'utf8')
  writeFileSync(join(widget, 'index.js'), 'module.exports = { FilesModule: () => null }', 'utf8')
  const broken = join(home, '用户层', '小组件', 'notes')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'widget.json'), '{ 坏的', 'utf8')
  // 布局模板:起步层那一份真文件(2026-10-23,分层二刀二)。
  const layouts = join(home, '用户层', '布局')
  mkdirSync(layouts, { recursive: true })
  writeFileSync(join(layouts, 'ops.json'), readFileSync(join(STARTER_LAYOUTS_DIR, 'ops.json'), 'utf8'), 'utf8')
  writeFileSync(join(layouts, 'ops.css'), readFileSync(join(STARTER_LAYOUTS_DIR, 'ops.css'), 'utf8'), 'utf8')
  // 快照打底(与 index.ts 同款):模板/皮肤那几处同步读的是 scan() 刷新的快照。
  await userLayer.scan()
  const tokens = createModuleTokens()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    modules: createCustomModulesService({ dir: userLayer.webWidgetsDir }),
    moduleOrigin: { port: 0, tokens },
    ...(opts.withLayer === false ? {} : { userLayer }),
  })
  started.push(server)
  return { url: server.url, tokens, opened, dir: userLayer.dir }
}

const asModule = (token: string) => ({ origin: 'null', authorization: `Bearer ${token}` })

describe('/state.user_layer', () => {
  it('★清单进 /state:好的带指纹,坏的带人话', async () => {
    const { url } = await serve()
    const state = await (await fetch(`${url}/state`)).json() as Record<string, any>
    expect(state.user_layer.contract).toBe(USER_LAYER_CONTRACT)
    const files = state.user_layer.widgets.find((one: any) => one.id === 'files')
    expect(files).toMatchObject({ status: 'ok', replaces: 'files', export: 'FilesModule' })
    expect(files.rev).toMatch(/^[0-9a-f]{12}$/)
    const notes = state.user_layer.widgets.find((one: any) => one.id === 'notes')
    expect(notes.status).toBe('broken')
    expect(notes.problem).toMatch(/widget\.json/)
    // 目录路径不进 /state(一秒一拍、手机也读):设置那一节自己拉 /user-layer。
    expect(JSON.stringify(state.user_layer)).not.toContain('用户层')
  })

  it('没接用户层:整块缺席', async () => {
    const { url } = await serve({ withLayer: false })
    const state = await (await fetch(`${url}/state`)).json() as Record<string, unknown>
    expect(state.user_layer).toBeUndefined()
  })
})

describe('GET /user-layer', () => {
  it('★目录、骨架、能替哪几格、四族插件清单', async () => {
    const { url, dir } = await serve()
    const res = await fetch(`${url}/user-layer`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, any>
    expect(body.dir).toBe(dir)
    expect(body.web_widgets_dir).toBe(join(dir, '网页小组件'))
    expect(body.folders.map((one: any) => one.name)).toContain('插件')
    expect(body.slots.map((one: any) => one.id)).toEqual(['notes', 'files', 'todo', 'publish', 'review', 'usage-panel'])
    expect(body.plugins.map((one: any) => one.name)).toEqual(FAMILY_PLUGINS.map(one => one.name))
    expect(body.plugins.every((one: any) => one.where === 'built-in')).toBe(true)
    expect(body.widgets).toHaveLength(2)
  })

  it('没接:404', async () => {
    const { url } = await serve({ withLayer: false })
    expect((await fetch(`${url}/user-layer`)).status).toBe(404)
  })

  it('网页小组件的令牌打不到(不在九条里)', async () => {
    const { url, tokens } = await serve()
    const res = await fetch(`${url}/user-layer`, { headers: asModule(tokens.issue('pomodoro')) })
    expect(res.status).toBe(403)
  })
})

describe('GET /user-layer/widgets/<id>/code', () => {
  it('★好的那一格:端出入口代码', async () => {
    const { url } = await serve()
    const res = await fetch(`${url}/user-layer/widgets/files/code`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect(await res.text()).toBe('module.exports = { FilesModule: () => null }')
  })

  it('坏的 / 没有的 / 怪名字:404', async () => {
    const { url } = await serve()
    for (const id of ['notes', 'nope', '..%2Fetc']) {
      expect((await fetch(`${url}/user-layer/widgets/${id}/code`)).status, id).toBe(404)
    }
  })

  it('网页小组件的令牌打不到', async () => {
    const { url, tokens } = await serve()
    const res = await fetch(`${url}/user-layer/widgets/files/code`, { headers: asModule(tokens.issue('pomodoro')) })
    expect(res.status).toBe(403)
  })
})

describe('布局模板(2026-10-23,分层二刀二)', () => {
  it('/state.user_layer.layouts 列出 ops:ok + 模板指纹 + 皮肤指纹', async () => {
    const { url } = await serve()
    const state = await (await fetch(`${url}/state`)).json() as { user_layer?: { layouts?: { id: string, status: string, rev?: string, skin_rev?: string }[] } }
    const ops = state.user_layer?.layouts?.find(one => one.id === 'ops')
    expect(ops?.status).toBe('ok')
    expect(ops?.rev).toMatch(/^[0-9a-f]{12}$/)
    expect(ops?.skin_rev).toMatch(/^[0-9a-f]{12}$/)
  })

  it('GET /user-layer/layouts/<id>/skin 回 css 原文;text/css', async () => {
    const { url } = await serve()
    const res = await fetch(`${url}/user-layer/layouts/ops/skin`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
    expect(await res.text()).toBe(readFileSync(join(STARTER_LAYOUTS_DIR, 'ops.css'), 'utf8'))
  })

  it('没有这个模板 / 它坏了 → 404', async () => {
    const { url, dir } = await serve()
    expect((await fetch(`${url}/user-layer/layouts/nope/skin`)).status).toBe(404)
    writeFileSync(join(dir, '布局', 'ops.json'), '{ 坏的', 'utf8')
    // 下一拍扫描把它标成 broken(这里用 GET /user-layer 触发一次 scan;真机上一秒一拍)。
    await fetch(`${url}/user-layer`)
    expect((await fetch(`${url}/user-layer/layouts/ops/skin`)).status).toBe(404)
  })
})

describe('POST /user-layer/reveal', () => {
  it('★在访达里打开用户层目录', async () => {
    const { url, opened, dir } = await serve()
    const res = await fetch(`${url}/user-layer/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(opened).toEqual([['open', dir]])
  })

  it('网页小组件的令牌打不到,一条命令都不跑', async () => {
    const { url, tokens, opened } = await serve()
    const res = await fetch(`${url}/user-layer/reveal`, { method: 'POST', headers: { ...asModule(tokens.issue('pomodoro')), 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(403)
    expect(opened).toEqual([])
  })
})

describe('POST /user-layer/report', () => {
  it('★页面报画好了 → 存成上一版;再报新的坏了 → /state 端回上一版并说原因', async () => {
    const { url, dir } = await serve()
    const rev1 = ((await (await fetch(`${url}/state`)).json()) as any).user_layer.widgets.find((one: any) => one.id === 'files').rev
    const report = async (body: unknown) => await fetch(`${url}/user-layer/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await report({ id: 'files', rev: rev1, ok: true })).status).toBe(200)
    writeFileSync(join(dir, '小组件', 'files', 'index.js'), 'module.exports = { FilesModule: () => "v2" }', 'utf8')
    const rev2 = ((await (await fetch(`${url}/state`)).json()) as any).user_layer.widgets.find((one: any) => one.id === 'files').rev
    await report({ id: 'files', rev: rev2, ok: false, problem: '画这一格时出错:x' })
    const files = ((await (await fetch(`${url}/state`)).json()) as any).user_layer.widgets.find((one: any) => one.id === 'files')
    expect(files).toMatchObject({ status: 'ok', rev: rev1 })
    expect(files.rolled_back).toContain('画这一格时出错')
    expect(await (await fetch(`${url}/user-layer/widgets/files/code`)).text()).toBe('module.exports = { FilesModule: () => null }')
  })

  it('形状不对:400', async () => {
    const { url } = await serve()
    const res = await fetch(`${url}/user-layer/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"files"}' })
    expect(res.status).toBe(400)
  })
})

describe('POST /user-layer/fix(自愈:派一家去改用户层,工作区只开到用户层目录)', () => {
  it('★交代带着用户层目录与契约,命令行那只手在用户层目录里起、只放行这一个目录', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-user-layer-fix-'))
    dirs.push(home)
    const userLayer = createUserLayerService({ dir: join(home, '用户层') })
    await userLayer.ensure()
    const ran: { argv: readonly string[], cwd?: string }[] = []
    const engineRig = engineHarness({ connected: () => false })
    const server = await startWorkbenchServer({
      engine: engineRig.engine,
      engineRegistry: engineRig.registry,
      port: 0,
      service: createWorkbenchService({}),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      tasks: createTasksService({ file: join(home, 'tasks.json'), newId: () => 't-1' }),
      userLayer,
      appInstalled: () => true,
      dispatchRun: {
        runCli: (cmd) => {
          ran.push({ argv: cmd.argv, ...(cmd.cwd === undefined ? {} : { cwd: cmd.cwd }) })
          return { pid: 4321, exited: new Promise<{ code: number | null }>(() => {}) }
        },
        resolveCli: family => ({ found: true, family, bin: `/fake/${family}`, source: 'bundled' }),
        resultDir: home,
      },
    })
    started.push(server)
    const res = await fetch(`${server.url}/user-layer/fix`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ said: '素材管理按名字排' }) })
    const body = await res.json() as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(body.dispatch_ok).toBe(true)
    expect(ran).toHaveLength(1)
    const argv = ran[0]!.argv.join('\n')
    expect(argv).toContain('素材管理按名字排')
    expect(argv).toContain(`${userLayer.dir}/${USER_LAYER_CONTRACT_FILE}`)
    // 工作区就是用户层目录:Codex 的 -C / Claude 的 --add-dir 指的都是它,不是本体、也不是她的某个仓库。
    expect(ran[0]!.cwd ?? argv).toContain(userLayer.dir)
    expect(argv).toMatch(new RegExp(`(-C|--add-dir)\\n${userLayer.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  it('一句话都没说:400', async () => {
    const { url } = await serve()
    const res = await fetch(`${url}/user-layer/fix`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"said":""}' })
    expect(res.status).toBe(400)
  })

  it('网页小组件的令牌打不到', async () => {
    const { url, tokens } = await serve()
    const res = await fetch(`${url}/user-layer/fix`, { method: 'POST', headers: { ...asModule(tokens.issue('pomodoro')), 'content-type': 'application/json' }, body: '{"said":"x"}' })
    expect(res.status).toBe(403)
  })
})
