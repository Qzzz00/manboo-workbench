/**
 * 通道层的协议(2026-09-17,docs/设计-手机通道层-2026-09-17.md)——**手机这一侧的那一半**。
 *
 * 一句话:手机与电脑之间只留一条通道 = 一个 LiveKit 房间。声音走音频轨;
 * 所有原来发给 8791 的 HTTP 请求,在出了局域网之后改走房间的数据通道,由 Mac 上的工人代理。
 *
 * 这个文件里**只有纯函数**:字节进、对象出。真正连房间的在 roomLink.ts,
 * 请求配对在 rpc.ts,两条路怎么选在 routedClient.ts。
 *
 * 协议是与 Mac 侧那张卡共同约定的,**逐字照此实现**(改这里就必须同时改那边):
 *
 *   控制通道 topic `wb.rpc`,走的是 LiveKit 的**文本数据流**(`sendText` / `registerTextStreamHandler`),
 *   **不是** `publishData` —— 单个数据包有 15KB 上限,`/state` 一份快照远不止;文本流由框架自动分块重组。
 *   (这一条是对着 Mac 侧 channel-worker/src/rpc.ts 的文件头对齐的,两端必须一致,否则谁都收不到谁。)
 *   一条消息就是一行 JSON:
 *     请求 { id, type:'http', method:'GET|POST|PUT|DELETE', path:'/state', body: <json|null> }
 *     响应 { id: <同 id>, type:'http', status: 200, body: <json> }
 *     续期 { id, type:'renew' } → { id, type:'token', token, expires_at: <unix 秒> }
 *     字幕 { type:'caption', role:'me'|'butler', text, final, tone? }(工人**广播**给房里所有人;`tone` 2026-10-02)
 *     应声 { type:'backchannel', round, at, line? }(工人**广播**:他说得久了,这台手机本地插一声「嗯」)
 *     办不成 { id, type:'error', error:'…' }(工人那边连 8791 都没连上一类)
 *     识别 { id, type:'asr' } + `wb.asr` 字节流(属性 wb_asr_id = id)→ { id, type:'http', status, body }(2026-09-25,卡 S)
 *   文件 topic `wb.file`(LiveKit byte stream)。
 *   工人身份固定 `wb-channel-worker`,**只认它发来的响应**。
 *
 * 文件 topic:协议定的是 `wb.file`(点),原型工人一度用的是 `wb-file`(中横线)。
 * 手机发件按协议发 `wb.file`,**收件两个都收**(见 WBCH_FILE_TOPICS),这样谁先改都不至于断。
 *
 * 解析一律「解不出就 null」:这是网络上来的东西,一次抛异常就能把整条通道带走。
 */

// ———————————————————————— 约定的那几个字符串 ————————————————————————

/** 控制 / 续期 / 字幕都走这一个**文本流** topic。 */
export const WBCH_RPC_TOPIC = 'wb.rpc';

/** 协议里的文件 topic。手机发件用它。 */
export const WBCH_FILE_TOPIC = 'wb.file';

/** 原型工人(channel-worker/src/agent.ts)此刻用的那个。**只用于收**,不用于发。 */
export const WBCH_LEGACY_FILE_TOPIC = 'wb-file';

/** 收文件时两个 topic 都挂上——协议改名期间不断。 */
export const WBCH_FILE_TOPICS: readonly string[] = [WBCH_FILE_TOPIC, WBCH_LEGACY_FILE_TOPIC];

/** 工人在房里的身份。**只认它发来的响应**——房里别人说的话一概不当答复。 */
export const WBCH_WORKER_IDENTITY = 'wb-channel-worker';

/**
 * 「按住说话」的录音在外面走这条**字节流**(2026-09-25,卡 S「手机在哪都能用」)。
 * 与 channel-worker/src/asrRelay.ts 的 `ASR_TOPIC` 逐字一样。**只发给工人**;`wb.rpc` 上另有一条
 * `{ id, type:'asr' }` 来取,回包是一条 `type:'http'`(与直连 `/butler/proxy/api/asr` 同一个口径)。
 * 为什么是字节流、不分片,见 asrRelay.ts 的文件头。
 */
export const WBCH_ASR_TOPIC = 'wb.asr';

