/**
 * 用户层自愈 · 真实浏览器验收驱动(2026-10-23,卡「分层自愈完善」补验收,不再留维护者手点)。
 *
 *   node dev/user-layer-run/heal-check.ts
 *
 * 起三样真东西,全是自己的、临时的:
 *   1. 真 `WorkbenchServer`(port 3393,tmp 用户层 + 假本体目录,走真扫描 / 真路由 / 真 tick);
 *   2. 真 vite 页(port 9193,dev/user-layer-run/heal.html)——挂的是真 `UserLayerPanel` 与真
 *      `UserLayerCell` + `useUserLayerSync`(页面装小组件那条 React 路),`/wb` 代理到 3393;
 *   3. 本机 chromium headless shell(CDP 9333)真开那一页,在里面点「选回这一版」「派去改」,
 *      并读写 tmp 用户层的文件,核四件事:
 *        ① 选回历史版本(UI 点击 → 真 API → 格子换上旧版)
 *        ② 坏版跨重启不重报(页面真报一次坏 → 服务重启 → 上报数不增、仍端上一版)
 *        ③ 改好自动恢复(文件改好 → 下一拍格子换上新版)
 *        ④ 越界拒装与原有 dirty 保全(派去改 → 那家改本体+用户层+新建格 → 交回 → tick 拒装:
 *           窗口内变过的一切原样保留、分清是谁改的不行就记阻塞,那一格先不端(/state 端回上一版),
 *           证据与派活前备份长留在 .修复/<itemId>/,本体一份不回写;卡上说一句)
 *
 * 不碰 ~/.dsh / 8791 / 个人账号;不复刻组件逻辑(页面挂的全是真组件);跑完自删临时目录。
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkbenchServer } from '../../src/server/http.ts'
import { startWorkbenchServer } from '../../src/server/http.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { createTasksService, type TasksService } from '../../src/server/tasks.ts'
import { createUserLayerService, type UserLayerService } from '../../src/server/userLayer.ts'
import { engineHarness } from '../../tests/helpers/engineHarness.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..', '..')
const WB_PORT = 3393
const VITE_PORT = 9193
const CDP_PORT = 9333

/**
 * 浏览器可移植解析(2026-10-27 Root 验收退修:原来写死 ms-playwright 缓存里的
 * chromium_headless_shell-1223,缓存一换/一清就跑不了)。顺序:
 *   1. 环境变量 HEAL_CHECK_BROWSER 显式覆盖(指向本机任意 Chromium/Chrome 可执行文件);
 *   2. ms-playwright 缓存里现成的那一份(headless shell 或 Chromium,有什么用什么,**不下载**);
 *   3. 已安装的 Google Chrome(`/Applications/...`,明确**不下载、不安装**)。
 * 真 Chrome 启动加 `--headless=new`;headless shell 本身就是无头。
 */
function resolveBrowserBin(): { bin: string, isHeadlessShell: boolean } {
  const override = process.env.HEAL_CHECK_BROWSER?.trim()
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) throw new Error(`HEAL_CHECK_BROWSER 指向的浏览器不存在:${override}`)
    return { bin: override, isHeadlessShell: false }
  }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache).sort()) {
      const shell = join(cache, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
      if (existsSync(shell)) return { bin: shell, isHeadlessShell: true }
      for (const sub of ['chrome-mac', 'chrome-mac-arm64']) {
        const chromium = join(cache, entry, sub, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
        if (existsSync(chromium)) return { bin: chromium, isHeadlessShell: false }
      }
    }
  }
  const installed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  ].find(path => existsSync(path))
  if (installed !== undefined) return { bin: installed, isHeadlessShell: false }
  throw new Error('找不到可用的浏览器:设 HEAL_CHECK_BROWSER 指向本机 Chrome/Chromium(不下载、不安装)')
}

function chromeArgs(profileDir: string, isHeadlessShell: boolean): string[] {
  return [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--disable-extensions', '--mute-audio',
    ...(isHeadlessShell ? [] : ['--headless=new']),
    'about:blank',
  ]
}

/** 固定端口预检(Root 退修要求):先探后启,被占就退出,绝不去杀别人的服务。 */
async function assertPortFree(port: number): Promise<void> {
  const probe = await new Promise<boolean>((ok) => {
    const socket = createConnection({ host: '127.0.0.1', port, timeout: 800 })
    socket.once('connect', () => { socket.destroy(); ok(true) })
    socket.once('timeout', () => { socket.destroy(); ok(false) })
    socket.once('error', () => { socket.destroy(); ok(false) })
  })
  if (probe) throw new Error(`端口 ${port} 已被占用:先确认那不是别人的服务,本次不启动、不抢占`)
}

