// 语气 → 那张脸(2026-10-02,卡「声音与形象跟着话走」第 4 件)。
//
// 这一组钉四件:
//   ① 表里认得的那几个语气**和工人那份短列表对得上**(两个仓库不互相 import,靠对照用例);
//   ② 形象清单里有对应表情 → 点那一张(逐字优先、再看含不含);
//   ③ **一个都没命中就不动脸**(回 undefined);
//   ④ 字幕协议上的 `tone` 解析得出来,而字幕文字里**不含标签**。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveNeutralExpression, resolveToneExpression, knownToneKeys, TONE_HOLD_MS } from '../src/live2d/tone';
import { parseWbchInbound } from '../src/channel/channelProtocol';
import type { AvatarManifest } from '../src/live2d/types';

/** 一个只有这几张表情的形象(名字故意起成美术常用的那种)。 */
function avatarWith(ids: readonly string[]): AvatarManifest {
  return {
    id: 'a1',
    name: '沉稳',
    summary: '',
    persona: { tone: '', traits: [], styleRules: [] },
    modelJson: 'model.json',
    scaleMultiplier: 1,
    verticalOffset: 0,
    modelTransform: { scale: 1, offsetX: 0, offsetY: 0 },
    transformDefaults: { scale: 1, offsetX: 0, offsetY: 0 },
    expressions: ids.map((id) => ({
      id, label: id, kind: 'emotion' as const, prompt: id, binding: { mode: 'file' as const, file: `${id}.exp3.json` },
    })),
  } as AvatarManifest;
}

describe('语气表', () => {
  it('认得的就是工人那七个 id(对照 channel-worker/src/tts/tone.ts)', () => {
    const worker = readFileSync(join(process.cwd(), '..', 'channel-worker', 'src', 'tts', 'tone.ts'), 'utf8');
    const listed = /export const TONES = \[([^\]]+)\]/.exec(worker)?.[1] ?? '';
    const ids = [...listed.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!).sort();
    expect(ids.length).toBeGreaterThan(0);
    expect(knownToneKeys()).toEqual(ids);
  });

  it('停多久是个正数(说完回中性靠它)', () => {
    expect(TONE_HOLD_MS).toBeGreaterThan(0);
  });
});

describe('有对应表情就点那一张', () => {
  it('逐字命中(不计大小写)', () => {
    const avatar = avatarWith(['neutral', 'Happy', 'sad', 'shy']);
    expect(resolveToneExpression(avatar, 'happy')).toBe('Happy');
    expect(resolveToneExpression(avatar, 'sorry')).toBe('sad');
    expect(resolveToneExpression(avatar, 'soft')).toBe('shy');
    expect(resolveToneExpression(avatar, 'calm')).toBe('neutral');
  });

  it('逐字不中就看 id 里含不含(美术起的名字常带前缀)', () => {
    const avatar = avatarWith(['exp_normal', 'exp_happy_01', 'exp_gentle']);
    expect(resolveToneExpression(avatar, 'happy')).toBe('exp_happy_01');
    expect(resolveToneExpression(avatar, 'care')).toBe('exp_gentle');
  });

  it('中文名的形象包也认', () => {
    const avatar = avatarWith(['默认', '微笑', '难过']);
    expect(resolveToneExpression(avatar, 'happy')).toBe('微笑');
    expect(resolveToneExpression(avatar, 'sorry')).toBe('难过');
  });

  it('回中性那一张也从表里找;形象里没有中性就 undefined', () => {
    expect(resolveNeutralExpression(avatarWith(['neutral', 'happy']))).toBe('neutral');
    expect(resolveNeutralExpression(avatarWith(['f01', 'f02']))).toBeUndefined();
  });
});

describe('**没有对应就不动脸**', () => {
  it('形象里一张都不沾 → undefined', () => {
    const avatar = avatarWith(['f01', 'f02', 'f03']);
    for (const tone of knownToneKeys()) expect(resolveToneExpression(avatar, tone)).toBeUndefined();
  });

  it('认不得的语气、空的、缺席的 → undefined', () => {
    const avatar = avatarWith(['neutral', 'happy']);
    expect(resolveToneExpression(avatar, '兴高采烈')).toBeUndefined();
    expect(resolveToneExpression(avatar, '')).toBeUndefined();
    expect(resolveToneExpression(avatar, undefined)).toBeUndefined();
  });

  it('形象一张表情都没有 → undefined,不抛', () => {
    expect(resolveToneExpression(avatarWith([]), 'happy')).toBeUndefined();
  });
});

describe('字幕上那一格', () => {
  it('解析得出来', () => {
    const msg = parseWbchInbound(JSON.stringify({ type: 'caption', role: 'butler', text: '你还好吗?', final: true, tone: 'care' }));
    expect(msg).toEqual({ type: 'caption', role: 'butler', text: '你还好吗?', final: true, tone: 'care' });
  });

  it('老工人不带这一格:整格缺席,别的一个字没变', () => {
    const msg = parseWbchInbound(JSON.stringify({ type: 'caption', role: 'butler', text: '好的。', final: true }));
    expect(msg).toEqual({ type: 'caption', role: 'butler', text: '好的。', final: true });
  });

  it('认不得的取值**不在这一层挡**(认不认得由这张表说了算)', () => {
    const msg = parseWbchInbound(JSON.stringify({ type: 'caption', role: 'butler', text: '好。', final: true, tone: '兴高采烈' }));
    expect(msg).toMatchObject({ tone: '兴高采烈' });
    expect(resolveToneExpression(avatarWith(['neutral', 'happy']), '兴高采烈')).toBeUndefined();
  });
});

describe('接线', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  it('舞台那一层按 toneRef 点表情,到点回中性', () => {
    const stage = read('src/live2d/ButlerStage.tsx');
    expect(stage).toContain('resolveToneExpression');
    expect(stage).toContain('resolveNeutralExpression');
    expect(stage).toContain('toneRef');
  });

  it('通话那一层把字幕上的 tone 转上去', () => {
    expect(read('src/call/livekitCall.ts')).toContain('onButlerTone');
    expect(read('src/call/rtcCall.ts')).toContain('onButlerTone');
    expect(read('src/call/useCall.ts')).toContain('toneRef');
  });
});
