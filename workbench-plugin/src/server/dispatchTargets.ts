/**
 * **能接活的有哪几家 —— 只问登记表**(2026-09-25,卡 Z;设计 `docs/设计-Agent自动发现与统一接入-2026-09-25.md`
 * 第一节第 1、6 条)。
 *
 * 维护者 09-25 原话:「要是写死了就很糟糕了,这次不能说你把写死的范围增加到 6 个,你得想个机制,
 * 后面检测到是 Agent,有会话窗口的这种都得能有气泡和会话状态、标题、内容」。卡 Q 把界面改成读登记表之后,
 * 还剩三处在读写死的名单 —— 派活候选、能力体检、额度列表。这个文件就是那三处共用的**一份候选**:
 *
 * - **有哪几家**:登记表里判成 Agent、接上了的每一家(`AgentRegistryView.entries`),外加只走接口、
 *   连 App 都没有的那几家(今天 = GPT;接口接得上、**而且中转上真配了它那一家上游**才列 ——
 *   2026-09-26 卡 GH「中转配了哪家才出现哪家」,判据在 `relayProviders.ts`)。名单在代码里**一处都没有了**。
 * - **每家几只手**:有本机 App(登记表给了 `bundle_id`)→ 窗口那只手;`agentSources.ts` 里给它写过命令行 /
 *   接口的 → 再加上那一只。新发现的一家什么都没写过,于是只有窗口那只手 —— 这正是「不改代码就能派活」。
 * - **叫什么、什么颜色**:登记表里的 `name` / `color`(有专门接法的那几家用那一路的名字)。
 *
 * 老宿主 / 还没接发现引擎的那一路有个兜底(`fallbackTargets`):按「工作台为哪几个 App 写过专门代码」
 * (`FAMILY_SOURCES`)+ 这台电脑上装没装 拼一份,行为与 09-25 之前一字不变。**接了发现引擎就完全由登记表说话**,
 * 兜底一条都不掺 —— 不然「登记表里没有它」与「名单里有它」又会两边打架。
 *
 * 全是纯函数。
 */
import type { AgentEntryView, AgentRegistryView, DispatchHand } from '../protocol.ts'
import { dispatchUnreadableSay } from '../protocol.ts'
import { FAMILY_SOURCES, bindingFor, openCommandFor } from './agentSources.ts'
import type { RelayProvidersView } from './relayProviders.ts'
import { relayHasProviderFor } from './relayProviders.ts'

/** 派活 / 体检 / 额度共用的一家。 */
export interface DispatchTarget {
  /** 登记表 id,也就是派活的家名(`TaskDispatch.family`)。 */
  id: string
  /** 显示名(登记表里的名字)。界面上、确认点里念的都是它。 */
  title: string
  /** 它那个 App 的包标识。缺席 = 没有本机 App(只走接口那几家)。 */
  bundle_id?: string
  /** 它此刻开着没(登记表报的)。不知道就缺席。 */
  app_running?: boolean
  /** 按顺序有哪几只手(第一只送不进去才退到第二只)。 */
  hands: readonly DispatchHand[]
  /** 怎么把它拉起来。没有 App 的缺席。 */
  open?: readonly string[]
  /** 窗位叠里那家的老键(按包标识反查不到时退回它)。 */
  dock_key?: string
  /** 它的会话流(`/state.sessions` 里的 agent);只有写过专门会话读法的那几家有。 */
  feed?: string
  /** 它在界面上的颜色(登记表里算好的那一格)。 */
  color?: string
  /** 名字之外、他在原话里点名它时会写的字。 */
  aliases: readonly string[]
  /**
   * **这一家在这台电脑上装着的那几个 App**(2026-09-28,卡 DP;只有装着两个以上时才有这一格)。
   *
   * 豆包那一家在维护者两台机器上都同时装着 `com.bot.pc.doubao`(Doubao)与
   * `com.work.pc.doubao`(豆包工作)。候选照旧**一家一条**(界面上不该冒出两家),
   * 但派的那一刻要挑一个包 —— 挑法在 `agentSources.pickFamilyPackage` 一处,这一格是它的输入。
   */
  packages?: readonly { bundle_id: string, name: string, running?: boolean }[]
  /** 这一条是登记表给的(不是兜底拼的)。 */
  from_registry: boolean
  /**
   * ★ **这一家此刻能做哪几样**(2026-10-02,卡「引擎接线与删复制品」;引擎登记处现查的那一份)。
   *
   * 从前「有哪几家」与「每家会什么」是同一道门:`agentDiscovery` 只在**窗口结构三样都认得出**
   * (对话区 / 输入框 / 发送键)时才把一家标成 `connected`,而候选 = `connected` 的那几家。
   * 后果在 Air 上看见了:Kimi(kmp 版输入框是 `AXUnknown`)永远不在 @ 候选里;Codex 关了窗就掉出候选。
   *
   * 现在两件事分开:**存在**= 家族目录认识 + 这台装着(`here`);**能做什么** = 各适配器现查(这一格)。
   * 缺席 = 引擎还没接上 / 还没探完(老宿主、用例)—— 照旧只看有没有 App,一字不变。
   */
  can?: {
    open: boolean
    send: boolean
    read: boolean
    press: boolean
    approve: boolean
    writeAsk: boolean
    stop: boolean
    openSession: boolean
  }
  /**
   * **写进去到什么程度**:`full` 认得出输入框;`paste_only` 自绘界面(读得到、写入靠粘贴)。
   * 界面上念「写入靠粘贴」,**不把它判成「没接上」**(那样整家就派不了活了)。
   */
  write?: 'full' | 'paste_only'
}

