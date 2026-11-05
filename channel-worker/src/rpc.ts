/**
 * 房间代理(2026-09-17):工人在 LiveKit 房间里当手机的**代办**。
 *
 * 远程模式下手机够不到 8791(它在 Ben 的 Mac 上,没有公网口子),但手机和工人都在同一个房间里。
 * 所以手机把「我要调 8791 的哪条路」当成一条消息发进房间,工人替它去调,再把回包发回去。
 * 房间就成了唯一那条通道 —— 设计 §四.4 说的「8791 的控制指令逐步收进房间的数据通道」。
 *
 * ## 走的是「数据流」不是「数据包」
 *
 * LiveKit 的 `publishData` 单包有 15KB 的上限,而 `/state` 一份快照远不止 15KB。所以 `wb.rpc`
 * 用的是**文本数据流**(`sendText` / `registerTextStreamHandler`):框架自动分块重组,内容就是一行 JSON。
 * 两端必须用同一套 —— 手机那一侧也是 `registerTextStreamHandler('wb.rpc', …)` 与 `sendText(json, { topic })`。
 *
 * ## 安全:工人是**降权**代办,不是「代表本机」
 *
 * 工人跑在回环上,8791 对回环全权信任。要是工人原样把房里的请求转成一条回环请求,
 * **房里任何参与者都拿到了这台 Mac 的全部权限**。所以这里有两道:
 *
 *   ① **身份**:只认 identity 以 `wb-phone-` 开头的参与者,设备 id 从**参与者属性**(凭证里签的
 *      `wb_device_id`)读,读不到就退回从 identity 里拆。两样都是 LiveKit 按签好的凭证强制的,
 *      participant 自己改不了(我们发的授权里没有 `canUpdateOwnMetadata`)。
 *   ② **降权**:转发时带 `X-Workbench-Channel-Device: <设备 id>`,8791 把这条回环请求降成
 *      **那台已配对设备**的权限(workbench-plugin/src/server/http.ts 里那一段)。设备被解除配对,
 *      这条路当场 401 —— 凭证还没过期也没用。
 *   ③ **白名单**:再往窄里收一道,只放手机现在真的用到的那几条 + `/channel/*`,其余一律 403。
 *      多一道的理由:降权之后手机的权限仍然不小(能建事项、能写引导),而房间里的输入是最不可控的。
 *
 * 这个文件里**全是纯函数 + 一个不碰 LiveKit 的 handle**:房间那一层在 agent.ts 里接线,
 * 所以单测不用起房间。
 */

/**
 * 房间里那条 JSON 控制通道的 topic(RPC / 续期 / 字幕 / 缓冲语信号)。两端唯一的约定。
 *
 * 广播出去的两种(不按设备分,一个房间就是一场对话):`{type:'caption'}` 见下面的 {@link RpcCaption},
 * `{type:'filler'}` 见 filler.ts —— 那一条里**没有话**,说哪一句由收的那一头挑。
 */
export const RPC_TOPIC = 'wb.rpc'

/** 传文件的 topic。两端唯一的约定(原型里是 `wb-file`,见 LEGACY_FILE_TOPIC)。 */
export const FILE_TOPIC = 'wb.file'

/**
 * 原型阶段用过的文件 topic。**只收不发** —— 浏览器测试页与 09-17 那版假手机还发着它,
 * 为了不把已经跑通的那一遍弄坏,收件侧两个 topic 都注册;发件侧只用 `wb.file`。
 */
export const LEGACY_FILE_TOPIC = 'wb-file'

/** 手机的身份前缀。由 8791 按设备令牌拼,手机说了不算。 */
export const PHONE_IDENTITY_PREFIX = 'wb-phone-'

/** 凭证里带设备 id 的参与者属性名(与 workbench-plugin/src/server/channel.ts 同一个字符串)。 */
export const DEVICE_ATTRIBUTE = 'wb_device_id'

/** 工人在房里的身份。手机只认它。 */
export const WORKER_IDENTITY = 'wb-channel-worker'

/** 一条回包最多多大。文本流会自动分块,这个上限只为拦住病态的大回包(它会把房间带慢)。 */
export const RPC_MAX_RESPONSE_BYTES = 1024 * 1024

export type RpcMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'DELETE']

export interface RpcHttpRequest {
  id: string
  type: 'http'
  method: RpcMethod
  path: string
  body?: unknown
}

export interface RpcRenewRequest {
  id: string
  type: 'renew'
}

export const ONBOARDING_RPC_ACTIONS: readonly string[] = ['start', 'resume', 'say', 'stop']
export type OnboardingRpcAction = 'start' | 'resume' | 'say' | 'stop'

/**
 * 「我在做引导」(2026-09-18)。手机进房之后发这一条,工人据此把系统提示换成引导那一套并开口。
 *
 * - `start` / `resume`:开始 / 接着做引导。**开场白重不重说由工作台的简报说了算**(speak_seed),
 *   手机说了不算 —— 它记不住「上次念到哪」,onboarding.json 才是真相。
 * - `say`:打字备胎。字幕面板里打的一句话当成他说的话喂给模型,走同一条 record 路径。
 * - `stop`:挂断了 —— 暂停引导,回到平时那套人设。
 */
export interface RpcOnboardingRequest {
  id: string
  type: 'onboarding'
  action: OnboardingRpcAction
  text?: string
}

/**
 * `playing`(2026-09-28,卡 CF 第 4 条):**手机本地真的开始播远端音轨了**。
 * 开场白等这一条(`tts/playingGate.ts`)—— 「订上音轨」早在十几分钟前就成立,
 * 「真的出声」才是他听不听得到第一个字的那一刻。
 */
export const CALL_RPC_ACTIONS: readonly string[] = ['start', 'answer', 'later', 'hangup', 'playing']
export type CallRpcAction = 'start' | 'answer' | 'later' | 'hangup' | 'playing'

/**
 * 「**这是一通普通电话,打个招呼吧**」(2026-09-18,Ben 真机:「接通的瞬间它说『你说』」)。
 *
 * 以前那句招呼是工人**一进房就**说的(`session.say(persona.welcome)`)。工人是常驻的,
 * 房里没人时那一句只是排在音频队列里 —— 等手机进来那一刻才真的出声。于是 Ben 一进引导
 * 先听见「喂,我在,你说。」,之后才是开场白(他那台机器的日志逐字印证了这个顺序)。
 *
 * 所以招呼从此**由打电话的那一头点名要**:普通通话发这一条,引导发的是 `onboarding.start`。
 * 两者互斥、各自明确,中间**没有时间窗**可赌 —— 手机进房前要先问麦克风权限,那一下可能等人好几秒,
 * 任何「先说招呼、等一会儿看看是不是引导」的写法都会在真机上翻车。
 */
export interface RpcCallRequest {
  id: string
  type: 'call'
  action: CallRpcAction
  /**
   * 哪一通来电(2026-09-21,`answer` / `later` 必带;2026-10-22 起 `start` 也可带:手机给自己拨的这一通编的号)。**必须带** ——
   * 「接起正在响的那一通」听起来省事,但铃刚好在他按下去那一刻超时的话,
   * 他就接起了下一通、而以为自己接的是上一通。带上 id,对不上就如实回一句。
   */
  call_id?: string
  /**
   * **这台手机接起之后会告诉你「我这边在放了」**(2026-09-28,卡 CF 第 4 条;`start` / `answer` 带)。
   *
   * 有它,工人的开场白就多等一下那条 `playing`(上限 2.5s);**没有它就一个字都不等** ——
   * 老手机(还没更新的那个包)不发 `playing`,等它等于让他举着一只安静的听筒。
   */
  reports_playing?: true
  /**
   * **手机自己把通话输出烘热等了多久**(毫秒,`playing` 带;2026-09-28 卡 OP)。
   * 只进日志 —— 统筹真机核那一行「凭什么开口、各等了多少」靠它。取不到就缺席,不编一个数。
   */
  warm_ms?: number
}

/**
 * 「**把那张取件单上的文件推给我**」(2026-09-25,卡 J)。手机在外面(直连不通)时,
 * 打字那条「把 X 发我」取文件走这一条:工人来 8791 核单(单子必须是开给这台手机的),
 * 再用 `wb.file` 字节流推过去。**只回「开始推了」**,不等传完 —— 大文件要传好一会儿,
 * 字节到了手机自己知道;推不过去工人另发一条 `file_status` 说原因。
 */
export interface RpcFilePullRequest {
  id: string
  type: 'file_pull'
  offer: string
}

/**
 * 「**我要识别一段录音,编号 id**」(2026-09-25,卡 S)。录音本身随后在 `wb.asr` 字节流上到(流上属性带同一个 id),
 * 工人对上之后交给 8791 的 `/butler/proxy/api/asr`,回包是一条 `type:'http'`。怎么走、为什么见 asrRelay.ts。
 */
export interface RpcAsrRequest {
  id: string
  type: 'asr'
}

