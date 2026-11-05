import { useCallback, useEffect, useRef, useState } from 'react';
import { getServerBaseUrl } from '../screensaver/lib/serverConfig';

// DJ 模式配置（与后端 server/dj/modeConfig.cjs 对齐）：专注番茄时长 + 休息哄睡开关。
// 后端是真源，前端用 localStorage 兜底首屏（离线/请求中先用上次值，避免闪烁）。
export interface DjModeConfig {
  focus: { pomodoroMin: number };
  rest: { lullaby: boolean };
  commute: { interests: string };
}

const DEFAULTS: DjModeConfig = {
  focus: { pomodoroMin: 25 },
  rest: { lullaby: false },
  commute: { interests: '' },
};

const LS_KEY = 'aiboo:dj-mode-config';

function loadCache(): DjModeConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULTS;
}

function saveCache(cfg: DjModeConfig) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

/**
 * 拉取/回写 DJ 模式配置。`active` 为 false 时不发请求（退出 DJ 即停）。
 * setter 乐观更新本地，再 POST 后端；失败保留本地值（下次进 DJ 再同步）。
 */
export function useDjModeConfig(active: boolean) {
  const [config, setConfig] = useState<DjModeConfig>(loadCache);
  const baseRef = useRef(getServerBaseUrl());

  useEffect(() => {
    if (!active) return;
    const base = baseRef.current;
    if (!base) return;
    let closed = false;
    fetch(`${base}/api/dj/mode-config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: DjModeConfig | null) => {
        if (closed || !data) return;
        setConfig(data);
        saveCache(data);
      })
      .catch(() => {
        /* 离线：用 localStorage 缓存即可 */
      });
    return () => {
      closed = true;
    };
  }, [active]);

  const patch = useCallback((partial: Partial<DjModeConfig>) => {
    setConfig((prev) => {
      const next: DjModeConfig = {
        focus: { ...prev.focus, ...partial.focus },
        rest: { ...prev.rest, ...partial.rest },
        commute: { ...prev.commute, ...partial.commute },
      };
      saveCache(next);
      const base = baseRef.current;
      if (base) {
        fetch(`${base}/api/dj/mode-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(partial),
        }).catch(() => {
          /* 回写失败：本地已更新，下次进 DJ 再同步 */
        });
      }
      return next;
    });
  }, []);

  const setPomodoroMin = useCallback((min: number) => patch({ focus: { pomodoroMin: min } }), [patch]);
  const setLullaby = useCallback((on: boolean) => patch({ rest: { lullaby: on } }), [patch]);

  return {
    pomodoroMin: config.focus.pomodoroMin,
    lullaby: config.rest.lullaby,
    setPomodoroMin,
    setLullaby,
  };
}
