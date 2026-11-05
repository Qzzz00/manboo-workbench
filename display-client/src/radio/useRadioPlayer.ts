// 电台播放编排 hook：扫描/权限/队列/播放状态订阅。UI 状态全走 radioState 纯函数。
import { useCallback, useEffect, useRef, useState } from 'react';
import RadioLauncher, { type PlaybackSnapshotRaw } from '../lib/radioLauncherPlugin.ts';
import {
  normalizeTracks, toPlaybackView, scanPhaseOf, resolvePlaybackQueue,
  type PlaybackView, type RadioTrack, type ScanPhase,
} from './radioState.ts';

export function useRadioPlayer() {
  const [tracks, setTracks] = useState<RadioTrack[]>([]);
  const [checked, setChecked] = useState(false);
  const [granted, setGranted] = useState(false);
  const [snap, setSnap] = useState<PlaybackSnapshotRaw | null>(null);
  const [coverUrl, setCoverUrl] = useState('');
  const tracksRef = useRef<RadioTrack[]>([]);
  tracksRef.current = tracks;
  // setQueue 成功时冻结的队列快照：热插拔/重扫改变 tracks 后，仍用这份解释原生 snap.index，
  // 避免播放视图（曲名/封面）随扫描列表漂移而错位。见 radioState.resolvePlaybackQueue。
  const queueRef = useRef<RadioTrack[]>([]);

  const rescan = useCallback(async () => {
    try {
      const r = await RadioLauncher.scanAudio();
      setGranted(r.granted);
      setTracks(r.granted ? normalizeTracks(r.tracks) : []);
    } catch {
      setGranted(false);
      setTracks([]);
    }
    setChecked(true);
  }, []);

  // 首挂载：扫描 + 订阅播放状态 + 1s 进度轮询（灭屏节流无妨：原生播放不断，亮屏重同步）
  // + 订阅 SD 卡挂载/弹出（原生 2s 去抖后触发）→ 自动重扫曲库。
  useEffect(() => {
    void rescan();
    let removed = false;
    let sub: { remove: () => Promise<void> } | null = null;
    let mediaSub: { remove: () => Promise<void> } | null = null;
    RadioLauncher.addListener('playbackState', (s) => setSnap(s)).then((h) => {
      if (removed) void h.remove();
      else sub = h;
    }).catch(() => {});
    RadioLauncher.addListener('mediaChanged', () => void rescan()).then((h) => {
      if (removed) void h.remove();
      else mediaSub = h;
    }).catch(() => {});
    const timer = window.setInterval(() => {
      RadioLauncher.getPlaybackState().then(setSnap).catch(() => {});
    }, 1000);
    const onVis = () => { if (!document.hidden) RadioLauncher.getPlaybackState().then(setSnap).catch(() => {}); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      removed = true;
      void sub?.remove();
      void mediaSub?.remove();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [rescan]);

  const view: PlaybackView = toPlaybackView(snap, resolvePlaybackQueue(queueRef.current, tracks));
  const phase: ScanPhase = scanPhaseOf({ checked, granted, count: tracks.length });

  // 当前曲封面（懒加载，一曲一取）
  useEffect(() => {
    const id = view.track?.id;
    if (!id) { setCoverUrl(''); return; }
    let stale = false;
    RadioLauncher.getAlbumArt({ trackId: id }).then((r) => { if (!stale) setCoverUrl(r.dataUrl); }).catch(() => {});
    return () => { stale = true; };
  }, [view.track?.id]);

  // 记住播放态：当前曲 id 持久化，下次冷启恢复到这首。
  useEffect(() => {
    const id = view.track?.id;
    if (id) { try { localStorage.setItem('aiboo:radio-last-id', id); } catch { /* ignore */ } }
  }, [view.track?.id]);

  // 预加载：冷启扫描出歌后，若原生还没队列（index<0），自动建队列并续播上次那首（无需手动去歌单点歌）。
  // 只跑一次；原生已有队列在播（热重启保留）则不打扰。★setQueue 原生会自动 play()，即「电台开机续播」。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    if (!checked || !granted || tracks.length === 0) return;
    if (snap && snap.index >= 0) { restoredRef.current = true; return; }
    restoredRef.current = true;
    let idx = 0;
    try {
      const saved = localStorage.getItem('aiboo:radio-last-id');
      if (saved) { const i = tracks.findIndex((t) => t.id === saved); if (i >= 0) idx = i; }
    } catch { /* ignore */ }
    const list = tracks;
    void RadioLauncher.setQueue({
      tracks: list.map((t) => ({ uri: t.uri, title: t.title, artist: t.artist, album: t.album })),
      startIndex: idx,
      playWhenReady: false, // 冷启只恢复到上次那首并暂停待播（Ben：开机默认暂停，不自动播放）
    }).then(() => { queueRef.current = list; }).catch(() => {});
  }, [checked, granted, tracks, snap]);

  const playAt = useCallback(async (index: number) => {
    const list = tracksRef.current;
    if (!list.length) return;
    try {
      await RadioLauncher.setQueue({
        tracks: list.map((t) => ({ uri: t.uri, title: t.title, artist: t.artist, album: t.album })),
        startIndex: index,
      });
      // 冻结这份列表为队列快照，后续 snap.index 一律按它解释（不受之后重扫影响）。
      queueRef.current = list;
    } catch {
      // 静默失败：与其余原生调用一致，不打断 UI
    }
  }, []);

  const requestPermission = useCallback(async () => {
    await RadioLauncher.requestAudioPermission().catch(() => {});
    // 系统弹窗关闭后窗口重获焦点，visibilitychange/interval 已兜底；再主动补一次
    window.setTimeout(() => void rescan(), 1200);
  }, [rescan]);

  return {
    tracks, phase, view, coverUrl,
    actions: {
      rescan, requestPermission, playAt,
      toggle: () => RadioLauncher.playbackControl({ op: 'toggle' }).catch(() => {}),
      next: () => RadioLauncher.playbackControl({ op: 'next' }).catch(() => {}),
      prev: () => RadioLauncher.playbackControl({ op: 'prev' }).catch(() => {}),
    },
  };
}
