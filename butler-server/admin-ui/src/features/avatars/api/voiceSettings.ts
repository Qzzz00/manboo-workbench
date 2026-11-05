// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/api/voiceSettings.ts
/**
 * 音色同步配置 API（ALL-605 契约 / ALL-608 前端消费）。
 * 后端 server/routes/voiceSettings.cjs。
 *   GET  /api/voice-settings/:avatarId   读某角色最终两侧音色配置
 *   PUT  /api/voice-settings            保存同步模式 + 源音色（服务端解析并落地两套最终音色）
 *   GET  /api/voice-mappings            列逻辑音色映射
 *   POST /api/voice-mappings/resolve    按一侧音色反查两侧最终配置
 */

import { request } from '@/shared/api/client';
import type { LogicalVoiceMapping, VoiceRef, VoiceSettings, VoiceSyncMode } from '@/shared/types';

export interface PutVoiceSettingsPayload {
  avatar_id: string;
  voice_sync_mode: VoiceSyncMode;
  base_voice?: VoiceRef;
  rtc_voice?: VoiceRef;
}

export async function getVoiceSettings(avatarId: string): Promise<VoiceSettings> {
  const res = await request<{ voice_settings: VoiceSettings }>(
    `/api/voice-settings/${encodeURIComponent(avatarId)}`,
  );
  return res.voice_settings;
}

export async function putVoiceSettings(payload: PutVoiceSettingsPayload): Promise<VoiceSettings> {
  const res = await request<{ voice_settings: VoiceSettings }>('/api/voice-settings', {
    method: 'PUT',
    json: payload,
  });
  return res.voice_settings;
}

export async function listVoiceMappings(): Promise<LogicalVoiceMapping[]> {
  const res = await request<{ mappings: LogicalVoiceMapping[] }>('/api/voice-mappings');
  return res.mappings;
}

/** 新增/更新逻辑音色映射（PUT /api/voice-mappings/:logicalVoiceId，upsert）。 */
export interface PutVoiceMappingPayload {
  base_voice: VoiceRef;
  rtc_voice: VoiceRef;
  enabled?: boolean;
}

export async function putVoiceMapping(
  logicalVoiceId: string,
  payload: PutVoiceMappingPayload,
): Promise<LogicalVoiceMapping> {
  const res = await request<{ mapping: LogicalVoiceMapping }>(
    `/api/voice-mappings/${encodeURIComponent(logicalVoiceId)}`,
    { method: 'PUT', json: payload },
  );
  return res.mapping;
}

/** 删除逻辑音色映射（DELETE /api/voice-mappings/:logicalVoiceId）。 */
export async function deleteVoiceMapping(logicalVoiceId: string): Promise<void> {
  await request(`/api/voice-mappings/${encodeURIComponent(logicalVoiceId)}`, { method: 'DELETE' });
}

export async function resolveVoiceMapping(side: 'base' | 'rtc', voice: VoiceRef): Promise<LogicalVoiceMapping> {
  const res = await request<{ mapping: LogicalVoiceMapping }>('/api/voice-mappings/resolve', {
    method: 'POST',
    json: { side, voice },
  });
  return res.mapping;
}

/**
 * POST /api/voices/preview —— RTC/base 槽位音色试听（ALL-606 契约）。
 * 请求体 { provider_id, voice_id, scene }；返回 JSON { audio_url, duration_ms?, expires_at }。
 */
export interface VoicePreviewPayload {
  provider_id: string;
  voice_id: string;
  scene: 'rtc' | 'base';
}

export interface VoicePreviewResult {
  audio_url: string;
  duration_ms?: number;
  expires_at: string;
}

export async function previewVoice(payload: VoicePreviewPayload): Promise<VoicePreviewResult> {
  return request<VoicePreviewResult>('/api/voices/preview', {
    method: 'POST',
    json: payload,
  });
}
