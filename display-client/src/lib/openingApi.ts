import { apiGet, apiPatch } from './apiClient.ts';
import type { Emotion } from './emotion.ts';

export type OpeningConfig = {
  enabled: boolean;
  text: string;
};

export type OpeningMessage = {
  id: string;
  content: string;
  role: 'assistant';
  type: 'text';
  meta: string;
  createdAt: number;
  // 开场情绪在「开场生成」阶段一并解算（新引擎 LLM JSON / legacy 启发式），交客户端 AU solver。
  emotion?: Emotion;
  intensity?: number;
  // 多条开场按 sequence 排序后逐条推送；老服务端/legacy 单条时可能缺省。
  sequence?: number;
};

export type OpeningTriggerResult = {
  should_send: boolean;
  // 新服务端返回 2~4 条短消息数组；老服务端/legacy 仍只返回单条 message。
  messages?: OpeningMessage[];
  // 保留旧字段（= messages[0]），兼容只读旧字段的调用方。
  message?: OpeningMessage;
};

// 开场多条之间的推送间隔（模仿真人"啪啪啪连发"）：第一条立即，之后每 +1000ms 推一条。
export const OPENING_MESSAGE_INTERVAL_MS = 1000;

// 把 trigger 返回值规整成有序的开场消息数组：
// 优先 messages；只有老服务端的 message 时 wrap 成 [message]；按 sequence 稳定排序；
// 丢掉空内容的条目。返回 [] 表示无可推送内容（调用方什么都不推）。
export function normalizeOpeningMessages(result: OpeningTriggerResult): OpeningMessage[] {
  if (!result || !result.should_send) return [];
  const raw =
    Array.isArray(result.messages) && result.messages.length
      ? result.messages
      : result.message
        ? [result.message]
        : [];
  return raw
    .filter((m): m is OpeningMessage => !!m && typeof m.content === 'string' && m.content.trim().length > 0)
    .slice()
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

// 按 OPENING_MESSAGE_INTERVAL_MS 间隔逐条 push：第一条立即，第 i 条延迟 i*interval。
// 返回 cancel()：清掉尚未触发的后续条（已 push 的不回收），用于「用户中途插话/切角色」时止推。
export function scheduleStagedMessages(
  messages: OpeningMessage[],
  push: (message: OpeningMessage) => void,
  intervalMs: number = OPENING_MESSAGE_INTERVAL_MS,
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  messages.forEach((message, i) => {
    if (i === 0) {
      push(message); // 第一条立即
      return;
    }
    timers.push(setTimeout(() => push(message), i * intervalMs));
  });
  return () => {
    while (timers.length) clearTimeout(timers.pop());
  };
}

export async function fetchOpeningConfig(avatarId: string): Promise<OpeningConfig> {
  const data = (await apiGet(`/api/characters/${encodeURIComponent(avatarId)}/opening`)) as OpeningConfig;
  return data;
}

export async function patchOpeningConfig(
  avatarId: string,
  patch: Partial<OpeningConfig>,
): Promise<OpeningConfig> {
  const data = (await apiPatch(`/api/characters/${encodeURIComponent(avatarId)}/opening`, patch)) as OpeningConfig;
  return data;
}

export async function triggerOpening(sessionId: string): Promise<OpeningTriggerResult> {
  const data = (await apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/opening`)) as OpeningTriggerResult;
  return data;
}
