/**
 * 工人的全部可配项。**一个都不硬编码**——设计 §三 的结论是「远程只是服务器放哪」,
 * 所以地址、端口、ASR 实现、数据目录都得能改;默认值一律指向本机/局域网。
 *
 * 远程时要改的只有三样(docs/交接-0917-LiveKit通道层原型.md 第四节也抄了一份):
 *   1. 工作台那边的 `WORKBENCH_CHANNEL_URL` → VPS 上 livekit-server 的 wss 地址;
 *   2. 工作台那边的 `WORKBENCH_CHANNEL_API_KEY` / `_SECRET` → VPS 上配的那对;
 *   3. 手机端取凭证的 8791 地址(那是手机接线那张卡的事)。
 * **工人这边一行都不用改** —— 它的进房凭证是向 8791 要的,服务器地址跟着凭证一起回来。
 *
 * 凭据纪律:这个文件里**没有任何密钥**。
 *   - LiveKit 的 api key / secret:工人根本拿不到,它只拿 8791 签好的一次性 token;
 *   - 火山的 TTS / ASR 密钥:在 butler-server(8792)里,工人只发 HTTP;
 *   - DeepSeek 的 key:见 src/deepseekKey.ts,只在进程内存里,不落盘、不进日志。
 */
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
// 应声词表那一格的形状 —— 缺省那份表与「缺省 + 她加的」怎么合,都在那个文件里。
import type { AckWordsOverride } from './backchannel.ts'
// 开场那一句晚多久 —— 默认值与它的理由都在那个文件里,这里不另抄一个数。
import { DEFAULT_GREETING_DELAY_MS, OPENER_LEAD_PHONE_SILENCE_MS, OPENER_LEAD_SILENCE_MS } from './tts/greeting.ts'
import { OPENER_SUBSCRIBE_WAIT_MS } from './tts/openerGate.ts'
import { PLAYING_WAIT_MS } from './tts/playingGate.ts'
// 首句那两个数的默认值与理由都在那两个文件里,这里不另抄一个数。
import { FIRST_VOICE_TIMEOUT_MS } from './firstVoice.ts'
import { FIRST_VOICE_GRACE_MS } from './workerFiller.ts'

/**
 * 这台机器在房里叫什么。默认主机名去掉 `.local` —— Ben 的那台叫「Ben 的 MacBook Pro」,
 * 读出来正好是人话。取不到就一句「这台电脑」,**不编一个型号**。
 */
export function defaultDeviceName(): string {
  try {
    const name = hostname().replace(/\.local$/i, '').trim()
    return name === '' ? '这台电脑' : name
  }
  catch { return '这台电脑' }
}

/** ASR 实现。`volc-streaming` 要密钥,`segmented` 不要(走 8792 已配好的那条)。 */
export type ChannelAsrKind = 'volc-streaming' | 'segmented'

