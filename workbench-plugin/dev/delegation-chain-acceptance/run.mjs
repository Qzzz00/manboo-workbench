/**
 * 真实委托全链验收驱动(2026-10-27,卡 t-bd1c04ed;统筹《mechanism-chain-ask》要求的下一棒)。
 *
 * 一条命令跑完五步,全部打在**当前生产 startWorkbenchServer 的隔离实例**上(仿
 * dev/desktop-onboarding-acceptance 的做法:显式临时 HOME,不碰真 HOME / 真 DSH / 真服务):
 *
 *   ① 桌面入口说一句「交给小K把 README 第一行改成『工作台验收』」→ 卡建好、负责人是
 *      小K名片、**真的派出去**(命令行那只手有进程证据,不是只显示在做);
 *   ② 交回 → 卡到「等你确认」;
 *   ③ 事务官按卡上验收条件自己验收:第一次交回**故意不达标**(缺日期行)→ 退修给
 *      **同一执行者**(Kimi 续跑 --session 原会话,不另起作者),不把普通退修推给维护者;
 *   ④ 第二次交回达标 → 验收通过 → 卡完成并回写(卡上结果 / 回执 / 事务官会话留痕);
 *   ⑤ 失败恢复:派活通道注入断一次 → 卡如实挂阻塞 → 同事项续上 → 重派成功,不重复派。
 *
 * 模式:
 *   - 缺省**受控**:模型与 CLI 是替身(按仓库现状改 README、写 Kimi stream-json 结果),
 *     链路其余全真。作者自测用这个。
 *   - CHAIN_REAL=1 **真实**:model.json / credentials.json 只读引用本机
 *     ~/.dsh/workbench/ 那两份(不复制、不打印、不进证据);派活走本机真 Kimi CLI
 *     (名片 runtime kimi,临时项目目录,名片 budget.minutes=10 时长上限)。统筹来跑。
 *
 * 证据只记:请求方法 / 路径 / 状态码、卡状态与派活账(手 / pid / 起止时刻 / 时长上限)、
 * README 事实行、会话号、时间。**不记请求正文、不记凭据、不记模型原文。**
 *
 * 边界:不安装 DSH、不注册服务、不打开本人 App/账号、不改任何全局上限与实验开关;
 * 事务官会话是记录的替身(真 DSH 宿主缺席)——验收 / 退修的**动作**由驱动经真实 API
 * 执行(扮演事务官),这是本驱动的受控替身范围,交接里写明。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(here, '../..')
const REAL = process.env.CHAIN_REAL === '1'
const root = process.env.CHAIN_ROOT ?? mkdtempSync(join(tmpdir(), 'delegation-chain-'))
const home = join(root, 'home')
const wb = join(home, '.dsh', 'workbench')
const repo = join(root, 'project')
const evidenceDir = process.env.CHAIN_EVIDENCE ?? join(root, 'evidence')
mkdirSync(wb, { recursive: true })
mkdirSync(evidenceDir, { recursive: true })
mkdirSync(repo, { recursive: true })
writeFileSync(join(repo, 'README.md'), '# 隔离验收项目\n\n原始内容。\n')
// Kimi 新会话派活固定带 --agent-file docs/卡/agents/kimi-coder.md(agentDispatch.ts 缺省):临时项目照惯例备一份。
mkdirSync(join(repo, 'docs', '卡', 'agents'), { recursive: true })
writeFileSync(join(repo, 'docs', '卡', 'agents', 'kimi-coder.md'), [
    '---',
    'name: chain-qa',
    'description: 隔离验收执行者:按一句交代改本仓库的文件,改完一句话汇报',
    '---',
    '',
    '你是隔离验收项目的执行者。按交代的字面修改本仓库里的文件;不要改交代之外的东西;',
    '做完用一句话汇报改了哪个文件、改了什么。',
    '',
  ].join('\n'))
await execFileP('git', ['init', '-q'], { cwd: repo })
await execFileP('git', ['add', '-A'], { cwd: repo })
await execFileP('git', ['-c', 'user.email=chain@qa.local', '-c', 'user.name=chain-qa', 'commit', '-qm', 'init'], { cwd: repo })

/* ── 证据账(不记正文 / 凭据) ── */
const evidence = { mode: REAL ? 'real' : 'controlled', startedAt: new Date().toISOString(), root, requests: [], steps: [], boundaries: [
  '隔离临时 HOME;不碰真 HOME / 真 DSH / 真服务;事务官会话为记录替身,验收与退修动作为驱动经真实 API 执行',
  REAL ? '真实模式:model.json / credentials.json 只读引用本机路径(未复制、未打印);Kimi CLI 真跑(订阅额度,费用以提供方账单为准,本驱动不读余额、不编数)' : '受控模式:模型与 CLI 为替身;链路其余全真',
] }
function note(step, data) { evidence.steps.push({ step, at: new Date().toISOString(), ...data }) }

