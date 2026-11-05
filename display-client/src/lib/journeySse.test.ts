import { describe, it, expect, vi } from 'vitest';
import { parseSseChunk, connectJourneyStream } from './journeySse.ts';

describe('parseSseChunk', () => {
  it('parses complete frames and keeps incomplete remainder', () => {
    const input = 'event: proactive\ndata: {"content":"hi"}\n\nevent: life_signs\ndata: {"state_id":"s"}\n\nevent: partial\ndata: {"x":1}';
    const { events, rest } = parseSseChunk(input);
    expect(events).toEqual([
      { event: 'proactive', data: '{"content":"hi"}' },
      { event: 'life_signs', data: '{"state_id":"s"}' },
    ]);
    expect(rest).toBe('event: partial\ndata: {"x":1}');
  });

  it('ignores comment/keepalive lines and defaults event to "message"', () => {
    const input = ': keepalive\n\ndata: {"a":1}\n\n';
    const { events } = parseSseChunk(input);
    expect(events).toEqual([{ event: 'message', data: '{"a":1}' }]);
  });
});

describe('connectJourneyStream', () => {
  it('sends X-Device-Id and Authorization headers on connect', () => {
    const fetchImpl = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const conn = connectJourneyStream({
      onEvent: () => {},
      getBaseUrl: () => 'https://api.example.com',
      getToken: () => 'tok-123',
      getDeviceId: () => 'device-abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/api/sessions/stream',
      expect.objectContaining({
        headers: { 'X-Device-Id': 'device-abc', Authorization: 'Bearer tok-123' },
      }),
    );
    conn.close();
  });
});
