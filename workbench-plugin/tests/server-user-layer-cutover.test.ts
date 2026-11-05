// @vitest-environment node
/**
 * 用户层切割收尾(2026-10-26,卡「用户层切割收尾:采集器与偏好摄入、升级保全用户定制」):
 *
 * 1. **偏好真读用户层目录**:rules.json / prompt-overrides.json(+ .log.jsonl)/ dispatch-prefs.json
 *    从 `~/.dsh/workbench/` 切到 `~/.dsh/workbench/用户层/偏好/`;老位置一次性迁移(老文件保留、
 *    不再读),幂等,坏文件不炸,她删过的不复生。
 * 2. **采集器真读用户层目录**:定义从 `<工作目录>/采集器/` 切到 `用户层/采集器/`(采回来的
 *    数据还在工作目录 `数据/<名>/`);老位置一次性迁移,同一套 保留/幂等/不炸/不复生。
 * 3. **升级保全(先行红例)**:模拟热更后第二次启动(新服务实例 + ensure + 迁移再跑一遍),
 *    她定制过的 采集器/偏好/小组件/布局 逐字不动;她删过的一份布局不复生。
 *
 * 全部用临时目录真跑真文件(路径注入纪律);USER_LAYER_FOLDERS 两行的 live 标志与契约文本
 * 也有对照断言,防回头。
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  USER_LAYER_FOLDERS, contractText, createUserLayerService, defaultUserLayerDir,
  legacyPrefsMoves, migrateLegacyFilesOnce,
} from '../src/server/userLayer.ts'
import { createCollectorsService, type CollectorBrowser } from '../src/server/collectors.ts'
import { createRulesService, defaultRulesFile } from '../src/server/rules.ts'
import { defaultPromptOverridesFile, defaultPromptOverridesLogFile } from '../src/server/promptOverrides.ts'
import { createDispatchPrefsService, defaultDispatchPrefsFile } from '../src/server/dispatchPrefs.ts'
import { STARTER_LAYER_DIR } from './helpers/starterLayer.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-cutover-'))
  dirs.push(dir)
  return dir
}

const readOrUndef = (path: string): string | undefined => {
  try { return readFileSync(path, 'utf8') }
  catch { return undefined }
}

const fakeBrowser: CollectorBrowser = {
  openWindow: async () => 9222,
  readPage: async (_profileDir, url) => ({ href: url, title: '店铺后台', text: '成交金额 ¥1,234.00' }),
}

const VALID_RULES = JSON.stringify({ version: 1, rules: [{ id: 'r1', text: '不要蓝', status: 'kept', created_at: '2026-09-24T00:00:00+08:00', updated_at: '2026-09-24T00:00:00+08:00', adopted_at: '2026-09-24T00:00:00+08:00' }], events: [], reviews: [] })

describe('偏好切进 用户层/偏好', () => {
  it('默认路径对照:三份(含日志)都指到 用户层/偏好/', () => {
    const home = '/Users/x'
    const prefs = join(home, '.dsh', 'workbench', '用户层', '偏好')
    expect(defaultRulesFile(home)).toBe(join(prefs, 'rules.json'))
    expect(defaultPromptOverridesFile(home)).toBe(join(prefs, 'prompt-overrides.json'))
    expect(defaultPromptOverridesLogFile(home)).toBe(join(prefs, 'prompt-overrides.log.jsonl'))
    expect(defaultDispatchPrefsFile(home)).toBe(join(prefs, 'dispatch-prefs.json'))
  })

  it('老位置一次性迁移:老文件保留、坏文件原样搬进不炸、第二次不盖她的改动、删了不复生', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    await writeFile(join(oldWb, 'prompt-overrides.json'), '{ 这玩意儿坏了', 'utf8') // 坏文件:原样搬、不炸
    await writeFile(join(oldWb, 'dispatch-prefs.json'), JSON.stringify({ tell_scope: { mine: true, dispatch: false, meeting: true, routine: true }, auto_desk: true }), 'utf8')
    await writeFile(join(oldWb, 'prompt-overrides.log.jsonl'), '{"at":"2026-10-01T00:00:00+08:00"}\n', 'utf8')

    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    const first = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect([...first.copied].sort()).toEqual(['dispatch-prefs.json', 'prompt-overrides.json', 'prompt-overrides.log.jsonl', 'rules.json'])

    // 新位置内容与老位置逐字一致;老位置保留(不删)
    for (const name of ['rules.json', 'prompt-overrides.json', 'dispatch-prefs.json', 'prompt-overrides.log.jsonl']) {
      expect(readOrUndef(join(prefsDir, name))).toBe(readOrUndef(join(oldWb, name)))
      expect(existsSync(join(oldWb, name))).toBe(true)
    }

    // 她的改动不被第二次启动盖掉(幂等:只补缺,从不覆盖)
    const hers = '{ "version": 1, "rules": [], "events": [], "reviews": [], " hers": true }\n'
    await writeFile(join(prefsDir, 'rules.json'), hers, 'utf8')
    const second = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(second.copied).toEqual([])
    expect(readOrUndef(join(prefsDir, 'rules.json'))).toBe(hers)

    // 她删掉新位置的文件:迁移不再搬回来(删后不复生)
    await rm(join(prefsDir, 'rules.json'))
    await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(existsSync(join(prefsDir, 'rules.json'))).toBe(false)
    // 老位置依旧在(保留,只是不再读)
    expect(existsSync(join(oldWb, 'rules.json'))).toBe(true)
  })

  it('坏的老 rules.json 搬进新位置后,规矩服务读它不炸、退回缺省', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), 'not json at all', 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    const rules = createRulesService({ file: defaultRulesFile(home) })
    await expect(rules.load()).resolves.toBeUndefined()
  })
})

describe('采集器定义切进 用户层/采集器', () => {
  const DEF_店铺 = JSON.stringify({ version: 1, name: '店铺', url: 'https://ark.xiaohongshu.com/app/data', profile: 'collector-abc', created_at: '2026-09-23T00:00:00+08:00' })

  function setup(home: string, workdir: string, defsDir: string) {
    return createCollectorsService({
      workdir: () => workdir,
      profileRoot: join(home, '.dsh', 'workbench'),
      browser: fakeBrowser,
      now: () => Date.parse('2026-10-26T09:00:00+08:00'),
      defsDir,
      legacyDefsDir: () => join(workdir, '采集器'),
    })
  }

  it('定义从用户层读;老位置一次性迁移(保留/幂等/不复生);新增写新位置;数据仍落工作目录', async () => {
    const home = tmp()
    const workdir = join(home, '运营')
    const legacy = join(workdir, '采集器')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, '店铺.json'), DEF_店铺, 'utf8')
    await writeFile(join(legacy, '坏.json'), '{ 坏', 'utf8')
    const defsDir = join(defaultUserLayerDir(home), '采集器')

    const service = setup(home, workdir, defsDir)
    await service.load()
    const names = service.view().items.map(one => one.name)
    expect(names).toContain('店铺')
    expect(names).not.toContain('坏') // 坏定义不进清单、不炸

    // 迁移 = 拷贝:老位置保留,新位置逐字一致
    expect(readOrUndef(join(defsDir, '店铺.json'))).toBe(DEF_店铺)
    expect(existsSync(join(legacy, '店铺.json'))).toBe(true)

    // 新增写新位置,不写老位置
    const added = await service.add({ name: '新品', url: 'https://ark.xiaohongshu.com/app/new' })
    expect(added.ok).toBe(true)
    expect(existsSync(join(defsDir, '新品.json'))).toBe(true)
    expect(existsSync(join(legacy, '新品.json'))).toBe(false)

    // 跑一次:数据仍落 工作目录/数据/<名>/,不进用户层
    const ran = await service.run('店铺', 'manual')
    expect(ran.ok).toBe(true)
    expect(readOrUndef(join(workdir, '数据', '店铺', '最新.txt'))).toContain('成交金额')
    expect(existsSync(join(defsDir, '数据'))).toBe(false)

    // 她改了新位置的定义:重起(新实例)不盖她的改动
    const hers = DEF_店铺.replace('"note"', '"note"') // noop 保持合法
    const edited = `${hers.slice(0, -2)},\n  "note": "她加的备注"\n}\n`
    await writeFile(join(defsDir, '店铺.json'), edited, 'utf8')
    const restarted = setup(home, workdir, defsDir)
    await restarted.load()
    expect(readOrUndef(join(defsDir, '店铺.json'))).toBe(edited)

    // 她删了新位置的定义:重起不从老位置搬回来(删后不复生)
    await rm(join(defsDir, '店铺.json'))
    const restarted2 = setup(home, workdir, defsDir)
    await restarted2.load()
    expect(existsSync(join(defsDir, '店铺.json'))).toBe(false)
    expect(restarted2.view().items.map(one => one.name)).not.toContain('店铺')
    expect(existsSync(join(legacy, '店铺.json'))).toBe(true)
  })

  it('撤:定义进 用户层/采集器/.trash/,数据不删', async () => {
    const home = tmp()
    const workdir = join(home, '运营')
    const defsDir = join(defaultUserLayerDir(home), '采集器')
    const service = setup(home, workdir, defsDir)
    await service.load()
    await service.add({ name: '店铺', url: 'https://ark.xiaohongshu.com/app/data' })
    await service.run('店铺', 'manual')
    const removed = await service.remove('店铺')
    expect(removed.ok).toBe(true)
    expect(existsSync(join(defsDir, '.trash'))).toBe(true)
    expect(existsSync(join(workdir, '数据', '店铺', '最新.txt'))).toBe(true)
  })
})

describe('升级保全用户定制(先行红例)', () => {
  it('热更后第二次启动:采集器/偏好/小组件/布局她的定制逐字不动,她删过的布局不复生', async () => {
    const home = tmp()
    const userDir = defaultUserLayerDir(home)
    const oldWb = join(home, '.dsh', 'workbench')
    const workdir = join(home, '运营')
    await mkdir(oldWb, { recursive: true })
    await mkdir(join(workdir, '采集器'), { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    await writeFile(join(oldWb, 'dispatch-prefs.json'), JSON.stringify({ tell_scope: { mine: true, dispatch: true, meeting: false, routine: true }, auto_desk: false }), 'utf8')
    await writeFile(join(workdir, '采集器', '店铺.json'), DEF_MIGRATED, 'utf8')

    // ── 「老版本」第一次启动:建骨架 + 起步层 + 迁移 ──
    const first = createUserLayerService({ dir: userDir, starterDir: STARTER_LAYER_DIR, legacyModulesDir: join(oldWb, 'modules') })
    await first.ensure()
    await migrateLegacyFilesOnce(join(userDir, '偏好'), legacyPrefsMoves(home, join(userDir, '偏好')))
    const collectors1 = createCollectorsService({
      workdir: () => workdir,
      profileRoot: join(oldWb),
      browser: fakeBrowser,
      now: () => Date.parse('2026-10-26T09:00:00+08:00'),
      defsDir: join(userDir, '采集器'),
      legacyDefsDir: () => join(workdir, '采集器'),
    })
    await collectors1.load()

    // ── 她定制四样 ──
    const prefsHers = '{ "version": 1, "rules": [{ "id": "r9", "text": "她自己写的规矩", "status": "kept", "created_at": "2026-10-26T00:00:00+08:00", "updated_at": "2026-10-26T00:00:00+08:00", "adopted_at": "2026-10-26T00:00:00+08:00" }], "events": [], "reviews": [] }\n'
    await writeFile(join(userDir, '偏好', 'rules.json'), prefsHers, 'utf8')
    const collectorHers = JSON.stringify({ version: 1, name: '店铺', url: 'https://ark.xiaohongshu.com/app/data', profile: 'collector-abc', created_at: '2026-09-23T00:00:00+08:00', note: '她改过的定义' }) + '\n'
    await writeFile(join(userDir, '采集器', '店铺.json'), collectorHers, 'utf8')
    const widgetHers = '/* 她的小组件定制 */\nmodule.exports = { NotesModule() { return null } }\n'
    await writeFile(join(userDir, '小组件', 'notes', 'index.js'), widgetHers, 'utf8')
    const layoutHers = '{ "contract": 1, "id": "ops", "name": "她的运营", "portrait": [{ "id": "projects", "order": 0, "row": 0, "basis_pct": 30 }], "landscape": [{ "id": "projects", "order": 0, "row": 0, "basis_pct": 30 }] }\n'
    await writeFile(join(userDir, '布局', 'ops.json'), layoutHers, 'utf8')
    // 她删了起步层布局里的皮肤:升级不得复活
    await rm(join(userDir, '布局', 'ops.css'))

    // ── 「热更后」第二次启动:全新服务实例 + 同款起步层 + 迁移再跑 ──
    const second = createUserLayerService({ dir: userDir, starterDir: STARTER_LAYER_DIR, legacyModulesDir: join(oldWb, 'modules') })
    await second.ensure()
    await migrateLegacyFilesOnce(join(userDir, '偏好'), legacyPrefsMoves(home, join(userDir, '偏好')))
    const collectors2 = createCollectorsService({
      workdir: () => workdir,
      profileRoot: join(oldWb),
      browser: fakeBrowser,
      now: () => Date.parse('2026-10-26T10:00:00+08:00'),
      defsDir: join(userDir, '采集器'),
      legacyDefsDir: () => join(workdir, '采集器'),
    })
    await collectors2.load()

    // 四样逐字不动
    expect(readOrUndef(join(userDir, '偏好', 'rules.json'))).toBe(prefsHers)
    expect(readOrUndef(join(userDir, '采集器', '店铺.json'))).toBe(collectorHers)
    expect(readOrUndef(join(userDir, '小组件', 'notes', 'index.js'))).toBe(widgetHers)
    expect(readOrUndef(join(userDir, '布局', 'ops.json'))).toBe(layoutHers)
    expect(existsSync(join(userDir, '布局', 'ops.css'))).toBe(false)

    // 服务真读她定制后的那一份
    expect(collectors2.view().items.find(one => one.name === '店铺')?.note).toBe('她改过的定义')
    const rules = createRulesService({ file: defaultRulesFile(home) })
    await rules.load()
    expect(rules.view().rules.some(one => one.text === '她自己写的规矩')).toBe(true)
    const prefs = createDispatchPrefsService({ file: defaultDispatchPrefsFile(home) })
    await prefs.load()
    expect(prefs.view().tell_scope.meeting).toBe(false)
  })
})

