/**
 * 几种**专门的读法**挂在登记表的哪一条上(2026-09-25,卡 Q「Agent 自动发现与统一接入」)。
 *
 * ## ★ 这张表里有一条 ≠ 这台电脑上出现这一家(2026-09-26,卡 GH)
 *
 * 维护者 09-26 问「派活名单里的 GPT 是个空壳,可以删掉是吧」。**答案是不删,改成一条机制**:
 * **中转配了哪家才出现哪家**。
 *
 * - 接口那只手(`api: true`)发出去的请求经我们自己的中转(`relay/`)转给上游,中转按模型名前缀挑上游;
 *   服务器上没配那一家的 Key 时,派过去只会换回 503(`openai_not_configured`)。
 * - 所以工作台起来后会问一次中转的 `/health`(`server/relayProviders.ts`),拿 `providers` 那一格:
 *   **该家没配 → 接口那只手不可用**;`noWindow: true` 且接口不可用的那一家(今天 = GPT)
 *   **整家不出现** —— 不进派活名单(`dispatchTargets`)、不进额度面板、不进事务官技能里那张
 *   「这台电脑上现在怎么派」的表、不进设置里各家能力那一页。
 * - 豆包这种**还有窗口那只手**的照常在,只是接口那一只标成不可用(「中转没配这家」)。
 *
 * ★ **代码路径一条都没删,下面 GPT 那条也留着**:哪天服务器上加一行 `RELAY_OPENAI_KEY`
 * (变量名见 `relay/server/providers.cjs` 的 `PROVIDER_ENV`),`/health` 一变,
 * GPT 自己回到名单、额度面板、技能表、@ 候选里 —— 一行代码都不用改、不用发版。
 *
 * 设计第 1 条:「Claude/Codex/Kimi 现在专门的读法(会话文件、命令行)保留,作为这几家『更细的来源』挂在各自的
 * 登记条目上,**不再当名单用**。」所以这张表回答的不是「有哪几家 Agent」(那是登记表的事,运行时发现的),
 * 而是「工作台里写好了的那几种会话读法,各自读的是哪个 App」—— 每种读法本来就是为某一个 App 写的代码,
 * 它读的是谁是它自己的事实。
 *
 * - 某一家被发现了(窗口那条路),而它恰好有一种专门读法:两路都挂上,专门那一路更细(会话一条一条、有项目、有等待原因),
 *   先用它;它一条会话都没有时退回读窗口。
 * - 某种专门读法读到了会话,但那家 App 还没被发现(没开过、或者只用命令行):凭会话记录登记它(`found.how = 'sessions'`)。
 * - 事务官自己(DSH)没有桌面 App,它的会话就是它自己,永远在表里最前面。
 *
 * **登记表里这一家的 id**:有专门读法的,用那一路的 id(`claude` / `codex` / `kimi` / `dsh`)—— 事项卡上的 `links`、
 * `POST /read`、`GET /sessions/digest` 认的都是它,换成包标识就对不上了;别的一律是它的包标识(`com.meta.endo`)。
 * 包标识始终在 `bundle_id` 那一格(窗口槽的标签按它对上登记条目)。
 */
/**
 * 同一家名下的**一个 App**(2026-09-28,卡 DP)。
 *
 * 豆包那一家在一台机器上能同时装着两个(`com.bot.pc.doubao` 与 `com.work.pc.doubao`),
 * 坞上、界面上是两个图标、两个名字,而派活按家名走 —— 所以每个包要记得住自己叫什么、
 * 她说哪几个字是专指它的。**都是真机上读出来的,不猜。**
 */
export interface FamilyPackage {
  bundle_id: string
  /** 这个包自己的显示名(回话里要说清派给了哪一个)。 */
  name: string
  /**
   * **只指这一个包**的说法。光说家里的小名(「豆包」)不写在这儿 ——
   * 那种说法哪一个都可能,按装机 / 窗口在不在挑(见 `pickFamilyPackage`)。
   */
  aliases?: readonly string[]
}

