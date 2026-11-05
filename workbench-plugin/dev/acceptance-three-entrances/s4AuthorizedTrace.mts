/** Explicit isolated QA evidence observer + single-understanding budget, never a provider substitute. */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { loadSentences } from './judge.ts'
const root = process.env.PHONE_ACCEPTANCE_ROOT
if (!root || resolve(root) !== root || !process.env.WORKBENCH_S4_WINDOW_QA) throw new Error('explicit S4 isolation required')
const config = JSON.parse(process.env.WORKBENCH_S4_WINDOW_QA) as { root: string; home: string }
if (config.root !== root || config.home !== join(root, 'iso/home')) throw new Error('trace root mismatch')
const emit = (kind: string, data: Record<string, unknown>) => appendFileSync(join(root, 'live-trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, ...data }) + '\n', { mode: 0o600 })
const originalSpawn = cp.spawn
// Existing normal helper constructs its isolated env; only its own DSH/worker inherit this observer.
cp.spawn = ((command: string, args: string[], options: cp.SpawnOptions) => {
  if (options?.env?.HOME === config.home) options = { ...options, env: { ...options.env, PHONE_ACCEPTANCE_ROOT: root, WORKBENCH_S4_WINDOW_QA: process.env.WORKBENCH_S4_WINDOW_QA, NODE_OPTIONS: `--import=${import.meta.url}`, CLAUDE_CONFIG_DIR: join(config.home, '.claude-qa-unused') } }
  return originalSpawn(command, args, options)
}) as typeof cp.spawn
syncBuiltinESMExports()
const ports = JSON.parse(process.env.PHONE_ACCEPTANCE_PORTS ?? '{}') as { workbench?: number; butler?: number }
// Child env has production port fields rather than parent helper JSON.
const base = `http://127.0.0.1:${ports.workbench ?? process.env.WORKBENCH_PORT ?? 9693}`
const butler = `http://127.0.0.1:${ports.butler ?? 9692}`
const isolated = process.env.HOME === config.home
const original = globalThis.fetch
let cookie: string | undefined
const s4 = loadSentences().find(row => row.id === 's4')!.turns[0]!
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  let body: Record<string, unknown> | undefined
  try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined } catch { /* not JSON */ }
  const model = isolated && url.endsWith('/chat/completions')
  const say = isolated && url === base + '/butler/say'
  const voice = url.startsWith(butler + '/api/voices') || url.startsWith(base + '/butler/proxy/api/voices')
  const tts = isolated && url.startsWith(butler + '/api/tts')
  if (model) {
    const messages = body?.messages as { content?: string }[] | undefined
    if (!existsSync(join(root, 'allow-s4-once')) || !messages?.some(m => m.content?.includes(`她说:「${s4}」`))) { emit('blocked_model', { reason: 'not approved original one understanding' }); throw new Error('QA model budget denied') }
    try { writeFileSync(join(root, 'understanding.claim'), new Date().toISOString(), { flag: 'wx', mode: 0o600 }) }
    catch { emit('blocked_model', { reason: 'one understanding already claimed' }); throw new Error('QA one understanding exhausted') }
    emit('model_request', { model: body?.model, messages, max_tokens: body?.max_tokens })
  }
  if (say) emit('say_request', { text: body?.text, ctx: body?.ctx, entrance: body?.entrance })
  if (tts) emit('tts_request', { path: new URL(url).pathname, text: body?.text, scene: body?.scene })
  let next = init
  if (!isolated && url.startsWith(base) && cookie) { const headers = new Headers(init?.headers); headers.set('cookie', cookie); next = { ...init, headers } }
  const response = await original(input, next)
  if (!isolated && url.startsWith(base + '/account/')) { const value = response.headers.get('set-cookie'); if (value) cookie = value.split(';', 1)[0] }
  if (model || say || voice) {
    const raw = await response.clone().json().catch(() => ({})) as Record<string, any>
    if (model) emit('model_response', { status: response.status, model: raw.model, content: raw.choices?.[0]?.message?.content, finish_reason: raw.choices?.[0]?.finish_reason, usage: raw.usage })
    if (say) emit('say_response', { status: response.status, response: raw })
    if (voice) emit('voice_response', { path: new URL(url).pathname, status: response.status, current: raw.current, count: raw.voices?.length })
  }
  if (tts) emit('tts_response', { status: response.status, content_type: response.headers.get('content-type') })
  return response
}
