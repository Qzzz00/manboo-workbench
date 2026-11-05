/**
 * 待机哼唱的防烦门——纯函数，本功能的生死线。
 * 哼歌这种事宁可少也不能烦：任何一道门不过就不哼，且连续被打断会自动退避到次日。
 */

export const HUM_IDLE_MS = 3 * 60_000;
export const HUM_MIN_GAP_MS = 10 * 60_000;
export const HUM_MAX_PER_HOUR = 3;
export const HUM_QUIET_START_HOUR = 23;
export const HUM_QUIET_END_HOUR = 8;
export const HUM_MAX_CONSECUTIVE_INTERRUPTS = 2;

const HOUR_MS = 3600_000;

export type HumGateState = {
  /** 设置项：本宿主允许自发哼唱 */
  enabled: boolean;
  /** 页面/窗口当前可见 */
  visible: boolean;
  /** TTS 总开关（ttsEnabledStore） */
  ttsEnabled: boolean;
  /** 扬声器被别人占着（TTS 在播 / 通话中） */
  voiceChannelBusy: boolean;
  lastInteractionAt: number;
  lastHumAt: number;
  /** 近一小时的哼唱时刻 */
  humTimestamps: number[];
  consecutiveInterrupts: number;
  /** 退避截止时刻；now < 此值则一律不哼 */
  backoffUntil: number;
};

export function defaultHumGateState(now: number): HumGateState {
  return {
    enabled: true,
    visible: true,
    ttsEnabled: true,
    voiceChannelBusy: false,
    lastInteractionAt: now,
    lastHumAt: 0,
    humTimestamps: [],
    consecutiveInterrupts: 0,
    backoffUntil: 0,
  };
}

/** 免打扰时段：23:00–08:00（跨零点，所以是「或」不是「且」）。 */
export function isQuietHour(now: number): boolean {
  const hour = new Date(now).getHours();
  return hour >= HUM_QUIET_START_HOUR || hour < HUM_QUIET_END_HOUR;
}

/** 退避目标：下一个 08:00。 */
export function nextMorning(now: number): number {
  const d = new Date(now);
  d.setHours(HUM_QUIET_END_HOUR, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function shouldHum(s: HumGateState, now: number): boolean {
  if (!s.enabled || !s.visible || !s.ttsEnabled || s.voiceChannelBusy) return false;
  if (now < s.backoffUntil) return false;
  if (isQuietHour(now)) return false;
  if (now - s.lastInteractionAt < HUM_IDLE_MS) return false;
  if (s.lastHumAt > 0 && now - s.lastHumAt < HUM_MIN_GAP_MS) return false;
  if (s.humTimestamps.filter((t) => now - t < HOUR_MS).length >= HUM_MAX_PER_HOUR) return false;
  return true;
}

export function markInteraction(s: HumGateState, now: number): HumGateState {
  return { ...s, lastInteractionAt: now };
}

export function markHumStarted(s: HumGateState, now: number): HumGateState {
  return {
    ...s,
    lastHumAt: now,
    humTimestamps: [...s.humTimestamps.filter((t) => now - t < HOUR_MS), now],
  };
}

/** 完整哼完一次：说明没打扰到人，打断计数清零。 */
export function markHumCompleted(s: HumGateState): HumGateState {
  return { ...s, consecutiveInterrupts: 0 };
}

/** 哼到一半被打断：连续两次就说明这会儿人不想听，退避到次日早上。 */
export function markHumInterrupted(s: HumGateState, now: number): HumGateState {
  const n = s.consecutiveInterrupts + 1;
  if (n < HUM_MAX_CONSECUTIVE_INTERRUPTS) return { ...s, consecutiveInterrupts: n };
  return { ...s, consecutiveInterrupts: n, backoffUntil: nextMorning(now) };
}

/**
 * 「哼到一半停了」的原因。
 *
 * ★退避规则（连续 2 次 → 次日 08:00）的**唯一证据**是 markHumInterrupted 注释里那句
 * 「说明这会儿人不想听」。所以只有用户自己的动作才算数：应用自己抢走扬声器（旅程
 * 主动消息走 performProactive → TTS → acquireVoice('tts', ...)，会同步喊停哼唱）
 * 恰恰发生在「用户闲着」——那也正是唯一会起哼的时段。把它计进连续打断，等于同一天
 * 来两条主动消息就把整个功能静默关到明早，全程没有任何用户不满。
 */
export type HumStopReason =
  /** 用户点屏 / 按键 / 发消息——真·打断，是「不想听」的证据 */
  | 'user-interaction'
  /** 应用自己占用扬声器（主动消息 TTS / 通话）——系统行为，不是用户不满 */
  | 'voice-preempted'
  /** 用户从后台切回本页——刷新交互计时，但没有「嫌吵」的证据 */
  | 'app-returned';

/** 这次「停」算不算用户不想听。 */
export function countsAsInterrupt(reason: HumStopReason): boolean {
  return reason === 'user-interaction';
}

/** 按停哼原因推进门状态：只有真·打断才计入连续打断（可能触发次日退避）。 */
export function applyHumStop(s: HumGateState, reason: HumStopReason, now: number): HumGateState {
  return countsAsInterrupt(reason) ? markHumInterrupted(s, now) : s;
}
