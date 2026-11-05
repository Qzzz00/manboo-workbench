/**
 * 布局模板的服务端(2026-09-21):模型校验 / apply / restore / 建文件夹 / 窗位登记。
 *
 * 一条纪律贯穿全文件:**「做产品」模板必须逐字等于现状**。所以第一组用例拿的是
 * client/layout.ts 的 DEFAULT_LAYOUT 与 DEFAULT_LANDSCAPE_MODULES 去对 —— 那两个常量
 * 现在是从 templates.ts re-export 的,对上了就说明"搬家"没改动任何一个数字。
 */
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkbenchLayout } from '../src/protocol.ts'
import { LAYOUT_MODULE_IDS } from '../src/protocol.ts'
import { DEFAULT_LANDSCAPE_MODULES, DEFAULT_LAYOUT } from '../src/client/layout.ts'
import {
  DEFAULT_MODULE_TITLES, OPS_ASSET_DIRS, OPS_FAVORITES_REL,
  PRODUCT_TEMPLATE, setWorkbenchTemplateSource, templateById, templateModuleTitle,
} from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'

/**
 * 2026-10-23(分层二刀二):ops 模板的内容搬进了用户层起步层 `布局/ops.json`,
 * 本体 templates.ts 只剩 product。这份用例读真起步层走真 parser 拿这一份,
 * 并注进全局模板来源(钉死「认得 ops」那一面的行为;afterEach 复位回默认)。
 */
const OPS_TEMPLATE = await loadStarterLayoutTemplate()
const OPS_STAGES = OPS_TEMPLATE.board_lanes
setWorkbenchTemplateSource({
  all: () => [PRODUCT_TEMPLATE, OPS_TEMPLATE],
  byId: (id: string) => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : id === OPS_TEMPLATE.id ? OPS_TEMPLATE : undefined),
})
import {
  MISSING_CWD_NOTE,
  applyTemplateToLayout, createTemplateService, isSafeTemplateRel, loadTemplateFile,
  saveTemplateFile, templateStateView,
} from '../src/server/templateStore.ts'

async function tmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** 一个最小可用的 service:布局在内存里,文件与备份在临时目录里。 */
async function makeService(opts: { cwd?: string, keepBackups?: number } = {}) {
  /** 「切完了」这一声响了几次(2026-09-21:项目区据此把扫描缓存作废)。 */
  const applied: string[] = []
  const dir = await tmpDir('tpl-')
  let layout: WorkbenchLayout | undefined = {
    modules: DEFAULT_LAYOUT.modules.map(m => ({ ...m })),
    butler: { corner: 'tl', min: true, pos: { x_pct: 12, y_pct: 34 } },
    pureMode: false,
    projects_view: 'board',
    landscape: { modules: DEFAULT_LANDSCAPE_MODULES.map(m => ({ ...m })), rail_pct: 9 },
  }
  const enabled: string[][] = []
  const registered: { bundle_id: string, name: string }[] = []
  let clock = Date.parse('2026-09-21T10:00:00Z')
  const service = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'template-backups'),
    readLayout: () => Promise.resolve(layout),
    writeLayout: (next) => { layout = next; return Promise.resolve() },
    ...(opts.cwd === undefined ? {} : { butlerCwd: () => opts.cwd }),
    ...(opts.keepBackups === undefined ? {} : { keepBackups: opts.keepBackups }),
    enableApps: (keys) => {
      enabled.push([...keys])
      return Promise.resolve({ enabled: [...keys], already: [], unknown: [] })
    },
    registerApp: (info) => {
      registered.push(info)
      return Promise.resolve({ ok: true, key: info.bundle_id === 'com.openai.codex' ? 'codex' : 't-x' })
    },
    onApplied: () => { applied.push(service.currentId()) },
    // 每调一次往前走一毫秒:备份文件名里的时间戳才不会在同一毫秒内撞成同一个。
    now: () => { clock += 1; return clock },
  })
  await service.load()
  return {
    dir, service, enabled, registered, applied,
    layout: () => layout,
    setLayout: (next: WorkbenchLayout | undefined) => { layout = next },
  }
}

