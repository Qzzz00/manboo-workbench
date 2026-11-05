/**
 * 引导落地:**让模型把他的原话理成卡片**(2026-09-24 晚,卡 feat/onboarding-materialize)。
 *
 * 规则表(materialize.ts `rulesExtract`)认得的是维护者那一通电话里的说法;别的用户、别的说法要靠模型认。
 * 这里只管「问一次、拿回一份严格 JSON」:
 *   - **同一套模型配置**:地址与钥匙走 `modelService.endpoint()`(中转或他自己的 Key,与事务官同一处来源),
 *     模型名用 `deepseek-chat`(不想的那一档,见 {@link DEFAULT_EXTRACT_MODEL});
 *   - **严格 JSON**:`response_format: json_object` + 我们自己再校验一遍(形状不对整份不要,见 `parseModelExtraction`);
 *     上游不认 `response_format`(400)就去掉它再问一次;
 *   - **有上限**:默认 25 秒,超时 / 连不上 / 回的不是 JSON —— 回 `{ ok:false, why }`,调用方照规则表那一份走(确定性兜底)。
 *
 * 纯 I/O 边界:地址、模型、fetch 都是注入的,用例不碰网络。
 */
import type { MaterializeArchive } from './materialize.ts'
import { archiveClauses, parseModelExtraction } from './materialize.ts'

export interface ExtractEndpoint {
  ready: boolean
  /** 已经带 `/v1` 的那一截(modelService.endpoint() 回的就是这样)。 */
  baseUrl: string
  key?: string
}

export interface ExtractDeps {
  endpoint: () => Promise<ExtractEndpoint>
  /** 指定模型名(测试 / 以后要换时用)。缺席 / 回 undefined = {@link DEFAULT_EXTRACT_MODEL}。 */
  model?: () => Promise<string | undefined> | string | undefined
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export const EXTRACT_TIMEOUT_MS = 30_000
/**
 * 用哪个模型名。
 *
 * 2026-09-24 晚 scratch 真跑:`deepseek-v4-flash` **会先想一遍** —— 这一问它想了 5000 多 token、58 秒,
 * 6000 token 上限还是截断,2400 上限时正文是空的;于是当时改用 `deepseek-chat`(走不想的那一档,
 * 12 秒、1500 token、一份完整的 JSON)。
 *
 * **2026-09-28(卡 BS)改回 `deepseek-v4-flash`,但这一次自己把思考关掉**(`thinking: { type: 'disabled' }`,
 * 见下面那段 fetch)。原因:中转记账对认不出的名字一律按 Pro 价算(`relay/server/pricing.cjs` priceTierOf),
 * 而 `deepseek-chat` 转给上游的本来就是 Flash —— 等于按 3–4 倍的价记一样的活。
 * 当年那个「想太久、正文截断」的毛病正是思考没关,关掉之后两个毛病一起没了。
 *
 * 地址与钥匙仍是事务官那一套(modelService.endpoint())。
 */
export const DEFAULT_EXTRACT_MODEL = 'deepseek-v4-flash'

/** 问模型的那两段话。**只给他说过的**(已经记进存档的答案),不给仓库内容、不给别的项目。 */
export function buildExtractPrompt(archive: MaterializeArchive, today: string): { system: string, user: string } {
  const { project, clauses } = archiveClauses(archive)
  const said = (from: string): string[] => clauses.filter(one => one.from === from).map(one => one.text)
  const lines: string[] = [`今天是 ${today}。下面是用户在引导访谈里亲口说的话(已经按字段记好),把它理成看板卡片。`, '']
  if (project !== undefined) {
    lines.push(`【项目 ${project.name}】`)
    if (project.one_liner !== undefined) lines.push(`- 一句话:${project.one_liner}`)
    if (project.status !== undefined) lines.push(`- 现在到哪:${project.status}`)
    if (project.details !== undefined) lines.push(`- 细节:${project.details}`)
    if (project.vision !== undefined) lines.push(`- 做成什么样:${project.vision}`)
    if (project.next_step !== undefined) lines.push(`- 下一步:${project.next_step}`)
    if (project.deadline !== undefined) lines.push(`- 截止:${project.deadline}`)
    for (const item of project.unsure ?? []) lines.push(`- 拿不准:${item}`)
    lines.push('')
  }
  const other = said('habits.other')
  if (other.length > 0) lines.push(`【其它(工作习惯、别的项目)】${other.join(';')}`, '')
  lines.push(
    '要求:',
    '1. 只从上面的原话里出卡,不编;标题用他的说法,不超过 16 个字。一件事只出一张(同一件事在几处都说了,合成一张)。',
    '2. 他说不做、没必要的,不出卡;只是背景(假期、行程、截止日本身)不出卡,写进 background。',
    '3. 「按交接推进」「交接里的三件」这类照搬旧清单的,不出卡。',
    '4. owner 只能是 codex / claude / kimi / butler(事务官)/ me(他自己)/ colleague(同事)/ other(别人)。他说谁在做就是谁;写代码的活默认 claude;他说的分工优先。',
    '5. status:已经有人在做 = doing;他说「下去再确认」「待确认」= confirm;其余 todo。',
    '6. due 只写原话里能确定的日子(YYYY-MM-DD);冲刺的截止日写进 sprint,不用每张都写。',
    '7. 他说「不阻塞」「不算阻塞」的写 blocking:false;「最重要」「核心」「最高优先」的写 priority:"high"。',
    '8. first 一律写 false(第一件由工作台对他点头的那句话来认)。',
    '9. quote:这张卡出自他哪句原话,原样摘,不超过 40 字。',
    '10. 他顺口提到的另一个项目写进 projects(name、repo 仓库名、owner、note)。keywords:每个项目 2 到 5 个资讯关注词,只用他话里出现过的说法。',
    '',
    '只回这一个 JSON 对象,不要任何别的文字:',
    '{"sprint":{"name":"<比赛名> 参赛 · MM-DD","deadline":"YYYY-MM-DD"},'
    + '"cards":[{"title":"","owner":"claude","owner_note":"","status":"todo","due":null,"priority":"mid","blocking":true,"group":"","note":"","quote":"","first":false}],'
    + '"projects":[{"name":"","repo":"","owner":"","note":""}],'
    + '"background":"",'
    + '"keywords":{"<项目名>":[""]}}',
  )
  return {
    system: '你把一次引导访谈里用户亲口说的话,整理成看板卡片。只回一个 JSON 对象,不要任何别的文字,不要代码块。',
    user: lines.join('\n'),
  }
}

/** 模型回的正文 → JSON(容忍 ```json 围栏与前后多出来的一两句)。 */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try { return JSON.parse(trimmed) }
  catch { /* 往下挑第一个 { 到最后一个 } */ }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try { return JSON.parse(trimmed.slice(start, end + 1)) }
  catch { return undefined }
}

