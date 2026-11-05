/**
 * `ApiClient` 的第二个实现:请求经 LiveKit 房间的数据通道,由 Mac 上的工人代理(2026-09-17)。
 *
 * 和 api/client.ts 那一份**接口完全一样**,业务代码不知道自己走的是哪条:
 * status 的四种口径(200 / 401 / 503 / 其它)一模一样,error 文案也一样从 body.error 里取原话。
 *
 * 几处要说清楚的:
 *
 * 1. `blob()` 走不了这条路。工人代理回来的是 JSON,音频(TTS)、形象包(bundle.zip)那几样是二进制,
 *    协议里没有为它们留位置(设计 §二说大文件先不做)。远程模式下这几样如实回一句,
 *    **不假装成功、也不塞一段空音频**;那一句从 remoteParity.ts 里取(每一条都写了在外面怎么办)。
 * 2. **识别是例外**(2026-09-25,卡 S):`POST /butler/proxy/api/asr` 带着一段 WAV(Blob)来,走专门那条 ——
 *    `wb.rpc` 上一条 `{type:'asr'}` + `wb.asr` 字节流,工人交给电脑上的识别(channel-worker/src/asrRelay.ts)。
 *    回包是那条 HTTP 原样的 status + body,和直连同一个口径;房间那一侧的几种没办成折成 status
 *    (504 等太久 / 501 电脑上的事务官太旧),api/voice.ts 按 status 说人话,两条路一套说法。
 * 3. 工人那一侧有一份**白名单**(channel-worker/src/rpc.ts 的 RPC_ALLOWED),不在里头的一律 403。
 *    手机这一侧有一张对得上的表(remoteParity.ts):声明「只在局域网」的那几条**当场**回它那句给人看的话,
 *    不往房间里白跑一趟;没声明又被挡的(守门用例会拦住这种情况),才落到 403 那句兜底。
 *    403 当 `unavailable`:对界面来说是「这项能力在外面用不了」,不是「出错了」。**只在这条路上这么归**。
 */
import type { ApiClient, ApiResult, RequestOptions } from '../api/client';
import { WBCH_RPC_NOT_PAIRED_TEXT, WBCH_WORKER_NOT_PAIRED_TEXT, type WbchRpc, type WbchRpcResult } from './rpc';
import type { WbchMethod } from './channelProtocol';
import { lanOnlyReason } from './remoteParity';

/**
 * 在外面走不了、又没在 remoteParity.ts 里写明那句话时的兜底说法(二进制那几条、工人白名单不放的那几条)。
 * 守门(tests/remoteParity.test.ts)让这种情况只剩「别处正在加白名单」那一类 —— 那时他看见的就是这一句,不是「白名单」原话。
 */
export const WBCH_BLOB_UNSUPPORTED_TEXT = '这一样在外面还用不了,跟电脑连同一个 Wi-Fi 时才有';

/** 工人白名单不放时那句原话的尾巴(channel-worker/src/rpc.ts:`${method} ${path} 不在房间代理的白名单里`)。不给他看。 */
const WORKER_WHITELIST_REFUSAL = '不在房间代理的白名单里';

/** 房间这条路的 baseUrl 只是个说明用的标签,不会被拿去拼真地址。 */
export const WBCH_REMOTE_BASE_URL = 'wbch://room';

/** 识别那条路(与直连打的是同一条)。只有它带着 Blob 也走得了房间。 */
export const WBCH_ASR_PATH = '/butler/proxy/api/asr';

/** 会议分段那条(2026-10-09)。只有它和识别带着 Blob 也走得了房间;只在她这一场同意过才被调(meetingApi.ts)。 */
export const WBCH_MEETING_SEGMENT_PATH = '/meeting/segment';

/** 电脑上的工人不认 `meeting_segment`(10-09 之前的老版本):折成 501。 */
export const WBCH_MEETING_OUTDATED_TEXT = '电脑上的事务官还是旧版本,在外面传不了会议录音;回到家里的网会自动传';

/** 经房间传一段等到上限还没回。 */
export const WBCH_MEETING_SLOW_TEXT = '经服务器传这一段,等了很久没传完(网可能慢),等会儿会再传';

/** 经房间转文字等到上限还没回(折成 504,voice.ts 说「等太久」)。这一句只进日志 / 测试,屏上是 voice.ts 那句。 */
export const WBCH_ASR_SLOW_TEXT = '经房间转文字,等了很久没回';

/**
 * 电脑上的工人不认 `asr` 这种请求 —— 是 09-25 之前的老版本(折成 501,voice.ts 说「电脑上的事务官要更新」)。
 */
export const WBCH_ASR_OUTDATED_TEXT = '电脑上的事务官还是旧版本,在外面转不了文字';

/** 一个 Blob 的字节。WebView 有 `arrayBuffer()`;没有的(老内核、测试里的 jsdom)退回 FileReader。 */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('读不出录音'));
    reader.readAsArrayBuffer(blob);
  });
}

function errorTextOf(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const raw = (body as { error?: unknown }).error;
    if (typeof raw === 'string' && raw !== '') {
      // 工人的两句原话换成他看得懂、照着能做的:不认这台手机 → 重新配对;白名单不放 → 在外面还用不了。
      if (raw === WBCH_WORKER_NOT_PAIRED_TEXT) return WBCH_RPC_NOT_PAIRED_TEXT;
      if (raw.endsWith(WORKER_WHITELIST_REFUSAL)) return WBCH_BLOB_UNSUPPORTED_TEXT;
      return raw;
    }
  }
  return fallback;
}

export interface WbchChannelClientDeps {
  rpc: WbchRpc;
  /** 和直连那条路同一个回调:401 一出现就回配对页。两条路共用一个,免得点两次。 */
  onUnauthorized: () => void;
}

