/**
 * **模型把工具调用写成一段文字吐了出来**(2026-09-30 Air 真机,维护者:「事务官口头说已指派,却没有实际创建任务」)。
 *
 * 通话纪要里事务官念出了这一串:
 *
 *     <｜｜DSML｜｜ calls>
 *     <｜｜DSML｜｜ invoke name="wb_…">
 *     <｜｜DSML｜｜ parameter name="text" string="true">…</｜｜DSML｜｜ parameter>
 *     <｜｜DSML｜｜ parameter name="confirmed" string="false">true</｜｜DSML｜｜ parameter>
 *     </｜｜DSML｜｜ invoke>
 *     </｜｜DSML｜｜ calls>
 *
 * DeepSeek 偶尔不走结构化的 tool_calls,把调用按它自己的标记写进正文。工人照念、工具一次没调 ——
 * 嘴上「都对我就派」,看板上什么都没有。修在流上(与 stutter.ts 同一处):
 * 认出这段 → **一个字都不念** → 流末尾补一块带 `toolCalls` 的 chunk,框架照常去调那件工具。
 *
 * 认法宽一点:竖线全角半角、一根两根都认(`<｜｜DSML｜｜`、`<|DSML|`)。
 * `string="true"` 的参数原样当字符串;其余按 JSON 解析(`true` / `3`),解析不了就当字符串。
 */
import { llm } from '@livekit/agents'

/** 一段 DSML 标记的开头(全角 / 半角竖线,一根或两根)。 */
const OPEN = /<\/?[｜|]{1,2}DSML[｜|]{1,2}/
const INVOKE = /<[｜|]{1,2}DSML[｜|]{1,2}\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[｜|]{1,2}DSML[｜|]{1,2}\s*invoke\s*>/g
const PARAM = /<[｜|]{1,2}DSML[｜|]{1,2}\s*parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/[｜|]{1,2}DSML[｜|]{1,2}\s*parameter\s*>/g

export interface DsmlCall { name: string, args: Record<string, unknown> }

/** 一段正文 → 该念的那部分 + 里面写着的调用。没有 DSML 就原样、没有调用。 */
export function parseDsmlCalls(text: string): { spoken: string, calls: DsmlCall[] } {
  const at = text.search(OPEN)
  if (at < 0) return { spoken: text, calls: [] }
  const calls: DsmlCall[] = []
  for (const invoke of text.matchAll(INVOKE)) {
    const args: Record<string, unknown> = {}
    for (const param of (invoke[2] ?? '').matchAll(PARAM)) {
      const name = param[1] as string
      const raw = param[3] ?? ''
      if (param[2] === 'true') { args[name] = raw; continue }
      try { args[name] = JSON.parse(raw.trim()) }
      catch { args[name] = raw }
    }
    calls.push({ name: invoke[1] as string, args })
  }
  return { spoken: text.slice(0, at), calls }
}

/** 这一段末尾是不是一个**可能**要长成 DSML 开头的半截(「<」「<｜」「<｜｜DS」……),先压着看下一块。 */
function pendingPrefix(text: string): number {
  const probe = '<｜｜DSML｜｜'
  const probe2 = '<|DSML|'
  for (let n = Math.min(text.length, probe.length); n > 0; n -= 1) {
    const tail = text.slice(-n)
    if (probe.startsWith(tail) || probe2.startsWith(tail) || /^<\/?[｜|]{0,2}D?S?M?L?$/.test(tail)) return n
  }
  return 0
}

let seq = 0

/**
 * 包 `llmNode` 的输出(字符串或 ChatChunk)。没有 DSML 时一字不改地放行
 * (只在块尾压住一个可能是开头的「<」,下一块来了就放);一旦认出 DSML,**从那儿起一个字都不放**,
 * 流末尾把里面的调用变成一块 `delta.toolCalls` 交给框架。
 */
export function withDsmlToolCalls<T>(base: ReadableStream<T>): ReadableStream<T> {
  let hold = ''
  let captured: string | undefined
  let lastWasString = true
  const emitText = (controller: TransformStreamDefaultController<T>, text: string): void => {
    if (text === '') return
    controller.enqueue((lastWasString ? text : { id: `dsml-text-${seq}`, delta: { role: 'assistant', content: text } }) as T)
  }
  const take = (controller: TransformStreamDefaultController<T>, text: string): void => {
    if (captured !== undefined) { captured += text; return }
    const combined = hold + text
    hold = ''
    const at = combined.search(OPEN)
    if (at >= 0) {
      emitText(controller, combined.slice(0, at))
      captured = combined.slice(at)
      return
    }
    const keep = pendingPrefix(combined)
    emitText(controller, combined.slice(0, combined.length - keep))
    hold = combined.slice(combined.length - keep)
  }
  return base.pipeThrough(new TransformStream<T, T>({
    transform(chunk, controller) {
      if (typeof chunk === 'string') { lastWasString = true; take(controller, chunk); return }
      const delta = (chunk as { delta?: { content?: unknown } } | null)?.delta
      if (delta === undefined || typeof delta.content !== 'string' || delta.content === '') {
        controller.enqueue(chunk)
        return
      }
      lastWasString = false
      const rest = { ...(chunk as object), delta: { ...delta, content: '' } }
      take(controller, delta.content)
      // 同一块里要是还带着别的(结构化的 toolCalls),照样放。
      const tools = (delta as { toolCalls?: unknown[] }).toolCalls
      if (Array.isArray(tools) && tools.length > 0) controller.enqueue(rest as T)
    },
    flush(controller) {
      if (captured === undefined) { emitText(controller, hold); return }
      const { calls } = parseDsmlCalls(captured)
      if (calls.length === 0) return
      seq += 1
      const toolCalls = calls.map((call, i) => llm.FunctionCall.create({
        callId: `dsml_${seq}_${i}`,
        name: call.name,
        args: JSON.stringify(call.args),
      }))
      console.log(`[dsml] 模型把 ${calls.length} 次工具调用写进了正文(${calls.map(c => c.name).join('、')}):没念,照常去调`)
      controller.enqueue({ id: `dsml-${seq}`, delta: { role: 'assistant', toolCalls } } as T)
    },
  }))
}
