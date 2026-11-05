/**
 * 横屏展示台用哪一套(2026-10-01,维护者:「在设置里面新增一个展示台样式的选项,一个是现在这个,
 * 另一个是 Codex 新做的那个,选中哪个,横屏就显示哪个」)。
 *
 * 这是这台手机的显示偏好:落 Capacitor Preferences、单独一个键(同「大字」),不进 settingsStore、不经 8791。
 * 生效方式:DisplayPage 把它拼进展示台地址(`?layout=orbit`,display-client displayStage.ts `resolveDisplayLayout`)。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { preferencesStore, type KeyValueStore } from '../api/tokenStore';

export type DisplayStyle = 'classic' | 'orbit';

export const DISPLAY_STYLE_KEY = 'butler.displayStyle';

/** 设置里那两项。现在这套排第一、是缺省。 */
export const DISPLAY_STYLES: readonly { key: DisplayStyle; label: string; hint: string }[] = [
  { key: 'classic', label: '三栏(原来这套)', hint: '左边形象与黄历,中间按家列会话,右边时钟、音乐、额度' },
  { key: 'orbit', label: '环绕(新)', hint: '形象居中,会话卡在两侧,额度按账号铺在下面' },
];

export interface DisplayStyleStore {
  load(): Promise<DisplayStyle>;
  save(style: DisplayStyle): Promise<void>;
}

export function createDisplayStyleStore(kv: KeyValueStore): DisplayStyleStore {
  return {
    async load() {
      try { return (await kv.get(DISPLAY_STYLE_KEY)) === 'orbit' ? 'orbit' : 'classic'; } catch { return 'classic'; }
    },
    async save(style) {
      try { await kv.set(DISPLAY_STYLE_KEY, style); } catch { /* 存不了就只在这次生效 */ }
    },
  };
}

export interface DisplayStyleHandle {
  style: DisplayStyle;
  set(style: DisplayStyle): Promise<void>;
}

export const DisplayStyleContext = createContext<DisplayStyleHandle>({ style: 'classic', set: async () => {} });

export function useDisplayStyle(): DisplayStyleHandle {
  return useContext(DisplayStyleContext);
}

/** 启动时读一次;之后一改当场生效并落盘。 */
export function DisplayStyleProvider({ store, children }: { store?: DisplayStyleStore; children: ReactNode }) {
  const s = useMemo(() => store ?? createDisplayStyleStore(preferencesStore()), [store]);
  const [style, setStyle] = useState<DisplayStyle>('classic');
  useEffect(() => {
    let alive = true;
    void s.load().then((v) => { if (alive) setStyle(v); });
    return () => { alive = false; };
  }, [s]);
  const set = useCallback(async (v: DisplayStyle) => {
    setStyle(v);
    await s.save(v);
  }, [s]);
  const handle = useMemo(() => ({ style, set }), [style, set]);
  return <DisplayStyleContext.Provider value={handle}>{children}</DisplayStyleContext.Provider>;
}