export interface SessionSourceBinding {
  /**
   * 登记表里这一条的 id,也就是**派活时这一家的家名**(`TaskDispatch.family`、额度适配器、事项卡的 `links` 认的都是它)。
   * 有专门读法的那几家用那一路的 id(`claude` / `codex` / `kimi` / `dsh` / `muse` / `manus` / `doubao` / `gpt`);
   * 别的一律是它的包标识 —— 那一种在这张表里根本不出现(表里只有写过专门代码的)。
   */
  agent: string
  /** 它读的是哪个 App。事务官自己、只走接口的那几家没有 App。 */
  bundle_id?: string
  /**
   * **同一家有几个 App**(2026-09-28,卡 CF 起头、卡 DP 补齐「挑哪一个」)。
   *
   * 维护者新 MacBook Air 上豆包办公的包标识是 `com.work.pc.doubao`,他旧机器上那个是
   * `com.bot.pc.doubao` —— 同一家在不同渠道/版本下包标识不同。只写一个的后果真机上看到了:
   * 登记表把那台上的豆包登记成 **id = 包标识、名字 =「豆包工作」**,而电话里派活按家名 `doubao` 找,
   * 于是「这台电脑上还没接上 doubao;现在能派的是 豆包工作」——同一个 App 被说成两家。
   *
   * ★ 卡 CF 只做到「两个包都认成同一家」;2026-09-28 晚发现**同一台机器上两个都装着**
   * (Air 上既有 `com.bot.pc.doubao`「Doubao」又有 `com.work.pc.doubao`「豆包工作」),
   * 于是还缺一条规则:**她说的那几个字指哪一个**。所以这一格不只是包标识,还带各自的显示名与说法,
   * 挑哪一个由 `pickFamilyPackage` 一处说了算(派活、捎话、界面都问它)。
   *
   * 这一格里的每一个都**认成这一家**(`bindingForBundle`、本机探测的候选都过一遍),
   * 而 `bundle_id` 仍是主包(说不清时就是它)。**都是真机上读出来的,不猜**。
   */
  packages?: readonly FamilyPackage[]
  /** 显示名(登记表里这一条叫什么)。 */
  name: string
  /** 这一路来源怎么叫(人话)。 */
  label: string
  /** 事务官自己。 */
  self?: true
  /** 它有自己的会话流(`/state.sessions` 里 `agent` = 这个 id)。缺席 = 只有读窗口这一路。 */
  feed?: true
  /**
   * 没跑就拿这条命令把它拉起来。**缺席 = 按包标识拉**(`open -b <包标识>`)——
   * 新发现的一家不写代码也拉得起来;这里只留调研实测过、与 `apps.ts` 的 `APP_COMMANDS` 逐字相同的那几条。
   */
  open?: readonly string[]
  /** 窗位叠里那家的老键(`dock.switchTo` 认的是 registry 键)。按包标识反查不到时退回它。 */
  dockKey?: string
  /** 他在原话里点名这一家时会写的字(名字之外的写法:「豆包」/「doubao」)。名字本身不用写。 */
  aliases?: readonly string[]
  /**
   * 聊天的活**留着命令行当备用**(Ben 09-22 定的 A3)。今天只有 Codex:
   * Claude 那份桌面端登录态不给命令行用,他定了不单独登(写代码的活另算,见 `cliAllowedFor`)。
   */
  cliBackup?: true
  /** 走接口那只手(`dispatchApi.ts` 里给它配了模型)。 */
  api?: true
  /** 它没有自己那扇能送话的窗(GPT 与 Codex 是同一个 App,两家抢同一扇窗会互相盖掉)。 */
  noWindow?: true
  /**
   * **它会在窗口里摆一道选择题等她**(侧栏「待确认」+ 主区那一行标记 + 问题与选项,见 `doubaoVisibleForm`;
   * 标记各包写法不同,见 `isAskMarkerLine`),
   * 那个提问面板能替她点、能写进去(2026-10-12)。按**这一家**认:同一家的每个包都算,判断里不写包名。
   */
  askPanel?: true
}

