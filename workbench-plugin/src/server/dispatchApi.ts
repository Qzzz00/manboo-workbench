/**
 * 派活的第二只手:**经中转把这件事发给 GPT / 豆包**(2026-09-22)。
 *
 * 三只手同一条链路、同一份记录、同一块小标,只是"送话"的方式不同
 * (`DispatchHand`:`cli` 命令行 / `window` 客户端窗口 / `api` 接口):
 *
 * | 手 | 谁 | 在哪 |
 * |---|---|---|
 * | `cli` | Codex(Claude 探得到但按 A3 不用) | `server/agentDispatch.ts` |
 * | `window` | Claude / Codex / Kimi | `server/dispatchClient.ts` |
 * | `api` | **GPT / 豆包** | 这个文件 |
 *
 * ## 为什么这两家只有接口这一只手
 *
 * Ben 的原话(决策记录 2026-09-21「运营白板三件」第 2 条):「产品研发场景怎么派活,
 * 这个场景就怎么派活,不是通用的吗。」链路通用,手不同 ——
 *
 * - **GPT**:ChatGPT 桌面版与 Codex 是**同一个 app**(`com.openai.codex`),
 *   窗口那只手已经归 Codex 了。两家抢同一扇窗会互相盖掉对方的话。
 * - **豆包**:没有命令行;窗口那条实测送不进去 —— 辅助功能树只有 10 个节点,
 *   找不到能写字的输入框(`docs/交接-0921-送话进客户端窗口.md`,豆包 0/5)。
 *
 * ## Key 在服务器上,不在这台机器上
 *
 * 用户手里是订阅,不是 API Key(Ben 纠正派活定义时说的那一句)。所以这条路
 * **不碰任何上游凭据**:请求发到中转(`relay/`),中转按模型名前缀挑上游、用服务器上的 Key 转出去、
 * 按家记账。这个文件里唯一的凭据是**中转令牌**,而它本来就是工作台自己那一份
 * (`modelService.endpoint()`),不新存一份、不进日志、不进任何回包。
 *
 * ## 这只手做得到什么、做不到什么(小标上要说得出来)
 *
 * **做得到**:把事项的原话 + 项目上下文摘要发过去,把回答原样记到卡上。
 * **做不到**:它**不碰文件**。命令行那只手会真在仓库里改东西,接口这只手只会回一段字 ——
 * 所以运营白板上分给它们的活正是"写文本 / 分析 / 润色"这一类。
 * 这件事在提示词里对模型明说一次(它不该回"我已经改好了 X 文件"),
 * 也在交接与技能正文里对 Ben 明说一次。
 */
import type { AgentDispatchFamily, TaskDispatch } from '../protocol.ts'
import { dispatchFamilyTitle } from '../protocol.ts'

/** 走接口那只手的两家。**顺序固定**(界面、技能正文、用例都按它排)。 */
export const API_DISPATCH_FAMILIES = ['gpt', 'doubao'] as const
export type ApiDispatchFamily = typeof API_DISPATCH_FAMILIES[number]

export function isApiDispatchFamily(value: unknown): value is ApiDispatchFamily {
  return typeof value === 'string' && (API_DISPATCH_FAMILIES as readonly string[]).includes(value)
}

/**
 * 默认发哪个模型。**名字的前缀就是中转分家的判据**(`gpt-*` → OpenAI、`doubao-*` → 火山方舟,
 * 见 relay/server/providers.cjs),所以这两个值改成同前缀的别的型号都不会改变去哪一家。
 *
 * 为什么写死在代码里而不是让用户填:这一版用户那一侧**没有任何要填的东西** ——
 * 服务器上配了什么由 Ben 定(部署变量在交接里),桌面这边只挑一个前缀对的默认值。
 * 调用方明着传 `model` 时以它为准(界面上以后要做"换个型号"的话,接口已经在这儿了)。
 */
export const API_DISPATCH_MODELS: Readonly<Record<ApiDispatchFamily, string>> = {
  gpt: 'gpt-4o',
  doubao: 'doubao-pro-32k',
}

