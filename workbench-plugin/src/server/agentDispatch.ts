/**
 * 派活给别家 Agent(2026-09-21,参赛冲刺卡 ④「指挥电脑上的 Agent」)。
 *
 * Ben 在手机上说一句「让 Codex 把 X 做了」,链路是:
 *
 *   电话/打字 → 工人的 wb_dispatch_item(带 assignee) → POST /butler/item
 *     → 建卡(assignee=codex)+ 开一条 DSH 会话
 *     → 事务官读它自己的技能段(~/.dsh/AGENTS.md 的「派活给别家Agent」),
 *        照着这份表起一个**非交互**子进程,并把进度回报到 POST /butler/item/dispatch
 *     → 卡上出现「派给 Codex · 进行中」,失败时收件箱里多一条「要我自己来吗」
 *
 * **为什么是事务官去 spawn,而不是插件自己 spawn**(2026-09-21 的技术选择,可推翻):
 * 事务官本来就有 shell、有工作目录、有会话记录 —— 它跑的每一条命令在 DSH 的会话里
 * 都是看得见的一行。插件自己 spawn 的话,这一行谁也看不到,"可见可撤销"里的"可见"就丢了。
 * 插件只做三件它该做的事:**把本机真实的命令名告诉事务官**(下面这张表)、
 * **把进度记在卡上**、**按 pid 停掉**(kill 需要一个不会随会话结束而消失的地方)。
 *
 * ## 这台电脑上实测(2026-09-21,见 docs/交接-0921-派活给别家Agent.md;Kimi 那格 2026-10-22 更新)
 *
 * | 家 | 命令在哪 | 非交互怎么跑 | 工作目录 | 结果怎么拿 |
 * |---|---|---|---|---|
 * | Codex | PATH 上没有;`/Applications/ChatGPT.app/Contents/Resources/codex`(codex-cli 0.153.4) | `codex exec <prompt>` | `-C <目录>` | `-o <文件>` 写最后一条消息 |
 * | Claude | PATH 上没有;`~/Library/Application Support/Claude/claude-code/<版本>/claude.app/Contents/MacOS/claude`(2.1.275) | `claude -p <prompt>` | **没有目录参数**,只能靠子进程自己的 cwd(再加 `--add-dir`) | `--output-format json` 走标准输出 |
 * | Kimi | PATH 上的 `kimi`,或 `/opt/homebrew/bin/kimi`(Kimi Code CLI 2.2.0,2026-10-22 brew 装好、维护者登录;0921 时「未查到」的结论作废) | `kimi -p <prompt> --output-format stream-json` | **没有目录参数**,靠子进程 cwd | stream-json 每行一个 JSON:最后一条 `role:"assistant"` 的 `content` 是汇报,`role:"meta",type:"session.resume_hint"` 的 `session_id` 记进 links |
 *
 * 「未查到」就是未查到 —— 不编一条像模像样的命令出来(D13)。Kimi 那一档(0921 时)的正确行为是
 * 对 Ben 说实话:「这台电脑上 Kimi 没有命令行,我自己来做还是等你装」。10-22 事实变了:装上了,
 * 于是这一格照实测改写 —— 探不到照旧如实说「没装 Kimi Code CLI(brew install kimi-code)」。
 *
 * ★ **命令行在 ≠ 登得上**(2026-09-21 真跑出来的):Codex 那份跑通了(退出码 0、README 真写出来了);
 * Claude 那份跑得起来、回的也是正经 JSON,但内容是 `"result":"Not logged in · Please run /login"`
 * —— 桌面端的登录态**不给**这份命令行用。所以"有没有命令行"与"登没登上"是两件事,
 * 这个模块只回答前一件;后一件由那次派活自己失败、把 `result` 原话当失败原因报回来
 * (卡上就会写「派给 Claude,失败(Not logged in · Please run /login)」)。
 * **不在这里替他探登录态**:探一次要真发一次请求、要碰凭据,两样都不该由工作台做。
 *
 * ## 边界(任务书第 4 条)
 *
 * - **目录**:`dispatchCwdAllowed` —— 只在扫描根底下的目录里跑。事项没挂项目就不许猜一个,
 *   回 `{ ok: false }` 让事务官去问 Ben(问一句的代价远小于在错的仓库里改文件)。
 * - **凭据**:这里一个字都不碰。各家 CLI 自己用自己那份登录态,工作台既不读也不传。
 * - **可撤销**:`dispatch.pid` 记在卡上,卡面「停掉」按 pid 杀 —— 见 http.ts 那条路由。
 */
import type { AgentDispatchFamily, DispatchHand, JobKind, TaskDispatch } from '../protocol.ts'
import { DISPATCH_HAND_TITLES, dispatchFamilyTitle } from '../protocol.ts'
import { FAMILY_SOURCES, bindingFor } from './agentSources.ts'
import type { DispatchTarget } from './dispatchTargets.ts'
import { handsOf } from './dispatchTargets.ts'
import type { ApiDispatchFamily } from './dispatchApi.ts'
import { API_DISPATCH_MODELS } from './dispatchApi.ts'
import { CODEX_APP_BUNDLE_BINARY } from './engine/adapters/codexAppServerClient.ts'
import { isAbsolute, join } from 'node:path'