const hash12 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)

const DEF_MIGRATED = JSON.stringify({ version: 1, name: '店铺', url: 'https://ark.xiaohongshu.com/app/data', profile: 'collector-abc', created_at: '2026-09-23T00:00:00+08:00' })

describe('清单与契约对照(防回头)', () => {
  it('USER_LAYER_FOLDERS:采集器与偏好 live,契约文本写进两样的格式', () => {
    const collectors = USER_LAYER_FOLDERS.find(one => one.name === '采集器')
    const prefs = USER_LAYER_FOLDERS.find(one => one.name === '偏好')
    expect(collectors?.live).toBe(true)
    expect(prefs?.live).toBe(true)
    const text = contractText('/tmp/x')
    expect(text).toContain('## 采集器')
    expect(text).toContain('## 偏好')
    expect(text).toContain('偏好/rules.json')
    expect(text).toContain('采集器/<名>.json')
  })
})

describe('独立 HOME 真跑(整流程对照)', () => {
  it('HOME 指向全新临时目录:建层 → 老文件迁移 → 服务真读 → 升级再跑,前后一致', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wb-cutover-home-'))
    dirs.push(home)
    const oldWb = join(home, '.dsh', 'workbench')
    const workdir = join(home, '运营')
    await mkdir(join(oldWb), { recursive: true })
    await mkdir(join(workdir, '采集器'), { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    await writeFile(join(oldWb, 'prompt-overrides.json'), JSON.stringify({ version: 1, overrides: [{ stage: 'onboarding', body: '她改过的提示词' }] }), 'utf8')
    await writeFile(join(workdir, '采集器', '店铺.json'), DEF_MIGRATED, 'utf8')

    const before = async () => {
      const service = createUserLayerService({ dir: defaultUserLayerDir(home), starterDir: STARTER_LAYER_DIR, legacyModulesDir: join(oldWb, 'modules') })
      await service.ensure()
      await migrateLegacyFilesOnce(join(service.dir, '偏好'), legacyPrefsMoves(home, join(service.dir, '偏好')))
      const collectors = createCollectorsService({
        workdir: () => workdir, profileRoot: oldWb, browser: fakeBrowser,
        now: () => Date.parse('2026-10-26T09:00:00+08:00'),
        defsDir: join(service.dir, '采集器'), legacyDefsDir: () => join(workdir, '采集器'),
      })
      await collectors.load()
      const rules = createRulesService({ file: defaultRulesFile(home) })
      await rules.load()
      return { service, collectors, rules }
    }

    // 第一遍(装机/老版本首次启动)
    const round1 = await before()
    expect(round1.collectors.view().items.map(one => one.name)).toContain('店铺')
    expect(round1.rules.view().rules.some(one => one.id === 'r1')).toBe(true)

    // 她用起来:加一条偏好、改采集器
    await writeFile(join(round1.service.dir, '偏好', 'prompt-overrides.json'), JSON.stringify({ version: 1, overrides: [{ stage: 'onboarding', body: '她又改过一版' }] }), 'utf8')
    await round1.collectors.add({ name: '新品', url: 'https://ark.xiaohongshu.com/app/new' })

    // 第二遍(升级后重启):全部照旧
    const round2 = await before()
    expect(readOrUndef(join(round2.service.dir, '偏好', 'prompt-overrides.json'))).toContain('她又改过一版')
    expect(round2.collectors.view().items.map(one => one.name).sort()).toEqual(['店铺', '新品'])
  })

  it('process.env.HOME 真换:全部 default 路径(不带参)自己落到临时 HOME,迁移与升级前后对照', async () => {
    const realHome = process.env.HOME
    const home = await mkdtemp(join(tmpdir(), 'wb-cutover-envhome-'))
    dirs.push(home)
    process.env.HOME = home
    try {
      const oldWb = join(home, '.dsh', 'workbench')
      const workdir = join(home, '运营')
      await mkdir(oldWb, { recursive: true })
      await mkdir(join(workdir, '采集器'), { recursive: true })
      await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
      await writeFile(join(workdir, '采集器', '店铺.json'), DEF_MIGRATED, 'utf8')

      const boot = async () => {
        const service = createUserLayerService({ dir: defaultUserLayerDir(), starterDir: STARTER_LAYER_DIR, legacyModulesDir: join(oldWb, 'modules') })
        await service.ensure()
        await migrateLegacyFilesOnce(join(service.dir, '偏好'), legacyPrefsMoves(home, join(service.dir, '偏好')))
        const collectors = createCollectorsService({
          workdir: () => workdir, profileRoot: oldWb, browser: fakeBrowser,
          now: () => Date.parse('2026-10-26T09:00:00+08:00'),
          defsDir: join(service.dir, '采集器'), legacyDefsDir: () => join(workdir, '采集器'),
        })
        await collectors.load()
        const rules = createRulesService({ file: defaultRulesFile() })
        await rules.load()
        return { service, collectors, rules }
      }

      const before = await boot()
      expect(before.service.dir).toBe(join(home, '.dsh', 'workbench', '用户层'))
      expect(before.rules.view().rules.some(one => one.id === 'r1')).toBe(true)
      expect(before.collectors.view().items.map(one => one.name)).toContain('店铺')

      // 升级前快照 → 她改四处 → 升级后对照
      const snap = (root: string) => ({
        rules: readOrUndef(join(root, '偏好', 'rules.json')),
        collector: readOrUndef(join(root, '采集器', '店铺.json')),
        notes: readOrUndef(join(root, '小组件', 'notes', 'index.js')),
        layout: readOrUndef(join(root, '布局', 'ops.json')),
      })
      const hers = snap(before.service.dir)
      const rulesHers = hers.rules!.replace('"不要蓝"', '"不要蓝(她自己又改了一遍)"')
      await writeFile(join(before.service.dir, '偏好', 'rules.json'), rulesHers, 'utf8')
      const collectorHers = hers.collector!.replace('}', ',\n  "note": "她加的"\n}\n')
      await writeFile(join(before.service.dir, '采集器', '店铺.json'), collectorHers, 'utf8')
      const after = await boot()
      expect(snap(after.service.dir)).toEqual({ ...hers, rules: rulesHers, collector: collectorHers })
    }
    finally {
      process.env.HOME = realHome
    }
  })
})

describe('迁移失败语义(2026-10-26 统筹退修;第五轮按不变量重写)', () => {
  const MIGRATION_MARKER = '.迁过'

  /** 让一份「源」变成目录:copyFile 真失败(ENOTSUP ≠ ENOENT),模拟 EACCES/EIO 那类临时错误。 */
  async function breakSource(path: string) {
    await rm(path, { force: true })
    await mkdir(path)
  }

  /** 挡住某一步持久写的临时路径(tag 决定哪一步)。 */
  async function blockPersist(prefsDir: string, tag: string) {
    await mkdir(join(prefsDir, `${MIGRATION_MARKER}.part-${process.pid}-${tag}`), { recursive: true })
  }

  const unblockPersist = (prefsDir: string, tag: string) =>
    rm(join(prefsDir, `${MIGRATION_MARKER}.part-${process.pid}-${tag}`), { recursive: true, force: true })

  const markerItems = (prefsDir: string): Record<string, { stage: string, staging?: string, sha?: string }> => {
    try {
      const raw = JSON.parse(readFileSync(join(prefsDir, MIGRATION_MARKER), 'utf8')) as { items?: Record<string, { stage: string, staging?: string, sha?: string }> }
      return raw.items ?? {}
    }
    catch { return {} }
  }

  it('真实失败不谎称已迁:源在而拷不动 → failed、回退认领;恢复后补迁;已发布且她删过的不复生', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    await writeFile(join(oldWb, 'prompt-overrides.json'), JSON.stringify({ version: 1, overrides: [] }), 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')

    // 第一遍:prompt-overrides 的源「坏了」(目录 → 拷不动);rules 正常发布
    await breakSource(join(oldWb, 'prompt-overrides.json'))
    const first = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(first.copied).toEqual(['rules.json'])
    expect(first.failed).toEqual(['prompt-overrides.json'])
    expect(first.done).toBe(false)
    expect(markerItems(prefsDir)['rules.json']?.stage).toBe('published')
    expect(existsSync(join(prefsDir, 'prompt-overrides.json'))).toBe(false)
    expect(readOrUndef(join(prefsDir, 'rules.json'))).toBe(VALID_RULES)

    // 她用起来:删掉已发布的 rules.json —— 终态,永不重拷
    await rm(join(prefsDir, 'rules.json'))
    // 源修好后重启:补迁 prompt-overrides;rules.json 不复生
    await rm(join(oldWb, 'prompt-overrides.json'), { recursive: true, force: true })
    await writeFile(join(oldWb, 'prompt-overrides.json'), JSON.stringify({ version: 1, overrides: [{ stage: 'onboarding', body: '她的提示词' }] }), 'utf8')
    const second = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(second.copied).toEqual(['prompt-overrides.json'])
    expect(second.failed).toEqual([])
    expect(second.done).toBe(true)
    expect(readOrUndef(join(prefsDir, 'prompt-overrides.json'))).toContain('她的提示词')
    expect(existsSync(join(prefsDir, 'rules.json'))).toBe(false) // 已发布后她删的:不复活
    expect(markerItems(prefsDir)['rules.json']?.stage).toBe('published')
  })

  it('源不存在 ≠ 失败:记 absent 终态(一次性:后来再出现的也不迁)', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    const first = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(first.copied).toEqual(['rules.json'])
    expect(first.failed).toEqual([])
    expect(first.done).toBe(true)
    await writeFile(join(oldWb, 'dispatch-prefs.json'), JSON.stringify({ tell_scope: { mine: false, dispatch: false, meeting: false, routine: false }, auto_desk: true }), 'utf8')
    const second = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(second.copied).toEqual([])
    expect(existsSync(join(prefsDir, 'dispatch-prefs.json'))).toBe(false)
  })

  it('她先建好的目标被认养:不覆盖、她的字节原样、记 adopted 终态;删掉不复生', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    await mkdir(prefsDir, { recursive: true })
    const hers = '{ "version": 1, "rules": [], "events": [], "reviews": [], "她先建的": true }\n'
    await writeFile(join(prefsDir, 'rules.json'), hers, 'utf8')
    const first = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(first.copied).toEqual([])
    expect(first.failed).toEqual([])
    expect(readOrUndef(join(prefsDir, 'rules.json'))).toBe(hers)
    expect(markerItems(prefsDir)['rules.json']?.stage).toBe('adopted')
    await rm(join(prefsDir, 'rules.json'))
    const second = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(existsSync(join(prefsDir, 'rules.json'))).toBe(false)
    expect(second.done).toBe(true)
  })

  it('采集器老定义迁移失败:view() 如实说「没迁成、下次再试」,不谎称已迁', async () => {
    const home = tmp()
    const workdir = join(home, '运营')
    const legacy = join(workdir, '采集器')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, '店铺.json'), DEF_MIGRATED, 'utf8')
    const defsDir = join(defaultUserLayerDir(home), '采集器')
    await mkdir(defsDir, { recursive: true })
    await chmod(defsDir, 0o555) // 目标目录只读:认领落盘真失败(EACCES)
    const service = createCollectorsService({
      workdir: () => workdir,
      profileRoot: join(home, '.dsh', 'workbench'),
      browser: fakeBrowser,
      now: () => Date.parse('2026-10-26T09:00:00+08:00'),
      defsDir,
      legacyDefsDir: () => legacy,
    })
    await service.load()
    const view = service.view()
    expect(view.items.map(one => one.name)).toEqual([])
    expect(view.note ?? '').toContain('没迁成')
    await chmod(defsDir, 0o755)
    const service2 = createCollectorsService({
      workdir: () => workdir,
      profileRoot: join(home, '.dsh', 'workbench'),
      browser: fakeBrowser,
      now: () => Date.parse('2026-10-26T09:00:00+08:00'),
      defsDir,
      legacyDefsDir: () => legacy,
    })
    await service2.load()
    expect(service2.view().items.map(one => one.name)).toEqual(['店铺'])
    expect(service2.view().note ?? '').not.toContain('没迁成')
  })
})


