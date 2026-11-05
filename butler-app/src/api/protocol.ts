/**
 * 工作台 /state 里手机端用得到的那一小块。**只加可选字段的三方契约**在
 * workbench-plugin/src/protocol.ts,这里是它的只读子集(字段名一字不改);
 * 手机不认识的字段一律忽略,服务端多给不会坏。
 */
export type AgentId = 'dsh' | 'claude' | 'codex' | 'kimi';
export type SessionStatus = 'waiting' | 'running' | 'done' | 'error' | 'offline';
export type WaitReason = 'approval' | 'input' | 'quota' | 'error';
export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'confirm' | 'done' | 'blocked' | 'canceled';
export type TaskDirection = 'mine' | 'butler';

export const STATUS_TITLES: Record<TaskStatus, string> = {
  backlog: '待排',
  todo: '待办',
  doing: '进行中',
  confirm: '等我确认',
  done: '完成',
  blocked: '阻塞',
  canceled: '取消',
};

/**
 * 「只是问了一句」(2026-09-25,卡 Y)。与工作台 `server/casualAsk.ts` 的 `CASUAL_ASK_NOTE` **逐字相同**:
 * 两边各写一句,同一张卡在电脑上和手机上说的话就会不一样。
 */
export const CASUAL_ASK_LABEL = '只是问了一句';

export const WAIT_REASON_TITLES: Record<WaitReason, string> = {
  approval: '等审批',
  input: '等你输入',
  quota: '额度不足',
  error: '出错',
};

/** 开不出会话时那句话,与服务端 protocol.ts 的 BUTLER_NO_SESSION_NOTE 同词。 */
export const BUTLER_NO_SESSION_NOTE = '会话未开';

export interface SessionView {
  agent: AgentId;
  session_id: string;
  project: string;
  status: SessionStatus;
  wait_reason?: WaitReason;
  title?: string;
  /** 最新一段回复的摘要。**DSH 会话今天不填这个字段**(见交接「需要工作台配合」),填了手机就当回复读出来。 */
  summary?: string;
  /** 最近在做什么(2026-09-25,卡 P):一句人话 + 那一刻。读不到就缺席(写「读不到它在做什么」)。 */
  activity?: SessionActivity;
  /** 这条会话停着在等他什么(2026-09-25,卡 T;工作台判好的,见 {@link SessionAskView})。 */
  ask?: SessionAskView;
  elapsed_sec: number;
  unread: boolean;
  updated_at: string;
  /**
   * **这条会话是工作台自己起的**(2026-09-25,卡 V):能力体检 / 派活探针 / 统筹自测那一类。
   * 有这一格的**不进首页「正在办」、不计入任何数**。与 workbench-plugin/src/protocol.ts 的 `SelfcheckView` 同形。
   */
  selfcheck?: { kind?: 'caps' | 'dispatch' | 'selftest'; by: 'env' | 'prefix' | 'cwd' };
  /** 出错时那一句人话 + 一键入口(工作台翻好的;「Not logged in · Please run /login」→「Claude 命令行还没登录」)。 */
  human_error?: { line: string; action?: string; raw?: string };
  /** 判成这个状态的依据,一句话(给排错看,界面不必显示)。 */
  status_why?: string;
  /** 记录里明写着停下来在等人(形式信号;内容判断归卡 T)。 */
  formal_wait?: 'approval' | 'question';
  /**
   * 这条会话底下的后台任务(2026-09-25,卡 Q):Claude 的子代理、事务官派出去的活……同一个形状。
   * 只挂在主会话上:子任务不单独成一张卡、不单独算「正在办」。与 workbench-plugin/src/protocol.ts 的 `SessionChildView` 同形。
   */
  children?: readonly SessionChildView[];
}

export type SessionChildStatus = 'running' | 'waiting' | 'done' | 'error';

/** 主会话底下的一项后台任务。给他看的只有描述、状态、在做什么、时间;id、型号不露。 */
export interface SessionChildView {
  id: string;
  parent_session_id: string;
  title: string;
  status: SessionChildStatus;
  activity?: SessionActivity;
  started_at?: string;
  ended_at?: string;
  model?: string;
}

export const SESSION_CHILD_STATUS_TEXT: Readonly<Record<SessionChildStatus, string>> = {
  running: '在跑', waiting: '等你', done: '办完了', error: '出错了',
};

/** 主卡上那一行:「内含 3 项后台任务 · 在跑 2 · 等你 1」(电脑上同一句)。没有后台任务 → undefined。 */
export function sessionChildrenLine(children: readonly Pick<SessionChildView, 'status'>[] | undefined): string | undefined {
  const list = children ?? [];
  if (list.length === 0) return undefined;
  const running = list.filter((one) => one.status === 'running').length;
  const waiting = list.filter((one) => one.status === 'waiting').length;
  const parts = [`内含 ${list.length} 项后台任务`];
  if (running > 0) parts.push(`在跑 ${running}`);
  if (waiting > 0) parts.push(`等你 ${waiting}`);
  if (running === 0 && waiting === 0) parts.push('都办完了');
  return parts.join(' · ');
}

/** 展开之后一项一行的第二行:「在跑 · 在跑测试 · 3 分钟前」。 */
export function sessionChildLine(child: Pick<SessionChildView, 'status' | 'activity' | 'started_at' | 'ended_at'>, now: string): string {
  const parts: string[] = [SESSION_CHILD_STATUS_TEXT[child.status]];
  if (child.activity !== undefined && child.activity.line.trim() !== '') parts.push(child.activity.line);
  const at = child.activity?.at ?? child.ended_at ?? child.started_at;
  const ago = at === undefined ? undefined : agoLabel(at, now);
  if (ago !== undefined) parts.push(ago);
  return parts.join(' · ');
}

/** 主会话算不算「在办」:它自己在跑,或者底下有后台任务在跑 / 在等你(只算这一条主会话一次)。 */
export function sessionBusy(session: Pick<SessionView, 'status'> & { children?: readonly Pick<SessionChildView, 'status'>[] }): boolean {
  if (session.status === 'running') return true;
  if (session.status === 'offline') return false;
  return (session.children ?? []).some((child) => child.status === 'running' || child.status === 'waiting');
}

export interface TaskConversation {
  agent: 'dsh';
  session_id: string;
  archived_at?: string;
}

/**
 * 这是哪一种事项(2026-09-21 选题池 / 2026-09-22 需求卡)。**缺省 = 普通事项**。
 * 手机上唯一的用处:`feature` 的卡点开的是需求卡页,不是那张只读的详情卡。
 */
export type TaskKind = 'topic' | 'feature';

/**
 * 派给别家 Agent 那一次(命令行 / 接口那两只手)。手机只读它算小标,不发起派活。
 * 权威定义在 workbench-plugin/src/protocol.ts 的 `TaskDispatch`,这里只抄用得着的三格。
 */
export interface DispatchRuntimeView {
  attempt_id: string;
  mode: 'new' | 'resume';
  started_at: string;
  requested: { model?: string; effort?: string };
  observed: { model?: string; effort?: string };
  status: 'verified' | 'mismatch' | 'unverified';
  source?: 'native_context' | 'cli_result';
  session_id?: string;
  turn_id?: string;
}
export interface TaskDispatchView {
  runtime?: DispatchRuntimeView;
  selection?: { evaluated_at: string; family: string; reason: string; candidates: readonly { family: string; ok: boolean; quota: string; level: 'ok' | 'low' | 'empty' | 'unknown'; read_at?: string }[] };
  status: 'running' | 'done' | 'failed';
  /** 卡 O:不是没做成,是停下来的(他点了「停掉这一件」/ 到时长上限)。有它就不按失败染红。 */
  stopped?: 'user' | 'cap';
  started_at: string;
  /** 2026-09-24(卡 F)起抄进来的几格:派给谁、哪只手、失败原话、**收回来的回答**。 */
  family?: string;
  hand?: 'cli' | 'api' | 'window';
  note?: string;
  reply?: string;
}

/** 送话进客户端窗口那一次(第三只手)。同上,只抄用得着的几格。 */
export interface TaskClientDispatchView {
  runtime?: DispatchRuntimeView;
  selection?: TaskDispatchView['selection'];
  /** `typed` = 字写进框里了、没发出去(2026-09-28,卡 WR)。 */
  status: 'sent' | 'typed' | 'failed';
  at: string;
  /** 2026-09-24(卡 F)起:派给谁、回答收回来没有、回答原文、读不回来时那一句。 */
  family?: string;
  reply_state?: 'waiting' | 'done' | 'unreadable';
  reply?: string;
  reply_note?: string;
  reason?: string;
  /** 在它对话区里亲眼看见我们那一句的时刻(2026-09-30):这是「已送达」的唯一凭据。 */
  seen_at?: string;
  /** 按了发送、当场没核上时那一句。 */
  confirm_note?: string;
}

/**
 * **这一件到底派出去了没有**(2026-09-30 维护者拍板:派活成功不回电话,那就得在卡上一眼看得出来)。
 *
 * 真身在工作台 `workbench-plugin/src/protocol.ts` 的 `clientDispatchDelivery` / `clientDeliveryLine`;
 * 两个工程互不 import,所以这里照抄一份,由 `tests/deliveryLineMirror.test.ts` 读那个文件比对(不靠注释同步)。
 */
export type ClientDispatchDelivery = 'seen' | 'unconfirmed' | 'typed' | 'failed';

export function clientDispatchDelivery(dispatch: TaskClientDispatchView): ClientDispatchDelivery {
  if (dispatch.status === 'failed') return 'failed';
  if (dispatch.status === 'typed') return 'typed';
  if (dispatch.seen_at !== undefined || dispatch.reply_state === 'done') return 'seen';
  return 'unconfirmed';
}

export function clientDeliveryLine(dispatch: TaskClientDispatchView, name?: string): string {
  const who = name ?? dispatch.family ?? '那一家';
  const why = dispatch.reason === undefined || dispatch.reason.trim() === '' ? '' : `:${dispatch.reason.trim()}`;
  switch (clientDispatchDelivery(dispatch)) {
    case 'seen': return `已派出 · ${who}那边看到了`;
    case 'unconfirmed': return `按了发送,还没在${who}那边看到 —— 我在盯着`;
    case 'typed': return `没派出去:字写进${who}的输入框了,没发出去`;
    default: return `没派出去${why === '' ? `:${who}那边没送成` : why}`;
  }
}

