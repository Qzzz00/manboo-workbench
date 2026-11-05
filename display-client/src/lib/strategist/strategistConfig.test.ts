import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_STRATEGIST_CONFIG,
  loadStrategistConfig,
  normalizeStrategistConfig,
  saveStrategistConfig,
} from './strategistConfig.ts';

// 测试环境是 node（非 jsdom），全局无 localStorage —— 同 handheldLaunchStore.test.ts 打内存版 stub。
function installLocalStorageStub() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe('normalizeStrategistConfig', () => {
  it('空输入回默认（阿里云公网部署，不是 adb reverse）', () => {
    expect(normalizeStrategistConfig(null)).toEqual(DEFAULT_STRATEGIST_CONFIG);
    // 掌机连 VR_GUEST 访客网、有客户端隔离，ping 不到 Mac —— 公网才是默认，
    // 本地 docker compose 那条要在设置页手填。
    expect(DEFAULT_STRATEGIST_CONFIG.baseUrl).toBe('https://js.aibooo.cn');
  });

  it('去掉末尾斜杠——拼路径时会拼出双斜杠', () => {
    expect(normalizeStrategistConfig({ baseUrl: 'http://1.2.3.4:8080/' }).baseUrl).toBe(
      'http://1.2.3.4:8080',
    );
  });

  it('非法 baseUrl 回默认而不是留着炸', () => {
    expect(normalizeStrategistConfig({ baseUrl: '不是地址' }).baseUrl).toBe(
      DEFAULT_STRATEGIST_CONFIG.baseUrl,
    );
  });

  it('https 也认（将来部署到公网）', () => {
    expect(normalizeStrategistConfig({ baseUrl: 'https://s.example.com' }).baseUrl).toBe(
      'https://s.example.com',
    );
  });

  it('token 前后空白剪掉——手输容易带空格，带了就 401', () => {
    expect(normalizeStrategistConfig({ deviceToken: '  abc  ' }).deviceToken).toBe('abc');
  });
});

describe('load/save', () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  it('存了能读回来', () => {
    saveStrategistConfig({ baseUrl: 'http://10.0.0.2:8080', deviceToken: 't' });
    expect(loadStrategistConfig()).toMatchObject({
      baseUrl: 'http://10.0.0.2:8080',
      deviceToken: 't',
    });
  });

  it('★军师与语音是两套地址/两个 token，互不覆盖', () => {
    // 之前只有一条注入通道，两者互相覆盖过一次，这条盯着别再犯。
    saveStrategistConfig({
      baseUrl: 'http://127.0.0.1:8080',
      deviceToken: 'strat',
      aibooBaseUrl: 'http://your-aiboo-host:3456',
      aibooDeviceToken: 'voice',
    });
    const got = loadStrategistConfig();
    expect(got.deviceToken).toBe('strat');
    expect(got.aibooDeviceToken).toBe('voice');
    expect(got.baseUrl).not.toBe(got.aibooBaseUrl);
  });

  it('语音服务器有公网默认值（掌机拔线也能用语音）', () => {
    expect(DEFAULT_STRATEGIST_CONFIG.aibooBaseUrl).toMatch(/^http:\/\/8\.134\./);
  });

  it('坏 JSON 回默认，不抛——桌面绝不能因为读设置失败起不来', () => {
    localStorage.setItem('aiboo:strategist-config', '{{{');
    expect(loadStrategistConfig()).toEqual(DEFAULT_STRATEGIST_CONFIG);
  });

  it('存的时候也过一遍归一化（半截地址不会被写进去）', () => {
    saveStrategistConfig({ baseUrl: 'http://1', deviceToken: ' x ' });
    const got = loadStrategistConfig();
    expect(got.baseUrl).toBe(DEFAULT_STRATEGIST_CONFIG.baseUrl);
    expect(got.deviceToken).toBe('x');
  });
});
