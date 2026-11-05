/**
 * DSH 0.1.7 起「模型设置住在 profile 的补丁层里」的读写(2026-09-26,卡 U1b)。
 *
 * ## 为什么要这一份
 *
 * 0.1.7 **删掉了 `settings.yaml` 这个文件**:每次启动只要看见它,就先改名成 `settings.yaml.imported`,
 * 再把里面每个顶层段写进**当前 profile 的 `cordis.patch.yml`**(上游
 * `packages/settings/settings/src/index.ts` 的 `importLegacyDocument()` → `configEditor.edit()`)。
 * 我们的 `agent-default-model` 与 `llm-pi-ai` 两段就这么搬了家 —— 于是「切到中转」「下发令牌」
 * 「读当前模型」三件事都要改成读写这里。哪一代运行时该读哪儿由 `dshSettingsStore.ts` 判,
 * 这一份只管「补丁层这一代怎么读怎么写」(纯函数,可测)。
 *
 * ## 补丁层的语义(逐条从上游代码核过,不是猜的)
 *
 * 文件是**一个 YAML 数组**,每一项是一行补丁。上游 `cordis-plugin-include` 的 `applyEntryPatches`:
 *
 * ```js
 * for (const [key, value] of Object.entries(overrides)) target[key] = value
 * ```
 *
 * —— 也就是**按 id 整体替换该行的 config**,不是深合并。三个直接后果,这份代码全靠它们成立:
 *
 * 1. 写 `- id: agent-default-model` 的 config 时**必须同时写 provider 与 model**。上游
 *    `dsh-agent-default-model` 的 schema 里这两个字段都是必填(`volatile-defined`,没有默认值),
 *    只写一个 = 组合起不来。所以「没写过 model」时要补一个,补的是**中转认的那个 id**
 *    (`SEEDED_DEFAULT_MODEL`)而不是上游缺省的 `deepseek-flash` —— 理由见 setup/paths.ts。
 * 2. 写 `name:` 有风险、不写没有:`applyEntryPatches` 见到 `name` 与目标不一致就**整行跳过**
 *    (只在日志里 warn)。写错一个字的后果是"界面上一切正常、DSH 那侧一个字没改",
 *    这是最难查的一种。少写 `name` 不会被跳过(上游自己找行时写的是 `!item.has('name') || 相等`),
 *    所以**我们新建的行一律不写 `name`**;已经在那儿的行(上游/迁移写的)带着 `name`,我们原样留着。
 * 3. `llm-pi-ai` 的 config 只有一个顶层键 `providers`(上游
 *    `Config = z.object({ providers: z.dict(profile).default({}).volatile() })`)。
 *    所以「这一段是不是我们写的」不靠注释记号认(上游改配置时会把 config 里的注释重建掉),
 *    而是看 `providers` 底下**是不是只有 `workbench-relay` 这一个路由**。多一个我们就不动手。
 *
 * ## 写坏一个字符,DSH 整个起不来
 *
 * 所以这一份的每一次写入都有三道:
 *
 * - **认不得就不写**:制表符、多文档分隔、顶层不是数组、行内 `config: {…}`、缩进不像样 ——
 *   一律 `ok: false` 并说人话。宁可"这次没跟着切",不可写出一个起不来的补丁层。
 * - **值不安全就不写**:模型 id / 路由名 / 地址里出现会破坏纯量的字符(`: `、` #`、换行、
 *   以 YAML 指示符开头)时拒写,不硬塞引号。
 * - **写完自己再核一遍**:新文本仍然认得、自己那两行读回来**就是**打算写进去的、
 *   **别人的每一行逐字节相同**。任一条不过就当没写过。
 *
 * 备份、落盘、判哪一代,都在 `dshSettingsStore.ts`。
 */
import {
  DSH_OFFICIAL_PROVIDER, DSH_OWN_KEY_ENV, DSH_OWN_PROVIDER, DSH_RELAY_PROVIDER, DSH_RELAY_TOKEN_ENV,
  OWN_DISPLAY_NAME,
  RELAY_COMPAT, RELAY_STANDARD_MODELS, relayModelFieldLines, relayModelSpec, relayThinkingLevels,
  type DshSettingsEdit,
} from './dshModelSettings.ts'
import { DSH_UPSTREAM_DEFAULT_MODEL, SEEDED_DEFAULT_MODEL } from './setup/paths.ts'

/** 补丁层里那两行的 id(上游 `packages/bundle/base/cordis.patch.yml` 的原名)。 */
export const PATCH_DEFAULT_MODEL_ID = 'agent-default-model'
export const PATCH_RELAY_PLUGIN_ID = 'llm-pi-ai'

/** 我们自己写出来的那几层缩进(读的时候是**现算**的,只有新建的块用这几个)。 */
const ROW_KEY_INDENT = 2
const CONFIG_INDENT = 4
const PROVIDERS_INDENT = 6
const PROVIDER_INDENT = 8
const MODEL_ITEM_INDENT = 10
const MODEL_FIELD_INDENT = 12

/** 没写过 model 时补哪个、切回自己的 Key 时退回哪儿。两个常量都在 setup/paths.ts 里有出处。 */
export interface PatchModelDefaults {
  /** 补丁里还没写过 model 时用的那个 id(必须是中转真的认的)。 */
  relayModel: string
  /** 上游缺省(`@deepseek-ai/dsh-base` 的 `agent-default-model` 那一项)。 */
  upstream: { provider: string, model: string }
}

export const PATCH_MODEL_DEFAULTS: PatchModelDefaults = {
  relayModel: SEEDED_DEFAULT_MODEL,
  upstream: { provider: DSH_UPSTREAM_DEFAULT_MODEL.provider, model: DSH_UPSTREAM_DEFAULT_MODEL.model },
}

/** 界面上说的那一句。**不出现文件名** —— 用户不知道 cordis.patch.yml 是什么,也不该知道。 */
const UNREADABLE = '事务官(DSH)那一侧的设置是手工改过的,工作台认不出它的写法,所以一个字都没敢动。'
const UNSAFE_VALUE = '这个模型名里有工作台没法安全写进事务官设置的字符,所以这次没有改它那一侧。'
const NOT_OURS = '事务官(DSH)那一侧的模型服务是你自己配过的,工作台不动它;要让它也走工作台的模型服务,得请人工合一次。'
const VERIFY_FAILED = '工作台改完之后自己核了一遍,发现改得不对,所以整件都没写 —— 事务官那一侧还是原来的样子。'

