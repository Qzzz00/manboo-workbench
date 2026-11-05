/**
 * **一个「听懂」入口**(2026-10-13,卡「三个入口一套管线」;交接 `docs/交接-1013-一套管线与演示固定流程.md`)。
 *
 * ## 为什么有这个文件(维护者 10-13 早原话)
 *
 * > 「手机端和电脑上的文字输入、语音输入(转文字)和通话本质上都是经过
 * >   需求理解 → 需求确认 → 调用工具处理 → 跟进处理结果 → 反馈处理结果 这些环节的;
 * >   现在不是同一套,修一个地方其他地方还有惊喜;如果是同一套,adb 往手机打字测的效果
 * >   和我通话告知事务官的效果应该是一致的。」
 *
 * 改之前确实是三套:文字交代打 `POST /butler/item`,那条路由里按规则认话、认出来**直接办、没有确认**;
 * 通话里是工人先按词表判路、再由模型自己决定调不调 `wb_dispatch_item`,工具第一次回确认点让模型复述、
 * 第二次才打 `/butler/item`;另有首句、垫场、兜底句各一套。10-13 早那一通的五处毛病
 * (决策记录同日)全都长在「通话那一列自己有一套」上。
 *
 * ## 这一层管什么
 *
 * **只管第一个环节:需求理解。** 一句话进来 → 回一份 {@link Understanding}:
 * 这是哪一类事、要不要先确认一句、要打哪条路、嘴里说哪一句。
 * 纯函数,一行 I/O 都没有 —— 要查的那几样(挂着的问、在办的那件事、此刻是哪一版待办、
 * 这句话点到了哪一家)由调用方数好塞进 {@link UnderstandContext}。
 *
 * **认话的词表一张都不在这里**:视频那一句问 `videoChain.ts`、发布计划问 `publishPlan.ts`、
 * 会议问 `meetingPrep.ts`、要文件问 `fileFetch.ts`、切待办版本问 `demoPlaybook.ts`、
 * 点名哪一家由调用方用 `agentDispatch.ts` 那一套认好。这个文件只定**顺序**与**确认策略**,
 * 而顺序与确认策略从此只有这一处 —— 三个入口照它走。
 *
 * ## 三个入口怎么用它
 *
 *   · `POST /butler/understand` —— 文字进、Understanding 出,**不办事**。电话工人每句转写先问它;
 *   · `POST /butler/item` —— 同一个函数,认出来照 `route` 办、回 `say.start` 做回执;
 *   · `POST /confirm/points` —— 认出来不是真的产品需求({@link looksLikeProductRequirement})就只念一句确认。
 *
 * ## 顺序就是判据(改顺序等于改行为)
 *
 *   ① 切待办版本 → ② 做视频 → ③ 记发布计划 → ④ 答挂着的那一问 → ⑤ 给在办的那件事补一句
 *   → ⑥ 登记一场会 → ⑦ 要一份文件 → ⑧ 记一笔 → ⑨ 点了名的派活 → ⑩ 认不出(交给模型)。
 *
 * 前三条是演示那四个场景里的三个(第四个是 ④):**不确认、不反问**,认出来就办。
 * 后面几条照旧 —— ⑧⑩ 交给模型,⑨ 留**一句**确认。
 *
 * ★ **⑤ 那一档 2026-10-13 晚收紧过**(卡 P;交接 `docs/交接-1013-补细节不吞别的话.md`):
 * 演示机 20:30 那一通里,一句切待办的话被 ASR 切成两段、都落在做视频那件事的 60 秒窗口里,
 * 两段都当成了补细节 —— 记上了卡,还并进了可灵那句提示词。现在补细节要**像一句描述**
 * (判据在 `followUp.ts`)、窗口 20 秒、**只认紧跟着那件事之后的第一句**;对不上就往下走。
 */
