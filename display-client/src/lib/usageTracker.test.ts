import { describe, expect, it, vi } from 'vitest';

import { createUsageTracker, MAX_REPORT_SECONDS, type UsageSegment } from './usageTracker';

describe('usageTracker', () => {
  it('settles one segment when going to background', () => {
    const tracker = createUsageTracker();
    tracker.enterForeground(1_000, 'yumi');
    const segments = tracker.enterBackground(121_000);
    expect(segments).toEqual<UsageSegment[]>([{ avatarId: 'yumi', seconds: 120 }]);
  });

  it('is idempotent on duplicate transitions', () => {
    const tracker = createUsageTracker();
    expect(tracker.enterBackground(1_000)).toEqual([]);
    tracker.enterForeground(1_000, 'yumi');
    expect(tracker.enterForeground(2_000, 'yumi')).toEqual([]);
    expect(tracker.enterBackground(62_000)).toEqual([{ avatarId: 'yumi', seconds: 61 }]);
    expect(tracker.enterBackground(63_000)).toEqual([]);
  });

  it('accumulates across periodic flushes while staying in foreground', () => {
    const tracker = createUsageTracker();
    tracker.enterForeground(0, 'yumi');
    const flushed = tracker.flush(60_000);
    expect(flushed).toEqual([{ avatarId: 'yumi', seconds: 60 }]);
    // 周期结算后继续计时，退后台时只报剩余段
    expect(tracker.enterBackground(120_000)).toEqual([{ avatarId: 'yumi', seconds: 60 }]);
  });

  it('attributes time to the right avatar across a mid-session switch', () => {
    const tracker = createUsageTracker();
    tracker.enterForeground(0, 'yumi');
    const settled = tracker.switchAvatar(90_000, 'ellen');
    expect(settled).toEqual([{ avatarId: 'yumi', seconds: 90 }]);
    expect(tracker.enterBackground(120_000)).toEqual([{ avatarId: 'ellen', seconds: 30 }]);
  });

  it('ignores avatar switch while in background', () => {
    const tracker = createUsageTracker();
    expect(tracker.switchAvatar(1_000, 'ellen')).toEqual([]);
    tracker.enterForeground(2_000, 'yumi');
    expect(tracker.enterBackground(12_000)).toEqual([{ avatarId: 'yumi', seconds: 10 }]);
  });

  it('chunks segments longer than the per-report cap', () => {
    const tracker = createUsageTracker();
    tracker.enterForeground(0, 'yumi');
    const segments = tracker.enterBackground(7_500_000); // 7500s = 3600 + 3600 + 300
    expect(segments).toEqual([
      { avatarId: 'yumi', seconds: MAX_REPORT_SECONDS },
      { avatarId: 'yumi', seconds: MAX_REPORT_SECONDS },
      { avatarId: 'yumi', seconds: 300 },
    ]);
  });

  it('drops sub-second and negative segments instead of reporting zero', () => {
    const tracker = createUsageTracker();
    tracker.enterForeground(1_000, 'yumi');
    expect(tracker.enterBackground(1_400)).toEqual([]);
    // 时钟回拨不产生负时长
    tracker.enterForeground(10_000, 'yumi');
    expect(tracker.enterBackground(9_000)).toEqual([]);
  });

  it('ignores empty avatar id', () => {
    const tracker = createUsageTracker();
    tracker.enterForeground(0, '');
    expect(tracker.enterBackground(120_000)).toEqual([]);
  });
});

describe('usageTracker onSessionStart', () => {
  it('fires once on the first enterForeground', () => {
    const onSessionStart = vi.fn();
    const tracker = createUsageTracker({ onSessionStart });
    tracker.enterForeground(1_000, 'yumi');
    expect(onSessionStart).toHaveBeenCalledTimes(1);
  });

  it('does not fire on repeated enterForeground while already in foreground', () => {
    const onSessionStart = vi.fn();
    const tracker = createUsageTracker({ onSessionStart });
    tracker.enterForeground(1_000, 'yumi');
    tracker.enterForeground(2_000, 'yumi');
    tracker.enterForeground(3_000, 'yumi');
    expect(onSessionStart).toHaveBeenCalledTimes(1);
  });

  it('does not fire on enterBackground or switchAvatar while in background', () => {
    const onSessionStart = vi.fn();
    const tracker = createUsageTracker({ onSessionStart });
    tracker.enterBackground(1_000);
    tracker.switchAvatar(2_000, 'ellen');
    expect(onSessionStart).not.toHaveBeenCalled();
  });

  it('fires again after enterBackground and a subsequent enterForeground', () => {
    const onSessionStart = vi.fn();
    const tracker = createUsageTracker({ onSessionStart });
    tracker.enterForeground(1_000, 'yumi');
    tracker.enterBackground(121_000);
    tracker.enterForeground(122_000, 'yumi');
    expect(onSessionStart).toHaveBeenCalledTimes(2);
  });
});
