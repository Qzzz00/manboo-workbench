/**
 * **各家能力体检**(2026-09-25,卡 O「派活的眼睛」;设计 `docs/设计-谁来做与进度靠证据-2026-09-25.md` 第一节第 3 条)。
 *
 * 维护者:「那就不应该派给 Codex 啊,应该派给 Claude 啊」—— 可派给 Claude 真要改代码,Claude 命令行没登录,
 * 只能打进桌面 App 的聊天窗,聊天改不了本机文件;派出去的活会回来一句「我没法访问你的文件」。
 * 这件事以前**谁也不知道**,直到派出去了才撞上。现在每家三格,**查出来,不是写死的**:
 *
 * | 格 | 查什么(都不碰凭据、不打印凭据) |
 * |---|---|
 * | 能聊天 | 窗口那只手:工作台 App 连着、有辅助功能授权、壳会先开新对话;它的窗口没被对话框挡住(`focus_input` 只找输入框、不送字、不抢焦点) |
 * | 能改本机文件 | 只有**能在指定目录里改文件、又不用人在电脑前批的手**才算:今天 = Claude / Codex / Kimi 的命令行(2026-10-22 卡 C 加 Kimi),**而且要登着**(`claude auth status` / `codex login status`,只取「登没登」一个布尔;Kimi 没有只本地的查法,不跑猜的命令,真派出去它自己会说) |
 * | 能把结果收回来 | 窗口那只手:壳会读回复(`read_reply`);命令行那只手:跑完收结果文件 |
 *
 * ## 为什么 Codex 的窗口不算「能改本机文件」
 *
 * 2026-09-25 只读查了这台 Mac 上派活开出来的 Codex 会话(`~/.codex/sessions/…` 里 `session_meta` / `turn_context` 两行):
 * 窗口里「New Chat」开出来的会话 `cwd` 是 **Codex App 当前选中的那个项目**(这台机器上是 desktop-workbench 的主 checkout),
 * 沙箱 `workspace-write`、批准策略 `on-request` —— 能改文件,但**只能改它当前打开的那个项目**,
 * 越出去要批准时得有人在电脑前点。命令行 `codex exec -C <项目目录> -s workspace-write` 才是
 * 「在指定项目里改、不用人批」。所以写代码的活只走命令行。
 *
 * ## 为什么 Claude 的窗口不算
 *
 * 桌面 App 那扇窗我们控制不了它在哪个目录、用什么权限;派进去还会把他(和统筹)正开着的那扇窗切走。
 * 命令行 `claude -p … --permission-mode acceptEdits` + 沙箱,工作目录由工作台给 —— 那才是能改本机文件的手。
 * 而桌面端的登录态**不给**命令行用(09-21 实测),命令行要**单独登一次**:这正是「登录 Claude」那颗键。
 *
 * ## 这个文件
 *
 * `agentCapFrom` / `agentCapsFrom` 是纯函数(吃「查到的事实」,吐三格);`createAgentCaps` 管什么时候去查、
 * 缓存多久、他点了「登录」之后每几秒看一眼。真去碰进程 / 窗口的那几下全是注入的(`index.ts` 接真的,用例接假的)。
 */
import type {
  AgentCapView, AgentCapsView, CapCell, CapCellView, CapFamily, CapFixView, DispatchHand,
} from '../protocol.ts'
/**
 * 命令行能在指定目录里改文件的那几家(2026-10-22 卡 C 起含 Kimi:Kimi Code CLI 2.2.0 实测可 `-p` 非交互)。
 * **只有这三家**:别家要么没有命令行,要么命令行不是派活用的。
 * ★ 定义在协议层(`protocol.ts` 的 `CODE_CLI_FAMILIES` / `hasCodeCli`,卡「名片编辑表单重排」挪过去的),
 * 这里只是引过来用;要改名单改协议那一处。
 */
import {
  CAP_CELL_TITLES, CODE_CLI_FAMILIES, dispatchFamilyTitle, hasCodeCli,
} from '../protocol.ts'
import { SHELL_DROP_DEAD_LOCAL_BASE_URL, sourceText } from './cliEnv.ts'
import { fallbackTargets } from './dispatchTargets.ts'

/**
 * 体检表上的一行是哪一家(2026-09-25,卡 Z)。**从 Agent 登记表来**:
 * `windowTargets(dispatchTargets(…))` —— 接上了、而且有本机窗口的那几家。
 * 原来这张表等于写死的 `CLIENT_DISPATCH_FAMILIES`,登记表里新接上一家,这里就多一行,不改代码。
 */
export interface CapTarget {
  id: CapFamily
  title: string
}

