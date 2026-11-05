import { describe, expect, it } from 'vitest';
import { classifyCallEmotion, findEmotionMotion } from './callEmotion.ts';

describe('classifyCallEmotion', () => {
  it('拿不准的句子返回 null（保持原表情，不乱动）', () => {
    expect(classifyCallEmotion('今天星期三。')).toBeNull();
    expect(classifyCallEmotion('嗯。')).toBeNull();
    expect(classifyCallEmotion('')).toBeNull();
    expect(classifyCallEmotion('   ')).toBeNull();
  });

  it('识别开心', () => {
    const r = classifyCallEmotion('哈哈，真的太好了！');
    expect(r?.emotion).toBe('happy');
  });

  it('识别难过', () => {
    const r = classifyCallEmotion('呜呜，听到这个我好难过…');
    expect(r?.emotion).toBe('sad');
  });

  it('识别生气', () => {
    const r = classifyCallEmotion('哼！讨厌，气死我了！');
    expect(r?.emotion).toBe('angry');
  });

  it('识别惊讶', () => {
    const r = classifyCallEmotion('诶？真的吗？我没想到会这样！');
    expect(r?.emotion).toBe('surprised');
  });

  it('识别害羞', () => {
    const r = classifyCallEmotion('讨厌啦，人家会不好意思的…');
    expect(r?.emotion).toBe('shy');
  });

  it('识别温柔安抚', () => {
    const r = classifyCallEmotion('别担心，没关系的，我陪着你，慢慢来。');
    expect(r?.emotion).toBe('gentle');
  });

  it('识别兴奋', () => {
    const r = classifyCallEmotion('哇塞！太棒了太棒了，我好期待！！');
    expect(r?.emotion).toBe('excited');
  });

  it('感叹号加强 intensity，命中越多越强', () => {
    const weak = classifyCallEmotion('还挺开心的');
    const strong = classifyCallEmotion('开心开心！今天真是太开心啦！！');
    expect(weak).not.toBeNull();
    expect(strong).not.toBeNull();
    expect(strong!.intensity).toBeGreaterThan(weak!.intensity);
  });

  it('intensity 始终在 [0.4, 1] 区间', () => {
    for (const text of ['开心', '哼！气死我了！！！讨厌讨厌讨厌！！']) {
      const r = classifyCallEmotion(text);
      expect(r!.intensity).toBeGreaterThanOrEqual(0.4);
      expect(r!.intensity).toBeLessThanOrEqual(1);
    }
  });
});

describe('findEmotionMotion', () => {
  const motions = { Happy: {}, cry_loop: {}, TapBody: {} };

  it('按情绪匹配动作组名（大小写不敏感）', () => {
    expect(findEmotionMotion(motions, 'happy')).toBe('Happy');
    expect(findEmotionMotion(motions, 'sad')).toBe('cry_loop');
  });

  it('没有匹配的动作返回 undefined', () => {
    expect(findEmotionMotion(motions, 'angry')).toBeUndefined();
    expect(findEmotionMotion({}, 'happy')).toBeUndefined();
    expect(findEmotionMotion(undefined, 'happy')).toBeUndefined();
  });
});