/** 录音流上带编号的属性名(同 asrRelay.ts 的 `ASR_ID_ATTRIBUTE`)。 */
export const WBCH_ASR_ID_ATTRIBUTE = 'wb_asr_id';

/**
 * 会议分段在外面走这条**字节流**(2026-10-09,卡「会后真机走通」)。与 channel-worker/src/meetingRelay.ts 的
 * `MEETING_TOPIC` 逐字一样(那边的用例读这个文件比对)。**只发给工人**,而且只在她这一场点过「现在经服务器传」时才发;
 * `wb.rpc` 上另有一条 `{ id, type:'meeting_segment', meeting_id, seq, ms }` 来取。
 */
export const WBCH_MEETING_TOPIC = 'wb.meeting';

/** 会议分段流上带编号的属性名(同 meetingRelay.ts 的 `MEETING_ID_ATTRIBUTE`)。 */
export const WBCH_MEETING_ID_ATTRIBUTE = 'wb_meeting_seg';

// ———————————————————————— 消息 ————————————————————————

export type WbchMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** 手机 → 工人:代我打一条 HTTP。 */
export interface WbchHttpRequest {
  id: string;
  type: 'http';
  method: WbchMethod;
  path: string;
  /** 没有 body 时发 `null`,不发缺席的字段——两边对字段有无的判断最容易长歪。 */
  body: unknown;
}

/** 手机 → 工人:我的进房凭证快到期了,换一张。 */
export interface WbchRenewRequest {
  id: string;
  type: 'renew';
}

/**
 * 手机 → 工人:**我在做引导**(2026-09-18,Ben:「引导部分的 UI 还是按住说话和打字回答,不是通话模式吗」)。
 *
 * 引导从此就是一通电话:工人把系统提示换成「引导技能 + 当前阶段要问什么 + 值的形状」,
 * 自己接话、自己把答案交给阶段机(`POST /onboarding/answer`,阶段机一个字没改)。
 *   start / resume  进引导。**开场白重不重说由工作台的简报定**(speak_seed),手机说了不算;
 *   say             打字备胎:字幕面板里打的一句话,当成他说的那句;
 *   stop            挂断 = 暂停引导(下次接着做)。
 */
export type WbchOnboardingAction = 'start' | 'resume' | 'say' | 'stop';

export interface WbchOnboardingRequest {
  id: string;
  type: 'onboarding';
  action: WbchOnboardingAction;
  text?: string;
}

/**
 * 手机 → 工人:**这是一通普通电话,打个招呼吧**(2026-09-18,Ben 真机:「接通的瞬间它说『你说』」)。
 *
 * 那句招呼原先是工人一进房就说的。工人是常驻的,房里没人时那一句只排在音频队列里,
 * 等第一台手机进来才真的出声 —— 于是进引导先听见「喂,我在,你说。」,之后才是开场白。
 * 现在招呼由**打电话的这一头**点名要:普通通话发这一条,引导发的是 onboarding.start。
 * 两者互斥、各自明确;中间不留任何靠时间窗猜的余地(进房前还要问麦克风权限,那一下可能等人好几秒)。
 */
/**
 * 2026-09-21 多了三条(座机主动来电):
 *   answer  他按了「接起」—— 工人这才开口(「我打给你是因为…」);
 *   later   他按了「稍后」—— 按未接记,**不重拨**;
 *   hangup  这通电话挂了 —— 工人换回平时那套人设,排着的下一通才响。
 * 前两条**必须带 call_id**:铃有可能刚好在他按下去那一刻超时,不带 id 就会「接起了下一通
 * 而以为接的是上一通」。
 */
/*
 * `playing`(2026-09-28,卡 CF 第 4 条):**这边真的开始放远端音轨了**。
 * 工人的开场白等这一条(上限 2.5s),因为「订上音轨」十几分钟前就成立了,
 * 而他听不听得到第一个字取决于这台机器什么时候真的出声
 * (判据见 src/call/outputWarm.ts:经同一输出播一小段静音,它的媒体时钟真的在走才算)。
 */
export type WbchCallAction = 'start' | 'answer' | 'later' | 'hangup' | 'playing';

