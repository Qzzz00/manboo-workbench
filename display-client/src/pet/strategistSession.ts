// 底条军师问答的状态机。纯逻辑、与 React 无关 —— 面板只负责把状态画出来。
//
// ★★交互是「等你开口」不是「替你猜」（Ben 2026-07-31 定调）：
// 原来点一下就直接出答案（文档 §7.4 的「一键卡关」），实际用下来很不合逻辑——
// 没有问题的 AI 只能给通用建议（「想抓就打残丢球」），而且用户会懵：「我不用问问题吗？」
// 现在改成：F10 呼出 → 角色主动开场白「怎么啦，需要我帮忙吗？」（这句话本身就是
// 「可以问了」的提示）→ 按住说话才真正提问。「一键卡关」只作为服务端内部的
// quick_action（截图和问题一起发）继续存在，UI 上这个概念消失。
//
// ★答案**保留到下一个问题**，不再定时收走：问题可能复杂，用户要能回头慢慢看
// （面板此时可滚动，见 Live2DOverlayService 动态切 FLAG_NOT_TOUCHABLE）。
//
// ★每个中间态都有一句话（statusTextFor）：端到端要 5-10 秒，不给反馈用户会以为按坏了。

export type StrategistState =
  /** 刚呼出底条：角色主动招呼，等你开口。这是常驻的「待命」态。 */
  | { kind: 'greeting' }
  | { kind: 'capturing' }
  | { kind: 'listening' }
  | { kind: 'transcribing' }
  | { kind: 'thinking'; transcript?: string }
  | { kind: 'answering'; text: string; transcript?: string }
  | { kind: 'done'; text: string; transcript?: string }
  | { kind: 'error'; message: string };

export type StrategistEvent =
  /** 点一下角色：收起上一条答案、回到待命并重播招呼（不发请求、不花钱）。 */
  | { type: 'ask' }
  | { type: 'captured' }
  | { type: 'holdStart' }
  | { type: 'holdEnd' }
  | { type: 'transcribed'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'reset' };

export function initialState(): StrategistState {
  return { kind: 'greeting' };
}

/** 正在跑一轮（此时点一下 = 取消）。done/error 是「结果还挂在屏幕上」，不算忙。 */
export function isBusy(s: StrategistState): boolean {
  return (
    s.kind === 'capturing' ||
    s.kind === 'listening' ||
    s.kind === 'transcribing' ||
    s.kind === 'thinking' ||
    s.kind === 'answering'
  );
}

function transcriptOf(s: StrategistState): string | undefined {
  return 'transcript' in s ? s.transcript : undefined;
}

export function strategistReducer(s: StrategistState, e: StrategistEvent): StrategistState {
  switch (e.type) {
    case 'reset':
      return { kind: 'greeting' };
    case 'error':
      return { kind: 'error', message: e.message };
    case 'ask':
      // 点一下角色：忙就打断，不忙就把上一条答案收走、回到待命。
      // ★不再直接出答案 —— 提问必须由用户开口（按住说话）。
      return { kind: 'greeting' };
    case 'holdStart':
      // 忙的时候按住不抢占正在跑的那一轮（返回同一个对象，调用方可以靠引用相等判「没变」）
      return isBusy(s) ? s : { kind: 'listening' };
    case 'holdEnd':
      // 原生手势可能乱序（比如 hold 还没到门槛就抬手），不在录音就什么都不做
      return s.kind === 'listening' ? { kind: 'transcribing' } : s;
    case 'transcribed':
      return { kind: 'thinking', transcript: e.text };
    case 'captured':
      // 一键卡关（capturing）→ 直接思考；语音路径的截屏在按下瞬间就做完了。
      return { kind: 'thinking', transcript: transcriptOf(s) };
    case 'delta':
      return s.kind === 'answering'
        ? { kind: 'answering', text: s.text + e.text, transcript: s.transcript }
        : { kind: 'answering', text: e.text, transcript: transcriptOf(s) };
    case 'done':
      return {
        kind: 'done',
        text: s.kind === 'answering' ? s.text : '',
        transcript: transcriptOf(s),
      };
    default:
      return s;
  }
}

/** 每个状态给玩家看的一句话。空串 = 该状态由内容本身表达（answering/done 显示答案）。 */
export function statusTextFor(s: StrategistState): string {
  switch (s.kind) {
    case 'greeting':
      return '怎么啦，需要我帮忙吗？（按住我说话）';
    case 'capturing':
      return '看一眼画面…';
    case 'listening':
      return '在听…（松开就问）';
    case 'transcribing':
      return '听清了没…';
    case 'thinking':
      return '想想…';
    case 'error':
      return s.message;
    default:
      return '';
  }
}
