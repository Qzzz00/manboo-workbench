// @vitest-environment node
/**
 * 布局模板进用户层(2026-10-23,卡「分层第二刀(二)」)。
 *
 * 三件事:
 * 1. `parseLayoutTemplate`(本体只认格式):好文件 / 坏 JSON / contract 太新 / id 不符 /
 *    project_source 非法 / 模块缺字段 / app 缺 url / skin 文件不在 / 路径不合法 —— 逐条人话;
 * 2. **起步层对照**:读真 `user-layer/起步/布局/ops.json` 走真 parser,folders / files 与本体
 *    常量(TOPIC_DIR、OPS_ASSET_DIRS、OPS_FAVORITES_REL)逐项相等(读源头比对,不逐字抄),
 *    board_lanes 长度 8;
 * 3. 服务那一半:scan() 列清单(指纹 / 皮肤指纹)、ensure() 缺才放(她改过的永不覆盖)、
 *    删了 → 模板系统退回 product 并在 detail 里说一句人话。
 *
 * 全部在临时目录里跑,**不碰 ~/.dsh**(同 server-user-layer.test.ts 的规矩)。
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserLayerService, LAYOUT_SEED_MARKER, parseLayoutTemplate } from '../src/server/userLayer.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { OPS_ASSET_DIRS, OPS_FAVORITES_REL, PRODUCT_TEMPLATE, TOPIC_DIR, setWorkbenchTemplateSource } from '../src/templates.ts'
import { loadStarterLayoutTemplate, STARTER_LAYOUTS_DIR, STARTER_LAYER_DIR } from './helpers/starterLayer.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rm(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  // 模块级模板来源是全局状态:每个文件用完复位回默认(product only)。
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE],
    byId: id => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : undefined),
  })
})

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 一个最小的合法布局 JSON(在好文件的基础上改一处来造各种坏)。 */
function goodLayout(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract: 1,
    id: 'demo',
    name: '演示布局',
    tagline: '一条演示',
    project_word: '账号',
    project_empty_line: '还没有。',
    project_source: 'accounts',
    portrait: [{ id: 'slot', order: 0, row: 0, basis_pct: 50 }],
    landscape: [{ id: 'slot', order: 0, row: 0, basis_pct: 50, region: 'deck', hidden: true, col: 0, width_pct: 60, side_pct: 22 }],
    apps: [{ kind: 'web', key: 't-x', label: '某网页', url: 'https://x.example/' }],
    folders: [{ rel: '素材/脚本', purpose: '脚本' }],
    files: ['素材/收藏网址.md'],
    board_lanes: ['环节一'],
    skin: 'demo.css',
    ...patch,
  })
}

