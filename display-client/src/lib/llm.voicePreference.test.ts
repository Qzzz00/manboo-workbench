import { describe, expect, it } from 'vitest';
import { applyVoicePreference } from './llm.ts';

describe('applyVoicePreference', () => {
  const textSegs = [{ type: 'text' as const, text: '就知道你会来找我～' }];

  it('voice=true 且无显式 segments：整条回复变成一条语音段', () => {
    const out = applyVoicePreference(textSegs, true, false, '就知道你会来找我～');
    expect(out).toEqual([{ type: 'voice', text: '就知道你会来找我～' }]);
  });

  it('voice 未置/false：保持原文字段不动', () => {
    expect(applyVoicePreference(textSegs, undefined, false, '在呢')).toBe(textSegs);
    expect(applyVoicePreference(textSegs, false, false, '在呢')).toBe(textSegs);
  });

  it('有显式 segments（如图片/多段）时不覆盖', () => {
    const imageSegs = [{ type: 'image' as const, prompt: 'a cat', alt: '猫' }];
    expect(applyVoicePreference(imageSegs, true, true, '给你看只猫')).toBe(imageSegs);
  });

  it('多个文字段会拼成整条语音文案', () => {
    const multi = [
      { type: 'text' as const, text: '嗯……' },
      { type: 'text' as const, text: '我想你了。' },
    ];
    const out = applyVoicePreference(multi, true, false, '嗯……我想你了。');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'voice' });
    expect((out[0] as { text: string }).text).toContain('我想你了');
  });

  it('超长回复截断到 200 字', () => {
    const long = '啦'.repeat(300);
    const out = applyVoicePreference([{ type: 'text', text: long }], true, false, long);
    expect((out[0] as { text: string }).text.length).toBe(200);
  });

  it('回复为空时不产生空语音段，保持原样', () => {
    const empty = [{ type: 'text' as const, text: '   ' }];
    const out = applyVoicePreference(empty, true, false, '   ');
    expect(out).toBe(empty);
  });
});