/**
 * 「**这一段会议录音交给电脑**」(2026-10-09,卡「会后真机走通」)。录音随后在 `wb.meeting` 字节流上到
 * (流上属性带同一个 id);工人对上之后以那台手机的身份 POST 8791 的 `/meeting/segment`,回包是一条 `type:'http'`。
 * 只在她点过「现在经服务器传」的那一场才发(手机那一侧管)。怎么走见 meetingRelay.ts。
 */
export interface RpcMeetingSegmentRequest {
  id: string
  type: 'meeting_segment'
  meeting_id: string
  seq: number
  ms?: number
}

export type RpcRequest = RpcHttpRequest | RpcRenewRequest | RpcOnboardingRequest | RpcCallRequest | RpcFilePullRequest | RpcAsrRequest | RpcMeetingSegmentRequest

export type RpcResponse =
  | { id: string, type: 'http', status: number, body: unknown }
  /**
   * 续期的回话。`url` / `room` / `route`(2026-10-21,局域网主路):8791 按来路签的那间房,设备拿续到的地址覆盖旧的;
   * 老 8791 不回就缺席(那时与以前一字不差,只有两格)。
   */
  | { id: string, type: 'token', token: string, expires_at: number, url?: string, room?: string, route?: 'lan' | 'relay' }
  /**
   * 引导那条的答复。`leader:'desktop'` = **此刻引导归电脑管**(2026-09-18 拍板
   * 「手机已扫码就优先手机的引导」的另一半:人在电脑上按了「改在电脑上做」时,
   * 手机不该同时也在问)。这时 `ok` 仍是 true(没出错),但工人**不开口**;
   * 手机照这一格显示「电脑上在做,先别说」并给一颗「改回手机」。
   */
  | { id: string, type: 'onboarding', ok: boolean, stage?: string, error?: string, leader?: string }
  | { id: string, type: 'call', ok: boolean, error?: string }
  /** 取件单那一条的答复:`ok` = 开始推了(不是推完了)。 */
  | { id: string, type: 'file_pull', ok: boolean, name?: string, bytes?: number, error?: string }
  | { id: string, type: 'error', error: string }

/** 字幕。工人**广播**给房里所有人(一个房间就是一场对话,不按设备分)。 */
export interface RpcCaption {
  type: 'caption'
  role: 'me' | 'butler'
  text: string
  final: boolean
  /**
   * **这一句的语气**(2026-10-02,卡「声音与形象跟着话走」;只有 `role:'butler'` 有)。
   * 取值是 `tts/tone.ts` 的短列表 id(`calm` / `happy` / `care` / …)。
   *
   * 为什么挂在字幕上、不另开一条信号:字幕正是在「这一句开始出声」那一刻推的
   * (butlerTts 的 `onSpeech`),而表情该变的时刻**就是**那一刻 —— 另开一条只会多一次对时。
   * **字幕文字里绝不含标签**(送进来之前已经 stripToneTags 过)。
   * 模型没写语气就整格缺席;认不得这一格的手机原样忽略。
   */
  tone?: string
}

/**
 * 白名单。**只放手机现在真的用到的那几条 + `/channel/*`**,别的一律 403。
 *
 * 几条刻意**没进**白名单的,理由写在这儿免得下次有人「顺手加上」:
 *
 * - `/butler/proxy/**`(头像包、bundle.zip、TTS 音频):是二进制、而且动辄几 MB。
 *   `wb.rpc` 是一条 JSON 通道,把 zip 塞进来只会把房间的数据通道堵住。远程模式下手机也不需要它 ——
 *   声音是房间里的音频轨,形象包是一次性的大下载,该走别的路(下一步:`wb.file` 或直连)。
 *   **识别另有专门的路**(2026-09-25,卡 S):`type:'asr'` + `wb.asr` 字节流,见 asrRelay.ts。
 *   它不经这张表,也不因此放开 `/butler/proxy/**` 里的任何一条。
 * - `/channel/persona`:里头是他手上**所有**事项的摘要,那是本机工人要的东西,8791 本来就只给回环。
 *   放进白名单也只会换来一个 403,不如明说。
 * - `/channel/start|stop`、`/pair/*`、`/credentials/*`、窗位与本机进程那一堆:改的是信任边界本身或本机状态,
 *   降权之后 8791 也会挡,但**房间里不该连试都能试**。
 */
