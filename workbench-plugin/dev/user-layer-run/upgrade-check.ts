/**
 * 用户层 · 升级保全验收驱动(2026-10-27,卡 t-e64e5d90;把《交接-1026-用户层切割收尾》里
 * 「装旧版→升级→核对用户层」五步草案做成一条命令):
 *
 *     node --experimental-strip-types dev/user-layer-run/upgrade-check.ts
 *
 * 走法(复用 `tests/update-e2e.test.ts` 验证过的那套真更新机械,不另写装机/更新逻辑):
 *
 *   N-1 = 0.4.149 → N = 当前 main 的 0.4.160:
 *   1. 隔离 HOME(mktemp)里用**真实的 `setup/install.ts`** 装 N-1 插件包(prebuilt pluginTarball,
 *      与热更新 apply 同一条装包代码);
 *   2. 起真服务(源码 = N-1 这一版),ensure 建骨架,造四样定制(采集器走真 /collector/add API,
 *      偏好/小组件/布局按真实契约格式落文件);
 *   3. **走真实更新路**:本地 http 清单服务器 + 真 `createUpdateService().check()/apply()` ——
 *      真下载(curl + shasum 校验)、真解包、真跑 install.ts 的 plugin 步把 N 换掉
 *      (`dsh plugin add` 与 launchctl 与 update-e2e 同款假法:隔离 HOME 里没有运行时,它们会去
 *      动真机;包的落盘与替换是真的,逐字节核 sha256);
 *   4. 起服务(N 源码,全新实例 = 重启):四样逐字对照、被加载口真装上(/state 证据)、
 *      删掉布局后 ensure 不复生、小组件改坏 → 真 /user-layer/report 报坏 → 端回上一版
 *      (跨重启仍端上一版)、偏好坏文件不炸退回缺省。
 *
 * 全程临时目录(0904 铁律:只删自己 mktemp 的那几棵),不碰真机 ~/.dsh / 8791 / 个人 profile,
 * 不下载不安装、不起 GUI 安装器、不签名、不发版。端口全用 0(让系统分),不抢固定口。
 * 退出码:0 = 全过;1 = 有红。
 *
 * 真旧版开关(2026-10-27 统筹补):`UPGRADE_FROM_TGZ=<本地路径或 https://…/plugin.tgz>` 给了就用它
 * 当 N-1(我们更新服务器上真 0.4.149 的那份);URL 走 `curl -fL` 下到临时目录,并取同目录更新清单
 * (…/updates/beta.json)里的 `plugin_tgz.sha256` 逐字节核对,对不上就红、不硬跑。缺省不变:
 * 当前构建产物打标 ${N1_VERSION}。
 *
 * 如实边界(写进报告,不夸大):
 *   - 拿不到 0.4.149 的旧源码树:N-1 的包用**当前构建产物**打、版本号标 0.4.149。驱动的是
 *     「真实更新机械 + 用户层保全判法」,不是新旧两版代码差异本身;
 *   - profile 注册那一跳(`dsh plugin add`)在隔离环境没有运行时,与 update-e2e 同款假法拦下,
 *     但拦之前 install.ts 真把包拷进了 ~/.dsh/packages —— 换包是否成功按那份逐字节核。
 */
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkbenchServer } from '../../src/server/http.ts'
import { startWorkbenchServer } from '../../src/server/http.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { createTasksService } from '../../src/server/tasks.ts'
import { createRulesService } from '../../src/server/rules.ts'
import { createCollectorsService } from '../../src/server/collectors.ts'
import { createExecutionLeaseStore } from '../../src/server/executionLease.ts'
import { defaultUserLayerDir, createUserLayerService, type UserLayerService } from '../../src/server/userLayer.ts'
import { createSetupInstaller } from '../../src/server/setup/install.ts'
import { nodeSetupIo, type SetupIo } from '../../src/server/setup/io.ts'
import { setupPaths } from '../../src/server/setup/paths.ts'
import { createUpdateService } from '../../src/server/update/service.ts'
import { engineHarness } from '../../tests/helpers/engineHarness.ts'
import { seedInstalledPnpm } from '../../tests/setup/pnpmFake.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..', '..')
const N_VERSION = (JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as { version: string }).version
const N1_VERSION = '0.4.149'

