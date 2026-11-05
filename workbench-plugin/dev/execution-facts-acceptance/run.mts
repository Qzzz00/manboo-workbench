/** Isolated HTTP + production React QA with synthetic source facts, no CLI/model/account access. */
import assert from 'node:assert/strict'
import { createServer as portProbe } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from '../../../butler-app/node_modules/vite/dist/node/index.js'
import { startWorkbenchServer } from '../../src/server/http.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { createTasksService } from '../../src/server/tasks.ts'
const here = dirname(fileURLToPath(import.meta.url)), plugin = resolve(here, '../..')
const evidence = resolve(plugin, '../docs/验收/执行事实-1026/browser')
await mkdir(evidence, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'execution-facts-qa-'))
for (const port of [9393, 9394]) {
  const probe = portProbe()
  await new Promise<void>((ok, bad) => { probe.once('error', bad); probe.listen(port, '127.0.0.1', () => probe.close(() => ok())) })
}
const service = createWorkbenchService()
const tasks = createTasksService({ file: join(root, 'tasks.json') })
const server = await startWorkbenchServer({ port: 9393, service, tasks, tickIntervalMs: 0 })
let vite: Awaited<ReturnType<typeof createVite>> | undefined, chrome: ReturnType<typeof spawn> | undefined, socket: WebSocket | undefined
try {
  async function api(path: string, body?: unknown): Promise<any> {
    const res = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const got = await res.json(); assert.ok(res.ok, JSON.stringify({ path, status: res.status, got })); return got
  }
  const goal = await api('/collab/goal/create', { title: '隔离验收交付', conditions: [{ text: '产物可验收' }, { text: '退回能回退' }, { text: '重启不重复' }] })
  const titles = ['接通真实来源', '核对交付产物', '补齐异常分支']
  const ids: string[] = []
  for (const [index, title] of titles.entries()) {
    const links = [{ agent: index === 2 ? 'kimi' : 'codex', session_id: `qa-source-${index}` }]
    const made = await api('/task/create', { title, from: { kind: 'user', quote: '受控隔离验收' }, acceptance: ['受控产物可检查'], status: 'todo', direction: 'mine', assignee: links[0]!.agent, goal_id: goal.id, links })
    ids.push(made.id)
    await api('/task/move', { id: made.id, status: 'doing' })
    service.applyEvent({ ...links[0]!, agent: links[0]!.agent as 'codex' | 'kimi', type: 'running', title, ts: Math.floor(Date.now() / 1000) })
  }
  await api('/task/receipt', { id: ids[1], receipt: 'done', text: '做完: 1. 隔离夹具产物可检查', by: 'codex' })
  const before = await api('/state')
  const condition = before.tasks.goals.find((g: any) => g.id === goal.id).conditions[0]
  await api('/collab/goal/condition/save', { goal_id: goal.id, id: condition.id, text: condition.text, task_id: ids[1], evidence: ['controlled-fixture:artifact'] })
  await api('/collab/goal/condition/verify', { goal_id: goal.id, condition_id: condition.id, by: 'me', pass: true })
  await api('/collab/goal/condition/deliver', { goal_id: goal.id, condition_id: condition.id })
  service.applyEvent({ agent: 'codex', session_id: 'qa-source-1', type: 'done', title: titles[1], ts: Math.floor(Date.now() / 1000) })
  vite = await createVite({ configFile: false, root: here, cacheDir: join(root, 'vite-cache'), server: { host: '127.0.0.1', port: 9394, strictPort: true, fs: { allow: [plugin] }, proxy: { '/api': { target: server.url, rewrite: path => path.replace(/^\/api/, '') } } }, resolve: { alias: ['react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'react-dom', 'react'].map(name => ({ find: new RegExp(`^${name}$`), replacement: join(plugin, 'node_modules', `${name}${name === 'react' || name === 'react-dom' ? '/index.js' : '.js'}`) })) }, esbuild: { jsx: 'automatic' } })
  await vite.listen()
  const profile = join(root, 'chrome')
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' })
  let debugging = ''
  for (let i = 0; i < 100; i++) { try { debugging = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); break } catch { await new Promise(r => setTimeout(r, 100)) } }
  assert.ok(debugging, 'isolated Chrome startup failed')
  const pages = await (await fetch(`http://127.0.0.1:${debugging.split('\n')[0]}/json/list`)).json() as any[]
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>(), exceptions: unknown[] = []
  socket.onmessage = event => { const m = JSON.parse(String(event.data)); if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } }
  await new Promise<void>((ok, bad) => { socket!.onopen = () => ok(); socket!.onerror = () => bad(new Error('CDP failed')) })
  const send = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression: string) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value }
  const wait = async (expression: string) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)) } throw new Error('UI timeout: '+expression+' '+await evaluate('document.body.innerText')+' '+JSON.stringify(exceptions)) }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.navigate', { url: 'http://127.0.0.1:9394/' })
  await wait("document.body.innerText.includes('核对交付产物')")
  const results: unknown[] = []
  for (const [width, height] of [[1024, 768], [1440, 900], [430, 860]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await new Promise(r => setTimeout(r, 900))
    const geometry = await evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};return {text:document.body.innerText,cards:[...document.querySelectorAll('.ben-wb__task-constellation li')].map(rect),orb:rect(document.querySelector('.ben-wb__task-orb-anchor')),inputs:[...document.querySelectorAll('textarea')].map(rect)}})()`)
    results.push({ width, height, ...geometry })
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); await writeFile(join(evidence, `ui-${width}.png`), Buffer.from(shot.data, 'base64'))
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false })
  await evaluate(`document.querySelector('[aria-label="查看事项:核对交付产物"]').click()`)
  await wait(`document.querySelector('[aria-label="验收进度"]')?.innerText.includes('已交付')`)
  await api('/task/move', { id: ids[1], status: 'done' })
  await api('/task/move', { id: ids[1], status: 'doing' })
  await wait(`document.querySelector('[aria-label="验收进度"]')?.innerText.includes('退回重做')`)
  assert.ok(await evaluate(`document.querySelector('[aria-label="验收进度"]').innerText.includes('旧轮')`))
  const conditionShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(join(evidence, 'ui-condition-reopened.png'), Buffer.from(conditionShot.data, 'base64'))
  results.push({ condition: 'real HTTP delivered -> done -> reopened -> rework; old verification visible' })
  await writeFile(join(evidence, 'layout.json'), JSON.stringify({ fixture: 'synthetic sources through isolated WorkbenchServer; NOT real CLI execution', results, exceptions }, null, 2))
  assert.equal(exceptions.length, 0)
  console.log('browser snapshots saved; geometry requires visual review')
} finally {
  socket?.close()
  if (chrome !== undefined) { chrome.kill('SIGTERM'); await new Promise<void>(ok => { if (chrome!.exitCode !== null) ok(); else chrome!.once('exit', () => ok()) }) }
  await vite?.close(); await server.close()
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
