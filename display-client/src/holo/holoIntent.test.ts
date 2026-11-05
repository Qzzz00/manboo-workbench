import { describe, expect, it } from 'vitest';
import { HOLO_CONTROLS, type HoloControl } from './holoControl';
import {
  clampVolume,
  gestureToIntent,
  holoEventToIntent,
  playbackIntent,
  resolveIntent,
  VOLUME_STEP,
  type HoloAction,
} from './holoIntent';

describe('resolveIntent — playback（语音白名单 → dj 动作）', () => {
  it('每个 HoloControl 都翻成正确的 dj 动作', () => {
    const cases: Array<[HoloControl, HoloAction]> = [
      ['next', { type: 'dj.next' }],
      ['prev', { type: 'dj.prev' }],
      ['playPause', { type: 'dj.playPause' }],
      ['mode:focus', { type: 'dj.setMode', mode: 'focus' }],
      ['mode:commute', { type: 'dj.setMode', mode: 'commute' }],
    ];
    for (const [control, action] of cases) {
      expect(resolveIntent({ kind: 'playback', control })).toEqual(action);
    }
  });

  it('覆盖整张白名单：没有任何 HoloControl 漏映射（漏了 assertNever 会抛）', () => {
    for (const c of HOLO_CONTROLS) {
      expect(() => resolveIntent(playbackIntent(c))).not.toThrow();
    }
  });
});

describe('resolveIntent — volume（相对增减 + 绝对设定）', () => {
  it('相对 up/down 映射到 ±VOLUME_STEP 的 delta', () => {
    expect(resolveIntent({ kind: 'volume', dir: 'up' })).toEqual({ type: 'volume.delta', delta: VOLUME_STEP });
    expect(resolveIntent({ kind: 'volume', dir: 'down' })).toEqual({ type: 'volume.delta', delta: -VOLUME_STEP });
  });

  it('绝对 set 在区间内原样透传', () => {
    expect(resolveIntent({ kind: 'volume', set: 0.5 })).toEqual({ type: 'volume.set', value: 0.5 });
    expect(resolveIntent({ kind: 'volume', set: 0 })).toEqual({ type: 'volume.set', value: 0 });
    expect(resolveIntent({ kind: 'volume', set: 1 })).toEqual({ type: 'volume.set', value: 1 });
  });

  it('绝对 set 越界被 clamp 回 [0,1]', () => {
    expect(resolveIntent({ kind: 'volume', set: 1.7 })).toEqual({ type: 'volume.set', value: 1 });
    expect(resolveIntent({ kind: 'volume', set: -0.3 })).toEqual({ type: 'volume.set', value: 0 });
  });
});

describe('resolveIntent — pomodoro & chat', () => {
  it('番茄 ack → pomodoro.ack', () => {
    expect(resolveIntent({ kind: 'pomodoro', action: 'ack' })).toEqual({ type: 'pomodoro.ack' });
  });

  it('番茄 set 意图/语音带参指令 → pomodoro.setMinutes', () => {
    expect(resolveIntent({ kind: 'pomodoro', action: 'set', minutes: 25 })).toEqual({ type: 'pomodoro.setMinutes', minutes: 25 });
    expect(resolveIntent(playbackIntent('pomodoro:set:25'))).toEqual({ type: 'pomodoro.setMinutes', minutes: 25 });
  });

  it('chat 原样带上文本兜底给 LLM', () => {
    expect(resolveIntent({ kind: 'chat', text: '今天天气怎么样' })).toEqual({ type: 'chat', text: '今天天气怎么样' });
    expect(resolveIntent({ kind: 'chat', text: '' })).toEqual({ type: 'chat', text: '' });
  });
});

describe('clampVolume（音量夹到 [0,1]）', () => {
  it('区间内不动，越界夹边界，非法值兜底', () => {
    expect(clampVolume(0.42)).toBe(0.42);
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(1)).toBe(1);
    expect(clampVolume(2)).toBe(1); // 超上界 → 1
    expect(clampVolume(-5)).toBe(0); // 低于下界 → 0
    expect(clampVolume(Infinity)).toBe(1); // +∞ 自然夹到上界
    expect(clampVolume(-Infinity)).toBe(0); // -∞ 自然夹到下界
    expect(clampVolume(NaN)).toBe(0); // NaN 兜底静音
  });
});

describe('playbackIntent（HoloControl 包成 intent）', () => {
  it('包装出正确的 playback 意图', () => {
    expect(playbackIntent('next')).toEqual({ kind: 'playback', control: 'next' });
    expect(playbackIntent('mode:focus')).toEqual({ kind: 'playback', control: 'mode:focus' });
  });

  it('经 resolveIntent 往返到正确动作', () => {
    expect(resolveIntent(playbackIntent('playPause'))).toEqual({ type: 'dj.playPause' });
    expect(resolveIntent(playbackIntent('mode:commute'))).toEqual({ type: 'dj.setMode', mode: 'commute' });
  });
});

