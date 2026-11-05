import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..', '..')
// 默认输出至当前工作树的 docs/验收-事务官页接线与浮窗-2026-10-23
// 若显式指定 EVIDENCE_OUT_DIR 环境变量则同步写入, 杜绝向 root 目录硬编码写入
const targetDir1 = process.env.EVIDENCE_DIR ? resolve(process.env.EVIDENCE_DIR) : resolve(root, 'docs', '验收-事务官页接线与浮窗-2026-10-23')
const targetDir2 = process.env.EVIDENCE_OUT_DIR ? resolve(process.env.EVIDENCE_OUT_DIR) : null
const distDir = resolve(here, 'dist')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const iconDir = resolve(root, 'docs', 'assets', 'global-ui-review-2026-10-21', 'live', 'agent-icons')

const OVERALL_TIMEOUT_MS = 60_000
const PER_SHOT_TIMEOUT_MS = 15_000
const SETTLE_MS = 1200
const DEVTOOLS_PORT = 9398
const SERVER_PORT = 3593

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

const scenarios = [
  { name: '01-narrow-520x680-idle.png', query: 'scenario=01-narrow-520x680-idle', width: 520, height: 680, desc: '520x680浮窗安静态,粒子球正常运转' },
  { name: '02-narrow-520x680-asks-glowing.png', query: 'scenario=02-narrow-520x680-asks-glowing', width: 520, height: 680, desc: '520x680待办询问走光(FxBeam),输入框在下方不遮挡待办行' },
  { name: '03-narrow-520x680-typing-glowing.png', query: 'scenario=03-narrow-520x680-typing-glowing', width: 520, height: 680, desc: '520x680输入框草稿输入态(Composer走光),上方舞台收缩且不遮挡' },
  { name: '04-narrow-520x680-multicards-scroll.png', query: 'scenario=04-narrow-520x680-multicards-scroll', width: 520, height: 680, desc: '520x680多会话与多事项,下方独立纵向滚动,输入框保持钉底' },
  { name: '05-narrow-520x680-drawer-open.png', query: 'scenario=05-narrow-520x680-drawer-open', width: 520, height: 680, desc: '520x680抽屉展开,暂停/试铃/外观设置等交互控件全部可达' },
  { name: '06-fullscreen-1475x812.png', query: 'scenario=06-fullscreen-1475x812', width: 1475, height: 812, desc: '1475x812大屏全景,宽视口自适应完整展示' },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${SERVER_PORT}`)
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
    try { chromeProc.kill('SIGKILL') } catch { /* ignore */ }
    chromeProc = null
  }
}

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
  const close = () => { try { ws.close() } catch { /* ignore */ } }
  return { ready, send, close }
}

async function waitForDevtoolsPort(port) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch { /* wait */ }
    await sleep(100)
  }
  throw new Error('Chrome DevTools 端口一直没就绪')
}

const EVAL_SCRIPT = `(() => {
  const rect = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const butler = document.querySelector('.ben-wb__butler');
  const stage = document.querySelector('.ben-wb__scene-top');
  const sceneBelow = document.querySelector('.ben-wb__scene-below');
  const composerSlot = document.querySelector('.ben-wb__composer-slot');
  const askRow = document.querySelector('.ben-wb__askrow--summary') || document.querySelector('.ben-wb__ask') || document.querySelector('.ben-wb__askrow');
  const askBeam = document.querySelector('[data-fx="ask"]');
  const composerBeam = document.querySelector('[data-fx="composer"]');
  const drawer = document.querySelector('.ben-wb__drawer');
  const pauseBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && (b.textContent.includes('全部暂停') || b.textContent.includes('恢复')));
  const ringBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && (b.textContent.includes('试铃') || b.textContent.includes('停铃')));
  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('外观设置'));
  const textarea = document.querySelector('.wb-cmp__input');
  const submitBtn = document.querySelector('.wb-cmp__send');

  const composerRect = rect(composerSlot);
  const askRect = rect(askRow);
  const stageRect = rect(stage);
  const sceneBelowRect = rect(sceneBelow);

  const askActive = askBeam ? (askBeam.getAttribute('data-fx-active') === 'true' || askBeam.dataset.fxActive === 'true') : false;
  const composerActive = composerBeam ? (composerBeam.getAttribute('data-fx-active') === 'true' || composerBeam.dataset.fxActive === 'true') : false;

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    butler: rect(butler),
    stage: stageRect,
    sceneBelow: {
      rect: sceneBelowRect,
      scrollHeight: sceneBelow ? sceneBelow.scrollHeight : 0,
      clientHeight: sceneBelow ? sceneBelow.clientHeight : 0,
    },
    composerSlot: composerRect,
    askRow: askRect,
    glow: {
      askBeamActive: askActive,
      composerBeamActive: composerActive,
    },
    drawer: rect(drawer),
    pauseBtn: rect(pauseBtn),
    ringBtn: rect(ringBtn),
    settingsBtn: rect(settingsBtn),
    textarea: rect(textarea),
    submitBtn: rect(submitBtn),
    hasOcclusion: (composerRect && askRect) ? (composerRect.top < askRect.bottom) : false,
    composerWithinBounds: composerRect ? (composerRect.bottom <= window.innerHeight + 4) : false,
  };
})()`

async function shootOne(port, sc) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const client = cdp(target.webSocketDebuggerUrl)
  try {
    await client.ready
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: sc.width, height: sc.height, deviceScaleFactor: 2, mobile: false,
    })
    await client.send('Page.navigate', { url: `http://127.0.0.1:${SERVER_PORT}/?${sc.query}` })
    await sleep(SETTLE_MS)

    const evalRes = await client.send('Runtime.evaluate', { expression: EVAL_SCRIPT, returnByValue: true })
    const measurements = evalRes.result?.value

    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    const buffer = Buffer.from(shot.data, 'base64')

    const out1 = resolve(targetDir1, sc.name)
    fs.writeFileSync(out1, buffer)
    if (targetDir2 && fs.existsSync(targetDir2)) {
      const out2 = resolve(targetDir2, sc.name)
      fs.writeFileSync(out2, buffer)
    }

    console.log(`Saved screenshot ${sc.name} (${sc.width}x${sc.height})`)
    return { name: sc.name, desc: sc.desc, measurements }
  } finally {
    client.close()
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {})
  }
}