/**
 * **先用哪只手派**(2026-09-22,Ben 定的 A3)。
 *
 * 原话:「Claude 命令行不登,Claude 走窗口那只手,命令行只作 Codex 备用。」
 * 交接-0921-派活给别家Agent 第八节问的就是这件事(Claude Code 的命令行要不要单独登一次),
 * 他选了「不登」——**那条路从此不试**。
 *
 * | 家 | 顺序 | 为什么 |
 * |---|---|---|
 * | Codex | 客户端窗口 → 命令行(备用) | 两条都真跑通过(2026-09-21);窗口在前是因为用户手里是订阅不是 API Key |
 * | Claude | 只有客户端窗口 | 桌面端登录态不给命令行用,实测回 `Not logged in · Please run /login`;而 Ben 定了不单独登 |
 * | Kimi | 只有客户端窗口 | 这台电脑上根本没有一次性非交互命令行(见下面那张表) |
 * | GPT | 只有接口 | **ChatGPT 桌面版与 Codex 是同一个 app**(`com.openai.codex`),窗口那只手归 Codex —— 两家抢同一扇窗会互相盖掉对方的话 |
 * | 豆包 | 只有接口 | 没有命令行;窗口也送不进去(辅助功能树只有 10 个节点,见 docs/交接-0921-送话进客户端窗口.md 的 0/5) |
 *
 * **数组的顺序就是尝试的顺序**,第一只手送不进去才退到第二只。
 *
 * ★ **GPT 与豆包只有 `api` 这一只,没有退路**:接口这条路发不出去(服务器没配那家、
 * 额度用完、上游连不上)时**如实失败**,不改用窗口顶上 —— GPT 那扇窗是 Codex 的,
 * 顶上去等于把话送给了另一家;豆包那扇窗实测就是送不进去。
 *
 * ★ **2026-09-25(卡 Z)这张写死的表没了**。原来是 `AGENT_HAND_ORDER`(七家各一行);现在**现算**
 * (`dispatchTargets.ts` 的 `handsOf`):有本机 App 就有窗口那只手,`agentSources.ts` 里给它写过
 * 命令行备用 / 接口的再加上那一只。那张表里的每一条判断一条都没丢,只是从「七行字面量」变成了
 * 「每家自己那点专门代码 + 它有没有 App」——**新发现的一家不改代码就有窗口那只手**。
 *
 * ★ 2026-09-24(卡 F)**豆包的窗口那只手能用了**:这台机器上豆包 2.17.10 的辅助功能树里
 * 有输入框了(368 个节点,占位符「发消息或按住空格说话...」),实测新对话 + 送字 + 发送 + 读回复
 * 一整条都通(交接-0925-远程派活六家 第二节)。0921 那张表里的 0/5 是旧版本。接口留作备用。
 */

/** 这一家走的是接口那只手吗(今天 = GPT 与豆包 —— `agentSources.ts` 里给它们配了模型)。 */
export function apiIsHandFor(family: AgentDispatchFamily): boolean {
  return bindingFor(family)?.api === true
}

/**
 * 这一家按顺序有哪几只手。`hasApp` 缺席时按「写过专门接法的那几家有没有 App」算
 * (老调用方;登记表在手的地方传 `dispatchTargets` 里那一条的 `hands`)。
 */
export function dispatchHands(family: AgentDispatchFamily, hasApp?: boolean): readonly DispatchHand[] {
  return handsOf({ id: family, hasApp: hasApp ?? bindingFor(family)?.bundle_id !== undefined })
}

/**
 * 这一家还留着命令行当备用吗。**今天只有 Codex**。
 *
 * 判据是上面那张表,不是"这台电脑上有没有那个二进制" —— 两件事:
 * `resolveAgentCli` 回答的是**事实**(探得到探不到),这个函数回答的是**策略**(用不用)。
 * Claude 那份探得到、也跑得起来,但按 Ben 的定不用它。
 */
export function cliIsBackupFor(family: AgentDispatchFamily): boolean {
  return bindingFor(family)?.cliBackup === true
}

/** 这一家的手在界面/技能里怎么念:「客户端窗口 → 命令行(备用)」。 */
export function handOrderText(family: AgentDispatchFamily): string {
  return dispatchHands(family)
    .map((hand, index) => (index === 0 ? DISPATCH_HAND_TITLES[hand] : `${DISPATCH_HAND_TITLES[hand]}(备用)`))
    .join(' → ')
}

/**
 * 从一段话里认出「让谁做」。认不出来回 undefined —— **不默认派给谁**。
 *
 * 语义分类(2026-10-27 退修批,root 用真实输入复现 5 个错判后重设计):**命令 / 否定 /
 * 询问 / 背景** 四个闭类,按句判 ——
 *
 * - **询问**:整句含疑问 / 取舍短语(是否、要不要、能不能、还是…)—— 这话是在问或还在
 *   取舍,不自动派(「是否让 Claude 来做?先给我方案」不是指派);
 * - **否定**:指派动词紧邻窗口(前 4 字)内出现否定字(不/没/未/别/勿/毋/莫/甭/休/无/非/否
 *   —— 中文否定是闭类,不逐句加例外)—— 否定只作用到它紧贴的那一个动词,所以
 *   「不要让 Claude 处理,这次交给 Kimi」里 Claude 不算、Kimi 照派;
 * - **背景**:名字紧跟完成体(了/过/的/来着),或动词紧邻过去时副词(昨天/之前/已经/刚…)——
 *   「昨天让 Claude 做了」是现状描述,不是这次指派;
 * - **命令**:以上都不沾,才算一次指派。
 *
 * 混合 / 沾不上类别的 → 不派(事务官自己办)—— **绝不把不确定话语兜底成一次派发**:
 * 漏认的下场是事务官自己办(它读得懂那句话,大概率还是会去派),错认的下场是在一个他没
 * 打算动的仓库里起了一个会改文件的进程。宁可漏认不可错认。
 *
 * 分层(同卡设计):**显式负责人**(`assignee`,电话 / 模型直填)永远优先,不走这里;
 * 普通句子先过理解中枢(单中枢模型清单,`items[].who`),这里是打字建事项**最后的
 * 确定性兜底**(输入框里没有"选一家"的控件)。同一名字多处出现逐个查,取最早合法命中。
 */
/**
 * 他在原话里会怎么写这一家的名字:登记表里的名字 + 家名 + `agentSources.ts` 里记的别名
 * (「豆包」也写作 `doubao`)。**一个字的不认**(太容易误撞);包标识那种带点的不认
 * (他不会在电话里念 `com.meta.endo`)。
 */
