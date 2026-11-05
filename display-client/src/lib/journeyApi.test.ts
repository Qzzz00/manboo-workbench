/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiClient.ts', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(m: string, public status: number, public code?: string) { super(m); }
  },
}));
import { apiGet } from './apiClient.ts';
import { fetchJourneyEnding } from './journeyApi.ts';

describe('fetchJourneyEnding (JMEASURE-RUNTIME-001)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('请求 /api/journey/ending 并映射真实结局字段', async () => {
    (apiGet as any).mockResolvedValue({
      id: 'e1',
      journeyInstanceId: 'i1',
      bodyText: '一起复查的那天，我才知道什么是被接住。',
      rhythm: 'warm',
      generatedAt: '2026-08-07T00:00:00.000Z',
      usedMemoryIds: ['m1'],
    });
    const ending = await fetchJourneyEnding();
    expect(apiGet).toHaveBeenCalledWith('/api/journey/ending');
    expect(ending.bodyText).toContain('被接住');
    expect(ending.rhythm).toBe('warm');
    expect(ending.usedMemoryIds).toEqual(['m1']);
  });

  it('传 avatarId 时带 avatar_id 查询参数', async () => {
    (apiGet as any).mockResolvedValue({
      id: 'e1', journeyInstanceId: 'i1', bodyText: 'x', rhythm: 'open', generatedAt: '',
    });
    await fetchJourneyEnding('a1');
    expect(apiGet).toHaveBeenCalledWith('/api/journey/ending?avatar_id=a1');
  });

  it('非法 rhythm 回退 reflective', async () => {
    (apiGet as any).mockResolvedValue({
      id: 'e1', journeyInstanceId: 'i1', bodyText: 'x', rhythm: 'weird', generatedAt: '',
    });
    const ending = await fetchJourneyEnding();
    expect(ending.rhythm).toBe('reflective');
  });

  it('响应缺关键字段时抛 invalid_response，而不是 501 占位', async () => {
    (apiGet as any).mockResolvedValue({});
    await expect(fetchJourneyEnding()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('404 错误原样透传（旅程未完成）', async () => {
    const { ApiError } = await import('./apiClient.ts');
    (apiGet as any).mockRejectedValue(new ApiError('ending not found', 404, 'ending_not_found'));
    await expect(fetchJourneyEnding()).rejects.toMatchObject({ status: 404, code: 'ending_not_found' });
  });
});
