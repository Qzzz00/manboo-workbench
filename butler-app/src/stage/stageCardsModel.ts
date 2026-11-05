/**
 * 首页球下面那几块卡片里各自有什么(2026-09-21 起,运营同事白板第三节「手机端界面」)。
 *
 * 白板上手机端画的是**一个形象 + 几块卡片**:竖版形象居中在上、卡片在下。
 * 决策记录 2026-09-21「运营白板三件」第 3 条:**手机端用我们的粒子球,不用白板上的人形**。
 *
 * 这个文件**只翻译,不判断**(同 items/itemsModel.ts 的纪律):判断都在工作台(C2)。
 *
 * ## 2026-09-25(卡 feat/first-look-orb-top,设计 docs/设计-引导落地-引导结束后的样子-2026-09-24.md「手机首页」)
 *
 * | 卡片 | 数据从哪来 | 整张点下去 |
 * |---|---|---|
 * | 正在办(整行) | 事务官在办的事项(挂着的会话在跑)+ 各家客户端此刻在跑、没挂在事项上的会话 —— 与电脑首页球周围那几张同一个口径 | 事项页「在办」 |
 * | 等你确认 | `/state.butler_inbox` 里 `kind: 'confirm'` | 事项页「事务官交给我的」 |
 * | 今天要做 | 我交给事务官的、还没办完的(去掉正在办的、去掉通话纪要);**加上现在该他动的**(负责人是他、卡住了等他 —— 卡 N),他自己的排前面 | 事项页「在办」 |
 * | 最近一次通话 | 最新一份通话记录(`/state.calls`,2026-10-22 起);老工作台退回最新一张纪要卡(`origin:'call'`,老卡按标题认)。写**一句话摘要**;引导那一通也算 | 通话记录页里那一通 |
 * | 资讯 | `GET /feed` + `GET /feed/aidj`(首页自己拉,不进 /state):今天那期播客 / 几条资讯 | 资讯页(能听) |
 *
 * 维护者 09-24 晚的原话:「最近一次通话:还没有通过电话 —— 其实刚打了 27 分钟」(引导那一通从来不落纪要);
 * 「资讯明明早上的播客都已经有了,为什么还说没有接入」(那一格写死了「还没接上」);
 * 「今日要做」「等我确认」只能点卡里那颗「去看」(整张卡要能点)。
 */
import type { InboxTab } from '../items/inboxTabs';
import { ASSIGNEE_NAMES, CALL_RECORD_TITLE_PREFIX, type CallRecordView, registryAgentName, sessionJobId, sessionJobMatches, sessionOfJob, sessionBusy, sessionChildrenLine, sessionDisplayTitle, taskOriginOf, type AskSessionView, type ButlerInboxItem, type SessionView, type TaskView, type WaitingKind, type WorkbenchState } from '../api/protocol';
import { mineGroups, mineTasks, moverOf, trackedTasks } from '../items/itemsModel';
import type { AidjView } from '../feed/aidjModel';
import { emptyNote, playablePodcast, type NewsView, type PlayablePodcast } from '../feed/newsModel';
// 事务官问你的话、要你批的事(2026-09-25,卡 M):「等你确认」那一格最前面几行,点开是同样的问题与选项。
import { approvalLine, questionLine, waitingPile } from '../asks/asksModel';

export type StageCardId = 'doing' | 'confirm' | 'today' | 'call' | 'feed';

/** 整张卡点下去去哪。事项页那几种带上落在哪一段 / 哪一张。 */
export type StageCardTarget =
  | { page: 'inbox'; tab?: InboxTab; taskId?: string }
  /** 通话记录页;带 callId 直接打开那一通(「最近一次通话」;通话记录的编号,老纪要卡就是卡的 id)。 */
  | { page: 'calls'; callId?: string }
  | { page: 'news' }
  /** 「我照你说的摆好了」那一页(引导落地,首页的下一级页)。 */
  | { page: 'setup' }
  /** 事务官问你的话、要你批的事那一页(2026-09-25,卡 M):同电脑球下那几张,答完两边一起消失。 */
  | { page: 'asks' };

/** 一块卡片。`lines` 是卡片里那几行;空数组 = 什么都没有,这时显示 `empty`。 */
export interface StageCard {
  id: StageCardId;
  title: string;
  /** 右上角那个数。**没有数可数的卡片(通话、资讯)整个字段缺席**,不画 0。 */
  count?: number;
  /**
   * 卡片里那几行。`agent` = 这一行说的是哪一家(登记表条目的 id;2026-09-26,卡 LG3)——
   * 首页「正在办」「等你确认」那几行名字前那张 logo 按它取。**只有真说得清是哪一家的那几行才有**
   * (一件事里两家一起在跑、纯粹的一件事项、事务官自己那几行都缺席);缺席就是原来的样子,没有图。
   */
  lines: { id: string; text: string; note?: string; agent?: string }[];
  /** 列到 `lines` 之外还剩几条。**缺席 = 一条不剩**,不写「还有 0 件」。 */
  more?: number;
  /** 没有内容时说的那句话。 */
  empty: string;
  /** 整张卡点下去去哪。没有去处就缺席(卡片仍然显示,只是点不动)。 */
  to?: StageCardTarget;
  /** 占满一整行(「正在办」:它是一眼要看到的那一格,也可能一条都没有 —— 那时只是细细一行)。 */
  wide?: boolean;
  /**
   * 那一件的附注**另起一行**(「最近一次通话」:一句话摘要在上、「几点 · 多长」在下)。
   * 缺席 = 附注跟在同一行右边,地方不够时附注先让(标题优先)。
   */
  stacked?: boolean;
}