const sleep = (ms: number) => new Promise((ok) => { setTimeout(ok, ms) })

const home = mkdtempSync(join(tmpdir(), 'wb-heal-browser-'))
const layerDir = join(home, '用户层')
const bodyDir = join(home, '本体')
const widgetDir = join(layerDir, '小组件', 'files')
const MANIFEST = { contract: 1, id: 'files', name: '素材管理', replaces: 'files', export: 'FilesModule' }
const CODE_V1 = 'module.exports = { FilesModule: function FilesModule() { return "她的素材管理 v1" } }'
const CODE_V2 = 'module.exports = { FilesModule: function FilesModule() { return "她的素材管理 v2" } }'
const CODE_BAD = 'function ( 这一版是故意写坏的'
const CODE_V4 = 'module.exports = { FilesModule: function FilesModule() { return "她的素材管理 v4" } }'

const results: { name: string, ok: boolean, detail: string }[] = []
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

mkdirSync(join(bodyDir, 'lib'), { recursive: true })
writeFileSync(join(bodyDir, 'lib', 'index.js'), '本体代码 v1', 'utf8')
mkdirSync(widgetDir, { recursive: true })
writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify(MANIFEST), 'utf8')
writeFileSync(join(widgetDir, 'index.js'), CODE_V1, 'utf8')

/* ── 真服务(可重启:同一份目录,新进程内的新服务实例 = 真机重启)────────────────── */
let taskSeq = 0
async function startServer(): Promise<{ server: WorkbenchServer, userLayer: UserLayerService, tasks: TasksService }> {
  const userLayer = createUserLayerService({ dir: layerDir, bodyDir, runCommand: async () => ({ ok: false, stdout: '' }) })
  await userLayer.ensure()
  const engineRig = engineHarness({ connected: () => false })
  const tasks = createTasksService({ file: join(home, `tasks-${Date.now()}-${taskSeq++}.json`), newId: () => `t-${Date.now()}-${taskSeq}` })
  const server = await startWorkbenchServer({
    engine: engineRig.engine,
    engineRegistry: engineRig.registry,
    port: WB_PORT,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    userLayer,
    appInstalled: () => true,
    dispatchRun: {
      runCli: () => ({ pid: 4321, exited: new Promise<{ code: number | null }>(() => {}) }),
      resolveCli: family => ({ found: true, family, bin: `/fake/${family}`, source: 'bundled' }),
      resultDir: home,
    },
  })
  return { server, userLayer, tasks }
}

/* ── CDP 小驱动(照 dev/collab-board/verify-three-fixes.mjs 的写法)────────────── */
function cdp(wsUrl: string): { send: (method: string, params?: Record<string, unknown>) => Promise<unknown>, close: () => void, onConsole: (fn: (text: string) => void) => void } {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map<number, { ok: (value: unknown) => void, bad: (error: Error) => void }>()
  const consoleListeners: ((text: string) => void)[] = []
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number, method?: string, params?: { args?: { value?: unknown, description?: string }[] } }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { ok, bad } = pending.get(msg.id)!
      pending.delete(msg.id)
      const result = (msg as { result?: unknown, error?: { message?: string } }).result
      const error = (msg as { error?: { message?: string } }).error
      if (error !== undefined) bad(new Error(error.message ?? 'CDP error'))
      else ok(result)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params?.args ?? []).map(one => String(one.value ?? one.description ?? '')).join(' ')
      for (const fn of consoleListeners) fn(text)
    }
  }
  const ready = new Promise<void>((ok, bad) => {
    ws.onopen = () => { ok() }
    ws.onerror = () => { bad(new Error('CDP 连不上')) }
  })
  const send = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    await ready
    const id = ++seq
    return new Promise((ok, bad) => {
      pending.set(id, { ok: ok as (value: unknown) => void, bad })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  return { send, close: () => { try { ws.close() } catch { /* 关了就关了 */ } }, onConsole: fn => { consoleListeners.push(fn) } }
}

type Driver = ReturnType<typeof cdp>
async function evaluate(driver: Driver, expression: string): Promise<unknown> {
  const result = await driver.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as { result?: { value?: unknown }, exceptionDetails?: { text?: string } }
  if (result.exceptionDetails !== undefined) throw new Error(`页面里抛错:${result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails)}`)
  return result.result?.value
}

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { if (await fn()) return } catch { /* 下一轮 */ }
    if (Date.now() > deadline) throw new Error(`等超时:${label}`)
    await sleep(250)
  }
}

