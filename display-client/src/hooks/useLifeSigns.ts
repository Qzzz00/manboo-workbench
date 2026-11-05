import { useEffect, useState } from 'react';
import { getLifeSigns, subscribeLifeSigns, LIFE_SIGNS_CHANGE_EVENT } from '../lib/journeyStore.ts';
import type { JourneyLifeSigns } from '../types/journey.ts';

export interface LifeSignsSnapshot {
  model_id?: string;
  wardrobe_item_id?: string;
  background_id?: string;
  state_id?: string;
  location_id?: string;
  /** 动态场景背景（ALL-414）：当前/目标场景 key，随 background_id 一起下发 */
  scene_key?: string;
  /** SSE 推送携带的来源角色 id（用于过滤非当前角色的背景下发）；快照路径无此字段 */
  avatarId?: string;
}

function normalize(lifeSigns: JourneyLifeSigns): LifeSignsSnapshot {
  return {
    model_id: lifeSigns.model_id,
    wardrobe_item_id: lifeSigns.wardrobe_item_id,
    background_id: lifeSigns.background_id,
    state_id: lifeSigns.state_id,
    location_id: lifeSigns.location_id,
    scene_key: lifeSigns.scene_key,
    avatarId: lifeSigns.avatarId,
  };
}

/**
 * 读取并订阅 journeyStore 中的生命迹象。
 * 同时监听同窗口自定义事件、跨窗口 storage 事件，并以 2 秒轮询兜底，
 * 保证 journey runtime 更新后能立即反映到 UI。
 */
export function useLifeSigns(): LifeSignsSnapshot {
  const [snapshot, setSnapshot] = useState<LifeSignsSnapshot>(() => normalize(getLifeSigns()));

  useEffect(() => {
    let cancelled = false;

    function sync() {
      if (cancelled) return;
      setSnapshot(normalize(getLifeSigns()));
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === 'aiboo-journey-state') sync();
    }

    function handleCustom(event: Event) {
      const detail = (event as CustomEvent<JourneyLifeSigns | undefined>).detail;
      if (detail) {
        setSnapshot(normalize(detail));
      } else {
        sync();
      }
    }

    const unsubscribe = subscribeLifeSigns(sync);
    window.addEventListener(LIFE_SIGNS_CHANGE_EVENT, handleCustom);
    window.addEventListener('storage', handleStorage);

    const interval = window.setInterval(sync, 2000);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener(LIFE_SIGNS_CHANGE_EVENT, handleCustom);
      window.removeEventListener('storage', handleStorage);
      window.clearInterval(interval);
    };
  }, []);

  return snapshot;
}