/**
 * 每张卡片标题下面**固定几行**(2026-09-25 晚,卡 fix/phone-home-card-fit)。
 *
 * 统筹在小米 10S 真机上看到:「今天要做」第二行只露出上半截、「最近一次通话」那行「18:51」切掉一半、
 * 「资讯」那句拦腰切断 —— 以前卡片区按屏高的 46% 平分、行数不定,装不下就硬裁,又没有省略号。
 * 现在反过来:**行数定死、卡片高度由行数算出来**(五张一样高),球那一格让出剩下的地方;
 * 一行一件,一行之内截断带省略号,标题优先;件数多于行数时最后一行写「还有 N 件」。
 *
 * 屏很矮(或开了大字)时只放两行,由 StageCards 按舞台的高度定(见 {@link cardRowsFor})。
 */
export const CARD_ROWS = 3;
export const CARD_ROWS_SHORT = 2;
/**
 * 舞台高度低于这么多「字号」(html 的 font-size,大字档跟着变大)就只放两行。
 * 53.75 × 16px = 860px:三行时卡片区连同顶上一排、字幕那一格、未接来电那一行、底下输入框一共约 670px,
 * 小米 10S 去掉状态栏与导航栏大约 845px 高,三行时球只剩 166px(实测);两行时回到 220px 上下。
 * 高过 860px 的屏(统筹给的 412×915)照旧三行。按字号算而不是按像素算:开了大字卡片更高,门槛跟着抬。
 */
export const SHORT_SCENE_REM = 53.75;

export function cardRowsFor(sceneHeightPx: number, rootFontPx: number): number {
  if (!(sceneHeightPx > 0) || !(rootFontPx > 0)) return CARD_ROWS;
  return sceneHeightPx < SHORT_SCENE_REM * rootFontPx ? CARD_ROWS_SHORT : CARD_ROWS;
}

/**
 * 一份清单按行数摆:摆得下就全摆;摆不下就摆 rows-1 件,最后一行留给「还有 N 件」。
 * 右上角那个数照旧是总数(它和这几行不是同一个数)。
 */
export function fitRows<T>(items: readonly T[], rows: number): { shown: T[]; more?: number } {
  const budget = Math.max(1, Math.floor(rows));
  if (items.length <= budget) return { shown: [...items] };
  const shown = items.slice(0, budget - 1);
  return { shown, more: items.length - shown.length };
}

/** 还没通过电话时「最近一次通话」那一格说的话。**不写「还没有通过电话」**:引导那一通现在也算,没有就是真没有。 */
export const CALL_NONE_TEXT = '还没有通话记录。打一通电话,挂断后这里写一句这通说了什么。';
/** 资讯那一格还没问到时。 */
export const FEED_ASKING_TEXT = '正在拿今天的资讯…';
/** 这台工作台压根没接资讯(`/feed` 404)。说清为什么,而不是「还没接上」一句了事。 */
export const FEED_UNAVAILABLE_TEXT = '电脑上的工作台这一版还没有资讯(太老了),更新之后这里会有每天的播客。';

/**
 * 那一家叫什么:**Agent 登记表里的名字**(2026-09-25,卡 Q);不在表里就原样用它的 id(卡 P 定的规矩:按字符串处理、
 * 不收窄成固定几家)。手机里不再有名字表 —— 电脑上接上一家,手机上就叫得出它。
 */
export function agentTitle(agent: string, state?: Pick<WorkbenchState, 'agent_registry'>): string {
  // ★ 2026-10-03(卡「两条接缝」):登记表那一下只有 `registryAgentName` 一处 ——
  // 这里**故意不退回任何名字表**(上面那一段:手机里不再有名字表),与 `dispatchWho` 的差别就是这一格。
  return registryAgentName(agent, state) ?? agent;
}

/** 那一家的颜色(卡 Q):登记表里算好的那一格;老工作台没给 → undefined(圆点照状态色)。 */
export function agentColor(agent: string, state?: Pick<WorkbenchState, 'agent_registry'>): string | undefined {
  return state?.agent_registry?.entries.find((entry) => entry.id === agent)?.color;
}

/**
 * 「各家正在办」那里的一句(2026-09-25,卡 Q;统筹:没给壳辅助功能授权时不许空白):电脑上读不了别家窗口时说清为什么、去哪儿开。
 * 手机开不了电脑的系统设置,只说在电脑上点哪儿。
 */
export function agentsBlockedLine(state: Pick<WorkbenchState, 'agent_registry'>): string | undefined {
  const blocked = state.agent_registry?.blocked;
  if (blocked === undefined) return undefined;
  return blocked.kind === 'accessibility' ? `${blocked.text} —— 在电脑上工作台顶上点「去打开」就行` : blocked.text;
}

/** 各家的会话(登记表里的;老工作台没有登记表时退回会话流,名字就是 id)。 */
function registrySessions(state: WorkbenchState): readonly (Omit<SessionView, 'agent'> & { agent: string })[] {
  const entries = state.agent_registry?.entries;
  if (entries === undefined) return state.sessions.filter((s) => s.agent !== 'dsh');
  return entries.filter((entry) => entry.self !== true && entry.id !== 'dsh').flatMap((entry) => entry.sessions);
}

const sessionKey = (ref: { agent: string; session_id: string }): string => `${ref.agent}:${ref.session_id}`;

/**
 * 在办的事项:是一件事项(他交给事务官的,或看板上写了负责人的 —— 卡 N)、进行中,挂着的会话(事项自己那段 + 各家)至少一条在跑。
 * 与工作台 `isItemExecuting` 同一个意思(手机这份 /state 子集里没有 agents 在线表,在线那一格不看)。
 */