/**
 * 这一家按顺序有哪几只手。**顺序就是尝试的顺序**(Ben 09-21 定的:派活是直接操作窗口槽里的客户端,
 * 用户手里是订阅不是 Key,所以窗口在最前;命令行只在 Ben 09-22 的 A3 里留给 Codex 当备用;接口垫底)。
 *
 * ★ 写代码的活另算:那一类只用「能在指定目录里改文件、又不用人在电脑前批」的那只手
 * (`dispatchChoice.handsFor` → `agentCaps.hasCodeCli`),与这里的顺序无关。
 */
export function handsOf(input: { id: string, hasApp: boolean, apiConfigured?: boolean | undefined }): readonly DispatchHand[] {
  const binding = bindingFor(input.id)
  const hands: DispatchHand[] = []
  if (input.hasApp && binding?.noWindow !== true) hands.push('window')
  if (binding?.cliBackup === true) hands.push('cli')
  /*
   * ★ 2026-09-27(卡 MS):**中转上明说没配这一家,接口这只手就不给它**。
   *
   * 21:23 那一通派给豆包:窗口那只手没送成,于是退到接口那只手 —— 而服务器上压根没配豆包那把 Key,
   * 换回来的是一句 503,最后写到卡上、念给他听的是「接口:服务器没配…」。没配的东西不该去试,
   * 更不该把它写进给他看的失败原因(维护者原话:「这条兜底在没配时就别尝试」)。
   *
   * **只在确凿知道没配时才去掉**(`apiConfigured === false`):没问到过(缺席)照老样子留着 ——
   * 不猜(D13),宁可试一次也不因为一次 /health 没通就把一条能用的路拆掉。
   */
  if (binding?.api === true && input.apiConfigured !== false) hands.push('api')
  // 一只手都没有的(只有会话记录、App 没装):照旧按窗口那只手记 —— 派的时候会如实说「这台电脑上没装它」。
  return hands.length > 0 ? hands : ['window']
}

function targetOf(input: {
  id: string
  title: string
  bundle_id?: string | undefined
  app_running?: boolean | undefined
  color?: string | undefined
  from_registry: boolean
  /** 中转上配了这一家上游没有。`false` = 确凿没配(接口那只手不给它);缺席 = 不知道,照老样子。 */
  api_configured?: boolean | undefined
}): DispatchTarget {
  const binding = bindingFor(input.id)
  const bundleId = input.bundle_id ?? binding?.bundle_id
  const open = openCommandFor(input.id, bundleId)
  return {
    id: input.id,
    title: input.title,
    ...(bundleId === undefined ? {} : { bundle_id: bundleId }),
    ...(input.app_running === undefined ? {} : { app_running: input.app_running }),
    hands: handsOf({ id: input.id, hasApp: bundleId !== undefined, ...(input.api_configured === undefined ? {} : { apiConfigured: input.api_configured }) }),
    ...(open === undefined ? {} : { open }),
    ...(binding?.dockKey === undefined ? {} : { dock_key: binding.dockKey }),
    ...(binding?.feed === true ? { feed: input.id } : {}),
    ...(input.color === undefined ? {} : { color: input.color }),
    aliases: binding?.aliases ?? [],
    from_registry: input.from_registry,
  }
}