/**
 * 运营白板上那张分工表(`docs/调研/自媒体工作台-运营同事需求白板-2026-09-21.md` 第二节)。
 *
 * 原话:「GPT 负责文本与图片生成(55%)、Claude 负责分析既有文本与数据(35%)、
 * 豆包负责转成更合适的中文表达(10%)」。这几句会进提示词的第一段 ——
 * 让它知道自己是被当成哪一手请来的,回答的形状才对得上。
 *
 * **只写走接口那两家**:Claude 那一份在窗口那只手上,不在这里重写一遍。
 */
export const API_DISPATCH_ROLES: Readonly<Record<ApiDispatchFamily, string>> = {
  gpt: '写文本、出创意、做图片的文案与提示词',
  doubao: '把已有的中文改得更地道、更像人话(润色,不改事实、不加料)',
}

/** 这件事所在项目的上下文摘要。**都可缺席** —— 没挂项目就不编一个出来(D13)。 */
export interface ApiDispatchContext {
  /** 项目名(卡上那个)。 */
  project?: string
  /** 项目目录。记在 `TaskDispatch.cwd` 上,也进提示词("这件事是围绕哪个仓库说的")。 */
  cwd?: string
  /** 一句话的项目说明(README 第一行、或者卡上的备注)。 */
  note?: string
}

/**
 * 发过去的那两段话。**分成 system / user 两条**,不是拼成一大段:
 * 角色与边界(不碰文件、说中文、不编)属于 system,他那句原话属于 user ——
 * 混在一起时模型分不清哪一句是"要求"哪一句是"任务",尤其在润色这种
 * "把下面这段改一改"的活上,边界那几句会被当成待润色的正文一起改了。
 */
export interface DispatchPrompt {
  system: string
  user: string
}

/**
 * 拼提示词。**纯函数**,一行 I/O 都没有 —— 用例直接对着字符串断言。
 *
 * 三条写进 system 的硬边界,每一条都对应一种会骗人的回答:
 * 1. **你改不了文件** → 否则它会回"我已经把 X 改好了",而卡上"完成"那两个字会让人真去信;
 * 2. **不知道就说不知道** → 它拿不到仓库内容,只有这份摘要;
 * 3. **说中文** → 最终读这段话的是 Ben。
 */
export function buildDispatchPrompt(input: {
  family: ApiDispatchFamily
  text: string
  context?: ApiDispatchContext | undefined
}): DispatchPrompt {
  const who = dispatchFamilyTitle(input.family)
  const system = [
    `你是 ${who},通过一台桌面工作台被派来做一件事。你在这次协作里负责的是:${API_DISPATCH_ROLES[input.family]}。`,
    '三条边界,请严格遵守:',
    '1. 你**没有**这台电脑的文件访问权,改不了任何文件、跑不了任何命令。只要回文字。不要说"我已经改好了/已创建文件"这类话。',
    '2. 你看到的项目信息只有下面这一小段摘要。摘要里没有的事实,直说"这段材料里没有",不要推测、不要编。',
    '3. 用中文回答。先给结论,再给要点;不要客套开场白。',
  ].join('\n')

  const context = input.context ?? {}
  const lines: string[] = []
  if (context.project !== undefined && context.project !== '') lines.push(`项目:${context.project}`)
  if (context.cwd !== undefined && context.cwd !== '') lines.push(`项目目录:${context.cwd}`)
  if (context.note !== undefined && context.note !== '') lines.push(`项目说明:${context.note}`)

  const user = lines.length === 0
    // 没挂项目就**明说"没有项目上下文"**,而不是悄悄少一段:模型看不到上下文时
    // 会自己脑补一个,明写一句反而让它老实问回来。
    ? `要做的事:\n${input.text.trim()}\n\n(这件事没挂在任何项目上,没有额外的项目上下文。)`
    : `项目上下文:\n${lines.join('\n')}\n\n要做的事:\n${input.text.trim()}`

  return { system, user }
}

