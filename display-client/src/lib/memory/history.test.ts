import { describe, expect, it } from 'vitest';
import { buildHistoryForPrompt } from './history.ts';
import type { Chat, ChatSummary } from './types.ts';

function message(id: string, content = '.') {
  return { id, role: 'user' as const, content, type: 'text' as const };
}

function summary(overrides: Partial<ChatSummary> & { to_message_id: string; id: string }): ChatSummary {
  return {
    id: overrides.id,
    chat_id: 'c',
    from_message_id: overrides.from_message_id ?? overrides.to_message_id,
    to_message_id: overrides.to_message_id,
    bound_message_id: overrides.to_message_id,
    content: overrides.content ?? '旧摘要',
    token_count: overrides.token_count ?? 5,
    status: overrides.status ?? 'fresh',
    created_at: overrides.created_at ?? '2026-01-01',
  };
}

function makeChat(messages: ReturnType<typeof message>[], summaries: ChatSummary[]): Chat {
  return { id: 'c', messages, metadata: { summaries }, characterName: '角色' };
}

describe('buildHistoryForPrompt', () => {
  it('无摘要时返回全部近期消息', () => {
    const msgs = [message('m1', '你好'), message('m2', '你好呀')];
    const chat = makeChat(msgs, []);
    const result = buildHistoryForPrompt(chat);
    expect(result.summary).toBeUndefined();
    expect(result.recent).toHaveLength(2);
    expect(result.recent[0].id).toBe('m1');
  });

  it('游标有效：返回摘要 + 游标后的消息', () => {
    const msgs = [message('m1', 'a'), message('m2', 'b'), message('m3', 'c')];
    const s = summary({ id: 's1', to_message_id: 'm2', content: '摘要内容' });
    const chat = makeChat(msgs, [s]);
    const result = buildHistoryForPrompt(chat);
    expect(result.summary).toBe('摘要内容');
    // 跳过 m1/m2（已摘要），从 m3 开始
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0].id).toBe('m3');
  });

  it('游标失效——to_message_id 不在消息列表中 → 丢弃摘要', () => {
    // 模拟后台重置：消息被删除了，只有新发的消息
    const msgs = [message('n1', '新消息')];
    const s = summary({ id: 's1', to_message_id: 'old-msg-99', content: '旧角色的原始摘要' });
    const chat = makeChat(msgs, [s]);
    const result = buildHistoryForPrompt(chat);
    expect(result.summary).toBeUndefined();
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0].id).toBe('n1');
  });

  it('多条摘要时：跳过游标失效的，用最后一条有效的', () => {
    const msgs = [
      message('m1', 'a'), message('m2', 'b'), message('m3', 'c'),
      message('m4', 'd'), message('m5', 'e'),
    ];
    const freshValid = summary({ id: 's1', to_message_id: 'm2', content: '有效摘要', status: 'fresh' });
    const freshStale = summary({ id: 's2', to_message_id: 'deleted', content: '脏摘要', status: 'fresh' });
    const dirty = summary({ id: 's3', to_message_id: 'm3', content: 'dirty摘要', status: 'dirty' });
    const chat = makeChat(msgs, [freshValid, freshStale, dirty]);
    const result = buildHistoryForPrompt(chat);
    // 跳过 stale（无效）+ dirty，只用 freshValid；游标 m2 之后 = m3/m4/m5
    expect(result.summary).toBe('有效摘要');
    expect(result.recent.map((m) => m.id)).toEqual(['m3', 'm4', 'm5']);
  });

  it('所有有效摘要的游标都失效 → 无摘要，返回全部', () => {
    const msgs = [message('n1', 'a'), message('n2', 'b')];
    const cheap = summary({ id: 's1', to_message_id: 'gone-1', content: '脏1', token_count: 1 });
    const chat = makeChat(msgs, [cheap]);
    const result = buildHistoryForPrompt(chat);
    expect(result.summary).toBeUndefined();
    expect(result.recent).toHaveLength(2);
  });
});
