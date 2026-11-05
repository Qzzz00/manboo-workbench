import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadLastLaunched,
  saveLastLaunched,
  switchAppFor,
  PACKAGE_BY_APP,
  type LastLaunched,
} from './handheldLaunchStore.ts';

// 测试环境是 node（非 jsdom），全局无 localStorage —— 同 radioDjAvatar.test.ts 打内存版 stub。
function installLocalStorageStub() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

describe('switchAppFor（开游戏前杀谁）', () => {
  const RA = PACKAGE_BY_APP.retroarch;
  const DS = PACKAGE_BY_APP.duckstation;

  it('点的正是上次那一款 → 不杀（continue，切回前台保住现场）', () => {
    const last: LastLaunched = { pkg: RA, romPath: '/GBA/a.gba' };
    expect(switchAppFor(last, RA, '/GBA/a.gba')).toBeNull();
  });

  it('同一模拟器换 ROM（都走 RetroArch）→ 杀掉目标模拟器再开', () => {
    const last: LastLaunched = { pkg: RA, romPath: '/GBA/a.gba' };
    expect(switchAppFor(last, RA, '/GBA/b.gba')).toBe(RA);
  });

  it('换到另一个模拟器 → 杀目标模拟器（no-op 若它没跑，无害）', () => {
    const last: LastLaunched = { pkg: RA, romPath: '/GBA/a.gba' };
    expect(switchAppFor(last, DS, '/PS1/b.bin')).toBe(DS);
  });

  it('换到 PSP → 杀 PPSSPP（换游戏那条链路要覆盖新模拟器）', () => {
    const last: LastLaunched = { pkg: RA, romPath: '/GBA/a.gba' };
    expect(switchAppFor(last, PACKAGE_BY_APP.ppsspp, '/PSP/ISO/b.iso'))
      .toBe('org.ppsspp.ppsspp');
  });

  // ★真机实锤的坑：Aiboo 没开过任何游戏（lastLaunched 为空），但系统里残留着旧模拟器 task
  // （用户在 Aiboo 外自己开的 / 上个会话遗留）。默认必须杀，否则旧 task 被重建 = 开出旧游戏。
  it('冷启动/无记录 → 仍返回目标模拟器（默认就杀，清残留 task）', () => {
    expect(switchAppFor(null, RA, '/GBA/a.gba')).toBe(RA);
  });
});

describe('load/save 往返', () => {
  beforeEach(() => installLocalStorageStub());

  it('存了能读回来', () => {
    saveLastLaunched({ pkg: PACKAGE_BY_APP.retroarch, romPath: '/GBA/x.gba' });
    expect(loadLastLaunched()).toEqual({ pkg: PACKAGE_BY_APP.retroarch, romPath: '/GBA/x.gba' });
  });

  it('没存过 → null', () => {
    expect(loadLastLaunched()).toBeNull();
  });

  it('坏 JSON / 缺字段 → null，不抛', () => {
    localStorage.setItem('aiboo:handheld-last-launched', '{ not json');
    expect(loadLastLaunched()).toBeNull();
    localStorage.setItem('aiboo:handheld-last-launched', JSON.stringify({ pkg: 'x' }));
    expect(loadLastLaunched()).toBeNull();
  });
});