export const RPC_ALLOWED: readonly { method: RpcMethod, path: string | RegExp }[] = [
  // 看板与快照
  { method: 'GET', path: '/state' },
  // 「今天的待办」换显示(2026-10-12,周三演示):手机出门也能切;8791 那边照旧按设备令牌判 `trusted`。
  { method: 'POST', path: '/today/view' },
  /**
   * ★ **「听懂」那一问**(2026-10-13,卡「三个入口一套管线」):一句话进、一份判定出,
   * **一个字都不办、一行都不写盘**(8791 那条路由自己写着)。电话工人每句转写先问它;
   * 放进白名单是为了**出门(中转)时手机那条路与在家一模一样** —— 三个入口一套管线,
   * 不能因为走了房间代理就退回「手机自己猜」。
   */
  { method: 'POST', path: '/butler/understand' },
  /**
   * ★ **往她日历上记一条发布计划**(2026-10-13 下午,卡 B):`POST /publish/plan`
   * (电话里模型调 `wb_publish_plan` 打它)。放进白名单是为了**出门经中转时与在家一模一样** ——
   * 一条计划记不记得上,不该看她在不在家;8791 那边照旧按设备令牌判 `trusted` + `agentWriteDenied`。
   */
  { method: 'POST', path: '/publish/plan' },
  // 引导(手机上那条对话)
  { method: 'GET', path: '/onboarding' },
  { method: 'GET', path: '/onboarding/turns' },
  { method: 'POST', path: '/onboarding/say' },
  { method: 'POST', path: '/onboarding/restart' },
  { method: 'POST', path: '/onboarding/session' },
  // 谁主导引导(2026-09-18):手机上那颗「改回手机」按它。改的只是界面归属,不是权限。
  { method: 'POST', path: '/onboarding/leader' },
  /**
   * 引导落地(2026-09-24 晚,卡 feat/onboarding-materialize):手机「等你确认」里那张「我照你说的摆好了」——
   * 「就这样」「改一下」出了局域网也要按得动(维护者明天起只带手机)。8791 那边照样认设备令牌降下来的权限。
   */
  { method: 'POST', path: '/onboarding/materialize/preview' },
  { method: 'POST', path: '/onboarding/materialize/apply' },
  /**
   * 挪一张卡(2026-09-22,待拍板 E2:「座机页出了局域网按不动『批准』」)。
   *
   * 座机页上那颗「批准」打的就是这一条(`{id, status:'done'}`)。出了局域网手机够不到
   * 8791,只能走房间代理 —— 而这条以前不在白名单里,于是那颗键在家外面是死的
   * (「稍后」按得动,因为它走的是 `/call/*`)。座机就摆在家里,但**「按不动」是一种失真**:
   * 屏上画着一颗能按的键,按下去什么都没发生。
   *
   * **只开这一条**。`/task/create`、`/task/update`、`/sprint/*`、`/module/*`、`/board/project`
   * 都在 8791 的同一个处理分支下,一条都没进来:这一条开的是「把他已经看见的那张卡挪一格」,
   * 不是「让房间能编看板」。8791 那边照旧按设备令牌判 `trusted` + `agentWriteDenied`,
   * 这里放行不等于那边不判。
   */
  { method: 'POST', path: '/task/move' },
  // 手机协作页按设备身份代理精确生产路由；LAN 配对、connect/receive 和成员管理不开放。
  { method: 'GET', path: '/collab/goal/board' },
  { method: 'GET', path: '/collab/note/activity' },
  { method: 'GET', path: '/collab/relations' },
  { method: 'GET', path: '/collab/runs' },
  { method: 'GET', path: '/collab/capacity' },
  { method: 'GET', path: '/collab/lan/identity' },
  { method: 'GET', path: '/collab/lan/members' },
  { method: 'GET', path: '/collab/lan/channel' },
  { method: 'POST', path: '/collab/goal/create' },
  { method: 'POST', path: '/collab/goal/condition/save' },
  { method: 'POST', path: '/collab/goal/condition/remove' },
  { method: 'POST', path: '/collab/goal/condition/verify' },
  { method: 'POST', path: '/collab/goal/condition/deliver' },
  { method: 'POST', path: '/collab/relation/save' },
  { method: 'POST', path: '/collab/relation/remove' },
  { method: 'POST', path: '/collab/lan/identity' },
  { method: 'POST', path: '/collab/lan/channel/send' },
  { method: 'POST', path: '/collab/note/message' },
  { method: 'POST', path: '/task/comment' },
  { method: 'GET', path: '/collab/relay/studio' },
  { method: 'GET', path: '/collab/relay/channel' },
  /**
   * 事项详情里「现在到哪」那一段的三颗(2026-09-25,卡 N;统筹定「维护者要的就是在手机上派活、验收」):
   *
   *   POST /progress/said   他说一句到哪了 —— 记成口述证据、当场再核那一张;「不做了」「做完了」会照转换表挪卡。
   *   POST /progress/check  「现在核一次」—— 当场按证据重判这一张。代价:**花模型的钱**(一张约一分钱,
   *                         受「每件事上限」那份设置管,一天不超过两倍);他在手机上点的,和电脑上点的同一个口。
   *   POST /item/drive      「派给 X」—— **真派活**。手机上先摆出那一问「这张派给 X 开工?现在:…」
   *                         (与电脑外层卡、卡片弹窗同一句,protocol.ts `dispatchAskText`),他点「派」才发这一条;
   *                         8791 那边照旧按设备令牌判 `trusted` + `agentWriteDenied`,派之前先按证据核一次。
   */
  { method: 'POST', path: '/progress/said' },
  { method: 'POST', path: '/progress/check' },
  { method: 'POST', path: '/item/drive' },
  // 事项
  { method: 'POST', path: '/butler/item' },
  // 1a(2026-10-24):「落地」口 /butler/say —— 与 /butler/item 同一道门(8791 按设备令牌判 trusted)。
  { method: 'POST', path: '/butler/say' },
  { method: 'POST', path: '/butler/item/say' },
  /**
   * 派活的眼睛(2026-09-25,卡 O):手机事项详情里那几颗键,出了局域网也得按得动(9/29 起他只带手机):
   *
   *   POST /butler/item/stop    「停掉这一件」—— 停事务官那条会话 / 杀派给别家的命令行进程 / 不再等窗口里的回答。
   *                             代价:房里的手机能叫停电脑上一件正在跑的活(只停,不起任何东西)。
   *   POST /butler/item/budget  到上限停下来之后「继续 / 停掉这一件 / 换 X 来做」。「继续」让她接着做(再给一档上限),
   *                             「换 X」走下面那条派活路。
   *   POST /dispatch/run        派不出去时他点「换 Codex 来做」:对一张**已经建好**的卡派活,与手机上
   *                             `/butler/item` 带 assignee(点名派活,早就在白名单里)是同一条路、同样的门
   *                             (8791 那边照样按设备令牌判 trusted + agentWriteDenied)。
   *
   * 「登录 Claude」(`/agents/login`)**不进**:它们在这台 Mac 上开窗口,8791 只认回环,手机上只说一句「要在电脑前点」。
   */
  /**
   * 会议(2026-10-09,卡「会后真机走通」):开一场 / 结束 / 看纪要 / 建事项 / 重新来 —— **只有文字**(标题、纪要、待办),
   * 和别的事项文字一样经房间。**录音本身不走这里**:分段是 `type:'meeting_segment'` + `wb.meeting` 字节流,
   * 而且只在她这一场点过「现在经服务器传」时才发(meetingRelay.ts)。`/meeting/segment` 不进白名单。
   */
  { method: 'POST', path: '/meeting/start' },
  { method: 'POST', path: '/meeting/finish' },
  { method: 'GET', path: '/meeting' },
  { method: 'POST', path: '/meeting/apply' },
  { method: 'POST', path: '/meeting/retry' },
  // 会前(2026-10-10,卡「会前画像与预案」):登记、一问一答、预案卡、撤掉登记、会后那一句 —— 都是文字。
  // 花名档案(`/meeting/people*`)**不进**:只在她电脑上看、删。
  { method: 'POST', path: '/meeting/plan' },
  { method: 'POST', path: '/meeting/answer' },
  { method: 'POST', path: '/meeting/card' },
  { method: 'POST', path: '/meeting/drop' },
  { method: 'POST', path: '/meeting/outcome' },
  { method: 'POST', path: '/butler/item/stop' },
  { method: 'POST', path: '/butler/item/budget' },
  { method: 'POST', path: '/dispatch/run' },
  { method: 'GET', path: /^\/butler\/item\/[A-Za-z0-9_-]+\/turns$/ },
  /**
   * 点开「某家在跑的一条会话」(2026-09-25,卡 P;维护者:「事务官中并没有显示会话的标题和内容」)。
   * 手机「各家正在办」点开看标题、项目、在做什么、最近几轮 —— 出了局域网也得看得见。
   * **只读**,而且只认工作台各家接入登记过的会话(按会话 id 找文件,不收路径);回的是洗过的人话。
   * 代价:他自己那几条会话最近几轮的摘录会经中转的房间走一趟(同 `/butler/item/:id/turns` 那一条)。
   */
  { method: 'GET', path: '/sessions/digest' },
  /**
   * 手机读对话(2026-10-01;维护者:「每一个智能体只显示一个最近会话」「往上就没了」「图片、视频、md 都不支持」)。
   * 出门照样要能翻她自己那几条对话 —— 只读,门同上一条(8791 按设备令牌判 trusted):
   *   GET /sessions/history     各家最近 7 天的对话(标题 + 最后一句),分页。
   *   GET /sessions/transcript  一条对话的完整内容,往上翻分页(一页几轮,远小于 1MB 回包上限)。
   *   GET /sessions/attachment  对话里的附件:缩略图 / 一页 / 一段文字 / 512KB 一块(base64 后仍小于 1MB)。
   *                             8791 只给这条会话里出现过的(回到记录里那一行核),不开放任意读盘。
   *                             为什么不走 `wb.file`:那条是「存到手机上」的下载,附件要的是当场看,还要缩略图、逐页、转好的正文。
   * 代价同上一条:她自己会话的内容经中转的房间走一趟(只在她点开的时候)。
   *
   * 2026-10-04(卡「手机看各家对话里的图片和文件」)加的 `view=keep` 走的还是这同一条 ——
   * 它只**开一张取件单**(回单号、名字、大小),字节照旧由 `file_pull` + `wb.file` 那条路推
   * (在家直连 `GET /files/offer/<单号>`)。所以这张名单一个字没变,工人也不用认新路径。
   */
  { method: 'GET', path: '/sessions/history' },
  { method: 'GET', path: '/sessions/transcript' },
  { method: 'GET', path: '/sessions/attachment' },
  /**
   * Agent 登记表的外层那一句(2026-09-25,卡 Q):「新接上一家:XX」上的「这不是 Agent」「知道了」、点开某家会话里的「这不是 Agent」。
   * 出了局域网也得按得动(同「批准」那一条的理由)。改的只是登记表里他说的那一句,8791 那边照旧按设备令牌判 `trusted`。
   * (拿不准的那一家「要接上吗」走的是下面卡 M 的 `/questions/answer`;`/agents/connect` 留着给接口直接用。)
   */
  { method: 'POST', path: '/agents/connect' },
  { method: 'POST', path: '/agents/not-agent' },
  { method: 'POST', path: '/agents/notice/dismiss' },
  /**
   * 各家 logo 的**清单**(2026-09-26,卡 LG3:手机客户端上也要显示各家的 logo)。
   * 回的是 `{ icons: [{ id, etag, bytes }] }` —— 九家不到 1 KB 的 JSON,没有一个图片字节。
   * 手机拿它跟本地存着的那几张对 etag:没变的一张都不重取。**图片本身(`/agents/icon/:id`)不进来** ——
   * 房间这条路只收 JSON,十几 KB 的 PNG 走不了;在外面没存着的那一家退回色点(手机上写着一句人话)。
   */
  { method: 'GET', path: '/agents/icons' },
  /**
   * 别家的会话停着在等他,他在手机上答了(2026-09-25,卡 T「在等你」):工作台把这句话送回那段会话
   * (找得到那段对话才打字;送不回去的如实回一句「这一问得在电脑上的 Claude 里回答」)。出了局域网也得答得了。
   * 8791 那边照旧按设备令牌判 `trusted`。「去回答」(`/sessions/reveal`)只在电脑上,不进来。
   */
  { method: 'POST', path: '/sessions/answer' },
  // 「等你」里那一件他答了(2026-09-28,卡 WQ):点它给的那一项 / 自己说一句 → 电脑替他答进那家窗口。
  { method: 'POST', path: '/asks/answer' },
  /**
   * 那家停在权限弹窗上,手机打开那张卡时读一下弹窗上有哪几颗键(2026-10-01,卡 AP「手机替她批准」)。
   * 维护者 10-01 午饭在外面(走中转)就撞上了:打字批不了权限弹窗,这一条不放行,在外面就看不到「批准 / 拒绝」那两颗键。
   * 只读键名、不按(按走上面 `/asks/answer`);8791 那边照旧按设备令牌判 `trusted`。
   */
  { method: 'POST', path: '/sessions/approval/read' },
  // 「不用管这条」(同一件事的另一颗键):按内容判出来的这一问从「等你」里拿掉。
  { method: 'POST', path: '/sessions/ask/dismiss' },
  /**
   * 手机在某家那条会话的卡片下面直接说一句(2026-09-27,卡 PS;维护者 22:0x:「还得能直接在下面输入信息……
   * 能直接把信息发到这个会话窗口里」)。9/29 起他只带手机,人在外面照样要能往正在跑的那条对话里插一句话 ——
   * 与「答那一问」(上面那条)同一条路、同一只手,只是不要求那条会话此刻在等他。
   * 8791 那边照旧按设备令牌判 `trusted`;送不进去的如实回一句人话(手机原样摆出来)。
   */
  { method: 'POST', path: '/sessions/relay' },
  /**
   * 接着这件事做(2026-10-23,卡 A「同事项接续与动作契约」):手机事项详情里「继续这件事」那一条 —
   * 读来源清单(GET,与 `/butler/item/:id/turns` 同一道门:只读她自己的会话)再把一句发到
   * 选定的来源(POST,与 `/butler/item/say` 同一道门:发她自己的话,送不进去如实回人话)。
   * 出局域网与在家同一个口;8791 那边照旧按设备令牌判 trusted。
   */
  { method: 'GET', path: /^\/butler\/item\/[A-Za-z0-9_-]+\/continue$/ },
  { method: 'POST', path: '/butler/item/continue' },
  /**
   * **手机页面自己报错**(2026-09-25,卡 V)。09-25 晚电脑上点「事务官」没反应、页面卡死,
   * 而没有任何地方记录;手机上同一件事更查不到(他在外面,连不上局域网)。
   * 这一条只往里送**一句话 + 栈的前几行 + 在哪一页**,服务端写日志 + 记最近 20 条,不回任何数据。
   * 报错这条路出了局域网也得通,否则「他在外面点不动」这种最该查的场景恰好一条记录都没有。
   */
  { method: 'POST', path: '/client/error' },
  /**
   * 统一输入框(2026-09-24):四个菜单的数据、换档 / 换模型、「先问我」的批准。
   * 出了局域网也得点得动 —— 「批准」按不动与座机页那颗键是同一种失真。
   * **上传不在这里**:文件在外面走 `wb.file` 字节流进同一个收件文件夹(房间代理只收 JSON)。
   */
  { method: 'GET', path: '/composer/options' },
  { method: 'POST', path: '/composer/choice' },
  { method: 'POST', path: '/approvals/answer' },
  /**
   * 答她问的话(2026-09-25,卡 M 补):手机「等你确认」里那一问,点选项、「我自己说」交上去都是这一条。
   * 她停在那一问上等他,他人在外面就只有手机 —— 卡 M 开这条时没进表,出了局域网一点就 403,
   * 与座机页那颗「批准」同一种「按不动」。8791 那边照旧按设备令牌判 `trusted`,这里放行不等于那边不判。
   */
  { method: 'POST', path: '/questions/answer' },
  // 形象(只是那一份 JSON 配置,不是资产包)
  { method: 'GET', path: '/butler/appearance' },
  // 通话纪要
  { method: 'POST', path: '/butler/call/record' },
  // 本机后端在不在(手机据此决定要不要显示语音那几个键)
  { method: 'GET', path: '/butler/status' },
  // 座机主动来电(2026-09-21):看未接来电、回拨、调座机设置。
  // **只有这三条** —— `/call/claim` 与 `/call/ack` 是工人自己的活,8791 那边只认回环,
  // 放进白名单也只会换来一个 403,不如明说。
  { method: 'GET', path: '/call/log' },
  { method: 'POST', path: '/call/out' },
  // 「清空未接」(2026-09-22):他说「我看过了」,只标记不删台账;出了局域网也得按得动。
  { method: 'POST', path: '/call/missed/clear' },
  { method: 'GET', path: '/call/config' },
  { method: 'POST', path: '/call/config' },
  /**
   * 「把这台座机记到账号下」(2026-09-27,卡 HS)。手机上「设置 → 座机 → 添加座机」最后一步:
   * 蓝牙配网走完,手机请**电脑**拿它自己的账号会话替座机去中转领一把设备令牌,再经 BLE 交给座机。
   *
   * 为什么要进白名单:手机与座机之间是蓝牙(不要局域网),而手机与电脑之间这一下**多半不在同一个网**
   * —— 他站在座机旁边、手机走着流量,或者座机那个网还没配好。这一条走不了房间的话,
   * 整条配网就只能在家里的 Wi-Fi 上做,而那恰恰是最不需要配网的时候。
   *
   * 代价:房里那台配对过的手机能让电脑替**一台它报上来的座机**在账号里登记一次。8791 那边
   * 照旧按设备令牌判 `trusted`,而且只认 `handset-…` 那种形状的编号、种类写死 handset。
   */
  { method: 'POST', path: '/channel/relay-handset' },
  // 资讯(2026-09-21)。**只有这三条 JSON**;`/feed/podcast` 是几 MB 的音频,
  // 按这个文件头部那条规矩不进白名单 —— 音频走 `wb.file`(电脑那边合成完就放进发件目录,
  // 工人下一拍推到手机)。出了局域网点播放会如实说「这条路不走房间代理」。
  //
  // 为什么这三条要进:资讯与播客的用法就是**通勤时听、在路上翻** —— 一个只在家里
  // Wi-Fi 上能打开的「通勤电台」等于没做。它们都是读/轻写,降权之后 8791 那边照样按
  // 设备令牌的权限判(`trusted`),不扩大任何暴露面。
  { method: 'GET', path: '/feed' },
  { method: 'POST', path: '/feed/feedback' },
  { method: 'POST', path: '/feed/config' },
  /**
   * ★ **就一条资讯深聊**(2026-10-13,卡「播客页重做」;8791 那边在 `/feed/dig*`)。
   *
   * 维护者要的是「点一张资讯卡 → 打断播客 → 就这条跟事务官挖下去 → 结论回电脑」,
   * 而这整件事发生的地方正是**通勤路上**(资讯页本来就是为那会儿做的)。
   * 这四条不进来,这个功能就只在家里 Wi-Fi 上成立 —— 和上面那三条同一条理由。
   *
   * 四条都是**窄路**,这正是上面 `/task/create` 那段「不想放宽就放一条窄路」说的那种:
   *   - `/feed/dig`       只收「哪条资讯 + 她这一句 + 刚才几轮」,回一段话。**不建卡、不开会话、不改盘上任何东西**;
   *   - `/feed/dig/note`  只收「哪条 + 结论」,往随手记加一条(来源那一行由 8791 自己拼,手机拼不了);
   *   - `/feed/dig/task`  只收「哪条 + 结论当标题」。**不是 `/task/create`**:项目、desc、来源全由 8791 按那条资讯填,
   *                       房里拿不到「编一整张卡」的能力;
   *   - `/feed/dig/call`  只收「哪条」,记一格「接下来那一通电话是为它打的」(十分钟过期、取一次就清)。
   *
   * 代价照老规矩按「一台配对过的手机在外面能做什么」读:多一条随手记、多一张挂在那条资讯项目上的卡、
   * 多一次模型调用。8791 那边照旧按设备令牌判 `trusted`(`/feed/dig/task` 还过 `agentWriteDenied`),
   * 这里放行不等于那边不判。
   */
  { method: 'POST', path: '/feed/dig' },
  { method: 'POST', path: '/feed/dig/note' },
  { method: 'POST', path: '/feed/dig/task' },
  { method: 'POST', path: '/feed/dig/call' },
  // AIDJ 双主播播客(2026-09-22)。**进来的只有节目单这份 JSON**(几十 KB):
  // 它里头的音频地址是**指向 Aiboo 公网服务器的绝对地址**,手机直接去拉,一个字节都不经这条通道。
  // 所以出了局域网这一版**连播客本身也能听**了 —— 上一条注释里那个「点播放会如实说没有」
  // 的老毛病,只在退回单人口播那条路上还在。
  { method: 'GET', path: '/feed/aidj' },
  { method: 'POST', path: '/feed/aidj/config' },
  /**
   * 需求卡与选题卡 = 指挥台(2026-09-23,中秋断点 A:「手机出了局域网能指挥需求卡」)。
   *
   * 中秋那天他人在外面,对手机说「把座机页的时钟字号调大一号」,事务官建一张需求卡,
   * 之后的**梳理 → 拆解与派活 → 验收 → 记录**这四步都要在手机上推得动、把得了关。
   * 那几条路由的门在 8791 那边(workbench-plugin/src/server/http.ts 的 FEATURE_DECK_PATHS),
   * 这里只管「房间里能不能试」。
   *
   * 放行的逐条与它的代价 —— **代价一律按"一台配对过的手机在外面能做什么"读**:
   *
   *   POST /feature/docs    读回四个页签(需求 / 子事项 / 验收 / 记录)的全文 + 把关记录 + 仓库路径。
   *                         代价:她仓库里 `docs/需求/<名>/` 那几份 .md 的正文会经中转的房间走一趟。
   *                         那是她自己写给自己看的需求,不是凭据;但**确实出了这台 Mac**,记在这里。
   *   POST /feature/run     「让事务官推进这一步」。代价:房里的这台手机能让电脑上的事务官开工
   *                         (拼一段话交给 `butlerSession.say`,与 `/butler/item/say` 同一个口)。
   *                         它**不起任何进程** —— 真去动 Codex / Claude 窗口的是事务官,
   *                         那一层的门在 `/dispatch/*`,一条都没进这张表。
   *   POST /feature/review  把关三键(通过 / 打回带一句话 / 我自己改),每次追加一行 `审核记录.jsonl`。
   *                         代价:房里能往那份留痕里追加,并把「打回」那一句送进事务官的会话。
   *                         只追加、不改写、不删 —— 服务端那一侧就是这么写的。
   *   POST /feature/record  「写进决策记录」:把 `记录.md` 那一节追加进她仓库的 `docs/决策记录.md`。
   *                         代价最重的一条:**房里能让电脑往她的代码仓库里追加一段文字**。
   *                         仍然放,因为第三幕的最后一步就是它,而且服务端把着三道:
   *                         只追加不改写、一模一样的一节不写第二遍、路径只收项目内的相对 .md。
   *   POST /topic/docs|run|review  选题卡那一套,逐条同上(产物在工作目录的 `选题/<名>/`)。
   *                         ★ **今天手机上还没有选题卡页**(这一版只做了需求卡),所以这三条
   *                         暂时没有调用方。仍然放行是统筹这张卡点名要的:选题卡与需求卡是
   *                         同一套指挥台,手机那一页是下一张卡,那时不必再回来改白名单。
   *                         不想留这三条没人用的口子,删掉它们不影响需求卡那四条。
   *
   * **刻意没进这张表的**,理由写在这儿免得下次有人「顺手加上」:
   *
   * - `POST /feature/doc/save` 与 `POST /topic/doc/save`(把一份产物写回文件)。
   *   手机这一版四个页签**只读**(他不在手机上改长文,「我自己改」只留痕、不打开编辑器),
   *   所以今天**没有调用方**。这个文件开头那条规矩是"只放手机现在真的用到的那几条";
   *   放一条没人用的覆写路进来,换来的只是房里多一条能盖掉她仓库里那几份 .md 的口子。
   *   哪天手机上真要贴一版回去,连着那一版的界面一起加,别提前开。
   * - `POST /task/create` / `POST /task/update`(建卡、改卡、改 `feature_stage`)。
   *   于是**手机推不动"下一态"** —— 四态之间那一步今天只能在电脑上点,或者由事务官自己改。
   *   这是明着付的代价:`/task/update` 收的是一整张卡(标题、项目、状态、进度……),
   *   为了推一格进度而把整张卡的编辑权放进房间,和 `/task/move` 那条「只挪一格」的分寸正相反。
   *   要放就放一条**只改这一个字段**的窄路,那是 8791 那边的事,不是在这里放宽。
   * - `/topic/assets` / `/topic/open`(列素材、在 Mac 上打开文件夹):
   *   后者动的是本机屏幕上的一扇窗,房里不该够得到;前者手机上没有用它的界面。
   * - `/dispatch/client` / `/dispatch/api`(直接把话送进 Codex / Claude 的窗口或接口):
   *   ★ 2026-09-23 起 8791 那边**已经给配对设备走了**(「同一个事务官」),但这里仍然不放 ——
   *   理由换成了这个文件开头那条老规矩:**手机上没有调用方**。手机点的是「让事务官推进这一步」,
   *   派哪只手是事务官按技能决定的。哪天手机上真长出「替我按那个窗口」那颗键,连着界面一起加。
   * - `/config/skill/apply` / `/config/ops-skills/apply`(接上事务官的技能):同上,8791 那边
   *   已经给配对设备走,手机上没有那一页。
   *
   * ★ **放行 ≠ 那边给走**(这一条永远成立,别删):白名单是这条链上的**第一道门**,
   * 8791 那边按设备令牌判 `trusted` + `agentWriteDenied` 是第二道,两道各判各的。
   *
   * ☑ 2026-09-23 **第二道门已经开了**:`FEATURE_DECK_PATHS` 与 `TOPIC_DECK_PATHS` 那两处
   * 从 `!loopback` 改成了 `!trusted`(Ben 拍板「同一个事务官」,见
   * docs/设计-同一个事务官-2026-09-23.md)。在那之前这几条按下去一律回一句
   * 「只能在本机操作需求目录 / 选题目录」;现在配对过的手机按得动了。
   */
  { method: 'POST', path: '/feature/docs' },
  { method: 'POST', path: '/feature/run' },
  { method: 'POST', path: '/feature/review' },
  { method: 'POST', path: '/feature/record' },
  /**
   * ★ **发版**(2026-09-23,中秋目标第一节第 5 步)。一颗键 = 全量测试 → ff 合并 main →
   * 跑发版脚本 → 触发热更新。**这是这张表里最重的一条**,而且 Ben 是明知地点头的:
   * 「手机在外面按一下会合并 main 并发一版」。
   *
   * 三件事把着它,缺一不可:
   *   ① 手机那一侧的**二次确认**(「会合并并发一版,确定?」)—— 重的动作靠界面上那一下,
   *      不靠"只认本机"把她自己挡在外面(设计-同一个事务官 第四节);
   *   ② 8791 那边 `/feature/ship` 自己的判据与硬边界(不改 deploy/、失败就停、每步留痕);
   *   ③ 房间本身要有设备令牌才进得来,陌生来源连白名单都摸不到。
   */
  { method: 'POST', path: '/feature/ship' },
  { method: 'POST', path: '/topic/docs' },
  { method: 'POST', path: '/topic/run' },
  { method: 'POST', path: '/topic/review' },
  // 通道层自己
  { method: 'GET', path: '/channel/status' },
  { method: 'POST', path: '/channel/token' },
  /**
   * 设备目录与传输记录(2026-09-21)。手机的记录面板读这两条 —— 远程模式下它够不到 8791,
   * 得经房间代理。**两条都只读**:写那一头(`POST /channel/devices`)只认回环,
   * 白名单里根本没有它,所以房里的谁都改不了这张表。
   */
  { method: 'GET', path: '/devices/online' },
  { method: 'GET', path: '/devices/transfers' },
  /**
   * ★ **等她点的那几张取文件的卡 + 她自己报的回执**(2026-10-04,卡 `claude/phone-file-send-loop`)。
   *
   * 事务官找到文件之后由 8791 把卡摆在那台手机名下(`fileDelivery.ts`),手机每隔几秒问一次
   * `GET /files/pending` —— 出门时它够不到 8791,得经这里代理;收完写进盘、sha256 对上了
   * 再 `POST /files/received` 报一句,那是三条回执路里最真的一条。
   *
   * 两条都**只关这台设备自己的事**:8791 那边按设备令牌降下来的权限判(单子只认开给它的那台),
   * 这里放行不等于那边不判。
   */
  { method: 'GET', path: '/files/pending' },
  { method: 'POST', path: '/files/received' },
  /**
   * ★ **「看过了」那两下**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   *
   * 「问一句」的答案摆在手机球下那一行字幕,交代的事办完先挂一条「刚办完 · 结果一句话」;
   * 她点开看过 / 划掉都要报回 8791 —— 服务端只有那一格(`seen_at` / `seen_result_at`),
   * **两端同步靠的就是它**。出门时手机够不到 8791,得经这里代理;
   * 不开这两条的下场是「她在外面看过了,回到家电脑上那几条还亮着」。
   *
   * 两条都**只改一个布尔意义上的时刻**,不改状态、不改内容、不回任何数据:
   * `/task/seen-result` **不是** `/task/move`(状态还是 `done`,2026-09-09 那张七态表一个字没动)。
   * 8791 那边照样按设备令牌降下来的权限判(`trusted`),这里放行不等于那边不判。
   */
  { method: 'POST', path: '/answers/seen' },
  { method: 'POST', path: '/task/seen-result' },
  /**
   * 她记住的规矩(2026-09-24 晚,卡 K):手机设置里那张表出了局域网也得看得见、删得动、改得了
   * (维护者 9/29 起只带手机)。**只开看、写一条、改、删、恢复**;导入、反馈、自查是电脑那边的事,不进房间。
   * 8791 那边照样按设备令牌降下来的权限判(`trusted`),这里放行不等于那边不判。
   */
  { method: 'GET', path: '/butler/rules' },
  { method: 'POST', path: '/butler/rules' },
  { method: 'POST', path: '/butler/rules/update' },
  { method: 'POST', path: '/butler/rules/remove' },
  { method: 'POST', path: '/butler/rules/restore' },
  /**
   * 「它学到了什么」(2026-10-09):手机设置里那一页出了局域网也得看得见、撤得掉。
   * **只开看习惯、撤一条、读进化日志**;学一遍、进化循环的写路(扫、做、撤固化)是电脑那边的事,不进房间。
   * 8791 那边 `/habits/revoke` 照样只认她本人(配对过的手机算),这里放行不等于那边不判。
   */
  { method: 'GET', path: '/habits' },
  { method: 'POST', path: '/habits/revoke' },
  { method: 'GET', path: '/evolve/log' },
  /**
   * 撤错了恢复一条、收件箱「新学到一条」那一句点「知道了」(2026-10-10)。8791 那边同 revoke 只认她本人。
   */
  { method: 'POST', path: '/habits/restore' },
  { method: 'POST', path: '/habits/seen' },
  /**
   * 发诊断包(2026-10-21,内测发版底座):手机设置里那颗键,出门也得按得动 —— 出了事她多半正在外面。
   * 进来的只是「打个包」这一句、回去的只是编号与「包在哪」;**包本身由电脑直接 POST 给中转,不经房间**
   * (同上面 `/butler/proxy/**` 不进白名单的那条理由:二进制不走这条 JSON 通道)。
   * 8791 那边按设备令牌判 `trusted`;打包要几十秒,所以那条路起作业立刻回,手机隔一会儿 GET 一次。
   */
  { method: 'POST', path: '/diag/send' },
  { method: 'GET', path: '/diag/send' },
]

