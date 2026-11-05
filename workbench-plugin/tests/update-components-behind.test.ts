// @vitest-environment node
/**
 * 「版本号一样,可这台电脑上还有几样没装上」—— 「有更新」的第三档(2026-10-03)。
 *
 * ## 这一份是为哪一幕写的
 *
 * 0.4.89 刚发完的那十分钟(维护者机器,10:0x):发版闸只装了**插件**(`dsh plugin add`),
 * 装完 `update/check` 回的是 `current == latest == 0.4.89`,于是 `available: false`,
 * 设置里写着「没有更新」。可同一份回包的 `plan.items` 里五样都 `changed: true` ——
 * 事务官后端(没有语气代码)、电话工人(没有中文打断)**都还是旧的**。
 * 维护者亲手 `POST /update/apply` 一次,回的是「已经是最新的了」,一件都没装。
 *
 * 根子:`available` 只认「插件版本号更新」(①)或「只补运行环境」(②)两档,
 * 不认「同一版里还有组件没装到本机」。这一份钉的就是第 ③ 档。
 *
 * ## 两条边界(这一档最容易做错的地方)
 *
 * 1. **「没查出来」不当成「没装」**(D13 的另一面)。`plan` 里 `source: 'none'` 的那几件
 *    说的是"这台电脑上没记过它是哪一份" —— 刚用安装包装好的机器压根没有 `installed.json`,
 *    把它们算成"没装"会让每一台新机器一打开就被告知"有 5 样没装上"。
 *    所以这一档只数**有凭据**的那几件(`record` / `local`:我们知道本机那份是哪一份,而它不一样)。
 * 2. **版本号必须相等**。服务器上比本机旧(维护者机器上常跑着还没发出去的那一版)时一律沉默 ——
 *    否则那颗按钮会把插件降级回公网那一版。
 *
 * 真跑那一截(第二节)与 `update-incremental` 同一套纪律:真 curl、真 shasum、真 tar,
 * 只有会去动真实 DSH 运行时与 launchd 的那几类命令被拦下来;所有落盘都在 mktemp 出来的
 * 临时 HOME 下,删之前逐个核对前缀(0904 铁律)。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { behindItems, parseInstalled, planAssets, serializeInstalled } from '../src/server/update/installed.ts'
import { componentsBehindNotes, createUpdateService } from '../src/server/update/service.ts'
import type { InstalledAssets, UpdateAssetKind, UpdateJobView, UpdateManifest, UpdatePlanView } from '../src/server/update/types.ts'
import { UPDATE_ASSET_TITLES } from '../src/server/update/types.ts'
import { seedInstalledPnpm } from './setup/pnpmFake.ts'

const NOW = Date.parse('2026-10-03T02:00:00Z')
const STALE = '0'.repeat(64)
const PREFIX = join(tmpdir(), 'wb-behind-')

const dirs: string[] = []
const fakes: Server[] = []
afterEach(async () => {
  while (fakes.length) await new Promise<void>((resolve) => { fakes.pop()?.close(() => resolve()) })
  while (dirs.length) {
    const dir = dirs.pop() as string
    // 0904 家目录被删事故之后的纪律:递归删除只许落在本用例前缀下的那个 mkdtemp 沙箱里。
    if (!dir.startsWith(PREFIX) || dir.slice(PREFIX.length).includes('/')) throw new Error(`拒绝删除:${dir}`)
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

function box(): string {
  const dir = mkdtempSync(PREFIX)
  dirs.push(dir)
  return dir
}

function shaOfText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/* ════════════════════ 一、判法(清单 + installed.json) ════════════════════ */

/** 插件包那一份字节(闸刚 `cp` 到 `~/.dsh/packages/plugin.tgz` 的那一份)。 */
const 插件包 = '这是 0.4.89 的插件包(假的)'
const 插件SHA = shaOfText(插件包)