/** 一条登记表条目 → 一家候选。事务官自己不是候选(「派给事务官」= 她自己办,不是一次派活)。 */
export function targetFromEntry(entry: AgentEntryView, providers?: RelayProvidersView | undefined): DispatchTarget | undefined {
  if (entry.self === true || entry.id === 'dsh') return undefined
  return targetOf({
    id: entry.id,
    title: entry.name,
    bundle_id: entry.bundle_id,
    app_running: entry.app_running,
    color: entry.color,
    from_registry: true,
    // 中转问到过、而且这一家不在里面 → 接口那只手不给它(卡 MS)。没问到过就不说话。
    ...(providers === undefined ? {} : { api_configured: relayHasProviderFor(entry.id, providers) }),
  })
}

export interface DispatchTargetsInput {
  /** 登记表此刻的样子(`agents.view()`)。缺席 = 还没接发现引擎,走兜底。 */
  registry?: AgentRegistryView | undefined
  /** 接口那只手接得上(只走接口的那几家要它才列得出来)。 */
  apiReady?: boolean | undefined
  /**
   * 中转上配了哪几家上游(`/health` 的 `providers`,2026-09-26 卡 GH)。
   * **缺席 = 从没问到过 → 当一家都没配**:于是只走接口的那几家一家都不列 —— 宁可少一家,不摆空壳。
   */
  relayProviders?: RelayProvidersView | undefined
  /** 那家的 App 装在这台电脑上没有(**只给兜底那一路用**)。 */
  installed?: ((id: string) => boolean) | undefined
  /**
   * **这台电脑上探到装了的那几家**(`/state.installed_agents` 的 `agents`,卡 HC)。
   *
   * 2026-09-28(卡 CF,维护者新 Air):`installed_agents` 里有 Codex(`com.openai.codex`),
   * 而 `agent_registry` 里一条都没有 —— 登记表要它**跑过一次**(巡检读到窗口)或者有会话文件才登记,
   * 而那台机器上 Codex 刚装、没开过。于是「让 Codex 办」在电话里成了「这台电脑上还没接上 codex」,
   * 可它就装在那儿。
   *
   * 所以候选 = 登记表那几家 **+ 探到装了、登记表里还没有的那几家**(窗口那只手;真派的时候
   * `ensureRunning` 会按包标识把它拉起来,拉不起来照旧如实说)。**装了 = 能派**,与「界面上显示哪几家」
   * 同一份探测,于是「能派谁」只有一份答案。探不到那一格(缺席)时一字不变。
   */
  installedAgents?: readonly {
    id: string
    name: string
    bundle_id?: string
    /** 这一家装着的那几个包(卡 DP;探测报的,只有两个以上时才有)。`running` 拿不到就缺席。 */
    packages?: readonly { bundle_id: string, name: string, running?: boolean }[]
  }[] | undefined
  /**
   * ★ **引擎登记处那一份候选**(2026-10-02;`engine/registry.ts` 的 `targetsNow()`)。
   *
   * 两件事靠它:
   * ① **补上登记表与本机探测都漏掉的那几家** —— 目录认识它、某条通道此刻答应得上(Codex 关了窗、
   *    `app-server` 好好的那一种),或者探不出装没装(壳没连上 / Spotlight 关了:`here:'unknown'`,
   *    「查不到」不许冒充「没有」);
   * ② 给每一家挂上 `can` / `write`(能做什么 = 适配器现查,见 {@link DispatchTarget.can})。
   *
   * 缺席 = 引擎还没接上(老宿主 / 用例)→ 行为与这一版之前一字不变。
   */
  engineTargets?: readonly {
    family: string
    name: string
    bundle_id?: string
    can: NonNullable<DispatchTarget['can']>
    write?: 'full' | 'paste_only'
    here: 'package' | 'channel' | 'unknown'
  }[] | undefined
}

