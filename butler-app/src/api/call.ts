/**
 * 通话模式要打的几条接口(2026-09-17)。两类地址:
 *
 *   经代理去本机后端(密钥与火山 OpenAPI 都在那边):
 *     GET  /butler/proxy/api/rtc/status   配了通话供应商没有
 *     POST /butler/proxy/api/rtc/token    进房 token(AppKey 只在服务端)
 *     POST /butler/proxy/api/rtc/start    智能体进房。**人设由工作台在代理层注入**,手机不传
 *     POST /butler/proxy/api/rtc/stop     挂断
 *   直接打工作台(它才认识事项):
 *     POST /butler/call/record            挂断后的那一通 → 一份通话记录(2026-10-22 起不建卡)
 *
 * 503(没配)→ kind=unavailable,界面把通话入口灰掉并说「电脑上还没配通话供应商」,不弹错误栈。
 */
import type { ApiClient, ApiResult } from './client';
import type { CallUtterance } from '../call/callModel';

const PROXY = '/butler/proxy/api';

export interface RtcToken {
  appId: string;
  roomId: string;
  userId: string;
  token: string;
}

export interface RtcStarted {
  taskId: string;
  botUserId: string;
}

export interface RtcStatus {
  /** 本机后端真的说了「配了」。 */
  configured: boolean;
  /**
   * 这一次到底问到答案没有。**「没问到」与「问到了,没配」是两件事**:
   * 前者是掉线(过会儿还能打),后者要 Ben 去 Mac 上配密钥。界面上说的话不一样。
   */
  checked: boolean;
  reason?: string;
  /**
   * **电脑此刻在哪一间房**(2026-09-27,卡 RM ③)。只有 LiveKit 那条路
   * (`/channel/status`)说得出;火山那条与老工作台一律缺席。调用方拿它跟手上那张
   * 进房凭证比一比,不一样就丢掉旧的重取(见 `channelRoomMoved`)。
   */
  room?: string;
}

export interface CallApi {
  /** 火山那条链路配没配。拿不到(掉线 / 没接本机后端)也回 configured:false,但 reason 说的是拿不到,不是没配。 */
  status(): Promise<RtcStatus>;
  /**
   * LiveKit 那条链路通不通(2026-09-17):`GET /channel/status`。
   * 三件事都齐了才算能打——**配了 key/secret**、**livekit-server 应答**、**工人在房里**。
   * 缺哪一样就说哪一样:Ben 要照着这句话知道去 Mac 上做什么,笼统说一句「打不了」等于没说。
   */
  channelStatus(): Promise<RtcStatus>;
  token(): Promise<ApiResult<RtcToken>>;
  /** avatarId 决定音色绑定;systemMessage / welcomeMessage 一律由工作台注入,这里不传。 */
  start(input: { roomId: string, userId: string, avatarId?: string }): Promise<ApiResult<RtcStarted>>;
  stop(input: { roomId: string, taskId: string }): Promise<ApiResult<{ durationSeconds?: number }>>;
  /** 通话纪要。失败不重试:那只是一条记录,不该拦住挂断。 */
  /**
   * 挂断后的纪要。`kind:'onboarding'`(2026-09-25)= 引导那一通:工作台按引导存档拼一句摘要落「引导通话(n 分)」,
   * **不收字幕**(调用方也不带)—— 手机首页「最近一次通话」要算上它。
   */
  /**
   * `callId`(2026-10-22):这一通的编号 —— 来电那一通是台账上的 id,他拨出去的那一通是拨号时手机编的、
   * 也交给了工人的那个(`channel.callStart(callId)`)。工作台按它把手机与工人报的并成一份,记录也挂得上台账。
   */
  record(input: { callId?: string, durationSeconds?: number, transcript: readonly CallUtterance[], kind?: 'onboarding' }): Promise<ApiResult<{ id?: string }>>;
}

/** `GET /channel/status` 的回包(workbench-plugin/src/server/channel.ts 的 ChannelStatus)。 */
export interface ChannelStatusBody {
  configured?: unknown;
  server?: unknown;
  worker?: unknown;
  note?: unknown;
  /**
   * **电脑此刻在哪一间房**(2026-09-27,卡 RM ③)。房间名由账号算(中转那边),
   * 而它会变 —— 电脑登录之后把自己挂到账号下,房间就从「名字那一间」换成「账号那一间」。
   * 手上那张进房凭证是 7 天级的,不比对就会一直守着旧房间:电话打不进来、座机提机没人接。
   * 老工作台不回这一项就缺席 —— 那时什么都不做,照旧靠「房里没有电脑」那条反应式的路。
   */
  room?: unknown;
}

/**
 * 「手上那张凭证跟电脑不在同一间房」(2026-09-27,卡 RM ③)。**两样都拿得到才判** ——
 * 缺一样就回 false:凭空判一次「搬房」会把一台好好的连接踢掉重连。
 */
