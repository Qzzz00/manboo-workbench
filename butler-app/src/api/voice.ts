/**
 * 语音与形象:全部经工作台代理到本机后端 `/butler/proxy/api/*`(契约见 docs/交接-0914-butler-app.md):
 *   GET  /avatars、/avatars/:id、/avatars/:id/bundle.zip
 *   POST /tts { text, avatarId? } → audio
 *   POST /asr  裸 WAV(`content-type: audio/wav`)→ { text }    (butler-server 两种都认;2026-09-25 起不再转 base64)
 *   POST /rtc/token
 * 接口 503(电脑上没配)/ 404(工作台没接本机后端)→ 界面退回文字模式,说「语音暂时用不了,先打字」,不编假回复。
 *
 * **识别在哪都能用**(2026-09-25,卡 S「手机在哪都能用」):局域网里直连 8791;出了局域网,同一个请求由通道层
 * 改走房间 —— 录音经 `wb.asr` 字节流交给电脑上的通话组件,它交给同一个本机识别(channel/channelClient.ts、
 * channel-worker/src/asrRelay.ts)。**这里一个字不分叉**:两条路回的都是那条 HTTP 的 status + body。
 */
import type { ApiClient, ApiResult } from './client';

/**
 * 语音(朗读 / 按住说话)这会儿用不了时,麦克风键下面那一行。2026-09-25(卡 S)改过措辞:以前是「本机没有配语音,先用文字」——
 * 第一次用的人读到「本机」会以为是手机缺了什么、要去设置里找;其实是电脑那边还没开通,他什么都不用做(60 秒后自己再探)。
 */
export const VOICE_UNAVAILABLE_TEXT = '语音暂时用不了,先打字;好了会自己恢复';

/** 识别出来是空的(没说话、太小声、噪音):客户端空文本与服务端 422 empty_transcript 同一句。 */
export const ASR_EMPTY_TEXT = '没听清,再说一遍?';

/*
 * 识别没成时屏上那一句(2026-09-25,卡 S)。**说真实原因,并给一个能做的下一步**。
 *
 * 09-24 那一版在外面只会说「不在同一个网络,这会儿转不了文字」—— 那不是原因,是借口:出了局域网本来就该能转。
 * 现在房间那条路通了,没成只剩下面这几种真原因,两条路(直连 / 房间)同一套说法,按 HTTP status 分:
 *   电脑不在线(连不上)/ 没听清(422、空文本)/ 识别服务出错(5xx、没配)/ 等太久(408、504),
 *   外加三种少见但确实会有的:太长(413)、电脑上的事务官太旧(501,老工人不认这种请求)、不认这台手机(401 / 403)。
 */
/*
 * 措辞按「不懂技术、第一次用、人在外面」的人读(维护者 09-25 的设计原则:从常规用户第一次使用、非专业用户的视角想):
 * 不说「识别服务」「钥匙」「版本号」「局域网」这类词;每句都说**他此刻能做的那一步**,做不了的(电脑不在他身边)就说等什么。
 */
/** 两条路都够不着电脑,又说不清是哪一头的毛病。 */
export const ASR_OFFLINE_TEXT = '连不上电脑,这段没转成文字:等手机和电脑都连上网,再按住说';
/** 进了房间,电脑不在房里(关机、睡着、断网)。他在外面管不了电脑,就说等它上线。 */
export const ASR_DESKTOP_OFFLINE_TEXT = '电脑不在线,这段没转成文字:等电脑开机、连上网,再按住说';
/**
 * 进了房间,而且**确知**电脑是「没说再见就消失了」(2026-09-28,卡 AW,与首页同一口径)。
 * 合盖、省电睡过去就长这样 —— 说这一件事,别让他去猜是不是配对坏了。
 */
export const ASR_DESKTOP_ASLEEP_TEXT = '电脑睡着了,这段没转成文字:打开电脑(合盖的话掀开)就会自己连上,再按住说';
/** 手机自己没网。 */
export const ASR_PHONE_OFFLINE_TEXT = '手机没连上网,这段没转成文字:连上网再按住说';
export const ASR_SLOW_TEXT = '转文字等得太久,这段没转成:网可能慢,再按住说一遍,或者先打字';
export const ASR_SERVICE_TEXT = '电脑那边转文字出了错,这段没转成:过一会儿再按住说,或者先打字';
/** 电脑那边没有转文字的能力(服务器还没下发)。他什么都不用做,好了就能用 —— 这一点要说出来,免得他去翻设置。 */
export const ASR_UNCONFIGURED_TEXT = '电脑那边暂时转不了文字,这段先打字吧;好了之后不用你做什么,直接按住说就行';
export const ASR_TOO_LONG_TEXT = '这段太长了,一次最多说 20 秒:分两段说';
/** 电脑上的工作台是 09-25 之前的,不会经房间转文字。 */
export const ASR_OUTDATED_TEXT = '电脑上的工作台要更新一下,才能在外面转文字:回到电脑前点一下更新,这会儿先打字';