export function executingTasks(state: WorkbenchState): TaskView[] {
  if (state.stale) return [];
  if (state.running !== undefined) return trackedTasks(state).filter(task => state.running!.items.some(one => one.task_id === task.id && (state.running?.scope !== 'classified_business_tasks' || one.role === 'business')) && (state.running?.scope === 'classified_business_tasks' || task.source?.kind !== 'session'));
  const running = new Set(state.sessions.filter((s) => s.status === 'running').map(sessionKey));
  return trackedTasks(state).filter((task) => {
    if (task.status !== 'doing') return false;
    const refs = [...(task.links ?? []), ...(task.conversation === undefined ? [] : [task.conversation])];
    return refs.some((ref) => running.has(sessionKey(ref)));
  });
}

/**
 * 各家客户端里此刻在跑、又没挂在任何一张「我交给事务官的」事项上的会话。**哪几家 = Agent 登记表**(卡 Q):
 * 读窗口读出来的那几家(Muse、Manus、豆包……)与有会话记录的那几家走同一条路。
 * 与电脑端 `butlerSceneModel.externalRunningSessions` 同一个口径:事务官自己(dsh)的不单列,挂在事项上的只算一次。
 */
export function externalRunning(state: WorkbenchState): (Omit<SessionView, 'agent'> & { agent: string })[] {
  if (state.stale) return [];
  const linked = new Set<string>();
  for (const task of trackedTasks(state)) {
    for (const link of task.links ?? []) linked.add(sessionKey(link));
    if (task.conversation !== undefined) linked.add(sessionKey(task.conversation));
  }
  return registrySessions(state)
    // 在办 = 它自己在跑,或者底下有后台任务在跑 / 在等你(卡 Q:主会话只算这一次,子任务不单独算)。
    // 卡 V(2026-09-25):**工作台自己起的不算他的**(`selfcheck`)—— 能力体检 / 派活探针 / 统筹自测
    // 那几条不进首页「正在办」。与电脑端 `running.ts` 的 `isHisSession` 同一条判据。
    .filter((s) => sessionBusy(s) && s.selfcheck === undefined && !linked.has(sessionKey(s)))
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** 「最近的对话」列多久以内的(天)、最多几条(2026-09-30)。 */
export const RECENT_SESSION_DAYS = 3;
export const RECENT_SESSION_MAX = 10;

/**
 * **各家最近的对话里,此刻没在跑的那几条**(2026-09-30,维护者:「如果会话状态不是正在办的话,
 * 我甚至在手机上都找不到这个会话」)。一条对话停下来(在等他、刚答完)就从「各家正在办」里掉出去,
 * 手机上点不进去、也就没法往里说一句 —— 而他最要回话的恰恰是停下来等他的那条。
 *
 * 口径与 {@link externalRunning} 同一套(同一份登记表、自测的不算、事务官自己不算、电脑那份是上次的就不列),
 * 只是反过来:**不在跑的**,最近 {@link RECENT_SESSION_DAYS} 天、最多 {@link RECENT_SESSION_MAX} 条,新的在前。
 */
export function externalRecent(state: WorkbenchState): (Omit<SessionView, 'agent'> & { agent: string })[] {
  if (state.stale) return [];
  const nowMs = Date.parse(state.now);
  const since = Number.isFinite(nowMs) ? nowMs - RECENT_SESSION_DAYS * 24 * 3_600_000 : -Infinity;
  return registrySessions(state)
    .filter((s) => !sessionBusy(s) && s.selfcheck === undefined && s.status !== 'offline')
    .filter((s) => { const at = Date.parse(s.updated_at); return !Number.isFinite(at) || at >= since; })
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, RECENT_SESSION_MAX);
}

function doingCard(state: WorkbenchState, budget: number): StageCard {
  const tasks = executingTasks(state);
  const running = new Set(state.sessions.filter((s) => s.status === 'running').map(sessionKey));
  const rows: StageCard['lines'] = [
    ...tasks.map((task) => {
      const ids = [...new Set((task.links ?? []).filter((link) => running.has(sessionKey(link)) && link.agent !== 'dsh').map((link) => link.agent))];
      const who = ids.map((id) => agentTitle(id, state));
      return {
        id: task.id,
        text: task.title,
        note: who.length === 0 ? '事务官' : who.join(' · '),
        // 这件事此刻**只有一家**在跑:那一行前面就能画它的 logo(卡 LG3)。两家一起在跑时画谁都是错的,缺席。
        ...(ids.length === 1 && ids[0] !== undefined ? { agent: ids[0] } : {}),
      };
    }),
    ...externalRunning(state).map((s) => ({
      id: sessionJobId(s.agent, s.session_id),
      // 标题:那家自己的标题(2026-09-25,卡 P:服务端读出来了);读不到才「Claude 的一条会话」。与电脑同一个函数。
      text: sessionDisplayTitle(s, agentTitle(s.agent, state)),
      // 它底下有后台任务(卡 Q):那一行写几项、在跑几项。
      note: [agentTitle(s.agent, state), sessionChildrenLine(s.children)].filter((one): one is string => one !== undefined).join(' · '),
      // 这一行就是某一家的一条会话:名字前那张 logo 认它(卡 LG3)。
      agent: s.agent,
    })),
  ];
  // The public running list owns execution. Session-only entries are not business tasks.
  const scoped = state.running?.scope === 'classified_business_tasks';
  const unclassified = scoped ? state.running?.excluded?.some(one => one.role === 'unclassified') ?? false
    : state.running?.items.some(one => state.tasks?.tasks.find(task => task.id === one.task_id)?.source?.kind === 'session') ?? false;
  const publicRows = state.running === undefined ? rows : [...new Set(state.running.items.flatMap(one => one.task_id === undefined || scoped && one.role !== 'business' ? [] : [one.task_id]))].map(id => {
    const facts = state.running!.items.filter(one => one.task_id === id);
    const task = state.tasks?.tasks.find(one => one.id === id);
    const providers = [...new Set(scoped ? facts.flatMap(one => (one.sources ?? []).filter(source => source.role === 'business').map(source => source.provider ?? '提供方未确认')) : facts.map(one => one.agent))];
    return { id, text: task?.title ?? facts[0]!.text, note: `${unclassified ? '已确认业务 · ' : ''}${providers.map(one => agentTitle(one, state)).join(' · ')}`, ...(providers.length === 1 ? { agent: providers[0]! } : {}) };
  });
  const count = state.running === undefined ? (!state.stale ? rows.length : undefined) : !state.stale && state.running.count !== undefined ? scoped ? state.running.count : publicRows.filter(one => state.tasks?.tasks.find(task => task.id === one.id)?.source?.kind !== 'session').length : undefined;
  const businessRows = (scoped ? publicRows : publicRows.filter(one => state.tasks?.tasks.find(task => task.id === one.id)?.source?.kind !== 'session'))
    .map(one => scoped && count === undefined ? { ...one, note: `业务总数未知 · ${one.note}` } : one);
  const fit = fitRows(businessRows, budget);
  return {
    id: 'doing',
    title: '正在办',
    // 手机与电脑舞台、球下、汇报共用公共业务事项数；窗口槽单列各家运行会话数。
    // 老工作台没给这一格才退回自己数这几行。
    ...(count === undefined ? {} : { count }),
    lines: fit.shown,
    ...(fit.more === undefined ? {} : { more: fit.more }),
    empty: unclassified && count !== undefined ? '当前已纳管业务任务没有在执行；另有历史来源角色未知。'
      : unclassified ? '另有来源角色未知的会话，业务总数未确认。'
        : count === undefined ? `业务任务总数未知，已观测 ${scoped ? state.running?.observed_count ?? businessRows.length : businessRows.length} 件。` : '这会儿没有在办的事。',
    to: { page: 'inbox', tab: 'doing' },
    wide: true,
  };
}