/** 一行补丁。`end` 不含尾随的空行与注释行(注释留在行与行的缝里,谁都不算)。 */
export interface PatchRow {
  start: number
  end: number
  id?: string
  insert: boolean
}

export type ProfilePatchDoc =
  | { ok: true, lines: string[], rows: PatchRow[], /** 上游空模板那一行 `[]` 在第几行。 */ emptyLine?: number }
  | { ok: false, error: string }

/** 行首缩进宽度。 */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isSkippable(line: string): boolean {
  return line.trim() === '' || /^\s*#/.test(line)
}

/**
 * 认一遍整份补丁层。**只认我们真的看得懂的那个方言** —— 看不懂一律 `ok: false`,
 * 上层据此不写。这是「写坏一个字符 DSH 起不来」的第一道。
 */
export function parseProfilePatch(text: string): ProfilePatchDoc {
  if (text.includes('\t')) return { ok: false, error: UNREADABLE }
  const lines = text.split('\n')
  const starts: number[] = []
  const inlineMappings: number[] = []
  let emptyLine: number | undefined
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    if (isSkippable(line)) continue
    if (/^(---|\.\.\.)/.test(line)) return { ok: false, error: UNREADABLE }
    // 正式 editor 会把空 providers 写成 {}；等行与 config 层级确定后只放行这一种空映射。
    if (/^\s*(- )?[^\s#][^:]*:\s*\{/.test(line)) inlineMappings.push(i)
    if (indentOf(line) > 0) {
      // 缩进行只能出现在某一行补丁的内部。
      if (starts.length === 0) return { ok: false, error: UNREADABLE }
      continue
    }
    if (line.trimEnd() === '[]') {
      // 上游建 profile 时写的那份空模板。它与真的补丁行不能同时存在。
      if (starts.length > 0) return { ok: false, error: UNREADABLE }
      emptyLine = i
      continue
    }
    if (!line.startsWith('- ') || emptyLine !== undefined) return { ok: false, error: UNREADABLE }
    starts.push(i)
  }

  const rows: PatchRow[] = []
  for (let n = 0; n < starts.length; n += 1) {
    const start = starts[n] as number
    let end = n + 1 < starts.length ? starts[n + 1] as number : lines.length
    while (end > start + 1 && isSkippable(lines[end - 1] as string)) end -= 1
    const first = (lines[start] as string).slice(2)
    if (!/^[A-Za-z0-9_-]+:/.test(first)) return { ok: false, error: UNREADABLE }
    for (let i = start + 1; i < end; i += 1) {
      const line = lines[i] as string
      if (isSkippable(line)) continue
      const indent = indentOf(line)
      if (indent < ROW_KEY_INDENT) return { ok: false, error: UNREADABLE }
      if (indent > ROW_KEY_INDENT) continue
      // 补丁行自己的键那一层:要么是 `键:`,要么是上一个键的数组项 `- …`。
      if (!/^ {2}([A-Za-z0-9_-]+:|- )/.test(line)) return { ok: false, error: UNREADABLE }
    }
    const row: PatchRow = { start, end, insert: false }
    const keys = rowKeys(lines, row)
    const insert = keys.find(one => one.key === 'insert')
    if (insert !== undefined) row.insert = true
    const id = keys.find(one => one.key === 'id')
    if (id !== undefined) {
      const scalar = splitScalar(id.raw)
      if (scalar.value !== '') row.id = scalar.value
    }
    rows.push(row)
    for (const index of inlineMappings.filter(i => i >= start && i < end)) {
      const block = configBlockOf(lines, row).block
      const key = block?.children.find(one => one.index === index && one.key === 'providers')
      if (row.id !== PATCH_RELAY_PLUGIN_ID || row.insert || key === undefined || block?.childIndent === undefined
        || keys.filter(one => one.key === 'id').length !== 1 || keys.filter(one => one.key === 'config').length !== 1
        || block.children.length !== 1 || block.strange > 0 || splitScalar(key.raw).value !== '{}'
        || blockAt(lines, index, block.childIndent, block.end).childIndent !== undefined) {
        return { ok: false, error: UNREADABLE }
      }
    }
  }
  return emptyLine === undefined ? { ok: true, lines, rows } : { ok: true, lines, rows, emptyLine }
}

interface KeyLine {
  index: number
  key: string
  /** `键:` 后面那一截原文(还没切注释、没去引号)。 */
  raw: string
}

/** 一行补丁自己那一层的键(第一行的 `- id: x` 也算 —— 它就是缩进 2 的第一个键)。 */
function rowKeys(lines: readonly string[], row: PatchRow): KeyLine[] {
  const out: KeyLine[] = []
  const first = /^([A-Za-z0-9_-]+):(.*)$/.exec((lines[row.start] as string).slice(2))
  if (first !== null) out.push({ index: row.start, key: first[1] as string, raw: first[2] as string })
  for (let i = row.start + 1; i < row.end; i += 1) {
    const m = /^ {2}([A-Za-z0-9_-]+):(.*)$/.exec(lines[i] as string)
    if (m !== null) out.push({ index: i, key: m[1] as string, raw: m[2] as string })
  }
  return out
}

/**
 * 一个「键:」底下那一块的范围与它孩子们的缩进。**缩进是现算的**,不假定上游写成几格 ——
 * 上游用的是 `yaml` 库、我们用的是行级手术,两边的落笔宽度不保证永远一致。
 */
interface Block {
  /** 孩子们所在的缩进(块是空的时候 undefined)。 */
  childIndent?: number
  /** 块的行区间 `[from, end)`,不含尾随空行与注释。 */
  from: number
  end: number
  children: KeyLine[]
  /**
   * 孩子那一层里**不像「键:」的行**有几条(数组项 `- …`、续行、看不懂的写法)。
   * 判「这一段是不是我们写的」时要看这个数:键名可以是中文,`[A-Za-z0-9_-]` 那种窄正则
   * 会把 `别的键: 1` 直接漏掉,于是"多出来的键"被当成没有 —— 那正是会让我们去覆盖
   * 他自己配的东西的那种漏。
   */
  strange: number
}

function blockAt(lines: readonly string[], header: number, headerIndent: number, limit: number): Block {
  const from = header + 1
  let end = from
  let childIndent: number | undefined
  for (let i = from; i < limit; i += 1) {
    const line = lines[i] as string
    if (isSkippable(line)) continue
    if (indentOf(line) <= headerIndent) break
    if (childIndent === undefined) childIndent = indentOf(line)
    end = i + 1
  }
  const children: KeyLine[] = []
  let strange = 0
  if (childIndent !== undefined) {
    const key = new RegExp(`^ {${String(childIndent)}}([^\\s#][^:]*):(.*)$`)
    for (let i = from; i < end; i += 1) {
      const line = lines[i] as string
      if (isSkippable(line) || indentOf(line) !== childIndent) continue
      const m = key.exec(line)
      if (m === null) strange += 1
      else children.push({ index: i, key: m[1] as string, raw: m[2] as string })
    }
  }
  return childIndent === undefined
    ? { from, end, children, strange }
    : { childIndent, from, end, children, strange }
}

interface Scalar {
  value: string
  /** 行尾那一截(注释等),写回时原样留着。 */
  tail: string
}

/**
 * 把「键:」后面那一截切成值与行尾。
 * YAML 里只有**空白后面**的 `#` 才是注释(`a#b` 是字面量的一部分),引号里的 `#` 也不是。
 */
function splitScalar(raw: string): Scalar {
  const body = raw.replace(/^[ ]+/, '')
  if (body.startsWith("'") || body.startsWith('"')) {
    const quote = body[0] as string
    const close = body.indexOf(quote, 1)
    if (close !== -1) return { value: body.slice(1, close), tail: body.slice(close + 1) }
  }
  const at = body.search(/\s+#/)
  if (at === -1) return { value: body.trimEnd(), tail: '' }
  return { value: body.slice(0, at).trimEnd(), tail: body.slice(at) }
}

/**
 * 这个值能不能当**纯量**原样写进 YAML。不能就拒写,不硬塞引号 —— 加引号要跟着处理转义,
 * 而这份代码的每一次落笔都要能在出错时说"我什么都没写"。
 */
function isSafePlainScalar(value: string): boolean {
  if (value === '' || /[\n\t\r]/.test(value)) return false
  if (value !== value.trim()) return false
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return false
  return !value.includes(': ') && !/\s#/.test(value) && !value.endsWith(':')
}

/** 找按 id 该动的那一行:非 insert、同 id 的**最后一行**(与上游 `findLastIndex` 同一条规矩)。 */
function rowOf(rows: readonly PatchRow[], id: string): PatchRow | undefined {
  return [...rows].reverse().find(row => row.id === id && !row.insert)
}

/** 一行补丁的 `config:` 那一块。没有那个键时 `header` 是 undefined;行内写法一律不认。 */
function configBlockOf(lines: readonly string[], row: PatchRow): { header?: number, block?: Block, inline: boolean } {
  const key = rowKeys(lines, row).find(one => one.key === 'config')
  if (key === undefined) return { inline: false }
  if (splitScalar(key.raw).value !== '') return { inline: true }
  return { header: key.index, block: blockAt(lines, key.index, ROW_KEY_INDENT, row.end), inline: false }
}

/** 读 patch 里 `agent-default-model` 那一行写着什么。没有那一行 = 还没人写过(回 undefined)。 */
export function readPatchDefaultModel(
  text: string,
): { provider?: string, model?: string, reasoningEffort?: string } | undefined {
  const doc = parseProfilePatch(text)
  if (!doc.ok) return undefined
  const row = rowOf(doc.rows, PATCH_DEFAULT_MODEL_ID)
  if (row === undefined) return undefined
  const config = configBlockOf(doc.lines, row)
  if (config.block === undefined) return {}
  const out: { provider?: string, model?: string, reasoningEffort?: string } = {}
  for (const child of config.block.children) {
    const scalar = splitScalar(child.raw).value
    if (scalar === '') continue
    if (child.key === 'provider') out.provider = scalar
    else if (child.key === 'model') out.model = scalar
    else if (child.key === 'reasoningEffort') out.reasoningEffort = scalar
  }
  return out
}

/** 在线 editor 已证明与继承层完全相同的 provider，先从受管文本视图略去。
 * 只供原纯函数守门使用；最终完整 raw 写回仍保留这些原值。未知/改过的 provider 不略去。
 */
export function withoutInheritedProviders(text: string, names: readonly string[]): string {
  const doc = parseProfilePatch(text)
  if (!doc.ok) return text
  const row = rowOf(doc.rows, PATCH_RELAY_PLUGIN_ID)
  if (row === undefined) return text
  const config = configBlockOf(doc.lines, row)
  if (config.block?.childIndent === undefined) return text
  const key = config.block.children.find(one => one.key === 'providers')
  if (key === undefined) return text
  const providers = blockAt(doc.lines, key.index, config.block.childIndent, config.block.end)
  if (providers.childIndent === undefined) return text
  const lines = [...doc.lines]
  for (const child of [...providers.children].reverse()) {
    if (!names.includes(child.key)) continue
    const body = blockAt(doc.lines, child.index, providers.childIndent, providers.end)
    lines.splice(child.index, body.end - child.index)
  }
  return joinLines(lines)
}

/**
 * 一条模型登记项里 `reasoningEfforts:` 底下的键(按出现顺序)。没有那个键回 undefined。
 * `off:` 那一档值是空的 —— 只看键名,不看值(值是线上的拼法,少一个字也算不齐,由 compat 那一层兜)。
 */
function thinkingLevelKeys(body: readonly string[]): string[] | undefined {
  const at = body.findIndex(line => /^\s*reasoningEfforts:\s*$/.test(line))
  if (at === -1) return undefined
  const indent = (body[at] as string).search(/\S/)
  const out: string[] = []
  for (let i = at + 1; i < body.length; i += 1) {
    const line = body[i] as string
    if (line.trim() === '') continue
    const here = line.search(/\S/)
    if (here <= indent) break
    const m = /^\s*([A-Za-z0-9_-]+):/.exec(line)
    if (m === null) break
    out.push(m[1] as string)
  }
  return out
}

export type PatchRelayRead =
  | { ok: true, found: false }
  | {
    ok: true
    found: true
    baseUrl?: string
    models: string[]
    /** 登记时声明了能收图的那几个(`input` 里有 image)。 */
    imageModels?: string[]
    /** 每个模型登记了哪几档思考(`reasoningEfforts:` 底下的键,2026-09-28 卡 BS)。没登记的不出现。 */
    thinkingLevels?: Record<string, string[]>
    /** provider 级 `compat:` 底下那几个键值(读到什么记什么,判「要不要重写」时比它)。 */
    compat?: Record<string, string>
    api?: string
    apiKeyEnv?: string
    displayName?: string
  }
  | { ok: false, error: string }

/**
 * 读 patch 里我们维护的路由。
 *
 * 「是不是我们的」= `providers` 底下**只有 `workbench-relay` / `workbench-own` 这两个我们维护的名字**,
 * 而且 config 里除了 `providers` 没有别的键。多一样(他自己配过)就回 `ok: false` ——
 * 与 settings.yaml 那一代同一条规矩,只是判据从"段内注释记号"换成了结构本身
 * (上游改配置会把 config 里的注释重建掉,记号留不住)。
 *
 * 2026-10-23(卡「事务官换Key」)起这一段可能是 workbench-own(他自己接的端点):
 * 那一支对「中转」这条路来说等于「还没配过」(`found: false`,不是错),见 {@link readPatchOwnProvider}。
 */
export function readPatchRelayProvider(text: string): PatchRelayRead {
  const doc = parseProfilePatch(text)
  if (!doc.ok) return { ok: false, error: doc.error }
  const row = rowOf(doc.rows, PATCH_RELAY_PLUGIN_ID)
  if (row === undefined) return { ok: true, found: false }
  const config = configBlockOf(doc.lines, row)
  if (config.inline) return { ok: false, error: UNREADABLE }
  if (config.block === undefined || config.block.childIndent === undefined) return { ok: true, found: false }
  const others = config.block.children.filter(one => one.key !== 'providers')
  if (others.length > 0 || config.block.strange > 0) return { ok: false, error: NOT_OURS }
  const providersKey = config.block.children.find(one => one.key === 'providers')
  if (providersKey === undefined) return { ok: false, error: NOT_OURS }
  const providers = blockAt(doc.lines, providersKey.index, config.block.childIndent, config.block.end)
  if (providers.strange > 0) return { ok: false, error: NOT_OURS }
  const keys = providers.children.map(one => one.key)
  if (keys.some(one => one !== DSH_RELAY_PROVIDER && one !== DSH_OWN_PROVIDER)) return { ok: false, error: NOT_OURS }
  const relayLine = providers.children.find(one => one.key === DSH_RELAY_PROVIDER)
  if (relayLine === undefined) return { ok: true, found: false }
  const ours = relayLine
  const providerIndent = providers.childIndent as number
  const fields = blockAt(doc.lines, ours.index, providerIndent, providers.end)
  const field = (key: string): string | undefined => {
    const line = fields.children.find(one => one.key === key)
    return line === undefined ? undefined : splitScalar(line.raw).value
  }
  /** provider 级 `compat:` 底下那几个键值(2026-09-28 卡 BS:思考开关就挂在这儿)。 */
  const compat: Record<string, string> = {}
  const compatKey = fields.children.find(one => one.key === 'compat')
  if (compatKey !== undefined && fields.childIndent !== undefined) {
    const block = blockAt(doc.lines, compatKey.index, fields.childIndent, fields.end)
    for (const child of block.children) {
      const scalar = splitScalar(child.raw).value
      if (scalar !== '') compat[child.key] = scalar
    }
  }
  const modelsKey = fields.children.find(one => one.key === 'models')
  const models: string[] = []
  const imageModels: string[] = []
  const thinkingLevels: Record<string, string[]> = {}
  if (modelsKey !== undefined && fields.childIndent !== undefined) {
    const list = blockAt(doc.lines, modelsKey.index, fields.childIndent, fields.end)
    if (list.childIndent !== undefined) {
      const item = new RegExp(`^ {${String(list.childIndent)}}- id:(.*)$`)
      let open: string | undefined
      let body: string[] = []
      /**
       * 一条登记项**说没说自己能收图**。写法有两种,两种都要认:我们自己写的是行内
       * `input: [text, image]`,而**上游的 `yaml` 库写的是块式**(`input:` 换行后 `- text` / `- image`)
       * —— 0.1.7 把 `settings.yaml` 收进补丁层时、以及它自己的模型页改配置时,落笔都是块式。
       * 认死一种的后果:每次切换都把语义相同的一段重写一遍(白写一次、多一份备份)。
       */
      const settle = (): void => {
        if (open === undefined) return
        const text = body.join('\n')
        if (/(^|[\s,[])image([\s,\]]|$)/.test(text)) imageModels.push(open)
        // 这条登记项声明了哪几档思考(2026-09-28 卡 BS)。档是**按模型**给的(pro 没有 low),
        // 所以记的是键名而不是"有没有声明" —— 判要不要重写时要逐档比。
        const levels = thinkingLevelKeys(body)
        if (levels !== undefined) thinkingLevels[open] = levels
        open = undefined
        body = []
      }
      for (let i = list.from; i < list.end; i += 1) {
        const line = doc.lines[i] as string
        const m = item.exec(line)
        if (m !== null) {
          settle()
          const id = splitScalar(m[1] as string).value
          if (id !== '') { models.push(id); open = id }
          continue
        }
        if (open !== undefined) body.push(line)
      }
      settle()
    }
  }
  const api = field('api')
  const apiKeyEnv = field('apiKeyEnv')
  const displayName = field('displayName')
  const baseUrl = field('baseURL')
  return {
    ok: true, found: true, models, imageModels, thinkingLevels, compat,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(api === undefined ? {} : { api }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(displayName === undefined ? {} : { displayName }),
  }
}

export type PatchOwnRead =
  | { ok: true, found: false }
  | { ok: true, found: true, baseUrl: string, model: string }
  | { ok: false, error: string }

/**
 * 读 patch 里 workbench-own 那一段(2026-10-23,卡「事务官换Key」):他自己接的端点的地址与模型名。
 * 「是不是我们的」与 {@link readPatchRelayProvider} 同一条规矩(providers 里只有我们维护的名字);
 * 他自己配过别人的路由就回 `ok: false`,那一段没配过回 `found: false`。
 */
export function readPatchOwnProvider(text: string): PatchOwnRead {
  const doc = parseProfilePatch(text)
  if (!doc.ok) return { ok: false, error: doc.error }
  const row = rowOf(doc.rows, PATCH_RELAY_PLUGIN_ID)
  if (row === undefined) return { ok: true, found: false }
  const config = configBlockOf(doc.lines, row)
  if (config.inline) return { ok: false, error: UNREADABLE }
  if (config.block === undefined || config.block.childIndent === undefined) return { ok: true, found: false }
  const others = config.block.children.filter(one => one.key !== 'providers')
  if (others.length > 0 || config.block.strange > 0) return { ok: false, error: NOT_OURS }
  const providersKey = config.block.children.find(one => one.key === 'providers')
  if (providersKey === undefined) return { ok: false, error: NOT_OURS }
  const providers = blockAt(doc.lines, providersKey.index, config.block.childIndent, config.block.end)
  if (providers.strange > 0) return { ok: false, error: NOT_OURS }
  const keys = providers.children.map(one => one.key)
  if (keys.some(one => one !== DSH_RELAY_PROVIDER && one !== DSH_OWN_PROVIDER)) return { ok: false, error: NOT_OURS }
  const ownLine = providers.children.find(one => one.key === DSH_OWN_PROVIDER)
  if (ownLine === undefined) return { ok: true, found: false }
  const fields = blockAt(doc.lines, ownLine.index, providers.childIndent as number, providers.end)
  const field = (key: string): string | undefined => {
    const line = fields.children.find(one => one.key === key)
    return line === undefined ? undefined : splitScalar(line.raw).value
  }
  const baseUrl = field('baseURL')
  const modelsKey = fields.children.find(one => one.key === 'models')
  let model: string | undefined
  if (modelsKey !== undefined && fields.childIndent !== undefined) {
    const list = blockAt(doc.lines, modelsKey.index, fields.childIndent, fields.end)
    if (list.childIndent !== undefined) {
      const item = new RegExp(`^ {${String(list.childIndent)}}- id:(.*)$`)
      for (let i = list.from; i < list.end; i += 1) {
        const m = item.exec(doc.lines[i] as string)
        if (m === null) continue
        const id = splitScalar(m[1] as string).value
        if (id !== '') { model = id; break }
      }
    }
  }
  if (baseUrl === undefined || model === undefined) return { ok: false, error: VERIFY_FAILED }
  return { ok: true, found: true, baseUrl, model }
}

/** 我们那一段的固定值(两处用:落笔时写它,判"要不要重写"时比它)。 */
const RELAY_API = 'openai-completions'
const RELAY_DISPLAY_NAME = '工作台提供的模型服务'

/**
 * 补丁层里那一段**语义上已经就是我们要写的那一段**吗?是就一个字都不改。
 *
 * 为什么要这一步而不是直接比文本:同一份配置有两种落笔方式(我们写行内 `input: [text, image]`,
 * 上游的 `yaml` 库写块式),比文本会在**升级那一刻**把语义相同的一段重写一遍 ——
 * 卡 U1b 的要求原话是"升级那一刻不重复写"。
 */
function relayBlockMatches(read: PatchRelayRead, intended: { baseUrl: string, models: readonly string[] }): boolean {
  if (!read.ok || !read.found) return false
  if (read.baseUrl !== intended.baseUrl) return false
  if (read.api !== RELAY_API || read.apiKeyEnv !== DSH_RELAY_TOKEN_ENV) return false
  if (read.displayName !== RELAY_DISPLAY_NAME) return false
  if (read.models.join(',') !== [...intended.models].join(',')) return false
  const want = intended.models.filter(id => relayModelSpec(id).images).join(',')
  if ((read.imageModels ?? []).join(',') !== want) return false
  // 思考开关那几行也要齐(2026-09-28 卡 BS):少一档就重写一次,这样老机器开机那一下会自己补上。
  // 逐个模型比档(pro 没有 low),所以不是"有没有声明"而是"声明的是不是正好这几档"。
  const levels = read.thinkingLevels ?? {}
  for (const id of intended.models) {
    const want = relayThinkingLevels(id).map(one => one.level).join(',')
    if ((levels[id] ?? []).join(',') !== want) return false
  }
  const compat = read.compat ?? {}
  if (Object.keys(compat).length !== RELAY_COMPAT.length) return false
  return RELAY_COMPAT.every(one => compat[one.key] === one.value)
}

/** 我们那条路由在补丁层里的 config 那一块(`config:` 下面那几行)。 */
function relayConfigLines(options: { baseUrl: string, models: readonly string[] }): string[] {
  const models = options.models.length === 0 ? [PATCH_MODEL_DEFAULTS.relayModel] : options.models
  const pad = (n: number): string => ' '.repeat(n)
  return [
    `${pad(CONFIG_INDENT)}providers:`,
    `${pad(PROVIDERS_INDENT)}${DSH_RELAY_PROVIDER}:`,
    `${pad(PROVIDER_INDENT)}displayName: ${RELAY_DISPLAY_NAME}`,
    `${pad(PROVIDER_INDENT)}api: ${RELAY_API}`,
    `${pad(PROVIDER_INDENT)}baseURL: ${options.baseUrl}`,
    `${pad(PROVIDER_INDENT)}apiKeyEnv: ${DSH_RELAY_TOKEN_ENV}`,
    // 思考开关(2026-09-28,卡 BS):为什么非要这几行才关得掉,见 dshModelSettings 的 RELAY_THINKING_LEVELS。
    `${pad(PROVIDER_INDENT)}compat:`,
    ...RELAY_COMPAT.map(one => `${pad(PROVIDER_INDENT + 2)}${one.key}: ${one.value}`),
    `${pad(PROVIDER_INDENT)}models:`,
    ...models.flatMap(id => [
      `${pad(MODEL_ITEM_INDENT)}- id: ${id}`,
      ...relayModelFieldLines(id, pad(MODEL_FIELD_INDENT)),
    ]),
  ]
}

/** workbench-own 那一段在补丁层里的 config 那一块(2026-10-23,卡「事务官换Key」)。 */
function ownConfigLines(options: { baseUrl: string, model: string }): string[] {
  const pad = (n: number): string => ' '.repeat(n)
  return [
    `${pad(CONFIG_INDENT)}providers:`,
    `${pad(PROVIDERS_INDENT)}${DSH_OWN_PROVIDER}:`,
    `${pad(PROVIDER_INDENT)}displayName: ${OWN_DISPLAY_NAME}`,
    `${pad(PROVIDER_INDENT)}api: ${RELAY_API}`,
    `${pad(PROVIDER_INDENT)}baseURL: ${options.baseUrl}`,
    `${pad(PROVIDER_INDENT)}apiKeyEnv: ${DSH_OWN_KEY_ENV}`,
    `${pad(PROVIDER_INDENT)}models:`,
    `${pad(MODEL_ITEM_INDENT)}- id: ${options.model}`,
  ]
}

/** workbench-own 那一段**语义上已经就是我们要写的那一段**吗(同 relayBlockMatches 的道理)。 */
function ownBlockMatches(read: PatchOwnRead, intended: { baseUrl: string, model: string }): boolean {
  return read.ok && read.found && read.baseUrl === intended.baseUrl && read.model === intended.model
}

function joinLines(lines: readonly string[]): string {
  const out = lines.join('\n')
  return out.endsWith('\n') ? out : `${out}\n`
}

/** 往文档末尾加一行补丁(带一行给人看的注释)。`[]` 那份空模板要先让位。 */
function appendRow(doc: { lines: readonly string[], emptyLine?: number }, comment: string, row: readonly string[]): string[] {
  const lines = [...doc.lines]
  if (doc.emptyLine !== undefined) lines.splice(doc.emptyLine, 1)
  while (lines.length > 0 && (lines.at(-1) as string).trim() === '') lines.pop()
  return [...lines, '', comment, ...row]
}

/** 替换某一行补丁的整块 config(没有 `config:` 这个键就补一个)。 */
function withConfigBlock(lines: readonly string[], row: PatchRow, configLines: readonly string[]): string[] {
  const config = configBlockOf(lines, row)
  if (config.header === undefined) {
    return [...lines.slice(0, row.end), `${' '.repeat(ROW_KEY_INDENT)}config:`, ...configLines, ...lines.slice(row.end)]
  }
  const block = config.block as Block
  return [
    ...lines.slice(0, config.header + 1),
    ...configLines,
    ...lines.slice(block.end),
  ]
}

/** 改某一行补丁 config 里的一个纯量(没有就补在块的最前面;缩进随现有的孩子)。 */
function withConfigScalar(lines: readonly string[], row: PatchRow, key: string, value: string): string[] {
  const config = configBlockOf(lines, row)
  const block = config.block
  if (config.header === undefined || block === undefined) return lines as string[]
  const indent = block.childIndent ?? CONFIG_INDENT
  const existing = block.children.find(one => one.key === key)
  const out = [...lines]
  if (existing === undefined) {
    out.splice(config.header + 1, 0, `${' '.repeat(indent)}${key}: ${value}`)
    return out
  }
  out[existing.index] = `${' '.repeat(indent)}${key}: ${value}${splitScalar(existing.raw).tail}`
  return out
}

/** 每一行补丁的「指纹」:用来证明**别人的行一个字节都没动**。 */
function rowSignatures(text: string): { key: string, text: string }[] | undefined {
  const doc = parseProfilePatch(text)
  if (!doc.ok) return undefined
  return doc.rows.map((row, index) => ({
    key: row.id ?? `#${String(index)}`,
    text: doc.lines.slice(row.start, row.end).join('\n'),
  }))
}

/**
 * 写完自己核一遍。三条都过才算这次写入成立:文档仍然认得、自己那两行读回来就是打算写的、
 * **除了那两个 id,每一行补丁逐字节相同**。任一条不过,上层当这次没写过。
 */
function verified(before: string, after: string, intent: {
  model?: { provider: string, model: string }
  relay?: { baseUrl: string, models: readonly string[] }
  own?: { baseUrl: string, model: string }
}): string | undefined {
  if (!parseProfilePatch(after).ok) return VERIFY_FAILED
  if (intent.model !== undefined) {
    const got = readPatchDefaultModel(after)
    if (got?.provider !== intent.model.provider || got.model !== intent.model.model) return VERIFY_FAILED
  }
  if (intent.relay !== undefined) {
    const got = readPatchRelayProvider(after)
    if (!got.ok || !got.found) return VERIFY_FAILED
    if (got.baseUrl !== intent.relay.baseUrl) return VERIFY_FAILED
    if (got.models.join(',') !== [...intent.relay.models].join(',')) return VERIFY_FAILED
  }
  if (intent.own !== undefined) {
    const got = readPatchOwnProvider(after)
    if (!got.ok || !got.found) return VERIFY_FAILED
    if (got.baseUrl !== intent.own.baseUrl || got.model !== intent.own.model) return VERIFY_FAILED
  }
  const ours = new Set([PATCH_DEFAULT_MODEL_ID, PATCH_RELAY_PLUGIN_ID])
  const left = rowSignatures(before)?.filter(one => !ours.has(one.key))
  const right = rowSignatures(after)?.filter(one => !ours.has(one.key))
  if (left === undefined || right === undefined) return VERIFY_FAILED
  if (left.length !== right.length) return VERIFY_FAILED
  for (let i = 0; i < left.length; i += 1) {
    if (left[i]?.key !== right[i]?.key || left[i]?.text !== right[i]?.text) return VERIFY_FAILED
  }
  return undefined
}

/** 我们建的那一行前面那句给人看的注释(**不写 `name:`**,理由见文件头第 2 条)。 */
const RELAY_ROW_COMMENT = '# 工作台提供的模型服务:这一行由「设置 → 模型」维护,手改会被下一次切换覆盖。'
const MODEL_ROW_COMMENT = '# 事务官那一侧用哪家模型:这一行由「设置 → 模型」维护。'

/**
 * 切到中转(补丁层这一代)。装上(或更新)我们那条路由,再把 `provider` 指过来。
 *
 * `model` 那一行**他选过就一个字不动**;补丁里压根没写过时才补一个中转认的 id ——
 * 升级那一刻(段刚被收进 patch)走的正是"选过"这一支,所以不会把他的选择覆盖回默认。
 */
export function patchForRelay(
  text: string,
  options: { baseUrl: string, extraModels?: readonly string[] } & PatchModelDefaults,
): DshSettingsEdit {
  const doc = parseProfilePatch(text)
  if (!doc.ok) return { ok: false, error: doc.error }
  const relay = readPatchRelayProvider(text)
  if (!relay.ok) return { ok: false, error: relay.error }

  const current = readPatchDefaultModel(text)
  const model = current?.model ?? options.relayModel
  const models = [...new Set([
    model,
    ...(relay.found ? relay.models : []),
    ...RELAY_STANDARD_MODELS,
    ...(options.extraModels ?? []),
  ])]
  for (const value of [options.baseUrl, model, ...models]) {
    if (!isSafePlainScalar(value)) return { ok: false, error: UNSAFE_VALUE }
  }

  // ① 我们那条路由。**语义上已经一样就一个字不改**(理由见 relayBlockMatches)。
  const intended = { baseUrl: options.baseUrl, models }
  let lines: string[]
  const relayRow = rowOf(doc.rows, PATCH_RELAY_PLUGIN_ID)
  if (relayRow === undefined) {
    lines = appendRow(doc, RELAY_ROW_COMMENT, [
      `- id: ${PATCH_RELAY_PLUGIN_ID}`, `${' '.repeat(ROW_KEY_INDENT)}config:`, ...relayConfigLines(intended),
    ])
  }
  else if (relayBlockMatches(relay, intended)) {
    lines = [...doc.lines]
  }
  else {
    lines = withConfigBlock(doc.lines, relayRow, relayConfigLines(intended))
  }

  // ② `agent-default-model` 那一行。provider 指过来,model 一定要在(上游 schema 两个都必填)。
  const after = parseProfilePatch(joinLines(lines))
  if (!after.ok) return { ok: false, error: VERIFY_FAILED }
  const modelRow = rowOf(after.rows, PATCH_DEFAULT_MODEL_ID)
  if (modelRow === undefined) {
    lines = appendRow(after, MODEL_ROW_COMMENT, [
      `- id: ${PATCH_DEFAULT_MODEL_ID}`,
      `${' '.repeat(ROW_KEY_INDENT)}config:`,
      `${' '.repeat(CONFIG_INDENT)}provider: ${DSH_RELAY_PROVIDER}`,
      `${' '.repeat(CONFIG_INDENT)}model: ${model}`,
    ])
  }
  else {
    lines = withConfigScalar(after.lines, modelRow, 'provider', DSH_RELAY_PROVIDER)
    const again = parseProfilePatch(joinLines(lines))
    if (!again.ok) return { ok: false, error: VERIFY_FAILED }
    const row = rowOf(again.rows, PATCH_DEFAULT_MODEL_ID)
    if (row === undefined) return { ok: false, error: VERIFY_FAILED }
    lines = withConfigScalar(again.lines, row, 'model', model)
  }

  const out = joinLines(lines)
  const failed = verified(text, out, { model: { provider: DSH_RELAY_PROVIDER, model }, relay: { baseUrl: options.baseUrl, models } })
  if (failed !== undefined) return { ok: false, error: failed }
  return { ok: true, text: out, changed: out !== joinLines(text.split('\n')) }
}

/**
 * 切回自己的 Key(补丁层这一代)。只把 `provider` 指回去,`model` 与别的键原样。
 * **我们那条路由留着不删** —— 删了下次切回来又要重写,而留着的代价只是模型选择器里多一条。
 */
export function patchForOwnKey(
  text: string,
  options: { previousProvider?: string } & PatchModelDefaults,
): DshSettingsEdit {
  const doc = parseProfilePatch(text)
  if (!doc.ok) return { ok: false, error: doc.error }
  // workbench-relay / workbench-own 都是我们维护的临时路由:切回「官方」时不能指回一条可能已经不在了的路由。
  const target = options.previousProvider !== undefined
    && options.previousProvider !== DSH_RELAY_PROVIDER && options.previousProvider !== DSH_OWN_PROVIDER
    ? options.previousProvider
    : DSH_OFFICIAL_PROVIDER
  if (!isSafePlainScalar(target)) return { ok: false, error: UNSAFE_VALUE }

  const current = readPatchDefaultModel(text)
  const row = rowOf(doc.rows, PATCH_DEFAULT_MODEL_ID)
  // 补丁里压根没有那一行 = 现在跑的就是上游缺省;要切回去的又正是它 → 不写,也不是错。
  if (row === undefined && target === options.upstream.provider) return { ok: true, text, changed: false }

  const model = current?.model ?? options.upstream.model
  if (!isSafePlainScalar(model)) return { ok: false, error: UNSAFE_VALUE }

  let lines: string[]
  if (row === undefined) {
    lines = appendRow(doc, MODEL_ROW_COMMENT, [
      `- id: ${PATCH_DEFAULT_MODEL_ID}`,
      `${' '.repeat(ROW_KEY_INDENT)}config:`,
      `${' '.repeat(CONFIG_INDENT)}provider: ${target}`,
      `${' '.repeat(CONFIG_INDENT)}model: ${model}`,
    ])
  }
  else {
    lines = withConfigScalar(doc.lines, row, 'provider', target)
    const again = parseProfilePatch(joinLines(lines))
    if (!again.ok) return { ok: false, error: VERIFY_FAILED }
    const next = rowOf(again.rows, PATCH_DEFAULT_MODEL_ID)
    if (next === undefined) return { ok: false, error: VERIFY_FAILED }
    lines = withConfigScalar(again.lines, next, 'model', model)
  }

  const out = joinLines(lines)
  const failed = verified(text, out, { model: { provider: target, model } })
  if (failed !== undefined) return { ok: false, error: failed }
  return { ok: true, text: out, changed: out !== joinLines(text.split('\n')) }
}

/** 我们建的那一行(workbench-own)前面那句给人看的注释(**不写 `name:`**,理由见文件头第 2 条)。 */
const OWN_ROW_COMMENT = '# 自己接的模型服务:这一行由「设置 → 模型」维护,手改会被下一次切换覆盖。'

/**
 * 「地址保持官方、只换模型名」(2026-10-23 退修,补丁层这一代):provider 那一行照
 * {@link patchForOwnKey} 的回滚语义,model 行换成他填的;不建 workbench-own,别人的行一个字节不动。
 * 补丁里压根没有那一行时:他填了模型名 = 替他新建一行(provider 回滚目标 + 他填的模型)。
 */
export function patchForOwnModel(
  text: string,
  options: { model: string, previousProvider?: string } & PatchModelDefaults,
): DshSettingsEdit {
  if (!isSafePlainScalar(options.model)) return { ok: false, error: UNSAFE_VALUE }
  const doc = parseProfilePatch(text)
  if (!doc.ok) return { ok: false, error: doc.error }
  // 与 patchForOwnKey 同一个回滚目标(它内部就是这么算的)。
  const target = options.previousProvider !== undefined
    && options.previousProvider !== DSH_RELAY_PROVIDER && options.previousProvider !== DSH_OWN_PROVIDER
    ? options.previousProvider
    : DSH_OFFICIAL_PROVIDER

  const back = patchForOwnKey(text, { ...options })
  if (!back.ok) return back
  const backDoc = parseProfilePatch(back.text)
  if (!backDoc.ok) return { ok: false, error: VERIFY_FAILED }
  if (rowOf(backDoc.rows, PATCH_DEFAULT_MODEL_ID) !== undefined) {
    const row = rowOf(backDoc.rows, PATCH_DEFAULT_MODEL_ID) as PatchRow
    const out = joinLines(withConfigScalar(backDoc.lines, row, 'model', options.model))
    const failed = verified(text, out, { model: { provider: target, model: options.model } })
    if (failed !== undefined) return { ok: false, error: failed }
    return { ok: true, text: out, changed: out !== joinLines(text.split('\n')) }
  }

  // 补丁里还没有那一行:他填了模型名,替他新建(provider 回滚目标 + 他填的模型)。
  const lines = appendRow(backDoc, MODEL_ROW_COMMENT, [
    `- id: ${PATCH_DEFAULT_MODEL_ID}`,
    `${' '.repeat(ROW_KEY_INDENT)}config:`,
    `${' '.repeat(CONFIG_INDENT)}provider: ${target}`,
    `${' '.repeat(CONFIG_INDENT)}model: ${options.model}`,
  ])
  const out = joinLines(lines)
  const failed = verified(text, out, { model: { provider: target, model: options.model } })
  if (failed !== undefined) return { ok: false, error: failed }
  return { ok: true, text: out, changed: out !== joinLines(text.split('\n')) }
}

/**
 * 切到「自己接的端点」(own 档填了 base_url 的那一个,2026-10-23,卡「事务官换Key」):
 * 装上(或更新)workbench-own 那一段,`agent-default-model` 的 provider 与 model 都指过去
 * (地址与模型名是他自己填的,照填,不替他猜别的)。
 *
 * 与 patchForRelay 同几道守门:认不得的文档不写;他自己配过 llm-pi-ai 整件不做;
 * 值不安全拒写;写完自己再核一遍。幂等 —— 语义上已经是那一段就一个字不改。
 */
export function patchForOwnEndpoint(
  text: string,
  options: { baseUrl: string, model: string } & PatchModelDefaults,
): DshSettingsEdit {
  const doc = parseProfilePatch(text)
  if (!doc.ok) return { ok: false, error: doc.error }
  const own = readPatchOwnProvider(text)
  if (!own.ok) return { ok: false, error: own.error }
  for (const value of [options.baseUrl, options.model]) {
    if (!isSafePlainScalar(value)) return { ok: false, error: UNSAFE_VALUE }
  }

  // ① workbench-own 那一段。已经齐了就一个字不改。
  const intended = { baseUrl: options.baseUrl, model: options.model }
  let lines: string[]
  const relayRow = rowOf(doc.rows, PATCH_RELAY_PLUGIN_ID)
  if (ownBlockMatches(own, intended)) {
    lines = [...doc.lines]
  }
  else if (relayRow === undefined) {
    lines = appendRow(doc, OWN_ROW_COMMENT, [
      `- id: ${PATCH_RELAY_PLUGIN_ID}`, `${' '.repeat(ROW_KEY_INDENT)}config:`, ...ownConfigLines(intended),
    ])
  }
  else {
    lines = withConfigBlock(doc.lines, relayRow, ownConfigLines(intended))
  }

  // ② `agent-default-model` 那一行:provider 与 model 都指过去(他填的模型名照填)。
  const after = parseProfilePatch(joinLines(lines))
  if (!after.ok) return { ok: false, error: VERIFY_FAILED }
  const modelRow = rowOf(after.rows, PATCH_DEFAULT_MODEL_ID)
  if (modelRow === undefined) {
    lines = appendRow(after, MODEL_ROW_COMMENT, [
      `- id: ${PATCH_DEFAULT_MODEL_ID}`,
      `${' '.repeat(ROW_KEY_INDENT)}config:`,
      `${' '.repeat(CONFIG_INDENT)}provider: ${DSH_OWN_PROVIDER}`,
      `${' '.repeat(CONFIG_INDENT)}model: ${options.model}`,
    ])
  }
  else {
    lines = withConfigScalar(after.lines, modelRow, 'provider', DSH_OWN_PROVIDER)
    const again = parseProfilePatch(joinLines(lines))
    if (!again.ok) return { ok: false, error: VERIFY_FAILED }
    const row = rowOf(again.rows, PATCH_DEFAULT_MODEL_ID)
    if (row === undefined) return { ok: false, error: VERIFY_FAILED }
    lines = withConfigScalar(again.lines, row, 'model', options.model)
  }

  const out = joinLines(lines)
  const failed = verified(text, out, {
    model: { provider: DSH_OWN_PROVIDER, model: options.model },
    own: intended,
  })
  if (failed !== undefined) return { ok: false, error: failed }
  return { ok: true, text: out, changed: out !== joinLines(text.split('\n')) }
}

/**
 * 老机器上我们那条路由补齐(补上 pro、给能看图的写 `input`),`agent-default-model` 一个字不碰
 * ——他切回了自己的 Key 也不会被我们切回中转。
 *
 * 开机时跑的,所以「没有那一段」「是他自己配的」都**不算错**(回 `changed: false`);
 * 只有"文档认不得"才回 `ok: false`,那一条值得进日志。
 */
export function patchUpgradeManagedRelay(text: string): DshSettingsEdit {
  const doc = parseProfilePatch(text)
  if (!doc.ok) return { ok: false, error: doc.error }
  const relay = readPatchRelayProvider(text)
  if (!relay.ok) return { ok: true, text, changed: false }
  if (!relay.found || relay.baseUrl === undefined) return { ok: true, text, changed: false }
  const row = rowOf(doc.rows, PATCH_RELAY_PLUGIN_ID)
  if (row === undefined) return { ok: true, text, changed: false }

  const current = readPatchDefaultModel(text)?.model
  const models = [...new Set([
    ...(current === undefined ? [] : [current]),
    ...relay.models,
    ...RELAY_STANDARD_MODELS,
  ])]
  for (const value of [relay.baseUrl, ...models]) {
    if (!isSafePlainScalar(value)) return { ok: true, text, changed: false }
  }
  const intended = { baseUrl: relay.baseUrl, models }
  // 已经齐了就一个字不改 —— 这一下每次开机都跑,写一次就多一份备份。
  if (relayBlockMatches(relay, intended)) return { ok: true, text, changed: false }
  const out = joinLines(withConfigBlock(doc.lines, row, relayConfigLines(intended)))
  const failed = verified(text, out, { relay: { baseUrl: relay.baseUrl, models } })
  if (failed !== undefined) return { ok: false, error: failed }
  return { ok: true, text: out, changed: out !== joinLines(text.split('\n')) }
}
