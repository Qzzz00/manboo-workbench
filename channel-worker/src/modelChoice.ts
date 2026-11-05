/**
 * 接话模型往哪儿发(2026-09-17,决策记录同日「模型 API 是后面的可选步骤,默认用我们提供的服务」)。
 *
 * 工作台的设置里多了一节「模型服务」,选择落在 `~/.dsh/workbench/model.json`:
 *
 *   { "mode": "relay" | "own", "relay_url": "https://api.aibooo.cn", "relay_token": "wb_…" }
 *
 * 工人读同一份文件,所以「在设置里切一次,电话那头也跟着换」。
 *
 * ## 三条优先级,以及为什么是这个顺序
 *
 * 1. **显式设了 `WORKBENCH_CHANNEL_LLM_BASE_URL` 的环境变量最大。**
 *    那是统筹临时把工人指到别处跑一次用的(灰度、对着假上游验收),
 *    这种时候他要的就是「别管文件里写的什么」。
 * 2. **其次看 model.json。** `relay` 就发去中转、拿中转令牌当 Bearer;`own` 就发去他自己那个端点
 *    (没填 = 官方,填了 `own.base_url` 就是那一家的 OpenAI 协议口,2026-10-23 卡「事务官换Key」)、
 *    拿他自己那把 Key;`own.model` 填了就把接话模型名一起换掉。
 * 3. **没有 model.json 就完全照旧**(`DEEPSEEK_API_KEY` → credentials.json 的 keys.deepseek,
 *    地址是官方)。这一条是为了老机器:model.json 是这一刀才有的文件,
 *    要是「文件不在 = 按 relay 处理」,那 Ben 现在这台机器一升级就会因为没有令牌而突然接不了话。
 *
 * ## 凭据纪律(同 deepseekKey.ts)
 *
 * 这个模块**只回值本身**,绝不打印、绝不写文件、绝不进任何回给房间的消息。
 * 想知道「配了没有」用返回里的 `ready`,它只是个布尔;`source` 是给日志用的一个词
 * (`relay` / `own` / `env`),不含地址之外的任何信息。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultCredentialsFile, deepseekKeyOfCredentials } from './deepseekKey.ts'

/** 工作台存「用哪一家」的地方(与 workbench-plugin 的 defaultModelFile 同一处)。 */
export function defaultModelFile(home: string = homedir()): string {
  return join(home, '.dsh', 'workbench', 'model.json')
}

export interface ModelChoice {
  mode: 'relay' | 'own'
  relayUrl: string
  relayToken?: string
  /**
   * own 档「自己的 OpenAI 协议端点」(2026-10-23,卡「事务官换Key」)。缺席 = 官方地址 / 缺省模型名,
   * 老配置一字不变。都不是秘密(note 里可以说),Key 仍只在 credentials.json / 环境变量里。
   */
  ownBaseUrl?: string
  ownModel?: string
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * model.json 的文本 → 选择。**坏 JSON 与缺字段都返回 undefined**(= 当作没有这个文件),
 * 而不是当成 `relay`:一份写坏的配置不该让工人去一个没有令牌的地方发请求。
 */
export function modelChoiceOfText(raw: string): ModelChoice | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch { return undefined }
  const obj = (parsed ?? {}) as Record<string, unknown>
  if (obj.mode !== 'relay' && obj.mode !== 'own') return undefined
  const url = text(obj.relay_url)
  if (obj.mode === 'relay' && url === undefined) return undefined
  // own 档的端点:只认 `own` 是对象;字段不对当没填(同插件侧 modelConfig.ts 的判法,对照用例钉着)。
  const own = (typeof obj.own === 'object' && obj.own !== null ? obj.own : {}) as Record<string, unknown>
  const ownBase = text(own.base_url)
  const ownModel = text(own.model)
  return {
    mode: obj.mode,
    relayUrl: trimSlash(url ?? ''),
    ...(text(obj.relay_token) === undefined ? {} : { relayToken: text(obj.relay_token) as string }),
    ...(ownBase === undefined ? {} : { ownBaseUrl: trimSlash(ownBase) }),
    ...(ownModel === undefined ? {} : { ownModel }),
  }
}

export type ChannelModelSource = 'env' | 'relay' | 'own'

export interface ChannelModelTarget {
  baseUrl: string
  key?: string
  /**
   * 该用的模型名(2026-10-23)。只有 own 档**自己填了**才有 —— 老配置与 relay 档缺席,
   * 工人照旧用配置里的缺省名(`CHANNEL_DEFAULTS.llmModel`,与插件侧 {@link OWN_DEFAULT_MODEL} 同一个)。
   */
  model?: string
  source: ChannelModelSource
  /** 能不能真的发出去。false 时工人照常起,只是接不了话(与之前同一套行为)。 */
  ready: boolean
  /** 一句给日志看的人话。**不含任何 key**。 */
  note: string
}

