/**
 * 让 DSH 运行时也走我们的中转(2026-09-17,任务卡第 1 与第 3③ 条的调研结论)。
 *
 * ## ⚠️ 这一份是 **0.1.2 那一代**(`settings.yaml` 形)。别直接调它
 *
 * 2026-09-26(卡 U1b):0.1.7 **把 `settings.yaml` 收走了** —— 每次启动改名成 `.imported`,
 * 里面每个顶层段写进当前 profile 的 `cordis.patch.yml`。补丁层那一代的读写在
 * `dshProfilePatch.ts`;**判哪一代、备份、落盘在 `dshSettingsStore.ts`**。
 * 模型面板、令牌下发、开机补齐这三处一律经 store,不许再自己拼 `settings.yaml` 这个路径。
 * 这一份仍然有用:0.1.2 那批机器、以及"换完运行时还没重启"的那一刻,走的正是它
 * (安装器播种也照旧写这个文件 —— 靠 0.1.7 那条一次性迁移带进补丁层)。
 *
 * 给人看的每一句话里**不出现文件名**(用户不知道 settings.yaml 是什么,也不该知道)。
 *
 * ## 调研结论:能配,不用改 DSH 一行源码
 *
 * DSH 的 `@deepseek-ai/dsh-llm-pi-ai` 插件**已经以「休眠」姿态挂在 profile 里**
 * (`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` 的 `- id: llm-pi-ai`,
 * 注释原文就是「zero routes … until a `llm-pi-ai:` settings section supplies provider profiles」)。
 * 也就是说:往 `~/.dsh/settings.yaml` 里写一段 `llm-pi-ai:`,它就当场注册出一条新的 provider 路由;
 * 把 `agent-default-model.provider` 指过去,DSH 的会话就走我们的中转了。
 *
 * 确切形状(upstream `packages/llm/llm-pi-ai/src/config.ts` L314-342 的 schema):
 *
 * ```yaml
 * llm-pi-ai:
 *   providers:
 *     workbench-relay:
 *       displayName: …
 *       api: openai-completions        # 三选一:openai-completions / openai-responses / anthropic-messages
 *       baseURL: https://<中转地址>/v1      # 带 /v1;pi-ai 往后面直接拼 /chat/completions 与 /models
 *       apiKeyEnv: WORKBENCH_RELAY_TOKEN    # 是「凭据引用」,不是值本身
 *       models:
 *         - id: deepseek-chat          # catalog 里没有的路由,api / baseURL / 非空 models 三者必填
 * ```
 *
 * `apiKeyEnv` 指的是一个**名字**,值由 DSH 的凭据层去找:继承的进程环境 → `~/.dsh/.credentials.yaml`
 * → `<cwd>/.env` → `$DSH_HOME/.env`。我们走最后那一层,把令牌写进 `~/.dsh/.env`。
 * `WORKBENCH_RELAY_TOKEN` 不在 DSH 的 bootstrap-only 名单里(那份名单在 app-boot/src/index.ts,
 * 含 `DEEPSEEK_BASE_URL`、`DSH_*` 前缀等,写进 .env 会让 DSH **拒绝启动**),所以可以放心写。
 *
 * ## 两个后果,交接文档里都写了
 *
 * 1. `settings.yaml` 是热加载的,但 `.env` 是**启动时**读进快照的 —— 所以第一次写令牌之后
 *    要 `launchctl kickstart -k gui/$(id -u)/ai.deepseek.dsh` 重启一次 DSH 才认。
 * 2. 这是 **Ben 的文件**。所以这里全部是「行级手术」而不是「读 YAML、改对象、再序列化」:
 *    后者会把他的注释、顺序、缩进风格洗掉一遍。我们只碰两处:
 *    - 整段 `llm-pi-ai:`(而且**只在它是我们自己写的时候**——靠段内第一行那句标记认;
 *      他要是自己配过 llm-pi-ai,我们一个字都不动,只回一句话让人工去看);
 *    - `agent-default-model:` 段里的 `provider:` **那一行**(`model:`、`reasoningEffort:` 原样留着)。
 */

