// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/settings/api/rtcProviders.ts
/**
 * 类型化「实时通话(RTC)」provider（volcengine_rtc）API。
 * 后端 server/routes/admin/rtcProviders.cjs。
 */

import { request } from '@/shared/api/client';
import type {
  CreateRtcProviderPayload,
  PatchRtcProviderPayload,
  RtcProvider,
} from '@/shared/types';

export async function listRtcProviders(): Promise<RtcProvider[]> {
  const res = await request<{ models: RtcProvider[] }>('/admin/rtc-providers');
  return res.models;
}

export async function createRtcProvider(payload: CreateRtcProviderPayload): Promise<RtcProvider> {
  const res = await request<{ model: RtcProvider }>('/admin/rtc-providers', { method: 'POST', json: payload });
  return res.model;
}

export async function patchRtcProvider(id: string, payload: PatchRtcProviderPayload): Promise<RtcProvider> {
  const res = await request<{ model: RtcProvider }>(`/admin/rtc-providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: payload,
  });
  return res.model;
}

export async function deleteRtcProvider(id: string): Promise<{ deleted: boolean; id: string }> {
  return request(`/admin/rtc-providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
