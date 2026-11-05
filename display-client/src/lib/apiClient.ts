/**
 * 统一 API 客户端
 *
 * - baseURL + 自动注入 JWT
 * - 统一错误处理（401 跳登录 / 配额用尽提示 / 网络失败）
 * - 后端地址区分 dev / 真机环境
 */

import { Capacitor } from '@capacitor/core';
import { AIBOO_DEFAULT_BASE_URL } from './aibooDefault';

const SERVER_URL_KEY = 'llm-live2d:server-url';
const AUTH_TOKEN_KEY = 'llm-live2d:auth-token';
const USER_KEY = 'llm-live2d:user';
const DEVICE_ID_KEY = 'llm-live2d:device-id';

/**
 * App 安装级设备标识。首次调用生成一个 UUID 持久化到 localStorage；
 * Capacitor WebView 的 localStorage 跨启动保留、仅卸载/清数据时清除，正好对应
 * 「安装级 UUID」语义，无需引入原生插件。内测期注册绑定 + 登录校验都用它。
 */
export function getDeviceId(): string {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id =
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/** 后端返回的业务错误 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 401 登录态失效 */
export class ApiAuthError extends ApiError {
  constructor(message = '登录已过期，请重新登录') {
    super(message, 401, 'auth_required');
  }
}

/** 429 / 配额用尽 */
export class ApiQuotaError extends ApiError {
  constructor(message = '配额已用完，请联系管理员') {
    super(message, 429, 'quota_exhausted');
  }
}

/** 网络失败 */
export class ApiNetworkError extends ApiError {
  constructor(message = '网络连接失败，请检查网络') {
    super(message, 0, 'network_error');
  }
}

export type ApiFetchOptions = RequestInit & {
  /** 为 true 时 401 不触发全局登出（用于登录/注册接口本身，及刷新 token 后的重试） */
  skipAuthHandler?: boolean;
  /** 内部标记：本次已是刷新 token 后的重试，避免无限重试。 */
  _retried?: boolean;
  /**
   * 请求超时（毫秒）。未传时默认 60000ms。
   * 传 0 表示不超时（用于长连接 / 流式场景）。
   * 超时触发后请求会被 abort，并抛出 ApiNetworkError('请求超时，请检查网络后重试')。
   */
  timeoutMs?: number;
};

/** apiFetch 默认超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 60000;

let authErrorHandler: (() => void) | null = null;

/**
 * 设置 401 时的全局回调（例如把 React state 清掉并跳登录页）。
 * 建议在 App 挂载时调用，卸载时传 null。
 */
export function setAuthErrorHandler(handler: (() => void) | null) {
  authErrorHandler = handler;
}

// access token 短期有效，过期即 401。注册「用 refresh token 换新 access token」的回调
// （authStore.refreshAccessToken），apiFetch 遇 401 先静默刷新+重试一次，刷新失败才登出，
// 避免用户会话中途被强制退出登录。
let tokenRefreshHandler: (() => Promise<string | null>) | null = null;
let refreshInFlight: Promise<string | null> | null = null;

export function setTokenRefreshHandler(handler: (() => Promise<string | null>) | null) {
  tokenRefreshHandler = handler;
}

/** 并发的 401 只触发一次刷新，其余共享同一个刷新结果。 */
function refreshTokenOnce(): Promise<string | null> {
  if (!tokenRefreshHandler) return Promise.resolve(null);
  if (!refreshInFlight) {
    refreshInFlight = tokenRefreshHandler()
      .catch(() => null)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

/** 判断当前是否在本地开发环境 */
export function isLocalDevHost(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.protocol !== 'http:') return false;
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}

/** 浏览器本地 dev（vite 中间件可用）判定。注意：原生 App 的 WebView 也跑在
 * http://localhost（androidScheme:'http'），裸用 isLocalDevHost 会把真机误判成 dev
 * （2026-07-10 投放上传实锤：请求打回 WebView 自己，收到 SPA 的 <!doctype）——
 * 判「浏览器 dev」必须叠 isNativePlatform 排除真机。 */
export function isBrowserDev(): boolean {
  return !Capacitor.isNativePlatform() && isLocalDevHost();
}

/** 云端后端地址：手机端 / 生产环境的默认后端（本地开发仍走 localhost）。 */
export const DEFAULT_CLOUD_BASE_URL = AIBOO_DEFAULT_BASE_URL;

/** 根据环境返回默认后端地址 */
export function getDefaultBaseUrl(): string {
  // Capacitor 原生 App 的 WebView 跑在 http://localhost（androidScheme:'http'），
  // 会被 isLocalDevHost 误判为本地 dev；原生 App 一律连云端后端。
  if (Capacitor.isNativePlatform()) return DEFAULT_CLOUD_BASE_URL;
  return isLocalDevHost() ? 'http://localhost:3456' : DEFAULT_CLOUD_BASE_URL;
}

/** 读取当前配置的后端地址 */
export function getBaseUrl(): string {
  if (typeof window === 'undefined') return getDefaultBaseUrl();
  return localStorage.getItem(SERVER_URL_KEY) || getDefaultBaseUrl();
}

/** 手动设置后端地址 */
export function setBaseUrl(url: string) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SERVER_URL_KEY, url.replace(/\/+$/, ''));
}

