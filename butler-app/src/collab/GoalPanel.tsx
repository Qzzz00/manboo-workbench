/**
 * 目标详情(2026-10-24,小K,阶段 2:接 core 真实条件与验收)。
 *
 * 能力条件来自 core 的真实账:`GET /collab/goal/board?goal_id=` 给服务端现算的状态
 * (读侧口径唯一,UI 不另造),条件账(goal.conditions,/state 快照)给核验留痕与交付时刻。
 * - 没条件的目标如实显示「未设置」,**不按完成几卡偷算能力达成**(统筹校正第 2 条);
 * - 重开/退回使旧核验失效(状态回「退回重做」,历史留痕保留,页上写清轮次);
 * - 有权限的核验动作(通过/退回/记交付)真打 core 端点,失败把服务端原因摆出来。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { friendlyWhen, type TaskView } from '../api/protocol';
import type { ApiClient } from '../api/client';
import {
  actorName,
  actorLabel,
  timeFactsOf,
  plannedTimeLine,
  type ActorContext,
} from './collabModel';
import {
  GOAL_CONDITION_STATE_TITLES,
  capacityLine,
  conditionRowsFromBoard,
  goalHasConditions,
  guardBoardSummary,
  guardCapacity,
  runSegmentLine,
  type ConditionRowReal,
  type RawBoardSummary,
  type RawCapacity,
  type RawGoalWithConditions,
} from './collabCore';

import { useRuns, type RunsSnapshot } from './useRuns';
import type { RawRunSegment } from './collabCore';
import { BucketBoard, staleOf } from './CollabPage';
import { guardTaskCollab, type CollabFields } from './collabState';

interface BoardState {
  summary: RawBoardSummary | undefined;
  loading: boolean;
  error: string | undefined;
  round: number;
}

/** `GET /collab/goal/board` 的真实读法;失败如实(调用方显示未知+重试)。 */
async function fetchBoard(client: ApiClient, goalId: string): Promise<{ summary?: RawBoardSummary; error?: string }> {
  const res = await client.json<unknown>(`/collab/goal/board?goal_id=${encodeURIComponent(goalId)}`, { method: 'GET' });
  if (!res.ok) return { error: res.error || '读不到目标汇总' };
  const summary = guardBoardSummary(res.data);
  return summary === undefined ? { error: '读不懂目标汇总(老工作台?)' } : { summary };
}