describe('parseLayoutTemplate(纯函数,本体只认格式)', () => {
  it('好文件 → 完整模板 + 皮肤原文', async () => {
    const parsed = await parseLayoutTemplate('demo', goodLayout(), async () => '.a{}')
    if (!parsed.ok) throw new Error(`不该 broken:${parsed.view.problem ?? ''}`)
    expect(parsed.template.id).toBe('demo')
    expect(parsed.template.name).toBe('演示布局')
    expect(parsed.template.project_source).toBe('accounts')
    expect(parsed.template.portrait).toEqual([{ id: 'slot', order: 0, row: 0, basis_pct: 50 }])
    expect(parsed.template.landscape[0]).toEqual({ id: 'slot', order: 0, row: 0, basis_pct: 50, region: 'deck', hidden: true, col: 0, width_pct: 60, side_pct: 22 })
    expect(parsed.template.apps).toEqual([{ kind: 'web', key: 't-x', label: '某网页', url: 'https://x.example/' }])
    expect(parsed.template.board_lanes).toEqual(['环节一'])
    expect(parsed.skin).toBe('.a{}')
  })

  it('contract 缺省 = 1;缺省字段回「做产品」的值', async () => {
    const parsed = await parseLayoutTemplate('demo', JSON.stringify({
      id: 'demo',
      portrait: [{ id: 'slot', order: 0, row: 0, basis_pct: 50 }],
      landscape: [{ id: 'slot', order: 0, row: 0, basis_pct: 50 }],
    }))
    if (!parsed.ok) throw new Error(`不该 broken:${parsed.view.problem ?? ''}`)
    expect(parsed.template.name).toBe('demo')
    expect(parsed.template.project_word).toBe(PRODUCT_TEMPLATE.project_word)
    expect(parsed.template.project_empty_line).toBe(PRODUCT_TEMPLATE.project_empty_line)
    expect(parsed.template.project_source).toBe('git')
    expect(parsed.template.board_lanes).toEqual([])
    expect(parsed.template.onboarding).toEqual({})
    expect(parsed.template.files_empty_line).toBeUndefined()
  })

  it('坏 JSON / 不是对象:一句人话,指出是引号或逗号', async () => {
    for (const text of ['{ 这不是 json', '[1,2]', '"x"', 'null']) {
      const parsed = await parseLayoutTemplate('demo', text)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.view.status).toBe('broken')
      expect(parsed.view.problem).toMatch(/读不出来|应该是一个/)
    }
  })

  it('contract 太新:先更新工作台(与小组件那句同款)', async () => {
    const parsed = await parseLayoutTemplate('demo', goodLayout({ contract: 99 }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.view.problem).toContain('先更新工作台')
  })

  it('id 必须等于文件名 stem', async () => {
    const parsed = await parseLayoutTemplate('demo', goodLayout({ id: '别的' }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.view.problem).toContain('对不上')
  })

  it('project_source 只认 git / accounts', async () => {
    const parsed = await parseLayoutTemplate('demo', goodLayout({ project_source: 'folder' }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.view.problem).toContain('project_source')
  })

  it('portrait / landscape 要非空数组', async () => {
    for (const field of ['portrait', 'landscape'] as const) {
      const parsed = await parseLayoutTemplate('demo', goodLayout({ [field]: [] }))
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.view.problem).toContain(field)
    }
  })

  it('模块缺 order / region 乱写:指出第几个模块', async () => {
    const noOrder = await parseLayoutTemplate('demo', goodLayout({
      portrait: [{ id: 'slot', row: 0, basis_pct: 50 }],
    }))
    expect(noOrder.ok).toBe(false)
    if (!noOrder.ok) {
      expect(noOrder.view.problem).toContain('第 1 个模块')
      expect(noOrder.view.problem).toContain('order')
    }
    const badRegion = await parseLayoutTemplate('demo', goodLayout({
      portrait: [
        { id: 'slot', order: 0, row: 0, basis_pct: 50 },
        { id: 'todo', order: 1, row: 0, basis_pct: 50, region: 'middle' },
      ],
    }))
    expect(badRegion.ok).toBe(false)
    if (!badRegion.ok) {
      expect(badRegion.view.problem).toContain('第 2 个模块')
      expect(badRegion.view.problem).toContain('region')
    }
  })

  it('网页应用没有 url:指出是哪个应用', async () => {
    const parsed = await parseLayoutTemplate('demo', goodLayout({
      apps: [{ kind: 'web', key: 't-x', label: '某网页' }],
    }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.view.problem).toContain('某网页')
    expect(parsed.view.problem).toContain('url')
  })

  it('文件夹路径不合法(绝对路径 / ..)不放行', async () => {
    for (const rel of ['/tmp/x', '../x', '素材/../../x']) {
      const parsed = await parseLayoutTemplate('demo', goodLayout({ folders: [{ rel, purpose: 'x' }] }))
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.view.problem).toContain('文件夹')
    }
  })

  it('module_titles / board_lanes 类型不对:逐条指出', async () => {
    const titles = await parseLayoutTemplate('demo', goodLayout({ module_titles: { files: 3 } }))
    expect(titles.ok).toBe(false)
    if (!titles.ok) expect(titles.view.problem).toContain('files')
    const lanes = await parseLayoutTemplate('demo', goodLayout({ board_lanes: '选题策划' }))
    expect(lanes.ok).toBe(false)
    if (!lanes.ok) expect(lanes.view.problem).toContain('board_lanes')
  })

  it('skin 只能是这个目录里的一份 .css 文件名', async () => {
    const badName = await parseLayoutTemplate('demo', goodLayout({ skin: '../x.css' }))
    expect(badName.ok).toBe(false)
    if (!badName.ok) expect(badName.view.problem).toContain('skin')
    const missing = await parseLayoutTemplate('demo', goodLayout({ skin: 'ops.css' }), async () => undefined)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.view.problem).toContain('皮肤文件 ops.css 不在或读不出来')
    // 没带 skin = 合法,只是没有皮肤。
    const none = await parseLayoutTemplate('demo', goodLayout({ skin: undefined }))
    expect(none.ok && none.skin === undefined).toBe(true)
  })
})

