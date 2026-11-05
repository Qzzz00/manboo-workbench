/**
 * 工作台(8791)客户端。工人对工作台只有这几件事要做:
 *
 *   - 取进房凭证(`POST /channel/token` + `worker: true`);
 *   - 取人设与此刻的事项摘要(`GET /channel/persona`);
 *   - 三件工具:记一件事 / 查在办 / 给已在办的事补一句。
 *
 * 工人跑在本机,所以走回环 —— **不带任何令牌**,门是 8791 自己的回环门。这也意味着
 * 工人**够不到 ~/.dsh**:人设、事项、会话全由工作台经手,工人一个文件都不读。
 *
 * 纪律:每个方法都返回 `{ ok, ... }` 而不是抛。工具执行失败要能变成一句「没记上」说给他听,
 * 而不是把整条通话打断 —— 电话里最坏的失真是「答应了但其实没办」(D13)。
 */
import { todoViewDoneText, todoViewSameText, type TodoView } from './todoView.ts'
import type { Understanding } from './understand.ts'
import { APPEND_FAILED_SAY, answerAskSay, askAgentIdOf } from './understand.ts'
import type { CallAsk } from './confirm.ts'
import { fallbackSpoken } from './confirm.ts'
import { familyTitle } from './agentName.ts'
import { personaSectionsOf, type PersonaSection } from './personaTrim.ts'
import { postSayTurn, type SayContext, type SayReply } from './sayTurn.ts'

/** `GET /families` 回包里一行的形状(与插件 `server/spokenFamily.ts` 的 `SpokenFamily` 同三格)。 */
export interface SpokenFamilyRow {
  id: string
  title: string
  aliases?: readonly string[]
}

/**
 * 工人替房里的手机去调 8791 时带的头。带上它,8791 就**把这条回环请求降成那台设备的权限**
 * —— 和这台手机自己打 8791 时一模一样。定义与理由在 workbench-plugin/src/server/channel.ts
 * 的 `CHANNEL_DEVICE_HEADER`;两端必须是同一个字符串。
 *
 * 工人自己那几条调用(取凭证、取人设、三件工具)**不带**它 —— 那些是工人自己的事,不是替谁办的。
 */
export const CHANNEL_DEVICE_HEADER = 'x-workbench-channel-device'

/**
 * 工人替房里的设备转请求时,报**自己在哪条路线的房间里**(2026-10-21,局域网主路)。8791 据此签同一间房的票:
 * 云房间里的让中转签,本机房间里的本机签、给这台 Mac 的局域网地址。定义与理由在 workbench-plugin/src/server/channel.ts
 * 的 `CHANNEL_ROUTE_HEADER`;两端必须是同一个字符串(有对照用例)。还不知道自己在哪条(没取过票、老 8791 不回)就不带。
 */
export const CHANNEL_ROUTE_HEADER = 'x-workbench-channel-route'

/** 路线:`lan` = 本机房间(8791 自己签),`relay` = 云房间(中转签)。与 8791 的 `ChannelRoute` 同一套值。 */
export type ChannelRoute = 'lan' | 'relay'

export function channelRouteOf(value: unknown): ChannelRoute | undefined {
  return value === 'lan' || value === 'relay' ? value : undefined
}

/**
 * 工人那把进程令牌走的头(2026-09-28,卡 BS)。与 8791 的
 * `workbench-plugin/src/server/herself.ts` 的 `ACTOR_TOKEN_HEADER` 必须是同一个字符串。
 */
export const ACTOR_TOKEN_HEADER = 'x-workbench-actor'

/**
 * 事项能派给谁(2026-09-21,卡 ④「指挥电脑上的 Agent」)。
 *
 * `dsh` 也在里面 —— 他在电话里会说「这件你自己来」,模型得有个东西填;它等同于不填
 * (工作台那边 assignee=dsh 就是事务官自己办,不会起任何子进程)。
 *
 * ★ **开集,与插件一致**(2026-10-22,卡「契约对照测试补齐」):插件在 2026-09-25(卡 Z)就删了
 * 写死的名单、改成 `AgentDispatchFamily = string`,有哪几家能接活由工作台的 Agent 登记表说了算。
 * 工人只把模型填的那一家**归一化后原样发过去**,不写死 8 家、不替它判断 —— 写死名单的注释
 * (「值域与 8791 的 TaskAssignee 一字不差」)已过时删除。开集这件事由
 * `channel-worker/tests/item-assignee-sync.test.ts` 读插件源码钉着。
 */
export type ItemAssignee = string

/**
 * 模型给的那个值归一化。**任意非空字符串都收**(新家名不再当成「没点名」);
 * 只有空的、不是字符串的才算没点名 —— 整个字段不发,8791 才分得清"没点名"与"点了名但认不出"。
 */
export function itemAssigneeOf(value: unknown): ItemAssignee | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('agent:')) return trimmed
  return trimmed.toLowerCase()
}

/** 规范化类型 id:支持 dev/meeting/content/routine 及其对应的中文名 */
export function normalizeWorkType(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined
  const trimmed = val.trim()
  if (trimmed === '会议' || trimmed === 'meeting') return 'meeting'
  if (trimmed === '研发与设计' || trimmed === '研发' || trimmed === '设计' || trimmed === 'dev') return 'dev'
  if (trimmed === '内容与推广' || trimmed === '内容' || trimmed === '推广' || trimmed === 'content') return 'content'
  if (trimmed === '经营与其他' || trimmed === '经营' || trimmed === 'routine') return 'routine'
  return trimmed === '' ? undefined : trimmed
}

/** 解析便签来源:对象形 {kind, ref?, quote?} 或字符串 */
export function parseNoteFrom(from: unknown): { kind: string, ref?: string, quote?: string } | undefined {
  if (typeof from === 'object' && from !== null) {
    const obj = from as Record<string, unknown>
    if (typeof obj.kind === 'string' && obj.kind.trim() !== '') {
      return {
        kind: obj.kind.trim(),
        ...(typeof obj.ref === 'string' && obj.ref.trim() !== '' ? { ref: obj.ref.trim() } : {}),
        ...(typeof obj.quote === 'string' && obj.quote.trim() !== '' ? { quote: obj.quote.trim() } : {}),
      }
    }
  }
  if (typeof from === 'string' && from.trim() !== '') {
    const trimmed = from.trim()
    if (['meeting', 'session', 'said', 'channel', 'evidence', 'user'].includes(trimmed)) {
      return { kind: trimmed }
    }
    return { kind: 'said', quote: trimmed }
  }
  return undefined
}


/**
 * 问一次工作台版本最多等多久(2026-09-23)。2 秒:`GET /update/check` 会去更新服务器
 * 拉一次清单,而它排在「她接起电话开口」前面 —— 网不好的时候宁可这一行写「没拿到」,
 * 也不能让她晚两秒说话。
 */
export const WORKBENCH_VERSION_TIMEOUT_MS = 2000

/** 8791 回来的进房凭证。`url` 是 livekit-server 的地址 —— 工人不自己配。 */
export interface ChannelTicket {
  url: string
  room: string
  identity: string
  token: string
  expires_at: number
  /** 这张票是哪条路线的(2026-10-21)。老 8791 不回就缺席。 */
  route?: ChannelRoute
}

/**
 * 替设备续到的那一张(2026-10-21 起多带地址):`url` / `room` / `route` 是 8791 按来路签的那间房 ——
 * 设备拿续到的地址覆盖旧的(连接规格「续期回来的地址覆盖旧的」)。老 8791 只回两格时这三格缺席。
 */
export interface RenewedTicket {
  token: string
  expires_at: number
  url?: string
  room?: string
  route?: ChannelRoute
}

/** 按房间领电话的回包(2026-10-21,卡 M6 两间房用)。 */
export interface RoomClaim {
  calls: readonly unknown[]
  /** 这间房领过、已在别的房间接起的那几通:收掉自己房里的铃。 */
  answered_elsewhere: readonly { id: string, room: string }[]
}

/**
 * 「我这间房里有人接起了」的答案(2026-10-21,先接先得)。`first: false` = 别的房间先接了,挂掉自己这边。
 * `unknown: true` = 问不到 8791(没这条路 / 连不上):**当先接**,不为一个问不到的答案把她的电话挂掉。
 */
export interface AnsweredVerdict {
  first: boolean
  room?: string
  device_id?: string
  unknown?: true
}

/**
 * 8791 下发的第三方凭据(2026-09-21)。以前工人自己去读
 * `~/.dsh/workbench/channel.json`;现在**它一个文件都不读** ——
 * 那份文件在新用户的机器上压根不存在(钥匙在服务器上,由工作台登录后取回来)。
 *
 * 只存内存、不落盘;下一轮进房时自然会再取一份新的,于是服务器上换了钥匙这边就跟上了。
 */
export interface ChannelCredentials {
  source: 'local' | 'server' | 'none'
  volc_asr?: { app_id: string, access_token: string, resource_id?: string }
  volc_tts?: { app_id: string, access_token: string, resource_id?: string, cluster?: string }
  expires_at?: string
  /** 取不到时的一句人话(例如「登录之后才能用」)。原样记进日志,不自己编。 */
  note?: string
}

/**
 * 这台机器上「可以找文件」的目录(2026-09-21)。由 8791 按 `docs/记忆/授权.md` 的
 * `read_scan_roots` 决定:不是「可以」就一个目录都不给,并带一句人话。
 */
export interface ChannelSearchRoots {
  allowed: boolean
  roots: readonly { path: string, label?: string, depth?: number }[]
  /** 没授权 / 这份工作台还没有这条接口时的一句人话。**原样说给他听**。 */
  note?: string
  /**
   * 带着他那句话问的时候,8791 顺手认出来的项目(2026-09-25,卡 J):「工作台 README」→
   * 只在 desktop-workbench 里找 readme。认不出 / 老的 8791 就缺席,照旧在所有根里找。
   */
  focus?: { name: string, path: string, terms: readonly string[] }
}

/** 替在外面的那台手机核一张取件单(`GET /channel/file-offer/<单号>`,2026-09-25)。 */
export type ChannelFileOffer =
  | { ok: true, path: string, name: string, bytes: number, where?: string }
  | { ok: false, error: string }

/** 人设 + 此刻事项摘要。工人一个字都不自己编(见 workbench-plugin/src/server/channel.ts)。 */
export interface ChannelPersona {
  system_message: string
  /**
   * **同一份人设,一段一段带标记**(2026-10-03,卡「chat 路人设按意图裁」)。
   * 工作台拼的(`workbench-plugin` 的 `channelPersonaSections`),按顺序把 `text` 拼起来
   * 逐字就是 {@link system_message}。工人按这一回合的意图与手上那几件工具摘掉用不上的段,
   * 裁法与退路全在 personaTrim.ts 的文件头。
   *
   * **老工作台没有这一格就缺席** = 每回合整份带 {@link system_message},和这一版之前一字不差。
   */
  persona_sections?: readonly PersonaSection[]
  welcome: string
  butler_name?: string
  /** 只是「怎么说话」那一段(2026-09-18)。引导模式自己拼系统提示时用它,语气不分叉。 */
  style?: string
  /**
   * 电话里怎么叫他(2026-09-23)。人设里那张「称呼」表,由 8791 解析出来。
   * 没写过就缺席 —— 工人退回 address.ts 里那两个缺省,**不自己编一个称呼**。
   */
  addresses?: readonly string[]
  /**
   * 每轮最多几句(2026-09-24 晚,卡 K)。8791 从他的规矩表算出来(「电话每轮不超过两句」→ 2);
   * 他把那条删了就缺席 = 不掐。工人在流上掐(sentenceCap.ts),引导那一通不掐。
   */
  max_sentences?: number
  /**
   * **识别热词**(2026-10-02,卡「电话里像个活人」):这台机器上的家名、事务官的名字、称呼、
   * 账号名、小组件名、她最近说过的专有词。8791 的 `GET /channel/persona` 算好了下发
   * (workbench-plugin 的 `channelHotwords`)。
   *
   * 工人把它交给识别那一头:火山流式走 `request.corpus.hotwords`(asr/volcProtocol.ts),
   * 分段兜底走 8792 `/api/asr` 的 `hotwords`。**老工作台没有这一格就缺席** = 不带热词,
   * 和这一版之前一字不差。
   */
  hotwords?: readonly string[]
}

/**
 * 事务官本尊那条会话里的一个回合(`GET /butler/item/:id/turns`)。
 * 与 workbench-plugin 的 `SessionTurn` 逐字相同(两个仓库不互相 import,见文件头那条老规矩)。
 */
export interface SessionTurn {
  role: 'user' | 'assistant'
  text: string
  at: string
}

/**
 * 转给本体之后最多等多久(2026-09-23)。**12 秒** —— 一个 DSH 回合通常三五秒,
 * 十二秒还没回基本是它正忙着别的活。再长下去他会以为电话断了:
 * 缓冲语只有七句,盖不住半分钟的沉默(filler.ts)。
 * 等不到就如实说「它还没回」,**绝不自己编一个答案**。
 */
export const BUTLER_ANSWER_TIMEOUT_MS = 12_000
/** 隔多久去看一眼有没有新回合。600ms:一条回环 HTTP,快到听不出来,也不至于把 8791 问麻。 */
export const BUTLER_ANSWER_POLL_MS = 600

const sleep = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))

/** 这几条回合里最后一条事务官的话是什么时候说的(没有就 undefined)。 */
export function lastAssistantAt(turns: readonly SessionTurn[] | undefined): string | undefined {
  return [...(turns ?? [])].reverse().find(turn => turn.role === 'assistant')?.at
}

/**
 * **比 `since` 更新**的那条事务官回话。没有就 undefined。
 *
 * 为什么要比时间而不是直接取最后一条:问话投进去的那一瞬间,会话里通常已经躺着
 * 上一轮的回答 —— 取最后一条会把上一轮的答案当成这一轮的念给他听(D13 那类失真里
 * 最难发现的一种:话是真的,答的不是这个问题)。
 */
export function newestAssistantText(
  turns: readonly SessionTurn[] | undefined, since: string | undefined,
): string | undefined {
  for (const turn of [...(turns ?? [])].reverse()) {
    if (turn.role !== 'assistant') continue
    if (since !== undefined && turn.at <= since) return undefined
    const text = turn.text.trim()
    return text === '' ? undefined : text
  }
  return undefined
}

/**
 * 「要放开这件事,Ben 得改哪一行」——**授权表被拒时必须说清楚的那一句**
 * (2026-09-23,Ben:她当时答「没记上,事务官那边还没拿到写工作台的授权」,
 * 而他根本不知道该去哪儿改;更早的一版甚至说「我记在脑子里」)。
 *
 * 文件名与键名逐字写死:`docs/记忆/授权.md` 的「能写什么」那张表,`write_api` 那一行。
 * 他那份在 `~/Documents/工作台/docs/记忆/授权.md`。
 */
export function writeApiHint(): string {
  return '如实告诉他:这要他自己放开 —— 在 docs/记忆/授权.md 的「能写什么」那张表里,'
    + '`write_api` 那一行现在写的是「不可以」,把它改成「可以」就行(他那份在 ~/Documents/工作台 底下)。'
    + '**不要说「我记在脑子里」**,也不要说下次再试。'
}

/** 同上,写人设那一项(`write_docs`)。 */
export function writeDocsHint(): string {
  return '如实告诉他:这要他自己放开 —— 在 docs/记忆/授权.md 的「能写什么」那张表里,'
    + '`write_docs` 那一行改成「可以」(他那份在 ~/Documents/工作台 底下)。'
}

