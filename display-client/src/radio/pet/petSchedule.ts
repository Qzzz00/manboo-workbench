/**
 * 挂机主动行为调度：30s 一跳的 tick 问「现在该不该来一发、来哪种」。
 * 全部纯函数（now/rand 注入），节奏与冷却是佛系的安全阀——绝不密集刷存在感。
 */
import type { Hunger } from './petState.ts';
import type { IdleBehavior } from './petReactions.ts';

export type ScheduleState = {
  nextIdleAt: number;
  lastDanceAt: number;
  lastRemindAt: number;
  lastReactionAt: number; // 任何反应（触摸/喂食/语音/挂机）都会更新（markReaction）
  napping: boolean;       // sleepy 动作停在半睡姿态中（被摸/说话要走 wake 反应）
};
export type ScheduleCtx = {
  now: number;
  page: 'radio' | 'home';
  blocked: boolean;  // 覆盖层/宠物面板/通话中/正在叫——任一为真都闭嘴
  playing: boolean;
  hunger: Hunger;
  sleepy: boolean;
  level: number;
  boredMs: number;
  avatarId: string;
};

const MIN = 60_000;
const IDLE_MIN = 2 * MIN, IDLE_MAX = 6 * MIN;         // 基础节奏
const BORED_MIN = 1.5 * MIN, BORED_MAX = 4 * MIN;     // 无聊(>45min)时更黏人
const BORED_AFTER_MS = 45 * MIN;
const DANCE_COOLDOWN_MS = 10 * MIN;
const REMIND_COOLDOWN_MS = 30 * MIN;
const QUIET_AFTER_REACTION_MS = 20_000;
const DEFER_MIN_MS = 30_000, DEFER_SPAN_MS = 60_000;  // 被否决时顺延量

const span = (rand: () => number, lo: number, hi: number) => lo + rand() * (hi - lo);

export function initSchedule(now: number, rand: () => number = Math.random): ScheduleState {
  return { nextIdleAt: now + span(rand, IDLE_MIN, IDLE_MAX), lastDanceAt: 0, lastRemindAt: 0, lastReactionAt: now, napping: false };
}

export function markReaction(st: ScheduleState, now: number): ScheduleState {
  return { ...st, lastReactionAt: now, napping: false };
}

export function decideIdle(
  st: ScheduleState,
  ctx: ScheduleCtx,
  rand: () => number = Math.random,
): { behavior: IdleBehavior | null; next: ScheduleState } {
  const { now } = ctx;
  const vetoed = ctx.page !== 'radio' || ctx.blocked || now - st.lastReactionAt < QUIET_AFTER_REACTION_MS;
  if (vetoed) {
    // 到点却被否决 → 顺延一小段，别在解除瞬间攒着爆发
    if (now >= st.nextIdleAt) return { behavior: null, next: { ...st, nextIdleAt: now + DEFER_MIN_MS + rand() * DEFER_SPAN_MS } };
    return { behavior: null, next: st };
  }
  if (now < st.nextIdleAt) return { behavior: null, next: st };

  const bored = ctx.boredMs > BORED_AFTER_MS;
  const reschedule = (extra: Partial<ScheduleState>): ScheduleState => ({
    ...st,
    ...extra,
    nextIdleAt: now + (bored ? span(rand, BORED_MIN, BORED_MAX) : span(rand, IDLE_MIN, IDLE_MAX)),
  });

  if (ctx.hunger === 'hungry' && now - st.lastRemindAt > REMIND_COOLDOWN_MS && rand() < 0.5) {
    return { behavior: 'hungryRemind', next: reschedule({ lastRemindAt: now, lastReactionAt: now }) };
  }
  if (ctx.playing && now - st.lastDanceAt > DANCE_COOLDOWN_MS && rand() < 0.35) {
    return { behavior: 'dance', next: reschedule({ lastDanceAt: now, lastReactionAt: now }) };
  }
  // 猫「夜里精神」：sleepy 不打盹，落到求关注
  const catAwakeAtNight = ctx.avatarId === 'hijiki' || ctx.avatarId === 'tororo';
  if (ctx.sleepy && !catAwakeAtNight) {
    return { behavior: 'nap', next: reschedule({ napping: true, lastReactionAt: now }) };
  }
  if (ctx.level >= 2) {
    return { behavior: 'attention', next: reschedule({ lastReactionAt: now }) };
  }
  // Lv1 还不熟：安静，但下一发照排
  return { behavior: null, next: reschedule({}) };
}
