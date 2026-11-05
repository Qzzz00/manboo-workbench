/**
 * 展示台的纯数据投影:WS 消息归约与两个人话格式(重置时刻、时长)。
 * 会话区与额度区的投影 2026-09-30 起在 displayBoard.ts(与 Mac 同一份判据),这里原来那套写死四家的已删。
 *
 * 架构约束 C2（PRD §4.1）：展示台不跑模型、不做判断。
 * 这里做的全是"怎么摆"，不是"该不该响"——该不该响是工作台算好推过来的。
 */
import type {
  AgentId,
  LiveMessage,
  SessionView,
  WorkbenchState,
} from './workbenchProtocol';

export function sessionKey(agent: AgentId, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

/**
 * 把额度窗口的重置时刻写成人话。
 *
 * 之前直接把 ISO 串打在屏上（"周 窗口 2026-08-20T03:33:00.000Z 重置"），
 * 又长又要人自己心算，还会把格子撑破。
 *
 * 不走 Intl：这台设备是 Chrome 61 的老 WebView，用 Date 的本地时间方法最稳。
 */
export function formatResetAt(iso: string, now: Date = new Date()): string | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;

  const pad = (n: number): string => String(n).padStart(2, '0');
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;

  const dayOf = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayOf(at) - dayOf(now)) / 86_400_000);

  if (days === 0) return `今天 ${clock}`;
  if (days === 1) return `明天 ${clock}`;
  // 更远的只给日期：几天后的重置精确到分是噪音，还会把额度格撑到折行（真机实锤）。
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export interface LiveResult {
  state: WorkbenchState;
  /** 这条消息触发了响铃时给出会话键，供上层做 Live2D 起身与置顶。 */
  ring?: string;
  /** 这条消息要求停铃时给出会话键（话机摘机/响铃超时——来电链 v0）。 */
  ringStop?: string;
}

/** 把 event 并进快照。同一会话覆盖而不是追加。 */
function mergeEvent(state: WorkbenchState, message: Extract<LiveMessage, { kind: 'event' }>): WorkbenchState {
  const { event } = message;
  const key = sessionKey(event.agent, event.session_id);
  const rest = state.sessions.filter((s) => sessionKey(s.agent, s.session_id) !== key);
  const prev = state.sessions.find((s) => sessionKey(s.agent, s.session_id) === key);

  const merged: SessionView = {
    agent: event.agent,
    session_id: event.session_id,
    project: event.project ?? prev?.project ?? '未归类',
    status: event.type,
    elapsed_sec: 0,
    unread: event.type === 'done',
    updated_at: new Date().toISOString(),
    ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.title === undefined ? {} : { title: event.title }),
    // 摘要拿不到就不填。PRD §5.3 明令不许编造。
    ...(event.summary === undefined ? {} : { summary: event.summary }),
  };

  return { ...state, sessions: [...rest, merged] };
}

/**
 * 归约一条 WS 消息。纯函数，方便测——WS 那层只负责搬运。
 *
 * **兜底是「认不得就忽略」，绝不能改回「除此之外都当响铃」。**
 * 那个默认危险的写法让同一个坑复发了三次：ping 落进去变成假响铃（补了例外）、
 * call 落进去变成「接了电话反而响铃」（又补了例外）、悬停高亮 v1 的 hover 落进去
 * 变成一条 `undefined:undefined` 的假响铃——刷新应用就响，而且按钮和网页都停不掉，
 * 因为停铃要按会话键匹配，那个坏键谁也对不上（2026-08-24 真机实证）。
 * 服务端每加一个新消息类型，展示台就得跟着补一次例外，漏一次就响一次假铃；
 * 反过来默认忽略，最坏情况只是「新功能在展示台上没反应」，不会误报警。
 */
export function reduceLive(state: WorkbenchState, message: LiveMessage): LiveResult {
  if (message.kind === 'snapshot') return { state: message.state };
  if (message.kind === 'event') return { state: mergeEvent(state, message) };
  // 话机摘挂机：offhook（有人接）/missed（超时没人接）都要停铃；
  // onhook 与铃声无关——挂断的时候铃早停了。
  if (message.kind === 'call') {
    if (message.phase === 'onhook') return { state };
    return { state, ringStop: sessionKey(message.agent, message.session_id) };
  }
  // 响铃判定在工作台做，展示台只消费结果（C2）。只有明确的 ring 才起铃。
  if (message.kind === 'ring') return { state, ring: sessionKey(message.agent, message.session_id) };
  // 心跳、以及任何这一版还认不得的类型（如服务端新加的 hover）：不改状态、不响铃。
  return { state };
}

export function humanDuration(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.floor(sec))} 秒`;
  const minutes = Math.floor(sec / 60);
  if (minutes < 60) {
    const rest = Math.floor(sec % 60);
    return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  return restMin === 0 ? `${hours} 小时` : `${hours} 小时 ${restMin} 分`;
}