/** 看板上一条事项,只留通话里念得出来的那几样。 */
export interface BoardItem {
  id: string
  title: string
  status: string
  /**
   * 派给别家那一件此刻的样子(2026-09-24,卡 F):「派给 Codex,回来了:……」「派给 Kimi,等它回答」。
   * 他在电话里问「Codex 做完了吗 / 回来说什么了」,她照这一句答 —— 这就是「通过事务官去验收」的那一半。
   */
  dispatch?: string
}

/** 派活那几家在电话里怎么念(与工作台 DISPATCH_FAMILY_TITLES 同一套)。 */
const DISPATCH_WHO: Readonly<Record<string, string>> = {
  codex: 'Codex', claude: 'Claude', kimi: 'Kimi', gpt: 'GPT', doubao: '豆包', muse: 'Muse', manus: 'Manus',
}

/** 卡上的派活记录 → 一句给她念的话。没派过活回 undefined。回答只念开头 120 字,全文在卡上。 */
export function spokenDispatchOf(raw: unknown): string | undefined {
  const task = (raw ?? {}) as { client_dispatch?: Record<string, unknown>, dispatch?: Record<string, unknown> }
  const cd = task.client_dispatch
  const d = task.dispatch
  const family = typeof cd?.family === 'string' ? cd.family : typeof d?.family === 'string' ? d.family : undefined
  if (family === undefined) return undefined
  const who = DISPATCH_WHO[family] ?? family
  const reply = typeof cd?.reply === 'string' && cd.reply.trim() !== '' ? cd.reply : typeof d?.reply === 'string' && d.reply.trim() !== '' ? d.reply : undefined
  if (reply !== undefined) {
    const flat = reply.replace(/\s+/g, ' ').trim()
    return `派给 ${who},回来了:${flat.length > 120 ? `${flat.slice(0, 120)}…` : flat}`
  }
  if (cd?.reply_state === 'unreadable') return `派给 ${who},已经发出去了,但结果没读回来,要他到 ${who} 里看`
  if (cd?.status === 'failed' || d?.status === 'failed') return `派给 ${who},没派出去`
  if (cd?.reply_state === 'waiting' || d?.status === 'running') return `派给 ${who},还在等它做完`
  return undefined
}

export type ToolResult =
  | { ok: true, text: string }
  /**
   * `unreachable`(2026-10-22):**工作台连不上**(请求根本没送到)。通话记录据此把这一张算成没建成的「要办」
   * (`callRecord.ts` 的 `unsavedTodoOf`);工作台回了话却不肯建的不带它。
   */
  | { ok: false, text: string, unreachable?: true }

/**
 * `POST /butler/understand` 回来的那一下(2026-10-13,卡「三个入口一套管线」)。
 *
 * `old` = 这台工作台还没有这条路(404)—— **照老路交给模型**,别把电话弄坏;
 * `down` = 连不上 / 回包不认得,同上。两种都只记一行日志,一个字不跟她说。
 */
export type UnderstandOutcome =
  | { kind: 'understood', understanding: Understanding }
  | { kind: 'old' }
  | { kind: 'down', why: string }

/** 照那份判定办完之后的那一下。`say` 就是嘴里要念的那一句(已经按真实结果挑过)。 */
export interface UnderstoodResult {
  ok: boolean
  say: string
  /** `/butler/item` 建出来的那一件(下一句「补细节」要并进它)。 */
  itemId?: string
  /**
   * **真实原因,只进日志**(2026-10-13 下午,卡 A):`say` 换成固定一句的那几路
   * (补一句进那件事)照旧要让查日志的人看得见 8791 到底回的是什么。
   * 念出去的永远只有 `say`。
   */
  why?: string
}

/**
 * 理解中枢执行口的回包(A2,2026-10-28;8791 `POST /butler/hub/execute`,契约统筹 10-28 定,见交接-1028-A1):
 * `{ say_id, results, say }`。每条结果 `{ command, ok, did, why?, next?, card_id?, ask? }`;护栏挂起、要她点头的那一条
 * 带 `ask.ask_id`(8791 挂的那一问),答了再打一次 `confirmed`。
 */
export interface HubExecuteResult {
  command: string
  ok: boolean
  did: string
  why?: string
  next?: string
  card_id?: string
  ask?: { question: string, options: readonly string[], ask_id?: string }
}
export interface HubExecuteReply {
  say_id: string
  results: readonly HubExecuteResult[]
  say: { screen: string, spoken: string }
}

export type HubExecuteOutcome =
  | { ok: true, reply: HubExecuteReply }
  /** `old` = 这台 8791 还没有执行口(404);`unreachable` = 请求没送到。 */
  | { ok: false, why: string, old?: true, unreachable?: true, status?: number }

