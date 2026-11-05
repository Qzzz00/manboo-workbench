/**
 * 只起真实例(供浏览器腿跑完再停):node dev/collab-a-acceptance/serve.mts
 * 起好后 8993 可用;Ctrl-C / SIGTERM 停干净(含 S10 式重启出来的进程按路径精确停)。
 */
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { startAInstance, PORTS } from './instance.mts'
import { sayListFor } from './say-list-pin.mts'
import { assertPhoneAcceptanceAttachment } from '../acceptance-three-entrances/phonePorts.ts'

const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname)
const REPO = join(HERE, '..', '..', '..')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const output = process.env.COLLAB_A_ACCEPTANCE_OUTPUT_DIR === undefined
  ? join(homedir(), '.cache', 'collab-a-acceptance', `serve-${Date.now()}`)
  : resolve(process.env.COLLAB_A_ACCEPTANCE_OUTPUT_DIR)
mkdirSync(output, { recursive: true, mode: 0o700 })
const attachedRoot = process.env.COLLAB_A_ACCEPTANCE_ATTACH_ROOT
const root = attachedRoot === undefined ? join(output, 'instance') : resolve(attachedRoot)
if (attachedRoot !== undefined) assertPhoneAcceptanceAttachment(JSON.parse(readFileSync(join(root, 'instance.json'), 'utf8')), root, { dsh: PORTS.dsh, workbench: PORTS.workbench, module: PORTS.module, butler: PORTS.butler, connector: PORTS.connector, textTurn: PORTS.textTurn })
const fixturePlans: Record<string, unknown> = process.env.COLLAB_A_ACCEPTANCE_MODEL_FIXTURE_FILE === undefined ? {} : JSON.parse(readFileSync(process.env.COLLAB_A_ACCEPTANCE_MODEL_FIXTURE_FILE, 'utf8'))
const ownKey = 'collab-a-fake-own-key-not-personal'
const allPorts = attachedRoot === undefined ? Object.values(PORTS) : [PORTS.model, PORTS.livekit, PORTS.rtcTcp, PORTS.rtcUdp]
for (const port of allPorts) {
  try {
    const listeners = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (listeners !== '') throw new Error(`端口 ${port} 已被占用，拒绝启动隔离实例`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('端口 ')) throw error
  }
}
try {
  const udp = execFileSync('lsof', ['-nP', `-iUDP:${PORTS.rtcUdp}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  if (udp !== '') throw new Error(`UDP 端口 ${PORTS.rtcUdp} 已被占用，拒绝启动隔离实例`)
} catch (error) {
  if (error instanceof Error && error.message.startsWith('UDP 端口 ')) throw error
}

async function fakeHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let raw = ''
  for await (const c of req) raw += c
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(raw) } catch { /* 空 */ }
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/health' || req.url?.endsWith('/health')) { res.end(JSON.stringify({ ok: true, providers: { deepseek: true } })); return }
  if (req.url?.endsWith('/models')) { res.end(JSON.stringify({ object: 'list', data: [{ id: 'collab-a-brain', object: 'model', owned_by: 'qa' }] })); return }
  if (!req.url?.endsWith('/chat/completions')) { res.statusCode = 404; res.end('{}'); return }
  const messages = (body.messages ?? []) as { role?: string, content?: unknown }[]
  const text = JSON.stringify(messages)
  // 1a 验收:say 模型的确定性回法 —— 用户消息里带「她说:「X」」时,按句子回一份命令清单(不经真模型,钉行为)。
  const saidMatch = /她说:「([\s\S]*?)」/.exec(String((messages[messages.length - 1] as { content?: unknown } | undefined)?.content ?? ''))
  if (saidMatch !== null) {
    const fixture = fixturePlans[(saidMatch[1] ?? '').trim()]
    if (fixture !== undefined) {
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fixture) } }], finish_reason: 'stop' }))
      return
    }
    // SAY_REAL=1:这份「听懂」交给真 Kimi(既有授权正常调用;--output-format text,JSON 纪律靠系统提示)。
    if (process.env.SAY_REAL === '1') {
      const { execFile } = await import('node:child_process')
      const system = String((messages.find(m => m.role === 'system') as { content?: unknown } | undefined)?.content ?? '')
      const user = String((messages[messages.length - 1] as { content?: unknown } | undefined)?.content ?? '')
      const real = await new Promise<string>((resolve) => {
        execFile('/opt/homebrew/bin/kimi', ['-p', `${system}\n\n${user}`, '--output-format', 'text'],
          { env: { ...process.env, KIMI_CODE_HOME: `${process.env.HOME}/.kimi-code`, KIMI_CLI_NO_AUTO_UPDATE: '1' }, timeout: 90_000, maxBuffer: 1 << 24 },
          (_e, stdout) => { resolve(stdout ?? '') })
      })
      res.end(JSON.stringify({ choices: [{ message: { content: real } }], finish_reason: 'stop' }))
      return
    }
    const said = (saidMatch[1] ?? '').trim()
    const list = sayListFor(said)
    if (list !== undefined) {
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(list) } }], finish_reason: 'stop' }))
      return
    }
  }
  const marker = ['QA_BROWSER', 'QA_PHONE', 'QA_OFFLINE'].find(m => text.includes(m)) ?? 'QA_GENERIC'
  const reply = `收到,${marker} 的回复。`
  const common = { id: 'chatcmpl-serve', created: Math.floor(Date.now() / 1000), model: body.model }
  if (body.stream === true) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const delta of [{ role: 'assistant', content: '' }, { content: reply }]) res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
    res.end()
  } else {
    res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }))
  }
}


const server = http.createServer((req, res) => { void fakeHandler(req, res).catch(() => { res.statusCode = 500; res.end('{}') }) })
await new Promise<void>((r, j) => { server.once('error', j); server.listen(PORTS.model, '127.0.0.1', () => r()) })
writeFileSync(join(output, 'livekit.yaml'), `port: ${PORTS.livekit}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${PORTS.rtcTcp}\n  udp_port: ${PORTS.rtcUdp}\n  use_external_ip: false\nkeys:\n  collab-a-local: collab-a-only-local-secret\nlogging:\n  level: error\n`, { mode: 0o600 })
const { spawn } = await import('node:child_process')
const livekit = spawn('/opt/homebrew/bin/livekit-server', ['--config', join(output, 'livekit.yaml')], { stdio: 'ignore' })
await sleep(2500)
const instance = attachedRoot === undefined
  ? await startAInstance({ root, repo: REPO, log: line => console.log('[instance]', line) })
  : { root, base: `http://127.0.0.1:${PORTS.workbench}`, stop: async () => {} }
if (attachedRoot !== undefined) {
  // Only the explicitly attached QA HOME is configured; the normal instance owner keeps its lifecycle.
  writeFileSync(join(root, 'iso', 'home', '.dsh', 'workbench', 'channel.json'), JSON.stringify({ url: `ws://127.0.0.1:${PORTS.livekit}`, api_key: 'collab-a-local', api_secret: 'collab-a-only-local-secret', room: 'collab-a-qa' }), { mode: 0o600 })
}
// 引导跳过(项目扫描被它闸着:scan_blocked「引导还没做完」)→ 扫描才跑,CLI 派活才认项目目录。
  await fetch(`${instance.base}/onboarding/skip-rest`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` }, body: JSON.stringify({ reason: '协作A验收' }) })
  await fetch(`${instance.base}/first-run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }) })
