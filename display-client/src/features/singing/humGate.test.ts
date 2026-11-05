import { describe, it, expect } from 'vitest';
import {
  applyHumStop, countsAsInterrupt,
  defaultHumGateState, markHumCompleted, markHumInterrupted, markHumStarted,
  markInteraction, nextMorning, shouldHum,
  HUM_IDLE_MS, HUM_MIN_GAP_MS, HUM_MAX_PER_HOUR,
  type HumGateState,
} from './humGate.ts';

const MIN = 60_000;
const HOUR = 3600_000;
// 用本地时间构造，避免时区把「免打扰时段」测出歧义（照 petState.test.ts 的做法）
const NOON = new Date(2026, 6, 31, 12, 0, 0).getTime();
const NIGHT = new Date(2026, 6, 31, 23, 30, 0).getTime();
const DAWN = new Date(2026, 6, 31, 6, 0, 0).getTime();

/** 造一个「其他门全开、只等被测那一项」的状态。 */
function ready(now: number): HumGateState {
  return { ...defaultHumGateState(now), lastInteractionAt: now - HUM_IDLE_MS - 1 };
}

describe('shouldHum', () => {
  it('全部条件满足时哼', () => {
    expect(shouldHum(ready(NOON), NOON)).toBe(true);
  });

  it('设置关闭 / 页面不可见 / TTS 关闭 / 扬声器占用，任一即不哼', () => {
    expect(shouldHum({ ...ready(NOON), enabled: false }, NOON)).toBe(false);
    expect(shouldHum({ ...ready(NOON), visible: false }, NOON)).toBe(false);
    expect(shouldHum({ ...ready(NOON), ttsEnabled: false }, NOON)).toBe(false);
    expect(shouldHum({ ...ready(NOON), voiceChannelBusy: true }, NOON)).toBe(false);
  });

  it('距上次交互不足 3 分钟不哼；刚满即哼', () => {
    expect(shouldHum({ ...ready(NOON), lastInteractionAt: NOON - HUM_IDLE_MS + 1 }, NOON)).toBe(false);
    expect(shouldHum({ ...ready(NOON), lastInteractionAt: NOON - HUM_IDLE_MS }, NOON)).toBe(true);
  });

  it('距上次哼不足 10 分钟不哼', () => {
    expect(shouldHum({ ...ready(NOON), lastHumAt: NOON - HUM_MIN_GAP_MS + 1 }, NOON)).toBe(false);
    expect(shouldHum({ ...ready(NOON), lastHumAt: NOON - HUM_MIN_GAP_MS }, NOON)).toBe(true);
  });

  it('每小时上限 3 次；一小时前的记录不算', () => {
    const full = { ...ready(NOON), humTimestamps: [NOON - 50 * MIN, NOON - 40 * MIN, NOON - 30 * MIN] };
    expect(shouldHum(full, NOON)).toBe(false);
    const aged = { ...ready(NOON), humTimestamps: [NOON - HOUR - 1, NOON - 40 * MIN, NOON - 30 * MIN] };
    expect(shouldHum(aged, NOON)).toBe(true);
    expect(HUM_MAX_PER_HOUR).toBe(3);
  });

  it('免打扰时段 23:00–08:00 不哼', () => {
    expect(shouldHum(ready(NIGHT), NIGHT)).toBe(false);
    expect(shouldHum(ready(DAWN), DAWN)).toBe(false);
  });

  it('退避期内不哼', () => {
    expect(shouldHum({ ...ready(NOON), backoffUntil: NOON + 1 }, NOON)).toBe(false);
    expect(shouldHum({ ...ready(NOON), backoffUntil: NOON }, NOON)).toBe(true);
  });
});