describe('模板定义', () => {
  it('「做产品」模板的两份排布逐字等于现在的默认布局', () => {
    expect(PRODUCT_TEMPLATE.portrait).toEqual(DEFAULT_LAYOUT.modules)
    expect(PRODUCT_TEMPLATE.landscape).toEqual(DEFAULT_LANDSCAPE_MODULES)
  })

  it('「做产品」模板不带应用、不建文件夹、不换看板列、不换引导问法', () => {
    expect(PRODUCT_TEMPLATE.apps).toEqual([])
    expect(PRODUCT_TEMPLATE.folders).toEqual([])
    expect(PRODUCT_TEMPLATE.board_lanes).toEqual([])
    expect(PRODUCT_TEMPLATE.onboarding).toEqual({})
    expect(PRODUCT_TEMPLATE.module_titles).toEqual({})
  })

  it('两套模板用到的模块 id 都在协议白名单里', () => {
    for (const template of [PRODUCT_TEMPLATE, OPS_TEMPLATE]) {
      for (const module of [...template.portrait, ...template.landscape]) {
        expect(LAYOUT_MODULE_IDS as readonly string[]).toContain(module.id)
      }
    }
  })

  it('运营横屏:右侧栏是 账号 / 待办事项 / 发布计划,底部是 数据复盘 / 随手记 / 素材管理', () => {
    const shown = OPS_TEMPLATE.landscape.filter(m => m.hidden !== true)
    const side = shown.filter(m => m.id === 'projects' || m.region === 'side').map(m => m.id)
    const deck = shown.filter(m => m.id !== 'slot' && m.id !== 'projects' && m.region !== 'side').map(m => m.id)
    expect(side).toEqual(['projects', 'todo', 'today', 'publish'])
    expect(deck).toEqual(['review', 'notes', 'files'])
    expect(shown.some(m => m.id === 'slot')).toBe(true)
  })

  it('运营横屏把消耗数据与余额收起(而不是删掉)——用户还能自己展开回来', () => {
    const usage = OPS_TEMPLATE.landscape.find(m => m.id === 'usage')
    const quota = OPS_TEMPLATE.landscape.find(m => m.id === 'quota')
    expect(usage?.hidden).toBe(true)
    expect(quota?.hidden).toBe(true)
  })

  /**
   * 2026-09-21 第二张卡:竖屏不再沿用做产品那一份(上一版沿用是 Ben 定的"先做横屏",
   * 记在交接第七节第 2 条的「已知缺口」里)。这三条钉的是那个缺口真的补上了。
   */
  it('运营竖屏不再等于做产品那一份', () => {
    expect(OPS_TEMPLATE.portrait).not.toEqual(PRODUCT_TEMPLATE.portrait)
  })

  it('运营竖屏从上到下:窗口槽 → 账号 / 待办事项 / 发布计划 → 数据复盘 / 随手记 / 素材管理', () => {
    const shown = OPS_TEMPLATE.portrait.filter(m => m.hidden !== true)
    expect(shown.map(m => m.id)).toEqual(['slot', 'projects', 'todo', 'today', 'publish', 'review', 'notes', 'files'])
    // 中间那三格在同一行、同一列 —— 整行竖排,不是三列并排(理由见 templates.ts 的取舍 1)。
    const middle = shown.filter(m => m.row === 1)
    expect(middle.map(m => m.id)).toEqual(['projects', 'todo', 'today', 'publish'])
    expect(middle.every(m => m.col === 0)).toBe(true)
    // 顺序与横屏右侧栏从上到下逐字一致(取舍 2)。
    const side = OPS_TEMPLATE.landscape.filter(m => m.hidden !== true && (m.id === 'projects' || m.region === 'side'))
    expect(side.map(m => m.id)).toEqual(middle.map(m => m.id))
  })

  it('运营竖屏里消耗数据与余额也是收起(不是删掉)—— 上一版竖屏是展开着的', () => {
    const usage = OPS_TEMPLATE.portrait.find(m => m.id === 'usage')
    const quota = OPS_TEMPLATE.portrait.find(m => m.id === 'quota')
    expect(usage?.hidden).toBe(true)
    expect(quota?.hidden).toBe(true)
  })

  it('竖屏三行的高度和是 100(同做产品那一份的口径)', () => {
    const shown = OPS_TEMPLATE.portrait.filter(m => m.hidden !== true)
    // 一行有多高 = 这一行里最高的那一列。`col` 缺席的模块各占一列(protocol.LayoutModule),
    // 同列的按 basis_pct 竖着叠起来。
    const rowHeight = (row: number): number => {
      const byCol = new Map<string, number>()
      shown.filter(m => m.row === row).forEach((m, index) => {
        const key = m.col === undefined ? `solo-${index}` : `col-${m.col}`
        byCol.set(key, (byCol.get(key) ?? 0) + (m.basis_pct ?? 0))
      })
      return Math.max(...byCol.values())
    }
    expect(rowHeight(0) + rowHeight(1) + rowHeight(2)).toBe(100)
  })

  it('做产品模板的竖屏一个字没变', () => {
    expect(PRODUCT_TEMPLATE.portrait.map(m => m.id)).toEqual(['projects', 'usage', 'quota', 'slot', 'notes', 'files'])
  })

  it('运营模板的看板列就是运营同事那张表的八个环节,顺序一致', () => {
    expect(OPS_TEMPLATE.board_lanes).toEqual([
      '选题策划', '内容调研', '结构与脚本', '素材制作',
      '后期制作', '发布包装', '发布与互动', '数据复盘',
    ])
    expect(OPS_STAGES.length).toBe(8)
  })

  // 2026-09-21 选题池:多了一个 `选题`(一条选题一个文件夹,见 server/topicAssets.ts
  // 顶上那段目录约定)。**`素材/选题池` 原样留着** —— 它是白板上七类素材库之一,
  // 已经在用户盘上建出来了,改名或搬走要动人家已有的文件。
  it('运营模板在工作目录下要建的是 账号 + 选题 + 素材下七个固定子文件夹', () => {
    expect(OPS_TEMPLATE.folders.map(f => f.rel)).toEqual([
      '账号',
      '选题',
      ...OPS_ASSET_DIRS.map(name => `素材/${name}`),
    ])
  })

  it('剪映本机没装:登记里没有 bundle id,而是一句如实的「未查到」', () => {
    const jy = OPS_TEMPLATE.apps.find(app => app.label === '剪映')
    expect(jy?.bundle_id).toBeUndefined()
    expect(jy?.bundle_note).toContain('未查到 bundle id')
  })

  it('网页型的三个应用都带 url、都没有 bundle id', () => {
    const web = OPS_TEMPLATE.apps.filter(app => app.kind === 'web')
    expect(web.map(app => app.label)).toEqual(['可灵', '小红书', '可画'])
    for (const app of web) {
      expect(app.url).toMatch(/^https:\/\//)
      expect(app.bundle_id).toBeUndefined()
    }
  })

  it('模块标题:模板没改就落回默认,两边都没有就原样回 id', () => {
    expect(templateModuleTitle(PRODUCT_TEMPLATE, 'files')).toBe('图谱')
    expect(templateModuleTitle(OPS_TEMPLATE, 'files')).toBe('素材管理')
    expect(templateModuleTitle(OPS_TEMPLATE, 'projects')).toBe('账号')
    expect(templateModuleTitle(OPS_TEMPLATE, 'notes')).toBe(DEFAULT_MODULE_TITLES.notes)
    expect(templateModuleTitle(OPS_TEMPLATE, '没这个模块')).toBe('没这个模块')
    expect(templateModuleTitle(undefined, 'slot')).toBe('窗口槽')
  })

  it('认不出的 id 回 undefined,不偷偷退回 product', () => {
    expect(templateById('product')).toBe(PRODUCT_TEMPLATE)
    expect(templateById('ops')).toBe(OPS_TEMPLATE)
    expect(templateById('ops2')).toBeUndefined()
  })
})

describe('applyTemplateToLayout(纯函数)', () => {
  const base: WorkbenchLayout = {
    modules: [{ id: 'slot', order: 0 }],
    butler: { corner: 'tl', min: true, pos: { x_pct: 12, y_pct: 34 }, size: { w_px: 300, h_px: 200 } },
    pureMode: true,
    projects_view: 'board',
    board_axis: 'status-columns',
    landscape: { modules: [], rail_pct: 9, butler_pos: { x_pct: 1, y_pct: 2 } },
  }

  it('横竖两份模块都换掉', () => {
    const next = applyTemplateToLayout(base, OPS_TEMPLATE)
    expect(next.modules).toEqual(OPS_TEMPLATE.portrait)
    expect(next.landscape?.modules).toEqual(OPS_TEMPLATE.landscape)
  })

  it('浮窗位置 / 尺寸 / 纯净模式 / 两个视图开关 / 左栏宽度一个字不动', () => {
    const next = applyTemplateToLayout(base, OPS_TEMPLATE)
    expect(next.butler).toEqual(base.butler)
    expect(next.pureMode).toBe(true)
    expect(next.projects_view).toBe('board')
    expect(next.board_axis).toBe('status-columns')
    expect(next.landscape?.rail_pct).toBe(9)
    expect(next.landscape?.butler_pos).toEqual({ x_pct: 1, y_pct: 2 })
  })

  it('不与模板常量共享引用(改返回值不该改到内置模板)', () => {
    const next = applyTemplateToLayout(base, OPS_TEMPLATE)
    expect(next.modules[0]).not.toBe(OPS_TEMPLATE.portrait[0])
    expect(next.landscape?.modules[0]).not.toBe(OPS_TEMPLATE.landscape[0])
  })

  it('切回 product 就是回到今天的样子', () => {
    const once = applyTemplateToLayout(base, OPS_TEMPLATE)
    const back = applyTemplateToLayout(once, PRODUCT_TEMPLATE)
    expect(back.modules).toEqual(DEFAULT_LAYOUT.modules)
    expect(back.landscape?.modules).toEqual(DEFAULT_LANDSCAPE_MODULES)
  })
})

describe('文件夹路径的那道闸', () => {
  it('只放行工作目录之下的相对路径', () => {
    expect(isSafeTemplateRel('素材/脚本')).toBe(true)
    expect(isSafeTemplateRel('账号')).toBe(true)
    expect(isSafeTemplateRel('')).toBe(false)
    expect(isSafeTemplateRel('/tmp/x')).toBe(false)
    expect(isSafeTemplateRel('~/x')).toBe(false)
    expect(isSafeTemplateRel('../x')).toBe(false)
    expect(isSafeTemplateRel('素材/../../x')).toBe(false)
    expect(isSafeTemplateRel('素材//脚本')).toBe(false)
    expect(isSafeTemplateRel('./x')).toBe(false)
  })
})

describe('template.json', () => {
  it('文件不在 = product', async () => {
    const dir = await tmpDir('tplf-')
    expect(await loadTemplateFile(join(dir, 'nope.json'))).toEqual({ version: 1, id: 'product' })
  })

  it('写坏了 = product,不抛', async () => {
    const dir = await tmpDir('tplf-')
    const file = join(dir, 'template.json')
    await writeFile(file, '{ 这不是 json')
    expect((await loadTemplateFile(file)).id).toBe('product')
  })

  it('认不出的 id **原样保留**(那是用户的选择;回退是运行期 current() 的事,不落盘)', async () => {
    const dir = await tmpDir('tplf-')
    const file = join(dir, 'template.json')
    await writeFile(file, JSON.stringify({ version: 1, id: '我编的' }))
    expect((await loadTemplateFile(file)).id).toBe('我编的')
    // id 不是字符串 / 空串才兜底 product。
    await writeFile(file, JSON.stringify({ version: 1, id: 7 }))
    expect((await loadTemplateFile(file)).id).toBe('product')
  })

  it('★选的布局这会儿认不出来:currentId 仍是她选的那个,current() 回退 product;修好来源自动恢复', async () => {
    const dir = await tmpDir('tplf-')
    const file = join(dir, 'template.json')
    await saveTemplateFile(file, { version: 1, id: 'ops' })
    // 来源里没有 ops(= 用户层那份被删 / 改坏了):启动照旧读得出她的选择 …
    setWorkbenchTemplateSource({
      all: () => [PRODUCT_TEMPLATE],
      byId: id => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : undefined),
    })
    const svc = createTemplateService({ file, backupsDir: join(dir, 'backups'), readLayout: () => Promise.resolve(undefined), writeLayout: () => Promise.resolve() })
    await svc.load()
    expect(svc.currentId()).toBe('ops')
    // … 但显示退回 product(不白屏、不抛)。
    expect(svc.current().id).toBe('product')
    // 她把用户层那份修好(来源重新认得 ops):不用重切、不用重启,自己回来。
    setWorkbenchTemplateSource({
      all: () => [PRODUCT_TEMPLATE, OPS_TEMPLATE],
      byId: id => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : id === OPS_TEMPLATE.id ? OPS_TEMPLATE : undefined),
    })
    expect(svc.current().id).toBe('ops')
    // 盘上那份一个字没动:还是她选的 ops。
    expect((await loadTemplateFile(file)).id).toBe('ops')
  })

  it('存过再读回来是同一个', async () => {
    const dir = await tmpDir('tplf-')
    const file = join(dir, 'template.json')
    await saveTemplateFile(file, { version: 1, id: 'ops', applied_at: '2026-09-21T10:00:00.000Z' })
    const back = await loadTemplateFile(file)
    expect(back.id).toBe('ops')
    expect(back.applied_at).toBe('2026-09-21T10:00:00.000Z')
  })
})