export interface ChannelWorkerConfig {
  /** 工作台(签凭证、取人设、建事项)。默认本机 8791。 */
  workbenchUrl: string
  /** 事务官本机后端(TTS / 非流式 ASR)。默认本机 8792。 */
  butlerUrl: string
  /** 用哪个 ASR。 */
  asr: ChannelAsrKind
  /** 别的设备发来的文件落在哪。默认 `~/文档/事务官/收件`(2026-09-21 从 `~/.dsh` 里搬出来)。 */
  inboxDir: string
  /** 传输记录(jsonl)。默认与收件目录同级。 */
  transfersFile: string
  /** 这台机器在房里叫什么。默认主机名 —— 「发到…」的选单里他看见的就是这个。 */
  deviceName: string
  /** 接话模型。 */
  llmModel: string
  llmBaseUrl: string
  /** 火山 TTS 的场景/音色(交给 8792 解析绑定,这里只透传)。 */
  ttsScene: string
  ttsVoiceId?: string
  /** 火山流式 ASR 的 WebSocket 地址(只有 asr=volc-streaming 时用到)。 */
  volcAsrUrl: string
  /**
   * 每回合打一行计时、并报给 8791(2026-09-23)。缺省**开**。
   * 关:`WORKBENCH_CHANNEL_LATENCY=off` —— 关掉之后 `GET /channel/latency` 就一直是空的。
   * 代价只有一行日志 + 一条回环 HTTP,所以默认开着:没有数就只能凭体感猜。
   */
  latencyLog: boolean
  /**
   * 端点检测的固定等待(毫秒)。**缺省缺席 = 用框架的默认值**,一个字都不改。
   *
   * 框架的默认值(`@livekit/agents` 1.9 的 voice/turn_config/endpointing.js):
   * 流式 STT 走 `{ minDelay: 300, maxDelay: 2500 }`,非流式(VAD 分段)走 `{ 500, 3000 }`。
   * 调小 = 她抢话更早,代价是**误切**:他说话中间换一口气就被当成说完了。
   * 开关:`WORKBENCH_CHANNEL_ENDPOINTING_MIN_MS` / `_MAX_MS`。
   */
  endpointingMinMs?: number
  endpointingMaxMs?: number
  /**
   * 断句的软断点门槛(字)。缺省缺席 = 用 `tts/sentences.ts` 里的 `SOFT_BREAK_AT`(18)。
   * 调小 = 第一句更短、更早出声,代价是断得碎、接缝听得出来。
   * 开关:`WORKBENCH_CHANNEL_TTS_SOFT_BREAK`。
   */
  ttsSoftBreakAt?: number
  /**
   * **一回合第一块**的断句门槛(字)。缺省缺席 = 用 `tts/sentences.ts` 的
   * `FIRST_SOFT_BREAK_AT`(10)。等待路径上只有第一块,所以只让它短。
   * 设成和 `ttsSoftBreakAt` 一样 = 逐字回到 09-22 的行为。
   * 开关:`WORKBENCH_CHANNEL_TTS_FIRST_BREAK`。
   */
  ttsFirstBreakAt?: number
  /**
   * **流式合成**(2026-09-23)。缺省**开**,开关 `WORKBENCH_CHANNEL_TTS_STREAM=off`。
   *
   * 开着就先走 8792 的 `/api/tts/stream`(边合边发),第一包音频从「整句合完」变成
   * 「火山的首包」。Ben 09-23 真机第一批的 `tts_first_ms` 是 1441 / 1559ms,
   * 那一整段量的就是「整句合完」。
   *
   * **默认开是安全的**:那条路走不通(老 8792 → 404、连不上、回了错帧)一律当场回退到
   * 老的 `/api/tts`,而且一个进程只白试一次(butlerTts.ts 的 `noteStreamOff`)。
   */
  ttsStream: boolean
  /**
   * **抢跑合成**(2026-09-23)。缺省**关**,与框架的默认值一致。
   *
   * 框架的 `preemptiveGeneration` 缺省是 `{ enabled: true, preemptiveTts: false }`:
   * 回合还没确认就先让**模型**跑起来,但**合成要等回合确认**。也就是说
   * 「第一句的合成时间」整段压在他说完之后 —— 那正是 `tts_first_ms` 量的那一段。
   * 打开之后合成也跟着抢跑,首句合成基本从等待路径上消失。
   *
   * **代价说清楚**:他说完之后又补了一句(抢跑的那一版作废),抢跑合的那一句就白合了 ——
   * 白花一次火山 TTS 的钱,而且因为合成排着队(tts/gate.ts 并发 1),那一次白跑还会把
   * 真正要说的那一句往后压几百毫秒。所以**先量后开**:
   * `WORKBENCH_CHANNEL_PREEMPTIVE_TTS=on`,前后各量二十回合再决定要不要留。
   */
  preemptiveTts: boolean
  /**
   * 开场那一句**晚多久再出口**(毫秒)。缺省 `DEFAULT_GREETING_DELAY_MS`(700)。
   *
   * 维护者 2026-09-23 14:20 真机:「拿起电话之后,我放到耳边,一听到『吩咐』两个字,
   * 很明显说的太早了。」提机到贴耳大约 0.5–1 秒,这一段等的就是它。
   * 开关 `WORKBENCH_CHANNEL_GREETING_DELAY_MS`;**设 0 = 逐字回到 09-23 下午那一版**。
   */
  greetingDelayMs: number
  /**
   * 开场那一句**前面垫多少静音**(毫秒,2026-09-27 卡 CL)。缺省 {@link OPENER_LEAD_SILENCE_MS}(260)。
   *
   * 维护者 21:3x 真机:「一上来就听到『吩咐』两个字,『吩』字还是尾巴」—— 被吃掉的是
   * 对端起播那几百毫秒(手机那个 `<audio>` 从暂停里 `play()` 回来要重开 AudioTrack)。
   * 垫的这一段就是给它吃的。开关 `WORKBENCH_CHANNEL_OPENER_LEAD_MS`;**设 0 = 不垫**。
   */
  openerLeadMs: number
  /**
   * **手机拨出**那一通开场前垫多少静音(2026-09-28 19:2x)。缺省 {@link OPENER_LEAD_PHONE_SILENCE_MS}(1200)。
   * 开关 `WORKBENCH_CHANNEL_OPENER_LEAD_PHONE_MS`;座机话筒那一通照旧用 `openerLeadMs`。
   */
  openerLeadPhoneMs: number
  /**
   * 开场那一句**最多等对端订上工人音轨多久**(毫秒)。缺省 {@link OPENER_SUBSCRIBE_WAIT_MS}(1500)。
   *
   * 到点照旧开口 —— 不能因为等而让他举着一只安静的听筒(那是 09-23 那张卡治过的毛病)。
   * 开关 `WORKBENCH_CHANNEL_OPENER_SUBSCRIBE_MS`;**设 0 = 不等**。
   */
  openerSubscribeMs: number
  /**
   * 开场那一句**最多等手机说「我这边在放了」多久**(毫秒,2026-09-28 卡 CF 第 4 条)。
   * 缺省 {@link PLAYING_WAIT_MS}(2500)。
   *
   * 「订上音轨」十几分钟前就成立了(手机常驻房间),**真的出声**才是他听不听得到第一个字的那一刻。
   * 手机接起时说过「我会报」才等;老手机不报就一个字都不等。到点照旧开口,日志里记一行。
   * 开关 `WORKBENCH_CHANNEL_OPENER_PLAYING_MS`;**设 0 = 不等**(逐字回到卡 CL 那一版)。
   */
  openerPlayingMs: number
  /**
   * **垫场由工人自己用当前音色说**(2026-09-23 晚,维护者拍板;workerFiller.ts)。缺省**开**。
   * `WORKBENCH_CHANNEL_WORKER_FILLER=off` → 逐字回到上一版:工人只发信号(不带 `voiced_by`),
   * 手机照旧放本地那份。
   */
  workerFiller: boolean
  /**
   * **工具按意图只下发用得上的那几件**(2026-10-03,卡「首声提速」甲)。缺省**开**。
   *
   * 开着:要办事的回合按分流判出来的意图挑一小组工具(对照表在 `intentTools.ts` 一处),
   * 认不出意图的回合照旧全套。关掉(`WORKBENCH_CHANNEL_TOOLS_BY_INTENT=off`)=
   * **逐字回到这一版之前**:每个要办事的回合都把 16 件工具的说明书(9544 字)重发一遍。
   */
  toolsByIntent: boolean
  /**
   * **人设按意图裁**(2026-10-03,卡 ②,维护者拍板「做」)。缺省**开**。
   *
   * 开着:这一回合只带「必带段 + 用得上的段」(段与标记由 8791 下发,裁法在 `personaTrim.ts`);
   * 工作台没下发分段、或者下发的形状认不出来 → 照旧整份(不漏规矩)。
   * 关掉(`WORKBENCH_CHANNEL_PERSONA_BY_INTENT=off`)= **逐字回到这一版之前**:每回合整份 3159 字。
   */
  personaByIntent: boolean
  /**
   * **这一回合的第一句话现生一句**(2026-10-03,卡「首声提速」乙)。缺省**开**。
   *
   * 开着:要办事的回合在真回答之前问一次小模型,出一句贴这件事的话,
   * 由垫场那条路立刻念出去(替掉固定的「我想想」)。那一句的边界在 `firstVoice.ts`。
   * 关掉(`WORKBENCH_CHANNEL_FIRST_VOICE=off`)= 逐字回到固定那五句。
   */
  firstVoice: boolean
  /**
   * 首句用哪个模型。缺省**与接话模型同一个**(`llmModel`)—— 它本来就是 flash 那一档,
   * 而这一问**不带工具、不带人设、最多吐 40 个 token**,快的一半原因在这儿。
   * 真要换一个更小的:`WORKBENCH_CHANNEL_FIRST_VOICE_MODEL`。
   */
  firstVoiceModel: string
  /** 首句最多等多久(毫秒)。缺省 `FIRST_VOICE_TIMEOUT_MS`;`WORKBENCH_CHANNEL_FIRST_VOICE_TIMEOUT_MS`。 */
  firstVoiceTimeoutMs: number
  /**
   * 垫场到点了、首句还在合着,最多再多等多久(毫秒)。缺省 `FIRST_VOICE_GRACE_MS`(400)。
   * **设 0 = 一点都不多等**(首句只在 700ms 之内赶上才算),开关
   * `WORKBENCH_CHANNEL_FIRST_VOICE_GRACE_MS`。代价见 workerFiller.ts 那一段。
   */
  firstVoiceGraceMs: number
  /**
   * 电话里传文件等多久就先回话(毫秒,2026-09-25 卡 J)。缺省缺席 = 工具里那个数(4 秒):
   * 小文件在这之内传完她说「发过去了」,大文件先回「开始传了」,电话不陪着等。
   * `WORKBENCH_CHANNEL_SEND_QUICK_MS`;端到端测试把它调小,好让 40MB 的文件在本机也走到「先回话」那一支。
   */
  sendQuickMs?: number
  /**
   * **打断按中文的字数判**(2026-10-03,决策记录 ④甲)。缺省**开**。
   *
   * 关了就是 10-02 之前那条路:框架那道词数闸不填、她一听见一声「嗯」就把话掐在半句上。
   * 留这个开关只为真机上出事时能一句话退回去(改 `WORKBENCH_CHANNEL_BARGE_IN_ZH=off` 重启工人),
   * 不是给用户的选项。
   */
  bargeInZh: boolean
  /**
   * **她说的那一声「嗯 / 对 / 好」不进交给模型的文本**(2026-10-03,维护者拍板「抹掉」)。缺省**开**。
   *
   * 判成应声的那一段工人这边本来就不进回合,可框架那一头照旧把它攒在 `audioTranscript` 里
   * (`audio_recognition.js` 第 1266–1275 行),于是「嗯 帮我把这条派给 Codex」整句交给模型。
   * 开着 = 回合提交前把开头那几段剥掉(`bargeIn.ts` 的 `stripLeadingAcks`,只剥判定命中的那一截);
   * `WORKBENCH_CHANNEL_ACK_OUT_OF_TEXT=off` = 逐字回到上游行为。
   *
   * 打断那道闸关着(`bargeInZh=off`)时这一格等于没有:没有判成应声的段,也就没有要剥的。
   */
  ackOutOfText: boolean
  /**
   * **没调成工具不许说办了**(2026-10-12,卡「通话补一句不丢事」第 3 条;`claimGuard.ts`)。
   * 开着 = 一回合里没有一件工具办成时,她说「派给 Claude 了」「换好了」那一句换成如实的问话;
   * `WORKBENCH_CHANNEL_CLAIM_GUARD=off` = 原样念。
   */
  claimGuard: boolean
  /** 运营那层加进来的应声词(缺省那份在 backchannel.ts,这里只收她加的)。 */
  ackWords?: AckWordsOverride
  /** 中间结果数到几个字才算真打断。缺省见 bargeIn.ts。 */
  bargeInMinChars?: number
  /** 一个字都没识别出来、连着说这么久也照样停。缺省见 bargeIn.ts。 */
  bargeInDeadlineMs?: number
}

