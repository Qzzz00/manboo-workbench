import { describe, it, expect } from 'vitest';
import { normalizeTracks, toPlaybackView, scanPhaseOf, fmtTime, resolvePlaybackQueue, type RadioTrack } from './radioState.ts';

const T = (id: string): RadioTrack => ({ id, uri: `content://x/${id}`, title: `t${id}`, artist: '', album: '', durationMs: 60000 });

describe('normalizeTracks', () => {
  it('完整字段原样映射', () => {
    expect(
      normalizeTracks([{ id: 7, uri: 'content://x/7', title: 'T', artist: 'A', album: 'B', durationMs: 1234 }])
    ).toEqual([{ id: '7', uri: 'content://x/7', title: 'T', artist: 'A', album: 'B', durationMs: 1234 }]);
  });
  it('脏数据防御：缺 title 用 <unknown>，duration 非数→0，缺 uri 整条丢弃', () => {
    const out = normalizeTracks([
      { id: 1, uri: 'content://x/1', artist: '', durationMs: 'x' },
      { id: 2, title: '没uri' },
    ]);
    expect(out).toEqual([{ id: '1', uri: 'content://x/1', title: '未知曲目', artist: '', album: '', durationMs: 0 }]);
  });
});

describe('toPlaybackView', () => {
  it('正常快照映射当前曲与进度', () => {
    const v = toPlaybackView({ playing: true, index: 1, positionMs: 30000, durationMs: 60000, ended: false }, [T('1'), T('2')]);
    expect(v.track?.id).toBe('2');
    expect(v.progress).toBeCloseTo(0.5);
    expect(v.playing).toBe(true);
  });
  it('null 快照/index=-1/越界 → 空视图', () => {
    for (const snap of [null, { playing: false, index: -1, positionMs: 0, durationMs: 0, ended: false }, { playing: false, index: 9, positionMs: 0, durationMs: 0, ended: false }]) {
      const v = toPlaybackView(snap as never, [T('1')]);
      expect(v.track).toBeNull();
      expect(v.progress).toBe(0);
    }
  });
  it('durationMs=0 时用曲目时长兜底', () => {
    const v = toPlaybackView({ playing: true, index: 0, positionMs: 15000, durationMs: 0, ended: false }, [T('1')]);
    expect(v.durationMs).toBe(60000);
    expect(v.progress).toBeCloseTo(0.25);
  });
  it('positionMs 超过 durationMs 时 progress 钳制到 1', () => {
    const v = toPlaybackView({ playing: true, index: 0, positionMs: 70000, durationMs: 60000, ended: false }, [T('1')]);
    expect(v.progress).toBe(1);
  });
});

describe('scanPhaseOf', () => {
  it('四态判定', () => {
    expect(scanPhaseOf({ checked: false, granted: false, count: 0 })).toBe('loading');
    expect(scanPhaseOf({ checked: true, granted: false, count: 0 })).toBe('denied');
    expect(scanPhaseOf({ checked: true, granted: true, count: 0 })).toBe('empty');
    expect(scanPhaseOf({ checked: true, granted: true, count: 3 })).toBe('ready');
  });
});

describe('fmtTime', () => {
  it('毫秒转 m:ss', () => {
    expect(fmtTime(0)).toBe('0:00');
    expect(fmtTime(61000)).toBe('1:01');
    expect(fmtTime(NaN)).toBe('0:00');
    expect(fmtTime(-5)).toBe('0:00');
  });
});

describe('resolvePlaybackQueue', () => {
  it('队列快照非空时用快照解释 index（重扫后列表变了，index 仍指旧队列曲目）', () => {
    const queueSnapshot = [T('1'), T('2')];
    const rescannedTracks = [T('9'), T('1'), T('2')]; // 重扫后顺序变化、多了新曲目
    expect(resolvePlaybackQueue(queueSnapshot, rescannedTracks)).toBe(queueSnapshot);
  });
  it('队列快照为空时回落扫描列表', () => {
    const tracks = [T('1'), T('2')];
    expect(resolvePlaybackQueue([], tracks)).toBe(tracks);
  });
});
