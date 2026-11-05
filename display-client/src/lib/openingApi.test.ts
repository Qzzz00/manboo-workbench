/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiClient.ts', () => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
}));
import { apiGet } from './apiClient.ts';
import { triggerOpening } from './openingApi.ts';

describe('openingApi.triggerOpening', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls the session-scoped opening endpoint', async () => {
    (apiGet as any).mockResolvedValue({ should_send: false });
    await triggerOpening('a1');
    expect(apiGet).toHaveBeenCalledWith('/api/sessions/a1/opening');
  });

  it('passes through emotion/intensity from the message', async () => {
    (apiGet as any).mockResolvedValue({
      should_send: true,
      message: {
        id: 'm1', content: '终于等到你！', role: 'assistant', type: 'text',
        meta: 'opening', createdAt: 1, emotion: 'excited', intensity: 0.9,
      },
    });
    const r = await triggerOpening('a1');
    expect(r.message?.emotion).toBe('excited');
    expect(r.message?.intensity).toBe(0.9);
  });

  it('tolerates messages without emotion fields (legacy/no-match)', async () => {
    (apiGet as any).mockResolvedValue({
      should_send: true,
      message: { id: 'm1', content: 'hi', role: 'assistant', type: 'text', meta: 'opening', createdAt: 1 },
    });
    const r = await triggerOpening('a1');
    expect(r.message?.emotion).toBeUndefined();
    expect(r.message?.intensity).toBeUndefined();
  });
});
