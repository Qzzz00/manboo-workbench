import { apiGet, apiPost } from './apiClient.ts';

/**
 * 客户端功能开关：是否启用应用内触达（画外消息横幅 / 原地来电）。
 * 网络异常或后端未就绪都不应挡住主流程 —— 失败静默返回 {inAppTouch:false}，
 * 相当于「未开启」，调用方无需 try/catch。
 */
export async function fetchClientFlags(): Promise<{ inAppTouch: boolean }> {
  try {
    const data = (await apiGet('/api/sessions/client-flags')) as { inAppTouch?: boolean } | null;
    return { inAppTouch: data?.inAppTouch === true };
  } catch {
    return { inAppTouch: false };
  }
}

/**
 * 回报一次来电邀请的结果（接听/挂断/超时未接）。
 * 失败静默 —— 服务端有 60s sweeper：置 call_ringing 后超 60s 仍无回写的行会被
 * proactiveDispatcher.drain() 兜底结算成未接留言，不需要客户端重试或向用户报错。
 */
export async function postCallResult(
  avatarId: string,
  id: string,
  result: 'accepted' | 'declined' | 'timeout',
): Promise<void> {
  try {
    await apiPost(`/api/sessions/${encodeURIComponent(avatarId)}/call-result`, { id, result });
  } catch {
    // 静默：留言兜底在服务端。
  }
}