// 跨源注入的 token 覆盖（桌宠页 pet.localhost 与主 App localhost 不共享 localStorage）。
// 由原生桥 window.__petAuth（src/pet/main.tsx）在 pet 页启动时调用 setInjectedToken 写入；
// 主 App 正常运行时始终为 null，getStoredToken 回落到原有 localStorage 读取，行为不变。
let injectedToken: string | null = null;

/** 跨源注入 token（桌宠页专用）：设置后 getStoredToken 优先返回它，覆盖 localStorage 读取。传 null 清除注入。 */
export function setInjectedToken(t: string | null) {
  injectedToken = t;
}

/** 读取本地存储的 JWT（若已跨源注入则优先返回注入值，见 setInjectedToken）。 */
export function getStoredToken(): string | null {
  if (injectedToken != null) return injectedToken;
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

/** 清除登录态 */
export function clearAuth() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/**
 * 统一 fetch 封装。
 *
 * 自动拼接 baseURL、注入 Authorization、解析 JSON、按状态码抛出结构化错误。
 */
export async function apiFetch(
  path: string,
  options: ApiFetchOptions = {},
): Promise<unknown> {
  const { skipAuthHandler, _retried, timeoutMs, signal: externalSignal, ...fetchOptions } = options;

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new ApiNetworkError('后端地址未配置，请先设置服务器地址');
  }

  const url = `${baseUrl}${path}`;
  const token = getStoredToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Device-Id': getDeviceId(),
    ...(fetchOptions.headers as Record<string, string> || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // 超时控制：内部 AbortController 负责超时，同时兼容调用方自带的 signal。
  const effectiveTimeout = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (effectiveTimeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeout);
  }

  // 调用方自带 signal：转发其 abort 到内部 controller（保留外部 abort 语义）。
  let forwardAbort: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      forwardAbort = () => controller.abort();
      externalSignal.addEventListener('abort', forwardAbort);
    }
  }

  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (externalSignal && forwardAbort) {
      externalSignal.removeEventListener('abort', forwardAbort);
    }
  };

  console.log('[apiFetch]', fetchOptions.method || 'GET', url, 'token=', token ? 'yes' : 'no');
  let res: Response;
  try {
    res = await fetch(url, { ...fetchOptions, headers, signal: controller.signal });
    console.log('[apiFetch] response', res.status, url);
  } catch (networkErr) {
    // 因超时触发的 abort：抛出明确的超时错误。
    if (timedOut) {
      throw new ApiNetworkError('请求超时，请检查网络后重试');
    }
    // 外部 signal 触发的 abort：保留原始 AbortError，交由调用方处理。
    if (externalSignal?.aborted) {
      throw networkErr;
    }
    const message =
      networkErr instanceof Error ? networkErr.message : '网络请求失败';
    throw new ApiNetworkError(message);
  } finally {
    cleanup();
  }

  // 204 No Content
  if (res.status === 204) {
    return null;
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message =
      (data as Record<string, unknown>)?.error as string
      || (data as Record<string, unknown>)?.message as string
      || `请求失败 (${res.status})`;

    // 401 登录态失效：先用 refresh token 静默刷新并重试一次，刷新失败才真正登出。
    if (res.status === 401 && !skipAuthHandler) {
      if (!_retried && tokenRefreshHandler) {
        const newToken = await refreshTokenOnce();
        if (newToken) {
          return apiFetch(path, { ...options, _retried: true });
        }
      }
      clearAuth();
      authErrorHandler?.();
      throw new ApiAuthError(message);
    }

    // 429 配额用尽
    if (res.status === 429) {
      throw new ApiQuotaError(message);
    }

    // 后端显式返回配额错误码
    if ((data as Record<string, unknown>)?.code === 'quota_exhausted') {
      throw new ApiQuotaError(message);
    }

    throw new ApiError(message, res.status, (data as Record<string, unknown>)?.code as string);
  }

  return data;
}