/**
 * 路径规整:去掉 query、拒绝任何带 `..` 或不以 `/` 开头的东西。
 * 回的是 `{ path, query }` —— 白名单按 path 比,转发时把 query 原样带上(`/onboarding/turns?after=`)。
 */
export function splitPath(raw: string): { path: string, query: string } | undefined {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return undefined
  const cut = raw.indexOf('?')
  const path = cut < 0 ? raw : raw.slice(0, cut)
  const query = cut < 0 ? '' : raw.slice(cut)
  // `..` 与 `//` 都可能被下游当成别的路径,直接拒;白名单是按字符串比的,不能让它绕过去。
  if (path.includes('..') || path.includes('//') || path.includes('\\')) return undefined
  return { path, query }
}

/** 这条 method + path 在不在白名单里。 */
export function isAllowedRpcPath(method: string, path: string): boolean {
  return RPC_ALLOWED.some(rule => rule.method === method
    && (typeof rule.path === 'string' ? rule.path === path : rule.path.test(path)))
}

/**
 * 一行 JSON → 一条请求。**认不出来就说认不出来**,连 id 都读不到就连回都不回
 * (回不到人身上,发出去只是噪音)。
 */
export function parseRpcRequest(text: string): { ok: true, request: RpcRequest } | { ok: false, id?: string, error: string } {
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { return { ok: false, error: '不是合法 JSON' } }
  if (raw === null || typeof raw !== 'object') return { ok: false, error: '不是一个对象' }
  const message = raw as Record<string, unknown>
  const id = typeof message.id === 'string' && message.id !== '' ? message.id : undefined
  if (id === undefined) return { ok: false, error: '缺 id' }
  if (message.type === 'renew') return { ok: true, request: { id, type: 'renew' } }
  if (message.type === 'asr') return { ok: true, request: { id, type: 'asr' } }
  if (message.type === 'meeting_segment') {
    const meetingId = typeof message.meeting_id === 'string' ? message.meeting_id.trim() : ''
    const seq = message.seq
    if (meetingId === '' || meetingId.length > 200) return { ok: false, id, error: '会议分段那条得带是哪一场(meeting_id)' }
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return { ok: false, id, error: '会议分段那条的段号得从 1 开始' }
    const ms = typeof message.ms === 'number' && Number.isFinite(message.ms) && message.ms > 0 ? Math.round(message.ms) : undefined
    return { ok: true, request: { id, type: 'meeting_segment', meeting_id: meetingId, seq, ...(ms === undefined ? {} : { ms }) } }
  }
  if (message.type === 'file_pull') {
    const offer = typeof message.offer === 'string' ? message.offer.trim() : ''
    if (offer === '' || offer.length > 200) return { ok: false, id, error: '取文件那条得带取件单号(offer)' }
    return { ok: true, request: { id, type: 'file_pull', offer } }
  }
  if (message.type === 'call') {
    const action = typeof message.action === 'string' ? message.action : ''
    if (!CALL_RPC_ACTIONS.includes(action)) {
      return { ok: false, id, error: `通话这条只认 ${CALL_RPC_ACTIONS.join(' / ')},不认识 ${String(message.action)}` }
    }
    const callId = typeof message.call_id === 'string' ? message.call_id.trim() : ''
    if ((action === 'answer' || action === 'later') && callId === '') {
      return { ok: false, id, error: '接起 / 稍后这两条得带 call_id' }
    }
    // 新包的 `start`/`answer` 带这一格(卡 CF 第 4 条):接起之后它会发一条 `playing`。
    const reportsPlaying = message.reports_playing === true
    // 新包的 `playing` 还带它自己烘热输出等了多久(卡 OP):只进日志,不合理的数当没带。
    const warmRaw = message.warm_ms
    const warmMs = typeof warmRaw === 'number' && Number.isFinite(warmRaw) && warmRaw >= 0 && warmRaw <= 60_000
      ? Math.round(warmRaw)
      : undefined
    return {
      ok: true,
      request: {
        id,
        type: 'call',
        action: action as CallRpcAction,
        ...(callId === '' ? {} : { call_id: callId }),
        ...(reportsPlaying ? { reports_playing: true as const } : {}),
        ...(warmMs === undefined ? {} : { warm_ms: warmMs }),
      },
    }
  }
  if (message.type === 'onboarding') {
    const action = typeof message.action === 'string' ? message.action : ''
    if (!ONBOARDING_RPC_ACTIONS.includes(action)) {
      return { ok: false, id, error: `引导这条只认 ${ONBOARDING_RPC_ACTIONS.join(' / ')},不认识 ${String(message.action)}` }
    }
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (action === 'say' && text === '') return { ok: false, id, error: '打字那条得带 text' }
    return {
      ok: true,
      request: { id, type: 'onboarding', action: action as OnboardingRpcAction, ...(text === '' ? {} : { text }) },
    }
  }
  if (message.type !== 'http') return { ok: false, id, error: `不认识这种请求:${String(message.type)}` }
  const method = typeof message.method === 'string' ? message.method.toUpperCase() : ''
  if (!METHODS.includes(method)) return { ok: false, id, error: `不认识这个方法:${String(message.method)}` }
  if (typeof message.path !== 'string') return { ok: false, id, error: '缺 path' }
  return {
    ok: true,
    request: {
      id,
      type: 'http',
      method: method as RpcMethod,
      path: message.path,
      ...(message.body === undefined || message.body === null ? {} : { body: message.body }),
    },
  }
}

