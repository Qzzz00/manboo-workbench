import { describe, expect, it } from 'vitest';
import { meetingClock, meetingLevelBar, meetingWorkingText } from '../src/meeting/meetingModel';

describe('计时器', () => {
  it('小时位一直在(会议常常过一小时)', () => {
    expect(meetingClock(0)).toBe('00:00:00');
    expect(meetingClock(61_000)).toBe('00:01:01');
    expect(meetingClock(3_723_000)).toBe('01:02:03');
  });

  it('负数与 NaN 当 0', () => {
    expect(meetingClock(-1)).toBe('00:00:00');
    expect(meetingClock(Number.NaN)).toBe('00:00:00');
  });
});

describe('电平条', () => {
  it('小的 RMS 也看得出动静,但永远不超过 1', () => {
    expect(meetingLevelBar(0)).toBe(0);
    expect(meetingLevelBar(0.02)).toBeGreaterThan(0.2);
    expect(meetingLevelBar(1)).toBe(1);
    expect(meetingLevelBar(9)).toBe(1);
  });

  it('负数与 NaN 当 0(不画一根负长度的条)', () => {
    expect(meetingLevelBar(-1)).toBe(0);
    expect(meetingLevelBar(Number.NaN)).toBe(0);
  });
});

// 分段上传的记账(按 seq、失败不丢、App 重开接着传)在 tests/meetingOutbox.test.ts(2026-10-09 起落在 Preferences)。

describe('「正在整理」说哪一句', () => {
  it('转写时带进度;段数还没上来时不说 0/0', () => {
    expect(meetingWorkingText('transcribing', 1, 3)).toBe('正在转写…(1/3 段)');
    expect(meetingWorkingText('transcribing', undefined, undefined)).toBe('正在转写…');
    expect(meetingWorkingText('transcribing', 0, 0)).toBe('正在转写…');
  });

  it('梳理与未知各自一句', () => {
    expect(meetingWorkingText('summarizing', 3, 3)).toContain('梳理');
    expect(meetingWorkingText(undefined, undefined, undefined)).toBe('正在整理…');
  });
});