function needlesFor(target: { id: string, title: string, aliases?: readonly string[] | undefined }): string[] {
  const out = new Set<string>()
  for (const one of [target.title, ...(target.aliases ?? []), target.id]) {
    const word = one.trim().toLowerCase()
    if (word.length < 2 || word.includes('.')) continue
    out.add(word)
  }
  return [...out]
}

/*
 * ★ **动词紧邻名字**且同句才算指派(2026-10-27):名字前那一截必须以指派动词结尾
 * (后面只许介词「给 / 到 / 至」与空白引号)。
 */
const HANDOFF_ADJACENT = /(交给|让|叫|派|找|给)(?:给|到|至)?[「"'“‘\s]*$/u
/** 否定闭类(单字):中文否定 / 否决字,覆盖面是语言闭类,不是逐句例外表。 */
const NEGATION_CHARS = /[不没未别勿毋莫甭休无非否]/u
/** 疑问 / 取舍短语:**整句**命中即不派(问的是「要不要派」,还没下令)。 */
const INTERROGATIVE_CLAUSE = /是否|要不要|能不能|可不可以|该不该|行不行|难道|岂不|好吗|行吗|对不|还是|或是/u
/**
 * 过去时副词(动词的紧邻窗口内命中即背景)。窗口本身只有 4 字、不含动词后的内容,
 * 不做锚定;「刚」一类歧义字不在内 —— 它更像「刚派的活」,完成体(了/过)兜那种。
 */
const PAST_WINDOW = /(昨天|前天|之前|先前|早前|已经|曾经|本来|上次|原本|前阵|早些时候)/u
/** 被动 / 归属助词在紧邻窗口内(「是让 X 修的」「归 Kimi 管」)—— 说的是现状,不是下令。 */
const PASSIVE_WINDOW = /[是由归被]/u
/** 完成体:名字**紧跟**(允许空白)了 / 过 / 的 / 来着 → 说的是已发生的事。 */
const COMPLETION_AFTER = /^\s*(?:了|过|的|来着)/u
/** 否定 / 过去时回看几个字:否定与时态都贴在动词前,窗口外的 earlier 语境不算(分句各算各的)。 */
const WINDOW_CHARS = 4
const CLAUSE_CUT = /[。！!?？;；\n]/u

/**
 * 这一处出现位是不是一次指派。`clause` = 所在整句;`before` = 句内名字前那一截;
 * `after` = 句内名字后那一截。语义四类见文件头:询问按整句,否定 / 过去时按动词紧邻
 * 窗口,完成体按名字后紧跟。
 */
function handoffHitAt(clause: string, before: string, after: string): boolean {
  if (INTERROGATIVE_CLAUSE.test(clause)) return false
  const verb = HANDOFF_ADJACENT.exec(before)
  if (verb === null) return false
  const window = before.slice(Math.max(0, verb.index - WINDOW_CHARS), verb.index)
  if (NEGATION_CHARS.test(window)) return false
  if (PAST_WINDOW.test(window)) return false
  if (PASSIVE_WINDOW.test(window)) return false
  if (COMPLETION_AFTER.test(after)) return false
  return true
}

export function dispatchFamilyOf(text: string, targets?: readonly DispatchTarget[]): AgentDispatchFamily | undefined {
  const lower = text.toLowerCase()
  // 顺序即优先级:一句话里同时点到两家时按先出现的那家(「让 Codex 做,别找 Claude」)。
  let best: { family: AgentDispatchFamily, at: number } | undefined
  const hit = (family: AgentDispatchFamily, needle: string): void => {
    // 同一名字多处出现逐个查(背景里那处没动词,不该挡掉后面真正的指派)。
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at === -1) return
      // 同一句才认:名字前一道句读切断之后的那一截才作数。
      let clauseStart = 0
      for (let i = at - 1; i >= 0; i -= 1) {
        if (CLAUSE_CUT.test(lower[i] as string)) { clauseStart = i + 1; break }
      }
      let clauseEnd = lower.length
      for (let i = at + needle.length; i < lower.length; i += 1) {
        if (CLAUSE_CUT.test(lower[i] as string)) { clauseEnd = i; break }
      }
      const before = lower.slice(clauseStart, at)
      const after = lower.slice(at + needle.length, clauseEnd)
      if (handoffHitAt(lower.slice(clauseStart, clauseEnd), before, after) && (best === undefined || at < best.at)) {
        best = { family, at }
        return
      }
      from = at + needle.length
    }
  }
  /*
   * ★ 2026-09-25(卡 Z):认哪几个名字**从登记表来**(传进来的 `targets`)——
   * 运行时新接上一家,他在电话里说「让 XX 看看」就认得出,不用改这里的代码。
   * 没传(老调用方)才退回「写过专门接法的那几家」的名字与别名。
   */
  const known = targets ?? FAMILY_SOURCES
    .filter(one => one.self !== true)
    .map(one => ({ id: one.agent, title: one.name, aliases: one.aliases }))
  for (const target of known) {
    for (const needle of needlesFor(target)) hit(target.id, needle)
  }
  return best?.family
}

/**
 * 这段话里**有没有提到**某一家(2026-10-27 三批):只做「提到没有」的扫描,不猜是不是指派 ——
 * 派发决定只由理解中枢的结构化意图给出(见 `sayModel.ts` 的 dispatch 契约);这里供
 * 「模型没接成而话里又点到了家 → 保守不派」那一道回退用。名字从登记表来,不写死。
 */
export function mentionsDispatchFamily(text: string, targets?: readonly DispatchTarget[]): boolean {
  const lower = text.toLowerCase()
  const known = targets ?? FAMILY_SOURCES
    .filter(one => one.self !== true)
    .map(one => ({ id: one.agent, title: one.name, aliases: one.aliases }))
  return known.some(target => needlesFor(target).some(needle => lower.includes(needle)))
}