/**
 * 这个参与者是哪台设备。**属性优先**(凭证里签的,原样;identity 里那份被清洗过,可能对不上),
 * 退而求其次从 identity 前缀拆。不是手机就 undefined —— 房里的测试页、别的什么东西都够不到 8791。
 */
export function deviceIdOfParticipant(participant: { identity?: string, attributes?: Record<string, string> }): string | undefined {
  const identity = participant.identity ?? ''
  if (!identity.startsWith(PHONE_IDENTITY_PREFIX)) return undefined
  const signed = participant.attributes?.[DEVICE_ATTRIBUTE]
  if (typeof signed === 'string' && signed.trim() !== '') return signed.trim()
  const suffix = identity.slice(PHONE_IDENTITY_PREFIX.length)
  return suffix === '' ? undefined : suffix
}

/**
 * 凭证里带「这台是什么」的属性名(2026-09-21,座机形态:手机 + 树莓派话筒)。
 * 与 workbench-plugin/src/server/channel.ts 的 `CHANNEL_KIND_ATTRIBUTE` 同一个字符串。
 */
export const KIND_ATTRIBUTE = 'wb_kind'

/** 房里那位是什么。`handset` = 树莓派上那只实体话筒;别的(含缺省)都当手机。 */
export type ParticipantKind = 'phone' | 'handset'

