/**
 * 更新完打开 App 那一句「已更新到 0.4.xx」(2026-10-03,卡 claude/phone-in-app-update 第 3 件)。
 *
 * 读 build.json 里那一格,与**上次记下的**比。一样、或者从没记过就一个字不说 ——
 * 头一回装上这个功能的那台手机不该被恭喜一次。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PHONE_LAST_VERSION_KEY, UpdatedToast } from '../src/update/UpdatedToast';
import { resetPhoneBuildStampCache } from '../src/update/buildStamp';
import type { KeyValueStore } from '../src/api/tokenStore';

function memory(seed?: string): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (seed !== undefined) data.set(PHONE_LAST_VERSION_KEY, seed);
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function stampFetch(version: string | null): typeof fetch {
  return (async () => (version === null
    ? new Response('', { status: 404 })
    : new Response(JSON.stringify({ butler_app_tree: 'd'.repeat(40), built_at: '2026-10-03T06:08:50.842Z', dirty: false, version, version_code: 1 }), { status: 200 }))) as typeof fetch;
}

async function mount(seed: string | undefined, version: string | null) {
  resetPhoneBuildStampCache();
  const kv = memory(seed);
  render(<UpdatedToast kv={kv} fetchImpl={stampFetch(version)} />);
  await act(async () => {});
  return kv;
}

describe('已更新到 那一句', () => {
  it('★上次记的是 0.4.90、这个包是 0.4.91:说一句,并把新的记下来', async () => {
    const kv = await mount('0.4.90', '0.4.91');
    expect(screen.getByText('已更新到 0.4.91')).toBeTruthy();
    expect(kv.data.get(PHONE_LAST_VERSION_KEY)).toBe('0.4.91');
  });

  it('★从没记过(头一回装上这个功能):一个字不说,但把这一版记下来', async () => {
    const kv = await mount(undefined, '0.4.91');
    expect(screen.queryByText(/已更新到/)).toBeNull();
    expect(kv.data.get(PHONE_LAST_VERSION_KEY)).toBe('0.4.91');
  });

  it('和上次一样:一个字不说', async () => {
    const kv = await mount('0.4.91', '0.4.91');
    expect(document.body.textContent).toBe('');
    expect(kv.data.get(PHONE_LAST_VERSION_KEY)).toBe('0.4.91');
  });

  it('★读不到 build.json(老包、浏览器里):一个字不说,也不记一个空版本号', async () => {
    const kv = await mount('0.4.90', null);
    expect(document.body.textContent).toBe('');
    expect(kv.data.get(PHONE_LAST_VERSION_KEY)).toBe('0.4.90');
  });

  it('装回了旧的一份:照实说旧,不说"已更新"', async () => {
    await mount('0.4.91', '0.4.90');
    expect(screen.getByText(/0\.4\.90/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('已更新到');
  });

  it('★点一下就收起来;不点也会自己收(它只是一句招呼)', async () => {
    vi.useFakeTimers();
    try {
      resetPhoneBuildStampCache();
      render(<UpdatedToast kv={memory('0.4.90')} fetchImpl={stampFetch('0.4.91')} dismissMs={5_000} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const line = screen.getByText('已更新到 0.4.91');
      await act(async () => { fireEvent.click(line); });
      expect(screen.queryByText('已更新到 0.4.91')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('不点的那条路:到点自己消失', async () => {
    vi.useFakeTimers();
    try {
      resetPhoneBuildStampCache();
      render(<UpdatedToast kv={memory('0.4.90')} fetchImpl={stampFetch('0.4.91')} dismissMs={5_000} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('已更新到 0.4.91')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
      expect(screen.queryByText('已更新到 0.4.91')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