/**
 * **工作台为哪几个 App 写过专门代码**(会话读法、命令行、接口、窗口上的额度正则、拉起它的命令)。
 *
 * ★ 这张表**不回答「有哪几家 Agent」** —— 那是登记表(运行时发现)的事。它只回答「某一家有没有更细的接法」:
 * 一条都没有的那一家(运行时新发现的)照样能被派活,走通用的那条路(读窗口那只手 + `open -b <包标识>`)。
 * 2026-09-25(卡 Z)把原来三张写死的名单(`AGENT_DISPATCH_FAMILIES` / `CLIENT_DISPATCH_FAMILIES` /
 * `CLIENT_DISPATCH_OPEN_COMMANDS`)删掉之后,剩下的就是这一份 —— 每一条都因为仓库里真有为它写的代码才在这儿。
 */
export const FAMILY_SOURCES: readonly SessionSourceBinding[] = [
  { agent: 'dsh', name: '事务官', label: '事务官自己的会话', self: true, feed: true },
  {
    agent: 'claude',
    bundle_id: 'com.anthropic.claudefordesktop',
    name: 'Claude',
    label: '它的会话记录',
    feed: true,
    open: ['open', '-a', 'Claude'],
    dockKey: 'claude',
  },
  // ChatGPT 桌面版与 Codex 是同一个 App(com.openai.codex),会话文件在 ~/.codex 下。
  {
    agent: 'codex',
    bundle_id: 'com.openai.codex',
    name: 'Codex',
    label: '它的会话文件',
    feed: true,
    open: ['open', '-a', 'ChatGPT'],
    dockKey: 'codex',
    cliBackup: true,
  },
  {
    agent: 'kimi',
    bundle_id: 'com.moonshot.kimichat',
    name: 'Kimi',
    label: '它的会话记录',
    feed: true,
    open: ['open', '-a', 'Kimi'],
    dockKey: 'kimi',
  },
  /*
   * 下面这几家**没有会话流**(读不到会话文件),会话靠读窗口;它们在这张表里,是因为各自有别的专门代码:
   * 豆包 —— 接口那只手的备用 + 额度「不限」那一格查实过的出处(`agentQuota.ts`);
   * Muse / Manus —— 窗口上读额度的那两条正则(`MUSE_WINDOW` / `MANUS_WINDOW`);
   * GPT —— 只有接口那只手(`dispatchApi.ts` 的模型),连 App 都没有。
   */
  /*
   * 豆包办公:两个包标识都是真机上读出来的(维护者旧机器 `com.bot.pc.doubao`、
   * 2026-09-28 新 Air `com.work.pc.doubao`),**两台都认得出是同一家**(卡 CF;见 `bundle_ids`)。
   */
  {
    agent: 'doubao',
    bundle_id: 'com.bot.pc.doubao',
    /*
     * 两条都是真机读出来的显示名:`com.bot.pc.doubao` 在 Air 的坞上写「Doubao」,
     * `com.work.pc.doubao` 写「豆包工作」。「豆包办公 / 豆包工作 / 办公豆包」这几个说法
     * **专指后一个**(她嘴里的「办公」= 那个办公版);光说「豆包」时哪一个都可能,
     * 于是按装机 / 窗口在不在挑(见 `pickFamilyPackage`)。
     */
    packages: [
      { bundle_id: 'com.bot.pc.doubao', name: '豆包' },
      { bundle_id: 'com.work.pc.doubao', name: '豆包工作', aliases: ['豆包工作', '豆包办公', '豆包办公模式', '办公豆包'] },
      // Mac App Store 版豆包(2026-10-01 Air 诊断包:她平时开着的就是这一个,工作台以前不认得)。
      { bundle_id: 'com.bot.neotix.doubao', name: '豆包' },
    ],
    name: '豆包办公',
    label: '读它的窗口',
    open: ['open', '-a', 'Doubao'],
    aliases: ['豆包', '豆包办公', '豆包工作', '豆包办公模式', 'doubao'],
    api: true,
    askPanel: true,
  },
  // Muse 是 Meta 的,bundle id 里的 endo 是它的内部代号(2026-09-24 本机读 Info.plist 读出来的)。
  { agent: 'muse', bundle_id: 'com.meta.endo', name: 'Muse', label: '读它的窗口', open: ['open', '-a', 'Muse'] },
  { agent: 'manus', bundle_id: 'im.manus.desktop', name: 'Manus', label: '读它的窗口', open: ['open', '-a', 'Manus'] },
  /*
   * GPT:只有接口那一只手。★ 它**出不出现**由中转说话(2026-09-26,卡 GH;见文件头):
   * `/health` 的 `providers.openai` 为真才进名单。线上那台此刻是 `false`(服务器上没配 OpenAI 的 Key),
   * 于是今天它一处都不出现;配上那一把 Key 之后这一条自己活过来 —— 所以**别删它**。
   */
  { agent: 'gpt', name: 'GPT', label: '经工作台中转的接口', api: true, noWindow: true },
]

