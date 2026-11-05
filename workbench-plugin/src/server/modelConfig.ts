/**
 * 「模型服务」用哪一家(2026-09-17,决策记录同日「模型 API 是后面的可选步骤,默认用我们提供的服务」)。
 *
 * Ben 的原话:「可以默认使用我们提供的服务,也可以自己去 DeepSeek 生成 API Key 再来填入,
 * 不要变成阻塞项」。所以这里只有两个模式,默认那个**什么都不用填**:
 *
 * - `relay`(默认):走我们自己那台服务器上的中转(仓库里的 `relay/`)。
 *   工作台替用户领一个中转令牌存在本机,用户自始至终看不到也不用管它。
 * - `own`:用户自己的 DeepSeek Key —— 就是设置里「额度凭据」那一格早就有的那个
 *   (`credentials.json` 的 `keys.deepseek`),这里不再存第二份。
 *
 * ## 为什么单独一个文件、单独一份 model.json
 *
 * 不塞进 credentials.json:那份文件的规矩是「只存 Key、永不回显」,而 `mode` 是要显示的;
 * 混在一起迟早有人为了显示 mode 而把整份读出来送到浏览器。分开之后规矩不会打架 ——
 * **model.json 里唯一的秘密是 `relay_token`,它和 Key 一样永不回显**,其余字段都可以显示。
 *
 * ## 三个消费者
 *
 * 1. 工作台自己(设置里那一节,显示今日用量);
 * 2. 通道层工人(channel-worker,接话模型的 base URL 与 key);
 * 3. DSH 运行时(写 `~/.dsh/settings.yaml` 的 `llm-pi-ai` 那一段,见 dshModelSettings.ts)。
 *
 * 三家读的都是这一份文件,所以「切一次,三处都跟着变」。
 *
 * ## 「own」这一档是什么(2026-10-23,卡「事务官换Key」)
 *
 * 不再是「写死 DeepSeek 官方」,而是「**自己的 OpenAI 协议端点**」:地址、模型名可填
 * (`own.base_url` / `own.model`,缺省 = DeepSeek 官方 + {@link OWN_DEFAULT_MODEL},老配置一字不改照旧)。
 * Key 仍在 credentials.json,**一行明文都不进 model.json 之外的任何地方**:不进日志、不进 /state
 * (`/model/status` 只回「配没配」与地址、模型名 —— 后两样不是秘密,预填设置页用)。
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { BUILD_RELAY_URL } from '../buildEndpoints.ts'

export type ModelMode = 'relay' | 'own'

/**
 * 中转的缺省地址 = 这份构建带的那一个(src/buildEndpoints.ts):我们的发版构建是我们那台,**开源构建是空**。
 * model.json 里的 relay_url 压过它(自建中转的人填那里)。
 */
export const DEFAULT_RELAY_URL = BUILD_RELAY_URL

/**
 * 没接中转时各处说的那一句(2026-10-21,零服务器是缺省)。登录、出门、工作室、检查更新、通道凭据都说它,
 * 后面跟一句「那这一处该怎么办」。不说「连不上」—— 一个包都没发,不是网络的事。
 */
export const NO_RELAY_NOTE = '这台没接中转'

/** 手机 / 座机要「挂到账号下」(`/channel/relay-device`、`/channel/relay-handset`)而这台没接中转时那一句。 */
export const RELAY_LINK_NO_RELAY = `${NO_RELAY_NOTE}:没有账号可挂,手机和座机只在家里的局域网里用。`

/** 这台接没接中转:model.json(或构建)里有没有中转地址。没有 = 零服务器档,一个包都不往中转发。 */
export function relayConfigured(config: Pick<ModelConfig, 'relay_url'>): boolean {
  return config.relay_url !== ''
}

