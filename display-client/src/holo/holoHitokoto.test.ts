import { describe, expect, it } from 'vitest';
import { parseHitokoto } from './holoHitokoto';

describe('parseHitokoto', () => {
  it('句子+from_who 优先作出处', () => {
    expect(parseHitokoto({ hitokoto: '宁可枝头抱香死', from: '画菊', from_who: '郑思肖' }))
      .toBe('「宁可枝头抱香死」—— 郑思肖');
  });
  it('无 from_who 用 from', () => {
    expect(parseHitokoto({ hitokoto: '海内存知己', from: '送杜少府之任蜀州' }))
      .toBe('「海内存知己」—— 送杜少府之任蜀州');
  });
  it('无出处只句子', () => {
    expect(parseHitokoto({ hitokoto: '山高月小' })).toBe('「山高月小」');
  });
  it('缺句子/空句子/非对象 → null', () => {
    expect(parseHitokoto({ from: 'x' })).toBeNull();
    expect(parseHitokoto({ hitokoto: '' })).toBeNull();
    expect(parseHitokoto(null)).toBeNull();
    expect(parseHitokoto('str')).toBeNull();
  });
});
