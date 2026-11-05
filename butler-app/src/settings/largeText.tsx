/**
 * 「大字」开关(2026-09-16,Ben:手机上文字不明显):全局字号再放大 15%。
 * 落 Capacitor Preferences,单独一个键、单独一个文件——不进 settingsStore,免得和同时在跑的引导 / 粒子那几张卡改同一处。
 * 生效方式:<html data-ba-text="large">,styles.css 里 html 基准字号从 16px 变 18.4px,所有 rem 字号跟着走。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { preferencesStore, type KeyValueStore } from '../api/tokenStore';

export const LARGE_TEXT_KEY = 'butler.largeText';
export const LARGE_TEXT_ATTR = 'data-ba-text';
export const LARGE_TEXT_SCALE = 1.15;

export interface LargeTextStore {
  load(): Promise<boolean>;
  save(on: boolean): Promise<void>;
}

export function createLargeTextStore(kv: KeyValueStore): LargeTextStore {
  return {
    async load() {
      try { return (await kv.get(LARGE_TEXT_KEY)) === '1'; } catch { return false; }
    },
    async save(on) {
      try { await kv.set(LARGE_TEXT_KEY, on ? '1' : '0'); } catch { /* 存不了就只在内存里 */ }
    },
  };
}

/** 把开关写到 <html> 上;CSS 只认这个属性。 */
export function applyLargeText(on: boolean, root: Element | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (root === null) return;
  if (on) root.setAttribute(LARGE_TEXT_ATTR, 'large');
  else root.removeAttribute(LARGE_TEXT_ATTR);
}

export interface LargeTextHandle {
  on: boolean;
  set(on: boolean): Promise<void>;
}

export const LargeTextContext = createContext<LargeTextHandle>({ on: false, set: async () => {} });

export function useLargeText(): LargeTextHandle {
  return useContext(LargeTextContext);
}

/** 启动时读一次并应用;之后改开关立刻应用并落盘。 */
export function LargeTextProvider({ store, children }: { store?: LargeTextStore; children: ReactNode }) {
  const s = useMemo(() => store ?? createLargeTextStore(preferencesStore()), [store]);
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void s.load().then((v) => { if (!alive) return; setOn(v); applyLargeText(v); });
    return () => { alive = false; };
  }, [s]);
  const set = useCallback(async (v: boolean) => {
    setOn(v);
    applyLargeText(v);
    await s.save(v);
  }, [s]);
  const handle = useMemo(() => ({ on, set }), [on, set]);
  return <LargeTextContext.Provider value={handle}>{children}</LargeTextContext.Provider>;
}