/**
 * 「连不上」那一句按此刻知道的细一点(调用方从通道层取了传进来;这里不 import 通道层,api 层不往上依赖):
 * 手机自己没网 → 说手机;中转明说不认这台手机 → 原话(它自带「重新扫码配对」);进了房、房里没有电脑 → 说电脑;
 * 别的说不清是哪一头,就说「连不上电脑」,不猜。
 */
export function asrOfflineText(ctx: { online?: boolean; presence?: { kind: string; error?: string; departure?: string } } = {}): string {
  if (ctx.online === false) return ASR_PHONE_OFFLINE_TEXT;
  if (ctx.presence?.kind === 'revoked' && ctx.presence.error !== undefined && ctx.presence.error !== '') return ctx.presence.error;
  // 确知电脑是没说再见就消失的(卡 AW)→ 说睡着了;**没有这个依据就照旧说「不在线」,不猜**。
  if (ctx.presence?.kind === 'absent' && ctx.presence.departure === 'timeout') return ASR_DESKTOP_ASLEEP_TEXT;
  if (ctx.presence?.kind === 'absent') return ASR_DESKTOP_OFFLINE_TEXT;
  return ASR_OFFLINE_TEXT;
}

/** 一次识别请求没成 → 屏上那一句。直连与房间两条路共用(见上面那段)。 */
export function asrFailureOf(result: Extract<ApiResult<unknown>, { ok: false }>, offlineText: () => string = () => ASR_OFFLINE_TEXT): Extract<AsrResult, { ok: false }> {
  const { status } = result;
  if (status === 422) return { ok: false, kind: 'empty', error: ASR_EMPTY_TEXT };
  if (result.kind === 'network') return { ok: false, kind: 'network', error: offlineText() };
  // 503 = 电脑上没配识别;404 = 这台工作台没接本机后端。两样都是「没配好」,不是坏了。
  if (status === 503 || status === 404) return { ok: false, kind: 'unavailable', error: ASR_UNCONFIGURED_TEXT };
  // 不认这台手机:通道层 / 8791 给的那句本来就带着出路(重新扫码配对),原样转达。
  if (status === 401 || status === 403) return { ok: false, kind: 'unauthorized', error: result.error };
  if (status === 408 || status === 504) return { ok: false, kind: 'slow', error: ASR_SLOW_TEXT };
  if (status === 413) return { ok: false, kind: 'too_long', error: ASR_TOO_LONG_TEXT };
  if (status === 501) return { ok: false, kind: 'outdated', error: ASR_OUTDATED_TEXT };
  return { ok: false, kind: 'http', error: ASR_SERVICE_TEXT };
}

export interface AvatarSummary {
  id: string;
  name: string;
  summary?: string;
  status?: string;
  version?: number | string;
  /** 已发布那一版 zip 的字节数与 sha256(butler-server routes/api/avatars.cjs 的 size_bytes / checksum)。 */
  size_bytes?: number | null;
  checksum?: string | null;
}

export interface AvatarDetail extends AvatarSummary {
  model_entry?: string;
  transform?: Record<string, unknown>;
  voice?: string | null;
  default_background?: string | null;
}

/**
 * 识别的结果。没成时 `error` **就是屏上那一句**(asrFailureOf 定的),调用方原样给他看;
 * `kind`:empty 没听清 / unavailable 电脑上没配 / network 连不上 / http 识别服务出错 / unauthorized 不认这台手机 /
 * slow 等太久 / too_long 太长 / outdated 电脑上的事务官太旧。
 */
export type AsrResult =
  | { ok: true; text: string }
  | { ok: false; kind: 'empty' | 'unavailable' | 'network' | 'http' | 'unauthorized' | 'slow' | 'too_long' | 'outdated'; error: string };

export interface VoiceApiOptions {
  /** 「连不上」时屏上那一句,按此刻知道的细一点(session.ts 从通道层取;缺省 {@link ASR_OFFLINE_TEXT})。 */
  offlineText?: () => string;
}

export interface VoiceApi {
  listAvatars(): Promise<{ ok: true; avatars: AvatarSummary[] } | Extract<ApiResult<never>, { ok: false }>>;
  getAvatar(id: string): Promise<ApiResult<AvatarDetail>>;
  fetchBundle(id: string): Promise<ApiResult<Blob>>;
  tts(text: string, avatarId?: string): Promise<ApiResult<Blob>>;
  asr(wav: Blob): Promise<AsrResult>;
  rtcToken(): Promise<ApiResult<unknown>>;
}