export interface TaskView {
  id: string;
  title: string;
  /** 这句话落下时事务官回她的那一句(2026-10-24,卡 1a):手机与电脑同一来源,优先显示它。 */
  say_note?: string;
  desc?: string;
  status: TaskStatus;
  /** 协作区公共账字段，与工作台同源。 */
  goal_id?: string;
  acceptance?: readonly string[];
  comments?: readonly NoteComment[];
  receipt?: NoteReceipt;
  /** 要本人拍板的结构化请求(2026-10-26 抄进这份子集):带它、章在「等我确认」才轮到她拍板;判据 `ownerAskOf`。 */
  owner_ask?: OwnerAsk;
  children?: readonly string[];
  from?: NoteFrom;
  collaborators?: readonly string[];
  watchers?: readonly string[];
  start?: string;
  end?: string;
  planned_at?: string;
  labels?: readonly string[];
  messages?: readonly NoteMessage[];
  transitions?: readonly TaskTransition[];
  round?: number;
  block_reason?: WaitReason;
  project_id?: string;
  direction?: TaskDirection;
  conversation?: TaskConversation;
  /**
   * 预期结束时间 / 发布日(`YYYY-MM-DD`)。2026-09-21 抄进这份子集:展示台「今日要做」
   * 那块卡片在标题后面写一行它。字段名与工作台那份逐字相同,没有就是没有。
   */
  due?: string;
  /**
   * 这是哪一种事项(2026-09-23 抄进这份子集)。缺省 = 普通事项,老卡一字不变。
   * `feature` 时 `feature_stage` 才有意义(四态之一),`topic` 时是 `stage`(六段之一)。
   */
  kind?: TaskKind;
  /** 需求卡走到哪一态。缺省 = 还没写过进度,按「梳理」读,**但手机不替他往盘上写**。 */
  feature_stage?: string;
  /** 选题卡走到哪一段(六段之一)。这一版手机上只显示,不推进。 */
  stage?: string;
  /**
   * 「只是问了一句」(2026-09-25 抄进这份子集,卡 Y)。她答完自己判的:这一轮没派出去、没改文件、
   * 没有要交回的东西 → 不算一件事,卡进「完成」并盖这个章。手机上**不进「等你确认」、不上字幕**
   * (它连 `confirm` 都没进,那两处本来就数不到它),事项页「办完」那一摞里那一格说「只是问了一句」而不是「完成」。
   */
  casual?: boolean;
  /**
   * ★ **她看过这件事的结果了**(2026-10-04 抄进这份子集,卡 `claude/answer-comes-to-her`;ISO 时刻)。
   * 办完的事先在首页挂一张「刚办完 · 结果一句话」,她点开看过或划掉才盖这一格、收进「办完」。
   * **这是她这一端的状态,不是这件事的状态**(状态还是 `done`)。
   * 手机这一侧只读;写只走 `POST /task/seen-result`。缺席 = 还没看过 / 老工作台。
   */
  seen_result_at?: string;
  /** 派活那一次(命令行 / 接口)。用来算卡上那颗四档小标。 */
  dispatch?: TaskDispatchView;
  /** 送话进窗口那一次。同上。 */
  client_dispatch?: TaskClientDispatchView;
  /**
   * 卡上挂着的各家会话(2026-09-25 抄进这份子集)。首页「正在办」拿它认「这条在跑的会话是不是已经算在这件事里」,
   * 与电脑端 butlerSceneModel 同一个去重口径。
   */
  links?: readonly TaskLinkView[];
  /** 转卡来源(2026-09-25 抄进来):老卡没有 origin 时认「会议来的」要它。 */
  source?: { kind: string; ref?: string };
  /** 这条事项是谁写下的(2026-09-25)。见 {@link TaskOrigin}。 */
  origin?: TaskOrigin;
  /** 这张卡是一通电话的纪要(2026-09-25)。首页「最近一次通话」读它。 */
  call?: TaskCallMeta;
  /** 派活挑不到手(2026-09-25,卡 O):为什么、修法、能换谁。与工作台 `TaskDispatchBlock` 同形。 */
  dispatch_block?: TaskDispatchBlockView;
  /** 这件事的花费 / 时长上限(卡 O;只有事务官自己在办的才有)。与工作台 `TaskBudgetView` 同形。 */
  budget?: TaskBudgetView;
  /**
   * 工作台记在卡上的一句话(2026-09-25 抄进这份子集,卡 O):派不出去 / 到上限停下来时,卡上的备注往往就是那一句,
   * 手机上的 `blockLine` / `pausedLine` 拿它去重,免得同一句念两遍。与工作台那份同名同义,**只由服务端写**。
   * 也是卡 N 写在卡上的那句(「你没批,这张先不派给 Claude」「会话未开」)—— 同一格。
   */
  note?: string;
  /**
   * 负责人(2026-09-25 卡 N 抄进来):某家 AI / 事务官(`dsh`)/ 他(`me`)/ 同事 / 别人。**负责人决定谁动** ——
   * 写了负责人的看板卡就是一件事项(见 {@link isTrackedItem})。
   */
  assignee?: string;
  /** 负责人那一格的补充(「9/29 回来写」)。 */
  assignee_note?: string;
  /**
   * 谁管这件事:派活与验收的那一方(2026-10-27,协作区与事务官标签页合并 §3.1;与工作台那份同名同义)。
   * 事务官建的、派的是 `dsh`;缺席 = 不知道,界面不写、不猜。
   */
  manager?: string;
  /** 交回来的东西(2026-09-25 抄进来):手机只认 `reply` —— 「XX 到哪了」当场答的那一句也挂在这里。 */
  deliverables?: readonly { kind: string; ref: string }[];
  /** 现在到哪 · 依据 · 什么时候看的(卡 N 进度核对)。没核过缺席。 */
  progress?: TaskProgressView;
  /** 现在该谁动(卡 N,服务端每次 /state 现算)。 */
  mover?: TaskMoverView;
  /** 没办完的停在哪(2026-10-12,与工作台 `TaskView.standing` 同形;服务端每次 /state 现算)。老工作台缺席。 */
  standing?: ItemStandingView;
  done_at?: string;
  created_at: string;
  updated_at: string;
}

/** 一键修(卡 O)。`desk_only` 的只能在电脑前做 —— 手机上只说一句,不画按钮。 */
export interface CapFixView {
  kind: 'login_cli' | 'grant_ax' | 'update_shell';
  family: string;
  label: string;
  hint?: string;
  desk_only?: boolean;
}

export interface TaskDispatchBlockView {
  family: string;
  kind: 'code' | 'chat';
  why: string;
  fix?: CapFixView;
  alternatives?: readonly { family: string; title: string; note?: string }[];
  /**
   * 电脑锁着屏、这件派活排着队,解锁后自动重派(2026-10-12 抄进这份子集;与工作台 `TaskDispatchBlock.unlock` 同名同义)。
   * 有它时「等什么」那一格说 {@link UNLOCK_WAIT_LABEL}。
   */
  unlock?: true;
  at: string;
}

/** 卡挂着「在等你解锁电脑」时那一格的字(与工作台 protocol.ts 同名同值,`tests/unlockWaitParity.test.ts` 比对)。 */
export const UNLOCK_WAIT_LABEL = '等你解锁电脑(解锁就送)';

export interface TaskBudgetView {
  limit_cny: number;
  limit_minutes: number;
  spent_cny?: number;
  run_minutes?: number;
  requests?: number;
  model?: string;
  state: 'running' | 'paused' | 'stopped';
  extended?: number;
  note?: string;
  paused_at?: string;
  switch_to?: string;
  /** 这一格管的是派给那家命令行的活(只管时间;钱算在那家自己的额度上)。与工作台 `TaskBudgetView.cli_family` 同义。 */
  cli_family?: string;
  /**
   * 事务官自己报的「我卡在哪」(2026-10-04,卡「事务官上限只看钱」)。
   * 手机上那一问的正文由工作台拼好下发(`/asks` 里那一句),这一格只是同一份契约的镜像 ——
   * 手机端不自己拼那句话。缺席 = 它没说。
   */
  stuck?: string;
  stuck_at?: string;
  /**
   * ★ **不再用**(2026-10-04 去掉了步数线)。老卡上可能还带着这一格,手机端一律不显示。
   */
  limit_steps?: number;
}

/** 各家能力体检那一格(卡 O)。 */
export interface CapCellView {
  state: 'ok' | 'no' | 'unknown' | 'na';
  note: string;
  via?: string;
  fix?: CapFixView;
}

export interface AgentCapsView {
  agents: readonly { family: string; title: string; installed?: boolean; cells: { chat: CapCellView; edit: CapCellView; collect: CapCellView }; line: string }[];
  checked_at?: string;
  checking?: boolean;
  login_wait?: { family: string; since: string };
  line: string;
}

/**
 * 一家的额度(卡 O,与 workbench-plugin/src/protocol.ts 的 `AgentQuotaView` 同形,只取手机用得上的几格):
 * 三格之一 —— 有数 / 不限(查实过的)/ 没接上:原因。
 */
export interface AgentQuotaView {
  id: string;
  title: string;
  state: 'numbers' | 'unlimited' | 'unconnected';
  line: string;
  short?: string;
  level?: 'ok' | 'low' | 'empty';
  source?: string;
  why?: string;
  fix?: { kind: string; label: string; hint?: string; desk_only?: boolean };
  /**
   * 这个数**截至**什么时候(2026-09-26 卡 QS 引入;2026-10-02 卡 QA 起是来源自己给的真时刻,
   * 不再是「第一次看见这个值」的代用品)。超过一刻钟没读到新的,`line` 里就带着「截至 21:00」。
   */
  read_at?: string;
  /**
   * 这一家的用量**页面上是分几行列的**(2026-09-27,卡 AG;与 workbench-plugin 的 `QuotaWindow` 同形)。
   *
   * 电脑上一行一条横条;手机上**照它页面怎么列就怎么列地写成一句**(见 `quotaRowWords`)——
   * 上面那句 `line` 照旧只说**最紧的那一行**(派活确认点、通知里读的都是它,不改),
   * 这一格是补在它后面的细账。`group` 是页面上的组名原话(Antigravity 的「Gemini Models」
   * 「Claude and GPT models」),没分组的那几家没有这一格。
   */
  windows?: readonly { label: string; left_pct: number; reset_at?: string; group?: string }[];
  /**
   * 这个数是上次读到的、而且**过线了**(离 `read_at` 超过 2 小时)。
   *
   * ★ 2026-10-02(卡 QA):原来这一档是「标灰但照说那个数」(线是 6 小时)。维护者 21:3x:
   * 「本机上的 Claude 额度,一晚上了,还是 100%」—— 标灰不够,她看见的还是一个百分比。
   * 现在服务端把 `left_pct` / `left` / `windows` 一并摘掉,`line` 就是「读不到最新的,上次 04:27」
   * ——所以手机这一侧**写不出百分比**(`quotaRowWords` 自然没有行可写),照原话摆、把那一行画淡即可。
   * 仍然**不改成「没接上」**(那是从没接上才用的词)。
   */
  stale?: boolean;
  /**
   * 过线那一格该多说哪两句(2026-10-02,卡 QK;与工作台 `QuotaStaleHint` 同形)。
   *
   * 卡 QA 之后 `line` 只说「读不到最新的,上次 04:27」—— 不骗人了,可**为什么**读不到、
   * 她能做什么,一个字都没有。那两句(「Claude 桌面没在跑」「配一把 Claude 的密钥就能实时」)
   * 由各家额度来源自己声明(工作台 `quota/liveSources.ts` 一处),服务端已经拼进 `line` 里,
   * **手机照念就够了**(`quotaWords`)。
   *
   * 这一格另给一份只为一件事:`live.fix` 是**只能在电脑前做**的那一步(`desk_only`)——
   * 手机上一颗按钮都不画(按了也够不着那台 Mac 的屏幕,同这一页其余的修法)。
   */
  stale_hint?: {
    why?: string;
    live?: { why: string; fix?: { label: string; at: { group: string; row: string }; desk_only?: boolean } };
  };
}

/** 进度的依据(与工作台 `ProgressBasisView` 同形)。依据只给人看出处与时刻,`ref` 手机不显示。 */
export interface ProgressBasisView {
  kind: string;
  source: string;
  ref?: string;
  at?: string;
  quote?: string;
}

/** 一张卡「现在到哪」(与工作台 `TaskProgressView` 同形)。 */
export interface TaskProgressView {
  line: string;
  state: 'found' | 'none' | 'mismatch';
  basis: readonly ProgressBasisView[];
  checked_at: string;
  waiting_on?: 'me' | 'agent' | 'others' | 'nobody';
  mismatch?: string;
  by: 'model' | 'rules';
  changed?: boolean;
  /** 这一轮看没看各家 AI 的对话(与工作台同名字段)。 */
  read_sessions?: boolean;
}

/** 现在该谁动(与工作台 `TaskMoverView` 同形)。 */
export interface TaskMoverView {
  who: 'me' | 'butler' | 'agent' | 'others' | 'none';
  line: string;
  assignee?: string;
}

// ——— 没办完的事项停在哪(2026-10-12)。照抄工作台 protocol.ts 那一段,`tests/itemStanding.test.ts` 读源文件比对 ———

export type ItemStandingCase = 'waiting_her' | 'in_motion' | 'waiting_others' | 'queued' | 'result_unwritten' | 'channel_failed' | 'likely_moot';

export const ITEM_STANDING_CASE_TITLES: Readonly<Record<ItemStandingCase, string>> = {
  waiting_her: '等你',
  in_motion: '在做',
  waiting_others: '等别人',
  queued: '排着',
  result_unwritten: '结果回来了没收进卡',
  channel_failed: '没派成,停着',
  likely_moot: '多半不需要了',
};

export type ItemEvidenceSource = 'dispatch' | 'session' | 'her' | 'card';

export const ITEM_EVIDENCE_SOURCE_TITLES: Readonly<Record<ItemEvidenceSource, string>> = {
  dispatch: '派活回执',
  session: '会话',
  her: '你的操作',
  card: '卡上改动',
};

export type ItemWaitingOn = 'her' | 'agent' | 'unlock' | 'others' | 'nobody';
export type ItemStandingAction = 'continue' | 'close' | 'redispatch';

export const ITEM_STANDING_ACTION_TITLES: Readonly<Record<ItemStandingAction, string>> = {
  continue: '继续',
  close: '关掉',
  redispatch: '重派',
};

export interface ItemStandingView {
  case: ItemStandingCase;
  last?: { what: string; at: string; source: ItemEvidenceSource };
  waiting_on: ItemWaitingOn;
  agent?: string;
  next: string;
  idle_days?: number;
  stalled?: true;
  actions?: readonly ItemStandingAction[];
}

/** 三个选择各走哪个现有入口(与工作台 `itemStandingRequest` 同表)。 */
export function itemStandingRequest(taskId: string, standing: ItemStandingCase, action: ItemStandingAction):
  { path: '/task/move'; body: { id: string; status: 'canceled' | 'confirm' } } | { path: '/item/drive'; body: { task_id: string } } | { open: true } {
  if (action === 'close') return { path: '/task/move', body: { id: taskId, status: 'canceled' } };
  if (action === 'redispatch') return { path: '/item/drive', body: { task_id: taskId } };
  if (standing === 'result_unwritten') return { path: '/task/move', body: { id: taskId, status: 'confirm' } };
  if (standing === 'likely_moot') return { path: '/item/drive', body: { task_id: taskId } };
  return { open: true };
}

