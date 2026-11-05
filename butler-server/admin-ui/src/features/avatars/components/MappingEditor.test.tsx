// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/MappingEditor.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MappingEditor } from '@/features/avatars/components/MappingEditor';

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

function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(element); });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('MappingEditor', () => {
  it('添加空映射行', () => {
    const onChange = vi.fn();
    const { container, cleanup } = render(
      <MappingEditor label="映射" value={{}} onChange={onChange} />,
    );

    const addBtn = container.querySelector('button');
    expect(addBtn?.textContent).toContain('添加映射');

    act(() => addBtn!.click());
    expect(onChange).toHaveBeenCalledWith({ '': '' });

    cleanup();
  });

  it('编辑 key 时删除旧键并写入新键', () => {
    const onChange = vi.fn();
    const { container, cleanup } = render(
      <MappingEditor label="映射" value={{ happy: 'smile' }} onChange={onChange} />,
    );

    const keyInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(keyInput.value).toBe('happy');

    act(() => {
      setNativeValue(keyInput, 'cheerful');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ cheerful: 'smile' });

    cleanup();
  });

  it('编辑 value 时更新对应键值', () => {
    const onChange = vi.fn();
    const { container, cleanup } = render(
      <MappingEditor label="映射" value={{ happy: 'smile' }} onChange={onChange} />,
    );

    const valueInput = container.querySelectorAll('input[type="text"]')[1] as HTMLInputElement;
    expect(valueInput.value).toBe('smile');

    act(() => {
      setNativeValue(valueInput, 'big_smile');
      valueInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ happy: 'big_smile' });

    cleanup();
  });

  it('点击删除移除对应映射', () => {
    const onChange = vi.fn();
    const { container, cleanup } = render(
      <MappingEditor label="映射" value={{ happy: 'smile', sad: 'frown' }} onChange={onChange} />,
    );

    const deleteBtns = container.querySelectorAll('button.btn-danger') as NodeListOf<HTMLButtonElement>;
    expect(deleteBtns.length).toBe(2);

    act(() => deleteBtns[0].click());
    expect(onChange).toHaveBeenCalledWith({ sad: 'frown' });

    cleanup();
  });
});