/**
 * 截止日写短:「2026-09-22」→「9/22」(那一格附注最多占一行的 40%,十个字符的日期在半张卡上放不下、整个不出现)。
 * 认不出的原样写。
 */
export function shortDue(due: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(due.trim());
  return m === null ? due : `${Number(m[2])}/${Number(m[3])}`;
}

function taskLine(task: TaskView): { id: string; text: string; note?: string } {
  // 附注:截止日优先;没有截止日、负责人又不是他 → 写谁在管(「Codex」「同事」),一眼分得清是不是他自己的。
  const owner = task.assignee === undefined || task.assignee === 'me' ? undefined : ASSIGNEE_NAMES[task.assignee] ?? task.assignee;
  const note = task.due !== undefined ? shortDue(task.due) : owner;
  return { id: task.id, text: task.title, ...(note === undefined ? {} : { note }) };
}

/**
 * 「今天要做」那几件(2026-09-25 卡 N):他交给事务官的、还没办完的(老口径),加上**现在该他动的**
 * (负责人是他、卡住了等他)。去掉正在办的、通话纪要、挂着「派给 X 开工?」那一问的(那一问在「等你确认」里)。
 * 他自己的排前面(按截止日),其余按最后一次改动从新到旧。
 */
export function todayTasks(state: WorkbenchState): TaskView[] {
  const doingIds = new Set(executingTasks(state).map((task) => task.id));
  const asking = new Set((state.approvals ?? [])
    .filter((one) => one.session_id.startsWith('dispatch:'))
    .map((one) => one.session_id.slice('dispatch:'.length)));
  const open = mineGroups(state).open.filter((task) => !doingIds.has(task.id) && !isCallRecord(task) && !asking.has(task.id)
    && (task.direction === 'mine' || moverOf(task) === 'me'));
  const his = open.filter((task) => moverOf(task) === 'me')
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  return [...his, ...open.filter((task) => moverOf(task) !== 'me')];
}

function inboxLine(item: ButlerInboxItem): { id: string; text: string; note?: string } {
  return { id: item.id, text: item.title, ...(item.note === undefined ? {} : { note: item.note }) };
}

/** 是不是一张通话纪要卡(有 origin 看 origin,老卡看标题)。2026-10-22 起工作台不再建这种卡,只剩存量。 */
export function isCallRecord(task: TaskView): boolean {
  return taskOriginOf(task) === 'call' || task.title.startsWith(CALL_RECORD_TITLE_PREFIX);
}

/** 最新一张通话纪要卡(存量)。按建卡时刻取最新(纪要都是挂断那一刻落的)。 */
export function latestCallRecord(state: WorkbenchState): TaskView | undefined {
  let latest: TaskView | undefined;
  for (const task of mineTasks(state)) {
    if (!isCallRecord(task)) continue;
    if (latest === undefined || task.created_at > latest.created_at) latest = task;
  }
  return latest;
}

/**
 * ★ **手机上的一通电话**(2026-10-22,决策记录同日「通电话是记录不是事项」)。
 *
 * 工作台从这一天起不再给电话建纪要卡,一通电话是 `/state.calls` 里的一份记录(`record`);
 * 这一天之前落的老纪要卡(`task`)照旧算一通。「通话记录」与「最近一次通话」都读这一份。
 */
export interface CallEntry {
  /** 记录的编号;老纪要卡就是卡的 id。 */
  id: string;
  kind: 'onboarding' | 'call';
  at: string;
  summary: string;
  duration_seconds?: number;
  record?: CallRecordView;
  task?: TaskView;
}

function recordEntry(record: CallRecordView): CallEntry {
  return {
    id: record.id, kind: record.kind, at: record.at, summary: record.summary,
    ...(record.duration_seconds === undefined ? {} : { duration_seconds: record.duration_seconds }), record,
  };
}

