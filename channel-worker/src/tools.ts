/**
 * 通话里的三件工具。**都在本机直接执行** —— 这是换掉火山 RTC 智能体最实在的那一条好处:
 * 不需要任何公网回调地址(对比 workbench-plugin/src/server/rtcCall.ts 顶部那段限制)。
 *
 *   wb_remember_item   他说「记下来 / 记一下 / 先记着」→ POST 8791 /task/create(**只建卡,不开会话**)
 *   wb_dispatch_item   他要事务官**去办**一件新的事 → POST 8791 /butler/item(建卡 + 在 DSH 里开会话)
 *   wb_list_doing      他问「现在在办什么」→ GET 8791 /state,现查现答
 *   wb_hand_to_butler  他给**已经在办**的某件事补一句 → POST 8791 /butler/item/say
 *   wb_item_progress   他问「XX 到哪了」→ POST 8791 /progress/ask(当场按证据核那一件,2026-09-25 卡 N)
 *
 * 「记」与「办」分成两件工具(2026-09-23 `fix/call-remember-direct`):以前 wb_remember_item
 * 一律开会话,12:39 那一通为了记一句话,那条会话通读记忆跑了约 30 次工具、吃掉 35 万 token,
 * 把当天额度撞满。分界由**模型选哪件工具**表达,不靠关键词猜(见 remember.ts 顶上)。
 * wb_list_doing 的名字与 0.2.33 通话模式那一件(rtcCall.ts 的 CALL_TOOL_DOING)一模一样。
 *
 * 第三个是通道层新加的。为什么不让它也去建一条新事项:他说「刚才那件事,顺便把 X 也办了」,
 * 建第二张卡的话看板上会多出一件没头没尾的事,而正在办那条会话根本不知道。所以它走
 * /butler/item/say —— 8791 那条路由把这句话投进那条事项底下的 DSH 会话。
 *
 * 每个工具都**返回一句给模型看的话**(不是抛异常):办成了说办成了,没办成说没办成。
 * 电话里最坏的失真是「答应了但其实没办」,所以失败也必须有话可说(D13)。
 */
import { llm } from '@livekit/agents'
import type { WorkbenchClient } from './workbench.ts'
import { TODO_VIEWS, todoViewConfirmText, type TodoView } from './todoView.ts'
import { itemAssigneeOf } from './workbench.ts'
import type { VoiceClient, VoiceOption, VoiceWant } from './voice.ts'
import { askWhichLine, cannotSpeakChineseLine, matchSpoken, parseWant, pickByDescription, sampleLine, speaksChinese, voiceLabel, wantOtherThan } from './voice.ts'
import { judgePreference } from './prefs.ts'
import type { CallAsk } from './confirm.ts'
import { DIRECT_DONE_NOTE, askReasonLine, confirmGateText, confirmGateTextNoHold, confirmGateTextSimple, fallbackSpoken, heldText, unconfirmedDesc } from './confirm.ts'
import { looksLikeCalendarNote, noteFields, notRememberedText, rememberedText } from './remember.ts'
import { butlerAskPrefix, looksLikeInterrupt, looksLikeLookupOnly, looksLikeRelay } from './butlerRoute.ts'
import { HUB_TOOL_OF, createHubTools } from './hubTools.ts'
import { canonicalWho, matchSpokenFamily } from './agentName.ts'
import { relayIntent } from './relayIntent.ts'
import { END_CALL_DESCRIPTION, TOOL_END_CALL } from './farewell.ts'
import type { DeviceInfo } from './files/devices.ts'
import { pickDevice } from './files/devices.ts'
import type { DeviceSearchSlice, FoundHandles, FoundPaths } from './files/deviceTools.ts'
import {
  confirmPrompt,
  handleOf,
  notSentText,
  pathAllowed,
  pathDeniedText,
  rememberFound,
  sendingText,
  sentText,
  spokenSearchResults,
  unknownDeviceText,
} from './files/deviceTools.ts'

/**
 * 写板子的那几件 = 理解中枢命令表(A2,2026-10-28;hubTools.ts)。下面几个旧名字指到对应的那件,
 * 给意图对照表、垫场白名单与通话记录接着用。
 */
/** **只记**:命令 note,只建卡、不派。 */
export const TOOL_REMEMBER = HUB_TOOL_OF.note
/** **派活**:命令 dispatch。 */
export const TOOL_DISPATCH = HUB_TOOL_OF.dispatch
export const TOOL_DOING = 'wb_list_doing'
/** 「XX 到哪了」:当场按证据核那一件(卡 N)。 */
export const TOOL_PROGRESS = 'wb_item_progress'
/** 「下午三点跟 B 客户谈…」:登记一场待开的会(2026-10-10,卡「会前画像与预案」)。 */
export const TOOL_PLAN_MEETING = 'wb_plan_meeting'
/**
 * 「我 20 号计划发一个大赛回顾的视频」「把这条记到日历上」:
 * **往她日历上记一条发布计划**(2026-10-13 下午,卡 B)。一张派活卡都不建、没有人在办。
 */
export const TOOL_PUBLISH_PLAN = 'wb_publish_plan'
/** 答那场会还差的那一问(五问一问一答)。 */
export const TOOL_ANSWER_MEETING = 'wb_answer_meeting'
/** 给板上某张卡补一句:命令 supplement。 */
export const TOOL_HAND = HUB_TOOL_OF.supplement
/**
 * 第四件(2026-09-21,座机主动来电):**电话里当场落一个决定**。
 * 只在一通「她主动打来」的电话里挂上去(agent.ts 接起来那一刻 updateTools),
 * 平时的通话里没有它 —— 他随口说一句「那个可以」不该把某张卡挪走。
 */
export const TOOL_DECIDE = 'wb_decide_item'
/**
 * 「等你回答」那一通(2026-09-25,卡 M):事务官在 DSH 会话里问他的一问 / 要他批的一条,他在电话里说了意思,
 * **原话**交给工作台(`POST /asks/voice`);工作台认得出是哪个选项就选它,认不准就当「我自己说」交上去。
 * 只挂在这种电话上(agent.ts 的 wearRing),平时没有它。
 */
export const TOOL_ANSWER_ASK = 'wb_answer_ask'

/**
 * ——— 2026-09-23 加的四件(Ben 第五通电话) ———
 *
 * 他那一通里三次撞到「她做不了」:要她派单(没有这件工具)、要她换音色(没有这件工具)、
 * 要她记住一条以后都算数的规矩(没有这件工具,于是三次说「记住了」而什么都没落盘)。
 * 这四件就是那三个洞,外加把「要判断的事」交回本体的那一条。
 */
/*
 * 以前这里还有一件 `wb_create_item`(建一张卡、不开会话,但要过确认点)。它和「只记」的
 * wb_remember_item 是同一件事,两件摆在模型面前只会让它在「记下来」上挑错 —— 已并进 wb_remember_item。
 */
/** 电话里换音色:先念几个给他挑,他挑定了当场换。 */
export const TOOL_VOICE = 'wb_set_voice'
/** 记一条**长期**规矩(「以后 / 每次 / 别再」那一类):命令 remember。 */
export const TOOL_PREFERENCE = HUB_TOOL_OF.remember
/** 把要判断、要读记忆的那一句**转给事务官本尊**,拿它的原话再念。 */
export const TOOL_ASK_BUTLER = 'wb_ask_butler'
/**
 * **给某条正在跑的会话捎句话**(2026-09-26,卡 BR)。
 *
 * 维护者 16:41 那一通:「给那个 Claude,现在正在做统筹交接的那个会话窗口,发个信息问一下:
 * 现在进行到什么情况,大概什么时候能处理完」。那会儿一件能做这事的工具都没有 ——
 * 最近的是 {@link TOOL_ASK_BUTLER},而它**要一个事项 id**,于是他听到的是「它归哪件事」。
 * 维护者:「它不能给你发信息」,算 bug。
 *
 * 这一件走 `POST /sessions/relay`:**不要事项**,认会话靠他嘴里的标题 / 家名 / 状态。
 */
export const TOOL_RELAY_SESSION = 'wb_relay_to_session'
/**
 * **看一眼某一家此刻在跑的那条对话**(2026-09-27,卡 LK)。「问状态」与「捎话」从此是两件工具。
 *
 * 维护者 21:2x 那一通:他问「现在 Codex 是什么状态?他正在跑那个参赛网页那个东西」,
 * 事务官先答**看板上的旧事项**({@link TOOL_PROGRESS} 核的是事项),他纠正之后事务官又去
 * **给 Codex 捎话**({@link TOOL_RELAY_SESSION});他明说「不要给他发信息,就看一眼」,
 * 答回来的还是旧事项。他挂了电话。
 *
 * 这一件只读:`GET /sessions/lookup`,回一句「在跑还是停了 · 最后一次动静多久前 · 最后一句在干什么」。
 */
export const TOOL_SESSION_STATUS = 'wb_session_status'

/**
 * 盯着刚捎过去的那句话,别家回了就打电话(2026-09-27)。
 *
 * 2026-10-03:**名字从字面提成常量** —— 卡「首声提速」的意图→工具对照表
 * (`intentTools.ts`)按名字挑工具,抄一遍字符串就等于「这一组悄悄少一件」。
 */
export const TOOL_WATCH_REPLY = 'wb_watch_reply'

/** 在几台授权过的设备上按文件名找文件(2026-09-21)。**不读内容**。 */
export const TOOL_SEARCH_FILES = 'wb_search_files'
/** 把找到的文件从一台设备传到另一台(2026-09-21)。2026-10-12 起说清了直接传,只在她说「先跟我确认」时先复述。 */
export const TOOL_SEND_FILE = 'wb_send_file'