/** 一家 CLI 探出来的结果。`found:false` 时 `why` 是**给 Ben 看的那一句**,不是错误码。 */
export type AgentCli =
  | { found: true, family: AgentDispatchFamily, bin: string, source: 'path' | 'bundled' }
  | { found: false, family: AgentDispatchFamily, why: string }

export interface AgentCliProbe {
  /** 进程的 PATH(`process.env.PATH`)。 */
  pathEnv?: string | undefined
  /** 家目录。Claude 那份装在 `~/Library/Application Support/Claude` 底下。 */
  home: string
  /** 这个路径在不在(注入的,测试不碰真盘)。 */
  exists: (file: string) => boolean
  /** 列一个目录(只给 Claude 挑版本用)。不存在回空数组。 */
  listDir?: ((dir: string) => readonly string[]) | undefined
}

/**
 * ChatGPT.app 自带的那一份。2026-09-07 事故之后 `resolveCodexBinary` 就是这么兜底的,这里沿用同一条路。
 *
 * **2026-10-02**:这个路径原来在这里和 `quota/codexAppServer.ts` 各写了一遍,而且**两处都是错的**
 * (`Contents/Resources/codex` 在 codex-cli 0.159.2 上不存在,见
 * `docs/设计-一条引擎替八条管线-2026-10-02.md` 第六节)。现在只认共用客户端里那一处。
 */
export const CODEX_BUNDLED = CODEX_APP_BUNDLE_BINARY

/** Claude Code 由桌面端自己管的那一份。`<版本>` 每次升级换一个目录,所以要现挑。 */
export function claudeManagedDir(home: string): string {
  return `${home}/Library/Application Support/Claude/claude-code`
}

/** PATH 上找一个命令。找不到回 undefined。 */
function onPath(probe: AgentCliProbe, name: string): string | undefined {
  for (const dir of (probe.pathEnv ?? '').split(':')) {
    if (dir === '') continue
    const file = `${dir}/${name}`
    if (probe.exists(file)) return file
  }
  return undefined
}

