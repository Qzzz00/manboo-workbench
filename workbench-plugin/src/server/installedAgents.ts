/**
 * **这台电脑上装了哪几家 AI**(2026-09-27,卡 HC「不写死各家 AI」)。
 *
 * 维护者在全新 MacBook Air(只装了豆包办公与 Codex)上看到的:顶栏、会话那一排里
 * 照样列着 Claude 与 Kimi,而豆包办公一处都认不出来。原话:
 * 「顶部栏也是一样,现在还是有 claude 和 kimi,你要全面检查一遍,每一个人电脑装的东西都不一样,
 * 千万不能写死,豆包办公还认不出来呢」。
 *
 * ## 规矩(这一份存在的全部理由)
 *
 * **显示与否只看探测,不写死任何一家。** 名字 / 图标 / 包标识 / 读法这种「认得出是谁」的知识表
 * (`agentSources.ts` 的 `FAMILY_SOURCES`)照旧留着 —— 它回答的是「某一家有没有更细的接法」;
 * 「有哪几家该出现在界面上」只由这一份回答。
 *
 * 所以这里**不新写一张家名表**:候选就是 `FAMILY_SOURCES` 里带包标识的那几条,
 * 逐条 `mdfind` 一次它的包标识。新加一家专门读法时,它自动进这一份候选,不用改这个文件。
 *
 * ## 三态,跟 `clientScan.ts` 一字不差的纪律
 *
 * - 探到了 → 出现;
 * - 探了、没找到 → **整家不出现**(顶栏、坞、额度、派活、引导里都没有它);
 * - **一家都探不出来**(Spotlight 关了 / `mdfind` 不在 / 壳没接)→ 回 `undefined`,
 *   上层退回这一版之前的行为(全都显示)。「查不到」不许冒充「没有」(D13)。
 *
 * 只走 `mdfind`,与 `clientScan.probeInstalled` 同一条路、同一份判据 —— 同一台机器上
 * 两处探测给出两个答案的话,维护者看到的是同一个界面。
 *
 * 事务官自己(`dsh`)没有 App,永远不进这一份候选,也永远不被过滤掉(见 `shownAgentIds`)。
 */
import { FAMILY_SOURCES, bindingFor, bundleIdsOf, packagesOf } from './agentSources.ts'
// Antigravity 的包标识归它的原生额度读法那份所有(卡 AN),这里只引用,不写第二遍。
import { ANTIGRAVITY_BUNDLE_ID } from '../quota/antigravityNative.ts'
import { probeInstalled } from './clientScan.ts'
import type { SetupIo } from './setup/io.ts'

/** 一轮重扫的最小间隔。与 `CLIENT_RESCAN_MS` 一致:mdfind 几条子命令,一分钟一次足够。 */
export const AGENT_RESCAN_MS = 60_000

/** 候选的一条:登记表 id、它的包标识、显示名。 */
export interface AgentAppCandidate {
  id: string
  bundle_id: string
  name: string
}

/**
 * 要去探的那几家里**写过专门读法的**:`FAMILY_SOURCES` 里有包标识的每一条。
 *
 * 没包标识的两条不在这儿,各有各的理由:`dsh` 是事务官自己(没有 App);
 * `gpt` 只有接口那只手,出不出现由中转的 `/health` 说话(卡 GH),与本机装没装无关。
 * 这两条之外**每一条都必须有包标识** —— 有用例钉着(`server-no-hardcoded-agents.test.ts`)。
 */
export const AGENT_APP_CANDIDATES: readonly AgentAppCandidate[] = FAMILY_SOURCES
  .filter((one): one is typeof one & { bundle_id: string } => one.bundle_id !== undefined && one.bundle_id !== '')
  /*
   * **同一家的每一个已知包标识都探一遍**(2026-09-28,卡 CF):豆包办公在维护者旧机器上是
   * `com.bot.pc.doubao`、在新 Air 上是 `com.work.pc.doubao`。只探主包标识的后果是新机器上
   * 「豆包办公没装」,而它明明装着、窗口也读到了 —— 家名(`id`)两条都是 `doubao`,
   * 所以探到哪一个,得到的都是同一家。
   */
  .flatMap(one => bundleIdsOf(one).map(bundleId => ({ id: one.agent, bundle_id: bundleId, name: one.name })))

