/**
 * 通道层(2026-09-17,docs/设计-手机通道层-2026-09-17.md)在**工作台这一侧**的那一块。
 *
 * 设计结论:手机与电脑之间只留一条通道 —— 一个 LiveKit 房间。声音、文字、文件、控制指令
 * 都走它。真正进房说话的是独立进程「事务官工人」(仓库根目录 channel-worker/,选型理由见
 * docs/交接-0917-LiveKit通道层原型.md 第二节)。
 *
 * **8791 在这条链路里管这几件事**,一件都不多:
 *
 *   1. `POST /channel/token`  签发进房凭证。沿用手机配对的设备令牌门 —— 谁能写事项,谁才能进房。
 *      凭证里带**设备属性**(CHANNEL_DEVICE_ATTRIBUTE),工人据此知道房里那位是哪台手机。
 *   2. `GET  /channel/status` 如实报告:livekit-server 在不在、工人在没在房里、走的是本机还是远程。
 *   3. `GET  /channel/persona` 只给本机(工人)取人设 + 此刻的事项摘要。
 *   4. `POST /channel/start|stop`、`GET /channel/worker`(只认回环)—— 工人进程的启停与状态,
 *      实现在 server/channelWorker.ts,这个文件只管凭证、状态与人设。
 *   5. 替房里的手机来的那些请求的**降权**:见 CHANNEL_DEVICE_HEADER。
 *
 * 为什么人设不由工人自己拼:**人设只能有一个来源**。0.2.33 的代理层注入(server/rtcCall.ts)
 * 取的是 `~/.dsh/AGENTS.md` 首行的名字与「说话方式」标记段,加上看板此刻的摘要;工人再抄一份
 * 提取逻辑,迟早两边长歪。所以抽取那几个纯函数原样复用 rtcCall.ts 的,这里只多拼通道层特有的
 * 那一段(能用哪几件工具、打断怎么说)。工人一个字都不自己编,也因此**完全够不到 ~/.dsh**。
 *
 * **凭据**:两条来源,按顺序试(2026-09-21 起多了第二条)。
 *
 *   ① **本机**:环境变量,或数据目录下的 `channel.json` 里的 api_key / api_secret。
 *      这一条留给"本机自己起了一台 livekit-server --dev"的开发与灰度 —— 那时候根本没有服务器。
 *      有它就在本文件里签 JWT,secret **只在 signAccessToken 里出现**,不进 /state、不进日志。
 *   ② **服务器下发**:没有本机那一份时,向中转要(server/channelCredentials.ts)。
 *      这时候我们手上**连 secret 都没有** —— 要进房就让中转替我们签,拿回来的只是签好的一串。
 *      这是新用户与真机的常态:他不该、也不会有一把 LiveKit 的钥匙。
 *
 * 两条都没有 = 通道不可用,而且要说清楚是哪一种「没有」:
 * 「还没登录」与「服务器上没配」对用户是两件完全不同的事(前者他自己能解决)。
 *
 * 除 `createChannelService` 外全是纯函数:字符串进、字符串出,不碰磁盘也不发请求。
 */
import { INTRO_INTENT, INTRO_KNOWLEDGE_LINES, INTRO_RULES_LINES, INTRO_SECTION_NAME, INTRO_THOUGHT_LINES } from './introKnowledge.ts'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { TasksState } from '../protocol.ts'
import { DISPATCH_FAMILY_TITLES } from '../protocol.ts'
import { FEED_DIG_SECTION } from './feedDig.ts'
import type { ChannelCredentialStore, RemoteChannelCredentials } from './channelCredentials.ts'
import { butlerNameOf, callAddressesOf, callContextBlock, callPreferencesOf, speakingStyleOf } from './rtcCall.ts'
import { askOnlyFourKindsBlock } from './confirmPoints.ts'
import { MACHINE_ID_PATTERN, localRoomOf } from './machineId.ts'

// ———————————————————————— 常量 ————————————————————————

/** 工人在房里的身份。/channel/status 判「工人在不在房」认的就是这个字符串。 */
export const CHANNEL_WORKER_IDENTITY = 'wb-channel-worker'

/** 手机的身份前缀:`wb-phone-<device_id>`。身份由服务端按设备令牌拼,调用方说了不算。 */
export const CHANNEL_PHONE_PREFIX = 'wb-phone-'

/** 本机浏览器测试页(channel-worker/dev/)的身份前缀。只有回环来源拿得到。 */
export const CHANNEL_DEV_PREFIX = 'wb-dev-'

/**
 * 收件目录的**显示名**。人设里只说这个名字,不说绝对路径 —— 电话里念路径听不懂。
 * 真正落盘在哪由工人那边的配置决定(channel-worker/src/config.ts,默认
 * `~/.dsh/workbench/channel-inbox/`),工作台这边只借这个名字拼一句话。
 */
export const CHANNEL_INBOX_NAME = '通道收件箱'

/** 默认房间名。一个房间就够了(设计 §二),不按设备开房。 */
export const CHANNEL_DEFAULT_ROOM = 'workbench'

/** 这台没接中转(零服务器档,2026-10-21)时 `/channel/status` 那一句:电话只走家里,不是「要登录」。 */
export const CHANNEL_NO_RELAY_NOTE = '这台没接中转:电话只在家里的局域网里打(本机房间),出门打不了。'

/**
 * 没接中转、也没填识别钥匙时 `/channel/credentials` 那一句:告诉她去哪填。工人这时退回事务官后端的分段识别
 * (channel-worker/src/asr/index.ts 的 chooseAsrKind),所以说的是「填了更快」,不是「不填就听不见」。
 */
export const CHANNEL_NO_RELAY_ASR_NOTE = '这台没接中转:电话里听懂说话先走事务官后端的分段识别;在设置 › 各家的登录与密钥 › 火山识别填上自己的 App ID 与 Access Token,就换成更快的流式识别。'

/** 默认服务器地址:本机回环的 livekit-server --dev。远程时只改这一项(和 key/secret)。 */
export const CHANNEL_DEFAULT_URL = 'ws://127.0.0.1:7880'

/**
 * 进房凭证的默认有效期:**7 天**(2026-09-17 决策记录「工人常驻与房间代理」第 3 条)。
 *
 * 原型里是 15 分钟 —— 那时手机每次通话前现取一张,凭证只是一次通话的门票。改成 7 天的理由:
 * 远程模式下手机不再「每次通话前先打 8791」,它**只连房间**;要续期就得先进得去房间(续期是
 * 房里的一条 `renew`,由工人代请)。15 分钟意味着手机放兜里半小时回来就进不去、也就没法续期,
 * 变成必须回到局域网重新配对 —— 那正是远程要解决的问题。
 *
 * 代价说清楚:一张凭证泄露后最长 7 天内能进这个房间。压住这个代价的是另外两条 ——
 *   ① 凭证的授权里**没有 roomAdmin**(踢不了人、关不了房),房里除了工人只有他自己的设备;
 *   ② 凭证**不等于**能指挥电脑:房里想调 8791 得走 `wb.rpc`,工人会把它降权成那台设备的权限
 *      (见 CHANNEL_DEVICE_HEADER),设备一解除配对,凭证还没过期也已经什么都做不了了。
 * 想改短就配 `WORKBENCH_CHANNEL_TOKEN_TTL`(秒)或 channel.json 的 `token_ttl_seconds`。
 */
export const CHANNEL_DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * **本机房间**(地址指向这台 Mac 自己的 livekit-server)的票缺省 **24 小时**(2026-10-21,局域网主路)。
 * 上面那 7 天是为「手机在外面只连得上房间、续期得先进得去」;本机房间只有在家才进得去,
 * 在家随时能找 8791 换一张,用不着长票 —— 而局域网里的票是明文过 Wi-Fi 的,短一点损失小一点。
 */
export const CHANNEL_LOCAL_TOKEN_TTL_SECONDS = 24 * 60 * 60

/** 可配的上下界。1 分钟以下没法用,30 天以上不如重新配对。越界就夹回来,不报错也不当没配。 */
export const CHANNEL_MIN_TOKEN_TTL_SECONDS = 60
export const CHANNEL_MAX_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * 工人替房里的手机去调 8791 时带的头(小写)。**它只会降权,不会升权**:
 *
 * 工人跑在本机回环上,而 8791 对回环来源是全权信任的(配对码、凭据、窗位……都在回环后面)。
 * 要是工人原样把房里的请求转成一条回环请求,房里任何人都拿到了一台 Mac 的全部权限 —— 这条头
 * 就是为了不让那件事发生:带上它的回环请求,8791 **按这台设备的权限**处理,和这台手机自己
 * 在局域网里打 8791 时一模一样。因为回环本来就是最高权限,所以「认这条头」不可能是提权;
 * 设备 id 认不出来(没配对过 / 已解除)就 401,**不退回回环全权**。
 *
 * 非回环来源上这条头一律不看 —— 那条路上本来就要设备令牌,轮不到它说自己是谁。
 */
export const CHANNEL_DEVICE_HEADER = 'x-workbench-channel-device'

/**
 * 工人替房里的设备转来时,报**它自己在哪条路线的房间里**(2026-10-21,局域网主路)。值是 {@link ChannelRoute}。
 *
 * 为什么要它:转来的请求 socket 两头都是回环,8791 看不出那台设备是在本机房间(在家)还是云房间(出门)。
 * 续期要签**同一间房**的票:云房间里的工人替手机续,得让中转签;本机房间里的,本机签、给局域网地址。
 * 只在回环 + {@link CHANNEL_DEVICE_HEADER} 那条路上看它;它只挑房间、不改权限(设备照旧按那台的权限)。
 * 老工人不带 = 与今天一样(本机有钥匙签本机,没有就中转)。与 channel-worker/src/workbench.ts 同一个字符串(有对照用例)。
 */
export const CHANNEL_ROUTE_HEADER = 'x-workbench-channel-route'

/**
 * 凭证里带设备 id 的那个参与者属性名。手机进房后,工人从**参与者属性**里读它,
 * 据此决定这条 `wb.rpc` 该用谁的权限去调 8791。
 *
 * 为什么可信:属性是**签在凭证里的**(LiveKit 的 ClaimGrants.attributes),凭证由 8791 签、
 * 手机改不了;而且我们发出去的授权里**没有 canUpdateOwnMetadata**,所以参与者进房之后也改不动
 * 自己的属性。身份 `wb-phone-<device_id>` 是第二道 —— identity 由 LiveKit 按 `sub` 强制,同样伪造不了。
 */
export const CHANNEL_DEVICE_ATTRIBUTE = 'wb_device_id'

/**
 * 凭证里带「这台是什么」的那个属性名(2026-09-21,座机形态:手机 + 树莓派话筒)。
 * 值是 `'phone'` 或 `'handset'`,由 `server/devices.ts` 的 `deviceKindOf` 从配对时
 * 报的 platform 推出来。
 *
 * **为什么非要签进凭证,而不是让参与者自己报一句**:工人要按这个值决定
 * 「这一通的声音走哪台设备」(docs/设计-座机信号协议-2026-09-21.md §四)。
 * 房里自称的东西谁都能说;签在凭证里的属性由 8791 签、LiveKit 强制,
 * 而我们发出去的授权里**没有 canUpdateOwnMetadata**,进房之后也改不动。
 * 和 `wb_device_id` 同一条理由、同一道门。
 *
 * 老手机拿到的凭证里没有这一项 —— 工人缺省当 `phone`,不当成坏数据。
 */
export const CHANNEL_KIND_ATTRIBUTE = 'wb_kind'

/** 房间里那条 JSON 控制通道的 topic(RPC / 续期 / 字幕)。两端唯一的约定。 */
export const CHANNEL_RPC_TOPIC = 'wb.rpc'

/** 房间里传文件的 topic。两端唯一的约定。 */
export const CHANNEL_FILE_TOPIC = 'wb.file'

/**
 * 通话里那几件工具的名字。**与 channel-worker/src/tools.ts、hubTools.ts 里的常量逐字相同** —— 两个仓库不互相 import,
 * 这是本仓库既有的做法(见 rpc.ts 顶上那几个 topic 常量)。对不上的后果是人设里教她调一件不存在的工具。
 *
 * 2026-10-28(A2,理解中枢):写板子的那几件 = 理解中枢的命令表(`hub/commands.ts`),工具按命令一一对应,
 * 执行一律回 8791 `POST /butler/hub/execute`;旧的「记 / 办 / 补一句 / 需求卡 / 规矩 / 目标 / 便签」那几件并进来了。
 */