export const CHANNEL_DEFAULTS = {
  workbenchUrl: 'http://127.0.0.1:8791',
  butlerUrl: 'http://127.0.0.1:8792',
  asr: 'segmented' as ChannelAsrKind,
  llmModel: 'deepseek-v4-flash',
  llmBaseUrl: 'https://api.deepseek.com/v1',
  ttsScene: 'chat',
  volcAsrUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
} as const

/**
 * 工作目录的默认位置(2026-09-21)。
 *
 * **从 `~/.dsh/workbench/` 搬到 `~/Documents/事务官/`**,理由只有一条:
 * 收件与发件这两个文件夹是**给人用的**。Ben 不看命令行,`~/.dsh` 在访达里默认根本不显示;
 * 而这张卡的发件方式正是「把文件拖进 发给-XXX 文件夹」——拖不进去的文件夹等于没有。
 *
 * 老位置的文件一个都没动(工人不删任何东西);要沿用老位置,
 * 把 `WORKBENCH_CHANNEL_INBOX_DIR` 指回去即可。
 */
export function defaultWorkDir(home: string = homedir()): string {
  return join(home, 'Documents', '事务官')
}

/** 收件目录的默认位置。 */
export function defaultInboxDir(home: string = homedir()): string {
  return join(defaultWorkDir(home), '收件')
}