/**
 * 命令行能在指定目录里改文件的那几家(2026-10-22 卡 C 起含 Kimi:Kimi Code CLI 2.2.0 实测可 `-p` 非交互)。
 * **只有这三家**:别家要么没有命令行,要么命令行不是派活用的。
 * ★ 定义在协议层(`protocol.ts` 的 `CODE_CLI_FAMILIES` / `hasCodeCli`,卡「名片编辑表单重排」挪过去的),要改名单改那一处。
 */

/** 一家命令行此刻的样子。 */
export interface CapCliFact {
  /** 这台电脑上找得到它的命令行(`resolveAgentCli`)。 */
  found: boolean
  /** 登没登:`unknown` = 没查过 / 这次查不出来(不许说成没登)。 */
  login: 'yes' | 'no' | 'unknown'
  /** 查不出来时那一句(给人看的,不含任何输出原文)。 */
  note?: string
  at?: string
  /**
   * 它会继承的那个中转地址(`ANTHROPIC_BASE_URL`,只 Claude 有;`server/cliEnv.ts` 探的)。缺席 = 环境里没有这个变量。
   * 本机的、连不上的(以前 headroom 代理留下的):派活时工作台不带它;远端的、连不上的:命令行就是连不上。
   */
  proxy?: { host: string, port: number, local: boolean, reachable: boolean, source?: 'launchd' | 'process' }
}

/** 看一眼那家的窗口(`focus_input`,只找输入框、不送字、不抢焦点)得到的结论。 */
export type WindowProbeState = 'ok' | 'not_running' | 'sheet' | 'no_window' | 'hidden' | 'ax_off' | 'no_input' | 'error'

export interface CapWindowFact {
  state: WindowProbeState
  /** 对话框的名字、该点的那颗键、查不出来时那一句。 */
  title?: string
  button?: string
  note?: string
  at: string
}

export interface CapHelperFact {
  /** 工作台 App(壳)连着。 */
  connected: boolean
  /** 壳有辅助功能授权。 */
  authorized: boolean
  /** 壳会先开新对话(旧壳会把话打进他正开着的那条对话)。 */
  newConversation: boolean
  /** 壳会读回复。 */
  readReply: boolean
}

export interface CapFacts {
  installed: Partial<Record<CapFamily, boolean>>
  /** 每家叫什么(登记表里的名字)。缺席的按 {@link dispatchFamilyTitle} 退回家名。 */
  titles?: Readonly<Record<string, string>>
  helper: CapHelperFact
  window: Partial<Record<CapFamily, CapWindowFact>>
  cli: Partial<Record<CapFamily, CapCliFact>>
}

/** 这一家叫什么:体检那一份(登记表给的)优先,拿不到就退回家名。 */
function titleOf(family: CapFamily, facts?: CapFacts): string {
  return facts?.titles?.[family] ?? dispatchFamilyTitle(family)
}

/**
 * 「帮我接上」那颗键(统筹 09-25 设计原则:按不懂技术、第一次装的人来说 —— 界面上不出现「命令行」这类词,说结果)。
 * **账号密码工作台不经手**:它开一扇窗口,缺那一份就先用那家官方的安装程序装好(`missing`),再打开那家**自己的**登录页;
 * 登好了工作台自己再查一次,这一格自己变,不用他回来点「刷新」。
 */
export function loginFix(family: 'claude' | 'codex', missing = false): CapFixView {
  const who = titleOf(family)
  const account = family === 'claude' ? 'Claude' : 'ChatGPT'
  return {
    kind: 'login_cli',
    family,
    label: '帮我接上',
    hint: missing
      ? `会开一个窗口,先装好 ${who} 改文件要用的那一份(${who} 官方的安装程序),再打开 ${account} 自己的登录页;账号密码在那一页上填,工作台不经手。好了这一格自己变`
      : `会打开 ${account} 自己的登录页,账号密码在那一页上填,工作台不经手;登好了这一格自己变`,
    desk_only: true,
  }
}

