/**
 * 协作区页(2026-10-24,卡「完整手机协作下级页」,小K)。
 *
 * 首页的下一级(与事项/资讯同级):目标 / 事项 / 频道三个分区。
 * 事实来自 `GET /state` 与 core 的 board/activity/runs/capacity/LAN/relay 投影:
 * - 目标:冲刺/范围选择(范围始终标明)→ 目标 → 条件(按条件算)+ 派盯分桶清单;
 * - 事项:同一批事的六个状态桶,目标可用性另外按条件交付记录算,
 *   父子不双计;点开看连续活动流、留言(只记录,走待发箱)、关系与时间事实;
 * - 频道:事务官聊天室,人类**只读**,没有发送框。
 *
 * 未纳管、读不到或失联一律保留未知；LAN 与 relay 的来源分别标明。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { WAIT_REASON_TITLES, friendlyWhen, type TaskView, type WorkbenchState } from '../api/protocol';
import { useFeed } from '../hooks';
import { useSession } from '../session';
import { useBackHandler } from '../nav/back';
import {
  COLLAB_BUCKET_HINTS,
  COLLAB_BUCKETS,
  COLLAB_BUCKET_TITLES,
  actorName,
  actorLabel,
  boardRows,
  bucketCounts,
  rowsOfBucket,
  type ActorContext,
  type BoardGroup,
  type BoardRow,
} from './collabModel';
import {
  UNSORTED_GOAL_ID,
  collabCards,
  collabFields,
  collabGoals,
  collabSprints,
  goalIdOfTask,
  guardGoalConditions,
  relayTickOf,
  type CollabFields,
} from './collabState';
import { useRuns, type RunsSnapshot } from './useRuns';
import { runSegmentLine, type RawRunSegment } from './collabCore';
import { GoalPanel } from './GoalPanel';
import { TaskSheet } from './TaskSheet';
import { ChannelPanel } from './ChannelPanel';
import { useStudio } from './useStudio';
import './collab.css';

/** 从首页/事项页带进来的落点(同一个对象只认一次,照事项页的 handled 模式)。 */
export interface CollabTarget {
  goalId?: string;
  taskId?: string;
}

type CollabTab = 'goals' | 'tasks' | 'channel';
type CollabView = { name: 'home' } | { name: 'goal'; goalId: string } | { name: 'task'; taskId: string };

/** 范围:全部 / 未归目标 / 某 sprint(父组不双计随范围走)。 */
type Scope = 'all' | 'unsorted' | `sprint:${string}`;

const UNSORTED_TITLE = '未归目标';