/**
 * 有**自己的会话流**的那几路(登记表按它把 `/state.sessions` 分给各家)。
 * 由上面那张表现算,不另写一份字面量。
 */
export const SESSION_SOURCES: readonly SessionSourceBinding[] = FAMILY_SOURCES.filter(one => one.feed === true)

/** 登记表 id → 挂在它上面的专门接法。没有就 undefined(运行时新发现的那一家)。 */
export function bindingFor(entryId: string): SessionSourceBinding | undefined {
  return FAMILY_SOURCES.find(one => one.agent === entryId)
}

/**
 * 这一条认得出的**每一个包标识**(主的排在最前;没有 App 的那几条回空)。
 * 一处算出来,`bindingForBundle` 与本机探测的候选都用它 —— 两处各拼一遍迟早会漂。
 */
export function bundleIdsOf(binding: SessionSourceBinding | undefined): readonly string[] {
  return packagesOf(binding).map(one => one.bundle_id)
}

/**
 * 这一条认得出的**每一个 App**(主包排在最前;没有 App 的那几条回空)。
 * 只写了 `bundle_id`、没写 `packages` 的那几家 = 一条,名字就是这一家的名字。
 */
export function packagesOf(binding: SessionSourceBinding | undefined): readonly FamilyPackage[] {
  if (binding === undefined) return []
  const out: FamilyPackage[] = []
  const push = (one: FamilyPackage): void => {
    if (one.bundle_id.trim() === '' || out.some(had => had.bundle_id === one.bundle_id)) return
    out.push(one)
  }
  if (binding.bundle_id !== undefined) push({ bundle_id: binding.bundle_id, name: binding.name })
  for (const one of binding.packages ?? []) push(one)
  return out
}

/**
 * **一家装着几个 App 时,这一次派给哪一个**(2026-09-28,卡 DP;规则只在这里,派活/捎话/界面都问它)。
 *
 * 现场:维护者本机与 Air 上都同时装着两个豆包。卡 CF 把两个包都认成 `doubao` 一家之后,
 * 派活永远拿主包(`com.bot.pc.doubao`)—— 而他嘴里的「豆包工作 / 豆包办公」指的是另一个。
 *
 * 顺序(**先认她的话,再看这台电脑的事实,最不知道时才用主包**):
 * 1. 她原话里点了某个包**专有的说法**(「豆包工作」「豆包办公」)→ 就是它(该包装着才算;
 *    长的说法先匹配,不然「豆包工作」会被「豆包」抢走);
 * 2. 这台电脑上只装了一个 → 那一个;
 * 3. 两个都装着 → **窗口开着的那一个**(她正在用的那个);
 * 4. 都开着 / 都没开 → 主包(知识表的顺序)。
 *
 * `installed` 缺席 = 不知道装了哪几个(老宿主、用例)→ 主包,行为与这张卡之前一字不变;
 * `installed` 给了空数组 = 探过、一个都没装 → **回 undefined**,由上层说「这台电脑上还没接上」。
 * 知识表里没有这一家(运行时新发现的)→ undefined,调用方照旧用它自己那个包标识(不猜)。
 *
 * 回话里要**说清派给了哪一个**(`name`)—— 两个同名的 App 摆在坞上,不说她不知道去哪扇窗看。
 */
