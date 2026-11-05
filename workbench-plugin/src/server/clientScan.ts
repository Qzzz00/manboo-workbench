/**
 * 各家客户端的「扫到没有 / 接上没有」(2026-09-17,Ben:「Kimi、Codex 这些额度,都是扫描到了
 * 再开始,最好每个区域单独解锁」)。
 *
 * 这一份是**唯一的探测真相**:登录台的体检页(setup/status.ts 的 checkClient)与看板上的
 * 额度面板、窗位清单、顶部状态点全走这里的 `probeInstalled`。此前只有体检页会探测,
 * 再给看板抄一份的话,同一台机器上两处会给出不一样的答案 —— 而 Ben 看到的是同一个界面。
 *
 * 三件事各自的取证路子(取不到就说取不到,绝不推断):
 *
 * | 家 | installed | connected |
 * |---|---|---|
 * | Claude | mdfind 找得到 bundle | `~/.claude/settings.json` 里有**工作台自己的**钩子,指着固定位置上那个脚本,且脚本真在、能执行 |
 * | Codex  | mdfind 找得到 bundle(ChatGPT.app) | `~/.codex/hooks.json` 里同上 |
 * | Kimi   | mdfind 找得到 bundle | 凭据里有 `kimi_web`(网页登录过一次) |
 * | 微信/企微 | mdfind 找得到 bundle | **永远 false**(2026-09-25)—— 聊天应用,没有额度、没有「接」这一步 |
 *
 * ★ 微信/企微原来是「装了即算接上」。额度面板顶上那一行因此写着「已接上 2 家:微信、企业微信」,
 * 而真正有额度的三家一家都没接 —— 维护者 09-24:「接微信和企业微信干嘛,这两家有额度???」。
 * 「接上」在这里只有一个意思:**额度数字取得到了**。聊天应用永远不是;它们只在窗位清单里用
 * `installed`(`QUOTA_CLIENT_KEYS` 之外的那两家,见 protocol.ts)。
 *
 * ★ **「钩子在就算」**(2026-09-17 Ben 拍板,决策记录「三条按统筹建议拍板」)。
 * 0.2.38 那一版是「钩子在 **或** 本次运行收到过事件」,现在把后半截去掉了,两个理由:
 *
 * 1. 事件那半截跨不过重启 —— 工作台一重启 `sawEvent` 全成 false,真正决定界面的从来是钩子;
 * 2. 更要紧的是:钩子成了**一颗按钮就能装上**的东西(hooksApply.ts)。既然「接上」这件事
 *    有了唯一一条可执行的路,判据就该跟那条路一一对应 —— 界面说「没接上」,按钮点下去
 *    必定让它变成「接上了」。掺进事件证据的话会出现"说接上了但钩子其实没贴"的夹缝态,
 *    那时按钮该不该出现、点了又该发生什么,谁也说不清。
 *
 * ★ 「工作台自己的」而不是「有任意一条 hook」:Codex 那边本来就挂着 headroom 的两条,
 * 只数命令数的话,一台**根本没接工作台**的机器会被判成「接上了」——解锁卡就永远不出现,
 * 而他压根没有接上过。判据与代写、撤回三处共用 `WB_HOOKS_COMMAND_MARKERS` 这一份(新旧两种位置都认)。
 *
 * ★ 「指着固定位置」(卡 R,2026-09-25):钩子脚本随插件走、同步在 `~/.dsh/workbench/hooks/`
 * (hookScripts.ts)。**指着旧位置(开发仓库里)的条目不算接上** —— 与 09-17 决策记录第 8 条同一个道理:
 * 「接上」必须跟那颗按钮写进去的东西一一对应,界面说「没接上」,按钮点下去就换成新位置、变成「接上了」。
 * 维护者那台机器装上新版后 Claude / Codex 会先显示「要你点一次」,点一次就把旧条目平滑换掉。
 * 脚本文件本身不在 / 不能执行(同步没成)也不算:那几条命令每次都在报错。
 *
 * ★ 探测整个失败时回 `undefined` 而不是"五家都没装"(mdfind 要 Spotlight,索引关了/没权限
 * 时它一条都不回)。差别在界面上是天壤之别:缺席 = 前台照今天那样全都显示;五个 false =
 * 额度面板与窗位清单一起空掉。同 D13:"查不到"不许冒充"没有"。
 */
