/** Isolated production HTTP + React lifecycle. No personal HOME, credentials, DSH process or remote services.
 * The session adapter emits the canonical stage question and records browser replies only; it never generates content or fabricates task success.
 * Tests may submit explicit tool answers through the actual /onboarding/answer API, separately recorded.
 *
 * 真实模式(全部显式开关,缺省仍是受控:模型 fetch 抛错、不接例程、不接派活引擎,62 项不受影响):
 *  - C03125_REAL_MODEL=1:模型配置**只读引用**本机真实 ~/.dsh/workbench/model.json 与 credentials.json
 *    (由 run.mjs 经 C03125_REAL_HOME 传原始 HOME;路径不复制、不打印、不进证据)。fetch 真发并计数;
 *    POST /qa/break-model 把下一击模型调用掐断一次(恢复性测试用)。接上真例程服务:早报真生成
 *    (日报四段那一下走真模型),证据只记状态与段数,不记正文。
 *  - C03125_REAL_DISPATCH=1 / C03125_STUB_DISPATCH=1:接派活引擎(登记表 + 命令行通道 + 动作闸 + 任务账),
 *    登记一张 Kimi 执行者名片(runtime kimi、仓库=隔离项目、每件事 10 分钟上限)。
 *    REAL 起本机真 kimi 子进程(环境里的 HOME 指回真实家目录,用维护者既有登录态,不克隆凭据);
 *    STUB 起 node 替身(自测开关机构,不花额度、不真跑 Kimi)。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, openSync, closeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { resolveAcceptanceDependencies } from './dependencies.mjs'
const here = dirname(fileURLToPath(import.meta.url)), plugin = resolve(here, '../..')
const root = process.env.C03125_ROOT
if (!root || !process.env.HOME?.startsWith(root + '/')) throw new Error('explicit isolated HOME required')
const realModel = process.env.C03125_REAL_MODEL === '1'
const realDispatch = process.env.C03125_REAL_DISPATCH === '1'
const stubDispatch = process.env.C03125_STUB_DISPATCH === '1'
const dispatchMode = realDispatch || stubDispatch
const realHome = process.env.C03125_REAL_HOME ?? ''
if ((realModel || realDispatch) && (realHome === '' || !existsSync(join(realHome, '.dsh/workbench/model.json')) || !existsSync(join(realHome, '.dsh/workbench/credentials.json')))) {
  // 不打印真实路径(纪律:真实配置的路径不进日志/证据)。
  throw new Error('real mode requires C03125_REAL_HOME with workstation model config')
}
const dir = join(process.env.HOME, '.dsh/workbench'), repo = join(root, 'project')
mkdirSync(dir, { recursive: true }); mkdirSync(join(repo, 'docs/记忆/项目'), { recursive: true })
writeFileSync(join(repo, 'README.md'), '# 隔离验收项目\n\n')
const nm = n => join(plugin, 'node_modules', n)
const dependencies = resolveAcceptanceDependencies(plugin)
const { createServer } = await import(dependencies.viteEntry)
let api, apiPort = 0, apiUrl, onboarding, turns
const audit = []
let modelCalls = 0, modelBreaks = 0
/** 真实模式那一发 fetch:计数进证据;break-model 把下一击掐断一次再恢复(驱动层断模型)。 */
const countedFetch = async (input, init) => {
  if (modelBreaks > 0) { modelBreaks--; throw new Error('c03125 injected one-shot model outage') }
  modelCalls++
  return await fetch(input, init)
}
const modelFetch = realModel ? countedFetch : async () => { throw new Error('isolated external model network disabled') }
const vite = await createServer({ root: here, configFile: false, cacheDir: join(root, 'vite-cache'),
  resolve: { alias: [
    { find: /^react\/jsx-runtime$/, replacement: nm('react/jsx-runtime.js') },
    { find: /^react-dom\/client$/, replacement: nm('react-dom/client.js') },
    { find: /^react-dom$/, replacement: nm('react-dom/index.js') },
    { find: /^react$/, replacement: nm('react/index.js') },
    { find: /^@deepseek-ai\/dsh-client-store$/, replacement: dependencies.storeSource },
  ] },
  define: { __WORKBENCH_VERSION__: '"c03125-isolated"', __WORKBENCH_BUILD_RELAY_URL__: '""', __WORKBENCH_BUILD_UPDATE_MANIFEST_URL__: '""' },
  server: { host: '127.0.0.1', port: 0, fs: { allow: dependencies.fsAllow } },
  oxc: { jsx: { runtime: 'automatic' } }, logLevel: 'warn',
})
const load = p => vite.ssrLoadModule(join(plugin, 'src/server', p + '.ts'))
const { OWN_DEFAULT_MODEL } = await load('modelConfig')
const { startWorkbenchServer } = await load('http')
const { createWorkbenchService } = await load('service')
const { createAppConfig } = await load('appConfig')
const { createPairingService } = await load('devices')
const { createFirstUseService } = await load('firstUse')
const { createAccountService } = await load('account')
const { createOnboardingService } = await load('onboarding')
const { stageDef } = await load('onboardingStages')
const { createOnboardingTurns } = await load('onboardingTurns')
const { createTasksService } = await load('tasks')
const { createModelService } = await load('modelService')
const { createRoutinesService } = await load('routines')
const { createRegistry } = await load('engine/registry')
const { createEngine } = await load('engine/engine')
const { createActionGate } = await load('actionGate')
const { createJobLog } = await load('jobLog')
const { resolveAgentCli } = await load('agentDispatch')
let generation = 0
let modelSvc
/** 真模型那一问(照 host 半区 askModel 的形状;只走中转/自有端点,凭据留在 modelService 里)。 */
async function realChat(prompt) {
  const endpoint = await modelSvc.endpoint()
  if (!endpoint.ready) throw new Error('模型服务还没接上')
  const res = await countedFetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.key}` },
    body: JSON.stringify({ model: endpoint.model ?? OWN_DEFAULT_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.4, thinking: { type: 'disabled' } }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`模型服务回了 ${res.status}`)
  const body = await res.json().catch(() => ({}))
  const content = body.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') throw new Error('模型没回内容')
  return content
}
const today = new Date().toISOString().slice(0, 10)
/** 派活目标仓库:git 仓库 + Kimi 智能体文件(工作树从那一份开出来,替身/真 kimi 都在里面干活)。 */
function prepDispatchRepo() {
  const agentDir = join(repo, 'docs/卡/agents')
  mkdirSync(agentDir, { recursive: true })
  // Kimi CLI 要求智能体文件带 YAML frontmatter(真 kimi 2.2.0 实测:缺了报 Invalid agent file)。
  // 回执格式要写死:真模型实测会先寒暄再加「做完:」,工作台只认三种开头的第一句话(parseReceipt),不合会被标「回执不规范」。
  writeFileSync(join(agentDir, 'kimi-coder.md'), [
    '---',
    'name: c03125-acceptance-runner',
    'description: 隔离验收执行者:在隔离项目里按交代改一个文件,按「做完:/有异议:/卡住:」开头交回',
    '---',
    '', '',
    '你在一个隔离验收项目里做一件小事:按交代的原话改文件,改完交回。',
    '',
    '**交回格式(必须严格遵守)**:你的回复整段只能有一句话,且必须以「做完:」「有异议:」或「卡住:」开头,'
    + '后面带证据或理由。**不许先寒暄**(「加好了」「已完成」这类开头会让工作台认不出回执)。',
    '只改这个目录里的文件,不联网,不装依赖。',
  ].join('\n'))
  const git = (args) => spawnSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  git(['init', '-q'])
  git(['config', 'user.name', 'c03125-acceptance'])
  git(['config', 'user.email', 'c03125-acceptance@example.invalid'])
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'c03125 dispatch base'])
}
if (dispatchMode) { prepDispatchRepo(); mkdirSync(join(root, 'dispatch'), { recursive: true }) }
/** 真 Kimi:detached 子进程,stdout/stderr 落结果文件(照生产 createDispatchRunIo 的形状,不加 taskpolicy 包装)。 */
const realRunCli = (cmd) => {
  try {
    const out = openSync(cmd.logFile, 'a'), err = openSync(cmd.logFile, 'a')
    const child = spawn(cmd.bin, [...cmd.argv], { cwd: cmd.cwd, detached: true, stdio: ['ignore', out, err], env: cmd.env ?? process.env })
    closeSync(out); closeSync(err)
    child.unref()
    const exited = new Promise(resolveExit => child.once('exit', code => resolveExit({ code })))
    return { pid: child.pid, exited }
  } catch (error) {
    return { error: String(error), exited: new Promise(() => {}) }
  }
}
/** 替身 Kimi:node 一把梭,真改 README(证明落在cwd),打一条 stream-json 回执。只自测开关机构,不花额度。 */
const stubReply = `做完:已在 README.md 加了一行今天的日期(替身执行,非真实模型)`
const stubRunCli = (cmd) => {
  const script = `const fs=require('fs');const p='README.md';try{const t=fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';if(!t.includes('${today}'))fs.appendFileSync(p,'\\n${today}\\n')}catch(e){}console.log(${JSON.stringify(JSON.stringify({ role: 'assistant', content: stubReply }))})`
  const out = openSync(cmd.logFile, 'a'), err = openSync(cmd.logFile, 'a')
  const child = spawn(process.execPath, ['-e', script], { cwd: cmd.cwd, detached: true, stdio: ['ignore', out, err], env: process.env })
  closeSync(out); closeSync(err)
  child.unref()
  const exited = new Promise(resolveExit => child.once('exit', code => resolveExit({ code })))
  return { pid: child.pid, exited }
}
const listDirSafe = d => { try { return readdirSync(d) } catch { return [] } }
let dispatchCardId
async function start() {
  const config = createAppConfig({ file: join(dir, 'app.json') })
  onboarding = createOnboardingService({ file: join(dir, 'onboarding.json'), repoRoot: repo, agentsFile: join(repo, 'AGENTS.md') })
  await onboarding.load()
  turns = createOnboardingTurns()
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  // 模型配置只读引用真实家目录那两份(真实模式);隔离模式照旧用隔离 HOME 里的(不存在 = 门如实缺)。
  const modelDir = realModel || realDispatch ? join(realHome, '.dsh/workbench') : dir
  modelSvc = createModelService({ modelFile: join(modelDir, 'model.json'), credentialFile: join(modelDir, 'credentials.json'), dshHome: join(process.env.HOME, '.dsh'), fetchImpl: modelFetch })
  const butlerSession = { open: async () => `isolated-session-${generation}-${Date.now()}`, isAlive: () => true,
    say: async (id, text) => { const detail = onboarding.detail(); const seed = stageDef(detail.stage, detail.mode, detail.template).seed; turns.handleEvent(id, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: seed }] } } }); turns.handleEvent(id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }); return true } }
  // 真实模式:接真例程(早报真生成;时刻钉在 23:59,露面不自动跑,只有引导里那一颗键会触发)。
  let routines
  if (realModel) {
    writeFileSync(join(dir, 'routines.json'), JSON.stringify({ morning: { enabled: true, at: '23:59', not_before: '06:00' }, repo }))
    routines = createRoutinesService({ configFile: join(dir, 'routines.json'), stateFile: join(dir, 'routines-state.json'), session: butlerSession, defaultRepo: repo, dayReview: { chat: realChat } })
    await routines.load()
  }
  // 真实模式都登记 Kimi 执行者名片(负责人在卡上;只派活模式另外接引擎)。
  let engineRegistry, engine
  if (dispatchMode || realModel) {
    if (dispatchMode) {
      engineRegistry = createRegistry()
      engine = createEngine({ registry: engineRegistry, gate: createActionGate({ phaseOf: () => 'open', now: () => new Date() }), log: createJobLog() })
    }
    const cards = (await tasks.list()).agent_cards ?? []
    const existing = cards.find(one => one.name === '隔离验收执行者')
    if (existing !== undefined) dispatchCardId = existing.id
    else {
      const saved = await tasks.saveAgentCard({ name: '隔离验收执行者', hand: 'cli', runtime: { family: 'kimi' }, project: { repo }, budget: { minutes: 10 }, shared: { to: 'none' } })
      if (!saved.ok || saved.id === undefined) throw new Error('save kimi agent card failed: ' + (saved.reason ?? ''))
      dispatchCardId = saved.id
    }
  }
  api = await startWorkbenchServer({ port: apiPort, host: '127.0.0.1',
    credentialFile: join(dir, 'credentials.json'),
    model: modelSvc,
    ...(realModel ? { fetchImpl: countedFetch, routines } : {}),
    ...(dispatchMode
      ? {
          engineRegistry, engine,
          dispatchRun: {
            resultDir: join(root, 'dispatch'),
            runCli: realDispatch ? realRunCli : stubRunCli,
            resolveCli: realDispatch
              ? family => resolveAgentCli(family, { pathEnv: process.env.PATH, home: realHome, exists: existsSync, listDir: listDirSafe })
              : family => family === 'kimi'
                  ? { found: true, family, bin: process.execPath, source: 'path' }
                  : { found: false, family, why: 'stub only registers kimi' },
            ...(realDispatch ? { envForCli: async () => ({ env: { ...process.env, HOME: realHome } }) } : {}),
          },
        }
      : {}),
    service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0,
    appConfig: config, account: createAccountService({ file: join(dir, 'account.json'), keyFile: join(dir, 'account-session.key') }),
    onboarding, onboardingTurns: turns, tasks,
    firstUse: createFirstUseService({ file: join(dir, 'first-use.json') }),
    pairing: createPairingService({ file: join(dir, 'devices.json') }), sourceRepo: async () => false,
    butlerSession,
    lan: { config, mdns: { async start() {}, async stop() {}, active: () => false }, lanAddress: () => '127.0.0.1', name: '隔离工作台', version: 'test' },
  })
  apiUrl = api.url; apiPort = Number(new URL(apiUrl).port); generation++
}
await start()
const middleware = async (req, res, next) => {
  if (req.url === '/qa/stop' && req.method === 'POST') { await api.close(); api = undefined; res.end('{}'); return }
  if (req.url === '/qa/restart' && req.method === 'POST') {
    await api?.close(); await start(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ generation })); return
  }
  if (req.url === '/qa/break-model' && req.method === 'POST') { modelBreaks++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ breaks: modelBreaks })); return }
  if (req.url === '/qa/evidence') {
    const morningSummary = (() => { try {
      const last = JSON.parse(readFileSync(join(dir, 'routines-state.json'), 'utf8'))?.last?.morning
      return last === undefined ? null : { status: last.status, started_at: last.started_at, segments: typeof last.report === 'string' ? last.report.split('\n\n').filter(s => s.trim() !== '').length : 0, dayReviewByProgram: typeof last.note === 'string' && last.note.includes('日报四段按记录排的') }
    } catch { return null } })()
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ generation, requests: audit, modelCalls, modelMode: realModel ? 'real' : 'controlled', dispatchMode: realDispatch ? 'real' : stubDispatch ? 'stub' : 'off', dispatchCardId, morning: morningSummary, files: ['app.json', 'onboarding.json', 'first-use.json', 'devices.json'].map(file => ({ file, data: (() => { try { const d = JSON.parse(readFileSync(join(dir, file), 'utf8')); if (file === 'devices.json') return { deviceCount: d.devices?.length ?? 0 }; return file === 'onboarding.json' ? { stage: d.stage, nickname: d.nickname, mode: d.mode, answered: d.answered } : d } catch { return null } })() })) })); return }
  if (!req.url?.startsWith('/api/')) { next(); return }
  const path = req.url.slice(4)
  const forwarded = request(apiUrl + path, { method: req.method, agent: false, headers: { ...req.headers, host: new URL(apiUrl).host, connection: 'close' } }, upstream => {
    audit.push({ method: req.method, path: path.split('?')[0], status: upstream.statusCode, generation })
    res.writeHead(upstream.statusCode ?? 500, upstream.headers); upstream.pipe(res)
  })
  forwarded.on('error', () => { res.statusCode = 503; res.end('{}') }); req.pipe(forwarded)
}
vite.middlewares.stack.unshift({ route: '', handle: middleware })
await vite.listen()
const page = `http://127.0.0.1:${vite.httpServer.address().port}`
writeFileSync(join(root, 'ready.json'), JSON.stringify({ page, api: apiUrl, pid: process.pid }))
console.log(JSON.stringify({ page, api: apiUrl, root }))
async function stop() { await api?.close(); await vite.close(); process.exit(0) }
process.on('SIGTERM', stop); process.on('SIGINT', stop)
