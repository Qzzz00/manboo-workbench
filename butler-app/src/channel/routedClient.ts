/**
 * 两条路怎么选(2026-09-17)。**局域网里优先直连 8791**(快),连不上自动切到房间代理。
 *
 * 判据只有一条:**直连回的是不是 kind=network**。
 *   - 回了 200 / 401 / 503 / 404 都算「工作台答了」,直接用,不切——那是真答复,换条路问也是同样的答复。
 *   - 回 network(连不上、超时)才切到房间。
 * 切过去之后不会一直待在远程:每过 recheckMs 拿下一条 **GET** 当探子,再试一次直连;通了就切回来。
 * 探子用的是真请求,不另发心跳——多一条心跳就多一处会骗人的状态。
 * **只拿 GET 当探子**(2026-09-25,卡 S):探子那一下在外面常常要挂到系统超时(几十秒)才失败,
 * GET 到点就掐(directProbeMs),POST 不掐(怕办两遍)—— 以前每 30 秒轮到的那条 POST 就这么干等,
 * 在外面按住说话、发一句话,碰上了就是半分钟没反应。首页每 3 秒一条 GET /state,探子不缺。
 *
 * 两条都不通 = offline,原样转达直连那句话(它说得最具体:同不同网、开没开局域网访问)。
 *
 * 状态给舞台页顶上那条细横幅用;**不弹窗**(Ben 的口径:切换是自动的,别打扰)。
 */
import type { ApiClient, ApiResult, RequestOptions } from '../api/client';
import type { WbchMode } from './channelProtocol';
import { stampClientKey } from './clientKey';

export interface WbchRoutedClient extends ApiClient {
  mode(): WbchMode;
  subscribe(listener: (mode: WbchMode) => void): () => void;
}

export interface WbchRoutedClientDeps {
  direct: ApiClient;
  /**
   * 拿远程那条路。**要现拿**:它得先保证房间连着(可能要进房、可能凭证过期要先续)。
   * 拿不到就说一句为什么(那句话会原样出现在失败结果里)。
   */
  remote: () => Promise<{ ok: true; client: ApiClient } | { ok: false; error: string }>;
  /**
   * 从远程/未连接**切回直连那一下**叫一次(不是每条请求都叫)。
   * 通道层据此把房间放掉:回到局域网之后还挂着一条 WebSocket 只是白耗电。
   */
  onBackToDirect?: () => void;
  /** 待在远程时,隔多久拿一条请求回头试试直连。缺省 30 秒。 */
  recheckMs?: number;
  /**
   * **试探直连**最多等多久(2026-09-23 第二轮从零重装)。只管两种时候的 **GET**:
   * 还没直连成功过(刚打开 App),以及待在远程 / 未连接时回头探一下。
   *
   * 手机只有 LTE 时,局域网地址那一下常常不是当场失败,而是连接一直挂着等系统超时(几十秒到两分钟)——
   * 那段时间里首页什么结论都给不出。等到点就当连不上,转房间那条路。
   * 只管 GET:它们重发一次无害;POST(发事项、上传录音)被掐断再走房间可能办两遍,照旧等到底。
   * 直连通过之后、在直连模式里的请求**不掐**(大文件、慢接口照常)。
   */
  directProbeMs?: number;
  /**
   * 手机的网络变了(Wi-Fi ↔ 移动网络、断网又连上)就叫一声(2026-09-25,卡 S「刚出家门那一下」)。
   * 叫了之后「直连通过过」作废:家里那个地址又回到**没确认**,下一条 GET / 标了 idempotent 的请求(识别)
   * 最多等 directProbeMs 就改走房间,而不是挂到系统超时(LTE 上够不着局域网地址,那一下常常要几十秒)。
   * 回的函数用来退订。不给就不管(老调用方、测试)。session.ts 接的是 `online` / `offline` 与 navigator.connection 的 `change`。
   */
  networkChanges?: (listener: () => void) => () => void;
  now?: () => number;
  /**
   * 直连探测多久还没答,就**同时**开始走房间(2026-09-30,维护者:「手机一上来先显示电脑不在线」)。
   * 缺省 {@link WBCH_RACE_AFTER_MS}。0 = 不抢跑(老行为:直连失败了才去房间)。只对重发无害的请求(GET / idempotent)抢跑。
   */
  raceAfterMs?: number;
  /**
   * **按路线选直连**(2026-10-21,局域网 M4)。路线驱动(routeDriver.ts)判在家 / 出门:
   * `url` = 此刻直连 8791 用的地址(`direct` 那个客户端的地址跟着它走);`null` = 不在家,**直连一下都不碰**,直接走房间
   * (4G 上拿局域网地址去碰运气,常常要挂到系统超时)。`settled: false` = 第一次判定还没落地,先等 {@link settled}。
   * 不给就是老规矩(自己试直连、不通再切)。
   */
  directBase?: () => { url: string | null; settled: boolean };
  /** 等第一次判定落地(最多等多久由它自己定)。 */
  settled?: () => Promise<void>;
  /** 在家时直连这一下慢(`raceAfterMs` 没答):告诉驱动复查一次(Mac 可能换了地址、Wi-Fi 可能刚断)。 */
  onSlowDirect?: () => void;
}