describe('迁移阶段不变量(2026-10-26 五轮验收:I1 不删用户文件 / I2 跨进程按记录恢复 / I3 三态区分)', () => {
  const MIGRATION_MARKER = '.迁过'

  /** 挡住某一步持久写的临时路径(只挡那一步:认领/暂存身份/已发布)。 */
  async function blockPersist(prefsDir: string, tag: string) {
    await mkdir(join(prefsDir, `${MIGRATION_MARKER}.part-${process.pid}-${tag}`), { recursive: true })
  }

  const unblockPersist = (prefsDir: string, tag: string) =>
    rm(join(prefsDir, `${MIGRATION_MARKER}.part-${process.pid}-${tag}`), { recursive: true, force: true })

  const markerItems = (prefsDir: string): Record<string, { stage: string, staging?: string, sha?: string }> => {
    try {
      const raw = JSON.parse(readFileSync(join(prefsDir, MIGRATION_MARKER), 'utf8')) as { items?: Record<string, { stage: string, staging?: string, sha?: string }> }
      return raw.items ?? {}
    }
    catch { return {} }
  }

  /** 目录里没有我们留下的暂存(挡路临时目录是测试自己放的,不算)。 */
  const leftovers = (dir: string) => {
    try { return readdirSync(dir).filter(name => name.includes('.migrating')) }
    catch { return [] }
  }

  const writeMarker = async (prefsDir: string, items: unknown) => {
    await mkdir(prefsDir, { recursive: true })
    await writeFile(join(prefsDir, MIGRATION_MARKER), JSON.stringify({ _note: '', items }), 'utf8')
  }

  it('已发布但记录没记上(写 published 失败):目标是我们的;她删目标后重启=不确定,绝不复生、绝不 done:true', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    await blockPersist(prefsDir, 'published') // 认领、暂存身份都落盘;最后一步「记已发布」失败

    const first = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(first.done).toBe(false)
    expect(first.failed).toContain('rules.json')
    expect(first.markerError ?? '').not.toBe('')
    expect(readOrUndef(join(prefsDir, 'rules.json'))).toBe(VALID_RULES) // 已发布,内容是我们的
    expect(markerItems(prefsDir)['rules.json']?.stage).toBe('staged') // 记录仍待确认

    // 她删目标;摘掉挡路;重启 —— 暂存没了目标也没了 = 不确定:不重拷、不关闭
    await rm(join(prefsDir, 'rules.json'))
    await unblockPersist(prefsDir, 'published')
    const second = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(existsSync(join(prefsDir, 'rules.json'))).toBe(false)
    expect(second.done).toBe(false)
    expect(second.failed).toContain('rules.json')
    expect(second.markerError ?? '').not.toBe('')
    const third = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(existsSync(join(prefsDir, 'rules.json'))).toBe(false) // 持续不确定,持续如实报
    expect(third.done).toBe(false)
  })

  it('未发布可重试:认领后、暂存身份写失败 → 目标从不暴露;恢复后重启完成迁移(这不是复生)', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    await blockPersist(prefsDir, 'staged') // 认领落盘;暂存身份写失败

    const first = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(first.done).toBe(false)
    expect(first.failed).toContain('rules.json')
    expect(existsSync(join(prefsDir, 'rules.json'))).toBe(false) // 未持久化的目标没有暴露
    expect(leftovers(prefsDir)).toEqual([]) // 我们刚建的暂存也清了
    expect(markerItems(prefsDir)['rules.json']?.stage).toBe('claimed')

    await unblockPersist(prefsDir, 'staged')
    const second = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(second.copied).toEqual(['rules.json']) // 未发布 → 完成它
    expect(second.done).toBe(true)
    expect(readOrUndef(join(prefsDir, 'rules.json'))).toBe(VALID_RULES)
  })

  it('I1 她的正式文件一个字不动:staged 恢复时目标已是她的内容 → 认养,原文快照不变;暂存只清「记录点名+指纹对得上」的那份', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    const ours = JSON.stringify({ version: 1, overrides: [{ stage: 'onboarding', body: '老位置版本' }] })
    await writeFile(join(oldWb, 'prompt-overrides.json'), ours, 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    const moves = legacyPrefsMoves(home, prefsDir).filter(move => move.to.endsWith('prompt-overrides.json'))
    // 先正常迁一遍拿到合法 staged 记录,再手工复现「staged 待恢复 + 她刚写了正式目标」
    await migrateLegacyFilesOnce(prefsDir, moves)
    const staged = markerItems(prefsDir)['prompt-overrides.json']
    expect(staged?.stage).toBe('published')
    // 复现恢复现场:记录拨回 staged,目标换成她刚写的文件,另放一份「名对但内容不对」的假暂存
    const hers = '{ "version": 1, "overrides": [], "她刚写的": true }\n'
    await writeFile(join(prefsDir, 'prompt-overrides.json'), hers, 'utf8')
    const foreignStaging = 'prompt-overrides.json.migrating-deadbeef'
    await writeFile(join(prefsDir, foreignStaging), '别人的暂存', 'utf8')
    await writeMarker(prefsDir, {
      'rules.json': { stage: 'absent' },
      'prompt-overrides.json': { stage: 'staged', staging: foreignStaging, sha: staged?.sha ?? '000000000000' },
    })
    const hersBefore = readOrUndef(join(prefsDir, 'prompt-overrides.json'))
    const result = await migrateLegacyFilesOnce(prefsDir, moves)
    expect(readOrUndef(join(prefsDir, 'prompt-overrides.json'))).toBe(hersBefore) // 她的字节逐字不变
    expect(readOrUndef(join(prefsDir, 'prompt-overrides.json'))).toBe(hers)
    expect(result.failed).toEqual([])
    expect(markerItems(prefsDir)['prompt-overrides.json']?.stage).toBe('adopted')
    expect(existsSync(join(prefsDir, foreignStaging))).toBe(true) // 指纹对不上:不碰
    // 真暂存(记录点名+指纹对)才被清:再放一份真指纹的,认养时清掉
    const realStaging = 'prompt-overrides.json.migrating-cafef00d'
    await writeFile(join(prefsDir, realStaging), ours, 'utf8')
    await writeMarker(prefsDir, { 'prompt-overrides.json': { stage: 'staged', staging: realStaging, sha: hash12(ours) } })
    await migrateLegacyFilesOnce(prefsDir, moves)
    expect(existsSync(join(prefsDir, realStaging))).toBe(false) // 证明是我们的,清了
    expect(readOrUndef(join(prefsDir, 'prompt-overrides.json'))).toBe(hers) // 她的还在
  })

  it('I2 跨真实子进程:子进程A发布后「记已发布」失败退出,子进程B(不同 PID)按记录里的暂存身份完成恢复', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    const userLayerTs = join(import.meta.dirname, '..', 'src', 'server', 'userLayer.ts')
    const childScript = join(home, 'child.mjs')
    await writeFile(childScript, [
      `import { mkdir } from 'node:fs/promises'`,
      `import { join } from 'node:path'`,
      `import { defaultUserLayerDir, legacyPrefsMoves, migrateLegacyFilesOnce } from ${JSON.stringify(userLayerTs)}`,
      `const home = process.argv[2]`,
      `const prefsDir = join(defaultUserLayerDir(home), '偏好')`,
      `await mkdir(join(prefsDir, '.迁过.part-' + process.pid + '-published'), { recursive: true })`,
      `const result = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))`,
      `console.log(JSON.stringify({ pid: process.pid, result }))`,
    ].join('\n'), 'utf8')
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync(process.execPath, ['--experimental-strip-types', childScript, home], { encoding: 'utf8' })
    const child = JSON.parse(out.trim().split('\n').pop() as string) as { pid: number, result: { done: boolean, failed: string[] } }
    expect(child.result.done).toBe(false) // A:发布成功但记录没记上
    expect(child.result.failed).toContain('rules.json')
    expect(child.pid).not.toBe(process.pid) // 真的是另一个进程
    expect(readOrUndef(join(prefsDir, 'rules.json'))).toBe(VALID_RULES) // A 已发布
    const stagedRecord = markerItems(prefsDir)['rules.json']
    expect(stagedRecord?.stage).toBe('staged')
    expect(stagedRecord?.staging ?? '').toContain('.migrating-') // 暂存身份在案,不依赖 PID

    // B(本进程,不同 PID):目标是我们的(指纹对) → 补记已发布,完成恢复
    const recovered = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(recovered.done).toBe(true)
    expect(recovered.copied).toEqual([])
    expect(markerItems(prefsDir)['rules.json']?.stage).toBe('published')
    expect(readOrUndef(join(prefsDir, 'rules.json'))).toBe(VALID_RULES)
  })

  it('I3 未发布三窗口(新进程视角):claimed 崩溃重试 / staged 暂存还在完成发布(暂存名带旧 PID 也找得到)/ 暂存丢失目标不在=不确定', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    const moves = legacyPrefsMoves(home, prefsDir)

    // 窗口①:claimed 后崩溃(复制前)—— 记录 claimed、什么都没发布 → 重启重试成功
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    await writeMarker(prefsDir, { 'rules.json': { stage: 'claimed' } })
    const r1 = await migrateLegacyFilesOnce(prefsDir, moves.filter(move => move.to.endsWith('rules.json')))
    expect(r1.copied).toEqual(['rules.json'])
    expect(r1.done).toBe(true)
    expect(readOrUndef(join(prefsDir, 'rules.json'))).toBe(VALID_RULES)

    // 窗口②:staged 后、发布前崩溃 —— 暂存名带着「旧进程」的痕迹(这里用假 PID 999999 证明不按当前 PID 推)
    await rm(join(prefsDir, 'rules.json'))
    const stagedName = 'rules.json.migrating-f00d999999'
    await writeFile(join(prefsDir, stagedName), VALID_RULES, 'utf8')
    await writeMarker(prefsDir, { 'rules.json': { stage: 'staged', staging: stagedName, sha: hash12(VALID_RULES) } })
    const r2 = await migrateLegacyFilesOnce(prefsDir, moves.filter(move => move.to.endsWith('rules.json')))
    expect(r2.copied).toEqual(['rules.json']) // 完成自己的发布,不是从老位置重拷
    expect(readOrUndef(join(prefsDir, 'rules.json'))).toBe(VALID_RULES)
    expect(existsSync(join(prefsDir, stagedName))).toBe(false)

    // 窗口③:暂存丢了、目标也不在 —— 不确定:保留 staged、如实报、绝不 done:true、绝不重拷
    await rm(join(prefsDir, 'rules.json'))
    await writeMarker(prefsDir, { 'rules.json': { stage: 'staged', staging: 'rules.json.migrating-不在了', sha: hash12(VALID_RULES) } })
    const r3 = await migrateLegacyFilesOnce(prefsDir, moves.filter(move => move.to.endsWith('rules.json')))
    expect(existsSync(join(prefsDir, 'rules.json'))).toBe(false)
    expect(r3.done).toBe(false)
    expect(r3.failed).toContain('rules.json')
    expect(r3.markerError ?? '').not.toBe('')
    const r4 = await migrateLegacyFilesOnce(prefsDir, moves.filter(move => move.to.endsWith('rules.json')))
    expect(r4.done).toBe(false) // 持续不确定,持续报;老位置还在也不再进来
    expect(existsSync(join(prefsDir, 'rules.json'))).toBe(false)
  })

  it('marker 存在但读坏(损坏内容 / EACCES 类):不假装没有 —— 不动、不报完成', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    await mkdir(prefsDir, { recursive: true })
    await writeFile(join(prefsDir, MIGRATION_MARKER), '{ 这不是 json', 'utf8')
    const first = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(first.copied).toEqual([])
    expect(first.done).toBe(false)
    expect(first.failed).toContain('rules.json')
    expect(first.markerError ?? '').not.toBe('')
    expect(existsSync(join(prefsDir, 'rules.json'))).toBe(false)
    await rm(join(prefsDir, MIGRATION_MARKER))
    await mkdir(join(prefsDir, MIGRATION_MARKER)) // 记录是目录:读失败同理
    const second = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
    expect(second.copied).toEqual([])
    expect(second.done).toBe(false)
    expect(second.markerError ?? '').not.toBe('')
    expect(existsSync(join(prefsDir, 'rules.json'))).toBe(false)
  })
})

