import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { StageIcon } from '../src/stage/icons';

/** 2026-09-17 Ben:图标复用 Codex 收的 Tabler 库,不自画。这里钉住:每个名字都出 svg、跟 currentColor、对读屏隐藏。 */
describe('舞台图标(Tabler 内联)', () => {
  it.each(['phone', 'phone-off', 'microphone', 'microphone-off', 'message-2', 'messages', 'settings'] as const)('%s 渲染成 svg', (name) => {
    const { container } = render(<StageIcon name={name} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('data-icon')).toBe(name);
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect(svg!.querySelectorAll('path').length).toBeGreaterThan(0);
    const paint = name === 'microphone-off' ? svg!.getAttribute('stroke') : svg!.getAttribute('fill');
    expect(paint).toBe('currentColor');
  });
});
