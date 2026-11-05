/**
 * 每个区域单独解锁 —— 取数那一半(纯函数,不碰 DOM、不发请求)。
 *
 * Ben 2026-09-17:「Kimi、Codex 这些额度,都是扫描到了再开始,最好每个区域单独解锁:
 * 没装的那家不显示、不催;装了才亮出那一格,并在格里给『怎么接上』的一步。」
 * 目标用户是不懂代码的半专业个体 —— **不能一上来全摆出来吓人**。
 *
 * 一条贯穿全文件的规矩:`clients` 缺席(服务端还没扫过 / 没接扫描服务)时,
 * 这里的每个函数都退回**这一版之前的行为**(四家全显示、四颗点全在)。
 * "还不知道"不该长得像"都没有" —— 空着的界面比多一格更吓人,而且它是假的。
 */
import type { AgentId, ClientAreaView, ClientKey, ClientsView, QuotaEntry } from '../protocol.ts'
import type { QuotaCell } from './quotaCells.ts'
import { QUOTA_CLIENT_KEYS } from '../protocol.ts'

/** 额度面板里四个 agent 与桌面客户端的对应关系。`dsh` 没有客户端,永远显示。 */
const AGENT_CLIENT: Partial<Record<AgentId, ClientKey>> = {
  claude: 'claude',
  codex: 'codex',
  kimi: 'kimi',
}

/** 展示名。跟服务端 CLIENT_LABELS 是同一套文案,但前端不 import 服务端(两边构建独立)。 */
export const CLIENT_NAMES: Readonly<Record<ClientKey, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  wechat: '微信',
  wecom: '企业微信',
}

/**
 * 那颗按钮把他送到哪儿。
 *
 * - `apply` → **工作台替他写钩子**(2026-09-17 Ben 拍板)。弹一个小确认框:先看一眼
 *   要写进哪个文件、要写什么,他点「写入」才真写,写完能一键撤回。Claude / Codex 走这条。
 * - `settings` → 齿轮弹窗(「额度凭据」那一节就在里面:Kimi 的登录按钮、DeepSeek 的 Key);
 * - `setup` → 初始化页(钩子在那儿也渲染好了,是代写之外的手工后路)。
 *
 * 为什么 Claude / Codex 从 `setup` 改成 `apply`:原来那颗按钮只是把他送到一页
 * "已经渲染好的 JSON" 前面,剩下的合并动作还是他自己做 —— 对不懂代码的人,
 * 那一步(合并、路径、不能整份覆盖)是整条流程里唯一一处会卡死的地方,而且做错不报错。
 *
 * 做成一张表而不是散在组件里:这几个去处以后会随设置弹窗改版而变,变的时候只改这里。
 *
 * 2026-09-21 多两个去处,都是 DeepSeek 那一格要的(它不在那五家里):
 * - `relay` → **就地**切到「用工作台提供的服务」。登录过了这就是一键的事,不用跳设置;
 * - `model` → 设置弹窗里「模型服务」那一节(他要填自己的 Key)。今天它和 `settings`
 *   打开的是同一扇窗,但**名字不共用**:这一格要去的是「模型服务」那一节,
 *   Kimi 那一格要去的是「额度凭据」那一节。哪天设置能定位到小节,改的是这张表,不是各处 if。
 */
export type UnlockTarget = 'settings' | 'setup' | 'apply' | 'relay' | 'model' | 'apply-all'

const UNLOCK_TARGET: Readonly<Record<ClientKey, UnlockTarget>> = {
  claude: 'apply',
  codex: 'apply',
  kimi: 'settings',
  wechat: 'setup',
  wecom: 'setup',
}

const UNLOCK_BUTTON: Readonly<Record<UnlockTarget, string>> = {
  settings: '去设置里接上',
  setup: '去初始化页看钩子',
  // Ben 定的那句原话。整句话里没有一个技术词,而且它承诺的正是按下去会发生的事。
  apply: '点一下,工作台帮你接上',
  // 2026-09-21 Ben 定的那两句。「推荐」两个字与设置里「模型服务」那一节逐字一致 ——
  // 同一件事在两处用两种说法,人会以为是两件事。
  relay: '用我们的服务(推荐)',
  model: '填自己的 Key',
  // 2026-09-25:Claude、Codex 一次接上(一次看、一次点,每家仍能单独撤回)。
  'apply-all': '全部接上',
}

export function unlockTarget(client: ClientKey): UnlockTarget {
  return UNLOCK_TARGET[client]
}

export function unlockButtonLabel(client: ClientKey): string {
  return UNLOCK_BUTTON[unlockTarget(client)]
}

