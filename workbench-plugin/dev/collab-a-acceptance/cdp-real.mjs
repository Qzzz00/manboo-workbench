// 协作A:对**真实例(8993 真 DSH)** 的桌面/手机浏览器腿(真 Chrome headless + CDP)。
// 前置:node dev/collab-a-acceptance/serve.mts 在跑(8993)。跑完自行停 vite/Chrome,不动实例。
// 用法:node dev/collab-a-acceptance/cdp-real.mjs
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname)
const ROOT = join(HERE, '..', '..', '..')
const OUT = join(HERE, 'browser-real-shots')
mkdirSync(OUT, { recursive: true })
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`) }
const procs = []
let chromeProc = null
const cleanup = () => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } if (chromeProc) { try { chromeProc.kill('SIGKILL') } catch {} } }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })
setTimeout(() => { console.error('watchdog 300s'); cleanup(); process.exit(1) }, 300_000).unref()

const deskP = spawn('npx', ['vite', '--config', './vite.config.mjs'], { cwd: join(ROOT, 'workbench-plugin', 'dev', 'continue-flow'), env: { ...process.env, WB_TARGET: 'http://127.0.0.1:8993' }, stdio: ['ignore', 'pipe', 'pipe'] })
deskP.stdout.on('data', d => console.log('[desk]', String(d).trim().slice(0, 100)))
deskP.stderr.on('data', () => {})
const phoneP = spawn('npx', ['vite', '--config', './vite.config.mjs'], { cwd: join(ROOT, 'butler-app', 'dev', 'continue-box'), env: { ...process.env, WB_TARGET: 'http://127.0.0.1:8993', WB_BOX_PORT: '4342', VITE_WB_PORT: '8993' }, stdio: ['ignore', 'pipe', 'pipe'] })
phoneP.stdout.on('data', d => console.log('[phone]', String(d).trim().slice(0, 100)))
phoneP.stderr.on('data', () => {})
procs.push(deskP, phoneP)
await sleep(5000)

const CHROME_PORT = 4600 + Math.floor(Math.random() * 200)
const tmpProfile = join(tmpdir(), `collab-a-real-chrome-${Date.now()}`)
chromeProc = spawn(chrome, [`--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--disable-gpu', `--user-data-dir=${tmpProfile}`, '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
procs.push(chromeProc)
let wsUrl = null
for (let i = 0; i < 40 && wsUrl === null; i++) {
  await sleep(250)
  try { const list = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json(); wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? null } catch {}
}
const ws = new WebSocket(wsUrl)
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad })
let seq = 0
const pending = new Map()
ws.onmessage = ev => { const m = JSON.parse(String(ev.data)); if (m.id !== undefined && pending.has(m.id)) { const { ok, bad } = pending.get(m.id); pending.delete(m.id); m.error ? bad(new Error(m.error.message)) : ok(m.result) } }
const send = (method, params = {}) => new Promise((ok, bad) => { const id = ++seq; pending.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params })) })
const evl = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300))
  return r.result.value
}
async function nav(url, width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 800 })
  await send('Page.navigate', { url })
  for (let i = 0; i < 80; i++) { await sleep(250); if (await evl('document.readyState === "complete"')) break }
}
async function typeText(pickExpr, text) {
  await evl(`(() => { const el=${pickExpr}; if(!el) return 'missing'; el.focus(); el.select(); return 'ok' })()`)
  await send('Input.insertText', { text })
  await sleep(250)
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'))
  console.log('📷', name)
}
const turnsOf = async (id) => fetch(`http://127.0.0.1:4331/butler/item/${id}/turns?limit=30`).then(async r => JSON.stringify((await r.json()).turns ?? [])).catch(() => '')
const cardProbe = await fetch('http://127.0.0.1:4331/state').then(async r => (await r.json()).tasks?.tasks?.[0]).catch(() => undefined)
console.log('目标卡:', cardProbe?.id, cardProbe?.title)
const CARD = cardProbe?.id ?? 't-1'

