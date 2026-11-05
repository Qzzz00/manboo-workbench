import { describe, expect, it } from 'vitest';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import type { KeyValueStore } from '../src/api/tokenStore';

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

describe('settingsStore', () => {
  it('缺省:语音开、没选形象、引导待跑标记为空、主界面是粒子、通话走 LiveKit', async () => {
    expect(await createSettingsStore(memory()).load()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      voiceEnabled: true, avatarId: null, onboarding: 'none', stage: 'particles', callProvider: 'livekit', ringStandby: true,
    });
  });
  it('局部更新并读回;坏数据回缺省', async () => {
    const kv = memory();
    const store = createSettingsStore(kv);
    await store.update({ avatarId: 'hijiki' });
    await store.update({ voiceEnabled: false });
    await store.update({ stage: 'live2d' });
    expect(await store.load()).toEqual({
      voiceEnabled: false, avatarId: 'hijiki', onboarding: 'none', stage: 'live2d', callProvider: 'livekit', ringStandby: true,
    });
    kv.data.set('butler.settings', 'garbage');
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });
  it('不认识的键忽略,类型不对的字段回缺省', async () => {
    const kv = memory();
    kv.data.set('butler.settings', JSON.stringify({ voiceEnabled: 'yes', avatarId: 3, onboarding: 'pending', stage: 'orb', callProvider: '火山', extra: 1 }));
    expect(await createSettingsStore(kv).load()).toEqual({
      voiceEnabled: true, avatarId: null, onboarding: 'pending', stage: 'particles', callProvider: 'livekit', ringStandby: true,
    });
  });
  /**
   * ★ 座机页那三格(座机模式 / 放上无线充就进座机页 / 拿下来 5 分钟后回舞台)2026-09-25 去掉了
   * (维护者:「手机的不要这个什么所谓的座机页面,就显示首页就好了...多此一举」)。
   * 老手机上存着的这三格:读进来就丢,第一次写回的时候顺手从存档里消失,不报错。
   */
  it('★ 老存档里的座机三格:读不出来,写一次之后存档里也没有了', async () => {
    const kv = memory();
    kv.data.set('butler.settings', JSON.stringify({ voiceEnabled: false, deskPhone: 'always', deskPhoneOnCharge: true, deskPhoneLeaveOnUnplug: false }));
    const loaded = await createSettingsStore(kv).load() as unknown as Record<string, unknown>;
    expect(loaded.deskPhone).toBeUndefined();
    expect(loaded.deskPhoneOnCharge).toBeUndefined();
    expect(loaded.voiceEnabled).toBe(false);
    await createSettingsStore(kv).update({ avatarId: 'x' });
    expect(JSON.parse(kv.data.get('butler.settings')!)).not.toHaveProperty('deskPhone');
  });
});