/** 用户自己的 Key 时,直连官方。也是 own 档「自己的端点」缺省的地址(老配置没有这一格 = 它)。 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/**
 * own 档「自己的 OpenAI 协议端点」缺省的地址 = DeepSeek 官方的 OpenAI SDK 写法(带 `/v1`,
 * 2026-10-23,卡「事务官换Key」)。老配置(没有 own.base_url)= 这一个,行为一字不变。
 *
 * **拼接规矩(三处消费方同一个,对照用例钉着)**:`own.base_url` **原样使用**,
 * 只在存的时候去掉末尾斜杠,**不自动补 `/v1`** —— 各家的 OpenAI 兼容口路径不一样:
 * DeepSeek 官方是 `/v1`、火山方舟 Agent Plan 是 `/api/plan/v3`,补错了就是 404。
 * 用户照他那一家的 SDK 文档填(文档里 baseURL 写什么就填什么);
 * 已经带 `/v1` 的(如 `https://api.moonshot.cn/v1`)也不会被拼成 `/v1/v1`。
 * 依据(都读过源码/文档,不是猜):OpenAI 官方 SDK 拿 baseURL 直接拼 `/chat/completions`;
 * DSH 的 pi-ai 一样(`dshModelSettings.ts` 文件头,上游 `api/openai-completions.js`);
 * 工人那一路就是 OpenAI 官方 SDK(`llmThinking.ts` 的 `createNoThinkingClient`);
 * 插件自己拼 `${baseUrl}/chat/completions`,同一规矩。
 */
export const OWN_DEFAULT_BASE_URL = `${DEEPSEEK_BASE_URL}/v1`

/**
 * own 档缺省的模型名(2026-10-23,卡「事务官换Key」)= 现在各处在用的那一个:
 * 插件自己调模型(progress / waiting / materialize / askModel)与通话工人缺省都是它。
 * 老配置(没有 own.model)照旧用这个名,行为一字不变。
 */
export const OWN_DEFAULT_MODEL = 'deepseek-v4-flash'

export interface ModelConfig {
  mode: ModelMode
  /** 中转地址,不含末尾斜杠。 */
  relay_url: string
  /** 中转令牌。**秘密**:不回显、不进日志、不进 /state。 */
  relay_token?: string
  /** 领令牌时报给中转的账号名。账号还在本机,所以这只是个名字(过渡,见交接第六节)。 */
  account?: string
  /**
   * 手上那把 `relay_token` 记在中转的**哪一个账号**名下(2026-09-27,卡 RM)。
   * 就是中转 `tokens.account` 那一列的原值:带账号会话领的是 `acct:<账号 id>`,
   * 装完还没登录时领的是一个名字(legacy)。
   *
   * 为什么非要记这一格:**房间名由这一列算**(relay/server/channel.cjs)。
   * 不记的话,「这台机器手上那把令牌是不是当前登录账号的」只能去问服务器,
   * 而那个问题每次启动都要问一遍、断网就问不出来。记下来之后它是一次本地比对。
   *
   * 缺席 = 不知道(09-27 之前装的机器都是这样)。这时只要登录着,就当成「不是本账号的」
   * 去重领一次 —— 重领是幂等的,而漏绑的后果是提机没人接。
   */
  relay_token_account?: string
  /** 这台机器的 id,第一次写文件时生成,之后不变。换设备重领令牌时用它区分。 */
  device_id: string
  /**
   * 切到中转之前 DSH 的 `agent-default-model.provider` 是什么。
   * 切回「用自己的 Key」时照它恢复 —— 不记的话只能一律回 `deepseek-official`,
   * 而他可能本来就配着别的。
   */
  dsh_prev_provider?: string
  /**
   * 工作台替他写 `agent-default-model.model` 之前,他原来选的是哪个模型(2026-10-23 退修)。
   * own 档他自己填模型名(或自己接端点)时我们会覆盖 model 行;他改回缺省模型名时
   * 照这一格恢复,不把他的选择弄丢。模式与 {@link dsh_prev_provider} 同一条。
   */
  dsh_prev_model?: string
  /** 最近成功切换前的官方默认模型，仅供旧会话对齐；与最终恢复来源 dsh_prev_model 分开。缺席不猜。 */
  dsh_alignment_prev_model?: string
  /**
   * own 档「自己的 OpenAI 协议端点」的地址(2026-10-23,卡「事务官换Key」)。
   * **原样使用**(只去末尾斜杠),不自动补 `/v1` —— 见 {@link OWN_DEFAULT_BASE_URL} 那一段。
   * 缺席(老配置)= {@link OWN_DEFAULT_BASE_URL}(DeepSeek 官方,行为照旧)。
   * 不是秘密,可以显示;Key 仍在 credentials.json,这一行明文都不进 model.json 之外的任何地方。
   */
  own_base_url?: string
  /** own 档用的模型名。缺席 = {@link OWN_DEFAULT_MODEL}。不是秘密,可以显示。 */
  own_model?: string
}