function manifest(over: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    version: '0.4.89',
    notes: '这一版改了什么,发版的人写的那一段',
    assets: {
      plugin_tgz: { url: 'http://127.0.0.1:9/updates/0.4.89/plugin.tgz', sha256: 插件SHA, size: 1_200_000 },
      scripts_tgz: { url: 'http://127.0.0.1:9/updates/0.4.89/scripts.tgz', sha256: 'c'.repeat(64), size: 9_000 },
      butler_server_tgz: { url: 'http://127.0.0.1:9/updates/0.4.89/butler-server.tgz', sha256: 'd'.repeat(64), size: 41_000_000 },
      channel_worker_tgz: { url: 'http://127.0.0.1:9/updates/0.4.89/channel-worker.tgz', sha256: 'e'.repeat(64), size: 349_000_000 },
    },
    ...over,
  }
}

/**
 * 一台机器:`installed.json` 里记着哪几条,`~/.dsh/packages/plugin.tgz` 是哪一份字节。
 *
 * `plugin: false` = 这台机器上没有那个文件(兜底算不出来 → `source: 'none'`)。
 */
function machine(options: {
  installed?: Partial<Record<UpdateAssetKind, string>>
  plugin?: string | false
} = {}): { home: string, paths: ReturnType<typeof setupPaths> } {
  const home = box()
  const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
  mkdirSync(paths.packagesDir, { recursive: true })
  const bytes = options.plugin === undefined ? 插件包 : options.plugin
  if (bytes !== false) writeFileSync(`${paths.packagesDir}/plugin.tgz`, bytes)
  if (options.installed !== undefined) {
    const record: InstalledAssets = { version: '0.4.88', updated_at: new Date(NOW).toISOString(), assets: {} }
    for (const [kind, sha] of Object.entries(options.installed)) {
      record.assets[kind as UpdateAssetKind] = { sha256: sha, version: '0.4.88', at: new Date(NOW).toISOString() }
    }
    mkdirSync(paths.updatesDir, { recursive: true })
    writeFileSync(paths.installedJson, serializeInstalled(record))
  }
  return { home, paths }
}

