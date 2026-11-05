/** Isolated HTTP + production React QA through the real public execution reconciler. Sources below are controlled files, not authors' CLI sessions. */
import assert from 'node:assert/strict'
import { createServer as portProbe } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, appendFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from '../../../butler-app/node_modules/vite/dist/node/index.js'
import { startWorkbenchServer } from '../../src/server/http.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { createAppConfig } from '../../src/server/appConfig.ts'
import { createTasksService } from '../../src/server/tasks.ts'
import { createJobLog } from '../../src/server/jobLog.ts'
const here = dirname(fileURLToPath(import.meta.url)), plugin = resolve(here, '../..')
const evidence = resolve(plugin, process.env.BUSINESS_EVIDENCE_DIR ?? '../docs/验收/执行事实-1026/public-seam-browser')
await mkdir(evidence, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'execution-facts-qa-'))
for (const port of [9393, 9394]) {
  const probe = portProbe()
  await new Promise<void>((ok, bad) => { probe.once('error', bad); probe.listen(port, '127.0.0.1', () => probe.close(() => ok())) })
}
let service = createWorkbenchService()
const cwd = join(root, 'project'); await mkdir(cwd)
const refs: { agent: string, session_id: string, file: string, format: 'codex-rollout' | 'kimi-wire' }[] = []
const sourceDir = join(root, '.codex', 'sessions', '2026', '10', '26'); await mkdir(sourceDir, { recursive: true })
const tasksFile = join(root, 'tasks.json'), jobsFile = join(root, 'jobs.jsonl')
let tasks = createTasksService({ file: tasksFile }), jobs = createJobLog({ file: jobsFile }), allowed = true
// The public snapshot clock has second precision; keep controlled rounds ordered behind it.
let eventTime = Math.floor(Date.now() / 1000) * 1000 - 30_000
const now = () => new Date(eventTime += 1000).toISOString()
async function codexSource(id: string, provider = 'openai') {
  const file = join(sourceDir, `${id}.jsonl`)
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd, model_provider: provider } }) + '\n')
  refs.push({ agent: 'codex', session_id: id, file, format: 'codex-rollout' })
  return file
}
async function codexEvent(id: string, type: string, round: string, last_agent_message?: string) {
  const file = refs.find(one => one.session_id === id)!.file
  await appendFile(file, JSON.stringify({ type: 'event_msg', timestamp: now(), payload: { type, turn_id: round,
    ...(last_agent_message === undefined ? {} : { last_agent_message }) } }) + '\n')
}
async function kimiSource(id: string) {
  const dir = join(root, '.kimi-code', 'sessions', 'qa', id)
  await mkdir(join(dir, 'agents', 'main'), { recursive: true })
  await writeFile(join(dir, 'state.json'), JSON.stringify({ cwd }))
  const file = join(dir, 'agents', 'main', 'wire.jsonl')
  await writeFile(file, JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: Date.now() }) + '\n')
  refs.push({ agent: 'kimi', session_id: id, file, format: 'kimi-wire' })
  return file
}
async function kimiEvent(id: string, type: string, extra: object = {}) {
  await appendFile(refs.find(one => one.session_id === id)!.file,
    JSON.stringify({ type: 'context.append_loop_event', time: Date.parse(now()), event: { type, ...extra } }) + '\n')
}
async function openServer() { return startWorkbenchServer({ port: 9393, service, tasks, jobLog: jobs, tickIntervalMs: 0, heartbeatMs: 0,
  paths: { home: root, config: createAppConfig({ file: join(root, 'app.json') }) },
  authorization: { isAllowed: async () => allowed, denialMessage: () => '受控来源撤权' } as never,
  sessionDigest: { files: () => refs } as never,
  projects: { getProjectsState: async () => ({ projects: [{ id: 'qa', name: '隔离验收', path: cwd }] }) } as never }) }