/** 失败归到哪一类。**归不出类就 `other`,并把原话原样带走**(同窗口那只手的纪律)。 */
export type ApiFailureKind = 'not_relay' | 'no_token' | 'not_configured' | 'quota' | 'unreachable' | 'upstream_error' | 'empty' | 'other'

/** 给人看的那一句(收件箱里问「要我自己来吗」时用它开头)。 */
export const API_FAILURE_HINTS: Readonly<Record<ApiFailureKind, string>> = {
  not_relay: '现在用的是你自己的 DeepSeek Key,直连官方发不出这一家',
  no_token: '这台设备还没领到模型服务的凭证',
  not_configured: '服务器上还没配这一家的账号',
  quota: '今天的模型额度用完了',
  unreachable: '连不上模型服务',
  upstream_error: '那一家回了一个错',
  empty: '那一家回了一段空的',
  other: '没发成',
}

/**
 * 中转回的错误 → 归类。中转那边的错误是 OpenAI 形状(`{ error: { message, code } }`),
 * 而且 message 本来就是**中文人话**(它是写给不懂代码的人看的),所以这里只归类、不改写原话。
 */
export function classifyApiFailure(status: number, code?: string): ApiFailureKind {
  if (code === 'openai_not_configured' || code === 'doubao_not_configured' || code === 'upstream_not_configured') return 'not_configured'
  if (code === 'daily_quota_exceeded' || status === 429) return 'quota'
  if (code === 'invalid_relay_token' || status === 401) return 'no_token'
  if (status === 502 || status === 503 || status === 504) return 'unreachable'
  if (status >= 400) return 'upstream_error'
  return 'other'
}

/** 中转那一头怎么发得出去。注进来的就是 `modelService.endpoint()` 那一份。 */
export interface ApiDispatchEndpoint {
  mode: 'relay' | 'own'
  /** 已经带 `/v1`。 */
  baseUrl: string
  key?: string
  ready: boolean
}

export interface ApiDispatchDeps {
  endpoint: () => Promise<ApiDispatchEndpoint>
  fetchImpl?: typeof fetch
  now: () => Date
  /** 一次问答等多久。缺省 3 分钟 —— 长文润色与写稿子都可能跑很久。 */
  timeoutMs?: number
}

export interface ApiDispatchInput {
  family: ApiDispatchFamily
  text: string
  context?: ApiDispatchContext | undefined
  /** 明着指定型号(缺省见 `API_DISPATCH_MODELS`)。 */
  model?: string | undefined
}

export interface ApiDispatchResult {
  ok: boolean
  /** 记到卡上的那一条(成败都有:**不假装成功**,失败也要看得见原因)。 */
  dispatch: TaskDispatch
  /** 它回的那段话(成了才有)。 */
  reply?: string
  reason?: string
  kind?: ApiFailureKind
  /** 这一次花了多少 token(中转回的 usage;没有就缺席,不估)。 */
  tokens?: number
}

export interface ApiDispatch {
  send: (input: ApiDispatchInput) => Promise<ApiDispatchResult>
}

/** 一次问答等多久。 */
export const API_DISPATCH_TIMEOUT_MS = 180_000

/** 回答最多记多长。**只截记在卡上的那一份**,原文在回包里照旧全给调用方。 */
export const API_REPLY_NOTE_MAX = 400

/**
 * 卡上那句 `note`:成了记回答的开头,没成记失败原话。
 * 截断时**明说截断了**(`…(还有 N 字)`)—— 一段被悄悄切掉一半的回答比没有更坏。
 */
export function replyNote(reply: string, max = API_REPLY_NOTE_MAX): string {
  const text = reply.trim().replace(/\s+/g, ' ')
  if (text.length <= max) return text
  return `${text.slice(0, max)}…(还有 ${text.length - max} 字,全文在这条事项的会话里)`
}