export function GoalPanel(props: {
  goal: RawGoalWithConditions;
  tasks: readonly TaskView[];
  fields: (t: TaskView) => CollabFields;
  actors: ActorContext;
  now: string;
  client: ApiClient;
  onRefresh(): Promise<void>;
  onOpenTask(taskId: string): void;
}) {
  const { goal, tasks, fields, actors, now, client, onRefresh, onOpenTask } = props;
  const [board, setBoard] = useState<BoardState>({ summary: undefined, loading: true, error: undefined, round: 0 });
  const boardRequest = useRef(0);
  const loadBoard = useCallback(() => {
    const request = ++boardRequest.current;
    setBoard((b) => ({ ...b, loading: true, error: undefined }));
    void fetchBoard(client, goal.id).then(({ summary, error }) => {
      if (request !== boardRequest.current) return;
      setBoard((b) => ({ summary, loading: false, error, round: b.round + 1 }));
    });
  // /state.now 只有秒精度；同一秒内核验/重开也要按新快照重读。
  }, [client, goal, now]);
  useEffect(() => { loadBoard(); return () => { boardRequest.current += 1; }; }, [loadBoard]);

  const runs = useRuns(client, tasks, true, now);
  const hasConditions = goalHasConditions(goal);
  const conditions = useMemo(
    () => board.summary === undefined ? [] : conditionRowsFromBoard(board.summary, goal.conditions ?? [], actors),
    [board.summary, goal.conditions, actors],
  );
  const reached = conditions.filter((c) => c.state === 'verified' || c.state === 'delivered').length;
  const delivered = conditions.filter((c) => c.state === 'delivered').length;
  const conditionCount = conditions.length || (goal.conditions?.length ?? 0);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  return (
    <>
      {/* 目标头:钉在顶上,滑清单不丢目标。 */}
      <header>
        <h2 className="ba-collab__goaltitle" style={{ fontSize: 'var(--ba-fs-title)' }}>
          {goal.title}
          {goal.status !== undefined && goal.status !== 'open' && (
            <span className="ba-collab__tag" data-tone={goal.status === 'reached' ? 'ok' : undefined}>
              {goal.status === 'reached' ? '已达成' : '已放弃'}
            </span>
          )}
        </h2>
        {goal.why !== undefined && <p className="ba-collab__meta">{goal.why}</p>}
        <p className="ba-collab__rangenote" role="note">
          本目标 · {goal.title}
          {goal.due !== undefined ? ` · 截止 ${goal.due}` : ''} · 父子不重复计数 · 取消单列
        </p>
      </header>

      <section aria-label="能力条件">
        <h3 className="ba-collab__sub">
          能力条件
          <span className="ba-collab__n">
            {hasConditions
              ? board.summary === undefined ? `${conditionCount} 条,验收与交付状态未知` : `${reached}/${conditionCount} 已验收 · ${delivered}/${conditionCount} 当前可用(按条件算,不按卡数)`
              : '未设置'}
          </span>
        </h3>
        {board.error !== undefined && (
          <p className="ba-collab__error" role="alert">
            {board.error}
            <button type="button" className="ba-collab__linkbtn" onClick={loadBoard}>再读一次</button>
          </p>
        )}
        {!hasConditions && board.error === undefined && (
          <p className="ba-collab__unwired">
            这个目标还没有设置能力条件(3–7 条「用户能做成的事」)。条件没设之前,
            下面只摆工作分布与真实回执,不拿完成几张卡冒充能力达成。
          </p>
        )}
        {conditions.map((row) => (
          <ConditionRowView
            key={row.id}
            row={row}
            task={row.taskId === undefined ? undefined : taskById.get(row.taskId)}
            actors={actors}
            now={now}
            client={client}
            goalId={goal.id}
            onOpenTask={onOpenTask}
            onChanged={() => { loadBoard(); void onRefresh(); }}
          />
        ))}
        {hasConditions && conditions.length === 0 && board.error === undefined && !board.loading && (
          <p className="ba-collab__unwired">条件在账上,但汇总投影还没读回来。</p>
        )}
        <p className="ba-collab__unwired">
          退回/重开会把对应条件打回「退回重做」:旧核验留痕保留,但不再算数(轮次对不上)。
        </p>
      </section>

      <section aria-label="派盯清单">
        <h3 className="ba-collab__sub">清单 <span className="ba-collab__n">任务数只说明工作分布</span></h3>
        <BucketBoard
          tasks={tasks}
          runs={runs}
          fields={fields}
          actors={actors}
          now={now}
          onOpenTask={onOpenTask}
          emptyText="这个目标里还没有事项。"
        />
      </section>

      <ScheduleSection
        tasks={tasks}
        runs={runs}
        fields={fields}
        actors={actors}
        now={now}
        client={client}
        onOpenTask={onOpenTask}
      />
    </>
  );
}

/** 能不能验:承接任务在 confirm/done(有成果可验),服务端同款门。 */
function verifiable(task: TaskView | undefined): boolean {
  return task !== undefined && (task.status === 'confirm' || task.status === 'done');
}

