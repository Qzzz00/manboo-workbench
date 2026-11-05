/**
 * **先问 8791,再问模型**(2026-10-13,卡「三个入口一套管线」;交接 `docs/交接-1013-一套管线与演示固定流程.md`)。
 *
 * ## 为什么(维护者 10-13 早原话)
 *
 * > 「手机端和电脑上的文字输入、语音输入(转文字)和通话本质上都是经过
 * >   需求理解 → 需求确认 → 调用工具处理 → 跟进处理结果 → 反馈处理结果 这些环节的;
 * >   现在不是同一套,修一个地方其他地方还有惊喜。」
 *
 * 10-13 早那一通(手机 App)的五处毛病全长在「通话这一列自己有一套」上:
 * 「帮我生成一个小女孩在花海里面漫步的视频」被 `turnRoute` 判成闲聊、零工具,
 * 模型反问四个细节;补了细节又判闲聊;派活回的是产品需求那套确认点;
 * 兜底句三次把诚实回答换成「我还没记下,要我现在记吗」;首句三次许愿「我这就去…」而没动。
 *
 * ## 这个文件管什么
 *
 * 只管**形状与判字**(纯的,不认识 LiveKit、不发 HTTP):
 *   · 8791 回来的那份 {@link Understanding} 长什么样(与 `workbench-plugin/src/server/understand.ts` 同形);
 *   · 她那一句是不是「对 / 去吧」({@link approvalOf}) —— 挂着一句确认时要用;
 *   · 固定流程那一句怎么变成一条**文字流**交给框架({@link saidStream}) —— 不经模型。
 *
 * 真正打那几条路在 `workbench.ts`(`understandSaid` / `runUnderstanding`),接线在 `agent.ts`。
 *
 * ## 两条纪律
 *
 *   ① **认不出就照老路**:`kind === 'none'`、拿不到这一格(老工作台 404 / 8791 连不上)
 *      一律回去交给模型 —— 行为与这一版之前一字不差;
 *   ② **只说真发生过的事**:固定流程里说的那一句只在 8791 回 200 **而且真办了**的时候念;
 *      没成就照 8791 那句原因说(同 D13、同 `claimGuard.ts` 那条分寸)。
 */

/** 她那一句是哪一类事(与 8791 的 `UnderstandKind` 同一组字)。 */
export type UnderstandKind =
  | 'none' | 'today_view' | 'video' | 'publish_plan' | 'answer_ask' | 'append'
  | 'meeting_plan' | 'file' | 'remember' | 'dispatch'

/** 要打的那条路(8791 说了算,工人不自己挑端口)。 */
export interface UnderstandRoute {
  path: string
  body: Record<string, unknown>
}

export interface Understanding {
  kind: UnderstandKind
  mode: 'demo' | 'normal'
  route?: UnderstandRoute
  confirm: { needed: boolean, spoken?: string, why?: string, hint?: string }
  say: { start: string, done?: string }
  ask?: string
  why: string
}

/**
 * 这一问最多等多久(毫秒)。8791 在同一台机器上、这条路纯算不写盘,正常几毫秒;
 * 到点还没回来就**按「问不到」走老路**(同 `turnRoute.ts` 的 `ROUTE_BUDGET_MS` 那条纪律:
 * 不把电话晾着)。先应与垫场那两道闸也等这一下,所以它不能大 —— 400ms 是「听得出的静音」之下。
 */
export const UNDERSTAND_BUDGET_MS = 400

/** 这一句 8791 认下来了吗(有路可走,或者有一句要回问)。两样都没有 = 交给模型。 */
export function isHandled(one: Understanding | undefined): boolean {
  if (one === undefined || one.kind === 'none') return false
  return one.route !== undefined || (one.ask !== undefined && one.ask !== '')
}

/** 日志那一行。 */
export function describeUnderstanding(one: Understanding): string {
  const how = one.route === undefined ? (one.ask === undefined ? '交给模型' : '回问一句') : `打 ${one.route.path}`
  const gate = one.confirm.needed ? `,先问一句(${one.confirm.why ?? '?'})` : ''
  return `8791 听懂了:${one.kind}/${one.mode} → ${how}${gate}(${one.why})`
}

/* ──────────────────────── 挂着一句确认时,她答的是什么 ──────────────────────── */