describe('apply', () => {
  it('切到运营:布局换成运营那一套,当前模板落盘', async () => {
    const { service, layout, dir } = await makeService()
    const result = await service.apply('ops')
    expect(result.ok).toBe(true)
    expect(service.currentId()).toBe('ops')
    expect(layout()?.landscape?.modules).toEqual(OPS_TEMPLATE.landscape)
    expect((await loadTemplateFile(join(dir, 'template.json'))).id).toBe('ops')
  })

  it('切之前自动存一份可回退的备份', async () => {
    const { service, dir } = await makeService()
    const result = await service.apply('ops')
    expect(result.backup).toBeDefined()
    const names = await readdir(join(dir, 'template-backups'))
    expect(names).toContain(result.backup)
    const backup = JSON.parse(await readFile(join(dir, 'template-backups', result.backup as string), 'utf8'))
    // 备份里是**整份**布局,不是渲染出来的 markdown —— 它就是回退要写回去的那一份。
    expect(backup.layout.landscape.modules).toEqual(DEFAULT_LANDSCAPE_MODULES)
    expect(backup.template_id).toBe('product')
    expect(backup.applying).toBe('ops')
  })

  it('认不出的 id:400 那一档,一个字都不落盘', async () => {
    const { service, layout } = await makeService()
    const result = await service.apply('我编的')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('没有这个模板')
    expect(service.currentId()).toBe('product')
    expect(layout()?.landscape?.modules).toEqual(DEFAULT_LANDSCAPE_MODULES)
  })

  it('id 不是字符串也认不出', async () => {
    const { service } = await makeService()
    expect((await service.apply(undefined)).ok).toBe(false)
    expect((await service.apply(7)).ok).toBe(false)
  })

  it('配了工作目录:七个素材子文件夹 + 账号,只建不删', async () => {
    const cwd = await tmpDir('cwd-')
    // 先在其中一个里放一个文件:apply 之后它必须还在(「只建不删」)。
    await mkdir(join(cwd, '素材/脚本'), { recursive: true })
    await writeFile(join(cwd, '素材/脚本/旧稿.md'), '别动我')
    const { service } = await makeService({ cwd })
    const result = await service.apply('ops')
    // 2026-09-21 第八格:folders 之后还种一个文件(素材/收藏网址.md),它也算这次"建出来的"。
    expect(result.folders_made).toEqual([...OPS_TEMPLATE.folders.map(f => f.rel), ...OPS_TEMPLATE.files])
    expect(result.folder_errors).toEqual([])
    expect(await readFile(join(cwd, '素材/脚本/旧稿.md'), 'utf8')).toBe('别动我')
    expect((await readdir(join(cwd, '素材'))).sort()).toEqual([...OPS_ASSET_DIRS, '收藏网址.md'].sort())
  })

  it('第八格「收藏网址」:种一份带格式说明的空文件', async () => {
    const cwd = await tmpDir('cwd-')
    const { service } = await makeService({ cwd })
    await service.apply('ops')
    const text = await readFile(join(cwd, OPS_FAVORITES_REL), 'utf8')
    expect(text).toContain('# 收藏网址')
    expect(text).toContain('- [标题](链接) —— 备注')
  })

  it('收藏网址**已经有了就一个字不动**(那是他攒的东西,不是模板产物)', async () => {
    const cwd = await tmpDir('cwd-')
    await mkdir(join(cwd, '素材'), { recursive: true })
    await writeFile(join(cwd, OPS_FAVORITES_REL), '- [我自己存的](https://a.com)\n')
    const { service } = await makeService({ cwd })
    const result = await service.apply('ops')
    expect(await readFile(join(cwd, OPS_FAVORITES_REL), 'utf8')).toBe('- [我自己存的](https://a.com)\n')
    // 没建就不许写进 folders_made —— 没发生的事不许写进结果。
    expect(result.folders_made).not.toContain(OPS_FAVORITES_REL)
  })

  it('做产品模板不种任何文件', async () => {
    const cwd = await tmpDir('cwd-')
    const { service } = await makeService({ cwd })
    await service.apply('ops')
    await service.apply('product')
    // 切回做产品不会删掉已经种下的东西(只建不删),但也不会再种新的。
    expect(PRODUCT_TEMPLATE.files).toEqual([])
  })

  it('没配工作目录:一个文件夹都不建,也不报错、不猜路径', async () => {
    const { service } = await makeService()
    const result = await service.apply('ops')
    expect(result.ok).toBe(true)
    expect(result.folders_made).toEqual([])
    expect(result.folder_errors).toEqual([])
  })

  /**
   * 2026-09-26(卡 ZM,灰度里撞出来的):不建是对的(不猜路径),**一声不吭就不对**。
   *
   * 灰度里切到自媒体运营模板,回包是 `folders_made: []` + `folder_errors: []`,
   * 界面只在这两个数组非空时说话,于是屏幕上只有一句「已经切过去了」——
   * 而「账号 / 选题 / 素材」七格一个都没建出来,`/state.template.asset_dirs` 跟着
   * 整块缺席,素材管理那一行也不画。界面上一切正常,东西没了。
   */
  it('没配工作目录:如实说「一个都没建、为什么、下一步点哪儿」', async () => {
    const { service } = await makeService()
    const result = await service.apply('ops')
    expect(result.folders_note).toBe(MISSING_CWD_NOTE)
    // 三样缺一不可:没做成什么 / 为什么 / 下一步点哪儿。
    expect(result.folders_note).toContain('一个都没建')
    expect(result.folders_note).toContain('还没有设工作目录')
    expect(result.folders_note).toContain('事务官仓库')
    // 不许把英文键名摆给用户看(三层自验清单第三节:不露内部的东西)。
    expect(result.folders_note).not.toContain('butler_cwd')
  })

  it('做产品模板本来就不建东西:没配工作目录也不说那句话', async () => {
    const { service } = await makeService()
    await service.apply('ops')
    const back = await service.apply('product')
    expect(back.ok).toBe(true)
    // 它的 folders / files 都是空的,谈不上"没建成" —— 不该为一个它不需要的目录吓唬人。
    expect(PRODUCT_TEMPLATE.folders).toEqual([])
    expect(PRODUCT_TEMPLATE.files).toEqual([])
    expect(back.folders_note).toBeUndefined()
  })

  it('配了工作目录:建得出来,就不再说那句话', async () => {
    const cwd = await tmpDir('tpl-cwd-')
    const { service } = await makeService({ cwd })
    const result = await service.apply('ops')
    expect(result.folders_made.length).toBeGreaterThan(0)
    expect(result.folders_note).toBeUndefined()
  })

  it('窗位应用:带 bundle id 的登记并放进清单,没 bundle id 的如实说「未查到」', async () => {
    const { service, enabled, registered } = await makeService()
    const result = await service.apply('ops')
    expect(registered.map(r => r.bundle_id)).toEqual(['com.openai.codex', 'com.bot.pc.doubao'])
    expect(enabled).toEqual([['codex', 't-x']])
    expect(result.apps_note).toContain('已放进窗位清单')
    expect(result.apps_note).toContain('剪映')
    expect(result.apps_note).toContain('未查到 bundle id')
  })

  it('切回做产品:布局逐字回到今天的样子', async () => {
    const { service, layout } = await makeService()
    await service.apply('ops')
    await service.apply('product')
    expect(service.currentId()).toBe('product')
    expect(layout()?.modules).toEqual(DEFAULT_LAYOUT.modules)
    expect(layout()?.landscape?.modules).toEqual(DEFAULT_LANDSCAPE_MODULES)
  })

  it('浮窗位置这类「不是排布」的字段切来切去都不动', async () => {
    const { service, layout } = await makeService()
    await service.apply('ops')
    await service.apply('product')
    expect(layout()?.butler.pos).toEqual({ x_pct: 12, y_pct: 34 })
    expect(layout()?.projects_view).toBe('board')
    expect(layout()?.landscape?.rail_pct).toBe(9)
  })

  it('读不到布局(项目区没接线)也切得过去,只是没有备份', async () => {
    const ctx = await makeService()
    ctx.setLayout(undefined)
    const result = await ctx.service.apply('ops')
    expect(result.ok).toBe(true)
    expect(result.backup).toBeUndefined()
    expect(ctx.layout()?.landscape?.modules).toEqual(OPS_TEMPLATE.landscape)
  })

  it('备份最多留 N 份,超了删最旧的', async () => {
    const { service, dir } = await makeService({ keepBackups: 2 })
    await service.apply('ops')
    await service.apply('product')
    await service.apply('ops')
    const names = (await readdir(join(dir, 'template-backups'))).filter(n => n.endsWith('.json'))
    expect(names.length).toBe(2)
  })

  it('别人放在备份目录里的文件一个都不碰', async () => {
    const { service, dir } = await makeService({ keepBackups: 1 })
    await mkdir(join(dir, 'template-backups'), { recursive: true })
    await writeFile(join(dir, 'template-backups', '我的笔记.txt'), 'x')
    await service.apply('ops')
    await service.apply('product')
    expect(await readFile(join(dir, 'template-backups', '我的笔记.txt'), 'utf8')).toBe('x')
  })
})

