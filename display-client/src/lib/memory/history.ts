import { MEMORY_CONFIG } from '../../config/memory.ts';
import type { ChatMessage } from '../llm.ts';
import type { Chat } from './types.ts';
import { estimateTokens } from './tokenEstimator.ts';

function latestFresh(chat: Chat) {
  for (let i = chat.metadata.summaries.length - 1; i >= 0; i--) {
    const s = chat.metadata.summaries[i];
    if (s.status !== 'fresh') continue;
    // 游标失效（服务端历史被重置/删除，to_message_id 已不在消息列表里）
    // → 摘要内容不再可信（可能带着上一个设定的旧事），整条跳过
    if (findMsgIndex(chat, s.to_message_id) === -1) continue;
    return s;
  }
  return undefined;
}

function findMsgIndex(chat: Chat, messageId: string): number {
  return chat.messages.findIndex((m) => m.id === messageId);
}

/**
 * 根据 token 预算构造用于 prompt 的历史消息列表。
 * 返回 { summary?: string; recent: Message[] }，其中 recent 按时间升序。
 */
export function buildHistoryForPrompt(chat: Chat): {
  summary?: string;
  recent: ChatMessage[];
} {
  const activeSummary = latestFresh(chat);
  let remaining = MEMORY_CONFIG.HISTORY_TOKEN_BUDGET - (activeSummary?.token_count ?? 0);

  const result: ChatMessage[] = [];

  // 从最新消息往前遍历，跳过已被摘要覆盖的消息
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (activeSummary) {
      const cursorIdx = findMsgIndex(chat, activeSummary.to_message_id);
      if (cursorIdx >= 0 && i <= cursorIdx) break;
    }
    const t = estimateTokens(m.content);
    if (t > remaining) break;
    result.unshift(m);
    remaining -= t;
  }

  return { summary: activeSummary?.content, recent: result };
}
