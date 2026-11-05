// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/Live2DForm.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Live2DForm } from '@/features/avatars/components/Live2DForm';
import type { CharacterLive2D, Live2dModelSummary } from '@/shared/types';

const models: Live2dModelSummary[] = [
  { id: 'm1', name: '模型一', preview_url: '/live2D/m1/preview.png' },
  { id: 'm2', name: '模型二' },
];

function render(value: CharacterLive2D, onChange = vi.fn()) {
  return renderToString(<Live2DForm value={value} availableModels={models} onChange={onChange} />);
}

describe('Live2DForm', () => {
  it('渲染模型下拉与映射编辑器', () => {
    const html = render({ model_id: '', expression_mappings: {} });
    expect(html).toContain('Live2D 模型');
    expect(html).toContain('表情参数映射 expression_mappings');
    expect(html).toContain('模型一');
    expect(html).toContain('模型二');
  });

  it('选中模型时展示预览图', () => {
    const html = render({ model_id: 'm1', expression_mappings: {} });
    expect(html).toContain('/live2D/m1/preview.png');
  });

  it('未选中模型时不展示预览图', () => {
    const html = render({ model_id: '', expression_mappings: {} });
    expect(html).not.toContain('/live2D/m1/preview.png');
  });

  it('渲染已有的表情映射', () => {
    const html = render({
      model_id: 'm2',
      expression_mappings: { happy: 'ParamMouthOpen', sad: 'ParamBrowLY' },
    });
    expect(html).toContain('happy');
    expect(html).toContain('ParamMouthOpen');
    expect(html).toContain('sad');
    expect(html).toContain('ParamBrowLY');
  });

  it('无可用模型时显示提示', () => {
    const html = renderToString(
      <Live2DForm value={{ model_id: '', expression_mappings: {}}} availableModels={[]} onChange={vi.fn()} />,
    );
    expect(html).toContain('暂无可用模型');
  });
});