/** 只记一张卡、不派人(命令 note)。 */
export const CHANNEL_TOOL_NOTE = 'wb_note'
/** 派活(命令 dispatch)。 */
export const CHANNEL_TOOL_DISPATCH = 'wb_dispatch'
/** 给板上某张卡补一句(命令 supplement)。 */
export const CHANNEL_TOOL_HAND = 'wb_supplement'
/** 记一条以后都算数的规矩(命令 remember)。 */
export const CHANNEL_TOOL_PREFERENCE = 'wb_remember'
/** 改派 / 改名 / 取消 / 挪状态 / 归目标 / 目标四件 / 用户层 / 反馈:命令表其余几条。 */
export const CHANNEL_TOOL_REASSIGN = 'wb_reassign'
export const CHANNEL_TOOL_RENAME = 'wb_rename'
export const CHANNEL_TOOL_CANCEL = 'wb_cancel'
export const CHANNEL_TOOL_MOVE_STATUS = 'wb_move_status'
export const CHANNEL_TOOL_SET_GOAL = 'wb_set_goal'
export const CHANNEL_TOOL_GOAL_STATUS = 'wb_goal_status'
export const CHANNEL_TOOL_GOAL_CREATE = 'wb_goal_create'
export const CHANNEL_TOOL_GOAL_DUE = 'wb_goal_due'
export const CHANNEL_TOOL_USER_LAYER_FIX = 'wb_user_layer_fix'
export const CHANNEL_TOOL_FEEDBACK = 'wb_feedback'
/** 她答了 8791 护栏挂的那一问。 */
export const CHANNEL_TOOL_CONFIRM = 'wb_confirm'
export const CHANNEL_TOOL_VOICE = 'wb_set_voice'
export const CHANNEL_TOOL_ASK_BUTLER = 'wb_ask_butler'
/**
 * **给某一家捎句话**(卡 BR 那件工具;2026-09-27 卡 MS 补进人设)。
 *
 * 它 09-26 就在工人手里,**人设里从来没提过它** —— 21:17 那一通里模型手上"能做的"那张单子上
 * 只有「记」「交给事务官办」「查在办」「补一句」这几件,于是「给 minus 发个信息」只能去调
 * 「交给事务官办」:建卡、开会话、grep 名字、列四条确认点,一个字没发出去。
 * 工具在手上而人设里没写,等于没有。
 */
export const CHANNEL_TOOL_RELAY = 'wb_relay_to_session'

// ———————————————————————— 配置 ————————————————————————

export interface ChannelConfig {
  /** 工人与手机连的 WebSocket 地址。 */
  url: string
  /** 同一台 livekit-server 的 HTTP 面(查房间用)。不配就从 url 换协议推出来。 */
  httpUrl: string
  apiKey: string
  apiSecret: string
  room: string
  /** 签出去的进房凭证有效期(秒)。见 CHANNEL_DEFAULT_TOKEN_TTL_SECONDS。 */
  tokenTtlSeconds: number
}

/** 能安全发给浏览器/手机的那一份:**没有 secret**。 */
export interface ChannelConfigView {
  url: string
  room: string
  configured: boolean
  /** 连的是本机那台 dev 服务器,还是远程碰头点。见 channelModeOf。 */
  mode: ChannelMode
  /**
   * 这一份配置是从哪儿来的(2026-09-21)。
   * `local` = 本机有 api key/secret(环境变量或 channel.json);
   * `server` = 由中转在登录后下发,secret 不在这台机器上;
   * `none` = 两条都没有。
   */
  source: ChannelConfigSource
}

export type ChannelConfigSource = 'local' | 'server' | 'none'

/**
 * `local` = 地址指向本机回环;`lan` = 局域网地址(私网段 / 链路本地 / `.local`,2026-10-21 加的一档 ——
 * 探针①里局域网地址被报成 `remote`);`remote` = 别的机器(云上那台)。
 */
export type ChannelMode = 'local' | 'lan' | 'remote'

/**
 * **路线**(2026-10-21,局域网主路;设计稿第三节术语):`lan` = 主路,这台 Mac 自己签的本机房间;
 * `relay` = 备路,中转签的云房间。票、`/channel/status` 与续期都带上这一格,设备按它分开缓存票。
 */
export type ChannelRoute = 'lan' | 'relay'

export const CHANNEL_ROUTES: readonly ChannelRoute[] = ['lan', 'relay']

/** 配置文件(可选)的形状。key/secret 明文落在这里,所以它在数据目录、不在仓库。 */
interface ChannelConfigFile {
  url?: unknown
  http_url?: unknown
  api_key?: unknown
  api_secret?: unknown
  room?: unknown
  token_ttl_seconds?: unknown
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 有效期:环境变量(字符串)或配置文件(数字或字符串)。读不懂就用默认值,越界就夹回上下界 ——
 * **不因为一个写歪的数字让整条通道签不出凭证**。
 */
export function tokenTtlOf(env: unknown, file: unknown, fallback = CHANNEL_DEFAULT_TOKEN_TTL_SECONDS): number {
  const raw = text(env) ?? (typeof file === 'number' ? String(file) : text(file))
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(CHANNEL_MAX_TOKEN_TTL_SECONDS, Math.max(CHANNEL_MIN_TOKEN_TTL_SECONDS, Math.floor(parsed)))
}

/** URL 里的主机名(小写;IPv6 去掉方括号)。 */
function hostOf(url: string): string {
  const authority = url.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? ''
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    return authority.slice(1, close < 0 ? undefined : close).toLowerCase()
  }
  return (authority.split(':')[0] ?? '').toLowerCase()
}

/** 地址规整:去方括号、IPv6 映射的 IPv4(`::ffff:10.0.0.2`)剥成 IPv4。 */
function bareAddress(address: string): string {
  let one = address.trim().toLowerCase()
  if (one.startsWith('[') && one.endsWith(']')) one = one.slice(1, -1)
  if (one.startsWith('::ffff:') && /^\d+\.\d+\.\d+\.\d+$/.test(one.slice('::ffff:'.length))) one = one.slice('::ffff:'.length)
  return one
}

function ipv4Parts(host: string): [number, number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return undefined
  const parts = match.slice(1).map(Number)
  return parts.some(n => n > 255) ? undefined : parts as [number, number, number, number]
}

/** 这个主机就是这台机器:回环、`localhost`、未指定地址(`0.0.0.0` / `::`,livekit 绑在所有网卡上时配置里会这么写)。 */
export function isThisMachineHost(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  const one = bareAddress(host)
  if (one === 'localhost' || one === '::1' || one === '::' || one === '0.0.0.0') return true
  return ipv4Parts(one)?.[0] === 127
}

/**
 * 局域网里的地址(2026-10-21):私网段(10/8、172.16/12、192.168/16)、链路本地(169.254/16)、
 * 运营商级 NAT 那一段(100.64/10 —— Tailscale 给设备的地址在这里,设计稿第四节档一「出门经 Tailscale」走的还是主路)、
 * IPv6 的 ULA(fc00::/7)与链路本地(fe80::/10)、mDNS 的 `.local` 主机名。**看不懂的一律不算**。
 */
export function isPrivateAddress(address: string | undefined): boolean {
  if (address === undefined || address.trim() === '') return false
  const one = bareAddress(address).split('%')[0] as string
  if (one.endsWith('.local')) return true
  const v4 = ipv4Parts(one)
  if (v4 !== undefined) {
    const [a, b] = v4
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  if (!one.includes(':')) return false
  return /^f[cd][0-9a-f]{0,2}:/.test(one) || /^fe[89ab][0-9a-f]:/.test(one)
}

/**
 * 地址指的是本机、局域网里,还是别人家的机器。**只看主机名**,不发任何请求 ——
 * `/channel/status` 里那个 `mode` 回的就是它,Ben 一眼就知道「这会儿走的是本机、局域网还是云上那台」。
 */
export function channelModeOf(url: string): ChannelMode {
  const host = hostOf(url)
  if (isThisMachineHost(host)) return 'local'
  return isPrivateAddress(host) ? 'lan' : 'remote'
}

/**
 * **按来路改写地址**(2026-10-21,局域网主路;设计稿第二节):配置里那个地址指向这台 Mac 自己
 * (缺省 `ws://127.0.0.1:7880`)时,给设备的那张票把主机换成**这条请求进来的那块网卡的地址**
 * —— 设备能连上 8791 的那个地址,就一定连得上同一台 Mac 上的 7880。端口、协议照旧。
 *
 * 配置写的不是本机(云上那台、或已经明写了局域网地址)就**原样**:那是她自己定的地址,不替她改。
 * 给的地址缺席或本身是回环(工人、Mac 上的页面、ADB 反向的手机)也原样。
 */
export function advertisedUrlOf(configUrl: string, host: string | undefined): string {
  if (host === undefined || host.trim() === '' || isThisMachineHost(host)) return configUrl
  if (!isThisMachineHost(hostOf(configUrl))) return configUrl
  const match = /^([a-z]+:\/\/)(\[[^\]]*\]|[^/:]*)(.*)$/i.exec(configUrl)
  if (match === null) return configUrl
  const bare = bareAddress(host)
  const shown = bare.includes(':') ? `[${bare.replace(/%/g, '%25')}]` : bare
  return `${match[1]}${shown}${match[3]}`
}

/** `ws://host:7880` → `http://host:7880`。已经是 http 的原样留着。 */
export function httpUrlOf(url: string): string {
  if (url.startsWith('wss://')) return `https://${url.slice('wss://'.length)}`
  if (url.startsWith('ws://')) return `http://${url.slice('ws://'.length)}`
  return url
}

/**
 * 环境变量 + 配置文件 → 一份配置。**环境变量优先**(本机跑原型时不用落任何文件)。
 *
 * key 或 secret 缺一个就返回 undefined ——「配了一半」当没配,不去猜另一半。
 *
 * **本机房间**(地址指向这台 Mac,2026-10-21):没写 `room` 时房间名用 `options.localRoom`
 * (`wb-local-<机器 id 前 8 位>`,server/machineId.ts;安装器装时也写进 channel.json),票缺省 24 小时。
 * 取不到机器 id(不传 localRoom)就退回老缺省 {@link CHANNEL_DEFAULT_ROOM},不编一个。
 * 地址指向别处(拷来的云上那份)时房间名与有效期的缺省都照旧。
 */
export function channelConfigOf(
  env: Record<string, string | undefined>,
  file: unknown = undefined,
  options: { localRoom?: string } = {},
): ChannelConfig | undefined {
  const raw = (file !== null && typeof file === 'object' ? file : {}) as ChannelConfigFile
  const url = text(env.WORKBENCH_CHANNEL_URL) ?? text(raw.url) ?? CHANNEL_DEFAULT_URL
  const apiKey = text(env.WORKBENCH_CHANNEL_API_KEY) ?? text(raw.api_key)
  const apiSecret = text(env.WORKBENCH_CHANNEL_API_SECRET) ?? text(raw.api_secret)
  if (apiKey === undefined || apiSecret === undefined) return undefined
  const thisMachine = isThisMachineHost(hostOf(url))
  return {
    url,
    httpUrl: text(env.WORKBENCH_CHANNEL_HTTP_URL) ?? text(raw.http_url) ?? httpUrlOf(url),
    apiKey,
    apiSecret,
    room: text(env.WORKBENCH_CHANNEL_ROOM) ?? text(raw.room)
      ?? (thisMachine && options.localRoom !== undefined ? options.localRoom : CHANNEL_DEFAULT_ROOM),
    tokenTtlSeconds: tokenTtlOf(
      env.WORKBENCH_CHANNEL_TOKEN_TTL,
      raw.token_ttl_seconds,
      thisMachine ? CHANNEL_LOCAL_TOKEN_TTL_SECONDS : CHANNEL_DEFAULT_TOKEN_TTL_SECONDS,
    ),
  }
}

// ———————————————————————— 按来路签:路线与地址(2026-10-21,局域网主路) ————————————————————————

/**
 * 这条签票 / 问状态的请求**从哪儿来**(设计稿第二节「按来路签地址」)。由 http.ts 按 socket 与头填。
 */
export interface ChannelCaller {
  /** 请求进来的那块网卡的地址(`req.socket.localAddress`)。设备连得上它,就连得上同一台 Mac 的 7880。 */
  localAddress?: string
  /** 对面的地址(`req.socket.remoteAddress`)。判「局域网里来的还是外网来的」。 */
  remoteAddress?: string
  /**
   * 工人替房里的设备转来的(回环 + {@link CHANNEL_DEVICE_HEADER})。socket 两头都是回环,真来路是工人
   * 所在的那间房:工人用 {@link CHANNEL_ROUTE_HEADER} 报;老工人不报 = `route` 缺席。
   */
  proxied?: { route?: ChannelRoute }
  /** 本机点名要哪条(工人自己取票时;卡 M6 的第二条工人要 `relay`)。只有回环的话 http.ts 才填。 */
  want?: ChannelRoute
}

/** 这一张票怎么签:本机签哪个地址,或者让中转签(签不出时可退回的本机那一张)。 */
export type ChannelPlan =
  | { route: 'lan', url: string }
  | { route: 'relay', fallback?: { route: 'lan', url: string } }

/**
 * **按来路选路线与地址**。纯函数,`issue` 与 `status` 共用这一份(两处各判一遍,迟早一处给了地址、另一处报了别的,
 * 听筒拿 status 的地址比票的地址判「换房了」—— `phone-bridge/pairing.py` 的 `room_moved` —— 就会白换票)。
 *
 *   - 没有来路(老调用方、探针直调):本机有钥匙签本机、地址原样,没有才中转 —— 与改之前一字不差;
 *   - 本机点名:要什么给什么,没有就签不出;
 *   - 工人转来的:工人在云房间 → 中转;在本机房间(或老工人不报)→ 本机有钥匙签本机、地址给这台 Mac 的第一个局域网地址;
 *   - 回环来的(工人、Mac 上的页面、ADB 反向的手机):本机签、地址原样(回环);
 *   - 局域网里的设备:本机签、地址是它进来的那块网卡;本机没钥匙才中转(今天的老路);
 *   - **外网来的设备**(对面的地址不是局域网网段):中转签,签不出再退回本机 —— 明文的本机房间不该是外网的首选。
 *
 * 在家那几条一下都不碰中转:中转不通不影响在家签票(卡 M2 第 4 条)。
 */