export interface WorkbenchClient {
  ticket: () => Promise<ChannelTicket>
  /**
   * 理解中枢的执行口(A2):一条或几条命令(按 8791 命令表)交过去,护栏 / 核手 / 执行全在那头。
   * `confirmed` = 她答了 8791 挂的那一问。可缺:老用例里的假客户端没有它(工具如实说这一版办不了)。
   */
  hubExecute?: (input: { said: string, commands?: readonly Record<string, unknown>[], confirmed?: { ask_id: string, choice: string } }) => Promise<HubExecuteOutcome>
  /** 理解中枢的上下文包(A2;8791 `GET /butler/hub/context`):与 `/butler/say` 同一份。取不到 `{ ok:false }`,不挡回合。 */
  hubContext?: (input: { entrance: 'call', said: string }, transport?: { timeoutMs?: number }) => Promise<{ ok: true, text: string } | { ok: false }>
  persona: () => Promise<ChannelPersona>
  /** 每句电话 final 进入唯一意图中枢；失败由入口如实播报不可用。 */
  sayTurn: (input: { text: string, ctx?: SayContext, clientKey?: string }, transport?: { timeoutMs?: number, signal?: AbortSignal }) => Promise<{ ok: true, reply: SayReply } | { ok: false, why: string, timedOut?: boolean, outcomeUncertain?: boolean }>
  /**
   * 第三方凭据(火山识别/合成)。**取不到不抛**:回 `{ source: 'none', note }` ——
   * 没有识别凭据只是「这一轮走分段兜底」,不该把整条进房流程带走。
   * 老版本的工作台没有这条路(404),同样回 none,工人退回老办法(环境变量 / channel.json)。
   */
  credentials: () => Promise<ChannelCredentials>
  /**
   * ★ **这台电脑上认得出哪几家**(2026-10-03,卡「两条接缝」;决策记录 10-03 早 ⑦)。
   *
   * 认家名的候选池**主人在插件那头**(家族目录 + 本机探测 + 登记表),这条路是它的下发口
   * `GET /families`。工人每轮进房前拉一次,拉到就 `setFamilyPool` 整池换掉;
   * **取不到不抛**(回 `{ ok:false, note }`)—— 这一轮退回 `FALLBACK_FAMILIES`,
   * 老版本的工作台(404)同理。
   */
  families: () => Promise<{ ok: true, families: readonly SpokenFamilyRow[] } | { ok: false, note: string }>
  /** 记一件事:建卡 + 在 DSH 里开一条会话把原话发出去。 */
  rememberItem: (text: string, assignee?: ItemAssignee | undefined) => Promise<ToolResult>
  /** 查此刻在办 / 等他确认的事(现查现答,不照人设里那份快照背)。 */
  listDoing: () => Promise<ToolResult>
  /**
   * 「XX 到哪了」(2026-09-25,卡 N):走 8791 的 `POST /progress/ask` —— 工作台认出是看板上哪一张,当场按证据
   * (仓库提交 / 交接 / 派出去的活的回话 / 各家会话最后几轮)核一次,回一句「现在到哪 · 依据 · 几点看的」。
   * 没看到进展就是「还没看到进展,要你说一句」,**不编**。旧版工作台没有这条路(404)时如实说。
   */
  askProgress: (text: string) => Promise<ToolResult>
  /**
   * 会前(2026-10-10,卡「会前画像与预案」):她在电话里说「下午三点跟 B 客户谈…」→ `POST /meeting/plan`,
   * 落成一场待开的会;回话里带「还差哪一问」。可选:老的假客户端没有它,工具就如实说不会。
   */
  planMeeting?: (text: string) => Promise<ToolResult>
  /** 答那场会还差的那一问 → `POST /meeting/answer`(不带 id = 最近那场还在问的会)。 */
  answerMeeting?: (answer: string) => Promise<ToolResult>
  /** 往已在办那条事项的会话里再补一句。 */
  handToButler: (itemId: string, text: string) => Promise<ToolResult>
  /**
   * **把他的话捎进某条会话**(2026-09-26,卡 BR):走 8791 的 `POST /sessions/relay`。
   *
   * 维护者 16:41 那一通要的就是这条路(「给那个 Claude、现在正在做统筹交接的那个会话窗口,发个信息问一下」),
   * 而那会儿只有 {@link askButler} 这条**要事项 id** 的路 —— 于是他听到的是「它归哪件事」。
   * 这一条**不要事项**:`who` 是他点名那一句原话,工作台按 `/state.sessions` 里的标题 / 家名 / 状态认;
   * `text` 是他要捎的原话,**原样送**。
   *
   * 三种回话都如实带走:捎到了 / 有几条都对得上(念给他选)/ 捎不进去(哪一步没成)。
   * 旧版工作台没有这条路(404)就说这台电脑上的工作台还不会捎话 —— **不装作送到了**(D13)。
   */
  relayToSession: (input: { who: string, text: string, interrupt?: boolean, overwrite?: boolean, newConversation?: boolean, watchOnly?: boolean, callOnReply?: boolean }) => Promise<ToolResult>
  /**
   * **看一眼某一家此刻在跑的那条对话,只读**(2026-09-27,卡 LK)。
   *
   * 维护者 21:2x:「你告诉我现在 Codex 现在是什么状态?」「不要给他发信息,就看一眼」——
   * 那会儿能用的只有 {@link relayToSession}(会真往那扇窗里打字)与 `wb_item_progress`
   * (核的是看板上的旧事项)。这一条走 `GET /sessions/lookup`:**一个字节都不送出去**,
   * 回一句「在跑还是停了 · 最后一次动静多久前 · 最后一句在干什么」。
   */
  lookupSession: (who: string) => Promise<ToolResult>
  /**
   * **建一条看板卡 / 派一张需求卡**(2026-09-23,Ben:「把音色这个事情改成可以配置的……
   * 你能派单吗?」——那一通里她答「没记上」,而真相是工人**压根没有这件工具**)。
   *
   * 走 `POST /task/create`,与他在看板上手建一张卡**同一条路**。
   * 和 {@link rememberItem} 的分工写死:
   *   - `rememberItem` 走 `/butler/item` —— 建卡 **+ 在 DSH 里开一条会话**,是「交给事务官去办」;
   *   - 这一条只建卡,不开会话 —— 是「先记在看板上」与「派一张需求卡」。
   *
   * `feature: true` 时带 `kind=feature` 与那句需求(`desc`),于是它落在需求卡那一档上,
   * 而不是一张没头没尾的待办(卡 = 指挥台,见 docs/审视-用户到底得到什么-2026-09-22.md 第三节)。
   *
   * **授权表不放行时如实说**:`write_api` 不是「可以」→ 8791 回 403 + 一句人话,
   * 这里原样带走,再补上「要 Ben 改哪一行」(见 {@link writeApiHint})。
   */
  createTask: (input: { title: string, desc?: string, feature?: boolean }) => Promise<ToolResult>
  /** 在看板上建一个目标(2026-10-23,卡「事务官的板上工具」):POST /collab/goal/create */
  createGoal: (input: { title: string, why?: string, due?: string, project?: string, project_id?: string, version?: string }) => Promise<ToolResult>
  /** 更新看板上的目标(2026-10-23):POST /collab/goal/update */
  updateGoal: (input: { id: string, title?: string, status?: 'open' | 'reached' | 'dropped', why?: string, due?: string, project?: string, project_id?: string, version?: string }) => Promise<ToolResult>
  /** 在看板上建便签(2026-10-23,缺省 backlog):POST /task/create */
  createNote: (input: {
    title: string
    goal_id?: string
    status?: 'backlog' | 'todo'
    assignee?: string
    work_type?: string
    start?: string
    end?: string
    acceptance?: readonly string[]
    from?: unknown
  }) => Promise<ToolResult>
  /** 更新便签属性(2026-10-23):POST /task/update */
  updateNote: (input: {
    id: string
    goal_id?: string
    work_type?: string
    start?: string
    end?: string
    priority?: string
    title?: string
    assignee?: string
    acceptance?: readonly string[]
  }) => Promise<ToolResult>
  /** 挪动便签状态(2026-10-23,按七态转换表):POST /task/move */
  moveNote: (input: { id: string, status: string }) => Promise<ToolResult>
  /**
   * **接需求先给确认点**(2026-09-23,维护者 13:05:「不能假装自己搞懂了」)。
   *
   * 走 8791 的 `POST /confirm/points` —— 它是那张「确认点生成规则」表的**唯一出口**。
   * 顶层各子目录互不 import(AGENTS.md),所以工人只能问过去;但那不是"各写一份"的理由:
   * 电话里问的和卡上问的必须是同一套,否则"她到底确认了什么"就说不清了。
   *
   * **问不到不抛**:旧版工作台没有这条路(404)、8791 没起来(连不上),都回
   * `{ ok:false, spoken }` —— `spoken` 是兜底那一句(至少问「怎么算做完」),
   * 并让她如实说这一次没拿到那张表。**不装作问过了**。
   */
  confirmPoints: (text: string, who?: string, opts?: {
    /**
     * 哪一件工具在问(2026-10-12,「电话里只在拿不准时先确认」):带上它 8791 才回 `call`(要不要先问)。
     * dispatch / feature / hand / layout / file。
     */
    for?: string
    /** 她刚说的原话(「先跟我确认」常常丢在模型改写的那句里)。 */
    said?: string
  }) => Promise<{
    ok: boolean
    /** 电话里念的那一段(最多三条、每条一句)。**ok 与否都有** —— 门不能因为表没拿到就开。 */
    spoken: string
    /** 没拿到那张表时的一句实话(拼进回给模型的话里)。 */
    note?: string
    /**
     * **这件事简单**(2026-09-28,卡 CF 第 6 条):点了名、一句话说得清的打听。
     * 真 = `spoken` 是**一句**确认(不是三条),回给模型的门也短一截。
     */
    simple?: boolean
    /**
     * **要不要先问**(2026-10-12)。8791 按规则判(`callAsk.ts`)。**缺席 = 判不准 → 按问**
     * (老工作台没有这一格、表没拿到)。
     */
    call?: CallAsk
  }>
  /**
   * **把这句问话转给事务官本体**(2026-09-23,「通话里的她 = 本体」)。
   *
   * 走的是 `POST /butler/item/say` + 轮询 `GET /butler/item/:id/turns`:
   * 把他的问题投进那条事项底下的 DSH 会话,再把本体的回答取回来念给他听。
   * 为什么要它:工人那只小模型看不见记忆、判断不了事项,自己答就是编(D13)。
   *
   * **慢**:一个 DSH 来回。所以只给「问事项 / 问记忆」两类用(butlerRoute.ts),
   * 闲聊仍由工人自己答;等的这几秒由缓冲语盖(filler.ts 的 SLOW_TOOLS)。
   * 等过了 `timeoutMs` 还没有新回合就**如实说没等到**,不编一个答案。
   */
  askButler: (input: { itemId: string, question: string, timeoutMs?: number }) => Promise<ToolResult>
  /**
   * 那条事项底下会话的最近几个回合(`GET /butler/item/:id/turns`)。
   * 只给 {@link askButler} 用 —— **取不到不抛**,回 `{ ok:false }`,由它去决定等还是不等。
   */
  itemTurns: (itemId: string) => Promise<{ ok: true, turns: readonly SessionTurn[] } | { ok: false }>
  /**
   * **把一条长期偏好写进人设**(2026-09-23,Ben 第五通三次说「这个我记着了」而什么都没落盘)。
   *
   * 走 8791 的窄口 `POST /butler/memory/preference`,它写的是 `~/.dsh/AGENTS.md` 里
   * 「通话偏好」/「称呼」两个标记段,**段外一个字不动**;门是授权表的 `write_docs`。
   *
   * `kind: 'address'` 是称呼表那一路(他说「以后叫我姚总」),其余进偏好段。
   * 回 `{ ok:false }` 时**必须照实说没记上** —— 「她说记住了」与「真写了」必须是同一件事。
   */
  savePreference: (input: { text: string, kind?: 'preference' | 'address' }) => Promise<ToolResult>
  /**
   * **电话里用说话改布局**(2026-09-22)。
   *
   * 走的是 `POST /layout/act` —— 与界面上那张确认卡点「就这样」之后走的**同一条路**。
   * 不走 `POST /layout`:那条会把整份布局覆盖掉,一个字段填错就是他排了半天的版面没了;
   * `/layout/act` 一次只改他说的那一格,而且改之前工作台自己存好了可回退的快照。
   *
   * `undo` 走 `POST /layout/undo`(回退上一步)。
   */
  layoutAct: (input: {
    orientation: 'portrait' | 'landscape'
    actions: readonly Record<string, unknown>[]
    reason?: string
  }) => Promise<ToolResult>
  layoutUndo: () => Promise<ToolResult>
  /**
   * 换「今天的待办」的显示(2026-10-12,周三演示):`POST /today/view {view}`。
   * 切之前 8791 存一份布局快照,所以 `layoutUndo` 也能切回上一版。
   */
  todoView: (view: TodoView) => Promise<ToolResult>
  /**
   * ★ **往她日历上记一条发布计划**(2026-10-13 下午,卡 B):`POST /publish/plan`。
   *
   * 「几号发一个什么」这件事**一张卡都不派** —— 落的是一条与「卡片内填」逐字同形的选题卡
   * (判据与落盘都在工作台那一处)。`date` 填 `YYYY-MM-DD` 或她的原话那一截(「20 号」「下周三」),
   * 算不出来 8791 会 400 + 回问一句,原样带回去问她。
   *
   * **老工作台没有这条路** → 404,如实说版本旧了(不许说记上了)。
   */
  publishPlan?: (input: {
    title: string
    date: string
    contentType?: '视频' | '图文'
    said?: string
  }) => Promise<ToolResult>
  /**
   * ★ **这一句 8791 怎么理解**(2026-10-13,卡「三个入口一套管线」):`POST /butler/understand`。
   *
   * **一个字都不办** —— 只回一份判定(认话的顺序与确认策略都在工作台那一处,
   * `workbench-plugin/src/server/understand.ts`)。电话里每一句转写先问它,`kind:'none'`
   * 或者问不到(**老工作台 404 / 连不上**)就照老路交给模型 —— 行为与这一版之前一字不差。
   */
  understandSaid: (input: {
    text: string
    /** 上一句刚派出去 / 刚开始的那件事(8791 据此认「补细节」)。 */
    open?: { itemId: string, said: string, atMs: number }
  }) => Promise<UnderstandOutcome>
  /**
   * ★ **照那份判定去办**(2026-10-13)。打的是 8791 指的那条路(`/butler/item` /
   * `/today/view` / `/asks/voice` / `/butler/item/say`),**工人不自己挑端口**。
   *
   * 回话里那一句:**真办成了**才念 `say.start`;没成就照 8791 那句原因说(D13)。
   */
  runUnderstanding: (input: {
    understanding: Understanding
    text: string
    /** 她点头之后那一次(`/butler/item` 带 `confirmed:true`)。 */
    confirmed?: boolean
  }) => Promise<UnderstoodResult>
  /**
   * **电话里当场落一个决定**(2026-09-21,座机主动来电)。走的是看板那条唯一的改状态路
   * (`POST /task/move`,七态转换表在服务端)—— 电话里说的和他在看板上拖的必须是同一件事。
   * 转换表不许的那一步,服务端回 409 + 一句人话,**原样说给他听**,不自己找条别的路绕过去。
   */
  decideItem: (itemId: string, decision: 'approve' | 'redo' | 'later') => Promise<ToolResult>
  /**
   * 「等你回答」那一通里他说的意思,原话交给工作台(`POST /asks/voice`,2026-09-25,卡 M)。
   * 工作台选中了哪个选项 / 交了原话 / 批没批,回一句给她据以回话;400 / 404 的那句人话原样带走。
   */
  answerAsk: (itemId: string, said: string) => Promise<ToolResult>
  /**
   * 来领这一拍要打的电话(`POST /call/claim`,只认回环)。领走即转「振铃中」。
   * 取不到**不抛**:8791 这会儿不在只是这一拍没活,下一拍再问。
   */
  claimCalls: () => Promise<readonly unknown[]>
  /**
   * **按房间领**(2026-10-21,局域网主路 M2):`POST /call/claim {room}`。同一通两间房都领得到;
   * `answered_elsewhere` 是这间房领过、已在别处接起的那几通。取不到回空的,不抛。卡 M6 两间房接这一条。
   */
  claimRoomCalls: (room: string) => Promise<RoomClaim>
  /** **先接先得**(2026-10-21):`POST /call/answered`。见 {@link AnsweredVerdict}。不抛。 */
  callAnswered: (input: { id: string, room: string, device_id?: string }) => Promise<AnsweredVerdict>
  /** 这一通怎么收场的(`POST /call/ack`)。回不去只记一行日志 —— 台账那边有一道超时兜底。 */
  /** `fail_kind`(2026-10-12):`failed` 是哪一种。工人取消那一通只报 `tech`,其余几种由工作台自己记。 */
  /** `room`(2026-10-21):按房间领的那一通带上自己那间房,一间房没接不落整通「未接」。 */
  ackCall: (input: { id: string, result: 'answered' | 'missed' | 'notified' | 'failed', error?: string, fail_kind?: 'tech', room?: string }) => Promise<boolean>
  /**
   * 事务官此刻是哪个音色(`GET /butler/status` → `voice`,2026-09-22)。
   *
   * 工人拿它盯着"人有没有在 Mac 上换音色":变了就往房里广播一条 `filler_voice_changed`,
   * 手机据此下次进房重取缓冲语那七句。**问不到回 undefined**(8792 没跑、这一拍超时),
   * 那时当没发生 —— 把"问不到"当成"换成了空"去广播,手机会按一个空名字建缓存。
   */
  butlerVoice: () => Promise<string | undefined>
  /**
   * 这台机器上的工作台是哪一版(`GET /update/check` 的 `current`,2026-09-23)。
   *
   * 「关于我自己」那段里那一行读的就是它(selfBrief.ts)。那条路**只认回环**
   * —— 工人正好在回环上;热更新没启用时是 404,取不到更新清单时它照样回得出 `current`。
   * **问不到回 undefined**,让她说「这一项我没拿到」,**不编一个版本号**。
   *
   * 带一道自己的超时:它会去更新服务器拉一次清单,而这一条排在「她开口」前面,
   * 不该为一行自我介绍让电话等着。
   */
  workbenchVersion: () => Promise<string | undefined>
  /**
   * 一通电话的记录(`POST /butler/call/record`,2026-09-23)。时长 + 双方字幕(+ 没建成的「要办」),
   * 2026-10-22 起 8791 落成一份**通话记录**、不建卡。带 `call_id` 时由 8791 并成一份:
   * 同一通只落一份,后到的那份更全就补字幕。
   *
   * 回 false = 没落下(8791 不在、`write_api` 没授权)。**不抛** ——
   * 纪要是一条记录,交不上去不该把挂断这件事搅黄。
   */
  recordCall: (input: {
    call_id?: string
    durationSeconds: number
    transcript: readonly { who: 'me' | 'butler', text: string }[]
    todos?: readonly { title: string, desc?: string, feature?: true }[]
  }) => Promise<boolean>
  /**
   * 房间代理:**以某台已配对设备的身份**调 8791 的任意一条路(白名单在 rpc.ts 里把过了)。
   * 回的是 `{ status, body }` 原样 —— 房里那头要的就是 8791 的真回答,包括 403 与 409。
   */
  callAsDevice: (input: {
    deviceId: string
    method: 'GET' | 'POST' | 'PUT' | 'DELETE'
    path: string
    body?: unknown
  }) => Promise<{ status: number, body: unknown }>
  /** 房间代理:替某台设备续一张进房凭证(2026-10-21 起连地址一起带回,见 {@link RenewedTicket})。 */
  renewTicket: (deviceId: string) => Promise<RenewedTicket | { error: string, status: number }>
  /**
   * 「我在这台机器上能找哪些目录」(2026-09-21)。**取不到一律当成「一个都不能找」** ——
   * 授权这件事上,连不上工作台不能等于放行。
   */
  searchRoots: (query?: string) => Promise<ChannelSearchRoots>
  /**
   * 替在外面的那台手机核一张取件单(2026-09-25,卡 J)。带降权头:单子必须是开给这台设备的。
   * **不抛**:连不上 / 单子不在都回 `{ ok:false, error }`,那句话原样转给手机。
   */
  fileOffer: (offerId: string, deviceId: string) => Promise<ChannelFileOffer>
  /** 把此刻在线的设备报给工作台,电脑端 `GET /devices/online` 看的就是这一份。**失败只记日志**。 */
  reportDevices: (devices: readonly unknown[]) => Promise<void>
  /** 报一条传输记录。同样**失败只记日志** —— 记不上不该让文件传不过去。 */
  reportTransfer: (record: unknown) => Promise<void>
  /**
   * ★ **电话里要的那个文件也登记进交付回执台账**(2026-10-04,卡 `claude/three-small-1004`)。
   *
   * 电话里 `wb_send_file` 那条从前不经事项、也不经台账:字节从一台设备直推到另一台,
   * 成没成只有这里知道 —— 于是「她在电话里要的文件没到」在看板上一个影子都没有。
   * 真传之前来登记一条,拿一个单号;传完报流水时把单号带回去(`TransferRecord.offer`),
   * 8791 按单号认出这是哪一件事的回执。
   *
   * **取不到单号就当没登记**(回 undefined):照旧把文件推过去,只是看板上少一张牌子 ——
   * 老工作台没有这个口,不能因为登记不上就不传文件。
   */
  phoneDelivery: (input: { name: string, toDevice: string, toName: string, said?: string }) => Promise<string | undefined>
  /**
   * 报一回合的计时(2026-09-23)。8791 留最近 20 条,`GET /channel/latency` 与体检页读它。
   * **失败连日志都不记**:它是一条量延迟的旁路,自己出声只会把真正的日志淹掉 ——
   * 报不上去的后果仅仅是体检页上少一行,而那一行在 channel-worker.log 里原样有一份。
   */
  reportLatency: (turn: unknown) => Promise<void>
  /**
   * 引导简报(2026-09-18,手机引导改通话模式):阶段、要弄清的、能写的 key 与值的形状、
   * 引导技能全文、这一阶段的种子句出过声没有。回 `{ status, body }` 原样 ——
   * 工作台没配记忆仓库时是 404,由调用方如实说一句,不猜一份阶段出来问人。
   */
  onboardingBrief: () => Promise<{ status: number, body: unknown }>
  /** 往阶段机交一项答案。**阶段机不变**:key 白名单、值校验、推进都在服务端。 */
  onboardingAnswer: (input: { stage: string, key: string, value: unknown, heard?: { asked: string, reply: string } }) => Promise<{ status: number, body: unknown }>
  /** 「这一阶段的种子句我已经念出去了」——落盘,于是挂断再进来不重说(开场白只说一次)。 */
  onboardingSeedSpoken: (stage: string) => Promise<{ status: number, body: unknown }>
  /**
   * 「引导归手机管了」(2026-09-18,Ben:「如果手机已经扫码,优先手机的引导流程」)。
   * 手机开始引导通话那一刻工人替它落这一笔 —— 电脑端的首次流程据此把第 ③ 屏换成**只读进度**,
   * 不再同时出输入框。**只改界面归属,不改任何权限**:两端共用同一份 onboarding.json。
   */
  onboardingLeader: (leader: 'phone' | 'desktop') => Promise<{ status: number, body: unknown }>
  /**
   * **真去扫一遍仓库**(2026-09-20,Ben:「授权扫仓库,但是没去扫」)。
   * 8791 那头认 `read_scan_roots` 授权:不是「可以」就回 403 带一句人话 ——
   * 那句话要原样说给他听,而不是变成「扫不到」。
   */
  /** 不带 name = 整个扫;带 name = 只找这一个(2026-09-23,不全量扫;只找到一个时回包顺带读好的摘要,2026-09-24)。 */
  onboardingScan: (name?: string) => Promise<{ status: number, body: unknown }>
  /**
   * **读一个项目的说明和最近的记录**(2026-09-24,已有项目拉齐)。`POST /onboarding/project-brief {path}`:
   * 回 `{ ok, name, path, brief, sources, note }`;门与找项目同一道(没授权 403 带「先问后看」的用法,
   * 新点子 / 运营那一支 403),路径只认找项目时回过的那种。回 `{ status, body }` 原样,由调用方翻成人话。
   */
  onboardingProjectBrief: (path: string) => Promise<{ status: number, body: unknown }>
  /**
   * **改一项已经答过的**(2026-09-20,Ben:「它说不能改,我当时一度想要停下」)。
   * 与 onboardingAnswer 的差别全在服务端:不看当前阶段、不推进阶段、必须先答过。
   */
  onboardingCorrect: (input: { stage: string, key: string, value: unknown }) => Promise<{ status: number, body: unknown }>
  /**
   * 「到那天还有几个工作日」(2026-09-20,Ben:「10 月 4 号,智能一点就该知道这是国庆」)。
   * 节假日表在工作台那边(holidays.ts),**这边一个日期都不自己算**。
   */
  onboardingWorkdays: (input: { to: string, from?: string }) => Promise<{ status: number, body: unknown }>
  /**
   * 引导落地(2026-09-24 晚):把单子摆上屏(`POST /onboarding/materialize/preview`)。回 `{ ok, id, line, … }`:
   * `line` 是电话里那一句(「都摆好了,两个项目、十件事……行吗?」)。老工作台 404。
   */
  onboardingMaterializePreview?: () => Promise<{ status: number, body: unknown }>
  /**
   * 他点头了,落(`POST /onboarding/materialize/apply`)。`skip` 是他说「那件不用」的那几件的说法;
   * `heard` 是他刚才那句(8791 据此判「听着没点头」就 409)。回 `{ ok, line, result }`。
   */
  onboardingMaterializeApply?: (input: { id?: string, skip?: readonly string[], heard?: { asked: string, reply: string } }) => Promise<{ status: number, body: unknown }>
}