/** 传输记录的默认位置(与收件目录同级)。 */
export function defaultTransfersFile(inboxDir: string): string {
  return join(inboxDir, '..', '传输记录.jsonl')
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 环境变量 → 一个正整数。**读不懂就当没配**(回 undefined),不退回一个猜出来的数:
 * 拼错了还照跑的话,真机上量出来的数字会对不上任何一份配置,而没人知道为什么。
 */
export function positiveIntOf(value: unknown): number | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.floor(parsed)
}

/**
 * 环境变量 → 一个**可以是 0** 的毫秒数。
 *
 * {@link positiveIntOf} 把 0 当成缺席(退回默认值),而
 * `WORKBENCH_CHANNEL_GREETING_DELAY_MS=0` 的意思恰恰是「一点都不延后」——
 * 那是一个真正的值,不是「没设」。负数与读不懂的照旧当缺席。
 */
export function millisOf(value: unknown): number | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.floor(parsed)
}

/**
 * 一个开关。缺席时用 `fallback`;`off`/`0`/`false`/`no` 算关,`on`/`1`/`true`/`yes` 算开。
 * **读不懂的值当缺席**(退回 fallback)—— 拼错了不该把一个默认关着的手悄悄打开。
 */
export function switchOnOf(value: unknown, fallback = true): boolean {
  const raw = text(value)?.toLowerCase()
  if (raw === undefined) return fallback
  if (['off', '0', 'false', 'no'].includes(raw)) return false
  if (['on', '1', 'true', 'yes'].includes(raw)) return true
  return fallback
}

