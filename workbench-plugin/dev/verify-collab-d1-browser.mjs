/**
 * 协作 D1 真实进展可读摘要 浏览器自动化与真 API 验收脚本。
 *
 * 端口:
 * - 前端看样与静态服务: 3293 (自有分配)
 * - Chrome 远程调试端口: 9092 (自有 909x)
 * - 真实 WorkbenchServer: 9093 (自有 909x；页面经 CORS 从 3293 直读其 /state)
 *
 * 覆盖场景:
 * - 任务 0 / 多
 * - 真实执行中 vs 待执行回执 vs 回合结束 vs 已交回 vs 已验收 vs 已交付 vs 受阻 vs 取消
 * - 父子任务去重（不重复计算工作量）
 * - 演示数据隔离（demo 不进入生产账）
 * - 验收条件清单（未声明标明尚未安排；已取消事项不混成尚未安排噪音）
 * - 陈旧快照检测
 * - 1440 与 1024 桌面尺寸，无横向溢出
 * - 真实 API 驱动 UI：同一真实 WorkbenchServer 建/更新事项，/state 实际驱动完整
 *   CollabZone 摘要，轮询自动刷新前后一致，点开计数与清单同范围（夹具模式分层保留）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const rootDir = resolve(pluginDir, '..')

const tmpReportDir = '/tmp/codex-coordinator-1023'
const persistentReportDir = '/Users/example/.codex/coordinator-state/desktop-workbench-1023'
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const VITE_PORT = 3293
const CHROME_PORT = 9092
const API_PORT = 9093
const tmpUserData = fs.mkdtempSync(join(tmpdir(), 'chrome-collab-d1-'))

fs.mkdirSync(tmpReportDir, { recursive: true })
fs.mkdirSync(persistentReportDir, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))

let viteProc = null
let chromeProc = null
let finished = false

const logs = []
function log(step, data = {}) {
  const entry = { time: new Date().toISOString(), step, ...data }
  logs.push(entry)
  console.log(`[${entry.time}] [${step}]`, Object.keys(data).length > 0 ? JSON.stringify(data) : '')
}

function killVite() {
  if (viteProc !== null) {
    try {
      if (viteProc.pid) process.kill(-viteProc.pid, 'SIGKILL')
    } catch { /* ignored */ }
    try {
      viteProc.kill('SIGKILL')
    } catch { /* ignored */ }
    viteProc = null
  }
}

function killChrome() {
  if (chromeProc !== null) {
    try { chromeProc.kill('SIGKILL') } catch { /* ignored */ }
    chromeProc = null
  }
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true })
  } catch { /* ignored */ }
}

function cleanup() {
  killChrome()
  killVite()
}

process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })
process.on('SIGTERM', () => { cleanup(); process.exit(1) })

// 240s 兜底看门狗（含真实 API 驱动场景）
const watchdog = setTimeout(() => {
  if (finished) return
  console.error('Watchdog timeout (240s), aborting...')
  cleanup()
  process.exit(1)
}, 240_000)

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
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* wait */ }
    await sleep(150)
  }
  throw new Error(`Failed to connect to ${url}`)
}

async function saveEvidenceFile(filename, buffer) {
  const p1 = resolve(tmpReportDir, filename)
  const p2 = resolve(persistentReportDir, filename)
  fs.writeFileSync(p1, buffer)
  fs.writeFileSync(p2, buffer)
  log('evidence_saved', { file: filename })
}

async function ensureVite() {
  if (viteProc !== null) return
  log('start_vite', { port: VITE_PORT })
  const viteBin = resolve(pluginDir, 'node_modules', '.bin', 'vite')
  viteProc = spawn(
    viteBin,
    ['--config', 'dev/collab-board/vite.config.mjs', '--port', String(VITE_PORT), '--strictPort'],
    { cwd: pluginDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )

  await waitForUrl(`http://127.0.0.1:${VITE_PORT}/progress-test.html`)
  log('vite_ready', { url: `http://127.0.0.1:${VITE_PORT}/progress-test.html` })
}

async function ensureChrome() {
  if (chromeProc !== null) return
  log('start_chrome', { port: CHROME_PORT })
  chromeProc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${tmpUserData}`,
    `--remote-debugging-port=${CHROME_PORT}`,
    'about:blank',
  ], { stdio: 'ignore' })

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
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时: ${what}; 最后值 ${JSON.stringify(value)}`)
    }
    await sleep(250)
  }
}