/** 通话里念得出来的三列(与 rtcCall.ts 的 CONTEXT_STATUSES 同一口径:「待排」不进电话)。 */
const SPOKEN_STATUSES: readonly { status: string, label: string }[] = [
  { status: 'todo', label: '待办' },
  { status: 'doing', label: '在办' },
  { status: 'confirm', label: '等他确认' },
]

/** 一列最多念几条。 */
const SPOKEN_MAX = 5

/** /state 的 tasks 那一块 → 扁平的事项列表。读不懂就空数组,**绝不抛**。 */
export function boardItemsOf(state: unknown): readonly BoardItem[] {
  const tasks = (state as { tasks?: { tasks?: unknown } } | null)?.tasks?.tasks
  if (!Array.isArray(tasks)) return []
  const out: BoardItem[] = []
  for (const raw of tasks) {
    const item = (raw ?? {}) as { id?: unknown, title?: unknown, status?: unknown }
    if (typeof item.id !== 'string' || typeof item.title !== 'string') continue
    const dispatch = spokenDispatchOf(raw)
    out.push({ id: item.id, title: item.title, status: typeof item.status === 'string' ? item.status : '', ...(dispatch === undefined ? {} : { dispatch }) })
  }
  return out
}

/**
 * 事项列表 → 一段说给模型听的话。**带上 id** —— 第三件工具要拿 id 才能往那条会话里补话;
 * 人设里已经交代过「不要把 id 念出来」,所以这里给 id 是安全的,不给才会让那件工具没法用。
 */
export function spokenBoardSummary(items: readonly BoardItem[]): string {
  const lines: string[] = []
  for (const { status, label } of SPOKEN_STATUSES) {
    const matched = items.filter(item => item.status === status)
    if (matched.length === 0) {
      lines.push(`${label}:没有。`)
      continue
    }
    const shown = matched.slice(0, SPOKEN_MAX)
    const rest = matched.length - shown.length
    const body = shown.map(item => `${item.title}(id ${item.id}${item.dispatch === undefined ? '' : `;${item.dispatch}`})`).join('、')
    lines.push(`${label}:${body}${rest > 0 ? `,另外还有 ${rest} 条` : ''}。`)
  }
  return lines.join('\n')
}

/**
 * 各家客户端里的会话(2026-09-23 16:30,维护者真机:「Claude 和 Codex 两个客户端都在跑任务,
 * 事务官咬死说没有」)。看板事项与客户端会话是**两份表**:事项在 `/state.tasks`,
 * 客户端(Claude / Codex / DSH / Kimi)经 hook 报上来的会话在 `/state.sessions`。
 * 以前只念前一份,于是他问「有几个 agent 在跑」她答「一个都没有」。
 */
export interface AgentSession {
  agent: string
  status: string
  title: string
  project: string
  /** 距上一次动静多少秒(`last_output_sec`);读不到就 undefined。 */
  quietSec?: number
}

/**
 * 事务官自己那条会话念给他听叫什么。**它不是「一家」**(候选池里没有 `dsh` ——
 * 他不会在电话里点名「事务官」去捎话),所以不进家名那一池,只在这里一行。
 */
const SELF_AGENT_NAME = '事务官本体'

/** `/state.sessions` → 在跑 / 等他回话的那几条。读不懂就空数组,**绝不抛**。 */
export function agentSessionsOf(state: unknown): readonly AgentSession[] {
  const raw = (state as { sessions?: unknown } | null)?.sessions
  if (!Array.isArray(raw)) return []
  const out: AgentSession[] = []
  for (const one of raw) {
    const s = (one ?? {}) as Record<string, unknown>
    const status = typeof s.status === 'string' ? s.status : ''
    if (status !== 'running' && status !== 'waiting') continue
    const quiet = typeof s.last_output_sec === 'number' && Number.isFinite(s.last_output_sec) ? s.last_output_sec : undefined
    out.push({
      agent: typeof s.agent === 'string' ? s.agent : '?',
      status,
      title: typeof s.title === 'string' ? s.title.trim() : '',
      project: typeof s.project === 'string' ? s.project : '',
      ...(quiet === undefined ? {} : { quietSec: quiet }),
    })
  }
  return out
}

/** 超过这么久没动静的「在跑」,如实说「很久没动静了,可能已经停了」—— 客户端没报结束时它会一直挂着。 */
const QUIET_SUSPECT_SEC = 30 * 60

/** 客户端会话 → 一段说给模型听的话。**没有就明说没有**,不让她拿事项表顶替。 */
export function spokenAgentSessions(sessions: readonly AgentSession[]): string {
  if (sessions.length === 0) return '各客户端(Claude / Codex 等)里:没有在跑的会话。'
  const lines = sessions.slice(0, SPOKEN_MAX).map((s) => {
    /*
     * ★ 2026-10-03(卡「两条接缝」):从前这里是第四份写死的家名表(claude / codex / dsh / kimi
     * 四家),于是豆包 / Muse / Manus 的会话在电话里被念成家名本身。现在问同一池
     * (`familyTitle` —— 主人下发的那一份;拉不到就兜底那一份),认不出的原样念。
     */
    const who = s.agent === 'dsh' ? SELF_AGENT_NAME : familyTitle(s.agent)
    const what = s.title !== '' ? `「${s.title}」` : (s.project !== '' ? `${s.project} 里一条没起标题的` : '一条没起标题的')
    const state = s.status === 'waiting' ? '在等他回话' : '在跑'
    const quiet = s.quietSec !== undefined && s.quietSec >= QUIET_SUSPECT_SEC
      ? `(已经 ${Math.round(s.quietSec / 60)} 分钟没动静,可能其实停了)`
      : ''
    return `${who}:${what},${state}${quiet}`
  })
  const rest = sessions.length - lines.length
  return `各客户端里的会话(这是 agent 在干的活,和看板事项是两回事):\n${lines.join('\n')}${rest > 0 ? `\n另外还有 ${rest} 条。` : ''}`
}

export interface WorkbenchClientDeps {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** 房里显示的名字(可选)。2026-09-21 起这里填的是**设备名**,「发到…」的选单里他看见的就是它。 */
  workerName?: string
  /**
   * 第二台电脑用的身份后缀(2026-09-21)。
   *
   * 第一台电脑上的工人身份固定是 `wb-channel-worker` —— 手机只认这个字符串,**不能动**。
   * 同一个房间里再进一台电脑时,它得有个不一样的身份,于是 `wb-channel-worker-<后缀>`。
   * 后缀由 8791 清洗,这里只是原样带过去。
   */
  workerSuffix?: string
  /**
   * 这条工人要进哪条路线的房(2026-10-21,卡 M6 两间房):第二条工人进云房间时给 `relay`,取票时原样交给 8791。
   * 不给 = 8791 照老规矩(本机有钥匙签本机房间,没有就中转)。
   */
  workerRoute?: ChannelRoute
  /**
   * 这台机器上**工人自己那把进程令牌**(2026-09-28,卡 BS)。8791 靠它认出
   * 「这一条是电话工人转的、算她本人」—— 她在电话里亲口说的那一句(`/asks/voice`)要过那道门。
   *
   * 令牌由 8791 开机时现生,**只放进工人的 spawn env**(`WORKBENCH_WORKER_ACTOR`),
   * 不进 8791 自己的 env,所以事务官在自己的 env 里读不到它。没拿到就不带这条头:
   * 那几个口会回 403 并说清「只有你本人能答」,**不假装答上了**(D13)。
   */
  actorToken?: string
  /** 测试注入钟(电话里同一句话的请求号按它算那一阵,见 {@link CALL_REPEAT_WINDOW_MS})。 */
  now?: () => number
}

/**
 * 电话里同一句话、同一件事,这么久之内再调一次算**同一次**(2026-10-12,卡「手机交代只执行一次」)。
 * 模型重试、把一句话当成两轮各调一次,都在几秒之内;两分钟之后她再说同一句,当她真要再办一次。
 */
export const CALL_REPEAT_WINDOW_MS = 2 * 60_000

