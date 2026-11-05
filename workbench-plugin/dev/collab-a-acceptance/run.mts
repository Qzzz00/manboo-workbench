/**
 * 协作A验收主脚本:真 DSH(3193/8993)+ 假 OpenAI(19893)+ 真插件(本树)+ 真 Kimi CLI 派活探针。
 * 跑:cd workbench-plugin && node dev/collab-a-acceptance/run.mts
 * 证据:./run-<ts>/evidence.json(600);清理自动停自有进程并核端口清零。
 */
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startAInstance, PORTS } from './instance.mts'

const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname)
const REPO = join(HERE, '..', '..', '..')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const output = join(homedir(), '.cache', 'collab-a-acceptance', `run-${Date.now()}`)
mkdirSync(output, { recursive: true, mode: 0o700 })
const root = join(output, 'instance')
const base = `http://127.0.0.1:${PORTS.workbench}`
const ownKey = 'collab-a-fake-own-key-not-personal'
const records: Record<string, unknown>[] = []
const upstream: Record<string, unknown>[] = []
const persist = () => writeFileSync(join(output, 'evidence.json'), JSON.stringify({ records, upstream }, null, 2), { mode: 0o600 })
function record(name: string, data: Record<string, unknown>): void {
  records.push({ at: new Date().toISOString(), name, ...data }); persist(); console.log(name, JSON.stringify(data))
  if (data.passed === false && !name.startsWith('cleanup')) throw new Error('QA_CHECK_FAILED:' + name)
}
function recordSoft(name: string, data: Record<string, unknown>): void {
  records.push({ at: new Date().toISOString(), name, ...data }); persist(); console.log(name, JSON.stringify(data))
}
const MARKERS = ['QA_A_FIRST', 'QA_A_SECOND', 'QA_A_CONT', 'QA_A_REPLAY', 'QA_A_RETRY', 'QA_A_AFTER_RESTART', 'QA_KIMI_OK', 'QA_KIMI_CONT']
const lastUserMarkers = (messages: unknown[]): string[] => {
  const text = JSON.stringify(messages ?? [])
  return MARKERS.filter(m => text.includes(m))
}
function summarize(body: Record<string, unknown>): Record<string, unknown> {
  const messages = (body.messages ?? []) as { role?: string, content?: unknown }[]
  const flat = messages.map(m => `${m.role}:${JSON.stringify(m.content)}`)
  const first = flat.findIndex(x => x.includes('QA_A_FIRST'))
  return {
    model: body.model, stream: body.stream === true,
    messagesCount: messages.length,
    lastUserMarkers: lastUserMarkers(messages),
    historyHasFirst: first >= 0 && flat.slice(first + 1).some(x => x.startsWith('assistant:')),
  }
}
async function fakeHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let raw = ''
  for await (const c of req) raw += c
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(raw) } catch { /* 空 */ }
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/health' || req.url?.endsWith('/health')) { res.end(JSON.stringify({ ok: true, providers: { deepseek: true } })); return }
  if (req.url?.endsWith('/usage') || req.url?.endsWith('/v1/usage')) { res.end(JSON.stringify({ used_tokens: 0, daily_token_limit: 1000, remaining_tokens: 1000 })); return }
  if (req.url?.endsWith('/models')) { res.end(JSON.stringify({ object: 'list', data: [{ id: 'collab-a-brain', object: 'model', owned_by: 'qa' }] })); return }
  if (!req.url?.endsWith('/chat/completions')) { res.statusCode = 404; res.end('{}'); return }
  const obs = summarize(body)
  upstream.push({ at: Date.now(), url: req.url, ...obs, authOk: req.headers.authorization === `Bearer ${ownKey}` })
  persist()
  if (body.model !== 'collab-a-brain') { res.statusCode = 400; res.end(JSON.stringify({ error: { code: 'QA_UNKNOWN_MODEL' } })); return }
  const marker = obs.lastUserMarkers[obs.lastUserMarkers.length - 1] ?? 'QA_NO_MARKER'
  const reply = `收到,${marker} 的回复。`
  const common = { id: 'chatcmpl-collab-a', created: Math.floor(Date.now() / 1000), model: body.model }
  if (body.stream === true) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const delta of [{ role: 'assistant', content: '' }, { content: reply }]) res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
    res.end()
  } else {
    res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  }
}
async function api(path: string, body?: unknown, method?: string): Promise<{ status: number, body: Record<string, unknown> }> {
  const m = method ?? (body === undefined ? 'GET' : 'POST')
  const res = await fetch(base + path, {
    method: m,
    headers: { 'Content-Type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  let json: Record<string, unknown> = {}
  try { json = await res.json() as Record<string, unknown> } catch { /* 空 */ }
  return { status: res.status, body: json }
}
async function until(label: string, predicate: () => Promise<unknown>, ms = 60_000): Promise<unknown> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const found = await predicate()
    if (found) return found
    await sleep(500)
  }
  record(label, { passed: false, reason: 'timeout' })
  return undefined
}
const upstreamCount = (marker: string): number => upstream.filter(x => (x.lastUserMarkers as string[] | undefined)?.includes(marker)).length

let instance: AInstance | undefined, server: http.Server | undefined, livekit: ReturnType<typeof spawn> | undefined, cleaning = false
async function cleanup(): Promise<void> {
  if (cleaning) return
  cleaning = true
  try {
    record('cleanup-start', {})
    // S10 重启出来的 DSH 不受 instance.stop 管:按**自己的**进程路径精确停(命令行含本 run 目录才动)。
    try {
      const pid = execFileSync('lsof', ['-t', '-nP', '-iTCP:3193', '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (pid !== '') {
        const cmd = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' })
        if (cmd.includes(output)) { process.kill(Number(pid), 'SIGTERM'); await sleep(4000) }
      }
    } catch { /* 3193 已空 */ }
    if (instance) await instance.stop()
    if (server) await new Promise(r => server!.close(r))
    if (livekit) { livekit.kill('SIGKILL'); await sleep(1500) }
    const busy: number[] = []
    for (const p of [3193, 8992, 8993, 8994, 8996, 8997, 19893, 19994, 19995, 19996]) {
      try { if (execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '') busy.push(p) } catch { /* 空闲 */ }
    }
    record('cleanup-result', { passed: busy.length === 0, remainingPorts: busy })
  } catch (e) {
    record('cleanup-error', { error: String(e) })
  }
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void cleanup().finally(() => process.exit(130)) })

try {
  for (const p of [3193, 8992, 8993, 8994, 8996, 8997, 19893, 19994, 19995, 19996]) {
    try { if (execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '') throw new Error('BUSY_' + p) } catch (e) { if (String((e as Error).message).startsWith('BUSY')) throw e }
  }
  server = http.createServer((req, res) => { void fakeHandler(req, res).catch(() => { res.statusCode = 500; res.end('{}') }) })
  await new Promise((r, j) => { server!.once('error', j); server!.listen(19893, '127.0.0.1', r) })
  writeFileSync(join(output, 'livekit.yaml'), 'port: 19994\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: 19995\n  udp_port: 19996\n  use_external_ip: false\nkeys:\n  collab-a-local: collab-a-only-local-secret\nlogging:\n  level: error\n', { mode: 0o600 })
  livekit = spawn('/opt/homebrew/bin/livekit-server', ['--config', join(output, 'livekit.yaml')], { stdio: 'ignore' })
  await until('local-livekit-ready', async () => { try { return (await fetch('http://127.0.0.1:19994')).ok } catch { return false } }, 15_000)

  instance = await startAInstance({ root, repo: REPO, log: line => console.log('[instance]', line) })
// 引导跳过(项目扫描被它闸着:scan_blocked「引导还没做完」)→ 扫描才跑,CLI 派活才认项目目录。
  await fetch(`${instance.base}/onboarding/skip-rest`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` }, body: JSON.stringify({ reason: '协作A验收' }) })
  await fetch(`${instance.base}/first-run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }) })
  record('instance-ready', { passed: true, realDsh: true, realPluginBundle: true, fakeUpstream: 'http://127.0.0.1:19893', ports: PORTS })

  // S1 运行时换上自有模型 + 假凭据,等目录热加载
  const cred = await api('/credentials', { provider: 'deepseek', key: ownKey })
  const save1 = await api('/model', { mode: 'own', own_base_url: 'http://127.0.0.1:19893/v1', own_model: 'collab-a-brain' }, 'PUT')
  record('S1-model-save', { passed: save1.status === 200 && save1.body.ok === true, status: save1.status, credStatus: cred.status })
  const cat1 = await until('S1-catalog-own-model', async () => {
    const o = await api('/composer/options')
    return (o.body.models as { provider?: string, id?: string }[] | undefined)?.some(m => m.provider === 'workbench-own' && m.id === 'collab-a-brain') === true
  }, 120_000)
  record('S1-catalog-own-model', { passed: cat1 === true, waited: true })
  const try1 = await api('/model/try', {})
  record('S1-model-try', { passed: try1.status === 200 && try1.body.ok === true, status: try1.status })

  // S2 建事项(真 DSH 会话 + 真模型往返)
  const mark2 = upstream.length
  const created = await api('/butler/item', { text: '请只回复 QA_A_FIRST,不使用工具。', orientation: 'portrait', can_meeting_plan: true })
  record('S2-create-item', { status: created.status, ok: created.body.ok, itemId: created.body.id, sessionId: (created.body.conversation as { session_id?: string } | undefined)?.session_id })
  const itemId = String(created.body.id)
  const sessionId = String((created.body.conversation as { session_id?: string }).session_id)
  const first = await until('S2-upstream', () => upstream.slice(mark2).find(x => (x.lastUserMarkers as string[]).includes('QA_A_FIRST')))
  record('S2-real-model-roundtrip', { passed: !!first && (first as { authOk?: boolean }).authOk === true && (first as { model?: string }).model === 'collab-a-brain' })

  // S3 同事项第二句(真 /butler/item/say):同会话 + 双历史
  const mark3 = upstream.length
  const said2 = await api('/butler/item/say', { id: itemId, text: '请只回复 QA_A_SECOND,不使用工具。' })
  record('S3-say-same-item', { status: said2.status, ok: said2.body.ok, sameSession: said2.body.session_id === sessionId })
  const second = await until('S3-upstream', () => upstream.slice(mark3).find(x => (x.lastUserMarkers as string[]).includes('QA_A_SECOND')))
  record('S3-dual-history', { passed: !!second && (second as { historyHasFirst?: boolean }).historyHasFirst === true && said2.body.session_id === sessionId })

  // S4 事项对话双历史(电脑/手机同一读口)
  const turns = await api(`/butler/item/${itemId}/turns?limit=20`)
  const turnText = JSON.stringify(turns.body.turns ?? [])
  record('S4-turns-dual-history', { passed: turnText.includes('QA_A_FIRST') && turnText.includes('QA_A_SECOND') && turnText.includes('收到,QA_A_FIRST') })

  // S5 接续视图
  const view = await api(`/butler/item/${itemId}/continue`)
  const sources = (view.body.sources as { key?: string, action?: { kind?: string } }[] | undefined) ?? []
  record('S5-continue-view', { passed: sources.some(s => s.key === 'butler' && s.action?.kind === 'butler'), sources: JSON.stringify(sources) })

  // S6 继续这件事 → 事务官会话(真 DSH)
  const mark6 = upstream.length
  const cont = await api('/butler/item/continue', { id: itemId, text: '请只回复 QA_A_CONT,不使用工具。', target: 'butler' })
  record('S6-continue-sent', { passed: cont.status === 200 && cont.body.ok === true && cont.body.fact === 'sent', body: cont.body })
  const contCall = await until('S6-upstream', () => upstream.slice(mark6).find(x => (x.lastUserMarkers as string[]).includes('QA_A_CONT')))
  record('S6-continue-history', { passed: !!contCall && (contCall as { historyHasFirst?: boolean }).historyHasFirst === true && (contCall as { messagesCount?: number }).messagesCount! >= 5 })

  // S7 只留记录(规矩形字):留言落卡、规矩表零新增
  const rec = await api('/butler/item/continue', { id: itemId, text: '以后别在晚上派活', record: true })
  const state7 = await api('/state')
  const card7 = (state7.body.tasks as { tasks?: { id?: string, comments?: unknown[] }[] } | undefined)?.tasks?.find(t => t.id === itemId)
  const rules7 = await api('/butler/rules')
  const counting7 = ((rules7.body.rules as { status?: string }[] | undefined) ?? []).filter(r => r.status !== 'reverted')
  record('S7-record-no-side-effects', { passed: rec.body.fact === 'saved' && (card7?.comments ?? []).length === 1 && counting7.length === 0, comments: (card7?.comments ?? []).length, rules: counting7.length })

  // S8 同号重试:第二次 replayed,上游只算一次(真台账)
  const k1 = await api('/butler/item/continue', { id: itemId, text: '请只回复 QA_A_REPLAY,不使用工具。', target: 'butler', client_key: 'qa-collab-a-1' })
  // say 是排队语义:先等第一次真落在假上游,再放同号重试 —— 不然两下的异步模型调用和断言赛跑。
  await until('S8-first-lands', () => upstreamCount('QA_A_REPLAY') >= 1 ? true : undefined, 30_000)
  const k2 = await api('/butler/item/continue', { id: itemId, text: '请只回复 QA_A_REPLAY,不使用工具。', target: 'butler', client_key: 'qa-collab-a-1' })
  await sleep(3000)
  record('S8-client-key-replay', { passed: k1.body.ok === true && k2.body.replayed === true && upstreamCount('QA_A_REPLAY') === 1, firstOk: k1.body.ok, replayed: k2.body.replayed, upstreamCalls: upstreamCount('QA_A_REPLAY') })

  // S9 失败与恢复:模型指到死端口 → 那一轮真失败(照实记回包);原事项与会话保留、恢复后续得上、双历史在。
  // (同步拒发分类的契约在 HTTP 层接缝用例与 root c55 证据里已钉;这里验 A 的失败恢复语义。)
  const badSave = await api('/model', { mode: 'own', own_base_url: 'http://127.0.0.1:19894', own_model: 'collab-a-brain' }, 'PUT')
  record('S9-dead-base-save', { passed: true, status: badSave.status, ok: badSave.body.ok })
  await sleep(1500)
  const failedSay = await api('/butler/item/say', { id: itemId, text: '请只回复 QA_A_INJECT_FAIL,不使用工具。' })
  record('S9-failed-round', { passed: true, status: failedSay.status, ok: failedSay.body.ok })
  await sleep(3000)
  const state9 = await api('/state')
  const card9 = (state9.body.tasks as { tasks?: { id?: string, conversation?: { session_id?: string } }[] } | undefined)?.tasks?.find(t => t.id === itemId)
  record('S9-original-kept', { passed: card9?.conversation?.session_id === sessionId })
  const goodSave = await api('/model', { mode: 'own', own_base_url: 'http://127.0.0.1:19893/v1', own_model: 'collab-a-brain' }, 'PUT')
  await sleep(1500)
  const mark9 = upstream.length
  const retrySay = await api('/butler/item/say', { id: itemId, text: '请只回复 QA_A_RETRY,不使用工具。' })
  const retryCall = await until('S9-retry-upstream', () => upstream.slice(mark9).find(x => (x.lastUserMarkers as string[]).includes('QA_A_RETRY')))
  record('S9-retry-recovers', { passed: goodSave.body.ok === true && retrySay.status === 200 && !!retryCall && (retryCall as { historyHasFirst?: boolean }).historyHasFirst === true })

  // S10 DSH 重启:同 item 同 session,历史在
  await instance.stop()
  await until('S10-own-stopped', async () => { try { execFileSync('lsof', ['-t', '-nP', '-iTCP:3193', '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }, 15_000)
  const home = instance.home, dsh = instance.dsh
  const restartLog = openSync(join(output, 'restart.log'), 'a')
  const env: NodeJS.ProcessEnv = {
    HOME: home, USER: process.env.USER ?? '', SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8', TMPDIR: '/tmp', DSH_HOME: dsh,
    PATH: `${join(root, 'fakebin')}:${join(dsh, 'node', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    WORKBENCH_PORT: '8993', WORKBENCH_HOST: '127.0.0.1', WORKBENCH_MODULE_PORT: '8994',
    DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write', WORKBENCH_AUDIENCE: 'internal',
    CHANNEL_WORKER_DIR: join(REPO, 'channel-worker'), WORKBENCH_CHANNEL_LOAD_GUARD: 'off', WORKBENCH_CHANNEL_BUTLER_URL: 'http://127.0.0.1:8992',
    // Kimi CLI 现成登录态直用(与 instance.mts 同一口径:不复制凭据)
    KIMI_CODE_HOME: join(homedir(), '.kimi-code'), KIMI_CODE_CACHE_DIR: join(dsh, 'kimi-code-cache'), KIMI_CLI_NO_AUTO_UPDATE: '1',
  }
  const p = spawn(join(dsh, 'node', 'bin', 'node'), [join(dsh, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'web', '--host', '127.0.0.1', '--port', '3193', '--no-open'], { cwd: join(dsh, 'runtime'), env, stdio: ['ignore', restartLog, restartLog] })
  p.unref()
  await until('S10-restart-ready', async () => { try { return (await fetch(`${base}/state`)).ok } catch { return false } }, 180_000)
  const mark10 = upstream.length
  const afterRestart = await api('/butler/item/say', { id: itemId, text: '请只回复 QA_A_AFTER_RESTART,不使用工具。' })
  const afterCall = await until('S10-restart-upstream', () => upstream.slice(mark10).find(x => (x.lastUserMarkers as string[]).includes('QA_A_AFTER_RESTART')))
  record('S10-restart-history', { passed: afterRestart.status === 200 && afterRestart.body.session_id === sessionId && !!afterCall && (afterCall as { historyHasFirst?: boolean }).historyHasFirst === true, carriedOn: afterRestart.body.session_id === sessionId })

  // S11 用户改名保护
  await api('/task/update', { id: itemId, title: '我自己起的名' })
  const state11 = await api('/state')
  const card11 = (state11.body.tasks as { tasks?: { id?: string, title?: string, title_from?: string }[] } | undefined)?.tasks?.find(t => t.id === itemId)
  record('S11-rename-protected', { passed: card11?.title === '我自己起的名' && card11?.title_from === 'custom', title_from: card11?.title_from })

  // S12 真 Kimi CLI:既有派活路(/dispatch/run 回包原文即这台认不认的判据)→ 同事项 → 接续探针(照实记)
  const caps12 = await api('/agents/caps')
  recordSoft('S12-caps', { body: JSON.stringify(caps12.body).slice(0, 1200) })
  const stateP = await api('/state')
  const projects = (stateP.body.projects as { projects?: { id?: string, name?: string, path?: string }[] } | undefined)?.projects ?? []
  const withPath = projects.find(pj => typeof pj.path === 'string' && pj.path !== '')
  recordSoft('S12-project-picked', { project: withPath ?? null, all: projects.map(pj => [pj.id, pj.name, pj.path]) })
  const ktask = await api('/task/create', { title: 'QA kimi 真实派活(轻量)', ...(withPath?.id === undefined ? {} : { project_id: withPath.id }) })
  const kid = String(ktask.body.id)
  const mark12 = Date.now()
  // kind:'code':Kimi 的命令行走写代码那一类(既有策略闸:chat 只给 Codex 备用);cwd 是隔离 qa 仓,一句话活,不改文件。
  const disp = await api('/dispatch/run', { item_id: kid, app: 'kimi', text: '请只回复 QA_KIMI_OK 后结束,不要改任何文件。', kind: 'code' })
  const kimiAccepted = disp.status === 200 && disp.body.ok === true
  recordSoft('S12-dispatch-probe', { passed: kimiAccepted, status: disp.status, ok: disp.body.ok, note: disp.body.note ?? disp.body.error ?? null })
  if (kimiAccepted) {
    const done = await until('S12-dispatch-done-soft', async () => {
      const s = await api('/state')
      const t = (s.body.tasks as { tasks?: { id?: string, dispatch?: { status?: string, session_id?: string, reply?: string } }[] } | undefined)?.tasks?.find(x => x.id === kid)
      return t?.dispatch !== undefined && ['done', 'failed', 'stopped'].includes(t.dispatch.status ?? '') ? t.dispatch : undefined
    }, 240_000)
    recordSoft('S12-kimi-dispatch', { passed: done !== undefined && (done as { status?: string }).status === 'done', dispatch: done ?? null, elapsedSec: Math.round((Date.now() - mark12) / 1000) })
    const state12 = await api('/state')
    const kcard = (state12.body.tasks as { tasks?: { id?: string, links?: { agent?: string, session_id?: string }[] }[] } | undefined)?.tasks?.find(t => t.id === kid)
    const kimiLink = kcard?.links?.find(l => l.agent === 'kimi')
    recordSoft('S12-kimi-linked', { passed: kimiLink !== undefined && typeof kimiLink.session_id === 'string', links: kcard?.links ?? [] })
    if (kimiLink !== undefined) {
      const ksess = String(kimiLink.session_id)
      // 来源视图:这条 CLI 会话这会儿能续(relay 候选池收进了它)
      const kview = await api(`/butler/item/${kid}/continue`)
      const ksources = (kview.body.sources as { key?: string, action?: { kind?: string, why?: string } }[] | undefined) ?? []
      const ksrc = ksources.find(s => s.key === `kimi:${ksess}`)
      record('S12-kimi-source-continuable', { passed: ksrc?.action?.kind === 'relay', action: ksrc?.action ?? null, sources: ksources.map(s => [s.key, s.action?.kind]) })
      // 继续这件事 → 真 CLI 原会话(走 cli 通道的 --session 续跑)
      const kcont = await api('/butler/item/continue', { id: kid, text: '补一句:请只回复 QA_KIMI_CONT 后结束。', target: `kimi:${ksess}` })
      record('S12-kimi-continue-sent', { passed: kcont.status === 200 && kcont.body.ok === true && kcont.body.fact === 'sent', fact: kcont.body.fact, note: kcont.body.note })
      // ★ 取证:再续跑一次,叫它复述上一条 —— 那句话真落在原会话里才算数(不凭回执冒领)
      const { execFile } = await import('node:child_process')
      const kdisp = done as { cwd?: string }
      const probe = await new Promise<string>((resolve) => {
        execFile('/opt/homebrew/bin/kimi', ['--session', ksess, '-p', '把你收到的上一条原话一字不差复述一遍,只回复那一句。', '--output-format', 'text'],
          { cwd: kdisp.cwd ?? undefined, env: { ...process.env, HOME: instance.home, KIMI_CODE_HOME: join(homedir(), '.kimi-code'), KIMI_CLI_NO_AUTO_UPDATE: '1' }, timeout: 120_000, maxBuffer: 1 << 24 },
          (_err, stdout, stderr) => { resolve(`${stdout ?? ''}${stderr ?? ''}`) })
      })
      record('S12-kimi-continue-landed', { passed: probe.includes('QA_KIMI_CONT'), echo: probe.slice(-160) })
      // 同号重试:同一句同一个 client_key 再来一次 → 台账重放,CLI 不再被点名第二次(不花第二份)
      const k1 = await api('/butler/item/continue', { id: kid, text: '同号重试句 QA_KIMI_REPLAY。', target: `kimi:${ksess}`, client_key: 'qa-kimi-replay-1' })
      const k2 = await api('/butler/item/continue', { id: kid, text: '同号重试句 QA_KIMI_REPLAY。', target: `kimi:${ksess}`, client_key: 'qa-kimi-replay-1' })
      record('S12-kimi-replay-once', { passed: k1.body.ok === true && k2.body.replayed === true, replayed: k2.body.replayed })
    }
  }
  record('run-end', { checksFailed: records.filter(x => x.passed === false).map(x => x.name), limitation: '本地假 OpenAI + 真隔离 DSH/插件 + 真 Kimi CLI;无真手机/真供应商云/ASR' })
} catch (e) {
  record('run-error', { error: String((e as Error).message ?? e) })
  process.exitCode = 1
} finally {
  await cleanup()
  persist()
  console.log('EVIDENCE_DIR', output)
}