/**
 * **判过是 Agent、但登记表 id 仍是包标识的那几家**(2026-09-27 晚,卡 HC 的回归)。
 *
 * 真机 `/state.installed_agents` 只报了六家 —— 维护者那台机器上 Antigravity 与 Grok Bot
 * 明明装着、顶栏里也都在(它们是**运行中**被发现的,从来没进过 `FAMILY_SOURCES`)。
 * 「本机有哪几家」是唯一出处,漏掉真装着的家就不算唯一出处。
 *
 * ★ **为什么不把它们加进 `FAMILY_SOURCES`**(那是更顺手的写法,但会出事):
 * 那张表一进,`entryIdForBundle()` 就会把这一家的登记表 id 从**包标识**换成短名
 * (`com.google.antigravity` → `antigravity`)。而维护者机器上已经落盘的东西全按老 id 存着 ——
 * 登记表条目、`window-quota.json` 的读数、已读簿、卡上的 `links`、派活记录。
 * 换 id 等于把这些一次性孤立掉(他会看见 Antigravity 的额度读数没了、蓝点重新冒)。
 * 那要配一支迁移,不是今晚该动的东西。
 *
 * 所以这里**只补候选、不动 id**:`id` 就是它的包标识,与登记表里那一条逐字相同。
 * 好处是**没启动过也探得到** —— 登记表那一路要它跑过一次才有。
 *
 * 两个包标识都是 2026-09-27 本机读 `Info.plist` 与 `mdls` 读出来的,不猜:
 * - Antigravity `com.google.antigravity`(与 `quota/antigravityNative.ts` 的
 *   `ANTIGRAVITY_BUNDLE_ID` 同一个;那边是它的正主,这里只引用)
 * - Grok Bot `com.anysphere.sand` —— 名字对不上是真的:`anysphere` 是 Cursor 那家公司、
 *   `sand` 是内部代号(同 Muse 的 `com.meta.endo`)。**别照名字猜包标识。**
 *
 * 这张表与 `FAMILY_SOURCES` 是同一个性质的知识表(B 档:只回答「认得出是谁」),
 * 显示与否照旧只看探测。新一家不必往这儿加 —— 它跑过一次就从登记表那一路进候选。
 */
export const KNOWN_APP_CANDIDATES: readonly AgentAppCandidate[] = [
  { id: ANTIGRAVITY_BUNDLE_ID, bundle_id: ANTIGRAVITY_BUNDLE_ID, name: 'Antigravity' },
  { id: 'com.anysphere.sand', bundle_id: 'com.anysphere.sand', name: 'Grok Bot' },
]

/**
 * **候选还要从登记表里长**(2026-09-27 晚,卡 HC 的回归;现场见上面那一段)。
 *
 * 候选 = 上面那两张知识表 **+ 登记表里判过是 Agent 的每一条**(它带着自己的包标识与名字)。
 * 这一层才是根治:**下一家新接上的不用改一行代码**就进这一份 —— 与卡 Q「不写死」同一个机制,
 * 上面那张 `KNOWN_APP_CANDIDATES` 只是替它补上「还没启动过」那一段空窗。
 *
 * 按**包标识**去重,知识表那条优先(同一家在两边的 id 本来就一样,真正会撞的只有包标识)。
 */
export function candidatesWith(
  extra: readonly { id: string, bundle_id?: string, name: string, self?: boolean }[],
  base: readonly AgentAppCandidate[] = [...AGENT_APP_CANDIDATES, ...KNOWN_APP_CANDIDATES],
): readonly AgentAppCandidate[] {
  const seen = new Set(base.map(one => one.bundle_id))
  const out = [...base]
  for (const one of extra) {
    // 事务官自己没有 App;没有包标识的一条探不了(只走接口的那种)。
    if (one.self === true || one.bundle_id === undefined || one.bundle_id === '') continue
    if (seen.has(one.bundle_id)) continue
    seen.add(one.bundle_id)
    out.push({ id: one.id, bundle_id: one.bundle_id, name: one.name })
  }
  return out
}

