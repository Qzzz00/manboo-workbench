/** Capture-only normal DSH/bundle assembly. No real model, Agent reply or personal window. */
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { startInstance, PORTS, type Instance } from './instance.ts'
import { auditS4WindowQaCapture } from './s4WindowQa.ts'
import type { HelperRequest } from '../../src/server/helperChannel.ts'
import type { TaskView } from '../../src/protocol.ts'
import { loadSentences } from './judge.ts'

const root = resolve(process.env.PHONE_ACCEPTANCE_ROOT ?? (() => { throw new Error('explicit PHONE_ACCEPTANCE_ROOT required') })())
const home = join(root, 'iso/home')
const projectRepo = join(home, 'Documents/GitHub/样片')
const repo = resolve(import.meta.dirname, '../../..')
await mkdir(root, { recursive: true, mode: 0o700 })
process.env.WORKBENCH_S4_WINDOW_QA = JSON.stringify({ version: 1, enabled: true, root, home, profileDir: join(home, '.dsh/profiles/web'), projectId: '样片', projectRepo })
process.env.PHONE_ACCEPTANCE_S4_ASSEMBLY_ONLY = '1'
const S4 = loadSentences().find(row => row.id === 's4')!.turns[0]!
// Same explicit transport fixture as the API owner's s4-host-bootstrap test, not model semantics.
const items = [
  { kind: '记', title: '周四下午给客户发样片', risk: 'none', confidence: 0.99, why: '记待办' },
  { kind: '办', title: '把样片剪一版', who: 'claude', risk: 'none', confidence: 0.99, why: '受控理解清单' },
  { kind: '改', title: '换个女声', risk: 'none', confidence: 0.99, why: '改设置' },
]
const modelRequests: unknown[] = [], captures: unknown[] = [], rejected: string[] = []
const provider = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-selected', object: 'model', owned_by: 'qa' }] })); return
  }
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}') as { messages?: unknown }
  if (!JSON.stringify(body.messages).includes(S4)) { res.writeHead(422).end('{}'); return }
  modelRequests.push(body)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ addressed: true, items }) } }] }))
})
let instance: Instance | undefined, socket: WebSocket | undefined, exit = 1
const post = async (path: string, body: unknown, method = 'POST') => {
  const response = await fetch(`${instance!.base}${path}`, { method, headers: { origin: `http://127.0.0.1:${PORTS.dsh}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data: unknown = await response.json()
  if (!response.ok) {
    await writeFile(join(root, 'http-error.json'), JSON.stringify({ path, status: response.status, data }, null, 2))
    throw new Error(`${path} HTTP ${response.status}`)
  }
  return data
}
try {
  await new Promise<void>((ok, fail) => { provider.once('error', fail); provider.listen(29693, '127.0.0.1', ok) })
  instance = await startInstance({ root, repo, build: false, textTurn: false, log: line => console.log(line) })
  await post('/onboarding/skip-rest', { reason: 's4 fixture assembly only' })
  await post('/first-run', { done: true })
  const model = await (await fetch(instance.base + '/model')).json() as Record<string, unknown>
  if (model.mode !== 'own' || model.own_base_url !== 'http://127.0.0.1:29693/v1' || model.own_model !== 'fixture-selected') throw new Error('normal assembly fixture model not configured at boot')
  socket = new WebSocket(instance.base.replace('http:', 'ws:') + '/helper')
  const ws = socket
  ws.on('message', async data => {
    const message = JSON.parse(String(data)) as HelperRequest & { kind?: string; id?: number }
    if (message.kind !== 'req') return
    try {
      if (message.op === 'send_text') {
        const state = JSON.parse(await readFile(join(home, '.dsh/workbench/tasks.json'), 'utf8')) as { tasks: TaskView[] }
        const candidates = state.tasks.filter(task => task.title === items[1]!.title && task.project_id === '样片')
        if (candidates.length !== 1) throw new Error('QA_CAPTURE_REJECTED: task scope ambiguous')
        auditS4WindowQaCapture(message, candidates[0]!, false) // Actual normal UI identity stays submit:false.
        captures.push({ request: message, task: candidates[0] })
        ws.send(JSON.stringify({ kind: 'res', id: message.id, ok: true, result: { submitted: false, method: 'capture-only-no-window' } }))
      } else ws.send(JSON.stringify({ kind: 'res', id: message.id, ok: true, result: { found: false, busy: false } }))
    } catch (error) {
      const reason = String(error); rejected.push(reason)
      ws.send(JSON.stringify({ kind: 'res', id: message.id, ok: false, error: reason }))
    }
  })
  await new Promise<void>((ok, fail) => { ws.once('open', ok); ws.once('error', fail) })
  ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: 'QA_CAPTURE_ONLY', caps: ['new_conversation', 'read_reply'] }))
  await new Promise(resolve => setTimeout(resolve, 500))
  const result = await post('/butler/say', { text: S4 })
  await writeFile(join(root, 'say-result.json'), JSON.stringify(result, null, 2))
  await writeFile(join(root, 'assembly-observation.json'), JSON.stringify({ fixtureOnly: true, modelRequests, captures, rejected, realModelCalls: 0, realAgentReplies: 0, personalWindows: 0 }, null, 2))
  if (captures.length !== 1 || rejected.length !== 0 || modelRequests.length !== 1) throw new Error('normal assembly did not capture exactly one safe original prompt')
  exit = 0
} catch (error) {
  await writeFile(join(root, 'assembly-error.txt'), String(error))
  console.error(String(error))
} finally {
  socket?.close()
  await instance?.stop()
  await new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections() })
  await writeFile(join(root, 'exit.json'), JSON.stringify({ exit, fixtureOnly: true, realModelCalls: 0, realAgentReplies: 0, personalWindows: 0 }))
}
process.exit(exit)
