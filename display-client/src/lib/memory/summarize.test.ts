import { describe, expect, it, vi } from 'vitest';
import type { Chat, ChatSummary } from './types.ts';

// 截获 maybeSummarize 调用的 fetchChatCompletion 的 prompt
let lastCompletionPrompt = '';

vi.mock('../llm.ts', () => ({
  fetchChatCompletion: vi.fn(async (msgs: Array<{ role: string; content: string }>) => {
    lastCompletionPrompt = msgs[0]?.content ?? '';
    return '新摘要内容';
  }),
}));

vi.mock('./store.ts', () => ({
  saveChatMetadata: vi.fn(),
}));

import { maybeSummarize } from './summarize.ts';

function message(id: string, role: 'user' | 'assistant' = 'user', content = '你好') {
  return { id, role, content, type: 'text' as const };
}

function freshSummary(overrides: Partial<ChatSummary> & { id: string; to_message_id: string }): ChatSummary {
  return {
    id: overrides.id,
    chat_id: 'c',
    from_message_id: overrides.from_message_id ?? overrides.to_message_id,
    to_message_id: overrides.to_message_id,
    bound_message_id: overrides.to_message_id,
    content: overrides.content ?? '旧摘要',
    token_count: 10,
    status: 'fresh',
    created_at: '2026-01-01',
  };
}

function makeChat(messages: ReturnType<typeof message>[], summaries: ChatSummary[]): Chat {
  return { id: 'c', messages, metadata: { summaries }, characterName: '白夜凛', userName: '用户' };
}

// 摘要阈值: 20 条触发，保留最近 6 条不摘要 → 至少 27 条才能走到 fetchChatCompletion
// (27 - 6 = 21 → ≥ 20 threshold)
// 每条消息 token_count 设为 0，不走 token 预算限制
function makeMany(n: number): ReturnType<typeof message>[] {
  return Array.from({ length: n }, (_, i) =>
    message(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`),
  );
}

describe('maybeSummarize 游标自愈', () => {
  it('游标失效时不把旧摘要内容作为 previousSummary 传给 LLM', async () => {
    lastCompletionPrompt = '';
    const freshStale = freshSummary({
      id: 's-stale',
      to_message_id: 'GONE-DELETED-BY-MEMORY-RESET',
      content: '白夜凛为毕业作品发愁只剩28天室友录完demo',
    });
    const msgs = makeMany(27);
    const chat = makeChat(msgs, [freshStale]);
    await maybeSummarize(chat);
    // 游标失效 → activeSummary undefined → prevSummary 为空，
    // 旧摘要"毕业作品发愁"不应出现在 prompt 里
    expect(lastCompletionPrompt).not.toContain('毕业');
    expect(lastCompletionPrompt).not.toContain('demo');
    // 应该以当前消息为基础生成新摘要，不含"此前摘要"段
    expect(lastCompletionPrompt).not.toContain('此前摘要');
    // 新摘要应该基于有效消息
    expect(lastCompletionPrompt).toContain('msg 0');
  });

  it('游标有效时正常把旧摘要作为 previousSummary', async () => {
    lastCompletionPrompt = '';
    const msgs = makeMany(33);
    // 游标指向 m7（索引 7），newSince = [8..32] = 25 ≥ 20 threshold
    const freshValid = freshSummary({ id: 's-valid', to_message_id: 'm7', content: '一段正常的滚动摘要' });
    const chat = makeChat(msgs, [freshValid]);
    await maybeSummarize(chat);
    // effectivePrevSummary = 有效摘要的内容 → 出现在 prompt 的"此前摘要"段
    expect(lastCompletionPrompt).toContain('此前摘要');
    expect(lastCompletionPrompt).toContain('一段正常的滚动摘要');
    // 待摘要消息应该从 m7 之后开始（游标 +1 → m8）
    expect(lastCompletionPrompt).toContain('msg 8');
  });

  it('消息不足阈值时不触发摘要', async () => {
    lastCompletionPrompt = '';
    const freshStale = freshSummary({ id: 's', to_message_id: 'GONE', content: '旧' });
    const chat = makeChat(makeMany(10), [freshStale]);
    await maybeSummarize(chat);
    // 未调用 LLM → lastCompletionPrompt 仍为空
    expect(lastCompletionPrompt).toBe('');
  });
});