import type { ClientAreaView, ClientKey, ClientsView } from '../protocol.ts'
import { CLIENT_KEYS, QUOTA_CLIENT_KEYS } from '../protocol.ts'
import { APP_BUNDLES } from './activation.ts'
import { wbHooksMentionsOurScript } from './hooksConfig.ts'
import type { SetupIo } from './setup/io.ts'

/** 一轮重扫的最小间隔。mdfind 一轮五条子命令,一分钟一次足够(同 SETUP_RECHECK_MS)。 */
export const CLIENT_RESCAN_MS = 60_000

/** 展示名与官网。官网只放首页/下载页,不猜具体安装包地址(同 setup/status.ts 的 CLIENT_ROWS)。 */
export const CLIENT_LABELS: Readonly<Record<ClientKey, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  wechat: '微信',
  wecom: '企业微信',
}

/**
 * Kimi 那一步的人话(2026-09-25)。额度面板的解锁卡、「已接上 N 家」那一行、「全部接上」的
 * 预览里说的都是这一句 —— 同一件事三处三种说法,人会以为是三件事。
 */
export const KIMI_LOGIN_HOW = '要你自己登一次(账号密码工作台不经手)—— 去设置 → 额度凭据,点「登录 Kimi」,在弹出来的窗口里登一次就好,以后不用再登。'

/**
 * 装了没接上时,格子里那一句。**一句、一个动作**,而且说的是 Ben 在界面上真能点到的地方。
 * 半专业用户不认识 "hooks"、"credentials",所以这里一个英文词都不出现。
 */
const HOW: Readonly<Partial<Record<ClientKey, string>>> = {
  // 2026-09-17 起这两句不再教他手工贴文件了 —— 按钮真的会替他写(hooksApply.ts),
  // 而且写之前先给他看一眼。文案里那个"看一眼"不是客套:它是这颗按钮敢存在的前提。
  claude: '点一下,工作台帮你接上 —— 会先让你看一眼要写什么,写完还能一键撤回。',
  codex: '点一下,工作台帮你接上 —— 会先让你看一眼要写什么,写完还能一键撤回。',
  // 2026-09-25:Kimi 这一步**只能他自己来**(登录要他的账号),工作台代不了 —— 那就把话说清:
  // 自己登、登一次、以后不用再登。维护者那句「授权要自己点就算了」的前提是"只点一次"。
  kimi: KIMI_LOGIN_HOW,
  // 微信/企微没有这一格:它们不是"还没接",是压根没有「接」这回事(见文件头那张表)。
}

/**
 * 一家装没装:`mdfind kMDItemCFBundleIdentifier == '<id>'` 有输出即算装了。
 *
 * 回 `undefined` = **查不出来**(命令没跑成 / 没登记 bundle id)。跟"跑成了、没找到"
 * (`{ found: false }`)分开,上层据此决定要不要整块缺席。
 *
 * `path` 是找到的那一份在哪 —— 体检页要回答"装在哪个目录",看板只要 `found`。
 * 一次 mdfind 两边都够用,不跑第二遍。
 */
export async function probeInstalled(
  io: Pick<SetupIo, 'exec'>,
  bundleId: string,
): Promise<{ found: boolean, path?: string } | undefined> {
  if (bundleId === '') return undefined
  const out = await io.exec(['mdfind', `kMDItemCFBundleIdentifier == '${bundleId}'`])
  if (!out.ok) return undefined
  const first = out.out.split('\n').map(line => line.trim()).find(line => line !== '')
  return first === undefined ? { found: false } : { found: true, path: first }
}

/** 一家的 bundle id。五家都在 APP_BUNDLES 里,查不到回空串(上层当"查不出来")。 */
export function bundleOfClient(key: ClientKey): string {
  return Object.hasOwn(APP_BUNDLES, key) ? (APP_BUNDLES[key] ?? '') : ''
}