function serviceOn(home: string, options: { currentVersion: string, manifest?: UpdateManifest }) {
  const real = nodeSetupIo()
  const body = options.manifest ?? manifest()
  const io: SetupIo = {
    ...real,
    fetch: (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  }
  let seq = 0
  return createUpdateService({
    io,
    paths: setupPaths({ home, applicationsDir: join(home, 'Applications') }),
    now: () => NOW,
    newId: () => `job${(seq += 1)}`,
    currentVersion: options.currentVersion,
    manifestUrl: 'http://127.0.0.1:9/updates/latest.json',
    applyTuning: { subPollMs: 0, restartDelayMs: 0, downloadPollMs: 0 },
  })
}

/** 闸刚装完插件的那台机器:记录还是上一版的,三样组件没装。 */
function 刚过闸的机器(): { home: string, paths: ReturnType<typeof setupPaths> } {
  return machine({
    installed: {
      plugin_tgz: STALE,
      scripts_tgz: STALE,
      butler_server_tgz: STALE,
      channel_worker_tgz: STALE,
    },
  })
}

describe('check() · 版本号相等,可组件还没装到这台电脑上', () => {
  it('★算「有更新」,而且 current / latest 照实都是这一版(不编一个新版本号)', async () => {
    const { home } = 刚过闸的机器()
    const view = await serviceOn(home, { currentVersion: '0.4.89' }).check()
    expect(view.available).toBe(true)
    expect(view.components_behind).toBe(true)
    expect(view.current).toBe('0.4.89')
    expect(view.latest).toBe('0.4.89')
    expect(view.runtime_only).toBeUndefined()
  })

  it('★插件那一格认本机那份字节(闸装的就是清单里那一份)—— 不再多装一遍、多重启一次', async () => {
    const { home } = 刚过闸的机器()
    const view = await serviceOn(home, { currentVersion: '0.4.89' }).check()
    const plugin = view.plan?.items.find(item => item.kind === 'plugin_tgz')
    expect(plugin?.changed).toBe(false)
    expect(plugin?.source).toBe('local')
    // 这一趟真要下的只有另外三样(插件那 1.2MB 不在账里)。
    expect(view.plan?.changed).toBe(3)
    expect(view.size).toBe(9_000 + 41_000_000 + 349_000_000)
  })

  it('★「这一版说了什么」换成一句人话:几样没装、是哪几样、装完会重启', async () => {
    const { home } = 刚过闸的机器()
    const view = await serviceOn(home, { currentVersion: '0.4.89' }).check()
    expect(view.notes).not.toBe('这一版改了什么,发版的人写的那一段')
    expect(view.notes).toContain('还没装到这台电脑上')
    expect(view.notes).toContain('3 样')
    expect(view.notes).toContain(UPDATE_ASSET_TITLES.butler_server_tgz)
    expect(view.notes).toContain(UPDATE_ASSET_TITLES.channel_worker_tgz)
    expect(view.notes).toContain('重启')
  })

  it('★一样都没落后(记录与清单逐条相同)→ 照旧「没有更新」,apply 照旧拒', async () => {
    const { home } = machine({
      installed: {
        plugin_tgz: 插件SHA,
        scripts_tgz: 'c'.repeat(64),
        butler_server_tgz: 'd'.repeat(64),
        channel_worker_tgz: 'e'.repeat(64),
      },
    })
    const update = serviceOn(home, { currentVersion: '0.4.89' })
    const view = await update.check()
    expect(view.available).toBe(false)
    expect(view.components_behind).toBeUndefined()
    expect(view.plan?.changed).toBe(0)
    // 发版说明照旧是发版的人写的那一段(没有要装的东西,就没有要解释的事)。
    expect(view.notes).toBe('这一版改了什么,发版的人写的那一段')
    expect(update.apply()).toEqual({ error: '已经是最新的了(0.4.89)。' })
  })

  it('★刚用安装包装好的机器(一条记录都没有)**不算**落后 —— 不许一打开就说「有 4 样没装」', async () => {
    const { home } = machine({ plugin: false })
    const view = await serviceOn(home, { currentVersion: '0.4.89' }).check()
    // 账还是照旧「没查出来就照下」(D13),但那不等于可以对他说"你这台少了 4 样"。
    expect(view.plan?.changed).toBe(4)
    expect(view.plan?.items.every(item => item.source === 'none')).toBe(true)
    expect(view.available).toBe(false)
    expect(view.components_behind).toBeUndefined()
  })

  it('★插件那一行压根没记过、而本机那份字节就是这一版的 → 照样不重装插件,也不算它落后', async () => {
    // 闸在更早那一版就装过插件、而这台机器的 installed.json 从没记过它(老机器的样子)。
    const { home } = machine({ installed: { scripts_tgz: STALE } })
    const view = await serviceOn(home, { currentVersion: '0.4.89' }).check()
    const plugin = view.plan?.items.find(item => item.kind === 'plugin_tgz')
    expect(plugin?.changed).toBe(false)
    expect(plugin?.source).toBe('local')
    // 落后的只有启动脚本那一样(事务官后端 / 通话组件没记过 → 不知道,就不说)。
    expect(view.components_behind).toBe(true)
    expect(behindItems(view.plan as UpdatePlanView).map(item => item.kind)).toEqual(['scripts_tgz'])
    expect(view.notes).toContain('1 样还没装到这台电脑上')
    expect(view.notes).toContain(UPDATE_ASSET_TITLES.scripts_tgz)
    // 这一趟真要下的比"还差这几样"多两样(那两样没记过 → 照下),所以那句话里得说清楚,
    // 不然他会问"为什么补一个启动脚本要下 300 多兆"。
    expect(view.notes).toContain('另外 2 样这台电脑上没记过')
  })

  it('★服务器上那一版比本机旧(维护者机器常跑着还没发的那一版)→ 一律沉默,不给降级的按钮', async () => {
    const { home } = 刚过闸的机器()
    const view = await serviceOn(home, { currentVersion: '0.4.90' }).check()
    expect(view.available).toBe(false)
    expect(view.components_behind).toBeUndefined()
  })

  it('手机包与电脑安装包**不算**没装(这台机器从来不下载它们)', async () => {
    const { home } = 刚过闸的机器()
    const withBoth = manifest({
      assets: {
        ...manifest().assets,
        apk: { url: 'http://127.0.0.1:9/updates/0.4.89/app.apk', sha256: 'f'.repeat(64), size: 32_000_000 },
        installer_dmg: { url: 'http://127.0.0.1:9/updates/0.4.89/工作台安装器-0.4.89.dmg', sha256: '9'.repeat(64), size: 120_000_000 },
      },
    })
    const update = serviceOn(home, { currentVersion: '0.4.89', manifest: withBoth })
    const view = await update.check()
    expect(view.plan?.items.map(item => item.kind)).not.toContain('apk')
    expect(view.plan?.items.map(item => item.kind)).not.toContain('installer_dmg')
    expect(view.notes).not.toContain(UPDATE_ASSET_TITLES.apk)
    expect(view.notes).not.toContain(UPDATE_ASSET_TITLES.installer_dmg)
    // 「有新的手机包」那一格只在插件真有新版时给 —— 这一档里手机包一个字节没变。
    expect(view.apk).toBeUndefined()
    expect(update.apk()).toBeUndefined()
    // 安装包那一格与 available 无关,照旧答得出「那个包在哪」(卡 SM)。
    expect(update.installer()?.version).toBe('0.4.89')
  })

  it('这台机器太旧、跨不过去(min_installer_version 比本机新)→ 不给按钮,apply 也拒', async () => {
    const { home } = 刚过闸的机器()
    const update = serviceOn(home, {
      currentVersion: '0.4.89',
      manifest: manifest({ min_installer_version: '0.4.95' }),
    })
    const view = await update.check()
    expect(view.available).toBe(false)
    expect(view.needs_installer).toContain('重新下一次安装包')
    expect('error' in update.apply()).toBe(true)
  })

  it('/state 那一格(lastCheck)跟着说有、并带上那句人话', async () => {
    const { home } = 刚过闸的机器()
    const update = serviceOn(home, { currentVersion: '0.4.89' })
    await update.check()
    const state = update.lastCheck()
    expect(state?.available).toBe(true)
    expect(state?.current).toBe('0.4.89')
    expect(state?.latest).toBe('0.4.89')
    expect(state?.notes).toContain('还没装到这台电脑上')
  })
})

describe('兄弟路:插件真有新版那一趟一个字没变', () => {
  it('记录陈了、本机那份字节与新版清单对不上 → 照旧下插件(localFirst 只在版本号相等那一趟开)', async () => {
    // 这台机器上 packages/plugin.tgz 是 0.4.88 那一份,清单是 0.4.90。
    const { home } = machine({ plugin: '这是 0.4.88 的插件包(假的)', installed: { plugin_tgz: STALE } })
    const view = await serviceOn(home, {
      currentVersion: '0.4.88',
      manifest: manifest({ version: '0.4.90' }),
    }).check()
    expect(view.available).toBe(true)
    expect(view.components_behind).toBeUndefined()
    expect(view.plan?.items.find(item => item.kind === 'plugin_tgz')?.changed).toBe(true)
    // 发版说明照旧是发版的人写的那一段。
    expect(view.notes).toBe('这一版改了什么,发版的人写的那一段')
  })

  it('★插件版本相等 + 运行环境漂了 → 还是「只补运行环境」那一档(它优先,账里只有那一件)', async () => {
    const { home } = 刚过闸的机器()
    const withRuntime = manifest({
      assets: {
        ...manifest().assets,
        runtime_tgz: { url: 'http://127.0.0.1:9/updates/0.4.89/runtime.tgz', sha256: 'b'.repeat(64), size: 40_000 },
      },
    })
    const real = nodeSetupIo()
    const io: SetupIo = {
      ...real,
      fetch: (async () => new Response(JSON.stringify(withRuntime), { status: 200 })) as typeof fetch,
    }
    const update = createUpdateService({
      io,
      paths: setupPaths({ home, applicationsDir: join(home, 'Applications') }),
      now: () => NOW,
      newId: () => 'job1',
      currentVersion: '0.4.89',
      manifestUrl: 'http://127.0.0.1:9/updates/latest.json',
      runtimeDrift: async () => ({ drifted: true, locked: '0.1.7-rc.2', installed: '0.1.2-rc.1', items: [], detail: '', says: '运行环境还是旧的' }),
    })
    const view = await update.check()
    expect(view.runtime_only).toBe(true)
    expect(view.components_behind).toBeUndefined()
    expect(view.plan?.items.map(item => item.kind)).toEqual(['runtime_tgz'])
    // 补完运行环境之后那一拍才轮到这一档(两趟各自重启一次,顺序是先运行环境)。
    expect(view.notes).toContain('运行环境')
  })
})

/**
 * 审计那条反例,**反过来**(`docs/审计材料/2026-10-03/update.mjs`,origin/main)。
 *
 * 那份脚本的三条断言是「缺陷还在」:`available === false`、两件 changed、
 * `apply().error` 匹配 /已经是最新/。这一条把三条都倒过来,而且照它的形状搭现场 ——
 * 一条 io 桩(`readFile` 回那份 installed.json、`stat` 一律 undefined → 兜底算不出任何 sha),
 * 所以插件那一件靠的是**记录**:它记着新 sha(审计那台机器上插件已经装对了),
 * 工人与事务官后端记着旧 sha。
 */
describe('审计反例 update.mjs · 同版 + 两件组件落后', () => {
  it('★available 为真、两件 changed、apply 不再回「已经是最新的了」', async () => {
    const shaOld = '1'.repeat(64)
    const shaNew = '2'.repeat(64)
    const audit: UpdateManifest = {
      version: '0.4.89',
      released_at: '2026-10-03T02:00:00Z',
      assets: {
        plugin_tgz: { url: 'https://audit.invalid/updates/0.4.89/plugin.tgz', sha256: shaNew, size: 100 },
        channel_worker_tgz: { url: 'https://audit.invalid/updates/0.4.89/channel-worker.tgz', sha256: shaNew, size: 200 },
        butler_server_tgz: { url: 'https://audit.invalid/updates/0.4.89/butler-server.tgz', sha256: shaNew, size: 300 },
      },
    }
    const installed = {
      assets: {
        plugin_tgz: { sha256: shaNew, version: '0.4.89', at: audit.released_at },
        channel_worker_tgz: { sha256: shaOld, version: '0.4.88', at: audit.released_at },
        butler_server_tgz: { sha256: shaOld, version: '0.4.88', at: audit.released_at },
      },
    }
    const io = {
      fetch: (async () => new Response(JSON.stringify(audit))) as typeof fetch,
      readFile: async () => JSON.stringify(installed),
      stat: async () => undefined,
    } as unknown as SetupIo
    const update = createUpdateService({
      io,
      paths: setupPaths({ home: '/tmp/audit-do-not-write' }),
      now: () => Date.parse(audit.released_at as string),
      newId: () => 'audit',
      currentVersion: '0.4.89',
      manifestUrl: 'https://audit.invalid/updates/latest.json',
    })
    const check = await update.check()
    expect(check.current).toBe('0.4.89')
    expect(check.latest).toBe('0.4.89')
    expect(check.available).toBe(true)
    expect(check.components_behind).toBe(true)
    expect(check.plan?.items.filter(item => item.changed).length).toBe(2)
    expect(behindItems(check.plan as UpdatePlanView).map(item => item.kind)).toEqual(['butler_server_tgz', 'channel_worker_tgz'])
    const started = update.apply()
    expect('error' in started).toBe(false)
  })
})

describe('behindItems · 只数有凭据的那几件', () => {
  it('记录说不一样、本机那份字节说不一样 → 算;压根没记过 → 不算', () => {
    const plan = planAssets(manifest(), {
      assets: {
        scripts_tgz: { sha256: STALE, version: '0.4.88', at: '' },
        channel_worker_tgz: { sha256: STALE, version: '0.4.88', at: '' },
      },
    }, { plugin_tgz: '7'.repeat(64) })
    // 四件都要下(没记过的那一件照下,D13),但只有三件**有凭据**说明本机那份对不上。
    expect(plan.changed).toBe(4)
    expect(behindItems(plan).map(item => item.kind)).toEqual(['plugin_tgz', 'scripts_tgz', 'channel_worker_tgz'])
    expect(behindItems(plan).every(item => item.source !== 'none')).toBe(true)
  })

  it('一件都没落后时回空数组(不回 undefined,调用方不用分叉)', () => {
    const plan = planAssets(manifest(), { assets: {} })
    expect(behindItems(plan)).toEqual([])
  })
})

describe('componentsBehindNotes · 那句人话', () => {
  it('说清三件事:几样没装 / 是哪几样 / 要下多大、装完会重启;不出现内部词', () => {
    const plan = planAssets(manifest(), {
      assets: {
        plugin_tgz: { sha256: 插件SHA, version: '0.4.89', at: '' },
        butler_server_tgz: { sha256: STALE, version: '0.4.88', at: '' },
        channel_worker_tgz: { sha256: STALE, version: '0.4.88', at: '' },
      },
    })
    const says = componentsBehindNotes('0.4.89', behindItems(plan), plan)
    expect(says).toContain('0.4.89')
    expect(says).toContain('2 样')
    expect(says).toContain('事务官本机后端')
    expect(says).toContain('通话组件')
    expect(says).toContain('重启')
    expect(says).toContain('MB')
    for (const word of ['npm', 'sha', 'sha256', 'installed.json', 'profile', '校验和', '依赖树']) {
      expect(says, word).not.toContain(word)
    }
  })
})

/* ════════════════════ 二、临时 HOME 里真走一遍 ════════════════════ */

function sha256OfFile(path: string): string {
  return execFileSync('shasum', ['-a', '256', path], { encoding: 'utf8' }).trim().split(/\s+/)[0] as string
}

async function serveDir(root: string): Promise<string> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0] as string).replace(/^\/+/, '')
    const file = join(root, name)
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404); res.end('no'); return
    }
    res.writeHead(200, { 'content-length': String(statSync(file).size) })
    createReadStream(file).pipe(res)
  })
  fakes.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
}