async function pageText(driver: Driver, selector: string): Promise<string> {
  return String(await evaluate(driver, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? '' : el.textContent ?? '' })()`))
}

async function stateWidget(): Promise<{ rev?: string, status?: string, rolled_back?: string, problem?: string }> {
  const res = await fetch(`http://127.0.0.1:${WB_PORT}/state`)
  const state = await res.json() as { user_layer?: { widgets: { id: string, rev?: string, status?: string, rolled_back?: string, problem?: string }[] } }
  const widget = state.user_layer?.widgets.find(one => one.id === 'files')
  if (widget === undefined) throw new Error('/state 里没有 files')
  return widget
}

async function badReportsFor(rev: string): Promise<number> {
  const reports = await evaluate(DRIVER_GLOBAL.driver, `window.__reports.filter(one => one.ok === false && one.rev === ${JSON.stringify(rev)}).length`) as number
  return reports
}

/* DRIVER_GLOBAL 让辅助函数够得着当前 driver */
const DRIVER_GLOBAL: { driver: Driver } = { driver: undefined as unknown as Driver }

async function main(): Promise<void> {
  console.log(`临时目录:${home}`)
  /* ── 固定端口先探后启:被占就退出,绝不杀别人的服务(要在自家服务起来之前探)── */
  for (const port of [WB_PORT, VITE_PORT, CDP_PORT]) await assertPortFree(port)
  let rig = await startServer()
  let cleaned = false
  const chromeProfile = mkdtempSync(join(tmpdir(), 'wb-heal-chrome-'))
  let chromeProc: ReturnType<typeof spawn> | null = null
  let viteProc: ReturnType<typeof spawn> | null = null

  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    try { chromeProc?.kill('SIGKILL') } catch { /* 尽力 */ }
    try { if (viteProc?.pid !== undefined) process.kill(-viteProc.pid, 'SIGKILL') } catch { try { viteProc?.kill('SIGKILL') } catch { /* 尽力 */ } }
    void rig.server.close().catch(() => undefined)
    // chrome 死透要一拍,profile 目录删不干净就等 300ms 再来,绝不让清理盖掉真错误(同步等,信号处理器里也安全)
    const syncSleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
    for (let attempt = 0; attempt < 4; attempt++) {
      try { rmSync(chromeProfile, { recursive: true, force: true }) }
      catch { /* 下一轮 */ }
      try { rmSync(home, { recursive: true, force: true }) }
      catch { /* 下一轮 */ }
      if (!existsSync(chromeProfile) && !existsSync(home)) break
      syncSleep(300)
    }
  }
  process.on('SIGINT', () => { cleanup(); process.exit(1) })
  process.on('SIGTERM', () => { cleanup(); process.exit(1) })

  try {
    /* ── vite 真页 ─────────────────────────────────────────────── */
    viteProc = spawn(join(pluginDir, 'node_modules', '.bin', 'vite'), ['--config', join(here, 'vite.config.mjs')], {
      cwd: pluginDir,
      env: { ...process.env, PORT: String(VITE_PORT), WB_PORT: String(WB_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    viteProc.stderr!.on('data', chunk => { console.error(`[vite] ${String(chunk).trim()}`) })
    await waitFor('vite 起好', async () => { try { return (await fetch(`http://127.0.0.1:${VITE_PORT}/heal.html`)).ok } catch { return false } }, 20_000)

    /* ── chromium / 已装 Chrome(可移植解析,不下载不安装)────────── */
    const browser = resolveBrowserBin()
    console.log(`浏览器:${browser.bin}${browser.isHeadlessShell ? '(headless shell)' : '(--headless=new)'}`)
    chromeProc = spawn(browser.bin, chromeArgs(chromeProfile, browser.isHeadlessShell), { stdio: ['ignore', 'pipe', 'pipe'] })
    chromeProc.stderr!.on('data', () => { /* headless shell 的噪音不往上冒 */ })
    let target: { webSocketDebuggerUrl: string } | undefined
    await waitFor('chrome CDP 起好', async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json() as { type: string, webSocketDebuggerUrl: string }[]
        target = list.find(one => one.type === 'page')
        return target !== undefined
      }
      catch { return false }
    }, 20_000)
    const driver = cdp(target!.webSocketDebuggerUrl)
    DRIVER_GLOBAL.driver = driver
    driver.onConsole(text => { console.log(`[page] ${text}`) })
    await driver.send('Runtime.enable')
    await driver.send('Page.enable')
    await driver.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/heal.html` })
    await waitFor('真设置节渲染出来', async () => (await pageText(driver, 'section.ben-wb__ss')).includes('用户层'))

    /* ── 0) 真接线:格子自动装上 v1,页面真上报 ok ────────────────── */
    await waitFor('格子装上 v1', async () => (await pageText(driver, '[data-cell]')).includes('她的素材管理 v1'))
    await waitFor('页面真上报 ok', async () => {
      const count = await evaluate(driver, 'window.__reports.filter(one => one.ok === true).length') as number
      return count >= 1
    })
    check('真实浏览器装上小组件并真上报', true, 'UserLayerCell 真组件渲染「她的素材管理 v1」,/user-layer/report 收到 ok')

    /* ── ① 选回历史版本(UI 点击 → 真 API)──────────────────────── */
    writeFileSync(join(widgetDir, 'index.js'), CODE_V2, 'utf8')
    await waitFor('/state 换成 v2', async () => (await stateWidget()).rev !== undefined && (await stateWidget()).rev !== revOf(CODE_V1))
    await waitFor('v2 上报 ok', async () => {
      const rev2 = (await stateWidget()).rev ?? ''
      return (await evaluate(driver, `window.__reports.filter(one => one.ok === true && one.rev === ${JSON.stringify(rev2)}).length`) as number) >= 1
    })
    await driver.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/heal.html` })
    await waitFor('重载后设置节出来', async () => (await pageText(driver, 'section.ben-wb__ss')).includes('用户层'))
    await waitFor('「画好过 2 版」出来', async () => (await pageText(driver, 'section.ben-wb__ss')).includes('画好过 2 版'))
    await evaluate(driver, `[...document.querySelectorAll('summary')].find(one => one.textContent?.includes('画好过 2 版'))?.click()`)
    const rev1 = revOf(CODE_V1)
    await waitFor('两行历史出来', async () => (await pageText(driver, '[data-history]')).includes(rev1))
    await evaluate(driver, `document.querySelector('[data-history-rev="${rev1}"]')?.querySelector('button')?.click()`)
    await waitFor('选回上屏', async () => (await pageText(driver, 'section.ben-wb__ss')).includes('已选回那一版'))
    const afterRestore = await stateWidget()
    check('选回历史版本', afterRestore.rev === rev1, `点「选回这一版」→ /state rev=${afterRestore.rev?.slice(0, 12) ?? '无'},期望 v1 的 ${rev1.slice(0, 12)}`)
    await waitFor('格子换回 v1', async () => (await pageText(driver, '[data-cell]')).includes('她的素材管理 v1'))

    /* ── ② 坏版跨重启不重报 ────────────────────────────────────── */
    writeFileSync(join(widgetDir, 'index.js'), CODE_BAD, 'utf8')
    const badRev = revOf(CODE_BAD)
    await waitFor('坏版报上来', async () => (await badReportsFor(badRev)) >= 1)
    // 面板只在挂载时拉一次清单:按它自己的真刷新键重拉,再看「在用上一版」
    await evaluate(driver, `[...document.querySelectorAll('button')].find(one => one.textContent === '重新看一遍')?.click()`)
    await waitFor('设置节说在用上一版', async () => (await pageText(driver, 'section.ben-wb__ss')).includes('在用上一版'))
    const countBeforeRestart = await badReportsFor(badRev)
    // 真机重启:同一个目录,全新服务实例(坏版本小表从盘上读回来)
    await rig.server.close()
    await sleep(400)
    rig = await startServer()
    await waitFor('重启后 /state 恢复', async () => { try { await stateWidget(); return true } catch { return false } })
    await sleep(2_500) // 好几拍:页面要真重试早就重试了
    const countAfterRestart = await badReportsFor(badRev)
    const afterRestart = await stateWidget()
    check('坏版跨重启不重报', countAfterRestart === countBeforeRestart && countAfterRestart >= 1,
      `同一指纹 bad 上报 ${countBeforeRestart} → 重启后 ${countAfterRestart};/state 仍 ${afterRestart.rolled_back === undefined ? '端上一版' : 'broken'}`)
    check('坏版跨重启仍端上一版(页面不换)', (await pageText(driver, 'section.ben-wb__ss')).includes('在用上一版'), '设置节重载后仍写「在用上一版」')

    /* ── ③ 改好自动恢复 ────────────────────────────────────────── */
    writeFileSync(join(widgetDir, 'index.js'), CODE_V4, 'utf8')
    await waitFor('格子换上 v4', async () => (await pageText(driver, '[data-cell]')).includes('她的素材管理 v4'))
    const afterFix = await stateWidget()
    check('改好自动恢复', afterFix.status === 'ok' && afterFix.rolled_back === undefined, '文件改好 → 下一拍 ok,格子渲染「她的素材管理 v4」')

    /* ── ④ 越界拒装 + 原有 dirty 保全(真 UI 派活)───────────────── */
    writeFileSync(join(layerDir, '说明.md'), '她刚写的备注:这一格别看颜色,看数字。', 'utf8') // 派活之前她自己的改动
    await driver.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/heal.html` })
    await waitFor('重载后设置节出来', async () => (await pageText(driver, 'section.ben-wb__ss')).includes('用户层'))
    await waitFor('格子又装上 v4', async () => (await pageText(driver, '[data-cell]')).includes('她的素材管理 v4'))
    await evaluate(driver, `(() => {
      const input = document.querySelector('input[aria-label="想改用户层里的什么"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '素材管理标题大一点')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await evaluate(driver, `[...document.querySelectorAll('button')].find(one => one.textContent === '派去改')?.click()`)
    await waitFor('派活回执上屏', async () => (await pageText(driver, 'section.ben-wb__ss')).includes('交给') && (await pageText(driver, 'section.ben-wb__ss')).includes('只改用户层目录'))
    let itemId = ''
    await waitFor('守门记账', async () => {
      const pending = await rig.userLayer.pendingFixGuards()
      itemId = pending[0] ?? ''
      return pending.length === 1
    })
    check('真 UI 派出去改并记账', itemId !== '', `面板表单 POST /user-layer/fix,守门待核=${itemId}`)
    // 派出去的那一家:改本体、改用户层、还新建了一格(也可能都是她自己在窗口内动的 —— 分不清)
    writeFileSync(join(bodyDir, 'lib', 'index.js'), '本体代码 被改', 'utf8')
    writeFileSync(join(widgetDir, 'index.js'), 'module.exports = { FilesModule: function FilesModule() { return "窗口内变的" } }', 'utf8')
    mkdirSync(join(layerDir, '小组件', 'evil'), { recursive: true })
    writeFileSync(join(layerDir, '小组件', 'evil', 'widget.json'), JSON.stringify({ ...MANIFEST, id: 'evil', replaces: 'todo' }), 'utf8')
    writeFileSync(join(layerDir, '小组件', 'evil', 'index.js'), 'module.exports = { FilesModule: function FilesModule() { return 1 } }', 'utf8')
    // 交回(命令行那只手结束)——真 dispatchRun 那一拍的等价物
    await rig.tasks.update(itemId, { dispatch: { family: 'codex', status: 'done', hand: 'cli', cwd: layerDir, started_at: new Date().toISOString(), ended_at: new Date().toISOString() } })
    rig.server.tick()
    await waitFor('守门核完', async () => (await rig.userLayer.pendingFixGuards()).length === 0)
    const filesNow = readFileSync(join(widgetDir, 'index.js'), 'utf8')
    const readmeNow = readFileSync(join(layerDir, '说明.md'), 'utf8')
    const bodyNow = readFileSync(join(bodyDir, 'lib', 'index.js'), 'utf8')
    const recordKept = existsSync(join(layerDir, '.修复', itemId, 'record.json'))
    const backupKept = existsSync(join(layerDir, '.修复', itemId, '之前', '小组件', 'files', 'index.js'))
    const evilKept = existsSync(join(layerDir, '小组件', 'evil', 'index.js'))
    const heldBack = (await stateWidget()).rolled_back
    const card = (await rig.tasks.list()).tasks.find(one => one.id === itemId)
    // 安全语义(独立审后退修):窗口内变过的一切原样保留,分清是谁改的不行就记阻塞 + 那一格先不端
    check('越界拒装:窗口内变过的文件原样保留(不回退)', filesNow.includes('窗口内变的'), `files/index.js 保留窗口内的样子,不被派活前的备份覆盖`)
    check('原有 dirty 一份不丢', readmeNow.includes('她刚写的备注'), `派活前她写的 说明.md 原样:${readmeNow.slice(0, 12)}…`)
    check('越界拒装:新建格子也保留原样(不挪走唯一副本)', evilKept, `小组件/evil 还在原处;证据是记录与派活前备份,不是挪文件`)
    check('越界拒装:那一格先不端(/state 端回上一版)', heldBack !== undefined && heldBack.includes('先不装'), `rolled_back=${heldBack ?? '(没有)'}`)
    check('越界拒装:证据与派活前备份长留', recordKept && backupKept, `.修复/${itemId}/ 里 record.json 与 之前/ 都在`)
    check('本体一份文件都不由守门回写', bodyNow === '本体代码 被改', '假本体 lib/index.js 保持「被改」的样子,证据里记了它')
    check('卡上说一句', card?.note !== undefined && card.note.includes('本体') && card.note.includes('保留'), `note=${card?.note ?? '(没有)'}`)

    /* ── ⑤ 残留 Minor 角落(真 UI + 真 API):坏版 + 换入口名 + 选回旧版,在制原件一份不丢 ── */
    writeFileSync(join(widgetDir, 'index.js'), CODE_V4, 'utf8')
    writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify(MANIFEST), 'utf8')
    await driver.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/heal.html` })
    await waitFor('重载后格子又正常', async () => (await pageText(driver, '[data-cell]')).includes('她的素材管理 v4'))
    // 她在改的新版跑不起来;这个坏组合 ② 里已经报过(服务端坏版表在),/state 直接端回上一版
    writeFileSync(join(widgetDir, 'index.js'), CODE_BAD, 'utf8')
    await waitFor('坏版被端回上一版(⑤)', async () => (await stateWidget()).rolled_back !== undefined)
    await evaluate(driver, `[...document.querySelectorAll('button')].find(one => one.textContent === '重新看一遍')?.click()`)
    await waitFor('设置节说在用上一版(⑤)', async () => (await pageText(driver, 'section.ben-wb__ss')).includes('在用上一版'))
    // 她把入口改名叫 c.js —— 内容一个码没动,坏版键(入口内容@样式)不变,这一版仍是坏版、没有快照
    writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify({ ...MANIFEST, entry: 'c.js' }), 'utf8')
    renameSync(join(widgetDir, 'index.js'), join(widgetDir, 'c.js'))
    // 选回入口名不同的 v1(真 UI 点「选回这一版」)
    await driver.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/heal.html` })
    await waitFor('重载后设置节出来(⑤)', async () => (await pageText(driver, 'section.ben-wb__ss')).includes('用户层'))
    await evaluate(driver, `[...document.querySelectorAll('summary')].find(one => one.textContent?.includes('画好过'))?.click()`)
    await evaluate(driver, `document.querySelector('[data-history-rev="${revOf(CODE_V1)}"]')?.querySelector('button')?.click()`)
    await waitFor('选回上屏(⑤)', async () => (await pageText(driver, 'section.ben-wb__ss')).includes('已选回那一版'))
    const kept = readFileSync(join(widgetDir, 'c.js'), 'utf8')
    const backToV1 = await stateWidget()
    check('坏版换入口名选回:她的在制原件(c.js)一份不丢', kept === CODE_BAD, `c.js 原样保留(没有快照也不删),内容=${kept.slice(0, 14)}…`)
    check('坏版换入口名选回:格子真换回 v1(真 API)', backToV1.rev === revOf(CODE_V1), `/state rev=${backToV1.rev?.slice(0, 12) ?? '无'},期望 v1 的 ${revOf(CODE_V1).slice(0, 12)}`)
    await waitFor('格子换回 v1(⑤)', async () => (await pageText(driver, '[data-cell]')).includes('她的素材管理 v1'))
  }
  finally {
    cleanup()
  }

  const failed = results.filter(one => !one.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 项过`)
  if (failed.length > 0) process.exit(1)
}

function revOf(code: string): string {
  // 与服务端同口径:sha256 前 12 位
  return createHash('sha256').update(code).digest('hex').slice(0, 12)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