const results: { name: string, ok: boolean, detail: string }[] = []
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

const sleep = (ms: number): Promise<void> => new Promise(ok => { setTimeout(ok, ms) })
const sha256File = (path: string): string => execFileSync('shasum', ['-a', '256', path], { encoding: 'utf8' }).trim().split(/\s+/)[0] as string
const revOf = (code: string): string => createHash('sha256').update(code).digest('hex').slice(0, 12)

/** 0904 铁律:只删自己 mktemp 出来的、且落在系统临时目录里的树。 */
function removeTree(dir: string): void {
  if (!dir.startsWith(tmpdir())) throw new Error(`拒绝删除临时目录之外的路径:${dir}`)
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
}

/** 静态只读 http(照 update-e2e 的 serveDir)。 */
async function serveDir(root: string): Promise<{ origin: string, close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0] as string).replace(/^\/+/, '')
    const file = join(root, name)
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('no'); return }
    res.writeHead(200, { 'content-length': String(statSync(file).size) })
    createReadStream(file).pipe(res)
  })
  await new Promise<void>(ok => { server.listen(0, '127.0.0.1', () => ok()) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise(ok => { server.close(() => ok()) }) }
}

/** 打一份「npm pack 形状」的插件包:{ package/package.json + package/lib/... }。 */
function packPlugin(dir: string, version: string, marker: string): string {
  const stage = join(dir, `stage-${version}`)
  mkdirSync(join(stage, 'package', 'lib'), { recursive: true })
  writeFileSync(join(stage, 'package', 'package.json'), JSON.stringify({ name: '@ben/dsh-workbench', version }, null, 2), 'utf8')
  writeFileSync(join(stage, 'package', 'lib', 'index.js'), `// ${marker}\nmodule.exports = {}\n`, 'utf8')
  const tgz = join(dir, `workbench-${version}.tgz`)
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'package'])
  removeTree(stage)
  return tgz
}

/** 从插件 tgz 里读版本号({ package/package.json } 的 npm pack 形状)。 */
function versionOfTgz(tgz: string): string {
  const raw = execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return (JSON.parse(raw) as { version?: string }).version ?? ''
}