export interface WbchCallRequest {
  id: string;
  type: 'call';
  action: WbchCallAction;
  call_id?: string;
  /**
   * **这个包会发 `playing`**(卡 CF 第 4 条,`start` / `answer` 带)。
   * 工人据它决定等不等那一条 —— 老包不带,工人就一个字都不等(不许让他举着一只安静的听筒)。
   */
  reports_playing?: true;
  /**
   * **把通话输出烘热等了多久**(毫秒,`playing` 带;2026-09-28 卡 OP)。
   * 只给工人记进日志 —— 统筹真机核那一行「凭什么开口、各等了多少」靠它。
   */
  warm_ms?: number;
}

/**
 * 手机 → 工人:**把那张取件单上的文件推给我**(2026-09-25,卡 J)。
 * 打字要的那个文件,在外面(直连不通)时走这一条:工人去 8791 核单,再用 `wb.file` 推过来。
 * 答复只说「开始推了」,字节随后到;推不过去工人另发一条 {@link WbchFileStatus}。
 */
export interface WbchFilePullRequest {
  id: string;
  type: 'file_pull';
  offer: string;
}

/**
 * 手机 → 工人:**我要识别一段录音,编号 id**(2026-09-25,卡 S)。录音本身同时在 `wb.asr` 字节流上发
 * (流上属性 `wb_asr_id = id`)。老工人不认这一条,当场回「不认识这种请求:asr」—— 手机据此说「电脑上的事务官要更新」,
 * 不用干等一个没人收的字节流。
 */
export interface WbchAsrRequest {
  id: string;
  type: 'asr';
}

/**
 * 手机 → 工人:**这一段会议录音交给电脑**(2026-10-09)。录音本身同时在 `wb.meeting` 字节流上发
 * (流上属性 `wb_meeting_seg = id`);工人以这台手机的身份 POST 8791 的 `/meeting/segment`,回一条 `type:'http'`。
 */
export interface WbchMeetingSegmentRequest {
  id: string;
  type: 'meeting_segment';
  meeting_id: string;
  seq: number;
  ms?: number;
}

export type WbchOutbound = WbchHttpRequest | WbchRenewRequest | WbchOnboardingRequest | WbchCallRequest | WbchFilePullRequest | WbchAsrRequest | WbchMeetingSegmentRequest;

/** 工人 → 手机:那条 HTTP 的答复。status 原样带回,手机照 8791 的口径处理(401/503/…)。 */
export interface WbchHttpResponse {
  id: string;
  type: 'http';
  status: number;
  body: unknown;
}

/** 工人 → 手机:新的进房凭证。 */
export interface WbchTokenMessage {
  id: string;
  type: 'token';
  token: string;
  /** unix 秒。 */
  expires_at: number;
  /**
   * 新票的房间地址、房间名、哪条路线(局域网 M2 起 8791 回了才带;老工人不带)。
   * 手机换了网卡地址、Mac 换了地址时,续期回来的地址覆盖同一路线那份(局域网 M4)。
   */
  url?: string;
  room?: string;
  route?: 'lan' | 'relay';
}

/** 工人 → 手机:转写与回复。`final=false` 是还在改的中间结果。 */
export interface WbchCaption {
  type: 'caption';
  role: 'me' | 'butler';
  text: string;
  final: boolean;
  /**
   * **这一句的语气**(2026-10-02,卡「声音与形象跟着话走」;只有 `role:'butler'` 有)。
   * 取值与 channel-worker/src/tts/tone.ts 的短列表 id **逐字相同**
   * (`calm` / `happy` / `care` / `sorry` / `urgent` / `soft` / `ask`;两个仓库不互相 import,
   * 同 topic 常量那条老做法)。手机拿它驱动 Live2D 的表情(src/live2d/tone.ts)。
   *
   * `text` 里**绝不含标签** —— 工人在推之前已经剥掉了。老工人不带这一格:那时脸不动,和从前一样。
   */
  tone?: string;
}

/**
 * 工人 → 手机:**缓冲语信号**(2026-09-20,Ben:「缓冲语可以存到手机里啊」)。
 *
 * 工人在回合提交 / 开始调一件慢工具那一刻广播一条。**这条消息里没有话** ——
 * 说哪一句由手机自己挑(那几句音频是预先合成好打在包里的,字幕上写的必须正好是喇叭里放的)。
 * 收了之后怎么办见 call/fillerAudio.ts。
 */