/** `2.1.275` > `2.1.260` > `2.1.9`。按数字段比,比不出来的排后面(不猜)。 */
export function newestVersionDir(names: readonly string[]): string | undefined {
  const parsed = names
    .map(name => ({ name, parts: name.split('.').map(part => Number.parseInt(part, 10)) }))
    .filter(one => one.parts.length > 0 && one.parts.every(part => Number.isInteger(part)))
  if (parsed.length === 0) return undefined
  parsed.sort((a, b) => {
    const len = Math.max(a.parts.length, b.parts.length)
    for (let i = 0; i < len; i += 1) {
      const diff = (b.parts[i] ?? 0) - (a.parts[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  })
  return parsed[0]?.name
}

/**
 * 一家的命令行在哪。**PATH 优先**(Ben 自己装过的那份说了算),再退回各家固定的那几个位置。
 *
 * 2026-10-22(卡 C):Kimi 不再是「一律没有」—— Kimi Code CLI 2.2.0 装上了(PATH 上的 `kimi`,
 * 或固定的 `/opt/homebrew/bin/kimi`;DSH 的 PATH 里常常没有 Homebrew,同 Claude 的 `~/.local/bin` 兜法)。
 * 探不到照旧 `found:false`,why 给装法,不编一条猜的命令(D13)。
 */
export function resolveAgentCli(family: AgentDispatchFamily, probe: AgentCliProbe): AgentCli {
  if (family === 'codex') {
    const found = onPath(probe, 'codex')
    if (found !== undefined) return { found: true, family, bin: found, source: 'path' }
    if (probe.exists(CODEX_BUNDLED)) return { found: true, family, bin: CODEX_BUNDLED, source: 'bundled' }
    return { found: false, family, why: '这台电脑上 Codex 没有命令行(PATH 上没有 codex,也没装 ChatGPT.app)' }
  }
  if (family === 'claude') {
    const found = onPath(probe, 'claude')
    if (found !== undefined) return { found: true, family, bin: found, source: 'path' }
    // Claude 官方安装程序装的那一份(卡 O「帮我接上」装的就是它):DSH 的 PATH 里常常没有 ~/.local/bin。
    for (const bin of [`${probe.home}/.local/bin/claude`, `${probe.home}/.claude/local/claude`]) {
      if (probe.home !== '' && probe.exists(bin)) return { found: true, family, bin, source: 'path' }
    }
    const dir = claudeManagedDir(probe.home)
    const version = newestVersionDir(probe.listDir?.(dir) ?? [])
    if (version !== undefined) {
      const bin = `${dir}/${version}/claude.app/Contents/MacOS/claude`
      if (probe.exists(bin)) return { found: true, family, bin, source: 'bundled' }
    }
    return { found: false, family, why: '这台电脑上 Claude Code 没有命令行(PATH 上没有 claude,Claude 桌面端也没带一份)' }
  }
  if (family === 'gpt') {
    return {
      found: false,
      family,
      // ChatGPT 那个 app 里自带的命令行**就是 codex**(同一个 bundle),已经在上面那一档了。
      // 再探一遍只会探到同一个二进制,然后在技能里写成"GPT 也有命令行",那是错的。
      why: 'GPT 不走命令行(ChatGPT.app 里自带的那份命令行就是 Codex,已经算在 Codex 名下);它走接口那只手',
    }
  }
  if (family === 'doubao') {
    return {
      found: false,
      family,
      why: '豆包没有命令行;先走窗口,接口备用',
    }
  }
  if (family === 'muse' || family === 'manus') {
    return {
      found: false,
      family,
      // 实测(2026-09-24):两个 app 包里都只有它自己的主程序与崩溃上报,没有一次性命令行。
      why: `${dispatchFamilyTitle(family)} 没有命令行,只走窗口那只手`,
    }
  }
  if (family === 'kimi') {
    const found = onPath(probe, 'kimi')
    if (found !== undefined) return { found: true, family, bin: found, source: 'path' }
    // Homebrew 那份固定位置(DSH 的 PATH 里常常没有 /opt/homebrew/bin,同 Claude 的 ~/.local/bin 兜法)。
    if (probe.exists('/opt/homebrew/bin/kimi')) return { found: true, family, bin: '/opt/homebrew/bin/kimi', source: 'path' }
    // Kimi.app 里那两个(kimiim-cli 群聊收发 / daimon 常驻守护)都不是派活用的,0921 实测过,不算数。
    return { found: false, family, why: '这台电脑上没装 Kimi Code CLI(brew install kimi-code)' }
  }
  /*
   * ★ 2026-09-25(卡 Z):运行时新接上的那一家走到这里 —— **如实说没查过**,不替它编一条命令
   * (D13)。它照旧能派:窗口那只手是通用的。哪天为它写了专门的探法,在上面加一档。
   */
  return {
    found: false,
    family,
    why: `没查过 ${dispatchFamilyTitle(family)} 有没有命令行,派活走它的窗口那只手`,
  }
}

/**
 * **名片上写的 runtime → 那家的命令行**(2026-10-22,卡 C):名片写了 `bin` 就用它写的那一份(不再探);
 * 没写就按家探测(`resolveAgentCli`)。这是「bin 缺省由探测补」那一处。
 */
export function cliFor(family: AgentDispatchFamily, opts: { bin?: string, probe?: AgentCliProbe } = {}): AgentCli {
  const bin = opts.bin?.trim()
  if (bin !== undefined && bin !== '') return { found: true, family, bin, source: 'path' }
  if (opts.probe !== undefined) return resolveAgentCli(family, opts.probe)
  return { found: false, family, why: `这台电脑上没装 ${dispatchFamilyTitle(family)} 的命令行(没有 bin、也没给探针)` }
}

export interface DispatchCommand {
  bin: string
  argv: readonly string[]
  /** 子进程的工作目录。Claude / Kimi 那两家**只能**靠它(它们没有目录参数)。 */
  cwd: string
  /** 结果文件。Codex 用 `-o` 写这里;Claude 走标准输出,整个字段缺席。 */
  outputFile?: string
  /** 结果怎么读:`file` = 读 `-o` 那个文件(Codex);`stdout_json` = 标准输出里的结构化 JSON(Claude 那条 result / Kimi 的 stream-json)。 */
  resultFrom?: 'file' | 'stdout_json'
}

/**
 * 命令行这只手**这一类活**用不用(2026-09-25,卡 O;2026-10-22 卡 C 加 Kimi)。
 *
 * - 聊天的活:照 A3(Ben 09-22):只有 Codex 留着命令行当备用,Claude / Kimi 走窗口;
 * - **写代码的活:Claude / Codex / Kimi 的命令行都用** —— 那是能在指定目录里改文件、又不用人在电脑前批的手
 *   (设计 09-25 第 3、6 条;维护者:「应该派给 Claude 啊」;10-22 决策记录「先配 Kimi 命令行编程智能体」)。
 *   Claude 命令行要单独登一次,没登就派不出去、如实说(`agentCaps.ts` 查登没登);
 *   Kimi 没登一样如实失败 —— 它自己把「没登录」说回来,卡上写它的原话。
 */
export function cliAllowedFor(family: AgentDispatchFamily, kind: JobKind | undefined): boolean {
  if (kind === 'code') return family === 'codex' || family === 'claude' || family === 'kimi'
  return cliIsBackupFor(family)
}

/**
 * Claude 命令行跑写代码的活时带的那份设置:**开沙箱**(命令只能写这个工作目录、没有网),沙箱里的命令自动放行,
 * 出不了沙箱的命令一律不放、沙箱起不来就不跑。配上 `--permission-mode acceptEdits`(改文件不问)与
 * `--permission-prompts none`(任何要问人的一步直接拒,不挂在那儿等一个不在电脑前的人)——
 * 与 Codex 的 `-s workspace-write`(非交互、不批准)是同一个分寸。**不用任何 `--dangerously-*`**。
 */
export const CLAUDE_CODE_SETTINGS = JSON.stringify({
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true },
})

/**
 * 起一个非交互子任务的那条命令。
 *
 * 两家的形状差得远,所以这里**照各自实测的来**,不强行统一成一个抽象:
 * - Codex:`codex exec -C <cwd> -s workspace-write -o <文件> <prompt>` —— 它有自己的目录参数与结果文件;
 * - Claude:`claude -p <prompt> --output-format json --add-dir <cwd>`,工作目录靠子进程 cwd。
 *
 * 沙箱/权限档位都取**能写这个工作目录、但不放开整台机器**的那一档
 * (Codex `workspace-write`、Claude `acceptEdits`)。再往上是 `--dangerously-*`,
 * 那一档不许出现在这里 —— 派一次活不该顺手把整台电脑交出去。
 */
export function dispatchCommand(cli: AgentCli, input: { prompt: string, cwd: string, outputFile?: string, json?: boolean, kind?: JobKind, model?: string, effort?: 'low' | 'medium' | 'high', agentFile?: string, agentFileOmit?: boolean, resume?: string }): DispatchCommand | undefined {
  if (!cli.found) return undefined
  /**
   * **策略闸(2026-09-22,A3;2026-09-25 卡 O 放开写代码那一类;2026-10-22 卡 C 加 Kimi)**:聊天的活命令行只给
   * Codex 当备用;写代码的活 Claude / Codex / Kimi 的命令行都用(`cliAllowedFor`)。Claude 命令行没登录时拼出来的
   * 命令只会换回 `Not logged in` —— 派活那一层先看体检(`agentCaps.ts`),没登就不派、说清楚、给「登录 Claude」。
   */
  if (!cliAllowedFor(cli.family, input.kind)) return undefined
  if (cli.family === 'claude') {
    return {
      bin: cli.bin,
      argv: [
        ...claudeCliArgv(input.prompt, input.cwd, input.model, input.resume),
        ...(input.effort === undefined ? [] : ['--effort', input.effort]),
        '--permission-prompts', 'none',
        '--settings', CLAUDE_CODE_SETTINGS,
      ],
      cwd: input.cwd,
      resultFrom: 'stdout_json',
    }
  }
  if (cli.family === 'kimi') {
    return {
      bin: cli.bin,
      argv: [...kimiCliArgv(input.prompt, input.cwd, { model: input.model, instructions: input.agentFile, resume: input.resume, ...(input.agentFileOmit === true ? { skipAgentFile: true } : {}) })],
      cwd: input.cwd,
      resultFrom: 'stdout_json',
    }
  }
  if (cli.family === 'codex') {
    const out = input.outputFile
    return {
      bin: cli.bin,
      argv: [
        'exec',
        // `--json`(2026-09-24,卡 F):事件流打到标准输出,第一行就是 thread id —— 工作台据此把
        // 这条会话 links 进事项(首页「正在办」只数一次)。结果仍然读 `-o` 那个文件。
        ...(input.json === true ? ['--json'] : []),
        '-C', input.cwd,
        '-s', 'workspace-write',
        // 模型:`codex exec -m <名>`(0.16x 的 `--help` 实测;名片给了才加,一字不加)。
        ...(input.model === undefined ? [] : ['-m', input.model]),
        ...(input.effort === undefined ? [] : ['-c', `model_reasoning_effort=${JSON.stringify(input.effort)}`]),
        ...(out === undefined ? [] : ['-o', out]),
        ...(input.resume === undefined ? [] : ['resume', input.resume]),
        input.prompt,
      ],
      cwd: input.cwd,
      ...(out === undefined ? {} : { outputFile: out }),
      resultFrom: 'file',
    }
  }
  return undefined
}

/**
 * Claude 那条非交互命令**长什么样**(2026-09-21 真跑过:`claude -p … --output-format json`)。
 *
 * 2026-09-25(卡 O)起**写代码的活**走它(`cliAllowedFor`);聊天的活仍照 A3 走窗口。
 * 2026-10-22(卡 D):名片给了模型才带 `--model <名>`,不给一字不变。
 * 2026-10-23(卡「派活给名片的四处」③):续跑给了会话号才带 `--resume <id>`(接着那一条,不从头再读一遍)。
 */
export function claudeCliArgv(prompt: string, cwd: string, model?: string, resume?: string): readonly string[] {
  return [
    '-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', cwd,
    ...(model === undefined ? [] : ['--model', model]),
    ...(resume === undefined || resume === '' ? [] : ['--resume', resume]),
  ]
}

/** 智能体文件缺省那一份(相对仓库;2026-10-22 卡 A)。 */
export const DEFAULT_KIMI_AGENT_FILE = 'docs/卡/agents/kimi-coder.md'

/**
 * 智能体文件没找到时落到卡上那一句(2026-10-29,任务书「派活智能体文件与起跑换手」):
 * 照样派,只是这次不带 `--agent-file`。
 */
export const agentFileMissingNote = (rel: string): string => `名片的智能体文件 ${rel} 没找到,这次没带`

export interface AgentFilePick {
  /** 解析出来的绝对路径(存在才带);缺席而 {@link omit} = 这次不带 `--agent-file`。 */
  agentFile?: string
  /** true = 这次不带 `--agent-file`(与 agentFile 二选一)。 */
  omit?: boolean
  /** 要落到卡上的一句(只在新片给了路径而文件不存在时有)。 */
  note?: string
}

/**
 * 智能体文件解析(2026-10-29,任务书「派活智能体文件与起跑换手」①②③,一处说了算):
 *
 * - 相对路径**先相对 `repo`(名片写的 project.repo,这台有源码仓),其次相对 `cwd`**(任务工作目录),
 *   第一个真实存在的 wins;绝对路径原样核存在。
 * - 解析出来的文件**不存在就不带 `--agent-file`**,照样派;名片给了路径的,卡上 note 一句
 *   「名片的智能体文件 <路径> 没找到,这次没带」;缺省那一份找不到就静静不带(不每张卡一句噪音)。
 * - **用户层那条路**(`userLayer`:cwdFixed 且 cwd 在用户层目录)一律不带:那份 coder 智能体文件
 *   讲的是开工作树、推分支、写交接,对用户层是错指令;交代本身已带用户层契约。
 *
 * `exists` 由调用方注入(生产 `existsSync`;用例给假文件系统),这一层不做 I/O。
 */
export function pickAgentFile(input: {
  instructions?: string | undefined
  /** 名片上的 project.repo(这台有源码仓才传)。 */
  repo?: string | undefined
  cwd: string
  /** 用户层那条路(cwdFixed 且 cwd 在用户层目录)。 */
  userLayer?: boolean | undefined
  exists: (path: string) => boolean
}): AgentFilePick {
  if (input.userLayer === true) return { omit: true }
  const written = input.instructions?.trim()
  const explicit = !(written === undefined || written === '')
  const rel = explicit ? written as string : DEFAULT_KIMI_AGENT_FILE
  const bases = isAbsolute(rel) ? [rel] : [input.repo, input.cwd]
    .filter((base): base is string => typeof base === 'string' && base !== '')
    .map(base => join(base, rel))
  for (const candidate of bases) {
    if (input.exists(candidate)) return { agentFile: candidate }
  }
  return explicit ? { omit: true, note: agentFileMissingNote(rel) } : { omit: true }
}

/**
 * Kimi 那条非交互命令**长什么样**(2026-10-22 真跑过,样本 `tests/fixtures/kimi-stream-json/sample.jsonl`):
 * `kimi -p <prompt> --output-format stream-json --agent-file <智能体文件绝对路径> [-m <模型>]`。
 * Kimi **没有目录参数**,工作目录只能靠子进程 cwd(同 Claude);`--agent-file` 要绝对路径。
 * 名片里写的相对路径**在派发那一层按 `pickAgentFile` 解析**(先 project.repo 后 cwd、不存在就不带,
 * 2026-10-29 任务书「派活智能体文件与起跑换手」)——传进来的 `instructions` 约定已是**解析后的绝对路径**;
 * 这里只兜相对 cwd 的拼法(老调用方:relay 续跑那一类不带智能体文件,用不到这一格)。
 *
 * 强度(effort)这一档传不进去:Kimi Code CLI 2.2.0 的 `-p` 没有思考档参数,它配置里的
 * `[thinking] effort` 要它自己的配置文件管 —— 写在名片里存着,派的时候不带(交接写明)。
 *
 * 续跑(2026-10-23 卡「派活给名片的四处」③):给了会话号带 `--session <id>`(接着那一条,不从头再读一遍)。
 */
export function kimiCliArgv(prompt: string, cwd: string, card: { model?: string | undefined, instructions?: string | undefined, resume?: string | undefined, skipAgentFile?: boolean | undefined }): readonly string[] {
  const written = card.instructions?.trim()
  const rel = written === undefined || written === '' ? DEFAULT_KIMI_AGENT_FILE : written
  const abs = isAbsolute(rel) ? rel : join(cwd, rel)
  const model = card.model?.trim()
  const resume = card.resume?.trim()
  const resuming = !(resume === undefined || resume === '')
  return [
    ...(resuming ? ['--session', resume] : []),
    '-p', prompt,
    '--output-format', 'stream-json',
    /*
     * 续跑**不带** `--agent-file`(2026-10-23 统筹实测,Kimi Code CLI 2.2.0 原话:
     * 「Cannot combine --agent/--agent-file with --session/--continue: the agent is bound at session
     * creation and the bound agent is restored automatically on resume.」)—— 智能体在建会话那一下绑死,
     * 续跑自动恢复;再带一次整条命令直接退出。会话号用结果日志 `session.resume_hint` 里的**整串**
     * (带 `session_` 前缀),少了前缀 Kimi 报 Session not found。
     *
     * `skipAgentFile`(2026-10-29,任务书「派活智能体文件与起跑换手」):派发那一层解析过文件、
     * **决定这次不带**(文件不存在 / 用户层那条路)——那一层带了位回来,这里连缺省那一份也不加,
     * 不然相对 cwd 拼出来的缺省路径照样指向一个不存在的美工文件、命令行一起就退。
     */
    ...(resuming || card.skipAgentFile === true ? [] : ['--agent-file', abs]),
    ...(model === undefined || model === '' ? [] : ['-m', model]),
  ]
}

/**
 * Kimi `stream-json` 的结果(2026-10-22 卡 C):标准输出**每行一个 JSON**,从后往前找 ——
 * 最后一条 `role:"assistant"` 且带 `content` 的就是汇报;`role:"meta", type:"session.resume_hint"`
 * 里的 `session_id` 记下来(对应 `claudeResultOf` 的 `session_id`,挂进卡 links)。
 * 一条都没有 / 全是半截行 → undefined(进程被停掉、半截输出)。
 */
export function kimiResultOf(log: string): { text: string, error: boolean, session_id?: string } | undefined {
  const lines = log.split('\n').map(line => line.trim()).filter(line => line.startsWith('{'))
  let report: { text: string, session_id?: string } | undefined
  let sessionId: string | undefined
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const event = JSON.parse(lines[i] as string) as Record<string, unknown>
      if (sessionId === undefined && event.role === 'meta' && event.type === 'session.resume_hint' && typeof event.session_id === 'string' && event.session_id !== '') {
        sessionId = event.session_id
      }
      if (report === undefined && event.role === 'assistant' && typeof event.content === 'string' && event.content.trim() !== '') {
        report = { text: event.content.trim() }
      }
      if (report !== undefined) break
    }
    catch { /* 半截行跳过 */ }
  }
  if (report === undefined) return undefined
  return { text: report.text, error: false, ...(sessionId === undefined ? {} : { session_id: sessionId }) }
}

