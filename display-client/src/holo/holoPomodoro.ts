/**
 * 番茄钟状态机（纯函数，1 秒 1 拍）：
 *   work(专注,时长可配) → alarm(闹钟:Stackchan 摇头,等摸头 ack,120s 兜底) → rest(休息 10 分钟) → work…
 *
 * 与旧「work→rest 自动切」的差别：专注结束先进 alarm 相位——物理世界的闹钟（Stackchan 摇头）
 * 响到用户摸头为止；摸头(或超时兜底)才真正开始休息计时。回到 work 时 fire 'workStart'，
 * App 据此口播「开始新一轮专注」。副作用全部经 fire 信号交给调用侧，本模块零 IO 可单测锁死。
 */

export type PomodoroPhase = 'work' | 'alarm' | 'rest';

export interface PomodoroState {
  phase: PomodoroPhase;
  /** 当前相位剩余秒（alarm 相位无意义，恒 0）。 */
  remain: number;
  /** alarm 相位已持续秒数（做 120s 无人应答兜底）。 */
  alarmElapsed: number;
  /** 语音「暂停专注」：true 时 work/rest 倒计时冻结（alarm 相位不受它管——物理闹钟照摇）。 */
  paused: boolean;
}

/** 休息时长：Ben 拍板 10 分钟。 */
export const REST_SECONDS = 10 * 60;
/** 闹钟无人摸头的兜底：2 分钟后自动进休息（人不在工位也不至于卡死）。 */
export const ALARM_TIMEOUT_SECONDS = 120;

export type PomodoroFire = 'alarm' | 'alarmAgain' | 'workStart' | null;

export function initialPomodoro(workSeconds: number): PomodoroState {
  return { phase: 'work', remain: Math.max(1, workSeconds), alarmElapsed: 0, paused: false };
}

/** 语音命令（纯函数）：暂停/继续只翻 paused 旗标；ack 走 tickPomodoro 的 acked 参数。 */
export function applyPomodoroCommand(s: PomodoroState, action: 'pause' | 'resume'): PomodoroState {
  return { ...s, paused: action === 'pause' };
}

/**
 * 走一拍（1 秒）。acked=本拍收到了摸头确认（只在 alarm 相位有意义）。
 * 返回新状态 + 需要触发的副作用（'alarm'=专注结束该摇头口播 / 'workStart'=新专注开工该口播）。
 */
export function tickPomodoro(
  s: PomodoroState,
  workSeconds: number,
  acked: boolean,
): { state: PomodoroState; fire: PomodoroFire } {
  if (s.phase === 'work') {
    if (s.paused) return { state: s, fire: null }; // 暂停中冻结倒计时
    if (s.remain > 1) return { state: { ...s, remain: s.remain - 1 }, fire: null };
    return { state: { phase: 'alarm', remain: 0, alarmElapsed: 0, paused: false }, fire: 'alarm' };
  }
  if (s.phase === 'alarm') {
    if (acked || s.alarmElapsed + 1 >= ALARM_TIMEOUT_SECONDS) {
      return { state: { phase: 'rest', remain: REST_SECONDS, alarmElapsed: 0, paused: false }, fire: null };
    }
    const nextElapsed = s.alarmElapsed + 1;
    // 每20s补发一次闹钟命令(调用侧只重发命令不重复口播):防首发丢失/设备错过
    return { state: { ...s, alarmElapsed: nextElapsed }, fire: nextElapsed % 20 === 0 ? 'alarmAgain' : null };
  }
  // rest
  if (s.paused) return { state: s, fire: null };
  if (s.remain > 1) return { state: { ...s, remain: s.remain - 1 }, fire: null };
  return { state: initialPomodoro(workSeconds), fire: 'workStart' };
}
