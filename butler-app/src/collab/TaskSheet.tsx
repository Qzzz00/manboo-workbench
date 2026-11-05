/**
 * 事项详情(2026-10-24,小K,阶段 2:接 core 真实活动流 / 关系 / 留言投递)。
 *
 * - 活动流:`GET /collab/note/activity?id=` —— message(带投递状态)/ comment / receipt /
 *   transition(状态经手)/ run(运行片段)按时间合一,读侧口径唯一;读不到显示上次已知 + 重试。
 * - 关系:`GET /collab/relations?task_id=` —— 五种关系(父子仍走 children),stale 现算
 *   (上游重开 → 旧交接标「需复核」,不回滚已发生的事);清单跳转,不画线。
 * - 留言:`POST /collab/note/message`(client_msg_id 幂等);默认只留记录,「请它处理」
 *   真投递,逐个名片回状态(受理/送达/处理/失败带原因);走待发箱断网暂存恢复补发。
 * - 轮次:重开/退回 round+1,页上如实摆第几轮;旧核验失效由条件侧(core B)现算。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  STATUS_TITLES,
  WAIT_REASON_TITLES,
  friendlyWhen,
  type SessionView,
  type TaskView,
} from '../api/protocol';
import type { ApiClient } from '../api/client';
import { SEND_OUTBOX_AUTO_MS, type SendOutbox } from '../outbox/sendOutbox';
import {
  COLLAB_BUCKET_TITLES,
  actorName,
  bucketOf,
  timeFactsOf,
  plannedTimeLine,
  type ActorContext,
} from './collabModel';
import {
  guardActivityItems,
  guardRelations,
  runSegmentLine,
  type RawActivityItem,
  type RelationRow,
} from './collabCore';
import { DeliveryList } from './DeliveryList';
import {
  UNSORTED_GOAL_ID,
  goalIdOfTask,
  guardTaskCollab,
  type CollabFields,
  type RawGoal,
} from './collabState';
import {
  COMMENT_INTENTS,
  MESSAGE_PATH,
  composeComment,
  intentLine,
  type CommentIntent,
} from './comments';
import { staleOf } from './CollabPage';
import { Markdown } from '../ui/Markdown';
import { readCollabDraft, saveCollabDraft } from './collabDrafts';

const RECEIPT_KIND_TITLES: Readonly<Record<string, string>> = {
  done: '做完', objection: '有异议', blocked: '卡住',
};

export function TaskSheet(props: {
  task: TaskView;
  allTasks: readonly TaskView[];
  goals: readonly RawGoal[];
  fields: (t: TaskView) => CollabFields;
  actors: ActorContext;
  now: string;
  sessions: readonly SessionView[];
  outbox: SendOutbox | undefined;
  client: ApiClient;
  draftScope: string;
  onOpenItem?(id: string): void;
  onOpenTask(taskId: string): void;
  onOpenGoal(goalId: string): void;
}) {
  const { task, allTasks, goals, fields, actors, now, sessions, outbox, client, onOpenTask, onOpenGoal } = props;
  const f = fields(task);
  const tc = guardTaskCollab(task);
  const bucket = bucketOf(task.status);
  const goalId = goalIdOfTask(task);
  const goalTitle = goalId === UNSORTED_GOAL_ID ? undefined : goals.find((g) => g.id === goalId)?.title;
  const time = timeFactsOf(task, fields, now);
  const stale = staleOf(task.updated_at, now);
  const parent = allTasks.find((t) => (fields(t).children ?? []).includes(task.id));
  const children = (f.children ?? [])
    .map((c) => allTasks.find((t) => t.id === c))
    .filter((t): t is TaskView => t !== undefined);
  const collaborators = [...new Set([...(f.collaborators ?? []), ...(f.watchers ?? [])])];
  const dispatchEvidence = task.client_dispatch === undefined || task.dispatch !== undefined && (Date.parse(task.dispatch.started_at) || 0) >= (Date.parse(task.client_dispatch.at) || 0) ? task.dispatch : task.client_dispatch;
  const returnedReply = (task.client_dispatch?.reply?.trim() || task.dispatch?.reply?.trim()) || undefined;

  const activity = useActivity(client, task.id, task);
  const relations = useRelations(client, task.id, allTasks, fields, task);
  const fromLine = f.from !== undefined
    ? `${fromTitle(f.from.kind)}${f.from.ref !== undefined ? ` · ${f.from.ref}` : ''}`
    : (task.source?.kind === 'session' || task.source?.kind === 'meeting')
      ? `${fromTitle(task.source.kind)}${task.source.ref !== undefined ? ` · ${task.source.ref}` : ''}`
      : undefined;

  return (
    <>
      <header>
        <h2 className="ba-collab__goaltitle" style={{ fontSize: 'var(--ba-fs-title)' }}>
          {task.title}
          <span className="ba-collab__tag" data-tone={bucket === 'blocked' ? 'bad' : bucket === 'confirm' ? 'warn' : bucket === 'done' ? 'ok' : undefined}>
            {COLLAB_BUCKET_TITLES[bucket]}
          </span>
          {tc.round > 1 && <span className="ba-collab__tag" data-tone="warn">第 {tc.round} 轮</span>}
          {stale && <span className="ba-collab__tag" data-tone="warn">记录过旧</span>}
        </h2>
        <p className="ba-collab__meta">
          负责人 {actorName(task.assignee, actors)}
          {task.assignee_note !== undefined && ` · ${task.assignee_note}`}
          {' · '}更新 {friendlyWhen(task.updated_at, now)}
          {goalId !== UNSORTED_GOAL_ID && (
            <>
              {' · '}归在
              <button type="button" className="ba-collab__linkbtn" onClick={() => onOpenGoal(goalId)}>
                {goalTitle ?? '一个当前清单里没有的目标'}
              </button>
            </>
          )}
        </p>
        {task.block_reason !== undefined && bucket === 'blocked' && (
          <p className="ba-collab__notice">受阻:{WAIT_REASON_TITLES[task.block_reason]}
            {task.standing?.next !== undefined && ` · 下一手:${task.standing.next}`}
          </p>
        )}
      </header>

      {props.onOpenItem !== undefined && <button type="button" className="ba-btn ba-btn--ghost" onClick={() => props.onOpenItem?.(task.id)}>打开原事项操作</button>}

      <section aria-label="连续活动">
        <h3 className="ba-collab__sub">连续活动 <span className="ba-collab__n">留言·回执·经手·运行</span></h3>
        {activity.error !== undefined && (
          <p className="ba-collab__error" role="alert">
            {activity.error}
            <button type="button" className="ba-collab__linkbtn" onClick={activity.reload}>再读一次</button>
            {activity.items.length > 0 && ' · 下面是上次读到的'}
          </p>
        )}
        {fromLine !== undefined && (
          <div className="ba-collab__act">
            <span className="ba-collab__actic" aria-hidden>源</span>
            <div className="ba-collab__actbody">
              <div className="ba-collab__acthead">{fromLine}</div>
              {f.from?.quote !== undefined && <div className="ba-collab__actquote">{f.from.quote}</div>}
            </div>
          </div>
        )}
        <SessionFacts task={task} sessions={sessions} now={now} />
        {activity.items.length === 0 && activity.error === undefined
          ? <p className="ba-collab__empty">{activity.loading ? '正在读活动账…' : '这件事还没有任何记录。'}</p>
          : activity.items.map((item, i) => <ActivityRow key={`${item.type}:${i}`} item={item} actors={actors} now={now} onOpenTask={onOpenTask} />)}
      </section>

      {dispatchEvidence?.selection !== undefined && <p>{dispatchEvidence.selection.reason}</p>}
      {dispatchEvidence?.runtime !== undefined && <p>{[
        dispatchEvidence.runtime.observed.model,
        dispatchEvidence.runtime.observed.effort === undefined ? undefined : `思考档${({ minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '最高', off: '关闭', on: '开启' } as Record<string, string>)[dispatchEvidence.runtime.observed.effort] ?? '未识别'}`,
        dispatchEvidence.runtime.status === 'verified' ? '已核实' : dispatchEvidence.runtime.status === 'mismatch' ? '运行档位与请求不符' : '运行模型与思考档未核实',
      ].filter(Boolean).join('；')}</p>}
      {(returnedReply !== undefined || task.deliverables !== undefined && task.deliverables.length > 0 || (f.receipt?.evidence?.length ?? 0) > 0) && (
        <section aria-label="成果与证据">
          <h3 className="ba-collab__sub">成果与证据</h3>
          {returnedReply !== undefined && <>
            <h4 className="ba-collab__sub">最近交回正文</h4>
            <Markdown text={returnedReply} />
            {tc.round > 1 && <p className="ba-collab__unwired">重开后本轮是否完成,以新的回执与核验为准。</p>}
          </>}
          <div className="ba-collab__facts">
            {(task.deliverables ?? []).map((d) => (
              <div key={d.ref} className="ba-collab__fact">
                <span className="ba-collab__factk">交付物</span>
                <span className="ba-collab__factv">{d.ref}{d.kind !== '' ? `(${d.kind})` : ''}</span>
              </div>
            ))}
            {(f.receipt?.evidence ?? []).map((e) => (
              <div key={e} className="ba-collab__fact">
                <span className="ba-collab__factk">回执证据</span>
                <span className="ba-collab__factv">{e}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-label="关系">
        <h3 className="ba-collab__sub">关系 <span className="ba-collab__n">清单跳转,不画线</span></h3>
        <div className="ba-collab__facts">
          {parent !== undefined && (
            <RelationJump k="所属组" title={parent.title} onClick={() => onOpenTask(parent.id)} />
          )}
          {children.map((c) => (
            <RelationJump key={c.id} k="子卡" title={c.title} onClick={() => onOpenTask(c.id)} />
          ))}
          {fromLine !== undefined && (
            <div className="ba-collab__fact">
              <span className="ba-collab__factk">从哪来</span>
              <span className="ba-collab__factv">{fromLine}</span>
            </div>
          )}
          {collaborators.length > 0 && (
            <div className="ba-collab__fact">
              <span className="ba-collab__factk">协作/关注</span>
              <span className="ba-collab__factv">{collaborators.map((c) => actorName(c, actors)).join('、')}</span>
            </div>
          )}
          {relations.error !== undefined && (
            <div className="ba-collab__fact">
              <span className="ba-collab__factk">关系</span>
              <span className="ba-collab__factv ba-collab__error">
                {relations.error}
                <button type="button" className="ba-collab__linkbtn" onClick={relations.reload}>再读一次</button>
              </span>
            </div>
          )}
          {relations.rows.map((row) => (
            <RelationFactRow key={row.id} row={row} titleOf={relations.titleOf} onOpen={onOpenTask} />
          ))}
          {relations.rows.length === 0 && relations.error === undefined && !relations.loading && (
            <div className="ba-collab__fact">
              <span className="ba-collab__factk">依赖/交接</span>
              <span className="ba-collab__factv">这张卡还没有依赖 / 交接 / 退回关系(父子在上面单列)</span>
            </div>
          )}
          <div className="ba-collab__fact">
            <span className="ba-collab__factk">轮次</span>
            <span className="ba-collab__factv">
              第 {tc.round} 轮{tc.round > 1 ? '(重开/退回后轮次 +1,旧核验失效)' : ''}
            </span>
          </div>
        </div>
      </section>

      <section aria-label="时间">
        <h3 className="ba-collab__sub">时间 <span className="ba-collab__n">真实片段与未知分开</span></h3>
        <div className="ba-collab__facts">
          <div className="ba-collab__fact">
            <span className="ba-collab__factk">计划</span>
            <span className="ba-collab__factv">
              {plannedTimeLine(time)}
            </span>
          </div>
          <div className="ba-collab__fact">
            <span className="ba-collab__factk">实际</span>
            <span className="ba-collab__factv">
              {time.actual !== undefined
                ? `${friendlyWhen(time.actual.start, now)} 起${time.actual.end !== undefined ? ` → ${friendlyWhen(time.actual.end, now)} 止` : '(只有开始时刻)'}`
                : '实际时间未知'}
            </span>
          </div>
        </div>
      </section>

      <CommentComposer key={`${props.draftScope}:${task.id}`} draftScope={props.draftScope} taskId={task.id} actors={actors} outbox={outbox} client={client} now={now} onSent={activity.reload} />
    </>
  );
}

/* —— 活动流 —— */

