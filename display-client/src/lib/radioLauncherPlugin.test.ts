import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 工厂被提升到顶部，普通顶层变量引用会炸 ReferenceError，需经 vi.hoisted（同 RadioSettingsSheet.test.ts）。
// isNative 用可变引用让各用例切换原生/网页环境；插件方法 stub 供 ensureBatteryExemption 断言调用。
const mocks = vi.hoisted(() => ({
  isNative: { value: false },
  getBatteryExemption: vi.fn(),
  requestBatteryExemption: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mocks.isNative.value },
  registerPlugin: () => ({
    getBatteryExemption: mocks.getBatteryExemption,
    requestBatteryExemption: mocks.requestBatteryExemption,
  }),
}));

import { resolveRootKind, ensureBatteryExemption } from './radioLauncherPlugin.ts';

describe('resolveRootKind', () => {
  it('网页默认走主 App', () => {
    expect(resolveRootKind({ isNative: false, search: '', launcherKind: 'none' })).toBe('app');
  });
  it('?radio=1 强制电台根（网页开发用）', () => {
    expect(resolveRootKind({ isNative: false, search: '?radio=1', launcherKind: 'none' })).toBe('radio');
  });
  it('?handheld=1 强制掌机根（网页开发用）', () => {
    expect(resolveRootKind({ isNative: false, search: '?handheld=1', launcherKind: 'none' })).toBe('handheld');
  });
  it('原生 radio flavor 走电台根', () => {
    expect(resolveRootKind({ isNative: true, search: '', launcherKind: 'radio' })).toBe('radio');
  });
  it('原生 handheld flavor 走掌机根', () => {
    expect(resolveRootKind({ isNative: true, search: '', launcherKind: 'handheld' })).toBe('handheld');
  });
  it('原生 phone flavor 走主 App', () => {
    expect(resolveRootKind({ isNative: true, search: '', launcherKind: 'none' })).toBe('app');
  });
  // 旧 APK 混跑：新前端配上没有 kind 字段的旧原生包，kind 读到 undefined 会被 detectRootKind
  // 兜底成 radio 或 none，绝不会漏进未知值。但纯函数本身也要对未知值有确定行为——
  // 一律回落主 App。桌面白屏是致命的，宁可挂错根也不能不挂。
  it('未知 kind 回落主 App', () => {
    expect(resolveRootKind({ isNative: true, search: '', launcherKind: '' })).toBe('app');
  });
});

// careai ROM 会在灭屏约 12 分钟后按 app-idle 杀前台播放服务（task-10 报告实锤），
// 根治 = 首启引导用户授予电池优化豁免。这里锁的是引导流程的分支逻辑。
describe('ensureBatteryExemption 首启电池优化豁免引导', () => {
  beforeEach(() => {
    mocks.isNative.value = true;
    mocks.getBatteryExemption.mockReset();
    mocks.requestBatteryExemption.mockReset();
    mocks.requestBatteryExemption.mockResolvedValue(undefined);
  });

  it('网页环境：不查询不弹窗', async () => {
    mocks.isNative.value = false;
    await ensureBatteryExemption();
    expect(mocks.getBatteryExemption).not.toHaveBeenCalled();
    expect(mocks.requestBatteryExemption).not.toHaveBeenCalled();
  });

  it('已豁免：只查询，不再弹窗', async () => {
    mocks.getBatteryExemption.mockResolvedValue({ exempt: true });
    await ensureBatteryExemption();
    expect(mocks.getBatteryExemption).toHaveBeenCalledTimes(1);
    expect(mocks.requestBatteryExemption).not.toHaveBeenCalled();
  });

  it('未豁免：拉起系统豁免弹窗', async () => {
    mocks.getBatteryExemption.mockResolvedValue({ exempt: false });
    await ensureBatteryExemption();
    expect(mocks.requestBatteryExemption).toHaveBeenCalledTimes(1);
  });

  it('查询失败：安全跳过，不弹窗不抛异常', async () => {
    mocks.getBatteryExemption.mockRejectedValue(new Error('boom'));
    await expect(ensureBatteryExemption()).resolves.toBeUndefined();
    expect(mocks.requestBatteryExemption).not.toHaveBeenCalled();
  });

  it('弹窗调用失败：不向调用方抛异常', async () => {
    mocks.getBatteryExemption.mockResolvedValue({ exempt: false });
    mocks.requestBatteryExemption.mockRejectedValue(new Error('no activity'));
    await expect(ensureBatteryExemption()).resolves.toBeUndefined();
  });
});