function ConditionRowView(props: {
  row: ConditionRowReal;
  task: TaskView | undefined;
  actors: ActorContext;
  now: string;
  client: ApiClient;
  goalId: string;
  onOpenTask(taskId: string): void;
  onChanged(): void;
}) {
  const { row, task, actors, now, client, goalId, onOpenTask, onChanged } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okNote, setOkNote] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const taskRound = task === undefined ? undefined : guardTaskCollab(task).round;
  useEffect(() => { setOkNote(null); setError(null); }, [taskRound]);

  const act = (path: string, body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setOkNote(null);
    void client.json(path, { method: 'POST', body }).then((res) => {
      setBusy(false);
      if (res.ok) { setOkNote(done); onChanged(); }
      else setError(res.error || '没存上');
    });
  };
  const verify = (pass: boolean) => {
    if (!pass && note.trim() === '') { setError('退回前写明要改什么'); return; }
    act('/collab/goal/condition/verify', {
      goal_id: goalId, condition_id: row.id, by: 'me', pass,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    }, pass ? '已验收通过' : '已退回重做');
  };
  const deliver = () => act('/collab/goal/condition/deliver', { goal_id: goalId, condition_id: row.id }, '已记交付');

  return (
    <div className="ba-collab__cond">
      <span className="ba-collab__condstate" data-s={row.state}>{GOAL_CONDITION_STATE_TITLES[row.state] ?? row.state}</span>
      <p className="ba-collab__condtext">{row.text}</p>
      <p className="ba-collab__condevi">
        {row.taskId !== undefined && (
          <>
            承接:
            <button type="button" className="ba-collab__linkbtn" onClick={() => onOpenTask(row.taskId as string)}>
              {task?.title ?? row.taskId}
            </button>
            {row.assigneeName !== undefined && `(${row.assigneeName})`}
          </>
        )}
        {row.taskId === undefined && '尚未安排承接任务'}
        {row.lastReceiptAt !== undefined && <> · 最近回执 {friendlyWhen(row.lastReceiptAt, now)}</>}
        {row.evidence.length > 0 && <> · 证据:{row.evidence.join('、')}</>}
        {row.blocker !== undefined && <> · 受阻:{[row.blocker.reason, row.blocker.next].filter((s) => s !== undefined).join(' · ')}</>}
        {row.deliveredAt !== undefined && <> · 交付 {friendlyWhen(row.deliveredAt, now)}</>}
      </p>
      {row.verifications.length > 0 && (
        <p className="ba-collab__condevi">
          核验留痕:
          {row.verifications.map((v, i) => (
            <span key={i}>
              {i > 0 && ' / '}
              {actorName(v.by, actors)} {v.pass ? '通过' : '不通过'} · 第{v.round}轮 · {friendlyWhen(v.at, now)}
              {v.note !== undefined && `(${v.note})`}
            </span>
          ))}
        </p>
      )}
      {task !== undefined && (
        <>
        {verifiable(task) && row.state !== 'delivered' && (
          <label className="ba-collab__condevi">
            核验依据或退回要求
            <textarea className="ba-collab__draft" aria-label="核验依据或退回要求" value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} placeholder="通过看了什么;退回要改什么" />
          </label>
        )}
        <div className="ba-collab__intent">
          {verifiable(task) && row.state !== 'delivered' && (
            <>
              <button type="button" disabled={busy} onClick={() => verify(true)}>验收通过</button>
              <button type="button" disabled={busy} onClick={() => verify(false)}>退回重做</button>
            </>
          )}
          {row.state === 'verified' && (
            <button type="button" disabled={busy} onClick={deliver}>记交付</button>
          )}
          {okNote !== null && <span role="status">{okNote}</span>}
        </div>
        </>
      )}
      {error !== null && <p className="ba-collab__error" role="alert">{error}</p>}
    </div>
  );
}