// 模型与凭据(浏览器腿直接可用)
await fetch(`http://127.0.0.1:${PORTS.workbench}/credentials`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` }, body: JSON.stringify({ provider: 'deepseek', key: ownKey }) })
await fetch(`http://127.0.0.1:${PORTS.workbench}/model`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` }, body: JSON.stringify({ mode: 'own', own_base_url: `http://127.0.0.1:${PORTS.model}/v1`, own_model: 'collab-a-brain' }) })
// 默认浏览器腿保留原种子；附着 App 模式只接线，不额外创建回执卡。
let createdJson: { id?: string } = {}
if (attachedRoot === undefined) {
  const created = await fetch(`http://127.0.0.1:${PORTS.workbench}/butler/item`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` }, body: JSON.stringify({ text: '请只回复 QA_BROWSER_SEED,不使用工具。', orientation: 'portrait', can_meeting_plan: true }) })
  createdJson = await created.json() as { id?: string }
}
if (attachedRoot !== undefined) {
  // Logout only clears the account session; the device-bound relay can still run.
  // Use only this validated QA profile's public device_id, never another account device.
  const ownDevice = (JSON.parse(readFileSync(join(root, 'iso', 'home', '.dsh', 'workbench', 'model.json'), 'utf8')) as { device_id?: unknown }).device_id
  const devices = await fetch(`${instance.base}/account/devices`)
  if (devices.ok) {
    const list = await devices.json() as { devices?: { device_id?: string }[] }
    if (typeof ownDevice === 'string' && list.devices?.some(one => one.device_id === ownDevice)) {
      const revoked = await fetch(`${instance.base}/account/devices/revoke`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` }, body: JSON.stringify({ device_id: ownDevice }) })
      if (!revoked.ok) throw new Error(`own QA relay device revoke failed (${revoked.status})`)
    }
  }
  await fetch(`${instance.base}/account/logout`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` }, body: '{}' })
  await fetch(`${instance.base}/channel/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` }, body: '{}' })
  // The production supervisor can return after its bounded exit grace. Wait for
  // our text listener to close before a replacement can write the same token file.
  const deadline = Date.now() + 15_000
  for (;;) {
    let listening = false
    try { listening = execFileSync('lsof', ['-t', '-nP', `-iTCP:${PORTS.textTurn}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '' } catch { /* closed */ }
    if (!listening) break
    if (Date.now() >= deadline) throw new Error('own QA text port did not close after channel/stop')
    await sleep(100)
  }
  await fetch(`${instance.base}/channel/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` }, body: '{}' })
}
console.log('SERVE_READY card=', createdJson.id, 'base=', instance.base)

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  try {
    const pid = execFileSync('lsof', ['-t', '-nP', `-iTCP:${PORTS.dsh}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (pid !== '') {
      const cmd = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' })
      if (cmd.includes(output)) process.kill(Number(pid), 'SIGTERM')
    }
  } catch { /* 已空 */ }
  await instance.stop()
  if (attachedRoot !== undefined) await fetch(`${instance.base}/channel/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` }, body: '{}' }).catch(() => {})
  const roomStopped = livekit.exitCode !== null || livekit.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => livekit.once('exit', () => resolve()))
  livekit.kill('SIGKILL')
  await roomStopped
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections() })
  const busy: number[] = []
  for (const p of allPorts) {
    try { if (execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '') busy.push(p) } catch { /* 空闲 */ }
  }
  console.log('SERVE_STOPPED remainingPorts=', JSON.stringify(busy))
  process.exit(busy.length === 0 ? 0 : 2)
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void stop() })