/** 窗口那只手的结论(能聊天、能收回结果共用它的前半截)。 */
function windowCell(family: CapFamily, facts: CapFacts, purpose: 'chat' | 'collect'): CapCellView {
  const who = titleOf(family, facts)
  const helper = facts.helper
  if (!helper.connected) {
    return { state: 'unknown', note: '电脑上的工作台 App 没开着,窗口那只手这会儿用不了' }
  }
  if (!helper.authorized) {
    return {
      state: 'no',
      note: '工作台还没拿到「辅助功能」授权,送不进字、也读不到回答',
      fix: { kind: 'grant_ax', family, label: '去授权', hint: '系统设置 → 隐私与安全性 → 辅助功能,打开「工作台」', desk_only: true },
    }
  }
  if (purpose === 'chat' && !helper.newConversation) {
    return {
      state: 'no',
      note: '电脑上的工作台 App 还是旧版,不会先开新对话 —— 为了不打进你正开着的那条对话,这会儿不送',
      fix: { kind: 'update_shell', family, label: '装新版工作台 App', hint: '设置 → 检查更新,装好重开一次工作台' },
    }
  }
  if (purpose === 'collect') {
    return helper.readReply
      ? { state: 'ok', note: `读 ${who} 窗口里的回答,稳住了收回来`, via: 'window' }
      : {
          state: 'no',
          note: '电脑上的工作台 App 还是旧版,读不回回答',
          fix: { kind: 'update_shell', family, label: '装新版工作台 App', hint: '设置 → 检查更新,装好重开一次工作台' },
        }
  }
  const probe = facts.window[family]
  if (probe === undefined) return { state: 'ok', note: `送得进 ${who} 的窗口(派的时候先开一条新对话)`, via: 'window' }
  switch (probe.state) {
    case 'ok':
      return { state: 'ok', note: `送得进 ${who} 的窗口(派的时候先开一条新对话)`, via: 'window' }
    case 'not_running':
      return { state: 'ok', note: `${who} 这会儿没开着,派活时会先把它打开`, via: 'window' }
    case 'sheet': {
      const button = probe.button ?? '取消'
      const name = probe.title === undefined || probe.title === '' ? '' : `「${probe.title}」`
      /*
       * ★ 2026-09-30(维护者拍板把「叫到台前」那一整套键删掉,见 `docs/决策记录.md`)。
       * **该他自己动的那一步写成一句话,不摆键** —— 原来这三种各挂一颗把那家叫到台前的键,现在把那句人话并进 `note` 里,
       * 与下面 `ax_off` 那一支(一直就只有一句「把 X 退出再打开一次」)一个样子。
       */
      return {
        state: 'no',
        note: `${who} 的窗口上开着一个对话框${name},话会打进那个框里 —— 先在 ${who} 那扇窗上点「${button}」,把对话框关掉`,
      }
    }
    /*
     * ★ **藏在窗口槽里的那一家照旧派得出去**(2026-10-01)。她把一家拉进窗口槽之后,不在台前那一格的
     * App 由工作台自己藏起来,藏着的 App 辅助功能一扇窗都列不出 —— 看一眼当然看不见输入框。
     * 可**派活根本不在这一刻送**:`dispatchClient` 先 `ensureRunning`、再 `bringToFront`
     * (窗位叠里有它就走 `dock.switchTo`,那一下把它放出来、摆到台前),然后才送话。
     * 凭这一眼说「派不了」,就是 Air 10-01 那一条:「已把豆包办公移动到窗口槽里,@ 后依旧无法派活」。
     */
    case 'hidden':
      return { state: 'ok', note: `${who} 这会儿藏在窗口槽里,派活时工作台会先切到它那一格再送`, via: 'window' }
    case 'no_window':
      return {
        state: 'no',
        note: `${who} 开着,但一扇窗都没有(可能缩在程序坞里,或只剩菜单栏图标)—— 把 ${who} 的窗口叫出来(点程序坞里的 ${who})`,
      }
    case 'no_input':
      return {
        state: 'no',
        note: `找到了 ${who} 的窗口,但没找到能写字的输入框(可能停在设置页之类)—— 把 ${who} 切回对话页`,
      }
    case 'ax_off':
      return { state: 'no', note: `读不到 ${who} 的窗口(它的辅助功能通道关着)—— 把 ${who} 退出再打开一次` }
    default:
      return { state: 'unknown', note: probe.note ?? `这次没看成 ${who} 的窗口` }
  }
}

/** 命令行那只手能不能用(聊天 / 收回结果 / 改文件共用)。 */
function cliUsable(family: CapFamily, facts: CapFacts): boolean {
  const cli = facts.cli[family]
  return hasCodeCli(family) && cli?.found === true && cli.login === 'yes'
}