function useActivity(client: ApiClient, taskId: string, refreshToken: TaskView): { items: RawActivityItem[]; error: string | undefined; loading: boolean; reload(): void } {
  const [snapshot, setSnapshot] = useState<{ client: ApiClient; id: string; items: RawActivityItem[]; error?: string; loading: boolean }>({ client, id: taskId, items: [], loading: true });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true;
    setSnapshot((old) => old.id === taskId && old.client === client ? { ...old, loading: true } : { client, id: taskId, items: [], loading: true });
    client.json<unknown>(`/collab/note/activity?id=${encodeURIComponent(taskId)}`, { method: 'GET' })
      .then((res) => {
        if (!alive) return;
        if (res.ok) {
          const got = guardActivityItems(res.data);
          if (got === undefined) setSnapshot((old) => ({ ...old, error: '工作台回的活动账格式不认识' }));
          else { setSnapshot({ client, id: taskId, items: got, loading: false }); }
        } else setSnapshot((old) => ({ ...old, error: res.error || '读不到活动账' }));
      })
      .catch(() => { if (alive) setSnapshot((old) => ({ ...old, error: '读不到活动账' })); })
      .finally(() => { if (alive) setSnapshot((old) => ({ ...old, loading: false })); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, taskId, round, refreshToken]);
  const current = snapshot.id === taskId && snapshot.client === client ? snapshot : { items: [], loading: true, error: undefined };
  return { ...current, error: current.error, reload: () => { setRound((r) => r + 1); } };
}

