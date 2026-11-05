import { apiPost } from './apiClient.ts';
import { API_USAGE_OPEN, API_USAGE_REPORT } from './apiConfig.ts';

/**
 * 上报一段前台活跃时长（秒），挂当前选中角色。
 * 失败静默 —— 时长统计是被动数据，口径允许分钟级误差（丢一段可接受），
 * 不重试、不打扰主流程。
 */
export async function reportUsageTime(avatarId: string, seconds: number): Promise<void> {
  try {
    await apiPost(API_USAGE_REPORT, { avatar_id: avatarId, seconds });
  } catch {
    // 静默：被动统计数据，允许丢段。
  }
}

/**
 * 上报一次应用「打开」事件（进前台真实切换，无角色维度）。
 * 失败静默 —— 打开次数是被动统计，允许丢，不重试、不打扰主流程（401 也不例外）。
 */
export async function reportUsageOpen(): Promise<void> {
  try {
    await apiPost(API_USAGE_OPEN, {});
  } catch {
    // 静默：被动统计数据，允许丢失。
  }
}