function editCell(family: CapFamily, facts: CapFacts): CapCellView {
  const who = titleOf(family, facts)
  if (!hasCodeCli(family)) return { state: 'na', note: '只能聊天,改不了你电脑上的文件' }
  const cli = facts.cli[family]
  if (cli === undefined || cli.login === 'unknown' && cli.found) {
    return { state: 'unknown', note: cli?.note ?? `还没查到 ${who} 能不能直接改你电脑上的文件` }
  }
  if (!cli.found) {
    // 普通用户多半没有这一份(统筹 09-25):说结果、给一键。Claude 缺的那一份用它官方的安装程序装;Codex 那一份跟着 ChatGPT 走;
    // Kimi 那一份是 brew 装的(2026-10-22 卡 C),装法照 `resolveAgentCli` 那一句,不另写第二句。
    return family === 'claude'
      ? { state: 'no', note: `要让 ${who} 直接改你电脑上的文件,还差一步`, fix: loginFix(family, true) }
      : family === 'kimi'
        ? { state: 'no', note: `要让 ${who} 直接改你电脑上的文件,还差一步:这台电脑上没装 Kimi Code CLI(brew install kimi-code),装好用 Kimi 的账号登录一次` }
        : {
            // 2026-09-30:那颗把 ChatGPT 叫到台前的键删了,该做的那一步写在这一句里(维护者拍板)。
            state: 'no',
            note: `要让 ${who} 直接改你电脑上的文件,还差一步:在 ChatGPT 里检查更新,把它更新到最新版;更新完这一格自己变`,
          }
  }
  /**
   * 中转地址(2026-09-25,统筹:「命令行派活别继承死掉的代理地址」):
   * - 远端的、连不上 → 命令行派出去也连不上,这一格就是「不行」(不替他改地址:去掉它请求会带着给中转的令牌改道去官方);
   * - 本机的、连不上(以前 headroom 代理留下的 127.0.0.1:8787)→ 派活时工作台不带这个地址,照常判,只补一句说清。
   */
  const proxy = cli.proxy
  const where = proxy === undefined ? '' : proxy.host.includes(':') ? `[${proxy.host}]:${proxy.port}` : `${proxy.host}:${proxy.port}`
  if (proxy !== undefined && !proxy.reachable && !proxy.local) {
    return {
      state: 'no',
      note: `${who} 被设成先连一个中转,那个中转这会儿连不上(${where})—— 派出去也连不上;这个设置${sourceText(proxy.source)},要懂的人来改(工作台不替你改),这之前写代码的活先交给别家${cli.login === 'no' ? ';另外还要登录一次' : ''}`,
      // 「登录」那颗键只有 Claude / Codex 两家有(2026-10-22:Kimi 没有只本地的查法,login 到不了 'no' 这一支)。
      ...(cli.login === 'no' && (family === 'claude' || family === 'codex') ? { fix: loginFix(family) } : {}),
    }
  }
  const deadLocal = proxy !== undefined && !proxy.reachable && proxy.local
    ? `。另外:${who} 被设成先连一个本机中转(${where}),那上面早就没人在听了 —— 这个设置${sourceText(proxy.source)};工作台派活时会绕开它,直接连 ${who},不用你管`
    : ''
  if (cli.login === 'no') {
    // 同上:Kimi 到不了这一支(它的「登没登」只可能是 unknown)—— 这句登录指引只对 Claude / Codex 说。
    if (family === 'claude' || family === 'codex') {
      return {
        state: 'no',
        note: `要让 ${who} 直接改你电脑上的文件,还差一步:登录一次${deadLocal}`,
        fix: loginFix(family),
      }
    }
    return { state: 'unknown', note: `要让 ${who} 直接改你电脑上的文件,还差一步:用 ${who} 的账号登录一次它的命令行` }
  }
  return {
    state: 'ok',
    via: 'cli',
    note: family === 'codex'
      ? '能直接改你电脑上的文件(在你指定的项目里,后台做;Codex 窗口里那个只能改它当前打开的项目,所以改文件不走窗口)'
      : `能直接改你电脑上的文件(在你指定的项目里,后台做,不用你盯)${deadLocal}`,
  }
}

/** 三格里「好」的那几格靠哪几只手,按手的顺序合成一格。 */
function either(first: CapCellView, second: CapCellView | undefined): CapCellView {
  if (first.state === 'ok' || second === undefined) return first
  if (second.state === 'ok') return second
  // 两只手都不行:先说窗口那只的原因(它是这一格的主手),命令行那只只在窗口那只说不出来时顶上。
  return first.state === 'unknown' && second.state === 'no' ? second : first
}

/** 一家的三格。纯函数。名字从 `facts.titles`(登记表)来,没有就退回家名。 */
export function agentCapFrom(family: CapFamily, facts: CapFacts): AgentCapView {
  const who = titleOf(family, facts)
  const installed = facts.installed[family]
  if (installed === false) {
    const na: CapCellView = { state: 'na', note: `这台电脑上没装 ${who}` }
    return { family, title: who, installed: false, cells: { chat: na, edit: na, collect: na }, line: `这台电脑上没装 ${who}` }
  }
  const cliCell = (purpose: 'chat' | 'collect'): CapCellView | undefined => {
    if (!hasCodeCli(family)) return undefined
    if (cliUsable(family, facts)) {
      return { state: 'ok', via: 'cli', note: purpose === 'chat' ? `后台那条路也通,${who} 也能在那儿答` : '后台做完把结果收回来' }
    }
    return undefined
  }
  const chat = either(windowCell(family, facts, 'chat'), cliCell('chat'))
  const collect = either(windowCell(family, facts, 'collect'), cliCell('collect'))
  const edit = editCell(family, facts)
  const cells: Record<CapCell, CapCellView> = { chat, edit, collect }
  return { family, title: who, ...(installed === undefined ? {} : { installed }), cells, line: capLine(who, cells) }
}

