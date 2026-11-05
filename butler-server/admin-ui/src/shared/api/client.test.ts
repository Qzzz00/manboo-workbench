// 来源:Aiboo origin/main 1f430c3f admin-ui/src/shared/api/client.test.ts(本机版:断言不再带 Authorization)
import { describe, it, expect, afterEach } from 'vitest';
import { AxiosError, AxiosHeaders, type AxiosAdapter, type AxiosResponse } from 'axios';
import { apiClient, request, AdminApiError } from '@/shared/api/client';

let lastConfig: { headers?: AxiosHeaders; url?: string; data?: unknown } | null = null;

function adapterWithStatus(status: number, data: unknown = { ok: true }): AxiosAdapter {
  return async (config) => {
    lastConfig = config;
    const response: AxiosResponse = { data, status, statusText: '', headers: {}, config, request: {} };
    if (status >= 200 && status < 300) return response;
    throw new AxiosError('request failed', undefined, config, {}, response);
  };
}

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
  lastConfig = null;
});

describe('apiClient(本机版无登录)', () => {
  it('不带 Authorization 头', async () => {
    apiClient.defaults.adapter = adapterWithStatus(200);
    await apiClient.get('/admin/avatars');
    expect(lastConfig?.headers?.get('Authorization')).toBeFalsy();
  });

  it('403(非本机且无令牌)转成 AdminApiError,带上服务端原话', async () => {
    apiClient.defaults.adapter = adapterWithStatus(403, { code: 'forbidden', error: '只接受本机或工作台转发的请求' });
    await expect(request('/admin/avatars')).rejects.toMatchObject({
      name: 'AdminApiError',
      status: 403,
      code: 'forbidden',
      message: '只接受本机或工作台转发的请求',
    });
    await expect(request('/admin/avatars')).rejects.toBeInstanceOf(AdminApiError);
  });
});