export function participantKindOf(participant: { attributes?: Record<string, string> }): ParticipantKind {
  // **缺省是 phone**:老手机的凭证里没有这一项,而它们本来就是手机。
  // 认不出来的值也当手机 —— 把一台看不懂的设备当成听筒,会把通话的声音送错地方。
  return participant.attributes?.[KIND_ATTRIBUTE] === 'handset' ? 'handset' : 'phone'
}

/**
 * **这一通的声音跟谁走**(2026-09-21,docs/设计-座机信号协议-2026-09-21.md §四)。
 *
 * 座机形态下房里同时有两台本账号的设备:手机(外壳里、无线充,管屏和 App)和
 * 树莓派话筒(管送话/受话)。麦克风只能接一位(声音这条链一次只服务一个人,
 * 见 agent.ts 里 relinkSpeaker 那段注释),所以要有一条**写死的、说得出理由的**挑法:
 *
 *   ① 现任还在房里就不换 —— 他正说着话,不该被后进来的人抢走(这条是老的);
 *   ② 有听筒就跟听筒走 —— 他拿起了一只实体话筒,声音当然从那只话筒进出;
 *      手机在这种时候只显示字幕与按钮,不推自己的麦克风(那一半在手机那边);
 *   ③ 没有听筒就跟手机走(老行为,逐字不变);
 *   ④ 都没有就随便挑一个(房里可能只有测试页)。
 *
 * **不按「谁先接起」挑**:接起那条 `call/answer` 走的是 `wb.rpc`,它跟音频是两条链,
 * 而这个函数在 `ParticipantConnected` / `Disconnected` 上也要跑一遍 —— 那时候
 * 压根没有"刚才谁接的"这回事。一条规则在所有时刻都给同一个答案,才不会出现
 * "他拿着听筒说话,而她在听手机"这种没法复现的毛病。
 */
export function pickSpeaker(
  identities: readonly string[],
  kindOf: (identity: string) => ParticipantKind,
  bound?: string,
): string | undefined {
  if (bound !== undefined && identities.includes(bound)) return bound
  const handset = identities.find(id => id.startsWith(PHONE_IDENTITY_PREFIX) && kindOf(id) === 'handset')
  if (handset !== undefined) return handset
  return identities.find(id => id.startsWith(PHONE_IDENTITY_PREFIX)) ?? identities[0]
}

