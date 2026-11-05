import { describe, it, expect } from 'vitest';
import { buildImageUserContent } from './llm.ts';

describe('buildImageUserContent', () => {
  it('有 caption：text + image_url 两段', () => {
    expect(buildImageUserContent('这是什么', 'data:image/jpeg;base64,AAA')).toEqual([
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
    ]);
  });
  it('空 caption：只有 image_url', () => {
    expect(buildImageUserContent('   ', 'data:image/jpeg;base64,BBB')).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
    ]);
  });
});