import type { TodayViewStyle } from '../protocol.ts'
import { spokenOptionOf } from './butlerAsks.ts'
import { callAskVerdict, type CallAskView } from './callAsk.ts'
import { DEMO_ANSWER_ASK_SAY, demoAppendSay, demoTodayViewSay, demoVideoSay, todayViewAsked } from './demoPlaybook.ts'
import { ASKING, looksLikeAck, looksLikeFollowUp, notAppendDetailWhy } from './followUp.ts'
/**
 * 应声那几张表与「能不能当补细节 / 答那一问」自 2026-10-13 晚(卡 P)搬到了 `followUp.ts`
 * (那一层还住着补细节那道新门,视频接力也要读它 —— 留在这个文件里两边就互相 import)。
 * **从这儿接着出去**:`callSummary.ts` 与用例读的仍是 `understand.ts` 这几个名字。
 */
export { FOLLOW_UP_MAX_CHARS, PLAIN_ACK, PLAIN_ANSWER, looksLikeAck, looksLikeAppendDetail, looksLikeFollowUp } from './followUp.ts'
import { parseFetchRequest } from './fileFetch.ts'
import { looksLikeMeetingPlan } from './meetingPrep.ts'
import { PUBLISH_PLAN_ASK_DAY, PUBLISH_PLAN_ASK_SUBJECT, publishPlanOf, publishPlanReply, type PublishPlanSaid } from './publishPlan.ts'
import { videoChainPlan, type VideoPlan } from './videoChain.ts'

/** 这一句是哪一类事。`none` = 认不出,交给模型(宁可漏认)。 */
export type UnderstandKind =
  | 'none'
  | 'today_view'
  | 'video'
  | 'publish_plan'
  | 'answer_ask'
  | 'append'
  | 'meeting_plan'
  | 'file'
  | 'remember'
  | 'dispatch'

/** 要打的那条路。调用方照它发,**不自己挑端口**。 */
export interface UnderstandRoute {
  /** 8791 上的路径。 */
  path: '/butler/item' | '/today/view' | '/asks/voice' | '/butler/item/say'
  /** 除 `text` / `source` 之外要带的那几格(调用方原样合进 body)。 */
  body: Record<string, unknown>
}

export interface Understanding {
  kind: UnderstandKind
  /** `demo` = 演示那四个场景的固定流程(不确认、不反问、没有先应 / 垫场 / 兜底句)。 */
  mode: 'demo' | 'normal'
  /**
   * 要打哪条路。**缺席而 {@link ask} 在** = 只回问一句、什么都不办;
   * **两样都缺** = 这一句交给模型(照老路)。
   */
  route?: UnderstandRoute
  /**
   * 先确认一句吗。**判据不在这个文件里** —— 要不要问由 `callAsk.ts` 的 `callAskVerdict` 说
   * (2026-10-12 维护者拍板「电话里只在拿不准时先确认」);`needed` 为真时 `spoken` 一定在。
   * 四个演示场景 `mode:'demo'`**整条跳过它**:那几句话我们有把握。
   */
  confirm: { needed: boolean, spoken?: string, why?: CallAskView['why'], hint?: string }
  /** 嘴里说哪一句:`start` = 办成之后那一句;`done` = 后面还有一步时收尾那一句。 */
  say: { start: string, done?: string }
  /** 她没说清,回问这一句(问完就停,一个字都不猜)。 */
  ask?: string
  /** 凭什么这么认的(日志那一行;用例也读它)。 */
  why: string
  /** ② 认出来的那份两步计划(调用方要 subject)。 */
  video?: VideoPlan
  /** ③ 认出来的那条发布计划(`day` 缺席 = 日子说不清)。 */
  publish?: PublishPlanSaid
  /** ① 要切成哪一版。 */
  today_view?: TodayViewStyle
  /** ⑦ 她要的那份文件(`parseFetchRequest` 摘出来的那一截)。 */
  file?: { query: string }
  /**
   * 认出来的这一类归哪个实验开关、而它此刻关着(2026-10-21,卡「引导三件事」;`src/mainPaths.ts`)。
   * **这个文件不填它** —— 开关在 8791 那一层(`http.ts` 的 `understandingFor`)判,填了就把 `route` 摘掉、`ask` 换成那一句。
   */
  experiment_off?: string
}

