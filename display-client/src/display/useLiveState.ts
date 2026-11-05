/**
 * 把 liveStore 接进 React。接线逻辑全在 liveStore.ts（那边有测试），这里只做订阅。
 * 来电铃声（来电链 v0）也在这里挂上：铃跟着 store 的响铃集合走（ringer.ts，有测试），
 * 出声走原生桥（nativeRingtone.ts）。
 */
import { useEffect, useState } from 'react';
import { createLiveStore, resolveWorkbenchUrl, workbenchFallbackUrl, type LiveSnapshot, type WebSocketLike } from './liveStore';
import { attachRinger } from './ringer';
import { createNativeRinger } from './nativeRingtone';
import { emptyState, type WorkbenchState } from './workbenchProtocol';
import { listenHost, type HostAvatarItem } from './hostFeed';
import { resolveWorkbenchToken, withWorkbenchToken } from './workbenchToken';

export interface UseLiveStateOptions {
  url?: string;
  socketFactory?: (url: string) => WebSocketLike;
  /**
   * 不自己连(2026-09-30):手机壳递状态进来的那条路(`?feed=host`,见 hostFeed.ts)用不着这条 WS,
   * 也**不挂铃** —— 手机有自己的来电页,展示台再响一遍就是两份铃。
   */
  disabled?: boolean;
}

/** 工作台 /live 的地址(不带令牌)。地址优先级见 useLiveState 里的注释;配对框也用它。 */
export function resolveLiveUrl(): string {
  return resolveWorkbenchUrl(
    typeof window === 'undefined' ? '' : window.location.search,
    workbenchFallbackUrl(import.meta.env as { VITE_WORKBENCH_URL?: string }),
  );
}

function safeStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

const INITIAL: LiveSnapshot = { state: emptyState(), ringing: new Set(), connected: false };

export function useLiveState(options: UseLiveStateOptions = {}): LiveSnapshot {
  const [snapshot, setSnapshot] = useState<LiveSnapshot>(INITIAL);

  useEffect(() => {
    if (options.disabled === true) return;
    // 地址优先级：显式传入 > 查询串 ?workbench= > 构建期 VITE_WORKBENCH_URL > 本机 8791。
    // 展示台是 kiosk 启动、没有查询串，靠的就是构建期那一档（见 workbenchFallbackUrl）。
    // 2026-09-11 起非本机来源的 /live 要设备令牌(?token=,浏览器 WebSocket 设不了请求头);
    // 本机地址不带。令牌来源与存法见 workbenchToken.ts。
    const url = options.url
      ?? withWorkbenchToken(
        resolveLiveUrl(),
        resolveWorkbenchToken(typeof window === 'undefined' ? '' : window.location.search, safeStorage()),
      );
    const factory = options.socketFactory
      ?? ((target: string) => new WebSocket(target) as unknown as WebSocketLike);

    const store = createLiveStore({ url, socketFactory: factory });
    setSnapshot(store.get());
    const unsubscribe = store.subscribe(() => setSnapshot(store.get()));
    const detachRinger = attachRinger(store, createNativeRinger());

    return () => {
      detachRinger();
      unsubscribe();
      store.stop();
    };
  }, [options.url, options.socketFactory, options.disabled]);

  return snapshot;
}

/**
 * 手机壳递进来的那一份(2026-09-30,见 hostFeed.ts)。`enabled` 为假时什么都不挂。
 * `state` 在收到第一份快照之前是 null(调用方拿空快照顶着,`stale` 说实话)。
 */
export interface HostFeedView {
  state: WorkbenchState | null;
  settings: Record<string, number> | null;
  /** 形象队列 + 当前选择(2026-10-01)。壳还没递过来是 null(那就只有粒子球)。 */
  avatars: { items: HostAvatarItem[]; current: string } | null;
  /** 各家 logo(登记表 id → data:image)。壳没递过来是空的,那就画色点。 */
  icons: Record<string, string>;
}

export function useHostFeed(enabled: boolean): HostFeedView {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [settings, setSettings] = useState<Record<string, number> | null>(null);
  const [avatars, setAvatars] = useState<HostFeedView['avatars']>(null);
  const [icons, setIcons] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!enabled) return;
    return listenHost((message) => {
      if (message.kind === 'snapshot') setState(message.state);
      else if (message.kind === 'appearance') setSettings(message.settings);
      else if (message.kind === 'icons') setIcons((prev) => (JSON.stringify(prev) === JSON.stringify(message.icons) ? prev : message.icons));
      // 壳每次状态刷新都会重发一遍队列;内容没变就不换引用 —— 换了会让形象舞台以为换了一份、打断正在加载的模型。
      else setAvatars((prev) => {
        const next = { items: message.items, current: message.current };
        return prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
    });
  }, [enabled]);
  return { state, settings, avatars, icons };
}
