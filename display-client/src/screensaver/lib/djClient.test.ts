import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import {
  playableUrl,
  isUrlStale,
  streamUrl,
  DjPlayer,
  type DjItem,
} from './djClient';

function track(id: string, extra: Partial<DjItem> = {}): DjItem {
  return { kind: 'track', queue_item_id: id, duration_ms: 200000, song_url: `http://x/${id}.mp3`, ...extra };
}
function tts(id: string, extra: Partial<DjItem> = {}): DjItem {
  return { kind: 'tts', queue_item_id: id, duration_ms: 8000, audio_url: `http://x/${id}.wav`, ...extra };
}

describe('playableUrl / isUrlStale', () => {
  it('picks song_url for track, audio_url for tts', () => {
    expect(playableUrl(track('a'))).toBe('http://x/a.mp3');
    expect(playableUrl(tts('b'))).toBe('http://x/b.wav');
  });

  it('isUrlStale true within 60s of expiry', () => {
    const now = 1_000_000;
    expect(isUrlStale(track('a', { expires_at: new Date(now + 30_000).toISOString() }), now)).toBe(true);
    expect(isUrlStale(track('a', { expires_at: new Date(now + 120_000).toISOString() }), now)).toBe(false);
    expect(isUrlStale(track('a'), now)).toBe(false);
  });
});

describe('streamUrl', () => {
  it('track → backend proxy keyed by queue_item_id (ignores song_url)', () => {
    expect(streamUrl('http://h:3456', track('a b'))).toBe('http://h:3456/api/track/stream?id=a%20b');
  });

  it('tts relative audio_url → prefixed with base', () => {
    const item: DjItem = { kind: 'tts', queue_item_id: 't', duration_ms: 1000, audio_url: '/uploads/tts/x.mp3' };
    expect(streamUrl('http://h:3456', item)).toBe('http://h:3456/uploads/tts/x.mp3');
  });

  it('tts absolute audio_url → unchanged', () => {
    const item: DjItem = { kind: 'tts', queue_item_id: 't', duration_ms: 1000, audio_url: 'https://cdn/x.mp3' };
    expect(streamUrl('http://h:3456', item)).toBe('https://cdn/x.mp3');
  });

  it('tts without audio_url → undefined', () => {
    const item: DjItem = { kind: 'tts', queue_item_id: 't', duration_ms: 1000 };
    expect(streamUrl('http://h:3456', item)).toBeUndefined();
  });
});

// ---- 音乐卡死看门狗:流中途断时 <audio> 无 ended 无 error,靠进度检测切歌 ----

class FakeAudio {
  crossOrigin: string | null = null;
  preload = '';
  src = '';
  loop = false;
  volume = 1;
  currentTime = 0;
  paused = false;
  ended = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play() {
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener() {}
  removeEventListener() {}
}

describe('DjPlayer stall watchdog', () => {
  let audios: FakeAudio[];
  let onEnded: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    audios = [];
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor() {
          super();
          audios.push(this);
        }
      },
    );
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
    });
    onEnded = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function startPlayer(): Promise<FakeAudio> {
    const player = new DjPlayer(
      () => {},
      () => onEnded(),
    );
    await player.playTrack('http://h/api/track/stream?id=x');
    return audios[0]; // 构造顺序:music 是第一个 Audio
  }

  it('非暂停且 currentTime 连续无进展 → 视同播完切歌', async () => {
    const music = await startPlayer();
    music.currentTime = 42; // 播放中
    await vi.advanceTimersByTimeAsync(5000); // tick1: 建基线
    await vi.advanceTimersByTimeAsync(5000); // tick2: 无进展 strike1
    expect(onEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); // tick3: strike2 → 触发
    expect(onEnded).toHaveBeenCalledTimes(1);
    // 触发后 watchdog 已清:不再重复
    await vi.advanceTimersByTimeAsync(30000);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('正常推进不误切', async () => {
    const music = await startPlayer();
    music.currentTime = 1;
    for (let i = 0; i < 8; i += 1) {
      music.currentTime += 5;
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('暂停中不误切', async () => {
    const music = await startPlayer();
    music.currentTime = 42;
    music.paused = true;
    await vi.advanceTimersByTimeAsync(40000);
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('currentTime=0(起播未成功)不空切,留给整首兜底', async () => {
    const music = await startPlayer();
    music.currentTime = 0;
    await vi.advanceTimersByTimeAsync(40000);
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('真 ended 触发一次并清掉 watchdog', async () => {
    const music = await startPlayer();
    music.currentTime = 42;
    music.ended = true;
    music.onended?.();
    expect(onEnded).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40000);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});