/** 「对 / 行 / 去吧」。**整句就这几个字才算**:「对,但是换成 Codex」是改口,不是点头。 */
const YES_WORDS: readonly string[] = [
  '对', '对的', '是', '是的', '没错', '好', '好的', '好啊', '可以', '行', '就这样', '去吧', '去建吧', '好去建吧', '去办', '办吧',
  '嗯', '嗯嗯', '没问题', '批准', '同意', '开工', '那就这样', '就那样',
]
// 「对对 / 好好 / 行行」叠字收成一个字再查(应声整表只在 backchannel.ts 一处,这里不再抄一份)。
const DOUBLED_YES = /^(对|好|行|嗯)\1+$/u
/** 「不对 / 不用 / 算了」。 */
const NO_WORDS: readonly string[] = [
  '不对', '不是', '不用', '不用了', '算了', '不要', '别', '先别', '取消', '不办', '再想想', '等一下', '等等',
]
/** 点头 / 摇头那一句最长这么多字(再长就是她在改口)。 */
export const APPROVAL_MAX_CHARS = 8

/** 她在答挂着那一句确认吗:`yes` 点头、`no` 摇头、`undefined` 改口 / 说的是别的。 */
export function approvalOf(said: string): 'yes' | 'no' | undefined {
  const text = (said ?? '').trim().replace(/[。.,,!!??、\s]+$/u, '').replace(/^[嗯啊哦噢]+[,,]?/u, '')
  if (text === '' || [...text].length > APPROVAL_MAX_CHARS) return undefined
  const compact = text.replace(/[,，、\s]/gu, '')
  const word = DOUBLED_YES.test(compact) ? compact[0]! : compact
  // 摇头先看:「不用了」里也有一个「用」,而「不对」里有一个「对」。
  if (NO_WORDS.includes(word)) return 'no'
  if (YES_WORDS.includes(word)) return 'yes'
  return undefined
}

/** 她摇头之后说的那一句。 */
export const CONFIRM_DROPPED_SAY = '好,那就不办了。'

/* ──────────────────────── 答挂着那一问:没办成时说一句人话 ──────────────────────── */

/**
 * ★ **固定流程没办成时说的必须是一句人话 —— 从理由分档拼,不许念接口的字**
 * (2026-10-13,维护者 11:40 真机那一通的后半段;同 `claimGuard.ts` 的 `failedLine` 那条分寸)。
 *
 * ## 现场
 *
 * ```
 * 他说(ASR):果汁。
 * 8791 听懂了:answer_ask/demo → 打 /asks/voice
 * 固定流程 answer_ask → /asks/voice:没办成,说「已尝试发送,但回执尚未确认。请查看对话区,
 *   不要重复发送;这不代表发送失败」
 * 她说:已尝试发送,但回执尚未确认。请查看对话区,不要重复发送;这不代表发送失败
 * ```
 *
 * 那一长串是 8791 回包里的 `note` —— 它是**给界面看的提示**(壳替她点完没读到回执时写的),
 * 不是一句对着听筒说的话。电话里她该听见的是「我替你点了果汁,没看到它选上,你在电脑上点一下」。
 *
 * ## 规矩(这一处定死)
 *
 *   · **`note` / `error` 一个字都不念**:那两格是接口给界面的,照念就是把内部口吻读给她听;
 *   · 分档只看**形状那几格**:`/asks/voice` 回的是
 *     `{ ok, kind, picked? | custom?, confirmed, approved? }`(插件 `http.ts` 里 `/asks/voice` 那一段),
 *     加上 HTTP 状态码;
 *   · 这一条**只管 `/asks/voice` 那一路**。`/butler/item` 那边 400 回的那一句是
 *     **8791 替她回问的正文**(「这条打算哪天发?」),照旧原样念 —— 两件事不能混。
 */
export interface AnswerAskOutcome {
  /** HTTP 状态码(`0` = 连都没连上)。 */
  status: number
  /** 替她点上的那一项(`picked`)。 */
  picked?: string
  /** 原样送进那条会话的那一句(`custom`)。 */
  custom?: string
  /** 她在电话里说的那一句(「点没点上」那一档里要复述她的原话)。 */
  said?: string
  /** 这一问在哪一家(念给她听的正名,`familyTitle` 的结果)。认不出就不说哪一家。 */
  agent?: string
}

/** 送不进去那一档:这一问只能她自己去点。 */
export function askElsewhereSay(agent?: string): string {
  const who = (agent ?? '').trim()
  return who === '' ? '这一问得你在电脑上回答。' : `这一问得在电脑上的${who}里回答。`
}

/** 接口报错那一档(连不上、500、它自己也说不清)。 */
export const ASK_BROKEN_SAY = '我这边没办成,等会再试。'

/** 那一问已经不在了(409:那边自己往下走了)。 */
export const ASK_GONE_SAY = '那一问那边已经过去了,不用管了。'

/** 这几句话一句最长这么多字(同固定流程那一条:`DEMO_SAY_MAX_CHARS`,两边各自量)。 */
export const ANSWER_ASK_SAY_MAX_CHARS = 25

