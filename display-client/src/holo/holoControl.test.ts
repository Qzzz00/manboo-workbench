import { describe, expect, it } from 'vitest';
import { HOLO_CONTROLS, HOLO_CONTROL_SYSTEM_NOTE, parseHoloControl } from './holoControl';

describe('parseHoloControl', () => {
  it('accepts every whitelisted control verbatim', () => {
    for (const c of HOLO_CONTROLS) {
      expect(parseHoloControl(c)).toBe(c);
    }
  });

  it('tolerates surrounding whitespace and case', () => {
    expect(parseHoloControl('  next ')).toBe('next');
    expect(parseHoloControl('PlayPause')).toBe('playPause');
    expect(parseHoloControl('MODE:FOCUS')).toBe('mode:focus');
    expect(parseHoloControl('mode:Commute')).toBe('mode:commute');
  });

  it('parses pomodoro:set:<minutes> within 1-180 and rejects out-of-range', () => {
    expect(parseHoloControl('pomodoro:set:25')).toBe('pomodoro:set:25');
    expect(parseHoloControl('  Pomodoro:Set:45 ')).toBe('pomodoro:set:45');
    expect(parseHoloControl('pomodoro:set:1')).toBe('pomodoro:set:1');
    expect(parseHoloControl('pomodoro:set:180')).toBe('pomodoro:set:180');
    expect(parseHoloControl('pomodoro:set:0')).toBeUndefined();
    expect(parseHoloControl('pomodoro:set:181')).toBeUndefined();
    expect(parseHoloControl('pomodoro:set:')).toBeUndefined();
    expect(parseHoloControl('pomodoro:set:abc')).toBeUndefined();
  });

  it('rejects unknown / non-string / empty values as undefined (treated as plain chat)', () => {
    expect(parseHoloControl('stop')).toBeUndefined();
    expect(parseHoloControl('volume:mute')).toBeUndefined(); // min/half/max 也转正了,拿个真非法的
    expect(parseHoloControl('volume:up')).toBe('volume:up'); // 2026-07-17 挥手手势撤销,音量走语音
    expect(parseHoloControl('')).toBeUndefined();
    expect(parseHoloControl('   ')).toBeUndefined();
    expect(parseHoloControl(undefined)).toBeUndefined();
    expect(parseHoloControl(null)).toBeUndefined();
    expect(parseHoloControl(42)).toBeUndefined();
    expect(parseHoloControl({ control: 'next' })).toBeUndefined();
  });
});

describe('holoControl open_app 扩展', () => {
  it('open_app:<name> 解析出带参指令', () => {
    expect(parseHoloControl('open_app:微信')).toBe('open_app:微信');
    expect(parseHoloControl('open_app:wechat')).toBe('open_app:wechat');
  });
  it('open_app 空名 → undefined', () => {
    expect(parseHoloControl('open_app:')).toBeUndefined();
    expect(parseHoloControl('open_app:   ')).toBeUndefined();
  });
  it('既有指令不回归', () => {
    expect(parseHoloControl('next')).toBe('next');
    expect(parseHoloControl('pomodoro:set:25')).toBe('pomodoro:set:25');
  });
  it('system note 含 open_app 说明', () => {
    expect(HOLO_CONTROL_SYSTEM_NOTE).toContain('open_app');
  });
});