/**
 * 电话里改工作台的版面(2026-09-22,「非标需求由事务官直接改」第一层)。
 *
 * 2026-10-12(维护者拍板「电话里只在拿不准时先确认」)起:**说清了直接改**,改完提一句「撤销」;
 * 只在他说「先跟我确认」(或者判不准:8791 没给那一格)时先复述一句,他说对了带 `confirmed: true` 再调。
 * 界面上那条路(`/layout/confirm`)那张卡这次不动 —— 屏幕上点一下不算啰嗦,电话里每次念一遍才算。
 */
export const TOOL_LAYOUT = 'wb_layout'

/** 改布局那几种动作。**与 8791 的 LAYOUT_ACT_KINDS 同一份**;工作台认不出的一律 400。
 * (2026-10-22 起 `export`,给 `tests/layout-kinds-sync.test.ts` 读;那份读插件源码比对,漂了那条红。) */
export const LAYOUT_KINDS = ['move', 'region', 'hide', 'show', 'rename', 'resize', 'swap'] as const

/** 复述那一句(纯拼字,不经模型)。**从他给的参数里拼**,不是生成的。 */
export function layoutConfirmText(input: {
  kind: string, module: string, dir?: string, region?: string, title?: string, other?: string, axis?: string, delta?: number,
}): string {
  const who = `「${input.module}」`
  switch (input.kind) {
    case 'move': return `把${who}往${{ up: '上', down: '下', left: '左', right: '右' }[input.dir ?? ''] ?? '?'}挪一格,对吗?`
    case 'region': return input.region === 'side' ? `把${who}挪到右侧栏、项目区下面,对吗?` : `把${who}挪回底部那一排,对吗?`
    case 'hide': return `把${who}藏起来,对吗?`
    case 'show': return `把${who}放出来,对吗?`
    case 'rename': return `把${who}改叫「${input.title ?? ''}」,对吗?`
    case 'swap': return `把${who}和「${input.other ?? ''}」换个位置,对吗?`
    case 'resize': {
      const bigger = (input.delta ?? 0) > 0
      const word = input.axis === 'width' ? (bigger ? '宽' : '窄') : (bigger ? '高' : '矮')
      return `把${who}调${word}一点,对吗?`
    }
    default: return `对${who}做「${input.kind}」,对吗?`
  }
}

/** 回给模型的那一句:先复述,再等他点头。形状与 files/deviceTools.ts 的 confirmPrompt 一致。 */
export function layoutConfirmPrompt(say: string): string {
  return `还没改。先照着这句问他一遍:「${say}」`
    + '他明确说对/是/就这样之后,再调用一次这件工具并把 confirmed 填 true;他说不对就别改,问清楚是哪一格。'
}

/**
 * 电话里换「今天的待办」那一格的显示(2026-10-12,周三演示;决策记录同日「演示:切换待办版本」)。
 * 两版:`by_date` 卡片(每条一张小卡,今天 / 明天 / 更晚分三组)、`flat` 列表(平铺清单)。走 `POST /today/view`。
 * 同 {@link TOOL_LAYOUT} 那道门:第一次只回一句复述,她说对了带 `confirmed: true` 再调才切。
 */
export const TOOL_TODO_VIEW = 'wb_todo_view'
export { TODO_VIEWS, TODO_VIEW_TITLES, todoViewConfirmText, todoViewDoneText, todoViewSameText, type TodoView } from './todoView.ts'

/**
 * 房间那一头(agent.ts 接线)。这个文件自己不认识 LiveKit,所以两件工具能在单测里走完。
 */
export interface DeviceFilesPort {
  /** 此刻在线的设备(含自己)。 */
  devices: () => readonly DeviceInfo[]
  /** 这台机器自己。 */
  self: () => DeviceInfo
  /**
   * **他正拿着打电话的那台**(2026-09-25,卡 J)。他说「发到我手机上」时 `to` 就是它 ——
   * 模型不认得他的手机在房里叫什么(「Pixel 10 Pro XL」),以前填一个「我」就被回「没有哪台叫『我』」。
   * 缺席 = 不知道(退回「房里只有一台手机就是它」)。
   */
  caller?: () => DeviceInfo | undefined
  /** 在指定的几台(不指定 = 全部)上找。每台一段结果,**那台没回话也要有一段**并写清 note。 */
  search: (input: { query: string, devices?: readonly DeviceInfo[] }) => Promise<readonly DeviceSearchSlice[]>
  /** 把 `from` 上的 `path` 发到 `to`。 */
  send: (input: { from: DeviceInfo, path: string, to: DeviceInfo }) => Promise<
    { ok: true, name: string, bytes?: number } | { ok: false, error: string }
  >
}

export interface ChannelToolsDeps {
  workbench: WorkbenchClient
  /**
   * 8792 那头的音色(2026-09-23)。**不传就没有换音色这件工具** ——
   * 有一件调不通的工具比没有更糟(同 deviceFiles 那条)。
   */
  voice?: VoiceClient
  /**
   * 这会儿电话里说的是哪一条事项(主动来电那一通有,平时没有)。
   * {@link TOOL_ASK_BUTLER} 拿它当缺省的收件人;没有就让模型先去查一条。
   */
  currentItemId?: () => string | undefined
  /** 设备间找文件 / 传文件。不传就没有这两件工具(房间还没接上时就是这样)。 */
  deviceFiles?: DeviceFilesPort
  /**
   * **他刚才亲口说的那一句**(2026-09-27,卡 LK)。捎话那道门要它 ——
   * 「没让发就不许发」这件事只能按**他的原话**判,不能按模型往工具里填的参数判
   * (模型填的 `text` 在真捎话与只看一眼这两种情形里长得一模一样:「现在进行到什么情况」)。
   * 缺席 = 拿不到他的原话 → 那道门不拦(宁可少一道门,不可拦掉真该捎的那一次)。
   */
  lastSaid?: () => string | undefined
  /**
   * 这一通电话里「机器真的看见过」的路径。调用方传一张进来,通话结束时丢掉。
   * 不传就每次 createChannelTools 自己新开一张(单测里就是这样)。
   */
  foundPaths?: FoundPaths
  /** 搜索结果的编号表(2026-09-25,卡 J)。与 foundPaths 同一个寿命。 */
  foundHandles?: FoundHandles
  /**
   * 传文件等多久就先回话(毫秒,2026-09-25)。小文件在这之内传完,她说「发过去了」;
   * 大文件先回「开始传了」,**电话不陪着等**,传完再由 {@link onLateSend} 说一声。缺省 4000。
   */
  sendQuickMs?: number
  /**
   * 先回了「开始传了」的那一件**后来**有结果了(2026-09-25)。`text` 是一句可以直接念的话;
   * 工人拿它在电话还开着时说一声(成了一句、没成一句带原因)。不传就只记日志。
   */
  onLateSend?: (text: string, ok: boolean) => void
  /**
   * 一件工具**开跑了**(2026-09-20 第二版)。工人据此往房间广播一条缓冲语信号,
   * 由手机拿包里预先合成好的那句垫上。
   *
   * 值不值得垫是**工人那边一张白名单**说了算(filler.ts 的 `SLOW_TOOLS`),这里一律报。
   * 这三件都是一次回环 HTTP、通常几十毫秒,今天一件都不在白名单上。
   */
  onStart?: (name: string) => void
  /** 每次工具执行完调一次:通话结束后写纪要要用(谁在什么时候办了什么)。 */
  onUsed?: (name: string, ok: boolean, text: string) => void
  /**
   * **8792 那边的当前音色刚刚真的被换掉了**(2026-09-23 下午)。
   *
   * 为什么非有这一声不可:工人手里那张预合成的缓存(开场白 + 按意图先应的那几句)
   * 装的是**声音**。他在电话里换完音色,缓存里还是上一个人的嗓子 ——
   * 维护者 2026-09-23 14:20 真机原话「音色和最开始听到的『吩咐』二字不一致」正是这一类。
   *
   * 工人那边另有一根盯着 8792 的节拍(filler.ts 的 `VoiceWatcher`,管的是
   * 「他在 Mac 的配置后台里换」那条路),但它隔几秒才问一次 —— 而电话里换完音色
   * **下一句话就是新嗓子**,等不了那几秒。所以两条路各有一声,谁先到都算。
   *
   * `preview` = 逐个播样音那种试听(音色确实换了,但他还没挑定):
   * 调用方**只作废缓存、不重合成**,免得他试听三个音色就在通话中间排三十次合成。
   */
  onVoicePicked?: (voiceId: string, options?: { preview?: boolean }) => void
  /**
   * **她要挂电话了**(2026-09-23 晚,维护者真机 0.2.73「说了拜拜之后没有真的拜拜」)。
   *
   * 不传就没有 {@link TOOL_END_CALL} 这件工具(同 voice / deviceFiles 那条:调不通的工具比没有更糟)。
   * 回 `ok:true` = 记下了、等她那句道别播完由工人挂;`ok:false` = 被否决了(转述、「别挂」、
   * 道别后又说了新的事),`text` 是给模型看的那句理由。规则与状态机在 farewell.ts。
   */
  endCall?: () => { ok: boolean, text: string }
}