/** 我们那条路由的名字。不能叫 deepseek-official —— 那是 llm-deepseek 已占的路由。 */
export const DSH_RELAY_PROVIDER = 'workbench-relay'

/**
 * own 档「自己接的端点」那条路由的名字(2026-10-23,卡「事务官换Key」)。
 * 同样避开 deepseek-official;与中转那条并存互斥(llm-pi-ai 的 config 按 id 整体替换,
 * 一次只有一条我们维护的路由在值班)。
 */
export const DSH_OWN_PROVIDER = 'workbench-own'

/** 令牌放在哪个环境变量名下。改名要同时改 settings.yaml 里的 apiKeyEnv。 */
export const DSH_RELAY_TOKEN_ENV = 'WORKBENCH_RELAY_TOKEN'

/**
 * 他自己那把 Key 交给 DSH 用的环境变量名(2026-10-23,卡「事务官换Key」)。
 * 只有 own 档填了自己接的端点(不是 DeepSeek 官方)才写进 ~/.dsh/.env;
 * 值就是 credentials.json 里那一把,0600,永不进日志、永不回显。
 * 不在 DSH 的 bootstrap-only 名单里(同 WORKBENCH_RELAY_TOKEN 那一条调研)。
 */
export const DSH_OWN_KEY_ENV = 'WORKBENCH_OWN_MODEL_KEY'

/** 用户自己的 Key 时回到这条路由(DSH 自带的那个)。 */
export const DSH_OFFICIAL_PROVIDER = 'deepseek-official'

/** 认「这一段是工作台写的」的标记。段**内**第一行,这样它跟着段一起被查到、被替换。 */
export const DSH_MANAGED_MARK = '# managed-by: workbench-model-panel'

const TOP_LEVEL = /^[A-Za-z0-9_-]+:/

/** 一个顶层段占的行区间 `[start, end)`。找不到返回 undefined。 */
export function topLevelBlockRange(lines: readonly string[], key: string): { start: number, end: number } | undefined {
  const start = lines.findIndex(line => line.startsWith(`${key}:`))
  if (start === -1) return undefined
  let end = start + 1
  while (end < lines.length && !TOP_LEVEL.test(lines[end] as string)) end += 1
  return { start, end }
}

function splitLines(text: string): string[] {
  return text.split('\n')
}

function joinLines(lines: readonly string[]): string {
  const out = lines.join('\n')
  return out.endsWith('\n') ? out : `${out}\n`
}

