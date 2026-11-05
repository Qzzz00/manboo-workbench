/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiClient.ts', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  ApiError: class ApiError extends Error { constructor(m: string, public status: number) { super(m); } },
}));
import { apiGet, apiPost } from './apiClient.ts';
import { startJourney, fetchProactiveSince, markProactiveSeen } from './proactiveApi.ts';

describe('proactiveApi', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('startJourney posts to the avatar-scoped endpoint', async () => {
    (apiPost as any).mockResolvedValue({ instance: { id: 'i1' }, created: true });
    const r = await startJourney('a1');
    expect(apiPost).toHaveBeenCalledWith('/api/sessions/a1/journey/start', {});
    expect(r.ok).toBe(true);
  });

  it('fetchProactiveSince returns messages array', async () => {
    (apiGet as any).mockResolvedValue({ messages: [{ id: 'p1', content: 'hi', createdAt: 5 }] });
    const list = await fetchProactiveSince('a1', 0);
    expect(apiGet).toHaveBeenCalledWith('/api/sessions/a1/proactive?since=0');
    expect(list[0].content).toBe('hi');
  });

  it('fetchProactiveSince 把毫秒 since 转成秒再请求（兼容历史 lastSeen 误存毫秒）', async () => {
    (apiGet as any).mockResolvedValue({ messages: [] });
    await fetchProactiveSince('a1', 1_720_000_000_000);
    expect(apiGet).toHaveBeenCalledWith('/api/sessions/a1/proactive?since=1720000000');
  });

  it('markProactiveSeen posts ids', async () => {
    (apiPost as any).mockResolvedValue({ ok: true });
    await markProactiveSeen('a1', ['p1', 'p2']);
    expect(apiPost).toHaveBeenCalledWith('/api/sessions/a1/proactive/seen', { ids: ['p1', 'p2'] });
  });
});