describe('切完了要喊一声(2026-09-21:模板决定项目区读哪个数据源)', () => {
  it('apply 成功之后 onApplied 响一次,而且那时当前模板已经是新的了', async () => {
    const f = await makeService()
    await f.service.apply('ops')
    // 回调里读到的是**切过去之后**的 id —— 在它之前作废缓存,下一次扫描会用旧数据源再扫一遍。
    expect(f.applied).toEqual(['ops'])
  })

  it('apply 被拒(认不出的 id)时一声都不响 —— 什么都没发生就不该让别人去重扫', async () => {
    const f = await makeService()
    await f.service.apply('我编的')
    expect(f.applied).toEqual([])
  })

  it('restore 也响一次(回退同样可能换回另一个数据源)', async () => {
    const f = await makeService()
    await f.service.apply('ops')
    await f.service.restore()
    expect(f.applied).toEqual(['ops', 'product'])
  })

  it('回调抛了不拦切换本身 —— 布局已经换过去了,一次缓存没清干净不该让整件事回滚', async () => {
    const dir = await tmpDir('tpl-throw-')
    let layout: WorkbenchLayout | undefined = { modules: [], butler: { corner: 'br', min: false } }
    const service = createTemplateService({
      file: join(dir, 'template.json'),
      backupsDir: join(dir, 'template-backups'),
      readLayout: () => Promise.resolve(layout),
      writeLayout: (next) => { layout = next; return Promise.resolve() },
      onApplied: () => { throw new Error('缓存清不掉') },
    })
    await service.load()
    const result = await service.apply('ops')
    expect(result.ok).toBe(true)
    expect(service.currentId()).toBe('ops')
  })
})

