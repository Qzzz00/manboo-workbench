/**
 * 事项收件箱的数据映射:与电脑端 workbench-plugin/src/client/butlerInbox.ts、orb.ts 同一套口径——
 * 同源数据(/state)、同一套状态点(白=在办、黄=要我看、蓝=等我确认、灰=没动/结束)。
 * 这里不做任何判断,只翻译;判断都在工作台(C2)。
 */
import {
  BUTLER_NO_SESSION_NOTE, CASUAL_ASK_LABEL, STATUS_TITLES, UNLOCK_WAIT_LABEL, WAIT_REASON_TITLES, clientDeliveryLine, dispatchWho, isEvidenceProposal, isTrackedItem, sessionActivityLine, sessionChildrenLine, sessionDisplayTitle, sessionJobId, taskOriginOf, standingBadgeText,
  type ButlerInboxItem, type SessionView, type TaskStatus, type TaskView, type WorkbenchState,
} from '../api/protocol';

export type CardDot = 'white' | 'yellow' | 'blue' | 'gray';

export interface ItemCard {
  id: string;
  kind: 'inbox' | 'mine';
  title: string;
  dot: CardDot;
  /** 七态里的哪一格。 */
  label?: string;
  waitLabel?: string;
  /**
   * **派出去了没有**(2026-09-30 维护者拍板:派活成功不回电话,电脑与手机上都要一眼看得出
   * 「已送达 / 按了发送没核上 / 没派出去 + 原因」)。没派过窗口的那几张缺席。
   */
  delivery?: string;
  /** 停在哪那一格(2026-10-12):只给要留意的那几种(结果没收进卡 / 没派成 / 多半不需要了 / 等她太久),与电脑卡面同一句。 */
  standing?: string;
  note?: string;
  at?: string;
  /** 点得开的会话;没有就画成静态卡。 */
  sessionId?: string;
  /** 来源卡(下半区恒有;上半区只有 confirm 那档有)。 */
  taskId?: string;
  /**
   * 这张卡点开是一张**指挥台**(2026-09-23)。缺席 = 普通事项,点开还是那张只读详情卡。
   * 只写在卡面上让他知道"这个点开不一样",真正决定开哪一页的是 `task.kind`(InboxPage)。
   */
  deck?: '需求' | '选题';
  /**
   * 这一张是**某家客户端里在跑的一条会话**(2026-09-25,卡 P),不是事项。点开看的是那条会话:
   * 标题、在哪个项目、在做什么、最近几轮(`GET /sessions/digest`)。
   */
  external?: { agent: string; sessionId: string };
  /** 这条会话底下的后台任务那一行(卡 Q):「内含 3 项后台任务 · 在跑 2」。没有就缺席。 */
  childrenLine?: string;
  /** 前面那个圆点用这一家自己的颜色(卡 Q:各家正在办;与电脑上它的小头像同一个色)。缺席照 `dot` 的状态色。 */
  tint?: string;
  /** Agent 登记表那一档(卡 Q):点开有「知道了 / 这不是 Agent」。 */
  agent?: { id: string; notice_id?: string };
  /** 「新学到一条」那一档(2026-10-10):点开有「撤掉 / 知道了」。 */
  habit?: { id: string };
  /** 这一张是**一通电话的记录**(2026-10-22,不是事项):点开看那一通(`items/RecordPages.tsx`)。 */
  callRecordId?: string;
}

export function statusDot(status: TaskStatus): CardDot {
  if (status === 'doing') return 'white';
  if (status === 'blocked') return 'yellow';
  if (status === 'confirm') return 'blue';
  return 'gray';
}

export function inboxItemCard(item: ButlerInboxItem): ItemCard {
  // 2026-10-26(卡「事务官页接管队列」):confirm 没带四类拍板请求的,是事务官待核验队列,标出来、不给「通过」。
  const verifying = item.kind === 'confirm' && item.owner_ask === undefined;
  return {
    id: item.id,
    kind: 'inbox',
    title: item.title,
    dot: item.kind === 'confirm' ? 'blue' : 'yellow',
    ...(verifying ? { label: '事务官核验中' } : item.status === undefined ? {} : { label: STATUS_TITLES[item.status] }),
    ...(item.wait_reason === undefined ? {} : { waitLabel: WAIT_REASON_TITLES[item.wait_reason] }),
    ...(item.note === undefined ? {} : { note: item.note }),
    ...(item.at === undefined ? {} : { at: item.at }),
    ...(item.conversation === undefined ? {} : { sessionId: item.conversation.session_id }),
    ...(item.task_id === undefined ? {} : { taskId: item.task_id }),
    ...(item.kind === 'agent' && item.agent !== undefined ? { agent: item.agent } : {}),
    ...(item.kind === 'habit' && item.habit !== undefined ? { habit: item.habit } : {}),
  };
}

