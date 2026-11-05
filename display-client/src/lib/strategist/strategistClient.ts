// 掌机军师服务端（strategist/server）的设备侧客户端。
//
// 契约见 strategist/docs/军师Agent开发文档v1.0.md §7：
//   POST /v1/packs/resolve  ROM 文件名 → 知识包
//   POST /v1/sessions       建会话
//   POST /v1/chat           SSE 流式对话（meta/delta/action/sources/done/error）
//
// ★所有函数接受注入的 fetchImpl：这份代码同时跑在底条 overlay WebView（pet.localhost）
// 与主 App 里，两处都没有统一的 http 客户端，注入是唯一能单测的形状。
// SSE 切帧复用 src/lib/journeySse.ts 的 parseSseChunk（已有实现 + 已有测试，不重写）。

import { parseSseChunk } from '../journeySse.ts';

export type StrategistEndpoint = { baseUrl: string; deviceToken: string };

export type ResolveResult = {
  matched: boolean;
  match_by?: string;
  pack_id?: string;
  game_title?: string;
  confidence?: string;
  candidates?: { pack_id: string; game_title: string; score: number }[];
};

export type ChatMeta = {
  intent: string;
  pack_id: string | null;
  confidence: string | null;
  fallback_used: boolean;
};

export type ChatSource = { type: string; ref?: string; chapter?: string; url?: string };

export type ChatHandlers = {
  onMeta: (m: ChatMeta) => void;
  onDelta: (text: string) => void;
  onAction: (emotion: string) => void;
  onSources: (items: ChatSource[]) => void;
  onDone: (latencyMs: number) => void;
  /** code 形如 HTTP_401 / UPSTREAM_TIMEOUT / STREAM_TRUNCATED / NETWORK。 */
  onError: (code: string, message?: string) => void;
};

export type ChatRequest = {
  sessionId: string;
  message: string;
  quickAction?: 'stuck';
  screenshotBase64?: string;
  /** 底条那只角色的人设——军师据它决定说话的口吻（见 pet/strategistCharacter.ts）。 */
  character?: string;
};

type Opts = { fetchImpl?: typeof fetch };

function headers(ep: StrategistEndpoint): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Device-Token': ep.deviceToken };
}

