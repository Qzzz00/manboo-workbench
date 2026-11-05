import { describe, it, expect, vi } from 'vitest';
import { executeRadioAction } from './radioVoiceExecutor.ts';
import type { HoloAction } from '../holo/holoIntent.ts';

// 不显式标注 `RadioVoiceDeps & { playback: ReturnType<typeof vi.fn>; ... }`：
// `ReturnType<typeof vi.fn>` 对泛型函数类型提取时会退化到约束 `Procedure | Constructable`
// 而非默认值 `Procedure`（TS 已知行为），导致赋值期不匹配；直接推断类型可规避且不影响运行时断言。
function makeDeps(playing = true) {
  return {
    playback: vi.fn(),
    setVolume: vi.fn(),
    adjustVolume: vi.fn(),
    isPlaying: () => playing,
    openApp: vi.fn(),
  };
}

describe('executeRadioAction', () => {
  it('dj.next/prev/playPause → playback', () => {
    const d = makeDeps();
    executeRadioAction({ type: 'dj.next' }, d);
    executeRadioAction({ type: 'dj.prev' }, d);
    executeRadioAction({ type: 'dj.playPause' }, d);
    expect(d.playback.mock.calls).toEqual([['next'], ['prev'], ['toggle']]);
  });
  it('dj.pause 仅在播放中才 toggle', () => {
    const playingDeps = makeDeps(true);
    executeRadioAction({ type: 'dj.pause' }, playingDeps);
    expect(playingDeps.playback).toHaveBeenCalledWith('toggle');
    const pausedDeps = makeDeps(false);
    executeRadioAction({ type: 'dj.pause' }, pausedDeps);
    expect(pausedDeps.playback).not.toHaveBeenCalled();
  });
  it('dj.play 仅在暂停中才 toggle', () => {
    const pausedDeps = makeDeps(false);
    executeRadioAction({ type: 'dj.play' }, pausedDeps);
    expect(pausedDeps.playback).toHaveBeenCalledWith('toggle');
    const playingDeps = makeDeps(true);
    executeRadioAction({ type: 'dj.play' }, playingDeps);
    expect(playingDeps.playback).not.toHaveBeenCalled();
  });
  it('volume.delta/set → 音量调用', () => {
    const d = makeDeps();
    executeRadioAction({ type: 'volume.delta', delta: 0.1 }, d);
    executeRadioAction({ type: 'volume.set', value: 0.5 }, d);
    expect(d.adjustVolume).toHaveBeenCalledWith(0.1);
    expect(d.setVolume).toHaveBeenCalledWith(0.5);
  });
  it('open_app → 交宿主 deps.openApp(原始名字) 解析', () => {
    const d = makeDeps();
    executeRadioAction({ type: 'open_app', name: '七猫' }, d);
    expect(d.openApp).toHaveBeenCalledWith('七猫');
  });
  it('holo 专属动作(setMode/pomodoro/chat) → no-op', () => {
    const d = makeDeps();
    executeRadioAction({ type: 'dj.setMode', mode: 'focus' } as HoloAction, d);
    executeRadioAction({ type: 'pomodoro.pause' } as HoloAction, d);
    executeRadioAction({ type: 'chat', text: 'hi' } as HoloAction, d);
    expect(d.playback).not.toHaveBeenCalled();
    expect(d.setVolume).not.toHaveBeenCalled();
    expect(d.adjustVolume).not.toHaveBeenCalled();
    expect(d.openApp).not.toHaveBeenCalled();
  });
});