describe('状态流转', () => {
  it('markInteraction 刷新交互时刻', () => {
    expect(markInteraction(ready(NOON), NOON + 5).lastInteractionAt).toBe(NOON + 5);
  });

  it('markHumStarted 记时刻并淘汰一小时前的记录', () => {
    const s = markHumStarted({ ...ready(NOON), humTimestamps: [NOON - HOUR - 1, NOON - 10 * MIN] }, NOON);
    expect(s.lastHumAt).toBe(NOON);
    expect(s.humTimestamps).toEqual([NOON - 10 * MIN, NOON]);
  });

  it('连续 2 次被打断 → 退避到次日早上；中间哼完一次会清零', () => {
    let s = markHumInterrupted(ready(NOON), NOON);
    expect(s.backoffUntil).toBe(0);
    expect(s.consecutiveInterrupts).toBe(1);

    s = markHumInterrupted(s, NOON);
    expect(s.consecutiveInterrupts).toBe(2);
    expect(s.backoffUntil).toBe(nextMorning(NOON));

    const recovered = markHumCompleted(markHumInterrupted(ready(NOON), NOON));
    expect(recovered.consecutiveInterrupts).toBe(0);
  });

  it('nextMorning：中午 → 次日 08:00；凌晨 → 当天 08:00', () => {
    expect(nextMorning(NOON)).toBe(new Date(2026, 7, 1, 8, 0, 0, 0).getTime());
    expect(nextMorning(DAWN)).toBe(new Date(2026, 6, 31, 8, 0, 0, 0).getTime());
  });
});

describe('停哼原因 → 是否计入连续打断', () => {
  it('只有用户自己的动作算「打断」', () => {
    expect(countsAsInterrupt('user-interaction')).toBe(true);
    expect(countsAsInterrupt('voice-preempted')).toBe(false);
    expect(countsAsInterrupt('app-returned')).toBe(false);
  });

  it('user-interaction 与直接调 markHumInterrupted 等价（含触发次日退避）', () => {
    const once = applyHumStop(ready(NOON), 'user-interaction', NOON);
    expect(once).toEqual(markHumInterrupted(ready(NOON), NOON));

    const twice = applyHumStop(once, 'user-interaction', NOON);
    expect(twice.consecutiveInterrupts).toBe(2);
    expect(twice.backoffUntil).toBe(nextMorning(NOON));
  });

  // ★核心回归：应用自己抢麦（旅程主动消息 → TTS → acquireVoice('tts', ...) 会同步喊停哼唱）
  //   曾经与用户点屏走同一条路，两条主动消息就把功能静默退避到明早，全程没有用户不满。
  it('★应用自己抢走扬声器不计数：连来 5 次也不退避，门依旧放行', () => {
    let s = ready(NOON);
    for (let i = 0; i < 5; i += 1) s = applyHumStop(s, 'voice-preempted', NOON);
    expect(s.consecutiveInterrupts).toBe(0);
    expect(s.backoffUntil).toBe(0);
    expect(shouldHum(s, NOON)).toBe(true);
  });

  // ★F2 的另一半：切回本页要刷新 lastInteractionAt（那条由 markInteraction 负责），
  //   但不能同时被记成「人不想听」——否则两次切 App 就退避到明早。
  it('★切回本页不计数：连来 5 次也不退避', () => {
    let s = ready(NOON);
    for (let i = 0; i < 5; i += 1) s = applyHumStop(s, 'app-returned', NOON);
    expect(s.consecutiveInterrupts).toBe(0);
    expect(s.backoffUntil).toBe(0);
  });

  it('不计数的原因不会把已经攒下的打断计数抹掉（只是不推进）', () => {
    const afterOneReal = applyHumStop(ready(NOON), 'user-interaction', NOON);
    expect(afterOneReal.consecutiveInterrupts).toBe(1);
    const afterPreempt = applyHumStop(afterOneReal, 'voice-preempted', NOON);
    expect(afterPreempt).toBe(afterOneReal); // 原样返回，状态一个字段都不动
  });

  it('系统抢麦夹在两次真打断中间：仍然是第 2 次真打断触发退避', () => {
    let s = applyHumStop(ready(NOON), 'user-interaction', NOON);
    s = applyHumStop(s, 'voice-preempted', NOON);
    s = applyHumStop(s, 'app-returned', NOON);
    expect(s.backoffUntil).toBe(0);
    s = applyHumStop(s, 'user-interaction', NOON);
    expect(s.consecutiveInterrupts).toBe(2);
    expect(s.backoffUntil).toBe(nextMorning(NOON));
  });

  it('中间哼完一次仍然清零（markHumCompleted 语义不受影响）', () => {
    const s = markHumCompleted(applyHumStop(ready(NOON), 'user-interaction', NOON));
    expect(s.consecutiveInterrupts).toBe(0);
  });
});