describe('gestureToIntent（Stackchan 手势接缝：纯查表）', () => {
  it('命中的手势映射到对应意图', () => {
    expect(gestureToIntent('pinch')).toEqual({ kind: 'volume', dir: 'down' });
    expect(gestureToIntent('swipe_left')).toEqual({ kind: 'playback', control: 'prev' });
    expect(gestureToIntent('swipe_right')).toEqual({ kind: 'playback', control: 'next' });
    expect(gestureToIntent('open_palm')).toEqual({ kind: 'playback', control: 'playPause' });
  });

  it('未知手势 → null', () => {
    expect(gestureToIntent('moonwalk')).toBeNull();
    expect(gestureToIntent('')).toBeNull();
  });

  it('端到端：手势 → 意图 → 动作串起来', () => {
    const intent = gestureToIntent('swipe_right');
    expect(intent).not.toBeNull();
    expect(resolveIntent(intent!)).toEqual({ type: 'dj.next' });
    expect(resolveIntent(gestureToIntent('pinch')!)).toEqual({ type: 'volume.delta', delta: -VOLUME_STEP });
  });
});

describe('holoEventToIntent（桥事件流：手势+语音统一入口）', () => {
  it('gesture 事件走手势查表', () => {
    expect(holoEventToIntent({ kind: 'gesture', value: 'swipe_right' })).toEqual({
      kind: 'playback',
      control: 'next',
    });
    expect(holoEventToIntent({ kind: 'gesture', value: 'moonwalk' })).toBeNull();
  });

  it('utterance 事件兜底进 LLM 对话（chat 意图）', () => {
    expect(holoEventToIntent({ kind: 'utterance', value: '下一首' })).toEqual({ kind: 'chat', text: '下一首' });
    expect(holoEventToIntent({ kind: 'utterance', value: '  今天天气怎么样  ' })).toEqual({
      kind: 'chat',
      text: '今天天气怎么样',
    });
  });

  it('空转写 / 未知 kind → null', () => {
    expect(holoEventToIntent({ kind: 'utterance', value: '   ' })).toBeNull();
    expect(holoEventToIntent({ kind: 'telemetry', value: 'x' })).toBeNull();
  });
});

describe('隔空手势扩展（Stackchan 摄像头 + 摸头）', () => {
  it('上/下挥 = 音量加/减', () => {
    expect(gestureToIntent('swipe_up')).toEqual({ kind: 'volume', dir: 'up' });
    expect(gestureToIntent('swipe_down')).toEqual({ kind: 'volume', dir: 'down' });
    expect(resolveIntent(gestureToIntent('swipe_up')!)).toEqual({ type: 'volume.delta', delta: VOLUME_STEP });
  });

  it('摸头 = 番茄闹钟确认', () => {
    expect(gestureToIntent('head_pat')).toEqual({ kind: 'pomodoro', action: 'ack' });
    expect(resolveIntent(gestureToIntent('head_pat')!)).toEqual({ type: 'pomodoro.ack' });
  });
});

describe('手型手势（视觉大脑：拳=暂停/掌=播放）', () => {
  it('fist/palm 映射到明确的 pause/play 控制', () => {
    expect(gestureToIntent('fist')).toEqual({ kind: 'playback', control: 'pause' });
    expect(gestureToIntent('palm')).toEqual({ kind: 'playback', control: 'play' });
  });

  it('pause/play 解析为专属动作（非 toggle）', () => {
    expect(resolveIntent(gestureToIntent('fist')!)).toEqual({ type: 'dj.pause' });
    expect(resolveIntent(gestureToIntent('palm')!)).toEqual({ type: 'dj.play' });
  });
});

describe('语音音量控制（挥手撤销后的替代通道）', () => {
  it('volume:up/down 控制翻成音量增减动作', () => {
    expect(resolveIntent(playbackIntent('volume:up'))).toEqual({ type: 'volume.delta', delta: VOLUME_STEP });
    expect(resolveIntent(playbackIntent('volume:down'))).toEqual({ type: 'volume.delta', delta: -VOLUME_STEP });
  });
});

describe('语音音量绝对档（「改到最小」类需求）', () => {
  it('min/half/max 解析为绝对设定', () => {
    expect(resolveIntent(playbackIntent('volume:min'))).toEqual({ type: 'volume.set', value: 0.12 });
    expect(resolveIntent(playbackIntent('volume:half'))).toEqual({ type: 'volume.set', value: 0.5 });
    expect(resolveIntent(playbackIntent('volume:max'))).toEqual({ type: 'volume.set', value: 1 });
  });
});

describe('holoIntent open_app', () => {
  it('open_app 意图 → open_app 动作(带原始名字)', () => {
    expect(resolveIntent({ kind: 'open_app', name: '微信' })).toEqual({ type: 'open_app', name: '微信' });
  });
  it('playback 控制字符串 open_app:<name> → open_app 动作', () => {
    expect(resolveIntent({ kind: 'playback', control: 'open_app:日历' })).toEqual({ type: 'open_app', name: '日历' });
  });
  it('既有意图不回归', () => {
    expect(resolveIntent({ kind: 'playback', control: 'next' })).toEqual({ type: 'dj.next' });
  });
});