export interface WbchFiller {
  type: 'filler';
  /**
   * `thinking` = 她开始想;`tool` = 她开始查东西;
   * `tool_done` = 那件慢工具跑完了、她跑之前说的那几句也放完了(2026-09-24 傍晚,channel-worker/src/filler.ts toolsDone)。
   * `tool_done` **不垫话**:只给引导通话页管球的执行中样子(call/livekitCall.ts 转成 `onTool`)。
   */
  kind: 'thinking' | 'tool' | 'tool_done';
  /** 哪件工具(`kind:'tool'` / `'tool_done'` 有)。手机据此挑那句工具专用的话。 */
  tool?: string;
  /** 第几轮。手机据此分辨「同一轮的第二条信号」和「新的一轮」。 */
  round: number;
  /** 工人发它的那一刻(毫秒)。只用来量延迟、写日志。 */
  at: number;
  /**
   * **垫场由工人自己用当前音色说了**(2026-09-23 晚,channel-worker/src/workerFiller.ts)。
   * 带着它 → 这台手机**不放本地那份**(那份是固定音色,换了音色就是两个嗓子);
   * 老工人不带 → 照老行为自己垫。
   */
  voiced_by?: 'worker';
}

/**
 * 工人 → 手机,**广播**:**该应一声了**(2026-10-02,卡「声音与形象跟着话走」第 5 件)。
 *
 * 他连着说 ≥2.4 秒、还没到句尾、距上一声 ≥4.5 秒、这一轮还没应满 3 次 ——
 * 阈值全在工人那一头算(channel-worker/src/backchannel.ts),这条消息只说「现在放」。
 * 放的是包里预先合成好的那几声(`fillerLines.json` 里 `kind:'ack'` 的),
 * **他一停就不放**(call/ackAudio.ts)。老工人不发这一条 → 没有应声,和从前一样。
 */
export interface WbchBackchannel {
  type: 'backchannel';
  /** 第几轮(与缓冲语信号同一个轮号)。手机据此分辨批次。 */
  round: number;
  /** 工人发它的那一刻(毫秒)。只用来量延迟、写日志。 */
  at: number;
  /** 这一次点名放哪一声。认不得就忽略,自己挑(同缓冲语那条的规矩)。 */
  line?: string;
}

/**
 * 工人 → 手机,**广播**:事务官的音色换了(2026-09-22)。
 *
 * 缓冲语那七句从这一版起是**按音色缓存在手机本地**的(call/fillerVoiceCache.ts)。
 * 人在 Mac 的配置后台里换了音色之后,电话里会有两个嗓子 —— 她的回答是新的、
 * 垫场那几句还是旧的。工人盯着 8791 的 `/butler/status`,变了就广播这一条。
 *
 * 手机收到**不当场重新合成**(七条 TTS 一起打出去正是 09-20 那次 502 的病根),
 * 只记一笔,**下次进房**再按新音色取一遍。
 */
export interface WbchFillerVoiceChanged {
  type: 'filler_voice_changed';
  /** 现在是哪个音色。手机拿它当缓存键的前半截。 */
  voice: string;
  /** 工人发它的那一刻(毫秒)。只用来写日志。 */
  at: number;
}

/**
 * 工人 → 手机,**广播**:座机响了(2026-09-21,Ben:「待确认 / 运行失败 / 完成提醒时座机响铃」)。
 *
 * 和字幕、缓冲语同一条 topic、同样没有 id、同样不配对答复 —— 它不是「答复」,是**来电**。
 * 收到之后怎么办见 call/incomingModel.ts:响铃 + 震动 + 全屏来电页,`silent` 的只发一条通知。
 */
export interface WbchRing {
  type: 'ring';
  call_id: string;
  /**
   * 为什么打:等你确认 / 运行失败 / 完成 / 等你回答(2026-09-25,卡 M:事务官在会话里问你、要你批)/
   * 回话来了(2026-09-27,卡 CB:你让事务官捎进某条会话的那句话,那边回了)。
   * 人话在 call/incomingModel.ts 的 RING_REASON_TITLES。
   */
  reason: 'confirm' | 'failed' | 'done' | 'ask' | 'relay';
  /** 为哪件事打的。接起来之后要把它带回去(回拨、落决定都认它)。 */
  item_id: string;
  /** 来电页上那一行大字。 */
  title: string;
  note?: string;
  at: string;
  /** 夜间静默时段:**只发通知,不响铃、不弹来电页**。 */
  silent: boolean;
  /** 并进这一通的其它「完成」。 */
  merged?: readonly { item_id: string; title: string }[];
  /** 响到这个时刻为止(毫秒)。手机自己也倒计时,不必只等工人那条 ring_end。 */
  until: number;
}