/** 工人替手机去 8791 要的那两件事。agent.ts 传真的进来,测试传假的。 */
/** 引导模式的开关(agent.ts 里那一层接上来;handleRpcRequest 自己不认识 LiveKit)。 */
export interface RpcOnboardingPort {
  /**
   * 开始 / 接着做引导。回一句人话 —— 接不上(没配记忆仓库、没有模型 key)要如实说。
   * `leader:'desktop'` = 这会儿引导归电脑管,**工人一个字都不说**(见 RpcResponse 上那段注释)。
   *
   * `by` 是**打这一通引导的那一台**(2026-09-25,卡 fix/evening-gaps):工人把接话对象钉到它身上、
   * 只订它的麦克风 —— 与普通通话 `greet` / 来电 `answer` 同一条规矩(谁打的电话就听谁)。
   * 09-24 晚房里先有一个测试页,接话对象一直钉在测试页上,小米那一通的声音根本没人听。
   */
  begin: (resume: boolean, by?: { identity: string, kind: ParticipantKind }) => Promise<{ ok: boolean, stage?: string, error?: string, leader?: string }>
  /** 打字备胎:这句话当成他说的。 */
  say: (text: string) => Promise<{ ok: boolean, error?: string }>
  /** 挂断:暂停引导。 */
  stop: () => Promise<void>
}

/** 普通通话那条(2026-09-18)。招呼由打电话的那一头点名要,工人不再进房就说。 */
export interface RpcCallPort {
  /**
   * 打个招呼(persona.welcome)。说不出去(没有接话模型)要如实说一句。
   *
   * `by` 是**这一通是谁拨的**(2026-09-23,提机即拨出)。座机形态下房里同时有手机和
   * 那只树莓派听筒:他从听筒拨出去,她的招呼就该从那只听筒里出来。和 `answer` 一样,
   * 身份与种类都来自凭证里签的属性,不是设备在消息里自称的。
   *
   * **可选**:老手机(还没更新的那个包)发的 `start` 不带身份,那时退回 `pickSpeaker`
   * 那三条老规矩 —— 宁可沿用老行为,也不拿一个编出来的身份去钉接话对象。
   */
  /**
   * `callId`(2026-10-22):手机 `start` 带来的这一通的编号。工人报记录时带它,手机挂断报的也带它,
   * 8791 并成一份(决策记录同日「通电话是记录不是事项」)。老手机不带 → 工人自己编一个。
   */
  greet: (by?: { identity: string, kind: ParticipantKind }, callId?: string) => Promise<{ ok: boolean, error?: string }>
  /**
   * **接起一通主动来电**(2026-09-21)。她这才开口(「我打给你是因为…」)。
   * 对不上正在响的那一通就如实回一句 —— 铃可能刚好在他按下去那一刻超时了。
   *
   * `by` 是**哪一台接的**(2026-09-22 晚):身份与种类都来自凭证里签的属性,
   * 不是设备在消息里自称的(房里的自称一个字都不能信,同 hangup 那条的理由)。
   * 工人拿它做两件事:①把接话对象钉到这一台上(谁接谁说话);
   * ②把它写进 `ring_end{answered}` 的广播里,让房里另一台知道「这通不归我出声」。
   */
  answer: (callId: string, by?: { identity: string, kind: ParticipantKind }) => Promise<{ ok: boolean, error?: string }>
  /** 「稍后」:当未接记,**不重拨**(理由见 workbench-plugin/src/server/callOut.ts 第 4 条)。 */
  later: (callId: string) => Promise<{ ok: boolean, error?: string }>
  /**
   * 这通电话他挂了(2026-09-21)。换回平时那套人设,排着的下一通这就响。
   * **可选** —— 老手机(还没更新的那个包)挂断时不发这一条,工人靠「手机离开房间」兜底。
   *
   * `by` 是**发这一条的那台设备是什么**(2026-09-22,待拍板 E1):树莓派话筒挂机
   * (`handset`)时工人要往房里广播一条 `ring_end{outcome:'hung_up'}`,手机才收得掉
   * 屏上那面「字幕 + 挂断」;手机自己挂的(`phone`)不广播 —— 它本来就知道。
   */
  hangup?: (by: ParticipantKind) => Promise<{ ok: boolean, error?: string }>
  /**
   * **这台手机接起之后会报「我在放了」**(2026-09-28,卡 CF 第 4 条)。
   * `start` / `answer` 带着 `reports_playing` 时先叫这一下,开场白才会去等那条 `playing`;
   * 没叫过就一个字都不等(老手机)。**可选**:老工人 / 用例里的假件没有它。
   */
  expectPlaying?: (identity: string) => void
  /**
   * 手机说「**我这边在放了**」(`action:'playing'`)。工人的开场白在等的就是它。
   * **可选**,同上。
   */
  playing?: (identity: string, warmMs?: number) => Promise<{ ok: boolean, error?: string }>
}

/** 取文件那一头(2026-09-25,卡 J)。agent.ts 传真的进来(8791 核单 + 房间推字节),测试传假的。 */
export interface RpcFilesPort {
  /**
   * 核一张取件单,核过了就**开始**推给这台手机(不等推完)。回的是「开始推了没有」。
   * `identity` 是发这一条的那台手机在房里的身份 —— 字节推给它,不推给别人。
   */
  pull: (input: { offer: string, deviceId: string, identity: string }) => Promise<{ ok: boolean, name?: string, bytes?: number, error?: string }>
}

/** 识别那一头(2026-09-25,卡 S)。实现见 asrRelay.ts 的 createAsrRelay;回的是 8791 原样的 status + body。 */
export interface RpcAsrPort {
  transcribe: (input: { id: string, deviceId: string, identity: string }) => Promise<{ status: number, body: unknown }>
}

/** 会议分段那一头(2026-10-09)。实现见 meetingRelay.ts 的 createMeetingRelay;回的是 8791 原样的 status + body。 */
export interface RpcMeetingPort {
  segment: (input: { id: string, deviceId: string, identity: string, meetingId: string, seq: number, ms?: number }) => Promise<{ status: number, body: unknown }>
}

export interface RpcWorkbenchPort {
  /** 以**那台设备的身份**调 8791。实现见 workbench.ts:带 X-Workbench-Channel-Device。 */
  callAsDevice: (input: {
    deviceId: string
    method: RpcMethod
    path: string
    body?: unknown
  }) => Promise<{ status: number, body: unknown }>
  /** 替那台设备续一张进房凭证(8791 的 /channel/token,同样是降权调用)。2026-10-21 起可能多带地址三格。 */
  renewTicket: (deviceId: string) => Promise<
    { token: string, expires_at: number, url?: string, room?: string, route?: 'lan' | 'relay' } | { error: string, status: number }
  >
}

/**
 * 一条请求 → 一条回包。**绝不抛**:房里来的东西什么样都可能,抛出去会把工人带走。
 *
 * `deviceId` 由调用方(agent.ts)从参与者身份算好再传进来 —— 这个函数不认识 LiveKit。
 */
