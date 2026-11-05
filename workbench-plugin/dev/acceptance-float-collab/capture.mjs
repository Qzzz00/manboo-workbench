// 浮窗两态与协作区五项改动的验收截图脚本。
//
// 用法:
//   1. npx vite build            # 在本目录先构建看样台(dist/ 是现算物,git 不跟踪)
//   2. node capture.mjs          # 截 8 张,写进 <仓库>/docs/交接-1022-浮窗两态与头像面板遮挡/
//
// 为什么不直接用 `chrome --screenshot --virtual-time-budget`:事务官那颗粒子球
// (Orb)是 requestAnimationFrame 常驻动画,--virtual-time-budget 与 rAF 循环组合
// 会让 Chrome 永不退出(2026-10-22 实测卡死 150s+)。这里改成 CDP 驱动:等 load
// 事件再补一段真实时间让 React 渲染与看样台的 setTimeout(50ms) 弹层跑完,然后
// Page.captureScreenshot。任何一步超过预算都会杀掉 Chrome 并以非零退出,不会卡死。
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import { resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..', '..')
const outDir = resolve(root, 'docs', '交接-1022-浮窗两态与头像面板遮挡')
const distDir = resolve(here, 'dist')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const iconDir = resolve(root, 'docs', 'assets', 'global-ui-review-2026-10-21', 'live', 'agent-icons')

// 硬预算:整个脚本最多跑 60 秒,到点杀 Chrome、非零退出
const OVERALL_TIMEOUT_MS = 60_000
// 单张截图的 Chrome 存活预算(启动 + 导航 + 渲染等待)
const PER_SHOT_TIMEOUT_MS = 15_000
// load 事件之后再等多久截图:覆盖 React 首绘与看样台里 50ms 的弹层定时器
const SETTLE_MS = 800

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

const scenarios = [
  { name: '01-浮窗球态-96px.png', query: 'scenario=01-butler-ball', width: 1200, height: 800 },
  { name: '01-浮窗球态-叫停入口.png', query: 'scenario=01-butler-ball&popover=1', width: 1200, height: 800 },
  { name: '01-浮窗展开态-520x680.png', query: 'scenario=01-butler-expanded', width: 1200, height: 800 },
  { name: '02-换头像面板打开-名片浮列收起.png', query: 'scenario=02-dialog-open', width: 1200, height: 800 },
  { name: '02-换头像面板关闭-名片浮列恢复.png', query: 'scenario=02-dialog-closed', width: 1200, height: 800 },
  { name: '03-卡面负责人芯片-各家Logo.png', query: 'scenario=03-agent-chips', width: 1400, height: 850 },
  { name: '04-画布便签标题超长-不重叠.png', query: 'scenario=04-note-wrap', width: 1400, height: 850 },
  { name: '05-周五目标恢复-独立画框.png', query: 'scenario=05-friday-goal', width: 1400, height: 850 },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 静态服务器(看样台 dist + 各家 logo)────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:4201')
  if (url.pathname.startsWith('/agents/icon/')) {
    const iconPath = resolve(iconDir, `${decodeURIComponent(url.pathname.slice('/agents/icon/'.length))}.png`)
    if (fs.existsSync(iconPath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return fs.createReadStream(iconPath).pipe(res)
    }
  }
  let filePath = resolve(distDir, url.pathname.slice(1) || 'index.html')
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = resolve(filePath, 'index.html')
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' })
    return fs.createReadStream(filePath).pipe(res)
  }
  res.writeHead(404)
  res.end('Not Found')
})

// ── 60 秒总看门狗:任何情况下都不许把这个脚本留着卡死 ───────────────
let chromeProc = null
let finished = false
const watchdog = setTimeout(() => {
  if (finished) return
  console.error(`总超时 ${OVERALL_TIMEOUT_MS / 1000}s:强制杀掉 Chrome 并以非零退出`)
  killChrome()
  process.exit(1)
}, OVERALL_TIMEOUT_MS)

function killChrome() {
  if (chromeProc !== null) {
    try { chromeProc.kill('SIGKILL') } catch { /* 已经没了 */ }
    chromeProc = null
  }
}

// ── CDP 最小客户端:只发命令、收结果,不带事件订阅 ──────────────────
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  ws.onmessage = event => {
    const msg = JSON.parse(String(event.data))
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: ok, reject: bad } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error !== undefined) bad(new Error(msg.error.message ?? 'CDP error'))
      else ok(msg.result)
    }
  }
  const ready = new Promise((ok, bad) => {
    ws.onopen = () => ok()
    ws.onerror = err => bad(new Error(`CDP 连接失败:${String(err)}`))
  })
  const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
    const id = ++seq
    pending.set(id, { resolve: ok, reject: bad })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const close = () => { try { ws.close() } catch { /* 无所谓 */ } }
  return { ready, send, close }
}

async function waitForDevtoolsPort(port) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch { /* 还没起 */ }
    await sleep(100)
  }
  throw new Error('Chrome DevTools 端口一直没就绪')
}

async function shootOne(port, sc) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const client = cdp(target.webSocketDebuggerUrl)
  try {
    await client.ready
    await client.send('Page.enable')
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: sc.width, height: sc.height, deviceScaleFactor: 2, mobile: false,
    })
    // load 事件之后留 SETTLE_MS:覆盖 React 首绘与看样台里 50ms 的弹层定时器
    await client.send('Page.navigate', { url: `http://127.0.0.1:4201/?${sc.query}` })
    await sleep(SETTLE_MS)
    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    const outFile = resolve(outDir, sc.name)
    fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'))
    console.log(`Saved ${outFile}`)
  } finally {
    client.close()
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {})
  }
}

try {
  if (!fs.existsSync(resolve(distDir, 'index.html'))) {
    console.error('缺 dist/:先在本目录跑 npx vite build')
    process.exit(1)
  }
  fs.mkdirSync(outDir, { recursive: true })
  await new Promise(r => server.listen(4201, '127.0.0.1', r))
  console.log('Static server listening on http://127.0.0.1:4201')

  const port = 4300 + Math.floor(Math.random() * 500)
  chromeProc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    'about:blank',
  ], { stdio: 'ignore' })
  chromeProc.on('exit', () => { chromeProc = null })

  await waitForDevtoolsPort(port)

  for (const sc of scenarios) {
    const timer = setTimeout(() => {
      console.error(`单张超时 ${PER_SHOT_TIMEOUT_MS / 1000}s:${sc.name}`)
      killChrome()
      process.exit(1)
    }, PER_SHOT_TIMEOUT_MS)
    console.log(`Shooting ${sc.name}...`)
    try {
      await shootOne(port, sc)
    } finally {
      clearTimeout(timer)
    }
    if (chromeProc === null) throw new Error('Chrome 中途退出了')
  }

  finished = true
  clearTimeout(watchdog)
  killChrome()
  console.log('All screenshots captured successfully!')
  process.exit(0)
} catch (err) {
  finished = true
  clearTimeout(watchdog)
  killChrome()
  console.error(`截图失败:${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
} finally {
  server.close()
}