/** 工人 → 手机,广播:**这一通完了**。手机据此收掉来电页、停铃。 */
export interface WbchRingEnd {
  type: 'ring_end';
  call_id: string;
  /**
   * `answered` / `missed` / `canceled` 说的是**这一通是怎么收场的**(响着的时候来);
   * `hung_up`(2026-09-22,待拍板 E1)说的是**这通已接的电话结束了** —— 同一个 `call_id`
   * 上它排在 `answered` 之后。
   *
   * 今天只有两条路会发 `hung_up`:树莓派话筒挂机(叉簧压回去),以及工人发现房里没人了
   * 自己补的那一刀。**这台手机自己按的挂断不会收到它** —— 工人那边刻意不发回声
   * (channel-worker/src/callOut.ts 的 `RingHangupBy`)。
   */
  outcome: 'answered' | 'missed' | 'canceled' | 'hung_up';
  /**
   * **是谁接的 / 是谁挂的**(2026-09-22 晚)。与 channel-worker/src/callOut.ts 的
   * `RingDeviceKind` **逐字相同**(两个仓库不互相 import,同 topic 常量那条老做法)。
   *
   * 手机拿它做一件很具体的事:**这一通归不归我说话**。归我(`phone`,或者压根没有这一格
   * 而我自己正是按下接起的那一台)就照常通话;归听筒(`handset`)就只显示字幕与挂断 ——
   * **不放她的声音、不推自己的麦克风**(Ben:「响铃应该是手机发出,话筒自己是用来对话的」)。
   *
   * **老工人不带这一格**,那时退回 0921 那条推断:「我还响着却收到 answered = 别人接的」。
   */
  by?: 'phone' | 'handset';
  /**
   * **接起的那一台的房间身份**(2026-09-23 晚,维护者真机「手机接起来没声」)。
   * 与 channel-worker/src/callOut.ts 的 `RingEndSignal.by_identity` **逐字相同**。
   *
   * 只在 `answered` 上带。手机拿它和自己的 identity 一比:**是我就进通话**(开喇叭开麦),
   * 不是我才进字幕页。老工人不带这一格 —— 那时靠「我刚按了接起」那个乐观标记判
   * (butler-app/src/call/incomingModel.ts 的 `answering`)。
   */
  by_identity?: string;
  text?: string;
}

/**
 * 工人 → 手机,**广播**:**这会儿房里在不在通话里**(2026-09-23,Ben 12:45 真机 0.2.68:
 * 「我拿起话筒确实是打出去了,但是手机上没有变化,这不对,打过来和打过去
 * 都应该是显示同一个页面。」)。
 *
 * 与 channel-worker/src/callOut.ts 的 `CallStateSignal` **逐字相同**
 * (两个仓库不互相 import,同 topic 常量那条老做法)。
 *
 * 为什么不塞进 `ring_end`:`ring_end` 说的是「**那一通铃**怎么收场的」,
 * 而他提机拨出去的那一通**压根没有铃、没有 call_id**。硬给它编一条 `ring_end`
 * 就是在台账口径上说假话。所以另起一条只说一件事的信号。
 *
 * 手机拿它做一件很具体的事:`by:'handset'` 的 `in_call` → 进那张「话筒通话中 · 挂断」页
 * (**和来电被话筒接起时同一张**);`idle` → 回舞台。`by:'phone'` 的那一条这台不认 ——
 * 手机自己拨 / 自己接的那条路一个字没改。
 */
export interface WbchCallState {
  type: 'call_state';
  state: 'in_call' | 'idle';
  /** 通话的 / 挂断的是哪一台。`worker` 只出现在 `idle` 上(房里没人了、工人退出)。 */
  by: 'phone' | 'handset' | 'worker';
  /** 来电接起来的那一通才有;他自己拨出去的那通**就是没有**。 */
  call_id?: string;
  /** 这一通从什么时候起(毫秒)。屏上那行「从 HH:MM 起」读的正是它。 */
  started_at: number;
  /** 通话的是哪一台的房间身份(2026-09-23 晚,只在 `in_call` 上带;老工人没有)。同 {@link WbchRingEnd.by_identity}。 */
  by_identity?: string;
}