function useRelations(
  client: ApiClient,
  taskId: string,
  allTasks: readonly TaskView[],
  fields: (t: TaskView) => CollabFields,
  refreshToken: TaskView,
): { rows: RelationRow[]; error: string | undefined; loading: boolean; reload(): void; titleOf(id: string): string } {
  const [snapshot, setSnapshot] = useState<{ client: ApiClient; id: string; rows: RelationRow[]; error?: string; loading: boolean }>({ client, id: taskId, rows: [], loading: true });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true;
    setSnapshot((old) => old.id === taskId && old.client === client ? { ...old, loading: true } : { client, id: taskId, rows: [], loading: true });
    client.json<unknown>(`/collab/relations?task_id=${encodeURIComponent(taskId)}`, { method: 'GET' })
      .then((res) => {
        if (!alive) return;
        if (res.ok) {
          const got = guardRelations(res.data, taskId);
          if (got === undefined) setSnapshot((old) => ({ ...old, error: '工作台回的关系格式不认识' }));
          else { setSnapshot({ client, id: taskId, rows: got, loading: false }); }
        }
        else setSnapshot((old) => ({ ...old, error: res.error || '读不到关系' }));
      })
      .catch(() => { if (alive) setSnapshot((old) => ({ ...old, error: '读不到关系' })); })
      .finally(() => { if (alive) setSnapshot((old) => ({ ...old, loading: false })); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, taskId, round, refreshToken]);
  const titleOf = useCallback((id: string) => {
    const found = allTasks.find((t) => t.id === id);
    if (found !== undefined) return found.title;
    void fields;
    return id;
  }, [allTasks, fields]);
  const current = snapshot.id === taskId && snapshot.client === client ? snapshot : { rows: [], loading: true, error: undefined };
  return { ...current, error: current.error, reload: () => { setRound((r) => r + 1); }, titleOf };
}