async function postJson<T>(
  ep: StrategistEndpoint,
  path: string,
  body: unknown,
  opts?: Opts,
): Promise<T> {
  const f = opts?.fetchImpl ?? fetch;
  const resp = await f(`${ep.baseUrl}${path}`, {
    method: 'POST',
    headers: headers(ep),
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP_${resp.status}`);
  return (await resp.json()) as T;
}

export async function resolvePack(
  ep: StrategistEndpoint,
  romFilename: string,
  opts?: Opts,
): Promise<ResolveResult> {
  return postJson<ResolveResult>(ep, '/v1/packs/resolve', { rom_filename: romFilename }, opts);
}

export async function createSession(
  ep: StrategistEndpoint,
  p: { deviceId: string; packId: string | null; romFilename: string },
  opts?: Opts,
): Promise<string> {
  const r = await postJson<{ session_id: string }>(
    ep,
    '/v1/sessions',
    { device_id: p.deviceId, pack_id: p.packId, rom_filename: p.romFilename },
    opts,
  );
  return r.session_id;
}

export type SaveStateApplied = {
  applied: boolean;
  reason?: string;
  player_state?: Record<string, unknown>;
};

/**
 * 上传玩家的 RetroArch 存档，让军师知道「他现在打到哪」。
 *
 * ★传原始存档而不是掌机自己解析好的结果：解析要用知识包里的 ROM 推导表
 * （徽章旗标基址、地图号→地名…），那些表在服务端。掌机自己解得先把表下下来，
 * 等于把同一份逻辑再实现一遍 Kotlin 版——两份实现迟早漂。
 *
 * ★调用方**必须 await 完再发问**：这一轮问答要用的就是这份进度，
 * 边传边问的话第一句会按上一次的进度回答。
 */
export async function uploadSaveState(
  ep: StrategistEndpoint,
  sessionId: string,
  p: { saveBase64: string; savedAtMs?: number },
  opts?: Opts,
): Promise<SaveStateApplied> {
  return postJson<SaveStateApplied>(
    ep,
    `/v1/sessions/${sessionId}/save-state`,
    { save_base64: p.saveBase64, saved_at_ms: p.savedAtMs ?? null },
    opts,
  );
}

/**
 * 语音端点走的是 **Aiboo 后台**（阿里云），不是军师服务端。
 *
 * ★为什么：Aiboo 后台早就有 `/ai/asr` 与 `/ai/tts` 在生产跑，凭证也配好了，
 * 而且 `/ai/tts` 会按 avatarId 查音色绑定 —— 底条那只角色说话就是**她自己的声音**。
 * 我一度在军师服务端把火山那两套协议重写了一遍（200 行二进制帧），是纯粹的重复
 * 开发且更差，已删除。
 * ★附带好处：阿里云是公网可达的，语音这条即使掌机没插 USB 也能用。
 */
export type AibooEndpoint = {
  baseUrl: string;
  /** Aiboo 用户 JWT 或设备 token —— 两种都支持，见 aibooHeaders。 */
  token: string;
  /** 内测模式的设备绑定校验要这个头。 */
  deviceId?: string;
};

/**
 * ★两个头都发，因为服务端 `middleware/deviceOrUserAuth.cjs` 是二选一的：
 * 它**只从 `X-Device-Token` 读设备 token**，不匹配才落回 userAuth 去验
 * `Authorization: Bearer` 里的用户 JWT。
 *
 * 只发 Bearer 曾让掌机所有语音请求 401（真机报「token 不对」）：设备 token 被
 * 当成 JWT 去验，必然 `Invalid token`。而 M2 的部署自检是 curl 带 `x-device-token`
 * 发的——服务端那侧验过了，客户端真实发法从来没验过，两边就这么错开了。
 *
 * 两个都发即两种凭证都能用：是设备 token 就走设备分支，是用户 JWT 就
 * `X-Device-Token` 对不上、自然落回 userAuth。
 */
function aibooHeaders(ep: AibooEndpoint): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ep.token}`,
    'X-Device-Token': ep.token,
  };
  if (ep.deviceId) h['X-Device-Id'] = ep.deviceId;
  return h;
}

/**
 * 语音识别：16k 单声道 PCM（base64）→ 文本。
 *
 * ★`hotwords` 是**游戏专属**专有名词（精灵名/地名/馆主名），由 `hotwords()` 从
 * 军师服务端按当前会话取。不传也照常工作，只是回到「只有通用词」的老样子。
 * 为什么必须传：军师那边的同音纠错按设计只改拼音**完全相同**的词，
 * 「鬼斯通」被听成「韦斯通」它救不回来（guǐ ≠ wéi），只能靠热词让 ASR 别听错。
 */
export async function asr(
  ep: AibooEndpoint,
  p: { pcmBase64: string; sampleRate: number; hotwords?: string[] },
  opts?: Opts,
): Promise<string> {
  const f = opts?.fetchImpl ?? fetch;
  const resp = await f(`${ep.baseUrl}/ai/asr`, {
    method: 'POST',
    headers: aibooHeaders(ep),
    body: JSON.stringify({
      audio: p.pcmBase64,
      sample_rate: p.sampleRate,
      ...(p.hotwords?.length ? { hotwords: p.hotwords } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`HTTP_${resp.status}`);
  return ((await resp.json()) as { text: string }).text;
}

/**
 * 这一刻该喂给 ASR 的专有名词（军师服务端按会话选，见 chat/hotwords.py）。
 *
 * ★调用时机：**上一轮答完之后**取、存起来给下一次按住说话用。它是「下一句会说
 * 什么」的先验，提前算得出来；挂在按住说话的关键路径上只会白加一个往返。
 * 取不到就返回空数组——热词是纯增量，缺了只是回到现状，不该让语音这条挂掉。
 */
export async function hotwords(
  ep: StrategistEndpoint,
  sessionId: string,
  opts?: Opts,
): Promise<string[]> {
  const f = opts?.fetchImpl ?? fetch;
  try {
    const resp = await f(`${ep.baseUrl}/v1/sessions/${sessionId}/hotwords`, {
      headers: headers(ep),
    });
    if (!resp.ok) return [];
    const body = (await resp.json()) as { hotwords?: string[] };
    return Array.isArray(body.hotwords) ? body.hotwords : [];
  } catch {
    return [];
  }
}

/**
 * 语音合成：一句文本 → 一段可直接喂 <audio> 的音频。
 * ★传 avatarId：后端据它查音色绑定，底条角色说话才是她自己的声音。
 * ★返回的是**音频字节流**（不是 JSON），所以走 blob → data URI。
 */
export async function tts(
  ep: AibooEndpoint,
  p: { text: string; avatarId?: string },
  opts?: Opts,
): Promise<{ audioBase64: string; mime: string }> {
  const f = opts?.fetchImpl ?? fetch;
  const resp = await f(`${ep.baseUrl}/ai/tts`, {
    method: 'POST',
    headers: aibooHeaders(ep),
    body: JSON.stringify({ text: p.text, avatarId: p.avatarId }),
  });
  if (!resp.ok) throw new Error(`HTTP_${resp.status}`);
  const mime = resp.headers.get('content-type') || 'audio/mpeg';
  const buf = new Uint8Array(await resp.arrayBuffer());
  // 分块转 base64：一次 fromCharCode(...buf) 在几百 KB 音频上会 RangeError 爆栈。
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return { audioBase64: btoa(bin), mime };
}

/**
 * SSE 流式对话。返回 abort 句柄——用户再点一下角色要能打断上一轮。
 *
 * ★刻意不做自动重试：一键卡关的截图是「按下那一刻」的画面，重试时画面早变了，
 * 重发旧图只会给出对不上现状的建议。失败就报错，让用户自己再按一次。
 */
export function chatStream(
  ep: StrategistEndpoint,
  req: ChatRequest,
  h: ChatHandlers,
  opts?: Opts,
): { abort: () => void } {
  const f = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  let finished = false;
  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    fn();
  };

  void (async () => {
    try {
      const resp = await f(`${ep.baseUrl}/v1/chat`, {
        method: 'POST',
        headers: headers(ep),
        signal: controller.signal,
        body: JSON.stringify({
          session_id: req.sessionId,
          message: req.message,
          quick_action: req.quickAction ?? null,
          screenshot_base64: req.screenshotBase64 ?? null,
          character: req.character || null,
        }),
      });
      if (!resp.ok || !resp.body) {
        finish(() => h.onError(`HTTP_${resp.status}`));
        return;
      }
      const reader = resp.body.getReader();
      // abort 时把读端也取消掉，否则挂着的流会一直占着连接。
      controller.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}));
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const e of events) {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(e.data) as Record<string, unknown>;
          } catch {
            // 非 JSON 帧（keepalive 注释已被 parseSseChunk 过滤）直接跳过
            continue;
          }
          switch (e.event) {
            case 'meta':
              h.onMeta(data as unknown as ChatMeta);
              break;
            case 'delta':
              h.onDelta(String(data.text ?? ''));
              break;
            case 'action':
              h.onAction(String(data.emotion ?? 'idle'));
              break;
            case 'sources':
              h.onSources((data.items as ChatSource[]) ?? []);
              break;
            case 'done':
              finish(() => h.onDone(Number(data.latency_ms ?? 0)));
              break;
            case 'error':
              finish(() => h.onError(String(data.code ?? 'UNKNOWN'), String(data.message ?? '')));
              break;
            default:
              break;
          }
        }
      }
      // 流结束了却没收到 done/error：当成网络中断。不报的话 UI 会永远停在「想想…」。
      if (controller.signal.aborted) {
        finished = true;
        return;
      }
      finish(() => h.onError('STREAM_TRUNCATED'));
    } catch (e) {
      // 用户主动打断不是错误，不该冒出 error 回调去污染 UI。
      if (controller.signal.aborted) {
        finished = true;
        return;
      }
      finish(() => h.onError('NETWORK', String((e as { message?: string })?.message ?? e)));
    }
  })();

  return { abort: () => controller.abort() };
}
