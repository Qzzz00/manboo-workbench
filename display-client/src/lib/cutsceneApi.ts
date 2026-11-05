import { apiGet, apiPost } from './apiClient.ts';

export interface PendingCutscene {
  id: string;
  beatId?: string;
  storyboard: unknown;
  bgmUrl?: string | null;
  createdAt?: number;
}

// 拉「已烤好、已到投递时刻、未看」的演出（次日晨/强制烤后浮现换挡卡）。
export async function fetchPendingCutscenes(avatarId: string): Promise<PendingCutscene[]> {
  const data = (await apiGet(`/api/sessions/${encodeURIComponent(avatarId)}/cutscene/pending`)) as {
    cutscenes: PendingCutscene[];
  };
  return data.cutscenes || [];
}

// 演出完整播完 → 触发服务端三层回写（形象/记忆/已看），返回本场的形象结果。
export async function completeCutscene(avatarId: string, id: string): Promise<Record<string, unknown> | null> {
  const data = (await apiPost(
    `/api/sessions/${encodeURIComponent(avatarId)}/cutscene/${encodeURIComponent(id)}/complete`,
    {},
  )) as { appearance?: Record<string, unknown> };
  return data.appearance ?? null;
}

// 进角色时加载持久形象状态（换装/发型），交给 presence.setApparel 落到日常 Live2D。
export async function fetchAppearance(avatarId: string): Promise<Record<string, unknown>> {
  const data = (await apiGet(`/api/sessions/${encodeURIComponent(avatarId)}/appearance`)) as {
    appearance: Record<string, unknown>;
  };
  return data.appearance || {};
}