/** 老纪要卡那一通。这个字段出现之前落的老卡没有摘要 —— 那时就是卡的标题,不编一句。 */
export function taskCallEntry(task: TaskView): CallEntry {
  return {
    id: task.id, kind: task.call?.kind ?? 'call', at: task.created_at, summary: task.call?.summary ?? task.title,
    ...(task.call?.duration_seconds === undefined ? {} : { duration_seconds: task.call.duration_seconds }), task,
  };
}

/** 通话记录,新的在前(工作台给的就是新的在前,这里再按时刻排一遍)。老工作台没有这一格 → 空。 */
export function callRecordEntries(state: WorkbenchState): CallEntry[] {
  return [...(state.calls?.recent ?? [])].sort((a, b) => b.at.localeCompare(a.at)).map(recordEntry);
}

/**
 * 最近一次通话:有通话记录就是最新那一份;一份都没有(老工作台、这一天之前)就是最新那张老纪要卡。
 * 记录一律比老卡新(老卡都是 10-22 之前落的),所以不必把两样混起来比时刻。
 */
export function latestCall(state: WorkbenchState): CallEntry | undefined {
  const record = callRecordEntries(state)[0];
  if (record !== undefined) return record;
  const task = latestCallRecord(state);
  return task === undefined ? undefined : taskCallEntry(task);
}

/**
 * ★ **「刚办完 · 结果一句话」摆哪几行**(2026-10-04,卡 `claude/answer-comes-to-her`)。
 *
 * 维护者 10-04(经工作台捎话):「信息直接从正在办切到办完了,我是自己追过去点开查看的」。
 * 她点头的第 2 条:**交代一件事办完的结果先摆到她面前** —— 办完不直接沉进「办完」,
 * 首页先挂一条,她点开看过、或者划掉,才收进去。
 *
 * **判据全在工作台一处**(`src/answerCell.ts` 的 `freshResultsOf`:办完了 + 她没看过 +
 * 24 小时内 + 不是「只是问了一句」那一张)—— 手机这一侧**一个条件都不自己判**,
 * 读 `/state.fresh_results` 原样摆。老工作台没这一格 → 一条都不摆(照旧现在的样子)。
 */
export function freshResultRows(state: WorkbenchState): { id: string; text: string; note?: string }[] {
  return (state.fresh_results?.items ?? []).map((one) => ({
    id: one.task_id,
    // 正文是**结果那一句**(她要看的是结果,不是她当初说的那句话);取不到就摆标题,不编一句。
    text: one.result ?? one.title,
    // 附注是那件事的标题(结果一句话摆在正文时,右边这一格说清是哪一件)。
    ...(one.result === undefined ? {} : { note: one.title }),
  }));
}

/** 「3 分 5 秒」/「27 分」。与工作台 `formatCallDuration` 同一个说法。 */
export function callDurationText(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes === 0) return `${rest} 秒`;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}

/** 「18:52」(与 now 同一天)/「9月24日 18:52」。认不出就空串。 */
export function whenText(iso: string, nowIso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const now = new Date(nowIso);
  const sameDay = !Number.isNaN(now.getTime()) && now.toDateString() === at.toDateString();
  return sameDay ? hhmm : `${at.getMonth() + 1}月${at.getDate()}日 ${hhmm}`;
}

/**
 * 一通电话在首页上那一行:正文是**那一句摘要**(工作台按事实拼的,不经模型),右边是「几点 · 多长」。
 * 老纪要卡没有摘要 —— 那时正文就是卡的标题(「和事务官通了个电话(34 秒)」),不编一句。
 */
export function callEntryLine(entry: CallEntry, nowIso: string): { id: string; text: string; note?: string } {
  const when = whenText(entry.at, nowIso);
  const long = callDurationText(entry.duration_seconds);
  const note = [when, long].filter((part): part is string => part !== undefined && part !== '').join(' · ');
  return { id: entry.id, text: entry.summary, ...(note === '' ? {} : { note }) };
}

/** 一张老纪要卡在首页上那一行(同 {@link callEntryLine})。 */
export function callLine(task: TaskView, nowIso: string): { id: string; text: string; note?: string } {
  return callEntryLine(taskCallEntry(task), nowIso);
}

/**
 * 引导那一通**没有纪要卡**时(2026-09-25 之前的手机挂断时不写 —— 维护者 09-24 晚那通 27 分钟就是这样),
 * 首页那一行写这一句 + 引导走完的时刻。不编时长、不编摘要;没有卡可开,这一行点不开。
 */
export const ONBOARDING_DONE_CALL_TEXT = '引导走完了';

/** 引导走完的时刻比最近一通还晚、又没有引导那一通的记录(或纪要卡)→ 那一通就是最近一次通话。 */
function onboardingCallFallback(state: WorkbenchState, latest: CallEntry | undefined): { id: string; text: string; note?: string } | undefined {
  const onboarding = state.onboarding;
  if (onboarding === undefined || !onboarding.done || onboarding.done_at === undefined) return undefined;
  if ((state.calls?.recent ?? []).some((record) => record.kind === 'onboarding')) return undefined;
  if (mineTasks(state).some((task) => isCallRecord(task) && task.call?.kind === 'onboarding')) return undefined;
  if (latest !== undefined && Date.parse(latest.at) >= Date.parse(onboarding.done_at)) return undefined;
  const when = whenText(onboarding.done_at, state.now);
  return { id: 'onboarding-done', text: ONBOARDING_DONE_CALL_TEXT, ...(when === '' ? {} : { note: when }) };
}

