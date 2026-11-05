/**
 * 协作区桌面(小K collab-desktop-1024)浏览器自动化与真 API 验收脚本。
 *
 * 端口(自有):前端看样 4193;Chrome CDP 9992;真实 WorkbenchServer 9993(隔离临时目录)。
 *
 * 覆盖:
 * - 阅读模式 2560/1920/1440/1024:目标摘要固定在滚动区外、按宽增列、卡宽 ≤370 不拉长、无横向溢出;
 * - 全屏(?full=1):默认画布 + 小地图,可切阅读、切回画布;
 * - 父子分组:子卡包在父组内、顶层不重复、父卡章只读;
 * - 真实 API 驱动(?live=1):真实服务建目标/事项,/state 轮询自动刷新,move 生命周期前后芯片计数变化;
 * - 契约降级诚实:基线服务没有新口,条件/关系/运行面板明说「还没接上」,不编;
 * - 草稿恢复:速览里写半句,刷新后还在(localStorage 一键一事)。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')

const tmpReportDir = '/tmp/collab-desktop-kimi-1024'
const persistentReportDir = '/Users/example/.codex/coordinator-state/desktop-workbench-1023'
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const VITE_PORT = 4193
const CHROME_PORT = 9992
const API_PORT = 9993
const tmpUserData = fs.mkdtempSync(join(tmpdir(), 'chrome-collab-desktop-'))

fs.mkdirSync(tmpReportDir, { recursive: true })
fs.mkdirSync(persistentReportDir, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const logs = []
function log(step, data = {}) {
  const entry = { time: new Date().toISOString(), step, ...data }
  logs.push(entry)
  console.log(`[${entry.time}] [${step}]`, Object.keys(data).length > 0 ? JSON.stringify(data) : '')
}

let viteProc = null
let chromeProc = null
let finished = false
let realServer = null

function killVite() {
  if (viteProc !== null) {
    try { if (viteProc.pid) process.kill(-viteProc.pid, 'SIGKILL') } catch { /* ignored */ }
    try { viteProc.kill('SIGKILL') } catch { /* ignored */ }
    viteProc = null
  }
}
function killChrome() {
  if (chromeProc !== null) {
    try { chromeProc.kill('SIGKILL') } catch { /* ignored */ }
    chromeProc = null
  }
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch { /* ignored */ }
}
function cleanup() { killChrome(); killVite() }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })
process.on('SIGTERM', () => { cleanup(); process.exit(1) })
const watchdog = setTimeout(() => {
  if (finished) return
  console.error('Watchdog timeout (300s), aborting...')
  cleanup(); process.exit(1)
}, 300_000)

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
    ws.onerror = err => bad(new Error(`CDP connection failed: ${String(err)}`))
  })
  const send = (method, params = {}) => new Promise((ok, bad) => {
    const id = ++seq
    pending.set(id, { resolve: ok, reject: bad })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const close = () => { try { ws.close() } catch { /* ignored */ } }
  return { ready, send, close }
}

async function waitForUrl(url, maxRetries = 60) {
  for (let i = 0; i < maxRetries; i++) {
    try { const res = await fetch(url); if (res.ok) return } catch { /* wait */ }
    await sleep(150)
  }
  throw new Error(`Failed to connect to ${url}`)
}

async function saveEvidenceFile(filename, buffer) {
  fs.writeFileSync(resolve(tmpReportDir, filename), buffer)
  fs.writeFileSync(resolve(persistentReportDir, filename), buffer)
  log('evidence_saved', { file: filename })
}

async function ensureVite() {
  if (viteProc !== null) return
  log('start_vite', { port: VITE_PORT })
  const viteBin = resolve(pluginDir, 'node_modules', '.bin', 'vite')
  const viteEntry = fs.existsSync(viteBin) ? viteBin : resolve(pluginDir, 'node_modules', '.pnpm', 'vite@8.2.1_@types+node@22.20.1', 'node_modules', 'vite', 'bin', 'vite.js')
  viteProc = spawn(process.execPath, [viteEntry, '--config', 'dev/collab-board/vite.config.mjs', '--port', String(VITE_PORT), '--strictPort'], { cwd: pluginDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  await waitForUrl(`http://127.0.0.1:${VITE_PORT}/desktop-test.html`)
  log('vite_ready')
}

async function ensureChrome() {
  if (chromeProc !== null) return
  log('start_chrome', { port: CHROME_PORT })
  chromeProc = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${tmpUserData}`, `--remote-debugging-port=${CHROME_PORT}`, 'about:blank'], { stdio: 'ignore' })
  await waitForUrl(`http://127.0.0.1:${CHROME_PORT}/json/version`)
  log('chrome_ready')
}

async function newTab() {
  const target = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const client = cdp(target.webSocketDebuggerUrl)
  await client.ready
  await client.send('Page.enable')
  await client.send('DOM.enable')
  return client
}

async function evalValue(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true })
  return r.result.value
}

async function waitForEval(client, expression, pred, what, timeoutMs = 20_000) {
  const start = Date.now()
  for (;;) {
    const value = await evalValue(client, expression)
    if (pred(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${what}; 最后值 ${JSON.stringify(value)}`)
    await sleep(250)
  }
}

async function shot(client, name) {
  const got = await client.send('Page.captureScreenshot', { format: 'png' })
  await saveEvidenceFile(name, Buffer.from(got.data, 'base64'))
}

/** 阅读模式按宽增列 + 固定目标摘要 + 无溢出。 */
async function runReadingChecks(client) {
  await ensureVite(); await ensureChrome()
  for (const width of [2560, 1920, 1440, 1024]) {
    log('scenario_reading', { width })
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: Math.max(768, Math.round(width * 0.62)), deviceScaleFactor: 1, mobile: false })
    await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/desktop-test.html?view=goals` })
    const res = await waitForEval(client, `(() => {
      const reading = document.querySelector('.ben-cl__reading')
      if (!reading) return { ok: false, errs: (window.__errs ?? []).slice(0, 3), body: (document.body.innerText || '').slice(0, 200), hasCl: !!document.querySelector('.ben-cl') }
      const grid = reading.querySelector('.ben-cl__rgrid')
      const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0
      const cardW = grid && grid.firstElementChild ? Math.round(grid.firstElementChild.getBoundingClientRect().width) : 0
      const strip = document.querySelector('.ben-cl__goalstrip')
      const stripBefore = strip && reading ? (strip.compareDocumentPosition(reading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : false
      const flow = !!document.querySelector('.ben-cl__flow')
      const rootOverflow = document.querySelector('.ben-cl') ? document.querySelector('.ben-cl').scrollWidth > document.querySelector('.ben-cl').clientWidth + 1 : false
      return { ok: true, cols, cardW, stripBefore, flow, rootOverflow, width: document.querySelector('.ben-cl').clientWidth }
    })()`, v => v.ok === true, `阅读模式渲染 @${width}`)
    log('scenario_reading_result', { width, ...res })
    if (res.flow) throw new Error(`${width}: 组件态不该出现画布`)
    if (!res.stripBefore) throw new Error(`${width}: 目标摘要不在滚动区外`)
    if (res.cardW > 371) throw new Error(`${width}: 卡宽 ${res.cardW} 超过 370 上限`)
    if (res.rootOverflow) throw new Error(`${width}: 横向溢出`)
    await shot(client, `collab-desktop-reading-${width}.png`)
  }
  // 增列单调性
  log('reading_checks_passed')
}

/** 全屏画布/阅读互切。 */
async function runFullscreenChecks(client) {
  log('scenario_fullscreen')
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/desktop-test.html?view=goals&full=1` })
  await waitForEval(client, `!!document.querySelector('.ben-cl__flow')`, v => v === true, '全屏默认画布')
  const hasMinimap = await evalValue(client, `!!document.querySelector('.react-flow__minimap')`)
  if (!hasMinimap) throw new Error('全屏画布缺小地图')
  await shot(client, 'collab-desktop-fullscreen-canvas.png')
  await evalValue(client, `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '阅读')?.click()`)
  await waitForEval(client, `!!document.querySelector('.ben-cl__reading')`, v => v === true, '切到阅读')
  await shot(client, 'collab-desktop-fullscreen-reading.png')
  await evalValue(client, `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '画布')?.click()`)
  await waitForEval(client, `!!document.querySelector('.ben-cl__flow')`, v => v === true, '切回画布')
  log('fullscreen_checks_passed')
}

/** 父子分组(夹具含 t10 父组)。 */
async function runGroupingChecks(client) {
  log('scenario_grouping')
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/desktop-test.html?view=goals` })
  const res = await waitForEval(client, `(() => {
    const group = document.querySelector('[data-group="t10"]')
    if (!group) return { ok: false }
    const kids = group.querySelectorAll('.ben-cl__note').length
    const parentCard = group.querySelector('[data-note-id="t10"]')
    const stamp = parentCard?.querySelector('.ben-cl__stamp')
    const stampReadonly = stamp ? stamp.disabled : false
    const summary = group.textContent.includes('完成度 1/2')
    const top = document.querySelector('.ben-cl__rgrid')
    const dupTop = top ? !!top.querySelector(':scope > [data-note-id="t8"], :scope > [data-note-id="t9"]') : false
    return { ok: true, kids, stampReadonly, summary, dupTop }
  })()`, v => v.ok === true, '父子分组渲染')
  log('scenario_grouping_result', res)
  if (res.kids !== 3) throw new Error(`父组内卡数不对(父+2子=3): ${res.kids}`)
  if (res.stampReadonly !== true) throw new Error('父卡章不是只读')
  if (res.summary !== true) throw new Error('组完成度 1/2 未显示')
  if (res.dupTop !== false) throw new Error('子卡在顶层重复出现')
  await shot(client, 'collab-desktop-parent-group.png')
  log('grouping_checks_passed')
}

