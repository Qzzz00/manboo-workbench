/**
 * 现有用户层旧 files 小组件原件 · 最终真实路径收据(2026-10-24,卡「图谱显示修复与Archify接入」)。
 *
 * 背景:既有的 real-browser-graph-drag.mjs 用的是**仓库 starter 现版本**;维护者机器上
 * ~/.dsh 里那份**旧原件**(2026-10-21 分层第一刀版 + 兼容 style.css,cf-advanced 还是
 * margin-top+min-height:180px 的老定义)不能凭 starter 证据断言适配。本脚本:
 * - 只读加载该原件( index.js 经本体同一 evaluateWidget 白名单求值;style.css 由页面
 *   按产品加载口同序注入 —— 契约里 style.css 是这一版的组成部分);
 * - 全部 HTTP/缓存指向自有隔离 HOME 与 3493(真服务)/9291(页面代理),不碰个人 ~/.dsh
 *   写入、8791、账号凭据;
 * - 验既有把手向下/上拖、外壳/GraphView/iframe/图注的祖先几何(不只 bbox 增长)、
 *   初始/常规/最矮/全屏返回;
 * - 原件前后 sha256 必须一致(只读收据),不一致即失败保全。
 *
 * 若旧原件在现行产品下真实为红(如它自己的 min-height:180px 与高度链冲突),本脚本
 * 只留证报告,不改原件、不边验边改造绿。
 *
 * 用法:WIDGET_DIR=~/.dsh/workbench/用户层/小组件/files node tests/existing-user-layer-smoke.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(pluginDir, '..')
const EVIDENCE_DIR = path.join(repoRoot, 'docs', '验收-图谱显示与Archify-2026-10-23')
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

const REAL_SERVER_PORT = 3493
const PAGE_PORT = 9291
const WIDGET_DIR = process.env.WIDGET_DIR ?? ''
const HEAD_COMMIT = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim()

const PLAYWRIGHT_CANDIDATES = [
  process.env.PLAYWRIGHT_PATH,
  '/Users/example/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js',
].filter(Boolean)
const playwrightEntry = PLAYWRIGHT_CANDIDATES.find(c => fs.existsSync(c))
if (playwrightEntry === undefined) throw new Error(`找不到 Playwright 入口(候选:${PLAYWRIGHT_CANDIDATES.join(', ')})`)
const pw = (await import(playwrightEntry)).default

const PROJECTS = [
  { id: 'desktop-workbench', name: '工作台', stage: '在用', path: '/Users/example/Documents/GitHub/desktop-workbench', links: [], session_count: 0, idle: true },
  { id: 'doudou', name: 'DouDou', stage: '在用', path: '/Users/example/Documents/GitHub/DouDou', links: [], session_count: 0, idle: true },
]

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function log(stage, msg) { console.log(`[旧原件][${stage}] ${msg}`) }

async function main() {
  if (WIDGET_DIR === '' || !fs.existsSync(path.join(WIDGET_DIR, 'index.js'))) {
    throw new Error('缺 WIDGET_DIR(现有用户层 files 小组件目录);不拿 starter 代替')
  }
  const widgetEntry = path.join(WIDGET_DIR, 'index.js')
  const widgetStyle = path.join(WIDGET_DIR, 'style.css')
  const hashBefore = { index: sha256(widgetEntry), style: fs.existsSync(widgetStyle) ? sha256(widgetStyle) : null }
  log('target', `原件: ${widgetEntry}`)
  log('target', `sha256(index.js)=${hashBefore.index.slice(0, 16)}…${fs.statSync(widgetEntry).size}B; style.css=${hashBefore.style?.slice(0, 16) ?? '(无)'}`)

  // 端口空闲核
  for (const port of [REAL_SERVER_PORT, PAGE_PORT]) {
    await new Promise((resolve, reject) => {
      const probe = http.createServer()
      probe.once('error', err => reject(new Error(`端口 ${port} 不可用:${err.message}`)))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
    })
  }

  // 隔离 HOME:graphify 缓存从维护者 ~/.dsh **只读**拷贝
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-old-widget-home-'))
  const graphifyDir = path.join(tempHome, '.dsh', 'workbench', 'graphify')
  fs.mkdirSync(graphifyDir, { recursive: true })
  for (const proj of ['desktop-workbench', 'doudou']) {
    fs.cpSync(path.join(os.homedir(), '.dsh', 'workbench', 'graphify', proj), path.join(graphifyDir, proj), { recursive: true })
  }

  // harness 包(与 S1-S9 同一入口,未改)
  const bundleRun = spawnSync(path.join(pluginDir, 'node_modules', '.bin', 'tsdown'), ['-c', 'tests/harness/tsdown.config.ts', '-l', 'warn'], { cwd: pluginDir, encoding: 'utf8' })
  if (bundleRun.status !== 0) throw new Error(`harness 打包失败:\n${bundleRun.stdout}\n${bundleRun.stderr}`)
  const bundleJs = fs.readFileSync(path.join(pluginDir, 'tests', 'harness', 'dist', 'workbench-harness-entry.iife.js'))

  // 真服务(真 http.ts 路由 + graphify/archify;repoRoot 走真实装配定位)
  const { TOKENS_STYLE } = await import(pathToFileURL(path.join(pluginDir, 'src/client/tokens.ts')).href)
  const { STYLE } = await import(pathToFileURL(path.join(pluginDir, 'src/client/style.ts')).href)
  const { startWorkbenchServer } = await import(pathToFileURL(path.join(pluginDir, 'src/server/http.ts')).href)
  const { createWorkbenchService } = await import(pathToFileURL(path.join(pluginDir, 'src/server/service.ts')).href)
  const { createGraphifyService } = await import(pathToFileURL(path.join(pluginDir, 'src/server/graphify.ts')).href)
  const { archifyAssetRootFrom, createArchifyService } = await import(pathToFileURL(path.join(pluginDir, 'src/server/archify.ts')).href)
  const projectPaths = async () => PROJECTS.map(p => ({ id: p.id, path: p.path }))
  const graphify = createGraphifyService({ dir: graphifyDir, projectPaths, vizUrl: () => 'off', uvBootstrapUrl: () => 'off' })
  const archify = createArchifyService({ homeDir: tempHome, repoRoot: archifyAssetRootFrom(import.meta.url), projectPaths })
  const service = createWorkbenchService()
  const server = await startWorkbenchServer({ port: REAL_SERVER_PORT, service, graphify, archify, tickIntervalMs: 0, heartbeatMs: 0 })
  log('server', `真服务 ${server.url}`)

  const widgetCode = fs.readFileSync(widgetEntry, 'utf8')
  const styleCss = fs.existsSync(widgetStyle) ? fs.readFileSync(widgetStyle, 'utf8') : null
  const pageServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PAGE_PORT}`)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>旧用户层原件收据</title>
<link rel="stylesheet" href="/styles.css">
<style>
  body{margin:0;background:#121216;font:12px/1.5 -apple-system,sans-serif;box-sizing:border-box;padding:16px;overflow:auto}
  .shell{width:760px;height:560px;border:1px solid #333;border-radius:8px;padding:10px;background:#181820;display:flex;flex-direction:column}
  /* .ben-wb 是本体覆盖根(absolute inset 0);单实例也要按流内排 */
  .shell .ben-wb{position:static!important;inset:auto!important;width:100%;height:100%}
