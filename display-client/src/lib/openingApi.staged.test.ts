import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeOpeningMessages,
  scheduleStagedMessages,
  OPENING_MESSAGE_INTERVAL_MS,
  type OpeningMessage,
  type OpeningTriggerResult,
} from './openingApi.ts';

function msg(id: string, content: string, sequence?: number): OpeningMessage {
  return { id, content, role: 'assistant', type: 'text', meta: 'opening', createdAt: 1, sequence };
}

describe('normalizeOpeningMessages', () => {
  it('prefers messages[] and sorts by sequence', () => {
    const result: OpeningTriggerResult = {
      should_send: true,
      messages: [msg('c', '第三条', 2), msg('a', '第一条', 0), msg('b', '第二条', 1)],
    };
    const out = normalizeOpeningMessages(result);
    expect(out.map((m) => m.content)).toEqual(['第一条', '第二条', '第三条']);
  });

  it('wraps a legacy single message into a one-element array', () => {
    const result: OpeningTriggerResult = { should_send: true, message: msg('m1', 'hi') };
    const out = normalizeOpeningMessages(result);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('hi');
  });

  it('drops empty-content entries', () => {
    const result: OpeningTriggerResult = {
      should_send: true,
      messages: [msg('a', '  ', 0), msg('b', '有内容', 1)],
    };
    const out = normalizeOpeningMessages(result);
    expect(out.map((m) => m.content)).toEqual(['有内容']);
  });

  it('returns [] when should_send is false or nothing to send', () => {
    expect(normalizeOpeningMessages({ should_send: false, messages: [msg('a', 'x')] })).toEqual([]);
    expect(normalizeOpeningMessages({ should_send: true })).toEqual([]);
  });
});

describe('scheduleStagedMessages', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pushes first immediately then one per interval', () => {
    const pushed: string[] = [];
    scheduleStagedMessages([msg('a', 'A', 0), msg('b', 'B', 1), msg('c', 'C', 2)], (m) => pushed.push(m.content));

    // 第一条立即
    expect(pushed).toEqual(['A']);

    vi.advanceTimersByTime(OPENING_MESSAGE_INTERVAL_MS);
    expect(pushed).toEqual(['A', 'B']);

    vi.advanceTimersByTime(OPENING_MESSAGE_INTERVAL_MS);
    expect(pushed).toEqual(['A', 'B', 'C']);
  });

  it('cancel() stops subsequent pushes (user starts talking mid-opening)', () => {
    const pushed: string[] = [];
    const cancel = scheduleStagedMessages(
      [msg('a', 'A', 0), msg('b', 'B', 1), msg('c', 'C', 2)],
      (m) => pushed.push(m.content),
    );

    // 第一条已推，用户此时插话 → 取消后续
    expect(pushed).toEqual(['A']);
    cancel();

    vi.advanceTimersByTime(OPENING_MESSAGE_INTERVAL_MS * 5);
    expect(pushed).toEqual(['A']); // B/C 不再推
  });

  it('handles a single message with no pending timers', () => {
    const pushed: string[] = [];
    const cancel = scheduleStagedMessages([msg('a', 'A', 0)], (m) => pushed.push(m.content));
    expect(pushed).toEqual(['A']);
    expect(() => cancel()).not.toThrow();
  });
});
