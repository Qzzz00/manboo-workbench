/**
 * 「关于我自己」——她在电话里被问到自己是怎么跑起来的时候照着答的那几行
 * (2026-09-23,Ben 第四通真机:问「你跑在哪个模型上、thinking 开没开」,
 * 她答「我这边拿不到……得在电脑那端的设置里看」)。
 *
 * ## 为什么要有它
 *
 * 那句话是真话里最没用的一种:**信息就在她跑着的这个进程里**(模型名在 config、
 * 走不走中转在 modelChoice、识别方式在 asr、音色在 8792、版本在 8791),
 * 只是没人把它拼给模型看。于是她只能说「我拿不到」,而他要的答案离她一行代码远。
 *
 * ## 三条规矩
 *
 * 1. **每通电话开始时现拼**,不在进程启动时拼一次就完事:音色、版本、上一回合的延迟
 *    这几样在两通电话之间会变,拼死了就成了一份过期的自我介绍。
 * 2. **一个字都不写死**。每一行都来自这一轮真实的配置/回包;这个文件里没有
 *    「deepseek」「火山」之外的任何常量事实,连「thinking 没开」也是**读**
 *    交给模型的那几个参数读出来的(见 {@link thinkingOf})——哪天那里多一项,
 *    这段话自己就跟着变。
 * 3. **拿不到就说拿不到**。缺席的那一项写「这一项我没拿到」,不猜、不从别处推
 *    (D13:说错一个版本号比说「我没拿到」糟得多)。
 *
 * ## 凭据纪律
 *
 * 这里出现的只有**地址、名字、开关**。key / token 一个字节都不进这段话,
 * 也不进任何一条日志 —— {@link thinkingOf} 只从参数里读一个布尔,别的键看都不看。
 *
 * 纯函数:不认识 fetch、不认识 LiveKit。接线在 agent.ts。
 */

/** 接话模型往哪儿发。与 modelChoice.ts 的 `ChannelModelSource` 一一对上。 */
export type SelfModelRoute = 'relay' | 'own' | 'env'

/** 上一回合的延迟,只留电话里说得出口的那几段(latency.ts 的 `TurnLatency` 子集)。 */
export interface SelfTurnLatency {
  round?: number
  total_ms?: number | null
  asr_ms?: number | null
  llm_first_ms?: number | null
  tts_first_ms?: number | null
}

/**
 * 这一通电话开始时,这台机器上的实情。**每一项都可以缺席** —— 缺席就是「没拿到」,
 * 不是「没有」:8791 没答应、8792 没跑、这一轮还没有过回合,都会让某一项空着。
 */
export interface SelfFacts {
  /** 接话模型名(config.llmModel)。 */
  llmModel?: string
  /** 走中转还是直连(modelChoice 的 source)。 */
  llmRoute?: SelfModelRoute
  /** 模型请求发去哪个地址。**不含任何 key**。 */
  llmBaseUrl?: string
  /** 这一轮交给模型的参数里有没有 thinking 这一项(见 thinkingOf)。 */
  thinking?: boolean
  /** 识别方式:`volc-streaming`(火山流式)/ `segmented`(VAD 分段走 8792)。 */
  asr?: string
  /** 合成走哪个本机后端(8792)。 */
  ttsUrl?: string
  /** 合成的场景(火山那边按它绑音色)。 */
  ttsScene?: string
  /** 此刻的音色 id。 */
  ttsVoice?: string
  /** 工作台版本(8791 `GET /update/check` 的 current)。 */
  workbenchVersion?: string
  /** 这台电脑叫什么(config.deviceName)。 */
  deviceName?: string
  /** 这一通是谁接的:手机 / 树莓派话筒。 */
  answeredOn?: 'phone' | 'handset'
  /** 上一回合的计时(latency.ts)。 */
  lastTurn?: SelfTurnLatency
}

/** 拿不到的那一项统一这么说。**只此一句** —— 一种缺席就该只有一种说法。 */
export const SELF_MISSING = '这一项我没拿到'

/**
 * 参数里有没有把 thinking 打开。
 *
 * 读的是**这一轮真的交给模型的那个参数对象**(agent.ts 里构造 LLM 时用的那一个),
 * 所以这段话不是写死的「没开」:哪天那里多一项 `thinking` / `reasoning` /
 * `enable_thinking`,她在电话里的答案自己就变了。
 *
 * - 那几个键一个都没有 → `false`(**没开**,不是「不知道」:参数里没有就是没开);
 * - 有 → 按它的真假回。
 *
 * **只读这几个键**,别的键(apiKey 就在同一个对象里)看都不看,也绝不打印。
 */