</style></head><body>
<div class="shell"><div id="workbench-root"></div></div>
<script src="/harness.js"></script>
<script>
  fetch('/widget-code').then(r => r.text()).then(code => {
    // style.css 按产品加载口同序注入(清单契约的组成部分)
    fetch('/widget-style').then(r => r.ok ? r.text() : null).then(css => {
      if (css) { const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el) }
      window.__wbHarness.mount(document.getElementById('workbench-root'), {
        widgetCode: code,
        baseUrl: 'http://127.0.0.1:${PAGE_PORT}',
        projects: ${JSON.stringify(PROJECTS)},
        currentProjectId: 'desktop-workbench',
        columnHeight: 536,
      })
    })
  })
</script></body></html>`)
      return
    }
    if (url.pathname === '/styles.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); res.end(`${TOKENS_STYLE}\n${STYLE}`); return }
    if (url.pathname === '/harness.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(bundleJs); return }
    if (url.pathname === '/widget-code') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(widgetCode); return }
    if (url.pathname === '/widget-style') {
      if (styleCss === null) { res.writeHead(404); res.end('') } else { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); res.end(styleCss) }
      return
    }
    if (url.pathname.startsWith('/graphify/') || url.pathname.startsWith('/archify/')) {
      const upstream = http.request({ host: '127.0.0.1', port: REAL_SERVER_PORT, path: url.pathname + url.search, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${REAL_SERVER_PORT}` } }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      })
      upstream.on('error', err => { res.writeHead(502); res.end(String(err)) })
      req.pipe(upstream)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise(resolve => pageServer.listen(PAGE_PORT, '127.0.0.1', resolve))
  log('page', `页面 http://127.0.0.1:${PAGE_PORT}`)

  const measurements = {}
  const checks = {}
  const shot = (name) => path.join(EVIDENCE_DIR, `旧原件-${name}.png`)
  const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const browser = await pw.chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/`)
    await page.waitForSelector('#workbench-root .ben-wb__mod-handle', { timeout: 15000 })
    // 真实入口:点旧原件自己的「整理与图谱」进嵌套图谱
    await page.click('#workbench-root button:has-text("整理与图谱")')
    await page.waitForSelector('#workbench-root iframe[title="项目图谱"]', { timeout: 15000 })

    const measure = () => page.evaluate(() => {
      const root = document.getElementById('workbench-root')
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }
      return {
        mod: box(root.querySelector('.ben-wb__mod[data-module-box="files"]')),
        advanced: box(root.querySelector('.cf-advanced')),
        graph: box(root.querySelector('.ben-wb__graph')),
        iframe: box(root.querySelector('iframe[title="项目图谱"]')),
        note: box(root.querySelector('.ben-wb__graph-note')),
      }
    })
    const noAncestorClipping = () => page.evaluate(() => {
      const root = document.getElementById('workbench-root')
      const mod = root.querySelector('.ben-wb__mod[data-module-box="files"]')
      if (!mod) return { ok: false, reason: 'no mod' }
      const mr = mod.getBoundingClientRect()
      const innerBottom = mr.bottom - 12
      const report = {}
      let ok = true
      for (const [name, el] of [['iframe', root.querySelector('iframe[title="项目图谱"]')], ['note', root.querySelector('.ben-wb__graph-note')]]) {
        if (!el) { report[name] = 'missing'; ok = false; continue }
        const r = el.getBoundingClientRect()
        const visible = r.height > 0 && r.bottom <= innerBottom + 1 && r.top >= mr.top - 1
        report[name] = { h: Math.round(r.height * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, innerBottom: Math.round(innerBottom * 10) / 10, visible }
        if (!visible) ok = false
      }
      return { ok, modH: Math.round(mr.height * 10) / 10, report }
    })

    // S1 初始(常规高度起步)
    const s1 = await measure()
    measurements.initial = s1
    log('S1', `初始 ${JSON.stringify(s1)}`)
    await page.screenshot({ path: shot('01-初始') })
    checks.oldWidgetMounted = s1.iframe !== null && s1.advanced !== null

    // S2 既有把手向下拖 +240(向下=图变高)
    const hb1 = await page.locator('#workbench-root .ben-wb__mod-handle').boundingBox()
    await page.mouse.move(hb1.x + hb1.width / 2, hb1.y + hb1.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb1.x + hb1.width / 2, hb1.y + hb1.height / 2 + 240, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const s2 = await measure()
    const clip2 = await noAncestorClipping()
    measurements.draggedUp = { rects: s2, clipping: clip2 }
    log('S2', `向下拖后 ${JSON.stringify(s2)} 裁切=${JSON.stringify(clip2)}`)
    await page.screenshot({ path: shot('02-向下拖后') })
    checks.dragDownGrows = (s2.iframe.h - s1.iframe.h) >= 60 && (s2.mod.h - s1.mod.h) >= 100

    // S3 向上拖 -120(缩回)
    const hb2 = await page.locator('#workbench-root .ben-wb__mod-handle').boundingBox()
    await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2 - 120, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const s3 = await measure()
    measurements.draggedDown = s3
    log('S3', `向上拖后 ${JSON.stringify(s3)}`)
    checks.dragUpShrinks = s3.iframe.h < s2.iframe.h

    // S4 拖到最矮:验地板与图注/图体祖先几何(旧原件自己的 min-height:180px 在此见真章)
    const hb3 = await page.locator('#workbench-root .ben-wb__mod-handle').boundingBox()
    await page.mouse.move(hb3.x + hb3.width / 2, hb3.y + hb3.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb3.x + hb3.width / 2, hb3.y + hb3.height / 2 - 500, { steps: 15 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const s4 = await measure()
    const clip4 = await noAncestorClipping()
    measurements.minSize = { rects: s4, clipping: clip4 }
    log('S4', `最矮 ${JSON.stringify(s4)} 裁切=${JSON.stringify(clip4)}`)
    await page.screenshot({ path: shot('04-最矮') })
    // 图区基本可读门槛:最矮处 iframe 也不得塌成细条(2px 那种不算可读)
    checks.minIframeReadable = typeof s4.iframe.h === 'number' && s4.iframe.h >= 30

    // S5 从最矮拖回 +210,切项目 DouDou,高度不回退
    const hb4 = await page.locator('#workbench-root .ben-wb__mod-handle').boundingBox()
    await page.mouse.move(hb4.x + hb4.width / 2, hb4.y + hb4.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb4.x + hb4.width / 2, hb4.y + hb4.height / 2 + 210, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    await page.selectOption('#workbench-root select[aria-label="图谱项目"]', 'doudou')
    await page.waitForTimeout(1200)
    const s5 = await measure()
    measurements.doudou = s5
    log('S5', `DouDou ${JSON.stringify(s5)}`)
    checks.projectSwitch = s5.iframe !== null && s5.iframe.h > 0

    // S6 展开全屏 → 返回
    await page.click('#workbench-root button[aria-label="展开查看图谱"]')
    await page.waitForSelector('.ben-wb__graph-modal', { timeout: 3000 })
    await page.screenshot({ path: shot('06-全屏') })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    checks.fullscreenReturn = (await page.$('.ben-wb__graph-modal')) === null

    // 原件只读核验:hash 前后一致
    const hashAfter = { index: sha256(widgetEntry), style: fs.existsSync(widgetStyle) ? sha256(widgetStyle) : null }
    checks.originalUntouched = hashAfter.index === hashBefore.index && hashAfter.style === hashBefore.style
    measurements.hashes = { before: hashBefore, after: hashAfter }
    log('hash', `前后一致=${checks.originalUntouched}`)

    const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k)
    const receipt = {
      timestamp: new Date().toISOString(),
      commit: HEAD_COMMIT,
      widget: { dir: WIDGET_DIR, entryBytes: fs.statSync(widgetEntry).size, sha256: hashBefore, styleSha256: hashBefore.style },
      environment: { isolatedHome: tempHome, ports: [REAL_SERVER_PORT, PAGE_PORT], maintainerHomeWritten: false },
      whatIsReal: ['旧用户层 files 小组件原件(只读,前后 hash 一致)', 'evaluateWidget 同一白名单加载口', 'style.css 按产品契约同序注入', '真 startWorkbenchServer + 隔离 HOME', '既有把手真实 pointer 拖拽'],
      measurements, checks,
      // 最矮态裁切如实记录(不判死):旧原件 cf-advanced 自有 min-height:180px 与高度链的
      // 真实关系留给统筹判读;红了不修原件。
      minSizeClipping: clip4,
    }
    fs.writeFileSync(path.join(EVIDENCE_DIR, '旧用户层原件-最终收据.json'), JSON.stringify(receipt, null, 2))
    if (failed.length > 0) throw new Error(`有未过检查:${failed.join(', ')}`)
    log('done', '旧原件冒烟全部通过。')
  } finally {
    await browser.close()
    pageServer.close()
    await server.close()
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
}

main().catch((err) => { console.error('旧原件冒烟失败:', err); process.exit(1) })