/** 「在等谁」那一句(与工作台 `standingWaitingText` 同句)。 */
export function standingWaitingText(standing: Pick<ItemStandingView, 'waiting_on'>, agentName?: string): string {
  switch (standing.waiting_on) {
    case 'her': return '在等你';
    case 'agent': return `在等 ${agentName ?? '那一家'}`;
    case 'unlock': return '在等你解锁电脑';
    case 'others': return '在等别人';
    case 'nobody': return '没人在等';
  }
}

/* ─────────────── 协作核心公共镜像;权威源 workbench-plugin/src/protocol.ts ─────────────── */
export type NoteFromKind = 'meeting' | 'session' | 'said' | 'channel' | 'evidence' | 'user';
export interface NoteFrom { kind: NoteFromKind; ref?: string; quote?: string }
export type NoteReceiptKind = 'done' | 'objection' | 'blocked';
export interface NoteReceipt { kind: NoteReceiptKind; text: string; message_id?: string; evidence?: readonly string[]; by?: string; source_session_id?: string; source_round?: string; task_round?: number; at: string }
/**
 * 要本人拍板的四类(2026-10-26 抄进这份子集,卡「事务官页接管队列」;与工作台 protocol.ts 逐字同源)。
 * 只有花钱 / 新对外发布 / 本人账号与设备配对 / 习惯与范围取舍四类能标成 OwnerAsk。
 */
export type OwnerAskKind = 'spend' | 'publish' | 'pairing' | 'scope';
export const OWNER_ASK_KINDS: readonly OwnerAskKind[] = ['spend', 'publish', 'pairing', 'scope'];
export const OWNER_ASK_TITLES: Record<OwnerAskKind, string> = { spend: '花钱', publish: '对外发布', pairing: '账号与设备配对', scope: '习惯与范围' };
export function isOwnerAskKind(value: unknown): value is OwnerAskKind {
  return typeof value === 'string' && (OWNER_ASK_KINDS as readonly string[]).includes(value);
}
export interface OwnerAsk { kind: OwnerAskKind; proposal: string; basis: string; by?: string; at: string }
/** 这一件「等我确认」此刻轮不轮到本人:章在「等我确认」、且带四类之一的结构化请求(判据与工作台同一处)。 */
export function ownerAskOf(task: Pick<TaskView, 'status' | 'owner_ask'>): OwnerAsk | undefined {
  if (task.status !== 'confirm') return undefined;
  const ask = task.owner_ask;
  return ask !== undefined && isOwnerAskKind(ask.kind) ? ask : undefined;
}
export interface NoteComment { id: string; by: string; text: string; at: string; verdict?: 'pass' | 'rework' | 'self'; resolved_by?: string; resolved_at?: string; intent?: 'supplement' | 'redirect' | 'hurry' | 'recall' }
export type NoteMessageIntent = 'record' | 'ask';
export interface MessageDelivery { task_id?: string; receipt?: NoteReceipt; to: string; status: 'pending' | 'delivered' | 'accepted' | 'failed'; error?: string; at: string }
export interface NoteMessage { id: string; client_msg_id?: string; by: string; text: string; at: string; intent: NoteMessageIntent; mentions?: readonly string[]; reply_to?: string; deliveries?: readonly MessageDelivery[] }
export interface TaskTransition { from: TaskStatus; to: TaskStatus; at: string }
export type ActivityItem =
  | { type: 'message'; at: string; message: NoteMessage }
  | { type: 'comment'; at: string; comment: NoteComment }
  | { type: 'receipt'; at: string; receipt: NoteReceipt }
  | { type: 'transition'; at: string; from: TaskStatus; to: TaskStatus }
  | { type: 'run'; at: string; segment: RunSegment };
export type GoalConditionState = 'pending' | 'dispatched' | 'doing' | 'unknown' | 'blocked' | 'submitted' | 'rework' | 'verified' | 'delivered';
export interface GoalConditionVerification { by: string; at: string; pass: boolean; note?: string; round: number }
export interface GoalCondition { id: string; text: string; task_id?: string; evidence?: readonly string[]; verifications: readonly GoalConditionVerification[]; delivered_at?: string; created_at: string; updated_at: string }
export interface GoalBoardSummary {
  goal_id: string; scope: string;
  conditions: { total: number; by_state: Record<GoalConditionState, number>; items: Array<{ id: string; text: string; state: GoalConditionState; task_id?: string; assignee?: string; last_receipt_at?: string; blocker?: { reason?: string; waiting_on?: string; next?: string } }> };
  tasks: { total: number; by_status: Record<TaskStatus, number>; canceled: number; unscheduled: number };
}
export type ExecutionState = 'running' | 'awaiting_review' | 'rework' | 'blocked' | 'unknown' | 'completed' | 'canceled' | 'queued';
export type ExecutionRole = 'business' | 'coordination' | 'unclassified';
export interface ExecutionRoleFact { kind: ExecutionRole; origin: 'explicit_task' | 'automatic_session' | 'user' | 'delegation' | 'unclassified' }
export interface RunSegment {
  role?: ExecutionRole;
  role_origin?: ExecutionRoleFact['origin'];
  task_round?: number;
  current?: boolean;
  execution_state?: ExecutionState;
  task_id: string;
  session_id?: string;
  agent?: string;
  source_round?: string;
  source: string;
  status: 'dispatched' | 'running' | 'paused' | 'done' | 'failed' | 'unknown';
  /** 原assigned时刻,不是实际开工。 */
  started_at: string;
  /** 原管线收场时刻(含超时/人工收卡),不是实际完成。 */
  finished_at?: string;
  /** 本机首次核到执行源开工的观察时刻(jobLog.started),非模型内部精确起点;无证据则缺席。 */
  execution_started_observed_at?: string;
  /** 本机核到结果交回的观察时刻(jobLog.replied),人工收卡/超时/失联不补值。 */
  execution_finished_observed_at?: string;
  pause_reason?: string;
  outcome?: string;
}
export interface CapacityItem { id: string; online: boolean; active_jobs: number; running_jobs: number; limit: number | 'unknown' }
export interface LanIdentity { member_id: string; name: string; avatar?: string; version: number; updated_at: string }
/** reachable 是最近两分钟内的探测结果;过期缺席表示未知,last_seen 保留历史。 */
export interface LanMember { member_id: string; name: string; host: string; port: number; last_seen?: string; reachable?: boolean }
export type LanChannelCategory = 'news' | 'daily' | 'weekly'
export interface LanChannelTopic { id: string, title: string }
export interface LanChannelRef { kind: 'task' | 'url', id: string, title: string, url?: string }
export interface LanChannelSource {
  kind: 'feed' | 'project-report'
  id: string
  recorded_at: string
  scope: 'project-feed' | 'local-project-records'
  url?: string
  publisher?: string
  published_at?: string
  period?: { from: string, to: string }
}
export interface LanChannelSourcePolicy {
  project_id: string
  enabled: boolean
  recipients: readonly string[]
  categories: readonly LanChannelCategory[]
  version: number
  updated_at: string
}
export interface LanChannelSourceScope {
  news: 'unwired' | 'empty' | 'ready' | 'unknown'
  reports: 'unknown' | 'ready'
  peer_sources: 'paired-origin-claims'
  publication_enabled: boolean
  notes?: readonly string[]
}

export interface LanChannelMessage {
  id: string
  client_msg_id?: string
  project_id: string
  author: { member_id: string, name: string }
  text: string
  kind: 'message' | 'report'
  reply_to?: string
  at: string
  deliveries?: readonly MessageDelivery[]
  /** 成组正式来源字段,仅来源发布器或已配对对端提供;旧消息缺席即未知,不从正文猜测。 */
  category?: LanChannelCategory
  topic?: LanChannelTopic
  source?: LanChannelSource
  refs?: readonly LanChannelRef[]
}

export interface LanHello { member_id: string; name: string }
export type TaskRelationKind = 'derived' | 'depends_on' | 'handoff' | 'rejected_back' | 'reference';
export interface TaskRelation { id: string; from_id: string; to_id: string; kind: TaskRelationKind; note?: string; round?: number; created_at: string; stale?: boolean }
export type GoalStatus = 'open' | 'reached' | 'dropped';
export type MemberAssignee = `member:${string}`;
export type ScheduleRiskLevel = 'ample' | 'tight' | 'late' | 'unknown';
export interface ScheduleRisk { level: ScheduleRiskLevel; eta?: string; reason: string; window_days: number; done_recent?: number; remaining?: number }
export interface CollabGoal {
  id: string; title: string; why?: string; owner: 'me' | MemberAssignee; status: GoalStatus; due?: string; project_id?: string; version?: string; migrated_from?: string; conditions?: readonly GoalCondition[]; created_at: string; updated_at: string; risk?: ScheduleRisk;
}
export interface CollabSprint { id: string; title: string; start?: string; end?: string; goal_ids: readonly string[]; created_at: string; updated_at: string }
export interface AgentCard {
  id: string; name: string; owner: 'me' | MemberAssignee; hand: string; runtime?: { family: string; bin?: string }; project?: { repo: string }; model?: { name?: string; effort?: 'low' | 'medium' | 'high' }; instructions?: string; budget?: { minutes?: number }; good_at?: string; skills?: readonly string[]; mcp?: readonly string[]; shared: { to: 'workspace' | 'none' | 'members'; members?: readonly string[]; repos?: readonly string[]; budget_per_day?: number }; created_at: string; updated_at: string;
}

/** 卡面那一格(与工作台 `standingBadgeText` 同句):只给要留意的那几种,等她的只在停太久时。 */
export function standingBadgeText(standing: Pick<ItemStandingView, 'case' | 'idle_days' | 'stalled'> | undefined): string | undefined {
  if (standing === undefined) return undefined;
  const problem = standing.case === 'result_unwritten' || standing.case === 'channel_failed' || standing.case === 'likely_moot'
    || (standing.case === 'waiting_her' && standing.stalled === true);
  if (!problem) return undefined;
  const days = standing.idle_days === undefined || standing.idle_days < 1 ? '' : ` · 停了 ${standing.idle_days} 天`;
  return `${ITEM_STANDING_CASE_TITLES[standing.case]}${days}`;
}

/** 找不到证据时那一句(与工作台 `PROGRESS_NONE_LINE` 同词)。 */
export const PROGRESS_NONE_LINE = '还没看到进展,要你说一句';

/** 没看到进展时补的「我在哪儿找过」(与工作台 `progressNoneHint` 逐字同一条)。 */
export function progressNoneHint(progress: Pick<TaskProgressView, 'read_sessions'> | undefined): string {
  return progress?.read_sessions === true
    ? '项目文件夹、交出去的活、你跟各家 AI 的对话里,都没说到这件事做到哪了。'
    : '项目文件夹和交出去的活里,都没说到这件事做到哪了(你跟各家 AI 的对话我没看)。';
}

/**
 * 负责人怎么称呼。**手机这一侧只剩这一张退路表**(2026-10-03,卡「两条接缝」;决策记录 10-03 早 ⑦)。
 *
 * 家名候选池的**主人是工作台插件的家族目录**,手机读到的那一份是 `/state.agent_registry`
 * ({@link registryAgentName})—— 电脑上接上一家,手机上就叫得出它,不用改一行手机代码。
 * 这张表只在**登记表里没有那一家**时顶一下(老工作台、还没扫到),外加人那三档与事务官自己
 * (它们压根不在登记表里)。与插件 `protocol.ts` 的 `ASSIGNEE_NAMES` 由
 * `tests/family-titles-sync.test.ts` 直接读插件源码钉着(⊆)。
 *
 * 从前手机里还有第二张(`chat/chatModel.ts` 的 `DISPATCH_WHO`,审计第二表第 8 条那第三个池)——
 * 它已经漂了:`doubao` 在插件那头是「豆包办公」,在手机两张表里都写着「豆包」,
 * 于是同一件事手机上说「豆包回来了」、电脑上说「豆包办公回来了」。那一张删了,这一张跟主人对齐。
 */
export const ASSIGNEE_NAMES: Readonly<Record<string, string>> = {
  dsh: '事务官', claude: 'Claude', codex: 'Codex', kimi: 'Kimi', gpt: 'GPT', doubao: '豆包办公', muse: 'Muse', manus: 'Manus',
  me: '你', colleague: '同事', other: '别人',
};

/**
 * ★ **「这条会话」这件事的键,手机这一侧只有这一个定法**(2026-10-03,卡「两条接缝」;
 * 决策记录 10-03 早 ⑦ 第二条)。与工作台 `server/jobKey.ts` 的 `SESSION_JOB_PREFIX` /
 * `SESSION_JOB_SEP` / `sessionJobId` / `sessionOfJob` 是同一个定法的两份实现
 * (顶层子目录互不 import),由 `tests/session-job-key-sync.test.ts` 直接读插件源码钉着。
 *
 * 从前 `/state.waiting` 那一行的键是 `session:<家>:<会话 id>` —— **分隔符是冒号**,
 * 而窗口型那几条会话 id 自己带冒号(`window:825f1900`),拆的时候得「只切第一刀」;
 * 同一个前缀在座机台账里又是第三种意思(`session:<会话 id>`,没有家名)。
 * 现在三处同一种:`session:<家>/<会话 id>`(家名里没有 `/`)。
 */
