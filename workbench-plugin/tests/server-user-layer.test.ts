// @vitest-environment node
/**
 * 用户层的加载口 · 服务端那一半(2026-10-21,卡「分层第一刀」;设计 `docs/设计-分层第一刀-2026-10-21.md`)。
 *
 * 钉四件事:
 *   ① 骨架:目录缺才建,说明缺才写;第一次建目录时放进起步层,之后一个字不动;老的 `modules/` 搬进「网页小组件」;
 *   ② 清单:`小组件/<id>/widget.json` 逐个读,坏的**跳过并给一句人话**,不连累别的;
 *   ③ 代码:只端清单过了的那一份入口文件,路径不从外面拼;
 *   ④ 打开目录:跑的是 `open <用户层目录>`,不是别的命令。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_API,
  USER_LAYER_CONTRACT,
  USER_LAYER_CONTRACT_FILE,
  USER_LAYER_FOLDERS,
  WIDGET_SLOTS,
  createUserLayerService,
  defaultUserLayerDir,
  userLayerFixBrief,
} from '../src/server/userLayer.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-user-layer-'))
  dirs.push(dir)
  return dir
}

function writeWidget(root: string, id: string, manifest: unknown, code = 'module.exports = { W: function W() { return null } }', entry = 'index.js'): void {
  const dir = join(root, '小组件', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'widget.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8')
  writeFileSync(join(dir, entry), code, 'utf8')
}

const GOOD = { contract: 1, id: 'files', name: '素材管理', replaces: 'files', entry: 'index.js', export: 'W' }

describe('目录与骨架', () => {
  it('默认目录在 ~/.dsh/workbench/用户层', () => {
    expect(defaultUserLayerDir('/Users/x')).toBe('/Users/x/.dsh/workbench/用户层')
  })

  it('★目录缺席:建出六个子目录 + 说明,并放进起步层(只这一次)', async () => {
    const home = tmp()
    const starter = tmp()
    writeWidget(starter, 'files', GOOD)
    const service = createUserLayerService({ dir: join(home, '用户层'), starterDir: starter })
    const first = await service.ensure()
    expect(first.created).toBe(true)
    expect(first.seeded).toEqual(['files'])
    for (const folder of USER_LAYER_FOLDERS) expect(existsSync(join(home, '用户层', folder.name))).toBe(true)
    expect(existsSync(join(home, '用户层', '说明.md'))).toBe(true)
    expect(readFileSync(join(home, '用户层', '小组件', 'files', 'widget.json'), 'utf8')).toContain('素材管理')
  })

  it('目录已在:不再放起步层(她删掉的那一格不会自己长回来),她改过的说明一个字不动', async () => {
    const home = tmp()
    const starter = tmp()
    writeWidget(starter, 'files', GOOD)
    const root = join(home, '用户层')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '说明.md'), '我自己写的', 'utf8')
    const service = createUserLayerService({ dir: root, starterDir: starter })
    const again = await service.ensure()
    expect(again.created).toBe(false)
    expect(again.seeded).toEqual([])
    expect(existsSync(join(root, '小组件', 'files'))).toBe(false)
    expect(readFileSync(join(root, '说明.md'), 'utf8')).toBe('我自己写的')
    // 缺的子目录照样补上
    expect(existsSync(join(root, '插件'))).toBe(true)
  })

  it('没有起步层(开发机没构建过)也照常建骨架', async () => {
    const home = tmp()
    const service = createUserLayerService({ dir: join(home, '用户层'), starterDir: join(home, '没有这个目录') })
    const made = await service.ensure()
    expect(made.created).toBe(true)
    expect(made.seeded).toEqual([])
    expect(readdirSync(join(home, '用户层', '小组件'))).toEqual([])
  })

  it('老的 modules/ 在、网页小组件/ 还没有:整个搬进来(搬,不删)', async () => {
    const home = tmp()
    const legacy = join(home, 'modules')
    mkdirSync(join(legacy, 'pomodoro'), { recursive: true })
    writeFileSync(join(legacy, 'pomodoro', 'module.json'), '{"name":"番茄钟"}', 'utf8')
    const service = createUserLayerService({ dir: join(home, '用户层'), legacyModulesDir: legacy })
    const made = await service.ensure()
    expect(made.movedLegacyModules).toBe(true)
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(service.webWidgetsDir, 'pomodoro', 'module.json'), 'utf8')).toContain('番茄钟')
  })

  it('两边都有:一个都不动,如实说一句', async () => {
    const home = tmp()
    const legacy = join(home, 'modules')
    mkdirSync(join(legacy, 'a'), { recursive: true })
    const root = join(home, '用户层')
    mkdirSync(join(root, '网页小组件', 'b'), { recursive: true })
    const service = createUserLayerService({ dir: root, legacyModulesDir: legacy })
    const made = await service.ensure()
    expect(made.movedLegacyModules).toBe(false)
    expect(existsSync(join(legacy, 'a'))).toBe(true)
    expect(existsSync(join(root, '网页小组件', 'b'))).toBe(true)
    expect(made.note).toMatch(/modules/)
  })
})

describe('清单:按 widget.json 装,坏了跳过并说人话', () => {
  async function scanWith(setup: (root: string) => void) {
    const root = join(tmp(), '用户层')
    const service = createUserLayerService({ dir: root })
    await service.ensure()
    setup(root)
    return await service.scan()
  }

  it('空目录:一个都没有,契约版本照报', async () => {
    const view = await scanWith(() => {})
    expect(view.contract).toBe(USER_LAYER_CONTRACT)
    expect(view.widgets).toEqual([])
  })

  it('★好的那一份:ok,带上替哪一格、导出名与内容指纹', async () => {
    const view = await scanWith(root => writeWidget(root, 'files', { ...GOOD, author: '运营同学', version: '2026-10-21' }))
    expect(view.widgets).toHaveLength(1)
    const one = view.widgets[0]!
    expect(one).toMatchObject({ id: 'files', name: '素材管理', replaces: 'files', export: 'W', status: 'ok', author: '运营同学', version: '2026-10-21' })
    expect(one.rev).toMatch(/^[0-9a-f]{12}$/)
    expect(one.problem).toBeUndefined()
  })

  it('改了代码,指纹跟着变(客户端据此重装)', async () => {
    const root = join(tmp(), '用户层')
    const service = createUserLayerService({ dir: root })
    await service.ensure()
    writeWidget(root, 'files', GOOD, 'module.exports = { W: () => null }')
    const before = (await service.scan()).widgets[0]!.rev
    writeFileSync(join(root, '小组件', 'files', 'index.js'), 'module.exports = { W: () => "改过" }', 'utf8')
    const after = (await service.scan()).widgets[0]!.rev
    expect(after).not.toBe(before)
  })

  it('widget.json 不是 JSON:broken,一句人话,别的照装', async () => {
    const view = await scanWith((root) => {
      writeWidget(root, 'files', '{ 这不是 json')
      writeWidget(root, 'notes', { ...GOOD, id: 'notes', name: '随手记', replaces: 'notes' })
    })
    const files = view.widgets.find(one => one.id === 'files')!
    expect(files.status).toBe('broken')
    expect(files.problem).toMatch(/widget\.json/)
    expect(view.widgets.find(one => one.id === 'notes')!.status).toBe('ok')
  })

  it('替的那一格本体没开:说出能替哪几格', async () => {
    const view = await scanWith(root => writeWidget(root, 'files', { ...GOOD, replaces: 'quota' }))
    const one = view.widgets[0]!
    expect(one.status).toBe('broken')
    for (const slot of WIDGET_SLOTS) expect(one.problem).toContain(slot.name)
  })

  it('按更新的契约写的:先更新工作台', async () => {
    const view = await scanWith(root => writeWidget(root, 'files', { ...GOOD, contract: USER_LAYER_CONTRACT + 1 }))
    expect(view.widgets[0]!.status).toBe('broken')
    expect(view.widgets[0]!.problem).toMatch(/更新工作台/)
  })

  it('入口文件不在:说找不到哪个文件', async () => {
    const view = await scanWith((root) => {
      writeWidget(root, 'files', { ...GOOD, entry: 'main.js' })
    })
    expect(view.widgets[0]!.status).toBe('broken')
    expect(view.widgets[0]!.problem).toContain('main.js')
  })

  it('入口想往目录外面指(../ 或绝对路径或不是 .js):不认', async () => {
    for (const entry of ['../x.js', '/etc/passwd', 'a/b.js', 'index.html']) {
      const view = await scanWith(root => writeWidget(root, 'files', { ...GOOD, entry }))
      expect(view.widgets[0]!.status, entry).toBe('broken')
    }
  })

  it('目录名和 id 对不上:不认(免得两份抢一个名字)', async () => {
    const view = await scanWith(root => writeWidget(root, 'files', { ...GOOD, id: 'other' }))
    expect(view.widgets[0]!.status).toBe('broken')
    expect(view.widgets[0]!.problem).toMatch(/目录名/)
  })

  it('两份替同一格:按目录名先到的那份在用,另一份跳过并说清楚', async () => {
    const view = await scanWith((root) => {
      writeWidget(root, 'files', GOOD)
      writeWidget(root, 'files-2', { ...GOOD, id: 'files-2', name: '素材管理 · 新版' })
    })
    expect(view.widgets.find(one => one.id === 'files')!.status).toBe('ok')
    const second = view.widgets.find(one => one.id === 'files-2')!
    expect(second.status).toBe('broken')
    expect(second.problem).toContain('素材管理')
  })

  it('不合规的目录名(隐藏、大写、中文)不当小组件,也不报 —— 回收站之类的自己的东西', async () => {
    const view = await scanWith((root) => {
      mkdirSync(join(root, '小组件', '.trash'), { recursive: true })
      mkdirSync(join(root, '小组件', '草稿'), { recursive: true })
    })
    expect(view.widgets).toEqual([])
  })

  it('只认模板里的那几种:templates 字段原样带出', async () => {
    const view = await scanWith(root => writeWidget(root, 'usage', { ...GOOD, id: 'usage', replaces: 'usage-panel', templates: ['ops'] }))
    expect(view.widgets[0]).toMatchObject({ status: 'ok', templates: ['ops'] })
  })
})

describe('代码与打开目录', () => {
  it('★只端清单过了的那一份入口文件', async () => {
    const root = join(tmp(), '用户层')
    const service = createUserLayerService({ dir: root })
    await service.ensure()
    writeWidget(root, 'files', GOOD, 'module.exports = { W: () => "files" }')
    writeWidget(root, 'notes', { ...GOOD, id: 'notes', replaces: 'quota' })
    const hit = await service.widgetCode('files')
    expect(hit?.code).toBe('module.exports = { W: () => "files" }')
    expect(hit?.rev).toMatch(/^[0-9a-f]{12}$/)
    expect(await service.widgetCode('notes')).toBeUndefined()
    expect(await service.widgetCode('../etc')).toBeUndefined()
    expect(await service.widgetCode('nope')).toBeUndefined()
  })

  it('打开目录:先把目录建好,再跑 open <目录>', async () => {
    const root = join(tmp(), '用户层')
    const ran: string[][] = []
    const service = createUserLayerService({ dir: root, runCommand: async (cmd) => { ran.push([...cmd]); return { ok: true, stdout: '' } } })
    const opened = await service.reveal()
    expect(opened.ok).toBe(true)
    expect(existsSync(root)).toBe(true)
    expect(ran).toEqual([['open', root]])
  })

  it('Finder 没应答:如实说', async () => {
    const root = join(tmp(), '用户层')
    const service = createUserLayerService({ dir: root, runCommand: async () => ({ ok: false, stdout: '' }) })
    const opened = await service.reveal()
    expect(opened).toEqual({ ok: false, reason: 'Finder 没有响应' })
  })
})

describe('契约文件:放在目录里,coding agent 读了就知道能改什么(10-21 统筹补的硬要求 ①)', () => {
  it('★ensure 写出 契约.md:能替哪几格、清单字段、接口表、不许碰的', async () => {
    const root = join(tmp(), '用户层')
    const service = createUserLayerService({ dir: root })
    await service.ensure()
    const text = readFileSync(join(root, USER_LAYER_CONTRACT_FILE), 'utf8')
    for (const slot of WIDGET_SLOTS) expect(text).toContain(slot.id)
    for (const group of Object.keys(HOST_API)) expect(text).toContain(group)
    expect(text).toContain('widget.json')
    expect(text).toMatch(/只改这个目录/)
    expect(text).toContain(`第 ${USER_LAYER_CONTRACT} 版`)
  })

  it('契约是本体写的:每次起服务按本体这一版重写(她的 说明.md 不动)', async () => {
    const root = join(tmp(), '用户层')
    const service = createUserLayerService({ dir: root })
    await service.ensure()
    writeFileSync(join(root, USER_LAYER_CONTRACT_FILE), '旧的', 'utf8')
    await service.ensure()
    expect(readFileSync(join(root, USER_LAYER_CONTRACT_FILE), 'utf8')).not.toBe('旧的')
  })
})

describe('坏了自动回上一版(只在用户层里;不动她改的那份文件)', () => {
  async function layer() {
    const root = join(tmp(), '用户层')
    const service = createUserLayerService({ dir: root })
    await service.ensure()
    writeWidget(root, 'files', GOOD, 'module.exports = { W: () => "v1" }')
    const v1 = (await service.scan()).widgets[0]!.rev!
    return { root, service, v1 }
  }

  it('★v1 画好了(页面报 ok)→ v2 在页面上坏了 → 端回 v1,清单里说清原因;她的 v2 文件原样在', async () => {
    const { root, service, v1 } = await layer()
    await service.report({ id: 'files', rev: v1, ok: true })
    writeFileSync(join(root, '小组件', 'files', 'index.js'), 'module.exports = { W: () => "v2" }', 'utf8')
    const v2 = (await service.scan()).widgets[0]!.rev!
    expect(v2).not.toBe(v1)
    await service.report({ id: 'files', rev: v2, ok: false, problem: '画这一格时出错:x' })
    const after = (await service.scan()).widgets[0]!
    expect(after).toMatchObject({ status: 'ok', rev: v1 })
    expect(after.rolled_back).toContain('画这一格时出错')
    expect((await service.widgetCode('files'))?.code).toContain('"v1"')
    expect(readFileSync(join(root, '小组件', 'files', 'index.js'), 'utf8')).toContain('"v2"')
  })

  it('清单写坏了也回上一版', async () => {
    const { root, service, v1 } = await layer()
    await service.report({ id: 'files', rev: v1, ok: true })
    writeFileSync(join(root, '小组件', 'files', 'widget.json'), '{ 坏', 'utf8')
    const after = (await service.scan()).widgets[0]!
    expect(after).toMatchObject({ status: 'ok', rev: v1 })
    expect(after.rolled_back).toMatch(/widget\.json/)
  })

  it('改好了(新指纹)就换上新的,不再用上一版', async () => {
    const { root, service, v1 } = await layer()
    await service.report({ id: 'files', rev: v1, ok: true })
    writeFileSync(join(root, '小组件', 'files', 'widget.json'), '{ 坏', 'utf8')
    await service.scan()
    writeFileSync(join(root, '小组件', 'files', 'widget.json'), JSON.stringify(GOOD), 'utf8')
    writeFileSync(join(root, '小组件', 'files', 'index.js'), 'module.exports = { W: () => "v3" }', 'utf8')
    const after = (await service.scan()).widgets[0]!
    expect(after.rev).not.toBe(v1)
    expect(after.rolled_back).toBeUndefined()
  })

  it('从来没画好过(没有上一版):照旧 broken', async () => {
    const { service, v1 } = await layer()
    await service.report({ id: 'files', rev: v1, ok: false, problem: '坏' })
    const after = (await service.scan()).widgets[0]!
    expect(after.status).toBe('broken')
    expect(after.problem).toBe('坏')
  })

  it('上一版也坏了:不来回倒,broken', async () => {
    const { root, service, v1 } = await layer()
    await service.report({ id: 'files', rev: v1, ok: true })
    writeFileSync(join(root, '小组件', 'files', 'index.js'), 'module.exports = { W: () => "v2" }', 'utf8')
    const v2 = (await service.scan()).widgets[0]!.rev!
    await service.report({ id: 'files', rev: v2, ok: false, problem: '新的坏' })
    await service.report({ id: 'files', rev: v1, ok: false, problem: '旧的也坏' })
    const after = (await service.scan()).widgets[0]!
    expect(after.status).toBe('broken')
  })

  it('上一版存在用户层自己的隐藏目录里,不碰本体任何地方', async () => {
    const { root, service, v1 } = await layer()
    await service.report({ id: 'files', rev: v1, ok: true })
    expect(existsSync(join(root, '.上一版', '小组件', 'files', 'index.js'))).toBe(true)
  })
})

describe('派活改用户层:交代只开用户层目录(10-21 统筹补的硬要求 ②)', () => {
  it('★交代里写明只改这个目录、先读契约、本体只读、改完不用重启', () => {
    const brief = userLayerFixBrief('素材管理那一格加个按名字排序', '/Users/x/.dsh/workbench/用户层')
    expect(brief).toContain('素材管理那一格加个按名字排序')
    expect(brief).toContain('/Users/x/.dsh/workbench/用户层')
    expect(brief).toContain(USER_LAYER_CONTRACT_FILE)
    expect(brief).toMatch(/之外.*一个文件都不改|只读/)
    expect(brief).toMatch(/不用重启/)
  })
})