export function pickFamilyPackage(input: {
  family: string
  /** 她的原话 / 她点的那个名字(认不出就不影响别的几条)。 */
  said?: string | undefined
  /** 这台电脑上探到装了的那几个包(缺席 = 不知道)。 */
  installed?: readonly { bundle_id: string, running?: boolean }[] | undefined
}): { bundle_id: string, name: string, why: 'said' | 'only' | 'running' | 'default' } | undefined {
  const packages = packagesOf(bindingFor(input.family))
  if (packages.length === 0) return undefined
  const primary = packages[0] as FamilyPackage
  if (input.installed === undefined) return { bundle_id: primary.bundle_id, name: primary.name, why: 'default' }
  const here = packages.filter(one => input.installed?.some(had => had.bundle_id === one.bundle_id) === true)
  if (here.length === 0) return undefined
  const said = input.said ?? ''
  if (said.trim() !== '') {
    // 长的说法先匹配:「豆包工作」里也有「豆包」,短的先匹配就永远挑不到那个专有的包。
    const pairs = here.flatMap(one => (one.aliases ?? []).map(alias => ({ one, alias })))
      .sort((a, b) => b.alias.length - a.alias.length)
    for (const { one, alias } of pairs) {
      if (alias.trim() !== '' && said.includes(alias)) return { bundle_id: one.bundle_id, name: one.name, why: 'said' }
    }
  }
  const only = here[0] as FamilyPackage
  if (here.length === 1) return { bundle_id: only.bundle_id, name: only.name, why: 'only' }
  const running = here.find(one => input.installed?.some(had => had.bundle_id === one.bundle_id && had.running === true) === true)
  if (running !== undefined) return { bundle_id: running.bundle_id, name: running.name, why: 'running' }
  return { bundle_id: only.bundle_id, name: only.name, why: 'default' }
}

/** 某个 App 上挂着的专门接法。**同一家的别的已知包标识也算**(卡 CF 的 `bundle_ids`)。 */
export function bindingForBundle(bundleId: string): SessionSourceBinding | undefined {
  return FAMILY_SOURCES.find(one => bundleIdsOf(one).includes(bundleId))
}

/** 这个包所在的那一家会不会在窗口里摆选择题等她(见 {@link SessionSourceBinding.askPanel})。 */
export function familyAsksInWindow(bundleId: string | undefined): boolean {
  return bundleId !== undefined && bindingForBundle(bundleId)?.askPanel === true
}

/**
 * 一个 App 归到哪一家:**先按包标识,认不出再按它的显示名**(2026-09-28,卡 CF)。
 *
 * 按名字这一路只在包标识一个都对不上时才走,判据与「他嘴里那一家」同一套写法
 * (正名与 `aliases` 逐字命中,不做模糊打分)—— 名字是运行时读来的、可能换皮,
 * 所以它只当**退路**,而且认不出就老老实实回 undefined,不猜(D13)。
 */
export function bindingForApp(app: { bundle_id?: string, name?: string }): SessionSourceBinding | undefined {
  const byBundle = app.bundle_id === undefined ? undefined : bindingForBundle(app.bundle_id)
  if (byBundle !== undefined) return byBundle
  const name = app.name?.trim().toLowerCase() ?? ''
  if (name === '') return undefined
  return FAMILY_SOURCES.find(one => one.bundle_id !== undefined
    && [one.name, ...(one.aliases ?? [])]
      // 太短的别名(「豆包」)不走这一路:手机版豆包、别家叫同一个小名的都会撞上来。
      .filter(alias => alias.trim().length >= 3)
      .some(alias => alias.trim().toLowerCase() === name))
}