export interface UnderstandContext {
  /** 这一刻(毫秒)。 */
  nowMs: number
  /** 这句话从哪儿来。缺省按 `desk`。 */
  source?: 'call' | 'phone' | 'desk'
  /**
   * 上一句刚派出去 / 刚开始的那件事(**补细节**用)。
   * `at_ms` 是那件事开始的时刻 —— 超过 {@link APPEND_WINDOW_MS} 就不再并进去。
   *
   * ★ `first`(2026-10-13 晚,卡 P)= **这是那件事之后的第一句吗**。
   * `false` = 中间已经插过别的话了,这一句不再往那件事上并;
   * 缺席 = 调用方没数(老回包)—— 按第一句算,与这一版之前一字不差。
   * 数的那道闸在 `followUp.ts` 的 `createAppendGate`(`/butler/understand` 每一句问一次)。
   */
  open?: { item_id: string, said: string, at_ms: number, first?: boolean }
  /**
   * 此刻挂着的那一问(座机念过豆包那道题、还在等她答)。
   *
   * ★ `options`(2026-10-13 下午,卡 C)= 那一问摆出来的那几项**原话**。判「她这一句是在答那一问」
   * 要对着它比 —— 缺席(数不出来 / 那一问本来就没有选项)时退到「是一句实答就算」那一档。
   */
  openAsk?: { item_id: string, title: string, options?: readonly string[] }
  /** 「今天的待办」此刻是哪一版(她说「改回去」时要知道从哪儿改回)。 */
  todayView?: TodayViewStyle
  /**
   * 这句话里点到的那一家。**由调用方用家族目录那一套认好**(`dispatchFamilyOf` +
   * `dispatchNameTargetsNow`)—— 这个文件不抄第二份名单。
   */
  named?: { family: string, title: string }
  /** 认得「要文件」那张卡吗(同 `/butler/item` 的 `can_file_ask`)。 */
  canFileAsk?: boolean
  /** 认得「登记一场会」那条回执吗(同 `/butler/item` 的 `can_meeting_plan`)。 */
  canMeetingPlan?: boolean
}

/**
 * 刚开始的那件事,多久之内说的那一句算「补细节」(**统筹 2026-10-13 晚定:20 秒**;原先 60 秒)。
 *
 * 演示机 20:30 那一通里,一句切待办的话落在做视频那件事的 60 秒窗口里被当成了补细节。
 * 补细节是她说完那一句**紧接着**想起来的一句描述,20 秒够用;慢慢想起来的那一句
 * 照旧走后面的认法(认不出交给模型),不并进刚才那一件。
 */
export const APPEND_WINDOW_MS = 20 * 1000

/** 「记一笔」那一句。认出来只为**排在派活前面**:它交给模型用 `wb_remember_item` 记,照老路。 */
const REMEMBER_CUE = /记一下|记下来|记一笔|帮我记|先记着|记住/u
/**
 * 「记到日历 / 记进发布计划」那一句(2026-10-13 下午,见 {@link looksLikeNoteOnly})。
 * 工人那份(`channel-worker/src/remember.ts` 的 `CALENDAR_NOTE`)照抄这一张,两边逐字相同由
 * `channel-worker/tests/calendar-note-sync.test.ts` 钉着(它读这一份源码比对,漂了那条红)。
 */
const CALENDAR_NOTE_CUE = /记(?:到|进|在|上)(?:我的)?(?:日历|月历|发布计划)|(?:加|排)(?:到|进)(?:我的)?(?:日历|月历|发布计划)|发布计划里?(?:记|加|排)/u

/**
 * 她明说「记一下 / 帮我记 / 先记着」(不含「记到日历」那一种:那一种落的是发布计划,不是事项)。
 * 通话记录拿它标「可能要办」(`server/callRecords.ts` 的 `maybeTodosOf`)。
 */
export function asksToRemember(said: string): boolean {
  const text = typeof said === 'string' ? said.trim() : ''
  return text !== '' && REMEMBER_CUE.test(text) && !CALENDAR_NOTE_CUE.test(text)
}