export interface ResolveChannelModelDeps {
  env?: Record<string, string | undefined>
  /** 环境变量没给时用的官方地址(CHANNEL_DEFAULTS.llmBaseUrl)。 */
  fallbackBaseUrl: string
  home?: string
  modelFile?: string
  credentialsFile?: string
  readFileImpl?: (file: string) => Promise<string>
}

/** 他自己那把 Key:环境变量优先,其次 credentials.json(与 deepseekKey.ts 同一条路)。 */
async function ownKeyOf(
  env: Record<string, string | undefined>,
  credentialsFile: string,
  read: (file: string) => Promise<string>,
): Promise<string | undefined> {
  const fromEnv = text(env.DEEPSEEK_API_KEY)
  if (fromEnv !== undefined) return fromEnv
  try { return deepseekKeyOfCredentials(await read(credentialsFile)) }
  catch { return undefined }
}

export async function resolveChannelModel(deps: ResolveChannelModelDeps): Promise<ChannelModelTarget> {
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const read = deps.readFileImpl ?? ((file: string) => readFile(file, 'utf8'))
  const credentialsFile = deps.credentialsFile ?? defaultCredentialsFile(home)

  // ① 环境变量显式指定了地址:统筹在临时跑,别管文件。
  const envBase = text(env.WORKBENCH_CHANNEL_LLM_BASE_URL)
  if (envBase !== undefined) {
    const key = await ownKeyOf(env, credentialsFile, read)
    return {
      baseUrl: trimSlash(envBase),
      ...(key === undefined ? {} : { key }),
      source: 'env',
      ready: key !== undefined,
      note: `接话模型按环境变量指到 ${trimSlash(envBase)}${key === undefined ? ',但没有 key' : ''}`,
    }
  }

  // ② model.json。
  let choice: ModelChoice | undefined
  try { choice = modelChoiceOfText(await read(deps.modelFile ?? defaultModelFile(home))) }
  catch { choice = undefined }

  if (choice?.mode === 'relay') {
    if (choice.relayToken !== undefined) {
      return {
        baseUrl: `${choice.relayUrl}/v1`,
        key: choice.relayToken,
        source: 'relay',
        ready: true,
        note: '接话模型走工作台提供的服务',
      }
    }
    // 选了中转但还没领到凭证:退回他自己的端点,并**说出来**——
    // 不说的话现象是「电话能打但答非所问地沉默」,那是最难查的一种。
    const key = await ownKeyOf(env, credentialsFile, read)
    const fallback = ownTargetOf(choice, deps.fallbackBaseUrl)
    return {
      baseUrl: fallback.baseUrl,
      ...(key === undefined ? {} : { key }),
      ...(fallback.model === undefined ? {} : { model: fallback.model }),
      source: 'own',
      ready: key !== undefined,
      note: key === undefined
        ? '选了工作台提供的服务但还没领到凭证,而且也没有自己的 Key —— 接不了话'
        : '选了工作台提供的服务但还没领到凭证,这一轮先用你自己的 Key',
    }
  }

  // ③ 选了自己的 Key,或者压根没有 model.json(老机器)——都走「他自己的端点」那一条老路。
  const key = await ownKeyOf(env, credentialsFile, read)
  const target = choice === undefined
    ? { baseUrl: deps.fallbackBaseUrl, model: undefined as string | undefined }
    : ownTargetOf(choice, deps.fallbackBaseUrl)
  return {
    baseUrl: target.baseUrl,
    ...(key === undefined ? {} : { key }),
    ...(target.model === undefined ? {} : { model: target.model }),
    source: 'own',
    ready: key !== undefined,
    note: key === undefined ? '没有接话模型的 key' : '接话模型用你自己的 Key',
  }
}

/**
 * own 档「自己的端点」往哪发(2026-10-23,卡「事务官换Key」):他填的地址**原样用**
 * (只去末尾斜杠,**不自动补 `/v1`**)——工人这一路是 OpenAI 官方 SDK(`llmThinking.ts`
 * 的 `createNoThinkingClient`),拿 baseURL 直接拼 `/chat/completions`;
 * 火山方舟 Agent Plan 是 `/api/plan/v3`,补一个 `/v1` 就是 404。没填用缺省那个
 * (CHANNEL_DEFAULTS.llmBaseUrl,官方带 `/v1` 的写法);模型名同理,没填 = 工人缺省那个。
 */