function callCard(state: WorkbenchState): StageCard {
  const latest = latestCall(state);
  const base = { id: 'call' as const, title: '最近一次通话', empty: CALL_NONE_TEXT, stacked: true };
  const fallback = onboardingCallFallback(state, latest);
  if (fallback !== undefined) return { ...base, lines: [fallback] };
  return {
    ...base,
    lines: latest === undefined ? [] : [callEntryLine(latest, state.now)],
    ...(latest === undefined ? {} : { to: { page: 'calls' as const, callId: latest.id } }),
  };
}

/**
 * 首页自己拉的那一份资讯(不进 /state:一天只变一次,见 feed/useNews.ts 顶上那段)。
 * `asked=false` = 还没问到;`unavailable` = 这台工作台没接资讯(404)。
 * 今天它只喂一样东西:球下那一排里资讯那颗的小点({@link glancePodcast})。
 */
export interface NewsGlance {
  asked: boolean;
  unavailable: boolean;
  /** 问的时候出的错(连不上电脑之类)。原样显示。 */
  error?: string;
  view?: NewsView;
  /** 今天那期双主播节目;这台工作台没接 AIDJ 时 null。 */
  aidj?: AidjView | null;
}

/**
 * 首页那一份里**今天那期播客能不能听**(2026-10-03 晚,资讯那颗的小点;维护者:「要,只标播客有没有」)。
 * 还没问到、这台工作台没接资讯(404)都是没有 —— 后者与资讯那一页一样整块当不存在;
 * 其余照 {@link playablePodcast} 那一处判,首页不另判一遍。
 */
export function glancePodcast(glance: NewsGlance | undefined): PlayablePodcast | null {
  if (glance === undefined || !glance.asked || glance.unavailable) return null;
  return playablePodcast(glance.view, glance.aidj);
}

/**
 * 「12 分钟」。按节目自己估的总长,不足一分钟说「不到 1 分钟」。
 * 2026-09-25 晚(卡 fix/phone-home-card-fit)去掉了「约」和主播名:那一格附注最多占一行的 40%,
 * 「小满 / 阿本 · 约 11 分钟」在手机上永远放不下、整个不出现;「11 分钟」放得下。主播在资讯页里。
 */
function minutesText(ms: number): string {
  const minutes = Math.round(ms / 60000);
  return minutes < 1 ? '不到 1 分钟' : `${minutes} 分钟`;
}

/** 资讯那一格。**真没有时才说没有,并说清为什么**(中转没配搜索、模型没接上、还没到早报时间……)。 */
export function feedCard(glance: NewsGlance | undefined, nowIso: string): StageCard {
  const base = { id: 'feed' as const, title: '资讯', to: { page: 'news' as const } };
  if (glance === undefined || !glance.asked) return { ...base, lines: [], empty: FEED_ASKING_TEXT };
  if (glance.unavailable) return { ...base, lines: [], empty: FEED_UNAVAILABLE_TEXT };
  const view = glance.view;
  const lines: StageCard['lines'] = [];
  // 这一格最多两条(卡片窄,每条是「一句话 + 下面一行附注」):播客那一条,再加「跟你项目有关的几条」;
  // 没有跟项目有关的,第二条才写播客的头条。哪一样算「能听」认 glancePodcast(与资讯那一页、那颗小点同一处)。
  let topic: StageCard['lines'][number] | undefined;
  const playable = glancePodcast(glance);
  if (playable?.kind === 'aidj') {
    lines.push({ id: 'aidj', text: '今天的资讯播客', note: minutesText(playable.program.estimated_total_ms) });
    const first = playable.program.topics[0];
    if (first !== undefined) topic = { id: `topic:${first.id}`, text: first.title };
  } else if (playable?.kind === 'local') {
    const when = playable.podcast.at > 0 ? whenText(new Date(playable.podcast.at).toISOString(), nowIso) : '';
    lines.push({ id: 'podcast', text: '今天的资讯播客', ...(when === '' ? {} : { note: when }) });
  } else if (view?.podcast !== undefined && view.podcast.script !== '') {
    lines.push({ id: 'script', text: '今天只有文字稿', ...(view.podcast.error === undefined ? {} : { note: view.podcast.error }) });
  }
  const items = (view?.groups ?? []).flatMap((group) => group.items);
  if (items.length > 0) {
    lines.push({ id: 'items', text: `${items.length} 条跟你的项目有关`, note: items[0]!.title });
  } else if (topic !== undefined) {
    lines.push(topic);
  }
  if (lines.length > 0) return { ...base, lines, empty: '今天还没有新的资讯。' };
  // 一样都没有:说清为什么。问的时候就出错了(连不上电脑)先说那一句。
  const why = glance.error ?? (view === undefined ? FEED_ASKING_TEXT : emptyNote(view, true));
  return { ...base, lines: [], empty: why };
}

/** 「等你确认」那一格置顶那一行的标题。 */
export const SETUP_LINE_TEXT = '我照你说的摆好了';

/** 单子那一页上,别的待确认那一小节的标题(2026-09-25,卡 fix/confirm-cancel)。 */
export function otherConfirmsTitle(count: number): string {
  return `另外 ${count} 件等你确认`;
}

/** 「等你确认」里的一行:哪一样(点下去去哪按它分)、一句话、附注,办完了等你确认的带着事项 id。 */
export interface WaitingRow {
  id: string;
  kind: WaitingKind;
  text: string;
  note?: string;
  taskId?: string;
  /**
   * 这一行是**哪一家**在等他(2026-09-26,卡 LG3)。今天只有 `kind: 'session'` 那一种说得清
   * (「Grok Bot 在等你选」——那句话里就写着是谁),名字前那张 logo 按它取。
   * 事务官问的、要他批的那几行是她自己的事,缺席。
   */
  agent?: string;
}