const PROXY = '/butler/proxy/api';

function normalizeAvatars(data: unknown): AvatarSummary[] {
  const list = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as { avatars?: unknown }).avatars)
      ? (data as { avatars: unknown[] }).avatars
      : [];
  return list
    .filter((x): x is AvatarSummary => typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string')
    .filter((x) => x.status === undefined || x.status === 'published')
    .map((x) => ({ ...x, name: typeof x.name === 'string' && x.name !== '' ? x.name : x.id }));
}

export function createVoiceApi(client: ApiClient, options: VoiceApiOptions = {}): VoiceApi {
  const offlineText = options.offlineText ?? (() => ASR_OFFLINE_TEXT);
  return {
    async listAvatars() {
      const r = await client.json<unknown>(`${PROXY}/avatars`);
      if (!r.ok) return r;
      return { ok: true, avatars: normalizeAvatars(r.data) };
    },
    async getAvatar(id) {
      // butler-server 回的是 `{ avatar: {...} }`(routes/api/avatars.cjs);拆掉这一层,model_entry / transform 才读得到。
      const r = await client.json<unknown>(`${PROXY}/avatars/${encodeURIComponent(id)}`);
      if (!r.ok) return r;
      const body = r.data as { avatar?: unknown } | null;
      const detail = typeof body === 'object' && body !== null && typeof body.avatar === 'object' && body.avatar !== null ? body.avatar : body;
      return { ...r, data: detail as AvatarDetail };
    },
    fetchBundle(id) {
      return client.blob(`${PROXY}/avatars/${encodeURIComponent(id)}/bundle.zip`);
    },
    tts(text, avatarId) {
      return client.blob(`${PROXY}/tts`, { method: 'POST', body: { text, ...(avatarId === undefined ? {} : { avatarId }) } });
    },
    async asr(wav) {
      /**
       * **录音原样以字节上路**(2026-09-25,卡 S),不再转 base64:直连时就是一个 `audio/wav` 的 POST
       * (butler-server 的 /api/asr 本来就收裸 WAV,8791 原样转过去);出了局域网,通道层把这个 Blob
       * 放上 `wb.asr` 字节流(channel/channelClient.ts)。两条路都少了三分之一的字节。
       * `idempotent`:重发一次无害(只是再识别一遍),直连还没确认时可以到点掐断改走房间(routedClient.ts)。
       */
      const mimeType = wav.type !== '' ? wav.type : 'audio/wav';
      const r = await client.json<{ text?: unknown }>(`${PROXY}/asr`, {
        method: 'POST',
        body: wav.type !== '' ? wav : new Blob([wav], { type: mimeType }),
        headers: { 'content-type': mimeType },
        idempotent: true,
      });
      // 422 = 识别服务说「没听清」(butler-server routes/api/asr.cjs 的 empty_transcript):和空文本同一句。
      if (!r.ok) return asrFailureOf(r, offlineText);
      const text = typeof r.data?.text === 'string' ? r.data.text.trim() : '';
      if (text === '') return { ok: false, kind: 'empty', error: ASR_EMPTY_TEXT };
      return { ok: true, text };
    },
    rtcToken() {
      return client.json<unknown>(`${PROXY}/rtc/token`, { method: 'POST', body: {} });
    },
  };
}

/** 不可用时记下判定时刻(since,毫秒):过了 VOICE_RETRY_MS 再有机会就重新探一次,Ben 配好密钥不用重装 App。 */
export type VoiceAvailability = 'unknown' | { available: true } | { available: false; note: string; since?: number };

/** 「没配」之后多久再试一次。 */
export const VOICE_RETRY_MS = 60_000;

/** 一次语音接口的结果 → 语音可用性。掉线不改判断;503/404 才是「没配」。 */
export function reduceVoiceAvailability(current: VoiceAvailability, result: ApiResult<unknown>, now: number = Date.now()): VoiceAvailability {
  if (result.ok) return { available: true };
  if (result.kind === 'unavailable' || result.status === 404) return { available: false, note: VOICE_UNAVAILABLE_TEXT, since: now };
  return current;
}

/**
 * 这一次要不要真的去打语音接口:没判过 / 可用 → 打;不可用但已过 retryMs → 再探一次;否则跳过。
 * 语音可用与否**只**由 /api/tts、/api/asr 的结果决定——有没有已发布形象是另一回事(形象只决定画粒子还是 Live2D)。
 */
export function shouldTryVoice(current: VoiceAvailability, now: number = Date.now(), retryMs: number = VOICE_RETRY_MS): boolean {
  if (current === 'unknown' || current.available) return true;
  return current.since === undefined || now - current.since >= retryMs;
}