describe('起步层对照(读真文件,走真 parser)', () => {
  it('ops.json 解析得过,带皮肤', async () => {
    const template = await loadStarterLayoutTemplate()
    expect(template.id).toBe('ops')
    expect(template.name).toBe('自媒体运营')
    expect(template.project_source).toBe('accounts')
  })

  it('folders / files 与本体命名契约逐项相等(TOPIC_DIR、OPS_ASSET_DIRS、OPS_FAVORITES_REL)', async () => {
    const template = await loadStarterLayoutTemplate()
    expect(template.folders.map(one => one.rel)).toEqual([
      '账号',
      TOPIC_DIR,
      ...OPS_ASSET_DIRS.map(name => `素材/${name}`),
    ])
    expect(template.files).toEqual([OPS_FAVORITES_REL])
  })

  it('board_lanes 是八环节', async () => {
    const template = await loadStarterLayoutTemplate()
    expect(template.board_lanes).toHaveLength(8)
    expect(template.board_lanes[0]).toBe('选题策划')
    expect(template.board_lanes[7]).toBe('数据复盘')
  })
})

/** 一个装着真起步层 布局/ 的服务(目录在临时位置)。 */
async function makeLayoutService(opts: { starter?: string } = {}) {
  const dir = await tmpDir('ul-layer-')
  const service = createUserLayerService({
    dir,
    ...(opts.starter === undefined ? {} : { starterDir: opts.starter }),
  })
  return { dir, service }
}

