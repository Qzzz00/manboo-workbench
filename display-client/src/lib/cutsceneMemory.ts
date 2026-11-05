import { apiGet } from './apiClient.ts';

export interface MemoryEvent {
  title: string;
  summary: string;
  origin?: string;
  createdAt?: number;
}

// 把近期共同经历（含已看演出消化出的事件）拼成一小段 prompt 上下文，
// 让角色能在日常对话里自然提起「上次那件事」。放进 chat_summary，不改渲染器。
export function formatMemoriesForPrompt(events: MemoryEvent[]): string {
  const items = (events || []).filter((e) => e && (e.summary || e.title));
  if (!items.length) return '';
  const lines = items.slice(0, 5).map((e) => `- ${e.title ? e.title + '：' : ''}${e.summary || ''}`.trim());
  return ['【近期共同经历（可在合适时自然提起，别生硬复述）】', ...lines].join('\n');
}

const cache = new Map<string, { at: number; block: string }>();

// 带 60s 缓存的拉取，避免每条消息都请求；失败静默降级到旧缓存/空串（绝不让上下文报错）。
export async function getRecentMemoriesBlock(avatarId: string, maxAgeMs = 60_000): Promise<string> {
  const hit = cache.get(avatarId);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.block;
  try {
    const data = (await apiGet(`/api/sessions/${encodeURIComponent(avatarId)}/memory-events`)) as { events: MemoryEvent[] };
    const block = formatMemoriesForPrompt(data.events || []);
    cache.set(avatarId, { at: Date.now(), block });
    return block;
  } catch {
    return hit ? hit.block : '';
  }
}
