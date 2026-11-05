/**
 * 真实 React 生产树 + 真服务的图谱/架构图浏览器验收(2026-10-23,卡「图谱显示修复与Archify接入」)。
 *
 * 与旧版(手搭静态 fixture + 自写拖拽)的本质区别 —— 本脚本**不复刻任何产品行为**:
 * - 组件树是真的:用户层 files 小组件真文件(user-layer/起步/小组件/files/index.js)经本体
 *   加载口 evaluateWidget 求值,嵌的是 shipped FilesModule / GraphView / ModuleBox / ModuleHeader;
 * - 手柄是真的:ModuleBox 底边那把,Δpx→Δpct 换算走真 resizeModule(见 tests/harness/入口);
 * - 服务端是真的:startWorkbenchServer(http.ts)真路由,graphify / archify 真服务;
 * - 「由 Agent 生成」是真的:服务端 spawn 本机已授权 kimi CLI 只读 DouDou 源码产规格,
 *   官方离线 archify CLI 校验后原子落地;
 * - Agent 读规格是真的:kimi CLI 自己 curl /archify/spec 端点回答,脚本再回源码核验。
 *
 * 环境边界:隔离 HOME(mkdtemp),图谱数据从维护者 ~/.dsh 只读拷贝;不写维护者 HOME、
 * 不停 8791、不占 3193/3393/3593;自有端口 3493(真服务)/9291(页面+代理)。
 *
 * 用法:node tests/real-browser-graph-drag.mjs   (真实 Agent 阶段可能要几分钟)
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pluginDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(pluginDir, '..')
const EVIDENCE_DIR = path.join(repoRoot, 'docs', '验收-图谱显示与Archify-2026-10-26')
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

const REAL_SERVER_PORT = 3493
const PAGE_PORT = 9291
const HEAD_COMMIT = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim()

// Playwright 解析顺序:环境变量 PLAYWRIGHT_PATH → 本机 codex runtime 既有路径(不装新依赖)
const PLAYWRIGHT_CANDIDATES = [
  process.env.PLAYWRIGHT_PATH,
  '/Users/example/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js',
].filter(Boolean)
const playwrightEntry = PLAYWRIGHT_CANDIDATES.find((candidate) => fs.existsSync(candidate))
if (playwrightEntry === undefined) {
  throw new Error(`找不到 Playwright 入口;请用 PLAYWRIGHT_PATH 环境变量指定(候选:${PLAYWRIGHT_CANDIDATES.join(', ')})`)
}
const pw = (await import(playwrightEntry)).default
const { chromium } = pw

/** 真服务与页面要用的真实项目登记(读用户项目源码只读;graphify 大图数据从缓存拷) */
const PROJECTS = [
  { id: 'desktop-workbench', name: '工作台', stage: '在用', path: '/Users/example/Documents/GitHub/desktop-workbench', links: [], session_count: 0, idle: true },
  { id: 'doudou', name: 'DouDou', stage: '在用', path: '/Users/example/Documents/GitHub/DouDou', links: [], session_count: 0, idle: true },
]

function assertFree(port) {
  return new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.once('error', (err) => reject(new Error(`端口 ${port} 不可用:${err.message}`)))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
  })
}

function log(stage, msg) {
  console.log(`[真React][${stage}] ${msg}`)
}

