import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client';
import { APPEARANCE_NOT_SYNCED_TEXT, createAppearanceFeed, presetFromDoc } from '../src/swarm/appearance';
import { TUNING_DEFAULTS } from '../src/swarm/core.js';

const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
const client = (fetchImpl: typeof fetch) => createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
const doc = (version: number, count: number) => ({ version, updated_at: 't', preset: { kind: 'butler-swarm-v4', version: 1, settings: { ...TUNING_DEFAULTS, count }, svg: '', fill: false } });

describe('外观继承 Mac 的那一份', () => {
  it('presetFromDoc:合法文档 → 归一化后的 preset;形状不对 → null', () => {
    const parsed = presetFromDoc(doc(3, 6800));
    expect(parsed?.version).toBe(3);
    expect(parsed?.preset.settings.count).toBe(6800);
    expect(presetFromDoc({ version: 1, preset: { kind: 'x' } })).toBeNull();
    expect(presetFromDoc({ preset: doc(1, 1).preset })).toBeNull();
    expect(presetFromDoc(null)).toBeNull();
  });
  it('presetFromDoc:超范围的数值收口到范围内(与 Mac 同一个 normalizeTuning)', () => {
    expect(presetFromDoc(doc(1, 99999))?.preset.settings.count).toBe(8000);
  });
  it('拉到 → synced,数量等继承;版本没变不重拉,变了重拉', async () => {
    let version = 1;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://h:8791/butler/appearance');
      return new Response(JSON.stringify(doc(version, version === 1 ? 1800 : 3600)), { status: 200 });
    });
    const feed = createAppearanceFeed(client(fetchImpl as unknown as typeof fetch));
    expect(feed.get().status).toBe('loading');
    await feed.refresh();
    expect(feed.get()).toMatchObject({ status: 'synced', version: 1, preset: { settings: { count: 1800 } } });
    feed.notice(1);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    version = 2;
    feed.notice(2);
    await vi.waitFor(() => expect(feed.get()).toMatchObject({ status: 'synced', version: 2, preset: { settings: { count: 3600 } } }));
  });
  it('404(Mac 还没存过)→ 核心默认值 + 「未同步到 Mac 的外观」;连不上同样', async () => {
    const missing = createAppearanceFeed(client(vi.fn(async () => new Response(JSON.stringify({ error: '还没有保存过外观' }), { status: 404 })) as unknown as typeof fetch));
    await missing.refresh();
    expect(missing.get()).toMatchObject({ status: 'default', note: APPEARANCE_NOT_SYNCED_TEXT, preset: { settings: TUNING_DEFAULTS } });
    const down = createAppearanceFeed(client(vi.fn(async () => { throw new TypeError('down'); }) as unknown as typeof fetch));
    await down.refresh();
    expect(down.get()).toMatchObject({ status: 'default', note: APPEARANCE_NOT_SYNCED_TEXT });
  });
  it('已同步过之后暂时拉不到:留着上次那份,不退回默认', async () => {
    let fail = false;
    const fetchImpl = vi.fn(async () => { if (fail) throw new TypeError('down'); return new Response(JSON.stringify(doc(1, 1800)), { status: 200 }); });
    const feed = createAppearanceFeed(client(fetchImpl as unknown as typeof fetch));
    await feed.refresh();
    fail = true;
    await feed.refresh();
    expect(feed.get()).toMatchObject({ status: 'synced', preset: { settings: { count: 1800 } } });
  });
});