export function createChannelTools(deps: ChannelToolsDeps) {
  let lastRelayForWatch: { who: string, text: string, at: number } | undefined
  let humanDestinationBlocked = false
  let pendingNewChat: { id: string, who: string, at: number } | undefined
  let pendingRelay: { who: string, text: string, at: number, draftBlocked: boolean } | undefined
  const record = (name: string) => (result: { ok: boolean, text: string }): string => {
    deps.onUsed?.(name, result.ok, result.text)
    return result.text
  }
  /** 开跑了说一声。**这一声炸了不许把工具带走** —— 垫一句是好意,不是主线。 */
  const started = (name: string): void => {
    try { deps.onStart?.(name) }
    catch { /* 见上 */ }
  }
  /** 音色真换过去了,说一声。**这一声炸了不许把工具带走**(同 `started` 那一条)。 */
  const picked = (voiceId: string, options?: { preview?: boolean }): void => {
    try { deps.onVoicePicked?.(voiceId, options) }
    catch { /* 见上 */ }
  }

  /** 她刚亲口说的那一句(拿不到就缺席)。 */
  const heardNow = (): string | undefined => {
    try { return deps.lastSaid?.() }
    catch { return undefined }
  }

  /**
   * **这一次要不要先问她**(2026-10-12,维护者拍板「电话里只在拿不准时先确认」)。
   *
   * 问 8791 一句(`/confirm/points`,带上哪件工具、她的原话、点了哪一家):判据只在那一头(`callAsk.ts`),
   * 这里一条规则都不写。回 `call.ask === false` 才算「说清了、直接办」;**别的一律按问** ——
   * 老工作台不给这一格、表没拿到、这台客户端压根没有这条路(老用例里的假客户端),都是判不准。
   */
  type Asked = Awaited<ReturnType<WorkbenchClient['confirmPoints']>>
  const askFirst = async (input: { said: string, who?: string, for: string }): Promise<{ clear: boolean, got?: Asked }> => {
    if (typeof deps.workbench.confirmPoints !== 'function') return { clear: false }
    const heard = heardNow()
    let got: Asked
    try { got = await deps.workbench.confirmPoints(input.said, input.who, { for: input.for, ...(heard === undefined ? {} : { said: heard }) }) }
    catch { return { clear: false } }
    return { clear: got.call?.ask === false, got }
  }

  /**
   * 挂断那一件(2026-09-23 晚)。**没有参数**:他这一回合说了什么由工人自己拿(识别结果),
   * 不让模型转述一遍再拿来判 —— 否决要看的是他的原话,不是模型的复述。
   */
  const endCall = deps.endCall
  const endTools = endCall === undefined ? {} : {
    [TOOL_END_CALL]: llm.tool({
      description: END_CALL_DESCRIPTION,
      execute: async () => {
        started(TOOL_END_CALL)
        return record(TOOL_END_CALL)(endCall())
      },
    }),
  }

  const found: FoundPaths = deps.foundPaths ?? new Map()
  const handles: FoundHandles = deps.foundHandles ?? new Map()
  const port = deps.deviceFiles
  const sendQuickMs = deps.sendQuickMs ?? 4000

  /**
   * 「发到我手机上」→ 哪一台(2026-09-25,卡 J)。他说「我」「我手机」「手机」、或者干脆没说,
   * 都是他正拿着打电话的那一台;不知道是哪一台时,房里恰好只有一台手机就是它。
   * 别的说法按设备名认(宽的那一档撞了两台就当没认出 —— 传错机器比传不过去糟)。
   */
  function resolveTarget(raw: unknown): { device: DeviceInfo, toCaller: boolean } | undefined {
    if (port === undefined) return undefined
    const said = typeof raw === 'string' ? raw.trim() : ''
    const caller = port.caller?.()
    const phones = port.devices().filter(device => device.kind === 'phone')
    const fallback = caller ?? (phones.length === 1 ? phones[0] : undefined)
    const mine = (device: DeviceInfo | undefined) => device === undefined
      ? undefined
      : { device, toCaller: caller !== undefined && device.identity === caller.identity }
    // 「给我的手机上」→「手机」;「我」→ 空。
    const bare = said.replace(/^(?:给|发给|发到|到)?(?:我自己的|我的|我|他的|他)?/, '').replace(/(?:上|里|这边|这里|这儿)$/, '').trim()
    if (bare === '' || /^(?:这台|这个|本机)?(?:手机|电话)$/.test(bare)) return mine(fallback)
    const picked = pickDevice(port.devices(), bare) ?? pickDevice(port.devices(), said)
    if (picked !== undefined) return mine(picked)
    // 「我的平板」而房里没有哪台名字里带平板:多半他就是拿着平板在打这通电话。
    if (/^(?:平板|pad)$/i.test(bare)) return mine(caller)
    return undefined
  }

  /** 「书房 Mac」「电脑」「这台电脑」→ 哪一台。没说就是这台工人自己。 */
  function resolveSource(raw: unknown): DeviceInfo | undefined {
    if (port === undefined) return undefined
    const said = typeof raw === 'string' ? raw.trim() : ''
    if (said === '' || /^(?:电脑|这台电脑|我电脑|我的电脑|mac|这台mac)$/i.test(said)) return port.self()
    return pickDevice(port.devices(), said)
  }
  const voice = deps.voice

  /**
   * 换音色(2026-09-23 第二版:**按描述挑 + 逐个播样音**)。
   *
   * 没接上 8792(voice 缺席)时**一件都不给** —— 「她答应换了但其实换不了」正是这张卡在修的毛病。
   *
   * ## 为什么不是「念三个名字给他挑」(第一版)
   *
   * 真机第二通:她念了知性灿灿 / 可爱女生 / 调皮公主,他说「怎么都是女的」。
   * 名字念得再清楚,他也**听不见那是什么嗓子**。Ben 13:00 的原话:
   * 「要么就是你先播给他听,要么就是他模糊的描述,然后你去音色库里挑。」
   *
   * ## 这一版的形状
   *
   * 一件工具、三种用法,状态在这个闭包里(= **这一通电话**,挂了就忘):
   *   · 什么都不填 / 只填 `like` → 按描述打分挑三个,**真换成第一个**,回一段让她念样音的话;
   *     再调一次(仍然什么都不填)→ 换成第二个、念样音;以此类推;
   *   · `which`(他的原话:「第二个」「那个男的」「知性灿灿」)→ **定了**,并把没要的那几个记一笔;
   *   · `action=again` → 换一批(这一通念过的都不再出现);`action=cancel` → 换回他原来那个。
   *
   * ## 试听也是真换
   *
   * 播样音 = **先把音色真换过去,再让她念那一句**。所以他听见的就是那个嗓子(TTS 每句现解析一次绑定)。
   * 代价:他中途挂了电话,嗓子停在最后试听的那一个上 —— `cancel` 就是给这件事准备的,
   * 而 8792 那边这几下带 `preview`,**不会被记成「他挑过这个」**。
   */
  const pick = {
    /** 进这一轮之前是哪个音色(`cancel` 要换回去)。 */
    original: undefined as string | undefined,
    /** 这一批三个。 */
    shortlist: [] as VoiceOption[],
    /** 这一通电话里念过的所有 id(「换一批」要避开)。 */
    offered: [] as string[],
    /** 这一批播到第几个了(-1 = 还没开始)。 */
    playing: -1,
    /** 这一批是按他哪句话挑的(他换了说法就重挑)。 */
    because: '' as string,
    /**
     * **他听过「这个只会念英文」还是要的那几个**(2026-09-28,卡 VC)。
     *
     * 念不了中文的音色第一次点到时只说那一句实话、一个字不换;他再说一次才真换过去。
     * 为什么要这一格:换过去他一个字都听不见,连「这个行吗」都没有声音 ——
     * 真机那一晚他就是这么以为「TTS 坏了」的。
     */
    insisted: [] as string[],
  }

  /** 重挑一批。回 false 表示**库翻完了**,由调用方如实说。 */
  function reshuffle(list: Parameters<typeof pickByDescription>[0], want: VoiceWant, because: string): boolean {
    const picked = pickByDescription(list, { want, offered: pick.offered })
    pick.shortlist = [...picked]
    pick.playing = -1
    pick.because = because
    for (const one of picked) if (!pick.offered.includes(one.id)) pick.offered.push(one.id)
    return picked.length > 0
  }

  const voiceTools = voice === undefined ? {} : {
    [TOOL_VOICE]: llm.tool({
      description:
        '换她自己说话的嗓子,**一个一个播给他听**。他说「换个音色」「你的声音太像豆包了」'
        + '「换个沉稳点的男声」这类话时调用。'
        + '**第一次把他的原话填进 like**(「沉稳一点的男声」「年轻活泼的」;他没给方向就别填),'
        + '它会挑几个、**当场换成第一个**,并回一段话告诉你怎么念样音 —— 照着念,他听见的就是那个嗓子。'
        + '他说「听下一个」→ 再调用一次,**什么都不填**。'
        + '他说「就这个 / 第二个 / 那个男的 / 知性灿灿」→ 再调用一次,把他的**原话**填进 which。'
        + '他说「都不要 / 换一批」→ action 填 again;他说「算了 / 还是原来那个」→ action 填 cancel。'
        + '**任何时候都只念名字,不要念 id**。',
      parameters: {
        type: 'object',
        properties: {
          like: { type: 'string', description: '他给的方向,填他的原话,比如「沉稳一点的男声」;他没说就不填' },
          which: { type: 'string', description: '他挑定时的原话,比如「第二个」「那个男的」「知性灿灿」;还没挑就不填' },
          action: { type: 'string', enum: ['again', 'cancel'], description: 'again=都不要再挑一批;cancel=算了,换回原来那个' },
        },
        additionalProperties: false,
      },
      execute: async ({ like, which, action }) => {
        started(TOOL_VOICE)
        const listed = await voice.list()
        if (!listed.ok) return record(TOOL_VOICE)({ ok: false, text: listed.text })
        const list = listed.list
        // 第一次进来记下他原来那个 —— `cancel` 要换回去。
        if (pick.original === undefined && list.current !== undefined) pick.original = list.current.id

        const act = typeof action === 'string' ? action.trim() : ''
        const said = typeof which === 'string' ? which.trim() : ''
        const wantText = typeof like === 'string' ? like.trim() : ''

        // ① 算了 —— 换回他原来那个。换不回去要如实说,他这会儿听见的是试听那个嗓子。
        if (act === 'cancel') {
          const back = pick.original
          pick.shortlist = []
          pick.playing = -1
          if (back === undefined) {
            return record(TOOL_VOICE)({ ok: false, text: '不知道他原来用的是哪个音色,换不回去。如实告诉他,让他自己挑一个。' })
          }
          const done = await voice.set(back)
          if (!done.ok) return record(TOOL_VOICE)({ ok: false, text: done.text })
          // 换回去也是换:那张预合成的缓存里还是刚才试听那个嗓子。
          picked(back)
          return record(TOOL_VOICE)({ ok: true, text: `换回原来那个「${voiceLabel(done.voice)}」了。说一句「那还是原来这个」。` })
        }

        // ② 他挑定了。**对不上就问**,撞了两个也问 —— 绝不挑一个顶上。
        if (said !== '') {
          const matched = matchSpoken(pick.shortlist, said, list.voices)
          if (matched.kind === 'many') return record(TOOL_VOICE)({ ok: false, text: askWhichLine(matched.voices) })
          if (matched.kind === 'none') {
            return record(TOOL_VOICE)({
              ok: false,
              text: `他说的「${said}」对不上刚才那几个。把刚才念过的再说一遍让他挑,或者问他想要什么样的(沉稳的?年轻的?男声还是女声?)。`,
            })
          }
          // 念不了中文的那一个:**先把实话说给他**,他坚持第二次才换(见 pick.insisted)。
          if (speaksChinese(matched.voice) === false && !pick.insisted.includes(matched.voice.id)) {
            pick.insisted.push(matched.voice.id)
            return record(TOOL_VOICE)({ ok: false, text: cannotSpeakChineseLine(matched.voice) })
          }
          const done = await voice.set(matched.voice.id)
          if (!done.ok) return record(TOOL_VOICE)({ ok: false, text: done.text })
          // **他挑定了** —— 开场白与先应那几句现在就按新嗓子重合成(不是只作废)。
          picked(matched.voice.id)
          // 这一批里没被选中的那几个 = 「他不要的」,记一笔,下次别再推同一批。
          await voice.passed(pick.shortlist.filter(one => one.id !== matched.voice.id).map(one => one.id))
          pick.shortlist = []
          pick.playing = -1
          return record(TOOL_VOICE)({
            ok: true,
            text: `定了,现在就是「${voiceLabel(done.voice)}」。下一句话起就一直是这个嗓子 —— 说一句「行,那以后就这个」。`,
          })
        }

        // ③ 换一批 / 第一次 / 他换了说法 → 重挑。
        const changedMind = wantText !== '' && wantText !== pick.because
        if (act === 'again' || pick.shortlist.length === 0 || changedMind) {
          if (act === 'again' && pick.shortlist.length > 0) {
            // 这一批他一个都不要:三个全记进「不要的」。
            await voice.passed(pick.shortlist.map(one => one.id))
          }
          // 他一个字都没说方向时:按「和现在不一样」挑(Ben:别再给三个同性别的)。
          const want = wantText === '' ? wantOtherThan(list.current) : parseWant(wantText)
          if (!reshuffle(list, want, wantText)) {
            return record(TOOL_VOICE)({
              ok: false,
              text: '这台机器上能换的音色都念过一遍了,没有新的了。如实告诉他,问他要不要回头挑刚才那几个里的一个。',
            })
          }
        }

        // ④ 播下一个。播完这一批就问他,**不自己接着往下翻**。
        pick.playing += 1
        const target = pick.shortlist[pick.playing]
        if (target === undefined) {
          const names = pick.shortlist.map(one => `「${voiceLabel(one)}」`).join('、')
          return record(TOOL_VOICE)({
            ok: false,
            text: `这一批${names}都播过了,音色一个字没动。问他挑哪一个,或者要不要换一批(换一批就再调用一次,action 填 again)。`,
          })
        }
        // **先真换过去再念** —— 他听见的那一句就是这个嗓子。preview:8792 不把试听记成「他挑过」。
        const done = await voice.set(target.id, { preview: true })
        if (!done.ok) return record(TOOL_VOICE)({ ok: false, text: done.text })
        // 试听也真换了当前音色 —— 但他还在挑,**只作废、先不重合成**(见 onVoicePicked)。
        picked(target.id, { preview: true })
        // 下一个先在 8792 那边合好落盘,他还在听这一个的时候就备好了(样音缓存)。**不等它**。
        const next = pick.shortlist[pick.playing + 1]
        if (next !== undefined) void voice.warm(next.id)
        return record(TOOL_VOICE)({
          ok: true,
          text: sampleLine({
            voice: { ...target, ...done.voice },
            index: pick.playing,
            total: pick.shortlist.length,
            ...(list.sample_text === undefined ? {} : { sampleText: list.sample_text }),
            ...(pick.because === '' ? {} : { because: pick.because }),
          }),
        })
      },
    }),
  }

  /** 两件设备工具。没接上房间(port 缺席)时一件都不给模型 —— 有一件调不通的工具比没有更糟。 */
  const deviceTools = port === undefined ? {} : {
    [TOOL_SEARCH_FILES]: llm.tool({
      description:
        '在他授权过的几台设备上**按文件名和路径**找文件。他说「我那份 XX 在哪」「把工作台仓库里的 README 找出来」'
        + '这类话时调用。**只看名字,不读内容**;只在授权过的目录里找(找不到可能只是没授权,回来的话里会写清楚)。'
        + 'devices 不填就是所有在线设备;填的话写设备名(比如「书房 Mac」)。'
        + 'query 用他说的那几个字,**项目名也带上**(「工作台 README」),工作台会先认出是哪个仓库再在里面找。'
        + '回来的每一条带一个**编号**,传文件时填编号;编号不要念给他听。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '文件名里的词,尽量用他说的那几个字' },
          devices: { type: 'array', items: { type: 'string' }, description: '只在这几台上找(设备名);不填就是全部' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query, devices }) => {
        started(TOOL_SEARCH_FILES)
        const wanted = Array.isArray(devices)
          ? devices.map(name => String(name)).map(name => port.devices().find(device => device.name === name)
            ?? port.devices().find(device => device.identity === name))
          : undefined
        const picked = wanted?.filter((device): device is DeviceInfo => device !== undefined)
        if (wanted !== undefined && picked !== undefined && picked.length === 0) {
          return record(TOOL_SEARCH_FILES)({ ok: false, text: unknownDeviceText(String(devices), port.devices()) })
        }
        const slices = await port.search({
          query: String(query ?? ''),
          ...(picked === undefined || picked.length === 0 ? {} : { devices: picked }),
        })
        const ids = rememberFound(found, slices, handles)
        return record(TOOL_SEARCH_FILES)({ ok: true, text: spokenSearchResults(slices, ids) })
      },
    }),

    [TOOL_SEND_FILE]: llm.tool({
      description:
        `把${TOOL_SEARCH_FILES}找到的某个文件传到他手机上(或者另一台设备)。`
        + '**file 填搜索结果里那一条的编号**,不许凭记忆写、不许自己编 —— 没搜到过的一律传不出去。'
        + 'to 不填就是他**正拿着打电话的这台手机**(他说「发我」「发到我手机上」都是它);要发到别的设备才填设备名。'
        // 2026-10-12:传到她自己的设备上是一份拷贝、不对外 —— 说清了直接传,只在她说「先跟我确认」时先复述。
        + '**她说清了就直接传**;它回一句复述让你问的时候(她说过「先跟我确认」),照着问,她说对了'
        + '再调用一次(file 不变)并把 confirmed 填 true。大文件会先回「开始传了」,不用在电话里等它传完。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '搜索结果里那一条的编号(比如 1)' },
          to: { type: 'string', description: '发到哪台设备(设备名);不填就是他正拿着打电话的这台手机' },
          confirmed: { type: 'boolean', description: '它让你先问、他口头确认过了才填 true;第一次调用不要填' },
          device: { type: 'string', description: '(老用法)文件在哪台设备上;填了 file 就不用填' },
          path: { type: 'string', description: '(老用法)照抄搜索结果里的路径;填了 file 就不用填' },
        },
        additionalProperties: false,
      },
      execute: async ({ file, device, path, to, confirmed }) => {
        started(TOOL_SEND_FILE)
        const all = port.devices()
        // ① 哪个文件:编号优先(新);路径那条留给老的说法,照旧过白名单。
        let from: DeviceInfo | undefined
        let filePath: string
        let fileName: string
        let where: string | undefined
        const byHandle = file === undefined || file === null || String(file).trim() === '' ? undefined : handleOf(handles, file)
        if (file !== undefined && file !== null && String(file).trim() !== '' && byHandle === undefined) {
          return record(TOOL_SEND_FILE)({ ok: false, text: `没有编号是「${String(file)}」的搜索结果。先用查找文件那件工具搜一次,再从结果里挑一个编号。` })
        }
        if (byHandle !== undefined) {
          from = all.find(d => d.identity === byHandle.identity)
          if (from === undefined) {
            return record(TOOL_SEND_FILE)({ ok: false, text: '搜到这个文件的那台设备这会儿不在线了,传不了。跟他如实说一声。' })
          }
          filePath = byHandle.path
          fileName = byHandle.name
          where = byHandle.where
        }
        else {
          const fromName = String(device ?? '')
          from = resolveSource(fromName)
          if (from === undefined) return record(TOOL_SEND_FILE)({ ok: false, text: unknownDeviceText(fromName, all) })
          filePath = String(path ?? '')
          if (filePath === '') {
            return record(TOOL_SEND_FILE)({ ok: false, text: '没说传哪一个。先用查找文件那件工具搜一次,再把结果里的编号填进 file。' })
          }
          fileName = filePath.split('/').filter(Boolean).at(-1) ?? filePath
        }
        // ② 白名单:没搜到过的路径一律不传(模型会编路径,这一道就是拦它的)。
        if (!pathAllowed(found, from.identity, filePath)) {
          return record(TOOL_SEND_FILE)({ ok: false, text: pathDeniedText(byHandle === undefined ? filePath : fileName) })
        }
        // ③ 发到哪:没说 / 说「我」就是他正拿着的这台手机。
        const target = resolveTarget(to)
        if (target === undefined) {
          return record(TOOL_SEND_FILE)({ ok: false, text: unknownDeviceText(String(to ?? '他的手机'), all) })
        }
        if (target.device.identity === from.identity) {
          return record(TOOL_SEND_FILE)({ ok: false, text: `「${fileName}」本来就在${from.name}上,不用传。问他是不是要发到手机上。` })
        }
        const who = { from, to: target.device, toCaller: target.toCaller }
        // ④ 要不要先复述(2026-10-12):她自己的设备之间传一份拷贝,说清了直接传;判不准 / 她说先确认才问。
        if (confirmed !== true && !(await askFirst({ said: `把「${fileName}」从${from.name}传到${target.device.name}`, for: 'file' })).clear) {
          return record(TOOL_SEND_FILE)({
            ok: false,
            text: confirmPrompt({ ...who, fileName, ...(where === undefined ? {} : { where }) }),
          })
        }
        // ⑤ 真传。等 sendQuickMs:小文件传完了就说「发过去了」;大文件先回「开始传了」,**电话不陪着等**。
        const sending = port.send({ from, path: filePath, to: target.device })
        let timer: ReturnType<typeof setTimeout> | undefined
        const quick = await Promise.race([
          sending,
          new Promise<'slow'>((resolve) => { timer = setTimeout(() => resolve('slow'), sendQuickMs) }),
        ])
        if (timer !== undefined) clearTimeout(timer)
        if (quick === 'slow') {
          const size = byHandle?.size
          void sending.then((result) => {
            const text = result.ok
              ? `那个「${fileName}」传完了,已经在手机上。`
              : `那个「${fileName}」没传过去:${result.error}。`
            try { deps.onLateSend?.(text, result.ok) }
            catch { /* 说一声是好意,不是主线 */ }
          }).catch(() => { /* send 自己不抛;万一抛了也别变成未处理的拒绝 */ })
          return record(TOOL_SEND_FILE)({ ok: true, text: sendingText({ ...who, name: fileName, ...(size === undefined ? {} : { bytes: size }) }) })
        }
        if (!quick.ok) {
          return record(TOOL_SEND_FILE)({ ok: false, text: notSentText({ from, to: target.device, name: fileName, error: quick.error }) })
        }
        return record(TOOL_SEND_FILE)({
          ok: true,
          text: sentText({ ...who, name: quick.name, ...(quick.bytes === undefined ? {} : { bytes: quick.bytes }) }),
        })
      },
    }),
  }

  return {
    ...deviceTools,
    ...voiceTools,
    ...endTools,
    /*
     * 写板子的那几件 = 理解中枢的命令表(A2,2026-10-28;hubTools.ts):每件只把一条命令交 8791 执行口,
     * 派给谁、能不能办、要不要先问都在那头判。旧的记 / 办 / 补一句 / 需求卡 / 规矩 / 目标 / 便签那几件并进来了。
     */
    ...createHubTools({ workbench: deps.workbench, lastSaid: heardNow, onStart: started, onUsed: (name, ok, text) => { deps.onUsed?.(name, ok, text) } }),

    [TOOL_ASK_BUTLER]: llm.tool({
      description:
        // 2026-10-02:这是**你自己**在电脑上那只手去翻,不是转给另一个人(卡「电话里像个活人」)。
        '用你在电脑上那只手去翻一遍,再把翻到的说出来。'
        + '他问的是**事项**(在办什么、做到哪了、谁在做、要不要验收)或者**记忆**'
        + '(我以前说过什么、那个项目是什么、你记得我什么)时,一律用它 —— '
        + '**不要自己凭系统提示里那份快照答**,那份是旧的,你也看不见记忆。'
        + `不知道是哪一条事项就先调 ${TOOL_DOING} 查一条最像的,把 item_id 填上。`
        + '闲聊、寒暄、语气上的事不要用它(慢)。'
        + '它回来说没查出来,就照实说「我还在查,等会儿告诉你」,**不要自己编一个答案**,也别说「我问了事务官」。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '他那句问话,用原话' },
          item_id: { type: 'string', description: `跟哪条事项有关;不填就用这通电话正在说的那一条,没有就先调 ${TOOL_DOING} 查` },
        },
        required: ['question'],
        additionalProperties: false,
      },
      execute: async ({ question, item_id }) => {
        started(TOOL_ASK_BUTLER)
        const given = typeof item_id === 'string' ? item_id.trim() : ''
        const itemId = given !== '' ? given : (deps.currentItemId?.() ?? '')
        /**
         * **这一版只能顺着某条事项的会话问到本体**(`/butler/item/say` 就是这么一条路)。
         * 没有事项 id 时不硬造一条 —— 为了问一句话建一张卡,看板上会多出一件没头没尾的事。
         * 这是这一版写明的遗留(见 docs/交接-0923-通话交回本体.md)。
         */
        const asked = String(question ?? '')
        if (/(?:盯|定一下|回电|打电话|回复.*通知)/.test(deps.lastSaid?.() ?? asked)) return record(TOOL_ASK_BUTLER)({ ok: false, text: `跟踪别家会话回复请用 ${TOOL_WATCH_REPLY}，不需要看板事项。只有工具确认登记后才可以承诺回电。` })
        /**
         * 他要的其实是**给某条会话捎句话**(2026-09-26,卡 BR):那条路不要事项 ——
         * 别再把「先挑一条事项」推给他(维护者 09-26 16:41 电话里听到的正是「它归哪件事」,
         * 他把这算作 bug)。指到那件工具上去。
         */
        if (looksLikeRelay(asked)) {
          return record(TOOL_ASK_BUTLER)({
            ok: false,
            text: `他这句是要给某条会话捎话,不是问一件事。用 ${TOOL_RELAY_SESSION}:who 填他点名那一句、text 填他要捎的原话。`
              + '**不要**问他这归哪件事。',
          })
        }
        if (itemId === '') {
          return record(TOOL_ASK_BUTLER)({
            ok: false,
            text: `这一版只能顺着某一条事项往下查,而这会儿没有事项 id。先调 ${TOOL_DOING} 挑一条最相关的再问;`
              + '一条都对不上就**如实说这个你查不到**,别自己答。',
          })
        }
        // 不再按词表分「问事项 / 问记忆」(A2):前缀只说清这是电话里问的、答要短。
        return record(TOOL_ASK_BUTLER)(await deps.workbench.askButler({ itemId, question: `${butlerAskPrefix('ask')}${asked}` }))
      },
    }),

    [TOOL_PLAN_MEETING]: llm.tool({
      description:
        '她说**接下来要开一场会**(「下午三点跟 B 客户谈下季度合作」「明天上午组里例会」「周三给大老板汇报」)时调用:'
        + '在电脑上登记成一场待开的会,会前准备(画像、预案卡)照着它做,会后录音也接到这一场。'
        + 'text 填她的原话,别改写。它回来会说还差哪一问 —— **一次只问那一问**,她答了用 '
        + `${TOOL_ANSWER_MEETING} 交上去;认不出的别替她猜。参会人只说花名,不问真名和联系方式。`
        + `她只是要记一件事、不是开会,用 ${TOOL_REMEMBER}。`,
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '她说这场会的原话' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async ({ text }) => {
        started(TOOL_PLAN_MEETING)
        const plan = deps.workbench.planMeeting
        return record(TOOL_PLAN_MEETING)(plan === undefined
          ? { ok: false, text: '这台电脑上的工作台还不会登记会议。如实说,让她在电脑或手机上记一句。' }
          : await plan(String(text ?? '')))
      },
    }),

    [TOOL_ANSWER_MEETING]: llm.tool({
      description:
        `她在回答 ${TOOL_PLAN_MEETING} 那场会还差的那一问(内部还是外部、什么类型、谁来谁拍板、她的角色、要定下什么)时调用。`
        + 'answer 填她的原话。它回来会说下一问,或者「要定什么还没说清」并给一句拟好去问组织者的话 ——'
        + '那句话**只念给她听,发不发由她,不要替她发**。',
      parameters: {
        type: 'object',
        properties: {
          answer: { type: 'string', description: '她的回答原话' },
        },
        required: ['answer'],
        additionalProperties: false,
      },
      execute: async ({ answer }) => {
        started(TOOL_ANSWER_MEETING)
        const reply = deps.workbench.answerMeeting
        return record(TOOL_ANSWER_MEETING)(reply === undefined
          ? { ok: false, text: '这台电脑上的工作台还不会记这一问。如实说。' }
          : await reply(String(answer ?? '')))
      },
    }),

    [TOOL_PUBLISH_PLAN]: llm.tool({
      description:
        '**往她日历上记一条发布计划**:她说「几号要发一个什么」(「我 20 号计划发一个视频,是做大赛回顾」'
        + '「这条记到日历上」「排进发布计划,下周三发那条图文」)时调用。'
        + 'title 填她要发的内容(「大赛回顾」,别写成一句话);date 填她说的日子原话(「20 号」「下周三」「10 月 20 日」);'
        + 'content_type 填「视频」或「图文」;said 填她那一句原话。'
        + '它回来那一句就是她该听到的话,**照它说** —— 这一条**没有人在办、也没派给谁**,'
        + '别说「我去办」「派出去了」。'
        + `要人去办一件事才用 ${TOOL_DISPATCH};只是记一句话、跟日子无关的用 ${TOOL_REMEMBER}。`
        + '它说「这条是关于什么的?」/「打算哪天发?」就照着问她一句,她答了再调一次 —— **一个日子都不要替她猜**。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '她要发的内容,比如「大赛回顾」「秋天穿搭」' },
          date: { type: 'string', description: '她说的日子:「20 号」「下周三」「10 月 20 日」,或 YYYY-MM-DD' },
          content_type: { type: 'string', enum: ['视频', '图文'], description: '视频还是图文;她没说就填视频' },
          said: { type: 'string', description: '她那一句原话(月历上悬浮能看到它)' },
        },
        required: ['title', 'date'],
        additionalProperties: false,
      },
      execute: async (args) => {
        started(TOOL_PUBLISH_PLAN)
        const one = args as Record<string, unknown>
        const plan = deps.workbench.publishPlan
        if (plan === undefined) {
          return record(TOOL_PUBLISH_PLAN)({ ok: false, text: '这台电脑上的工作台还不会记发布计划。如实说,让她在电脑上点那一天自己填一条。' })
        }
        return record(TOOL_PUBLISH_PLAN)(await plan({
          title: String(one.title ?? ''),
          date: String(one.date ?? ''),
          ...(one.content_type === '图文' ? { contentType: '图文' as const } : { contentType: '视频' as const }),
          ...(typeof one.said === 'string' && one.said.trim() !== '' ? { said: one.said } : {}),
        }))
      },
    }),

    [TOOL_DOING]: llm.tool({
      description:
        '查此刻工作台上待办、在办、等他确认的事项,**以及 Claude / Codex 等客户端里正在跑的会话**。'
        + '他问「现在在办什么」「有什么等我确认」「有几个 agent / 任务在跑」这类问题时调用,'
        + '现查现答,别照系统提示里那份快照背。事项和客户端会话是两回事,两样都要说到。'
        + '回来的每条事项都带 id —— id 是给你调用别的工具用的,**不要念给他听**。',
      execute: async () => {
        started(TOOL_DOING)
        return record(TOOL_DOING)(await deps.workbench.listDoing())
      },
    }),

    [TOOL_PROGRESS]: llm.tool({
      description:
        '他问**某一件事**「到哪了」「进度怎么样」「做得怎么样了」时调用:工作台当场按证据'
        + '(仓库提交、交接文档、派出去的活交回来的话、各家 AI 会话的最后几轮)核一次那件事,'
        + '回一句「现在到哪 · 依据 · 几点看的」。**照它回的说**,不要凭系统提示里的快照或卡上的旧备注答;'
        + '它说还没看到进展,就如实说、请他说一句(跟他说话不用「证据」这个词,说「我看到的」)。问「现在在办什么」(不是某一件)用 '
        + `${TOOL_DOING}。`
        // 卡 LK:他问的是**某一家此刻在跑的那条对话**(「Codex 现在什么状态」)时,这件工具会去核
        // 看板上的旧事项 —— 21:2x 那一通就是这么答成「参赛网页架构收尾」的。
        + `他问的是**某一家**现在什么状态、在干什么、到哪了(「Codex 现在什么状态」「Claude 在干嘛」),`
        + `那不是一件事项,用 ${TOOL_SESSION_STATUS}。`
        // ★ 2026-10-01(Air 09-29 那通电话):她调完这件工具,嘴上说的是「我去重派一次,有结果打电话告诉你」——
        // 查了一下进度,被说成了派活 + 一通根本不会打的回电。两件事在这里就划开。
        + `**这件工具只是查一眼,它既没有派活、也不会在有结果时打电话。**`
        + `查完不许说「我去重派一次」「我这就再派」——真要再派一次得调 ${TOOL_DECIDE}(decision=redo),按它回的话说成没成;`
        + '也不许说「有结果我打电话告诉你」:派出去成了只记在看板上,不会有回电。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '他问的那句话原文(要带上是哪件事,比如「参赛网页到哪了」)' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async ({ text }) => {
        started(TOOL_PROGRESS)
        return record(TOOL_PROGRESS)(await deps.workbench.askProgress(String(text ?? '')))
      },
    }),

    [TOOL_RELAY_SESSION]: llm.tool({
      description:
        '**把他的话送进某条会话**(某个 AI 那边正开着的一段对话):他说「给那个 Claude、正在做 XX 的那个会话'
        + '发个信息问一下……」「跟 Codex 刚才那条说一句」「捎句话给统筹交接那条」时用它。'
        + '**不需要事项**,也不要问他「这归哪件事」—— 那条会话不挂在看板上也送得进去。'
        + 'who 填**他点名那一句的原话**(「正在做统筹交接的那个 Claude 会话」),'
        + 'text 填**他要捎的那句话的原话**,一个字都不要改写、不要替他补一句。'
        + '它回「有几条都对得上」时,问他是哪一条。他说「新开一条」仍用此工具，who 带上原来那一家，text 保留原来要发的话；工具会新建对话，不再选旧会话。他说「盖掉」时仍保留原话，工具会传递本次覆盖授权。'
        + '**那条会话正在跑时**:他只是要补一句(「问问它到哪了」)→ 话排进去,它跑完自己看见;'
        + '他说「打断它 / 先停下 / 别做了改成…」→ 工作台先按那家的停止键、停下了才送(这一下由代码按他的原话认,你不用填)。'
        + '它说认不出停止键 / 没打断成,就照它的原话说,别说成打断了。'
        + '捎到了才说捎到了;它说捎不到就**照它的原话说**哪一步没成,别说成送到了。'
        + '**回电不是默认的**(2026-10-04):只有他明说「回了打给我 / 回了告诉我」才会有那一通,'
        + '这一下由代码按他的原话认,你不用填。他没说过就**不许许一通电话、也不许说「我盯着」** —— '
        + '那种时候工作台压根不盯,它回的那句留在那条会话里;照工作台回的那句话说。'
        + `要给**已经在办的某件事**补一句话用 ${TOOL_HAND};要新派一件活用 ${TOOL_DISPATCH}。`,
      parameters: {
        type: 'object',
        properties: {
          who: { type: 'string', description: '他点名是哪一条会话的原话(标题 / 哪一家 / 在跑还是做完了,他怎么说就怎么填)' },
          text: { type: 'string', description: '他要捎进那条会话的话,**原话**' },
        },
        required: ['who', 'text'],
        additionalProperties: false,
      },
      execute: async ({ who, text }) => {
        started(TOOL_RELAY_SESSION)
        /**
         * ★ **他没让发就不许发,这道门在最前面**(2026-09-27,卡 LK;卡 MS 合流时保序)。
         *
         * 现场:他问「Codex 现在是什么状态」,事务官调了这件工具去捎话;他明说
         * 「不要给他发信息,就看一眼」。判据按**他的原话**(不是模型填的参数):有「看一眼 /
         * 什么状态 / 在干什么 / 到哪了」的意思、又没有一个明确的送话动词 → 这一句是只读的,
         * 当场挡下,指到 {@link TOOL_SESSION_STATUS}。认名字那一步排在它后面 ——
         * 认出是哪一家也不该让一句「别发」变成一次真发出去的话。
         */
        const lastSaid = deps.lastSaid?.() ?? ''
        // Resolve explicit target changes before applying the human-chat exclusion.
        const cancelHuman = /(?:撤掉|取消|不管|别管|不用|不要).{0,12}(?:微信|wechat)|(?:微信|wechat).{0,12}(?:撤掉|取消|不管|别管|不用|不要)/i.test(lastSaid)
        const routeWords = cancelHuman
          ? lastSaid.split(/[，,。；;]/).filter(part => !/(?:微信|wechat|weixin|wecom)/i.test(part)).join('，')
          : lastSaid
        const namedTarget = matchSpokenFamily(routeWords)
        const toolTarget = matchSpokenFamily(String(who ?? ''))
        const explicitAiSwitch = namedTarget.kind === 'one'
          && /(?:打开|切到|回到|换到|回去|给|向|往|让|发给|告诉)/.test(routeWords)
          && !/(?:不要|别|不是|没让).{0,12}(?:打开|切到|回到|给|向|往|发)/.test(routeWords)
        if (cancelHuman) {
          humanDestinationBlocked = !explicitAiSwitch
          pendingRelay = undefined
          if (!explicitAiSwitch) {
            pendingNewChat = undefined
            return record(TOOL_RELAY_SESSION)({ ok: false, text: '微信请求已撤销，没有发送任何消息。接下来请明确目标和内容。' })
          }
        }
        if (!cancelHuman && /(?:微信|wechat|weixin|企业微信|wecom)/i.test(lastSaid + ' ' + String(who ?? ''))) {
          pendingRelay = undefined
          pendingNewChat = undefined
          humanDestinationBlocked = true
          return record(TOOL_RELAY_SESSION)({ ok: false, text: '微信联系人发送未接入此工具，未向任何 AI 发送。可以直接点名另一家 AI 应用切换目标，无须先撤销。' })
        }
        if (explicitAiSwitch && namedTarget.kind === 'one') {
          if (toolTarget.kind !== 'one' || toolTarget.id !== namedTarget.id) {
            return record(TOOL_RELAY_SESSION)({ ok: false, text: '工具目标与用户刚点名的应用不一致，没有发送。who 应填写用户刚点名的应用。' })
          }
          humanDestinationBlocked = false
          const previousTarget = pendingRelay ? matchSpokenFamily(pendingRelay.who) : undefined
          if (previousTarget?.kind === 'one' && previousTarget.id !== namedTarget.id) pendingRelay = undefined
          if (pendingNewChat && pendingNewChat.id !== namedTarget.id) pendingNewChat = undefined
        }
        if (humanDestinationBlocked) return record(TOOL_RELAY_SESSION)({ ok: false, text: '上一请求是微信，不能猜成豆包；请明确新的目标应用，明确点名即可切换。' })
        if (relayIntent(lastSaid).newConversation && namedTarget.kind === 'one') {
          pendingNewChat = { id: namedTarget.id, who: namedTarget.title, at: Date.now() }
          if (!/(?:问|告诉|说[:：]|内容[是为]|消息[是为])/.test(lastSaid)) {
            return record(TOOL_RELAY_SESSION)({ ok: false, text: `已切换目标为${namedTarget.title}并记住要新开会话；尚未发送。请接着说要问什么，下一句按新会话发送，不再列旧会话。` })
          }
        }
        if (lastSaid !== '' && looksLikeLookupOnly(lastSaid)) {
          return record(TOOL_RELAY_SESSION)({
            ok: false,
            text: `没捎 —— 他刚才那句是要你**看一眼**,不是让你给它发信息。用 ${TOOL_SESSION_STATUS}:`
              + 'who 填他点名那一句的原话。他明确说「跟它说 / 发给它 / 捎句话 / 告诉它」才用这一件。',
          })
        }
        /**
         * ★ 名字解析由代码做(2026-09-27,卡 MS):**唯一高置信就直接当那一家**
         * (`minus` → Manus),把正名换进他那句话里再送给工作台 —— 8791 那头认会话靠家名,
         * 送「minus」过去它一样认不出。两家都像才问一句(下面那一支),一家都不像照原样送
         * (他说的可能是标题,不是家名)。**与看一眼那条路用同一个函数**,两条路认出来必是同一家。
         */
        const spoken = String(who ?? '')
        const match = matchSpokenFamily(spoken)
        if (match.kind === 'many') {
          return record(TOOL_RELAY_SESSION)({
            ok: false,
            text: `他点的这个名字有两家都像。问他一句「${match.line}」,他说了再调一次。别自己挑一家。`,
          })
        }
        /**
         * ★ **「打断再发」还是「补一句」由他的原话定**(2026-09-28,卡 WR)。
         *
         * 维护者点的第三个场景:「给工作中的会话发信息,并且打断发送新信息」。判据按**他的原话**
         * (不是模型填的参数,同上面那道「他没让发就不许发」):他说「打断它 / 先停下 / 别做了改成…」
         * 才带 `interrupt`。**认不准一律按补一句** —— 无端按一下停止键是把他的活废了。
         */
        const interrupt = lastSaid !== '' && looksLikeInterrupt(lastSaid)
        const intent = relayIntent(lastSaid)
        const answeringItem = deps.currentItemId?.() ?? ''
        if (answeringItem.startsWith('session:') && namedTarget.kind === 'none' && !intent.newConversation && !intent.overwrite) {
          return record(TOOL_RELAY_SESSION)(await deps.workbench.answerAsk(answeringItem, String(text ?? '')))
        }
        const pendingNew = pendingNewChat && Date.now() - pendingNewChat.at < 120000 && match.kind === 'one' && match.id === pendingNewChat.id ? pendingNewChat : undefined
        const useNewConversation = intent.newConversation || pendingNew !== undefined
        const pending = pendingRelay && Date.now() - pendingRelay.at < 600000 ? pendingRelay : undefined
        const overwrite = intent.overwrite && pending?.draftBlocked === true
        if (intent.overwrite && !overwrite) return record(TOOL_RELAY_SESSION)({ ok: false, text: '没有可以对应的草稿覆盖请求，请重新说清给哪条会话发什么。' })
        const request = {
          who: overwrite ? pending!.who : cancelHuman && namedTarget.kind === 'one' ? namedTarget.title : canonicalWho(spoken),
          text: (overwrite || (intent.newConversation && !/(?:问|告诉|发消息|发信息)/.test(lastSaid))) && pending ? pending.text : String(text ?? ''),
          ...(interrupt ? { interrupt: true } : {}),
          ...(overwrite ? { overwrite: true } : {}),
          ...(useNewConversation ? { newConversation: true } : {}),
          /*
           * ★ **「回了打电话给我」只认她明说的那一句**(2026-10-04,卡 `claude/relay-call-optin`)。
           * 维护者原话:「不是每次都要的,能不能给个勾选,勾了才需要盯和打电话」——
           * 手机上那是个勾选框,电话里没有框,所以这里按她的原话判(同 `interrupt` 那条纪律:
           * 不看模型填的参数)。**认不准一律不盯** —— 她嫌烦的正是那一通。
           */
          ...(intent.callBack ? { callOnReply: true } : {}),
        }
        if (intent.newConversation && pending && matchSpokenFamily(request.who).kind === 'none') request.who = pending.who
        lastRelayForWatch = { who: request.who, text: request.text, at: Date.now() }
        const result = await deps.workbench.relayToSession(request)
        if (result.ok) pendingNewChat = undefined
        pendingRelay = result.ok ? undefined : { who: request.who, text: request.text, at: Date.now(), draftBlocked: /草稿|输入框|overwrite/.test(result.text) }
        return record(TOOL_RELAY_SESSION)(result)
      },
    }),

    [TOOL_WATCH_REPLY]: llm.tool({
      description: '用户要求盯着刚才给 AI 发的消息、收到回复就打电话时使用。登记服务器后台跟踪，不重发消息、不需要看板事项。只有返回成功才承诺回电；查不到明确说未登记。',
      parameters: { type: 'object', properties: { who: { type: 'string', description: '用户点名的 AI 应用' }, message: { type: 'string', description: '刚才实际捎去的原消息，记不清时留空，不编造' } }, required: ['who'], additionalProperties: false },
      execute: async ({ who, message }) => {
        const target = String(who ?? '').trim()
        if (/(?:微信|wechat|weixin|wecom)/i.test(target)) return record(TOOL_WATCH_REPLY)({ ok: false, text: '微信不走 AI 回复跟踪。' })
        const current = matchSpokenFamily(target)
        const last = lastRelayForWatch && Date.now() - lastRelayForWatch.at < 1200000 ? lastRelayForWatch : undefined
        const previous = last ? matchSpokenFamily(last.who) : undefined
        const same = current.kind === 'one' && previous?.kind === 'one' && current.id === previous.id
        const text = same ? last!.text : String(message ?? '').trim()
        if (!text) return record(TOOL_WATCH_REPLY)({ ok: false, text: '没有这家刚才发送的原消息，未登记跟踪。请说清要跟踪哪句，不能承诺已在盯着。' })
        // 这一件工具本身就是「回了就打电话」那一下(2026-10-04):所以它一定带上 `callOnReply`。
        return record(TOOL_WATCH_REPLY)(await deps.workbench.relayToSession({ who: target, text, watchOnly: true, callOnReply: true }))
      },
    }),

    [TOOL_SESSION_STATUS]: llm.tool({
      description:
        '**看一眼某一家此刻正开着的那条对话是什么状态**,只看、什么都不发。'
        + '他问「Codex 现在什么状态」「Claude 在干什么」「你去看一眼那个整理材料的会话」'
        + '「那条跑完了没」「到哪了」这类话时用它。'
        + 'who 填**他点名那一句的原话**(家名、他说的那个标题、在跑还是做完了,他怎么说就怎么填)。'
        + '回来的那句里有:在跑还是停了、最后一次动静是多久前、最后一句在干什么 —— '
        + '**照那句说**,时长照它念(别把「快四个小时」换算成分钟数)。'
        + `他问的是**看板上某一件事**的进度(不是某一家的对话)才用 ${TOOL_PROGRESS};`
        + `他明确要你**给那条对话发一句话**才用 ${TOOL_RELAY_SESSION} —— 只是问状态的时候**不要**调那一件。`
        + '它说没认出是哪一条,就把它给的那几条念给他听、问他是哪一条,别自己挑一条。',
      parameters: {
        type: 'object',
        properties: {
          who: { type: 'string', description: '他点名那一句的原话(哪一家 / 他说的标题 / 在跑还是做完了)' },
        },
        required: ['who'],
        additionalProperties: false,
      },
      execute: async ({ who }) => {
        started(TOOL_SESSION_STATUS)
        /*
         * ★ 认名字与捎话那条路**同一个函数**(2026-09-27,卡 MS 合流):听错的名字在这里也认
         * (「minus」→ Manus),两家都像就问一句。两条路各认一套的话,「看一眼 minus」与
         * 「给 minus 发个信息」会指到两家去。
         */
        const spoken = String(who ?? '')
        const match = matchSpokenFamily(spoken)
        if (match.kind === 'many') {
          return record(TOOL_SESSION_STATUS)({
            ok: false,
            text: `他点的这个名字有两家都像。问他一句「${match.line}」,他说了再调一次。别自己挑一家。`,
          })
        }
        return record(TOOL_SESSION_STATUS)(await deps.workbench.lookupSession(canonicalWho(spoken)))
      },
    }),

    [TOOL_LAYOUT]: llm.tool({
      description:
        '改工作台的版面:把某一格挪一挪、藏起来、再显示、改个名、调高矮宽窄,或者撤销上一次。'
        + '他说的是**这块屏幕自己**的时候才用它(「把消耗数据挪到项目区下面」「把随手记藏起来」'
        + '「项目区改叫账号」「底部那排高一点」);他说的是屏幕上那些**事**的时候不要用。'
        // 2026-10-12:改版面撤得回(「撤销」),说清了直接改;只在他说「先跟我确认」时先复述。
        + '**他说清了就直接改**,改完一句说结果、提一句不合适说「撤销」;它回一句复述让你问的时候,'
        + '照着问,他明确说对了再调用一次并把 confirmed 填 true。'
        + 'orientation 是他此刻看的是哪一版布局 —— **拿不准就先问他一句**,'
        + '同一句话在横屏和竖屏上是两件不同的事(竖屏根本没有「右侧栏」)。'
        + 'undo 填 true 就是撤销上一次那一步(他说「撤销」「改回去」时用),**撤销不需要确认**。',
      parameters: {
        type: 'object',
        properties: {
          orientation: { type: 'string', enum: ['portrait', 'landscape'], description: '他此刻看的是横屏还是竖屏那一版布局' },
          kind: { type: 'string', enum: [...LAYOUT_KINDS], description: '要做哪一种改动' },
          module: {
            type: 'string',
            description: '哪一格。用工作台的模块 id:projects/slot/usage/quota/notes/files/todo/publish/review;'
              + '底部那一整排填 deck',
          },
          dir: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'kind=move 时:往哪个方向挪一格' },
          region: { type: 'string', enum: ['side', 'deck'], description: 'kind=region 时:side=右侧栏(项目区下面),deck=底部那一排' },
          title: { type: 'string', description: 'kind=rename 时:新名字(最多 10 个字)' },
          other: { type: 'string', description: 'kind=swap 时:跟哪一格换' },
          axis: { type: 'string', enum: ['height', 'width'], description: 'kind=resize 时:改高矮还是改宽窄' },
          delta_pct: { type: 'number', description: 'kind=resize 时:加几个百分点(变小就填负数,一般用 6 / -6)' },
          undo: { type: 'boolean', description: '撤销上一次那一步。填了它,上面那些一个都不用填' },
          confirmed: { type: 'boolean', description: '它让你先问、他口头确认过了才填 true;第一次调用不要填' },
        },
        required: ['orientation'],
        additionalProperties: false,
      },
      execute: async (args) => {
        started(TOOL_LAYOUT)
        const one = args as Record<string, unknown>
        // 撤销**不走复述那道门**:他刚被告知可以说「撤销」,再问一遍就成了绕圈。
        if (one.undo === true) return record(TOOL_LAYOUT)(await deps.workbench.layoutUndo())

        const orientation = one.orientation === 'landscape' ? 'landscape' : 'portrait'
        const kind = String(one.kind ?? '')
        const module = String(one.module ?? '')
        if (!(LAYOUT_KINDS as readonly string[]).includes(kind)) {
          return record(TOOL_LAYOUT)({ ok: false, text: `不认识这种改动:${kind}。再问他一遍想把哪一格怎么样。` })
        }
        if (module === '') {
          return record(TOOL_LAYOUT)({ ok: false, text: '没说是哪一格,布局没动。问清楚再来。' })
        }
        const act: Record<string, unknown> = { kind, module }
        for (const key of ['dir', 'region', 'title', 'other', 'axis', 'delta_pct'] as const) {
          if (one[key] !== undefined) act[key] = one[key]
        }
        const say = layoutConfirmText({
          kind,
          module,
          ...(typeof one.dir === 'string' ? { dir: one.dir } : {}),
          ...(typeof one.region === 'string' ? { region: one.region } : {}),
          ...(typeof one.title === 'string' ? { title: one.title } : {}),
          ...(typeof one.other === 'string' ? { other: one.other } : {}),
          ...(typeof one.axis === 'string' ? { axis: one.axis } : {}),
          ...(typeof one.delta_pct === 'number' ? { delta: one.delta_pct } : {}),
        })
        // 要不要先复述(2026-10-12):撤得回,说清了直接改;判不准 / 他说先确认才问。
        if (one.confirmed !== true && !(await askFirst({ said: say, for: 'layout' })).clear) {
          return record(TOOL_LAYOUT)({ ok: false, text: layoutConfirmPrompt(say) })
        }
        return record(TOOL_LAYOUT)(await deps.workbench.layoutAct({ orientation, actions: [act], reason: say }))
      },
    }),

    [TOOL_TODO_VIEW]: llm.tool({
      description:
        '换「今天的待办」那一格的显示:by_date = 卡片(每条一张小卡,今天、明天、更晚分三组,卡上带到期、负责人、状态点),'
        + 'flat = 列表(一条平铺清单)。她说「把待办改成卡片」「改成卡片式」就填 by_date;'
        + '「待办改回列表」「改成列表」「改回去」就填 flat(改回去 = 换成现在没用的那一版)。'
        + '老说法也认:「按日期汇总」= 卡片,「不汇总 / 平铺」= 列表。'
        + '**第一次调用一定不会真换**:它给你一句复述,你照着问她一遍,她说对了再调用一次并把 confirmed 填 true。'
        + '换好了照它回的那句说,一句就够,别解释怎么换的。',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: [...TODO_VIEWS], description: 'by_date=卡片,flat=列表' },
          confirmed: { type: 'boolean', description: '她已经口头确认过了就填 true;第一次调用不要填' },
        },
        required: ['view'],
        additionalProperties: false,
      },
      execute: async (args) => {
        started(TOOL_TODO_VIEW)
        const one = args as Record<string, unknown>
        const view = String(one.view ?? '')
        if (!(TODO_VIEWS as readonly string[]).includes(view)) {
          return record(TOOL_TODO_VIEW)({ ok: false, text: `不认识这一版:${view},没切。再问她一遍要卡片还是列表。` })
        }
        const say = todoViewConfirmText(view as TodoView)
        if (one.confirmed !== true) {
          return record(TOOL_TODO_VIEW)({
            ok: false,
            text: `还没换。先照着这句问她一遍:「${say}」她明确说对/是/就这样之后,再调用一次并把 confirmed 填 true。`,
          })
        }
        return record(TOOL_TODO_VIEW)(await deps.workbench.todoView(view as TodoView))
      },
    }),
  }
}

