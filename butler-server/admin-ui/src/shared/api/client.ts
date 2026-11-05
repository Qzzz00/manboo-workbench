// 来源:Aiboo origin/main 1f430c3f admin-ui/src/shared/api/client.ts(去掉 JWT 请求头与 401 跳登录)
import axios from 'axios';
import { AdminApiError } from '@/shared/api/errors';

export { AdminApiError };

export interface RequestOptions {
  method?: string;
  json?: unknown;
  form?: FormData;
  query?: Record<string, string | undefined>;
  onProgress?: (percent: number) => void;
  /** 单次请求超时（ms）；超时 axios 抛 ECONNABORTED，由调用方转成友好错误。 */
  timeout?: number;
}

/**
 * 共享 axios 实例。baseURL 为空:所有请求走同源相对路径(/admin/…、/api/…),
 * 开发态由 Vite 代理到 butler-server(127.0.0.1:8792),生产态后台就托管在 butler-server 自己的 /admin/ 下。
 * 本机版无登录,不加 Authorization;鉴权由 butler-server 按来源(本机回环 / 工作台令牌)判。
 */
export const apiClient = axios.create({
  baseURL: '',
  headers: { 'Content-Type': 'application/json' },
});

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', json, form, query, onProgress, timeout } = opts;

  const params = query
    ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined))
    : undefined;

  try {
    const res = await apiClient.request<T>({
      url: path,
      method,
      params,
      timeout,
      data: form ?? json,
      // FormData:把默认 Content-Type 置空,由浏览器自动生成带 boundary 的 multipart 头。
      headers: form ? { 'Content-Type': undefined } : undefined,
      onUploadProgress: onProgress
        ? (e) => {
            if (e.total && e.total > 0) {
              onProgress(Math.round((e.loaded / e.total) * 100));
            }
          }
        : undefined,
    });
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const data = err.response?.data as
        | { code?: string; error?: string | { code?: string; message?: string } }
        | undefined;
      const errField = data?.error;
      const message =
        (typeof errField === 'string' ? errField : errField?.message) ?? err.message;
      const code = (typeof errField === 'object' ? errField?.code : undefined) ?? data?.code;
      throw new AdminApiError(message, err.response?.status ?? 0, code);
    }
    throw err;
  }
}