export async function handleRpcRequest(
  request: RpcRequest,
  ctx: {
    deviceId: string
    workbench: RpcWorkbenchPort
    onboarding?: RpcOnboardingPort
    call?: RpcCallPort
    /** 取文件(2026-09-25)。不传 = 这个工人不管取文件(第二台电脑、老接线),如实回一句。 */
    files?: RpcFilesPort
    /** 识别(2026-09-25,卡 S)。不传 = 这个工人没接识别这条路,如实回一句。 */
    asr?: RpcAsrPort
    /** 会议分段(2026-10-09)。不传 = 这个工人没接这条路,如实回一句。 */
    meeting?: RpcMeetingPort
    /**
     * 发这一条的那台设备是什么(2026-09-22)。**缺省是 `phone`** —— 老手机的凭证里
     * 没有 `wb_kind`,而它们本来就是手机(同 {@link participantKindOf} 的缺省)。
     * 今天只有挂断那一条用得上它:挂机要不要往房里广播,取决于挂的是哪一台。
     */
    kind?: ParticipantKind
    /**
     * **这一条是谁发的**(2026-09-22 晚)。接起那一条要用它把接话对象钉到这一台上
     * —— 座机形态下房里同时有手机和听筒,「谁接的」和「声音跟谁走」必须是同一台。
     */
    identity?: string
  },
): Promise<RpcResponse> {
  if (request.type === 'asr') {
    // 回包与 http 代理同一个形状(status + body):手机照直连 `/butler/proxy/api/asr` 的口径读。501 = 这里没接这条路。
    if (ctx.asr === undefined || ctx.identity === undefined) {
      return { id: request.id, type: 'http', status: 501, body: { error: '电脑上的通话组件这会儿转不了文字(没接上识别这条路)' } }
    }
    try {
      const done = await ctx.asr.transcribe({ id: request.id, deviceId: ctx.deviceId, identity: ctx.identity })
      return { id: request.id, type: 'http', status: done.status, body: done.body }
    }
    catch {
      return { id: request.id, type: 'http', status: 502, body: { error: '这一段没识别成' } }
    }
  }
  if (request.type === 'meeting_segment') {
    if (ctx.meeting === undefined || ctx.identity === undefined) {
      return { id: request.id, type: 'http', status: 501, body: { error: '电脑上的事务官还是旧版本,在外面传不了会议录音' } }
    }
    try {
      const done = await ctx.meeting.segment({
        id: request.id, deviceId: ctx.deviceId, identity: ctx.identity, meetingId: request.meeting_id, seq: request.seq,
        ...(request.ms === undefined ? {} : { ms: request.ms }),
      })
      return { id: request.id, type: 'http', status: done.status, body: done.body }
    }
    catch {
      return { id: request.id, type: 'http', status: 502, body: { error: '这一段没传成' } }
    }
  }
  if (request.type === 'file_pull') {
    if (ctx.files === undefined || ctx.identity === undefined) {
      return { id: request.id, type: 'file_pull', ok: false, error: '电脑上的事务官这会儿推不了文件(工人没接上取文件这条路)' }
    }
    try {
      const started = await ctx.files.pull({ offer: request.offer, deviceId: ctx.deviceId, identity: ctx.identity })
      return {
        id: request.id,
        type: 'file_pull',
        ok: started.ok,
        ...(started.name === undefined ? {} : { name: started.name }),
        ...(started.bytes === undefined ? {} : { bytes: started.bytes }),
        ...(started.error === undefined ? {} : { error: started.error }),
      }
    }
    catch (err) {
      return { id: request.id, type: 'file_pull', ok: false, error: (err as Error)?.message ?? '没推出去,也没说原因' }
    }
  }
  if (request.type === 'call') {
    // 没有接话模型时压根没有嘴:如实说一句,别让手机以为她在打招呼。
    if (ctx.call === undefined) {
      return { id: request.id, type: 'call', ok: false, error: '电脑上的事务官现在接不了话(没有接话模型)' }
    }
    // identity 问不出来就不带 by:宁可退回老行为(按 pickSpeaker 那三条挑),
    // 也不拿一个编出来的身份去钉接话对象。接起(answer)与拨出(start)用的是同一个。
    const by = ctx.identity === undefined
      ? undefined
      : { identity: ctx.identity, kind: ctx.kind ?? ('phone' as ParticipantKind) }
    /*
     * **这台手机说它接起之后会报「在放了」**(2026-09-28,卡 CF 第 4 条):记在这一通上,
     * 开场白据此决定等不等那条 `playing`。身份是凭证里签的(同 `by`),不是消息里自称的。
     */
    if (request.reports_playing === true && ctx.identity !== undefined) {
      try { ctx.call.expectPlaying?.(ctx.identity) } catch { /* 记不上就退回「不等」,不许因此接不了电话 */ }
    }
    try {
      if (request.action === 'playing') {
        if (ctx.identity === undefined) return { id: request.id, type: 'call', ok: false, error: '不知道这条是哪台设备发的' }
        const told = await (ctx.call.playing?.(ctx.identity, request.warm_ms) ?? Promise.resolve({ ok: true, error: undefined }))
        return { id: request.id, type: 'call', ok: told.ok, ...(told.error === undefined ? {} : { error: told.error }) }
      }
      const done = request.action === 'answer'
        ? await ctx.call.answer(request.call_id ?? '', by)
        : request.action === 'later'
          ? await ctx.call.later(request.call_id ?? '')
          : request.action === 'hangup'
            ? await (ctx.call.hangup?.(ctx.kind ?? 'phone') ?? Promise.resolve({ ok: true, error: undefined }))
            // `start`:手机点通话键、或者**他从听筒里拨出去**(2026-09-23 提机即拨出)。
            // 带上 `by`,她的招呼才从拨这一通的那一台里出来。
            : request.call_id === undefined ? await ctx.call.greet(by) : await ctx.call.greet(by, request.call_id)
      return { id: request.id, type: 'call', ok: done.ok, ...(done.error === undefined ? {} : { error: done.error }) }
    }
    catch (err) {
      return { id: request.id, type: 'call', ok: false, error: (err as Error)?.message ?? '这一条没办成' }
    }
  }
  if (request.type === 'onboarding') {
    // 没接引导模式(没有模型 key、或者这台工作台没配记忆仓库):如实说一句,别让手机以为接上了。
    if (ctx.onboarding === undefined) {
      return { id: request.id, type: 'onboarding', ok: false, error: '电脑上的事务官现在接不了引导(没有接话模型,或者工作台没配记忆仓库)' }
    }
    try {
      if (request.action === 'stop') {
        await ctx.onboarding.stop()
        return { id: request.id, type: 'onboarding', ok: true }
      }
      if (request.action === 'say') {
        const said = await ctx.onboarding.say(request.text ?? '')
        return { id: request.id, type: 'onboarding', ok: said.ok, ...(said.error === undefined ? {} : { error: said.error }) }
      }
      // 谁打的这一通引导(与 call 那一支同一个 by):工人据此只听这一台。问不出身份就不带,退回老行为。
      const by = ctx.identity === undefined
        ? undefined
        : { identity: ctx.identity, kind: ctx.kind ?? ('phone' as ParticipantKind) }
      const begun = await ctx.onboarding.begin(request.action === 'resume', by)
      return {
        id: request.id,
        type: 'onboarding',
        ok: begun.ok,
        ...(begun.stage === undefined ? {} : { stage: begun.stage }),
        ...(begun.error === undefined ? {} : { error: begun.error }),
        ...(begun.leader === undefined ? {} : { leader: begun.leader }),
      }
    }
    catch (err) {
      return { id: request.id, type: 'onboarding', ok: false, error: (err as Error)?.message ?? '引导没接上' }
    }
  }
  if (request.type === 'renew') {
    let result: Awaited<ReturnType<RpcWorkbenchPort['renewTicket']>>
    try { result = await ctx.workbench.renewTicket(ctx.deviceId) }
    catch { return { id: request.id, type: 'error', error: '工作台连不上,这张凭证续不了' } }
    if ('error' in result) return { id: request.id, type: 'error', error: result.error }
    return {
      id: request.id,
      type: 'token',
      token: result.token,
      expires_at: result.expires_at,
      ...(result.url === undefined ? {} : { url: result.url }),
      ...(result.room === undefined ? {} : { room: result.room }),
      ...(result.route === undefined ? {} : { route: result.route }),
    }
  }

  const split = splitPath(request.path)
  if (split === undefined) {
    return { id: request.id, type: 'http', status: 400, body: { error: `这个路径不合法:${request.path}` } }
  }
  if (!isAllowedRpcPath(request.method, split.path)) {
    // 403 而不是 404:如实说「这条路不给走」,不假装它不存在。
    return {
      id: request.id,
      type: 'http',
      status: 403,
      body: { error: `${request.method} ${split.path} 不在房间代理的白名单里` },
    }
  }
  try {
    const result = await ctx.workbench.callAsDevice({
      deviceId: ctx.deviceId,
      method: request.method,
      path: `${split.path}${split.query}`,
      ...(request.body === undefined ? {} : { body: request.body }),
    })
    return { id: request.id, type: 'http', status: result.status, body: result.body }
  }
  catch {
    return { id: request.id, type: 'http', status: 502, body: { error: '工作台连不上' } }
  }
}

/** 不是配对过的手机发来的那句话(房间代理一条都不代办)。 */
export const RPC_NOT_PAIRED_TEXT = '房间代理只替已配对的手机办事'

/**
 * 不是配对过的手机发来一条请求时回什么(2026-09-25,卡 fix/evening-gaps)。
 *
 * 以前一律回 `http 403`。手机那头对「引导」「通话」只认同类回包,于是把这条 403 丢掉、干等 15 秒超时 ——
 * 小米测试机配对后那一通引导就卡在「正在接通…」,老包那时麦克风已经开着。
 * 现在引导 / 通话 / 取文件回**同类**的一条 `ok:false`(老手机包也认,当场收场),其余照旧 `http 403`。
 */
export function notPairedResponse(request: RpcRequest): RpcResponse {
  if (request.type === 'onboarding') return { id: request.id, type: 'onboarding', ok: false, error: RPC_NOT_PAIRED_TEXT }
  if (request.type === 'call') return { id: request.id, type: 'call', ok: false, error: RPC_NOT_PAIRED_TEXT }
  if (request.type === 'file_pull') return { id: request.id, type: 'file_pull', ok: false, error: RPC_NOT_PAIRED_TEXT }
  return { id: request.id, type: 'http', status: 403, body: { error: RPC_NOT_PAIRED_TEXT } }
}

/** 回包 → 一行 JSON。太大就换成一条 413,**不发一个半截的 JSON 过去**。 */
export function encodeRpcResponse(response: RpcResponse): string {
  const text = JSON.stringify(response)
  if (Buffer.byteLength(text, 'utf8') <= RPC_MAX_RESPONSE_BYTES) return text
  return JSON.stringify({
    id: response.id,
    type: 'http',
    status: 413,
    body: { error: '回包太大,这条路送不过去' },
  })
}

/** 字幕 → 一行 JSON。 */
export function encodeCaption(caption: RpcCaption): string {
  return JSON.stringify(caption)
}