/**
 * 主动来电那一通里多的一件工具(2026-09-21)。**不进平时那套工具** ——
 * 见 {@link TOOL_DECIDE} 的注释:平时闲聊里一句「那个可以」不该把一张卡挪走。
 *
 * 三个 decision 与他嘴里那三类话一一对上(对照表写在 callOut.ts 的 ringInstructions 里)。
 * 「稍后」**不改状态**:那正是「稍后」的意思,改成什么都不对。
 */
export function createRingTools(deps: ChannelToolsDeps) {
  const record = (name: string) => (result: { ok: boolean, text: string }): string => {
    deps.onUsed?.(name, result.ok, result.text)
    return result.text
  }
  return {
    [TOOL_DECIDE]: llm.tool({
      description:
        '把他在这通电话里对某件事的答复**当场落到那条事项上**。'
        + '只有这通电话正在说的那件事才用它,item_id 用系统提示里给的那个 —— 或者上一问交完之后工具回话里给的「下一问」那个,不要猜。'
        + 'approve = 批准 / 验收通过(事项挪到「完成」);'
        + 'redo = 不行 / 打回去重做(事项回到「进行中」);**这件是派给某家 AI 却没派出去的,redo 会当场再派一次**,工具回话里说成没成,照它说 ——'
        + '**调它之前不许说「我去重派一次」**,它回话说没派成也不许说成在做;'
        + '**派出去了也不许许诺回电**(成了只记在看板上,不会有人打电话报结果);'
        + 'later = 稍后再说(**一个状态都不改**,只在那条事项底下记一句)。'
        + '他说的不是这三类,就再问一遍,别自己挑一个。',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: '事项 id,用系统提示里这通电话给的那一个' },
          decision: { type: 'string', enum: ['approve', 'redo', 'later'], description: '他的答复属于哪一类' },
        },
        required: ['item_id', 'decision'],
        additionalProperties: false,
      },
      execute: async ({ item_id, decision }) => {
        try { deps.onStart?.(TOOL_DECIDE) }
        catch { /* 垫一句是好意,不是主线 */ }
        const picked = String(decision ?? '')
        if (picked !== 'approve' && picked !== 'redo' && picked !== 'later') {
          return record(TOOL_DECIDE)({ ok: false, text: `不认识这个答复:${picked}。再问他一遍是批准、重做还是稍后。` })
        }
        return record(TOOL_DECIDE)(await deps.workbench.decideItem(String(item_id ?? ''), picked))
      },
    }),
    [TOOL_ANSWER_ASK]: llm.tool({
      description:
        '把他在这通电话里对那一问(或那一件要批的事)说的意思**原话**交给工作台。'
        + '只有这通电话正在说的那件事才用它,item_id 用系统提示里给的那个 —— 或者上一问交完之后工具回话里给的「下一问」那个,不要猜。'
        + 'said 填他的原话,不要改写、不要替他挑选项;工作台认得出是哪个选项就选它,认不准就把原话交上去。'
        + '他说「我去手机上看」「等会儿」就别调。',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: '事项 id,用系统提示里这通电话给的那一个' },
          said: { type: 'string', description: '他的原话' },
        },
        required: ['item_id', 'said'],
        additionalProperties: false,
      },
      execute: async ({ item_id, said }) => {
        try { deps.onStart?.(TOOL_ANSWER_ASK) }
        catch { /* 垫一句是好意,不是主线 */ }
        return record(TOOL_ANSWER_ASK)(await deps.workbench.answerAsk(String(item_id ?? ''), String(said ?? '')))
      },
    }),
  }
}
