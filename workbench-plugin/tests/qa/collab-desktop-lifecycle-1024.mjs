/** Opt-in real browser + production API + native authenticated Codex acceptance.
 * Run manually with node; never included in the unit suite. All work/data live in a temporary project.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync, readFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const fConsumer = process.env.COLLAB_QA_F_SOURCE === '1'
const clockConsumer = process.env.COLLAB_QA_CLOCK === '1'
const fix66 = process.env.COLLAB_QA_FIX_66 === '1'
const readonlyDelta = fix66 || clockConsumer || fConsumer
if (fix66 || clockConsumer) assert(process.env.COLLAB_QA_REUSE_DIR || process.env.COLLAB_QA_PRIOR_DIR, 'fixed delta QA requires actual prior artifacts')
const plugin = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const corePlugin = process.env.COLLAB_QA_CORE_ROOT ?? plugin
const invite = process.env.COLLAB_QA_INVITE !== '0'
const lan = process.env.COLLAB_QA_LAN !== '0'
const serverModule = name => import(pathToFileURL(join(corePlugin, 'src/server', name)).href)
const { createWorkbenchService } = await serverModule('service.ts')
const { createTasksService } = await serverModule('tasks.ts')
const { createJobLog } = await serverModule('jobLog.ts')
const { createPersonalTokens } = await serverModule('personalToken.ts')
const { createActionGate } = await serverModule('actionGate.ts')
const { createEngineWiring } = await serverModule('engine/wire.ts')
const { lowPriorityCommand } = await serverModule('lowPriority.ts')
const { startWorkbenchServer } = await serverModule('http.ts')
const { createPairingService } = await serverModule('devices.ts')
const dir = process.env.COLLAB_QA_REUSE_DIR ?? mkdtempSync(join(tmpdir(), 'collab-desktop-sol-'))
assert(dir.startsWith(join(tmpdir(), 'collab-desktop-sol-')), 'QA directory must be an isolated temporary run')
if (readonlyDelta && process.env.COLLAB_QA_PRIOR_DIR) {
  const prior = process.env.COLLAB_QA_PRIOR_DIR
  assert(prior.startsWith(join(tmpdir(), 'collab-desktop-sol-')), 'only controlled prior QA directories are accepted')
  const provenance = []
  for (const relative of ['primary/tasks.json', 'primary/jobs.jsonl', 'peer/tasks.json', 'peer/jobs.jsonl']) {
    const source = join(prior, relative)
    if (!existsSync(source)) continue
    mkdirSync(dirname(join(dir, relative)), { recursive: true })
    copyFileSync(source, join(dir, relative))
    provenance.push({ source, file: relative, sha256: createHash('sha256').update(readFileSync(source)).digest('hex') })
  }
  writeFileSync(join(dir, 'prior-evidence-provenance.json'), JSON.stringify(provenance, null, 2))
}
const project = join(dir, 'project')
if (!existsSync(project)) {
  mkdirSync(project)
  execFileSync('git', ['init', '-q', project])
  writeFileSync(join(project, 'numbers.txt'), '17\n29\n43\n')
}
const evidence = existsSync(join(dir, 'evidence.json')) ? JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) : { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: plugin, encoding: 'utf8' }).trim(), dir, checks: [] }
const record = (name, data = {}) => { evidence.checks.push({ name, at: new Date().toISOString(), ...data }); writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(name, JSON.stringify(data)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(read, accepts, label, timeout = 20000) {
  const end = Date.now() + timeout
  let value
  do { value = await read(); if (accepts(value)) return value; await sleep(200) } while (Date.now() < end)
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
const children = new Set()
const services = []
const wiring = []
let client
let fFixture
const stop = async () => {
  client?.close()
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} } }
  for (const service of services.reverse()) await service.close()
  for (const one of wiring) one.close()
}
const startChild = (bin, args, options = {}) => { const p = spawn(bin, args, { stdio: 'ignore', detached: true, ...options }); children.add(p); p.once('exit', () => children.delete(p)); return p }

async function serve(name, port, execute = false) {
  const root = join(dir, name); mkdirSync(root, { recursive: true })
  const tasks = createTasksService({ file: join(root, 'tasks.json'), ...(fFixture === undefined ? {} : { now: () => fFixture.now() / 1000 }) })
  const jobLog = createJobLog({ file: join(root, 'jobs.jsonl') })
  await jobLog.load()
  const gate = createActionGate({ phaseOf: () => 'unknown', log: jobLog, now: () => new Date() })
  const engine = createEngineWiring({ gate, log: jobLog }); wiring.push(engine)
  const server = await startWorkbenchServer({
    port, service: createWorkbenchService(fFixture === undefined ? {} : { now: () => fFixture.now() / 1000 }), tasks, jobLog,
    ...(fFixture === undefined || name !== 'primary' ? {} : { feed: fFixture.feed }), tickIntervalMs: 0, heartbeatMs: 0,
    personalTokens: createPersonalTokens({ file: join(root, 'pat.json') }),
    pairing: createPairingService({ file: join(root, 'devices.json') }),
    collabWorkdir: async () => root,
    paths: { home: root, moduleDir: join(plugin, 'src/server') },
    ...(readonlyDelta ? {} : { engine: engine.engine, engineRegistry: engine.registry, actionGate: gate }),
    ...(execute ? { dispatchRun: {
      resultDir: root, pollMs: 1000,
      runCli: cmd => {
        const fd = openSync(cmd.logFile, 'a')
        const low = lowPriorityCommand(cmd.bin, cmd.argv)
        const child = startChild(low.file, low.args, { cwd: cmd.cwd, stdio: ['ignore', fd, fd], env: cmd.env ?? process.env })
        closeSync(fd)
        const exited = new Promise(resolve => { child.once('exit', code => resolve({ code })); child.once('error', () => resolve({ code: null })) })
        return { pid: child.pid, exited }
      },
    } } : {}),
  })
  services.push(server)
  return server
}
async function api(server, path, body) {
  const response = await fetch(`${server.url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:9991' }, body: JSON.stringify(body) })
  const data = await response.json()
  assert(response.ok, `${path}: ${response.status} ${data.error ?? ''}`)
  return data
}
async function cdp() {
  const browserDir = join(dir, 'browser')
  startChild('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${browserDir}`, '--remote-debugging-port=9992', 'about:blank'])
  await until(() => fetch('http://127.0.0.1:9992/json/version').then(r => r.ok).catch(() => false), Boolean, 'Chrome ready')
  const target = await fetch('http://127.0.0.1:9992/json/new?about:blank', { method: 'PUT' }).then(r => r.json())
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0; const waiting = new Map()
  ws.onmessage = event => { const msg = JSON.parse(String(event.data)); const pending = waiting.get(msg.id); if (pending) { waiting.delete(msg.id); msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result) } }
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad })
  const send = (method, params = {}) => new Promise((resolve, reject) => { waiting.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; window.addEventListener('error', event => window.__errs.push(event.message)); window.addEventListener('unhandledrejection', event => window.__errs.push(String(event.reason)));` })
  return { send, close: () => ws.close() }
}
async function evaluate(expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
const shown = expression => until(() => evaluate(expression), Boolean, expression)
const click = (name, root = 'document') => evaluate(`Array.from((${root}).querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(name)})?.click()`)
const input = async (label, value, root = 'document') => { await shown(`!!(${root})?.querySelector(${JSON.stringify(`[aria-label=${JSON.stringify(label)}]`)})`); return evaluate(`(() => { const el = (${root}).querySelector(${JSON.stringify(`[aria-label=${JSON.stringify(label)}]`)}); if (!el) throw new Error('missing input: '+${JSON.stringify(label)}); Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`) }
const conditionRow = name => `Array.from(document.querySelectorAll('.ben-cl__gc-item')).find(el => el.querySelector('.ben-cl__gc-text')?.textContent === ${JSON.stringify(name)})`

try {
  if (fConsumer) {
    const { createFSourceFixture } = await import('./collab-desktop-f-source-consumer.mjs')
    fFixture = await createFSourceFixture({ dir, createFeedService: (await serverModule('feed.ts')).createFeedService })
    services.push({ close: fFixture.close })
  }
  const primary = await serve('primary', 9993, !readonlyDelta)
  let peer = await serve('peer', 9994)
  const uiHash = createHash('sha256')
  for (const file of readdirSync(join(plugin, 'src/client/collab')).sort()) if (/\.tsx?$/.test(file)) uiHash.update(file).update(readFileSync(join(plugin, 'src/client/collab', file)))
  record('isolated_servers_started', { primary: primary.url, peer: peer.url, uiSourceHash: uiHash.digest('hex'), coreSource: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: corePlugin, encoding: 'utf8' }).trim(), coreDeltaHash: createHash('sha256').update(execFileSync('git', ['diff', '--', 'src/protocol.ts', 'src/server'], { cwd: corePlugin })).digest('hex') })
  if (fConsumer) {
    const { fSourceAcceptance } = await import('./collab-desktop-f-source-consumer.mjs')
    await fSourceAcceptance({ dir, plugin, primary, peer, fixture: fFixture, api, record, startChild, until, browser: async () => { client = await cdp(); return client }, evaluate, shown, closePeer: async () => { services.splice(services.indexOf(peer), 1); await peer.close() }, restartPeer: async () => { peer = await serve('peer', 9994); return peer } })
    record('qa_completed', { newModelTasks: 0, physicalMachines: false })
  } else if (clockConsumer) {
    const { clockAcceptance } = await import('./collab-desktop-clock-consumer.mjs')
    await clockAcceptance({ dir, plugin, primary, api, record, startChild, until, browser: async () => { client = await cdp(); return client }, evaluate, shown })
    record('qa_completed', { newModelTasks: 0 })
  } else if (fix66) {
    const { concentratedAcceptance } = await import('./collab-desktop-66-fix.mjs')
    await concentratedAcceptance({ dir, plugin, primary, peer, api, record, startChild, until, closePeer: async () => { services.splice(services.indexOf(peer), 1); await peer.close() }, browser: async () => { client = await cdp(); return client }, evaluate, input, click, shown })
    record('qa_completed')
  } else {
  const initial = await api(primary, '/state')
  const card = initial.tasks.agent_cards?.find(one => one.name === 'QA Codex 只读核验') ?? await api(primary, '/collab/agent/save', { name: 'QA Codex 只读核验', hand: 'cli', runtime: { family: 'codex' }, model: { name: 'gpt-6.1-sol', effort: 'medium' }, project: { repo: project } })
  const goal = initial.tasks.goals?.find(one => one.title === '隔离真实生命周期') ?? await api(primary, '/collab/goal/create', { title: '隔离真实生命周期' })
  const made = initial.tasks.tasks.find(one => one.title === '读取测试数据求和') ?? await api(primary, '/task/create', { title: '读取测试数据求和', status: 'todo', assignee: card.id, goal_id: goal.id, from: { kind: 'said', quote: '隔离 QA：读取受控测试文件并核对总和' }, acceptance: ['读取 numbers.txt 并给出准确总和'] })
  const taskId = made.id
  if (made.dispatch?.status !== 'done') {
    const dispatched = await api(primary, '/dispatch/run', { item_id: taskId, app: 'codex', kind: 'code', text: '这是隔离验收任务，不是研发委派。只读取当前目录 numbers.txt，用命令计算三行整数总和，不修改任何文件，不启动代理。完成后用中文准确回复：做完:1 总和=<实际计算结果>；说明执行的计算命令。' })
    record('native_codex_dispatched', { ok: dispatched.ok, taskId })
    assert.equal(dispatched.ok, true)
  } else record('reuse_real_codex_receipt', { taskId })
  const completed = await until(() => api(primary, '/state').then(s => s.tasks.tasks.find(t => t.id === taskId)), t => ['done', 'failed'].includes(t.dispatch?.status), 'native Codex completion', 180000)
  assert.equal(completed.dispatch.status, 'done', completed.dispatch.note)
  assert.match(completed.receipt?.text ?? '', /89/)
  record('native_codex_receipt', { status: completed.status, receipt: completed.receipt, dispatch: { family: completed.dispatch.family, status: completed.dispatch.status }, events: primary.jobLog.events(taskId).map(e => ({ step: e.step, family: e.family, at: e.at })) })

  let invitationParent
  let invitationChild
  if (invite) {
    const invitationGoal = initial.tasks.goals?.find(one => one.title === '协作邀请目标') ?? await api(primary, '/collab/goal/create', { title: '协作邀请目标', project_id: 'qa-shared-project' })
    invitationParent = initial.tasks.tasks.find(one => one.title === '协作核验原事项') ?? await api(primary, '/task/create', { title: '协作核验原事项', status: 'todo', assignee: 'me', goal_id: invitationGoal.id, project_id: 'qa-shared-project', from: { kind: 'said', quote: '隔离 QA：从原事项邀请协作者核对真实测试输入' }, acceptance: ['协作者交回准确求和回执'] })
    const invitation = { task_id: invitationParent.id, client_msg_id: `qa-invite-${taskId}-${process.env.COLLAB_QA_INVITE_RUN_ID ?? '1'}`, intent: 'ask', mentions: [card.id], text: '请在项目里检查 numbers.txt，只读取文件，用命令求三行整数总和，不修改文件，不启动代理；准确回复 做完:1 总和=<实际结果>，并说明实际计算命令。' }
    const sent = await api(primary, '/collab/note/message', invitation)
    const childId = sent.message.deliveries[0].task_id
    invitationChild = childId
    assert(childId, 'invitation must identify its exact execution task')
    record('native_invitation_sent', { parent: invitationParent.id, messageId: sent.message.id, childId, status: sent.message.deliveries[0].status })
    await api(primary, '/collab/note/message', invitation)
    const correlated = await until(() => api(primary, `/collab/note/activity?id=${invitationParent.id}`).then(data => data.items.find(item => item.type === 'message' && item.message.id === sent.message.id)?.message.deliveries[0]), delivery => {
      if (delivery?.status === 'failed') throw new Error(`invitation execution failed: ${delivery.error}`)
      return delivery?.status === 'accepted' && delivery.receipt !== undefined
    }, 'precise invitation receipt', 180000)
    assert.equal(correlated.task_id, childId)
    assert.match(correlated.receipt.text, /89/)
    const after = (await api(primary, '/state')).tasks.tasks.find(one => one.id === invitationParent.id)
    assert.equal(after.assignee, 'me')
    assert.equal(after.children.filter(id => id === childId).length, 1)
    const events = await until(async () => primary.jobLog.events(childId), events => events.some(event => event.step === 'replied'), 'natural replied event')
    assert(events.some(event => event.step === 'started'), 'actual provider stream must supply started')
    assert(events.some(event => event.step === 'replied'), 'natural CLI finish must supply replied')
    record('native_invitation_correlated_receipt', { parent: invitationParent.id, childId, status: correlated.status, receipt: correlated.receipt, events: events.map(event => ({ step: event.step, at: event.at })) })
  }

  if (lan) {
    const projectId = 'qa-shared-project'
    await api(primary, '/collab/goal/update', { id: goal.id, project_id: projectId })
    await api(peer, '/collab/goal/create', { title: '隔离对端共同项目', project_id: projectId })
    const pair = async (from, to) => {
      const pairing = await api(to, '/pair/start', {})
      const identity = (await api(to, '/collab/lan/identity')).identity
      await api(from, '/collab/lan/connect', { host: '127.0.0.1', port: to.port, member_id: identity.member_id, code: pairing.pairing.code })
      return identity
    }
    const peerIdentity = await pair(primary, peer)
    const selfIdentity = await pair(peer, primary)
    const original = await api(primary, '/collab/lan/channel/send', { project_id: projectId, text: 'QA：请核对真实 Codex 求和回执 89', recipients: [peerIdentity.member_id], client_msg_id: `sum-${taskId}` })
    assert(['delivered', 'accepted'].includes(original.message.deliveries[0].status))
    const incoming = await api(peer, `/collab/lan/channel?project_id=${projectId}`)
    assert(incoming.messages.some(message => message.id === original.message.id && message.author.member_id === selfIdentity.member_id))
    await api(primary, '/collab/lan/channel/send', { project_id: projectId, text: 'QA：请核对真实 Codex 求和回执 89', recipients: [peerIdentity.member_id], client_msg_id: `sum-${taskId}` })
    assert.equal((await api(peer, `/collab/lan/channel?project_id=${projectId}`)).messages.filter(message => message.id === original.message.id).length, 1)
    const sum = readFileSync(join(project, 'numbers.txt'), 'utf8').trim().split('\n').map(Number).reduce((a, b) => a + b, 0)
    assert.equal(sum, 89)
    await api(peer, '/collab/lan/channel/send', { project_id: projectId, text: `做完: QA 核对报告，输入求和 ${sum}，与真实 Codex 回执一致`, kind: 'report', reply_to: original.message.id, recipients: [selfIdentity.member_id], client_msg_id: `report-${taskId}` })
    const returned = await api(primary, `/collab/lan/channel?project_id=${projectId}`)
    assert.equal(returned.messages.find(message => message.id === original.message.id).deliveries[0].status, 'accepted')
    assert(!JSON.stringify(returned).includes('Bearer'))
    record('two_local_instances_lan_roundtrip', { messageId: original.message.id, scope: 'controlled-local-instances', delivered: true, reportCorrelated: true, duplicateCount: 1, physicalMachines: false })
    await api(primary, '/collab/lan/members?refresh=1')
    await api(peer, '/collab/lan/members?refresh=1')
    await api(primary, '/collab/lan/identity', { name: 'QA 主端' })
    await api(peer, '/collab/lan/identity', { name: 'QA 对端' })
    const refreshed = await api(primary, '/collab/lan/members?refresh=1')
    assert.equal(refreshed.members.find(member => member.member_id === peerIdentity.member_id).name, 'QA 对端')
    const rejected = async (body, match) => {
      const response = await fetch(`${primary.url}/collab/lan/identity`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(response.status, 409)
      assert.match((await response.json()).error, match)
    }
    await rejected({ name: 'QA 对端' }, /重复/)
    const version = (await api(primary, '/collab/lan/identity')).identity.version
    await rejected({ name: 'QA 主端', expected_version: version - 1 }, /版本|冲突/)
    services.splice(services.indexOf(peer), 1)
    await peer.close()
    const missing = await api(primary, '/collab/lan/members?refresh=1')
    assert.equal(missing.members.find(member => member.member_id === peerIdentity.member_id).reachable, false)
    await rejected({ name: 'QA 新名字', members_refreshed: true }, /不完整|未知/)
    const failed = await api(primary, '/collab/lan/channel/send', { project_id: projectId, text: '对端离线的真实投递检查', recipients: [peerIdentity.member_id], client_msg_id: `offline-${taskId}` })
    assert.equal(failed.message.deliveries[0].status, 'failed')
    peer = await serve('peer', 9994)
    const recovered = await api(primary, '/collab/lan/members?refresh=1')
    assert.equal(recovered.members.find(member => member.member_id === peerIdentity.member_id).reachable, true)
    const resent = await api(primary, '/collab/lan/channel/send', { project_id: projectId, text: '对端恢复后真实投递检查', recipients: [peerIdentity.member_id], client_msg_id: `recovered-${taskId}` })
    assert.equal(resent.message.deliveries[0].status, 'delivered')
    record('lan_stable_identity_rename_conflicts_offline_and_recovery', { physicalMachines: false })
  }

  const require = createRequire(import.meta.url)
  const vite = join(dirname(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json')), 'bin/vite.js')
  startChild(process.execPath, [vite, '--config', 'dev/collab-board/vite.config.mjs', '--port', '9991', '--strictPort'], { cwd: plugin })
  await until(() => fetch('http://127.0.0.1:9991/desktop-test.html').then(r => r.ok).catch(() => false), Boolean, 'Vite ready')
  client = await cdp()
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await client.send('Page.navigate', { url: `http://127.0.0.1:9991/desktop-test.html?live=1&view=goals&api=${encodeURIComponent(primary.url)}` })
  await shown(`document.querySelector('.ben-cl__reading') && document.body.innerText.includes('读取测试数据求和')`)
  if (invitationParent) {
    await evaluate(`Array.from(document.querySelectorAll('.ben-cl__note-title')).find(el => el.textContent.trim() === '协作核验原事项')?.click()`)
    await shown(`document.querySelector('.ben-cl__dialog')?.textContent.includes('总和=89') && Array.from(document.querySelectorAll('button')).some(button => button.textContent === '查看协作执行事项')`)
    await evaluate(`document.querySelector('button[data-task-id="${invitationChild}"]')?.click()`)
    await shown(`document.querySelector('.ben-cl__dialog')?.textContent.includes('实际运行')`)
    record('production_react_invitation_receipt_and_task_navigation')
    await evaluate(`document.querySelector('button[aria-label="关上"]')?.click()`)
  }
  if (lan) {
    await click('频道')
    await shown(`document.querySelector('[aria-label="局域网项目频道"]')?.textContent.includes('QA 核对报告')`)
    assert.equal(await evaluate(`document.querySelector('[aria-label="局域网项目频道"] textarea') === null`), true)
    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(dir, 'lan-channel.png'), Buffer.from(shot.data, 'base64'))
    record('production_react_lan_channel_readonly')
    await click('目标')
    await shown(`!!document.querySelector('.ben-cl__reading')`)
  }
  if (process.env.COLLAB_QA_LAN_ONLY !== '1') {
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === '看目标 隔离真实生命周期 的条件')?.click()`)
  await shown(`!!document.querySelector('.ben-cl__goalpanel')`)
  const conditions = ['能读取三行受控输入', '能给出准确总和', '能交回可复核的实际命令']
  for (const name of conditions) {
    await input('新条件(用户能做成的一件事)', name)
    await click('加条件')
    await shown(`!!(${conditionRow(name)})`)
    await evaluate(`(() => { const el = (${conditionRow(name)}).querySelector('select'); el.value = ${JSON.stringify(taskId)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await input(`验收证据 · ${name}`, `${join(project, 'numbers.txt')}\n真实 CLI 回执：总和 89，并有实际计算命令`)
    await click('保存承接与证据', conditionRow(name))
    await shown(`(${conditionRow(name)})?.querySelector('.ben-cl__gc-state')?.textContent === '交回待验'`)
  }
  await input('核验依据', '请重新检查输入并逐项答复验收结果', conditionRow(conditions[1]))
  await click('验收不过', conditionRow(conditions[1]))
  await shown(`(${conditionRow(conditions[1])})?.querySelector('.ben-cl__gc-state')?.textContent === '退回重做'`)
  await api(primary, '/task/move', { id: taskId, status: 'doing' })
  await api(primary, '/dispatch/run', { item_id: taskId, app: 'codex', kind: 'code', text: '这是同一隔离验收事项退回后的新轮。只读 numbers.txt，实际执行命令重新求和，核对三行输入，说明可复核命令，不改文件，不启动代理。逐项回复 做完:1 总和=<实际计算值>；包含实际输入行数和执行命令。' })
  const reworked = await until(() => api(primary, '/state').then(s => s.tasks.tasks.find(t => t.id === taskId)), t => t.dispatch?.status === 'done' && t.status === 'confirm', 'real rework completion', 180000)
  assert.match(reworked.receipt?.text ?? '', /89/)
  assert.equal(reworked.round, 2)
  record('native_rework_completed', { taskId, round: reworked.round, receipt: reworked.receipt })
  for (const name of conditions) {
    await shown(`!!(${conditionRow(name)})?.querySelector('[aria-label="核验依据"]')`)
    await input('核验依据', '对照三行输入 17+29+43=89，新轮真实 CLI 已交回命令', conditionRow(name))
    await click('核验通过', conditionRow(name))
    await shown(`(${conditionRow(name)})?.querySelector('.ben-cl__gc-state')?.textContent === '已验收'`)
    await click('记交付', conditionRow(name))
    await shown(`(${conditionRow(name)})?.querySelector('.ben-cl__gc-state')?.textContent === '已交付'`)
  }
  const board = await api(primary, `/collab/goal/board?goal_id=${goal.id}`)
  assert.equal(board.summary.conditions.by_state.delivered, 3)
  assert.equal(board.summary.tasks.total, 1)
  record('three_conditions_one_real_task_delivered', { conditions: 3, tasks: 1 })
  await api(primary, '/task/move', { id: taskId, status: 'doing' })
  await shown(`Array.from(document.querySelectorAll('.ben-cl__gc-state')).filter(el => el.textContent === '退回重做').length === 3 && document.body.innerText.includes('旧轮证据')`)
  record('production_react_verified_delivered_reopened')
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(dir, 'goal-reopened.png'), Buffer.from(screenshot.data, 'base64'))
  await evaluate(`document.querySelector('button[aria-label="关上"]')?.click()`)
  }
  await click('时间线')
  await shown(`document.querySelector('[aria-label="实际执行记录"]')?.textContent.includes('读取测试数据求和')`)
  await shown(`document.querySelector('[aria-label="实际执行记录"] [data-status="done"]') !== null`)
  record('production_react_timeline_actual_execution')
  await click('目标')
  await evaluate(`Array.from(document.querySelectorAll('.ben-cl__note-title')).find(el => el.textContent.trim() === '读取测试数据求和')?.click()`)
  await shown(`!!document.querySelector('[aria-label="留一句"]')`)
  await input('留一句', '断线仍保留的未发送草稿')
  await client.send('Network.enable')
  await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  await shown(`document.body.innerText.includes('Agent 掉线')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="留一句"]').value`), '断线仍保留的未发送草稿')
  assert.equal(await evaluate(`document.body.innerText.includes('读取测试数据求和')`), true)
  await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await shown(`!document.body.innerText.includes('Agent 掉线')`)
  await client.send('Page.reload')
  await shown(`!!document.querySelector('.ben-cl__reading')`)
  await evaluate(`Array.from(document.querySelectorAll('.ben-cl__note-title')).find(el => el.textContent.trim() === '读取测试数据求和')?.click()`)
  await shown(`document.querySelector('[aria-label="留一句"]')?.value === '断线仍保留的未发送草稿'`)
  record('production_react_network_loss_recovery_and_draft_reload')
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
  assert.equal(await evaluate('document.documentElement.scrollWidth <= 1024'), true)
  const narrow = await client.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(dir, 'desktop-1024.png'), Buffer.from(narrow.data, 'base64'))
  await evaluate(`document.querySelector('button[aria-label="关上"]')?.click()`)
  await click('频道')
  await shown(`!!document.querySelector('.ben-cl__lan-connect')`)
  await evaluate(`document.querySelector('.ben-cl__lan-connect').open = true`)
  assert.equal(await evaluate('document.documentElement.scrollWidth <= 1024'), true)
  const lanNarrow = await client.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(dir, 'lan-1024.png'), Buffer.from(lanNarrow.data, 'base64'))
  await click('目标')
  await shown(`!!document.querySelector('.ben-cl__reading')`)
  await evaluate(`document.querySelector('button[aria-label="看目标 隔离真实生命周期 的条件"]')?.click()`)
  await shown(`document.querySelectorAll('.ben-cl__gc-state').length === 3`)
  assert.equal(await evaluate('document.documentElement.scrollWidth <= 1024'), true)
  const goalNarrow = await client.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(dir, 'goal-1024.png'), Buffer.from(goalNarrow.data, 'base64'))
  record('production_react_goal_pairing_channel_1024_readable')
  const errors = await evaluate('window.__errs ?? []')
  record('browser_errors', { errors })
  assert.deepEqual(errors, [])
  record('qa_completed')
  }
} catch (error) {
  record('qa_failed', { message: error.message })
  if (client) {
    try { record('browser_failure_dom', { body: await evaluate('document.body.innerText'), errors: await evaluate('window.__errs ?? []') }); const shot = await client.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(dir, 'failure.png'), Buffer.from(shot.data, 'base64')) } catch {}
  }
  process.exitCode = 1
} finally {
  await stop()
  console.log(`Evidence: ${join(dir, 'evidence.json')}`)
}
