import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import type { TaskView } from '../api/protocol';
import { goalIdOfTask } from './collabState';
import { guardRunSegments, type RawRunSegment } from './collabCore';
export interface RunsSnapshot { items?: readonly RawRunSegment[]; error?: string; loading: boolean }
/** 按 client + 精确事项集合隔离执行投影;同范围刷新失败保留旧快照并明示。 */
export function useRuns(client: ApiClient, tasks: readonly TaskView[], enabled = true, refreshToken?: string): RunsSnapshot {
  const scope = JSON.stringify([...new Set(tasks.map((task) => task.id))].sort());
  const [snapshot, setSnapshot] = useState<RunsSnapshot & { client: ApiClient; scope: string }>({ client, scope, loading: true });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setSnapshot((old) => old.client === client && old.scope === scope ? { ...old, loading: true } : { client, scope, loading: true });
    const goals = [...new Set(tasks.map(goalIdOfTask))];
    void Promise.all(goals.map(async (goal) => {
      const result = await client.json<unknown>(`/collab/runs?goal_id=${encodeURIComponent(goal)}`, { method: 'GET' });
      if (!result.ok) throw new Error(result.error || '读不到运行记录');
      const items = guardRunSegments(result.data);
      if (items === undefined) throw new Error('工作台回的运行记录格式不认识');
      return items;
    })).then((lists) => {
      if (!alive) return;
      const ids = new Set(tasks.map((task) => task.id));
      setSnapshot({ client, scope, loading: false, items: lists.flat().filter((run) => ids.has(run.taskId)) });
    }).catch((error: unknown) => {
      if (alive) setSnapshot((old) => ({ ...old, loading: false, error: error instanceof Error ? error.message : '读不到运行记录' }));
    });
    return () => { alive = false; };
  }, [client, scope, tasks, enabled, refreshToken]);
  return snapshot.client === client && snapshot.scope === scope ? snapshot : { loading: true };
}
