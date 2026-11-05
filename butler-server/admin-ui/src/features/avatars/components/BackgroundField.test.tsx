// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/BackgroundField.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { BackgroundField } from '@/features/avatars/components/BackgroundField';

describe('BackgroundField', () => {
  it('空值：渲染拖拽落区提示与 URL 输入框', () => {
    const html = renderToString(<BackgroundField value="" onChange={vi.fn()} />);
    expect(html).toContain('拖拽图片到这里');
    expect(html).toContain('或直接填图片链接');
    expect(html).toContain('留空则无默认背景');
  });

  it('有值：渲染背景缩略图与替换提示', () => {
    const html = renderToString(<BackgroundField value="https://x.example/bg.png" onChange={vi.fn()} />);
    expect(html).toContain('https://x.example/bg.png');
    expect(html).toContain('点击或拖拽图片可替换');
  });
});
