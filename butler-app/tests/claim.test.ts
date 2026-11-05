import { describe, expect, it, vi } from 'vitest';
import { claimPairing } from '../src/pairing/claim';

const target = { host: '10.0.0.2', port: 8791 };

describe('POST /pair/claim', () => {
  it('发 { code, device_name, platform:"android" },成功回 Pairing(地址 + 令牌 + 设备 id)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, token: 'T', device_id: 'dev-1' }), { status: 200 }));
    const result = await claimPairing({ fetchImpl, target, code: '123456', deviceName: 'Pixel 8' });
    expect(result).toEqual({ ok: true, pairing: { token: 'T', host: '10.0.0.2', port: 8791, deviceId: 'dev-1' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://10.0.0.2:8791/pair/claim');
    expect(JSON.parse(String(init.body))).toEqual({ code: '123456', device_name: 'Pixel 8', platform: 'android' });
  });
  it('服务端拒绝 → 原话 + locked_until', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: '连续错 5 次,锁 10 分钟', locked_until: '2026-09-14T09:00:00Z' }), { status: 429 }));
    expect(await claimPairing({ fetchImpl, target, code: '000000', deviceName: 'x' }))
      .toEqual({ ok: false, error: '连续错 5 次,锁 10 分钟', lockedUntil: '2026-09-14T09:00:00Z' });
  });
  it('404 配对未启用 → 提示去工作台开开关', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: '配对未启用' }), { status: 404 }));
    const r = await claimPairing({ fetchImpl, target, code: '123456', deviceName: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('配对未启用');
  });
  it('连不上 → 说清检查局域网与开关', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fail'); });
    const r = await claimPairing({ fetchImpl, target, code: '123456', deviceName: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('连不上工作台');
  });
  it('200 但没有 token → 按失败处理,不存半截', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const r = await claimPairing({ fetchImpl, target, code: '123456', deviceName: 'x' });
    expect(r.ok).toBe(false);
  });
});
