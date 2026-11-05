import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_PAIR, resolveHoloPair } from './holoPair';

describe('resolveHoloPair', () => {
  it('URL ?pair= 永远优先（含本机）', () => {
    expect(resolveHoloPair('?pair=abc', '127.0.0.1')).toBe('abc');
    expect(resolveHoloPair('?app=v2&pair=x1', 'example.com')).toBe('x1');
  });

  it('瘦终端本机访问默认 ben1（明早零参数可用）', () => {
    expect(resolveHoloPair('', '127.0.0.1')).toBe(DEFAULT_LOCAL_PAIR);
    expect(resolveHoloPair('?app=v2', 'localhost')).toBe(DEFAULT_LOCAL_PAIR);
    expect(resolveHoloPair('', '::1')).toBe(DEFAULT_LOCAL_PAIR);
  });

  it('非本机且无参数 → null（不轮询）', () => {
    expect(resolveHoloPair('', 'example.com')).toBeNull();
    expect(resolveHoloPair('?scale=0.9', 'your-aiboo-host')).toBeNull();
  });

  it('超长 pair 截断到 64', () => {
    const long = 'p'.repeat(100);
    expect(resolveHoloPair(`?pair=${long}`, 'example.com')).toBe('p'.repeat(64));
  });
});