function randomKey(): string {
  try {
    const uuid: string | undefined = globalThis.crypto?.randomUUID?.()
    if (typeof uuid === 'string' && uuid.length > 0) return `call-${uuid}`
  }
  catch { /* 没有就退回下面那个 */ }
  return `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createWorkbenchClient(deps: WorkbenchClientDeps): WorkbenchClient {
  const doFetch = deps.fetchImpl ?? fetch
  const base = deps.baseUrl.replace(/\/+$/, '')
  const now = deps.now ?? (() => Date.now())
  /**
   * 「这一件 · 这一句」→ 上一次用的请求号(2026-10-12)。8791 按 `client_key` 只办一次、回第一次那份
   * (workbench-plugin/src/server/clientKeys.ts),所以同一句在 {@link CALL_REPEAT_WINDOW_MS} 之内再调,带回同一个号。
   */
  const repeatKeys = new Map<string, { key: string, at: number }>()
  /**
   * 这条工人此刻在哪条路线的房里(2026-10-21):上一次取票 8791 回的那个。替房里的设备转请求、续期时报上
   * ({@link CHANNEL_ROUTE_HEADER}),8791 才签得出同一间房的票。还没取过 / 老 8791 不回 = 不报。
   */
  let myRoute: ChannelRoute | undefined
  const routeHeader = (): Record<string, string> => (myRoute === undefined ? {} : { [CHANNEL_ROUTE_HEADER]: myRoute })
  function repeatKeyOf(what: string): string {
    const at = now()
    for (const [one, seen] of repeatKeys) if (at - seen.at > CALL_REPEAT_WINDOW_MS) repeatKeys.delete(one)
    const seen = repeatKeys.get(what)
    if (seen !== undefined) return seen.key
    const key = randomKey()
    repeatKeys.set(what, { key, at })
    return key
  }

  /**
   * 工人那把令牌挂在每一条请求上(2026-09-28,卡 BS)。挂在这一层而不是逐个调用点:
   * 「所有请求都带身份」于是是**构造上**成立的,不靠每个调用点自己记得。
   * 没有令牌就一条头都不加(形状与从前逐字一样)。
   */
  function withActor(init?: RequestInit): RequestInit | undefined {
    if (deps.actorToken === undefined || deps.actorToken === '') return init
    return { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), [ACTOR_TOKEN_HEADER]: deps.actorToken } }
  }

  async function json(path: string, init?: RequestInit): Promise<{ status: number, body: unknown }> {
    const res = await doFetch(`${base}${path}`, withActor(init))
    const raw = await res.text()
    let body: unknown = {}
    try { body = raw === '' ? {} : JSON.parse(raw) }
    catch { body = { error: '回包不是 JSON' } }
    return { status: res.status, body }
  }

  /**
   * 这件事是不是「派给某家 AI、上一次没派成」(重做时要真的再派一次,见 `decideItem`)。
   * 只认三样:负责人是某家 AI(不是事务官、不是人)、窗口派活那条记录 `failed` / `typed`,或命令行那条 `failed`。
   * 看板读不到就 undefined —— 不猜,照旧挪。
   */
  async function failedDispatchOf(id: string): Promise<{ family: string } | undefined> {
    let state: { status: number, body: unknown }
    try { state = await json('/state') }
    catch { return undefined }
    if (state.status !== 200) return undefined
    const tasks = (state.body as { tasks?: { tasks?: unknown } } | null)?.tasks?.tasks
    if (!Array.isArray(tasks)) return undefined
    const task = tasks.find(one => (one as { id?: unknown } | null)?.id === id) as {
      assignee?: unknown
      client_dispatch?: { status?: unknown, family?: unknown }
      dispatch?: { status?: unknown, family?: unknown }
    } | undefined
    if (task === undefined || typeof task.assignee !== 'string') return undefined
    if (task.assignee === 'dsh') return undefined
    const windowFailed = task.client_dispatch?.status === 'failed' || task.client_dispatch?.status === 'typed'
    const cliFailed = task.dispatch?.status === 'failed'
    return windowFailed || cliFailed ? { family: task.assignee } : undefined
  }

  /** 8791 的错误一律是 `{ error: '一句人话' }`;取不到就给一句能照着做的兜底。 */
  function errorOf(body: unknown, fallback: string): string {
    const message = (body as { error?: unknown } | null)?.error
    return typeof message === 'string' && message !== '' ? message : fallback
  }

  /** 会前那两条的同一套回话(2026-10-10):工作台那一句 note 原样念,别添。 */
  const meetingCall = async (path: string, body: Record<string, unknown>): Promise<ToolResult> => {
    let result: { status: number, body: unknown }
    try {
      result = await json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    }
    catch {
      return { ok: false, text: '工作台连不上,这场会没记上。如实告诉她。' }
    }
    if (result.status === 404) return { ok: false, text: '电脑上的工作台这一版还不会登记会议。如实告诉她,让她在电脑或手机上记一句。' }
    if (result.status === 403) return { ok: false, text: `没记上:${errorOf(result.body, '工作台不让写')}\n${writeApiHint()}` }
    if (result.status !== 200) return { ok: false, text: `没记上:${errorOf(result.body, '工作台拒绝了')}。照这句如实说。` }
    const note = (result.body as { note?: unknown } | null)?.note
    const line = typeof note === 'string' && note.trim() !== '' ? note.trim() : '记下了。'
    return { ok: true, text: `${line}\n照这句说;里面有一问就问她那一问,她答了用「答会前那一问」那件工具交上去。别替她答,别猜;要她去问组织者的那句话只念给她听,不要替她发给任何人。` }
  }

  return {
    async hubExecute(input) {
      let result: { status: number, body: unknown }
      try {
        result = await json('/butler/hub/execute', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            entrance: 'call',
            said: input.said,
            ...(input.confirmed === undefined ? { commands: input.commands ?? [] } : { confirmed: input.confirmed }),
          }),
        })
      }
      catch {
        return { ok: false, why: '工作台连不上', unreachable: true }
      }
      if (result.status === 404) return { ok: false, why: '电脑上的工作台这一版还没有理解中枢的执行口', old: true, status: 404 }
      const reply = result.body as Partial<HubExecuteReply> | null
      if (result.status !== 200 || typeof reply?.say?.spoken !== 'string' || !Array.isArray(reply.results)) {
        return { ok: false, why: errorOf(result.body, '工作台没办'), status: result.status }
      }
      return { ok: true, reply: reply as HubExecuteReply }
    },
    async hubContext(input, transport) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), transport?.timeoutMs ?? 1500)
      try {
        const { status, body } = await json(`/butler/hub/context?entrance=${input.entrance}&said=${encodeURIComponent(input.said.slice(0, 500))}`, { signal: controller.signal })
        const text = (body as { text?: unknown } | null)?.text
        return status === 200 && typeof text === 'string' && text !== '' ? { ok: true as const, text } : { ok: false as const }
      }
      catch { return { ok: false as const } }
      finally { clearTimeout(timer) }
    },
    async sayTurn(input, transport) {
      const result = await postSayTurn({
        baseUrl: base,
        text: input.text,
        ...(input.ctx === undefined ? {} : { ctx: input.ctx }),
        clientKey: input.clientKey ?? repeatKeyOf(`say:${input.text}`),
        ...(transport?.timeoutMs === undefined ? {} : { timeoutMs: transport.timeoutMs }),
        ...(transport?.signal === undefined ? {} : { signal: transport.signal }),
        headers: { ...routeHeader(), ...(deps.actorToken ? { [ACTOR_TOKEN_HEADER]: deps.actorToken } : {}) },
        fetchImpl: doFetch,
      })
      return result.kind === 'reply'
        ? { ok: true as const, reply: result.reply }
        : { ok: false as const, why: result.reason, ...(result.timedOut ? { timedOut: true } : {}), ...(result.outcomeUncertain ? { outcomeUncertain: true } : {}) }
    },
    async ticket() {
      const { status, body } = await json('/channel/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          worker: true,
          ...(deps.workerName === undefined ? {} : { name: deps.workerName }),
          ...(deps.workerSuffix === undefined || deps.workerSuffix === '' ? {} : { suffix: deps.workerSuffix }),
          ...(deps.workerRoute === undefined ? {} : { route: deps.workerRoute }),
        }),
      })
      if (status !== 200) throw new Error(`取进房凭证失败(${status}):${errorOf(body, '工作台没说原因')}`)
      const ticket = body as Partial<ChannelTicket>
      if (typeof ticket.url !== 'string' || typeof ticket.token !== 'string' || typeof ticket.room !== 'string') {
        throw new Error('进房凭证的形状不对:缺 url / room / token')
      }
      myRoute = channelRouteOf(ticket.route)
      const { route: _raw, ...rest } = ticket as ChannelTicket
      return { ...rest, ...(myRoute === undefined ? {} : { route: myRoute }) }
    },

    async credentials() {
      let result: { status: number, body: unknown }
      try { result = await json('/channel/credentials') }
      catch {
        // 8791 这会儿不在(工作台刚重启)。**不抛** —— 下一轮进房时会再问一次。
        return { source: 'none', note: '这会儿问不到工作台要通道凭据。' }
      }
      if (result.status === 404) {
        // 老版本的工作台没有这条路。退回老办法,并且说清楚是这一种「没有」。
        return { source: 'none', note: '这份工作台还没有「通道凭据」这条接口(是旧版),按本机配置走。' }
      }
      if (result.status !== 200) {
        return { source: 'none', note: errorOf(result.body, `工作台没能给出通道凭据(${result.status})`) }
      }
      const body = (result.body ?? {}) as Partial<ChannelCredentials>
      const source = body.source === 'server' || body.source === 'local' ? body.source : 'none'
      return {
        source,
        ...(body.volc_asr === undefined ? {} : { volc_asr: body.volc_asr }),
        ...(body.volc_tts === undefined ? {} : { volc_tts: body.volc_tts }),
        ...(typeof body.expires_at === 'string' ? { expires_at: body.expires_at } : {}),
        ...(typeof body.note === 'string' && body.note !== '' ? { note: body.note } : {}),
      }
    },

    /**
     * ★ **认家名那一池,从主人那里拉**(2026-10-03,卡「两条接缝」)。
     * 三种「没拉到」各说清是哪一种,**都不抛**(这一轮退回兜底那份,电话照旧接得起来)。
     */
    async families() {
      let result: { status: number, body: unknown }
      try { result = await json('/families') }
      catch { return { ok: false, note: '这会儿连不上工作台,问不到这台电脑上认得出哪几家。' } }
      if (result.status === 404) return { ok: false, note: '这份工作台还没有「有哪几家」这条接口(是旧版)。' }
      if (result.status !== 200) return { ok: false, note: errorOf(result.body, `工作台没能给出有哪几家(${result.status})`) }
      const raw = (result.body as { families?: unknown } | null)?.families
      if (!Array.isArray(raw)) return { ok: false, note: '工作台回的「有哪几家」形状不对(缺 families)。' }
      // 形状容错在 `setFamilyPool` 那一处(一行坏了不许清空整池),这里只把数组原样带过去。
      return { ok: true, families: raw as readonly SpokenFamilyRow[] }
    },

    async searchRoots(query) {
      let result: { status: number, body: unknown }
      const q = typeof query === 'string' && query.trim() !== '' ? `?q=${encodeURIComponent(query.trim())}` : ''
      try { result = await json(`/channel/search-roots${q}`) }
      catch { return { allowed: false, roots: [], note: '这会儿连不上工作台,问不到能找哪些目录。' } }
      if (result.status === 404) {
        return { allowed: false, roots: [], note: '这份工作台还没有「找文件」这条接口(是旧版)。' }
      }
      if (result.status !== 200) {
        return { allowed: false, roots: [], note: errorOf(result.body, `工作台没给出可找的目录(${result.status})`) }
      }
      const body = (result.body ?? {}) as { allowed?: unknown, roots?: unknown, note?: unknown }
      const roots: { path: string, label?: string, depth?: number }[] = []
      if (Array.isArray(body.roots)) {
        for (const item of body.roots) {
          const raw = (item ?? {}) as { path?: unknown, label?: unknown, depth?: unknown }
          if (typeof raw.path !== 'string' || raw.path === '') continue
          roots.push({
            path: raw.path,
            ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
            ...(typeof raw.depth === 'number' ? { depth: raw.depth } : {}),
          })
        }
      }
      const rawFocus = (body as { focus?: unknown }).focus as { name?: unknown, path?: unknown, terms?: unknown } | undefined
      const focus = rawFocus !== undefined && typeof rawFocus.path === 'string' && rawFocus.path !== '' && typeof rawFocus.name === 'string'
        ? {
            name: rawFocus.name,
            path: rawFocus.path,
            terms: Array.isArray(rawFocus.terms) ? rawFocus.terms.filter((term): term is string => typeof term === 'string') : [],
          }
        : undefined
      return {
        allowed: body.allowed === true,
        roots,
        ...(typeof body.note === 'string' && body.note !== '' ? { note: body.note } : {}),
        ...(focus === undefined ? {} : { focus }),
      }
    },

    async fileOffer(offerId, deviceId) {
      let result: { status: number, body: unknown }
      try {
        result = await json(`/channel/file-offer/${encodeURIComponent(offerId)}`, {
          headers: { [CHANNEL_DEVICE_HEADER]: deviceId },
        })
      }
      catch { return { ok: false, error: '工作台这会儿连不上,取不了这个文件' } }
      if (result.status === 404 && errorOf(result.body, '') === '') {
        return { ok: false, error: '电脑上的工作台还没有「取文件」这条接口(要升级一下)' }
      }
      if (result.status !== 200) return { ok: false, error: errorOf(result.body, `工作台没给这个文件(${result.status})`) }
      const body = (result.body ?? {}) as { path?: unknown, name?: unknown, bytes?: unknown, where?: unknown }
      if (typeof body.path !== 'string' || typeof body.name !== 'string') return { ok: false, error: '工作台回的取件单形状不对' }
      return {
        ok: true,
        path: body.path,
        name: body.name,
        bytes: typeof body.bytes === 'number' ? body.bytes : 0,
        ...(typeof body.where === 'string' ? { where: body.where } : {}),
      }
    },

    async phoneDelivery(input) {
      try {
        const result = await json('/files/phone-delivery', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: input.name,
            to_device: input.toDevice,
            to_name: input.toName,
            ...(input.said === undefined || input.said === '' ? {} : { said: input.said }),
          }),
        })
        if (result.status !== 200) return undefined
        const body = (result.body ?? {}) as { offer?: unknown }
        return typeof body.offer === 'string' && body.offer !== '' ? body.offer : undefined
      }
      catch { return undefined }
    },

    async reportDevices(devices) {
      try {
        await json('/channel/devices', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // 两条工人各在一间房(卡 M6):带上自己那条路线,8791 两份分开记、合起来给。
          body: JSON.stringify({ devices, ...(myRoute === undefined ? {} : { route: myRoute }) }),
        })
      }
      catch { /* 报不上去只是电脑端那张表旧一点,不该把房间带走 */ }
    },

    async reportTransfer(record) {
      try {
        await json('/channel/transfer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ record }),
        })
      }
      catch { /* 同上 */ }
    },

    async reportLatency(turn) {
      try {
        await json('/channel/latency', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turn }),
        })
      }
      catch { /* 见接口上那一段:这一条报不上去,日志里那一行还在 */ }
    },

    async persona() {
      const { status, body } = await json('/channel/persona')
      if (status !== 200) throw new Error(`取人设失败(${status}):${errorOf(body, '工作台没说原因')}`)
      const persona = body as Partial<ChannelPersona>
      if (typeof persona.system_message !== 'string' || typeof persona.welcome !== 'string') {
        throw new Error('人设的形状不对:缺 system_message / welcome')
      }
      // 称呼表(2026-09-23)。老工作台没有这一格 —— 那就缺席,工人用缺省的两个,
      // **不因为少一个字段把整份人设判废**。
      const addresses = Array.isArray((persona as { addresses?: unknown }).addresses)
        ? ((persona as { addresses: unknown[] }).addresses)
            .filter((one): one is string => typeof one === 'string' && one.trim() !== '')
        : undefined
      // 每轮最多几句(卡 K):1–5 之间的整数才认,别的当没有(不掐)。
      const cap = (persona as { max_sentences?: unknown }).max_sentences
      // 热词(2026-10-02):字符串、两个字以上才认。老工作台没有这一格就缺席 = 不带热词。
      const hotwords = Array.isArray((persona as { hotwords?: unknown }).hotwords)
        ? ((persona as { hotwords: unknown[] }).hotwords)
            .filter((one): one is string => typeof one === 'string' && [...one.trim()].length >= 2)
            .map(one => one.trim())
        : undefined
      /**
       * 分段人设(2026-10-03,卡「人设按意图裁」)。**拼回去对不上整份就整格扔掉** ——
       * 裁出来的那一份要替掉上下文里整份人设那一段,对不上的话裁的就不是同一份东西了。
       * 老工作台没有这一格就缺席 = 每回合整份,和这一版之前一字不差。
       */
      const sections = personaSectionsOf(
        (persona as { persona_sections?: unknown }).persona_sections,
        persona.system_message,
      )
      const { max_sentences: _raw, hotwords: _words, persona_sections: _parts, ...rest } = persona as ChannelPersona
      return {
        ...rest,
        ...(addresses === undefined || addresses.length === 0 ? {} : { addresses }),
        ...(typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 && cap <= 5 ? { max_sentences: cap } : {}),
        ...(hotwords === undefined || hotwords.length === 0 ? {} : { hotwords }),
        ...(sections === undefined ? {} : { persona_sections: sections }),
      }
    },

    async rememberItem(text, assignee) {
      const trimmed = text.trim()
      if (trimmed === '') return { ok: false, text: '他这句话是空的,没记。' }
      let result: { status: number, body: unknown }
      try {
        result = await json('/butler/item', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // assignee 只在**他点了名**的时候带上。带一个 undefined 上去会在 JSON 里变成缺席,
          // 行为一样,但显式地不发更省事:8791 那边据此分得清"没点名"与"点了名但认不出"。
          // `source:'call'`(2026-09-24,卡 F):这句话已经在电话里过了确认点那道门,
          // 点了名的活工作台直接派,不再在手机首页挂一条「要你批」。老工作台不认这一格,照旧。
          // `client_key`(2026-10-12):同一句同一家两分钟内再调,电脑只建一张卡。
          body: JSON.stringify({ text: trimmed, source: 'call', ...(assignee === undefined ? {} : { assignee }), client_key: repeatKeyOf(`item ${assignee ?? ''} ${trimmed}`) }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,这件事没记下来。如实告诉他。', unreachable: true }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没记上:${errorOf(result.body, '工作台拒绝了')}。如实告诉他。` }
      }
      const created = result.body as { id?: unknown, note?: unknown, assignee?: unknown, dispatch_note?: unknown, dispatch_ok?: unknown, feedback?: unknown, publish_plan?: unknown }
      /**
       * **她在排一条发布计划**(2026-10-13,卡「座机一句话记发布计划」):工作台已经把它记进日历上那一格了,
       * 回执里带着 `publish_plan` 与那一句话。**照那一句说** —— 这一档没有人在办、也没派给谁,
       * 下面那几句(「我这就去办」「人还没派上」)说出来都是假的。老工作台不带这一格 → 照旧走下面(行为一字不变)。
       */
      if (created.publish_plan !== undefined && typeof created.note === 'string' && created.note !== '') {
        return { ok: true, text: `${created.note}\n**照这一句说**,别添别的:这一条是记进发布计划(她的日历上那一格),没有人在办,也没派给谁。别说「我去办」「派出去了」,也别念「看板」「卡」「事项」。` }
      }
      /**
       * **本体的毛病**(2026-09-28,卡 FB):他说的是工作台自己哪儿不对 —— 工作台**一张卡都没建、
       * 一家都没派**,回执里带着那条反馈(`feedback`)与事务官那一句(`note`)。
       *
       * 这一档绝不能走下面那几句:它们都以「记下了,事项 id …」开头,而这会儿既没有 id,
       * 也没有人在办(说成"事务官还没开始办"是假话)。照工作台那一句说,一个字都不要添。
       */
      if (created.feedback !== undefined) {
        const line = typeof created.note === 'string' && created.note !== '' ? created.note : '这是工作台本身的问题,我反馈给开发者了。'
        return { ok: true, text: `${line}\n**照这一句说**。这是工作台本身的毛病:没建卡,也没派任何一家去改(工作台本体不由他的 Agent 改,我们修好随更新给他)。这句里没有的别添,别说「记下了」「事项 id」「我派出去了」。` }
      }
      const id = typeof created.id === 'string' ? created.id : '?'
      /**
       * 点了名的活**由工作台直接派**(2026-09-24,卡 F):回执里多一句 `dispatch_note`
       * (「正在派给 Codex……做完我把结果收回来」)。有它就照它说 —— 这时候没有开事务官会话,
       * 不能说「交给事务官去办了」。
       */
      if (typeof created.dispatch_note === 'string' && created.dispatch_note !== '') {
        /*
         * ★ **派没派出去以 `dispatch_ok` 为准**(2026-09-28,卡 CF)。
         *
         * 09-28 那两通:这里不管成没成都回一句「可以跟他说『派出去了』」,于是她说了「派出去了,豆包在查」,
         * 十几秒后又「插一句:没成」。工作台现在在**开口之前**就同步判过一次(这台电脑上有没有这一家),
         * 派不出去时回 `dispatch_ok:false` + 一句原因 —— 那就当场说那一句,一个字都不要说成派出去了。
         * 老工作台不带这一格(缺席)→ 照旧(那时它只在真派了的时候才给 `dispatch_note`)。
         */
        /*
         * ★ 2026-10-01(卡「派给读不到的那家当场说」):末一句原来写着「……或者你自己办」。
         * 维护者 09-28 已经拍板**事务官自己不干活**,而 10-01 那一通正是这么出事的:
         * 「让 Kimi 查一下国庆放假多少天」派不出去(读不到它的窗口),于是事务官自己跑了 8 分钟命令、
         * 撞上步数上限,那件事一直没动。所以这里只留一条路:**照那句原话说,问他换哪一家**。
         */
        if (created.dispatch_ok === false) {
          return { ok: false, text: `没派出去:${created.dispatch_note}。**当场把这一句如实说给他**,别说「派出去了」、别说「在办」;那句话里已经写着能派的是哪几家,照它问他换哪一家。**不要自己去办这件事**,也别自己想别的办法。` }
        }
        /*
         * ★ 2026-09-30 维护者拍板:**派活成功不回电话** —— 那就不能再许诺「结果回来我告诉你」。
         * 卡上(看板与手机)有一格写着它收没收到;失败与捎话回话才打电话。
         */
        return { ok: true, text: `记下了,事项 id ${id}。${created.dispatch_note}。可以说一句「派出去了」就收;**别念「看板」「卡」「事项」这些词**,别许诺结果回来给他打电话,也别说做完了。` }
      }
      // 会话开不出来时事项照建、如实标「会话未开」——这时候**不能**说「我让事务官去办」。
      const note = typeof created.note === 'string' ? created.note : undefined
      /**
       * 派给别家那一句(2026-09-21)。**以工作台回执里的 assignee 为准**,不以我们发上去的为准:
       * 他点名的那家可能在那台电脑上根本没有命令行,工作台会把这件事如实退回来 ——
       * 这时候电话里绝不能说「已经让 Codex 去做了」。
       */
      const who = typeof created.assignee === 'string' && created.assignee !== 'dsh' ? created.assignee : undefined
      const handoff = who === undefined ? '' : `这条点名要 ${who} 做,你这就去派;那边要是没有命令行,你再回来问她。`
      return note === undefined
        // 2026-10-02:**第一人称**。以前这一句教的是「我让事务官去办」—— 当着她的面把自己说成第三个人。
        ? { ok: true, text: `记下了,事项 id ${id},我这就去办。${handoff}跟她说一句「我去办,办完告诉你」就够 —— **别说「我让事务官去办」、别念「会话」「卡」「看板」**。` }
        : { ok: true, text: `记下了,事项 id ${id},但是${note}——还没动手。跟她说事情记下了、人还没派上,一句收。` }
    },

    async listDoing() {
      let result: { status: number, body: unknown }
      try { result = await json('/state') }
      catch { return { ok: false, text: '工作台连不上,查不到他手上的事。别凭印象说,告诉他查不到。' } }
      if (result.status !== 200) {
        return { ok: false, text: `查不到:${errorOf(result.body, '工作台拒绝了')}。别凭印象说。` }
      }
      return {
        ok: true,
        text: `看板事项:\n${spokenBoardSummary(boardItemsOf(result.body))}\n${spokenAgentSessions(agentSessionsOf(result.body))}`,
      }
    },

    async planMeeting(text) {
      const said = text.trim()
      if (said === '') return { ok: false, text: '没听清是哪场会。问她一句什么时候、跟谁、谈什么。' }
      return await meetingCall('/meeting/plan', { text: said })
    },

    async answerMeeting(answer) {
      const said = answer.trim()
      if (said === '') return { ok: false, text: '没听清她的回答,再问一遍那一问。' }
      return await meetingCall('/meeting/answer', { answer: said })
    },

    async askProgress(text) {
      const said = text.trim()
      if (said === '') return { ok: false, text: '没听清问的是哪一件。问他一句是哪件事,别猜。' }
      let result: { status: number, body: unknown }
      try {
        result = await json('/progress/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: said }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,查不到这件事到哪了。如实告诉他,别凭印象说。' }
      }
      if (result.status === 404) {
        return { ok: false, text: '电脑上的工作台这一版还不会核进度。别凭印象说,告诉他这件要到电脑上看。' }
      }
      if (result.status === 403) {
        return { ok: false, text: `没查到:${errorOf(result.body, '工作台不让查')}\n${writeApiHint()}` }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没查到:${errorOf(result.body, '工作台拒绝了')}。别凭印象说。` }
      }
      const body = result.body as { ok?: unknown, line?: unknown }
      const line = typeof body.line === 'string' ? body.line.trim() : ''
      if (body.ok !== true || line === '') {
        return { ok: false, text: `${line === '' ? '看板上没认出是哪一件' : line}。问他是哪一件,别猜一个。` }
      }
      return { ok: true, text: `${line}\n照这句说(依据和几点看的也说一下);这句里没有的别添,说还没看到进展就请他说一句。` }
    },

    async handToButler(itemId, text) {
      const id = itemId.trim()
      const say = text.trim()
      if (id === '' || say === '') return { ok: false, text: '缺事项 id 或者要说的话,没送出去。' }
      let result: { status: number, body: unknown }
      try {
        result = await json('/butler/item/say', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, text: say, client_key: repeatKeyOf(`say ${id} ${say}`) }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,这句话没送到事务官那儿。如实告诉他。' }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没送到:${errorOf(result.body, '工作台拒绝了')}。如实告诉他。` }
      }
      return { ok: true, text: '送到了。可以跟他说「我跟事务官说了,办完告诉你」。' }
    },

    async relayToSession(input) {
      const who = input.who.trim()
      const say = input.text.trim()
      if (who === '') return { ok: false, text: '没说清捎给哪一条会话。问他一句是哪一条,别猜一条送进去。' }
      if (say === '') return { ok: false, text: '要捎的话是空的,没送。问他一句要捎什么。' }
      let result: { status: number, body: unknown }
      try {
        result = await json('/sessions/relay', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // `from:'call'`(2026-09-27,卡 CB):这一句是**电话里**让捎的。回电话转述回话时
          // 那一句人话会说「你电话里让我捎的那句话」——他才对得上是哪一次。
          // `interrupt`(2026-09-28,卡 WR):先按那家的停止键再送 —— 只有他明说要打断才有这一格。
          // `call_on_reply`(2026-10-04,卡 `claude/relay-call-optin` → `claude/relay-nocall-noread`):
          // **只有她明说「回了打给我」才有** —— 缺席 = 工作台那头**不登记、不盯、不读**,
          // 它回的那句就留在那条会话里(她在手机「各家对话」里看得到)。
          body: JSON.stringify({ who, text: say, from: 'call', ...(input.interrupt === true ? { interrupt: true } : {}), ...(input.overwrite === true ? { overwrite: true } : {}), ...(input.newConversation === true ? { new_conversation: true } : {}), ...(input.watchOnly === true ? { watch_only: true } : {}), ...(input.callOnReply === true ? { call_on_reply: true } : {}), client_key: repeatKeyOf(`relay ${who} ${input.watchOnly === true ? 'watch' : 'send'} ${say}`) }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,这句话没捎进去。如实告诉他。' }
      }
      if (result.status === 404) {
        return { ok: false, text: '电脑上的工作台这一版还不会往会话里捎话。如实告诉他这一句没捎到,别说成送到了。' }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没捎到:${errorOf(result.body, '工作台拒绝了')}。如实告诉他。` }
      }
      const body = result.body as { ok?: unknown, note?: unknown, where?: unknown }
      const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : ''
      if (body.ok === true) {
        // 回电那条路(卡 CB)在工作台那头:它回了 / 等太久了都会排一通电话。
        // 这里**照着工作台那句话说**(它自己会带上「它回了我打电话告诉你」),不自己编一句承诺。
        return { ok: true, text: `${note === '' ? '捎到了。' : note}\n照这句说,别多加别的。` }
      }
      // 几条都对得上:把候选念给他选(工作台已经拼好那一句),**不许自己挑一条**。
      if (body.where === 'pick') {
        return { ok: false, text: `${note}\n照这句念给他听、问他是哪一条;他说了哪一条再调一次(who 填他说的那一句)。别自己挑一条送。` }
      }
      return { ok: false, text: `${note === '' ? '这句话没捎进去。' : note}\n照这句如实说,别说成送到了。` }
    },

    async lookupSession(who) {
      const asked = who.trim()
      if (asked === '') return { ok: false, text: '没说清要看哪一家、哪一条对话。问他一句,别猜一条。' }
      let result: { status: number, body: unknown }
      try {
        result = await json(`/sessions/lookup?who=${encodeURIComponent(asked)}`)
      }
      catch {
        return { ok: false, text: '工作台连不上,这会儿看不到它什么状态。如实告诉他。' }
      }
      if (result.status === 404) {
        return { ok: false, text: '电脑上的工作台这一版还不会单看一条对话的状态。如实说这一次看不到,别凭印象答。' }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没看到:${errorOf(result.body, '工作台拒绝了')}。如实告诉他。` }
      }
      const body = result.body as { ok?: unknown, note?: unknown, where?: unknown }
      const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : ''
      if (body.ok === true) {
        return { ok: true, text: `${note}\n照这句说给他听(时长照这句念,**不要换成分钟数**),别多加别的、别顺手给它捎话。` }
      }
      if (body.where === 'pick') {
        return { ok: false, text: `${note}\n照这句念给他听、问他是哪一条;他说了再调一次这件工具。` }
      }
      return { ok: false, text: `${note === '' ? '没找到他说的那条对话。' : note}\n照这句如实说,别编一个状态。` }
    },

    async createTask(input) {
      const title = input.title.trim()
      if (title === '') return { ok: false, text: '这件事没有标题,卡没建。问清楚是什么事。' }
      const desc = input.desc?.trim()
      // 需求卡**必须带那句需求**:一张只有标题的需求卡等于没拆,指挥台上什么都推不动。
      if (input.feature === true && (desc === undefined || desc === '')) {
        return { ok: false, text: '需求卡缺那句「要做成什么样」,没派。问他一句再来。' }
      }
      let result: { status: number, body: unknown }
      try {
        result = await json('/task/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title,
            ...(desc === undefined || desc === '' ? {} : { desc }),
            ...(input.feature === true ? { kind: 'feature' } : {}),
            /*
             * ★ 显式落「待办」(2026-10-23,卡「待排的卡不许被派出去」③):`/task/create` 的缺省
             * 从这一版起是「待排」(便签路),而电话里说「记下来」这一张照旧要进「待办」——
             * 它不是便签,是「先记在看板上」,意图此刻就是明说的,所以显式传。
             */
            status: 'todo',
            // 来源留痕:看板上一眼看得出这张卡是电话里派的。认不出的 kind 由 8791 归成 manual。
            source: { kind: 'session', ref: '电话' },
          }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,这张卡没建。如实告诉他。', unreachable: true }
      }
      if (result.status === 403) {
        return { ok: false, text: `${errorOf(result.body, '工作台不让写')}\n${writeApiHint()}` }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没建上:${errorOf(result.body, '工作台拒绝了')}。如实告诉他。` }
      }
      const id = (result.body as { id?: unknown } | null)?.id
      const shown = typeof id === 'string' ? id : '?'
      return input.feature === true
        ? { ok: true, text: `需求卡派出去了(id ${shown},id 不要念给他听)。跟他说「需求卡我派上了」。` }
        : { ok: true, text: `建好了,在看板的待办里(id ${shown},id 不要念给他听)。` }
    },

    async createGoal(input) {
      const title = input.title.trim()
      if (title === '') return { ok: false, text: '目标标题不能为空。' }
      const projectId = (input.project?.trim() || input.project_id?.trim()) || undefined

      let result: { status: number, body: unknown }
      try {
        result = await json('/collab/goal/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title,
            ...(input.why?.trim() ? { why: input.why.trim() } : {}),
            ...(input.due?.trim() ? { due: input.due.trim() } : {}),
            ...(projectId ? { project_id: projectId } : {}),
            ...(input.version?.trim() ? { version: input.version.trim() } : {}),
          }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,目标没建上。如实告诉他。', unreachable: true }
      }
      if (result.status === 403) {
        return { ok: false, text: `${errorOf(result.body, '工作台不让写')}\n${writeApiHint()}` }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没建上:${errorOf(result.body, '工作台拒绝了')}。如实告诉他。` }
      }
      const id = (result.body as { id?: unknown } | null)?.id
      const shown = typeof id === 'string' ? id : '?'
      return { ok: true, text: `目标建好了(id ${shown})。` }
    },

    async updateGoal(input) {
      const id = input.id.trim()
      if (id === '') return { ok: false, text: 'id 必须是非空字符串。' }
      const projectId = (input.project?.trim() || input.project_id?.trim()) || undefined

      let result: { status: number, body: unknown }
      try {
        result = await json('/collab/goal/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id,
            ...(input.title?.trim() ? { title: input.title.trim() } : {}),
            ...(input.status ? { status: input.status } : {}),
            ...(input.why !== undefined ? { why: input.why === null || input.why === '' ? null : input.why } : {}),
            ...(input.due !== undefined ? { due: input.due === null || input.due === '' ? null : input.due } : {}),
            ...(projectId !== undefined ? { project_id: projectId } : {}),
            ...(input.version !== undefined ? { version: input.version === null || input.version === '' ? null : input.version } : {}),
          }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,目标没改上。如实告诉他。', unreachable: true }
      }
      if (result.status === 403) {
        return { ok: false, text: `${errorOf(result.body, '工作台不让写')}\n${writeApiHint()}` }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没改上:${errorOf(result.body, '工作台拒绝了')}。如实告诉他。` }
      }
      return { ok: true, text: `目标已更新(id ${id})。` }
    },

    async createNote(input) {
      const title = input.title.trim()
      if (title === '') return { ok: false, text: '便签标题不能为空。' }
      const status = input.status === 'todo' ? 'todo' : 'backlog'
      const assignee = itemAssigneeOf(input.assignee)
      const workType = normalizeWorkType(input.work_type)
      const acceptance = Array.isArray(input.acceptance) ? input.acceptance.map(s => String(s).trim()).filter(Boolean) : []
      const from = parseNoteFrom(input.from) ?? { kind: 'said', ref: '事务官' }

      let result: { status: number, body: unknown }
      try {
        result = await json('/task/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title,
            status,
            ...(input.goal_id?.trim() ? { goal_id: input.goal_id.trim() } : {}),
            ...(assignee ? { assignee } : {}),
            ...(workType ? { work_type: workType, workType } : {}),
            ...(input.start?.trim() ? { start: input.start.trim() } : {}),
            ...(input.end?.trim() ? { end: input.end.trim() } : {}),
            ...(acceptance.length > 0 ? { acceptance } : {}),
            from,
          }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,便签没建上。如实告诉他。', unreachable: true }
      }
      if (result.status === 403) {
        return { ok: false, text: `${errorOf(result.body, '工作台不让写')}\n${writeApiHint()}` }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没建上:${errorOf(result.body, '工作台拒绝了')}。如实告诉他。` }
      }
      const id = (result.body as { id?: unknown } | null)?.id
      const shown = typeof id === 'string' ? id : '?'
      return { ok: true, text: `便签已建好(id ${shown},状态:${status === 'backlog' ? '待排' : '待办'})。` }
    },

    async updateNote(input) {
      const id = input.id.trim()
      if (id === '') return { ok: false, text: '事项 id 必须是非空字符串。' }
      const workType = normalizeWorkType(input.work_type)
      const assignee = itemAssigneeOf(input.assignee)
      const acceptance = Array.isArray(input.acceptance) ? input.acceptance.map(s => String(s).trim()).filter(Boolean) : undefined

      let result: { status: number, body: unknown }
      try {
        result = await json('/task/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id,
            ...(input.title?.trim() ? { title: input.title.trim() } : {}),
            ...(input.goal_id !== undefined ? { goal_id: input.goal_id === null || input.goal_id === '' ? null : input.goal_id } : {}),
            ...(workType !== undefined ? { work_type: workType, workType } : {}),
            ...(input.start !== undefined ? { start: input.start === null || input.start === '' ? null : input.start } : {}),
            ...(input.end !== undefined ? { end: input.end === null || input.end === '' ? null : input.end } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(assignee ? { assignee } : {}),
            ...(acceptance ? { acceptance } : {}),
          }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,便签没改上。如实告诉他。', unreachable: true }
      }
      if (result.status === 403) {
        return { ok: false, text: `${errorOf(result.body, '工作台不让写')}\n${writeApiHint()}` }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没改上:${errorOf(result.body, '工作台拒绝了')}。如实告诉他。` }
      }
      return { ok: true, text: `便签已更新(id ${id})。` }
    },

    async moveNote(input) {
      const id = input.id.trim()
      if (id === '') return { ok: false, text: '事项 id 必须是非空字符串。' }
      const status = input.status.trim()
      if (status === '') return { ok: false, text: '状态不能为空。' }

      let result: { status: number, body: unknown }
      try {
        result = await json('/task/move', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, status }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,状态没挪动。如实告诉他。', unreachable: true }
      }
      if (result.status === 403) {
        return { ok: false, text: `${errorOf(result.body, '工作台不让写')}\n${writeApiHint()}` }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没挪动:${errorOf(result.body, `工作台回了 ${result.status}`)}。如实告诉他。` }
      }
      return { ok: true, text: `已挪到「${status}」(id ${id})。` }
    },

    async confirmPoints(text, who, opts) {
      const said = text.trim()
      if (said === '') return { ok: false, spoken: fallbackSpoken('(他这句话是空的)'), note: '他这句话是空的,先问清楚他要什么。' }
      let result: { status: number, body: unknown }
      // `who`(2026-09-27,卡 MS):他点名要哪一家做。工作台据它换掉「这件事谁去执行」那一条的默认理解 ——
      // 「找豆包总结一下」不该听到「事务官自己办,动的是工作台这一处」。
      try { result = await json('/confirm/points', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: said,
          ...(who === undefined || who.trim() === '' ? {} : { who: who.trim() }),
          ...(opts?.for === undefined ? {} : { for: opts.for }),
          ...(opts?.said === undefined || opts.said.trim() === '' ? {} : { said: opts.said.trim() }),
        }),
      }) }
      catch {
        return { ok: false, spoken: fallbackSpoken(said), note: '这会儿问不到工作台那张确认点的表,下面这条是兜底的。' }
      }
      if (result.status === 404) {
        return { ok: false, spoken: fallbackSpoken(said), note: '这份工作台还没有确认点那条接口(是旧版),下面这条是兜底的。' }
      }
      if (result.status !== 200) {
        return { ok: false, spoken: fallbackSpoken(said), note: `工作台没给出确认点(${result.status}),下面这条是兜底的。` }
      }
      const body = result.body as { spoken?: unknown, simple?: unknown, call?: unknown } | null
      const spoken = body?.spoken
      if (typeof spoken !== 'string' || spoken.trim() === '') {
        return { ok: false, spoken: fallbackSpoken(said), note: '工作台回的确认点是空的,下面这条是兜底的。' }
      }
      /*
       * **简单的事只确认一句**(2026-09-28,卡 CF 第 6 条):工作台判的(点了名 + 一句话说得清的打听),
       * `spoken` 就是那一句。老工作台不带这一格 → 照旧走三条那一段。
       */
      const call = callAskOf(body?.call)
      return { ok: true, spoken, ...(body?.simple === true ? { simple: true } : {}), ...(call === undefined ? {} : { call }) }
    },

    async askButler(input) {
      const id = input.itemId.trim()
      const question = input.question.trim()
      if (id === '' || question === '') return { ok: false, text: '缺事项 id 或者他那句话,没问出去。' }
      // ① 先把问题投进那条会话。送不进去就到此为止 —— 后面等回答等的是一条没送出去的问题。
      const sent = await this.handToButler(id, question)
      if (!sent.ok) {
        return sent.text.includes('授权')
          ? { ok: false, text: `${sent.text}\n${writeApiHint()}` }
          : { ok: false, text: `这句话没送进你在电脑上那只手:${sent.text}` }
      }
      // ② 记下「问之前最后一条回合是什么时候」,只认**比它新**的那一条(不然会把上一轮的答案念给他)。
      const before = await this.itemTurns(id)
      const since = before.ok ? lastAssistantAt(before.turns) : undefined
      const deadline = Date.now() + (input.timeoutMs ?? BUTLER_ANSWER_TIMEOUT_MS)
      while (Date.now() < deadline) {
        await sleep(BUTLER_ANSWER_POLL_MS)
        const got = await this.itemTurns(id)
        if (!got.ok) continue
        const answer = newestAssistantText(got.turns, since)
        if (answer !== undefined) {
          // 2026-10-02:这是**你自己**在电脑上翻到的,不是别人告诉你的 —— 说「我查了」,不说「事务官说」。
          return { ok: true, text: `你在电脑上查到的是:${answer}\n照这个意思用**一句**人话说出来(说「我查了」),别照着念、别念 id 和路径、别说「事务官说」。` }
        }
      }
      return {
        ok: false,
        text: '问题已经送进你在电脑上那只手了,但这会儿还没查出来。'
          + '**如实说**「我还在查,等会儿告诉你」—— 不要自己编一个答案,也别说「我问了事务官」。',
      }
    },

    async itemTurns(itemId) {
      const id = itemId.trim()
      if (id === '') return { ok: false }
      let result: { status: number, body: unknown }
      try { result = await json(`/butler/item/${encodeURIComponent(id)}/turns?limit=8`) }
      catch { return { ok: false } }
      if (result.status !== 200) return { ok: false }
      const turns = (result.body as { turns?: unknown } | null)?.turns
      return { ok: true, turns: Array.isArray(turns) ? turns as readonly SessionTurn[] : [] }
    },

    async savePreference(input) {
      const text = input.text.trim()
      if (text === '') return { ok: false, text: '这句话是空的,没记。' }
      let result: { status: number, body: unknown }
      try {
        result = await json('/butler/memory/preference', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, ...(input.kind === undefined ? {} : { kind: input.kind }) }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,这条没写进人设。**如实告诉他没记上**。' }
      }
      if (result.status === 403) {
        return { ok: false, text: `${errorOf(result.body, '工作台不让写')}\n${writeDocsHint()}\n**如实告诉他没记上。**` }
      }
      if (result.status === 404) {
        return { ok: false, text: '这台工作台还没接「把偏好写进人设」这一档,没记上。**如实告诉他**。' }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没写进去:${errorOf(result.body, '工作台拒绝了')}。**如实告诉他没记上**。` }
      }
      return input.kind === 'address'
        ? { ok: true, text: '记下了,以后按这个叫他。可以说一句「行,以后就这么叫」。' }
        : { ok: true, text: '记下了,写进人设了,下一通电话也算数。可以说一句「记住了」。' }
    },

    async layoutAct(input) {
      if (input.actions.length === 0) return { ok: false, text: '一条动作都没有,布局没动。' }
      let result: { status: number, body: unknown }
      try {
        result = await json('/layout/act', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            orientation: input.orientation,
            actions: input.actions,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,布局一格没动。如实告诉他。' }
      }
      if (result.status === 404) {
        // 老版本的工作台没有这条路。**如实说**,不退回去拼 /layout(那条会覆盖整份布局)。
        return { ok: false, text: '这台工作台还没有「用说话改布局」这条路(版本旧了),布局没动。如实告诉他。' }
      }
      if (result.status !== 200) {
        // 400 里那句话是服务端写给人看的中文,**原样带走**(同 decideItem 那条纪律)。
        return { ok: false, text: `没改成:${errorOf(result.body, `工作台回了 ${result.status}`)}。如实告诉他。` }
      }
      const note = (result.body as { note?: unknown } | null)?.note
      return {
        ok: true,
        text: typeof note === 'string' && note !== '' ? note : '挪好了,不合适说「撤销」。',
      }
    },

    async layoutUndo() {
      let result: { status: number, body: unknown }
      try {
        result = await json('/layout/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      }
      catch {
        return { ok: false, text: '工作台连不上,没撤回去。如实告诉他。' }
      }
      if (result.status !== 200) {
        return { ok: false, text: `撤不回去:${errorOf(result.body, `工作台回了 ${result.status}`)}。如实告诉他。` }
      }
      return { ok: true, text: '回到上一步了。' }
    },

    async publishPlan(input) {
      const title = input.title.trim()
      const date = input.date.trim()
      if (title === '') return { ok: false, text: '她没说要发什么,这条没记。先问她「这条是关于什么的?」' }
      let result: { status: number, body: unknown }
      try {
        result = await json('/publish/plan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title,
            date,
            ...(input.contentType === undefined ? {} : { content_type: input.contentType }),
            ...(input.said === undefined || input.said.trim() === '' ? {} : { said: input.said.trim() }),
          }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,这条发布计划没记上。如实告诉她。' }
      }
      if (result.status === 404) {
        return { ok: false, text: '这台工作台还没有「记发布计划」这条路(版本旧了),没记上。如实告诉她。' }
      }
      /*
       * 400 = 8791 **替她回问的那一句正文**(「这条打算哪天发?」/「这条是关于什么的?」):
       * 原样带回去问她,一个字都不要说成记上了(同 `rememberItem` 那一档的分寸)。
       */
      if (result.status !== 200) {
        return { ok: false, text: `${errorOf(result.body, '工作台拒绝了')}\n**照这一句问她**,这条还没记上。` }
      }
      const body = result.body as { note?: unknown }
      const note = typeof body.note === 'string' && body.note !== '' ? body.note : '记进发布计划了。'
      return {
        ok: true,
        text: `${note}\n**照这一句说**,别添别的:这一条是记进她日历上那一格,没有人在办、也没派给谁。`
          + '别说「我去办」「派出去了」,也别念「看板」「卡」「事项」。',
      }
    },

    async todoView(view) {
      let result: { status: number, body: unknown }
      try {
        result = await json('/today/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ view }) })
      }
      catch {
        return { ok: false, text: '工作台连不上,待办没换。如实告诉她。' }
      }
      if (result.status === 404) {
        return { ok: false, text: '这台工作台还没有换待办显示这条路(版本旧了),没换。如实告诉她。' }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没换成:${errorOf(result.body, `工作台回了 ${result.status}`)}。如实告诉她。` }
      }
      if ((result.body as { changed?: unknown } | null)?.changed === false) {
        return { ok: true, text: `${todoViewSameText(view)}照这句告诉她,别说成换了。` }
      }
      return { ok: true, text: todoViewDoneText(view) }
    },

    /**
     * ★ **先问 8791 这一句是什么意思**(2026-10-13,卡「三个入口一套管线」)。
     * 这一下**什么都不办**;问不到就如实回 `old` / `down`,由 agent.ts 照老路交给模型。
     */
    async understandSaid(input) {
      const text = input.text.trim()
      if (text === '') return { kind: 'down', why: '空的一句' }
      let result: { status: number, body: unknown }
      try {
        result = await json('/butler/understand', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            source: 'call',
            ...(input.open === undefined
              ? {}
              : { open: { item_id: input.open.itemId, said: input.open.said, at_ms: input.open.atMs } }),
          }),
        })
      }
      catch (err) {
        return { kind: 'down', why: (err as Error)?.message ?? '连不上' }
      }
      // 老工作台没有这条路 —— 照老路走(整条管线要能在上一版工作台上原样跑)。
      if (result.status === 404) return { kind: 'old' }
      if (result.status !== 200) return { kind: 'down', why: `工作台回了 ${result.status}` }
      const one = (result.body as { understanding?: unknown } | null)?.understanding as Understanding | undefined
      // 形状不认得 = 当没问到(宁可慢别错:不拿一份读不懂的判定去办事)。
      if (one === undefined || typeof one.kind !== 'string' || typeof one.mode !== 'string' || typeof one.confirm !== 'object') {
        return { kind: 'down', why: '回包的形状不认得' }
      }
      // `say` 那一格缺席 / 缺 `start` 的老回包也收得住(下面只读 `say.start`)。
      const say = { start: typeof one.say?.start === 'string' ? one.say.start : '', ...(one.say?.done === undefined ? {} : { done: one.say.done }) }
      return { kind: 'understood', understanding: { ...one, say } }
    },

    /**
     * ★ **照那份判定去办**(2026-10-13)。打 8791 指的那条路,回一句**按真实结果挑过**的话。
     *
     * 每条路各自的「其实没办成」都在这里认出来(不许说成办了,D13):
     *   · `/butler/item`:`dispatch_ok === false`(第一步派不出去)→ 说那句原因;
     *   · `/today/view`:`changed === false`(本来就是这一版)→ 说工作台那句「本来就是…」;
     *   · `/asks/voice`:`confirmed === false`(点了、没看到它收下)→ **从理由分档拼一句人话**
     *     (2026-10-13 下午,`answerAskSay`)。11:40 真机那一通这里把接口的 `note`
     *     (「已尝试发送,但回执尚未确认。请查看对话区…」)原话念给了她听 —— 那一格是给界面的,
     *     不是给听筒的。这一路**一个 `note` / `error` 的字都不念**,只看 `picked` / `custom` /
     *     `confirmed` 与状态码分档。
     */
    async runUnderstanding(input) {
      const route = input.understanding.route
      if (route === undefined) return { ok: false, say: input.understanding.ask ?? '这件我没接上,你再说一遍。' }
      const text = input.text.trim()
      /** 这一路是「替她答挂着那一问」吗(没办成时那几句话由 `answerAskSay` 拼,不读 `note`)。 */
      const answering = route.path === '/asks/voice'
      /**
       * 这一路是「补一句进刚开始那件事」吗。没办成时固定说 {@link APPEND_FAILED_SAY},
       * **一个 `note` / `error` 的字都不念**(2026-10-13 下午,卡 A 第 2 条:
       * 14:02 那一通把 409 的「这件事的会话没开,说不进去」原样念了出来)。
       */
      const appending = route.path === '/butler/item/say'
      /** 这一问在哪一家:`session:<家>/<会话 id>` 认得出就说哪一家,认不出就不说。 */
      const askAgent = answering
        ? ((id: string | undefined) => (id === undefined ? undefined : familyTitle(id)))(askAgentIdOf(String(route.body.item_id ?? '')))
        : undefined
      /** 她在电话里说的那一句(点没点上那一档里要复述它)。 */
      const askSaid = answering ? String(route.body.said ?? text) : text
      const body: Record<string, unknown> = route.path === '/butler/item'
        ? {
            text,
            source: 'call',
            ...route.body,
            ...(input.confirmed === true ? { confirmed: true } : {}),
            // 同一句两分钟内再打一次只办一回(10-12 那张卡的请求号机制,这里白捡)。
            client_key: repeatKeyOf(`understood ${route.path} ${text}`),
          }
        : { ...route.body }
      let result: { status: number, body: unknown }
      try {
        result = await json(route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      }
      catch {
        if (answering) return { ok: false, say: answerAskSay({ status: 0, ...(askAgent === undefined ? {} : { agent: askAgent }) }) }
        if (appending) return { ok: false, say: APPEND_FAILED_SAY, why: '工作台连不上' }
        return { ok: false, say: '工作台这会儿连不上,这件没办成。' }
      }
      const got = (result.body ?? {}) as Record<string, unknown>
      if (result.status !== 200) {
        /*
         * 答挂着那一问这一路:状态码分档说一句人话(400 没按出去 / 409 那一问已经过去了 /
         * 其余「我这边没办成」)。**不念 `error`** —— 那一格写的是「没听准他要哪一项(它给的是:…)」
         * 这种给界面的话(2026-10-13 下午)。
         */
        if (answering) {
          return { ok: false, say: answerAskSay({ status: result.status, ...(askAgent === undefined ? {} : { agent: askAgent }) }) }
        }
        // 8791 回问那一句(「这条打算哪天发?」)就是正文,原样念 —— 它不是一个错。
        const why = errorOf(got, `工作台回了 ${result.status}`)
        // 补一句那一路:固定一句,真实原因只进日志(调用方按 `why` 记一行)。
        if (appending) return { ok: false, say: APPEND_FAILED_SAY, why }
        return { ok: false, say: why }
      }
      const itemId = typeof got.id === 'string' ? got.id : undefined
      const honest = (line: unknown): string | undefined => (typeof line === 'string' && line.trim() !== '' ? line.trim() : undefined)
      if (got.dispatch_ok === false) {
        return { ok: false, say: honest(got.dispatch_note) ?? '没派出去。', ...(itemId === undefined ? {} : { itemId }) }
      }
      if (got.changed === false) return { ok: true, say: honest(got.note) ?? '本来就是这一版,没动。' }
      if (got.confirmed === false) {
        // 按出去了、没看到它收下:说「我替你点了〈那一项〉,没看到它选上,你在电脑上点一下」。
        if (answering) {
          return {
            ok: false,
            say: answerAskSay({
              status: 200,
              ...(typeof got.picked === 'string' ? { picked: got.picked } : {}),
              ...(typeof got.custom === 'string' ? { custom: got.custom } : {}),
              said: askSaid,
              ...(askAgent === undefined ? {} : { agent: askAgent }),
            }),
          }
        }
        return { ok: false, say: honest(got.note) ?? '按了,没看到它收下。' }
      }
      const say = input.understanding.say.start.trim() !== ''
        ? input.understanding.say.start.trim()
        // 答挂着那一问这一路**连成了那一句也不读 `note`**(同上:那一格是给界面的)。
        : answering ? '好了,替你答上了。' : honest(got.note) ?? honest(got.dispatch_note) ?? '办好了。'
      return { ok: true, say, ...(itemId === undefined ? {} : { itemId }) }
    },

    /**
     * 引导那三条(2026-09-18)。走**回环、不带设备头** —— 这是工人自己在做引导,不是替谁代办;
     * 8791 的 /onboarding/* 认「回环或已配对手机」,工人在本机,门是回环那一道。
     */
    async answerAsk(itemId, said) {
      const id = itemId.trim()
      const words = said.trim()
      if (id === '' || words === '') return { ok: false, text: '没有事项 id 或者他的原话,没交上去。如实告诉他。' }
      let result: { status: number, body: unknown }
      try {
        result = await json('/asks/voice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ item_id: id, said: words }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,没交上去。跟他说手机上「等你确认」里点一下也行。' }
      }
      if (result.status !== 200) {
        return { ok: false, text: `没交上去:${errorOf(result.body, `工作台回了 ${result.status}`)}。如实告诉他,手机上「等你确认」里也能答。` }
      }
      const body = (result.body ?? {}) as { kind?: unknown, picked?: unknown, custom?: unknown, allow?: unknown, next?: unknown, confirmed?: unknown, note?: unknown }
      /**
       * 别家会话弹的那个框(2026-09-28,卡 WQ):工作台**替他点了**那一项,并且重读核实过。
       * `confirmed:false` = 点了、没看到它收下 —— 照工作台那句话说,**绝不说成答上了**(链上第 ⑤ 环:不撒谎)。
       *
       * ★ **他说的那一句不在那几项里**(2026-09-28,卡 AT):工作台把他那句**原话**写进了那个面板里的
       * 自由作答框、按了面板自己那颗发送键(回包带 `custom` 而不是 `picked`)。核实的规矩一模一样。
       */
      if (body.kind === 'session') {
        const note = typeof body.note === 'string' && body.note !== '' ? body.note : ''
        if (typeof body.custom === 'string' && body.custom !== '') {
          return body.confirmed === true
            ? { ok: true, text: `替他把他那句「${body.custom}」写进那个框、发出去了,那一问已经收了。一句话跟他说一声就行。` }
            : { ok: true, text: `${note === '' ? `写进去了「${body.custom}」,但没看到它收下` : note}。**如实这么告诉他**,别说成答上了。` }
        }
        const picked = typeof body.picked === 'string' ? body.picked : '那一项'
        // 权限弹窗(2026-10-01,卡 AP):按的是「批准一次 / 拒绝」那颗键,照意思说(键名多半是英文,只附在后面)。
        const approved = (body as { approved?: unknown }).approved
        if ((approved === 'once' || approved === 'deny') && body.confirmed === true) {
          return { ok: true, text: `${approved === 'once' ? '替他批准了这一次' : '替他拒绝了'}(按的是它弹窗上的「${picked}」),那个弹窗已经收了。一句话跟他说一声就行。` }
        }
        return body.confirmed === true
          ? { ok: true, text: `替他点了「${picked}」,那一问已经收了。一句话跟他说一声就行。` }
          : { ok: true, text: `${note === '' ? `点了「${picked}」,但没看到它收下` : note}。**如实这么告诉他**,别说成答上了。` }
      }
      const done = body.kind === 'approval'
        ? (body.allow === true ? '批了,它接着办。' : '没批,它会换个办法或者停下来。')
        : typeof body.picked === 'string' ? `交上去了:他选的是「${body.picked}」,它接着办。` : '他的原话交上去了,它照着办。'
      /**
       * 还有下一问(2026-09-25,卡 M 追加:接连几问只响一次,电话里一问一问答下去)。
       * 工作台把在等他的下一问带回来:哪件事、那一句、选项。**原样转给她**,她接着问;他说「先这样」就停。
       */
      const next = (body.next ?? undefined) as { item_id?: unknown, title?: unknown, note?: unknown } | undefined
      if (next !== undefined && typeof next.item_id === 'string' && typeof next.title === 'string') {
        const note = typeof next.note === 'string' && next.note !== '' ? `(工作台记的一句:${next.note})` : ''
        return { ok: true, text: `${done}还有下一问:${next.title}${note}。先一句话跟他确认上一件,再用人话问这一问;他答了用 wb_answer_ask 交,item_id 用 ${next.item_id}。他说「先这样」就不问了。` }
      }
      return { ok: true, text: `${done}一句话跟他确认就行。` }
    },

    async decideItem(itemId, decision) {
      const id = itemId.trim()
      if (id === '') return { ok: false, text: '没有事项 id,这个决定没落下去。如实告诉他。' }
      if (decision === 'later') {
        // 「稍后」**不改任何状态** —— 那正是它的意思。落一句到那条事项底下的会话里就够了。
        const said = await this.handToButler(id, '他在电话里说这件事稍后再说。')
        return said.ok
          ? { ok: true, text: '记下了「稍后」,状态一个字没改。跟他说这件事先放着。' }
          : { ok: false, text: `「稍后」没记上:${said.text}` }
      }
      /*
       * ★ 派活没成的那件,他说「重做 / 再派一次」→ **真的再派一次**(2026-10-01 Air 诊断包:
       * 以前只挪回进行中、嘴上说「接着做」,一下都没再派,卡停在「在做(没看到它在跑)」)。
       * 派的结果当场照实说:成了照工作台那句,又没成说清原因 —— 不许说成在做。
       */
      if (decision === 'redo') {
        const failed = await failedDispatchOf(id)
        if (failed !== undefined) {
          let run: { status: number, body: unknown }
          try {
            run = await json('/dispatch/run', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ item_id: id, app: failed.family, source: 'call' }),
            })
          }
          catch {
            return { ok: false, text: '工作台连不上,没能再派一次。如实告诉他这件还没派出去。' }
          }
          const said = run.body as { ok?: unknown, note?: unknown }
          const note = typeof said.note === 'string' && said.note.trim() !== '' ? said.note.trim() : ''
          if (run.status === 200 && said.ok === true) {
            return { ok: true, text: `又派了一次:${note === '' ? '派出去了' : note}。照这句说,看板上能看到它收没收到;别许诺结果回来给他打电话。` }
          }
          const why = note !== '' ? note : errorOf(run.body, `工作台回了 ${run.status}`)
          return { ok: false, text: `又没派出去:${why}。照实告诉他这次也没成、原因是什么,别说成在做。` }
        }
      }
      const status = decision === 'approve' ? 'done' : 'doing'
      let result: { status: number, body: unknown }
      try {
        result = await json('/task/move', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, status }),
        })
      }
      catch {
        return { ok: false, text: '工作台连不上,这个决定没落下去。如实告诉他。' }
      }
      if (result.status !== 200) {
        // 409 里那句话是服务端写给人看的中文(七态转换表),**原样带走**。
        return { ok: false, text: `没落下去:${errorOf(result.body, `工作台回了 ${result.status}`)}。如实告诉他。` }
      }
      return decision === 'approve'
        ? { ok: true, text: '批了,这件事已经挪到「完成」。' }
        : { ok: true, text: '打回去了,这件事回到「进行中」,事务官会接着做。' }
    },

    async claimCalls() {
      let result: { status: number, body: unknown }
      try { result = await json('/call/claim', { method: 'POST' }) }
      catch { return [] }
      if (result.status !== 200) return []
      const calls = (result.body as { calls?: unknown } | null)?.calls
      return Array.isArray(calls) ? calls : []
    },

    async claimRoomCalls(room) {
      let result: { status: number, body: unknown }
      try {
        result = await json('/call/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room }) })
      }
      catch { return { calls: [], answered_elsewhere: [] } }
      if (result.status !== 200) return { calls: [], answered_elsewhere: [] }
      const body = (result.body ?? {}) as { calls?: unknown, answered_elsewhere?: unknown }
      const elsewhere = Array.isArray(body.answered_elsewhere)
        ? body.answered_elsewhere.flatMap((one) => {
          const row = (one ?? {}) as { id?: unknown, room?: unknown }
          return typeof row.id === 'string' && typeof row.room === 'string' ? [{ id: row.id, room: row.room }] : []
        })
        : []
      return { calls: Array.isArray(body.calls) ? body.calls : [], answered_elsewhere: elsewhere }
    },

    async callAnswered(input) {
      let result: { status: number, body: unknown }
      try {
        result = await json('/call/answered', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: input.id, room: input.room, ...(input.device_id === undefined ? {} : { device_id: input.device_id }) }),
        })
      }
      catch { return { first: true, unknown: true } }
      const body = (result.body ?? {}) as { ok?: unknown, first?: unknown, room?: unknown, device_id?: unknown }
      if (result.status !== 200 || body.ok !== true || typeof body.first !== 'boolean') return { first: true, unknown: true }
      return {
        first: body.first,
        ...(typeof body.room === 'string' ? { room: body.room } : {}),
        ...(typeof body.device_id === 'string' ? { device_id: body.device_id } : {}),
      }
    },

    async butlerVoice() {
      let result: { status: number, body: unknown }
      try { result = await json('/butler/status') }
      catch { return undefined }
      if (result.status !== 200) return undefined
      const voice = (result.body as { voice?: unknown } | null)?.voice
      return typeof voice === 'string' && voice.trim() !== '' ? voice.trim() : undefined
    },

    async workbenchVersion() {
      let result: { status: number, body: unknown }
      try {
        // 自己那道超时:这一条排在她开口前面(见接口上那段),更新服务器慢不该让电话等着。
        result = await json('/update/check', { signal: AbortSignal.timeout(WORKBENCH_VERSION_TIMEOUT_MS) })
      }
      catch { return undefined }
      // 热更新没启用是 404 —— 那时**真的没有**这个数,如实回 undefined。
      if (result.status !== 200) return undefined
      const current = (result.body as { current?: unknown } | null)?.current
      return typeof current === 'string' && current.trim() !== '' ? current.trim() : undefined
    },

    async recordCall(input) {
      try {
        const result = await json('/butler/call/record', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        })
        return result.status === 200
      }
      catch { return false }
    },

    async ackCall(input) {
      try {
        const result = await json('/call/ack', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        })
        return result.status === 200
      }
      catch { return false }
    },

    onboardingBrief() {
      return json('/onboarding/brief')
    },

    onboardingAnswer(input) {
      return json('/onboarding/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: input.stage, key: input.key, value: input.value, ...(input.heard === undefined ? {} : { heard: input.heard }) }),
      })
    },

    onboardingSeedSpoken(stage) {
      return json('/onboarding/spoken', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage }),
      })
    },

    onboardingScan(name) {
      return json('/onboarding/scan', name === undefined || name.trim() === ''
        ? { method: 'POST' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) })
    },

    onboardingProjectBrief(path) {
      return json('/onboarding/project-brief', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    },

    onboardingCorrect(input) {
      return json('/onboarding/correct', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: input.stage, key: input.key, value: input.value }),
      })
    },

    onboardingWorkdays(input) {
      const query = new URLSearchParams({ to: input.to, ...(input.from === undefined ? {} : { from: input.from }) })
      return json(`/onboarding/workdays?${query.toString()}`)
    },

    onboardingMaterializePreview() {
      return json('/onboarding/materialize/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    },

    onboardingMaterializeApply(input) {
      return json('/onboarding/materialize/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(input.id === undefined ? {} : { id: input.id }),
          ...(input.skip === undefined || input.skip.length === 0 ? {} : { skip: input.skip }),
          ...(input.heard === undefined ? {} : { heard: input.heard }),
        }),
      })
    },

    onboardingLeader(leader) {
      return json('/onboarding/leader', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leader }),
      })
    },

    async callAsDevice(input) {
      const hasBody = input.body !== undefined && input.method !== 'GET'
      return json(input.path, {
        method: input.method,
        headers: {
          [CHANNEL_DEVICE_HEADER]: input.deviceId,
          ...routeHeader(),
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
      })
    },

    async renewTicket(deviceId) {
      let result: { status: number, body: unknown }
      try {
        result = await json('/channel/token', {
          method: 'POST',
          headers: { 'content-type': 'application/json', [CHANNEL_DEVICE_HEADER]: deviceId, ...routeHeader() },
          // name 不传:房里显示的名字由手机第一次配对时定,续期不该把它改了。
          body: JSON.stringify({}),
        })
      }
      catch {
        return { status: 0, error: '工作台连不上,这张凭证续不了' }
      }
      if (result.status !== 200) {
        return { status: result.status, error: errorOf(result.body, '工作台没说原因') }
      }
      const ticket = result.body as Partial<ChannelTicket>
      if (typeof ticket.token !== 'string' || typeof ticket.expires_at !== 'number') {
        return { status: result.status, error: '工作台回的凭证形状不对' }
      }
      // 地址与房间(2026-10-21):8791 按来路签的那一间,设备拿它覆盖旧的。老 8791 只回两格时缺席。
      const route = channelRouteOf(ticket.route)
      return {
        token: ticket.token,
        expires_at: ticket.expires_at,
        ...(typeof ticket.url === 'string' && ticket.url !== '' ? { url: ticket.url } : {}),
        ...(typeof ticket.room === 'string' && ticket.room !== '' ? { room: ticket.room } : {}),
        ...(route === undefined ? {} : { route }),
      }
    },
  }
}

/** `/confirm/points` 回包里 `call` 那一格。形状不对就当没有(= 按问)。 */
export function callAskOf(value: unknown): CallAsk | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const one = value as Record<string, unknown>
  if (typeof one.ask !== 'boolean' || typeof one.why !== 'string') return undefined
  return {
    ask: one.ask,
    why: one.why,
    ...(typeof one.spoken === 'string' && one.spoken.trim() !== '' ? { spoken: one.spoken } : {}),
    ...(typeof one.hint === 'string' && one.hint.trim() !== '' ? { hint: one.hint } : {}),
  }
}
