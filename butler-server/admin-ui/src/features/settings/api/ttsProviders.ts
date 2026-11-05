// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/settings/api/ttsProviders.ts
/**
 * 类型化 TTS provider（dashscope | volcengine）+ 音色查询 API。
 * 后端 server/routes/admin/ttsProviders.cjs、ttsVoices.cjs。
 */

import axios from 'axios';
import { request, apiClient, AdminApiError } from '@/shared/api/client';
import type {
  CreateTtsProviderPayload,
  PatchTtsProviderPayload,
  TtsProvider,
  TtsVoicesResponse,
} from '@/shared/types';

export async function listTtsProviders(): Promise<TtsProvider[]> {
  const res = await request<{ models: TtsProvider[] }>('/admin/tts-models');
  return res.models;
}

export async function createTtsProvider(payload: CreateTtsProviderPayload): Promise<TtsProvider> {
  const res = await request<{ model: TtsProvider }>('/admin/tts-models', { method: 'POST', json: payload });
  return res.model;
}

export async function patchTtsProvider(id: string, payload: PatchTtsProviderPayload): Promise<TtsProvider> {
  const res = await request<{ model: TtsProvider }>(`/admin/tts-models/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: payload,
  });
  return res.model;
}

export async function deleteTtsProvider(id: string): Promise<{ deleted: boolean; id: string }> {
  return request(`/admin/tts-models/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * GET /admin/tts-voices —— 官方精选 + 账号复刻音色（音色下拉用）。
 * 传 providerId 则按该 provider 取音色；kind='rtc' 时按 rtc_providers 解析。不传回落全局默认。
 */
export async function getTtsVoices(opts?: { providerId?: string; kind?: 'tts' | 'rtc' }): Promise<TtsVoicesResponse> {
  const qs = new URLSearchParams();
  if (opts?.providerId) qs.set('providerId', opts.providerId);
  if (opts?.kind) qs.set('kind', opts.kind);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<TtsVoicesResponse>(`/admin/tts-voices${suffix}`);
}

/**
 * POST /admin/tts-voices/refresh —— **重新向火山取一遍**这个账号能用哪些音色(2026-09-27,卡 VO)。
 * 一趟要逐个音色试合一句,两三分钟;这里起了就回(202),页面重新 getTtsVoices 看 availability。
 */
export async function refreshTtsVoices(): Promise<{ ok: boolean; started: boolean; note: string }> {
  return request('/admin/tts-voices/refresh', { method: 'POST' });
}

/**
 * POST /admin/tts-voices/preview —— 试听：用默认 TTS provider 实时合成一句样音，返回音频 Blob。
 * 出错时后端返回 JSON({error})，这里把 blob 读成文本解析出可读错误。
 */
export async function previewTtsVoice(voice: string, opts?: { text?: string; providerId?: string }): Promise<Blob> {
  try {
    const res = await apiClient.request<Blob>({
      url: '/admin/tts-voices/preview',
      method: 'POST',
      data: { voice, ...(opts?.text ? { text: opts.text } : {}), ...(opts?.providerId ? { providerId: opts.providerId } : {}) },
      responseType: 'blob',
    });
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.data instanceof Blob) {
      const txt = await err.response.data.text();
      let msg = txt;
      try { msg = (JSON.parse(txt) as { error?: string }).error ?? txt; } catch { /* 非 JSON 原样用 */ }
      throw new AdminApiError(msg, err.response.status ?? 0);
    }
    throw err;
  }
}