let server = await openServer()
let vite: Awaited<ReturnType<typeof createVite>> | undefined, chrome: ReturnType<typeof spawn> | undefined, socket: WebSocket | undefined
try {
  async function api(path: string, body?: unknown): Promise<any> {
    const res = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:9394' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const got = await res.json(); assert.ok(res.ok, JSON.stringify({ path, status: res.status, got })); return got
  }
  const goal = await api('/collab/goal/create', { title: '隔离验收交付', conditions: [{ text: '产物可验收' }, { text: '退回能回退' }, { text: '重启不重复' }] })
  const titles = ['接通真实来源', '核对交付产物', '补齐异常分支']
  const ids: string[] = []
  await codexSource('qa-source-0'); await codexEvent('qa-source-0', 'task_started', 'r-1')
  await codexSource('qa-source-1'); await codexEvent('qa-source-1', 'task_started', 'r-1'); await codexEvent('qa-source-1', 'task_complete', 'r-1', '做完: 受控交付')
  await kimiSource('qa-source-2'); await kimiEvent('qa-source-2', 'step.begin', { step: 1 })
  await codexSource('qa-manager'); await codexEvent('qa-manager', 'task_started', 'r-1')
  for (const [index, title] of titles.entries()) {
    const links = [{ agent: index === 2 ? 'kimi' : 'codex', session_id: `qa-source-${index}` },
      ...(index === 0 ? [{ agent: 'codex', session_id: 'qa-manager', execution_role: 'coordination' }] : [])]
    const made = await api('/task/create', { title, from: { kind: 'user', quote: '受控隔离验收' }, acceptance: ['受控产物可检查'], status: 'todo', direction: 'mine', assignee: links[0]!.agent, project_id: 'qa', goal_id: goal.id, links })
    ids.push(made.id)
  }
  // Many actual waiting cards through the real API; they must not displace the business heading.
  for (let i = 0; i < 8; i++) {
    const card = await api('/task/create', { title: `等待验收 ${i + 1}`, from: { kind: 'user', quote: '隔离待验夹具' }, acceptance: ['检查产物'], status: 'todo', direction: 'mine', assignee: 'codex' })
    await api('/task/move', { id: card.id, status: 'doing' })
    await api('/task/receipt', { id: card.id, receipt: 'done', text: '做完: 1. 等待核验的受控产物', by: 'codex' })
  }
  const ownerDecision = await api('/task/create', { title: '发布范围需要本人拍板', status: 'confirm', assignee: 'codex', from: { kind: 'user', quote: '隔离拍板夹具' }, acceptance: ['方案明确'] })
  await api('/task/owner-ask', { id: ownerDecision.id, kind: 'publish', proposal: '先发布这一版', basis: '已核对隔离产物' })
  const before = await api('/state')
  assert.deepEqual(before.waiting.items.filter((item: any) => item.kind === 'confirm').map((item: any) => item.task_id), [ownerDecision.id], 'only structured owner decision reaches the user waiting pile')
  await writeFile(join(evidence, 'state-before-condition.json'), JSON.stringify({ tasks: before.tasks?.tasks?.map((one: any) => ({ id: one.id, title: one.title, status: one.status, links: one.links, project_id: one.project_id })), execution: before.execution, running: before.running }, null, 2))
  const condition = before.tasks.goals.find((g: any) => g.id === goal.id).conditions[0]
  await api('/collab/goal/condition/save', { goal_id: goal.id, id: condition.id, text: condition.text, task_id: ids[1], evidence: ['controlled-fixture:artifact'] })
  await api('/collab/goal/condition/verify', { goal_id: goal.id, condition_id: condition.id, by: 'me', pass: true })
  await api('/collab/goal/condition/deliver', { goal_id: goal.id, condition_id: condition.id })
  const initial = await api('/state')
  assert.equal(initial.running.scope, 'classified_business_tasks')
  assert.equal(initial.running.count, 2)
  assert.equal(initial.execution.observed_running_sessions, 2)
  assert.equal(initial.running.items.find((one: any) => one.task_id === ids[0]).sources.length, 2)
  assert.equal(initial.running.items.find((one: any) => one.task_id === ids[2]).sources[0].transport, 'kimi-wire')
  vite = await createVite({ configFile: false, root: here, cacheDir: join(root, 'vite-cache'), optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] }, server: { host: '127.0.0.1', port: 9394, strictPort: true, fs: { allow: [plugin] }, proxy: { '/api': { target: server.url, rewrite: path => path.replace(/^\/api/, '') } } }, resolve: { alias: ['react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'react-dom', 'react'].map(name => ({ find: new RegExp(`^${name}$`), replacement: join(plugin, 'node_modules', `${name}${name === 'react' || name === 'react-dom' ? '/index.js' : '.js'}`) })) }, esbuild: { jsx: 'automatic' } })
  await writeFile(join(evidence, 'public-state-before.json'), JSON.stringify(await api('/state'), null, 2))
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
  await wait("document.body.innerText.includes('业务任务正在执行 2 件')")
  const results: unknown[] = []
  const lifecycle: unknown[] = [{ step: 'started', running: (await api('/state')).running }]
  async function shot(name: string) { const got = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(evidence, name+'.png'), Buffer.from(got.data, 'base64')) }
  for (const [width, height] of [[1024, 768], [780, 720], [780, 520], [520, 680], [1440, 900]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await new Promise(r => setTimeout(r, 700))
    const geometry = await evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom}};return {heading:rect(document.querySelector('.ben-wb__business-execution>button')),orb:rect(document.querySelector('.ben-wb__task-orb-anchor')),input:rect(document.querySelector('textarea')),cards:[...document.querySelectorAll('[data-task-card]')].map(rect),text:document.body.innerText}})()`)
    assert.ok(geometry.heading.y >= 0 && geometry.heading.bottom < height, 'business heading visible without scrolling')
    assert.ok(geometry.orb.h >= 100 && geometry.orb.bottom <= geometry.input.y, 'orb stays above composer')
    assert.ok(geometry.cards.every((r: any) => r.bottom < geometry.input.y), 'execution cards stay above composer'); results.push({ width, height, ...geometry }); await shot(`business-${width}x${height}`)
    await evaluate(`document.querySelector('.ben-wb__business-execution>button').click()`)
    await wait(`!!document.querySelector('[aria-label="正在执行的业务任务"]')`)
    if (height <= 520) assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ben-wb__task-constellation')).display`), 'none', 'short expanded execution list must leave the orb visible instead of placing duplicate cards over it')
    const list = await evaluate(`(()=>{const e=document.querySelector('[aria-label="正在执行的业务任务"]'); const r=e.getBoundingClientRect();return {text:e.innerText,count:e.querySelectorAll('li').length,bottom:r.bottom}})()`)
    assert.equal(list.count, 2); assert.ok(!list.text.includes('统筹 Codex')); assert.ok(list.text.toLowerCase().includes('kimi'))
    assert.ok(list.bottom < height, 'list fits normal window')
    await shot(`business-list-${width}x${height}`)
    const readability = await evaluate(`(()=>{
      const list=document.querySelector('[aria-label="正在执行的业务任务"]');
      const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}};
      const bounds=rect(list), center=rect(document.querySelector('.ben-wb__items-center')), input=rect(document.querySelector('textarea'));
      const blocked=[...list.querySelectorAll('li>button,li>p')].filter(e=>{const r=rect(e);return r.top>=bounds.top+45&&r.bottom<=bounds.bottom}).flatMap(e=>{
        const r=rect(e), hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
        return hit&&!list.contains(hit)?[{text:e.textContent,cover:hit.className}]:[];
      });
      return {bounds,center,input,blocked};
    })()`)
    await writeFile(join(evidence, `readability-${width}x${height}.json`), JSON.stringify(readability,null,2))
    assert.deepEqual(readability.blocked, [], 'execution list text is covered by background content')
    assert.ok(readability.bounds.top >= readability.center.bottom && readability.bounds.bottom <= readability.input.top, 'execution list is partitioned from stage text and composer')
    const scrolled = await evaluate(`(()=>{
      const list=document.querySelector('[aria-label="正在执行的业务任务"]');list.scrollTop=list.scrollHeight;
      const action=list.querySelector('li:last-child>p:last-child'), r=action.getBoundingClientRect(), bounds=list.getBoundingClientRect();
      const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
      return {scrollTop:list.scrollTop,scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,action:action.textContent,visible:r.top>=bounds.top&&r.bottom<=bounds.bottom,uncovered:!!hit&&list.contains(hit)};
    })()`)
    assert.ok(scrolled.visible && scrolled.uncovered, 'last business task action is readable after scrolling')
    assert.ok(scrolled.scrollHeight <= scrolled.clientHeight || scrolled.scrollTop > 0, 'overflowed list can scroll')
    results.push({width,height,readability,scrolled})
    await shot(`business-list-scrolled-${width}x${height}`)
    await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent==='收起执行清单').click()`)
    await wait(`!document.querySelector('[aria-label="正在执行的业务任务"]')`)
    await shot(`business-list-collapsed-${width}x${height}`)
    await evaluate(`document.querySelector('.ben-wb__business-execution>button').click()`)
    await evaluate(`document.querySelector('[aria-label="正在执行的业务任务"]').scrollTop=99999`)
    await evaluate(`document.querySelector('[aria-label="打开业务任务:补齐异常分支"]').click()`)
    await wait(`document.querySelector('[aria-label="当前聚焦事项"]')?.innerText.includes('补齐异常分支')`)
    assert.ok(!(await evaluate(`document.querySelector('[aria-label="当前聚焦事项"]').innerText`)).includes('掉线'), 'public running source cannot appear offline in task detail')
    await shot(`business-task-${width}x${height}`)
    await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent==='返回待机').click()`)
  }
  // Both transitions go through the actual isolated API. Source events remain controlled fixtures.
  await codexEvent('qa-source-0', 'task_complete', 'r-1', '做完: 受控来源交回')
  await wait("document.body.innerText.includes('业务任务正在执行 1 件')")
  await shot('business-returned')
  lifecycle.push({ step: 'returned', running: (await api('/state')).running })
  await api('/task/move', { id: ids[0], status: 'doing' })
  eventTime = Math.floor(Date.now() / 1000) * 1000 - 1000
  await codexEvent('qa-source-0', 'task_started', 'r-2')
  const reopened = await api('/state')
  await writeFile(join(evidence, 'state-reopened.json'), JSON.stringify({ task: reopened.tasks.tasks.find((one: any) => one.id === ids[0]), execution: reopened.execution.items.find((one: any) => one.task_id === ids[0]), running: reopened.running }, null, 2))
  await wait("document.body.innerText.includes('业务任务正在执行 2 件')")
  await shot('business-rework')
  lifecycle.push({ step: 'rework', running: (await api('/state')).running })
  const firstRef = refs.find(one => one.session_id === 'qa-source-0')!, originalFile = firstRef.file
  firstRef.file = join(root, '.codex', 'sessions', '2026', '10', '26', 'controlled-missing.jsonl')
  const partial = await api('/state')
  assert.equal(partial.running.count, undefined)
  assert.equal(partial.running.observed_count, 1)
  await wait("document.body.innerText.includes('已观测业务任务 1 件 · 总数未知')")
  await shot('business-partial-unknown')
  lifecycle.push({ step: 'one source missing; one business observed', running: partial.running })
  firstRef.file = originalFile
  await wait("document.body.innerText.includes('业务任务正在执行 2 件')")
  allowed = false
  await wait("document.querySelector('.ben-wb__business-execution>button')?.innerText.includes('业务任务执行状态未知')")
  await shot('business-disconnected')
  const offlineBounds = await evaluate(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {stageBottom:r('.ben-wb__task-stage').bottom,centerBottom:r('.ben-wb__items-center').bottom,belowTop:r('.ben-wb__scene-below').top}})()`)
  assert.ok(offlineBounds.stageBottom <= offlineBounds.belowTop && offlineBounds.centerBottom <= offlineBounds.belowTop, 'waiting cards cannot cover the offline orb or status: '+JSON.stringify(offlineBounds))
  lifecycle.push({ step: 'disconnected', running: (await api('/state')).running })
  await server.close()
  service = createWorkbenchService()
  await jobs.flush(); tasks = createTasksService({ file: tasksFile }); jobs = createJobLog({ file: jobsFile }); await jobs.load(); allowed = true
  server = await openServer()
  await wait("document.body.innerText.includes('业务任务正在执行 2 件')")
  await shot('business-restarted-replay')
  lifecycle.push({ step: 'server restarted; same controlled files replayed by public reconciler', running: (await api('/state')).running })
  await writeFile(join(evidence, 'lifecycle.json'), JSON.stringify({ scope: 'real isolated HTTP restart + public execution file replay; controlled source files, not authors’ CLI originals', lifecycle }, null, 2))
  await writeFile(join(evidence, 'layout.json'), JSON.stringify({ fixture: 'production React + real public /state and reconciler; controlled Codex/Kimi source files; not physical App/phone or author CLI sessions', results, exceptions }, null, 2))
  assert.equal(exceptions.length, 0)
  console.log('browser snapshots saved; geometry requires visual review')
} finally {
  socket?.close()
  if (chrome !== undefined) { chrome.kill('SIGTERM'); await new Promise<void>(ok => { if (chrome!.exitCode !== null) ok(); else chrome!.once('exit', () => ok()) }) }
  await vite?.close(); await server.close()
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
