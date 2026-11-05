/**
 * 1a 原 7 句矩阵验收(2026-10-24 补轮,卡 t-1fc4c898):既有三入口句子集 + 既有 judge(一字不改,
 *  import 原文件),只跑 1a 的两列 —— 电脑对话框(desk,/butler/item 兼容层)与手机文字(phone,
 *  设备令牌 + 手机自己的 chatModel)。电话(真音频/文字口)是 1b,不跑;s7 旁人插话仅电话 → 如实 n/a。
 *
 * 真链路:隔离实例(instance.mts,3193/8993,本树现打的插件包)+ 自有假上游(19893;SAY_REAL=1
 *  时「听懂」转真 Kimi 桥,与产品同一 modelService 入口)+ 自起 butler-server(8992,换音色)。
 * 证据:./run-1a-matrix-<ts>/{evidence.json,report.md}。退出码 0=两列全过(n/a/skipped 不算),1=有红。
 * 用法:实例未起时 `SAY_REAL=1 node dev/collab-a-acceptance/run-1a-matrix.mts`(它自己起全套并清理)。
 */
import http from 'node:http'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startAInstance, PORTS } from './instance.mts'
import { sayListFor } from './say-list-pin.mts'
import { loadSentences, judge, renderReport, type RunResult, type Observation, type TurnFact, type CardFact } from '../acceptance-three-entrances/judge.ts'
import { sayAtDesk, sayOnPhone, phoneBubble, loadPhoneModel, readState, diffState, cardFactOf, cleanup, settle, settleSessions, type StateLike } from '../acceptance-three-entrances/entrances.ts'
import { deskReceiptOf, phonePendingOf, type ItemAnswer } from '../acceptance-three-entrances/receipts.ts'

const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname)
const REPO = join(HERE, '..', '..', '..')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const out = join(HERE, `run-1a-matrix-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })
const base = `http://127.0.0.1:${PORTS.workbench}`
const localOrigin = `http://127.0.0.1:${PORTS.dsh}`
const ownKey = 'collab-a-fake-own-key-not-personal'
const SAY_REAL = process.env.SAY_REAL === '1'
const records: Record<string, unknown>[] = []
const persist = () => writeFileSync(join(out, 'evidence.json'), JSON.stringify(records, null, 2), { mode: 0o600 })
function record(name: string, data: Record<string, unknown>): void {
  records.push({ at: new Date().toISOString(), name, ...data }); persist(); console.log(name, JSON.stringify(data))
}

/** 自有假上游(19893):健康/用量/模型目录 + chat/completions。SAY_REAL=1 时把「听懂」转真 Kimi 桥。 */
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
  const messages = (body.messages ?? []) as { role?: string, content?: unknown }[]
  const saidMatch = /她说:「([\s\S]*?)」/.exec(String(messages[messages.length - 1]?.content ?? ''))
  if (body.model !== 'collab-a-brain') { res.statusCode = 400; res.end(JSON.stringify({ error: { code: 'QA_UNKNOWN_MODEL' } })); return }
  let reply: string
  if (SAY_REAL && saidMatch !== null) {
    // 真模型轮:这份「听懂」交真 Kimi(既有授权正常调用;--output-format text,JSON 纪律靠系统提示)。
    const system = String(messages.find(m => m.role === 'system')?.content ?? '')
    const user = String(messages[messages.length - 1]?.content ?? '')
    record('upstream-real-understand', { said: saidMatch[1] })
    const kimiRun = await new Promise<{ stdout: string, code: number | null, stderr: string }>((resolve) => {
      execFile('/opt/homebrew/bin/kimi', ['-p', `${system}\n\n${user}`, '--output-format', 'text'],
        { env: { ...process.env, KIMI_CODE_HOME: join(homedir(), '.kimi-code'), KIMI_CLI_NO_AUTO_UPDATE: '1' }, timeout: 120_000, maxBuffer: 1 << 24 },
        (e, stdout, stderr) => { resolve({ stdout: stdout ?? '', code: typeof e?.code === 'number' ? e.code : (e === null ? 0 : null), stderr: (stderr ?? '').slice(0, 300) }) })
    })
    reply = kimiRun.stdout
    record('upstream-real-reply', { said: saidMatch[1], reply: reply.slice(0, 800), ...(reply.trim() === '' ? { empty: true, code: kimiRun.code, stderr: kimiRun.stderr } : {}) })
  }
  else {
    // 假上游钉版:矩阵句子回钉死的命令清单(确定性回归);不认得的句子兜底「保守先记」。
    const pinned = saidMatch !== null ? sayListFor((saidMatch[1] ?? '').trim()) : undefined
    reply = pinned !== undefined
      ? JSON.stringify(pinned)
      : JSON.stringify({ addressed: true, items: [{ kind: '记', title: '没钉这句', risk: 'none', confidence: 0.3, why: 'qa-fallback' }] })
    record('upstream-understand', { said: saidMatch?.[1] ?? null, model: body.model, pinned: pinned !== undefined, reply: reply.slice(0, 400) })
  }
  const common = { id: 'chatcmpl-collab-a', created: Math.floor(Date.now() / 1000), model: body.model }
  res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
}