describe('restore', () => {
  it('切过之后回退:布局与当前模板一起还原', async () => {
    const { service, layout } = await makeService()
    await service.apply('ops')
    expect(service.currentId()).toBe('ops')
    const restored = await service.restore()
    expect(restored.ok).toBe(true)
    expect(restored.template_id).toBe('product')
    expect(service.currentId()).toBe('product')
    expect(layout()?.landscape?.modules).toEqual(DEFAULT_LANDSCAPE_MODULES)
    expect(layout()?.butler.pos).toEqual({ x_pct: 12, y_pct: 34 })
  })

  it('没切过就回退:一句人话,不抛', async () => {
    const { service } = await makeService()
    const restored = await service.restore()
    expect(restored.ok).toBe(false)
    expect(restored.reason).toContain('没有可回退')
  })

  it('回退是一步不是历史栈:连回两次,第二次说没有了', async () => {
    const { service } = await makeService()
    await service.apply('ops')
    expect((await service.restore()).ok).toBe(true)
    const second = await service.restore()
    expect(second.ok).toBe(false)
    expect(second.reason).toContain('没有可回退')
  })

  it('备份写坏了:如实说读不出来,不把布局改成半份', async () => {
    const { service, dir, layout } = await makeService()
    const applied = await service.apply('ops')
    await writeFile(join(dir, 'template-backups', applied.backup as string), '{ 坏的')
    const before = layout()
    const restored = await service.restore()
    expect(restored.ok).toBe(false)
    expect(restored.reason).toContain('读不出来')
    expect(layout()).toBe(before)
  })
})