export function defaultModelFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/model.json`
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 一份文本 → 配置。**坏文件不抛**,退回默认(= 用我们提供的服务、还没领令牌),
 * 因为那正是「什么都没配过」的状态,界面显示它是对的。
 *
 * `newDeviceId` 注进来是为了测试能定死;生产就是 randomUUID。
 */
export function parseModelConfig(text_: string | undefined, newDeviceId: () => string = randomUUID): ModelConfig {
  let parsed: unknown
  try { parsed = text_ === undefined ? undefined : JSON.parse(text_) }
  catch { parsed = undefined }
  const raw = (parsed ?? {}) as Record<string, unknown>
  const relayUrl = trimSlash(text(raw.relay_url) ?? DEFAULT_RELAY_URL)
  // 没有中转地址时写着 relay 也按 own:那条路走不通,不装作能走(零服务器档就是这样起步的)。
  const mode: ModelMode = raw.mode === 'own' || relayUrl === '' ? 'own' : 'relay'
  // own 档的端点:只认 `own` 是一个对象;字段不对就当没填,退回缺省(官方 + 缺省模型名)。
  const own = (typeof raw.own === 'object' && raw.own !== null ? raw.own : {}) as Record<string, unknown>
  const ownBase = text(own.base_url)
  const ownModel = text(own.model)
  return {
    mode,
    relay_url: relayUrl,
    ...(text(raw.relay_token) === undefined ? {} : { relay_token: text(raw.relay_token) as string }),
    ...(text(raw.account) === undefined ? {} : { account: text(raw.account) as string }),
    ...(text(raw.relay_token_account) === undefined
      ? {}
      : { relay_token_account: text(raw.relay_token_account) as string }),
    device_id: text(raw.device_id) ?? newDeviceId(),
    ...(text(raw.dsh_prev_provider) === undefined ? {} : { dsh_prev_provider: text(raw.dsh_prev_provider) as string }),
    ...(text(raw.dsh_prev_model) === undefined ? {} : { dsh_prev_model: text(raw.dsh_prev_model) as string }),
    ...(text(raw.dsh_alignment_prev_model) === undefined ? {} : { dsh_alignment_prev_model: text(raw.dsh_alignment_prev_model) as string }),
    own_base_url: ownBase === undefined ? OWN_DEFAULT_BASE_URL : trimSlash(ownBase),
    own_model: ownModel ?? OWN_DEFAULT_MODEL,
  }
}

export async function loadModelConfig(
  file: string,
  newDeviceId: () => string = randomUUID,
): Promise<ModelConfig> {
  try { return parseModelConfig(await readFile(file, 'utf8'), newDeviceId) }
  catch { return parseModelConfig(undefined, newDeviceId) }
}

/** 落盘,0600(同 credentials.json:里头有令牌)。own 的地址与模型名收成 `own` 对象那一格。 */
export async function saveModelConfig(file: string, config: ModelConfig): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const { own_base_url, own_model, ...rest } = config
  const onDisk = {
    ...rest,
    own: { base_url: own_base_url ?? OWN_DEFAULT_BASE_URL, model: own_model ?? OWN_DEFAULT_MODEL },
  }
  await writeFile(file, `${JSON.stringify(onDisk, null, 2)}\n`, { mode: 0o600 })
  // writeFile 的 mode 只在新建时生效,已存在的文件要显式收一次(同 credentials.ts)。
  await chmod(file, 0o600)
}

/**
 * 此刻真正该用的 base URL 与 key。三个消费者都走这一个函数,
 * 免得「工作台以为在用中转、工人还在直连官方」这种各说各话的状态。
 *
 * `ownKey` 是 credentials.json 里那一个(调用方读进来,这里不碰那份文件)。
 * 拿不到 key 时返回 `key: undefined` 而不是抛 —— 没配好只是「接不了话」,不是崩溃。
 */
export interface ModelEndpoint {
  mode: ModelMode
  /**
   * 直接给 OpenAI 客户端用的 base URL(后面拼 `/chat/completions`)。
   * relay = `${relay_url}/v1`(我们的中转只暴露 `/v1/*`);
   * own = 他填的 `own.base_url` **原样**(不自动补 `/v1`,见 {@link OWN_DEFAULT_BASE_URL} 那一段)。
   */
  baseUrl: string
  key?: string
  /**
   * 该用的模型名(2026-10-23,卡「事务官换Key」)。**只有 own 档有** —— 他自己填的模型名;
   * relay 档一字不动(消费方照旧用各自登记的名,中转把名字透传给上游)。
   */
  model?: string
  /** 能不能真的发出去。false 时界面要说清楚缺什么。 */
  ready: boolean
}

