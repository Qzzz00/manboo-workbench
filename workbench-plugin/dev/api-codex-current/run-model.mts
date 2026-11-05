/** 当前生产 relay 所选模型的精确 Say 探针；仅使用已授权验收账号，凭据不输出。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { relayLogin, relayRegisterDevice } from '../../src/server/relayAccountApi.ts'
import { modelEndpointOf } from '../../src/server/modelConfig.ts'
import { understandByModel } from '../../src/server/sayModel.ts'
const out = process.env.QA_API_OUTPUT
if (!out) throw new Error('QA_API_OUTPUT required')
mkdirSync(out, { recursive: true, mode: 0o700 })
const config = readFileSync(new URL('../../../deploy/release-endpoints.env', import.meta.url), 'utf8')
const relayUrl = /^WORKBENCH_BUILD_RELAY_URL=(.+)$/m.exec(config)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
if (!relayUrl) throw new Error('Build relay endpoint missing')
const account = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/workbench-acceptance/relay-account.json'), 'utf8'))
const login = await relayLogin({ relayUrl, identifier: account.username, password: account.password })
if (!login.ok) { console.log(JSON.stringify({ stage: 'login', ok: false, status: 'status' in login ? login.status : undefined })); process.exit(1) }
const device = await relayRegisterDevice({ relayUrl, session: login.value.session_token, deviceId: 'qa-api-codex-current-1024', name: 'API定向验收', kind: 'other' })
if (!device.ok) { console.log(JSON.stringify({ stage: 'device', ok: false, status: 'status' in device ? device.status : undefined })); process.exit(1) }
const endpoint = modelEndpointOf({ mode: 'relay', relay_url: relayUrl, relay_token: device.value.token, device_id: 'qa-api-codex-current-1024' })
const cases = JSON.parse(readFileSync(new URL('../acceptance-three-entrances/sentences.json', import.meta.url), 'utf8')).sentences
const records: unknown[] = []
for (const id of ['s3', 's4', 's5', 's6']) {
 const s = cases.find((v: { id: string }) => v.id === id)
 const said = s.turns?.[0]
 if (typeof said !== 'string') throw new Error(`Unknown fixture shape ${id}`)
 let trace: Record<string, unknown> = {}
 const result = await understandByModel(said, { inCall: true, dispatchables: [{ id: 'claude', title: 'Claude' }] }, {
  endpoint: async () => ({ ...endpoint, key: endpoint.key }),
  fetchImpl: async (url, init) => {
   const request = JSON.parse(String(init?.body)); const r = await fetch(url, init); const b = await r.clone().json().catch(() => ({}))
   trace = { status: r.status, requestedModel: request.model, returnedModel: b.model, finishReason: b.choices?.[0]?.finish_reason, content: b.choices?.[0]?.message?.content }
   return r
  },
 })
 records.push({ id, said, trace, result })
 writeFileSync(join(out, 'model.json'), JSON.stringify(records, null, 2), { mode: 0o600 })
 console.log(JSON.stringify({ id, status: trace.status, requestedModel: trace.requestedModel, returnedModel: trace.returnedModel, items: result?.items.length, finishReason: trace.finishReason }))
}
