// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/AudioField.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AudioField } from '@/features/avatars/components/AudioField';

describe('AudioField', () => {
  it('空值：渲染占位文案与上传按钮，不渲染 <audio>', () => {
    const html = renderToString(<AudioField label="来电铃声" value="" onChange={vi.fn()} />);
    expect(html).toContain('来电铃声');
    expect(html).toContain('未设置（用默认音效）');
    expect(html).toContain('上传文件');
    expect(html).not.toContain('<audio');
  });

  it('有值：渲染 <audio controls> 与替换按钮', () => {
    const html = renderToString(
      <AudioField label="消息提示音" value="https://x.example/ring.mp3" onChange={vi.fn()} />,
    );
    expect(html).toContain('<audio');
    expect(html).toContain('https://x.example/ring.mp3');
    expect(html).toContain('替换文件');
  });
});
