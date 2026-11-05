/**
 * 界面上的相对日子照**电脑的钟**(2026-10-02,卡 claude/phone-clock;口径 2026-10-01 已拍板,
 * 见 docs/交接-1002-手机事项页今天分组.md)。
 *
 * 这一份钉三样:
 *   ① `clockOf`(src/clock.ts):相对日子的参考时刻只有这一个主人,读不出来才退回手机的钟;
 *   ② `formatClock(iso, now)`:「是不是今天」照 `now`(= `/state.now`)判,不看手机的墙钟;
 *   ③ 气泡列表 `ThreadList`:它手上没有 `state`,`now` 是**传进去的**(每条气泡上那个时刻照它写)。
 *
 * 每一条都把**手机自己的钟钉在一个风马牛不相及的日子**(2026-12-25)——
 * 证的是「这一处看的是 /state.now」,而不是「今天恰好是哪一天」。哪天跑都一样。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { clockOf } from '../src/clock';
import { formatClock } from '../src/hooks';
import { ThreadList } from '../src/chat/ThreadList';
import type { ThreadMessage } from '../src/chat/chatModel';

function pinPhoneClock(at: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}
afterEach(() => { vi.useRealTimers(); });

/** 本地时刻 → ISO:断言与跑测试那台机器的时区无关(两头都用本地分量造)。 */
function local(y: number, m: number, d: number, h: number, min: number): Date {
  return new Date(y, m - 1, d, h, min);
}
function iso(y: number, m: number, d: number, h: number, min: number): string {
  return local(y, m, d, h, min).toISOString();
}

const PHONE_FAR_OFF = local(2026, 12, 25, 10, 0);

describe('clockOf:相对日子的参考时刻', () => {
  it('/state.now 那个字符串就是参考时刻', () => {
    pinPhoneClock(PHONE_FAR_OFF);
    expect(clockOf(iso(2026, 10, 2, 21, 30)).getTime()).toBe(local(2026, 10, 2, 21, 30).getTime());
  });

  it('毫秒数与 Date 照旧能用(老调用方与用例)', () => {
    pinPhoneClock(PHONE_FAR_OFF);
    const at = local(2026, 10, 2, 21, 30);
    expect(clockOf(at.getTime()).getTime()).toBe(at.getTime());
    expect(clockOf(at).getTime()).toBe(at.getTime());
  });

  it('读不出来(还没连上那一瞬的空串 / 缺席 / 认不出)才退回手机的钟', () => {
    pinPhoneClock(PHONE_FAR_OFF);
    expect(clockOf('').getTime()).toBe(PHONE_FAR_OFF.getTime());
    expect(clockOf(undefined).getTime()).toBe(PHONE_FAR_OFF.getTime());
    expect(clockOf('这不是一个时刻').getTime()).toBe(PHONE_FAR_OFF.getTime());
  });
});

describe('formatClock:「是不是今天」照 /state.now 判', () => {
  it('★手机的钟在 12-25,/state.now 在 10-02:当天那一条只写时刻,不带日期', () => {
    pinPhoneClock(PHONE_FAR_OFF);
    expect(formatClock(iso(2026, 10, 2, 21, 30), iso(2026, 10, 2, 23, 0))).toBe('21:30');
  });

  it('★别的日子带「M-DD」:前一天那一条写「10-01 21:30」—— 手机的钟还停在 10-01 也不算数', () => {
    pinPhoneClock(local(2026, 10, 1, 23, 0));
    expect(formatClock(iso(2026, 10, 1, 21, 30), iso(2026, 10, 2, 9, 0))).toBe('10-01 21:30');
  });

  it('★手机的钟在「今天」也不算数:/state.now 说 10-03 了,10-02 那一条就要带日期', () => {
    pinPhoneClock(local(2026, 10, 2, 23, 59));
    expect(formatClock(iso(2026, 10, 2, 21, 30), iso(2026, 10, 3, 0, 10))).toBe('10-02 21:30');
  });

  it('/state.now 读不出来(还没连上)才退回手机的钟', () => {
    pinPhoneClock(local(2026, 10, 2, 23, 0));
    expect(formatClock(iso(2026, 10, 2, 21, 30), '')).toBe('21:30');
    expect(formatClock(iso(2026, 10, 1, 21, 30), undefined)).toBe('10-01 21:30');
  });

  it('没有时刻 / 认不出的时刻:空字符串,不编一个', () => {
    pinPhoneClock(PHONE_FAR_OFF);
    expect(formatClock(undefined, iso(2026, 10, 2, 9, 0))).toBe('');
    expect(formatClock('这不是一个时刻', iso(2026, 10, 2, 9, 0))).toBe('');
  });
});

describe('气泡列表:now 是传进去的(它手上没有 state)', () => {
  function message(at: string): ThreadMessage {
    return { taskId: 't1', user: '加个导出 PDF', at, butler: { kind: 'status', text: '事务官在办', speak: false } };
  }

  it('★手机的钟在 12-25:/state.now 当天那条气泡只写时刻', () => {
    pinPhoneClock(PHONE_FAR_OFF);
    render(<ThreadList thread={[message(iso(2026, 10, 2, 21, 30))]} voiceOff now={iso(2026, 10, 2, 23, 0)} />);
    expect(screen.getByText('21:30')).toBeTruthy();
  });

  it('★不是 /state.now 那一天的带日期(手机的钟还停在 10-01 也不算数)', () => {
    pinPhoneClock(local(2026, 10, 1, 23, 0));
    render(<ThreadList thread={[message(iso(2026, 10, 1, 21, 30))]} voiceOff now={iso(2026, 10, 2, 9, 0)} />);
    expect(screen.getByText('10-01 21:30')).toBeTruthy();
  });
});