/**
 * 能接活的每一家。顺序:登记表里认出来的先后(事务官自己不算),最后是只走接口、没有 App 的那几家。
 * 兜底那一路按 `FAMILY_SOURCES` 的顺序(Claude、Codex、Kimi、豆包、Muse、Manus),与 09-25 之前一字不变。
 */
export function dispatchTargets(input: DispatchTargetsInput): readonly DispatchTarget[] {
  const out: DispatchTarget[] = []
  const seen = new Set<string>()
  const push = (target: DispatchTarget | undefined): void => {
    if (target === undefined || seen.has(target.id)) return
    seen.add(target.id)
    out.push(target)
  }
  if (input.registry !== undefined) {
    for (const entry of input.registry.entries) push(targetFromEntry(entry, input.relayProviders))
  }
  else {
    for (const target of fallbackTargets(input.installed)) push(target)
  }
  /*
   * ★ **装了、登记表里还没有的那几家也能派**(2026-09-28,卡 CF;理由见 `installedAgents`)。
   * 排在登记表那几家后面、按包标识去重:同一家在两边都出现时,登记表那条(有名字、有开没开)说话。
   */
  for (const one of input.installedAgents ?? []) {
    if (one.id === 'dsh' || one.id.trim() === '' || one.bundle_id === undefined || one.bundle_id.trim() === '') continue
    if (out.some(target => target.bundle_id === one.bundle_id)) continue
    push(targetOf({
      id: one.id,
      // 有专门接法的那一家用那一路的名字(界面上一直这么叫它);别的用探测报的那个。
      title: bindingFor(one.id)?.name ?? one.name,
      bundle_id: one.bundle_id,
      from_registry: false,
      ...(input.relayProviders === undefined ? {} : { api_configured: relayHasProviderFor(one.id, input.relayProviders) }),
    }))
  }
  /*
   * ★ **一家装着两个 App 时,两个都挂在这一家身上**(2026-09-28,卡 DP)。
   * 候选照旧一家一条(界面上不该冒出两家),派的那一刻由 `pickFamilyPackage` 挑一个 ——
   * 这一格就是它的输入。登记表那一路也吃得到:这一家在探测里有几个包,与它是从哪来的无关。
   */
  for (const one of input.installedAgents ?? []) {
    const packages = one.packages ?? []
    if (packages.length < 2) continue
    const target = out.find(had => had.id === one.id)
    if (target === undefined) continue
    target.packages = packages
  }
  /*
   * ★ **引擎登记处说「这一家在这台电脑上」的,也进候选**(2026-10-02;见 {@link DispatchTargetsInput.engineTargets})。
   *
   * 排在登记表与本机探测之后 —— 那两边有它时按那一条说话(有名字、有开没开、有几个包)。
   * 事务官自己不进(`targetOf` 那一层不会给 `dsh` 发手,这里也按家名跳过)。
   */
  for (const one of input.engineTargets ?? []) {
    if (one.family === 'dsh' || one.family.trim() === '') continue
    if (out.some(target => target.id === one.family)) continue
    /*
     * ★ **`here:'unknown'` 的不进候选**:那一档的意思是「目录认识它,可**这台探不出装没装**」
     * (Spotlight 关了 / 壳没连上)。引擎自己的候选名单照旧列着它(「查不到」不许冒充「没有」),
     * 但「现在能派谁」要是把它摆出来,她点下去只会撞一鼻子灰 —— 这里要的是**探到了**:
     * 有包(`package`)、或者某条通道此刻真答应得上(`channel`,Codex 关了窗、app-server 好着那一种)。
     */
    if (one.here === 'unknown') continue
    push(targetOf({
      id: one.family,
      title: bindingFor(one.family)?.name ?? one.name,
      ...(one.bundle_id === undefined ? {} : { bundle_id: one.bundle_id }),
      from_registry: false,
      ...(input.relayProviders === undefined ? {} : { api_configured: relayHasProviderFor(one.family, input.relayProviders) }),
    }))
  }
  /*
   * ★ **每一家能做什么、写进去到什么程度:只问引擎登记处**(适配器现查)。
   * 这一格不参与「有哪几家」—— 存在与能力分开,正是「四件套的根子」那一条。
   */
  for (const one of input.engineTargets ?? []) {
    const target = out.find(had => had.id === one.family)
    if (target === undefined) continue
    target.can = one.can
    if (one.write !== undefined) target.write = one.write
  }
  /*
   * 只走接口、连 App 都没有的那几家(今天 = GPT)。**两道门都得过**:
   *
   * 1. 接口那只手接得上(列了也是一颗点了没反应的);
   * 2. ★ 中转上真配了它那一家上游(2026-09-26,卡 GH)——线上那台中转 `/health` 回的是 `openai:false`,
   *    派过去只会换回 503「服务器没配 OpenAI」。**代码路径一条都没删**:哪天服务器上加了那把 Key,
   *    `/health` 一变,GPT 自己回到名单、额度面板、技能表里(见 `agentSources.ts` 文件头)。
   */
  if (input.apiReady === true) {
    for (const binding of FAMILY_SOURCES) {
      if (binding.api !== true || binding.bundle_id !== undefined) continue
      if (!relayHasProviderFor(binding.agent, input.relayProviders)) continue
      push(targetOf({ id: binding.agent, title: binding.name, from_registry: false }))
    }
  }
  return out
}

