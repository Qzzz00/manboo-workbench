import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { applyLargeText, createLargeTextStore, LARGE_TEXT_ATTR, LARGE_TEXT_KEY, LargeTextProvider, useLargeText } from '../src/settings/largeText';
import type { KeyValueStore } from '../src/api/tokenStore';

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function Toggle() {
  const { on, set } = useLargeText();
  return <label><input type="checkbox" checked={on} onChange={(e) => { void set(e.target.checked); }} />大字</label>;
}

describe('大字开关', () => {
  it('缺省关;存 1 读回开;坏值当关', async () => {
    const kv = memory();
    const store = createLargeTextStore(kv);
    expect(await store.load()).toBe(false);
    await store.save(true);
    expect(kv.data.get(LARGE_TEXT_KEY)).toBe('1');
    expect(await store.load()).toBe(true);
    kv.data.set(LARGE_TEXT_KEY, 'yes');
    expect(await store.load()).toBe(false);
  });
  it('存取层抛错不影响使用', async () => {
    const broken: KeyValueStore = { async get() { throw new Error('x'); }, async set() { throw new Error('x'); }, async remove() {} };
    const store = createLargeTextStore(broken);
    expect(await store.load()).toBe(false);
    await expect(store.save(true)).resolves.toBeUndefined();
  });
  it('applyLargeText 在 <html> 上加 / 去 data-ba-text="large"', () => {
    const root = document.createElement('div');
    applyLargeText(true, root);
    expect(root.getAttribute(LARGE_TEXT_ATTR)).toBe('large');
    applyLargeText(false, root);
    expect(root.hasAttribute(LARGE_TEXT_ATTR)).toBe(false);
  });
  it('Provider:启动读盘并应用;切开关立刻生效并落盘;重开还记得', async () => {
    document.documentElement.removeAttribute(LARGE_TEXT_ATTR);
    const kv = memory();
    const store = createLargeTextStore(kv);
    const first = render(<LargeTextProvider store={store}><Toggle /></LargeTextProvider>);
    await act(async () => {});
    expect(document.documentElement.hasAttribute(LARGE_TEXT_ATTR)).toBe(false);
    await act(async () => { fireEvent.click(screen.getByLabelText('大字')); });
    expect(document.documentElement.getAttribute(LARGE_TEXT_ATTR)).toBe('large');
    expect(kv.data.get(LARGE_TEXT_KEY)).toBe('1');
    first.unmount();
    document.documentElement.removeAttribute(LARGE_TEXT_ATTR);
    // 「重开 App」:新 Provider 从同一个盘读
    render(<LargeTextProvider store={createLargeTextStore(kv)}><Toggle /></LargeTextProvider>);
    await act(async () => {});
    expect((screen.getByLabelText('大字') as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.getAttribute(LARGE_TEXT_ATTR)).toBe('large');
    document.documentElement.removeAttribute(LARGE_TEXT_ATTR);
  });
});