/**
 * own 档「自己的端点」此刻该往哪发、用哪个模型名。缺省填齐的老配置(官方 + 缺省模型名)
 * 也走这一个函数 —— 三处消费方拼出来的东西因此永远一致(对照用例钉着)。
 */
export function ownEndpointOf(config: Pick<ModelConfig, 'own_base_url' | 'own_model'>): { baseUrl: string, model: string } {
  return {
    baseUrl: config.own_base_url ?? OWN_DEFAULT_BASE_URL,
    model: config.own_model ?? OWN_DEFAULT_MODEL,
  }
}

export function modelEndpointOf(config: ModelConfig, ownKey?: string): ModelEndpoint {
  if (config.mode === 'own') {
    const own = ownEndpointOf(config)
    return {
      mode: 'own',
      baseUrl: own.baseUrl,
      ...(ownKey === undefined ? {} : { key: ownKey }),
      model: own.model,
      ready: ownKey !== undefined,
    }
  }
  return {
    mode: 'relay',
    baseUrl: `${config.relay_url}/v1`,
    ...(config.relay_token === undefined ? {} : { key: config.relay_token }),
    ready: config.relay_token !== undefined,
  }
}

/**
 * 中转回的今日用量。
 *
 * 2026-09-23 起中转按**元**算额度(relay/server/pricing.cjs):`used_cny` / `daily_cost_limit_cny` /
 * `remaining_cny` 三格是新的,**老中转没有** —— 那时整组缺席,界面回退显示 token 数。
 * token 那三格照旧,只作参考。
 */
export interface RelayUsageView {
  day: string
  used_tokens: number
  daily_token_limit: number
  remaining_tokens: number
  used_cny?: number
  daily_cost_limit_cny?: number
  remaining_cny?: number
}

/** 给浏览器看的形状。**没有 relay_token**,只有「领到了没有」。 */
export interface ModelStatusView {
  mode: ModelMode
  relay_url: string
  /** 这台接没接中转(`relayConfigured`)。false 时界面不给「用工作台提供的服务」那一项,说 {@link NO_RELAY_NOTE}。 */
  relay_configured: boolean
  relay_token_configured: boolean
  own_key_configured: boolean
  /** own 档的地址与模型名(2026-10-23)。都不是秘密,预填进设置那两格用。 */
  own_base_url: string
  own_model: string
  ready: boolean
  /** 今日用量。取不到(没令牌、中转连不上)就整块缺席,而不是填 0 —— 0 和「不知道」是两回事。 */
  usage?: RelayUsageView
  /** 取不到用量时的一句人话。 */
  usage_error?: string
}

export function modelStatusOf(
  config: ModelConfig,
  ownKeyConfigured: boolean,
  usage?: ModelStatusView['usage'],
  usageError?: string,
): ModelStatusView {
  const own = ownEndpointOf(config)
  return {
    mode: config.mode,
    relay_url: config.relay_url,
    relay_configured: relayConfigured(config),
    relay_token_configured: config.relay_token !== undefined,
    own_key_configured: ownKeyConfigured,
    own_base_url: own.baseUrl,
    own_model: own.model,
    ready: config.mode === 'own' ? ownKeyConfigured : config.relay_token !== undefined,
    ...(usage === undefined ? {} : { usage }),
    ...(usageError === undefined ? {} : { usage_error: usageError }),
  }
}

/** PUT /model 的请求体。只认这几个字段,别的忽略。 */
export type ModelPatchParsed =
  | { ok: true, mode: ModelMode, relay_url?: string, own_base_url?: string, own_model?: string }
  | { ok: false, error: string }