async function main() {
  await assertFree(REAL_SERVER_PORT)
  await assertFree(PAGE_PORT)

  // ── 1. 隔离 HOME:graphify 产物从维护者缓存只读拷入(大图 41606 节点真数据) ──
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-real-react-home-'))
  const graphifyDir = path.join(tempHome, '.dsh', 'workbench', 'graphify')
  fs.mkdirSync(graphifyDir, { recursive: true })
  for (const proj of ['desktop-workbench', 'doudou']) {
    fs.cpSync(path.join(os.homedir(), '.dsh', 'workbench', 'graphify', proj), path.join(graphifyDir, proj), { recursive: true })
  }
  // 大图页模板若在本卡内升过级,缓存里的 graph.html 就是旧模板 —— 用真 PIPELINE_PY 的
  // write_large_html 对真布局数据重放一次(与下次「重建图谱」产物同码路),否则验的是旧页面。
  {
    const pluginSrc = fs.readFileSync(path.join(pluginDir, 'src', 'server', 'graphify.ts'), 'utf8')
    const pyMatch = pluginSrc.match(/const PIPELINE_PY = `([\s\S]*?)`\n\nexport interface/)
    if (!pyMatch) throw new Error('从 graphify.ts 抽 PIPELINE_PY 失败')
    const pyBody = pyMatch[1]
    const dwbDir = path.join(graphifyDir, 'desktop-workbench')
    const writerPy = path.join(graphifyDir, '.replay-writer.py')
    fs.writeFileSync(writerPy, [
      'import json',
      'from pathlib import Path',
      pyBody.slice(pyBody.indexOf('LARGE_HTML ='), pyBody.indexOf('\nt0 = time.time()')),
      `layout = json.loads(Path(${JSON.stringify(path.join(dwbDir, 'graph-layout.json'))}).read_text())`,
      'members = {}',
      'for nid, c in layout["communities"].items():',
      '    members.setdefault(int(c), []).append(nid)',
      `write_large_html(None, members, Path(${JSON.stringify(dwbDir)}))`,
    ].join('\n'), 'utf8')
    const replay = spawnSync('python3', [writerPy], { encoding: 'utf8' })
    fs.rmSync(writerPy, { force: true })
    if (replay.status !== 0) throw new Error(`大图模板重放失败:\n${replay.stdout}\n${replay.stderr}`)
    log('setup', 'desktop-workbench 大图页已按当前 PIPELINE_PY 模板重放(旧缓存模板不验)')
  }
  log('setup', `隔离 HOME: ${tempHome}`)

  // ── 2. 打包真实 React harness 入口(tsdown,iife 单文件) ──
  const bundle = spawnSync(path.join(pluginDir, 'node_modules', '.bin', 'tsdown'), ['-c', 'tests/harness/tsdown.config.ts', '-l', 'warn'], {
    cwd: pluginDir, encoding: 'utf8',
  })
  if (bundle.status !== 0) throw new Error(`harness 打包失败:\n${bundle.stdout}\n${bundle.stderr}`)
  const bundleJs = fs.readFileSync(path.join(pluginDir, 'tests', 'harness', 'dist', 'workbench-harness-entry.iife.js'))

  // ── 3. 真服务:startWorkbenchServer 真路由 + graphify/archify 真服务 ──
  const { TOKENS_STYLE } = await import(pathToFile(pluginDir, 'src/client/tokens.ts'))
  const { STYLE } = await import(pathToFile(pluginDir, 'src/client/style.ts'))
  const { startWorkbenchServer } = await import(pathToFile(pluginDir, 'src/server/http.ts'))
  const { createWorkbenchService } = await import(pathToFile(pluginDir, 'src/server/service.ts'))
  const { createGraphifyService } = await import(pathToFile(pluginDir, 'src/server/graphify.ts'))
  const { createArchifyService } = await import(pathToFile(pluginDir, 'src/server/archify.ts'))

  const projectPaths = async () => PROJECTS.map(p => ({ id: p.id, path: p.path }))
  const graphify = createGraphifyService({
    dir: graphifyDir,
    projectPaths,
    vizUrl: () => 'off',
    uvBootstrapUrl: () => 'off',
  })
  const archify = createArchifyService({
    homeDir: tempHome,
    repoRoot,
    projectPaths,
    // 真实 Agent:本机已授权 kimi CLI(读 ~/.kimi 既有凭据,不走新账号)
  })
  const service = createWorkbenchService()
  const server = await startWorkbenchServer({
    port: REAL_SERVER_PORT,
    service,
    graphify,
    archify,
    tickIntervalMs: 0,
    heartbeatMs: 0,
  })
  log('server', `真服务 ${server.url}(startWorkbenchServer 真路由)`)

  // ── 4. 页面服务(9291):harness 页面 + /graphify/* /archify/* 透明代理到真服务 ──
  const widgetCode = fs.readFileSync(path.join(repoRoot, 'user-layer', '起步', '小组件', 'files', 'index.js'), 'utf8')
  const pageServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PAGE_PORT}`)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>真实React图谱验收</title>
<link rel="stylesheet" href="/styles.css">
<style>
  body{margin:0;background:#121216;font:12px/1.5 -apple-system,sans-serif;box-sizing:border-box;display:flex;flex-direction:column;padding:16px;gap:14px;overflow:auto}
  .shell{width:760px;flex:none;height:560px;border:1px solid #333;border-radius:8px;padding:10px;background:#181820;display:flex;flex-direction:column}
  #note{color:#888;font-size:11px;margin-top:2px;white-space:pre-wrap}
  /* .ben-wb 是本体全屏覆盖根(absolute inset 0);harness 里两颗实例要按流内排,只在页面层覆盖 */
  .shell .ben-wb{position:static!important;inset:auto!important;width:100%;height:100%}
</style></head><body>
<div class="shell" id="shell"><div id="workbench-root"></div></div>
<div class="shell" id="shell-builtin"><div id="workbench-root-builtin"></div></div>
<div id="note"></div>
<script src="/harness.js"></script>
<script>
  fetch('/widget-code').then(r => r.text()).then(code => {
    window.__wbHarness.mount(document.getElementById('workbench-root'), {
      widgetCode: code,
      baseUrl: 'http://127.0.0.1:${PAGE_PORT}',
      projects: ${JSON.stringify(PROJECTS)},
      currentProjectId: 'desktop-workbench',
      columnHeight: 536,
    })
    document.getElementById('note').textContent = 'A=用户层 files 小组件(真文件)嵌 shipped FilesModule;B=直出本体 FilesModule(Workbench 传真实 header 的兄弟路);真服务 3493 经本页代理。'
    // B:直出本体旧嵌套入口(同列高,常规高度)
    window.__wbHarness.mount(document.getElementById('workbench-root-builtin'), {
      variant: 'builtin',
      widgetCode: code,
      baseUrl: 'http://127.0.0.1:${PAGE_PORT}',
      projects: ${JSON.stringify(PROJECTS)},
      currentProjectId: 'desktop-workbench',
      columnHeight: 536,
    })
  })
</script></body></html>`)
      return
    }
    if (url.pathname === '/styles.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
      res.end(`${TOKENS_STYLE}\n${STYLE}`)
      return
    }
    if (url.pathname === '/harness.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(bundleJs)
      return
    }
    if (url.pathname === '/widget-code') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(widgetCode)
      return
    }
    if (url.pathname.startsWith('/graphify/') || url.pathname.startsWith('/archify/')) {
      // 透明代理:页面与 iframe 同 Origin,真请求打到真 http.ts 路由
      const upstream = http.request({ host: '127.0.0.1', port: REAL_SERVER_PORT, path: url.pathname + url.search, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${REAL_SERVER_PORT}` } }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      })
      upstream.on('error', (err) => { res.writeHead(502); res.end(String(err)) })
      req.pipe(upstream)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise(resolve => pageServer.listen(PAGE_PORT, '127.0.0.1', resolve))
  log('page', `页面 http://127.0.0.1:${PAGE_PORT}(代理 → 真服务 ${REAL_SERVER_PORT})`)

  const measurements = {}
  const checks = {}
  const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
    page.on('console', m => { if (m.type() === 'error') log('console-error', m.text()) })
    page.on('pageerror', (err) => log('pageerror', String(err)))
    page.on('requestfailed', (req) => log('request-failed', `${req.url()} ${req.failure()?.errorText}`))
    page.on('request', (r) => { if (r.url().includes('generate-agent')) log('S8-net', `generate-agent 已发出 ${r.method()} ${r.url().slice(-30)}`) })
    page.on('response', (res) => {
      if (res.status() >= 400) log('http-4xx', `${res.status()} ${res.url()}`)
      if (res.url().includes('generate-agent')) log('S8-net', `generate-agent 响应 ${res.status()}`)
    })
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/`)
    // 等真实小组件把图谱格挂出来(真 GraphView 发起真 status 请求)
    try {
      await page.waitForSelector('#workbench-root .ben-wb__mod-handle', { timeout: 15000 })
      // 真实路径:小组件默认在「素材入口」,点「整理与图谱」进嵌套图谱那一页(用户日常就是点这颗)
      await page.click('#workbench-root button:has-text("整理与图谱")')
      // 图区实体二态之一:够高挂 iframe,太矮给收拢条(2026-10-26 视觉退回的机制)——任一出现都算挂上
      await page.waitForSelector('#workbench-root iframe[title="项目图谱"], #workbench-root .ben-wb__graph-collapsed', { timeout: 15000 })
    } catch (err) {
      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '(evaluate 也失败)')
      const graphHtml = await page.evaluate(() => {
        const el = document.querySelector('.ben-wb__graph')
        return el ? el.outerHTML.slice(0, 1200) : '(没有 .ben-wb__graph)'
      }).catch(() => '(evaluate 失败)')
      log('debug', `挂载失败,页面文本: ${bodyText.slice(0, 600)}\n图谱格 HTML: ${graphHtml}`)
      throw err
    }

    const measure = () => page.evaluate(() => {
      const root = document.getElementById('workbench-root')
      const box = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      }
      return {
        mod: box(root.querySelector('.ben-wb__mod[data-module-box="files"]')),
        advanced: box(root.querySelector('.cf-advanced')),
        graph: box(root.querySelector('.ben-wb__graph')),
        iframe: box(root.querySelector('iframe[title="项目图谱"]')),
        bar: box(root.querySelector('.ben-wb__graph-collapsed')),
        note: box(root.querySelector('.ben-wb__graph-note')),
      }
    })
    /** 图区当前实体:iframe(够高)或收拢条(太矮)——量「图占的那块」,不猜形态 */
    const areaBox = (m) => m.iframe ?? m.bar
    const areaH = (m) => { const a = areaBox(m); return a ? a.h : 0 }
    /** 祖先裁切核验:图区(iframe 或收拢条)与图注完整落在 mod 内容区之内(不被 overflow:hidden 裁) */
    const noAncestorClipping = (rootSel) => page.evaluate((sel) => {
      const root = document.querySelector(sel)
      const mod = root.querySelector('.ben-wb__mod[data-module-box="files"]')
      if (!mod) return { ok: false, reason: 'no mod' }
      const mr = mod.getBoundingClientRect()
      const innerBottom = mr.bottom - 12 // 底边 12px 手柄不占内容
      const report = {}
      let ok = true
      for (const [name, el] of [['graph', root.querySelector('iframe[title="项目图谱"], .ben-wb__graph-collapsed')], ['note', root.querySelector('.ben-wb__graph-note')]]) {
        if (!el) { report[name] = 'missing'; ok = false; continue }
        const r = el.getBoundingClientRect()
        const visible = r.height > 0 && r.bottom <= innerBottom + 1 && r.top >= mr.top - 1
        report[name] = { h: Math.round(r.height * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, innerBottom: Math.round(innerBottom * 10) / 10, visible }
        if (!visible) ok = false
      }
      return { ok, modH: Math.round(mr.height * 10) / 10, report }
    }, rootSel)
    const boxOf = (o) => o && { w: Math.round(o.w ?? o.width), h: Math.round(o.h ?? o.height) }

    // ── S1 初始:真实生产树渲染,各级高度就绪 ──
    const s1 = await measure()
    measurements.initial = s1
    log('S1', `初始 ${JSON.stringify(s1)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-01-初始.png') })
    checks.realReactTreeMounted = areaBox(s1) !== null && s1.advanced !== null

    // ── S2 真拖柄拉高手柄(+240px):增长必须传到外壳、GraphView 与图区 ──
    const handleBox = await page.locator('#workbench-root .ben-wb__mod-handle').boundingBox()
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 240, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const s2 = await measure()
    measurements.draggedUp = s2
    log('S2', `拖高后 ${JSON.stringify(s2)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-02-拖高手柄后.png') })
    // 默认矮态(220px)是收拢条;拖高后真 iframe 挂出来、图区显著变高;
    // 增长逐层传导(外壳增量还包含手柄/余量,cf-advanced 传导量以实际为准)
    checks.dragUpPropagates = s2.iframe !== null
      && (areaH(s2) - areaH(s1)) >= 60
      && (s2.mod.h - s1.mod.h) >= 150
      && Math.abs((s2.iframe.h - areaH(s1)) - (s2.advanced.h - s1.advanced.h)) < 2

    // ── S3 拖回(-120px):双向随动 ──
    const handleBox2 = await page.locator('#workbench-root .ben-wb__mod-handle').boundingBox()
    await page.mouse.move(handleBox2.x + handleBox2.width / 2, handleBox2.y + handleBox2.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox2.x + handleBox2.width / 2, handleBox2.y + handleBox2.height / 2 - 120, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const s3 = await measure()
    measurements.draggedDown = s3
    log('S3', `缩回后 ${JSON.stringify(s3)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-03-拖拽缩回.png') })
    checks.dragDownPropagates = areaH(s3) < areaH(s2)

    // ── S3b 最矮允许尺寸:拖到最低,外壳停在合理最小高度,图体与图注不被祖先裁切 ──
    const handleBoxMin = await page.locator('#workbench-root .ben-wb__mod-handle').boundingBox()
    await page.mouse.move(handleBoxMin.x + handleBoxMin.width / 2, handleBoxMin.y + handleBoxMin.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBoxMin.x + handleBoxMin.width / 2, handleBoxMin.y + handleBoxMin.height / 2 - 500, { steps: 15 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const s3b = await measure()
    const clipA = await noAncestorClipping('#workbench-root')
    measurements.minSize = { rects: s3b, clipping: clipA }
    log('S3b', `最矮: ${JSON.stringify(s3b.mod)} 裁切核验: ${JSON.stringify(clipA)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-03b-最矮允许尺寸.png') })
    // 极小尺寸的诚实机制(视觉退回钉的):收拢条在、不塞细线图;文案说实话;
    // 点它真开全屏、Esc 真关得掉 —— 「明确可用的展开方式」要真的可用,不许只存在。
    const barInfo = await page.evaluate(() => {
      const el = document.querySelector('#workbench-root .ben-wb__graph-collapsed')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { text: el.textContent, h: Math.round(r.height * 10) / 10, w: Math.round(r.width * 10) / 10 }
    })
    log('S3b', `收拢条 ${JSON.stringify(barInfo)}`)
    let minExpandWorks = false
    if (barInfo !== null && /展开全屏/.test(barInfo.text)) {
      await page.click('#workbench-root .ben-wb__graph-collapsed')
      await page.waitForSelector('.ben-wb__graph-modal', { timeout: 3000 })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      minExpandWorks = (await page.$('.ben-wb__graph-modal')) === null
    }
    checks.minSizeNoClipping = clipA.ok && s3b.mod.h >= 200 && s3b.mod.h <= 250 && barInfo !== null && barInfo.h >= 20
    checks.minSizeExpandWorks = minExpandWorks
    // 从最矮拖回常规,验证向上拖仍然有效(不被地板卡死)
    // 从最矮拖回常规(8%→约 47% 需 +210px 左右),后续 S4/S5 以实测基线为准
    const handleBoxUp = await page.locator('#workbench-root .ben-wb__mod-handle').boundingBox()
    await page.mouse.move(handleBoxUp.x + handleBoxUp.width / 2, handleBoxUp.y + handleBoxUp.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBoxUp.x + handleBoxUp.width / 2, handleBoxUp.y + handleBoxUp.height / 2 + 210, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(200)

    // ── S3c 直出本体旧嵌套入口(B 实例):常规高度下图体/图注完整可见、无祖先裁切 ──
    await page.waitForSelector('#workbench-root-builtin iframe[title="项目图谱"]', { timeout: 15000 })
    const clipB = await noAncestorClipping('#workbench-root-builtin')
    measurements.builtinDirect = { clipping: clipB }
    log('S3c', `直出本体(B): ${JSON.stringify(clipB)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-10-旧嵌套直出本体.png') })
    checks.builtinDirectNoClipping = clipB.ok
    // B 实例图区 ~93px:净区容不下「点+名+数」一行 → 页面必须走诚实提示(tooshort),
    // 而不是把圆点和标签压进 43px 里再被底边裁(04a 退回点名的内建入口裁切)。
    const bFrameEl = await page.$('#workbench-root-builtin iframe[title="项目图谱"]')
    const bFrame = await bFrameEl.contentFrame()
    await bFrame.waitForFunction('window.__overviewStats !== undefined', undefined, { timeout: 15000 })
    const bStats = await bFrame.evaluate(() => window.__overviewStats)
    const bNotice = await bFrame.evaluate(() => ({
      display: getComputedStyle(document.getElementById('tooshort')).display,
      text: document.getElementById('tooshort').textContent,
    }))
    measurements.builtinOverview = { stats: bStats, notice: bNotice }
    log('S3c', `内建入口(B): ${JSON.stringify({ tooShort: bStats.tooShort, notice: bNotice })}`)
    checks.builtinTooShortHonest = bStats.tooShort === true
      ? bNotice.display === 'flex' && bNotice.text.includes('展开')
      : bStats.bottomClear === true && bStats.shown > 0

    // ── S4 大图真聚合概览(2026-10-26 视觉验收退回后重做):分页+视口自适应,首屏必须真可读 ──
    // 判定从「画的是不是聚合点」升级到「渲染出来能不能认」:几何回执(最小/中位像素半径、
    // 标签数、覆盖率)由图页用 vis 自己的世界→屏幕变换实测上报,断言钉在可读下限上。
    // S3b 把 A 实例拖到了最矮(收拢条态),先把真手柄拖回到图区 ≥150px 再验
    // (375 是这格拖高的实际上限,iframe 占满剩余约 181px —— 控件不再压图,这是修对的表现)。
    const dragHandleUp = async (targetH) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const m = await measure()
        if (m.iframe && m.iframe.h >= targetH) return m
        const hb = await page.locator('#workbench-root .ben-wb__mod-handle').boundingBox()
        await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
        await page.mouse.down()
        await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 300, { steps: 12 })
        await page.mouse.up()
        await page.waitForTimeout(250)
      }
      const m = await measure()
      if (!m.iframe || m.iframe.h < targetH) throw new Error(`拖不回可交互高度: ${JSON.stringify(m)}`)
      return m
    }
    const s4base = await dragHandleUp(150)
    const frameEl = await page.$('#workbench-root iframe[title="项目图谱"]')
    const frame = await frameEl.contentFrame()
    await frame.waitForSelector('#net', { timeout: 15000 })
    await frame.waitForFunction('window.__overviewCount > 0', undefined, { timeout: 15000 })
    const overview = await frame.evaluate(() => {
      const ids = window.__net.body.data.nodes.getIds()
      return {
        hud: document.getElementById('hud-text').textContent,
        nodeCount: ids.length,
        overviewCount: window.__overviewCount,
        rawCount: window.__nodeCount,
        allCommunity: ids.every(id => String(id).startsWith('c:')),
        stats: window.__overviewStats,
        // 标签转义核:渲染态 label 必须是真换行两行,不许含字面反斜杠(13 截图退回实证)
        firstLabel: String(window.__net.body.data.nodes.get(ids[0]).label),
        // 诊断:前几颗点与「其余社区」的世界坐标(排查点击落点用)
        probe: [ids[0], 'c:*'].map(id => ({ id: String(id), p: window.__net.getPosition(id) })),
      }
    })
    measurements.largeOverview = overview
    log('S4', `概览 ${JSON.stringify(overview)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-04a-大图社区聚合概览.png') })
    // 聚合必须属实:画的都是社区聚合点、总量一个不少地如实上报、HUD 写明聚合与分页。
    checks.overviewIsAggregated = overview.allCommunity
      && overview.stats !== undefined
      && overview.stats.communities === overview.overviewCount
      && overview.rawCount >= 40000
      && overview.hud.includes('聚合')
      && overview.hud.includes(String(overview.rawCount))
      && overview.stats.pageCount >= 2
    // 首屏必须真可读(视觉退回的核心):渲染几何钉下限,不是「控件存在」就算过。
    // 标签数随页容走:每个展示的社区都带标签;标签必须真换行、带社区名;
    // 首行不被 HUD 盖、底行标签完整落在画布内(净区判定的可复核形式)。
    checks.overviewReadable = overview.stats !== undefined
      && overview.stats.minRadiusPx >= 8
      && overview.stats.medianRadiusPx >= 10
      && overview.stats.labeledCount >= Math.min(40, overview.stats.shown)
      && overview.stats.coverage >= 0.12
      && overview.firstLabel.includes('\n') && !overview.firstLabel.includes('\\')
      && /[\u4e00-\u9fa5A-Za-z_]/.test(overview.firstLabel)
      && overview.stats.hudClear === true
      && overview.stats.bottomClear === true

    // ── S4-分页:点「其余社区」翻到下页(真实指针),「上一页」可逆回来 ──
    const restPos = await frame.evaluate(() => new Promise((resolve) => {
      const net = window.__net
      const canvas = document.getElementById('net')
      net.focus('c:*', { scale: 1, animation: false })
      requestAnimationFrame(() => {
        const p = net.canvasToDOM(net.getPosition('c:*'))
        const hit = net.getNodeAt(p)
        resolve({
          x: p.x, y: p.y,
          inViewport: p.x > 0 && p.x < canvas.clientWidth && p.y > 0 && p.y < canvas.clientHeight,
          hit: hit === null || hit === undefined ? null : String(hit),
        })
      })
    }))
    const frameBox4 = await frameEl.boundingBox()
    log('S4-page', `其余社区点位 ${JSON.stringify({ restPos, frameBox: frameBox4 })}`)
    let paging = { advanced: false, back: false }
    if (restPos !== null && restPos.inViewport) {
      await page.mouse.click(frameBox4.x + restPos.x, frameBox4.y + restPos.y)
      await page.waitForTimeout(400)
      const page2 = await frame.evaluate(() => ({ page: window.__overviewStats.page, hud: document.getElementById('hud-text').textContent }))
      // 第 2 页同样是完整可读的一屏
      const page2Stats = await frame.evaluate(() => window.__overviewStats)
      log('S4-page2', `翻页后 ${JSON.stringify({ page2, minRadiusPx: page2Stats.minRadiusPx, labeledCount: page2Stats.labeledCount })}`)
      paging.advanced = page2.page === 1 && page2.hud.includes('第 2/') && page2Stats.minRadiusPx >= 8 && page2Stats.labeledCount >= Math.min(40, page2Stats.shown)
      // 上一页:真实指针点按钮中心(与画布点击同路径;frame.click 在 sandbox iframe 里偶发落空)
      const backBox = await frame.evaluate(() => {
        const el = document.getElementById('back-btn')
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, display: getComputedStyle(el).display, text: el.textContent }
      })
      log('S4-page2', `上一页按钮 ${JSON.stringify(backBox)}`)
      await page.mouse.click(frameBox4.x + backBox.x, frameBox4.y + backBox.y)
      await page.waitForTimeout(300)
      const page1 = await frame.evaluate(() => window.__overviewStats.page)
      log('S4-page2', `点上一页后 page=${page1}`)
      paging.back = page1 === 0
    }
    measurements.overviewPaging = { restPos, ...paging }
    checks.overviewPaging = paging.advanced && paging.back

    // ── S4b 真实点击社区聚合点 → 进入该社区成员视图(逐级展开),返回概览可逆 ──
    // 新布局世界单位=像素(scale 1),第一格就是最大社区;聚焦后真实指针点击,
    // 命中哪颗聚合点都行,验证的是「点聚合点必进入社区」。
    const comPos = await frame.evaluate(() => new Promise((resolve) => {
      const net = window.__net
      const canvas = document.getElementById('net')
      const target = net.body.data.nodes.getIds()[0] // 插入顺序=社区大小降序,最大社区
      net.focus(target, { scale: 1.0, animation: false })
      requestAnimationFrame(() => {
        const p = net.canvasToDOM(net.getPosition(target))
        const hit = net.getNodeAt(p)
        resolve({
          x: p.x, y: p.y,
          inViewport: p.x > 0 && p.x < canvas.clientWidth && p.y > 0 && p.y < canvas.clientHeight,
          hit: hit === null || hit === undefined ? null : String(hit),
        })
      })
    }))
    if (comPos === null || !comPos.inViewport) throw new Error(`最大社区聚合点不在视口内: ${JSON.stringify(comPos)}`)
    log('S4b', `点击位 ${JSON.stringify({ iframe: s4base.iframe, frameBox: frameBox4, comPos })}`)
    await page.mouse.click(frameBox4.x + comPos.x, frameBox4.y + comPos.y)
    await page.waitForTimeout(400)
    const drilled = await frame.evaluate(() => {
      const ids = window.__net.body.data.nodes.getIds()
      return {
        hud: document.getElementById('hud-text').textContent,
        nodeCount: ids.length,
        hasMembers: ids.some(id => !String(id).startsWith('c:')),
        hasAggregates: ids.some(id => String(id).startsWith('c:')),
        backVisible: document.getElementById('back-btn').style.display !== 'none',
      }
    })
    // 出社区连线方向回归(统筹退回点名):from 必须是本社区成员(在 DataSet 里)。
    // 旧实现取社区外端点,边在 DataSet 里挂空端点,成员→相邻社区关系静默丢失。
    const edgeCheck = await frame.evaluate(() => {
      const nodeSet = new Set(window.__net.body.data.nodes.getIds().map(String))
      const edges = window.__net.body.data.edges.get()
      const missing = edges.filter(e => !nodeSet.has(String(e.from)) || !nodeSet.has(String(e.to)))
      return { total: edges.length, missing: missing.length }
    })
    measurements.drillEdges = edgeCheck
    log('S4b', `边端点 ${JSON.stringify(edgeCheck)}`)
    checks.drillEdgesEndpointsExist = edgeCheck.total > 0 && edgeCheck.missing === 0
    measurements.drillIn = { click: comPos, ...drilled }
    log('S4b', `进入社区 ${JSON.stringify(drilled)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-04b-点入社区成员.png') })
    checks.drillDownWorks = drilled.hasMembers && drilled.hasAggregates && drilled.backVisible
      && drilled.hud.includes('社区')
    // 返回概览:回到第 1 页纯聚合视图(48 社区 + 「其余社区」翻页点)
    await frame.click('#back-btn')
    await page.waitForTimeout(300)
    const backAgain = await frame.evaluate(() => {
      const ids = window.__net.body.data.nodes.getIds()
      return { allCommunity: ids.every(id => String(id).startsWith('c:')), count: ids.length }
    })
    checks.drillBackReversible = backAgain.allCommunity && backAgain.count === overview.stats.perPage + 1

    // ── S4c 搜索定位原节点:搜 FilesModule → 其所在社区自动展开 → 聚焦出 NODE INFO ──
    await frame.click('#kw')
    await frame.type('#kw', 'FilesModule', { delay: 20 })
    await page.keyboard.press('Enter') // 焦点已落在 iframe 的输入框,Enter 走 page 级键盘
    await page.waitForTimeout(600)
    const sideInfo = await frame.evaluate(() => {
      const side = document.getElementById('side')
      const r = side.getBoundingClientRect()
      return { display: getComputedStyle(side).display, h: r.height, label: document.getElementById('s-label').textContent }
    })
    log('S4c', `搜索定位 NODE INFO: ${JSON.stringify(sideInfo)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-04c-搜索定位节点.png') })
    // 点空白处收回,验证双向
    let sideAfterBlank = 'block'
    const blankPoint = await frame.evaluate(() => {
      const net = window.__net
      const canvas = document.getElementById('net')
      for (let y = 8; y < canvas.clientHeight - 8; y += 14) {
        for (let x = 8; x < canvas.clientWidth - 8; x += 14) {
          if (!net.getNodeAt({ x, y })) return { x, y }
        }
      }
      return null
    })
    if (blankPoint !== null) {
      await page.mouse.click(frameBox4.x + blankPoint.x, frameBox4.y + blankPoint.y)
      await page.waitForTimeout(250)
      sideAfterBlank = await frame.evaluate(() => getComputedStyle(document.getElementById('side')).display)
    }
    measurements.nodeInfo = { side: sideInfo, sideAfterBlank, iframeH: s4base.iframe.h }
    checks.searchLocatesNode = sideInfo.display === 'block' && sideInfo.label.includes('FilesModule')
    checks.nodeInfoFollowsHeight = sideInfo.display === 'block' && Math.abs(sideInfo.h - s4base.iframe.h) < 4 && sideAfterBlank === 'none'

    // ── S6b 全屏展开大图:概览在全屏里按新视口重排且真可读(视觉退回:全屏是读图主路径之一) ──
    await page.click('#workbench-root button[aria-label="展开查看图谱"]')
    await page.waitForSelector('.ben-wb__graph-modal', { timeout: 3000 })
    const bigModalFrameEl = await page.$('.ben-wb__graph-modal iframe')
    const bigModalFrame = await bigModalFrameEl.contentFrame()
    // 图页在 iframe 里按自己的视口现算布局;等它把几何回执交出来再断言语截图
    await bigModalFrame.waitForFunction('window.__overviewStats && window.__overviewStats.minRadiusPx >= 8', undefined, { timeout: 15000 })
    const modalOverviewStats = await bigModalFrame.evaluate(() => window.__overviewStats)
    measurements.modalOverviewStats = modalOverviewStats
    log('S6b', `全屏概览 ${JSON.stringify(modalOverviewStats)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-13-全屏大图概览可读.png') })
    checks.modalOverviewReadable = modalOverviewStats.minRadiusPx >= 8 && modalOverviewStats.medianRadiusPx >= 20 && modalOverviewStats.labeledCount >= 40
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    if ((await page.$('.ben-wb__graph-modal')) !== null) {
      await page.click('.ben-wb__graph-modal .ben-wb__graph-modal-close')
      await page.waitForTimeout(200)
    }

    // ── S5 切项目 DouDou:真 select 换项目,高度不回退 ──
    await page.selectOption('#workbench-root select[aria-label="图谱项目"]', 'doudou')
    // 等 DouDou 的图谱 iframe 真挂出来再量(status 回包 + hasHtml 渲染有真实时延)
    await page.waitForSelector('#workbench-root iframe[title="项目图谱"]', { timeout: 15000 })
    await page.waitForTimeout(400)
    const s5 = await measure()
    measurements.doudou = s5
    log('S5', `DouDou ${JSON.stringify(s5)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-05-切换项目DouDou.png') })
    checks.projectSwitchKeepsHeight = s5.iframe.h >= s4base.iframe.h - 4

    // ── S6 展开全屏 → Escape 退出(DouDou 小图:等画布真画出来再截图,不截黑屏) ──
    await page.click('#workbench-root button[aria-label="展开查看图谱"]')
    await page.waitForSelector('.ben-wb__graph-modal', { timeout: 3000 })
    const doudouModalFrameEl = await page.$('.ben-wb__graph-modal iframe')
    const doudouModalFrame = await doudouModalFrameEl.contentFrame()
    await doudouModalFrame.waitForSelector('canvas', { timeout: 15000 })
    await page.waitForTimeout(400)
    const modalIframe = await page.evaluate(() => {
      const el = document.querySelector('.ben-wb__graph-modal iframe')
      const r = el.getBoundingClientRect()
      return { w: r.width, h: r.height }
    })
    measurements.modal = modalIframe
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-06-展开全屏.png') })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    checks.modalOpenClose = modalIframe.h > 600 && (await page.$('.ben-wb__graph-modal')) === null

    // ── S7 Archify 五图(先切回 desktop-workbench):钉点徽标来自规格,生成时间如实呈现 ──
    await page.selectOption('#workbench-root select[aria-label="图谱项目"]', 'desktop-workbench')
    await page.waitForTimeout(1000)
    await page.click('#workbench-root button[role="tab"]:has-text("架构图")')
    await page.waitForSelector('select[aria-label="架构图选择"]', { timeout: 10000 })
    const archHead = await page.evaluate(() => {
      const root = document.getElementById('workbench-root') // 限定 A;B 实例也在 DOM 里
      const badge = root.querySelector('.ben-wb__graph-badge')
      const note = root.querySelectorAll('.ben-wb__graph-note')
      const lastNote = note[note.length - 1]
      const iframe = root.querySelector('iframe[title^="架构图"]')
      return {
        badge: badge?.textContent ?? null,
        note: lastNote?.textContent ?? null,
        options: root.querySelector('select[aria-label="架构图选择"]').options.length,
        iframeSrc: iframe?.getAttribute('src') ?? null,
      }
    })
    measurements.archifyDesktop = archHead
    log('S7', `Archify ${JSON.stringify(archHead)}`)
    checks.archifyFiveWithPinAndAge = archHead.options === 5 && archHead.badge.includes('c55') && archHead.note.includes('生成于')
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-07-Archify五图与钉点.png') })

    // ── S7b Archify 普通窗口可自行缩放(2026-10-26 排查实证:旧链路 ?embed=1 把缩放/详情全藏了) ──
    const archFrameEl = await page.$('#workbench-root iframe[title^="架构图"]')
    const archFrame = await archFrameEl.contentFrame()
    const zoomBefore = await archFrame.evaluate(() => {
      const nav = document.querySelector('.diagram-nav')
      const zoomIn = document.querySelector('.diagram-nav [data-view="in"]')
      const zoomOut = document.querySelector('.diagram-nav [data-view="out"]')
      const reset = document.querySelector('.diagram-nav [data-view="reset"]')
      const percent = document.querySelector('[data-view-percent]')
      return {
        navPresent: nav !== null,
        zoomInPresent: zoomIn !== null && !zoomIn.disabled,
        zoomOutPresent: zoomOut !== null && !zoomOut.disabled,
        resetPresent: reset !== null && !reset.disabled,
        percent: percent ? percent.textContent.trim() : null,
      }
    })
    await archFrame.click('.diagram-nav [data-view="in"]')
    await archFrame.click('.diagram-nav [data-view="in"]')
    await page.waitForTimeout(400)
    const zoomAfter = await archFrame.evaluate(() => {
      const percent = document.querySelector('[data-view-percent]')
      return { percent: percent ? percent.textContent.trim() : null }
    })
    // 再点「重置图表视图」必须能回原位
    await archFrame.click('.diagram-nav [data-view="reset"]')
    await page.waitForTimeout(400)
    const zoomReset = await archFrame.evaluate(() => {
      const percent = document.querySelector('[data-view-percent]')
      return { percent: percent ? percent.textContent.trim() : null }
    })
    measurements.archifyZoom = { before: zoomBefore, afterTwoIn: zoomAfter, afterReset: zoomReset }
    log('S7b', `缩放 ${JSON.stringify(measurements.archifyZoom)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-11-Archify普通窗口缩放.png') })
    // 用户看得见的缩放百分比为准:两次放大后百分比变化,重置后回到原值
    checks.archifyZoomUsable = zoomBefore.navPresent && zoomBefore.zoomInPresent && zoomBefore.zoomOutPresent && zoomBefore.resetPresent
      && zoomAfter.percent !== zoomBefore.percent
      && zoomReset.percent === zoomBefore.percent

    // ── S7c Archify 展开全屏 → 真点节点 → 原图二级详情(语义护照)出现;Esc 退出 ──
    await page.click('#workbench-root button[aria-label="展开查看图谱"]')
    await page.waitForSelector('.ben-wb__graph-modal', { timeout: 3000 })
    const modalArchFrameEl = await page.$('.ben-wb__graph-modal iframe')
    const modalArchFrame = await modalArchFrameEl.contentFrame()
    await modalArchFrame.waitForSelector('svg [data-node-id]', { timeout: 15000 })
    const nodeBox = await (await modalArchFrame.$('svg [data-node-id]')).boundingBox()
    await page.mouse.click(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2)
    await page.waitForTimeout(500)
    const passport = await modalArchFrame.evaluate(() => {
      const chip = document.getElementById('focus-chip')
      if (!chip) return { present: false }
      const style = getComputedStyle(chip)
      return {
        present: true,
        hiddenAttr: chip.hidden,
        display: style.display,
        text: chip.textContent.trim().slice(0, 80),
      }
    })
    measurements.archifyModalDetail = { modalIframeBox: await modalArchFrameEl.boundingBox(), passport }
    log('S7c', `展开节点详情 ${JSON.stringify(passport)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-12-Archify展开节点详情.png') })
    // ── 焦点取证 + 真实 Esc 验证(2026-10-26 前:焦点进了 iframe 后顶层收不到 Esc,
    //    弹层关不掉把整格盖住;已修,这里做真浏览器回归)──
    const focusProbe = await modalArchFrame.evaluate(() => ({ frameHasFocus: document.hasFocus() })).catch((e) => String(e))
    const topFocus = await page.evaluate(() => {
      const ae = document.activeElement
      return ae ? String(ae.tagName + ' ' + ae.className).slice(0, 60) : null
    })
    log('S7c', `焦点探测 frame=${JSON.stringify(focusProbe)} top.activeElement=${topFocus}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    let modalGone = (await page.$('.ben-wb__graph-modal')) === null
    checks.escClosesModalFromIframeFocus = modalGone
    if (!modalGone) {
      // 诊断:从顶层往图里合成一颗 Esc —— 若合成能关而真键不能,问题在按键投递;
      // 若都不能,搭桥监听没挂到活窗口。evaluate 全在顶层做,弹层关掉也不会崩。
      const probe = await page.evaluate(() => {
        const frame = document.querySelector('.ben-wb__graph-modal iframe')
        try {
          frame?.contentDocument?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
          return 'dispatched'
        }
        catch (error) { return String(error) }
      })
      await page.waitForTimeout(400)
      const syntheticClosed = (await page.$('.ben-wb__graph-modal')) === null
      log('S7c-warn', `Esc 未关掉弹层(焦点在 iframe 里);合成 Esc 探测=${probe} 合成后关闭=${syntheticClosed}。改点「退出全屏」继续取证`)
      await page.click('.ben-wb__graph-modal .ben-wb__graph-modal-close')
      await page.waitForTimeout(300)
      modalGone = (await page.$('.ben-wb__graph-modal')) === null
    }
    if (process.env.HARNESS_STOP_AFTER === 's7c') {
      measurements.focusProbe = { focusProbe, topFocus, escClosed: checks.escClosesModalFromIframeFocus }
      log('S7c', `Esc 关闭弹层(焦点在图内)=${checks.escClosesModalFromIframeFocus}`)
      throw new Error('HARNESS_STOP_AFTER=s7c,探测完即停')
    }
    checks.archifyModalDetail = passport.present && !passport.hiddenAttr && passport.display !== 'none' && passport.text.length > 0 && modalGone

    // ── S8 DouDou「由 Agent 生成」:真 kimi CLI 读真源码 → 校验 → 原子交付 → 格内可看 ──
    await page.selectOption('#workbench-root select[aria-label="图谱项目"]', 'doudou')
    await page.waitForTimeout(800)
    await page.waitForSelector('text=这个项目还没有架构图', { timeout: 5000 })
    if (await page.$('.ben-wb__graph-modal')) {
      log('S8-warn', '仍有残留全屏弹层,先点「退出全屏」再生成')
      await page.click('.ben-wb__graph-modal .ben-wb__graph-modal-close')
      await page.waitForTimeout(300)
    }
    log('S8', '点击「由 Agent 生成」(服务端派真 kimi CLI 只读 DouDou 源码,可能数分钟)…')
    // 真坐标真实点击:Playwright 的 actionability 重试会被 React 合法状态变化
    // (点击后立即 busy)干扰;取按钮中心坐标后用 CDP 真实鼠标点击,一发即中
    const btnBox = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '由 Agent 生成' && !b.disabled)
      if (!btn) return null
      const r = btn.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    if (btnBox === null) throw new Error('「由 Agent 生成」按钮不存在或不可用')
    // 点之前先取证:按钮中心点命中的是谁(2026-10-26 曾因坐标点击被盖住而点空,
    // 这里把 elementFromPoint 结果留在 measurements 里)。
    const hitProbe = await page.evaluate((box) => {
      const el = document.elementFromPoint(box.x, box.y)
      return el ? { tag: el.tagName, cls: String(el.className).slice(0, 80), text: (el.textContent ?? '').trim().slice(0, 40) } : null
    }, btnBox)
    measurements.agentClickProbe = { btnBox, hitProbe }
    log('S8', `按钮中心命中: ${JSON.stringify(hitProbe)}`)
    // Playwright 原生点击:actionability 会校验「该点真的收到指针事件」,被盖住会自动重试,
    // 比裸坐标可靠;点击后立即 busy 的合法状态变化用忙态断言兜(不依赖 actionability 事后校验)。
    await page.locator('#workbench-root button', { hasText: '由 Agent 生成' }).first().click({ timeout: 10000 })
    // 点击必须被 React 接住:按钮立刻变「正在生成…」;没变就是点空了(布局瞬移),重试一次再断定
    let busy = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '正在生成…'))
    if (!busy) {
      log('S8', '第一次点击未生效(按钮没变「正在生成…」),重试一次')
      await page.locator('#workbench-root button', { hasText: '由 Agent 生成' }).first().click({ timeout: 10000 })
      busy = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '正在生成…'))
    }
    if (!busy) throw new Error('点击「由 Agent 生成」后按钮未进入「正在生成…」,请求没有发出')
    const agentOutcome = await Promise.race([
      page.waitForSelector('select[aria-label="架构图选择"]', { timeout: 12 * 60 * 1000 }).then(() => 'generated'),
      page.waitForSelector('.ben-wb__graph-error', { timeout: 12 * 60 * 1000 }).then(async () => `error:${await page.textContent('.ben-wb__graph-error')}`),
    ])
    if (agentOutcome !== 'generated') throw new Error(`「由 Agent 生成」未成功(${agentOutcome})`)
    await page.waitForSelector('iframe[title^="架构图"]', { timeout: 30000 })
    await page.waitForTimeout(1500)
    const doudouArch = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[title^="架构图"]')
      const note = document.querySelectorAll('.ben-wb__graph-note')
      return { src: iframe?.getAttribute('src') ?? null, note: note[note.length - 1]?.textContent ?? null }
    })
    const doudouStatus = await (await fetch(`${server.url}/archify/status?project=doudou`)).json()
    measurements.doudouAgent = { view: doudouArch, status: { hasDiagrams: doudouStatus.hasDiagrams, diagrams: doudouStatus.diagrams } }
    log('S8', `Agent 产物 ${JSON.stringify(measurements.doudouAgent)}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '真React-08-DouDou由Agent生成.png') })
    checks.agentGeneratedReal = doudouArch.src.includes('/archify/view/doudou/doudou-arch.html')
      && doudouStatus.hasDiagrams === true
      && typeof doudouStatus.diagrams[0].generatedAt === 'number'
      && doudouStatus.diagrams[0].name !== doudouStatus.diagrams[0].id

    // ── S9 真实 Agent 定向读 spec 端点 + 回源码核验 ──
    log('S9', '派 kimi CLI 自己 curl /archify/spec 端点回答结构问题…')
    const specPrompt = [
      '先用 curl 读取 http://127.0.0.1:3493/archify/spec/desktop-workbench/architecture-runtime 这份 JSON 架构规格。',
      '然后只依据规格回答(不超过 4 行):中转(relay)服务里,签发 LiveKit 进房票据的接口与模型代理接口,规格里标注的源文件与行号分别是什么?',
    ].join('\n')
    // 注意参数序:kimi 的 -p 直接吃下一个参数当提示词,不能再插 --auto(会变成命令)。
    // 必须异步 spawn:真服务与本脚本同进程,spawnSync 会卡住事件循环,
    // Agent 去 curl 的 /archify/spec 正是本进程的服务 —— 同步等就是自己锁死自己。
    const agentAnswer = await new Promise((resolve) => {
      const child = spawn('kimi', ['-p', specPrompt], { cwd: repoRoot, env: { ...process.env } })
      let out = ''
      child.stdout.on('data', (c) => { out += c.toString('utf8') })
      child.stderr.on('data', () => {})
      const killer = setTimeout(() => { child.kill('SIGTERM') }, 5 * 60 * 1000)
      child.once('error', () => { clearTimeout(killer); resolve('') })
      child.once('close', () => { clearTimeout(killer); resolve(out.trim()) })
    })
    const relaySource = fs.readFileSync(path.join(repoRoot, 'relay', 'server', 'app.cjs'), 'utf8').split('\n')
    const line448 = relaySource[447] ?? ''
    const line1081 = relaySource[1080] ?? ''
    // 实质核验:Agent 必须答出「relay/server/app.cjs」与行号 448(签票处),
    // 并提到模型代理(/chat/completions 或 1081 或「代理」措辞);
    // 措辞不锁死,事实由下面回源再证
    const answerOk = agentAnswer.includes('app.cjs') && agentAnswer.includes('448')
      && (agentAnswer.includes('chat/completions') || agentAnswer.includes('1081') || agentAnswer.includes('代理'))
    const sourceOk = line448.includes("app.post('/v1/channel-token'") && line1081.includes("app.post('/v1/chat/completions'")
    measurements.agentSpecRead = {
      answer: agentAnswer.slice(-1200),
      byteRatio: null,
      sourceCheck: { line448: line448.trim(), line1081: line1081.trim(), ok: sourceOk },
    }
    // 字节体积比(实测):spec JSON vs 同图 HTML 产物 —— 只记字节,不宣称 token 比例。
    // 端点取不到时退回直接量盘上同一份文件(desktop-workbench 的规格/产物就是这两份)。
    const pinnedDir = path.join(repoRoot, 'docs', '全景地图', 'archify')
    const specFile = path.join(pinnedDir, 'architecture-runtime.json')
    const htmlFile = path.join(pinnedDir, 'architecture-runtime.html')
    let specBytes
    try {
      const specJson = await (await fetch(`${server.url}/archify/spec/desktop-workbench/architecture-runtime`)).text()
      specBytes = Buffer.byteLength(specJson)
    } catch (err) {
      log('S9-warn', `spec 端点取字节数失败(${String(err).slice(0, 120)}),退回盘上同一份文件`)
      specBytes = fs.statSync(specFile).size
    }
    const htmlSize = fs.statSync(htmlFile).size
    measurements.agentSpecRead.byteRatio = {
      specBytes,
      htmlBytes: htmlSize,
      ratio: `${(100 - specBytes / htmlSize * 100).toFixed(1)}% 字节更少(token 节省未实测)`,
    }
    fs.writeFileSync(path.join(EVIDENCE_DIR, '真React-09-Agent读规格-回执.json'), JSON.stringify(measurements.agentSpecRead, null, 2))
    log('S9', `Agent 回答末段: ${agentAnswer.slice(-200)}`)
    checks.agentReadSpecEndpoint = answerOk && sourceOk

    // ── 汇总收据 ──
    const failed = Object.entries(checks).filter(([, v]) => v !== true)
    const receipt = {
      timestamp: new Date().toISOString(),
      commit: HEAD_COMMIT,
      ports: { realServer: REAL_SERVER_PORT, page: PAGE_PORT },
      browser: 'Google Chrome (headless,真实渲染)',
      environment: { isolatedHome: tempHome, maintainerHomeWritten: false },
      whatIsReal: [
        '用户层 files 小组件真文件(user-layer/起步/小组件/files/index.js)经 evaluateWidget 求值',
        'shipped FilesModule/GraphView/ModuleBox/ModuleHeader 组件树',
        'ModuleBox 真手柄 + 真 resizeModule 换算(胶水 mirrors Workbench.tsx)',
        'startWorkbenchServer 真路由 + graphify/archify 真服务',
        'DouDou 架构图由真 kimi CLI 读真源码生成,官方 archify CLI 校验落地',
        'spec 端点由 kimi CLI 真实 curl 读取',
      ],
      measurements,
      checks,
    }
    fs.writeFileSync(path.join(EVIDENCE_DIR, '真React-浏览器验收收据.json'), JSON.stringify(receipt, null, 2))
    if (failed.length > 0) {
      throw new Error(`有未过检查:${failed.map(([k]) => k).join(', ')}`)
    }
    log('done', '全部检查通过。')
  } finally {
    await browser.close()
    pageServer.close()
    await server.close()
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
}

function pathToFile(dir, rel) {
  return pathToFileURL(path.join(dir, rel)).href
}

main().catch((err) => {
  console.error('验收失败:', err)
  process.exit(1)
})
