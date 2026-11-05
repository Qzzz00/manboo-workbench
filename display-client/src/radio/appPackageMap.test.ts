import { describe, it, expect } from 'vitest';
import { resolveAppPackage } from './appPackageMap.ts';

describe('resolveAppPackage', () => {
  it('中文名命中包名', () => {
    expect(resolveAppPackage('微信')).toBe('com.tencent.mm');
    expect(resolveAppPackage('QQ')).toBe('com.tencent.mobileqq');
  });
  it('英文/别名命中', () => {
    expect(resolveAppPackage('wechat')).toBe('com.tencent.mm');
    expect(resolveAppPackage('设置')).toBe('com.android.settings');
  });
  it('去空白 + 大小写不敏感', () => {
    expect(resolveAppPackage('  WeChat ')).toBe('com.tencent.mm');
  });
  it('未知 → null', () => {
    expect(resolveAppPackage('随便什么没收录的app')).toBeNull();
    expect(resolveAppPackage('')).toBeNull();
  });
});
