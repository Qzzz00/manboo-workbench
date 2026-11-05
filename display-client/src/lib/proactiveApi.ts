import { apiGet, apiPost, ApiError } from './apiClient.ts';
import type { JourneyLifeSigns } from '../types/journey.ts';

export interface ProactiveMessage {
  id: string;
  content: string;
  beatId?: string;
  lifeSigns?: JourneyLifeSigns | null;
  createdAt?: number;
}

export interface StartJourneyResult {
  ok: boolean;
  blocked?: boolean;
  /** 403 时后端返回的细分原因：'birth_date_missing' | 'underage_blocked' 等。 */
  code?: string;
  instance?: unknown;
}

export async function startJourney(avatarId: string): Promise<StartJourneyResult> {
  try {
    const resp = (await apiPost(`/api/sessions/${encodeURIComponent(avatarId)}/journey/start`, {})) as {
      instance?: unknown;
    };
    return { ok: true, instance: resp.instance };
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      // 不在这里弹 toast —— 交给调用方按 code 决定（缺生日→弹填写框 / 真未成年→提示）。
      return { ok: false, blocked: true, code: err.code };
    }
    throw err;
  }
}

export async function fetchProactiveSince(avatarId: string, since: number): Promise<ProactiveMessage[]> {
  // ALL-432：服务端 created_at 是秒；兼容调用方误传毫秒（历史 lastSeen 用 Date.now() 存过），
  // 统一转秒再请求，避免单位错配导致离线已投递未看的 beat 被跳过。
  const sinceSec = since > 1e11 ? Math.floor(since / 1000) : since;
  const data = (await apiGet(
    `/api/sessions/${encodeURIComponent(avatarId)}/proactive?since=${Number(sinceSec) || 0}`,
  )) as { messages: ProactiveMessage[] };
  return data.messages || [];
}

export async function markProactiveSeen(avatarId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await apiPost(`/api/sessions/${encodeURIComponent(avatarId)}/proactive/seen`, { ids });
}