async function runBrowserChecks() {
  await ensureVite()
  await ensureChrome()
  const client = await newTab()

  // ─────────────────────────────────────────────────────────────
  // 场景一：多任务全景状态 + 1440 桌面布局
  // ─────────────────────────────────────────────────────────────
  log('scenario_multi_1440')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  })
  await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/progress-test.html?scenario=multi` })
  await sleep(1500)

  const check1 = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const summary = document.querySelector('.ben-cl__progress-summary');
      if (!summary) return { ok: false, error: '未找到 .ben-cl__progress-summary' };

      const scopeTitle = document.querySelector('.ben-cl__ps-scope-title')?.textContent?.trim();
      const dedupTag = document.querySelector('.ben-cl__ps-dedup-tag')?.textContent?.trim();
      const demoTag = document.querySelector('.ben-cl__ps-demo-tag')?.textContent?.trim();

      const chips = Array.from(document.querySelectorAll('.ben-cl__ps-chip')).map(btn => btn.textContent.trim().replace(/\\s+/g, ' '));

      const overflow = summary.scrollWidth > summary.clientWidth + 1;
      const rootOverflow = document.querySelector('.ben-cl')?.scrollWidth > document.querySelector('.ben-cl')?.clientWidth + 1;

      return {
        ok: true,
        scopeTitle,
        dedupTag,
        demoTag,
        chips,
        overflow,
        rootOverflow,
        clientWidth: summary.clientWidth,
        scrollWidth: summary.scrollWidth,
      };
    })()`,
    returnByValue: true,
  })

  const res1 = check1.result.value
  log('scenario_multi_1440_result', res1)
  if (!res1.ok) throw new Error(res1.error)
  if (res1.overflow || res1.rootOverflow) throw new Error(`1440 下检测到横向溢出: summary=${res1.scrollWidth}/${res1.clientWidth}`)

  // 验证去重与隔离
  if (!res1.dedupTag.includes('含 1 个任务组，已去重')) throw new Error('父子去重标签未正确展示')
  if (!res1.demoTag.includes('已隔离 1 件演示数据')) throw new Error('演示数据隔离标签未展示')

  // 点击展开 "真实执行中 1 项"
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const btn = Array.from(document.querySelectorAll('.ben-cl__ps-chip')).find(b => b.textContent.includes('真实执行中'));
      if (btn) btn.click();
    })()`,
  })
  await sleep(400)

  const checkDrawerRunning = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const drawer = document.querySelector('.ben-cl__ps-drawer');
      if (!drawer) return { ok: false, error: '抽屉未展开' };
      const title = drawer.querySelector('.ben-cl__ps-drawer-title')?.textContent?.trim();
      const itemTitle = drawer.querySelector('.ben-cl__ps-item-title')?.textContent?.trim();
      const badge = drawer.querySelector('.ben-cl__ps-badge')?.textContent?.trim();
      return { ok: true, title, itemTitle, badge };
    })()`,
    returnByValue: true,
  })
  log('drawer_running_result', checkDrawerRunning.result.value)
  if (!checkDrawerRunning.result.value.ok) throw new Error(checkDrawerRunning.result.value.error)
  if (!checkDrawerRunning.result.value.itemTitle.includes('真实执行中')) throw new Error('真实执行中清单未正确展示对应任务')

  // 点击展开 "受阻 1 项"
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const btn = Array.from(document.querySelectorAll('.ben-cl__ps-chip')).find(b => b.textContent.includes('受阻'));
      if (btn) btn.click();
    })()`,
  })
  await sleep(400)

  const checkDrawerBlocked = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const drawer = document.querySelector('.ben-cl__ps-drawer');
      const item = drawer?.querySelector('.ben-cl__ps-item');
      const wait = item?.querySelector('.ben-cl__ps-wait')?.textContent?.trim();
      return { ok: !!drawer, wait };
    })()`,
    returnByValue: true,
  })
  log('drawer_blocked_result', checkDrawerBlocked.result.value)
  if (!checkDrawerBlocked.result.value.wait?.includes('等审批')) throw new Error('受阻任务等待原因未正确展示')

  // 点击 "验收条件 8 条"
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const btn = Array.from(document.querySelectorAll('.ben-cl__ps-chip')).find(b => b.textContent.includes('验收条件'));
      if (btn) btn.click();
    })()`,
  })
  await sleep(400)

  const checkDrawerConds = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const condList = document.querySelector('.ben-cl__ps-cond-list');
      const items = Array.from(condList?.querySelectorAll('.ben-cl__ps-cond-item') || []);
      const unassigned = items.some(it => it.textContent.includes('尚未安排'));
      return { ok: items.length > 0, count: items.length, unassigned };
    })()`,
    returnByValue: true,
  })
  log('drawer_conditions_result', checkDrawerConds.result.value)
  if (!checkDrawerConds.result.value.unassigned) throw new Error('未声明条件的事项未标记为尚未安排')

  // 截图 1440
  const shot1440 = await client.send('Page.captureScreenshot', { format: 'png' })
  await saveEvidenceFile('collab-d1-desktop-1440.png', Buffer.from(shot1440.data, 'base64'))

  // ─────────────────────────────────────────────────────────────
  // 场景二：1024 桌面尺寸与无溢出检查
  // ─────────────────────────────────────────────────────────────
  log('scenario_multi_1024')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1024, height: 768, deviceScaleFactor: 2, mobile: false,
  })
  await sleep(600)

  const check1024 = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const summary = document.querySelector('.ben-cl__progress-summary');
      const overflow = summary.scrollWidth > summary.clientWidth + 1;
      const rootOverflow = document.querySelector('.ben-cl')?.scrollWidth > document.querySelector('.ben-cl')?.clientWidth + 1;
      return {
        clientWidth: summary.clientWidth,
        scrollWidth: summary.scrollWidth,
        overflow,
        rootOverflow,
      };
    })()`,
    returnByValue: true,
  })
  log('scenario_multi_1024_result', check1024.result.value)
  if (check1024.result.value.overflow || check1024.result.value.rootOverflow) {
    throw new Error(`1024 下检测到横向溢出: ${check1024.result.value.scrollWidth}/${check1024.result.value.clientWidth}`)
  }

  const shot1024 = await client.send('Page.captureScreenshot', { format: 'png' })
  await saveEvidenceFile('collab-d1-desktop-1024.png', Buffer.from(shot1024.data, 'base64'))

  // ─────────────────────────────────────────────────────────────
  // 场景三：任务 0 (空数据状态)
  // ─────────────────────────────────────────────────────────────
  log('scenario_zero')
  await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/progress-test.html?scenario=zero` })
  await sleep(1000)

  const checkZero = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const remainingBtn = Array.from(document.querySelectorAll('.ben-cl__ps-chip')).find(b => b.textContent.includes('本轮剩余'));
      return {
        remainingText: remainingBtn ? remainingBtn.textContent.replace(/\\s+/g, ' ') : null,
      };
    })()`,
    returnByValue: true,
  })
  log('scenario_zero_result', checkZero.result.value)
  if (checkZero.result.value.remainingText !== '本轮剩余 0 件') throw new Error('空数据状态本轮剩余未能正确显示 0 件')

  const shotZero = await client.send('Page.captureScreenshot', { format: 'png' })
  await saveEvidenceFile('collab-d1-empty-state.png', Buffer.from(shotZero.data, 'base64'))

  // ─────────────────────────────────────────────────────────────
  // 场景四：过旧快照状态
  // ─────────────────────────────────────────────────────────────
  log('scenario_stale')
  await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/progress-test.html?scenario=stale` })
  await sleep(1000)

  const checkStale = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const staleTag = document.querySelector('.ben-cl__ps-stale-tag');
      return {
        hasStaleTag: staleTag !== null,
        text: staleTag ? staleTag.textContent.trim() : null,
      };
    })()`,
    returnByValue: true,
  })
  log('scenario_stale_result', checkStale.result.value)
  if (!checkStale.result.value.hasStaleTag) throw new Error('陈旧快照未出现警告标记')

  const shotStale = await client.send('Page.captureScreenshot', { format: 'png' })
  await saveEvidenceFile('collab-d1-stale-snapshot.png', Buffer.from(shotStale.data, 'base64'))

  log('browser_checks_passed')
  return client
}

/**
 * 场景五：真实 API 驱动完整 CollabZone 摘要。
 *
 * 同一真实 WorkbenchServer 先建真实事项（父子/取消/受阻/已交付/待回执等全类），
 * 浏览器页面 (?live=1) 只经真实 fetch 读其 /state 驱动 UI；随后在同一服务上
 * move/新建事项，UI 轮询自动刷新，刷新前后数字一致，点开计数与清单同范围。
 */
async function runRealApiDrivenUiCheck(client) {
  log('start_real_api_driven_ui', { apiPort: API_PORT })
  const { createWorkbenchService } = await import('../src/server/service.ts')
  const { createTasksService } = await import('../src/server/tasks.ts')
  const { createJobLog } = await import('../src/server/jobLog.ts')
  const { createPersonalTokens } = await import('../src/server/personalToken.ts')
  const { startWorkbenchServer } = await import('../src/server/http.ts')

  const tempDir = fs.mkdtempSync(join(tmpdir(), 'wb-d1-realapi-'))
  const tasksService = createTasksService({
    file: join(tempDir, 'tasks.json'),
    now: () => Math.floor(Date.now() / 1000),
    newId: () => `task-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
  })

  const mk = async (title, patch = {}) => {
    const r = await tasksService.create({ title, ...patch })
    if (!r.ok || r.id === undefined) throw new Error(`真实服务建事项失败: ${title} (${r.reason ?? '未知原因'})`)
    return r.id
  }

  // 先建子任务，父容器再引用（真实服务同一个口，不绕路）。
  const c1 = await mk('子任务一：真实协议对接', { status: 'todo', acceptance: ['状态码 200', '回包结构一致'] })
  const c2 = await mk('子任务二：账面在做待回执', { status: 'doing', acceptance: ['延迟低于 200ms'] })
  await mk('真实API任务组：核心通路', { children: [c1, c2] })
  await mk('已交付：介绍短片发布', { status: 'done', publishedAt: '2026-10-23', acceptance: ['视频上线'] })
  await mk('已验收待交付：降噪补丁', { status: 'done' })
  await mk('交回待验：头像对齐', { status: 'confirm', acceptance: ['像素对齐无偏差'] })
  await mk('受阻：等审批发布权限', { status: 'blocked' })
  await mk('已取消：旧版清理', { status: 'canceled' })
  await mk('未开始：使用手册', { status: 'todo' })

  const server = await startWorkbenchServer({
    port: API_PORT,
    service: createWorkbenchService(),
    tasks: tasksService,
    jobLog: createJobLog(),
    personalTokens: createPersonalTokens({ file: join(tempDir, 'pat.json') }),
    collabWorkdir: async () => join(tempDir, 'work'),
  })
  log('real_api_server_started', { url: server.url })

  const SUMMARY_SNAPSHOT = `(() => {
    const chip = name => Array.from(document.querySelectorAll('.ben-cl__ps-chip')).find(b => b.textContent.includes(name))?.textContent.replace(/\\s+/g, ' ').trim() ?? null
    return {
      summary: !!document.querySelector('.ben-cl__progress-summary'),
      scope: document.querySelector('.ben-cl__ps-scope-title')?.textContent?.trim() ?? null,
      total: document.querySelector('.ben-cl__ps-scope-count')?.textContent?.trim() ?? null,
      dedup: document.querySelector('.ben-cl__ps-dedup-tag')?.textContent?.trim() ?? null,
      stale: !!document.querySelector('.ben-cl__ps-stale-tag'),
      remaining: chip('本轮剩余'),
      delivered: chip('当前可用'),
      accepted: chip('已验收待交付'),
      review: chip('交回待验'),
      running: chip('真实执行中'),
      waiting: chip('待执行回执'),
      unstarted: chip('未开始'),
      blocked: chip('受阻'),
      canceled: chip('已取消'),
      conditions: chip('验收条件'),
    }
  })()`

  const clickChip = async name => evalValue(client, `(() => {
    const btn = Array.from(document.querySelectorAll('.ben-cl__ps-chip')).find(b => b.textContent.includes(${JSON.stringify(name)}))
    if (btn) btn.click()
    return !!btn
  })()`)

  try {
    // 真 API 直读断言：与浏览器 UI 同源同一份 /state。
    const stateRes = await fetch(`http://127.0.0.1:${API_PORT}/state`)
    const state = await stateRes.json()
    if (!Array.isArray(state.tasks?.tasks) || state.tasks.tasks.length !== 9) {
      throw new Error(`真实 /state 任务数不对: ${JSON.stringify(state.tasks?.tasks?.length)}`)
    }
    log('real_api_state_received', { taskCount: state.tasks.tasks.length })

    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
    await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/progress-test.html?live=1&api=http://127.0.0.1:${API_PORT}` })

    // 初始：9 张真实卡（父去重后 8 项生产工作）。
    const snap = await waitForEval(
      client,
      SUMMARY_SNAPSHOT,
      v => v.summary && typeof v.total === 'string' && v.total.includes('共 8 项'),
      '真实API驱动摘要初次渲染（共 8 项）',
    )
    log('real_api_ui_snapshot_initial', snap)

    const expectSnap = (key, text) => {
      if (snap[key] !== text) throw new Error(`摘要 ${key} 应为「${text}」，实得「${snap[key]}」`)
    }
    expectSnap('scope', '全部事项')
    expectSnap('total', '共 8 项生产工作')
    if (!snap.dedup?.includes('含 1 个任务组')) throw new Error(`父子去重标签未展示: ${snap.dedup}`)
    if (snap.stale !== false) throw new Error('真实服务快照不应标陈旧')
    expectSnap('remaining', '本轮剩余 6 件')
    expectSnap('delivered', '当前可用 1 项')
    expectSnap('accepted', '已验收待交付 1 项')
    expectSnap('review', '交回待验 1 项')
    expectSnap('running', '真实执行中 0 项')
    expectSnap('waiting', '待执行回执 1 项')
    expectSnap('unstarted', '未开始 2 项')
    expectSnap('blocked', '受阻 1 项')
    expectSnap('canceled', '已取消 1 项')
    expectSnap('conditions', '验收条件 8 条')

    // 点开「已取消」：计数与清单同范围。
    if (!(await clickChip('已取消'))) throw new Error('未找到已取消芯片')
    await sleep(400)
    const canceledDrawer = await evalValue(client, `(() => {
      const drawer = document.querySelector('.ben-cl__ps-drawer')
      return {
        title: drawer?.querySelector('.ben-cl__ps-drawer-title')?.textContent?.trim(),
        items: Array.from(drawer?.querySelectorAll('.ben-cl__ps-item-title') ?? []).map(el => el.textContent.trim()),
      }
    })()`)
    log('real_api_drawer_canceled', canceledDrawer)
    if (canceledDrawer.title !== '已取消 (1 项)') throw new Error(`已取消抽屉标题不对: ${canceledDrawer.title}`)
    if (canceledDrawer.items.length !== 1 || !canceledDrawer.items[0].includes('已取消：旧版清理')) {
      throw new Error(`已取消清单与计数不同范围: ${JSON.stringify(canceledDrawer.items)}`)
    }

    // 点开「验收条件」：取消事项的条件噪音不进清单；非目标范围标题不冒称「目标验收条件」。
    if (!(await clickChip('验收条件'))) throw new Error('未找到验收条件芯片')
    await sleep(400)
    const condDrawer = await evalValue(client, `(() => {
      const drawer = document.querySelector('.ben-cl__ps-drawer')
      const items = Array.from(drawer?.querySelectorAll('.ben-cl__ps-cond-item') ?? [])
      return {
        title: drawer?.querySelector('.ben-cl__ps-drawer-title')?.textContent?.trim(),
        count: items.length,
        mentionsCanceled: items.some(it => it.textContent.includes('已取消：旧版清理')),
      }
    })()`)
    log('real_api_drawer_conditions', condDrawer)
    if (condDrawer.title !== '验收条件清单 (8 条)') throw new Error(`条件抽屉标题不对: ${condDrawer.title}`)
    if (condDrawer.count !== 8) throw new Error(`条件清单计数不对: ${condDrawer.count}`)
    if (condDrawer.mentionsCanceled) throw new Error('已取消事项的条件混进了清单')

    // 点开「待执行回执」：真实账面在做、无执行凭据的事项落在这里。
    if (!(await clickChip('待执行回执'))) throw new Error('未找到待执行回执芯片')
    await sleep(400)
    const waitingDrawer = await evalValue(client, `(() => {
      const drawer = document.querySelector('.ben-cl__ps-drawer')
      return {
        title: drawer?.querySelector('.ben-cl__ps-drawer-title')?.textContent?.trim(),
        items: Array.from(drawer?.querySelectorAll('.ben-cl__ps-item-title') ?? []).map(el => el.textContent.trim()),
      }
    })()`)
    log('real_api_drawer_waiting', waitingDrawer)
    if (waitingDrawer.items.length !== 1 || !waitingDrawer.items[0].includes('子任务二：账面在做待回执')) {
      throw new Error(`待执行回执清单不对: ${JSON.stringify(waitingDrawer.items)}`)
    }

    const shotReal = await client.send('Page.captureScreenshot', { format: 'png' })
    await saveEvidenceFile('collab-d1-real-api-driven.png', Buffer.from(shotReal.data, 'base64'))

    // ── 真实更新：同一服务 move + 新建，UI 轮询须自动刷新且前后一致 ──
    const moved = await tasksService.move(c2, 'canceled')
    if (!moved.ok) throw new Error(`move 失败: ${moved.reason ?? '未知'}`)
    await mk('晚到的事项：更新后新建', { status: 'todo' })
    log('real_api_mutations_applied', { moved: c2, created: '晚到的事项' })

    const snap2 = await waitForEval(
      client,
      SUMMARY_SNAPSHOT,
      v => v.summary
        && typeof v.total === 'string' && v.total.includes('共 9 项')
        && v.canceled === '已取消 2 项'
        && v.waiting === '待执行回执 0 项'
        && v.unstarted === '未开始 3 项'
        && v.remaining === '本轮剩余 6 件',
      '真实更新后 UI 自动刷新（共 9 项 / 已取消 2 / 待回执 0 / 未开始 3 / 剩余 6）',
    )
    log('real_api_ui_snapshot_after_update', snap2)

    if (!(await clickChip('已取消'))) throw new Error('刷新后未找到已取消芯片')
    await sleep(400)
    const canceledDrawer2 = await evalValue(client, `(() => {
      const drawer = document.querySelector('.ben-cl__ps-drawer')
      return {
        title: drawer?.querySelector('.ben-cl__ps-drawer-title')?.textContent?.trim(),
        items: Array.from(drawer?.querySelectorAll('.ben-cl__ps-item-title') ?? []).map(el => el.textContent.trim()),
      }
    })()`)
    log('real_api_drawer_canceled_after_update', canceledDrawer2)
    if (canceledDrawer2.items.length !== 2
      || !canceledDrawer2.items.some(t => t.includes('已取消：旧版清理'))
      || !canceledDrawer2.items.some(t => t.includes('子任务二：账面在做待回执'))) {
      throw new Error(`刷新后已取消清单与计数不同范围: ${JSON.stringify(canceledDrawer2.items)}`)
    }

    // 更新后真 API 直读对照。
    const stateRes2 = await fetch(`http://127.0.0.1:${API_PORT}/state`)
    const state2 = await stateRes2.json()
    if (state2.tasks?.tasks?.length !== 10) throw new Error(`更新后 /state 任务数不对: ${state2.tasks?.tasks?.length}`)

    const shotUpdated = await client.send('Page.captureScreenshot', { format: 'png' })
    await saveEvidenceFile('collab-d1-real-api-updated.png', Buffer.from(shotUpdated.data, 'base64'))

    log('real_api_driven_ui_passed')
  } finally {
    await server.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
    log('real_api_server_closed')
  }
}

async function main() {
  try {
    const client = await runBrowserChecks()
    await runRealApiDrivenUiCheck(client)
    client.close()

    finished = true
    log('all_checks_completed_successfully')

    // 写入 JSONL 日志
    const logJsonl = logs.map(l => JSON.stringify(l)).join('\n') + '\n'
    fs.writeFileSync(resolve(tmpReportDir, 'kimi-collab-d1-concentrated-fix.jsonl'), logJsonl)
    fs.writeFileSync(resolve(persistentReportDir, 'kimi-collab-d1-concentrated-fix.jsonl'), logJsonl)

    cleanup()
    process.exit(0)
  } catch (err) {
    console.error('验收执行失败:', err)
    log('error', { message: err.message, stack: err.stack })
    cleanup()
    process.exit(1)
  }
}

main()