describe('服务的布局那一半', () => {
  it('scan() 把起步层 ops.json 列进 layouts:ok + 模板指纹 + 皮肤指纹', async () => {
    const { service } = await makeLayoutService({ starter: STARTER_LAYER_DIR })
    await service.ensure()
    await service.scan() // 快照由 scan 刷新
    const view = await service.scan()
    const ops = view.layouts?.find(one => one.id === 'ops')
    expect(ops?.status).toBe('ok')
    expect(ops?.name).toBe('自媒体运营')
    expect(ops?.rev).toMatch(/^[0-9a-f]{12}$/)
    expect(ops?.skin_rev).toMatch(/^[0-9a-f]{12}$/)
  })

  it('layoutTemplate / layoutSkin 只回 ok 的;坏文件不进清单', async () => {
    const { service } = await makeLayoutService({ starter: STARTER_LAYER_DIR })
    await service.ensure()
    await service.scan() // 快照由 scan 刷新
    const template = service.layoutTemplate('ops')
    expect(template?.id).toBe('ops')
    const skin = service.layoutSkin('ops')
    expect(skin?.css).toContain('.ben-wb[data-template=ops]')
    expect(skin?.rev).toMatch(/^[0-9a-f]{12}$/)
    expect(service.layoutTemplate('没这个')).toBeUndefined()
    expect(service.layoutSkin('没这个')).toBeUndefined()
  })

  it('坏掉的布局:清单里 broken 带一句人话,layoutTemplate 回 undefined', async () => {
    const { dir, service } = await makeLayoutService({ starter: STARTER_LAYER_DIR })
    await service.ensure()
    await writeFile(join(dir, '布局', 'broken.json'), '{ 坏文件')
    const view = await service.scan()
    const broken = view.layouts?.find(one => one.id === 'broken')
    expect(broken?.status).toBe('broken')
    expect(broken?.problem).toContain('读不出来')
    // 别的照装。
    expect(view.layouts?.find(one => one.id === 'ops')?.status).toBe('ok')
  })

  it('ensure():ops.json 缺失时补放;她改过的永不覆盖(升级不动它)', async () => {
    const { dir, service } = await makeLayoutService({ starter: STARTER_LAYER_DIR })
    // 目录已建(ensure 建骨架)但布局文件不在 → 补放。
    await service.ensure()
    expect(await readFile(join(dir, '布局', 'ops.json'), 'utf8')).toBe(
      await readFile(join(STARTER_LAYOUTS_DIR, 'ops.json'), 'utf8'),
    )
    // 她改过一个字 → 再 ensure 一个字不动。
    const hers = await readFile(join(dir, '布局', 'ops.json'), 'utf8') + '\n// 她加的记号\n'
    await writeFile(join(dir, '布局', 'ops.json'), hers)
    const again = await service.ensure()
    expect(again.seededLayouts).toEqual([])
    expect(await readFile(join(dir, '布局', 'ops.json'), 'utf8')).toBe(hers)
  })

  it('她删了 ops.json → 下次 ensure **不再补回**(一次性 seed,删过不恢复)', async () => {
    const { dir, service } = await makeLayoutService({ starter: STARTER_LAYER_DIR })
    await service.ensure()
    expect(existsSync(join(dir, '布局', 'ops.json'))).toBe(true)
    await rm(join(dir, '布局', 'ops.json'))
    const again = await service.ensure()
    expect(again.seededLayouts).toEqual([])
    expect(existsSync(join(dir, '布局', 'ops.json'))).toBe(false)
  })

  it('删掉 .seeded 标记 → 下次 ensure 把缺的补回来(等价老机器重新升级)', async () => {
    const { dir, service } = await makeLayoutService({ starter: STARTER_LAYER_DIR })
    await service.ensure()
    await rm(join(dir, '布局', 'ops.json'))
    await rm(join(dir, '布局', LAYOUT_SEED_MARKER))
    const upgraded = await service.ensure()
    expect(upgraded.seededLayouts).toContain('ops.json')
    expect(await readFile(join(dir, '布局', 'ops.json'), 'utf8'))
      .toBe(await readFile(join(STARTER_LAYOUTS_DIR, 'ops.json'), 'utf8'))
  })

  it('她删了 ops.json:scan 不再列它,模板系统退回 product,detail 里说一句人话', async () => {
    const { dir, service } = await makeLayoutService({ starter: STARTER_LAYER_DIR })
    await service.ensure()
    await service.scan()
    // 与 index.ts 同款接线:来源 = product + 用户层快照。
    setWorkbenchTemplateSource({
      all: () => [PRODUCT_TEMPLATE, ...service.layoutTemplates()],
      byId: id => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : service.layoutTemplate(id)),
    })
    // 先切到 ops 再删:模拟「用着她那一份,文件没了」。
    const file = join(dir, 'template.json')
    const tplDir = await tmpDir('tpl-layer-')
    let layout: import('../src/protocol.ts').WorkbenchLayout | undefined = { modules: [], butler: { corner: 'br', min: false } }
    const tpl = createTemplateService({
      file,
      backupsDir: join(tplDir, 'backups'),
      readLayout: () => Promise.resolve(layout),
      writeLayout: next => { layout = next; return Promise.resolve() },
      templates: () => service.layoutTemplates(),
    })
    await tpl.load()
    await tpl.apply('ops')
    expect(tpl.currentId()).toBe('ops')

    await rm(join(dir, '布局', 'ops.json'))
    await service.scan() // 下一拍:快照里 ops 没了
    expect((await service.scan()).layouts?.some(one => one.id === 'ops')).toBe(false)
    expect(service.layoutTemplate('ops')).toBeUndefined()
    // current() 优雅降级回 product,而不是抛 / 白屏。
    expect(tpl.current().id).toBe('product')
    // 设置那张卡:current 仍如实报盘上记的 id,product 那张亮,note 是一句人话。
    const detail = await tpl.detail()
    expect(detail.current).toBe('ops')
    const productCard = detail.templates.find(one => one.id === 'product')
    expect(productCard?.current).toBe(true)
    expect(detail.note).toContain('原来用的「ops」布局在用户层里读不出来或已不在')
    expect(detail.note).toContain('用户层/布局/ops.json')
    // 模板修好(把起步层那一份放回去)→ 下一拍恢复,note 消失。
    await copyFile(join(STARTER_LAYOUTS_DIR, 'ops.json'), join(dir, '布局', 'ops.json'))
    await service.scan()
    expect(tpl.current().id).toBe('ops')
    expect((await tpl.detail()).note).toBeUndefined()
  })
})
