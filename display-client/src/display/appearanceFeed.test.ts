/**
 * 粒子球的参数从 Mac 那份 appearance.json 来(2026-09-22)。
 * 最要紧的一条:**任何一条路走不通都回默认值,不抛、不白屏**。
 */
import { describe, expect, it, vi } from 'vitest';
import { TUNING_DEFAULTS } from '../swarm/core.js';
import {
  APPEARANCE_DEFAULT_NOTE,
  fetchAppearance,
  settingsFromDoc,
  workbenchHttpBase,
} from './appearanceFeed';

const preset = (over: Record<string, number> = {}) => ({
  kind: 'butler-swarm-v4',
  version: 1,
  settings: { ...TUNING_DEFAULTS, ...over },
  svg: '',
  fill: false,
});

function okFetch(body: unknown, seen?: { url?: string; headers?: Headers }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (seen !== undefined) { seen.url = String(input); seen.headers = new Headers(init?.headers); }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

describe('/live 的 ws 地址 → 同一台工作台的 HTTP 根', () => {
  it('ws → http、wss → https,端口原样', () => {
    expect(workbenchHttpBase('ws://10.0.0.9:8791/live')).toBe('http://10.0.0.9:8791');
    expect(workbenchHttpBase('wss://box.local:8791/live?token=T')).toBe('https://box.local:8791');
    expect(workbenchHttpBase('http://127.0.0.1:8791/live')).toBe('http://127.0.0.1:8791');
  });
  it('认不出来就 null(那就用默认值)', () => {
    expect(workbenchHttpBase('')).toBeNull();
    expect(workbenchHttpBase('不是地址')).toBeNull();
    expect(workbenchHttpBase('file:///tmp/x')).toBeNull();
  });
});

describe('服务端那份文档 → 参数', () => {
  it('正常文档:参数与版本都拿到', () => {
    const parsed = settingsFromDoc({ version: 7, preset: preset({ count: 1800 }) });
    expect(parsed?.version).toBe(7);
    expect(parsed?.settings.count).toBe(1800);
  });
  it('越界的值被核心 normalize 夹回范围(数量上限 8000)', () => {
    expect(settingsFromDoc({ version: 1, preset: preset({ count: 99999 }) })?.settings.count).toBe(8000);
  });
  it('形状不对一律 null:不是对象 / 没有版本 / preset 不是这套调试台导出的', () => {
    expect(settingsFromDoc(null)).toBeNull();
    expect(settingsFromDoc('x')).toBeNull();
    expect(settingsFromDoc({ preset: preset() })).toBeNull();
    expect(settingsFromDoc({ version: 1, preset: { kind: '别的东西' } })).toBeNull();
  });
});

describe('拉一次外观', () => {
  it('★拿到了就是 synced,参数来自 Mac', async () => {
    const r = await fetchAppearance({
      wsUrl: 'ws://127.0.0.1:8791/live',
      token: null,
      fetchImpl: okFetch({ version: 3, preset: preset({ count: 1800, spinSpeed: 0.6 }) }),
    });
    expect(r.status).toBe('synced');
    expect(r.version).toBe(3);
    expect(r.settings.count).toBe(1800);
    expect(r.settings.spinSpeed).toBe(0.6);
  });
  it('★地址与令牌:打的是同一台工作台的 /butler/appearance,令牌走请求头、不进 URL', async () => {
    const seen: { url?: string; headers?: Headers } = {};
    await fetchAppearance({
      wsUrl: 'ws://10.0.0.9:8791/live?token=SECRET',
      token: 'SECRET',
      fetchImpl: okFetch({ version: 1, preset: preset() }, seen),
    });
    expect(seen.url).toBe('http://10.0.0.9:8791/butler/appearance');
    expect(seen.url).not.toContain('SECRET');
    expect(seen.headers?.get('authorization')).toBe('Bearer SECRET');
  });
  it('本机回环没有令牌时不带那个头(服务端本机免令牌)', async () => {
    const seen: { url?: string; headers?: Headers } = {};
    await fetchAppearance({ wsUrl: 'ws://127.0.0.1:8791/live', token: null, fetchImpl: okFetch({ version: 1, preset: preset() }, seen) });
    expect(seen.headers?.has('authorization')).toBe(false);
  });
  it('★404(Mac 上从没调过外观)= 默认值 + 一句实话,不抛', async () => {
    const r = await fetchAppearance({
      wsUrl: 'ws://127.0.0.1:8791/live',
      token: null,
      fetchImpl: (async () => ({ ok: false, status: 404, json: async () => ({ error: '还没有保存过外观' }) } as Response)) as unknown as typeof fetch,
    });
    expect(r.status).toBe('default');
    expect(r.note).toBe(APPEARANCE_DEFAULT_NOTE);
    expect(r.settings.count).toBe(TUNING_DEFAULTS.count);
  });
  it('★连不上 / 被 CORS 拦下(fetch 直接抛)也是默认值,不抛出去', async () => {
    const r = await fetchAppearance({
      wsUrl: 'ws://10.0.0.9:8791/live',
      token: 'T',
      fetchImpl: vi.fn(async () => { throw new Error('Failed to fetch'); }) as unknown as typeof fetch,
    });
    expect(r.status).toBe('default');
    expect(r.settings).toEqual({ ...TUNING_DEFAULTS });
  });
  it('地址认不出来时连请求都不发', async () => {
    const impl = vi.fn();
    const r = await fetchAppearance({ wsUrl: '不是地址', token: null, fetchImpl: impl as unknown as typeof fetch });
    expect(impl).not.toHaveBeenCalled();
    expect(r.status).toBe('default');
  });
});