describe('来源/目标不可读 ≠ 不存在(2026-10-26 五轮返工)', () => {
  const MIGRATION_MARKER = '.迁过'

  const markerItems = (prefsDir: string): Record<string, { stage: string, staging?: string, sha?: string }> => {
    try {
      const raw = JSON.parse(readFileSync(join(prefsDir, MIGRATION_MARKER), 'utf8')) as { items?: Record<string, { stage: string, staging?: string, sha?: string }> }
      return raw.items ?? {}
    }
    catch { return {} }
  }

  it('源父目录 EACCES:不记 absent、不写终态,如实 failed;恢复权限后下次迁入原字节(finally 恢复权限)', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    const unreadable = join(oldWb, '不可读')
    await mkdir(unreadable, { recursive: true })
    await writeFile(join(unreadable, 'rules.json'), VALID_RULES, 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    const moves = [{ from: join(unreadable, 'rules.json'), to: join(prefsDir, 'rules.json') }]
    await chmod(unreadable, 0o000) // 只有源的父目录不可访问:access 抛 EACCES,不是 ENOENT(marker 在别的分支,可读)
    try {
      const first = await migrateLegacyFilesOnce(prefsDir, moves)
      expect(first.done).toBe(false)
      expect(first.failed).toContain('rules.json')
      expect(first.markerError ?? '').not.toBe('')
      expect(markerItems(prefsDir)['rules.json']).toBeUndefined() // 不许写任何终态(尤其不许 absent)
    }
    finally {
      await chmod(unreadable, 0o755) // finally 恢复,不碰真实目录语义
    }
    const second = await migrateLegacyFilesOnce(prefsDir, moves)
    expect(second.copied).toEqual(['rules.json'])
    expect(second.done).toBe(true)
    expect(readOrUndef(join(prefsDir, 'rules.json'))).toBe(VALID_RULES) // 原字节
  })

  it('目标位置读不准(EACCES):不盲 rename 覆盖、不当「她删过」关闭,如实 failed;恢复后重试成功', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    const lockedDir = join(prefsDir, '锁住的子目录')
    await mkdir(lockedDir, { recursive: true })
    await chmod(lockedDir, 0o000)
    const moves = [{ from: join(oldWb, 'rules.json'), to: join(lockedDir, 'rules.json') }]
    try {
      const first = await migrateLegacyFilesOnce(prefsDir, moves)
      expect(first.done).toBe(false)
      expect(first.failed).toContain('rules.json')
      expect(first.markerError ?? '').not.toBe('')
      expect(markerItems(prefsDir)['rules.json']).toBeUndefined() // 没写终态
    }
    finally {
      await chmod(lockedDir, 0o755)
    }
    const second = await migrateLegacyFilesOnce(prefsDir, moves)
    expect(second.copied).toEqual(['rules.json'])
    expect(readOrUndef(join(lockedDir, 'rules.json'))).toBe(VALID_RULES)
  })

  it('staged 记录结构坏(staging 带 ../、绝对路径,或缺 sha):拒读 —— 不动、不越界碰任何文件', async () => {
    const home = tmp()
    const oldWb = join(home, '.dsh', 'workbench')
    await mkdir(oldWb, { recursive: true })
    await writeFile(join(oldWb, 'rules.json'), VALID_RULES, 'utf8')
    const prefsDir = join(defaultUserLayerDir(home), '偏好')
    const sentinel = join(home, '越界哨兵.txt')
    await writeFile(sentinel, '别碰我', 'utf8')
    const badMarkers: unknown[] = [
      { 'rules.json': { stage: 'staged', staging: '../../越界哨兵.txt', sha: 'abcdef012345' } },
      { 'rules.json': { stage: 'staged', staging: '/etc/passwd', sha: 'abcdef012345' } },
      { 'rules.json': { stage: 'staged', staging: 'rules.json.migrating-ok', sha: 'not-a-hash!!' } },
      { 'rules.json': { stage: 'staged', staging: 'rules.json.migrating-ok' } }, // 缺 sha
      { 'rules.json': { stage: 'staged', staging: '子/名', sha: 'abcdef012345' } },
    ]
    for (const items of badMarkers) {
      await mkdir(prefsDir, { recursive: true })
      await writeFile(join(prefsDir, MIGRATION_MARKER), JSON.stringify({ _note: '', items }), 'utf8')
      const result = await migrateLegacyFilesOnce(prefsDir, legacyPrefsMoves(home, prefsDir))
      expect(result.copied).toEqual([])
      expect(result.done).toBe(false)
      expect(result.failed).toContain('rules.json')
      expect(result.markerError ?? '').not.toBe('')
      expect(existsSync(join(prefsDir, 'rules.json'))).toBe(false) // 没有盲迁
      expect(readOrUndef(sentinel)).toBe('别碰我') // 越界目标一个没碰
    }
  })

  it('采集器老位置 readdir EACCES ≠ 没有:view() 如实说读不出来;恢复权限后下次迁入', async () => {
    const home = tmp()
    const workdir = join(home, '运营')
    const legacy = join(workdir, '采集器')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, '店铺.json'), DEF_MIGRATED, 'utf8')
    const defsDir = join(defaultUserLayerDir(home), '采集器')
    const make = () => createCollectorsService({
      workdir: () => workdir,
      profileRoot: join(home, '.dsh', 'workbench'),
      browser: fakeBrowser,
      now: () => Date.parse('2026-10-26T09:00:00+08:00'),
      defsDir,
      legacyDefsDir: () => legacy,
    })
    await chmod(workdir, 0o000) // 父目录不可读:readdir EACCES
    let first
    try {
      first = make()
      await first.load()
      const view = first.view()
      expect(view.note ?? '').not.toBe('') // 如实说,不静默当「没有老位置」
    }
    finally {
      await chmod(workdir, 0o755)
    }
    expect(readOrUndef(join(defsDir, '店铺.json'))).toBeUndefined() // 没迁就是没迁
    const second = make()
    await second.load()
    expect(second.view().items.map(one => one.name)).toEqual(['店铺']) // 恢复后迁入
    expect(readOrUndef(join(defsDir, '店铺.json'))).toBe(DEF_MIGRATED)
  })
})