export const THINKING_KEYS: readonly string[] = ['thinking', 'reasoning', 'enable_thinking', 'reasoning_effort']

export function thinkingOf(params: Record<string, unknown> | undefined): boolean | undefined {
  if (params === undefined) return undefined
  for (const key of THINKING_KEYS) {
    if (!(key in params)) continue
    const value = params[key]
    if (value === undefined || value === null) continue
    if (value === false || value === 'off' || value === 'none' || value === 'disabled') return false
    return true
  }
  return false
}

/** 「2130 毫秒」这类数。null / undefined / 负数一律当没测到。 */
function ms(value: number | null | undefined): string | undefined {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) return undefined
  return `${Math.round(value)} 毫秒`
}

function routeText(route: SelfModelRoute | undefined, baseUrl: string | undefined): string | undefined {
  if (route === undefined) return undefined
  const where = baseUrl === undefined ? '' : `(${baseUrl})`
  if (route === 'relay') return `走我们自己的中转${where}`
  if (route === 'own') return `直连模型厂商${where}`
  return `按这台机器上的环境变量指到${where === '' ? '别处' : where}`
}

/** 一行:`名目:内容`。内容缺席就写那句「没拿到」。 */
function line(label: string, value: string | undefined): string {
  return `${label}:${value === undefined || value.trim() === '' ? SELF_MISSING : value.trim()}`
}

/** 上一回合那一行。一个数都没测到就整行缺席(而不是写一串 null)。 */
export function lastTurnText(turn: SelfTurnLatency | undefined): string | undefined {
  if (turn === undefined) return undefined
  const total = ms(turn.total_ms)
  const parts: string[] = []
  const asr = ms(turn.asr_ms)
  const llm = ms(turn.llm_first_ms)
  const tts = ms(turn.tts_first_ms)
  if (asr !== undefined) parts.push(`识别 ${asr}`)
  if (llm !== undefined) parts.push(`模型第一段字 ${llm}`)
  if (tts !== undefined) parts.push(`第一句合成 ${tts}`)
  if (total === undefined && parts.length === 0) return undefined
  const head = total === undefined
    ? '他说完到我出声那一段没测到'
    : `他说完到我出声 ${total}`
  return `${head}${parts.length === 0 ? '' : `(${parts.join('、')})`}`
}

/**
 * 那几行 → 一段能直接贴进系统提示的话。
 *
 * 末尾那句约束是整段的要害:**照着答,拿不到就说没拿到**。
 * 没有它,模型会把「这一项我没拿到」自动补成一个听起来合理的值 —— 那正是要治的毛病。
 */
export function describeSelf(facts: SelfFacts): string {
  const voice = facts.ttsVoice
  const ttsText = facts.ttsUrl === undefined
    ? undefined
    : `经这台电脑上的事务官后端(${facts.ttsUrl})调火山合成${facts.ttsScene === undefined ? '' : `,场景 ${facts.ttsScene}`}${voice === undefined ? `,音色 ${SELF_MISSING}` : `,音色 ${voice}`}`
  const asrText = facts.asr === undefined
    ? undefined
    : facts.asr === 'volc-streaming'
      ? '火山流式识别(volc-streaming)'
      : facts.asr === 'segmented'
        ? '先断句再整段送去识别(segmented,走这台电脑上的事务官后端)'
        : facts.asr
  return [
    '——— 关于我自己 ———',
    '下面这几行是这一通电话开始时,从我这会儿真正跑着的配置里读出来的:',
    line('- 接话模型', facts.llmModel),
    line('- 模型走哪条路', routeText(facts.llmRoute, facts.llmBaseUrl)),
    line('- thinking(深度思考)', facts.thinking === undefined
      ? undefined
      : facts.thinking ? '开着(给模型的参数里有这一项)' : '没开 —— 这一轮给模型的参数里没有这一项'),
    line('- 我怎么听见你', asrText),
    line('- 我怎么出声', ttsText),
    line('- 工作台版本', facts.workbenchVersion),
    line('- 我跑在哪台电脑上', facts.deviceName),
    line('- 这一通是谁接的', facts.answeredOn === undefined
      ? undefined
      : facts.answeredOn === 'handset' ? '座机上那只树莓派话筒' : '手机'),
    line('- 上一回合的延迟', lastTurnText(facts.lastTurn)),
    '',
    `他问起我是怎么跑的(模型、思考、识别、音色、版本、延迟),就照上面这几行答,**别推、别猜**;`,
    `上面写着「${SELF_MISSING}」的那几项,就如实说这一项没拿到 —— 不要改口说「得去电脑那端看」,`,
    '那几项我本来就该知道。上面没写的(比如密钥),一个字都不要说,也不要猜它长什么样。',
  ].join('\n')
}