/* ── 生产模块加载(vite ssrLoadModule,与 onboarding 驱动同一做法) ── */
const nm = n => join(plugin, 'node_modules', n)
const viteDir = readdirSync(nm('.pnpm')).find(n => n.startsWith('vite@'))
const { createServer } = await import(join(nm('.pnpm'), viteDir, 'node_modules/vite/dist/node/index.js'))
const vite = await createServer({ root: here, configFile: false, cacheDir: join(root, 'vite-cache'),
  resolve: { alias: [
    { find: /^react\/jsx-runtime$/, replacement: nm('react/jsx-runtime.js') },
    { find: /^react$/, replacement: nm('react/index.js') },
  ] },
  define: { __WORKBENCH_VERSION__: '"chain-acceptance"', __WORKBENCH_BUILD_RELAY_URL__: '""', __WORKBENCH_BUILD_UPDATE_MANIFEST_URL__: '""' },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(plugin, '..')] } },
  oxc: { jsx: { runtime: 'automatic' } }, logLevel: 'warn',
})
const load = p => vite.ssrLoadModule(join(plugin, 'src/server', p + '.ts'))
const loadAny = p => vite.ssrLoadModule(p)
const { startWorkbenchServer } = await load('http')
const { createWorkbenchService } = await load('service')
const { createAppConfig } = await load('appConfig')
const { createTasksService } = await load('tasks')
const { createProjectsService } = await load('projectsService')
const { createModelService } = await load('modelService')
const { createJobLog } = await load('jobLog')
const { engineHarness } = await loadAny(join(plugin, 'tests/helpers/engineHarness.ts'))

/* ── 服务组装 ── */
const tasks = createTasksService({ file: join(wb, 'tasks.json') })
const appConfig = createAppConfig({ file: join(wb, 'app.json') })
const jobLog = createJobLog({ file: join(wb, 'jobs.jsonl'), now: () => new Date(), warn: () => {} })
const projects = createProjectsService({
  file: join(wb, 'projects.json'),
  exec: async (args, cwd) => { try { const { stdout } = await execFileP('git', [...args], { cwd }); return { ok: true, stdout } } catch { return { ok: false, stdout: '' } } },
  listDir: async d => (await import('node:fs/promises')).readdir(d).catch(() => []),
  isRepo: async d => existsSync(join(d, '.git')),
  codexHome: join(home, '.codex'),
  codexDeps: {},
  home,
  scanRoots: [],
})

/* 模型:受控替身 / 真实只读引用。受控模式写隔离配置(替身拦截,钥匙不出门)。 */
if (!REAL) {
  writeFileSync(join(wb, 'model.json'), JSON.stringify({ mode: 'own', own_base_url: 'http://127.0.0.1:19/v1', own_model: 'qa-brain' }))
  writeFileSync(join(wb, 'credentials.json'), JSON.stringify({ keys: { deepseek: 'qa-fake-key-isolated' } }))
}
let cardId = ''
let realModelCalls = 0
/* 真实模式:只数调用次数(费用估算用),不记录请求 / 响应内容。 */
const realModelCountingFetch = async (url, init) => { realModelCalls += 1; return fetch(url, init) }
const modelStandIn = (async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  const system = String(body.messages?.[0]?.content ?? '')
  const said = String(body.messages?.at(-1)?.content ?? '')
  // 交回核验(受控):第一次核不过(逼出退修环),此后过。
  if (system.includes('交回核验')) {
    // 按条件真核(受控回执写明它做了什么;不再「第一次必红」——那是在替产品演)。
    const said2 = said
    const cond2 = /验收人\s*[:：]\s*验收员甲/.test(said2)
    const items = [
      { condition: '第一行是「工作台验收」', met: /工作台验收/.test(said2), evidence: '首行「工作台验收」' },
      { condition: '文末有「验收人:验收员甲」一行', met: cond2, evidence: cond2 ? '文末加「验收人:验收员甲」' : '' },
    ]
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), { status: 200 })
  }
  const quote = said.split('她说:「').at(-1) ?? ''
  if (!quote.includes('交给小K') || cardId === '') throw new Error('chain-model-unreachable')
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ addressed: true, items: [], dispatch: { do: 'run', family: cardId, kind: 'code' } }) } }] }), { status: 200 })
})
/* 真实模式的配置解析:只读引用本机那两份(不复制、不打印、不进证据)。解析本身在
 * real-config.mjs(纯函数),用例钉着;那里只认「绝对路径 + <home>/.dsh/workbench 之下」。 */