/** 工人 → 手机:这条没办成(它那边连 8791 都连不上一类)。 */
export interface WbchErrorMessage {
  id: string;
  type: 'error';
  error: string;
}

/** 工人 → 手机:引导那条消息办成了没有(2026-09-18)。办不成时 error 是一句人话,原样显示。 */
export interface WbchOnboardingAck {
  id: string;
  type: 'onboarding';
  ok: boolean;
  stage?: string;
  error?: string;
  /**
   * 这会儿引导归谁管(2026-09-18)。`'desktop'` = 人在电脑上按了「改在电脑上做」,
   * 工人**一个字都不说** —— 手机据此显示「电脑上在做,先别说」并给一颗「改回手机」。
   * `ok` 仍是 true:那不是错误,是另一头在做。
   */
  leader?: string;
}

/** 工人 → 手机:招呼说了没有。说不出去(没有接话模型)时 error 是一句人话。 */
export interface WbchCallAck {
  id: string;
  type: 'call';
  ok: boolean;
  error?: string;
}

/** 工人 → 手机:取件单那一条的答复(2026-09-25)。`ok` = 开始推了,**不是推完了**。 */
export interface WbchFilePullAck {
  id: string;
  type: 'file_pull';
  ok: boolean;
  name?: string;
  bytes?: number;
  error?: string;
}

/**
 * 工人 → 手机:**一个文件没推过来**(2026-09-25)。只发给收件的那一台,不配对答复。
 * 以前推不过去只进电脑的日志,手机上一个字都不说 —— 他在外面干等一个永远不来的文件。
 */
export interface WbchFileStatus {
  type: 'file_status';
  name: string;
  ok: boolean;
  error?: string;
}

export type WbchInbound = WbchHttpResponse | WbchTokenMessage | WbchCaption | WbchFiller | WbchBackchannel | WbchFillerVoiceChanged | WbchRing | WbchRingEnd | WbchCallState | WbchErrorMessage | WbchOnboardingAck | WbchCallAck | WbchFilePullAck | WbchFileStatus;

