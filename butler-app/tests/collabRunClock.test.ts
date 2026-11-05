import { expect, it } from 'vitest';
import type { ApiClient } from '../src/api/client';
import { collabClient } from '../src/api/collab';
import type { RunSegment } from '../src/api/protocol';

it('typed runs/activity保留可选观察时刻,旧源缺席不补assigned或finished', async () => {
  const old: RunSegment = { task_id: 't/1', source: 'codex', status: 'done', started_at: '2026-10-24T01:00:00Z', finished_at: '2026-10-24T01:30:00Z' };
  const observed: RunSegment = { ...old, execution_started_observed_at: '2026-10-24T01:05:00Z', execution_finished_observed_at: '2026-10-24T01:25:00Z' };
  const calls: string[] = [];
  const transport: ApiClient = {
    baseUrl: 'controlled',
    async json<T>(path: string) {
      calls.push(path);
      const data = path.startsWith('/collab/runs') ? { runs: [old, observed] } : { items: [{ type: 'run', at: old.finished_at, segment: observed }] };
      return { ok: true, status: 200, data: data as T };
    },
    async blob() { return { ok: false, status: 0, kind: 'network', error: 'unused' }; },
  };
  const client = collabClient(transport);
  const runs = await client.runs('t/1');
  expect(runs.ok).toBe(true);
  if (runs.ok) {
    expect(runs.data.runs).toEqual([old, observed]);
    expect(runs.data.runs[0]?.execution_started_observed_at).toBeUndefined();
    expect(runs.data.runs[0]?.execution_finished_observed_at).toBeUndefined();
  }
  const activity = await client.activity('t/1');
  expect(activity.ok).toBe(true);
  if (activity.ok) expect(activity.data.items[0]).toMatchObject({ type: 'run', segment: observed });
  expect(calls).toEqual(['/collab/runs?task_id=t%2F1', '/collab/note/activity?id=t%2F1']);
});