export function channelPlanOf(input: {
  caller?: ChannelCaller
  /** 本机有钥匙时配置里的那个地址;没有钥匙 = 缺席。 */
  localUrl?: string
  /** 接了中转(能让中转签)。 */
  relay: boolean
  /** 这台 Mac 此刻的局域网地址,第一项最可能(`lan.ts` 的 `lanAddresses`,en0 优先)。 */
  lanAddresses?: readonly string[]
}): ChannelPlan | undefined {
  const lan = (host: string | undefined): ChannelPlan | undefined =>
    input.localUrl === undefined ? undefined : { route: 'lan', url: advertisedUrlOf(input.localUrl, host) }
  const relay: ChannelPlan | undefined = input.relay ? { route: 'relay' } : undefined
  const caller = input.caller
  if (caller === undefined) return lan(undefined) ?? relay
  if (caller.want === 'relay') return relay
  if (caller.want === 'lan') return lan(undefined)
  if (caller.proxied !== undefined) {
    if (caller.proxied.route === 'relay') return relay
    return lan(input.lanAddresses?.[0]) ?? relay
  }
  const local = caller.localAddress
  if (local === undefined || isThisMachineHost(local)) return lan(undefined) ?? relay
  const remote = caller.remoteAddress
  const outside = remote !== undefined && remote.trim() !== '' && !isThisMachineHost(remote) && !isPrivateAddress(remote)
  if (!outside) return lan(local) ?? relay
  const fallback = lan(local)
  if (relay === undefined) return fallback
  return fallback?.route === 'lan' ? { route: 'relay', fallback } : relay
}

// ———————————————————————— 哪几条路线要工人(2026-10-22,局域网主路 M6) ————————————————————————

/**
 * 一条路线此刻要不要一条工人。`keep` = 这会儿说不准(中转一时问不到):在房里的不停、没起的不起,
 * 不为一次网络抖动把出门那一路的工人拔掉。
 */
export type ChannelWorkerRouteWant =
  | { want: true, url: string, room: string }
  | { want: false, note: string }
  | { want: 'keep', note: string }

export type ChannelWorkerRoutes = Record<ChannelRoute, ChannelWorkerRouteWant>

export const WORKER_ROUTE_NO_LOCAL_KEY = '这台没有本机房间的钥匙(channel.json)'
export const WORKER_ROUTE_NO_RELAY = '这台没接中转,只有本机房间'
export const WORKER_ROUTE_RELAY_NOT_READY = '服务器上还没配 LiveKit,云房间这会儿进不了'
/** 本机钥匙签的就是云上那同一间:两条工人同一个身份进同一间房会互相踢,一条就够。 */
export const WORKER_ROUTE_SAME_ROOM = '本机钥匙签的就是云上这一间,一条工人就够'

/**
 * 「还没登录」这一种答案记多久(毫秒)。这段时间里 30 秒那一拍不再去问中转 —— 没登录的机器每 30 秒白敲一次门;
 * 登录那一下(账号绑定,`onRoomChanged`)与他点「起」都 `force`,当场再问。
 */
export const CHANNEL_WORKER_RELAY_RECHECK_MS = 5 * 60_000

function sameRoom(a: { url: string, room: string }, b: { url: string, room: string }): boolean {
  const bare = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase()
  return a.room === b.room && bare(a.url) === bare(b.url)
}

/**
 * **哪几条路线要一条工人**(纯函数)。本机有钥匙 → 本机房间一条(地址原样,就是工人回环连的那个);
 * 中转签得出云房间、又不是本机钥匙签的那同一间 → 云房间再一条。中转回的失败分两种:
 * 网络 / 服务器 → `keep`;其余(没登录、令牌不对、没接中转)→ 不要,那句人话原样带上。
 */
export function workerRoutesOf(input: {
  local?: { url: string, room: string }
  /** 中转那一份(`ChannelCredentialStore.get()` 的回答)。没接中转 = 缺席。 */
  relay?: { ok: true, credentials: RemoteChannelCredentials } | { ok: false, reason: string, error: string }
}): ChannelWorkerRoutes {
  const lan: ChannelWorkerRouteWant = input.local === undefined
    ? { want: false, note: WORKER_ROUTE_NO_LOCAL_KEY }
    : { want: true, url: input.local.url, room: input.local.room }
  const relayOf = (): ChannelWorkerRouteWant => {
    const answer = input.relay
    if (answer === undefined) return { want: false, note: WORKER_ROUTE_NO_RELAY }
    if (!answer.ok) {
      return answer.reason === 'network' || answer.reason === 'server'
        ? { want: 'keep', note: answer.error }
        : { want: false, note: answer.error }
    }
    const { configured, url, room } = answer.credentials.livekit
    if (!configured || url === undefined || room === undefined) return { want: false, note: WORKER_ROUTE_RELAY_NOT_READY }
    if (input.local !== undefined && sameRoom(input.local, { url, room })) return { want: false, note: WORKER_ROUTE_SAME_ROOM }
    return { want: true, url, room }
  }
  return { lan, relay: relayOf() }
}

/** 默认配置文件位置:跟凭据同一个数据目录,不进仓库。 */
export function defaultChannelConfigFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/channel.json`
}

// ———————————————————————— 进房凭证(LiveKit access token) ————————————————————————

/**
 * LiveKit 的进房凭证就是一个 HS256 JWT,没有别的花样:
 * `iss` = api key,`sub` = 身份,`video` = 授权。所以这里**不引第三方 SDK** ——
 * 一个 JWT 值不得让插件的依赖树多一棵子树(它最后要装进 ~/.dsh 运行时)。
 */
export interface ChannelGrant {
  room: string
  roomJoin?: boolean
  canPublish?: boolean
  canSubscribe?: boolean
  canPublishData?: boolean
  roomAdmin?: boolean
  roomList?: boolean
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface SignAccessTokenInput {
  apiKey: string
  apiSecret: string
  identity: string
  grant: ChannelGrant
  /** 房里显示的名字(可选)。 */
  name?: string
  /**
   * 签进凭证的参与者属性(可选)。进房后房里别的参与者读得到,**持证人自己改不了**
   * (授权里没有 canUpdateOwnMetadata)—— 工人就是靠这一点信任里头的设备 id。
   */
  attributes?: Record<string, string>
  /**
   * 签进凭证的 metadata(可选,2026-09-21)。一行 JSON `{device_id, name, kind}` ——
   * 房里的「在线设备表」认的就是它。和 attributes 同一条理由可信:**签在凭证里,持证人改不了**。
   *
   * 为什么不只用 attributes:设备名是给人看的(「Ben 的手机」「书房 Mac」),
   * attributes 是给程序降权用的一个 id。两件事混在一个键里,迟早有人把名字当 id 用。
   */
  metadata?: string
  ttlSeconds: number
  /** 现在几点(秒)。测试注入固定值。 */
  nowSeconds: number
}

/** 签一张 LiveKit 进房凭证。**secret 只在这个函数里出现**,签完就没了。 */
export function signAccessToken(input: SignAccessTokenInput): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    iss: input.apiKey,
    sub: input.identity,
    nbf: input.nowSeconds,
    exp: input.nowSeconds + input.ttlSeconds,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
    video: input.grant,
  }))
  const signature = base64url(createHmac('sha256', input.apiSecret).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${signature}`
}

/**
 * 手机/浏览器的授权:进这一个房、能说能听能发数据。给的就是这四样,一样不多:
 *
 * - **没有 roomAdmin / roomList** —— 它不该能踢人、关房、看别的房;
 * - **没有 canUpdateOwnMetadata** —— 它不该能改自己的属性。工人是按属性里的
 *   `wb_device_id` 决定用谁的权限去调 8791 的,能改属性就等于能改自己是谁;
 * - **没有 roomRecord / ingressAdmin** 之类的一切。
 */
export function joinGrant(room: string): ChannelGrant {
  return { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true }
}

/**
 * 凭证里那行设备 metadata(2026-09-21)。`{device_id, name, kind}`,一行 JSON。
 *
 * - `kind`:工人 = `mac`,已配对的设备 = `phone`。**回环测试页(`wb-dev-*`)压根不给** ——
 *   它不是一台设备,不该出现在「发到…」的选单里(见 channel-worker/src/files/devices.ts)。
 * - `name`:调用方给的那个(手机侧由 8791 用配对记录里的名字覆盖,自称的名字不作数)。
 *   没给就用 identity —— **不编一个好看的名字**。
 */
export function channelDeviceMetadata(input: {
  identity: string
  deviceId?: string
  name?: string
  worker?: boolean
}): string | undefined {
  const kind = input.worker === true
    ? 'mac'
    : (input.deviceId !== undefined && input.deviceId !== '' ? 'phone' : undefined)
  if (kind === undefined) return undefined
  return JSON.stringify({
    device_id: input.deviceId !== undefined && input.deviceId !== '' ? input.deviceId : input.identity,
    name: input.name !== undefined && input.name.trim() !== '' ? input.name.trim() : input.identity,
    kind,
  })
}

/** 查房间用的授权:只读,不进房。 */
export function adminGrant(room: string): ChannelGrant {
  return { room, roomAdmin: true, roomList: true }
}

/**
 * 身份怎么拼。**调用方说了不算**:
 *   - 已配对的手机 → `wb-phone-<device_id>`(将来要按设备踢人、按设备限权,身份里得有设备)。
 *   - 本机回环 → `wb-dev-<后缀>`(测试页)。
 * 两者都只保留 `[A-Za-z0-9_-]`,别的字符换成 `-` —— 身份要进 JWT 和房间列表,不给它带奇怪字节。
 */
export function channelIdentityOf(input: { deviceId?: string, suffix?: string, worker?: boolean }): string {
  const clean = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48)
  /**
   * 工人的身份。**第一台电脑固定是 `wb-channel-worker`** —— 手机只认这个字符串(butler-app
   * 的 channelProtocol.ts 写死了),动它就等于把手机那条路弄断。
   *
   * 2026-09-21:同一个房间里可能有第二台电脑,它得有个不一样的身份,于是
   * `wb-channel-worker-<后缀>`。后缀由那台机器自己的 `WORKBENCH_CHANNEL_WORKER_SUFFIX` 给,
   * 在这里清洗一遍再用 —— 身份要进 JWT 和房间列表,不给它带奇怪字节。
   */
  if (input.worker === true) {
    const suffix = input.suffix !== undefined && input.suffix.trim() !== '' ? clean(input.suffix.trim()) : undefined
    return suffix === undefined ? CHANNEL_WORKER_IDENTITY : `${CHANNEL_WORKER_IDENTITY}-${suffix}`
  }
  if (input.deviceId !== undefined && input.deviceId !== '') return `${CHANNEL_PHONE_PREFIX}${clean(input.deviceId)}`
  const suffix = input.suffix !== undefined && input.suffix !== '' ? clean(input.suffix) : 'page'
  return `${CHANNEL_DEV_PREFIX}${suffix}`
}

// ———————————————————————— 状态 ————————————————————————

export interface ChannelStatus {
  /** 配置齐了没有(key/secret 都在)。没齐时下面几项一律缺席 —— 不猜。 */
  configured: boolean
  url?: string
  room?: string
  /** 走的是本机那台 dev 服务器还是远程碰头点。没配时缺席。 */
  mode?: ChannelMode
  /** 进房凭证的有效期(秒)。手机据此决定多久续一次;没配时缺席。 */
  token_ttl_seconds?: number
  /** livekit-server 应答了没有。探不到就是 false,并在 note 里说一句为什么。 */
  server: boolean
  /** 工人在房里没有。server 探不到时一律 false(不是「不知道」就写 true)。 */
  worker: boolean
  /** 房里此刻的身份列表(工人也在内)。探不到就缺席。 */
  participants?: readonly string[]
  /** 探测失败的原因,一句人话。成功时缺席。 */
  note?: string
  /** 这份配置从哪儿来(2026-09-21)。见 ChannelConfigSource。 */
  source?: ChannelConfigSource
  /**
   * 问的这一位此刻该在哪条路线的房里(2026-10-21,局域网主路)。与它这时候签票得到的 `route` 同一条规矩
   * ({@link channelPlanOf}),`url` / `room` 也是那一间的。没配时缺席。
   */
  route?: ChannelRoute
  /**
   * 「没配」的那一种是**还没登录**(2026-09-21)。
   * 这一格为真时界面该说的是「登录后可用」,而不是「通道没配」——
   * 后者会让一个什么都没做错的新用户以为是自己漏了一步。
   */
  needs_login?: boolean
}

/** 工人要的那一份凭据(`GET /channel/credentials`)。**只给本机**。 */
export interface ChannelWorkerCredentials {
  source: ChannelConfigSource
  volc_asr?: { app_id: string, access_token: string, resource_id?: string }
  volc_tts?: { app_id: string, access_token: string, resource_id?: string, cluster?: string }
  /** 这一份什么时候过期(ISO)。工人据此决定什么时候再问一次。 */
  expires_at?: string
  /** 取不到时的一句人话。取到了就缺席。 */
  note?: string
}