/**
 * 没接发现引擎时的那一份(老宿主、大多数用例):写过专门代码、而且**装在这台电脑上**的那几家。
 * `installed` 缺席时把有 App 的都算上(用例里的老行为)。
 */
export function fallbackTargets(installed?: (id: string) => boolean): readonly DispatchTarget[] {
  return FAMILY_SOURCES
    .filter(one => one.self !== true && one.bundle_id !== undefined && one.noWindow !== true)
    .filter(one => installed === undefined || installed(one.agent))
    .map(one => targetOf({ id: one.agent, title: one.name, bundle_id: one.bundle_id, from_registry: false }))
}

/**
 * 写过专门接法的每一家(含只走接口、连 App 都没有的 GPT)。
 * **只给「认他原话里点了哪一家的名」当退路**(`familiesIn` / `dispatchFamilyOf`),不当派活候选用。
 */
export function knownFamilyTargets(): readonly DispatchTarget[] {
  return FAMILY_SOURCES
    .filter(one => one.self !== true)
    .map(one => targetOf({ id: one.agent, title: one.name, bundle_id: one.bundle_id, from_registry: false }))
}

/** 名字(登记表里的)。表里没有这一家就原样用 id —— 不猜一个名字出来。 */
export function targetTitle(targets: readonly DispatchTarget[], id: string): string {
  return targets.find(one => one.id === id)?.title ?? bindingFor(id)?.name ?? id
}

/** 这一家在候选里吗(HTTP 入口把关用:名字打错了当场知道)。 */
export function isDispatchTarget(targets: readonly DispatchTarget[], id: unknown): boolean {
  return typeof id === 'string' && targets.some(one => one.id === id)
}

/**
 * 能力体检那几家(`AgentCapsDeps.families` 吃的就是这一份):登记表里接上了、**有本机窗口**的那几家。
 * 接线(`src/index.ts`)与用例走同一个函数 —— 两处各拼一遍迟早会漂。
 */
export function capTargetsFor(input: DispatchTargetsInput): readonly { id: string, title: string }[] {
  return windowTargets(dispatchTargets(input)).map(one => ({ id: one.id, title: one.title }))
}

/**
 * **认出是 AI 应用、可那扇窗读不到**的那一家(登记表 `unreadable` 那一截的子集;
 * 用例与别的消费方只要这三格,不必拼整条 `AgentUnreadableView`)。
 */
export interface UnreadableApp {
  /** 登记表 id:认得出这一家的就是家名(`kimi`),认不出的就是包标识(`com.electron.klingai`)。 */
  id: string
  /** 显示名(登记表现成的那一份;说话用它,不写死任何一家的名字)。 */
  name: string
  bundle_id: string
}

/**
 * **同一家装着的包里读得到的那几个**(2026-10-03,运营维护包审计末节第二项;接缝:家族目录与别名表)。
 * 登记表 `unreadable` 那一截里有的包剔掉;窗口那条通道挑包时只在它们里面挑。
 */