/** 「我替你答了 X」里那个 X 最多念这么多字(再长就不是一个选项了)。 */
const ANSWER_ASK_WHAT_MAX = 6
/** 念那一家的正名最多这么多字(「豆包办公」「千问办公」都在这之内)。 */
const ANSWER_ASK_WHO_MAX = 5

function clipChars(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/**
 * `/asks/voice` 没办成时她该说的那一句。**只看形状那几格,不看 `note` / `error`。**
 *
 * ★ 2026-10-13 下午(卡 C,验收交接第三节第 3 条):**200 + `confirmed:false` 那一档改口**。
 * 14:17 真机那一通里壳的回执说「没点上」,而**电脑上的豆包已经收到并回了** ——
 * 她却说「我替你点了咖啡,没看到它选上,你在电脑上的豆包办公里点一下」,
 * 既说错了事实,又给她派了一件不用做的活。现在这一档只说两件真事:
 * **我替你答了什么** + **你看一眼那边**(不再先说「没看到它选上」、不再命令她去点)。
 */
export function answerAskSay(outcome: AnswerAskOutcome): string {
  if (outcome.status === 409) return ASK_GONE_SAY
  /*
   * 400 / 404 = **一下都没送出去**(没听准是哪一项、只能选一项的那一问认不出她说的是哪一个、
   * 那一家的框写不进、替她按的路没接上、这件事上压根没有在等她的那一问)。
   * 这几种该说的是同一件事:这一问得你自己去答。
   */
  if (outcome.status === 400 || outcome.status === 404) return askElsewhereSay(outcome.agent)
  if (outcome.status !== 200) return ASK_BROKEN_SAY
  // 200 而没核实上:**送出去了、没核上**。复述一遍我替她答的是什么,再让她看一眼。
  const what = clipChars((outcome.picked ?? outcome.custom ?? outcome.said ?? '').trim(), ANSWER_ASK_WHAT_MAX)
  const who = clipChars((outcome.agent ?? '').trim(), ANSWER_ASK_WHO_MAX)
  const look = who === '' ? '你去电脑上看一眼' : `你看一眼${who}那边`
  return what === '' ? `我替你答了,${look}。` : `我替你答了${what},${look}。`
}

/**
 * `session:<哪一家>/<会话 id>` 里那一家(10-03 起的写法;老行 `session:<家>:<id>` 也读得出)。
 * 认不出回 `undefined` —— **不猜一家**(念错一家比不说哪一家更坏)。
 */
export function askAgentIdOf(itemId: string): string | undefined {
  const text = (itemId ?? '').trim()
  if (!text.startsWith('session:')) return undefined
  const rest = text.slice('session:'.length)
  const cut = /[/:]/u.exec(rest)
  const id = (cut === null ? '' : rest.slice(0, cut.index)).trim()
  return id === '' ? undefined : id
}

/* ──────────────────────── 先说再办(2026-10-13 下午,卡 A 第 1 条) ──────────────────────── */

/**
 * ★ **认出来就先念,派活放后台**(2026-10-13 下午,维护者真机 0.4.119:「体验有点奇妙」)。
 *
 * ## 现场(三通都这样)
 *
 * ```
 * 他说(ASR):帮我实生成一个云南瓦剌猫的蹦蹦跳跳的视频在屋檐上面。
 * 8791 听懂了:video/demo → 打 /butler/item(…)
 * 固定流程 video → /butler/item:办好了,说「好,做…的视频。先让豆包出参考图,图出来我放进可灵。」
 * 回合计时 #2 {"llm_first_ms":7631,…}                     ← 他说完到她开口:静默 7.6 秒
 * ```
 *
 * `/butler/item` 这一支里**同步**等着把第一步派给豆包(每次 7.4–7.6 秒),而固定流程回合
 * 按设计**不先应、不垫场** —— 两条加在一起就是「他说完,听筒里 9 秒没人说话」。
 *
 * `say.start` 那一句本来就是「**将要做**」的措辞(「先让豆包出参考图,图出来我放进可灵」),
 * 所以它不必等派活回来:**先念,派活在后台跑**;真没派出去再补一句短的原因
 * ({@link sayFirstFailLine})。
 *
 * ## 哪几类先念
 *
 * 只有**要派活**那一支({@link SAY_FIRST_KINDS})。`today_view` / `publish_plan` 照旧同步 ——
 * 它们 1.5 秒内就回(真机 `llm_first_ms` 111–186ms),而且那一句话要看结果才说得对
 * (`changed:false` → 「本来就是列表的,没动」);先念就得冒「说错一版」的险,换不来 1 秒。
 * `answer_ask` / `append` 同理(那两句都在说已经发生的事)。
 */
export const SAY_FIRST_KINDS: readonly UnderstandKind[] = ['video']

/** 这一份判定该「先念再办」吗。 */
export function saysFirst(one: Understanding): boolean {
  if (one.route?.path !== '/butler/item') return false
  if (!SAY_FIRST_KINDS.includes(one.kind)) return false
  // 没有那一句就没什么可先念的(回头还得靠结果拼一句)。
  return one.say.start.trim() !== ''
}

/** 后补那一句最长多少字(同 `DEMO_SAY_MAX_CHARS`:电话里每一句都短)。 */
export const SAY_FIRST_FAIL_MAX_CHARS = 25

/**
 * 先念之后派活没成,**补的那一句**。入参是 `runUnderstanding` 已经挑过的那句原因
 * (`dispatch_note`)。拼不出一句人话就回 `undefined` —— 那时一个字都不补
 * (**不编一个原因**,D13;那一件在 8791 那头照旧会排一通「运行失败」打回来)。
 */
export function sayFirstFailLine(say: string | undefined): string | undefined {
  const raw = (say ?? '').trim()
  if (raw === '') return undefined
  const chars = [...raw]
  return chars.length <= SAY_FIRST_FAIL_MAX_CHARS ? raw : `${chars.slice(0, SAY_FIRST_FAIL_MAX_CHARS - 1).join('')}…`
}

/* ──────────────────────── 送去办的正文是哪一句 ──────────────────────── */

/**
 * ★ **送 `/butler/item` 的正文用 8791 认的那一句,不用拼起来的那一段**
 * (2026-10-13 下午,卡 A 第 6 条)。
 *
 * 他被打断之后那一回合有两段识别结果:
 * 「给我生成一个。」+「给我生成一个女孩子在树林下摘蘑菇的视频。」。
 * 工人把一回合的几段**拼**在一起记成 `turnHeard`,从前送去办的就是它 ——
 * 于是卡标题成了「给我生成一个。给我生成一个女孩子…」,主题被截成
 * 「。给我生成一个女孩子在树林下摘蘑菇」,选题目录名也是它。
 *
 * 而「听懂」那一问是**按段**问的(`hearFinalText` 里拿 `transcript` 问),
 * 工人自己认下来的那一句是对的。所以送去办的正文就用它。
 *
 * 问不到那一句(老工作台、超时)才退回拼起来的那一段 —— 行为与这一版之前一字不差。
 */
export function bodyTextOf(input: { asked?: string, heard: string }): string {
  const asked = (input.asked ?? '').trim()
  return asked === '' ? (input.heard ?? '').trim() : asked
}

/* ──────────────────────── 补一句没进去时说什么 ──────────────────────── */

/**
 * ★ **`/butler/item/say` 没办成时说的那一句**(2026-10-13 下午,卡 A 第 2 条后半)。
 *
 * 14:02 那一通:「好了,告诉我,拜拜」被当成补细节 → `/butler/item/say` 回 409
 * 「这件事的会话没开,说不进去」→ **那句接口的话被原样念了出来**。
 *
 * 道别那一头已经在 `farewell.ts` 收掉了;**这一路从此一个 `note` / `error` 的字都不念**,
 * 只说这一句(维护者 10-13 定的措辞)。真实原因照旧进日志 —— 查的时候要看得见。
 *
 * ⚠️ 这一句与 D13(不许说没做的事)相抵:会话没开那一下**那句细节其实没落下去**
 * (视频接力那一件是 `skipSession` 建的,见 `docs/交接-1013-一套管线与演示固定流程.md` 第十节第 5 条)。
 * 要名实相符得让 8791 对没有会话的那一件也收下补的话 —— 归下一张卡,见本卡交接「决策记录待写」。
 */
export const APPEND_FAILED_SAY = '记下了。'

/* ──────────────────────── 固定流程那一句怎么出声 ──────────────────────── */

/**
 * 把一句定死的话变成 `llmNode` 那条流的形状(一个字符串块就够:
 * 框架与我们流上那几层(`sentenceCap` / `claimGuard` / 垫场)都收字符串,见 claimGuard.ts 的 `emit`)。
 *
 * **为什么走 `llmNode` 而不是 `session.say`**:走这里,框架照常把这一句排进发言队列、
 * 进对话历史、推字幕与表情 —— 与模型说的那一句走的是同一条路,下一回合她记得自己说过什么。
 * `session.say` 那条路是给**开场白 / 先应**那种「插在回合之外」的句子用的。
 */
export function saidStream<T>(text: string): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      const said = text.trim()
      if (said !== '') controller.enqueue(said as T)
      controller.close()
    },
  })
}