/**
 * 解锁卡上的一颗按钮(2026-09-21)。
 *
 * 加这一层是因为 DeepSeek 那一格有**两条路**(用我们的服务 / 填自己的 Key),
 * 而那五家各只有一条。把"这张卡有几颗按钮"从组件里挪进这个纯函数之后,
 * 组件永远只是「把 actions 画出来」—— 哪天 Kimi 也长出第二条路,改的还是这里。
 */
export interface UnlockAction {
  label: string
  target: UnlockTarget
  /** 那五家才有。DeepSeek 没有桌面客户端,这一格缺席。 */
  client?: ClientKey
  /** 推荐的那一颗(视觉上重一点)。一张卡上最多一颗。 */
  primary?: boolean
}

/** 那五家各自那一颗。 */
export function unlockActions(client: ClientKey): readonly UnlockAction[] {
  return [{ label: unlockButtonLabel(client), target: unlockTarget(client), client }]
}

/**
 * DeepSeek 那一格的两颗(2026-09-21)。顺序就是屏幕上的顺序:**推荐的那条在前**。
 *
 * 「用我们的服务」在前不是排版偏好:对一个不懂代码的人,"去申请一个 API Key"
 * 是整条路上唯一一处会卡死的地方,而另一条路他已经登录过了,是一键。
 */
export const DEEPSEEK_UNLOCK_ACTIONS: readonly UnlockAction[] = [
  { label: UNLOCK_BUTTON.relay, target: 'relay', primary: true },
  { label: UNLOCK_BUTTON.model, target: 'model' },
]

/**
 * 额度面板里的一格。两种形态:
 * - `quota` —— 接上了,显示真数字(原来那张 QuotaCell 一字不改);
 * - `unlock` —— 还没接上,显示一张解锁卡(名字 + 一句 how + 一到两颗按钮)。
 *
 * **没装的那家不在这个数组里** —— 不是一格空的,是整格不存在。
 *
 * 2026-09-21:`client` 变成**可选** —— DeepSeek 也出解锁卡了,而它不是那五家里的任何一家
 * (`ClientKey` 管的是桌面客户端)。按钮改成由 `actions` 给,一颗还是两颗由这个文件决定。
 */
export type QuotaArea =
  | { kind: 'quota', agent: AgentId, cell: QuotaCell }
  | {
    kind: 'unlock'
    agent: AgentId
    /** 那五家才有。DeepSeek 缺席。 */
    client?: ClientKey
    name: string
    how: string
    actions: readonly UnlockAction[]
  }

/**
 * DeepSeek 那一格在「用工作台提供的服务」时换一套说法(2026-09-17 model.json 的 mode)。
 *
 * 为什么必须换:`relay` 时用的是工作台自家中转的额度,**界面上那个「¥ 账号余额」不是他的钱**。
 * 照旧显示等于说了一句假话 —— 而且是关于钱的假话。
 *
 * 2026-09-18 换了取数那一头(Ben 真机「清空凭据后还显示 ¥2.26」那张卡):
 * 这一格的数字现在由服务端直接给成**中转的今日用量** —— 一条 `{ label:'今日' }` 的窗口
 * (quota/relay.ts)。它有分母(今日上限),所以照别家那样画条,条长＝今天还剩多少。
 *
 * 原来那一版拿的是 `today_spent`,而那是**官方账户余额两次读数之差**:走中转时那个账户
 * 根本没在动,把它写成「工作台提供的服务 · 今日用量」正是这次要修的那句假话。
 * 服务端给不出中转用量时(中转没部署好、计量接口 404)如实写「还没接上」,**不编数**(D13)。
 */
export function relayCell(cell: QuotaCell, entry: QuotaEntry | undefined): QuotaCell {
  const today = entry?.kind === 'quota' ? entry.windows.find(window => window.label === '今日') : undefined
  if (today !== undefined) {
    const bar = cell.bars.find(one => one.label === '今日')
    return {
      ...cell,
      showBar: true,
      bars: bar === undefined ? cell.bars : [bar],
      value: `${today.left_pct}%`,
      note: '工作台提供的服务 · 今日用量',
    }
  }

  return {
    ...cell,
    // 余额条/余额数一律不留:relay 下它们说的不是他的账户。
    showBar: false,
    bars: [],
    value: '未接入',
    // 服务端已经把原因写成人话了(「…今日用量还没接上(中转没能给出用量(HTTP 404))」),
    // 照它说 —— 那句里有 Ben 拿去问人的那个状态码。它没说时给一句最保守的。
    note: entry?.kind === 'unknown' && entry.note !== undefined && entry.note.includes('工作台提供的服务')
      ? entry.note
      : '工作台提供的服务 · 今日用量还没接上(中转那边的计量未接线)',
    level: 'ok',
  }
}