describe('/state.template 那一块', () => {
  it('做产品:标题全是默认的,没有素材目录、没有网页应用', () => {
    const view = templateStateView(PRODUCT_TEMPLATE, { hasBackup: false })
    expect(view.id).toBe('product')
    expect(view.project_word).toBe('项目')
    expect(view.module_titles.files).toBe('图谱')
    expect(view.asset_dirs).toBeUndefined()
    expect(view.web_apps).toBeUndefined()
    expect(view.board_lanes).toEqual([])
    expect(view.has_backup).toBe(false)
  })

  it('运营 + 配了工作目录:素材那几个是绝对路径', () => {
    const view = templateStateView(OPS_TEMPLATE, { butlerCwd: '/Users/x/运营', hasBackup: true })
    expect(view.project_word).toBe('账号')
    expect(view.project_empty_line).toBe('还没有账号,引导里会问。')
    expect(view.module_titles.files).toBe('素材管理')
    expect(view.module_titles.projects).toBe('账号')
    expect(view.module_titles.notes).toBe('随手记')
    expect(view.asset_dirs?.脚本).toBe('/Users/x/运营/素材/脚本')
    expect(view.asset_dirs?.账号).toBe('/Users/x/运营/账号')
    expect(view.board_lanes).toEqual(OPS_STAGES)
    expect(view.has_backup).toBe(true)
  })

  it('运营 + 没配工作目录:asset_dirs 整块缺席,不拿猜的路径顶替', () => {
    const view = templateStateView(OPS_TEMPLATE, { hasBackup: false })
    expect(view.asset_dirs).toBeUndefined()
    expect(view.web_apps?.map(app => app.label)).toEqual(['可灵', '小红书', '可画'])
  })
})

