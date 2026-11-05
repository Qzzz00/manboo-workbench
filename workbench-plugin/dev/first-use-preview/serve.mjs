/**
 * 首次引导预览台(2026-10-21,卡「引导三件事」;只给人点着看,不进构建、不进测试)。
 *
 * 真的:电脑首次流程那几屏(`FirstRunFlow`)、首页「现在能做什么」、设置里的实验开关 —— 都是插件里那几个 React 组件原样;
 * 后面的 8791 也是真的 `startWorkbenchServer`(三件主路、先试哪件、实验开关、配对、建卡、行为账),数据放在一个临时目录里,
 * **不碰 `~/.dsh`、不连 DSH、不连中转**。
 *
 * 模拟的(页面顶上那条工具栏里写着):引导对话里模型那几句、「出一份早报」「交给它」真跑那一下、手机真打进来那一通、
 * Claude / Codex 登没登录、手机扫码配上。这几样要 DSH、模型、通话工人或真手机,预览台里由这一层替它们回话。
 *
 *     cd workbench-plugin && node dev/first-use-preview/serve.mjs     # 然后开 http://127.0.0.1:5199
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = join(here, '..', '..')
// vite 不是插件的直接依赖(vitest 带进来的那一份),按路径取。
const { readdirSync } = await import('node:fs')
const viteDir = readdirSync(join(plugin, 'node_modules/.pnpm')).find(name => name.startsWith('vite@'))
const { createServer } = await import(join(plugin, 'node_modules/.pnpm', viteDir, 'node_modules/vite/dist/node/index.js'))
const API_PORT = 8893
const PAGE_PORT = 5199

const vite = await createServer({
  root: here,
  configFile: false,
  server: { host: '127.0.0.1', port: PAGE_PORT, strictPort: true, fs: { allow: [plugin, join(plugin, '..', '..', '..', '..', '..', 'deepseek-harness')] } },
  oxc: { jsx: { runtime: 'automatic' } },
  plugins: [preview()],
  logLevel: 'warn',
})

const load = path => vite.ssrLoadModule(join(plugin, path))
const { startWorkbenchServer } = await load('src/server/http.ts')
const { createWorkbenchService } = await load('src/server/service.ts')
const { createTasksService } = await load('src/server/tasks.ts')
const { createPairingService } = await load('src/server/devices.ts')
const { createAppConfig } = await load('src/server/appConfig.ts')
const { createBehaviorLog } = await load('src/server/behaviorLog.ts')
const { createFirstUseService } = await load('src/server/firstUse.ts')

const dir = mkdtempSync(join(tmpdir(), 'wb-first-use-preview-'))
const config = createAppConfig({ file: join(dir, 'app.json') })
const behaviorLog = createBehaviorLog({ dir: join(dir, '行为账') })
const firstUse = createFirstUseService({ file: join(dir, 'first-use.json'), behaviorLog })
const pairing = createPairingService({ file: join(dir, 'devices.json') })

/** 模拟那几样此刻的样子(工具栏改它)。 */
const sim = { loggedIn: { claude: false, codex: false }, guideDone: false, said: 0, nickname: '' }

function cap(family, title) {
  const ok = sim.loggedIn[family]
  return {
    family, title, installed: true,
    cells: {
      chat: { state: 'na', note: '' },
      edit: ok ? { state: 'ok', note: '能改', via: 'cli' } : { state: 'no', note: '还差一步:登录一次', fix: { kind: 'login_cli', family, label: `登录 ${title}` } },
      collect: { state: 'unknown', note: '' },
    },
    line: '',
  }
}
const agentCaps = {
  view: () => ({ agents: [cap('claude', 'Claude'), cap('codex', 'Codex')], line: '' }),
  pump() {}, check: async () => {}, waitLogin() {}, whenLoggedIn() {}, stop() {},
}

const server = await startWorkbenchServer({
  port: API_PORT,
  service: createWorkbenchService(),
  tickIntervalMs: 0,
  heartbeatMs: 0,
  tasks: createTasksService({ file: join(dir, 'tasks.json') }),
  pairing,
  behaviorLog,
  firstUse,
  appConfig: config,
  agentCaps,
  // 「登录 Claude / Codex」那颗键:预览台里点了就当登上了。
  loginLauncher: async (family) => { sim.loggedIn[family] = true; return { ok: true, note: `(模拟)${family === 'claude' ? 'Claude' : 'Codex'} 登录好了` } },
  sourceRepo: async () => false,
  lan: { config, mdns: { async start() {}, async stop() {}, active: () => false }, lanAddress: () => '127.0.0.1', name: '预览台', version: '0.0.0' },
})