/**
 * 派活的目录门(任务书第 4 条)。只在**扫描根底下**跑。
 *
 * 判据是路径前缀 + 分隔符:`/a/b` 放行 `/a/b` 与 `/a/b/c`,但**不放行** `/a/bb`
 * ——少了那个分隔符的话,「/Users/example/Code」这条根会把「/Users/example/CodeXXX」一起放进来。
 * `..` 一律拒绝:这里不做路径规范化(规范化要碰盘,而门必须是纯函数),
 * 所以带 `..` 的路径一概当成算不清,不放行。
 */
export function dispatchCwdAllowed(cwd: string, roots: readonly string[]): boolean {
  if (cwd === '' || !cwd.startsWith('/')) return false
  if (cwd.split('/').includes('..')) return false
  return roots.some(root => {
    if (root === '' || !root.startsWith('/')) return false
    const base = root.endsWith('/') ? root.slice(0, -1) : root
    return cwd === base || cwd.startsWith(`${base}/`)
  })
}

/** 进度写在事项上的那一句。**三档各一句**,措辞固定 —— 卡面、收件箱、电话里念的都是它。 */
export function dispatchNote(dispatch: Pick<TaskDispatch, 'family' | 'status' | 'note' | 'stopped'>): string {
  const who = dispatchFamilyTitle(dispatch.family)
  if (dispatch.status === 'running') return `派给 ${who},进行中`
  if (dispatch.status === 'done') return `派给 ${who},完成`
  // 卡 O:停下来的不是失败(他点了停 / 到时长上限先停下来问他)。
  if (dispatch.stopped === 'user') return `派给 ${who},你停掉了`
  if (dispatch.stopped === 'cap') return `派给 ${who},到时长上限先停下来了`
  const why = dispatch.note === undefined || dispatch.note.trim() === '' ? '没说原因' : dispatch.note.trim()
  return `派给 ${who},失败(${why})`
}

