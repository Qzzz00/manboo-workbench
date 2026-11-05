import { useCallback, useEffect, useState } from 'react';
import { fetchJourneyEnding, type JourneyEnding } from '../lib/journeyApi.ts';

export type UseEndingState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string; retry: () => void }
  | { status: 'ready'; ending: JourneyEnding; retry: () => void };

/**
 * 拉取并管理旅程结局状态。
 *
 * - 挂载时自动请求 `/api/journey/ending`
 * - 暴露 `retry` 供 UI 重试
 * - 状态机显式区分 idle / loading / error / ready，避免 undefined 歧义
 */
export function useEnding(autoLoad = true): UseEndingState {
  const [state, setState] = useState<UseEndingState>({ status: 'idle' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const ending = await fetchJourneyEnding();
      setState({ status: 'ready', ending, retry: load });
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载结局失败';
      setState({ status: 'error', message, retry: load });
    }
  }, []);

  useEffect(() => {
    if (!autoLoad) return;
    void load();
  }, [autoLoad, load]);

  return state;
}
