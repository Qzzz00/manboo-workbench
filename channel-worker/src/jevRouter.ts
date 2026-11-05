/**
 * Jev 分流:把「这一句是闲聊还是要办事」交给 TypeSafe AI 的云端决策模型
 * (2026-09-23,Ben:「我觉得这里是不是可以把 Jev 接进来啊」)。
 *
 * **这是第二实现,不是默认实现。** 默认是规则法(turnRoute.ts 的 `RulesTurnRouter`)。
 * 要用它:`WORKBENCH_CHANNEL_TURN_ROUTER=jev` + 环境变量里有 `JEV_API_KEY`。
 * 没有 key 的时候**这个文件一行都不会被加载**(turnRoute.ts 的 `createTurnRouter` 是动态 import)。
 *
 * ## 它是什么(docs/设计-事务官自进化闭环-2026-09-23.md 2.1/2.2,那一节是按官方文档与第三方实测盘的)
 *
 * 闭源云端模型,`POST https://api.typesafe.ai/v1/systemone`,当前 `jev-1.13.0`:
 * 非自回归,不生成 token,直接出一个**分布**。`choice` 型问题回 `probabilities` 与 `confidence`。
 * 定价 $0.042 / 百万输入 token,输出免费。
 *
 * ## 接它之前就知道的三件事(都写在这里,免得日后又去翻)
 *
 *   ① **confidence 不是正确率**,是分布的尖锐度(官方 `/confidence` 页原话:
 *      "Calibration does not mean that an individual prediction is guaranteed to be correct.")。
 *      所以这里**不拿它当放行权限用**:低于 {@link JEV_MIN_CONFIDENCE} 一律按 `act`
 *      —— 和规则法「拿不准按 act」同一条。
 *   ② **中文不是它的主场**(官方 `/models`:英语是主要训练语言,CJK "handled but not equally well"),
 *      而我们这里全是中文口语。所以问题写成**中文 + 选项带 other**(官方规矩:choice 必加 other),
 *      拿不准的 other 同样落到 `act`。
 *   ③ **它在等待路径上**。公开实测 P50 0.30–0.33 秒、国内 0.7–0.9 秒 —— 这一跳加在
 *      「他说完 → 她开口」中间。分流本来是为了省模型首字那 1.5~3 秒,
 *      要是判一次就花掉 0.8 秒,闲聊回合省下来的就所剩无几。**这正是要用离线对照去量的那件事**
 *      (channel-worker/scripts/eval-turn-router.mjs)。
 *
 * ## 凭据与数据出境
 *
 * key **只从环境变量读**,不落盘、不进日志、不进任何一次 `console.log`。
 * 但请求体里带的是**他在电话里说的那句话** —— 那句话会离开这台机器、发到第三方。
 * 这件事要 Ben 拍板,交接与决策记录里都写着。
 */
import type { TurnDecision, TurnRouter } from './turnRoute.ts'

/** 官方直连地址。经 OpenRouter / Gateway 绕的话用 `JEV_API_URL` 覆盖。 */
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

/** 钉住的版本。**不跟随更新**(AGENTS.md C3 同一条理由:阈值不能跨版本迁移)。 */
export const JEV_MODEL = 'jev-1.13.0'

/** 一次判定最多等多久。到点当没判出来 → 上层按 `act`。 */
export const JEV_TIMEOUT_MS = 1200

/**
 * 低于这个把握一律按 `act`。0.75 是**起手值,不是标定过的阈值** ——
 * 标定方案在设计文档 2.4(中文校准那七步),没跑过之前它只是一个「宁可慢别错」的旋钮。
 */
export const JEV_MIN_CONFIDENCE = 0.75

/** 三个选项。**`other` 是官方规矩**(choice 必加),我们把它当「拿不准」用。 */
export const JEV_CHOICES = ['闲聊', '要办事', 'other'] as const

/** 问什么。一个问题只问一件事、不带否定(官方 `/model-jaggedness` 说它按字面读)。 */
export const JEV_QUESTION
  = '下面这句话是用户在电话里对一位秘书说的。'
    + '他是想让秘书去做一件事(查事项、记东西、派活、换音色、问以前说过的话),'
    + '还是只是在说话(打招呼、回应、点评、问秘书自己是谁)?'

/** 定价:美元 / 百万输入 token(2026-09-23 官方页,官方承认可能是补贴价)。 */
export const JEV_USD_PER_MTOK = 0.042

/**
 * 一次调用大概几个 token。**中文按 1 字 ≈ 1 token 估**(保守;真账要看回包里的用量)。
 * 成本估算就用它,交接里写明是估的。
 */
