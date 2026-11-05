import { describe, expect, it } from 'vitest';

import { takeCompleteSentences } from './sentences.ts';

describe('takeCompleteSentences', () => {
  it('按中文句末标点切出完整句，尾巴留着', () => {
    const r = takeCompleteSentences('你在道馆里。先打小怪');
    expect(r.sentences).toEqual(['你在道馆里。']);
    expect(r.rest).toBe('先打小怪');
  });

  it('一次能切出多句', () => {
    const r = takeCompleteSentences('先往左走。然后上楼！最后');
    expect(r.sentences).toEqual(['先往左走。', '然后上楼！']);
    expect(r.rest).toBe('最后');
  });

  it('没有标点但已经很长也要切出来（否则一直不播报，用户以为哑了）', () => {
    const long = '啊'.repeat(45);
    const r = takeCompleteSentences(long);
    expect(r.sentences.length).toBe(1);
    expect(r.sentences[0].length).toBe(40);
    expect(r.rest.length).toBe(5);
  });

  it('短且无标点时什么都不切（等后面的字）', () => {
    const r = takeCompleteSentences('你现在');
    expect(r.sentences).toEqual([]);
    expect(r.rest).toBe('你现在');
  });

  it('换行也算断句，且换行不进合成文本', () => {
    const r = takeCompleteSentences('第一步\n第二步');
    expect(r.sentences).toEqual(['第一步']);
    expect(r.rest).toBe('第二步');
  });

  it('纯标点/空白一句都不产出（别拿空串去请求 TTS，火山会报错）', () => {
    const r = takeCompleteSentences('。。  。');
    expect(r.sentences).toEqual([]);
    expect(r.rest).toBe('');
  });

  it('英文问号感叹号也认（军师偶尔会混英文）', () => {
    const r = takeCompleteSentences('Ready? Go!');
    expect(r.sentences).toEqual(['Ready?', ' Go!']);
  });

  it('空输入安全', () => {
    expect(takeCompleteSentences('')).toEqual({ sentences: [], rest: '' });
  });
});
