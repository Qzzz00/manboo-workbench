/** Safe projections and source hooks for the isolated s3/s7 fixture probe. Never imported by production. */
type Obj = Record<string, unknown>
const obj = (value: unknown): Obj => value !== null && typeof value === 'object' ? value as Obj : {}
const pick = (value: unknown, keys: string[]): Obj => Object.fromEntries(keys.flatMap<[string, unknown]>(key => {
  const v = obj(value)[key]
  return typeof v === 'string' ? [[key, v.slice(0, 1000)]] : typeof v === 'number' || typeof v === 'boolean' ? [[key, v]] : []
}))

export function projectCapture(kind: string, raw: unknown): Obj {
  const value = obj(raw)
  if (kind === 'say_request') {
    const ctx = pick(value.ctx, ['last_say_id', 'in_call'])
    const confirmed = pick(obj(value.ctx).confirmed, ['ask_id', 'choice'])
    if (Object.keys(confirmed).length) ctx.confirmed = confirmed
    return { ...pick(value, ['client_key', 'text', 'entrance']), ctx }
  }
  if (kind === 'say_response') return {
    ...pick(value, ['client_key', 'status', 'say_id', 'code']),
    items: Array.isArray(value.items) ? value.items.map(item => pick(item, ['id', 'card_id', 'title', 'kind', 'status'])) : [],
    decided: Array.isArray(value.decided) ? value.decided.map(item => pick(item, ['item_index', 'card_id', 'kind', 'action'])) : [],
    asks: Array.isArray(value.asks) ? value.asks.map(item => pick(item, ['ask_id', 'question'])) : [],
    ask: pick(value.ask, ['ask_id', 'question']), say: pick(value.say, ['screen', 'spoken']),
  }
  if (kind === 'asr_frame') return {
    ...pick(value.result, ['text']),
    utterances: Array.isArray(obj(value.result).utterances)
      ? (obj(value.result).utterances as unknown[]).map(item => pick(item, ['text', 'definite', 'start_time', 'end_time'])) : [],
  }
  if (kind === 'asr_request') return { audio: pick(value.audio, ['format', 'rate', 'bits', 'channel']),
    request: pick(value.request, ['model_name', 'enable_itn', 'enable_punc', 'result_type', 'end_window_size']),
    corpus_present: obj(value.request).corpus !== undefined }
  if (kind === 'asr_kind') return pick(value, ['kind'])
  if (kind === 'final') return pick(value, ['text', 'generation'])
  if (kind === 'say_link') return pick(value, ['client_key', 'generation'])
  return {}
}

function replaceOne(source: string, needle: string, replacement: string): string {
  if (source.split(needle).length !== 2) throw new Error('phone capture source boundary drift')
  return source.replace(needle, replacement)
}
export function instrumentSource(path: string, source: string): string {
  const emit = 'globalThis.__phoneCapture'
  if (path.endsWith('/channel-worker/src/agent.ts')) {
    source = replaceOne(source, 'if (asr.note !== undefined)', `${emit}('asr_kind', { kind: asr.kind });\n    if (asr.note !== undefined)`)
    const finalStart = '    function hearFinalText(transcript: string, options: { typed?: boolean } = {}): void {\n      sayGeneration += 1'
    source = replaceOne(source, finalStart, `${finalStart}; ${emit}('final', { text: transcript, generation: sayGeneration })`)
    source = replaceOne(source, 'const pending = deps.workbench.sayTurn(sayInput, { signal: controller.signal })', `${emit}('say_link', { client_key: sayInput.clientKey, generation: sayGeneration });\n        const pending = deps.workbench.sayTurn(sayInput, { signal: controller.signal })`)
  }
  if (path.endsWith('/channel-worker/src/asr/volcProtocol.ts')) source = replaceOne(source,
    '  return buildFrame({\n    messageType: MSG_FULL_CLIENT,', `  ${emit}('asr_request', request);\n  return buildFrame({\n    messageType: MSG_FULL_CLIENT,`)
  if (path.endsWith('/channel-worker/src/asr/volcSession.ts')) source = replaceOne(source,
    'const definite = definiteTranscriptOf(frame)', `const definite = definiteTranscriptOf(frame); if (definite !== undefined) ${emit}('asr_frame', frame.json)`)
  return source
}
