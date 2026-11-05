import { describe, expect, it, vi } from 'vitest';
import { workbenchFromService } from '../src/pairing/discovery';

describe('mDNS 记录 → 工作台目标', () => {
  it('IPv4 优先,TXT 的 port / name / v 都带上', () => {
    expect(workbenchFromService({
      name: 'raw', port: 8791, hostname: 'bens-mac.local.',
      ipv4Addresses: ['169.254.1.2', '10.0.0.2'], txtRecord: { port: '8791', name: '工作台 · Bens-Mac', v: '0.2.25' },
    })).toEqual({ name: '工作台 · Bens-Mac', host: '10.0.0.2', port: 8791, version: '0.2.25' });
  });
  it('TXT 的 mac_id 带上(局域网 M4:同一个网里只认配对过的那台)', () => {
    expect(workbenchFromService({ name: 'x', port: 8791, ipv4Addresses: ['10.0.0.2'], txtRecord: { mac_id: 'abc123' } }))
      .toEqual({ name: 'x', host: '10.0.0.2', port: 8791, macId: 'abc123' });
  });
  it('没有 IPv4 就退回 hostname(去掉尾点);两者都没有 → null', () => {
    expect(workbenchFromService({ name: 'x', port: 8791, hostname: 'bens-mac.local.' })).toEqual({ name: 'x', host: 'bens-mac.local', port: 8791 });
    expect(workbenchFromService({ name: 'x', port: 8791 })).toBeNull();
  });
  it('TXT 没有 port 时用服务端口;端口非法 → null', () => {
    expect(workbenchFromService({ name: 'x', port: 8799, ipv4Addresses: ['10.0.0.9'] })?.port).toBe(8799);
    expect(workbenchFromService({ name: 'x', port: 0, ipv4Addresses: ['10.0.0.9'] })).toBeNull();
  });
});

describe('startDiscovery 的回调', () => {
  it('插件先回一个空结果(安卓 watch 刚挂上那一下)不抛,之后 resolved 照常认出', async () => {
    let emit: ((result: unknown) => void) | undefined;
    vi.doMock('capacitor-zeroconf', () => ({
      ZeroConf: {
        watch: async (_req: unknown, cb: (result: unknown) => void) => { emit = cb; return 'id'; },
        unwatch: async () => {},
        close: async () => {},
      },
    }));
    const { startDiscovery } = await import('../src/pairing/discovery');
    const found: unknown[] = [];
    await startDiscovery({ onFound: (w) => found.push(w), onUnavailable: () => {} });
    expect(() => emit?.(undefined)).not.toThrow();
    emit?.({ action: 'resolved', service: { name: 'x', port: 8791, ipv4Addresses: ['10.0.0.2'] } });
    expect(found).toEqual([{ name: 'x', host: '10.0.0.2', port: 8791 }]);
    vi.doUnmock('capacitor-zeroconf');
  });
});