// —— 桌面 1440(真 /state → NoteDialog → 真 DSH)——
console.log('\n—— 桌面(真 DSH 8993)——')
await nav('http://127.0.0.1:4331/', 1440, 900)
await sleep(2500)
check('桌面:弹窗开(真 /state)', await evl(`!!document.querySelector('[role="dialog"]')`))
check('桌面:来源列出(单来源=一行「发给:」;多来源=带空档的选择)', await evl("document.body.innerText.includes('发给:') || document.querySelector('select[aria-label=\"发给哪一条会话\"] option')?.textContent === '选一条会话……'"))
await typeText(`[...document.querySelectorAll('textarea')].find(x=>x.getAttribute('aria-label')==='接着说')`, '浏览器里对真会话说一句 QA_BROWSER_REAL')
if (await evl(`!!document.querySelector('select[aria-label="发给哪一条会话"]')`)) {
  await evl(`(() => { const s=document.querySelector('select[aria-label="发给哪一条会话"]'); s.selectedIndex=1; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value })()`)
}
await evl(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='发出去')?.click()`)
await sleep(5000)
check('桌面:送进真 DSH 会话(回执「捎到了」)', await evl(`document.body.innerText.includes('捎到了')`))
check('桌面:那句话真落在会话里(turns 读到)', (await turnsOf(CARD)).includes('QA_BROWSER_REAL'))
await shot('r1-桌面-真DSH发送.png')
await typeText(`[...document.querySelectorAll('textarea')].find(x=>x.getAttribute('aria-label')==='接着说')`, '真例重载后该还在的草稿')
await sleep(400)
await nav('http://127.0.0.1:4331/', 1440, 900)
await sleep(2500)
check('桌面:整页重载草稿还在(真例)', await evl(`(() => { const t=[...document.querySelectorAll('textarea')].find(x=>x.getAttribute('aria-label')==='接着说'); return t?.value === '真例重载后该还在的草稿' })()`))

// —— 手机 375(同一真实例的下级页)——
console.log('\n—— 手机 375(真 DSH 8993)——')
await nav('http://127.0.0.1:4342/', 375, 812)
await sleep(3000)
check('375:这一格摆出来(真例)', await evl(`!!document.querySelector('[aria-label="继续这件事"]')`))
await typeText(`[...document.querySelectorAll('textarea')].find(x=>x.getAttribute('aria-label')==='接着说')`, '手机浏览器补一句 QA_PHONE_REAL')
await evl(`document.querySelector('button[aria-label="发送"]')?.click()`)
await sleep(5000)
check('375:送到真会话(回执「捎到了」)', await evl(`document.body.innerText.includes('捎到了')`))
check('375:那句话真落在会话里', (await fetch(`http://127.0.0.1:4342/butler/item/${CARD}/turns?limit=30`).then(async r => JSON.stringify((await r.json()).turns ?? [])).catch(() => '')).includes('QA_PHONE_REAL'))
await send('Network.enable')
await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
await typeText(`[...document.querySelectorAll('textarea')].find(x=>x.getAttribute('aria-label')==='接着说')`, '断网时手机打的 QA_OFFLINE')
await evl(`document.querySelector('button[aria-label="发送"]')?.click()`)
await sleep(1200)
check('375:断网 → 屏上说「没送到」', await evl(`document.body.innerText.includes('没送到')`))
await shot('r2-手机375-断网.png')
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
await sleep(500)
await evl(`document.querySelector('button[aria-label="发送"]')?.click()`)
await sleep(5000)
check('375:恢复后同句送达(turns 里出现)', (await fetch(`http://127.0.0.1:4342/butler/item/${CARD}/turns?limit=40`).then(async r => JSON.stringify((await r.json()).turns ?? [])).catch(() => '')).includes('QA_OFFLINE'))
await typeText(`[...document.querySelectorAll('textarea')].find(x=>x.getAttribute('aria-label')==='接着说')`, '375真例重载草稿')
await sleep(400)
await nav('http://127.0.0.1:4342/', 375, 812)
await sleep(3000)
check('375:重载草稿还在(真例)', await evl(`(() => { const t=[...document.querySelectorAll('textarea')].find(x=>x.getAttribute('aria-label')==='接着说'); return t?.value === '375真例重载草稿' })()`))
check('375:无横向溢出', await evl(`document.documentElement.scrollWidth <= window.innerWidth`))
await shot('r3-手机375-真例.png')

console.log('\n==== 汇总 ====')
const failed = results.filter(r => !r.ok)
writeFileSync(join(HERE, 'browser-real-results.json'), JSON.stringify(results, null, 2))
console.log(`共 ${results.length} 项,过 ${results.length - failed.length},败 ${failed.length}`)
cleanup()
process.exit(failed.length === 0 ? 0 : 2)