const DEFAULT_RECHECK_MS = 30000;
export const WBCH_DIRECT_PROBE_MS = 5000;
/** 直连这么久还没答就同时走房间。在家直连零点几秒就回来,房间一下都不碰。 */
export const WBCH_RACE_AFTER_MS = 1200;

/**
 * 浏览器 / WebView 里「网络变了」的那几个事件(给 session.ts 当缺省)。没有 window(测试、非浏览器)就什么都不挂。
 * `navigator.connection` 的 `change`:安卓 WebView 在 Wi-Fi ↔ 移动网络切换时发;`online` / `offline`:断网与连上。
 */
export function wbchNetworkChanges(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
  const connection = (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: EventTarget }).connection);
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  try { connection?.addEventListener?.('change', listener); } catch { /* 老内核没有 */ }
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
    try { connection?.removeEventListener?.('change', listener); } catch { /* 同上 */ }
  };
}

export function createWbchRoutedClient(deps: WbchRoutedClientDeps): WbchRoutedClient {
  const recheckMs = deps.recheckMs ?? DEFAULT_RECHECK_MS;
  const now = deps.now ?? (() => Date.now());
  const listeners = new Set<(mode: WbchMode) => void>();
  let mode: WbchMode = 'direct';
  let lastDirectTry = 0;
  const probeMs = deps.directProbeMs ?? WBCH_DIRECT_PROBE_MS;
  /** 这一次打开 App 以来直连通过没有。通过之前,直连那一下也算「试探」。网络一变就作废(见 networkChanges)。 */
  let directEverOk = false;
  // 网络变了:家里那个地址回到「没确认」,远程时也马上可以回头探一次(不用再等 recheckMs)。
  deps.networkChanges?.(() => { directEverOk = false; lastDirectTry = 0; });

  function setMode(next: WbchMode): void {
    if (mode === next) return;
    const wasRemote = mode !== 'direct';
    mode = next;
    if (next === 'direct' && wasRemote) {
      try { deps.onBackToDirect?.(); } catch { /* 放房间失败不该拦住这条请求 */ }
    }
    for (const l of [...listeners]) { try { l(next); } catch { /* 一个订阅者抛不该拦住请求 */ } }
  }

  /**
   * 这一拍要不要先试直连。直连模式下都试;远程 / 未连接时只让 **GET** 待够了 recheckMs 回头探一次
   * (见文件头「只拿 GET 当探子」:POST 在外面探直连会干等到系统超时)。
   */
  function shouldTryDirect(options: RequestOptions): boolean {
    if (mode === 'direct') return true;
    return (options.method ?? 'GET') === 'GET' && now() - lastDirectTry >= recheckMs;
  }

  /** 直连跑一次;是「试探」且重发无害(GET,或者标了 idempotent 的识别)时,到点就掐断(当连不上)。 */
  async function runDirect<T>(
    run: (client: ApiClient, options: RequestOptions) => Promise<ApiResult<T>>,
    options: RequestOptions,
  ): Promise<ApiResult<T>> {
    const retrySafe = (options.method ?? 'GET') === 'GET' || options.idempotent === true;
    const probing = (!directEverOk || mode !== 'direct') && retrySafe && probeMs > 0;
    if (!probing) return run(deps.direct, options);
    const controller = new AbortController();
    const outer = options.signal;
    const onOuter = () => controller.abort();
    if (outer !== undefined) { if (outer.aborted) controller.abort(); else outer.addEventListener('abort', onOuter); }
    const timer = setTimeout(() => controller.abort(), probeMs);
    try {
      return await run(deps.direct, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  }

  const raceAfterMs = deps.raceAfterMs ?? WBCH_RACE_AFTER_MS;

  /**
   * **直连慢就同时走房间,谁先通用谁**(2026-09-30)。只在「这一下是试探」(直连还没确认过)、
   * 且请求重发无害时用;先等直连 `raceAfterMs`,答了就照老路走;没答就同时开房间那条。
   * 回 `undefined` = 这一下不抢跑,调用方照老路走。
   */
  async function race<T>(
    run: (client: ApiClient, options: RequestOptions) => Promise<ApiResult<T>>,
    options: RequestOptions,
  ): Promise<ApiResult<T> | undefined> {
    const retrySafe = (options.method ?? 'GET') === 'GET' || options.idempotent === true;
    if (raceAfterMs <= 0 || !retrySafe || directEverOk || mode !== 'direct') return undefined;
    lastDirectTry = now();
    const directP = runDirect(run, options);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const early = await Promise.race([
      directP.then((r) => ({ kind: 'direct' as const, r })),
      new Promise<{ kind: 'slow' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'slow' }), raceAfterMs); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const good = (r: ApiResult<T>) => r.ok || r.kind !== 'network';
    if (early.kind === 'direct' && good(early.r)) { directEverOk = true; setMode('direct'); return early.r; }
    if (early.kind === 'slow') { try { deps.onSlowDirect?.(); } catch { /* 驱动那边抛不该拦住这条请求 */ } }
    // 直连慢(或者已经失败了):房间那条现在就开始。
    let roomHeld = false;
    let directWon = false;
    const release = () => { try { deps.onBackToDirect?.(); } catch { /* 放不掉不拦 */ } };
    const roomP = (async (): Promise<ApiResult<T> | { ok: false, status: 0, kind: 'network', error: string }> => {
      const remote = await deps.remote();
      if (!remote.ok) return { ok: false, status: 0, kind: 'network', error: remote.error };
      roomHeld = true;
      // 直连已经赢了:进房这一趟白走了,当场放掉,这一条也不在房间里再问一遍。
      if (directWon) { release(); return { ok: false, status: 0, kind: 'network', error: '直连已经通了' }; }
      return run(remote.client, options);
    })();
    return await new Promise<ApiResult<T>>((resolve) => {
      let settled = false;
      let directFail: ApiResult<T> | undefined = early.kind === 'direct' ? early.r : undefined;
      let roomFail: ApiResult<T> | undefined;
      const tryFail = () => {
        if (settled || directFail === undefined || roomFail === undefined) return;
        settled = true;
        setMode('offline');
        resolve(directFail);
      };
      if (early.kind === 'slow') {
        void directP.then((r) => {
          if (settled) return;
          if (good(r)) {
            settled = true;
            directWon = true;
            directEverOk = true;
            setMode('direct');
            // 房间那条已经进了的话当场放掉(还没进上的,进上那一刻自己放)。
            if (roomHeld) release();
            resolve(r);
            return;
          }
          directFail = r;
          tryFail();
        });
      }
      void roomP.then((r) => {
        if (settled) return;
        if (good(r as ApiResult<T>)) { settled = true; setMode('remote'); resolve(r as ApiResult<T>); return; }
        roomFail = r as ApiResult<T>;
        tryFail();
      });
    });
  }

  /** 驱动说不在家:只走房间。 */
  async function roomOnly<T>(
    run: (client: ApiClient, options: RequestOptions) => Promise<ApiResult<T>>,
    options: RequestOptions,
  ): Promise<ApiResult<T>> {
    const remote = await deps.remote();
    if (!remote.ok) { setMode('offline'); return { ok: false, status: 0, kind: 'network', error: remote.error }; }
    const result = await run(remote.client, options);
    setMode(result.ok || result.kind !== 'network' ? 'remote' : 'offline');
    return result;
  }

  /** 上一拍驱动给的直连地址:换了地址(Mac 换了 IP、换了一台)就当没确认过,重新试探。 */
  let lastBase: string | null | undefined;

  async function route<T>(
    run: (client: ApiClient, options: RequestOptions) => Promise<ApiResult<T>>,
    options: RequestOptions,
  ): Promise<ApiResult<T>> {
    if (deps.directBase !== undefined) {
      if (!deps.directBase().settled) await deps.settled?.().catch(() => {});
      const base = deps.directBase().url;
      if (base !== lastBase) { lastBase = base; directEverOk = false; lastDirectTry = 0; }
      if (base === null) return roomOnly(run, options);
    }
    const raced = await race(run, options);
    if (raced !== undefined) return raced;
    let directFailure: Extract<ApiResult<T>, { ok: false }> | undefined;
    if (shouldTryDirect(options)) {
      lastDirectTry = now();
      const result = await runDirect(run, options);
      // 工作台答了(哪怕答的是 401 / 503)就用它的答复:换条路问也是同一句。
      if (result.ok || result.kind !== 'network') { directEverOk = true; setMode('direct'); return result; }
      directFailure = result;
    }

    const remote = await deps.remote();
    if (!remote.ok) {
      setMode('offline');
      // 直连那句话说得最具体(同不同网、开没开局域网访问),优先转达它;
      // 没试过直连(还在远程模式的间歇里)才说房间那句。
      return directFailure ?? { ok: false, status: 0, kind: 'network', error: remote.error };
    }
    const result = await run(remote.client, options);
    if (result.ok || result.kind !== 'network') { setMode('remote'); return result; }
    setMode('offline');
    return directFailure ?? result;
  }

  return {
    get baseUrl() { return deps.direct.baseUrl; },
    mode: () => mode,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // 会改东西的那几条在这里盖请求号(clientKey.ts):直连断了改走房间,两下带的是同一个号,电脑只办一次。
    json<T>(path: string, options: RequestOptions = {}) {
      return route<T>((client, opts) => client.json<T>(path, opts), stampClientKey(path, options));
    },
    blob(path: string, options: RequestOptions = {}) {
      return route<Blob>((client, opts) => client.blob(path, opts), stampClientKey(path, options));
    },
  };
}