/** 造一版:插件 + 启动脚本 + 通话组件三样产物 + 一份 latest.json(摆成仓库的样子)。 */
function publish(serverRoot: string, origin: string, version: string): void {
  const dir = join(serverRoot, 'updates', version)
  mkdirSync(dir, { recursive: true })

  const pluginStage = join(serverRoot, `plugin-${version}/package`)
  mkdirSync(pluginStage, { recursive: true })
  writeFileSync(join(pluginStage, 'package.json'), JSON.stringify({ name: '@ben/dsh-workbench', version }))
  execFileSync('tar', ['-czf', join(dir, 'plugin.tgz'), '-C', join(serverRoot, `plugin-${version}`), 'package'])

  const scripts = join(serverRoot, 'scripts-stage')
  mkdirSync(join(scripts, 'workbench-plugin/bin'), { recursive: true })
  mkdirSync(join(scripts, 'deploy'), { recursive: true })
  mkdirSync(join(scripts, 'butler-server/launchd'), { recursive: true })
  writeFileSync(join(scripts, 'workbench-plugin/bin/dsh-start'), `#!/usr/bin/env bash\necho dsh-start ${version}\n`)
  writeFileSync(join(scripts, 'workbench-plugin/bin/butler-start'), '#!/usr/bin/env bash\necho butler-start\n')
  writeFileSync(join(scripts, 'deploy/channel-start'), '#!/usr/bin/env bash\necho channel-start\n')
  writeFileSync(join(scripts, 'deploy/ai.deepseek.dsh.plist'), '<plist><dict><key>P</key><string>{{HOME}}/.dsh/bin/dsh-start</string></dict></plist>\n')
  writeFileSync(join(scripts, 'butler-server/launchd/ai.deepseek.butler.plist'), '<plist><dict><key>P</key><string>{{HOME}}/.dsh/bin/butler-start</string></dict></plist>\n')
  execFileSync('tar', ['-czf', join(dir, 'scripts.tgz'), '-C', scripts, 'workbench-plugin', 'deploy', 'butler-server'])

  const worker = join(serverRoot, 'worker-stage')
  // 装工人那一步会先看 payload 里有没有 @livekit/rtc-node(原生模块必须跟着走)。
  mkdirSync(join(worker, 'channel-worker/node_modules/@livekit/rtc-node'), { recursive: true })
  mkdirSync(join(worker, 'channel-worker/src'), { recursive: true })
  writeFileSync(join(worker, 'channel-worker/src/main.ts'), `console.log("假工人 ${version}")\n`)
  writeFileSync(join(worker, 'channel-worker/node_modules/@livekit/rtc-node/package.json'), '{"name":"@livekit/rtc-node"}\n')
  execFileSync('tar', ['-czf', join(dir, 'channel-worker.tgz'), '-C', worker, 'channel-worker'])

  const asset = (file: string): { url: string, sha256: string, size: number } => ({
    url: `${origin}/updates/${version}/${file}`,
    sha256: sha256OfFile(join(dir, file)),
    size: statSync(join(dir, file)).size,
  })
  writeFileSync(join(serverRoot, 'updates/latest.json'), `${JSON.stringify({
    version,
    notes: `这是 ${version}。`,
    assets: {
      plugin_tgz: asset('plugin.tgz'),
      scripts_tgz: asset('scripts.tgz'),
      channel_worker_tgz: asset('channel-worker.tgz'),
    },
  }, null, 2)}\n`)
}

