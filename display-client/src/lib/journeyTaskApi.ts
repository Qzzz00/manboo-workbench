/**
 * 旅程任务完成闭环（ALL-371 / 任务包 B + ALL-407 类型统一）客户端运行时 API。
 *
 * 后端路由（server/routes/journeySession.cjs）：
 *   GET  /api/sessions/:avatarId/journey/current-task            → 当前派发中的任务
 *   POST /api/sessions/:avatarId/journey/tasks/:taskId/complete  → 提交反馈完成任务
 *
 * 反馈载荷（与服务端 FEEDBACK_TYPES 全集一致；voice 运行时暂不支持，服务端明确拒绝）：
 *   text     → { feedback_type:'text', text }
 *   image    → { feedback_type:'image', image_url }
 *   confirm  → { feedback_type:'confirm', confirmed:true }
 *   option   → { feedback_type:'option', option_id }
 *   number   → { feedback_type:'number', number }
 *   location → { feedback_type:'location', lat, lng }
 *   nfc_tag  → { feedback_type:'nfc_tag', tag_id }
 */

import type { CurrentBeat, JourneyTask, TaskFeedback } from '../types/journey.ts';
import { ApiError, apiGet, apiPost } from './apiClient.ts';

export interface TaskCompletionResult {
  status: 'completed';
  /** 幂等命中（后端返回 409）时为 true：任务此前已完成，剧情不会重复推进。 */
  alreadyCompleted: boolean;
  nextBeat: CurrentBeat | null;
  followUp: string | null;
}

const sessionPath = (avatarId: string, suffix: string) =>
  `/api/sessions/${encodeURIComponent(avatarId)}/journey/${suffix}`;

/** 拉取当前登录用户在该角色下派发中的任务；无进行中的旅程/任务时返回 null。 */
export async function fetchCurrentTask(avatarId: string): Promise<JourneyTask | null> {
  const data = (await apiGet(sessionPath(avatarId, 'current-task'))) as { task?: JourneyTask | null };
  return data?.task ?? null;
}

// 把判别联合的反馈转成后端约定的请求体。
function toRequestBody(feedback: TaskFeedback): Record<string, unknown> {
  switch (feedback.type) {
    case 'text':
      return { feedback_type: 'text', text: feedback.value };
    case 'image':
      return { feedback_type: 'image', image_url: feedback.value };
    case 'confirm':
      return { feedback_type: 'confirm', confirmed: true };
    case 'option':
      return { feedback_type: 'option', option_id: feedback.value };
    case 'number':
      return { feedback_type: 'number', number: feedback.value };
    case 'location': {
      // JourneyTaskCard 采集的 value 是 "lat,lng" 字符串，这里解析为结构化字段。
      const [lat, lng] = feedback.value.split(',').map((s) => Number.parseFloat(s.trim()));
      return { feedback_type: 'location', lat, lng };
    }
    case 'nfc_tag':
      return { feedback_type: 'nfc_tag', tag_id: feedback.value };
    default:
      // voice：运行时暂不支持，仍以通用 value 提交，服务端返回明确的 voice_unsupported 错误。
      return { feedback_type: feedback.type, value: (feedback as { value: unknown }).value };
  }
}

function normalize(data: unknown, alreadyCompleted: boolean): TaskCompletionResult {
  const next = (data as { next_state?: { next_beat?: CurrentBeat | null; follow_up?: string | null } })?.next_state;
  return {
    status: 'completed',
    alreadyCompleted,
    nextBeat: next?.next_beat ?? null,
    followUp: next?.follow_up ?? null,
  };
}

/**
 * 提交任务反馈完成任务。
 * - 200 → 完成并（可能）推进剧情；
 * - 409 → 幂等命中：视为已完成，剧情不重复推进，返回 alreadyCompleted=true；
 * - 400/404 等 → 抛 ApiError，由调用方展示错误并允许重试。
 */
export async function submitTaskFeedback(
  avatarId: string,
  taskId: string,
  feedback: TaskFeedback,
): Promise<TaskCompletionResult> {
  try {
    const data = await apiPost(sessionPath(avatarId, `tasks/${encodeURIComponent(taskId)}/complete`), toRequestBody(feedback));
    return normalize(data, false);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      return { status: 'completed', alreadyCompleted: true, nextBeat: null, followUp: null };
    }
    throw e;
  }
}