export const SESSION_JOB_PREFIX = 'session:';
export const SESSION_JOB_SEP = '/';

/**
 * 10-03 之前那个分隔符(冒号)。**只用来认键,不用来拼键** —— 手机与插件分开发版,
 * 新手机装在老工作台旁边时 `/state.waiting` 下发的还是 `session:<家>:<会话 id>`,
 * 认不出就是「首页列得出、点进去只剩一行字」(审计第四节第 2 条)。
 */
export const LEGACY_SESSION_JOB_SEP = ':';

export function sessionJobId(agent: string, sessionId: string): string {
  return `${SESSION_JOB_PREFIX}${agent}${SESSION_JOB_SEP}${sessionId}`;
}

/**
 * 下发的这个键指的是不是「这一家的这条会话」。**新拼法与 10-03 之前的老拼法都认**;
 * 两头都是拿家名与会话 id 原样比,所以窗口型那几条自带冒号的会话 id 也不会拆错。
 */
export function sessionJobMatches(key: string, agent: string, sessionId: string): boolean {
  return key === sessionJobId(agent, sessionId)
    || key === `${SESSION_JOB_PREFIX}${agent}${LEGACY_SESSION_JOB_SEP}${sessionId}`;
}

/** 这个键是不是会话键;是就拆出家与会话 id(不是就 undefined,**不猜**)。 */
export function sessionOfJob(job: string): { agent: string; sessionId: string } | undefined {
  if (!job.startsWith(SESSION_JOB_PREFIX)) return undefined;
  const rest = job.slice(SESSION_JOB_PREFIX.length);
  const cut = rest.indexOf(SESSION_JOB_SEP);
  if (cut <= 0 || cut === rest.length - 1) return undefined;
  return { agent: rest.slice(0, cut), sessionId: rest.slice(cut + 1) };
}

/**
 * 登记表里那一家的名字 —— **主人下发的那一份**(`/state.agent_registry`,卡 Q)。
 * 表里没有(老工作台 / 还没扫到 / 人那三档)就 `undefined`,**不猜**。
 */
export function registryAgentName(
  family: string,
  state?: Pick<WorkbenchState, 'agent_registry'>,
): string | undefined {
  const name = state?.agent_registry?.entries.find((entry) => entry.id === family)?.name;
  return name === undefined || name.trim() === '' ? undefined : name;
}

/**
 * 派给那一家时念给她听的名字:**先问主人**(登记表),登记表里没有才查 {@link ASSIGNEE_NAMES},
 * 都没有**原样用家名**(运行时发现的那一家家名就是包标识 —— 原样显示也比猜一个名字好)。
 */
export function dispatchWho(family: string, state?: Pick<WorkbenchState, 'agent_registry'>): string {
  return registryAgentName(family, state) ?? ASSIGNEE_NAMES[family] ?? family;
}

/**
 * 一张卡算不算一件「事项」(与工作台 `isTrackedItem` 逐字同一条规矩):他交给事务官的(`mine`)一个不少;
 * 选题池的卡只按 mine 算;其余写了负责人的就是。**事项与看板卡是同一份数据的两种排法**。
 */
export function isTrackedItem(task: Pick<TaskView, 'direction' | 'assignee' | 'kind'>): boolean {
  if (task.direction === 'mine') return true;
  if (task.kind === 'topic') return false;
  return task.assignee !== undefined;
}

/**
 * 永远不算一家能派活的(与工作台 `NEVER_DISPATCH_FAMILIES` 同一串):微信、企业微信这类人跟人聊天的。
 *
 * ★ 2026-09-25(卡 Z):原来这里是写死的 `DISPATCH_FAMILIES`(七家),**新接上一家手机上那颗
 * 「派给 X」就不出现**。现在跟工作台一样是开集 —— 有哪几家由 Agent 登记表说,这里只挡住明显不是一家的值。
 */
export const NEVER_DISPATCH_FAMILIES: readonly string[] = ['wechat', 'wecom', 'com.tencent.xinWeChat', 'com.tencent.WeWorkMac'];

/** 人能代表自己的那三档(与工作台 `PERSON_ASSIGNEES` 同一串;driveLabel / isDispatchFamily 共用)。 */
export const PERSON_ASSIGNEES = ['me', 'colleague', 'other'] as const;
export type PersonAssignee = typeof PERSON_ASSIGNEES[number];
export function isPersonAssignee(value: unknown): value is PersonAssignee {
  return typeof value === 'string' && (PERSON_ASSIGNEES as readonly string[]).includes(value);
}

/** 包标识的样子(与工作台 `BUNDLE_ID` 同一个形):运行时新发现的一家、没进 ASSIGNEE_NAMES 的,照这个认。 */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/;

/**
 * 这个值看上去是一家能派活的(与工作台 `isAgentDispatchFamily` 同一条)。
 *
 * ★ 2026-10-22(卡「契约对照测试补齐」)收紧:**登记过的一家(ASSIGNEE_NAMES 里有)或带点的
 * 包标识形状才算**,不再把随便一个字符串当一家 —— 原来那句「开集」注释是错的(工作台那边
 * 自 2026-09-25 起就是「登记表里有或像包标识才算」,见 `tests/drive-label-sync.test.ts`)。
 */
export function isDispatchFamily(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  if (value === 'dsh' || isPersonAssignee(value) || NEVER_DISPATCH_FAMILIES.includes(value)) return false;
  // es2020(WebView 档 lib)没有 Object.hasOwn —— 用等价的 hasOwnProperty(运行时行为一字不差)。
  return Object.prototype.hasOwnProperty.call(ASSIGNEE_NAMES, value) || BUNDLE_ID.test(value);
}

/** 短时刻(与工作台 `shortMoment` 逐字同一条):ISO →「9月24日 20:17」;只有日子的 →「9月25日」;认不出空串。 */
export function shortMoment(iso: string | undefined): string {
  if (iso === undefined) return '';
  const day = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
  if (day !== null) return `${Number(day[1])}月${Number(day[2])}日`;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getMonth() + 1}月${at.getDate()}日 ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 界面上现画的时刻(与工作台 `friendlyWhen` 逐字同一条):「今天 20:17」「昨天 20:17」「9月22日 20:17」。 */
export function friendlyWhen(iso: string | undefined, now: string | number | undefined): string {
  if (iso === undefined) return '';
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const at = dateOnly === null ? new Date(iso) : new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  if (Number.isNaN(at.getTime())) return '';
  const ref = now === undefined ? new Date() : new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const clock = dateOnly === null ? ` ${pad(at.getHours())}:${pad(at.getMinutes())}` : '';
  if (Number.isNaN(ref.getTime())) return `${at.getMonth() + 1}月${at.getDate()}日${clock}`;
  const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(ref) - dayStart(at)) / 86_400_000);
  if (days === 0) return `今天${clock}`;
  if (days === 1) return `昨天${clock}`;
  return `${at.getFullYear() === ref.getFullYear() ? '' : `${at.getFullYear()}年`}${at.getMonth() + 1}月${at.getDate()}日${clock}`;
}

/**
 * 真派活之前那一问的字(与工作台 `dispatchAskText` 逐字同一条;统筹:「真派活前要有确认,手机和电脑同一套」):
 * 「这张派给 Codex 开工?现在:<按证据的一句>(<出处> <时刻>)」。证据和卡上对不上时接在后面。
 */
export function dispatchAskText(assignee: string | undefined, progress: TaskProgressView | undefined, extra?: string, now?: string | number): string {
  // 名片负责人没有名片表时至少剥掉 `agent:` 前缀(工作台那份带了表就念名片名;手机这条路只到「派给 X」能画的卡)。
  const named = assignee !== undefined && assignee.startsWith('agent:') ? assignee.slice('agent:'.length) : assignee;
  const who = assignee === 'dsh' || assignee === undefined ? '交给事务官' : `派给 ${ASSIGNEE_NAMES[assignee] ?? named} `;
  const basis = progress?.basis[0];
  const when = now === undefined ? shortMoment(basis?.at) : friendlyWhen(basis?.at, now);
  const where = progress === undefined || progress.state === 'none'
    ? '还没看到这件事的进展'
    : `${progress.line}${basis === undefined ? '' : `(${basis.source}${when === '' ? '' : ` · ${when}`})`}`;
  const mismatch = progress?.state === 'mismatch' && progress.mismatch !== undefined ? `;和卡上对不上:${progress.mismatch}` : '';
  return `这张${who}开工?现在:${where}${mismatch}${extra === undefined || extra === '' ? '' : `;${extra}`}`;
}

/** 那颗「派给 X」/「交给事务官」给什么字(与工作台 `driveLabel` 同一条):待办、某家 AI 或事务官、不是选题 / 需求卡、没在跑。
 * 2026-10-22 起人那三档走 {@link isPersonAssignee}(与工作台同一条 helper);家名走收紧后的
 * {@link isDispatchFamily};末了 `?? who` 是手机这边的安全网(包标识家名不在 ASSIGNEE_NAMES 时
 * 原样显示,不念「undefined」—— 对照见 `tests/drive-label-sync.test.ts`)。 */
export function driveLabel(task: Pick<TaskView, 'status' | 'assignee' | 'kind' | 'dispatch'>): string | undefined {
  if (task.status !== 'todo' || task.kind === 'topic' || task.kind === 'feature') return undefined;
  if (task.dispatch?.status === 'running') return undefined;
  const who = task.assignee;
  if (who === undefined || isPersonAssignee(who)) return undefined;
  if (who === 'dsh') return '交给事务官';
  if (!isDispatchFamily(who)) return undefined;
  return `派给 ${ASSIGNEE_NAMES[who] ?? who}`;
}

/** 证据里冒出来的下一步(进度核对建的「待排」卡):在「等你确认」里问「要加上吗」,不算在办。 */
export function isEvidenceProposal(task: Pick<TaskView, 'origin' | 'status'>): boolean {
  return task.origin === 'evidence' && task.status === 'backlog';
}

export interface TaskLinkView {
  agent: AgentId;
  session_id: string;
  note?: string;
}

/**
 * 事项是谁写下的(2026-09-25,与 workbench-plugin/src/protocol.ts 的 `TaskOrigin` 逐字相同):
 * 他亲口交代 / 通话纪要 / 引导排的 / 会议来的。缺席 = 老卡,按 {@link taskOriginOf} 从形状认。
 */
export type TaskOrigin = 'user' | 'call' | 'onboarding' | 'meeting' | 'evidence';

/** 通话纪要那一通(与工作台 `TaskCallMeta` 同形)。 */
export interface TaskCallMeta {
  kind: 'onboarding' | 'call';
  summary: string;
  duration_seconds?: number;
}

/**
 * ★ **一通电话是一条记录,不是事项**(2026-10-22,决策记录同日「通电话是记录不是事项」)。
 * 与工作台 `workbench-plugin/src/protocol.ts` 的 `CallRecordView` / `CallsView` 同形(用例读那边源文件比对字段名)。
 * 工作台从这一天起不再给电话建纪要卡,手机的「通话记录」与「最近一次通话」读 `/state.calls`。
 */
export interface CallRecordLineView {
  who: 'me' | 'butler';
  text: string;
}

export type CallRecordItemDid = 'created' | 'moved' | 'said';

export interface CallRecordItemLinkView {
  task_id: string;
  did: CallRecordItemDid;
  title?: string;
  to?: TaskStatus;
}

export interface CallRecordView {
  id: string;
  kind: 'onboarding' | 'call';
  at: string;
  duration_seconds?: number;
  summary: string;
  lines: number;
  transcript: readonly CallRecordLineView[];
  items: readonly CallRecordItemLinkView[];
  maybe_todo?: readonly string[];
  file?: string;
}

export interface CallsView {
  recent: readonly CallRecordView[];
  dir?: string;
}

/** `POST /butler/call/record` 请求体的那几格。与工作台 `CALL_RECORD_BODY_FIELDS` 同名(用例读那边源文件比对)。 */
export const CALL_RECORD_BODY_FIELDS = ['call_id', 'durationSeconds', 'transcript', 'kind', 'todos'] as const;

/**
 * **老卡**通话纪要的标题开头(没有 origin 时靠它认)。与工作台 `CALL_RECORD_TITLE_PREFIX` 同词。
 *
 * **2026-10-13 起工作台落的新卡标题写的是「聊了什么」**(「电话里:把待办改成按日期汇总」),
 * 新卡一律带 `origin:'call'` —— 所以 `taskOriginOf` 与 `isCallRecord` 照旧认得出,这一格只管老卡。
 */
