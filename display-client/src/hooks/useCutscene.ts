import { useCallback, useEffect, useState } from 'react';
import { fetchPendingCutscenes, type PendingCutscene } from '../lib/cutsceneApi.ts';

// 管理某角色的待播演出：进角色时拉 pending → 浮换挡卡；open 进播放；finish/dismiss 收起。
// complete 的服务端回写 + 形象应用由 App 在 CutsceneScene.onComplete 里做（那里有 presence）。
export function useCutscene(avatarId: string | undefined) {
  const [pending, setPending] = useState<PendingCutscene | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let alive = true;
    setPending(null);
    setPlaying(false);
    if (!avatarId) return;
    fetchPendingCutscenes(avatarId)
      .then((list) => { if (alive) setPending(list[0] ?? null); })
      .catch(() => { /* 无 pending / 未登录：静默 */ });
    return () => { alive = false; };
  }, [avatarId]);

  const open = useCallback(() => setPlaying(true), []);
  const dismiss = useCallback(() => setPending(null), []);
  const finish = useCallback(() => { setPlaying(false); setPending(null); }, []);

  return { pending, playing, open, dismiss, finish };
}