/** ListParticipants 的回包 → 身份列表。解析不出来就空 —— **绝不抛**。 */
export function participantIdentitiesOf(body: unknown): readonly string[] {
  const raw = (body !== null && typeof body === 'object' ? body : {}) as { participants?: unknown }
  if (!Array.isArray(raw.participants)) return []
  const out: string[] = []
  for (const item of raw.participants) {
    const identity = (item as { identity?: unknown })?.identity
    if (typeof identity === 'string' && identity !== '') out.push(identity)
  }
  return out
}

// ———————————————————————— 人设 ————————————————————————

export interface ChannelPersona {
  system_message: string
  /**
   * **同一份人设,一段一段带标记**(2026-10-03,卡「chat 路人设按意图裁」)。
   *
   * 按顺序把 `text` 拼起来**逐字就是** {@link system_message}(有对照用例)——
   * 多这一格只为让工人能按这一回合的意图把用不上的段摘掉(`channel-worker/src/personaTrim.ts`)。
   * 标记的含义见 {@link ChannelPersonaSection}。
   *
   * 老工人不认这一格 = 照旧每回合整份带 {@link system_message},一字不差。
   */
  persona_sections?: readonly ChannelPersonaSection[]
  welcome: string
  butler_name?: string
  /** 只是「怎么说话」那一段(2026-09-18):引导模式下工人自己拼提示时用它,语气不分叉。 */
  style?: string
  /**
   * 电话里怎么叫他(2026-09-23)。`~/.dsh/AGENTS.md` 的「称呼」标记段,一行一个。
   * 没写过就**缺席** —— 工人有它自己的缺省(channel-worker 的 address.ts),这里不编一个。
   */
  addresses?: readonly string[]
  /**
   * 每轮最多几句(2026-09-24 晚,卡 K)。从规矩表算(「电话每轮不超过两句」→ 2),工人在流上掐;
   * 规矩表里没有这一条就缺席 = 不掐。
   */
  max_sentences?: number
  /**
   * **识别热词**(2026-10-02,卡「电话里像个活人」):这台机器上的家名、事务官的名字、
   * 称呼、账号名、小组件名、她最近说过的专有词。工人把它交给火山的 `corpus.hotwords`
   * (流式)与 8792 的 `/api/asr`(分段兜底)。怎么来的见 {@link channelHotwords}。
   * **一个词都算不出来时整格缺席** —— 工人那边 `hotwords` 缺席就是「不带热词」,和以前一字不差。
   */
  hotwords?: readonly string[]
}

const DEFAULT_STYLE = '一次说一两句,像打电话那样,别念稿子。'

/* ──────────────────────── 耳朵:这台机器上的词表 ──────────────────────── */

/**
 * **识别热词**(2026-10-02,卡「电话里像个活人」)。
 *
 * Air 那一通里「Codex」被听成 to death / 泄露 / Cold death,**来回五轮**:
 * 「没听清,你说的是哪个额度?」「两个名字都撞上了,我听不准……」。
 * 维护者点的根子是「耳朵不认识她的词」—— 识别那一头从来没拿到过这台机器上的名字。
 *
 * 火山大模型流式识别**本来就收热词**(`request.corpus.hotwords`,见
 * channel-worker/src/asr/volcProtocol.ts 的 `buildCorpus`);分段兜底那一路也收
 * (8792 的 `/api/asr` 带 `hotwords`)。两条路的收法 09-25 就写好了,
 * **但一直没有人往里面填东西** —— `createAsr({ hotwords })` 的调用方从来没给过这一格。
 * 这个函数就是那一格的内容,由 `GET /channel/persona` 下发给工人。
 *
 * 词从哪儿来(都是**数出来的**,不经模型):
 *   ① **家名**:登记表里那几家的称呼(`DISPATCH_FAMILY_TITLES`)+ 家名本身(`codex`/`manus`…);
 *   ② **她给事务官起的名字**与**称呼表**里那几个(她天天念);
 *   ③ **最近她说过的专有词**:看板上事项标题里的拉丁字母词(Codex / Manus / PDF / UI 这一类)——
 *      中文词不收,中文识别本来就不太错,收进去只会把同音字拉偏;
 *   ④ **调用方再给的那些**({@link ChannelServiceDeps.extraHotwords}:账号名、小组件名)。
 *
 * 两条分寸(与 `buildCorpus` 那边同一条):**单字不收**(单字热词会把同音字一起拉偏)、
 * **去重**、**有上限**(火山那头对 corpus 长度有限制,词太多等于没有重点)。
 */
export const CHANNEL_HOTWORDS_MAX = 60

/** 一个词值不值得当热词。单字不收、太长不收(那是一句话,不是一个词)。 */
function usableHotword(word: string): boolean {
  const one = word.trim()
  return [...one].length >= 2 && [...one].length <= 20
}

