/** 生产 CollabZone + 临时真实 WorkbenchServer；正式 HTTP 建账，不读日用实例。 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import config from './collab-board/vite.config.mjs'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createPersonalTokens } from '../src/server/personalToken.ts'
import { startWorkbenchServer } from '../src/server/http.ts'

const require = createRequire(import.meta.url)
const { createServer: createViteServer } = await import(require.resolve('vite', { paths: [require.resolve('vitest/package.json')] }))
const temp = mkdtempSync(join(tmpdir(), 'collab-context-1026-'))
const evidence = resolve(`../docs/assets/collab-d1-context-1026/run-${Date.now()}`)
mkdirSync(evidence, { recursive: true })
const logs = []
const log = (name, data) => { logs.push({ name, data }); console.log(name, JSON.stringify(data)) }
const pause = ms => new Promise(ok => setTimeout(ok, ms))
let sequence = 0, server, vite, chrome, socket
const watchdog = setTimeout(() => { console.error('timeout'); chrome?.kill(); process.exit(1) }, 180000)

async function checkPortUnused(port) {
  await new Promise((ok, bad) => {
    const probe = createConnection({ host: '127.0.0.1', port })
    probe.once('connect', () => { probe.destroy(); bad(new Error(`临时端口 ${port} 已占用，保留原服务并停止本轮`)) })
    probe.once('error', error => { probe.destroy(); error.code === 'ECONNREFUSED' ? ok() : bad(error) })
    probe.setTimeout(800, () => { probe.destroy(); bad(new Error(`端口 ${port} 探测超时`)) })
  })
}

try {
  for (const port of [3293, 9092, 9093]) await checkPortUnused(port)
  log('ports-unused', { ports: [3293, 9092, 9093], evidence })
  server = await startWorkbenchServer({
    port: 9093, tickIntervalMs: 0,
    paths: { home: temp, config: createAppConfig({ file: join(temp, 'app.json') }) },
    credentialFile: join(temp, 'credentials.json'), service: createWorkbenchService(),
    tasks: createTasksService({ file: join(temp, 'tasks.json'), newId: () => `qa-${++sequence}` }),
    jobLog: createJobLog({ file: join(temp, 'jobs.jsonl') }),
    personalTokens: createPersonalTokens({ file: join(temp, 'pat.json') }),
    collabWorkdir: async () => join(temp, 'work'),
  })
  const post = async (path, body) => {
    const res = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json()
    assert(res.ok, `${path}: ${JSON.stringify(data)}`)
    return data
  }
  const goals = [], members = []
  for (const title of ['座机普通窗口可读', '样片发布准备', '每周资料整理', '回访与复盘', '下次会议准备']) {
    goals.push((await post('/collab/goal/create', { title, why: '在普通窗口也能接着完成工作' })).id)
  }
  for (const name of ['资料整理', '内容编辑', '研发协作', '会议准备', '试用反馈', '素材核对', '字幕整理', '界面检查', '文案校对', '发布准备', '来往整理', '结果复核', '日程核对', '阅读体验', '回访记录']) {
    members.push((await post('/collab/agent/save', { name, hand: 'cli', runtime: { family: 'codex' }, shared: { to: 'none' } })).id)
  }
  const addTasks = async (start, end) => {
    for (let i = start; i < end; i++) {
      const task = await post('/task/create', {
        title: `${i + 1}. ${['整理项目材料并核对遗漏', '补充说明并准备下一轮试用', '检查阅读体验和交接结果'][i % 3]}`,
        status: i % 5 === 0 ? 'confirm' : i % 7 === 0 ? 'blocked' : 'todo',
        goal_id: goals[i % goals.length], project_id: '阅读体验', assignee: members[0],
        from: { kind: 'said', quote: '请核对普通窗口折叠后的阅读体验' },
        acceptance: ['普通窗口里能读清要求', '阅读后可以顺畅接着查看下一项'],
      })
      if (i < 7) await post('/collab/goal/condition/save', { goal_id: goals[i % goals.length], text: `验收 ${i + 1}：普通窗口可以完整阅读并继续处理`, task_id: task.id })
    }
  }
  await addTasks(0, 24)
  log('real-data', { goals: goals.length, members: members.length + 1, count: 24, source: 'HTTP goal/create agent/save task/create goal/condition/save', temp })
  vite = await createViteServer({ ...config, configFile: false, cacheDir: join(temp, 'vite-cache'), server: { ...config.server, port: 3293 } })
  await vite.listen()
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${join(temp, 'chrome')}`, '--remote-debugging-port=9092', 'about:blank',
  ], { stdio: 'ignore' })
  let tab
  for (let i = 0; i < 60; i++) {
    try { tab = (await (await fetch('http://127.0.0.1:9092/json/list')).json()).find(x => x.type === 'page'); if (tab) break } catch {}
    await pause(150)
  }
  assert(tab)
  socket = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((ok, bad) => { socket.onopen = ok; socket.onerror = bad })
  let seq = 0
  const pending = new Map()
  socket.onmessage = e => {
    const m = JSON.parse(String(e.data))
    if (!pending.has(m.id)) return
    const [ok, bad] = pending.get(m.id); pending.delete(m.id)
    m.error ? bad(new Error(JSON.stringify(m.error))) : ok(m.result)
  }
  const send = (method, params = {}) => new Promise((ok, bad) => {
    const id = ++seq; pending.set(id, [ok, bad]); socket.send(JSON.stringify({ id, method, params }))
  })
  const ev = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  const wait = async expression => {
    for (let i = 0; i < 80; i++) { if (await ev(expression)) return; await pause(100) }
    throw new Error('wait failed: ' + expression)
  }
  const mouseClick = async expression => {
    const point = await ev(`(() => {
      const e=${expression}; if (!e) return null;
      e.scrollIntoView({block:'nearest',inline:'nearest'});
      const r=e.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,visible:r.width>0 && r.height>0 && (hit===e || e.contains(hit))};
    })()`)
    assert(point?.visible, `实际点击位置不可达：${expression}`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await pause(120)
  }
  const click = text => mouseClick(`[...document.querySelectorAll('button')].find(b=>b.getClientRects().length && (b.textContent.trim()===${JSON.stringify(text)} || b.textContent.startsWith(${JSON.stringify(text + ' ·')})))`)
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(evidence, name + '.png'), Buffer.from(r.data, 'base64'))
  }
  const metrics = () => ev(`(() => {
    const e=document.querySelector('.ben-cl__reading'), r=e.getBoundingClientRect();
    const cards=[...e.querySelectorAll('[data-note-id]')].map(x=>x.getBoundingClientRect());
    return {height:r.height,top:r.top,bottom:r.bottom,client:e.clientHeight,scroll:e.scrollHeight,scrollTop:e.scrollTop,
      fullyVisible:cards.filter(x=>x.top>=r.top && x.bottom<=r.bottom).length,overflow:document.documentElement.scrollWidth>innerWidth,
      folds:[...document.querySelectorAll('.ben-cl__context-controls [aria-expanded]')].map(x=>x.getAttribute('aria-expanded')),errors:window.__errs};
  })()`)
  const url = `http://127.0.0.1:3293/desktop-test.html?live=1&api=${encodeURIComponent(server.url)}&view=goals`
  const resize = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  const scrollTop = () => ev(`document.querySelector('.ben-cl__reading').scrollTop`)
  await resize(780, 720)
  await send('Page.navigate', { url })
  await wait(`document.querySelectorAll('[data-note-id]').length===24`)
  await pause(800)
  log('ordinary-expanded', await metrics()); await shot('01-ordinary-expanded')

  // 实际鼠标逐项点击，不能用隐藏 DOM 的 click 冒作可达入口。
  for (const name of ['成员', '筛选', '等你', '统计', '能力条件']) {
    await click(name)
    const closed = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(name)} || b.textContent.startsWith(${JSON.stringify(name + ' ·')}));return b.getAttribute('aria-expanded') })()`)
    assert.equal(closed, 'false', name)
    await click(name)
  }
  log('independent-folds', { names: ['成员', '筛选', '等你', '统计', '能力条件'], allRestored: true })
  await ev(`(() => {const s=document.querySelector('select[aria-label="项目"]');s.value='阅读体验';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await mouseClick(`document.querySelectorAll('.ben-cl__people button')[2]`)
  await mouseClick(`document.querySelector('button[aria-label="筛选"]')`)
  await mouseClick(`[...document.querySelectorAll('.ben-cl__filter summary')].find(e=>e.textContent==='负责人')`)
  await mouseClick(`document.querySelector('.ben-cl__filter[open] input')`)
  assert(await ev(`document.querySelector('.ben-cl__filter[open] input').checked`))
  // 关闭浮层但保留选择，随后验证折叠不清掉该选择。
  await mouseClick(`document.querySelector('.ben-cl__filter[open] summary')`)
  await ev(`document.querySelector('.ben-cl__reading').scrollTop=250`)
  const before = await scrollTop()
  await click('收起上方')
  let m = await metrics()
  log('ordinary-collapsed', m)
  assert(m.height >= 450); assert(m.fullyVisible >= 2); assert(!m.overflow); assert.deepEqual(m.errors, [])
  assert(await ev(`document.querySelector('select[aria-label="当前目标"]').getClientRects().length>0`))
  assert.equal(await scrollTop(), before)
  await ev(`document.querySelector('.ben-cl__reading').scrollTop=0`); await shot('02-ordinary-collapsed')
  await click('展开上方')
  assert.equal(await ev(`document.querySelector('select[aria-label="项目"]').value`), '阅读体验')
  assert(await ev(`document.querySelectorAll('.ben-cl__people button')[2].getAttribute('aria-pressed')==='true'`))
  assert(await ev(`document.querySelector('.ben-cl__filters input:checked')!==null`))
  await ev(`document.querySelector('.ben-cl__reading').scrollTop=250`)
  const previous = await scrollTop()
  await click('收起上方'); await click('展开上方')
  assert.equal(await scrollTop(), previous)
  await click('收起上方')
  await ev(`(() => {const s=document.querySelector('select[aria-label="当前目标"]');s.value=${JSON.stringify(goals[1])};s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await pause(150)
  assert.equal(await ev(`document.querySelector('select[aria-label="当前目标"]').value`), goals[1])
  assert.equal(await ev(`document.querySelector('.ben-cl__fixed-goal button[aria-expanded]').getAttribute('aria-expanded')`), 'false')
  await click('能力条件'); assert.equal(await ev(`document.querySelector('select[aria-label="当前目标"]').value`), goals[1]); await click('能力条件')
  log('selection-and-scroll-restored', { project: true, member: true, facet: true, goal: true, scrollTop: previous })
  await send('Page.reload'); await wait(`document.querySelector('.ben-cl__reading')!==null`); await pause(600)
  m = await metrics(); assert(m.folds.every(x => x === 'false')); log('reload-fold-preference', m)
  assert.equal(await ev(`document.querySelector('.ben-cl__fixed-goal button[aria-expanded]').getAttribute('aria-expanded')`), 'false')

  await resize(1440, 1000)
  await send('Page.navigate', { url: url + '&full=1' }); await wait(`document.querySelector('.ben-cl__flow')!==null`)
  await click('筛选'); await click('阅读'); await click('收起上方'); await pause(300)
  m = await metrics(); log('fullscreen-reading', m); assert(m.height >= 700); assert(!m.overflow); await shot('03-fullscreen')
  await addTasks(24, 100); await resize(780, 720)
  await send('Page.navigate', { url }); await wait(`document.querySelectorAll('[data-note-id]').length===100`); await pause(300)
  await ev(`document.querySelector('.ben-cl__reading').scrollTop=0`)
  m = await metrics(); log('many-content', m); assert(m.height >= 450); assert(m.scroll > m.client * 3); assert(m.fullyVisible >= 2); await shot('04-many-top')
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 450, deltaX: 0, deltaY: 1800 })
  await wait(`document.querySelector('.ben-cl__reading').scrollTop>=1700`)
  m = await metrics(); assert(m.scrollTop >= 1700); log('many-wheel-scroll', m); await shot('05-many-scrolled')
  await click('展开上方')
  await ev(`{const e=document.querySelector('.ben-cl__reading');e.scrollTop=e.scrollHeight-e.clientHeight-5}`)
  const nearBottom = await scrollTop()
  await click('收起上方'); await click('展开上方')
  assert.equal(await scrollTop(), nearBottom)
  log('bottom-scroll-preserved', { nearBottom })
  await shot('06-many-expanded-bottom')
  assert.deepEqual(await ev('window.__errs'), [])
  writeFileSync(join(evidence, 'results.json'), JSON.stringify({ passed: true, logs }, null, 2))
} catch (error) {
  log('failed', { message: String(error), code: error.code }); throw error
} finally {
  clearTimeout(watchdog); socket?.close(); chrome?.kill(); await vite?.close(); await server?.close()
  writeFileSync(join(evidence, 'attempt-log.json'), JSON.stringify(logs, null, 2))
}