/** 探到的一条(界面与引导读它)。 */
export interface InstalledAgentView {
  id: string
  name: string
  bundle_id: string
  /**
   * **这一家装着的那几个 App**(2026-09-28,卡 DP):只有同一台上装着两个以上时才有这一格。
   *
   * 界面照旧一家一条(`bundle_id` 是挑出来的那一个),但派活要挑一个包 ——
   * 豆包在维护者机器上同时装着 `com.bot.pc.doubao`(Doubao)与 `com.work.pc.doubao`(豆包工作),
   * 她说「豆包工作」指的是后一个。挑法在 `agentSources.pickFamilyPackage` 一处。
   */
  packages?: readonly { bundle_id: string, name: string }[]
}

export interface InstalledAgentsView {
  /** 探到装了的那几家(候选表的顺序,不随扫描先后漂移)。 */
  agents: readonly InstalledAgentView[]
  /**
   * 这一份是什么时候探的(ISO)。界面要说得出「几点探到的」。
   *
   * ★ `deps.now()` 是**毫秒**(生产上就是 `Date.now()`,与 `clientScan` 的 `rescanMs` 同一份口径)。
   * 头一版这里按秒算、又乘了一遍 1000,真机上写出来的是 `+058709-03-29T13:14:51.000Z`
   * —— 公元五万八千年。有用例钉着(见 `server-no-hardcoded-agents.test.ts`「时刻」那一节)。
   */
  at: string
}

export interface InstalledAgentScanDeps {
  io: Pick<SetupIo, 'exec'>
  now: () => number
  rescanMs?: number
  /** 只探这几条(用例注入;缺席 = `AGENT_APP_CANDIDATES` + `registryApps()`)。 */
  candidates?: readonly AgentAppCandidate[]
  /**
   * 登记表里判过是 Agent 的那几条(2026-09-27 晚的回归):**每一拍现取**,新接上一家
   * 下一轮就进候选。缺席 = 只探知识表那几条(既有那一批用例一字不变)。
   * 同步取值(读的是内存里的登记表视图),不在这条路上发请求。
   */
  registryApps?: () => readonly { id: string, bundle_id?: string, name: string, self?: boolean }[]
}

export interface InstalledAgentScan {
  /** 上一轮的结论。**没扫过就 undefined**(`/state.installed_agents` 随之缺席)。 */
  view: () => InstalledAgentsView | undefined
  /** 节流过的后台重扫(composeState 每拍调一次,内部决定要不要真跑)。 */
  pump: () => void
  /** 真扫一轮(用例与首扫用)。 */
  scan: () => Promise<InstalledAgentsView | undefined>
  /** 探到装了的那几家的 id。没扫过就 undefined。 */
  installedIds: () => ReadonlySet<string> | undefined
  /** 把节流作废,下一拍 `pump()` 立刻重扫。 */
  invalidate: () => void
}