export function parseModelPatch(body: unknown): ModelPatchParsed {
  const raw = (body ?? {}) as Record<string, unknown>
  if (raw.mode !== 'relay' && raw.mode !== 'own') {
    return { ok: false, error: 'mode 要是 relay(用工作台提供的服务)或 own(用自己的 DeepSeek Key)' }
  }
  const url = text(raw.relay_url)
  if (url !== undefined && !/^https?:\/\//.test(url)) {
    return { ok: false, error: '中转地址要以 http:// 或 https:// 开头' }
  }
  // own 档自己的端点(2026-10-23):可填可不填;填了就要过校验。地址与模型名都不是秘密。
  const ownBase = text(raw.own_base_url)
  if (ownBase !== undefined && !/^https?:\/\//.test(ownBase)) {
    return { ok: false, error: '模型服务的地址要以 http:// 或 https:// 开头' }
  }
  const ownModel = text(raw.own_model)
  if (ownModel !== undefined && (ownModel !== ownModel.trim() || /\s/.test(ownModel))) {
    return { ok: false, error: '模型名不能为空,也不能带空白' }
  }
  return {
    ok: true,
    mode: raw.mode,
    ...(url === undefined ? {} : { relay_url: trimSlash(url) }),
    ...(ownBase === undefined ? {} : { own_base_url: trimSlash(ownBase) }),
    ...(ownModel === undefined ? {} : { own_model: ownModel }),
  }
}

/**
 * 「这台机器现在要不要**自动**去接工作台提供的模型服务」(2026-09-18,决策记录同日
 * 「新用户零凭据:模型服务令牌要在注册那一刻自动领」)。
 *
 * 09-17 那一版把领令牌挂在设置里那颗按钮上,于是 Ben 清空凭据之后真机上是
 * `mode:'relay'` 但 `relay_token_configured:false` —— **默认值说得没错,只是没人去领**。
 * 新用户不该被要求点这一下,所以注册/登录成功那一刻由服务端自己跑一遍。
 *
 * 判据只有三条,都摆在这里、都是纯函数(要在没有网络、没有文件系统的用例里钉住):
 *
 * 1. `mode: 'own'` —— 他自己选过「用我自己的 DeepSeek 账号」。**一个字都不动**:
 *    自动化去改一个人明确做过的选择,比不自动化糟得多。
 * 2. 已经有令牌 —— 接过了,再领一次只会把旧的作废(中转那边 issueToken 就是这么做的)。
 * 3. 他已经填了自己的 DeepSeek Key —— 任务卡原话「已有自己 Key 时不动」。
 *    `model.json` 还不存在时默认值恰好是 relay,可他手里那把 Key 是**真凭据**,
 *    这时候替他去领中转令牌等于替他换了一家服务商。
 *
 * 剩下的那一种(没选过、没令牌、也没 Key)才是新用户,才自动。
 */
export type AutoRelayDecision =
  | { auto: true }
  | { auto: false, reason: 'no_relay' | 'own_mode' | 'already_linked' | 'own_key' }

export function autoRelayDecision(config: ModelConfig, ownKeyConfigured: boolean): AutoRelayDecision {
  if (!relayConfigured(config)) return { auto: false, reason: 'no_relay' }
  if (config.mode === 'own') return { auto: false, reason: 'own_mode' }
  if (config.relay_token !== undefined) return { auto: false, reason: 'already_linked' }
  if (ownKeyConfigured) return { auto: false, reason: 'own_key' }
  return { auto: true }
}

/**
 * 向中转领一个令牌。第一次切到「用工作台提供的服务」时叫一次,以后除非重领不再叫。
 *
 * 失败一律返回一句**人话**而不是抛:领不到只是「今天还用不了」,界面要能说清楚原因。
 * 中转那边的错误形状是 OpenAI 的 `{ error: { message } }`,这里照读。
 */
export type RegisterResult =
  | {
      ok: true
      token: string
      /**
       * 这把令牌记在中转的哪个账号名下(中转回包里的 `account`,2026-09-27 卡 RM)。
       * 房间名由它算,所以它要跟着令牌一起存进 model.json。老中转不回这一项就缺席。
       */
      account?: string
    }
  | { ok: false, error: string, no_relay?: true }