/*
 * ★ 2026-10-29 删规矩第一批(A#23):`looksLikeNoteOnly` / `NOTE_ONLY_NOTE`(「记一下」只记不派、
 * 卡上回一句)随旧路删除 —— 所有入口进理解中枢,记还是派由模型按命令表出(note / dispatch)。
 * `asksToRemember` 保留:通话记录「可能要办」那一标还在用它。
 */

/* ──────────────────────── 她这一句是在答挂着那一问吗 ──────────────────────── */

/**
 * ★ **她这一句算不算「在答挂着那一问」**(2026-10-13 下午,卡 C;验收交接第三节第 19 条)。
 *
 * ## 为什么要收紧
 *
 * 旧判据是「挂着一问 + 这一句不是新意图」。14:3x 那一通里卡 t-86856ebb 撞上限、挂着一问
 * 「继续、停掉、还是换 Claude」,他说「看见了,嗯」→ 被当成答案 → `/asks/voice` 回 ok →
 * 她说「好了,替你选上了」,而那张卡仍然 blocked、`waiting` 里那条还在。
 * **演示风险**:场景 3 只要还有任何问挂着,她随口一句都会被「替你选上」。
 *
 * ## 收紧成两档
 *
 *   · 那一问**摆着选项**:她说的必须对得上某一项 —— 原话 / 把那一项说全了 / 说的是那一项的一截 /
 *     「第 N 个」/「最后一个」。认法是 `butlerAsks.spokenOptionOf`(**与 `/asks/voice` 真按下去那一项
 *     同一个函数**,两处判得不一样就会出现「这边说算答案、那边说认不准」);
 *   · 那一问**没有选项**(自由作答的那一种):是一句实答就算。
 *
 * 两档前面都先过 {@link looksLikeFollowUp}:短、不是应声 / 感叹 / 闲话、不是反问、不带办事的动词。
 * 对不上 → `no`,这一句**交给模型**(`kind:'none'`,照老路)。不自己回问「你选哪个」:
 * 她这一句可能压根不是在答这一问(14:19 那通的「给我看看」),回一句「你选哪个」比不作声更糟。
 */
export type AnswerAskVerdict =
  /** 对上了那一项(`option` 是那一项的原话;送去 `/asks/voice` 的仍是她的原话)。 */
  | { how: 'option', option: string }
  /** 那一问没有选项,这是一句实答。 */
  | { how: 'said' }
  /** 不算在答那一问。 */
  | { how: 'no', why: string }

export function answerAskVerdict(said: string, ask: { options?: readonly string[] }): AnswerAskVerdict {
  const text = (said ?? '').trim()
  if (text === '') return { how: 'no', why: '空的一句' }
  if (looksLikeAck(text)) return { how: 'no', why: `光一句应声(「${text}」),不当答案` }
  if (!looksLikeFollowUp(text)) return { how: 'no', why: '这一句不像在答那一问(太长 / 在反问 / 带着办事的动词)' }
  const options = (ask.options ?? []).map(one => (one ?? '').trim()).filter(one => one !== '')
  if (options.length === 0) return { how: 'said' }
  const hit = spokenOptionOf(options.map(label => ({ label })), text)
  if (hit === undefined) return { how: 'no', why: `对不上那几项(它给的是:${options.join(' / ')})` }
  return { how: 'option', option: hit.label }
}

/* ──────────────────────── 真的产品需求才念《需求确认点》 ──────────────────────── */

/** 造东西的动词(要做一个新的 / 改一处现成的)。 */
const BUILD_VERBS = /做个|做一个|开发|实现|写个|写一个|加一个|加个|新增|改成|改一下|改掉|重构|支持|接入|上线|优化|修一下|修复|设计/u
/** 产品那一头的对象。**这一格是关键**:没有它的「做一个视频」不是产品需求。 */
const PRODUCT_NOUNS = /功能|页面|界面|入口|按钮|模块|小组件|组件|接口|流程|需求|版本|设置项|选项|字段|逻辑|交互|布局|工作台|插件|服务|脚本|代码|bug|Bug|BUG|报错|崩/u
/** 真的产品需求总得说上几句 —— 太短的那一句照旧只确认一句。 */
export const PRODUCT_REQUIREMENT_MIN_CHARS = 10