/** 提议(做个小工具 / 改布局 / 固化下来)在手机上怎么说:那几样要在电脑上看着定。 */
export const PROPOSAL_NOTE = '在电脑上定';

/** 要他定的那一件(卡 O:派不出去 / 到上限停下来了)的附注。 */
export const DECIDE_NOTE = '要你定';

/**
 * ★ **「等你」那一行指的是哪条会话 —— 首页与点进去那张卡只问这一处**(2026-10-03,审计第四节第 1、2 条)。
 *
 * 工作台 `/state.waiting` 的「等你」行把两路会话数在一起(插件 `waiting.ts` 的 `waitingSessions`):
 * 会话文件那几家(`state.sessions`)+ 登记表里读窗口读出来的(`agent_registry.entries[].sessions`,`via:'window'`)。
 * 从前手机两处都只在 `state.sessions` 里找 —— 窗口型(豆包 / Muse / Manus)只在登记表里,
 * 于是首页列得出、点进去只剩一行字:选项键、「我自己说」一颗都不渲染,附注还误成「到电脑上回答」。
 *
 * 登记表里 `via:'sessions'` 那几条是 `state.sessions` 的副本,**不从登记表取**(免得同一条会话算两份)。
 * 认键走 {@link sessionJobMatches}:新拼法与 10-03 之前的老拼法都认(新手机连老插件)。
 */