/**
 * 「这台机器手上那把令牌属于当前登录的账号吗;不属于要不要现在就去重领」(2026-09-27,卡 RM)。
 *
 * **为什么这是一件必须做的事,而不是一个补丁**:每一台新装的机器走的都是同一条路 ——
 * 装完 → 工作台起来 → modelService 先领一把令牌(引导要调模型)→ 用户**这才**登录。
 * 那一把是 legacy 的,`account` 列是个名字;而座机、扫码的手机是带账号会话领的,
 * `account` 列是 `acct:<id>`。房间由那一列算,于是同一个账号两间房:
 * 电脑与手机在一间,座机在另一间 —— 提机没人接、给座机换网络也发不到它头上。
 *
 * 所以「登录」这件事从今天起多一层意思:**把这台机器挂到账号下**。判据全在这个纯函数里:
 *
 *   · 没登录(`accountScope` 缺席)→ 不动。legacy 令牌照样调模型,引导要用它。
 *   · 还没有令牌 → 不用「重领」,照常的领取那条路会带上会话(`reason: 'no_token'`)。
 *   · 有令牌、而且 `relay_token_account` 正好是这个账号 → **一个字节都不动**
 *     (重领会把旧的作废,手机上正通着的那条会当场断)。
 *   · 有令牌、但那一格缺席或对不上 → 重领(`reason: 'not_this_account'` / `'unknown'`)。
 */
export type DeviceTokenBinding =
  | { rebind: false, reason: 'no_relay' | 'not_logged_in' | 'already_bound' }
  | { rebind: true, reason: 'no_token' | 'unknown' | 'not_this_account' }

export function deviceTokenBindingOf(config: ModelConfig, accountScope: string | undefined): DeviceTokenBinding {
  if (!relayConfigured(config)) return { rebind: false, reason: 'no_relay' }
  if (accountScope === undefined || accountScope.trim() === '') return { rebind: false, reason: 'not_logged_in' }
  /**
   * 「我自己的 DeepSeek Key」那一支:模型不走中转,可**电话照样要打**
   * (channelCredentials 那段注释里同一条理由)。所以这里**照样绑** —— 绑的只是
   * 「这台机器在服务器上的身份」,一个字都不碰他选的那家模型。
   */
  if (config.relay_token === undefined) return { rebind: true, reason: 'no_token' }
  if (config.relay_token_account === undefined) return { rebind: true, reason: 'unknown' }
  return config.relay_token_account === accountScope
    ? { rebind: false, reason: 'already_bound' }
    : { rebind: true, reason: 'not_this_account' }
}

export async function registerRelayDevice(
  options: {
    relayUrl: string
    account: string
    deviceId: string
    /**
     * 账号会话令牌(2026-09-21)。**带了它,这台设备就记在服务器上那个账号名下**,
     * 房间由账号 id 算 —— 这是堵上「知道账号名就能进别人房」那个洞的最后一环。
     * 没带就走老路(`account` 那个名字),服务器那边由 RELAY_ALLOW_LEGACY_REGISTER 决定还认不认。
     */
    session?: string
    /** 显示在「我的设备」里的名字与类型。只在带了会话时有意义。 */
    name?: string
    kind?: 'mac' | 'phone' | 'windows' | 'other'
    fetchImpl?: typeof fetch
    timeoutMs?: number
  },
): Promise<RegisterResult> {
  if (trimSlash(options.relayUrl) === '') return { ok: false, error: NO_RELAY_NOTE, no_relay: true }
  const fetchImpl = options.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(`${trimSlash(options.relayUrl)}/register-device`, {
      method: 'POST',
      // 不设上限的话,中转不回话时取通道凭据前「先补一张令牌」那一步一直挂着,电话工人那条拉起循环跟着停(2026-10-21)。
      signal: AbortSignal.timeout(options.timeoutMs ?? RELAY_REGISTER_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        ...(options.session === undefined ? {} : { authorization: `Bearer ${options.session}` }),
      },
      body: JSON.stringify({
        // 带了会话就不发 account:服务器认会话,发了也只是噪音(而且那是个人信息)。
        ...(options.session === undefined ? { account: options.account } : {}),
        device_id: options.deviceId,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.kind === undefined ? {} : { kind: options.kind }),
      }),
    })
  }
  catch {
    // 底层错误信息可能把地址、代理细节抖出来,一律换成自己的措辞。
    return { ok: false, error: '连不上工作台的模型服务(网络不通,或者服务还没部署好)。' }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } }
    return { ok: false, error: body.error?.message ?? `模型服务拒绝了这次领取(HTTP ${res.status})。` }
  }
  const body = await res.json().catch(() => ({})) as { token?: unknown, account?: unknown }
  const token = text(body.token)
  if (token === undefined) return { ok: false, error: '模型服务回的内容看不懂,没拿到凭证。' }
  // `account` 是中转 tokens 表里那一列的原值(房间名由它算)。老中转不回就缺席,不编。
  const account = text(body.account)
  return { ok: true, token, ...(account === undefined ? {} : { account }) }
}