function ownTargetOf(choice: Pick<ModelChoice, 'ownBaseUrl' | 'ownModel'>, fallbackBaseUrl: string): { baseUrl: string, model?: string } {
  const base = trimSlash(choice.ownBaseUrl ?? '')
  return {
    baseUrl: base === '' ? fallbackBaseUrl : base,
    ...(choice.ownModel === undefined ? {} : { model: choice.ownModel }),
  }
}

/**
 * 「这一通电话」的活模型视图(2026-10-23 运行时 P1):工人是常驻的,一份模型配置
 * 只管**一通** —— 每通电话开始现读一次 model.json(agent.ts 的每通刷新,
 * 与「认得出哪几家」同一条缝):在通的这一通照旧打完,下一通自然吃新配置;
 * 不打断通话,也不靠外部重启进程。
 */
export interface ChannelModelNow {
  llmModel: string
  firstVoiceModel: string
  llmBaseUrl: string
  key: string | undefined
  source: ChannelModelSource
}

/**
 * 把 `resolveChannelModel` 的解析结果落到一通电话的完整配置上。
 * 与 main.ts 启动时同一套覆盖规矩:自己填的模型名 → 接话与首声都跟着换;
 * `WORKBENCH_CHANNEL_LLM_MODEL` 等环境变量指过的照旧最大,文件里的值不盖它。
 */
export function applyModelChoice<T extends { llmModel: string, firstVoiceModel: string, llmBaseUrl: string }>(
  base: T,
  model: ChannelModelTarget,
  env: Record<string, string | undefined> = {},
): T {
  // 统筹用环境变量临时指过模型名(灰度、对着假上游验收):那比文件里的设置大,不盖。
  const envPicked = text(env.WORKBENCH_CHANNEL_LLM_MODEL) !== undefined
    || text(env.WORKBENCH_CHANNEL_FIRST_VOICE_MODEL) !== undefined
  return {
    ...base,
    llmBaseUrl: model.baseUrl,
    ...(model.model === undefined || envPicked ? {} : { llmModel: model.model, firstVoiceModel: model.model }),
  }
}

/** 从拼好的 config + 解析结果提取「这一通」的活视图(agent 每通刷新用)。 */
export function channelModelNow(
  config: { llmModel: string, firstVoiceModel: string, llmBaseUrl: string },
  key: string | undefined,
  source: ChannelModelSource,
): ChannelModelNow {
  return { llmModel: config.llmModel, firstVoiceModel: config.firstVoiceModel, llmBaseUrl: config.llmBaseUrl, key, source }
}

/**
 * 每通现读的结果要不要换上:`fresh` 取不到(读盘坏了)或四样全同 → 不换(返回 undefined),
 * 省得每通白重建一遍 LLM 客户端。任何一样变了 → 返回新的。
 */
export function channelModelRefreshOf(current: ChannelModelNow, fresh: ChannelModelNow | undefined): ChannelModelNow | undefined {
  if (fresh === undefined) return undefined
  if (current.llmModel === fresh.llmModel
    && current.firstVoiceModel === fresh.firstVoiceModel
    && current.llmBaseUrl === fresh.llmBaseUrl
    && current.key === fresh.key) return undefined
  return fresh
}

/**
 * 「换 LLM,成功才提交」的编排(2026-10-23 源审退修)。
 *
 * 原实现在 await `agent.updateOptions` **之前**就改了本地缓存 —— updateOptions 失败时
 * 框架回滚旧 LLM,本地缓存却已新,下一通 fresh 与缓存相同 → 永远不重试。这里把两件事分开:
 * `apply` 用 next 重建 LLM 交给框架,回 true = 换上、false/抛 = 没换上(框架回滚旧 LLM)。
 * 只有 true 才把 next 交还调用方**提交本地缓存**;false 回 undefined —— 调用方保持旧状态,
 * 于是下一通 fresh 与旧状态依旧不同 → 再次尝试。
 *
 * **await apply 之后才返回**:调用方(agent.ts 的 greet)把它排进「首句投给 LLM」之前,
 * 顺序因此钉住(延迟的 apply 不结束,这个函数就不返回)。
 */
export async function applyCallModelRefresh(
  current: ChannelModelNow,
  fresh: ChannelModelNow | undefined,
  apply: (next: ChannelModelNow) => Promise<boolean>,
): Promise<ChannelModelNow | undefined> {
  const next = channelModelRefreshOf(current, fresh)
  if (next === undefined) return undefined
  const ok = await apply(next)
  return ok ? next : undefined
}