const FROM_TITLES: Readonly<Record<string, string>> = {
  meeting: '会上定的', session: '从会话来的', said: '你说的', channel: '频道里的', evidence: '证据里冒出来的', user: '你写下的',
};
function fromTitle(kind: string): string {
  return FROM_TITLES[kind] ?? kind;
}

const SESSION_STATUS_TITLES: Readonly<Record<string, string>> = {
  waiting: '会话在等', running: '会话有活动', done: '会话已结束(成果另看交回)', error: '出错', offline: '离线', unknown: '未纳管/当前状态未知',
};

/** 关联会话(links + conversation)对 /state.sessions 的真实状态,不进活动流。 */
function SessionFacts(props: { task: TaskView; sessions: readonly SessionView[]; now: string }) {
  const { task, sessions, now } = props;
  const seen = new Set<string>();
  const rows: { agent: string; sessionId: string; title?: string; note?: string; status: string; at?: string }[] = [];
  const push = (agent: string, sessionId: string, note?: string) => {
    const key = `${agent}:${sessionId}`;
    if (seen.has(key)) return;
    const s = sessions.find((one) => one.session_id === sessionId && one.agent === agent);
    seen.add(key);
    rows.push({ agent, sessionId, status: s?.status ?? 'unknown',
      ...(s === undefined ? {} : { at: s.updated_at }),
      ...(s?.title === undefined ? {} : { title: s.title }), ...(note === undefined ? {} : { note }) });
  };
  for (const link of task.links ?? []) {
    const rawNote = (link as unknown as Record<string, unknown>).note;
    push(link.agent, link.session_id, typeof rawNote === 'string' && rawNote !== '' ? rawNote : undefined);
  }
  if (task.conversation !== undefined) push(task.conversation.agent, task.conversation.session_id);
  if (rows.length === 0) return <p className="ba-collab__unwired">未关联可核对的执行会话,外部执行状态未知。</p>;
  return (
    <>
      {rows.map((row) => (
        <div key={`${row.agent}:${row.sessionId}`} className="ba-collab__act">
          <span className="ba-collab__actic" aria-hidden>窗</span>
          <div className="ba-collab__actbody">
            <div className="ba-collab__acthead">
              {row.agent} 的会话 · {SESSION_STATUS_TITLES[row.status] ?? row.status}
              <span>{row.at === undefined ? '会话时间未知' : friendlyWhen(row.at, now)}</span>
            </div>
            {row.title !== undefined && <div className="ba-collab__acttext">{row.title}</div>}
            {row.note !== undefined && <div className="ba-collab__actquote">{row.note}</div>}
          </div>
        </div>
      ))}
    </>
  );
}

