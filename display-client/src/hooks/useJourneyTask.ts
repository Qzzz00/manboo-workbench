/**
 * 旅程任务完成闭环（ALL-371 / 任务包 B）客户端 hook。
 *
 * 职责：拉取当前派发中的任务、提交反馈、维护提交态。
 * - 成功提交后清空任务并尝试拉取下一个（若有）；
 * - 提交失败抛出错误，交由 JourneyTaskCard 保留卡片并展示错误（可重试）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { JourneyTask, TaskFeedback } from '../types/journey.ts';
import { fetchCurrentTask, submitTaskFeedback } from '../lib/journeyTaskApi.ts';

export interface UseJourneyTaskResult {
  task: JourneyTask | null;
  submitting: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  submit: (feedback: TaskFeedback) => Promise<void>;
}

export function useJourneyTask(avatarId: string | null | undefined): UseJourneyTaskResult {
  const [task, setTask] = useState<JourneyTask | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!avatarId) {
      setTask(null);
      return;
    }
    try {
      setTask(await fetchCurrentTask(avatarId));
    } catch (e) {
      // 静默降级：拉取任务失败不打断主流程（聊天等），下次刷新会重试。
      console.warn('[useJourneyTask] fetchCurrentTask failed', e);
    }
  }, [avatarId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = useCallback(
    async (feedback: TaskFeedback) => {
      if (!avatarId || !task) return;
      setSubmitting(true);
      setError(null);
      try {
        await submitTaskFeedback(avatarId, task.id, feedback);
        setTask(null); // 完成 → 卡片消失
        void refresh(); // 拉取下一个任务（若有）
      } catch (e) {
        const message = e instanceof Error ? e.message : '提交失败';
        setError(message);
        throw e; // 让卡片捕获并保留、展示错误
      } finally {
        setSubmitting(false);
      }
    },
    [avatarId, task, refresh],
  );

  return { task, submitting, error, refresh, submit };
}