/**
 * 额度面板该画哪几格。
 *
 * @param cells `quotaCells(...)` 的原样输出(四家固定顺序)。
 * @param clients `/state.clients`。**缺席 = 还没扫过**,四格全画(这一版之前的行为)。
 * @param quota `/state.quota`,只有 relay 那一格用得到(取 today_spent)。
 * @param modelMode `/state.model_mode`。`relay` 时 DeepSeek 那格换说法;缺席按现有逻辑。
 * @param relayConfigured `/state.relay_configured`。`false`(这台没接中转)时 DeepSeek 那张卡只剩「填自己的 Key」。
 */
export function quotaAreas(
  cells: readonly QuotaCell[],
  clients: ClientsView | undefined,
  quota: Partial<Record<AgentId, QuotaEntry>> = {},
  modelMode?: 'relay' | 'own',
  relayConfigured?: boolean,
): readonly QuotaArea[] {
  const out: QuotaArea[] = []
  for (const cell of cells) {
    const key = AGENT_CLIENT[cell.agent]
    // DeepSeek:没有桌面客户端,永远在;relay 时换一套说法,没接上时出解锁卡。
    if (key === undefined) {
      if (modelMode === 'relay') {
        out.push({ kind: 'quota', agent: cell.agent, cell: relayCell(cell, quota[cell.agent]) })
        continue
      }
      if (deepseekUnconnected(quota[cell.agent])) { out.push(deepseekUnlock(cell.agent, relayConfigured === false)); continue }
      out.push({ kind: 'quota', agent: cell.agent, cell })
      continue
    }
    const view = clients?.[key]
    // 还没扫过 → 照这一版之前那样显示。
    if (view === undefined) { out.push({ kind: 'quota', agent: cell.agent, cell }); continue }
    // 没装 → 整格不出现(不显示、不催、不占位)。
    if (!view.installed) continue
    if (view.connected) { out.push({ kind: 'quota', agent: cell.agent, cell }); continue }
    out.push({
      kind: 'unlock',
      agent: cell.agent,
      client: key,
      name: CLIENT_NAMES[key],
      // how 按契约只在没接上时有;真缺了也不留空白卡片 —— 给一句最保守的通用话。
      how: view.how ?? '去设置里把这一家接上。',
      actions: unlockActions(key),
    })
  }
  return out
}

/** DeepSeek 那一格的名字与那句话。与别家同一张卡,只是按钮有两颗。 */
export const DEEPSEEK_UNLOCK_HOW = '两条路随你挑:用我们的服务(不用填任何东西),或者用你自己的 DeepSeek 账号。'

/** 这台没接中转时那一句:只有一条路。 */
export const DEEPSEEK_UNLOCK_HOW_NO_RELAY = '这台没接中转:用你自己的 DeepSeek 账号,填一串密钥就能用。'

function deepseekUnlock(agent: AgentId, noRelay = false): QuotaArea {
  return noRelay
    ? { kind: 'unlock', agent, name: 'DeepSeek', how: DEEPSEEK_UNLOCK_HOW_NO_RELAY, actions: [{ label: UNLOCK_BUTTON.model, target: 'model', primary: true }] }
    : { kind: 'unlock', agent, name: 'DeepSeek', how: DEEPSEEK_UNLOCK_HOW, actions: DEEPSEEK_UNLOCK_ACTIONS }
}

/**
 * DeepSeek 这会儿是不是「没走中转、也没填 Key」(2026-09-21)。
 *
 * 判据只认服务端那面旗子 `no_stale`:取数层在**确定**没有任何一把 Key 时才打上它
 * (quota/collect.ts 的 `collectDeepSeek`),而网络抖一下取不到余额是**另一回事**
 * —— 那时候 entry 也是 unknown,但没有这面旗子,那一格该照旧写「未接入 · 这次没取到」,
 * 不该换成一张"还没接上、来选一条路"的卡。把两件事画成同一张卡就是编(D13):
 * 他明明填了 Key,界面却让他再去填一次。
 *
 * relay 那一支在调用处已经先返回了,所以这里看到的 unknown 只会是「用自己的账号」那一档。
 */
export function deepseekUnconnected(entry: QuotaEntry | undefined): boolean {
  return entry?.kind === 'unknown' && entry.no_stale === true
}

/**
 * 「解锁进度」那一小行(第 5 条)。
 *
 * 只说**有额度的那几家**(2026-09-25):Claude、Codex、Kimi,再加上 DeepSeek(它没有桌面客户端,
 * 状态由调用方从 quota / model_mode 算好了传进来)。微信、企业微信**永远不进这句话** ——
 * 09-24 维护者引导完看到的是「已接上 2 家:微信、企业微信」,而有额度的三家一家都没接,
 * 原话:「接微信和企业微信干嘛,这两家有额度???」
 *
 * 其余照旧:只说**扫到装了的那几家**(没装的不进这句话,否则又变成"一上来全摆出来");
 * 还没扫过、或者三家一家都没扫到 → 整行缺席(只剩 DeepSeek 一家时这一行没有话要说:
 * 它回答的是"为什么这里只有这几家、还差哪一步",而 DeepSeek 那一格自己就在面板里)。
 */