export function createInstalledAgentScan(deps: InstalledAgentScanDeps): InstalledAgentScan {
  const rescanMs = deps.rescanMs ?? AGENT_RESCAN_MS
  /**
   * 这一轮要探的那几条。`candidates` 给了就只认它(用例);否则知识表那几条 + 登记表现取的那几条。
   * **每一轮重算**:登记表是活的,新接上一家不该等到重启才被探到。
   */
  function candidatesNow(): readonly AgentAppCandidate[] {
    if (deps.candidates !== undefined) return deps.candidates
    let extra: readonly { id: string, bundle_id?: string, name: string, self?: boolean }[] = []
    try { extra = deps.registryApps?.() ?? [] }
    catch { extra = [] }
    return candidatesWith(extra)
  }
  let found: readonly AgentAppCandidate[] | undefined
  let checkedAt: number | undefined
  let scanning = false

  function compose(list: readonly AgentAppCandidate[], at: number): InstalledAgentsView {
    /*
     * **一家只报一条**(2026-09-28,卡 CF):同一家可能有几个已知包标识(豆包办公两个),
     * 两个都装在同一台机器上时报两条,界面上就成了两家。留先探到的那一条(候选表的顺序 = 主包标识在前)。
     */
    const seen = new Set<string>()
    /*
     * ★ 2026-09-28(卡 DP):一家只报一条,**但这一条要记得住「两个都装着」**。
     * 只留第一条的后果:派活永远派给主包(`com.bot.pc.doubao`),而她说的「豆包工作」是另一个。
     * 名字从知识表(`packagesOf`)里取 —— 各个包自己的显示名写在那儿,这里不另写一遍。
     */
    const packagesOfFamily = (id: string): readonly { bundle_id: string, name: string }[] => {
      const here = list.filter(one => one.id === id).map(one => one.bundle_id)
      if (here.length < 2) return []
      return packagesOf(bindingFor(id))
        .filter(one => here.includes(one.bundle_id))
        .map(one => ({ bundle_id: one.bundle_id, name: one.name }))
    }
    return {
      agents: list
        .filter(one => !seen.has(one.id) && (seen.add(one.id), true))
        .map((one) => {
          const packages = packagesOfFamily(one.id)
          return {
            id: one.id,
            name: one.name,
            bundle_id: one.bundle_id,
            ...(packages.length < 2 ? {} : { packages }),
          }
        }),
      // `at` 是毫秒(deps.now() = Date.now()):**不许再乘 1000**,见 InstalledAgentsView.at。
      at: new Date(at).toISOString(),
    }
  }

  async function runScan(): Promise<InstalledAgentsView | undefined> {
    const hits: AgentAppCandidate[] = []
    let probed = 0
    for (const one of candidatesNow()) {
      const probe = await probeInstalled(deps.io, one.bundle_id)
      if (probe === undefined) continue
      probed += 1
      if (probe.found) hits.push(one)
    }
    checkedAt = deps.now()
    // 一家都探不出来(Spotlight 关了 / mdfind 不在)→ 整格缺席,不冒充「都没装」。
    if (probed === 0) {
      found = undefined
      return undefined
    }
    found = hits
    return compose(hits, checkedAt)
  }

  return {
    view: () => (found === undefined || checkedAt === undefined ? undefined : compose(found, checkedAt)),
    pump: () => {
      if (scanning) return
      if (checkedAt !== undefined && deps.now() - checkedAt < rescanMs) return
      scanning = true
      // fire-and-forget:扫得慢不该拖住 /state(同 clientScan.pump)。
      void runScan().catch(() => {}).finally(() => { scanning = false })
    },
    scan: runScan,
    installedIds: () => (found === undefined ? undefined : new Set(found.map(one => one.id))),
    invalidate: () => { checkedAt = undefined },
  }
}

/**
 * **界面上该出现哪几家**(纯函数,`/state.agents` 与额度、派活、引导都过这一道)。
 *
 * @param all 待过滤的那几家(今天是 `AGENT_IDS`,以后是登记表里的每一条)。
 * @param installed 探到装了的那几家的 id;**`undefined` = 没探出来 → 一个都不筛**
 *   (退回这一版之前的行为,D13:「查不到」不等于「没有」)。
 * @param extras 探测之外也必须留下的那几家:此刻真有会话 / 登记表里接上过的。
 *   装在非标准位置、Spotlight 索引不到的那一家不该因为这条规矩消失 —— 它真在说话。
 *
 * `dsh`(事务官自己)没有 App,永远留下。
 */
export function shownAgentIds<T extends string>(
  all: readonly T[],
  installed: ReadonlySet<string> | undefined,
  extras: ReadonlySet<string> = new Set(),
): readonly T[] {
  if (installed === undefined) return all
  return all.filter(id => id === 'dsh' || installed.has(id) || extras.has(id))
}
