// @vitest-environment node
/**
 * 旧起步层 files 组件的升级兼容(2026-10-23,卡「系统文件夹改成Graphify图谱」第四轮)。
 *
 * 背景:2026-10-21「分层第一刀」种下的 files 小组件没有 templates 字段(当时替全部布局);
 * 10-23 素材管理收缝到 ops 后,逐字未改的旧组件会把开发者布局的 files 格也替掉、图谱格
 * 上不去;而 ensure() 只在新建目录时种种子,老用户不重种。兼容因此在**加载口**做:
 * 清单原文 + 入口文件指纹都对得上旧起步原文的(server/userLayer.ts 里钉死的两个常量),
 * 按 templates:["ops"] 认。只认指纹,不认「id 叫 files」。
 *
 * 钉死的行为(回归逐条):
 * - 旧起步逐字未改 → templates:["ops"](product 落回本体图谱、ops 仍是素材管理);
 * - 入口改一个字 / 清单改一个字段 → 不碰(用户定制不被收窄);
 * - 当前起步层(清单自带 templates)→ 照常,兼容逻辑不干扰;
 * - 用户删掉了 files 目录 → 不复生、不报错;
 * - 重复 scan 幂等;widgetCode 照旧把入口代码端出去。
 *
 * 夹具 tests/fixtures/user-layer-legacy-starter-files/ 是 main 上旧起步那两份的逐字拷贝
 * (2026-10-23 `git show main:…` 取得),指纹因此天然对得上钉死的常量。
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserLayerService, LEGACY_STARTER_FILES_REV } from '../src/server/userLayer.ts'

const FIXTURE = join(process.cwd(), 'tests/fixtures/user-layer-legacy-starter-files')

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'user-layer-legacy-'))
  dirs.push(root)
  return root
}

/** 造一个「老用户」的用户层:小组件/files 按给定形态落盘(不经过 ensure 的播种)。 */
async function layFiles(root: string, options: {
  manifest?: string
  index?: string
  omit?: boolean
} = {}): Promise<void> {
  const dir = join(root, '小组件', 'files')
  if (options.omit === true) return
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'widget.json'), options.manifest ?? await readFile(join(FIXTURE, 'widget.json'), 'utf8'))
  await writeFile(join(dir, 'index.js'), options.index ?? await readFile(join(FIXTURE, 'index.js'), 'utf8'))
}

/** 旧起步夹具的指纹,和加载口钉死的常量必须一致(夹具本身就是从 main 逐字拷的)。 */
describe('夹具与钉死常量对得上', () => {
  it('入口 sha256 前 12 位 = LEGACY_STARTER_FILES_REV(夹具取自主干那一版)', async () => {
    const { createHash } = await import('node:crypto')
    const sha = createHash('sha256').update(await readFile(join(FIXTURE, 'index.js'))).digest('hex').slice(0, 12)
    expect(sha).toBe(LEGACY_STARTER_FILES_REV)
  })
})