function isFaked(cmd: readonly string[]): boolean {
  const bin = cmd[0] ?? ''
  // launchctl **按整条 argv 认**(2026-10-13):重启那一下是 `/bin/sh -c '… exec launchctl …'`,
  // 只看 cmd[0] 这道硬线就失效了,会把真服务重启掉。
  if (cmd.some(arg => arg.includes('launchctl'))) return true
  if (bin === 'npm' || bin === 'rsync' || bin === 'codesign') return true
  return cmd.includes('plugin') && cmd.includes('--profile')
}

describe('真走一遍:闸装完插件之后,更新路把剩下那两样补上', () => {
  it('★版本号相等 + 两样有凭据落后 → 装那两样、插件不重下、装完 installed.json 记齐、下一次 check 都 same', async () => {
    const home = box()
    const serverRoot = box()
    const origin = await serveDir(serverRoot)
    publish(serverRoot, origin, '9.9.9')

    const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
    // ── 把现场摆成「闸刚装完插件」的样子 ──
    // ① `~/.dsh/packages/plugin.tgz` 就是清单里那一份字节(闸 `cp` 过去的那一下);
    mkdirSync(paths.packagesDir, { recursive: true })
    copyFileSync(join(serverRoot, 'updates/9.9.9/plugin.tgz'), `${paths.packagesDir}/plugin.tgz`)
    // ② `installed.json` 还是上一版那几条 —— 闸从 10-03 起会顺手把 `plugin_tgz` 那一行记上
    //    (`local-install-gate.sh` 第 5 下),但**记不上的时候(写不进去、或者闸是更早那一版)
    //    就是这个样子**,这一档正是那时候的兜底。
    mkdirSync(paths.updatesDir, { recursive: true })
    writeFileSync(paths.installedJson, serializeInstalled({
      version: '9.9.8',
      assets: {
        plugin_tgz: { sha256: STALE, version: '9.9.8', at: '' },
        scripts_tgz: { sha256: STALE, version: '9.9.8', at: '' },
        channel_worker_tgz: { sha256: STALE, version: '9.9.8', at: '' },
      },
    }))
    // 这台机器上自带的 pnpm 已经装好了(装插件那一步判「已经在了,不用装」,不去联网下)。
    seedInstalledPnpm(paths)

    const curls: string[][] = []
    const real = nodeSetupIo()
    const io: SetupIo = {
      ...real,
      exec: async (cmd: readonly string[], options?: SetupExecOptions) => {
        if (cmd[0] === 'curl') curls.push([...cmd])
        if (isFaked(cmd)) return { ok: true, code: 0, out: '(用例拦下来的)' }
        return await real.exec(cmd, options)
      },
      uid: () => 501,
    }
    const make = (): ReturnType<typeof createUpdateService> => createUpdateService({
      io,
      paths,
      now: () => Date.now(),
      newId: (() => { let n = 0; return () => `bh-${++n}-${Math.random().toString(16).slice(2)}` })(),
      // 闸装完、重启过了:跑着的插件就是清单里那一版。
      currentVersion: '9.9.9',
      manifestUrl: `${origin}/updates/latest.json`,
      checkIntervalMs: 0,
      applyTuning: { subPollMs: 0, restartDelayMs: 0, downloadPollMs: 0 },
    })

    const update = make()
    const checked = await update.check()
    expect(checked.available).toBe(true)
    expect(checked.components_behind).toBe(true)
    expect(checked.plan?.changed).toBe(2)
    expect(checked.plan?.items.find(item => item.kind === 'plugin_tgz')?.changed).toBe(false)

    const started = update.apply() as UpdateJobView
    expect('error' in started).toBe(false)
    await update.waitJob(started.id)
    const job = update.job(started.id) as UpdateJobView
    expect(job.error).toBeUndefined()
    expect(job.state).toBe('done')

    // ① 只下了那两样,插件那一份一次都没 curl(闸已经把它装上了)。
    expect(curls.length).toBe(2)
    expect(curls.map(one => one.join(' ')).join('\n')).not.toContain('/plugin.tgz')
    const assets = `${home}/.dsh/updates/9.9.9/assets`
    expect(existsSync(`${assets}/scripts.tgz`)).toBe(true)
    expect(existsSync(`${assets}/channel-worker.tgz`)).toBe(true)
    expect(existsSync(`${assets}/plugin.tgz`)).toBe(false)
    // ② 插件那一句进「本来就不用换」,不进「这一版没带」。
    expect(job.unchanged.join('\n')).toContain('工作台本体')
    expect(job.skipped.join('\n')).not.toContain('工作台本体')
    // ③ 装完照样重启(真换了两样)。
    expect(job.restarting).toBe(true)

    // ④ installed.json **记齐**:装上去那两样记成这一版,插件那一条也补成本机那份字节
    //    —— 这正是「下一次 check 都 same」的前提。
    const record = parseInstalled(readFileSync(paths.installedJson, 'utf8'))
    expect(record.assets.plugin_tgz?.sha256).toBe(sha256OfFile(join(serverRoot, 'updates/9.9.9/plugin.tgz')))
    expect(record.assets.scripts_tgz?.sha256).toBe(sha256OfFile(join(serverRoot, 'updates/9.9.9/scripts.tgz')))
    expect(record.assets.channel_worker_tgz?.sha256).toBe(sha256OfFile(join(serverRoot, 'updates/9.9.9/channel-worker.tgz')))

    // ⑤ 再查一次:三样都 same,「没有更新」,按钮也按不动了。
    const again = make()
    const after = await again.check()
    expect(after.plan?.changed).toBe(0)
    expect(after.available).toBe(false)
    expect(after.components_behind).toBeUndefined()
    expect(again.apply()).toEqual({ error: '已经是最新的了(9.9.9)。' })
    expect(`${home}/.dsh`.startsWith(tmpdir())).toBe(true)
  }, 120_000)
})