export interface ClientScanDeps {
  /** `stat` 给了才核对「钩子指着的那个脚本真在、能执行」(生产给的是 nodeSetupIo,带着它)。 */
  io: Pick<SetupIo, 'exec' | 'readFile'> & Partial<Pick<SetupIo, 'stat'>>
  paths: { claudeSettings: string, codexHooks: string, credentialsJson: string }
  /**
   * 各家 hook 该指的那个脚本:固定位置上的 `agent-hook.sh`(hookScripts.ts 的 `hookScript`)。
   * 给了才判「指没指对」—— 指着旧位置(开发仓库)的不算接上;没给就只看"有没有工作台的 hook"。
   */
  hookScript?: string
  now: () => number
  rescanMs?: number
}

export interface ClientScan {
  /** 上一轮的结论。**没扫过就 undefined**(/state 那一格随之缺席)。 */
  view: () => ClientsView | undefined
  /** 节流过的后台重扫。composeState 每拍调一次,内部决定要不要真跑。 */
  pump: () => void
  /** 真扫一轮(测试与首扫用)。 */
  scan: () => Promise<ClientsView | undefined>
  /**
   * 把那一分钟的节流作废,下一拍 `pump()` 立刻重扫。
   *
   * 代写钩子(`POST /config/hooks/apply`)写完就调它:不然他点完「接上」,解锁卡还要
   * 挂在那儿最多 60 秒才消失 —— 那一分钟里他会以为按钮没起作用,然后再点一次。
   */
  invalidate: () => void
  /** 装了的那几家(窗位清单的 disabled 默认值据此走)。没扫过就 undefined。 */
  installedKeys: () => ReadonlySet<ClientKey> | undefined
}

/** 缓存下来的那一半:贵(mdfind)或者不怎么变(配置文件)的证据。 */
interface ScanSnapshot {
  installed: Partial<Record<ClientKey, boolean>>
  /** 线接上了的结构证据(hooks 指对了 / 登录过了 / 微信这种装了即算)。 */
  wired: Partial<Record<ClientKey, boolean>>
}