/**
 * **这一句是不是真的产品需求**(2026-10-13)。只有它才念《需求确认点》那三条
 * (「从哪儿触发 / 这一版做到哪儿 / 怎么算做完」)。
 *
 * 10-13 早那一通里,「帮我生成一个小女孩在花海里面漫步的视频」被回了那三条 —— 她要的是一条视频,
 * 不是一个功能。判据三条,**全都要满足**(判据在代码里,不交给模型):
 *   ① 有一个**造东西**的动词({@link BUILD_VERBS});
 *   ② 说的是**产品那一头的对象**({@link PRODUCT_NOUNS}:功能 / 页面 / 入口 / 模块 / bug…);
 *   ③ 话不短(≥ {@link PRODUCT_REQUIREMENT_MIN_CHARS} 字)。
 *
 * 不满足 = 一句确认就够(`spokenSimpleConfirm` 那一句)。宁可少念经:念错三条的代价是
 * 10-13 早那一幕(她在电话里被问「从哪儿触发」),漏念的代价只是卡上那三条她自己看一眼。
 */
export function looksLikeProductRequirement(said: string): boolean {
  const text = typeof said === 'string' ? said.trim() : ''
  if ([...text].length < PRODUCT_REQUIREMENT_MIN_CHARS) return false
  if (!BUILD_VERBS.test(text)) return false
  return PRODUCT_NOUNS.test(text)
}

/* ──────────────────────── 听懂 ──────────────────────── */

/** 要问的时候念的那一句(形状照 `publishPlanConfirmLine`:一句话 + 「对吗?」)。 */
export function dispatchConfirmLine(said: string, who: string): string {
  const text = said.trim().replace(/[。.!!??]+$/u, '')
  return `${who === '' || text.includes(who) ? text : `让 ${who} ${text}`} —— 对吗?`
}

function nothing(why: string): Understanding {
  return { kind: 'none', mode: 'normal', confirm: { needed: false }, say: { start: '' }, why }
}

/**
 * 一句话 → 一份理解。**认不出就 `kind:'none'`**(交给模型,照老路;宁可漏认)。
 *
 * 顺序见文件头。每一档都写明「凭什么」(`why`)—— 真机日志里那一行就是它。
 */
