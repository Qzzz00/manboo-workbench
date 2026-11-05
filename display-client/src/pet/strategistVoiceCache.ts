// 固定短句的语音缓存：开场白与「等我看看」垫词。
//
// ★为什么是「首次合成即缓存」而不是构建期烤成 assets：/ai/tts 按 avatarId 查音色绑定，
// 底条角色是可切换的（三只）——烤死的那份一换角色就对不上，招呼是 A 的声音、回答是 B 的。
// 缓存以 (avatarId, 文本) 为键，音色永远跟着当前角色走。
//
// ★底条一起来就**预热**：垫词的全部意义是「立刻有声音」，等用词的时候才合成就晚了
// （一次往返 1-2 秒，正好是它要填的那个空档）。预热是 fire-and-forget，失败无所谓。
//
// 存 localStorage：一句 mp3 约 30-40KB，四句合计 ~160KB，远在配额内。

import { tts, type AibooEndpoint } from '../lib/strategist/strategistClient.ts';

const KEY = 'aiboo:strategist-voice-cache';

/** 开场白：F10 呼出底条时角色主动说这句，它本身就是「可以问了」的提示。 */
export const GREETING = '怎么啦，需要我帮忙吗？';

/** 思考时的垫词，随机挑一句 —— 固定一句听多了会腻。 */
export const FILLERS = ['我看看啊…', '让我瞅瞅…', '稍等，我看看画面…'];

export const CACHED_LINES = [GREETING, ...FILLERS];

type Clip = { audioBase64: string; mime: string };
type CacheShape = Record<string, Clip>;

function keyOf(avatarId: string, text: string): string {
  return `${avatarId}|${text}`;
}

function readAll(): CacheShape {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as CacheShape;
  } catch {
    return {};
  }
}

export function getCached(avatarId: string, text: string): Clip | null {
  return readAll()[keyOf(avatarId, text)] ?? null;
}

function put(avatarId: string, text: string, clip: Clip): void {
  try {
    const all = readAll();
    all[keyOf(avatarId, text)] = clip;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 配额满/存储不可用：本次会话内仍能用（调用方拿到的是刚合成的那份），不影响功能。
  }
}

/**
 * 预热缓存。已缓存的跳过，不重复花钱。
 * 串行而不是并发：这是后台预热，没必要为了快一点同时开四条 TTS 请求跟前台抢带宽。
 */
export async function warmVoiceCache(
  ep: () => AibooEndpoint,
  avatarId: string,
  opts?: { ttsImpl?: typeof tts },
): Promise<void> {
  const synth = opts?.ttsImpl ?? tts;
  for (const text of CACHED_LINES) {
    if (getCached(avatarId, text)) continue;
    try {
      put(avatarId, text, await synth(ep(), { text, avatarId }));
    } catch {
      // 预热失败不该有任何可见后果：用词的时候没缓存就现合成，再不行就只显示文字。
      return;
    }
  }
}

/** 随机挑一句已缓存的垫词；一句都没有就返回 null（调用方跳过播报即可）。 */
export function pickFiller(avatarId: string, rnd: () => number = Math.random): Clip | null {
  const ready = FILLERS.map((t) => getCached(avatarId, t)).filter((c): c is Clip => !!c);
  if (!ready.length) return null;
  return ready[Math.floor(rnd() * ready.length) % ready.length];
}