/** GET 快捷方法 */
export function apiGet(path: string, options?: ApiFetchOptions) {
  return apiFetch(path, { ...options, method: 'GET' });
}

/** POST 快捷方法 */
export function apiPost(path: string, body: unknown, options?: ApiFetchOptions) {
  return apiFetch(path, { ...options, method: 'POST', body: JSON.stringify(body) });
}

/** PATCH 快捷方法 */
export function apiPatch(path: string, body: unknown, options?: ApiFetchOptions) {
  return apiFetch(path, { ...options, method: 'PATCH', body: JSON.stringify(body) });
}

/**
 * 上传文件（语音 / 图片）。
 * 使用 FormData，不设置 Content-Type（浏览器自动设置 multipart boundary）。
 */
export async function apiUploadFile(
  path: string,
  file: File | Blob,
  fileName: string,
  onProgress?: (percent: number) => void,
): Promise<{ url: string; mimeType: string; size: number }> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new ApiNetworkError('后端地址未配置，请先设置服务器地址');
  }

  const url = `${baseUrl}${path}`;
  const token = getStoredToken();

  const formData = new FormData();
  formData.append('file', file, fileName);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data as { url: string; mimeType: string; size: number });
        } catch {
          reject(new ApiError('解析上传响应失败', xhr.status));
        }
      } else {
        let message = '上传失败';
        try {
          const data = JSON.parse(xhr.responseText);
          message = data.error || message;
        } catch { /* ignore */ }
        if (xhr.status === 413) {
          reject(new ApiError('文件过大', xhr.status, 'upload_too_large'));
        } else {
          reject(new ApiError(message, xhr.status));
        }
      }
    });

    xhr.addEventListener('error', () => {
      reject(new ApiNetworkError('网络错误，上传失败'));
    });

    xhr.open('POST', url);
    xhr.setRequestHeader('X-Device-Id', getDeviceId());
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }
    xhr.send(formData);
  });
}

/**
 * 下载二进制资源（如角色 zip 包），返回 ArrayBuffer。
 *
 * 复用 apiFetch 的 baseURL 拼接、JWT 注入与错误语义，
 * 但不做 JSON 解析；非 2xx 时抛出结构化错误。
 */
export async function apiGetArrayBuffer(
  path: string,
  options: ApiFetchOptions = {},
): Promise<ArrayBuffer> {
  const { skipAuthHandler, _retried, ...fetchOptions } = options;

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new ApiNetworkError('后端地址未配置，请先设置服务器地址');
  }

  const url = `${baseUrl}${path}`;
  const token = getStoredToken();

  const headers: Record<string, string> = {
    'X-Device-Id': getDeviceId(),
    ...(fetchOptions.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { ...fetchOptions, method: 'GET', headers });
  } catch (networkErr) {
    const message =
      networkErr instanceof Error ? networkErr.message : '网络请求失败';
    throw new ApiNetworkError(message);
  }

  if (!res.ok) {
    if (res.status === 401 && !skipAuthHandler) {
      if (!_retried && tokenRefreshHandler) {
        const newToken = await refreshTokenOnce();
        if (newToken) {
          return apiGetArrayBuffer(path, { ...options, _retried: true });
        }
      }
      clearAuth();
      authErrorHandler?.();
      throw new ApiAuthError();
    }
    if (res.status === 429) {
      throw new ApiQuotaError();
    }
    throw new ApiError(`下载失败 (${res.status})`, res.status);
  }

  return res.arrayBuffer();
}