export const CALL_RECORD_TITLE_PREFIX = '和事务官通了';
/** 引导里建的事项 desc 的开头。与工作台 `ONBOARDING_TASK_DESC_PREFIX` 同词。 */
export const ONBOARDING_TASK_DESC_PREFIX = '引导';

/** 一张卡是谁写下的。有 origin 就用它;老卡只认三种写死的形状(与工作台 `taskOriginOf` 同一份规矩)。 */
export function taskOriginOf(task: Pick<TaskView, 'origin' | 'title' | 'desc' | 'source'>): TaskOrigin {
  if (task.origin !== undefined) return task.origin;
  if (task.title.startsWith(CALL_RECORD_TITLE_PREFIX)) return 'call';
  if (task.desc !== undefined && task.desc.startsWith(ONBOARDING_TASK_DESC_PREFIX)) return 'onboarding';
  if (task.source?.kind === 'meeting') return 'meeting';
  return 'user';
}

export interface ButlerInboxItem {
  id: string;
  /**
   * 电脑那边还有别的几档(手机只按通用的样子画);`agent` 是登记表那一档(卡 Q)。
   * `quota` 是剩余额度告警(2026-10-23):只是工作台消息,手机上不摆(见 inboxTabs 的 NOT_ITEMS)。
   * `spend` 是额度活用建议(2026-10-28,卡 t-f68365f6):重置前 6 小时还剩一半以上 → 列板上待排的研发活,
   * 只提议不自动派;同一纪律,手机上不摆。
   */
  kind: 'confirm' | 'session' | 'sentinel' | 'risk' | 'agent' | 'quota' | 'spend' | (string & {});
  title: string;
  note?: string;
  at?: string;
  status?: TaskStatus;
  wait_reason?: WaitReason;
  task_id?: string;
  conversation?: TaskConversation;
  /**
   * `confirm` 那一档专有(2026-10-26 抄进这份子集,卡「事务官页接管队列」):事务官标好的四类拍板请求。
   * 手机收件箱据此分「等你拍板」(详情里给「通过」)与「事务官核验中」(只看不批)。
   */
  owner_ask?: OwnerAsk;
  /**
   * Agent 登记表那一档(卡 Q):哪一家;「新接上一家」那一句(`notice_id`)。
   * 拿不准的「XX 像是个 Agent,要接上吗?」不在收件箱里,在 `questions` 里(「等你确认」那一张提问卡答)。
   */
  agent?: { id: string; notice_id?: string };
  /** 「新学到一条:…,正在试用」那一档(`kind: 'habit'`,2026-10-10):那条习惯的 id(撤掉 / 知道了拿它回去)。 */
  habit?: { id: string };
}

/**
 * 「等你确认」里的一条会话 —— **两路来源同一种形状**(2026-10-03,审计第四节第 1、2 条)。
 * 一路是会话文件那几家({@link WorkbenchState.sessions}),一路是登记表里读窗口读出来的
 * ({@link AgentSessionView});后者的家 id 是 App 的包标识,**不在 {@link AgentId} 里**,
 * 所以 `agent` 这一格放宽成字符串。
 */
export type AskSessionView = Omit<SessionView, 'agent'> & {
  /** 登记表里的 id(有专门读法的那几家是 claude / codex / kimi / dsh,别的是 App 的包标识)。 */
  agent: string;
};

/**
 * Agent 登记表(2026-09-25,卡 Q「Agent 自动发现与统一接入」)。与电脑那边 workbench-plugin/src/protocol.ts
 * `AgentRegistryView` 同形,手机只用到这几格:**「有哪几家」只认这一份**,手机里不再有名字表。
 */
export type AgentSessionView = AskSessionView & {
  /** `records`(2026-10-08):读它自己本机记录长出来的(千问办公)。只有 `sessions` 是 `state.sessions` 的副本。 */
  via: 'sessions' | 'window' | 'records';
};

export interface AgentEntryView {
  id: string;
  name: string;
  self?: boolean;
  /** 这一家的颜色(卡 Q:从它 App 图标的主色来,电脑上会话卡的小头像、顶栏小灯同一个色)。老工作台没有这一格。 */
  color?: string;
  /**
   * 这一家的 **logo 取到了没有**(2026-09-26,卡 LG 加的那一格;卡 LG3 手机上也用它)。
   * 真 → 按 `GET /agents/icon/<这一条的 id>` 当一张 PNG 取(图片本身不在快照里:一张十几 KB,
   * 每秒一拍的快照塞不下);假 / 缺席(老工作台、没装那个 App、壳是旧版)→ **退回色点**(`color`)。
   */
  icon?: boolean;
  bundle_id?: string;
  app_running?: boolean;
  status: 'running' | 'waiting' | 'idle' | 'unknown';
  title?: string;
  latest?: string;
  read_at?: string;
  bubble?: { kind: 'started' | 'replied'; text: string; at: string };
  gaps: Partial<Record<'status' | 'title' | 'latest' | 'bubble', string>>;
  note?: string;
  sessions: readonly AgentSessionView[];
  counts: { running: number; waiting: number; unread: number };
}

export interface AgentRegistryView {
  entries: readonly AgentEntryView[];
  /** 登记表自己的账:正在问他的那几家。**那一问本身在 `questions` 里**(数进 `waiting`),手机不另摆。 */
  asking: readonly { id: string; name: string; question: string; basis: string; at: string }[];
  notices: readonly { id: string; text: string; at: string }[];
  paused?: string;
  note?: string;
  /**
   * 读不了别家窗口、要他动一下手的那一句(卡 Q):`accessibility` = 电脑上的工作台还没开「辅助功能」权限,
   * `old_shell` = 电脑上的工作台 App 是旧版。手机上只能说一声,去开要在电脑上点。
   */
  blocked?: { kind: 'accessibility' | 'old_shell'; text: string; apps?: readonly string[] };
}

/**
 * **此刻能不能出声**(2026-09-26,卡 QH)。工作台服务端算好的**一处判断**(`server/quietHours.ts`),
 * 手机这边只读结论,**不自己算时段** —— 09-26 00:19 冷启动半夜朗读就是因为时段判断只长在座机那条路里。
 */
export interface QuietView {
  /** 此刻在免打扰时段里。 */
  active: boolean;
  /** 时段两头(`HH:MM`,可跨零点)。时段写坏了读不出来时两格一起缺席。 */
  from?: string;
  to?: string;
  /** 到几点恢复出声。只在 `active` 时有。 */
  until?: string;
  /** 为什么不出声,一句人话。只在 `active` 时有。 */
  reason?: string;
}

export interface WorkbenchState {
  now: string;
  stale: boolean;
  /** Agent 登记表(卡 Q):正在办、各家正在办、各家叫什么都读它。老工作台没有这一格。 */
  agent_registry?: AgentRegistryView;
  /** 「先问我」那一档在等批的操作(2026-09-24 统一输入框)。手机首页「等你确认」里能点。 */
  approvals?: readonly PendingApprovalView[];
  /** 各家能做什么(2026-09-25,卡 O):六家各三格。手机设置里只读地看一眼;修要在电脑前。 */
  agent_caps?: AgentCapsView;
  /** 能接活的每一家的额度(2026-09-25,卡 O):三格之一。手机设置「各家能做什么」里每家跟一句。 */
  agent_quota?: readonly AgentQuotaView[];
  /**
   * 事务官在 DSH 会话里问他的话(2026-09-25,卡 M)。手机首页「等你确认」里一行,点开是同样的问题与选项;
   * 电脑上答了这里跟着消失。与 workbench-plugin/src/protocol.ts 的 `PendingQuestionView` 同形。
   */
  questions?: readonly PendingQuestionView[];
  /**
   * 「等你」的那一堆(2026-09-25,卡 M 追加;维护者硬规矩「同一件事的数字各处一致」):工作台服务端算好的那一份,
   * 与电脑球下「等你 n」「还有 N 件要你看」、「事务官」标签上的数**同一堆、同一个数**。手机「等你确认」那一格只读它,不自己数。
   * 缺席 = 老工作台(那时按老办法凑,见 asks/asksModel.ts 的 waitingPile)。与 workbench-plugin/src/protocol.ts 的 `WaitingView` 同形。
   */
  waiting?: WaitingView;
  /**
   * 「此刻有几件在跑」(2026-09-25,卡 V,同上那条硬规矩):工作台算好的那一份。
   * 首页「正在办」那块卡的数读它,不自己数;缺席 = 老工作台(那时退回自己数)。
   */
  running?: RunningView;
  /**
   * 粒子球此刻的状态(2026-10-04,卡「球的颜色一处算」):工作台算好的那一份,
   * **与电脑首页那颗球同一格、同一个颜色**。手机只显示它,不自己推算;缺席 = 老工作台(退回本地推算)。
   */
  orb?: OrbView;
  /**
   * ★ **「问一句」的回答**(2026-10-04,卡 `claude/answer-comes-to-her`)。球下那一行字幕摆它,
   * App 在后台时按它推一条通知(正文就是答案)。**一处算、两端只显示**(工作台 `src/answerCell.ts`)。
   * 缺席 = 老工作台(字幕照旧只摆事项那一条)。
   */
  answers?: AnswersView;
  /**
   * ★ **刚办完、她还没看过的那几件**(同上第 2 条)。首页在两张卡上面挂一条,
   * 「看过」/「划掉」都走 `POST /task/seen-result`。缺席 = 老工作台(办完的事直接进「办完」)。
   */
  fresh_results?: FreshResultsView;
  /**
   * **此刻能不能出声**(2026-09-26,卡 QH)。与工作台 `protocol.ts` 的 `QuietView` 同形。
   * 免打扰时段里**一切不是他刚按下的声音都不出**:朗读、提示音、铃。界面照常 —— 字幕、气泡都出,
   * 只是不念。他自己点「重听 / 播放」不受它管(那是他要的)。
   * 老工作台没有这一格 —— **缺席按「能出声」算**,不替他静音。
   */
  quiet?: QuietView;
  /** 输入框胶囊上此刻写什么(粘性的档与模型,电脑与手机共用一份)。 */
  composer?: ComposerCurrentView;
  sessions: readonly SessionView[];
  tasks?: {
    tasks: readonly TaskView[];
    goals?: readonly CollabGoal[];
    goal_sprints?: readonly CollabSprint[];
    agent_cards?: readonly AgentCard[];
    relay_tick?: number;
  };
  butler_inbox?: { items: readonly ButlerInboxItem[] };
  projects?: { projects?: readonly { id: string; name: string }[] };
  /** 外观版本(2026-09-16):Mac 那份 appearance.json 的 version;变了手机重新拉 GET /butler/appearance。 */
  appearance_version?: number;
  /** 电脑认请求号(2026-10-12,卡「手机交代只执行一次」):有它待发箱才自动补发;缺席 = 老工作台,只等她点「重发」。 */
  client_keys?: true;
  /** 引导进度(2026-09-15):没接引导服务时缺省。 */
  /**
   * `done_at`(2026-09-25 起的工作台才有):引导走完的那一刻(老存档没记,工作台拿存档最后一次改动的时刻顶上)。
   * 首页「最近一次通话」拿它补那一通 —— 2026-09-25 之前引导那一通挂断时不写纪要卡。
   */
  onboarding?: { stage: string; done: boolean; askedAt?: string; done_at?: string };
  /**
   * 引导落地那张单子(2026-09-24 晚,卡 feat/onboarding-materialize):「我照你说的摆好了」。
   * 形状与电脑那边 workbench-plugin/src/protocol.ts `MaterializeStateView` 同一份;没排过就缺席。
   */
  materialize?: MaterializeStateView;
  /**
   * 这台工作台叫什么(2026-09-17 登录:顶上要显示「已登录:工作台 · xxx」)。
   * **Mac 侧现在还不发这一段**(请求写在 docs/交接-0917-手机登录流程.md 第四节);
   * 没有就退回配对时 mDNS 记下的名字,再没有就显示地址。
   */
  workbench?: { name?: string };
  /**
   * 电脑那边查到有新的手机包了(2026-09-18 热更新)。手机这边**只做提示与一条链接** ——
   * 下载与安装都走系统那一套(APK 安装是 Android 的事,App 替不了)。
   * 电脑没查过、或者这一版没带手机包时整格缺席(不编一个假的)。
   */
  update_available_apk?: { version: string; url: string; size: number };
  /**
   * 云上那份手机包在哪(2026-09-18「包一律放阿里云服务器」)。跟上一格的区别是**不比版本**:
   * 上一格说「有新的」,这一格说「那个包在哪」—— 设置里「重新下载手机包」用它
   * (装坏了、换了台手机,跟有没有新版没关系)。地址是公网的,出了家里的 Wi-Fi 也下得动。
   * 电脑没查过清单、或者清单里没带手机包时整格缺席。
   */
  phone_apk?: { version: string; url: string; size: number; sha256?: string };
  /**
   * 会议(2026-10-10 起手机读其中的 `upcoming`:会前登记、还没开录的那几场,带画像与预案卡)。
   * 与 workbench-plugin/src/protocol.ts 的 `MeetingsView` 同形;手机只用到下面这几样。老工作台没有这一格。
   */
  meetings?: { upcoming?: readonly MeetingPlanView[]; recent?: readonly MeetingRecentView[] };
  /**
   * 通话记录(2026-10-22:通电话是记录不是事项)。与工作台 `CallsView` 同形。
   * 老工作台没有这一格 → 「通话记录」与「最近一次通话」退回读老纪要卡。
   */
  calls?: CallsView;
  /**
   * 手机才显示的那几格从哪一版手机包起才有(2026-10-09,电脑那边 `src/phoneCells.ts`)。
   * 拿自己装的版本比:落后、而且 `phone_apk` 更新时,首页提示更新手机端(update/PhoneBehindBanner.tsx)。
   * 老工作台没有这一格 → 不提示。
   */
  phone_cells?: readonly PhoneCellView[];
  /**
   * 今天的待办(2026-10-12):看板事项按 `due` 切出来的今天那一刀,电脑切好发来(workbench-plugin/src/todayTodos.ts),
   * 与自媒体模板里那一格同一份。只在自媒体模板出现;老工作台 / 做产品模板缺席 → 事项页不摆那一块。
   */
  today_todos?: TodayTodosView;
}