/** 事项标题里的拉丁字母词(「派 Codex 修小组件」→ `Codex`)。 */
export function latinWordsIn(text: string): string[] {
  return (text.match(/[A-Za-z][A-Za-z0-9+#.-]{1,19}/g) ?? []).filter(one => one.length >= 2)
}

export function channelHotwords(input: {
  agentsText?: string
  tasks?: TasksState
  butlerName?: string
  extra?: readonly string[]
}): readonly string[] {
  const out: string[] = []
  const add = (word: unknown): void => {
    if (typeof word !== 'string') return
    const one = word.trim()
    if (!usableHotword(one)) return
    if (out.some(had => had.toLowerCase() === one.toLowerCase())) return
    if (out.length >= CHANNEL_HOTWORDS_MAX) return
    out.push(one)
  }
  // ① 家名:称呼与家名本身(「豆包办公」与 `doubao` 她都可能说)
  for (const [family, title] of Object.entries(DISPATCH_FAMILY_TITLES)) { add(title); add(family) }
  // ② 事务官的名字与称呼表
  add(input.butlerName)
  for (const one of callAddressesOf(input.agentsText)) add(one)
  // ④ 调用方给的(账号名、小组件名)—— 排在事项标题前面:它们是登记在册的,比标题里抠出来的准
  for (const one of input.extra ?? []) add(one)
  // ③ 最近她说过的专有词:看板上事项标题里的拉丁词(新的排前面)
  for (const task of [...(input.tasks?.tasks ?? [])].reverse()) {
    for (const one of latinWordsIn(task.title)) add(one)
  }
  return out
}

/**
 * 电话里对面那个人怎么称。
 *
 * ——— 为什么不写死「他」(2026-10-02,卡「电话里像个活人」)———
 *
 * 这份提示词从 09-18 起通篇写「他」—— 维护者自己是第一个用户。可**运营同学是女生**,
 * 而这份提示词是她这通电话的全部人格来源:里头六十多个「他」会原样漂进她听到的话里。
 *
 * 所以称谓从**称呼表**(`~/.dsh/AGENTS.md` 的「称呼」标记段)来:表里有就用第一个(「小笨蛋」),
 * 没有就用中性的「对方」。**不编一个性别**。
 */
export const NEUTRAL_ADDRESS = '对方'

export function personaAddress(agentsText: string | undefined): string {
  for (const one of callAddressesOf(agentsText)) {
    const trimmed = typeof one === 'string' ? one.trim() : ''
    // 一个称呼长过 12 个字基本是把一整句话写进表里了(见 channel-worker 的 address.ts 同一条)。
    if (trimmed !== '' && trimmed.length <= 12) return trimmed
  }
  return NEUTRAL_ADDRESS
}

/**
 * 工人的系统提示。与 0.2.33 通话模式那份(server/rtcCall.ts buildCallSystemMessage)**同源不同文**:
 * 名字、说话方式、事项摘要三样取自同一处;能做什么不一样 —— 这条链路的工具在本机直接执行,
 * 不依赖任何公网回调,所以工具**永远是开着的**,不存在「这通电话记不了事项」那种降级。
 *
 * ——— 2026-10-02「电话里像个活人」改了四处(卡,根子见 docs/分析-和事务官说话为什么费劲-2026-10-02.md)———
 *
 * ① **一个「我」**。09-18 那一版第一句写「你是他的事务官」,底下又写「交给**事务官本尊**去办」
 *    「办成了说『我让事务官去办』」—— 同一份说明里它既是事务官、又是事务官的传话人。
 *    Air 那几通里「事务官」出现 35 次多是第三人称,她当场问:「你是什么身份?你是事务官还是?」
 *    现在:电话里的就是事务官本人,电脑上那条会话是**它自己的手**,不是另一个人。
 * ② **规矩留判断、删话术**。澄清环节(不可改清单上那一项)保留的是「拿不准才问」那个判断;
 *    固定三问模板删掉 —— 查个天气也过一遍三条确认点,那就是她说的「念了一遍经书」。
 * ③ **只说她关心的**。不念栏位名、状态名、「会话」、通话记录本身;内部原因只在她问「为什么」时说。
 * ④ **跟着她的长短说**。她平均 12 个字,事务官平均 87 个字(Air 326 回合)。默认一句。
 *
 * ——— 2026-10-03「chat 路人设按意图裁」(维护者拍板「做」)———
 *
 * 这一份 3159 字,工人**每一个回合**整份带上;chat 路首声 p95 1934ms 全在
 * 「长人设 + 模型 + 跨境一跳」上(交接-1003-首声提速第一节末)。于是这一份从
 * 「一整段字」改成**一段一段带标记**({@link channelPersonaSections}):
 * 哪几段任何回合都得带(身份 / 底线 / 语气 / 澄清),哪几段只有办某一类事时才用得上。
 * 裁在工人那一侧(`channel-worker/src/personaTrim.ts`),**这一头只负责标**。
 * {@link buildChannelSystemMessage} 仍然是那一整段、**逐字不变**(就是把这几段拼回去)。
 */
export function buildChannelSystemMessage(input: ChannelPersonaInput): string {
  return channelPersonaSections(input).map(one => one.text).join('\n')
}

export interface ChannelPersonaInput {
  agentsText?: string
  tasks?: TasksState
  /** 收文件落在哪(只说目录名,不说绝对路径 —— 电话里念路径听不懂)。 */
  inboxName?: string
  rememberTool: string
  doingTool: string
  handTool: string
  /**
   * 他的规矩那一段(2026-09-24 晚,卡 K;server/rules.ts 的 `callRulesBlock`)。说话与全局那几条全文,
   * 其余只列短名 —— 他问「我的规矩有哪些」她说得出来,又不把「每轮两句」稀释掉。缺席 = 整段不出现。
   */
  rulesBlock?: string
  /**
   * 「她要跟你聊的那一条资讯」那一段(2026-10-13,卡「播客页重做」;`server/feedDig.ts` 拼好)。
   * 缺席 = 整段不出现(绝大多数电话都是这样)。**标 `always`**:这一通就是为它打的,
   * 任何回合都不能把它裁掉 —— 裁掉之后她问「那条到底怎么说」,事务官就不知道在说哪条。
   */
  digBlock?: string
}

/**
 * 人设的**一段**,外加「这一回合用不用得上它」那个标记(2026-10-03,卡 ②)。
 *
 * 由 `GET /channel/persona` 的 `persona_sections` 下发给工人;工人每一回合只带
 * 「必带段 + 这一回合用得上的段」,**认不出的形状一律带整份**(不漏规矩)。
 * 裁法与退路全在 `channel-worker/src/personaTrim.ts` 的文件头。
 *
 * 四种标记,**一段至少有一种**(一种都没有的段工人会判成「我看不懂这份人设」→ 整份退回):
 */
export interface ChannelPersonaSection {
  /** 段名(电话里从来不念它,只给日志与用例认)。 */
  name: string
  /** 这一段的原文。**按顺序拼起来逐字就是** {@link buildChannelSystemMessage}。 */
  text: string
  /** 任何回合都得带(身份 / 底线 / 语气 / 澄清环节 —— 后两样在不可改清单上)。 */
  always?: true
  /** 哪些意图用得上它(id 与 `channel-worker/src/intentTools.ts` 同一套,见 {@link PERSONA_ACT_INTENTS})。 */
  intents?: readonly string[]
  /**
   * 这一段讲的是**哪一件工具**:这一回合手上有它才带。
   *
   * 为什么按工具名而不是按意图标:工具按意图下发那张表在工人手上(`intentTools.ts`),
   * 在这儿再抄一份意图↔工具的对应迟早对不上。按工具名标,工人拿**这一回合真送出去的那几件**
   * 一比就完 —— 说明书与手上那几件天生对齐,不可能出现「说明书讲了一件手上没有的工具」。
   */
  tool?: string
  /** 这一段是**一组的头**(【你能做什么】那一行):组里有别的段带上了才带它。 */
  head?: string
  /** 这一段属于哪一组(带上它,组的头就跟着带上)。 */
  group?: string
}

/**
 * 要办事的那几个意图 id。**与 `channel-worker/src/intentTools.ts` 的 `INTENT_TOOLS` 同一套**
 * ——— 有一条对照用例读那个文件的源码比对,少一个就红(`tests/persona-sections-1003.test.ts`)。
 *
 * 标成这一组 = 「**任何**要办事的回合都用得上」:工具的成败怎么说、听不准名字怎么办、
 * 她手上的事那份快照 —— 这几段与手上具体是哪一件工具无关,但闲聊回合(零工具)用不上。
 */
export const PERSONA_ACT_INTENTS: readonly string[] = [
  'remember', 'dispatch', 'voice', 'file', 'lookup', 'relay',
  'operate', 'change', 'pick', 'callout', 'address', 'find', 'status',
]

/** 【你能做什么】那一组的组名(头与成员共用)。 */
export const PERSONA_TOOLS_GROUP = '你能做什么'

/**
 * **闲聊那一侧也有意图**(2026-10-13 夜,卡 V):「介绍自己」走 chat 路(零工具),但要带上那份材料。
 * 与 `PERSONA_ACT_INTENTS` 合起来 = 工人 `intentTools.ts` 的全部 id(对照用例盯着)。
 */
export const PERSONA_CHAT_INTENTS: readonly string[] = [INTRO_INTENT]

export function channelPersonaSections(input: ChannelPersonaInput): readonly ChannelPersonaSection[] {
  const name = butlerNameOf(input.agentsText)
  /** 电话里对面那个人怎么称(称呼表的第一个,没有就「对方」)。见 {@link personaAddress}。 */
  const u = personaAddress(input.agentsText)
  const style = speakingStyleOf(input.agentsText) ?? DEFAULT_STYLE
  const who = name === undefined ? '你就是事务官。' : `你就是事务官,名字叫${name}。`
  /**
   * 他在以前的电话里立下的长期规矩(2026-09-23)。**排在「怎么说话」后面** ——
   * 它们是对语气与做法的修订,写在规矩前面才管得住后面那几条。
   * 一条都没有时整段缺席:一个空的「他说过的」比没有更让人以为她忘了。
   */
  const prefs = callPreferencesOf(input.agentsText)
  const prefBlock = prefs.length === 0
    ? []
    : ['', `【${u}以前在电话里说过、以后都算数的】`, ...prefs.map(one => `- ${one}`)]
  const sections: ChannelPersonaSection[] = []
  /** 一段进表。`lines` 原样拼成 `text` —— 按顺序把 `text` 拼回去,逐字就是以前那一整段。 */
  const add = (one: Omit<ChannelPersonaSection, 'text'> & { lines: readonly string[] }): void => {
    const { lines, ...rest } = one
    sections.push({ ...rest, text: lines.join('\n') })
  }

  add({
    name: '开头',
    always: true,
    lines: [`${who}${u}在手机上跟你说话:你说的每个字都会被念出来,${u}随时可以打断你。`],
  })
  /*
   * ——— 「一个「我」」那一段(2026-10-02)———
   *
   * Air 那几通里「事务官」出现 35 次、多是第三人称(「这些都归事务官」「事务官这边我去看」),
   * 她听糊涂了直接问:「你是什么身份?你是事务官还是?」。病根在这份提示词自己:
   * 第一句写「你是他的事务官」,底下又写「交给事务官本尊去办」。
   *
   * 这一段是那句话的反面,而且必须排在最前面 —— 底下每一条工具说明都要照它读。
   * **身份那一段,任何回合都带**(2026-10-03)。
   */
  add({
    name: '【只有一个「我」】',
    always: true,
    lines: [
      '',
      '【只有一个「我」】',
      `- 电话里的你**就是**事务官本人。电脑上那条会话是**你自己的手**,不是另一个人、不是你的同事。`,
      '- 所以:**永远说「我」**。「我去办」「我查了」「我没办成」。',
      '- **不许**说「我让事务官去办」「交给事务官本尊」「事务官这边」「这些都归事务官」'
      + `—— 那等于当着${u}的面把自己说成第三个人。`,
      '- 不说「开了一条会话」「派了个任务」这种内部说法;那是你动手的方式,不是她要听的事。',
    ],
  })
  add({ name: '【怎么说话】', always: true, lines: ['', '【怎么说话】', style] })
  // 他以前在电话里说过的那几条:一条都没有时**整段缺席**(见上面 prefBlock 那段注释)。
  if (prefBlock.length > 0) add({ name: '【以前说过、以后都算数的】', always: true, lines: prefBlock })
  // 他的规矩那一段(卡 K)。缺席 = 整段不出现;在就是底线,任何回合都带。
  if (input.rulesBlock !== undefined && input.rulesBlock.trim() !== '') {
    add({ name: '他的规矩', always: true, lines: ['', input.rulesBlock.trim()] })
  }
  /*
   * 她要跟你聊的那一条资讯(2026-10-13)。排在规矩后面、说话规矩前面:
   * 它是**这一通的来由**,得在「怎么说话」之前读到;而它不能盖掉底线与规矩。
   */
  if (input.digBlock !== undefined && input.digBlock.trim() !== '') {
    add({ name: FEED_DIG_SECTION, always: true, lines: ['', input.digBlock.trim()] })
  }
  add({
    name: '【说话的规矩】',
    always: true,
    lines: [
      '',
      '【说话的规矩】',
      /*
       * 2026-10-02:长短跟着她走。Air 326 回合里她平均 **12 字**、事务官平均 **87 字** ——
       * 七倍。以前这一条写的是「一次一两句」,没有「比着谁」,于是状态 + 下一步 + 提醒
       * 全塞进同一句。`max_sentences` 那道硬闸(规矩表 → sentenceCap.ts)照旧在,这一条是它前面的分寸。
       */
      `- **跟着${u}的长短说**:默认**一句**。${u}说得长你才能说第二句;真有细节要交代,`
      + '先问一句「要细说吗」,等她说要才说。',
      '- 不念清单、不念 Markdown、不念代码、不念链接和 id —— 那些用耳朵听不懂。',
      '- 不知道就说不知道,数字拿不到就说拿不到,绝不编。',
      `- ${u}一开口你就停下来听。`,
      // 2026-09-23,Ben:「你非常不智能,你像个机器人。」——套公式的那三条明着禁掉。
      '- **不要套公式**:不要每次都「先说有什么事、再念一遍标题、再问批准不批准」。'
      + '**也不要每次用同一句开场**(「有什么吩咐」「有件事跟你确认一下」这种模板,一次都不要)。',
      `- **不要自我介绍**、不要说「是我」—— 这个电话只有你会打给${u},${u}知道是你。`,
      '- 念事情用人话讲,**不要把标题原样念出来**。',
      /*
       * ——— 「只说她关心的」(2026-10-02)———
       *
       * Air 那几通里卡 / 待办 / 看板 / 等你确认 出现 34 次、「会话」13 次,还把通话本身当一件事播报
       * (「插一句:『和事务官通了个电话(5 秒)』办完了」)。她关心的只有三件:好了没、在哪、要我做什么。
       */
      `- **只说${u}关心的**,顺序是「结果 → 要${u}做的那一件事」。没有要她做的事就只说结果,一句收。`,
      '- **不念系统里的名词**:卡、事项、待办、在办、看板、栏位、状态、等你确认、未确认、会话、任务 id'
      + ' —— 这些是我们记账用的词,她听不懂也不关心。要说就说那件事本身(「天气问到了」「音乐开起来了」)。',
      '- **不把通话本身当一件事报**:她正在跟你说话,不用告诉她「我们通了个电话」。',
      `- **内部原因只在${u}问「为什么」「怎么回事」时才说**。没问就只给结果与下一步。`,
      /*
       * 2026-09-27(卡 MS):21:17 那一通她说的是「办上了…… **要是到时候打不通,我可不管**」。
       * 维护者要的正相反:办不成是我们的事,不是他的。这一条明着写进人设 ——
       * 那句话不是模型突发奇想,是这份单子里从来没有一条管过"办不成的时候怎么说"。
       */
      /*
       * 2026-09-28(卡 CF 第 7 条):那一通最后一句是「……缺一把豆包火山的钥匙。狗东西接不」。
       * 查过了:「狗东西」不在称呼表里、不在这份提示词里、也不是识别结果 —— 是模型自己生的。
       * 流式合成拦不住半句话,所以这一条明着写进单子里;我们**自己拼**的每一句另有一道
       * (channel-worker/src/spokenSafe.ts)。
       */
      '- **不许骂人、不许带脏字**(「狗东西」「他妈的」这类一个字都不许出现)。东西没接上就说没接上,气是她的,不是你的。',
      /*
       * 2026-09-28(卡 CF 第 8 条):真机上念给他听的是「窗口:这台电脑上还没接上 doub…」、
       * 「接口:服务器没配 豆包(火山方舟)(缺 RELAY_DOUBAO_KEY)」。包标识、环境变量名、
       * 我们分段用的前缀都是给查日志的人看的。
       */
      '- **不念内部字段**:包标识(com.xxx.yyy)、环境变量名(RELAY_XXX_KEY)、「窗口:」「接口:」这类前缀一个都不念。'
      + '走不通就说那一条走不通的**人话原因**,一句就够。',
      '- **不许甩锅、不许免责**。「到时候打不通我可不管」「你自己看着办」「不关我的事」这类话一句都不许说:'
      + '办不成是我们的事。真没办成就说**卡在哪一步**(送不进去 / 那家窗口没开 / 服务器没配),'
      + `说下一步我去做什么,然后**有结果了打电话告诉${u}**。`,
    ],
  })
  /*
   * ——— 澄清环节(2026-10-02)———
   *
   * 「澄清环节」在不可改清单上(PRD §9),改的不是它,是它被写成了话术:
   * 09-23 的三条确认点落到电话里成了固定三问,Air 那几通里「要你确认三点 / 跟你核三条」8 次,
   * 连「查个天气」「放进发布计划」都要过一遍。
   * 保留的是**判断**:拿不准才问、一次只问最要紧的一件、用她的话问。
   *
   * **它在不可改清单上,所以标 `always`** —— 裁人设那一条不许碰它(2026-10-03)。
   */
  add({
    name: '【拿不准的时候怎么问】',
    always: true,
    lines: [
      '',
      '【拿不准的时候怎么问】',
      `- **听懂了就直接办**,办完说结果。${u}话里缺的那一块不影响做法,就按最可能的那个做,顺口说一句你按什么做的。`,
      '- **真拿不准才问**,而且**一次只问最要紧的那一件** —— 就是那个「答案不同、做法就不同」的点。',
      `- 问的时候**用${u}自己的话**问(「你说的小组件是消耗数据那个吗?」),不要列①②③、不要念「要确认的」「确认点」。`,
      '- **不要复述一遍她刚说的话**再问。她刚说完,她知道自己说了什么。',
      /*
       * ★ **只问四类事**(2026-10-04,卡 `claude/three-small-1004`;维护者点头)。
       * 上面那几条说的是**怎么问**,这两条说的是**问什么** —— 维护者:
       * 「别拿细枝末节来问我拍板」;运营同学 10-02:「频繁询问是否继续」。
       * 字只有一处定:`confirmPoints.askOnlyFourKindsBlock`(与事项第一条消息、技能正文同一份)。
       */
      ...askOnlyFourKindsBlock(u).map(line => `- ${line}`),
    ],
  })
  /**
   * 【语气】(2026-10-02,卡「声音与形象跟着话走」)。
   *
   * 维护者:「在前端通过文字、TTS、实际动作能不能把用户哄开心,我们其实没下过功夫。」
   * 查实(docs/设计-活人感标准与前端差距-2026-10-02 第三节):合成那头**一个语气参数都没传过**,
   * 默认音色全靠自己揣摩 —— 同一句「好的」有时像在赌气。而模型其实知道这句话该用什么语气。
   *
   * 所以这里只多要一件事:**每句开头写一个语气标签**。那个标签在念之前被剥掉
   * (channel-worker/src/tts/tone.ts),字幕上也不显示 —— 它只管声音与那张脸。
   * **短列表与别名的主人是 tone.ts**,这几个字与那份列表有对照用例(tone-1002.test.ts)。
   *
   * 每一句话都要带那个标签,所以它是**必带段**(2026-10-03,卡上点名的三样之一)。
   */
  add({
    name: '【语气】',
    always: true,
    lines: [
      '',
      '【语气】',
      '- **每句话开头给一个语气标签**,方括号括起来,就这七个里挑一个:'
      + '[平静] [高兴] [关心] [歉意] [着急] [轻声] [疑问]。例:`[关心]你今天听着有点累。`',
      `- 拿不准就写 [平静]。标签**不会被念出来**,${u}看不见也听不见它 —— 它只决定你的声音和表情。`,
      '- 需要更具体的时候,可以在标签里加一句**不超过二十字**的说明,竖线隔开:'
      + '`[关心|慢一点、轻一点说]`。一句话一个标签,句子中间不要再写。',
    ],
  })
  /*
   * ★ **介绍自己**(2026-10-13 夜,卡 V):对方问「能介绍一下自己吗 / 你是谁 / 你能做什么」那一回合才带。
   * 材料与规矩都在 `introKnowledge.ts`(来处:AGENTS.md 与官网首页);这里只负责把它作为一段挂上、标上意图。
   */
  add({
    // 段名写字面:工人 `persona-trim-1003.test.ts` 读这份源码比对 `name: '【介绍自己】'`(与 `INTRO_SECTION_NAME` 同一个字,有对照用例)。
    name: '【介绍自己】',
    intents: [INTRO_INTENT],
    lines: ['', `${INTRO_SECTION_NAME}(${u}或对方问你是谁、能做什么时,只按下面这份材料说)`, ...INTRO_KNOWLEDGE_LINES, '', '我们的想法(官网「事务官手记」六篇,一篇一条):', ...INTRO_THOUGHT_LINES, '', '介绍自己的规矩:', ...INTRO_RULES_LINES],
  })
  // 她手上的事那份快照:闲聊回合用不上(她没问事、也没工具去查),要办事的回合都用得上。
  add({
    name: '【手上的事】',
    intents: PERSONA_ACT_INTENTS,
    lines: ['', `【${u}手上的事(工作台此刻的快照,可能已经变了)】`, callContextBlock(input.tasks)],
  })
  // 【你能做什么】那一行是**组的头**:底下一条说明都没带上时它自己也不出现(闲聊回合就是这样)。
  add({ name: '【你能做什么】', head: PERSONA_TOOLS_GROUP, lines: ['', '【你能做什么】'] })
  /*
   * ——— 事务官不自己干活(2026-09-28 定,2026-10-02 进人设)———
   *
   * Air 那一通的确认点里念的是「谁来执行,我按事务官自己办」—— 和 09-28 那条拍板相反。
   * 这一条与 base-086 上「desk 按能力选家」是同一条规矩,写在工具单子最前面。
   */
  add({
    name: '不自己动手干活',
    group: PERSONA_TOOLS_GROUP,
    intents: PERSONA_ACT_INTENTS,
    lines: [
      `- **你自己不动手干活**。要在电脑上做的事(查、改、打开、做出来)一律交给能做的那一家 Agent 去做;`
      + `${u}点了名就派给那一家,没点名你按本机各家的能力自己挑一家,**别问她「要不要我自己办」**。`,
    ],
  })
  // 2026-09-23 `fix/call-remember-direct`:「记」与「办」分成两件工具。12:39 那一通里一句
  // 「把这件事记下来」开了一条 DSH 会话,吃掉当天 67% 的额度。
  add({
    name: '记一笔',
    group: PERSONA_TOOLS_GROUP,
    tool: input.rememberTool,
    lines: [
      `- ${u}说「记下来」「记一下」「建个待办」「先记着」→ 调 ${input.rememberTool},标题只写那件事本身。`,
      '  **只是记,不派活**。它回来说记下了才说「记下了」。',
    ],
  })
  add({
    name: '去办一件新的事',
    group: PERSONA_TOOLS_GROUP,
    tool: CHANNEL_TOOL_DISPATCH,
    lines: [
      `- ${u}要人**去做**一件事(查一下、改一下、做出来、派给谁)→ 调 ${CHANNEL_TOOL_DISPATCH}:${u}点了名就把名字填进 to,没点名不填,`
      + '挑谁、那只手能不能用由电脑那头核。**只是记一下的事不要用它**。办成了就说**那件事**成了。',
      `  **听清了就直接调,别先问「对吗」、别复述${u}的话**:要不要先问由它回话说了算 ——`
      + `回「还没办。先照这句问她」才问那一句,${u}答了调 ${CHANNEL_TOOL_CONFIRM}。`,
    ],
  })
  add({
    name: '现在在办什么',
    group: PERSONA_TOOLS_GROUP,
    tool: input.doingTool,
    lines: [`- ${u}问「现在在办什么」「有什么等我确认」 → 调 ${input.doingTool} 现查一遍再答,别照上面那份快照背。`],
  })
  /*
   * ⚠️ 这一段里还点了 `doingTool` 的名字(「不知道 id 就先调它查」)。工具按意图下发那张表里
   * 带 `wb_hand_to_butler` 的组几乎都同时带 `wb_list_doing`,只有 `pick`(「来个 / 给我来」)那一组
   * 有前者没后者 —— 那一回合这一句会提到一件手上没有的工具。工人另有一行当场说清手上有哪几件
   * (`intentTools.ts` 的 `intentToolNote`),所以最坏是多一趟来回,不会说成办了。照实记在交接里。
   */
  add({
    name: '给在办的那件事补一句',
    group: PERSONA_TOOLS_GROUP,
    tool: input.handTool,
    lines: [
      `- ${u}要给板上**某张卡**再补一句交代 → 调 ${input.handTool},带上那张卡的 id 和${u}这句话。`,
      `  不知道是哪张就先调 ${input.doingTool} 查,查不到就问${u}是哪件,别猜。`,
    ],
  })
  add({
    name: '卡与目标的其余几件',
    group: PERSONA_TOOLS_GROUP,
    tool: CHANNEL_TOOL_REASSIGN,
    lines: [
      `- 同一张卡换人 → ${CHANNEL_TOOL_REASSIGN}(永不改名);${u}明说改名 → ${CHANNEL_TOOL_RENAME};取消 → ${CHANNEL_TOOL_CANCEL};挪状态 → ${CHANNEL_TOOL_MOVE_STATUS};`
      + `归到目标下 → ${CHANNEL_TOOL_SET_GOAL};目标标成达成 / 不要了 → ${CHANNEL_TOOL_GOAL_STATUS};建目标 → ${CHANNEL_TOOL_GOAL_CREATE};改截止 → ${CHANNEL_TOOL_GOAL_DUE};`
      + `改${u}自己那一格(用户层)→ ${CHANNEL_TOOL_USER_LAYER_FIX};工作台本身的毛病、又没点名让谁修 → ${CHANNEL_TOOL_FEEDBACK}。`,
      `  这几件都交给电脑那头办,它回什么照着说;要${u}点头的它会回一问,${u}答了调 ${CHANNEL_TOOL_CONFIRM}。`,
    ],
  })
  add({
    name: '换嗓子',
    group: PERSONA_TOOLS_GROUP,
    tool: CHANNEL_TOOL_VOICE,
    lines: [`- ${u}嫌你的声音不好听、要换嗓子 → 调 ${CHANNEL_TOOL_VOICE}:先不填 voice,拿回几个名字念给${u}挑,挑定了再调一次。`],
  })
  add({
    name: '以后都算数的规矩',
    group: PERSONA_TOOLS_GROUP,
    tool: CHANNEL_TOOL_PREFERENCE,
    lines: [
      `- ${u}说「以后都……」「每次……」「别再……」「不要……」这种**以后都算数**的话 → 调 ${CHANNEL_TOOL_PREFERENCE} 记进${u}的规矩表(派活、验收都照这张表做);`,
      '  **它回来说没写成,就照实说没记上** —— 不许说「记住了」,更不许说「我记在脑子里」。',
    ],
  })
  // ——— 2026-09-27(卡 MS):捎话那件工具 09-26 就在她手上,这份单子上一直没写它 ———
  add({
    name: '给某一家说句话',
    group: PERSONA_TOOLS_GROUP,
    tool: CHANNEL_TOOL_RELAY,
    lines: [
      `- ${u}要**给某一家说句话**(「给 Manus 发个信息问他…」「跟 Codex 那条说一句」「问问豆包…」)→ 调 ${CHANNEL_TOOL_RELAY}:`,
      `  who 填${u}点名那一句、text 填${u}要捎的**原话**。**这一档不建事项、不开会话、不列确认点** ——`
      + `一句话能说清的事直接办,别拿 ${CHANNEL_TOOL_DISPATCH} 去办它。名字听着不像本机哪一家(「minus」其实是 Manus)由工作台认,你不用问${u}。`,
    ],
  })
  add({
    name: '问事项或者你记得什么',
    group: PERSONA_TOOLS_GROUP,
    tool: CHANNEL_TOOL_ASK_BUTLER,
    lines: [
      `- ${u}问**事项**或者**你记得什么** → 调 ${CHANNEL_TOOL_ASK_BUTLER}:那是你在电脑上的那只手去翻一遍,`
      + '把翻到的用人话说出来(说「我查了」,不是「我问了事务官」);',
      '  你自己看不见记忆、手上那份事项快照也是旧的,**不许凭它编一个答案**。这一下要等几秒,是值得的。',
    ],
  })
  // 工具的成败怎么说:与手上具体哪一件无关,但闲聊回合(零工具)用不上。
  add({
    name: '工具没办成怎么说',
    group: PERSONA_TOOLS_GROUP,
    intents: PERSONA_ACT_INTENTS,
    lines: [
      '- 工具回来说没办成,就如实说没办成,别含糊过去。',
      `- 工具回来说**没有这项授权**,就照实把「要在哪个文件、哪一行改成什么」说给${u}听,别说「我记下了」。`,
    ],
  })
  /*
   * ——— 耳朵:听不准只问一次(2026-10-02)———
   *
   * Air 那一通里「Codex」被听成 to death / 泄露 / Cold death,来回**五轮**:
   * 「没听清,你说的是哪个额度?」「两个名字都撞上了,我听不准……」。
   * 识别那一头另配了热词表(工作台下发 → asr/volcProtocol.ts 的 corpus.hotwords);
   * 这一条管的是热词也没救回来的那一次。
   *
   * 标**全部要办事的意图**(不按单个意图分):她报一个家名、账号名、小组件名
   * 可能出现在任何一类事里,分不开(2026-10-03,与 intentTools.ts「宁可宽」同一条)。
   */
  add({
    name: '【听不准的时候】',
    intents: PERSONA_ACT_INTENTS,
    lines: [
      '',
      '【听不准的时候】',
      `- 本机各家 Agent 的名字(Codex、Claude、豆包、Manus…)、${u}的账号名、小组件名都已经喂给识别了,`
      + '听着像的就按那个认,**不要为一个名字反复问**。',
      '- 实在不确定就**只问一次**,而且是**问一个**:「你是说 Codex 吗?」——'
      + '不要摆两个候选让她挑、不要说「两个名字都撞上了」、不要连着问第二遍。',
      '- 问过一次还是不确定,就按最像的那个办,顺口说一句「我按 Codex 办了,不对你说一声」。',
    ],
  })
  add({
    name: '【文件】',
    intents: PERSONA_ACT_INTENTS,
    lines: [
      '',
      '【文件】',
      input.inboxName === undefined
        ? `- ${u}从手机发过来的文件会自动落到电脑上的收件目录,你只要口头确认收到了几个文件、叫什么。`
        : `- ${u}从手机发过来的文件会自动落到电脑上的「${input.inboxName}」,你只要口头确认收到了几个文件、叫什么。`,
      `- 你自己不会挑文件发给${u} —— 要发文件是${u}在电脑上点的,不是你决定的。`,
    ],
  })
  return sections
}

/** 接上之后她的第一句。短 —— 第一句长了,人只会想快点插话。 */
export function buildChannelWelcome(butlerName: string | undefined): string {
  return butlerName === undefined ? '喂,我在,你说。' : `喂,我是${butlerName},你说。`
}

// ———————————————————————— 接线 ————————————————————————

/** `POST /channel/token` 的回包。`route` 是 2026-10-21 加的一格(老消费方不认也不碍事)。 */
export interface ChannelTicketView {
  url: string
  room: string
  identity: string
  token: string
  expires_at: number
  route: ChannelRoute
}

/**
 * `GET /channel/route` 的回包(2026-10-21,设计稿第二节;连接规格判据 ② ③ 用它)。**没有任何密钥**。
 * 说不出的格一律缺席,不编:
 */
export interface ChannelRouteView {
  /** 这台 Mac 的机器 id(server/machineId.ts)。设备拿它比「是不是我配对过的那台」。取不到就缺席。 */
  mac_id?: string
  /** 本机房间名。本机没有 LiveKit 钥匙时缺席。 */
  room?: string
  /** 给**这一位**(按来路)的本机房间地址。本机没有钥匙时缺席。 */
  lan_url?: string
  /** `lan_url` 是哪一档({@link channelModeOf})。随 `lan_url` 一起缺席。 */
  mode?: ChannelMode
  /** 这台 Mac 此刻的局域网地址(IPv4,en0 优先)。手机拿来更新候选地址表。 */
  lan_addresses: readonly string[]
  /** 这台接了中转、中转说云房间配好了(上一次取到的那份;没取过算 false)。没接中转(零服务器)时整格缺席。 */
  relay?: { configured: boolean }
}

/** 只要看板的「读」那一面 —— 人设拼装拿不到写看板的能力。 */
export interface ChannelTasksPort {
  list: () => Promise<TasksState>
}

export interface ChannelService {
  /**
   * 配置齐了没有 + 地址房间名 + 本机还是远程(**没有 secret**)。
   * 异步是因为 `url` 也可能只写在 channel.json 里(Ben 从阿里云那台拷过来的那份就是),
   * 只看环境变量会把「已经配好了远程」报成「没配」。
   */
  view: () => Promise<ChannelConfigView>
  /**
   * 签一张进房凭证。没配置就返回 undefined,路由据此回 503。
   * `caller` = 这条请求从哪儿来(2026-10-21):地址与路线按它定({@link channelPlanOf});不传 = 老行为。
   */
  issue: (
    input: { deviceId?: string, kind?: 'phone' | 'handset', suffix?: string, name?: string, worker?: boolean },
    caller?: ChannelCaller,
  ) => Promise<ChannelTicketView | undefined>
  /** 服务器在不在、工人在不在房。任何一步探不到都如实写进 note,不猜。`caller` 同 issue。 */
  status: (caller?: ChannelCaller) => Promise<ChannelStatus>
  /**
   * `GET /channel/route` 那张小表(2026-10-21):设备用它认「答话的是不是我配对过的那台、在哪、哪间房」。
   * **不签票、不问中转、不探房**,1 秒内答得出。
   */
  route: (caller?: ChannelCaller) => Promise<ChannelRouteView>
  /**
   * 哪几条路线此刻要一条工人(2026-10-22,卡 M6;{@link workerRoutesOf})。8791 看管工人的那根 30 秒节拍问它。
   * `force` = 不认记着的「还没登录」,当场再问中转({@link CHANNEL_WORKER_RELAY_RECHECK_MS})。
   */
  workerRoutes: (options?: { force?: boolean }) => Promise<ChannelWorkerRoutes>
  /** 工人要的人设 + 此刻事项摘要。 */
  persona: () => Promise<ChannelPersona>
  /**
   * 工人要的那一份第三方凭据(火山识别/合成),**只给本机**(2026-09-21)。
   *
   * 为什么工人不自己去问中转:工人手上没有设备令牌,也不该有 ——
   * 它连 `~/.dsh` 都够不到(文件头那条老规矩)。8791 是它唯一的信息来源,
   * 这一条只是把那条规矩延伸到凭据上。
   */
  credentials: () => Promise<ChannelWorkerCredentials>
}

export interface ChannelServiceDeps {
  /** ~/.dsh/AGENTS.md。只读,一个字都不改。 */
  agentsFile: string
  tasks?: ChannelTasksPort
  /** 配置文件位置。读不到就只看环境变量。 */
  configFile?: string
  env?: Record<string, string | undefined>
  /** 收件目录的显示名(进人设那一句)。 */
  inboxName?: string
  readFileImpl?: (file: string) => Promise<string>
  fetchImpl?: typeof fetch
  nowSeconds?: () => number
  /** 探测 livekit-server 的超时(毫秒),缺省 3000。测试里调小。 */
  probeTimeoutMs?: number
  /** 前两件工具的名字由 rtcCall.ts 那边给(同一张卡同一个名字),这里只作参数。 */
  rememberTool: string
  doingTool: string
  /**
   * 向中转要通道凭据的那一层(2026-09-21,server/channelCredentials.ts)。
   * 不传 = 只认本机那一份(测试与"这台机器不连服务器"都走这条)。
   *
   * **本机那一份优先**:一台起着 livekit-server --dev 的开发机不该因为登录了
   * 就把连接改到公网那台去 —— 那会让"我在本机调的那个房间"突然人去楼空。
   */
  remote?: ChannelCredentialStore
  /**
   * 她自己填的识别钥匙(设置 › 各家的登录与密钥,`credentials.json`;2026-10-21 零服务器档)。**有就先用它**,不往中转要;
   * 缺席 / 回空 = 没填。只交给回环上的工人(`/channel/credentials`),不进 `/state`、不进日志。
   */
  localKeys?: () => Promise<Pick<ChannelWorkerCredentials, 'volc_asr'>>
  /** 他的规矩那一段(卡 K,server/rules.ts 的 `callRulesBlock`),**每通电话现取**。缺席 = 人设里没有这一段。 */
  rulesBlock?: () => string | undefined
  /**
   * 「她要跟你聊的那一条资讯」那一段(2026-10-13,卡「播客页重做」;`server/feedDig.ts`)。
   * 她在资讯页上点「打电话聊」才有,**取一次就清**(只管接下来那一通)。
   * 缺席 / 回 undefined = 人设里没有这一段,与加它之前逐字相同。
   */
  digBlock?: () => string | undefined
  /** 每轮最多几句(卡 K,server/rules.ts 的 `sayLimitOf`)。缺席 = 不掐。 */
  sayLimit?: () => number | undefined
  /**
   * 再往热词表里加几个(2026-10-02):**她的账号名、小组件名**那一类 ——
   * 它们在别的服务手上(账号表、小组件登记表),这个文件够不到。
   * 缺席 = 只有 {@link channelHotwords} 自己算得出来的那几样。**绝不抛**是实现方的责任;
   * 这里仍然兜一层(取不到热词不该把一通电话带走)。
   */
  extraHotwords?: () => readonly string[]
  /**
   * 这台 Mac 的机器 id(2026-10-21,server/machineId.ts 的 `readOrCreateMachineId`)。
   * 本机房间名 `wb-local-<前 8 位>` 与 `/channel/route` 的 `mac_id` 都从它来。
   * 不传 / 抛 / 回的不像个 id = 没有:房间名退回 `workbench`,`mac_id` 缺席。取到一次就记住。
   */
  machineId?: () => Promise<string | undefined>
  /** 这台 Mac 此刻的局域网地址(`lan.ts` 的 `lanAddresses`)。不传 = 一个都说不出。**每次现取**(换了 Wi-Fi 就变)。 */
  lanAddresses?: () => readonly string[]
}

export function createChannelService(deps: ChannelServiceDeps): ChannelService {
  const read = deps.readFileImpl ?? ((file: string) => readFile(file, 'utf8'))
  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const env = deps.env ?? process.env
  const configFile = deps.configFile ?? defaultChannelConfigFile()
  const probeTimeoutMs = deps.probeTimeoutMs ?? 3000

  /** 机器 id 取到一次就记住(它装时定、以后不变);取不到下次再试。 */
  let machineIdKnown: string | undefined
  async function machineId(): Promise<string | undefined> {
    if (machineIdKnown !== undefined || deps.machineId === undefined) return machineIdKnown
    try {
      const id = await deps.machineId()
      if (typeof id === 'string' && MACHINE_ID_PATTERN.test(id)) machineIdKnown = id
    }
    catch { /* 落不了盘:这一次没有机器 id,房间名退回老缺省 */ }
    return machineIdKnown
  }

  function lanAddresses(): readonly string[] {
    try { return deps.lanAddresses?.() ?? [] }
    catch { return [] }
  }

  /** 每次现读:Ben 在配置文件里改了地址,不用重启工作台。读不到就只认环境变量。 */
  async function config(): Promise<ChannelConfig | undefined> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await read(configFile)) as unknown
    }
    catch {
      // 没有这个文件、或者是坏 JSON:都退回「只看环境变量」。坏文件不该把整条路由带走。
      parsed = undefined
    }
    const id = await machineId()
    return channelConfigOf(env, parsed, id === undefined ? {} : { localRoom: localRoomOf(id) })
  }

  /**
   * 这台接没接中转。没接(零服务器档)时签票计划里没有中转那条路、`/channel/route` 不带 `relay`。
   * 老的假 store(用例)没有这一问 → 按接了算,与加它之前一样。
   */
  async function relayIsOn(): Promise<boolean> {
    if (deps.remote === undefined) return false
    try { return await deps.remote.relayConfigured?.() ?? true }
    catch { return true }
  }

  /** 这一位的签票计划(issue 与 status 共用)。 */
  function planFor(resolved: ChannelConfig | undefined, caller: ChannelCaller | undefined, relay: boolean): ChannelPlan | undefined {
    return channelPlanOf({
      ...(caller === undefined ? {} : { caller }),
      ...(resolved === undefined ? {} : { localUrl: resolved.url }),
      relay,
      lanAddresses: lanAddresses(),
    })
  }

  async function agentsText(): Promise<string | undefined> {
    try { return await read(deps.agentsFile) }
    catch { return undefined }
  }

  async function board(): Promise<TasksState | undefined> {
    if (deps.tasks === undefined) return undefined
    try { return await deps.tasks.list() }
    catch { return undefined }
  }

  /**
   * 服务器下发的那一份(只在本机没配 key/secret 时才问)。**永不抛**:
   * 取不到只是「这会儿通道用不了」,不该把 /channel/status 整条路由带走。
   */
  async function remote(options?: { force?: boolean }): Promise<
    { ok: true, credentials: RemoteChannelCredentials } | { ok: false, reason: string, error: string } | undefined
  > {
    if (deps.remote === undefined) return undefined
    try { return await deps.remote.get(options) }
    catch { return { ok: false, reason: 'server', error: '取通道凭据时出了意外,这会儿通道用不了。' } }
  }

  /** 工人看管那一拍上一次问到的「还没登录」(只记这一种,见 {@link CHANNEL_WORKER_RELAY_RECHECK_MS})。 */
  let relayMiss: { at: number, result: NonNullable<Awaited<ReturnType<typeof remote>>> } | undefined

  /** 服务器那一份能不能用来进房(地址齐、房间名齐)。 */
  function remoteReady(credentials: RemoteChannelCredentials): credentials is RemoteChannelCredentials & {
    livekit: { configured: true, url: string, room: string }
  } {
    return credentials.livekit.configured && credentials.livekit.url !== undefined
      && credentials.livekit.room !== undefined
  }

  /**
   * 两条来源都没有时那句话。**「还没登录」与「服务器上没配」要分开说** ——
   * 前者是用户自己能解决的一步,后者是我们的事。把两者混成一句「通道没配」,
   * 新用户只会以为是自己漏了什么。
   */
  function unavailable(result: Awaited<ReturnType<typeof remote>>): { note: string, needsLogin: boolean } {
    if (deps.remote === undefined) {
      return { note: '没配 LiveKit 的 api key / secret', needsLogin: false }
    }
    if (result === undefined || result.ok) {
      return { note: '服务器上还没配 LiveKit,这台机器暂时通不了话。', needsLogin: false }
    }
    if (result.reason === 'no_relay') return { note: CHANNEL_NO_RELAY_NOTE, needsLogin: false }
    if (result.reason === 'not_linked' || result.reason === 'unauthorized') {
      return { note: `通道密钥由服务器在登录后下发。${result.error}`, needsLogin: true }
    }
    return { note: result.error, needsLogin: false }
  }

  return {
    async view() {
      const resolved = await config()
      if (resolved !== undefined) {
        return {
          url: resolved.url,
          room: resolved.room,
          configured: true,
          mode: channelModeOf(resolved.url),
          source: 'local',
        }
      }
      const fromServer = await remote()
      if (fromServer?.ok === true && remoteReady(fromServer.credentials)) {
        const url = fromServer.credentials.livekit.url
        return {
          url,
          room: fromServer.credentials.livekit.room,
          configured: true,
          mode: channelModeOf(url),
          source: 'server',
        }
      }
      return {
        url: CHANNEL_DEFAULT_URL,
        room: CHANNEL_DEFAULT_ROOM,
        configured: false,
        mode: channelModeOf(CHANNEL_DEFAULT_URL),
        source: 'none',
      }
    },

    async credentials() {
      // 她自己填的识别钥匙先用(零服务器档就靠它;接了中转的机器填了也一样,不往中转要)。
      let own: Pick<ChannelWorkerCredentials, 'volc_asr'> = {}
      try { own = await deps.localKeys?.() ?? {} }
      catch { own = {} }
      if (own.volc_asr !== undefined) return { source: 'local', volc_asr: own.volc_asr }
      const fromServer = await remote()
      if (fromServer === undefined) {
        return { source: 'none', note: '这台机器没接服务器下发,通道凭据只能来自本机配置。' }
      }
      if (!fromServer.ok && fromServer.reason === 'no_relay') return { source: 'none', note: CHANNEL_NO_RELAY_ASR_NOTE }
      if (!fromServer.ok) {
        return {
          source: 'none',
          note: fromServer.reason === 'not_linked'
            ? `通道密钥由服务器在登录后下发。${fromServer.error}`
            : fromServer.error,
        }
      }
      const { volc_asr: asr, volc_tts: tts, expires_at: expiresAt, notes } = fromServer.credentials
      return {
        source: 'server',
        ...(asr === undefined ? {} : { volc_asr: asr }),
        ...(tts === undefined ? {} : { volc_tts: tts }),
        ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
        // 服务器说缺什么就原样带上一句(例如「还没配火山识别」),工人据此在日志里说人话。
        ...(asr === undefined && notes !== undefined && notes.length > 0 ? { note: notes.join(' ') } : {}),
      }
    },

    async issue(input, caller) {
      const resolved = await config()
      const identity = channelIdentityOf(input)
      /**
       * 签进凭证的那几项属性。两条签发路径(本机签 / 中转签)**共用这一份** ——
       * 两处各拼一遍,迟早会有一条路上的手机少一项属性,而那种错只在远程模式下才现形。
       *
       * 工人自己那张不带任何属性:它不是一台设备,也不该被降权成谁。
       *
       * 2026-09-21 合并说明(merge/sprint-2):凭证里有**两个 kind,语义不同、不能合成一个**——
       *   · 属性 `wb_kind`(这里):`phone | handset`,答的是**这一通的声音跟谁走**
       *     (channel-worker/src/rpc.ts 的 participantKindOf / pickSpeaker 读它);
       *   · metadata 里的 `kind`(下面 channelDeviceMetadata 拼的):`mac | phone`,答的是
       *     **设备目录里这是哪一类设备**(channel-worker/src/files/devices.ts 读它)。
       * 一台树莓派话筒在这行 metadata 里仍然是 `phone`(设备目录那一类只分电脑/手机);
       * 2026-09-23 起 `GET /devices/online` 那一头不再信这一项,而是拿 device_id 去
       * 配对记录里查真种类(server/deviceDirectory.ts 的 withPairedKinds)——
       * 所以这里维持原样,不必为了话筒动 metadata 的格式。
       */
      const attributesOf = (): Record<string, string> | undefined => {
        if (input.worker === true || input.deviceId === undefined || input.deviceId === '') return undefined
        return {
          [CHANNEL_DEVICE_ATTRIBUTE]: input.deviceId,
          // 缺省 phone:老调用方没传 kind 时,行为与 2026-09-21 之前逐字相同。
          [CHANNEL_KIND_ATTRIBUTE]: input.kind ?? 'phone',
        }
      }
      /**
       * 让中转替我们签(2026-09-21;2026-10-21 起只在「本机没钥匙」或「外网来的 / 云房间里的」时走)。
       * 身份与设备属性仍然由**这里**拼(channelIdentityOf 那条老规矩:调用方说了不算),
       * 中转只管"这张设备令牌只签得出它自己那一间房"。
       */
      const viaRelay = async (): Promise<ChannelTicketView | undefined> => {
        if (deps.remote === undefined) return undefined
        const attributes = attributesOf()
        const metadata = channelDeviceMetadata({ identity, ...input })
        const ticket = await deps.remote.issueToken({
          identity,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(attributes === undefined ? {} : { attributes }),
          ...(metadata === undefined ? {} : { metadata }),
        }).catch(() => ({ ok: false as const, reason: 'server' as const, error: '签不出进房凭证。' }))
        return ticket.ok ? { ...ticket.ticket, route: 'relay' } : undefined
      }
      /** 本机签。`url` 是按来路改写过的那个(channelPlanOf),房间与有效期照配置。 */
      const signLocal = (local: ChannelConfig, url: string): ChannelTicketView => {
        const nowSec = now()
        /**
         * 设备 id 原样签进属性(**不做 identity 那种字符清洗**):identity 要进房间列表、得干净,
         * 属性只在两端之间传,工人拿它去 8791 查设备,清洗过反而对不上。
         */
        const attributes = attributesOf()
        const localMetadata = channelDeviceMetadata({ identity, ...input })
        return {
          url,
          room: local.room,
          identity,
          token: signAccessToken({
            apiKey: local.apiKey,
            apiSecret: local.apiSecret,
            identity,
            grant: joinGrant(local.room),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(attributes === undefined ? {} : { attributes }),
            // 设备目录认的那一行(2026-09-21)。签在凭证里,持证人改不了。
            ...(localMetadata === undefined ? {} : { metadata: localMetadata }),
            ttlSeconds: local.tokenTtlSeconds,
            nowSeconds: nowSec,
          }),
          expires_at: nowSec + local.tokenTtlSeconds,
          route: 'lan',
        }
      }
      const plan = planFor(resolved, caller, await relayIsOn())
      if (plan === undefined) return undefined
      if (plan.route === 'lan') return resolved === undefined ? undefined : signLocal(resolved, plan.url)
      const relayed = await viaRelay()
      if (relayed !== undefined) return relayed
      // 外网来的、中转签不出:退回本机那一张(设备连得上 8791 的那个地址,就连得上 7880)。
      return plan.fallback === undefined || resolved === undefined ? undefined : signLocal(resolved, plan.fallback.url)
    },

    async status(caller) {
      const resolved = await config()

      /**
       * 探一眼房里有谁,要三样:HTTP 面的地址、房间名、一张 roomAdmin 的凭证。
       * 本机有 secret 时自己签;没有时向中转要一张 60 秒的(`kind: 'admin'`)——
       * **探测这件事不值得把 secret 发到客户端来**。
       *
       * 报给这一位的 `url` / `room` / `route` 与它这时候签票会拿到的那张同一条规矩({@link channelPlanOf});
       * **探房**照旧从这台 Mac 自己去探(本机房间走配置里的 HTTP 面,也就是回环),不按来路改。
       */
      let probe: {
        base: Omit<ChannelStatus, 'server' | 'worker'>
        httpUrl: string
        room: string
        token: string
        /** 探的是这台 Mac 自己的 livekit-server(连不上时那句话按它分)。 */
        local: boolean
      } | undefined

      const localProbe = (local: ChannelConfig, url: string): NonNullable<typeof probe> => ({
        base: {
          configured: true,
          url,
          room: local.room,
          mode: channelModeOf(url),
          token_ttl_seconds: local.tokenTtlSeconds,
          source: 'local',
          route: 'lan',
        },
        httpUrl: local.httpUrl,
        room: local.room,
        token: signAccessToken({
          apiKey: local.apiKey,
          apiSecret: local.apiSecret,
          identity: 'wb-status',
          grant: adminGrant(local.room),
          ttlSeconds: 60,
          nowSeconds: now(),
        }),
        local: channelModeOf(local.url) === 'local',
      })

      const plan = planFor(resolved, caller, await relayIsOn())
      if (plan?.route === 'lan' && resolved !== undefined) {
        probe = localProbe(resolved, plan.url)
      }
      else {
        const fromServer = await remote()
        if (plan?.route === 'relay' && fromServer?.ok === true && remoteReady(fromServer.credentials)) {
          const { url, room, token_ttl_seconds: ttl } = fromServer.credentials.livekit
          const base: Omit<ChannelStatus, 'server' | 'worker'> = {
            configured: true,
            url,
            room,
            mode: channelModeOf(url),
            source: 'server',
            route: 'relay',
            ...(ttl === undefined ? {} : { token_ttl_seconds: ttl }),
          }
          const admin = await (deps.remote as ChannelCredentialStore)
            .issueToken({ identity: 'wb-status', kind: 'admin' })
            .catch(() => ({ ok: false as const, reason: 'server' as const, error: '签不出查房凭证。' }))
          if (!admin.ok) {
            // 凭据取得到、查房凭证签不出:说得出是哪一步,别混成「连不上」。
            return { ...base, server: false, worker: false, note: admin.error }
          }
          probe = { base, httpUrl: httpUrlOf(url), room, token: admin.ticket.token, local: false }
        }
        else if (plan?.route === 'relay' && plan.fallback !== undefined && resolved !== undefined) {
          // 外网来的、中转这会儿取不到:与签票同一条退路,报本机那一间。
          probe = localProbe(resolved, plan.fallback.url)
        }
        else {
          const { note, needsLogin } = unavailable(fromServer)
          return {
            configured: false,
            server: false,
            worker: false,
            source: 'none',
            note,
            ...(needsLogin ? { needs_login: true } : {}),
          }
        }
      }

      const { base } = probe
      let res: Response
      try {
        res = await doFetch(`${probe.httpUrl}/twirp/livekit.RoomService/ListParticipants`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${probe.token}` },
          body: JSON.stringify({ room: probe.room }),
          // 远程那台在外网,断网/机器关了会一直挂着。3 秒够本机和一次跨城往返,超了就当探不到。
          signal: AbortSignal.timeout(probeTimeoutMs),
        })
      }
      catch {
        // 连不上 = 服务器没起(或地址写错、或这会儿没网)。给一句能照着做的话,按本机/远程分开说。
        return {
          ...base,
          server: false,
          worker: false,
          note: probe.local
            ? 'livekit-server 连不上:先在本机把 livekit-server 起起来'
            : `连不上 ${base.url}:碰头点那台机器没起、地址写错,或者这会儿没网`,
        }
      }
      if (!res.ok) {
        return {
          ...base,
          server: true,
          worker: false,
          note: base.source === 'server'
            // 服务器下发的那条路上,「凭证不对」不是他能改的事 —— 别让他去找一把他没有的 key。
            ? `livekit-server 回了 ${res.status}:服务器上那对 LiveKit 凭证多半不对,这一条要我们去查`
            : `livekit-server 回了 ${res.status}:多半是 api key / secret 不对`,
        }
      }
      let body: unknown
      try { body = await res.json() }
      catch { return { ...base, server: true, worker: false, note: 'livekit-server 的回包读不懂' } }
      const participants = participantIdentitiesOf(body)
      /**
       * 「工人在不在房」**按前缀比**(2026-09-21):第二台电脑上的工人身份是
       * `wb-channel-worker-<后缀>`,按全等比会把它报成「没有工人」。
       */
      const worker = participants.some(identity => identity.startsWith(CHANNEL_WORKER_IDENTITY))
      return { ...base, server: true, worker, participants }
    },

    async workerRoutes(options) {
      const resolved = await config()
      let relay: Awaited<ReturnType<typeof remote>>
      if (deps.remote !== undefined) {
        const nowMs = now() * 1000
        if (options?.force !== true && relayMiss !== undefined && nowMs - relayMiss.at < CHANNEL_WORKER_RELAY_RECHECK_MS) {
          relay = relayMiss.result
        }
        else {
          relay = await remote()
          relayMiss = relay !== undefined && !relay.ok && (relay.reason === 'not_linked' || relay.reason === 'unauthorized')
            ? { at: nowMs, result: relay }
            : undefined
        }
      }
      return workerRoutesOf({
        ...(resolved === undefined ? {} : { local: { url: resolved.url, room: resolved.room } }),
        ...(relay === undefined ? {} : { relay }),
      })
    },

    async route(caller) {
      const [id, resolved] = await Promise.all([machineId(), config()])
      const addresses = lanAddresses()
      /**
       * 这里只问「本机房间给这一位什么地址」,所以计划里**不算中转**(relay: false):外网来的也照样给本机那个地址
       * —— 判在不在家是设备的事(连接规格),这张表只如实说「我是谁、在哪、哪间房」。
       */
      const { want: _ignored, ...asked } = caller ?? {}
      const plan = resolved === undefined
        ? undefined
        : channelPlanOf({
          ...(caller === undefined ? {} : { caller: asked }),
          localUrl: resolved.url,
          relay: false,
          lanAddresses: addresses,
        })
      const lanUrl = plan?.route === 'lan' ? plan.url : undefined
      let relayConfigured: boolean | undefined
      if (await relayIsOn() && deps.remote !== undefined) {
        try { relayConfigured = deps.remote.view().livekit_configured === true }
        catch { relayConfigured = false }
      }
      return {
        ...(id === undefined ? {} : { mac_id: id }),
        ...(resolved === undefined ? {} : { room: resolved.room }),
        ...(lanUrl === undefined ? {} : { lan_url: lanUrl, mode: channelModeOf(lanUrl) }),
        lan_addresses: addresses,
        ...(relayConfigured === undefined ? {} : { relay: { configured: relayConfigured } }),
      }
    },

    async persona() {
      const [agents, tasks] = await Promise.all([agentsText(), board()])
      const butlerName = butlerNameOf(agents)
      // 规矩那一段(卡 K)。取不到不连累人设:少一段,不是整通电话起不来。
      let rulesText: string | undefined
      try { rulesText = deps.rulesBlock?.() } catch { rulesText = undefined }
      /*
       * 她要聊的那一条资讯(2026-10-13)。与规矩那一段同一条分寸:**取不到不连累人设**
       * —— 少一段是「这一通不知道她要聊哪条」,不是整通电话起不来。
       */
      let digText: string | undefined
      try { digText = deps.digBlock?.() } catch { digText = undefined }
      let maxSentences: number | undefined
      try { maxSentences = deps.sayLimit?.() } catch { maxSentences = undefined }
      /*
       * 识别热词(2026-10-02)。**算不出来不连累人设**:少一格热词是「耳朵回到以前那样」,
       * 不是整通电话起不来 —— 和上面规矩那一段同一条分寸。
       */
      let hotwords: readonly string[] = []
      try {
        let extra: readonly string[] = []
        try { extra = deps.extraHotwords?.() ?? [] } catch { extra = [] }
        hotwords = channelHotwords({
          ...(agents === undefined ? {} : { agentsText: agents }),
          ...(tasks === undefined ? {} : { tasks }),
          ...(butlerName === undefined ? {} : { butlerName }),
          extra,
        })
      }
      catch { hotwords = [] }
      /**
       * 人设拼一次就够(2026-10-03):整段与分段**同一份输入**算出来,
       * 所以「拼起来逐字就是 system_message」在真下发的这一份上也成立,不只在用例里。
       */
      const personaInput: ChannelPersonaInput = {
        ...(agents === undefined ? {} : { agentsText: agents }),
        ...(tasks === undefined ? {} : { tasks }),
        ...(deps.inboxName === undefined ? {} : { inboxName: deps.inboxName }),
        rememberTool: deps.rememberTool,
        doingTool: deps.doingTool,
        handTool: CHANNEL_TOOL_HAND,
        ...(rulesText === undefined ? {} : { rulesBlock: rulesText }),
        ...(digText === undefined ? {} : { digBlock: digText }),
      }
      const personaSections = channelPersonaSections(personaInput)
      return {
        system_message: personaSections.map(one => one.text).join('\n'),
        persona_sections: personaSections,
        welcome: buildChannelWelcome(butlerName),
        ...(butlerName === undefined ? {} : { butler_name: butlerName }),
        /**
         * 称呼表(2026-09-23)。**没写过就整格缺席** —— 工人那边有缺省(「老板」「Ben」),
         * 在这儿也编一份的话,两处缺省迟早对不上。
         */
        ...(callAddressesOf(agents).length === 0 ? {} : { addresses: callAddressesOf(agents) }),
        /**
         * 说话方式单独再给一份(2026-09-18,引导改通话模式)。引导时工人要自己拼系统提示 ——
         * 上面那一整段里有「他手上的事」,引导还没开始时那是空的,但**语气得照旧**。
         * 没写过人设(引导还没做到 ④′)就是那句缺省。
         */
        style: speakingStyleOf(agents) ?? DEFAULT_STYLE,
        ...(maxSentences === undefined ? {} : { max_sentences: maxSentences }),
        ...(hotwords.length === 0 ? {} : { hotwords }),
      }
    },
  }
}