/** 打真的 8791(工具栏的几下要走真路:配对、建卡)。 */
async function api(path, body) {
  const res = await fetch(`${server.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return await res.json().catch(() => ({}))
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}
async function bodyOf(req) {
  let text = ''
  for await (const chunk of req) text += chunk
  try { return JSON.parse(text || '{}') } catch { return {} }
}

/**
 * 预览台这一层:引导对话(DSH 那一半)、「试一下」真跑那一下、工具栏的几颗键;其余一律转给真的 8791。
 */
function preview() {
  return {
    name: 'first-use-preview',
    configureServer(dev) {
      dev.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '/').split('?')[0]
        const own = path === '/' || path.startsWith('/@') || path.startsWith('/node_modules') || path.startsWith('/src') || path.endsWith('.tsx') || path.endsWith('.ts') || path.endsWith('.html') || path.startsWith('/__')
          || path.startsWith('/@fs')
        if (own) { next(); return }
        try {
          // ——— 引导对话(要 DSH + 模型):照阶段机的样子回几句 ———
          if (path === '/onboarding' && req.method === 'GET') { json(res, 200, { stage: sim.nickname === '' ? 'opening' : 'branch', done: sim.guideDone, ...(sim.nickname === '' ? {} : { nickname: sim.nickname }) }); return }
          if (path === '/onboarding/answer') {
            const body = await bodyOf(req)
            if (body.key === 'nickname') sim.nickname = String(body.value)
            json(res, 200, { ok: true, stage: 'template', advanced: true, done: false }); return
          }
          if (path === '/onboarding/session') { json(res, 200, { stage: 'template', session_id: 'preview', first_message: '', seed: '', resumed: false }); return }
          if (path === '/onboarding/say') { sim.said += 1; if (sim.said >= 2) sim.guideDone = true; json(res, 200, { ok: true }); return }
          if (path === '/onboarding/turns') {
            const name = sim.nickname || '你'
            const turns = [{ seq: 1, role: 'assistant', text: `好,${name}。你说的这件事,更像做产品研发,还是做自媒体运营?` }]
            if (sim.said >= 1) turns.push({ seq: 2, role: 'user', text: '(你刚说的那句)' }, { seq: 3, role: 'assistant', text: '好。用一句话说说这件事是什么?(预览台:再说一句就算五问走完)' })
            json(res, 200, { turns, busy: false, ended: false, stage: sim.guideDone ? 'done' : 'template', done: sim.guideDone }); return
          }
          if (path === '/setup/apk.json') { json(res, 200, { available: true, path: '/x', url: 'https://example.invalid/butler.apk', source: 'cloud' }); return }
          // ——— 「试一下」真跑那一下(要例程 / 派活 / 通话工人)———
          if (path === '/first-use/try') {
            const body = await bodyOf(req)
            await firstUse.trying(body.path)
            if (body.path === 'morning') {
              setTimeout(() => { void firstUse.record({ key: `morning:preview-${Date.now()}:ok`, path: 'morning', ok: true, at: new Date().toISOString() }, '电脑') }, 4000)
              json(res, 200, { ok: true, note: '我先把今天的资讯整理成早报,一分钟。(预览台:4 秒后算出来了)' }); return
            }
            if (body.path === 'delegate') {
              if (!sim.loggedIn.claude && !sim.loggedIn.codex) { json(res, 200, { ok: false, door: 'ai_login' }); return }
              setTimeout(() => { void firstUse.record({ key: `delegate:preview-${Date.now()}:ok`, path: 'delegate', ok: true, at: new Date().toISOString() }, '电脑') }, 5000)
              json(res, 200, { ok: true, note: `交给 ${sim.loggedIn.claude ? 'Claude' : 'Codex'} 了,回来的结果会挂在那张卡上,手机上也看得到。(预览台:5 秒后算交回)` }); return
            }
            json(res, 200, { ok: true, note: '手机上拨给我一下。(预览台:用顶上「模拟:手机打进来」)' }); return
          }
          // ——— 工具栏 ———
          if (path === '/sim/pair') {
            await api('/lan', { enabled: true })
            const code = (await api('/pair/start', {})).pairing?.code
            await api('/pair/claim', { code, device_name: '预览台手机', platform: 'android' })
            json(res, 200, { ok: true }); return
          }
          if (path === '/sim/call') {
            await firstUse.record({ key: `call:preview-${Date.now()}`, path: 'call', ok: true, at: new Date().toISOString() }, '电话')
            json(res, 200, { ok: true }); return
          }
          if (path === '/sim/guide-done') { sim.guideDone = true; json(res, 200, { ok: true }); return }
          if (path === '/sim/state') { json(res, 200, { ...sim, dir }); return }
          // ——— 其余转给真的 8791 ———
          const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise((resolve) => { let t = ''; req.on('data', c => { t += c }); req.on('end', () => resolve(t)) })
          const upstream = await fetch(`${server.url}${req.url}`, {
            method: req.method,
            headers: { 'content-type': req.headers['content-type'] ?? 'application/json', ...(req.headers.origin === undefined ? {} : { origin: req.headers.origin }) },
            ...(body === undefined || body === '' ? {} : { body }),
          })
          res.statusCode = upstream.status
          res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json')
          res.end(Buffer.from(await upstream.arrayBuffer()))
        }
        catch (error) {
          json(res, 502, { error: `预览台转发出错:${error instanceof Error ? error.message : String(error)}` })
        }
      })
    },
  }
}

await vite.listen()
console.log(`预览台:http://127.0.0.1:${PAGE_PORT}  (真的 8791 在 ${server.url},数据在 ${dir})`)