export function encodeWbchOutbound(message: WbchOutbound): string {
  return JSON.stringify(message);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 一行 JSON → 认得的一条消息。认不出就 null,**绝不抛**。
 * 严格一点没坏处:字段不对的消息当没收到,比半懂不懂地处理安全。
 */
export function parseWbchInbound(text: string): WbchInbound | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;

  if (msg.type === 'http') {
    if (!nonEmptyString(msg.id) || !finiteNumber(msg.status)) return null;
    return { id: msg.id, type: 'http', status: msg.status, body: msg.body };
  }
  if (msg.type === 'token') {
    if (!nonEmptyString(msg.id) || !nonEmptyString(msg.token) || !finiteNumber(msg.expires_at)) return null;
    return {
      id: msg.id,
      type: 'token',
      token: msg.token,
      expires_at: msg.expires_at,
      ...(nonEmptyString(msg.url) ? { url: msg.url.trim() } : {}),
      ...(nonEmptyString(msg.room) ? { room: msg.room.trim() } : {}),
      ...(msg.route === 'lan' || msg.route === 'relay' ? { route: msg.route } : {}),
    };
  }
  if (msg.type === 'error') {
    if (!nonEmptyString(msg.id) || !nonEmptyString(msg.error)) return null;
    return { id: msg.id, type: 'error', error: msg.error };
  }
  if (msg.type === 'onboarding') {
    if (!nonEmptyString(msg.id) || typeof msg.ok !== 'boolean') return null;
    return {
      id: msg.id,
      type: 'onboarding',
      ok: msg.ok,
      ...(nonEmptyString(msg.stage) ? { stage: msg.stage } : {}),
      ...(nonEmptyString(msg.error) ? { error: msg.error } : {}),
      ...(nonEmptyString(msg.leader) ? { leader: msg.leader } : {}),
    };
  }
  if (msg.type === 'call') {
    if (!nonEmptyString(msg.id) || typeof msg.ok !== 'boolean') return null;
    return {
      id: msg.id,
      type: 'call',
      ok: msg.ok,
      ...(nonEmptyString(msg.error) ? { error: msg.error } : {}),
    };
  }
  if (msg.type === 'file_pull') {
    if (!nonEmptyString(msg.id) || typeof msg.ok !== 'boolean') return null;
    return {
      id: msg.id,
      type: 'file_pull',
      ok: msg.ok,
      ...(nonEmptyString(msg.name) ? { name: msg.name } : {}),
      ...(finiteNumber(msg.bytes) ? { bytes: msg.bytes } : {}),
      ...(nonEmptyString(msg.error) ? { error: msg.error } : {}),
    };
  }
  if (msg.type === 'file_status') {
    if (!nonEmptyString(msg.name) || typeof msg.ok !== 'boolean') return null;
    return { type: 'file_status', name: msg.name, ok: msg.ok, ...(nonEmptyString(msg.error) ? { error: msg.error } : {}) };
  }
  if (msg.type === 'caption') {
    if (msg.role !== 'me' && msg.role !== 'butler') return null;
    if (!nonEmptyString(msg.text)) return null;
    return {
      type: 'caption',
      role: msg.role,
      text: msg.text.trim(),
      final: msg.final === true,
      // 语气(2026-10-02):**不在这儿校验取值** —— 认不认得由 live2d/tone.ts 那张表说了算,
      // 它认不得就不动脸。在这一层挡掉等于把「将来多一个语气」的升级路堵死。
      ...(nonEmptyString(msg.tone) ? { tone: msg.tone.trim() } : {}),
    };
  }
  if (msg.type === 'ring') {
    // call_id 与 title 是这条消息的骨头(界面上要写、接起来要带回去),缺一条就当没收到。
    if (!nonEmptyString(msg.call_id)) return null;
    if (msg.reason !== 'confirm' && msg.reason !== 'failed' && msg.reason !== 'done' && msg.reason !== 'ask' && msg.reason !== 'relay') return null;
    if (typeof msg.title !== 'string') return null;
    const merged = Array.isArray(msg.merged)
      ? msg.merged.flatMap((one) => {
          const row = (one ?? {}) as Record<string, unknown>;
          return nonEmptyString(row.item_id) && typeof row.title === 'string' ? [{ item_id: row.item_id, title: row.title }] : [];
        })
      : [];
    return {
      type: 'ring',
      call_id: msg.call_id,
      reason: msg.reason,
      item_id: nonEmptyString(msg.item_id) ? msg.item_id : '',
      title: msg.title,
      ...(nonEmptyString(msg.note) ? { note: msg.note.trim() } : {}),
      at: typeof msg.at === 'string' ? msg.at : '',
      silent: msg.silent === true,
      until: finiteNumber(msg.until) ? msg.until : 0,
      ...(merged.length === 0 ? {} : { merged }),
    };
  }
  if (msg.type === 'ring_end') {
    if (!nonEmptyString(msg.call_id)) return null;
    // `hung_up` 是 2026-09-22 新加的第四个(话筒挂机)。**认不得的一律当没收到** ——
    // 一个看不懂的 outcome 要么收掉一屏不该收的,要么留着一屏该收的,两样都是失真。
    if (msg.outcome !== 'answered' && msg.outcome !== 'missed' && msg.outcome !== 'canceled' && msg.outcome !== 'hung_up') return null;
    return {
      type: 'ring_end',
      call_id: msg.call_id,
      outcome: msg.outcome,
      /**
       * **是谁接的 / 是谁挂的**。2026-09-22 晚就写进协议了,而这一行到 09-23 才补上 ——
       * 在那之前它一直被这个解析器吃掉,于是手机这一侧的 `by` 永远是 undefined。
       * 认不得的种类**不编一个**:那一格整个缺席,界面退回 0921 那条推断。
       */
      ...(msg.by === 'phone' || msg.by === 'handset' ? { by: msg.by } : {}),
      ...(nonEmptyString(msg.by_identity) ? { by_identity: msg.by_identity } : {}),
      ...(nonEmptyString(msg.text) ? { text: msg.text.trim() } : {}),
    };
  }
  if (msg.type === 'call_state') {
    // 这两格是这条消息的骨头:少一格就判不了「这一通归不归我」,半懂不懂地处理
    // 要么收掉一屏不该收的,要么留着一屏该收的 —— 两样都是失真(同 ring_end 那条)。
    if (msg.state !== 'in_call' && msg.state !== 'idle') return null;
    if (msg.by !== 'phone' && msg.by !== 'handset' && msg.by !== 'worker') return null;
    return {
      type: 'call_state',
      state: msg.state,
      by: msg.by,
      ...(nonEmptyString(msg.call_id) ? { call_id: msg.call_id } : {}),
      // 读不出来就 0:界面上那行「从 HH:MM 起」自己会不显示,**不编一个时刻**。
      started_at: finiteNumber(msg.started_at) ? msg.started_at : 0,
      ...(nonEmptyString(msg.by_identity) ? { by_identity: msg.by_identity } : {}),
    };
  }
  if (msg.type === 'filler_voice_changed') {
    // 音色名是这条消息的骨头(它是缓存键的前半截),空的就当没收到 ——
    // 一个空名字会把七句缓存写到 `filler//<id>` 底下,而那不是任何一个音色。
    if (!nonEmptyString(msg.voice)) return null;
    return { type: 'filler_voice_changed', voice: msg.voice.trim(), at: finiteNumber(msg.at) ? msg.at : 0 };
  }
  if (msg.type === 'backchannel') {
    // 轮号是这条消息的骨头(手机靠它分批次),没有就当没收到 —— 同缓冲语那条,严一点没坏处。
    if (!finiteNumber(msg.round)) return null;
    return {
      type: 'backchannel',
      round: msg.round,
      at: finiteNumber(msg.at) ? msg.at : 0,
      ...(nonEmptyString(msg.line) ? { line: msg.line.trim() } : {}),
    };
  }
  if (msg.type === 'filler') {
    // 轮号是这条消息的骨头(手机靠它分批次),没有就当没收到 —— 严一点没坏处。
    if (msg.kind !== 'thinking' && msg.kind !== 'tool' && msg.kind !== 'tool_done') return null;
    if (!finiteNumber(msg.round)) return null;
    return {
      type: 'filler',
      kind: msg.kind,
      round: msg.round,
      at: finiteNumber(msg.at) ? msg.at : 0,
      ...(nonEmptyString(msg.tool) ? { tool: msg.tool.trim() } : {}),
      ...(msg.voiced_by === 'worker' ? { voiced_by: 'worker' as const } : {}),
    };
  }
  return null;
}