/** 一家那一句:行的几格连起来,不行的那一格说原因(只说最要紧的一条)。 */
export function capLine(who: string, cells: Readonly<Record<CapCell, CapCellView>>): string {
  const order: CapCell[] = ['chat', 'edit', 'collect']
  const ok = order.filter(cell => cells[cell].state === 'ok').map(cell => CAP_CELL_TITLES[cell])
  const problem = order.map(cell => cells[cell]).find(one => one.state === 'no')
  const unknown = order.map(cell => cells[cell]).find(one => one.state === 'unknown')
  const onlyChat = cells.edit.state === 'na' ? '(只能聊天,改不了本机文件)' : ''
  if (problem !== undefined) return `${who}:${problem.note}`
  if (unknown !== undefined && ok.length === 0) return `${who}:${unknown.note}`
  return `${who}:${ok.join('、')}${onlyChat}`
}

/**
 * 整张表。**哪几家从 `extra.families`(Agent 登记表算出来的那一份)来**;缺席时退回
 * 「写过专门接法、有本机 App 的那几家」(老宿主 / 用例),与 09-25 之前一字不变。
 */
export function agentCapsFrom(
  facts: CapFacts,
  extra: { checked_at?: string, checking?: boolean, login_wait?: AgentCapsView['login_wait'], families?: readonly CapTarget[] } = {},
): AgentCapsView {
  const families = extra.families ?? fallbackTargets().map(one => ({ id: one.id, title: one.title }))
  const titles: Record<string, string> = { ...Object.fromEntries(families.map(one => [one.id, one.title])), ...facts.titles }
  const withTitles: CapFacts = { ...facts, titles }
  const agents = families.map(one => agentCapFrom(one.id, withTitles))
  const editors = agents.filter(one => one.cells.edit.state === 'ok').map(one => one.title)
  // 还差一步的那几家只写名字(按钮就在那一格里):不把「帮我接上」这种按钮字拼进句子里念。
  const fixes = agents.filter(one => one.installed !== false)
    .filter(one => Object.values(one.cells).some(cell => cell.state === 'no' && cell.fix !== undefined))
    .map(one => one.title)
  const parts = [
    editors.length === 0 ? '这会儿没有一家能直接改你电脑上的文件' : `能直接改你电脑上的文件的:${editors.join('、')}`,
    ...(fixes.length === 0 ? [] : [`还差一步的:${fixes.join('、')}(点那一格里的按钮)`]),
  ]
  return {
    agents,
    ...(extra.checked_at === undefined ? {} : { checked_at: extra.checked_at }),
    ...(extra.checking === true ? { checking: true } : {}),
    ...(extra.login_wait === undefined ? {} : { login_wait: extra.login_wait }),
    line: parts.join(';'),
  }
}

/** 某一家此刻能不能改本机文件、能不能聊(派活挑手用)。 */
export function canEdit(view: AgentCapsView | undefined, family: string): boolean {
  return view?.agents.find(one => one.family === family)?.cells.edit.state === 'ok'
}

// ───────────────────────── 读壳的失败原话 ─────────────────────────

/**
 * 壳 `focus_input` 回的失败原话 → 一种窗口状况(原话见 `SendTextPolicy.Failure.message`)。
 * 对话框那一句新壳会带名字与按钮(「对话框「存储」(……按钮:取消 / 存储)」),老壳没有 —— 两种都认。
 */
