/**
 * 界面上相对日子的用例一律注入固定钟(2026-10-02,卡 claude/phone-clock)。
 *
 * `pinPhoneClock` 把**手机自己的墙钟**钉在一个与用例数据风马牛不相及的日子 ——
 * 哪一处要是还看手机的钟,那一条就红;哪天跑都一样(10-01 那条「今天」用例一过夜就红,
 * 就是因为它拿墙钟赌,见 docs/交接-1002-手机事项页今天分组.md)。
 *
 * `hmOf` / `dayHmOf` 按跑测试那台机器的本地时区算出屏上该写的字,断言不跟时区赌。
 */
import { vi } from 'vitest';

/** 一个与任何用例数据都不沾边的日子。 */
export const PHONE_FAR_OFF = '2026-12-25T10:00:00+08:00';

export function pinPhoneClock(iso: string = PHONE_FAR_OFF): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

export function unpinPhoneClock(): void {
  vi.useRealTimers();
}

/** `/state.now` 那一天的那个时刻,屏上写「HH:MM」。 */
export function hmOf(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** 不是 `/state.now` 那一天的,屏上写「M-DD HH:MM」。 */
export function dayHmOf(iso: string): string {
  const at = new Date(iso);
  return `${at.getMonth() + 1}-${String(at.getDate()).padStart(2, '0')} ${hmOf(iso)}`;
}