/**
 * **这个 App 的在跑 / 做完以它的会话文件为准,读窗口那一只手只补标题**(2026-09-27,卡 GB)。
 *
 * `feed: true` 的那几家(Claude / Codex / Kimi)有文件型会话源:`/state.sessions` 那一路一条一条读,
 * 有项目、有等待原因、有真正的起止时刻。窗口上那些字(`Bash 2m 09s`、`Edited 2 files+15-6`、`Beta`、
 * `工作区正在准备中`)是面板标牌与状态条,拿它们猜「它是不是在跑 / 是不是回了」只会冒幽灵气泡 ——
 * 维护者 13:25:「现在是不是就有一些气泡会跑出来,一闪而过很诡异」。
 *
 * 所以这几家的窗口读法**只补标题与最新一句**:不冒气泡、不记蓝点、状态说不清
 * (见 `nextWindowState` 的 `titleOnly`)。别的几家(Muse / Manus / 豆包办公 / 运行时新发现的那些)
 * 没有会话文件,照旧按窗口判 —— 只是「在跑」从此只认停止键。
 */
export function windowTitleOnly(bundleId: string): boolean {
  return bindingForBundle(bundleId)?.feed === true
}

/** 一种专门读法对应的登记表 id(就是它自己的 agent id)。 */
export function entryIdOf(binding: SessionSourceBinding): string {
  return binding.agent
}

/** 一个 App 在登记表里的 id:有专门读法的用那一路的 id,别的就是包标识。 */
export function entryIdForBundle(bundleId: string): string {
  return bindingForBundle(bundleId)?.agent ?? bundleId
}

/** 登记表 id → 那个 App 的包标识(事务官自己、只走接口的那几家没有)。 */
export function bundleForEntry(entryId: string): string | undefined {
  const binding = bindingFor(entryId)
  if (binding !== undefined) return binding.bundle_id
  return entryId
}

/**
 * 这一家的 `.app` 叫什么(2026-09-27,卡 HC):从 `open -a <名字>` 那条命令里取最后一段。
 *
 * 只给"探测整个跑不起来时看一眼 `/Applications/<名字>.app` 在不在"那条退路用。
 * **不新写一张显示名表** —— 原来 `http.ts` 里就写死过一份六家的
 * (`{ claude:'Claude', codex:'ChatGPT', … }`),表外的一家一律被判成"没装"。
 * 表里没写 `open -a` 的那几条(只走接口的、运行时新发现的)回 `undefined`:退路认不出就说认不出。
 */
export function appBundleNameOf(entryId: string): string | undefined {
  const open = bindingFor(entryId)?.open
  if (open === undefined || open.length < 3 || open[1] !== '-a') return undefined
  const name = open[open.length - 1]
  return name === undefined || name === '' ? undefined : name
}

/**
 * 拉起这一家的命令:**一律按包标识**(`open -b <包标识>`)。
 *
 * 2026-09-28(新 Air 真机):原来写过 `open` 的那几家照它的显示名拉(`open -a ChatGPT`)——
 * 同一个 App 在不同机器上名字不同(维护者旧机器上微信叫 WeChat2.app,别人机器上叫 WeChat.app),
 * 按名字拉在别人机器上就「找不到应用」。包标识是稳定的,所以只按它拉;
 * 表里那几条 `open -a` 只剩一个用处 —— 给退路读 `.app` 的名字(`appBundleNameOf`)。
 * 认不出包标识的(只走接口的那几家)才回 undefined。
 */
export function openCommandFor(entryId: string, bundleId?: string): readonly string[] | undefined {
  const binding = bindingFor(entryId)
  const bundle = bundleId ?? binding?.bundle_id ?? (entryId.includes('.') ? entryId : undefined)
  return bundle === undefined ? undefined : ['open', '-b', bundle]
}