export function channelRoomMoved(statusRoom: unknown, heldRoom: string | undefined): boolean {
  const said = typeof statusRoom === 'string' && statusRoom.trim() !== '' ? statusRoom.trim() : undefined;
  if (said === undefined || heldRoom === undefined || heldRoom === '') return false;
  return said !== heldRoom;
}

/**
 * **这一问之后要不要去核对一次房间**(2026-09-28,卡 PH)。
 *
 * 卡 RM ③ 只做了一半:「问到了房间名、跟手上那张不一样」才去搬。可**问 status 走的正是
 * 旧房间里的代理** —— 电脑搬进账号房间之后,旧房间里没人应,于是这一问永远失败、
 * 房间名永远问不到、手机也就永远搬不过去。09-28 真机上小米就卡在这儿
 * (Air 带账号重领令牌搬了家,小米一次都没向中转领过进房凭证)。
 *
 * 所以两种情况都去核对(`recheckRoom` 会**中转优先**地重取一张,拿到的房间不同就连着搬过去):
 *   - 问到了、房间不一样 → 明确搬家;
 *   - **压根没问到**(`checked: false`)→ 可能正是「电脑已经不在这间房了」。
 * 核对本身很轻(一张凭证),而且拿到同一间房时它什么都不做,所以这一下是安全的。
 * 问到了、房间一样 → 什么都不做(电脑就在这间房,只是这会儿没配好 / 工人没跑)。
 */
export function channelShouldRecheckRoom(status: Pick<RtcStatus, 'checked' | 'room'>, heldRoom: string | undefined): boolean {
  if (!status.checked) return true;
  return channelRoomMoved(status.room, heldRoom);
}

/** 通道层没配 key/secret 时那句话。要 Ben 去 Mac 上动手,所以说的是「电脑上」。 */
export const CHANNEL_NOT_CONFIGURED_TEXT = '电脑上还没配 LiveKit 的 api key / secret';
/** livekit-server 不应答。 */
export const CHANNEL_NO_SERVER_TEXT = '连不上 LiveKit 服务器';
/** 服务器在、工人不在:最常见的一种,而且 Ben 一眼能知道去干什么。 */
export const CHANNEL_NO_WORKER_TEXT = '电脑上的事务官工人没在跑';

/**
 * 回包 → 能不能打。**纯函数**,单独抽出来是因为这三句话的取舍是这张卡里最容易写糊的一处:
 * 三件事都齐了才算能打;缺哪一样就说哪一样,服务端的 note 如果说得更具体就用它的原话。
 */
export function channelCallReadiness(data: ChannelStatusBody | undefined): RtcStatus {
  const note = typeof data?.note === 'string' && data.note !== '' ? data.note : undefined;
  // 电脑报的房间名原样带上来(卡 RM ③):调用方拿它跟手上那张凭证比一比。没报就缺席。
  const room = typeof data?.room === 'string' && data.room.trim() !== '' ? { room: data.room.trim() } : {};
  if (data?.configured !== true) return { configured: false, checked: true, reason: note ?? CHANNEL_NOT_CONFIGURED_TEXT, ...room };
  if (data?.server !== true) return { configured: false, checked: true, reason: note ?? CHANNEL_NO_SERVER_TEXT, ...room };
  if (data?.worker !== true) return { configured: false, checked: true, reason: note ?? CHANNEL_NO_WORKER_TEXT, ...room };
  return { configured: true, checked: true, ...room };
}

export function createCallApi(client: ApiClient): CallApi {
  return {
    async status() {
      const r = await client.json<{ configured?: unknown, reason?: unknown }>(`${PROXY}/rtc/status`);
      if (!r.ok) return { configured: false, checked: false, reason: r.error };
      const data = r.data;
      return {
        configured: data?.configured === true,
        checked: true,
        ...(typeof data?.reason === 'string' && data.reason !== '' ? { reason: data.reason } : {}),
      };
    },
    async channelStatus() {
      const r = await client.json<ChannelStatusBody>('/channel/status');
      // 没问到 ≠ 没配。前者过会儿还能打,后者要 Ben 去 Mac 上动手。
      if (!r.ok) return { configured: false, checked: false, reason: r.error };
      return channelCallReadiness(r.data);
    },
    token() {
      return client.json<RtcToken>(`${PROXY}/rtc/token`, { method: 'POST', body: {} });
    },
    start(input) {
      return client.json<RtcStarted>(`${PROXY}/rtc/start`, {
        method: 'POST',
        body: {
          roomId: input.roomId,
          userId: input.userId,
          ...(input.avatarId === undefined ? {} : { avatarId: input.avatarId }),
        },
      });
    },
    stop(input) {
      return client.json<{ durationSeconds?: number }>(`${PROXY}/rtc/stop`, { method: 'POST', body: input });
    },
    record(input) {
      return client.json<{ id?: string }>('/butler/call/record', {
        method: 'POST',
        body: {
          ...(input.callId === undefined || input.callId === '' ? {} : { call_id: input.callId }),
          ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
          transcript: input.transcript,
          ...(input.kind === undefined ? {} : { kind: input.kind }),
        },
      });
    },
  };
}