/** 上半区。顺序照服务端(等着的会话 → 等我确认 → 哨兵 → 排期),手机不重排。 */
export function inboxCards(state: WorkbenchState): ItemCard[] {
  return (state.butler_inbox?.items ?? []).map(inboxItemCard);
}

export interface MineGroups {
  /** 在办:待排/待办/进行中/阻塞(等我确认的已升到上半区,不重复出现)。 */
  open: TaskView[];
  /** 办完:完成/取消。 */
  finished: TaskView[];
}

/** 他交给事务官的那些(`direction:'mine'`):对话记录、通话纪要只认这一种。 */
export function mineTasks(state: WorkbenchState): TaskView[] {
  return (state.tasks?.tasks ?? []).filter((task) => task.direction === 'mine');
}

/**
 * 全部事项(2026-09-25 卡 N,一件事一份):他交给事务官的,加上看板上写了负责人的(与工作台 `isTrackedItem` 同一条)。
 * 事项与看板卡是同一份数据的两种排法 —— 看板上写着「Claude」的那张在手机事项页里也看得见。
 */
export function trackedTasks(state: WorkbenchState): TaskView[] {
  return (state.tasks?.tasks ?? []).filter(isTrackedItem);
}

/**
 * 在办 / 办完两摞。证据里冒出来、还没点头的下一步(「待排」卡)不在这里 —— 它在上半区「等你确认」里问「要加上吗」。
 */
export function mineGroups(state: WorkbenchState): MineGroups {
  const mine = trackedTasks(state).filter((t) => !isEvidenceProposal(t));
  const byRecent = (a: TaskView, b: TaskView): number => b.updated_at.localeCompare(a.updated_at);
  return {
    open: mine.filter((t) => t.status !== 'confirm' && t.status !== 'done' && t.status !== 'canceled').sort(byRecent),
    finished: mine.filter((t) => t.status === 'done' || t.status === 'canceled').sort(byRecent),
  };
}

/** 事项按「现在该谁动」排(卡 N):你来 / AI 与事务官在办或排着 / 等别人。办完的另一摞。 */
export interface MoverGroups {
  me: TaskView[];
  agents: TaskView[];
  others: TaskView[];
  finished: TaskView[];
}

/** 这件现在该谁动。服务端没给(老工作台)时:负责人是他 → 他;同事 / 别人 → 别人;其余算事务官那边。 */
export function moverOf(task: TaskView): 'me' | 'agents' | 'others' {
  const who = task.mover?.who;
  if (who === 'me') return 'me';
  if (who === 'others') return 'others';
  if (who === 'agent' || who === 'butler' || who === 'none') return 'agents';
  if (task.assignee === 'me') return 'me';
  if (task.assignee === 'colleague' || task.assignee === 'other') return 'others';
  return 'agents';
}

export function moverGroups(state: WorkbenchState): MoverGroups {
  const groups = mineGroups(state);
  const out: MoverGroups = { me: [], agents: [], others: [], finished: groups.finished };
  for (const task of groups.open) out[moverOf(task)].push(task);
  return out;
}