try {
  if (!fs.existsSync(resolve(distDir, 'index.html'))) {
    console.error('缺 dist/: 先在本目录跑 vite build')
    process.exit(1)
  }
  fs.mkdirSync(targetDir1, { recursive: true })
  if (targetDir2 && fs.existsSync(dirname(targetDir2))) {
    fs.mkdirSync(targetDir2, { recursive: true })
  }

  await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r))
  console.log(`Static server listening on http://127.0.0.1:${SERVER_PORT}`)

  chromeProc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${DEVTOOLS_PORT}`,
    'about:blank',
  ], { stdio: 'ignore' })
  chromeProc.on('exit', () => { chromeProc = null })

  await waitForDevtoolsPort(DEVTOOLS_PORT)

  const allMeasurements = []
  for (const sc of scenarios) {
    const timer = setTimeout(() => {
      console.error(`单张超时 ${PER_SHOT_TIMEOUT_MS / 1000}s: ${sc.name}`)
      killChrome()
      process.exit(1)
    }, PER_SHOT_TIMEOUT_MS)
    console.log(`Shooting ${sc.name}...`)
    try {
      const res = await shootOne(DEVTOOLS_PORT, sc)
      allMeasurements.push(res)
    } finally {
      clearTimeout(timer)
    }
    if (chromeProc === null) throw new Error('Chrome 中途退出了')
  }

  // 计算 SHA-256 并生成收据
  const receipts = []
  for (const sc of scenarios) {
    const filePath = resolve(targetDir1, sc.name)
    const data = fs.readFileSync(filePath)
    const hash = crypto.createHash('sha256').update(data).digest('hex')
    receipts.push({ file: sc.name, sha256: hash, desc: sc.desc })
  }

  // 保持与现有截图收据合并 (如果存在原先的历史截图)
  let existingReceipts = []
  const oldReceiptPath = resolve(targetDir1, '截图收据.json')
  const rootOldReceiptPath = targetDir2 ? resolve(targetDir2, '截图收据.json') : null
  const readPath = (rootOldReceiptPath && fs.existsSync(rootOldReceiptPath)) ? rootOldReceiptPath : (fs.existsSync(oldReceiptPath) ? oldReceiptPath : null)
  if (readPath) {
    try {
      existingReceipts = JSON.parse(fs.readFileSync(readPath, 'utf8'))
    } catch { /* ignore */ }
  }

  const mergedReceipts = [...existingReceipts.filter(r => !receipts.some(n => n.file === r.file)), ...receipts]

  const receiptJson = JSON.stringify(mergedReceipts, null, 2)
  fs.writeFileSync(resolve(targetDir1, '截图收据.json'), receiptJson)
  if (targetDir2 && fs.existsSync(targetDir2)) {
    fs.writeFileSync(resolve(targetDir2, '截图收据.json'), receiptJson)
  }

  const measureJson = JSON.stringify(allMeasurements, null, 2)
  fs.writeFileSync(resolve(targetDir1, 'DOM-measurements.json'), measureJson)
  if (targetDir2 && fs.existsSync(targetDir2)) {
    fs.writeFileSync(resolve(targetDir2, 'DOM-measurements.json'), measureJson)
  }

  console.log('DOM measurements & screenshots successfully saved!')
  finished = true
  clearTimeout(watchdog)
  killChrome()
  server.close()
  process.exit(0)
} catch (err) {
  finished = true
  clearTimeout(watchdog)
  killChrome()
  server.close()
  console.error(`截图脚本失败: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