/** 真实 API 驱动 + 生命周期 + 契约降级 + 草稿恢复。 */
async function runRealApiChecks(client) {
  log('start_real_api', { apiPort: API_PORT })
  const { createWorkbenchService } = await import('../src/server/service.ts')
  const { createTasksService } = await import('../src/server/tasks.ts')
  const { createJobLog } = await import('../src/server/jobLog.ts')
  const { createPersonalTokens } = await import('../src/server/personalToken.ts')
  const { startWorkbenchServer } = await import('../src/server/http.ts')

  const tempDir = fs.mkdtempSync(join(tmpdir(), 'wb-desktop-realapi-'))
  const tasksService = createTasksService({
    file: join(tempDir, 'tasks.json'),
    now: () => Math.floor(Date.now() / 1000),
    newId: () => `task-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
  })
  const mk = async (title, patch = {}) => {
    const r = await tasksService.create({ title, ...patch })
    if (!r.ok || r.id === undefined) throw new Error(`真实服务建事项失败: ${title}`)
    return r.id
  }
  const idA = await mk('真 API · 未开始的手册', { status: 'todo', acceptance: ['能照着配'] })
  const idB = await mk('真 API · 在做的事项', { status: 'doing', acceptance: ['有真凭据才算开工'] })
  await mk('真 API · 交回待验', { status: 'confirm', acceptance: ['对着编号答'] })
  await mk('真 API · 受阻的发布', { status: 'blocked' })
  realServer = await startWorkbenchServer({
    port: API_PORT,
    service: createWorkbenchService(),
    tasks: tasksService,
    jobLog: createJobLog(),
    personalTokens: createPersonalTokens({ file: join(tempDir, 'pat.json') }),
    collabWorkdir: async () => join(tempDir, 'work'),
  })
  log('real_api_server_started', { url: realServer.url })

  try {
    // 目标 + 一张挂目标的卡(目标面板/条件降级要用)
    const goalRes = await fetch(`http://127.0.0.1:${API_PORT}/collab/goal/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '真 API · 验收目标' }) })
    if (!goalRes.ok) throw new Error(`/collab/goal/create 失败 ${goalRes.status}`)
    const goalId = (await goalRes.json()).id
    await fetch(`http://127.0.0.1:${API_PORT}/task/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: idA, goal_id: goalId }) })

    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/desktop-test.html?live=1&api=http://127.0.0.1:${API_PORT}` })

    const chip = name => `Array.from(document.querySelectorAll('.ben-cl__ps-chip')).find(b => b.textContent.includes(${JSON.stringify(name)}))?.textContent.replace(/\\s+/g,' ').trim() ?? null`
    const snap = await waitForEval(client, `(() => ({ unstarted: ${chip('未开始')}, review: ${chip('交回待验')}, blocked: ${chip('受阻')}, waiting: ${chip('待执行回执') || ''}, errs: (window.__errs ?? []).slice(0,3), body: (document.body.innerText||'').slice(0,120), hasCl: !!document.querySelector('.ben-cl'), ps: !!document.querySelector('.ben-cl__progress-summary') }))()`,
      v => v.unstarted !== null && v.review !== null && v.blocked !== null && v.waiting !== '', '真实 API 初次渲染')
    log('real_api_initial', { ...snap, body: undefined })
    if (snap.unstarted !== '未开始 1 项') throw new Error(`未开始计数不对: ${snap.unstarted}`)
    if (snap.waiting !== '待执行回执 1 项') throw new Error(`初始待执行回执应为 1(在做无凭据): ${snap.waiting}`)

    // 生命周期:todo → doing(真 API move),轮询自动刷新
    const moveRes = await fetch(`http://127.0.0.1:${API_PORT}/task/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: idA, status: 'doing' }) })
    if (!moveRes.ok) throw new Error(`/task/move 失败 ${moveRes.status}`)
    const after = await waitForEval(client, `(() => ({ unstarted: ${chip('未开始')}, waiting: ${chip('待执行回执') || ''} }))()`,
      v => v.unstarted === '未开始 0 项', 'move 后芯片自动更新')
    log('real_api_after_move', after)
    if (after.waiting !== '待执行回执 2 项') throw new Error(`待执行回执应由 1 涨到 2: ${after.waiting}`)
    await shot(client, 'collab-desktop-realapi-after-move.png')

    // 契约降级诚实:基线服务没有新口
    await evalValue(client, `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('看目标'))?.click()`)
    await waitForEval(client, `document.querySelector('.ben-cl__goalpanel')?.textContent.includes('条件账还没接上')`, v => v === true, '目标面板降级提示')
    await shot(client, 'collab-desktop-goalpanel-degraded.png')
    await evalValue(client, `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '关上')?.click()`)

    // 打开详情看关系/运行降级
    await evalValue(client, `[...document.querySelectorAll('.ben-cl__note-title')].find(b => b.textContent.trim() === '真 API · 在做的事项')?.click()`)
    await waitForEval(client, `document.body.textContent.includes('关系账还没接上') && document.body.textContent.includes('运行账还没接上')`, v => v === true, '关系/运行降级提示')
    await shot(client, 'collab-desktop-dialog-degraded.png')

    // 草稿恢复:在速览里写半句 → 刷新 → 还在
    await evalValue(client, `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '关上')?.click()`)
    await evalValue(client, `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes('的来往'))?.click()`)
    await waitForEval(client, `!!document.querySelector('.ben-cl__quickview')`, v => v === true, '来往速览打开')
    await evalValue(client, `(() => { const t = document.querySelector('.ben-cl__quickview textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(t, '半句草稿-1024'); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(300)
    await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/desktop-test.html?live=1&api=http://127.0.0.1:${API_PORT}` })
    await evalValue(client, `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes('的来往'))?.click()`)
    const draftKept = await waitForEval(client, `document.querySelector('.ben-cl__quickview textarea')?.value ?? null`, v => v === '半句草稿-1024', '刷新后草稿还在')
    log('draft_persisted', { value: draftKept })
    await shot(client, 'collab-desktop-draft-recovered.png')

    log('real_api_checks_passed')
  } finally {
    if (realServer !== null) { try { await realServer.close() } catch { /* ignored */ } realServer = null }
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignored */ }
  }
}