/** 问一次模型。**不抛**:任何失败都回 `{ ok:false, why }`(一句人话,进计划的 model_note)。 */
export async function extractWithModel(
  archive: MaterializeArchive,
  today: string,
  deps: ExtractDeps,
): Promise<{ ok: true, value: Exclude<ReturnType<typeof parseModelExtraction>, { ok: false }>['value'], model: string } | { ok: false, why: string }> {
  let endpoint: ExtractEndpoint
  try { endpoint = await deps.endpoint() }
  catch (error) { return { ok: false, why: `模型服务查不到(${error instanceof Error ? error.message : String(error)})` } }
  if (!endpoint.ready) return { ok: false, why: '模型服务还没接上' }
  let model = DEFAULT_EXTRACT_MODEL
  try {
    // own 档他自己填的模型名照用(2026-10-23,卡「事务官换Key」)——不一定是 deepseek 开头;
    // 地址与钥匙已经是他自己那一家的,模型名还挑 deepseek 前缀就是接不上。
    const picked = await deps.model?.()
    if (typeof picked === 'string' && picked.trim() !== '') model = picked.trim()
  }
  catch { /* 用默认那个 */ }
  const prompt = buildExtractPrompt(archive, today)
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? EXTRACT_TIMEOUT_MS
  const ask = async (strictJson: boolean): Promise<{ status: number, text?: string, why?: string }> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    try {
      const response = await fetchImpl(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(endpoint.key === undefined ? {} : { authorization: `Bearer ${endpoint.key}` }) },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
          temperature: 0.2,
          max_tokens: 4000,
          // 不用想(2026-09-28 卡 BS):理成一份 JSON 是照材料填表,想反而会把 4000 个 token 花在想上、正文截断。
          thinking: { type: 'disabled' },
          ...(strictJson ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      })
      if (!response.ok) return { status: response.status, why: `模型服务回了 ${response.status}` }
      const body = await response.json() as { choices?: { message?: { content?: unknown } }[] }
      const content = body.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.trim() === '') return { status: 200, why: '模型没回内容' }
      return { status: 200, text: content }
    }
    catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return { status: 0, why: aborted ? `模型超时(${Math.round(timeoutMs / 1000)} 秒)` : `连不上模型服务(${error instanceof Error ? error.message.split('\n')[0] : String(error)})` }
    }
    finally { clearTimeout(timer) }
  }
  let reply = await ask(true)
  // 上游不认 response_format:去掉它再问一次(我们自己也会校验 JSON)。
  if (reply.status === 400) reply = await ask(false)
  if (reply.text === undefined) return { ok: false, why: reply.why ?? '模型没回内容' }
  const json = parseJsonReply(reply.text)
  if (json === undefined) return { ok: false, why: '模型回的不是 JSON' }
  const parsed = parseModelExtraction(json, today)
  if (!parsed.ok) return { ok: false, why: `模型回的卡片不合格:${parsed.why}` }
  return { ok: true, value: parsed.value, model }
}