/** 问中转「我今天用了多少」。失败返回一句人话,同样不抛。 */
export type UsageResult =
  | { ok: true, usage: NonNullable<ModelStatusView['usage']> }
  | { ok: false, error: string }

/**
 * 用量往哪条路上问,**按顺序试**(2026-09-18)。
 *
 * Ben 真机上这条一直回「模型服务没能给出用量(HTTP 404)」。查下来挡住的**不是中转** ——
 * 中转里 `/usage` 一直都在 —— 而是 Caddy:`api.aibooo.cn` 那一段只反代
 * `/v1/*`、`/register-device`、`/health`、`/updates/*`(deploy/aliyun-relay-setup.sh),
 * `/usage` 从公网压根到不了中转,那个 404 是 Caddy 自己回的。
 *
 * 中转把这条挪进了已经放行的前缀(`/v1/usage`,relay/server/app.cjs 里两条路同一个 handler),
 * 这里跟着改。**老路径留作退路**:服务器上那份中转还没重新部署时、以及直连 127.0.0.1:8795 的
 * 灰度实例,走的仍然是 `/usage`。只在 404 时退一步 —— 401 / 429 / 500 都是中转自己说的话,照原样报。
 */
export const RELAY_USAGE_PATHS = ['/v1/usage', '/usage'] as const

/**
 * 查一次中转用量最多等多久(2026-10-21 急修「8791 空转」)。原来不设上限:中转一慢,问的那一方(设置页、
 * 判模型的每日预算)就跟着挂几十秒,这一趟再到点也只是「今天的用量暂时看不到」。
 */
export const RELAY_USAGE_TIMEOUT_MS = 5000

/** 领一次设备令牌最多等多久(2026-10-21)。比查用量宽:注册那一下中转要写库。 */
export const RELAY_REGISTER_TIMEOUT_MS = 15_000

export async function fetchRelayUsage(
  options: { relayUrl: string, token: string, fetchImpl?: typeof fetch, timeoutMs?: number },
): Promise<UsageResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const base = trimSlash(options.relayUrl)
  if (base === '') return { ok: false, error: NO_RELAY_NOTE }
  const timeoutMs = options.timeoutMs ?? RELAY_USAGE_TIMEOUT_MS
  const ask = async (path: string): Promise<Response> => fetchImpl(`${base}${path}`, {
    headers: { authorization: `Bearer ${options.token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  let res: Response
  try {
    res = await ask(RELAY_USAGE_PATHS[0])
    if (res.status === 404) res = await ask(RELAY_USAGE_PATHS[1])
  }
  catch { return { ok: false, error: '连不上模型服务,今天的用量暂时看不到。' } }
  if (res.status === 401) return { ok: false, error: '这台设备的凭证失效了,点「重新领取」就好。' }
  if (res.status === 404) {
    // 两条路都没有 = 服务器上那份中转还是旧的。这句话要指向真正该做的事(重新部署),
    // 而不是留下一个让人去猜的「HTTP 404」。
    return { ok: false, error: '模型服务上没有「用量」这条接口(服务器上那份中转还是旧的,要重新部署一次)。' }
  }
  if (!res.ok) return { ok: false, error: `模型服务没能给出用量(HTTP ${res.status})。` }
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  const day = text(body.day)
  if (day === undefined) return { ok: false, error: '模型服务回的用量看不懂。' }
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  // 元那三格:中转说了上限才算数(老中转一格都没有 → 整组缺席,界面回退显示 token)。
  const cny = isNum(body.daily_cost_limit_cny)
    ? {
        used_cny: num(body.used_cny),
        daily_cost_limit_cny: body.daily_cost_limit_cny,
        remaining_cny: isNum(body.remaining_cny)
          ? body.remaining_cny
          : Math.max(0, body.daily_cost_limit_cny - num(body.used_cny)),
      }
    : {}
  return {
    ok: true,
    usage: {
      day,
      used_tokens: num(body.used_tokens),
      daily_token_limit: num(body.daily_token_limit),
      remaining_tokens: num(body.remaining_tokens),
      ...cny,
    },
  }
}