const { resolveRealModelFiles } = await import('./real-config.mjs')
const realFiles = resolveRealModelFiles(process.env.CHAIN_HOME ?? process.env.HOME)
const model = createModelService(REAL
  ? { modelFile: realFiles.modelFile, credentialFile: realFiles.credentialFile, dshHome: join(home, '.dsh') }
  : { modelFile: join(wb, 'model.json'), credentialFile: join(wb, 'credentials.json'), dshHome: join(home, '.dsh'), fetchImpl: modelStandIn })

/* CLI:受控替身 / 真 Kimi CLI。替身按仓库现状改 README(不另起作者:续跑带 --session)。 */
const resultDir = join(wb, 'dispatch-results')
mkdirSync(resultDir, { recursive: true })
let fakePid = 40000
/* 通道断开注入:一次性开关,两臂(受控替身 / 真 CLI)同一口径 —— 下一次 CLI 启动失败。 */
const injectedFailure = { armed: false }
const injectedBreak = () => {
  injectedFailure.armed = false
  return { exited: Promise.resolve({ code: 1 }), error: '注入:派活通道断一次' }
}
const runCliControlled = (cmd) => {
  if (injectedFailure.armed) return injectedBreak()
  const resume = (() => { const i = cmd.argv.indexOf('--session'); return i >= 0 ? String(cmd.argv[i + 1]) : '' })()
  const readme = join(cmd.cwd, 'README.md')
  let text = readFileSync(readme, 'utf8')
  const lines = text.split('\n')
  if (!lines[0].includes('工作台验收')) lines[0] = '工作台验收'
  else if (!/验收人\s*[:：]\s*验收员甲/.test(text)) lines.push('', '验收人:验收员甲')
  text = lines.join('\n')
  writeFileSync(readme, text)
  const sessionId = resume !== '' ? resume : `qa-kimi-${++fakePid}`
  const saidWhat = /验收人\s*[:：]\s*验收员甲/.test(text)
    ? '已改 README:首行「工作台验收」,文末加「验收人:验收员甲」。'
    : '已改 README:首行「工作台验收」。'
  writeFileSync(cmd.logFile, [
    JSON.stringify({ role: 'assistant', content: saidWhat }),
    JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: sessionId }),
  ].join('\n'))
  writeFileSync(cmd.logFile.replace(/\.jsonl$/, ''), '')
  // 真进程有耗时:留 2.5s 让「在跑期间换验收条件」这拍有确定窗口(受控不赛跑;真机本就几十秒)。
  return { pid: ++fakePid, exited: new Promise(res => setTimeout(() => res({ code: 0 }), 2500)) }
}
note('setup', { repo: 'git init + README', home })

/* ── 启动隔离实例 ── */
const butlerSaid = []
const cliDeps = REAL
  ? {
      resolveCli: () => ({ found: true, family: 'kimi', bin: 'kimi', source: 'path' }),
      runCli: (cmd) => {
        if (injectedFailure.armed) return injectedBreak()
        const out = openSync(cmd.logFile, 'w')
        const child = spawn(cmd.bin, [...cmd.argv], { cwd: cmd.cwd, detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...(cmd.env ?? {}) } })
        child.unref()
        return { pid: child.pid, exited: new Promise(res => child.on('exit', code => res({ code }))) }
      },
      resultDir, now: () => new Date(),
    }
  : {
      resolveCli: () => ({ found: true, family: 'kimi', bin: 'kimi-qa', source: 'path' }),
      runCli: runCliControlled,
      resultDir, now: () => new Date(),
    }