function ActivityRow(props: { item: RawActivityItem; actors: ActorContext; now: string; onOpenTask(id: string): void }) {
  const { item, actors, now, onOpenTask } = props;
  switch (item.type) {
    case 'message': {
      const m = item.message;
      return (
        <div className="ba-collab__act">
          <span className="ba-collab__actic" aria-hidden>{m.intent === 'ask' ? '邀' : '言'}</span>
          <div className="ba-collab__actbody">
            <div className="ba-collab__acthead">
              {actorName(m.by, actors)}{m.intent === 'ask' ? ' 请它处理' : ' 留言'}
              <span>{friendlyWhen(m.at, now)}</span>
            </div>
            <div className="ba-collab__acttext">{m.text}</div>
            {(m.deliveries ?? []).length > 0 && (
              <DeliveryList messageId={m.id} deliveries={m.deliveries!} actors={actors} now={now} onOpenTask={onOpenTask} />
            )}
          </div>
        </div>
      );
    }
    case 'comment':
      return (
        <div className="ba-collab__act">
          <span className="ba-collab__actic" aria-hidden>言</span>
          <div className="ba-collab__actbody">
            <div className="ba-collab__acthead">
              {actorName(item.comment.by, actors)} 留言
              <span>{friendlyWhen(item.comment.at, now)}</span>
              {item.comment.resolved === true && <span className="ba-collab__tag">已处理</span>}
            </div>
            <div className="ba-collab__acttext">{item.comment.text}</div>
          </div>
        </div>
      );
    case 'receipt':
      return (
        <div className="ba-collab__act">
          <span className="ba-collab__actic" aria-hidden>执</span>
          <div className="ba-collab__actbody">
            <div className="ba-collab__acthead">
              交回:{RECEIPT_KIND_TITLES[item.receipt.kind] ?? item.receipt.kind}
              {item.receipt.by !== undefined && ` · ${actorName(item.receipt.by, actors)}`}
              <span>{friendlyWhen(item.receipt.at, now)}</span>
            </div>
            <div className="ba-collab__acttext">{item.receipt.text}</div>
            {item.receipt.evidence.length > 0 && <div className="ba-collab__actquote">证据:{item.receipt.evidence.join('、')}</div>}
          </div>
        </div>
      );
    case 'transition':
      return (
        <div className="ba-collab__act">
          <span className="ba-collab__actic" aria-hidden>经</span>
          <div className="ba-collab__actbody">
            <div className="ba-collab__acthead">
              挪卡:{STATUS_TITLES[item.from as keyof typeof STATUS_TITLES] ?? item.from} → {STATUS_TITLES[item.to as keyof typeof STATUS_TITLES] ?? item.to}
              <span>{friendlyWhen(item.at, now)}</span>
            </div>
          </div>
        </div>
      );
    case 'run': {
      const seg = item.segment;
      return (
        <div className="ba-collab__act">
          <span className="ba-collab__actic" aria-hidden>跑</span>
          <div className="ba-collab__actbody">
            <div className="ba-collab__acthead">
              派出与执行记录({seg.source})
              <span>记录时间 {friendlyWhen(seg.startedAt, now)}</span>
            </div>
            <div className="ba-collab__acttext">{runSegmentLine(seg)}</div>
          </div>
        </div>
      );
    }
  }
}

