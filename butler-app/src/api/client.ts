/**
 * 工作台 8791 的 HTTP 客户端。App 只对这一个地址说话。
 *
 * - 每个请求带 `Authorization: Bearer <设备令牌>`(令牌只在这里出现,不打日志、不进 URL)。
 * - 401 = 令牌失效(被解除配对 / 工作台重置)→ 通知一次 onUnauthorized,界面回配对页并说明。
 * - 503 = 那项能力本机没配(语音那几条)→ kind=unavailable,界面退回文字模式,不算掉线。
 * - 连不上 → kind=network。
 * 服务端的 error 文案原样转达,不自己编。
 *
 * 2026-09-17:`ApiClient` 现在有两个实现——这一份(局域网直连 8791)和 channel/channelClient.ts
 * (出了局域网,经 LiveKit 房间的数据通道让 Mac 上的工人代理)。谁走哪条由 channel/routedClient.ts
 * 决定,**业务代码一律只见这个接口**。`ApiResult` 的四种 kind 是两条路共同的口径,改它要两边一起改。
 */
import type { Pairing } from './tokenStore';
import { baseUrlOf } from '../pairing/pairUrl';

export type ApiFailureKind = 'unauthorized' | 'unavailable' | 'network' | 'http';

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; kind: ApiFailureKind; error: string };

export interface RequestOptions {
  /** PUT / DELETE 眼下没人用,写全是因为房间那条路的协议允许(见 channel/channelProtocol.ts)。 */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 对象会被 JSON 序列化;Blob / FormData 原样发。 */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * 这一条**重发一次无害**(2026-09-25,卡 S:识别 —— 最多再识别一遍)。只有两条路那一层看它
   * (channel/routedClient.ts):直连还没确认时,它和 GET 一样到点就掐断、改走房间;POST 默认不掐,怕办两遍。
   */
  idempotent?: boolean;
}

/** 下载回来的东西(2026-09-25,卡 J):字节 + 服务端写在头里的几样。 */
export interface ApiDownload {
  bytes: Uint8Array;
  /** 服务端说的大小(Content-Length)。没说就缺席。 */
  total?: number;
  mimeType?: string;
  /** 服务端算好的 sha256(`x-wb-sha256`)。收完对一遍。 */
  sha256?: string;
}

export interface ApiClient {
  readonly baseUrl: string;
  json<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResult<T>>;
  blob(path: string, options?: RequestOptions): Promise<ApiResult<Blob>>;
  /**
   * **边下边报进度**(2026-09-25,卡 J:在家时从电脑直接取文件)。只有直连那一份有 ——
   * 房间那条路是一条 JSON 通道,字节走 `wb.file`,不走这里。可缺(老的假客户端没有)。
   */
  download?(path: string, options?: RequestOptions & { onProgress?: (received: number, total?: number) => void }): Promise<ApiResult<ApiDownload>>;
}

export interface ApiClientOptions {
  pairing: Pairing;
  /**
   * 现取的地址(2026-10-21,局域网 M4):路线驱动在家时判到的那个 8791(Mac 换了地址、mDNS 找回来的)。
   * 不给就是配对时那个地址。
   */
  baseUrl?: () => string;
  fetchImpl?: typeof fetch;
  onUnauthorized: () => void;
}

export const NETWORK_ERROR_TEXT = '连不上工作台:确认手机和 Mac 在同一局域网,且工作台设置里「允许手机在局域网访问」是开着的';

async function readError(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (text === '') return undefined;
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === 'string' && body.error !== '' ? body.error : undefined;
  } catch {
    return undefined;
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const pairedBase = baseUrlOf(options.pairing);
  const baseOf = (): string => options.baseUrl?.() ?? pairedBase;
  let unauthorizedFired = false;

  async function send(path: string, request: RequestOptions): Promise<Response | { failure: ApiResult<never> }> {
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${options.pairing.token}`);
    let body: BodyInit | undefined;
    if (request.body !== undefined) {
      if (request.body instanceof Blob || request.body instanceof FormData || typeof request.body === 'string') {
        body = request.body;
      } else {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(request.body);
      }
    }
    let res: Response;
    try {
      res = await fetchImpl(`${baseOf()}${path}`, {
        method: request.method ?? 'GET',
        headers,
        ...(body === undefined ? {} : { body }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch {
      return { failure: { ok: false, status: 0, kind: 'network', error: NETWORK_ERROR_TEXT } };
    }
    if (res.ok) return res;
    const error = await readError(res);
    if (res.status === 401) {
      if (!unauthorizedFired) {
        unauthorizedFired = true;
        options.onUnauthorized();
      }
      return { failure: { ok: false, status: 401, kind: 'unauthorized', error: error ?? '设备令牌已失效:请重新配对' } };
    }
    if (res.status === 503) {
      return { failure: { ok: false, status: 503, kind: 'unavailable', error: error ?? '本机没有配这项能力' } };
    }
    return { failure: { ok: false, status: res.status, kind: 'http', error: error ?? `请求失败(${res.status})` } };
  }

  return {
    get baseUrl() { return baseOf(); },
    async json<T>(path: string, request: RequestOptions = {}): Promise<ApiResult<T>> {
      const res = await send(path, request);
      if ('failure' in res) return res.failure;
      try {
        const text = await res.text();
        return { ok: true, status: res.status, data: (text === '' ? undefined : JSON.parse(text)) as T };
      } catch {
        return { ok: false, status: res.status, kind: 'http', error: '工作台回了一段读不懂的内容' };
      }
    },
    async blob(path: string, request: RequestOptions = {}): Promise<ApiResult<Blob>> {
      const res = await send(path, request);
      if ('failure' in res) return res.failure;
      return { ok: true, status: res.status, data: await res.blob() };
    },
    async download(path, request = {}) {
      const res = await send(path, request);
      if ('failure' in res) return res.failure;
      const declared = Number(res.headers.get('content-length'));
      const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;
      const mimeType = res.headers.get('content-type') ?? undefined;
      const sha256 = res.headers.get('x-wb-sha256') ?? undefined;
      const meta = { ...(total === undefined ? {} : { total }), ...(mimeType === undefined ? {} : { mimeType }), ...(sha256 === undefined ? {} : { sha256 }) };
      try {
        const reader = res.body?.getReader();
        if (reader === undefined) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          request.onProgress?.(bytes.length, total);
          return { ok: true, status: res.status, data: { bytes, ...meta } };
        }
        const chunks: Uint8Array[] = [];
        let received = 0;
        let lastEmit = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          if (received - lastEmit >= 256 * 1024) { lastEmit = received; request.onProgress?.(received, total); }
        }
        request.onProgress?.(received, total);
        const bytes = new Uint8Array(received);
        let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
        if (total !== undefined && received !== total) {
          return { ok: false, status: res.status, kind: 'network', error: `传到一半断了(收到 ${Math.floor((received / total) * 100)}%)` };
        }
        return { ok: true, status: res.status, data: { bytes, ...meta } };
      } catch {
        return { ok: false, status: res.status, kind: 'network', error: '传到一半断了(手机和电脑之间的网断了一下)' };
      }
    },
  };
}