export function createWbchChannelClient(deps: WbchChannelClientDeps): ApiClient {
  let unauthorizedFired = false;

  /** 一条 HTTP 回包(status + body)→ ApiResult。代理那条与识别那条共用,口径与直连一致。 */
  function fromReply<T>(reply: Extract<WbchRpcResult, { ok: true }>): ApiResult<T> {
    const { status, body } = reply;
    if (status >= 200 && status < 300) return { ok: true, status, data: body as T };
    if (status === 401) {
      if (!unauthorizedFired) { unauthorizedFired = true; deps.onUnauthorized(); }
      return { ok: false, status, kind: 'unauthorized', error: errorTextOf(body, '设备令牌已失效:请重新配对') };
    }
    if (status === 503) return { ok: false, status, kind: 'unavailable', error: errorTextOf(body, '本机没有配这项能力') };
    // 403 = 工人的白名单不放这条,或者工人不认这台手机(那一句换成能照着做的,见 errorTextOf)。
    if (status === 403) return { ok: false, status, kind: 'unavailable', error: errorTextOf(body, WBCH_BLOB_UNSUPPORTED_TEXT) };
    return { ok: false, status, kind: 'http', error: errorTextOf(body, `请求失败(${status})`) };
  }

  /** 识别那条(见文件头第 2 条)。 */
  async function asr<T>(audio: Blob): Promise<ApiResult<T>> {
    if (deps.rpc.asr === undefined) return { ok: false, status: 501, kind: 'http', error: WBCH_ASR_OUTDATED_TEXT };
    let bytes: Uint8Array;
    try { bytes = await blobBytes(audio); }
    catch { return { ok: false, status: 400, kind: 'http', error: '这段录音读不出来' }; }
    const result = await deps.rpc.asr(bytes, audio.type !== '' ? audio.type : 'audio/wav');
    if (result.ok) return fromReply<T>(result);
    if (result.cause === 'timeout') return { ok: false, status: 504, kind: 'http', error: WBCH_ASR_SLOW_TEXT };
    // 老工人:`不认识这种请求:asr`。它答得上来(不是连不上),只是不会这一样。
    if (result.cause === 'worker' && result.error.includes('不认识这种请求')) return { ok: false, status: 501, kind: 'http', error: WBCH_ASR_OUTDATED_TEXT };
    return { ok: false, status: 0, kind: 'network', error: result.error };
  }

  /** 会议分段那条(见 WBCH_MEETING_SEGMENT_PATH)。哪一场、第几段、多长从查询串里取(与直连同一个查询串)。 */
  async function meetingSegment<T>(path: string, audio: Blob): Promise<ApiResult<T>> {
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    const meetingId = (query.get('id') ?? '').trim();
    const seq = Number(query.get('seq') ?? '');
    const ms = Number(query.get('ms') ?? '');
    if (meetingId === '' || !Number.isInteger(seq) || seq < 1) return { ok: false, status: 400, kind: 'http', error: '要带 id 与 seq(从 1 开始)' };
    if (deps.rpc.meetingSegment === undefined) return { ok: false, status: 501, kind: 'http', error: WBCH_MEETING_OUTDATED_TEXT };
    let bytes: Uint8Array;
    try { bytes = await blobBytes(audio); }
    catch { return { ok: false, status: 400, kind: 'http', error: '这段录音读不出来' }; }
    const result = await deps.rpc.meetingSegment(bytes, audio.type !== '' ? audio.type : 'audio/mp4', {
      meetingId, seq, ...(Number.isFinite(ms) && ms > 0 ? { ms } : {}),
    });
    if (result.ok) return fromReply<T>(result);
    if (result.cause === 'timeout') return { ok: false, status: 504, kind: 'http', error: WBCH_MEETING_SLOW_TEXT };
    if (result.cause === 'worker' && result.error.includes('不认识这种请求')) return { ok: false, status: 501, kind: 'http', error: WBCH_MEETING_OUTDATED_TEXT };
    return { ok: false, status: 0, kind: 'network', error: result.error };
  }

  async function call<T>(path: string, options: RequestOptions): Promise<ApiResult<T>> {
    const method = (options.method ?? 'GET') as WbchMethod;
    // 声明了只在局域网的:当场说那句给人看的话(remoteParity.ts),不往房间里白跑一趟。
    const lanOnly = lanOnlyReason(method, path);
    if (lanOnly !== undefined) return { ok: false, status: 0, kind: 'unavailable', error: lanOnly };
    if (options.body instanceof Blob && method === 'POST' && path.split('?')[0] === WBCH_ASR_PATH) return asr<T>(options.body);
    if (options.body instanceof Blob && method === 'POST' && path.split('?')[0] === WBCH_MEETING_SEGMENT_PATH) return meetingSegment<T>(path, options.body);
    // 别的只有能 JSON 化的 body 走得了这条路。Blob / FormData 在协议里没有位置。
    if (options.body instanceof Blob || options.body instanceof FormData) {
      return { ok: false, status: 0, kind: 'unavailable', error: WBCH_BLOB_UNSUPPORTED_TEXT };
    }
    const result = await deps.rpc.http({ method, path, ...(options.body === undefined ? {} : { body: options.body }) });
    if (!result.ok) return { ok: false, status: 0, kind: 'network', error: result.error };
    return fromReply<T>(result);
  }

  return {
    baseUrl: WBCH_REMOTE_BASE_URL,
    json: <T>(path: string, options: RequestOptions = {}) => call<T>(path, options),
    async blob(path: string, options: RequestOptions = {}) {
      return { ok: false, status: 0, kind: 'unavailable', error: lanOnlyReason(options.method ?? 'GET', path) ?? WBCH_BLOB_UNSUPPORTED_TEXT };
    },
  };
}