export interface UnlockProgress {
  /** 已接上的那几家的名字(按 DeepSeek、Claude、Codex、Kimi 的顺序)。 */
  connected: readonly string[]
  /** 装了还没接的那几家(只含有额度的三家)。 */
  pending: readonly { client: ClientKey, name: string, how: string }[]
  /**
   * 能**一次接上**的那几家(2026-09-25):装了、没接、而且工作台能替他写的(Claude / Codex)。
   * 两家以上时那一行带一颗「全部接上」—— 一次看、一次点,每家仍能单独撤回。
   */
  applyAll: readonly ('claude' | 'codex')[]
  /** 一整句人话。界面直接显示这一句。 */
  line: string
}

/** DeepSeek 那一家此刻接没接上。说不出来(还没取过数、这次没取到)就是 undefined —— 不进那一行。 */
export interface DeepSeekProgress { connected: boolean }

/**
 * DeepSeek 接没接上(2026-09-25,给「已接上 N 家」那一行用)。
 *
 * - 走中转(`relay`)→ 接上了(用的是工作台提供的服务,不需要他做任何事);
 * - 服务端**确定**一把 Key 都没有(`no_stale`,同 deepseekUnconnected)→ 没接上;
 * - 取到过余额 / 额度 → 接上了;
 * - 还没取过数、或者"这次没取到"(unknown 但没有 no_stale 那面旗子)→ **说不出来**,不进那一行:
 *   把"网络抖了一下"说成"还没接上"就是编(D13),把它说成"接上了"也是。
 */
export function deepseekProgress(
  entry: QuotaEntry | undefined,
  modelMode?: 'relay' | 'own',
): DeepSeekProgress | undefined {
  if (modelMode === 'relay') return { connected: true }
  if (entry === undefined) return undefined
  if (deepseekUnconnected(entry)) return { connected: false }
  if (entry.kind === 'balance' || entry.kind === 'quota') return { connected: true }
  return undefined
}

function isApplyable(client: ClientKey): client is 'claude' | 'codex' {
  return unlockTarget(client) === 'apply' && (client === 'claude' || client === 'codex')
}

export function unlockProgress(
  clients: ClientsView | undefined,
  deepseek?: DeepSeekProgress,
): UnlockProgress | undefined {
  if (clients === undefined) return undefined
  const installed = QUOTA_CLIENT_KEYS
    .map(key => ({ key, view: clients[key] as ClientAreaView | undefined }))
    .filter((row): row is { key: ClientKey, view: ClientAreaView } => row.view?.installed === true)
  if (installed.length === 0) return undefined

  const connected = [
    ...(deepseek?.connected === true ? ['DeepSeek'] : []),
    ...installed.filter(row => row.view.connected).map(row => CLIENT_NAMES[row.key]),
  ]
  const pending = installed.filter(row => !row.view.connected).map(row => ({
    client: row.key,
    name: CLIENT_NAMES[row.key],
    how: row.view.how ?? '去设置里把这一家接上。',
  }))
  const applyAll = pending.map(row => row.client).filter(isApplyable)

  const parts: string[] = []
  if (connected.length > 0) parts.push(`已接上 ${connected.length} 家:${connected.join('、')}`)
  if (applyAll.length >= 2) {
    // 能一次接上的那几家并成一句 —— 两句「点一下,工作台帮你接上」并排,等于让他点两次、看两次。
    const names = applyAll.map(client => CLIENT_NAMES[client]).join('、')
    parts.push(`${names} 装了还没接:点「全部接上」一次接好(先看要写什么,写完每家都能单独撤回)`)
  }
  for (const row of pending) {
    if (applyAll.length >= 2 && isApplyable(row.client)) continue
    parts.push(`${row.name} 装了还没接:${row.how}`)
  }
  if (deepseek?.connected === false) parts.push(`DeepSeek 还没接:${DEEPSEEK_UNLOCK_HOW}`)
  // 各句自带的句号先摘掉再用分号连 —— 不然读出来是「…撤回。;Codex …」(09-24 截图里就是这样)。
  const trimmed = parts.map(part => part.replace(/。$/, ''))
  // 全接上了也照说一句 —— 那是这一整块唯一一次报喜的机会,而且它顺带解释了
  // "为什么界面上只有这几家"(没装的那几家从来就没出现过)。
  return { connected, pending, applyAll, line: trimmed.join(';') }
}