export function createClientScan(deps: ClientScanDeps): ClientScan {
  const rescanMs = deps.rescanMs ?? CLIENT_RESCAN_MS
  let snapshot: ScanSnapshot | undefined
  let checkedAt: number | undefined
  let scanning = false

  /**
   * Claude / Codex 共用的一条:配置文件里有**工作台自己的**钩子,而且(给了 `hookScript` 的话)
   * 指的就是固定位置上那个脚本、那个脚本真在、能执行。
   *
   * 「工作台自己的」靠 `WB_HOOKS_COMMAND_MARKERS` 认(新旧两种位置)—— 与代写(hooksApply.ts)、
   * 撤回用的是同一份。别人的钩子(headroom 在 Codex 那边就挂着两条)一律不算数:
   * 它们跟工作台收不收得到会话事件毫无关系。
   */
  async function hooksWired(file: string): Promise<boolean> {
    const text = await deps.io.readFile(file)
    if (text === undefined) return false
    const ours = wbHookCommands(text)
    if (ours.length === 0) return false
    const expected = deps.hookScript
    if (expected === undefined || expected === '') return true
    // 指着旧位置(开发仓库、搬家前的 checkout)—— 不算接上,那颗按钮会把它换到固定位置上。
    if (!ours.includes(expected)) return false
    // 脚本本身不在 / 不能执行(同步没成):那几条命令每次都在报错,说"接上了"是句假话。
    if (deps.io.stat === undefined) return true
    const info = await deps.io.stat(expected)
    return info?.isFile === true && info.executable
  }

  const claudeWired = (): Promise<boolean> => hooksWired(deps.paths.claudeSettings)
  const codexWired = (): Promise<boolean> => hooksWired(deps.paths.codexHooks)

  /** Kimi:凭据里有 kimi_web(网页登录过一次)。**只看键在不在,绝不读值。** */
  async function kimiWired(): Promise<boolean> {
    const text = await deps.io.readFile(deps.paths.credentialsJson)
    if (text === undefined) return false
    try {
      const parsed = JSON.parse(text) as Record<string, unknown> | null
      if (typeof parsed !== 'object' || parsed === null) return false
      // credentials.json 的真实形状是 { keys: { deepseek, kimi_web } }(credentials.ts);顶层也认,免得哪天扁平化。
      const keys = parsed.keys
      const nested = typeof keys === 'object' && keys !== null ? (keys as Record<string, unknown>).kimi_web : undefined
      const value = nested ?? parsed.kimi_web
      return value !== undefined && value !== null && value !== ''
    }
    catch { return false }
  }

  async function wiredOf(key: ClientKey): Promise<boolean> {
    if (key === 'claude') return claudeWired()
    if (key === 'codex') return codexWired()
    if (key === 'kimi') return kimiWired()
    // 微信/企微:聊天应用,没有额度、没有「接」这一步 —— **永远不算接上**(2026-09-25,见文件头)。
    return false
  }

  function compose(snap: ScanSnapshot): ClientsView {
    const out = {} as Record<ClientKey, ClientAreaView>
    for (const key of CLIENT_KEYS) {
      const installed = snap.installed[key] === true
      // 没装的那家 connected 一律 false:装都没装,"接上了"是句假话。
      const connected = installed && snap.wired[key] === true
      // how 只给有额度的那几家:聊天应用没有「下一步」可说(D13,写一句空话不如缺席)。
      const how = QUOTA_CLIENT_KEYS.includes(key) ? HOW[key] : undefined
      out[key] = {
        installed,
        connected,
        ...(installed && !connected && how !== undefined ? { how } : {}),
      }
    }
    return out
  }

  async function runScan(): Promise<ClientsView | undefined> {
    const installed: Partial<Record<ClientKey, boolean>> = {}
    const wired: Partial<Record<ClientKey, boolean>> = {}
    let probed = 0
    for (const key of CLIENT_KEYS) {
      const probe = await probeInstalled(deps.io, bundleOfClient(key))
      if (probe === undefined) continue
      probed += 1
      installed[key] = probe.found
      // 没装就不必再去读它的配置文件 —— 省几次 I/O,结论也一样(没装 = 不显示)。
      wired[key] = probe.found ? await wiredOf(key) : false
    }
    checkedAt = deps.now()
    // 一家都探不出来(Spotlight 关了 / mdfind 不在) → 整格缺席,不冒充"都没装"。
    if (probed === 0) {
      snapshot = undefined
      return undefined
    }
    snapshot = { installed, wired }
    return compose(snapshot)
  }

  return {
    view: () => (snapshot === undefined ? undefined : compose(snapshot)),
    pump: () => {
      if (scanning) return
      if (checkedAt !== undefined && deps.now() - checkedAt < rescanMs) return
      scanning = true
      // fire-and-forget:扫得慢不该拖住 /state(同 setup/service.ts 的 pump)。
      void runScan().catch(() => {}).finally(() => { scanning = false })
    },
    scan: runScan,
    invalidate: () => { checkedAt = undefined },
    installedKeys: () => {
      if (snapshot === undefined) return undefined
      return new Set(CLIENT_KEYS.filter(key => snapshot?.installed[key] === true))
    },
  }
}

/**
 * 一份 hooks 配置里,**工作台自己的**那几条命令指着的脚本路径(新位置或旧位置)。
 *
 * 只认 `hooks` 那一棵,**不看 statusLine**:状态栏是显示用的,少了它照样收得到事件 ——
 * 拿它当"没接上"的证据会误伤(他自己配过一条状态栏时,代写那边是**不动**它的)。
 */
export function wbHookCommands(configText: string): readonly string[] {
  return claudeHookPaths(configText).paths.filter(path => wbHooksMentionsOurScript(path))
}

/**
 * `~/.claude/settings.json` 里有几条 hook、它们指到哪些路径。
 *
 * 跟 setup/status.ts 的 `claudeHooksPointAt` 是同一套走法,但**这里不看 statusLine**(理由同上)。
 * Codex 的 hooks.json 形状不同,但这个走法是"把整棵树走一遍收 command",两边都吃得下。
 */
export function claudeHookPaths(settingsText: string): { hooks: number, paths: readonly string[] } {
  let parsed: unknown
  try { parsed = JSON.parse(settingsText) }
  catch { return { hooks: 0, paths: [] } }
  const root = (parsed ?? {}) as Record<string, unknown>
  const paths = new Set<string>()
  let hooks = 0
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (typeof record.command === 'string') {
      hooks += 1
      for (const found of record.command.match(/\/[^\s"']+/g) ?? []) paths.add(found)
    }
    for (const child of Object.values(record)) walk(child)
  }
  walk(root.hooks)
  return { hooks, paths: [...paths] }
}
