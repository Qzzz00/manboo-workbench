/** One explicitly authorized original phone S4; no fixture model, synthetic reply or personal profile. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises'
import { existsSync, appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import WebSocket from 'ws'
import { verifyS4SourceProof, verifyS4InstalledBundle } from './s4SourceProof.ts'
import { startInstance, stopRoot, PORTS, type Instance } from './instance.ts'
import { createAuthorizedS4WindowBridge, s4OpeningCacheReady, type S4BridgeTask } from './s4AuthorizedBridge.ts'
import type { HelperRequest } from '../../src/server/helperChannel.ts'
import { loadSentences, judge } from './judge.ts'
import { cardFactOf, diffState, readState, sayToTextTurn, hangupTextTurn } from './entrances.ts'
const root = resolve(process.env.PHONE_ACCEPTANCE_ROOT ?? '')
const repo = resolve(import.meta.dirname, '../../..')
const probe = process.env.S4_QA_PROBE_APP
if (process.env.S4_AUTHORIZED_SINGLE_WINDOW !== '1' || !probe || !process.env.WORKBENCH_S4_WINDOW_QA || !root || root === repo) throw new Error('explicit approved single-window configuration required')
const home = join(root, 'iso/home'), exec = promisify(execFile)
await mkdir(root, { recursive: true, mode: 0o700 })
const save = async (name: string, value: unknown) => { await writeFile(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 }) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const s4 = loadSentences().find(row => row.id === 's4')!
let instance: Instance | undefined, socket: WebSocket | undefined, room: any, exit = 1, invoked = 0, preparationStarted = false
const evidence: Record<string, unknown> = { understandingSent: false, windowSendAttempts: 0, realWindowReceipt: false }
const packets: unknown[] = [], frames: Buffer[] = []
let audioRate = 0, audioChannels = 0, audioBytes = 0, audioPeak = 0
const log = (line: string) => console.log(new Date().toISOString(), line)
try {
  const sourceProof = await verifyS4SourceProof(repo, process.env.S4_QA_EXPECTED_FIXED_SHA, process.env.S4_QA_PROOF_ROOT, process.env.PHONE_ACCEPTANCE_WORKER_DIR)
  if ((await readdir(root)).length !== 0) throw new Error('fresh single-use QA root required; no old permit')
  evidence.source = sourceProof.currentGitSHA
  evidence.productFixedSource = sourceProof.expectedFixedSHA
  await save('source-before-start.json', sourceProof)
  preparationStarted = true
  instance = await startInstance({ root, repo, build: false, textTurn: true, log, sourceProof })
  const i = instance
  const req = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(i.base + path, { method, headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}`, ...((path.startsWith('/butler/proxy/') || path === '/channel/token') ? { authorization: `Bearer ${i.phoneToken}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
    const data: any = await r.json(); if (!r.ok) { await save('http-failure.json', { path, status: r.status, data }); throw new Error(`${path} HTTP ${r.status}`) }; return data
  }
  await req('/config/paths', 'PUT', { scan_roots: [{ path: join(home, 'Documents/GitHub'), depth: 1 }] })
  const state = await readState(i.base)
  await save('prepared-projects.json', state.projects)
  const model = await req('/model')
  await save('model-readiness.json', { mode: model.mode, ready: model.ready, relay_configured: model.relay_configured, relay_token_configured: model.relay_token_configured, own_model: model.own_model })
  if (model.ready !== true || model.mode !== 'relay') throw new Error('normal original relay provider not ready')
  const voices = await req('/butler/proxy/api/voices')
  const male = voices.voices?.find((v: any) => v.gender === '男' && v.speaks_chinese && v.ok !== false)
  if (!male) throw new Error('no supported Chinese male voice')
  await req('/butler/proxy/api/voices/current', 'PUT', { voice_id: male.id })
  const beforeVoice = (await req('/butler/proxy/api/voices')).current
  await save('voice-before.json', beforeVoice)
  if (beforeVoice?.id !== male.id || beforeVoice?.gender !== '男') throw new Error('male voice readback mismatch')
  const response = await fetch(i.base + '/butler/proxy/api/tts', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${i.phoneToken}` }, body: JSON.stringify({ text: '语音准备检查。', scene: 'chat', encoding: 'wav' }), signal: AbortSignal.timeout(30_000) })
  const wav = Buffer.from(await response.arrayBuffer())
  await save('tts-readiness.json', { status: response.status, bytes: wav.length, content_type: response.headers.get('content-type') })
  if (!response.ok || wav.toString('ascii', 0, 4) !== 'RIFF') throw new Error('real voice WAV not ready')
  await writeFile(join(root, 'readiness.wav'), wav)
  await req('/channel/start', 'POST', {})
  const why = await i.waitWorker('text'); if (why) throw new Error(why)
  // Both routes exist normally; the QA text port belongs only to the LAN route, as in existing replay helper.
  const workerLog = join(home, '.dsh/workbench/logs/channel-worker-relay.log')
  let warm = ''
  const warmEnd = Date.now() + 120_000
  while (Date.now() < warmEnd) {
    warm = await readFile(workerLog, 'utf8').catch(() => '')
    if (s4OpeningCacheReady(warm)) break
    await sleep(1000)
  }
  if (!s4OpeningCacheReady(warm)) throw new Error('worker opening cache not ready (see actual relay log)')
  await save('worker-ready.json', { textReady: true, openingCacheReady: true })
  const bridge = createAuthorizedS4WindowBridge({
    authorized: true,
    tasks: async () => (JSON.parse(await readFile(join(home, '.dsh/workbench/tasks.json'), 'utf8')) as { tasks: S4BridgeTask[] }).tasks,
    invoke: async request => {
      const number = ++invoked
      await save(`swift-${number}-request.json`, request)
      const out = join(root, `swift-${number}-result.json`)
      await exec('/usr/bin/open', ['-n', '-a', probe, '--args', 'op', JSON.stringify(request), '--out', out], { timeout: 10_000 })
      const until = Date.now() + (request.op === 'send_text' ? 55_000 : 15_000)
      while (!existsSync(out) && Date.now() < until) await sleep(150)
      const raw: any = JSON.parse(await readFile(out, 'utf8'))
      packets.push({ at: new Date().toISOString(), request, response: raw })
      if (request.op === 'send_text') { evidence.windowSendAttempts = Number(evidence.windowSendAttempts) + 1; evidence.submitted = raw.result?.submitted; await save('acceptance-progress.json', evidence) }
      return raw
    },
  })
  socket = new WebSocket(i.base.replace('http:', 'ws:') + '/helper')
  const ws = socket
  ws.on('message', data => { void (async () => {
    const message = JSON.parse(String(data)) as HelperRequest & { kind?: string; id?: number }
    if (message.kind !== 'req') return
    try {
      const raw: any = await bridge.handle(message)
      ws.send(JSON.stringify({ kind: 'res', id: message.id, ok: raw.ok === true, ...(raw.ok ? { result: raw.result } : { error: raw.error }) }))
    } catch (error) {
      appendFileSync(join(root, 'helper-denied.jsonl'), JSON.stringify({ at: new Date().toISOString(), op: message.op, error: String(error) }) + '\n')
      ws.send(JSON.stringify({ kind: 'res', id: message.id, ok: false, error: String(error) }))
    }
  })().catch(error => log(String(error))) })
  await new Promise<void>((ok, fail) => { ws.once('open', ok); ws.once('error', fail) })
  ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: 'S4_AUTHORIZED_ORIGINAL_SWIFT', caps: ['new_conversation', 'read_reply'] }))
  // Actual room observer: no synthesized events, no microphone, no call.start injection.
  const require = createRequire(join(repo, 'channel-worker/package.json'))
  const rtc = require('@livekit/rtc-node') as typeof import('@livekit/rtc-node')
  const ticket = await req('/channel/token', 'POST', {})
  room = new rtc.Room()
  room.registerTextStreamHandler('wb.rpc', async (reader: any, from: any) => {
    if (from?.identity !== 'wb-channel-worker') return
    appendFileSync(join(root, 'room-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), from: from.identity, text: await reader.readAll() }) + '\n')
  })
  room.on(rtc.RoomEvent.TrackSubscribed, (track: any, _publication: any, participant: any) => {
    if (track.kind !== rtc.TrackKind.KIND_AUDIO || participant.identity !== 'wb-channel-worker') return
    void (async () => {
      for await (const frame of new rtc.AudioStream(track)) {
        audioRate ||= frame.sampleRate; audioChannels ||= frame.channels
        if (frame.sampleRate !== audioRate || frame.channels !== audioChannels || audioBytes > 48_000 * 2 * 300) continue
        const b = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
        frames.push(Buffer.from(b)); audioBytes += b.length
        for (let at = 0; at < frame.data.length; at += 4) audioPeak = Math.max(audioPeak, Math.abs(frame.data[at]!))
      }
    })().catch(error => log('audio observer ended: ' + String(error)))
  })
  await room.connect(ticket.url, ticket.token, { autoSubscribe: true, dynacast: true })
  const readySource = await verifyS4SourceProof(repo, sourceProof.expectedFixedSHA, sourceProof.proofRoot, process.env.PHONE_ACCEPTANCE_WORKER_DIR)
  await verifyS4InstalledBundle(readySource, home)
  await save('source-at-ready.json', { ...readySource, installedVerified: true })
  evidence.source = readySource.currentGitSHA
  await save('prepared.json', { ready: true, realUnderstandingUsed: 0, canonical: 'com.anthropic.claudefordesktop', newConversationCreated: false })
  log('S4_READY: normal provider/worker/male WAV/cache/guarded Swift/real room; waiting local once permit')
  const permitEnd = Date.now() + 600_000
  while (!existsSync(join(root, 'allow-s4-once')) && Date.now() < permitEnd) await sleep(500)
  if (!existsSync(join(root, 'allow-s4-once'))) throw new Error('bounded readiness permit expired; no s4 sent')
  const permittedSource = await verifyS4SourceProof(repo, sourceProof.expectedFixedSHA, sourceProof.proofRoot, process.env.PHONE_ACCEPTANCE_WORKER_DIR)
  await verifyS4InstalledBundle(permittedSource, home)
  await save('source-before-permit-consumption.json', { ...permittedSource, installedVerified: true })
  evidence.source = permittedSource.currentGitSHA
  const before = await readState(i.base)
  await save('state-before.json', before)
  evidence.understandingSent = true; await save('acceptance-progress.json', evidence)
  const result = await sayToTextTurn(i.textTurn!.port, i.textTurn!.token, s4.turns[0]!)
  await save('phone-text-result.json', result)
  await sleep(2000)
  const after = await readState(i.base)
  await save('state-after.json', after)
  const afterVoice = (await req('/butler/proxy/api/voices')).current
  await save('voice-after.json', afterVoice)
  const difference = diffState(before, after)
  const observation = { sentence: s4.id, entrance: 'call' as const, turns: [{ said: s4.turns[0]!, reply: result.said.join(''), tools: result.tools, ms: result.ms, approvalsAdded: difference.asksAdded }], newCards: difference.newTasks.map(cardFactOf), voice: { before: beforeVoice.gender === '男' ? 'male' : 'female', after: afterVoice.gender === '女' ? 'female' : 'male' } }
  await save('original-judge.json', { observation, verdict: judge(s4, observation) })
  // Only read this freshly sent marker. The product's own watcher uses the same original helper bridge.
  const sent = packets.find((p: any) => p.request?.op === 'send_text') as any
  if (sent) {
    const marker = sent.request.text.slice(1, sent.request.text.indexOf('】'))
    const replyEnd = Date.now() + 90_000
    let read: any
    while (Date.now() < replyEnd) {
      read = await bridge.handle({ op: 'read_reply', bundle_id: sent.request.bundle_id, index: 0, marker })
      const texts = read?.result?.texts ?? []
      if (read?.result?.found && read.result.busy === false && texts.slice(1).some((text: string) => text.trim() === 'QA_S4_CLAUDE_RECEIPT')) { evidence.realWindowReceipt = true; break }
      await sleep(2500)
    }
    await save('final-marker-reply.json', read)
  }
  evidence.originalJudge = judge(s4, observation)
  evidence.newCards = difference.newTasks.map(cardFactOf)
  evidence.voice = { before: beforeVoice, after: afterVoice }
  await save('helper-packets.json', packets)
  await save('state-final.json', await readState(i.base))
  exit = evidence.realWindowReceipt === true && evidence.submitted === true && (evidence.originalJudge as { status: string }).status === 'pass' ? 0 : 1
} catch (error) {
  evidence.failure = String(error); log('S4_ACCEPTANCE_FAILED ' + String(error))
} finally {
  if (!preparationStarted) {
    console.error('S4 preflight denied; existing QA evidence and services were not changed')
  } else {
  await save('helper-packets.json', packets)
  await save('acceptance-result.json', { ...evidence, exit, audioBytes, audioRate, audioChannels, audioPeak })
  if (audioBytes) {
    const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(36 + audioBytes, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(audioChannels, 22); h.writeUInt32LE(audioRate, 24); h.writeUInt32LE(audioRate * audioChannels * 2, 28); h.writeUInt16LE(audioChannels * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(audioBytes, 40)
    await writeFile(join(root, 'actual-room-audio.wav'), Buffer.concat([h, ...frames]))
  }
  if (instance?.textTurn) await hangupTextTurn(instance.textTurn.port, instance.textTurn.token)
  await room?.disconnect(); socket?.close()
  for (const name of ['channel-worker-relay.log', 'channel-worker.log']) await copyFile(join(home, '.dsh/workbench/logs', name), join(root, name)).catch(() => {})
  if (instance) await instance.stop(); else if (preparationStarted && existsSync(join(root, 'iso'))) await stopRoot(root, log)
  await save('actual-exit.json', { exit, isoRemoved: !existsSync(join(root, 'iso')), personalAppStopped: false, qaConversationDeleted: false })
  }
}
process.exit(exit)