/**
 * 技能段的正文 = 仓库里那份 `docs/技能/派活给别家Agent.md` 的全文 + **这台电脑现探出来的那张表**。
 *
 * 为什么要拼这一下:仓库里那份讲的是"怎么派",而"这台电脑上 codex 在哪"是**每台机器不一样的**
 * ——写死在仓库里就会在别人的机器上指错(2026-09-07 事故里 `~/.local/bin/codex` 被删之后
 * 那条静默失败的钩子,就是这个毛病)。所以路径这一半每次接上时现探现写。
 */
/**
 * 便签四样与回执三态(2026-10-21 协作区,设计稿第五节)。跟在仓库那份技能正文后面、现探那张表前面:
 * 门在服务端(`noteGate.ts`),这一段只是让事务官**事先**知道,不必撞一次 400 / 409 才学会。
 */
export const NOTE_RULES_SECTION: readonly string[] = [
  '## 便签四样与回执(工作台的门,缺了会被拒)',
  '',
  '- **建便签**(`POST /task/create`)带齐四样:`goal_id`(写不出目标就不传,会贴进「未归目标」、标「目标待定」)、'
    + '`from`(`{kind: meeting|session|said|channel|evidence|user, ref?, quote?}` —— 会议 id / 会话 `<家>:<id>` / 他的原话)、'
    + '`acceptance`(1–3 条「做到什么算完」)、`assignee`。缺来源 / 验收 / 负责人一律 400。',
  '- **派之前**(`POST /dispatch/run`)便签上必须已有 `acceptance`;没有就先 `POST /task/update {id, acceptance:[…]}`,否则 409。',
  '- 送给那家的说明由工作台拼:验收自动带 1、2、3 的编号,并写明交回只许三种开头(「做完:」带产物或证据 /「有异议:」带理由 /「卡住:」说卡在哪);'
    + '读回来的话工作台自己认,认不出就在章上标「回执不规范」。做完 / 有异议进「等你」,卡住进「卡住」。**只有他点「做完」才算做完。**',
  '- 别家 agent 不经 `/dispatch/run`、自己交回的,用 `POST /task/receipt {id, receipt: done|objection|blocked, text, evidence?, by: <家>}` 报。',
]