/** 今天的待办里的一件(与电脑那边 `TodayTodoItem` 同形)。 */
export interface TodayTodoItem {
  id: string;
  title: string;
  due: string;
  done: boolean;
  overdue: boolean;
}

/** 「今天的待办」两种显示(与电脑那边 `TODAY_VIEWS` 同一份,2026-10-12 周三演示):按日期汇总 / 不汇总。 */
export type TodayViewStyle = 'by_date' | 'flat';
/** 换版本时那一块盖着遮罩多久(毫秒;与电脑那边 `TODAY_SWITCH_MS` 同一个数,tests/todayTodosView 对照着)。 */
export const TODAY_SWITCH_MS = 2400;
export const TODAY_SWITCH_TEXT = '正在优化…';

/** 按日期汇总那一版的一组(与电脑那边 `TodayTodoGroup` 同形)。 */
export interface TodayTodoGroup {
  key: 'today' | 'tomorrow' | 'later';
  label: string;
  items: readonly TodayTodoItem[];
}

/** `/state.today_todos`(与电脑那边 `TodayTodosView` 同形;`date` 按电脑本机那一天)。 */
export interface TodayTodosView {
  date: string;
  tomorrow: string;
  items: readonly TodayTodoItem[];
  /** 此刻用哪一版;老工作台缺席 = 不汇总。 */
  style?: TodayViewStyle;
  /** 按日期汇总那一版的三组(电脑切好的)。 */
  groups?: readonly TodayTodoGroup[];
}

/** 一格手机才显示的东西,从哪一版手机包起才有(与电脑那边 `PhoneCellView` 同形)。 */
export interface PhoneCellView {
  cell: string;
  title: string;
  since: string;
}

/** 负责人(与电脑那边 `MaterializeOwner` 同一串)。 */
export type MaterializeOwner = 'codex' | 'claude' | 'kimi' | 'butler' | 'me' | 'colleague' | 'other';
export const MATERIALIZE_OWNER_LABELS: Record<MaterializeOwner, string> = {
  codex: 'Codex', claude: 'Claude', kimi: 'Kimi', butler: '事务官', me: '你', colleague: '同事', other: '别人',
};

export interface MaterializeRowView {
  key: string;
  kind: string;
  group: string;
  title: string;
  detail?: string;
  quote?: string;
  checked: boolean;
  done?: boolean;
  placeholder?: string;
  owner?: MaterializeOwner;
  editable?: boolean;
  /** 免打扰那一行的起止:「改一下」时能改到几点(2026-09-25)。 */
  time?: { from: string; to: string };
}

export interface MaterializeStateView {
  id: string;
  status: 'pending' | 'applying' | 'applied';
  line: string;
  source: string;
  counts: { projects: number; tasks: number; cancel: number };
  groups: readonly { id: string; title: string }[];
  rows: readonly MaterializeRowView[];
  created_at: string;
  applied_at?: string;
  result?: {
    ok: boolean;
    line: string;
    rows: readonly { key: string; title: string; ok: boolean; note?: string }[];
    dispatch?: { task_id: string; ok: boolean; session_id?: string; note?: string };
    unmatched?: readonly string[];
  };
}

export function emptyState(): WorkbenchState {
  return { now: '', stale: true, sessions: [] };
}

/**
 * 这份状态是**工作台真发来的那一份**吗(2026-09-26,卡 QH;统筹拍板「冷启动不念旧回答」)。
 *
 * 分的是 {@link emptyState}(还没连上、界面刚挂出来时手上那份占位)与第一份真快照。
 * `now` 是工作台每一拍都填的时刻(`new Date().toISOString()`),占位那份是空字符串 ——
 * **只有这一格分得开两者**:`connected` 不行(电脑掉线之后它翻 false,可手上那份状态还是真的),
 * `sessions.length` 也不行(他真的一条会话都没有时也是空的)。
 *
 * 谁在用:朗读那一层靠它认「第一拍」(`chat/useSpeak.ts`)。以前它把「渲染了第一次」当第一拍,
 * 那一刻手上是占位状态、一条回复都没有,于是「已有的全标成念过」标的是空集 ——
 * 第一份真快照一到,旧回答全成了「新出现的」,打开 App 就念一遍。**改这里要连它一起想**。
 */
export function snapshotArrived(state: WorkbenchState): boolean {
  return state.now !== '';
}

/** POST /butler/item 的回执。 */
export type ButlerItemResponse =
  /**
   * 「接着刚才那件说了」(2026-09-25,卡 Y):这句话没建新卡,说进了上一件那条会话里。
   * `id` 是**上一件**的事项 id。手机上那条气泡不挂到那张卡上(不然它会被 mergePending 当成重复的收掉,
   * 他刚说的那句话就从对话里消失了)—— 留成一条自己的气泡,原话在那件事的对话里(事项页点开能看)。
   */
  | { ok: true; id: string; carried_on: true; conversation?: TaskConversation }
  | { ok: true; id: string; conversation: TaskConversation }
  | { ok: true; id: string; note: string }
  /** 「把 X 发到我手机上」(2026-09-25,卡 J):不建事项,回一张取文件的卡(见 files/fileFetch.ts)。 */
  | { ok: true; id?: undefined; file_ask: unknown; note?: string }
  /** 「下午三点跟 B 客户谈…」(2026-10-10):不建事项,登记成一场待开的会;`note` 是「记下了 + 还差哪一问」。 */
  | { ok: true; id?: undefined; meeting_plan: { id: string; title: string }; note?: string }
  /**
   * 「计划 18 号发一个关于 XXX 的视频」(2026-10-13):记进她日历上那一格 —— 一条选题卡 + 计划发布日。
   * **卡是真建了**(`id` 在),但没有人在办,所以手机那条气泡摆 `note`、回执直接「办完了」,不挂这张卡。
   * 没说清哪天的那一句不走这里:电脑回 400 + 一句回问(「这条打算哪天发?」)。
   */
  | { ok: true; id: string; publish_plan: { day: string; title: string; content_type?: string; already?: true }; note: string };

/** /live 推送。手机只消费 snapshot,其它种类不改状态。 */
export type LiveMessage =
  | { kind: 'snapshot'; state: WorkbenchState }
  | { kind: 'ping'; ts: number }
  | { kind: string };

// ─── 统一输入框(2026-09-24)。服务端 workbench-plugin/src/protocol.ts 同名一节的只读子集,字段名一字不改。───

export type ComposerMode = 'plan' | 'ask' | 'auto';
export type DispatchHand = 'cli' | 'api' | 'window';

export interface ComposerAgentView {
  /**
   * ★ 2026-09-27(卡 HC「不写死各家 AI」):**开集,与电脑那边一字不差**
   * (`workbench-plugin/src/protocol.ts` 的 `ComposerAgentView.family` 是 `string`)。
   *
   * 原来这里写着闭集的六家,于是 Muse / Manus / Grok Bot / Antigravity 这些
   * 运行时新接上的家在手机的派活那一排里**类型上就非法** —— 服务端报了,手机也画不出来。
   * 「有哪几家」只由这台电脑上的探测与登记表回答,协议不替它收窄。
   */
  family: string;
  title: string;
  hands: readonly { hand: DispatchHand; ready: boolean; why?: string }[];
  ready: boolean;
  in_slot: boolean;
  last_used_at?: string;
}

export interface ComposerModelView {
  provider: string;
  id: string;
  title: string;
  images: boolean;
}

export interface ComposerOptionsView {
  agents: readonly ComposerAgentView[];
  modes: readonly { id: ComposerMode; title: string; hint: string }[];
  mode: ComposerMode;
  models: readonly ComposerModelView[];
  model?: { provider: string; id: string };
  models_note?: string;
  recent: readonly { kind: 'item' | 'project'; id: string; title: string; note?: string }[];
}

export interface ComposerUploadView {
  id: string;
  name: string;
  type: string;
  bytes: number;
  image: boolean;
}

export interface ComposerCurrentView {
  mode: ComposerMode;
  model?: { provider: string; id: string; title: string; images: boolean };
}

export interface PendingApprovalView {
  id: string;
  session_id: string;
  task_id?: string;
  task_title?: string;
  tool: string;
  reason?: string;
  at: string;
  /** 派活前那一问(卡 O):能派给的几家一家一行,各带额度那一格。与工作台 `ApprovalOptionView` 同形。 */
  options?: readonly {
    family: string;
    title: string;
    quota: string;
    state?: 'numbers' | 'unlimited' | 'unconnected';
    /** 这个数是上次读到的、而且老了(卡 QS):`quota` 那句里带着几点读到的,这一行画淡。 */
    stale?: boolean;
    chosen?: boolean;
  }[];
  /** 人话(2026-09-25,卡 M;工作台翻好,手机照着摆):要做什么 / 为什么 / 放开到多大 / 同类的那一类 / 底层原话。 */
  say?: string;
  why?: string;
  scope?: string;
  kind?: { key: string; title: string };
  raw?: { reason?: string; command?: string };
  /**
   * 这一条是**事务官自己的提议**(2026-09-28,卡 UX):负责人驱动挂的「这张派给 X 开工?」。
   * 有它的不进「等你」、座机不为它响(卡 WY 已拍板)。老工作台不给这一格 → 照旧按那句话认(`STALE_WAITING_TEXTS`)。
   */
  proposal?: true;
}

/**
 * 「等你」那一堆里的一件(2026-09-25,卡 M 追加)。只有他能做的三样:答(问你的)、批(要批的操作、等他点头的单子与提议)、
 * 验收(办完了等他确认的)。`text` 是工作台写好的一行人话。
 * 卡 T(2026-09-25)加一样 `session`:别家的会话停着在等他(Claude / Codex / Kimi 那边在问他)。
 */
export type WaitingKind = 'question' | 'approval' | 'plan' | 'proposal' | 'confirm' | 'session' | 'decide';

export interface WaitingItemView {
  /** `question:<id>` / `approval:<id>` / `laid:<id>` / `dev:<id>` / `layout:<id>` / `evolve:<id>` / `confirm:<事项 id>` / `session:<哪一家>/<会话 id>`({@link sessionJobId})。 */
  key: string;
  kind: WaitingKind;
  verb: '答' | '批' | '验收' | '做' | '审';
  text: string;
  task_id?: string;
}

export interface WaitingView {
  count: number;
  items: readonly WaitingItemView[];
}

/**
 * 「此刻有几件在跑」(2026-09-25,卡 V)。工作台用 `src/running.ts` 的 `runningNow` 算好这一格,
 * **电脑那五处与手机首页「正在办」读同一个数**。`count` 缺席 = 数不出来(不填 0)。
 */
export interface RunningItemView {
  key: string;
  agent: AgentId;
  session_id?: string;
  task_id?: string;
  text: string;
  role?: 'business' | 'coordination' | 'unclassified';
  sources?: readonly { agent: string; session_id: string; provider?: string; transport?: string; role?: 'business' | 'coordination' | 'unclassified'; state: 'running' | 'returned' | 'ended' | 'interrupted' | 'unknown' }[];
}

export interface RunningView {
  scope?: 'classified_business_tasks';
  observed_count?: number;
  excluded?: readonly RunningItemView[];
  count?: number;
  items: readonly RunningItemView[];
}