// 这台隔离实例**没有可用的窗口通道**(无头验收环境,壳不在场):窗口那只手如实报不可用,
// 引擎回退到命令行那只手 —— 真实模式才真的走本机 Kimi CLI,而不是假壳里发个 submitted。
const harness = engineHarness({
  helper: { connected: () => false, supports: () => false, request: async () => ({}) },
  cli: cliDeps,
  now: () => new Date(),
})
const server = await startWorkbenchServer({
  port: 0, host: '127.0.0.1',
  service: createWorkbenchService(),
  tickIntervalMs: 0, heartbeatMs: 0,
  tasks, appConfig, model, projects, jobLog,
  engine: harness.engine, engineRegistry: harness.registry,
  sourceRepo: async () => false,
  appInstalled: () => true,
  runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
  dispatchRun: { leaseFile: join(wb, 'execution-leases.json'), pollMs: 60 },
  ...(REAL ? { fetchImpl: realModelCountingFetch } : { fetchImpl: modelStandIn }),
  itemBudget: { store: { get: () => ({ cny: 0, minutes: 10 }), set: async () => true }, usage: () => undefined },
  butlerSession: {
    open: async () => 'chain-butler-1',
    say: async (session, text) => { butlerSaid.push({ session, at: new Date().toISOString(), chars: text.length }); return true },
    clearQueued: async () => ({ removed: [], remaining: [], incomplete: false }),
    running: () => false,
  },
})
const url = server.url