export function readablePackagesOf<T extends { bundle_id: string }>(installed: readonly T[] | undefined, unreadable: readonly UnreadableApp[] | undefined): T[] {
  const bad = new Set((unreadable ?? []).map(one => one.bundle_id))
  return (installed ?? []).filter(one => one.bundle_id.trim() !== '' && !bad.has(one.bundle_id))
}

/**
 * **窗口这一条通道:这一家此刻读不读得到 —— 按具体包判**(外层 {@link unreadableBlockOf} 的内层那一半,同一个接缝)。
 *
 * - 点名要哪个包(`said`)→ 只看那一个包读不读得到(不偷换成同家另一个包);
 * - 这一家装着一个读得到的包 → 不拦(App Store 版豆包读不到、豆包办公接着);
 * - 一个读得到的包都没装(新版 Kimi:一个包都解析不出)→ 退回按家名 / 包标识 / 解析出的那个包对。
 */
export function unreadablePackageHit(input: {
  family: string
  unreadable?: readonly UnreadableApp[] | undefined
  installed?: readonly { bundle_id: string }[] | undefined
  said?: string | undefined
  resolved?: () => string | undefined
}): UnreadableApp | undefined {
  const list = input.unreadable ?? []
  if (list.length === 0) return undefined
  if (input.said !== undefined && input.said.trim() !== '') return list.find(one => one.bundle_id === input.said)
  if (readablePackagesOf(input.installed, list).length > 0) return undefined
  const bundle = input.resolved?.()
  return list.find(one => one.id === input.family || one.bundle_id === input.family || (bundle !== undefined && one.bundle_id === bundle))
}

/**
 * ★ **派给这一家等于派进一口井 —— 当场拦下**(2026-10-01,卡「派给读不到的那家当场说」)。
 *
 * 判据(三样都要对上一样才算,**一家只有一条能走的路也不拦**):
 *
 * 1. `unreadable` 里有这一家 —— 按**家名**对(`kimi`),或者按**包标识**对
 *    (登记表认不出它、id 就是包标识的那几家:可灵 `com.electron.klingai`);
 * 2. 这一家在候选里**没有**(新版 Kimi 这一类:登记表不收它、本机探测的候选也从登记表长,
 *    于是 `dispatchTargets` 里一条都没有)—— 或者有、可它**每一个包都读不到**而且没有别的手;
 * 3. 反过来:**同一家还有一条读得到的路就不拦**。Air 上 App Store 版豆包
 *    (`com.bot.neotix.doubao`)读不到,而豆包办公(`com.work.pc.doubao`)好好地接着 ——
 *    两个包同属 `doubao` 一家,拦了她就再也派不了豆包。所以「登记表里接上了的那一条」(`from_registry`)
 *    一律算读得到;接口 / 命令行那两只手也算(窗口读不到不影响它们)。
 */
export function unreadableBlockOf(input: {
  family: string
  targets: readonly DispatchTarget[]
  unreadable?: readonly UnreadableApp[] | undefined
}): UnreadableApp | undefined {
  const list = input.unreadable ?? []
  if (list.length === 0) return undefined
  const target = input.targets.find(one => one.id === input.family)
  const bundles = target === undefined
    ? []
    : [...(target.bundle_id === undefined ? [] : [target.bundle_id]), ...(target.packages ?? []).map(one => one.bundle_id)]
  const hit = list.find(one => one.id === input.family || one.bundle_id === input.family
    || (bundles.length > 0 && bundles.includes(one.bundle_id)))
  if (hit === undefined) return undefined
  if (target === undefined) return hit
  // 登记表里接上了的那一条 = 真读到过它的窗口;接口 / 命令行那两只手与窗口读不读得到无关。
  if (target.from_registry) return undefined
  if (target.hands.some(hand => hand !== 'window')) return undefined
  const unreadableBundles = new Set(list.map(one => one.bundle_id))
  return bundles.length > 0 && bundles.every(one => unreadableBundles.has(one)) ? hit : undefined
}

