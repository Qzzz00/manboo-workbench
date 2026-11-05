import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ApiClient } from '../src/api/client';
import type { RunSegment, TaskView } from '../src/api/protocol';
import { guardActivityItems, guardRunSegments, runSegmentLine } from '../src/collab/collabCore';
import { TaskSheet } from '../src/collab/TaskSheet';
import { GoalPanel } from '../src/collab/GoalPanel';
import { collabFields } from '../src/collab/collabState';
const assigned = '2026-10-24T01:00:00Z', finish = '2026-10-24T01:30:00Z';
const startedObservation = '2026-10-24T01:05:00Z', resultObservation = '2026-10-24T01:25:00Z';
const old: RunSegment = { task_id: 'task-clock', source: 'codex', status: 'done', started_at: assigned, finished_at: finish, outcome: 'replied' };
const observed: RunSegment = { ...old, execution_started_observed_at: startedObservation, execution_finished_observed_at: resultObservation };
const read = (segment: RunSegment) => guardRunSegments({ runs: [segment] })![0]!;
afterEach(cleanup);
it('runs与activity守卫直接保留唯一RunSegment的两个可选观察字段', () => {
  const run = read(observed);
  expect(run).toMatchObject({ execution_started_observed_at: startedObservation, execution_finished_observed_at: resultObservation });
  const activity = guardActivityItems({ items: [{ type: 'run', at: finish, segment: observed }] });
  expect(activity?.[0]).toMatchObject({ type: 'run', segment: { execution_started_observed_at: startedObservation, execution_finished_observed_at: resultObservation } });
});
it('旧源缺席时明示观察未知,不补assigned/管线收场/排期,不算精确耗时', () => {
  const run = read(old), line = runSegmentLine(run);
  expect(run).not.toHaveProperty('execution_started_observed_at'); expect(run).not.toHaveProperty('execution_finished_observed_at');
  expect(line).toContain('本机核到开工:未知'); expect(line).toContain('本机收到结果:未知');
  expect(line).not.toContain(assigned); expect(line).not.toContain(finish); expect(line).not.toMatch(/耗时\s*\d/);
});
it('失联历史观察不升级running,只有结果观察不填开始', () => {
  const unknown = read({ ...observed, status: 'unknown', finished_at: undefined, outcome: undefined, execution_finished_observed_at: undefined });
  expect(unknown.status).toBe('unknown');
  expect(runSegmentLine(unknown)).toContain('失联或记录过旧'); expect(runSegmentLine(unknown)).toContain(`本机核到开工:${startedObservation}`); expect(runSegmentLine(unknown)).toContain('本机收到结果:未知');
  const resultOnly = read({ ...observed, execution_started_observed_at: undefined });
  expect(runSegmentLine(resultOnly)).toContain('本机核到开工:未知'); expect(runSegmentLine(resultOnly)).toContain(`本机收到结果:${resultObservation}`);
});
it('坏字段缺席,不会把数字或空串当成观察时刻', () => {
  const run = guardRunSegments({ runs: [{ ...old, execution_started_observed_at: 42, execution_finished_observed_at: '' }] })![0]!;
  expect(run).not.toHaveProperty('execution_started_observed_at'); expect(run).not.toHaveProperty('execution_finished_observed_at');
  expect(runSegmentLine(run)).toContain('本机核到开工:未知');
});
const task: TaskView = { id: 'task-clock', title: '已有执行产物', status: 'confirm', created_at: assigned, updated_at: finish, assignee: 'me', goal_id: 'goal-clock', start: '2026-10-25T09:00:00Z', end: '2026-10-25T11:00:00Z' };
const actors = { cards: {}, members: {} };
function clientFor(segment: RunSegment): ApiClient {
  return { baseUrl: 'controlled-clock', async json<T>(path: string) {
    const data = path.includes('/note/activity') ? { items: [{ type: 'run', at: finish, segment }] }
      : path.includes('/runs') ? { runs: [segment] }
      : path.includes('/goal/board') ? { summary: { goal_id: 'goal-clock', scope: '目标', conditions: { items: [] }, tasks: {} } }
      : { items: [], relations: [] };
    return { ok: true, status: 200, data: data as T };
  }, async blob() { return { ok: false, kind: 'network', status: 0, error: 'unused' }; } };
}
it.each([observed, { ...observed, status: 'unknown' as const, finished_at: undefined, outcome: undefined, execution_finished_observed_at: undefined }, old])('生产时间线与安排/派盯显示观察含义,保持计划和记录时间独立: $status', async (segment) => {
  const client = clientFor(segment), now = '2026-10-24T02:00:00Z';
  const ui = render(<TaskSheet task={task} allTasks={[task]} goals={[]} fields={collabFields} actors={actors} now={now} sessions={[]} outbox={undefined} client={client} draftScope="clock-test" onOpenTask={() => {}} onOpenGoal={() => {}} />);
  const activity = screen.getByRole('region', { name: '连续活动' });
  expect(await within(activity).findByText(/本机核到开工:/)).toBeTruthy();
  const text = activity.textContent!;
  expect(text).toContain(segment.execution_started_observed_at ?? '本机核到开工:未知');
  expect(text).toContain(segment.execution_finished_observed_at ?? '本机收到结果:未知');
  expect(text).toContain('非模型精确起止或耗时');
  expect(screen.getByRole('region', { name: '时间' }).textContent).toContain('计划 2026-10-25T09:00:00Z');
  ui.unmount();
  render(<GoalPanel goal={{ id: 'goal-clock', title: '原目标' }} tasks={[task]} fields={collabFields} actors={actors} now={now} client={client} onRefresh={async () => {}} onOpenTask={() => {}} />);
  const schedule = screen.getByRole('region', { name: '按人的安排' });
  expect(await within(schedule).findByText(/本机核到开工:/)).toBeTruthy();
  expect(schedule.textContent).toContain('记录时间'); expect(schedule.textContent).toContain('计划 2026-10-25T09:00:00Z');
  expect(await within(screen.getByRole('region', { name: '执行状态' })).findByText(/本机核到开工:/)).toBeTruthy();
});