function RelationJump(props: { k: string; title: string; onClick(): void }) {
  return (
    <div className="ba-collab__fact">
      <span className="ba-collab__factk">{props.k}</span>
      <span className="ba-collab__factv">
        <button type="button" className="ba-collab__linkbtn" onClick={props.onClick}>{props.title}</button>
      </span>
    </div>
  );
}

function RelationFactRow(props: { row: RelationRow; titleOf(id: string): string; onOpen(id: string): void }) {
  const { row, titleOf, onOpen } = props;
  return (
    <div className="ba-collab__fact">
      <span className="ba-collab__factk">
        {row.direction === 'out' ? `${row.kindTitle} →` : `← ${row.kindTitle}`}
      </span>
      <span className="ba-collab__factv">
        <button type="button" className="ba-collab__linkbtn" onClick={() => onOpen(row.otherId)}>
          {titleOf(row.otherId)}
        </button>
        {row.note !== undefined && ` · ${row.note}`}
        {row.round !== undefined && ` · 第${row.round}轮`}
        {row.stale && <span className="ba-collab__tag" data-tone="warn">上游重开,需复核</span>}
      </span>
    </div>
  );
}

/**
 * 留言输入区:默认只留记录;@ 名片后可切「请它处理」(真投递,逐个回状态)。
 * 投递走待发箱:断网暂存恢复补发,请求号(client_msg_id)幂等,电脑说不行的留原话。
 */
