// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/VoiceForm.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { VoiceForm } from '@/features/avatars/components/VoiceForm';
import type { CharacterVoice } from '@/shared/types';

const defaultVoice: CharacterVoice = {
  tts_provider: 'volc_seedtts',
  voice_id: '',
  emotion_mappings: {},
};

function renderStatic(value: CharacterVoice, onChange = vi.fn(), onPreview?: () => void) {
  return renderToString(
    <VoiceForm
      value={value}
      onChange={onChange}
      onPreview={onPreview}
      previewing={false}
    />,
  );
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const descriptor =
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
  if (descriptor && descriptor.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
}

function renderInContainer(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(element); });
  return { container, root, cleanup: () => cleanupRoot(root, container) };
}

function cleanupRoot(root: Root, container: HTMLElement) {
  act(() => root.unmount());
  container.remove();
}

describe('VoiceForm', () => {
  it('渲染三个 TTS 引擎选项与映射编辑器', () => {
    const html = renderStatic(defaultVoice);
    expect(html).toContain('TTS 引擎');
    expect(html).toContain('火山 SeedTTS');
    expect(html).toContain('火山 V3');
    expect(html).toContain('通义千问 (Qwen)');
    expect(html).toContain('情绪映射 emotion_mappings');
  });

  it('渲染已有的情绪映射', () => {
    const html = renderStatic({
      tts_provider: 'qwen',
      voice_id: 'qwen-voice-1',
      emotion_mappings: { cheerful: 'happy', melancholic: 'sad' },
    });
    expect(html).toContain('cheerful');
    expect(html).toContain('happy');
    expect(html).toContain('melancholic');
    expect(html).toContain('sad');
    expect(html).toContain('qwen-voice-1');
  });

  it('切换 TTS 引擎触发 onChange', () => {
    const onChange = vi.fn();
    const { container, cleanup } = renderInContainer(
      <VoiceForm value={defaultVoice} onChange={onChange} />,
    );

    const select = container.querySelector('select') as HTMLSelectElement | null;
    expect(select).not.toBeNull();

    act(() => {
      select!.value = 'qwen';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({ ...defaultVoice, tts_provider: 'qwen' });

    cleanup();
  });

  it('修改音色 ID 触发 onChange', () => {
    const onChange = vi.fn();
    const { container, cleanup } = renderInContainer(
      <VoiceForm value={defaultVoice} onChange={onChange} />,
    );

    const input = container.querySelector('input[type="text"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();

    act(() => {
      setNativeValue(input!, 'S_new_voice');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ ...defaultVoice, voice_id: 'S_new_voice' });

    cleanup();
  });

  it('有试听回调且音色非空时展示试听按钮', () => {
    const onPreview = vi.fn();
    const { container, cleanup } = renderInContainer(
      <VoiceForm
        value={{ ...defaultVoice, voice_id: 'S_voice' }}
        onChange={vi.fn()}
        onPreview={onPreview}
      />,
    );

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('试听'),
    ) as HTMLButtonElement | undefined;
    expect(btn).not.toBeUndefined();
    expect(btn!.disabled).toBe(false);

    act(() => btn!.click());
    expect(onPreview).toHaveBeenCalledWith('S_voice');

    cleanup();
  });

  it('试听按钮在音色为空时禁用', () => {
    const onPreview = vi.fn();
    const { container, cleanup } = renderInContainer(
      <VoiceForm value={defaultVoice} onChange={vi.fn()} onPreview={onPreview} />,
    );

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('试听'),
    );
    expect(btn).not.toBeUndefined();
    expect(btn!.disabled).toBe(true);

    cleanup();
  });
});