export function askSessionOf(
  state: Pick<WorkbenchState, 'sessions' | 'agent_registry'>,
  key: string,
): AskSessionView | undefined {
  const file = state.sessions.find((one) => sessionJobMatches(key, one.agent, one.session_id));
  if (file !== undefined) return file;
  for (const entry of state.agent_registry?.entries ?? []) {
    const found = entry.sessions.find((one) => one.via !== 'sessions' && sessionJobMatches(key, one.agent, one.session_id));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 「等你确认」那一格与它点开那几页上的行 —— **一件对一行,就是「等你」那一堆**(2026-09-25,卡 M 追加;
 * 统筹:「还有 N 件要你看」「等你 n」、事务官标签上的数、手机「等你确认」数的必须是同一堆、同一个数)。
 * 顺序照那一堆:问你的 → 要你批的 → 单子 → 提议 → 办完了等你确认的。字尽量用手机这边原来那几句(带附注)。
 */
export function waitingRows(state: WorkbenchState): WaitingRow[] {
  const inbox = state.butler_inbox?.items ?? [];
  return waitingPile(state).items.map((item): WaitingRow => {
    const id = item.key.slice(item.key.indexOf(':') + 1);
    if (item.kind === 'question') {
      const question = (state.questions ?? []).find((one) => one.id === id);
      return { ...(question === undefined ? { id: item.key, text: item.text, note: '要你回答' } : questionLine(question)), kind: 'question' };
    }
    if (item.kind === 'approval') {
      const approval = (state.approvals ?? []).find((one) => one.id === id);
      return { ...(approval === undefined ? { id: item.key, text: item.text, note: '要你批' } : approvalLine(approval)), kind: 'approval' };
    }
    if (item.kind === 'plan') {
      const line = setupLine(state);
      return { ...(line ?? { id: item.key, text: SETUP_LINE_TEXT }), kind: 'plan' };
    }
    if (item.kind === 'confirm') {
      const event = inbox.find((one) => one.kind === 'confirm' && (one.task_id ?? one.id) === id);
      return { ...(event === undefined ? { id: item.key, text: item.text } : inboxLine(event)), kind: 'confirm', taskId: id };
    }
    if (item.kind === 'session') {
      /*
       * 别家的会话在等他(卡 T):一行就是工作台写好的那句人话;送不回去的附一句「到电脑上回答」。
       * ★ 2026-10-03(审计第四节):这一行与点进去那张卡**查同一份会话**({@link askSessionOf})——
       * 从前这里只在 `state.sessions` 里找,窗口型那几家只在登记表里,于是附注一律误成「到电脑上回答」。
       */
      const one = askSessionOf(state, item.key);
      const ask = one?.ask;
      // `agent`(卡 LG3):哪一家在等他,名字前那张 logo 按它取;会话一时找不到才退回从键上拆。
      const agent = one?.agent ?? sessionOfJob(item.key)?.agent;
      return { id: item.key, kind: 'session', text: item.text, note: ask !== undefined && (ask.reply === 'window' || ask.reply === 'cli') ? '要你回答' : '到电脑上回答', ...(agent === undefined ? {} : { agent }) };
    }
    // 要他定的(卡 O):派不出去 / 到上限停下来了。点下去是那件事的详情(那几颗键在那儿:继续 / 停掉 / 换一家;登录要在电脑前)。
    if (item.kind === 'decide') return { id: item.key, kind: 'decide', text: item.text, note: DECIDE_NOTE, taskId: id };
    return { id: item.key, kind: item.kind, text: item.text, note: PROPOSAL_NOTE };
  });
}

/**
 * 「等你确认」里除了这一页已经摆着的那几样之外的几件(单子那一页:除了单子;问你 / 要你批那一页:除了那几张卡)。
 * 2026-09-25 卡 fix/confirm-cancel 起单子那一页顶上列「另外 N 件」;卡 M 追加起它就是「等你」那一堆去掉这一页上的 ——
 * 两页上「另外 N 件」加上这一页摆着的,正好是首页那一格的数。
 */
export function otherWaiting(state: WorkbenchState, except: readonly WaitingKind[]): WaitingRow[] {
  return waitingRows(state).filter((row) => !except.includes(row.kind));
}

/** 单子那一页上的「另外 N 件」(卡 fix/confirm-cancel 那个名字留着):除了单子之外的那几件。 */
export function otherConfirms(state: WorkbenchState): WaitingRow[] {
  return otherWaiting(state, ['plan']);
}

/**
 * 引导落地那张单子(2026-09-25,卡 feat/onboarding-materialize 放进卡 A 的五卡首页):**等他点头 / 正在落**时,
 * 在「等你确认」那一格置顶一行「我照你说的摆好了」,整张卡点下去是整张单子(`{ page: 'setup' }`)。落好了就不在这一格了 ——
 * 那不是一件等他确认的事(回执在那一页上、首页飘一句)。
 */
export function setupLine(state: WorkbenchState): { id: string; text: string; note?: string } | undefined {
  const view = state.materialize;
  if (view === undefined || view.status === 'applied') return undefined;
  // 半宽那一格只摆得下一行字:「等你点头」不另写(它就在「等你确认」这一格里),只在正在落的那几秒说一声。
  return { id: `setup:${view.id}`, text: SETUP_LINE_TEXT, ...(view.status === 'applying' ? { note: '正在落…' } : {}) };
}

/**
 * **首页主列上留的那两张**(2026-10-03 傍晚,维护者看过示意图后拍的方案 B)。原话:
 *
 * > 只保留正在办和待确认两个是卡片,其他都和前面一样做成 icon 就 OK……中间的球球还是要大的,
 * > 这个事情是要适配 Live2D 的显示空间,省出来的空间 Live2D 也能放大。
 *
 * 其余三张(今天要做 / 最近一次通话 / 资讯)搬成球下那一排图标(`stage/HomeRail.tsx`),
 * 内容在各自那一页上。{@link stageCards} 照旧是那五样「是什么」的**全份口径**,不动。
 */
export const HOME_CARD_IDS: readonly StageCardId[] = ['doing', 'confirm'];

/**
 * 首页主列那两张,**并排各占一半**。
 *
 * 所以「正在办」那一张**不再占整行**(`wide: false`):半宽那一格里「哪一家在办」不能再独占右边一格
 * ——「Claude · 内含 3 项后台任务」在 175px 上会把标题挤到只剩一个省略号。半宽按别的卡那条老规矩走:
 * 标题优先、附注跟在同一行后面、地方不够先没附注(画它的那一处与 `[data-wide="true"]` 那几条 CSS 都认这个格子)。
 */
export function homeCards(state: WorkbenchState, rows: number = CARD_ROWS): StageCard[] {
  return stageCards(state, undefined, rows)
    .filter((card) => HOME_CARD_IDS.includes(card.id))
    .map((card) => ({ ...card, wide: false }));
}

/**
 * 首页那五样各自是什么。顺序是 2026-10-03 之前屏幕上从上到下的顺序:
 * 正在办(整行)→ 等你确认 · 今天要做 → 最近一次通话 · 资讯。
 *
 * 2026-10-03 傍晚(方案 B)起**只有前两张画在主列上**({@link homeCards});后三张是球下那一排图标,
 * 它们的内容在各自那一页上。这个函数照旧是五样「是什么」的唯一出处(用例认它),一个字没动。
 */
export function stageCards(state: WorkbenchState, news?: NewsGlance, rows: number = CARD_ROWS): StageCard[] {
  // 「等你」那一堆(卡 M 追加):工作台算好的那一份,一件一行、数就是它的数 —— 与电脑球下「等你 n」、「事务官」标签上的数同一个。
  // 顺序照那一堆:问你的、要你批的排最前(那件事正卡在这儿等你);「我照你说的摆好了」其次(卡 B);提议;办完了等你确认的。
  const pile = waitingPile(state);
  const waiting = waitingRows(state);
  // `agent` 一路带到卡片上(卡 LG3):「Grok Bot 在等你选」那一行前面要画它的 logo。
  const confirmFit = fitRows(waiting.map(({ id, text, note, agent }) => ({ id, text, ...(note === undefined ? {} : { note }), ...(agent === undefined ? {} : { agent }) })), rows);
  const onAsksPage = waiting.some((row) => row.kind === 'question' || row.kind === 'approval' || row.kind === 'proposal' || row.kind === 'session');
  const hasPlan = waiting.some((row) => row.kind === 'plan');
  // 「今天要做」换成卡 N 的那一份:他自己的在前、挂着问的那几张不算(合并卡 W 09-25)。
  const open = todayTasks(state);
  const openFit = fitRows(open, rows);
  return [
    doingCard(state, rows),
    {
      id: 'confirm',
      title: '等你确认',
      // 与电脑球下「等你 n」「还有 N 件要你看」、「事务官」标签上的数同一个数(维护者硬规矩:同一件事的数字各处一致)。
      count: pile.count,
      lines: confirmFit.shown,
      ...(confirmFit.more === undefined ? {} : { more: confirmFit.more }),
      empty: '没有要你确认的。',
      // 单子等他点头时,整张卡点下去先看单子(最要紧的那一件);别的待确认在单子那一页顶上列着,点一件打开它
      //(2026-09-25,卡 fix/confirm-cancel:以前那几件没有入口)。
      // 有问你的 / 要你批的 / 提议:整张卡点下去先到那一页(最急;提议也列在那一页);没有就照旧。
      to: onAsksPage ? { page: 'asks' } : hasPlan ? { page: 'setup' } : { page: 'inbox', tab: 'waiting' },
    },
    {
      id: 'today',
      title: '今天要做',
      // 右上角那个数**永远是总数** —— 它和下面列出来的几行不是同一个数,也不该是。
      count: open.length,
      lines: openFit.shown.map(taskLine),
      ...(openFit.more === undefined ? {} : { more: openFit.more }),
      empty: '今天没有要办的事。',
      to: { page: 'inbox', tab: 'queued' },
    },
    callCard(state),
    feedCard(news, state.now),
  ];
}