/**
 * 粒子球此刻的状态(2026-10-04,卡「球的颜色一处算」)。与 workbench-plugin/src/protocol.ts 的 `OrbView` 同形。
 *
 * 维护者 10-04(经工作台捎话):「有一个镜头发现手机的粒子球和电脑上粒子球两个的状态不一样、颜色比如状态」。
 * 根子是两端各自从 /state 推算(手机在 swarm/orbState.ts、电脑在 client/butlerSceneModel.ts)。
 * 现在工作台用 `src/orbCell.ts` 的 `orbCellOf` 算好这一格,**手机与电脑都只显示它**:
 * 提示色(红 / 琥珀 / 中性)、在办与否、球下「受阻 N」。
 *
 * 手机自己的**本机交互态**照旧叠在上面(在说话 / 在收音 / 在想 / 通话页压成中性)—— 那是手机独有的,电脑没有。
 * 缺席 = 老工作台(那时退回 `signalsFromState` 里的本地推算,行为一字不差)。
 */
export interface OrbView {
  /** `failed` 只认**此刻正在执行的那件出错**;`confirmation` = 等她回话 / 来电响 / 通话中;其余 `neutral`。**不会是 `completed`**。 */
  notice: 'neutral' | 'confirmation' | 'failed';
  /** 有没有在办(= `running.count > 0`)。球的形态(莫比乌斯环)认它。 */
  working: boolean;
  /** 受阻几件(历史阻塞 / 出错 / 在等某家):只进这个数,**不染红主球**。 */
  blocked: number;
  active_failure: boolean;
  waiting: boolean;
  calling: boolean;
  /**
   * ★ **有一条她还没看过的回答**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   * **故意不进 `notice`**:琥珀只留给「有事停着等你回话」—— 一条回答不等她做任何事。
   * 要不要改成琥珀只动工作台 `src/orbCell.ts` 那三行,手机这一侧一个字都不用改。
   */
  answer?: boolean;
  /** ★ **有一张「刚办完」她还没看过**(同上)。同样不进 `notice`(09-28:完成那一类只发通知)。 */
  fresh_result?: boolean;
}

/**
 * ★ **一条「问一句」的回答**(2026-10-04,卡 `claude/answer-comes-to-her`;
 * 与 workbench-plugin/src/protocol.ts 的 `AnswerView` 同形)。
 *
 * 维护者 10-04(经工作台捎话):「好消息是信息准确,回复也很快,坏消息是信息直接从正在办切到办完了,
 * 我是自己追过去点开查看的」。从此答案**出现在她提问的那个地方** —— 手机就是球下那一行字幕
 * (长的截一句、点一下展开全文);App 在后台时一条通知,**正文就是答案本身**。
 *
 * 答案原文**一个字没截**(截是字幕那一格 CSS 的事)。缺席整格 = 老工作台(照旧现在的样子)。
 */
export interface AnswerView {
  /** 这一条的 id(= 那张卡的 id)。标「看过了」用它:`POST /answers/seen {id}`。 */
  id: string;
  /** 她问的那一句。老账里可能是空串(问句丢了答案还在)。 */
  question: string;
  /** 答案原文。 */
  answer: string;
  at: string;
  task_id?: string;
  session_id?: string;
  /** 她在哪问的(`phone` / `desk` / `call`…;与规矩表那一格同一套枚举)。认不出就缺席。 */
  where?: string;
  /** 她看过了(两端同步:服务端只有这一格)。缺席 = 还没看过。 */
  seen_at?: string;
}

export interface AnswersView {
  /** 最近几条,新的在前。 */
  items: readonly AnswerView[];
  /** 还没看过的几条。**手机不自己数**(同一件事的数字各处一致是硬规矩)。 */
  unseen: number;
}

/**
 * ★ **一张「刚办完 · 结果一句话」**(2026-10-04,同上第 2 条;与工作台 `FreshResultView` 同形)。
 *
 * 办完的事**不直接沉进「办完」**:首页先挂一张,她点开看过或划掉
 * (`POST /task/seen-result {id}`)才收进去。两端同一格(`seen_result_at`),手机看过电脑那张也收。
 */
export interface FreshResultView {
  task_id: string;
  title: string;
  /** 结果一句话。取不到就缺席 —— 那时只摆标题,**不编一句「这件事办完了」**。 */
  result?: string;
  done_at: string;
}

export interface FreshResultsView {
  items: readonly FreshResultView[];
}

/** 事务官问他的一件事(2026-09-25,卡 M)。文字工作台已经收拾过。 */
export interface PendingQuestionView {
  id: string;
  session_id: string;
  task_id?: string;
  task_title?: string;
  at: string;
  questions: readonly PendingQuestionItemView[];
}

export interface PendingQuestionItemView {
  id: string;
  header?: string;
  question: string;
  detail?: string;
  multi: boolean;
  /** `label` 原样交回去;`text` 摆在按钮上。 */
  options: readonly { label: string; text: string; note?: string }[];
}

export interface QuestionAnswerItem {
  id: string;
  selected: readonly string[];
  custom?: string;
}

/* ──────────── 在跑的会话写清是什么(2026-09-25,卡 P)—— 与 workbench-plugin/src/protocol.ts 同名同义,电脑与手机「正在办」同一口径 ──────────── */

export interface SessionActivity {
  line: string;
  at: string;
}

/** 权限弹窗上给她按的一颗(2026-10-01,卡 AP):`label` 壳读到的原字;`does` 它的意思。 */
export interface SessionApprovalKey {
  label: string;
  does: 'once' | 'deny';
}

/**
 * 别家的会话在等他什么(2026-09-25,卡 T)。权威定义在 workbench-plugin/src/protocol.ts 的 `SessionAskView`,这里抄手机用得着的几格。
 * `kind`:choose 在等你选 / approve 在等你点头 / do 在等你动手 / review 在等你看。
 * `reply`:答了能不能送回去 —— window / cli 送得回去;desk = 这一问得在电脑上那家里回答(`where` 是那句人话)。
 */
/**
 * **那一问的原文**(2026-10-04,卡 `claude/ask-with-context`;权威定义在
 * workbench-plugin/src/protocol.ts 的 `SessionAskFullView`)。维护者原话:「麻烦的是每次要确认内容的
 * 信息都很短,我都不知道发生了什么,还得自己去最近的会话找上下文,这个不好」。
 *
 * {@link SessionAskView.question} 是洗过、截到 60 字的一句人话(首页那一行、来电里念的那一句都是它);
 * 这一格是那家弹窗里的原字,只在她点开那一条时摆。**缺席 = 读不到原文**(按内容判出来的那几条)
 * 或者这台电脑上的工作台还是旧版 —— 两种都照旧摆短的那一句,一个字不编。
 */
export interface SessionAskFullView {
  question: string;
  header?: string;
  /** 选项原字。答的时候送回去的**不是它** —— 照旧是 {@link SessionAskView.options} 里那一颗。 */
  options?: readonly { label: string; note?: string }[];
}

export interface SessionAskView {
  kind: 'choose' | 'approve' | 'do' | 'review';
  question: string;
  options?: readonly { label: string; note?: string }[];
  /** 那一问的原文(2026-10-04;见 {@link SessionAskFullView})。 */
  full?: SessionAskFullView;
  since: string;
  quote?: string;
  by: 'form' | 'rules' | 'model';
  reply?: 'window' | 'cli' | 'desk';
  where?: string;
  /**
   * **它弹的那个框上那几项,工作台能替他点**(2026-09-28,卡 WQ)。为真时手机上那几个选项是**能点的按钮**:
   * 点一下 → `POST /asks/answer {key, choice}` → 工作台把那家叫到台前按下去、再重读一次核实。
   * 缺席 = 照旧只摆字 + 一句「这一问得在电脑上…回答」。
   */
  press?: true;
  /**
   * **她自己打的那一句工作台也送得进去**(2026-09-28,卡 AT)。为真时手机上这张卡摆「我自己说」那个框:
   * 打一句 → `POST /asks/answer {key, text}` → 工作台把她那句**原文一字不改**写进那家提问面板里的
   * 自由作答框、按**面板自己**那颗发送键,再核实一次。缺席 = 照旧一句「要自己说一句,得在电脑上…」。
   */
  write?: true;
  /** 电脑上「去回答」能不能把那段对话调到前面(手机上没有这颗键,只抄着)。 */
  reveal?: true;
  /**
   * **这一问是那家的权限弹窗**(2026-10-01,卡 AP「手机替她批准」;权威定义见 workbench-plugin/src/protocol.ts)。
   * 有这一格 = **不摆输入框**:`keys` 摆成按钮(壳读到的原字;`does` 配一句中文)→ `POST /asks/answer {key, choice}`;
   * `readable` = 打开这张卡时去读一次(`POST /sessions/approval/read`);`why` = 上次没读成那句(给「再看一次」);
   * 都没有 = 这一路读不了 → 照 `where` 说到电脑上点。放宽的键(本次会话都允许)不在 `keys` 里。
   */
  permission?: { keys?: readonly SessionApprovalKey[]; readable?: true; why?: string };
  /** 在等他的是这条会话底下的哪个子任务(后台任务);缺席 = 主会话自己在等。 */
  child?: { id: string; title?: string };
}

export interface SessionDigestRound {
  ask?: string;
  reply?: string;
  did?: string;
  at?: string;
}

/** `GET /sessions/digest?agent=&id=`:点开一条「某家在跑的会话」看的那一页(当场读,不经模型)。 */
export interface SessionDigestView {
  /** 哪一家(按字符串,不收窄成固定几家:以后自动发现的一家也走这一页)。 */
  agent: string;
  session_id: string;
  title?: string;
  project: string;
  status?: SessionStatus;
  elapsed_sec?: number;
  activity?: SessionActivity;
  rounds: readonly SessionDigestRound[];
  /**
   * 最近几轮**为什么是空的**(2026-09-28,卡 WR)。读它的窗口读出来的那几条只存了标题与最新一句,
   * 没有对话记录可读 —— 这一格如实说一句,界面照它说(不画一段空白,也不假装在读)。
   */
  rounds_note?: string;
  ended?: boolean;
  read_at: string;
  /**
   * **现在能不能在这张卡下面直接往这条会话里说一句**(2026-09-27,卡 PS)。能就摆输入框
   * (发出去走 `POST /sessions/relay`),不能就一行 `why` 说清为什么、不摆(不给摆设)。
   * 旧版工作台缺席这一格 —— 那也不摆(见 `items/SessionSayBox.tsx`)。
   */
  relay?: SessionRelayReadyView;
}

/* ──────── 手机读对话:历史、完整对话、附件(2026-10-01)。与 workbench-plugin/src/protocol.ts 同名同值(tests/sessionLibraryParity.test.ts 核)──────── */

export const SESSION_HISTORY_DAYS = 7;
export const SESSION_HISTORY_LIMIT = 20;
/** 固定入口那一份每家最多这么多条(2026-10-03,卡「手机各家最近会话固定入口」)。 */
export const SESSION_HISTORY_PER_FAMILY = 10;
export const SESSION_WINDOW_ONLY_NOTE = '这家只能看最新一句,完整的对话在它自己的窗口里';
/**
 * 窗口型那几家的图片与文件(2026-10-04,卡「手机看各家对话里的图片和文件」):读窗口只拿到那一句字,
 * 没有记录文件 —— 图片的字节、文件在哪都没有。**不编一个**,照这句如实说。
 */
export const SESSION_WINDOW_ONLY_MEDIA_NOTE = '这一家没有对话记录文件,图片和文件只能在电脑上它自己的窗口里看';

/** `GET /sessions/history`:各家最近的对话(从各家的会话记录文件读,关掉的也在)。 */
export interface SessionHistoryItem {
  agent: string;
  session_id: string;
  title?: string;
  project?: string;
  /** 窗口型读不到真实时间时缺席。 */
  last_at?: string;
  last_line?: { who: 'you' | 'ai'; text: string };
  status?: SessionStatus;
  window_only?: true;
}

export interface SessionHistoryView {
  items: SessionHistoryItem[];
  next?: string;
  days: number;
  read_at: string;
  /**
   * 这一份是按「每家最多 n 条」取的(2026-10-03)。**缺席 = 这台电脑上的工作台还不认 `per_family`**:
   * 回包形状一模一样,只能靠这一格分辨 —— 手机据此退回老样子(一条平列表)并说一句。
   */
  per_family?: number;
}

export type SessionAttachmentKind =
  | 'image' | 'video' | 'audio' | 'markdown' | 'text' | 'code' | 'table' | 'html'
  | 'pdf' | 'document' | 'slides' | 'sheet' | 'archive' | 'other';

export interface SessionAttachmentRef {
  ref: string;
  name: string;
  kind: SessionAttachmentKind;
  bytes?: number;
  from: 'you' | 'ai';
  missing?: true;
}

export type SessionTranscriptEntry =
  | { k: 'ask'; text: string; at?: string; attachments?: SessionAttachmentRef[] }
  | { k: 'reply'; text: string; at?: string; final?: true; clipped?: true; attachments?: SessionAttachmentRef[] }
  | { k: 'steps'; line: string; at?: string; steps: { line: string; detail?: string; files?: string[] }[]; attachments?: SessionAttachmentRef[] }
  | { k: 'note'; text: string; at?: string; tone: 'fail' | 'stop' | 'wait' };

export const SESSION_TRANSCRIPT_ROUNDS = 4;