// ———————————————————————— 凭证续期 ————————————————————————

/** 提前多久换一张新的。任务书定的十分钟。 */
export const WBCH_RENEW_LEAD_SECONDS = 600;

/** 从现在到「该续了」还有多少毫秒。已经该续(或已过期)就是 0,不给负数。 */
export function wbchRenewDelayMs(expiresAtSeconds: number, nowMs: number, leadSeconds = WBCH_RENEW_LEAD_SECONDS): number {
  if (!Number.isFinite(expiresAtSeconds)) return 0;
  return Math.max(0, (expiresAtSeconds - leadSeconds) * 1000 - nowMs);
}

export function wbchNeedsRenew(expiresAtSeconds: number, nowMs: number, leadSeconds = WBCH_RENEW_LEAD_SECONDS): boolean {
  return wbchRenewDelayMs(expiresAtSeconds, nowMs, leadSeconds) === 0;
}

export function wbchExpired(expiresAtSeconds: number, nowMs: number): boolean {
  return Number.isFinite(expiresAtSeconds) && expiresAtSeconds * 1000 <= nowMs;
}

/** 设置页上那一行。粗到分钟就够,精确到秒只会让人盯着看。 */
export function wbchExpiryText(expiresAtSeconds: number, nowMs: number): string {
  if (wbchExpired(expiresAtSeconds, nowMs)) return '已过期';
  const seconds = expiresAtSeconds - nowMs / 1000;
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} 分钟后到期`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时后到期`;
  return `${Math.round(seconds / 86400)} 天后到期`;
}

// ———————————————————————— 连接方式 ————————————————————————

/**
 * 此刻手机是怎么连上事务官的。舞台页顶上那条细横幅显示它:
 *   direct  局域网里直连 8791(快,首选)
 *   remote  出了局域网,所有请求经房间的数据通道由 Mac 上的工人代理
 *   offline 两条都不通
 */
export type WbchMode = 'direct' | 'remote' | 'offline';

export const WBCH_MODE_TEXT: Record<WbchMode, string> = {
  direct: '直连',
  remote: '远程',
  offline: '未连接',
};
