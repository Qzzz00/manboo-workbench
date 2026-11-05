/**
 * 把 appearanceFeed 接进 React(2026-09-22)。逻辑全在 appearanceFeed.ts(那边有测试),
 * 这里只做「开机拉一次 + 版本变了再拉一次」——与手机端 `AppearanceFeed.notice(version)` 同一条规矩。
 *
 * `appearance_version` 跟着 `/live` 的快照一起来(工作台 composeState 里那一个字段),
 * 所以 Mac 上一拖滑杆、展示台上的球**当场**跟着变,不用刷新这块屏。
 */
import { useEffect, useRef, useState } from 'react';
import { defaultSettings, fetchAppearance, type AppearanceResult } from './appearanceFeed';
import { resolveWorkbenchToken } from './workbenchToken';

function safeStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

export function useDisplayAppearance(wsUrl: string, appearanceVersion: number | undefined): AppearanceResult {
  const [result, setResult] = useState<AppearanceResult>(() => ({ status: 'default', settings: defaultSettings() }));
  /** 已经按这个版本拉过了就不再拉(快照几秒一条,不能每条都打一次 HTTP)。 */
  const seen = useRef<number | 'never'>('never');

  useEffect(() => {
    if (seen.current !== 'never' && seen.current === appearanceVersion) return;
    seen.current = appearanceVersion ?? -1;
    const controller = new AbortController();
    let alive = true;
    void fetchAppearance({
      wsUrl,
      token: resolveWorkbenchToken(typeof window === 'undefined' ? '' : window.location.search, safeStorage()),
      signal: controller.signal,
    }).then((next) => { if (alive) setResult(next); });
    return () => { alive = false; controller.abort(); };
  }, [wsUrl, appearanceVersion]);

  return result;
}