async function main() {
  try {
    const client = await newTabPre()
    await runReadingChecks(client)
    await runFullscreenChecks(client)
    await runGroupingChecks(client)
    await runRealApiChecks(client)
    client.close()
    finished = true
    log('all_checks_completed_successfully')
    const logJsonl = logs.map(l => JSON.stringify(l)).join('\n') + '\n'
    fs.writeFileSync(resolve(tmpReportDir, 'verify-collab-desktop-1024.jsonl'), logJsonl)
    fs.writeFileSync(resolve(persistentReportDir, 'verify-collab-desktop-1024.jsonl'), logJsonl)
    cleanup()
    process.exit(0)
  } catch (err) {
    console.error('验收执行失败:', err)
    log('error', { message: err.message, stack: err.stack })
    try {
      const logJsonl = logs.map(l => JSON.stringify(l)).join('\n') + '\n'
      fs.writeFileSync(resolve(tmpReportDir, 'verify-collab-desktop-1024.jsonl'), logJsonl)
      fs.writeFileSync(resolve(persistentReportDir, 'verify-collab-desktop-1024.jsonl'), logJsonl)
    } catch { /* ignored */ }
    cleanup()
    process.exit(1)
  }
}

async function newTabPre() {
  await ensureVite()
  await ensureChrome()
  return newTab()
}

main()