/** 读 `agent-default-model:` 段里现在是什么。段不在、字段不全都回 undefined。 */
export function readAgentDefaultModel(text: string): { provider?: string, model?: string } | undefined {
  const lines = splitLines(text)
  const range = topLevelBlockRange(lines, 'agent-default-model')
  if (range === undefined) return undefined
  const out: { provider?: string, model?: string } = {}
  for (const line of lines.slice(range.start + 1, range.end)) {
    const m = /^\s+(provider|model):\s*(.+?)\s*$/.exec(line)
    if (m === null) continue
    const value = (m[2] as string).replace(/^['"]|['"]$/g, '')
    if (m[1] === 'provider') out.provider = value
    else out.model = value
  }
  return out
}

/**
 * 中转上我们登记的模型(2026-09-24,统一输入框「模型直接列模型名」「图片现在就要能直接看」)。
 *
 * `images` 是**实测**出来的,不是猜的(2026-09-24 用本机中转令牌各发一张纯色 PNG 问颜色):
 * - `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`:都答对了颜色(中转回的上游名都是 `deepseek-flash`),能看图;
 * - `deepseek-v4-pro`:答「未知」,提示词只有 98 token(图被上游丢了),**不能看图**。
 *
 * DSH 按模型的 `input` 判能不能收图:不写就当只认文字,带图的消息会被拒(`MODEL_DOES_NOT_SUPPORT_IMAGES`)。
 * 所以能看图的那几个在我们那一段里写 `input: [text, image]`。
 *
 * 价:中转按名字里有没有 `flash` 定档(`relay/server/pricing.cjs` priceTierOf),三个里两个 Flash、一个 Pro。
 */
export interface RelayModelSpec {
  id: string
  /** 输入框胶囊上的短名。 */
  title: string
  images: boolean
}

export const RELAY_MODELS: readonly RelayModelSpec[] = [
  { id: 'deepseek-v4-flash', title: 'V4 Flash', images: true },
  { id: 'deepseek-v4-pro', title: 'V4 Pro', images: false },
  { id: 'deepseek-v4-flash-vision-exp', title: 'V4 Flash 看图版', images: true },
]

/** 每次写我们那一段都登记的两个(当前选中的另算,见 settingsForRelay)。 */
export const RELAY_STANDARD_MODELS: readonly string[] = ['deepseek-v4-flash', 'deepseek-v4-pro']

/** 查表;表里没有的按名字认一次(带 vision 的当能看图),短名就是原名 —— 不编一个好听的。 */
export function relayModelSpec(id: string): RelayModelSpec {
  return RELAY_MODELS.find(one => one.id === id) ?? { id, title: id, images: /vision/i.test(id) }
}

/**
 * **思考开关**(2026-09-28,卡 BS;设计-事务官做什么不做什么与思考分档 6.3 第 1 条)。
 *
 * 在这之前我们那条路由**一个思考参数都没声明**,于是 DSH 压根不发 —— 而中转后面的 DeepSeek
 * 默认「开着想」。09-28 实测:一天 150 万字思考里 74% 的输出是思考,思考按输出计价
 * (Flash 输出 8 元 / 百万,缓存命中的输入 0.04 元,差 200 倍)。所以要能**按会话关掉**。
 *
 * 怎么才关得掉(查实 pi-ai `api/openai-completions.js` 的 deepseek 那一支):
 * - 路由要声明 `compat.thinkingFormat: deepseek`,否则它认不出这是 DeepSeek 方言、什么都不发;
 * - 每个模型要声明 `reasoningEfforts`,键是能选的档、值是线上的拼法;
 *   **`off:` 留空**的那一档在 `thinkingLevelMap` 里不留键 —— 正是这一下让 pi-ai 发
 *   `thinking: { type: 'disabled' }`(`thinkingLevelMap.off !== null` 那一支);
 * - `supportsReasoningEffort` 开着,选了 low / high / max 时才带上 `reasoning_effort`,
 *   不然 low 和 high 发出去一模一样;
 * - `requiresReasoningContentOnAssistantMessages`:DeepSeek 多轮带工具时要把思考内容回放回去
 *   (catalog 里 deepseek 三个模型都是 true)。**一个会话一个档、中途不切**就是为了这一条。
 *
 * 档位与「哪件事用哪档」在 `butlerEffort.ts`;默认 = 关(全局默认也是关)。
 */
export const RELAY_THINKING_LEVELS: readonly { level: string, wire?: string }[] = [
  // off 故意留空值 —— 见上面第三条。
  { level: 'off' },
  { level: 'low', wire: 'low' },
  { level: 'high', wire: 'high' },
  { level: 'max', wire: 'max' },
]

/** 我们那条路由声明的 compat(provider 级,整条路由的模型共用)。 */
export const RELAY_COMPAT: readonly { key: string, value: string }[] = [
  { key: 'thinkingFormat', value: 'deepseek' },
  { key: 'supportsReasoningEffort', value: 'true' },
  { key: 'requiresReasoningContentOnAssistantMessages', value: 'true' },
  /*
   * DeepSeek 不认 `developer` 角色。pi-ai 看 baseURL(我们的中转地址)认不出背后是 DeepSeek,
   * 缺省当它支持 —— 模型一开思考,系统提示就用 developer 发,上游 422 拒掉整条请求
   * (2026-10-01 Air 诊断包:09-29 晚起事务官每一件都卡住)。
   */
  { key: 'supportsDeveloperRole', value: 'false' },
]

/**
 * **档位是按模型声明的,不是一刀切**(2026-09-28,卡 BS)。
 *
 * `deepseek-v4-pro` 线上没有 low 那一档;登记了它等于骗 DSH 说有,选中时上游会拒掉整条请求。
 * 所以这里按模型给能选的那几档 —— 表里没有的按全套(off / low / high / max)。
 */
const RELAY_MODELS_WITHOUT_LOW: readonly string[] = ['deepseek-v4-pro']

/** 这个模型能选哪几档。 */
export function relayThinkingLevels(id: string): readonly { level: string, wire?: string }[] {
  return RELAY_MODELS_WITHOUT_LOW.includes(id)
    ? RELAY_THINKING_LEVELS.filter(one => one.level !== 'low')
    : RELAY_THINKING_LEVELS
}

/** 一个模型登记项底下那几行(`input` 与 `reasoningEfforts`),缩进由调用方给。 */
export function relayModelFieldLines(id: string, indent: string): string[] {
  return [
    ...(relayModelSpec(id).images ? [`${indent}input: [text, image]`] : []),
    `${indent}reasoningEfforts:`,
    ...relayThinkingLevels(id).map(one => `${indent}  ${one.level}:${one.wire === undefined ? '' : ` ${one.wire}`}`),
  ]
}

/** 我们那一段的文本。`models` 至少一条 —— catalog 没有的路由,空 models 会被 DSH 当场拒掉。 */
export function relayProviderBlock(options: {
  baseUrl: string
  models: readonly string[]
  displayName?: string
}): string {
  const models = options.models.length === 0 ? ['deepseek-chat'] : options.models
  return [
    'llm-pi-ai:',
    `  ${DSH_MANAGED_MARK}`,
    '  # 这一段由工作台「设置 → 模型」维护,手改会被下一次切换覆盖。',
    '  providers:',
    `    ${DSH_RELAY_PROVIDER}:`,
    `      displayName: ${options.displayName ?? '工作台提供的模型服务'}`,
    '      api: openai-completions',
    `      baseURL: ${options.baseUrl}`,
    `      apiKeyEnv: ${DSH_RELAY_TOKEN_ENV}`,
    '      compat:',
    ...RELAY_COMPAT.map(one => `        ${one.key}: ${one.value}`),
    '      models:',
    ...models.flatMap(id => [`        - id: ${id}`, ...relayModelFieldLines(id, '          ')]),
  ].join('\n')
}

/**
 * 老机器上的那一段补齐(2026-09-24):**只在那一段是我们自己写的时候**,按现在的规矩重写一遍
 * (补上 pro、给能看图的写 `input`),baseURL 与已登记的模型原样保留,`agent-default-model` 一个字不碰
 * (他切回了自己的 Key 也不会被我们切回中转)。settings.yaml 是热加载的,不用重启。
 */
export function upgradeManagedRelayBlock(text: string): DshSettingsEdit {
  const lines = splitLines(text)
  const range = topLevelBlockRange(lines, 'llm-pi-ai')
  if (range === undefined) return { ok: true, text, changed: false }
  const body = lines.slice(range.start, range.end)
  if (!body.join('\n').includes(DSH_MANAGED_MARK)) return { ok: true, text, changed: false }
  const baseLine = body.map(line => /^\s+baseURL:\s*(.+?)\s*$/.exec(line)).find(m => m !== null)
  if (baseLine === undefined || baseLine === null) return { ok: true, text, changed: false }
  const registered = body.map(line => /^\s+- id:\s*(.+?)\s*$/.exec(line)?.[1]).filter((id): id is string => id !== undefined)
  const current = readAgentDefaultModel(text)?.model
  const models = [...new Set([...(current === undefined ? [] : [current]), ...registered, ...RELAY_STANDARD_MODELS])]
  const block = relayProviderBlock({ baseUrl: baseLine[1] as string, models })
  // 段尾的空行留在段外(与 settingsForRelay 一致),只替换有内容的那几行。
  let end = range.end
  while (end > range.start + 1 && (lines[end - 1] as string).trim() === '') end -= 1
  const next = [...lines.slice(0, range.start), ...splitLines(block), ...lines.slice(end)]
  const out = joinLines(next)
  return { ok: true, text: out, changed: out !== joinLines(lines) }
}

export type DshSettingsEdit =
  | { ok: true, text: string, changed: boolean }
  | { ok: false, error: string }

/**
 * 切到中转:装上(或更新)我们那一段,再把 `agent-default-model.provider` 指过去。
 * `model:` 那一行**不碰** —— 用户选的是哪个模型仍然由他自己定,中转把模型名原样透传给上游。
 */
export function settingsForRelay(text: string, options: { baseUrl: string, extraModels?: readonly string[] }): DshSettingsEdit {
  // 没接中转(零服务器档)时调用方拼出来的是 `/v1`:不往 DSH 里写一个连不上的地址。
  if (!/^https?:\/\/[^\s/]+/i.test(options.baseUrl)) {
    return { ok: false, error: '这台没接中转,事务官(DSH)那一侧照旧用你自己的模型密钥。' }
  }
  const before = text
  const current = readAgentDefaultModel(text)
  if (current === undefined) {
    return {
      ok: false,
      error: '事务官(DSH)那一侧还没选过模型,工作台不敢替你猜该用哪个;'
        + '先在它的网页里选一次模型,再回来切换。',
    }
  }
  if (current.model === undefined) {
    return { ok: false, error: '事务官(DSH)那一侧还没选定模型,先在它的网页里选一次,再回来切换。' }
  }

  const lines = splitLines(text)
  const existing = topLevelBlockRange(lines, 'llm-pi-ai')
  if (existing !== undefined) {
    const body = lines.slice(existing.start, existing.end).join('\n')
    if (!body.includes(DSH_MANAGED_MARK)) {
      return {
        ok: false,
        error: '事务官(DSH)那一侧的模型服务是你自己配过的,工作台不动它;'
          + '要让它也走工作台的模型服务,得请人工合一次。',
      }
    }
  }

  // models 至少要包含此刻选中的那个,否则切过去之后 DSH 会说 UNKNOWN_MODEL。
  const models = [...new Set([current.model, ...RELAY_STANDARD_MODELS, ...(options.extraModels ?? [])])]
  const block = relayProviderBlock({ baseUrl: options.baseUrl, models })

  let next: string[]
  if (existing === undefined) {
    next = [...lines]
    // 收尾的空行不要越堆越多。
    while (next.length > 0 && (next.at(-1) as string).trim() === '') next.pop()
    next.push(...splitLines(block))
  }
  else {
    next = [...lines.slice(0, existing.start), ...splitLines(block), ...lines.slice(existing.end)]
  }

  const withProvider = replaceProviderLine(next, DSH_RELAY_PROVIDER)
  if (!withProvider.ok) return withProvider
  return { ok: true, text: joinLines(withProvider.lines), changed: joinLines(withProvider.lines) !== before }
}

/**
 * 切回自己的 Key:把 `provider:` 指回去(默认 `deepseek-official`,或切走之前那一个)。
 * **我们那一段留着不删** —— 删了下次切回来又要重写一遍,而留着的代价只是模型选择器里多一条。
 */
export function settingsForOwnKey(text: string, previousProvider?: string): DshSettingsEdit {
  const lines = splitLines(text)
  if (topLevelBlockRange(lines, 'agent-default-model') === undefined) {
    // 本来就没这一段,那也就没什么可切回去的 —— 不是错误。
    return { ok: true, text, changed: false }
  }
  // workbench-relay / workbench-own 都是我们维护的临时路由:切回「官方」时不能指回一条可能已经不在了的路由。
  const target = previousProvider !== undefined
    && previousProvider !== DSH_RELAY_PROVIDER && previousProvider !== DSH_OWN_PROVIDER
    ? previousProvider
    : DSH_OFFICIAL_PROVIDER
  const replaced = replaceProviderLine(lines, target)
  if (!replaced.ok) return replaced
  return { ok: true, text: joinLines(replaced.lines), changed: joinLines(replaced.lines) !== text }
}

/** own 档那条路由在模型选择器里显示的名字。 */
export const OWN_DISPLAY_NAME = '自己接的模型服务'

/**
 * own 档「自己接的端点」那一段的整段文本(2026-10-23,卡「事务官换Key」)。
 * 与 {@link relayProviderBlock} 同一份规矩:带「是我们写的」标记,整段替换,手改会被下一次切换覆盖。
 * 刻意**不**声明思考档与 DeepSeek 方言 compat —— 那一家端点不一定是 DeepSeek,
 * 发它认不得的参数比不发糟;全局默认本来就不开思考。
 */
export function ownProviderSection(options: { baseUrl: string, model: string }): string {
  return [
    'llm-pi-ai:',
    `  ${DSH_MANAGED_MARK}`,
    '  # 这一段由工作台「设置 → 模型」维护,手改会被下一次切换覆盖。',
    '  providers:',
    `    ${DSH_OWN_PROVIDER}:`,
    `      displayName: ${OWN_DISPLAY_NAME}`,
    '      api: openai-completions',
    `      baseURL: ${options.baseUrl}`,
    `      apiKeyEnv: ${DSH_OWN_KEY_ENV}`,
    '      models:',
    `        - id: ${options.model}`,
  ].join('\n')
}

/**
 * 切到「自己接的端点」(own 档填了 base_url 的那一个,2026-10-23,卡「事务官换Key」):
 * 装上(或更新)workbench-own 那一段,`agent-default-model` 的 provider 与 model 都指过去
 * (地址与模型名是他自己填的,我们照填,不替他猜别的)。
 *
 * 与 settingsForRelay 同几条守门:地址要带协议;他自己配过 llm-pi-ai 就一个字不动;
 * 没有 agent-default-model 就不新建(缺 provider 或 model 那一行也不替他补)。
 * 老的「own = DeepSeek 官方」不走这一条,照旧 settingsForOwnKey。
 */
export function settingsForOwnEndpoint(text: string, options: { baseUrl: string, model: string }): DshSettingsEdit {
  if (!/^https?:\/\/[^\s/]+/i.test(options.baseUrl)) {
    return { ok: false, error: '自己接的模型服务地址要以 http:// 或 https:// 开头,所以这次没能写给事务官(DSH)。' }
  }
  const before = text
  const lines = splitLines(text)
  const existing = topLevelBlockRange(lines, 'llm-pi-ai')
  if (existing !== undefined) {
    const body = lines.slice(existing.start, existing.end).join('\n')
    if (!body.includes(DSH_MANAGED_MARK)) {
      return {
        ok: false,
        error: '事务官(DSH)那一侧的模型服务是你自己配过的,工作台不动它;'
          + '要让它也走你自己接的端点,得请人工合一次。',
      }
    }
  }

  const block = ownProviderSection(options)
  let next: string[]
  if (existing === undefined) {
    next = [...lines]
    while (next.length > 0 && (next.at(-1) as string).trim() === '') next.pop()
    next.push(...splitLines(block))
  }
  else {
    next = [...lines.slice(0, existing.start), ...splitLines(block), ...lines.slice(existing.end)]
  }

  const withProvider = replaceProviderLine(next, DSH_OWN_PROVIDER)
  if (!withProvider.ok) return withProvider
  const withModel = replaceModelLine(withProvider.lines, options.model)
  if (!withModel.ok) return withModel
  return { ok: true, text: joinLines(withModel.lines), changed: joinLines(withModel.lines) !== before }
}

/** 只换 `agent-default-model:` 段里 `model:` 那一行,缩进与其余各行原样。 */
function replaceModelLine(lines: readonly string[], model: string): ProviderLineResult {
  const range = topLevelBlockRange(lines, 'agent-default-model')
  if (range === undefined) {
    return { ok: false, error: '事务官(DSH)那一侧还没选过模型,工作台不替你新建。' }
  }
  const out = [...lines]
  for (let i = range.start + 1; i < range.end; i += 1) {
    const m = /^(\s+model:\s*)(.*)$/.exec(out[i] as string)
    if (m === null) continue
    out[i] = `${m[1] as string}${model}${(m[2] as string).match(/\s+#.*$/)?.[0] ?? ''}`
    return { ok: true, lines: out }
  }
  return { ok: false, error: '事务官(DSH)那一侧的模型设置里缺了一项,工作台不替你补,免得改坏它。' }
}

/**
 * 「地址保持官方、只换模型名」(2026-10-23 退修):不换路由、不碰 Key,
 * provider 照 {@link settingsForOwnKey} 的回滚语义(默认 `deepseek-official`,或切走之前那一个),
 * 只把 `model:` 那一行换成他填的。我们那一段(中转路由)留着不删。
 * 没有 agent-default-model 段时不新建 —— 他在 DSH 网页里还没选过模型,替他选一个比不切更糟。
 */
export function settingsForOwnModel(text: string, previousProvider: string | undefined, model: string): DshSettingsEdit {
  if (!isSafePlainScalarForSettings(model)) {
    return { ok: false, error: '这个模型名里有工作台没法安全写进事务官设置的字符,所以这次没有改它那一侧。' }
  }
  // 没有那一段(或缺 provider 行)就不猜:先跑一遍「切回自己的 Key」拿它的守门与回滚。
  const back = settingsForOwnKey(text, previousProvider)
  if (!back.ok) return back
  const lines = splitLines(back.text)
  if (topLevelBlockRange(lines, 'agent-default-model') === undefined) {
    return { ok: false, error: '事务官(DSH)那一侧还没选过模型,工作台不敢替你新建。' }
  }
  const replaced = replaceModelLine(lines, model)
  if (!replaced.ok) return replaced
  return { ok: true, text: joinLines(replaced.lines), changed: joinLines(replaced.lines) !== text }
}

/** settings.yaml 这一代的值安检(与补丁层 isSafePlainScalar 同规矩,拒写不硬塞)。 */
function isSafePlainScalarForSettings(value: string): boolean {
  if (value === '' || /[\n\t\r]/.test(value)) return false
  if (value !== value.trim()) return false
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return false
  return !value.includes(': ') && !/\s#/.test(value) && !value.endsWith(':')
}

type ProviderLineResult = { ok: true, lines: string[] } | { ok: false, error: string }

/** 只换 `agent-default-model:` 段里 `provider:` 那一行,缩进与其余各行原样。 */
function replaceProviderLine(lines: readonly string[], provider: string): ProviderLineResult {
  const range = topLevelBlockRange(lines, 'agent-default-model')
  if (range === undefined) {
    return { ok: false, error: '事务官(DSH)那一侧还没选过模型,工作台不替你新建。' }
  }
  const out = [...lines]
  for (let i = range.start + 1; i < range.end; i += 1) {
    const m = /^(\s+provider:\s*)(.*)$/.exec(out[i] as string)
    if (m === null) continue
    out[i] = `${m[1]}${provider}`
    return { ok: true, lines: out }
  }
  return { ok: false, error: '事务官(DSH)那一侧的模型设置里缺了一项,工作台不替你补,免得改坏它。' }
}

/**
 * `.env` 的行级改写。已有同名的换值,没有的追加到末尾;**其余行一个字节不动**。
 * 值里出现空白或 `#` 时加引号(DSH 用 node 的 `util.parseEnv` 解析,引号它认)。
 */
export function upsertEnvLine(text: string, name: string, value: string): string {
  const quoted = /[\s#'"]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value
  const lines = text === '' ? [] : splitLines(text)
  const index = lines.findIndex(line => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(line))
  if (index === -1) {
    const out = [...lines]
    while (out.length > 0 && (out.at(-1) as string).trim() === '') out.pop()
    out.push(`${name}=${quoted}`)
    return joinLines(out)
  }
  const out = [...lines]
  out[index] = `${name}=${quoted}`
  return joinLines(out)
}

/** 从 `.env` 文本里去掉一行(切回自己的 Key 时把令牌收走)。找不到就原样返回。 */
export function removeEnvLine(text: string, name: string): string {
  if (text === '') return text
  const lines = splitLines(text)
  const kept = lines.filter(line => !new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(line))
  return kept.length === lines.length ? text : joinLines(kept)
}
