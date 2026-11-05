/** Opt-in normal-provider instance for production App room/API acceptance. No test messages are generated here. */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { startInstance, PORTS } from './instance.ts'
const root = resolve(process.env.PHONE_ACCEPTANCE_ROOT ?? (() => { throw new Error('PHONE_ACCEPTANCE_ROOT required') })())
mkdirSync(root, { recursive: true, mode: 0o700 })
const repo = resolve(import.meta.dirname, '..', '..', '..')
const instance = await startInstance({ root, repo, build: true, textTurn: true, log: line => console.log(line) })
const saved = JSON.parse(readFileSync(join(root, 'instance.json'), 'utf8')) as { phoneId: string }
const response = await fetch(`${instance.base}/model`)
const model = await response.json() as Record<string, unknown>
writeFileSync(join(root, 'model-status.json'), JSON.stringify({ status: response.status, ready: model.ready, relay_configured: model.relay_configured, relay_token_configured: model.relay_token_configured }), { mode: 0o600 })
writeFileSync(join(root, 'app-session.json'), JSON.stringify({ pairing: { token: instance.phoneToken, deviceId: saved.phoneId, host: '127.0.0.1', port: PORTS.workbench }, base: instance.base, origin: `http://127.0.0.1:${PORTS.dsh}`, textTurn: { port: PORTS.textTurn, tokenFile: join(root, 'iso', 'text-turn.token') } }), { mode: 0o600 })
console.log('ROOM_APP_READY', JSON.stringify({ base: instance.base, modelStatus: response.status, ready: model.ready }))
let stopping = false
const stop = async () => { if (stopping) return; stopping = true; await instance.stop(); rmSync(join(root, 'app-session.json'), { force: true }); rmSync(join(root, 'logs', 'web.stdout.log'), { force: true }); console.log('ROOM_APP_STOPPED'); process.exit(0) }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop() })
const keepAlive = setInterval(() => {}, 30_000)
await new Promise(() => { void keepAlive })