/** `GET /sessions/transcript?agent=&id=&before=`:完整对话,从最新往前按轮分页;`before` 缺席 = 已经翻到开头。 */
export interface SessionTranscriptView {
  agent: string;
  session_id: string;
  title?: string;
  entries: SessionTranscriptEntry[];
  before?: string;
  read_at: string;
}

export const SESSION_ATTACHMENT_PART_BYTES = 512 * 1024;
export const SESSION_ATTACHMENT_TEXT_PART = 200_000;

/** `GET /sessions/attachment?…&view=info`:这个附件能怎么看(转换都在电脑上做好)。 */
export interface SessionAttachmentInfo {
  ref: string;
  name: string;
  kind: SessionAttachmentKind;
  mime: string;
  bytes: number;
  modified_at?: string;
  thumb: boolean;
  full?: { mime: string; bytes: number; parts: number };
  text?: { format: 'plain' | 'markdown' | 'code' | 'table' | 'html'; parts: number; lang?: string };
  pages?: number;
  note?: string;
}

export interface SessionAttachmentChunk {
  ref: string;
  view: 'thumb' | 'full' | 'text' | 'page';
  part: number;
  parts: number;
  mime?: string;
  data?: string;
  text?: string;
  rows?: string[][];
}

/** 能不能往这条会话里捎话(卡 PS)。`why` 是送不进去时那句人话,与真捎话回的那一句一模一样。 */
export interface SessionRelayReadyView {
  can: boolean;
  why?: string;
  /** 它此刻在跑没(2026-09-28,卡 WR):手机卡片据此摆不摆「打断并发送」那颗次级键。 */
  running?: boolean;
  /**
   * 能不能替他**打断**(先按那家的停止键,停下了再送)。`can:false` 时 `why` 是那句人话
   * (「认不出它的停止键,没敢替你按」/「这一家我不去打断」)—— 界面照它说,不摆那颗键。
   */
  interrupt?: { can: boolean; why?: string };
}

/* ──────── 同事项接续(2026-10-23,卡 A「同事项接续与动作契约」;与 workbench-plugin/src/protocol.ts 同名同值)──────── */

/** 一条来源这会儿能做什么。动作只有两条路(butler = 事务官那条会话;relay = 原 Agent 会话),与各家的实现无关。 */
export type ItemContinueAction =
  | { kind: 'butler' }
  | { kind: 'relay' }
  | { kind: 'none', why: string };

/** 同事项的一条来源:`GET /butler/item/:id/continue` 下发。 */
export interface ItemContinueSource {
  /** 稳定键:事务官会话固定 ITEM_CONTINUE_BUTLER_KEY;外部会话是 `${agent}:${session_id}`。 */
  key: string;
  agent: string;
  session_id: string;
  title: string;
  action: ItemContinueAction;
}

/** `GET /butler/item/:id/continue`:这件事现在能从哪儿接着做。 */
export interface ItemContinueView {
  id: string;
  sources: readonly ItemContinueSource[];
  /** 一条能续的来源都没有时的一句人话(普通记录总可以,不在这一格里)。 */
  note?: string;
}

/**
 * 接续动作的结果事实:保存 / 暂存待上线 / 已投递 / 失败 / 这条路走不通 / 要先选来源;
 * 2026-10-26(卡「事务官机制A」)补 redirected / recalled —— 只有真打断 / 真停住才许回。
 * 没有 started 这一档 —— 实际开工只有拿到真实开工回执才许说,发一句话报不出来。
 */
export type ItemContinueFact = 'saved' | 'kept' | 'sent' | 'failed' | 'unsupported' | 'pick' | 'redirected' | 'recalled';

/**
 * 同一事项上补一句的意图(2026-10-26,卡「事务官机制A」;与 workbench-plugin/src/protocol.ts 同名同值):
 * supplement 补充(缺省,旧调用逐字兼容)/ redirect 改方向(打断在跑的轮次)/ hurry 加速(催,别干等)/
 * recall 撤回(停住在跑的那一轮,别再办别再派)。只对事务官会话有意义;relay 那三种如实回 unsupported。
 */
export type ItemSayIntent = 'supplement' | 'redirect' | 'hurry' | 'recall';

/** 意图全集(服务端校验用)。 */
export const ITEM_SAY_INTENTS: readonly ItemSayIntent[] = ['supplement', 'redirect', 'hurry', 'recall'];

/** `POST /butler/item/continue` 的结果。`note` 是给人看的那一句,照服务端原话说,不另编。 */
export interface ItemContinueResult {
  ok: boolean;
  fact: ItemContinueFact;
  note: string;
  /** 这次动作用的意图(缺席 = 老服务端 / 老调用,按 supplement 理解)。 */
  intent?: ItemSayIntent;
  target?: string;
  delivered?: 'sent' | 'kept' | 'unconfirmed';
  candidates?: readonly ItemContinueSource[];
  /**
   * 事务官会话那一路的最终拒发分类(2026-10-23 晚,吸收 main 787f4d8f8;与 /butler/item/say 同一契约):
   * model = 模型还没完成应用(零发送,原事项与会话保留),host = 会话通道暂不可用。两种都**没有发送**。
   * 2026-10-26(卡「事务官机制A」)stale_queue = 改方向前要清掉队列里排着的旧话(旧队列不复活),
   * 队列这会儿读不清/清不动 —— 怕旧方案复活,这句没有发送,宁可原样不动。
   */
  code?: 'model_alignment_failed' | 'session_send_failed' | 'session_stale_queue';
  /** 撤回专用:在跑的那一轮真停住了是 true;没会话/没在跑是 false。 */
  stopped?: boolean;
  /** 撤回 / 改方向专用:这次作废掉的几句排队旧话(工作台递进去的)条数。 */
  cleared?: number;
}

/** 事务官那条会话在来源清单里的固定键。 */
export const ITEM_CONTINUE_BUTLER_KEY = 'butler';

/**
 * 一条会话在界面上叫什么:那家的标题;没有就「Claude 的一条会话」。
 * 那一家叫什么由调用方给(`agentName`):这里不放「是哪几家」的名单。
 */
export function sessionDisplayTitle(session: { title?: string | undefined }, agentName: string): string {
  const title = session.title?.trim();
  return title === undefined || title === '' ? `${agentName} 的一条会话` : title;
}

/** 「刚刚」「3 分钟前」「2 小时前」;`now` 用 /state.now(电脑的时钟)。算不出就 undefined。 */
export function agoLabel(at: string, now: string): string | undefined {
  const then = Date.parse(at);
  const current = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(current)) return undefined;
  const seconds = Math.round((current - then) / 1000);
  if (seconds < -120) return undefined;
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export const SESSION_ACTIVITY_UNKNOWN = '读不到它在做什么';

/** 「在做的事 · 3 分钟前」;读不到就「读不到它在做什么」。 */
export function sessionActivityLine(activity: SessionActivity | undefined, now: string): string {
  if (activity === undefined || activity.line.trim() === '') return SESSION_ACTIVITY_UNKNOWN;
  const ago = agoLabel(activity.at, now);
  return ago === undefined ? activity.line : `${activity.line} · ${ago}`;
}


/* ——— 会前:画像五问与预案卡(2026-10-10,与 workbench-plugin/src/protocol.ts 同形)——— */

export interface MeetingPrepAnswer<T> {
  value: T;
  /** said = 她那句话里说的;record = 已有记录里认出的(basis 写依据);asked = 她答的。 */
  from: 'said' | 'record' | 'asked';
  basis?: string;
}

export interface MeetingPersonView {
  alias: string;
  role?: string;
  decides?: true;
}

export type MeetingPrepQuestionId = 'scope' | 'kind' | 'people' | 'decider' | 'my_role' | 'goal';

export interface MeetingCardQuestionView {
  q: string;
  number?: { text: string; source: string };
  none?: true;
  line: string;
  fallback: string;
}

export interface MeetingPrepView {
  said: string;
  when?: string;
  scheduled_at?: string;
  scope?: MeetingPrepAnswer<'内部' | '外部'>;
  kind?: MeetingPrepAnswer<string>;
  people?: MeetingPrepAnswer<readonly MeetingPersonView[]>;
  decider?: MeetingPrepAnswer<string>;
  my_role?: MeetingPrepAnswer<string>;
  goal?: MeetingPrepAnswer<string>;
  goal_unclear?: true;
  organizer_ask?: string;
  ask?: { id: MeetingPrepQuestionId; text: string; choices?: readonly string[]; hint?: string };
  card_status: 'answers' | 'goal' | 'making' | 'ready' | 'failed';
  card?: { made_at: string; questions: readonly MeetingCardQuestionView[] };
  card_error?: string;
}

/** 一场待开的会(电脑 `MeetingView` 里手机用到的几样)。 */
export interface MeetingPlanView {
  id: string;
  title: string;
  date: string;
  status: string;
  prep?: MeetingPrepView;
}

/**
 * 最近整理过的一场会(2026-10-13 手机开始读 `/state.meetings.recent`)。
 *
 * 为什么只要这四样:列表上只报「哪一场、哪天、到哪一步」,点开之后那张脸走的是
 * `GET /meeting?id=`(那条回的是全貌)。老工作台没有这一格 → 列表整块不出现。
 */
export interface MeetingRecentView {
  id: string;
  title: string;
  date: string;
  status: string;
  /** 演示用那几场(电脑上一键放进来的虚构样例)。列表上标一个不起眼的记号,不冒充真会。 */
  demo?: true;
}

/**
 * 时间线上的一刻(2026-10-13,与 workbench-plugin/src/protocol.ts 的 `MeetingTimelineMark` 同形)。
 * `at` 是转写里那一行的时间戳原样(从会议开始算起),不是几点几分。
 */
export interface MeetingTimelineMark {
  at: string;
  text: string;
}

/* ──────── 1a「落地」口(2026-10-24,卡 t-1fc4c898;与 workbench-plugin/src/protocol.ts 同名同值)──────── */

/** 命令 kind 枚举(模型只能从这里选;1d 对照测试读这张表)。 */
export const SAY_KINDS = ['记', '办', '问', '改', '捎话', '闲聊'] as const;
export type SayKind = typeof SAY_KINDS[number];

/** 风险枚举:只看动作(内容里出现「发给」不构成风险)。 */
export const RISKS = ['none', 'external', 'irreversible', 'money', 'release'] as const;
export type SayRisk = typeof RISKS[number];

export interface SayResultItem {
  kind: SayKind;
  title: string;
  status: 'done' | 'asked' | 'failed';
  card_id?: string;
  detail?: string;
  /** 「办」成了的时候派给的家名(屏幕回话里如实带);缺席 = 没派成或未点名。 */
  who?: string;
}

/** 挂起的那一问(她明说「先跟我确认」的那件):没建卡没办,等她点头。 */
export interface ButlerSayAsk {
  ask_id: string;
  question: string;
}

/**
 * `POST /butler/say` 的请求(1a,2026-10-24 收口对齐 cc58 真源)。
 * ctx.last_say_id:改口/并件的「上一句」(10 分钟窗,服务端账本)。
 * ctx.confirmed:她答了挂着的一问——ask_id 用 ask.ask_id 或 hold.hold_id;
 *   choice 带「否」= 销账、那件如实没动;缺省/yes = 解冻执行原计划,不重新听懂。
 */
export interface ButlerSayRequest {
  text: string;
  entrance?: 'phone' | 'desktop' | 'phone_text' | 'hold_to_talk';
  client_key?: string;
  ctx?: {
    last_say_id?: string;
    confirmed?: { ask_id: string; choice?: string | boolean };
    /** 「我替你定的」一键改选:decided_id 是回包里 decided[].decided_id;choice = 她点的备选 id。 */
    decided?: { decided_id: string; choice: string };
    /** 建议落地:suggest_id 是回包里 suggest.suggest_id;choice='keep' 先放着,或备选 id(派一家)。 */
    suggest?: { suggest_id: string; choice: string };
    in_call?: boolean;
  };
}

/** `POST /butler/say` 的回包(1a):一句话进,命令清单 + 决策 + 真实回话出。 */
export interface ButlerSayResponse {
  say_id: string;
  items: SayResultItem[];
  decided?: { decided_id: string; item_index: number; field: 'who' | 'when' | 'kind'; chosen: string; why: string; alternatives: { id: string; label: string }[] };
  suggest?: { suggest_id: string; line: string; default_action: string; options: { id: string; label: string }[] };
  /** 挂起确认(等她点头,ask_id 可带回 ctx.confirmed 解冻)。 */
  ask?: ButlerSayAsk;
  /** 本句挂出的全部问(同句多问时 >1,含 ask 那一问;答一个,其余照挂不丢)。 */
  asks?: ButlerSayAsk[];
  /** 硬护栏(花钱/对外/撤不回/发版);hold_id 同样可 ctx.confirmed 解冻。 */
  hold?: { hold_id: string; reason: Exclude<SayRisk, 'none'>; question: string };
  say: { screen: string; spoken: string };
}