describe('GET /template 那一份', () => {
  it('两张卡片 + 当前是哪个 + 有没有备份', async () => {
    const { service } = await makeService()
    const before = await service.detail()
    expect(before.current).toBe('product')
    expect(before.has_backup).toBe(false)
    expect(before.templates.map(t => t.id)).toEqual(['product', 'ops'])
    expect(before.templates[0]?.current).toBe(true)
    expect(before.templates[1]?.name).toBe('自媒体运营')
    expect(before.templates[1]?.tagline.length).toBeGreaterThan(0)

    await service.apply('ops')
    const after = await service.detail()
    expect(after.current).toBe('ops')
    expect(after.has_backup).toBe(true)
    expect(after.last_backup_at).toBeDefined()
    expect(after.templates[1]?.current).toBe(true)
  })

  it('卡片上写得出这个模板带哪几个应用、建哪几个文件夹', async () => {
    const { service } = await makeService()
    const detail = await service.detail()
    const ops = detail.templates.find(t => t.id === 'ops')
    expect(ops?.apps.map(a => a.label)).toEqual(['ChatGPT', '豆包办公', '剪映', '可灵', '小红书', '可画'])
    expect(ops?.apps.find(a => a.label === '剪映')?.note).toContain('未查到')
    expect(ops?.folders).toContain('素材/成片')
    expect(ops?.board_lanes).toEqual(OPS_STAGES)
  })
})