export function itemCard(task: TaskView, agents?: Pick<WorkbenchState, 'agent_registry'>): ItemCard {
  const sessionId = task.conversation?.session_id;
  const moverLine = task.mover?.line;
  // 「会话未开」只对他交代给事务官的那种卡说(2026-09-25):通话纪要、引导排的、会议来的本来就不开会话,
  // 挂一句「会话未开」读起来像坏了。
  // 看板上写了负责人的那种事项(卡 N)与派给别家的那一件:本来就没有事务官那条会话,写「现在该谁动」那一句。
  const dispatched = task.dispatch !== undefined || task.client_dispatch !== undefined;
  const note = task.direction !== 'mine'
    ? (task.note ?? moverLine)
    : sessionId === undefined
      ? (dispatched ? moverLine : taskOriginOf(task) === 'user' ? BUTLER_NO_SESSION_NOTE : undefined)
      : task.conversation?.archived_at === undefined ? undefined : '会话已归档';
  const standing = standingBadgeText(task.standing);
  const cd = task.client_dispatch;
  const delivery = cd === undefined
    ? undefined
    : clientDeliveryLine(cd, cd.family === undefined ? undefined : dispatchWho(cd.family, agents));
  return {
    id: task.id,
    kind: 'mine',
    title: task.title,
    dot: statusDot(task.status),
    ...(delivery === undefined ? {} : { delivery }),
    ...(standing === undefined ? {} : { standing }),
    // 「只是问了一句」的那一张(2026-09-25,卡 Y):这一格说的是**这件事是什么**,不是「完成」——
    // 他问了一句、她答了,没有一件活被办完,写「完成」就是替一次闲聊记一笔功。
    label: task.casual === true ? CASUAL_ASK_LABEL : STATUS_TITLES[task.status],
    // 派活排着等电脑解锁(2026-10-12):那一格说清在等她解锁,而不是笼统的「等你输入」。
    ...(task.dispatch_block?.unlock === true
      ? { waitLabel: UNLOCK_WAIT_LABEL }
      : task.block_reason === undefined ? {} : { waitLabel: WAIT_REASON_TITLES[task.block_reason] }),
    ...(note === undefined ? {} : { note }),
    at: task.updated_at,
    ...(sessionId === undefined ? {} : { sessionId }),
    taskId: task.id,
    ...(task.kind === 'feature' ? { deck: '需求' as const } : task.kind === 'topic' ? { deck: '选题' as const } : {}),
  };
}

/** 事项底下那段会话的实时状态:拿 conversation.session_id 去 sessions 里现查,查法与电脑端相同。 */
export function conversationOf(state: WorkbenchState, task: TaskView): SessionView | undefined {
  const id = task.conversation?.session_id;
  if (id === undefined) return undefined;
  return state.sessions.find((s) => s.agent === 'dsh' && s.session_id === id);
}

export function taskById(state: WorkbenchState, id: string): TaskView | undefined {
  return state.tasks?.tasks.find((t) => t.id === id);
}

/** 「14 分钟」「1 小时 5 分钟」:进入这个状态多久了(用服务端算好的 elapsed_sec,不看手机时钟)。 */
export function elapsedText(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return '刚开始';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/**
 * 「Claude · 进行中 · 14 分钟」「Codex · 这一轮说完了」:一条会话此刻怎样。与电脑详情同一个说法。
 * 那一家叫什么由调用方给(`name`),这里不放「是哪几家」的名单。
 */
export function sessionStatusText(session: Pick<SessionView, 'status' | 'elapsed_sec'>, name: string): string {
  if (session.status === 'running') {
    const elapsed = elapsedText(session.elapsed_sec);
    return elapsed === undefined ? `${name} · 进行中` : `${name} · 进行中 · ${elapsed}`;
  }
  if (session.status === 'waiting') return `${name} · 在等你`;
  if (session.status === 'done') return `${name} · 这一轮说完了`;
  if (session.status === 'error') return `${name} · 出错停下了`;
  return `${name} · 已经关了`;
}

/**
 * 各家客户端里在跑的一条会话 → 事项页上的一行(2026-09-25,卡 P)。标题同电脑(那家自己的标题),
 * 附注是「在做什么 · 几分钟前」,读不到就「读不到它在做什么」。`agentName`:那一家叫什么(调用方查)。
 */
export function externalSessionCard(session: Omit<SessionView, 'agent'> & { agent: string }, now: string, agentName: string, tint?: string): ItemCard {
  return {
    id: sessionJobId(session.agent, session.session_id),
    kind: 'mine',
    title: sessionDisplayTitle(session, agentName),
    dot: 'white',
    ...(tint === undefined ? {} : { tint }),
    ...(sessionChildrenLine(session.children) === undefined ? {} : { childrenLine: sessionChildrenLine(session.children) as string }),
    label: sessionStatusText(session, agentName),
    note: sessionActivityLine(session.activity, now),
    external: { agent: session.agent, sessionId: session.session_id },
  };
}
