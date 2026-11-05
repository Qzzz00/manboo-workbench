import { MEMORY_CONFIG } from '../../config/memory.ts';
import type { Chat, ChatSummary } from './types.ts';
import { estimateTokens } from './tokenEstimator.ts';
import { saveChatMetadata } from './store.ts';
import { fetchChatCompletion } from '../llm.ts';

function latestFresh(chat: Chat): ChatSummary | undefined {
  for (let i = chat.metadata.summaries.length - 1; i >= 0; i--) {
    const s = chat.metadata.summaries[i];
    if (s.status !== 'fresh') continue;
    // 游标失效（服务端历史被重置/删除）→ 旧摘要内容不可信，
    // 跳过（不把旧设定的事当成 prevSummary 重新总结回来）
    if (findMsgIndex(chat, s.to_message_id) === -1) continue;
    return s;
  }
  return undefined;
}

function findMsgIndex(chat: Chat, messageId: string): number {
  return chat.messages.findIndex((m) => m.id === messageId);
}

export function buildSummaryPrompt(
  previousSummary: string | undefined,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  charName = '角色',
  userName = '用户',
): string {
  const lines = messages.map((m) => {
    const label = m.role === 'user' ? userName : charName;
    return `${label}：${m.content}`;
  });

  const parts = [
    `你是对话摘要助手。请将下面这段${charName}和${userName}的对话压缩成一段不超过 200 字的摘要。`,
    '保留：用户透露的事实（姓名/职业/偏好/经历）、情感走向、约定的事项。',
    '忽略：客套话、寒暄、重复信息。',
  ];

  if (previousSummary) {
    parts.push(`此前摘要：\n${previousSummary}`);
  }

  parts.push(`待压缩的消息：\n${lines.join('\n')}`);
  parts.push('请直接输出摘要正文，不要任何前缀或解释。');

  return parts.join('\n\n');
}

function appendSummary(chat: Chat, summary: Omit<ChatSummary, 'id' | 'chat_id'>): void {
  const full: ChatSummary = {
    ...summary,
    id: crypto.randomUUID(),
    chat_id: chat.id,
  };
  chat.metadata.summaries.push(full);
  saveChatMetadata(chat.id, chat.metadata);
}

/**
 * 异步触发摘要生成。失败时降级为「无摘要」继续走，不抛异常。
 */
export async function maybeSummarize(chat: Chat): Promise<void> {
  try {
    const summaries = chat.metadata.summaries;
    const activeSummary = latestFresh(chat);
    const cursorMsgId = activeSummary?.to_message_id;

    const newSince = cursorMsgId
      ? chat.messages.slice(findMsgIndex(chat, cursorMsgId) + 1)
      : [...chat.messages];

    if (newSince.length < MEMORY_CONFIG.SUMMARY_THRESHOLD) return;

    const toSummarize = newSince.slice(0, -MEMORY_CONFIG.KEEP_RECENT);
    if (toSummarize.length === 0) return;

    // 如果最新的 activeSummary 是 dirty，我们需要重新生成覆盖该 dirty 摘要及其后的内容
    // 简化处理：找到最老的 dirty 摘要，从它前面开始重新摘要
    const firstDirtyIndex = summaries.findIndex((s) => s.status === 'dirty');
    let effectivePrevSummary: string | undefined;
    let effectiveToSummarize = toSummarize;

    if (firstDirtyIndex >= 0) {
      // 找到 dirty 链的起点：prev_summary_id 链上最早的 dirty 前缀
      // 为了简化，我们直接用 activeSummary（如果是 dirty 则忽略其内容）
      // 或者用 dirty 之前最新的 fresh 摘要
      const prevFresh = summaries
        .slice(0, firstDirtyIndex)
        .reverse()
        .find((s) => s.status === 'fresh');
      effectivePrevSummary = prevFresh?.content;

      // 重新计算待摘要范围：从 prevFresh 的 to_message 之后到保留区之前
      if (prevFresh) {
        const startIdx = findMsgIndex(chat, prevFresh.to_message_id) + 1;
        effectiveToSummarize = chat.messages.slice(startIdx, startIdx + toSummarize.length);
      } else {
        effectiveToSummarize = newSince.slice(0, -MEMORY_CONFIG.KEEP_RECENT);
      }

      // 移除 dirty 摘要（它们将被重新生成的摘要替代）
      chat.metadata.summaries = summaries.filter((s) => s.status !== 'dirty');
    }

    const prompt = buildSummaryPrompt(
      effectivePrevSummary ?? activeSummary?.content,
      effectiveToSummarize,
      chat.characterName,
      chat.userName,
    );

    const summaryText = await fetchChatCompletion(
      [{ role: 'user', content: prompt }],
      0.7,
      undefined,
      MEMORY_CONFIG.SUMMARY_TOKEN_BUDGET,
    );

    const trimmed = summaryText.trim();
    if (!trimmed) return;

    appendSummary(chat, {
      from_message_id: effectiveToSummarize[0].id,
      to_message_id: effectiveToSummarize[effectiveToSummarize.length - 1].id,
      bound_message_id: effectiveToSummarize[effectiveToSummarize.length - 1].id,
      content: trimmed,
      token_count: estimateTokens(trimmed),
      status: 'fresh',
      created_at: new Date().toISOString(),
      prev_summary_id: activeSummary?.id,
    });
  } catch (error) {
    console.warn('[memory] summarize failed, degrading to no summary', error);
    // 降级：不抛异常，不破坏对话流
  }
}