let instance: Awaited<ReturnType<typeof startAInstance>> | undefined, server: http.Server | undefined, butler: ReturnType<typeof spawn> | undefined, cleaning = false
async function cleanupAll(): Promise<void> {
  if (cleaning) return
  cleaning = true
  try {
    if (butler) { butler.kill('SIGTERM'); await sleep(1500) }
    if (instance) await instance.stop()
    if (server) await new Promise(r => server!.close(r))
    const busy: number[] = []
    for (const p of [3193, 8992, 8993, 8994, 8996, 8997, 19893, 19994, 19995, 19996]) {
      try { if (execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '') busy.push(p) } catch { /* 空闲 */ }
    }
    record('cleanup-result', { passed: busy.length === 0, remainingPorts: busy })
  } catch (e) { record('cleanup-error', { error: String(e) }) }
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void cleanupAll().finally(() => process.exit(130)) })

try {
  for (const p of [3193, 8992, 8993, 8994, 8996, 8997, 19893]) {
    try { if (execFileSync('lsof', ['-t', '-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '') throw new Error('BUSY_' + p) } catch (e) { if (String((e as Error).message).startsWith('BUSY')) throw e }
  }
  server = http.createServer((req, res) => { void fakeHandler(req, res).catch(() => { res.statusCode = 500; res.end('{}') }) })
  await new Promise((r, j) => { server!.once('error', j); server!.listen(19893, '127.0.0.1', r) })
  record('fake-upstream-ready', { port: 19893, sayReal: SAY_REAL })

  instance = await startAInstance({ root: join(out, 'instance'), repo: REPO, log: line => console.log('[instance]', line) })
  // 引导跳过 + 假手机配对(与手机 App 同一条路)。
  const postLocal = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${instance!.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: localOrigin }, body: JSON.stringify(body) })
    return await res.json().catch(() => ({})) as Record<string, unknown>
  }
  await postLocal('/onboarding/skip-rest', { reason: '1a 矩阵验收' })
  await postLocal('/first-run', { done: true })
  await postLocal('/credentials', { provider: 'deepseek', key: ownKey })
  const modelPut = await fetch(`${instance.base}/model`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: localOrigin }, body: JSON.stringify({ mode: 'own', own_base_url: 'http://127.0.0.1:19893/v1', own_model: 'collab-a-brain' }) })
  record('model-pointed-own', { status: modelPut.status, ok: (await modelPut.json().catch(() => ({})) as { ok?: boolean }).ok === true })

  // 中转共享测试账号(验收设施,与三入口架同一个账号文件;不是个人凭据,不打印)。
  // 语音钥匙要登上中转才由工作台转给语音后端——不登的话第 4 句音色那一项判不了。
  const accountFile = join(homedir(), 'Library', 'Application Support', 'workbench-acceptance', 'relay-account.json')
  try {
    const account = JSON.parse(readFileSync(accountFile, 'utf8')) as { username?: string, password?: string, registered?: boolean }
    if (typeof account.username === 'string' && typeof account.password === 'string') {
      const auth = await postLocal(account.registered === true ? '/account/login' : '/account/register',
        account.registered === true
          ? { username: account.username, password: account.password }
          : { username: account.username, password: account.password, confirm: account.password })
      record('relay-test-account', { status: auth.status, ok: auth.ok === true || auth.status < 300, registered: account.registered === true })
      if (account.registered !== true && auth.status < 300) {
        writeFileSync(accountFile, JSON.stringify({ ...account, registered: true }), { mode: 0o600 })
      }
    }
    else record('relay-test-account', { skipped: '账号文件形状不对' })
  } catch (e) { record('relay-test-account', { skipped: String((e as Error).message).slice(0, 80) }) }
  const pairing = await postLocal('/pair/start', {})
  const code = (pairing.pairing as { code?: string } | undefined)?.code
  if (code === undefined) throw new Error(`配对码没生成:${JSON.stringify(pairing).slice(0, 200)}`)
  const claimed = await postLocal('/pair/claim', { code, device_name: '1a 验收假手机', platform: 'android' })
  const phoneToken = claimed.token as string | undefined
  if (typeof phoneToken !== 'string') throw new Error(`假手机配对没成:${JSON.stringify(claimed).slice(0, 200)}`)
  record('phone-paired', { ok: true })

  // 自己的语音后端(8992):换音色(s4)要真读真写;语音钥匙回环问隔离实例要。
  const butlerLog = openSync(join(out, 'butler.log'), 'a')
  butler = spawn(join(instance.home, '.dsh', 'node', 'bin', 'node'), [join(REPO, 'butler-server', 'server', 'index.cjs')],
    { cwd: join(REPO, 'butler-server'), env: { ...process.env, HOME: instance.home, DSH_HOME: join(instance.home, '.dsh'), BUTLER_WORKBENCH_URL: base }, stdio: ['ignore', butlerLog, butlerLog] })
  butler.unref()
  const butlerBase = `http://127.0.0.1:${PORTS.butler}`
  let butlerUp = false
  for (let i = 0; i < 30; i += 1) { try { butlerUp = (await fetch(`${butlerBase}/health`)).ok; if (butlerUp) break } catch { /* 还没起 */ } await sleep(1000) }
  record('butler-voice', { up: butlerUp })
  const voiceNow = async (): Promise<string | undefined> => {
    if (!butlerUp) return undefined
    try {
      const res = await fetch(`${butlerBase}/api/voices`)
      const body = await res.json() as { current?: { id?: string, name?: string, gender?: string } | null }
      const v = body.current
      return v === null || v === undefined ? undefined : `${v.name ?? '?'}·${v.gender ?? '?'}·${v.id ?? '?'}`
    } catch { return undefined }
  }
  let maleVoice: string | undefined
  const resetVoice = async (): Promise<string | undefined> => {
    if (!butlerUp) return '语音后端没起来,换音色那项判不了'
    try {
      if (maleVoice === undefined) {
        const end = Date.now() + 90_000
        while (Date.now() < end) {
          const res = await fetch(`${butlerBase}/api/voices`)
          const list = await res.json() as { voices?: { id?: string, gender?: string, speaks_chinese?: boolean, ok?: boolean }[] }
          maleVoice = (list.voices ?? []).find(v => v.gender === '男' && v.speaks_chinese === true && v.ok !== false)?.id
          if (maleVoice !== undefined) break
          await sleep(2000)
        }
      }
      if (maleVoice === undefined) return '音色单里挑不到会说中文的男声'
      const res = await fetch(`${butlerBase}/api/voices/current`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice_id: maleVoice }) })
      return res.ok ? undefined : `换男声没成(${res.status})`
    } catch (err) { return `换男声没成:${(err as Error).message}` }
  }

  const phoneModelNote = await loadPhoneModel(REPO)
  // SENTENCES_FILE=变式句子集(同期望换说法,真模型多法性轮);缺省 = 三入口原句子集。
  const sentences = loadSentences(process.env.SENTENCES_FILE ?? new URL('../acceptance-three-entrances/sentences.json', import.meta.url))
  const results: RunResult[] = []
  const notes: string[] = [
    `1a 矩阵(卡 t-1fc4c898 原范围补齐):真隔离 DSH/插件 + SAY_REAL=${SAY_REAL ? '真 Kimi 听懂' : '假上游钉版'}; judge/sentences 原文件未改。`,
    ...(phoneModelNote === undefined ? [] : [phoneModelNote]),
    '电话两列(真音频/文字口)是 1b,未跑;s7 旁人插话如实 n/a。',
  ]

  /** 一句跑一列;前后 /state 差集就是这一句建的卡;跑完清场(停会话/删卡/拒单)。 */
  const runCell = async (s: (typeof sentences)[number], column: 'desk' | 'phone'): Promise<void> => {
    const voiceSetup = s.expect.voice === undefined ? undefined : await resetVoice()
    const voiceBefore = s.expect.voice === undefined ? undefined : await voiceNow()
    const before = await readState(base)
    const turns: TurnFact[] = []
    let error: string | undefined
    try {
      for (const [i, text] of s.turns.entries()) {
        const beforeTurn = await readState(base)
        if (column === 'desk') {
          const { answer, turn } = await sayAtDesk(base, text)
          const afterTurn = await settle(base, {}, 2500, 20_000)
          const asks = diffState(beforeTurn, afterTurn).asksAdded
          turns.push({ ...turn, ...(asks === 0 ? {} : { approvalsAdded: asks }) })
        }
        else {
          const t0 = Date.now()
          const { answer, ok } = await sayOnPhone(base, phoneToken, text)
          const afterTurn = await settle(base, {}, 2500, 20_000)
          const asks = diffState(beforeTurn, afterTurn).asksAdded
          const settled = await settleSessions(base, beforeTurn, 5000, 60_000)
          const bubble = phoneBubble(answer as ItemAnswer, ok, settled.state)
          turns.push({ said: text, reply: bubble, ms: Date.now() - t0, ...(asks === 0 ? {} : { approvalsAdded: asks }) })
        }
      }
    } catch (e) { error = String((e as Error).message ?? e) }
    const settledAll = await settleSessions(base, before, 5000, 90_000)
    const after = settledAll.state
    const newCards: CardFact[] = diffState(before, after).newTasks.map(cardFactOf)
    const voiceAfter = s.expect.voice === undefined ? undefined : await voiceNow()
    const obs: Observation = {
      sentence: s.id,
      entrance: column,
      turns,
      newCards,
      ...(s.expect.voice === undefined ? {} : { voice: { before: voiceBefore, after: voiceAfter } }),
      ...(error === undefined ? {} : { error }),
      ...(voiceSetup === undefined ? {} : { notes: [voiceSetup] }),
    }
    results.push({ sentence: s, entrance: column, column, observation: obs })
    const verdict = judge(s, obs)
    record(`cell-${s.id}-${column}`, { status: verdict.status, reasons: verdict.reasons, cards: newCards.map(c => [c.title, c.status, c.assignee]) })
    await cleanup(base, after, newCards.map(c => c.id))
  }

  const filter = (process.env.SENTENCES_FILTER ?? '').split(',').map(one => one.trim()).filter(one => one !== '')
  for (const s of sentences) {
    if (filter.length > 0 && !filter.includes(s.id)) continue
    if (s.id === 's7') {
      // 旁人插话只走电话(1b):两列如实 n/a,不冒跑。
      for (const column of ['desk', 'phone'] as const) {
        results.push({ sentence: s, entrance: column, column, observation: { sentence: s.id, entrance: column, turns: [], newCards: [] } })
      }
      record('cell-s7-na', { note: '旁人插话是电话那一列(1b)的事' })
      continue
    }
    await runCell(s, 'desk')
    await runCell(s, 'phone')
  }

  const report = renderReport({ title: `三入口同一组句子 · 1a 矩阵(${new Date().toISOString().slice(0, 10)})`, meta: notes, sentences, results })
  writeFileSync(join(out, 'report.md'), report)
  const failed = results.filter(r => { const v = judge(r.sentence, r.observation); return v.status === 'fail' || v.status === 'error' })
  record('matrix-end', { checksFailed: failed.map(f => `${f.sentence.id}-${f.column}`), limitation: '电话两列是 1b 未跑;真手机未验;真云模型=真 Kimi 桥' })
  console.log('REPORT', join(out, 'report.md'))
  process.exitCode = failed.length === 0 ? 0 : 1
} catch (e) {
  record('run-error', { error: String((e as Error).message ?? e) })
  process.exitCode = 2
} finally {
  await cleanupAll()
  persist()
}
