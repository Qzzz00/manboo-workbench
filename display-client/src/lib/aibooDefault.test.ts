import { describe, expect, it } from 'vitest';
import { AIBOO_DEFAULT_BASE_URL, aibooDefaultBase } from './aibooDefault.ts';

describe('Aiboo 云的默认地址(2026-10-21:默认不变,构建时可换)', () => {
  it('没配:还是原来那台', () => {
    expect(aibooDefaultBase(undefined)).toBe('http://your-aiboo-host:3456');
    expect(aibooDefaultBase('')).toBe('http://your-aiboo-host:3456');
    expect(AIBOO_DEFAULT_BASE_URL).toBe('http://your-aiboo-host:3456');
  });

  it('VITE_AIBOO_BASE_URL 给了 http/https 就用它(去掉末尾斜杠);别的协议不认', () => {
    expect(aibooDefaultBase('https://my-aiboo.example.test/')).toBe('https://my-aiboo.example.test');
    expect(aibooDefaultBase('javascript:alert(1)')).toBe('http://your-aiboo-host:3456');
  });
});
