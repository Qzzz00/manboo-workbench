import { describe, expect, it } from 'vitest';
import { createNetworkSource, readingFromNative, type NativeNetworkReading, type NetworkWatchNative } from '../src/channel/networkWatch';

describe('网络读数(局域网 M4)', () => {
  it('原生读数照搬;移动网络 / 没网不带标识(规格只认 Wi-Fi / 有线上的标识)', () => {
    expect(readingFromNative({ kind: 'wifi', id: 'lan:10.0.0.1/24', label: '网关 10.0.0.1', local: 'granted' }))
      .toEqual({ kind: 'wifi', id: 'lan:10.0.0.1/24', label: '网关 10.0.0.1', local: 'granted' });
    expect(readingFromNative({ kind: 'cellular', id: 'x' })).toEqual({ kind: 'cellular', id: null });
    expect(readingFromNative({ kind: 'wifi', id: '', local: 'not_needed' })).toEqual({ kind: 'wifi', id: null });
    expect(readingFromNative({ kind: 'bogus' as never })).toEqual({ kind: 'none', id: null });
    expect(readingFromNative(null)).toEqual({ kind: 'none', id: null });
  });

  it('原生插件在:读它、听它的回调;本地网络权限向它要', async () => {
    let fire: ((r: NativeNetworkReading) => void) | null = null;
    const plugin: NetworkWatchNative = {
      current: async () => ({ kind: 'wifi', id: 'lan:10.0.0.1/24', local: 'prompt' }),
      requestLocalNetwork: async () => ({ local: 'denied' }),
      addListener: async (_e, l) => { fire = l; return { remove: async () => { fire = null; } }; },
    };
    const source = createNetworkSource({ plugin });
    await expect(source.current()).resolves.toEqual({ kind: 'wifi', id: 'lan:10.0.0.1/24', local: 'prompt' });
    const seen: string[] = [];
    const off = source.subscribe((n) => seen.push(`${n.kind} ${n.id}`));
    await new Promise((r) => setTimeout(r, 0));
    fire!({ kind: 'cellular' });
    expect(seen).toEqual(['cellular null']);
    await expect(source.ensureLocal!()).resolves.toBe('denied');
    off();
    expect(fire).toBeNull();
  });

  it('原生插件调不动(网页里、老包):退回浏览器那两样,标识读不到', async () => {
    const plugin: NetworkWatchNative = {
      current: async () => { throw new Error('not implemented'); },
      requestLocalNetwork: async () => { throw new Error('not implemented'); },
      addListener: async () => { throw new Error('not implemented'); },
    };
    const source = createNetworkSource({ plugin });
    const reading = await source.current();
    expect(reading.id).toBeNull();
    await expect(source.ensureLocal!()).resolves.toBe('granted');
  });
});