export function windowFactOf(message: string, at: string): CapWindowFact {
  if (message.includes('对话框')) {
    const named = /对话框「([^」]+)」/.exec(message)
    const buttons = /按钮[::]\s*([^)）]+)/.exec(message)?.[1]?.split(/\s*\/\s*/).map(one => one.trim()).filter(one => one !== '') ?? []
    const button = buttons.find(one => /^(取消|Cancel|关闭|Close|不存储|Don’t Save|Don't Save)$/i.test(one)) ?? buttons[0]
    return {
      state: 'sheet',
      ...(named?.[1] === undefined ? {} : { title: named[1] }),
      ...(button === undefined ? {} : { button }),
      at,
    }
  }
  if (message.includes('没在运行') || message.includes('未在运行')) return { state: 'not_running', at }
  if (message.includes('一扇标准窗口都没有') || message.includes('找不到窗口')) return { state: 'no_window', at }
  if (message.includes('辅助功能通道关着')) return { state: 'ax_off', at }
  if (message.includes('输入框没找到')) return { state: 'no_input', at }
  return { state: 'error', note: message.length > 80 ? `${message.slice(0, 80)}…` : message, at }
}

// ───────────────────────── 读命令行的「登没登」 ─────────────────────────

export interface CliRunResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * 那家命令行自己的「登没登」→ 一个布尔。**只取这一个布尔**:输出里别的东西(账号、组织、目录)一个字都不留、不打印。
 *
 * - Claude:`claude auth status --json` → `{"loggedIn": false, …}`(2.1.280 实测:只有 loggedIn / authMethod / apiProvider 这类键,没有凭据);
 * - Codex:`codex login status` → 「Logged in using ChatGPT」/「Not logged in」(退出码 0 / 1);
 * - Kimi(2026-10-22 卡 C):没有只本地的查法,**不跑猜的命令**(D13)—— 回 unknown,真派一次它自己会说。
 */
export function cliLoginOf(family: 'claude' | 'codex' | 'kimi', run: CliRunResult): { login: 'yes' | 'no' | 'unknown', note?: string } {
  if (family === 'kimi') return { login: 'unknown', note: 'Kimi 登没登这次没查(它没有只本地的查法;真派出去它自己会说)' }
  if (family === 'claude') {
    try {
      const parsed = JSON.parse(run.stdout.trim()) as { loggedIn?: unknown }
      if (parsed.loggedIn === true) return { login: 'yes' }
      if (parsed.loggedIn === false) return { login: 'no' }
    }
    catch { /* 不是 JSON:落到下面 */ }
    return { login: 'unknown', note: '这次没看出 Claude 登没登(它回的话看不懂)' }
  }
  const text = `${run.stdout}\n${run.stderr}`
  if (/not logged in/i.test(text)) return { login: 'no' }
  if (/logged in/i.test(text)) return { login: 'yes' }
  return { login: 'unknown', note: '这次没看出 Codex 登没登' }
}

/**
 * 「登录 X」那扇终端窗口里跑的脚本。**只跑那家自己的登录命令**:账号密码在它自己的登录页上填,
 * 工作台既看不见也不经手;脚本里没有任何凭据、不读任何凭据文件。
 */
/** Claude 官方的安装程序(装好的那一份在 `~/.local/bin/claude`)。只在他点了「帮我接上」、那一份又不在的时候,在他看得见的窗口里跑。 */
export const CLAUDE_INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash'

export function loginScript(family: 'claude' | 'codex', bin: string | undefined): string {
  const who = titleOf(family)
  const account = family === 'claude' ? 'Claude' : 'ChatGPT'
  const quoted = bin === undefined ? undefined : `'${bin.replace(/'/g, `'\\''`)}'`
  const verb = family === 'claude' ? 'auth login --claudeai' : 'login'
  // 缺那一份(只 Claude 这么做):先用它官方的安装程序装好,再用装好的那一份登录。
  const install = family === 'claude' && quoted === undefined
    ? [
        `echo "先装好 ${who} 改文件要用的那一份(${who} 官方的安装程序,大概一两分钟)……"`,
        CLAUDE_INSTALL_COMMAND,
        'WB_BIN="$HOME/.local/bin/claude"',
        'if [ ! -x "$WB_BIN" ]; then WB_BIN="$(command -v claude)"; fi',
        `if [ -z "$WB_BIN" ] || [ ! -x "$WB_BIN" ]; then echo ""; echo "没装上 —— 这个窗口留着,上面那几行就是原因;可以关掉它,回工作台先把这件交给别家做。"; exit 1; fi`,
        'echo ""',
      ]
    : []
  const command = quoted === undefined ? `"$WB_BIN" ${verb}` : `${quoted} ${verb}`
  return [
    '#!/bin/zsh',
    'clear',
    `echo "帮你接上 ${who}(工作台替你打开的窗口)"`,
    `echo "接下来会打开 ${account} 自己的登录页:账号密码只在那一页上填,工作台不经手。"`,
    'echo ""',
    // 他电脑上要是还留着以前别的工具设的本机代理地址(没人在听),装、登录那一下也会连不上 —— 同派活那条规矩,只拿掉这一个。
    ...(family === 'claude' ? [SHELL_DROP_DEAD_LOCAL_BASE_URL] : []),
    ...install,
    command,
    'echo ""',
    `echo "好了就可以关掉这个窗口 —— 工作台会自己发现,设置里「${who}」那一行会自己变。"`,
    '',
  ].join('\n')
}

// ───────────────────────── 服务:什么时候去查 ─────────────────────────

export interface AgentCapsDeps {
  /**
   * 体检哪几家(2026-09-25,卡 Z):Agent 登记表算出来的、有本机窗口的那几家
   * (`windowTargets(dispatchTargets(…))`)。缺席 = 老宿主 / 用例:退回「写过专门接法、有 App 的那几家」。
   */
  families?: () => readonly CapTarget[]
  /** 那家的 app 装没装(`undefined` = 查不出来)。 */
  installed: (family: CapFamily) => boolean | undefined
  helper: () => CapHelperFact
  /** 这一家的命令行在这台电脑上找不找得到(只问写代码的那三家)。 */
  cliFound: (family: 'claude' | 'codex' | 'kimi') => boolean
  /** 问那家命令行登没登(真跑一下它自己的 status 命令)。**绝不抛**。 */
  cliLogin: (family: 'claude' | 'codex' | 'kimi') => Promise<{ login: 'yes' | 'no' | 'unknown', note?: string }>
  /** 那家命令行会继承的中转地址探得通不通(只 Claude;`server/cliEnv.ts`)。缺席 = 不看。**绝不抛**。 */
  cliProxy?: (family: 'claude' | 'codex' | 'kimi') => Promise<CapCliFact['proxy']>
  /** 看一眼那家的窗口(只找输入框、不送字、不抢焦点)。缺席 = 不看窗口(没接壳)。 */
  probeWindow?: (family: CapFamily) => Promise<CapWindowFact>
  now: () => Date
  onChanged?: () => void
  /** 命令行登没登多久重查一次(后台)。缺省 10 分钟。 */
  cliTtlMs?: number
  /** 点了「登录」之后每几秒看一眼。缺省 4 秒。 */
  loginPollMs?: number
  /** 最多等他登多久。缺省 10 分钟。 */
  loginWaitMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface AgentCaps {
  view: () => AgentCapsView
  /**
   * ★ **只问一家的那三格,一个字都不碰「体检哪几家」**(2026-10-03,卡「0.4.87 启动崩溃」;
   * 交接 `docs/交接-1003-0.4.87启动崩溃.md`)。
   *
   * 为什么要单开这一格:窗口那条通道的 `capabilities()` 要的只有 `chat` / `collect` 两格
   * (「送得进话吗」「收得回结果吗」),而 {@link view} 的第一件事是算**体检哪几家**
   * (`deps.families()` → `capTargetsFor` → 引擎登记处的 `targetsNow()`)—— 于是
   * 「这一条通道会什么」绕一圈回去问「有哪几家」,0.4.87 在维护者那台上就是这么同步递归爆栈的。
   *
   * 这一格只认**一家**:装没装、壳此刻什么样、那一家窗口 / 命令行上次查到的事实,
   * **「有哪几家」不参与** —— 存在与能力分开,正是「四件套的根子」那一条。
   */
  cellsOf: (family: CapFamily) => Readonly<Record<CapCell, CapCellView>>
  /**
   * 真去查一遍。`window:true` 连窗口一起看(只看开着的几家;设置里打开那张表 / 派活前用);
   * 缺省只查命令行登没登。**绝不抛**。
   */
  check: (opts?: { window?: boolean, families?: readonly CapFamily[] }) => Promise<AgentCapsView>
  /** 后台:命令行那一半过期了就重查(不看窗口)。挂在 /state 那一拍上,节流。 */
  pump: () => void
  /** 他点了「登录 X」:每几秒看一眼,登好了就停(或者等够了)。 */
  waitLogin: (family: 'claude' | 'codex') => void
  /**
   * 这一家命令行此刻探到的事实(`found` / `login`;2026-10-22 卡 C 收尾)。**还没探过回 undefined** ——
   * 派活挑「能换的几家」据此只列真探到、且登录状态不是 `no` 的家(没装的机器不把 Kimi 推荐出去)。
   */
  cliFact?: (family: 'claude' | 'codex' | 'kimi') => CapCliFact | undefined
  /**
   * 他点了「帮我接上」、那一家登好了(工作台自己查到的,不用他回来点刷新)就叫一次。派活那一层据此把因为这个
   * 卡在「派不出去」的那几件接着派出去(统筹 09-25 设计原则:按第一次用的人想 —— 登好了就该接着干)。回一个取消订阅的函数。
   */
  whenLoggedIn: (listener: (family: 'claude' | 'codex') => void) => () => void
  stop: () => void
}

export function createAgentCaps(deps: AgentCapsDeps): AgentCaps {
  const cliTtlMs = deps.cliTtlMs ?? 10 * 60_000
  const loginPollMs = deps.loginPollMs ?? 4000
  const loginWaitMs = deps.loginWaitMs ?? 10 * 60_000
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  const cli: Partial<Record<CapFamily, CapCliFact>> = {}
  const window: Partial<Record<CapFamily, CapWindowFact>> = {}
  /** 体检哪几家(卡 Z:登记表算出来的那一份)。没接就退回「写过专门接法、有 App 的那几家」。 */
  const familiesNow = (): readonly CapTarget[] => deps.families?.() ?? fallbackTargets().map(one => ({ id: one.id, title: one.title }))
  let cliCheckedAt: number | undefined
  let checkedAt: string | undefined
  let checking = false
  let login: { family: 'claude' | 'codex', since: string, timer: unknown } | undefined
  const loggedInListeners = new Set<(family: 'claude' | 'codex') => void>()

  function facts(): CapFacts {
    const installed: Partial<Record<CapFamily, boolean>> = {}
    const titles: Record<string, string> = {}
    for (const one of familiesNow()) {
      titles[one.id] = one.title
      const state = deps.installed(one.id)
      if (state !== undefined) installed[one.id] = state
    }
    return { installed, titles, helper: deps.helper(), window, cli }
  }

  function changed(): void {
    try { deps.onChanged?.() } catch { /* 推快照失败不连累体检 */ }
  }

  async function checkCli(family: 'claude' | 'codex' | 'kimi'): Promise<void> {
    const found = deps.cliFound(family)
    const at = deps.now().toISOString()
    if (!found) { cli[family] = { found: false, login: 'unknown', at }; return }
    let result: { login: 'yes' | 'no' | 'unknown', note?: string }
    try { result = await deps.cliLogin(family) }
    catch { result = { login: 'unknown', note: `这次没问出 ${titleOf(family)} 登没登` } }
    let proxy: CapCliFact['proxy']
    try { proxy = await deps.cliProxy?.(family) }
    catch { proxy = undefined }
    cli[family] = { found: true, login: result.login, ...(result.note === undefined ? {} : { note: result.note }), at, ...(proxy === undefined ? {} : { proxy }) }
  }

  async function check(opts: { window?: boolean, families?: readonly CapFamily[] } = {}): Promise<AgentCapsView> {
    const families = opts.families ?? familiesNow().map(one => one.id)
    checking = true
    try {
      for (const family of families) {
        if (hasCodeCli(family)) await checkCli(family)
      }
      if (opts.window === true && deps.probeWindow !== undefined) {
        const helper = deps.helper()
        if (helper.connected && helper.authorized) {
          for (const family of families) {
            // 没装的不看(看了也是「没在运行」);一家看坏了不连累别家。
            if (deps.installed(family) === false) continue
            try { window[family] = await deps.probeWindow(family) }
            catch (error) { window[family] = windowFactOf(error instanceof Error ? error.message : String(error), deps.now().toISOString()) }
          }
        }
      }
      cliCheckedAt = deps.now().getTime()
      checkedAt = deps.now().toISOString()
    }
    catch { /* 绝不抛:查不出来的那几格留 unknown */ }
    finally { checking = false }
    changed()
    return view()
  }

  /**
   * 一家的那三格(见 {@link AgentCaps.cellsOf})。**不经 `facts()`**:`facts()` 要过一遍
   * `familiesNow()`,而那一步会回头问引擎登记处的候选名单 —— 这一格存在的全部理由就是不走那一步。
   */
  function cellsOf(family: CapFamily): Readonly<Record<CapCell, CapCellView>> {
    const state = deps.installed(family)
    return agentCapFrom(family, {
      installed: state === undefined ? {} : { [family]: state },
      helper: deps.helper(),
      window,
      cli,
    }).cells
  }

  function view(): AgentCapsView {
    return agentCapsFrom(facts(), {
      families: familiesNow(),
      ...(checkedAt === undefined ? {} : { checked_at: checkedAt }),
      checking,
      ...(login === undefined ? {} : { login_wait: { family: login.family, since: login.since } }),
    })
  }

  function pump(): void {
    if (checking) return
    if (cliCheckedAt !== undefined && deps.now().getTime() - cliCheckedAt < cliTtlMs) return
    cliCheckedAt = deps.now().getTime()
    void check({ families: CODE_CLI_FAMILIES }).catch(() => undefined)
  }

  function stopLogin(): void {
    if (login === undefined) return
    clearTimer(login.timer)
    login = undefined
  }

  function waitLogin(family: 'claude' | 'codex'): void {
    stopLogin()
    const since = deps.now()
    let polling = false
    const timer = setTimer(() => {
      if (polling) return
      polling = true
      void (async () => {
        try {
          await checkCli(family)
          const done = cli[family]?.login === 'yes'
          const expired = deps.now().getTime() - since.getTime() > loginWaitMs
          if (done || expired) stopLogin()
          changed()
          if (done) {
            for (const listener of loggedInListeners) {
              try { listener(family) }
              catch { /* 接着派没派成是派活那一层的事,不连累体检 */ }
            }
          }
        }
        finally { polling = false }
      })()
    }, loginPollMs)
    login = { family, since: since.toISOString(), timer }
    changed()
  }

  return {
    view,
    cellsOf,
    check,
    pump,
    waitLogin,
    cliFact: family => cli[family],
    whenLoggedIn(listener) {
      loggedInListeners.add(listener)
      return () => { loggedInListeners.delete(listener) }
    },
    stop: stopLogin,
  }
}