describe('旧起步 files 组件:加载口自动按 ops-only 认', () => {
  it('★逐字未改的旧起步 → scan 出的视图带 templates:["ops"],product 落回本体图谱、ops 仍素材', async () => {
    const root = await tempRoot()
    await layFiles(root)
    const svc = createUserLayerService({ dir: root })
    const view = await svc.scan()
    const files = view.widgets.find(widget => widget.id === 'files')
    expect(files?.status).toBe('ok')
    expect(files?.templates).toEqual(['ops'])
    // 用户层一个字没动:清单原样,识别是纯读取时的。
    expect(await readFile(join(root, '小组件', 'files', 'widget.json'), 'utf8'))
      .toBe(await readFile(join(FIXTURE, 'widget.json'), 'utf8'))
  })

  it('★组合验收:旧起步 files 经 ensure 补迁 style.css 后,同时具备 templates:["ops"] 与 style_rev', async () => {
    const root = await tempRoot()
    await layFiles(root)
    const starterRoot = join(process.cwd(), '../user-layer/起步')
    const svc = createUserLayerService({
      dir: root,
      starterDir: starterRoot,
    })
    const ensureResult = await svc.ensure()
    expect(ensureResult.created).toBe(false)

    // 1. 旧起步 index.js 与 widget.json 原汁原味保留(不覆盖)
    expect(await readFile(join(root, '小组件', 'files', 'widget.json'), 'utf8'))
      .toBe(await readFile(join(FIXTURE, 'widget.json'), 'utf8'))
    expect(await readFile(join(root, '小组件', 'files', 'index.js'), 'utf8'))
      .toBe(await readFile(join(FIXTURE, 'index.js'), 'utf8'))

    // 2. style.css 成功补放
    const styleCss = await readFile(join(root, '小组件', 'files', 'style.css'), 'utf8')
    expect(styleCss).toContain('.ben-wb .creator-files')

    // 3. scan() 结果同时拥有 templates: ['ops'] 和 style_rev
    const view = await svc.scan()
    const files = view.widgets.find(widget => widget.id === 'files')
    expect(files?.status).toBe('ok')
    expect(files?.templates).toEqual(['ops'])
    expect(files?.style_rev).toBeDefined()
    expect(files?.style_rev?.length).toBe(12)

    // 4. 重启 ensure 不复生/不重复写
    await svc.ensure()
    const viewAfterRestart = await svc.scan()
    expect(viewAfterRestart.widgets.find(w => w.id === 'files')).toEqual(files)
  })

  it('widgetCode 照旧把入口端出去(兼容不改代码路径)', async () => {
    const root = await tempRoot()
    await layFiles(root)
    const svc = createUserLayerService({ dir: root })
    const code = await svc.widgetCode('files')
    expect(code?.code).toBe(await readFile(join(FIXTURE, 'index.js'), 'utf8'))
  })

  it('入口改一个字 → 不碰(用户动过的不收窄)', async () => {
    const root = await tempRoot()
    const tweaked = `${await readFile(join(FIXTURE, 'index.js'), 'utf8')}\n// 用户加的一行`
    await layFiles(root, { index: tweaked })
    const svc = createUserLayerService({ dir: root })
    const files = (await svc.scan()).widgets.find(widget => widget.id === 'files')
    expect(files?.templates).toBeUndefined()
  })

  it('清单改一个字段(改了 name)→ 不碰', async () => {
    const root = await tempRoot()
    const manifest = (await readFile(join(FIXTURE, 'widget.json'), 'utf8')).replace('素材管理', '我的素材')
    await layFiles(root, { manifest })
    const svc = createUserLayerService({ dir: root })
    const files = (await svc.scan()).widgets.find(widget => widget.id === 'files')
    expect(files?.templates).toBeUndefined()
  })

  it('用户删掉了 files 目录 → 不复生、不报错,别的格照常', async () => {
    const root = await tempRoot()
    await layFiles(root, { omit: true })
    const svc = createUserLayerService({ dir: root })
    const view = await svc.scan()
    expect(view.widgets.find(widget => widget.id === 'files')).toBeUndefined()
  })

  it('重复 scan 幂等:两次视图一致,templates 不会叠、不会丢', async () => {
    const root = await tempRoot()
    await layFiles(root)
    const svc = createUserLayerService({ dir: root })
    const first = await svc.scan()
    const second = await svc.scan()
    expect(second).toEqual(first)
    expect(second.widgets.find(widget => widget.id === 'files')?.templates).toEqual(['ops'])
  })
})

describe('新装(当前起步层)不被兼容逻辑干扰', () => {
  it('当前起步 files 清单自带 templates:["ops"] → 照常,不需要识别也成立', async () => {
    const root = await tempRoot()
    const starter = join(process.cwd(), '../user-layer/起步/小组件/files')
    const dir = join(root, '小组件', 'files')
    await mkdir(dir, { recursive: true })
    await cp(join(starter, 'widget.json'), join(dir, 'widget.json'))
    await cp(join(starter, 'index.js'), join(dir, 'index.js'))
    const svc = createUserLayerService({ dir: root })
    const files = (await svc.scan()).widgets.find(widget => widget.id === 'files')
    expect(files?.status).toBe('ok')
    expect(files?.templates).toEqual(['ops'])
  })
})
