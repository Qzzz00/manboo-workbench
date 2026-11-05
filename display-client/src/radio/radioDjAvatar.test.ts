import { describe, it, expect, beforeEach } from 'vitest';
import {
  RADIO_DJ_OPTIONS,
  DEFAULT_RADIO_DJ_ID,
  isValidRadioDjId,
  loadRadioDjId,
  saveRadioDjId,
} from './radioDjAvatar.ts';
import { getAvatarById } from '../features/live2d/avatarData.ts';
import { installTestAvatars } from '../features/live2d/testAvatars.ts';

// 仓库不带模型(10-21),内置表是空的:这份用例拿当年那份清单当输入。
installTestAvatars();

// 测试环境是 node（非 jsdom），全局无 localStorage —— 同 journeyStore.unread.test.ts 打内存版 stub。
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

beforeEach(() => installLocalStorageStub());

describe('RADIO_DJ_OPTIONS', () => {
  // 清单里的 id 必须真在 avatarData 注册，否则设置页选了会渲染空白。
  it('每个选项都能在 avatarData 里查到，且是模型专用条目', () => {
    for (const opt of RADIO_DJ_OPTIONS) {
      const avatar = getAvatarById(opt.id);
      expect(avatar, `${opt.id} 未注册`).toBeDefined();
      expect(avatar!.listedInDrawer, `${opt.id} 不该在选人抽屉露出`).toBe(false);
      expect(avatar!.modelJson).toContain(opt.id);
    }
  });

  it('id 不重复', () => {
    const ids = RADIO_DJ_OPTIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('loadRadioDjId / saveRadioDjId', () => {
  it('没存过 → 默认第一只', () => {
    expect(loadRadioDjId()).toBe(DEFAULT_RADIO_DJ_ID);
  });

  it('存过就读回来', () => {
    saveRadioDjId('ghostie');
    expect(loadRadioDjId()).toBe('ghostie');
  });

  // 未来若从包里下架某只角色，旧值必须自动回落，不能让电台去加载不存在的模型。
  it('存了非法/已下架 id → 回落默认', () => {
    localStorage.setItem('aiboo:radio-dj-avatar', 'shuangsheng-dj');
    expect(loadRadioDjId()).toBe(DEFAULT_RADIO_DJ_ID);
  });

  it('save 拒绝非法 id，不污染已存的值', () => {
    saveRadioDjId('ghostpuppy');
    saveRadioDjId('not-a-real-avatar');
    expect(loadRadioDjId()).toBe('ghostpuppy');
  });

  it('isValidRadioDjId 对空值安全', () => {
    expect(isValidRadioDjId(null)).toBe(false);
    expect(isValidRadioDjId(undefined)).toBe(false);
    expect(isValidRadioDjId('')).toBe(false);
  });
});