export function understand(said: string, ctx: UnderstandContext): Understanding {
  const text = typeof said === 'string' ? said.trim() : ''
  if (text === '') return nothing('空的一句,当没说话')
  const fromCall = ctx.source === 'call'

  // ① 切待办版本(演示场景 ②)。**不确认**:她说的就是要切哪一版,复述一遍只是多一轮。
  const view = todayViewAsked(text)
  if (view !== undefined) {
    const same = ctx.todayView !== undefined && ctx.todayView === view
    return {
      kind: 'today_view',
      mode: 'demo',
      today_view: view,
      /*
       * `said` 带着她那句原话(2026-10-13,留痕):`/today/view` 这条路本来只收 `{view}`,
       * 于是电话里切完**事务官那里一行字都没有**(维护者:「场景二我也没看到事务官那里有什么记录啊」)。
       * 调用方原样把 `route.body` 合进去,所以**工人一个字都不用改**;设置里那两颗键不带它 = 不留痕
       * (她自己在页面上点的不出字,同 `actorNotes.ts` 那条纪律)。
       */
      route: { path: '/today/view', body: { view, said: text } },
      confirm: { needed: false },
      say: { start: demoTodayViewSay(view) },
      why: `切「今天的待办」那一格 → ${view}${same ? '(本来就是这一版)' : ''}`,
    }
  }

  // ② 做视频(演示场景 ①)。判据照旧是 `videoChainPlan`,这里只定「不确认、不反问」。
  const video = videoChainPlan(text)
  if (video !== undefined) {
    return {
      kind: 'video',
      mode: 'demo',
      video,
      route: { path: '/butler/item', body: {} },
      confirm: { needed: false },
      say: { start: demoVideoSay(video.subject) },
      why: `做一条「${video.subject}」的视频 → 豆包出参考图 → 可灵生成`,
    }
  }

  // ③ 记发布计划(演示场景 ④)。日子 / 主题说不清**回问一句**,一张卡都不建、一个字都不猜。
  const publish = publishPlanOf(text, ctx.nowMs)
  if (publish !== undefined) {
    /*
     * ★ 主题说不清(2026-10-13 下午):「我 20 号要发一个视频」—— 先问是关于什么的。
     * **主题比日子先问**:没有主题那张卡连标题都没有,而日子问出来也无处可记。
     */
    if (publish.subjectUnknown === true) {
      return {
        kind: 'publish_plan',
        mode: 'demo',
        publish,
        confirm: { needed: false },
        say: { start: '' },
        ask: PUBLISH_PLAN_ASK_SUBJECT,
        why: '像在排发布计划,可是没说清要发什么',
      }
    }
    if (publish.day === undefined) {
      return {
        kind: 'publish_plan',
        mode: 'demo',
        publish,
        confirm: { needed: false },
        say: { start: '' },
        ask: PUBLISH_PLAN_ASK_DAY,
        why: `像在排发布计划(${publish.title}),可是没说清哪一天`,
      }
    }
    return {
      kind: 'publish_plan',
      mode: 'demo',
      publish,
      route: { path: '/butler/item', body: {} },
      confirm: { needed: false },
      say: { start: publishPlanReply(publish, publish.day) },
      why: `发布计划:${publish.day} ${publish.title}`,
    }
  }

  /*
   * ④ 答挂着的那一问(演示场景 ③ 的后半段)。**只在电话里**:电脑与手机上她在界面里点。
   *
   * ★ 2026-10-13 下午(卡 C):判据收紧到 {@link answerAskVerdict} —— 对得上某一项(或那一问
   * 没选项时是一句实答)才算。**对不上就往下走**(最后多半是 ⑩ 交给模型):绝不让一句应声
   * 变成「替你选上了」。
   */
  if (fromCall && ctx.openAsk !== undefined) {
    const verdict = answerAskVerdict(text, ctx.openAsk)
    if (verdict.how !== 'no') {
      return {
        kind: 'answer_ask',
        mode: 'demo',
        route: { path: '/asks/voice', body: { item_id: ctx.openAsk.item_id, said: text } },
        confirm: { needed: false },
        say: { start: DEMO_ANSWER_ASK_SAY },
        why: verdict.how === 'option'
          ? `她在答挂着的那一问「${ctx.openAsk.title}」,说的是「${verdict.option}」那一项`
          : `她在答挂着的那一问「${ctx.openAsk.title}」(那一问没摆选项,这是一句实答)`,
      }
    }
  }

  /*
   * ⑤ 给在办的那件事补一句(「七八岁,穿小碎花连衣裙」)。**只在电话里**(电脑输入框另有 `carryOnTarget`)。
   *
   * ★ 2026-10-13 晚(卡 P)三道收紧 —— 演示机 20:30 那一通把一句切待办的话吞成了细节:
   *   · 判据换成 {@link looksLikeAppendDetail}(像一句描述:不短、不是半句、不是吩咐、不说别的那件事);
   *   · 窗口 60 秒 → 20 秒({@link APPEND_WINDOW_MS});
   *   · **只认紧跟着那件事之后的第一句**(`ctx.open.first`)。
   * 三道有一道不过就**往下走**,最后多半是 ⑩ 交给模型 —— 绝不把别的话并进在办的那一件。
   */
  const appendRefused = fromCall && ctx.open !== undefined ? notAppendDetailWhy(text, { nowMs: ctx.nowMs }) : undefined
  if (fromCall && ctx.open !== undefined && ctx.open.first !== false
    && ctx.nowMs - ctx.open.at_ms <= APPEND_WINDOW_MS && appendRefused === undefined) {
    return {
      kind: 'append',
      mode: 'normal',
      /*
       * `append:true` 是给留痕那一行用的(2026-10-13):`/butler/item/say` 这条路还承着界面上
       * 「推进 / 改一改」与工人的 `wb_hand_to_butler`(那两种送进去的不是她的原话),
       * 所以**只有这一格在的时候才留痕**。调用方原样合进 body,工人不用改。
       */
      route: { path: '/butler/item/say', body: { id: ctx.open.item_id, text, append: true } },
      confirm: { needed: false },
      say: { start: demoAppendSay(text) },
      why: `补进刚开始那件事「${ctx.open.said.slice(0, 20)}」`,
    }
  }

  // ⑥ 登记一场会。照旧由 `/butler/item` 那一道岔口办(这里只认出来、排好顺序)。
  if (ctx.canMeetingPlan === true && looksLikeMeetingPlan(text, ctx.nowMs)) {
    return {
      kind: 'meeting_plan',
      mode: 'normal',
      route: { path: '/butler/item', body: { can_meeting_plan: true } },
      confirm: { needed: false },
      say: { start: '' },
      why: '像在登记一场待开的会(`/butler/item` 那一道岔口回那一句)',
    }
  }

  /*
   * ⑦ 要一份文件。认出来**只为排顺序**:那张「要文件」的卡要有手机那一头的设备才摆得出来
   * (`/butler/item` 上那一档),电话里照旧由模型用 `wb_send_file` 办。
   */
  const wanted = ctx.canFileAsk === true ? parseFetchRequest(text) : undefined
  if (wanted !== undefined) {
    return {
      kind: 'file',
      mode: 'normal',
      file: wanted,
      route: { path: '/butler/item', body: { can_file_ask: true } },
      confirm: { needed: false },
      say: { start: '' },
      why: `像在要一份现成的文件(「${wanted.query}」;\`/butler/item\` 那一道岔口摆卡)`,
    }
  }

  /*
   * ⑧ 记一笔。**交给模型**(`wb_remember_item` → `/task/create`,与今天一字不差);
   * 认出来只为排在派活前面 —— 「记一下,让 Codex 看看」她要的是记,不是派。
   */
  if (REMEMBER_CUE.test(text)) return nothing(`像在记一笔(${REMEMBER_CUE.exec(text)?.[0] ?? ''}),交给模型用记一笔那件工具`)

  /*
   * ⑨ 点了名的派活。**要不要先问一句由 `callAsk.ts` 说**(2026-10-12 维护者拍板
   * 「电话里只在拿不准时先确认」)—— 这个文件不另写一套确认策略。
   * 要问的时候念的是**一句**,不再是《需求确认点》那三条
   * (判据见 {@link looksLikeProductRequirement};10-13 早那一通的第 ③ 处毛病)。
   */
  if (ctx.named !== undefined && !ASKING.test(text)) {
    /*
     * `named:true` 时 `callAskVerdict` 用不到选项表(① 那一条只管「没说派给谁」),
     * 所以这一层不用去数家数 —— 没点名的那一句这个函数压根回 `none`,照旧由模型调
     * `wb_dispatch_item` → `/confirm/points` 走它那一条完整的判断。
     */
    const verdict = callAskVerdict({ for: 'dispatch', text, named: true })
    return {
      kind: 'dispatch',
      mode: 'normal',
      route: { path: '/butler/item', body: {} },
      confirm: verdict.ask
        ? {
            needed: true,
            spoken: verdict.spoken ?? dispatchConfirmLine(text, ctx.named.title),
            why: verdict.why,
            ...(verdict.hint === undefined ? {} : { hint: verdict.hint }),
          }
        : { needed: false, why: verdict.why },
      say: { start: '' },
      why: `点名要 ${ctx.named.title} 办(要不要先问:${verdict.why})`,
    }
  }

  // ⑩ 认不出:交给模型。**为什么没当补细节也写在这一行**(真机日志里要看得见,卡 P)。
  return nothing(`认不出是哪一类,交给模型${appendRefused === undefined ? '' : `(没当补细节:${appendRefused})`}`)
}