export function estimateTokens(text: string): number {
  return JEV_QUESTION.length + JEV_CHOICES.join('').length + text.trim().length + 16
}

/** 估一次多少钱(美元)。 */
export function estimateCostUsd(text: string): number {
  return (estimateTokens(text) / 1_000_000) * JEV_USD_PER_MTOK
}

/**
 * 回包 → 判定。**纯函数**(假 HTTP 的用例直接喂它)。
 *
 * 读不懂、`other`、把握不够,一律 `act` —— 三条都落到同一边是故意的:
 * 这件事情上「没判出来」和「判成要办事」的后果一样,而多一条分支就多一处会写错的地方。
 */
export function decisionOfJevBody(body: unknown, ms: number): TurnDecision {
  const answer = readAnswer(body)
  if (answer === undefined) return { route: 'act', router: 'jev', reason: 'Jev 回包看不懂,按要办事走', ms }
  const { choice, confidence } = answer
  if (choice === 'other') {
    return { route: 'act', router: 'jev', reason: 'Jev 选了 other(拿不准),按要办事走', ms, ...(confidence === undefined ? {} : { confidence }) }
  }
  if (confidence !== undefined && confidence < JEV_MIN_CONFIDENCE) {
    return { route: 'act', router: 'jev', reason: `Jev 把握只有 ${confidence.toFixed(2)}(低于 ${JEV_MIN_CONFIDENCE}),按要办事走`, ms, confidence }
  }
  const route = choice === '闲聊' ? 'chat' : 'act'
  return {
    route,
    router: 'jev',
    reason: `Jev 判「${choice}」`,
    ms,
    ...(confidence === undefined ? {} : { confidence }),
  }
}

/** 回包里把「选了哪个」和「多有把握」挖出来。形状不对回 undefined。 */
function readAnswer(body: unknown): { choice: string, confidence?: number } | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const questions = (body as { questions?: unknown }).questions
  const first = Array.isArray(questions) ? questions[0] : (body as { answer?: unknown }).answer
  const row = (typeof first === 'object' && first !== null ? first : body) as Record<string, unknown>
  const choice = typeof row.choice === 'string' ? row.choice : (typeof row.answer === 'string' ? row.answer : undefined)
  if (choice === undefined) return undefined
  const confidence = typeof row.confidence === 'number' && Number.isFinite(row.confidence) ? row.confidence : undefined
  return { choice, ...(confidence === undefined ? {} : { confidence }) }
}

export interface JevOptions {
  /** **只从环境变量来**(turnRoute.ts 的 createTurnRouter)。这里不读文件、不写文件。 */
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
  /** 测试注入。缺省全局 fetch。 */
  fetchImpl?: typeof fetch
  now?: () => number
  log?: (line: string) => void
}

/**
 * Jev 分流。**一次判定 = 一次跨境 HTTP**,所以每一条路都有超时、每一条错都落到 `act`。
 */
export class JevTurnRouter implements TurnRouter {
  readonly name = 'jev'
  readonly #apiKey: string
  readonly #url: string
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #log: (line: string) => void

  constructor(options: JevOptions) {
    this.#apiKey = options.apiKey
    this.#url = options.baseUrl ?? JEV_URL
    this.#timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? (() => Date.now())
    this.#log = options.log ?? (() => {})
  }

  async route(text: string): Promise<TurnDecision> {
    const began = this.#now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    timer.unref?.()
    try {
      const res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // key 只在这一行出现:不进日志、不进异常消息、不进回包的记录。
          'authorization': `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          model: JEV_MODEL,
          state: text.trim(),
          questions: [{ id: 'route', type: 'choice', question: JEV_QUESTION, choices: [...JEV_CHOICES] }],
        }),
        signal: controller.signal,
      })
      const ms = this.#now() - began
      if (!res.ok) {
        this.#log(`[channel-worker] Jev 回了 ${res.status},这一回合按要办事走`)
        return { route: 'act', router: 'jev', reason: `Jev 回了 ${res.status}`, ms }
      }
      return decisionOfJevBody(await res.json(), ms)
    }
    catch (err) {
      const ms = this.#now() - began
      const why = (err as Error)?.name === 'AbortError' ? `超过 ${this.#timeoutMs}ms 没回来` : ((err as Error)?.message ?? '没说原因')
      this.#log(`[channel-worker] Jev 没判成(${why}),这一回合按要办事走`)
      return { route: 'act', router: 'jev', reason: `Jev 没判成:${why}`, ms }
    }
    finally { clearTimeout(timer) }
  }
}