/**
 * **这一家此刻派不派得出去 —— 同步就能判的那一半**(2026-09-28,卡 CF)。
 *
 * 真机上那两通电话最伤人的一处不是派不出去,是**顺序**:工具回「成了:记下了……正在派给 豆包办公」,
 * 她照着说「派出去了,豆包在查」,十几秒后才「插一句:没成」。维护者:「我的脑子要炸了」。
 *
 * 「送不送得进那扇窗」确实要等壳(异步),但「**这台电脑上有没有这一家**」是当场就知道的 ——
 * 一份候选(`dispatchTargets`:登记表 + 本机探测)里找不到它,后面那一串重试一步都不用做。
 * 所以派活在开口之前先过这一道:
 *
 * - 找不到这一家 → 当场说「这台电脑上还没接上 X;现在能派的是 …」,卡挂「等你处理」,**不建「在办」**;
 * - 找到了、但一只手都没有(没窗口、没命令行、接口也没配)→ 同上,说清没有手。
 *
 * 纯函数;派活那一层(`dispatchRun`)与建卡回话那一层(`http.ts`)用的是同一份判断 ——
 * 两处各判一遍,迟早会出现「一边说能派、一边说没接上」。
 */
export function dispatchReadiness(input: {
  family: string
  targets: readonly DispatchTarget[]
  /**
   * **认出是 AI 应用、可那扇窗读不到**的那几家(登记表的 `AgentRegistryView.unreadable`,2026-10-01)。
   * 给了就先过这一道:派给它们一个字都送不进去,当场说、不折腾(见 `unreadableBlockOf`)。
   * 缺席 = 不知道(老宿主 / 用例)→ 一字不变。
   */
  unreadable?: readonly UnreadableApp[] | undefined
}): { ok: true, target: DispatchTarget } | { ok: false, why: string, unreadable?: true } {
  const target = input.targets.find(one => one.id === input.family)
  /*
   * 「能派的那几家」里**不摆读不到的那几家**:摆了等于把她从一口井推进另一口井。
   * 多半一条都滤不掉(那几家压根不在候选里),这一道是防着「候选里有它、每个包都读不到」那一种。
   */
  const others = windowTargets(input.targets)
    .filter(one => one.id !== input.family
      && unreadableBlockOf({ family: one.id, targets: input.targets, unreadable: input.unreadable }) === undefined)
    .map(one => one.title)
  const who = targetTitle(input.targets, input.family)
  const blocked = unreadableBlockOf({ family: input.family, targets: input.targets, unreadable: input.unreadable })
  if (blocked !== undefined) {
    return { ok: false, why: dispatchUnreadableSay({ name: blocked.name, others }), unreadable: true }
  }
  if (target === undefined) {
    return {
      ok: false,
      why: others.length === 0
        ? `这台电脑上还没接上任何一家能接活的 AI,所以 ${who} 这件派不出去`
        : `这台电脑上还没接上 ${who};现在能派的是 ${others.join('、')}`,
    }
  }
  // 手是按「有没有 App / 写过命令行 / 接口配了没」算出来的(`handsOf`);一只都没有 = 派不出去。
  const hasHand = target.hands.some(hand => hand !== 'window') || target.bundle_id !== undefined
  if (!hasHand) return { ok: false, why: `${who} 在这台电脑上没有能接活的那只手(没有它的 App,接口也没配)` }
  return { ok: true, target }
}

/** 有本机 App、能读能送窗口的那几家(能力体检就是这几家;只走接口的 GPT 不在里面)。 */
export function windowTargets(targets: readonly DispatchTarget[]): readonly DispatchTarget[] {
  return targets.filter(one => one.bundle_id !== undefined)
}

/**
 * 报给壳的允许名单(`agent_allow`):**一家的每个包都报**(2026-10-01 Air 诊断包)。
 * 以前只报登记表给的那一个包;一家装着两个时,派活挑中 / 换到另一个,壳会当场拒掉。去重、排序。
 */
export function allowBundlesOf(targets: readonly DispatchTarget[]): string[] {
  const out = new Set<string>()
  for (const one of targets) {
    if (one.bundle_id !== undefined) out.add(one.bundle_id)
    for (const pkg of one.packages ?? []) out.add(pkg.bundle_id)
  }
  return [...out].sort()
}
