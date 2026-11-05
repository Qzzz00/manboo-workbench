// 电台桌面纯逻辑（无副作用，可测）：扫描结果规整、（Task 5 起）播放状态与扫描阶段。
export interface RadioTrack {
  id: string;
  uri: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
}

/** 原生播放服务状态快照（Task 4 起）。index=-1 表示无队列。 */
export interface PlaybackSnapshotRaw {
  playing: boolean;
  index: number;
  positionMs: number;
  durationMs: number;
  ended: boolean;
}

/** 原生扫描结果 → 规整 RadioTrack[]。缺 uri 的条目丢弃；缺字段给安全默认。 */
export function normalizeTracks(raw: unknown[]): RadioTrack[] {
  const out: RadioTrack[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const r = (item ?? {}) as Record<string, unknown>;
    const uri = typeof r.uri === 'string' && r.uri ? r.uri : '';
    if (!uri) continue;
    const dur = Number(r.durationMs);
    out.push({
      id: String(r.id ?? uri),
      uri,
      title: typeof r.title === 'string' && r.title ? r.title : '未知曲目',
      artist: typeof r.artist === 'string' ? r.artist : '',
      album: typeof r.album === 'string' ? r.album : '',
      durationMs: Number.isFinite(dur) && dur > 0 ? dur : 0,
    });
  }
  return out;
}

export interface PlaybackView {
  playing: boolean;
  track: RadioTrack | null;
  index: number;
  positionMs: number;
  durationMs: number;
  progress: number;
}

/** 原生播放快照 + 歌单 → UI 视图。任何异常输入回落空视图，绝不抛。 */
export function toPlaybackView(snap: PlaybackSnapshotRaw | null, tracks: RadioTrack[]): PlaybackView {
  const idx = snap && Number.isInteger(snap.index) ? snap.index : -1;
  const track = idx >= 0 && idx < tracks.length ? tracks[idx] : null;
  if (!snap || !track) {
    return { playing: false, track: null, index: -1, positionMs: 0, durationMs: 0, progress: 0 };
  }
  const durationMs = snap.durationMs > 0 ? snap.durationMs : track.durationMs;
  const positionMs = Math.max(0, snap.positionMs || 0);
  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  return { playing: !!snap.playing, track, index: idx, positionMs, durationMs, progress };
}

/** 播放视图用哪份列表解释 index：有队列快照用快照（setQueue 时冻结），否则回落扫描列表。 */
export function resolvePlaybackQueue(queueSnapshot: RadioTrack[], tracks: RadioTrack[]): RadioTrack[] {
  return queueSnapshot.length > 0 ? queueSnapshot : tracks;
}

export type ScanPhase = 'loading' | 'denied' | 'empty' | 'ready';

/** 扫描阶段状态机：loading（未查完）→ denied / empty / ready。 */
export function scanPhaseOf(opts: { checked: boolean; granted: boolean; count: number }): ScanPhase {
  if (!opts.checked) return 'loading';
  if (!opts.granted) return 'denied';
  return opts.count > 0 ? 'ready' : 'empty';
}

/** 毫秒 → m:ss。 */
export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