/**
 * 环境变量 → 应声词表。`+` 开头 = **添在缺省那份后面**(她只写她常说的那几个,不用重抄 22 个);
 * 不带 `+` = 整张换掉。逗号、顿号、全角逗号与空白都算分隔。
 *
 * 合成(缺省那份 + 她这几个)在 backchannel.ts 的 `ackWordsWith` —— 这里只解析,不拼。
 */
export function ackWordsOf(value: unknown): AckWordsOverride | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  const add = raw.startsWith('+')
  const words = (add ? raw.slice(1) : raw)
    .split(/[,，、\s]+/)
    .map(one => one.trim())
    .filter(one => one !== '')
  if (words.length === 0) return undefined
  return { mode: add ? 'add' : 'replace', words }
}

/** 去掉末尾斜杠 —— 后面一律 `${base}/path` 拼,重复斜杠会让某些代理 404。 */
function baseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * 环境变量 → 配置。不认识的 `WORKBENCH_CHANNEL_ASR` 值**退回 segmented 并不声张**是错的:
 * 这里直接退回默认,但调用方(main.ts)会把实际用的那个打出来,所以拼错了看日志一眼能发现。
 */
export function channelWorkerConfigOf(
  env: Record<string, string | undefined>,
  home: string = homedir(),
): ChannelWorkerConfig {
  const asrRaw = text(env.WORKBENCH_CHANNEL_ASR)
  const asr: ChannelAsrKind = asrRaw === 'volc-streaming' ? 'volc-streaming' : 'segmented'
  const inboxDir = text(env.WORKBENCH_CHANNEL_INBOX_DIR) ?? defaultInboxDir(home)
  return {
    workbenchUrl: baseUrl(text(env.WORKBENCH_CHANNEL_WORKBENCH_URL) ?? CHANNEL_DEFAULTS.workbenchUrl),
    butlerUrl: baseUrl(text(env.WORKBENCH_CHANNEL_BUTLER_URL) ?? CHANNEL_DEFAULTS.butlerUrl),
    asr,
    inboxDir,
    transfersFile: text(env.WORKBENCH_CHANNEL_TRANSFERS_FILE) ?? defaultTransfersFile(inboxDir),
    deviceName: text(env.WORKBENCH_CHANNEL_DEVICE_NAME) ?? defaultDeviceName(),
    llmModel: text(env.WORKBENCH_CHANNEL_LLM_MODEL) ?? CHANNEL_DEFAULTS.llmModel,
    llmBaseUrl: baseUrl(text(env.WORKBENCH_CHANNEL_LLM_BASE_URL) ?? CHANNEL_DEFAULTS.llmBaseUrl),
    ttsScene: text(env.WORKBENCH_CHANNEL_TTS_SCENE) ?? CHANNEL_DEFAULTS.ttsScene,
    ...(text(env.WORKBENCH_CHANNEL_TTS_VOICE) === undefined ? {} : { ttsVoiceId: text(env.WORKBENCH_CHANNEL_TTS_VOICE) as string }),
    volcAsrUrl: text(env.WORKBENCH_CHANNEL_VOLC_ASR_URL) ?? CHANNEL_DEFAULTS.volcAsrUrl,
    latencyLog: switchOnOf(env.WORKBENCH_CHANNEL_LATENCY),
    ttsStream: switchOnOf(env.WORKBENCH_CHANNEL_TTS_STREAM),
    preemptiveTts: switchOnOf(env.WORKBENCH_CHANNEL_PREEMPTIVE_TTS, false),
    greetingDelayMs: millisOf(env.WORKBENCH_CHANNEL_GREETING_DELAY_MS) ?? DEFAULT_GREETING_DELAY_MS,
    openerLeadMs: millisOf(env.WORKBENCH_CHANNEL_OPENER_LEAD_MS) ?? OPENER_LEAD_SILENCE_MS,
    openerLeadPhoneMs: millisOf(env.WORKBENCH_CHANNEL_OPENER_LEAD_PHONE_MS) ?? OPENER_LEAD_PHONE_SILENCE_MS,
    openerSubscribeMs: millisOf(env.WORKBENCH_CHANNEL_OPENER_SUBSCRIBE_MS) ?? OPENER_SUBSCRIBE_WAIT_MS,
    openerPlayingMs: millisOf(env.WORKBENCH_CHANNEL_OPENER_PLAYING_MS) ?? PLAYING_WAIT_MS,
    workerFiller: switchOnOf(env.WORKBENCH_CHANNEL_WORKER_FILLER),
    toolsByIntent: switchOnOf(env.WORKBENCH_CHANNEL_TOOLS_BY_INTENT),
    personaByIntent: switchOnOf(env.WORKBENCH_CHANNEL_PERSONA_BY_INTENT),
    firstVoice: switchOnOf(env.WORKBENCH_CHANNEL_FIRST_VOICE),
    firstVoiceModel: text(env.WORKBENCH_CHANNEL_FIRST_VOICE_MODEL)
      ?? text(env.WORKBENCH_CHANNEL_LLM_MODEL) ?? CHANNEL_DEFAULTS.llmModel,
    firstVoiceTimeoutMs: millisOf(env.WORKBENCH_CHANNEL_FIRST_VOICE_TIMEOUT_MS) ?? FIRST_VOICE_TIMEOUT_MS,
    firstVoiceGraceMs: millisOf(env.WORKBENCH_CHANNEL_FIRST_VOICE_GRACE_MS) ?? FIRST_VOICE_GRACE_MS,
    ...(millisOf(env.WORKBENCH_CHANNEL_SEND_QUICK_MS) === undefined
      ? {}
      : { sendQuickMs: millisOf(env.WORKBENCH_CHANNEL_SEND_QUICK_MS) as number }),
    ...(positiveIntOf(env.WORKBENCH_CHANNEL_ENDPOINTING_MIN_MS) === undefined
      ? {}
      : { endpointingMinMs: positiveIntOf(env.WORKBENCH_CHANNEL_ENDPOINTING_MIN_MS) as number }),
    ...(positiveIntOf(env.WORKBENCH_CHANNEL_ENDPOINTING_MAX_MS) === undefined
      ? {}
      : { endpointingMaxMs: positiveIntOf(env.WORKBENCH_CHANNEL_ENDPOINTING_MAX_MS) as number }),
    ...(positiveIntOf(env.WORKBENCH_CHANNEL_TTS_SOFT_BREAK) === undefined
      ? {}
      : { ttsSoftBreakAt: positiveIntOf(env.WORKBENCH_CHANNEL_TTS_SOFT_BREAK) as number }),
    ...(positiveIntOf(env.WORKBENCH_CHANNEL_TTS_FIRST_BREAK) === undefined
      ? {}
      : { ttsFirstBreakAt: positiveIntOf(env.WORKBENCH_CHANNEL_TTS_FIRST_BREAK) as number }),
    bargeInZh: switchOnOf(env.WORKBENCH_CHANNEL_BARGE_IN_ZH),
    ackOutOfText: switchOnOf(env.WORKBENCH_CHANNEL_ACK_OUT_OF_TEXT),
    claimGuard: switchOnOf(env.WORKBENCH_CHANNEL_CLAIM_GUARD),
    ...(ackWordsOf(env.WORKBENCH_CHANNEL_ACK_WORDS) === undefined
      ? {}
      : { ackWords: ackWordsOf(env.WORKBENCH_CHANNEL_ACK_WORDS) as AckWordsOverride }),
    ...(positiveIntOf(env.WORKBENCH_CHANNEL_BARGE_IN_MIN_CHARS) === undefined
      ? {}
      : { bargeInMinChars: positiveIntOf(env.WORKBENCH_CHANNEL_BARGE_IN_MIN_CHARS) as number }),
    ...(positiveIntOf(env.WORKBENCH_CHANNEL_BARGE_IN_DEADLINE_MS) === undefined
      ? {}
      : { bargeInDeadlineMs: positiveIntOf(env.WORKBENCH_CHANNEL_BARGE_IN_DEADLINE_MS) as number }),
  }
}