/** 用 curl 取一个 URL 的文本(更新清单用)。 */
function curlText(url: string): string {
  return execFileSync('curl', ['-fsSL', '--connect-timeout', '15', url], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
}

/**
 * N-1 包从哪来(统筹 2026-10-27):`UPGRADE_FROM_TGZ` 给了就用它(真 0.4.149);
 * 缺省 = 当前构建产物打标 ${N1_VERSION}。URL 情形下载到临时目录并对更新清单(beta.json)核 sha256。
 */
function resolveN1Package(): { tgz: string, version: string, sha256: string, source: string } {
  const given = process.env.UPGRADE_FROM_TGZ?.trim()
  if (given === undefined || given === '') {
    const tgz = packPlugin(box, N1_VERSION, `插件 ${N1_VERSION}(当前构建产物打标)`)
    return { tgz, version: N1_VERSION, sha256: sha256File(tgz), source: `当前构建产物打标 ${N1_VERSION}` }
  }
  if (/^https?:\/\//.test(given)) {
    const downloads = join(box, 'downloads')
    mkdirSync(downloads, { recursive: true })
    const tgz = join(downloads, 'n1-plugin.tgz')
    console.log(`下载真 N-1:${given}`)
    execFileSync('curl', ['-fL', '--retry', '2', '--connect-timeout', '20', '-o', tgz, given], { stdio: ['ignore', 'ignore', 'inherit'] })
    // 同目录更新清单里的 sha256 逐字节核(清单地址由 tgz 地址推:…/updates/<版本>/plugin.tgz → …/updates/beta.json)
    const manifestUrl = given.replace(/\/updates\/[^/]+\/plugin\.tgz$/, '/updates/beta.json')
    const manifest = JSON.parse(curlText(manifestUrl)) as { assets?: { plugin_tgz?: { sha256?: string, url?: string } } }
    const expected = manifest.assets?.plugin_tgz?.sha256
    const actual = sha256File(tgz)
    if (expected === undefined) throw new Error(`更新清单 ${manifestUrl} 里没有 plugin_tgz.sha256,核不了,不硬跑`)
    if (actual !== expected) throw new Error(`N-1 包 sha256 对不上清单:实际 ${actual},清单 ${expected} —— 不硬跑`)
    const version = versionOfTgz(tgz) || N1_VERSION
    return { tgz, version, sha256: actual, source: `真旧版 ${given}(清单核过 sha256)` }
  }
  const local = resolve(given)
  if (!existsSync(local)) throw new Error(`UPGRADE_FROM_TGZ 指向的本地文件不存在:${local}`)
  return { tgz: local, version: versionOfTgz(local) || N1_VERSION, sha256: sha256File(local), source: `本地 ${local}` }
}

/** 会被换成假的那几类命令(同 update-e2e:它们会去动真机运行时 / launchd)。 */
function isFaked(cmd: readonly string[]): boolean {
  const bin = cmd[0] ?? ''
  if (cmd.some(arg => arg.includes('launchctl'))) return true
  if (bin === 'npm' || bin === 'rsync' || bin === 'codesign') return true
  return cmd.includes('plugin') && cmd.includes('--profile')
}

const box = mkdtempSync(join(tmpdir(), 'wb-upgrade-check-'))
const home = join(box, '隔离home')
const workdir = join(home, '运营')
const layerDir = defaultUserLayerDir(home)
const widgetDir = join(layerDir, '小组件', 'files')
const prefsDir = join(layerDir, '偏好')
const MANIFEST = { contract: 1, id: 'files', name: '素材管理', replaces: 'files', entry: 'index.js', export: 'FilesModule' }
const HER_WIDGET = 'module.exports = { FilesModule: function FilesModule() { return "她的素材管理 定制版" } }'
const HER_LAYOUT = JSON.stringify({
  contract: 1, id: 'ops', name: '她的运营布局',
  portrait: [{ id: 'projects', order: 0, row: 0, basis_pct: 30 }],
  landscape: [{ id: 'projects', order: 0, row: 0, basis_pct: 30 }],
})
const HER_RULES = JSON.stringify({
  version: 1,
  rules: [{ id: 'r1', text: '不要蓝', status: 'kept', created_at: '2026-10-27T00:00:00+08:00', updated_at: '2026-10-27T00:00:00+08:00', adopted_at: '2026-10-27T00:00:00+08:00' }],
  events: [], reviews: [],
})
const BAD_WIDGET = 'function ( 这一版是故意写坏的'

async function main(): Promise<void> {
  console.log(`隔离目录:${box}`)
  const n1 = resolveN1Package()
  console.log(`升级:${n1.version} → ${N_VERSION}(N-1 来源:${n1.source})`)
  const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
  mkdirSync(workdir, { recursive: true })
  seedInstalledPnpm(paths)
  const faked: string[][] = []
  const realIo = nodeSetupIo()
  const io: SetupIo = {
    ...realIo,
    exec: async (cmd, options) => {
      if (isFaked(cmd)) { faked.push([...cmd]); return { ok: true, code: 0, out: '(隔离验收拦下来的:真机会动运行时/launchd)' } }
      return await realIo.exec(cmd, options)
    },
    uid: () => 501,
  }

  /* ── ① 隔离 HOME 里装 N-1(真实 install.ts,prebuilt 包)────────────────── */
  const pkgN1 = n1.tgz
  const repoSkeleton = join(box, 'repo')
  mkdirSync(join(repoSkeleton, 'workbench-plugin'), { recursive: true })
  const installerN1 = createSetupInstaller({
    io, paths, repoRoot: repoSkeleton, now: () => Date.now(), newId: () => randomUUID(),
    prebuilt: { pluginTarball: pkgN1 }, recordButlerCwd: false,
  })
  const subN1 = installerN1.start('plugin')
  await installerN1.wait(subN1.id)
  if (subN1.state === 'failed') throw new Error(`N-1 插件步没装成:${subN1.error ?? ''}`)
  const n1Placed = join(paths.packagesDir, pkgN1.split('/').pop() ?? 'n1.tgz')
  check(`N-1(${n1.version})装进隔离 profile(真实 install.ts)`, existsSync(n1Placed) && sha256File(n1Placed) === n1.sha256, `${n1Placed} 落盘且 sha256 与原件一致`)

  /* ── ② 起服务(N-1 代码),ensure 建骨架,造四样定制 ────────────────────── */
  async function bootServer(): Promise<{ server: WorkbenchServer, userLayer: UserLayerService, url: string }> {
    const userLayer = createUserLayerService({ dir: layerDir, bodyDir: join(box, '本体') })
    await userLayer.ensure()
    const engineRig = engineHarness({ connected: () => false })
    const rules = createRulesService({ file: join(prefsDir, 'rules.json') })
    await rules.load().catch(() => undefined)
    const collectors = createCollectorsService({
      workdir: () => workdir,
      defsDir: join(layerDir, '采集器'),
      profileRoot: join(home, '.dsh', 'workbench'),
      browser: { openWindow: async () => 9222, readPage: async (_d, url) => ({ href: url, title: '', text: '' }) },
    })
    await collectors.load()
    const server = await startWorkbenchServer({
      engine: engineRig.engine,
      engineRegistry: engineRig.registry,
      port: 0,
      service: createWorkbenchService({}),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      tasks: createTasksService({ file: join(box, `tasks-${Date.now()}.json`), newId: () => randomUUID() }),
      userLayer,
      rules,
      collectors,
      appInstalled: () => true,
      dispatchRun: {
        runCli: () => ({ pid: 4321, exited: new Promise<{ code: number | null }>(() => {}) }),
        resolveCli: family => ({ found: true, family, bin: `/fake/${family}`, source: 'bundled' }),
        resultDir: box,
        lease: createExecutionLeaseStore({ file: join(box, 'execution-leases.json') }),
      },
    })
    return { server, userLayer, url: server.url }
  }
  let rig = await bootServer()

  // 采集器走真 API(服务端写定义);偏好/小组件/布局按真实契约格式落文件(她的那一层本来就允许她手改)
  const added = await fetch(`${rig.url}/collector/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '店铺', url: 'https://ark.xiaohongshu.com/app/data' }) })
  const addedBody = await added.json() as { ok?: boolean, error?: string }
  check('造定制:采集器走真 /collector/add', added.ok && addedBody.ok === true, `POST /collector/add → 定义落 用户层/采集器/店铺.json${addedBody.ok === true ? '' : `(回执:${addedBody.error ?? JSON.stringify(addedBody)})`}`)
  mkdirSync(widgetDir, { recursive: true })
  writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify(MANIFEST), 'utf8')
  writeFileSync(join(widgetDir, 'index.js'), HER_WIDGET, 'utf8')
  mkdirSync(join(layerDir, '布局'), { recursive: true })
  writeFileSync(join(layerDir, '布局', 'ops.json'), HER_LAYOUT, 'utf8')
  mkdirSync(prefsDir, { recursive: true })
  writeFileSync(join(prefsDir, 'rules.json'), HER_RULES, 'utf8')
  // 让 files 格先「画好过一版」(坏版回退时才有上一版可端)
  await fetch(`${rig.url}/user-layer/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'files', rev: revOf(HER_WIDGET), ok: true }) })
  rig.server.tick()
  const snapshot = {
    collector: readFileSync(join(layerDir, '采集器', '店铺.json'), 'utf8'),
    prefs: readFileSync(join(prefsDir, 'rules.json'), 'utf8'),
    widget: readFileSync(join(widgetDir, 'index.js'), 'utf8'),
    layout: readFileSync(join(layerDir, '布局', 'ops.json'), 'utf8'),
  }

  /* ── ③ 走真实更新路:本地清单 + 真 check()/apply() ─────────────────────── */
  const srvRoot = mkdtempSync(join(tmpdir(), 'wb-upgrade-srv-'))
  const { origin, close } = await serveDir(srvRoot)
  const pkgN = packPlugin(box, N_VERSION, `插件 ${N_VERSION}`)
  const updatesDir = join(srvRoot, 'updates', N_VERSION)
  mkdirSync(updatesDir, { recursive: true })
  execFileSync('cp', [pkgN, join(updatesDir, 'plugin.tgz')])
  const manifest = {
    version: N_VERSION, released_at: '2026-10-27T08:00:00Z', notes: '升级保全验收。',
    assets: { plugin_tgz: { url: `${origin}/updates/${N_VERSION}/plugin.tgz`, sha256: sha256File(pkgN), size: statSync(pkgN).size } },
  }
  writeFileSync(join(srvRoot, 'updates', 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const update = createUpdateService({
    io, paths, now: () => Date.now(), newId: () => randomUUID(),
    currentVersion: n1.version,
    manifestUrl: `${origin}/updates/latest.json`,
    checkIntervalMs: 0,
    applyTuning: { subPollMs: 0, restartDelayMs: 0 },
  })
  const checked = await update.check()
  check('更新路 · check():清单真的经 http 取回并判出新版', checked.available === true && checked.latest === N_VERSION, `latest=${checked.latest}`)
  const started = update.apply()
  if ('error' in started) throw new Error(`apply 没起来:${started.error}`)
  await update.waitJob(started.id)
  const job = update.job(started.id)
  check('更新路 · apply() 作业跑完', job !== undefined && 'error' in job === false && (job as { state?: string }).state === 'done', `job=${JSON.stringify(job)}`)
  // 更新那条路的包名取下载件的名字(plugin.tgz,见 install.ts 的 tarball = prebuilt.split('/').pop())
  const nPlaced = join(paths.packagesDir, 'plugin.tgz')
  check('更新路 · N 真的换上进隔离 profile(逐字节)', existsSync(nPlaced) && sha256File(nPlaced) === sha256File(pkgN), 'install.ts 的 plugin 步把 N 拷进 ~/.dsh/packages/plugin.tgz,sha256 与清单/原件一致')
  check('更新路 · 装进 profile 的命令指向这份 N(假法拦下,argv 是真的)', faked.some(cmd => cmd.join(' ').endsWith('plugin --profile web add ' + nPlaced)), '`dsh plugin add` 在隔离环境无运行时,与 update-e2e 同款假法;包落盘如上一条真验')

  /* ── ④ 起服务(N 代码 = 重启后),四样逐字对照 + 加载口真装上 ────────────── */
  await rig.server.close()
  await sleep(300)
  rig = await bootServer()
  rig.server.tick()
  const state = await (await fetch(`${rig.url}/state`)).json() as {
    user_layer?: { widgets?: { id: string, status?: string, rev?: string }[], layouts?: { id: string, name?: string, status?: string }[] }
    collectors?: { items?: { name?: string }[] }
  }
  const same = (a: string, b: string): boolean => a === b
  check('升级后 · 采集器定制逐字不变', same(readFileSync(join(layerDir, '采集器', '店铺.json'), 'utf8'), snapshot.collector), '用户层/采集器/店铺.json 与升级前逐字一致')
  check('升级后 · 偏好定制逐字不变', same(readFileSync(join(prefsDir, 'rules.json'), 'utf8'), snapshot.prefs), '用户层/偏好/rules.json 逐字一致')
  check('升级后 · 小组件定制逐字不变', same(readFileSync(join(widgetDir, 'index.js'), 'utf8'), snapshot.widget), '用户层/小组件/files/index.js 逐字一致')
  check('升级后 · 布局定制逐字不变', same(readFileSync(join(layerDir, '布局', 'ops.json'), 'utf8'), snapshot.layout), '用户层/布局/ops.json 逐字一致')
  const widget = state.user_layer?.widgets?.find(one => one.id === 'files')
  check('升级后 · 小组件被加载口真装上(/state)', widget?.status === 'ok' && widget.rev === revOf(HER_WIDGET), `/state files ok,rev=她的定制版指纹 ${revOf(HER_WIDGET).slice(0, 12)}`)
  check('升级后 · 布局被加载口真装上(/state)', state.user_layer?.layouts?.some(one => one.id === 'ops' && one.status === 'ok' && one.name === '她的运营布局'), '/state layouts 里 ops ok、名字是她的')
  const collectorsState = await (await fetch(`${rig.url}/collector`)).json() as { items?: { name?: string }[] }
  check('升级后 · 采集器被真服务读到(/collector)', collectorsState.items?.some(one => one.name === '店铺'), 'GET /collector 里有「店铺」')

  /* ── ⑤ 删掉布局 → ensure(再次重启)不复生 ─────────────────────────────── */
  rmSync(join(layerDir, '布局', 'ops.json'))
  await rig.server.close()
  await sleep(300)
  rig = await bootServer()
  check('删后不复生:她删的布局升级/重启不再长回来', !existsSync(join(layerDir, '布局', 'ops.json')), 'ops.json 删掉后再 ensure,目录里依旧没有它')

  /* ── ⑥ 小组件改坏 → 真报坏 → 端回上一版;跨重启仍端上一版 ─────────────── */
  writeFileSync(join(widgetDir, 'index.js'), BAD_WIDGET, 'utf8')
  rig.server.tick()
  const badRev = revOf(BAD_WIDGET)
  await fetch(`${rig.url}/user-layer/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'files', rev: badRev, ok: false, problem: '画这一格时出错:故意写坏的' }) })
  rig.server.tick()
  const broken = await (await fetch(`${rig.url}/state`)).json() as { user_layer?: { widgets?: { id: string, status?: string, rolled_back?: string, problem?: string }[] } }
  const brokenWidget = broken.user_layer?.widgets?.find(one => one.id === 'files')
  // 上一版画好过的路径:status 仍是 ok,rolled_back 写那句原因(与 heal-http 同口径)
  check('坏了回上一版:坏版报上来后 /state 端回上一版并说一句', brokenWidget?.rolled_back === '画这一格时出错:故意写坏的',
    `rolled_back=${brokenWidget?.rolled_back ?? '(没有)'},/state 里她看得见`)
  const codeRes = await fetch(`${rig.url}/user-layer/widgets/files/code`)
  const served = await codeRes.text()
  check('坏了回上一版:端的是上一版(她的定制),不是坏文件', served.includes('她的素材管理 定制版') && !served.includes('故意写坏的'), 'GET /user-layer/widgets/files 返回上一版代码')
  await rig.server.close()
  await sleep(300)
  rig = await bootServer()
  const afterRestart = await (await fetch(`${rig.url}/state`)).json() as { user_layer?: { widgets?: { id: string, status?: string, rolled_back?: string }[] } }
  check('坏了回上一版:跨重启仍端上一版(坏版表落盘)', afterRestart.user_layer?.widgets?.find(one => one.id === 'files')?.rolled_back !== undefined, '服务重启后 files 仍 rolled_back')

  /* ── ⑦ 偏好改坏 → 服务照起,退回缺省不炸 ──────────────────────────────── */
  writeFileSync(join(prefsDir, 'rules.json'), '{ 这不是 json', 'utf8')
  await rig.server.close()
  await sleep(300)
  rig = await bootServer()
  const rulesRes = await fetch(`${rig.url}/state`)
  check('偏好坏文件不炸:服务照起、/state 正常', rulesRes.ok, 'rules.json 读坏 → 退回缺省,工作台照常起')

  await rig.server.close()
  await close()
  const failed = results.filter(one => !one.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 项过`)
  console.log(`(隔离目录留着供抽查:${box};确认后手动删)`)
  if (failed.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