function CommentComposer(props: {
  draftScope: string;
  taskId: string;
  actors: ActorContext;
  outbox: SendOutbox | undefined;
  client: ApiClient;
  now: string;
  onSent(): void;
}) {
  const { taskId, actors, outbox, client, now, onSent, draftScope } = props;
  const [saved] = useState(() => readCollabDraft(draftScope, taskId));
  const [draft, setDraft] = useState(saved.text);
  const [intent, setIntent] = useState<CommentIntent>(saved.intent);
  const [pickedIds, setPickedIds] = useState<string[]>(saved.pickedIds);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCards, setShowCards] = useState(false);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const editRevision = useRef(0);
  const sentCallback = useRef(onSent);
  sentCallback.current = onSent;
  const [, refreshOutbox] = useState(0);
  useEffect(() => { saveCollabDraft(draftScope, taskId, { text: draft, intent, pickedIds }); }, [draftScope, taskId, draft, intent, pickedIds]);
  useEffect(() => {
    if (outbox === undefined) return;
    let alive = true;
    void outbox.ready().then(() => { if (alive) refreshOutbox((n) => n + 1); });
    const stop = outbox.subscribe((event) => {
      refreshOutbox((n) => n + 1);
      if (event?.delivered?.path === MESSAGE_PATH && event.delivered.body.task_id === taskId) {
        setNotice('已送达,等同步'); sentCallback.current();
      }
    });
    return () => { alive = false; stop(); };
  }, [outbox, taskId]);
  const cards = Object.entries(actors.cards);
  const pending = outbox?.list().filter((e) => e.path === MESSAGE_PATH && e.body.task_id === taskId) ?? [];

  const send = async () => {
    if (inFlight.current) return;
    setNotice(null);
    const revision = editRevision.current;
    const clearSentDraft = () => { if (revision === editRevision.current) { setDraft(''); setPickedIds([]); } };
    const composed = composeComment(taskId, draft, actors.cards, intent, { pickedIds });
    if (!composed.ok) { setNotice(composed.error); return; }
    inFlight.current = true; setSending(true);
    try {
      if (outbox === undefined) {
        const res = await client.json(MESSAGE_PATH, { method: 'POST', body: composed.body });
        setNotice(res.ok ? '已送达,等同步' : `没送到:${res.error}(这个会话不带待发箱,恢复后请重发)`);
        if (res.ok) { clearSentDraft(); onSent(); }
        return;
      }
      const { outcome } = await outbox.send(MESSAGE_PATH, composed.body, { text: composed.display, at: now });
      if (outcome.kind === 'delivered' || outcome.kind === 'unsent') clearSentDraft();
      if (outcome.kind === 'delivered') setNotice('已送达,等同步');
      else if (outcome.kind === 'unsent') setNotice('没送到,已暂存;恢复后自动补发');
      else setNotice(`电脑说不行:${outcome.error}(已留档,点「收起」划掉)`);
    } catch {
      setNotice('没送到,草稿已保留');
    } finally {
      inFlight.current = false; setSending(false);
    }
  };

  return (
    <section className="ba-collab__composer" aria-label="留言">
      <h3 className="ba-collab__sub">留言 <span className="ba-collab__n">默认只留记录;@ 名片可请它处理</span></h3>
      {showCards && cards.length > 0 && (
        <div className="ba-collab__cards" role="listbox" aria-label="名片">
          {cards.map(([id, name]) => (
            <button key={id} type="button" className="ba-collab__cardchip"
              aria-pressed={pickedIds.includes(id)}
              onClick={() => { editRevision.current += 1; setPickedIds((ids) => ids.includes(id) ? ids : [...ids, id]); setDraft((d) => `${d}${d === '' || d.endsWith(' ') ? '' : ' '}@${name} `); setShowCards(false); }}>
              @{name}
              {cards.filter(([, other]) => other === name).length > 1 && <span> · {id}</span>}
            </button>
          ))}
        </div>
      )}
      {cards.length === 0 && (
        <p className="ba-collab__unwired">这台工作台上还没有名片,@ 不可用;留言会原样留记录。</p>
      )}
      {pickedIds.length > 0 && <p className="ba-collab__unwired">已选收件名片:{pickedIds.map((id) => `${actors.cards[id] ?? '名片已不在清单'} (${id})`).join('、')}</p>}
      <textarea
        className="ba-collab__draft"
        value={draft}
        onChange={(e) => { editRevision.current += 1; setDraft(e.target.value); }}
        placeholder="给这件事留一句话…(@ 从名片选)"
        aria-label="留言草稿"
      />
      <div className="ba-collab__intent" role="group" aria-label="这条留言做什么">
        {COMMENT_INTENTS.map((i) => (
          <button key={i.key} type="button" data-on={intent === i.key} onClick={() => { editRevision.current += 1; setIntent(i.key); }}>
            {i.label}
          </button>
        ))}
        <span>{intentLine(intent)}</span>
      </div>
      {cards.length > 0 && (
        <div className="ba-collab__intent">
          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setShowCards((s) => !s)}>
            {showCards ? '收起名片' : '@ 名片'}
          </button>
        </div>
      )}
      <div className="ba-collab__sendrow">
        <button type="button" className="ba-btn" onClick={() => { void send(); }} disabled={sending || draft.trim() === ''}>{sending ? '正在送…' : '留这条'}</button>
        {notice !== null && <span className="ba-collab__notice" role="status">{notice}</span>}
      </div>
      {pending.length > 0 && (
        <div className="ba-collab__pending" role="status">
          {pending.map((e) => (
            <span key={e.key}>
              {e.state === 'sending' ? `正在送:${e.text}` : e.state === 'unsent' ? `没送到:${e.text}${Date.now() - e.queuedAt > SEND_OUTBOX_AUTO_MS ? '(已超过自动补发时限,请重发)' : '(已暂存,连接恢复后尝试补发)'}` : `电脑说不行:${e.error ?? e.text}`}
              {e.state === 'unsent' && outbox !== undefined && <button type="button" onClick={() => { void outbox.resend(e.key).catch(() => setNotice('没送到,原待发记录仍保留')); }}>重发</button>}
              {e.state === 'rejected' && outbox !== undefined && (
                <button type="button" onClick={() => outbox.discard(e.key)}>收起</button>
              )}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