export function dispatchSkillBody(docText: string, clis: readonly AgentCli[]): string {
  const rows = clis.map((cli) => {
    const who = dispatchFamilyTitle(cli.family)
    const order = handOrderText(cli.family)
    /**
     * **只有留着命令行当备用的那家才写路径**(2026-09-22,A3)。
     * Claude 那份的路径写进技能里,事务官就会去试它 —— 而那条路 Ben 定了不走。
     */
    if (apiIsHandFor(cli.family) && !dispatchHands(cli.family).includes('window')) {
      // 走接口那两家:**不写 Key、不写地址**,只写"经中转"与默认模型 ——
      // 技能正文会被写进 ~/.dsh/AGENTS.md,那份文件里一个凭据都不许出现。
      return `| ${who} | ${order} | 经工作台中转发到上游(Key 在服务器上,本机不存);默认模型 \`${API_DISPATCH_MODELS[cli.family as ApiDispatchFamily]}\` |`
    }
    if (!cliIsBackupFor(cli.family)) {
      const why = cli.family === 'claude'
        ? '命令行不用:桌面端的登录态不给它,派活一律走窗口那只手'
        : cli.family === 'doubao'
          ? '窗口先送;送不进去再走接口(经工作台中转,Key 在服务器上,本机不存)'
          : (cli.found ? '命令行不用:这一家只走窗口那只手' : cli.why)
      return `| ${who} | ${order} | ${why} |`
    }
    return cli.found
      ? `| ${who} | ${order} | 命令行在 \`${cli.bin}\`(${cli.source === 'path' ? 'PATH 上装了一份' : '客户端自带的那一份'}) |`
      : `| ${who} | ${DISPATCH_HAND_TITLES.window} | ${cli.why} |`
  })
  return [
    docText.trimEnd(),
    '',
    ...NOTE_RULES_SECTION,
    '',
    '## 这台电脑上现在怎么派(工作台每次接上时现探,不是写死的)',
    '',
    '| 家 | 先用哪只手 | 备注 |',
    '|---|---|---|',
    ...rows,
    '',
    '> 「→」是**顺序**:先试前一只,送不进去才退到后一只。',
    // 卡 O(09-25 维护者设计原则):跟他说的那句不带「命令行」—— 按第一次用的人说结果。
    '> 上面这张表里写「没有命令行」的那家(= 它不能在后台直接改他电脑上的文件),**如实对他说**「X 这会儿还不能直接改你电脑上的文件,'
      + '我自己来做还是等你装」,不要改用别家顶替;**跟他说话不说「命令行」「CLI」**。',
  ].join('\n')
}

/**
 * 技能表里按什么顺序排(表里、界面上、这份技能里都一样,免得每次渲染顺序不同)。
 *
 * ★ 2026-09-25(卡 Z):**有哪几家不再由这里说** —— 传登记表算出来的那一份(`dispatchTargets`)进来,
 * 它就照那个顺序;没传(老调用方、用例)才退回「写过专门接法的那几家」。
 */
export function dispatchFamilies(targets?: readonly DispatchTarget[]): readonly AgentDispatchFamily[] {
  if (targets !== undefined) return targets.map(one => one.id)
  return FAMILY_SOURCES.filter(one => one.self !== true).map(one => one.agent)
}