export function CollabPage({ target, onOpenItem }: { target?: CollabTarget; onOpenItem?(taskId: string): void } = {}) {
  const session = useSession();
  const feed = useFeed(session.feed);
  const state = feed.state;

  const [tab, setTab] = useState<CollabTab>('goals');
  const [scope, setScope] = useState<Scope>('all');
  const [view, setView] = useState<CollabView>({ name: 'home' });
  useBackHandler(view.name !== 'home', () => setView({ name: 'home' }));

  // —— 真实快照 + 运行时守卫 ——
  const goals = useMemo(() => guardGoalConditions(collabGoals(state.tasks)), [state.tasks]);
  const sprints = useMemo(() => collabSprints(state.tasks), [state.tasks]);
  const cards = useMemo(() => collabCards(state.tasks), [state.tasks]);
  const tick = relayTickOf(state);
  const studio = useStudio(session.client, tick);
  const actors: ActorContext = useMemo(
    () => ({ cards, members: studioMembersMap(studio.studio) }),
    [cards, studio.studio],
  );
  const fields = collabFields;
  const channelProjects = useMemo(() => {
    const names = new Map((state.projects?.projects ?? []).map((project) => [project.id, project.name]));
    const ids = new Set((state.tasks?.tasks ?? []).flatMap((task) => task.project_id === undefined ? [] : [task.project_id]));
    for (const goal of goals) if (goal.projectId !== undefined) ids.add(goal.projectId);
    return [...ids].map((id) => ({ id, name: names.get(id) ?? id }));
  }, [state.projects, state.tasks, goals]);

  const tasks = useMemo(() => {
    const all: readonly TaskView[] = state.tasks?.tasks ?? [];
    if (scope === 'all') return all;
    if (scope === 'unsorted') return all.filter((t) => goalIdOfTask(t) === UNSORTED_GOAL_ID);
    const sprintId = scope.slice('sprint:'.length);
    const sprint = sprints.find((s) => s.id === sprintId);
    if (sprint === undefined) return all;
    return all.filter((t) => sprint.goalIds.includes(goalIdOfTask(t)));
  }, [state.tasks, scope, sprints]);

  const runs = useRuns(session.client, tasks, view.name === 'home' && tab === 'tasks', state.now);

  // 范围只筛清单；依赖/交接仍可打开范围外的真实事项。
  const taskById = useMemo(() => new Map((state.tasks?.tasks ?? []).map((t) => [t.id, t])), [state.tasks]);

  // 落点:认到了才跳;认不到等下一拍 /state。
  const handled = useRef<CollabTarget | undefined>(undefined);
  useEffect(() => {
    if (target === undefined || handled.current === target) return;
    if (target.taskId !== undefined) {
      if (!taskById.has(target.taskId)) return;
      handled.current = target;
      setView({ name: 'task', taskId: target.taskId });
      setTab('tasks');
      return;
    }
    if (target.goalId !== undefined) {
      handled.current = target;
      setView({ name: 'goal', goalId: target.goalId });
      setTab('goals');
    }
  }, [target, taskById]);

  const openTask = (taskId: string) => {
    if (taskById.has(taskId)) setView({ name: 'task', taskId });
  };
  const openGoal = (goalId: string) => setView({ name: 'goal', goalId });

  // 掉线那句话(更新暂不可达 = 摆上次已知状态)在所有下级视图都摆,不只是 tab 首页。
  const offlineLine = !feed.connected ? (
    <p className="ba-chat__offline" role="status">
      {feed.connecting === true ? '正在连接电脑…' : (feed.error ?? '工作台掉线,显示的是上次的状态')}
    </p>
  ) : null;
  /** 下级视图(goal/task)的统一外框:上面那条掉线话 + 可滚的身体。 */
  const framed = (body: React.ReactNode) => (
    <div className="ba-collab">
      {offlineLine}
      <div className="ba-collab__body">{body}</div>
    </div>
  );

  // —— 视图 ——
  if (view.name === 'goal') {
    const goal = view.goalId === UNSORTED_GOAL_ID
      ? { id: UNSORTED_GOAL_ID, title: UNSORTED_TITLE }
      : goals.find((g) => g.id === view.goalId);
    if (goal === undefined) {
      // 目标没了(被删/老数据):如实说明,不白屏。
      return framed((
        <>
          <p className="ba-collab__empty">这个目标不在当前状态里了(可能刚被挪走)。</p>
          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setView({ name: 'home' })}>返回协作区</button>
        </>
      ));
    }
    const goalTasks = (state.tasks?.tasks ?? []).filter((t) => goalIdOfTask(t) === goal.id);
    return framed((
      <GoalPanel
        goal={goal}
        tasks={goalTasks}
        fields={fields}
        actors={actors}
        now={state.now}
        client={session.client}
        onRefresh={() => session.feed.refresh()}
        onOpenTask={openTask}
      />
    ));
  }

  if (view.name === 'task') {
    const task = taskById.get(view.taskId);
    if (task === undefined) {
      return framed((
        <>
          <p className="ba-collab__empty">这张卡不在当前清单里了。</p>
          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setView({ name: 'home' })}>返回协作区</button>
        </>
      ));
    }
    return framed((
      <TaskSheet
        task={task}
        allTasks={state.tasks?.tasks ?? []}
        goals={goals}
        fields={fields}
        actors={actors}
        now={state.now}
        sessions={state.sessions}
        outbox={session.outbox}
        client={session.client}
        draftScope={session.pairing.deviceId}
        onOpenTask={openTask}
        onOpenGoal={openGoal}
        onOpenItem={onOpenItem}
      />
    ));
  }

  // —— 首页(三 tab)——
  const scopeLabel = scope === 'all' ? '全部目标'
    : scope === 'unsorted' ? UNSORTED_TITLE
      : (sprints.find((s) => `sprint:${s.id}` === scope)?.title ?? '范围');

  return (
    <div className="ba-collab">
      <div className="ba-inbox__tabs" role="tablist" aria-label="协作分区">
        {([['goals', '目标'], ['tasks', '事项'], ['channel', '频道']] as const).map(([key, label]) => (
          <button key={key} type="button" role="tab" className="ba-inbox__tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="ba-collab__body">
        {offlineLine}

        {tab !== 'channel' && (
          <>
            <div className="ba-collab__scopes" role="group" aria-label="范围">
              <button type="button" className="ba-collab__scope" data-on={scope === 'all'} onClick={() => setScope('all')}>全部</button>
              {sprints.map((s) => (
                <button key={s.id} type="button" className="ba-collab__scope" data-on={scope === `sprint:${s.id}`} onClick={() => setScope(`sprint:${s.id}`)}>
                  {s.title}
                </button>
              ))}
              <button type="button" className="ba-collab__scope" data-on={scope === 'unsorted'} onClick={() => setScope('unsorted')}>{UNSORTED_TITLE}</button>
            </div>
            <p className="ba-collab__rangenote" role="note">
              当前范围:{scopeLabel} · 取消单列不算达成 · 父子不重复计数
            </p>
          </>
        )}

        {tab === 'goals' && (
          <GoalsHome
            state={state}
            goals={goals}
            sprints={sprints}
            scope={scope}
            fields={fields}
            onOpenGoal={openGoal}
          />
        )}
        {tab === 'tasks' && (
          <BucketBoard
            tasks={tasks}
            runs={runs}
            fields={fields}
            actors={actors}
            now={state.now}
            onOpenTask={openTask}
            emptyText="这个范围里还没有事项。"
          />
        )}
        {tab === 'channel' && (
          <ChannelPanel
            client={session.client}
            studio={studio}
            tick={tick}
            now={state.now}
            projects={channelProjects}
            refreshToken={state.tasks}
          />
        )}
      </div>
    </div>
  );
}

function studioMembersMap(studio: ReturnType<typeof useStudio>['studio']): Readonly<Record<string, string>> {
  if (studio?.state !== 'joined') return {};
  const out: Record<string, string> = {};
  for (const m of studio.members) out[m.accountId] = m.nick ?? m.accountId;
  return out;
}

/** 目标 tab:范围里的目标清单(范围=全部时含「未归目标」)。 */
function GoalsHome(props: {
  state: WorkbenchState;
  goals: ReturnType<typeof collabGoals>;
  sprints: ReturnType<typeof collabSprints>;
  scope: Scope;
  fields: (t: TaskView) => CollabFields;
  onOpenGoal(goalId: string): void;
}) {
  const { state, goals, sprints, scope, fields, onOpenGoal } = props;
  const allTasks = state.tasks?.tasks ?? [];
  const visible = goals.filter((g) => {
    if (scope === 'all') return true;
    if (scope === 'unsorted') return false;
    const sprint = sprints.find((s) => `sprint:${s.id}` === scope);
    return sprint?.goalIds.includes(g.id) ?? false;
  });
  const unsortedCount = Object.values(bucketCounts(boardRows(allTasks.filter((t) => goalIdOfTask(t) === UNSORTED_GOAL_ID), fields))).reduce((a, b) => a + b, 0);
  const goalCounts = (goalId: string) => bucketCounts(boardRows(allTasks.filter((t) => goalIdOfTask(t) === goalId), fields));

  return (
    <>
      {visible.length === 0 && (scope === 'unsorted' || unsortedCount === 0) && (
        <p className="ba-collab__empty">这个范围里还没有目标。</p>
      )}
      {visible.map((g) => {
        const counts = goalCounts(g.id);
        const open = counts.doing + counts.todo + counts.blocked + counts.confirm;
        return (
          <button key={g.id} type="button" className="ba-collab__goal" onClick={() => onOpenGoal(g.id)}>
            <span className="ba-collab__goaltitle">
              {g.title}
              {g.status !== undefined && g.status !== 'open' && (
                <span className="ba-collab__tag" data-tone={g.status === 'reached' ? 'ok' : undefined}>{g.status === 'reached' ? '已达成' : '已放弃'}</span>
              )}
              {g.due !== undefined && <span className="ba-collab__tag">截止 {g.due}</span>}
            </span>
            <span className="ba-collab__counts">
              在推 <b>{open}</b> 件 · 已完成 <b>{counts.done}</b> · 交回待验 <b>{counts.confirm}</b>
              {counts.blocked > 0 && <> · 受阻 <b>{counts.blocked}</b></>}
              {counts.canceled > 0 && <> · 取消 {counts.canceled}</>}
            </span>
          </button>
        );
      })}
      {(scope === 'all' || scope === 'unsorted') && unsortedCount > 0 && (
        <button type="button" className="ba-collab__goal" onClick={() => onOpenGoal(UNSORTED_GOAL_ID)}>
          <span className="ba-collab__goaltitle">{UNSORTED_TITLE}</span>
          <span className="ba-collab__counts">{unsortedCount} 件还没贴进任何目标</span>
        </button>
      )}
    </>
  );
}

/**
 * 分桶清单(目标详情与事项 tab 同用):已完成 / 状态进行中 / 未开始 / 受阻 / 交回待验 / 取消单列。
 * 每行给:负责人、最近真实回执与时间、受阻原因与下一接手;记录过旧单独标。
 */
export function BucketBoard(props: {
  tasks: readonly TaskView[];
  runs: RunsSnapshot;
  fields: (t: TaskView) => CollabFields;
  actors: ActorContext;
  now: string;
  onOpenTask(taskId: string): void;
  emptyText: string;
}) {
  const { tasks, fields, actors, now, onOpenTask, emptyText, runs } = props;
  const rows = useMemo(() => boardRows(tasks, fields), [tasks, fields]);
  const counts = bucketCounts(rows);
  const total = COLLAB_BUCKETS.reduce((n, b) => n + counts[b], 0);
  if (total === 0) return <p className="ba-collab__empty">{emptyText}</p>;
  return (
    <>
      <ExecutionBoard tasks={tasks} fields={fields} actors={actors} runs={runs} onOpenTask={onOpenTask} />
      {COLLAB_BUCKETS.map((bucket) => {
        const inBucket = rowsOfBucket(rows, bucket);
        if (counts[bucket] === 0) return null;
        return (
          <section key={bucket} aria-label={COLLAB_BUCKET_TITLES[bucket]}>
            <h3 className="ba-collab__sub">
              {COLLAB_BUCKET_TITLES[bucket]} <span className="ba-collab__n">{counts[bucket]} 件</span>
              <span className="ba-collab__n">· {COLLAB_BUCKET_HINTS[bucket]}</span>
            </h3>
            {inBucket.length === 0 && <p className="ba-collab__n">组内事项见父组清单</p>}
            {inBucket.map((row, i) => (
              <RowButton
                key={row.kind === 'task' ? row.task.id : row.group.parent.id}
                row={row}
                fields={fields}
                actors={actors}
                now={now}
                onOpen={onOpenTask}
                index={i}
              />
            ))}
          </section>
        );
      })}
    </>
  );
}

function RowButton(props: {
  row: BoardRow;
  fields: (t: TaskView) => CollabFields;
  actors: ActorContext;
  now: string;
  onOpen(taskId: string): void;
  index: number;
}) {
  const { row, fields, actors, now, onOpen } = props;
  const parent = row.kind === 'group' ? row.group.parent : row.task;
  const open = () => onOpen(parent.id);
  return (
    <button type="button" className="ba-collab__row" data-bucket={row.bucket} onClick={open}>
      <span className="ba-collab__rowtitle">
        {parent.title}
        {row.kind === 'group' && <GroupSummary group={row.group} />}
      </span>
      <RowMeta task={parent} bucket={row.bucket} fields={fields} actors={actors} now={now} />
    </button>
  );
}

function GroupSummary({ group }: { group: BoardGroup }) {
  const parts = COLLAB_BUCKETS
    .filter((b) => group.counts[b] > 0)
    .map((b) => `${COLLAB_BUCKET_TITLES[b]} ${group.counts[b]}`);
  return <span className="ba-collab__tag">{`组 · ${group.total} 件:${parts.join(' · ')}`}</span>;
}

/** 一行卡的事实行:负责人 / 最近回执与时间 / 受阻原因与下一接手 / 记录过旧。 */
export function RowMeta(props: {
  task: TaskView;
  bucket: string;
  fields: (t: TaskView) => CollabFields;
  actors: ActorContext;
  now: string;
}) {
  const { task, bucket, fields, actors, now } = props;
  const receipt = fields(task).receipt;
  const stale = staleOf(task.updated_at, now);
  const pieces: string[] = [];
  pieces.push(actorName(task.assignee, actors));
  if (receipt !== undefined) {
    pieces.push(`回执 ${friendlyWhen(receipt.at, now)} · ${receipt.text}`);
  } else {
    pieces.push(`更新 ${friendlyWhen(task.updated_at, now)}`);
  }
  if (stale) pieces.push('记录过旧');
  if (bucket === 'blocked') {
    const reason = task.block_reason === undefined ? undefined : WAIT_REASON_TITLES[task.block_reason];
    const next = task.standing?.next;
    pieces.push([reason, next === undefined ? undefined : `下一手:${next}`].filter((s) => s !== undefined).join(' · '));
  }
  return (
    <span className="ba-collab__rowmeta">
      {pieces.map((p, i) => (
        <span key={i} className={p === '记录过旧' ? 'ba-collab__stale' : i > 0 ? 'ba-collab__dotsep' : undefined}>{p}</span>
      ))}
    </span>
  );
}

/** 超过 STALE_DAYS 天没动 = 记录过旧。now 是电脑的钟。 */
export function staleOf(updatedAt: string, now: string): boolean {
  const u = Date.parse(updatedAt);
  const n = Date.parse(now);
  if (!Number.isFinite(u) || !Number.isFinite(n)) return false;
  return n - u > 7 * 24 * 60 * 60 * 1000;
}

const EXECUTION_TITLES: Readonly<Record<string, string>> = {
  running: '实际执行中(有开工回执)', dispatched: '已派出,开工未确认', unknown: '失联或记录过旧',
  paused: '有等待/暂停记录(开工未知)', done: '执行已收场(成果另看回执)', failed: '收到失败收场记录', missing: '执行状态未知(没有运行记录)',
};
function ExecutionBoard({ tasks, fields, actors, runs, onOpenTask }: {
  tasks: readonly TaskView[]; fields: (task: TaskView) => CollabFields; actors: ActorContext; runs: RunsSnapshot; onOpenTask(id: string): void;
}) {
  const latest = new Map<string, RawRunSegment>();
  for (const run of runs.items ?? []) {
    const previous = latest.get(run.taskId);
    if (previous === undefined || Date.parse(run.startedAt) >= Date.parse(previous.startedAt)) latest.set(run.taskId, run);
  }
  const leaves = [...new Map(tasks.filter((task) => (fields(task).children?.length ?? 0) === 0).map((task) => [task.id, task])).values()];
  return <section aria-label="执行状态">
    <h3 className="ba-collab__sub">执行状态 <span className="ba-collab__n">只计叶事项,父组不重复计数</span></h3>
    {runs.error !== undefined && <p className="ba-collab__error">运行事实读不到:{runs.error}{runs.items !== undefined ? ' · 下面是本范围上次读到的执行状态,当前状态未知' : ''}</p>}
    {runs.loading && <p className="ba-collab__n">正在读执行状态…</p>}
    {Object.entries(EXECUTION_TITLES).map(([status, title]) => {
      const list = leaves.filter((task) => (latest.get(task.id)?.status ?? 'missing') === status);
      if (list.length === 0) return null;
      return <div key={status}>
        <h4 className="ba-collab__sub">{title} <span className="ba-collab__n">{list.length} 件</span></h4>
        {list.map((task) => <div key={task.id} className="ba-collab__executionrow">
          <button type="button" className="ba-collab__linkbtn" onClick={() => onOpenTask(task.id)}>{task.title}</button>
          <span className="ba-collab__factv">{actorLabel(task.assignee, actors)}{latest.get(task.id) === undefined ? '' : ` · ${runSegmentLine(latest.get(task.id)!)}`}</span>
        </div>)}
      </div>;
    })}
  </section>;
}