export function createApiDispatch(deps: ApiDispatchDeps): ApiDispatch {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? API_DISPATCH_TIMEOUT_MS

  async function send(input: ApiDispatchInput): Promise<ApiDispatchResult> {
    const at = deps.now().toISOString()
    const cwd = input.context?.cwd
    const base = (status: TaskDispatch['status'], note?: string): TaskDispatch => ({
      family: input.family,
      status,
      hand: 'api',
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
      started_at: at,
      ...(status === 'running' ? {} : { ended_at: deps.now().toISOString() }),
      ...(note === undefined ? {} : { note }),
    })
    const fail = (kind: ApiFailureKind, reason: string): ApiDispatchResult => ({
      ok: false, kind, reason, dispatch: base('failed', reason),
    })

    if (input.text.trim() === '') return fail('other', '这件事的正文是空的,没发出去')

    const endpoint = await deps.endpoint()
    /**
     * ★ **只有走中转才发得出去**。「用自己的 Key」那个模式直连的是 DeepSeek 官方,
     * 把 `gpt-4o` 发过去只会换回一句"没这个模型" —— 那会挂在卡上,看起来像是 GPT 坏了。
     * 所以在这儿就如实拦下,并把下一步说清楚(去设置里换回「工作台提供的模型服务」)。
     */
    if (endpoint.mode !== 'relay') {
      return fail(
        'not_relay',
        `派给 ${dispatchFamilyTitle(input.family)} 要走工作台提供的模型服务;`
        + '你现在用的是自己的 DeepSeek Key(直连官方,发不出这一家)。在「设置 → 模型」里换回来就行。',
      )
    }
    if (!endpoint.ready || endpoint.key === undefined) {
      return fail('no_token', '这台设备还没领到模型服务的凭证,先在「设置 → 模型」里领一次。')
    }

    const model = input.model ?? API_DISPATCH_MODELS[input.family]
    const prompt = buildDispatchPrompt({ family: input.family, text: input.text, context: input.context })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        }),
        signal: controller.signal,
      })
    }
    catch (error) {
      // 连不上 / 超时。**不把 error.message 原样往上抛**:它可能带着 URL 与请求细节
      // (同中转那边 upstream_unreachable 的理由)。超时与连不上分开说,因为下一步不一样。
      const aborted = (error as { name?: string }).name === 'AbortError'
      return fail('unreachable', aborted
        ? `等了 ${Math.round(timeoutMs / 1000)} 秒还没回,这次先算没做成。`
        : '连不上模型服务,这次没发出去。')
    }
    finally {
      clearTimeout(timer)
    }

    let body: Record<string, unknown> | undefined
    try { body = await response.json() as Record<string, unknown> }
    catch { body = undefined }

    if (!response.ok) {
      const error = (body?.error ?? {}) as Record<string, unknown>
      const code = typeof error.code === 'string' ? error.code : undefined
      // 中转那边的 message 已经是中文人话,**原样用**——它比我们在这里重编一句准。
      const message = typeof error.message === 'string' && error.message.trim() !== ''
        ? error.message.trim()
        : `模型服务回了 ${response.status},没说为什么。`
      return fail(classifyApiFailure(response.status, code), message)
    }

    const choices = Array.isArray(body?.choices) ? body.choices as Record<string, unknown>[] : []
    const message = (choices[0]?.message ?? {}) as Record<string, unknown>
    const reply = typeof message.content === 'string' ? message.content : ''
    if (reply.trim() === '') {
      return fail('empty', `${dispatchFamilyTitle(input.family)} 回了一段空的,这次没做成。`)
    }

    const usage = (body?.usage ?? {}) as Record<string, unknown>
    const tokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined
    return {
      ok: true,
      reply,
      ...(tokens === undefined ? {} : { tokens }),
      dispatch: base('done', replyNote(reply)),
    }
  }

  return { send }
}

/** 这个值是不是走接口那只手能派的家(HTTP 入口用它把关)。 */
export function apiDispatchFamilyOf(value: unknown): ApiDispatchFamily | undefined {
  return isApiDispatchFamily(value) ? value : undefined
}

/** 派活小标要用的:这一家的名字(协议层那张表,不在这里写第二份)。 */
export function apiFamilyTitle(family: AgentDispatchFamily): string {
  return dispatchFamilyTitle(family)
}