/* ── 驱动工具 ── */
async function api(method, path, body) {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const status = res.status
  evidence.requests.push({ method, path: path.split('?')[0], status, at: new Date().toISOString() })
  return { status, body: await res.json().catch(() => ({})) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function cardOf(id) { return (await tasks.list()).tasks.find(one => one.id === id) }
async function waitFor(fn, what, timeoutMs = REAL ? 600_000 : 30_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const got = await fn()
    if (got) return got
    if (Date.now() > until) throw new Error(`等待超时:${what}`)
    await sleep(REAL ? 2000 : 20)
  }
}
const ledgerOf = (card) => card?.dispatch?.hand === 'cli'
  ? { hand: 'cli', pid: card.dispatch.pid, startedAt: card.dispatch.started_at, endedAt: card.dispatch.ended_at, budgetMinutes: card.dispatch.budget_minutes, sessionId: card.links?.find(l => l.agent === 'kimi')?.session_id }
  : { hand: card?.client_dispatch ? 'window' : undefined }
const readmeFacts = () => {
  const first = readFileSync(join(repo, 'README.md'), 'utf8').split('\n')[0]
  return { readmeFirstLine: first.slice(0, 40), hasDateLine: /验收日期\s*[:：]/.test(readFileSync(join(repo, 'README.md'), 'utf8')) }
}

try {
  /* 名片:小K(runtime kimi;真实模式名片时长上限 10 分钟)。 */
  const saved = await tasks.saveAgentCard({ name: '小K', hand: 'kimi', runtime: { family: 'kimi' }, budget: { minutes: 10 } })
  if (!saved.ok) throw new Error(`名片没建成:${saved.reason ?? ''}`)
  cardId = String(saved.id)
  const project = await projects.adopt({ name: '验收项目', path: repo })
  evidence.projectId = project.id

  /* ① 桌面入口说一句 → 卡建好、负责人是小K名片、真的派出去。 */
  const said1 = await api('POST', '/butler/item', { text: '交给小K把 README 第一行改成「工作台验收」', entrance: 'desktop' })
  if (said1.status !== 200 || said1.body.ok !== true) throw new Error(`① 建卡失败:${said1.status}`)
  const id1 = String(said1.body.id)
  const card1 = await cardOf(id1)
  if (card1?.assignee !== cardId) throw new Error(`① 负责人不是小K名片:${String(card1?.assignee)}`)
  // 派活前卡上只写执行者凭原话就知道的第 1 条 —— 简报会把卡上 acceptance 带给执行者
  // (dispatchPrompt 带编号附上);隐藏条件若在派活前上卡,执行者照做,逼不出退修(统筹取证结论)。
  await tasks.update(id1, { projectId: project.id, acceptance: ['第一行是「工作台验收」'], conversation: { agent: 'dsh', session_id: 'chain-butler-1' } })
  const intentKind1 = String((said1.body?.dispatch_intent?.kind) ?? 'code')
  let card1b = await cardOf(id1)
  let dispatchPath = 'compat(1a 执行器当场代派)'
  if (card1b?.dispatch === undefined && card1b?.client_dispatch === undefined) {
    dispatchPath = `driver(进程内派活口, kind=${intentKind1})`
    const started1 = await server.dispatchItem(id1, { family: cardId, text: '把 README 第一行改成「工作台验收」', kind: intentKind1 })
    if (started1.ok !== true) throw new Error(`① 没派出去:${started1.note}`)
    // 简报(argv)此刻已固定 —— 立刻换上含隐藏条件的 acceptance:执行者看不见,产品按交回时的卡核。
    await tasks.update(id1, { acceptance: ['第一行是「工作台验收」', '文末有「验收人:验收员甲」一行'] })
  }
  const done1 = await waitFor(async () => { const c = await cardOf(id1); return c?.dispatch?.status === 'done' ? c : undefined }, '① 第一次交回')
  const facts1 = readmeFacts()
  if (!facts1.readmeFirstLine.includes('工作台验收')) throw new Error('① 执行者没有真的改 README')
  note('1-dispatch', { card: { id: id1, status: done1.status, assignee: done1.assignee }, ledger: ledgerOf(done1), ...facts1, dispatchPath, sendEvidence: 'cli 进程退出码 0 + 结果文件解析(session.resume_hint)' })

  /* ② 交回 → 卡到「等你确认」。核验闭环接得很快,confirm 可能是瞬态 —— 到达或已过都算。 */
  const confirm1 = await waitFor(async () => {
    const c = await cardOf(id1)
    return c !== undefined && (c.status === 'confirm' || c.status === 'doing' || c.status === 'done') ? c : undefined
  }, '② 卡到等你确认(或核验已接续)', REAL ? 480_000 : 60_000)
  note('2-delivered', { card: { id: id1, status: confirm1.status }, receiptAt: confirm1.receipt?.at })

  /*
   * ③ 事务官自己验收 —— **动作已由产品接管**(2026-10-27 交回闭环:CLI 交回进「等你确认」
   * 那一刻,产品按卡上 acceptance 自己核:不过 → 退修给同一执行者同一会话,过 → 通过回写)。
   * 驱动只做两件:**在跑期间换上**含隐藏条件的 acceptance(简报已送出,执行者看不见;
   * 若派活前上卡会被简报带过去照做,逼不出退修 —— 统筹 verify-replay 取证结论)与**核对**终态。
   */
  const firstSession = ledgerOf(done1).sessionId
  const firstDeliveredAt = ledgerOf(done1).endedAt
  await waitFor(async () => (await tasks.list()).tasks.find(one => one.id === id1)?.status === 'done', '③ 产品核验闭环后卡做完', REAL ? 480_000 : 60_000)
  const done2 = (await tasks.list()).tasks.find(one => one.id === id1)
  const secondSession = ledgerOf(done2).sessionId
  if (firstSession !== undefined && secondSession !== firstSession) throw new Error(`③ 换了执行会话(${firstSession} → ${secondSession}),不是同一执行者`)
  const facts2 = readmeFacts()
  if (!/验收人\s*[:：]\s*验收员甲/.test(readFileSync(join(repo, 'README.md'), 'utf8'))) throw new Error('③ 第二次交回仍缺「验收人:验收员甲」')
  const verdicts = (done2?.comments ?? []).map(one => one.text).filter(one => /验收(通过|未过)/u.test(one))
  if (!verdicts.some(one => one.includes('验收未过')) || !verdicts.some(one => one.includes('验收通过'))) throw new Error('③ 卡上缺事务官判词留言')
  note('3-rework', {
    card: { id: id1, status: done2?.status, round: done2?.round },
    ledger: ledgerOf(done2),
    sameSession: firstSession === secondSession,
    firstDeliveredAt,
    secondDeliveredAt: ledgerOf(done2).endedAt,
    reworkCommentOnCard: (done2?.comments ?? []).length > 0,
    readmeFirstLine: facts2.readmeFirstLine,
    unknownSatisfied: '验收人:验收员甲',
    byProduct: true,
  })

  /* ④ 通过回写由产品落(③ 的闭环已把卡挪「做完」、判词留言在卡上);这里核对证据。 */
  const passText = '验收通过:条件全过。'
  await api('POST', '/butler/item/say', { id: id1, text: passText })
  const done = await waitFor(async () => { const c = await cardOf(id1); return c?.status === 'done' ? c : undefined }, '④ 卡完成')
  note('4-accepted', { card: { id: id1, status: done.status, round: done.round }, receiptAt: done.receipt?.at, butlerSessionNotes: butlerSaid.length, byProduct: true })

  /* ⑤ 失败恢复:通道断一次 → 如实挂阻塞 → 同事项续上 → 重派成功,不重复派。 */
  injectedFailure.armed = true
  const said2 = await api('POST', '/butler/item', { text: '交给小K在 README 末尾加一行验收人:验收员甲', entrance: 'desktop' })
  const id2 = String(said2.body.id)
  await tasks.update(id2, { projectId: project.id, conversation: { agent: 'dsh', session_id: 'chain-butler-1' } })
  const intentKind2 = String((said2.body?.dispatch_intent?.kind) ?? 'code')
  let card2b = await cardOf(id2)
  if (card2b?.dispatch === undefined && card2b?.client_dispatch === undefined) {
    const broke = await server.dispatchItem(id2, { family: cardId, text: '在 README 末尾加一行验收人:验收员甲', kind: intentKind2 })
    void broke
  }
  const blocked = await waitFor(async () => { const c = await cardOf(id2); return c?.status === 'blocked' || c?.dispatch_block !== undefined ? c : undefined }, '⑤ 卡如实挂阻塞')
  await api('POST', '/butler/item/continue', { id: id2, text: '通道恢复了,按原话重试一次' })
  const retry = await server.dispatchItem(id2, { family: cardId, text: '在 README 末尾加一行验收人:验收员甲', kind: intentKind2 })
  if (retry.ok !== true) throw new Error(`⑤ 重派没成:${retry.note}`)
  const done5 = await waitFor(async () => { const c = await cardOf(id2); return c?.dispatch?.status === 'done' ? c : undefined }, '⑤ 重派交回')
  const links2 = (await cardOf(id2))?.links ?? []
  note('5-recovery', { card: { id: id2, status: blocked.status, then: done5.status }, block: String(blocked.dispatch_block?.why ?? blocked.note ?? '').slice(0, 60), ledger: ledgerOf(done5), linkCount: links2.length, butlerSaid: butlerSaid.length })

  evidence.endedAt = new Date().toISOString()
  evidence.budget = REAL
    ? { modelCalls: realModelCalls, note: `听懂模型调用 ${realModelCalls} 次(真实中转,费用以提供方账单为准,本驱动不读余额、不编数);Kimi CLI 真跑(1 件派活 + 1 次退修续跑,订阅额度,见 3-rework 的两次 ledger);名片时长上限 10 分钟已按名片记下(dispatch.budget_minutes)` }
    : { note: '受控模式:模型替身 0 费用;CLI 替身 0 费用' }
  const out = join(evidenceDir, `chain-evidence-${REAL ? 'real' : 'controlled'}.json`)
  writeFileSync(out, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ok: true, mode: evidence.mode, evidence: out, steps: evidence.steps.map(s => s.step) }))
}
catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error)
  evidence.endedAt = new Date().toISOString()
  writeFileSync(join(evidenceDir, `chain-evidence-${REAL ? 'real' : 'controlled'}-failed.json`), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ok: false, error: evidence.error, steps: evidence.steps.map(s => s.step) }))
  process.exitCode = 1
}
finally {
  await server.close().catch(() => {})
  await vite.close().catch(() => {})
}