/** 容量(契约 §4):在线 / 手上几件 / 未收场几件 / 能接几件,四个事实分开,上限取不到 = 未知。 */
function useCapacity(client: ApiClient, enabled: boolean, refreshToken: readonly TaskView[]): { items: RawCapacity[] | undefined; error: string | undefined; reload(): void } {
  const [items, setItems] = useState<RawCapacity[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    client.json<unknown>('/collab/capacity', { method: 'GET' }).then((res) => {
      if (!alive) return;
      if (res.ok) {
        const got = guardCapacity(res.data);
        if (got === undefined) setError('工作台回的容量格式不认识');
        else { setItems(got); setError(undefined); }
      }
      else setError(res.error || '读不到容量');
    }).catch(() => { if (alive) setError('读不到容量'); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, round, refreshToken]);
  return { items, error, reload: () => setRound((r) => r + 1) };
}

/**
 * 按人的安排(设计交接 3.2 的手机清单版):约定(due/start/end 排期) / 实际时刻未知 /
 * 真实运行片段(core §4) / 容量事实;未知不编。
 */
function ScheduleSection(props: {
  tasks: readonly TaskView[];
  runs: RunsSnapshot;
  fields: (t: TaskView) => CollabFields;
  actors: ActorContext;
  now: string;
  client: ApiClient;
  onOpenTask(taskId: string): void;
}) {
  const { tasks, fields, actors, now, client, runs, onOpenTask } = props;
  const capacity = useCapacity(client, true, tasks);
  const runsByTask = new Map<string, RawRunSegment[]>();
  for (const run of runs.items ?? []) runsByTask.set(run.taskId, [...(runsByTask.get(run.taskId) ?? []), run]);
  const byPerson = new Map<string, TaskView[]>();
  for (const t of tasks) {
    const who = t.assignee ?? '';
    const list = byPerson.get(who) ?? [];
    list.push(t);
    byPerson.set(who, list);
  }
  const people = [...byPerson.entries()];
  const unknownTasks = tasks.filter((t) => timeFactsOf(t, fields, now).plannedDate === undefined
    && timeFactsOf(t, fields, now).actual === undefined);
  return (
    <section aria-label="按人的安排">
      <h3 className="ba-collab__sub">安排 <span className="ba-collab__n">计划 / 派出与执行记录 / 容量分开</span></h3>
      {capacity.error !== undefined && <p className="ba-collab__unwired">容量这会儿读不到:{capacity.error}</p>}
      {runs.error !== undefined && <p className="ba-collab__unwired">派出与执行记录读不到:{runs.error}</p>}
      {(capacity.items?.length ?? 0) > 0 && (
        <div className="ba-collab__facts">
          {capacity.items?.map((item) => (
            <div key={item.id} className="ba-collab__fact">
              <span className="ba-collab__factk">容量</span>
              <span className="ba-collab__factv">{capacityLine(item, actors)}</span>
            </div>
          ))}
        </div>
      )}
      {people.length === 0 && (capacity.items?.length ?? 0) === 0 && <p className="ba-collab__empty">这个范围里还没有事项。</p>}
      {people.map(([who, list]) => (
        <div key={who}>
          <h3 className="ba-collab__sub">{actorLabel(who, actors)} <span className="ba-collab__n">{list.length} 件</span></h3>
          {list.map((t) => {
            const f = timeFactsOf(t, fields, now);
            const stale = staleOf(t.updated_at, now);
            return (
              <div key={t.id} className="ba-collab__fact">
                <span className="ba-collab__factk">计划</span>
                <span className="ba-collab__factv">
                  <span className="ba-collab__planline">{plannedTimeLine(f)}</span>
                  <button type="button" className="ba-collab__linkbtn" onClick={() => onOpenTask(t.id)}>{t.title}</button>
                  {' · '}
                  {f.actual !== undefined
                    ? `实际 ${friendlyWhen(f.actual.start, now)} 起${f.actual.end !== undefined ? ` → ${friendlyWhen(f.actual.end, now)} 止` : '(只有开始时刻)'}`
                    : `实际时间未知${f.unknown.length > 0 ? ` · ${f.unknown.join('、')}` : ''}`}
                  {runs.items !== undefined && (runsByTask.get(t.id) ?? []).map((run, index) => (
                    <span key={`${run.startedAt}:${index}`}> · 派出与执行记录:{runSegmentLine(run)} · {run.source} · 记录时间 {friendlyWhen(run.startedAt, now)}{run.finishedAt !== undefined ? ` → 收场 ${friendlyWhen(run.finishedAt, now)}` : ''}</span>
                  ))}
                  {runs.items !== undefined && (runsByTask.get(t.id)?.length ?? 0) === 0 && ' · 派出与执行记录:没有记录'}
                  {stale && ' · 记录过旧'}
                </span>
              </div>
            );
          })}
        </div>
      ))}
      {unknownTasks.length > 0 && (
        <p className="ba-collab__unwired">
          {unknownTasks.length} 件没有计划也没有实际记录,进「未安排/未知」,没替它们编时间。
        </p>
      )}
    </section>
  );
}
