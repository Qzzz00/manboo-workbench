/** Opt-in QA: load an existing controlled product task store; never create source links. */
import { mkdirSync, copyFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { startWorkbenchServer } from '../../src/server/http.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { createTasksService } from '../../src/server/tasks.ts'
import { createAuthorizationService } from '../../src/server/authorization.ts'
import { createPairingService } from '../../src/server/devices.ts'
import { decisionQaEnvironment } from './decisionQaEnvironment.mts'

const root = resolve(process.env.PHONE_REGISTERED_QA_ROOT ?? (() => { throw new Error('PHONE_REGISTERED_QA_ROOT required') })())
const original = resolve(process.env.PHONE_REGISTERED_QA_TASKS ?? (() => { throw new Error('PHONE_REGISTERED_QA_TASKS required') })())
const port = Number(process.env.PHONE_REGISTERED_QA_PORT ?? 9693)
mkdirSync(root, { recursive: true, mode: 0o700 })
const file = join(root, 'tasks.json')
if (existsSync(file)) throw new Error('QA output already has tasks; refuse overwrite')
copyFileSync(original, file)
const tasks = createTasksService({ file })
const authorization = createAuthorizationService({ file: join(root, 'authorization.md') })
await authorization.set('read_client_files', '可以', '2026-10-24')
await authorization.set('write_api', '可以', '2026-10-24')
const pairing = createPairingService({ file: join(root, 'devices.json') })
const decision = process.env.PHONE_REGISTERED_QA_ACTIONS === '1' ? await decisionQaEnvironment(root, tasks) : undefined
const server = await startWorkbenchServer({ port, service: createWorkbenchService({}), tasks, authorization, pairing, tickIntervalMs: 0, heartbeatMs: 0, ...decision?.options })
const request = async (path: string, body: unknown) => {
  const res = await fetch(server.url + path, { method: 'POST', headers: { origin: 'http://127.0.0.1:9695', 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return await res.json() as Record<string, any>
}
const started = await request('/pair/start', {})
const claimed = await request('/pair/claim', { code: started.pairing.code, device_name: '1c 独立浏览器验收', platform: 'web-qa' })
if (decision) writeFileSync(join(root, 'actions-ready.json'), JSON.stringify({ cardId: decision.cardId }))
const state = await tasks.list()
writeFileSync(join(root, 'provenance.json'), JSON.stringify({ original, sha256: createHash('sha256').update(await readFile(original)).digest('hex'), tasks: state.tasks.map(t => ({ id: t.id, links: t.links, dispatch: { family: t.dispatch?.family, session_id: t.dispatch?.session_id, status: t.dispatch?.status, cwd: t.dispatch?.cwd } })) }, null, 2))
writeFileSync(join(root, 'browser-session.json'), JSON.stringify({ token: claimed.token, deviceId: claimed.device_id, host: '127.0.0.1', port }), { mode: 0o600 })
console.log('REGISTERED_SOURCE_READY', server.url)
let stopping = false
const stop = async () => { if (stopping) return; stopping = true; await server.close(); await decision?.close(); rmSync(join(root, 'browser-session.json'), { force: true }); console.log('REGISTERED_SOURCE_STOPPED'); process.exit(0) }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop() })
await new Promise(() => {})
